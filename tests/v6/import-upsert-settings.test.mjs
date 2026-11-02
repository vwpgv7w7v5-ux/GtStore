import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-upsert-'));
const { server } = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
const req = async (p, o = {}) => {
  const r = await fetch(base + p, {
    ...o,
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const b = r.status === 204 ? null : await r.json();
  if (!r.ok) throw Object.assign(new Error(b?.error?.message), { status: r.status, body: b });
  return b;
};

try {
  await req('/bootstrap', {
    method: 'POST',
    body: { email: 'up@test.local', password: 'Password123!', name: 'Owner' },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'up@test.local', password: 'Password123!' },
  });
  const token = login.token;
  const me = await req('/me', { token });
  const ws = me.workspaces[0];
  const shop = (await req(`/workspaces/${ws.id}/shops`, { token }))[0];
  const root = `/workspaces/${ws.id}/shops/${shop.id}`;

  const csv1 = [
    'Название;SKU;Цена;Остаток;Категория',
    'Товар A;UPSERT-1;1000;5;Новинки',
  ].join('\n');
  const payload = {
    filename: 'a.csv',
    base64: Buffer.from(csv1).toString('base64'),
  };
  const first = await req(`${root}/import/commit`, {
    method: 'POST',
    token,
    body: payload,
  });
  assert.equal(first.imported, 1);
  assert.equal(first.updated, 0);

  const csv2 = [
    'Название;SKU;Цена;Остаток;Категория',
    'Товар A updated;UPSERT-1;1200;9;Новинки',
  ].join('\n');
  const second = await req(`${root}/import/commit`, {
    method: 'POST',
    token,
    body: {
      filename: 'b.csv',
      base64: Buffer.from(csv2).toString('base64'),
    },
  });
  assert.equal(second.imported, 0);
  assert.equal(second.updated, 1);
  const products = await req(`${root}/products`, { token });
  assert.equal(products.length, 1);
  assert.equal(products[0].price, 1200);
  assert.equal(products[0].stock, 9);

  const media = await req(root + '/media', { method: 'POST', token, body: {
    dataUrl: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', originalName: 'logo.png' } });
  const updatedShop = await req(`/workspaces/${ws.id}/shops/${shop.id}`, {
    method: 'PATCH',
    token,
    body: {
      name: 'Brand Shop',
      logoUrl: media.url,
      faviconUrl: media.url,
      currency: 'RUB',
    },
  });
  assert.equal(updatedShop.name, 'Brand Shop');
  assert.equal(updatedShop.logoUrl, media.url);

  const key = await req(`${root}/api-keys`, {
    method: 'POST',
    token,
    body: { name: 'Public API' },
  });
  assert.ok(key.token.startsWith('gtk_'));
  const keys = await req(`${root}/api-keys`, { token });
  assert.equal(keys.length, 1);

  const referral = await req(`${root}/referrals`, {
    method: 'POST',
    token,
    body: { telegram: '42', name: 'Partner', rewardPercent: 15 },
  });
  assert.ok(referral.code);

  const invite = await req(`/workspaces/${ws.id}/team/invites`, {
    method: 'POST',
    token,
    body: { email: 'staff2@test.local', role: 'viewer', shopIds: [shop.id] },
  });
  assert.ok(invite.acceptUrl);
  assert.equal(invite.mailStatus, 'logged');

  const promo = await req(`${root}/promotions`, {
    method: 'POST',
    token,
    body: { code: 'SAVE10', type: 'percent', value: 10 },
  });
  assert.equal(promo.code, 'SAVE10');

  console.log('V6 import upsert settings tests passed');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
