/** Тяжёлые справочники: RAM (sync read) + IndexedDB (async write), без блокирующего localStorage. */
(function (global) {
    'use strict';

    const DB_NAME = 'da_reference_v1';
    const STORE = 'bundles';
    const WRITE_DEBOUNCE_MS = 350;
    const mem = Object.create(null);
    const writeTimers = Object.create(null);
    let bootstrapPromise = null;

    const LEGACY_LS_KEYS = [
        'cppk_spr_cache_v2',
        'cppk_trains_local_cache',
        'cppk_calendar_local_routes',
        'cppk_shift_templates_bundle',
    ];

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!global.indexedDB) {
                reject(new Error('indexeddb_unavailable'));
                return;
            }
            const req = global.indexedDB.open(DB_NAME, 1);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    db.createObjectStore(STORE);
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
    }

    function idbGet(key) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readonly');
            const req = tx.objectStore(STORE).get(key);
            req.onsuccess = () => {
                db.close();
                resolve(req.result ?? null);
            };
            req.onerror = () => {
                db.close();
                reject(req.error);
            };
        }));
    }

    function idbPut(key, value) {
        return openDb().then((db) => new Promise((resolve, reject) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).put(value, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => {
                db.close();
                reject(tx.error);
            };
        }));
    }

    function hydrateLegacyLocalStorage() {
        LEGACY_LS_KEYS.forEach((key) => {
            if (mem[key] != null) return;
            try {
                const raw = global.localStorage.getItem(key);
                if (!raw) return;
                mem[key] = JSON.parse(raw);
            } catch (err) {
                console.warn('[ref-cache] legacy parse', key, err);
            }
        });
    }

    function getSync(key) {
        if (!key) return null;
        if (mem[key] != null) return mem[key];
        hydrateLegacyLocalStorage();
        return mem[key] ?? null;
    }

    function putSync(key, data) {
        if (!key || data == null) return;
        mem[key] = data;
        if (!global.indexedDB) return;
        clearTimeout(writeTimers[key]);
        writeTimers[key] = global.setTimeout(() => {
            writeTimers[key] = null;
            void idbPut(key, data).catch((err) => {
                console.warn('[ref-cache] idb put', key, err);
            });
        }, WRITE_DEBOUNCE_MS);
    }

    async function bootstrap() {
        hydrateLegacyLocalStorage();
        if (!global.indexedDB) return;
        try {
            const db = await openDb();
            const keys = await new Promise((resolve, reject) => {
                const tx = db.transaction(STORE, 'readonly');
                const req = tx.objectStore(STORE).getAllKeys();
                req.onsuccess = () => resolve(req.result || []);
                req.onerror = () => reject(req.error);
                tx.oncomplete = () => db.close();
            });
            await Promise.all(keys.map(async (key) => {
                const val = await idbGet(key);
                if (val != null) mem[key] = val;
            }));
            for (const key of LEGACY_LS_KEYS) {
                if (mem[key] == null) continue;
                await idbPut(key, mem[key]).catch(() => {});
                try {
                    global.localStorage.removeItem(key);
                } catch (_) { /* */ }
            }
        } catch (err) {
            console.warn('[ref-cache] bootstrap', err);
        }
    }

    function ensureBootstrap() {
        if (!bootstrapPromise) {
            bootstrapPromise = bootstrap();
        }
        return bootstrapPromise;
    }

    global.DaReferenceCache = {
        getSync,
        putSync,
        bootstrap: ensureBootstrap,
    };

    void ensureBootstrap();
})(typeof window !== 'undefined' ? window : globalThis);