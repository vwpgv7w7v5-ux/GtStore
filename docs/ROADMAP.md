# GtStore — дорожная карта

## Этап 1. Production Core (4–6 недель)
- TypeScript monorepo: apps/admin, apps/storefront, apps/api, packages/ui, packages/contracts.
- PostgreSQL + Prisma, Redis, S3-compatible storage.
- Tenant isolation, RBAC, audit log, secure auth.
- Catalog CRUD, categories tree, variants, media library, two-sheet import with validation preview.
- Order state machine and stock reservations.

## Этап 2. Commerce (4–5 недель)
- Payment provider adapters and webhook reconciliation.
- Delivery zones on map, pickup points, custom checkout fields.
- Promo/referral/loyalty ledger.
- Telegram and MAX channel adapters.
- Notification templates and event-driven messaging.

## Этап 3. Growth (3–5 недель)
- Segments, campaigns, consent and unsubscribe management.
- Funnel analytics, cohorts, repeat purchase, attribution.
- Storefront block editor, versioning, preview and publish workflow.
- Knowledge base, ticketing SLA and operator inbox.

## Этап 4. Ecosystem (4–8 недель)
- МойСклад, 1С, Bitrix24 production adapters.
- Public REST API, webhooks, OAuth apps and integration marketplace.
- Import/sync scheduler, conflict resolution and retry queues.
- White label and custom domains.

## Definition of Done
Каждый модуль имеет: schema, API contract, permissions, audit, validation, tests, empty/loading/error states, observability and documentation.
