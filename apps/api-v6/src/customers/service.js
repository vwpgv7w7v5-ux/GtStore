import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
const now=()=>new Date().toISOString();
const normPhone=v=>String(v||'').replace(/\D/g,'');
const normEmail=v=>String(v||'').trim().toLowerCase();
const money=v=>Math.round((Number(v)||0)*100)/100;
const tgNick=v=>{
  const raw=String(v||'').trim().replace(/^@/,'');
  return raw||'';
};

export class CustomerService {
 constructor(store,tenancy){this.store=store;this.tenancy=tenancy;}
 ensureShop(userId,workspaceId,shopId,role='viewer'){const c=this.tenancy.context(userId,workspaceId,role);const shop=c.state.shops.find(s=>s.id===shopId&&s.workspaceId===workspaceId);assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);return{...c,shop};}
 key(customer={}){const tg=String(customer.telegramId||'').trim();if(tg)return`tg:${tg}`;const phone=normPhone(customer.phone);if(phone)return`phone:${phone}`;const email=normEmail(customer.email);return email?`email:${email}`:'';}
 tier(spend){if(spend>=100000)return{name:'Platinum',cashback:7};if(spend>=50000)return{name:'Gold',cashback:5};if(spend>=15000)return{name:'Silver',cashback:3};return{name:'Base',cashback:1};}

 ensureRow(grouped,key,shopId,seed={}){
  if(!key) return null;
  let row=grouped.get(key);
  if(!row){
    row={
      key,shopId,
      name:'',phone:'',email:'',telegramId:'',telegramUsername:'',
      firstName:'',lastName:'',
      orders:0,completedOrders:0,totalSpend:0,
      lastOrderAt:null,firstOrderAt:null,
      firstSeenAt:null,lastSeenAt:null,visitCount:0,
      source:'',
      ...seed,
    };
    grouped.set(key,row);
  }
  return row;
 }

 markSeen(row,at){
  if(!at) return;
  if(!row.firstSeenAt||at<row.firstSeenAt) row.firstSeenAt=at;
  if(!row.lastSeenAt||at>row.lastSeenAt) row.lastSeenAt=at;
 }

 aggregate(state,shopId){
  const profiles=new Map((state.customerProfiles||[]).filter(p=>p.shopId===shopId).map(p=>[p.key,p]));
  const grouped=new Map();

  for(const order of (state.orders||[]).filter(o=>o.shopId===shopId)){
    const key=this.key(order.customer);
    if(!key) continue;
    const row=this.ensureRow(grouped,key,shopId,{source:'order'});
    Object.assign(row,{
      name:order.customer?.name||row.name,
      phone:order.customer?.phone||row.phone,
      email:order.customer?.email||row.email,
      telegramId:order.customer?.telegramId||row.telegramId,
    });
    row.orders++;
    if(!['cancelled','refunded'].includes(order.status)){
      row.totalSpend=money(row.totalSpend+Number(order.total||0));
      if(order.status==='completed') row.completedOrders++;
    }
    row.lastOrderAt=!row.lastOrderAt||order.createdAt>row.lastOrderAt?order.createdAt:row.lastOrderAt;
    row.firstOrderAt=!row.firstOrderAt||order.createdAt<row.firstOrderAt?order.createdAt:row.firstOrderAt;
    this.markSeen(row,order.createdAt);
  }

  // Profiles created via Mini App / bot (may have no orders yet)
  for(const profile of profiles.values()){
    const key=profile.key;
    if(!key) continue;
    const tg=String(profile.telegramId||(key.startsWith('tg:')?key.slice(3):'')).trim();
    const row=this.ensureRow(grouped,key,shopId,{
      telegramId:tg,
      source:key.startsWith('tg:')?'telegram':'profile',
    });
    row.name=row.name||profile.name||[profile.firstName,profile.lastName].filter(Boolean).join(' ')||'';
    row.phone=row.phone||profile.phone||'';
    row.email=row.email||profile.email||'';
    row.telegramId=row.telegramId||tg;
    row.telegramUsername=tgNick(profile.username||profile.telegramUsername)||row.telegramUsername;
    row.firstName=row.firstName||profile.firstName||'';
    row.lastName=row.lastName||profile.lastName||'';
    const first=profile.firstSeenAt||profile.createdAt||profile.referredAt;
    const last=profile.lastSeenAt||profile.updatedAt||profile.createdAt||profile.referredAt;
    this.markSeen(row,first);
    this.markSeen(row,last);
    const visits=Number(profile.visitCount||0);
    if(visits>row.visitCount) row.visitCount=visits;
  }

  // Anyone who messaged the bot / got welcome — show @username
  for(const m of state.telegramMessages||[]){
    if(m.shopId!==shopId) continue;
    // Outbound order alerts to the administrator are not customer visits.
    if(m.direction!=='inbound'&&m.type!=='incoming'&&!m.fromId&&!m.from?.id) continue;
    const tg=String(m.chatId||m.telegramId||m.fromId||m.from?.id||'').trim();
    if(!tg) continue;
    const key=`tg:${tg}`;
    const username=tgNick(m.username||m.fromUsername||m.from?.username);
    const name=[m.from?.firstName||m.firstName,m.from?.lastName||m.lastName].filter(Boolean).join(' ');
    const row=this.ensureRow(grouped,key,shopId,{telegramId:tg,source:'telegram'});
    if(username) row.telegramUsername=username;
    if(name&&!row.name) row.name=name;
    row.firstName=row.firstName||m.from?.firstName||'';
    row.lastName=row.lastName||m.from?.lastName||'';
    this.markSeen(row,m.createdAt||m.at);
  }

  for(const w of state.telegramWelcomeLog||[]){
    if(w.shopId!==shopId) continue;
    const tg=String(w.chatId||'').trim();
    if(!tg) continue;
    const key=`tg:${tg}`;
    const row=this.ensureRow(grouped,key,shopId,{telegramId:tg,source:'telegram'});
    this.markSeen(row,w.sentAt);
  }

  const ledger=state.loyaltyLedger||[];
  return[...grouped.values()].map(c=>{
    const profile=profiles.get(c.key)||{};
    const tier=this.tier(c.totalSpend);
    const balance=money(ledger.filter(x=>x.shopId===shopId&&x.customerKey===c.key).reduce((s,x)=>s+Number(x.amount||0),0));
    const segment=profile.segment||(c.totalSpend>=100000?'vip':c.orders>=2?'repeat':'new');
    const telegramUsername=tgNick(c.telegramUsername||profile.username||profile.telegramUsername);
    const displayName=c.name||[c.firstName,c.lastName].filter(Boolean).join(' ')||(telegramUsername?`@${telegramUsername}`:(c.telegramId?`TG ${c.telegramId}`:'Без имени'));
    const firstSeenAt=c.firstSeenAt||profile.firstSeenAt||profile.createdAt||c.firstOrderAt||null;
    const lastSeenAt=c.lastSeenAt||profile.lastSeenAt||profile.updatedAt||c.lastOrderAt||firstSeenAt||null;
    let visitCount=Number(profile.visitCount||c.visitCount||0);
    if(!Number.isFinite(visitCount)||visitCount<0) visitCount=0;
    // Backfill for older profiles without visitCount
    if(visitCount<1&&(firstSeenAt||lastSeenAt)){
      const same=firstSeenAt&&lastSeenAt&&String(firstSeenAt)===String(lastSeenAt);
      visitCount=same?1:2;
    }
    if(visitCount<1&&c.orders) visitCount=1;
    const returned=visitCount>=2;
    return{
      ...c,
      id:profile.id||c.key,
      name:displayName,
      telegramUsername,
      notes:profile.notes||'',
      tags:profile.tags||[],
      segment,
      tier:tier.name,
      cashback:tier.cashback,
      bonusBalance:balance,
      averageCheck:c.orders?money(c.totalSpend/c.orders):0,
      launchedBot:Boolean(c.telegramId),
      firstSeenAt,
      lastSeenAt,
      visitCount,
      returned,
    };
  }).sort((a,b)=>String(b.lastSeenAt||b.lastOrderAt||'').localeCompare(String(a.lastSeenAt||a.lastOrderAt||'')));
 }

 list(userId,workspaceId,shopId,filters={}){
  const{state}=this.ensureShop(userId,workspaceId,shopId);
  const q=String(filters.query||'').toLowerCase(),segment=String(filters.segment||'all');
  return this.aggregate(state,shopId)
    .filter(c=>{
      if(segment==='all') return true;
      if(segment==='telegram') return Boolean(String(c.telegramId||'').trim());
      return c.segment===segment;
    })
    .filter(c=>!q||`${c.name} ${c.phone} ${c.email} ${c.telegramId} ${c.telegramUsername}`.toLowerCase().includes(q));
 }
 get(userId,workspaceId,shopId,customerKey){
  const{state}=this.ensureShop(userId,workspaceId,shopId);
  const customer=this.aggregate(state,shopId).find(c=>c.key===customerKey||c.id===customerKey);
  assert(customer,'CUSTOMER_NOT_FOUND','Клиент не найден',404);
  return{
    ...customer,
    orders:(state.orders||[]).filter(o=>o.shopId===shopId&&this.key(o.customer)===customer.key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
    ledger:(state.loyaltyLedger||[]).filter(x=>x.shopId===shopId&&x.customerKey===customer.key).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)),
    promos:(state.personalPromos||[]).filter(x=>x.shopId===shopId&&x.customerKey===customer.key),
  };
 }
 metrics(userId,workspaceId,shopId){
  const customers=this.list(userId,workspaceId,shopId);
  return{
    total:customers.length,
    new:customers.filter(c=>c.segment==='new').length,
    repeat:customers.filter(c=>c.segment==='repeat').length,
    vip:customers.filter(c=>c.segment==='vip').length,
    telegram:customers.filter(c=>c.telegramId).length,
    returned:customers.filter(c=>c.returned).length,
    ltv:customers.length?money(customers.reduce((s,c)=>s+c.totalSpend,0)/customers.length):0,
    bonusLiability:money(customers.reduce((s,c)=>s+c.bonusBalance,0)),
  };
 }
 async update(userId,workspaceId,shopId,customerKey,input={}){
  this.ensureShop(userId,workspaceId,shopId,'manager');
  return this.store.transaction(userId,db=>{
    db.customerProfiles||=[];
    let p=db.customerProfiles.find(x=>x.shopId===shopId&&x.key===customerKey);
    if(!p){p={id:id('cus'),shopId,key:customerKey,createdAt:now()};db.customerProfiles.push(p);}
    if(input.notes!==undefined)p.notes=String(input.notes||'');
    if(input.segment!==undefined)p.segment=['new','repeat','vip'].includes(input.segment)?input.segment:'';
    if(input.tags!==undefined)p.tags=Array.isArray(input.tags)?input.tags.map(String):[];
    p.updatedAt=now();
    return p;
  });
 }
 async adjustBonus(userId,workspaceId,shopId,customerKey,input={}){
  this.ensureShop(userId,workspaceId,shopId,'manager');
  const amount=money(input.amount);
  assert(amount!==0,'BONUS_AMOUNT_REQUIRED','Укажите сумму бонусов');
  return this.store.transaction(userId,db=>{
    db.loyaltyLedger||=[];
    const current=db.loyaltyLedger.filter(x=>x.shopId===shopId&&x.customerKey===customerKey).reduce((s,x)=>s+Number(x.amount||0),0);
    assert(current+amount>=0,'INSUFFICIENT_BONUS','Недостаточно бонусов');
    const entry={id:id('bon'),shopId,customerKey,amount,reason:String(input.reason||'Ручная корректировка'),type:amount>0?'credit':'debit',actor:userId,createdAt:now()};
    db.loyaltyLedger.push(entry);
    return{entry,balance:money(current+amount)};
  });
 }
 async accrueForOrder(order){
  if(!order||order.status!=='completed')return null;
  const key=this.key(order.customer);
  if(!key)return null;
  return this.store.transaction('loyalty',db=>{
    db.loyaltyLedger||=[];
    if(db.loyaltyLedger.some(x=>x.orderId===order.id&&x.type==='cashback'))return null;
    const customer=this.aggregate(db,order.shopId).find(c=>c.key===key),percent=customer?.cashback||1,amount=money(Number(order.total||0)*percent/100);
    if(amount<=0)return null;
    const entry={id:id('bon'),shopId:order.shopId,customerKey:key,orderId:order.id,amount,reason:`Кэшбэк ${percent}% за заказ №${order.number}`,type:'cashback',createdAt:now()};
    db.loyaltyLedger.push(entry);
    return entry;
  });
 }
 async createPersonalPromo(userId,workspaceId,shopId,customerKey,input={}){
  this.ensureShop(userId,workspaceId,shopId,'manager');
  return this.store.transaction(userId,db=>{
    db.personalPromos||=[];
    const code=String(input.code||`CLIENT${Math.random().toString(36).slice(2,8)}`).toUpperCase();
    assert(!db.personalPromos.some(p=>p.shopId===shopId&&p.code===code),'PROMO_EXISTS','Такой промокод уже существует');
    const promo={id:id('prm'),shopId,customerKey,code,discount:Math.min(90,Math.max(1,Number(input.discount)||10)),active:true,expiresAt:input.expiresAt||null,createdAt:now()};
    db.personalPromos.push(promo);
    return promo;
  });
 }
}
