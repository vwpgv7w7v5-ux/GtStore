#!/usr/bin/env node
/**
 * One-shot: download external product/vitrina images into local /api/v6/media/
 * and rewrite URLs in data/v6.json for a given shop slug.
 *
 * Usage (on VPS from /opt/gtstore):
 *   node scripts/localize-shop-images.mjs gstore
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaService } from '../apps/api-v6/src/media/service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const slug = String(process.argv[2] || 'gstore').trim();
const dataFile = process.env.GTSTORE_DATA || path.join(root, 'data/v6.json');
const mediaDir = process.env.GTSTORE_MEDIA || path.join(root, 'uploads/v6');

const isExternal = (u) => /^https?:\/\//i.test(String(u || '')) && !String(u).includes('/api/v6/media/');

async function main() {
  if (!fs.existsSync(dataFile)) {
    console.error('Data file not found:', dataFile);
    process.exit(1);
  }
  const bak = `${dataFile}.bak-localize-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  fs.copyFileSync(dataFile, bak);
  console.log('Backup:', bak);

  const db = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  const shop = (db.shops || []).find((s) => s.slug === slug);
  if (!shop) {
    console.error('Shop not found:', slug);
    process.exit(1);
  }

  const media = new MediaService({ directory: mediaDir, publicPrefix: '/api/v6/media/' });
  const cache = new Map();
  let ok = 0;
  let fail = 0;
  let skipped = 0;

  async function localize(url) {
    const raw = String(url || '').trim();
    if (!raw) return raw;
    if (!isExternal(raw)) {
      skipped += 1;
      return raw.startsWith('/api/v6/media/') ? raw : raw;
    }
    if (cache.has(raw)) return cache.get(raw);
    try {
      const local = await Promise.race([
        media.ingestUrl(raw),
        new Promise((_, rej) => setTimeout(() => rej(new Error('LOCALIZE_TIMEOUT')), 50000)),
      ]);
      cache.set(raw, local);
      ok += 1;
      console.log('OK', ok, raw.slice(0, 80), '->', local);
      return local;
    } catch (err) {
      fail += 1;
      console.warn('FAIL', fail, raw.slice(0, 100), err?.message || err);
      cache.set(raw, raw);
      return raw;
    }
  }

  const products = (db.products || []).filter((p) => p.shopId === shop.id);
  for (const p of products) {
    if (Array.isArray(p.images)) {
      for (const img of p.images) {
        if (typeof img === 'string') continue;
        if (img?.url) img.url = await localize(img.url);
      }
    }
    if (p.imageUrl) p.imageUrl = await localize(p.imageUrl);
    for (const v of p.variants || []) {
      if (v.imageUrl) v.imageUrl = await localize(v.imageUrl);
      if (Array.isArray(v.images)) {
        for (const img of v.images) {
          if (img?.url) img.url = await localize(img.url);
        }
      }
    }
  }

  const sf = (db.storefronts || []).find((x) => x.shopId === shop.id);
  if (sf) {
    for (const side of ['draft', 'published']) {
      const pack = sf[side];
      if (!pack) continue;
      for (const item of pack.vitrina || []) {
        if (item?.imageUrl) item.imageUrl = await localize(item.imageUrl);
      }
      for (const block of pack.blocks || []) {
        if (block?.settings?.imageUrl) {
          block.settings.imageUrl = await localize(block.settings.imageUrl);
        }
      }
    }
  }

  if (shop.logoUrl) shop.logoUrl = await localize(shop.logoUrl);
  if (shop.faviconUrl) shop.faviconUrl = await localize(shop.faviconUrl);

  const tmp = `${dataFile}.tmp-localize`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, dataFile);
  console.log(JSON.stringify({ slug, shopId: shop.id, ok, fail, skipped, cache: cache.size, dataFile }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
