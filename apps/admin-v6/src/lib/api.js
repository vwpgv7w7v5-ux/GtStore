const base=localStorage.getItem('gt_api')||window.GT_API||(['4173','4174'].includes(location.port)?`${location.protocol}//${location.hostname}:4000/api/v6`:`${location.origin}/api/v6`);
export const session={get token(){return localStorage.getItem('gt_token')||''},set token(v){v?localStorage.setItem('gt_token',v):localStorage.removeItem('gt_token')}};
export function mediaUrl(value){
  if(!value)return '';
  try{const url=new URL(String(value),new URL(base,location.href).origin+'/');
    return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';
  }catch{return '';}
}
export async function api(path,options={}){
  const {timeoutMs=20000,...request}=options;
  let response;
  try{
    response=await fetch(base+path,{...request,signal:request.signal||AbortSignal.timeout(timeoutMs),
      headers:{'content-type':'application/json',...(session.token?{authorization:`Bearer ${session.token}`}:{}) ,...(request.headers||{})},
      body:request.body&&typeof request.body!=='string'?JSON.stringify(request.body):request.body});
  }catch(error){throw new Error(error.name==='TimeoutError'?'Сервер не ответил вовремя. Импорт мог продолжиться; откройте его статус повторно.':'Не удалось соединиться с сервером. Проверьте подключение.');}
  if(response.status===204)return null;
  let data;
  try{data=await response.json();}
  catch{throw new Error(response.status===413?'Файл превышает допустимый размер загрузки.':`Сервер вернул HTTP ${response.status}. Не удалось прочитать ответ API.`);}
  if(!response.ok){const error=new Error(data.error?.message||`Ошибка API (HTTP ${response.status})`);
    error.details=data.error?.details;error.code=data.error?.code;error.status=response.status;throw error;}
  return data;
}
