# GtStore v6.11 — Automation Flows

Релиз добавляет настоящие триггерные сценарии поверх заказов.

## Триггеры

- `order_created` — после создания заказа.
- `order_status_changed` — при переходе заказа в выбранный статус.

## Возможности

- CRUD сценариев;
- включение и отключение;
- задержка до 7 дней;
- Telegram-сообщения покупателю;
- переменные `{{customer.name}}`, `{{order.number}}`, `{{order.total}}`, `{{event.to}}`;
- защита от повторного запуска одного правила для одного события;
- журнал запусков;
- метрики `pending`, `sent`, `failed`;
- scheduler endpoint для отложенных сообщений.

## API

- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/automations`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/automations`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId`
- `PATCH /api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId`
- `DELETE /api/v6/workspaces/:workspaceId/shops/:shopId/automations/:ruleId`
- `POST /api/v6/internal/automations/run-due`

Отложенный runner использует тот же `X-GtStore-Scheduler-Secret`, что и кампании.
