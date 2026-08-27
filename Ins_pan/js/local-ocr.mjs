/**
 * Локальный OCR: Occular (русский ONNX, CUDA или CPU) + гибридный слой PDF.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sanitizeOcrText } from './sanitize-ocr.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const JOBS_ROOT = path.join(ROOT, 'data', 'ocr-jobs');
const RUNNER = path.join(ROOT, 'ocr', 'ocr_runner.py');

const jobs = new Map();
let daemon = null;
let daemonReady = null;
let readyInfo = null;
let stdoutBuf = '';
let activeJob = null;
let activeWait = null;
const jobQueue = [];
let pumpBusy = false;

function cfg() {
    return {
        python: process.env.PYTHON_PATH || 'python',
        dpi: Number(process.env.OCR_DPI || 108),
        scale: Number(process.env.OCR_SCALE || 1.5),
        port: Number(process.env.OCR_PORT || 8791)
    };
}

function pythonEnv() {
    const c = cfg();
    return {
        ...process.env,
        PYTHONUNBUFFERED: '1',
        PYTHONIOENCODING: 'utf-8',
        OCR_PORT: String(c.port),
        OCR_DPI: String(c.dpi),
        OCR_SCALE: String(c.scale),
        OMP_NUM_THREADS: '2',
        MKL_NUM_THREADS: '2',
        OPENBLAS_NUM_THREADS: '2',
        ORT_INTRA_OP_NUM_THREADS: '2',
        ORT_INTER_OP_NUM_THREADS: '2'
    };
}

function pythonCandidates() {
    const c = cfg();
    const list = [];
    if (c.python) list.push({ bin: c.python, prefix: [] });
    list.push({ bin: 'py', prefix: ['-3'] });
    list.push({ bin: 'python', prefix: [] });
    const seen = new Set();
    return list.filter((x) => {
        const key = `${x.bin}|${x.prefix.join(',')}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function parseJsonLine(line) {
    const t = String(line || '').trim();
    if (!t.startsWith('{')) return null;
    try {
        return JSON.parse(t);
    } catch {
        return null;
    }
}

function daemonProbe() {
    if (daemon && daemon.exitCode == null && readyInfo && readyInfo.ok) return readyInfo;
    return null;
}

function onStdoutLine(line) {
    const msg = parseJsonLine(line);
    if (!msg) return;
    if (msg.event === 'ready' || (msg.ok && msg.engine && !msg.event)) {
        readyInfo = { ...msg, ok: true };
        return;
    }
    if (!activeJob) return;
    applyEvent(activeJob, msg);
    if (msg.event === 'done' || msg.event === 'error') {
        const wait = activeWait;
        const job = activeJob;
        activeJob = null;
        activeWait = null;
        pumpBusy = false;
        if (wait) {
            if (msg.event === 'error' || job.status === 'error') {
                wait.reject(new Error(job.error || msg.error || 'Occular OCR error'));
            } else {
                wait.resolve();
            }
        }
        pumpQueue();
    }
}

function attachDaemonIo(child) {
    stdoutBuf = '';
    child.stdout?.on('data', (d) => {
        stdoutBuf += d.toString('utf8');
        const parts = stdoutBuf.split(/\r?\n/);
        stdoutBuf = parts.pop() || '';
        for (const line of parts) onStdoutLine(line);
    });
    child.stderr?.on('data', (d) => {
        const s = d.toString('utf8').trim();
        if (s) console.error('[occular]', s.slice(0, 500));
    });
    child.on('exit', (code) => {
        if (daemon === child) {
            daemon = null;
            daemonReady = null;
            readyInfo = null;
        }
        if (activeWait) {
            activeWait.reject(new Error('Процесс Occular OCR завершился'));
            activeWait = null;
            activeJob = null;
            pumpBusy = false;
        }
        console.error('[occular] daemon exit', code);
    });
}

function spawnDaemon() {
    const attempts = pythonCandidates();
    let lastErr = null;
    for (const { bin, prefix } of attempts) {
        try {
            const child = spawn(bin, [...prefix, RUNNER, '--serve'], {
                windowsHide: true,
                env: pythonEnv(),
                cwd: ROOT,
                stdio: ['pipe', 'pipe', 'pipe']
            });
            attachDaemonIo(child);
            return child;
        } catch (err) {
            lastErr = err;
            if (err && err.code === 'ENOENT') continue;
            throw err;
        }
    }
    throw lastErr || new Error('Python не найден. Укажите PYTHON_PATH в Ins_pan/.env');
}

export async function ensureOcrDaemon() {
    const live = daemonProbe();
    if (live) return live;
    if (daemonReady) return daemonReady;
    daemonReady = (async () => {
        daemon = spawnDaemon();
        const deadline = Date.now() + 180000;
        while (Date.now() < deadline) {
            if (daemon && daemon.exitCode != null) {
                throw new Error('Процесс Occular OCR завершился при запуске');
            }
            const ok = daemonProbe();
            if (ok) return ok;
            await new Promise((r) => setTimeout(r, 400));
        }
        throw new Error(
            'Occular OCR не поднялась. python Ins_pan/ocr/preload_models.py'
        );
    })().catch((err) => {
        daemonReady = null;
        throw err;
    });
    return daemonReady;
}

/** @deprecated имя для совместимости со стартом server.mjs */
export const ensureSuryaDaemon = ensureOcrDaemon;

function killDaemon() {
    try {
        daemon?.kill();
    } catch { /* ignore */ }
    daemon = null;
    daemonReady = null;
}

process.on('exit', killDaemon);
process.on('SIGINT', () => { killDaemon(); process.exit(0); });
process.on('SIGTERM', () => { killDaemon(); process.exit(0); });

export async function probeOcr() {
    try {
        const live = daemonProbe();
        if (live) return live;
        return await ensureOcrDaemon();
    } catch (err) {
        return { ok: false, engine: 'occular', error: String(err.message || err) };
    }
}

export function jobPublic(job) {
    return {
        id: job.id,
        status: job.status,
        page: job.page,
        pageCount: job.pageCount,
        error: job.error,
        docId: job.docId,
        device: job.device || 'cpu',
        engine: 'occular',
        pages: (job.pages || []).map((p) => ({
            page: p.page,
            text: p.text,
            raw: p.raw
        }))
    };
}

export function getJob(id) {
    return jobs.get(id) || null;
}

export function getJobImagePath(id, pageNum) {
    const job = jobs.get(id);
    if (!job) return null;
    const rec = job.pages.find((p) => p.page === Number(pageNum));
    return rec?.image || null;
}

export async function startOcrJob({ absPath, docId }) {
    const id = `ocr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const dir = path.join(JOBS_ROOT, id);
    await fs.mkdir(dir, { recursive: true });
    const job = {
        id,
        docId: docId || null,
        status: 'queued',
        page: 0,
        pageCount: 0,
        error: null,
        device: 'cpu',
        dir,
        pages: [],
        source: absPath
    };
    jobs.set(id, job);
    runOcrJob(job).catch((err) => {
        job.status = 'error';
        job.error = String(err.message || err);
        console.error('[ocr]', job.id, job.error);
    });
    return jobPublic(job);
}

function applyEvent(job, msg) {
    if (!msg) return;
    if (msg.device) job.device = msg.device;
    if (msg.event === 'start') {
        job.pageCount = Number(msg.pageCount) || 0;
        job.pages = Array.from({ length: job.pageCount }, (_, i) => ({
            page: i + 1,
            image: path.join(job.dir, `page-${String(i + 1).padStart(4, '0')}.png`),
            raw: '',
            text: ''
        }));
        job.status = 'ocr';
    }
    if (msg.event === 'models') job.status = 'ocr';
    if (msg.event === 'page') {
        const i = Number(msg.page) - 1;
        job.page = Number(msg.page) || job.page;
        if (i >= 0) {
            if (!job.pages[i]) job.pages[i] = { page: i + 1, image: '', raw: '', text: '' };
            const md = String(msg.markdown || msg.text || '');
            job.pages[i] = {
                page: Number(msg.page) || i + 1,
                image: msg.image || job.pages[i].image,
                raw: md,
                text: sanitizeOcrText(md)
            };
        }
    }
    if (msg.event === 'error') {
        job.status = 'error';
        job.error = String(msg.error || 'Occular OCR error');
    }
    if (msg.event === 'done') {
        job.status = 'done';
        job.page = job.pageCount;
    }
}

function pumpQueue() {
    if (pumpBusy || !jobQueue.length || !daemon || daemon.exitCode != null || !readyInfo) return;
    const item = jobQueue.shift();
    pumpBusy = true;
    activeJob = item.job;
    activeWait = item;
    const { scale } = cfg();
    const payload = JSON.stringify({
        pdf_path: item.job.source,
        input: item.job.source,
        outDir: item.job.dir,
        scale
    });
    daemon.stdin.write(`${payload}\n`, 'utf8');
}

async function runOcrJob(job) {
    job.status = 'ocr';
    await ensureOcrDaemon();
    await new Promise((resolve, reject) => {
        jobQueue.push({ job, resolve, reject });
        pumpQueue();
    });
    if (job.status === 'error') throw new Error(job.error || 'Occular OCR error');
    job.status = 'done';
    job.page = job.pageCount;
}

export async function ensureOcrDirs() {
    await fs.mkdir(JOBS_ROOT, { recursive: true });
}
