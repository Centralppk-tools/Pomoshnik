# Подготовка к деплою — Цифровой помощник

Инструкция для агента и разработчика. При фразах **«подготовь к деплою»**, **«prepare deploy»** — выполнить чеклист **полностью**, без лишних вопросов.

**Жёсткое правило:** `.cursor/rules/workflow-app-only.mdc` — работа только в `app/`, **без папки `Release/`**.

---

## 1. Проверка `app/`

| Проверка | Действие |
|----------|----------|
| `app/index.html` | главный файл, без сломанной разметки |
| `app/sw.js` | версия кэша актуальна (§2) |
| `app/manifest.json` | иконки на месте |
| `app/js/app-config.js` | ключи API на месте |
| `app/styles/*.css` | 9 файлов |
| `app/assets/` | `app-icon.png`, `brand-logo.png` |
| `app/data/` | конфиги, `release-notes.json` |
| Новые статические файлы | добавить в `PRECACHE_ASSETS` в `app/sw.js` |

**Не включать:** `Ins_pan/`, черновые логотипы в корне, `tools/_tmp*`, отладочный ingest.

---

## 2. Service Worker (`app/sw.js`)

1. Поднять версию: `CACHE_VERSION = 'da_vX_Y_Z'` (patch +1 от STABLE).
2. Обновить комментарий в первой строке.
3. Проверить `PRECACHE_ASSETS` — все новые файлы из `app/`.
4. Убрать отладочный код.

---

## 3. Release notes

Обновить `app/data/release-notes.json`: `"version"`, `"tags"`, `"highlights"`.

---

## 4. Снимок перед деплоем

```bash
npm run snapshot
```

Создаёт:

- `Version/snapshots/index X.Y.Z.html`
- `Version/snapshots/styles X.Y.Z/`

Версия берётся из `app/sw.js`.

---

## 5. Документация версий

### `Version/STABLE.txt`

- номер версии ★, дата, Service Worker
- **Деплой: содержимое `app/`**
- пути снимков
- ключевые изменения

### `Version/Commit.txt`

Блок в конце по образцу предыдущих версий. Без упоминания `Release/`.

---

## 6. Git-коммит

**Stage:**

```
app/
Version/STABLE.txt
Version/Commit.txt
Version/snapshots/index X.Y.Z.html
Version/snapshots/styles X.Y.Z/
google-script/     — если менялся
package.json       — если менялся
```

**Не stage:** `Release/`, `Ins_pan/`, лишние PNG, `secrets.local.json`.

### Сообщение коммита

```
release: vX.Y.Z STABLE — <краткое резюме>

- …
- ui/chore: SW da_vX_Y_Z, snapshot в Version/
```

---

## 7. Деплой на GitHub

1. Залить **всё содержимое `app/`** в корень сайта (или подпапку PWA).
2. Обязательно: `index.html`, `sw.js`, `js/app-config.js`, `styles/`, `data/`.
3. После залива — сброс Service Worker / Ctrl+F5.
4. Проверить: вход, маршрут, календарь, экспорт .ics, «Сообщить о проблеме».

---

## 8. Google Apps Script (если менялся API)

1. `npm run clasp:push` — **не** `clasp deploy`.
2. Ручной deploy в script.google.com → Web app.

---

## 9. Шпаргалка агента

```
1. git status + diff
2. Аудит app/, bump sw.js, release-notes.json
3. npm run snapshot
4. Version/STABLE.txt + Version/Commit.txt
5. git add app/ + Version/ → commit
6. Отчёт: версия, SW, снимок, hash. Деплой = app/
```

**Push** — только по явной просьбе.
