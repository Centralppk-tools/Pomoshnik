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
    const params = new URLSearchParams();

    const q = event.queryStringParameters || event.query || {};
    for (const [k, v] of Object.entries(q)) {
        if (v != null) params.set(k, String(v));
    }

    const multi = event.multiValueQueryStringParameters || {};
    for (const [k, values] of Object.entries(multi)) {
        if (Array.isArray(values)) {
            for (const v of values) params.append(k, String(v));
        }
    }

    if (event.rawQueryString) {
        const raw = new URLSearchParams(String(event.rawQueryString));
        for (const [k, v] of raw.entries()) {
            if (!params.has(k)) params.set(k, v);
        }
    }

    return params;
}

function buildRequestUrl(event) {
    const host = event.headers?.Host
        || event.headers?.host
        || 'functions.yandexcloud.net';
    const pathRaw = event.path || event.rawPath || '/';
    const path = pathRaw.startsWith('/') ? pathRaw : `/${pathRaw}`;

    let url;
    const rawUrl = String(event.url || '').trim();
    if (rawUrl) {
        try {
            url = new URL(rawUrl, `https://${host}`);
        } catch {
            url = new URL(`https://${host}${path}`);
        }
    } else {
        url = new URL(`https://${host}${path}`);
    }

    // YC: query часто только в queryStringParameters; event.url бывает '' или без ?
    const fromEvent = queryFromEvent(event);
    for (const [k, v] of fromEvent.entries()) {
        url.searchParams.set(k, v);
    }

    return url;
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

    let body = '';
    if (typeof response.text === 'function') {
        body = await response.text();
    } else if (response.body != null) {
        body = String(response.body);
    }

    return {
        statusCode: response.status || 200,
        headers,
        body,
    };
}

function isTimerEvent(event) {
    if (!event || typeof event !== 'object') return false;
    if (event.httpMethod || event.requestContext?.httpMethod || event.requestContext?.http) {
        return false;
    }
    if (event.queryStringParameters || event.multiValueQueryStringParameters) {
        return false;
    }
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

    if (typeof event === 'string') {
        try {
            event = JSON.parse(event);
        } catch {
            event = {};
        }
    }
    event = event || {};

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
