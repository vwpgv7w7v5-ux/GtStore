import crypto from 'node:crypto';
import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const allowedStatuses = new Set(['confirmed','awaiting_payment','paid','assembling','ready','shipped','completed','cancelled','refunded']);

export class TelegramService {
  constructor(store, tenancy, orders, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.orders = orders;
    this.fetch = options.fetch || globalThis.fetch;
    this.secret = crypto.createHash('sha256').update(String(options.secret || process.env.GTSTORE_TOKEN_SECRET || 'gtstore-local-development-secret')).digest();
  }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    const shop = context.state.shops.find(item => item.id === shopId && item.workspaceId === workspaceId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return { ...context, shop };
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    const encrypted = Buffer.concat([cipher.update(String(value), 'utf8'), cipher.final()]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(payload) {
    const [iv, tag, encrypted] = String(payload || '').split('.');
    assert(iv && tag && encrypted, 'TELEGRAM_TOKEN_INVALID', 'Токен Telegram повреждён', 500);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.secret, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(encrypted, 'base64url')), decipher.final()]).toString('utf8');
  }

  publicConfig(config) {
    if (!config) return { connected:false, enabled:false, adminChatId:'', botUsername:'', webhookUrl:'', updatedAt:null };
    return {
      connected:Boolean(config.tokenEncrypted),
      enabled:Boolean(config.enabled),
      adminChatId:config.adminChatId || '',
      botUsername:config.botUsername || '',
      webhookUrl:config.webhookUrl || '',
      updatedAt:config.updatedAt || null,
      lastError:config.lastError || '',
    };
  }

  getConfig(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    return this.publicConfig((state.telegramConfigs || []).find(item => item.shopId === shopId));
  }

  async api(token, method, payload = {}) {
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const response = await this.fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    assert(response.ok && data.ok, 'TELEGRAM_API_ERROR', data.description || 'Ошибка Telegram API', 502);
    return data.result;
  }

  async connect(userId, workspaceId, shopId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    const token = String(input.token || '').trim();
    assert(/^\d+:[A-Za-z0-9_-]{20,}$/.test(token), 'TELEGRAM_TOKEN_INVALID', 'Некорректный токен Telegram');
    const bot = await this.api(token, 'getMe');
    const webhookUrl = String(input.webhookUrl || '').trim();
    if (webhookUrl) await this.api(token, 'setWebhook', { url:webhookUrl, secret_token:String(input.webhookSecret || '') || undefined });
    return this.store.transaction(userId, db => {
      db.telegramConfigs ||= [];
      let config = db.telegramConfigs.find(item => item.shopId === shopId);
      const data = {
        workspaceId, shopId, tokenEncrypted:this.encrypt(token), adminChatId:String(input.adminChatId || '').trim(),
        botId:String(bot.id), botUsername:bot.username || '', enabled:input.enabled !== false, webhookUrl,
        webhookSecret:String(input.webhookSecret || '').trim(), updatedAt:now(), lastError:'',
      };
      if (config) Object.assign(config, data); else { config = { id:id('tgc'), createdAt:now(), ...data }; db.telegramConfigs.push(config); }
      return this.publicConfig(config);
    });
  }

  async disconnect(userId, workspaceId, shopId) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, db => {
      db.telegramConfigs ||= [];
      const config = db.telegramConfigs.find(item => item.shopId === shopId);
      if (config?.tokenEncrypted) this.api(this.decrypt(config.tokenEncrypted), 'deleteWebhook', {drop_pending_updates:false}).catch(() => undefined);
      db.telegramConfigs = db.telegramConfigs.filter(item => item.shopId !== shopId);
      return { connected:false };
    });
  }

  formatOrder(order) {
    const lines = order.lines.map(line => `• ${line.name}${line.variantName ? ` — ${line.variantName}` : ''} × ${line.quantity} = ${line.total.toLocaleString('ru-RU')} ₽`).join('\n');
    return [`🛒 Новый заказ №${order.number}`, '', lines, '', `Итого: ${order.total.toLocaleString('ru-RU')} ₽`, `Клиент: ${order.customer.name}`, `Телефон: ${order.customer.phone}`, `Доставка: ${order.deliveryMethod === 'courier' ? 'Курьер' : 'Самовывоз'}`, order.address ? `Адрес: ${order.address}` : '', order.comment ? `Комментарий: ${order.comment}` : ''].filter(Boolean).join('\n');
  }

  keyboard(order) {
    return { inline_keyboard:[
      [{text:'✅ Подтвердить',callback_data:`order:${order.id}:confirmed`},{text:'💳 Оплачен',callback_data:`order:${order.id}:paid`}],
      [{text:'📦 Сборка',callback_data:`order:${order.id}:assembling`},{text:'🚚 Готов',callback_data:`order:${order.id}:ready`}],
      [{text:'🏁 Завершить',callback_data:`order:${order.id}:completed`},{text:'❌ Отменить',callback_data:`order:${order.id}:cancelled`}],
    ]};
  }

  async notifyNewOrder(order) {
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(item => item.shopId === order.shopId && item.enabled && item.tokenEncrypted && item.adminChatId);
    if (!config) return { sent:false, reason:'not_configured' };
    try {
      const message = await this.api(this.decrypt(config.tokenEncrypted), 'sendMessage', {
        chat_id:config.adminChatId, text:this.formatOrder(order), reply_markup:this.keyboard(order), disable_web_page_preview:true,
      });
      await this.store.transaction('telegram-notifier', db => {
        db.telegramMessages ||= [];
        db.telegramMessages.push({id:id('tgm'),shopId:order.shopId,orderId:order.id,chatId:String(config.adminChatId),messageId:String(message.message_id),createdAt:now()});
      });
      return { sent:true, messageId:message.message_id };
    } catch (error) {
      await this.store.transaction('telegram-notifier', db => { const current=(db.telegramConfigs||[]).find(item=>item.shopId===order.shopId); if(current) current.lastError=error.message; });
      return { sent:false, reason:error.message };
    }
  }

  async sendDirect(shopId, chatId, text) {
    const state=this.store.snapshot(); const config=(state.telegramConfigs||[]).find(item=>item.shopId===shopId&&item.enabled&&item.tokenEncrypted);
    if(!config)return{sent:false,reason:'not_configured'};
    try{const message=await this.api(this.decrypt(config.tokenEncrypted),'sendMessage',{chat_id:String(chatId),text:String(text||'')});return{sent:true,messageId:message.message_id};}catch(error){return{sent:false,reason:error.message};}
  }

  async test(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId, 'manager');
    const config = (state.telegramConfigs || []).find(item => item.shopId === shopId);
    assert(config?.tokenEncrypted && config.adminChatId, 'TELEGRAM_NOT_CONFIGURED', 'Сначала подключите Telegram');
    const message = await this.api(this.decrypt(config.tokenEncrypted), 'sendMessage', {chat_id:config.adminChatId,text:'GtStore: тестовое уведомление доставлено.'});
    return {ok:true,messageId:message.message_id};
  }

  statusText(status) { return ({new:'Заказ создан',confirmed:'Заказ подтверждён',awaiting_payment:'Ожидаем оплату',paid:'Оплата получена',assembling:'Заказ собирается',ready:'Заказ готов',shipped:'Заказ передан в доставку',completed:'Заказ завершён',cancelled:'Заказ отменён',refunded:'Возврат оформлен'})[status] || status; }

  async notifyCustomer(order) {
    const chatId=String(order.customer?.telegramId||'').trim(); if(!chatId)return{sent:false,reason:'telegram_id_missing'};
    const state=this.store.snapshot(); const config=(state.telegramConfigs||[]).find(item=>item.shopId===order.shopId&&item.enabled&&item.tokenEncrypted); if(!config)return{sent:false,reason:'not_configured'};
    try{const message=await this.api(this.decrypt(config.tokenEncrypted),'sendMessage',{chat_id:chatId,text:`Заказ №${order.number}: ${this.statusText(order.status)}.\nСумма: ${order.total.toLocaleString('ru-RU')} ₽`});return{sent:true,messageId:message.message_id};}catch(error){return{sent:false,reason:error.message};}
  }

  async webhook(shopId, update, secret = '') {
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(item => item.shopId === shopId && item.enabled);
    assert(config, 'TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен', 404);
    if (config.webhookSecret) assert(secret === config.webhookSecret, 'TELEGRAM_WEBHOOK_FORBIDDEN', 'Неверный секрет webhook', 403);
    const callback = update?.callback_query;
    if (!callback) return {ok:true,ignored:true};
    const match = /^order:([^:]+):([^:]+)$/.exec(callback.data || '');
    if (!match || !allowedStatuses.has(match[2])) return {ok:true,ignored:true};
    const order = (state.orders || []).find(item => item.id === match[1] && item.shopId === shopId);
    assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
    const membership = state.memberships.find(item => item.workspaceId === order.workspaceId && ['owner','admin','manager'].includes(item.role));
    assert(membership, 'TELEGRAM_ACTOR_NOT_FOUND', 'Не найден сотрудник магазина', 403);
    const updated = await this.orders.update(membership.userId, order.workspaceId, shopId, order.id, {status:match[2]});
    await this.notifyCustomer(updated);
    const token = this.decrypt(config.tokenEncrypted);
    await this.api(token, 'answerCallbackQuery', {callback_query_id:callback.id,text:`Статус: ${updated.status}`}).catch(()=>undefined);
    if (callback.message) await this.api(token, 'editMessageReplyMarkup', {chat_id:callback.message.chat.id,message_id:callback.message.message_id,reply_markup:this.keyboard(updated)}).catch(()=>undefined);
    return {ok:true,orderId:updated.id,status:updated.status};
  }
}
