import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';

const allowedTypes = new Set(['hero','banner','categories','products','text','spacer','features','newsletter','showcase']);
const themePresets={
  midnight:{name:'Quiet Luxury',theme:{accent:'#C45A32',background:'#EBE5DB',surface:'#F7F3EC',text:'#2A2724',muted:'#6F675F',radius:26,font:'Plus Jakarta Sans',container:1120,cardStyle:'soft',buttonStyle:'pill',headerStyle:'glass'}},
  graphite:{name:'Угольный остров',theme:{accent:'#C45A32',background:'#2A2724',surface:'#3A3531',text:'#F3EBE1',muted:'#A89888',radius:24,font:'Syne',container:1180,cardStyle:'bordered',buttonStyle:'filled',headerStyle:'solid'}},
  minimal:{name:'Светлый greige',theme:{accent:'#A34828',background:'#E4DDD3',surface:'#FFF9F3',text:'#2A2724',muted:'#8A8178',radius:18,font:'Plus Jakarta Sans',container:1080,cardStyle:'flat',buttonStyle:'outline',headerStyle:'minimal'}},
  candy:{name:'Терракота',theme:{accent:'#D4683C',background:'#EBE5DB',surface:'#F7F3EC',text:'#2A2724',muted:'#6F675F',radius:28,font:'Syne',container:1140,cardStyle:'soft',buttonStyle:'pill',headerStyle:'glass'}}
};
const cleanColor=(value,fallback)=>/^#[0-9a-f]{6}$/i.test(String(value||''))?String(value):fallback;
const cleanTheme=input=>{const base=themePresets.midnight.theme,x=input&&typeof input==='object'?input:{};return{accent:cleanColor(x.accent,base.accent),background:cleanColor(x.background,base.background),surface:cleanColor(x.surface,base.surface),text:cleanColor(x.text,base.text),muted:cleanColor(x.muted,base.muted),radius:Math.max(0,Math.min(40,Number(x.radius??base.radius))),font:['Syne','Plus Jakarta Sans','DM Sans','Manrope','Outfit','Georgia','system-ui'].includes(x.font)?x.font:base.font,container:Math.max(760,Math.min(1440,Number(x.container??base.container))),cardStyle:['soft','bordered','flat'].includes(x.cardStyle)?x.cardStyle:base.cardStyle,buttonStyle:['filled','outline','pill'].includes(x.buttonStyle)?x.buttonStyle:base.buttonStyle,headerStyle:['glass','solid','minimal'].includes(x.headerStyle)?x.headerStyle:base.headerStyle,cartEnabled:x.cartEnabled===false?false:true,showcaseOnly:x.showcaseOnly===true};};
const cleanBlock = (block, index) => {
  const type = allowedTypes.has(block?.type) ? block.type : 'text';
  return { id:String(block?.id||id('block')), type, position:index, visible:block?.visible!==false, settings:typeof block?.settings==='object'&&block.settings?structuredClone(block.settings):{} };
};
const cleanVitrinaItem = (item, index) => {
  const placement = item?.placement === 'tiles' ? 'tiles' : 'carousel';
  const title = String(item?.title || '').trim().slice(0, 200);
  const name = String(item?.name || '').trim().slice(0, 120)
    || (placement === 'tiles' ? 'Плитка' : 'Баннер');
  return {
    id: String(item?.id || id('vit')),
    placement,
    name,
    // Keep title empty unless explicitly set — otherwise image-only tiles
    // fall back to the tiny icon+label layout in the Mini App.
    title,
    subtitle: String(item?.subtitle || '').trim().slice(0, 300),
    imageUrl: String(item?.imageUrl || '').trim(),
    linkUrl: String(item?.linkUrl || '').trim(),
    priority: Math.max(0, Math.min(9999, Number(item?.priority ?? index + 1) || 0)),
    visible: item?.visible !== false,
  };
};
const cleanVitrina = (items) =>
  (Array.isArray(items) ? items : [])
    .map(cleanVitrinaItem)
    .filter((item) => item.imageUrl && (item.placement === 'carousel' || item.placement === 'tiles'))
    .sort((a, b) => Number(b.priority) - Number(a.priority) || a.name.localeCompare(b.name, 'ru'));
const defaultDraft = shop => ({
  theme:cleanTheme({...themePresets.graphite.theme, background:'#1c1c1e', surface:'#2c2c2e', text:'#f5f5f7', muted:'#a1a1a6', accent:'#ffffff', radius:22, cardStyle:'soft', buttonStyle:'pill', headerStyle:'solid'}),
  seo:{title:shop.name,description:`Интернет-магазин ${shop.name}`},
  vitrina: [],
  blocks:[
    cleanBlock({type:'categories',settings:{title:'Категории'}},0),
    cleanBlock({type:'products',settings:{title:'Каталог'}},1)
  ]
});
export class StorefrontService {
  constructor(store,tenancy,catalog,media=null){this.store=store;this.tenancy=tenancy;this.catalog=catalog;this.media=media;}
  presets(){return Object.entries(themePresets).map(([id,p])=>({id,name:p.name,theme:structuredClone(p.theme)}));}
  ensureShop(userId,workspaceId,shopId,role='viewer'){const ctx=this.tenancy.context(userId,workspaceId,role);const shop=ctx.state.shops.find(x=>x.id===shopId&&x.workspaceId===workspaceId);assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);return{ctx,shop};}
  draft(userId,workspaceId,shopId){
    const{ctx,shop}=this.ensureShop(userId,workspaceId,shopId);
    const draft=ctx.state.storefronts?.find(x=>x.shopId===shopId)?.draft||defaultDraft(shop);
    return {...draft, vitrina: cleanVitrina(draft.vitrina)};
  }
  async localizeVitrina(items){
    const list=Array.isArray(items)?items:[];
    if(!this.media) return list;
    const out=[];
    for(const item of list){
      const next={...item};
      if(next.imageUrl) next.imageUrl=await this.media.ingestUrl(next.imageUrl);
      out.push(next);
    }
    return out;
  }
  async localizeBlocks(blocks){
    const list=Array.isArray(blocks)?blocks:[];
    if(!this.media) return list;
    const out=[];
    for(const block of list){
      const next={...block, settings:(block.settings && typeof block.settings==='object' ? {...block.settings} : {})};
      if(next.settings?.imageUrl) next.settings.imageUrl=await this.media.ingestUrl(next.settings.imageUrl);
      out.push(next);
    }
    return out;
  }
  async saveDraft(userId,workspaceId,shopId,input){
    const{shop}=this.ensureShop(userId,workspaceId,shopId,'manager');
    const current=this.draft(userId,workspaceId,shopId);
    const rawVitrina=input.vitrina !== undefined ? input.vitrina : current.vitrina;
    const rawBlocks=Array.isArray(input.blocks)?input.blocks:current.blocks||[];
    const localizedVitrina=await this.localizeVitrina(rawVitrina);
    const localizedBlocks=await this.localizeBlocks(rawBlocks);
    const draft={
      theme:cleanTheme({...defaultDraft(shop).theme,...(current.theme||{}),...(input.theme||{})}),
      seo:{...defaultDraft(shop).seo,...(current.seo||{}),...(input.seo||{})},
      blocks:localizedBlocks.map(cleanBlock),
      vitrina:cleanVitrina(localizedVitrina),
    };
    assert(draft.blocks.length<=30,'TOO_MANY_BLOCKS','На витрине может быть не более 30 блоков');
    assert(draft.vitrina.length<=40,'TOO_MANY_VITRINA','На витрине может быть не более 40 баннеров и плиток');
    return this.store.transaction(userId,db=>{
      db.storefronts||=[];
      let entity=db.storefronts.find(x=>x.shopId===shopId);
      if(!entity){
        entity={id:id('storefront'),shopId,draft,published:null,versions:[],updatedAt:new Date().toISOString()};
        db.storefronts.push(entity);
      }else{
        entity.draft=draft;
        entity.updatedAt=new Date().toISOString();
      }
      return structuredClone(entity.draft);
    });
  }
  async publish(userId,workspaceId,shopId){this.ensureShop(userId,workspaceId,shopId,'admin');return this.store.transaction(userId,db=>{db.storefronts||=[];const shop=db.shops.find(x=>x.id===shopId);let entity=db.storefronts.find(x=>x.shopId===shopId);if(!entity){entity={id:id('storefront'),shopId,draft:defaultDraft(shop),published:null,versions:[],updatedAt:new Date().toISOString()};db.storefronts.push(entity);}const version={id:id('sfv'),number:(entity.versions.at(-1)?.number||0)+1,createdAt:new Date().toISOString(),snapshot:structuredClone(entity.draft)};entity.versions.push(version);entity.published=structuredClone(entity.draft);entity.publishedAt=version.createdAt;shop.status='published';return{publishedAt:entity.publishedAt,version:version.number,slug:shop.slug};});}
  versions(userId,workspaceId,shopId){this.ensureShop(userId,workspaceId,shopId);const state=this.store.snapshot();return(state.storefronts?.find(x=>x.shopId===shopId)?.versions||[]).map(({snapshot,...meta})=>meta).reverse();}
  async restore(userId,workspaceId,shopId,versionId){this.ensureShop(userId,workspaceId,shopId,'manager');return this.store.transaction(userId,db=>{const entity=db.storefronts?.find(x=>x.shopId===shopId);const version=entity?.versions.find(x=>x.id===versionId);assert(version,'VERSION_NOT_FOUND','Версия не найдена',404);entity.draft=structuredClone(version.snapshot);entity.updatedAt=new Date().toISOString();return entity.draft;});}
  publicStore(slug){const state=this.store.snapshot();const shop=state.shops.find(x=>x.slug===slug&&x.status==='published');assert(shop,'STOREFRONT_NOT_FOUND','Опубликованная витрина не найдена',404);const entity=state.storefronts?.find(x=>x.shopId===shop.id);assert(entity?.published,'STOREFRONT_NOT_FOUND','Витрина ещё не опубликована',404);const categories=state.categories.filter(x=>x.shopId===shop.id);const reservedFor=(productId,variantId=null)=>(state.stockReservations||[]).filter(r=>r.shopId===shop.id&&r.productId===productId&&(r.variantId||null)===(variantId||null)&&r.status==='active').reduce((s,r)=>s+Number(r.quantity||0),0);const products=state.products.filter(x=>x.shopId===shop.id&&x.active!==false).map(p=>{if(p.variants?.length){const variants=p.variants.map(v=>({...v,stock:Math.max(0,Number(v.stock||0)-reservedFor(p.id,v.id))}));return{...p,variants,totalStock:variants.reduce((s,v)=>s+Number(v.stock||0),0)};}const totalStock=Math.max(0,Number(p.stock||0)-reservedFor(p.id));return{...p,stock:totalStock,totalStock};});const analytics=shop.settings?.analytics||{};const referralProgram=shop.settings?.referralProgram||{};const tg=state.telegramConfigs?.find(c=>c.shopId===shop.id&&c.enabled!==false&&c.tokenEncrypted);return{shop:{id:shop.id,name:shop.name,slug:shop.slug,logoUrl:shop.logoUrl||'',faviconUrl:shop.faviconUrl||'',currency:shop.currency||'RUB',settings:{storefront:shop.settings?.storefront||{},analytics:{metrikaId:analytics.metrikaId||'',metrikaEnabled:Boolean(analytics.metrikaId)},referralProgram:{enabled:Boolean(referralProgram.enabled)}}},storefront:entity.published,categories,products,cartEnabled:entity.published?.theme?.cartEnabled!==false&&shop.settings?.storefront?.cartEnabled!==false,showcaseOnly:entity.published?.theme?.showcaseOnly===true||shop.settings?.storefront?.showcaseOnly===true,referralProgramEnabled:Boolean(referralProgram.enabled),telegram:{botUsername:tg?.botUsername||''}};}
}
