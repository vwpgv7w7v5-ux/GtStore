import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { assert } from '../core/errors.js';
import { touchCustomerVisit } from '../customers/visits.js';
import { downloadViaCurl } from './proxy-fetch.js';

const nowSeconds=()=>Math.floor(Date.now()/1000);
const safeEqual=(a,b)=>{const left=Buffer.from(String(a));const right=Buffer.from(String(b));return left.length===right.length&&crypto.timingSafeEqual(left,right)};
const AVATAR_TTL_MS=7*24*60*60*1000;

export class TelegramCustomerService {
  constructor(store,telegram,options={}){
    this.downloadAvatar = options.downloadAvatar || downloadViaCurl;
    this.store=store;
    this.telegram=telegram;
    this.maxAge=Number(options.maxAge||86400);
    this.media=options.media||null;
    this.sessionSecret=crypto.createHash('sha256').update(String(options.secret||process.env.GTSTORE_CUSTOMER_SESSION_SECRET||process.env.GTSTORE_TOKEN_SECRET||'gtstore-customer-development-secret')).digest();
  }
  sign(payload){const body=Buffer.from(JSON.stringify(payload)).toString('base64url');const sig=crypto.createHmac('sha256',this.sessionSecret).update(body).digest('base64url');return `${body}.${sig}`;}
  verifySession(token){const [body,sig]=String(token||'').split('.');assert(body&&sig,'CUSTOMER_UNAUTHORIZED','Требуется авторизация Telegram',401);const expected=crypto.createHmac('sha256',this.sessionSecret).update(body).digest('base64url');assert(safeEqual(sig,expected),'CUSTOMER_UNAUTHORIZED','Недействительная сессия',401);let payload;try{payload=JSON.parse(Buffer.from(body,'base64url').toString('utf8'));}catch{assert(false,'CUSTOMER_UNAUTHORIZED','Недействительная сессия',401)}assert(payload.exp>=nowSeconds(),'CUSTOMER_SESSION_EXPIRED','Сессия истекла',401);return payload;}
  parseInitData(initData,token){const params=new URLSearchParams(String(initData||''));const hash=params.get('hash');assert(hash,'TELEGRAM_INIT_DATA_INVALID','Отсутствует подпись Telegram',401);params.delete('hash');const dataCheck=[...params.entries()].sort(([a],[b])=>a.localeCompare(b)).map(([k,v])=>`${k}=${v}`).join('\n');const secret=crypto.createHmac('sha256','WebAppData').update(token).digest();const expected=crypto.createHmac('sha256',secret).update(dataCheck).digest('hex');assert(safeEqual(hash,expected),'TELEGRAM_INIT_DATA_INVALID','Подпись Telegram не прошла проверку',401);const authDate=Number(params.get('auth_date')||0);assert(authDate>0&&Math.abs(nowSeconds()-authDate)<=this.maxAge,'TELEGRAM_INIT_DATA_EXPIRED','Данные Telegram устарели',401);let user;try{user=JSON.parse(params.get('user')||'{}');}catch{assert(false,'TELEGRAM_USER_INVALID','Некорректные данные пользователя',401)}assert(user?.id,'TELEGRAM_USER_INVALID','Пользователь Telegram не найден',401);return user;}

  tryParseInitData(initData, token) {
    try {
      return this.parseInitData(initData, token);
    } catch {
      return null;
    }
  }

  /** Find which shop/bot signed this Mini App initData — prevents opening the wrong shop. */
  resolveShopByInitData(initData) {
    const raw = String(initData || '').trim();
    if (!raw) return null;
    const state = this.store.snapshot();
    const configs = (state.telegramConfigs || []).filter(
      (item) => item.enabled !== false && item.tokenEncrypted,
    );
    for (const config of configs) {
      let token = '';
      try {
        token = this.telegram.decrypt(config.tokenEncrypted);
      } catch {
        continue;
      }
      if (!token) continue;
      const user = this.tryParseInitData(raw, token);
      if (!user) continue;
      const shop = state.shops.find((item) => item.id === config.shopId);
      if (!shop) continue;
      return {
        shop: { id: shop.id, slug: shop.slug, name: shop.name },
        botUsername: config.botUsername || '',
        telegramId: String(user.id),
      };
    }
    return null;
  }

  botTokenForShop(shopId){
    const state=this.store.snapshot();
    const config=(state.telegramConfigs||[]).find(item=>item.shopId===shopId&&item.enabled&&item.tokenEncrypted);
    assert(config,'TELEGRAM_NOT_CONFIGURED','Telegram не настроен',404);
    return this.telegram.decrypt(config.tokenEncrypted);
  }

  cachedAvatarPath(telegramId){
    if(!this.media) return null;
    const prefix=`tg-avatar-${telegramId}`;
    try{
      const files=fs.readdirSync(this.media.directory).filter((name)=>name.startsWith(`${prefix}.`));
      for(const name of files){
        const full=path.join(this.media.directory,name);
        const st=fs.statSync(full);
        if(Date.now()-st.mtimeMs<=AVATAR_TTL_MS && st.size>100){
          return {file:full,filename:name,url:`${this.media.publicPrefix}${name}`};
        }
      }
    }catch{}
    return null;
  }

  cachedAvatarUrl(telegramId){
    return this.cachedAvatarPath(telegramId)?.url||'';
  }

  async saveTelegramFile(botToken,filePath,telegramId){
    const ext=path.extname(filePath).toLowerCase()||'.jpg';
    const safeExt=['.jpg','.jpeg','.png','.webp','.gif'].includes(ext)?ext:'.jpg';
    const filename=`tg-avatar-${telegramId}${safeExt}`;
    const dest=path.join(this.media.directory,filename);
    await this.telegram.downloadFile(botToken,filePath,dest);
    const st=await fs.promises.stat(dest);
    if(st.size<100){
      await fs.promises.unlink(dest).catch(()=>{});
      throw new Error('avatar file too small');
    }
    return {filename,url:`${this.media.publicPrefix}${filename}`,file:dest};
  }

  async fetchAvatarFromBot(botToken,user){
    const telegramId=String(user.id);
    // 1) Profile photos album
    try{
      const photos=await this.telegram.api(botToken,'getUserProfilePhotos',{
        user_id:Number(telegramId),
        limit:1,
      });
      console.warn('[telegram-avatar]', telegramId, 'profilePhotos', photos?.total_count||0);
      const sizes=photos?.photos?.[0];
      if(Array.isArray(sizes)&&sizes.length){
        const best=sizes.reduce((a,b)=>Number(a.file_size||a.width||0)>=Number(b.file_size||b.width||0)?a:b);
        if(best?.file_id){
          const file=await this.telegram.api(botToken,'getFile',{file_id:best.file_id});
          if(file?.file_path) return this.saveTelegramFile(botToken,file.file_path,telegramId);
        }
      }
    }catch(error){
      console.warn('[telegram-avatar]', telegramId, 'profilePhotos fail', error?.message||error);
    }

    // 2) Private chat photo (works after user opened the bot / Mini App)
    try{
      const chat=await this.telegram.api(botToken,'getChat',{chat_id:Number(telegramId)});
      const fileId=chat?.photo?.big_file_id||chat?.photo?.small_file_id||'';
      console.warn('[telegram-avatar]', telegramId, 'getChat photo', Boolean(fileId));
      if(fileId){
        const file=await this.telegram.api(botToken,'getFile',{file_id:fileId});
        if(file?.file_path) return this.saveTelegramFile(botToken,file.file_path,telegramId);
      }
    }catch(error){
      console.warn('[telegram-avatar]', telegramId, 'getChat fail', error?.message||error);
    }

    // 3) Public username CDN (real JPG when available; skip tiny/placeholder GIF)
    const username=String(user.username||'').replace(/^@/,'').trim();
    if(username&&this.media){
      try{
        const filename=`tg-avatar-${telegramId}.jpg`;
        const dest=path.join(this.media.directory,filename);
        const proxy=String(process.env.TELEGRAM_PROXY||process.env.HTTPS_PROXY||process.env.HTTP_PROXY||'').trim();
        const url=`https://t.me/i/userpic/320/${encodeURIComponent(username)}.jpg`;
        await this.downloadAvatar(url,dest,proxy||undefined);
        const st=await fs.promises.stat(dest);
        // Telegram returns 1x1 GIF (42 bytes) when photo is unavailable
        if(st.size>1000){
          console.warn('[telegram-avatar]', telegramId, 'cdn jpg ok', st.size);
          return {filename,url:`${this.media.publicPrefix}${filename}`,file:dest};
        }
        await fs.promises.unlink(dest).catch(()=>{});
        console.warn('[telegram-avatar]', telegramId, 'cdn jpg placeholder', st.size);
      }catch(error){
        console.warn('[telegram-avatar]', telegramId, 'cdn fail', error?.message||error);
      }
    }
    return null;
  }

  async resolvePhotoUrl(botToken,user){
    const fromInit=String(user.photo_url||'').trim();
    if(fromInit) return fromInit;
    const cached=this.cachedAvatarUrl(String(user.id));
    if(cached) return cached;
    if(!this.media) return '';
    try{
      const saved=await this.fetchAvatarFromBot(botToken,user);
      return saved?.url||'';
    }catch(error){
      console.warn('[telegram-avatar]', error?.message||error);
      return '';
    }
  }

  avatarEndpoint(slug,token){
    return `/api/v6/public/storefronts/${encodeURIComponent(slug)}/telegram/avatar?t=${encodeURIComponent(token)}`;
  }

  async authenticate(slug,initData){
    const state=this.store.snapshot();
    const shop=state.shops.find(item=>item.slug===slug);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    const botToken=this.botTokenForShop(shop.id);
    const user=this.parseInitData(initData,botToken);
    const sessionToken=this.sign({
      shopId:shop.id,
      telegramId:String(user.id),
      username:String(user.username||''),
      exp:nowSeconds()+this.maxAge,
    });
    // Prefer cached/real photo; never block Mini App auth on Telegram CDN.
    let photoUrl=this.cachedAvatarUrl(String(user.id));
    if(!photoUrl && user.photo_url){
      photoUrl=String(user.photo_url);
    }
    if(!photoUrl){
      photoUrl=this.avatarEndpoint(slug,sessionToken);
    }
    // Fill/refresh avatar cache in background — do not delay token/referral.
    this.resolvePhotoUrl(botToken,user).catch(()=>{});
    this.fetchAvatarFromBot(botToken,user).catch(()=>{});
    const customer={
      telegramId:String(user.id),
      firstName:String(user.first_name||''),
      lastName:String(user.last_name||''),
      username:String(user.username||''),
      languageCode:String(user.language_code||''),
      photoUrl,
    };
    const result={
      token:sessionToken,
      customer,
      shop:{id:shop.id,slug:shop.slug,name:shop.name},
    };
    // Persist TG nick so admin «Клиенты» shows who opened the bot / Mini App
    this.store.transaction('tg-auth-profile',(db)=>{
      db.customerProfiles||=[];
      const key=`tg:${customer.telegramId}`;
      let profile=db.customerProfiles.find(p=>p.shopId===shop.id&&p.key===key);
      if(!profile){
        profile={id:`cus_${customer.telegramId}`,shopId:shop.id,key,telegramId:customer.telegramId,createdAt:new Date().toISOString()};
        db.customerProfiles.push(profile);
      }
      if(customer.username) profile.username=customer.username;
      if(customer.firstName) profile.firstName=customer.firstName;
      if(customer.lastName) profile.lastName=customer.lastName;
      if(!profile.name){
        profile.name=[customer.firstName,customer.lastName].filter(Boolean).join(' ')||(customer.username?`@${customer.username}`:'');
      }
      touchCustomerVisit(profile);
      return profile;
    }).catch((error)=>console.warn('[tg-auth-profile]',error?.message||error));
    // Auto-welcome when customer opens Mini App — no /start required
    Promise.resolve()
      .then(async()=>{
        if(!this.telegram?.sendWelcome) return;
        const result=await this.telegram.sendWelcome(shop.id,user.id,{force:false});
        if(!result?.sent && result?.reason){
          console.warn('[telegram-welcome]',shop.slug,user.id,result.reason);
        }
        return result;
      })
      .catch((error)=>console.warn('[telegram-welcome]',error?.message||error));
    return result;
  }

  async ensureAvatar(slug,token){
    const session=this.verifySession(token);
    const state=this.store.snapshot();
    const shop=state.shops.find(item=>item.id===session.shopId&&item.slug===slug);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    const cached=this.cachedAvatarPath(session.telegramId);
    if(cached) return cached;
    const botToken=this.botTokenForShop(shop.id);
    const saved=await this.fetchAvatarFromBot(botToken,{
      id:session.telegramId,
      username:session.username||'',
    });
    assert(saved?.file,'TELEGRAM_AVATAR_NOT_FOUND','Фото профиля Telegram недоступно',404);
    return saved;
  }

  profile(token){
    const session=this.verifySession(token);
    const state=this.store.snapshot();
    const shop=state.shops.find(item=>item.id===session.shopId);
    assert(shop,'SHOP_NOT_FOUND','Магазин не найден',404);
    const orders=(state.orders||[]).filter(item=>item.shopId===shop.id&&String(item.customer?.telegramId||'')===session.telegramId).sort((a,b)=>b.createdAt.localeCompare(a.createdAt));
    const latest=orders[0];
    return {
      telegramId:session.telegramId,
      shop:{id:shop.id,slug:shop.slug,name:shop.name},
      stats:{orders:orders.length,total:orders.reduce((sum,item)=>sum+Number(item.total||0),0)},
      customer:latest?.customer||{telegramId:session.telegramId},
      orders,
      photoUrl:this.cachedAvatarUrl(session.telegramId)||'',
    };
  }
}
