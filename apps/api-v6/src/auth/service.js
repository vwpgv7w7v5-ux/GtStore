import { assert } from '../core/errors.js'; import { hash, id, token } from '../core/ids.js'; import { hashPassword, verifyPassword } from '../core/password.js';
export class AuthService {
  constructor(store, options = {}) { this.store = store; this.sessionTtlMs = options.sessionTtlMs || 7 * 86400000; }
  async bootstrap(email, password, name = 'Владелец') {
    const state = this.store.snapshot(); if (state.users.length) return null;
    return this.store.transaction('system', db => {
      const user = { id: id('usr'), email: email.toLowerCase(), name, passwordHash: hashPassword(password), createdAt: new Date().toISOString() };
      const workspace = { id: id('ws'), name: 'Основное пространство', createdAt: new Date().toISOString() };
      const shop = { id: id('shop'), workspaceId: workspace.id, name: 'Мой магазин', slug: 'my-store', status: 'draft', createdAt: new Date().toISOString() };
      db.users.push(user); db.workspaces.push(workspace); db.shops.push(shop); db.memberships.push({ id: id('mem'), userId: user.id, workspaceId: workspace.id, role: 'owner' });
      return { user: this.publicUser(user), workspace, shop };
    });
  }
  async login(email, password, meta = {}) {
    const state = this.store.snapshot(); const user = state.users.find(item => item.email === String(email).toLowerCase());
    assert(user && verifyPassword(password, user.passwordHash), 'INVALID_CREDENTIALS', 'Неверный email или пароль', 401);
    const raw = token(); const session = { id: id('ses'), userId: user.id, tokenHash: hash(raw), createdAt: new Date().toISOString(), expiresAt: new Date(Date.now()+this.sessionTtlMs).toISOString(), meta };
    await this.store.transaction(user.id, db => { db.sessions = db.sessions.filter(s => new Date(s.expiresAt) > new Date()); db.sessions.push(session); });
    return { token: raw, expiresAt: session.expiresAt, user: this.publicUser(user) };
  }
  authenticate(raw) {
    assert(raw, 'AUTH_REQUIRED', 'Требуется авторизация', 401); const state = this.store.snapshot();
    const session = state.sessions.find(item => item.tokenHash === hash(raw)); assert(session && new Date(session.expiresAt) > new Date(), 'SESSION_EXPIRED', 'Сессия истекла', 401);
    const user = state.users.find(item => item.id === session.userId); assert(user, 'USER_NOT_FOUND', 'Пользователь не найден', 401); return { user, session, state };
  }
  async logout(raw) { const tokenHash = hash(raw); await this.store.transaction('session', db => { db.sessions = db.sessions.filter(s => s.tokenHash !== tokenHash); }); }
  publicUser(user) { return { id: user.id, email: user.email, name: user.name, createdAt: user.createdAt }; }
}
