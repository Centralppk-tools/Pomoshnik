#!/usr/bin/env node
/**
 * Деплой da-function.zip в Yandex Cloud Function.
 *
 * ВАЖНО: переменные окружения (YANDEX_API_KEY, CLIENT_GATE_TOKEN, …) обязательны.
 * Скрипт подтягивает env из последней версии функции, где они заданы, либо из yandex-cloud/.env
 *
 * Usage:
 *   npm run pack:yc
 *   npm run yc:deploy
 *
 * Нужен yc CLI (yc iam create-token / авторизация).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = join(root, 'yandex-cloud', 'da-function.zip');
const envFilePath = join(root, 'yandex-cloud', '.env');
const functionId = String(process.env.YC_FUNCTION_ID || 'd4etmp7m8cfgrv283027').trim();

function printManualSteps() {
    const size = existsSync(zipPath) ? statSync(zipPath).size : 0;
    const mb = (size / (1024 * 1024)).toFixed(2);
    console.log(`
=== Ручной деплой (консоль Yandex Cloud) ===

1. Cloud Functions → функция ${functionId} → Создать версию
2. Способ: ZIP-архив
3. Файл: ${zipPath}
   Размер: ${mb} MB
4. Runtime: nodejs18 (или nodejs20)
5. Entrypoint: index.handler
6. Таймаут: 30 s, память: 256 MB
7. **Обязательно** скопировать переменные окружения с предыдущей версии:
   YANDEX_API_KEY, STATS_SECRET, CLIENT_GATE_TOKEN, VAPID_*
   S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (рекомендуется)

8. После деплоя:
   npm run yc:preload-boards -- --secret=<STATS_SECRET>
`);
}

function runYc(args) {
    return execFileSync('yc', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function parseDotEnv(text) {
    const env = {};
    for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eq = trimmed.indexOf('=');
        if (eq <= 0) continue;
        const key = trimmed.slice(0, eq).trim();
        let val = trimmed.slice(eq + 1).trim();
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
        }
        if (key) env[key] = val;
    }
    return env;
}

function loadEnvFromFile() {
    if (!existsSync(envFilePath)) return null;
    const parsed = parseDotEnv(readFileSync(envFilePath, 'utf8'));
    return Object.keys(parsed).length ? parsed : null;
}

function loadEnvFromLastVersion() {
    try {
        const raw = runYc([
            'serverless', 'function', 'version', 'list',
            '--function-id', functionId,
            '--limit', '20',
            '--format', 'json',
        ]);
        const versions = JSON.parse(raw);
        for (const version of versions) {
            const env = version?.environment;
            if (env && typeof env === 'object' && Object.keys(env).length) {
                return { env, versionId: version.id };
            }
        }
    } catch (err) {
        console.warn('[yc:deploy] Не удалось прочитать env из версий:', err.message || err);
    }
    return null;
}

function formatEnvironmentArg(env) {
    return Object.entries(env)
        .filter(([k, v]) => k && v != null && String(v).trim() !== '')
        .map(([k, v]) => `${k}=${String(v).trim()}`)
        .join(',');
}

function deployViaYc() {
    if (!existsSync(zipPath)) {
        console.error('Нет ZIP. Запустите: npm run pack:yc');
        process.exit(1);
    }

    const fromFile = loadEnvFromFile();
    const fromVersion = loadEnvFromLastVersion();
    const environment = fromFile || fromVersion?.env;

    if (!environment || !Object.keys(environment).length) {
        console.error('Не найдены переменные окружения для деплоя.');
        console.error('Создайте yandex-cloud/.env (из .env.example) или задеплойте версию с env вручную в консоли YC.');
        printManualSteps();
        process.exit(1);
    }

    if (fromFile) {
        console.log('Env: yandex-cloud/.env');
    } else {
        console.log(`Env: скопировано с версии ${fromVersion.versionId}`);
    }

    const envArg = formatEnvironmentArg(environment);
    const required = ['YANDEX_API_KEY', 'CLIENT_GATE_TOKEN', 'STATS_SECRET'];
    const missing = required.filter((key) => !environment[key]);
    if (missing.length) {
        console.error('В env не хватает ключей:', missing.join(', '));
        process.exit(1);
    }

    console.log('ZIP:', zipPath, `(${(statSync(zipPath).size / (1024 * 1024)).toFixed(2)} MB)`);
    console.log('Deploy via yc serverless function version create …');

    const args = [
        'serverless', 'function', 'version', 'create',
        '--function-id', functionId,
        '--source-path', zipPath,
        '--runtime', 'nodejs18',
        '--entrypoint', 'index.handler',
        '--memory', '256MB',
        '--execution-timeout', '30s',
        '--environment', envArg,
    ];

    const out = runYc(args);
    console.log(out);
    console.log('\nOK. Проверка: curl с Origin GitHub Pages + X-DA-Client → ?api=trains-local');
    console.log('Табло: npm run yc:preload-boards -- --secret=...');
}

function main() {
    try {
        runYc(['--version']);
    } catch {
        console.log('yc CLI не найден — только инструкция.\n');
        printManualSteps();
        process.exit(0);
    }

    try {
        deployViaYc();
    } catch (err) {
        const stderr = err.stderr?.toString?.() || '';
        const stdout = err.stdout?.toString?.() || '';
        console.error(stderr || stdout || err.message || err);
        printManualSteps();
        process.exit(1);
    }
}

main();
