# GtStore v6.9 — Campaigns & Automation

Реализован серверный модуль CRM-кампаний для Telegram.

## Возможности

- кампании по сегментам `all`, `new`, `repeat`, `vip`;
- черновики и отложенный запуск;
- ручная отправка;
- защищённый endpoint планировщика;
- журнал доставки по каждому клиенту;
- метрики targeted / sent / failed;
- повторное использование зашифрованного Telegram-подключения магазина;
- блокировка повторной отправки завершённой кампании.

## API

- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/campaigns`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/campaigns`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId`
- `PATCH /api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/campaigns/:campaignId/send`
- `POST /api/v6/internal/campaigns/run-due`

Для production-планировщика задайте `GTSTORE_SCHEDULER_SECRET` и передавайте его в заголовке `X-GtStore-Scheduler-Secret`.

## Проверка

```bash
npm run v6:campaigns:test
npm run v6:test
```
