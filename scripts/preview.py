#!/usr/bin/env python3
"""Static preview server for the Celia Kids site.

Serves the repository root but never exposes build artifacts, tooling, or
dotfiles. Binds to 0.0.0.0 so the sandbox preview proxy can reach it.

    python3 scripts/preview.py            # http://0.0.0.0:8080
    PORT=3000 python3 scripts/preview.py
"""
from __future__ import annotations

import os
import posixpath
import sys
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parent.parent
PORT = int(os.environ.get("PORT", "8080"))
HOST = os.environ.get("HOST", "0.0.0.0")

# Never served: generated Apps Script bundle, git data, tests and tooling.
BLOCKED_PREFIXES = ("gas/", "scripts/", "config/", ".git/", ".github/", "_site/", "node_modules/")
# docs/ is readable except the operations runbooks, which name the rotation path.
BLOCKED_DOC_FILES = {"docs/secrets.md", "docs/secrets-manifest.json", "docs/exit-plan.md"}
PUBLIC_PREFIXES = ("docs/map/",)
BLOCKED_FILES = {"app.config.ts", "manus-routes.json", "SKILL.md"}
BLOCKED_SUFFIXES = (".py", ".gs", ".ts")


class PreviewHandler(SimpleHTTPRequestHandler):
    server_version = "CeliaPreview/2026"

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        clean = unquote(path.split("?", 1)[0].split("#", 1)[0])
        clean = posixpath.normpath(clean)
        parts = [part for part in clean.split("/") if part not in ("", ".", "..")]
        if parts and parts[-1] == "index.html":
            parts = parts[:-1]
        return str(ROOT.joinpath(*parts))

    def _blocked(self, path: str) -> bool:
        clean = unquote(path.split("?", 1)[0]).lstrip("/")
        if not clean or clean.endswith("/"):
            return False
        if any(part.startswith(".") for part in Path(clean).parts):
            return True
        if clean in BLOCKED_FILES or clean in BLOCKED_DOC_FILES or clean.endswith(BLOCKED_SUFFIXES):
            return True
        if clean.startswith(PUBLIC_PREFIXES) and not clean.endswith((".md", ".json")):
            return True
        return any(clean.startswith(prefix) for prefix in BLOCKED_PREFIXES)

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        if self._blocked(self.path):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        super().do_GET()

    def do_HEAD(self) -> None:  # noqa: N802
        if self._blocked(self.path):
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        super().do_HEAD()

    def end_headers(self) -> None:
        path = self.path.split("?", 1)[0]
        if path.endswith(".woff2") or path.endswith(".svg"):
            self.send_header("Cache-Control", "public, max-age=604800, immutable")
        elif path.endswith((".css", ".js", ".webmanifest")):
            self.send_header("Cache-Control", "public, max-age=300")
        else:
            self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("%s — %s\n" % (self.log_date_time_string(), fmt % args))


def main() -> int:
    if not (ROOT / "index.html").exists():
        print(f"index.html not found in {ROOT}", file=sys.stderr)
        return 1
    server = ThreadingHTTPServer((HOST, PORT), PreviewHandler)
    print(f"Celia Kids preview → http://{HOST}:{PORT}  (root: {ROOT})", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("stopped", flush=True)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
