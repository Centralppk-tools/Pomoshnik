#!/usr/bin/env node
/**
 * Деплой da-function.zip в Yandex Cloud Function через REST API.
 *
 * Нужен IAM-токен (живёт ~12 ч):
 *   yc iam create-token
 *   или OAuth: https://yandex.cloud/ru/docs/iam/operations/iam-token/create
 *
 * Usage:
 *   set YC_IAM_TOKEN=...
 *   set YC_FUNCTION_ID=d4etmp7m8cfgrv283027
 *   node tools/yc-deploy-function.mjs
 *
 * Без токена — печатает шаги для консоли YC.
 */
import { readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const zipPath = join(root, 'yandex-cloud', 'da-function.zip');
const functionId = String(process.env.YC_FUNCTION_ID || 'd4etmp7m8cfgrv283027').trim();
const iamToken = String(process.env.YC_IAM_TOKEN || process.env.YC_TOKEN || '').trim();

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
6. Таймаут: 30 с, память: 256 MB
7. Переменные окружения (не менять значения, только проверить):
   YANDEX_API_KEY, STATS_SECRET, CLIENT_GATE_TOKEN, VAPID_*
   S3_BUCKET + AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (рекомендуется)

8. Триггер «Таймер»:
   Cron: 5 21 * * *
   (00:05 МСК) — нативный таймер достаточен, secret не нужен.
   Альтернатива HTTP: ?preload_boards=1&secret=<STATS_SECRET>

9. После деплоя:
   npm run yc:preload-boards -- --secret=<STATS_SECRET>
   curl board → HIT_WORKER_KV или MISS_ON_DEMAND_YANDEX
`);
}

async function deployViaApi() {
    if (!existsSync(zipPath)) {
        console.error('Нет ZIP. Запустите: npm run pack:yc');
        process.exit(1);
    }

    const zipBase64 = readFileSync(zipPath).toString('base64');
    const url = `https://serverless-functions.api.cloud.yandex.net/functions/v1/versions?functionId=${encodeURIComponent(functionId)}`;

    const body = {
        functionId,
        runtime: 'nodejs18',
        entrypoint: 'index.handler',
        resources: { memory: '268435456' },
        executionTimeout: '30s',
        content: zipBase64,
    };

    console.log('POST', url);
    console.log('ZIP size:', (statSync(zipPath).size / (1024 * 1024)).toFixed(2), 'MB');

    const res = await fetch(url, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${iamToken}`,
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });

    const text = await res.text();
    if (!res.ok) {
        console.error('Deploy failed HTTP', res.status);
        console.error(text.slice(0, 2000));
        printManualSteps();
        process.exit(1);
    }

    try {
        console.log(JSON.stringify(JSON.parse(text), null, 2));
    } catch {
        console.log(text);
    }
    console.log('\nOK. Запустите: npm run yc:preload-boards -- --secret=...');
}

async function main() {
    if (!iamToken) {
        console.log('YC_IAM_TOKEN не задан — только инструкция.\n');
        printManualSteps();
        process.exit(0);
    }
    await deployViaApi();
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
