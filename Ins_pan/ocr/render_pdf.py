"""Рендер PDF в PNG. Пакет: pip install -r Ins_pan/requirements.txt"""
import os
import sys

def main():
    if len(sys.argv) < 4:
        print("usage: render_pdf.py input.pdf outdir dpi", file=sys.stderr)
        return 1
    pdf, outdir, dpi = sys.argv[1], sys.argv[2], int(sys.argv[3])
    try:
        import pymupdf as fitz
    except ImportError:
        try:
            import fitz
        except ImportError:
            print("pymupdf not installed", file=sys.stderr)
            return 2
    os.makedirs(outdir, exist_ok=True)
    doc = fitz.open(pdf)
    zoom = dpi / 72.0
    mat = fitz.Matrix(zoom, zoom)
    for i, page in enumerate(doc, start=1):
        pix = page.get_pixmap(matrix=mat, alpha=False)
        pix.save(os.path.join(outdir, f"page-{i:04d}.png"))
    print(len(doc))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
