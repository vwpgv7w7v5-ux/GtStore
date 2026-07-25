# GtStore v6.5 — Telegram Orders & Notifications

## Реализовано

- Подключение Telegram-бота через BotFather token.
- Проверка токена через `getMe`.
- AES-256-GCM шифрование токена в локальном хранилище.
- Настройка admin chat ID, webhook URL и webhook secret.
- Автоматическое уведомление администратора о новом заказе.
- Inline-кнопки изменения статуса заказа.
- Webhook с проверкой `X-Telegram-Bot-Api-Secret-Token`.
- Тестовое сообщение и отключение бота.
- Telegram-настройки в админке.
- Сохранение Telegram ID клиента в заказе.

## API

- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/telegram`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/telegram/connect`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/telegram/test`
- `DELETE /api/v6/workspaces/:workspaceId/shops/:shopId/telegram`
- `POST /api/v6/telegram/webhook/:shopId`

## Безопасность

Для production обязательно задайте уникальный `GTSTORE_TOKEN_SECRET` и HTTPS webhook URL. Токен не возвращается через API и не сохраняется открытым текстом.

## Проверка

```bash
npm run v6:test
npm run v6:telegram:test
```
