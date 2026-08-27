/**
 * Локальный сервер админки.
 * Читает/пишет только whitelist путей внутри ../app и ./data.
 * Запуск: npm start → http://127.0.0.1:8790
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractOfficeText } from './js/office-extract.mjs';
import { sanitizeOcrText } from './js/sanitize-ocr.mjs';
import { probeOcr, startOcrJob, getJob, getJobImagePath, ensureOcrDirs, jobPublic, ensureOcrDaemon } from './js/local-ocr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const APP_ROOT = path.resolve(ROOT, '..', 'app');
const HOST = '127.0.0.1';
const PORT = Number(process.env.ADMIN_PORT || 8790);

/** Разрешённые относительные пути от APP_ROOT */
const APP_FILE_WHITELIST = new Set([
    'spr.json',
    'data/line-sections.json',
    'data/release-notes.json',
    'data/calendar-local-routes.json',
    'data/instructions/index.json',
    'data/instructions/catalog.json'
]);

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.tif': 'image/tiff',
    '.tiff': 'image/tiff',
    '.pdf': 'application/pdf',
    '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    '.ico': 'image/x-icon'
};

function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body)
        ? body
        : JSON.stringify(body);
    res.writeHead(status, {
        'Cache-Control': 'no-store',
        ...headers
    });
    res.end(payload);
}

function sendJson(res, status, obj) {
    send(res, status, obj, { 'Content-Type': 'application/json; charset=utf-8' });
}

function safeResolveUnder(base, rel) {
    const cleaned = String(rel || '').replace(/^[/\\]+/, '').replace(/\\/g, '/');
    if (!cleaned || cleaned.includes('..')) return null;
    const abs = path.resolve(base, cleaned);
    if (!abs.startsWith(base + path.sep) && abs !== base) return null;
    return abs;
}

function isAppWhitelisted(rel) {
    const normalized = String(rel || '').replace(/\\/g, '/');
    if (APP_FILE_WHITELIST.has(normalized)) return true;
    // чанки и pdf регламентов
    if (/^data\/instructions\/chunks\/[A-Za-z0-9._-]+\.json$/.test(normalized)) return true;
    if (/^data\/instructions\/pdf\/[A-Za-z0-9._-]+\.pdf$/i.test(normalized)) return true;
    if (/^data\/instructions\/files\/[A-Za-z0-9._-]+\.(pdf|docx|xlsx|png|jpe?g|tiff?)$/i.test(normalized)) return true;
    return false;
}

async function readBody(req, limit = 40 * 1024 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) throw new Error('Body too large');
        chunks.push(chunk);
    }
    return Buffer.concat(chunks);
}

async function ensureInstructionsDirs() {
    const dirs = [
        path.join(APP_ROOT, 'data', 'instructions'),
        path.join(APP_ROOT, 'data', 'instructions', 'chunks'),
        path.join(APP_ROOT, 'data', 'instructions', 'pdf'),
        path.join(APP_ROOT, 'data', 'instructions', 'files'),
        path.join(ROOT, 'data')
    ];
    for (const dir of dirs) {
        await fs.mkdir(dir, { recursive: true });
    }
    const catalogPath = path.join(APP_ROOT, 'data', 'instructions', 'catalog.json');
    try {
        await fs.access(catalogPath);
    } catch {
        await fs.writeFile(catalogPath, JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString().slice(0, 10),
            folders: [],
            documents: []
        }, null, 2), 'utf8');
    }
    const indexPath = path.join(APP_ROOT, 'data', 'instructions', 'index.json');
    try {
        await fs.access(indexPath);
    } catch {
        await fs.writeFile(indexPath, JSON.stringify({
            version: 1,
            updatedAt: new Date().toISOString().slice(0, 10),
            docs: [],
            chunkCount: 0
        }, null, 2), 'utf8');
    }
}

async function handleApi(req, res, url) {
    if (url.pathname === '/api/health') {
        const ocr = await probeOcr();
        return sendJson(res, 200, { ok: true, appRoot: APP_ROOT, ocr });
    }

    if (url.pathname === '/api/files' && req.method === 'GET') {
        return sendJson(res, 200, {
            app: [...APP_FILE_WHITELIST],
            note: 'Также разрешены chunks/*.json, pdf/*.pdf и files/*.(pdf|docx|xlsx)'
        });
    }

    // GET /api/app-file?path=spr.json | data/instructions/pdf/….pdf
    if (url.pathname === '/api/app-file' && req.method === 'GET') {
        const rel = url.searchParams.get('path') || '';
        if (!isAppWhitelisted(rel)) return sendJson(res, 403, { error: 'path not allowed' });
        const abs = safeResolveUnder(APP_ROOT, rel);
        if (!abs) return sendJson(res, 400, { error: 'bad path' });
        try {
            const ext = path.extname(abs).toLowerCase();
            if (ext === '.json') {
                const raw = await fs.readFile(abs, 'utf8');
                return send(res, 200, raw, { 'Content-Type': 'application/json; charset=utf-8' });
            }
            const data = await fs.readFile(abs);
            return send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        } catch (err) {
            if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'not found' });
            return sendJson(res, 500, { error: String(err.message || err) });
        }
    }

    // PUT /api/app-file?path=spr.json  body: JSON
    if (url.pathname === '/api/app-file' && req.method === 'PUT') {
        const rel = url.searchParams.get('path') || '';
        if (!isAppWhitelisted(rel)) return sendJson(res, 403, { error: 'path not allowed' });
        const abs = safeResolveUnder(APP_ROOT, rel);
        if (!abs) return sendJson(res, 400, { error: 'bad path' });
        try {
            const buf = await readBody(req);
            const text = buf.toString('utf8');
            JSON.parse(text); // validate JSON
            await fs.mkdir(path.dirname(abs), { recursive: true });
            // backup
            try {
                await fs.copyFile(abs, `${abs}.bak`);
            } catch (_) { /* no previous */ }
            await fs.writeFile(abs, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
            return sendJson(res, 200, { ok: true, path: rel, bytes: Buffer.byteLength(text) });
        } catch (err) {
            return sendJson(res, 400, { error: String(err.message || err) });
        }
    }

    // POST /api/upload-pdf?docId=xxx  body: binary pdf
    if (url.pathname === '/api/upload-pdf' && req.method === 'POST') {
        const docId = String(url.searchParams.get('docId') || '').replace(/[^A-Za-z0-9._-]/g, '');
        if (!docId) return sendJson(res, 400, { error: 'docId required' });
        const rel = `data/instructions/pdf/${docId}.pdf`;
        const abs = safeResolveUnder(APP_ROOT, rel);
        if (!abs) return sendJson(res, 400, { error: 'bad path' });
        try {
            const buf = await readBody(req, 80 * 1024 * 1024);
            if (!buf.length) return sendJson(res, 400, { error: 'empty body' });
            const head = buf.slice(0, 5).toString('utf8');
            if (!head.startsWith('%PDF')) {
                return sendJson(res, 400, { error: `not a PDF (got "${head.replace(/\n/g, ' ')}")` });
            }
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, buf);
            return sendJson(res, 200, { ok: true, path: rel, bytes: buf.length, kind: 'pdf' });
        } catch (err) {
            console.error('[upload-pdf]', err);
            return sendJson(res, 500, { error: String(err.message || err) });
        }
    }

    // POST /api/upload-doc?docId=&ext=pdf|docx|xlsx
    if (url.pathname === '/api/upload-doc' && req.method === 'POST') {
        const docId = String(url.searchParams.get('docId') || '').replace(/[^A-Za-z0-9._-]/g, '');
        const ext = String(url.searchParams.get('ext') || '').replace(/^\./, '').toLowerCase();
        if (!docId) return sendJson(res, 400, { error: 'docId required' });
        if (!['pdf', 'docx', 'xlsx', 'png', 'jpg', 'jpeg', 'tif', 'tiff'].includes(ext)) {
            return sendJson(res, 400, { error: 'нужен pdf, docx, xlsx или изображение' });
        }
        const folder = ext === 'pdf' ? 'pdf' : 'files';
        const rel = `data/instructions/${folder}/${docId}.${ext}`;
        const abs = safeResolveUnder(APP_ROOT, rel);
        if (!abs) return sendJson(res, 400, { error: 'bad path' });
        try {
            const buf = await readBody(req, 80 * 1024 * 1024);
            if (!buf.length) return sendJson(res, 400, { error: 'empty body' });
            if (ext === 'pdf') {
                const head = buf.slice(0, 5).toString('utf8');
                if (!head.startsWith('%PDF')) {
                    return sendJson(res, 400, { error: 'это не PDF' });
                }
            } else if (['docx', 'xlsx'].includes(ext) && buf.slice(0, 2).toString('utf8') !== 'PK') {
                return sendJson(res, 400, { error: `нужен .${ext} (Office Open XML), не старый .doc/.xls` });
            }
            await fs.mkdir(path.dirname(abs), { recursive: true });
            await fs.writeFile(abs, buf);
            return sendJson(res, 200, { ok: true, path: rel, bytes: buf.length, kind: ext === 'jpeg' ? 'jpg' : ext });
        } catch (err) {
            console.error('[upload-doc]', err);
            return sendJson(res, 500, { error: String(err.message || err) });
        }
    }

    // POST /api/extract-office?path=data/instructions/files/xxx.docx
    if (url.pathname === '/api/extract-office' && req.method === 'POST') {
        const rel = url.searchParams.get('path') || '';
        if (!isAppWhitelisted(rel)) return sendJson(res, 403, { error: 'path not allowed' });
        const abs = safeResolveUnder(APP_ROOT, rel);
        if (!abs) return sendJson(res, 400, { error: 'bad path' });
        try {
            const buf = await fs.readFile(abs);
            const ext = path.extname(abs).slice(1);
            const pageTexts = extractOfficeText(buf, ext);
            return sendJson(res, 200, { ok: true, pageCount: pageTexts.length, pageTexts });
        } catch (err) {
            console.error('[extract-office]', err);
            return sendJson(res, 400, { error: String(err.message || err) });
        }
    }

    if (url.pathname === '/api/ocr/probe' && req.method === 'GET') {
        return sendJson(res, 200, await probeOcr());
    }

    if (url.pathname === '/api/ocr/sanitize' && req.method === 'POST') {
        try {
            const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString('utf8') || '{}');
            return sendJson(res, 200, { text: sanitizeOcrText(body.text || '') });
        } catch (err) {
            return sendJson(res, 400, { error: String(err.message || err) });
        }
    }

    if (url.pathname === '/api/ocr/jobs' && req.method === 'POST') {
        try {
            const body = JSON.parse((await readBody(req, 1024 * 1024)).toString('utf8') || '{}');
            const rel = String(body.path || '');
            if (!isAppWhitelisted(rel)) return sendJson(res, 403, { error: 'path not allowed' });
            const abs = safeResolveUnder(APP_ROOT, rel);
            if (!abs) return sendJson(res, 400, { error: 'bad path' });
            try {
                await fs.access(abs);
            } catch {
                return sendJson(res, 404, { error: 'file not found' });
            }
            const job = await startOcrJob({ absPath: abs, docId: body.docId || null });
            return sendJson(res, 200, job);
        } catch (err) {
            console.error('[ocr/jobs]', err);
            return sendJson(res, 400, { error: String(err.message || err) });
        }
    }

    const jobGet = url.pathname.match(/^\/api\/ocr\/jobs\/([^/]+)$/);
    if (jobGet && req.method === 'GET') {
        const job = getJob(jobGet[1]);
        if (!job) return sendJson(res, 404, { error: 'job not found' });
        return sendJson(res, 200, jobPublic(job));
    }

    const jobPage = url.pathname.match(/^\/api\/ocr\/jobs\/([^/]+)\/page\/(\d+)$/);
    if (jobPage && req.method === 'GET') {
        const img = getJobImagePath(jobPage[1], jobPage[2]);
        if (!img) return sendJson(res, 404, { error: 'page not ready' });
        try {
            const data = await fs.readFile(img);
            const ext = path.extname(img).toLowerCase();
            return send(res, 200, data, { 'Content-Type': MIME[ext] || 'image/png' });
        } catch {
            return sendJson(res, 404, { error: 'page missing' });
        }
    }

    return sendJson(res, 404, { error: 'unknown api' });
}

async function serveStatic(req, res, url) {
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/Index.html';

    // прокси к pdf.js из app/vendor
    if (rel.startsWith('/vendor/')) {
        const abs = safeResolveUnder(APP_ROOT, rel.slice(1));
        if (!abs) return sendJson(res, 403, { error: 'forbidden' });
        try {
            const data = await fs.readFile(abs);
            const ext = path.extname(abs).toLowerCase();
            return send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
        } catch {
            return sendJson(res, 404, { error: 'not found' });
        }
    }

    const abs = safeResolveUnder(ROOT, rel.slice(1));
    if (!abs) return sendJson(res, 403, { error: 'forbidden' });
    try {
        const data = await fs.readFile(abs);
        const ext = path.extname(abs).toLowerCase();
        return send(res, 200, data, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    } catch {
        return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
}

async function loadEnvFile(file) {
    try {
        const raw = await fs.readFile(file, 'utf8');
        for (const line of raw.split(/\n/)) {
            const t = line.trim();
            if (!t || t.startsWith('#')) continue;
            const eq = t.indexOf('=');
            if (eq < 0) continue;
            const key = t.slice(0, eq).trim();
            let val = t.slice(eq + 1).trim();
            if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
                val = val.slice(1, -1);
            }
            if (key && process.env[key] == null) process.env[key] = val;
        }
    } catch { /* optional */ }
}

await loadEnvFile(path.join(ROOT, '.env'));
await ensureInstructionsDirs();
await ensureOcrDirs();

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url || '/', `http://${HOST}:${PORT}`);
        if (url.pathname.startsWith('/api/')) {
            return await handleApi(req, res, url);
        }
        return await serveStatic(req, res, url);
    } catch (err) {
        console.error(err);
        sendJson(res, 500, { error: String(err.message || err) });
    }
});

server.listen(PORT, HOST, () => {
    console.log(`\n  Admin → http://${HOST}:${PORT}`);
    console.log(`  App data → ${APP_ROOT}\n`);
    ensureOcrDaemon().then((info) => {
        const device = String(info.device || 'cpu').toLowerCase() === 'cuda' ? 'CUDA' : 'CPU';
        console.log(`  Occular OCR · stdin · ${device} ${info.version || ''} · модель в RAM`);
    }).catch((err) => {
        console.error('  Occular OCR:', err.message || err);
    });
});
