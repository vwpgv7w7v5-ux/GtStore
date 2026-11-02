import { AppError } from '../core/errors.js';
export class Router {
  constructor(){ this.routes=[]; }
  add(method, pattern, handler, options={}) { const keys=[]; const regex=new RegExp('^'+pattern.replace(/:[^/]+/g,part=>{keys.push(part.slice(1));return '([^/]+)';})+'$'); this.routes.push({method,regex,keys,handler,options}); }
  match(method,path){ for(const route of this.routes){ const match=path.match(route.regex); if(route.method===method&&match){ return { ...route, params:Object.fromEntries(route.keys.map((key,index)=>[key,decodeURIComponent(match[index+1])])) }; } } throw new AppError('NOT_FOUND','Маршрут не найден',404); }
}
export const json = (res,status,payload,headers={})=>{ const body=JSON.stringify(payload); res.writeHead(status,{'content-type':'application/json; charset=utf-8','content-length':Buffer.byteLength(body),...headers}); res.end(body); };
export const readJson = req => new Promise((resolve,reject)=>{ let raw=''; req.on('data',chunk=>{raw+=chunk;if(raw.length>40_000_000)reject(new AppError('PAYLOAD_TOO_LARGE','Слишком большой запрос',413));}); req.on('end',()=>{try{resolve(raw?JSON.parse(raw):{});}catch{reject(new AppError('INVALID_JSON','Некорректный JSON'));}}); req.on('error',reject); });
