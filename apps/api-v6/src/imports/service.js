import { AppError, assert } from '../core/errors.js';

const aliases = {
  name: ['name', 'название', 'товар', 'наименование'],
  sku: ['sku', 'артикул'],
  price: ['price', 'цена'],
  stock: ['stock', 'остаток', 'количество'],
  category: ['category', 'категория'],
  subcategory: ['subcategory', 'подкатегория'],
  brand: ['brand', 'бренд'],
  description: ['description', 'описание'],
  image: ['image', 'imageurl', 'изображение', 'фото', 'ссылка на изображение'],
  variant: ['variant', 'вариация', 'вкус'],
  barcode: ['barcode', 'штрихкод'],
};

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function canonicalRow(row) {
  const source = Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [normalizeKey(key), value]));
  const out = {};
  for (const [target, names] of Object.entries(aliases)) {
    for (const name of names) {
      const key = normalizeKey(name);
      if (Object.hasOwn(source, key)) { out[target] = source[key]; break; }
    }
  }
  return out;
}

function parseCsvLine(line, delimiter) {
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cells.push(current); current = '';
    } else current += char;
  }
  cells.push(current);
  return cells.map(cell => cell.trim());
}

export class ImportService {
  constructor(catalog, media) { this.catalog = catalog; this.media = media; }

  parseCsv(text) {
    const clean = String(text || '').replace(/^\uFEFF/, '').trim();
    assert(clean, 'IMPORT_FILE_EMPTY', 'Файл импорта пуст');
    const lines = clean.split(/\r?\n/).filter(Boolean);
    const delimiter = (lines[0].match(/;/g) || []).length >= (lines[0].match(/,/g) || []).length ? ';' : ',';
    const headers = parseCsvLine(lines.shift(), delimiter);
    return lines.map(line => Object.fromEntries(headers.map((header, index) => [header, parseCsvLine(line, delimiter)[index] ?? ''])));
  }

  async parseWorkbookBase64(base64, filename = '') {
    const extension = String(filename).toLowerCase().split('.').pop();
    if (extension === 'csv') return { sheets: { Товары: this.parseCsv(Buffer.from(base64, 'base64').toString('utf8')) } };
    assert(['xlsx', 'xls'].includes(extension), 'IMPORT_FORMAT_UNSUPPORTED', 'Поддерживаются CSV, XLSX и XLS');
    let XLSX;
    try { XLSX = await import('xlsx'); }
    catch { assert(false, 'XLSX_DEPENDENCY_MISSING', 'Для XLSX выполните npm install', 503); }
    let workbook;
    try { workbook = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer', cellDates: true }); }
    catch { assert(false, 'IMPORT_FILE_INVALID', 'Не удалось прочитать Excel-файл. Загрузите файл XLSX или XLS.'); }
    const sheets = {};
    for (const name of workbook.SheetNames) sheets[name] = XLSX.utils.sheet_to_json(workbook.Sheets[name], { defval: '' });
    return { sheets };
  }

  normalizeWorkbook(workbook) {
    const names = Object.keys(workbook.sheets || {});
    const productSheet = names.find(name => /товар|product/i.test(name)) || names[0];
    const categorySheet = names.find(name => /категор|categor/i.test(name));
    assert(productSheet, 'IMPORT_PRODUCTS_SHEET_MISSING', 'Не найден лист с товарами');
    const categories = (categorySheet ? workbook.sheets[categorySheet] : []).map(row => ({
      name: row.Категория || row.category || row.name || '',
      parentName: row.Подкатегория ? (row.Категория || '') : (row.parent || ''),
      childName: row.Подкатегория || '',
    })).filter(item => item.name || item.childName);
    const rows = workbook.sheets[productSheet].map(canonicalRow).map(row => ({ ...row,
      name: String(row.name || '').trim(), sku: String(row.sku ?? '').trim(),
      category: String(row.category || '').trim(), subcategory: String(row.subcategory || '').trim(),
      price: this.number(row.price), stock: this.number(row.stock), image: String(row.image || '').trim(),
    }));
    return { productSheet, categorySheet, categories, rows };
  }

  number(value) {
    if (value == null || String(value).trim() === '') return 0;
    return Number(String(value).trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.'));
  }

  preview(userId, workspaceId, shopId, workbook) {
    const normalized = this.normalizeWorkbook(workbook);
    const validation = this.catalog.importPreview(userId, workspaceId, shopId, normalized.rows);
    normalized.rows.forEach((row, index) => {
      for (const [field, label] of [['price', 'цена'], ['stock', 'остаток']]) {
        if (!Number.isFinite(row[field]) || row[field] < 0) validation.errors.push({ line: index + 2, field, message: `Некорректный ${label}` });
      }
    });
    validation.valid = validation.errors.length === 0;
    const existing = new Set(this.catalog.products(userId, workspaceId, shopId).map(p => p.sku));
    const skus = new Set(normalized.rows.map(row => row.sku));
    return {
      ...validation,
      created: [...skus].filter(sku => !existing.has(sku)).length,
      updated: [...skus].filter(sku => existing.has(sku)).length,
      uniqueImages: new Set(normalized.rows.map(row => row.image).filter(Boolean)).size,
      sheets: Object.keys(workbook.sheets || {}).map(name => ({ name, rows: workbook.sheets[name].length })),
      productSheet: normalized.productSheet,
      categorySheet: normalized.categorySheet || null,
      categoryRows: normalized.categories.length,
      rows: normalized.rows.slice(0, 100),
    };
  }

  async commit(userId, workspaceId, shopId, workbook, options = {}) {
    const normalized = this.normalizeWorkbook(workbook);
    const preview = this.preview(userId, workspaceId, shopId, workbook);
    assert(preview.valid || options.skipInvalid, 'IMPORT_VALIDATION_FAILED', 'Исправьте ошибки перед импортом', 422, preview.errors);
    const invalid = new Set(preview.errors.map(error => error.line - 2));
    const grouped = new Map();
    normalized.rows.forEach((row, index) => {
      if (invalid.has(index) && options.skipInvalid) return;
      const key = String(row.sku || `row-${index}`).trim();
      if (!grouped.has(key)) grouped.set(key, { ...row, variants: [], imageSources: new Set() });
      if (row.image) grouped.get(key).imageSources.add(row.image);
      if (row.variant) grouped.get(key).variants.push({ name: row.variant, sku: `${key}-${grouped.get(key).variants.length + 1}`, price: row.price, stock: row.stock, barcode: row.barcode || '' });
    });
    const sources = [...new Set([...grouped.values()].flatMap(row => [...row.imageSources]))];
    const images = new Map();
    // Download before the catalogue transaction: unavailable photos must not silently
    // create a partially imported catalogue with external or broken image links.
    let cursor = 0;
    const download = async () => {
      while (cursor < sources.length) {
        const source = sources[cursor++];
        assert(this.media, 'IMPORT_MEDIA_UNAVAILABLE', 'Хранилище фотографий не настроено', 503);
        let localFile;
        try {
          const url = new URL(source, 'https://local.invalid');
          if (url.pathname.startsWith(this.media.publicPrefix) && ['http:', 'https:'].includes(url.protocol)) {
            const filename = decodeURIComponent(url.pathname.slice(this.media.publicPrefix.length));
            this.media.resolve(filename);
            localFile = { filename, url: `${this.media.publicPrefix}${filename}` };
          }
        } catch { /* Nonlocal sources are validated and fetched by the media service. */ }
        try { images.set(source, localFile || await this.media.importRemote(source)); }
        catch (error) {
          const affected = [...grouped.values()].filter(row => row.imageSources.has(source)).map(row => row.sku);
          let address = 'Некорректный адрес';
          try {
            const safe = new URL(source);
            address = `${safe.protocol}//${safe.host}${safe.pathname}`;
          } catch { /* Do not echo credentials or query parameters from untrusted URLs. */ }
          throw new AppError(error.code || 'MEDIA_DOWNLOAD_FAILED',
            `Не удалось сохранить фото для SKU ${affected.slice(0, 5).join(', ')}. ${error.message}`,
            error.status || 502, [{ sku: affected[0], message: address }]);
        }
      }
    };
    const downloads = await Promise.allSettled(Array.from({ length: Math.min(4, sources.length) }, download));
    const failure = downloads.find(result => result.status === 'rejected');
    if (failure) throw failure.reason;
    const inputs = [...grouped.values()].map(({ imageSources, ...row }) => ({ ...row,
      images: imageSources.size ? [...imageSources].map((source, index) => ({ ...images.get(source), primary: index === 0 })) : undefined,
      active: options.active !== false,
    }));
    const result = await this.catalog.importBatch(userId, workspaceId, shopId, inputs, normalized.categories, options);
    if (invalid.size && options.skipInvalid) {
      result.failed += invalid.size;
      result.errors.push(...[...invalid].map(index => ({ line: index + 2, sku: normalized.rows[index]?.sku,
        code: 'IMPORT_VALIDATION_FAILED', message: preview.errors.filter(error => error.line === index + 2).map(error => error.message).join('; ') })));
    }
    return result;
  }
}
