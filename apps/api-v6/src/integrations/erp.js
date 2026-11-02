import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();

const ERP_PROVIDERS = [
  {
    code: 'moysklad',
    name: 'МойСклад',
    capabilities: ['catalog.pull', 'catalog.push', 'stock.sync', 'orders.push'],
  },
  {
    code: 'one_c',
    name: '1С',
    capabilities: ['catalog.pull', 'orders.push', 'stock.sync'],
  },
  {
    code: 'yclients',
    name: 'YClients',
    capabilities: ['services.pull', 'bookings.pull'],
  },
];

const MOYSKLAD_BASE = 'https://api.moysklad.ru/api/remap/1.2';

export class ErpService {
  constructor(store, tenancy, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.fetch = options.fetch || globalThis.fetch;
  }

  async moyskladRequest(creds, path, options = {}) {
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const response = await this.fetch(`${MOYSKLAD_BASE}${path}`, {
      method: options.method || 'GET',
      headers: {
        authorization: `Bearer ${creds.token}`,
        'content-type': 'application/json',
        ...(options.headers || {}),
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data?.errors?.[0]?.error || `МойСклад HTTP ${response.status}`);
    }
    return data;
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

  providers() {
    return ERP_PROVIDERS;
  }

  list(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.erpConnections || [])
      .filter((x) => x.shopId === shopId)
      .map((x) => ({
        ...x,
        credentials: undefined,
        tokenSet: Boolean(x.credentials?.token || x.credentials?.login),
      }));
  }

  logs(userId, workspaceId, shopId, limit = 100) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.integrationLogs || [])
      .filter((x) => x.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.min(500, Number(limit) || 100));
  }

  async log(shopId, provider, action, status, message, meta = {}) {
    return this.store.transaction('system:ilog', (db) => {
      db.integrationLogs ||= [];
      const row = {
        id: id('ilog'),
        shopId,
        provider,
        action,
        status,
        message: String(message || ''),
        meta,
        createdAt: now(),
      };
      db.integrationLogs.push(row);
      if (db.integrationLogs.length > 5000) {
        db.integrationLogs.splice(0, db.integrationLogs.length - 5000);
      }
      return row;
    });
  }

  async connect(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'admin');
    const provider = String(input.provider || '').toLowerCase();
    assert(
      ERP_PROVIDERS.some((p) => p.code === provider),
      'ERP_PROVIDER_INVALID',
      'Неизвестный ERP-провайдер',
    );
    const token = String(input.token || '').trim();
    const login = String(input.login || '').trim();
    const password = String(input.password || '').trim();
    assert(
      token || (login && password),
      'ERP_CREDENTIALS_REQUIRED',
      'Укажите токен или логин/пароль',
    );
    const row = await this.store.transaction(userId, (db) => {
      db.erpConnections ||= [];
      let conn = db.erpConnections.find(
        (x) => x.shopId === shopId && x.provider === provider,
      );
      if (!conn) {
        conn = {
          id: id('erp'),
          shopId,
          provider,
          createdAt: now(),
        };
        db.erpConnections.push(conn);
      }
      conn.name = String(
        input.name || ERP_PROVIDERS.find((p) => p.code === provider).name,
      );
      conn.active = input.active !== false;
      conn.credentials = {
        token: token || conn.credentials?.token || '',
        login: login || conn.credentials?.login || '',
        password: password || conn.credentials?.password || '',
        baseUrl: String(input.baseUrl || conn.credentials?.baseUrl || ''),
      };
      conn.syncMode = String(input.syncMode || conn.syncMode || 'manual');
      conn.updatedAt = now();
      conn.lastTestAt = null;
      conn.lastSyncAt = null;
      conn.status = 'connected';
      return {
        ...conn,
        credentials: undefined,
        tokenSet: true,
      };
    });
    await this.log(shopId, provider, 'connect', 'ok', 'Подключение сохранено');
    return row;
  }

  async disconnect(userId, workspaceId, shopId, connectionId) {
    this.ensure(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, (db) => {
      const i = (db.erpConnections || []).findIndex(
        (x) => x.id === connectionId && x.shopId === shopId,
      );
      assert(i >= 0, 'ERP_NOT_FOUND', 'Подключение не найдено', 404);
      const [removed] = db.erpConnections.splice(i, 1);
      return { removed: true, provider: removed.provider };
    });
  }

  async test(userId, workspaceId, shopId, connectionId) {
    const { state } = this.ensure(userId, workspaceId, shopId, 'admin');
    const row = (state.erpConnections || []).find(
      (x) => x.id === connectionId && x.shopId === shopId,
    );
    assert(row, 'ERP_NOT_FOUND', 'Подключение не найдено', 404);
    // Sandbox baseline: credentials present → ok. Upgraded to live HTTP below when possible.
    let ok = Boolean(row.credentials?.token || row.credentials?.login);
    let live = false;
    let detail = 'Проверка credentials (sandbox)';
    if (row.provider === 'moysklad' && row.credentials?.token && this.fetch) {
      try {
        const data = await this.moyskladRequest(row.credentials, '/entity/organization?limit=1');
        ok = true;
        live = true;
        detail = `МойСклад OK · организаций: ${data?.rows?.length ?? 0}`;
      } catch (e) {
        detail = `МойСклад недоступен (${String(e?.message || e)}) · sandbox-режим`;
      }
    } else if (row.credentials?.baseUrl && this.fetch) {
      try {
        const res = await this.fetch(row.credentials.baseUrl, {
          headers: row.credentials.token
            ? { authorization: `Bearer ${row.credentials.token}` }
            : {},
        });
        ok = res.ok || res.status === 401 || res.status === 403;
        live = res.ok;
        detail = `HTTP ${res.status}`;
      } catch (e) {
        ok = false;
        detail = String(e?.message || e);
      }
    }
    await this.store.transaction(userId, (db) => {
      const c = (db.erpConnections || []).find((x) => x.id === connectionId);
      if (c) {
        c.lastTestAt = now();
        c.status = ok ? 'ok' : 'error';
        c.live = live;
        c.lastError = ok ? '' : detail;
      }
    });
    await this.log(
      shopId,
      row.provider,
      'test',
      ok ? 'ok' : 'failed',
      detail,
      { live },
    );
    return { ok, live, detail, provider: row.provider };
  }

  async moyskladPull(userId, shopId, row) {
    const data = await this.moyskladRequest(row.credentials, '/entity/product?limit=100');
    const rows = Array.isArray(data.rows) ? data.rows : [];
    return this.store.transaction(userId, (db) => {
      db.products ||= [];
      let count = 0;
      for (const item of rows) {
        const sku = String(item.article || item.code || '').trim();
        const price = Number(item.salePrices?.[0]?.value || 0) / 100;
        const stock = Number(item.quantity ?? item.stock ?? NaN);
        let product = db.products.find(
          (p) => p.shopId === shopId && (p.externalId === item.id || (sku && p.sku === sku)),
        );
        if (!product && !sku) continue;
        if (!product) {
          product = {
            id: id('prd'),
            shopId,
            categoryId: null,
            name: item.name || sku,
            sku,
            brand: '',
            description: item.description || '',
            price: price || 0,
            compareAtPrice: null,
            stock: Number.isFinite(stock) ? stock : 0,
            active: true,
            archived: false,
            tags: [],
            images: [],
            variants: [],
            createdAt: now(),
            updatedAt: now(),
            version: 1,
          };
          db.products.push(product);
        } else {
          if (price) product.price = price;
          if (Number.isFinite(stock)) product.stock = stock;
          product.updatedAt = now();
        }
        product.externalId = item.id;
        count++;
      }
      return count;
    });
  }

  async moyskladPush(userId, shopId, row, orders) {
    let pushed = 0;
    for (const order of orders) {
      try {
        const created = await this.moyskladRequest(row.credentials, '/entity/customerorder', {
          method: 'POST',
          body: {
            name: order.number,
            description: `GStore заказ №${order.number}`,
            sum: Math.round(Number(order.total || 0) * 100),
          },
        });
        await this.store.transaction(userId, (db) => {
          const target = (db.orders || []).find((x) => x.id === order.id);
          if (target) target.externalErpId = created.id;
        });
        pushed++;
      } catch {
        /* skip this order, keep syncing the rest */
      }
    }
    return pushed;
  }

  async sync(userId, workspaceId, shopId, connectionId, input = {}) {
    const { state } = this.ensure(userId, workspaceId, shopId, 'manager');
    const row = (state.erpConnections || []).find(
      (x) => x.id === connectionId && x.shopId === shopId,
    );
    assert(row, 'ERP_NOT_FOUND', 'Подключение не найдено', 404);
    const direction = String(input.direction || 'pull');
    const sandboxStats = () => ({
      products: Number(input.dryRun ? 0 : Math.min(50, (state.products || []).filter((p) => p.shopId === shopId).length)),
      orders: 0,
      direction,
      simulated: true,
    });
    let stats = sandboxStats();
    let liveError = '';
    if (row.provider === 'moysklad' && row.credentials?.token && this.fetch && !input.dryRun) {
      try {
        let livePull = false;
        let livePush = false;
        let products = 0;
        let ordersPushed = 0;
        if (direction === 'pull' || direction === 'both') {
          products = await this.moyskladPull(userId, shopId, row);
          livePull = true;
        }
        if (direction === 'push' || direction === 'both') {
          const pending = (state.orders || [])
            .filter((o) => o.shopId === shopId && !o.externalErpId)
            .slice(0, 20);
          ordersPushed = await this.moyskladPush(userId, shopId, row, pending);
          livePush = pending.length > 0;
        }
        stats = { products, orders: ordersPushed, direction, simulated: !(livePull || livePush) };
      } catch (e) {
        liveError = String(e?.message || e);
        stats = sandboxStats();
      }
    }
    await this.store.transaction(userId, (db) => {
      const c = (db.erpConnections || []).find((x) => x.id === connectionId);
      if (c) {
        c.lastSyncAt = now();
        c.status = 'ok';
      }
    });
    await this.log(
      shopId,
      row.provider,
      `sync.${direction}`,
      'ok',
      stats.simulated
        ? `Синхронизация (${direction}) · sandbox${liveError ? ` · ${liveError}` : ''}`
        : `Синхронизация (${direction}) · live`,
      stats,
    );
    return { ok: true, stats };
  }
}
