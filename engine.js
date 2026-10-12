// Where Next decision engine. Pure functions, no DOM, so it can be tested in Node.
// All "rates" are rough relative estimates in $/hr-equivalent, built from priors
// (time of day, day of week, zone type) and adjusted by events, SEA flight banks,
// rain, the Seattle pay floor, drive time and the driver's own check-in history.
(function (root) {
  const Z = (typeof module !== 'undefined' && module.exports) ? require('./zones.js') : root.NF_ZONES;
  const ZONES = Z.ZONES;
  const ZONE_BY_ID = Object.fromEntries(ZONES.map(z => [z.id, z]));

  // ---------- geometry ----------
  function km(a, b) {
    const R = 6371, toR = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toR, dLng = (b.lng - a.lng) * toR;
    const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * toR) * Math.cos(b.lat * toR) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }
  function nearestZone(loc) {
    let best = null;
    for (const z of ZONES) {
      const d = km(loc, z);
      // Normalise by radius so a big residential zone doesn't swallow a small nightlife one.
      const score = d / Math.max(z.r, 0.5);
      if (!best || score < best.score) best = { zone: z, dist: d, score };
    }
    return { zone: best.zone, dist: best.dist, inside: best.dist <= best.zone.r * 1.6 };
  }
  // Rough drive minutes: straight line × road factor at a time-of-day speed, plus a bridge penalty.
  // First ~4 km on city streets, the rest at freeway speed.
  function driveMinutes(a, b, ctx) {
    const d = km(a, b);
    const h = ctx.h, wkday = ctx.dow >= 1 && ctx.dow <= 5;
    const rush = wkday && ((h >= 7 && h < 10) || (h >= 15 && h < 19));
    const night = h >= 22 || h < 6;
    const city = night ? 45 : rush ? 22 : 30;
    const fwy = night ? 90 : rush ? 45 : 65;
    const eastA = a.lng > -122.25, eastB = b.lng > -122.25;
    const bridge = (eastA !== eastB) ? (rush ? 8 : 3) : 0;
    const mins = 2 + Math.min(d, 4) * 1.35 / city * 60 + Math.max(0, d - 4) * 1.25 / fwy * 60 + bridge;
    return Math.max(2, Math.round(mins));
  }

  // ---------- priors ----------
  // Index 0-3 of each array is the night AFTER midnight that belongs to that day class
  // (e.g. fri[1] = 1-2 AM Saturday morning, bar-close territory).
  const CURVES = {
    downtown: {
      wk:  [10,8,6,6, 10,16,22,28,30,28,24,24,26,24,22,24,28,30,26,22,20,18,16,12],
      thu: [12,10,6,6, 10,16,22,28,30,28,24,24,26,24,22,24,28,30,28,26,24,22,20,16],
      fri: [22,22,24,8, 10,16,22,26,28,28,26,26,28,26,26,28,32,34,32,30,30,28,26,24],
      sat: [24,24,26,8, 8,12,16,20,24,26,28,30,30,30,30,30,30,32,32,30,30,28,26,24],
      sun: [12,10,6,6, 8,12,16,20,22,24,26,26,26,26,24,24,24,24,22,20,18,16,14,12]
    },
    nightlife: {
      wk:  [12,10,6,4, 4,6,8,10,12,12,12,14,16,14,14,16,18,22,26,26,24,22,20,16],
      thu: [18,16,14,6, 4,6,8,10,12,12,12,14,16,14,14,16,18,24,28,30,30,28,26,22],
      fri: [36,38,44,12, 4,6,8,10,12,12,12,14,16,14,14,16,20,26,30,32,34,36,36,34],
      sat: [38,40,46,14, 6,6,8,10,12,14,14,16,18,18,18,18,20,26,30,32,34,36,38,36],
      sun: [12,10,6,4, 6,6,8,10,12,14,16,16,16,16,14,14,14,16,18,18,16,14,12,10]
    },
    residential: {
      wk:  [6,5,4,8, 22,30,28,22,16,12,10,10,10,10,10,12,14,14,12,10,8,8,8,6],
      thu: [6,5,4,8, 22,30,28,22,16,12,10,10,10,10,10,12,14,14,12,10,8,8,8,6],
      fri: [8,8,6,8, 22,30,28,22,16,12,10,10,10,10,12,14,16,16,14,12,10,10,8,8],
      sat: [8,8,6,6, 12,18,22,22,20,16,12,10,10,10,10,10,12,12,12,10,10,8,8,8],
      sun: [6,5,4,6, 10,16,20,20,18,16,14,14,14,14,14,14,14,14,12,10,8,8,6,6]
    },
    office: {
      wk:  [4,3,2,2, 4,10,18,28,30,22,14,14,16,14,14,18,26,30,26,16,10,8,6,4],
      thu: [4,3,2,2, 4,10,18,28,30,22,14,14,16,14,14,18,26,30,26,16,10,8,6,4],
      fri: [4,3,2,2, 4,10,16,24,26,20,14,14,16,14,14,18,24,26,22,16,12,10,8,6],
      sat: [4,3,2,2, 3,4,6,8,10,10,10,10,10,10,10,10,10,10,8,8,6,6,4,4],
      sun: [4,3,2,2, 3,4,6,8,10,10,10,10,10,10,10,10,10,10,8,8,6,6,4,4]
    },
    campus: {
      wk:  [12,10,6,3, 2,4,8,14,18,18,16,18,18,16,16,18,18,16,16,16,16,16,14,12],
      thu: [14,12,8,4, 2,4,8,14,18,18,16,18,18,16,16,18,18,16,18,20,22,22,20,18],
      fri: [22,22,24,8, 2,4,8,12,16,16,16,16,16,16,16,16,18,20,22,24,26,26,24,24],
      sat: [24,24,26,8, 3,4,6,8,10,12,14,14,14,14,14,14,16,18,20,22,24,24,24,24],
      sun: [14,12,8,4, 2,4,6,8,10,12,14,14,14,14,14,14,14,14,14,12,12,10,10,8]
    },
    medical: {
      all: [8,6,6,6, 8,14,24,22,16,16,16,16,16,16,22,24,16,16,20,24,14,12,10,10]
    },
    center: {
      wk:  [10,8,4,3, 3,4,6,10,12,14,14,16,16,16,16,16,18,20,22,22,20,18,16,12],
      thu: [12,10,6,3, 3,4,6,10,12,14,14,16,16,16,16,16,18,20,24,24,22,20,18,14],
      fri: [20,18,16,6, 3,4,6,10,12,14,16,18,18,18,18,18,20,24,26,26,26,26,24,22],
      sat: [22,20,18,6, 3,4,6,10,14,16,18,20,20,20,20,20,22,24,26,26,26,26,24,22],
      sun: [10,8,4,3, 3,4,6,10,14,16,18,18,18,18,18,18,18,18,16,14,12,10,10,8]
    },
    stadium: { all: [4,3,2,2, 2,3,4,6,8,8,8,8,8,8,8,8,8,8,8,8,8,6,6,4] },
    mixed:   { all: [6,5,4,4, 8,12,16,18,16,14,14,14,14,14,14,16,18,18,16,14,12,10,8,6] }
  };
  const TYPE_LABEL = {
    downtown: 'downtown and hotels', nightlife: 'bars and restaurants', residential: 'residential',
    office: 'office commute', campus: 'campus', medical: 'hospital shifts', center: 'Seattle Center',
    stadium: 'stadium district', mixed: 'mixed area', airport: 'airport', smallairport: 'Paine Field'
  };
  function dayClass(dow) { return dow === 4 ? 'thu' : dow === 5 ? 'fri' : dow === 6 ? 'sat' : dow === 0 ? 'sun' : 'wk'; }
  function curveValue(type, dow, h) {
    const c = CURVES[type]; if (!c) return 8;
    // Hours after midnight (0-3) belong to the previous day's night.
    const d = h < 4 ? (dow + 6) % 7 : dow;
    const arr = c.all || c[dayClass(d)];
    return arr[h];
  }

  // SEA arrivals and departures, relative 0-100 by hour. Baseline profile unless the
  // day's data file supplies its own (data.sea.arrivals / data.sea.departures).
  const SEA_BASE = {
    arr: [35,15,5,2, 3,15,25,25,30,40,50,55,55,55,60,65,65,60,60,60,65,75,80,60],
    dep: [10,3,2,5, 25,70,90,90,75,60,50,50,50,50,55,55,50,45,45,40,35,40,45,25]
  };
  function seaIndex(data, dow, h) {
    const s = data && data.sea;
    let arr = (s && Array.isArray(s.arrivals) && s.arrivals.length === 24) ? s.arrivals[h] : SEA_BASE.arr[h];
    let dep = (s && Array.isArray(s.departures) && s.departures.length === 24) ? s.departures[h] : SEA_BASE.dep[h];
    if (!(s && s.arrivals)) {
      if (dow === 0 && h >= 13) arr *= 1.15;           // Sunday weekend returns
      if (dow === 5 && h >= 15) arr *= 1.1;            // Friday evening arrivals
      if (dow === 1 && h >= 4 && h < 10) dep *= 1.1;   // Monday business departures
    }
    return { arr: Math.min(100, arr), dep: Math.min(100, dep), fromData: !!(s && s.arrivals) };
  }
  function nextArrivalPeak(data, dow, h) {
    for (let k = 1; k <= 12; k++) {
      const hh = (h + k) % 24;
      const s = seaIndex(data, dow, hh);
      if (s.arr >= 55 && s.arr > s.dep) return hh;
    }
    return null;
  }

  // ---------- adjustments ----------
  function eventsEffect(zone, T, ctx) {
    let mult = 1; const why = [];
    for (const e of ctx.events || []) {
      if (e.outMin == null) continue;
      const inEgress = T >= e.outMin - 15 && T <= e.outMin + 35;
      const inPre = e.startMin != null && T >= e.startMin - 75 && T <= e.startMin - 15;
      const during = e.startMin != null && T > e.startMin && T < e.outMin - 15;
      if (e.kind === 'watch') {
        if (inEgress && ['nightlife', 'campus', 'center'].includes(zone.type)) {
          mult *= 1.25; why.push(`${e.name}: bar crowds head home around ${fmtMin(e.outMin)}`);
        }
        continue;
      }
      if (e.lat == null || e.lng == null) continue;
      const d = km(zone, e);
      if (inEgress) {
        if (e.crowd === 'big') {
          if (d <= 0.8) { mult *= 0.85; why.push(`${e.name} lets out ~${fmtMin(e.outMin)}, but the curb there floods with drivers`); }
          else if (d <= 3) { mult *= 1.45; why.push(`${e.name} lets out ~${fmtMin(e.outMin)}: crowds spill here, drivers stay at the venue`); }
          else if (d <= 5) { mult *= 1.1; }
        } else if (e.crowd === 'mid') {
          if (d <= 1.0) { mult *= 1.6; why.push(`${e.name} lets out ~${fmtMin(e.outMin)}, mid-size crowd, few drivers`); }
          else if (d <= 3) { mult *= 1.15; }
        } else if (d <= 0.8) { mult *= 1.3; why.push(`${e.name} lets out ~${fmtMin(e.outMin)}`); }
      } else if (inPre && e.crowd === 'big' && zone.type === 'residential' && d <= 25) {
        mult *= 1.08;
      } else if (during && d <= 1.0 && e.kind === 'festival') {
        mult *= 1.15; why.push(`${e.name} is on now`);
      }
    }
    return { mult, why };
  }
  function rainEffect(T, ctx) {
    const w = ctx.weather; if (!w || !w.length) return { mult: 1, why: [] };
    const at = mins => { const p = w.find(x => mins >= x.startMin && mins < x.startMin + 60); return p ? p.pop : null; };
    const now = at(T); if (now == null) return { mult: 1, why: [] };
    const prev = [at(T - 60), at(T - 120), at(T - 180)].filter(v => v != null);
    if (now >= 60 && prev.length && Math.max(...prev) < 40) return { mult: 1.3, why: ['Rain is just starting: demand jumps before more drivers log on'] };
    if (now >= 60) return { mult: 1.1, why: ['Rain keeps more people off foot and transit'] };
    return { mult: 1, why: [] };
  }
  function daypart(h) { return (h >= 4 && h < 9) ? 'early' : (h >= 9 && h < 15) ? 'mid' : (h >= 15 && h < 20) ? 'eve' : 'night'; }
  function median(a) { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : null; }
  // Minutes from one check-in to the next (≈ wait for a ping + the trip) by zone and daypart.
  function historyStats(checkins) {
    const cyc = {}, all = [];
    const list = (checkins || []).slice().sort((a, b) => a.t - b.t);
    for (let i = 0; i < list.length - 1; i++) {
      const gap = (list[i + 1].t - list[i].t) / 60000;
      if (gap < 8 || gap > 120) continue;
      const key = list[i].zone + '|' + list[i].part;
      (cyc[key] = cyc[key] || []).push(gap); all.push(gap);
    }
    return { cyc, overall: median(all), n: all.length };
  }
  function historyEffect(zone, h, stats) {
    if (!stats || !stats.overall) return { mult: 1, why: [] };
    const arr = stats.cyc[zone.id + '|' + daypart(h)];
    if (!arr || arr.length < 3) return { mult: 1, why: [] };
    const m = median(arr);
    const mult = Math.max(0.75, Math.min(1.3, stats.overall / m));
    const why = [`Your history here at this time: ${Math.round(m)} min drop-off to drop-off vs ${Math.round(stats.overall)} min typical`];
    return { mult, why };
  }

  // ---------- value of being in a zone at minute T ----------
  function valueAt(zone, T, ctx) {
    const h = Math.floor(((T % 1440) + 1440) % 1440 / 60);
    const dow = T >= 1440 ? (ctx.dow + 1) % 7 : ctx.dow;
    const why = [];
    let rate;
    if (zone.type === 'airport') {
      const s = seaIndex(ctx.data, dow, h);
      rate = Math.max(4, Math.min(38, 8 + 0.35 * s.arr - 0.2 * s.dep));
      if (s.dep > s.arr + 15) why.push('SEA is departure-heavy now: drivers who drop off pile into the line');
      else if (s.arr > s.dep + 10) why.push('SEA arrivals outnumber departures now, so the line moves');
    } else if (zone.type === 'smallairport') {
      rate = 4;
      const arrs = (ctx.data && ctx.data.pae && ctx.data.pae.arrivals) || [];
      const soon = arrs.map(t => toMin(t)).filter(m => m != null && m - T >= 0 && m - T <= 35);
      if (soon.length) { rate = 22; why.push(`${soon.length} PAE arrival${soon.length > 1 ? 's' : ''} landing within 35 min`); }
    } else {
      rate = curveValue(zone.type, dow, h);
      if (!zone.seattle) rate *= 0.8; // state pay floor outside Seattle
      const label = TYPE_LABEL[zone.type];
      if (zone.type === 'residential' && h >= 4 && h < 8) why.push('Home-to-airport window: people leave about two hours before morning flights');
      else if (zone.type === 'nightlife' && (h >= 21 || h < 3) && rate >= 26) why.push('Bar and restaurant crowd leaving, often one by one');
      else if (zone.type === 'downtown' && h >= 8 && h < 11) why.push('Hotel checkout hours: best odds of a downtown airport run');
      else if (zone.type === 'office' && rate >= 24) why.push('Commute rush');
      else if (zone.type === 'medical' && rate >= 20) why.push('Hospital shift change');
      else if (label && rate >= 22) why.push(`Busy time for ${label}`);
    }
    const ev = eventsEffect(zone, T, ctx), rain = rainEffect(T, ctx), hist = historyEffect(zone, h, ctx.history);
    rate *= ev.mult * rain.mult * hist.mult;
    return { rate, why: [...ev.why, ...rain.why, ...hist.why, ...why] };
  }

  // Value over the next half hour after arriving (arrival, +15, +30 min), so a
  // let-out or rain starting soon counts even if it hasn't begun yet.
  function valueWindow(zone, T, ctx) {
    const parts = [0, 15, 30].map(o => valueAt(zone, T + o, ctx));
    const rate = parts.reduce((s, p) => s + p.rate, 0) / parts.length;
    const why = [...new Set(parts.flatMap(p => p.why))];
    return { rate, why };
  }

  // ---------- helpers ----------
  function toMin(t) { const m = /^(\d{1,2}):(\d{2})$/.exec(t || ''); return m ? (+m[1]) * 60 + (+m[2]) : null; }
  function fmtMin(m) { m = ((m % 1440) + 1440) % 1440; let h = Math.floor(m / 60); const mm = String(m % 60).padStart(2, '0'); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12; return `${h}:${mm} ${ap}`; }
  function meter(rate) { return rate >= 30 ? 5 : rate >= 24 ? 4 : rate >= 18 ? 3 : rate >= 12 ? 2 : 1; }

  // Turn data-file events (local HH:MM on a given day) into minutes relative to today 00:00.
  function prepareEvents(files, todayYmd) {
    const out = [];
    for (const f of files || []) {
      if (!f || !Array.isArray(f.events)) continue;
      const offset = f.date === todayYmd ? 0 : -1440;
      for (const e of f.events) {
        const s = toMin(e.start), o = toMin(e.out);
        if (o == null) continue;
        let startMin = s == null ? null : s + offset, outMin = o + offset;
        if (startMin != null && outMin < startMin) outMin += 1440;
        out.push(Object.assign({}, e, { startMin, outMin }));
      }
    }
    return out;
  }


  // ---------- small venues near the driver (from OpenStreetMap, fetched by the app) ----------
  // Typical let-out times by venue kind and weekday (minutes after midnight; > 1440 = after midnight).
  const H = (h, m) => h * 60 + (m || 0);
  function venueLetouts(kind, dow) {
    const thuSun = [0, 4, 5, 6].includes(dow), friSat = dow === 5 || dow === 6;
    switch (kind) {
      case 'comedy':  return thuSun ? [H(21), H(23, 15)] : dow === 3 ? [H(21)] : [];
      case 'theatre': return [...(dow >= 2 && dow <= 6 ? [H(22)] : []), ...(dow === 6 || dow === 0 ? [H(16, 30)] : [])];
      case 'music':   return [H(23, 15)];
      case 'club':    return friSat ? [H(26)] : thuSun ? [H(25)] : [];
      case 'cinema':  return [H(21, 30), H(23, 45)];
      case 'arts':    return thuSun ? [H(21, 30)] : [];
      default:        return [];
    }
  }
  const VENUE_BOOST = { comedy: 1.15, theatre: 1.2, music: 1.15, club: 1.2, cinema: 1.08, arts: 1.1 };
  // Let-outs within [-10, +35] min of T, for venues within 600 m of the driver.
  function venuesNow(ctx, T) {
    const hits = [];
    for (const v of ctx.venues || []) {
      if (v.dist == null || v.dist > 0.6) continue;
      const today = venueLetouts(v.kind, ctx.dow);
      const yday = venueLetouts(v.kind, (ctx.dow + 6) % 7).map(m => m - 1440);
      for (const out of [...today, ...yday]) {
        if (out - T >= -10 && out - T <= 35) { hits.push({ v, out }); break; }
      }
    }
    return hits;
  }
  function venuesEffect(ctx, T) {
    const hits = venuesNow(ctx, T);
    let mult = 1; const why = [];
    for (const h of hits.slice(0, 3)) {
      mult *= VENUE_BOOST[h.v.kind] || 1.1;
      why.push(`${h.v.name} (${Math.round(h.v.dist * 1000)} m away) usually lets out around ${fmtMin(h.out)}`);
    }
    return { mult: Math.min(mult, 1.35), why, hits };
  }

  // ---------- main ----------
  function recommend(ctx) {
    const now = ctx.h * 60 + ctx.m;
    const loc = ctx.loc;
    const nz = nearestZone(loc);
    const here = nz.zone;
    const seattleHere = ctx.cityIsSeattle != null ? ctx.cityIsSeattle : here.seattle;
    const hereZone = Object.assign({}, here, { lat: loc.lat, lng: loc.lng, seattle: seattleHere });
    const prox = nz.inside ? 1 : 0.85;

    const hereVal = valueWindow(hereZone, now, ctx); hereVal.rate *= prox;
    const ven = venuesEffect(ctx, now);
    if (ven.mult > 1) { hereVal.rate *= ven.mult; hereVal.why = [...ven.why, ...hereVal.why]; }
    const cands = [];
    for (const z of ZONES) {
      if (z.id === here.id) continue;
      const travel = driveMinutes(loc, z, ctx);
      if (travel > 45) continue;
      const v = valueWindow(z, now + travel, ctx);
      const score = v.rate * (60 - Math.min(travel, 55)) / 60;
      cands.push({ zone: z, travel, rate: v.rate, score, why: v.why });
    }
    cands.sort((a, b) => b.score - a.score);
    const stay = { zone: here, travel: 0, rate: hereVal.rate, score: hereVal.rate, why: hereVal.why };
    const best = cands[0];
    const upcoming = (ctx.events || []).filter(e => e.outMin != null && e.outMin >= now - 10 && e.outMin <= now + 240)
      .sort((a, b) => a.outMin - b.outMin);

    const base = { here, hereInside: nz.inside, seattle: seattleHere, upcoming, venueHits: ven.hits, alternatives: [] };
    const home = ctx.settings && ctx.settings.homeLat != null ? { lat: ctx.settings.homeLat, lng: ctx.settings.homeLng, name: 'Home' } : null;
    const endShift = (reasons) => Object.assign(base, {
      action: 'end', verb: 'Consider calling it', target: home, rate: Math.max(stay.rate, best ? best.rate : 0), travel: home ? driveMinutes(loc, home, ctx) : 0, meter: meter(Math.max(stay.rate, best ? best.rate : 0)),
      reasons, alternatives: [stay, ...cands.slice(0, 2)]
    });

    // At SEA: stay in the line or leave.
    if (here.id === 'sea' && nz.inside) {
      const s = seaIndex(ctx.data, ctx.dow, ctx.h);
      const sNext = seaIndex(ctx.data, ctx.dow, (ctx.h + 1) % 24);
      const arr = (s.arr + sNext.arr) / 2, dep = (s.dep + sNext.dep) / 2;
      const perMin = Math.max(0.3, 4 * arr / 100);
      const q = ctx.queue && ctx.queue.pos > 0 && (Date.now() - ctx.queue.at) < 25 * 60000 ? ctx.queue.pos : null;
      const estWait = q != null ? Math.round(q / perMin) : null;
      const leaveTo = cands.find(c => c.zone.seattle) || best;
      const peak = nextArrivalPeak(ctx.data, ctx.dow, ctx.h);
      const reasons = [];
      let stayInLine;
      if (estWait != null) {
        stayInLine = estWait <= 25 || (estWait <= 40 && leaveTo.rate < 18);
        reasons.push(`#${q} in line at about ${perMin.toFixed(1)} pickups a minute: roughly ${estWait} min wait`);
      } else {
        stayInLine = arr >= 55 && arr > dep;
        reasons.push(stayInLine ? 'Arrivals outnumber departures this hour, so the line should move' : 'Departure-heavy hour: most drivers here just dropped off, and the line moves slowly');
        reasons.push('Enter your place in line below for a wait estimate');
      }
      if (!stayInLine && peak != null) reasons.push(`Arrivals pick up around ${fmtMin(peak * 60)}`);
      const sch = ctx.data && ctx.data.sea && ctx.data.sea.scheduled && ctx.data.sea.scheduled.arrivals;
      if (s.fromData === false) reasons.push('Flight banks are a typical-day estimate');
      else if (Array.isArray(sch) && sch.length === 24) {
        const n = Math.round(sch[ctx.h] * (60 - ctx.m) / 60 + sch[(ctx.h + 1) % 24] * ctx.m / 60);
        reasons.push(`Today's schedule: about ${n} passenger flight${n === 1 ? '' : 's'} land in the next hour`);
      }
      if (stayInLine) {
        return Object.assign(base, { action: 'sea-stay', verb: 'Stay in the SEA line', target: null, rate: stay.rate, travel: 0, meter: meter(stay.rate), reasons, estWait, alternatives: [leaveTo, ...cands.filter(c => c !== leaveTo).slice(0, 2)] });
      }
      return Object.assign(base, { action: 'sea-leave', verb: 'Leave SEA', target: leaveTo.zone, rate: leaveTo.rate, travel: leaveTo.travel, meter: meter(leaveTo.rate),
        reasons: [...reasons, `${leaveTo.zone.name} is ${leaveTo.travel} min north${leaveTo.zone.seattle ? ' and pays the Seattle rate' : ''}`, ...leaveTo.why.slice(0, 1)], estWait,
        alternatives: cands.filter(c => c !== leaveTo).slice(0, 3) });
    }

    const moveWins = best && best.score > stay.score * 1.12 && best.score - stay.score > 2;
    const pick = moveWins ? best : stay;

    // Dead stretch with something better coming: take a break.
    if (pick.rate < 17) {
      let future = null;
      for (const ahead of [30, 45, 60, 90, 120]) {
        for (const z of ZONES) {
          const travel = z.id === here.id ? 0 : driveMinutes(loc, z, ctx);
          if (travel > 40) continue;
          if (ahead - travel < 25) continue; // would have to leave now anyway: that's a move, not a break
          const v = valueAt(z, now + ahead, ctx);
          if (v.rate >= Math.max(pick.rate * 1.5, 22) && (!future || v.rate > future.rate)) future = { zone: z, ahead, travel, rate: v.rate, why: v.why };
        }
        if (future) break;
      }
      if (future && future.ahead - future.travel > 90) {
        return endShift([`Slow everywhere within reach for the next ${Math.round((future.ahead - future.travel) / 30) / 2} hours`,
          `Next good window: ${future.zone.name} around ${fmtMin(now + future.ahead)}`, ...future.why.slice(0, 1)]);
      }
      if (future) {
        const resumeAt = now + Math.max(0, future.ahead - future.travel);
        if (future.zone.id === here.id) {
          return Object.assign(base, {
            action: 'break', verb: 'Take a break here', target: null, rate: pick.rate, laterRate: future.rate, travel: 0, meter: meter(pick.rate), resumeAt,
            reasons: ['Slow right now', `Requests here should pick up around ${fmtMin(now + future.ahead)}`, ...future.why.slice(0, 1)],
            alternatives: cands.slice(0, 3)
          });
        }
        return Object.assign(base, {
          action: 'break', verb: 'Take a break', target: future.zone, rate: pick.rate, laterRate: future.rate, travel: future.travel, meter: meter(pick.rate), resumeAt,
          reasons: [`Slow stretch here right now`, `Leave by ${fmtMin(resumeAt)} for ${future.zone.name} (${future.travel} min)`, ...future.why.slice(0, 2)],
          alternatives: cands.slice(0, 3)
        });
      }
    }

    if (pick.rate < 14) {
      return endShift(['Nothing within reach looks worth the time for the next two hours',
        best ? `If you keep going: ${best.zone.name}, ${best.travel} min away` : 'Nothing nearby stands out']);
    }

    if (!moveWins) {
      const reasons = stay.why.slice(0, 3);
      if (!reasons.length) reasons.push(here.seattle ? 'Nothing nearby beats waiting here, and Seattle pickups pay the higher floor' : 'Nothing within reach beats waiting here right now');
      if (here.tip) reasons.push(here.tip);
      return Object.assign(base, { action: 'stay', verb: 'Stay here', target: null, rate: stay.rate, travel: 0, meter: meter(stay.rate), reasons, alternatives: cands.slice(0, 3) });
    }
    const reasons = best.why.slice(0, 3);
    if (best.zone.seattle && !seattleHere) reasons.push('Pickups there pay the Seattle rate');
    if (!reasons.length) reasons.push(`Better odds than waiting here (${TYPE_LABEL[best.zone.type] || best.zone.type})`);
    if (best.zone.tip) reasons.push(best.zone.tip);
    return Object.assign(base, { action: 'move', verb: 'Head to', target: best.zone, rate: best.rate, travel: best.travel, meter: meter(best.rate), reasons, alternatives: [stay, ...cands.slice(1, 3)] });
  }

  const api = { recommend, venueLetouts, nearestZone, driveMinutes, valueAt, seaIndex, prepareEvents, historyStats, daypart, km, fmtMin, toMin, meter, ZONE_BY_ID };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.NF_ENGINE = api;
})(typeof window !== 'undefined' ? window : globalThis);
