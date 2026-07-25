export function createId(prefix='id'): string { return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2,10)}`; }
export function createOrderNumber(sequence:number,date=new Date()):string { const y=date.getFullYear().toString().slice(-2); const m=String(date.getMonth()+1).padStart(2,'0'); const d=String(date.getDate()).padStart(2,'0'); return `${y}${m}${d}-${String(sequence).padStart(5,'0')}`; }
export function slugify(value:string):string { return value.trim().toLowerCase().replace(/[ё]/g,'е').replace(/[^a-zа-я0-9]+/gi,'-').replace(/^-|-$/g,''); }
