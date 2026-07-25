# GtStore v6.15 — Webhooks & Integrations

Добавлен production-oriented слой исходящих webhooks для подключения CRM, ERP, складских систем и внешней аналитики.

## Возможности

- CRUD webhook-интеграций на уровне магазина.
- События `order.created`, `order.updated`, `order.status_changed`, `customer.created`, `campaign.sent`.
- Подпись каждого запроса HMAC-SHA256 в `X-GtStore-Signature`.
- Однократная выдача signing secret и безопасное отображение preview.
- Ротация секрета.
- Тестовая доставка.
- Журнал последних 200 доставок в API, хранение до 5000 записей.
- Автоматическая отправка событий при создании и изменении заказа.
- HTTPS обязателен, кроме localhost для разработки.

## API

- `GET /api/v6/integrations/events`
- `GET|POST /api/v6/workspaces/:workspaceId/shops/:shopId/integrations`
- `PATCH|DELETE /api/v6/workspaces/:workspaceId/shops/:shopId/integrations/:hookId`
- `POST .../:hookId/test`
- `POST .../:hookId/rotate-secret`
- `GET .../integrations/deliveries`

Версия API: `6.15.0`.
