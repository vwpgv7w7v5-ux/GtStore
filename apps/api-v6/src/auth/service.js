import { assert } from '../core/errors.js';
import { hash, id, token } from '../core/ids.js';
import { hashPassword, verifyPassword } from '../core/password.js';

function slugify(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9а-яё]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 64) || 'store';
}

function uniqueSlug(db, desired) {
  let slug = slugify(desired);
  const base = slug;
  let n = 1;
  while (db.shops.some((s) => s.slug === slug)) {
    slug = `${base}-${++n}`.slice(0, 64);
  }
  return slug;
}

export class AuthService {
  constructor(store, options = {}) {
    this.store = store;
    this.sessionTtlMs = options.sessionTtlMs || 7 * 86400000;
  }

  async bootstrap(email, password, name = 'Владелец') {
    const state = this.store.snapshot();
    if (state.users.length) return null;
    return this.store.transaction('system', (db) => {
      const user = {
        id: id('usr'),
        email: email.toLowerCase(),
        name,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      const workspace = {
        id: id('ws'),
        name: 'Основное пространство',
        createdAt: new Date().toISOString(),
      };
      const shop = {
        id: id('shop'),
        workspaceId: workspace.id,
        name: 'Мой магазин',
        slug: uniqueSlug(db, 'my-store'),
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      db.workspaces.push(workspace);
      db.shops.push(shop);
      db.memberships.push({
        id: id('mem'),
        userId: user.id,
        workspaceId: workspace.id,
        role: 'owner',
      });
      return { user: this.publicUser(user), workspace, shop };
    });
  }

  async register(email, password, name, options = {}) {
    const normalized = String(email || '')
      .toLowerCase()
      .trim();
    assert(
      normalized.includes('@') && normalized.includes('.'),
      'EMAIL_INVALID',
      'Укажите корректный email',
    );
    assert(
      String(password || '').length >= 8,
      'PASSWORD_WEAK',
      'Пароль должен содержать минимум 8 символов',
    );
    const displayName = String(name || normalized.split('@')[0]).trim();
    assert(displayName.length >= 2, 'NAME_REQUIRED', 'Укажите имя');
    const workspaceName =
      String(options.workspaceName || 'Моё пространство').trim() ||
      'Моё пространство';
    const shopName =
      String(options.shopName || 'Мой магазин').trim() || 'Мой магазин';

    const created = await this.store.transaction('register', (db) => {
      assert(
        !db.users.some((u) => u.email === normalized),
        'EMAIL_EXISTS',
        'Пользователь с таким email уже зарегистрирован',
        409,
      );
      const user = {
        id: id('usr'),
        email: normalized,
        name: displayName,
        passwordHash: hashPassword(password),
        createdAt: new Date().toISOString(),
      };
      const workspace = {
        id: id('ws'),
        name: workspaceName,
        createdAt: new Date().toISOString(),
      };
      const shop = {
        id: id('shop'),
        workspaceId: workspace.id,
        name: shopName,
        slug: uniqueSlug(db, options.shopSlug || shopName),
        status: 'draft',
        createdAt: new Date().toISOString(),
      };
      db.users.push(user);
      db.workspaces.push(workspace);
      db.shops.push(shop);
      db.memberships.push({
        id: id('mem'),
        userId: user.id,
        workspaceId: workspace.id,
        role: 'owner',
      });
      return { user, workspace, shop };
    });

    const session = await this.login(normalized, password, {
      ip: options.ip,
      userAgent: options.userAgent,
    });
    return {
      ...session,
      workspace: created.workspace,
      shop: created.shop,
    };
  }

  async login(email, password, meta = {}) {
    const state = this.store.snapshot();
    const user = state.users.find(
      (item) => item.email === String(email).toLowerCase(),
    );
    assert(
      user && verifyPassword(password, user.passwordHash),
      'INVALID_CREDENTIALS',
      'Неверный email или пароль',
      401,
    );
    const raw = token();
    const session = {
      id: id('ses'),
      userId: user.id,
      tokenHash: hash(raw),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.sessionTtlMs).toISOString(),
      meta,
    };
    await this.store.transaction(user.id, (db) => {
      db.sessions = db.sessions.filter((s) => new Date(s.expiresAt) > new Date());
      db.sessions.push(session);
    });
    return {
      token: raw,
      expiresAt: session.expiresAt,
      user: this.publicUser(user),
    };
  }

  authenticate(raw) {
    assert(raw, 'AUTH_REQUIRED', 'Требуется авторизация', 401);
    const state = this.store.snapshot();
    const session = state.sessions.find((item) => item.tokenHash === hash(raw));
    assert(
      session && new Date(session.expiresAt) > new Date(),
      'SESSION_EXPIRED',
      'Сессия истекла',
      401,
    );
    const user = state.users.find((item) => item.id === session.userId);
    assert(user, 'USER_NOT_FOUND', 'Пользователь не найден', 401);
    return { user, session, state };
  }

  async refresh(raw) {
    const { user, session } = this.authenticate(raw);
    const next = token();
    const expiresAt = new Date(Date.now() + this.sessionTtlMs).toISOString();
    await this.store.transaction(user.id, (db) => {
      const current = db.sessions.find((s) => s.id === session.id);
      assert(current, 'SESSION_EXPIRED', 'Сессия истекла', 401);
      current.tokenHash = hash(next);
      current.expiresAt = expiresAt;
      current.refreshedAt = new Date().toISOString();
    });
    return {
      token: next,
      expiresAt,
      user: this.publicUser(user),
    };
  }

  async logout(raw) {
    const tokenHash = hash(raw);
    await this.store.transaction('session', (db) => {
      db.sessions = db.sessions.filter((s) => s.tokenHash !== tokenHash);
    });
  }

  publicUser(user) {
    return {
      id: user.id,
      email: user.email,
      name: user.name,
      createdAt: user.createdAt,
    };
  }
}

export { slugify, uniqueSlug };
