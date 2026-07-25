import { ValidationError } from './errors';
export type ReferralLedgerStatus='pending'|'available'|'used'|'cancelled';
export interface ReferralRule { inviterPercent:number; inviteePercent:number; minOrderAmount:number; maxRewardAmount?:number; }
export function validateReferralRule(rule:ReferralRule):void { if(rule.inviterPercent<0||rule.inviterPercent>100) throw new ValidationError('Invalid inviter percent'); if(rule.inviteePercent<0||rule.inviteePercent>100) throw new ValidationError('Invalid invitee percent'); if(rule.minOrderAmount<0) throw new ValidationError('Invalid minimum order amount'); }
export function calculateReferralReward(total:number,rule:ReferralRule):number { validateReferralRule(rule); if(total<rule.minOrderAmount) return 0; const raw=total*rule.inviterPercent/100; return Math.round(Math.min(raw,rule.maxRewardAmount??raw)*100)/100; }
export function generateReferralCode(seed:string):string { const clean=seed.replace(/[^a-z0-9]/gi,'').toUpperCase().slice(0,6)||'USER'; return `${clean}${Math.random().toString(36).slice(2,6).toUpperCase()}`; }
