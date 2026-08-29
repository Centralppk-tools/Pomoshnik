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
CANONICAL_SHIFTS_DIR = ROOT / "Часы смен"
OUT_PRIMARY = ROOT / "yandex-cloud" / "function" / "data" / "shift-templates.json"
OUT_LOCAL = ROOT / "app" / "data" / "shift-templates.json"

CANONICAL_DATE_FILES: list[tuple[str, str]] = [
    ("2026-08-27", "27 августа часы смен МЯЭД.pdf"),
    ("2026-08-28", "28 августа часы смен МЯЭД.pdf"),
    ("2026-08-29", "29 августа часы смен МЯЭД.pdf"),
    ("2026-08-30", "30 августа часы смен МЯЭД.pdf"),
    ("2026-08-31", "31 августа часы смен МЯЭД.pdf"),
    ("2026-09-01", "1 сентября часы смен МЯЭД.pdf"),
    ("2026-09-02", "2 сентября часы смен МЯЭД.pdf"),
    ("2026-09-03", "3 сентября часы смен МЯЭД.pdf"),
]

from lib.pdf_to_xlsx import pdf_to_xlsx  # noqa: E402
from lib.bundle import (  # noqa: E402
    DATE_MARKER_RE,
    WEEKDAY_MARKERS,
    app_date_to_iso,
    collect_one_time_dates,
    compute_loaded_until_iso,
    describe_bundle_meta,
    finalize_bundle,
    get_rows_for_tag,
    list_bundle_tags,
    merge_plan,
    pick_active_normative,
)


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


DATE_MARKER_RE = DATE_MARKER_RE
WEEKDAY_MARKERS = WEEKDAY_MARKERS


def parse_russian_date_from_name(name: str) -> str | None:
    lower = name.lower()
    for month_word, month_num in (("августа", 8), ("сентября", 9)):
        m = re.search(rf"(\d{{1,2}})\s+{month_word}", lower)
        if m:
            day = int(m.group(1))
            return f"2026-{month_num:02d}-{day:02d}"
    return None


def is_date_only_rows(rows: list[dict]) -> bool:
    markers = {str(r.get("date") or "").strip() for r in rows}
    markers.discard("")
    return bool(markers) and all(DATE_MARKER_RE.match(m) for m in markers)


def seed_recurring_rows(existing: dict | None, merged_rows: list[dict]) -> list[dict]:
    """Разовые даты не заменяют повторяющийся норматив пн–чт / пт / сб / вс."""
    if not is_date_only_rows(merged_rows):
        return merged_rows
    normatives = (existing or {}).get("normatives") or []
    prev = pick_active_normative(normatives) if normatives else None
    if not prev:
        return merged_rows
    recurring = [
        dict(r) for r in (prev.get("shiftDetails") or [])
        if str(r.get("date") or "").strip() in WEEKDAY_MARKERS
    ]
    if not recurring:
        return merged_rows
    return ES.sort_rows(ES.dedupe_rows(recurring + list(merged_rows)))


def merge_date_upload(existing: dict | None, files_meta: list, merged_rows: list) -> dict:
    """Разовые даты — в активный норматив, без нового блока «с 1.09»."""
    normatives = []
    if existing and isinstance(existing.get("normatives"), list):
        normatives = [dict(n) for n in existing["normatives"]]

    active = pick_active_normative(normatives)
    if not active:
        raise ValueError("Нет активного норматива — сначала залейте норматив (пн–чт / пт / сб / вс)")

    upload_dates = collect_one_time_dates(merged_rows)
    if not upload_dates:
        raise ValueError("В загрузке нет разовых дат")

    upload_id = datetime.now(timezone.utc).strftime("upload-%Y%m%d-%H%M%SZ")
    upload_record = {
        "id": upload_id,
        "kind": "dates",
        "uploadedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceFiles": [f["name"] for f in files_meta],
        "dates": upload_dates,
        "rows": len(merged_rows),
    }

    date_set = set(upload_dates)
    kept = [
        r for r in (active.get("shiftDetails") or [])
        if str(r.get("date") or "").strip() not in date_set
    ]
    block_rows = ES.sort_rows(ES.dedupe_rows(kept + list(merged_rows)))

    uploads = list(active.get("uploads") or [])
    uploads.append(upload_record)

    active_idx = next(i for i, n in enumerate(normatives) if n.get("id") == active.get("id"))
    normatives[active_idx] = {
        **active,
        "uploads": uploads,
        "shiftDetails": block_rows,
        "stats": {
            "rows": len(block_rows),
            "routes": len({r["route"] for r in block_rows}),
            "markers": sorted({r["date"] for r in block_rows}),
        },
    }

    version = str(active.get("id") or datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    bundle = {
        "version": version,
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {
            "type": "naryad-pan",
            "exporter": "Naryad_pan/lib/process.py",
        },
        "normatives": normatives,
    }
    return finalize_bundle(bundle, ES)


def merge_normative(existing: dict | None, normative_from: str, close_previous: bool, files_meta: list, merged_rows: list) -> dict:
    if is_date_only_rows(merged_rows):
        return merge_date_upload(existing, files_meta, merged_rows)

    normatives = []
    if existing and isinstance(existing.get("normatives"), list):
        normatives = [dict(n) for n in existing["normatives"]]

    prev_to = add_days_iso(normative_from, -1) if close_previous and normatives else None
    if close_previous and normatives:
        for n in reversed(normatives):
            if n.get("normativeTo") in (None, ""):
                n["normativeTo"] = prev_to
                break

    block_rows = ES.sort_rows(ES.dedupe_rows(seed_recurring_rows(existing, list(merged_rows))))
    new_block = {
        "id": normative_from,
        "normativeFrom": normative_from,
        "normativeTo": None,
        "sourceFiles": [f["name"] for f in files_meta],
        "uploads": [],
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


def inspect_bundle_tag(tag_id: str) -> dict:
    data = load_existing_bundle()
    if not data:
        raise ValueError("файл shift-templates.json не найден")
    rows = get_rows_for_tag(data, tag_id, ES)
    tag = next((t for t in list_bundle_tags(data) if t.get("id") == tag_id), None)
    return {"ok": True, "tag": tag, "rows": rows, "stats": {"rows": len(rows), "routes": len({r.get("route") for r in rows})}}


def pick_best_tmp_file(candidates: list[Path]) -> Path:
    xlsx = [p for p in candidates if p.suffix.lower() == ".xlsx"]
    pool = xlsx or candidates
    return max(pool, key=lambda p: p.stat().st_mtime)


def parse_pdf_for_iso(src: Path, iso: str) -> list[dict]:
    output_date = iso_to_app_date(iso)
    parse_marker = ES.iso_to_weekday_marker(iso)
    xlsx_path = TMP_DIR / f"_rebuild_{iso}.xlsx"
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    prepare_xlsx(src, xlsx_path)
    rows = ES.parse_workbook_with_marker(xlsx_path, parse_marker)
    return [{**r, "date": output_date} for r in rows]


def rebuild_bundle_from_tmp() -> dict:
    """Пересборка: нормативы до 05.08 + разовые 27.08–03.09 из «Часы смен/», без блока 2026-09-01."""
    existing = load_existing_bundle()
    if not existing:
        raise ValueError("shift-templates.json не найден")

    keep_ids = {"2026-06-24", "2026-07-17", "2026-08-05"}
    normatives = [dict(n) for n in (existing.get("normatives") or []) if str(n.get("id")) in keep_ids]
    active = next((n for n in normatives if n.get("id") == "2026-08-05"), None)
    if not active:
        raise ValueError("В базе нет норматива 2026-08-05")

    weekday_rows = [
        dict(r) for r in (active.get("shiftDetails") or [])
        if str(r.get("date") or "").strip() in WEEKDAY_MARKERS
    ]

    parsed_batches: list[dict] = []
    merged_one_time: list[dict] = []
    for iso, filename in CANONICAL_DATE_FILES:
        src = CANONICAL_SHIFTS_DIR / filename
        if not src.is_file():
            raise ValueError(f"Нет исходного PDF: {src}")
        rows = parse_pdf_for_iso(src, iso)
        merged_one_time.extend(rows)
        parsed_batches.append({
            "iso": iso,
            "file": filename,
            "path": str(src),
            "rows": len(rows),
            "routes": len({r["route"] for r in rows}),
        })

    upload_id = datetime.now(timezone.utc).strftime("upload-%Y%m%d-%H%M%SZ")
    upload_record = {
        "id": upload_id,
        "kind": "dates",
        "uploadedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "sourceFiles": [b["file"] for b in parsed_batches],
        "sourceDir": str(CANONICAL_SHIFTS_DIR),
        "dates": collect_one_time_dates(merged_one_time),
        "rows": len(merged_one_time),
    }

    block_rows = ES.sort_rows(ES.dedupe_rows(weekday_rows + merged_one_time))
    active_idx = next(i for i, n in enumerate(normatives) if n.get("id") == "2026-08-05")
    normatives[active_idx] = {
        **active,
        "normativeTo": None,
        "uploads": [upload_record],
        "shiftDetails": block_rows,
        "stats": {
            "rows": len(block_rows),
            "routes": len({r["route"] for r in block_rows}),
            "markers": sorted({r["date"] for r in block_rows}),
        },
    }

    bundle = {
        "version": "2026-08-05",
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {"type": "naryad-pan", "exporter": "Naryad_pan/lib/process.py", "sourceDir": str(CANONICAL_SHIFTS_DIR)},
        "normatives": normatives,
    }
    bundle = finalize_bundle(bundle, ES)
    text = json.dumps(bundle, ensure_ascii=False, indent=2) + "\n"
    OUT_PRIMARY.write_text(text, encoding="utf-8")
    if OUT_LOCAL.parent.exists():
        OUT_LOCAL.write_text(text, encoding="utf-8")

    return {
        "ok": True,
        "parsedDates": parsed_batches,
        "loadedUntilIso": compute_loaded_until_iso(normatives),
        "meta": describe_bundle_meta(bundle),
        "stats": bundle.get("stats"),
    }


def repair_bundle_file() -> dict:
    data = load_existing_bundle()
    if not data:
        raise ValueError("файл shift-templates.json не найден")
    fixed = repair_missing_nights_and_recurring(data)
    fixed = finalize_bundle(fixed, ES)
    text = json.dumps(fixed, ensure_ascii=False, indent=2) + "\n"
    OUT_PRIMARY.write_text(text, encoding="utf-8")
    if OUT_LOCAL.parent.exists():
        OUT_LOCAL.write_text(text, encoding="utf-8")
    return {"ok": True, "meta": describe_bundle_meta(fixed), "stats": fixed.get("stats")}


def repair_missing_nights_and_recurring(data: dict) -> dict:
    """Починка: разовые PDF без ночи + блок без пн–чт/пт/сб/вс."""
    normatives = [dict(n) for n in (data.get("normatives") or [])]
    if not normatives:
        return data

    active = pick_active_normative(normatives)
    if not active:
        return data

    prev = None
    for n in reversed(normatives):
        if n.get("id") != active.get("id"):
            prev = n
            break

    block_id = active.get("id")
    idx = next(i for i, n in enumerate(normatives) if n.get("id") == block_id)

    rows: list[dict] = []
    if prev:
        rows.extend(
            dict(r) for r in (prev.get("shiftDetails") or [])
            if str(r.get("date") or "").strip() in WEEKDAY_MARKERS
        )

    # Переразбор PDF/xlsx из _tmp для разовых дат
    if TMP_DIR.is_dir():
        for xlsx in sorted(TMP_DIR.glob("*.xlsx")):
            name = xlsx.name.lower()
            # имя содержит «28 августа» и т.п. — пропускаем, дату берём из содержимого через mode=date ниже
            m = re.search(r"(\d{1,2})\s*(?:августа|сентября)", name)
            if not m:
                continue
            day = int(m.group(1))
            month = 8 if "августа" in name else 9
            iso = f"2026-{month:02d}-{day:02d}"
            output_date = iso_to_app_date(iso)
            parse_marker = ES.iso_to_weekday_marker(iso)
            try:
                parsed = ES.parse_workbook_with_marker(xlsx, parse_marker)
            except Exception:
                continue
            rows.extend({**r, "date": output_date} for r in parsed)

    if not rows:
        rows = list(active.get("shiftDetails") or [])

    block_rows = ES.sort_rows(ES.dedupe_rows(rows))
    normatives[idx] = {
        **active,
        "shiftDetails": block_rows,
        "stats": {
            "rows": len(block_rows),
            "routes": len({r["route"] for r in block_rows}),
            "markers": sorted({r["date"] for r in block_rows}),
        },
    }
    data = dict(data)
    data["normatives"] = normatives
    data["generatedAt"] = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    return data


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
    upload_kind = "dates" if is_date_only_rows(merged) else "normative"
    if upload_kind == "dates" and not normative_from:
        active = pick_active_normative((existing or {}).get("normatives") or [])
        normative_from = str(active.get("id") if active else datetime.now(timezone.utc).strftime("%Y-%m-%d"))
    if upload_kind == "normative" and not normative_from:
        raise ValueError("Укажите дату начала норматива для маркерных файлов")

    plan = merge_plan(existing, normative_from, len(merged), upload_kind)
    if close_previous and plan["previousActiveId"] and upload_kind == "normative":
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
