import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';
const calls=[];
const fakeFetch=async(url,options={})=>{calls.push({url,options});return {ok:true,status:202,json:async()=>({ok:true})};};
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtstore-webhooks-')); const app=createApp({databaseFile:path.join(dir,'db.json'),mediaDirectory:path.join(dir,'media'),fetch:fakeFetch}); await new Promise(r=>app.server.listen(0,r)); const base=`http://127.0.0.1:${app.server.address().port}/api/v6`;
const req=async(p,o={})=>{const r=await fetch(base+p,{...o,headers:{'content-type':'application/json',...(o.token?{authorization:`Bearer ${o.token}`}:{})},body:o.body?JSON.stringify(o.body):undefined});const b=r.status===204?null:await r.json();if(!r.ok)throw Object.assign(new Error(b?.error?.message),{status:r.status,body:b});return b;};
try {
 await req('/bootstrap',{method:'POST',body:{email:'owner@test.local',password:'Password123!',name:'Owner'}});
 const login=await req('/auth/login',{method:'POST',body:{email:'owner@test.local',password:'Password123!'}}); const me=await req('/me',{token:login.token}); const ws=me.workspaces[0]; const shop=(await req(`/workspaces/${ws.id}/shops`,{token:login.token}))[0];
 const events=await req('/integrations/events',{token:login.token}); assert.ok(events.includes('order.created'));
 const hook=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations`,{method:'POST',token:login.token,body:{name:'ERP webhook',url:'https://erp.example.test/hooks/orders',events:['order.created','order.status_changed']}});
 assert.ok(hook.signingSecret); assert.equal(hook.secret,undefined);
 const result=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations/${hook.id}/test`,{method:'POST',token:login.token}); assert.equal(result.status,'sent'); assert.equal(calls.length,1);
 const sent=calls[0]; assert.equal(sent.options.headers['x-gtstore-event'],'order.created'); const expected=`sha256=${crypto.createHmac('sha256',hook.signingSecret).update(sent.options.body).digest('hex')}`; assert.equal(sent.options.headers['x-gtstore-signature'],expected);
 const deliveries=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations/deliveries?hookId=${hook.id}`,{token:login.token}); assert.equal(deliveries.length,1); assert.equal(deliveries[0].statusCode,202);
 const rotated=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations/${hook.id}/rotate-secret`,{method:'POST',token:login.token}); assert.notEqual(rotated.signingSecret,hook.signingSecret);
 const updated=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations/${hook.id}`,{method:'PATCH',token:login.token,body:{active:false}}); assert.equal(updated.active,false);
 const removed=await req(`/workspaces/${ws.id}/shops/${shop.id}/integrations/${hook.id}`,{method:'DELETE',token:login.token}); assert.equal(removed.id,hook.id);
 console.log('V6.15 webhooks and integrations tests passed');
} finally { await new Promise(r=>app.server.close(r)); fs.rmSync(dir,{recursive:true,force:true}); }
