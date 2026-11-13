/**
 * Полностраничный снимок для обратной связи (modern-screenshot, офлайн).
 */
(function daFeedbackCapture(global) {
    const MAX_SIDE = 8192;
    const DEFAULT_TIMEOUT_MS = 14000;

    function captureRoot() {
        const doc = global.document;
        if (!doc) return null;
        const candidates = [
            doc.documentElement,
            doc.body,
            doc.querySelector(".phone-screen"),
            ...Array.from(doc.querySelectorAll(".screen:not(.hidden)")),
        ].filter(Boolean);
        let best = doc.documentElement;
        let bestH = 0;
        candidates.forEach((el) => {
            const h = Math.max(el.scrollHeight || 0, el.offsetHeight || 0);
            if (h > bestH) {
                bestH = h;
                best = el;
            }
        });
        return best;
    }

    function pickScale(width, height) {
        const maxDim = Math.max(width, height, 1);
        const byCanvas = MAX_SIDE / maxDim;
        const dpr = Math.min(global.devicePixelRatio || 1, 2);
        return Math.min(dpr, byCanvas, 1.5);
    }

    function capturePage(options = {}) {
        const lib = global.modernScreenshot;
        if (!lib || typeof lib.domToPng !== "function") {
            return Promise.reject(new Error("capture_lib_missing"));
        }
        const root = captureRoot();
        if (!root) return Promise.reject(new Error("capture_root_missing"));
        const rectW = Math.max(root.scrollWidth || 0, root.offsetWidth || 0, 1);
        const rectH = Math.max(root.scrollHeight || 0, root.offsetHeight || 0, 1);
        const scale = pickScale(rectW, rectH);
        const timeout = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
        const filter = (node) => {
            if (!node || node.nodeType !== 1) return true;
            const id = node.id || "";
            if (id === "feedbackSheet" || id === "appUpdateToast") return false;
            if (node.classList && node.classList.contains("feedback-sheet-overlay")) return false;
            if (node.classList && node.classList.contains("donate-sheet-overlay") && node.classList.contains("is-open")) {
                return false;
            }
            return true;
        };
        return Promise.race([
            lib.domToPng(root, {
                scale,
                backgroundColor: "#0b0e14",
                maximumCanvasSize: MAX_SIDE,
                timeout,
                filter,
                features: {
                    restoreScrollPosition: true,
                    removeControlCharacter: true,
                },
            }),
            new Promise((_, reject) => {
                setTimeout(() => reject(new Error("capture_timeout")), timeout + 500);
            }),
        ]);
    }

    global.DaFeedbackCapture = {
        capturePage,
        captureRoot,
    };
})(typeof window !== "undefined" ? window : globalThis);
