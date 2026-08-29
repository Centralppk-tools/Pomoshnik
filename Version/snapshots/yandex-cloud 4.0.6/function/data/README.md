# Данные приложения (сервер)

Источник правды для продакшена: `yandex-cloud/function/data/`.

Клиент грузит через Cloud Function:

| api= | Файл |
|------|------|
| `spr` | spr.json |
| `trains-local` | trains-local.json |
| `shift-templates` | shift-templates.json |
| `calendar-local-routes` | calendar-local-routes.json |
| `line-sections` | line-sections.json |
| `brakes` | расчёт из spr |
| `shift-template` | шаблон смены |
| `pay-summary` | POST оплата |
| `instructions-catalog` / `instructions-chunk` / `instructions-search` | инструкции |

Копии в `app/` могут оставаться для админки `Ins_pan/` и локального fallback, но **на GitHub Pages не заливаются** (`tools/deploy-github.mjs`).

PDF инструкций пока могут оставаться в `app/data/instructions/pdf/` для просмотра; текст/поиск — на сервере.
