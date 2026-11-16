/** Справочники PWA: crew-api /api/v1/data/* (JWT) или S3, локальные файлы — только на 127.0.0.1. */
(function (global) {
    function cfg() {
        return global.APP_CONFIG?.sheduleMax || {};
    }

    function s3Base() {
        return String(cfg().s3BaseUrl || 'https://shedulemax-public.s3.cloud.ru').replace(/\/$/, '');
    }

    function useDirectS3() {
        return Boolean(s3Base()) && cfg().useDirectS3 !== false;
    }

    function useCrewDataMirror() {
        return global.DaCrewApi?.useCrewDataMirror?.() === true
            && global.DaCrewApi?.hasValidJwt?.() === true;
    }

    function isLocalDevHost() {
        const host = String(global.location?.hostname || '');
        return host === '127.0.0.1' || host === 'localhost';
    }

    function normalizeRelPath(path) {
        let rel = String(path || '').trim().replace(/^\.\//, '');
        if (rel === 'spr.json') return 'data/spr.json';
        if (rel === 'trains-local.json') return 'data/trains-local.json';
        if (!rel.startsWith('data/')) return `data/${rel}`;
        return rel;
    }

    function s3UrlForRel(relPath) {
        const key = normalizeRelPath(relPath);
        return `${s3Base()}/${key}`;
    }

    function crewDataUrlForRel(relPath) {
        if (!useCrewDataMirror()) return '';
        return global.DaCrewApi?.dataMirrorUrlForRel?.(relPath) || '';
    }

    function urlsFor(localPath) {
        const rel = String(localPath || '').trim();
        const urls = [];
        if (isLocalDevHost()) {
            const local = rel.startsWith('./') || rel.startsWith('/') ? rel : `./${rel}`;
            urls.push(local);
        }
        const crewUrl = crewDataUrlForRel(rel);
        if (crewUrl) urls.push(crewUrl);
        if (useDirectS3() && !useCrewDataMirror()) {
            urls.push(s3UrlForRel(rel));
        }
        if (!urls.length) {
            const local = rel.startsWith('./') || rel.startsWith('/') ? rel : `./${rel}`;
            urls.push(local);
        }
        return urls;
    }

    function resolveAssetUrl(relOrAbs) {
        const raw = String(relOrAbs || '').trim();
        if (!raw || /^https?:\/\//i.test(raw)) return raw;
        const rel = raw.replace(/^\.\//, '');
        const crewUrl = crewDataUrlForRel(rel);
        if (crewUrl) return crewUrl;
        if (useDirectS3() && !useCrewDataMirror()) return s3UrlForRel(rel);
        return raw.startsWith('./') ? raw : `./${rel}`;
    }

    async function fetchResource(url, init = {}) {
        const target = String(url || '');
        const merged = { cache: 'no-store', ...init };
        if (global.DaCrewApi?.isCrewDataUrl?.(target)) {
            if (!global.DaCrewApi.hasValidJwt()) {
                const err = new Error('missing_token');
                err.code = 'missing_token';
                throw err;
            }
            const headers = { ...merged.headers, ...global.DaCrewApi.dataAuthHeaders() };
            return global.DaCrewApi.crewFetch(
                target,
                { ...merged, headers },
                merged.timeoutMs || undefined,
            );
        }
        return fetch(target, merged);
    }

    async function fetchJson(localPath, options = {}) {
        const bust = options.cacheBust === true;
        const candidates = urlsFor(localPath);
        let lastError = null;
        for (const url of candidates) {
            const fetchUrl = bust ? `${url}${url.includes('?') ? '&' : '?'}_t=${Date.now()}` : url;
            try {
                const res = await fetchResource(fetchUrl, { cache: 'no-store', timeoutMs: options.timeoutMs });
                if (!res.ok) {
                    lastError = new Error(`HTTP ${res.status} для ${fetchUrl}`);
                    continue;
                }
                const text = await res.text();
                if (!text.trim()) {
                    lastError = new Error(`Пустой ответ: ${fetchUrl}`);
                    continue;
                }
                return JSON.parse(text);
            } catch (err) {
                lastError = err;
            }
        }
        throw lastError || new Error(`Не удалось загрузить ${localPath}`);
    }

    global.AppDataSource = {
        s3Base,
        useDirectS3,
        useCrewDataMirror,
        isLocalDevHost,
        urlsFor,
        resolveAssetUrl,
        fetchResource,
        fetchJson,
        s3UrlForRel,
        crewDataUrlForRel,
    };
})(window);