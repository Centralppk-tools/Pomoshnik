# Подготовка к деплою — Цифровой помощник

Инструкция для агента и разработчика. При фразах **«подготовь к деплою»**, **«prepare deploy»** — выполнить чеклист **полностью**, без лишних вопросов.

**Жёсткое правило:** `.cursor/rules/workflow-app-only.mdc` — UI в `app/`, сервер в `yandex-cloud/`, **без папки `Release/`**.

---

## 1. Проверка `app/`

| Проверка | Действие |
|----------|----------|
| `app/index.html` | главный файл; **обязательно** `APP_RELEASE_VERSION = 'X.Y.Z'` = текущий релиз; обновить `RELEASE_NOTES_FALLBACK` под пункты пользователя |
| `app/sw.js` | версия кэша актуальна (§2) |
| `app/manifest.json` | иконки на месте |
| `app/js/app-config.js` | `yandexProxy` → URL Cloud Function; без секрета Rasp в идеале |
| `app/styles/*.css` | 10 файлов |
| `app/assets/` | `app-icon.png`, `brand-logo.png` |
| `app/data/` | конфиги, `release-notes.json` |
| Новые статические файлы | добавить в `PRECACHE_ASSETS` в `app/sw.js` |

**Не включать:** `Ins_pan/`, черновые логотипы в корне, `tools/_tmp*`, отладочный ingest.

---

## 2. Service Worker (`app/sw.js`)

1. Поднять версию: `CACHE_VERSION = 'da_vX_Y_Z'` (patch +1 от STABLE, если пользователь не задал номер).
2. Обновить комментарий в первой строке.
3. Проверить `PRECACHE_ASSETS` — все новые файлы из `app/`.
4. Убрать отладочный код.

---

## 3. Release notes

Обновить **синхронно** (один номер версии X.Y.Z):

1. `app/data/release-notes.json` — `"version"`, `"tags"`, `"highlights"` (формулировки пользователя).
2. `app/index.html` — `APP_RELEASE_VERSION = 'X.Y.Z'` и `RELEASE_NOTES_FALLBACK` (те же пункты).

Без пункта 2 оверлей «Что нового» и футер берут **старый** fallback и игнорируют свежий JSON.

---

## 4. Сервер (`yandex-cloud/`)

1. Правки в `yandex-cloud/function/` (логика табло/прокси/push).
2. `npm run pack:yc` — ZIP с путями `/` для Linux.
3. Документация: `yandex-cloud/README.md`.

Cloudflare (`worker.js`, `wrangler.toml`, `npx wrangler deploy`) — **не использовать**.

---

## 5. Снимок перед деплоем

```bash
npm run snapshot
```

Создаёт:

- `Version/snapshots/index X.Y.Z.html` — UI + inline JS
- `Version/snapshots/styles X.Y.Z/` — CSS
- `Version/snapshots/app-config X.Y.Z.js` — фронт-конфиг
- **`Version/snapshots/yandex-cloud X.Y.Z/`** — **вся серверная часть (обязательно)**:
  - `function/index.js`, `function/lib/*`, `package.json`, `package-lock.json`
  - `README.md`, `.env.example`
  - `da-function.zip`
  - `SNAPSHOT.json`

Без `yandex-cloud X.Y.Z/` снимок **неполный** — релиз не готов.

Версия берётся из `app/sw.js`.

---

## 6. Документация версий

### `Version/STABLE.txt`

- номер версии ★, дата, Service Worker
- **Деплой PWA: содержимое `app/`**
- **Деплой сервера: `yandex-cloud/da-function.zip` → Cloud Function (`index.handler`)**
- пути снимков, включая `yandex-cloud X.Y.Z/`
- ключевые изменения (формулировки пользователя)

### `Version/Commit.txt`

Блок в конце по образцу предыдущих версий. Без упоминания `Release/`. Указать снимок сервера.

---

## 7. Git-коммит

**Stage:**

```
app/
yandex-cloud/          — без function/node_modules
Version/STABLE.txt
Version/Commit.txt
Version/snapshots/index X.Y.Z.html
Version/snapshots/styles X.Y.Z/
Version/snapshots/app-config X.Y.Z.js
Version/snapshots/yandex-cloud X.Y.Z/
tools/snapshot.mjs
tools/pack-yandex-function.mjs
package.json / .cursorrules / .cursor/rules — если менялись
```

**Не stage:** `Release/`, `Ins_pan/`, `yandex-cloud/function/node_modules/`, лишние PNG, `secrets.local.json`.

### Сообщение коммита

```
release: vX.Y.Z STABLE — <краткое резюме>

- …
- ui/chore: SW da_vX_Y_Z, snapshot в Version/
```

Формулировки «Основное» — только от пользователя.

---

## 8. Деплой

### PWA (GitHub Pages)

1. Залить **всё содержимое `app/`** в корень сайта (или подпапку PWA).
2. Обязательно: `index.html`, `sw.js`, `js/app-config.js`, `styles/`, `data/`, instructions/vendor при наличии.
3. После залива — сброс Service Worker / Ctrl+F5.

### Сервер (Yandex Cloud)

1. Залить `yandex-cloud/da-function.zip` (или из снимка) → новая версия функции.
2. Entrypoint: `index.handler`, Node 18+.
3. Env: `YANDEX_API_KEY`, `STATS_SECRET`, `VAPID_*`, желательно S3.
4. Таймеры: `?preload_boards=1&secret=` (00:05 МСК), `?run_push=1&secret=` (каждую минуту).

---

## 9. Google Apps Script (если менялся API)

1. `npm run clasp:push` — **не** `clasp deploy`.
2. Ручной deploy в script.google.com → Web app.

---

## 10. Шпаргалка агента

```
1. git status + diff
2. Аудит app/ + yandex-cloud/, bump sw.js, release-notes
3. npm run snapshot  (включая yandex-cloud X.Y.Z/)
4. Version/STABLE.txt + Version/Commit.txt
5. git add app/ yandex-cloud/ Version/ → commit
6. Отчёт: версия, SW, снимки (app + сервер), hash
```

**Push** — только по явной просьбе.
