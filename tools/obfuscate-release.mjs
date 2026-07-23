import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const releaseDir = process.argv[2];

if (!releaseDir) {
    console.error('Usage: node tools/obfuscate-release.mjs <Release/X.Y.Z>');
    process.exit(1);
}

function minifyJs(code) {
    return code
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
        .replace(/\s+/g, ' ')
        .replace(/\s*([{};,()[\]:=+\-*/<>!&|?])\s*/g, '$1')
        .trim();
}

function maskJs(code) {
    let out = minifyJs(code);
    out = out.replace(/'use strict';?/g, '');
    return out;
}

function obfuscateInlineScripts(html) {
    return html.replace(/<script(\s[^>]*)?>([\s\S]*?)<\/script>/gi, (full, attrs, body) => {
        if (attrs && /\ssrc\s*=/.test(attrs)) return full;
        const trimmed = body.trim();
        if (!trimmed) return full;
        return `<script${attrs || ''}>${maskJs(body)}</script>`;
    });
}

function walkJs(dir) {
    for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        const st = statSync(path);
        if (st.isDirectory()) {
            walkJs(path);
            continue;
        }
        if (!name.endsWith('.js')) continue;
        const src = readFileSync(path, 'utf8');
        writeFileSync(path, maskJs(src), 'utf8');
        console.log(`  mask: ${path.replace(releaseDir, '')}`);
    }
}

const indexPath = join(releaseDir, 'index.html');

console.log('Маскировка релиза…');
writeFileSync(indexPath, obfuscateInlineScripts(readFileSync(indexPath, 'utf8')), 'utf8');
console.log('  mask: index.html (inline scripts)');

const jsDir = join(releaseDir, 'js');
if (statSync(jsDir).isDirectory()) {
    walkJs(jsDir);
}

console.log('Маскировка завершена.');
