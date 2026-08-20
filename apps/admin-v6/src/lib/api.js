function resolveApiBase(){
  const params=new URLSearchParams(location.search);
  const fromQuery=params.get('api');
  if(fromQuery)return fromQuery.replace(/\/$/,'');
  const stored=localStorage.getItem('gt_api');
  if(stored)return stored.replace(/\/$/,'');
  if(location.protocol==='https:'||location.port==='4000')return `${location.origin}/api/v6`;
  if(location.port==='4173'||location.port==='4174')return `${location.protocol}//${location.hostname}:4000/api/v6`;
  return `${location.origin}/api/v6`;
}
const base=resolveApiBase();
export const session={get token(){return localStorage.getItem('gt_token')||''},set token(v){v?localStorage.setItem('gt_token',v):localStorage.removeItem('gt_token')}};
export async function api(path,options={}){ const response=await fetch(base+path,{...options,headers:{'content-type':'application/json',...(session.token?{authorization:`Bearer ${session.token}`}:{}) ,...(options.headers||{})},body:options.body&&typeof options.body!=='string'?JSON.stringify(options.body):options.body}); if(response.status===204)return null; const data=await response.json(); if(!response.ok)throw new Error(data.error?.message||'Ошибка API'); return data; }
