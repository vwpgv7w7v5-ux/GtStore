import type { Money, CurrencyCode } from '@gtstore/contracts/common';
import { ValidationError } from './errors';
export function money(amount:number,currency:CurrencyCode='RUB'):Money { if(!Number.isFinite(amount)) throw new ValidationError('Invalid amount'); return {amount:Math.round(amount*100)/100,currency}; }
export function assertSameCurrency(a:Money,b:Money):void { if(a.currency!==b.currency) throw new ValidationError('Currency mismatch'); }
export function addMoney(...values:Money[]):Money { if(!values.length) return money(0); const currency=values[0].currency; values.forEach(v=>{if(v.currency!==currency) throw new ValidationError('Currency mismatch');}); return money(values.reduce((s,v)=>s+v.amount,0),currency); }
export function multiplyMoney(value:Money,quantity:number):Money { if(quantity<0||!Number.isFinite(quantity)) throw new ValidationError('Invalid quantity'); return money(value.amount*quantity,value.currency); }
export function subtractMoney(a:Money,b:Money):Money { assertSameCurrency(a,b); return money(a.amount-b.amount,a.currency); }
export function percent(value:Money,rate:number):Money { if(rate<0||rate>100) throw new ValidationError('Invalid percent'); return money(value.amount*rate/100,value.currency); }
export function clampMoney(value:Money,min=0):Money { return money(Math.max(min,value.amount),value.currency); }
