const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const extensions = new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.css','.html','.json','.md','.prisma']);
const ignored = new Set(['node_modules','.git']);
let files=0, physical=0, nonEmpty=0, bytes=0;
const byExt={};
function walk(dir){
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    if(ignored.has(entry.name)) continue;
    const full=path.join(dir,entry.name);
    if(entry.isDirectory()) walk(full);
    else if(extensions.has(path.extname(entry.name))){
      const text=fs.readFileSync(full,'utf8');
      const lines=text.split(/\r?\n/);
      const ext=path.extname(entry.name)||'none';
      files++;
      physical+=lines.length;
      nonEmpty+=lines.filter(x=>x.trim()).length;
      bytes+=Buffer.byteLength(text);
      byExt[ext]??={files:0,lines:0,nonEmpty:0};
      byExt[ext].files++;
      byExt[ext].lines+=lines.length;
      byExt[ext].nonEmpty+=lines.filter(x=>x.trim()).length;
    }
  }
}
walk(root);
console.log(JSON.stringify({files,physicalLines:physical,nonEmptyLines:nonEmpty,bytes,byExtension:byExt},null,2));
