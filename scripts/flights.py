#!/usr/bin/env python3
"""Fetch scheduled passenger flights at SEA and PAE and write data/flights/YYYY-MM-DD.json.

Runs in GitHub Actions (see .github/workflows/flights.yml). Source: AeroDataBox FIDS
endpoint via RapidAPI, key in the AERODATABOX_KEY secret. Standard library only.

Output (all times Pacific):
{
  "date": "2026-10-13", "fetchedAt": "...Z", "source": "AeroDataBox",
  "sea": {
    "arrivals":   [24 ints 0-100],  # rideshare demand index: flights landing ~30 min earlier
    "departures": [24 ints 0-100],  # drop-off index: flights leaving ~90 min later
    "scheduled":  {"arrivals": [24 counts], "departures": [24 counts]}  # by scheduled hour
  },
  "pae": {"arrivals": ["HH:MM", ...]}
}
The two index lists share one scale: the busiest hour of either list is 100.
"""
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from zoneinfo import ZoneInfo

TZ = ZoneInfo("America/Los_Angeles")
HOST = "aerodatabox.p.rapidapi.com"
ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "data" / "flights"
ARRIVAL_TO_CURB_MIN = 30      # landing -> rider requesting a car
DROPOFF_BEFORE_DEP_MIN = 90   # driver drops a rider off this long before the flight leaves
KEEP_DAYS = 14


def fids(code, frm, to, direction):
    """One FIDS call (TIER 2 = 2 API units; 3 calls a day = 6 units). Returns the parsed JSON dict."""
    fixtures = os.environ.get("FLIGHTS_FIXTURES")  # offline testing
    if fixtures:
        p = Path(fixtures) / f"{code}_{frm.replace(':', '')}_{direction}.json"
        return json.loads(p.read_text()) if p.exists() else {}
    q = urllib.parse.urlencode({
        "direction": direction, "withLeg": "false", "withCancelled": "false",
        "withCodeshared": "false", "withCargo": "false", "withPrivate": "false",
        "withLocation": "false",
    })
    url = f"https://{HOST}/flights/airports/iata/{code}/{frm}/{to}?{q}"
    req = urllib.request.Request(url, headers={
        "X-RapidAPI-Key": os.environ["AERODATABOX_KEY"], "X-RapidAPI-Host": HOST,
        "Accept": "application/json",
    })
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=40) as r:
                body = r.read()
                return json.loads(body) if body.strip() else {}
        except urllib.error.HTTPError as e:
            if e.code == 204:
                return {}
            if e.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(5 * (attempt + 1))
                continue
            raise SystemExit(f"AeroDataBox {code} {frm}: HTTP {e.code} {e.read()[:300]!r}")
        except urllib.error.URLError as e:
            if attempt < 2:
                time.sleep(5)
                continue
            raise SystemExit(f"AeroDataBox {code} {frm}: {e}")
        finally:
            time.sleep(1.2)  # free plan: 1 request per second
    return {}


def local_time(flight):
    """Scheduled local time at this airport as a naive datetime, or None."""
    mv = flight.get("movement") or {}
    st = (mv.get("scheduledTime") or {}).get("local") or flight.get("scheduledTimeLocal")
    if not st:
        return None
    try:
        return datetime.fromisoformat(st.replace(" ", "T")[:16])
    except ValueError:
        return None


def passenger(flight):
    if flight.get("isCargo"):
        return False
    return flight.get("codeshareStatus") not in ("IsCodeshared",)


def collect(code, day, direction, windows):
    """Scheduled local times of passenger flights, as {"arrivals": [...], "departures": [...]}.
    One call per window; direction "Both" returns both lists from the same call."""
    out = {"arrivals": [], "departures": []}
    seen = set()
    for frm, to in windows:
        res = fids(code, f"{day}T{frm}", f"{day}T{to}", direction)
        for key in out:
            for f in res.get(key) or []:
                t = local_time(f)
                if t is None or not passenger(f):
                    continue
                ident = (key, f.get("number"), t)
                if ident in seen:
                    continue
                seen.add(ident)
                out[key].append(t)
    return {k: sorted(v) for k, v in out.items()}


def hourly(times, day, shift_min=0):
    counts = [0] * 24
    for t in times:
        s = t + timedelta(minutes=shift_min)
        if s.date() == day:
            counts[s.hour] += 1
    return counts


def build(day):
    d = day.isoformat()
    halves = [("00:00", "12:00"), ("12:00", "23:59")]
    sea = collect("SEA", d, "Both", halves)                      # 2 calls
    sea_arr, sea_dep = sea["arrivals"], sea["departures"]
    pae_arr = collect("PAE", d, "Arrival", [("09:00", "21:00")])["arrivals"]  # 1 call
    if not sea_arr and not sea_dep:
        print(f"{d}: no SEA flights returned; leaving any existing file alone")
        return None
    demand = hourly(sea_arr, day, ARRIVAL_TO_CURB_MIN)
    dropoff = hourly(sea_dep, day, -DROPOFF_BEFORE_DEP_MIN)
    peak = max(demand + dropoff) or 1
    scale = lambda xs: [round(100 * x / peak) for x in xs]
    doc = {
        "date": d,
        "fetchedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "source": "AeroDataBox (scheduled passenger flights, codeshares and cargo excluded)",
        "sea": {
            "arrivals": scale(demand),
            "departures": scale(dropoff),
            "scheduled": {"arrivals": hourly(sea_arr, day), "departures": hourly(sea_dep, day)},
        },
    }
    if pae_arr:
        doc["pae"] = {"arrivals": [t.strftime("%H:%M") for t in pae_arr]}
    print(f"{d}: SEA {len(sea_arr)} arrivals, {len(sea_dep)} departures; PAE {len(pae_arr)} arrivals")
    return doc


def main():
    if not os.environ.get("AERODATABOX_KEY") and not os.environ.get("FLIGHTS_FIXTURES"):
        print("::warning::AERODATABOX_KEY secret is not set; skipping flight schedules.")
        return 0
    today = datetime.now(TZ).date()
    raw = (os.environ.get("DATES") or "").strip()
    if raw:
        days = [date.fromisoformat(x.strip()) for x in raw.split(",") if x.strip()]
    elif os.environ.get("EVENT") in ("push", "workflow_dispatch"):
        days = [today, today + timedelta(days=1)]
    else:
        days = [today + timedelta(days=1)]
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    for day in days:
        doc = build(day)
        if doc:
            (OUT_DIR / f"{day.isoformat()}.json").write_text(json.dumps(doc, indent=1) + "\n")
    cutoff = today - timedelta(days=KEEP_DAYS)
    for p in OUT_DIR.glob("*.json"):
        try:
            if date.fromisoformat(p.stem) < cutoff:
                p.unlink()
        except ValueError:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
