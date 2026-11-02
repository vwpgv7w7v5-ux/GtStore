#!/usr/bin/env node
/**
 * Localize remote product images (imgbb etc.) onto this server.
 * Broken / 404 links are cleared so admin no longer shows "image not found".
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB = process.env.V6_DATABASE_FILE || '/opt/gtstore/data/v6.json';
const UPLOADS = process.env.V6_UPLOADS_DIR || '/opt/gtstore/uploads/v6';
const PREFIX = '/api/v6/media/';
const SHOP_SLUG = process.env.SHOP_SLUG || 'gstore';
const CONCURRENCY = Number(process.env.CONCURRENCY || 12);

fs.mkdirSync(UPLOADS, { recursive: true });

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const shop = db.shops.find((s) => s.slug === SHOP_SLUG);
if (!shop) {
  console.error('SHOP_NOT_FOUND', SHOP_SLUG);
  process.exit(1);
}
const products = (db.products || []).filter((p) => p.shopId === shop.id);

const isRemote = (url) =>
  /^https?:\/\//i.test(String(url || '')) && !String(url).includes('/api/v6/media/');
const cache = new Map();

async function localize(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (!isRemote(raw)) return raw;
  if (cache.has(raw)) return cache.get(raw);
  const pending = (async () => {
    try {
      const res = await fetch(raw, {
        headers: { Accept: 'image/*,*/*', 'User-Agent': 'GtStoreMediaIngest/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return '';
      const buf = Buffer.from(await res.arrayBuffer());
      // imgbb "not found" placeholder is a tiny PNG
      if (buf.length < 2500) return '';
      const mime = String(res.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      let ext = '.jpg';
      if (mime.includes('png') || raw.toLowerCase().endsWith('.png')) ext = '.png';
      else if (mime.includes('webp')) ext = '.webp';
      else if (mime.includes('gif')) ext = '.gif';
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS, filename), buf);
      return `${PREFIX}${filename}`;
    } catch {
      return '';
    }
  })();
  cache.set(raw, pending);
  const result = await pending;
  cache.set(raw, result);
  return result;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      await fn(items[idx], idx);
      if (idx && idx % 20 === 0) process.stdout.write(`…${idx}/${items.length}\n`);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
}

const jobs = [];
for (const p of products) {
  if (Array.isArray(p.images)) {
    for (const img of p.images) {
      const url = img?.url || (typeof img === 'string' ? img : '');
      if (isRemote(url)) jobs.push({ type: 'img', img, url });
    }
  }
  for (const v of p.variants || []) {
    if (isRemote(v.imageUrl)) jobs.push({ type: 'vurl', v, url: v.imageUrl });
    for (const img of v.images || []) {
      if (isRemote(img?.url)) jobs.push({ type: 'vimg', img, url: img.url });
    }
  }
}

console.log('jobs', jobs.length);
let localized = 0;
let cleared = 0;
await mapPool(jobs, CONCURRENCY, async (job) => {
  const local = await localize(job.url);
  if (job.type === 'img') {
    if (local) {
      job.img.url = local;
      localized += 1;
    } else {
      job.img.url = '';
      cleared += 1;
    }
  } else if (job.type === 'vurl') {
    job.v.imageUrl = local || '';
    if (local) localized += 1;
    else cleared += 1;
  } else if (job.type === 'vimg') {
    if (local) {
      job.img.url = local;
      localized += 1;
    } else {
      job.img.url = '';
      cleared += 1;
    }
  }
});

for (const p of products) {
  if (Array.isArray(p.images)) {
    p.images = p.images.filter((img) => img?.url);
    p.images.forEach((img, i) => {
      img.primary = i === 0;
    });
  }
  for (const v of p.variants || []) {
    if (Array.isArray(v.images)) v.images = v.images.filter((img) => img?.url);
  }
  p.updatedAt = new Date().toISOString();
}

db.revision = (db.revision || 0) + 1;
fs.writeFileSync(DB, JSON.stringify(db, null, 2));
console.log(JSON.stringify({ jobs: jobs.length, localized, cleared, unique: cache.size }, null, 2));
