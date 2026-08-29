"""Сборка и метаданные shift-templates.json."""
from __future__ import annotations

import re
from typing import Any

DATE_MARKER_RE = re.compile(r"^\d{2}-\d{2}-\d{4}$")
WEEKDAY_MARKERS = frozenset({"пн-чт", "пт", "сб", "вс"})


def pick_active_normative(normatives: list[dict]) -> dict | None:
    for item in reversed(normatives):
        if item.get("normativeTo") in (None, ""):
            return item
    return normatives[-1] if normatives else None


def app_date_to_iso(app_date: str) -> str | None:
    m = DATE_MARKER_RE.match(str(app_date or "").strip())
    if not m:
        return None
    d, mo, y = app_date.split("-")
    return f"{y}-{mo}-{d}"


def collect_one_time_dates(rows: list[dict]) -> list[str]:
    dates = sorted({str(r.get("date") or "").strip() for r in rows if DATE_MARKER_RE.match(str(r.get("date") or ""))})
    return [d for d in dates if d]


def compute_loaded_until_iso(normatives: list[dict]) -> str | None:
    max_iso = None
    for bundle in normatives:
        for row in bundle.get("shiftDetails") or []:
            iso = app_date_to_iso(row.get("date"))
            if iso and (max_iso is None or iso > max_iso):
                max_iso = iso
    return max_iso


def finalize_bundle(data: dict, es_module: Any) -> dict:
    """Корневой shiftDetails = только активный норматив (без дубля всех периодов)."""
    normatives = list(data.get("normatives") or [])
    active = pick_active_normative(normatives)

    if active and active.get("shiftDetails"):
        root_rows = es_module.sort_rows(es_module.dedupe_rows(list(active["shiftDetails"])))
    elif not normatives and data.get("shiftDetails"):
        root_rows = es_module.sort_rows(es_module.dedupe_rows(list(data["shiftDetails"])))
    else:
        root_rows = []

    data["normatives"] = normatives
    data["shiftDetails"] = root_rows
    data["stats"] = {
        "rows": len(root_rows),
        "routes": len({r["route"] for r in root_rows}),
        "markers": sorted({r["date"] for r in root_rows}),
        "normatives": len(normatives),
    }
    data["meta"] = describe_bundle_meta(data)
    return data


def list_bundle_tags(data: dict | None) -> list[dict]:
    if not data:
        return []
    tags: list[dict] = []
    normatives = data.get("normatives") or []
    active = pick_active_normative(normatives) if normatives else None

    for item in normatives:
        nid = str(item.get("id") or "")
        rows = item.get("shiftDetails") or []
        weekday_rows = [r for r in rows if str(r.get("date") or "").strip() in WEEKDAY_MARKERS]
        to_label = item.get("normativeTo") or "…"
        tags.append({
            "id": f"normative:{nid}",
            "kind": "normative",
            "normativeId": nid,
            "label": f"Норматив · {item.get('normativeFrom')} – {to_label}",
            "rows": len(weekday_rows),
            "totalRows": len(rows),
            "files": len(item.get("sourceFiles") or []),
            "active": active is not None and item.get("id") == active.get("id"),
            "uploadedAt": None,
        })
        for upload in item.get("uploads") or []:
            uid = str(upload.get("id") or "")
            dates = upload.get("dates") or []
            date_hint = ", ".join(dates[:4])
            if len(dates) > 4:
                date_hint += "…"
            tags.append({
                "id": f"upload:{uid}",
                "kind": "upload",
                "normativeId": nid,
                "uploadId": uid,
                "label": f"Разово · {date_hint or uid}",
                "rows": upload.get("rows") or len(dates),
                "totalRows": upload.get("rows") or 0,
                "files": len(upload.get("sourceFiles") or []),
                "active": False,
                "uploadedAt": upload.get("uploadedAt"),
                "dates": dates,
            })

    tags.sort(key=lambda t: (t.get("uploadedAt") or t.get("normativeId") or "", t.get("id") or ""), reverse=True)
    return tags


def get_rows_for_tag(data: dict | None, tag_id: str, es_module: Any) -> list[dict]:
    if not data or not tag_id:
        return []
    normatives = data.get("normatives") or []

    if tag_id.startswith("normative:"):
        nid = tag_id.split(":", 1)[1]
        block = next((n for n in normatives if str(n.get("id")) == nid), None)
        if not block:
            return []
        rows = [r for r in (block.get("shiftDetails") or []) if str(r.get("date") or "").strip() in WEEKDAY_MARKERS]
        return [es_module.row_with_kind(r) for r in es_module.sort_rows(rows)]

    if tag_id.startswith("upload:"):
        uid = tag_id.split(":", 1)[1]
        for block in normatives:
            for upload in block.get("uploads") or []:
                if str(upload.get("id")) != uid:
                    continue
                date_set = set(upload.get("dates") or [])
                rows = [r for r in (block.get("shiftDetails") or []) if str(r.get("date") or "").strip() in date_set]
                return [es_module.row_with_kind(r) for r in es_module.sort_rows(rows)]
        return []

    return []


def describe_bundle_meta(data: dict | None) -> dict:
    if not data:
        return {
            "exists": False,
            "activeNormativeId": None,
            "lastWriteAt": None,
            "loadedUntilIso": None,
            "loadedUntilLabel": None,
            "normativePeriods": [],
            "tags": [],
        }

    normatives = data.get("normatives") or []
    active = pick_active_normative(normatives) if normatives else None
    loaded_until_iso = compute_loaded_until_iso(normatives)
    loaded_until_label = None
    if loaded_until_iso:
        y, m, d = loaded_until_iso.split("-")
        loaded_until_label = f"{d}.{m}.{y}"

    periods = []
    for item in normatives:
        periods.append({
            "id": item.get("id"),
            "from": item.get("normativeFrom"),
            "to": item.get("normativeTo"),
            "rows": len(item.get("shiftDetails") or []),
            "files": len(item.get("sourceFiles") or []),
            "uploads": len(item.get("uploads") or []),
            "active": active is not None and item.get("id") == active.get("id"),
        })

    root_rows = len(data.get("shiftDetails") or [])
    last_upload = None
    for tag in list_bundle_tags(data):
        if tag.get("kind") == "upload" and tag.get("uploadedAt"):
            if last_upload is None or tag["uploadedAt"] > last_upload.get("uploadedAt", ""):
                last_upload = tag

    return {
        "exists": True,
        "version": data.get("version"),
        "lastWriteAt": data.get("generatedAt"),
        "activeNormativeId": active.get("id") if active else None,
        "activeNormativeFrom": active.get("normativeFrom") if active else None,
        "activeNormativeTo": active.get("normativeTo") if active else None,
        "loadedUntilIso": loaded_until_iso,
        "loadedUntilLabel": loaded_until_label,
        "lastUploadId": last_upload.get("uploadId") if last_upload else None,
        "lastUploadLabel": last_upload.get("label") if last_upload else None,
        "lastUploadAt": last_upload.get("uploadedAt") if last_upload else None,
        "rootShiftDetailsRows": root_rows,
        "normativesCount": len(normatives),
        "normativePeriods": periods,
        "tags": list_bundle_tags(data),
    }


def merge_plan(existing: dict | None, normative_from: str, new_rows: int, upload_kind: str = "normative") -> dict:
    periods = (existing or {}).get("normatives") or []
    ids = [str(p.get("id") or "") for p in periods]
    if upload_kind == "dates":
        action = "append_dates"
    else:
        action = "replace" if normative_from in ids else "append"
    active = pick_active_normative(periods) if periods else None
    return {
        "action": action,
        "uploadKind": upload_kind,
        "normativeFrom": normative_from or None,
        "existingNormatives": len(periods),
        "replacesId": normative_from if action == "replace" else None,
        "newBlockRows": new_rows,
        "previousActiveId": active.get("id") if active else None,
        "willClosePreviousTo": None,
    }
