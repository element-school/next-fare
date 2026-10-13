#!/usr/bin/env python3
"""Pull public data for the ride-demand model and write it to research/data/.

Runs in GitHub Actions (.github/workflows/research.yml); the steps to run are listed in
research/jobs.json. Everything here is public data: City of Chicago rideshare trips, Census
ACS and LODES, Census tract boundaries and OpenStreetMap. Nothing personal goes in this folder.

Steps
  chicago   pickups and drop-offs by tract x weekday x hour for each month in jobs.json
  tracts    2020 tract polygons for Cook County IL and King + Snohomish WA (area, centroid)
  acs       ACS 5-year tract features (population, income, car-free households, transit commuting)
  lodes     jobs by tract and sector (LEHD LODES workplace area characteristics)
  osm       venues by type from OpenStreetMap, assigned to tracts
  join      tract feature table for both regions + Chicago trips mapped to 2020 tracts
"""
import csv
import gzip
import io
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA = ROOT / "data"
LOG = []
UA = {"User-Agent": "next-fare-research/1.0 (github.com/element-school/next-fare)"}

REGIONS = {
    # state fips, county fips list, OSM bbox (south, west, north, east)
    "chicago": {"state": "17", "counties": ["031"], "bbox": (41.62, -87.96, 42.04, -87.50)},
    "seattle": {"state": "53", "counties": ["033", "061"], "bbox": (47.38, -122.46, 47.95, -122.00)},
}
SOCRATA = "https://data.cityofchicago.org/resource/6dvr-xwnh.json"
AIRPORT_CAS = (76, 56)  # O'Hare, Garfield Ridge (Midway)


def log(*a):
    msg = " ".join(str(x) for x in a)
    print(msg, flush=True)
    LOG.append(msg)


def get(url, params=None, timeout=300, tries=4, binary=False, headers=None):
    if params:
        url = url + ("&" if "?" in url else "?") + urllib.parse.urlencode(params)
    h = dict(UA)
    if headers:
        h.update(headers)
    for i in range(tries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=h), timeout=timeout) as r:
                b = r.read()
                return b if binary else b.decode("utf-8")
        except urllib.error.HTTPError as e:
            body = e.read()[:300].decode("utf-8", "replace")
            if 400 <= e.code < 500 and e.code != 429:  # the request itself is refused; retrying won't help
                raise RuntimeError(f"HTTP {e.code}: {body}") from None
            log(f"  retry {i + 1}/{tries} {url[:100]}: HTTP {e.code} {body[:150]}")
        except Exception as e:  # noqa: BLE001
            log(f"  retry {i + 1}/{tries} {url[:100]}: {e}")
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"failed: {url[:200]}")


def write_csv(path, rows, fields):
    path.parent.mkdir(parents=True, exist_ok=True)
    opener = gzip.open if str(path).endswith(".gz") else open
    with opener(path, "wt", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow(r)
    log(f"  wrote {path.relative_to(ROOT)} ({len(rows)} rows)")


# ---------------------------------------------------------------------------- chicago
CACHE = ROOT / "cache" / "chicago"  # per-day query results, kept between runs by actions/cache (not in git)
SUMS = ("n", "sec", "mi", "fare", "tipped", "to_airport")


def _chicago_query(side, d, hdr):
    import datetime as dt
    sel = [f"{side}_census_tract as tract", f"{side}_community_area as ca",
           "date_extract_hh(trip_start_timestamp) as hh", "count(*) as n", "sum(trip_seconds) as sec",
           "sum(trip_miles) as mi", "sum(fare) as fare", "sum(case(tip > 0, 1, true, 0)) as tipped"]
    if side == "pickup":
        sel.append(f"sum(case(dropoff_community_area = {AIRPORT_CAS[0]} OR dropoff_community_area = {AIRPORT_CAS[1]}, 1, true, 0)) as to_airport")
    nxt = d + dt.timedelta(days=1)
    q = {"$select": ", ".join(sel), "$group": "tract, ca, hh", "$limit": 50000,
         "$where": f"trip_start_timestamp >= '{d.isoformat()}T00:00:00' AND trip_start_timestamp < '{nxt.isoformat()}T00:00:00'"}
    t0 = time.time()
    page = json.loads(get(SOCRATA, q, timeout=150, tries=3, headers=hdr))
    if len(page) >= 50000:
        raise RuntimeError(f"{side} {d}: hit the 50,000-row limit")
    path = CACHE / f"{side}_{d.isoformat()}.json.gz"
    with gzip.open(path, "wt") as f:
        json.dump(page, f)
    return len(page), time.time() - t0


def chicago(job):
    """One small query per day and side (pickup/drop-off), grouped by tract and hour.

    A whole month in one query made the server drop the connection, so each day is fetched on
    its own, a few at a time, and cached. The step stops starting new queries after
    CHICAGO_BUDGET_MIN minutes and the next run resumes from the cache, so a slow server costs
    time rather than the whole pull. research/data/chicago_progress.json shows how far it got.
    When every day is in, the days are summed into tract x weekday x hour, plus a per-date x hour
    city total for checking holidays against ordinary days."""
    import datetime as dt
    from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
    token = (os.environ.get("SOCRATA_APP_TOKEN") or "").strip() or None
    hdr = {"X-App-Token": token} if token else None
    if token:  # an invalid token gets 403 on every query, so check it once up front
        try:
            get(SOCRATA, {"$limit": 1}, timeout=60, tries=2, headers=hdr)
            log(f"  app token accepted ({len(token)} characters)")
        except RuntimeError as e:
            log(f"  app token rejected, continuing without it: {e}")
            print(f"::warning::Socrata app token rejected ({len(token)} characters): {str(e)[:200]}", flush=True)
            token, hdr = None, None
    days = []
    for month in job.get("months", []):
        y, m = map(int, month.split("-"))
        d = dt.date(y, m, 1)
        while d.month == m:
            days.append(d)
            d += dt.timedelta(days=1)
    outs = [DATA / f"chicago_{s}s.csv.gz" for s in ("pickup", "dropoff")]
    if all(o.exists() for o in outs) and not job.get("force"):
        log("  skip chicago (outputs exist)")
        return
    CACHE.mkdir(parents=True, exist_ok=True)
    todo = [(s, d) for s in ("pickup", "dropoff") for d in days if not (CACHE / f"{s}_{d.isoformat()}.json.gz").exists()]
    total = 2 * len(days)
    log(f"  {total - len(todo)}/{total} days already cached; fetching {len(todo)} "
        f"({'with' if token else 'without'} an app token)")
    deadline = time.time() + float(os.environ.get("CHICAGO_BUDGET_MIN", "170")) * 60
    # without an app token Socrata throttles by IP (GitHub runners share IPs), so go gently
    workers = int(os.environ.get("CHICAGO_WORKERS", "4" if token else "2"))
    failed, done, times, last_save = [], 0, [], time.time()

    def progress(final=False):
        cached = len(list(CACHE.glob("*.json.gz")))
        (DATA / "chicago_progress.json").write_text(json.dumps({
            "cached": cached, "total": total, "failed": [f"{s} {d}" for s, d in failed][-20:],
            "median_query_s": round(sorted(times)[len(times) // 2], 1) if times else None,
            "updated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "final": final}, indent=1))
        return cached

    queue = list(todo)
    with ThreadPoolExecutor(max_workers=workers) as ex:
        running = {}
        while queue or running:
            while queue and len(running) < workers and time.time() < deadline:
                s, d = queue.pop(0)
                running[ex.submit(_chicago_query, s, d, hdr)] = (s, d)
            if not running:
                break
            fin, _ = wait(running, timeout=60, return_when=FIRST_COMPLETED)
            for fut in fin:
                s, d = running.pop(fut)
                try:
                    _, secs = fut.result()
                    times.append(secs)
                    done += 1
                    if done % 20 == 0:
                        log(f"  fetched {done}/{len(todo)} (last: {s} {d}, {secs:.0f}s)")
                except Exception as e:  # noqa: BLE001
                    failed.append((s, d))
                    log(f"  {s} {d} failed: {e}")
            if time.time() - last_save > 600:  # show progress in the repo every 10 minutes
                progress()
                if os.environ.get("COMMIT_EACH_STEP"):
                    commit("Research data: chicago progress")
                last_save = time.time()
    cached = progress(final=True)
    if cached < total:
        raise RuntimeError(f"chicago partial: {cached}/{total} days cached ({len(failed)} failed this run); "
                           "run again to resume")

    for side, out in zip(("pickup", "dropoff"), outs):
        agg, daily = {}, []
        for d in days:
            with gzip.open(CACHE / f"{side}_{d.isoformat()}.json.gz", "rt") as f:
                page = json.load(f)
            dow = (d.weekday() + 1) % 7  # Socrata convention: 0 = Sunday
            hours = {}
            for r in page:
                key = (r.get("tract") or "", r.get("ca") or "", dow, int(r["hh"]))
                a = agg.setdefault(key, dict.fromkeys(SUMS, 0.0))
                for fld in SUMS:
                    a[fld] += float(r.get(fld) or 0)
                hours[int(r["hh"])] = hours.get(int(r["hh"]), 0) + int(float(r["n"]))
            daily += [{"date": d.isoformat(), "dow": dow, "hh": h, "n": n} for h, n in sorted(hours.items())]
        rows = [{"tract": k[0], "ca": k[1], "dow": k[2], "hh": k[3], **v} for k, v in agg.items()]
        write_csv(out, rows, ["tract", "ca", "dow", "hh"] + list(SUMS))
        if side == "pickup":
            write_csv(DATA / "chicago_daily_hourly.csv", daily, ["date", "dow", "hh", "n"])
    # tract centroids as Chicago reports them (2010 tracts), for mapping to 2020 tracts
    cent = DATA / "chicago_tract_centroids.csv"
    if not cent.exists() or job.get("force"):
        seen = {}
        for side in ("pickup", "dropoff"):
            q = {"$select": f"{side}_census_tract as tract, {side}_centroid_latitude as lat, {side}_centroid_longitude as lng",
                 "$group": "tract, lat, lng", "$limit": 50000,
                 "$where": f"{side}_census_tract IS NOT NULL AND trip_start_timestamp >= '{days[0].isoformat()}T00:00:00' AND trip_start_timestamp < '{(days[0] + dt.timedelta(days=7)).isoformat()}T00:00:00'"}
            for r in json.loads(get(SOCRATA, q, timeout=300, tries=4, headers=hdr)):
                if r.get("tract") and r.get("lat"):
                    seen[r["tract"]] = {"tract": r["tract"], "lat": r["lat"], "lng": r["lng"]}
        write_csv(cent, list(seen.values()), ["tract", "lat", "lng"])


# ---------------------------------------------------------------------------- tracts
def _shapes(state):
    import shapefile  # pyshp
    for year in (2024, 2023, 2022):
        url = f"https://www2.census.gov/geo/tiger/GENZ{year}/shp/cb_{year}_{state}_tract_500k.zip"
        try:
            b = get(url, binary=True, tries=2)
            log(f"  tracts {state}: cb_{year}")
            break
        except RuntimeError:
            continue
    else:
        raise RuntimeError("no tract file")
    z = zipfile.ZipFile(io.BytesIO(b))
    stem = [n for n in z.namelist() if n.endswith(".shp")][0][:-4]
    r = shapefile.Reader(shp=io.BytesIO(z.read(stem + ".shp")), dbf=io.BytesIO(z.read(stem + ".dbf")),
                         shx=io.BytesIO(z.read(stem + ".shx")))
    return r


def tracts(job):
    from shapely.geometry import shape, mapping
    for name, reg in REGIONS.items():
        r = _shapes(reg["state"])
        fields = [f[0] for f in r.fields[1:]]
        rows, feats = [], []
        for sr in r.iterShapeRecords():
            rec = dict(zip(fields, sr.record))
            if rec.get("COUNTYFP") not in reg["counties"]:
                continue
            g = shape(sr.shape.__geo_interface__)
            c = g.representative_point()
            rows.append({"geoid": rec["GEOID"], "county": rec["COUNTYFP"], "aland_m2": rec.get("ALAND", 0),
                         "lat": round(c.y, 6), "lng": round(c.x, 6)})
            feats.append({"type": "Feature", "properties": {"geoid": rec["GEOID"]},
                          "geometry": mapping(g.simplify(0.0002, preserve_topology=True))})
        write_csv(DATA / f"tracts_{name}.csv", rows, ["geoid", "county", "aland_m2", "lat", "lng"])
        (DATA / f"tracts_{name}.geojson").write_text(json.dumps({"type": "FeatureCollection", "features": feats}))
        log(f"  wrote tracts_{name}.geojson ({len(feats)} tracts)")


# ---------------------------------------------------------------------------- acs
ACS_VARS = {
    "B01003_001E": "pop", "B19013_001E": "med_income", "B01002_001E": "med_age",
    "B25044_001E": "hh", "B25044_003E": "hh_owner_nocar", "B25044_010E": "hh_renter_nocar",
    "B08301_001E": "workers", "B08301_010E": "commute_transit", "B08301_016E": "commute_taxi",
    "B08301_019E": "commute_walk", "B08301_021E": "commute_home",
}


def _acs_table(year, table, prefixes):
    """Stream one ACS 5-year table-based summary file (all US geographies, pipe-delimited,
    no API key needed) and keep the tract rows whose GEO_ID starts with one of the prefixes.
    Returns {geoid: {column: value}} with columns named like B01003_001E."""
    url = (f"https://www2.census.gov/programs-surveys/acs/summary_file/{year}/table-based-SF/data/"
           f"5YRData/acsdt5y{year}-{table.lower()}.dat")
    out = {}
    for i in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r:
                lines = io.TextIOWrapper(r, encoding="utf-8", errors="replace")
                head = None
                for line in lines:
                    parts = line.rstrip("\n").split("|")
                    if head is None:
                        # columns look like B01003_E001; rename to the API style B01003_001E
                        head = []
                        for c in parts:
                            t, _, rest = c.partition("_")
                            head.append(f"{t}_{rest[1:]}{rest[0]}" if rest[:1] in ("E", "M") and rest[1:].isdigit() else c)
                        continue
                    if parts[0].startswith(prefixes):
                        out[parts[0][9:]] = dict(zip(head, parts))
            log(f"  acs {year} {table}: {len(out)} tracts")
            return out
        except urllib.error.HTTPError as e:
            if e.code == 404:
                raise RuntimeError(f"{url} not found")
            log(f"  retry {i + 1}/3 {url}: {e}")
        except Exception as e:  # noqa: BLE001
            log(f"  retry {i + 1}/3 {url}: {e}")
        time.sleep(15 * (i + 1))
    raise RuntimeError(f"failed: {url}")


def acs(job):
    """The Census API now answers 'Missing Key' to keyless requests, so this reads the bulk
    table-based summary files instead (one file per table, every geography in the country)."""
    prefixes = tuple(f"1400000US{reg['state']}{c}" for reg in REGIONS.values() for c in reg["counties"])
    tables = sorted({k.split("_")[0] for k in ACS_VARS})
    for year in (2024, 2023):
        try:
            merged = {}
            for t in tables:
                for geoid, d in _acs_table(year, t, prefixes).items():
                    merged.setdefault(geoid, {}).update(d)
            break
        except RuntimeError as e:
            log(f"  acs {year}: {e}")
    else:
        raise RuntimeError("ACS summary files unavailable for 2024 and 2023")
    missing = [k for k in ACS_VARS if not any(k in d for d in merged.values())]
    if missing:
        sample = next(iter(merged.values()), {})
        raise RuntimeError(f"ACS columns missing {missing}; file has {list(sample)[:12]}")
    for name, reg in REGIONS.items():
        rows = []
        for geoid, d in sorted(merged.items()):
            if not geoid.startswith(tuple(reg["state"] + c for c in reg["counties"])):
                continue
            out = {"geoid": geoid}
            for k, v in ACS_VARS.items():
                try:
                    x = float(d.get(k))
                except (TypeError, ValueError):
                    x = None
                out[v] = None if x is None or x < 0 else x  # negative = suppressed
            rows.append(out)
        log(f"  acs {name}: {year} acs5, {len(rows)} tracts")
        write_csv(DATA / f"acs_{name}.csv", rows, ["geoid"] + list(ACS_VARS.values()))


# ---------------------------------------------------------------------------- lodes
LODES_COLS = {"C000": "jobs", "CNS07": "jobs_retail", "CNS10": "jobs_finance", "CNS12": "jobs_professional",
              "CNS15": "jobs_education", "CNS16": "jobs_health", "CNS17": "jobs_arts", "CNS18": "jobs_food_lodging",
              "CNS20": "jobs_public_admin"}


def lodes(job):
    abbr = {"17": "il", "53": "wa"}
    for name, reg in REGIONS.items():
        st = abbr[reg["state"]]
        for year in (2023, 2022, 2021):
            url = f"https://lehd.ces.census.gov/data/lodes/LODES8/{st}/wac/{st}_wac_S000_JT00_{year}.csv.gz"
            try:
                b = get(url, binary=True, tries=2)
            except RuntimeError:
                continue
            agg = {}
            with gzip.open(io.BytesIO(b), "rt") as f:
                for rec in csv.DictReader(f):
                    geo = rec["w_geocode"]
                    if geo[2:5] not in reg["counties"]:
                        continue
                    t = agg.setdefault(geo[:11], {v: 0 for v in LODES_COLS.values()})
                    for k, v in LODES_COLS.items():
                        t[v] += int(rec[k])
            rows = [{"geoid": g, **v} for g, v in agg.items()]
            log(f"  lodes {name}: {year}, {len(rows)} tracts")
            write_csv(DATA / f"lodes_{name}.csv", rows, ["geoid"] + list(LODES_COLS.values()))
            break


# ---------------------------------------------------------------------------- osm
OSM_TYPES = {
    # key: overpass selector body (applied to nwr within bbox)
    "hotel": '["tourism"~"^(hotel|motel)$"]',
    "hostel_apt": '["tourism"~"^(hostel|apartment|guest_house)$"]',
    "bar": '["amenity"~"^(bar|pub|biergarten)$"]',
    "nightclub": '["amenity"="nightclub"]',
    "restaurant": '["amenity"="restaurant"]',
    "fast_food_cafe": '["amenity"~"^(fast_food|cafe)$"]',
    "venue": '["amenity"~"^(theatre|cinema|arts_centre|events_venue|concert_hall|music_venue)$"]',
    "stadium": '["leisure"~"^(stadium|sports_centre)$"]["name"]',
    "hospital": '["amenity"="hospital"]',
    "university": '["amenity"~"^(university|college)$"]',
    "rail_station": '["railway"="station"]',
    "mall": '["shop"="mall"]',
    "office": '["office"]',
    "supermarket": '["shop"="supermarket"]',
}
OVERPASS = "https://overpass-api.de/api/interpreter"


def osm(job):
    for name, reg in REGIONS.items():
        s, w, n, e = reg["bbox"]
        rows = []
        for key, sel in OSM_TYPES.items():
            q = f"[out:json][timeout:180];nwr{sel}({s},{w},{n},{e});out center tags;"
            for i in range(3):
                try:
                    data = json.loads(get(OVERPASS, {"data": q}, timeout=240, tries=2))
                    break
                except Exception as ex:  # noqa: BLE001
                    log(f"  overpass {name}/{key} attempt {i + 1}: {ex}")
                    time.sleep(30)
            else:
                raise RuntimeError(f"overpass failed {name}/{key}")
            for el in data.get("elements", []):
                c = el.get("center") or el
                if c.get("lat") is None:
                    continue
                t = el.get("tags", {})
                rows.append({"type": key, "osm": f"{el['type'][0]}{el['id']}", "lat": c["lat"], "lng": c["lon"],
                             "name": t.get("name", ""), "stars": t.get("stars", ""), "rooms": t.get("rooms", ""),
                             "brand": t.get("brand", ""), "sub": t.get("tourism") or t.get("amenity") or t.get("railway") or t.get("leisure") or t.get("shop") or t.get("office") or ""})
            log(f"  osm {name}/{key}: {sum(1 for r in rows if r['type'] == key)}")
            time.sleep(5)
        write_csv(DATA / f"osm_{name}.csv.gz", rows, ["type", "osm", "lat", "lng", "name", "stars", "rooms", "brand", "sub"])


# ---------------------------------------------------------------------------- join
def _index(name):
    from shapely.geometry import shape
    from shapely.strtree import STRtree
    gj = json.loads((DATA / f"tracts_{name}.geojson").read_text())
    geoms = [shape(f["geometry"]) for f in gj["features"]]
    ids = [f["properties"]["geoid"] for f in gj["features"]]
    return STRtree(geoms), geoms, ids


def _locate(tree, geoms, ids, lat, lng):
    from shapely.geometry import Point
    p = Point(lng, lat)
    for i in tree.query(p):
        if geoms[i].contains(p):
            return ids[i]
    j = tree.nearest(p)  # just outside a simplified edge
    return ids[j] if geoms[j].distance(p) < 0.003 else None


def join(job):
    for name in REGIONS:
        tree, geoms, ids = _index(name)
        # venue counts per tract
        counts = {}
        path = DATA / f"osm_{name}.csv.gz"
        if path.exists():
            with gzip.open(path, "rt") as f:
                for r in csv.DictReader(f):
                    g = _locate(tree, geoms, ids, float(r["lat"]), float(r["lng"]))
                    if g:
                        counts.setdefault(g, {}).setdefault(r["type"], 0)
                        counts[g][r["type"]] += 1
        rows = [{"geoid": g, **{f"osm_{k}": v.get(k, 0) for k in OSM_TYPES}} for g, v in counts.items()]
        write_csv(DATA / f"osm_counts_{name}.csv", rows, ["geoid"] + [f"osm_{k}" for k in OSM_TYPES])
        # Chicago trips: map each reported (2010) tract to the 2020 tract containing its centroid
        if name == "chicago":
            cent = {}
            cpath = DATA / "chicago_tract_centroids.csv"
            if cpath.exists():
                with open(cpath) as f:
                    for r in csv.DictReader(f):
                        cent[r["tract"]] = _locate(tree, geoms, ids, float(r["lat"]), float(r["lng"]))
            for side in ("pickup", "dropoff"):
                src = DATA / f"chicago_{side}s.csv.gz"
                if not src.exists():
                    continue
                out, kept, skipped = {}, 0, 0
                with gzip.open(src, "rt") as f:
                    for r in csv.DictReader(f):
                        g = cent.get(r["tract"]) if r["tract"] else None
                        n = float(r["n"] or 0)
                        if not g:
                            skipped += n  # suppressed tract (community area only) or outside the tract layer
                            continue
                        kept += n
                        k = (g, int(r["dow"]), int(r["hh"]))
                        o = out.setdefault(k, {"n": 0, "sec": 0.0, "mi": 0.0, "fare": 0.0, "tipped": 0, "to_airport": 0})
                        for fld in o:
                            o[fld] += float(r.get(fld) or 0)
                log(f"  {side}s mapped to a 2020 tract: {kept:.0f}; not mapped (left out): {skipped:.0f}")
                rows = [{"geoid": k[0], "dow": k[1], "hh": k[2], **v} for k, v in out.items()]
                write_csv(DATA / f"chicago_{side}s_by_tract2020.csv.gz", rows,
                          ["geoid", "dow", "hh", "n", "sec", "mi", "fare", "tipped", "to_airport"])


def commit(msg):
    """Save progress to the repo after each step, so a later failure keeps what finished."""
    import subprocess
    run = lambda *a: subprocess.run(a, cwd=ROOT.parent, capture_output=True, text=True)
    run("git", "add", "-A", "research/data")
    if run("git", "diff", "--cached", "--quiet").returncode == 0:
        return
    run("git", "commit", "-m", msg)
    for _ in range(3):
        if run("git", "pull", "--rebase", "origin", "main").returncode == 0 and run("git", "push", "origin", "HEAD:main").returncode == 0:
            log(f"  committed: {msg}")
            return
        time.sleep(10)
    log(f"  commit failed: {msg}")


STEPS = {"chicago": chicago, "tracts": tracts, "acs": acs, "lodes": lodes, "osm": osm, "join": join}


def main():
    job = json.loads((ROOT / "jobs.json").read_text())
    DATA.mkdir(parents=True, exist_ok=True)
    ok = True
    for step in job["run"]:
        log(f"== {step}")
        t0 = time.time()
        try:
            STEPS[step](job)
            print(f"::notice::{step} ok in {time.time() - t0:.0f}s", flush=True)
        except Exception as e:  # noqa: BLE001
            ok = False
            log(f"!! {step} failed: {e!r}")
            print(f"::error::{step} failed after {time.time() - t0:.0f}s: {str(e)[:400]}", flush=True)
        log(f"   {step} took {time.time() - t0:.0f}s")
        (DATA / "last_run.log").write_text("\n".join(LOG) + "\n")
        if os.environ.get("COMMIT_EACH_STEP"):
            commit(f"Research data: {step}")
    (DATA / "last_run.log").write_text("\n".join(LOG) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
