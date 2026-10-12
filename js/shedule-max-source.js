/** Источник расписания Цифрового помощника: Shedule_Max (S3 / локальный API). */
(function (global) {
    const DIRS = ['from_moscow', 'to_moscow'];

    function cfg() {
        return global.APP_CONFIG?.sheduleMax || {};
    }

    function s3Base() {
        return String(cfg().s3BaseUrl || 'https://shedulemax-public.s3.cloud.ru').replace(/\/$/, '');
    }

    function useDirectS3() {
        return Boolean(s3Base()) && cfg().useDirectS3 !== false;
    }

    const dayStopsCache = Object.create(null);
    const dayStopsInflight = Object.create(null);
    const trainStopsMem = Object.create(null);
    const FETCH_TIMEOUT_MS = 4500;
    const DAY_CACHE_NAME = 'da_shedulemax_day_v1';

    function dayStopsPath(date) {
        const day = String(date || '').trim();
        return day ? `data/cache_stops/${day}.json` : '';
    }

    function trainStopsKey(date, number) {
        const day = String(date || '').trim();
        const num = String(number || '').replace(/\D/g, '');
        return day && num ? `${day}|${num}` : '';
    }

    function stopFilePath(uid) {
        const id = String(uid || '').trim();
        return id ? `data/cache_stops/stop_${id}.json` : '';
    }

    function s3Url(path) {
        return `${s3Base()}/${String(path || '').replace(/^\//, '')}`;
    }

    function clockHms(value) {
        const match = String(value || '').trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return '';
        const hour = String(Number(match[1])).padStart(2, '0');
        return `${hour}:${match[2]}:${match[3] || '00'}`;
    }

    function clockToSeconds(value) {
        const match = String(value || '').trim().match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
        if (!match) return null;
        return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3] || 0);
    }

    function expandRepeatedHalt(arr, dep, { skip, first, last } = {}) {
        const arrival = clockHms(arr);
        const departure = clockHms(dep);
        if (skip || first || last || !arrival || !departure) {
            return { arr: arrival, dep: departure, seconds: 0 };
        }
        const start = clockToSeconds(arrival);
        const end = clockToSeconds(departure);
        if (start == null || end == null) {
            return { arr: arrival, dep: departure, seconds: 0 };
        }
        if (start === end) {
            const hour = arrival.slice(0, 2);
            const minute = arrival.slice(3, 5);
            return {
                arr: `${hour}:${minute}:00`,
                dep: `${hour}:${minute}:30`,
                seconds: 30,
            };
        }
        let seconds = end - start;
        if (seconds < 0) seconds += 24 * 3600;
        return { arr: arrival, dep: departure, seconds };
    }

    function clockToIso(_date, clock) {
        return clockHms(clock);
    }

    function isSkipStop(stop, index, total) {
        if (!stop) return true;
        if (stop.skip || stop.isPass || stop.pass || stop.is_stop === false) return true;
        const first = Number(index) === 0;
        const last = Number(total) > 1 && Number(index) === Number(total) - 1;
        if (first || last) return false;
        return !String(stop.arr || '').trim() && !String(stop.dep || '').trim();
    }

    function mapBoardTrain(train, date, direction) {
        const number = String(train?.trainNumber || '').trim();
        const uid = String(train?.voyageCode || train?.scheduleId || number).trim();
        const dep = clockHms(train?.depTime || train?.departure || train?.departure_time || train?.segDep);
        const arr = clockHms(train?.arrTime || train?.arrival || train?.arrival_time || train?.segArr);
        const express = /экспресс|рэкс/i.test(String(train?.serviceType || train?.category || ''));
        const rawStops = Array.isArray(train?.stops) ? train.stops : [];
        const alreadyMapped = rawStops.length && rawStops[0]?.station;
        const mappedTrip = rawStops.length && !alreadyMapped
            ? mapStops(train, number, date)
            : null;
        return {
            thread: {
                uid,
                number,
                title: String(train?.route || ''),
                transport_type: 'suburban',
                express_type: express ? 'express' : null,
            },
            departure: dep || mappedTrip?.departure || '',
            arrival: arr || mappedTrip?.arrival || '',
            depTime: dep || mappedTrip?.depTime || '',
            arrTime: arr || mappedTrip?.arrTime || '',
            stops: alreadyMapped ? rawStops : (mappedTrip?.stops || undefined),
            days: null,
            except_days: null,
            is_fuzzy: false,
            _sheduleMax: {
                date,
                direction,
                voyageCode: String(train?.voyageCode || uid).trim(),
                scheduleId: String(train?.scheduleId || '').trim(),
                trainNumber: number,
            },
        };
    }

    function mapStops(payload, trainNumber, date) {
        const raw = Array.isArray(payload?.stops) ? payload.stops : [];
        const stops = raw.map((stop, index) => {
            const skipped = isSkipStop(stop, index, raw.length);
            const title = String(stop?.name || 'Станция');
            const expanded = expandRepeatedHalt(stop?.arr, stop?.dep, {
                skip: skipped,
                first: index === 0,
                last: raw.length > 1 && index === raw.length - 1,
            });
            const givenSec = Number(stop?.stop_seconds);
            const stopSeconds = Number.isFinite(givenSec) && givenSec > 0 ? givenSec : expanded.seconds;
            return {
                station: {
                    title,
                    code: String(stop?.nnst || ''),
                },
                arrival: expanded.arr || null,
                departure: expanded.dep || null,
                stop_time: stopSeconds,
                stop_seconds: stopSeconds,
                dwell: stop?.dwell || '',
                skip: skipped,
                is_stop: !skipped,
            };
        });
        const halts = stops.filter((stop) => !stop.skip);
        const first = halts[0] || stops[0];
        const last = halts[halts.length - 1] || stops[stops.length - 1];
        const departureTime = clockHms(payload?.depTime) || clockHms(first?.departure);
        const arrivalTime = clockHms(payload?.arrTime) || clockHms(last?.arrival);
        let durationMins = null;
        const depParts = departureTime.split(':').map(Number);
        const arrParts = arrivalTime.split(':').map(Number);
        if (depParts.length >= 2 && arrParts.length >= 2) {
            const dMin = depParts[0] * 60 + depParts[1];
            const aMin = arrParts[0] * 60 + arrParts[1];
            durationMins = aMin >= dMin ? aMin - dMin : aMin + 1440 - dMin;
        }
        const origin = first?.station?.title || '';
        const dest = last?.station?.title || '';
        return {
            number: String(payload?.trainNumber || trainNumber || ''),
            uid: String(payload?.voyageCode || ''),
            title: payload?.route || (origin && dest ? `${origin} — ${dest}` : ''),
            transport_type: /экспресс/i.test(String(payload?.serviceType || '')) ? 'РЭКС / Экспресс' : 'Пригородный',
            departure: departureTime,
            arrival: arrivalTime,
            depTime: departureTime,
            arrTime: arrivalTime,
            duration: durationMins,
            stops,
            scheduleDate: date,
            serviceDays: null,
            source: 'shedule-max',
        };
    }

    async function openDayCache() {
        if (!global.caches?.open) return null;
        try {
            return await global.caches.open(DAY_CACHE_NAME);
        } catch {
            return null;
        }
    }

    function openDayIdb() {
        if (!global.indexedDB) return Promise.resolve(null);
        return new Promise((resolve) => {
            try {
                const req = global.indexedDB.open('da_shedulemax_idb', 1);
                req.onupgradeneeded = () => {
                    if (!req.result.objectStoreNames.contains('day')) {
                        req.result.createObjectStore('day');
                    }
                };
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    async function idbGetJson(url) {
        const db = await openDayIdb();
        if (!db) return null;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction('day', 'readonly');
                const req = tx.objectStore('day').get(url);
                req.onsuccess = () => resolve(req.result || null);
                req.onerror = () => resolve(null);
            } catch {
                resolve(null);
            }
        });
    }

    async function idbPutJson(url, payload) {
        const db = await openDayIdb();
        if (!db || !payload) return;
        return new Promise((resolve) => {
            try {
                const tx = db.transaction('day', 'readwrite');
                tx.objectStore('day').put(payload, url);
                tx.oncomplete = () => resolve();
                tx.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    }

    async function readCachedJson(url) {
        const cache = await openDayCache();
        if (cache) {
            try {
                const hit = await cache.match(url);
                if (hit?.ok) return await hit.json();
            } catch {
                /* fall through to IDB */
            }
        }
        return idbGetJson(url);
    }

    async function writeCachedResponse(url, response, payload) {
        if (payload) void idbPutJson(url, payload);
        const cache = await openDayCache();
        if (!cache || !response) return;
        try {
            await cache.put(url, response);
        } catch {
            /* quota / private mode */
        }
    }

    async function readJson(url, timeoutMs = FETCH_TIMEOUT_MS) {
        const controller = new AbortController();
        const timer = global.setTimeout(() => controller.abort(), timeoutMs);
        let res;
        try {
            res = await fetch(url, { signal: controller.signal });
        } catch (err) {
            const fail = new Error(
                err?.name === 'AbortError'
                    ? 'Превышено время ожидания расписания'
                    : 'Не удалось связаться с хранилищем расписания'
            );
            fail.cause = err;
            fail.code = err?.name === 'AbortError' ? 'TIMEOUT' : 'FETCH_FAILED';
            throw fail;
        } finally {
            global.clearTimeout(timer);
        }
        if (res.status === 404) {
            const miss = new Error('Файл расписания ещё не создан');
            miss.code = 'NOT_FOUND';
            miss.status = 404;
            throw miss;
        }
        if (!res.ok) {
            const fail = new Error(`Расписание недоступно (HTTP ${res.status})`);
            fail.code = 'FETCH_FAILED';
            throw fail;
        }
        let payload = null;
        try {
            payload = await res.clone().json();
        } catch {
            payload = null;
        }
        if (!payload) {
            const fail = new Error('Некорректный JSON расписания');
            fail.code = 'FETCH_FAILED';
            throw fail;
        }
        void writeCachedResponse(url, res, payload);
        return payload;
    }

    function trainsFromBoardPayload(payload, direction) {
        if (!payload) return [];
        const trains = payload.trains || payload[direction] || [];
        return Array.isArray(trains) ? trains : [];
    }

    async function fetchBoardFromS3(date, direction, errors) {
        if (!useDirectS3()) return null;
        const path = `data/cache_schedule/schedule_${date}_${direction}.json`;
        try {
            const url = s3Url(path);
            const cached = await readCachedJson(url);
            const payload = cached || await readJson(url, FETCH_TIMEOUT_MS);
            const trains = trainsFromBoardPayload(payload, direction);
            if (trains.length) {
                return trains.map((train) => mapBoardTrain(train, date, direction));
            }
        } catch (err) {
            errors.push(err);
        }
        return null;
    }

    async function fetchBoardDirection(date, direction) {
        const errors = [];
        const fromS3 = await fetchBoardFromS3(date, direction, errors);
        if (fromS3?.length) return fromS3;
        throw errors[0] || new Error(`Расписание на ${date} ещё не создано`);
    }

    async function fetchYaroslavlBoard(date) {
        const parts = await Promise.allSettled(DIRS.map((direction) => fetchBoardDirection(date, direction)));
        const schedule = [];
        const seen = new Set();
        parts.forEach((part) => {
            if (part.status !== 'fulfilled') return;
            (part.value || []).forEach((item) => {
                const key = `${item.thread?.number || ''}@${item.thread?.uid || ''}@${item.departure || ''}`;
                if (seen.has(key)) return;
                seen.add(key);
                schedule.push(item);
            });
        });
        if (!schedule.length) {
            const err = parts.find((part) => part.status === 'rejected');
            throw err?.reason || new Error(`Табло ${date} недоступно`);
        }
        return schedule;
    }

    function isTripPayload(value) {
        return Boolean(value && typeof value === 'object' && !Array.isArray(value)
            && (Array.isArray(value.stops) || value.trainNumber || value.voyageCode || value.depTime));
    }

    function tripMatches(trip, number, uid) {
        if (!isTripPayload(trip)) return false;
        const trainNumber = String(trip.trainNumber || trip.number || '').trim();
        const voyage = String(trip.voyageCode || '').trim();
        const scheduleId = String(trip.scheduleId || '').trim();
        if (uid && (voyage === uid || scheduleId === uid || trainNumber === uid)) return true;
        if (number && trainNumber === number) return true;
        return false;
    }

    function pickTripFromDayDoc(doc, number, uid) {
        if (!doc || typeof doc !== 'object') return null;
        if (Array.isArray(doc.stops) && (tripMatches(doc, number, uid) || !doc.trainNumber)) {
            return doc;
        }
        const keyed = (number && doc[number]) || (uid && (doc[uid] || doc[String(uid)]));
        if (isTripPayload(keyed) && (tripMatches(keyed, number, uid) || (!uid && number && String(keyed.trainNumber || number) === number))) {
            return keyed;
        }
        const lists = [];
        if (Array.isArray(doc)) lists.push(doc);
        ['trains', 'items', 'trips', 'data'].forEach((key) => {
            if (Array.isArray(doc[key])) lists.push(doc[key]);
        });
        for (const list of lists) {
            const hit = list.find((trip) => tripMatches(trip, number, uid));
            if (hit) return hit;
        }
        for (const value of Object.values(doc)) {
            if (tripMatches(value, number, uid)) return value;
        }
        return null;
    }

    async function loadDayStopsDoc(date) {
        const day = String(date || '').trim();
        if (!day) return null;
        if (Object.prototype.hasOwnProperty.call(dayStopsCache, day)) {
            return dayStopsCache[day];
        }
        if (dayStopsInflight[day]) return dayStopsInflight[day];
        const url = s3Url(dayStopsPath(day));
        dayStopsInflight[day] = (async () => {
            try {
                const cached = await readCachedJson(url);
                if (cached) {
                    dayStopsCache[day] = cached;
                    return cached;
                }
                const payload = await readJson(url, FETCH_TIMEOUT_MS);
                dayStopsCache[day] = payload;
                return payload;
            } catch {
                dayStopsCache[day] = null;
                return null;
            }
        })();
        try {
            return await dayStopsInflight[day];
        } finally {
            delete dayStopsInflight[day];
        }
    }

    function threadLookupKeys(trainData) {
        const number = String(trainData?.thread?.number || trainData?.number || trainData?._sheduleMax?.trainNumber || '').trim();
        const uid = String(
            trainData?._sheduleMax?.voyageCode
            || trainData?.thread?.uid
            || trainData?._sheduleMax?.scheduleId
            || ''
        ).trim();
        return { number, uid };
    }

    function threadFromPayload(payload, number, date) {
        if (!payload) return null;
        const raw = Array.isArray(payload.stops) ? payload.stops : [];
        if (raw.length && raw[0]?.station) {
            return {
                ...payload,
                number: payload.number || number,
                stops: raw,
            };
        }
        return mapStops(payload, number, date);
    }

    function lookupThreadSync(trainData, date) {
        const day = String(date || '').trim();
        if (!day) return null;
        const { number, uid } = threadLookupKeys(trainData);
        const mem = trainStopsMem[trainStopsKey(day, number)];
        if (mem) return threadFromPayload(mem, number, date);
        const doc = dayStopsCache[day];
        if (!doc) return null;
        const trip = pickTripFromDayDoc(doc, number, uid);
        if (!trip) return null;
        return threadFromPayload(trip, number, date);
    }

    function rememberStopsPayload(key, url, payload) {
        if (!payload || !Array.isArray(payload.stops) || !payload.stops.length) return null;
        trainStopsMem[key] = payload;
        if (url) void writeCachedResponse(url, null, payload);
        return payload;
    }

    async function loadTrainStops(date, number, uid) {
        const key = trainStopsKey(date, number);
        const path = stopFilePath(uid);
        if (!key) return null;
        if (trainStopsMem[key]) return trainStopsMem[key];
        const url = path ? s3Url(path) : '';
        if (!url) return null;

        const cached = await readCachedJson(url);
        const remembered = rememberStopsPayload(key, url, cached);
        if (remembered) return remembered;
        try {
            const payload = await readJson(url, FETCH_TIMEOUT_MS);
            return rememberStopsPayload(key, url, payload);
        } catch {
            return null;
        }
    }

    async function hydrateDayStopsCacheOnly(date) {
        const day = String(date || '').trim();
        if (!day) return null;
        if (dayStopsCache[day]) return dayStopsCache[day];
        const cached = await readCachedJson(s3Url(dayStopsPath(day)));
        if (cached) {
            dayStopsCache[day] = cached;
            return cached;
        }
        return null;
    }

    async function fetchThreadFromObjectStore(date, number, uid) {
        const dayDoc = await loadDayStopsDoc(date);
        if (!dayDoc) return null;
        const trip = pickTripFromDayDoc(dayDoc, number, uid);
        if (!trip) return null;
        return mapStops(trip, number, date);
    }

    async function fetchThread(trainData, date) {
        const sync = lookupThreadSync(trainData, date);
        if (sync) return sync;
        const { number, uid } = threadLookupKeys(trainData);
        return fetchThreadFromObjectStore(date, number, uid);
    }

    global.SheduleMaxSource = {
        fetchYaroslavlBoard,
        fetchThread,
        lookupThreadSync,
        loadTrainStops,
        hydrateDayStopsCacheOnly,
        prefetchDayStops: hydrateDayStopsCacheOnly,
        clockHms,
        clockToIso,
        enabled() {
            return Boolean(s3Base());
        },
    };
})(window);
