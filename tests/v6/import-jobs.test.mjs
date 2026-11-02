import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import XLSX from 'xlsx';
import sharp from 'sharp';
import { createApp } from '../../apps/api-v6/src/app.js';

const png = await sharp({ create: { width: 32, height: 32, channels: 3, background: '#d48543' } }).png().toBuffer();
const bytesFor = source => Buffer.concat([png, crypto.createHash('sha256').update(String(source)).digest()]);
const image = source => Object.assign(Readable.from([bytesFor(source)]), { statusCode: 200, headers: { 'content-type': 'image/png' } });
const pack = rows => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(rows), 'Товары');
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([{ Категория: 'Каталог', Подкатегория: 'Бренд', Линейка: 'Серия' }]), 'Категории');
  return { filename: 'catalogue.xlsx', base64: XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' }) };
};
const rows = (count, images = 6) => Array.from({ length: count }, (_, i) => ({
  Название: `Товар ${i + 1}`, SKU: i + 1, Цена: 350, Остаток: 20,
  Категория: 'Каталог', Подкатегория: 'Бренд', Линейка: 'Серия', Вкус: `Вкус ${i + 1}`,
  Изображение: `https://images.example.com/photo-${i % images}.png`,
}));

async function start(directory, request) {
  const app = createApp({ databaseFile: path.join(directory, 'db.json'), mediaDirectory: path.join(directory, 'media'),
    mediaOptions: { remoteOptions: { proxy: null, lookup: async () => [{ address: '93.184.216.34', family: 4 }], request } } });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  return { ...app, base: `http://127.0.0.1:${app.server.address().port}/api/v6` };
}
const close = app => new Promise(resolve => app.server.close(resolve));
function client(app, token = '') {
  return async (route, method = 'GET', body, status = 200) => {
    const response = await fetch(app.base + route, { method, signal: AbortSignal.timeout(10000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const data = response.status === 204 ? null : await response.json();
    assert.equal(response.status, status, `${method} ${route}: ${JSON.stringify(data)}`);
    return data;
  };
}
async function owner(app) {
  const request = client(app);
  const boot = await request('/bootstrap', 'POST', { email: 'owner@jobs.test', password: 'ImportTest123!', name: 'Owner' }, 201);
  const login = await request('/auth/login', 'POST', { email: 'owner@jobs.test', password: 'ImportTest123!' });
  return { request: client(app, login.token), token: login.token, boot,
    root: `/workspaces/${boot.workspace.id}/shops/${boot.shop.id}` };
}
async function waitFor(request, root, id, predicate = job => !['queued', 'running'].includes(job.state)) {
  for (let tries = 0; tries < 1000; tries++) {
    const job = await request(root + '/import/jobs/' + id);
    if (predicate(job)) return job;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Import job did not reach the expected state');
}

async function testBackgroundProgress() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-import-jobs-'));
  let app, release;
  const gate = new Promise(resolve => { release = resolve; });
  let active = 0, maxActive = 0;
  const calls = new Map();
  try {
    app = await start(directory, async url => {
      const source = String(url);
      calls.set(source, (calls.get(source) || 0) + 1);
      active++; maxActive = Math.max(maxActive, active);
      if (!source.endsWith('photo-0.png')) await gate;
      active--;
      return image(source);
    });
    let { request, root, token, boot } = await owner(app);
    const payload = { ...pack(rows(70)), options: { onMissingSku: 'delete', onMissingCategory: 'delete' } };
    const queued = await request(root + '/import/jobs', 'POST', payload, 202);
    const progress = await waitFor(request, root, queued.id, job => job.media.prepared > 0);
    assert.equal(progress.processed, 0, 'HTTP returns status while photo downloads are still held open');
    assert.ok(progress.percent > 0 && progress.percent < 100, 'Progress must change before the first DB batch completes');
    assert.equal((await request('/health')).ok, true, 'The API stays responsive during image downloads');
    assert.equal((await request(root + '/import/jobs', 'POST', payload, 202)).id, queued.id, 'POST retry must reuse the same active job');
    await request(root + '/import/jobs', 'POST', pack(rows(71)), 409);
    await request(root + '/import/commit', 'POST', payload, 409);
    await client(app)(root + '/import/jobs/' + queued.id, 'GET', undefined, 401);
    const addedCategory = await request(root + '/categories', 'POST', { name: 'Added during import' }, 201);
    const addedProduct = await request(root + '/products', 'POST', { name: 'Added during import',
      sku: 'NEW-DURING-IMPORT', price: 10, stock: 1, categoryId: addedCategory.id }, 201);
    release();
    const completed = await waitFor(request, root, queued.id);
    assert.equal(completed.state, 'completed', JSON.stringify(completed));
    assert.equal(completed.processed, 70);
    assert.equal(completed.totals.imported, 70);
    assert.equal(completed.totals.failed, 0);
    assert.ok(maxActive > 1 && maxActive <= 4, 'Downloads must be parallel with a bounded concurrency');
    assert.equal(calls.size, 6);
    assert.ok([...calls.values()].every(count => count === 1), 'A shared source is downloaded only once');
    assert.ok((await request(root + '/products')).some(p => p.id === addedProduct.id), 'Cleanup must preserve products added while the import was running');
    assert.ok((await request(root + '/categories')).some(c => c.id === addedCategory.id));
    await request(root + '/products/' + addedProduct.id, 'DELETE');
    await request(root + '/categories/' + addedCategory.id, 'DELETE');
    const products = await request(root + '/products');
    const originalIds = new Map(products.map(p => [p.sku, { id: p.id, variantId: p.variants[0].id }]));
    const photo = products[0].images[0].url;
    const withCustomFlavorPhoto = { ...products[0].variants[0], imageUrl: photo, images: [{ url: photo }] };
    await request(root + '/products/' + products[0].id, 'PATCH', { variants: [withCustomFlavorPhoto] });
    const resized = await fetch(new URL(photo + '?w=240', app.base));
    assert.equal(resized.headers.get('content-type'), 'image/webp');
    assert.equal(Buffer.from(await resized.arrayBuffer()).toString('ascii', 8, 12), 'WEBP');
    const diskJob = JSON.parse(fs.readFileSync(path.join(directory, 'import-jobs', queued.id + '.json')));
    assert.equal(diskJob.state, 'completed');
    assert.equal('workbook' in diskJob, false, 'Status files must not contain the uploaded workbook');
    await close(app);
    app = await start(directory, async () => { throw new Error('External image host is offline'); });
    request = client(app, token);
    assert.equal((await request(root + '/import/jobs/' + queued.id)).state, 'completed');
    const second = await request(root + '/import/jobs', 'POST', payload, 202);
    const repeated = await waitFor(request, root, second.id);
    assert.equal(repeated.state, 'completed');
    assert.equal(repeated.totals.updated, 70);
    assert.equal(repeated.totals.imported, 0);
    for (const product of await request(root + '/products')) {
      assert.equal(product.id, originalIds.get(product.sku).id);
      assert.equal(product.variants[0].id, originalIds.get(product.sku).variantId);
      if (product.id === products[0].id) assert.equal(product.variants[0].imageUrl, photo,
        'A blank photo column in Excel must not erase a manually uploaded flavor photo');
    }
    const served = await fetch(new URL(photo, app.base));
    assert.equal(served.status, 200);
    await close(app);
    const interruptedId = crypto.randomUUID();
    fs.writeFileSync(path.join(directory, 'import-jobs', interruptedId + '.json'), JSON.stringify({
      id: interruptedId, actor: boot.user.id, workspaceId: boot.workspace.id, shopId: boot.shop.id,
      state: 'running', processed: 25, total: 70,
    }));
    app = await start(directory, async () => { throw new Error('Offline'); });
    request = client(app, token);
    const interrupted = await request(root + '/import/jobs/' + interruptedId);
    assert.equal(interrupted.state, 'interrupted');
    assert.equal(interrupted.error.code, 'IMPORT_INTERRUPTED');
    console.log('Background import: live photo progress, bounded downloads, duplicate POST, saved status, offline reimport and thumbnails passed.');
  } finally {
    release();
    if (app?.server.listening) await close(app);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testFailures() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-import-job-errors-'));
  let app, calls = 0;
  try {
    app = await start(directory, async () => { calls++; return Object.assign(Readable.from(['missing']), { statusCode: 404, headers: {} }); });
    const { request, root } = await owner(app);
    const keepCategory = await request(root + '/categories', 'POST', { name: 'Keep category' }, 201);
    const keepProduct = await request(root + '/products', 'POST', { name: 'Keep product', sku: 'KEEP', categoryId: keepCategory.id, price: 10, stock: 1 }, 201);
    const payload = pack(rows(60, 1));
    const before = (await request('/health')).revision;
    const strict = await request(root + '/import/jobs', 'POST', payload, 202);
    const failed = await waitFor(request, root, strict.id);
    assert.equal(failed.state, 'failed');
    assert.match(failed.error.message, /SKU/);
    assert.equal((await request('/health')).revision, before, 'Photo failure must occur before writing categories/products');
    const skipped = await request(root + '/import/jobs', 'POST', { ...payload, options: { skipInvalid: true,
      onMissingSku: 'delete', onMissingCategory: 'delete' } }, 202);
    const partial = await waitFor(request, root, skipped.id);
    assert.equal(partial.state, 'completed_with_errors');
    assert.equal(partial.totals.failed, 60);
    assert.equal(partial.cleanupSkipped, true);
    assert.equal(calls, 2, 'An unavailable shared source is tried once per import, not for every product/batch');
    assert.ok((await request(root + '/products')).some(p => p.id === keepProduct.id));
    assert.ok((await request(root + '/categories')).some(c => c.id === keepCategory.id));
    const invalidOffset = await request(root + '/import/commit', 'POST', { ...payload, options: {
      skipInvalid: true, batchOffset: 25, batchLimit: 25, onMissingSku: 'delete' } }, 409);
    assert.equal(invalidOffset.error.code, 'IMPORT_BATCH_ORDER');
    const invalidLimit = await request(root + '/import/commit', 'POST', { ...payload, options: { batchOffset: -1, batchLimit: -1 } }, 400);
    assert.equal(invalidLimit.error.code, 'IMPORT_BATCH_INVALID');
    await request(root + '/products/' + keepProduct.id, 'PATCH', { variants: [
      { name: 'Existing variant', sku: 'TAKEN', price: 10, stock: 1 } ] });
    const revisionBeforeConflict = (await request('/health')).revision;
    const collision = await request(root + '/import/commit', 'POST', pack([
      { Название: 'Do not partially save', SKU: 'NEW-BEFORE-CONFLICT', Цена: 10, Остаток: 1 },
      { Название: 'Conflicts with a variant', SKU: 'TAKEN', Цена: 10, Остаток: 1 },
    ]), 400);
    assert.equal(collision.error.code, 'SKU_EXISTS');
    assert.equal((await request('/health')).revision, revisionBeforeConflict);
    assert.equal((await request(root + '/products')).some(p => p.sku === 'NEW-BEFORE-CONFLICT'), false);
    console.log('Import failures: no silent success, shared failures deduplicated, cleanup blocked after skipped rows, offsets validated.');
  } finally {
    if (app?.server.listening) await close(app);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testUploadedFile(filename) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-uploaded-job-'));
  let app;
  const urls = new Set();
  try {
    app = await start(directory, async url => { urls.add(String(url)); return image(url); });
    const { request, root } = await owner(app);
    const job = await request(root + '/import/jobs', 'POST', {
      filename: path.basename(filename), base64: fs.readFileSync(filename).toString('base64'),
    }, 202);
    const result = await waitFor(request, root, job.id);
    assert.equal(result.state, 'completed', JSON.stringify(result));
    assert.equal(result.processed, 1219);
    assert.equal(result.totals.imported, 1219);
    assert.equal(result.totals.failed, 0);
    assert.equal(urls.size, 97);
    assert.equal((await request(root + '/products')).length, 1219);
    console.log(`${path.basename(filename)}: background import completed, 1219 products, 97 image sources.`);
  } finally {
    if (app?.server.listening) await close(app);
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

await testBackgroundProgress();
await testFailures();
for (const filename of process.argv.slice(2)) await testUploadedFile(filename);
console.log('V6 background import tests passed');
