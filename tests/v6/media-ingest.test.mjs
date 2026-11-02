import assert from 'node:assert/strict';
import fs from 'node:fs';
import { Readable } from 'node:stream';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-media-ingest-'));
const databaseFile = path.join(tmp, 'db.json');
const mediaDirectory = path.join(tmp, 'media');

const pixel = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);

const remoteUrl = 'https://images.example.com/remote.png';
let downloads = 0;
const { server } = createApp({ databaseFile, mediaDirectory, mediaOptions: { remoteOptions: {
  proxy: null, lookup: async () => [{ address: '93.184.216.34', family: 4 }],
  request: async url => {
    assert.equal(url.href, remoteUrl); downloads++;
    return Object.assign(Readable.from([pixel]), { statusCode: 200, headers: { 'content-type': 'image/png' } });
  },
} } });
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;

const request = async (route, options = {}) => {
  const response = await fetch(base + route, {
    method: options.method || 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
};

await request('/bootstrap', {
  method: 'POST',
  body: { email: 'owner@ingest.local', password: 'StrongPass123!', name: 'Owner' },
});
const login = await request('/auth/login', {
  method: 'POST',
  body: { email: 'owner@ingest.local', password: 'StrongPass123!' },
});
const token = login.data.token;
const me = (await request('/me', { token })).data;
const workspace = me.workspaces[0];
const shop = (await request(`/workspaces/${workspace.id}/shops`, { token })).data[0];
const root = `/workspaces/${workspace.id}/shops/${shop.id}`;

const created = await request(root + '/products', {
  method: 'POST',
  token,
  body: {
    name: 'Remote photo product',
    sku: 'INGEST-001',
    price: 100,
    stock: 1,
    images: [{ url: remoteUrl, primary: true }],
  },
});
assert.equal(created.response.status, 201, JSON.stringify(created.data));
assert.match(created.data.images[0].url, /^\/api\/v6\/media\//);
const filename = created.data.images[0].url.split('/').pop();
assert.equal(fs.existsSync(path.join(mediaDirectory, filename)), true);

const served = await fetch(base + '/media/' + filename);
assert.equal(served.status, 200);

const draft = await request(root + '/storefront', {
  method: 'PATCH',
  token,
  body: {
    vitrina: [
      {
        id: 'vit-1',
        placement: 'carousel',
        name: 'Баннер',
        title: '',
        subtitle: '',
        imageUrl: remoteUrl,
        priority: 1,
        visible: true,
      },
    ],
  },
});
assert.equal(draft.response.status, 200, JSON.stringify(draft.data));
assert.match(draft.data.vitrina[0].imageUrl, /^\/api\/v6\/media\//);

const shopPatch = await request(`/workspaces/${workspace.id}/shops/${shop.id}`, {
  method: 'PATCH',
  token,
  body: { logoUrl: remoteUrl },
});
assert.equal(shopPatch.response.status, 200, JSON.stringify(shopPatch.data));
assert.match(shopPatch.data.logoUrl, /^\/api\/v6\/media\//);

await new Promise((resolve) => server.close(resolve));
assert.equal(downloads, 1, 'Products, banners and logos must reuse one saved remote source');
fs.rmSync(tmp, { recursive: true, force: true });
console.log('V6 media ingest tests passed');
