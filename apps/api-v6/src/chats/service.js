import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now = () => new Date().toISOString();

export class ChatService {
  constructor(store, tenancy, telegram, max) {
    this.store = store;
    this.tenancy = tenancy;
    this.telegram = telegram;
    this.max = max;
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

  threads(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    const profiles = new Map(
      (state.customerProfiles || [])
        .filter((p) => p.shopId === shopId && String(p.key || '').startsWith('tg:'))
        .map((p) => [String(p.telegramId || p.key.slice(3)), p]),
    );
    const messages = [
      ...((state.chatMessages || []).filter((m) => m.shopId === shopId)),
      ...((state.telegramMessages || [])
        .filter((m) => m.shopId === shopId)
        .map((m) => ({
          id: m.id,
          shopId: m.shopId,
          channel: 'telegram',
          direction: m.direction || (m.type === 'incoming' ? 'inbound' : 'outbound'),
          externalUserId: String(m.chatId || m.telegramId || m.fromId || ''),
          username: m.username || m.fromUsername || m.from?.username || '',
          firstName: m.firstName || m.from?.firstName || '',
          lastName: m.lastName || m.from?.lastName || '',
          text: m.text || m.message || '',
          createdAt: m.createdAt || m.at || now(),
        }))),
    ].sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const map = new Map();
    for (const msg of messages) {
      const key = `${msg.channel}:${msg.externalUserId}`;
      const profile = msg.channel === 'telegram' ? profiles.get(String(msg.externalUserId)) : null;
      const prev = map.get(key) || {
        id: key,
        channel: msg.channel,
        externalUserId: msg.externalUserId,
        username: '',
        firstName: '',
        lastName: '',
        lastText: '',
        lastAt: '',
        unread: 0,
        messages: 0,
      };
      prev.lastText = msg.text;
      prev.lastAt = msg.createdAt;
      prev.username =
        msg.username ||
        prev.username ||
        profile?.username ||
        profile?.telegramUsername ||
        '';
      prev.firstName = msg.firstName || prev.firstName || profile?.firstName || '';
      prev.lastName = msg.lastName || prev.lastName || profile?.lastName || '';
      prev.messages += 1;
      if (msg.direction === 'inbound') prev.unread += 1;
      map.set(key, prev);
    }
    return [...map.values()].sort((a, b) =>
      String(b.lastAt).localeCompare(String(a.lastAt)),
    );
  }

  thread(userId, workspaceId, shopId, channel, externalUserId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    const uid = String(externalUserId);
    const fromChat = (state.chatMessages || []).filter(
      (m) =>
        m.shopId === shopId &&
        m.channel === channel &&
        String(m.externalUserId) === uid,
    );
    const fromTg =
      channel === 'telegram'
        ? (state.telegramMessages || [])
            .filter(
              (m) =>
                m.shopId === shopId &&
                String(m.chatId || m.telegramId || m.fromId || '') === uid,
            )
            .map((m) => ({
              id: m.id,
              shopId: m.shopId,
              channel: 'telegram',
              direction: m.direction || 'inbound',
              externalUserId: uid,
              username: m.username || m.fromUsername || m.from?.username || '',
              text: m.text || m.message || '',
              createdAt: m.createdAt || m.at || now(),
            }))
        : [];
    return [...fromChat, ...fromTg].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  async reply(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const channel = String(input.channel || 'telegram');
    const externalUserId = String(input.externalUserId || '').trim();
    const text = String(input.text || '').trim();
    assert(externalUserId, 'CHAT_USER_REQUIRED', 'Укажите получателя');
    assert(text, 'CHAT_TEXT_REQUIRED', 'Введите сообщение');
    let sendResult = { sent: true };
    if (channel === 'telegram') {
      sendResult = await this.telegram.sendDirect(shopId, externalUserId, text);
    } else if (channel === 'max') {
      sendResult = await this.max.sendMessage(shopId, externalUserId, text);
    } else {
      assert(false, 'CHAT_CHANNEL_INVALID', 'Неизвестный канал');
    }
    return this.store.transaction(userId, (db) => {
      db.chatMessages ||= [];
      const msg = {
        id: id('chat'),
        shopId,
        channel,
        direction: 'outbound',
        externalUserId,
        username: '',
        text,
        sendResult,
        createdAt: now(),
        actor: userId,
      };
      db.chatMessages.push(msg);
      return msg;
    });
  }

  posts(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.channelPosts || [])
      .filter((p) => p.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async postChannel(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const channel = String(input.channel || 'telegram');
    const text = String(input.text || '').trim();
    assert(text, 'POST_TEXT_REQUIRED', 'Введите текст');
    if (channel === 'max') {
      return this.max.publishChannel(userId, workspaceId, shopId, input);
    }
    if (channel === 'telegram') {
      const state = this.store.snapshot();
      const tg = (state.telegramConfigs || []).find((x) => x.shopId === shopId);
      const channelId = String(
        input.channelId || tg?.channelId || tg?.adminChatId || '',
      );
      assert(channelId, 'TG_CHANNEL_REQUIRED', 'Укажите chat/channel id');
      const result = await this.telegram.sendDirect(shopId, channelId, text);
      return this.store.transaction(userId, (db) => {
        db.channelPosts ||= [];
        const post = {
          id: id('cpost'),
          shopId,
          channel: 'telegram',
          channelId,
          text,
          imageUrl: String(input.imageUrl || ''),
          externalId: result?.messageId || null,
          sandbox: !result?.sent,
          status: result?.sent ? 'published' : 'failed',
          createdAt: now(),
          actor: userId,
        };
        db.channelPosts.push(post);
        return post;
      });
    }
    assert(false, 'POST_CHANNEL_INVALID', 'Неизвестный канал');
  }
}
