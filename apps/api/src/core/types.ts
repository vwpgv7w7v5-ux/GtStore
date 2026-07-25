export interface RequestContext { requestId:string; userId?:string; workspaceId?:string; shopId?:string; roles:string[]; permissions:Set<string>; }
export interface Repository<T extends {id:string}> { list(predicate?:(item:T)=>boolean):Promise<T[]>; get(id:string):Promise<T|undefined>; insert(value:T):Promise<T>; update(id:string,mutator:(current:T)=>T):Promise<T>; delete(id:string):Promise<void>; }
export interface Clock { now():Date; }
export class SystemClock implements Clock { now():Date { return new Date(); } }
export interface EventBus { publish(event:DomainEvent):Promise<void>; subscribe(type:string,handler:(event:DomainEvent)=>Promise<void>):void; }
export interface DomainEvent { id:string; type:string; at:string; aggregateId?:string; shopId?:string; payload:Record<string,unknown>; }
