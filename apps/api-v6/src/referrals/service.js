import crypto from 'node:crypto';
import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const money = (v) => Math.round(Math.max(0, Number(v) || 0) * 100) / 100;

const defaultReward = (overrides = {}) => ({
  type: 'percent',
  value: 10,
  minOrder: 0,
  validDays: 14,
  excludeDiscounted: false,
  ...overrides,
});

const defaultProgram = () => ({
  enabled: false,
  firstOrderOnly: true,
  referrerReward: defaultReward({ value: 10, validDays: 30, delayDays: 0 }),
  refereeReward: defaultReward({ value: 10, validDays: 14, delayDays: 0 }),
  updatedAt: null,
});

export class ReferralService {
  constructor(store, tenancy, telegram = null) {
    this.store = store;
    this.tenancy = tenancy;
    this.telegram = telegram;
  }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    assert(
      context.state.shops.some(
        (shop) => shop.id === shopId && shop.workspaceId === workspaceId,
      ),
      'SHOP_NOT_FOUND',
      'Магазин не найден',
      404,
    );
    return context;
  }

  programOf(shop) {
    const raw = shop?.settings?.referralProgram;
    const base = defaultProgram();
    if (!raw || typeof raw !== 'object') return base;
    return {
      enabled: Boolean(raw.enabled),
      firstOrderOnly: raw.firstOrderOnly !== false,
      referrerReward: {
        ...base.referrerReward,
        ...(raw.referrerReward || {}),
        delayDays: Math.max(
          0,
          Number(raw.referrerReward?.delayDays ?? base.referrerReward.delayDays ?? 0),
        ),
      },
      refereeReward: {
        ...base.refereeReward,
        ...(raw.refereeReward || {}),
      },
      updatedAt: raw.updatedAt || null,
    };
  }

  priorOrdersCount(state, shopId, refereeTelegramId = '', refereePhone = '') {
    const tg = String(refereeTelegramId || '').trim();
    const phone = String(refereePhone || '').replace(/\D/g, '');
    return (state.orders || []).filter((order) => {
      if (order.shopId !== shopId) return false;
      if (['cancelled', 'refunded'].includes(order.status)) return false;
      const orderTg = String(order.customer?.telegramId || '').trim();
      const orderPhone = String(order.customer?.phone || '').replace(/\D/g, '');
      if (tg && orderTg && orderTg === tg) return true;
      if (!tg && phone && orderPhone && orderPhone === phone) return true;
      return false;
    }).length;
  }

  hasExternalLoyalty(shop) {
    const loyalty = shop?.settings?.loyalty || shop?.settings?.externalLoyalty || {};
    const provider = String(loyalty.provider || loyalty.system || '').toLowerCase();
    return Boolean(
      loyalty.external === true ||
        loyalty.maxma ||
        provider === 'maxma' ||
        provider === 'external',
    );
  }

  getProgram(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    const shop = state.shops.find((item) => item.id === shopId);
    const program = this.programOf(shop);
    return {
      ...program,
      externalLoyaltyBlocked: this.hasExternalLoyalty(shop),
      analytics: this.analytics(shopId, state),
    };
  }

  async updateProgram(userId, workspaceId, shopId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, (db) => {
      const shop = db.shops.find((item) => item.id === shopId);
      assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
      if (input.enabled && this.hasExternalLoyalty(shop)) {
        assert(
          false,
          'REFERRAL_LOYALTY_CONFLICT',
          'Реферальную программу нельзя включить при внешней системе лояльности (например Maxma)',
          400,
        );
      }
      shop.settings ||= {};
      const current = this.programOf(shop);
      const normalizeReward = (src = {}, fallback = {}) => {
        const type = src.type === 'fixed' ? 'fixed' : 'percent';
        const value = Math.max(0, Number(src.value ?? fallback.value ?? 0));
        return {
          type,
          value: type === 'percent' ? Math.min(90, value) : money(value),
          minOrder: money(src.minOrder ?? fallback.minOrder ?? 0),
          validDays: Math.max(0, Number(src.validDays ?? fallback.validDays ?? 0)),
          excludeDiscounted: Boolean(
            src.excludeDiscounted ?? fallback.excludeDiscounted ?? false,
          ),
          delayDays: Math.max(0, Number(src.delayDays ?? fallback.delayDays ?? 0)),
        };
      };
      const next = {
        enabled: input.enabled !== undefined ? Boolean(input.enabled) : current.enabled,
        firstOrderOnly:
          input.firstOrderOnly !== undefined
            ? Boolean(input.firstOrderOnly)
            : current.firstOrderOnly !== false,
        referrerReward: normalizeReward(
          input.referrerReward || {},
          current.referrerReward,
        ),
        refereeReward: normalizeReward(
          input.refereeReward || {},
          current.refereeReward,
        ),
        updatedAt: now(),
      };
      shop.settings.referralProgram = next;
      shop.updatedAt = now();
      return {
        ...next,
        externalLoyaltyBlocked: this.hasExternalLoyalty(shop),
        analytics: this.analytics(shopId, db),
      };
    });
  }

  analytics(shopId, state = this.store.snapshot()) {
    const refs = (state.referrals || []).filter((item) => item.shopId === shopId);
    const ledger = (state.referralLedger || []).filter((item) => item.shopId === shopId);
    const orderIds = new Set(ledger.map((item) => item.orderId));
    const orders = (state.orders || []).filter((item) => orderIds.has(item.id));
    const invited = new Set(
      orders.map((item) => String(item.customer?.telegramId || item.customer?.phone || item.id)),
    );
    return {
      referrers: refs.length,
      invited: invited.size,
      orders: orders.length,
      orderSum: money(orders.reduce((sum, item) => sum + Number(item.total || 0), 0)),
      pendingRewards: money(
        ledger
          .filter((item) => item.status === 'pending')
          .reduce((sum, item) => sum + Number(item.amount || 0), 0),
      ),
      availableRewards: money(
        ledger
          .filter((item) => item.status === 'available')
          .reduce((sum, item) => sum + Number(item.amount || 0), 0),
      ),
    };
  }

  list(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    return (state.referrals || [])
      .filter((item) => item.shopId === shopId)
      .map((item) => ({
        ...item,
        summary: this.summary(shopId, item.id, state),
      }))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  summary(shopId, referralId, state = this.store.snapshot()) {
    this.unlockDue(state, shopId);
    const rows = (state.referralLedger || []).filter(
      (x) => x.shopId === shopId && x.referralId === referralId,
    );
    return {
      pending: money(
        rows.filter((x) => x.status === 'pending').reduce((s, x) => s + x.amount, 0),
      ),
      available: money(
        rows
          .filter((x) => x.status === 'available')
          .reduce((s, x) => s + x.amount, 0),
      ),
      used: money(
        rows.filter((x) => x.status === 'used').reduce((s, x) => s + x.amount, 0),
      ),
      entries: rows.length,
    };
  }

  unlockDue(state, shopId = null) {
    const stamp = Date.now();
    for (const entry of state.referralLedger || []) {
      if (shopId && entry.shopId !== shopId) continue;
      if (
        entry.status === 'pending' &&
        entry.availableAt &&
        new Date(entry.availableAt).getTime() <= stamp
      ) {
        entry.status = 'available';
      }
    }
  }

  async create(userId, workspaceId, shopId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const telegram = String(input.telegram || input.telegramId || '').trim();
    assert(telegram, 'REFERRAL_TELEGRAM_REQUIRED', 'Укажите Telegram реферера');
    return this.store.transaction(userId, (db) => {
      db.referrals ||= [];
      const existing = db.referrals.find(
        (x) => x.shopId === shopId && x.telegram === telegram,
      );
      if (existing) return existing;
      const shop = db.shops.find((item) => item.id === shopId);
      const program = this.programOf(shop);
      const item = {
        id: id('ref'),
        shopId,
        telegram,
        name: String(input.name || telegram).trim(),
        code: crypto.randomBytes(4).toString('hex').toUpperCase(),
        discountPercent: Math.min(
          50,
          Math.max(
            0,
            Number(
              input.discountPercent ??
                (program.refereeReward.type === 'percent'
                  ? program.refereeReward.value
                  : 10),
            ),
          ),
        ),
        rewardPercent: Math.min(
          50,
          Math.max(
            0,
            Number(
              input.rewardPercent ??
                (program.referrerReward.type === 'percent'
                  ? program.referrerReward.value
                  : 10),
            ),
          ),
        ),
        uses: 0,
        createdAt: now(),
      };
      db.referrals.push(item);
      return item;
    });
  }

  invitePayload(shop, row, program, botUsername = '') {
    const bot = String(botUsername || '').replace(/^@/, '');
    const webPath = `/?shop=${encodeURIComponent(shop.slug)}&ref=${encodeURIComponent(row.code)}`;
    // Industry standard Mini App deep-link: t.me/bot?startapp=ref_CODE
    const telegramLink = bot
      ? `https://t.me/${bot}?startapp=${encodeURIComponent(`ref_${row.code}`)}`
      : '';
    // Fallback bot deep-link (opens chat first, then Mini App via menu)
    const telegramStartLink = bot
      ? `https://t.me/${bot}?start=${encodeURIComponent(`ref_${row.code}`)}`
      : '';
    return {
      code: row.code,
      linkPath: webPath,
      webPath,
      telegramLink: telegramLink || telegramStartLink,
      telegramStartLink,
      botUsername: bot,
      program,
    };
  }

  /** Create-or-get personal referral code for a Telegram user (await — store.transaction is async). */
  async ensureForCustomer(shopId, telegramId, name = '') {
    const tg = String(telegramId || '').trim();
    if (!tg) return null;
    return this.store.transaction('referral-auto', (db) => {
      const shop = db.shops.find((item) => item.id === shopId);
      if (!shop) return null;
      const program = this.programOf(shop);
      if (!program.enabled) return null;
      db.referrals ||= [];
      let row = db.referrals.find(
        (item) => item.shopId === shopId && String(item.telegram) === tg,
      );
      if (!row) {
        // Readable short code (8 hex), unique per shop — same pattern as other TG Mini Apps
        let code = '';
        for (let i = 0; i < 8; i += 1) {
          code = crypto.randomBytes(4).toString('hex').toUpperCase();
          if (!db.referrals.some((item) => item.shopId === shopId && item.code === code)) break;
        }
        row = {
          id: id('ref'),
          shopId,
          telegram: tg,
          name: String(name || tg).trim(),
          code,
          discountPercent:
            program.refereeReward.type === 'percent' ? program.refereeReward.value : 0,
          rewardPercent:
            program.referrerReward.type === 'percent' ? program.referrerReward.value : 0,
          uses: 0,
          createdAt: now(),
          auto: true,
        };
        db.referrals.push(row);
      } else if (name && (!row.name || row.name === row.telegram)) {
        row.name = String(name).trim();
      }
      const botUsername = String(
        (db.telegramConfigs || []).find(
          (item) => item.shopId === shopId && item.enabled !== false,
        )?.botUsername || '',
      ).replace(/^@/, '');
      return this.invitePayload(shop, row, program, botUsername);
    });
  }

  personalStats(shopId, referralRow, state = this.store.snapshot()) {
    if (!referralRow?.id) {
      return { clicks: 0, invited: 0, orders: 0, earned: 0 };
    }
    const code = String(referralRow.code || '').toUpperCase();
    const summary = this.summary(shopId, referralRow.id, state);
    const invited = (state.customerProfiles || []).filter(
      (item) =>
        item.shopId === shopId &&
        String(item.referredByCode || '').toUpperCase() === code,
    ).length;
    const orders = (state.orders || []).filter(
      (item) =>
        item.shopId === shopId &&
        String(item.referralCode || '').toUpperCase() === code,
    ).length;
    const clicks = Math.max(Number(referralRow.uses || 0), invited);
    return {
      clicks,
      invited,
      orders,
      earned: money(
        Number(summary.pending || 0) +
          Number(summary.available || 0) +
          Number(summary.used || 0),
      ),
      pending: summary.pending,
      available: summary.available,
      used: summary.used,
    };
  }

  async customerInvite(tokenContext) {
    const { shop, session } = tokenContext;
    const program = this.programOf(shop);
    if (!program.enabled) {
      return { enabled: false };
    }
    const tg = String(session?.telegramId || '').trim();
    if (!tg) {
      return {
        enabled: true,
        code: '',
        error: 'TELEGRAM_REQUIRED',
        message: 'Нужна авторизация через Telegram Mini App',
      };
    }
    const displayName = String(
      tokenContext.name ||
        [session.firstName, session.lastName].filter(Boolean).join(' ') ||
        session.username ||
        '',
    ).trim();
    const ensured = await this.ensureForCustomer(shop.id, tg, displayName);
    if (!ensured?.code) {
      return {
        enabled: true,
        code: '',
        error: 'REFERRAL_CREATE_FAILED',
        message: 'Не удалось создать реферальный код',
      };
    }
    const state = this.store.snapshot();
    const row = (state.referrals || []).find(
      (item) =>
        item.shopId === shop.id &&
        String(item.code || '').toUpperCase() === String(ensured.code).toUpperCase(),
    );
    return {
      enabled: true,
      code: ensured.code,
      linkPath: ensured.linkPath || '',
      webPath: ensured.webPath || ensured.linkPath || '',
      telegramLink: ensured.telegramLink || '',
      telegramStartLink: ensured.telegramStartLink || '',
      botUsername: ensured.botUsername || '',
      firstOrderOnly: program.firstOrderOnly !== false,
      refereeReward: program.refereeReward,
      referrerReward: program.referrerReward,
      stats: this.personalStats(shop.id, row, state),
    };
  }

  validatePublic(slug, code) {
    const state = this.store.snapshot();
    const shop = state.shops.find((item) => item.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const program = this.programOf(shop);
    assert(program.enabled, 'REFERRAL_DISABLED', 'Реферальная программа выключена', 404);
    const referral = (state.referrals || []).find(
      (item) =>
        item.shopId === shop.id &&
        item.code === String(code || '').toUpperCase(),
    );
    assert(referral, 'REFERRAL_NOT_FOUND', 'Реферальный код не найден', 404);
    const reward = program.refereeReward;
    return {
      code: referral.code,
      name: referral.name,
      enabled: true,
      firstOrderOnly: program.firstOrderOnly !== false,
      rewardType: reward.type,
      discountPercent: reward.type === 'percent' ? reward.value : 0,
      discountFixed: reward.type === 'fixed' ? reward.value : 0,
      minOrder: reward.minOrder,
      validDays: reward.validDays,
      excludeDiscounted: reward.excludeDiscounted,
    };
  }

  quoteRefereeDiscount(
    shop,
    code,
    subtotal,
    { hasProductDiscount = false, refereeTelegramId = '', refereePhone = '' } = {},
  ) {
    const program = this.programOf(shop);
    if (!program.enabled || !code) return { discount: 0, referral: null };
    const state = this.store.snapshot();
    const referral = (state.referrals || []).find(
      (item) =>
        item.shopId === shop.id &&
        item.code === String(code).toUpperCase(),
    );
    if (!referral) return { discount: 0, referral: null };
    if (
      refereeTelegramId &&
      String(referral.telegram) === String(refereeTelegramId)
    ) {
      return { discount: 0, referral, reason: 'self_referral' };
    }
    if (program.firstOrderOnly !== false) {
      const prior = this.priorOrdersCount(
        state,
        shop.id,
        refereeTelegramId,
        refereePhone,
      );
      if (prior > 0) {
        return { discount: 0, referral, reason: 'not_first_order' };
      }
    }
    const reward = program.refereeReward;
    if (Number(subtotal) < Number(reward.minOrder || 0)) {
      return { discount: 0, referral, reason: 'min_order' };
    }
    if (reward.excludeDiscounted && hasProductDiscount) {
      return { discount: 0, referral, reason: 'exclude_discounted' };
    }
    const discount =
      reward.type === 'fixed'
        ? money(Math.min(Number(subtotal), reward.value))
        : money((Number(subtotal) * Number(reward.value)) / 100);
    return { discount, referral, reward };
  }

  async registerOrder(shopId, code, orderId, orderTotal, refereeTelegramId = '') {
    if (!code) return null;
    return this.store.transaction('referral', (db) => {
      db.referrals ||= [];
      db.referralLedger ||= [];
      db.loyaltyLedger ||= [];
      const shop = db.shops.find((item) => item.id === shopId);
      const program = this.programOf(shop);
      if (!program.enabled) return null;
      const ref = db.referrals.find(
        (x) => x.shopId === shopId && x.code === String(code).toUpperCase(),
      );
      if (!ref) return null;
      if (
        refereeTelegramId &&
        String(ref.telegram) === String(refereeTelegramId)
      ) {
        return null;
      }
      if (db.referralLedger.some((x) => x.orderId === orderId)) return null;
      const order = (db.orders || []).find((item) => item.id === orderId);
      if (program.firstOrderOnly !== false) {
        // current order is already in db.orders — exclude it
        const priorWithoutCurrent = (db.orders || []).filter((item) => {
          if (item.id === orderId) return false;
          if (item.shopId !== shopId) return false;
          if (['cancelled', 'refunded'].includes(item.status)) return false;
          const orderTg = String(item.customer?.telegramId || '').trim();
          const orderPhone = String(item.customer?.phone || '').replace(/\D/g, '');
          const tg = String(refereeTelegramId || '').trim();
          const phone = String(order?.customer?.phone || '').replace(/\D/g, '');
          if (tg && orderTg && orderTg === tg) return true;
          if (!tg && phone && orderPhone && orderPhone === phone) return true;
          return false;
        }).length;
        if (priorWithoutCurrent > 0) return null;
      }
      const reward = program.referrerReward;
      const amount =
        reward.type === 'fixed'
          ? money(reward.value)
          : money((Number(orderTotal) * Number(reward.value || ref.rewardPercent || 0)) / 100);
      if (amount <= 0) return null;
      const delayDays = Math.max(0, Number(reward.delayDays || 0));
      const availableAt =
        delayDays > 0
          ? new Date(Date.now() + delayDays * 86400000).toISOString()
          : now();
      const entry = {
        id: id('led'),
        shopId,
        referralId: ref.id,
        orderId,
        amount,
        status: delayDays > 0 ? 'pending' : 'available',
        createdAt: now(),
        availableAt,
        refereeTelegramId: String(refereeTelegramId || ''),
      };
      db.referralLedger.push(entry);
      ref.uses = Number(ref.uses || 0) + 1;
      // Instant bonus to referrer TG account when no delay.
      if (entry.status === 'available' && ref.telegram) {
        const customerKey = `tg:${ref.telegram}`;
        if (
          !db.loyaltyLedger.some(
            (x) =>
              x.shopId === shopId &&
              x.orderId === orderId &&
              x.type === 'referral_reward',
          )
        ) {
          db.loyaltyLedger.push({
            id: id('bon'),
            shopId,
            customerKey,
            orderId,
            amount,
            reason: `Реферальная награда 10% за первый заказ друга`,
            type: 'referral_reward',
            createdAt: now(),
          });
          entry.creditedAt = now();
        }
      }
      return entry;
    });
  }

  async settle(shopId, orderId) {
    return this.store.transaction('referral-settle', (db) => {
      this.unlockDue(db, shopId);
      db.loyaltyLedger ||= [];
      const entry = (db.referralLedger || []).find(
        (x) => x.shopId === shopId && x.orderId === orderId,
      );
      if (!entry) return null;
      const due =
        !entry.availableAt || new Date(entry.availableAt).getTime() <= Date.now();
      if (due) {
        entry.status = 'available';
        entry.availableAt = entry.availableAt || now();
        entry.settledAt = now();
      }
      const ref = (db.referrals || []).find((item) => item.id === entry.referralId);
      if (due && ref?.telegram && !entry.creditedAt) {
        const customerKey = `tg:${ref.telegram}`;
        if (
          !db.loyaltyLedger.some(
            (x) =>
              x.shopId === shopId &&
              x.orderId === orderId &&
              x.type === 'referral_reward',
          )
        ) {
          db.loyaltyLedger.push({
            id: id('bon'),
            shopId,
            customerKey,
            orderId,
            amount: entry.amount,
            reason: `Реферальная награда за заказ друга`,
            type: 'referral_reward',
            createdAt: now(),
          });
          entry.creditedAt = now();
        }
      }
      return { entry, referral: ref || null, unlocked: due };
    });
  }
}
