const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[2]||'.');
const port=Number(process.argv[3]||process.env.PORT||4173);
const host=process.env.HOST||'0.0.0.0';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json','.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.webp':'image/webp','.svg':'image/svg+xml','.ico':'image/x-icon','.woff2':'font/woff2'};
http.createServer((req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');
  const urlPath=decodeURIComponent((req.url||'/').split('?')[0]);
  let file=path.join(root,urlPath);
  if(file.endsWith(path.sep)||urlPath.endsWith('/'))file=path.join(file,'index.html');
  if(!file.startsWith(root)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found')}
    const ext=path.extname(file);
    const headers={'content-type':types[ext]||'application/octet-stream'};
    if(ext==='.html')headers['Cache-Control']='no-store';
    else if(ext==='.js'||ext==='.css')headers['Cache-Control']='no-cache';
    else if(ext==='.png'||ext==='.svg'||ext==='.ico'||ext==='.webp')headers['Cache-Control']='no-cache, max-age=0, must-revalidate';
    res.writeHead(200,headers);
    res.end(data);
  });
}).listen(port,host,()=>console.log(`Static: http://${host}:${port} → ${root}`));
