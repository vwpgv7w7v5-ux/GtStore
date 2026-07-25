'use strict';
(() => {
  const state = { open:false, commands:[], active:0 };
  const $ = (s, r=document) => r.querySelector(s);
  const $$ = (s, r=document) => [...r.querySelectorAll(s)];
  const safe = value => String(value ?? '').replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
  function toast(message, tone='info') {
    let stack = $('.vision-toast-stack');
    if (!stack) { stack=document.createElement('div'); stack.className='vision-toast-stack'; document.body.append(stack); }
    const node=document.createElement('div'); node.className='vision-toast'; node.dataset.tone=tone; node.textContent=message; stack.append(node);
    setTimeout(()=>node.remove(), 3600);
  }
  window.visionToast = toast;
  function tabCommands() {
    return $$('.nav [data-tab]').map(button => ({
      title:button.textContent.trim(), hint:'Перейти в раздел', keywords:button.dataset.tab,
      run:()=>button.click()
    }));
  }
  function actionCommands() {
    const entries = [
      ['Создать товар','Открыть каталог и форму товара','catalog',()=>{ $('[data-tab="catalog"]')?.click(); setTimeout(()=>$('#addProduct')?.click(),120); }],
      ['Создать заказ','Новый ручной заказ','orders',()=>{ $('[data-tab="orders"]')?.click(); setTimeout(()=>$('#addOrder')?.click(),120); }],
      ['Импортировать Excel','Каталог из двух листов','excel import',()=>{ $('[data-tab="catalog"]')?.click(); setTimeout(()=>$('#excelInput')?.click(),120); }],
      ['Настроить витрину','Баннеры, плитки и Mini App','storefront',()=> $('[data-tab="storefront"]')?.click()],
      ['Открыть помощь','База знаний и поддержка','help support',()=> $('[data-tab="help"]')?.click()],
    ];
    return entries.map(([title,hint,keywords,run])=>({title,hint,keywords,run}));
  }
  function buildCommandPalette() {
    const root=document.createElement('div'); root.className='vision-command'; root.innerHTML=`<div class="vision-command-box"><input class="vision-command-input" placeholder="Поиск разделов и действий…" autocomplete="off"><div class="vision-command-results"></div></div>`; document.body.append(root);
    const input=$('.vision-command-input',root), results=$('.vision-command-results',root);
    const render=()=>{
      const q=input.value.toLowerCase().trim(); state.commands=[...actionCommands(),...tabCommands()].filter(x=>!q||`${x.title} ${x.hint} ${x.keywords||''}`.toLowerCase().includes(q)); state.active=Math.min(state.active,state.commands.length-1); results.innerHTML=state.commands.map((x,i)=>`<button class="vision-command-item ${i===state.active?'active':''}" data-i="${i}"><span>${safe(x.title)}</span><small>${safe(x.hint)}</small></button>`).join('')||'<div class="vision-command-item">Ничего не найдено</div>';
      $$('[data-i]',results).forEach(btn=>btn.onclick=()=>execute(Number(btn.dataset.i)));
    };
    const execute=i=>{ const cmd=state.commands[i]; if(!cmd)return; close(); cmd.run(); };
    const open=()=>{root.classList.add('open');state.open=true;input.value='';state.active=0;render();setTimeout(()=>input.focus(),0)};
    const close=()=>{root.classList.remove('open');state.open=false};
    root.addEventListener('click',e=>{if(e.target===root)close()}); input.addEventListener('input',render);
    input.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){e.preventDefault();state.active=Math.min(state.active+1,state.commands.length-1);render()}if(e.key==='ArrowUp'){e.preventDefault();state.active=Math.max(0,state.active-1);render()}if(e.key==='Enter'){e.preventDefault();execute(state.active)}if(e.key==='Escape')close()});
    document.addEventListener('keydown',e=>{if((e.metaKey||e.ctrlKey)&&e.key.toLowerCase()==='k'){e.preventDefault();state.open?close():open()}if(e.key==='Escape'&&state.open)close()});
    window.openVisionCommand=open;
  }
  async function systemStatus() {
    const wrap=document.createElement('div'); wrap.className='vision-topbar'; wrap.innerHTML='<button class="vision-pill" id="visionCommandButton">⌘K&nbsp; Команды</button><div class="vision-pill"><i class="vision-dot"></i><span id="visionHealth">Проверка системы</span></div>'; document.body.append(wrap);
    $('#visionCommandButton').onclick=()=>window.openVisionCommand?.();
    try { const r=await fetch('/api/health'); const d=await r.json(); $('#visionHealth').textContent=d.ok===false?'Требуется внимание':'Система работает'; } catch { $('#visionHealth').textContent='Нет связи с сервером'; }
  }
  async function onboarding() {
    const box=document.createElement('aside'); box.className='vision-onboarding'; box.innerHTML='<button class="icon-btn" data-close style="float:right">×</button><h3>Запуск магазина</h3><p>Контроль готовности проекта к первым продажам.</p><div class="vision-progress"><i></i></div><div class="vision-checks"></div>'; document.body.append(box);
    $('[data-close]',box).onclick=()=>{box.classList.remove('open');localStorage.setItem('gtstore_onboarding_closed','1')};
    try {
      const token=localStorage.getItem('gtstore_token')||''; const headers=token?{authorization:`Bearer ${token}`} : {};
      const [shopsR,productsR,botsR]=await Promise.allSettled([fetch('/api/shops',{headers}),fetch('/api/products?shopId=demo',{headers}),fetch('/api/telegram/bots?shopId=demo',{headers})]);
      const values=await Promise.all([shopsR.value?.json?.().catch(()=>[]),productsR.value?.json?.().catch(()=>[]),botsR.value?.json?.().catch(()=>[])]);
      const checks=[['Магазин создан',Array.isArray(values[0])&&values[0].length>0],['Добавлен хотя бы один товар',Array.isArray(values[1])&&values[1].length>0],['Подключён канал продаж',Array.isArray(values[2])&&values[2].length>0],['Настроены доставка и оплата',false]];
      const done=checks.filter(x=>x[1]).length; $('.vision-progress i',box).style.width=`${done/checks.length*100}%`; $('.vision-checks',box).innerHTML=checks.map(([t,v])=>`<div class="vision-check ${v?'done':''}"><b>${v?'✓':'·'}</b><span>${safe(t)}</span></div>`).join('');
      if(done<checks.length&&!localStorage.getItem('gtstore_onboarding_closed'))setTimeout(()=>box.classList.add('open'),800);
    } catch {}
  }
  function dataMotion() {
    document.addEventListener('pointermove',e=>{ if(matchMedia('(prefers-reduced-motion: reduce)').matches)return; const x=(e.clientX/innerWidth-.5),y=(e.clientY/innerHeight-.5); document.documentElement.style.setProperty('--pointer-x',x.toFixed(3));document.documentElement.style.setProperty('--pointer-y',y.toFixed(3)); });
  }
  async function productionCoreBadge(){
    const badge=document.createElement('button');badge.className='vision-core-badge';badge.innerHTML='<span>V4 Production Core<small id="visionCoreMeta">Проверка модульного ядра</small></span>';document.body.append(badge);
    const check=async()=>{try{const token=localStorage.getItem('gtstore_token')||'';const r=await fetch('/api/v4/health',{headers:token?{authorization:`Bearer ${token}`}:{}});const d=await r.json();$('#visionCoreMeta').textContent=r.ok?`${d.channels.length} канала · ${d.integrations.length} интеграции · rev ${d.revision}`:'Требуется вход';}catch{$('#visionCoreMeta').textContent='Ядро недоступно';}};
    badge.onclick=()=>{toast('V4: каталог, заказы, резервы, реферальный ledger и адаптеры каналов активны','info');check()};await check();
  }
  addEventListener('DOMContentLoaded',()=>{buildCommandPalette();systemStatus();onboarding();dataMotion();productionCoreBadge();});
})();
