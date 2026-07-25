import type { AuditFields, Id, Money, ChannelType } from './common';
export type OrderStatus = 'draft'|'new'|'confirmed'|'awaiting_payment'|'paid'|'assembling'|'ready'|'shipped'|'completed'|'cancelled'|'refunded';
export type PaymentStatus = 'pending'|'authorized'|'paid'|'failed'|'refunded'|'partially_refunded';
export interface OrderLine { id: Id; productId: Id; variantId: Id; name: string; sku: string; quantity: number; unitPrice: Money; total: Money; }
export interface CustomerSnapshot { customerId?: Id; name: string; phone?: string; email?: string; telegramId?: string; maxId?: string; }
export interface DeliverySnapshot { methodId?: Id; methodName: string; zoneId?: Id; address?: string; fields: Record<string,string>; price: Money; }
export interface Order extends AuditFields { id: Id; shopId: Id; number: string; status: OrderStatus; paymentStatus: PaymentStatus; channel: ChannelType; customer: CustomerSnapshot; lines: OrderLine[]; subtotal: Money; discount: Money; delivery: DeliverySnapshot; total: Money; promoCode?: string; referralCode?: string; comment?: string; history: OrderHistoryEntry[]; }
export interface OrderHistoryEntry { id: Id; at: string; actorId?: Id; type: string; from?: string; to?: string; note?: string; }
