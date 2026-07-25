'use strict';
const {ChannelAdapter}=require('./channel-adapter');
class MaxAdapter extends ChannelAdapter {
 constructor(config={}){super(config);this.baseUrl=config.baseUrl||'https://platform-api.max.ru';}
 async request(path,payload){if(!this.config.token)throw new Error('MAX token is not configured');const r=await fetch(`${this.baseUrl}${path}`,{method:'POST',headers:{'content-type':'application/json','authorization':this.config.token},body:JSON.stringify(payload)});if(!r.ok)throw new Error(`MAX API ${r.status}`);return r.json();}
 connect(){return this.request('/me',{});}
 sendMessage({chatId,text}){return this.request('/messages',{chat_id:chatId,text});}
 sendOrderNotification({chatId,order}){return this.sendMessage({chatId,text:`Заказ ${order.number}: ${order.total} ₽`});}
 verifyWebhook(headers){return headers['x-gtstore-channel-secret']===this.config.webhookSecret;}
 normalizeUser(payload){const user=payload?.user||{};return {channel:'max',externalId:String(user.id||''),username:user.username||'',name:user.name||''};}
}
module.exports={MaxAdapter};
