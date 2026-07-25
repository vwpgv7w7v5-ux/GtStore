import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();
const triggerTypes = new Set(['order_created', 'order_status_changed']);
const orderStatuses = new Set(['new','confirmed','awaiting_payment','paid','assembling','ready','shipped','completed','cancelled','refunded']);
const replaceVars = (template, context) => String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key) => {
  const value = key.split('.').reduce((acc, part) => acc == null ? undefined : acc[part], context);
  return value == null ? '' : String(value);
});

export class AutomationService {
  constructor(store, tenancy, telegram) { this.store = store; this.tenancy = tenancy; this.telegram = telegram; }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    const shop = context.state.shops.find(item => item.id === shopId && item.workspaceId === workspaceId);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return { ...context, shop };
  }

  normalize(input = {}, existing = {}) {
    const name = input.name === undefined ? existing.name : String(input.name || '').trim();
    const trigger = input.trigger === undefined ? existing.trigger : String(input.trigger || '');
    const message = input.message === undefined ? existing.message : String(input.message || '').trim();
    const status = input.status === undefined ? (existing.status || null) : (input.status ? String(input.status) : null);
    const delayMinutes = input.delayMinutes === undefined ? Number(existing.delayMinutes || 0) : Math.max(0, Math.min(10080, Math.floor(Number(input.delayMinutes || 0))));
    const enabled = input.enabled === undefined ? existing.enabled !== false : Boolean(input.enabled);
    assert(name, 'AUTOMATION_NAME_REQUIRED', 'Укажите название сценария');
    assert(triggerTypes.has(trigger), 'AUTOMATION_TRIGGER_INVALID', 'Некорректный триггер сценария');
    assert(message, 'AUTOMATION_MESSAGE_REQUIRED', 'Введите текст сообщения');
    if (trigger === 'order_status_changed') assert(status && orderStatuses.has(status), 'AUTOMATION_STATUS_INVALID', 'Укажите корректный статус заказа');
    return { name, trigger, status: trigger === 'order_status_changed' ? status : null, message, delayMinutes, enabled };
  }

  list(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    const runs = state.automationRuns || [];
    return (state.automationRules || []).filter(rule => rule.shopId === shopId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(rule => ({
      ...rule,
      metrics: {
        total: runs.filter(run => run.ruleId === rule.id).length,
        sent: runs.filter(run => run.ruleId === rule.id && run.status === 'sent').length,
        failed: runs.filter(run => run.ruleId === rule.id && run.status === 'failed').length,
        pending: runs.filter(run => run.ruleId === rule.id && run.status === 'pending').length,
      }
    }));
  }

  get(userId, workspaceId, shopId, ruleId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId);
    const rule = (state.automationRules || []).find(item => item.id === ruleId && item.shopId === shopId);
    assert(rule, 'AUTOMATION_NOT_FOUND', 'Сценарий не найден', 404);
    return { ...rule, runs:(state.automationRuns || []).filter(run => run.ruleId === rule.id).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)) };
  }

  async create(userId, workspaceId, shopId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    const clean = this.normalize(input);
    return this.store.transaction(userId, db => {
      db.automationRules ||= [];
      const rule = { id:id('aut'), workspaceId, shopId, ...clean, createdAt:now(), updatedAt:now() };
      db.automationRules.push(rule);
      return rule;
    });
  }

  async update(userId, workspaceId, shopId, ruleId, input = {}) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, db => {
      const rule = (db.automationRules || []).find(item => item.id === ruleId && item.shopId === shopId);
      assert(rule, 'AUTOMATION_NOT_FOUND', 'Сценарий не найден', 404);
      Object.assign(rule, this.normalize(input, rule), { updatedAt:now() });
      return rule;
    });
  }

  async remove(userId, workspaceId, shopId, ruleId) {
    this.ensureShop(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, db => {
      const index = (db.automationRules || []).findIndex(item => item.id === ruleId && item.shopId === shopId);
      assert(index >= 0, 'AUTOMATION_NOT_FOUND', 'Сценарий не найден', 404);
      const [removed] = db.automationRules.splice(index, 1);
      return removed;
    });
  }

  matchingRules(state, order, event) {
    return (state.automationRules || []).filter(rule => rule.shopId === order.shopId && rule.enabled !== false)
      .filter(rule => rule.trigger === event.type)
      .filter(rule => rule.trigger !== 'order_status_changed' || rule.status === event.to);
  }

  async handleOrderEvent(order, event) {
    if (!order?.customer?.telegramId) return { queued:0, reason:'customer_without_telegram' };
    const state = this.store.snapshot();
    const rules = this.matchingRules(state, order, event);
    for (const rule of rules) {
      const duplicate = (state.automationRuns || []).some(run => run.ruleId === rule.id && run.orderId === order.id && run.eventKey === `${event.type}:${event.to || ''}`);
      if (duplicate) continue;
      await this.store.transaction('automation-engine', db => {
        db.automationRuns ||= [];
        db.automationRuns.push({
          id:id('run'), ruleId:rule.id, shopId:order.shopId, orderId:order.id,
          telegramId:String(order.customer.telegramId), eventKey:`${event.type}:${event.to || ''}`,
          status:'pending', scheduledAt:new Date(Date.now() + rule.delayMinutes * 60000).toISOString(),
          message:replaceVars(rule.message, { order, customer:order.customer, event }), createdAt:now(), updatedAt:now()
        });
      });
    }
    const processed = await this.runDue('event-engine');
    return { queued:rules.length, processed:processed.processed };
  }

  async runDue(actor = 'scheduler') {
    const state = this.store.snapshot();
    const due = (state.automationRuns || []).filter(run => run.status === 'pending' && new Date(run.scheduledAt) <= new Date());
    const results = [];
    for (const run of due) {
      let result;
      try { result = await this.telegram.sendDirect(run.shopId, run.telegramId, run.message); }
      catch { result = { sent:false, reason:'send_failed' }; }
      const saved = await this.store.transaction(actor, db => {
        const current = (db.automationRuns || []).find(item => item.id === run.id);
        if (!current || current.status !== 'pending') return current;
        current.status = result.sent ? 'sent' : 'failed';
        current.reason = result.reason || '';
        current.messageId = result.messageId || null;
        current.sentAt = result.sent ? now() : null;
        current.updatedAt = now();
        return current;
      });
      results.push(saved);
    }
    return { processed:results.length, results };
  }
}
