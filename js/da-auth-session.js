/**
 * JWT-сессия аккаунта (register/login/reset).
 */
(function (global) {
    'use strict';

    const JWT_KEY = 'da_auth_jwt';
    const USER_KEY = 'da_auth_user';

    function getJwt() {
        try {
            return (global.localStorage.getItem(JWT_KEY) || '').trim();
        } catch (_) {
            return '';
        }
    }

    function getStoredUser() {
        try {
            const raw = global.localStorage.getItem(USER_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch (_) {
            return null;
        }
    }

    function persistSession(token, user) {
        function safeSet(key, value) {
            try {
                global.localStorage.setItem(key, value);
            } catch (err) {
                if (err && err.name === 'QuotaExceededError' && typeof global.DaAuthSessionFreeStorage === 'function') {
                    global.DaAuthSessionFreeStorage();
                    global.localStorage.setItem(key, value);
                    return;
                }
                throw err;
            }
        }
        if (token) {
            safeSet(JWT_KEY, String(token));
        }
        if (user && typeof user === 'object') {
            const prev = getStoredUser();
            let merged = user;
            if (prev && typeof prev === 'object') {
                merged = { ...prev, ...user };
                // Ответ /api/v1/sync не отдаёт email_verified_at — не затираем после миграции.
                if (prev.email_verified_at && (user.email_verified_at == null || String(user.email_verified_at).trim() === '')) {
                    merged.email_verified_at = prev.email_verified_at;
                }
                if (prev.email && (user.email == null || String(user.email).trim() === '')) {
                    merged.email = prev.email;
                }
            }
            safeSet(USER_KEY, JSON.stringify(merged));
            const verified = merged.email_verified_at != null && String(merged.email_verified_at).trim() !== '';
            if (verified && merged.email && String(merged.email).trim()) {
                try {
                    global.localStorage.setItem('da_had_cloud_account', '1');
                } catch (_) { /* */ }
            }
        }
    }

    function clearSession() {
        try {
            global.localStorage.removeItem(JWT_KEY);
            global.localStorage.removeItem(USER_KEY);
        } catch (_) { /* */ }
    }

    function applyUserToProfile(user) {
        if (!user || typeof user !== 'object') return;
        const name = String(user.name || '').trim();
        const tab = String(user.tab_number || '').trim();
        if (name) {
            try { global.localStorage.setItem('depotFio', name); } catch (_) { /* */ }
        }
        if (tab) {
            try { global.localStorage.setItem('depotTab', tab); } catch (_) { /* */ }
        }
        const role = String(user.role || '').toLowerCase();
        if (role.includes('машинист') || role === 'driver') {
            try { global.localStorage.setItem('depotPosition', 'machinist'); } catch (_) { /* */ }
        } else if (role) {
            try { global.localStorage.setItem('depotPosition', 'assistant'); } catch (_) { /* */ }
        }
    }

    function authHeaders() {
        const jwt = getJwt();
        if (!jwt) return {};
        return { Authorization: `Bearer ${jwt}` };
    }

    function resolveCrewApiBaseUrl() {
        const c = global.APP_CONFIG?.crewApi || {};
        const configured = String(c.baseUrl || '').replace(/\/$/, '');
        if (c.devSameOriginProxy === false || !configured) return configured;
        if (typeof global.location === 'undefined') return configured;
        const loc = global.location;
        const host = String(loc.hostname || '').toLowerCase();
        if (loc.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
            return String(loc.origin || '').replace(/\/$/, '');
        }
        return configured;
    }

    function normalizeAuthPath(path) {
        const p = String(path || '').trim();
        if (!p) return '/api/auth/register';
        return p.startsWith('/') ? p : `/${p}`;
    }

    async function authFetch(path, options) {
        const baseUrl = resolveCrewApiBaseUrl();
        if (!baseUrl) throw new Error('crew_api_disabled');
        const apiPath = normalizeAuthPath(path);
        const url = `${baseUrl}${apiPath}`;
        const opts = options && typeof options === 'object' ? options : {};
        const method = String(opts.method || 'POST').toUpperCase();
        const init = {
            method,
            headers: {
                ...authHeaders(),
                ...(opts.headers || {})
            },
            cache: 'no-store'
        };
        if (method !== 'GET' && method !== 'HEAD') {
            init.headers['Content-Type'] = 'application/json';
        }
        if (opts.body != null) {
            init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
        }
        const res = await fetch(url, init);
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `http_${res.status}`);
            err.status = res.status;
            err.requestUrl = url;
            err.payload = data || {
                error: `http_${res.status}`,
                message: res.status === 404
                    ? 'Сервис авторизации не найден. Обновите crew-api на сервере или запустите локально npm start в crew-api/.'
                    : `Ошибка запроса ${res.status}`
            };
            throw err;
        }
        return data;
    }

    async function register(payload) {
        const data = await authFetch('/api/auth/register', { body: payload });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function verifyRegistration(email, code) {
        const data = await authFetch('/api/auth/verify-registration', {
            body: { email: String(email || '').trim(), code: String(code || '').trim() }
        });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function login(payload) {
        const body = payload && typeof payload === 'object' ? { ...payload } : {};
        const loginVal = String(body.login || body.email || body.tab_number || '').trim();
        const tabExtra = String(body.tab_number || '').trim();
        if (loginVal.includes('@') && tabExtra) {
            body.tab_number = tabExtra;
        }
        const data = await authFetch('/api/auth/login', { body });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function forgotPassword(emailOrTab) {
        return authFetch('/api/auth/forgot-password', {
            body: { emailOrTab: String(emailOrTab || '').trim() }
        });
    }

    async function resetPassword(token, newPassword) {
        const body = { token, newPassword };
        let data;
        try {
            data = await authFetch('/api/auth/reset-password-confirm', { body });
        } catch (err) {
            if (err?.status === 404) {
                data = await authFetch('/api/auth/reset-password', { body });
            } else {
                throw err;
            }
        }
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function checkResetToken(token) {
        let data;
        try {
            data = await authFetch('/api/auth/check-reset-token', {
                body: { token: String(token || '').trim() }
            });
        } catch (err) {
            if (err?.status === 404) {
                return { ok: true, valid: true };
            }
            throw err;
        }
        return data;
    }

    async function bindEmail(email) {
        const data = await authFetch('/api/auth/bind-email', {
            body: { email: String(email || '').trim() }
        });
        if (data.user) persistSession(getJwt(), data.user);
        return data;
    }

    async function upgradeProfile(payload) {
        const data = await authFetch('/api/auth/upgrade-profile', { body: payload });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function requestMigrationEmail(payload) {
        return authFetch('/api/auth/request-migration-email', { body: payload });
    }

    async function verifyMigrationEmail(payload) {
        const data = await authFetch('/api/auth/verify-migration-email', { body: payload });
        if (data.token) persistSession(data.token, data.user);
        return data;
    }

    async function fetchMe() {
        const data = await authFetch('/api/auth/me', { method: 'GET' });
        if (data?.user) persistSession(getJwt(), data.user);
        return data;
    }

    function hasVerifiedEmailOnAccount() {
        const u = getStoredUser();
        if (!u) return false;
        const mail = String(u.email || '').trim();
        if (!mail) return false;
        return u.email_verified_at != null && String(u.email_verified_at).trim() !== '';
    }

    function hasEmailOnAccount() {
        return hasVerifiedEmailOnAccount();
    }

    global.DaAuthSession = {
        getJwt,
        getStoredUser,
        persistSession,
        clearSession,
        applyUserToProfile,
        authHeaders,
        register,
        verifyRegistration,
        login,
        forgotPassword,
        resetPassword,
        checkResetToken,
        bindEmail,
        upgradeProfile,
        requestMigrationEmail,
        verifyMigrationEmail,
        fetchMe,
        hasEmailOnAccount,
        hasVerifiedEmailOnAccount
    };
})(typeof window !== 'undefined' ? window : globalThis);
