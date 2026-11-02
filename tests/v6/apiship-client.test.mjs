import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';
import { ApishipClient } from '../../apps/api-v6/src/delivery/apiship-client.js';

// Unit: ApishipClient normalizes live responses and surfaces HTTP errors for callers to catch.
{
  const okFetch = async (url) => {
    assert.ok(url.startsWith('https://api.apiship.ru/v1/points'));
    return {
      ok: true,
      json: async () => ({
        data: [
          {
            id: 'pvz1',
            code: 'pvz1',
            name: 'ПВЗ Тест',
            address: { fullAddress: 'Москва, ул. Тестовая, 1' },
            providerKey: 'cdek',
            address_geo: {},
          },
        ],
      }),
    };
  };
  const client = new ApishipClient('demo-token', { fetch: okFetch });
  const points = await client.listPoints({ city: 'Москва' });
  assert.equal(points.length, 1);
  assert.equal(points[0].carrier, 'cdek');
  assert.equal(points[0].address, 'Москва, ул. Тестовая, 1');
}

// Unit: missing token throws synchronously-caught error, letting service fall back to simulation.
{
  const client = new ApishipClient('', { fetch: async () => ({ ok: true, json: async () => ({}) }) });
  await assert.rejects(() => client.listPoints({ city: 'Москва' }), /APISHIP_TOKEN_MISSING/);
}

// Unit: non-ok HTTP response is rejected with a readable message.
{
  const failFetch = async () => ({
    ok: false,
    status: 500,
    json: async () => ({ message: 'boom' }),
  });
  const client = new ApishipClient('demo-token', { fetch: failFetch });
  await assert.rejects(() => client.calculator({}), /boom/);
}

// Integration: delivery service falls back to the simulated catalog when the live call fails.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-apiship-'));
const failingFetch = async (url) => {
  if (String(url).includes('api.apiship.ru')) throw new Error('network unavailable');
  return { ok: true, json: async () => ({}) };
};
const { server } = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
  fetch: failingFetch,
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
const req = async (p, o = {}) => {
  const r = await fetch(base + p, {
    ...o,
    headers: { 'content-type': 'application/json', ...(o.token ? { authorization: `Bearer ${o.token}` } : {}) },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const b = r.status === 204 ? null : await r.json();
  if (!r.ok) throw Object.assign(new Error(b?.error?.message || String(b)), { status: r.status, body: b });
  return b;
};

try {
  const boot = await req('/bootstrap', {
    method: 'POST',
    body: { email: 'apiship@test.local', password: 'Password123!', name: 'Owner' },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'apiship@test.local', password: 'Password123!' },
  });
  const shop = boot.shop;
  const workspaceId = boot.workspace.id;

  await req(`/workspaces/${workspaceId}/shops/${shop.id}/delivery/apiship`, {
    method: 'PUT',
    token: login.token,
    body: { token: 'fallback-demo-token' },
  });

  const points = await req(
    `/public/storefronts/${shop.slug}/delivery/points?city=Москва&carrier=cdek`,
  );
  assert.equal(points.live, false);
  assert.equal(points.source, 'apiship-simulated');
  assert.ok(points.points.length >= 1);

  const quote = await req(`/public/storefronts/${shop.slug}/delivery/quote`, {
    method: 'POST',
    body: { subtotal: 1000, city: 'Москва' },
  });
  assert.ok(Array.isArray(quote) && quote.length > 0);
  assert.ok(quote.every((q) => q.live === false));

  console.log('V6.21 apiship client fallback tests passed');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
