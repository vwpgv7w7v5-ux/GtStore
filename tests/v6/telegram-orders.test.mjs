import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const calls=[];
const fakeFetch=async(url,options={})=>{
  const method=url.split('/').at(-1); const payload=JSON.parse(options.body||'{}'); calls.push({method,payload});
  const result=method==='getMe'?{id:777,username:'gtstore_test_bot'}:method==='sendMessage'?{message_id:101,chat:{id:payload.chat_id}}:true;
  return {ok:true,json:async()=>({ok:true,result})};
};
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'gtstore-v65-'));
const {server}=createApp({databaseFile:path.join(temp,'db.json'),mediaDirectory:path.join(temp,'media'),fetch:fakeFetch,telegramSecret:'test-secret'});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const origin=`http://127.0.0.1:${server.address().port}`; const base=origin+'/api/v6';
const request=async(url,options={})=>{const response=await fetch(base+url,{...options,headers:{'content-type':'application/json',...(options.headers||{})},body:options.body?JSON.stringify(options.body):undefined});const body=response.status===204?null:await response.json();if(!response.ok)throw Object.assign(new Error(body?.error?.message||'HTTP error'),{status:response.status,body});return body};
try{
  await request('/bootstrap',{method:'POST',body:{email:'owner@test.local',password:'ChangeMe123!',name:'Owner'}});
  const login=await request('/auth/login',{method:'POST',body:{email:'owner@test.local',password:'ChangeMe123!'}}); const auth={authorization:`Bearer ${login.token}`};
  const me=await request('/me',{headers:auth}); const workspace=me.workspaces[0]; const shop=(await request(`/workspaces/${workspace.id}/shops`,{headers:auth}))[0];
  const connected=await request(`/workspaces/${workspace.id}/shops/${shop.id}/telegram/connect`,{method:'POST',headers:auth,body:{token:'123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345',adminChatId:'-100123',webhookUrl:`${origin}/api/v6/telegram/webhook/${shop.id}`,webhookSecret:'hook-secret'}});
  assert.equal(connected.connected,true); assert.equal(connected.botUsername,'gtstore_test_bot'); assert.equal('token' in connected,false);
  const config=await request(`/workspaces/${workspace.id}/shops/${shop.id}/telegram`,{headers:auth}); assert.equal(config.adminChatId,'-100123');
  const category=await request(`/workspaces/${workspace.id}/shops/${shop.id}/categories`,{method:'POST',headers:auth,body:{name:'Telegram'}});
  const product=await request(`/workspaces/${workspace.id}/shops/${shop.id}/products`,{method:'POST',headers:auth,body:{name:'Telegram товар',sku:'TG-1',categoryId:category.id,price:500,stock:3,active:true}});
  const order=await request(`/public/storefronts/${shop.slug}/orders`,{method:'POST',body:{customer:{name:'Кирилл',phone:'+79990000000',telegramId:'42'},items:[{productId:product.id,quantity:1}]}});
  assert.equal(order.telegramNotification.sent,true); assert.ok(calls.some(item=>item.method==='sendMessage'&&item.payload.text.includes(`№${order.number}`)));
  const webhookResponse=await fetch(`${base}/telegram/webhook/${shop.id}`,{method:'POST',headers:{'content-type':'application/json','x-telegram-bot-api-secret-token':'hook-secret'},body:JSON.stringify({callback_query:{id:'cb-1',data:`order:${order.id}:confirmed`,message:{message_id:101,chat:{id:-100123}}}})});
  assert.equal(webhookResponse.status,200); const webhook=await webhookResponse.json(); assert.equal(webhook.status,'confirmed');
  const detailed=await request(`/workspaces/${workspace.id}/shops/${shop.id}/orders/${order.id}`,{headers:auth}); assert.equal(detailed.status,'confirmed');
  const raw=JSON.parse(fs.readFileSync(path.join(temp,'db.json'),'utf8')); assert.ok(raw.telegramConfigs[0].tokenEncrypted); assert.equal(JSON.stringify(raw).includes('ABCDEFGHIJKLMNOPQRSTUVWXYZ_12345'),false);
  await request(`/workspaces/${workspace.id}/shops/${shop.id}/telegram`,{method:'DELETE',headers:auth});
  console.log('V6.5 Telegram orders tests passed');
} finally { await new Promise(resolve=>server.close(resolve)); fs.rmSync(temp,{recursive:true,force:true}); }
