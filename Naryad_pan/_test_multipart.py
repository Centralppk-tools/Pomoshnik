import cgi
import io
import json
import uuid
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
add_part("file_0", xlsx.read_bytes(), xlsx.name)
body.extend(f"--{boundary}--\r\n".encode())

fp = io.BytesIO(bytes(body))
ctype = f"multipart/form-data; boundary={boundary}"
form = cgi.FieldStorage(
    fp=fp,
    headers={"content-type": ctype, "content-length": str(len(body))},
    environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": ctype, "CONTENT_LENGTH": str(len(body))},
)
print("keys", list(form.keys()))
meta_raw = form.getvalue("meta")
print("meta", meta_raw[:80] if meta_raw else None)
key = "file_0"
print("contains", key in form)
field = form[key]
print("field type", type(field), "filename", getattr(field, "filename", None))
