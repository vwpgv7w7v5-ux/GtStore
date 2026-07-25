import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const allowedTypes = new Set(['hero','categories','products','text','spacer','features','newsletter']);
const themePresets={
  midnight:{name:'Midnight',theme:{accent:'#d59a55',background:'#f4f1eb',surface:'#ffffff',text:'#171717',muted:'#756d64',radius:20,font:'Inter',container:1100,cardStyle:'soft',buttonStyle:'filled',headerStyle:'glass'}},
  graphite:{name:'Graphite',theme:{accent:'#8ea1ff',background:'#0e1117',surface:'#171b24',text:'#f6f7fb',muted:'#9ca6b5',radius:16,font:'Inter',container:1180,cardStyle:'bordered',buttonStyle:'filled',headerStyle:'solid'}},
  minimal:{name:'Minimal',theme:{accent:'#111111',background:'#ffffff',surface:'#ffffff',text:'#111111',muted:'#6b7280',radius:4,font:'Arial',container:1040,cardStyle:'flat',buttonStyle:'outline',headerStyle:'minimal'}},
  candy:{name:'Candy',theme:{accent:'#e54b8d',background:'#fff5fa',surface:'#ffffff',text:'#2d1724',muted:'#8f667c',radius:28,font:'Inter',container:1140,cardStyle:'soft',buttonStyle:'filled',headerStyle:'glass'}}
};
const cleanColor=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(String(value||''))?String(value):fallback;
const cleanTheme=input=>{const base=themePresets.midnight.theme,x=input&&typeof input==='object'?input:{};return{accent:cleanColor(x.accent,base.accent),background:cleanColor(x.background,base.background),surface:cleanColor(x.surface,base.surface),text:cleanColor(x.text,base.text),muted:cleanColor(x.muted,base.muted),radius:Math.max(0,Math.min(40,Number(x.radius??base.radius))),font:['Inter','Arial','Georgia','system-ui'].includes(x.font)?x.font:base.font,container:Math.max(760,Math.min(1440,Number(x.container??base.container))),cardStyle:['soft','bordered','flat'].includes(x.cardStyle)?x.cardStyle:base.cardStyle,buttonStyle:['filled','outline','pill'].includes(x.buttonStyle)?x.buttonStyle:base.buttonStyle,headerStyle:['glass','solid','minimal'].includes(x.headerStyle)?x.headerStyle:base.headerStyle};};
const cleanBlock = (block, index) => {
  const type = allowedTypes.has(block?.type) ? block.type : 'text';
  return { id:String(block?.id||id('block')), type, position:index, visible:block?.visible!==false, settings:typeof block?.settings==='object'&&block.settings?structuredClone(block.settings):{} };
};
const defaultDraft = shop => ({
  theme:cleanTheme(themePresets.midnight.theme),
  seo:{title:shop.name,description:`Интернет-магазин ${shop.name}`},
  blocks:[
    cleanBlock({type:'hero',settings:{eyebrow:'НОВАЯ КОЛЛЕКЦИЯ',title:shop.name,subtitle:'Каталог доступен прямо в Telegram',buttonText:'Смотреть каталог'}},0),
    cleanBlock({type:'categories',settings:{title:'Категории'}},1),
    cleanBlock({type:'products',settings:{title:'Популярные товары',limit:8}},2)
  ]
});
export class StorefrontService {
  constructor(store,tenancy,catalog){this.store=store;this.tenancy=tenancy;this.catalog=catalog;}
  presets(){return Object.entries(themePresets).map(([id,p])=>({id,name:p.name,theme:structuredClone(p.theme)}));}
  ensureShop(userId,workspaceId,shopId,role='viewer'){const ctx=this.tenancy.context(userId,workspaceId,role);const shop=ctx.state.shops.find(x=>x.id===shopId&&x.workspaceId===workspaceId);assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);return{ctx,shop};}
  draft(userId,workspaceId,shopId){const{ctx,shop}=this.ensureShop(userId,workspaceId,shopId);return ctx.state.storefronts?.find(x=>x.shopId===shopId)?.draft||defaultDraft(shop);}
  async saveDraft(userId,workspaceId,shopId,input){const{shop}=this.ensureShop(userId,workspaceId,shopId,'manager');const draft={theme:cleanTheme({...defaultDraft(shop).theme,...(input.theme||{})}),seo:{...defaultDraft(shop).seo,...(input.seo||{})},blocks:(Array.isArray(input.blocks)?input.blocks:[]).map(cleanBlock)};assert(draft.blocks.length<=30,'TOO_MANY_BLOCKS','На витрине может быть не более 30 блоков');return this.store.transaction(userId,db=>{db.storefronts||=[];let entity=db.storefronts.find(x=>x.shopId===shopId);if(!entity){entity={id:id('storefront'),shopId,draft,published:null,versions:[],updatedAt:new Date().toISOString()};db.storefronts.push(entity);}else{entity.draft=draft;entity.updatedAt=new Date().toISOString();}return structuredClone(entity.draft);});}
  async publish(userId,workspaceId,shopId){this.ensureShop(userId,workspaceId,shopId,'admin');return this.store.transaction(userId,db=>{db.storefronts||=[];const shop=db.shops.find(x=>x.id===shopId);let entity=db.storefronts.find(x=>x.shopId===shopId);if(!entity){entity={id:id('storefront'),shopId,draft:defaultDraft(shop),published:null,versions:[],updatedAt:new Date().toISOString()};db.storefronts.push(entity);}const version={id:id('sfv'),number:(entity.versions.at(-1)?.number||0)+1,createdAt:new Date().toISOString(),snapshot:structuredClone(entity.draft)};entity.versions.push(version);entity.published=structuredClone(entity.draft);entity.publishedAt=version.createdAt;shop.status='published';return{publishedAt:entity.publishedAt,version:version.number,slug:shop.slug};});}
  versions(userId,workspaceId,shopId){this.ensureShop(userId,workspaceId,shopId);const state=this.store.snapshot();return(state.storefronts?.find(x=>x.shopId===shopId)?.versions||[]).map(({snapshot,...meta})=>meta).reverse();}
  async restore(userId,workspaceId,shopId,versionId){this.ensureShop(userId,workspaceId,shopId,'manager');return this.store.transaction(userId,db=>{const entity=db.storefronts?.find(x=>x.shopId===shopId);const version=entity?.versions.find(x=>x.id===versionId);assert(version,'VERSION_NOT_FOUND','Версия не найдена',404);entity.draft=structuredClone(version.snapshot);entity.updatedAt=new Date().toISOString();return entity.draft;});}
  publicStore(slug){const state=this.store.snapshot();const shop=state.shops.find(x=>x.slug===slug&&x.status==='published');assert(shop,'STOREFRONT_NOT_FOUND','Опубликованная витрина не найдена',404);const entity=state.storefronts?.find(x=>x.shopId===shop.id);assert(entity?.published,'STOREFRONT_NOT_FOUND','Витрина ещё не опубликована',404);const categories=state.categories.filter(x=>x.shopId===shop.id);const products=state.products.filter(x=>x.shopId===shop.id&&x.active!==false).map(p=>({...p,totalStock:p.variants?.length?p.variants.reduce((s,v)=>s+Number(v.stock||0),0):Number(p.stock||0)}));return{shop:{id:shop.id,name:shop.name,slug:shop.slug},storefront:entity.published,categories,products};}
}
