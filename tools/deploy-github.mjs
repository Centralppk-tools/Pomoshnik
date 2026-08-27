import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const appDir = join(root, 'app');
const deployDir = join(root, '.deploy', 'pomoshnik');
const remoteUrl = 'https://github.com/centralppk-tools/Pomoshnik.git';
const dryRun = process.argv.includes('--dry-run');
const gitSafeDirs = [root, deployDir].map((dir) => `-c safe.directory=${JSON.stringify(dir)}`).join(' ');
const git = (cmd, cwd = root) => `git ${gitSafeDirs} ${cmd}`;
const messageArg = process.argv.find((arg) => arg.startsWith('--message='));
const commitMessage = messageArg
    ? messageArg.slice('--message='.length)
    : readDeployMessage();

function readDeployMessage() {
    const sw = readFileSync(join(appDir, 'sw.js'), 'utf8');
    const match = sw.match(/da_v(\d+(?:_\d+)+)/);
    const version = match ? match[1].replace(/_/g, '.') : 'unknown';
    return `deploy: v${version} — GitHub Pages`;
}

function run(cmd, cwd = root, { capture = false, skipInDryRun = false } = {}) {
    if (dryRun && skipInDryRun) {
        console.log(`[dry-run] (${relative(root, cwd) || '.'}) ${cmd}`);
        return capture ? '' : undefined;
    }
    if (capture) return execSync(cmd, { cwd, encoding: 'utf8' }).trim();
    execSync(cmd, { cwd, stdio: 'inherit' });
}

function runCapture(cmd, cwd = root) {
    return run(cmd, cwd, { capture: true });
}

function shouldSkip(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    if (normalized.endsWith('.bak')) return true;
    if (normalized.includes('/pdf/test_') || normalized.startsWith('pdf/test_')) return true;
    return false;
}

function copyAppFiltered(src, dest) {
    mkdirSync(dest, { recursive: true });
    for (const entry of readdirSync(src, { withFileTypes: true })) {
        const srcPath = join(src, entry.name);
        const relPath = relative(appDir, srcPath);
        if (shouldSkip(relPath)) continue;

        const destPath = join(dest, entry.name);
        if (entry.isDirectory()) {
            copyAppFiltered(srcPath, destPath);
        } else if (entry.isFile()) {
            cpSync(srcPath, destPath);
        }
    }
}

function clearDeployTree() {
    for (const entry of readdirSync(deployDir)) {
        if (entry === '.git') continue;
        rmSync(join(deployDir, entry), { recursive: true, force: true });
    }
}

function ensureClone() {
    mkdirSync(dirname(deployDir), { recursive: true });
    if (!existsSync(join(deployDir, '.git'))) {
        console.log(`Клонирование ${remoteUrl} → .deploy/pomoshnik`);
        run(git(`clone ${remoteUrl} "${deployDir}"`), root);
    }
    run(git('fetch origin'), deployDir);
    run(git('checkout main'), deployDir);
    run(git('reset --hard origin/main'), deployDir);
}

function main() {
    if (!statSync(appDir).isDirectory()) {
        console.error('Папка app/ не найдена.');
        process.exit(1);
    }

    ensureClone();
    console.log('Синхронизация app/ → .deploy/pomoshnik …');
    clearDeployTree();
    copyAppFiltered(appDir, deployDir);

    const status = runCapture(git('status --porcelain'), deployDir);
    if (!status) {
        console.log('Изменений нет — деплой не нужен.');
        return;
    }

    console.log('Изменения для деплоя:');
    console.log(status);

    if (dryRun) {
        console.log(`[dry-run] git commit -m "${commitMessage}"`);
        console.log('[dry-run] git push origin main');
        return;
    }

    run(git('add -A'), deployDir, { skipInDryRun: true });
    run(git(`commit -m "${commitMessage.replace(/"/g, '\\"')}"`), deployDir, { skipInDryRun: true });
    run(git('push origin main'), deployDir, { skipInDryRun: true });
    console.log('Готово: https://centralppk-tools.github.io/Pomoshnik/');
}

main();
