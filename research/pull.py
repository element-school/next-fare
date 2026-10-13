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
        except Exception as e:  # noqa: BLE001
            log(f"  retry {i + 1}/{tries} {url[:140]}: {e}")
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
def chicago(job):
    token = os.environ.get("SOCRATA_APP_TOKEN")
    hdr = {"X-App-Token": token} if token else None
    for month in job.get("months", []):
        y, m = map(int, month.split("-"))
        nxt = f"{y + (m == 12)}-{(m % 12) + 1:02d}"
        where = f"trip_start_timestamp >= '{month}-01T00:00:00' AND trip_start_timestamp < '{nxt}-01T00:00:00'"
        for side in ("pickup", "dropoff"):
            out = DATA / f"chicago_{side}s_{month}.csv.gz"
            if out.exists() and not job.get("force"):
                log(f"  skip {out.name} (exists)")
                continue
            sel = [
                f"{side}_census_tract as tract", f"{side}_community_area as ca",
                f"{side}_centroid_latitude as lat", f"{side}_centroid_longitude as lng",
                "date_extract_dow(trip_start_timestamp) as dow", "date_extract_hh(trip_start_timestamp) as hh",
                "count(*) as n", "sum(trip_seconds) as sec", "sum(trip_miles) as mi", "sum(fare) as fare",
                "sum(case(tip > 0, 1, true, 0)) as tipped",
            ]
            if side == "pickup":
                sel.append(f"sum(case(dropoff_community_area = {AIRPORT_CAS[0]} OR dropoff_community_area = {AIRPORT_CAS[1]}, 1, true, 0)) as to_airport")
            group = "tract, ca, lat, lng, dow, hh"
            rows, offset, t0 = [], 0, time.time()
            while True:
                q = {"$select": ", ".join(sel), "$where": where, "$group": group,
                     "$order": group, "$limit": 50000, "$offset": offset}
                page = json.loads(get(SOCRATA, q, timeout=600, headers=hdr))
                rows += page
                log(f"  {month} {side}s offset {offset}: {len(page)} rows ({time.time() - t0:.0f}s)")
                if len(page) < 50000:
                    break
                offset += 50000
            fields = ["tract", "ca", "lat", "lng", "dow", "hh", "n", "sec", "mi", "fare", "tipped", "to_airport"]
            write_csv(out, rows, fields)


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


def acs(job):
    for name, reg in REGIONS.items():
        for year in (2024, 2023):
            try:
                rows = []
                for county in reg["counties"]:
                    txt = get(f"https://api.census.gov/data/{year}/acs/acs5",
                              {"get": ",".join(ACS_VARS), "for": "tract:*", "in": f"state:{reg['state']} county:{county}"}, tries=2)
                    data = json.loads(txt)
                    head = data[0]
                    for row in data[1:]:
                        d = dict(zip(head, row))
                        out = {"geoid": d["state"] + d["county"] + d["tract"]}
                        for k, v in ACS_VARS.items():
                            x = float(d[k]) if d[k] not in (None, "") else None
                            out[v] = None if x is None or x < 0 else x  # negative = suppressed
                        rows.append(out)
                log(f"  acs {name}: {year} acs5, {len(rows)} tracts")
                write_csv(DATA / f"acs_{name}.csv", rows, ["geoid"] + list(ACS_VARS.values()))
                break
            except RuntimeError:
                continue


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
        # Chicago trip centroids -> 2020 tracts
        if name == "chicago":
            for side in ("pickup", "dropoff"):
                cache, out, kept, skipped = {}, {}, 0, 0
                for p in sorted(DATA.glob(f"chicago_{side}s_2*.csv.gz")):
                    with gzip.open(p, "rt") as f:
                        for r in csv.DictReader(f):
                            # Rows without a tract carry a community-area centroid; mapping that to
                            # one tract would be wrong, so they are counted and left out.
                            if not r["lat"] or not r["tract"]:
                                skipped += float(r["n"] or 0)
                                continue
                            kept += float(r["n"] or 0)
                            key = (r["lat"], r["lng"])
                            if key not in cache:
                                cache[key] = _locate(tree, geoms, ids, float(r["lat"]), float(r["lng"]))
                            g = cache[key]
                            if not g:
                                continue
                            k = (g, int(r["dow"]), int(r["hh"]))
                            o = out.setdefault(k, {"n": 0, "sec": 0.0, "mi": 0.0, "fare": 0.0, "tipped": 0, "to_airport": 0})
                            for fld in o:
                                v = r.get(fld) or 0
                                o[fld] += float(v)
                log(f"  {side}s with a tract: {kept:.0f}; without (left out): {skipped:.0f}")
                rows = [{"geoid": k[0], "dow": k[1], "hh": k[2], **v} for k, v in out.items()]
                write_csv(DATA / f"chicago_{side}s_by_tract2020.csv.gz", rows,
                          ["geoid", "dow", "hh", "n", "sec", "mi", "fare", "tipped", "to_airport"])


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
        except Exception as e:  # noqa: BLE001
            ok = False
            log(f"!! {step} failed: {e!r}")
        log(f"   {step} took {time.time() - t0:.0f}s")
    (DATA / "last_run.log").write_text("\n".join(LOG) + "\n")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
