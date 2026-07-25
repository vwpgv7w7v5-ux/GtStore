'use strict';
const {ChannelAdapter}=require('./channel-adapter');
class TelegramAdapter extends ChannelAdapter {
 endpoint(method){return `https://api.telegram.org/bot${this.config.token}/${method}`;}
 async call(method,payload={}){const r=await fetch(this.endpoint(method),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(payload)});const data=await r.json();if(!data.ok)throw new Error(data.description||'Telegram API error');return data.result;}
 connect(){return this.call('getMe');}
 sendMessage({chatId,text,replyMarkup}){return this.call('sendMessage',{chat_id:chatId,text,reply_markup:replyMarkup});}
 sendOrderNotification({chatId,order}){return this.sendMessage({chatId,text:`Новый заказ ${order.number} на ${order.total} ₽`});}
 verifyWebhook(headers){const expected=this.config.webhookSecret;return !!expected&&headers['x-telegram-bot-api-secret-token']===expected;}
 normalizeUser(payload){const user=payload?.message?.from||payload?.callback_query?.from||{};return {channel:'telegram',externalId:String(user.id||''),username:user.username||'',name:[user.first_name,user.last_name].filter(Boolean).join(' ')};}
}
module.exports={TelegramAdapter};
