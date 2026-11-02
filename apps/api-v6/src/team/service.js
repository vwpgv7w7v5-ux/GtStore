import { assert } from '../core/errors.js';
import { id, token } from '../core/ids.js';
import { hashPassword } from '../core/password.js';
import { Permission, permissionsForRole, hasPermission } from './permissions.js';

const roles = new Set(['viewer','manager','admin']);
export class TeamService {
  constructor(store, tenancy, auth, mail = null, options = {}){
    this.store=store; this.tenancy=tenancy; this.auth=auth; this.mail=mail;
    this.acceptBaseUrl=String(options.acceptBaseUrl||process.env.ADMIN_URL||process.env.PUBLIC_BASE_URL||'http://127.0.0.1:4173').replace(/\/$/,'');
  }
  permissionCatalog(){ return { permissions: Object.values(Permission), roles: { viewer: permissionsForRole('viewer'), manager: permissionsForRole('manager'), admin: permissionsForRole('admin'), owner: permissionsForRole('owner') } }; }
  can(userId, workspaceId, permission){
    const c=this.tenancy.context(userId,workspaceId,'viewer');
    const membership=c.state.memberships.find(m=>m.userId===userId&&m.workspaceId===workspaceId);
    return hasPermission(membership?.role||'viewer', permission);
  }
  list(userId, workspaceId){
    const c=this.tenancy.context(userId,workspaceId,'admin');
    return c.state.memberships.filter(m=>m.workspaceId===workspaceId).map(m=>({
      ...m,
      permissions: permissionsForRole(m.role),
      user:this.auth.publicUser(c.state.users.find(u=>u.id===m.userId)),
      shops:(m.shopIds||[]).map(shopId=>c.state.shops.find(s=>s.id===shopId)).filter(Boolean)
    }));
  }
  invites(userId, workspaceId){ const c=this.tenancy.context(userId,workspaceId,'admin'); return (c.state.invitations||[]).filter(i=>i.workspaceId===workspaceId); }
  async invite(userId,workspaceId,input){
    const c=this.tenancy.context(userId,workspaceId,'admin'); const email=String(input.email||'').trim().toLowerCase();
    assert(email.includes('@'),'EMAIL_REQUIRED','Укажите корректный email'); assert(roles.has(input.role),'ROLE_INVALID','Недопустимая роль');
    const shopIds=Array.isArray(input.shopIds)?input.shopIds:[]; shopIds.forEach(shopId=>assert(c.state.shops.some(s=>s.id===shopId&&s.workspaceId===workspaceId),'SHOP_NOT_FOUND','Магазин не найден',404));
    const raw=token();
    const invite=await this.store.transaction(userId,db=>{ db.invitations ||= []; const row={id:id('inv'),workspaceId,email,role:input.role,shopIds,token:raw,status:'pending',expiresAt:new Date(Date.now()+7*86400000).toISOString(),createdAt:new Date().toISOString(),createdBy:userId}; db.invitations.push(row); return row; });
    const acceptUrl=`${this.acceptBaseUrl}/?invite=${encodeURIComponent(invite.token)}`;
    let mail=null;
    if(this.mail){
      mail=await this.mail.send({
        to:email,
        subject:'Приглашение в GStore',
        text:`Вас пригласили в рабочее пространство GStore.\nРоль: ${invite.role}\nПринять приглашение: ${acceptUrl}\nТокен: ${invite.token}`,
        html:`<p>Вас пригласили в рабочее пространство GStore.</p><p>Роль: <b>${invite.role}</b></p><p><a href="${acceptUrl}">Принять приглашение</a></p><p>Токен: <code>${invite.token}</code></p>`,
      });
    }
    return {...invite, acceptUrl, mailStatus:mail?.status||'skipped'};
  }
  async accept(input){
    const raw=String(input.token||''); const state=this.store.snapshot(); const invite=(state.invitations||[]).find(i=>i.token===raw&&i.status==='pending');
    assert(invite&&new Date(invite.expiresAt)>new Date(),'INVITE_INVALID','Приглашение недействительно или истекло',400);
    return this.store.transaction('invite',db=>{ let user=db.users.find(u=>u.email===invite.email); if(!user){ assert(String(input.password||'').length>=8,'PASSWORD_WEAK','Пароль должен содержать минимум 8 символов'); user={id:id('usr'),email:invite.email,name:String(input.name||invite.email.split('@')[0]),passwordHash:hashPassword(input.password),createdAt:new Date().toISOString()}; db.users.push(user); }
      let membership=db.memberships.find(m=>m.userId===user.id&&m.workspaceId===invite.workspaceId); if(!membership){ membership={id:id('mem'),userId:user.id,workspaceId:invite.workspaceId,role:invite.role,shopIds:invite.shopIds}; db.memberships.push(membership); }
      const target=db.invitations.find(i=>i.id===invite.id); target.status='accepted'; target.acceptedAt=new Date().toISOString(); target.userId=user.id; return {user:this.auth.publicUser(user),membership}; });
  }
  async update(userId,workspaceId,membershipId,input){
    this.tenancy.context(userId,workspaceId,'admin'); if(input.role!==undefined) assert(roles.has(input.role),'ROLE_INVALID','Недопустимая роль');
    return this.store.transaction(userId,db=>{ const m=db.memberships.find(x=>x.id===membershipId&&x.workspaceId===workspaceId); assert(m,'MEMBERSHIP_NOT_FOUND','Сотрудник не найден',404); assert(m.role!=='owner','OWNER_IMMUTABLE','Роль владельца нельзя изменить',400); if(input.role)m.role=input.role; if(Array.isArray(input.shopIds))m.shopIds=input.shopIds; m.updatedAt=new Date().toISOString(); return m; });
  }
  async remove(userId,workspaceId,membershipId){ this.tenancy.context(userId,workspaceId,'admin'); return this.store.transaction(userId,db=>{ const m=db.memberships.find(x=>x.id===membershipId&&x.workspaceId===workspaceId); assert(m,'MEMBERSHIP_NOT_FOUND','Сотрудник не найден',404); assert(m.role!=='owner','OWNER_IMMUTABLE','Владельца нельзя удалить',400); db.memberships=db.memberships.filter(x=>x.id!==membershipId); db.sessions=db.sessions.filter(s=>s.userId!==m.userId); return {removed:true}; }); }
  audit(userId,workspaceId,limit=100){ const c=this.tenancy.context(userId,workspaceId,'admin'); return c.state.audit.slice(-Math.min(500,Number(limit)||100)).reverse(); }
}
