const app=document.querySelector('#app');
// Telegram SDK loads async — never cache WebApp at boot.
function getTg(){return window.Telegram?.WebApp||null}
function hashHasTg(){return /tgWebAppData=/.test(location.hash||'')}
function detectTgNative(){
  const w=getTg();
  return Boolean(
    document.documentElement.classList.contains('tg-native')
    || (w&&(w.initData||w.initDataUnsafe?.user||w.initDataUnsafe?.query_id||(w.platform&&w.platform!=='unknown')))
    || hashHasTg()
  );
}
let isTgNative=detectTgNative();
let isTg=isTgNative;
let isCompact=isTgNative||document.documentElement.classList.contains('tg-miniapp')||Math.min(screen.width||0,window.innerWidth||0)<=640;
function syncMiniappClasses(){
  isTgNative=detectTgNative();
  isTg=isTgNative;
  isCompact=isTgNative||document.documentElement.classList.contains('tg-miniapp')||Math.min(screen.width||0,window.innerWidth||0)<=640||isCompact;
  if(isCompact||isTgNative){
    document.documentElement.classList.add('tg-miniapp');
    document.body?.classList.add('tg-miniapp');
  }
  if(isTgNative){
    document.documentElement.classList.add('tg-native');
    document.body?.classList.add('tg-native');
  }
}
function lockViewportWidth(){
  const vv=window.visualViewport;
  const w=Math.max(280,Math.min(Math.floor((vv&&vv.width)||window.innerWidth||screen.width||390),1200));
  document.documentElement.style.setProperty('--app-w',`${w}px`);
  try{document.documentElement.scrollLeft=0;if(document.body)document.body.scrollLeft=0}catch{}
  if(typeof window.__sfLockWidth==='function')try{window.__sfLockWidth()}catch{}
}
function ensureViewportLock(){
  syncMiniappClasses();
  lockViewportWidth();
  if(typeof window.__sfLockViewport==='function')try{window.__sfLockViewport(isTgNative)}catch{}
}
syncMiniappClasses();
lockViewportWidth();
window.addEventListener('resize',lockViewportWidth,{passive:true});
window.addEventListener('orientationchange',()=>setTimeout(ensureViewportLock,50));
window.visualViewport?.addEventListener('resize',lockViewportWidth,{passive:true});
window.addEventListener('telegram-web-app-ready',ensureViewportLock);
let tgMainBound=false,tgBackBound=false;
function applyTgChrome(){
  const tg=getTg();
  if(!tg||!isTg)return;
  try{
    tg.ready?.();
    tg.expand?.();
    tg.disableVerticalSwipes?.();
    const tp=tg.themeParams||{};
    if(tp.secondary_bg_color)tg.setHeaderColor?.(tp.secondary_bg_color);
    else tg.setHeaderColor?.('secondary_bg_color');
    const bg=getComputedStyle(document.documentElement).getPropertyValue('--page-bg').trim()||'#ebe5db';
    tg.setBackgroundColor?.(bg);
    tg.MainButton?.hide?.();
    tg.MainButton?.setParams?.({is_visible:false});
    document.body.classList.remove('has-tg-mainbutton');
  }catch{}
}
applyTgChrome();
syncTgMainButton();
function openCartDrawer(){
  document.querySelector('#drawer')?.classList.add('open');
  syncTgBackButton(true);
  syncBodyScrollLock();
  syncTgMainButton();
}
function onTgMainButtonClick(){
  const drawerOpen=document.querySelector('#drawer')?.classList.contains('open');
  if(drawerOpen && cart.length && typeof cartEnabled==='function' && cartEnabled()){
    openCheckout();
    return;
  }
  openCartDrawer();
}
function syncTgMainButton(){
  // Native Telegram MainButton duplicates in-app terracotta CTA — always keep it hidden.
  const tg=getTg();
  try{
    tg?.MainButton?.hide?.();
    tg?.MainButton?.setParams?.({is_visible:false});
  }catch{}
  document.body.classList.remove('has-tg-mainbutton');
}
function syncTgBackButton(open){
  const tg=getTg();
  if(!tg?.BackButton||!isTg)return;
  try{
    if(!tgBackBound){
      tgBackBound=true;
      tg.BackButton.onClick?.(()=>{
        document.querySelector('#drawer')?.classList.remove('open');
        const modal=document.querySelector('#modal');
        if(modal)modal.innerHTML='';
        if(appTab==='cart'){appTab='home';document.querySelectorAll('.tg-tab').forEach(t=>t.classList.toggle('on',t.dataset.tab===appTab))}
        tg.BackButton.hide();
        syncTgMainButton();
        syncBodyScrollLock();
      });
    }
    if(open)tg.BackButton.show();
    else tg.BackButton.hide();
  }catch{}
}
let bodyScrollY=0,bodyScrollLocked=false,touchMoveGuardBound=false,overlayObserver=null;
function overlayOpen(){
  const drawer=document.querySelector('#drawer');
  const modal=document.querySelector('#modal');
  return Boolean(drawer?.classList.contains('open')||modal?.querySelector('.modal-backdrop'));
}
function touchScrollRoot(target){
  return target?.closest?.('.cart-drawer.open, .modal-backdrop, .checkout-card, .product-detail, .ref-sheet, .profile-card, .success-card');
}
function onOverlayTouchMove(e){
  if(!bodyScrollLocked)return;
  if(touchScrollRoot(e.target))return;
  e.preventDefault();
}
function lockBodyScroll(){
  if(bodyScrollLocked)return;
  bodyScrollY=window.scrollY||document.documentElement.scrollTop||0;
  bodyScrollLocked=true;
  document.documentElement.classList.add('scroll-locked');
  document.body.classList.add('scroll-locked');
  document.body.style.top=`-${bodyScrollY}px`;
  if(!touchMoveGuardBound){
    touchMoveGuardBound=true;
    document.addEventListener('touchmove',onOverlayTouchMove,{passive:false});
  }
}
function unlockBodyScroll(){
  if(!bodyScrollLocked)return;
  bodyScrollLocked=false;
  document.documentElement.classList.remove('scroll-locked');
  document.body.classList.remove('scroll-locked');
  document.body.style.top='';
  window.scrollTo(0,bodyScrollY);
}
function syncBodyScrollLock(){
  if(overlayOpen())lockBodyScroll();
  else unlockBodyScroll();
  syncTgMainButton();
}
function watchOverlays(){
  const drawer=document.querySelector('#drawer');
  const modal=document.querySelector('#modal');
  if(overlayObserver){try{overlayObserver.disconnect()}catch{}overlayObserver=null}
  overlayObserver=new MutationObserver(()=>syncBodyScrollLock());
  if(drawer)overlayObserver.observe(drawer,{attributes:true,attributeFilter:['class']});
  if(modal)overlayObserver.observe(modal,{childList:true});
  syncBodyScrollLock();
}

function refreshTgFlags(){
  isTgNative=detectTgNative();
  isTg=isTgNative;
  if(isTgNative){
    document.documentElement.classList.add('tg-miniapp','tg-native');
    document.body.classList.add('tg-miniapp','tg-native');
  }
  applyTgChrome();
}
const storage={get(k){try{return localStorage.getItem(k)}catch{return null}},set(k,v){try{localStorage.setItem(k,v)}catch{}}};
const sessionStore={get(k){try{return sessionStorage.getItem(k)}catch{return null}},set(k,v){try{sessionStorage.setItem(k,v)}catch{}}};
const uuid=()=>{try{return crypto.randomUUID()}catch{return `s_${Date.now()}_${Math.random().toString(16).slice(2)}`}};
const params=new URLSearchParams(location.search);
// Mini App must always hit same-origin API. Stale localStorage gt_api breaks vitrina/media.
const api=(()=>{
  const fromQuery=String(params.get('api')||'').trim().replace(/\/$/,'');
  if(fromQuery) return fromQuery;
  const devPort=['4173','4174','5173','3000','4000'].includes(String(location.port||''));
  if(!devPort) return `${location.origin}/api/v6`;
  return storage.get('gt_api')||window.GT_API||`${location.protocol}//${location.hostname}:4000/api/v6`;
})();
const mediaUrl=(url,size)=>{
  const u=String(url||'').trim();
  if(!u) return '';
  let absolute='';
  if(/^data:image\/(png|jpeg|gif|webp);base64,/i.test(u))absolute=u;
  else try{
    const parsed=new URL(u,new URL(api,location.href).origin+'/');
    if(!['http:','https:'].includes(parsed.protocol)||parsed.username||parsed.password)return '';
    absolute=parsed.href;
  }catch{return '';}
  if(!size||absolute.startsWith('data:')) return absolute;
  // Only resize same-origin /api/v6/media assets (local uploads).
  try{
    const parsed=new URL(absolute);
    if(!parsed.pathname.includes('/api/v6/media/')) return absolute;
    if(/\.w\d+\.webp$/i.test(parsed.pathname)) return absolute;
    const width=size===true||size==='thumb'?480:size==='tile'?360:size==='hero'?960:size==='detail'?720:Number(size)||480;
    if(!width) return absolute;
    parsed.searchParams.set('w',String(width));
    return parsed.toString();
  }catch{
    return absolute;
  }
};
const preloadImages=(urls=[])=>{
  const seen=new Set();
  for(const raw of urls){
    const href=String(raw||'').trim();
    if(!href||seen.has(href)) continue;
    seen.add(href);
    if([...document.querySelectorAll('link[rel="preload"][as="image"]')].some(el=>el.href===href)) continue;
    const link=document.createElement('link');
    link.rel='preload';
    link.as='image';
    link.href=href;
    document.head.append(link);
  }
};
function preloadVisibleCatalogImages(){
  if(!data) return;
  const urls=[];
  const cats=(data.categories||[]).filter(c=>!c.parentId&&c.imageUrl).slice(0,8);
  for(const c of cats) urls.push(mediaUrl(c.imageUrl,'tile'));
  for(const t of vitrinaList().filter(x=>x.placement==='tiles').slice(0,6)) urls.push(mediaUrl(t.imageUrl,'tile'));
  for(const b of vitrinaList().filter(x=>x.placement==='carousel').slice(0,2)) urls.push(mediaUrl(b.imageUrl,'hero'));
  preloadImages(urls);
}
if(params.get('preview')==='tg'||params.get('preview')==='1'){
  document.documentElement.classList.add('tg-miniapp','tg-native','tg-admin-preview');
  document.body.classList.add('tg-miniapp','tg-native','tg-admin-preview');
  isTgNative=true;
  isTg=true;
}
const startParam=String(getTg()?.initDataUnsafe?.start_param||params.get('startapp')||params.get('start')||params.get('tgWebAppStartParam')||'');
function parseStartUtm(sp){if(!sp)return null;const re=/utm_?(source|medium|campaign|content|term)-([^_]+)/gi;let m;const map={};let matched=false;while((m=re.exec(sp))){matched=true;try{map[m[1].toLowerCase()]=decodeURIComponent(m[2])}catch{map[m[1].toLowerCase()]=m[2]}}return matched?map:null}
const startUtm=parseStartUtm(startParam);
const deep={productId:params.get('product')||'',categoryId:params.get('category')||'',mode:params.get('mode')||''};
if(startParam.startsWith('product_'))deep.productId=startParam.slice(8);
else if(startParam.startsWith('cat_')||startParam.startsWith('category_'))deep.categoryId=startParam.replace(/^cat(egory)?_/,'');
else if(startParam.startsWith('shop_')){/* shop id ignored; slug via ?shop= */}
const isSpecialStart=Boolean(startUtm)||/^(product_|cat_|category_|shop_|ref_|referral_)/i.test(startParam);
const slugFromStart=startParam&&!isSpecialStart?startParam:'';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let slug=params.get('shop')||slugFromStart||'';
function redirectToShop(nextSlug){
  const u=new URL(location.href);
  u.searchParams.set('shop', nextSlug);
  // Drop startapp shop aliases that can force the wrong store.
  location.replace(u.pathname+u.search+u.hash);
}
const refStorageKey=()=>`gt_ref_${slug||'_'}`;
function captureReferralCode(){
  let code=String(params.get('ref')||params.get('referral')||'').trim().toUpperCase();
  if(!code&&startParam){
    const m=String(startParam).match(/^(?:ref_|referral_)([A-Z0-9]+)$/i);
    if(m) code=m[1].toUpperCase();
  }
  if(code) storage.set(refStorageKey(),code);
  return code||String(storage.get(refStorageKey())||'').trim().toUpperCase();
}
let referralCode=captureReferralCode();
function currentReferralCode(){
  return referralCode||String(storage.get(refStorageKey())||'').trim().toUpperCase()||'';
}
async function ensureShopBoundToBot(){
  const initData=initDataRaw();
  if(!initData) return slug;
  try{
    const resolved=await fetchJson(`${api}/public/telegram/resolve-shop`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({initData}),
    },12000);
    const next=String(resolved?.shop?.slug||'').trim();
    if(next && next!==slug){
      redirectToShop(next);
      return null; // navigating away
    }
    if(next) slug=next;
  }catch{}
  return slug;
}
// Never reuse another shop from localStorage across bots/sessions — that leaked GtTobacco into new shops.
if(slug) storage.set('gt_shop',slug);
const money=v=>Number(v||0).toLocaleString('ru-RU');
let data,checkoutConfig,cart=[],telegramIdentity=null,customerProfile=null,portalTab='menu',catalogQuery='',activeCategory=deep.categoryId||'',appTab='home';
const image=p=>p.images?.[0]?.url||p.imageUrl||'';
const variantImage=v=>v?.imageUrl||v?.images?.[0]?.url||'';
const imgTag=(src,alt,cls='',prio='low',size='thumb')=>{
  const url=mediaUrl(src,size);
  if(!url)return`<div class="image ${cls}">◇</div>`;
  // Mini App used to force eager on every image → dozens of multi‑MB downloads.
  const eager=prio==='high';
  const lazy=eager?'eager':'lazy';
  const fp=prio==='high'?'high':'auto';
  return`<img class="${cls}" src="${esc(url)}" alt="${esc(alt||'')}" width="800" height="800" loading="${lazy}" decoding="async" fetchpriority="${fp}">`;
};

const totalItems=()=>cart.reduce((sum,item)=>sum+item.quantity,0);
const linePrice=item=>Number(item.variant?.price ?? item.product.price ?? 0);
const subtotal=()=>cart.reduce((sum,item)=>sum+linePrice(item)*item.quantity,0);
const showcaseMode=()=>deep.mode||data?.storefront?.theme?.showcaseMode||'grid';
const categoryDescendants=rootId=>{const ids=new Set([rootId]);let grew=true;while(grew){grew=false;for(const c of data.categories||[]){if(c.parentId&&ids.has(c.parentId)&&!ids.has(c.id)){ids.add(c.id);grew=true}}}return ids};
const categoryChildren=parentId=>(data.categories||[]).filter(c=>c.parentId===parentId);
const categoryById=id=>(data.categories||[]).find(c=>c.id===id);
const categoryRootId=id=>{let cur=categoryById(id);const seen=new Set();while(cur?.parentId&&!seen.has(cur.id)){seen.add(cur.id);cur=categoryById(cur.parentId)}return cur?.id||id||''};
const categoryPath=id=>{const path=[];let cur=categoryById(id);const seen=new Set();while(cur&&!seen.has(cur.id)){seen.add(cur.id);path.unshift(cur);cur=categoryById(cur.parentId)}return path};
/** 3-level nav: root chips above; here L2 (Terea/Neo) + optional L3 (страна/формат). */
const scopedCategoryNav=()=>{
  if(!activeCategory) return {rootId:'',branchId:'',l2:[],l3:[]};
  const path=categoryPath(activeCategory);
  const rootId=path[0]?.id||activeCategory;
  const l2=categoryChildren(rootId);
  let branchId='';
  if(path.length>=2) branchId=path[1].id;
  else if(path.length===1&&!l2.length) branchId='';
  const l3=branchId?categoryChildren(branchId):[];
  return {rootId,branchId,l2,l3,path};
};
/** Legacy helper for single-row consumers. */
const scopedSubcategories=()=>{
  const nav=scopedCategoryNav();
  if(!nav.rootId) return {parentId:'',children:[]};
  if(nav.branchId&&nav.l3.length) return {parentId:nav.branchId,children:nav.l3};
  if(nav.l2.length) return {parentId:nav.rootId,children:nav.l2};
  return {parentId:nav.rootId,children:[]};
};

const categoryImageUrl=id=>{
  let cur=categoryById(id);
  const seen=new Set();
  while(cur&&!seen.has(cur.id)){
    seen.add(cur.id);
    if(cur.imageUrl) return cur.imageUrl;
    cur=categoryById(cur.parentId);
  }
  return '';
};
const categoryProductDisplay=id=>{
  const cat=categoryById(id);
  return cat?.productDisplay==='flavors'?'flavors':'photos';
};
const flavorKey=(productId,variantId)=>`${productId}::${variantId||''}`;
let flavorSelected=new Set();
const flavorRowsFromProducts=products=>{
  const rows=[];
  for(const p of products||[]){
    const variants=(p.variants||[]).filter(v=>v.active!==false);
    if(variants.length){
      for(const v of variants){
        rows.push({
          key:flavorKey(p.id,v.id),
          product:p,
          variant:v,
          name:String(v.name||p.name||'').trim(),
          price:Number(v.price??p.price??0),
          stock:Number(v.stock??p.totalStock??p.stock??0),
          hasOwnImage:Boolean(variantImage(v)||image(p)),
        });
      }
    }else{
      rows.push({
        key:flavorKey(p.id,''),
        product:p,
        variant:null,
        name:String(p.name||'').trim(),
        price:Number(p.price??0),
        stock:Number(p.totalStock??p.stock??0),
        hasOwnImage:Boolean(image(p)),
      });
    }
  }
  return rows;
};
const flavorListHtml=()=>{
  const cat=categoryById(activeCategory);
  if(!cat||categoryProductDisplay(activeCategory)!=='flavors') return '';
  // If this category still has image children, keep tile nav — list only when leaf or no image kids
  const imageKids=categoryChildren(activeCategory).filter(c=>c.imageUrl);
  if(imageKids.length) return '';
  const products=filteredProducts();
  const q=catalogQuery.trim().toLowerCase();
  const rows=flavorRowsFromProducts(products).filter(r=>!q||String(r.name||'').toLowerCase().includes(q)||String(r.product?.name||'').toLowerCase().includes(q));
  const hero=mediaUrl(categoryImageUrl(activeCategory),'hero');
  const selectedCount=[...flavorSelected].filter(k=>rows.some(r=>r.key===k)).length;
  const canBuy=cartEnabled();
  return `<section class="flavor-board" aria-label="${esc(cat.name)}">
    <div class="flavor-hero">${hero?`<img src="${esc(hero)}" alt="${esc(cat.name)}" loading="eager" decoding="async" fetchpriority="high">`:`<div class="flavor-hero-ph">◇</div>`}
      <div class="flavor-hero-meta"><small>Выберите вкус</small><h2>${esc(cat.name)}</h2></div>
    </div>
    <div class="flavor-list">${rows.length?rows.map(r=>{
      const on=flavorSelected.has(r.key);
      const disabled=r.stock<=0;
      return `<button type="button" class="flavor-row ${on?'is-on':''} ${disabled?'is-out':''}" data-flavor-key="${esc(r.key)}" data-flavor-product="${esc(r.product.id)}" data-flavor-variant="${esc(r.variant?.id||'')}" ${disabled?'disabled':''}>
        <span class="flavor-check" aria-hidden="true"></span>
        <span class="flavor-text"><b>${esc(r.name)}</b><small>${disabled?'Нет в наличии':`${money(r.price)} ₽`}</small></span>
      </button>`;
    }).join(''):'<p class="empty-cart">В этой линейке пока нет вкусов</p>'}</div>
    ${canBuy&&rows.length?`<div class="flavor-bar"><button type="button" class="flavor-add" id="flavor-add-cart" ${selectedCount?'':'disabled'}>${selectedCount?`В корзину · ${selectedCount}`:'Выберите вкус'}</button></div>`:''}
  </section>`;
};

const filteredProducts=()=>data.products.filter(p=>{
  const q=catalogQuery.trim().toLowerCase();
  const variantBlob=(p.variants||[]).map(v=>`${v.name||''} ${v.sku||''}`).join(' ');
  const okQuery=!q||`${p.name} ${p.sku} ${p.brand||''} ${variantBlob}`.toLowerCase().includes(q);
  const okCat=!activeCategory||categoryDescendants(activeCategory).has(p.categoryId);
  const okProduct=!deep.productId||p.id===deep.productId;
  return okQuery&&okCat&&okProduct;
});
const categoryButtons=()=>{
  const cats=data.categories||[];
  const roots=cats.filter(c=>!c.parentId);
  const btn=(c,nested,on)=>`<button data-category="${c.id}" class="${on?'active':''}${nested?' cat-child':''}">${esc(c.name)}</button>`;
  /* Mini App / vitrina: L2 + L3 under selected root, never repeat root chips */
  if(isCompact||vitrinaList().length>0){
    const nav=scopedCategoryNav();
    if(!nav.rootId||!nav.l2.length) return '';
    const l2Html=nav.l2.map(c=>btn(c,true,nav.branchId===c.id||(!nav.branchId&&activeCategory===c.id))).join('');
    if(!nav.branchId||!nav.l3.length) return l2Html;
    const l3Html=nav.l3.map(c=>btn(c,true,activeCategory===c.id)).join('');
    return `${l2Html}<span class="cat-level-break" aria-hidden="true"></span>${l3Html}`;
  }
  if(!roots.length)return cats.map(c=>btn(c,false,activeCategory===c.id)).join('');
  return roots.map(r=>`${btn(r,false,activeCategory===r.id)}${categoryChildren(r.id).map(c=>btn(c,true,activeCategory===c.id)).join('')}`).join('');
};
const analyticsSession=sessionStore.get('gt_analytics_session')||uuid();sessionStore.set('gt_analytics_session',analyticsSession);
const withTimeout=(promise,timeoutMs,label='timeout')=>new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(Object.assign(new Error(label),{name:'AbortError'})),timeoutMs);
  Promise.resolve(promise).then(
    (value)=>{clearTimeout(timer);resolve(value)},
    (err)=>{clearTimeout(timer);reject(err)},
  );
});
const fetchJson=async(url,options={},timeoutMs=10000)=>{
  const ctrl=new AbortController();
  const timer=setTimeout(()=>{try{ctrl.abort()}catch{}},timeoutMs);
  try{
    // Always bypass HTTP/WebView cache so admin edits reach Mini App immediately
    const r=await withTimeout(fetch(url,{cache:'no-store',...options,signal:ctrl.signal}),timeoutMs+80,'Сервер не ответил вовремя');
    const j=await r.json().catch(()=>({}));
    if(!r.ok)throw new Error(j.error?.message||`Ошибка ${r.status}`);
    return j;
  }finally{clearTimeout(timer)}
};
let storefrontSyncing=false;
let lastStorefrontSync=0;
let storefrontSyncTimer=null;
function ensureModalRoot(){
  let modal=document.querySelector('body > #modal');
  if(!modal){
    modal=document.querySelector('#modal');
    if(modal) document.body.appendChild(modal);
    else{
      modal=document.createElement('div');
      modal.id='modal';
      document.body.appendChild(modal);
    }
  }
  document.querySelectorAll('#app #modal').forEach(el=>{if(el!==modal)el.remove()});
  return modal;
}
function storefrontBusyUi(){
  return Boolean(document.querySelector('#checkout-form, .product-detail, .ref-sheet, .profile-card.wide, .modal-backdrop, #modal:not(:empty), #profile-panel:not([hidden])'));
}
async function loadStorefrontData({soft=false}={}){
  if(!slug) return null;
  if(storefrontSyncing) return null;
  if(soft && storefrontBusyUi()) return null;
  const now=Date.now();
  if(soft && now-lastStorefrontSync<1200) return null;
  storefrontSyncing=true;
  try{
    const store=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}?_=${now}`,{cache:'no-store'},soft?6000:8000);
    if(!store||typeof store!=='object') return null;
    data=store;
    if(data?.storefront&&!Array.isArray(data.storefront.vitrina)) data.storefront.vitrina=[];
    if(!Array.isArray(data.storefront?.blocks)) data.storefront={...(data.storefront||{}),blocks:[]};
    if(!Array.isArray(data.products)) data.products=[];
    if(!Array.isArray(data.categories)) data.categories=[];
    lastStorefrontSync=Date.now();
    if(soft){
      if(storefrontBusyUi()) return data;
      const drawerOpen=document.querySelector('#drawer')?.classList.contains('open');
      const keepTab=appTab;
      render();
      appTab=keepTab;
      if(drawerOpen) document.querySelector('#drawer')?.classList.add('open');
    }
    return data;
  }catch(err){
    if(!soft) throw err;
    console.warn('[storefront-sync]',err?.message||err);
    return null;
  }finally{
    storefrontSyncing=false;
  }
}
function scheduleStorefrontSync(){
  if(storefrontSyncTimer) clearTimeout(storefrontSyncTimer);
  storefrontSyncTimer=setTimeout(()=>{loadStorefrontData({soft:true}).catch(()=>{})},350);
}
function bindStorefrontLiveSync(){
  document.addEventListener('visibilitychange',()=>{
    if(document.visibilityState==='visible') scheduleStorefrontSync();
  });
  window.addEventListener('pageshow',(e)=>{if(e.persisted) scheduleStorefrontSync()});
  window.addEventListener('focus',scheduleStorefrontSync);
  // While Mini App stays open, pick up admin/section edits without reopen
  setInterval(()=>{
    if(document.visibilityState==='visible') loadStorefrontData({soft:true}).catch(()=>{});
  },12000);
}
const authHeaders=()=>{const token=telegramIdentity?.token||storage.get(`gt_customer_${slug}`);return token?{authorization:`Bearer ${token}`}:{};};
function track(type,extra={}){fetch(`${api}/public/storefronts/${encodeURIComponent(slug)}/analytics/events`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type,source:params.get('utm_source')||params.get('source')||(getTg()?.initData?'telegram':'direct'),sessionId:analyticsSession,...extra})}).catch(()=>{})}

function block(block){const s=block.settings||{};if(block.visible===false)return'';if(block.type==='hero'||block.type==='banner'){const media=s.imageUrl?`<div class="hero-media"><img src="${esc(mediaUrl(s.imageUrl))}" alt=""></div>`:'';const cta=s.linkUrl?`<a class="hero-cta" href="${esc(s.linkUrl)}">${esc(s.buttonText||'Открыть')}</a>`:`<button onclick="document.querySelector('.products')?.scrollIntoView({behavior:'smooth'})">${esc(s.buttonText||'Каталог')}</button>`;const eyebrow=String(s.eyebrow||'').trim();const subtitle=String(s.subtitle||'').trim();return`<section class="hero ${block.type}">${media}<div>${eyebrow?`<small>${esc(eyebrow)}</small>`:''}<h1>${esc(s.title||data.shop.name)}</h1>${subtitle?`<p>${esc(subtitle)}</p>`:''}${cta}</div></section>`}if(block.type==='features'){const items=[s.f1||s.feature1||'Быстрая доставка',s.f2||s.feature2||'Бонусы за покупки',s.f3||s.feature3||'Поддержка в Telegram'];return`<section class="features"><h2>${esc(s.title||'Почему мы')}</h2><div class="feature-grid">${items.map(t=>`<article><b>${esc(t)}</b></article>`).join('')}</div></section>`}if(block.type==='categories'){const useScoped=Boolean(isCompact||vitrinaList().length>0);if(useScoped){/* Subcats render under root chips in catalogToolbarHtml */return''}return`<section><h2>${esc(s.title||'Категории')}</h2><div class="categories"><button data-category="" class="${!activeCategory?'active':''}">Все</button>${categoryButtons()}</div></section>`}if(block.type==='products'||block.type==='showcase'){const mode=s.mode||showcaseMode();const flavorMode=activeCategory&&categoryProductDisplay(activeCategory)==='flavors'&&!categoryChildren(activeCategory).some(c=>c.imageUrl);if(flavorMode){return`<section class="products showcase-flavors">${catalogToolbarHtml(s.title||categoryById(activeCategory)?.name||'Товары','Поиск вкуса')}${flavorListHtml()}</section>`}return`<section class="products showcase-${esc(mode)}">${catalogToolbarHtml(s.title||'Товары','Поиск по названию, SKU, бренду')}<div class="grid mode-${esc(mode)}">${filteredProducts().map((p,i)=>productCard(p,i)).join('')||'<p class="empty-cart">Ничего не найдено</p>'}</div></section>`}if(block.type==='text'||block.type==='newsletter')return`<section class="text"><h2>${esc(s.title||'')}</h2><p>${esc(s.text||s.subtitle||'')}</p></section>`;if(block.type==='spacer')return`<div style="height:${Number(s.height||32)}px"></div>`;return''}
function cartEnabled(){return data?.cartEnabled!==false&&data?.showcaseOnly!==true&&data?.storefront?.theme?.cartEnabled!==false&&data?.storefront?.theme?.showcaseOnly!==true}
function ensureMetrika(){const mid=String(data?.shop?.settings?.analytics?.metrikaId||'').trim();if(!mid||document.getElementById('ym-gtstore'))return;const s=document.createElement('script');s.id='ym-gtstore';s.innerHTML=`(function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};m[i].l=1*new Date();k=e.createElement(t),a=e.getElementsByTagName(t)[0];k.async=1;k.src=r;a.parentNode.insertBefore(k,a)})(window,document,"script","https://mc.yandex.ru/metrika/tag.js","ym");ym(${JSON.stringify(mid)},"init",{clickmap:true,trackLinks:true,accurateTrackBounce:true});`;document.head.append(s)}
function productCard(p,index=0){const variants=(p.variants||[]).filter(v=>v.active!==false);const cover=variantImage(variants[0])||image(p)||categoryImageUrl(p.categoryId);const buy=cartEnabled()?`<button data-add="${p.id}" ${p.totalStock<=0?'disabled':''}>${p.totalStock<=0?'Нет в наличии':'В корзину'}</button>`:`<button type="button" disabled>Витрина</button>`;const brand=p.brand?`<small class="product-brand">${esc(p.brand)}</small>`:'';const prio=index<6?'high':'low';return`<article class="product" data-category-id="${esc(p.categoryId||'')}" data-open-product="${p.id}" role="button" tabindex="0">${imgTag(cover,p.name,'product-cover',prio,'thumb')}${brand}<h3>${esc(p.name)}</h3><p class="product-price">${money(variants[0]?.price??p.price)} ₽</p>${buy}</article>`}
function openProduct(productId){
  const p=data.products.find(x=>x.id===productId);if(!p)return;
  const variants=(p.variants||[]).filter(v=>v.active!==false);
  const variant=variants[0]||null;
  const cover=variantImage(variant)||image(p);
  const modal=document.querySelector('#modal');
  const rawDesc=String(p.description||'').trim();
  const name=String(p.name||'').trim();
  const desc=rawDesc&&rawDesc.toLowerCase()!==name.toLowerCase()?rawDesc:'';
  const price=Number(variant?.price??p.price??0);
  const canBuy=cartEnabled()&&Number(p.totalStock||0)>0;
  const orderBtn=canBuy
    ?`<button type="button" class="primary detail-order" id="detail-order"><span class="detail-order-label">Оформить доставку</span><b class="detail-order-sum">${money(price)} ₽</b></button>`
    :(cartEnabled()?`<button type="button" class="primary" id="detail-order" disabled>Нет в наличии</button>`:'');
  modal.innerHTML=`<div class="modal-backdrop" id="product-backdrop"><div class="checkout-card product-detail${desc?' has-desc':''}"><button type="button" class="modal-close" id="close-product">×</button><div class="product-detail-media">${cover?`<img src="${esc(mediaUrl(cover,'detail'))}" alt="${esc(name)}" loading="eager" decoding="async" fetchpriority="high">`:'<div class="image">◇</div>'}</div><div class="product-detail-meta"><small class="product-brand">${esc(p.brand||'')}</small><h2>${esc(name)}</h2><p class="product-price"><b>${money(price)} ₽</b></p></div><div class="product-detail-body">${desc?`<p class="product-desc">${esc(desc)}</p>`:''}</div><div class="modal-actions">${orderBtn}<button type="button" class="ghost" id="close-product-2">Закрыть</button></div></div></div>`;
  const close=()=>{modal.innerHTML='';syncTgBackButton(false);syncTgMainButton();syncBodyScrollLock?.()};
  modal.querySelector('#close-product').onclick=close;
  modal.querySelector('#close-product-2').onclick=close;
  modal.querySelector('#product-backdrop').onclick=e=>{if(e.target.id==='product-backdrop')close()};
  modal.querySelector('#detail-order')?.addEventListener('click',()=>{
    if(!canBuy)return;
    const existing=cart.find(item=>item.product.id===p.id&&(item.variant?.id||'')===(variant?.id||''));
    if(existing)existing.quantity++;
    else cart.push({product:p,variant,quantity:1});
    track('add_to_cart',{productId:p.id,variantId:variant?.id||null});
    close();
    render();
    openCheckout();
  });
  syncTgBackButton(true);
  syncBodyScrollLock?.();
}
function cartLines(){return cart.length?cart.map((item,i)=>`<article class="cart-line"><div><b>${esc(item.product.name)}${item.variant?` · ${esc(item.variant.name||item.variant.sku)}`:''}</b><small>${money(linePrice(item))} ₽</small></div><div class="qty"><button data-dec="${i}">−</button><span>${item.quantity}</span><button data-inc="${i}">+</button></div><button class="remove" data-remove="${i}">×</button></article>`).join(''):'<div class="empty-cart">Корзина пуста</div>'}
function vitrinaList(){return (data.storefront?.vitrina||[]).filter(x=>x&&x.visible!==false&&x.imageUrl&&(x.placement==='carousel'||x.placement==='tiles')).sort((a,b)=>Number(b.priority||0)-Number(a.priority||0))}
function vitrinaTargetAttrs(item){
  const link=String(item?.linkUrl||'').trim();
  if(link) return `href="${esc(link)}" target="_blank" rel="noopener"`;
  return `href="#catalog" data-vitrina-catalog="1"`;
}
function vitrinaCarouselHtml(){
  const banners=vitrinaList().filter(x=>x.placement==='carousel');
  if(!banners.length)return'';
  const slide=Math.min(Math.max(0,Number(window.__vitrinaSlide||0)),banners.length-1);
  window.__vitrinaSlide=slide;
  const slides=banners.map((b,i)=>{
    const title=String(b.title||'').trim();
    const subtitle=String(b.subtitle||'').trim();
    const copy=(title||subtitle)?`<div class="vitrina-banner-copy">${title?`<b>${esc(title)}</b>`:''}${subtitle?`<small>${esc(subtitle)}</small>`:''}</div>`:'';
    const src=mediaUrl(b.imageUrl,'hero');
    const eager=i===slide||i===((slide+1)%banners.length);
    return `<a class="vitrina-banner ${title||subtitle?'':'image-only'}${i===slide?' is-active':''}" data-vitrina-slide="${i}" ${vitrinaTargetAttrs(b)}>${src?`<img src="${esc(src)}" alt="" loading="${eager?'eager':'lazy'}" decoding="async"${i===slide?' fetchpriority="high"':''}>`:'<div class="vitrina-banner-ph"></div>'}${copy}</a>`;
  }).join('');
  return `<section class="vitrina-carousel" aria-label="Баннеры"><div class="vitrina-carousel-stage">${slides}</div>${banners.length>1?`<div class="vitrina-dots">${banners.map((_,i)=>`<button type="button" class="${i===slide?'on':''}" data-vitrina-dot="${i}" aria-label="Слайд ${i+1}"></button>`).join('')}</div>`:''}</section>`;
}
function setVitrinaSlide(index){
  const banners=vitrinaList().filter(x=>x.placement==='carousel');
  if(!banners.length)return;
  const next=((Number(index)%banners.length)+banners.length)%banners.length;
  window.__vitrinaSlide=next;
  const section=document.querySelector('.vitrina-carousel');
  if(!section)return;
  section.querySelectorAll('.vitrina-banner').forEach((el)=>el.classList.toggle('is-active',Number(el.dataset.vitrinaSlide)===next));
  section.querySelectorAll('[data-vitrina-dot]').forEach((el)=>el.classList.toggle('on',Number(el.dataset.vitrinaDot)===next));
}
function vitrinaTilesHtml(){const tiles=vitrinaList().filter(x=>x.placement==='tiles');if(!tiles.length)return'';return `<section class="vitrina-tiles" aria-label="Разделы">${tiles.map((t,i)=>{const title=String(t.title||'').trim();const subtitle=String(t.subtitle||'').trim();const label=title||subtitle||t.name||'Плитка';const src=mediaUrl(t.imageUrl,'tile');const eager=i<8;if(src)return`<a class="vitrina-tile image-only" ${vitrinaTargetAttrs(t)} aria-label="${esc(label)}"><span class="vitrina-tile-media"><img src="${esc(src)}" alt="${esc(label)}" width="800" height="800" loading="${eager?'eager':'lazy'}" decoding="async"${eager?' fetchpriority="high"':''}></span></a>`;return`<a class="vitrina-tile" ${vitrinaTargetAttrs(t)}><span class="vitrina-tile-ico">◆</span><div><b>${esc(label)}</b></div></a>`}).join('')}</section>`}
/** Image tiles for categories that contain subcats/lines (or any level with imageUrl). */
function categoryTilesHtml(){
  const cats=data.categories||[];
  let items=[];
  if(!activeCategory){
    items=cats.filter(c=>!c.parentId&&c.imageUrl);
  }else{
    const kids=categoryChildren(activeCategory).filter(c=>c.imageUrl);
    if(kids.length) items=kids;
  }
  if(!items.length) return '';
  return `<section class="vitrina-tiles category-tiles" aria-label="Категории">${items.map((c,i)=>{
    const src=mediaUrl(c.imageUrl,'tile');
    const on=activeCategory===c.id||categoryRootId(activeCategory)===c.id||categoryPath(activeCategory).some(p=>p.id===c.id);
    const eager=i<8;
    return `<button type="button" class="vitrina-tile image-only ${on?'on':''}" data-cat="${esc(c.id)}" aria-label="${esc(c.name)}"><span class="vitrina-tile-media">${src?`<img src="${esc(src)}" alt="${esc(c.name)}" width="800" height="800" loading="${eager?'eager':'lazy'}" decoding="async"${eager?' fetchpriority="high"':''}>`:''}</span><span class="cat-tile-label">${esc(c.name)}</span></button>`;
  }).join('')}</section>`;
}
function vitrinaChipsHtml(){const cats=(data.categories||[]).filter(c=>!c.parentId).slice(0,12);const rootOn=activeCategory?categoryRootId(activeCategory):'';return `<section class="vitrina-chips"><button type="button" class="vitrina-sort" id="vitrina-sort" aria-label="Сортировка">⇅</button><button type="button" class="vitrina-chip ${!activeCategory?'on':''}" data-cat="">Все</button>${cats.map(c=>`<button type="button" class="vitrina-chip ${rootOn===c.id?'on':''}" data-cat="${esc(c.id)}">${esc(c.name)}</button>`).join('')}</section>`}
function scopedSubcatsHtml(){
  if(!activeCategory) return '';
  const nav=scopedCategoryNav();
  if(!nav.l2.length&&!nav.l3.length) return '';
  const rootName=categoryById(nav.rootId)?.name||'Раздел';
  const branchName=categoryById(nav.branchId)?.name||'';
  const l2Row=`<div class="categories cat-row"><button data-category="${esc(nav.rootId)}" class="${activeCategory===nav.rootId?'active':''}">Все · ${esc(rootName)}</button>${nav.l2.map(c=>`<button data-category="${esc(c.id)}" class="${(nav.branchId===c.id||activeCategory===c.id)?'active':''} cat-child">${esc(c.name)}</button>`).join('')}</div>`;
  const l3Row=nav.branchId&&nav.l3.length?`<div class="categories cat-row cat-row-l3"><button data-category="${esc(nav.branchId)}" class="${activeCategory===nav.branchId?'active':''}">Все · ${esc(branchName)}</button>${nav.l3.map(c=>`<button data-category="${esc(c.id)}" class="${activeCategory===c.id?'active':''} cat-child">${esc(c.name)}</button>`).join('')}</div>`:'';
  return `<div class="cat-nav-inline" aria-label="Подкатегории">${l2Row}${l3Row}</div>`;
}
function catalogToolbarHtml(title,placeholder){
  const chips=(isCompact||vitrinaList().length>0)?vitrinaChipsHtml():'';
  const subcats=chips?scopedSubcatsHtml():'';
  const headTitle=chips?'':`<h2>${esc(title||'Товары')}</h2>`;
  return `${chips}${subcats}<div class="catalog-head${chips?' is-search-only':''}">${headTitle}<input id="catalog-search" value="${esc(catalogQuery)}" placeholder="${esc(placeholder||'Поиск')}"></div>`;
}
function vitrinaSectionHtml(){
  const catTiles=categoryTilesHtml();
  const has=vitrinaList().length>0||Boolean(catTiles);
  if(!has&&!isCompact)return'';
  /* Banners/tiles first; category chips live above catalog search. */
  return `<div class="vitrina-top">${catTiles}${vitrinaTilesHtml()}${vitrinaCarouselHtml()}</div>`;
}

function initDataRaw(){
  const w=getTg();
  if(w?.initData) return String(w.initData);
  const m=String(location.hash||'').match(/tgWebAppData=([^&]+)/);
  if(!m) return '';
  try{return decodeURIComponent(m[1])}catch{return m[1]}
}
function parseUserFromInitData(raw){
  if(!raw) return null;
  try{
    const user=new URLSearchParams(raw).get('user');
    if(!user) return null;
    const parsed=JSON.parse(user);
    return parsed&&typeof parsed==='object'?parsed:null;
  }catch{return null}
}
function tgWebUser(){
  const w=getTg();
  const u=w?.initDataUnsafe?.user||parseUserFromInitData(initDataRaw());
  if(u&&(u.id||u.first_name||u.username)) return u;
  return null;
}
function customerName(){
  const u=tgWebUser();
  if(u){
    const fromTg=[u.first_name,u.last_name].filter(Boolean).join(' ').trim();
    if(fromTg) return fromTg;
    if(u.username) return `@${u.username}`;
  }
  const c=telegramIdentity?.customer||{};
  const fromAuth=[c.firstName,c.lastName].filter(Boolean).join(' ').trim();
  if(fromAuth) return fromAuth;
  if(c.username) return `@${c.username}`;
  const p=customerProfile?.profile||customerProfile?.customer||{};
  const fromProfile=String(p.name||'').trim();
  if(fromProfile&&fromProfile.toLowerCase()!=='покупатель') return fromProfile;
  return 'Покупатель';
}
function customerPhoto(){
  const raw=String(
    telegramIdentity?.customer?.photoUrl
    ||tgWebUser()?.photo_url
    ||customerProfile?.photoUrl
    ||customerProfile?.profile?.photoUrl
    ||''
  ).trim();
  if(!raw){
    const token=telegramIdentity?.token||storage.get(`gt_customer_${slug}`);
    if(token) return `${api}/public/storefronts/${encodeURIComponent(slug)}/telegram/avatar?t=${encodeURIComponent(token)}`;
    return '';
  }
  if(/^https?:\/\//i.test(raw)||raw.startsWith('data:')||raw.startsWith('blob:')) return raw;
  if(raw.startsWith('/')) return raw;
  return `/${raw}`;
}
function customerInitials(){
  const parts=customerName().replace(/^@/,'').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0]||'G')+(parts[1]?.[0]||'')).toUpperCase();
}
function avatarHtml(cls='tg-avatar'){
  const photo=customerPhoto();
  if(!photo) return `<div class="${cls}">${esc(customerInitials())}</div>`;
  return `<div class="${cls} has-photo" data-initials="${esc(customerInitials())}"><img src="${esc(photo)}" alt="${esc(customerName())}" loading="eager" decoding="async" referrerpolicy="no-referrer" data-retry="0" onerror="window.__gtAvatarErr&&window.__gtAvatarErr(this)"></div>`;
}
window.__gtAvatarErr=(img)=>{
  const n=Number(img.dataset.retry||0);
  const box=img.closest('.has-photo');
  if(n>=4){
    if(box){
      box.classList.remove('has-photo');
      box.textContent=box.dataset.initials||'G';
    }
    return;
  }
  img.dataset.retry=String(n+1);
  const base=String(img.getAttribute('src')||'').replace(/([?&])_r=\d+/g,'').replace(/[?&]$/,'');
  setTimeout(()=>{img.src=`${base}${base.includes('?')?'&':'?'}_r=${Date.now()}`},800*(n+1));
};
function referralEnabled(){
  return Boolean(customerProfile?.referral?.enabled||data?.referralProgramEnabled||data?.shop?.settings?.referralProgram?.enabled);
}
function referralAcceptedKey(){return `gt_ref_accepted_${slug}`}
function referralAccepted(){return storage.get(referralAcceptedKey())==='1'}
function setReferralAccepted(){storage.set(referralAcceptedKey(),'1')}
function referralInviteLink(invite){
  if(!invite?.code) return '';
  if(invite.telegramLink) return invite.telegramLink;
  const bot=String(invite.botUsername||data?.telegram?.botUsername||'').replace(/^@/,'');
  if(bot) return `https://t.me/${bot}?startapp=${encodeURIComponent(`ref_${invite.code}`)}`;
  return `${location.origin}${location.pathname}?shop=${encodeURIComponent(slug)}&ref=${encodeURIComponent(invite.code)}`;
}
function referralWebLink(invite){
  if(!invite?.code) return '';
  return `${location.origin}${location.pathname}?shop=${encodeURIComponent(slug)}&ref=${encodeURIComponent(invite.code)}`;
}
async function copyText(value,btn){
  const text=String(value||'');
  if(!text)return false;
  try{
    if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text)}
    else throw new Error('no clipboard');
    if(btn){const prev=btn.textContent;btn.textContent='Скопировано';setTimeout(()=>{btn.textContent=prev},1600)}
    return true;
  }catch{
    try{
      const ta=document.createElement('textarea');
      ta.value=text;ta.setAttribute('readonly','');ta.style.position='fixed';ta.style.opacity='0';
      document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
      if(btn){const prev=btn.textContent;btn.textContent='Скопировано';setTimeout(()=>{btn.textContent=prev},1600)}
      return true;
    }catch{
      prompt('Скопируйте ссылку:',text);
      return false;
    }
  }
}
function shareInviteInTelegram(link,text){
  const url=`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${encodeURIComponent(text||'')}`;
  const tg=getTg();
  try{
    if(tg?.openTelegramLink){tg.openTelegramLink(url);return}
    if(tg?.openLink){tg.openLink(url);return}
  }catch{}
  window.open(url,'_blank','noopener');
}
function inviteLinkBlockHtml(invite,{compact=false}={}){
  const link=referralInviteLink(invite);
  const friend=referralRewardLabel(invite.refereeReward);
  const yours=referralRewardLabel(invite.referrerReward);
  if(!link) return `<p class="ref-sheet-error">Не удалось получить ссылку. Откройте магазин через Telegram-бот.</p>`;
  const shopName=data?.shop?.name||'магазине';
  const shareText=`Скидка ${friend} на первый заказ в ${shopName}`;
  const st=invite.stats||{};
  const clicks=Number(st.clicks??st.invited??0);
  const invited=Number(st.invited??0);
  const orders=Number(st.orders??0);
  const stats=`<div class="ref-stats" aria-label="Статистика">
      <div class="ref-stat"><b>${clicks}</b><small>перешли</small></div>
      <div class="ref-stat"><b>${invited}</b><small>пришли</small></div>
      <div class="ref-stat"><b>${orders}</b><small>заказали</small></div>
    </div>`;
  return `${compact?'':`<p class="ref-sheet-text">Вам — ${esc(yours)} после первого заказа друга. Другу — ${esc(friend)} на первую покупку.</p>`}
    <div class="invite-code-wrap">
      <small>Ваш промокод</small>
      <button type="button" class="invite-code invite-code-btn" data-invite-copy="${esc(invite.code||'')}" aria-label="Скопировать промокод">${esc(invite.code||'')}</button>
    </div>
    <div class="invite-code-wrap">
      <small>Реферальная ссылка</small>
      <button type="button" class="invite-link-a invite-link invite-link-btn" data-invite-copy="${esc(link)}" title="${esc(link)}">${esc(link)}</button>
    </div>
    ${stats}
    <div class="invite-actions ref-sheet-actions">
      <button type="button" class="ref-sheet-btn ref-share-btn" data-invite-share="${esc(link)}" data-invite-share-text="${esc(shareText)}">Поделиться</button>
    </div>`;
}
function bindInviteLinkActions(root=document){
  root.querySelectorAll('[data-invite-copy]').forEach(btn=>{
    btn.onclick=async()=>{await copyText(btn.dataset.inviteCopy||'',btn)};
  });
  root.querySelectorAll('[data-invite-share]').forEach(btn=>{
    btn.onclick=()=>shareInviteInTelegram(btn.dataset.inviteShare||'',btn.dataset.inviteShareText||'');
  });
  root.querySelectorAll('[data-invite-open]').forEach(el=>{
    el.addEventListener('click',e=>{
      const href=el.getAttribute('href')||el.dataset.inviteOpen||'';
      const tg=getTg();
      if(tg&&/^https:\/\/t\.me\//i.test(href)){
        e.preventDefault();
        try{tg.openTelegramLink?.(href)||tg.openLink?.(href)||(location.href=href)}catch{location.href=href}
      }
    });
  });
}
function referralRewardLabel(reward){
  if(!reward) return '10%';
  return reward.type==='fixed'?`${money(reward.value)} ₽`:`${Number(reward.value||0)}%`;
}
function profileMenuHtml(){
  const name=customerName();
  const rows=[
    ['invite','ref','Промокод за рекомендацию',''],
    ['orders','orders','История заказов',''],
    ['bonuses','bonus',`Бонусы`,`${money(customerProfile?.bonuses?.balance||customerProfile?.profile?.bonusBalance||0)}`],
    ['addresses','addr','Адреса',''],
    ['support','support','Связаться с поддержкой',''],
  ].filter(([id])=>id!=='invite'||referralEnabled());
  return `<section class="tg-profile"><div class="tg-profile-hero">${avatarHtml('tg-avatar')}<h2>${esc(name)}</h2>${tgWebUser()?.username?`<small class="tg-username">@${esc(tgWebUser().username)}</small>`:''}</div><div class="tg-menu">${rows.map(([id,tone,label,value])=>`<button type="button" class="tg-menu-row" data-profile-action="${id}"><span class="tg-menu-ico tone-${tone}"></span><span class="tg-menu-text">${esc(label)}</span>${value?`<span class="tg-menu-value">${esc(value)}</span>`:''}<span class="tg-menu-chev">›</span></button>`).join('')}</div><div id="profile-panel" class="tg-profile-panel" hidden></div></section>`;
}
function tabIcon(kind){
  /* Apple SF Symbols–style: outline idle, filled when .tg-tab.on */
  if(kind==='home') return `<svg class="sf-ico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><g class="sf-outline" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 10.2 12 3.8l7.5 6.4"/><path d="M6.4 9.6V19.2a1 1 0 0 0 1 1h3.1v-5.1h3V20.2h3.1a1 1 0 0 0 1-1V9.6"/></g><g class="sf-fill" fill="currentColor"><path d="M11.35 3.25a1.1 1.1 0 0 1 1.3 0l8.05 6.35a.95.95 0 0 1-.6 1.7h-.85v8.45a1.7 1.7 0 0 1-1.7 1.7h-3.55a.85.85 0 0 1-.85-.85v-4.55h-2.5v4.55a.85.85 0 0 1-.85.85H6.55a1.7 1.7 0 0 1-1.7-1.7V11.3h-.85a.95.95 0 0 1-.6-1.7l8-6.35Z"/></g></svg>`;
  if(kind==='wishlist') return `<svg class="sf-ico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><g class="sf-outline" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20.2s-6.8-4.35-8.85-8.2C1.95 9.35 2.7 6.2 5.35 5.1A4.35 4.35 0 0 1 12 7.35 4.35 4.35 0 0 1 18.65 5.1c2.65 1.1 3.4 4.25 2.2 6.9C18.8 15.85 12 20.2 12 20.2Z"/></g><g class="sf-fill" fill="currentColor"><path d="M12 21.15a1 1 0 0 1-.55-.16C5.85 17.3 2.1 14 2.1 9.55A5.05 5.05 0 0 1 7 4.4c1.55 0 3.05.7 4.05 1.85A5.3 5.3 0 0 1 17 4.4a5.05 5.05 0 0 1 4.9 5.15c0 4.45-3.75 7.75-9.35 11.44a1 1 0 0 1-.55.16Z"/></g></svg>`;
  if(kind==='cart') return `<svg class="sf-ico" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><g class="sf-outline" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M8 7.25V6a4 4 0 0 1 8 0v1.25"/><path d="M5.75 7.25h12.5l-.95 11.55a1.75 1.75 0 0 1-1.74 1.6H8.44a1.75 1.75 0 0 1-1.74-1.6L5.75 7.25Z"/></g><g class="sf-fill" fill="currentColor"><path fill-rule="evenodd" d="M12 2.75a4.75 4.75 0 0 1 4.75 4.75v.6h1.7c.66 0 1.18.57 1.13 1.23l-.95 11.55A2.5 2.5 0 0 1 16.15 23.5H7.85a2.5 2.5 0 0 1-2.48-2.27l-.95-11.55A1.15 1.15 0 0 1 5.55 8.1h1.7v-.6A4.75 4.75 0 0 1 12 2.75Zm0 1.7A3.05 3.05 0 0 0 8.95 7.5v.6h6.1v-.6A3.05 3.05 0 0 0 12 4.45Z"/></g></svg>`;
  return '';
}
function tabBarHtml(){
  if(!(isCompact||isTg)) return '';
  const count=totalItems();
  const items=[
    ['home','Главная',tabIcon('home')],
    ['wishlist','Избранное',tabIcon('wishlist')],
    ['cart','Корзина',tabIcon('cart')],
    ['profile','Профиль',avatarHtml('tab-avatar')],
  ];
  return `<nav class="tg-tabbar" aria-label="Навигация">${items.map(([id,label,icon])=>`<button type="button" class="tg-tab ${appTab===id?'on':''}" data-tab="${id}"><span class="tg-tab-ico">${icon}${id==='cart'&&count?`<i class="tg-tab-badge">${count}</i>`:''}</span><span class="tg-tab-label">${label}</span></button>`).join('')}</nav>`;
}
function wishlistPageHtml(){
  const wishlist=customerProfile?.wishlist||[];
  return `<section class="tg-page"><h2 class="tg-page-title">Избранное</h2><div class="profile-orders">${wishlist.length?wishlist.map(w=>`<article><b>${esc(w.product?.name||w.productId)}</b><span>${money(w.product?.price||0)} ₽</span><button type="button" data-wish-remove="${esc(w.productId)}">Убрать</button></article>`).join(''):'<p class="empty-cart">Список желаний пуст</p>'}</div></section>`;
}

function render(){const t=data.storefront.theme||{};const root=document.documentElement;const hasVitrina=vitrinaList().length>0;const darkTg=isCompact||hasVitrina;root.style.setProperty('--accent',t.accent||(darkTg?'#ffffff':'#d59a55'));root.style.setProperty('--radius',`${Number(t.radius||22)}px`);root.style.setProperty('--page-bg',darkTg?(t.background&&!['#EBE5DB','#ebe5db'].includes(t.background)?t.background:'#1c1c1e'):(t.background||'#f4f1eb'));root.style.setProperty('--surface',darkTg?(t.surface&&!['#F7F3EC','#f7f3ec'].includes(t.surface)?t.surface:'#2c2c2e'):(t.surface||'#fff'));root.style.setProperty('--text',darkTg?(t.text&&!['#2A2724','#2a2724'].includes(t.text)?t.text:'#f5f5f7'):(t.text||'#171717'));root.style.setProperty('--muted',darkTg?(t.muted&&!['#6F675F','#6f675f'].includes(t.muted)?t.muted:'#a1a1a6'):(t.muted||'#756d64'));ensureViewportLock();root.style.setProperty('--container', (isCompact||darkTg||root.classList.contains('tg-miniapp')) ? '100%' : `${Number(t.container||1100)}px`);root.style.fontFamily='"Plus Jakarta Sans", ui-sans-serif, sans-serif';if(t.font&&!isCompact)root.style.fontFamily=`"${t.font}", "Plus Jakarta Sans", sans-serif`;
  /* Preserve runtime body flags — never wipe tg-miniapp / scroll-locked / tabbar via className= */
  const preserve=['tg-miniapp','tg-native','tg-admin-preview','has-tabbar','has-tg-mainbutton','scroll-locked','has-vitrina'].filter(c=>document.body.classList.contains(c));
  document.body.className=`card-${t.cardStyle||'soft'} button-${t.buttonStyle||'filled'} header-${t.headerStyle||'glass'}`;
  preserve.forEach(c=>document.body.classList.add(c));
  if(isCompact||root.classList.contains('tg-miniapp'))document.body.classList.add('tg-miniapp');
  if(isTgNative||root.classList.contains('tg-native'))document.body.classList.add('tg-native');
  if(hasVitrina)document.body.classList.add('has-vitrina');
  document.title=data.storefront.seo?.title||data.shop.name;let fav=document.querySelector('link[rel="icon"]');if(!fav){fav=document.createElement('link');fav.rel='icon';document.head.append(fav)}fav.href=data.shop.faviconUrl||data.shop.logoUrl||'/gstore-mark.png?v=3';fav.type=(data.shop.faviconUrl||data.shop.logoUrl)?'':(fav.type||'image/png');if(data.storefront.seo?.description){let meta=document.querySelector('meta[name="description"]');if(!meta){meta=document.createElement('meta');meta.name='description';document.head.append(meta)}meta.content=data.storefront.seo.description}ensureMetrika();const showCart=cartEnabled();const blocksHtml=(data.storefront.blocks||[]).filter(b=>!(hasVitrina&&(b.type==='hero'||b.type==='banner'))).map(block).join('');const useTabs=Boolean(isCompact||isTg);const mainHtml=appTab==='profile'?profileMenuHtml():appTab==='wishlist'?wishlistPageHtml():`<div id="catalog">${vitrinaSectionHtml()}${blocksHtml}</div>`;app.innerHTML=`<header class="${hasVitrina||useTabs?'vitrina-header':''}">${data.shop.logoUrl?`<img class="shop-logo" src="${esc(mediaUrl(data.shop.logoUrl))}" alt="${esc(data.shop.name)}">`:`<b>${esc(data.shop.name)}</b>`}<div class="header-actions">${!useTabs&&(telegramIdentity||storage.get(`gt_customer_${slug}`))?`<button id="profile">Кабинет</button>`:''}${showCart&&!useTabs?`<button id="cart">Корзина · <span>${totalItems()}</span></button>`:''}</div></header><main class="${useTabs?'has-tabbar':''}">${mainHtml}</main>${showCart?`<div class="cart-drawer" id="drawer"><div><h2>Корзина</h2><button id="close">×</button></div><section>${cartLines()}</section><footer class="cart-footer"><div class="cart-total"><span>Итого</span><b>${money(subtotal())} ₽</b></div><button type="button" class="checkout-btn" id="checkout" ${cart.length?'':'disabled'}>Оформить доставку</button></footer></div>`:''}${tabBarHtml()}`;document.body.classList.toggle('has-tabbar',useTabs);ensureModalRoot();bind();bindVitrina();bindTabs();if(appTab==='cart'){document.querySelector('#drawer')?.classList.add('open');syncTgBackButton(true)}if(appTab==='profile'||appTab==='wishlist'){loadProfile().then(()=>{if(appTab==='profile'||appTab==='wishlist')renderSoftProfile()})};watchOverlays();syncTgMainButton();ensureViewportLock();
}
function renderSoftProfile(){
  const main=document.querySelector('main');
  if(!main)return;
  if(appTab==='profile') main.innerHTML=profileMenuHtml();
  if(appTab==='wishlist') main.innerHTML=wishlistPageHtml();
  const tabIco=document.querySelector('.tg-tab[data-tab="profile"] .tg-tab-ico');
  if(tabIco) tabIco.innerHTML=avatarHtml('tab-avatar');
  bindProfileActions();
  bindWishlistActions();
  bindProfileReferralCard();
}
function bindProfileReferralCard(){
  bindInviteLinkActions(document);
}
function bindTabs(){
  document.querySelectorAll('[data-tab]').forEach(btn=>btn.onclick=async()=>{
    const next=btn.dataset.tab||'home';
    if(next==='cart'){
      appTab='cart';
      document.querySelector('#drawer')?.classList.add('open');
      syncTgBackButton(true);
      document.querySelectorAll('.tg-tab').forEach(t=>t.classList.toggle('on',t.dataset.tab==='cart'));
      return;
    }
    appTab=next;
    if(next==='profile'||next==='wishlist'){
      await syncTelegramIdentity().catch(()=>{});
      await loadProfile().catch(()=>{});
    }
    document.querySelector('#drawer')?.classList.remove('open');
    syncTgBackButton(false);
    render();
  });
  bindProfileActions();
  bindWishlistActions();
  bindProfileReferralCard();
}
function bindWishlistActions(){
  document.querySelectorAll('[data-wish-remove]').forEach(b=>b.onclick=async()=>{
    try{
      await fetchJson(`${api}/public/profile/wishlist/${b.dataset.wishRemove}`,{method:'DELETE',headers:authHeaders()});
      await loadProfile();
      render();
    }catch(err){alert(err.message)}
  });
}
function bindProfileActions(){
  document.querySelectorAll('[data-profile-action]').forEach(btn=>btn.onclick=async()=>{
    const action=btn.dataset.profileAction;
    if(action==='support'){
      const bot=data?.telegram?.botUsername||'';
      if(bot) location.href=`https://t.me/${encodeURIComponent(bot)}`;
      else alert('Напишите в поддержку через Telegram-бот магазина');
      return;
    }
    if(action==='invite'){
      await openReferralFromProfile();
      return;
    }
    portalTab=action;
    await loadProfile().catch(()=>{});
    const panel=document.querySelector('#profile-panel');
    if(!panel){openProfile();return}
    panel.hidden=false;
    panel.innerHTML=`<div class="tg-panel-head"><button type="button" id="profile-panel-back">‹ Назад</button><b>${action==='orders'?'История заказов':action==='bonuses'?'Бонусы':'Адреса'}</b></div><div class="tg-panel-body">${portalBody()}</div>`;
    document.querySelector('.tg-menu')?.setAttribute('hidden','');
    document.querySelector('.tg-profile-hero')?.setAttribute('hidden','');
    panel.querySelector('#profile-panel-back').onclick=()=>{
      panel.hidden=true;panel.innerHTML='';
      document.querySelector('.tg-menu')?.removeAttribute('hidden');
      document.querySelector('.tg-profile-hero')?.removeAttribute('hidden');
    };
    panel.querySelectorAll('[data-repeat]').forEach(b=>b.onclick=async()=>{
      try{
        const pack=await fetchJson(`${api}/public/profile/repeat-order/${b.dataset.repeat}`,{headers:authHeaders()});
        for(const item of pack.items||[]){
          const product=data.products.find(p=>p.id===item.productId);if(!product)continue;
          const variant=item.variantId?(product.variants||[]).find(v=>v.id===item.variantId):null;
          cart.push({product,variant:variant||null,quantity:item.quantity});
        }
        appTab='cart';render();
      }catch(err){alert(err.message)}
    });
    panel.querySelector('#add-address')?.addEventListener('click',async()=>{
      const address=prompt('Адрес доставки');if(!address)return;
      await fetchJson(`${api}/public/profile/addresses`,{method:'POST',headers:{...authHeaders(),'content-type':'application/json'},body:JSON.stringify({address,label:'Дом'})});
      await loadProfile();btn.click();
    });
  });
}

function bindVitrina(){
  if(bindVitrina._timer){clearInterval(bindVitrina._timer);bindVitrina._timer=null}
  document.querySelectorAll('[data-vitrina-dot]').forEach(btn=>btn.onclick=()=>setVitrinaSlide(Number(btn.dataset.vitrinaDot||0)));
  document.querySelectorAll('[data-cat]').forEach(btn=>btn.onclick=()=>{flavorSelected=new Set();activeCategory=btn.dataset.cat||'';render();document.querySelector('.products')?.scrollIntoView({behavior:'smooth'})});
  document.querySelectorAll('[data-vitrina-catalog]').forEach(el=>el.addEventListener('click',e=>{e.preventDefault();document.querySelector('.products,#catalog')?.scrollIntoView({behavior:'smooth'})}));
  const banners=vitrinaList().filter(x=>x.placement==='carousel');
  if(banners.length>1){
    bindVitrina._timer=setInterval(()=>setVitrinaSlide(Number(window.__vitrinaSlide||0)+1),4200);
  }
}
function bindFlavorList(){
  document.querySelectorAll('[data-flavor-key]').forEach(btn=>{
    btn.onclick=()=>{
      if(btn.disabled) return;
      const key=btn.dataset.flavorKey;
      if(flavorSelected.has(key)) flavorSelected.delete(key);
      else flavorSelected.add(key);
      // cheap repaint of list state
      const section=btn.closest('.flavor-board');
      if(!section){render();return}
      section.querySelectorAll('[data-flavor-key]').forEach(el=>el.classList.toggle('is-on',flavorSelected.has(el.dataset.flavorKey)));
      const add=section.querySelector('#flavor-add-cart');
      if(add){
        const n=[...section.querySelectorAll('[data-flavor-key]')].filter(el=>flavorSelected.has(el.dataset.flavorKey)).length;
        add.disabled=!n;
        add.textContent=n?`В корзину · ${n}`:'Выберите вкус';
      }
    };
  });
  document.querySelector('#flavor-add-cart')?.addEventListener('click',()=>{
    if(!cartEnabled()) return;
    let added=0;
    document.querySelectorAll('[data-flavor-key].is-on').forEach(el=>{
      const product=data.products.find(p=>p.id===el.dataset.flavorProduct);
      if(!product) return;
      const variantId=el.dataset.flavorVariant||'';
      const variant=variantId?(product.variants||[]).find(v=>v.id===variantId)||null:((product.variants||[]).find(v=>v.active!==false)||null);
      const existing=cart.find(item=>item.product.id===product.id&&(item.variant?.id||'')===(variant?.id||''));
      if(existing) existing.quantity++;
      else cart.push({product,variant:variant||null,quantity:1});
      track('add_to_cart',{productId:product.id,variantId:variant?.id||null});
      added+=1;
    });
    if(!added) return;
    flavorSelected=new Set();
    render();
    document.querySelector('#drawer')?.classList.add('open');
    syncTgBackButton(true);
    syncTgMainButton();
  });
}
function bind(){bindFlavorList();document.querySelectorAll('[data-add]').forEach(b=>b.onclick=()=>{if(!cartEnabled())return;const product=data.products.find(p=>p.id===b.dataset.add);const variant=(product.variants||[]).find(v=>v.active!==false)||null;const existing=cart.find(item=>item.product.id===product.id&&(item.variant?.id||'')===(variant?.id||''));if(existing)existing.quantity++;else cart.push({product,variant:variant||null,quantity:1});track('add_to_cart',{productId:product.id,variantId:variant?.id||null});render();document.querySelector('#drawer')?.classList.add('open');syncTgBackButton(true);syncTgMainButton()});document.querySelector('#cart')?.addEventListener('click',()=>{document.querySelector('#drawer')?.classList.add('open');syncTgBackButton(true);syncTgMainButton()});document.querySelectorAll('[data-open-product]').forEach(card=>{const open=()=>openProduct(card.dataset.openProduct);card.addEventListener('click',e=>{if(e.target.closest('button,select,a,label,input'))return;open()});card.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open()}})});const profile=document.querySelector('#profile');if(profile)profile.onclick=openProfile;document.querySelector('#close')?.addEventListener('click',()=>{document.querySelector('#drawer')?.classList.remove('open');if(appTab==='cart')appTab='home';document.querySelectorAll('.tg-tab').forEach(t=>t.classList.toggle('on',t.dataset.tab===appTab));syncTgBackButton(false)});document.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{cart.splice(Number(b.dataset.remove),1);render();document.querySelector('#drawer')?.classList.add('open')});document.querySelectorAll('[data-inc]').forEach(b=>b.onclick=()=>{cart[Number(b.dataset.inc)].quantity++;render();document.querySelector('#drawer')?.classList.add('open')});document.querySelectorAll('[data-dec]').forEach(b=>b.onclick=()=>{const item=cart[Number(b.dataset.dec)];item.quantity--;if(item.quantity<=0)cart.splice(Number(b.dataset.dec),1);render();document.querySelector('#drawer')?.classList.add('open')});document.querySelectorAll('[data-category]').forEach(b=>b.onclick=()=>{flavorSelected=new Set();activeCategory=b.dataset.category||'';render();document.querySelector('.products')?.scrollIntoView({behavior:'smooth'})});const search=document.querySelector('#catalog-search');if(search)search.oninput=e=>{catalogQuery=e.target.value;render();const next=document.querySelector('#catalog-search');if(next){next.focus();next.setSelectionRange(catalogQuery.length,catalogQuery.length)}};document.querySelectorAll('[data-variant-for]').forEach(sel=>sel.onchange=()=>{const opt=sel.selectedOptions[0];const card=sel.closest('.product');const img=card?.querySelector('.product-cover');const price=card?.querySelector('.product-price');if(img&&opt?.dataset.img){if(img.tagName==='IMG')img.src=opt.dataset.img;else{const next=document.createElement('img');next.className='product-cover';next.src=opt.dataset.img;next.alt='';img.replaceWith(next)}}if(price&&opt?.dataset.price!=null)price.textContent=`${money(opt.dataset.price)} ₽`});document.querySelector('#checkout')?.addEventListener('click',openCheckout)}
function openCheckout(){track('checkout_started');syncTgBackButton(true);try{getTg()?.MainButton?.hide?.();document.body.classList.remove('has-tg-mainbutton')}catch{}const modal=document.querySelector('#modal');const delivery=checkoutConfig.deliveryMethods||[];const payment=checkoutConfig.paymentMethods||[];modal.innerHTML=`<div class="modal-backdrop"><form class="checkout-card" id="checkout-form"><div class="checkout-head"><div><small>ОФОРМЛЕНИЕ</small><h2>Ваш заказ</h2></div><button type="button" id="close-checkout">×</button></div><div class="checkout-grid"><section><label>Имя<input name="name" required minlength="2" autocomplete="name"></label><label>Телефон<input name="phone" required autocomplete="tel" placeholder="+7 999 000-00-00"></label><label>Email<input name="email" type="email" autocomplete="email"></label><h3>Доставка</h3>${delivery.map((method,i)=>`<label class="option"><input type="radio" name="deliveryMethod" value="${method.id}" ${i===0?'checked':''}><span><b>${esc(method.name)}</b><small>${esc(method.description||'')} · ${method.price?money(method.price)+' ₽':'бесплатно'}</small></span></label>`).join('')}<label id="address-field" hidden>Адрес<input name="address" placeholder="Улица, дом, квартира"></label><label id="city-field" hidden>Город<input name="city" value="Москва" placeholder="Город"></label><div id="pvz-field" hidden><h3>Пункт выдачи</h3><div id="pvz-map" class="pvz-map"></div><input type="hidden" name="pickupPointId" value=""><small id="pvz-selected"></small></div><h3>Оплата</h3>${payment.map((method,i)=>`<label class="option"><input type="radio" name="paymentMethod" value="${method.id}" ${i===0?'checked':''}><span><b>${esc(method.name)}</b></span></label>`).join('')}<label>Промокод<input name="promoCode" autocomplete="off" placeholder="WELCOME10"></label><label>Списать бонусы<input name="bonusRequested" type="number" min="0" step="1" value="0"></label><button type="button" id="apply-discount">Применить скидку</button><small id="discount-message"></small><label>Комментарий<textarea name="comment" rows="3"></textarea></label></section><aside class="order-summary">${cart.map(item=>`<p><span>${esc(item.product.name)}${item.variant?` · ${esc(item.variant.name||item.variant.sku)}`:''} × ${item.quantity}</span><b>${money(linePrice(item)*item.quantity)} ₽</b></p>`).join('')}<hr><p><span>Товары</span><b>${money(subtotal())} ₽</b></p><p id="delivery-total"><span>Доставка</span><b>0 ₽</b></p><p id="discount-total" hidden><span>Скидка</span><b>0 ₽</b></p><p class="grand"><span>Итого</span><b id="grand-total">${money(subtotal())} ₽</b></p><button class="submit-order">Создать заказ</button><div id="checkout-error"></div></aside></div></form></div>`;modal.querySelector('#close-checkout').onclick=()=>{modal.innerHTML='';syncTgBackButton(false);syncTgMainButton()};modal.querySelectorAll('[name=deliveryMethod]').forEach(r=>r.onchange=()=>updateDelivery(modal));modal.querySelector('#checkout-form').onsubmit=submitOrder;modal.querySelector('#apply-discount').onclick=()=>quoteCheckout(modal);modal.querySelector('[name=city]')?.addEventListener('change',()=>loadPvz(modal));updateDelivery(modal)}
async function loadPvz(modal){const selected=modal.querySelector('[name=deliveryMethod]:checked')?.value;const method=checkoutConfig.deliveryMethods.find(item=>item.id===selected);const box=modal.querySelector('#pvz-field');const map=modal.querySelector('#pvz-map');if(!method?.supportsPvz){box.hidden=true;return}box.hidden=false;const city=modal.querySelector('[name=city]')?.value||'Москва';try{const pack=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/delivery/points?city=${encodeURIComponent(city)}&carrier=apiship`);map.innerHTML=(pack.points||[]).map(p=>`<button type="button" class="pvz-pin" data-pvz="${esc(p.id)}" title="${esc(p.address)}"><b>${esc(p.carrierName)}</b><small>${esc(p.address)}</small></button>`).join('')||'<p class="muted">ПВЗ не найдены</p>';map.querySelectorAll('[data-pvz]').forEach(btn=>btn.onclick=()=>{modal.querySelector('[name=pickupPointId]').value=btn.dataset.pvz;modal.querySelector('#pvz-selected').textContent='Выбран: '+btn.title;map.querySelectorAll('.pvz-pin').forEach(x=>x.classList.remove('active'));btn.classList.add('active')})}catch(e){map.innerHTML=`<p class="muted">${esc(e.message)}</p>`}}
function utmFromUrl(){const p=new URLSearchParams(location.search);const fromQuery={source:p.get('utm_source')||'',medium:p.get('utm_medium')||'',campaign:p.get('utm_campaign')||'',content:p.get('utm_content')||'',term:p.get('utm_term')||''};const merged={source:fromQuery.source||startUtm?.source||'',medium:fromQuery.medium||startUtm?.medium||'',campaign:fromQuery.campaign||startUtm?.campaign||'',content:fromQuery.content||startUtm?.content||'',term:fromQuery.term||startUtm?.term||''};const storeKey=`gt_utm_${slug}`;if(Object.values(merged).some(Boolean)){storage.set(storeKey,JSON.stringify(merged));sessionStore.set('gt_utm_session',JSON.stringify(merged));return merged}const saved=storage.get(storeKey)||sessionStore.get('gt_utm_session');if(saved){try{return JSON.parse(saved)}catch{}}return merged}

let checkoutGeo={lat:null,lng:null,zoneLabel:null};
let checkoutQuoteTimer=null;
function checkoutLocation(modal){
  const form=modal.querySelector('#checkout-form');
  if(!form) return {};
  const fields=Object.fromEntries(new FormData(form));
  return {
    address:fields.address||'',
    city:fields.city||'',
    pickupPointId:fields.pickupPointId||'',
    lat:checkoutGeo.lat,
    lng:checkoutGeo.lng,
  };
}
async function refreshDeliveryQuote(modal,{silent=false}={}){
  const form=modal.querySelector('#checkout-form');
  if(!form) return null;
  const fields=Object.fromEntries(new FormData(form));
  const selected=fields.deliveryMethod;
  const method=(checkoutConfig.deliveryMethods||[]).find(item=>item.id===selected);
  const needsAddress=method?.requiresAddress??((method?.provider||selected)!=='pickup');
  const zoneHint=modal.querySelector('#delivery-zone-hint');
  if(!needsAddress){
    checkoutGeo={lat:null,lng:null,zoneLabel:null};
    if(zoneHint){zoneHint.hidden=true;zoneHint.textContent='';}
    modal.querySelector('#delivery-total b').textContent=`${money(method?.price||0)} ₽`;
    modal.querySelector('#grand-total').textContent=`${money(subtotal()+Number(method?.price||0))} ₽`;
    return null;
  }
  if(String(fields.address||'').trim().length<5){
    if(zoneHint){zoneHint.hidden=false;zoneHint.textContent='Укажите адрес — подставим цену района';}
    modal.querySelector('#delivery-total b').textContent=`${money(method?.price||0)} ₽`;
    modal.querySelector('#grand-total').textContent=`${money(subtotal()+Number(method?.price||0))} ₽`;
    return null;
  }
  try{
    const quote=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/checkout/quote`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({
        customer:{name:fields.name||'Клиент',phone:fields.phone||'+70000000000',email:fields.email||'',telegramId:telegramIdentity?.customer?.telegramId||''},
        deliveryMethod:fields.deliveryMethod,
        address:fields.address,
        city:fields.city,
        lat:checkoutGeo.lat,
        lng:checkoutGeo.lng,
        pickupPointId:fields.pickupPointId||'',
        promoCode:fields.promoCode,
        bonusRequested:Number(fields.bonusRequested||0),
        referralCode:currentReferralCode(),
        items:cart.map(item=>({productId:item.product.id,variantId:item.variant?.id||null,quantity:item.quantity}))
      })
    });
    if(quote.lat!=null&&quote.lng!=null){checkoutGeo.lat=quote.lat;checkoutGeo.lng=quote.lng}
    checkoutGeo.zoneLabel=quote.zoneLabel||null;
    modal.querySelector('#delivery-total b').textContent=`${money(quote.deliveryPrice||0)} ₽`;
    modal.querySelector('#grand-total').textContent=`${money(quote.total)} ₽`;
    modal.querySelector('#discount-total').hidden=quote.totalDiscount<=0;
    modal.querySelector('#discount-total b').textContent=`−${money(quote.totalDiscount)} ₽`;
    if(zoneHint){
      if(quote.courierZoneId&&quote.zoneLabel){
        zoneHint.hidden=false;
        zoneHint.textContent=`Район «${quote.zoneLabel}» · доставка ${money(quote.deliveryPrice||0)} ₽`;
      }else{
        zoneHint.hidden=false;
        zoneHint.textContent='Адрес вне нарисованных районов · базовая цена курьера';
      }
    }
    return quote;
  }catch(err){
    if(!silent&&zoneHint){zoneHint.hidden=false;zoneHint.textContent=err.message||'Не удалось рассчитать доставку';}
    return null;
  }
}
function scheduleDeliveryQuote(modal){
  clearTimeout(checkoutQuoteTimer);
  checkoutQuoteTimer=setTimeout(()=>refreshDeliveryQuote(modal,{silent:true}),450);
}

function updateDelivery(modal){const selected=modal.querySelector('[name=deliveryMethod]:checked')?.value;const method=checkoutConfig.deliveryMethods.find(item=>item.id===selected);const needsAddress=method?.requiresAddress??((method?.provider||selected)!=='pickup');const needsPvz=Boolean(method?.supportsPvz);modal.querySelector('#address-field').hidden=!needsAddress||needsPvz;modal.querySelector('[name=address]').required=needsAddress&&!needsPvz;const city=modal.querySelector('#city-field');if(city)city.hidden=!needsAddress&&!needsPvz;if(needsPvz)loadPvz(modal);else{const box=modal.querySelector('#pvz-field');if(box)box.hidden=true}refreshDeliveryQuote(modal,{silent:true})}

async function quoteCheckout(modal){const form=modal.querySelector('#checkout-form');const fields=Object.fromEntries(new FormData(form));const message=modal.querySelector('#discount-message');try{const quote=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/checkout/quote`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customer:{name:fields.name,phone:fields.phone,email:fields.email,telegramId:telegramIdentity?.customer?.telegramId||''},deliveryMethod:fields.deliveryMethod,address:fields.address,city:fields.city,lat:checkoutGeo.lat,lng:checkoutGeo.lng,pickupPointId:fields.pickupPointId||'',promoCode:fields.promoCode,bonusRequested:Number(fields.bonusRequested||0),referralCode:currentReferralCode(),items:cart.map(item=>({productId:item.product.id,variantId:item.variant?.id||null,quantity:item.quantity}))})});if(quote.lat!=null&&quote.lng!=null){checkoutGeo.lat=quote.lat;checkoutGeo.lng=quote.lng}checkoutGeo.zoneLabel=quote.zoneLabel||null;modal.querySelector('#delivery-total b').textContent=`${money(quote.deliveryPrice||0)} ₽`;const zoneHint=modal.querySelector('#delivery-zone-hint');if(zoneHint){if(quote.courierZoneId&&quote.zoneLabel){zoneHint.hidden=false;zoneHint.textContent=`Район «${quote.zoneLabel}» · доставка ${money(quote.deliveryPrice||0)} ₽`}else if(String(fields.address||'').trim()){zoneHint.hidden=false;zoneHint.textContent='Адрес вне нарисованных районов · базовая цена курьера'}}modal.querySelector('#discount-total').hidden=quote.totalDiscount<=0;modal.querySelector('#discount-total b').textContent=`−${money(quote.totalDiscount)} ₽`;modal.querySelector('#grand-total').textContent=`${money(quote.total)} ₽`;const parts=[];if(quote.promoDiscount>0)parts.push(`Промокод: ${money(quote.promoDiscount)} ₽`);if(quote.referralDiscount>0)parts.push(`Реферал: ${money(quote.referralDiscount)} ₽`);if(quote.bonusUsed>0)parts.push(`бонусы: ${money(quote.bonusUsed)} ₽`);message.textContent=parts.length?parts.join(' · '):'Скидка не применена';message.dataset.ok='1'}catch(e){message.textContent=e.message;message.dataset.ok='0'}}

function inviteShareBlock(invite){if(!invite?.enabled||!invite.code)return'';const link=referralInviteLink(invite);if(!link)return'';const friendReward=referralRewardLabel(invite.refereeReward);const yourReward=referralRewardLabel(invite.referrerReward);const shareText=`Скидка ${friendReward} на первый заказ в ${data?.shop?.name||'магазине'}`;return`<div class="invite-share"><p><b>Промокод за рекомендацию</b></p><p>Вам — ${esc(yourReward)}, другу — ${esc(friendReward)} на первый заказ.</p><div class="invite-code-wrap"><small>Ваш промокод</small><code class="invite-code">${esc(invite.code)}</code></div><a class="invite-link-a invite-link" href="${esc(link)}" target="_blank" rel="noopener" data-invite-open="${esc(link)}">${esc(link)}</a><div class="invite-actions ref-sheet-actions"><button type="button" class="ref-sheet-btn" data-invite-share="${esc(link)}" data-invite-share-text="${esc(shareText)}">Поделиться</button><button type="button" class="ref-sheet-btn ghost" data-invite-copy="${esc(link)}">Скопировать ссылку</button></div></div>`}
function inviteCacheKey(){return `gt_invite_${slug}`}
function cachedInvite(){
  const mem=customerProfile?.referral||telegramIdentity?.referral||null;
  if(mem?.code) return mem;
  try{
    const raw=storage.get(inviteCacheKey());
    if(!raw) return null;
    const parsed=typeof raw==='string'?JSON.parse(raw):raw;
    return parsed?.code?parsed:null;
  }catch{return null}
}
function rememberInvite(invite){
  if(!invite?.code) return invite;
  if(customerProfile) customerProfile.referral=invite;
  else customerProfile={referral:invite};
  if(telegramIdentity) telegramIdentity.referral=invite;
  if(invite.enabled){
    data.referralProgramEnabled=true;
    if(data.shop?.settings) data.shop.settings.referralProgram={...(data.shop.settings.referralProgram||{}),enabled:true};
  }
  try{storage.set(inviteCacheKey(),JSON.stringify(invite))}catch{}
  return invite;
}
let inviteLoadPromise=null;
let authPromise=null;
let authAt=0;
async function loadInvite({force=false,skipAuth=false}={}){
  const hit=cachedInvite();
  if(hit?.code && !force) return hit;
  if(inviteLoadPromise) return inviteLoadPromise;
  const run=async()=>{
    if(!skipAuth) await authenticateTelegram().catch(()=>{});
    const token=telegramIdentity?.token||storage.get(`gt_customer_${slug}`);
    if(!token){
      const local=telegramIdentity?.referral||cachedInvite();
      return local?.code?local:null;
    }
    try{
      const invite=await fetchJson(`${api}/public/profile/referral`,{method:'POST',headers:{...authHeaders(),'content-type':'application/json'},body:'{}'},8000);
      return rememberInvite(invite);
    }catch(err){
      console.warn(err);
      try{
        const invite=await fetchJson(`${api}/public/profile/referral`,{headers:authHeaders()},6000);
        return rememberInvite(invite);
      }catch{
        return cachedInvite()||telegramIdentity?.referral||customerProfile?.referral||null;
      }
    }
  };
  inviteLoadPromise=run().finally(()=>{inviteLoadPromise=null});
  return inviteLoadPromise;
}
function closeReferralModal(){
  referralFlowSeq+=1;
  referralFlowLock=false;
  const modal=document.querySelector('#modal');
  if(modal) modal.innerHTML='';
  try{unlockBodyScroll()}catch{}
  syncTgBackButton(false);
}
function showReferralPrivacy(){
  const modal=document.querySelector('#modal');
  modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-privacy-backdrop"><div class="ref-sheet"><button type="button" class="ref-sheet-close" id="ref-privacy-close">×</button><div class="ref-sheet-ico" aria-hidden="true">ⓘ</div><h2>Политика</h2><p class="ref-sheet-text">Мы используем ваш Telegram ID только для персональной реферальной ссылки, начисления бонусов и связи заказа с аккаунтом. Данные не передаются третьим лицам вне сервиса магазина.</p><button type="button" class="ref-sheet-btn" id="ref-privacy-back">Понятно</button></div></div>`;
  const close=()=>{
    const invite=customerProfile?.referral;
    if(invite?.code) showReferralLinkSheet(invite);
    else openReferralConsent();
  };
  modal.querySelector('#ref-privacy-close').onclick=close;
  modal.querySelector('#ref-privacy-back').onclick=close;
  modal.querySelector('#ref-privacy-backdrop').onclick=e=>{if(e.target.id==='ref-privacy-backdrop')close()};
}
function openReferralConsent(){
  if(document.querySelector("#ref-consent-backdrop")) return;
  const shopName=data?.shop?.name||'магазине';
  const yours=referralRewardLabel(customerProfile?.referral?.referrerReward||{type:'percent',value:10});
  const friend=referralRewardLabel(customerProfile?.referral?.refereeReward||{type:'percent',value:10});
  const modal=ensureModalRoot();
  lockBodyScroll();
  modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-consent-backdrop"><div class="ref-sheet ref-sheet-modal">
    <button type="button" class="ref-sheet-close" id="ref-consent-close">×</button>
    <div class="ref-sheet-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l2.1-2.1a3 3 0 1 1 4.2 4.2l-1.4 1.4a1 1 0 1 1-1.4-1.4l1.4-1.4a1 1 0 1 0-1.4-1.4l-2.1 2.1a1 1 0 0 1-1.4 0Zm2.8-2.8a1 1 0 0 1 0 1.4l-2.1 2.1a3 3 0 1 1-4.2-4.2l1.4-1.4a1 1 0 0 1 1.4 1.4L7.5 11a1 1 0 1 0 1.4 1.4l2.1-2.1a1 1 0 0 1 1.4 0Z"/></svg></div>
    <h2>Промокод за рекомендацию</h2>
    <p class="ref-sheet-text">Вам — ${esc(yours)}, как друг сделает первый заказ в ${esc(shopName)}. А другу — ${esc(friend)} на первую покупку.</p>
    <label class="ref-consent"><input type="checkbox" id="ref-policy-check" class="ref-consent-input"><span class="ref-consent-box" aria-hidden="true"></span><span class="ref-consent-text">Соглашаюсь с <button type="button" class="ref-policy-link" id="ref-policy-link">политикой</button> обработки персональных данных</span></label>
    <p class="ref-sheet-error" id="ref-consent-error" hidden></p>
    <button type="button" class="ref-sheet-btn" id="ref-continue" disabled>Продолжить</button>
  </div></div>`;
  const check=modal.querySelector('#ref-policy-check');
  const cont=modal.querySelector('#ref-continue');
  const err=modal.querySelector('#ref-consent-error');
  check.onchange=()=>{cont.disabled=!check.checked;err.hidden=true};
  modal.querySelector('#ref-consent-close').onclick=closeReferralModal;
  modal.querySelector('#ref-consent-backdrop').onclick=e=>{if(e.target.id==='ref-consent-backdrop')closeReferralModal()};
  modal.querySelector('#ref-policy-link').onclick=e=>{e.preventDefault();showReferralPrivacy()};
  cont.onclick=async()=>{
    if(!check.checked){err.textContent='Нужно согласие с политикой';err.hidden=false;return}
    setReferralAccepted();
    const ready=cachedInvite();
    if(ready?.code){showReferralLinkSheet(ready);return}
    cont.disabled=true;cont.textContent='Формируем ссылку…';
    const invite=await loadInvite({force:true});
    if(!invite?.enabled||!invite.code){
      err.textContent=initDataRaw()?'Не удалось сформировать ссылку. Попробуйте ещё раз.':'Откройте магазин через Telegram-бот, чтобы получить ссылку.';
      err.hidden=false;
      cont.disabled=false;cont.textContent='Продолжить';
      return;
    }
    showReferralLinkSheet(invite);
  };
  syncTgBackButton(true);
}
function showReferralLinkSheet(invite){
  if(!invite?.code) return;
  // One stable sheet — ignore duplicate paints of the same dialog
  const existing=document.querySelector('#ref-link-backdrop');
  if(existing){
    patchReferralStats(invite);
    return;
  }
  const accepted=referralAccepted();
  const modal=ensureModalRoot();
  modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-link-backdrop"><div class="ref-sheet ref-sheet-modal" role="dialog" aria-modal="true" aria-labelledby="ref-sheet-title">
    <button type="button" class="ref-sheet-close" id="ref-link-close" aria-label="Закрыть">×</button>
    <div class="ref-sheet-ico" aria-hidden="true"><svg viewBox="0 0 24 24" width="28" height="28"><path fill="currentColor" d="M10.6 13.4a1 1 0 0 1 0-1.4l2.1-2.1a3 3 0 1 1 4.2 4.2l-1.4 1.4a1 1 0 1 1-1.4-1.4l1.4-1.4a1 1 0 1 0-1.4-1.4l-2.1 2.1a1 1 0 0 1-1.4 0Zm2.8-2.8a1 1 0 0 1 0 1.4l-2.1 2.1a3 3 0 1 1-4.2-4.2l1.4-1.4a1 1 0 0 1 1.4 1.4L7.5 11a1 1 0 1 0 1.4 1.4l2.1-2.1a1 1 0 0 1 1.4 0Z"/></svg></div>
    <h2 id="ref-sheet-title">Промокод за рекомендацию</h2>
    ${inviteLinkBlockHtml(invite)}
    ${accepted?'':`<label class="ref-consent"><input type="checkbox" id="ref-policy-check" class="ref-consent-input"><span class="ref-consent-box" aria-hidden="true"></span><span class="ref-consent-text">Соглашаюсь с <button type="button" class="ref-policy-link" id="ref-policy-link">политикой</button> обработки персональных данных</span></label>
    <p class="ref-sheet-error" id="ref-consent-error" hidden></p>`}
  </div></div>`;
  lockBodyScroll();
  modal.querySelector('#ref-link-close').onclick=closeReferralModal;
  modal.querySelector('#ref-link-backdrop').onclick=e=>{if(e.target.id==='ref-link-backdrop')closeReferralModal()};
  const check=modal.querySelector('#ref-policy-check');
  const gate=()=>{
    if(referralAccepted()) return true;
    if(check?.checked){setReferralAccepted();return true}
    const err=modal.querySelector('#ref-consent-error');
    if(err){err.textContent='Отметьте согласие с политикой';err.hidden=false}
    return false;
  };
  modal.querySelectorAll('[data-invite-copy]').forEach(btn=>{
    btn.onclick=async()=>{
      if(!gate()) return;
      await copyText(btn.dataset.inviteCopy||'',btn);
    };
  });
  modal.querySelectorAll('[data-invite-share]').forEach(btn=>{
    btn.onclick=()=>{
      if(!gate()) return;
      shareInviteInTelegram(btn.dataset.inviteShare||'',btn.dataset.inviteShareText||'');
    };
  });
  modal.querySelector('#ref-policy-link')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();showReferralPrivacy()});
  syncTgBackButton(true);
}
function showInviteInProfilePanel(invite){
  const panel=document.querySelector('#profile-panel');
  if(!panel)return;
  panel.hidden=false;
  panel.innerHTML=`<div class="tg-panel-head"><button type="button" id="profile-panel-back">‹ Назад</button><b>Промокод за рекомендацию</b></div>
    <div class="tg-panel-body tg-invite-panel">${inviteLinkBlockHtml(invite)}</div>`;
  document.querySelector('.tg-menu')?.setAttribute('hidden','');
  document.querySelector('.tg-profile-hero')?.setAttribute('hidden','');
  panel.querySelector('#profile-panel-back').onclick=()=>{
    panel.hidden=true;panel.innerHTML='';
    document.querySelector('.tg-menu')?.removeAttribute('hidden');
    document.querySelector('.tg-profile-hero')?.removeAttribute('hidden');
  };
  bindInviteLinkActions(panel);
}
function patchReferralStats(invite){
  const root=document.querySelector('#ref-link-backdrop .ref-stats');
  if(!root||!invite?.stats) return false;
  const st=invite.stats||{};
  const vals=[
    Number(st.clicks??st.invited??0),
    Number(st.invited??0),
    Number(st.orders??0),
  ];
  const nodes=root.querySelectorAll('.ref-stat b');
  nodes.forEach((el,i)=>{if(vals[i]!=null) el.textContent=String(vals[i])});
  return true;
}
let referralFlowLock=false;
let referralFlowSeq=0;
async function openReferralFromProfile(){
  await openReferralFlow();
}

async function openReferralFlow(){
  if(!referralEnabled()){alert('Реферальная программа пока выключена');return}
  // Already open — do not remount / re-animate
  if(document.querySelector('#ref-link-backdrop, #ref-consent-backdrop, #ref-loading-backdrop')) return;
  if(referralFlowLock) return;
  referralFlowLock=true;
  const seq=++referralFlowSeq;
  try{
    const modal=ensureModalRoot();
    if(!modal){alert('Окно недоступно');return}
    lockBodyScroll();
    syncTgBackButton(true);

    // Consent first — one paint, prefetch in background without UI refresh
    if(!referralAccepted()){
      openReferralConsent();
      loadInvite({force:Boolean(!cachedInvite()?.code),skipAuth:false}).catch(()=>{});
      return;
    }

    const cached=cachedInvite();
    if(cached?.code){
      showReferralLinkSheet(cached);
      // Refresh stats quietly — never remount the sheet
      loadInvite({force:true,skipAuth:false}).then((fresh)=>{
        if(seq!==referralFlowSeq) return;
        if(fresh?.code) patchReferralStats(fresh);
      }).catch(()=>{});
      return;
    }

    modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-loading-backdrop"><div class="ref-sheet ref-sheet-modal"><p class="ref-sheet-text">Формируем ваш промокод…</p></div></div>`;
    const invite=await loadInvite({force:true});
    if(seq!==referralFlowSeq) return;
    if(!document.querySelector('#ref-loading-backdrop')) return;
    if(!invite?.enabled){
      modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-link-backdrop"><div class="ref-sheet ref-sheet-modal"><button type="button" class="ref-sheet-close" id="ref-link-close">×</button><h2>Промокод</h2><p class="ref-sheet-error">Реферальная программа выключена</p><button type="button" class="ref-sheet-btn" id="ref-link-close-2">Закрыть</button></div></div>`;
      modal.querySelector('#ref-link-close').onclick=closeReferralModal;
      modal.querySelector('#ref-link-close-2').onclick=closeReferralModal;
      return;
    }
    if(!invite.code){
      const bot=esc(invite?.botUsername||data?.telegram?.botUsername||'GStoretabak_bot');
      const why=esc(invite?.message||(!initDataRaw()?'Откройте магазин из Telegram-бота — нужна авторизация Mini App.':'Не удалось создать код. Нажмите «Повторить».'));
      modal.innerHTML=`<div class="modal-backdrop ref-sheet-backdrop" id="ref-link-backdrop"><div class="ref-sheet ref-sheet-modal"><button type="button" class="ref-sheet-close" id="ref-link-close">×</button><h2>Промокод за рекомендацию</h2><p class="ref-sheet-error">${why}</p><p class="ref-sheet-text">Бот: @${bot}</p><button type="button" class="ref-sheet-btn" id="ref-retry">Повторить</button></div></div>`;
      modal.querySelector('#ref-link-close').onclick=closeReferralModal;
      modal.querySelector('#ref-retry').onclick=async()=>{try{localStorage.removeItem(`gt_customer_${slug}`);localStorage.removeItem(inviteCacheKey())}catch{};telegramIdentity=null;authAt=0;referralFlowLock=false;await openReferralFlow()};
      return;
    }
    showReferralLinkSheet(invite);
  }finally{
    referralFlowLock=false;
  }
}
async function showOrderSuccess(order){const invite=await loadInvite();const share=inviteShareBlock(invite);const pay=order.checkoutUrl?`<p>Перенаправляем на оплату…</p><a class="submit-order" href="${esc(order.checkoutUrl)}">Оплатить сейчас</a>`:`<p>Мы свяжемся с вами по телефону ${esc(order.customer.phone)}.</p>`;document.querySelector('#modal').innerHTML=`<div class="modal-backdrop"><div class="success-card"><div class="success-mark">✓</div><h2>Заказ №${esc(order.number)} создан</h2><p>Сумма: <b>${money(order.total)} ₽</b></p>${pay}${share}<button id="finish-order">Вернуться в магазин</button></div></div>`;bindInviteLinkActions(document.querySelector('#modal')||document);document.querySelector('#finish-order').onclick=()=>{render();getTg()?.close?.()};if(order.checkoutUrl)setTimeout(()=>{location.href=order.checkoutUrl},600)}
async function submitOrder(event){event.preventDefault();const form=event.currentTarget;const button=form.querySelector('.submit-order');const error=form.querySelector('#checkout-error');button.disabled=true;error.textContent='';try{const fields=Object.fromEntries(new FormData(form));const order=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/orders`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({customer:{name:fields.name,phone:fields.phone,email:fields.email,telegramId:telegramIdentity?.customer?.telegramId||''},deliveryMethod:fields.deliveryMethod,paymentMethod:fields.paymentMethod,address:fields.address,city:fields.city,lat:checkoutGeo.lat,lng:checkoutGeo.lng,pickupPointId:fields.pickupPointId||'',promoCode:fields.promoCode,bonusRequested:Number(fields.bonusRequested||0),comment:fields.comment,source:getTg()?.initData?'telegram':(new URLSearchParams(location.search).get('utm_source')||'web'),utm:utmFromUrl(),referralCode:currentReferralCode(),returnUrl:location.href.split('#')[0],items:cart.map(item=>({productId:item.product.id,variantId:item.variant?.id||null,quantity:item.quantity}))})});cart=[];await showOrderSuccess(order)}catch(e){error.textContent=e.message;button.disabled=false}}

async function authenticateTelegram({force=false}={}){
  refreshTgFlags();
  const initData=initDataRaw();
  if(!initData)return telegramIdentity;
  const token=telegramIdentity?.token||storage.get(`gt_customer_${slug}`);
  if(!force && telegramIdentity?.token && token && Date.now()-authAt<120000){
    return telegramIdentity;
  }
  if(authPromise) return authPromise;
  authPromise=(async()=>{
    try{
      const result=await fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/telegram/auth`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({initData})},9000);
      telegramIdentity=result;
      authAt=Date.now();
      storage.set(`gt_customer_${slug}`,result.token);
      if(result?.referral?.enabled&&result.referral.code){
        rememberInvite(result.referral);
      }
      return result;
    }catch(error){console.warn(error);return telegramIdentity}
    finally{authPromise=null}
  })();
  return authPromise;
}
async function syncTelegramIdentity(forceRender=false){
  const before=customerName();
  const beforePhoto=customerPhoto();
  const identity=await authenticateTelegram();
  const changed=Boolean(identity)||before!==customerName()||beforePhoto!==customerPhoto();
  if(identity?.referral?.code) rememberInvite(identity.referral);
  else if(identity?.token || storage.get(`gt_customer_${slug}`)) loadInvite({force:false,skipAuth:true}).catch(()=>{});
  if(identity&&(appTab==='profile'||appTab==='wishlist')){
    await loadProfile().catch(()=>{});
  }
  if(changed||forceRender){
    if(appTab==='profile'||appTab==='wishlist') renderSoftProfile();
    else if(document.querySelector('.tg-tabbar')){
      const tabIco=document.querySelector('.tg-tab[data-tab="profile"] .tg-tab-ico');
      if(tabIco) tabIco.innerHTML=avatarHtml('tab-avatar');
    }else if(identity) render();
  }
  return identity;
}
async function loadProfile(){const token=telegramIdentity?.token||storage.get(`gt_customer_${slug}`);if(!token)return null;try{const headers=authHeaders();const [profile,orders,bonuses,wishlist,addresses,referral]=await Promise.all([
    fetchJson(`${api}/public/profile`,{headers}),
    fetchJson(`${api}/public/profile/orders`,{headers}),
    fetchJson(`${api}/public/profile/bonuses`,{headers}),
    fetchJson(`${api}/public/profile/wishlist`,{headers}),
    fetchJson(`${api}/public/profile/addresses`,{headers}),
    fetchJson(`${api}/public/profile/referral`,{headers}).catch(()=>null),
  ]);
  customerProfile={profile,orders,bonuses,wishlist,addresses,referral};
  if(referral?.code) rememberInvite(referral);
  else if(referral?.enabled){
    data.referralProgramEnabled=true;
    if(data.shop?.settings) data.shop.settings.referralProgram={...(data.shop.settings.referralProgram||{}),enabled:true};
  }
  return customerProfile}catch{try{customerProfile=await fetchJson(`${api}/public/customer/me`,{headers:authHeaders()});return customerProfile}catch{return null}}}
function portalBody(){const p=customerProfile?.profile||customerProfile?.customer||{};const orders=customerProfile?.orders||[];const bonuses=customerProfile?.bonuses||{balance:0,entries:[]};const wishlist=customerProfile?.wishlist||[];const addresses=customerProfile?.addresses||[];if(portalTab==='bonuses')return`<div class="loyalty-card"><small>Баланс</small><strong>${money(bonuses.balance||0)}</strong></div><div class="profile-orders">${(bonuses.entries||[]).slice(0,20).map(e=>`<article><b>${e.amount>0?'+':''}${money(e.amount)}</b><small>${esc(e.reason||e.type||'')} · ${new Date(e.createdAt).toLocaleString('ru-RU')}</small></article>`).join('')||'<p>История бонусов пуста.</p>'}</div>`;if(portalTab==='wishlist')return`<div class="profile-orders">${wishlist.length?wishlist.map(w=>`<article><b>${esc(w.product?.name||w.productId)}</b><span>${money(w.product?.price||0)} ₽</span><button data-wish-remove="${esc(w.productId)}">Убрать</button></article>`).join(''):'<p>Список желаний пуст.</p>'}</div>`;if(portalTab==='addresses')return`<div class="profile-orders">${addresses.length?addresses.map(a=>`<article><b>${esc(a.label||'Адрес')}${a.isDefault?' · основной':''}</b><span>${esc(a.address)}</span></article>`).join(''):'<p>Адресов пока нет.</p>'}<button id="add-address">+ Адрес</button></div>`;return`<div class="profile-orders">${orders.length?orders.map(o=>`<article><b>Заказ №${esc(o.number)}</b><span>${esc(o.status)} · ${money(o.total)} ₽</span><small>${new Date(o.createdAt).toLocaleString('ru-RU')}</small><button data-repeat="${esc(o.id)}">Повторить</button></article>`).join(''):'<p>Заказов пока нет.</p>'}</div>`}
async function openProfile(){await loadProfile();const modal=document.querySelector('#modal');const p=customerProfile?.profile||{};const inviteOn=Boolean(customerProfile?.referral?.enabled||data?.referralProgramEnabled);const tabs=[['orders','Заказы'],['wishlist','Избранное'],['addresses','Адреса'],['bonuses','Бонусы']];if(inviteOn)tabs.push(['invite','Промокод']);const draw=()=>{if(portalTab==='invite'){openReferralFlow();return}modal.innerHTML=`<div class="modal-backdrop"><div class="success-card profile-card wide"><button id="close-profile">×</button><h2>Личный кабинет</h2><p>${esc(customerName())} · бонусы ${money(p.bonusBalance||customerProfile?.bonuses?.balance||0)}</p><div class="portal-tabs">${tabs.map(([id,label])=>`<button data-portal-tab="${id}" class="${portalTab===id?'active':''}">${label}</button>`).join('')}</div><div id="portal-body">${portalBody()}</div></div></div>`;modal.querySelector('#close-profile').onclick=()=>modal.innerHTML='';modal.querySelectorAll('[data-portal-tab]').forEach(b=>b.onclick=()=>{portalTab=b.dataset.portalTab;if(portalTab==='invite'){openReferralFlow();return}draw()});modal.querySelectorAll('[data-repeat]').forEach(b=>b.onclick=async()=>{try{const pack=await fetchJson(`${api}/public/profile/repeat-order/${b.dataset.repeat}`,{headers:authHeaders()});for(const item of pack.items||[]){const product=data.products.find(p=>p.id===item.productId);if(!product)continue;const variant=item.variantId?(product.variants||[]).find(v=>v.id===item.variantId):null;cart.push({product,variant:variant||null,quantity:item.quantity});}modal.innerHTML='';render();document.querySelector('#drawer')?.classList.add('open')}catch(err){alert(err.message)}});modal.querySelectorAll('[data-wish-remove]').forEach(b=>b.onclick=async()=>{await fetchJson(`${api}/public/profile/wishlist/${b.dataset.wishRemove}`,{method:'DELETE',headers:authHeaders()});await loadProfile();draw()});modal.querySelector('#add-address')?.addEventListener('click',async()=>{const address=prompt('Адрес доставки');if(!address)return;await fetchJson(`${api}/public/profile/addresses`,{method:'POST',headers:{...authHeaders(),'content-type':'application/json'},body:JSON.stringify({address,label:'Дом'})});await loadProfile();draw()})};draw()}

(async()=>{
  refreshTgFlags();
  getTg()?.ready?.();
  try{getTg()?.expand?.()}catch{}
  // Never block first paint on bot resolve — Telegram WebView otherwise stays on "Загрузка…".
  if(!slug){
    try{
      const bound=await withTimeout(ensureShopBoundToBot(),1800,'resolve-timeout');
      if(bound===null) return; // navigating away
    }catch{}
  }else{
    ensureShopBoundToBot().catch(()=>{});
  }
  if(!slug){
    app.innerHTML=`<div class="error"><h1>Магазин не указан</h1><p>Откройте витрину из меню бота вашего магазина.</p><small>API: ${esc(api)}</small><p style="margin-top:1rem"><button id="retry-sf" style="padding:.7rem 1rem;border:0;border-radius:12px;background:#171717;color:#fff">Повторить</button></p></div>`;
    document.querySelector('#retry-sf')?.addEventListener('click',()=>location.reload());
    return;
  }
  storage.set('gt_shop',slug);
  try{if(!['4173','4174','5173','3000','4000'].includes(String(location.port||''))) localStorage.removeItem('gt_api')}catch{}
  try{
    await loadStorefrontData({soft:false});
    checkoutConfig={deliveryMethods:[],paymentMethods:[]};
    fetchJson(`${api}/public/storefronts/${encodeURIComponent(slug)}/checkout-config?_=${Date.now()}`,{cache:'no-store'})
      .then((config)=>{checkoutConfig=config||{deliveryMethods:[],paymentMethods:[]}})
      .catch(()=>{});
    track('visit');
    preloadVisibleCatalogImages();
    render();
    bindStorefrontLiveSync();
    if(deep.productId||deep.categoryId){requestAnimationFrame(()=>document.querySelector('.products')?.scrollIntoView({behavior:'smooth'}))}
    // Identity must never block vitrina paint.
    Promise.resolve().then(()=>syncTelegramIdentity(true)).catch(()=>{});
    window.addEventListener('telegram-web-app-ready',()=>{syncTelegramIdentity(true).catch(()=>{})});
    let tries=0;
    const poll=setInterval(()=>{
      tries+=1;
      refreshTgFlags();
      if(initDataRaw()||tgWebUser()||tries>=20){
        clearInterval(poll);
        if(initDataRaw()||tgWebUser()) syncTelegramIdentity(true).catch(()=>{});
      }
    },250);
  }catch(e){
    const msg=e.name==='AbortError'?'Сервер не ответил вовремя':e.message;
    app.innerHTML=`<div class="error"><h1>Витрина недоступна</h1><p>${esc(msg)}</p><small>Магазин: <b>${esc(slug)}</b><br>API: ${esc(api)}</small><p style="margin-top:1rem;display:grid;gap:8px"><button id="retry-sf" style="padding:.7rem 1rem;border:0;border-radius:12px;background:#171717;color:#fff">Повторить</button></p></div>`;
    document.querySelector('#retry-sf')?.addEventListener('click',()=>location.reload());
  }
})();
