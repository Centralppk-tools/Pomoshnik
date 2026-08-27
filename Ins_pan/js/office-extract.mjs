/**
 * Минимальное извлечение текста из OOXML (docx / xlsx) без npm-зависимостей.
 */
import zlib from 'node:zlib';

function decodeXml(str) {
    return String(str || '')
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function unzip(buf) {
    const files = {};
    let eocd = -1;
    for (let i = buf.length - 22; i >= 0; i -= 1) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error('файл не ZIP/OOXML');
    const count = buf.readUInt16LE(eocd + 10);
    let cd = buf.readUInt32LE(eocd + 16);
    for (let n = 0; n < count; n += 1) {
        if (buf.readUInt32LE(cd) !== 0x02014b50) break;
        const method = buf.readUInt16LE(cd + 10);
        const compSize = buf.readUInt32LE(cd + 20);
        const nameLen = buf.readUInt16LE(cd + 28);
        const extraLen = buf.readUInt16LE(cd + 30);
        const commentLen = buf.readUInt16LE(cd + 32);
        const localOff = buf.readUInt32LE(cd + 42);
        const name = buf.slice(cd + 46, cd + 46 + nameLen).toString('utf8');
        const lName = buf.readUInt16LE(localOff + 26);
        const lExtra = buf.readUInt16LE(localOff + 28);
        const dataStart = localOff + 30 + lName + lExtra;
        const compressed = buf.slice(dataStart, dataStart + compSize);
        let data;
        if (method === 0) data = compressed;
        else if (method === 8) data = zlib.inflateRawSync(compressed);
        else throw new Error(`zip method ${method} не поддерживается`);
        files[name] = data;
        cd += 46 + nameLen + extraLen + commentLen;
    }
    return files;
}

function extractDocx(files) {
    const raw = files['word/document.xml'];
    if (!raw) throw new Error('в docx нет word/document.xml');
    const xml = raw.toString('utf8');
    const paras = xml.split(/<\/w:p>/).map((p) => {
        const parts = [...p.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((m) => decodeXml(m[1]));
        return parts.join('').replace(/\s+/g, ' ').trim();
    }).filter(Boolean);
    const pageTexts = [];
    let buf = '';
    paras.forEach((p) => {
        if (buf.length + p.length > 1800 && buf) {
            pageTexts.push(buf.trim());
            buf = p;
        } else {
            buf = buf ? `${buf}\n${p}` : p;
        }
    });
    if (buf.trim()) pageTexts.push(buf.trim());
    return pageTexts.length ? pageTexts : [''];
}

function extractXlsx(files) {
    const shared = [];
    const ss = files['xl/sharedStrings.xml'];
    if (ss) {
        const xml = ss.toString('utf8');
        const blocks = xml.match(/<si[\s\S]*?<\/si>/g) || [];
        blocks.forEach((block) => {
            const texts = [...block.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decodeXml(m[1]));
            shared.push(texts.join(''));
        });
    }
    const sheets = Object.keys(files)
        .filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/i.test(k))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    if (!sheets.length) return [shared.filter(Boolean).join('\n')];
    return sheets.map((name) => {
        const xml = files[name].toString('utf8');
        const rows = xml.match(/<row[\s\S]*?<\/row>/g) || [];
        const lines = rows.map((row) => {
            const cells = [...row.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)];
            return cells.map(([, attrs, inner]) => {
                const isShared = /\bt="s"/.test(attrs);
                const v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
                if (v == null) return '';
                if (isShared) return shared[Number(v)] || '';
                return decodeXml(v);
            }).filter(Boolean).join('\t');
        }).filter(Boolean);
        return lines.join('\n');
    });
}

export function extractOfficeText(buf, ext) {
    const kind = String(ext || '').replace(/^\./, '').toLowerCase();
    const files = unzip(buf);
    if (kind === 'docx') return extractDocx(files);
    if (kind === 'xlsx') return extractXlsx(files);
    throw new Error(`формат .${kind} не поддерживается (нужен docx или xlsx)`);
}
