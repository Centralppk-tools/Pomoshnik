// Версия релиза приложения — менять при каждом выкладке (сейчас 2.3.15 STABLE)
const CACHE_VERSION = 'cppk_v2_3_15';
const CACHE_NAME = `cppk_assistant_${CACHE_VERSION}`;

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
    './data/shift-templates.json',
    './data/calendar-local-routes.json',
    './data/release-notes.json',
    './assets/cppk-logo.png',
    './assets/cppk-train.png'
];

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

self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});

self.addEventListener('fetch', (event) => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);
    if (url.origin !== self.location.origin) return;

    if (request.mode === 'navigate' || isPrecachePath(url.pathname)) {
        event.respondWith(cacheFirst(request));
    }
});
