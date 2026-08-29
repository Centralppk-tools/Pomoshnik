'use strict';

/**
 * Базовая защита HTTP-входа Cloud Function:
 * - Origin / Referer только с Pages / localhost
 * - кастомный заголовок X-DA-Client
 * Таймеры/stats с ?secret=STATS_SECRET — без Origin (обход).
 */

const CLIENT_HEADER = 'x-da-client';

const DEFAULT_ALLOWED_ORIGINS = [
    'https://centralppk-tools.github.io',
    'http://127.0.0.1:8765',
    'http://localhost:8765',
    'http://127.0.0.1:8790',
    'http://localhost:8790',
];

function getAllowedOrigins(env = {}) {
    const raw = String(env.ALLOWED_ORIGINS || process.env.ALLOWED_ORIGINS || '').trim();
    if (!raw) return DEFAULT_ALLOWED_ORIGINS.slice();
    return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

function getExpectedClientToken(env = {}) {
    return String(env.CLIENT_GATE_TOKEN || process.env.CLIENT_GATE_TOKEN || '').trim();
}

function headerGet(request, name) {
    try {
        return String(request.headers?.get?.(name) || '').trim();
    } catch {
        return '';
    }
}

function originFromUrlLike(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    try {
        return new URL(raw).origin;
    } catch {
        return '';
    }
}

function isAllowedOrigin(origin, allowed) {
    if (!origin) return false;
    return allowed.includes(origin);
}

/** Таймеры /stats с корректным secret — без клиентского Origin */
function isSecretOpsBypass(reqUrl, env = {}) {
    const secret = String(reqUrl.searchParams.get('secret') || '').trim();
    const expected = String(env.STATS_SECRET || process.env.STATS_SECRET || '').trim();
    if (!expected || secret !== expected) return false;

    const path = (reqUrl.pathname || '/').replace(/\/+$/, '') || '/';
    if (path === '/stats') return true;
    if (reqUrl.searchParams.get('preload_boards') === '1') return true;
    if (reqUrl.searchParams.get('run_push') === '1') return true;
    return false;
}

function corsHeadersFor(origin, extra = {}) {
    const headers = {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-DA-Client',
        'Access-Control-Max-Age': '86400',
        'Vary': 'Origin',
        ...extra,
    };
    if (origin) {
        headers['Access-Control-Allow-Origin'] = origin;
    }
    return headers;
}

function forbiddenResponse(origin, message = 'Forbidden') {
    return new Response(JSON.stringify({ ok: false, error: 'forbidden', message }), {
        status: 403,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            ...corsHeadersFor(origin),
        },
    });
}

/**
 * @returns {{ ok: true, origin: string } | { ok: false, response: Response }}
 */
function assertClientAccess(request, reqUrl, env = {}) {
    if (isSecretOpsBypass(reqUrl, env)) {
        return { ok: true, origin: '' };
    }

    const allowed = getAllowedOrigins(env);
    const expectedToken = getExpectedClientToken(env);
    const reqOrigin = originFromUrlLike(headerGet(request, 'Origin'));
    const refOrigin = originFromUrlLike(headerGet(request, 'Referer'));
    const matchedOrigin = isAllowedOrigin(reqOrigin, allowed)
        ? reqOrigin
        : (isAllowedOrigin(refOrigin, allowed) ? refOrigin : '');

    if (!matchedOrigin) {
        return { ok: false, response: forbiddenResponse('', 'Origin/Referer not allowed') };
    }

    if (!expectedToken) {
        return { ok: false, response: forbiddenResponse(matchedOrigin, 'CLIENT_GATE_TOKEN not configured') };
    }

    const clientToken = headerGet(request, CLIENT_HEADER);
    if (!clientToken || clientToken !== expectedToken) {
        return { ok: false, response: forbiddenResponse(matchedOrigin, 'Invalid client header') };
    }

    return { ok: true, origin: matchedOrigin };
}

function optionsResponse(request, env = {}) {
    const allowed = getAllowedOrigins(env);
    const reqOrigin = originFromUrlLike(headerGet(request, 'Origin'));
    if (!isAllowedOrigin(reqOrigin, allowed)) {
        return forbiddenResponse('', 'Origin not allowed');
    }
    return new Response(null, {
        status: 204,
        headers: corsHeadersFor(reqOrigin),
    });
}

module.exports = {
    CLIENT_HEADER,
    DEFAULT_ALLOWED_ORIGINS,
    getAllowedOrigins,
    getExpectedClientToken,
    assertClientAccess,
    optionsResponse,
    corsHeadersFor,
    isSecretOpsBypass,
};
