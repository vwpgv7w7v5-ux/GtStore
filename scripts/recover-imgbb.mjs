#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const DB = '/opt/gtstore/data/v6.json';
const BAK = '/opt/gtstore/data/backups/v6.json.2026-08-15T16-40-20-018Z';
const UPLOADS = '/opt/gtstore/uploads/v6';
const PREFIX = '/api/v6/media/';

const db = JSON.parse(fs.readFileSync(DB, 'utf8'));
const bak = JSON.parse(fs.readFileSync(BAK, 'utf8'));
const shop = db.shops.find((s) => s.slug === 'gstore');
const bakById = new Map(
  (bak.products || []).filter((p) => p.shopId === shop.id).map((p) => [p.id, p]),
);
const isRemote = (url) =>
  /^https?:\/\//i.test(String(url || '')) && !String(url).includes('/api/v6/media/');
const cache = new Map();

async function localize(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  if (cache.has(raw)) return cache.get(raw);
  const pending = (async () => {
    try {
      const res = await fetch(raw, {
        headers: { Accept: 'image/*,*/*', 'User-Agent': 'GtStoreMediaIngest/1.0' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return '';
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 2500) return '';
      const mime = String(res.headers.get('content-type') || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
      let ext = '.jpg';
      if (mime.includes('png') || raw.toLowerCase().endsWith('.png')) ext = '.png';
      else if (mime.includes('webp')) ext = '.webp';
      const filename = `${crypto.randomUUID()}${ext}`;
      fs.writeFileSync(path.join(UPLOADS, filename), buf);
      return `${PREFIX}${filename}`;
    } catch {
      return '';
    }
  })();
  cache.set(raw, pending);
  const out = await pending;
  cache.set(raw, out);
  return out;
}

async function mapPool(items, limit, fn) {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
      while (i < items.length) {
        const idx = i++;
        await fn(items[idx], idx);
      }
    }),
  );
}

const targets = [];
for (const p of db.products || []) {
  if (p.shopId !== shop.id) continue;
  const cur = p.images?.[0]?.url || '';
  if (cur && String(cur).includes('/api/v6/media/')) continue;
  const oldUrl = bakById.get(p.id)?.images?.[0]?.url || '';
  if (!isRemote(oldUrl)) continue;
  targets.push({ p, oldUrl });
}

console.log('targets', targets.length);
let recovered = 0;
let still404 = 0;
await mapPool(targets, 10, async ({ p, oldUrl }) => {
  const local = await localize(oldUrl);
  if (local) {
    p.images = [{ url: local, primary: true, alt: p.name || '' }];
    p.updatedAt = new Date().toISOString();
    recovered += 1;
  } else {
    p.images = [];
    still404 += 1;
  }
});

db.revision = (db.revision || 0) + 1;
fs.writeFileSync(DB, JSON.stringify(db, null, 2));

let local = 0;
let remote = 0;
let none = 0;
for (const p of db.products || []) {
  if (p.shopId !== shop.id) continue;
  const u = p.images?.[0]?.url || '';
  if (!u) none += 1;
  else if (String(u).includes('/api/v6/media/')) local += 1;
  else if (/^https?:/i.test(u)) remote += 1;
  else none += 1;
}
console.log(JSON.stringify({ recovered, still404, local, remote, none }, null, 2));
