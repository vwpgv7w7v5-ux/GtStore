'use strict';
const assert=require('assert');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {JsonRepository}=require('../src/core/repository');
const {CategoryService}=require('../src/catalog/category-service');
const {ProductService}=require('../src/catalog/product-service');
const {OrderService}=require('../src/orders/order-service');
(async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'gtstore-'));const file=path.join(dir,'db.json');fs.writeFileSync(file,JSON.stringify({shops:[{id:'demo',name:'Demo'}],categories:[],products:[],orders:[]}));const repo=new JsonRepository(file),cats=new CategoryService(repo),products=new ProductService(repo),orders=new OrderService(repo);
 const cat=await cats.create('demo',{name:'Devices'});assert.equal(cats.tree('demo').length,1);
 const p=await products.create('demo',{name:'Test',sku:'TEST-1',price:1000,stock:3,categoryId:cat.id});assert.equal(p.stock,3);
 const o=await orders.create('demo',{customer:{name:'Kirill'},items:[{productId:p.id,quantity:2}]});assert.equal(o.total,2000);assert.equal(products.list('demo')[0].stock,1);
 await orders.transition('demo',o.id,'cancelled');assert.equal(products.list('demo')[0].stock,3);
 console.log('Production core tests passed');
})().catch(e=>{console.error(e);process.exit(1)});
