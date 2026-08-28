"""Сборка и метаданные shift-templates.json."""
from __future__ import annotations

from typing import Any


def pick_active_normative(normatives: list[dict]) -> dict | None:
    for item in reversed(normatives):
        if item.get("normativeTo") in (None, ""):
            return item
    return normatives[-1] if normatives else None


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


def describe_bundle_meta(data: dict | None) -> dict:
    if not data:
        return {
            "exists": False,
            "activeNormativeId": None,
            "lastWriteAt": None,
            "normativePeriods": [],
        }

    normatives = data.get("normatives") or []
    active = pick_active_normative(normatives) if normatives else None
    periods = []
    for item in normatives:
        periods.append({
            "id": item.get("id"),
            "from": item.get("normativeFrom"),
            "to": item.get("normativeTo"),
            "rows": len(item.get("shiftDetails") or []),
            "files": len(item.get("sourceFiles") or []),
            "active": active is not None and item.get("id") == active.get("id"),
        })

    root_rows = len(data.get("shiftDetails") or [])
    return {
        "exists": True,
        "version": data.get("version"),
        "lastWriteAt": data.get("generatedAt"),
        "activeNormativeId": active.get("id") if active else None,
        "activeNormativeFrom": active.get("normativeFrom") if active else None,
        "activeNormativeTo": active.get("normativeTo") if active else None,
        "rootShiftDetailsRows": root_rows,
        "normativesCount": len(normatives),
        "normativePeriods": periods,
    }


def merge_plan(existing: dict | None, normative_from: str, new_rows: int) -> dict:
    periods = (existing or {}).get("normatives") or []
    ids = [str(p.get("id") or "") for p in periods]
    action = "replace" if normative_from in ids else "append"
    active = pick_active_normative(periods) if periods else None
    return {
        "action": action,
        "normativeFrom": normative_from,
        "existingNormatives": len(periods),
        "replacesId": normative_from if action == "replace" else None,
        "newBlockRows": new_rows,
        "previousActiveId": active.get("id") if active else None,
        "willClosePreviousTo": None,
    }
