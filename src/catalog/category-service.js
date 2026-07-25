'use strict';
const {id,now}=require('../core/ids');
const {required,number,boolean}=require('../core/validation');
const {NotFoundError,ValidationError}=require('../core/errors');
class CategoryService {
  constructor(repo){this.repo=repo;}
  list(shopId){const db=this.repo.read();return (db.categories||[]).filter(x=>x.shopId===shopId).sort((a,b)=>(a.sort||0)-(b.sort||0));}
  async create(shopId,input){return this.repo.transaction(db=>{this.repo.assertShop(db,shopId);db.categories||=[];const parentId=input.parentId||'';if(parentId&&!db.categories.some(x=>x.id===parentId&&x.shopId===shopId))throw new ValidationError('Родительская категория не найдена');const item={id:id('cat'),shopId,name:required(input.name,'Название категории'),parentId,sort:number(input.sort??100,{min:0,max:9999,field:'Порядок'}),active:boolean(input.active,true),createdAt:now(),updatedAt:now()};db.categories.push(item);return item;});}
  async update(shopId,categoryId,input){return this.repo.transaction(db=>{const item=(db.categories||[]).find(x=>x.id===categoryId&&x.shopId===shopId);if(!item)throw new NotFoundError('Категория не найдена');if(input.parentId===categoryId)throw new ValidationError('Категория не может быть родителем самой себе');for(const key of ['name','parentId','sort','active'])if(key in input)item[key]=key==='name'?required(input[key],'Название'):key==='sort'?number(input[key],{min:0,max:9999}):key==='active'?boolean(input[key]):input[key];item.updatedAt=now();return item;});}
  async remove(shopId,categoryId){return this.repo.transaction(db=>{const children=(db.categories||[]).filter(x=>x.shopId===shopId&&x.parentId===categoryId);if(children.length)throw new ValidationError('Сначала удалите или переместите подкатегории');if((db.products||[]).some(x=>x.shopId===shopId&&x.categoryId===categoryId))throw new ValidationError('Категория используется товарами');const before=(db.categories||[]).length;db.categories=(db.categories||[]).filter(x=>!(x.id===categoryId&&x.shopId===shopId));if(before===db.categories.length)throw new NotFoundError('Категория не найдена');return {ok:true};});}
  tree(shopId){const all=this.list(shopId),map=new Map(all.map(x=>[x.id,{...x,children:[]}])) ,roots=[];for(const item of map.values()){if(item.parentId&&map.has(item.parentId))map.get(item.parentId).children.push(item);else roots.push(item);}return roots;}
}
module.exports={CategoryService};
