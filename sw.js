// Версия релиза приложения — менять при каждом выкладке (сейчас 2.4.5 STABLE)
const CACHE_VERSION = 'da_v2_4_5';
const NOTIFICATION_ICON = './assets/app-icon.png';
const CACHE_NAME = `digital_assistant_${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './styles/tokens.css',
    './styles/base.css',
    './styles/routes.css',
    './styles/schedule.css',
    './styles/calendar.css',
    './styles/profile.css',
    './styles/responsive.css',
    './styles/auth.css',
    './styles/community.css',
    './spr.json',
    './trains-local.json',
    './data/trains-uids.json',
    './data/shift-templates.json',
    './data/calendar-local-routes.json',
    './data/release-notes.json',
    './js/da-secrets.js',
    './google-oauth-callback.html',
    './assets/brand-logo.png',
    './assets/app-icon.png'
];

function isOAuthCallbackPath(pathname) {
    return pathname.endsWith('/google-oauth-callback.html') || pathname.endsWith('google-oauth-callback.html');
}

function isPrecachePath(pathname) {
    return PRECACHE_ASSETS.some((asset) => {
        const cleanAsset = asset.replace(/^\.\//, '');
        return pathname.endsWith(cleanAsset) || (cleanAsset === 'index.html' && pathname.endsWith('/'));
    });
}

async function precacheAssets(cache) {
    await Promise.allSettled(
        PRECACHE_ASSETS.map((url) =>
            cache.add(url).catch((err) => {
                console.warn(`[sw] пропуск прекэша ${url}:`, err);
            })
        )
    );
}

async function matchNavigationFallback(cache) {
    return cache.match('./index.html')
        || cache.match('index.html')
        || cache.match('./')
        || cache.match('/');
}

async function matchCachedRequest(cache, request) {
    const direct = await cache.match(request);
    if (direct) return direct;

    const url = new URL(request.url);
    const path = url.pathname;
    const fileName = path.split('/').pop() || '';

    if (fileName) {
        const byName = await cache.match(`./${fileName}`) || await cache.match(fileName);
        if (byName) return byName;
    }

    if (request.mode === 'navigate' || path.endsWith('/')) {
        if (isOAuthCallbackPath(path)) {
            return null;
        }
        return matchNavigationFallback(cache);
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

function isReleaseNotesRequest(pathname) {
    return pathname.endsWith('/data/release-notes.json') || pathname.endsWith('release-notes.json');
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

async function cacheFirst(request) {
    const cache = await caches.open(CACHE_NAME);
    const cached = await matchCachedRequest(cache, request);

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
        const fallback = await matchCachedRequest(cache, request);
        if (fallback) return fallback;
        throw err;
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => precacheAssets(cache))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('[sw] прекэш отклонён из-за отсутствия файлов:', err))
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

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (isOAuthCallbackPath(url.pathname)) {
        event.respondWith(fetch(request));
        return;
    }

    if (isReleaseNotesRequest(url.pathname)) {
        event.respondWith(networkFirst(request));
        return;
    }

    if (request.mode === 'navigate' || isPrecachePath(url.pathname)) {
        event.respondWith(cacheFirst(request));
    }
});
