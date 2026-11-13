/**
 * Сетевой слой VPS crew-api: sync, смены, профиль, стена. Офлайн-очередь смен в IndexedDB.
 */
(function (global) {
    'use strict';

    const DB_NAME = 'da_crew_api_v1';
    const DB_VERSION = 1;
    const STORE_QUEUE = 'shift_queue';
    const STORE_META = 'meta';

    const CLOUD_MIGRATED_KEY = 'da_cloud_migrated_v1';
    const CLOUD_MIGRATED_AT_KEY = 'da_cloud_migrated_v1_at';
    let cloudMigrationPromise = null;

    const hooks = {
        getSyncUserId: () => '',
        getTabNumber: () => '',
        buildShiftPayload: null,
        buildProfilePayload: null,
        applySyncPayload: null,
        onAccountSwitched: null
    };

    let pushTimer = null;
    const lastPushedHash = {};

    function shiftPushHashKey(syncUserId, payload) {
        const date = String(payload?.shift_date || '').slice(0, 10);
        let slot = Number(payload?.shift_slot);
        if (!Number.isFinite(slot) || slot < 0) slot = 0;
        return `${syncUserId}:${date}:${slot}`;
    }
    let profileTimer = null;
    let sessionRefreshTimer = null;
    let sessionAnchorAt = 0;
    const SESSION_TTL_MS = 30 * 60 * 1000;
    const SESSION_PREFETCH_LEAD_MS = 10 * 1000;
    const CREW_BG_SYNC_TIMEOUT_MS = 7000;
    const CREW_FETCH_TIMEOUT_MS = 10000;
    let sessionRefreshIdleStreak = 0;
    const SESSION_REFRESH_IDLE_MAX = 5;

    function bgSyncAllowed() {
        if (typeof global.document !== 'undefined' && global.document.visibilityState !== 'visible') {
            return false;
        }
        if (typeof global.navigator !== 'undefined' && global.navigator.onLine === false) {
            return false;
        }
        return true;
    }

    function bindCrewBackgroundVisibilityGuard() {
        if (global.__daCrewBgVisibilityBound) return;
        global.__daCrewBgVisibilityBound = true;
        const onWake = () => {
            if (!bgSyncAllowed()) return;
            scheduleCrewSessionRefresh();
        };
        if (typeof global.document !== 'undefined') {
            global.document.addEventListener('visibilitychange', onWake);
        }
        global.addEventListener('online', onWake);
    }

    function resolveCrewApiBaseUrl(c) {
        const configured = String(c.baseUrl || '').replace(/\/$/, '');
        if (c.devSameOriginProxy === false || !configured) return configured;
        if (typeof global.location === 'undefined') return configured;
        const loc = global.location;
        const host = String(loc.hostname || '').toLowerCase();
        if (loc.protocol === 'http:' && (host === '127.0.0.1' || host === 'localhost')) {
            return String(loc.origin || '').replace(/\/$/, '');
        }
        return configured;
    }

    function cfg() {
        const c = global.APP_CONFIG?.crewApi || {};
        const baseUrl = resolveCrewApiBaseUrl(c);
        return {
            baseUrl,
            enabled: Boolean(c.enabled && baseUrl)
        };
    }

    function openDb() {
        return new Promise((resolve, reject) => {
            if (!global.indexedDB) {
                reject(new Error('indexedDB_unavailable'));
                return;
            }
            const req = global.indexedDB.open(DB_NAME, DB_VERSION);
            req.onerror = () => reject(req.error || new Error('idb_open_failed'));
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE_QUEUE)) {
                    db.createObjectStore(STORE_QUEUE, { keyPath: 'id', autoIncrement: true });
                }
                if (!db.objectStoreNames.contains(STORE_META)) {
                    db.createObjectStore(STORE_META, { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
        });
    }

    async function idbPutMeta(key, value) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_META, 'readwrite');
            tx.objectStore(STORE_META).put({ key, value });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    function scopedMetaKey(key) {
        const syncUserId = hooks.getSyncUserId?.() || '';
        const base = String(key || '');
        return syncUserId ? `${base}::${syncUserId}` : base;
    }

    async function idbPutMetaScoped(key, value) {
        return idbPutMeta(scopedMetaKey(key), value);
    }

    async function idbGetMetaScoped(key) {
        return idbGetMeta(scopedMetaKey(key));
    }

    async function idbGetMeta(key) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_META, 'readonly');
            const req = tx.objectStore(STORE_META).get(key);
            req.onsuccess = () => {
                db.close();
                resolve(req.result ? req.result.value : null);
            };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    async function clearIndexedDbCaches() {
        if (!global.indexedDB) return;
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const names = [STORE_QUEUE, STORE_META];
            const tx = db.transaction(names, 'readwrite');
            names.forEach((n) => {
                try { tx.objectStore(n).clear(); } catch (_) { /* */ }
            });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function enqueueShiftPayload(payload) {
        if (!payload || !payload.shift_date) return;
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            tx.objectStore(STORE_QUEUE).add({
                payload,
                syncUserId: hooks.getSyncUserId?.() || '',
                tab: hooks.getTabNumber?.() || '',
                createdAt: Date.now()
            });
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    async function readIdbStoreDump() {
        const out = { shift_queue: [], meta: [] };
        try {
            const db = await openDb();
            const names = [STORE_QUEUE, STORE_META];
            await new Promise((resolve, reject) => {
                const tx = db.transaction(names, 'readonly');
                tx.objectStore(STORE_QUEUE).getAll().onsuccess = (ev) => {
                    out.shift_queue = ev.target.result || [];
                };
                tx.objectStore(STORE_META).getAll().onsuccess = (ev) => {
                    out.meta = ev.target.result || [];
                };
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
            });
        } catch (err) {
            out.error = String(err && err.message ? err.message : err);
        }
        return out;
    }

    const REFERENCE_LOCAL_STORAGE_KEYS = new Set([
        'cppk_spr_cache_v2',
        'cppk_trains_local_cache',
        'cppk_calendar_local_routes',
        'cppk_shift_templates_bundle',
        'cppk_shift_templates_session_at',
        'da_route_updated_at'
    ]);
    const CLOUD_DUMP_LS_MAX_VALUE_CHARS = 512 * 1024;

    function shouldSkipLocalStorageKeyForCloudDump(key) {
        if (!key || key.startsWith('__')) return true;
        if (key === 'da_auth_jwt' || key === 'rzd_users') return true;
        if (REFERENCE_LOCAL_STORAGE_KEYS.has(key)) return true;
        if (key.startsWith('da_route_stop_v1:')) return true;
        if (key.endsWith('_trainThreadsCache') || key.endsWith('_stationScheduleCache')) return true;
        if (key.startsWith('stops_') || key.startsWith('train_') || key.startsWith('route_')) return true;
        if (/schedule_cache/i.test(key) || /thread_/i.test(key)) return true;
        if (key.startsWith('cache_')) return true;
        return false;
    }

    function collectLocalStorageDump() {
        const bag = {};
        const skippedKeys = [];
        const skippedLarge = [];
        try {
            for (let i = 0; i < global.localStorage.length; i += 1) {
                const key = global.localStorage.key(i);
                if (key == null) continue;
                if (shouldSkipLocalStorageKeyForCloudDump(key)) {
                    skippedKeys.push(key);
                    continue;
                }
                const value = global.localStorage.getItem(key);
                if (value != null && value.length > CLOUD_DUMP_LS_MAX_VALUE_CHARS) {
                    skippedLarge.push(key);
                    continue;
                }
                bag[key] = value;
            }
            if (skippedKeys.length) bag.__cloud_dump_skipped_keys = skippedKeys;
            if (skippedLarge.length) bag.__cloud_dump_skipped_large = skippedLarge;
        } catch (err) {
            bag.__error = String(err && err.message ? err.message : err);
        }
        return bag;
    }

    function isCloudMigratedForSyncUser(syncUserId) {
        const id = String(syncUserId || '').trim();
        if (!id) return false;
        try {
            const raw = global.localStorage.getItem(CLOUD_MIGRATED_KEY);
            if (!raw) return false;
            if (raw === 'true') return true;
            const parsed = JSON.parse(raw);
            if (parsed && parsed.syncUsers && parsed.syncUsers[id]) return true;
            if (parsed && parsed.tabs && parsed.tabs[id]) return true;
        } catch (_) {
            return global.localStorage.getItem(CLOUD_MIGRATED_KEY) === 'true';
        }
        return false;
    }

    function markCloudMigrated(syncUserId, syncedAt) {
        const id = String(syncUserId || '').trim();
        if (!id) return;
        let state = { syncUsers: {} };
        try {
            const raw = global.localStorage.getItem(CLOUD_MIGRATED_KEY);
            if (raw && raw !== 'true') state = JSON.parse(raw) || state;
            else if (raw === 'true') {
                const legacyId = hooks.getSyncUserId?.();
                if (legacyId) state.syncUsers[legacyId] = syncedAt || new Date().toISOString();
            }
        } catch (_) { /* */ }
        if (!state.syncUsers) state.syncUsers = {};
        state.syncUsers[id] = syncedAt || new Date().toISOString();
        global.localStorage.setItem(CLOUD_MIGRATED_KEY, JSON.stringify(state));
        global.localStorage.setItem(CLOUD_MIGRATED_AT_KEY, state.syncUsers[id]);
    }

    async function migrateAllDataToCloud() {
        const { enabled } = cfg();
        const syncUserId = hooks.getSyncUserId?.() || '';
        const tab = hooks.getTabNumber?.() || '';
        if (!enabled || !syncUserId) return { ok: false, skipped: true };
        if (!global.navigator.onLine) return { ok: false, offline: true };
        if (isCloudMigratedForSyncUser(syncUserId)) return { ok: true, skipped: true, reason: 'already_migrated' };

        const appVersion = String(
            global.APP_CONFIG?.APP_BUILD_ID
            || global.APP_BUILD_ID
            || ''
        ).trim();

        const indexedDB = await readIdbStoreDump();
        const body = {
            dump: {
                localStorage: collectLocalStorageDump(),
                indexedDB: { [DB_NAME]: indexedDB }
            },
            meta: {
                sync_user_id: syncUserId,
                tab_number: tab || null,
                captured_at: new Date().toISOString(),
                app_version: appVersion,
                user_agent: String(global.navigator.userAgent || '').slice(0, 512)
            }
        };

        console.info('[crew-api] cloud migration: uploading full dump…');
        let data;
        try {
            data = await apiFetch('/api/v1/sync/full-dump', {
                method: 'POST',
                body
            });
        } catch (err) {
            if (err && err.status === 413) {
                console.warn('[crew-api] cloud migration: dump too large for server; retry with slimmer payload');
            }
            throw err;
        }
        if (data && data.ok) {
            markCloudMigrated(syncUserId, data.synced_at);
            console.info('[crew-api] cloud migration: ok', data.synced_at);
        }
        return data;
    }

    function maybeRunCloudMigration() {
        const { enabled } = cfg();
        const syncUserId = hooks.getSyncUserId?.() || '';
        if (!enabled || !syncUserId || !global.navigator.onLine) return Promise.resolve(null);
        if (!bgSyncAllowed()) return Promise.resolve(null);
        if (isCloudMigratedForSyncUser(syncUserId)) return Promise.resolve(null);
        if (cloudMigrationPromise) return cloudMigrationPromise;
        cloudMigrationPromise = migrateAllDataToCloud()
            .catch((err) => {
                console.warn('[crew-api] cloud migration failed (will retry later)', err);
                return null;
            })
            .finally(() => {
                cloudMigrationPromise = null;
            });
        return cloudMigrationPromise;
    }

    async function readShiftQueue() {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readonly');
            const req = tx.objectStore(STORE_QUEUE).getAll();
            req.onsuccess = () => { db.close(); resolve(req.result || []); };
            req.onerror = () => { db.close(); reject(req.error); };
        });
    }

    async function deleteQueueIds(ids) {
        if (!ids.length) return;
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(STORE_QUEUE, 'readwrite');
            const store = tx.objectStore(STORE_QUEUE);
            ids.forEach((id) => store.delete(id));
            tx.oncomplete = () => { db.close(); resolve(); };
            tx.onerror = () => { db.close(); reject(tx.error); };
        });
    }

    function resolveSyncUserIdFromSession() {
        const fromUser = global.DaAuthSession?.getStoredUser?.();
        const fromJwt = fromUser && fromUser.sync_user_id
            ? String(fromUser.sync_user_id).trim()
            : '';
        if (fromJwt) return fromJwt;
        return String(hooks.getSyncUserId?.() || '').trim();
    }

    function hasValidJwt() {
        const jwt = String(global.DaAuthSession?.getJwt?.() || '').trim();
        if (!jwt) return false;
        const parts = jwt.split('.');
        return parts.length === 3 && parts.every((p) => p.length > 0);
    }

    function forceAuthLock() {
        try {
            global.DaAuthSession?.clearSession?.();
        } catch (_) { /* */ }
        if (typeof global.lockAppAuth === 'function') {
            global.lockAppAuth();
        }
    }

    function requireJwtOrLockApp() {
        if (hasValidJwt()) {
            return global.DaAuthSession.getJwt();
        }
        forceAuthLock();
        const err = new Error('missing_token');
        err.status = 401;
        err.payload = { error: 'missing_token', message: 'Требуется вход.' };
        throw err;
    }

    function shouldForceAuthLockFromResponse(err) {
        if (!err) return false;
        const status = err.status;
        const code = String((err.payload && err.payload.error) || err.message || '').trim();
        if (status === 401) return true;
        if (status === 400 && code === 'missing_or_invalid_x_sync_user_id') return true;
        return (
            code === 'missing_token'
            || code === 'invalid_token'
            || code === 'user_not_found'
            || code === 'sync_user_id_spoof'
        );
    }

    function handleCrewUnauthorized(err) {
        if (!shouldForceAuthLockFromResponse(err)) return;
        forceAuthLock();
    }

    function headers() {
        requireJwtOrLockApp();
        const tab = hooks.getTabNumber?.() || '';
        const h = { 'Content-Type': 'application/json' };
        if (tab) h['x-tab-number'] = tab;
        const authH = global.DaAuthSession?.authHeaders?.() || {};
        Object.assign(h, authH);
        return h;
    }

    async function markCrewSessionFresh() {
        sessionAnchorAt = Date.now();
        try {
            await idbPutMetaScoped('crew_session_anchor_at', sessionAnchorAt);
        } catch (_) { /* */ }
        scheduleCrewSessionRefresh();
    }

    function scheduleCrewSessionRefresh() {
        if (sessionRefreshTimer) clearTimeout(sessionRefreshTimer);
        sessionRefreshTimer = null;
        if (!bgSyncAllowed()) return;
        if (!hasValidJwt()) return;
        if (typeof global.document !== 'undefined' && global.document.body?.classList?.contains('auth-locked')) {
            return;
        }
        const syncUserId = hooks.getSyncUserId?.() || '';
        let delay;
        if (!syncUserId) {
            sessionRefreshIdleStreak += 1;
            if (sessionRefreshIdleStreak > SESSION_REFRESH_IDLE_MAX) {
                return;
            }
            delay = Math.min(60000, 3000 * sessionRefreshIdleStreak);
        } else {
            sessionRefreshIdleStreak = 0;
            delay = Math.max(
                1000,
                sessionAnchorAt + SESSION_TTL_MS - SESSION_PREFETCH_LEAD_MS - Date.now()
            );
        }
        sessionRefreshTimer = setTimeout(() => {
            sessionRefreshTimer = null;
            void refreshCrewSessionBackground();
        }, delay);
    }

    async function refreshCrewSessionBackground() {
        if (!bgSyncAllowed()) {
            if (sessionRefreshTimer) {
                clearTimeout(sessionRefreshTimer);
                sessionRefreshTimer = null;
            }
            return;
        }
        const { enabled } = cfg();
        if (!enabled || !hooks.getSyncUserId?.()) {
            scheduleCrewSessionRefresh();
            return;
        }
        if (!hasValidJwt()) {
            return;
        }
        sessionRefreshIdleStreak = 0;
        try {
            const now = new Date();
            const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
            await Promise.race([
                sync(month),
                new Promise((_resolve, reject) => {
                    setTimeout(() => reject(new Error('crew_bg_sync_timeout')), CREW_BG_SYNC_TIMEOUT_MS);
                }),
            ]);
        } catch (e) {
            if (shouldForceAuthLockFromResponse(e)) {
                handleCrewUnauthorized(e);
            } else {
                console.warn('[crew-api] background sync', e);
            }
        } finally {
            if (!bgSyncAllowed()) return;
            try {
                await markCrewSessionFresh();
            } catch (err) {
                console.warn('[crew-api] session anchor after bg sync', err);
            }
        }
    }

    async function bootstrapCrewSessionAnchor() {
        try {
            const stored = await idbGetMetaScoped('crew_session_anchor_at');
            sessionAnchorAt = Number(stored) || Date.now();
        } catch (_) {
            sessionAnchorAt = Date.now();
        }
        scheduleCrewSessionRefresh();
    }

    async function crewFetch(url, init, timeoutMs) {
        const ms = Number(timeoutMs) > 0 ? Number(timeoutMs) : CREW_FETCH_TIMEOUT_MS;
        const ac = new AbortController();
        const timer = global.setTimeout(() => ac.abort(), ms);
        try {
            return await fetch(url, { ...init, signal: ac.signal });
        } catch (err) {
            if (err && err.name === 'AbortError') {
                const timeoutErr = new Error('request_timeout');
                timeoutErr.code = 'TIMEOUT';
                throw timeoutErr;
            }
            throw err;
        } finally {
            global.clearTimeout(timer);
        }
    }

    async function apiFetch(path, options = {}) {
        const { baseUrl, enabled } = cfg();
        if (!enabled) {
            throw new Error('crew_api_disabled');
        }
        requireJwtOrLockApp();
        const syncUserId = resolveSyncUserIdFromSession();
        if (!syncUserId) {
            forceAuthLock();
            const err = new Error('missing_token');
            err.status = 401;
            err.payload = {
                error: 'missing_sync_user_id',
                message: 'Нет привязки аккаунта. Войдите снова.',
            };
            throw err;
        }
        const url = `${baseUrl}${path}`;
        const init = {
            method: options.method || 'GET',
            headers: { ...headers(), ...(options.headers || {}) },
            cache: 'no-store'
        };
        if (options.body != null) {
            init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
        }
        const res = await crewFetch(url, init, options.timeoutMs);
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `http_${res.status}`);
            err.status = res.status;
            err.payload = data;
            if (res.status === 413) {
                err.message = 'payload_too_large';
            }
            handleCrewUnauthorized(err);
            throw err;
        }
        return data;
    }

    async function sync(month, options) {
        const m = String(month || '').trim();
        if (!/^\d{4}-\d{2}$/.test(m)) {
            throw new Error('invalid_month');
        }
        const data = await apiFetch(`/api/v1/sync?month=${encodeURIComponent(m)}`);
        await idbPutMetaScoped('last_sync_month', m);
        await idbPutMetaScoped('last_sync_at', Date.now());
        const opts = options && typeof options === 'object' ? { ...options } : {};
        const serverShifts = Array.isArray(data?.shifts) ? data.shifts : [];
        if (opts.replaceShifts && !serverShifts.length && typeof hooks.countLocalShiftDates === 'function') {
            const localCount = hooks.countLocalShiftDates();
            if (localCount > 0) {
                opts.preserveLocalOnEmptyServer = true;
            }
        }
        if (typeof hooks.applySyncPayload === 'function') {
            hooks.applySyncPayload(data, { ...opts, syncMonth: m });
        }
        await markCrewSessionFresh();
        return data;
    }

    async function deleteShift(shiftDateIso) {
        const date = String(shiftDateIso || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
            return { ok: false, skipped: true, reason: 'invalid_date' };
        }
        const syncUserId = hooks.getSyncUserId?.() || '';
        if (!syncUserId) {
            return { ok: true, skipped: true, reason: 'no_sync_user_id' };
        }
        const tabNum = String(hooks.getTabNumber?.() || '').trim();
        const jwtUser = global.DaAuthSession?.getStoredUser?.();
        const verified = jwtUser && jwtUser.email_verified_at != null && String(jwtUser.email_verified_at).trim() !== '';
        const hasMail = jwtUser && String(jwtUser.email || '').trim();
        if (verified && hasMail && !tabNum) {
            return { ok: false, skipped: true, reason: 'tab_number_required' };
        }
        const hashKey = shiftPushHashKey(syncUserId, { shift_date: date, shift_slot: 0 });
        delete lastPushedHash[hashKey];

        if (!global.navigator.onLine) {
            await enqueueShiftPayload({ shift_date: date, _delete: true });
            return { ok: true, queued: true };
        }

        try {
            const data = await apiFetch('/api/v1/shifts/delete', {
                method: 'POST',
                body: { shift_date: date },
            });
            return data;
        } catch (err) {
            await enqueueShiftPayload({ shift_date: date, _delete: true });
            throw err;
        }
    }

    async function saveShift(shiftOrList) {
        const syncUserId = hooks.getSyncUserId?.() || '';
        if (!syncUserId) {
            return { ok: true, skipped: true, reason: 'no_sync_user_id' };
        }
        const tabNum = String(hooks.getTabNumber?.() || '').trim();
        const jwtUser = global.DaAuthSession?.getStoredUser?.();
        const verified = jwtUser && jwtUser.email_verified_at != null && String(jwtUser.email_verified_at).trim() !== '';
        const hasMail = jwtUser && String(jwtUser.email || '').trim();
        if (verified && hasMail && !tabNum) {
            return { ok: false, skipped: true, reason: 'tab_number_required' };
        }
        const list = Array.isArray(shiftOrList) ? shiftOrList : [shiftOrList];
        const clean = list.filter((s) => s && s.shift_date && s.route_code && !s._delete);
        if (!clean.length) return { ok: true, skipped: true };

        if (!global.navigator.onLine) {
            if (verified && hasMail && !tabNum) {
                return { ok: false, skipped: true, reason: 'tab_number_required' };
            }
            for (const p of clean) await enqueueShiftPayload(p);
            return { ok: true, queued: clean.length };
        }

        try {
            const data = await apiFetch('/api/v1/shifts/save', {
                method: 'POST',
                body: clean.length === 1 ? clean[0] : { shifts: clean }
            });
            clean.forEach((p) => {
                lastPushedHash[shiftPushHashKey(syncUserId, p)] = JSON.stringify(p);
            });
            return data;
        } catch (err) {
            for (const p of clean) await enqueueShiftPayload(p);
            throw err;
        }
    }

    async function updateProfile(data) {
        if (!data || typeof data !== 'object') return { ok: true, skipped: true };
        if (!global.navigator.onLine) {
            await idbPutMetaScoped('profile_pending', data);
            return { ok: true, queued: true };
        }
        const res = await apiFetch('/api/v1/profile', { method: 'POST', body: data });
        await idbPutMetaScoped('profile_pending', null);
        return res;
    }

    async function clearShiftQueueAll() {
        const rows = await readShiftQueue();
        if (!rows.length) return;
        await deleteQueueIds(rows.map((r) => r.id));
    }

    async function applyClaimSyncSession(syncId, options) {
        const opts = options && typeof options === 'object' ? options : {};
        const id = String(syncId || '').trim();
        if (!id) {
            throw new Error('missing_sync_user_id');
        }
        if (typeof global.setSyncUserId === 'function') {
            const ok = global.setSyncUserId(id, { skipLegacyMigrate: true });
            if (!ok) {
                throw new Error('invalid_sync_user_id');
            }
        } else {
            try {
                global.localStorage.setItem('app_sync_user_id', id);
            } catch (_) { /* */ }
        }
        Object.keys(lastPushedHash).forEach((k) => delete lastPushedHash[k]);
        try {
            await clearShiftQueueAll();
        } catch (err) {
            console.warn('[crew-api] clearShiftQueueAll', err);
        }
        sessionAnchorAt = 0;
        try {
            await idbPutMetaScoped('crew_session_anchor_at', null);
            await idbPutMetaScoped('last_sync_month', null);
        } catch (_) { /* */ }
        if (!opts.skipAccountSwitchHook && typeof hooks.onAccountSwitched === 'function') {
            hooks.onAccountSwitched();
        }
    }

    async function claimAndSync(payload) {
        const { baseUrl, enabled } = cfg();
        if (!enabled) {
            if (typeof global.getOrCreateSyncUserId === 'function') {
                global.getOrCreateSyncUserId();
            }
            return { ok: true, skipped: true };
        }
        const tab = String(payload && payload.tabNumber || payload && payload.tab_number || '').trim();
        const role = String(payload && payload.role || '').trim();
        const name = String(payload && payload.name || '').trim();
        const shifts = Array.isArray(payload && payload.shifts) ? payload.shifts : [];
        let syncUserId = String(
            payload && payload.syncUserId || payload && payload.sync_user_id
            || (typeof global.getOrCreateSyncUserId === 'function' ? global.getOrCreateSyncUserId() : '')
        ).trim();
        if (!/^usr_[a-zA-Z0-9_-]{8,128}$/.test(syncUserId)) {
            if (typeof global.getOrCreateSyncUserId === 'function') {
                syncUserId = global.getOrCreateSyncUserId();
            }
        }
        if (!/^usr_[a-zA-Z0-9_-]{8,128}$/.test(syncUserId)) {
            const err = new Error('invalid_sync_user_id');
            err.payload = { error: 'invalid_sync_user_id', message: 'Не удалось подготовить идентификатор устройства.' };
            throw err;
        }
        const url = `${baseUrl}/api/v1/auth/claim-and-sync`;
        requireJwtOrLockApp();
        const claimHeaders = {
            'Content-Type': 'application/json',
            ...(global.DaAuthSession?.authHeaders?.() || {})
        };
        const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        const timeoutMs = 45000;
        const timeoutId = controller
            ? setTimeout(() => controller.abort(), timeoutMs)
            : null;
        let res;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: claimHeaders,
                body: JSON.stringify({
                    tab_number: tab || null,
                    name: name || null,
                    role,
                    sync_user_id: syncUserId,
                    shifts
                }),
                cache: 'no-store',
                signal: controller ? controller.signal : undefined,
            });
        } catch (fetchErr) {
            if (timeoutId) clearTimeout(timeoutId);
            if (fetchErr && fetchErr.name === 'AbortError') {
                const err = new Error('claim_sync_timeout');
                err.payload = {
                    error: 'claim_sync_timeout',
                    message: 'Сервер долго не отвечает. Вход выполнен — синхронизация повторится позже.',
                };
                throw err;
            }
            throw fetchErr;
        }
        if (timeoutId) clearTimeout(timeoutId);
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.error) || `http_${res.status}`);
            err.status = res.status;
            err.payload = data;
            handleCrewUnauthorized(err);
            throw err;
        }
        const finalSyncId = String(
            (data && data.sync_user_id) || syncUserId
        ).trim();
        await applyClaimSyncSession(finalSyncId, { skipAccountSwitchHook: true });
        return data;
    }

    async function postToWall(card) {
        if (!card || typeof card !== 'object') {
            throw new Error('invalid_wall_card');
        }
        return apiFetch('/api/v1/wall/post', { method: 'POST', body: card });
    }

    async function fetchWallComments(postId) {
        const id = Number.parseInt(String(postId || ''), 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new Error('invalid_post_id');
        }
        return apiFetch(`/api/v1/wall/posts/${encodeURIComponent(id)}/comments`);
    }

    async function postWallComment(postId, messageText) {
        const id = Number.parseInt(String(postId || ''), 10);
        const text = String(messageText || '').trim();
        if (!Number.isFinite(id) || id <= 0) {
            throw new Error('invalid_post_id');
        }
        if (!text) {
            throw new Error('invalid_message');
        }
        return apiFetch(`/api/v1/wall/posts/${encodeURIComponent(id)}/comments`, {
            method: 'POST',
            body: { message_text: text }
        });
    }

    async function postWallHammer(postId) {
        const id = Number.parseInt(String(postId || ''), 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new Error('invalid_post_id');
        }
        return apiFetch(`/api/v1/wall/posts/${encodeURIComponent(id)}/hammer`, {
            method: 'POST',
            body: {}
        });
    }

    async function postWallLike(postId) {
        const id = Number.parseInt(String(postId || ''), 10);
        if (!Number.isFinite(id) || id <= 0) {
            throw new Error('invalid_post_id');
        }
        return apiFetch(`/api/v1/wall/posts/${encodeURIComponent(id)}/like`, {
            method: 'POST',
            body: {}
        });
    }

    async function flushOfflineQueue() {
        const { enabled } = cfg();
        if (!enabled || !global.navigator.onLine) return;
        const syncUserId = hooks.getSyncUserId?.() || '';
        if (!syncUserId) return;

        const tabNum = String(hooks.getTabNumber?.() || '').trim();
        const jwtUser = global.DaAuthSession?.getStoredUser?.();
        const verified = jwtUser && jwtUser.email_verified_at != null && String(jwtUser.email_verified_at).trim() !== '';
        const hasMail = jwtUser && String(jwtUser.email || '').trim();
        if (verified && hasMail && !tabNum) return;

        const pendingProfile = await idbGetMetaScoped('profile_pending');
        if (pendingProfile) {
            try {
                await updateProfile(pendingProfile);
            } catch (e) {
                console.warn('[crew-api] profile flush', e);
            }
        }

        const rows = await readShiftQueue();
        const mine = rows.filter((r) => String(r.syncUserId || r.tab) === String(syncUserId));
        if (!mine.length) return;

        const byDate = new Map();
        mine.forEach((row) => {
            const p = row.payload;
            if (p?.shift_date) {
                const key = shiftPushHashKey(syncUserId, p);
                byDate.set(key, row);
            }
        });
        const queueRows = [...byDate.values()];
        const savePayloads = [];
        try {
            for (const row of queueRows) {
                const p = row.payload;
                if (p._delete) {
                    await apiFetch('/api/v1/shifts/delete', {
                        method: 'POST',
                        body: { shift_date: p.shift_date },
                    });
                    delete lastPushedHash[shiftPushHashKey(syncUserId, p)];
                } else {
                    savePayloads.push(p);
                }
            }
            if (savePayloads.length) {
                await apiFetch('/api/v1/shifts/save', {
                    method: 'POST',
                    body: { shifts: savePayloads },
                });
                savePayloads.forEach((p) => {
                    lastPushedHash[shiftPushHashKey(syncUserId, p)] = JSON.stringify(p);
                });
            }
            await deleteQueueIds(mine.map((r) => r.id));
        } catch (e) {
            console.warn('[crew-api] shift queue flush', e);
        }
    }

    function buildPendingShiftPushPayloads(calendarShifts) {
        const { enabled } = cfg();
        if (!enabled || typeof hooks.buildShiftPayload !== 'function') return [];
        const syncUserId = hooks.getSyncUserId?.() || '';
        if (!syncUserId) return [];
        const payloads = [];
        const map = calendarShifts && typeof calendarShifts === 'object' ? calendarShifts : {};
        Object.keys(map).forEach((dateKey) => {
            const raw = map[dateKey];
            let list = typeof global.normalizeDayShiftsRecord === 'function'
                ? global.normalizeDayShiftsRecord(raw)
                : (Array.isArray(raw) ? raw : raw ? [raw] : []);
            if (typeof global.sortDayShiftsForDisplay === 'function') {
                list = global.sortDayShiftsForDisplay(list);
            }
            list.forEach((shift, index) => {
                const p = hooks.buildShiftPayload(dateKey, shift, index);
                if (!p) return;
                const h = JSON.stringify(p);
                const hashKey = shiftPushHashKey(syncUserId, p);
                if (lastPushedHash[hashKey] === h) return;
                payloads.push(p);
            });
        });
        return payloads;
    }

    function schedulePushShifts(calendarShifts) {
        const { enabled } = cfg();
        if (!enabled || typeof hooks.buildShiftPayload !== 'function') return;
        if (!hooks.getSyncUserId?.()) return;
        clearTimeout(pushTimer);
        pushTimer = setTimeout(() => {
            pushTimer = null;
            const payloads = buildPendingShiftPushPayloads(calendarShifts);
            if (!payloads.length) return;
            saveShift(payloads).catch((err) => {
                console.warn('[crew-api] saveShift', err);
            });
        }, 700);
    }

    async function flushScheduledPushShifts(calendarShifts) {
        clearTimeout(pushTimer);
        pushTimer = null;
        const payloads = buildPendingShiftPushPayloads(calendarShifts);
        if (!payloads.length) return { ok: true, skipped: true };
        return saveShift(payloads);
    }

    function scheduleProfileUpdate() {
        const { enabled } = cfg();
        if (!enabled || typeof hooks.buildProfilePayload !== 'function') return;
        clearTimeout(profileTimer);
        profileTimer = setTimeout(() => {
            const body = hooks.buildProfilePayload();
            if (!body) return;
            updateProfile(body).catch((err) => console.warn('[crew-api] updateProfile', err));
        }, 500);
    }

    async function onTabNumberChanged(_prevTab, _nextTab) {
        Object.keys(lastPushedHash).forEach((k) => delete lastPushedHash[k]);
        scheduleProfileUpdate();
        if (!hooks.getSyncUserId?.()) return;
        const now = new Date();
        const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        try {
            await sync(month);
        } catch (e) {
            console.warn('[crew-api] sync after tab label change', e);
        }
    }

    async function syncCurrentMonth(date = new Date(), options) {
        const month = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
        return sync(month, options);
    }

    async function submitFeedback(body) {
        const { baseUrl, enabled } = cfg();
        if (!enabled) {
            throw new Error('crew_api_disabled');
        }
        const url = `${baseUrl}/api/v1/feedback`;
        requireJwtOrLockApp();
        const h = { 'Content-Type': 'application/json' };
        const authH = global.DaAuthSession?.authHeaders?.() || {};
        Object.assign(h, authH);
        const tab = hooks.getTabNumber?.() || '';
        if (tab) h['x-tab-number'] = tab;
        const res = await crewFetch(
            url,
            { method: 'POST', headers: h, body: JSON.stringify(body || {}) },
            25000,
        );
        let data = null;
        try {
            data = await res.json();
        } catch (_) {
            data = null;
        }
        if (!res.ok) {
            const err = new Error((data && data.message) || (data && data.error) || `http_${res.status}`);
            err.status = res.status;
            err.payload = data;
            handleCrewUnauthorized(err);
            throw err;
        }
        return data;
    }

    function configure(nextHooks) {
        Object.assign(hooks, nextHooks || {});
        bindCrewBackgroundVisibilityGuard();
        void bootstrapCrewSessionAnchor();
    }

    global.DaCrewApi = {
        configure,
        sync,
        syncCurrentMonth,
        claimAndSync,
        saveShift,
        deleteShift,
        updateProfile,
        postToWall,
        fetchWallComments,
        postWallComment,
        postWallHammer,
        postWallLike,
        flushOfflineQueue,
        flushScheduledPushShifts,
        schedulePushShifts,
        scheduleProfileUpdate,
        onTabNumberChanged,
        clearIndexedDbCaches,
        migrateAllDataToCloud,
        maybeRunCloudMigration,
        submitFeedback,
        isEnabled: () => cfg().enabled,
        getSyncUserId: () => hooks.getSyncUserId?.() || '',
        getTabNumber: () => hooks.getTabNumber?.() || ''
    };

    global.addEventListener('online', () => {
        if (!bgSyncAllowed()) return;
        flushOfflineQueue().catch(() => {});
    });
})(typeof window !== 'undefined' ? window : globalThis);
