/**
 * Последние клиентские ошибки и диагностика для обратной связи (без PII/токенов).
 */
(function daClientDiag(global) {
    const MAX = 5;
    const buffer = [];

    function redact(text) {
        let s = String(text || "");
        s = s.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, "Bearer [redacted]");
        s = s.replace(/(password|passwd|token|jwt|authorization)\s*[:=]\s*\S+/gi, "$1=[redacted]");
        s = s.replace(/da_auth_[a-z_]+/gi, "[storage-key]");
        return s.slice(0, 500);
    }

    function pushEntry(type, message) {
        buffer.push({ type, message: redact(message), at: new Date().toISOString() });
        while (buffer.length > MAX) buffer.shift();
    }

    global.addEventListener("error", (event) => {
        const msg = event?.message || (event?.error && event.error.message) || "error";
        pushEntry("error", msg);
    });

    global.addEventListener("unhandledrejection", (event) => {
        const reason = event?.reason;
        const msg =
            (reason && reason.message)
            || (typeof reason === "string" ? reason : "unhandledrejection");
        pushEntry("unhandledrejection", msg);
    });

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
    };
})(typeof window !== "undefined" ? window : globalThis);
