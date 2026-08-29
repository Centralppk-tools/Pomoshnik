'use strict';

/**
 * Точка входа Yandex Cloud Function.
 * HTTPS: https://functions.yandexcloud.net/<id>
 *
 * Таймеры (HTTP GET с secret):
 *   ?preload_boards=1&secret=…  — 00:05 МСК
 *   ?run_push=1&secret=…        — каждую минуту
 */

const { createStore } = require('./lib/store');
const core = require('./lib/core');

function buildEnv() {
    const env = { ...process.env };
    env.CACHE_KV = createStore(process.env);
    return env;
}

function queryFromEvent(event) {
    const q = event.queryStringParameters || {};
    const multi = event.multiValueQueryStringParameters || {};
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
        if (v != null) params.set(k, String(v));
    }
    for (const [k, values] of Object.entries(multi)) {
        if (Array.isArray(values)) {
            for (const v of values) params.append(k, String(v));
        }
    }
    return params;
}

function buildRequestUrl(event) {
    if (event.url) {
        try {
            return new URL(event.url);
        } catch {
            /* fall through */
        }
    }

    const host = event.headers?.['Host']
        || event.headers?.['host']
        || 'functions.yandexcloud.net';
    const path = event.path || '/';
    const params = queryFromEvent(event);
    const qs = params.toString();
    return new URL(`https://${host}${path}${qs ? `?${qs}` : ''}`);
}

function decodeBody(event) {
    if (event.body == null || event.body === '') return null;
    if (event.isBase64Encoded) {
        return Buffer.from(event.body, 'base64');
    }
    return event.body;
}

async function responseToYc(response) {
    if (!response) {
        return { statusCode: 204, headers: {}, body: '' };
    }

    const headers = {};
    if (response.headers && typeof response.headers.forEach === 'function') {
        response.headers.forEach((value, key) => {
            headers[key] = value;
        });
    } else if (response.headers && typeof response.headers === 'object') {
        Object.assign(headers, response.headers);
    }

    const originalStatus = response.status || 200;
    const ct = String(headers['Content-Type'] || headers['content-type'] || '');
    const isBinary = /^(application\/pdf|application\/octet-stream|image\/)/i.test(ct);

    if (isBinary) {
        let buf;
        if (typeof response.arrayBuffer === 'function') {
            buf = Buffer.from(await response.arrayBuffer());
        } else if (Buffer.isBuffer(response.body)) {
            buf = response.body;
        } else {
            buf = Buffer.from(String(response.body || ''), 'binary');
        }
        const statusCode = originalStatus >= 400 ? 200 : originalStatus;
        return {
            statusCode,
            isBase64Encoded: true,
            headers: {
                ...headers,
                'X-Original-Status': String(originalStatus),
            },
            body: buf.toString('base64'),
        };
    }

    let body = '';
    if (typeof response.text === 'function') {
        body = await response.text();
    } else if (response.body != null) {
        body = String(response.body);
    }

    // Yandex Cloud HTTP: тело ответа при statusCode != 2xx часто обрезается (Content-Length: 0).
    // Отдаём прикладные ошибки как 200 + JSON, исходный код — в заголовке.
    // Исключение: 403 gate — реальный Forbidden (как просили для левых запросов).
    if (originalStatus >= 400 && originalStatus !== 403) {
        if (!body) {
            body = JSON.stringify({
                ok: false,
                httpStatus: originalStatus,
                error: 'upstream_error',
            });
        }
        return {
            statusCode: 200,
            headers: {
                ...headers,
                'Content-Type': headers['Content-Type'] || headers['content-type'] || 'application/json; charset=utf-8',
                'X-Original-Status': String(originalStatus),
            },
            body,
        };
    }

    return {
        statusCode: originalStatus,
        headers,
        body,
    };
}

function isTimerEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.httpMethod || event.requestContext?.http) return false;
    if (event.messages || event.event_metadata || event.cron) return true;
    if (event.details?.payload) return true;
    return false;
}

function timerKind(event) {
    const raw = JSON.stringify(event || {});
    if (/board|preload/i.test(raw)) return 'board';
    if (event?.cron === '5 21 * * *') return 'board';
    return 'push';
}

/**
 * @param {object} event
 * @param {object} context
 */
module.exports.handler = async function handler(event, context) {
    const env = buildEnv();

    if (isTimerEvent(event)) {
        const kind = timerKind(event);
        if (kind === 'board') {
            await core.scheduled({ cron: '5 21 * * *' }, env);
        } else {
            await core.scheduled({ cron: '* * * * *' }, env);
        }
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ ok: true, kind }),
        };
    }

    const method = String(
        event.httpMethod
        || event.requestContext?.http?.method
        || event.requestContext?.httpMethod
        || 'GET'
    ).toUpperCase();

    const url = buildRequestUrl(event);
    const body = decodeBody(event);
    const headerInit = event.headers || {};

    const request = new Request(url.toString(), {
        method,
        headers: headerInit,
        body: method === 'GET' || method === 'HEAD' ? undefined : body,
    });

    const response = await core.handleRequest(request, env);
    return responseToYc(response);
};
