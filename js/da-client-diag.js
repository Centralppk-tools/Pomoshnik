/**
 * Последние клиентские ошибки и диагностика для обратной связи (без PII/токенов).
 */
(function daClientDiag(global) {
    const MAX = 20;
    const buffer = [];
    let consoleHooked = false;

    function redact(text) {
        let s = String(text || "");
        s = s.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]");
        s = s.replace(/(password|passwd|token|jwt|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
        s = s.replace(/da_auth_[a-z_]+/gi, "[storage-key]");
        return s.slice(0, 800);
    }

    function stackFrom(err) {
        if (!err) return "";
        if (typeof err === "string") return "";
        const st = err.stack || err.reason?.stack;
        return redact(String(st || "")).slice(0, 1200);
    }

    function pushEntry(type, message, stack) {
        buffer.push({
            type: String(type || "error").slice(0, 32),
            message: redact(message),
            stack: redact(stack || "").slice(0, 1200),
            at: new Date().toISOString(),
        });
        while (buffer.length > MAX) buffer.shift();
    }

    global.addEventListener("error", (event) => {
        const err = event?.error;
        const msg = event?.message || (err && err.message) || "error";
        pushEntry("error", msg, stackFrom(err));
    });

    global.addEventListener("unhandledrejection", (event) => {
        const reason = event?.reason;
        const msg =
            (reason && reason.message)
            || (typeof reason === "string" ? reason : "unhandledrejection");
        pushEntry("unhandledrejection", msg, stackFrom(reason));
    });

    function hookConsoleError() {
        if (consoleHooked || !global.console) return;
        consoleHooked = true;
        const orig = global.console.error?.bind(global.console);
        if (!orig) return;
        global.console.error = function patchedConsoleError(...args) {
            try {
                const parts = args.map((a) => {
                    if (a instanceof Error) return a.message;
                    if (typeof a === "object") {
                        try {
                            return JSON.stringify(a);
                        } catch (_) {
                            return String(a);
                        }
                    }
                    return String(a);
                });
                const errObj = args.find((a) => a instanceof Error);
                pushEntry("console.error", parts.join(" "), stackFrom(errObj));
            } catch (_) {
                /* ignore */
            }
            orig(...args);
        };
    }
    hookConsoleError();

    function snapshotExtra() {
        let syncState = null;
        try {
            syncState = {
                crewApiEnabled: Boolean(global.DaCrewApi?.isEnabled?.()),
                online: Boolean(global.navigator?.onLine),
                cloudMigrated: global.localStorage?.getItem("da_cloud_migrated_v1") ? true : false,
            };
        } catch (_) {
            syncState = { online: Boolean(global.navigator?.onLine) };
        }
        return syncState;
    }

    function buildFeedbackDiagnostic(appVersion, activeScreen) {
        const screen = String(activeScreen || "").trim().slice(0, 64);
        const viewport = `${global.innerWidth || 0}x${global.innerHeight || 0} @${global.devicePixelRatio || 1}`;
        const ua = String(global.navigator?.userAgent || "").slice(0, 512);
        const errors = global.DaClientDiag.getRecentErrors();
        const lines = [
            `Экран: ${screen || "—"}`,
            `Версия: ${String(appVersion || "").slice(0, 32) || "—"}`,
            `Разрешение: ${viewport}`,
            `Онлайн: ${global.navigator?.onLine ? "да" : "нет"}`,
        ];
        if (errors.length) {
            lines.push("Последние ошибки:");
            errors.slice(-10).forEach((row, idx) => {
                lines.push(`${idx + 1}. [${row.at}] ${row.type}: ${row.message}`);
                if (row.stack) lines.push(row.stack.slice(0, 280));
            });
        }
        return {
            screen,
            app_version: String(appVersion || "").slice(0, 32),
            viewport,
            userAgent: ua,
            online: Boolean(global.navigator?.onLine),
            recentErrors: errors,
            diagnosticText: lines.join("\n").slice(0, 3500),
        };
    }

    global.DaClientDiag = {
        getRecentErrors() {
            return buffer.map((row) => ({ ...row }));
        },
        buildClientMeta(appVersion) {
            let standalone = false;
            try {
                standalone = Boolean(
                    global.matchMedia
                    && global.matchMedia("(display-mode: standalone)").matches,
                );
            } catch (_) { /* */ }
            return {
                userAgent: String(global.navigator?.userAgent || "").slice(0, 512),
                platform: String(global.navigator?.platform || "").slice(0, 64),
                standalone,
                online: Boolean(global.navigator?.onLine),
                app_version: String(appVersion || "").slice(0, 32),
                recentErrors: global.DaClientDiag.getRecentErrors(),
                syncState: snapshotExtra(),
            };
        },
        buildFeedbackDiagnostic,
    };
})(typeof window !== "undefined" ? window : globalThis);
