# Where Next

A personal companion web app for rideshare driving in the Seattle area. Open it after a drop-off: it reads your location and tells you what to do next. The options are to stay put, head to a specific neighborhood, leave or stay in the SEA waiting line, take a break (with takeout spots nearby), or call it a night when nothing within reach looks worth the time.

It runs entirely in the browser. There is no server, no account, and no connection to Uber.

## How it decides

`engine.js` scores every zone in `zones.js` for the next half hour:

- **Time of day and day of week**: a demand curve per zone type (nightlife, downtown and hotels, residential, office, campus, hospitals, Seattle Center, stadiums).
- **Events** from the day's data file. Big crowds flood the venue curb with drivers, so nearby neighborhoods get the boost. Mid-size crowds boost the venue itself. TV games boost bar districts at the final whistle.
- **SEA flight banks**: arrivals vs. departures by hour, from the day's real schedule when the flights file exists, otherwise a typical-day profile. Departure-heavy hours fill the waiting lot with drivers who just dropped off. With your place in line it estimates the wait.
- **Rain** from the NWS hourly forecast. The first hour of rain after a dry stretch counts most.
- **Pay floor**: pickups inside Seattle pay $0.70/min + $1.63/mi (2026) vs. $0.40/min + $1.38/mi outside.
- **Drive time** to each zone.
- **Small venues nearby**: comedy clubs, theaters, music venues, nightclubs and cinemas within about 900 m (from OpenStreetMap), with the times that kind of venue usually lets out. A let-out in the next half hour raises the score for your spot.
- **Your history**: the minutes between check-ins (≈ wait for a ping + the trip) by zone and time of day, once a spot has at least 3.

The rates are relative estimates for comparing options, not earnings predictions. The app can't see Uber's surge pricing or nearby drivers.

## Data

- `data/YYYY-MM-DD.json`: one file per day, written each evening by a scheduled Claude task. Schema:

```json
{
  "date": "2026-10-17",
  "generatedAt": "2026-10-17T03:45:00Z",
  "events": [
    { "name": "Maná", "venue": "Climate Pledge Arena", "lat": 47.6221, "lng": -122.354,
      "start": "20:30", "out": "23:15", "crowd": "big", "kind": "concert", "note": "", "unconfirmed": false }
  ],
  "sea": { "arrivals": [24 numbers, 0-100], "departures": [24 numbers, 0-100] },
  "pae": { "arrivals": ["HH:MM", "..."] },
  "notes": ["..."]
}
```

`crowd` is `big` (arena or stadium), `mid` (about 1,000–3,000) or `small`. `kind` is one of `concert`, `sports`, `festival`, `convention`, `comedy`, `theatre` or `watch` (a TV game; no coordinates, boosts bar districts). Times are Pacific, 24-hour; an `out` earlier than `start` means after midnight. `sea` and `pae` are optional; without them the app uses a typical-day SEA profile.

- `data/flights/YYYY-MM-DD.json`: scheduled passenger flights at SEA and PAE, written each evening by the **Flight schedules** GitHub Action (`.github/workflows/flights.yml`, `scripts/flights.py`) from [AeroDataBox](https://aerodatabox.com/). It overrides `sea` and `pae` in the events file. `sea.arrivals` is a demand index for riders at the curb (flights shifted 30 minutes after landing), `sea.departures` a drop-off index (flights shifted 90 minutes before take-off), both scaled so the busiest hour is 100. `sea.scheduled` keeps the raw counts by scheduled hour. Codeshares, cargo and private flights are excluded.
  - Setup: get a free RapidAPI key for AeroDataBox (Basic plan, 400 units a month; this uses about 6 a day) and save it as the repository secret `AERODATABOX_KEY` (Settings → Secrets and variables → Actions). Without the key the Action skips and the app uses its typical-day profile.
  - Run it by hand from the Actions tab (Run workflow); leave the dates empty to fetch today and tomorrow.

- **On the phone** (localStorage, `wn-` keys): check-in history, settings (home, maps app), SEA line position, cached weather and neighborhood names. None of it leaves the device.

## Live services (all free, no keys)

- Location: the browser's Geolocation API.
- Neighborhood names: OpenStreetMap Nominatim, cached per ~100 m.
- Weather: api.weather.gov hourly forecast, cached 45 min.
- Venues nearby: OpenStreetMap Overpass, cached per ~1 km for 12 hours.
- Takeout: OpenStreetMap Overpass, only on request.

## Develop

Static files, no build step. Serve the folder locally (`python3 -m http.server`) and open http://localhost:8000. Geolocation works on localhost and on HTTPS (GitHub Pages).
