"""Разбор загруженных PDF/xlsx → shiftDetails (логика export-shifts.py)."""
from __future__ import annotations

import importlib.util
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
NARYAD_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = NARYAD_ROOT / "_tmp"
OUT_PRIMARY = ROOT / "yandex-cloud" / "function" / "data" / "shift-templates.json"
OUT_LOCAL = ROOT / "app" / "data" / "shift-templates.json"

from lib.pdf_to_xlsx import pdf_to_xlsx  # noqa: E402
from lib.bundle import describe_bundle_meta, finalize_bundle, merge_plan, pick_active_normative  # noqa: E402


def _load_export_shifts():
    path = ROOT / "tools" / "export-shifts.py"
    spec = importlib.util.spec_from_file_location("export_shifts", path)
    mod = importlib.util.module_from_spec(spec)
    assert spec.loader
    spec.loader.exec_module(mod)
    return mod


ES = _load_export_shifts()

MARKER_FROM_NAME = [
    ("ПН_ЧТ", "пн-чт"),
    ("ПНЧТ", "пн-чт"),
    ("_ПТ", "пт"),
    ("_СБ", "сб"),
    ("_ВС", "вс"),
]


def guess_marker(filename: str) -> str | None:
    upper = filename.upper()
    for pattern, marker in MARKER_FROM_NAME:
        if pattern in upper:
            return marker
    return None


def iso_to_app_date(iso: str) -> str:
    """YYYY-MM-DD → DD-MM-YYYY (как parseShiftDateToNormalized в app)."""
    y, m, d = iso.split("-")
    return f"{int(d):02d}-{int(m):02d}-{y}"


def resolve_parse_marker(entry: dict) -> str:
    """Маркер дня недели для разбора xlsx (не для записи в JSON при mode=date)."""
    mode = entry.get("mode") or "marker"
    if mode == "date":
        iso = str(entry.get("date") or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", iso):
            raise ValueError(f"Нужна дата YYYY-MM-DD для {entry.get('name')}")
        return ES.iso_to_weekday_marker(iso)
    marker = str(entry.get("marker") or "").strip()
    if marker not in {"пн-чт", "пт", "сб", "вс"}:
        raise ValueError(f"Выберите маркер (пн-чт/пт/сб/вс) для {entry.get('name')}")
    return marker


def resolve_output_date(entry: dict) -> str:
    """Значение поля date в shiftDetails: точная дата или маркер."""
    mode = entry.get("mode") or "marker"
    if mode == "date":
        iso = str(entry.get("date") or "").strip()
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", iso):
            raise ValueError(f"Нужна дата YYYY-MM-DD для {entry.get('name')}")
        return iso_to_app_date(iso)
    marker = str(entry.get("marker") or "").strip()
    if marker not in {"пн-чт", "пт", "сб", "вс"}:
        raise ValueError(f"Выберите маркер (пн-чт/пт/сб/вс) для {entry.get('name')}")
    return marker


def resolve_date_label(entry: dict) -> str:
    """Подпись для лога/UI."""
    mode = entry.get("mode") or "marker"
    if mode == "date":
        iso = str(entry.get("date") or "").strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", iso):
            return iso_to_app_date(iso)
        raise ValueError(f"Нужна дата YYYY-MM-DD для {entry.get('name')}")
    marker = str(entry.get("marker") or "").strip()
    if marker not in {"пн-чт", "пт", "сб", "вс"}:
        raise ValueError(f"Выберите маркер (пн-чт/пт/сб/вс) для {entry.get('name')}")
    return marker


def prepare_xlsx(source: Path, dest: Path) -> None:
    ext = source.suffix.lower()
    if ext == ".xlsx":
        dest.write_bytes(source.read_bytes())
        return
    if ext == ".pdf":
        pdf_to_xlsx(source, dest)
        return
    raise ValueError(f"Формат не поддерживается: {ext}")


def parse_upload(entry: dict, tmp_dir: Path) -> dict:
    src = Path(entry["path"])
    mode = entry.get("mode") or "marker"
    output_date = resolve_output_date(entry)
    parse_marker = resolve_parse_marker(entry)
    xlsx_path = tmp_dir / f"{src.stem}.xlsx"
    convert_meta = None
    if src.suffix.lower() == ".pdf":
        convert_meta = pdf_to_xlsx(src, xlsx_path)
    else:
        prepare_xlsx(src, xlsx_path)

    rows = ES.parse_workbook_with_marker(xlsx_path, parse_marker)
    if mode == "date":
        rows = [{**r, "date": output_date} for r in rows]
    warnings = ES.analyze_shift_rows(rows)
    kind = "разово" if mode == "date" else "маркер"
    return {
        "name": entry.get("name") or src.name,
        "label": output_date,
        "kind": kind,
        "mode": mode,
        "rows": len(rows),
        "routes": len({r["route"] for r in rows}),
        "shiftDetails": [ES.row_with_kind(r) for r in ES.sort_rows(rows)],
        "warnings": warnings,
        "convert": convert_meta,
    }


def add_days_iso(iso: str, days: int) -> str:
    y, m, d = map(int, iso.split("-"))
    from datetime import date, timedelta
    nd = date(y, m, d) + timedelta(days=days)
    return nd.isoformat()


def merge_normative(existing: dict | None, normative_from: str, close_previous: bool, files_meta: list, merged_rows: list) -> dict:
    normatives = []
    if existing and isinstance(existing.get("normatives"), list):
        normatives = [dict(n) for n in existing["normatives"]]

    prev_to = add_days_iso(normative_from, -1) if close_previous and normatives else None
    if close_previous and normatives:
        for n in reversed(normatives):
            if n.get("normativeTo") in (None, ""):
                n["normativeTo"] = prev_to
                break

    block_rows = ES.sort_rows(ES.dedupe_rows(list(merged_rows)))
    new_block = {
        "id": normative_from,
        "normativeFrom": normative_from,
        "normativeTo": None,
        "sourceFiles": [f["name"] for f in files_meta],
        "shiftDetails": block_rows,
        "stats": {
            "rows": len(block_rows),
            "routes": len({r["route"] for r in block_rows}),
            "markers": sorted({r["date"] for r in block_rows}),
        },
    }
    normatives = [n for n in normatives if n.get("id") != normative_from]
    normatives.append(new_block)
    normatives.sort(key=lambda n: n.get("normativeFrom") or "")

    bundle = {
        "version": normative_from,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {
            "type": "naryad-pan",
            "exporter": "Naryad_pan/lib/process.py",
        },
        "normatives": normatives,
    }
    return finalize_bundle(bundle, ES)


def load_existing_bundle() -> dict | None:
    if OUT_PRIMARY.is_file():
        return json.loads(OUT_PRIMARY.read_text(encoding="utf-8"))
    return None


def read_bundle_info() -> dict:
    data = load_existing_bundle()
    info = describe_bundle_meta(data)
    if OUT_PRIMARY.is_file():
        ts = datetime.fromtimestamp(OUT_PRIMARY.stat().st_mtime, tz=timezone.utc)
        info["fileModifiedAt"] = ts.replace(microsecond=0).isoformat().replace("+00:00", "Z")
        info["path"] = str(OUT_PRIMARY)
    else:
        info["fileModifiedAt"] = None
        info["path"] = str(OUT_PRIMARY)
    return info


def repair_bundle_file() -> dict:
    data = load_existing_bundle()
    if not data:
        raise ValueError("файл shift-templates.json не найден")
    fixed = finalize_bundle(data, ES)
    text = json.dumps(fixed, ensure_ascii=False, indent=2) + "\n"
    OUT_PRIMARY.write_text(text, encoding="utf-8")
    if OUT_LOCAL.parent.exists():
        OUT_LOCAL.write_text(text, encoding="utf-8")
    return {"ok": True, "meta": describe_bundle_meta(fixed), "stats": fixed.get("stats")}


def run_preview(files: list[dict], normative_from: str, close_previous: bool) -> dict:
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    parsed_files = []
    merged: list[dict] = []
    all_warnings = []

    for entry in files:
        result = parse_upload(entry, TMP_DIR)
        parsed_files.append({
            "name": result["name"],
            "label": result["label"],
            "kind": result.get("kind"),
            "mode": result.get("mode"),
            "rows": result["rows"],
            "routes": result["routes"],
            "warnings": result["warnings"],
            "convert": result.get("convert"),
        })
        merged.extend(result["shiftDetails"])
        for w in result["warnings"]:
            w = dict(w)
            w["file"] = result["name"]
            all_warnings.append(w)

    merged = ES.sort_rows(ES.dedupe_rows(merged))
    existing = load_existing_bundle()
    plan = merge_plan(existing, normative_from, len(merged))
    if close_previous and plan["previousActiveId"]:
        plan["willClosePreviousTo"] = add_days_iso(normative_from, -1)
    bundle = merge_normative(existing, normative_from, close_previous, parsed_files, merged)

    return {
        "ok": True,
        "files": parsed_files,
        "warnings": all_warnings,
        "mergePlan": plan,
        "bundleMeta": describe_bundle_meta(bundle),
        "stats": {
            "rows": len(merged),
            "routes": len({r["route"] for r in merged}),
            "files": len(parsed_files),
            "errors": sum(1 for w in all_warnings if w.get("level") == "error"),
            "warns": sum(1 for w in all_warnings if w.get("level") == "warn"),
        },
        "rows": [ES.row_with_kind(r) for r in merged],
        "bundlePreview": {
            "version": bundle["version"],
            "normatives": len(bundle["normatives"]),
            "activeId": pick_active_normative(bundle["normatives"]).get("id") if bundle.get("normatives") else None,
            "rootRows": len(bundle.get("shiftDetails") or []),
        },
        "_bundle": bundle,
    }


def run_apply(preview_result: dict, write_local: bool = True) -> dict:
    bundle = preview_result.get("_bundle")
    if not bundle:
        raise ValueError("Нет данных для записи — сначала предпросмотр")

    OUT_PRIMARY.parent.mkdir(parents=True, exist_ok=True)
    text = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    OUT_PRIMARY.write_text(text, encoding="utf-8")
    paths = [str(OUT_PRIMARY)]
    if write_local:
        OUT_LOCAL.parent.mkdir(parents=True, exist_ok=True)
        OUT_LOCAL.write_text(text, encoding="utf-8")
        paths.append(str(OUT_LOCAL))

    return {"ok": True, "paths": paths, "stats": bundle.get("stats"), "meta": bundle.get("meta")}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="JSON config path")
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    cfg = json.loads(Path(args.config).read_text(encoding="utf-8"))
    result = run_preview(cfg["files"], cfg["normativeFrom"], cfg.get("closePrevious", True))
    if args.apply:
        out = run_apply(result, cfg.get("writeLocal", True))
        print(json.dumps(out, ensure_ascii=False, indent=2))
    else:
        slim = dict(result)
        slim.pop("_bundle", None)
        print(json.dumps(slim, ensure_ascii=False, indent=2))
