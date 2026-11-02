import { AppError, assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const money = value => Math.round(Number(value || 0) * 100) / 100;
const integer = value => Math.max(0, Math.trunc(Number(value || 0)));
const slugify = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '');
const uniqueCategorySlug = (shopCategories, desired, excludeId = null) => {
  let slug = slugify(desired) || 'category';
  const base = slug.slice(0, 72);
  let n = 1;
  while (shopCategories.some((c) => c.slug === slug && c.id !== excludeId)) {
    slug = `${base}-${++n}`.slice(0, 80);
  }
  return slug;
};
const now = () => new Date().toISOString();

function normalizeImages(images = []) {
  return (Array.isArray(images) ? images : []).map((image, index) => ({
    id: image.id || id('img'),
    url: String(image.url || image).trim(),
    alt: String(image.alt || ''),
    position: Number.isFinite(image.position) ? image.position : index,
    primary: image.primary === true || index === 0,
  })).filter(image => image.url);
}

function normalizeVariants(variants = [], baseSku = '') {
  const seen = new Set();
  return (Array.isArray(variants) ? variants : []).map((variant, index) => {
    const sku = String(variant.sku || `${baseSku}-${index + 1}`).trim();
    assert(sku, 'VARIANT_SKU_REQUIRED', 'Укажите SKU вариации');
    assert(!seen.has(sku), 'VARIANT_SKU_DUPLICATE', `SKU вариации ${sku} повторяется`);
    seen.add(sku);
    const images = normalizeImages(
      Array.isArray(variant.images) && variant.images.length
        ? variant.images
        : variant.imageUrl
          ? [{ url: variant.imageUrl, alt: String(variant.name || '') }]
          : [],
    );
    return {
      id: variant.id || id('var'),
      name: String(variant.name || `Вкус ${index + 1}`).trim(),
      sku,
      barcode: String(variant.barcode || ''),
      price: money(variant.price),
      compareAtPrice: variant.compareAtPrice == null ? null : money(variant.compareAtPrice),
      stock: integer(variant.stock),
      active: variant.active !== false,
      imageUrl: String(variant.imageUrl || images[0]?.url || ''),
      images,
      attributes: variant.attributes && typeof variant.attributes === 'object' ? variant.attributes : {},
    };
  });
}

function descendantCategoryIds(categories, rootId) {
  const ids = new Set([String(rootId)]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const category of categories) {
      if (category.parentId && ids.has(category.parentId) && !ids.has(category.id)) {
        ids.add(category.id);
        grew = true;
      }
    }
  }
  return ids;
}

export class CatalogService {
  constructor(store, tenancy, media = null) {
    this.store = store;
    this.tenancy = tenancy;
    this.media = media;
  }

  async localizeProductInput(input = {}, options = {}) {
    if (!this.media) return input;
    return this.media.localizeProductInput(input, options);
  }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const ctx = this.tenancy.context(userId, workspaceId, role);
    const shop = ctx.state.shops.find(item => item.id === shopId && item.workspaceId === workspaceId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return ctx;
  }

  categories(userId, workspaceId, shopId) {
    return this.ensureShop(userId, workspaceId, shopId).state.categories
      .filter(category => category.shopId === shopId)
      .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name, 'ru'));
  }

  categoryTree(userId, workspaceId, shopId) {
    const categories = this.categories(userId, workspaceId, shopId);
    const nodes = new Map(categories.map(category => [category.id, { ...category, children: [] }]));
    const roots = [];
    for (const node of nodes.values()) {
      if (node.parentId && nodes.has(node.parentId)) nodes.get(node.parentId).children.push(node);
      else roots.push(node);
    }
    return roots;
  }

  products(userId, workspaceId, shopId, filters = {}) {
    const state = this.ensureShop(userId, workspaceId, shopId).state;
    const query = String(filters.query || '').trim().toLowerCase();
    const categoryId = String(filters.categoryId || '');
    const status = String(filters.status || 'all');
    const categoryIds = categoryId
      ? descendantCategoryIds(state.categories.filter((item) => item.shopId === shopId), categoryId)
      : null;
    return state.products
      .filter(product => product.shopId === shopId)
      .filter(product => !query || `${product.name} ${product.sku} ${product.brand || ''}`.toLowerCase().includes(query))
      .filter(product => !categoryIds || (product.categoryId && categoryIds.has(product.categoryId)))
      .filter(product => status === 'all' || (status === 'active' ? product.active : !product.active))
      .map(product => ({ ...product, totalStock: product.variants?.length ? product.variants.reduce((sum, item) => sum + item.stock, 0) : product.stock }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  product(userId, workspaceId, shopId, productId) {
    const product = this.ensureShop(userId, workspaceId, shopId).state.products.find(item => item.id === productId && item.shopId === shopId);
    assert(product, 'PRODUCT_NOT_FOUND', 'Товар не найден', 404);
    return product;
  }

  categoryDepth(shopCategories, categoryId) {
    // 0 = root, 1 = подкатегория, 2 = линейка/вариант
    let depth = 0;
    let cur = categoryId;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const node = shopCategories.find((item) => item.id === cur);
      if (!node?.parentId) break;
      depth += 1;
      cur = node.parentId;
      if (depth > 8) break;
    }
    return depth;
  }

  async resolveCategoryImage(url) {
    const raw = String(url || '').trim();
    if (!raw) return '';
    if (!this.media?.ingestUrl) return raw;
    return this.media.ingestUrl(raw);
  }

  async createCategory(userId, workspaceId, shopId, input, options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const name = String(input.name || '').trim();
    assert(name, 'CATEGORY_NAME_REQUIRED', 'Укажите название категории');
    const imageUrl = await this.resolveCategoryImage(input.imageUrl);
    return this.store.transaction(userId, db => {
      const shopCategories = db.categories.filter((category) => category.shopId === shopId);
      if (input.parentId) {
        const parent = shopCategories.find((category) => category.id === input.parentId);
        assert(parent, 'PARENT_NOT_FOUND', 'Родительская категория не найдена');
        assert(
          this.categoryDepth(shopCategories, parent.id) < 2,
          'CATEGORY_DEPTH',
          'Максимум 3 уровня: раздел → подкатегория → линейка (страна/формат)',
        );
      }
      const slug = uniqueCategorySlug(shopCategories, input.slug || name);
      const productDisplay =
        String(input.productDisplay || '').trim() === 'flavors' ? 'flavors' : 'photos';
      const category = {
        id: id('cat'),
        shopId,
        parentId: input.parentId || null,
        name,
        slug,
        description: String(input.description || ''),
        imageUrl,
        productDisplay,
        position: Number.isFinite(Number(input.position)) ? Number(input.position) : shopCategories.length,
        active: input.active !== false,
        createdAt: now(),
        updatedAt: now(),
      };
      db.categories.push(category);
      return category;
    }, { backup: options.backup !== false });
  }

  async updateCategory(userId, workspaceId, shopId, categoryId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const hasImage = Object.prototype.hasOwnProperty.call(input, 'imageUrl');
    const imageUrl = hasImage ? await this.resolveCategoryImage(input.imageUrl) : undefined;
    return this.store.transaction(userId, db => {
      const category = db.categories.find(item => item.id === categoryId && item.shopId === shopId);
      assert(category, 'CATEGORY_NOT_FOUND', 'Категория не найдена', 404);
      if (input.parentId) {
        assert(input.parentId !== categoryId, 'CATEGORY_CYCLE', 'Категория не может быть родителем самой себя');
        const shopCategories = db.categories.filter((item) => item.shopId === shopId);
        const parent = shopCategories.find((item) => item.id === input.parentId);
        assert(parent, 'PARENT_NOT_FOUND', 'Родительская категория не найдена');
        assert(
          !descendantCategoryIds(shopCategories, categoryId).has(String(input.parentId)),
          'CATEGORY_CYCLE',
          'Нельзя перенести категорию внутрь собственного потомка',
        );
        assert(
          this.categoryDepth(shopCategories, parent.id) < 2,
          'CATEGORY_DEPTH',
          'Максимум 3 уровня: раздел → подкатегория → линейка (страна/формат)',
        );
      }
      const shopCategories = db.categories.filter((item) => item.shopId === shopId);
      const slug =
        input.slug == null
          ? category.slug
          : uniqueCategorySlug(shopCategories, input.slug, categoryId);
      const next = { ...input, slug, updatedAt: now() };
      if (hasImage) next.imageUrl = imageUrl;
      if (Object.prototype.hasOwnProperty.call(input, 'productDisplay')) {
        next.productDisplay =
          String(input.productDisplay || '').trim() === 'flavors' ? 'flavors' : 'photos';
      }
      Object.assign(category, next);
      if(Object.prototype.hasOwnProperty.call(input,'parentId') && !input.parentId) category.parentId=null;
      return category;
    });
  }

  async deleteCategory(userId, workspaceId, shopId, categoryId, options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const cascade = options.cascade === true;
    return this.store.transaction(userId, db => {
      const category = db.categories.find(item => item.id === categoryId && item.shopId === shopId);
      assert(category, 'CATEGORY_NOT_FOUND', 'Категория не найдена', 404);
      if (!cascade) {
        assert(!db.categories.some(item => item.parentId === categoryId), 'CATEGORY_HAS_CHILDREN', 'Сначала удалите вложенные категории');
        assert(!db.products.some(item => item.categoryId === categoryId), 'CATEGORY_IN_USE', 'Категория используется товарами');
        const index = db.categories.findIndex(item => item.id === categoryId && item.shopId === shopId);
        return db.categories.splice(index, 1)[0];
      }
      const shopCategories = db.categories.filter(item => item.shopId === shopId);
      const idsToDelete = descendantCategoryIds(shopCategories, categoryId);
      let unlinkedProducts = 0;
      const ts = now();
      for (const product of db.products) {
        if (product.shopId === shopId && product.categoryId && idsToDelete.has(product.categoryId)) {
          product.categoryId = null;
          product.updatedAt = ts;
          unlinkedProducts += 1;
        }
      }
      const deletedIds = [];
      const remaining = new Set(idsToDelete);
      while (remaining.size > 0) {
        let removed = false;
        for (const catId of [...remaining]) {
          const hasChildInSet = shopCategories.some(item => item.parentId === catId && remaining.has(item.id));
          if (hasChildInSet) continue;
          const index = db.categories.findIndex(item => item.id === catId && item.shopId === shopId);
          if (index >= 0) db.categories.splice(index, 1)[0];
          deletedIds.push(catId);
          remaining.delete(catId);
          removed = true;
        }
        assert(removed, 'CATEGORY_DELETE_FAILED', 'Не удалось удалить категории');
      }
      return { ...category, deletedIds, unlinkedProducts };
    });
  }

  async createProduct(userId, workspaceId, shopId, input, options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    if (options.localize !== false) input = await this.localizeProductInput(input);
    const name = String(input.name || '').trim();
    const sku = String(input.sku || '').trim();
    assert(name, 'PRODUCT_NAME_REQUIRED', 'Укажите название товара');
    assert(sku, 'SKU_REQUIRED', 'Укажите SKU');
    return this.store.transaction(userId, db => {
      assert(!db.products.some(product => product.shopId === shopId && product.sku === sku), 'SKU_EXISTS', 'SKU уже используется');
      if (input.categoryId) assert(db.categories.some(category => category.id === input.categoryId && category.shopId === shopId), 'CATEGORY_NOT_FOUND', 'Категория не найдена');
      const variants = normalizeVariants(input.variants, sku);
      for (const variant of variants) assert(!db.products.some(product => product.shopId === shopId && (product.sku === variant.sku || product.variants?.some(item => item.sku === variant.sku))), 'SKU_EXISTS', `SKU ${variant.sku} уже используется`);
      const product = {
        id: id('prd'), shopId, categoryId: input.categoryId || null, name, sku,
        brand: String(input.brand || ''), description: String(input.description || ''),
        price: money(input.price), compareAtPrice: input.compareAtPrice == null ? null : money(input.compareAtPrice),
        stock: integer(input.stock), active: input.active !== false, archived: false,
        tags: Array.isArray(input.tags) ? input.tags.map(String) : [], images: normalizeImages(input.images), variants,
        createdAt: now(), updatedAt: now(), version: 1,
      };
      db.products.push(product);
      return product;
    });
  }

  async updateProduct(userId, workspaceId, shopId, productId, input, options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    if (options.localize !== false) input = await this.localizeProductInput(input);
    return this.store.transaction(userId, db => {
      const product = db.products.find(item => item.id === productId && item.shopId === shopId);
      assert(product, 'PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      const sku = input.sku == null ? product.sku : String(input.sku).trim();
      assert(!db.products.some(item => item.shopId === shopId && item.id !== productId && item.sku === sku), 'SKU_EXISTS', 'SKU уже используется');
      if (input.categoryId) assert(db.categories.some(category => category.id === input.categoryId && category.shopId === shopId), 'CATEGORY_NOT_FOUND', 'Категория не найдена');
      const variants = input.variants == null ? product.variants : normalizeVariants(input.variants, sku);
      Object.assign(product, {
        ...input, sku,
        price: input.price == null ? product.price : money(input.price),
        compareAtPrice: input.compareAtPrice === undefined ? product.compareAtPrice : input.compareAtPrice == null ? null : money(input.compareAtPrice),
        stock: input.stock == null ? product.stock : integer(input.stock),
        images: input.images == null ? product.images : normalizeImages(input.images),
        variants, tags: input.tags == null ? product.tags : input.tags.map(String),
        updatedAt: now(), version: (product.version || 1) + 1,
      });
      return product;
    }, { backup: options.backup !== false });
  }

  /**
   * Fast path for Excel/CSV import: many creates/updates in one DB write.
   * items: [{ mode:'create'|'update', productId?, input }]
   */
  async upsertProductsBulk(userId, workspaceId, shopId, items = [], options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const list = Array.isArray(items) ? items : [];
    if (!list.length) return { imported: [], updated: [], errors: [] };

    const prepared = new Array(list.length);
    const cache = options.mediaCache || new Map();
    let cursor = 0, completed = 0;
    const worker = async () => {
      while (cursor < list.length) {
        const index = cursor++, item = list[index];
        try {
          let input = { ...(item.input || {}) };
          const hasMedia = input.imageUrl || input.images?.length ||
            (input.variants || []).some(v => v.imageUrl || v.images?.length);
          if (options.localize !== false && hasMedia) input = await this.localizeProductInput(input, { cache });
          prepared[index] = { ...item, input, ok: true };
        } catch (error) {
          prepared[index] = { ...item, ok: false,
            error: { sku: item.input?.sku, message: error.message, code: error.code || 'IMPORT_LOCALIZE_ERROR', status: error.status } };
        }
        completed++;
        options.onProgress?.({ stage: 'media', prepared: completed, total: list.length });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, list.length) }, worker));
    const failure = prepared.find(item => !item.ok);
    if (failure && options.skipInvalid !== true) {
      throw new AppError(failure.error.code, `Фото для SKU ${failure.error.sku}: ${failure.error.message}`,
        failure.error.status || 422, [failure.error]);
    }

    return this.store.transaction(userId, (db) => {
      const imported = [];
      const updated = [];
      const errors = [];
      const shopProducts = () => db.products.filter((p) => p.shopId === shopId);
      const skuTaken = (sku, excludeId = null) =>
        shopProducts().some(
          (p) =>
            p.id !== excludeId &&
            (p.sku === sku || p.variants?.some((v) => v.sku === sku)),
        );

      for (const item of prepared) {
        if (!item.ok) {
          errors.push(item.error);
          continue;
        }
        try {
          const input = item.input || {};
          const name = String(input.name || '').trim();
          const sku = String(input.sku || '').trim();
          assert(name, 'PRODUCT_NAME_REQUIRED', 'Укажите название товара');
          assert(sku, 'SKU_REQUIRED', 'Укажите SKU');
          if (input.categoryId) {
            assert(
              db.categories.some((c) => c.id === input.categoryId && c.shopId === shopId),
              'CATEGORY_NOT_FOUND',
              'Категория не найдена',
            );
          }

          if (item.mode === 'update' && item.productId) {
            const product = db.products.find(
              (p) => p.id === item.productId && p.shopId === shopId,
            );
            assert(product, 'PRODUCT_NOT_FOUND', 'Товар не найден', 404);
            assert(!skuTaken(sku, product.id), 'SKU_EXISTS', 'SKU уже используется');
            const variants =
              input.variants == null
                ? product.variants
                : normalizeVariants(input.variants.map(v => {
                    const old = product.variants?.find(item => item.sku === v.sku);
                    return { ...v, id: v.id || old?.id,
                      imageUrl: v.imageUrl === undefined ? old?.imageUrl : v.imageUrl,
                      images: v.images === undefined && v.imageUrl === undefined ? old?.images : v.images };
                  }), sku);
            for (const variant of variants || []) {
              assert(
                !shopProducts().some(
                  (p) =>
                    p.id !== product.id &&
                    (p.sku === variant.sku ||
                      p.variants?.some((v) => v.sku === variant.sku)),
                ),
                'SKU_EXISTS',
                `SKU ${variant.sku} уже используется`,
              );
            }
            Object.assign(product, {
              ...input,
              sku,
              name: input.name == null ? product.name : name,
              price: input.price == null ? product.price : money(input.price),
              compareAtPrice:
                input.compareAtPrice === undefined
                  ? product.compareAtPrice
                  : input.compareAtPrice == null
                    ? null
                    : money(input.compareAtPrice),
              stock: input.stock == null ? product.stock : integer(input.stock),
              images:
                input.images == null ? product.images : normalizeImages(input.images),
              variants,
              tags: input.tags == null ? product.tags : input.tags.map(String),
              updatedAt: now(),
              version: (product.version || 1) + 1,
            });
            updated.push(product);
          } else {
            assert(!skuTaken(sku), 'SKU_EXISTS', 'SKU уже используется');
            const variants = normalizeVariants(input.variants, sku);
            for (const variant of variants) {
              assert(!skuTaken(variant.sku), 'SKU_EXISTS', `SKU ${variant.sku} уже используется`);
            }
            const product = {
              id: id('prd'),
              shopId,
              categoryId: input.categoryId || null,
              name,
              sku,
              brand: String(input.brand || ''),
              description: String(input.description || ''),
              price: money(input.price),
              compareAtPrice:
                input.compareAtPrice == null ? null : money(input.compareAtPrice),
              stock: integer(input.stock),
              active: input.active !== false,
              archived: false,
              tags: Array.isArray(input.tags) ? input.tags.map(String) : [],
              images: normalizeImages(input.images),
              variants,
              createdAt: now(),
              updatedAt: now(),
              version: 1,
            };
            db.products.push(product);
            imported.push(product);
          }
        } catch (error) {
          if (options.skipInvalid !== true) throw error;
          errors.push({
            sku: item.input?.sku,
            message: error.message,
            code: error.code || 'IMPORT_ERROR',
          });
        }
      }
      return { imported, updated, errors };
    }, { backup: options.backup !== false });
  }

  async deleteProduct(userId, workspaceId, shopId, productId) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, db => {
      const index = db.products.findIndex(item => item.id === productId && item.shopId === shopId);
      assert(index >= 0, 'PRODUCT_NOT_FOUND', 'Товар не найден', 404);
      return db.products.splice(index, 1)[0];
    });
  }

  async bulkUpdate(userId, workspaceId, shopId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const ids = Array.isArray(input.ids) ? input.ids : [];
    assert(ids.length, 'PRODUCT_IDS_REQUIRED', 'Выберите товары');
    return this.store.transaction(userId, db => {
      const products = db.products.filter(product => product.shopId === shopId && ids.includes(product.id));
      assert(products.length === ids.length, 'PRODUCT_NOT_FOUND', 'Часть товаров не найдена', 404);
      for (const product of products) {
        if (input.active != null) product.active = Boolean(input.active);
        if (input.categoryId !== undefined) product.categoryId = input.categoryId || null;
        if (input.stockDelta != null && !product.variants?.length) product.stock = integer(product.stock + Number(input.stockDelta));
        product.updatedAt = now(); product.version = (product.version || 1) + 1;
      }
      return products;
    });
  }

  importPreview(userId, workspaceId, shopId, rows = []) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const categories = this.categories(userId, workspaceId, shopId);
    const categoryByName = new Map(categories.map(category => [category.name.toLowerCase(), category.id]));
    const existingSkus = new Set(
      (this.store.snapshot().products || [])
        .filter((product) => product.shopId === shopId)
        .map((product) => String(product.sku || '').trim().toLowerCase())
        .filter(Boolean),
    );
    const errors = []; const warnings = []; const normalized = [];
    rows.forEach((row, index) => {
      const line = index + 2; const name = String(row.name || row['Название'] || '').trim(); const sku = String(row.sku || row['SKU'] || '').trim();
      if (!name) errors.push({ line, field: 'name', message: 'Не указано название' });
      if (!sku) errors.push({ line, field: 'sku', message: 'Не указан SKU' });
      for (const [field, label] of [['price', 'цена'], ['stock', 'остаток']]) {
        const value = row[field] ?? row[field === 'price' ? 'Цена' : 'Остаток'] ?? 0;
        if (!Number.isFinite(Number(value)) || Number(value) < 0) errors.push({ line, field, message: `Некорректный ${label}` });
      }
      const categoryName = String(row.category || row['Категория'] || '').trim();
      if (categoryName && !categoryByName.has(categoryName.toLowerCase())) warnings.push({ line, field: 'category', message: `Категория «${categoryName}» будет создана` });
      const willUpdate = Boolean(sku && existingSkus.has(sku.toLowerCase()));
      if (willUpdate) {
        warnings.push({
          line,
          field: 'sku',
          message: `SKU «${sku}» будет обновлён`,
        });
      }
      normalized.push({ name, sku, brand: row.brand || row['Бренд'] || '', categoryName, price: money(row.price || row['Цена']), stock: integer(row.stock || row['Остаток']), description: row.description || row['Описание'] || '', willUpdate });
    });
    return { valid: errors.length === 0, total: rows.length, errors, warnings, rows: normalized.slice(0, 2000) };
  }
}
