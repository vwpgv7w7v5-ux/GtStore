'use strict';
const fs=require('fs');
const path=require('path');
const {ConflictError}=require('./errors');
class JsonRepository {
  constructor(file){this.file=file;this.queue=Promise.resolve();this.ensure();}
  ensure(){fs.mkdirSync(path.dirname(this.file),{recursive:true});if(!fs.existsSync(this.file))fs.writeFileSync(this.file,'{}');}
  read(){return JSON.parse(fs.readFileSync(this.file,'utf8'));}
  write(data){const tmp=`${this.file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(data,null,2));fs.renameSync(tmp,this.file);}
  transaction(fn){
    const job=this.queue.then(async()=>{
      const db=this.read();
      const before=Number(db.meta?.revision||0);
      const result=await fn(db);
      db.meta={...(db.meta||{}),revision:before+1,updatedAt:new Date().toISOString()};
      this.write(db);
      return result;
    });
    this.queue=job.catch(()=>undefined);
    return job;
  }
  assertShop(db,shopId){const shop=(db.shops||[]).find(x=>x.id===shopId);if(!shop)throw new ConflictError('Магазин не найден');return shop;}
}
module.exports={JsonRepository};
