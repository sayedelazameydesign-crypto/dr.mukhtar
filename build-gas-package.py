#!/usr/bin/env python3
"""Inline the standalone app's CSS and JS into an Apps Script HtmlService page."""
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
html = (ROOT / "index.html").read_text(encoding="utf-8")
css = (ROOT / "app.css").read_text(encoding="utf-8")
js = (ROOT / "app.js").read_text(encoding="utf-8")

html, css_count = re.subn(
    r'<link rel="stylesheet" href="\./app\.css">',
    lambda _match: "<style>\n" + css + "\n</style>",
    html,
    count=1,
)
html, js_count = re.subn(
    r'<script src="\./app\.js" defer></script>',
    lambda _match: "<script>\n" + js + "\n</script>",
    html,
    count=1,
)
if css_count != 1 or js_count != 1:
    raise SystemExit("Could not find exactly one CSS and JS entry point in index.html")

out = ROOT / "gas" / "Index.html"
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(html, encoding="utf-8")
print(f"Built {out.relative_to(ROOT)} ({out.stat().st_size} bytes)")
