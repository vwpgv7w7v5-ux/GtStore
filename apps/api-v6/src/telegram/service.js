import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
import { touchCustomerVisit } from '../customers/visits.js';
import { createTelegramFetch, downloadViaCurl } from './proxy-fetch.js';

const now = () => new Date().toISOString();
const TELEGRAM_ALLOWED_UPDATES = ['message', 'callback_query', 'my_chat_member'];
const allowedStatuses = new Set([
  'confirmed',
  'awaiting_payment',
  'paid',
  'assembling',
  'ready',
  'shipped',
  'completed',
  'cancelled',
  'refunded',
]);

export class TelegramService {
  constructor(store, tenancy, orders, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.orders = orders;
    this.fetch = options.fetch || createTelegramFetch(globalThis.fetch);
    this.secret = crypto
      .createHash('sha256')
      .update(
        String(
          options.secret ||
            process.env.GTSTORE_TOKEN_SECRET ||
            'gtstore-local-development-secret',
        ),
      )
      .digest();
    this.publicBaseUrl = String(
      options.publicBaseUrl || process.env.PUBLIC_BASE_URL || '',
    ).replace(/\/$/, '');
    this.storefrontUrl = String(
      options.storefrontUrl || process.env.STOREFRONT_URL || '',
    ).replace(/\/$/, '');
    this.enablePolling = Boolean(options.enableTelegramPolling);
    this.pollers = new Map();
    this.seenUpdates = new Map(); // update_id -> ts
    this.seenMessages = new Map(); // shopId:message_id -> ts
  }

  pruneSeen(map, maxAgeMs = 10 * 60 * 1000) {
    const cutoff = Date.now() - maxAgeMs;
    for (const [key, ts] of map.entries()) {
      if (ts < cutoff) map.delete(key);
    }
  }

  claimOnce(map, key) {
    this.pruneSeen(map);
    if (map.has(key)) return false;
    map.set(key, Date.now());
    return true;
  }

  welcomeCooldownMs() {
    return Number(process.env.TELEGRAM_WELCOME_COOLDOWN_MS || 30 * 60 * 1000); // 30 min
  }

  shouldSendWelcome(shopId, chatId, { force = false } = {}) {
    if (force) return true;
    const state = this.store.snapshot();
    const logs = state.telegramWelcomeLog || [];
    const row = logs.find((item) => item.shopId === shopId && String(item.chatId) === String(chatId));
    if (!row?.sentAt) return true;
    return Date.now() - new Date(row.sentAt).getTime() >= this.welcomeCooldownMs();
  }

  markWelcomeSent(shopId, chatId) {
    return this.store.transaction('telegram-welcome', (db) => {
      db.telegramWelcomeLog ||= [];
      const idx = db.telegramWelcomeLog.findIndex(
        (item) => item.shopId === shopId && String(item.chatId) === String(chatId),
      );
      const row = { shopId, chatId: String(chatId), sentAt: now() };
      if (idx >= 0) db.telegramWelcomeLog[idx] = row;
      else db.telegramWelcomeLog.push(row);
      // prune old (>30 days)
      const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      db.telegramWelcomeLog = db.telegramWelcomeLog.filter(
        (item) => new Date(item.sentAt).getTime() >= cutoff,
      );
      return row;
    });
  }

  buildWelcomeMessage(config, shop) {
    const storefrontLink = this.shopStorefrontUrl(shop);
    const custom = String(config?.welcomeMessage || '').trim();
    const buttonText = this.normalizeShopButtonText(config?.shopButtonText);
    const text =
      custom ||
      [
        `Добро пожаловать в ${shop?.name || 'магазин'}!`,
        storefrontLink
          ? `\nОткройте каталог кнопкой ниже.`
          : '\nКаталог откроется через кнопку меню Mini App.',
      ].join('');
    const reply_markup = storefrontLink
      ? {
          inline_keyboard: [
            [
              this.isHttpsUrl(storefrontLink)
                ? { text: buttonText, web_app: { url: storefrontLink } }
                : { text: buttonText, url: storefrontLink },
            ],
          ],
        }
      : undefined;
    return { text: text.slice(0, 4096), reply_markup, storefrontLink };
  }

  /**
   * Send welcome to a Telegram chat. Used by /start and Mini App open.
   * @param {string} shopId
   * @param {string|number} chatId
   * @param {{ force?: boolean }} [options]
   */
  async sendWelcome(shopId, chatId, options = {}) {
    const force = options.force === true;
    if (!shopId || chatId == null || chatId === '') {
      return { sent: false, reason: 'missing_chat' };
    }
    if (!this.shouldSendWelcome(shopId, chatId, { force })) {
      return { sent: false, skipped: 'cooldown' };
    }
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(
      (item) => item.shopId === shopId && item.enabled !== false && item.tokenEncrypted,
    );
    if (!config) return { sent: false, reason: 'not_configured' };
    const shop = state.shops.find((item) => item.id === shopId);
    const token = this.decrypt(config.tokenEncrypted);
    const welcome = this.buildWelcomeMessage(config, shop);
    try {
      await this.api(token, 'sendMessage', {
        chat_id: chatId,
        text: welcome.text,
        reply_markup: welcome.reply_markup,
        disable_web_page_preview: true,
      });
      this.markWelcomeSent(shopId, chatId).catch(() => undefined);
      return { sent: true };
    } catch (error) {
      return { sent: false, reason: error.message || String(error) };
    }
  }

  isHttpsUrl(url) {
    try {
      return new URL(String(url || '')).protocol === 'https:';
    } catch {
      return false;
    }
  }

  ensureShop(userId, workspaceId, shopId, role = 'viewer') {
    const context = this.tenancy.context(userId, workspaceId, role);
    const shop = context.state.shops.find(
      (item) => item.id === shopId && item.workspaceId === workspaceId,
    );
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return { ...context, shop };
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.secret, iv);
    const encrypted = Buffer.concat([
      cipher.update(String(value), 'utf8'),
      cipher.final(),
    ]);
    return `${iv.toString('base64url')}.${cipher.getAuthTag().toString('base64url')}.${encrypted.toString('base64url')}`;
  }

  decrypt(payload) {
    const [iv, tag, encrypted] = String(payload || '').split('.');
    assert(
      iv && tag && encrypted,
      'TELEGRAM_TOKEN_INVALID',
      'Токен Telegram повреждён',
      500,
    );
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.secret,
      Buffer.from(iv, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  }

  shopStorefrontUrl(shop) {
    if (!this.storefrontUrl || !shop?.slug) return '';
    return `${this.storefrontUrl}/?shop=${encodeURIComponent(shop.slug)}`;
  }

  defaultShopButtonText() {
    return 'Открыть магазин';
  }

  normalizeShopButtonText(value, fallback = this.defaultShopButtonText()) {
    const text = String(value == null ? fallback : value).trim() || fallback;
    return text.slice(0, 64);
  }

  menuButtonText(value) {
    return this.normalizeShopButtonText(value).slice(0, 16);
  }

  async syncMenuButton(token, shop, buttonText) {
    const menuUrl = this.shopStorefrontUrl(shop);
    if (!menuUrl || !this.isHttpsUrl(menuUrl)) return;
    await this.api(token, 'setChatMenuButton', {
      menu_button: {
        type: 'web_app',
        text: this.menuButtonText(buttonText),
        web_app: { url: menuUrl },
      },
    }).catch(() => undefined);
  }

  suggestedWebhookUrl(shopId) {
    if (!shopId || !this.publicBaseUrl || !this.isHttpsUrl(this.publicBaseUrl)) {
      return '';
    }
    return `${this.publicBaseUrl}/api/v6/telegram/webhook/${shopId}`;
  }

  publicConfig(config, shop = null) {
    const shopId = shop?.id || config?.shopId || '';
    const httpsReady = this.isHttpsUrl(this.publicBaseUrl);
    const suggestedWebhookUrl = this.suggestedWebhookUrl(shopId);
    const miniAppUrl = this.shopStorefrontUrl(shop);
    const defaultWelcome = shop?.name
      ? `Добро пожаловать в ${shop.name}!\n\nОткройте каталог кнопкой ниже.`
      : 'Добро пожаловать!\n\nОткройте каталог кнопкой ниже.';
    if (!config) {
      return {
        connected: false,
        enabled: false,
        adminChatId: '',
        botUsername: '',
        welcomeMessage: defaultWelcome,
        shopButtonText: this.defaultShopButtonText(),
        webhookUrl: '',
        suggestedWebhookUrl,
        miniAppUrl,
        autoWebhook: httpsReady,
        mode: httpsReady ? 'webhook' : 'polling',
        publicBaseUrl: this.publicBaseUrl,
        storefrontUrl: this.storefrontUrl,
        storefrontHttps: this.isHttpsUrl(this.storefrontUrl),
        updatedAt: null,
      };
    }
    return {
      connected: Boolean(config.tokenEncrypted),
      enabled: Boolean(config.enabled),
      adminChatId: config.adminChatId || '',
      botUsername: config.botUsername || '',
      welcomeMessage: String(config.welcomeMessage || defaultWelcome),
      shopButtonText: this.normalizeShopButtonText(config.shopButtonText),
      webhookUrl: config.webhookUrl || '',
      suggestedWebhookUrl,
      miniAppUrl,
      autoWebhook: Boolean(config.autoWebhook),
      mode: config.mode || (config.webhookUrl ? 'webhook' : 'polling'),
      publicBaseUrl: this.publicBaseUrl,
      storefrontUrl: this.storefrontUrl,
      storefrontHttps: this.isHttpsUrl(this.storefrontUrl),
      updatedAt: config.updatedAt || null,
      lastError: config.lastError || '',
    };
  }

  getConfig(userId, workspaceId, shopId) {
    const { state, shop } = this.ensureShop(userId, workspaceId, shopId);
    return this.publicConfig(
      (state.telegramConfigs || []).find((item) => item.shopId === shopId),
      shop,
    );
  }

  async api(token, method, payload = {}, attempt = 1) {
    assert(this.fetch, 'FETCH_UNAVAILABLE', 'HTTP-клиент недоступен', 500);
    const root = String(
      this.apiRoot || process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org',
    ).replace(/\/$/, '');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), Number(process.env.TELEGRAM_API_TIMEOUT_MS || 20000));
    let response;
    // Retries are safe only for read/idempotent methods. sendMessage etc. must not retry
    // through flaky SOCKS — Telegram may deliver the message while the response is lost.
    const safeRetry = /^(getUpdates|getMe|getWebhookInfo|getChat|getFile|getUserProfilePhotos|deleteWebhook|getChatMember|getChatAdministrators)$/i.test(
      String(method || ''),
    );
    try {
      response = await this.fetch(`${root}/bot${token}/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: ctrl.signal,
      });
    } catch (error) {
      clearTimeout(timer);
      const msg = String(error?.message || error || '');
      const retryable = /reset by peer|timed out|timeout|Could not connect|Connection refused|Recv failure/i.test(
        msg,
      );
      if (safeRetry && retryable && attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, 800 * attempt));
        return this.api(token, method, payload, attempt + 1);
      }
      const proxyHint = process.env.TELEGRAM_PROXY
        ? ''
        : ' На этом VPS api.telegram.org недоступен напрямую — нужен TELEGRAM_PROXY (SOCKS5/HTTP).';
      assert(
        false,
        'TELEGRAM_API_ERROR',
        error?.name === 'AbortError'
          ? `Telegram API не отвечает (таймаут).${proxyHint}`
          : `Telegram API недоступен: ${msg}.${proxyHint}`,
        502,
      );
    } finally {
      clearTimeout(timer);
    }
    const data = await response.json().catch(() => ({}));
    assert(
      response.ok && data.ok,
      'TELEGRAM_API_ERROR',
      data.description || 'Ошибка Telegram API',
      502,
    );
    return data.result;
  }

  fileUrl(token, filePath) {
    const root = String(
      this.apiRoot || process.env.TELEGRAM_API_ROOT || 'https://api.telegram.org',
    ).replace(/\/$/, '');
    return `${root}/file/bot${token}/${filePath}`;
  }

  async downloadFile(token, filePath, destPath) {
    const url = this.fileUrl(token, filePath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const proxy = String(process.env.TELEGRAM_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '').trim();
    if (proxy) {
      await downloadViaCurl(url, destPath, proxy);
      return destPath;
    }
    const response = await this.fetch(url);
    assert(response.ok, 'TELEGRAM_API_ERROR', 'Не удалось скачать файл Telegram', 502);
    const buffer = Buffer.from(await response.arrayBuffer());
    await fs.promises.writeFile(destPath, buffer);
    return destPath;
  }

  async userAvatarFile(token, telegramUserId) {
    const photos = await this.api(token, 'getUserProfilePhotos', {
      user_id: Number(telegramUserId),
      limit: 1,
    });
    const sizes = photos?.photos?.[0];
    if (!Array.isArray(sizes) || !sizes.length) return null;
    const best = sizes.reduce((a, b) =>
      Number(a.file_size || a.width || 0) >= Number(b.file_size || b.width || 0) ? a : b,
    );
    if (!best?.file_id) return null;
    const file = await this.api(token, 'getFile', { file_id: best.file_id });
    return file?.file_path ? file : null;
  }

  resolveWebhookUrl(shopId, inputUrl) {
    if (
      process.env.TELEGRAM_FORCE_POLLING === '1' ||
      process.env.TELEGRAM_PROXY
    ) {
      return { webhookUrl: '', autoWebhook: false, mode: 'polling' };
    }
    const explicit = String(inputUrl || '').trim();
    if (explicit) {
      if (!this.isHttpsUrl(explicit)) {
        return { webhookUrl: '', autoWebhook: false, mode: 'polling' };
      }
      return { webhookUrl: explicit, autoWebhook: false, mode: 'webhook' };
    }
    if (this.publicBaseUrl && this.isHttpsUrl(this.publicBaseUrl)) {
      return {
        webhookUrl: `${this.publicBaseUrl}/api/v6/telegram/webhook/${shopId}`,
        autoWebhook: true,
        mode: 'webhook',
      };
    }
    return { webhookUrl: '', autoWebhook: false, mode: 'polling' };
  }

  async connect(userId, workspaceId, shopId, input = {}) {
    const { shop } = this.ensureShop(userId, workspaceId, shopId, 'admin');
    const existing = (() => {
      const state = this.store.snapshot();
      return (state.telegramConfigs || []).find((item) => item.shopId === shopId);
    })();
    let token = String(input.token || '').trim();
    if (token) {
      assert(
        /^\d+:[A-Za-z0-9_-]{20,}$/.test(token),
        'TELEGRAM_TOKEN_INVALID',
        'Некорректный токен Telegram',
      );
    } else {
      assert(
        existing?.tokenEncrypted,
        'TELEGRAM_TOKEN_REQUIRED',
        'Укажите токен BotFather',
        400,
      );
      token = this.decrypt(existing.tokenEncrypted);
    }
    const bot = await this.api(token, 'getMe');
    const { webhookUrl, autoWebhook, mode } = this.resolveWebhookUrl(
      shopId,
      input.webhookUrl,
    );
    let webhookSecret = String(input.webhookSecret || '').trim();
    if (!webhookSecret && webhookUrl) {
      webhookSecret =
        existing?.webhookSecret || crypto.randomBytes(24).toString('base64url');
    }
    if (mode === 'webhook' && webhookUrl) {
      await this.api(token, 'setWebhook', {
        url: webhookUrl,
        secret_token: webhookSecret || undefined,
        allowed_updates: TELEGRAM_ALLOWED_UPDATES,
        drop_pending_updates: false,
      });
    } else {
      await this.api(token, 'deleteWebhook', {
        drop_pending_updates: false,
      }).catch(() => undefined);
    }
    const resolvedButtonText = this.normalizeShopButtonText(
      input.shopButtonText != null ? input.shopButtonText : existing?.shopButtonText,
    );
    await this.syncMenuButton(token, shop, resolvedButtonText);
    const saved = this.store.transaction(userId, (db) => {
      db.telegramConfigs ||= [];
      let config = db.telegramConfigs.find((item) => item.shopId === shopId);
      const welcomeMessage =
        input.welcomeMessage != null
          ? String(input.welcomeMessage).slice(0, 4096)
          : config?.welcomeMessage ||
            `Добро пожаловать в ${shop.name}!\n\nОткройте каталог кнопкой ниже.`;
      const buttonText = this.normalizeShopButtonText(
        input.shopButtonText != null ? input.shopButtonText : config?.shopButtonText,
      );
      const tokenEncrypted = this.encrypt(token);
      const data = {
        workspaceId,
        shopId,
        tokenEncrypted,
        adminChatId: String(
          input.adminChatId != null && String(input.adminChatId).trim() !== ''
            ? input.adminChatId
            : config?.adminChatId || existing?.adminChatId || '',
        ).trim(),
        botId: String(bot.id),
        botUsername: bot.username || '',
        enabled: input.enabled !== false,
        welcomeMessage,
        shopButtonText: buttonText,
        webhookUrl,
        webhookSecret: webhookUrl ? webhookSecret : '',
        autoWebhook,
        mode,
        updatedAt: now(),
        lastError: '',
      };
      if (config) Object.assign(config, data);
      else {
        config = { id: id('tgc'), createdAt: now(), ...data };
        db.telegramConfigs.push(config);
      }
      // One bot token → one shop. Fully detach from every other shop.
      for (const other of db.telegramConfigs) {
        if (other.shopId === shopId || !other.tokenEncrypted) continue;
        let same = false;
        try {
          same = this.decrypt(other.tokenEncrypted) === token;
        } catch {
          same = other.botId && String(other.botId) === String(bot.id);
        }
        if (!same && other.botUsername && bot.username) {
          same =
            String(other.botUsername).toLowerCase() ===
            String(bot.username).toLowerCase();
        }
        if (!same) continue;
        other.enabled = false;
        other.tokenEncrypted = '';
        other.botId = '';
        other.botUsername = '';
        other.webhookUrl = '';
        other.lastError = `detached: bot owned by ${shop.slug}`;
        other.updatedAt = now();
      }
      return this.publicConfig(config, shop);
    });
    // After commit: stop pollers for shops that lost this bot.
    const state = this.store.snapshot();
    for (const other of state.telegramConfigs || []) {
      if (other.shopId === shopId) continue;
      if (String(other.lastError || '').startsWith('detached: bot owned by')) {
        this.stopPolling(other.shopId);
      }
    }
    if (mode === 'polling') this.startPolling(shopId);
    else this.stopPolling(shopId);
    return saved;
  }

  async updateSettings(userId, workspaceId, shopId, input = {}) {
    const { shop } = this.ensureShop(userId, workspaceId, shopId, 'admin');
    const saved = this.store.transaction(userId, (db) => {
      db.telegramConfigs ||= [];
      const config = db.telegramConfigs.find((item) => item.shopId === shopId);
      assert(config?.tokenEncrypted, 'TELEGRAM_NOT_CONFIGURED', 'Сначала подключите бота', 400);
      if (input.welcomeMessage != null) {
        config.welcomeMessage = String(input.welcomeMessage).slice(0, 4096);
      }
      if (input.shopButtonText != null) {
        config.shopButtonText = this.normalizeShopButtonText(input.shopButtonText);
      }
      if (input.adminChatId != null) {
        config.adminChatId = String(input.adminChatId).trim();
      }
      if (input.enabled != null) {
        config.enabled = input.enabled !== false;
      }
      config.updatedAt = now();
      config.lastError = '';
      return this.publicConfig(config, shop);
    });
    if (input.shopButtonText != null) {
      const state = this.store.snapshot();
      const config = (state.telegramConfigs || []).find((item) => item.shopId === shopId);
      if (config?.tokenEncrypted) {
        await this.syncMenuButton(
          this.decrypt(config.tokenEncrypted),
          shop,
          config.shopButtonText,
        );
      }
    }
    return saved;
  }

  async disconnect(userId, workspaceId, shopId) {
    this.ensureShop(userId, workspaceId, shopId, 'admin');
    this.stopPolling(shopId);
    return this.store.transaction(userId, (db) => {
      db.telegramConfigs ||= [];
      const config = db.telegramConfigs.find((item) => item.shopId === shopId);
      if (config?.tokenEncrypted) {
        this.api(this.decrypt(config.tokenEncrypted), 'deleteWebhook', {
          drop_pending_updates: false,
        }).catch(() => undefined);
      }
      db.telegramConfigs = db.telegramConfigs.filter(
        (item) => item.shopId !== shopId,
      );
      return { connected: false };
    });
  }

  stopPolling(shopId) {
    const runner = this.pollers.get(shopId);
    if (runner) runner.stopped = true;
    this.pollers.delete(shopId);
  }

  startPolling(shopId) {
    if (!this.enablePolling) return;
    this.stopPolling(shopId);
    const runner = { stopped: false, offset: 0 };
    this.pollers.set(shopId, runner);
    const loop = async () => {
      while (!runner.stopped) {
        try {
          const state = this.store.snapshot();
          const config = (state.telegramConfigs || []).find(
            (item) =>
              item.shopId === shopId &&
              item.tokenEncrypted &&
              item.enabled !== false,
          );
          if (!config) break;
          const token = this.decrypt(config.tokenEncrypted);
          // Stop sibling pollers that share the same bot token.
          for (const [otherId, otherRunner] of this.pollers.entries()) {
            if (otherId === shopId) continue;
            const other = (state.telegramConfigs || []).find(
              (item) => item.shopId === otherId && item.tokenEncrypted,
            );
            if (!other) continue;
            try {
              if (this.decrypt(other.tokenEncrypted) === token) {
                otherRunner.stopped = true;
                this.pollers.delete(otherId);
              }
            } catch {
              /* ignore */
            }
          }
          const updates = await this.api(token, 'getUpdates', {
            offset: runner.offset || undefined,
            timeout: 25,
            allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          });
          for (const update of updates || []) {
            runner.offset = Number(update.update_id) + 1;
            const updateKey = String(update.update_id);
            if (!this.claimOnce(this.seenUpdates, updateKey)) continue;
            await this.webhook(shopId, update, '').catch(() => undefined);
          }
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 2500));
        }
      }
    };
    loop();
  }

  /**
   * User opened / started private chat with the bot (even without typing /start).
   * Telegram sends my_chat_member when conversation becomes active.
   */
  async handleMyChatMember(shopId, config, update) {
    const event = update?.my_chat_member;
    if (!event) return { ok: true, ignored: true };
    const chat = event.chat;
    if (!chat || chat.type !== 'private') return { ok: true, ignored: true };
    const oldStatus = String(event.old_chat_member?.status || '');
    const newStatus = String(event.new_chat_member?.status || '');
    // User opened private chat / pressed Start UI (may not send /start text)
    const started =
      ['member', 'restricted'].includes(newStatus) &&
      !['member', 'administrator', 'creator'].includes(oldStatus);
    if (!started) return { ok: true, ignored: true, oldStatus, newStatus };
    const chatId = chat.id || event.from?.id;
    if (!chatId) return { ok: true, ignored: true };
    // Upsert lightweight customer row so admin sees the contact
    try {
      const tgId = String(event.from?.id || chatId);
      await this.store.transaction('tg-chat-open-profile', (db) => {
        db.customerProfiles ||= [];
        const key = `tg:${tgId}`;
        let profile = db.customerProfiles.find(
          (item) => item.shopId === shopId && item.key === key,
        );
        if (!profile) {
          profile = {
            id: `cus_${tgId}`,
            shopId,
            key,
            telegramId: tgId,
            createdAt: now(),
          };
          db.customerProfiles.push(profile);
        }
        const u = String(event.from?.username || '').replace(/^@/, '');
        if (u) profile.username = u;
        if (event.from?.first_name) profile.firstName = String(event.from.first_name);
        if (event.from?.last_name) profile.lastName = String(event.from.last_name);
        if (!profile.name) {
          profile.name =
            [profile.firstName, profile.lastName].filter(Boolean).join(' ') ||
            (u ? `@${u}` : '');
        }
        touchCustomerVisit(profile);
        return profile;
      });
    } catch (error) {
      console.warn('[telegram] chat-open profile', error?.message || error);
    }
    const result = await this.sendWelcome(shopId, chatId, { force: true });
    return { ok: true, handled: 'my_chat_member_welcome', welcome: result };
  }

  /**
   * Re-apply webhook allowed_updates so existing bots receive my_chat_member.
   */
  async refreshInboundUpdates() {
    const state = this.store.snapshot();
    for (const config of state.telegramConfigs || []) {
      if (!config?.tokenEncrypted || config.enabled === false) continue;
      if (!(config.mode === 'webhook' && config.webhookUrl)) continue;
      try {
        const token = this.decrypt(config.tokenEncrypted);
        await this.api(token, 'setWebhook', {
          url: config.webhookUrl,
          secret_token: config.webhookSecret || undefined,
          allowed_updates: TELEGRAM_ALLOWED_UPDATES,
          drop_pending_updates: false,
        });
      } catch (error) {
        console.warn(
          '[telegram] refresh webhook failed',
          config.shopId,
          error?.message || error,
        );
      }
    }
  }

  resumePolling() {
    if (!this.enablePolling) return;
    const state = this.store.snapshot();
    const seenTokens = new Set();
    for (const config of state.telegramConfigs || []) {
      if (
        !config.tokenEncrypted ||
        config.enabled === false ||
        !(config.mode === 'polling' || !config.webhookUrl)
      ) {
        continue;
      }
      let tokenKey = config.shopId;
      try {
        tokenKey = this.decrypt(config.tokenEncrypted);
      } catch {
        /* keep shopId */
      }
      if (seenTokens.has(tokenKey)) {
        continue;
      }
      seenTokens.add(tokenKey);
      this.startPolling(config.shopId);
    }
    // Keep webhooks in sync with current allowed_updates (welcome without /start)
    this.refreshInboundUpdates().catch((error) => {
      console.warn('[telegram] refreshInboundUpdates', error?.message || error);
    });
  }

  formatOrder(order) {
    const lines = order.lines
      .map(
        (line) =>
          `• ${line.name}${line.variantName ? ` — ${line.variantName}` : ''} × ${line.quantity} = ${line.total.toLocaleString('ru-RU')} ₽`,
      )
      .join('\n');
    return [
      `🛒 Новый заказ №${order.number}`,
      '',
      lines,
      '',
      `Итого: ${order.total.toLocaleString('ru-RU')} ₽`,
      `Клиент: ${order.customer.name}`,
      `Телефон: ${order.customer.phone}`,
      `Доставка: ${order.deliveryMethod === 'courier' ? 'Курьер' : 'Самовывоз'}`,
      order.address ? `Адрес: ${order.address}` : '',
      order.comment ? `Комментарий: ${order.comment}` : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  keyboard(order) {
    return {
      inline_keyboard: [
        [
          {
            text: '✅ Подтвердить',
            callback_data: `order:${order.id}:confirmed`,
          },
          { text: '💳 Оплачен', callback_data: `order:${order.id}:paid` },
        ],
        [
          {
            text: '📦 Сборка',
            callback_data: `order:${order.id}:assembling`,
          },
          { text: '🚚 Готов', callback_data: `order:${order.id}:ready` },
        ],
        [
          {
            text: '🏁 Завершить',
            callback_data: `order:${order.id}:completed`,
          },
          {
            text: '❌ Отменить',
            callback_data: `order:${order.id}:cancelled`,
          },
        ],
      ],
    };
  }

  async notifyNewOrder(order) {
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(
      (item) =>
        item.shopId === order.shopId &&
        item.enabled &&
        item.tokenEncrypted &&
        item.adminChatId,
    );
    if (!config) return { sent: false, reason: 'not_configured' };
    try {
      const message = await this.api(
        this.decrypt(config.tokenEncrypted),
        'sendMessage',
        {
          chat_id: config.adminChatId,
          text: this.formatOrder(order),
          reply_markup: this.keyboard(order),
          disable_web_page_preview: true,
        },
      );
      await this.store.transaction('telegram-notifier', (db) => {
        db.telegramMessages ||= [];
        db.telegramMessages.push({
          id: id('tgm'),
          shopId: order.shopId,
          orderId: order.id,
          chatId: String(config.adminChatId),
          messageId: String(message.message_id),
          createdAt: now(),
        });
      });
      return { sent: true, messageId: message.message_id };
    } catch (error) {
      await this.store.transaction('telegram-notifier', (db) => {
        const current = (db.telegramConfigs || []).find(
          (item) => item.shopId === order.shopId,
        );
        if (current) current.lastError = error.message;
      });
      return { sent: false, reason: error.message };
    }
  }

  async sendDirect(shopId, chatId, text) {
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(
      (item) =>
        item.shopId === shopId && item.enabled && item.tokenEncrypted,
    );
    if (!config) return { sent: false, reason: 'not_configured' };
    try {
      const message = await this.api(
        this.decrypt(config.tokenEncrypted),
        'sendMessage',
        { chat_id: String(chatId), text: String(text || '') },
      );
      return { sent: true, messageId: message.message_id };
    } catch (error) {
      return { sent: false, reason: error.message };
    }
  }

  async test(userId, workspaceId, shopId) {
    const { state } = this.ensureShop(userId, workspaceId, shopId, 'manager');
    const config = (state.telegramConfigs || []).find(
      (item) => item.shopId === shopId,
    );
    assert(
      config?.tokenEncrypted && config.adminChatId,
      'TELEGRAM_NOT_CONFIGURED',
      'Сначала подключите Telegram',
    );
    const message = await this.api(
      this.decrypt(config.tokenEncrypted),
      'sendMessage',
      {
        chat_id: config.adminChatId,
        text: 'GStore: тестовое уведомление доставлено.',
      },
    );
    return { ok: true, messageId: message.message_id };
  }

  statusText(status) {
    return (
      {
        new: 'Заказ создан',
        confirmed: 'Заказ подтверждён',
        awaiting_payment: 'Ожидаем оплату',
        paid: 'Оплата получена',
        assembling: 'Заказ собирается',
        ready: 'Заказ готов',
        shipped: 'Заказ передан в доставку',
        completed: 'Заказ завершён',
        cancelled: 'Заказ отменён',
        refunded: 'Возврат оформлен',
      }[status] || status
    );
  }

  async notifyCustomer(order) {
    const chatId = String(order.customer?.telegramId || '').trim();
    if (!chatId) return { sent: false, reason: 'telegram_id_missing' };
    return this.notifyText(
      order.shopId,
      chatId,
      `Заказ №${order.number}: ${this.statusText(order.status)}.\nСумма: ${order.total.toLocaleString('ru-RU')} ₽`,
    );
  }

  async notifyText(shopId, chatId, text) {
    const target = String(chatId || '').trim();
    if (!target) return { sent: false, reason: 'telegram_id_missing' };
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(
      (item) => item.shopId === shopId && item.enabled && item.tokenEncrypted,
    );
    if (!config) return { sent: false, reason: 'not_configured' };
    try {
      const message = await this.api(
        this.decrypt(config.tokenEncrypted),
        'sendMessage',
        { chat_id: target, text: String(text || '').slice(0, 4096) },
      );
      return { sent: true, messageId: message.message_id };
    } catch (error) {
      return { sent: false, reason: error.message };
    }
  }

  async handleMessage(shopId, config, message) {
    const chatId = message.chat?.id;
    if (!chatId) return { ok: true, ignored: true };
    const messageKey = `${shopId}:${message.message_id || ''}:${message.date || ''}`;
    if (message.message_id && !this.claimOnce(this.seenMessages, messageKey)) {
      return { ok: true, deduped: true };
    }
    const text = String(message.text || '').trim();
    const token = this.decrypt(config.tokenEncrypted);

    const fromUsername = String(message.from?.username || '').replace(/^@/, '');
    const fromFirst = String(message.from?.first_name || '');
    const fromLast = String(message.from?.last_name || '');
    const fromId = String(message.from?.id || chatId);

    await this.store.transaction('telegram-inbox', (db) => {
      db.telegramMessages ||= [];
      db.telegramMessages.push({
        id: id('tgm'),
        shopId,
        chatId: String(chatId),
        type: 'incoming',
        direction: 'inbound',
        text,
        username: fromUsername,
        fromUsername,
        firstName: fromFirst,
        lastName: fromLast,
        from: message.from
          ? {
              id: fromId,
              username: fromUsername,
              firstName: fromFirst,
              lastName: fromLast,
            }
          : null,
        createdAt: now(),
      });
      // Keep customer profile in sync so admin «Клиенты» shows @nick
      db.customerProfiles ||= [];
      const key = `tg:${fromId}`;
      let profile = db.customerProfiles.find(
        (item) => item.shopId === shopId && item.key === key,
      );
      if (!profile) {
        profile = {
          id: id('cus'),
          shopId,
          key,
          telegramId: fromId,
          createdAt: now(),
        };
        db.customerProfiles.push(profile);
      }
      if (fromUsername) profile.username = fromUsername;
      if (fromFirst) profile.firstName = fromFirst;
      if (fromLast) profile.lastName = fromLast;
      if (!profile.name && (fromFirst || fromLast || fromUsername)) {
        profile.name =
          [fromFirst, fromLast].filter(Boolean).join(' ') ||
          (fromUsername ? `@${fromUsername}` : '');
      }
      touchCustomerVisit(profile);
    });

    const send = async (payload) => {
      try {
        return await this.api(token, 'sendMessage', payload);
      } catch (error) {
        return { sent: false, reason: error.message || String(error) };
      }
    };

    if (text === '/start' || text.startsWith('/start ')) {
      const startPayload = text.slice('/start'.length).trim();
      const refMatch = String(startPayload).match(/^(?:ref_|referral_)([A-Z0-9]+)$/i);
      if (refMatch) {
        const code = String(refMatch[1] || '').toUpperCase();
        const tgId = String(message.from?.id || chatId);
        try {
          await this.store.transaction('referral-start-bind', (db) => {
            db.customerProfiles ||= [];
            const key = `tg:${tgId}`;
            let profile = db.customerProfiles.find(
              (item) => item.shopId === shopId && item.key === key,
            );
            if (!profile) {
              profile = {
                id: id('cus'),
                shopId,
                key,
                telegramId: tgId,
                createdAt: now(),
              };
              db.customerProfiles.push(profile);
            }
            const u = String(message.from?.username || '').replace(/^@/, '');
            if (u) profile.username = u;
            if (message.from?.first_name) profile.firstName = String(message.from.first_name);
            if (message.from?.last_name) profile.lastName = String(message.from.last_name);
            // Bind once — first touch attribution (standard for TG Mini Apps)
            if (!profile.referredByCode && code) {
              profile.referredByCode = code;
              profile.referredAt = now();
            }
            touchCustomerVisit(profile);
            return profile;
          });
        } catch (error) {
          console.warn('[telegram] referral start bind failed', error?.message || error);
        }
      }
      await this.sendWelcome(shopId, chatId, { force: true });
      return { ok: true, handled: 'start' };
    }

    if (text === '/help') {
      await send({
        chat_id: chatId,
        text: 'Откройте магазин через кнопку меню. Приветствие приходит автоматически.',
      });
      return { ok: true, handled: 'help' };
    }

    const welcomeResult = await this.sendWelcome(shopId, chatId, { force: false });
    if (!welcomeResult.sent) {
      await send({
        chat_id: chatId,
        text: 'Сообщение получено. Менеджер ответит в ближайшее время.',
      });
    }
    return { ok: true, handled: 'message' };
  }

  async webhook(shopId, update, secret = '') {
    const state = this.store.snapshot();
    const config = (state.telegramConfigs || []).find(
      (item) => item.shopId === shopId && item.enabled !== false && item.tokenEncrypted,
    );
    assert(config, 'TELEGRAM_NOT_CONFIGURED', 'Telegram не настроен', 404);
    if (config.mode !== 'polling' && config.webhookSecret) {
      assert(
        secret === config.webhookSecret,
        'TELEGRAM_WEBHOOK_FORBIDDEN',
        'Неверный секрет webhook',
        403,
      );
    }

    const callback = update?.callback_query;
    if (callback) {
      const match = /^order:([^:]+):([^:]+)$/.exec(callback.data || '');
      if (!match || !allowedStatuses.has(match[2])) {
        return { ok: true, ignored: true };
      }
      const order = (state.orders || []).find(
        (item) => item.id === match[1] && item.shopId === shopId,
      );
      assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
      const membership = state.memberships.find(
        (item) =>
          item.workspaceId === order.workspaceId &&
          ['owner', 'admin', 'manager'].includes(item.role),
      );
      assert(
        membership,
        'TELEGRAM_ACTOR_NOT_FOUND',
        'Не найден сотрудник магазина',
        403,
      );
      const updated = await this.orders.update(
        membership.userId,
        order.workspaceId,
        shopId,
        order.id,
        { status: match[2] },
      );
      await this.notifyCustomer(updated);
      const token = this.decrypt(config.tokenEncrypted);
      await this.api(token, 'answerCallbackQuery', {
        callback_query_id: callback.id,
        text: `Статус: ${updated.status}`,
      }).catch(() => undefined);
      if (callback.message) {
        await this.api(token, 'editMessageReplyMarkup', {
          chat_id: callback.message.chat.id,
          message_id: callback.message.message_id,
          reply_markup: this.keyboard(updated),
        }).catch(() => undefined);
      }
      return { ok: true, orderId: updated.id, status: updated.status };
    }

    if (update?.message) {
      return this.handleMessage(shopId, config, update.message);
    }

    if (update?.my_chat_member) {
      return this.handleMyChatMember(shopId, config, update);
    }

    return { ok: true, ignored: true };
  }
}
