/**
 * Cloudflare Worker — прокси Яндекс.Rasp + KV-кэш + метрики использования (DAU / регистрации) + Web Push.
 *
 * Bindings: env.CACHE_KV → TRAIN_CACHE, env.STATS_SECRET → секрет /stats
 *
 * Эндпоинты:
 *   GET ?url=…              — прокси Яндекс API + KV-кэш расписаний
 *   GET ?ping=1&device_uuid= — учёт DAU и регистрации (анонимно)
 *   GET /stats?secret=…     — статистика (HTML или ?format=json)
 *   POST ?register_push=1&device_uuid= — регистрация Web Push subscription
 *   POST ?sync_alerts=1&device_uuid=   — синхронизация push-алертов смены
 *   POST ?unregister_push=1&device_uuid=
 *
 * Cron (* * * * *): отправка просроченных push-алертов через Web Push Protocol.
 */

import { sendNotification, isExpired } from 'edgepush';

const MSK_OFFSET_SEC = 3 * 60 * 60;
const PUSH_DELIVERY_WINDOW_SEC = 240;

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

function corsResponse(body, status = 200, extraHeaders = {}) {
    const headers = new Headers({ ...CORS_HEADERS, ...extraHeaders });
    return new Response(body, { status, headers });
}

function getMskDateString(now = new Date()) {
    const mskMs = now.getTime() + MSK_OFFSET_SEC * 1000;
    const d = new Date(mskMs);
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}

function getMskDailyKeyDate(now = new Date()) {
    return getMskDateString(now).replace(/-/g, '_');
}

function addDaysToIsoDate(isoDate, days) {
    const [y, m, d] = isoDate.split('-').map(Number);
    const nd = new Date(Date.UTC(y, m - 1, d + days));
    const ny = nd.getUTCFullYear();
    const nm = String(nd.getUTCMonth() + 1).padStart(2, '0');
    const nday = String(nd.getUTCDate()).padStart(2, '0');
    return `${ny}-${nm}-${nday}`;
}

/** 00:00:00 MSK на календарную дату isoDate → Unix seconds */
function mskMidnightUnixSec(isoDate) {
    const [y, m, d] = isoDate.split('-').map(Number);
    return Math.floor(Date.UTC(y, m - 1, d, -3, 0, 0) / 1000);
}

/** Конец текущих суток MSK = полночь следующего дня MSK */
function mskEndOfTodayUnixSec(now = new Date()) {
    const today = getMskDateString(now);
    const tomorrow = addDaysToIsoDate(today, 1);
    return mskMidnightUnixSec(tomorrow);
}

function extractScheduleDateFromYandexUrl(targetUrl) {
    try {
        const u = new URL(targetUrl);
        const date = u.searchParams.get('date');
        if (date && /^\d{4}-\d{2}-\d{2}$/.test(date)) return date;
    } catch {
        /* ignore */
    }
    return getMskDateString();
}

function computeKvExpirationSec(targetUrl) {
    const d = extractScheduleDateFromYandexUrl(targetUrl);
    const expireDate = addDaysToIsoDate(d, 2);
    return mskMidnightUnixSec(expireDate);
}

function cacheKeyForUrl(targetUrl) {
    return `yandex:${targetUrl}`;
}

function isAllowedYandexHost(hostname) {
    return hostname === 'api.rasp.yandex.net' || hostname.endsWith('.rasp.yandex.net');
}

function sanitizeDeviceUuid(raw) {
    const uuid = String(raw || '').trim();
    if (!uuid || uuid.length > 64) return null;
    if (!/^[a-zA-Z0-9_-]+$/.test(uuid)) return null;
    return uuid;
}

async function countKeysByPrefix(kv, prefix) {
    if (!kv) return 0;
    let cursor;
    let count = 0;
    do {
        const result = await kv.list({ prefix, cursor });
        count += (result.keys || []).length;
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    return count;
}

async function handleUsagePing(reqUrl, env) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return corsResponse(JSON.stringify({ ok: false, error: 'KV not configured' }), 503, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const deviceUuid = sanitizeDeviceUuid(reqUrl.searchParams.get('device_uuid'));
    if (!deviceUuid) {
        return corsResponse(JSON.stringify({ ok: false, error: 'device_uuid required' }), 400, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const dailyDate = getMskDailyKeyDate();
    const dailyKey = `user_daily:${dailyDate}:${deviceUuid}`;
    const registeredKey = `user_registered:${deviceUuid}`;
    const expiration = mskEndOfTodayUnixSec();
    const nowSec = Math.floor(Date.now() / 1000);
    const meta = '1';

    if (expiration > nowSec) {
        await kv.put(dailyKey, meta, { expiration });
    } else {
        await kv.put(dailyKey, meta);
    }
    await kv.put(registeredKey, meta);

    return corsResponse(JSON.stringify({
        ok: true,
        device_uuid: deviceUuid,
        daily_key: dailyKey,
        date_msk: dailyDate,
    }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
    });
}

function renderStatsHtml(stats) {
    return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Цифровой помощник — статистика</title>
<style>
  body { font-family: system-ui, sans-serif; background: #1a1f24; color: #e8ecf0; margin: 0; padding: 24px; }
  .wrap { max-width: 420px; margin: 0 auto; }
  h1 { font-size: 1.25rem; font-weight: 600; margin: 0 0 8px; }
  .sub { color: #9aa3ad; font-size: 0.875rem; margin-bottom: 24px; }
  .card { background: #252b32; border-radius: 12px; padding: 20px; margin-bottom: 12px; }
  .label { font-size: 0.8rem; color: #9aa3ad; text-transform: uppercase; letter-spacing: 0.04em; }
  .value { font-size: 2.5rem; font-weight: 700; margin-top: 4px; color: #7dd3a8; }
  .foot { font-size: 0.75rem; color: #6b7280; margin-top: 24px; }
  a { color: #7eb8ff; }
</style>
</head>
<body>
<div class="wrap">
  <h1>Цифровой помощник</h1>
  <p class="sub">Метрики использования · MSK ${stats.date_msk.replace(/_/g, '.')}</p>
  <div class="card">
    <div class="label">Активные сегодня (DAU)</div>
    <div class="value">${stats.dau}</div>
  </div>
  <div class="card">
    <div class="label">Всего зарегистрировано</div>
    <div class="value">${stats.registered_total}</div>
  </div>
  <p class="foot">Обновлено: ${stats.generated_at} · <a href="?secret=${encodeURIComponent(stats.secret)}&format=json">JSON</a></p>
</div>
</body>
</html>`;
}

async function handleStats(reqUrl, env) {
    const secret = reqUrl.searchParams.get('secret') || '';
    const expected = String(env.STATS_SECRET || '').trim();
    if (!expected || secret !== expected) {
        return corsResponse('Forbidden', 403);
    }

    const kv = env.CACHE_KV;
    if (!kv) {
        return corsResponse(JSON.stringify({ ok: false, error: 'KV not configured' }), 503, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const dailyDate = getMskDailyKeyDate();
    const dau = await countKeysByPrefix(kv, `user_daily:${dailyDate}:`);
    const registeredTotal = await countKeysByPrefix(kv, 'user_registered:');
    const payload = {
        ok: true,
        date_msk: dailyDate,
        dau,
        registered_total: registeredTotal,
        generated_at: new Date().toISOString(),
    };

    if (reqUrl.searchParams.get('format') === 'json') {
        return corsResponse(JSON.stringify(payload), 200, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    return new Response(renderStatsHtml({ ...payload, secret }), {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
}

async function handleYandexProxy(request, reqUrl, env) {
    const targetUrl = reqUrl.searchParams.get('url');
    if (!targetUrl) {
        return corsResponse('Missing url parameter', 400);
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
    } catch {
        return corsResponse('Invalid url parameter', 400);
    }

    if (!isAllowedYandexHost(parsed.hostname)) {
        return corsResponse('Forbidden target host', 403);
    }

    const key = cacheKeyForUrl(targetUrl);
    const kv = env.CACHE_KV;

    if (kv) {
        const cached = await kv.get(key);
        if (cached !== null) {
            return corsResponse(cached, 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Cache-Status': 'HIT_WORKER_KV',
            });
        }
    }

    const upstream = await fetch(targetUrl, {
        method: request.method,
        headers: { Accept: 'application/json' },
    });

    const body = await upstream.text();
    const contentType = upstream.headers.get('Content-Type') || 'application/json; charset=utf-8';

    if (upstream.status === 200 && kv) {
        const expiration = computeKvExpirationSec(targetUrl);
        const nowSec = Math.floor(Date.now() / 1000);
        if (expiration > nowSec) {
            await kv.put(key, body, { expiration });
        }
    }

    const cacheHeader = upstream.status === 200 ? 'MISS_YANDEX_API' : 'BYPASS';
    return corsResponse(body, upstream.status, {
        'Content-Type': contentType,
        'X-Cache-Status': cacheHeader,
    });
}

function getVapidConfig(env) {
    const publicKey = String(env.VAPID_PUBLIC_KEY || '').trim();
    const privateKey = String(env.VAPID_PRIVATE_KEY || '').trim();
    const subject = String(env.VAPID_SUBJECT || 'mailto:support@cppk.local').trim();
    if (!publicKey || !privateKey) return null;
    return { publicKey, privateKey, subject };
}

async function sendWebPushNotification(subscription, payload, env) {
    const vapid = getVapidConfig(env);
    if (!vapid) {
        throw new Error('VAPID not configured');
    }

    const result = await sendNotification(
        subscription,
        JSON.stringify(payload),
        {
            vapid,
            ttl: 86400,
            urgency: 'high',
        }
    );

    if (isExpired(result.status)) {
        const error = new Error(`Push subscription expired (${result.status})`);
        error.statusCode = result.status;
        throw error;
    }

    if (result.status < 200 || result.status >= 300) {
        const error = new Error(`Push failed (${result.status})`);
        error.statusCode = result.status;
        throw error;
    }
}

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

function subscriptionKvKey(deviceUuid, endpoint) {
    const endpointTail = String(endpoint || '').slice(-48).replace(/[^a-zA-Z0-9]/g, '_') || 'unknown';
    return `push_sub:${deviceUuid}:${endpointTail}`;
}

async function listSubscriptionsForDevice(kv, deviceUuid) {
    const prefix = `push_sub:${deviceUuid}:`;
    let cursor;
    const items = [];
    do {
        const result = await kv.list({ prefix, cursor });
        for (const key of result.keys || []) {
            const raw = await kv.get(key.name);
            if (!raw) continue;
            try {
                const parsed = JSON.parse(raw);
                if (parsed?.subscription?.endpoint) {
                    items.push({ kvKey: key.name, subscription: parsed.subscription });
                }
            } catch {
                /* ignore */
            }
        }
        cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    return items;
}

async function handleRegisterPush(request, reqUrl, env) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return corsResponse(JSON.stringify({ ok: false, error: 'KV not configured' }), 503, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const deviceUuid = sanitizeDeviceUuid(reqUrl.searchParams.get('device_uuid'));
    if (!deviceUuid) {
        return corsResponse(JSON.stringify({ ok: false, error: 'device_uuid required' }), 400, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const body = await readJsonBody(request);
    const subscription = body?.subscription || body;
    const endpoint = String(subscription?.endpoint || '').trim();
    if (!endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
        return corsResponse(JSON.stringify({ ok: false, error: 'invalid subscription' }), 400, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const key = subscriptionKvKey(deviceUuid, endpoint);
    const expiration = mskEndOfTodayUnixSec() + 90 * 86400;

    await kv.put(key, JSON.stringify({
        device_uuid: deviceUuid,
        subscription,
        updated_at: new Date().toISOString(),
    }), { expiration });

    return corsResponse(JSON.stringify({ ok: true, device_uuid: deviceUuid }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
    });
}

async function handleSyncAlerts(request, reqUrl, env) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return corsResponse(JSON.stringify({ ok: false, error: 'KV not configured' }), 503, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const deviceUuid = sanitizeDeviceUuid(reqUrl.searchParams.get('device_uuid'));
    if (!deviceUuid) {
        return corsResponse(JSON.stringify({ ok: false, error: 'device_uuid required' }), 400, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const body = await readJsonBody(request);
    const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
    const sessionId = String(reqUrl.searchParams.get('session_id') || body?.session_id || '').trim().slice(0, 256);
    const sanitizedJobs = jobs
        .map((job) => {
            const key = String(job?.key || '').trim().slice(0, 128);
            const fireAtUnix = Number(job?.fireAtUnix);
            if (!key || !Number.isFinite(fireAtUnix)) return null;
            return {
                key,
                fireAtUnix: Math.floor(fireAtUnix),
                title: String(job?.title || '').slice(0, 180),
                kicker: String(job?.kicker || '').slice(0, 120),
                body: String(job?.body || '').slice(0, 240),
                tone: String(job?.tone || 'default').slice(0, 32),
            };
        })
        .filter(Boolean);

    const jobsKey = `push_jobs:${deviceUuid}`;
    let expiration = mskEndOfTodayUnixSec() + 2 * 86400;
    if (sanitizedJobs.length) {
        const maxFireAt = Math.max(...sanitizedJobs.map((job) => job.fireAtUnix));
        expiration = Math.max(expiration, maxFireAt + 2 * 86400);
    }

    await kv.put(jobsKey, JSON.stringify({
        session_id: sessionId,
        updated_at: new Date().toISOString(),
        jobs: sanitizedJobs,
    }), { expiration });

    return corsResponse(JSON.stringify({
        ok: true,
        device_uuid: deviceUuid,
        jobs_count: sanitizedJobs.length,
    }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
    });
}

async function handleUnregisterPush(request, reqUrl, env) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return corsResponse(JSON.stringify({ ok: false, error: 'KV not configured' }), 503, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const deviceUuid = sanitizeDeviceUuid(reqUrl.searchParams.get('device_uuid'));
    if (!deviceUuid) {
        return corsResponse(JSON.stringify({ ok: false, error: 'device_uuid required' }), 400, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const body = await readJsonBody(request);
    const endpoint = String(body?.endpoint || body?.subscription?.endpoint || '').trim();
    if (endpoint) {
        await kv.delete(subscriptionKvKey(deviceUuid, endpoint));
    } else {
        const prefix = `push_sub:${deviceUuid}:`;
        let cursor;
        do {
            const result = await kv.list({ prefix, cursor });
            await Promise.all((result.keys || []).map((key) => kv.delete(key.name)));
            cursor = result.list_complete ? undefined : result.cursor;
        } while (cursor);
        await kv.delete(`push_jobs:${deviceUuid}`);
    }

    return corsResponse(JSON.stringify({ ok: true, device_uuid: deviceUuid }), 200, {
        'Content-Type': 'application/json; charset=utf-8',
    });
}

async function processScheduledPushes(env) {
    const kv = env.CACHE_KV;
    if (!kv || !getVapidConfig(env)) return;

    const now = Math.floor(Date.now() / 1000);
    let cursor;

    do {
        const list = await kv.list({ prefix: 'push_jobs:', cursor });
        for (const keyInfo of list.keys || []) {
            const deviceUuid = keyInfo.name.slice('push_jobs:'.length);
            if (!deviceUuid) continue;

            const raw = await kv.get(keyInfo.name);
            if (!raw) continue;

            let data;
            try {
                data = JSON.parse(raw);
            } catch {
                continue;
            }

            const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
            if (!jobs.length) continue;

            const subscriptions = await listSubscriptionsForDevice(kv, deviceUuid);
            if (!subscriptions.length) continue;

            for (const job of jobs) {
                if (!job?.key || !Number.isFinite(job.fireAtUnix)) continue;
                if (job.fireAtUnix > now) continue;
                if (job.fireAtUnix + PUSH_DELIVERY_WINDOW_SEC < now) continue;

                const sentKey = `push_sent:${job.key}`;
                if (await kv.get(sentKey)) continue;

                const payload = {
                    key: job.key,
                    tag: job.key,
                    title: job.title || 'Цифровой помощник',
                    kicker: job.kicker || '',
                    body: job.body || '',
                    tone: job.tone || 'default',
                };

                let delivered = false;
                for (const item of subscriptions) {
                    try {
                        await sendWebPushNotification(item.subscription, payload, env);
                        delivered = true;
                    } catch (error) {
                        const statusCode = error?.statusCode;
                        if (statusCode === 404 || statusCode === 410) {
                            await kv.delete(item.kvKey);
                        }
                    }
                }

                if (delivered) {
                    await kv.put(sentKey, '1', { expiration: job.fireAtUnix + 86400 });
                }
            }
        }
        cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);
}

export default {
    async fetch(request, env) {
        if (request.method === 'OPTIONS') {
            return corsResponse(null, 204);
        }

        const reqUrl = new URL(request.url);
        const path = reqUrl.pathname.replace(/\/+$/, '') || '/';

        if (request.method === 'POST') {
            if (reqUrl.searchParams.get('register_push') === '1') {
                return handleRegisterPush(request, reqUrl, env);
            }
            if (reqUrl.searchParams.get('sync_alerts') === '1') {
                return handleSyncAlerts(request, reqUrl, env);
            }
            if (reqUrl.searchParams.get('unregister_push') === '1') {
                return handleUnregisterPush(request, reqUrl, env);
            }
            return corsResponse('Method Not Allowed', 405);
        }

        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return corsResponse('Method Not Allowed', 405);
        }

        if (path === '/stats') {
            return handleStats(reqUrl, env);
        }

        if (reqUrl.searchParams.get('ping') === '1') {
            return handleUsagePing(reqUrl, env);
        }

        return handleYandexProxy(request, reqUrl, env);
    },

    async scheduled(event, env) {
        await processScheduledPushes(env);
    },
};
