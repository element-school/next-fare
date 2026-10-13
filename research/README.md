# Research: where rides come from

Public data for a ride-demand model that learns, from Chicago's published rideshare trips, how many
rides each kind of place generates by hour (hotels, bars, restaurants, offices, hospitals, homes),
and transfers that to Seattle-area census tracts using the same features.

- `pull.py` downloads and aggregates the data in GitHub Actions (`.github/workflows/research.yml`);
  edit `jobs.json` to choose steps and months.
- `data/` holds the outputs: Chicago pickups/drop-offs by tract x weekday x hour, tract boundaries,
  ACS and LODES tract features, OpenStreetMap venue counts. All public data.

Sources: City of Chicago Transportation Network Providers trips (data.cityofchicago.org, 6dvr-xwnh);
US Census ACS 5-year and cartographic boundary files; LEHD LODES 8; OpenStreetMap via Overpass.
Nothing about the driver or riders goes in this folder.
