import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { assert } from '../core/errors.js';

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

  resolve(filename) {
    const safe = path.basename(String(filename || ''));
    assert(safe === filename && safe, 'MEDIA_PATH_INVALID', 'Некорректный путь к файлу', 400);
    const file = path.join(this.directory, safe);
    assert(fs.existsSync(file), 'MEDIA_NOT_FOUND', 'Файл не найден', 404);
    return file;
  }

  async remove(filename) {
    const file = this.resolve(filename);
    await fs.promises.unlink(file);
    return { removed: true, filename };
  }
}
