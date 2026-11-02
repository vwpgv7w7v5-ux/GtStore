import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, assert } from '../core/errors.js';
import { downloadRemoteImage, imageMime } from './remote-images.js';

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/jpg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

const EXT_MIME = new Map([
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'],
  ['.webp', 'image/webp'],
  ['.gif', 'image/gif'],
]);

const THUMB_WIDTHS = new Set([240, 360, 480, 720, 960, 1280]);
const DEFAULT_THUMB_WIDTH = 480;

let sharpLoader = null;
async function loadSharp() {
  if (sharpLoader) return sharpLoader;
  sharpLoader = import('sharp')
    .then((mod) => mod.default || mod)
    .catch(() => null);
  return sharpLoader;
}

export class MediaService {
  #thumbJobs = new Map();

  constructor(options = {}) {
    this.directory = path.resolve(options.directory || 'uploads/v6');
    this.publicPrefix = options.publicPrefix || '/api/v6/media/';
    this.maxBytes = options.maxBytes || 8 * 1024 * 1024;
    this.remoteOptions = options.remoteOptions || {};
    this.pendingImports = new Map();
    fs.mkdirSync(this.directory, { recursive: true });
  }

  decodeDataUrl(value) {
    const match = /^data:([^;]+);base64,(.+)$/s.exec(String(value || ''));
    assert(match, 'MEDIA_DATA_INVALID', 'Ожидалось изображение в формате data URL');
    const mime = match[1].toLowerCase();
    assert(ALLOWED.has(mime), 'MEDIA_TYPE_NOT_ALLOWED', 'Поддерживаются JPEG, PNG, WebP и GIF', 415);
    const buffer = Buffer.from(match[2], 'base64');
    assert(buffer.length > 0, 'MEDIA_EMPTY', 'Файл изображения пуст');
    assert(buffer.length <= this.maxBytes, 'MEDIA_TOO_LARGE', `Максимальный размер файла — ${Math.round(this.maxBytes / 1024 / 1024)} МБ`, 413);
    return { mime, buffer };
  }

  sniffMime(buffer, hint = '') {
    return imageMime(buffer) || '';
  }

  isLocalUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return false;
    try {
      const url = new URL(raw, 'http://local.invalid');
      return [this.publicPrefix, '/api/v6/media/', '/v6/media/'].some(prefix => url.pathname.startsWith(prefix));
    } catch {
      return false;
    }
  }

  normalizeLocalUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let filename;
    try {
      const url = new URL(raw, 'http://local.invalid');
      const prefix = [this.publicPrefix, '/api/v6/media/', '/v6/media/'].find(value => url.pathname.startsWith(value));
      assert(prefix, 'MEDIA_PATH_INVALID', 'Некорректный путь к фотографии');
      filename = decodeURIComponent(url.pathname.slice(prefix.length));
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw new AppError('MEDIA_PATH_INVALID', 'Некорректный путь к фотографии');
    }
    this.resolve(filename);
    return `${this.publicPrefix}${filename}`;
  }

  async writeBuffer(buffer, { mime = '', originalName = '', alt = '' } = {}) {
    const detected = this.sniffMime(buffer);
    assert(ALLOWED.has(detected), 'MEDIA_TYPE_NOT_ALLOWED', 'Поддерживаются JPEG, PNG, WebP и GIF', 415);
    const declared = String(mime || '').split(';')[0].trim().toLowerCase().replace('image/jpg', 'image/jpeg');
    assert(!declared || declared === detected, 'MEDIA_CONTENT_INVALID', 'Содержимое фотографии не соответствует формату изображения', 415);
    assert(buffer.length > 0, 'MEDIA_EMPTY', 'Файл изображения пуст');
    assert(buffer.length <= this.maxBytes, 'MEDIA_TOO_LARGE', `Максимальный размер файла — ${Math.round(this.maxBytes / 1024 / 1024)} МБ`, 413);
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const extension = ALLOWED.get(detected);
    const filename = `import-${digest}${extension}`;
    const destination = path.join(this.directory, filename);
    const temporary = path.join(this.directory, `.import-${digest}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(temporary, buffer, { flag: 'wx' });
      await fs.promises.rename(temporary, destination);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    return {
      id: digest,
      filename,
      originalName: String(originalName || ''),
      mime: detected,
      size: buffer.length,
      alt: String(alt || ''),
      url: `${this.publicPrefix}${filename}`,
      createdAt: new Date().toISOString(),
    };
  }

  async upload({ dataUrl, originalName = '', alt = '' }) {
    const { mime, buffer } = this.decodeDataUrl(dataUrl);
    return this.writeBuffer(buffer, { mime, originalName, alt });
  }

  /**
   * Ensure any image reference is stored on this server.
   * Accepts verified local media paths, data URLs, and public HTTPS URLs.
   */
  async ingestUrl(value, { originalName = '', alt = '', cache } = {}) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    if (cache) {
      if (!cache.has(raw)) cache.set(raw, this.ingestUrl(raw, { originalName, alt }));
      return cache.get(raw);
    }
    if (this.isLocalUrl(raw)) return this.normalizeLocalUrl(raw);
    if (raw.startsWith('data:image/')) {
      const uploaded = await this.upload({ dataUrl: raw, originalName, alt });
      return uploaded.url;
    }
    const uploaded = await this.importRemote(raw);
    return uploaded.url;
  }

  async importRemote(source) {
    const raw = String(source || '').trim();
    const key = crypto.createHash('sha256').update(raw).digest('hex');
    if (this.pendingImports.has(key)) return this.pendingImports.get(key);
    const pending = this.cacheRemote(raw, key);
    this.pendingImports.set(key, pending);
    try { return await pending; }
    catch (error) {
      if (error instanceof AppError) {
        try {
          const address = new URL(raw);
          error.message += ` (${`${address.origin}${address.pathname}`.slice(0, 200)})`;
        } catch { /* Never echo credentials or query strings. */ }
      }
      throw error;
    } finally { this.pendingImports.delete(key); }
  }

  async cacheRemote(source, key) {
    const cacheDirectory = path.join(this.directory, '.import-cache');
    const cacheFile = path.join(cacheDirectory, `${key}.json`);
    try {
      const cached = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
      if (/^[a-f0-9]{64}$/.test(cached.id) && cached.filename === `import-${cached.id}${ALLOWED.get(cached.mime)}`) {
        const file = this.resolve(cached.filename);
        const metadata = await fs.promises.stat(file);
        if (metadata.size === cached.size && metadata.size > 0 && metadata.size <= this.maxBytes) {
          const bytes = await fs.promises.readFile(file);
          if (crypto.createHash('sha256').update(bytes).digest('hex') === cached.id) {
            return { ...cached, url: `${this.publicPrefix}${cached.filename}` };
          }
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR', 'MEDIA_NOT_FOUND', 'MEDIA_PATH_INVALID'].includes(error.code) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    }
    const { buffer, mime } = await downloadRemoteImage(source, { ...this.remoteOptions, maxBytes: this.maxBytes });
    const metadata = await this.writeBuffer(buffer, { mime });
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const temporary = `${cacheFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(metadata), { flag: 'wx' });
      await fs.promises.rename(temporary, cacheFile);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    return metadata;
  }

  async ingestImages(images = [], options = {}) {
    const list = Array.isArray(images) ? images : [];
    const out = [];
    for (const [index, image] of list.entries()) {
      if (image == null) continue;
      if (typeof image === 'string') {
        const url = await this.ingestUrl(image, options);
        if (url) out.push({ id: crypto.randomUUID(), url, alt: '', position: index, primary: index === 0 });
        continue;
      }
      const url = await this.ingestUrl(image.url || '', { ...options, alt: image.alt || '', originalName: image.originalName || '' });
      if (!url) continue;
      out.push({
        id: image.id || crypto.randomUUID(),
        url,
        alt: String(image.alt || ''),
        position: Number.isFinite(image.position) ? image.position : index,
        primary: image.primary === true || index === 0,
      });
    }
    return out;
  }

  async localizeProductInput(input = {}, options = {}) {
    const next = { ...input };
    if (next.imageUrl !== undefined) next.imageUrl = await this.ingestUrl(next.imageUrl, options);
    if (next.images !== undefined) next.images = await this.ingestImages(next.images, options);
    if (!next.imageUrl && next.images?.[0]?.url) next.imageUrl = next.images[0].url;
    if (Array.isArray(next.variants)) {
      next.variants = await Promise.all(
        next.variants.map(async (variant) => {
          const item = { ...variant };
          if (item.imageUrl !== undefined) item.imageUrl = await this.ingestUrl(item.imageUrl, options);
          if (item.images !== undefined) item.images = await this.ingestImages(item.images, options);
          if (!item.imageUrl && item.images?.[0]?.url) item.imageUrl = item.images[0].url;
          return item;
        }),
      );
    }
    return next;
  }

  resolve(filename) {
    const safe = path.basename(String(filename || ''));
    assert(safe === filename && /^[a-z0-9][a-z0-9_.-]*\.(?:jpe?g|png|webp|gif)$/i.test(safe), 'MEDIA_PATH_INVALID', 'Некорректный путь к файлу', 400);
    const file = path.join(this.directory, safe);
    let metadata;
    try { metadata = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(metadata?.isFile(), 'MEDIA_NOT_FOUND', 'Файл не найден', 404);
    return file;
  }

  normalizeWidth(raw) {
    const width = Number.parseInt(String(raw || ''), 10);
    if (!Number.isFinite(width) || width <= 0) return 0;
    if (THUMB_WIDTHS.has(width)) return width;
    // Snap to nearest allowed width so clients can pass approximate sizes.
    let best = DEFAULT_THUMB_WIDTH;
    let bestDiff = Math.abs(best - width);
    for (const candidate of THUMB_WIDTHS) {
      const diff = Math.abs(candidate - width);
      if (diff < bestDiff) {
        best = candidate;
        bestDiff = diff;
      }
    }
    return best;
  }

  derivativeName(filename, width) {
    const base = path.basename(String(filename || ''));
    const stem = base.replace(/\.[^.]+$/, '');
    return `${stem}.w${width}.webp`;
  }

  /**
   * Serve a resized WebP derivative (cached next to the original).
   * Falls back to the original file when sharp is unavailable.
   */
  async resolveForServe(filename, widthRaw = 0) {
    const file = this.resolve(filename);
    const baseMime = EXT_MIME.get(path.extname(file).toLowerCase()) || 'application/octet-stream';
    const width = this.normalizeWidth(widthRaw);
    // Already a cached derivative or no resize requested.
    if (!width || /\.w\d+\.webp$/i.test(String(filename || ''))) {
      return { file, mime: baseMime };
    }

    const sharp = await loadSharp();
    if (!sharp) return { file, mime: baseMime };

    const outName = this.derivativeName(filename, width);
    const outPath = path.join(this.directory, outName);
    if (fs.existsSync(outPath)) {
      return { file: outPath, mime: 'image/webp' };
    }

    const jobKey = `${path.basename(filename)}:${width}`;
    let job = this.#thumbJobs.get(jobKey);
    if (!job) {
      job = (async () => {
        const tmp = `${outPath}.${process.pid}.${Date.now()}.tmp`;
        try {
          await sharp(file)
            .rotate()
            .resize({ width, height: width, fit: 'inside', withoutEnlargement: true })
            .webp({ quality: 72, effort: 4 })
            .toFile(tmp);
          await fs.promises.rename(tmp, outPath);
        } catch (error) {
          try { await fs.promises.unlink(tmp); } catch { /* ignore */ }
          throw error;
        } finally {
          this.#thumbJobs.delete(jobKey);
        }
      })();
      this.#thumbJobs.set(jobKey, job);
    }

    try {
      await job;
      return { file: outPath, mime: 'image/webp' };
    } catch {
      return { file, mime: baseMime };
    }
  }

  async remove(filename) {
    const file = this.resolve(filename);
    await fs.promises.unlink(file);
    const stem = path.basename(filename).replace(/\.[^.]+$/, '');
    for (const name of fs.readdirSync(this.directory)) {
      if (name.startsWith(`${stem}.w`) && name.endsWith('.webp')) {
        try { await fs.promises.unlink(path.join(this.directory, name)); } catch { /* ignore */ }
      }
    }
    return { removed: true, filename };
  }
}
