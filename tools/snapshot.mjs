import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

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

const configSource = join(root, 'app', 'js', 'app-config.js');
const configTarget = join(snapshotsDir, `app-config ${version}.js`);
copyFileSync(configSource, configTarget);
console.log(`Снимок конфига: Version/snapshots/app-config ${version}.js`);

// --- Полная серверная часть (Yandex Cloud) ---
const serverSnapDir = join(snapshotsDir, `yandex-cloud ${version}`);
if (existsSync(serverSnapDir)) {
    rmSync(serverSnapDir, { recursive: true, force: true });
}
mkdirSync(serverSnapDir, { recursive: true });

const ycRoot = join(root, 'yandex-cloud');
const fnSource = join(ycRoot, 'function');
const fnTarget = join(serverSnapDir, 'function');
mkdirSync(fnTarget, { recursive: true });

copyFileSync(join(fnSource, 'index.js'), join(fnTarget, 'index.js'));
copyFileSync(join(fnSource, 'package.json'), join(fnTarget, 'package.json'));
if (existsSync(join(fnSource, 'package-lock.json'))) {
    copyFileSync(join(fnSource, 'package-lock.json'), join(fnTarget, 'package-lock.json'));
}
cpSync(join(fnSource, 'lib'), join(fnTarget, 'lib'), { recursive: true });
if (existsSync(join(fnSource, 'data'))) {
    cpSync(join(fnSource, 'data'), join(fnTarget, 'data'), { recursive: true });
    console.log(`Снимок data/: Version/snapshots/yandex-cloud ${version}/function/data/`);
}

if (existsSync(join(ycRoot, 'README.md'))) {
    copyFileSync(join(ycRoot, 'README.md'), join(serverSnapDir, 'README.md'));
}
if (existsSync(join(ycRoot, '.env.example'))) {
    copyFileSync(join(ycRoot, '.env.example'), join(serverSnapDir, '.env.example'));
}

// Актуальный ZIP для заливки в консоль YC (пути с /)
try {
    execSync('node tools/pack-yandex-function.mjs', { cwd: root, stdio: 'inherit' });
} catch (err) {
    console.warn('Предупреждение: не удалось пересобрать da-function.zip', err.message || err);
}
const zipSource = join(ycRoot, 'da-function.zip');
if (existsSync(zipSource)) {
    copyFileSync(zipSource, join(serverSnapDir, 'da-function.zip'));
    console.log(`Снимок ZIP: Version/snapshots/yandex-cloud ${version}/da-function.zip`);
}

const manifest = {
    version,
    capturedAt: new Date().toISOString(),
    proxyUrlHint: 'см. app-config.js → yandexProxy',
    entrypoint: 'index.handler',
    contents: [
        'function/index.js',
        'function/lib/*',
        'function/package.json',
        'function/package-lock.json',
        'README.md',
        '.env.example',
        'da-function.zip',
    ],
};
writeFileSync(join(serverSnapDir, 'SNAPSHOT.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
console.log(`Снимок сервера: Version/snapshots/yandex-cloud ${version}/`);

// Legacy: wrangler только если файл ещё есть (не обязателен)
const wranglerSource = join(root, 'wrangler.toml');
if (existsSync(wranglerSource)) {
    const wranglerTarget = join(snapshotsDir, `wrangler ${version}.toml`);
    copyFileSync(wranglerSource, wranglerTarget);
    console.log(`Снимок legacy wrangler: Version/snapshots/wrangler ${version}.toml`);
}
