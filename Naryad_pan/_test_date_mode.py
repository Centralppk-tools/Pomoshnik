import json
import uuid
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent
xlsx = ROOT / "_tmp" / "1_МЯЭД_часы_смен_с_05_08_2026_норматив_ПН_ЧТ.xlsx"
if not xlsx.is_file():
    print("skip: no xlsx")
    raise SystemExit(0)

meta = json.dumps(
    {
        "normativeFrom": "2026-09-01",
        "closePrevious": True,
        "rows": [{"mode": "date", "date": "2026-08-28"}],
    },
    ensure_ascii=False,
)

boundary = uuid.uuid4().hex
body = bytearray()


def add_part(name, val, filename=None):
    body.extend(f"--{boundary}\r\n".encode())
    if filename:
        body.extend(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n\r\n'.encode())
        body.extend(val)
    else:
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(val.encode("utf-8"))
    body.extend(b"\r\n")


add_part("meta", meta)
add_part("file_0", xlsx.read_bytes(), xlsx.name)
body.extend(f"--{boundary}--\r\n".encode())

health = urllib.request.urlopen("http://127.0.0.1:8791/api/health", timeout=5)
print("health", health.read().decode())

req = urllib.request.Request("http://127.0.0.1:8791/api/preview", data=bytes(body), method="POST")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.loads(r.read().decode())
    print("preview ok", out.get("ok"), "rows", out.get("stats", {}).get("rows"))
except urllib.error.HTTPError as e:
    print("preview fail", e.read().decode())
