import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createApp} from '../../apps/api-v6/src/app.js';

const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtstore-v617-'));
const {server}=createApp({databaseFile:path.join(dir,'db.json'),mediaDirectory:path.join(dir,'media')});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/v6`;
const req=async(url,opt={})=>{const res=await fetch(base+url,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})},body:opt.body?JSON.stringify(opt.body):undefined});const body=res.status===204?null:await res.json();if(!res.ok)throw Object.assign(new Error(body?.error?.message||`HTTP ${res.status}`),{status:res.status,body});return body};
try{
  const boot=await req('/bootstrap',{method:'POST',body:{email:'warehouse@test.local',password:'Password123!',name:'Warehouse'}});
  const login=await req('/auth/login',{method:'POST',body:{email:'warehouse@test.local',password:'Password123!'}});
  const auth={authorization:`Bearer ${login.token}`}; const ws=boot.workspace; const shop=boot.shop; const root=`/workspaces/${ws.id}/shops/${shop.id}`;
  const category=await req(root+'/categories',{method:'POST',headers:auth,body:{name:'Склад'}});
  const product=await req(root+'/products',{method:'POST',headers:auth,body:{name:'Warehouse Product',sku:'WH-BASE',categoryId:category.id,price:1000,stock:0,active:true,variants:[{name:'Black',sku:'WH-BLK',price:1000,stock:10,active:true},{name:'White',sku:'WH-WHT',price:1100,stock:2,active:true}]}});
  const metrics=await req(root+'/warehouse/metrics',{headers:auth}); assert.equal(metrics.skuCount,2); assert.equal(metrics.totalStock,12); assert.equal(metrics.lowStock,1);
  const black=product.variants.find(v=>v.sku==='WH-BLK'); const white=product.variants.find(v=>v.sku==='WH-WHT');
  const receipt=await req(root+'/warehouse/adjust',{method:'POST',headers:auth,body:{productId:product.id,variantId:white.id,delta:5,reason:'Поставка',reference:'SUP-1'}}); assert.equal(receipt.type,'receipt'); assert.equal(receipt.after,7);
  const transfer=await req(root+'/warehouse/transfer',{method:'POST',headers:auth,body:{productId:product.id,fromVariantId:black.id,toVariantId:white.id,quantity:3}}); assert.equal(transfer.out.after,7); assert.equal(transfer.in.after,10);
  const stocktake=await req(root+'/warehouse/stocktakes',{method:'POST',headers:auth,body:{note:'Плановая проверка',items:[{productId:product.id,variantId:black.id,actual:6},{productId:product.id,variantId:white.id,actual:9}]}}); assert.equal(stocktake.status,'completed'); assert.equal(stocktake.differences,2);
  await req(root+'/storefront/publish',{method:'POST',headers:auth});
  const order=await req(`/public/storefronts/${shop.slug}/orders`,{method:'POST',body:{customer:{name:'Кирилл',phone:'+79990000000'},items:[{productId:product.id,variantId:black.id,quantity:2}]}}); assert.equal(order.lines[0].quantity,2);
  let inventory=await req(root+'/warehouse/inventory?q=WH-BLK',{headers:auth}); assert.equal(inventory[0].stock,6); assert.equal(inventory[0].available,4); assert.equal(inventory[0].reserved,2);
  const reservations=await req(root+'/warehouse/reservations',{headers:auth}); assert.equal(reservations.filter(r=>r.status==='active').length,1);
  await req(root+`/orders/${order.id}`,{method:'PATCH',headers:auth,body:{status:'confirmed'}});
  inventory=await req(root+'/warehouse/inventory?q=WH-BLK',{headers:auth}); assert.equal(inventory[0].stock,4); assert.equal(inventory[0].available,4);
  let movements=await req(root+'/warehouse/movements',{headers:auth}); assert.ok(movements.some(x=>x.type==='sale'&&x.reference===order.id)); assert.ok(movements.some(x=>x.type==='stocktake'));
  const cancelled=await req(root+`/orders/${order.id}`,{method:'PATCH',headers:auth,body:{status:'cancelled'}}); assert.equal(cancelled.status,'cancelled');
  inventory=await req(root+'/warehouse/inventory?q=WH-BLK',{headers:auth}); assert.equal(inventory[0].stock,6);
  movements=await req(root+'/warehouse/movements?type=return',{headers:auth}); assert.equal(movements.length,1); assert.equal(movements[0].reference,order.id);
  const stocktakes=await req(root+'/warehouse/stocktakes',{headers:auth}); assert.equal(stocktakes.length,1);
  console.log('V6.17 warehouse tests passed');
} finally {await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
