# Google Apps Script — деплой API (обратная связь + депо)

Активный deployment ID (v38, 2026-07-23):
  AKfycbyXZtOedTna78AwC4bvdGnMqXxqZ1cflSwODYXYIjm7zWA2BfYqpBJlhDZ0JzqozW4RkA

URL (прописан в app/index.html → DEPOT_API_DEPLOYMENT_ID):
  https://script.google.com/macros/s/AKfycbyXZtOedTna78AwC4bvdGnMqXxqZ1cflSwODYXYIjm7zWA2BfYqpBJlhDZ0JzqozW4RkA/exec

## ВАЖНО: не использовать clasp deploy для Web App

`clasp create-deployment` обновляет версию, но ломает публичный /exec (404).
Код заливать только так:  npm run clasp:push

Веб-приложение разворачивать ТОЛЬКО вручную:
1. https://script.google.com → проект депо
2. Развернуть → Управление развертываниями
3. Карандаш у активного Web App (или «Новое развертывание» → Web app)
4. Выполнять от имени: Я · Доступ: Все
5. Сохранить — скопировать URL /exec в DEPOT_API_DEPLOYMENT_ID если ID изменился

## Проверка

Открыть в браузере:
  .../exec?check=version
Должен быть JSON (version/dataVersion), НЕ HTML «Datei kann derzeit nicht geöffnet werden».

  .../exec?action=feedback&message=test
Должен быть {"ok":true}

  .../exec?action=gcalToken&code=test&redirect_uri=http://127.0.0.1:8765/google-oauth-callback.html&code_verifier=test
Должен быть JSON с ok:false (не employees!) — значит gcalToken подключён.
После npm run clasp:push обязательно переразвернуть Web App (шаги выше).

## Очистка старых деплоев

npm run clasp:cleanup-deployments
(оставляет только активный ID и @HEAD; лимит Google — 20 штук)

## Telegram @bag_rep_bot

Таблица → «Депо Скрипты» → «Настроить баг-репортер» → /start боту
