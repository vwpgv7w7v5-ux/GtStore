import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-apikey-'));
const { server } = createApp({
  databaseFile: path.join(temp, 'db.json'),
  mediaDirectory: path.join(temp, 'media'),
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
    body: { email: 'keys@test.local', password: 'ChangeMe123!', name: 'Keys' },
  });
  const login = await request('/auth/login', {
    method: 'POST',
    body: { email: 'keys@test.local', password: 'ChangeMe123!' },
  });
  const auth = { authorization: `Bearer ${login.token}` };
  const me = await request('/me', { headers: auth });
  const workspace = me.workspaces[0];
  const shop = (
    await request(`/workspaces/${workspace.id}/shops`, { headers: auth })
  )[0];
  const created = await request(
    `/workspaces/${workspace.id}/shops/${shop.id}/api-keys`,
    { method: 'POST', headers: auth, body: { name: 'CI', scopes: ['read'] } },
  );
  assert.match(created.token, /^gtk_/);
  const products = await request(
    `/workspaces/${workspace.id}/shops/${shop.id}/products`,
    { headers: { authorization: `Bearer ${created.token}` } },
  );
  assert.ok(Array.isArray(products));
  let failed = false;
  try {
    await request(`/workspaces/${workspace.id}/shops/${shop.id}/products`, {
      headers: { authorization: 'Bearer gtk_invalid_token_value_123456' },
    });
  } catch (error) {
    failed = error.status === 401;
  }
  assert.equal(failed, true);
  console.log('V6 API key auth tests passed');
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(temp, { recursive: true, force: true });
}
