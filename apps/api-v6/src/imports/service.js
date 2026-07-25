import { assert } from '../core/errors.js';

const aliases = {
  name: ['name', 'название', 'товар', 'наименование'],
  sku: ['sku', 'артикул'],
  price: ['price', 'цена'],
  stock: ['stock', 'остаток', 'количество'],
  category: ['category', 'категория'],
  subcategory: ['subcategory', 'подкатегория'],
  brand: ['brand', 'бренд'],
  description: ['description', 'описание'],
  image: ['image', 'imageurl', 'изображение', 'ссылка на изображение'],
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
  constructor(catalog) { this.catalog = catalog; }

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
    const workbook = XLSX.read(Buffer.from(base64, 'base64'), { type: 'buffer', cellDates: true });
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
    const rows = workbook.sheets[productSheet].map(canonicalRow);
    return { productSheet, categorySheet, categories, rows };
  }

  preview(userId, workspaceId, shopId, workbook) {
    const normalized = this.normalizeWorkbook(workbook);
    const validation = this.catalog.importPreview(userId, workspaceId, shopId, normalized.rows);
    return {
      ...validation,
      sheets: Object.keys(workbook.sheets || {}).map(name => ({ name, rows: workbook.sheets[name].length })),
      productSheet: normalized.productSheet,
      categorySheet: normalized.categorySheet || null,
      categoryRows: normalized.categories.length,
      rows: normalized.rows.slice(0, 100),
    };
  }

  async commit(userId, workspaceId, shopId, workbook, options = {}) {
    const normalized = this.normalizeWorkbook(workbook);
    const preview = this.catalog.importPreview(userId, workspaceId, shopId, normalized.rows);
    assert(preview.valid || options.skipInvalid, 'IMPORT_VALIDATION_FAILED', 'Исправьте ошибки перед импортом', 422, preview.errors);
    const existing = this.catalog.categories(userId, workspaceId, shopId);
    const byName = new Map(existing.map(category => [category.name.trim().toLowerCase(), category]));
    const createdCategories = [];
    const ensureCategory = async name => {
      const key = String(name || '').trim().toLowerCase();
      if (!key) return null;
      if (byName.has(key)) return byName.get(key);
      const category = await this.catalog.createCategory(userId, workspaceId, shopId, { name });
      byName.set(key, category); createdCategories.push(category); return category;
    };
    for (const entry of normalized.categories) {
      const parent = await ensureCategory(entry.name);
      if (entry.childName) {
        const key = entry.childName.trim().toLowerCase();
        if (!byName.has(key)) {
          const child = await this.catalog.createCategory(userId, workspaceId, shopId, { name: entry.childName, parentId: parent?.id || null });
          byName.set(key, child); createdCategories.push(child);
        }
      }
    }
    const grouped = new Map();
    normalized.rows.forEach((row, index) => {
      if ((!row.name || !row.sku) && options.skipInvalid) return;
      const key = String(row.sku || `row-${index}`).trim();
      if (!grouped.has(key)) grouped.set(key, { ...row, variants: [] });
      if (row.variant) grouped.get(key).variants.push({ name: row.variant, sku: `${key}-${grouped.get(key).variants.length + 1}`, price: row.price, stock: row.stock, barcode: row.barcode || '' });
    });
    const imported = [];
    const errors = [];
    for (const row of grouped.values()) {
      try {
        const category = await ensureCategory(row.subcategory || row.category);
        imported.push(await this.catalog.createProduct(userId, workspaceId, shopId, {
          name: row.name,
          sku: row.sku,
          price: row.price,
          stock: row.stock,
          categoryId: category?.id || null,
          brand: row.brand || '',
          description: row.description || '',
          barcode: row.barcode || '',
          images: row.image ? [{ url: row.image, primary: true }] : [],
          variants: row.variants,
          active: options.active !== false,
        }));
      } catch (error) { errors.push({ sku: row.sku, message: error.message, code: error.code || 'IMPORT_ERROR' }); }
    }
    return { imported: imported.length, failed: errors.length, createdCategories: createdCategories.length, products: imported, errors };
  }
}
