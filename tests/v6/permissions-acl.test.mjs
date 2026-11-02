import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-acl-'));
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
  if (!r.ok) throw Object.assign(new Error(b?.error?.message || String(b)), { status: r.status, body: b });
  return b;
};

try {
  const boot = await req('/bootstrap', {
    method: 'POST',
    body: { email: 'acl@test.local', password: 'Password123!', name: 'Owner' },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'acl@test.local', password: 'Password123!' },
  });
  const token = login.token;
  const ws = boot.workspace;
  const shop = boot.shop;
  const root = `/workspaces/${ws.id}/shops/${shop.id}`;

  const invite = await req(`/workspaces/${ws.id}/team/invites`, {
    method: 'POST',
    token,
    body: { email: 'viewer@test.local', role: 'viewer', shopIds: [shop.id] },
  });
  await req('/team/invites/accept', {
    method: 'POST',
    body: { token: invite.token, name: 'Viewer', password: 'Password123!' },
  });
  const viewerLogin = await req('/auth/login', {
    method: 'POST',
    body: { email: 'viewer@test.local', password: 'Password123!' },
  });
  const viewerToken = viewerLogin.token;

  const cat = await req(root + '/categories', { method: 'POST', token, body: { name: 'ACL' } });

  await assert.rejects(
    () => req(root + '/products', {
      method: 'POST',
      token: viewerToken,
      body: { name: 'Denied', sku: 'ACL-1', categoryId: cat.id, price: 100, stock: 1, active: true },
    }),
    (err) => err.status === 403 && err.body?.error?.code === 'PERMISSION_DENIED',
  );

  const product = await req(root + '/products', {
    method: 'POST',
    token,
    body: { name: 'Allowed', sku: 'ACL-2', categoryId: cat.id, price: 100, stock: 5, active: true },
  });

  const order = await req(`/public/storefronts/${shop.slug}/orders`, {
    method: 'POST',
    body: {
      customer: { name: 'Kirill', phone: '+79990000000' },
      items: [{ productId: product.id, quantity: 1 }],
    },
  });
  await assert.rejects(
    () => req(root + `/orders/${order.id}`, {
      method: 'PATCH',
      token: viewerToken,
      body: { status: 'confirmed' },
    }),
    (err) => err.status === 403 && err.body?.error?.code === 'PERMISSION_DENIED',
  );

  const confirmed = await req(root + `/orders/${order.id}`, {
    method: 'PATCH',
    token,
    body: { status: 'confirmed' },
  });
  assert.equal(confirmed.status, 'confirmed');

  console.log('V6.21 permissions ACL tests passed');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
