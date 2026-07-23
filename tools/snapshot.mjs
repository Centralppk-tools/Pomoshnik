import { copyFileSync, cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'app', 'sw.js');
const swSource = readFileSync(swPath, 'utf8');
const match = swSource.match(/(?:cppk_v|da_v)(\d+(?:_\d+)+)/);

if (!match) {
    console.error('Не удалось прочитать версию из app/sw.js (cppk_vX_Y_Z или da_vX_Y_Z).');
    process.exit(1);
}

const version = match[1].replace(/_/g, '.');
const snapshotsDir = join(root, 'Version', 'snapshots');
mkdirSync(snapshotsDir, { recursive: true });

const indexSource = join(root, 'app', 'index.html');
const indexTarget = join(snapshotsDir, `index ${version}.html`);
copyFileSync(indexSource, indexTarget);
console.log(`Снимок HTML: Version/snapshots/index ${version}.html`);

const stylesSource = join(root, 'app', 'styles');
const stylesTarget = join(snapshotsDir, `styles ${version}`);
cpSync(stylesSource, stylesTarget, { recursive: true });

const styleFiles = readdirSync(stylesTarget).filter((name) => name.endsWith('.css'));
console.log(`Снимок стилей: Version/snapshots/styles ${version}/ (${styleFiles.length} файлов)`);
