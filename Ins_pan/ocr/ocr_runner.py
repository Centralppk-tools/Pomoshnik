#!/usr/bin/env python3
"""Гибридный PDF + Occular OCR. Веса — Ins_pan/ocr/models/, движок один на процесс."""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import site
import sys
import time
import traceback
from pathlib import Path
from typing import Callable

# Локальный кэш весов — до huggingface / onnxruntime / occular
MODELS_DIR = str(Path(__file__).resolve().parent / "models")
os.makedirs(MODELS_DIR, exist_ok=True)
os.environ["HF_HOME"] = MODELS_DIR
os.environ["HF_HUB_CACHE"] = str(Path(MODELS_DIR) / "hub")
os.environ["HUGGINGFACE_HUB_CACHE"] = str(Path(MODELS_DIR) / "hub")
os.environ["TORCH_HOME"] = MODELS_DIR
os.environ["TRANSFORMERS_CACHE"] = MODELS_DIR
os.environ.setdefault("HF_HUB_DISABLE_SYMLINKS", "1")
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

def _local_models_ready() -> bool:
    root = Path(MODELS_DIR)
    return (root / "detector_dbnet_fp32.onnx").is_file() and (root / "compact_lm.npz").is_file()


if (Path(MODELS_DIR) / "compact_lm.npz").is_file():
    os.environ["OCCULAR_LM_DIR"] = MODELS_DIR

if _local_models_ready() and os.environ.get("OCR_ALLOW_DOWNLOAD") != "1":
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"

# CUDA DLL из pip (nvidia-cublas-cu12 / nvidia-cudnn-cu12) — до import onnxruntime
def _prepend_nvidia_dll_path() -> None:
    roots = list(site.getsitepackages())
    user = site.getusersitepackages()
    if user:
        roots.append(user)
    for p in roots:
        nvidia_dir = os.path.join(p, "nvidia")
        if not os.path.exists(nvidia_dir):
            continue
        for root, dirs, files in os.walk(nvidia_dir):
            if "bin" in dirs or "lib" in dirs:
                os.environ["PATH"] = root + os.pathsep + os.environ["PATH"]
            base = os.path.basename(root).lower()
            if base in ("bin", "lib"):
                os.environ["PATH"] = root + os.pathsep + os.environ["PATH"]
                if hasattr(os, "add_dll_directory"):
                    try:
                        os.add_dll_directory(root)
                    except OSError:
                        pass
        capi_dir = os.path.join(p, "onnxruntime", "capi")
        if os.path.isdir(capi_dir):
            os.environ["PATH"] = capi_dir + os.pathsep + os.environ["PATH"]
            if hasattr(os, "add_dll_directory"):
                try:
                    os.add_dll_directory(capi_dir)
                except OSError:
                    pass


_prepend_nvidia_dll_path()

for _k, _v in (
    ("PYTHONUNBUFFERED", "1"),
    ("OMP_NUM_THREADS", "2"),
    ("MKL_NUM_THREADS", "2"),
    ("OPENBLAS_NUM_THREADS", "2"),
    ("NUMEXPR_NUM_THREADS", "2"),
    ("ORT_INTRA_OP_NUM_THREADS", "2"),
    ("ORT_INTER_OP_NUM_THREADS", "2"),
):
    os.environ.setdefault(_k, _v)

MEANINGFUL_MIN = 40
DEFAULT_SCALE = 1.5
PREFERRED_PROVIDERS = ["CUDAExecutionProvider", "CPUExecutionProvider"]
LOCAL_WEIGHT_NAMES = (
    "detector_dbnet_fp32.onnx",
    "recognizer_svtr_fp32.onnx",
    "recognizer_charset.txt",
    "compact_lm.npz",
    "unigrams.txt",
)
engine = None
_ENGINE = None
_DEVICE = "cpu"


def log_device(msg: str) -> None:
    sys.stderr.write(msg.rstrip() + "\n")
    sys.stderr.flush()


def resolve_ort_providers() -> list[str]:
    """Всегда пробуем CUDA, затем CPU. На машинах без GPU-сборки ORT — только CPU."""
    try:
        import onnxruntime as ort
        available = set(ort.get_available_providers())
    except Exception:
        return ["CPUExecutionProvider"]
    if "CUDAExecutionProvider" in available:
        return list(PREFERRED_PROVIDERS)
    return ["CPUExecutionProvider"]


def device_label(providers: list[str]) -> str:
    if providers and providers[0] == "CUDAExecutionProvider":
        return "CUDA"
    return "CPU"


def local_weight(rel_path: str) -> str:
    """Сначала Ins_pan/ocr/models/, иначе веса пакета / HF-кэш под HF_HOME."""
    name = Path(rel_path).name
    dest = Path(MODELS_DIR) / name
    if dest.is_file():
        return str(dest)
    from ocr_skel.model_files import WEIGHTS_DIR, ensure_weight
    packaged = WEIGHTS_DIR / rel_path
    src = str(packaged) if packaged.is_file() else ensure_weight(rel_path)
    if os.environ.get("HF_HUB_OFFLINE") == "1" and not Path(src).is_file():
        raise FileNotFoundError(
            f"Нет веса {name} в {MODELS_DIR}. Запустите: python Ins_pan/ocr/preload_models.py"
        )
    dest.parent.mkdir(parents=True, exist_ok=True)
    if Path(src).resolve() != dest.resolve():
        shutil.copy2(src, dest)
    return str(dest)


def bind_onnx_providers(ocr_engine, providers: list[str]):
    """Occular по умолчанию жёстко сажает сессии на CPU — пересоздаём с CUDA+CPU."""
    import onnxruntime as ort

    inner = ocr_engine._pipe._pipeline
    try_providers = list(providers)
    use_cuda = try_providers[0] == "CUDAExecutionProvider"
    threads = 1 if use_cuda else 2
    opts = ort.SessionOptions()
    opts.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1

    def make_session(weight: str):
        nonlocal try_providers, use_cuda
        path = local_weight(weight)
        try:
            sess = ort.InferenceSession(path, sess_options=opts, providers=try_providers)
            actual = list(sess.get_providers())
            if use_cuda and "CUDAExecutionProvider" not in actual:
                raise RuntimeError("CUDA provider not active")
            return sess, actual
        except Exception as err:
            log_device(f"[occular] CUDA недоступна ({err}). Переход на CPU.")
            try_providers = ["CPUExecutionProvider"]
            use_cuda = False
            opts.intra_op_num_threads = 2
            sess = ort.InferenceSession(path, sess_options=opts, providers=try_providers)
            return sess, list(sess.get_providers())

    det_sess, det_p = make_session("detector_dbnet_fp32.onnx")
    rec_sess, rec_p = make_session("recognizer_svtr_fp32.onnx")
    inner.detector.session = det_sess
    inner.detector.input_name = det_sess.get_inputs()[0].name
    inner.detector._torch = None
    inner.recognizer.session = rec_sess
    inner.recognizer.input_name = rec_sess.get_inputs()[0].name
    inner.recognizer._torch = None
    return det_p


class OccularOCR:
    """Обёртка: pip-пакет экспортирует ocr_skel, в ТЗ указан OccularOCR()."""

    def __init__(self, providers=None):
        from ocr_skel import OCRPipeline, Settings
        self.providers = list(providers or PREFERRED_PROVIDERS)
        self._pipe = OCRPipeline(Settings(
            num_threads=2,
            gpu=False,
            deskew=False,
            lm=True,
            reading_order=False,
        ))
        used = bind_onnx_providers(self, self.providers)
        self.device = device_label(used)
        log_device(f"[occular] устройство: {self.device} providers={used}")

    def predict(self, image):
        import numpy as np
        if hasattr(image, "convert"):
            arr = np.asarray(image.convert("RGB"))
        else:
            arr = np.asarray(image)
        inner = self._pipe._pipeline
        rows = inner._ocr_whole(arr)
        lines = []
        for row in rows:
            text = str(row.get("text") or "").strip()
            if not text:
                continue
            lines.append(type("Line", (), {
                "text": text,
                "confidence": float(row.get("confidence") or 0),
                "quad": row.get("quad"),
            })())
        return type("Result", (), {"lines": lines, "raw": rows})()


def emit(obj: dict, write: Callable[[str], None] | None = None) -> None:
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    if write:
        write(line)
    else:
        sys.stdout.write(line)
        sys.stdout.flush()


def warmup_engine(ocr_engine) -> None:
    """LM и первый CUDA-прогон — один раз при старте, не на первом PDF."""
    rec = ocr_engine._pipe._pipeline.recognizer
    if getattr(rec, "lm", False):
        rec._ensure_lm()
        try:
            from ocr_skel.decoder_lm import _resolve_lm_files
            npz, uni = _resolve_lm_files()
            for src, name in ((npz, "compact_lm.npz"), (uni, "unigrams.txt")):
                dest = Path(MODELS_DIR) / name
                if Path(src).resolve() != dest.resolve():
                    shutil.copy2(src, dest)
            os.environ["OCCULAR_LM_DIR"] = MODELS_DIR
        except Exception as err:
            log_device(f"[occular] persist LM: {err}")
    from PIL import Image
    try:
        ocr_engine.predict(Image.new("RGB", (128, 64), (255, 255, 255)))
    except Exception as err:
        log_device(f"[occular] warmup: {err}")


def boot_engine():
    """Единственное место, где создаётся OccularOCR()."""
    global engine, _ENGINE, _DEVICE
    if engine is not None:
        return engine
    providers = resolve_ort_providers()
    log_device(f"[occular] providers={providers}")
    try:
        import ocr_skel  # noqa: F401
    except ImportError as err:
        raise RuntimeError(
            "Пакет occular-ocr не найден. "
            "python -m pip install -r Ins_pan/requirements.txt"
        ) from err
    engine = OccularOCR(providers=PREFERRED_PROVIDERS)
    _ENGINE = engine
    _DEVICE = "cuda" if str(engine.device).upper() == "CUDA" else "cpu"
    warmup_engine(engine)
    log_device(f"[occular] устройство: {engine.device} (модель в RAM, кэш {MODELS_DIR})")
    return engine


def current_device() -> str:
    if engine is not None:
        return _DEVICE
    return "cpu"


def probe(*, loaded: bool = False) -> dict:
    try:
        import ocr_skel
        from importlib.metadata import version as pkg_version
        ver = pkg_version("occular-ocr")
    except Exception as err:
        return {
            "ok": False,
            "engine": "occular",
            "device": "cpu",
            "loaded": False,
            "error": (
                "occular-ocr не найден. python -m pip install occular-ocr. "
                f"{err}"
            ),
        }
    providers = resolve_ort_providers()
    label = current_device()
    return {
        "ok": True,
        "engine": "occular",
        "device": label,
        "providers": providers,
        "version": str(ver),
        "loaded": loaded or _ENGINE is not None,
        "lang": "ru",
        "hybrid": True,
        "scale": DEFAULT_SCALE,
        "threads": 2,
        "skel": getattr(ocr_skel, "__version__", ""),
    }


def meaningful_char_count(text: str) -> int:
    t = str(text or "")
    t = re.sub(r"\(cid:\d+\)", "", t)
    t = re.sub(r"[\ufffd\x00-\x08\x0b\x0c\x0e-\x1f]", "", t)
    return len(re.findall(r"[А-Яа-яЁёA-Za-z0-9]", t))


def extract_pdf_page_text(pdf_path: Path, page_index: int) -> str:
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[page_index]
        tp = page.get_textpage()
        try:
            text = tp.get_text_range() or ""
        finally:
            try:
                tp.close()
            except Exception:
                pass
        return text
    finally:
        try:
            doc.close()
        except Exception:
            pass


def render_page_pil(pdf_path: Path, page_index: int, scale: float):
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(pdf_path))
    try:
        page = doc[page_index]
        bitmap = page.render(scale=max(0.8, float(scale)))
        return bitmap.to_pil().convert("RGB")
    finally:
        try:
            doc.close()
        except Exception:
            pass


def page_count(path: Path) -> int:
    suffix = path.suffix.lower()
    if suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"}:
        return 1
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(str(path))
    try:
        return len(doc)
    finally:
        try:
            doc.close()
        except Exception:
            pass


def load_image(path: Path):
    from PIL import Image
    img = Image.open(path)
    if img.mode != "RGB":
        img = img.convert("RGB")
    return img


def ocr_image(engine, image) -> tuple[str, list[dict]]:
    result = engine.predict(image)
    lines_out = []
    texts = []
    for line in getattr(result, "lines", None) or []:
        text = getattr(line, "text", None)
        if text is None and isinstance(line, dict):
            text = line.get("text")
        text = str(text or "").strip()
        if not text:
            continue
        texts.append(text)
        lines_out.append({"text": text})
    return "\n".join(texts), lines_out


def run_job(
    input_path: Path,
    out_dir: Path,
    scale: float,
    only_page: int | None,
    write: Callable[[str], None] | None = None,
) -> None:
    n = page_count(input_path)
    indices = [only_page - 1] if only_page else list(range(n))
    suffix = input_path.suffix.lower()
    is_image = suffix in {".png", ".jpg", ".jpeg", ".tif", ".tiff", ".webp", ".bmp"}
    emit(
        {
            "event": "start",
            "pageCount": len(indices),
            "device": current_device(),
            "engine": "occular",
            "hybrid": True,
            "scale": scale,
        },
        write,
    )
    emit({"event": "models", "device": _DEVICE or "cpu", "loaded": engine is not None}, write)

    if engine is None:
        raise RuntimeError("OccularOCR не инициализирован. Сначала boot_engine().")
    ocr_engine = engine
    for i, idx in enumerate(indices, start=1):
        t0 = time.perf_counter()
        source = "ocr"
        lines: list[dict] = []
        if is_image:
            img_path = out_dir / "page-0001.png"
            image = load_image(input_path)
            image.save(img_path, format="PNG")
            page_no = 1
            markdown, lines = ocr_image(ocr_engine, image)
            try:
                image.close()
            except Exception:
                pass
        else:
            page_no = idx + 1
            native = extract_pdf_page_text(input_path, idx)
            preview = render_page_pil(input_path, idx, scale)
            img_path = out_dir / f"page-{page_no:04d}.png"
            preview.save(img_path, format="PNG")
            native_ok = len(native.strip()) > MEANINGFUL_MIN and meaningful_char_count(native) > MEANINGFUL_MIN
            if native_ok:
                source = "digital"
                markdown = native.strip()
            else:
                markdown, lines = ocr_image(ocr_engine, preview)
            try:
                preview.close()
            except Exception:
                pass
        elapsed_ms = round((time.perf_counter() - t0) * 1000, 1)
        emit(
            {
                "event": "page",
                "page": page_no,
                "index": i,
                "total": len(indices),
                "markdown": markdown,
                "text": markdown,
                "lines": lines,
                "image": str(img_path),
                "device": _DEVICE or "cpu",
                "source": source,
                "ms": elapsed_ms,
            },
            write,
        )
    emit({"event": "done", "device": _DEVICE or "cpu"}, write)


def process_document(data: dict) -> None:
    src = Path(str(data.get("pdf_path") or data.get("input") or ""))
    out_dir = Path(str(data.get("outDir") or data.get("out_dir") or (src.parent / "_ocr_out")))
    scale = float(data.get("scale") or os.environ.get("OCR_SCALE") or DEFAULT_SCALE)
    page = int(data.get("page") or 0)
    if not src.exists():
        emit({"event": "error", "error": f"file not found: {src}"})
        return
    out_dir.mkdir(parents=True, exist_ok=True)
    run_job(src, out_dir, scale, page if page > 0 else None)


def serve_stdin() -> int:
    boot_engine()
    emit({"event": "ready", **probe(loaded=True)})
    log_device("[occular] stdin worker: модель в RAM, жду задачи")
    for line in sys.stdin:
        if not line.strip():
            continue
        try:
            data = json.loads(line)
        except Exception as err:
            emit({"event": "error", "error": f"bad json: {err}"})
            continue
        try:
            process_document(data)
        except Exception as err:
            emit(
                {
                    "event": "error",
                    "error": str(err),
                    "trace": traceback.format_exc()[-1200:],
                }
            )
        sys.stdout.flush()
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Occular OCR runner")
    parser.add_argument("--probe", action="store_true")
    parser.add_argument("--serve", action="store_true", help="Демон: модель в RAM + задачи из stdin")
    parser.add_argument("--input", type=str, default="")
    parser.add_argument("--out-dir", type=str, default="")
    parser.add_argument("--page", type=int, default=0)
    parser.add_argument("--scale", type=float, default=float(os.environ.get("OCR_SCALE") or DEFAULT_SCALE))
    args = parser.parse_args()

    if args.probe:
        result = probe(loaded=engine is not None)
        emit(result)
        return 0 if result["ok"] else 2
    if args.serve or not args.input:
        try:
            return serve_stdin()
        except Exception as err:
            emit({"event": "error", "error": str(err), "trace": traceback.format_exc()[-1200:]})
            return 1
    src = Path(args.input)
    if not src.exists():
        emit({"ok": False, "error": f"file not found: {src}"})
        return 2
    boot_engine()
    out_dir = Path(args.out_dir or (src.parent / "_ocr_out"))
    out_dir.mkdir(parents=True, exist_ok=True)
    try:
        run_job(src, out_dir, args.scale, args.page if args.page > 0 else None)
        return 0
    except Exception as err:
        emit({"event": "error", "error": str(err), "trace": traceback.format_exc()[-1200:]})
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
