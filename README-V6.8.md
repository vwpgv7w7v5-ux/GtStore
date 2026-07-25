# GtStore v6.8 — Promotions & Loyalty Checkout

## Реализовано

- общие промокоды: процентные и фиксированные;
- минимальная сумма заказа, даты действия, общий лимит и лимит на клиента;
- персональные промокоды из CRM;
- предварительный серверный расчёт скидки;
- применение промокода и бонусов в одной атомарной операции;
- ограничение списания бонусов до 30% суммы после промокода;
- ledger списания бонусов с привязкой к заказу;
- защита от повторного использования промокода;
- хранение скидки, промокода и списанных бонусов в заказе;
- поля промокода и бонусов в checkout витрины.

## API

- `POST /api/v6/public/storefronts/:slug/checkout/quote`
- `POST /api/v6/public/storefronts/:slug/orders`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/promotions`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/promotions`
- `PATCH /api/v6/workspaces/:workspaceId/shops/:shopId/promotions/:promoId`

## Проверка

```bash
npm run v6:promotions:test
npm run v6:test
```
