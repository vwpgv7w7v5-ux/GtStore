import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const money = value => Math.round(Math.max(0, Number(value) || 0) * 100) / 100;
const integer = value => Math.max(0, Math.floor(Number(value) || 0));
const transitions = {
  new: ['confirmed','cancelled'],
  confirmed: ['awaiting_payment','paid','assembling','cancelled'],
  awaiting_payment: ['paid','cancelled'],
  paid: ['assembling','refunded'],
  assembling: ['ready','cancelled'],
  ready: ['shipped','completed','cancelled'],
  shipped: ['completed','refunded'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

const offlinePayments = new Set(['cash', 'transfer']);
const onlinePayments = new Set([
  'yookassa',
  'cloudpayments',
  'stripe',
  'manual',
  'tbank',
  'tochka',
  'yapay',
  'split',
]);

export class OrderService {
  constructor(store, tenancy) { this.store = store; this.tenancy = tenancy; this.referrals = null; }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    const shop = context.state.shops.find(item => item.id === shopId && item.workspaceId === workspaceId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return { ...context, shop };
  }

  async resolveDelivery(slug, requested, subtotal = 0, location = {}) {
    const requestedId = String(requested || 'pickup');
    if (this.delivery) {
      const quoted = await this.delivery.quote(slug, {
        subtotal,
        address: location.address,
        city: location.city,
        region: location.region,
        lat: location.lat,
        lng: location.lng,
        pickupPointId: location.pickupPointId,
      });
      let method =
        quoted.find((m) => m.id === requestedId) ||
        quoted.find((m) => m.provider === requestedId);
      if (!method && ['pickup', 'courier'].includes(requestedId)) {
        return {
          id: requestedId,
          provider: requestedId,
          name: requestedId === 'courier' ? 'Курьер' : 'Самовывоз',
          calculatedPrice: requestedId === 'courier' ? 350 : 0,
          requiresAddress: requestedId !== 'pickup',
          courierZoneId: null,
          zoneLabel: null,
        };
      }
      if (!method) method = quoted[0];
      const provider = method.provider || method.id;
      return {
        id: method.id,
        provider,
        name: method.name,
        calculatedPrice: money(method.calculatedPrice),
        requiresAddress: provider !== 'pickup',
        courierZoneId: method.courierZoneId || null,
        zoneLabel: method.zoneLabel || null,
        lat: method.lat ?? null,
        lng: method.lng ?? null,
      };
    }
    const id = ['pickup', 'courier'].includes(requestedId) ? requestedId : 'pickup';
    return {
      id,
      provider: id,
      name: id === 'courier' ? 'Курьер' : 'Самовывоз',
      calculatedPrice: id === 'courier' ? 350 : 0,
      requiresAddress: id === 'courier',
    };
  }

  resolvePaymentMethod(requested) {
    const method = String(requested || 'cash').toLowerCase();
    if (offlinePayments.has(method) || onlinePayments.has(method)) return method;
    return 'cash';
  }

  isOnlinePayment(method) {
    return [
      'yookassa',
      'cloudpayments',
      'stripe',
      'tbank',
      'tochka',
      'yapay',
      'split',
    ].includes(method);
  }

  checkoutMethodEnabled(shop, methodId) {
    const flags = shop?.settings?.payments?.checkoutMethods;
    if (!flags || typeof flags !== 'object') return true;
    if (!Object.prototype.hasOwnProperty.call(flags, methodId)) return true;
    return flags[methodId] !== false;
  }

  buildPaymentMethods(shop) {
    const providers = this.payments ? this.payments.providers(shop) : [];
    const online = providers
      .filter(
        (p) =>
          p.mode === 'online' &&
          p.implemented &&
          p.code !== 'stripe' &&
          p.code !== 'cloudpayments',
      )
      .map((p) => ({
        id: p.code,
        name: p.live ? `Онлайн · ${p.name}` : `Онлайн · ${p.name} (sandbox)`,
        online: true,
        live: p.live,
      }));
    const all = [
      { id: 'cash', name: 'При получении', online: false },
      { id: 'transfer', name: 'Перевод', online: false },
      ...online,
    ];
    const visible = all.filter((method) => this.checkoutMethodEnabled(shop, method.id));
    return visible.length
      ? visible
      : [{ id: 'cash', name: 'При получении', online: false }];
  }

  checkoutConfig(slug) {
    const state = this.store.snapshot();
    const shop = state.shops.find(item => item.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const deliveryMethods = this.delivery
      ? this.delivery.publicMethods(slug).map((m) => ({
          id: m.id,
          provider: m.provider || m.id,
          name: m.name,
          price: money(m.price),
          description: m.description || '',
          requiresAddress: !['pickup'].includes(m.provider || m.id),
          supportsPvz: ['apiship', 'cdek', 'boxberry', 'russian_post', 'yandex', 'dpd'].includes(
            m.provider || m.id,
          ),
        }))
      : [
          { id: 'pickup', provider: 'pickup', name: 'Самовывоз', price: 0, description: 'Забрать заказ в магазине', requiresAddress: false },
          { id: 'courier', provider: 'courier', name: 'Курьер', price: 350, description: 'Доставка по городу', requiresAddress: true },
        ];
    const legal = this.payments ? this.payments.legalEntity(shop) : null;
    const fiscal = this.payments ? this.payments.fiscalSettings(shop) : null;
    return {
      deliveryMethods,
      paymentMethods: this.buildPaymentMethods(shop),
      requiredCustomerFields: ['name', 'phone'],
      legal: legal
        ? { companyName: legal.companyName, inn: legal.inn, vatRate: legal.vatRate }
        : null,
      fiscal,
      cartEnabled: shop.settings?.storefront?.cartEnabled !== false,
    };
  }

  async quotePublic(slug, input = {}) {
    const state=this.store.snapshot(); const shop=state.shops.find(item=>item.slug===slug);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    const items=Array.isArray(input.items)?input.items:[]; let subtotal=0;
    for(const requested of items){const product=state.products.find(item=>item.id===requested.productId&&item.shopId===shop.id&&item.active&&!item.archived);assert(product,'PRODUCT_NOT_FOUND','Один из товаров недоступен',404);const variant=requested.variantId?product.variants?.find(v=>v.id===requested.variantId&&v.active!==false):null;const quantity=integer(requested.quantity||1);subtotal+=money(Number(variant?.price??product.price)*quantity);}
    const delivery = await this.resolveDelivery(slug, input.deliveryMethod, money(subtotal), {
      address: input.address,
      city: input.city,
      region: input.region,
      lat: input.lat,
      lng: input.lng,
      pickupPointId: input.pickupPointId,
    });
    const deliveryPrice = delivery.calculatedPrice;
    const pricing=this.promotions?this.promotions.quote(state,shop.id,{subtotal:money(subtotal),customer:input.customer||{},promoCode:input.promoCode,bonusRequested:input.bonusRequested}):{promoDiscount:0,bonusUsed:0,totalDiscount:0,bonusBalance:0,bonusCap:0,promo:null};
    const afterPromo=money(Number(subtotal)-Number(pricing.promoDiscount||0));
    const referralQuote=this.referrals&&input.referralCode
      ?this.referrals.quoteRefereeDiscount(shop,input.referralCode,afterPromo,{
        refereeTelegramId:input.customer?.telegramId||'',
        refereePhone:input.customer?.phone||'',
      })
      :{discount:0};
    const referralDiscount=money(referralQuote.discount||0);
    const totalDiscount=money(Number(pricing.totalDiscount||0)+referralDiscount);
    return{
      subtotal:money(subtotal),
      deliveryPrice,
      deliveryMethod:delivery.id,
      courierZoneId:delivery.courierZoneId||null,
      zoneLabel:delivery.zoneLabel||null,
      lat:delivery.lat??null,
      lng:delivery.lng??null,
      promoDiscount:pricing.promoDiscount,
      bonusUsed:pricing.bonusUsed,
      referralDiscount,
      totalDiscount,
      total:money(subtotal+deliveryPrice-totalDiscount),
      bonusBalance:pricing.bonusBalance,
      bonusCap:pricing.bonusCap,
      promoCode:pricing.promo?.code||null,
      referralCode:referralQuote.referral?.code||null,
    };
  }

  async createPublic(slug, input = {}) {
    const customer = input.customer || {};
    const items = Array.isArray(input.items) ? input.items : [];
    assert(String(customer.name || '').trim().length >= 2, 'CUSTOMER_NAME_REQUIRED', 'Укажите имя');
    assert(String(customer.phone || '').replace(/\D/g,'').length >= 7, 'CUSTOMER_PHONE_REQUIRED', 'Укажите телефон');
    assert(items.length > 0, 'ORDER_ITEMS_REQUIRED', 'Корзина пуста');
    const paymentMethod = this.resolvePaymentMethod(input.paymentMethod);
    const allowedPayments = new Set(
      this.checkoutConfig(slug).paymentMethods.map((method) => method.id),
    );
    assert(
      allowedPayments.has(paymentMethod),
      'PAYMENT_METHOD_DISABLED',
      'Этот способ оплаты сейчас недоступен',
      400,
    );
    const utm = input.utm && typeof input.utm === 'object' ? {
      source: String(input.utm.source || input.utm.utm_source || '').trim(),
      medium: String(input.utm.medium || input.utm.utm_medium || '').trim(),
      campaign: String(input.utm.campaign || input.utm.utm_campaign || '').trim(),
      content: String(input.utm.content || input.utm.utm_content || '').trim(),
      term: String(input.utm.term || input.utm.utm_term || '').trim(),
    } : null;

    return this.store.transaction('public-checkout', async db => {
      db.orders ||= []; db.orderEvents ||= []; db.stockMovements ||= []; db.notifications ||= []; db.stockMovements ||= [];
      const shop = db.shops.find(item => item.slug === slug);
      assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
      const lines = [];
      for (const requested of items) {
        const quantity = integer(requested.quantity || 1);
        assert(quantity > 0 && quantity <= 99, 'INVALID_QUANTITY', 'Некорректное количество');
        const product = db.products.find(item => item.id === requested.productId && item.shopId === shop.id && item.active && !item.archived);
        assert(product, 'PRODUCT_NOT_FOUND', 'Один из товаров недоступен', 404);
        let variant = null;
        if (requested.variantId) {
          variant = product.variants?.find(item => item.id === requested.variantId && item.active !== false);
          assert(variant, 'VARIANT_NOT_FOUND', 'Вариант товара недоступен', 404);
        }
        const physical = variant ? integer(variant.stock) : integer(product.stock);
        db.stockReservations ||= [];
        const reserved = db.stockReservations
          .filter((r) => r.shopId === shop.id && r.productId === product.id && (r.variantId || null) === (variant?.id || null) && r.status === 'active')
          .reduce((sum, r) => sum + integer(r.quantity), 0);
        const available = Math.max(0, physical - reserved);
        assert(available >= quantity, 'INSUFFICIENT_STOCK', `Недостаточно товара «${product.name}»`);
        const unitPrice = money(variant?.price ?? product.price);
        lines.push({ id:id('line'), productId:product.id, variantId:variant?.id || null, name:product.name, variantName:variant?.name || '', sku:variant?.sku || product.sku, quantity, unitPrice, total:money(unitPrice * quantity) });
      }
      const subtotal = money(lines.reduce((sum,line)=>sum+line.total,0));
      const delivery = await this.resolveDelivery(slug, input.deliveryMethod, subtotal, {
        address: input.address,
        city: input.city,
        region: input.region,
        lat: input.lat,
        lng: input.lng,
        pickupPointId: input.pickupPointId,
      });
      if (delivery.requiresAddress) {
        assert(String(input.address || '').trim().length >= 5, 'ADDRESS_REQUIRED', 'Укажите адрес доставки');
      }
      const deliveryMethod = delivery.id;
      const deliveryPrice = delivery.calculatedPrice;
      const orderId=id('ord');
      const pricing=this.promotions?this.promotions.apply(db,shop.id,orderId,{subtotal,customer,promoCode:input.promoCode,bonusRequested:input.bonusRequested}):{promoDiscount:0,bonusUsed:0,totalDiscount:0,promo:null};
      const afterPromo=money(subtotal-Number(pricing.promoDiscount||0));
      const hasProductDiscount=lines.some((line)=>{
        const product=db.products.find((p)=>p.id===line.productId);
        const compare=Number(product?.compareAtPrice||product?.oldPrice||0);
        return compare>0&&compare>Number(line.unitPrice||0);
      });
      let referralCodeIn=String(input.referralCode||'').trim().toUpperCase();
      if(!referralCodeIn&&customer.telegramId){
        const profile=(db.customerProfiles||[]).find(
          (item)=>item.shopId===shop.id&&item.key===`tg:${customer.telegramId}`,
        );
        referralCodeIn=String(profile?.referredByCode||'').trim().toUpperCase();
      }
      const referralQuote=this.referrals&&referralCodeIn
        ?this.referrals.quoteRefereeDiscount(shop,referralCodeIn,afterPromo,{
          hasProductDiscount,
          refereeTelegramId:customer.telegramId||'',
          refereePhone:customer.phone||'',
        })
        :{discount:0,referral:null};
      const referralDiscount=money(referralQuote.discount||0);
      const totalDiscount=money(Number(pricing.totalDiscount||0)+referralDiscount);
      const total = money(subtotal + deliveryPrice - totalDiscount);
      const sequence = db.orders.filter(order => order.shopId === shop.id).length + 1;
      const order = {
        id:orderId, number:`${String(sequence).padStart(5,'0')}`, shopId:shop.id, workspaceId:shop.workspaceId,
        status:'new', paymentStatus:'pending', customer:{ name:String(customer.name).trim(), phone:String(customer.phone).trim(), email:String(customer.email||'').trim(), telegramId:String(customer.telegramId||'').trim() },
        deliveryMethod, deliveryProvider: delivery.provider, deliveryPrice,
        courierZoneId: delivery.courierZoneId || null,
        deliveryZoneLabel: delivery.zoneLabel || null,
        deliveryLat: delivery.lat ?? null,
        deliveryLng: delivery.lng ?? null,
        address:String(input.address||'').trim(), city:String(input.city||'').trim(), paymentMethod,
        comment:String(input.comment||'').trim(), lines, subtotal, promoCode:pricing.promo?.code||null, promoDiscount:pricing.promoDiscount, bonusUsed:pricing.bonusUsed, referralCode:referralQuote.referral?.code||null, referralDiscount, discount:totalDiscount, total, source:String(input.source||'web'), utm, createdAt:now(), updatedAt:now(),
      };
      db.orders.push(order);
      db.stockReservations ||= [];
      for (const line of lines) {
        db.stockReservations.push({
          id: id('rsv'),
          shopId: shop.id,
          orderId: order.id,
          productId: line.productId,
          variantId: line.variantId || null,
          quantity: line.quantity,
          status: 'active',
          createdAt: now(),
          updatedAt: now(),
        });
      }
      db.orderEvents.push({ id:id('evt'), orderId:order.id, type:'created', from:null, to:'new', actor:'customer', at:now() });
      db.notifications.push({ id:id('ntf'), shopId:shop.id, type:'new_order', title:`Новый заказ №${order.number}`, message:`${order.customer.name} · ${total.toLocaleString('ru-RU')} ₽`, read:false, createdAt:now() });
      return order;
    });
  }

  commitReservations(db, order, actor) {
    db.stockReservations ||= [];
    db.stockMovements ||= [];
    const active = db.stockReservations.filter(
      (r) => r.orderId === order.id && r.status === 'active',
    );
    for (const reservation of active) {
      const product = db.products.find(
        (item) => item.id === reservation.productId && item.shopId === order.shopId,
      );
      if (!product) {
        reservation.status = 'released';
        reservation.updatedAt = now();
        continue;
      }
      const variant = reservation.variantId
        ? product.variants?.find((item) => item.id === reservation.variantId)
        : null;
      const before = integer(variant ? variant.stock : product.stock);
      const quantity = integer(reservation.quantity);
      assert(before >= quantity, 'INSUFFICIENT_STOCK', `Недостаточно товара «${product.name}»`, 409);
      if (variant) variant.stock = before - quantity;
      else product.stock = before - quantity;
      product.updatedAt = now();
      db.stockMovements.push({
        id: id('mov'),
        shopId: order.shopId,
        productId: product.id,
        variantId: variant?.id || null,
        sku: variant?.sku || product.sku,
        name: product.name,
        type: 'sale',
        quantity,
        delta: -quantity,
        before,
        after: before - quantity,
        reason: 'Списание по оплаченному/подтверждённому заказу',
        reference: order.id,
        actor,
        createdAt: now(),
      });
      reservation.status = 'committed';
      reservation.updatedAt = now();
    }
  }

  releaseReservations(db, order, actor) {
    db.stockReservations ||= [];
    for (const reservation of db.stockReservations) {
      if (reservation.orderId === order.id && reservation.status === 'active') {
        reservation.status = 'released';
        reservation.updatedAt = now();
        reservation.releasedBy = actor;
      }
    }
  }

  list(userId, workspaceId, shopId, filters = {}) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    const query = String(filters.query || '').trim().toLowerCase();
    const status = String(filters.status || 'all');
    return (state.orders || []).filter(order => order.shopId === shopId)
      .filter(order => status === 'all' || order.status === status)
      .filter(order => !query || `${order.number} ${order.customer?.name||''} ${order.customer?.phone||''}`.toLowerCase().includes(query))
      .sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }

  get(userId, workspaceId, shopId, orderId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    const order = (state.orders || []).find(item => item.id === orderId && item.shopId === shopId);
    assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
    return { ...order, events:(state.orderEvents || []).filter(event => event.orderId === orderId) };
  }

  async update(userId, workspaceId, shopId, orderId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, db => {
      db.orders ||= []; db.orderEvents ||= []; db.stockMovements ||= [];
      const order = db.orders.find(item => item.id === orderId && item.shopId === shopId);
      assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
      if (input.status && input.status !== order.status) {
        assert(transitions[order.status]?.includes(input.status), 'INVALID_ORDER_TRANSITION', `Нельзя перевести заказ из «${order.status}» в «${input.status}»`);
        const previous = order.status;
        if (input.status === 'cancelled' && previous !== 'cancelled') {
          const committed = (db.stockReservations || []).some(
            (r) => r.orderId === order.id && r.status === 'committed',
          );
          if (committed) {
            for (const line of order.lines) {
              const product = db.products.find(item => item.id === line.productId && item.shopId === shopId);
              if (!product) continue;
              const variant = line.variantId ? product.variants?.find(item => item.id === line.variantId) : null;
              const beforeStock=integer(variant?variant.stock:product.stock); if (variant) variant.stock += line.quantity; else product.stock += line.quantity;
              const afterStock=beforeStock+line.quantity; product.updatedAt = now(); db.stockMovements.push({id:id('mov'),shopId,productId:product.id,variantId:variant?.id||null,sku:variant?.sku||product.sku,name:product.name,type:'return',quantity:line.quantity,delta:line.quantity,before:beforeStock,after:afterStock,reason:'Возврат остатка при отмене заказа',reference:order.id,actor:userId,createdAt:now()});
            }
          }
          this.releaseReservations(db, order, userId);
        }
        if (['paid', 'confirmed', 'assembling', 'ready', 'shipped', 'completed'].includes(input.status)) {
          this.commitReservations(db, order, userId);
        }
        order.status = input.status;
        db.orderEvents.push({ id:id('evt'), orderId, type:'status_changed', from:previous, to:input.status, actor:userId, at:now() });
      }
      if (input.paymentStatus) order.paymentStatus = input.paymentStatus;
      if (input.comment !== undefined) order.comment = String(input.comment || '');
      if (input.internalNote !== undefined) order.internalNote = String(input.internalNote || '');
      order.updatedAt = now();
      return order;
    });
  }

  metrics(userId, workspaceId, shopId) {
    const orders = this.list(userId, workspaceId, shopId);
    const active = orders.filter(order => !['cancelled','refunded'].includes(order.status));
    return {
      total:orders.length,
      new:orders.filter(order=>order.status==='new').length,
      processing:orders.filter(order=>['confirmed','awaiting_payment','paid','assembling','ready','shipped'].includes(order.status)).length,
      revenue:money(active.filter(order=>order.paymentStatus==='paid'||order.status==='completed').reduce((sum,order)=>sum+order.total,0)),
      average:active.length ? money(active.reduce((sum,order)=>sum+order.total,0)/active.length) : 0,
    };
  }
}
