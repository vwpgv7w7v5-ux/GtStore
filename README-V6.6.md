# GtStore v6.6 — Telegram Identity & Customer Notifications

## Added

- Telegram Mini App `initData` verification using Telegram's HMAC-SHA256 algorithm.
- Expiring signed customer sessions.
- Customer profile and order history API.
- Automatic Telegram messages when an order status changes.
- Customer Telegram ID automatically attached to checkout orders.
- “Мои заказы” screen in the storefront when opened as a Telegram Mini App.

## API

- `POST /api/v6/public/storefronts/:slug/telegram/auth`
- `GET /api/v6/public/customer/me`

## Environment

- `GTSTORE_TOKEN_SECRET` — bot token encryption key.
- `GTSTORE_CUSTOMER_SESSION_SECRET` — optional separate customer session signing key.

## Verification

```bash
npm run v6:test
```
