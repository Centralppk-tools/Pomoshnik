import json
import uuid
import urllib.error
import urllib.request
from pathlib import Path

xlsx = Path(__file__).resolve().parents[1] / "Часы смен" / "c 05_08" / "1_МЯЭД_часы_смен_с_05_08_2026_норматив_ПН_ЧТ.xlsx"
meta = json.dumps(
    {"normativeFrom": "2026-09-01", "closePrevious": True, "rows": [{"mode": "marker", "marker": "пн-чт"}]},
    ensure_ascii=False,
)

boundary = uuid.uuid4().hex
body = bytearray()


def add_part(name, val, filename=None, ctype="application/octet-stream"):
    body.extend(f"--{boundary}\r\n".encode())
    if filename:
        body.extend(f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'.encode())
        body.extend(f"Content-Type: {ctype}\r\n\r\n".encode())
        body.extend(val if isinstance(val, (bytes, bytearray)) else str(val).encode())
    else:
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(val.encode("utf-8"))
    body.extend(b"\r\n")


add_part("meta", meta)
add_part("file_0", xlsx.read_bytes(), xlsx.name, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
body.extend(f"--{boundary}--\r\n".encode())

req = urllib.request.Request("http://127.0.0.1:8791/api/preview", data=bytes(body), method="POST")
req.add_header("Content-Type", f"multipart/form-data; boundary={boundary}")
try:
    with urllib.request.urlopen(req, timeout=120) as r:
        out = json.loads(r.read().decode())
    print("ok", out.get("ok"), "rows", out.get("stats", {}).get("rows"))
except urllib.error.HTTPError as e:
    print(e.read().decode())
