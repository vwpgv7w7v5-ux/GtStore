'use strict';
const assert = require('assert');
const {
  publicBase,
  ensureHttpsWebAppUrl,
  absoluteShopUrl,
  webAppUrlFor,
  keyboardForBot,
} = require('../src/channels/telegram-webapp');

const shop = { slug: 'gttobacco' };
const bot = {
  buttonText: 'Открыть магазин',
  menu: [{ text: 'Каталог', action: 'webapp', value: '/shop/gttobacco' }],
};
const req = { headers: { host: 'localhost:3000', 'x-forwarded-proto': 'http' } };

assert.throws(() => ensureHttpsWebAppUrl('http://example.com/shop'), /HTTPS/);
assert.equal(ensureHttpsWebAppUrl('https://store.example.com/shop/demo/'), 'https://store.example.com/shop/demo');

assert.equal(
  absoluteShopUrl(req, shop, '', { publicBaseUrl: 'https://store.example.com' }),
  'https://store.example.com/shop/gttobacco',
);
assert.equal(
  webAppUrlFor(req, bot, shop, '/shop/gttobacco', { publicBaseUrl: 'https://store.example.com' }),
  'https://store.example.com/shop/gttobacco',
);
assert.throws(
  () => webAppUrlFor(req, bot, shop, '', { publicBaseUrl: '' }),
  /HTTPS/,
);

const keyboard = keyboardForBot(req, bot, shop, { publicBaseUrl: 'https://store.example.com' });
assert.equal(keyboard.inline_keyboard[0][0].web_app.url, 'https://store.example.com/shop/gttobacco');

assert.equal(publicBase(req, { publicBaseUrl: 'https://a.test/' }), 'https://a.test');
console.log('telegram-webapp helpers tests passed');
