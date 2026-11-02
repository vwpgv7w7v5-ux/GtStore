import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../apps/api-v6/src/app.js';

const file=path.join(os.tmpdir(),`gtstore-storefront-${Date.now()}.json`);
const {server}=createApp({databaseFile:file});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
const base=`http://127.0.0.1:${server.address().port}/api/v6`;
const request=async(pathname,options={})=>{const response=await fetch(base+pathname,{...options,headers:{'content-type':'application/json',...(options.token?{authorization:`Bearer ${options.token}`}:{})},body:options.body?JSON.stringify(options.body):undefined});const body=response.status===204?null:await response.json();return{status:response.status,body};};
try{
  const boot=await request('/bootstrap',{method:'POST',body:{email:'owner@store.local',password:'StrongPass123!',name:'Owner'}});
  const login=await request('/auth/login',{method:'POST',body:{email:'owner@store.local',password:'StrongPass123!'}});
  const token=login.body.token; const ws=boot.body.workspace; const shop=boot.body.shop; const root=`/workspaces/${ws.id}/shops/${shop.id}`;
  const category=(await request(root+'/categories',{method:'POST',token,body:{name:'Устройства'}})).body;
  await request(root+'/products',{method:'POST',token,body:{name:'Demo Product',sku:'DEMO-1',price:1990,stock:4,categoryId:category.id,active:true}});
  const draft=await request(root+'/storefront',{token}); assert.equal(draft.status,200); assert.equal(draft.body.blocks.length,2);
  draft.body.blocks.push({type:'text',settings:{title:'Доставка',text:'Сегодня по городу'}});
  const saved=await request(root+'/storefront',{method:'PATCH',token,body:draft.body}); assert.equal(saved.status,200); assert.equal(saved.body.blocks.length,3);
  const publish=await request(root+'/storefront/publish',{method:'POST',token}); assert.equal(publish.status,201); assert.equal(publish.body.version,1);
  const publicPage=await request(`/public/storefronts/${shop.slug}`); assert.equal(publicPage.status,200); assert.equal(publicPage.body.products.length,1); assert.equal(publicPage.body.storefront.blocks.length,3);
  const versions=await request(root+'/storefront/versions',{token}); assert.equal(versions.body.length,1);
  const changed={...saved.body,blocks:[saved.body.blocks[0]]}; await request(root+'/storefront',{method:'PATCH',token,body:changed});
  const restored=await request(root+`/storefront/versions/${versions.body[0].id}/restore`,{method:'POST',token}); assert.equal(restored.body.blocks.length,3);
  console.log('V6.3 storefront builder tests passed');
} finally {await new Promise(resolve=>server.close(resolve));fs.rmSync(file,{force:true});}
