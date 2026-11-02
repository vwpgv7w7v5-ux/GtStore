#!/usr/bin/env node
/**
 * Pre-generate WebP thumbnails for all media files so Mini App loads instantly.
 * Usage: node scripts/prewarm-media-thumbs.mjs [uploadsDir] [widths...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let sharp;
try {
  sharp = require('sharp');
} catch {
  console.error('Install sharp first: npm install sharp');
  process.exit(1);
}

const dir = path.resolve(process.argv[2] || 'uploads/v6');
const widths = (process.argv.slice(3).map(Number).filter(Boolean).length
  ? process.argv.slice(3).map(Number).filter(Boolean)
  : [360, 480, 720]);

const SRC_RE = /\.(jpe?g|png|webp|gif)$/i;
const DERIV_RE = /\.w\d+\.webp$/i;

const files = fs.readdirSync(dir).filter((name) => SRC_RE.test(name) && !DERIV_RE.test(name));
console.log(`Prewarming ${files.length} images in ${dir} → widths ${widths.join(',')}`);

let ok = 0;
let skip = 0;
let fail = 0;
const concurrency = 4;
let cursor = 0;

async function worker() {
  while (cursor < files.length) {
    const index = cursor++;
    const name = files[index];
    const src = path.join(dir, name);
    const stem = name.replace(/\.[^.]+$/, '');
    for (const width of widths) {
      const out = path.join(dir, `${stem}.w${width}.webp`);
      if (fs.existsSync(out)) {
        skip += 1;
        continue;
      }
      const tmp = `${out}.${process.pid}.tmp`;
      try {
        await sharp(src)
          .rotate()
          .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 72, effort: 4 })
          .toFile(tmp);
        await fs.promises.rename(tmp, out);
        ok += 1;
        if ((ok + skip) % 25 === 0) {
          console.log(`… ${ok} created, ${skip} existed, ${fail} failed`);
        }
      } catch (error) {
        fail += 1;
        try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
        console.warn(`fail ${name} w=${width}: ${error.message || error}`);
      }
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()));
console.log(`Done. created=${ok} existed=${skip} failed=${fail}`);
