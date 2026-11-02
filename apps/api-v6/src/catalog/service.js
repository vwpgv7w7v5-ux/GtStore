import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const money = value => Math.round(Number(value || 0) * 100) / 100;
const integer = value => Math.max(0, Math.trunc(Number(value || 0)));
const slugify = value => String(value || '').trim().toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '');
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
    return {
      id: variant.id || id('var'),
      name: String(variant.name || `Вариация ${index + 1}`).trim(),
      sku,
      barcode: String(variant.barcode || ''),
      price: money(variant.price),
      compareAtPrice: variant.compareAtPrice == null ? null : money(variant.compareAtPrice),
      stock: integer(variant.stock),
      active: variant.active !== false,
      attributes: variant.attributes && typeof variant.attributes === 'object' ? variant.attributes : {},
    };
  });
}

export class CatalogService {
  constructor(store, tenancy) { this.store = store; this.tenancy = tenancy; }

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
    return state.products
      .filter(product => product.shopId === shopId)
      .filter(product => !query || `${product.name} ${product.sku} ${product.brand || ''}`.toLowerCase().includes(query))
      .filter(product => !categoryId || product.categoryId === categoryId)
      .filter(product => status === 'all' || (status === 'active' ? product.active : !product.active))
      .map(product => ({ ...product, totalStock: product.variants?.length ? product.variants.reduce((sum, item) => sum + item.stock, 0) : product.stock }))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  product(userId, workspaceId, shopId, productId) {
    const product = this.ensureShop(userId, workspaceId, shopId).state.products.find(item => item.id === productId && item.shopId === shopId);
    assert(product, 'PRODUCT_NOT_FOUND', 'Товар не найден', 404);
    return product;
  }

  async createCategory(userId, workspaceId, shopId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const name = String(input.name || '').trim();
    assert(name, 'CATEGORY_NAME_REQUIRED', 'Укажите название категории');
    return this.store.transaction(userId, db => {
      if (input.parentId) assert(db.categories.some(category => category.id === input.parentId && category.shopId === shopId), 'PARENT_NOT_FOUND', 'Родительская категория не найдена');
      const slug = slugify(input.slug || name);
      assert(!db.categories.some(category => category.shopId === shopId && category.slug === slug), 'CATEGORY_SLUG_EXISTS', 'Категория с таким адресом уже существует');
      const category = { id: id('cat'), shopId, parentId: input.parentId || null, name, slug, description: String(input.description || ''), position: Number.isFinite(Number(input.position)) ? Number(input.position) : db.categories.filter(category => category.shopId === shopId).length, active: input.active !== false, createdAt: now(), updatedAt: now() };
      db.categories.push(category);
      return category;
    });
  }

  async updateCategory(userId, workspaceId, shopId, categoryId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, db => {
      const category = db.categories.find(item => item.id === categoryId && item.shopId === shopId);
      assert(category, 'CATEGORY_NOT_FOUND', 'Категория не найдена', 404);
      if (input.parentId) {
        assert(input.parentId !== categoryId, 'CATEGORY_CYCLE', 'Категория не может быть родителем самой себя');
        assert(db.categories.some(item => item.id === input.parentId && item.shopId === shopId), 'PARENT_NOT_FOUND', 'Родительская категория не найдена');
      }
      const slug = input.slug == null ? category.slug : slugify(input.slug);
      assert(!db.categories.some(item => item.shopId === shopId && item.id !== categoryId && item.slug === slug), 'CATEGORY_SLUG_EXISTS', 'Категория с таким адресом уже существует');
      Object.assign(category, { ...input, slug, updatedAt: now() });
      return category;
    });
  }

  async deleteCategory(userId, workspaceId, shopId, categoryId) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, db => {
      const index = db.categories.findIndex(item => item.id === categoryId && item.shopId === shopId);
      assert(index >= 0, 'CATEGORY_NOT_FOUND', 'Категория не найдена', 404);
      assert(!db.categories.some(item => item.parentId === categoryId), 'CATEGORY_HAS_CHILDREN', 'Сначала удалите вложенные категории');
      assert(!db.products.some(item => item.categoryId === categoryId), 'CATEGORY_IN_USE', 'Категория используется товарами');
      return db.categories.splice(index, 1)[0];
    });
  }

  async createProduct(userId, workspaceId, shopId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
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

  async updateProduct(userId, workspaceId, shopId, productId, input) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
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
    });
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
    const errors = []; const warnings = []; const normalized = [];
    rows.forEach((row, index) => {
      const line = index + 2; const name = String(row.name || row['Название'] || '').trim(); const sku = String(row.sku || row['SKU'] || '').trim();
      if (!name) errors.push({ line, field: 'name', message: 'Не указано название' });
      if (!sku) errors.push({ line, field: 'sku', message: 'Не указан SKU' });
      const categoryName = String(row.category || row['Категория'] || '').trim();
      if (categoryName && !categoryByName.has(categoryName.toLowerCase())) warnings.push({ line, field: 'category', message: `Категория «${categoryName}» будет создана` });
      normalized.push({ name, sku, brand: row.brand || row['Бренд'] || '', categoryName, price: money(row.price || row['Цена']), stock: integer(row.stock || row['Остаток']), description: row.description || row['Описание'] || '' });
    });
    return { valid: errors.length === 0, total: rows.length, errors, warnings, rows: normalized.slice(0, 100) };
  }

  // A catalogue import is one durable write, rather than one whole-file rewrite per row.
  async importBatch(userId, workspaceId, shopId, inputs, categories = [], options = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, db => {
      const categoryIndex = new Map(db.categories.filter(c => c.shopId === shopId)
        .map(c => [`${c.parentId || ''}:${c.name.trim().toLowerCase()}`, c]));
      const slugs = new Set(db.categories.filter(c => c.shopId === shopId).map(c => c.slug));
      let createdCategories = 0;
      const ensureCategory = (value, parent = null) => {
        const name = String(value || '').trim();
        if (!name) return parent;
        const key = `${parent?.id || ''}:${name.toLowerCase()}`;
        if (categoryIndex.has(key)) return categoryIndex.get(key);
        const base = slugify(parent ? `${parent.slug}-${name}` : name) || 'category';
        let slug = base;
        for (let suffix = 2; slugs.has(slug); suffix++) slug = `${base}-${suffix}`;
        const category = { id: id('cat'), shopId, parentId: parent?.id || null, name, slug,
          description: '', position: db.categories.filter(c => c.shopId === shopId).length,
          active: true, createdAt: now(), updatedAt: now() };
        db.categories.push(category);
        slugs.add(slug);
        categoryIndex.set(key, category);
        createdCategories++;
        return category;
      };
      for (const entry of categories) {
        const parent = ensureCategory(entry.name);
        if (entry.childName) ensureCategory(entry.childName, parent);
      }
      const existingBySku = new Map();
      const skuOwners = new Map();
      for (const product of db.products.filter(p => p.shopId === shopId)) {
        existingBySku.set(product.sku, product);
        skuOwners.set(product.sku, product.id);
        for (const variant of product.variants || []) skuOwners.set(variant.sku, product.id);
      }
      const products = [], errors = [];
      let created = 0, updated = 0;
      for (const input of inputs) {
        try {
          const name = String(input.name || '').trim(), sku = String(input.sku || '').trim();
          assert(name, 'PRODUCT_NAME_REQUIRED', 'Укажите название товара');
          assert(sku, 'SKU_REQUIRED', 'Укажите SKU');
          assert(Number.isFinite(Number(input.price)) && Number(input.price) >= 0, 'IMPORT_PRICE_INVALID', 'Некорректная цена');
          assert(Number.isFinite(Number(input.stock)) && Number(input.stock) >= 0, 'IMPORT_STOCK_INVALID', 'Некорректный остаток');
          const existing = existingBySku.get(sku);
          assert(!existing || options.updateExisting !== false, 'SKU_EXISTS', `SKU ${sku} уже используется`);
          assert(!skuOwners.has(sku) || skuOwners.get(sku) === existing?.id, 'SKU_EXISTS', `SKU ${sku} уже используется вариацией`);
          const variants = normalizeVariants((input.variants || []).map(v => ({ ...v,
            id: existing?.variants?.find(old => old.sku === v.sku)?.id })), sku);
          for (const variant of variants) {
            assert(variant.sku !== sku && (!skuOwners.has(variant.sku) || skuOwners.get(variant.sku) === existing?.id),
              'SKU_EXISTS', `SKU ${variant.sku} уже используется`);
            assert(Number.isFinite(variant.price) && Number.isFinite(variant.stock), 'IMPORT_VARIANT_INVALID', 'Некорректная цена или остаток вариации');
          }
          const parent = ensureCategory(input.category);
          const category = input.subcategory ? ensureCategory(input.subcategory, parent) : parent;
          const data = { name, sku, categoryId: category?.id || null,
            price: money(input.price), stock: integer(input.stock), brand: String(input.brand || ''),
            description: String(input.description || ''),
            images: input.images === undefined && existing ? existing.images : normalizeImages(input.images), variants,
            active: input.active !== false, updatedAt: now() };
          let product;
          if (existing) {
            for (const old of existing.variants || []) if (skuOwners.get(old.sku) === existing.id) skuOwners.delete(old.sku);
            Object.assign(existing, data, { version: (existing.version || 1) + 1 });
            product = existing;
            updated++;
          } else {
            product = { id: id('prd'), shopId, ...data, compareAtPrice: null, archived: false, tags: [], createdAt: now(), version: 1 };
            db.products.push(product);
            existingBySku.set(sku, product);
            created++;
          }
          skuOwners.set(sku, product.id);
          for (const variant of variants) skuOwners.set(variant.sku, product.id);
          products.push(product);
        } catch (error) {
          if (!options.skipInvalid) throw error;
          errors.push({ sku: String(input.sku || ''), code: error.code || 'IMPORT_ERROR', message: error.message });
        }
      }
      return { imported: products.length, created, updated, failed: errors.length, createdCategories, products, errors };
    });
  }
}
