import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-auth-'));
const app = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
});
await new Promise((r) => app.server.listen(0, r));
const base = `http://127.0.0.1:${app.server.address().port}/api/v6`;
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
  return { status: r.status, body: b };
};

try {
  let result = await req('/auth/register', {
    method: 'POST',
    body: {
      email: 'owner@acme.test',
      password: 'Secret123!',
      name: 'Owner',
      workspaceName: 'Acme',
      shopName: 'Acme Shop',
      shopSlug: 'acme-shop',
    },
  });
  assert.equal(result.status, 201);
  assert.ok(result.body.token);
  assert.equal(result.body.workspace.name, 'Acme');
  assert.equal(result.body.shop.slug, 'acme-shop');
  let token = result.body.token;

  result = await req('/auth/register', {
    method: 'POST',
    body: {
      email: 'owner@acme.test',
      password: 'Secret123!',
      name: 'Dup',
    },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'EMAIL_EXISTS');

  result = await req('/auth/refresh', { method: 'POST', token });
  assert.equal(result.status, 200);
  assert.ok(result.body.token);
  assert.notEqual(result.body.token, token);
  const oldToken = token;
  token = result.body.token;

  result = await req('/me', { token: oldToken });
  assert.equal(result.status, 401);

  result = await req('/me', { token });
  assert.equal(result.status, 200);
  const workspaceId = result.body.workspaces[0].id;

  result = await req(`/workspaces/${workspaceId}/shops`, {
    method: 'POST',
    token,
    body: { name: 'Second', slug: 'acme-shop' },
  });
  assert.equal(result.status, 409);
  assert.equal(result.body.error.code, 'SHOP_SLUG_EXISTS');

  result = await req(`/workspaces/${workspaceId}/shops`, {
    method: 'POST',
    token,
    body: { name: 'Second Shop' },
  });
  assert.equal(result.status, 201);
  assert.ok(result.body.slug);

  result = await req('/workspaces', {
    method: 'POST',
    token,
    body: { name: 'Second Space', shopName: 'Space Shop' },
  });
  assert.equal(result.status, 201);
  assert.equal(result.body.workspace.name, 'Second Space');

  result = await req('/auth/logout', { method: 'POST', token });
  assert.equal(result.status, 204);
  result = await req('/me', { token });
  assert.equal(result.status, 401);

  console.log('V6 auth onboarding tests passed');
} finally {
  await new Promise((r) => app.server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
