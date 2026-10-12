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
    files: [], flights: null, dataLoadedAt: 0, weather: null, weatherSummary: '', weatherAt: 0,
    lastRun: 0, running: false, rec: null,
    settings: Object.assign({ navApp: 'google', homeLat: null, homeLng: null }, store.get('settings', {})),
    venues: [], venuesKey: null,
    checkins: store.get('checkins', []),
    advice: store.get('advice', []), logKey: null,
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
  // Raw GitHub copy, used if a just-committed flights file hasn't reached GitHub Pages yet.
  const RAW = 'https://raw.githubusercontent.com/element-school/next-fare/main/';
  const getJSON = async url => {
    try { const r = await fetch(url, { cache: 'no-cache' }); return r.ok ? await r.json() : null; } catch { return null; }
  };
  async function loadData() {
    if (Date.now() - S.dataLoadedAt < 10 * 60000 && S.files.length) return;
    const days = [ymdOffset(0), ymdOffset(-1)];
    const fpath = `data/flights/${days[0]}.json`;
    const [files, flights] = await Promise.all([
      Promise.all(days.map(d => getJSON(`data/${d}.json`))),
      getJSON(fpath).then(f => f || getJSON(RAW + fpath))
    ]);
    S.files = files.map((f, i) => f ? Object.assign({ date: days[i] }, f) : null).filter(Boolean);
    // Flight schedules come from their own file (written by a GitHub Action) and
    // override any SEA/PAE numbers in the events file.
    S.flights = flights && flights.date === days[0] ? flights : null;
    if (S.flights) {
      let f = S.files.find(x => x.date === days[0]);
      if (!f) { f = { date: days[0], events: [] }; S.files.push(f); }
      if (S.flights.sea) f.sea = S.flights.sea;
      if (S.flights.pae) f.pae = S.flights.pae;
    }
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


  /* ---------- OpenStreetMap (Overpass) ---------- */
  async function overpass(q) {
    const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(q);
    for (let attempt = 0; attempt < 2; attempt++) {
      const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), 15000);
      try {
        const r = await fetch(url, { signal: ac.signal });
        clearTimeout(timer);
        if (r.ok) return await r.json();
        if (r.status !== 429 && r.status !== 504) throw new Error('http ' + r.status);
      } catch (e) { clearTimeout(timer); if (attempt === 1) throw e; }
      await new Promise(res => setTimeout(res, 2500));
    }
    throw new Error('unavailable');
  }

  /* ---------- venues nearby ---------- */
  const KIND_LABEL = { comedy: 'Comedy club', theatre: 'Theater', music: 'Music venue', club: 'Nightclub', cinema: 'Cinema', arts: 'Arts venue' };
  function venueKind(t) {
    const name = t.name || '';
    if (/comedy|laugh/i.test(name) || /comedy/i.test(t['theatre:genre'] || '')) return 'comedy';
    return { theatre: 'theatre', cinema: 'cinema', nightclub: 'club', music_venue: 'music', events_venue: 'music', arts_centre: 'arts', concert_hall: 'arts' }[t.amenity] || null;
  }
  async function loadVenues(loc) {
    const key = loc.lat.toFixed(3).slice(0, -1) + ',' + loc.lng.toFixed(3).slice(0, -1); // ~1 km cells
    const cache = store.get('venues', {});
    let list = cache[key] && Date.now() - cache[key].at < 12 * 3600000 ? cache[key].list : null;
    if (!list) {
      const c = `${loc.lat},${loc.lng}`;
      const j = await overpass(`[out:json][timeout:15];(nwr(around:1200,${c})["amenity"~"^(theatre|cinema|nightclub|music_venue|arts_centre|events_venue|concert_hall)$"];nwr(around:1200,${c})["name"~"[Cc]omedy|[Ll]augh"];);out center 60;`);
      const seen = new Set();
      list = (j.elements || []).map(e => {
        const t = e.tags || {}; const p = e.center || e; const kind = venueKind(t);
        return kind && t.name && p.lat != null ? { name: t.name, kind, lat: p.lat, lng: p.lon, web: t.website || t['contact:website'] || null } : null;
      }).filter(v => v && !seen.has(v.name) && seen.add(v.name));
      const keys = Object.keys(cache); if (keys.length > 60) delete cache[keys[0]];
      cache[key] = { at: Date.now(), list }; store.set('venues', cache);
    }
    S.venues = list.map(v => Object.assign({}, v, { dist: E.km(loc, v) })).filter(v => v.dist <= 0.9).sort((a, b) => a.dist - b.dist);
  }
  function renderVenues(r) {
    const box = $('#venues');
    if (!S.venues.length) { box.className = 'small'; box.textContent = 'No comedy clubs, theaters, music venues or cinemas mapped within about 900 m.'; return; }
    const p = pt(); const now = p.h * 60 + p.m;
    const hitNames = new Set((r && r.venueHits || []).map(h => h.v.name));
    box.className = '';
    box.innerHTML = S.venues.slice(0, 6).map(v => {
      const outs = E.venueLetouts(v.kind, p.dow).filter(m => m > now - 30).map(m => E.fmtMin(m));
      const link = safeLink(v.web) || `https://www.google.com/search?q=${encodeURIComponent(v.name + ' Seattle shows tonight')}`;
      return `<div class="row"><span class="n">${esc(v.name)}${hitNames.has(v.name) ? ' <span class="tag sea">letting out soon</span>' : ''}</span>
        <span class="d">${esc(KIND_LABEL[v.kind])} · ${Math.round(v.dist * 1000)} m${outs.length ? ` · usually out ~${esc(outs.join(', ~'))}` : ' · nothing typical left today'}</span>
        <span class="r"><a class="go" href="${esc(link)}" target="_blank" rel="noopener">Shows ›</a></span></div>`;
    }).join('') + '<p class="small">Let-out times are typical for this kind of venue. Tap Shows to check tonight’s schedule.</p>';
  }
  function safeLink(u) { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } }

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

  /* ---------- advice log (on this phone; exported from Settings) ---------- */
  const APP_VERSION = '2026-10-12';
  function logAdvice(rec, mode) {
    const now = Date.now(), loc = S.loc;
    const entry = {
      t: now, v: APP_VERSION,
      lat: +loc.lat.toFixed(4), lng: +loc.lng.toFixed(4), acc: loc.acc != null ? Math.round(loc.acc) : null, manual: !!loc.manual,
      zone: rec.here.id, inside: rec.hereInside, seattle: rec.seattle,
      a: rec.action, to: rec.target ? (rec.target.id || 'home') : null, travel: rec.travel || 0,
      rate: rec.rate != null ? Math.round(rec.rate) : null, later: rec.laterRate != null ? Math.round(rec.laterRate) : null,
      resume: rec.resumeAt != null ? E.fmtMin(rec.resumeAt) : null,
      wait: rec.estWait ?? null, q: S.queue && now - S.queue.at < 25 * 60000 ? S.queue.pos : null,
      why: (rec.reasons || []).slice(0, 2).map(x => String(x).slice(0, 120)),
      alts: (rec.alternatives || []).filter(Boolean).slice(0, 3).map(x => [x.zone.id, x.travel, Math.round(x.rate)])
    };
    const last = S.advice[S.advice.length - 1];
    if (mode === 'update') {
      if (!last || last.k !== S.logKey || now - last.t > 3 * 60000) return;
      S.advice[S.advice.length - 1] = Object.assign(entry, { t: last.t, k: last.k });
    } else if (last && now - last.t < 60000 && last.a === entry.a && last.to === entry.to && E.km(last, entry) < 0.1) {
      // A quick second refresh in the same spot with the same advice replaces the last entry (same key).
      S.logKey = last.k; entry.k = last.k;
      S.advice[S.advice.length - 1] = entry;
    } else {
      S.logKey = 'k' + now; entry.k = S.logKey;
      S.advice.push(entry);
      if (S.advice.length > 8000) S.advice = S.advice.slice(-8000);
    }
    store.set('advice', S.advice);
    adviceNote();
    syncMark([entry.k]);
  }
  function adviceNote() {
    const n = S.advice.length;
    $('#adviceNote').textContent = n
      ? `${n} saved since ${new Date(S.advice[0].t).toLocaleDateString('en-US', { timeZone: TZ, month: 'short', day: 'numeric' })}.`
      : 'Nothing saved yet.';
  }
  async function exportAdvice() {
    const p = pt();
    const body = JSON.stringify({ exportedAt: new Date().toISOString(), app: 'Where Next', version: APP_VERSION, advice: S.advice, checkins: S.checkins });
    const name = `where-next-log-${p.ymd}.json`;
    const file = new File([body], name, { type: 'application/json' });
    try {
      if (navigator.canShare && navigator.canShare({ files: [file] })) { await navigator.share({ files: [file], title: name }); return; }
    } catch (e) { if (e && e.name === 'AbortError') return; }
    const a = document.createElement('a'); a.href = URL.createObjectURL(file); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  /* ---------- cloud sync: advice log -> private Supabase table (only with a device key) ---------- */
  // The publishable key only lets the page call nf_log_advice(); the device key, kept on this
  // phone, is what that function checks before it stores anything. Nothing else is readable.
  const SB_URL = 'https://umcaijhbdvcoyefvflbf.supabase.co';
  const SB_KEY = 'sb_publishable_pHl5cv1j8ZoXbTV2ts-M6g_kUvi0HzE';
  const SY = { key: store.get('syncKey', null), pending: store.get('syncPending', []), last: store.get('syncLast', null), err: null, busy: false, timer: null };
  function syncMark(keys) {
    if (!SY.key) return;
    const set = new Set(SY.pending); keys.forEach(k => k && set.add(k));
    SY.pending = [...set]; store.set('syncPending', SY.pending);
    clearTimeout(SY.timer); SY.timer = setTimeout(syncFlush, 1500);
  }
  async function syncFlush() {
    if (!SY.key || SY.busy || !SY.pending.length) { syncNote(); return; }
    if (navigator.onLine === false) { SY.err = 'offline'; syncNote(); return; }
    SY.busy = true;
    try {
      while (SY.pending.length) {
        const batch = SY.pending.slice(0, 200);
        const byKey = new Map(S.advice.map(e => [e.k, e]));
        const rows = batch.map(k => byKey.get(k)).filter(Boolean);
        if (rows.length) {
          const r = await fetch(SB_URL + '/rest/v1/rpc/nf_log_advice', {
            method: 'POST',
            headers: { apikey: SB_KEY, 'Content-Type': 'application/json' },
            body: JSON.stringify({ p_key: SY.key, p_rows: rows })
          });
          if (!r.ok) {
            let msg = 'HTTP ' + r.status;
            try { const j = await r.json(); if (j && j.message) msg = j.message; } catch {}
            throw new Error(msg);
          }
        }
        const sent = new Set(batch);
        SY.pending = SY.pending.filter(k => !sent.has(k)); store.set('syncPending', SY.pending);
        SY.last = { at: Date.now(), n: ((SY.last && SY.last.n) || 0) + rows.length }; store.set('syncLast', SY.last);
      }
      SY.err = null;
    } catch (e) {
      SY.err = e && e.message || 'failed';
    } finally { SY.busy = false; syncNote(); }
  }
  function syncNote() {
    const el = $('#syncNote'); if (!el) return;
    $('#syncKey').hidden = !!SY.key; $('#syncSave').hidden = !!SY.key; $('#syncOff').hidden = !SY.key;
    if (!SY.key) { el.textContent = 'Off. Paste the sync key from Claude to upload the advice log to your private database automatically.'; return; }
    const when = SY.last ? new Date(SY.last.at).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' }) : null;
    el.textContent = SY.err === 'offline' ? `On. Offline; ${SY.pending.length} waiting to upload.`
      : SY.err ? `On, but the last upload failed (${SY.err}). ${SY.pending.length} waiting; it retries on the next refresh.`
      : SY.pending.length ? `On. Uploading ${SY.pending.length}…`
      : `On. Everything uploaded${when ? `, last at ${when}` : ''}.`;
  }

  /* ---------- today's rhythm (blocks from the nightly plan) ---------- */
  function fmtShort(m) { return E.fmtMin(m).replace(':00', ''); }
  function renderRhythm() {
    const p = pt(), now = p.h * 60 + p.m;
    const blocks = [];
    let head = '';
    for (const f of S.files) {
      const plan = f.plan; if (!plan || !Array.isArray(plan.blocks)) continue;
      const off = f.date === p.ymd ? 0 : f.date === ymdOffset(-1) ? -1440 : null;
      if (off == null) continue;
      if (off === 0) head = plan.headline || '';
      for (const b of plan.blocks) {
        const s0 = E.toMin(b.start), e0 = E.toMin(b.end); if (s0 == null || e0 == null) continue;
        const sm = s0 + off; let em = e0 + off; if (em <= sm) em += 1440;
        if (off < 0 && em <= now) continue; // yesterday's block already over
        blocks.push(Object.assign({}, b, { sm, em }));
      }
    }
    blocks.sort((a, b) => a.sm - b.sm);
    $('#planPanel').hidden = !blocks.length;
    if (!blocks.length) return;
    const next = blocks.find(b => b.sm > now && !b.isBreak);
    $('#planHead').textContent = head;
    $('#planNext').textContent = next ? `Next: ${fmtShort(next.sm)}` : '';
    $('#plan').innerHTML = blocks.map(b => {
      const st = b.em <= now ? 'past' : b.sm <= now ? 'now' : b === next ? 'next' : 'later';
      const s = ['high', 'medium', 'low'].includes(b.strength) ? b.strength : 'low';
      const showPlay = b.play && (st === 'now' || st === 'next');
      const tag = st === 'now' ? '<span class="pill">Now</span>' : st === 'next' ? '<span class="pill soft">Next</span>' : '';
      return `<div class="blk${b.isBreak ? ' brk' : ''}" data-st="${st}" data-s="${b.isBreak ? '' : s}">
        <span class="t">${esc(fmtShort(b.sm))}–${esc(fmtShort(b.em))}</span>
        <span class="z">${esc(b.isBreak ? (b.zone || 'Break') : b.zone)}${tag}</span>
        ${showPlay ? `<span class="p">${esc(b.play)}</span>` : ''}
      </div>`;
    }).join('');
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
      compute('new');
      S.lastRun = Date.now();
      loadVenues(loc).then(() => compute('update')).catch(() => { $('#venues').className = 'small'; $('#venues').textContent = 'Couldn\u2019t reach the map service for venues. It will try again on the next refresh.'; });
      if (!loc.manual) reverseGeocode(loc).then(g => { if (g) { S.label = g.label; S.city = g.city; S.cityIsSeattle = g.city ? g.city === 'Seattle' : null; compute('update'); } });
      else { S.label = null; S.city = null; S.cityIsSeattle = null; }
    } finally { S.running = false; $('#refresh').disabled = false; }
  }

  // log: 'new' = a refresh or new SEA line position (adds an entry); 'update' = the same
  // refresh recomputed once venues or the place name arrived (replaces that entry).
  function compute(log) {
    if (!S.loc) return;
    const p = pt();
    const ctx = {
      loc: S.loc, h: p.h, m: p.m, dow: p.dow,
      data: S.files.find(f => f.date === p.ymd) || null,
      events: E.prepareEvents(S.files, p.ymd),
      weather: S.weather, history: E.historyStats(S.checkins),
      settings: S.settings, queue: S.queue, cityIsSeattle: S.cityIsSeattle,
      venues: S.venues
    };
    const rec = E.recommend(ctx); S.rec = rec;
    if (log) logAdvice(rec, log);
    render(rec, ctx);
    renderRhythm();
    renderVenues(rec);
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
    else if (r.action === 'end') dest = 'Slow for the next couple of hours';
    if (r.travel) sub.push(`<span class="mono">${r.travel} min</span> drive`);
    if (r.meter) sub.push(dots(r.meter));
    const target = r.target;
    const navs = [];
    if (target && target.lat != null) {
      const app = S.settings.navApp;
      navs.push(`<a class="nav" href="${esc(navUrl(target, app))}" target="_blank" rel="noopener">${r.action === 'break' ? 'Later: navigate' : r.action === 'end' ? 'Navigate home' : 'Navigate'}</a>`);
    }
    if (r.action === 'end' && !target) r.reasons = [...r.reasons, 'Set your home in Settings for a one-tap route home'];
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
    const sch = S.flights && S.flights.sea && S.flights.sea.scheduled;
    const sum = a => (a || []).reduce((s, x) => s + x, 0);
    $('#dataNote').textContent += sch
      ? ` SEA flights: today's schedule (${sum(sch.arrivals)} arrivals, ${sum(sch.departures)} departures).`
      : ' SEA flights: typical-day estimate.';
  }

  /* ---------- food & chargers ---------- */
  async function findFood() {
    const box = $('#food');
    if (!S.loc) { box.textContent = 'Need your location first.'; return; }
    box.textContent = 'Looking nearby…';
    const { lat, lng } = S.loc;
    const c = `${lat},${lng}`;
    try {
      const j = await overpass(`[out:json][timeout:15];(node(around:1000,${c})["amenity"~"^(fast_food|cafe|restaurant)$"];way(around:1000,${c})["amenity"~"^(fast_food|cafe|restaurant)$"];);out center 80;`);
      const seen = new Set();
      const items = (j.elements || []).map(e => {
        const t = e.tags || {}; const p = e.center || e;
        const quick = t.amenity === 'fast_food' || t.amenity === 'cafe' || /^(yes|only)$/.test(t.takeaway || '');
        return { name: t.name || t.brand || '', amenity: t.amenity, cuisine: t.cuisine, hours: t.opening_hours, lat: p.lat, lng: p.lon, quick };
      }).filter(x => x.name && x.lat != null && !seen.has(x.name) && seen.add(x.name))
        .map(x => Object.assign(x, { d: E.km(S.loc, x) }));
      const food = items.sort((a, b) => (b.quick - a.quick) || (a.d - b.d)).slice(0, 6).sort((a, b) => a.d - b.d);
      if (!food.length) { box.textContent = 'Nothing mapped within a kilometer. Try again from a busier spot.'; return; }
      const row = x => `<div class="row"><span class="n">${esc(x.name)}</span>
        <span class="d">${esc([(x.cuisine || x.amenity || '').replace(/_/g, ' ').replace(/;/g, ', '), x.quick ? 'takeout' : '', x.hours].filter(Boolean).join(' · '))}</span>
        <span class="r"><span class="mono small">${x.d < 1 ? Math.round(x.d * 1000) + ' m' : x.d.toFixed(1) + ' km'}</span><a class="go" href="${esc(navUrl(x, S.settings.navApp))}" target="_blank" rel="noopener">Go ›</a></span></div>`;
      box.innerHTML = food.map(row).join('');
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
    S.queue = v > 0 ? { pos: v, at: Date.now() } : null; store.set('queue', S.queue); compute('new');
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
  $('#navApp').value = S.settings.navApp || 'google';
  $('#navApp').addEventListener('change', () => { S.settings.navApp = $('#navApp').value; saveSettings(); compute(); });
  let clearArmed = false;
  $('#clearHist').addEventListener('click', () => {
    if (!clearArmed) { clearArmed = true; $('#clearHist').textContent = 'Tap again to clear'; setTimeout(() => { clearArmed = false; $('#clearHist').textContent = 'Clear history'; }, 4000); return; }
    S.checkins = []; store.set('checkins', []); clearArmed = false; $('#clearHist').textContent = 'Clear history'; compute();
  });
  homeNote();

  // Refresh whenever you switch back to the app (e.g. right after a drop-off).
  $('#exportLog').addEventListener('click', exportAdvice);
  $('#syncSave').addEventListener('click', () => {
    const k = ($('#syncKey').value || '').trim();
    if (!/^wn_[A-Za-z0-9_-]{30,}$/.test(k)) { $('#syncNote').textContent = 'That doesn\u2019t look like a sync key. It starts with wn_.'; return; }
    SY.key = k; store.set('syncKey', k); $('#syncKey').value = '';
    SY.pending = []; syncMark(S.advice.map(e => e.k)); syncNote();
  });
  $('#syncOff').addEventListener('click', () => { SY.key = null; SY.pending = []; store.set('syncKey', null); store.set('syncPending', []); syncNote(); });
  window.addEventListener('online', () => syncFlush());
  syncNote(); if (SY.key && SY.pending.length) setTimeout(syncFlush, 3000);
  let clearLogArmed = false;
  $('#clearLog').addEventListener('click', () => {
    if (!clearLogArmed) { clearLogArmed = true; $('#clearLog').textContent = 'Tap again to clear'; setTimeout(() => { clearLogArmed = false; $('#clearLog').textContent = 'Clear'; }, 4000); return; }
    S.advice = []; store.set('advice', []); clearLogArmed = false; $('#clearLog').textContent = 'Clear'; adviceNote();
  });
  adviceNote();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (Date.now() - S.lastRun > 60000) run('visible');
    if (SY.key && SY.pending.length) syncFlush();
  });
  // Keep the advice current while the screen is on.
  setInterval(() => { if (document.visibilityState === 'visible' && S.loc) compute(); }, 60000);
  run('load');
})();
