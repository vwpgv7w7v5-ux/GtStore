import assert from 'node:assert/strict'; import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { createApp } from '../../apps/api-v6/src/app.js';
const file=path.join(os.tmpdir(),`gtstore-v6-${Date.now()}.json`); const {server}=createApp({databaseFile:file,deploymentCommit:"a".repeat(40)}); await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve)); const base=`http://127.0.0.1:${server.address().port}/api/v6`;
const request=async(pathname,options={})=>{const response=await fetch(base+pathname,{...options,headers:{'content-type':'application/json',...(options.token?{authorization:`Bearer ${options.token}`}:{})},body:options.body?JSON.stringify(options.body):undefined});const body=response.status===204?null:await response.json();return{status:response.status,body}};
try{
 assert.equal((await request("/health")).body.commit,"a".repeat(40));
 let result=await request('/bootstrap',{method:'POST',body:{email:'owner@test.local',password:'Secret123!',name:'Owner'}}); assert.equal(result.status,201); const workspace=result.body.workspace; const shop=result.body.shop;
 result=await request('/auth/login',{method:'POST',body:{email:'owner@test.local',password:'Secret123!'}}); assert.equal(result.status,200); const token=result.body.token;
 result=await request('/me',{token}); assert.equal(result.status,200); assert.equal(result.body.workspaces[0].id,workspace.id);
 result=await request(`/workspaces/${workspace.id}/shops/${shop.id}/categories`,{method:'POST',token,body:{name:'Устройства'}}); assert.equal(result.status,201); const category=result.body;
 result=await request(`/workspaces/${workspace.id}/shops/${shop.id}/products`,{method:'POST',token,body:{name:'IGNITE V350',sku:'IGN-V350',brand:'IGNITE',price:2490,stock:12,categoryId:category.id}}); assert.equal(result.status,201);
 result=await request(`/workspaces/${workspace.id}/shops/${shop.id}/products?q=ignite`,{token}); assert.equal(result.status,200); assert.equal(result.body.length,1); assert.equal(result.body[0].stock,12);
 result=await request(`/workspaces/${workspace.id}/shops/${shop.id}/products`,{method:'POST',token,body:{name:'Duplicate',sku:'IGN-V350',price:1}}); assert.equal(result.status,400); assert.equal(result.body.error.code,'SKU_EXISTS');
 result=await request('/auth/logout',{method:'POST',token}); assert.equal(result.status,204); console.log('V6 foundation tests passed');
}finally{await new Promise(resolve=>server.close(resolve));try{fs.unlinkSync(file)}catch{}}
