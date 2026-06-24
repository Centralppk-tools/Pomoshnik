import { copyFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'app', 'sw.js');
const swSource = readFileSync(swPath, 'utf8');
const match = swSource.match(/cppk_v(\d+_\d+_\d+)/);

if (!match) {
    console.error('Не удалось прочитать версию из app/sw.js (cppk_vX_Y_Z).');
    process.exit(1);
}

const version = match[1].replace(/_/g, '.');
const source = join(root, 'app', 'index.html');
const target = join(root, 'Version', 'snapshots', `index ${version}.html`);

copyFileSync(source, target);
console.log(`Снимок сохранён: Version/snapshots/index ${version}.html`);
