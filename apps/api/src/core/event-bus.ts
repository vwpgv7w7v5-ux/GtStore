import type { DomainEvent, EventBus } from './types';
export class LocalEventBus implements EventBus {
 private handlers=new Map<string,Array<(event:DomainEvent)=>Promise<void>>>();
 subscribe(type:string,handler:(event:DomainEvent)=>Promise<void>):void{ const list=this.handlers.get(type)??[]; list.push(handler); this.handlers.set(type,list); }
 async publish(event:DomainEvent):Promise<void>{ const handlers=[...(this.handlers.get(event.type)??[]),...(this.handlers.get('*')??[])]; const results=await Promise.allSettled(handlers.map(h=>h(event))); const failed=results.filter(r=>r.status==='rejected'); if(failed.length) console.error('Event handlers failed',failed); }
}
