# GtStore v6.7 — Customer CRM & Loyalty

## Возможности

- единая клиентская база, автоматически собираемая из заказов;
- объединение клиента по Telegram ID, телефону или email;
- сегменты: новый, повторный, VIP;
- метрики LTV, среднего чека и бонусных обязательств;
- уровни Base, Silver, Gold, Platinum;
- автоматический кэшбэк 1–7% после завершения заказа;
- бонусный ledger с ручным начислением и списанием;
- карточка клиента с заказами, заметками и бонусной историей;
- персональные промокоды.

## API

- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/customers`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/customers/metrics`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey`
- `PATCH /api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey/bonus`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/customers/:customerKey/promos`

## Проверка

```bash
npm run v6:crm:test
npm run v6:test
```
