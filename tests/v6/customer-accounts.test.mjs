import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const botToken='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345';
const fakeFetch=async url=>({ok:true,json:async()=>({ok:true,result:url.endsWith('/getMe')?{id:777,username:'bot'}:true})});
const signInitData=user=>{const p=new URLSearchParams({auth_date:String(Math.floor(Date.now()/1000)),query_id:'q',user:JSON.stringify(user)});const check=[...p.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(botToken).digest();p.set('hash',crypto.createHmac('sha256',secret).update(check).digest('hex'));return p.toString()};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gtstore-v620-'));
const {server}=createApp({databaseFile:path.join(temp,'db.json'),mediaDirectory:path.join(temp,'media'),fetch:fakeFetch,telegramSecret:'secret'});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const base=`http://127.0.0.1:${server.address().port}/api/v6`;
const req=async(url,opt={})=>{const r=await fetch(base+url,{...opt,headers:{'content-type':'application/json',...(opt.headers||{})},body:opt.body?JSON.stringify(opt.body):undefined});const j=await r.json();if(!r.ok)throw Object.assign(new Error(j.error?.message),{status:r.status});return j};
try{
 await req('/bootstrap',{method:'POST',body:{email:'owner@test.local',password:'ChangeMe123!',name:'Owner'}});
 const login=await req('/auth/login',{method:'POST',body:{email:'owner@test.local',password:'ChangeMe123!'}});const ah={authorization:`Bearer ${login.token}`};
 const me=await req('/me',{headers:ah});const ws=me.workspaces[0];const shop=(await req(`/workspaces/${ws.id}/shops`,{headers:ah}))[0];
 await req(`/workspaces/${ws.id}/shops/${shop.id}/telegram/connect`,{method:'POST',headers:ah,body:{token:botToken,adminChatId:'-1'}});
 const cat=await req(`/workspaces/${ws.id}/shops/${shop.id}/categories`,{method:'POST',headers:ah,body:{name:'Test'}});
 const product=await req(`/workspaces/${ws.id}/shops/${shop.id}/products`,{method:'POST',headers:ah,body:{name:'Item',sku:'I-1',categoryId:cat.id,price:700,stock:4,active:true}});
 const auth=await req(`/public/storefronts/${shop.slug}/telegram/auth`,{method:'POST',body:{initData:signInitData({id:42,first_name:'Kirill'})}});const ch={authorization:`Bearer ${auth.token}`};
 const profile=await req('/public/profile',{headers:ch});assert.equal(profile.telegramId,'42');
 const updated=await req('/public/profile',{method:'PATCH',headers:ch,body:{name:'Кирилл',email:'k@test.local'}});assert.equal(updated.name,'Кирилл');
 await req('/public/profile/wishlist',{method:'POST',headers:ch,body:{productId:product.id}});assert.equal((await req('/public/profile/wishlist',{headers:ch})).length,1);
 const address=await req('/public/profile/addresses',{method:'POST',headers:ch,body:{label:'Дом',address:'Москва, Тверская 1',isDefault:true}});assert.equal(address.isDefault,true);
 const order=await req(`/public/storefronts/${shop.slug}/orders`,{method:'POST',body:{customer:{name:'Кирилл',phone:'+79990000000',telegramId:'42'},items:[{productId:product.id,quantity:2}]}});
 assert.equal((await req('/public/profile/orders',{headers:ch})).length,1);
 const repeat=await req(`/public/profile/repeat-order/${order.id}`,{method:'POST',headers:ch});assert.equal(repeat.items[0].quantity,2);assert.equal(repeat.items[0].unitPrice,700);
 await req(`/public/profile/wishlist/${product.id}`,{method:'DELETE',headers:ch});assert.equal((await req('/public/profile/wishlist',{headers:ch})).length,0);
 await req(`/public/profile/addresses/${address.id}`,{method:'DELETE',headers:ch});assert.equal((await req('/public/profile/addresses',{headers:ch})).length,0);
 console.log('V6.20 customer accounts tests passed');
}finally{await new Promise(r=>server.close(r));fs.rmSync(temp,{recursive:true,force:true})}
