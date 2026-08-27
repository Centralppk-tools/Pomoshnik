#!/usr/bin/env python3
"""Один раз скачать веса Occular в Ins_pan/ocr/models/ (нужен интернет)."""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
MODELS = ROOT / "models"
MODELS.mkdir(parents=True, exist_ok=True)

os.environ["OCR_ALLOW_DOWNLOAD"] = "1"
os.environ["HF_HUB_OFFLINE"] = "0"
os.environ["TRANSFORMERS_OFFLINE"] = "0"
os.environ["HF_HOME"] = str(MODELS)
os.environ["HF_HUB_CACHE"] = str(MODELS / "hub")
os.environ["HUGGINGFACE_HUB_CACHE"] = str(MODELS / "hub")
os.environ["TORCH_HOME"] = str(MODELS)
os.environ["TRANSFORMERS_CACHE"] = str(MODELS)
os.environ["OCCULAR_LM_DIR"] = str(MODELS)
os.environ["HF_HUB_DISABLE_SYMLINKS"] = "1"


def _seed_user_hf_cache() -> None:
    old = Path.home() / ".cache" / "huggingface" / "hub"
    dest_hub = MODELS / "hub"
    if not old.is_dir():
        return
    dest_hub.mkdir(parents=True, exist_ok=True)
    for name in ("models--Shivin11--occular-ocr", "models--Shivin11--occular-lm-ru"):
        src = old / name
        dst = dest_hub / name
        if src.is_dir() and not dst.exists():
            print(f"[preload] копирую кэш {name} …", flush=True)
            shutil.copytree(src, dst)


def _copy_named(src: Path, name: str) -> None:
    dest = MODELS / name
    if src.is_file():
        shutil.copy2(src, dest)
        print(f"[preload] {name} -> {dest} ({dest.stat().st_size / 1e6:.1f} MB)", flush=True)


def main() -> int:
    sys.path.insert(0, str(ROOT))
    _seed_user_hf_cache()

    from huggingface_hub import hf_hub_download
    from ocr_skel.model_files import WEIGHTS_DIR, LM_HF_REPO, ensure_weight

    print(f"[preload] папка весов: {MODELS}", flush=True)
    for rel in ("detector_dbnet_fp32.onnx", "recognizer_svtr_fp32.onnx", "recognizer_charset.txt"):
        packaged = WEIGHTS_DIR / rel
        src = packaged if packaged.is_file() else Path(ensure_weight(rel))
        _copy_named(src, Path(rel).name)

    for name in ("compact_lm.npz", "unigrams.txt"):
        src = Path(hf_hub_download(LM_HF_REPO, name))
        _copy_named(src, name)

    print("[preload] инициализация OccularOCR + прогрев LM …", flush=True)
    import ocr_runner
    ocr_runner.boot_engine()
    missing = [n for n in ocr_runner.LOCAL_WEIGHT_NAMES if not (MODELS / n).is_file()]
    if missing:
        print("[preload] нет файлов:", ", ".join(missing), file=sys.stderr)
        return 1
    print("[preload] готово. Дальше демон работает офлайн из models/.", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
