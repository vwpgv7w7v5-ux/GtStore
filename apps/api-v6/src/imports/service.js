import crypto from 'node:crypto';
import { AppError, assert } from '../core/errors.js';

const aliases = {
  name: ['name', 'название', 'товар', 'наименование'],
  sku: ['sku', 'артикул'],
  price: ['price', 'цена'],
  stock: ['stock', 'остаток', 'количество'],
  category: ['category', 'категория'],
  subcategory: ['subcategory', 'подкатегория'],
  // 3rd level: Стики → Terea → Армения / Толстые; ЭС → Lost Mary → BM 16000
  group: [
    'group',
    'линейка',
    'вариант',
    'серия',
    'подподкатегория',
    'группа',
    'line',
    'variantgroup',
    'модель',
    'model',
    'device',
    'линейкатоваров',
    'сериятоваров',
    'линейка/модель',
    'модель/линейка',
  ],
  brand: ['brand', 'бренд'],
  description: ['description', 'описание'],
  image: ['image', 'imageurl', 'изображение', 'ссылка на изображение'],
  variant: [
    'variant',
    'вариация',
    'вкус',
    'вкус/цвет/размер',
    'вкусцветразмер',
    'цвет',
    'размер',
    'опция',
  ],
  // legacy column — still accepted on import, not written to new templates
  variantImage: ['variantimage', 'фото вкуса', 'изображение вкуса', 'картинка вкуса'],
  barcode: ['barcode', 'штрихкод'],
};

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase().replace(/[\s_-]+/g, '');
}

function cellToString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value.replace(/\u00a0/g, ' ').trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    // avoid scientific notation for barcodes/skus
    if (Number.isInteger(value) && Math.abs(value) >= 1e11) return String(Math.trunc(value));
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    // rich text / formula result shapes from SheetJS
    if (Array.isArray(value.r)) return value.r.map((p) => cellToString(p?.t ?? p)).join('');
    if (value.t != null && value.v == null) return cellToString(value.t);
    if (value.v != null) return cellToString(value.v);
    if (value.w != null) return cellToString(value.w);
    if (value.text != null) return cellToString(value.text);
    try { return String(value).trim(); } catch { return ''; }
  }
  return String(value).replace(/\u00a0/g, ' ').trim();
}

function normalizeSheetRows(rows) {
  return (rows || []).map((row) => {
    const out = {};
    for (const [key, value] of Object.entries(row || {})) {
      out[cellToString(key) || key] = cellToString(value);
    }
    return out;
  });
}

function canonicalRow(row) {
  const source = Object.fromEntries(
    Object.entries(row || {}).map(([key, value]) => [normalizeKey(cellToString(key) || key), cellToString(value)]),
  );
  const out = {};
  for (const [target, names] of Object.entries(aliases)) {
    for (const name of names) {
      const key = normalizeKey(name);
      if (Object.hasOwn(source, key)) { out[target] = source[key]; break; }
    }
  }
  if (out.price != null) out.price = String(out.price).replace(/\s+/g, '').replace('₽', '').replace(',', '.');
  if (out.stock != null) out.stock = String(out.stock).replace(/\s+/g, '').replace(',', '.');
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
  constructor(catalog) { this.catalog = catalog; this.sessions = new Map(); }

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
    if (['xml', 'yml', 'yaml'].includes(extension)) {
      assert(false, 'IMPORT_FORMAT_UNSUPPORTED', 'Импорт XML/YML не поддерживается. Загрузите CSV, XLS или XLSX.', 400);
    }
    if (extension === 'csv' || extension === 'txt') {
      return { sheets: { Товары: this.parseCsv(Buffer.from(base64, 'base64').toString('utf8')) } };
    }
    let XLSX;
    try { XLSX = await import('xlsx'); }
    catch { assert(false, 'XLSX_DEPENDENCY_MISSING', 'Для XLSX выполните npm install', 503); }
    try {
      const workbook = XLSX.read(Buffer.from(base64, 'base64'), {
        type: 'buffer',
        cellDates: true,
        cellNF: false,
        cellStyles: false, // ignore fonts/fills/row heights — data only
        sheetStubs: false,
        raw: false,
      });
      const sheets = {};
      for (const name of workbook.SheetNames) {
        const json = XLSX.utils.sheet_to_json(workbook.Sheets[name], {
          defval: '',
          raw: false, // prefer formatted text
          blankrows: false,
        });
        sheets[name] = normalizeSheetRows(json);
      }
      return { sheets };
    } catch {
      assert(false, 'IMPORT_FORMAT_UNSUPPORTED', 'Не удалось прочитать файл как Excel/CSV. Сохраните как XLSX или CSV.', 400);
    }
  }

  normalizeWorkbook(workbook) {
    const names = Object.keys(workbook.sheets || {});
    const productSheet = names.find(name => /товар|product/i.test(name)) || names[0];
    const categorySheet = names.find(name => /категор|categor/i.test(name));
    assert(productSheet, 'IMPORT_PRODUCTS_SHEET_MISSING', 'Не найден лист с товарами');
    const categories = (categorySheet ? workbook.sheets[categorySheet] : []).map((row) => {
      const rootName = cellToString(row.Категория || row.category || row.name || '');
      const midName = cellToString(row.Подкатегория || row.subcategory || '');
      const leafName = cellToString(
        row.Линейка || row.Вариант || row.Серия || row.Группа || row.group || row.line || '',
      );
      return { rootName, midName, leafName };
    }).filter((item) => item.rootName || item.midName || item.leafName);
    const rows = workbook.sheets[productSheet].map(canonicalRow);
    return { productSheet, categorySheet, categories, rows };
  }

  preview(userId, workspaceId, shopId, workbook) {
    const normalized = this.normalizeWorkbook(workbook);
    const validation = this.catalog.importPreview(userId, workspaceId, shopId, normalized.rows);
    const existing = new Set(this.catalog.products(userId, workspaceId, shopId).map(p => p.sku.toLowerCase()));
    const skus = new Set(normalized.rows.map(row => String(row.sku || '').toLowerCase()));
    return {
      ...validation,
      uniqueImages: new Set(normalized.rows.flatMap(row => [row.image, row.variantImage]).filter(Boolean)).size,
      created: [...skus].filter(sku => !existing.has(sku)).length,
      updated: [...skus].filter(sku => existing.has(sku)).length,
      sheets: Object.keys(workbook.sheets || {}).map(name => ({ name, rows: workbook.sheets[name].length })),
      productSheet: normalized.productSheet,
      categorySheet: normalized.categorySheet || null,
      categoryRows: normalized.categories.length,
      rows: validation.rows,
    };
  }

  async commit(userId, workspaceId, shopId, workbook, options = {}) {
    const offset = Number(options.batchOffset ?? 0), limit = Number(options.batchLimit ?? 0);
    assert(Number.isInteger(offset) && offset >= 0 && Number.isInteger(limit) && limit >= 0 && (limit > 0 || offset === 0),
      'IMPORT_BATCH_INVALID', 'Некорректные параметры пакета импорта');
    const flags = { skipInvalid: !!options.skipInvalid, localizeMedia: options.localizeMedia !== false,
      onMissingProduct: options.onMissingProduct || 'nothing', onMissingSku: options.onMissingSku || 'nothing',
      onMissingCategory: options.onMissingCategory || 'nothing', active: options.active !== false };
    const key = crypto.createHash('sha256').update(JSON.stringify([userId, workspaceId, shopId, workbook, flags])).digest('hex');
    // An offset cannot authorize destructive cleanup without successful earlier batches.
    for (const [id, session] of this.sessions) if (!session.busy && Date.now() - session.updatedAt > 3600000) this.sessions.delete(id);
    let session = this.sessions.get(key);
    assert(!session?.busy, 'IMPORT_BUSY', 'Этот импорт уже выполняется', 409);
    if (offset === 0) {
      session = { next: 0, failed: 0, mediaCache: new Map(), updatedAt: Date.now(),
        initialProductIds: new Set(this.catalog.products(userId, workspaceId, shopId).map(p => p.id)),
        initialCategoryIds: new Set(this.catalog.categories(userId, workspaceId, shopId).map(c => c.id)) };
      this.sessions.set(key, session);
    } else {
      assert(session && session.next === offset && !session.done, 'IMPORT_BATCH_ORDER',
        'Последовательность импорта прервана. Начните импорт файла заново.', 409);
    }
    session.busy = true;
    try {
      const result = await this.commitBatch(userId, workspaceId, shopId, workbook,
        { ...options, batchOffset: offset, batchLimit: limit ? Math.min(limit, 25) : 0, session });
      session.next = result.processed;
      session.done = result.done;
      return result;
    } catch (error) {
      session.done = true;
      throw error;
    } finally {
      session.busy = false;
      session.updatedAt = Date.now();
      if (session.done) this.sessions.delete(key);
    }
  }

  async commitBatch(userId, workspaceId, shopId, workbook, options = {}) {
    const batchOffset = Number.isFinite(Number(options.batchOffset)) ? Number(options.batchOffset) : 0;
    const batchLimit = Number.isFinite(Number(options.batchLimit)) ? Number(options.batchLimit) : 0;
    const localizeMedia = options.localizeMedia !== false;
    const normalized = this.normalizeWorkbook(workbook);
    // Full validation only on first batch — later batches reuse the same file
    if (batchOffset <= 0) {
      const preview = this.catalog.importPreview(userId, workspaceId, shopId, normalized.rows);
      assert(preview.valid || options.skipInvalid, 'IMPORT_VALIDATION_FAILED', 'Исправьте ошибки перед импортом', 422, preview.errors);
      options.session.invalidRows = new Set(preview.errors.map(error => error.line - 2));
      options.session.failed = options.session.invalidRows.size;
    } else if (!options.skipInvalid) {
      // Light check: workbook still parses to rows
      assert(normalized.rows?.length, 'IMPORT_VALIDATION_FAILED', 'Файл пуст', 422);
    }
    const onMissingProduct = ['nothing', 'hide', 'delete'].includes(options.onMissingProduct)
      ? options.onMissingProduct
      : 'nothing';
    const onMissingSku = ['nothing', 'hide', 'delete'].includes(options.onMissingSku)
      ? options.onMissingSku
      : onMissingProduct;
    const onMissingCategory = ['nothing', 'hide', 'delete'].includes(options.onMissingCategory)
      ? options.onMissingCategory
      : 'nothing';

    const existing = this.catalog.categories(userId, workspaceId, shopId);
    // Path-aware map so "Армения" under Terea ≠ "Армения" under Neo
    const byPath = new Map(
      existing.map((category) => [
        `${category.parentId || ''}::${String(category.name || '').trim().toLowerCase()}`,
        category,
      ]),
    );
    const createdCategories = [];
    // Path keys: "стики", "стики||terea", "стики||terea||армения"
    // (name-only matching wrongly keeps old root "IQOS" when IQOS exists as a subcategory)
    const fileCategoryPaths = new Set();
    const pathPart = (name) => String(name || '').trim().toLowerCase();
    const rememberCategoryPath = (rootName, midName = '', leafName = '') => {
      const root = pathPart(rootName);
      const mid = pathPart(midName);
      const leaf = pathPart(leafName);
      if (!root) return;
      fileCategoryPaths.add(root);
      if (mid) fileCategoryPaths.add(`${root}||${mid}`);
      if (mid && leaf) fileCategoryPaths.add(`${root}||${mid}||${leaf}`);
      else if (!mid && leaf) fileCategoryPaths.add(`${root}||${leaf}`);
    };
    const categoryPathKey = (category, byId) => {
      const parts = [];
      let cur = category;
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(pathPart(cur.name));
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return parts.filter(Boolean).join('||');
    };
    const ensureCategory = async (name, parentId = null) => {
      const clean = String(name || '').trim();
      const keyName = clean.toLowerCase();
      if (!keyName) return null;
      const pathKey = `${parentId || ''}::${keyName}`;
      if (byPath.has(pathKey)) return byPath.get(pathKey);
      // Prefer path-based slug so "Армения" under Terea ≠ "Армения" under Neo
      const parent = parentId
        ? [...byPath.values()].find((c) => c.id === parentId) ||
          existing.find((c) => c.id === parentId)
        : null;
      const preferredSlug = parent?.slug ? `${parent.slug}-${clean}` : clean;
      const category = await this.catalog.createCategory(userId, workspaceId, shopId, {
        name: clean,
        parentId: parentId || null,
        slug: preferredSlug,
      }, { backup: false });
      byPath.set(pathKey, category);
      createdCategories.push(category);
      return category;
    };
    const ensureCategoryPath = async (rootName, midName, leafName) => {
      rememberCategoryPath(rootName, midName, leafName);
      const root = rootName ? await ensureCategory(rootName, null) : null;
      // Without root, mid becomes top-level (compat with old sheets)
      const mid = midName ? await ensureCategory(midName, root?.id || null) : null;
      const leafParent = mid?.id || null;
      const leaf = leafName && leafParent
        ? await ensureCategory(leafName, leafParent)
        : (leafName && !midName && root ? await ensureCategory(leafName, root.id) : null);
      return leaf || mid || root || null;
    };

    /** If file has Категория+Подкатегория but empty Линейка, attach to leaf by product name. */
    const resolveLeafByProductName = (category, productName) => {
      if (!category?.id || !productName) return category;
      const kids = [...byPath.values()]
        .filter((c) => c.parentId === category.id)
        .sort((a, b) => String(b.name || '').length - String(a.name || '').length);
      if (!kids.length) {
        // refresh from live catalog (kids may exist from category sheet)
        const live = this.catalog
          .categories(userId, workspaceId, shopId)
          .filter((c) => c.parentId === category.id)
          .sort((a, b) => String(b.name || '').length - String(a.name || '').length);
        if (!live.length) return category;
        const hay = String(productName).toLowerCase();
        return live.find((c) => hay.includes(String(c.name || '').toLowerCase())) || category;
      }
      const hay = String(productName).toLowerCase();
      return kids.find((c) => hay.includes(String(c.name || '').toLowerCase())) || category;
    };

    /** Split "Электронные сигареты Lost Mary" → root + mid when Подкатегория looks like a line. */
    const splitCompositeCategory = (row) => {
      let root = String(row.category || '').trim();
      let mid = String(row.subcategory || '').trim();
      let leaf = String(row.group || '').trim();
      if (!leaf && mid && /^(lost\s*mary|plonq|inflave|pafos|puffmi|waka)\b/i.test(mid) && /\d{3,}/.test(mid)) {
        // mid is actually a line (Lost Mary BM 16000); category may be "Электронные сигареты Lost Mary"
        const m = root.match(/^(электронные\s+сигареты)\s+(.+)$/i);
        if (m) {
          leaf = mid;
          mid = m[2].trim();
          root = m[1].trim();
        } else if (/^электронные\s+сигареты$/i.test(root)) {
          // root ok; brand missing — derive brand from line prefix
          const brand = mid.match(/^(lost\s*mary|plonq|inflave|pafos|puffmi|waka)/i)?.[1];
          if (brand) {
            leaf = mid;
            mid = brand.replace(/\s+/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase());
            if (/^lost\s*mary$/i.test(mid)) mid = 'Lost Mary';
            else if (/^plonq$/i.test(mid)) mid = 'Plonq';
            else if (/^inflave$/i.test(mid)) mid = 'Inflave';
            else if (/^pafos$/i.test(mid)) mid = 'PAFOS';
            else if (/^puffmi$/i.test(mid)) mid = 'Puffmi';
            else if (/^waka$/i.test(mid)) mid = 'WAKA';
          }
        }
      } else if (!mid && !leaf) {
        const m = root.match(/^(электронные\s+сигареты)\s+(.+)$/i);
        if (m) {
          root = m[1].trim();
          mid = m[2].trim();
        }
      }
      return { root, mid, leaf };
    };
    const grouped = new Map();
    normalized.rows.forEach((row, index) => {
      if (options.skipInvalid && options.session.invalidRows.has(index)) return;
      rememberCategoryPath(row.category, row.subcategory, row.group);
      const key = String(row.sku || `row-${index}`).trim();
      if (!grouped.has(key)) grouped.set(key, { ...row, variants: [] });
      if (row.variant) grouped.get(key).variants.push({ name: row.variant, sku: `${key}-${grouped.get(key).variants.length + 1}`, price: row.price, stock: row.stock, barcode: row.barcode || '', imageUrl: row.variantImage || '' });
    });
    const groupList = [...grouped.values()];
    const total = groupList.length;
    const slice = batchLimit > 0 ? groupList.slice(batchOffset, batchOffset + batchLimit) : groupList;
    const isLast = batchLimit <= 0 || batchOffset + slice.length >= total;
    const imported = [];
    const updated = [];
    const errors = [];
    if (batchOffset === 0) for (const index of options.session.invalidRows) errors.push({
      line: index + 2, sku: normalized.rows[index]?.sku, code: 'IMPORT_VALIDATION_FAILED', message: 'Некорректная строка пропущена' });
    const imageUrls = new Set(slice.flatMap(row => [row.image, ...row.variants.map(v => v.imageUrl)].filter(Boolean)));
    const sources = [...imageUrls], localized = new Map(), mediaErrors = new Map();
    let imageCursor = 0, imageCompleted = 0;
    options.onProgress?.({ stage: 'media', prepared: 0, total: sources.length });
    const fetchImage = async () => {
      while (imageCursor < sources.length) {
        const source = sources[imageCursor++];
        try {
          const url = localizeMedia && this.catalog.media
            ? await this.catalog.media.ingestUrl(source, { cache: options.session.mediaCache }) : source;
          localized.set(source, url);
        } catch (error) { mediaErrors.set(source, error); }
        imageCompleted++;
        options.onProgress?.({ stage: 'media', prepared: imageCompleted, total: sources.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, sources.length) }, fetchImage));
    if (mediaErrors.size && !options.skipInvalid) {
      const [source, error] = mediaErrors.entries().next().value;
      const row = slice.find(row => row.image === source || row.variants.some(v => v.imageUrl === source));
      let address = 'Некорректный адрес';
      try { const url = new URL(source); address = `${url.origin}${url.pathname}`; } catch { /* No raw URL credentials in errors. */ }
      throw new AppError(error.code || 'IMPORT_MEDIA_FAILED', `Фото для SKU ${row?.sku}: ${error.message}`, error.status || 422,
        [{ sku: row?.sku, message: address }]);
    }
    for (const entry of normalized.categories) {
      await ensureCategoryPath(entry.rootName, entry.midName, entry.leafName);
    }
    const existingProducts = this.catalog.products(userId, workspaceId, shopId, {
      status: 'all',
    });
    const bySku = new Map(
      existingProducts.map((product) => [String(product.sku).trim().toLowerCase(), product]),
    );
    const fileSkus = new Set(
      [...grouped.keys()].map((sku) => String(sku || '').trim().toLowerCase()).filter(Boolean),
    );

    // Build payloads first (categories), then one bulk DB write for the whole batch
    const bulkItems = [];
    for (const row of slice) {
      try {
        const failedSource = [row.image, ...row.variants.map(v => v.imageUrl)].find(source => mediaErrors.has(source));
        if (failedSource) throw mediaErrors.get(failedSource);
        const parts = splitCompositeCategory(row);
        let category = await ensureCategoryPath(parts.root, parts.mid, parts.leaf);
        if (!parts.leaf) category = resolveLeafByProductName(category, row.name);
        const payload = {
          name: row.name,
          sku: row.sku,
          price: row.price,
          stock: row.stock,
          categoryId: category?.id || null,
          brand: row.brand || '',
          description: row.description || '',
          barcode: row.barcode || '',
          images: row.image ? [{ url: localized.get(row.image), primary: true }] : undefined,
          variants: row.variants?.length ? row.variants.map(v => {
            const variant = { ...v };
            if (v.imageUrl) variant.imageUrl = localized.get(v.imageUrl);
            else delete variant.imageUrl;
            return variant;
          }) : undefined,
          active: options.active !== false,
        };
        const current = bySku.get(String(row.sku || '').trim().toLowerCase());
        if (current) {
          if (payload.images === undefined) delete payload.images;
          if (payload.variants === undefined) delete payload.variants;
          bulkItems.push({ mode: 'update', productId: current.id, input: payload });
        } else {
          bulkItems.push({
            mode: 'create',
            input: {
              ...payload,
              images: payload.images || [],
              variants: payload.variants || [],
            },
          });
        }
      } catch (error) {
        errors.push({
          sku: row.sku,
          message: error.message,
          code: error.code || 'IMPORT_ERROR',
        });
      }
    }

    if (bulkItems.length) {
      const bulk = await this.catalog.upsertProductsBulk(
        userId,
        workspaceId,
        shopId,
        bulkItems,
        { localize: false, backup: true, skipInvalid: !!options.skipInvalid },
      );
      imported.push(...(bulk.imported || []));
      updated.push(...(bulk.updated || []));
      errors.push(...(bulk.errors || []));
      for (const product of [...imported, ...updated]) {
        bySku.set(String(product.sku).trim().toLowerCase(), product);
      }
    }

    options.session.failed += errors.filter(error => error.code !== 'IMPORT_VALIDATION_FAILED').length;
    const cleanupAllowed = options.session.failed === 0;
    const missingAction = onMissingSku !== 'nothing' ? onMissingSku : onMissingProduct;
    let missingHidden = 0;
    let missingDeleted = 0;
    if (isLast && cleanupAllowed && missingAction !== 'nothing') {
      const latestProducts = this.catalog.products(userId, workspaceId, shopId, {
        status: 'all',
      });
      for (const product of latestProducts) {
        if (!options.session.initialProductIds.has(product.id)) continue;
        const sku = String(product.sku || '').trim().toLowerCase();
        if (!sku || fileSkus.has(sku)) continue;
        try {
          if (missingAction === 'hide') {
            await this.catalog.updateProduct(userId, workspaceId, shopId, product.id, {
              active: false,
            });
            missingHidden += 1;
          } else if (missingAction === 'delete') {
            await this.catalog.deleteProduct(userId, workspaceId, shopId, product.id);
            missingDeleted += 1;
          }
        } catch (error) {
          errors.push({
            sku: product.sku,
            message: error.message,
            code: error.code || 'IMPORT_MISSING_PRODUCT_ERROR',
          });
        }
      }
    }

    let categoriesHidden = 0;
    let categoriesDeleted = 0;
    if (isLast && cleanupAllowed && onMissingCategory !== 'nothing') {
      // Process deepest categories first so parents can be removed after children.
      for (let pass = 0; pass < 20; pass += 1) {
        const latestCategories = this.catalog.categories(userId, workspaceId, shopId);
        const byId = new Map(latestCategories.map((c) => [c.id, c]));
        const latestProducts = this.catalog.products(userId, workspaceId, shopId, {
          status: 'all',
        });
        const usedCategoryIds = new Set(
          latestProducts.map((product) => product.categoryId).filter(Boolean),
        );
        // Also treat ancestor ids of used categories as "in use" for hide/delete safety
        for (const id of [...usedCategoryIds]) {
          let cur = byId.get(id);
          while (cur?.parentId) {
            usedCategoryIds.add(cur.parentId);
            cur = byId.get(cur.parentId);
          }
        }
        const childIds = new Set(
          latestCategories.map((category) => category.parentId).filter(Boolean),
        );
        let changed = false;
        for (const category of latestCategories) {
          if (!options.session.initialCategoryIds.has(category.id)) continue;
          const pathKey = categoryPathKey(category, byId);
          if (!pathKey || fileCategoryPaths.has(pathKey)) continue;
          if (childIds.has(category.id)) continue;
          try {
            if (onMissingCategory === 'hide') {
              if (category.active === false) continue;
              await this.catalog.updateCategory(userId, workspaceId, shopId, category.id, {
                active: false,
              });
              categoriesHidden += 1;
              changed = true;
            } else if (onMissingCategory === 'delete') {
              if (usedCategoryIds.has(category.id)) continue;
              await this.catalog.deleteCategory(userId, workspaceId, shopId, category.id);
              categoriesDeleted += 1;
              changed = true;
            }
          } catch (error) {
            errors.push({
              sku: category.name,
              message: error.message,
              code: error.code || 'IMPORT_MISSING_CATEGORY_ERROR',
            });
          }
        }
        if (!changed) break;
      }
    }

    return {
      imported: imported.length,
      updated: updated.length,
      failed: errors.length,
      createdCategories: createdCategories.length,
      missingHidden,
      missingDeleted,
      categoriesHidden,
      categoriesDeleted,
      cleanupSkipped: isLast && !cleanupAllowed,
      processed: batchOffset + slice.length,
      total,
      done: isLast,
      products: [...imported, ...updated],
      errors,
    };
  }

  async loadXlsx() {
    try {
      return await import('xlsx');
    } catch {
      assert(false, 'XLSX_DEPENDENCY_MISSING', 'Для Excel выполните npm install', 503);
    }
  }

  async buildTemplateWorkbook() {
    const XLSX = await this.loadXlsx();
    const products = [
      {
        Название: 'Стики Terea',
        SKU: 'TEREA-AMBER-AM',
        Цена: 350,
        Остаток: 20,
        Категория: 'Стики',
        Подкатегория: 'Terea',
        Линейка: 'Армения',
        Бренд: 'IQOS',
        Описание: 'Стики Terea (Армения)',
        Изображение: '',
        'Вкус/цвет/размер': 'Amber',
      },
      {
        Название: 'Стики Terea',
        SKU: 'TEREA-SIENNA-AM',
        Цена: 350,
        Остаток: 15,
        Категория: 'Стики',
        Подкатегория: 'Terea',
        Линейка: 'Армения',
        Бренд: 'IQOS',
        Описание: 'Стики Terea (Армения)',
        Изображение: '',
        'Вкус/цвет/размер': 'Sienna',
      },
      {
        Название: 'Футболка базовая',
        SKU: 'TEE-WHITE-S',
        Цена: 990,
        Остаток: 8,
        Категория: 'Одежда',
        Подкатегория: 'Футболки',
        Линейка: '',
        Бренд: '',
        Описание: 'Пример: цвет и размер в одной ячейке',
        Изображение: '',
        'Вкус/цвет/размер': 'Белый;размер:S',
      },
    ];
    const categories = [
      { Категория: 'Стики', Подкатегория: '', Линейка: '' },
      { Категория: 'Стики', Подкатегория: 'Terea', Линейка: '' },
      { Категория: 'Стики', Подкатегория: 'Terea', Линейка: 'Армения' },
      { Категория: 'Стики', Подкатегория: 'Terea', Линейка: 'Казахстан' },
      { Категория: 'Стики', Подкатегория: 'Neo', Линейка: 'Тонкие' },
      { Категория: 'Жидкости', Подкатегория: '', Линейка: '' },
    ];
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(products), 'Товары');
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(categories), 'Категории');
    const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
    return {
      filename: 'gtstore-import-template.xlsx',
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64,
    };
  }

  async exportCatalog(userId, workspaceId, shopId) {
    const XLSX = await this.loadXlsx();
    const products = this.catalog.products(userId, workspaceId, shopId, {
      status: 'all',
    });
    const categories = this.catalog.categories(userId, workspaceId, shopId);
    const byId = new Map(categories.map((category) => [category.id, category]));
    const chainOf = (category) => {
      const chain = [];
      let cur = category;
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        chain.unshift(cur);
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return chain;
    };
    const rows = [];
    for (const product of products) {
      const category = byId.get(product.categoryId);
      const chain = chainOf(category);
      const base = {
        Название: product.name,
        SKU: product.sku,
        Цена: product.price,
        Остаток: product.totalStock ?? product.stock,
        Категория: chain[0]?.name || '',
        Подкатегория: chain[1]?.name || '',
        Линейка: chain[2]?.name || '',
        Бренд: product.brand || '',
        Описание: product.description || '',
        Изображение: product.images?.[0]?.url || '',
        'Вкус/цвет/размер': '',
        Активен: product.active !== false ? 'да' : 'нет',
      };
      const variants = (product.variants || []).filter(Boolean);
      if (variants.length) {
        for (const variant of variants) {
          rows.push({
            ...base,
            Цена: variant.price,
            Остаток: variant.stock,
            'Вкус/цвет/размер': variant.name || '',
            Активен: variant.active !== false ? 'да' : 'нет',
          });
        }
      } else {
        rows.push(base);
      }
    }
    const categoryRows = categories.map((category) => {
      const chain = chainOf(category);
      return {
        Категория: chain[0]?.name || category.name,
        Подкатегория: chain[1]?.name || '',
        Линейка: chain[2]?.name || '',
      };
    });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(rows.length ? rows : [{ Название: '', SKU: '', Цена: '', Остаток: '', Категория: '', Подкатегория: '', Линейка: '', Бренд: '', Описание: '', Изображение: '', 'Вкус/цвет/размер': '', Активен: '' }]),
      'Товары',
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(categoryRows.length ? categoryRows : [{ Категория: '', Подкатегория: '', Линейка: '' }]),
      'Категории',
    );
    const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });
    const shop = this.catalog.ensureShop(userId, workspaceId, shopId).state.shops.find(
      (item) => item.id === shopId,
    );
    const slug = shop?.slug || 'catalog';
    return {
      filename: `gtstore-${slug}-export.xlsx`,
      mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      base64,
      products: products.length,
      rows: rows.length,
      categories: categories.length,
    };
  }
}
