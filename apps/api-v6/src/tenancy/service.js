import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
import { slugify, uniqueSlug } from '../auth/service.js';

const rank = { viewer: 1, manager: 2, admin: 3, owner: 4 };

export class TenancyService {
  constructor(store) {
    this.store = store;
  }

  context(userId, workspaceId, minimumRole = 'viewer') {
    const state = this.store.snapshot();
    const membership = state.memberships.find(
      (m) => m.userId === userId && m.workspaceId === workspaceId,
    );
    assert(
      membership,
      'WORKSPACE_ACCESS_DENIED',
      'Нет доступа к рабочему пространству',
      403,
    );
    assert(
      rank[membership.role] >= rank[minimumRole],
      'PERMISSION_DENIED',
      'Недостаточно прав',
      403,
    );
    const workspace = state.workspaces.find((w) => w.id === workspaceId);
    return { membership, workspace, state };
  }

  shops(userId, workspaceId) {
    const c = this.context(userId, workspaceId);
    const allowed =
      c.membership.role === 'owner' ||
      c.membership.role === 'admin' ||
      !Array.isArray(c.membership.shopIds) ||
      !c.membership.shopIds.length
        ? null
        : new Set(c.membership.shopIds);
    return c.state.shops.filter(
      (s) =>
        s.workspaceId === workspaceId && (!allowed || allowed.has(s.id)),
    );
  }

  async createWorkspace(userId, input = {}) {
    const state = this.store.snapshot();
    assert(
      state.users.some((u) => u.id === userId),
      'USER_NOT_FOUND',
      'Пользователь не найден',
      404,
    );
    const name = String(input.name || '').trim();
    assert(name.length >= 2, 'WORKSPACE_NAME_REQUIRED', 'Укажите название пространства');
    const shopName =
      String(input.shopName || name).trim() || name;

    return this.store.transaction(userId, (db) => {
      const workspace = {
        id: id('ws'),
        name,
        createdAt: new Date().toISOString(),
      };
      const requestedSlug = String(input.shopSlug || shopName).trim();
      const exact = slugify(requestedSlug);
      if (input.shopSlug) {
        assert(
          !db.shops.some((s) => s.slug === exact),
          'SHOP_SLUG_EXISTS',
          'Такой адрес магазина уже занят',
          409,
        );
      }
      const shop = {
        id: id('shop'),
        workspaceId: workspace.id,
        name: shopName,
        slug: input.shopSlug ? exact : uniqueSlug(db, shopName),
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      db.workspaces.push(workspace);
      db.memberships.push({
        id: id('mem'),
        userId,
        workspaceId: workspace.id,
        role: 'owner',
      });
      db.shops.push(shop);
      return { workspace, shop };
    });
  }

  async createShop(userId, workspaceId, input) {
    this.context(userId, workspaceId, 'admin');
    const name = String(input.name || '').trim();
    assert(name.length >= 2, 'SHOP_NAME_REQUIRED', 'Укажите название магазина');
    const explicitSlug =
      input.slug !== undefined && String(input.slug).trim() !== '';

    return this.store.transaction(userId, (db) => {
      let slug;
      if (explicitSlug) {
        slug = slugify(input.slug);
        assert(slug, 'SHOP_SLUG_REQUIRED', 'Укажите адрес магазина');
        assert(
          !db.shops.some((s) => s.slug === slug),
          'SHOP_SLUG_EXISTS',
          'Такой адрес магазина уже занят',
          409,
        );
      } else {
        slug = uniqueSlug(db, name);
      }
      const shop = {
        id: id('shop'),
        workspaceId,
        name,
        slug,
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      db.shops.push(shop);
      // Empty published storefront so a newly connected bot never falls through to another shop.
      db.storefronts ||= [];
      const draft = {
        theme: {
          accent: '#C45A32',
          background: '#EBE5DB',
          surface: '#F7F3EC',
          text: '#2A2724',
          muted: '#6F675F',
          radius: 26,
          font: 'Plus Jakarta Sans',
          container: 1120,
          cardStyle: 'soft',
          buttonStyle: 'pill',
          headerStyle: 'glass',
          cartEnabled: true,
          showcaseOnly: false,
        },
        seo: { title: name, description: '' },
        blocks: [
          {
            id: id('blk'),
            type: 'hero',
            visible: true,
            settings: {
              title: name,
              subtitle: 'Добавьте товары в разделе «Товары»',
              buttonText: 'Каталог',
            },
          },
          {
            id: id('blk'),
            type: 'categories',
            visible: true,
            settings: { title: 'Категории' },
          },
          {
            id: id('blk'),
            type: 'products',
            visible: true,
            settings: { title: 'Популярные товары', mode: 'grid' },
          },
        ],
        vitrina: [],
      };
      db.storefronts.push({
        id: id('storefront'),
        shopId: shop.id,
        draft,
        published: structuredClone(draft),
        versions: [
          {
            id: id('sfv'),
            number: 1,
            createdAt: new Date().toISOString(),
            snapshot: structuredClone(draft),
          },
        ],
        updatedAt: new Date().toISOString(),
        publishedAt: new Date().toISOString(),
      });
      shop.status = 'published';
      return shop;
    });
  }

  async updateShop(userId, workspaceId, shopId, input = {}) {
    this.context(userId, workspaceId, 'admin');
    return this.store.transaction(userId, (db) => {
      const shop = db.shops.find(
        (s) => s.id === shopId && s.workspaceId === workspaceId,
      );
      assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
      if (input.name !== undefined) {
        const name = String(input.name || '').trim();
        assert(name.length >= 2, 'SHOP_NAME_REQUIRED', 'Укажите название магазина');
        shop.name = name;
      }
      if (input.slug !== undefined) {
        const slug = slugify(input.slug);
        assert(slug, 'SHOP_SLUG_REQUIRED', 'Укажите адрес магазина');
        assert(
          !db.shops.some((s) => s.slug === slug && s.id !== shopId),
          'SHOP_SLUG_EXISTS',
          'Такой адрес магазина уже занят',
          409,
        );
        shop.slug = slug;
      }
      if (input.status !== undefined) {
        assert(
          ['draft', 'published', 'archived'].includes(input.status),
          'SHOP_STATUS_INVALID',
          'Недопустимый статус магазина',
        );
        shop.status = input.status;
      }
      if (input.logoUrl !== undefined) shop.logoUrl = String(input.logoUrl || '').trim();
      if (input.faviconUrl !== undefined) {
        shop.faviconUrl = String(input.faviconUrl || '').trim();
      }
      if (input.settings && typeof input.settings === 'object') {
        const prev = shop.settings || {};
        const next = { ...prev, ...input.settings };
        for (const key of [
          'payments',
          'delivery',
          'legal',
          'analytics',
          'channels',
          'storefront',
          'integrations',
        ]) {
          if (
            input.settings[key] &&
            typeof input.settings[key] === 'object' &&
            !Array.isArray(input.settings[key])
          ) {
            next[key] = { ...(prev[key] || {}), ...input.settings[key] };
            if (key === 'payments') {
              for (const [prov, val] of Object.entries(input.settings.payments)) {
                if (val && typeof val === 'object' && !Array.isArray(val)) {
                  next.payments[prov] = {
                    ...(prev.payments?.[prov] || {}),
                    ...val,
                  };
                }
              }
            }
          }
        }
        shop.settings = next;
      }
      if (input.currency !== undefined) {
        shop.currency = String(input.currency || 'RUB').toUpperCase();
      }
      if (input.timezone !== undefined) {
        shop.timezone = String(input.timezone || 'Europe/Moscow');
      }
      shop.updatedAt = new Date().toISOString();
      return shop;
    });
  }

  /**
   * Hard-delete a shop and purge all shop-scoped records from the JSON DB.
   * This is the "cache clear" for that shop — nothing shop-related remains.
   */
  async deleteShop(userId, workspaceId, shopId) {
    this.context(userId, workspaceId, 'admin');
    return this.store.transaction(userId, (db) => {
      const shop = db.shops.find(
        (s) => s.id === shopId && s.workspaceId === workspaceId,
      );
      assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);

      const orderIds = new Set(
        (db.orders || [])
          .filter((item) => item.shopId === shopId)
          .map((item) => item.id),
      );

      const shopScoped = [
        'categories',
        'products',
        'storefronts',
        'orders',
        'notifications',
        'telegramConfigs',
        'telegramMessages',
        'telegramWelcomeLog',
        'webhooks',
        'webhookDeliveries',
        'payments',
        'paymentEvents',
        'stockMovements',
        'stockReservations',
        'stocktakes',
        'deliveryMethods',
        'shipments',
        'shipmentEvents',
        'customerProfiles',
        'customerAddresses',
        'wishlist',
        'loyaltyLedger',
        'customerNotifications',
        'campaigns',
        'campaignDeliveries',
        'automationRules',
        'automationRuns',
        'promotions',
        'promoUsages',
        'personalPromos',
        'analyticsEvents',
        'apiKeys',
        'referrals',
        'referralLedger',
        'maxChannels',
        'feeds',
        'importJobs',
        'integrationLogs',
        'erpConnections',
        'channelPosts',
        'chatMessages',
        'courierZones',
        'receipts',
        'supportThreads',
        'supportMessages',
        'supportTickets',
      ];

      const purged = {};
      for (const key of shopScoped) {
        if (!Array.isArray(db[key])) continue;
        const before = db[key].length;
        db[key] = db[key].filter((item) => item?.shopId !== shopId);
        purged[key] = before - db[key].length;
      }

      if (Array.isArray(db.orderEvents)) {
        const before = db.orderEvents.length;
        db.orderEvents = db.orderEvents.filter(
          (item) => item?.shopId !== shopId && !orderIds.has(item?.orderId),
        );
        purged.orderEvents = before - db.orderEvents.length;
      }

      for (const membership of db.memberships || []) {
        if (Array.isArray(membership.shopIds)) {
          membership.shopIds = membership.shopIds.filter((id) => id !== shopId);
        }
      }

      const index = db.shops.findIndex(
        (s) => s.id === shopId && s.workspaceId === workspaceId,
      );
      assert(index >= 0, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
      const [removed] = db.shops.splice(index, 1);

      return {
        deleted: true,
        shop: { id: removed.id, name: removed.name, slug: removed.slug },
        purged,
        purgedTotal: Object.values(purged).reduce((sum, n) => sum + Number(n || 0), 0),
      };
    });
  }
}
