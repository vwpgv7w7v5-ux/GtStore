# GtStore v6.4 — Checkout & Orders

## Реализовано

- Публичное оформление заказа из web/Telegram Mini App.
- Контактные данные покупателя, доставка, адрес, способ оплаты и комментарий.
- Серверный пересчёт цены: клиент не может подменить стоимость товара.
- Проверка доступности и атомарное списание остатков.
- Нумерация заказов и строки заказа со снимком SKU, названия и цены.
- Состояния заказа и проверяемые переходы между ними.
- Возврат остатка при отмене заказа.
- Журнал событий заказа.
- Уведомление о новом заказе в хранилище платформы.
- Административный список заказов, поиск, фильтр, метрики и карточка заказа.
- Изменение статуса, оплаты и внутренней заметки.

## API

- `GET /api/v6/public/storefronts/:slug/checkout-config`
- `POST /api/v6/public/storefronts/:slug/orders`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/orders`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/orders/metrics`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/orders/:orderId`
- `PATCH /api/v6/workspaces/:workspaceId/shops/:shopId/orders/:orderId`

## Проверка

```bash
npm run v6:orders:test
npm run v6:test
```
