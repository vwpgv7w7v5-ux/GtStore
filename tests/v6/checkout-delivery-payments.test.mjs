import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gt-checkout-glue-'));
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
      ...(o.headers || {}),
    },
    body: o.body ? JSON.stringify(o.body) : undefined,
  });
  const b = r.status === 204 ? null : await r.json();
  if (!r.ok) {
    throw Object.assign(new Error(b?.error?.message), {
      status: r.status,
      body: b,
    });
  }
  return b;
};

try {
  await req('/bootstrap', {
    method: 'POST',
    body: {
      email: 'glue@test.local',
      password: 'Password123!',
      name: 'Glue',
    },
  });
  const login = await req('/auth/login', {
    method: 'POST',
    body: { email: 'glue@test.local', password: 'Password123!' },
  });
  const auth = { authorization: `Bearer ${login.token}` };
  const me = await req('/me', { headers: auth });
  const ws = me.workspaces[0];
  const shop = (
    await req(`/workspaces/${ws.id}/shops`, { headers: auth })
  )[0];
  const cat = await req(
    `/workspaces/${ws.id}/shops/${shop.id}/categories`,
    { method: 'POST', headers: auth, body: { name: 'Glue' } },
  );
  const product = await req(
    `/workspaces/${ws.id}/shops/${shop.id}/products`,
    {
      method: 'POST',
      headers: auth,
      body: {
        name: 'Glue item',
        sku: 'GLUE-1',
        categoryId: cat.id,
        price: 1000,
        stock: 5,
        active: true,
      },
    },
  );

  const config = await req(`/public/storefronts/${shop.slug}/checkout-config`);
  assert.equal(config.deliveryMethods.length, 2);
  assert.ok(config.paymentMethods.some((m) => m.id === 'yookassa'));
  assert.ok(config.paymentMethods.some((m) => m.id === 'cash'));

  await req(`/workspaces/${ws.id}/shops/${shop.id}/delivery/methods`, {
    method: 'POST',
    headers: auth,
    body: {
      provider: 'courier',
      name: 'Экспресс',
      price: 500,
      freeFrom: 5000,
      active: true,
    },
  });

  const quote = await req(`/public/storefronts/${shop.slug}/checkout/quote`, {
    method: 'POST',
    body: {
      deliveryMethod: (
        await req(`/public/storefronts/${shop.slug}/delivery/methods`)
      ).find((m) => m.provider === 'courier').id,
      items: [{ productId: product.id, quantity: 1 }],
    },
  });
  assert.equal(quote.deliveryPrice, 500);
  assert.equal(quote.total, 1500);

  const online = await req(`/public/storefronts/${shop.slug}/orders`, {
    method: 'POST',
    body: {
      customer: { name: 'Buyer', phone: '+79991112233' },
      deliveryMethod: 'pickup',
      paymentMethod: 'yookassa',
      utm: { source: 'telegram', medium: 'bot', campaign: 'spring' },
      items: [{ productId: product.id, quantity: 1 }],
    },
  });
  assert.equal(online.paymentMethod, 'yookassa');
  assert.ok(online.payment);
  assert.ok(online.checkoutUrl.includes('yookassa'));
  assert.equal(online.status, 'awaiting_payment');
  assert.equal(online.utm.source, 'telegram');

  const cash = await req(`/public/storefronts/${shop.slug}/orders`, {
    method: 'POST',
    body: {
      customer: { name: 'Cash', phone: '+79991112234' },
      deliveryMethod: 'courier',
      paymentMethod: 'cash',
      address: 'Москва, Тверская 1',
      items: [{ productId: product.id, quantity: 1 }],
    },
  });
  assert.equal(cash.paymentMethod, 'cash');
  assert.equal(cash.payment, null);
  assert.equal(cash.deliveryPrice, 500);
  assert.equal(cash.total, 1500);

  console.log('V6 checkout delivery payments glue tests passed');
} finally {
  await new Promise((r) => server.close(r));
  fs.rmSync(dir, { recursive: true, force: true });
}
