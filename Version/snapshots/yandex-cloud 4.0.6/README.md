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

Контракт API тот же, что у старого Worker, **плюс прикладной API**:

- `GET ?board=1&date=YYYY-MM-DD`
- `GET ?url=` (thread / Пушкино; ключ Rasp подставляет **сервер**)
- `GET ?api=spr|trains-local|shift-templates|calendar-local-routes|…`
- `GET ?api=brakes&station=&direction=`
- `GET ?api=shift-template&route=&date=`
- `POST ?api=pay-summary`
- `GET ?api=instructions-catalog|instructions-chunk|instructions-search`
- `GET ?preload_boards=1&secret=` / `?run_push=1&secret=`
- push / ping / stats — как раньше

Данные лежат в `function/data/` (не в публичном `app/` на Pages).

## Переменные окружения

См. `.env.example`. Обязательно:

- `YANDEX_API_KEY`
- `STATS_SECRET`
- `VAPID_*` (для push)
- `CLIENT_GATE_TOKEN` (тот же, что `yandexClientToken` в `app/js/app-config.js`)

Клиентские запросы без Origin/Referer с Pages/localhost или без заголовка `X-DA-Client` → **403**.  
Таймеры `preload_boards` / `run_push` и `/stats` — только с `?secret=STATS_SECRET` (без Origin).

Опционально: `ALLOWED_ORIGINS` (через запятую). По умолчанию: `https://centralppk-tools.github.io`, `http://127.0.0.1:8765`, `http://localhost:8765`.

Для персистентного кэша табло/ниток:

- бакет Object Storage + `S3_BUCKET` + ключи статического доступа

Без S3 функция поднимется, но кэш в памяти (после холодного старта табло «пропадёт»).

**Если в приложении «Расписание формируется» на все даты** — KV пустой: не отработал таймер `preload_boards` или нет S3. Запустите вручную:

```bash
npm run yc:preload-boards -- --secret=ВАШ_STATS_SECRET
```

или `GET ...?preload_boards=1&secret=STATS_SECRET`. Без залитого табло поезда 6000–6999 не найдутся (7000+ идут из `trains-local` на сервере).

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

В Yandex Cloud → **Cloud Scheduler** (или триггер функции) → HTTP GET на функцию:

| Когда | Cron (UTC) | URL |
|-------|------------|-----|
| Ежедневно **00:05 МСК** | `5 21 * * ? *` | `...?preload_boards=1&secret=STATS_SECRET` |
| Каждую **минуту** | `* * * * ? *` | `...?run_push=1&secret=STATS_SECRET` |

`00:05 МСК` = `21:05 UTC` предыдущего календарного дня (MSK = UTC+3).

### On-demand заливка табло

Если клиент запрашивает `GET ?board=1&date=YYYY-MM-DD`, а ключа в KV нет:

- **дата >= сегодня (MSK)** — сервер **сам** один раз тянет `/schedule/` у Яндекса, пишет в KV, отдаёт табло (`X-Cache-Status: MISS_ON_DEMAND_YANDEX`);
- **прошлые даты** — только `BOARD_NOT_READY`, Яндекс не дёргаем;
- после пустого ответа — cooldown **5 мин** (`board:miss:дата`), чтобы не жечь квоту.

Ручная заливка одной даты (с secret):

`GET ...?preload_boards=1&secret=...&date=2026-08-28` — только если дата **>= сегодня MSK**.

## Клиент

`app/js/app-config.js` → `yandexProxy` = URL этой функции (без обязательного `/` в конце — клиент нормализует).

## Локальная проверка handler

```bash
cd yandex-cloud/function
node -e "require('./index').handler({httpMethod:'GET',url:'https://x/?ping=1&device_uuid=test1',headers:{}},{}).then(r=>console.log(r))"
```
