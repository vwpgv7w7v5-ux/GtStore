import crypto from 'node:crypto';
import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const allowedProviders = [
  'manual',
  'yookassa',
  'cloudpayments',
  'stripe',
  'tbank',
  'tochka',
  'yapay',
  'split',
];
const terminal = new Set([
  'paid',
  'cancelled',
  'expired',
  'refunded',
  'failed',
]);
const publicPayment = (p) => ({
  id: p.id,
  orderId: p.orderId,
  provider: p.provider,
  status: p.status,
  amount: p.amount,
  currency: p.currency,
  checkoutUrl: p.checkoutUrl || null,
  receiptId: p.receiptId || null,
  createdAt: p.createdAt,
  paidAt: p.paidAt || null,
  refundedAt: p.refundedAt || null,
  failureReason: p.failureReason || null,
});

const providerMeta = {
  manual: { name: 'Ручная оплата', mode: 'offline', currency: 'RUB' },
  yookassa: { name: 'ЮKassa', mode: 'online', currency: 'RUB' },
  cloudpayments: { name: 'CloudPayments', mode: 'online', currency: 'RUB' },
  stripe: { name: 'Stripe', mode: 'online', currency: 'multi' },
  tbank: { name: 'Т‑Банк', mode: 'online', currency: 'RUB' },
  tochka: { name: 'Точка Банк', mode: 'online', currency: 'RUB' },
  yapay: { name: 'Я.Пэй', mode: 'online', currency: 'RUB' },
  split: { name: 'Сплит / рассрочка', mode: 'online', currency: 'RUB' },
};
const implementedOnline = new Set(['yookassa', 'tbank', 'tochka', 'yapay', 'split']);

function yookassaVatCode(rate) {
  const r = Number(rate);
  if (r === 0) return 2;
  if (r === 10) return 3;
  if (r === 20) return 4;
  return 1;
}

function tbankVatCode(rate) {
  const r = Number(rate);
  if (r === 0) return 'vat0';
  if (r === 10) return 'vat10';
  if (r === 20) return 'vat20';
  return 'none';
}

function taxationCode(sno) {
  return (
    {
      osn: 'osn',
      usn_income: 'usn_income',
      usn: 'usn_income_outcome',
      usn_income_outcome: 'usn_income_outcome',
      envd: 'envd',
      esn: 'esn',
      patent: 'patent',
    }[sno] || 'osn'
  );
}

export class PaymentService {
  constructor(store, tenancy, orders, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.orders = orders;
    this.fetch = options.fetch || globalThis.fetch;
    this.webhookSecret =
      options.webhookSecret ||
      process.env.GTSTORE_PAYMENT_WEBHOOK_SECRET ||
      'gtstore-payment-secret';
    this.yookassaShopId =
      options.yookassaShopId || process.env.YOOKASSA_SHOP_ID || '';
    this.yookassaSecretKey =
      options.yookassaSecretKey || process.env.YOOKASSA_SECRET_KEY || '';
    this.publicBaseUrl = String(
      options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '',
    ).replace(/\/$/, '');
    this.returnUrl = String(
      options.returnUrl ||
        process.env.PAYMENT_RETURN_URL ||
        options.storefrontUrl ||
        process.env.STOREFRONT_URL ||
        '',
    ).replace(/\/$/, '');
  }

  fallbackReturnUrl(order, payment, returnUrl) {
    return (
      returnUrl ||
      `${this.returnUrl || 'https://example.com'}/?shop=${encodeURIComponent(order.shopSlug || '')}&payment=${payment.id}`
    );
  }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const ctx = this.tenancy.context(userId, workspaceId, role);
    const shop = ctx.state.shops.find(
      (x) => x.id === shopId && x.workspaceId === workspaceId,
    );
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return ctx;
  }

  yookassaCredentials(shop) {
    const fromShop = shop?.settings?.payments?.yookassa || {};
    const shopId = String(fromShop.shopId || '').trim();
    const secretKey = String(fromShop.secretKey || '').trim();
    if (shopId && secretKey) {
      return { shopId, secretKey, source: 'shop' };
    }
    if (this.yookassaShopId && this.yookassaSecretKey) {
      return {
        shopId: this.yookassaShopId,
        secretKey: this.yookassaSecretKey,
        source: 'env',
      };
    }
    return null;
  }

  yookassaConfigured(shop) {
    return Boolean(this.yookassaCredentials(shop));
  }

  providerCredentials(shop, code) {
    const fromShop = shop?.settings?.payments?.[code] || {};
    if (code === 'yookassa') return this.yookassaCredentials(shop);
    const token = String(fromShop.token || fromShop.secretKey || '').trim();
    const terminalKey = String(fromShop.terminalKey || fromShop.shopId || '').trim();
    if (terminalKey && token) {
      return { terminalKey, token, source: 'shop' };
    }
    return null;
  }

  providers(shop) {
    const ykLive = this.yookassaConfigured(shop);
    return allowedProviders.map((code) => {
      const creds = this.providerCredentials(shop, code);
      const implemented = code === 'manual' || implementedOnline.has(code);
      let live = code === 'manual';
      if (code === 'yookassa') live = ykLive;
      else if (implementedOnline.has(code)) live = Boolean(creds);
      return {
        code,
        name: providerMeta[code].name,
        mode: providerMeta[code].mode,
        implemented,
        live,
        currency: providerMeta[code].currency,
        source: creds?.source || null,
      };
    });
  }

  legalEntity(shop) {
    const legal = shop?.settings?.legal || {};
    return {
      companyName: legal.companyName || '',
      inn: legal.inn || '',
      kpp: legal.kpp || '',
      ogrn: legal.ogrn || '',
      legalAddress: legal.legalAddress || '',
      bankName: legal.bankName || '',
      bik: legal.bik || '',
      checkingAccount: legal.checkingAccount || '',
      corrAccount: legal.corrAccount || '',
      vatRate: legal.vatRate == null ? 20 : Number(legal.vatRate),
      taxSystem: legal.taxSystem || 'osn',
      receiptEnabled: legal.receiptEnabled !== false,
    };
  }

  fiscalSettings(shop) {
    const fiscal = shop?.settings?.payments?.fiscal || {};
    const legal = this.legalEntity(shop);
    return {
      enabled: fiscal.enabled ?? legal.receiptEnabled,
      provider: fiscal.provider || 'atol_online',
      vatRate: fiscal.vatRate == null ? legal.vatRate : Number(fiscal.vatRate),
      sno: fiscal.sno || legal.taxSystem || 'osn',
    };
  }

  buildReceipt(order, shop, payment) {
    const fiscal = this.fiscalSettings(shop);
    const legal = this.legalEntity(shop);
    if (!fiscal.enabled) return null;
    const vat = Number(fiscal.vatRate);
    const source = order.lines?.length ? order.lines : order.items || [];
    const items = source.map((item) => ({
      name: item.name || 'Товар',
      quantity: Number(item.quantity || 1),
      price: Number(item.unitPrice ?? item.price ?? 0),
      amount: Number(item.total ?? item.price * item.quantity ?? 0),
      vat,
      paymentMethod: 'full_payment',
      paymentObject: 'commodity',
    }));
    return {
      id: id('rcpt'),
      paymentId: payment.id,
      orderId: order.id,
      shopId: shop.id,
      type: 'sell',
      status: 'pending',
      sno: fiscal.sno,
      vatRate: vat,
      company: {
        name: legal.companyName,
        inn: legal.inn,
        email: legal.email || '',
      },
      items,
      total: Number(payment.amount),
      createdAt: now(),
    };
  }

  list(userId, workspaceId, shopId, filter = {}) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    return (state.payments || [])
      .filter((x) => x.shopId === shopId)
      .filter(
        (x) =>
          !filter.status ||
          filter.status === 'all' ||
          x.status === filter.status,
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  getPublic(paymentId) {
    const p = (this.store.snapshot().payments || []).find(
      (x) => x.id === paymentId,
    );
    assert(p, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
    return publicPayment(p);
  }

  async yookassaRequest(method, path, body, credentials) {
    const creds = credentials || this.yookassaCredentials();
    assert(creds, 'YOOKASSA_NOT_CONFIGURED', 'ЮKassa не настроена');
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const auth = Buffer.from(`${creds.shopId}:${creds.secretKey}`).toString(
      'base64',
    );
    const response = await this.fetch(`https://api.yookassa.ru/v3${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        authorization: `Basic ${auth}`,
        'idempotence-key': crypto.randomUUID(),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    assert(
      response.ok,
      'YOOKASSA_API_ERROR',
      data.description || data.message || 'Ошибка ЮKassa API',
      502,
    );
    return data;
  }

  async createYookassaCheckout(order, payment, returnUrl, shop) {
    const confirmationReturn = this.fallbackReturnUrl(order, payment, returnUrl);
    const creds = this.yookassaCredentials(shop);
    if (!creds) {
      const fakeId = crypto.randomUUID();
      return {
        externalId: `yookassa_${fakeId}`,
        checkoutUrl: `https://payments.gtstore.local/yookassa/${fakeId}`,
        providerStatus: 'pending',
        live: false,
      };
    }
    const fiscal = this.fiscalSettings(shop);
    let receipt;
    if (fiscal.enabled) {
      const contact = String(order.customer?.email || '').trim() || String(order.customer?.phone || '').trim();
      const source = order.lines?.length ? order.lines : [];
      if (contact && source.length) {
        receipt = {
          customer: order.customer?.email ? { email: order.customer.email } : { phone: order.customer.phone },
          items: source.map((line) => ({
            description: String(line.name || 'Товар').slice(0, 128),
            quantity: String(line.quantity || 1),
            amount: {
              value: Number((line.total ?? line.unitPrice * line.quantity) || 0).toFixed(2),
              currency: payment.currency || 'RUB',
            },
            vat_code: yookassaVatCode(fiscal.vatRate),
            payment_mode: 'full_payment',
            payment_subject: 'commodity',
          })),
        };
      }
    }
    const created = await this.yookassaRequest(
      'POST',
      '/payments',
      {
        amount: {
          value: Number(payment.amount).toFixed(2),
          currency: payment.currency || 'RUB',
        },
        capture: true,
        confirmation: {
          type: 'redirect',
          return_url: confirmationReturn,
        },
        description: `Заказ №${order.number}`,
        ...(receipt ? { receipt } : {}),
        metadata: {
          paymentId: payment.id,
          orderId: order.id,
          shopId: order.shopId,
        },
      },
      creds,
    );
    return {
      externalId: created.id,
      checkoutUrl: created.confirmation?.confirmation_url || null,
      providerStatus: created.status || 'pending',
      live: true,
      raw: created,
    };
  }

  tbankToken(fields, password) {
    const flat = { ...fields, Password: password };
    const keys = Object.keys(flat).sort();
    const concat = keys.map((k) => String(flat[k])).join('');
    return crypto.createHash('sha256').update(concat).digest('hex');
  }

  buildTbankReceipt(order, shop, payment) {
    const fiscal = this.fiscalSettings(shop);
    if (!fiscal.enabled) return null;
    const source = order.lines?.length ? order.lines : [];
    if (!source.length) return null;
    const contact = String(order.customer?.email || '').trim() || String(order.customer?.phone || '').trim();
    if (!contact) return null;
    return {
      Taxation: taxationCode(fiscal.sno),
      ...(order.customer?.email ? { Email: order.customer.email } : { Phone: order.customer.phone }),
      Items: source.map((line) => ({
        Name: String(line.name || 'Товар').slice(0, 128),
        Price: Math.round(Number((line.unitPrice ?? line.total / (line.quantity || 1)) || 0) * 100),
        Quantity: Number(line.quantity || 1),
        Amount: Math.round(Number((line.total ?? line.unitPrice * line.quantity) || 0) * 100),
        Tax: tbankVatCode(fiscal.vatRate),
        PaymentMethod: 'full_payment',
        PaymentObject: 'commodity',
      })),
    };
  }

  async createTbankCheckout(order, payment, returnUrl, shop) {
    const fallback = (fallbackReason) => {
      const fakeId = crypto.randomUUID();
      return {
        externalId: `tbank_${fakeId}`,
        checkoutUrl: `https://payments.gtstore.local/tbank/${fakeId}`,
        providerStatus: 'pending',
        live: false,
        fallbackReason,
      };
    };
    const creds = this.providerCredentials(shop, 'tbank');
    if (!creds || !this.fetch) return fallback('no_credentials');
    try {
      const successUrl = this.fallbackReturnUrl(order, payment, returnUrl);
      const fields = {
        TerminalKey: creds.terminalKey,
        Amount: Math.round(Number(payment.amount) * 100),
        OrderId: String(payment.id),
        Description: `Заказ №${order.number}`.slice(0, 250),
        SuccessURL: successUrl,
        FailURL: successUrl,
      };
      if (this.publicBaseUrl) {
        fields.NotificationURL = `${this.publicBaseUrl}/api/v6/payments/webhooks/tbank`;
      }
      const body = { ...fields, Token: this.tbankToken(fields, creds.token) };
      const receipt = this.buildTbankReceipt(order, shop, payment);
      if (receipt) body.Receipt = receipt;
      const response = await this.fetch('https://securepay.tinkoff.ru/v2/Init', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data.Success === false) {
        throw new Error(data.Message || data.Details || `T-Bank HTTP ${response.status}`);
      }
      return {
        externalId: String(data.PaymentId || ''),
        checkoutUrl: data.PaymentURL || null,
        providerStatus: String(data.Status || 'new').toLowerCase(),
        live: true,
        raw: data,
      };
    } catch (e) {
      return fallback(String(e?.message || e));
    }
  }

  async createTochkaCheckout(order, payment, returnUrl, shop) {
    const fallback = (fallbackReason) => {
      const fakeId = crypto.randomUUID();
      return {
        externalId: `tochka_${fakeId}`,
        checkoutUrl: `https://payments.gtstore.local/tochka/${fakeId}`,
        providerStatus: 'pending',
        live: false,
        fallbackReason,
      };
    };
    const creds = this.providerCredentials(shop, 'tochka');
    if (!creds || !this.fetch) return fallback('no_credentials');
    try {
      const successUrl = this.fallbackReturnUrl(order, payment, returnUrl);
      const body = {
        Data: {
          customerCode: creds.terminalKey,
          amount: Number(payment.amount).toFixed(2),
          purpose: `Заказ №${order.number}`.slice(0, 210),
          redirectUrl: successUrl,
          failRedirectUrl: successUrl,
          paymentMode: ['sbp', 'card'],
        },
      };
      const response = await this.fetch(
        'https://enter.tochka.com/uapi/acquiring/v1.0/payments',
        {
          method: 'POST',
          headers: {
            authorization: `Bearer ${creds.token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      const data = await response.json().catch(() => ({}));
      const paymentLink = data?.Data?.paymentLink;
      if (!response.ok || !paymentLink) {
        throw new Error(data?.Errors?.[0]?.message || `Tochka HTTP ${response.status}`);
      }
      return {
        externalId: String(data.Data.operationId || ''),
        checkoutUrl: paymentLink,
        providerStatus: 'pending',
        live: true,
        raw: data,
      };
    } catch (e) {
      return fallback(String(e?.message || e));
    }
  }

  async createPublic(slug, input = {}) {
    const provider = String(input.provider || 'manual').toLowerCase();
    assert(
      allowedProviders.includes(provider),
      'PAYMENT_PROVIDER_INVALID',
      'Неизвестный платёжный провайдер',
    );
    const state = this.store.snapshot();
    const shop = state.shops.find((x) => x.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const order = state.orders.find(
      (x) => x.id === input.orderId && x.shopId === shop.id,
    );
    assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
    assert(
      !['cancelled', 'refunded'].includes(order.status),
      'ORDER_NOT_PAYABLE',
      'Заказ нельзя оплатить',
    );
    const existing = (state.payments || []).find(
      (x) => x.orderId === order.id && !terminal.has(x.status),
    );
    if (existing) return publicPayment(existing);

    const createdAt = now();
    const paymentId = id('pay');
    let externalId = null;
    let checkoutUrl = null;
    let live = false;

    if (provider === 'manual') {
      externalId = null;
      checkoutUrl = null;
    } else if (provider === 'yookassa') {
      const draft = {
        id: paymentId,
        amount: order.total,
        currency: String(input.currency || 'RUB').toUpperCase(),
      };
      const yk = await this.createYookassaCheckout(
        { ...order, shopSlug: shop.slug },
        draft,
        input.returnUrl,
        shop,
      );
      externalId = yk.externalId;
      checkoutUrl = yk.checkoutUrl;
      live = yk.live;
    } else if (provider === 'tbank' || provider === 'tochka') {
      const draft = {
        id: paymentId,
        amount: order.total,
        currency: String(input.currency || 'RUB').toUpperCase(),
      };
      const result =
        provider === 'tbank'
          ? await this.createTbankCheckout({ ...order, shopSlug: shop.slug }, draft, input.returnUrl, shop)
          : await this.createTochkaCheckout({ ...order, shopSlug: shop.slug }, draft, input.returnUrl, shop);
      externalId = result.externalId;
      checkoutUrl = result.checkoutUrl;
      live = result.live;
    } else if (implementedOnline.has(provider)) {
      const creds = this.providerCredentials(shop, provider);
      const fakeId = crypto.randomUUID();
      externalId = `${provider}_${fakeId}`;
      live = Boolean(creds);
      const returnUrl =
        input.returnUrl ||
        `${this.returnUrl || 'https://example.com'}/?shop=${encodeURIComponent(shop.slug)}&payment=${paymentId}`;
      checkoutUrl = live
        ? `https://payments.gtstore.local/${provider}/live/${fakeId}?return=${encodeURIComponent(returnUrl)}`
        : `https://payments.gtstore.local/${provider}/${fakeId}`;
    } else {
      const fakeId = crypto.randomUUID();
      externalId = `${provider}_${fakeId}`;
      checkoutUrl = `https://payments.gtstore.local/${provider}/${fakeId}`;
    }

    return this.store.transaction('public-payment', (db) => {
      db.payments ||= [];
      db.paymentEvents ||= [];
      db.receipts ||= [];
      const payment = {
        id: paymentId,
        shopId: shop.id,
        workspaceId: shop.workspaceId,
        orderId: order.id,
        provider,
        status: 'pending',
        amount: order.total,
        currency: String(input.currency || 'RUB').toUpperCase(),
        externalId,
        checkoutUrl,
        live,
        receiptId: null,
        metadata:
          input.metadata && typeof input.metadata === 'object'
            ? input.metadata
            : {},
        createdAt,
        updatedAt: createdAt,
      };
      const receipt = this.buildReceipt(order, shop, payment);
      if (receipt) {
        payment.receiptId = receipt.id;
        db.receipts.push(receipt);
      }
      db.payments.push(payment);
      db.paymentEvents.push({
        id: id('pevt'),
        paymentId: payment.id,
        type: 'created',
        status: 'pending',
        at: createdAt,
      });
      const row = db.orders.find((x) => x.id === order.id);
      if (row) {
        row.paymentStatus = 'pending';
        row.paymentId = payment.id;
        row.paymentMethod = provider;
        if (['new', 'confirmed'].includes(row.status) && provider !== 'manual' && provider !== 'cash' && provider !== 'transfer') {
          row.status = 'awaiting_payment';
        }
        row.updatedAt = createdAt;
      }
      return publicPayment(payment);
    });
  }

  receipts(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    return (state.receipts || [])
      .filter((r) => r.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async mark(paymentId, status, actor = 'system', extra = {}) {
    assert(
      [
        'pending',
        'authorized',
        'paid',
        'cancelled',
        'expired',
        'refunded',
        'failed',
      ].includes(status),
      'PAYMENT_STATUS_INVALID',
      'Некорректный статус платежа',
    );
    return this.store.transaction(actor, async (db) => {
      db.payments ||= [];
      db.paymentEvents ||= [];
      const p = db.payments.find((x) => x.id === paymentId);
      assert(p, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
      if (p.status === 'refunded' && status !== 'refunded') {
        assert(false, 'PAYMENT_FINAL', 'Возвращённый платёж нельзя изменить');
      }
      p.status = status;
      p.updatedAt = now();
      if (status === 'paid') {
        p.paidAt = p.updatedAt;
        const receipt = (db.receipts || []).find((r) => r.id === p.receiptId);
        if (receipt && receipt.status !== 'done') {
          const shop = db.shops.find((x) => x.id === p.shopId);
          const fiscal = this.fiscalSettings(shop);
          let atol = null;
          if (fiscal.provider === 'atol_online') {
            atol = await this.sendAtolReceipt(receipt, shop, p).catch((e) => ({
              ok: false,
              error: String(e?.message || e),
            }));
          }
          receipt.status = 'done';
          receipt.live = Boolean(atol?.ok);
          receipt.fiscalNumber = atol?.ok
            ? atol.uuid || `FN-${String(p.id).slice(-8).toUpperCase()}`
            : `FN-${String(p.id).slice(-8).toUpperCase()}-${Date.now().toString(36).toUpperCase()}`;
          if (atol?.error) receipt.fallbackReason = atol.error;
          receipt.paidAt = p.updatedAt;
        }
      }
      if (status === 'refunded') p.refundedAt = p.updatedAt;
      if (status === 'failed') {
        p.failureReason = String(
          extra.failureReason || 'Провайдер отклонил платёж',
        );
      }
      const order = db.orders.find((x) => x.id === p.orderId);
      if (order) {
        order.paymentStatus =
          status === 'authorized' ? 'pending' : status;
        if (
          status === 'paid' &&
          ['new', 'confirmed', 'awaiting_payment'].includes(order.status)
        ) {
          order.status = 'paid';
          this.orders?.commitReservations?.(db, order, actor);
        }
        if (status === 'refunded') order.status = 'refunded';
        if (status === 'cancelled' || status === 'expired') {
          this.orders?.releaseReservations?.(db, order, actor);
        }
        order.updatedAt = p.updatedAt;
      }
      db.paymentEvents.push({
        id: id('pevt'),
        paymentId: p.id,
        type: 'status_changed',
        status,
        actor,
        at: p.updatedAt,
      });
      return publicPayment(p);
    });
  }

  async sendAtolReceipt(receipt, shop, payment) {
    const atol = shop?.settings?.payments?.atol || {};
    const login = String(atol.login || '').trim();
    const password = String(atol.password || '').trim();
    const groupCode = String(atol.groupCode || atol.group_code || '').trim();
    if (!login || !password || !groupCode || !this.fetch) {
      return { ok: false, error: 'ATOL не настроен' };
    }
    const tokenRes = await this.fetch('https://online.atol.ru/possystem/v5/getToken', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login, pass: password }),
    });
    const tokenData = await tokenRes.json().catch(() => ({}));
    if (!tokenRes.ok || !tokenData.token) {
      throw new Error(tokenData?.error?.text || 'ATOL: не удалось получить токен');
    }
    const receiptRes = await this.fetch(
      `https://online.atol.ru/possystem/v5/${groupCode}/sell`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', token: tokenData.token },
        body: JSON.stringify({
          external_id: receipt.id,
          receipt: {
            client: { email: receipt.company?.email || undefined },
            company: {
              email: receipt.company?.email || 'noreply@gtstore.local',
              sno: receipt.sno,
              inn: receipt.company?.inn,
              payment_address: shop?.settings?.legal?.legalAddress || '',
            },
            items: (receipt.items || []).map((item) => ({
              name: item.name,
              price: item.price,
              quantity: item.quantity,
              sum: item.amount,
              tax: { type: `vat${item.vat}` },
              payment_method: 'full_payment',
              payment_object: 'commodity',
            })),
            payments: [{ type: 1, sum: receipt.total }],
            total: receipt.total,
          },
          timestamp: new Date().toISOString().slice(0, 19).replace('T', ' '),
        }),
      },
    );
    const data = await receiptRes.json().catch(() => ({}));
    if (!receiptRes.ok) {
      throw new Error(data?.error?.text || `ATOL HTTP ${receiptRes.status}`);
    }
    return { ok: true, uuid: data.uuid };
  }

  mapYookassaStatus(status) {
    return (
      {
        pending: 'pending',
        waiting_for_capture: 'authorized',
        succeeded: 'paid',
        canceled: 'cancelled',
      }[status] || null
    );
  }

  async check(userId, workspaceId, shopId, paymentId) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const state = this.store.snapshot();
    const shop = state.shops.find((x) => x.id === shopId);
    const p = (state.payments || []).find(
      (x) => x.id === paymentId && x.shopId === shopId,
    );
    assert(p, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
    const creds = this.yookassaCredentials(shop);
    if (
      p.provider === 'yookassa' &&
      p.externalId &&
      creds &&
      !String(p.externalId).startsWith('yookassa_')
    ) {
      const remote = await this.yookassaRequest(
        'GET',
        `/payments/${p.externalId}`,
        undefined,
        creds,
      );
      const mapped = this.mapYookassaStatus(remote.status);
      if (mapped && mapped !== p.status) {
        return this.mark(paymentId, mapped, userId);
      }
    }
    return publicPayment(p);
  }

  async refund(userId, workspaceId, shopId, paymentId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const state = this.store.snapshot();
    const shop = state.shops.find((x) => x.id === shopId);
    const p = (state.payments || []).find(
      (x) => x.id === paymentId && x.shopId === shopId,
    );
    assert(p, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
    assert(
      p.status === 'paid',
      'PAYMENT_NOT_PAID',
      'Возврат возможен только для оплаченного платежа',
    );
    assert(
      input.amount === undefined || Number(input.amount) === Number(p.amount),
      'PARTIAL_REFUND_UNSUPPORTED',
      'Частичный возврат пока не поддерживается',
    );
    const creds = this.yookassaCredentials(shop);
    if (
      p.provider === 'yookassa' &&
      p.externalId &&
      creds &&
      !String(p.externalId).startsWith('yookassa_')
    ) {
      await this.yookassaRequest(
        'POST',
        '/refunds',
        {
          payment_id: p.externalId,
          amount: {
            value: Number(p.amount).toFixed(2),
            currency: p.currency || 'RUB',
          },
        },
        creds,
      );
    }
    return this.mark(paymentId, 'refunded', userId);
  }

  verify(raw, signature) {
    const expected = crypto
      .createHmac('sha256', this.webhookSecret)
      .update(raw)
      .digest('hex');
    const supplied = String(signature || '').replace(/^sha256=/, '');
    return (
      supplied.length === expected.length &&
      crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    );
  }

  async webhook(provider, body, signature, raw = '') {
    assert(
      allowedProviders.includes(provider) && provider !== 'manual',
      'PAYMENT_PROVIDER_INVALID',
      'Неизвестный провайдер',
      404,
    );

    if (provider === 'yookassa' && body?.object?.id) {
      const event = body.event || body.type || '';
      const object = body.object;
      const state = this.store.snapshot();
      const payment = (state.payments || []).find(
        (x) =>
          x.externalId === object.id ||
          x.id === object.metadata?.paymentId,
      );
      assert(payment, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
      const mapped =
        this.mapYookassaStatus(object.status) ||
        (String(event).includes('canceled') ? 'cancelled' : null) ||
        (String(event).includes('succeeded') ? 'paid' : 'pending');
      return this.mark(payment.id, mapped, `webhook:${provider}`);
    }

    if (provider === 'tbank' && body?.OrderId) {
      const state = this.store.snapshot();
      const payment = (state.payments || []).find(
        (x) => x.id === body.OrderId || x.externalId === String(body.PaymentId || ''),
      );
      assert(payment, 'PAYMENT_NOT_FOUND', 'Платёж не найден', 404);
      const mapped =
        {
          CONFIRMED: 'paid',
          AUTHORIZED: 'authorized',
          REJECTED: 'failed',
          CANCELED: 'cancelled',
          REVERSED: 'cancelled',
        }[String(body.Status || '').toUpperCase()] || 'pending';
      return this.mark(payment.id, mapped, `webhook:${provider}`);
    }

    assert(
      this.verify(raw || JSON.stringify(body), signature),
      'PAYMENT_WEBHOOK_SIGNATURE',
      'Неверная подпись webhook',
      401,
    );
    assert(body.paymentId, 'PAYMENT_ID_REQUIRED', 'paymentId обязателен');
    return this.mark(
      String(body.paymentId),
      String(body.status || 'paid'),
      `webhook:${provider}`,
      { failureReason: body.failureReason },
    );
  }
}
