import type { Repository } from './types';
import { ConflictError, NotFoundError } from '@gtstore/domain/errors';
export class InMemoryRepository<T extends {id:string}> implements Repository<T> {
 private readonly rows=new Map<string,T>();
 constructor(seed:T[]=[]){ seed.forEach(item=>this.rows.set(item.id,structuredClone(item))); }
 async list(predicate?:(item:T)=>boolean):Promise<T[]>{ const items=[...this.rows.values()].map(v=>structuredClone(v)); return predicate?items.filter(predicate):items; }
 async get(id:string):Promise<T|undefined>{ const row=this.rows.get(id); return row?structuredClone(row):undefined; }
 async insert(value:T):Promise<T>{ if(this.rows.has(value.id)) throw new ConflictError(`Duplicate id ${value.id}`); this.rows.set(value.id,structuredClone(value)); return structuredClone(value); }
 async update(id:string,mutator:(current:T)=>T):Promise<T>{ const current=this.rows.get(id); if(!current) throw new NotFoundError('entity',id); const next=mutator(structuredClone(current)); this.rows.set(id,structuredClone(next)); return structuredClone(next); }
 async delete(id:string):Promise<void>{ if(!this.rows.delete(id)) throw new NotFoundError('entity',id); }
}
