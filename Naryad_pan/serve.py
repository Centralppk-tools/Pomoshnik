#!/usr/bin/env python3
"""Локальный сервер Naryad_pan — статика + API preview/apply."""
from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import traceback
import uuid
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

NARYAD_ROOT = Path(__file__).resolve().parent
if str(NARYAD_ROOT) not in sys.path:
    sys.path.insert(0, str(NARYAD_ROOT))

from lib.multipart import parse_preview_form  # noqa: E402
from lib.process import guess_marker, read_bundle_info, run_apply, run_preview  # noqa: E402

HOST = "127.0.0.1"
PORT = 8791
BUILD = "2026-08-29-bundle-fix"
TMP = NARYAD_ROOT / "_tmp"
PREVIEW_CACHE: dict[str, dict] = {}


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(NARYAD_ROOT), **kwargs)

    def log_message(self, fmt, *args):
        sys.stderr.write("[naryad] " + (fmt % args) + "\n")

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_GET(self):
        if self.path == "/api/health":
            self._json(200, {"ok": True, "service": "naryad_pan", "build": BUILD})
            return
        if self.path == "/api/bundle-info":
            self._json(200, {"ok": True, **read_bundle_info()})
            return
        if self.path in ("/", "/index.html"):
            self.path = "/Index.html"
        return super().do_GET()

    def do_POST(self):
        if self.path == "/api/preview":
            self._handle_preview()
            return
        if self.path == "/api/apply":
            self._handle_apply()
            return
        self._json(404, {"ok": False, "error": "not found"})

    def _json(self, code, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _parse_multipart(self):
        ctype = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else b""
        meta, uploads = parse_preview_form(body, ctype)
        files = []
        TMP.mkdir(parents=True, exist_ok=True)
        rows = meta.get("rows") or []
        for idx, (filename, data) in enumerate(uploads):
            safe = Path(filename).name
            dest = TMP / f"{uuid.uuid4().hex}_{safe}"
            dest.write_bytes(data)
            row_meta = rows[idx] if idx < len(rows) else {}
            if not isinstance(row_meta, dict):
                row_meta = {}
            files.append({
                "path": str(dest),
                "name": safe,
                "mode": row_meta.get("mode", "marker"),
                "marker": row_meta.get("marker"),
                "date": row_meta.get("date"),
            })
        return meta, files

    def _handle_preview(self):
        try:
            meta, files = self._parse_multipart()
            for i, f in enumerate(files):
                row = (meta.get("rows") or [None])[i] or {}
                if not f.get("marker") and row.get("marker"):
                    f["marker"] = row["marker"]
                if not f.get("mode") and row.get("mode"):
                    f["mode"] = row["mode"]
                if not f.get("date") and row.get("date"):
                    f["date"] = row["date"]
                if f.get("mode", "marker") == "marker" and not f.get("marker"):
                    guessed = guess_marker(f["name"])
                    if guessed:
                        f["marker"] = guessed

            result = run_preview(
                files,
                str(meta.get("normativeFrom") or "").strip(),
                bool(meta.get("closePrevious", True)),
            )
            token = uuid.uuid4().hex
            PREVIEW_CACHE[token] = result
            out = dict(result)
            out["previewToken"] = token
            out.pop("_bundle", None)
            self._json(200, out)
        except Exception as err:
            traceback.print_exc()
            self._json(400, {"ok": False, "error": str(err)})

    def _handle_apply(self):
        try:
            length = int(self.headers.get("Content-Length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            body = json.loads(raw.decode("utf-8") or "{}")
            token = body.get("previewToken")
            if not token or token not in PREVIEW_CACHE:
                raise ValueError("сначала предпросмотр")
            out = run_apply(PREVIEW_CACHE[token], write_local=bool(body.get("writeLocal", True)))
            self._json(200, out)
        except Exception as err:
            self._json(400, {"ok": False, "error": str(err)})


def _kill_port_listeners(port: int) -> None:
    if sys.platform == "win32":
        try:
            out = subprocess.check_output(
                ["netstat", "-ano"],
                stderr=subprocess.DEVNULL,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            for line in out.splitlines():
                if f":{port}" not in line or "LISTENING" not in line:
                    continue
                pid = line.split()[-1]
                if pid.isdigit() and int(pid) != os.getpid():
                    subprocess.run(["taskkill", "/F", "/PID", pid], check=False, capture_output=True)
        except (OSError, subprocess.SubprocessError):
            pass
    else:
        import signal
        try:
            out = subprocess.check_output(["lsof", "-ti", f":{port}"], text=True)
            for pid in out.split():
                if pid.strip().isdigit():
                    os.kill(int(pid), signal.SIGTERM)
        except (OSError, subprocess.SubprocessError):
            pass


def _port_busy(host: str, port: int) -> bool:
    probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        return probe.connect_ex((host, port)) == 0
    finally:
        probe.close()


def main():
    if _port_busy(HOST, PORT):
        print(f"Порт {PORT} занят — останавливаю старый процесс…")
        _kill_port_listeners(PORT)
        import time
        time.sleep(0.5)
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    print(f"Naryad_pan: http://{HOST}:{PORT}/  (build {BUILD})")
    print("Ctrl+C для остановки")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nstop")


if __name__ == "__main__":
    main()
