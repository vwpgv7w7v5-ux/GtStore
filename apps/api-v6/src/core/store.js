import fs from 'node:fs'; import path from 'node:path';
const initial = { revision: 0, users: [], sessions: [], workspaces: [], memberships: [], shops: [], categories: [], products: [], storefronts: [], orders: [], orderEvents: [], notifications: [], telegramConfigs: [], telegramMessages: [], invitations: [], audit: [], webhooks: [], webhookDeliveries: [], payments: [], paymentEvents: [], stockMovements: [], stockReservations: [], stocktakes: [], deliveryMethods: [], shipments: [], shipmentEvents: [], customerProfiles: [], customerAddresses: [], wishlist: [], loyaltyLedger: [], customerNotifications: [] };
export class JsonStore {
  #file; #state; #queue = Promise.resolve();
  constructor(file) { this.#file = file; this.#state = this.#load(); }
  #load() { try { return { ...structuredClone(initial), ...JSON.parse(fs.readFileSync(this.#file, 'utf8')) }; } catch { return structuredClone(initial); } }
  snapshot() { return structuredClone(this.#state); }
  async transaction(actor, operation) {
    const run = async () => {
      const draft = structuredClone(this.#state); const result = await operation(draft);
      draft.revision = (draft.revision || 0) + 1;
      draft.audit.push({ id: `audit_${draft.revision}`, actor, at: new Date().toISOString(), revision: draft.revision });
      const tmp = `${this.#file}.tmp`; fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(draft, null, 2)); fs.renameSync(tmp, this.#file); this.#state = draft; return result;
    };
    const pending = this.#queue.then(run, run); this.#queue = pending.catch(() => undefined); return pending;
  }
}
