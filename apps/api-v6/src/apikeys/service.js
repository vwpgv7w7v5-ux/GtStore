import crypto from 'node:crypto';
import { assert } from '../core/errors.js';
import { hash, id, token } from '../core/ids.js';

const now = () => new Date().toISOString();

export class ApiKeyService {
  constructor(store, tenancy) {
    this.store = store;
    this.tenancy = tenancy;
  }

  list(userId, workspaceId, shopId) {
    this.tenancy.context(userId, workspaceId, 'admin');
    const state = this.store.snapshot();
    return (state.apiKeys || [])
      .filter((key) => key.shopId === shopId && !key.revokedAt)
      .map((key) => ({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        scopes: key.scopes || [],
        createdAt: key.createdAt,
        lastUsedAt: key.lastUsedAt || null,
      }));
  }

  async create(userId, workspaceId, shopId, input = {}) {
    this.tenancy.context(userId, workspaceId, 'admin');
    const name = String(input.name || '').trim();
    assert(name.length >= 2, 'API_KEY_NAME_REQUIRED', 'Укажите название ключа');
    const raw = `gtk_${token()}`;
    const prefix = raw.slice(0, 12);
    return this.store.transaction(userId, (db) => {
      db.apiKeys ||= [];
      const row = {
        id: id('key'),
        workspaceId,
        shopId,
        name,
        prefix,
        tokenHash: hash(raw),
        scopes: Array.isArray(input.scopes) ? input.scopes.map(String) : ['read'],
        createdAt: now(),
        createdBy: userId,
        lastUsedAt: null,
        revokedAt: null,
      };
      db.apiKeys.push(row);
      return {
        id: row.id,
        name: row.name,
        prefix: row.prefix,
        scopes: row.scopes,
        createdAt: row.createdAt,
        token: raw,
      };
    });
  }

  async revoke(userId, workspaceId, shopId, keyId) {
    this.tenancy.context(userId, workspaceId, 'admin');
    return this.store.transaction(userId, (db) => {
      const row = (db.apiKeys || []).find(
        (key) => key.id === keyId && key.shopId === shopId,
      );
      assert(row, 'API_KEY_NOT_FOUND', 'Ключ не найден', 404);
      row.revokedAt = now();
      return { revoked: true, id: row.id };
    });
  }

  async authenticate(raw) {
    const value = String(raw || '').trim();
    if (!value.startsWith('gtk_')) return null;
    const state = this.store.snapshot();
    const key = (state.apiKeys || []).find(
      (item) => item.tokenHash === hash(value) && !item.revokedAt,
    );
    if (!key) return null;
    const stamp = now();
    await this.store.transaction('api-key-touch', (db) => {
      const row = (db.apiKeys || []).find((item) => item.id === key.id);
      if (row) row.lastUsedAt = stamp;
    });
    return { ...key, lastUsedAt: stamp };
  }

  hasScope(key, scope) {
    const scopes = key?.scopes || [];
    if (!scopes.length) return true;
    if (scopes.includes('*') || scopes.includes('admin')) return true;
    return scopes.includes(scope);
  }
}
