'use strict';
const {TelegramAdapter}=require('./telegram-adapter');
const {MaxAdapter}=require('./max-adapter');
class ChannelRegistry {
 constructor(){this.factories=new Map([['telegram',c=>new TelegramAdapter(c)],['max',c=>new MaxAdapter(c)]]);}
 register(name,factory){this.factories.set(name,factory);}
 create(name,config){const factory=this.factories.get(name);if(!factory)throw new Error(`Unsupported channel: ${name}`);return factory(config);}
 list(){return [...this.factories.keys()];}
}
module.exports={ChannelRegistry};
