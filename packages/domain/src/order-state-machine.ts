import type { OrderStatus } from '@gtstore/contracts/orders';
import { ConflictError } from './errors';
const transitions:Record<OrderStatus,OrderStatus[]>={
 draft:['new','cancelled'], new:['confirmed','awaiting_payment','cancelled'], confirmed:['awaiting_payment','paid','assembling','cancelled'], awaiting_payment:['paid','cancelled'], paid:['assembling','refunded'], assembling:['ready','cancelled'], ready:['shipped','completed','cancelled'], shipped:['completed','refunded'], completed:['refunded'], cancelled:[], refunded:[]
};
export function canTransition(from:OrderStatus,to:OrderStatus):boolean { return transitions[from].includes(to); }
export function assertTransition(from:OrderStatus,to:OrderStatus):void { if(!canTransition(from,to)) throw new ConflictError(`Transition ${from} -> ${to} is not allowed`,{from,to,allowed:transitions[from]}); }
export function nextStatuses(status:OrderStatus):OrderStatus[]{ return [...transitions[status]]; }
