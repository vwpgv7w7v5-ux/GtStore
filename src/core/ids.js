'use strict';
const crypto=require('crypto');
function id(prefix='id'){return `${prefix}_${crypto.randomUUID()}`;}
function now(){return new Date().toISOString();}
module.exports={id,now};
