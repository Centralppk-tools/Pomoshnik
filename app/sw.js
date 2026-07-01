// Версия релиза приложения — менять при каждом выкладке (сейчас 2.3.10 STABLE)
const CACHE_VERSION = 'cppk_v2_3_10';
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
    './spr.json',
    './trains-local.json',
    './data/shift-templates.json',
    './data/calendar-local-routes.json',
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

async function networkFirst(request) {
    const cache = await caches.open(CACHE_NAME);

    try {
        const response = await fetch(request);
        if (response && response.ok) {
            cache.put(request, response.clone());
        }
        return response;
    } catch (err) {
        const cached = await cache.match(request);
        if (cached) return cached;

        if (request.mode === 'navigate') {
            const fallback = await cache.match('./index.html')
                || await cache.match('index.html')
                || await cache.match('./');
            if (fallback) return fallback;
        }

        throw err;
    }
}

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => precacheAssets(cache))
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
        event.respondWith(networkFirst(request));
    }
});
