import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import XLSX from 'xlsx';
import { createApp } from '../../apps/api-v6/src/app.js';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
const imageFor = source => Buffer.concat([pixel, crypto.createHash('sha256').update(source).digest()]);
const imageResponse = source => Object.assign(Readable.from([imageFor(source)]), {
  statusCode: 200, headers: { 'content-type': 'image/png' },
});

function workbookPayload(rows, categories = [{ Категория: 'Основная', Подкатегория: 'Линейка' }]) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Товары');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(categories), 'Категории');
  return { filename: 'catalogue.xlsx', base64: XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) };
}

async function start(databaseFile, mediaDirectory, transport) {
  const app = createApp({ databaseFile, mediaDirectory, mediaOptions: { remoteOptions: {
    proxy: null,
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    request: transport,
  } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}/api/v6` };
}

const close = app => new Promise(resolve => app.server.close(resolve));
function client(app, token = '') {
  return async (route, { method = 'GET', body, status = 200 } = {}) => {
    const response = await fetch(app.base + route, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
}

async function initialize(app) {
  const request = client(app);
  const owner = await request('/bootstrap', { method: 'POST', status: 201,
    body: { email: 'owner@import.test', password: 'ImportTest123!', name: 'Owner' } });
  const login = await request('/auth/login', { method: 'POST', body: { email: 'owner@import.test', password: 'ImportTest123!' } });
  return { request: client(app, login.token), token: login.token,
    root: `/workspaces/${owner.workspace.id}/shops/${owner.shop.id}`, shop: owner.shop };
}

async function assertMediaAvailable(app, products) {
  const urls = new Set(products.map(product => product.images[0]?.url));
  assert.equal(urls.size, 97);
  for (const url of urls) {
    assert.match(url, /^\/api\/v6\/media\/import-[a-f0-9]{64}\.png$/);
    const response = await fetch(new URL(url, app.base));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.ok(bytes.subarray(0, pixel.length).equals(pixel));
    assert.equal(bytes.length, pixel.length + 32);
  }
}

async function testLargeWorkbook(payload, label, { synthetic = false } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-import-persistence-'));
  const databaseFile = path.join(temp, 'db.json'), mediaDirectory = path.join(temp, 'media');
  const calls = new Map();
  let app;
  try {
    app = await start(databaseFile, mediaDirectory, async source => {
      const key = String(source);
      calls.set(key, (calls.get(key) || 0) + 1);
      return imageResponse(key);
    });
    let { request, root, token, shop } = await initialize(app);
    const preview = await request(root + '/import/file', { method: 'POST', body: payload });
    assert.equal(preview.valid, true);
    assert.equal(preview.total, 1219);
    assert.equal(preview.created, 1219);
    assert.equal(preview.updated, 0);
    assert.equal(preview.uniqueImages, 97);
    assert.equal(calls.size, 0, 'Preview must not download or persist images');
    const before = await request('/health');
    const began = performance.now();
    const first = await request(root + '/import/commit', { method: 'POST', status: 201, body: payload });
    const elapsed = performance.now() - began;
    assert.equal(first.imported, 1219);
    assert.equal(first.created, 1219);
    assert.equal(first.updated, 0);
    assert.equal(first.failed, 0);
    assert.equal((await request('/health')).revision, before.revision + 1, 'Catalogue import must use one durable transaction');
    assert.equal(calls.size, 97);
    assert.ok([...calls.values()].every(count => count === 1), 'Shared image URLs must only be downloaded once');
    const sourceWorkbook = XLSX.read(payload.base64, { type: 'base64' });
    const sourceRows = XLSX.utils.sheet_to_json(sourceWorkbook.Sheets['Товары'], { defval: '' });
    const sourcesBySku = new Map(sourceRows.map(row => {
      const columns = Object.fromEntries(Object.entries(row).map(([name, value]) => [name.trim().toLowerCase(), value]));
      return [String(columns.sku), String(columns['изображение'])];
    }));
    for (const product of first.products) {
      const expectedDigest = crypto.createHash('sha256').update(imageFor(sourcesBySku.get(product.sku))).digest('hex');
      assert.equal(product.images[0].url, `/api/v6/media/import-${expectedDigest}.png`, `Wrong image assigned to SKU ${product.sku}`);
    }
    const ids = new Map(first.products.map(product => [product.sku, product.id]));
    if (synthetic) {
      const firstProduct = first.products.find(product => product.sku === '1');
      assert.equal(firstProduct.name, 'Товар 1');
      assert.equal(firstProduct.price, 1234.5);
      assert.equal(firstProduct.stock, 20);
      assert.equal(firstProduct.variants.length, 1);
      assert.equal(firstProduct.variants[0].name, 'Вкус 1');
      const categories = await request(root + '/categories');
      const parent = categories.find(category => category.name === 'Основная');
      const child = categories.find(category => category.name === 'Линейка');
      assert.equal(child.parentId, parent.id);
      assert.equal(firstProduct.categoryId, child.id);
    }
    await assertMediaAvailable(app, first.products);
    const photoCounts = new Map();
    for (const product of first.products) photoCounts.set(product.images[0].url, (photoCounts.get(product.images[0].url) || 0) + 1);
    const sharedPhoto = [...photoCounts].find(([, count]) => count > 1)?.[0];
    assert.ok(first.products.filter(product => product.images[0].url === sharedPhoto).length > 1);
    const deletion = await request(root + '/media/' + path.basename(sharedPhoto), { method: 'DELETE', status: 409 });
    assert.equal(deletion.error.code, 'MEDIA_IN_USE');
    const retainedPhoto = await fetch(new URL(sharedPhoto, app.base));
    assert.equal(retainedPhoto.status, 200, 'A shared catalogue photo must survive a rejected deletion');
    assert.ok(Buffer.from(await retainedPhoto.arrayBuffer()).subarray(0, pixel.length).equals(pixel));
    const secondPreview = await request(root + '/import/file', { method: 'POST', body: payload });
    assert.equal(secondPreview.created, 0);
    assert.equal(secondPreview.updated, 1219);
    const second = await request(root + '/import/commit', { method: 'POST', status: 201, body: payload });
    assert.equal(second.imported, 1219);
    assert.equal(second.created, 0);
    assert.equal(second.updated, 1219);
    assert.equal(second.failed, 0);
    assert.equal(second.createdCategories, 0);
    for (const product of second.products) assert.equal(product.id, ids.get(product.sku));
    assert.equal((await request(root + '/products')).length, 1219);
    assert.equal([...calls.values()].reduce((sum, count) => sum + count, 0), 97, 'Repeat import must use the durable image cache');
    const original = second.products[0];
    const withoutPhotos = workbookPayload([{ Название: original.name, SKU: original.sku,
      Цена: original.price, Остаток: original.stock }], []);
    const galleryPreserved = await request(root + '/import/commit', { method: 'POST', status: 201, body: withoutPhotos });
    assert.deepEqual(galleryPreserved.products[0].images, original.images,
      'Updating a SKU without an image source must preserve its saved gallery');
    await request(root + '/storefront/publish', { method: 'POST', status: 201 });
    const publicStore = await request(`/public/storefronts/${shop.slug}`);
    assert.equal(publicStore.products.length, 1219);
    await close(app);
    app = await start(databaseFile, mediaDirectory, async () => { throw new Error('Image host is offline after restart'); });
    request = client(app, token);
    const restored = await request(root + '/products');
    assert.equal(restored.length, 1219);
    await assertMediaAvailable(app, restored);
    const offlineImport = await request(root + '/import/commit', { method: 'POST', status: 201, body: payload });
    assert.equal(offlineImport.updated, 1219, 'Reimport must work from disk even if the image host is unavailable');
    assert.equal(offlineImport.failed, 0);
    console.log(`${label}: 1219 products, 97 saved photos, repeat import and offline restart passed (${Math.round(elapsed)} ms initial import).`);
  } finally {
    if (app?.server.listening) await close(app);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

async function testFailures() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-import-failures-'));
  let app;
  try {
    app = await start(path.join(temp, 'db.json'), path.join(temp, 'media'), async () =>
      Object.assign(Readable.from(['not found']), { statusCode: 404, headers: { 'content-type': 'text/plain' } }));
    const { request, root } = await initialize(app);
    const failedPayload = workbookPayload([{ Название: 'Не импортировать', SKU: 'FAIL-1', Цена: 10, Остаток: 1,
      Категория: 'Не создавать', Изображение: 'https://images.example.com/missing.png?token=do-not-echo#fragment' }]);
    const before = await request('/health');
    const failed = await request(root + '/import/commit', { method: 'POST', status: 502, body: failedPayload });
    assert.equal(failed.error.code, 'MEDIA_DOWNLOAD_FAILED');
    assert.match(failed.error.message, /FAIL-1/);
    assert.equal(failed.error.details[0].sku, 'FAIL-1');
    assert.equal(failed.error.details[0].message, 'https://images.example.com/missing.png');
    assert.ok(!JSON.stringify(failed).includes('do-not-echo'), 'Failure details must remove URL query secrets');
    assert.equal((await request('/health')).revision, before.revision);
    assert.equal((await request(root + '/products')).length, 0);
    assert.equal((await request(root + '/categories')).length, 0, 'Failed media must not create categories');
    const badNumbers = workbookPayload([
      { Название: 'Верная строка', SKU: 'OK-1', Цена: '1 234,50', Остаток: 2 },
      { Название: 'Неверная цена', SKU: 'BAD-PRICE', Цена: 'не число', Остаток: 2 },
      { Название: 'Неверный остаток', SKU: 'BAD-STOCK', Цена: 10, Остаток: -1 },
    ], []);
    const preview = await request(root + '/import/file', { method: 'POST', body: badNumbers });
    assert.equal(preview.valid, false);
    assert.equal(preview.errors.length, 2);
    const rejected = await request(root + '/import/commit', { method: 'POST', status: 422, body: badNumbers });
    assert.equal(rejected.error.code, 'IMPORT_VALIDATION_FAILED');
    assert.equal((await request('/health')).revision, before.revision);
    const skipped = await request(root + '/import/commit', { method: 'POST', status: 201,
      body: { ...badNumbers, options: { skipInvalid: true } } });
    assert.equal(skipped.imported, 1);
    assert.equal(skipped.failed, 2);
    assert.deepEqual(skipped.errors.map(error => error.line), [3, 4]);
    assert.equal(skipped.products[0].price, 1234.5);
    assert.equal((await request(root + '/products')).length, 1);
    console.log('Import media failures preserve catalogue state; invalid numeric rows are reported and skipped explicitly.');
  } finally {
    if (app?.server.listening) await close(app);
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

const synthetic = workbookPayload(Array.from({ length: 1219 }, (_, index) => ({
  ' Название ': ` Товар ${index + 1} `, ' SKU ': index + 1, Цена: index === 0 ? '1 234,50' : 350,
  Остаток: 20, Категория: ' Основная ', Подкатегория: ' Линейка ', Бренд: 'GT',
  Изображение: `https://images.example.com/photo-${index % 97}.png`, ' Вкус ': `Вкус ${index + 1}`,
})));
await testLargeWorkbook(synthetic, 'Synthetic XLSX', { synthetic: true });
await testFailures();
// Optional real-file validation without committing customer uploads as test fixtures.
for (const filename of process.argv.slice(2)) {
  await testLargeWorkbook({ filename: path.basename(filename), base64: fs.readFileSync(filename).toString('base64') }, path.basename(filename));
}
console.log('V6 import persistence tests passed');
