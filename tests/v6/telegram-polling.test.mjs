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
      ? { id: 42, username: 'gt_poll_bot' }
      : method === 'getUpdates'
        ? []
        : method === 'sendMessage'
          ? { message_id: 1 }
          : true;
  return { ok: true, json: async () => ({ ok: true, result }) };
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-tg-poll-'));
const { server, telegram } = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
  fetch: fakeFetch,
  telegramSecret: 'poll-secret',
  publicBaseUrl: 'http://77.222.35.15:4000',
  storefrontUrl: 'http://77.222.35.15:4174',
  enableTelegramPolling: true,
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
const req = async (p, o = {}) => {
  const r = await fetch(base + p, {
    ...o,
    headers: { 'content-type': 'application/json', ...(o.headers || {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const b = r.status === 204 ? null : await r.json();
  if (!r.ok) throw new Error(b?.error?.message || 'fail');
  return b;
};

try {
  await req('/bootstrap', {
    method: 'POST',
    body: { email: 'poll@test.local', password: 'Password123!', name: 'Poll' },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'poll@test.local', password: 'Password123!' },
  });
  const auth = { authorization: `Bearer ${login.token}` };
  const me = await req('/me', { headers: auth });
  const ws = me.workspaces[0];
  const shop = (await req(`/workspaces/${ws.id}/shops`, { headers: auth }))[0];

  calls.length = 0;
  const connected = await req(
    `/workspaces/${ws.id}/shops/${shop.id}/telegram/connect`,
    {
      method: 'POST',
      headers: auth,
      body: {
        token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',
        adminChatId: '1001',
      },
    },
  );
  assert.equal(connected.connected, true);
  assert.equal(connected.mode, 'polling');
  assert.equal(connected.webhookUrl, '');
  assert.ok(calls.some((c) => c.method === 'deleteWebhook'));
  assert.ok(!calls.some((c) => c.method === 'setWebhook'));
  assert.ok(telegram.pollers.has(shop.id));

  await req(`/workspaces/${ws.id}/shops/${shop.id}/telegram`, {
    method: 'DELETE',
    headers: auth,
  });
  assert.ok(!telegram.pollers.has(shop.id));
  console.log('V6 telegram polling tests passed');
} finally {
  telegram.stopPolling?.(
    [...telegram.pollers.keys()][0],
  );
  for (const id of [...telegram.pollers.keys()]) telegram.stopPolling(id);
  server.close();
}
