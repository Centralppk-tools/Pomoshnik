// Service Worker v5.3.6 da_v5_3_6k (network-first shell + query-aware cache)
const CACHE_NAME = 'da_v5_3_6p';
const NAVIGATE_NETWORK_TIMEOUT_MS = 2800;
const CRITICAL_MODULE_NETWORK_TIMEOUT_MS = 3000;
const APP_SHELL_NETWORK_TIMEOUT_MS = 1200;
const SHEDULE_MAX_NETWORK_TIMEOUT_MS = 3000;
const PRECACHE_BUDGET_MS = 4500;
const ASSET_CACHE_BUST = '5.3.6p';
const NOTIFICATION_ICON = './assets/app-icon.png';

const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    `./styles/tokens.css?v=${ASSET_CACHE_BUST}`,
    `./styles/base.css?v=${ASSET_CACHE_BUST}`,
    `./styles/routes.css?v=${ASSET_CACHE_BUST}`,
    `./styles/schedule.css?v=${ASSET_CACHE_BUST}`,
    `./styles/calendar.css?v=${ASSET_CACHE_BUST}`,
    `./styles/profile.css?v=${ASSET_CACHE_BUST}`,
    `./styles/responsive.css?v=${ASSET_CACHE_BUST}`,
    `./styles/auth.css?v=${ASSET_CACHE_BUST}`,
    `./styles/community.css?v=${ASSET_CACHE_BUST}`,
    `./styles/instructions.css?v=${ASSET_CACHE_BUST}`,
    `./styles/da-loading.css?v=${ASSET_CACHE_BUST}`,
    `./styles/subscription.css?v=${ASSET_CACHE_BUST}`,
    './data/trains-uids.json',
    './data/release-notes.json',
    `./js/app-config.js?v=${ASSET_CACHE_BUST}`,
    `./js/sync-user-id.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-auth-session.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-loading.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-reference-cache.js?v=${ASSET_CACHE_BUST}`,
    `./js/crew-api-client.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-legal-consent.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-auth-terms-gate.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-subscription.js?v=${ASSET_CACHE_BUST}`,
    `./js/schedule-maintenance.js?v=${ASSET_CACHE_BUST}`,
    `./js/hard-reset-app.js?v=${ASSET_CACHE_BUST}`,
    `./js/app-data-source.js?v=${ASSET_CACHE_BUST}`,
    `./js/shedule-max-source.js?v=${ASSET_CACHE_BUST}`,
    `./js/info-chip.js?v=${ASSET_CACHE_BUST}`,
    `./js/train-motion-timer.js?v=${ASSET_CACHE_BUST}`,
    `./js/instructions.js?v=${ASSET_CACHE_BUST}`,
    `./js/profile-compliance.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-payroll-rules.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-payroll-profile.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-payroll-profile-ui.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-payroll-engine.js?v=${ASSET_CACHE_BUST}`,
    `./js/da-payroll-screen.js?v=${ASSET_CACHE_BUST}`,
    './vendor/pdfjs/pdf.min.mjs',
    './vendor/pdfjs/pdf.worker.min.mjs',
    './vendor/pdfjs/pdf.worker.mjs',
    './assets/brand-logo.png',
    './assets/app-icon.png',
    './assets/wall-icons/doc.svg',
    './assets/wall-icons/hammer.svg',
    './assets/wall-icons/delete.svg',
    './.nojekyll'
];

function assetPathnameKey(assetUrl) {
    const raw = String(assetUrl || '').replace(/^\.\//, '');
    const q = raw.indexOf('?');
    return q >= 0 ? raw.slice(0, q) : raw;
}

function isPrecachePath(pathname) {
    return PRECACHE_ASSETS.some((asset) => {
        const cleanAsset = assetPathnameKey(asset);
        return pathname.endsWith(cleanAsset) || (cleanAsset === 'index.html' && pathname.endsWith('/'));
    });
}

function precacheOne(cache, url, timeoutMs = 2500) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { signal: controller.signal })
        .then((response) => {
            clearTimeout(timer);
            if (response && response.ok) {
                return cache.put(url, response);
            }
            return null;
        })
        .catch((err) => {
            clearTimeout(timer);
            console.warn(`[sw] пропуск прекэша ${url}:`, err);
            return null;
        });
}

async function precacheAssets(cache) {
    await Promise.allSettled(
        PRECACHE_ASSETS.map((url) => precacheOne(cache, url))
    );
}

async function matchNavigationFallback(cache) {
    return cache.match('./index.html')
        || cache.match('index.html')
        || cache.match('./')
        || cache.match('/');
}

async function matchCachedRequest(cache, request, { allowNavigateFallback = false } = {}) {
    const direct = await cache.match(request);
    if (direct) return direct;

    if (allowNavigateFallback) {
        const url = new URL(request.url);
        const path = url.pathname;
        if (request.mode === 'navigate' || path.endsWith('/') || path.endsWith('/index.html')) {
            return matchNavigationFallback(cache);
        }
    }

    return null;
}

function revalidateInBackground(cache, request) {
    fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone());
            }
        })
        .catch(() => {});
}

function isAppShellRequest(pathname, mode) {
    if (mode === 'navigate') return true;
    return pathname.endsWith('/index.html') || pathname.endsWith('index.html');
}

function isReleaseNotesRequest(pathname) {
    return pathname.endsWith('/data/release-notes.json') || pathname.endsWith('release-notes.json');
}

function isTrainUidsRequest(pathname) {
    return pathname.endsWith('/data/trains-uids.json') || pathname.endsWith('trains-uids.json');
}

/** Конфиг прокси — всегда из сети (не cache-first), иначе залипает старый workers.dev */
function isAppConfigRequest(pathname) {
    return pathname.endsWith('/js/app-config.js') || pathname.endsWith('app-config.js');
}

function isScheduleMaintenanceRequest(pathname) {
    return pathname.endsWith('/js/schedule-maintenance.js') || pathname.endsWith('schedule-maintenance.js');
}

/** Модуль «Инструкции» — network-first, иначе залипают старые иконки/стили после правок */
function isInstructionsModuleRequest(pathname) {
    return pathname.endsWith('/js/instructions.js')
        || pathname.endsWith('instructions.js')
        || pathname.endsWith('/styles/instructions.css')
        || pathname.endsWith('instructions.css')
        || pathname.endsWith('/styles/tokens.css')
        || pathname.endsWith('tokens.css')
        || pathname.includes('/assets/wall-icons/');
}

/** Личный кабинет — network-first (плановые события, должность) */
function isProfileModuleRequest(pathname) {
    return pathname.endsWith('/js/profile-compliance.js')
        || pathname.endsWith('profile-compliance.js')
        || pathname.endsWith('/styles/profile.css')
        || pathname.endsWith('profile.css');
}

/** Расписание ЦППК — network-first, иначе залипает старый код (8792, daily doc) */
function isSheduleMaxModuleRequest(pathname) {
    return pathname.endsWith('/js/shedule-max-source.js')
        || pathname.endsWith('shedule-max-source.js');
}

function isCrewApiClientRequest(pathname) {
    return pathname.endsWith('/js/crew-api-client.js')
        || pathname.endsWith('crew-api-client.js');
}

function isDaAuthSessionRequest(pathname) {
    return pathname.endsWith('/js/da-auth-session.js')
        || pathname.endsWith('da-auth-session.js');
}

function isSyncUserIdModuleRequest(pathname) {
    return pathname.endsWith('/js/sync-user-id.js')
        || pathname.endsWith('sync-user-id.js');
}

/** Маршруты — network-first, иначе залипают pending-карточки и routes.css */
function isRoutesModuleRequest(pathname) {
    return pathname.endsWith('/styles/routes.css')
        || pathname.endsWith('routes.css');
}

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await matchCachedRequest(cache, request);
        if (cached) return cached;
        throw err;
    }
}

async function networkFirstWithTimeout(request, timeoutMs, options = {}) {
    const cache = await caches.open(CACHE_NAME);
    const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : APP_SHELL_NETWORK_TIMEOUT_MS;
    const allowNavigateFallback = options.allowNavigateFallback === true;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);

    try {
        const response = await fetch(request, { signal: controller.signal });
        clearTimeout(timer);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        clearTimeout(timer);
        const cached = await matchCachedRequest(cache, request, { allowNavigateFallback });
        if (cached) return cached;
        throw err;
    }
}

/** Мгновенно из кэша, обновление в фоне — для офлайн F5 */
async function staleWhileRevalidate(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await matchCachedRequest(cache, request);

    const networkUpdate = fetch(request)
        .then((response) => {
            if (response && response.ok) {
                cache.put(request, response.clone());
            }
            return response;
        })
        .catch(() => null);

    if (cached) {
        revalidateInBackground(cache, request);
        void networkUpdate;
        return cached;
    }

    const response = await networkUpdate;
    if (response) return response;

    const fallback = await matchCachedRequest(cache, request, { allowNavigateFallback: true });
    if (fallback) return fallback;
    return networkFirstWithTimeout(request, APP_SHELL_NETWORK_TIMEOUT_MS);
}

function isAppShellModuleRequest(pathname) {
    return isAppConfigRequest(pathname)
        || isScheduleMaintenanceRequest(pathname)
        || isRoutesModuleRequest(pathname)
        || isCrewApiClientRequest(pathname)
        || isDaAuthSessionRequest(pathname)
        || isSyncUserIdModuleRequest(pathname);
}

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(request);

    if (cached) {
        revalidateInBackground(cache, request);
        return cached;
    }

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const fallback = await cache.match(request);
        if (fallback) return fallback;
        throw err;
    }
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
    event.waitUntil(
        Promise.race([
            caches.open(CACHE_NAME).then((cache) => precacheAssets(cache)),
            new Promise((resolve) => setTimeout(resolve, PRECACHE_BUDGET_MS)),
        ]).catch((err) => console.warn('[sw] прекэш отклонён:', err))
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(
                keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

async function showScheduleSystemNotification(payload = {}) {
    const title = String(payload.title || 'Цифровой помощник').trim();
    const kicker = String(payload.kicker || '').trim();
    const bodyText = String(payload.body || '').trim();
    const body = [kicker, bodyText].filter(Boolean).join(' — ') || title;
    const tag = String(payload.tag || payload.key || 'schedule-alert').trim();

    await self.registration.showNotification(title, {
        body,
        tag,
        renotify: true,
        icon: NOTIFICATION_ICON,
        badge: NOTIFICATION_ICON,
        vibrate: [140, 70, 140],
        requireInteraction: true,
        silent: false,
        data: {
            key: tag,
            url: './',
            screen: 'schedule'
        }
    });
}

function parseWebPushPayload(event) {
    if (!event?.data) return {};
    try {
        return event.data.json();
    } catch {
        try {
            const text = event.data.text();
            return text ? JSON.parse(text) : {};
        } catch {
            return {};
        }
    }
}

async function handleIncomingWebPush(event) {
    const payload = parseWebPushPayload(event);
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visibleClient = clients.find((client) => client.visibilityState === 'visible');

    if (visibleClient) {
        visibleClient.postMessage({
            type: 'REMOTE_SCHEDULE_NOTIFICATION',
            payload
        });
        return;
    }

    await showScheduleSystemNotification(payload);
}

self.addEventListener('push', (event) => {
    event.waitUntil(
        handleIncomingWebPush(event)
            .catch((err) => console.warn('[sw] web push failed:', err))
    );
});

self.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || !data.type) return;

    if (data.type === 'SKIP_WAITING') {
        self.skipWaiting();
        return;
    }

    if (data.type === 'SHOW_SCHEDULE_NOTIFICATION') {
        event.waitUntil(
            showScheduleSystemNotification(data.payload || {})
                .catch((err) => console.warn('[sw] schedule notification failed:', err))
        );
    }
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const targetUrl = event.notification.data?.url || './';

    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true })
            .then((clientList) => {
                for (const client of clientList) {
                    if ('focus' in client) {
                        return client.focus();
                    }
                }
                if (self.clients.openWindow) {
                    return self.clients.openWindow(targetUrl);
                }
                return null;
            })
    );
});

function isSheduleMaxDataRequest(url) {
    const host = String(url.hostname || '');
    const path = String(url.pathname || '');
    if (host.endsWith('s3.cloud.ru') && /cache_(schedule|stops)|cppk_export\/stops/.test(path)) return true;
    return false;
}

/** API на том же origin — только сеть, без CacheStorage */
function isSameOriginApiRequest(url) {
    const path = String(url.pathname || '');
    return path.startsWith('/api/') || path.includes('/dev-local-pay/api/');
}

function isPrivateCrewApiRequest(url) {
    const host = String(url.hostname || '').toLowerCase();
    if (host !== 'api.digipom.ru' && host !== '127.0.0.1' && host !== 'localhost') return false;
    return /\/api\/(v1\/(data|sync|profile|shifts|wall)|auth\/)/i.test(String(url.pathname || ''));
}

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (isPrivateCrewApiRequest(url)) {
        event.respondWith(fetch(request));
        return;
    }
    if (url.origin === self.location.origin && isSameOriginApiRequest(url)) {
        event.respondWith(fetch(request));
        return;
    }
    if (isSheduleMaxDataRequest(url)) {
        event.respondWith(networkFirstWithTimeout(request, SHEDULE_MAX_NETWORK_TIMEOUT_MS));
        return;
    }
    if (url.origin !== self.location.origin) return;

    if (isAppShellModuleRequest(url.pathname)) {
        event.respondWith(networkFirstWithTimeout(request, CRITICAL_MODULE_NETWORK_TIMEOUT_MS));
        return;
    }

    if (isInstructionsModuleRequest(url.pathname)) {
        event.respondWith(networkFirstWithTimeout(request, CRITICAL_MODULE_NETWORK_TIMEOUT_MS));
        return;
    }

    if (isProfileModuleRequest(url.pathname)) {
        event.respondWith(networkFirstWithTimeout(request, CRITICAL_MODULE_NETWORK_TIMEOUT_MS));
        return;
    }

    if (isSheduleMaxModuleRequest(url.pathname)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    if (isReleaseNotesRequest(url.pathname) || isTrainUidsRequest(url.pathname)) {
        event.respondWith(staleWhileRevalidate(request));
        return;
    }

    if (isAppShellRequest(url.pathname, request.mode)) {
        event.respondWith(networkFirstWithTimeout(request, NAVIGATE_NETWORK_TIMEOUT_MS, { allowNavigateFallback: true }));
        return;
    }

    if (isPrecachePath(url.pathname)) {
        event.respondWith(cacheFirst(request));
    }
});
