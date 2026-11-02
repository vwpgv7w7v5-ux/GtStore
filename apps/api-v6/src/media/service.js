import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, assert } from '../core/errors.js';
import { downloadRemoteImage } from './remote-images.js';

const ALLOWED = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.png'],
  ['image/webp', '.webp'],
  ['image/gif', '.gif'],
]);

export class MediaService {
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

  async upload({ dataUrl, originalName = '', alt = '' }) {
    const { mime, buffer } = this.decodeDataUrl(dataUrl);
    const id = crypto.randomUUID();
    const extension = ALLOWED.get(mime);
    const filename = `${id}${extension}`;
    const destination = path.join(this.directory, filename);
    await fs.promises.writeFile(destination, buffer, { flag: 'wx' });
    return {
      id,
      filename,
      originalName: String(originalName || ''),
      mime,
      size: buffer.length,
      alt: String(alt || ''),
      url: `${this.publicPrefix}${filename}`,
      createdAt: new Date().toISOString(),
    };
  }

  async importRemote(source) {
    const key = crypto.createHash('sha256').update(String(source)).digest('hex');
    if (this.pendingImports.has(key)) return this.pendingImports.get(key);
    const pending = this.cacheRemote(String(source), key);
    this.pendingImports.set(key, pending);
    try { return await pending; }
    catch (error) {
      if (error instanceof AppError) {
        try {
          const address = new URL(source);
          const reference = `${address.origin}${address.pathname}`.slice(0, 200);
          error.message += ` (${reference})`;
        } catch {}
      }
      throw error;
    }
    finally { this.pendingImports.delete(key); }
  }

  async cacheRemote(source, key) {
    // Cache metadata lives below a subdirectory which the basename-only media
    // route cannot serve. Both bytes and mapping survive an application restart.
    const cacheDirectory = path.join(this.directory, '.import-cache');
    const cacheFile = path.join(cacheDirectory, `${key}.json`);
    try {
      const cached = JSON.parse(await fs.promises.readFile(cacheFile, 'utf8'));
      if (cached.filename === path.basename(cached.filename) && ALLOWED.has(cached.mime)) {
        const file = await fs.promises.lstat(path.join(this.directory, cached.filename));
        if (file.isFile() && file.size === cached.size && file.size <= this.maxBytes) {
          const bytes = await fs.promises.readFile(path.join(this.directory, cached.filename));
          if (crypto.createHash('sha256').update(bytes).digest('hex') === cached.id) return { ...cached, url: `${this.publicPrefix}${cached.filename}` };
        }
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code) && !(error instanceof SyntaxError) && !(error instanceof TypeError)) throw error;
    }
    const { buffer, mime } = await downloadRemoteImage(source, { ...this.remoteOptions, maxBytes: this.maxBytes });
    const digest = crypto.createHash('sha256').update(buffer).digest('hex');
    const filename = `import-${digest}${ALLOWED.get(mime)}`;
    const mediaTemporary = path.join(this.directory, `.import-${digest}.${crypto.randomUUID()}.tmp`);
    try {
      await fs.promises.writeFile(mediaTemporary, buffer, { flag: 'wx' });
      await fs.promises.rename(mediaTemporary, path.join(this.directory, filename));
    } finally { await fs.promises.rm(mediaTemporary, { force: true }); }
    const metadata = {
      id: digest, filename, originalName: filename, mime, size: buffer.length,
      alt: '', url: `${this.publicPrefix}${filename}`, createdAt: new Date().toISOString(),
    };
    await fs.promises.mkdir(cacheDirectory, { recursive: true });
    const temporary = `${cacheFile}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, JSON.stringify(metadata), { flag: 'wx' });
      await fs.promises.rename(temporary, cacheFile);
    } finally { await fs.promises.rm(temporary, { force: true }); }
    return metadata;
  }

  resolve(filename) {
    const safe = path.basename(String(filename || ''));
    assert(safe === filename && /^[a-z0-9][a-z0-9_.-]*\.(?:jpe?g|png|webp|gif)$/i.test(safe), 'MEDIA_PATH_INVALID', 'Некорректный путь к файлу', 400);
    const file = path.join(this.directory, safe);
    let stat;
    try { stat = fs.lstatSync(file); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    assert(stat?.isFile(), 'MEDIA_NOT_FOUND', 'Файл не найден', 404);
    return file;
  }

  async remove(filename) {
    const file = this.resolve(filename);
    await fs.promises.unlink(file);
    return { removed: true, filename };
  }
}
