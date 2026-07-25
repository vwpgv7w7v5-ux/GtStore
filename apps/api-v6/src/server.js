import { createApp } from './app.js';
const port=Number(process.env.V6_PORT||4000); const host=process.env.HOST||'127.0.0.1'; const {server}=createApp({databaseFile:process.env.V6_DATABASE_FILE||'data/v6.json'});
server.listen(port,host,()=>console.log(`GtStore API v6: http://${host}:${port}`));
