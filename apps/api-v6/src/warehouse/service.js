import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const now=()=>new Date().toISOString();
const integer=value=>Math.floor(Number(value)||0);

export class WarehouseService {
  constructor(store,tenancy){this.store=store;this.tenancy=tenancy;}
  ensureShop(userId,workspaceId,shopId,role='viewer'){
    const context=this.tenancy.context(userId,workspaceId,role);
    const shop=context.state.shops.find(x=>x.id===shopId&&x.workspaceId===workspaceId);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404); return {...context,shop};
  }
  inventory(userId,workspaceId,shopId,filters={}){
    const {state}=this.ensureShop(userId,workspaceId,shopId);
    const q=String(filters.query||'').trim().toLowerCase();
    const rows=[];
    for(const product of state.products.filter(x=>x.shopId===shopId&&!x.archived)){
      if(product.variants?.length){for(const variant of product.variants){const reserved=(state.stockReservations||[]).filter(r=>r.shopId===shopId&&r.productId===product.id&&r.variantId===variant.id&&r.status==='active').reduce((s,r)=>s+r.quantity,0);rows.push({productId:product.id,variantId:variant.id,name:product.name,variantName:variant.name||'',sku:variant.sku,stock:integer(variant.stock),reserved,available:Math.max(0,integer(variant.stock)-reserved),active:product.active&&variant.active!==false,updatedAt:product.updatedAt});}}
      else {const reserved=(state.stockReservations||[]).filter(r=>r.shopId===shopId&&r.productId===product.id&&!r.variantId&&r.status==='active').reduce((s,r)=>s+r.quantity,0);rows.push({productId:product.id,variantId:null,name:product.name,variantName:'',sku:product.sku,stock:integer(product.stock),reserved,available:Math.max(0,integer(product.stock)-reserved),active:product.active,updatedAt:product.updatedAt});}
    }
    return rows.filter(x=>!q||`${x.name} ${x.variantName} ${x.sku}`.toLowerCase().includes(q)).sort((a,b)=>a.name.localeCompare(b.name,'ru'));
  }
  movements(userId,workspaceId,shopId,filters={}){
    this.ensureShop(userId,workspaceId,shopId); const state=this.store.snapshot();
    const type=String(filters.type||'all');
    return (state.stockMovements||[]).filter(x=>x.shopId===shopId&&(type==='all'||x.type===type)).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
  }
  async adjust(userId,workspaceId,shopId,input={}){
    this.ensureShop(userId,workspaceId,shopId,'manager'); const delta=integer(input.delta);
    assert(delta!==0,'STOCK_DELTA_REQUIRED','Изменение остатка не может быть равно нулю');
    return this.store.transaction(userId,db=>{
      db.stockMovements||=[]; const product=db.products.find(x=>x.id===input.productId&&x.shopId===shopId&&!x.archived); assert(product,'PRODUCT_NOT_FOUND','Товар не найден',404);
      const variant=input.variantId?product.variants?.find(x=>x.id===input.variantId):null; if(input.variantId)assert(variant,'VARIANT_NOT_FOUND','Вариант не найден',404);
      const before=integer(variant?variant.stock:product.stock); const after=before+delta; assert(after>=0,'INSUFFICIENT_STOCK','Остаток не может стать отрицательным',409);
      if(variant)variant.stock=after;else product.stock=after; product.updatedAt=now(); product.version=(product.version||1)+1;
      const movement={id:id('mov'),shopId,productId:product.id,variantId:variant?.id||null,sku:variant?.sku||product.sku,name:product.name,type:delta>0?'receipt':'writeoff',quantity:Math.abs(delta),delta,before,after,reason:String(input.reason||'Ручная корректировка'),reference:String(input.reference||''),actor:userId,createdAt:now()}; db.stockMovements.push(movement); return movement;
    });
  }
  async transfer(userId,workspaceId,shopId,input={}){
    this.ensureShop(userId,workspaceId,shopId,'manager');
    const quantity=Math.max(1,integer(input.quantity));
    return this.store.transaction(userId,db=>{
      db.stockMovements||=[]; const product=db.products.find(x=>x.id===input.productId&&x.shopId===shopId&&!x.archived); assert(product,'PRODUCT_NOT_FOUND','Товар не найден',404);
      const from=input.fromVariantId?product.variants?.find(x=>x.id===input.fromVariantId):null; const to=input.toVariantId?product.variants?.find(x=>x.id===input.toVariantId):null;
      assert(from&&to&&from.id!==to.id,'TRANSFER_VARIANTS_INVALID','Укажите разные варианты одного товара'); assert(integer(from.stock)>=quantity,'INSUFFICIENT_STOCK','Недостаточно остатка для перемещения',409);
      const stamp=now(); const beforeFrom=integer(from.stock),beforeTo=integer(to.stock); from.stock-=quantity;to.stock+=quantity;product.updatedAt=stamp;
      const transferId=id('trf'); const common={shopId,productId:product.id,name:product.name,type:'transfer',quantity,reason:String(input.reason||'Перемещение между вариантами'),reference:transferId,actor:userId,createdAt:stamp};
      const out={id:id('mov'),...common,variantId:from.id,sku:from.sku,delta:-quantity,before:beforeFrom,after:from.stock}; const incoming={id:id('mov'),...common,variantId:to.id,sku:to.sku,delta:quantity,before:beforeTo,after:to.stock}; db.stockMovements.push(out,incoming); return {id:transferId,out,in:incoming};
    });
  }
  stocktakes(userId,workspaceId,shopId){this.ensureShop(userId,workspaceId,shopId);const state=this.store.snapshot();return (state.stocktakes||[]).filter(x=>x.shopId===shopId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));}
  async createStocktake(userId,workspaceId,shopId,input={}){
    this.ensureShop(userId,workspaceId,shopId,'manager'); const items=Array.isArray(input.items)?input.items:[]; assert(items.length,'STOCKTAKE_ITEMS_REQUIRED','Добавьте позиции инвентаризации');
    return this.store.transaction(userId,db=>{db.stocktakes||=[];db.stockMovements||=[];const createdAt=now();const stocktake={id:id('stk'),shopId,status:'completed',note:String(input.note||''),items:[],differences:0,createdBy:userId,createdAt,completedAt:createdAt};
      for(const item of items){const product=db.products.find(x=>x.id===item.productId&&x.shopId===shopId&&!x.archived);assert(product,'PRODUCT_NOT_FOUND','Товар не найден',404);const variant=item.variantId?product.variants?.find(x=>x.id===item.variantId):null;if(item.variantId)assert(variant,'VARIANT_NOT_FOUND','Вариант не найден',404);const expected=integer(variant?variant.stock:product.stock),actual=Math.max(0,integer(item.actual)),delta=actual-expected;if(variant)variant.stock=actual;else product.stock=actual;product.updatedAt=createdAt;const row={productId:product.id,variantId:variant?.id||null,sku:variant?.sku||product.sku,name:product.name,expected,actual,delta};stocktake.items.push(row);if(delta!==0){stocktake.differences++;db.stockMovements.push({id:id('mov'),shopId,productId:product.id,variantId:variant?.id||null,sku:row.sku,name:product.name,type:'stocktake',quantity:Math.abs(delta),delta,before:expected,after:actual,reason:`Инвентаризация ${stocktake.id}`,reference:stocktake.id,actor:userId,createdAt});}}
      db.stocktakes.push(stocktake);return stocktake;});
  }
  metrics(userId,workspaceId,shopId){const rows=this.inventory(userId,workspaceId,shopId);return{skuCount:rows.length,totalStock:rows.reduce((s,x)=>s+x.stock,0),reserved:rows.reduce((s,x)=>s+x.reserved,0),available:rows.reduce((s,x)=>s+x.available,0),lowStock:rows.filter(x=>x.available<=3).length,outOfStock:rows.filter(x=>x.available===0).length};}
}
