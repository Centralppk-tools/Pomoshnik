"""PDF с таблицей → xlsx для parse_workbook_with_marker (без OCR)."""
from __future__ import annotations

from pathlib import Path

import openpyxl
import pdfplumber


def _clean_cell(value) -> str:
    if value is None:
        return ""
    return str(value).replace("\n", " ").strip()


def extract_largest_table(pdf_path: Path) -> list[list[str]]:
    best: list[list[str]] = []
    with pdfplumber.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            tables = page.extract_tables() or []
            for table in tables:
                if not table:
                    continue
                normalized = [[_clean_cell(c) for c in row] for row in table if any(_clean_cell(c) for c in row)]
                if len(normalized) > len(best):
                    best = normalized
                if normalized and len(normalized[0]) >= 20:
                    return normalized
    return best


def pdf_to_xlsx(pdf_path: Path, xlsx_path: Path) -> dict:
    rows = extract_largest_table(pdf_path)
    if not rows:
        raise ValueError(f"В PDF нет таблицы: {pdf_path.name}")

    max_cols = max(len(r) for r in rows)
    if max_cols < 10:
        raise ValueError(f"Слишком мало колонок ({max_cols}) — проверьте PDF")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Sheet1"
    for r_idx, row in enumerate(rows, start=1):
        for c_idx in range(max_cols):
            val = row[c_idx] if c_idx < len(row) else ""
            ws.cell(r_idx, c_idx + 1, val)

    xlsx_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(xlsx_path)
    wb.close()
    return {
        "rows": len(rows),
        "cols": max_cols,
        "xlsx": str(xlsx_path),
    }
