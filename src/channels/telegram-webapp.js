'use strict';

function publicBase(req, { publicBaseUrl, port = 3000 } = {}) {
  if (publicBaseUrl) return String(publicBaseUrl).replace(/\/$/, '');
  const proto = String(req?.headers?.['x-forwarded-proto'] || '')
    .split(',')[0]
    .trim() || 'http';
  const host = String(req?.headers?.['x-forwarded-host'] || req?.headers?.host || `localhost:${port}`)
    .split(',')[0]
    .trim();
  return `${proto}://${host}`;
}

function ensureHttpsWebAppUrl(url) {
  const u = String(url || '').trim();
  if (!/^https:\/\//i.test(u)) {
    throw new Error(
      'Для Telegram Mini App нужен HTTPS. Задайте PUBLIC_BASE_URL=https://ваш-домен в .env',
    );
  }
  return u.replace(/\/$/, '');
}

function absoluteShopUrl(req, shop, pathValue, options = {}) {
  const base = publicBase(req, options).replace(/\/$/, '');
  const raw = String(pathValue || '').trim();
  const path = raw.startsWith('/') ? raw : `/shop/${shop.slug}`;
  return `${base}${path}`;
}

function webAppUrlFor(req, bot, shop, value, options = {}) {
  const raw = String(value || '').trim();
  if (/^https?:\/\//i.test(raw)) return ensureHttpsWebAppUrl(raw);
  if (raw.startsWith('/')) {
    return ensureHttpsWebAppUrl(`${publicBase(req, options).replace(/\/$/, '')}${raw}`);
  }
  const fromMenu = (bot?.menu || []).find((m) => m.action === 'webapp');
  return ensureHttpsWebAppUrl(absoluteShopUrl(req, shop, fromMenu && fromMenu.value, options));
}

function keyboardForBot(req, bot, shop, options = {}) {
  const rows = [];
  for (const item of bot.menu || []) {
    const text = String(item.text || 'Кнопка');
    const value = String(item.value || '');
    let button = { text };
    if (item.action === 'webapp') {
      button.web_app = { url: webAppUrlFor(req, bot, shop, value, options) };
    } else if (item.action === 'url') {
      button.url = value;
    } else if (item.action === 'command') {
      button.callback_data = `command:${value.replace(/^\//, '')}`;
    } else {
      button.callback_data = value || 'noop';
    }
    rows.push([button]);
  }
  if (!rows.length) {
    rows.push([
      {
        text: bot.buttonText || 'Открыть магазин',
        web_app: { url: webAppUrlFor(req, bot, shop, '', options) },
      },
    ]);
  }
  return { inline_keyboard: rows };
}

module.exports = {
  publicBase,
  ensureHttpsWebAppUrl,
  absoluteShopUrl,
  webAppUrlFor,
  keyboardForBot,
};
