# Сервер Цифрового помощника — Yandex Cloud Functions

Клиент (`app/`) ходит сюда. Cloudflare Worker больше не используется.

**Публичный URL:** `https://functions.yandexcloud.net/d4etmp7m8cfgrv283027`

## Что внутри

| Файл | Роль |
|------|------|
| `function/index.js` | Точка входа Cloud Function |
| `function/lib/core.js` | Табло, прокси Rasp, ping/stats, Web Push (порт `worker.js`) |
| `function/lib/store.js` | Кэш: Object Storage или Memory |
| `function/lib/webpush-send.js` | Web Push через `web-push` |

Контракт API тот же, что у старого Worker:

- `GET ?board=1&date=YYYY-MM-DD`
- `GET ?url=` (thread / Пушкино; Ярославский `/schedule/` запрещён)
- `GET ?preload_boards=1&secret=`
- `GET ?run_push=1&secret=` — для минутного таймера
- `GET ?ping=1&device_uuid=`
- `GET /stats?secret=`
- `POST ?register_push=1` / `sync_alerts=1` / `unregister_push=1`

## Переменные окружения

См. `.env.example`. Обязательно:

- `YANDEX_API_KEY`
- `STATS_SECRET`
- `VAPID_*` (для push)

Для персистентного кэша табло/ниток:

- бакет Object Storage + `S3_BUCKET` + ключи статического доступа

Без S3 функция поднимется, но кэш в памяти (после холодного старта табло «пропадёт»).

## Деплой версии

```bash
cd yandex-cloud/function
npm ci
# zip без лишнего:
# Windows PowerShell:
Compress-Archive -Path index.js,lib,package.json,node_modules -DestinationPath ..\da-function.zip -Force

yc serverless function version create \
  --function-name=<имя функции> \
  --runtime nodejs18 \
  --entrypoint index.handler \
  --memory 256m \
  --execution-timeout 30s \
  --source-path ..\da-function.zip \
  --environment YANDEX_API_KEY=...,STATS_SECRET=...,VAPID_PUBLIC_KEY=...,VAPID_PRIVATE_KEY=...,VAPID_SUBJECT=mailto:pomoshnikcppk@t.me,S3_BUCKET=...,AWS_ACCESS_KEY_ID=...,AWS_SECRET_ACCESS_KEY=...
```

Либо загрузка ZIP в консоли: Cloud Functions → версия → ZIP.

## Таймеры (вместо cron Cloudflare)

В Yandex Cloud → Cloud Scheduler / Timer → HTTP GET на функцию:

| Когда | URL |
|-------|-----|
| Ежедневно **00:05 МСК** | `...?preload_boards=1&secret=STATS_SECRET` |
| Каждую **минуту** | `...?run_push=1&secret=STATS_SECRET` |

## Клиент

`app/js/app-config.js` → `yandexProxy` = URL этой функции (без обязательного `/` в конце — клиент нормализует).

## Локальная проверка handler

```bash
cd yandex-cloud/function
node -e "require('./index').handler({httpMethod:'GET',url:'https://x/?ping=1&device_uuid=test1',headers:{}},{}).then(r=>console.log(r))"
```
