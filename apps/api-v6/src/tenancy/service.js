import { assert } from '../core/errors.js'; import { id } from '../core/ids.js';
const rank = { viewer: 1, manager: 2, admin: 3, owner: 4 };
export class TenancyService {
  constructor(store) { this.store = store; }
  context(userId, workspaceId, minimumRole = 'viewer') {
    const state = this.store.snapshot(); const membership = state.memberships.find(m => m.userId === userId && m.workspaceId === workspaceId);
    assert(membership, 'WORKSPACE_ACCESS_DENIED', 'Нет доступа к рабочему пространству', 403);
    assert(rank[membership.role] >= rank[minimumRole], 'PERMISSION_DENIED', 'Недостаточно прав', 403);
    const workspace = state.workspaces.find(w => w.id === workspaceId); return { membership, workspace, state };
  }
  shops(userId, workspaceId) { const c=this.context(userId, workspaceId); const allowed=c.membership.role==='owner'||c.membership.role==='admin'||!Array.isArray(c.membership.shopIds)||!c.membership.shopIds.length?null:new Set(c.membership.shopIds); return c.state.shops.filter(s => s.workspaceId === workspaceId && (!allowed||allowed.has(s.id))); }
  async createShop(userId, workspaceId, input) {
    this.context(userId, workspaceId, 'admin'); const name = String(input.name || '').trim(); assert(name.length >= 2, 'SHOP_NAME_REQUIRED', 'Укажите название магазина');
    return this.store.transaction(userId, db => { const shop = { id:id('shop'), workspaceId, name, slug:String(input.slug||name).toLowerCase().replace(/[^a-z0-9а-я]+/gi,'-').replace(/^-|-$/g,''), status:'draft', createdAt:new Date().toISOString() }; db.shops.push(shop); return shop; });
  }
}
