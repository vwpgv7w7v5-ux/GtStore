import { createApp } from './app.js';

const port = Number(process.env.V6_PORT || 4000);
const host = process.env.HOST || '0.0.0.0';
const { server, telegram } = createApp({
  databaseFile: process.env.V6_DATABASE_FILE || 'data/v6.json',
  publicBaseUrl: process.env.PUBLIC_BASE_URL,
  storefrontUrl: process.env.STOREFRONT_URL,
  telegramSecret: process.env.GTSTORE_TOKEN_SECRET,
  paymentWebhookSecret: process.env.GTSTORE_PAYMENT_WEBHOOK_SECRET,
  yookassaShopId: process.env.YOOKASSA_SHOP_ID,
  yookassaSecretKey: process.env.YOOKASSA_SECRET_KEY,
  paymentReturnUrl: process.env.PAYMENT_RETURN_URL || process.env.STOREFRONT_URL,
  enableTelegramPolling: process.env.TELEGRAM_POLLING !== '0',
  yandexMapsApiKey: process.env.YANDEX_MAPS_API_KEY,
});

server.listen(port, host, () => {
  console.log(`GStore API v6: http://${host}:${port}`);
  telegram?.resumePolling?.();
});
