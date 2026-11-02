import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();

export class MaxService {
  constructor(store, tenancy, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.fetch = options.fetch || globalThis.fetch;
    this.baseUrl = String(
      options.baseUrl || process.env.MAX_API_BASE || 'https://platform-api.max.ru',
    ).replace(/\/$/, '');
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

  status(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    const row = (state.maxChannels || []).find((x) => x.shopId === shopId);
    if (!row) {
      return {
        connected: false,
        enabled: false,
        botUsername: '',
        channelId: '',
        lastError: '',
      };
    }
    return {
      connected: Boolean(row.token),
      enabled: row.enabled !== false,
      botUsername: row.botUsername || '',
      channelId: row.channelId || '',
      publicUrl: row.publicUrl || '',
      mode: row.live ? 'live' : 'sandbox',
      lastError: row.lastError || '',
      updatedAt: row.updatedAt,
    };
  }

  async api(token, path, payload = {}) {
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const response = await this.fetch(`${this.baseUrl}/${path.replace(/^\//, '')}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(data.message || data.error || `MAX API ${response.status}`);
    }
    return data;
  }

  async connect(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'admin');
    const token = String(input.token || '').trim();
    assert(token.length >= 10, 'MAX_TOKEN_REQUIRED', 'Укажите токен MAX');
    let botUsername = String(input.botUsername || '').trim();
    let live = false;
    let lastError = '';
    try {
      const me = await this.api(token, 'me', {});
      botUsername = me.username || me.name || botUsername || 'max_bot';
      live = true;
    } catch (e) {
      lastError = String(e?.message || e);
      botUsername = botUsername || 'max_sandbox';
    }
    return this.store.transaction(userId, (db) => {
      db.maxChannels ||= [];
      let row = db.maxChannels.find((x) => x.shopId === shopId);
      if (!row) {
        row = { id: id('max'), shopId, createdAt: now() };
        db.maxChannels.push(row);
      }
      Object.assign(row, {
        token,
        botUsername,
        channelId: String(input.channelId || row.channelId || ''),
        publicUrl: String(input.publicUrl || row.publicUrl || ''),
        enabled: input.enabled !== false,
        live,
        lastError,
        updatedAt: now(),
      });
      return {
        connected: Boolean(row.token),
        enabled: row.enabled !== false,
        botUsername: row.botUsername || '',
        channelId: row.channelId || '',
        publicUrl: row.publicUrl || '',
        mode: row.live ? 'live' : 'sandbox',
        lastError: row.lastError || '',
        updatedAt: row.updatedAt,
      };
    });
  }

  async disconnect(userId, workspaceId, shopId) {
    this.ensure(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, (db) => {
      db.maxChannels = (db.maxChannels || []).filter((x) => x.shopId !== shopId);
      return { connected: false };
    });
  }

  async sendMessage(shopId, externalUserId, text) {
    const state = this.store.snapshot();
    const row = (state.maxChannels || []).find((x) => x.shopId === shopId);
    assert(row?.token, 'MAX_NOT_CONNECTED', 'MAX не подключён');
    if (!row.live) {
      return { sent: true, sandbox: true, messageId: id('maxm') };
    }
    const result = await this.api(row.token, 'messages', {
      recipient_id: externalUserId,
      text,
    });
    return { sent: true, messageId: String(result.id || id('maxm')) };
  }

  async publishChannel(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const text = String(input.text || '').trim();
    assert(text, 'MAX_POST_EMPTY', 'Введите текст поста');
    const state = this.store.snapshot();
    const row = (state.maxChannels || []).find((x) => x.shopId === shopId);
    assert(row?.token, 'MAX_NOT_CONNECTED', 'MAX не подключён');
    const channelId = String(input.channelId || row.channelId || '').trim();
    assert(channelId, 'MAX_CHANNEL_REQUIRED', 'Укажите ID канала MAX');
    let externalId = null;
    let sandbox = !row.live;
    if (row.live) {
      try {
        const result = await this.api(row.token, 'channels/posts', {
          channel_id: channelId,
          text,
          image_url: input.imageUrl || undefined,
        });
        externalId = String(result.id || '');
      } catch (e) {
        await this.store.transaction(userId, (db) => {
          const ch = (db.maxChannels || []).find((x) => x.shopId === shopId);
          if (ch) ch.lastError = String(e?.message || e);
        });
        throw e;
      }
    } else {
      externalId = id('maxp');
    }
    return this.store.transaction(userId, (db) => {
      db.channelPosts ||= [];
      const post = {
        id: id('cpost'),
        shopId,
        channel: 'max',
        channelId,
        text,
        imageUrl: String(input.imageUrl || ''),
        externalId,
        sandbox,
        status: 'published',
        createdAt: now(),
        actor: userId,
      };
      db.channelPosts.push(post);
      return post;
    });
  }

  async webhook(shopId, body = {}) {
    const state = this.store.snapshot();
    const row = (state.maxChannels || []).find((x) => x.shopId === shopId);
    assert(row, 'MAX_NOT_CONNECTED', 'MAX не подключён', 404);
    const sender = body.sender || body.user || {};
    const text = String(body.text || body.message?.text || '');
    return this.store.transaction('max-webhook', (db) => {
      db.chatMessages ||= [];
      const msg = {
        id: id('chat'),
        shopId,
        channel: 'max',
        direction: 'inbound',
        externalUserId: String(sender.id || body.user_id || 'unknown'),
        username: sender.username || '',
        text,
        raw: body,
        createdAt: now(),
      };
      db.chatMessages.push(msg);
      return { ok: true, messageId: msg.id };
    });
  }
}
