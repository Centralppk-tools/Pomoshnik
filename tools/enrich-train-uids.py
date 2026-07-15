#!/usr/bin/env python3
"""
Один проход по табло Ярославского вокзала → trains-uids.json + дополнение trains-local.json.
Стоимость: 1–3 запроса schedule (не thread). Запускать редко, при смене ниток.

  python tools/enrich-train-uids.py
  python tools/enrich-train-uids.py --date 2026-07-15
"""
from __future__ import annotations

import json
import re
import sys
import urllib.parse
import urllib.request
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
APP = ROOT / "app"
TEMPLATES = APP / "data" / "shift-templates.json"
TRAINS_LOCAL = APP / "trains-local.json"
UIDS_OUT = APP / "data" / "trains-uids.json"

API_KEY = "64eba113-a83b-421c-baa8-d51f432cb3f3"
API_BASE = "https://api.rasp.yandex.net/v3.0"
PROXY = "https://late-shape-356d.maksbarybin9458.workers.dev/"
ANCHOR_STATION = "s2000002"


def proxy_fetch(url: str) -> dict:
    req_url = PROXY + "?url=" + urllib.parse.quote(url, safe="")
    with urllib.request.urlopen(req_url, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def fetch_board(schedule_date: str) -> list:
    all_rows = []
    offset = 0
    limit = 1000
    while offset <= 4000:
        url = (
            f"{API_BASE}/schedule/?apikey={API_KEY}&station={ANCHOR_STATION}"
            f"&transport_types=suburban&direction=all&limit={limit}&offset={offset}"
            f"&date={schedule_date}&lang=ru_RU"
        )
        data = proxy_fetch(url)
        if data.get("error"):
            raise RuntimeError(data["error"])
        batch = data.get("schedule") or []
        all_rows.extend(batch)
        if len(batch) < limit:
            break
        offset += limit
    return all_rows


def norm_num(raw: str) -> str:
    return re.sub(r"\D", "", str(raw or ""))


def collect_wanted_numbers() -> set[str]:
    text = TEMPLATES.read_text(encoding="utf-8")
    return {n for n in re.findall(r"\b(\d{4})\b", text) if n != "2026"}


def default_weekday() -> str:
    d = date.today()
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d.isoformat()


def main() -> int:
    schedule_date = default_weekday()
    if "--date" in sys.argv:
        i = sys.argv.index("--date")
        schedule_date = sys.argv[i + 1]

    wanted = collect_wanted_numbers()
    print(f"Wanted train numbers from shift-templates: {len(wanted)}")
    print(f"Fetching Yaroslavsky board for {schedule_date}…")

    board = fetch_board(schedule_date)
    print(f"Board rows: {len(board)}")

    uid_map: dict[str, str] = {}
    for row in board:
        thread = row.get("thread") or {}
        num = norm_num(thread.get("number"))
        uid = str(thread.get("uid") or "").strip()
        if num and uid and num not in uid_map:
            uid_map[num] = uid

    matched = {n: uid_map[n] for n in wanted if n in uid_map}
    print(f"UIDs matched for depot numbers: {len(matched)} / {len(wanted)}")

    UIDS_OUT.parent.mkdir(parents=True, exist_ok=True)
    UIDS_OUT.write_text(
        json.dumps(
            {
                "version": 1,
                "sourceDate": schedule_date,
                "station": ANCHOR_STATION,
                "description": "Индекс номер→threadUid с табло Ярославского. Обновлять: python tools/enrich-train-uids.py",
                "uids": matched,
            },
            ensure_ascii=False,
            indent=2,
        )
        + "\n",
        encoding="utf-8",
    )
    print(f"Wrote {UIDS_OUT}")

    if TRAINS_LOCAL.exists():
        local = json.loads(TRAINS_LOCAL.read_text(encoding="utf-8"))
        trains = local.get("trains") or []
        by_num = {norm_num(t.get("number")): t for t in trains}
        added = 0
        for num, uid in sorted(matched.items()):
            if num in by_num:
                if not by_num[num].get("threadUid"):
                    by_num[num]["threadUid"] = uid
                    added += 1
            else:
                trains.append({"number": num, "threadUid": uid, "days": "пн-чт"})
                by_num[num] = trains[-1]
                added += 1
        local["trains"] = trains
        TRAINS_LOCAL.write_text(
            json.dumps(local, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        print(f"Updated trains-local.json (+{added} threadUid entries)")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
