/** Thin client for the ApiShip aggregator API (https://apiship.ru). */
const BASE_URL = 'https://api.apiship.ru/v1';

export class ApishipClient {
  constructor(token, options = {}) {
    this.token = String(token || '').trim();
    this.fetch = options.fetch || globalThis.fetch;
    this.baseUrl = String(options.baseUrl || BASE_URL).replace(/\/$/, '');
  }

  async request(method, path, { query, body } = {}) {
    if (!this.token) throw new Error('APISHIP_TOKEN_MISSING');
    if (!this.fetch) throw new Error('FETCH_UNAVAILABLE');
    const qs = query
      ? '?' +
        new URLSearchParams(
          Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== ''),
        ).toString()
      : '';
    const response = await this.fetch(`${this.baseUrl}${path}${qs}`, {
      method,
      headers: {
        Authorization: this.token,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const message = data?.message || data?.error || `ApiShip HTTP ${response.status}`;
      throw new Error(message);
    }
    return data;
  }

  async listPoints({ city, providerKey, limit } = {}) {
    const data = await this.request('GET', '/points', {
      query: { city, providerKey, limit: limit || 200 },
    });
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return rows.map(normalizePoint);
  }

  async calculator(body = {}) {
    const data = await this.request('POST', '/calculator', { body });
    const rows = Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
    return rows.map(normalizeTariff);
  }

  async createOrder(body = {}) {
    const data = await this.request('POST', '/orders', { body });
    const row = data?.data || data || {};
    return {
      externalId: String(row.id || row.orderId || ''),
      tracking: String(row.number || row.trackNumber || row.id || ''),
      status: row.status || 'created',
      raw: row,
    };
  }

  async statuses(orderIds = []) {
    const data = await this.request('POST', '/orders/statuses', {
      body: { orderIds: Array.isArray(orderIds) ? orderIds : [orderIds] },
    });
    return Array.isArray(data?.data) ? data.data : Array.isArray(data) ? data : [];
  }
}

function normalizePoint(row = {}) {
  return {
    id: String(row.id || row.pointId || row.code || ''),
    code: String(row.code || row.id || ''),
    name: String(row.name || row.title || ''),
    address: String(row.address?.fullAddress || row.address || ''),
    city: String(row.address?.city || row.city || ''),
    lat: Number(row.address?.geo?.lat ?? row.latitude ?? row.lat ?? 0) || null,
    lng: Number(row.address?.geo?.lon ?? row.longitude ?? row.lng ?? 0) || null,
    carrier: String(row.providerKey || row.provider || row.carrier || ''),
    phone: String(row.phone || row.contactPhone || ''),
    schedule: row.schedule || row.workTime || '',
  };
}

function normalizeTariff(row = {}) {
  return {
    carrier: String(row.providerKey || row.provider || ''),
    carrierName: String(row.providerName || row.name || ''),
    tariffId: row.tariffId ?? row.id ?? null,
    tariffName: String(row.tariffName || row.name || ''),
    price: Number(row.price ?? row.deliverySum ?? row.cost ?? 0) || 0,
    etaDays: Number(row.deliveryPeriodMax ?? row.days ?? row.term ?? 0) || 0,
    pvz: Boolean(row.pickupPoint ?? row.pvz ?? false),
  };
}
