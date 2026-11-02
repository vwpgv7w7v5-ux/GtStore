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
      ? { id: 777, username: 'gtstore_auto_bot' }
      : method === 'sendMessage'
        ? { message_id: 202, chat: { id: payload.chat_id } }
        : true;
  return { ok: true, json: async () => ({ ok: true, result }) };
};

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-tg-auto-'));
const publicBaseUrl = 'https://shop.example.com';
const storefrontUrl = 'https://store.example.com';
const { server } = createApp({
  databaseFile: path.join(temp, 'db.json'),
  mediaDirectory: path.join(temp, 'media'),
  fetch: fakeFetch,
  telegramSecret: 'test-secret',
  publicBaseUrl,
  storefrontUrl,
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
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
    body: {
      email: 'owner@test.local',
      password: 'ChangeMe123!',
      name: 'Owner',
    },
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

  calls.length = 0;
  const connected = await request(
    `/workspaces/${workspace.id}/shops/${shop.id}/telegram/connect`,
    {
      method: 'POST',
      headers: auth,
      body: {
        token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        adminChatId: '-100999',
      },
    },
  );
  assert.equal(connected.connected, true);
  assert.equal(connected.autoWebhook, true);
  assert.equal(
    connected.webhookUrl,
    `${publicBaseUrl}/api/v6/telegram/webhook/${shop.id}`,
  );
  assert.ok(calls.some((c) => c.method === 'setWebhook'));
  assert.ok(calls.some((c) => c.method === 'setChatMenuButton'));
  const setWebhook = calls.find((c) => c.method === 'setWebhook');
  assert.ok(setWebhook.payload.secret_token);
  assert.deepEqual(setWebhook.payload.allowed_updates, [
    'message',
    'callback_query',
    'my_chat_member',
  ]);

  const raw = JSON.parse(fs.readFileSync(path.join(temp, 'db.json'), 'utf8'));
  const secret = raw.telegramConfigs[0].webhookSecret;
  assert.ok(secret);

  calls.length = 0;
  const startRes = await fetch(
    `${base}/telegram/webhook/${shop.id}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-telegram-bot-api-secret-token': secret,
      },
      body: JSON.stringify({
        message: {
          message_id: 1,
          chat: { id: 4242 },
          from: { id: 4242, username: 'buyer', first_name: 'Buyer' },
          text: '/start',
        },
      }),
    },
  );
  assert.equal(startRes.status, 200);
  const startBody = await startRes.json();
  assert.equal(startBody.handled, 'start');
  const startMsg = calls.find((c) => c.method === 'sendMessage');
  assert.ok(startMsg.payload.text.includes(shop.name));
  assert.ok(
    startMsg.payload.reply_markup.inline_keyboard[0][0].web_app.url.includes(
      shop.slug,
    ),
  );

  calls.length = 0;
  const helpRes = await fetch(`${base}/telegram/webhook/${shop.id}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-telegram-bot-api-secret-token': secret,
    },
    body: JSON.stringify({
      message: { message_id: 2, chat: { id: 4242 }, text: '/help' },
    }),
  });
  assert.equal(helpRes.status, 200);
  assert.equal((await helpRes.json()).handled, 'help');

  console.log('V6 telegram auto-webhook tests passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
