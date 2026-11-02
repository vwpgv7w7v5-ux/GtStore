import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AppError, assert } from '../core/errors.js';

const terminal = new Set(['completed', 'completed_with_errors', 'failed', 'interrupted']);
const countFields = ['imported', 'updated', 'failed', 'createdCategories', 'missingHidden', 'missingDeleted', 'categoriesHidden', 'categoriesDeleted'];

// Requests only enqueue or read progress. Slow image hosts never hold an HTTP
// import request open. Status is durable, but interrupted work is not silently
// resumed: the user can reimport safely using the persistent image cache.
export class ImportJobs {
  constructor(imports, { directory }) {
    this.imports = imports;
    this.directory = directory;
    this.jobs = new Map();
    this.active = new Map();
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    for (const name of fs.readdirSync(directory)) {
      if (!/^[a-f0-9-]{36}\.json$/.test(name)) continue;
      try {
        const job = JSON.parse(fs.readFileSync(path.join(directory, name), 'utf8'));
        if (job.id + '.json' !== name) continue;
        this.jobs.set(job.id, job);
        if (!terminal.has(job.state)) {
          job.state = 'interrupted';
          job.error = { code: 'IMPORT_INTERRUPTED', message: 'Сервер перезапущен. Загрузите файл заново; сохранённые фотографии будут использованы повторно.' };
          this.save(job, true);
        }
      } catch { /* An incomplete status file must not prevent API startup. */ }
    }
    this.prune();
  }

  prune() {
    const old = [...this.jobs.values()].filter(job => terminal.has(job.state))
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt))).slice(100);
    for (const job of old) {
      this.jobs.delete(job.id);
      fs.rmSync(path.join(this.directory, job.id + '.json'), { force: true });
    }
  }

  save(job, force = false) {
    job.updatedAt = new Date().toISOString();
    if (!force && Date.now() - (job.savedAt || 0) < 250) return;
    const temporary = path.join(this.directory, `.${job.id}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.record(job)), { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, path.join(this.directory, job.id + '.json'));
      job.savedAt = Date.now();
    } finally { fs.rmSync(temporary, { force: true }); }
  }

  record(job) {
    const { workbook, options, savedAt, ...record } = job;
    return record;
  }

  view(job) {
    const { actor, workspaceId, shopId, fingerprint, ...view } = this.record(job);
    return view;
  }

  get(actor, workspaceId, shopId, id) {
    const job = this.jobs.get(id);
    assert(job && job.actor === actor && job.workspaceId === workspaceId && job.shopId === shopId,
      'IMPORT_JOB_NOT_FOUND', 'Задание импорта не найдено', 404);
    return this.view(job);
  }

  start(actor, workspaceId, shopId, workbook, input = {}) {
    const options = { skipInvalid: input.skipInvalid === true, active: input.active !== false,
      onMissingSku: input.onMissingSku || 'nothing', onMissingProduct: input.onMissingProduct || 'nothing',
      onMissingCategory: input.onMissingCategory || 'nothing', localizeMedia: true };
    const preview = this.imports.preview(actor, workspaceId, shopId, workbook);
    assert(preview.valid || options.skipInvalid, 'IMPORT_VALIDATION_FAILED', 'Исправьте ошибки файла', 422, preview.errors);
    const total = new Set(this.imports.normalizeWorkbook(workbook).rows
      .filter(row => row.name && row.sku).map(row => String(row.sku))).size;
    assert(total > 0, 'IMPORT_EMPTY', 'В файле нет товаров для импорта');
    const fingerprint = crypto.createHash('sha256').update(JSON.stringify([actor, workbook, options])).digest('hex');
    const slot = `${workspaceId}:${shopId}`;
    const running = this.jobs.get(this.active.get(slot));
    if (running && running.actor === actor && running.fingerprint === fingerprint) return this.view(running);
    assert(!running, 'IMPORT_BUSY', 'В этом магазине уже выполняется импорт. Дождитесь завершения.', 409);
    assert(this.active.size < 2, 'IMPORT_QUEUE_FULL', 'Сервер уже выполняет два импорта. Повторите позже.', 429);
    this.prune();
    const job = { id: crypto.randomUUID(), actor, workspaceId, shopId, fingerprint,
      state: 'queued', phase: 'queued', processed: 0, total, percent: 0,
      media: { prepared: 0, total: 0 }, createdAt: new Date().toISOString(),
      totals: Object.fromEntries(countFields.map(field => [field, 0])), errors: [],
      workbook, options };
    this.jobs.set(job.id, job);
    this.active.set(slot, job.id);
    try { this.save(job, true); }
    catch (error) { this.active.delete(slot); this.jobs.delete(job.id); throw error; }
    setImmediate(() => this.run(job).catch(() => { /* run records its own failure. */ }));
    return this.view(job);
  }

  async run(job) {
    const deadline = Date.now() + 20 * 60 * 1000;
    try {
      job.state = 'running';
      job.phase = 'preparing';
      this.save(job, true);
      let offset = 0;
      while (true) {
        assert(Date.now() < deadline, 'IMPORT_TIMEOUT', 'Импорт превысил 20 минут. Повторите загрузку; готовые фото сохранены.', 504);
        const result = await this.imports.commit(job.actor, job.workspaceId, job.shopId, job.workbook, {
          ...job.options, batchOffset: offset, batchLimit: 25,
          onProgress: progress => {
            job.phase = 'media';
            job.media = { prepared: progress.prepared, total: progress.total };
            const fraction = progress.total ? progress.prepared / progress.total : 1;
            job.percent = Math.min(99.9, Math.round(1000 * (offset + Math.min(25, job.total - offset) * fraction * 0.8) / job.total) / 10);
            this.save(job);
          },
        });
        for (const field of countFields) job.totals[field] += result[field] || 0;
        job.errors.push(...(result.errors || []).slice(0, Math.max(0, 100 - job.errors.length)));
        job.cleanupSkipped = job.cleanupSkipped || result.cleanupSkipped === true;
        job.processed = result.processed;
        job.total = result.total;
        job.phase = 'saving';
        job.percent = Math.min(99.9, Math.round(1000 * job.processed / (job.total || 1)) / 10);
        this.save(job, true);
        if (result.done) break;
        assert(result.processed > offset, 'IMPORT_NO_PROGRESS', 'Сервер не продвинулся к следующей части файла', 500);
        offset = result.processed;
        await new Promise(resolve => setImmediate(resolve));
      }
      job.state = job.totals.failed ? 'completed_with_errors' : 'completed';
      job.phase = 'completed';
      job.percent = 100;
    } catch (error) {
      job.state = 'failed';
      job.error = { code: error.code || 'IMPORT_FAILED', message: error.message || 'Ошибка импорта' };
    } finally {
      this.active.delete(`${job.workspaceId}:${job.shopId}`);
      delete job.workbook;
      delete job.options;
      this.save(job, true);
    }
  }
}
