# GtStore v6.17 — Warehouse Core

Релиз добавляет единый складской контур поверх каталога и заказов.

## Реализовано

- сводка остатков по SKU и вариантам;
- показатели общего, доступного, низкого и нулевого остатка;
- ручная приёмка и списание;
- перемещение остатков между вариантами одного товара;
- журнал складских движений;
- завершённая инвентаризация с автоматической корректировкой;
- автоматическое движение `sale` при оформлении заказа;
- автоматический возврат остатка при отмене заказа;
- фильтрация движений по типу и поиск в остатках.

## API

- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/inventory`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/metrics`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/movements`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/adjust`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/transfer`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/stocktakes`
- `POST /api/v6/workspaces/:workspaceId/shops/:shopId/warehouse/stocktakes`

## Проверка

```bash
npm run v6:warehouse:test
npm run v6:test
```
