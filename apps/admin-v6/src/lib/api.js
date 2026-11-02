const base=(localStorage.getItem('gt_api')||(location.protocol==='https:'?'/api/v6':'http://127.0.0.1:4000/api/v6')).replace(/\/$/,'');
export const session={get token(){return localStorage.getItem('gt_token')||''},set token(v){v?localStorage.setItem('gt_token',v):localStorage.removeItem('gt_token')}};

export function mediaUrl(value){
  if(!value)return '';
  try{
    const url=new URL(String(value),new URL(base,location.href).origin+'/');
    return ['http:','https:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';
  }catch{return '';}
}

export async function api(path,options={}){
  let response;
  try{
    response=await fetch(base+path,{...options,headers:{'content-type':'application/json',...(session.token?{authorization:`Bearer ${session.token}`}:{}) ,...(options.headers||{})},body:options.body&&typeof options.body!=='string'?JSON.stringify(options.body):options.body});
  }catch{throw new Error('Не удалось соединиться с сервером. Проверьте соединение и повторите запрос.');}
  if(response.status===204)return null;
  let data;
  try{data=await response.json();}
  catch{throw new Error(`Сервер вернул HTTP ${response.status}. ${response.status===413?'Файл превышает допустимый размер загрузки.':'Не удалось прочитать ответ; проверьте доступность API.'}`);}
  if(!response.ok){
    const error=new Error(data.error?.message||`Ошибка API (HTTP ${response.status})`);
    error.details=data.error?.details;
    error.code=data.error?.code;
    error.status=response.status;
    throw error;
  }
  return data;
}
