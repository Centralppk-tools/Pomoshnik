#!/usr/bin/env python3
"""Sync app/data/line-sections.json → app/spr.json (route_reference, stations_path, line_sections)."""

from __future__ import annotations

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LINE_SECTIONS_PATH = ROOT / "app" / "data" / "line-sections.json"
SPR_PATH = ROOT / "app" / "spr.json"

KM_ALIASES = {
    "Ростокино (Ярославское направление)": "Ростокино",
    "Нагорное (43 км)": "43 км",
    "Топорково (76 км)": "76 км",
    "Шубино (90 км)": "90 км",
    "Александров-1": "Александров",
    "Фабрика 1 Мая": "Фабрика 1 мая",
    "Зелёный Бор": "Зеленый Бор",
    "Лесная (64 км)": "Лесная",
    "Фрязино-Пасс.": "Фрязино (пассажирская)",
    "Фрязино-Тов.": "Фрязино-товарная",
}


def main() -> None:
    line_data = json.loads(LINE_SECTIONS_PATH.read_text(encoding="utf-8"))
    spr = json.loads(SPR_PATH.read_text(encoding="utf-8"))

    legacy_km: dict[str, dict] = {}
    for row in spr.get("stations_path", []):
        name = row.get("station")
        if name:
            legacy_km[name] = {
                "km": row.get("km"),
                "piket": row.get("piket"),
                "kind": row.get("kind"),
            }

    station_kinds = line_data.get("station_kinds") or {}

    def km_for(name: str) -> dict:
        candidates = [name]
        alias = KM_ALIASES.get(name)
        if alias and alias not in candidates:
            candidates.append(alias)
        # Also try reverse: if legacy used long name and current is short
        for legacy_name, short in KM_ALIASES.items():
            if short == name and legacy_name not in candidates:
                candidates.append(legacy_name)

        old = {}
        for key in candidates:
            if key in legacy_km and legacy_km[key].get("km") is not None:
                old = legacy_km[key]
                break
            if key in legacy_km and not old:
                old = legacy_km[key]

        kind = station_kinds.get(name) or old.get("kind") or "halt"
        if kind not in ("station", "halt"):
            kind = "halt"

        out = {"station": name, "kind": kind}
        if old.get("km") is not None:
            out["km"] = old["km"]
        if old.get("piket") is not None:
            out["piket"] = old["piket"]
        return out

    route_reference: dict = {"source_trains": []}
    station_sections: dict[str, list[str]] = {}
    stations_path: list[dict] = []
    seen: set[str] = set()

    for section in line_data["sections"]:
        sid = section["id"]
        route_reference["source_trains"].append(section.get("train", ""))
        from_moscow = section["from_moscow"]
        route_reference[sid] = {
            "from_moscow": from_moscow,
            "to_moscow": list(reversed(from_moscow)),
        }
        for name in from_moscow:
            station_sections.setdefault(name, [])
            if sid not in station_sections[name]:
                station_sections[name].append(sid)
            if name not in seen:
                seen.add(name)
                row = km_for(name)
                row["sections"] = [sid]
                stations_path.append(row)
            else:
                for row in stations_path:
                    if row["station"] == name and sid not in row["sections"]:
                        row["sections"].append(sid)
                    if row["station"] == name and station_kinds.get(name):
                        row["kind"] = station_kinds[name]

    spr["route_reference"] = route_reference
    spr["stations_path"] = stations_path
    spr["line_sections"] = line_data
    spr.pop("line_sections_ref", None)

    SPR_PATH.write_text(json.dumps(spr, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"Updated {SPR_PATH}")
    print(f"  sections: {len(line_data['sections'])}")
    print(f"  stations_path: {len(stations_path)}")
    print(f"  route_reference keys: {[k for k in route_reference if k != 'source_trains']}")


if __name__ == "__main__":
    main()
