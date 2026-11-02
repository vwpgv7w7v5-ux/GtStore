import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
const now=()=>new Date().toISOString();
const allowedSegments=new Set(['all','telegram','new','repeat','vip']);
const allowedStatuses=new Set(['draft','scheduled','sending','sent','failed','cancelled']);
export class CampaignService{
 constructor(store,tenancy,customers,telegram){this.store=store;this.tenancy=tenancy;this.customers=customers;this.telegram=telegram;}
 ensureShop(userId,workspaceId,shopId,role='viewer'){const c=this.tenancy.context(userId,workspaceId,role);const shop=c.state.shops.find(s=>s.id===shopId&&s.workspaceId===workspaceId);assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);return{...c,shop};}
 list(userId,workspaceId,shopId){const{state}=this.ensureShop(userId,workspaceId,shopId);return(state.campaigns||[]).filter(x=>x.shopId===shopId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(c=>({...c,deliveries:(state.campaignDeliveries||[]).filter(d=>d.campaignId===c.id)}));}
 get(userId,workspaceId,shopId,campaignId){const{state}=this.ensureShop(userId,workspaceId,shopId);const c=(state.campaigns||[]).find(x=>x.id===campaignId&&x.shopId===shopId);assert(c,'CAMPAIGN_NOT_FOUND','Кампания не найдена',404);return{...c,deliveries:(state.campaignDeliveries||[]).filter(d=>d.campaignId===c.id)};}
 async create(userId,workspaceId,shopId,input={}){this.ensureShop(userId,workspaceId,shopId,'manager');const name=String(input.name||'').trim(),message=String(input.message||'').trim(),segment=String(input.segment||'all');const channel=['telegram','max'].includes(input.channel)?input.channel:'telegram';assert(name,'CAMPAIGN_NAME_REQUIRED','Укажите название кампании');assert(message,'CAMPAIGN_MESSAGE_REQUIRED','Введите текст сообщения');assert(allowedSegments.has(segment),'CAMPAIGN_SEGMENT_INVALID','Некорректный сегмент');return this.store.transaction(userId,db=>{db.campaigns||=[];const campaign={id:id('cmp'),workspaceId,shopId,name,message,segment,channel,status:input.scheduledAt?'scheduled':'draft',scheduledAt:input.scheduledAt||null,createdAt:now(),updatedAt:now(),metrics:{targeted:0,sent:0,failed:0}};db.campaigns.push(campaign);return campaign;});}
 async update(userId,workspaceId,shopId,campaignId,input={}){this.ensureShop(userId,workspaceId,shopId,'manager');return this.store.transaction(userId,db=>{const c=(db.campaigns||[]).find(x=>x.id===campaignId&&x.shopId===shopId);assert(c,'CAMPAIGN_NOT_FOUND','Кампания не найдена',404);assert(!['sending','sent'].includes(c.status),'CAMPAIGN_LOCKED','Отправленную кампанию нельзя редактировать');if(input.name!==undefined)c.name=String(input.name||'').trim();if(input.message!==undefined)c.message=String(input.message||'').trim();if(input.segment!==undefined){assert(allowedSegments.has(input.segment),'CAMPAIGN_SEGMENT_INVALID','Некорректный сегмент');c.segment=input.segment;}if(input.scheduledAt!==undefined){c.scheduledAt=input.scheduledAt||null;c.status=c.scheduledAt?'scheduled':'draft';}if(input.status!==undefined){assert(allowedStatuses.has(input.status),'CAMPAIGN_STATUS_INVALID','Некорректный статус');c.status=input.status;}c.updatedAt=now();return c;});}
 audience(shopId,segment){
  const state=this.store.snapshot();
  const seg=String(segment||'all');
  return this.customers.aggregate(state,shopId).filter((c)=>{
   const tg=String(c.telegramId||'').trim();
   if(!tg) return false;
   if(seg==='all'||seg==='telegram') return true;
   return c.segment===seg;
  });
 }
 audiencePreview(userId,workspaceId,shopId,segment='telegram'){
  this.ensureShop(userId,workspaceId,shopId);
  const items=this.audience(shopId,segment);
  return {segment,count:items.length,sample:items.slice(0,8).map((c)=>({key:c.key,name:c.name,telegramId:c.telegramId,username:c.telegramUsername||c.username||''}))};
 }
 async broadcast(userId,workspaceId,shopId,input={}){
  this.ensureShop(userId,workspaceId,shopId,'manager');
  const message=String(input.message||'').trim();
  assert(message,'CAMPAIGN_MESSAGE_REQUIRED','Введите текст сообщения');
  const segment=allowedSegments.has(String(input.segment||''))?String(input.segment):'telegram';
  const audience=this.audience(shopId,segment);
  assert(audience.length,'CAMPAIGN_AUDIENCE_EMPTY','Нет получателей: никто ещё не открывал бота или Mini App');
  const stamp=new Date().toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'});
  const name=String(input.name||'').trim()||`Рассылка бота · ${stamp}`;
  const campaign=await this.create(userId,workspaceId,shopId,{name,message,segment,channel:'telegram'});
  return this.send(userId,workspaceId,shopId,campaign.id);
 }
 async send(userId,workspaceId,shopId,campaignId){this.ensureShop(userId,workspaceId,shopId,'manager');const campaign=this.get(userId,workspaceId,shopId,campaignId);assert(!['sending','sent','cancelled'].includes(campaign.status),'CAMPAIGN_STATUS_INVALID','Кампания уже отправлена или отменена');const audience=this.audience(shopId,campaign.segment);await this.store.transaction(userId,db=>{const c=db.campaigns.find(x=>x.id===campaignId);c.status='sending';c.metrics={targeted:audience.length,sent:0,failed:0};c.updatedAt=now();});let sent=0,failed=0;for(const customer of audience){let result;try{result=await this.telegram.sendDirect(shopId,customer.telegramId,campaign.message);result.sent?sent++:failed++;}catch{failed++;result={sent:false,reason:'send_failed'};}await this.store.transaction('campaign-worker',db=>{db.campaignDeliveries||=[];db.campaignDeliveries.push({id:id('cmd'),campaignId,shopId,customerKey:customer.key,telegramId:String(customer.telegramId),status:result.sent?'sent':'failed',reason:result.reason||'',messageId:result.messageId||null,createdAt:now()});});}
 return this.store.transaction(userId,db=>{const c=db.campaigns.find(x=>x.id===campaignId);c.status=failed&&sent===0?'failed':'sent';c.sentAt=now();c.metrics={targeted:audience.length,sent,failed};c.updatedAt=now();return c;});}
 async runDue(actor='scheduler'){const state=this.store.snapshot(),due=(state.campaigns||[]).filter(c=>c.status==='scheduled'&&c.scheduledAt&&new Date(c.scheduledAt)<=new Date());const results=[];for(const c of due){const member=(state.memberships||[]).find(m=>m.workspaceId===c.workspaceId&&['owner','admin','manager'].includes(m.role));if(member)results.push(await this.send(member.userId,c.workspaceId,c.shopId,c.id));}return{processed:results.length,results};}
}
