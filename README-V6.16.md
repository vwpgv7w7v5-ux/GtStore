# GtStore v6.16 — Payments Core

Добавлен единый платежный слой поверх заказов и checkout.

## Реализовано

- реестр провайдеров: Manual, ЮKassa, CloudPayments, Stripe;
- создание платежа по заказу;
- публичная проверка статуса;
- журнал платежей магазина и фильтр по статусу;
- статусы pending, authorized, paid, cancelled, expired, refunded, failed;
- HMAC-SHA256 подпись входящих webhook;
- синхронизация paymentStatus и статуса заказа;
- полный возврат оплаченного платежа;
- защита от повторного активного платежа для одного заказа.

Провайдеры ЮKassa, CloudPayments и Stripe реализованы как адаптерный контракт с тестовым checkout URL. Для production необходимо подключить реальные SDK и credentials.

## Проверка

```bash
npm run v6:payments:test
npm run v6:test
```
