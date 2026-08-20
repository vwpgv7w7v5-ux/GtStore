import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const calls = [];
const fakeFetch = async (url, options = {}) => {
  const method = url.split('/').at(-1);
  const payload = JSON.parse(options.body || '{}');
  calls.push({ method, payload });
  const result =
    method === 'getMe'
      ? { id: 777, username: 'gtstore_test_bot' }
      : method === 'sendMessage'
        ? { message_id: 101, chat: { id: payload.chat_id } }
        : true;
  return { ok: true, json: async () => ({ ok: true, result }) };
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-miniapp-'));
const { server } = createApp({
  databaseFile: path.join(temp, 'db.json'),
  mediaDirectory: path.join(temp, 'media'),
  fetch: fakeFetch,
  telegramSecret: 'test-secret',
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const base = `${origin}/api/v6`;
const request = async (url, options = {}) => {
  const response = await fetch(base + url, {
    ...options,
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const body = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    throw Object.assign(new Error(body?.error?.message || 'HTTP error'), {
      status: response.status,
      body,
    });
  }
  return body;
};

try {
  await request('/bootstrap', {
    method: 'POST',
    body: { email: 'owner@test.local', password: 'ChangeMe123!', name: 'Owner' },
  });
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: 'owner@test.local', password: 'ChangeMe123!' },
  });
  const auth = { authorization: `Bearer ${login.token}` };
  const me = await request('/me', { headers: auth });
  const workspace = me.workspaces[0];
  const shop = (
    await request(`/workspaces/${workspace.id}/shops`, { headers: auth })
  )[0];
  const miniAppUrl = `https://store.example.com/app/?shop=${shop.slug}`;

  let failed = false;
  try {
    await request(`/workspaces/${workspace.id}/shops/${shop.id}/telegram/connect`, {
      method: 'POST',
      headers: auth,
      body: {
        token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        adminChatId: '-100123',
        miniAppUrl: 'http://insecure.example/app',
      },
    });
  } catch (error) {
    failed = true;
    assert.match(error.message, /https/i);
  }
  assert.equal(failed, true);

  const connected = await request(
    `/workspaces/${workspace.id}/shops/${shop.id}/telegram/connect`,
    {
      method: 'POST',
      headers: auth,
      body: {
        token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        adminChatId: '-100123',
        webhookUrl: `${origin}/api/v6/telegram/webhook/${shop.id}`,
        webhookSecret: 'hook-secret',
        miniAppUrl,
      },
    },
  );
  assert.equal(connected.miniAppUrl, miniAppUrl);
  assert.ok(
    calls.some(
      (item) =>
        item.method === 'setChatMenuButton' &&
        item.payload.menu_button?.web_app?.url === miniAppUrl,
    ),
  );

  const appPage = await fetch(`${origin}/app/?shop=${shop.slug}`);
  assert.equal(appPage.status, 200);
  const html = await appPage.text();
  assert.match(html, /telegram-web-app\.js/);
  assert.match(html, /storefront\.js/);

  const css = await fetch(`${origin}/app/storefront.css`);
  assert.equal(css.status, 200);

  calls.length = 0;
  const start = await fetch(`${base}/telegram/webhook/${shop.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': 'hook-secret',
    },
    body: JSON.stringify({
      message: { chat: { id: 42 }, text: '/start' },
    }),
  });
  assert.equal(start.status, 200);
  const startBody = await start.json();
  assert.equal(startBody.opened, true);
  const welcome = calls.find((item) => item.method === 'sendMessage');
  assert.equal(
    welcome.payload.reply_markup.inline_keyboard[0][0].web_app.url,
    miniAppUrl,
  );

  console.log('V6 Mini App open tests passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
