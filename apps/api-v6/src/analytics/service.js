import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const dayKey = value => new Date(value).toISOString().slice(0,10);
const money = value => Math.round((Number(value)||0)*100)/100;
const inRange = (value, from, to) => {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time >= from.getTime() && time <= to.getTime();
};
const rangeFor = days => {
  const count = Math.max(1, Math.min(365, Math.floor(Number(days)||30)));
  const to = new Date();
  to.setHours(23,59,59,999);
  const from = new Date(to);
  from.setDate(from.getDate()-count+1);
  from.setHours(0,0,0,0);
  return {days:count,from,to};
};

export class AnalyticsService {
  constructor(store, tenancy) { this.store=store; this.tenancy=tenancy; }
  ensureShop(userId,workspaceId,shopId){
    const context=this.tenancy.context(userId,workspaceId,'viewer');
    const shop=context.state.shops.find(item=>item.id===shopId&&item.workspaceId===workspaceId);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    return {...context,shop};
  }
  async track(slug,input={}){
    const allowed=new Set(['visit','product_view','add_to_cart','checkout_started']);
    const type=String(input.type||'');
    assert(allowed.has(type),'ANALYTICS_EVENT_INVALID','Некорректное событие аналитики');
    return this.store.transaction('public-analytics',db=>{
      const shop=db.shops.find(item=>item.slug===slug);
      assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
      db.analyticsEvents||=[];
      const event={id:id('anl'),shopId:shop.id,type,productId:input.productId||null,source:String(input.source||'direct').slice(0,80),sessionId:String(input.sessionId||'').slice(0,120),createdAt:new Date().toISOString()};
      db.analyticsEvents.push(event);
      return {accepted:true,eventId:event.id};
    });
  }
  dashboard(userId,workspaceId,shopId,days=30){
    const {state}=this.ensureShop(userId,workspaceId,shopId);
    const range=rangeFor(days);
    const orders=(state.orders||[]).filter(o=>o.shopId===shopId&&inRange(o.createdAt,range.from,range.to));
    const validOrders=orders.filter(o=>!['cancelled','refunded'].includes(o.status));
    const paidOrders=orders.filter(o=>o.paymentStatus==='paid'||['paid','assembling','ready','shipped','completed'].includes(o.status));
    const events=(state.analyticsEvents||[]).filter(e=>e.shopId===shopId&&inRange(e.createdAt,range.from,range.to));
    const visits=events.filter(e=>e.type==='visit').length;
    const productViews=events.filter(e=>e.type==='product_view').length;
    const carts=events.filter(e=>e.type==='add_to_cart').length;
    const checkoutStarted=events.filter(e=>e.type==='checkout_started').length;
    const revenue=money(paidOrders.reduce((sum,o)=>sum+Number(o.total||0),0));
    const averageOrder=validOrders.length?money(validOrders.reduce((sum,o)=>sum+Number(o.total||0),0)/validOrders.length):0;
    const conversion=visits?money(validOrders.length/visits*100):0;
    const dates=[]; for(let i=0;i<range.days;i++){const d=new Date(range.from);d.setDate(d.getDate()+i);dates.push(dayKey(d));}
    const series=dates.map(date=>{const dailyOrders=orders.filter(o=>dayKey(o.createdAt)===date);const dailyPaid=dailyOrders.filter(o=>o.paymentStatus==='paid'||['paid','assembling','ready','shipped','completed'].includes(o.status));return {date,orders:dailyOrders.length,revenue:money(dailyPaid.reduce((s,o)=>s+Number(o.total||0),0)),visits:events.filter(e=>e.type==='visit'&&dayKey(e.createdAt)===date).length};});
    const productMap=new Map();
    for(const order of validOrders) for(const line of order.lines||[]){const item=productMap.get(line.productId)||{productId:line.productId,name:line.name,quantity:0,revenue:0};item.quantity+=Number(line.quantity||0);item.revenue=money(item.revenue+Number(line.total||0));productMap.set(line.productId,item);}
    const topProducts=[...productMap.values()].sort((a,b)=>b.revenue-a.revenue).slice(0,10);
    const sourceMap=new Map();
    for(const order of validOrders){const source=order.source||'direct';const item=sourceMap.get(source)||{source,orders:0,revenue:0};item.orders++;item.revenue=money(item.revenue+Number(order.total||0));sourceMap.set(source,item);}
    for(const event of events.filter(e=>e.type==='visit')){const source=event.source||'direct';const item=sourceMap.get(source)||{source,orders:0,revenue:0};item.visits=(item.visits||0)+1;sourceMap.set(source,item);}
    const sources=[...sourceMap.values()].sort((a,b)=>(b.revenue||0)-(a.revenue||0));
    const customers=(state.orders||[]).filter(o=>o.shopId===shopId&&!['cancelled','refunded'].includes(o.status));
    const customerKeys=new Map(); for(const o of customers){const key=o.customer?.telegramId||o.customer?.phone||o.customer?.email;if(key)customerKeys.set(key,(customerKeys.get(key)||0)+1);}
    const campaigns=(state.campaigns||[]).filter(c=>c.shopId===shopId);
    const campaignMetrics={campaigns:campaigns.length,targeted:campaigns.reduce((s,c)=>s+Number(c.metrics?.targeted||0),0),sent:campaigns.reduce((s,c)=>s+Number(c.metrics?.sent||0),0),failed:campaigns.reduce((s,c)=>s+Number(c.metrics?.failed||0),0)};
    const automationRuns=(state.automationRuns||[]).filter(r=>r.shopId===shopId);
    const automationMetrics={rules:(state.automationRules||[]).filter(r=>r.shopId===shopId).length,total:automationRuns.length,sent:automationRuns.filter(r=>r.status==='sent').length,failed:automationRuns.filter(r=>r.status==='failed').length,pending:automationRuns.filter(r=>r.status==='pending').length};
    return {range:{days:range.days,from:range.from.toISOString(),to:range.to.toISOString()},metrics:{revenue,orders:validOrders.length,paidOrders:paidOrders.length,averageOrder,conversion,visits,productViews,carts,checkoutStarted,newCustomers:[...customerKeys.values()].filter(n=>n===1).length,repeatCustomers:[...customerKeys.values()].filter(n=>n>1).length},funnel:[{key:'visits',label:'Визиты',value:visits},{key:'views',label:'Просмотры товаров',value:productViews},{key:'carts',label:'Добавления в корзину',value:carts},{key:'checkout',label:'Начали оформление',value:checkoutStarted},{key:'orders',label:'Заказы',value:validOrders.length}],series,topProducts,sources,campaigns:campaignMetrics,automations:automationMetrics};
  }
}
