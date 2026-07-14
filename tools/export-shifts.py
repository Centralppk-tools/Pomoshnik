#!/usr/bin/env python3
"""Export shift hours from xlsx (Часы смен/) → app/data/shift-templates.json"""

from __future__ import annotations

import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

import openpyxl

ROOT = Path(__file__).resolve().parents[1]
HOURS_DIR = ROOT / "Часы смен"
OUT_PATH = ROOT / "app" / "data" / "shift-templates.json"
SCHEMA_DIR = ROOT / "app" / "data" / "shift-hours"

DAY_ROUTE_RE = re.compile(r"^[ДD]\d", re.I)
NIGHT_ROUTE_RE = re.compile(r"^[НN]\d", re.I)
MORNING_ROUTE_RE = re.compile(r"^\d+[УU]$", re.I)

FILE_MARKERS = [
    ("ПН_ЧТ", "пн-чт"),
    ("_ПТ", "пт"),
    ("_СБ", "сб"),
    ("_ВС", "вс"),
]

NORMATIVE_PERIODS = [
    {
        "id": "2026-06-24",
        "normativeFrom": "2026-06-24",
        "normativeTo": "2026-07-16",
        "folders": [HOURS_DIR],
        "excludeSubdirs": {"c 17_07"},
    },
    {
        "id": "2026-07-17",
        "normativeFrom": "2026-07-17",
        "normativeTo": None,
        "folders": [HOURS_DIR / "c 17_07"],
        "excludeSubdirs": set(),
    },
]

HEADER_ROW = 6
DATA_START_ROW = 7


def cell_str(value) -> str:
    if value is None:
        return ""
    text = str(value).strip()
    return text


def normalize_route(route: str) -> str:
    return cell_str(route).upper().replace(" ", "")


def normalize_lunch(value) -> str:
    text = cell_str(value)
    if not text:
        return ""
    if text in ("*", "**", "***"):
        return text
    last = text.split("\n")[-1].strip()
    return last if last in ("*", "**", "***") else ""


TIME_IN_CELL_RE = re.compile(r"(\d{1,2}:\d{2})")


def extract_times_from_cell(value) -> list[str]:
    text = cell_str(value).replace("\n", " ")
    return TIME_IN_CELL_RE.findall(text)


def extract_lunch_marker(*values) -> str:
    for value in values:
        text = cell_str(value)
        if not text:
            continue
        if "***" in text:
            return "***"
        if "**" in text:
            return "**"
        if "*" in text:
            return "*"
    return ""


def format_break_lunch(start_cell, end_cell) -> str:
    start_times = extract_times_from_cell(start_cell)
    end_times = extract_times_from_cell(end_cell)
    marker = extract_lunch_marker(start_cell, end_cell)
    marker = marker or normalize_lunch(end_cell) or normalize_lunch(start_cell)

    if start_times and end_times:
        lunch = f"{start_times[0]}-{end_times[0]}"
        if marker:
            lunch = f"{lunch} {marker}"
        return lunch

    if marker:
        return marker
    return ""


def detect_marker(path: Path) -> str:
    name = path.name.upper()
    for pattern, marker in FILE_MARKERS:
        if pattern.upper() in name:
            return marker
    raise ValueError(f"Cannot detect weekday marker for {path.name}")


def list_xlsx_files(folder: Path, exclude_subdirs: set[str]) -> list[Path]:
    files: list[Path] = []
    for path in sorted(folder.rglob("*.xlsx")):
        rel_parts = path.relative_to(folder).parts
        if rel_parts and rel_parts[0] in exclude_subdirs:
            continue
        if path.name.startswith("~$"):
            continue
        files.append(path)
    return files


def read_row_segment(ws, row: int, mapping: dict[str, int]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, col in mapping.items():
        out[key] = cell_str(ws.cell(row, col).value)
    return out


def flat_row(date: str, route: str, fields: dict[str, str]) -> dict[str, str]:
    row = {
        "date": date,
        "route": normalize_route(route),
    }
    for key in ("startPlace", "startTime", "trains", "endTime", "workHours", "nightHours", "morningRoute", "lunch"):
        value = cell_str(fields.get(key, ""))
        if value:
            row[key] = value
    return row


def parse_workbook(path: Path) -> list[dict[str, str]]:
    marker = detect_marker(path)
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    ws = wb.active

    morning_index: dict[str, int] = {}
    night_rows: list[tuple[int, str]] = []
    flat_rows: list[dict[str, str]] = []

    max_row = ws.max_row or DATA_START_ROW
    for row in range(DATA_START_ROW, max_row + 1):
        day_route = cell_str(ws.cell(row, 1).value)
        if not DAY_ROUTE_RE.match(day_route):
            continue

        morning_route_col22 = cell_str(ws.cell(row, 22).value)
        if MORNING_ROUTE_RE.match(morning_route_col22):
            morning_index[normalize_route(morning_route_col22)] = row

        day_fields = read_row_segment(
            ws,
            row,
            {
                "startPlace": 2,
                "startTime": 3,
                "trains": 4,
                "endTime": 5,
                "workHours": 6,
                "nightHours": 9,
            },
        )
        day_fields["lunch"] = format_break_lunch(ws.cell(row, 7).value, ws.cell(row, 8).value)
        flat_rows.append(flat_row(marker, day_route, day_fields))

        night_route = cell_str(ws.cell(row, 11).value)
        if not NIGHT_ROUTE_RE.match(night_route):
            continue

        night_fields = read_row_segment(
            ws,
            row,
            {
                "startPlace": 12,
                "startTime": 13,
                "trains": 14,
                "endTime": 15,
                "workHours": 16,
                "nightHours": 17,
                "morningRoute": 21,
            },
        )
        night_fields["lunch"] = format_break_lunch(ws.cell(row, 19).value, ws.cell(row, 20).value)
        flat_rows.append(flat_row(marker, night_route, night_fields))

        morning_route = cell_str(night_fields.get("morningRoute", ""))
        if morning_route:
            night_rows.append((row, normalize_route(morning_route)))

    for _source_row, morning_route in night_rows:
        target_row = morning_index.get(morning_route)
        if not target_row:
            continue

        morning_fields = read_row_segment(
            ws,
            target_row,
            {
                "startPlace": 23,
                "startTime": 24,
                "trains": 25,
                "endTime": 26,
                "workHours": 27,
                "nightHours": 28,
            },
        )
        morning_fields["lunch"] = format_break_lunch(
            ws.cell(target_row, 7).value,
            ws.cell(target_row, 8).value,
        )
        flat_rows.append(flat_row(marker, morning_route, morning_fields))

    wb.close()
    return dedupe_rows(flat_rows)


def dedupe_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    seen: dict[tuple[str, str], dict[str, str]] = {}
    for row in rows:
        key = (row["date"], row["route"])
        seen[key] = row
    return list(seen.values())


def sort_rows(rows: list[dict[str, str]]) -> list[dict[str, str]]:
    marker_order = {"пн-чт": 0, "пт": 1, "сб": 2, "вс": 3}

    def route_sort(route: str) -> tuple:
        kind = 0
        if route.startswith("Д"):
            kind = 0
        elif route.startswith("Н"):
            kind = 1
        else:
            kind = 2
        num = re.sub(r"[^\d]", "", route)
        return (kind, int(num) if num.isdigit() else 999, route)

    return sorted(
        rows,
        key=lambda row: (
            marker_order.get(row["date"], 99),
            route_sort(row["route"]),
        ),
    )


def export_period(period: dict) -> dict:
    rows: list[dict[str, str]] = []
    source_files: list[str] = []

    for folder in period["folders"]:
        if not folder.exists():
            print(f"warn: folder missing: {folder}", file=sys.stderr)
            continue
        for path in list_xlsx_files(folder, period["excludeSubdirs"]):
            parsed = parse_workbook(path)
            rows.extend(parsed)
            source_files.append(str(path.relative_to(ROOT)).replace("\\", "/"))
            print(f"  {path.name}: {len(parsed)} rows")

    merged = sort_rows(dedupe_rows(rows))
    routes = sorted({row["route"] for row in merged})

    return {
        "id": period["id"],
        "normativeFrom": period["normativeFrom"],
        "normativeTo": period["normativeTo"],
        "sourceFiles": source_files,
        "shiftDetails": merged,
        "stats": {
            "rows": len(merged),
            "routes": len(routes),
            "markers": sorted({row["date"] for row in merged}),
        },
    }


def main() -> int:
    print("Exporting shift hours…")
    normatives = []
    all_rows: list[dict[str, str]] = []

    for period in NORMATIVE_PERIODS:
        print(f"\n[{period['id']}]")
        bundle = export_period(period)
        normatives.append(bundle)
        all_rows.extend(bundle["shiftDetails"])

    payload = {
        "version": normatives[-1]["id"] if normatives else "0.0.0",
        "generatedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "source": {
            "type": "local-xlsx",
            "folder": "Часы смен/",
            "exporter": "tools/export-shifts.py",
        },
        "normatives": [
            {
                "id": item["id"],
                "normativeFrom": item["normativeFrom"],
                "normativeTo": item["normativeTo"],
                "sourceFiles": item["sourceFiles"],
                "stats": item["stats"],
                "shiftDetails": item["shiftDetails"],
            }
            for item in normatives
        ],
        "shiftDetails": sort_rows(dedupe_rows(all_rows)),
        "stats": {
            "rows": len(all_rows),
            "routes": len({row["route"] for row in all_rows}),
            "markers": sorted({row["date"] for row in all_rows}),
            "normatives": len(normatives),
        },
    }

    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"\nWrote {OUT_PATH} ({payload['stats']['rows']} rows, {payload['stats']['routes']} routes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
