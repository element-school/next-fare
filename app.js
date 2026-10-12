// Where Next: UI, location, data loading. Decision logic lives in engine.js.
(function () {
  const E = window.NF_ENGINE, ZONES = window.NF_ZONES.ZONES;
  const TZ = 'America/Los_Angeles';
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ---------- storage ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem('wn-' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('wn-' + k, JSON.stringify(v)); } catch {} }
  };

  /* ---------- time (Pacific) ---------- */
  const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  function pt(d) {
    const f = new Intl.DateTimeFormat('en-US', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    const p = Object.fromEntries(f.formatToParts(d || new Date()).map(x => [x.type, x.value]));
    return { ymd: `${p.year}-${p.month}-${p.day}`, h: (+p.hour) % 24, m: +p.minute, dow: DOW.indexOf(p.weekday) };
  }
  const ymdOffset = days => pt(new Date(Date.now() + days * 864e5)).ymd;

  /* ---------- state ---------- */
  const S = {
    loc: null, manual: null, label: null, city: null, cityIsSeattle: null,
    files: [], dataLoadedAt: 0, weather: null, weatherSummary: '', weatherAt: 0,
    lastRun: 0, running: false, rec: null,
    settings: Object.assign({ navApp: 'google', shiftEnd: '', homeLat: null, homeLng: null }, store.get('settings', {})),
    checkins: store.get('checkins', []),
    queue: store.get('queue', null)
  };

  /* ---------- location ---------- */
  function getPosition() {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) return reject(new Error('unsupported'));
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy }),
        err => reject(err), { enableHighAccuracy: true, timeout: 12000, maximumAge: 20000 });
    });
  }
  async function reverseGeocode(loc) {
    const key = loc.lat.toFixed(3) + ',' + loc.lng.toFixed(3);
    const cache = store.get('geo', {});
    if (cache[key]) return cache[key];
    try {
      const r = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${loc.lat}&lon=${loc.lng}&zoom=16&addressdetails=1&accept-language=en`);
      if (!r.ok) return null;
      const j = await r.json(); const a = j.address || {};
      const val = { label: a.neighbourhood || a.suburb || a.quarter || a.city_district || a.hamlet || null, city: a.city || a.town || a.village || null };
      const keys = Object.keys(cache); if (keys.length > 300) delete cache[keys[0]];
      cache[key] = val; store.set('geo', cache);
      return val;
    } catch { return null; }
  }

  /* ---------- data ---------- */
  async function loadData() {
    if (Date.now() - S.dataLoadedAt < 10 * 60000 && S.files.length) return;
    const days = [ymdOffset(0), ymdOffset(-1)];
    const files = await Promise.all(days.map(async d => {
      try { const r = await fetch(`data/${d}.json`, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
    }));
    S.files = files.map((f, i) => f ? Object.assign({ date: days[i] }, f) : null).filter(Boolean);
    S.dataLoadedAt = Date.now();
  }
  async function loadWeather() {
    if (Date.now() - S.weatherAt < 45 * 60000 && S.weather) return;
    const cached = store.get('wx', null);
    if (cached && Date.now() - cached.at < 45 * 60000) { applyWeather(cached.periods); S.weatherAt = cached.at; return; }
    try {
      const p = await (await fetch('https://api.weather.gov/points/47.6062,-122.3321', { headers: { Accept: 'application/geo+json' } })).json();
      const url = p && p.properties && p.properties.forecastHourly; if (!url) return;
      const f = await (await fetch(url, { headers: { Accept: 'application/geo+json' } })).json();
      const periods = ((f.properties && f.properties.periods) || []).slice(0, 36).map(x => ({
        start: x.startTime, pop: (x.probabilityOfPrecipitation && x.probabilityOfPrecipitation.value) || 0, t: x.temperature, s: x.shortForecast
      }));
      store.set('wx', { at: Date.now(), periods }); S.weatherAt = Date.now(); applyWeather(periods);
    } catch { /* weather is optional */ }
  }
  function applyWeather(periods) {
    const today = ymdOffset(0), tomorrow = ymdOffset(1), yesterday = ymdOffset(-1);
    S.weather = periods.map(p => {
      const q = pt(new Date(p.start)); const off = q.ymd === today ? 0 : q.ymd === tomorrow ? 1440 : q.ymd === yesterday ? -1440 : null;
      return off == null ? null : { startMin: off + q.h * 60 + q.m, pop: p.pop };
    }).filter(Boolean);
    const now = periods.find(p => new Date(p.start).getTime() <= Date.now() && Date.now() - new Date(p.start).getTime() < 3600000) || periods[0];
    S.weatherSummary = now ? `${now.t}° · ${now.s}${now.pop >= 30 ? ` · ${now.pop}% rain` : ''}` : '';
  }

  /* ---------- check-ins ---------- */
  function recordCheckin(loc, zoneId, manual) {
    const last = S.checkins[S.checkins.length - 1];
    const now = Date.now();
    if (last && now - last.t < 4 * 60000 && E.km(loc, last) < 0.6) return;
    const p = pt();
    S.checkins.push({ t: now, lat: +loc.lat.toFixed(4), lng: +loc.lng.toFixed(4), zone: zoneId, part: E.daypart(p.h), manual: !!manual });
    if (S.checkins.length > 3000) S.checkins = S.checkins.slice(-3000);
    store.set('checkins', S.checkins);
  }

  /* ---------- navigation links ---------- */
  function navUrl(t, app) {
    const ll = `${t.lat},${t.lng}`;
    if (app === 'waze') return `https://waze.com/ul?ll=${ll}&navigate=yes`;
    if (app === 'apple') return `https://maps.apple.com/?daddr=${ll}&dirflg=d`;
    return `https://www.google.com/maps/dir/?api=1&destination=${ll}&travelmode=driving`;
  }

  /* ---------- run ---------- */
  async function run(reason) {
    if (S.running) return; S.running = true;
    $('#refresh').disabled = true;
    try {
      const dataP = loadData(), wxP = loadWeather();
      let loc = null;
      setStatus('Finding your location…');
      try { loc = await getPosition(); S.manual = null; $('#manualZone').value = ''; $('#manualPanel').hidden = true; }
      catch (err) {
        $('#manualPanel').hidden = false;
        $('#manualWhy').textContent = err && err.code === 1
          ? 'Location is blocked for this site. Turn it on in your browser settings, or choose the closest area.'
          : 'Couldn’t get a location fix. Choose the closest area and I’ll work from there.';
        if (S.manual) loc = { lat: S.manual.lat, lng: S.manual.lng, manual: true };
        else if (S.loc) loc = S.loc;
        else { setCard({ action: 'stay', verb: 'Location needed', dest: 'Pick your spot below', status: '' }); return; }
      }
      S.loc = loc;
      await Promise.all([dataP, wxP]);
      const nz = E.nearestZone(loc);
      recordCheckin(loc, nz.zone.id, loc.manual);
      compute();
      S.lastRun = Date.now();
      if (!loc.manual) reverseGeocode(loc).then(g => { if (g) { S.label = g.label; S.city = g.city; S.cityIsSeattle = g.city ? g.city === 'Seattle' : null; compute(); } });
      else { S.label = null; S.city = null; S.cityIsSeattle = null; }
    } finally { S.running = false; $('#refresh').disabled = false; }
  }

  function compute() {
    if (!S.loc) return;
    const p = pt();
    const ctx = {
      loc: S.loc, h: p.h, m: p.m, dow: p.dow,
      data: S.files.find(f => f.date === p.ymd) || null,
      events: E.prepareEvents(S.files, p.ymd),
      weather: S.weather, history: E.historyStats(S.checkins),
      settings: S.settings, queue: S.queue, cityIsSeattle: S.cityIsSeattle
    };
    const rec = E.recommend(ctx); S.rec = rec;
    render(rec, ctx);
  }

  /* ---------- render ---------- */
  function setStatus(t) { $('#status') && ($('#status').textContent = t); }
  function setCard(o) {
    const c = $('#card'); c.dataset.a = o.action;
    c.innerHTML = `<div class="verb">${esc(o.verb)}</div><p class="dest">${esc(o.dest)}</p>${o.status ? `<div class="status" id="status">${esc(o.status)}</div>` : '<div class="status" id="status"></div>'}`;
  }
  function dots(n) { if (!n) return ''; return `<span class="dots" aria-label="Strength ${n} of 5">${[1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</span>`; }

  function render(r, ctx) {
    // Top bar
    const z = r.here;
    const place = S.loc.manual ? `Near ${z.name}` : (S.label ? `${S.label}${S.city && S.city !== 'Seattle' ? ', ' + S.city : ''}` : (r.hereInside ? z.name : `Near ${z.name}`));
    $('#place').textContent = place;
    const t = new Date().toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
    $('#meta').innerHTML = `<span class="tag ${r.seattle ? 'sea' : 'wa'}">${r.seattle ? 'Seattle rate' : 'WA rate'}</span><span>${esc(t)}</span>${S.weatherSummary ? `<span>${esc(S.weatherSummary)}</span>` : ''}`;

    // Card
    const c = $('#card'); c.dataset.a = r.action;
    let dest = '', sub = [];
    if (r.action === 'move' || r.action === 'sea-leave') dest = r.target.name;
    else if (r.action === 'stay') dest = r.hereInside ? `Wait in ${z.name}` : `Wait near ${z.name}`;
    else if (r.action === 'sea-stay') dest = r.estWait != null ? `About ${r.estWait} min wait` : 'Join the line';
    else if (r.action === 'break') dest = `Until ${E.fmtMin(r.resumeAt)}`;
    else if (r.action === 'home') dest = 'Home';
    if (r.travel) sub.push(`<span class="mono">${r.travel} min</span> drive`);
    if (r.meter) sub.push(dots(r.meter));
    const target = r.action === 'home' ? r.target : (r.action === 'break' ? r.target : r.target);
    const navs = [];
    if (target && target.lat != null) {
      const app = S.settings.navApp;
      navs.push(`<a class="nav" href="${esc(navUrl(target, app))}" target="_blank" rel="noopener">${r.action === 'break' ? 'Later: navigate' : 'Navigate'}</a>`);
    }
    if (r.action === 'break') navs.unshift(`<a class="nav alt" href="#foodPanel" id="cardFood">Food nearby</a>`);
    c.innerHTML = `<div class="verb">${esc(r.verb)}</div>
      <p class="dest">${esc(dest)}</p>
      ${sub.length ? `<div class="sub">${sub.join('<span aria-hidden="true">·</span>')}</div>` : ''}
      ${r.action === 'break' && r.target ? `<div class="sub">Then: ${esc(r.target.name)}</div>` : ''}
      <ul>${r.reasons.slice(0, 4).map(x => `<li>${esc(x)}</li>`).join('')}</ul>
      ${navs.length ? `<div class="navrow">${navs.join('')}</div>` : ''}`;
    const cf = $('#cardFood'); if (cf) cf.addEventListener('click', e => { e.preventDefault(); findFood(); $('#foodPanel').scrollIntoView({ behavior: 'smooth' }); });

    // SEA
    $('#seaPanel').hidden = !(z.id === 'sea' && r.hereInside);
    if (S.queue && S.queue.pos && Date.now() - S.queue.at < 25 * 60000) $('#seaPos').value = S.queue.pos;

    // Alternatives
    const alts = (r.alternatives || []).filter(Boolean).slice(0, 3);
    $('#altPanel').hidden = !alts.length;
    $('#alts').innerHTML = alts.map(a => {
      const isHere = a.travel === 0;
      const why = (a.why && a.why[0]) || (a.zone.tip || '');
      return `<div class="row"><span class="n">${esc(isHere ? 'Stay: ' + a.zone.name : a.zone.name)}</span>
        <span class="d">${esc(why)}</span>
        <span class="r">${dots(E.meter(a.rate))}${isHere ? '' : `<a class="go" href="${esc(navUrl(a.zone, S.settings.navApp))}" target="_blank" rel="noopener">${a.travel} min ›</a>`}</span></div>`;
    }).join('');

    // Upcoming let-outs
    const ups = r.upcoming || [];
    $('#upPanel').hidden = !ups.length;
    $('#ups').innerHTML = ups.map(e => `<div class="row"><span class="n">${esc(e.name)}</span>
      <span class="d">${esc([e.venue, e.crowd === 'big' ? 'big crowd: work the edges' : e.crowd === 'mid' ? 'mid-size: good odds' : 'small'].filter(Boolean).join(' · '))}</span>
      <span class="r mono">~${esc(E.fmtMin(e.outMin))}</span></div>`).join('');

    // Today stats
    const today = pt().ymd;
    const todays = S.checkins.filter(x => pt(new Date(x.t)).ymd === today);
    const gaps = []; for (let i = 1; i < todays.length; i++) { const g = (todays[i].t - todays[i - 1].t) / 60000; if (g >= 8 && g <= 120) gaps.push(g); }
    gaps.sort((a, b) => a - b);
    const med = gaps.length ? Math.round(gaps[Math.floor(gaps.length / 2)]) : null;
    const hist = ctx.history;
    $('#stats').innerHTML = `
      <div class="stat"><div class="label">Check-ins</div><div class="num">${todays.length}</div></div>
      <div class="stat"><div class="label">Min between</div><div class="num">${med ?? '—'}</div></div>
      <div class="stat"><div class="label">All-time</div><div class="num">${S.checkins.length}</div></div>`;
    $('#histNote').textContent = hist.n ? `${hist.n} drop-off gaps learned` : '';

    // Data freshness
    const f = S.files.find(x => x.date === today);
    $('#dataNote').textContent = f
      ? `Event data for ${today}${f.generatedAt ? `, written ${new Date(f.generatedAt).toLocaleString('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' })}` : ''}. ${(f.events || []).length} events.`
      : `No event data for ${today} yet, so advice uses time-of-day patterns only.`;
  }

  /* ---------- food & chargers ---------- */
  async function findFood() {
    const box = $('#food');
    if (!S.loc) { box.textContent = 'Need your location first.'; return; }
    box.textContent = 'Looking nearby…';
    const { lat, lng } = S.loc;
    const q = `[out:json][timeout:15];(
      nwr(around:1200,${lat},${lng})["amenity"~"^(fast_food|restaurant|cafe)$"]["takeaway"~"^(yes|only)$"];
      nwr(around:900,${lat},${lng})["amenity"="fast_food"];
      nwr(around:5000,${lat},${lng})["amenity"="charging_station"]["name"~"Tesla|Supercharger",i];
      nwr(around:5000,${lat},${lng})["amenity"="charging_station"]["brand"~"Tesla",i];
      nwr(around:5000,${lat},${lng})["amenity"="charging_station"]["operator"~"Tesla",i];
    );out center 80;`;
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
      if (!r.ok) throw new Error('http ' + r.status);
      const j = await r.json();
      const seen = new Set();
      const items = (j.elements || []).map(e => {
        const t = e.tags || {}; const p = e.center || e;
        return { name: t.name || t.brand || '', amenity: t.amenity, cuisine: t.cuisine, hours: t.opening_hours, lat: p.lat, lng: p.lon, charger: t.amenity === 'charging_station' };
      }).filter(x => x.name && x.lat != null && !seen.has(x.name + x.lat.toFixed(4)) && seen.add(x.name + x.lat.toFixed(4)))
        .map(x => Object.assign(x, { d: E.km(S.loc, x) }));
      const food = items.filter(x => !x.charger).sort((a, b) => a.d - b.d).slice(0, 5);
      const chargers = items.filter(x => x.charger).sort((a, b) => a.d - b.d).slice(0, 2);
      if (!food.length && !chargers.length) { box.textContent = 'Nothing tagged nearby. Try again from a busier spot.'; return; }
      const row = x => `<div class="row"><span class="n">${esc(x.name)}</span>
        <span class="d">${esc([x.charger ? 'Supercharger' : (x.cuisine || x.amenity || '').replace(/_/g, ' ').replace(/;/g, ', '), x.hours].filter(Boolean).join(' · '))}</span>
        <span class="r"><span class="mono small">${x.d < 1 ? Math.round(x.d * 1000) + ' m' : x.d.toFixed(1) + ' km'}</span><a class="go" href="${esc(navUrl(x, S.settings.navApp))}" target="_blank" rel="noopener">Go ›</a></span></div>`;
      box.innerHTML = (food.length ? food.map(row).join('') : '<p class="small">No takeout spots tagged within a kilometer.</p>')
        + (chargers.length ? `<div class="label" style="margin-top:6px">Superchargers</div>${chargers.map(row).join('')}` : '');
      box.classList.remove('small');
    } catch {
      box.textContent = 'Couldn’t reach the map service. Try again in a minute.';
    }
  }

  /* ---------- wiring ---------- */
  $('#refresh').addEventListener('click', () => run('button'));
  $('#foodBtn').addEventListener('click', findFood);
  $('#seaForm').addEventListener('submit', e => {
    e.preventDefault();
    const v = parseInt($('#seaPos').value, 10);
    S.queue = v > 0 ? { pos: v, at: Date.now() } : null; store.set('queue', S.queue); compute();
  });
  const sel = $('#manualZone');
  sel.innerHTML = '<option value="">Choose the closest area…</option>' + ZONES.map(z => `<option value="${z.id}">${esc(z.name)}</option>`).join('');
  sel.addEventListener('change', () => {
    const z = ZONES.find(x => x.id === sel.value);
    S.manual = z ? { lat: z.lat, lng: z.lng } : null;
    if (z) run('manual');
  });
  // Settings
  const saveSettings = () => store.set('settings', S.settings);
  const homeNote = () => { $('#homeNote').textContent = S.settings.homeLat != null ? 'Set. Used for "head home" after your end time. Stored only on this phone.' : 'Not set. Used for "head home" at the end of your shift. Stored only on this phone.'; };
  $('#setHome').addEventListener('click', async () => {
    try { const p = S.loc && !S.loc.manual ? S.loc : await getPosition(); S.settings.homeLat = +p.lat.toFixed(4); S.settings.homeLng = +p.lng.toFixed(4); saveSettings(); homeNote(); compute(); }
    catch { $('#homeNote').textContent = 'Couldn’t get your location to set home.'; }
  });
  $('#clearHome').addEventListener('click', () => { S.settings.homeLat = S.settings.homeLng = null; saveSettings(); homeNote(); compute(); });
  $('#shiftEnd').value = S.settings.shiftEnd || '';
  $('#shiftEnd').addEventListener('change', () => { S.settings.shiftEnd = $('#shiftEnd').value; saveSettings(); compute(); });
  $('#navApp').value = S.settings.navApp || 'google';
  $('#navApp').addEventListener('change', () => { S.settings.navApp = $('#navApp').value; saveSettings(); compute(); });
  let clearArmed = false;
  $('#clearHist').addEventListener('click', () => {
    if (!clearArmed) { clearArmed = true; $('#clearHist').textContent = 'Tap again to clear'; setTimeout(() => { clearArmed = false; $('#clearHist').textContent = 'Clear history'; }, 4000); return; }
    S.checkins = []; store.set('checkins', []); clearArmed = false; $('#clearHist').textContent = 'Clear history'; compute();
  });
  homeNote();

  // Refresh whenever you switch back to the app (e.g. right after a drop-off).
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && Date.now() - S.lastRun > 60000) run('visible'); });
  // Keep the advice current while the screen is on.
  setInterval(() => { if (document.visibilityState === 'visible' && S.loc) compute(); }, 60000);
  run('load');
})();
