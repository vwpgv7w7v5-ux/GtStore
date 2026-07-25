# GtStore v5.0 Platform Rebuild

This release starts the production architecture without removing the runnable legacy application.

## Implemented foundation

- TypeScript workspace layout for API, admin and storefront applications.
- Shared contracts for catalog, orders and storefront blocks.
- Domain services for money, identifiers, referral rewards and order status transitions.
- Modular API services for categories, products, stock reservations, orders, storefront publishing, delivery zones, custom payment fields, referrals, support tickets, knowledge base search and two-sheet imports.
- Channel adapter contracts plus Telegram and MAX implementations.
- Integration adapter contract plus generic REST implementation.
- PostgreSQL/Prisma data model for users, workspaces, shops, catalog, customers, orders and storefront versions.
- Vision UI v5 components for application shell, product editor and storefront builder.

## Migration strategy

The existing server remains available through `npm start`. The new source tree can be adopted module-by-module. This avoids breaking the current prototype while the new API and React applications are wired and tested.

## Not yet production-complete

- Prisma client generation and database migrations require PostgreSQL and dependency installation.
- React bundling configuration is not included in this archive yet.
- Payment providers, MAX production credentials, MySklad, 1C and Bitrix24 require external credentials and sandbox accounts.
- S3 media processing and background jobs remain next-stage work.
