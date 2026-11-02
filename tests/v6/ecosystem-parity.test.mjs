import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gtstore-eco-'));
const { server } = createApp({
  databaseFile: path.join(dir, 'db.json'),
  mediaDirectory: path.join(dir, 'media'),
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}/api/v6`;
const req = async (p, o = {}) => {
  const r = await fetch(base + p, {
    ...o,
    headers: {
      'content-type': 'application/json',
      ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
      ...(o.headers || {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const ct = r.headers.get('content-type') || '';
  const b =
    r.status === 204
      ? null
      : ct.includes('xml') || ct.includes('text')
        ? await r.text()
        : await r.json();
  if (!r.ok)
    throw Object.assign(new Error(b?.error?.message || String(b)), {
      status: r.status,
      body: b,
    });
  return b;
};

try {
  const boot = await req('/bootstrap', {
    method: 'POST',
    body: {
      email: 'eco@test.local',
      password: 'Password123!',
      name: 'Owner',
    },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'eco@test.local', password: 'Password123!' },
  });
  const token = login.token;
  const ws = boot.workspace;
  const shop = boot.shop;
  const root = `/workspaces/${ws.id}/shops/${shop.id}`;

  // Delivery: ApiShip carriers + zones + PVZ
  const carriers = await req('/delivery/carriers');
  assert.ok(carriers.length >= 40);
  assert.ok(carriers.some((c) => c.code === 'cdek'));
  const providers = await req('/delivery/providers');
  assert.ok(providers.some((p) => p.id === 'apiship'));
  const zone = await req(root + '/delivery/zones', {
    method: 'POST',
    token,
    body: {
      name: 'Центр',
      price: 299,
      center: { lat: 55.75, lng: 37.62 },
      radiusKm: 4,
    },
  });
  assert.equal(zone.price, 299);
  await req(root + '/delivery/methods', {
    method: 'POST',
    token,
    body: { provider: 'apiship', name: 'ApiShip ПВЗ', price: 390, active: true },
  });
  const points = await req(
    `/public/storefronts/${shop.slug}/delivery/points?city=Москва&carrier=apiship`,
  );
  assert.ok(points.points.length >= 6);
  const quote = await req(`/public/storefronts/${shop.slug}/delivery/quote`, {
    method: 'POST',
    body: { subtotal: 1000, lat: 55.75, lng: 37.62, city: 'Москва' },
  });
  assert.ok(quote.some((q) => q.courierZoneId === zone.id || q.supportsPvz));

  // Payments: providers + legal + receipts sandbox
  const paySettings = await req(root + '/payments/settings', {
    method: 'PUT',
    token,
    body: {
      tbank: { terminalKey: 'TBankDemo', token: 'secret-tbank' },
      tochka: { shopId: 'tochka1', secretKey: 'secret-tochka' },
      yapay: { shopId: 'yapay1', token: 'secret-yapay' },
      split: { shopId: 'split1', token: 'secret-split' },
      legal: {
        companyName: 'ООО Тест',
        inn: '7701234567',
        vatRate: 20,
        taxSystem: 'osn',
        receiptEnabled: true,
      },
      fiscal: { enabled: true, vatRate: 20, sno: 'osn' },
    },
  });
  assert.equal(paySettings.legal.inn, '7701234567');
  assert.ok(paySettings.providers.some((p) => p.code === 'tbank' && p.live));
  assert.ok(paySettings.providers.some((p) => p.code === 'yapay'));

  const cat = await req(root + '/categories', {
    method: 'POST',
    token,
    body: { name: 'Eco' },
  });
  const product = await req(root + '/products', {
    method: 'POST',
    token,
    body: {
      name: 'Eco Item',
      sku: 'ECO-1',
      categoryId: cat.id,
      price: 1500,
      stock: 5,
      active: true,
    },
  });
  const order = await req(`/public/storefronts/${shop.slug}/orders`, {
    method: 'POST',
    body: {
      customer: { name: 'Kirill', phone: '+79991112233' },
      items: [{ productId: product.id, quantity: 1 }],
      deliveryMethod: 'courier',
      paymentMethod: 'tbank',
      address: 'Moscow',
    },
  });
  const payment = await req(`/public/storefronts/${shop.slug}/payments`, {
    method: 'POST',
    body: { orderId: order.id, provider: 'tbank' },
  });
  assert.equal(payment.provider, 'tbank');
  assert.ok(payment.checkoutUrl);
  assert.ok(payment.receiptId);

  // MAX channel
  const max = await req(root + '/max/connect', {
    method: 'POST',
    token,
    body: { token: 'max-token-demo-123456', channelId: 'chan-1' },
  });
  assert.equal(max.connected, true);
  const post = await req(root + '/channel-posts', {
    method: 'POST',
    token,
    body: { channel: 'max', text: 'Привет из GtStore', channelId: 'chan-1' },
  });
  assert.equal(post.status, 'published');

  // YML feed
  await req(root + '/storefront', {
    method: 'PATCH',
    token,
    body: {
      theme: { cartEnabled: false, showcaseOnly: true },
      seo: { title: 'Eco' },
      blocks: [{ id: 'b1', type: 'products', visible: true, settings: { title: 'Каталог' } }],
    },
  });
  await req(root + '/storefront/publish', { method: 'POST', token });
  const yml = await req(`/public/storefronts/${shop.slug}/feed.yml`);
  assert.ok(String(yml).includes('<yml_catalog'));
  assert.ok(String(yml).includes('Eco Item'));

  // Import job schedule
  const job = await req(root + '/import-jobs', {
    method: 'POST',
    token,
    body: {
      url: 'https://example.com/feed.yml',
      intervalMinutes: 30,
      type: 'yml',
    },
  });
  assert.equal(job.intervalMinutes, 30);

  // ERP
  const erp = await req(root + '/erp', {
    method: 'POST',
    token,
    body: { provider: 'moysklad', token: 'ms-token' },
  });
  const test = await req(root + `/erp/${erp.id}/test`, { method: 'POST', token });
  assert.equal(test.ok, true);
  const sync = await req(root + `/erp/${erp.id}/sync`, {
    method: 'POST',
    token,
    body: { direction: 'pull' },
  });
  assert.equal(sync.ok, true);
  const logs = await req(root + '/integration-logs', { token });
  assert.ok(logs.length >= 2);

  // Metrika / cartless settings
  const analytics = await req(root + '/analytics/settings', {
    method: 'PUT',
    token,
    body: { metrikaId: '12345678', cartEnabled: false, showcaseOnly: true },
  });
  assert.equal(analytics.metrikaId, '12345678');
  assert.equal(analytics.showcaseOnly, true);
  const publicStore = await req(`/public/storefronts/${shop.slug}`);
  assert.equal(publicStore.cartEnabled, false);
  assert.equal(publicStore.shop.settings.analytics.metrikaId, '12345678');

  // Team permissions
  const team = await req(`/workspaces/${ws.id}/team`, { token });
  assert.ok(team.permissions?.roles?.manager?.includes('orders.write'));
  assert.ok(team.members[0].permissions.length > 0);

  // Chats reply path for max sandbox
  await req(`/public/max/${shop.id}/webhook`, {
    method: 'POST',
    body: { text: 'Здравствуйте', sender: { id: 'u1', username: 'client' } },
  });
  const threads = await req(root + '/chats', { token });
  assert.ok(threads.some((t) => t.channel === 'max'));

  console.log('V6.21 ecosystem parity tests passed');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
