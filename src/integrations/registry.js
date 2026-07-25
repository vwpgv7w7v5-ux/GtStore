'use strict';
class IntegrationRegistry {
 constructor(){this.items=new Map();}
 register(id,definition){this.items.set(id,{id,...definition});return this;}
 list(){return [...this.items.values()].map(x=>({...x,secretFields:undefined}));}
 get(id){return this.items.get(id);}
}
function createDefaultRegistry(){return new IntegrationRegistry()
 .register('moysklad',{name:'МойСклад',capabilities:['catalog.pull','catalog.push','stock.sync','orders.push']})
 .register('1c',{name:'1С',capabilities:['catalog.pull','stock.sync','orders.push'],transport:['http','file']})
 .register('bitrix24',{name:'Bitrix24',capabilities:['crm.contact.push','crm.deal.push','webhook.receive']})
 .register('custom',{name:'Универсальный API',capabilities:['rest','webhooks','api-keys']});}
module.exports={IntegrationRegistry,createDefaultRegistry};
