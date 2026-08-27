/**
 * Pack Yandex Cloud Function ZIP with Unix path separators (/).
 */
import { createWriteStream, existsSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fnDir = join(root, 'yandex-cloud', 'function');
const outZip = join(root, 'yandex-cloud', 'da-function.zip');

function loadArchiver() {
    const require = createRequire(join(root, 'package.json'));
    let mod;
    try {
        mod = require('archiver');
    } catch {
        console.log('Installing archiver…');
        execSync('npm install archiver --no-save', { cwd: root, stdio: 'inherit' });
        mod = require('archiver');
    }
    if (typeof mod === 'function') return mod;
    if (typeof mod.default === 'function') return mod.default;
    if (typeof mod.Archiver === 'function') {
        // archiver v7+: factory via ZipArchive / create
        return (format, opts) => {
            if (format === 'zip' && mod.ZipArchive) return new mod.ZipArchive(opts);
            return new mod.Archiver(format, opts);
        };
    }
    throw new Error('Unsupported archiver export');
}

function walkFiles(dir, list = []) {
    for (const name of readdirSync(dir)) {
        if (name === '.git' || name === '.DS_Store') continue;
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) walkFiles(full, list);
        else if (st.isFile()) list.push(full);
    }
    return list;
}

async function main() {
    if (!existsSync(join(fnDir, 'index.js'))) {
        console.error('Missing yandex-cloud/function/index.js');
        process.exit(1);
    }
    if (!existsSync(join(fnDir, 'node_modules'))) {
        console.log('npm ci in function…');
        execSync('npm ci', { cwd: fnDir, stdio: 'inherit' });
    }

    const archiver = loadArchiver();
    if (existsSync(outZip)) unlinkSync(outZip);

    const includeRoots = ['index.js', 'package.json', 'package-lock.json', 'lib', 'node_modules']
        .map((p) => join(fnDir, p))
        .filter((p) => existsSync(p));

    const files = [];
    for (const p of includeRoots) {
        const st = statSync(p);
        if (st.isDirectory()) walkFiles(p, files);
        else files.push(p);
    }

    await new Promise((resolve, reject) => {
        const output = createWriteStream(outZip);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', resolve);
        archive.on('error', reject);
        if (typeof archive.on === 'function') {
            archive.on('warning', (err) => {
                if (err.code !== 'ENOENT') reject(err);
            });
        }
        archive.pipe(output);

        for (const full of files) {
            const rel = relative(fnDir, full).split(sep).join('/');
            archive.file(full, { name: rel });
        }

        archive.finalize();
    });

    const size = statSync(outZip).size;
    console.log(`OK: ${outZip}`);
    console.log(`Size: ${(size / (1024 * 1024)).toFixed(2)} MB, files: ${files.length}`);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
