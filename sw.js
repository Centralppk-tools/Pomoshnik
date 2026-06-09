const CACHE_VERSION = 'cppk-v2.1.1';
const CACHE_NAME = `cppk-assistant-${CACHE_VERSION}`;

const PRECACHE_ASSETS = [
    './',
    './index.html',
    './manifest.json',
    './assets/cppk-logo.png',
    './assets/cppk-train.png'
];

function isPrecachePath(pathname) {
    const normalized = pathname.replace(/^\//, '').replace(/\/$/, '') || 'index.html';
    return PRECACHE_ASSETS.some((asset) => {
        const assetPath = asset.replace(/^\.\//, '').replace(/\/$/, '') || 'index.html';
        return normalized === assetPath
            || (assetPath === 'index.html' && (normalized === '' || normalized === 'index.html'));
    });
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
            .then((cache) => cache.addAll(PRECACHE_ASSETS))
            .catch((err) => console.warn('[sw] precache failed:', err))
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
