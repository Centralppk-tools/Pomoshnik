/**
 * Снимок видимой области экрана для обратной связи (modern-screenshot, офлайн).
 */
(function daFeedbackCapture(global) {
    const MAX_SIDE = 8192;
    const DEFAULT_TIMEOUT_MS = 14000;

    function getVisibleScreen() {
        const doc = global.document;
        if (!doc) return null;
        const screens = Array.from(doc.querySelectorAll(".screen")).filter(
            (el) => el && !el.classList.contains("hidden")
        );
        return screens[0] || null;
    }

  /**
   * Корень съёмки: телефонная рамка или прокручиваемая карточка вкладки (не document/body).
   */
    function captureRoot() {
        const screen = getVisibleScreen();
        if (!screen) {
            return global.document?.body || null;
        }
        const phone = screen.querySelector(".phone-screen");
        const card = phone?.querySelector(".screen-card");
        if (card) {
            const sh = card.scrollHeight || 0;
            const ch = card.clientHeight || 0;
            if (ch > 0 && sh > ch + 4) {
                return card;
            }
        }
        if (phone) return phone;
        return screen;
    }

    function captureViewportSize(root) {
        if (!root) {
            return {
                width: Math.max(global.innerWidth || 1, 1),
                height: Math.max(global.innerHeight || 1, 1),
            };
        }
        const rect = root.getBoundingClientRect();
        const width = Math.max(
            Math.round(rect.width || 0),
            root.clientWidth || 0,
            root.offsetWidth || 0,
            1
        );
        const viewportH = Math.max(root.clientHeight || 0, root.offsetHeight || 0);
        const visibleH = Math.min(
            viewportH || 0,
            Math.max(global.innerHeight || 0, 1)
        );
        const height = Math.max(visibleH || Math.round(rect.height || 0) || 1, 1);
        return { width, height };
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
        const { width, height } = captureViewportSize(root);
        const scale = pickScale(width, height);
        const timeout = Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS;
        const filter = (node) => {
            if (!node || node.nodeType !== 1) return true;
            const id = node.id || "";
            if (id === "feedbackSheet" || id === "appUpdateToast") return false;
            if (node.classList && node.classList.contains("feedback-sheet-overlay")) return false;
            if (node.classList && node.classList.contains("donate-sheet-overlay") && node.classList.contains("is-open")) {
                return false;
            }
            if (node.classList && node.classList.contains("screen") && node.classList.contains("hidden")) {
                return false;
            }
            return true;
        };
        return Promise.race([
            lib.domToPng(root, {
                scale,
                width,
                height,
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