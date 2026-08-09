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
 *
 * KV: только .get / .put / .delete — без .list() (лимит Free Tier list = 1000/день).
 */

import { sendNotification, isExpired } from 'edgepush';

const MSK_OFFSET_SEC = 3 * 60 * 60;
const PUSH_DELIVERY_WINDOW_SEC = 240;

const GLOBAL_PUSH_JOBS_KEY = 'global_push_jobs';
const STATS_TOTAL_USERS_KEY = 'stats_total_users';

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

function statsDailyUsersKey(dailyDate) {
    return `stats_daily_users:${dailyDate}`;
}

function pushSubsIndexKey(deviceUuid) {
    return `push_subs:${deviceUuid}`;
}

async function readJsonArray(kv, key) {
    if (!kv) return [];
    const value = await kv.get(key, { type: 'json' });
    return Array.isArray(value) ? value : [];
}

async function putJsonArray(kv, key, arr, options = {}) {
    const payload = JSON.stringify(arr);
    if (options.expiration && options.expiration > Math.floor(Date.now() / 1000)) {
        await kv.put(key, payload, { expiration: options.expiration });
        return;
    }
    await kv.put(key, payload);
}

async function addUniqueUuidToIndex(kv, key, deviceUuid, options = {}) {
    const list = await readJsonArray(kv, key);
    if (list.includes(deviceUuid)) {
        return { list, changed: false };
    }
    list.push(deviceUuid);
    await putJsonArray(kv, key, list, options);
    return { list, changed: true };
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
    const dailyKey = statsDailyUsersKey(dailyDate);
    const expiration = mskEndOfTodayUnixSec();
    const nowSec = Math.floor(Date.now() / 1000);
    const dailyOpts = expiration > nowSec ? { expiration } : {};

    await addUniqueUuidToIndex(kv, dailyKey, deviceUuid, dailyOpts);
    await addUniqueUuidToIndex(kv, STATS_TOTAL_USERS_KEY, deviceUuid);

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
    const [dailyUsers, totalUsers] = await Promise.all([
        readJsonArray(kv, statsDailyUsersKey(dailyDate)),
        readJsonArray(kv, STATS_TOTAL_USERS_KEY),
    ]);
    const payload = {
        ok: true,
        date_msk: dailyDate,
        dau: dailyUsers.length,
        registered_total: totalUsers.length,
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

function isValidSubscription(subscription) {
    const endpoint = String(subscription?.endpoint || '').trim();
    return Boolean(endpoint && subscription?.keys?.p256dh && subscription?.keys?.auth);
}

async function readDeviceSubscriptions(kv, deviceUuid) {
    const items = await readJsonArray(kv, pushSubsIndexKey(deviceUuid));
    return items
        .filter((item) => isValidSubscription(item?.subscription || item))
        .map((item) => {
            const subscription = item.subscription || item;
            return {
                endpoint: String(subscription.endpoint).trim(),
                subscription: {
                    endpoint: String(subscription.endpoint).trim(),
                    keys: {
                        p256dh: String(subscription.keys.p256dh),
                        auth: String(subscription.keys.auth),
                    },
                },
            };
        });
}

async function writeDeviceSubscriptions(kv, deviceUuid, items, expiration) {
    const key = pushSubsIndexKey(deviceUuid);
    if (!items.length) {
        await kv.delete(key);
        return;
    }
    const payload = items.map((item) => ({
        endpoint: item.endpoint || item.subscription?.endpoint,
        subscription: item.subscription || {
            endpoint: item.endpoint,
            keys: item.keys,
        },
        updated_at: item.updated_at || new Date().toISOString(),
    }));
    await putJsonArray(kv, key, payload, { expiration });
}

async function removeJobsForDevice(kv, deviceUuid) {
    const allJobs = await readJsonArray(kv, GLOBAL_PUSH_JOBS_KEY);
    const next = allJobs.filter((job) => job?.device_uuid !== deviceUuid);
    if (next.length === allJobs.length) return next;
    if (!next.length) {
        await kv.delete(GLOBAL_PUSH_JOBS_KEY);
        return [];
    }
    let expiration = mskEndOfTodayUnixSec() + 2 * 86400;
    const fireAts = next.map((job) => Number(job.fireAtUnix)).filter(Number.isFinite);
    if (fireAts.length) {
        expiration = Math.max(expiration, Math.max(...fireAts) + 2 * 86400);
    }
    await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, next, { expiration });
    return next;
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

    const expiration = mskEndOfTodayUnixSec() + 90 * 86400;
    const existing = await readDeviceSubscriptions(kv, deviceUuid);
    const next = existing.filter((item) => item.endpoint !== endpoint);
    next.push({
        endpoint,
        subscription: {
            endpoint,
            keys: {
                p256dh: String(subscription.keys.p256dh),
                auth: String(subscription.keys.auth),
            },
        },
        updated_at: new Date().toISOString(),
    });
    await writeDeviceSubscriptions(kv, deviceUuid, next, expiration);

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
                device_uuid: deviceUuid,
                key,
                fireAtUnix: Math.floor(fireAtUnix),
                title: String(job?.title || '').slice(0, 180),
                kicker: String(job?.kicker || '').slice(0, 120),
                body: String(job?.body || '').slice(0, 240),
                tone: String(job?.tone || 'default').slice(0, 32),
                session_id: sessionId,
            };
        })
        .filter(Boolean);

    const existing = await readJsonArray(kv, GLOBAL_PUSH_JOBS_KEY);
    const others = existing.filter((job) => job?.device_uuid !== deviceUuid);
    const next = others.concat(sanitizedJobs);

    if (!next.length) {
        await kv.delete(GLOBAL_PUSH_JOBS_KEY);
    } else {
        let expiration = mskEndOfTodayUnixSec() + 2 * 86400;
        const fireAts = next.map((job) => Number(job.fireAtUnix)).filter(Number.isFinite);
        if (fireAts.length) {
            expiration = Math.max(expiration, Math.max(...fireAts) + 2 * 86400);
        }
        await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, next, { expiration });
    }

    // Миграция: старый per-device ключ больше не нужен
    await kv.delete(`push_jobs:${deviceUuid}`);

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
    const expiration = mskEndOfTodayUnixSec() + 90 * 86400;

    if (endpoint) {
        const existing = await readDeviceSubscriptions(kv, deviceUuid);
        const next = existing.filter((item) => item.endpoint !== endpoint);
        await writeDeviceSubscriptions(kv, deviceUuid, next, expiration);
    } else {
        await kv.delete(pushSubsIndexKey(deviceUuid));
        await removeJobsForDevice(kv, deviceUuid);
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
    const allJobs = await readJsonArray(kv, GLOBAL_PUSH_JOBS_KEY);
    if (!allJobs.length) return;

    const remaining = [];
    const subsCache = new Map();
    let dirtySubs = false;

    async function getSubs(deviceUuid) {
        if (subsCache.has(deviceUuid)) return subsCache.get(deviceUuid);
        const items = await readDeviceSubscriptions(kv, deviceUuid);
        subsCache.set(deviceUuid, items);
        return items;
    }

    for (const job of allJobs) {
        const deviceUuid = sanitizeDeviceUuid(job?.device_uuid);
        if (!deviceUuid || !job?.key || !Number.isFinite(job.fireAtUnix)) {
            continue;
        }

        // Ещё рано — оставляем в индексе
        if (job.fireAtUnix > now) {
            remaining.push(job);
            continue;
        }

        // Окно доставки истекло — выбрасываем
        if (job.fireAtUnix + PUSH_DELIVERY_WINDOW_SEC < now) {
            continue;
        }

        const sentKey = `push_sent:${job.key}`;
        if (await kv.get(sentKey)) {
            continue;
        }

        const subscriptions = await getSubs(deviceUuid);
        if (!subscriptions.length) {
            // Нет подписок: оставляем job до конца окна (клиент может успеть зарегистрировать push)
            remaining.push(job);
            continue;
        }

        const payload = {
            key: job.key,
            tag: job.key,
            title: job.title || 'Цифровой помощник',
            kicker: job.kicker || '',
            body: job.body || '',
            tone: job.tone || 'default',
        };

        let delivered = false;
        const alive = [];
        for (const item of subscriptions) {
            try {
                await sendWebPushNotification(item.subscription, payload, env);
                delivered = true;
                alive.push(item);
            } catch (error) {
                const statusCode = error?.statusCode;
                if (statusCode === 404 || statusCode === 410) {
                    dirtySubs = true;
                    continue;
                }
                alive.push(item);
            }
        }

        if (alive.length !== subscriptions.length) {
            subsCache.set(deviceUuid, alive);
            const expiration = mskEndOfTodayUnixSec() + 90 * 86400;
            await writeDeviceSubscriptions(kv, deviceUuid, alive, expiration);
        }

        if (delivered) {
            await kv.put(sentKey, '1', { expiration: job.fireAtUnix + 86400 });
            // Доставлено — не возвращаем в индекс
            continue;
        }

        // Не доставлено (временная ошибка) — оставляем до конца окна
        remaining.push(job);
    }

    if (remaining.length !== allJobs.length || dirtySubs) {
        if (!remaining.length) {
            await kv.delete(GLOBAL_PUSH_JOBS_KEY);
        } else {
            let expiration = mskEndOfTodayUnixSec() + 2 * 86400;
            const fireAts = remaining.map((job) => Number(job.fireAtUnix)).filter(Number.isFinite);
            if (fireAts.length) {
                expiration = Math.max(expiration, Math.max(...fireAts) + 2 * 86400);
            }
            await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, remaining, { expiration });
        }
    }
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
