'use strict';
const crypto=require('crypto');
const {id,now}=require('../core/ids');
const {required,text,number}=require('../core/validation');
const {NotFoundError,ValidationError}=require('../core/errors');
class ReferralService {
 constructor(repo){this.repo=repo;}
 async create(shopId,input){return this.repo.transaction(db=>{db.referrals||=[];db.referralLedger||=[];const ownerTelegram=required(input.telegram,'Telegram пользователя');const existing=db.referrals.find(x=>x.shopId===shopId&&x.telegram===ownerTelegram);if(existing)return existing;const code=crypto.randomBytes(4).toString('hex').toUpperCase();const item={id:id('ref'),shopId,telegram:ownerTelegram,name:text(input.name,200),code,discountPercent:20,rewardPercent:20,uses:0,createdAt:now()};db.referrals.push(item);return item;});}
 async registerOrder(shopId,code,orderId,orderTotal){return this.repo.transaction(db=>{const ref=(db.referrals||[]).find(x=>x.shopId===shopId&&x.code===String(code).toUpperCase());if(!ref)throw new NotFoundError('Реферальный код не найден');if((db.referralLedger||[]).some(x=>x.orderId===orderId))throw new ValidationError('Бонус по этому заказу уже зарегистрирован');const amount=Math.round(number(orderTotal,{min:0})*ref.rewardPercent)/100;const entry={id:id('led'),shopId,referralId:ref.id,orderId,amount,status:'pending',createdAt:now(),availableAt:null};db.referralLedger.push(entry);ref.uses=Number(ref.uses||0)+1;return entry;});}
 async settle(shopId,orderId){return this.repo.transaction(db=>{const entry=(db.referralLedger||[]).find(x=>x.shopId===shopId&&x.orderId===orderId);if(!entry)throw new NotFoundError('Начисление не найдено');entry.status='available';entry.availableAt=now();return entry;});}
 summary(shopId,referralId){const db=this.repo.read();const rows=(db.referralLedger||[]).filter(x=>x.shopId===shopId&&x.referralId===referralId);return {pending:rows.filter(x=>x.status==='pending').reduce((s,x)=>s+x.amount,0),available:rows.filter(x=>x.status==='available').reduce((s,x)=>s+x.amount,0),used:rows.filter(x=>x.status==='used').reduce((s,x)=>s+x.amount,0),entries:rows};}
}
module.exports={ReferralService};
