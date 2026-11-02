import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createApp } from '../../apps/api-v6/src/app.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-v62-'));
const databaseFile = path.join(tmp, 'db.json');
const mediaDirectory = path.join(tmp, 'media');
const { server } = createApp({ databaseFile, mediaDirectory });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
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

await request('/bootstrap', { method: 'POST', body: { email: 'owner@media.local', password: 'StrongPass123!', name: 'Owner' } });
const login = await request('/auth/login', { method: 'POST', body: { email: 'owner@media.local', password: 'StrongPass123!' } });
const token = login.data.token;
const me = (await request('/me', { token })).data;
const workspace = me.workspaces[0];
const shop = (await request(`/workspaces/${workspace.id}/shops`, { token })).data[0];
const root = `/workspaces/${workspace.id}/shops/${shop.id}`;

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const media = await request(root + '/media', { method: 'POST', token, body: { dataUrl: pixel, originalName: 'pixel.png', alt: 'Pixel' } });
assert.equal(media.response.status, 201);
assert.equal(media.data.mime, 'image/png');
assert.equal(fs.existsSync(path.join(mediaDirectory, media.data.filename)), true);
const served = await fetch(base + '/media/' + media.data.filename);
assert.equal(served.status, 200);
assert.equal(served.headers.get('content-type'), 'image/png');

const csv = [
  'Название;SKU;Цена;Остаток;Категория;Бренд;Изображение',
  `Товар один;CSV-001;990;5;Новинки;GT;${base}/media/${media.data.filename}`,
  'Товар два;CSV-002;1490;7;Новинки;GT;',
].join('\n');
const payload = { filename: 'products.csv', base64: Buffer.from(csv).toString('base64') };
const preview = await request(root + '/import/file', { method: 'POST', token, body: payload });
assert.equal(preview.response.status, 200);
assert.equal(preview.data.valid, true);
assert.equal(preview.data.total, 2);
assert.equal(preview.data.sheets[0].name, 'Товары');

const commit = await request(root + '/import/commit', { method: 'POST', token, body: payload });
assert.equal(commit.response.status, 201);
assert.equal(commit.data.imported, 2);
assert.equal(commit.data.createdCategories, 1);
const products = (await request(root + '/products', { token })).data;
assert.equal(products.length, 2);
assert.equal(products[0].shopId, shop.id);

const inUse = await request(root + '/media/' + media.data.filename, { method: 'DELETE', token });
assert.equal(inUse.response.status, 409);
assert.equal(inUse.data.error.code, 'MEDIA_IN_USE');
assert.equal(fs.existsSync(path.join(mediaDirectory, media.data.filename)), true);
for (const product of products) {
  await request(root + '/products/' + product.id, { method: 'PATCH', token, body: { images: [] } });
}
const deleted = await request(root + '/media/' + media.data.filename, { method: 'DELETE', token });
assert.equal(deleted.response.status, 200);
assert.equal(fs.existsSync(path.join(mediaDirectory, media.data.filename)), false);

await new Promise(resolve => server.close(resolve));
fs.rmSync(tmp, { recursive: true, force: true });
console.log('V6.2 import and media tests passed');
