/**
 * Модуль «Инструкции» — файловый менеджер + поиск по тексту + PDF-просмотр.
 * Загрузка: только PDF (accept в HTML: application/pdf,.pdf). Текст — pdf.js textContent, без OCR.
 */
(function () {
    'use strict';

    const DB_NAME = 'da_instructions_v1';
    const DB_VERSION = 1;
    const PDFJS_URL = new URL('vendor/pdfjs/pdf.min.mjs', window.location.href).href;
    const PDFJS_WORKER = new URL('vendor/pdfjs/pdf.worker.min.mjs', window.location.href).href;
    const SYSTEM_FOLDER_IDS = ['pte', 'reglamenty', 'tra'];
    const MIN_PAGE_CHARS = 40;
    const DIGITIZE_MSG = 'Текст не распознан, воспользуйтесь сервисом оцифровки и обновите информацию';

    const STOP_WORDS = new Set([
        'в', 'на', 'по', 'и', 'с', 'для', 'при', 'от', 'к', 'а', 'но', 'или', 'из', 'у', 'о', 'об',
        'во', 'со', 'же', 'ли', 'бы', 'то', 'что', 'как', 'это', 'не', 'до', 'за', 'под', 'над',
        'без', 'про', 'через', 'между', 'после', 'перед', 'ещё', 'еще', 'уже', 'только', 'также'
    ]);

    let dbPromise = null;
    let pdfjsLib = null;
    let pdfjsLoading = null;
    let activeFolderId = null;
    let uiBound = false;
    let searchDebounceTimer = null;
    let lastFileHits = [];
    let dragDocId = null;
    let suppressDocClick = false;
    let itemMenuHoldUntil = 0;
    let staticPack = {
        ready: false,
        folders: [],
        documents: [],
        chunks: []
    };

    /** @type {null | {
     *   doc: object,
     *   pdf: object,
     *   pageNum: number,
     *   totalPages: number,
     *   rendering: boolean,
     *   gen: number,
     *   pageTexts: string[],
     *   findQuery: string,
     *   findMatches: Array<{page: number, start: number, end: number}>,
     *   findIndex: number,
     *   highlightQuery: string,
     *   resizeObs: ResizeObserver | null,
     *   renderTask: object | null,
     *   touchStartX: number,
     *   touchStartY: number,
     *   _resizeTimer: number,
     *   _scrubTimer: number
     * }} */
    let viewer = null;

    function uid(prefix) {
        return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    }

    function normalizeText(value) {
        return String(value || '')
            .toLowerCase()
            .replace(/ё/g, 'е')
            .replace(/\s+/g, ' ')
            .trim();
    }

    function formatBytes(size) {
        const n = Number(size) || 0;
        if (n < 1024) return `${n} Б`;
        if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} КБ`;
        return `${(n / (1024 * 1024)).toFixed(1)} МБ`;
    }

    function formatDate(ts) {
        try {
            return new Date(ts).toLocaleDateString('ru-RU', {
                day: '2-digit',
                month: '2-digit',
                year: 'numeric'
            });
        } catch (_) {
            return '';
        }
    }

    function escapeHtml(str) {
        return String(str || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function $(id) {
        return document.getElementById(id);
    }

    function setStatus(text) {
        const el = $('instrStatus');
        if (el) el.textContent = text || '';
    }

    function openDb() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains('folders')) {
                    db.createObjectStore('folders', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('documents')) {
                    const docs = db.createObjectStore('documents', { keyPath: 'id' });
                    docs.createIndex('byFolder', 'folderId', { unique: false });
                }
                if (!db.objectStoreNames.contains('chunks')) {
                    const chunks = db.createObjectStore('chunks', { keyPath: 'id' });
                    chunks.createIndex('byDoc', 'docId', { unique: false });
                }
                if (!db.objectStoreNames.contains('blobs')) {
                    db.createObjectStore('blobs', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('chats')) {
                    db.createObjectStore('chats', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error || new Error('IndexedDB open failed'));
        });
        return dbPromise;
    }

    function idbReq(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function withStore(storeName, mode, fn) {
        const db = await openDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(storeName, mode);
            const store = tx.objectStore(storeName);
            let result;
            tx.oncomplete = () => resolve(result);
            tx.onerror = () => reject(tx.error || new Error('tx error'));
            tx.onabort = () => reject(tx.error || new Error('tx aborted'));
            try {
                Promise.resolve(fn(store))
                    .then((value) => {
                        result = value;
                    })
                    .catch(reject);
            } catch (err) {
                reject(err);
            }
        });
    }

    async function getAll(storeName) {
        return withStore(storeName, 'readonly', (store) => idbReq(store.getAll()));
    }

    async function putItem(storeName, value) {
        return withStore(storeName, 'readwrite', (store) => idbReq(store.put(value)));
    }

    async function deleteItem(storeName, key) {
        return withStore(storeName, 'readwrite', (store) => idbReq(store.delete(key)));
    }

    async function getItem(storeName, key) {
        return withStore(storeName, 'readonly', (store) => idbReq(store.get(key)));
    }

    async function migrateRemoveSystemFolders() {
        const done = await getItem('meta', 'systemFoldersRemoved');
        if (done?.value) return;

        for (const id of SYSTEM_FOLDER_IDS) {
            await deleteItem('folders', id).catch(() => {});
        }

        const docs = await getAll('documents');
        for (const doc of docs) {
            if (SYSTEM_FOLDER_IDS.includes(doc.folderId)) {
                doc.folderId = null;
                await putItem('documents', doc);
            }
        }

        await putItem('meta', { key: 'systemFoldersRemoved', value: true });
        await putItem('meta', { key: 'foldersSeeded', value: true });
    }

    async function getOpfsRoot() {
        if (!navigator.storage?.getDirectory) return null;
        try {
            const root = await navigator.storage.getDirectory();
            return root.getDirectoryHandle('da_instructions', { create: true });
        } catch (_) {
            return null;
        }
    }

    async function saveBlob(docId, blob) {
        const dir = await getOpfsRoot();
        if (dir) {
            try {
                const handle = await dir.getFileHandle(`${docId}.bin`, { create: true });
                const writable = await handle.createWritable();
                await writable.write(blob);
                await writable.close();
                return { storage: 'opfs', path: `${docId}.bin` };
            } catch (_) {
                /* fall through */
            }
        }
        await putItem('blobs', { id: docId, blob });
        return { storage: 'idb', path: docId };
    }

    async function loadBlob(doc) {
        if (doc?.source === 'static' || doc?.storage === 'static') {
            const rel = String(doc.pdfPath || '').replace(/^\.\//, '');
            if (!rel) return null;
            const res = await fetch(`./${rel}`, { cache: 'no-store' });
            if (!res.ok) return null;
            return res.blob();
        }
        if (doc.storage === 'opfs') {
            const dir = await getOpfsRoot();
            if (dir) {
                try {
                    const handle = await dir.getFileHandle(doc.path || `${doc.id}.bin`);
                    return handle.getFile();
                } catch (_) {
                    /* fall through */
                }
            }
        }
        const row = await getItem('blobs', doc.id);
        return row?.blob || null;
    }

    async function resolveDocument(docId) {
        const id = String(docId || '');
        if (id.startsWith('static_')) {
            return staticPack.documents.find((d) => d.id === id) || null;
        }
        return getItem('documents', id);
    }

    async function resolveFolder(folderId) {
        const id = String(folderId || '');
        if (id.startsWith('static_')) {
            return staticPack.folders.find((f) => f.id === id) || null;
        }
        return getItem('folders', id);
    }

    async function loadStaticInstructionsPack() {
        staticPack = { ready: false, folders: [], documents: [], chunks: [] };
        try {
            const proxy = String(window.APP_CONFIG?.yandexProxy || '').replace(/\/?$/, '');
            const catalogUrls = [];
            if (proxy) catalogUrls.push(`${proxy}?api=instructions-catalog`);
            catalogUrls.push('./data/instructions/catalog.json');

            let catalog = null;
            for (const url of catalogUrls) {
                try {
                    const init = url.includes('functions.yandexcloud.net') && typeof window.daBuildProxyFetchInit === 'function'
                        ? window.daBuildProxyFetchInit({ cache: 'no-store' })
                        : { cache: 'no-store' };
                    const res = await fetch(url, init);
                    if (!res.ok) continue;
                    catalog = await res.json();
                    break;
                } catch (_) { /* next */ }
            }
            if (!catalog) {
                staticPack.ready = true;
                return;
            }
            staticPack.folders = (catalog.folders || []).map((f, idx) => ({
                id: `static_${f.id}`,
                staticId: f.id,
                name: f.name,
                order: f.order ?? idx,
                parentId: f.parentId ? `static_${f.parentId}` : null,
                source: 'static'
            }));

            for (const d of catalog.documents || []) {
                const pathRel = d.filePath || d.pdfPath || `data/instructions/pdf/${d.id}.pdf`;
                const kind = d.kind || (/\.xlsx$/i.test(pathRel) ? 'xlsx' : /\.docx$/i.test(pathRel) ? 'docx' : 'pdf');
                const mime = d.mime
                    || (kind === 'xlsx'
                        ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
                        : kind === 'docx'
                            ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
                            : 'application/pdf');
                const doc = {
                    id: `static_${d.id}`,
                    staticId: d.id,
                    source: 'static',
                    storage: 'static',
                    folderId: d.folderId ? `static_${d.folderId}` : null,
                    title: d.title,
                    mime,
                    kind,
                    pageCount: d.pageCount || 0,
                    updatedAt: d.updatedAt || 0,
                    hasText: d.hasText !== false && !d.needsDigitize,
                    needsDigitize: !!d.needsDigitize || d.hasText === false,
                    pdfPath: pathRel,
                    size: 0
                };
                staticPack.documents.push(doc);
                if (!doc.hasText) continue;
                try {
                    const chunkUrls = [];
                    if (proxy) chunkUrls.push(`${proxy}?api=instructions-chunk&id=${encodeURIComponent(d.id)}`);
                    chunkUrls.push(`./data/instructions/chunks/${d.id}.json`);
                    let pack = null;
                    for (const curl of chunkUrls) {
                        try {
                            const chunkRes = await fetch(curl, { cache: 'no-store' });
                            if (!chunkRes.ok) continue;
                            pack = await chunkRes.json();
                            break;
                        } catch (_) { /* next */ }
                    }
                    if (!pack) continue;
                    (pack.chunks || []).forEach((ch) => {
                        staticPack.chunks.push({
                            ...ch,
                            id: ch.id || uid('schk'),
                            docId: doc.id
                        });
                    });
                } catch (_) { /* skip */ }
            }
        } catch (err) {
            console.warn('[instructions] static pack', err);
        }
        staticPack.ready = true;
    }

    async function deleteBlob(doc) {
        if (doc.storage === 'opfs') {
            const dir = await getOpfsRoot();
            if (dir) {
                try {
                    await dir.removeEntry(doc.path || `${doc.id}.bin`);
                } catch (_) {
                    /* ignore */
                }
            }
        }
        await deleteItem('blobs', doc.id).catch(() => {});
    }

    async function loadPdfJs() {
        if (pdfjsLib) return pdfjsLib;
        if (pdfjsLoading) return pdfjsLoading;
        pdfjsLoading = import(PDFJS_URL)
            .then((mod) => {
                const lib = mod.default || mod;
                if (lib?.GlobalWorkerOptions) {
                    lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
                }
                pdfjsLib = lib;
                return lib;
            })
            .catch((err) => {
                pdfjsLoading = null;
                throw err;
            });
        return pdfjsLoading;
    }

    function cleanPdfText(raw) {
        return String(raw || '')
            .replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ')
            .replace(/[©®™�]/g, '')
            .replace(/([A-Za-zА-Яа-яЁё0-9])-\n([A-Za-zА-Яа-яЁё0-9])/g, '$1$2')
            .replace(/\r\n?/g, '\n')
            .replace(/[^\S\n]+/g, ' ')
            .replace(/ *\n */g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
    }

    function textContentToString(content) {
        let text = '';
        let lastY = null;
        const items = content?.items || [];
        for (let i = 0; i < items.length; i += 1) {
            const item = items[i];
            const str = item?.str;
            if (!str) continue;
            const y = item.transform ? item.transform[5] : null;
            if (lastY != null && y != null && Math.abs(y - lastY) > 4) {
                text += '\n';
            } else if (text && !/\s$/.test(text) && !/^\s/.test(str)) {
                text += ' ';
            }
            text += str;
            if (y != null) lastY = y;
        }
        return text;
    }

    function extractSection(text) {
        const raw = String(text || '');
        const m = raw.match(/(?:^|\n)\s*((?:\d+\.){1,4}\d+)\s/)
            || raw.match(/(?:п\.|пункт|раздел|статья)\s*([\d.]+)/i)
            || raw.match(/\b(\d+(?:\.\d+){1,3})\b/);
        return m ? (m[1] || m[0]).trim() : '';
    }

    function isTocJunk(text) {
        const lines = String(text || '').split(/\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length) return true;
        let tocHits = 0;
        lines.forEach((line) => {
            if (/\.{3,}|…/.test(line) && /\d{1,4}\s*$/.test(line)) tocHits += 1;
            if (/^\d+(?:\.\d+)*\s+.+\s+\d{1,4}$/.test(line) && line.length < 90) tocHits += 1;
        });
        if (tocHits >= 2) return true;
        if (tocHits >= 1 && lines.length <= 4) return true;
        const dottedRatio = tocHits / lines.length;
        return dottedRatio >= 0.5 && lines.length >= 3;
    }

    function isCoverJunk(text) {
        const raw = String(text || '').trim();
        if (!raw) return true;
        if (isTocJunk(raw)) return true;

        if (/внутренн\w*\s+нормативн|дата\s+утверждения|полигоне\s+обслуживания|центральная\s+ппк|у[эе]пс[-\s]?\d/i.test(raw)
            && raw.length < 520) {
            return true;
        }
        if (/термины\s+и\s+определения/i.test(raw) && raw.length < 280) return true;

        const cyr = (raw.match(/[а-яё]/gi) || []).length;
        const lat = (raw.match(/[a-z]/gi) || []).length;
        if (cyr + lat > 36 && lat > cyr * 0.5) return true;

        if (/(?:[A-Z]{3,}[^a-zа-яё]*){2,}/.test(raw) && cyr < 40) return true;
        if ((raw.match(/[|_]{2,}|\s—\s|\s–\s/g) || []).length >= 4 && raw.length < 650) return true;

        const words = raw.split(/\s+/).filter(Boolean);
        const shortRatio = words.filter((w) => w.length <= 2).length / Math.max(1, words.length);
        if (words.length > 12 && shortRatio > 0.45) return true;

        return false;
    }

    function splitIntoChunks(pageNum, pageText) {
        const cleaned = cleanPdfText(pageText);
        if (!cleaned) return [];

        let parts = cleaned.split(/(?=\n\d+\.\d+(?:\.\d+)*\b|\n[А-ЯЁA-Z][А-ЯЁA-Z\s]{3,}\n)/);
        if (parts.length === 1) {
            parts = cleaned.split(/\n{2,}/);
        }
        if (parts.length === 1 && cleaned.length > 900) {
            parts = [];
            let start = 0;
            while (start < cleaned.length) {
                let end = Math.min(cleaned.length, start + 700);
                if (end < cleaned.length) {
                    const soft = cleaned.lastIndexOf('. ', end);
                    if (soft > start + 200) end = soft + 1;
                }
                parts.push(cleaned.slice(start, end));
                start = end;
            }
        }

        return parts
            .map((part) => cleanPdfText(part))
            .filter((part) => part.length >= 24)
            .filter((part) => !isCoverJunk(part))
            .map((part) => {
                const section = extractSection(part);
                return {
                    id: uid('chk'),
                    page: pageNum,
                    section,
                    sectionHint: section,
                    cleanText: part,
                    text: part
                };
            });
    }

    async function extractPdfChunks(arrayBuffer) {
        const lib = await loadPdfJs();
        const pdf = await lib.getDocument({ data: arrayBuffer.slice(0) }).promise;
        const all = [];
        const pageTexts = [];
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum += 1) {
            const page = await pdf.getPage(pageNum);
            const content = await page.getTextContent();
            const raw = textContentToString(content);
            pageTexts.push(raw);
            all.push(...splitIntoChunks(pageNum, raw));
        }
        try { pdf.destroy(); } catch (_) { /* ignore */ }
        return { pageCount: pageTexts.length, chunks: all, pageTexts };
    }

    function queryKeywords(queryNorm) {
        return queryNorm
            .split(/[\s,;:!?()[\]«»"']+/)
            .map((t) => t.trim())
            .filter((t) => t.length > 1 && !STOP_WORDS.has(t));
    }

    function scoreChunk(query, chunk) {
        const source = chunk.cleanText || chunk.text || '';
        if (isCoverJunk(source)) return 0;

        const qNorm = normalizeText(query);
        const text = normalizeText(source);
        if (!qNorm || !text) return 0;

        let score = 0;
        const sectionPatterns = [...qNorm.matchAll(/\b\d+(?:\.\d+){1,3}\b/g)].map((m) => m[0]);
        sectionPatterns.forEach((sec) => {
            const escaped = sec.replace(/\./g, '\\.');
            const sectionField = normalizeText(chunk.section || chunk.sectionHint || '');
            const atStart = new RegExp(`(^|\\n)\\s*${escaped}(\\s|[.…]|$)`);
            const bodyAfter = source.replace(new RegExp(escaped), '').replace(/\s+/g, ' ').trim();
            if (sectionField === sec || atStart.test(source)) {
                if (bodyAfter.length >= 70) score += 100;
                else if (bodyAfter.length >= 30) score += 35;
            } else if (text.includes(sec)) {
                score += 6;
            }
        });

        if (text.includes(qNorm) && qNorm.length >= 6) {
            score += 50;
        }

        const keywords = queryKeywords(qNorm);
        if (!keywords.length && !sectionPatterns.length) {
            if (text.includes(qNorm)) score += 8;
            return score;
        }

        let hitCount = 0;
        keywords.forEach((token) => {
            if (text.includes(token)) {
                hitCount += 1;
                score += token.length >= 5 ? 6 : 3;
            }
        });

        if (keywords.length >= 2) {
            if (hitCount === keywords.length) score += 40;
            else if (hitCount >= Math.ceil(keywords.length * 0.75)) score += 18;
            else if (hitCount === 1) score = Math.max(0, score - 8);
        } else if (keywords.length === 1 && hitCount === 1) {
            score += 10;
        }

        if (Number(chunk.page) === 1 && score > 0 && source.length < 420) {
            score = Math.max(0, score - 25);
        }

        if (hitCount === 0 && !sectionPatterns.length) return 0;
        if (keywords.length >= 2 && hitCount < Math.ceil(keywords.length / 2) && !sectionPatterns.length) {
            return Math.min(score, 4);
        }

        return score;
    }

    async function keywordSearch(query, limit = 5) {
        const q = String(query || '').trim();
        if (!q) return [];

        const proxy = String(window.APP_CONFIG?.yandexProxy || '').replace(/\/?$/, '');
        if (proxy && q.length >= 2) {
            try {
                const searchInit = typeof window.daBuildProxyFetchInit === 'function'
                    ? window.daBuildProxyFetchInit({ cache: 'no-store' })
                    : { cache: 'no-store' };
                const res = await fetch(
                    `${proxy}?api=instructions-search&q=${encodeURIComponent(q)}&limit=${encodeURIComponent(limit)}`,
                    searchInit
                );
                if (res.ok) {
                    const data = await res.json();
                    if (data?.ok && Array.isArray(data.results) && data.results.length) {
                        return data.results.map((row) => ({
                            chunk: {
                                id: row.chunk?.id,
                                section: row.chunk?.section || '',
                                text: row.chunk?.text || '',
                                cleanText: row.chunk?.text || '',
                                page: row.chunk?.page || 0,
                                docId: `static_${row.doc?.id}`
                            },
                            doc: {
                                id: `static_${row.doc?.id}`,
                                staticId: row.doc?.id,
                                title: row.doc?.title || row.doc?.id,
                                source: 'static',
                                hasText: true
                            },
                            score: row.score || 0
                        })).slice(0, limit);
                    }
                }
            } catch (err) {
                console.warn('[instructions] server search', err);
            }
        }

        const chunks = [...(await getAll('chunks')), ...staticPack.chunks];
        const docs = [...(await getAll('documents')), ...staticPack.documents];
        const docMap = Object.fromEntries(docs.map((d) => [d.id, d]));
        return chunks
            .map((chunk) => ({
                chunk,
                doc: docMap[chunk.docId],
                score: scoreChunk(q, chunk)
            }))
            .filter((row) => row.score > 0 && row.doc && row.doc.hasText !== false
                && !isCoverJunk(row.chunk.cleanText || row.chunk.text))
            .sort((a, b) => b.score - a.score || (a.chunk.page || 0) - (b.chunk.page || 0))
            .slice(0, limit);
    }

    function makeSnippetHtml(text, query, maxLen = 180) {
        const raw = String(text || '').replace(/\s+/g, ' ').trim();
        if (!raw) return '';
        const qNorm = normalizeText(query);
        const keywords = queryKeywords(qNorm);
        const lower = normalizeText(raw);
        let anchor = -1;
        const needle = keywords[0] || qNorm;
        if (needle) anchor = lower.indexOf(needle);
        if (anchor < 0) anchor = 0;

        let start = Math.max(0, anchor - 50);
        let end = Math.min(raw.length, start + maxLen);
        if (start > 0) {
            const space = raw.indexOf(' ', start);
            if (space > 0 && space < start + 20) start = space + 1;
        }
        let slice = raw.slice(start, end).trim();
        if (start > 0) slice = `…${slice}`;
        if (end < raw.length) slice = `${slice}…`;

        let html = escapeHtml(slice);
        const terms = [...new Set([qNorm, ...keywords].filter((t) => t && t.length > 1))]
            .sort((a, b) => b.length - a.length);
        terms.forEach((term) => {
            const re = new RegExp(`(${term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
            html = html.replace(re, '<mark>$1</mark>');
        });
        return html;
    }

    function needsDigitizeBanner(doc) {
        if (doc.hasText === false) return true;
        if (doc.needsDigitize === true) return true;
        if (doc.needsOcr === true) return true;
        return false;
    }

    function digitizeBannerHtml() {
        return `<p class="instr-doc__digitize-banner" role="status">${escapeHtml(DIGITIZE_MSG)}</p>`;
    }

    function setFabMenuOpen(open) {
        const menu = $('instrFabMenu');
        const fab = $('instrFab');
        if (!menu || !fab) return;
        menu.hidden = !open;
        fab.classList.toggle('is-open', open);
        fab.setAttribute('aria-expanded', open ? 'true' : 'false');
    }

    let nameDialogResolver = null;

    function closeNameDialog(value) {
        const dialog = $('instrNameDialog');
        if (dialog) {
            dialog.hidden = true;
            dialog.setAttribute('aria-hidden', 'true');
        }
        document.body.classList.remove('release-overlay-open');
        const resolver = nameDialogResolver;
        nameDialogResolver = null;
        if (resolver) resolver(value);
    }

    function askFolderName() {
        return new Promise((resolve) => {
            const dialog = $('instrNameDialog');
            const input = $('instrNameDialogInput');
            if (!dialog || !input) {
                resolve(null);
                return;
            }
            nameDialogResolver = resolve;
            input.value = '';
            dialog.hidden = false;
            dialog.setAttribute('aria-hidden', 'false');
            document.body.classList.add('release-overlay-open');
            window.setTimeout(() => {
                input.focus();
                input.select();
            }, 40);
        });
    }

    async function createUserFolder() {
        const name = await askFolderName();
        if (name == null) return;
        const trimmed = String(name).trim();
        if (!trimmed) {
            setStatus('Введите название папки');
            window.setTimeout(() => setStatus(''), 2000);
            return;
        }
        const folders = await getAll('folders');
        const folder = {
            id: uid('fld'),
            name: trimmed.slice(0, 48),
            parentId: activeFolderId || null,
            order: folders.length,
            createdAt: Date.now()
        };
        await putItem('folders', folder);
        setStatus(`Папка «${folder.name}» создана`);
        window.setTimeout(() => setStatus(''), 2000);
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function deleteDocument(docId) {
        if (String(docId || '').startsWith('static_')) {
            setStatus('Основная документация — нельзя удалить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const doc = await getItem('documents', docId);
        if (!doc) return;
        const ok = window.confirm(`Удалить «${doc.title}»?`);
        if (!ok) return;

        const chunks = await getAll('chunks');
        for (const chunk of chunks) {
            if (chunk.docId === docId) {
                await deleteItem('chunks', chunk.id).catch(() => {});
            }
        }
        await deleteBlob(doc);
        await deleteItem('documents', docId);
        setStatus('Документ удалён');
        window.setTimeout(() => setStatus(''), 2000);
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    function isStaticItem(id) {
        return String(id || '').startsWith('static_');
    }

    function folderButtonHtml(folder) {
        const locked = folder.source === 'static';
        return `
            <button type="button" class="instr-folder${locked ? ' instr-folder--static' : ''}" data-folder-id="${escapeHtml(folder.id)}" ${locked ? 'data-static="1"' : ''}>
                <span class="instr-folder__icon" aria-hidden="true">
                    <svg viewBox="0 0 68 54" xmlns="http://www.w3.org/2000/svg">
                        <defs>
                            <linearGradient id="instrFolderGrad_${escapeHtml(folder.id)}" x1="8%" y1="0%" x2="92%" y2="100%">
                                <stop offset="0%" stop-color="#06C785"/>
                                <stop offset="100%" stop-color="#024C4E"/>
                            </linearGradient>
                        </defs>
                        <path fill="url(#instrFolderGrad_${escapeHtml(folder.id)})" d="M4 18c0-2.8 2.2-5 5-5h15.8c.8 0 1.5.3 2.1.8l3.6 3.4c.5.5 1.3.8 2.1.8H59c2.8 0 5 2.2 5 5v23c0 2.8-2.2 5-5 5H9c-2.8 0-5-2.2-5-5V18z"/>
                        <path fill="url(#instrFolderGrad_${escapeHtml(folder.id)})" d="M4 16.5c0-2.5 2-4.5 4.5-4.5H22l3.2 3.2H9c-2.8 0-5 1.8-5 4.3v.5H4z" opacity="0.95"/>
                    </svg>
                </span>
                <span class="instr-folder__name">${escapeHtml(folder.name)}</span>
            </button>
        `;
    }

    async function deleteUserFolder(folderId) {
        if (isStaticItem(folderId) || SYSTEM_FOLDER_IDS.includes(folderId)) {
            setStatus('Основная документация — нельзя удалить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const folder = await getItem('folders', folderId);
        if (!folder) return;
        const ok = window.confirm(`Удалить папку «${folder.name}»? Файлы и вложенные папки останутся уровнем выше.`);
        if (!ok) return;
        const parentId = folder.parentId || null;
        const folders = await getAll('folders');
        for (const f of folders) {
            if (f.parentId === folderId) {
                f.parentId = parentId;
                await putItem('folders', f);
            }
        }
        const docs = await getAll('documents');
        for (const doc of docs) {
            if (doc.folderId === folderId) {
                doc.folderId = parentId;
                doc.updatedAt = Date.now();
                await putItem('documents', doc);
            }
        }
        await deleteItem('folders', folderId);
        if (activeFolderId === folderId) activeFolderId = parentId;
        setStatus('Папка удалена');
        window.setTimeout(() => setStatus(''), 2000);
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    function docActionsHtml(doc, opts = {}) {
        const { hitsCount = 0 } = opts;
        const toggle = hitsCount
            ? `<button type="button" class="instr-doc__toggle" data-doc-toggle="${escapeHtml(doc.id)}" aria-expanded="true" aria-label="Показать совпадения">▾</button>`
            : '';
        const del = doc.source === 'static'
            ? ''
            : `<button type="button" class="instr-doc__delete" data-doc-delete="${escapeHtml(doc.id)}" aria-label="Удалить документ">✕</button>`;
        return `
            ${toggle}
            ${del}
        `;
    }

    async function renderFsNav() {
        const back = $('instrFsBack');
        const title = $('instrFsTitle');
        if (!title) return;

        if (!activeFolderId) {
            if (back) back.hidden = true;
            title.textContent = 'Рабочий стол';
            return;
        }

        const folder = await resolveFolder(activeFolderId);
        if (back) back.hidden = false;
        title.textContent = folder?.name || 'Папка';
    }

    async function enterFolder(folderId) {
        activeFolderId = folderId || null;
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function goDesktop() {
        activeFolderId = null;
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function goBack() {
        if (!activeFolderId) {
            await goDesktop();
            return;
        }
        const folder = await resolveFolder(activeFolderId);
        await enterFolder(folder?.parentId || null);
    }

    async function renderFolders() {
        const host = $('instrFolders');
        const baseHost = $('instrBaseFolders');
        const baseSection = $('instrBaseSection');
        if (!host) return;
        const q = String($('instrSearchInput')?.value || '').trim();
        const sortFolders = (a, b) => (a.order || 0) - (b.order || 0) || String(a.name).localeCompare(String(b.name), 'ru');

        if (q) {
            host.classList.add('is-hidden');
            host.innerHTML = '';
            if (baseSection) baseSection.hidden = true;
            if (baseHost) baseHost.innerHTML = '';
            return;
        }

        const parent = activeFolderId || null;
        const userFolders = (await getAll('folders'))
            .filter((f) => !SYSTEM_FOLDER_IDS.includes(f.id) && (f.parentId || null) === parent)
            .sort(sortFolders);
        const baseFolders = staticPack.folders
            .filter((f) => (f.parentId || null) === parent)
            .sort(sortFolders);

        if (baseHost && baseSection) {
            if (baseFolders.length) {
                baseSection.hidden = false;
                baseHost.innerHTML = baseFolders.map((folder) => folderButtonHtml(folder)).join('');
            } else {
                baseSection.hidden = true;
                baseHost.innerHTML = '';
            }
        }

        if (!userFolders.length) {
            host.classList.add('is-hidden');
            host.innerHTML = '';
            return;
        }

        host.classList.remove('is-hidden');
        host.innerHTML = userFolders.map((folder) => folderButtonHtml(folder)).join('');
    }

    function docSubMeta(doc, extra = '') {
        const bits = [
            formatBytes(doc.size),
            formatDate(doc.updatedAt),
            doc.pageCount ? `${doc.pageCount} стр.` : '',
            extra
        ].filter(Boolean);
        return bits.join(' · ');
    }

    async function moveDocToFolder(docId, folderId) {
        if (String(docId || '').startsWith('static_')) {
            setStatus('Статичный документ нельзя переместить');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        if (String(folderId || '').startsWith('static_')) {
            setStatus('В папку базы нельзя перемещать свои файлы');
            window.setTimeout(() => setStatus(''), 2500);
            return;
        }
        const doc = await getItem('documents', docId);
        if (!doc) return;
        if (doc.folderId === folderId) return;
        doc.folderId = folderId;
        doc.updatedAt = Date.now();
        await putItem('documents', doc);
        setStatus('Документ перемещён в папку');
        window.setTimeout(() => setStatus(''), 2000);
        await renderDocuments($('instrSearchInput')?.value || '');
        await renderFolders();
    }

    function renderHitSnippetRow(hit, query) {
        const section = hit.chunk.section || hit.chunk.sectionHint || '';
        const snippet = makeSnippetHtml(hit.chunk.cleanText || hit.chunk.text, query);
        return `
            <button type="button" class="instr-hit"
                data-doc-id="${escapeHtml(hit.doc.id)}"
                data-page="${Number(hit.chunk.page) || 1}"
                data-highlight="${escapeHtml(query)}">
                <span class="instr-hit__page">Стр. ${Number(hit.chunk.page) || 1}</span>
                ${section ? `<span class="instr-hit__section">${escapeHtml(section)}</span>` : ''}
                <span class="instr-hit__snippet">${snippet}</span>
            </button>
        `;
    }

    function renderDocCardHtml(doc, opts = {}) {
        const { hits = [], query = '', location = '' } = opts;
        const hitsHtml = hits.length
            ? `<div class="instr-doc-hits">${hits.map((h) => renderHitSnippetRow(h, query)).join('')}</div>`
            : '';
        const banner = needsDigitizeBanner(doc) ? digitizeBannerHtml() : '';
        const subExtra = [
            hits.length ? `${hits.length} совп.` : '',
            location
        ].filter(Boolean).join(' · ');
        return `
            <article class="instr-doc-card${hits.length ? ' is-open' : ''}" data-doc-card="${escapeHtml(doc.id)}" ${doc.source === 'static' ? '' : 'draggable="true"'}>
                <div class="instr-doc" data-doc-open="${escapeHtml(doc.id)}" role="button" tabindex="0">
                    <span class="instr-doc__badge" aria-hidden="true">
                        <span class="instr-doc__badge-label">${
                            doc.source === 'static'
                                ? (doc.kind === 'xlsx' ? 'XLS' : doc.kind === 'docx' ? 'DOC' : 'БЗ')
                                : (doc.kind === 'xlsx' ? 'XLS' : doc.kind === 'docx' ? 'DOC' : 'PDF')
                        }</span>
                        <span class="instr-doc__badge-lines"><span></span><span></span><span></span></span>
                    </span>
                    <span class="instr-doc__meta">
                        <span class="instr-doc__title">${escapeHtml(doc.title)}</span>
                        <span class="instr-doc__sub">${escapeHtml(docSubMeta(doc, subExtra))}</span>
                    </span>
                    ${docActionsHtml(doc, { hitsCount: hits.length })}
                </div>
                ${banner}
                ${hitsHtml}
            </article>
        `;
    }

    async function renderDocuments(filterQuery = '') {
        const host = $('instrDocs');
        if (!host) return;
        const allDocs = [...(await getAll('documents')), ...staticPack.documents];
        const folders = [...(await getAll('folders')), ...staticPack.folders];
        const folderMap = Object.fromEntries(folders.map((f) => [f.id, f]));

        if (activeFolderId && !folderMap[activeFolderId]) {
            activeFolderId = null;
            await renderFsNav();
        }

        const q = String(filterQuery || '').trim();
        const qNorm = normalizeText(q);
        lastFileHits = [];

        if (qNorm) {
            const chunkHits = await keywordSearch(q, 80);
            lastFileHits = chunkHits;
            const byDoc = new Map();
            chunkHits.forEach((hit) => {
                if (!byDoc.has(hit.doc.id)) byDoc.set(hit.doc.id, []);
                byDoc.get(hit.doc.id).push(hit);
            });

            const titleHits = allDocs.filter(
                (d) => d.hasText !== false && normalizeText(d.title).includes(qNorm) && !byDoc.has(d.id)
            );
            const orderedIds = [
                ...chunkHits.map((h) => h.doc.id).filter((id, i, arr) => arr.indexOf(id) === i),
                ...titleHits.map((d) => d.id)
            ].filter((id, i, arr) => arr.indexOf(id) === i);

            const docMap = Object.fromEntries(allDocs.map((d) => [d.id, d]));
            await renderFolders();

            if (!orderedIds.length) {
                host.innerHTML = '<p class="instr-empty">Ничего не найдено</p>';
                return;
            }

            host.innerHTML = orderedIds.map((docId) => {
                const doc = docMap[docId];
                if (!doc) return '';
                const hits = (byDoc.get(docId) || []).slice(0, 8);
                const folderName = doc.folderId ? folderMap[doc.folderId]?.name : '';
                const location = doc.source === 'static'
                    ? (folderName ? `База · ${folderName}` : 'База')
                    : (folderName || 'Рабочий стол');
                return renderDocCardHtml(doc, { hits, query: q, location });
            }).join('');
            return;
        }

        await renderFolders();

        let docs;
        if (activeFolderId) {
            docs = allDocs.filter((d) => d.folderId === activeFolderId);
        } else {
            docs = allDocs.filter((d) => !d.folderId);
        }
        docs.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));

        if (!docs.length) {
            const parent = activeFolderId || null;
            const hasChildFolders = [...(await getAll('folders')), ...staticPack.folders]
                .filter((f) => !SYSTEM_FOLDER_IDS.includes(f.id))
                .some((f) => (f.parentId || null) === parent);
            if (hasChildFolders) {
                host.innerHTML = '';
                return;
            }
            host.innerHTML = `<p class="instr-empty">${
                activeFolderId
                    ? 'Папка пуста. Нажмите +, чтобы добавить PDF, или перетащите документ с рабочего стола.'
                    : 'Нет документов на рабочем столе. Загрузите PDF или создайте папку.'
            }</p>`;
            return;
        }

        host.innerHTML = docs.map((doc) => renderDocCardHtml(doc)).join('');
    }

    async function refreshUi() {
        await migrateRemoveSystemFolders();
        await loadStaticInstructionsPack();
        await renderFsNav();
        await renderFolders();
        await renderDocuments($('instrSearchInput')?.value || '');
    }

    async function handleUploadFiles(fileList) {
        const files = Array.from(fileList || []);
        if (!files.length) return;

        let added = 0;
        let lastNeedsDigitize = false;
        for (const file of files) {
            const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
            if (!isPdf) {
                setStatus(`${file.name}: только PDF`);
                window.setTimeout(() => setStatus(''), 2500);
                continue;
            }

            setStatus(`Индексация: ${file.name}…`);
            const docId = uid('doc');
            const storage = await saveBlob(docId, file);
            let pageCount = 0;
            let chunks = [];
            let hasText = false;
            let needsDigitize = false;

            try {
                const buf = await file.arrayBuffer();
                const extracted = await extractPdfChunks(buf);
                pageCount = extracted.pageCount;
                chunks = extracted.chunks.map((c) => ({
                    id: c.id,
                    docId,
                    page: c.page,
                    section: c.section,
                    sectionHint: c.sectionHint,
                    cleanText: c.cleanText,
                    text: c.text
                }));

                const totalChars = (extracted.pageTexts || []).reduce(
                    (sum, t) => sum + cleanPdfText(t).length,
                    0
                );
                const avgPerPage = pageCount ? totalChars / pageCount : 0;
                if (avgPerPage < MIN_PAGE_CHARS || chunks.length === 0) {
                    hasText = false;
                    needsDigitize = true;
                    chunks = [];
                } else {
                    hasText = true;
                    needsDigitize = false;
                }
            } catch (err) {
                console.warn('[instructions] pdf extract', err);
                hasText = false;
                needsDigitize = true;
                chunks = [];
                setStatus(`PDF сохранён без текста: ${file.name}`);
            }

            const doc = {
                id: docId,
                folderId: activeFolderId || null,
                title: file.name,
                mime: 'application/pdf',
                size: file.size,
                pageCount,
                updatedAt: Date.now(),
                storage: storage.storage,
                path: storage.path,
                hasText,
                needsDigitize
            };
            await putItem('documents', doc);
            for (const chunk of chunks) {
                await putItem('chunks', chunk);
            }
            added += 1;
            lastNeedsDigitize = needsDigitize;
        }

        if (added) {
            if (lastNeedsDigitize) setStatus(DIGITIZE_MSG);
            else setStatus(added === 1 ? 'Файл добавлен' : `Добавлено файлов: ${added}`);
        }
        await renderDocuments($('instrSearchInput')?.value || '');
        window.setTimeout(() => setStatus(''), lastNeedsDigitize ? 6000 : 2500);
    }

    function updateViewerChrome() {
        if (!viewer) return;
        const titleEl = $('instrPdfTitle');
        const pageInput = $('instrPdfPageInput');
        const pageTotal = $('instrPdfPageTotal');
        const scrubber = $('instrPdfPageScrubber');
        const findCount = $('instrPdfFindCount');

        if (titleEl) titleEl.textContent = viewer.doc?.title || 'Документ';
        if (pageTotal) pageTotal.textContent = String(viewer.totalPages || 1);
        if (pageInput) {
            pageInput.max = String(viewer.totalPages || 1);
            pageInput.value = String(viewer.pageNum || 1);
        }
        if (scrubber) {
            scrubber.max = String(viewer.totalPages || 1);
            scrubber.value = String(viewer.pageNum || 1);
        }
        if (findCount) {
            const total = viewer.findMatches.length;
            const idx = total ? viewer.findIndex + 1 : 0;
            findCount.textContent = `${idx} из ${total}`;
        }
    }

    async function renderTextLayer(page, viewport) {
        const layer = $('instrPdfTextLayer');
        if (!layer || !pdfjsLib) return;
        layer.innerHTML = '';
        layer.style.width = `${Math.floor(viewport.width)}px`;
        layer.style.height = `${Math.floor(viewport.height)}px`;
        layer.style.setProperty('--scale-factor', String(viewport.scale));

        const textContent = await page.getTextContent();
        try {
            if (typeof pdfjsLib.TextLayer === 'function') {
                const textLayer = new pdfjsLib.TextLayer({
                    textContentSource: textContent,
                    container: layer,
                    viewport
                });
                await textLayer.render();
            }
        } catch (err) {
            console.warn('[instructions] textLayer', err);
        }

        applyTextHighlights(layer);
    }

    function applyTextHighlights(layer) {
        if (!viewer || !layer) return;
        const query = normalizeText(viewer.highlightQuery || viewer.findQuery || '');
        if (!query) return;
        const terms = queryKeywords(query);
        const needles = terms.length ? terms : (query.length > 1 ? [query] : []);
        if (!needles.length) return;

        let first = null;
        layer.querySelectorAll('span').forEach((span) => {
            span.classList.remove('instr-pdf-hl');
            const lower = normalizeText(span.textContent || '');
            if (!lower) return;
            if (needles.some((n) => lower.includes(n))) {
                span.classList.add('instr-pdf-hl');
                if (!first) first = span;
            }
        });
        first?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    function ensurePdfPageDom(stage) {
        let canvas = $('instrPdfCanvas');
        let wrap = $('instrPdfPageWrap');
        if (canvas && wrap && stage.contains(canvas) && stage.contains(wrap)) {
            wrap.hidden = false;
            return { canvas, wrap };
        }
        stage.innerHTML = `
            <div id="instrPdfPageWrap" class="instr-pdf-page-wrap">
                <canvas id="instrPdfCanvas"></canvas>
                <div id="instrPdfTextLayer" class="instr-pdf-text-layer textLayer"></div>
            </div>
        `;
        return { canvas: $('instrPdfCanvas'), wrap: $('instrPdfPageWrap') };
    }

    async function renderPdfPage(pageNum) {
        if (!viewer?.pdf) return;
        const stage = $('instrPdfStage');
        if (!stage) return;
        const gen = viewer.gen;

        if (viewer.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
            viewer.renderTask = null;
        }

        const { canvas, wrap } = ensurePdfPageDom(stage);
        if (!canvas || !wrap) return;

        const target = Math.min(Math.max(1, Number(pageNum) || 1), viewer.totalPages);
        viewer.pageNum = target;
        viewer.rendering = true;
        updateViewerChrome();

        try {
            const page = await viewer.pdf.getPage(target);
            if (!viewer || viewer.gen !== gen) return;

            const containerWidth = Math.max(280, (stage.clientWidth || window.innerWidth) - 24);
            const unscaled = page.getViewport({ scale: 1 });
            const scale = containerWidth / Math.max(1, unscaled.width);
            const viewport = page.getViewport({ scale });
            const dpr = Math.min(window.devicePixelRatio || 1, 2);
            const cssW = Math.floor(viewport.width);
            const cssH = Math.floor(viewport.height);

            const fresh = document.createElement('canvas');
            fresh.id = 'instrPdfCanvas';
            canvas.replaceWith(fresh);
            const drawCanvas = fresh;

            drawCanvas.width = Math.floor(cssW * dpr);
            drawCanvas.height = Math.floor(cssH * dpr);
            drawCanvas.style.width = `${cssW}px`;
            drawCanvas.style.height = `${cssH}px`;
            wrap.style.width = `${cssW}px`;
            wrap.style.height = `${cssH}px`;
            wrap.hidden = false;

            const ctx = drawCanvas.getContext('2d');
            if (!ctx) throw new Error('Canvas 2D недоступен');
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, drawCanvas.width, drawCanvas.height);

            const transform = dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : null;
            const renderTask = page.render({
                canvasContext: ctx,
                viewport,
                transform,
                intent: 'display'
            });
            viewer.renderTask = renderTask;
            await renderTask.promise;
            if (!viewer || viewer.gen !== gen) return;
            viewer.renderTask = null;
            await renderTextLayer(page, viewport);
        } catch (err) {
            if (err?.name === 'RenderingCancelledException') return;
            console.warn('[instructions] renderPdfPage', err);
            if (viewer && viewer.gen === gen) {
                stage.innerHTML = `<p class="instr-empty">Не удалось отрисовать страницу. ${escapeHtml(err.message || '')}</p>`;
            }
        } finally {
            if (viewer && viewer.gen === gen) {
                viewer.rendering = false;
                updateViewerChrome();
            }
        }
    }

    async function ensurePageTexts() {
        if (!viewer?.pdf) return;
        if (viewer.pageTexts.length === viewer.totalPages) return;
        viewer.pageTexts = new Array(viewer.totalPages).fill('');
        for (let i = 1; i <= viewer.totalPages; i += 1) {
            const page = await viewer.pdf.getPage(i);
            const content = await page.getTextContent();
            viewer.pageTexts[i - 1] = cleanPdfText(textContentToString(content));
        }
    }

    async function runPdfFind(query, resetIndex) {
        if (!viewer) return;
        viewer.findQuery = String(query || '').trim();
        viewer.highlightQuery = viewer.findQuery;
        if (!viewer.findQuery) {
            viewer.findMatches = [];
            viewer.findIndex = -1;
            updateViewerChrome();
            await renderPdfPage(viewer.pageNum);
            return;
        }

        await ensurePageTexts();
        const q = normalizeText(viewer.findQuery);
        const matches = [];
        viewer.pageTexts.forEach((pageText, idx) => {
            const lower = normalizeText(pageText);
            let from = 0;
            while (from < lower.length) {
                const pos = lower.indexOf(q, from);
                if (pos < 0) break;
                matches.push({ page: idx + 1, start: pos, end: pos + q.length });
                from = pos + Math.max(1, q.length);
                if (matches.length > 400) break;
            }
        });
        viewer.findMatches = matches;
        if (resetIndex !== false) {
            viewer.findIndex = matches.length ? 0 : -1;
        } else if (viewer.findIndex >= matches.length) {
            viewer.findIndex = matches.length ? 0 : -1;
        }
        updateViewerChrome();
        if (viewer.findIndex >= 0) {
            await goToFindMatch(viewer.findIndex);
        } else {
            await renderPdfPage(viewer.pageNum);
        }
    }

    async function goToFindMatch(index) {
        if (!viewer?.findMatches.length) return;
        const total = viewer.findMatches.length;
        viewer.findIndex = ((index % total) + total) % total;
        const match = viewer.findMatches[viewer.findIndex];
        viewer.highlightQuery = viewer.findQuery;
        updateViewerChrome();
        await renderPdfPage(match.page);
    }

    async function openPdfViewer(docId, page, highlightQuery) {
        const overlay = $('instrPdfOverlay');
        if (!overlay) return;

        const doc = await resolveDocument(docId);
        if (!doc) {
            setStatus('Документ не найден');
            return;
        }
        if (doc.kind === 'docx' || doc.kind === 'xlsx' || (doc.mime && !String(doc.mime).includes('pdf'))) {
            setStatus('Word и Excel смотрятся по индексу, без PDF-ридера');
            window.setTimeout(() => setStatus(''), 2800);
            return;
        }

        if (viewer?.resizeObs) {
            try { viewer.resizeObs.disconnect(); } catch (_) { /* ignore */ }
        }
        if (viewer?.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
        }
        if (viewer?.pdf) {
            try { viewer.pdf.destroy(); } catch (_) { /* ignore */ }
        }
        const openGen = (viewer?.gen || 0) + 1;
        viewer = null;

        const titleEl = $('instrPdfTitle');
        if (titleEl) titleEl.textContent = doc.title || 'Документ';
        const findInput = $('instrPdfFindInput');
        if (findInput) findInput.value = String(highlightQuery || '').trim();
        const findCount = $('instrPdfFindCount');
        if (findCount) findCount.textContent = '0 из 0';
        const pageTotal = $('instrPdfPageTotal');
        if (pageTotal) pageTotal.textContent = '…';
        const pageInput = $('instrPdfPageInput');
        if (pageInput) pageInput.value = String(Math.max(1, Number(page) || 1));

        const stage = $('instrPdfStage');
        if (stage) {
            stage.innerHTML = '<p class="instr-pdf-loading">Загрузка PDF…</p>';
        }

        overlay.hidden = false;
        overlay.setAttribute('aria-hidden', 'false');
        document.body.classList.add('release-overlay-open');

        try {
            const blob = await loadBlob(doc);
            if (!blob) throw new Error('Файл недоступен');

            const lib = await loadPdfJs();
            const src = new Uint8Array(await blob.arrayBuffer());
            const data = src.slice();
            const pdf = await lib.getDocument({ data }).promise;
            if (viewer && viewer.gen > openGen) {
                try { pdf.destroy(); } catch (_) { /* ignore */ }
                return;
            }

            const pageNum = Math.min(Math.max(1, Number(page) || 1), pdf.numPages || 1);

            viewer = {
                gen: openGen,
                doc,
                pdf,
                pageNum,
                totalPages: pdf.numPages || 1,
                rendering: false,
                pageTexts: [],
                findQuery: '',
                findMatches: [],
                findIndex: -1,
                highlightQuery: String(highlightQuery || '').trim(),
                resizeObs: null,
                renderTask: null,
                touchStartX: 0,
                touchStartY: 0
            };

            updateViewerChrome();
            await renderPdfPage(pageNum);
            if (!viewer || viewer.gen !== openGen) return;

            if (viewer.highlightQuery) {
                applyTextHighlights($('instrPdfTextLayer'));
            }

            const stageEl = $('instrPdfStage');
            if (stageEl && typeof ResizeObserver !== 'undefined') {
                viewer.resizeObs = new ResizeObserver(() => {
                    if (!viewer?.pdf || viewer.rendering || viewer.gen !== openGen) return;
                    window.clearTimeout(viewer._resizeTimer);
                    viewer._resizeTimer = window.setTimeout(() => {
                        if (viewer?.pdf && viewer.gen === openGen) {
                            renderPdfPage(viewer.pageNum);
                        }
                    }, 180);
                });
                viewer.resizeObs.observe(stageEl);
            }
        } catch (err) {
            console.warn('[instructions] viewer', err);
            const stageEl = $('instrPdfStage');
            if (stageEl) {
                stageEl.innerHTML = `<p class="instr-empty">Не удалось открыть документ. ${escapeHtml(err.message || '')}</p>`;
            }
            if (titleEl) titleEl.textContent = doc.title || 'Документ';
        }
    }

    function closePdfViewer(hideOverlay = true) {
        if (viewer?.resizeObs) {
            try { viewer.resizeObs.disconnect(); } catch (_) { /* ignore */ }
        }
        if (viewer?.renderTask) {
            try { viewer.renderTask.cancel(); } catch (_) { /* ignore */ }
        }
        if (viewer?.pdf) {
            try { viewer.pdf.destroy(); } catch (_) { /* ignore */ }
        }
        viewer = null;
        const findInput = $('instrPdfFindInput');
        if (findInput) findInput.value = '';
        const findCount = $('instrPdfFindCount');
        if (findCount) findCount.textContent = '0 из 0';
        const titleEl = $('instrPdfTitle');
        if (titleEl) titleEl.textContent = 'Документ';
        const pageTotal = $('instrPdfPageTotal');
        if (pageTotal) pageTotal.textContent = '1';
        const pageInput = $('instrPdfPageInput');
        if (pageInput) {
            pageInput.value = '1';
            pageInput.max = '1';
        }
        const scrubber = $('instrPdfPageScrubber');
        if (scrubber) {
            scrubber.value = '1';
            scrubber.max = '1';
        }

        if (!hideOverlay) return;
        const overlay = $('instrPdfOverlay');
        if (!overlay) return;
        overlay.hidden = true;
        overlay.setAttribute('aria-hidden', 'true');
        document.body.classList.remove('release-overlay-open');

        const stage = $('instrPdfStage');
        if (stage) stage.innerHTML = '';
    }

    function bindUi() {
        if (uiBound) return;
        uiBound = true;

        $('instrSearchInput')?.addEventListener('input', (e) => {
            window.clearTimeout(searchDebounceTimer);
            const value = e.target.value;
            searchDebounceTimer = window.setTimeout(() => {
                renderDocuments(value);
            }, 220);
        });

        $('instrFsBack')?.addEventListener('click', () => {
            goBack();
        });

        const pane = $('instrPaneFiles');
        const foldersHost = $('instrFolders');

        function hideItemMenu() {
            const menu = $('instrItemMenu');
            if (menu) menu.hidden = true;
        }

        function itemFromTarget(target) {
            const folder = target?.closest?.('[data-folder-id]');
            if (folder && pane?.contains(folder)) {
                return {
                    kind: 'folder',
                    id: folder.dataset.folderId,
                    locked: folder.hasAttribute('data-static')
                };
            }
            const card = target?.closest?.('[data-doc-card]');
            if (card && pane?.contains(card)) {
                return {
                    kind: 'doc',
                    id: card.dataset.docCard,
                    locked: isStaticItem(card.dataset.docCard)
                };
            }
            return null;
        }

        function placeItemMenu(x, y) {
            const menu = $('instrItemMenu');
            if (!menu) return;
            menu.hidden = false;
            const pad = 8;
            const w = menu.offsetWidth;
            const h = menu.offsetHeight;
            let left = x;
            let top = y;
            if (left + w > window.innerWidth - pad) left = window.innerWidth - w - pad;
            if (top + h > window.innerHeight - pad) top = window.innerHeight - h - pad;
            menu.style.left = `${Math.max(pad, left)}px`;
            menu.style.top = `${Math.max(pad, top)}px`;
        }

        function showItemMenuAt(x, y, item) {
            if (!item) return;
            hideItemMenu();
            if (item.locked) {
                setStatus('Основная документация — нельзя удалить');
                window.setTimeout(() => setStatus(''), 2500);
                return;
            }
            const menu = $('instrItemMenu');
            if (!menu) return;
            menu.dataset.kind = item.kind;
            menu.dataset.id = item.id;
            placeItemMenu(x, y);
            itemMenuHoldUntil = Date.now() + 500;
            suppressDocClick = true;
            window.setTimeout(() => {
                suppressDocClick = false;
            }, 450);
        }

        pane?.addEventListener('click', (e) => {
            if (e.target.closest('#instrItemMenu')) return;
            if (suppressDocClick) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const btn = e.target.closest('[data-folder-id]');
            if (!btn || !pane.contains(btn)) return;
            enterFolder(btn.dataset.folderId);
        });

        let pressTimer = 0;
        let pressStart = null;
        const cancelPress = () => {
            window.clearTimeout(pressTimer);
            pressStart = null;
        };
        pane?.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            const item = itemFromTarget(e.target);
            if (!item || item.locked) return;
            pressStart = { x: e.clientX, y: e.clientY, item };
            window.clearTimeout(pressTimer);
            pressTimer = window.setTimeout(() => {
                if (!pressStart) return;
                showItemMenuAt(pressStart.x, pressStart.y, pressStart.item);
                pressStart = null;
            }, 520);
        });
        pane?.addEventListener('pointermove', (e) => {
            if (!pressStart) return;
            const dx = e.clientX - pressStart.x;
            const dy = e.clientY - pressStart.y;
            if ((dx * dx) + (dy * dy) > 100) cancelPress();
        });
        pane?.addEventListener('pointerup', cancelPress);
        pane?.addEventListener('pointercancel', cancelPress);
        pane?.addEventListener('contextmenu', (e) => {
            const item = itemFromTarget(e.target);
            if (!item) return;
            e.preventDefault();
            showItemMenuAt(e.clientX, e.clientY, item);
        });

        $('instrItemMenu')?.addEventListener('click', (e) => {
            const btn = e.target.closest('[data-instr-ctx]');
            if (!btn) return;
            e.stopPropagation();
            const menu = $('instrItemMenu');
            const kind = menu?.dataset.kind;
            const id = menu?.dataset.id;
            hideItemMenu();
            if (btn.dataset.instrCtx !== 'delete' || !id) return;
            if (kind === 'folder') deleteUserFolder(id);
            else if (kind === 'doc') deleteDocument(id);
        });

        foldersHost?.addEventListener('dragover', (e) => {
            const folder = e.target.closest('[data-folder-id]');
            if (!folder || folder.hasAttribute('data-static') || !dragDocId) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            foldersHost.querySelectorAll('.instr-folder.is-drop-target').forEach((el) => {
                if (el !== folder) el.classList.remove('is-drop-target');
            });
            folder.classList.add('is-drop-target');
        });
        foldersHost?.addEventListener('dragleave', (e) => {
            const folder = e.target.closest('[data-folder-id]');
            if (!folder) return;
            if (folder.contains(e.relatedTarget)) return;
            folder.classList.remove('is-drop-target');
        });
        foldersHost?.addEventListener('drop', async (e) => {
            const folder = e.target.closest('[data-folder-id]');
            foldersHost.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
            if (!folder) return;
            e.preventDefault();
            const docId = e.dataTransfer.getData('text/instr-doc-id') || dragDocId;
            dragDocId = null;
            if (!docId) return;
            suppressDocClick = true;
            await moveDocToFolder(docId, folder.dataset.folderId);
            window.setTimeout(() => {
                suppressDocClick = false;
            }, 0);
        });

        const docsHost = $('instrDocs');
        docsHost?.addEventListener('dragstart', (e) => {
            const card = e.target.closest('[data-doc-card]');
            if (!card || !card.getAttribute('draggable')) {
                e.preventDefault();
                return;
            }
            dragDocId = card.dataset.docCard;
            e.dataTransfer.setData('text/instr-doc-id', dragDocId);
            e.dataTransfer.effectAllowed = 'move';
            card.classList.add('is-dragging');
        });
        docsHost?.addEventListener('dragend', () => {
            dragDocId = null;
            docsHost.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
            foldersHost?.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
        });

        docsHost?.addEventListener('click', (e) => {
            if (suppressDocClick) {
                e.preventDefault();
                e.stopPropagation();
                return;
            }
            const delBtn = e.target.closest('[data-doc-delete]');
            if (delBtn) {
                e.preventDefault();
                e.stopPropagation();
                deleteDocument(delBtn.dataset.docDelete);
                return;
            }
            const hit = e.target.closest('.instr-hit');
            if (hit) {
                openPdfViewer(hit.dataset.docId, Number(hit.dataset.page) || 1, hit.dataset.highlight || '');
                return;
            }
            const toggle = e.target.closest('[data-doc-toggle]');
            if (toggle) {
                const card = toggle.closest('.instr-doc-card');
                if (!card) return;
                const open = card.classList.toggle('is-open');
                toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
                return;
            }
            const openBtn = e.target.closest('[data-doc-open]');
            if (openBtn) {
                openPdfViewer(openBtn.dataset.docOpen, 1, $('instrSearchInput')?.value || '');
            }
        });

        $('instrFab')?.addEventListener('click', (e) => {
            e.stopPropagation();
            const menu = $('instrFabMenu');
            setFabMenuOpen(!!menu?.hidden);
        });

        $('instrFabMenu')?.addEventListener('click', (e) => {
            const item = e.target.closest('[data-fab-action]');
            if (!item) return;
            e.stopPropagation();
            setFabMenuOpen(false);
            if (item.dataset.fabAction === 'upload') {
                $('instrFileInput')?.click();
            } else if (item.dataset.fabAction === 'folder') {
                window.setTimeout(() => {
                    createUserFolder();
                }, 0);
            }
        });

        document.addEventListener('click', (e) => {
            const wrap = document.querySelector('.instr-fab-wrap');
            if (wrap && !wrap.contains(e.target)) setFabMenuOpen(false);
            if (Date.now() < itemMenuHoldUntil) return;
            if (!e.target.closest('#instrItemMenu')) hideItemMenu();
        });

        $('instrNameDialogOk')?.addEventListener('click', () => {
            closeNameDialog($('instrNameDialogInput')?.value ?? '');
        });
        $('instrNameDialog')?.addEventListener('click', (e) => {
            if (e.target.closest('[data-instr-name-cancel]')) {
                closeNameDialog(null);
            }
        });
        $('instrNameDialogInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                closeNameDialog(e.target.value);
            } else if (e.key === 'Escape') {
                e.preventDefault();
                closeNameDialog(null);
            }
        });

        $('instrFileInput')?.addEventListener('change', async (e) => {
            const input = e.target;
            await handleUploadFiles(input.files);
            input.value = '';
        });

        $('instrPdfCloseBtn')?.addEventListener('click', () => closePdfViewer(true));

        $('instrPdfPrev')?.addEventListener('click', () => {
            if (!viewer?.pdf) return;
            renderPdfPage(viewer.pageNum - 1);
        });
        $('instrPdfNext')?.addEventListener('click', () => {
            if (!viewer?.pdf) return;
            renderPdfPage(viewer.pageNum + 1);
        });

        $('instrPdfPageInput')?.addEventListener('change', (e) => {
            if (!viewer?.pdf) return;
            renderPdfPage(Number(e.target.value) || 1);
        });

        $('instrPdfPageScrubber')?.addEventListener('input', (e) => {
            if (!viewer?.pdf) return;
            const page = Number(e.target.value) || 1;
            viewer.pageNum = page;
            updateViewerChrome();
            window.clearTimeout(viewer._scrubTimer);
            viewer._scrubTimer = window.setTimeout(() => renderPdfPage(page), 60);
        });

        let findTimer = null;
        $('instrPdfFindInput')?.addEventListener('input', (e) => {
            window.clearTimeout(findTimer);
            const value = e.target.value;
            findTimer = window.setTimeout(() => runPdfFind(value, true), 250);
        });
        $('instrPdfFindInput')?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                if (e.shiftKey) goToFindMatch((viewer?.findIndex || 0) - 1);
                else goToFindMatch((viewer?.findIndex || 0) + 1);
            }
        });
        $('instrPdfFindPrev')?.addEventListener('click', () => goToFindMatch((viewer?.findIndex || 0) - 1));
        $('instrPdfFindNext')?.addEventListener('click', () => goToFindMatch((viewer?.findIndex || 0) + 1));

        const stage = $('instrPdfStage');
        stage?.addEventListener('touchstart', (e) => {
            if (!viewer || !e.changedTouches?.[0]) return;
            viewer.touchStartX = e.changedTouches[0].clientX;
            viewer.touchStartY = e.changedTouches[0].clientY;
        }, { passive: true });
        stage?.addEventListener('touchend', (e) => {
            if (!viewer?.pdf || !e.changedTouches?.[0]) return;
            const dx = e.changedTouches[0].clientX - (viewer.touchStartX || 0);
            const dy = e.changedTouches[0].clientY - (viewer.touchStartY || 0);
            if (Math.abs(dx) < 56 || Math.abs(dx) < Math.abs(dy) * 1.2) return;
            if (dx < 0) renderPdfPage(viewer.pageNum + 1);
            else renderPdfPage(viewer.pageNum - 1);
        }, { passive: true });

        document.addEventListener('keydown', (e) => {
            const nameDialog = $('instrNameDialog');
            if (nameDialog && !nameDialog.hidden && e.key === 'Escape') {
                e.preventDefault();
                closeNameDialog(null);
                return;
            }
            if (e.key === 'Escape') hideItemMenu();
            const overlay = $('instrPdfOverlay');
            if (!overlay || overlay.hidden || !viewer?.pdf) return;
            if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) return;
            if (e.key === 'ArrowLeft') {
                e.preventDefault();
                renderPdfPage(viewer.pageNum - 1);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                renderPdfPage(viewer.pageNum + 1);
            } else if (e.key === 'Escape') {
                closePdfViewer(true);
            }
        });
    }

    async function initInstructionsModule() {
        bindUi();
        try {
            await refreshUi();
        } catch (err) {
            console.warn('[instructions] init', err);
            setStatus('Не удалось открыть локальную базу инструкций');
        }
    }

    window.InstructionsModule = {
        init: initInstructionsModule,
        refresh: refreshUi
    };
})();