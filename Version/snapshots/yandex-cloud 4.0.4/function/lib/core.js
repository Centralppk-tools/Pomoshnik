/**
 * Yandex Cloud Function (ported from Cloudflare Worker) — прокси Яндекс.Rasp + KV-кэш + метрики использования (DAU / регистрации) + Web Push.
 *
 * env.CACHE_KV → Object Storage / MemoryStore; secrets from process.env, env.STATS_SECRET → секрет /stats
 *
 * Эндпоинты:
 *   GET ?board=1&date=YYYY-MM-DD — табло из KV; при промахе (дата >= сегодня MSK) — on-demand заливка с Яндекса
 *   GET ?preload_boards=1&secret= — ночной прогон (4 даты) или одна дата: &date=YYYY-MM-DD (>= сегодня)
 *   GET ?url=…              — прокси Яндекс API + KV (нити / Пушкино; не табло Ярославского)
 *   GET ?ping=1&device_uuid= — учёт DAU и регистрации (анонимно)
 *   GET /stats?secret=…     — статистика (HTML или ?format=json)
 *   POST ?register_push=1&device_uuid= — регистрация Web Push subscription
 *   POST ?sync_alerts=1&device_uuid=   — синхронизация push-алертов смены
 *   POST ?unregister_push=1&device_uuid=
 *
 * Cron (* * * * *): отправка просроченных push-алертов через Web Push Protocol.
 * Cron (5 21 * * * UTC = 00:05 MSK): табло на 4 даты (сегодня, +1, +2, +6).
 *
 * KV: только .get / .put / .delete — без .list() (лимит Free Tier list = 1000/день).
 * Пуш-джобы: без delete, только put + expirationTtl; одинаковый набор алертов — без put.
 */

const { sendNotification, isExpired } = require('./webpush-send');
const { handleAppApi } = require('./app-api');
const { assertClientAccess, optionsResponse, corsHeadersFor } = require('./client-gate');

const MSK_OFFSET_SEC = 3 * 60 * 60;
const PUSH_DELIVERY_WINDOW_SEC = 240;

const GLOBAL_PUSH_JOBS_KEY = 'global_push_jobs';
const STATS_TOTAL_USERS_KEY = 'stats_total_users';
const BOARD_STATION = 's2000002';
const BOARD_META_KEY = 'board:meta';
const BOARD_CRON = '5 21 * * *';
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Повтор on-demand /schedule/ после пустого ответа или ошибки */
const BOARD_MISS_COOLDOWN_SEC = 300;
/** Блокировка параллельной заливки одной даты */
const BOARD_FETCH_LOCK_SEC = 120;

/** CORS по умолчанию (без Origin — для secret-bypass / ошибок без известного origin) */
const CORS_HEADERS = corsHeadersFor('*');

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

function boardKvKey(date) {
    return `board:${BOARD_STATION}:${date}`;
}

function isIsoDate(value) {
    return ISO_DATE_RE.test(String(value || ''));
}

function formatRuIso(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return String(iso || '');
    return `${m[3]}.${m[2]}.${m[1]}`;
}

function collectBoardPreloadDates(now = new Date()) {
    const today = getMskDateString(now);
    return [
        today,
        addDaysToIsoDate(today, 1),
        addDaysToIsoDate(today, 2),
        addDaysToIsoDate(today, 6),
    ];
}

function isBoardOnDemandEligible(date, today) {
    return isIsoDate(date) && date >= today;
}

function boardMissKey(date) {
    return `board:miss:${date}`;
}

function boardFetchLockKey(date) {
    return `board:lock:${date}`;
}

function computeBoardRetryAfter(date, today) {
    if (date < today) {
        return null;
    }
    const horizonEnd = addDaysToIsoDate(today, 6);
    if (date > horizonEnd) {
        return addDaysToIsoDate(date, -6);
    }
    const tonight = [
        today,
        addDaysToIsoDate(today, 1),
        addDaysToIsoDate(today, 2),
        addDaysToIsoDate(today, 6),
    ];
    if (tonight.includes(date)) {
        return addDaysToIsoDate(today, 1);
    }
    return addDaysToIsoDate(date, -2);
}

function buildBoardNotReadyPayload(date, meta, today) {
    const known = Object.keys(meta?.dates || {}).filter(isIsoDate).sort();
    const availableUntil = known.length ? known[known.length - 1] : null;
    const retryAfterDate = computeBoardRetryAfter(date, today);
    const horizonEnd = addDaysToIsoDate(today, 6);
    let message;
    if (date < today) {
        message = `Табло на прошедшую дату (${formatRuIso(date)}) не хранится. Выберите сегодня или будущий день.`;
    } else if (date > horizonEnd) {
        message = `Пока есть расписание только до ${formatRuIso(availableUntil || horizonEnd)}. Этот день появится ${formatRuIso(retryAfterDate)}.`;
    } else if (retryAfterDate) {
        message = `Расписание на эту дату ещё готовится. Актуальное табло — на ближайшие три дня. Зайдите после ${formatRuIso(retryAfterDate)} (обычно после полуночи).`;
    } else {
        message = 'Расписание на эту дату ещё готовится.';
    }
    return {
        ok: false,
        code: 'BOARD_NOT_READY',
        date,
        availableUntil,
        retryAfterDate,
        message,
    };
}

function isYaroslavlScheduleUrl(parsed) {
    if (!parsed || !String(parsed.pathname || '').includes('/schedule/')) return false;
    return parsed.searchParams.get('station') === BOARD_STATION;
}

async function readBoardMeta(kv) {
    if (!kv) return { dates: {} };
    const raw = await kv.get(BOARD_META_KEY, { type: 'json' });
    if (!raw || typeof raw !== 'object') return { dates: {} };
    const dates = raw.dates && typeof raw.dates === 'object' && !Array.isArray(raw.dates)
        ? raw.dates
        : {};
    return { dates };
}

async function fetchYaroslavlBoardDay(date, env) {
    const apiKey = String(env.YANDEX_API_KEY || '').trim();
    if (!apiKey) {
        throw new Error('YANDEX_API_KEY not configured');
    }

    const all = [];
    let offset = 0;
    let pageCount = 0;
    const limit = 1000;

    while (offset <= 8000) {
        const url = `https://api.rasp.yandex.net/v3.0/schedule/?apikey=${encodeURIComponent(apiKey)}&station=${BOARD_STATION}&transport_types=suburban&direction=all&limit=${limit}&offset=${offset}&date=${date}&lang=ru_RU`;
        const res = await fetch(url, { headers: { Accept: 'application/json' } });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || data.error) {
            const errText = typeof data.error === 'string'
                ? data.error
                : (data.error?.text || `HTTP ${res.status}`);
            throw new Error(`${date}: ${errText}`);
        }
        const batch = Array.isArray(data.schedule) ? data.schedule : [];
        all.push(...batch);
        pageCount += 1;
        if (batch.length < limit) break;
        offset += limit;
    }

    return { schedule: all, pageCount };
}

async function writeBoardMeta(kv, meta, today) {
    const known = Object.keys(meta.dates || {}).filter(isIsoDate).sort();
    const maxDate = known.length ? known[known.length - 1] : addDaysToIsoDate(today, 6);
    const metaExpiration = mskMidnightUnixSec(addDaysToIsoDate(maxDate, 2));
    const nowSec = Math.floor(Date.now() / 1000);
    const metaBody = JSON.stringify({ dates: meta.dates, updatedAt: new Date().toISOString() });
    if (metaExpiration > nowSec) {
        await kv.put(BOARD_META_KEY, metaBody, { expiration: metaExpiration });
    } else {
        await kv.put(BOARD_META_KEY, metaBody);
    }
}

async function persistBoardDay(kv, date, schedule, pageCount, meta) {
    const fetchedAt = new Date().toISOString();
    const payload = {
        date,
        station: BOARD_STATION,
        fetchedAt,
        pageCount,
        schedule,
    };
    const expiration = mskMidnightUnixSec(addDaysToIsoDate(date, 2));
    const nowSec = Math.floor(Date.now() / 1000);
    if (expiration > nowSec) {
        await kv.put(boardKvKey(date), JSON.stringify(payload), { expiration });
    } else {
        await kv.put(boardKvKey(date), JSON.stringify(payload));
    }
    meta.dates[date] = { fetchedAt, pageCount, rows: schedule.length };
    return payload;
}

async function fetchAndPersistBoardDay(date, env, meta) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return { ok: false, error: 'KV not configured' };
    }
    try {
        const { schedule, pageCount } = await fetchYaroslavlBoardDay(date, env);
        if (!schedule.length) {
            return { date, ok: false, error: 'empty schedule', pageCount };
        }
        const payload = await persistBoardDay(kv, date, schedule, pageCount, meta);
        return { date, ok: true, pageCount, rows: schedule.length, payload };
    } catch (err) {
        return { date, ok: false, error: err.message || String(err) };
    }
}

/**
 * On-demand заливка одной даты при ?board=1, если ключ пуст и date >= сегодня MSK.
 * Прошлые даты не трогаем. Cooldown после пустого/ошибочного ответа — BOARD_MISS_COOLDOWN_SEC.
 */
async function tryOnDemandBoardFill(date, today, env) {
    if (!isBoardOnDemandEligible(date, today)) {
        return null;
    }

    const kv = env.CACHE_KV;
    if (!kv) return null;

    if (await kv.get(boardMissKey(date))) {
        return null;
    }

    if (await kv.get(boardFetchLockKey(date))) {
        const cached = await kv.get(boardKvKey(date), { type: 'json' });
        if (cached && Array.isArray(cached.schedule) && cached.schedule.length) {
            return cached;
        }
        return null;
    }

    await kv.put(boardFetchLockKey(date), '1', { expirationTtl: BOARD_FETCH_LOCK_SEC });

    try {
        const meta = await readBoardMeta(kv);
        const result = await fetchAndPersistBoardDay(date, env, meta);
        if (result.ok && result.payload) {
            await writeBoardMeta(kv, meta, today);
            await kv.delete(boardMissKey(date)).catch(() => {});
            return result.payload;
        }
        await kv.put(boardMissKey(date), '1', { expirationTtl: BOARD_MISS_COOLDOWN_SEC });
        return null;
    } catch (err) {
        await kv.put(boardMissKey(date), '1', { expirationTtl: BOARD_MISS_COOLDOWN_SEC });
        console.warn('[board] on-demand fill failed:', date, err.message || err);
        return null;
    } finally {
        await kv.delete(boardFetchLockKey(date)).catch(() => {});
    }
}

async function runBoardPreload(env, dates = null) {
    const kv = env.CACHE_KV;
    if (!kv) {
        return { ok: false, error: 'KV not configured', dates: [] };
    }

    const today = getMskDateString();
    const targetDates = Array.isArray(dates) && dates.length
        ? dates.filter((d) => isIsoDate(d) && d >= today)
        : collectBoardPreloadDates();
    const meta = await readBoardMeta(kv);
    const results = [];

    for (const date of targetDates) {
        const result = await fetchAndPersistBoardDay(date, env, meta);
        results.push(result);
    }

    if (results.some((r) => r.ok)) {
        await writeBoardMeta(kv, meta, today);
    }

    return { ok: true, today, dates: results };
}

async function handleGetBoard(reqUrl, env) {
    const date = String(reqUrl.searchParams.get('date') || '').trim();
    const today = getMskDateString();
    const kv = env.CACHE_KV;

    if (!isIsoDate(date)) {
        return corsResponse(JSON.stringify({
            ok: false,
            code: 'BOARD_BAD_DATE',
            message: 'Нужна дата YYYY-MM-DD',
        }), 400, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    if (!kv) {
        return corsResponse(JSON.stringify({
            ok: false,
            code: 'BOARD_NO_KV',
            message: 'KV не настроен',
        }), 503, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    const cached = await kv.get(boardKvKey(date), { type: 'json' });
    if (cached && Array.isArray(cached.schedule) && cached.schedule.length) {
        return corsResponse(JSON.stringify(cached), 200, {
            'Content-Type': 'application/json; charset=utf-8',
            'X-Cache-Status': 'HIT_WORKER_KV',
        });
    }

    if (isBoardOnDemandEligible(date, today)) {
        const filled = await tryOnDemandBoardFill(date, today, env);
        if (filled && Array.isArray(filled.schedule) && filled.schedule.length) {
            return corsResponse(JSON.stringify(filled), 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Cache-Status': 'MISS_ON_DEMAND_YANDEX',
            });
        }
    }

    const meta = await readBoardMeta(kv);
    return corsResponse(JSON.stringify(buildBoardNotReadyPayload(date, meta, today)), 404, {
        'Content-Type': 'application/json; charset=utf-8',
        'X-Cache-Status': 'BOARD_NOT_READY',
    });
}

async function handlePreloadBoards(reqUrl, env) {
    const secret = reqUrl.searchParams.get('secret') || '';
    const expected = String(env.STATS_SECRET || '').trim();
    if (!expected || secret !== expected) {
        return corsResponse('Forbidden', 403);
    }

    const today = getMskDateString();
    const dateParam = String(reqUrl.searchParams.get('date') || '').trim();
    let dates = null;
    if (dateParam) {
        if (!isIsoDate(dateParam)) {
            return corsResponse(JSON.stringify({
                ok: false,
                error: 'invalid date',
                message: 'Нужна дата YYYY-MM-DD',
            }), 400, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        if (dateParam < today) {
            return corsResponse(JSON.stringify({
                ok: false,
                error: 'past date',
                message: 'Заливка только для сегодня и будущих дат',
            }), 400, { 'Content-Type': 'application/json; charset=utf-8' });
        }
        dates = [dateParam];
    }

    const result = await runBoardPreload(env, dates);
    const slim = {
        ...result,
        dates: Array.isArray(result.dates)
            ? result.dates.map(({ payload, ...rest }) => rest)
            : result.dates,
    };
    return corsResponse(JSON.stringify(slim), result.ok ? 200 : 503, {
        'Content-Type': 'application/json; charset=utf-8',
    });
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

function toExpirationTtl(expirationUnix) {
    const ttl = Math.floor(Number(expirationUnix) - Math.floor(Date.now() / 1000));
    return Number.isFinite(ttl) ? ttl : 0;
}

async function putJsonArray(kv, key, arr, options = {}) {
    const payload = JSON.stringify(arr);
    let ttl = Number(options.expirationTtl);
    if (!Number.isFinite(ttl) || ttl <= 0) {
        ttl = toExpirationTtl(options.expiration);
    }
    if (ttl >= 60) {
        await kv.put(key, payload, { expirationTtl: ttl });
        return;
    }
    await kv.put(key, payload);
}

function pushJobsKvOptions(jobs) {
    let expiration = mskEndOfTodayUnixSec() + 2 * 86400;
    const fireAts = (jobs || []).map((job) => Number(job.fireAtUnix)).filter(Number.isFinite);
    if (fireAts.length) {
        expiration = Math.max(expiration, Math.max(...fireAts) + 2 * 86400);
    }
    return { expiration };
}

function deviceAlertsFingerprint(jobs) {
    return (jobs || [])
        .map((job) => `${String(job?.key || '')}\t${String(job?.fireAtUnix || '')}`)
        .sort()
        .join('\n');
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

    if (isYaroslavlScheduleUrl(parsed)) {
        const date = parsed.searchParams.get('date') || '';
        return corsResponse(JSON.stringify({
            ok: false,
            code: 'USE_BOARD_API',
            message: 'Табло Ярославского только через ?board=1&date=',
            date,
        }), 400, { 'Content-Type': 'application/json; charset=utf-8' });
    }

    const key = cacheKeyForUrl(targetUrl);
    const kv = env.CACHE_KV;

    const apiKey = String(env.YANDEX_API_KEY || '').trim();
    let upstreamUrl = targetUrl;
    if (apiKey) {
        try {
            const u = new URL(targetUrl);
            u.searchParams.set('apikey', apiKey);
            upstreamUrl = u.toString();
        } catch {
            /* keep original */
        }
    }

    if (kv) {
        const cached = await kv.get(key);
        if (cached !== null) {
            return corsResponse(cached, 200, {
                'Content-Type': 'application/json; charset=utf-8',
                'X-Cache-Status': 'HIT_WORKER_KV',
            });
        }
    }

    const upstream = await fetch(upstreamUrl, {
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
    await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, next, pushJobsKvOptions(next));
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
    const existingForDevice = existing.filter((job) => job?.device_uuid === deviceUuid);
    if (deviceAlertsFingerprint(existingForDevice) === deviceAlertsFingerprint(sanitizedJobs)) {
        return corsResponse(JSON.stringify({
            ok: true,
            unchanged: true,
            device_uuid: deviceUuid,
            jobs_count: sanitizedJobs.length,
        }), 200, {
            'Content-Type': 'application/json; charset=utf-8',
        });
    }

    const others = existing.filter((job) => job?.device_uuid !== deviceUuid);
    const next = others.concat(sanitizedJobs);
    await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, next, pushJobsKvOptions(next));

    return corsResponse(JSON.stringify({
        ok: true,
        unchanged: false,
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
        await putJsonArray(kv, GLOBAL_PUSH_JOBS_KEY, remaining, pushJobsKvOptions(remaining));
    }
}

module.exports = {
    async handleRequest(request, env) {
        if (request.method === 'OPTIONS') {
            return optionsResponse(request, env);
        }

        const reqUrl = new URL(request.url);
        const path = reqUrl.pathname.replace(/\/+$/, '') || '/';

        const gate = assertClientAccess(request, reqUrl, env);
        if (!gate.ok) return gate.response;

        const appApiResponse = await handleAppApi(request, reqUrl, { origin: gate.origin });
        if (appApiResponse) return appApiResponse;

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

        if (reqUrl.searchParams.get('board') === '1') {
            return handleGetBoard(reqUrl, env);
        }

        if (reqUrl.searchParams.get('preload_boards') === '1') {
            return handlePreloadBoards(reqUrl, env);
        }

        if (reqUrl.searchParams.get('run_push') === '1') {
            const secret = reqUrl.searchParams.get('secret') || '';
            const expected = String(env.STATS_SECRET || '').trim();
            if (!expected || secret !== expected) {
                return corsResponse('Forbidden', 403);
            }
            await processScheduledPushes(env);
            return corsResponse(JSON.stringify({ ok: true }), 200, {
                'Content-Type': 'application/json; charset=utf-8',
            });
        }

        return handleYandexProxy(request, reqUrl, env);
    },

    async scheduled(event, env) {
        if (event?.cron === BOARD_CRON) {
            await runBoardPreload(env);
            return;
        }
        await processScheduledPushes(env);
    },
};
