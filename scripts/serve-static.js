const http=require('http'),fs=require('fs'),path=require('path');
const root=path.resolve(process.argv[2]||'.');
const port=Number(process.argv[3]||4173);
const host=process.env.HOST||'0.0.0.0';
const types={'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.json':'application/json; charset=utf-8'};
http.createServer((req,res)=>{
  let file=path.join(root,decodeURIComponent((req.url||'/').split('?')[0]));
  if(file.endsWith(path.sep)||(fs.existsSync(file)&&fs.statSync(file).isDirectory()))file=path.join(file,'index.html');
  if(!file.startsWith(root)){res.writeHead(403);return res.end()}
  fs.readFile(file,(err,data)=>{
    if(err){res.writeHead(404);return res.end('Not found')}
    res.writeHead(200,{'content-type':types[path.extname(file)]||'application/octet-stream','cache-control':'no-store'});
    res.end(data);
  });
}).listen(port,host,()=>console.log(`Static: http://${host}:${port}`));
