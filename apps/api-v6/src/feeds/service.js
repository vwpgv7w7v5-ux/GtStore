import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const xmlEscape = (v) =>
  String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

export class FeedService {
  constructor(store, tenancy, catalog, imports, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.catalog = catalog;
    this.imports = imports;
    this.fetch = options.fetch || globalThis.fetch;
    this.publicBaseUrl = String(
      options.publicBaseUrl || process.env.PUBLIC_BASE_URL || process.env.STOREFRONT_URL || '',
    ).replace(/\/$/, '');
  }

  ensure(userId, workspaceId, shopId, role = 'viewer') {
    const c = this.tenancy.context(userId, workspaceId, role);
    assert(
      c.state.shops.some((s) => s.id === shopId && s.workspaceId === workspaceId),
      'SHOP_NOT_FOUND',
      'Магазин не найден',
      404,
    );
    return c;
  }

  list(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.feeds || []).filter((f) => f.shopId === shopId);
  }

  async create(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const name = String(input.name || 'YML каталог').trim();
    assert(name, 'FEED_NAME_REQUIRED', 'Укажите название фида');
    return this.store.transaction(userId, (db) => {
      db.feeds ||= [];
      const row = {
        id: id('feed'),
        shopId,
        name,
        type: ['yml', 'xml'].includes(input.type) ? input.type : 'yml',
        slug: String(input.slug || id('yml')).replace(/[^\w-]/g, '').slice(0, 40),
        active: input.active !== false,
        createdAt: now(),
        updatedAt: now(),
      };
      db.feeds.push(row);
      return row;
    });
  }

  async remove(userId, workspaceId, shopId, feedId) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const i = (db.feeds || []).findIndex(
        (f) => f.id === feedId && f.shopId === shopId,
      );
      assert(i >= 0, 'FEED_NOT_FOUND', 'Фид не найден', 404);
      return db.feeds.splice(i, 1)[0];
    });
  }

  exportYml(slug) {
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const categories = (state.categories || []).filter((c) => c.shopId === shop.id);
    const products = (state.products || []).filter(
      (p) => p.shopId === shop.id && p.active && !p.archived,
    );
    const catsXml = categories
      .map(
        (c) =>
          `    <category id="${xmlEscape(c.id)}">${xmlEscape(c.name)}</category>`,
      )
      .join('\n');
    const base = this.publicBaseUrl || '';
    const offers = products
      .map((p) => {
        const picture = p.images?.[0]?.url || '';
        const offerUrl = base
          ? `${base}/?shop=${encodeURIComponent(shop.slug)}&product=${encodeURIComponent(p.id)}`
          : '';
        return `    <offer id="${xmlEscape(p.id)}" available="${(p.totalStock ?? p.stock) > 0 ? 'true' : 'false'}">
      <name>${xmlEscape(p.name)}</name>
      <vendor>${xmlEscape(p.brand || '')}</vendor>
      <url>${xmlEscape(offerUrl)}</url>
      <price>${money(p.price)}</price>
      <currencyId>RUB</currencyId>
      <categoryId>${xmlEscape(p.categoryId || '')}</categoryId>
      ${picture ? `<picture>${xmlEscape(picture)}</picture>` : ''}
      <description>${xmlEscape(p.description || '')}</description>
      <barcode>${xmlEscape(p.sku || '')}</barcode>
    </offer>`;
      })
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE yml_catalog SYSTEM "shops.dtd">
<yml_catalog date="${now()}">
  <shop>
    <name>${xmlEscape(shop.name)}</name>
    <company>${xmlEscape(shop.name)}</company>
    <currencies><currency id="RUB" rate="1"/></currencies>
    <categories>
${catsXml}
    </categories>
    <offers>
${offers}
    </offers>
  </shop>
</yml_catalog>`;
    return { contentType: 'application/xml; charset=utf-8', body: xml };
  }

  parseYml(xmlText = '') {
    const offers = [];
    const re =
      /<offer\b[^>]*id="([^"]*)"[^>]*>([\s\S]*?)<\/offer>/gi;
    let m;
    while ((m = re.exec(xmlText))) {
      const block = m[2];
      const pick = (tag) => {
        const hit = block.match(
          new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'),
        );
        return hit ? hit[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/, '$1').trim() : '';
      };
      const name = pick('name') || pick('model');
      const price = money(pick('price'));
      const sku = pick('vendorCode') || pick('barcode') || m[1];
      if (!name) continue;
      offers.push({
        sku: sku || `yml-${offers.length + 1}`,
        name,
        price,
        stock: /available="false"/i.test(m[0]) ? 0 : 10,
        brand: pick('vendor'),
        description: pick('description'),
        categoryName: '',
        imageUrl: pick('picture'),
      });
    }
    return offers;
  }

  importJobs(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.importJobs || [])
      .filter((j) => j.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async scheduleImport(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const url = String(input.url || '').trim();
    assert(url.startsWith('http'), 'IMPORT_URL_INVALID', 'Укажите HTTP(S) URL фида');
    const intervalMinutes = Math.max(
      15,
      Number(input.intervalMinutes || 60) || 60,
    );
    return this.store.transaction(userId, (db) => {
      db.importJobs ||= [];
      const row = {
        id: id('ijob'),
        shopId,
        workspaceId,
        url,
        type: ['yml', 'xml', 'csv'].includes(input.type) ? input.type : 'yml',
        intervalMinutes,
        active: input.active !== false,
        lastRunAt: null,
        nextRunAt: now(),
        lastStatus: 'pending',
        lastError: '',
        lastStats: null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.importJobs.push(row);
      return row;
    });
  }

  async updateImportJob(userId, workspaceId, shopId, jobId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const row = (db.importJobs || []).find(
        (j) => j.id === jobId && j.shopId === shopId,
      );
      assert(row, 'IMPORT_JOB_NOT_FOUND', 'Задача импорта не найдена', 404);
      if (input.url !== undefined) row.url = String(input.url);
      if (input.intervalMinutes !== undefined)
        row.intervalMinutes = Math.max(15, Number(input.intervalMinutes) || 60);
      if (input.active !== undefined) row.active = Boolean(input.active);
      row.updatedAt = now();
      return row;
    });
  }

  async removeImportJob(userId, workspaceId, shopId, jobId) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const i = (db.importJobs || []).findIndex(
        (j) => j.id === jobId && j.shopId === shopId,
      );
      assert(i >= 0, 'IMPORT_JOB_NOT_FOUND', 'Задача импорта не найдена', 404);
      return db.importJobs.splice(i, 1)[0];
    });
  }

  async runImportJob(job) {
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const response = await this.fetch(job.url, {
      headers: { 'user-agent': 'GtStore-FeedImporter/6.20' },
    });
    assert(response.ok, 'IMPORT_FETCH_FAILED', `Не удалось скачать фид: HTTP ${response.status}`, 502);
    const text = await response.text();
    const rows = this.parseYml(text);
    assert(rows.length, 'IMPORT_EMPTY', 'В фиде нет товаров');
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.id === job.shopId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    // Use catalog via owner membership
    const owner = state.memberships.find(
      (m) => m.workspaceId === shop.workspaceId && m.role === 'owner',
    );
    const actor = owner?.userId || 'system:import';
    let created = 0;
    let updated = 0;
    for (const row of rows) {
      const existing = (state.products || []).find(
        (p) => p.shopId === job.shopId && p.sku === row.sku,
      );
      if (existing) {
        await this.catalog.updateProduct(
          actor,
          shop.workspaceId,
          job.shopId,
          existing.id,
          {
            name: row.name,
            price: row.price,
            stock: row.stock,
            brand: row.brand,
            description: row.description,
            active: true,
          },
        );
        updated++;
      } else {
        await this.catalog.createProduct(actor, shop.workspaceId, job.shopId, {
          name: row.name,
          sku: row.sku,
          price: row.price,
          stock: row.stock,
          brand: row.brand,
          description: row.description,
          active: true,
        });
        created++;
      }
    }
    const stats = { created, updated, total: rows.length };
    await this.store.transaction('system:import', (db) => {
      const j = (db.importJobs || []).find((x) => x.id === job.id);
      if (!j) return;
      j.lastRunAt = now();
      j.nextRunAt = new Date(
        Date.now() + j.intervalMinutes * 60_000,
      ).toISOString();
      j.lastStatus = 'ok';
      j.lastError = '';
      j.lastStats = stats;
      j.updatedAt = now();
      db.integrationLogs ||= [];
      db.integrationLogs.push({
        id: id('ilog'),
        shopId: job.shopId,
        provider: 'feed_import',
        action: 'run',
        status: 'ok',
        message: `Импорт ${stats.total} позиций`,
        meta: stats,
        createdAt: now(),
      });
    });
    return stats;
  }

  async runDue(limit = 20) {
    const state = this.store.snapshot();
    const due = (state.importJobs || [])
      .filter(
        (j) =>
          j.active !== false &&
          (!j.nextRunAt || new Date(j.nextRunAt) <= new Date()),
      )
      .slice(0, limit);
    const results = [];
    for (const job of due) {
      try {
        results.push({ id: job.id, ok: true, stats: await this.runImportJob(job) });
      } catch (e) {
        await this.store.transaction('system:import', (db) => {
          const j = (db.importJobs || []).find((x) => x.id === job.id);
          if (!j) return;
          j.lastRunAt = now();
          j.nextRunAt = new Date(
            Date.now() + j.intervalMinutes * 60_000,
          ).toISOString();
          j.lastStatus = 'failed';
          j.lastError = String(e?.message || e);
          j.updatedAt = now();
        });
        results.push({ id: job.id, ok: false, error: String(e?.message || e) });
      }
    }
    return { processed: results.length, results };
  }
}
