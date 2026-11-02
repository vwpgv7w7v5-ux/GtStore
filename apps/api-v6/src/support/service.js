import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
import { HELP_ARTICLES } from './articles.js';

const now = () => new Date().toISOString();

function scoreArticle(article, q) {
  if (!q) return 1;
  const hay = `${article.title} ${article.section} ${article.content} ${(article.tags || []).join(' ')}`.toLowerCase();
  const words = q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 1);
  if (!words.length) return hay.includes(q.toLowerCase()) ? 1 : 0;
  let score = 0;
  for (const w of words) {
    if (article.title.toLowerCase().includes(w)) score += 4;
    if ((article.tags || []).some((t) => t.toLowerCase().includes(w))) score += 3;
    if (article.section.toLowerCase().includes(w)) score += 2;
    if (article.content.toLowerCase().includes(w)) score += 1;
  }
  return score;
}

export class SupportService {
  constructor(store, tenancy) {
    this.store = store;
    this.tenancy = tenancy;
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

  sections() {
    return [...new Set(HELP_ARTICLES.map((a) => a.section))];
  }

  search(query = '', section = '') {
    const q = String(query || '').trim();
    const sec = String(section || '').trim();
    return HELP_ARTICLES.filter((a) => !sec || a.section === sec)
      .map((a) => ({ ...a, _score: scoreArticle(a, q) }))
      .filter((a) => !q || a._score > 0)
      .sort((a, b) => b._score - a._score || a.title.localeCompare(b.title, 'ru'))
      .map(({ _score, ...a }) => a);
  }

  getArticle(articleId) {
    const a = HELP_ARTICLES.find((x) => x.id === articleId);
    assert(a, 'ARTICLE_NOT_FOUND', 'Статья не найдена', 404);
    return a;
  }

  thread(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    const threads = state.supportThreads || [];
    let row = threads.find((t) => t.shopId === shopId && t.userId === userId);
    if (!row) {
      return {
        id: null,
        shopId,
        userId,
        status: 'new',
        messages: [
          {
            id: 'welcome',
            role: 'support',
            text: 'Здравствуйте! Я поддержка GStore. Задайте вопрос или найдите ответ в базе знаний слева.',
            createdAt: now(),
            auto: true,
          },
        ],
      };
    }
    const messages = (state.supportMessages || [])
      .filter((m) => m.threadId === row.id)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    return { ...row, messages };
  }

  tickets(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.supportTickets || [])
      .filter((t) => t.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  bestMatch(text) {
    const ranked = this.search(text);
    return ranked[0] || null;
  }

  async sendMessage(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId);
    const text = String(input.text || '').trim();
    assert(text.length >= 2, 'SUPPORT_TEXT_REQUIRED', 'Введите сообщение');
    const priority = ['low', 'normal', 'high'].includes(input.priority)
      ? input.priority
      : 'normal';

    const match = this.bestMatch(text);
    const autoText = match
      ? `Нашёл в базе знаний: «${match.title}» (${match.section}).\n\n${match.content.slice(0, 500)}${match.content.length > 500 ? '…' : ''}\n\nОткрыть статью: ${match.id}. Если это не помогло — напишите «оператор» или уточните детали.`
      : 'Спасибо! Обращение принято. Оператор ответит в этом чате. Пока можно поискать ответ в базе знаний слева.';

    return this.store.transaction(userId, (db) => {
      db.supportThreads ||= [];
      db.supportMessages ||= [];
      db.supportTickets ||= [];

      let thread = db.supportThreads.find(
        (t) => t.shopId === shopId && t.userId === userId,
      );
      if (!thread) {
        thread = {
          id: id('sth'),
          shopId,
          workspaceId,
          userId,
          status: 'open',
          priority,
          createdAt: now(),
          updatedAt: now(),
        };
        db.supportThreads.push(thread);
      } else {
        thread.status = 'open';
        thread.priority = priority;
        thread.updatedAt = now();
      }

      const userMsg = {
        id: id('smsg'),
        threadId: thread.id,
        shopId,
        role: 'user',
        text,
        createdAt: now(),
      };
      db.supportMessages.push(userMsg);

      const wantsOperator = /оператор|человек|менеджер|живы/i.test(text);
      const supportMsg = {
        id: id('smsg'),
        threadId: thread.id,
        shopId,
        role: 'support',
        text: wantsOperator
          ? 'Передал обращение оператору. Обычно отвечаем в рабочее время. Номер тикета появится ниже.'
          : autoText,
        articleId: !wantsOperator && match ? match.id : null,
        auto: true,
        createdAt: now(),
      };
      db.supportMessages.push(supportMsg);

      let ticket = null;
      if (wantsOperator || !match) {
        const number =
          1000 +
          (db.supportTickets.filter((t) => t.shopId === shopId).length || 0);
        ticket = {
          id: id('tkt'),
          number,
          shopId,
          workspaceId,
          userId,
          threadId: thread.id,
          subject: text.slice(0, 80),
          message: text,
          priority,
          status: 'open',
          createdAt: now(),
          updatedAt: now(),
        };
        db.supportTickets.push(ticket);
      }

      const messages = db.supportMessages
        .filter((m) => m.threadId === thread.id)
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      return {
        thread: { ...thread, messages },
        ticket,
        suggestedArticle: match,
      };
    });
  }
}
