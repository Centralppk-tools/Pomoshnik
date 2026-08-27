# Карта проекта «Цифровой помощник»

> Краткий контекст для задач. Актуальная версия: **3.2.1** (`app/sw.js` → `da_v3_2_1`).

---

## Официальные названия

| Название | Папка | Роль |
|----------|-------|------|
| **Цифровой помощник** | `app/` | Основное приложение (PWA). Прод-деплой. |
| **Админ панель инструктора** | `Ins_pan/` | Локальное управление данными приложения. Не в деплое PWA. |

Правило: админка всегда связана с `app/` и управляет его параметрами/данными. Подробнее: `.cursor/rules/admin-ins-pan.mdc`.

---

## Общая архитектура

**Назначение:** PWA для сотрудников ЦППК — личный график смен, построение маршрутов по поездам, справочник тормозов/остановок, расчёт часов и оплаты, экспорт в календарь.

**Стек:**
- Frontend: vanilla HTML/CSS/JS, без фреймворков
- PWA: `manifest.json` + Service Worker (`sw.js`)
- Данные: статические JSON + `localStorage` (per-user)
- Сборка/деплой: **нет bundler** — на GitHub Pages заливается папка `app/` как есть
- Dev-сервер: `npm run serve` → `python -m http.server 8765 --directory app`
- Backend-интеграции: Google Apps Script, Яндекс.Rasp API (через **Yandex Cloud Function** в `yandex-cloud/`), CloudTips, Telegram

**Точки входа:**
| Файл | Роль |
|------|------|
| `app/index.html` | Единственная страница: разметка (~480 строк) + **весь JS (~10k строк inline `<script>`)** |
| `app/js/app-config.js` | Секреты и URL API (`window.APP_CONFIG`) |
| `app/sw.js` | Офлайн-кэш, обновления PWA, push-уведомления смен |
| `app/manifest.json` | Манифест PWA |

**Экраны (bottom tabbar):**
- `screen-calendar` — график смен (дефолтный)
- `screen-schedule` — маршрут / расписание поездов
- `screen-instructions` — инструкции (файлы + чат по документам)
- `screen-profile` — личный кабинет
- `screen-auth` — вход по табельному номеру (overlay)

---

## Дерево структуры и модулей

```
Digital Assistant/
├── app/                          # ★ PRODUCTION — единственная папка для деплоя
│   ├── index.html                # UI + основная логика (inline) + экраны
│   ├── sw.js                     # Service Worker
│   ├── manifest.json
│   ├── js/
│   │   ├── app-config.js         # API-ключи (в git; example: app-config.example.js)
│   │   ├── app-config.example.js
│   │   └── instructions.js       # модуль «Инструкции» (IndexedDB + keyword-чат)
│   ├── styles/                   # UI (10 CSS-модулей)
│   │   ├── tokens.css            # CSS-переменные, тема; фирменный градиент --brand-grad-light #06C785 → --brand-grad-dark #024C4E
│   │   ├── base.css              # layout, типографика
│   │   ├── routes.css            # вкладка «Маршрут»
│   │   ├── schedule.css          # таймлайн остановок
│   │   ├── calendar.css          # календарь смен
│   │   ├── profile.css           # личный кабинет
│   │   ├── instructions.css      # инструкции: файлы + чат
│   │   ├── auth.css              # экран входа
│   │   ├── community.css         # футер, donate, feedback
│   │   └── responsive.css        # адаптив
│   ├── assets/                   # brand-logo.png, app-icon.png
│   ├── data/
│   │   ├── shift-templates.json  # ★ часы смен (экспорт из xlsx)
│   │   ├── calendar-local-routes.json  # пресеты ТО/И/Д99/Н99/У99
│   │   ├── trains-uids.json      # устарел (UID с табло; файл для SW-precache)
│   │   ├── release-notes.json    # «Что нового» после обновления
│   │   ├── shift-hours/          # схемы/справочники для export-shifts.py
│   │   └── trains-api/README.md  # ★ правила лимита API поездов
│   ├── spr.json                  # справочник тормозов, станций, маршрутов
│   ├── trains-local.json         # офлайн-резерв поездов (без обязательного uid)
│   └── generate_pdf.py           # генерация patent_doc.pdf (не runtime)
│
├── google-script/
│   └── Код.js                    # Google Apps Script Web App (депо API)
│
├── yandex-cloud/                 # ★ SERVER — Yandex Cloud Function (Rasp, push, кэш)
│   ├── function/                 # index.handler, lib/core.js, store, webpush
│   └── README.md                 # деплой, таймеры, env
│
├── worker.js                     # устарело (Cloudflare), см. yandex-cloud/
│
├── tools/                        # dev/build утилиты (не в деплое)
│   ├── snapshot.mjs              # npm run snapshot → Version/snapshots/
│   ├── export-shifts.py          # npm run export:shifts → shift-templates.json
│   ├── enrich-train-uids.py      # npm run enrich:train-uids → trains-uids.json
│   └── clasp-cleanup-deployments.mjs
│
├── Version/                      # версионирование и инструкции деплоя
│   ├── STABLE.txt, Commit.txt
│   ├── PREPARE-DEPLOY.md, DEPLOY-GITHUB.md
│   └── snapshots/                # HTML/CSS снимки перед деплоем
│
├── Часы смен/                    # исходные xlsx (не на GitHub Pages)
│   ├── с 24_06/                  # норматив до 16.07.2026
│   ├── c 17_07/                  # норматив 17.07–04.08.2026
│   └── c 05_08/                  # норматив с 05.08.2026 (пн–чт новые)
│
├── Ins_pan/                      # ★ Админ панель инструктора (localhost:8790; пишет в app/data)
│   ├── js/app.js, config.js      # конструктор распоряжений + Supabase
│   ├── css/app.css, data/stations.json
│   └── supabase/schema.sql
│
├── .cursor/rules/                # правила для AI-агента
│   ├── workflow-app-only.mdc     # только app/, без Release/
│   ├── prepare-deploy.mdc
│   └── train-api-quota.mdc
│
└── package.json                  # npm scripts (serve, snapshot, export, clasp)
```

**Где что лежит:**
| Слой | Расположение |
|------|--------------|
| UI (разметка) | `app/index.html` (секции `#screen-*`, модалки, tabbar) |
| UI (стили) | `app/styles/*.css` |
| Логика приложения | `app/index.html` `<script>` — ~100 функций, без модулей |
| Конфиг/секреты | `app/js/app-config.js` |
| Статические справочники | `app/spr.json`, `app/trains-local.json`, `app/data/*` |
| Локальное хранилище | `localStorage` через `userStorageKey()` / `userStorageSet()` |
| Офлайн-кэш PWA | Cache API в `app/sw.js` |
| Серверная логика | `google-script/Код.js` (Google Sheets) |

---

## Потоки данных и связи

### Инициализация (`DOMContentLoaded` в index.html)

```
app-config.js → APP_CFG
    → initUserAuth()           # сессия по табельному
    → loadLocalShiftTemplatesBundle()  # shift-templates.json
    → loadReferenceData()      # spr.json, trains-local.json
    → loadTrainThreadsCacheFromStorage()
    → initServiceWorker()
    → loadUserShifts()         # календарь из localStorage
```

### Авторизация

- Вход: табельный номер → `rzd_users` (глобальный реестр) + `currentUserTab` (сессия)
- Per-user ключи: `u_{tab}_{key}` через `userStorageKey(key)`
- Выход: `handleLogout()` — сброс сессии и `calendarUserShifts`

### Календарь смен

```
shift-templates.json (нормативы по датам)
    → findShiftTemplate(route, dateKey)   # поиск часов/поездов
    → renderShiftConstructor()              # UI конструктора дня
    → calendarUserShifts[DD.MM.YYYY]       # пользовательские правки
    → persistUserShifts() → localStorage u_{tab}_depotShifts
    → buildIcsCalendarDocument() → экспорт .ics
```

- Пресеты ТО/И: `calendar-local-routes.json`
- Ночные смены: связка N→U через `morningRoute`, `linkedMorningDateKey`
- Профиль: `updateProfileScreen()` — часы, оплата, ближайшая смена из `calendarUserShifts`

### Маршрут поездов (Яндекс.Rasp)

Подробно: `app/data/trains-api/README.md`.

**Табло Ярославского** качает Worker в 00:05 МСК (сегодня, +1, +2, +6) → KV `board:s2000002:дата`. Клиент только `GET ?board=1&date=`. Клиентский `/schedule/` на `s2000002` запрещён.

**3 триггера сети** (не таймер, не полночь):
1. `getRouteData()` — «Показать маршруты»
2. `navigateToRouteWithTrains()` — «Маршрут» из календаря/профиля
3. `refreshRouteData()` — «Обновить» (коротко — нитки; удержание — ещё раз `?board=1`)

```
6000–6999: кэш нитки → табло ?board=1 (D / ночь D+D+1) → UID → Worker /thread/
7000+ и прочие: только trains-local.json
Пушкино: запасной ?url= /schedule/, если номера нет на Ярославском
```

Квота Яндекса ~500/сутки: ночью 8–12 `/schedule/`, с телефона в основном `/thread/` (`MISS_YANDEX_API`).

### Справочник тормозов (`spr.json`)

```
loadReferenceData() → sprDataCache
    → findStationBrakes(), render route timeline
    → подсветка тормозов на карточках станций
    → shiftWarnings (до 10 предупреждений, localStorage)
```

### Google Apps Script (`DEPOT_API_URL`)

| Endpoint | Назначение |
|----------|------------|
| `GET ?check=version` | health ping |
| `POST action=feedback` | баг-репорт → Telegram @bag_rep_bot |
| `GET` (default) | employees + shiftDetails из Google Sheets (legacy, **график в app — локальный**) |
| `action=gcalToken` | OAuth token exchange (legacy, заменён экспортом .ics) |

Код: `google-script/Код.js` → листы «График работы_Прил», «Часы_смен_прил», «Настройки».

### Прочие интеграции

| Сервис | Использование |
|--------|---------------|
| CloudTips | donate sheet — оплата через `cloudtipsPaymentUrl`, fee API |
| Telegram | `@bag_rep_bot` (feedback), `@pomoshnikcppk` (community) |
| Supabase | только `Ins_pan/` (прототип) |

### Кэширование

| Данные | Где | Ключ/механизм |
|--------|-----|---------------|
| Справочники JSON | localStorage (global) | `cppk_spr_cache`, `cppk_trains_local_cache`, `cppk_shift_templates_bundle`, `cppk_calendar_local_routes`, `cppk_trains_uids_cache` |
| Нитки поездов | localStorage (per-user) | `u_{tab}_trainThreadsCache` → `{номер}@{YYYY-MM-DD}` |
| Табло станций | localStorage (per-user) | `u_{tab}_stationScheduleCache` → boards[date], max 4 даты |
| График смен | localStorage (per-user) | `u_{tab}_depotShifts` → `{DD.MM.YYYY: shiftRecord}` |
| Настройки маршрута | localStorage (per-user) | `trainNumbers`, `selectedDate`, `nightMode`, `shiftWarnings`, `stationNotes`, `shiftTrainPlan` |
| Сессия/профиль | localStorage (global) | `currentUserTab`, `depotFio`, `depotTab`, `depotPosition`, `rzd_users` |
| Статика PWA | Cache API | `digital_assistant_da_v2_4_6_2` — precache + cache-first/network-first |
| Release notes | network-first | `data/release-notes.json` |

### Workflow деплоя

```
правки в app/ → npm run snapshot → Version/snapshots/
             → обновить STABLE.txt, Commit.txt, release-notes.json, sw.js CACHE_VERSION
             → залить app/ на GitHub Pages
```

**Не использовать:** `Release/`, `npm run build`, obfuscate.

---

## Глоссарий ключевых сущностей

### Shift / смена

```js
{ route, hours, startTime, endTime, lunch, trainNum, nightHours, morningRoute?, note? }
```

- **route:** `Д60` (день), `Н60` (ночь), `61У` (утро), `ТО`, `И`
- **dateKey:** `DD.MM.YYYY` — ключ в `calendarUserShifts`
- **weekday marker:** `пн-чт`, `пт`, `сб`, `вс` — в shift-templates

### Shift template (flat row)

Из `shift-templates.json` / xlsx — поля: `date`, `route`, `startPlace`, `startTime`, `trains`, `endTime`, `nightHours`, `workHours`, `morningRoute`, `lunch`.

### Train thread cache entry

Кэш нитки поезда: `uid`, `stops[]`, `departure`, `arrival`, `scheduleDate`, `source`.

### trainPlan

План поездов для ночной смены: `{ items: [{number, scheduleDate, night|morning}], dateKey }` — в `shiftTrainPlan`.

### spr.json секции

- `brakes.from_moscow` / `to_moscow` — тормоза по направлению
- `stations_path[]` — километраж станций
- `routes[]` — справочник маршрутов
- `brakes.dead_ends` — тупики

### User storage

- `normalizeTabNumber()` → ключ `u_{tab}_*`
- `userShiftsStorageKey(tab)` → `u_{tab}_depotShifts`

### depotShiftTemplates

In-memory массив шаблонов смен; источник — `shift-templates.json` (локально), не Google API.

### Normative bundle

```js
{ id, normativeFrom, normativeTo, shiftDetails[] }
```

Выбор по дате: `resolveNormativeBundleForIso()`.

### Service Worker версия

`CACHE_VERSION = 'da_v2_4_6_2'` — синхронизировать с `APP_RELEASE_VERSION` в index.html.

---

## Связи «файл → ответственность → с кем взаимодействует»

| Файл/модуль | Ответственность | Взаимодействует с |
|-------------|-----------------|-------------------|
| `index.html` | orchestrator всего UI/логики | все JSON, sw.js, app-config, localStorage, внешние API |
| `getRouteData()` | загрузка маршрутов поездов | Yandex API, train caches, spr.json |
| `findShiftTemplate()` | часы/поезда по маршруту+дате | shift-templates.json |
| `calendarRenderCalendar()` | сетка месяца | calendarUserShifts, shift templates |
| `loadReferenceData()` | spr + trains offline | fetch → localStorage cache |
| `initUserAuth()` | вход/выход | rzd_users, currentUserTab |
| `sw.js` | PWA offline + push | precache assets, showNotification |
| `export-shifts.py` | xlsx → JSON | Часы смен/*.xlsx → shift-templates.json |
| `google-script/Код.js` | backend Sheets | doGet/doPost → app feedback, legacy data |
| `Ins_pan/js/app.js` | прототип распоряжений | Supabase, stations.json |

---

## npm scripts

| Команда | Действие |
|---------|----------|
| `npm run serve` | локальный dev http://127.0.0.1:8765 |
| `npm run snapshot` | снимок в Version/snapshots/ |
| `npm run export:shifts` | xlsx → shift-templates.json |
| `npm run enrich:train-uids` | устарел (UID теперь с табло на дату) |
| `npm run clasp:push` | push google-script/ в Apps Script |

---

## Важные ограничения для агента

1. **Все изменения только в `app/`** (кроме tools/, Version/, google-script/ по задаче)
2. **Не создавать `Release/`**
3. Перед деплоем — `npm run snapshot`, обновить Version/
4. Логику поездов — **сначала** читать `app/data/trains-api/README.md`
5. `Ins_pan/` — отдельный проект, не включать в деплoy app/
