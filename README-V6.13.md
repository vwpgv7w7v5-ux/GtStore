# GtStore v6.13 — Analytics Core

Добавлен единый аналитический модуль: события витрины, выручка, заказы, средний чек, конверсия, воронка, динамика по дням, лидеры товаров, источники, CRM-показатели, метрики кампаний и автоматизаций.

## API

- `POST /api/v6/public/storefronts/:slug/analytics/events`
- `GET /api/v6/workspaces/:workspaceId/shops/:shopId/analytics?days=30`

## Проверка

```bash
npm run v6:analytics:test
npm run v6:test
```
