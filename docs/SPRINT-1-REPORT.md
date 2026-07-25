# Sprint 1 — Foundation

## Реализовано

- Независимый API v6 на встроенном HTTP-сервере Node.js.
- PBKDF2-хеширование паролей и Bearer-сессии.
- Bootstrap первого владельца, рабочего пространства и магазина.
- Tenant isolation через workspace membership.
- Роли viewer, manager, admin и owner.
- Атомарное JSON-хранилище как локальный runtime fallback.
- CRUD-основа каталога: категории, товары, SKU, цены и остатки.
- Новая админка Vision v6 с реальным подключением к API.
- Docker Compose для PostgreSQL, Redis и MinIO.
- Интеграционные тесты без внешних зависимостей.

## Честные ограничения

PostgreSQL, Redis и MinIO подготовлены инфраструктурно, но текущий v6 runtime использует атомарное JSON-хранилище. Это позволяет запускать Sprint 1 без установки npm-пакетов. Следующий этап — Prisma repository и миграция runtime на PostgreSQL.
