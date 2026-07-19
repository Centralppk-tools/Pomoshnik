import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const swPath = join(root, 'app', 'sw.js');
const swSource = readFileSync(swPath, 'utf8');
const match = swSource.match(/(?:cppk_v|da_v)(\d+_\d+_\d+)/);

if (!match) {
    console.error('Не удалось прочитать версию из app/sw.js (cppk_vX_Y_Z или da_vX_Y_Z).');
    process.exit(1);
}

const version = match[1].replace(/_/g, '.');
const appSource = join(root, 'app');
const releaseDir = join(root, 'Release', version);

rmSync(releaseDir, { recursive: true, force: true });
mkdirSync(releaseDir, { recursive: true });
cpSync(appSource, releaseDir, { recursive: true });

const readme = `# Цифровой помощник v${version}

Сборка для выкладки на хостинг.

## Заливка

1. Загрузите все файлы из этой папки в корень сайта (или в подпапку PWA).
2. После залива — Ctrl+F5 или сброс Service Worker в DevTools.
3. Проверьте: вход, профиль, расписание, «Сообщить о проблеме».

Service Worker: da_v${match[1]}
`;

writeFileSync(join(releaseDir, 'README-DEPLOY.txt'), readme, 'utf8');
console.log(`Сборка: Release/${version}/`);
