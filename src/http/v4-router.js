'use strict';
const {JsonRepository}=require('../core/repository');
const {CategoryService}=require('../catalog/category-service');
const {ProductService}=require('../catalog/product-service');
const {OrderService}=require('../orders/order-service');
const {ReferralService}=require('../referrals/referral-service');
const {ChannelRegistry}=require('../channels/registry');
const {createDefaultRegistry}=require('../integrations/registry');
const {AppError}=require('../core/errors');
function send(res,status,data){res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store'});res.end(JSON.stringify(data));}
function readBody(req){return new Promise((resolve,reject)=>{let s='';req.on('data',c=>{s+=c;if(s.length>2_000_000){reject(new Error('Payload too large'));req.destroy();}});req.on('end',()=>{try{resolve(s?JSON.parse(s):{});}catch(e){reject(e);}});req.on('error',reject);});}
function createV4Router({dbFile,authorize}){
 const repo=new JsonRepository(dbFile),categories=new CategoryService(repo),products=new ProductService(repo),orders=new OrderService(repo),referrals=new ReferralService(repo),channels=new ChannelRegistry(),integrations=createDefaultRegistry();
 return async function route(req,res,url){
  if(!url.pathname.startsWith('/api/v4/'))return false;
  try{
   const user=authorize?authorize(req,res):{role:'owner'};if(!user)return true;
   const parts=url.pathname.split('/').filter(Boolean),shopId=url.searchParams.get('shopId')||'demo';
   if(req.method==='GET'&&url.pathname==='/api/v4/health')return send(res,200,{ok:true,version:'4.0.0',architecture:'modular-core',channels:channels.list(),integrations:integrations.list(),revision:repo.read().meta?.revision||0}),true;
   if(req.method==='GET'&&url.pathname==='/api/v4/catalog/categories')return send(res,200,{items:categories.list(shopId),tree:categories.tree(shopId)}),true;
   if(req.method==='POST'&&url.pathname==='/api/v4/catalog/categories')return send(res,201,await categories.create(shopId,await readBody(req))),true;
   if(parts[2]==='catalog'&&parts[3]==='categories'&&parts[4]){
    if(req.method==='PATCH')return send(res,200,await categories.update(shopId,parts[4],await readBody(req))),true;
    if(req.method==='DELETE')return send(res,200,await categories.remove(shopId,parts[4])),true;
   }
   if(req.method==='GET'&&url.pathname==='/api/v4/catalog/products')return send(res,200,{items:products.list(shopId,{search:url.searchParams.get('search')||'',categoryId:url.searchParams.get('categoryId')||''})}),true;
   if(req.method==='POST'&&url.pathname==='/api/v4/catalog/products')return send(res,201,await products.create(shopId,await readBody(req))),true;
   if(parts[2]==='catalog'&&parts[3]==='products'&&parts[4]){
    if(req.method==='PATCH')return send(res,200,await products.update(shopId,parts[4],await readBody(req))),true;
    if(req.method==='DELETE')return send(res,200,await products.remove(shopId,parts[4])),true;
   }
   if(req.method==='GET'&&url.pathname==='/api/v4/orders')return send(res,200,{items:orders.list(shopId)}),true;
   if(req.method==='POST'&&url.pathname==='/api/v4/orders')return send(res,201,await orders.create(shopId,await readBody(req))),true;
   if(parts[2]==='orders'&&parts[3]&&parts[4]==='transition'&&req.method==='POST'){const b=await readBody(req);return send(res,200,await orders.transition(shopId,parts[3],b.status)),true;}
   if(req.method==='POST'&&url.pathname==='/api/v4/referrals')return send(res,201,await referrals.create(shopId,await readBody(req))),true;
   if(req.method==='GET'&&url.pathname==='/api/v4/referrals/summary')return send(res,200,referrals.summary(shopId,url.searchParams.get('referralId'))),true;
   if(req.method==='GET'&&url.pathname==='/api/v4/integrations')return send(res,200,{items:integrations.list()}),true;
   return send(res,404,{error:'V4 endpoint not found'}),true;
  }catch(error){const status=error instanceof AppError?error.status:500;send(res,status,{error:error.message,code:error.code||'INTERNAL_ERROR',details:error.details||null});return true;}
 };
}
module.exports={createV4Router};
