'use strict';
const {ValidationError}=require('./errors');
function text(v,max=5000){return String(v??'').trim().slice(0,max);}
function number(v,{min=0,max=Number.MAX_SAFE_INTEGER,field='Значение'}={}){const n=Number(v);if(!Number.isFinite(n)||n<min||n>max)throw new ValidationError(`${field}: некорректное число`);return n;}
function required(v,field='Поле'){const x=text(v);if(!x)throw new ValidationError(`${field} обязательно`);return x;}
function boolean(v,def=false){if(v===undefined||v===null||v==='')return def;return !['false','0','нет','no','off'].includes(String(v).toLowerCase());}
module.exports={text,number,required,boolean};
