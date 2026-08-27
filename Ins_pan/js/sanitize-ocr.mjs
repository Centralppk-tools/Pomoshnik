/**
 * Нормализация текста: отточия оглавления, без ##, аббревиатуры не трогаем.
 * ЧМ, НМ, ТМ, ТО1, ТО2, ТР1, МВПС, ЭПС, АЛСН, КЛУБ, САУТ, РБ, ЦППК.
 */

function cleanTocLine(line) {
    let s = String(line || '').replace(/^#+\s+/, '');
    const toc = s.match(
        /^(\s*)(\d+(?:\.\d+){0,5}\.?|[IVXLC]{1,8}\.?)\s+(.+?)\s+(\d{1,4})\s*$/
    );
    if (toc) {
        const title = toc[3]
            .replace(/[.\-_·•…∙]{2,}/g, ' ')
            .replace(/[^\S\n]+/g, ' ')
            .trim();
        return `${toc[1]}${toc[2]} ${title}`.replace(/[^\S\n]+/g, ' ').trimEnd();
    }
    if (/[.\-_·•…∙]{3,}/.test(s)) {
        s = s.replace(/[.\-_·•…∙]{2,}/g, ' ');
    }
    return s;
}

export function sanitizeOcrText(raw) {
    let text = String(raw || '').replace(/\r\n?/g, '\n');
    text = text.replace(/([A-Za-zА-Яа-яЁё0-9])-\n([A-Za-zА-Яа-яЁё0-9])/g, '$1$2');
    text = text.replace(/[\u00A0\u200B-\u200D\uFEFF]/g, ' ');
    text = text.split('\n').map(cleanTocLine).join('\n');
    text = text.replace(/[^\S\n]+/g, ' ');
    text = text.replace(/ *\n */g, '\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}
