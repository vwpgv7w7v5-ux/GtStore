import fs from 'node:fs'; import path from 'node:path';
const initial = { revision: 0, users: [], sessions: [], workspaces: [], memberships: [], shops: [], categories: [], products: [], storefronts: [], orders: [], orderEvents: [], notifications: [], telegramConfigs: [], telegramMessages: [], invitations: [], audit: [], webhooks: [], webhookDeliveries: [], payments: [], paymentEvents: [], stockMovements: [], stockReservations: [], stocktakes: [], deliveryMethods: [], shipments: [], shipmentEvents: [], customerProfiles: [], customerAddresses: [], wishlist: [], loyaltyLedger: [], customerNotifications: [] };
export class JsonStore {
  #file; #state; #queue = Promise.resolve();
  constructor(file) { this.#file = file; this.#state = this.#load(); }
  #load() { try { return { ...structuredClone(initial), ...JSON.parse(fs.readFileSync(this.#file, 'utf8')) }; } catch { return structuredClone(initial); } }
  snapshot() { return structuredClone(this.#state); }
  async transaction(actor, operation, options = {}) {
    const run = async () => {
      const draft = structuredClone(this.#state); const result = await operation(draft);
      draft.revision = (draft.revision || 0) + 1;
      draft.audit.push({ id: `audit_${draft.revision}`, actor, at: new Date().toISOString(), revision: draft.revision });
      const dir = path.dirname(this.#file);
      fs.mkdirSync(dir, { recursive: true });
      // Keep timestamped backups so client catalogs are never lost to a bad write/deploy.
      // Import batches can skip per-row backups (options.backup === false) — still write the DB.
      if (options.backup !== false) {
        try {
          if (fs.existsSync(this.#file)) {
            const backups = path.join(dir, 'backups');
            fs.mkdirSync(backups, { recursive: true });
            const stamp = new Date().toISOString().replace(/[:.]/g, '-');
            const base = path.basename(this.#file);
            fs.copyFileSync(this.#file, path.join(backups, `${base}.${stamp}`));
            const keep = 30;
            const files = fs.readdirSync(backups)
              .filter((f) => f.startsWith(`${base}.`))
              .map((f) => ({ f, t: fs.statSync(path.join(backups, f)).mtimeMs }))
              .sort((a, b) => b.t - a.t);
            for (const old of files.slice(keep)) fs.unlinkSync(path.join(backups, old.f));
          }
        } catch { /* backup must never block a successful write */ }
      }
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(draft, null, 2)); fs.renameSync(tmp, this.#file); this.#state = draft; return result;
    };
    const pending = this.#queue.then(run, run); this.#queue = pending.catch(() => undefined); return pending;
  }
}
