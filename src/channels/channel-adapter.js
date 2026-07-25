'use strict';
class ChannelAdapter {
 constructor(config={}){this.config=config;}
 async connect(){throw new Error('connect() not implemented');}
 async publishStorefront(){throw new Error('publishStorefront() not implemented');}
 async sendMessage(){throw new Error('sendMessage() not implemented');}
 async sendOrderNotification(){throw new Error('sendOrderNotification() not implemented');}
 verifyWebhook(){return false;}
 normalizeUser(payload){return payload;}
}
module.exports={ChannelAdapter};
