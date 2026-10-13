#!/usr/bin/env python3
"""Stamp a new app version so phones pick up the change.

Updates version.json, the APP_VERSION constant in app.js and the ?v= on the script tags in
index.html. The app compares version.json with the version it is running and reloads itself
when they differ. Run before committing any change to index.html, app.js, engine.js or zones.js.
"""
import json
import re
from datetime import datetime, timezone
from pathlib import Path

root = Path(__file__).resolve().parent.parent
v = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M")
(root / "version.json").write_text(json.dumps({"v": v}) + "\n")
app = root / "app.js"
app.write_text(re.sub(r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{v}';", app.read_text(), count=1))
idx = root / "index.html"
idx.write_text(re.sub(r'src="(zones|engine|app)\.js(\?v=[^"]*)?"', lambda m: f'src="{m.group(1)}.js?v={v}"', idx.read_text()))
print(v)
