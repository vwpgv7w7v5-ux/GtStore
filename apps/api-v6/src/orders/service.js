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

export class OrderService {
  constructor(store, tenancy) { this.store = store; this.tenancy = tenancy; }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    const shop = context.state.shops.find(item => item.id === shopId && item.workspaceId === workspaceId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return { ...context, shop };
  }

  checkoutConfig(slug) {
    const state = this.store.snapshot();
    const shop = state.shops.find(item => item.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return {
      deliveryMethods: [
        { id:'pickup', name:'Самовывоз', price:0, description:'Забрать заказ в магазине' },
        { id:'courier', name:'Курьер', price:350, description:'Доставка по городу' },
      ],
      paymentMethods: [
        { id:'cash', name:'При получении' },
        { id:'transfer', name:'Перевод' },
      ],
      requiredCustomerFields:['name','phone'],
    };
  }

  quotePublic(slug, input = {}) {
    const state=this.store.snapshot(); const shop=state.shops.find(item=>item.slug===slug);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    const items=Array.isArray(input.items)?input.items:[]; let subtotal=0;
    for(const requested of items){const product=state.products.find(item=>item.id===requested.productId&&item.shopId===shop.id&&item.active&&!item.archived);assert(product,'PRODUCT_NOT_FOUND','Один из товаров недоступен',404);const variant=requested.variantId?product.variants?.find(v=>v.id===requested.variantId&&v.active!==false):null;const quantity=integer(requested.quantity||1);subtotal+=money(Number(variant?.price??product.price)*quantity);}
    const deliveryMethod=['pickup','courier'].includes(input.deliveryMethod)?input.deliveryMethod:'pickup'; const deliveryPrice=deliveryMethod==='courier'?350:0;
    const pricing=this.promotions?this.promotions.quote(state,shop.id,{subtotal:money(subtotal),customer:input.customer||{},promoCode:input.promoCode,bonusRequested:input.bonusRequested}):{promoDiscount:0,bonusUsed:0,totalDiscount:0,bonusBalance:0,bonusCap:0,promo:null};
    return{subtotal:money(subtotal),deliveryPrice,promoDiscount:pricing.promoDiscount,bonusUsed:pricing.bonusUsed,totalDiscount:pricing.totalDiscount,total:money(subtotal+deliveryPrice-pricing.totalDiscount),bonusBalance:pricing.bonusBalance,bonusCap:pricing.bonusCap,promoCode:pricing.promo?.code||null};
  }

  async createPublic(slug, input = {}) {
    const customer = input.customer || {};
    const items = Array.isArray(input.items) ? input.items : [];
    assert(String(customer.name || '').trim().length >= 2, 'CUSTOMER_NAME_REQUIRED', 'Укажите имя');
    assert(String(customer.phone || '').replace(/\D/g,'').length >= 7, 'CUSTOMER_PHONE_REQUIRED', 'Укажите телефон');
    assert(items.length > 0, 'ORDER_ITEMS_REQUIRED', 'Корзина пуста');
    const deliveryMethod = ['pickup','courier'].includes(input.deliveryMethod) ? input.deliveryMethod : 'pickup';
    const paymentMethod = ['cash','transfer'].includes(input.paymentMethod) ? input.paymentMethod : 'cash';
    if (deliveryMethod === 'courier') assert(String(input.address || '').trim().length >= 5, 'ADDRESS_REQUIRED', 'Укажите адрес доставки');

    return this.store.transaction('public-checkout', db => {
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
        const available = variant ? integer(variant.stock) : integer(product.stock);
        assert(available >= quantity, 'INSUFFICIENT_STOCK', `Недостаточно товара «${product.name}»`);
        const unitPrice = money(variant?.price ?? product.price);
        const beforeStock = available; if (variant) variant.stock -= quantity; else product.stock -= quantity;
        const afterStock = beforeStock - quantity; product.updatedAt = now(); product.version = (product.version || 1) + 1;
        db.stockMovements.push({ id:id('mov'), shopId:shop.id, productId:product.id, variantId:variant?.id||null, sku:variant?.sku||product.sku, name:product.name, type:'sale', quantity, delta:-quantity, before:beforeStock, after:afterStock, reason:'Резерв под новый заказ', reference:null, actor:'public-checkout', createdAt:now() });
        lines.push({ id:id('line'), productId:product.id, variantId:variant?.id || null, name:product.name, variantName:variant?.name || '', sku:variant?.sku || product.sku, quantity, unitPrice, total:money(unitPrice * quantity) });
      }
      const subtotal = money(lines.reduce((sum,line)=>sum+line.total,0));
      const deliveryPrice = deliveryMethod === 'courier' ? 350 : 0;
      const orderId=id('ord');
      const pricing=this.promotions?this.promotions.apply(db,shop.id,orderId,{subtotal,customer,promoCode:input.promoCode,bonusRequested:input.bonusRequested}):{promoDiscount:0,bonusUsed:0,totalDiscount:0,promo:null};
      const total = money(subtotal + deliveryPrice - pricing.totalDiscount);
      const sequence = db.orders.filter(order => order.shopId === shop.id).length + 1;
      const order = {
        id:orderId, number:`${String(sequence).padStart(5,'0')}`, shopId:shop.id, workspaceId:shop.workspaceId,
        status:'new', paymentStatus:'pending', customer:{ name:String(customer.name).trim(), phone:String(customer.phone).trim(), email:String(customer.email||'').trim(), telegramId:String(customer.telegramId||'').trim() },
        deliveryMethod, deliveryPrice, address:String(input.address||'').trim(), paymentMethod,
        comment:String(input.comment||'').trim(), lines, subtotal, promoCode:pricing.promo?.code||null, promoDiscount:pricing.promoDiscount, bonusUsed:pricing.bonusUsed, discount:pricing.totalDiscount, total, source:String(input.source||'web'), createdAt:now(), updatedAt:now(),
      };
      db.orders.push(order);
      for (let i=db.stockMovements.length-1;i>=0;i--){const movement=db.stockMovements[i];if(movement.shopId===shop.id&&movement.actor==='public-checkout'&&!movement.reference)movement.reference=order.id;else if(movement.reference)break;}
      db.orderEvents.push({ id:id('evt'), orderId:order.id, type:'created', from:null, to:'new', actor:'customer', at:now() });
      db.notifications.push({ id:id('ntf'), shopId:shop.id, type:'new_order', title:`Новый заказ №${order.number}`, message:`${order.customer.name} · ${total.toLocaleString('ru-RU')} ₽`, read:false, createdAt:now() });
      return order;
    });
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
          for (const line of order.lines) {
            const product = db.products.find(item => item.id === line.productId && item.shopId === shopId);
            if (!product) continue;
            const variant = line.variantId ? product.variants?.find(item => item.id === line.variantId) : null;
            const beforeStock=integer(variant?variant.stock:product.stock); if (variant) variant.stock += line.quantity; else product.stock += line.quantity;
            const afterStock=beforeStock+line.quantity; product.updatedAt = now(); db.stockMovements.push({id:id('mov'),shopId,productId:product.id,variantId:variant?.id||null,sku:variant?.sku||product.sku,name:product.name,type:'return',quantity:line.quantity,delta:line.quantity,before:beforeStock,after:afterStock,reason:'Возврат остатка при отмене заказа',reference:order.id,actor:userId,createdAt:now()});
          }
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
