'use strict';

/**
 * Прикладной API Цифрового помощника (данные + расчёты + поиск инструкций).
 * Query: ?api=<name>&...
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
};

const RATE_MACHINIST = 1000;
const RATE_ASSISTANT = 700;
const RATE_TO_I_MACHINIST = 500;
const RATE_TO_I_ASSISTANT = 315;

const cache = new Map();

function jsonResponse(body, status = 200, extra = {}) {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
        status,
        headers: {
            ...CORS,
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'public, max-age=60',
            ...extra,
        },
    });
}

function readJsonFile(relPath) {
    const full = path.join(DATA_DIR, relPath);
    if (cache.has(full)) return cache.get(full);
    const raw = fs.readFileSync(full, 'utf8');
    const data = JSON.parse(raw);
    cache.set(full, data);
    return data;
}

function normalizeStationKey(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^a-zа-я0-9]+/gi, ' ')
        .trim();
}

function stationSearchKeys(title) {
    const key = normalizeStationKey(title);
    if (!key) return [];
    const parts = key.split(' ').filter(Boolean);
    const keys = [key];
    if (parts.length > 1) keys.push(parts[0], parts.slice(0, 2).join(' '));
    return [...new Set(keys)];
}

function findBestMatchingStationKey(stationTitle, list) {
    const keys = stationSearchKeys(stationTitle);
    if (!keys.length || !Array.isArray(list)) return null;
    const names = list.map((b) => normalizeStationKey(b.station));
    for (const key of keys) {
        if (names.includes(key)) return key;
    }
    for (const key of keys) {
        const hit = names.find((n) => n.includes(key) || key.includes(n));
        if (hit) return hit;
    }
    return null;
}

function findStationBrakes(spr, stationTitle, preferredDirection) {
    if (!spr?.brakes) return [];
    const directions = preferredDirection
        ? [preferredDirection, preferredDirection === 'from_moscow' ? 'to_moscow' : 'from_moscow']
        : ['from_moscow', 'to_moscow'];

    for (const direction of directions) {
        const list = spr.brakes[direction];
        if (!list?.length) continue;
        for (const key of stationSearchKeys(stationTitle)) {
            const exact = list.filter((b) => normalizeStationKey(b.station) === key);
            if (exact.length) return exact;
        }
        const matchedKey = findBestMatchingStationKey(stationTitle, list);
        if (!matchedKey) continue;
        const fuzzy = list.filter((b) => normalizeStationKey(b.station) === matchedKey);
        if (fuzzy.length) return fuzzy;
    }
    return [];
}

function calendarKeyToIso(dateKey) {
    const m = String(dateKey || '').match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    return `${m[3]}-${m[2]}-${m[1]}`;
}

function getWeekdayMarkerForIso(isoDate) {
    if (!isoDate) return null;
    const [y, m, d] = isoDate.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    const map = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const single = map[dt.getUTCDay()];
    return { single, group: single === 'сб' || single === 'вс' ? single : 'пн-чт' };
}

function matchesWeekdayMarker(marker, weekdayInfo) {
    if (!marker || !weekdayInfo) return false;
    if (marker === weekdayInfo.single || marker === weekdayInfo.group) return true;
    if (marker === 'пн-чт' && ['пн', 'вт', 'ср', 'чт'].includes(weekdayInfo.single)) return true;
    if ((marker === 'пн-пт' || marker === 'пн-пя') && ['пн', 'вт', 'ср', 'чт', 'пт'].includes(weekdayInfo.single)) return true;
    return false;
}

function getRouteKind(routeStr) {
    const r = String(routeStr || '').trim().toUpperCase();
    if (/^[НN]/.test(r)) return 'night';
    if (/^[УU]/.test(r) || /У$/.test(r)) return 'morning';
    if (/^[ДD]/.test(r)) return 'day';
    return 'other';
}

function flattenNormatives(bundle) {
    const normatives = Array.isArray(bundle?.normatives) ? bundle.normatives : [];
    if (normatives.length) {
        return normatives.flatMap((n) => (Array.isArray(n.shiftDetails) ? n.shiftDetails : []));
    }
    return Array.isArray(bundle?.shiftDetails) ? bundle.shiftDetails : [];
}

function findShiftTemplate(bundle, routeNumber, dateKey) {
    const route = String(routeNumber || '').trim();
    if (!route || !dateKey) return null;
    const pool = flattenNormatives(bundle);
    if (!pool.length) return null;

    const cleanTarget = route.toUpperCase().replace(/[НУДNU]/g, '').trim();
    const isoDate = calendarKeyToIso(dateKey);
    const weekdayInfo = getWeekdayMarkerForIso(isoDate);
    const targetKind = getRouteKind(route);

    const isRouteMatch = (tmplRoute) => {
        const rStr = String(tmplRoute || '').trim();
        if (rStr === route) return true;
        const tmplKind = getRouteKind(rStr);
        if (targetKind !== 'other' && tmplKind !== 'other' && targetKind !== tmplKind) return false;
        const cleanTmpl = rStr.toUpperCase().replace(/[НУДNU]/g, '').trim();
        return cleanTmpl && cleanTmpl === cleanTarget;
    };

    const candidates = pool.filter((t) => isRouteMatch(t.route));
    if (!candidates.length) return null;

    const exact = candidates.find((t) => String(t.date || '') === dateKey || String(t.date || '') === isoDate);
    if (exact) return { ...exact };

    if (weekdayInfo) {
        const byMarker = candidates.find((t) => matchesWeekdayMarker(String(t.weekday || t.dayMarker || ''), weekdayInfo));
        if (byMarker) return { ...byMarker };
    }

    return { ...candidates[0] };
}

function isToOrIShift(shift) {
    const r = String(shift?.route || shift?.label || '').trim().toUpperCase();
    return r === 'ТО' || r === 'И' || r === 'TO' || r === 'I';
}

function getShiftRate(shift, position) {
    const isAssistant = /помощ/i.test(String(position || ''));
    if (isToOrIShift(shift)) {
        return isAssistant ? RATE_TO_I_ASSISTANT : RATE_TO_I_MACHINIST;
    }
    return isAssistant ? RATE_ASSISTANT : RATE_MACHINIST;
}

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/\s+/g, ' ')
        .trim();
}

const STOP_WORDS = new Set(['и', 'в', 'на', 'по', 'с', 'для', 'или', 'не', 'из', 'к', 'о', 'об', 'от', 'до', 'за']);

function loadInstructionsChunks() {
    const catalog = readJsonFile(path.join('instructions', 'catalog.json'));
    const chunks = [];
    const docs = [];
    for (const d of catalog.documents || []) {
        docs.push(d);
        if (d.hasText === false || d.needsDigitize) continue;
        const chunkPath = path.join(DATA_DIR, 'instructions', 'chunks', `${d.id}.json`);
        if (!fs.existsSync(chunkPath)) continue;
        try {
            const pack = JSON.parse(fs.readFileSync(chunkPath, 'utf8'));
            for (const ch of pack.chunks || []) {
                chunks.push({ ...ch, docId: d.id, docTitle: d.title });
            }
        } catch {
            /* skip */
        }
    }
    return { catalog, docs, chunks };
}

function scoreChunk(query, chunk) {
    const source = chunk.cleanText || chunk.text || '';
    const qNorm = normalizeText(query);
    const text = normalizeText(source);
    if (!qNorm || !text) return 0;
    let score = 0;
    if (text.includes(qNorm) && qNorm.length >= 6) score += 50;
    const keywords = qNorm
        .split(/[\s,;:!?()[\]«»"']+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    keywords.forEach((kw) => {
        if (text.includes(kw)) score += Math.min(12, kw.length);
    });
    return score;
}

function searchInstructions(query, limit = 20) {
    const q = String(query || '').trim();
    if (q.length < 2) return [];
    const { chunks, docs } = loadInstructionsChunks();
    const docMap = new Map(docs.map((d) => [d.id, d]));
    const scored = [];
    for (const chunk of chunks) {
        const score = scoreChunk(q, chunk);
        if (score <= 0) continue;
        const doc = docMap.get(chunk.docId);
        scored.push({
            score,
            chunk: {
                id: chunk.id,
                section: chunk.section || chunk.sectionHint || '',
                text: (chunk.cleanText || chunk.text || '').slice(0, 800),
                page: chunk.page || chunk.pageFrom || null,
            },
            doc: doc
                ? { id: doc.id, title: doc.title, folderId: doc.folderId || null }
                : { id: chunk.docId, title: chunk.docTitle || chunk.docId },
        });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, Math.max(1, Math.min(80, Number(limit) || 20)));
}

async function readJsonBody(request) {
    try {
        return await request.json();
    } catch {
        return null;
    }
}

/**
 * @returns {Promise<Response|null>} null = не наш api=
 */
async function handleAppApi(request, reqUrl) {
    const api = String(reqUrl.searchParams.get('api') || '').trim();
    if (!api) return null;

    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS });
    }

    try {
        if (api === 'health') {
            return jsonResponse({
                ok: true,
                service: 'da-app-api',
                apis: [
                    'spr', 'trains-local', 'shift-templates', 'calendar-local-routes', 'line-sections',
                    'brakes', 'shift-template', 'pay-summary',
                    'instructions-catalog', 'instructions-chunk', 'instructions-search',
                ],
            });
        }

        if (api === 'spr') {
            return jsonResponse(readJsonFile('spr.json'));
        }
        if (api === 'trains-local') {
            return jsonResponse(readJsonFile('trains-local.json'));
        }
        if (api === 'shift-templates') {
            return jsonResponse(readJsonFile('shift-templates.json'));
        }
        if (api === 'calendar-local-routes') {
            return jsonResponse(readJsonFile('calendar-local-routes.json'));
        }
        if (api === 'line-sections') {
            return jsonResponse(readJsonFile('line-sections.json'));
        }

        if (api === 'brakes') {
            const station = reqUrl.searchParams.get('station') || '';
            const direction = reqUrl.searchParams.get('direction') || '';
            const spr = readJsonFile('spr.json');
            const brakes = findStationBrakes(spr, station, direction || null);
            return jsonResponse({ ok: true, station, direction: direction || null, brakes });
        }

        if (api === 'shift-template') {
            const route = reqUrl.searchParams.get('route') || '';
            const date = reqUrl.searchParams.get('date') || '';
            const bundle = readJsonFile('shift-templates.json');
            const template = findShiftTemplate(bundle, route, date);
            return jsonResponse({ ok: true, route, date, template });
        }

        if (api === 'pay-summary' && request.method === 'POST') {
            const body = await readJsonBody(request);
            const position = body?.position || 'Машинист';
            const shifts = Array.isArray(body?.shifts) ? body.shifts : [];
            let totalHours = 0;
            let totalPay = 0;
            const items = shifts.map((s) => {
                const hours = Number(s.hours || s.workHours || 0) || 0;
                const rate = getShiftRate(s, position);
                const pay = hours * rate;
                totalHours += hours;
                totalPay += pay;
                return {
                    dateKey: s.dateKey || s.date || null,
                    route: s.route || null,
                    hours,
                    rate,
                    pay,
                };
            });
            return jsonResponse({
                ok: true,
                position,
                totalHours: Math.round(totalHours * 100) / 100,
                totalPay: Math.round(totalPay),
                items,
            });
        }

        if (api === 'instructions-catalog') {
            return jsonResponse(readJsonFile(path.join('instructions', 'catalog.json')));
        }

        if (api === 'instructions-chunk') {
            const id = String(reqUrl.searchParams.get('id') || '').replace(/[^a-zA-Z0-9_-]/g, '');
            if (!id) return jsonResponse({ ok: false, error: 'id required' }, 400);
            const file = path.join(DATA_DIR, 'instructions', 'chunks', `${id}.json`);
            if (!fs.existsSync(file)) return jsonResponse({ ok: false, error: 'not found' }, 404);
            return jsonResponse(JSON.parse(fs.readFileSync(file, 'utf8')));
        }

        if (api === 'instructions-search') {
            const q = reqUrl.searchParams.get('q') || '';
            const limit = reqUrl.searchParams.get('limit') || '20';
            const results = searchInstructions(q, limit);
            return jsonResponse({ ok: true, query: q, results });
        }

        return jsonResponse({ ok: false, error: `unknown api: ${api}` }, 400);
    } catch (err) {
        console.error('[app-api]', api, err);
        return jsonResponse({ ok: false, error: err.message || String(err) }, 500);
    }
}

module.exports = {
    handleAppApi,
    findShiftTemplate,
    findStationBrakes,
    searchInstructions,
};
