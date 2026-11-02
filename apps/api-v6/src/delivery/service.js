import { assert } from '../core/errors.js';
import { id } from '../core/ids.js';
import { apishipCarriers, seedPickupPoints } from './carriers.js';
import { ApishipClient } from './apiship-client.js';

const now = () => new Date().toISOString();
const money = (v) => Math.round((Number(v) || 0) * 100) / 100;
const providers = [
  { id: 'pickup', name: 'Самовывоз', kind: 'offline', supportsTracking: false },
  { id: 'courier', name: 'Курьер магазина', kind: 'local', supportsTracking: true },
  { id: 'apiship', name: 'ApiShip (40+ доставок)', kind: 'aggregator', supportsTracking: true, supportsPvz: true },
  { id: 'cdek', name: 'СДЭК', kind: 'carrier', supportsTracking: true, supportsPvz: true },
  { id: 'boxberry', name: 'Boxberry', kind: 'carrier', supportsTracking: true, supportsPvz: true },
  { id: 'russian_post', name: 'Почта России', kind: 'carrier', supportsTracking: true, supportsPvz: true },
  { id: 'yandex', name: 'Яндекс Доставка', kind: 'carrier', supportsTracking: true, supportsPvz: true },
  { id: 'dpd', name: 'DPD', kind: 'carrier', supportsTracking: true, supportsPvz: true },
];

const cityZones = {
  moscow: { label: 'Москва', multiplier: 1, etaBonus: 0 },
  spb: { label: 'Санкт-Петербург', multiplier: 1.15, etaBonus: 1 },
  region: { label: 'Регион РФ', multiplier: 1.45, etaBonus: 2 },
  remote: { label: 'Отдалённый регион', multiplier: 1.9, etaBonus: 4 },
};

function detectZone(city = '', region = '') {
  const hay = `${city} ${region}`.toLowerCase();
  if (/моск|moscow/.test(hay)) return 'moscow';
  if (/питер|петербург|spb|saint.?peter/.test(hay)) return 'spb';
  if (/крым|калининград|сахалин|якут|магадан|чукот|камчат/.test(hay)) return 'remote';
  if (hay.trim()) return 'region';
  return 'moscow';
}

const apishipCarrierCode = {
  cdek: 'cdek',
  boxberry: 'boxberry',
  russian_post: 'russianpost',
  yandex: 'yandex',
  dpd: 'dpd',
};

function trackingNumberFor(provider, shipmentId) {
  const seed = String(shipmentId || id('trk')).replace(/\W/g, '').slice(-8).toUpperCase();
  if (provider === 'cdek') return `CDEK${seed}`;
  if (provider === 'boxberry') return `BB${seed}`;
  if (provider === 'russian_post') return `RP${seed}RU`;
  if (provider === 'apiship') return `AS${seed}`;
  if (provider === 'yandex') return `YD${seed}`;
  if (provider === 'dpd') return `DPD${seed}`;
  return `GT${seed}`;
}

function pointInPolygon(lat, lng, polygon = []) {
  if (!Array.isArray(polygon) || polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const yi = Number(polygon[i].lat),
      xi = Number(polygon[i].lng);
    const yj = Number(polygon[j].lat),
      xj = Number(polygon[j].lng);
    const intersect =
      yi > lat !== yj > lat &&
      lng < ((xj - xi) * (lat - yi)) / (yj - yi + 1e-12) + xi;
    if (intersect) inside = !inside;
  }
  return inside;
}

function haversineKm(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Approximate polygon area in km² (for picking the most specific district). */
function polygonAreaKm2(polygon = []) {
  if (!Array.isArray(polygon) || polygon.length < 3) return Number.POSITIVE_INFINITY;
  const R = 6371;
  let sum = 0;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const lat1 = (Number(polygon[j].lat) * Math.PI) / 180;
    const lat2 = (Number(polygon[i].lat) * Math.PI) / 180;
    const lng1 = (Number(polygon[j].lng) * Math.PI) / 180;
    const lng2 = (Number(polygon[i].lng) * Math.PI) / 180;
    sum += (lng2 - lng1) * (2 + Math.sin(lat1) + Math.sin(lat2));
  }
  return Math.abs((sum * R * R) / 2);
}

const ZONE_COLORS = [
  '#C45A32',
  '#2F6F6A',
  '#3D5A80',
  '#8B5E3C',
  '#6B4E71',
  '#B08D57',
  '#4A6741',
  '#A65D57',
];

export class DeliveryService {
  constructor(store, tenancy, options = {}) {
    this.store = store;
    this.tenancy = tenancy;
    this.fetch = options.fetch || globalThis.fetch;
    this.apishipToken = options.apishipToken || process.env.APISHIP_TOKEN || '';
  }
  ensure(userId, workspaceId, shopId, role = 'viewer') {
    const c = this.tenancy.context(userId, workspaceId, role);
    assert(
      c.state.shops.some((s) => s.id === shopId && s.workspaceId === workspaceId),
      'SHOP_NOT_FOUND',
      'Магазин не найден',
      404,
    );
    return c;
  }
  providerList() {
    return providers;
  }
  carriers() {
    return apishipCarriers;
  }
  rawApishipToken(shop) {
    const fromShop = shop?.settings?.delivery?.apiship || {};
    return String(fromShop.token || this.apishipToken || '').trim();
  }
  apishipSettings(shop) {
    const fromShop = shop?.settings?.delivery?.apiship || {};
    const token = this.rawApishipToken(shop);
    return {
      tokenSet: Boolean(token),
      tokenPreview: token ? `${token.slice(0, 4)}••••` : '',
      live: Boolean(token),
      source: fromShop.token ? 'shop' : token ? 'env' : null,
      senderCity: fromShop.senderCity || 'Москва',
      enabledCarriers: Array.isArray(fromShop.enabledCarriers)
        ? fromShop.enabledCarriers
        : apishipCarriers.slice(0, 12).map((c) => c.code),
    };
  }
  async saveApiship(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'admin');
    return this.store.transaction(userId, (db) => {
      const shop = db.shops.find((s) => s.id === shopId);
      assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
      shop.settings ||= {};
      shop.settings.delivery ||= {};
      const prev = shop.settings.delivery.apiship || {};
      const next = {
        token: input.clearToken
          ? ''
          : String(input.token || prev.token || '').trim(),
        senderCity: String(input.senderCity || prev.senderCity || 'Москва'),
        enabledCarriers: Array.isArray(input.enabledCarriers)
          ? input.enabledCarriers.map(String)
          : prev.enabledCarriers ||
            apishipCarriers.slice(0, 12).map((c) => c.code),
      };
      shop.settings.delivery.apiship = next;
      shop.updatedAt = now();
      return this.apishipSettings(shop);
    });
  }
  async pickupPoints(slug, input = {}) {
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const city = String(input.city || 'Москва');
    const carrier = String(input.carrier || 'cdek').toLowerCase();
    const settings = this.apishipSettings(shop);
    const carriers = settings.enabledCarriers?.length
      ? settings.enabledCarriers
      : ['cdek', 'boxberry', 'russianpost'];
    const q = String(input.q || '').toLowerCase();
    let points = null;
    let live = false;
    if (settings.live) {
      try {
        const client = new ApishipClient(this.rawApishipToken(shop), { fetch: this.fetch });
        const providerKey = carrier === 'all' || carrier === 'apiship' ? undefined : carrier;
        const remote = await client.listPoints({ city, providerKey, limit: 200 });
        if (remote.length) {
          points = remote;
          live = true;
        }
      } catch {
        points = null;
      }
    }
    if (!points) {
      points =
        carrier === 'all' || carrier === 'apiship'
          ? carriers.flatMap((code) => seedPickupPoints(city, code))
          : seedPickupPoints(city, carrier);
    }
    return {
      city,
      carrier,
      live,
      source: live ? 'apiship-live' : settings.live ? 'apiship-simulated' : 'catalog',
      points: points.filter(
        (p) =>
          !q ||
          String(p.name || '').toLowerCase().includes(q) ||
          String(p.address || '').toLowerCase().includes(q),
      ),
    };
  }
  zones(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.courierZones || [])
      .filter((z) => z.shopId === shopId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
  publicZones(slug) {
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    return (state.courierZones || [])
      .filter((z) => z.shopId === shop.id && z.active !== false)
      .map((z) => ({
        id: z.id,
        name: z.name,
        price: z.price,
        freeFrom: z.freeFrom,
        color: z.color,
        polygon: z.polygon,
        center: z.center,
        radiusKm: z.radiusKm,
      }));
  }
  async createZone(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    assert(String(input.name || '').trim(), 'ZONE_NAME_REQUIRED', 'Укажите название зоны');
    return this.store.transaction(userId, (db) => {
      db.courierZones ||= [];
      const existing = (db.courierZones || []).filter((z) => z.shopId === shopId);
      const autoColor =
        ZONE_COLORS[existing.length % ZONE_COLORS.length] || '#C45A32';
      const row = {
        id: id('zone'),
        shopId,
        name: String(input.name).trim(),
        price: money(input.price ?? 350),
        freeFrom: input.freeFrom == null ? null : money(input.freeFrom),
        color: String(input.color || autoColor),
        polygon: Array.isArray(input.polygon) ? input.polygon : [],
        center:
          input.center && typeof input.center === 'object'
            ? {
                lat: Number(input.center.lat),
                lng: Number(input.center.lng),
              }
            : null,
        radiusKm: input.radiusKm == null ? null : Number(input.radiusKm),
        active: input.active !== false,
        sortOrder:
          input.sortOrder != null
            ? Number(input.sortOrder) || 0
            : existing.length,
        createdAt: now(),
        updatedAt: now(),
      };
      db.courierZones.push(row);
      return row;
    });
  }
  async updateZone(userId, workspaceId, shopId, zoneId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const row = (db.courierZones || []).find(
        (z) => z.id === zoneId && z.shopId === shopId,
      );
      assert(row, 'ZONE_NOT_FOUND', 'Зона не найдена', 404);
      if (input.name !== undefined) row.name = String(input.name || '').trim();
      if (input.color !== undefined) row.color = String(input.color || '#C26A4A');
      if (input.polygon !== undefined)
        row.polygon = Array.isArray(input.polygon)
          ? input.polygon.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
          : [];
      if (input.center !== undefined)
        row.center =
          input.center && typeof input.center === 'object'
            ? { lat: Number(input.center.lat), lng: Number(input.center.lng) }
            : null;
      if (input.radiusKm !== undefined)
        row.radiusKm = input.radiusKm == null ? null : Number(input.radiusKm);
      if (input.active !== undefined) row.active = input.active !== false;
      if (input.sortOrder !== undefined) row.sortOrder = Number(input.sortOrder) || 0;
      if (input.price !== undefined) row.price = money(input.price);
      if (input.freeFrom !== undefined)
        row.freeFrom = input.freeFrom == null ? null : money(input.freeFrom);
      row.updatedAt = now();
      return row;
    });
  }
  async removeZone(userId, workspaceId, shopId, zoneId) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const i = (db.courierZones || []).findIndex(
        (z) => z.id === zoneId && z.shopId === shopId,
      );
      assert(i >= 0, 'ZONE_NOT_FOUND', 'Зона не найдена', 404);
      return db.courierZones.splice(i, 1)[0];
    });
  }
  matchZone(shopId, lat, lng) {
    if (lat == null || lng == null || Number.isNaN(Number(lat)) || Number.isNaN(Number(lng)))
      return null;
    const point = { lat: Number(lat), lng: Number(lng) };
    const state = this.store.snapshot();
    const zones = (state.courierZones || []).filter(
      (z) => z.shopId === shopId && z.active !== false,
    );
    const hits = [];
    for (const zone of zones) {
      if (zone.polygon?.length >= 3 && pointInPolygon(point.lat, point.lng, zone.polygon)) {
        hits.push({
          zone,
          kind: 0, // polygon preferred over radius
          area: polygonAreaKm2(zone.polygon),
          sortOrder: Number(zone.sortOrder) || 0,
        });
        continue;
      }
      if (
        zone.center &&
        zone.radiusKm != null &&
        haversineKm(zone.center, point) <= Number(zone.radiusKm)
      ) {
        const r = Number(zone.radiusKm);
        hits.push({
          zone,
          kind: 1,
          area: Math.PI * r * r,
          sortOrder: Number(zone.sortOrder) || 0,
        });
      }
    }
    if (!hits.length) return null;
    // Most specific district wins: polygon over circle, then smaller area, then earlier sortOrder.
    hits.sort(
      (a, b) =>
        a.kind - b.kind || a.area - b.area || a.sortOrder - b.sortOrder,
    );
    return hits[0].zone;
  }

  async geocodeAddress(query) {
    const q = String(query || '').trim();
    if (q.length < 3) return null;
    const fetchFn = this.fetch || globalThis.fetch;
    if (!fetchFn) return null;
    const key = String(
      process.env.YANDEX_MAPS_API_KEY || process.env.YANDEX_GEOCODER_API_KEY || '',
    ).trim();
    try {
      if (key) {
        const url = `https://geocode-maps.yandex.ru/1.x/?apikey=${encodeURIComponent(key)}&geocode=${encodeURIComponent(q)}&format=json&results=1&lang=ru_RU`;
        const res = await fetchFn(url);
        if (res.ok) {
          const data = await res.json();
          const pos =
            data?.response?.GeoObjectCollection?.featureMember?.[0]?.GeoObject
              ?.Point?.pos;
          if (pos) {
            const [lng, lat] = String(pos).split(/\s+/).map(Number);
            if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng, source: 'yandex' };
          }
        }
      }
      const nominatim = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}&format=json&limit=1`;
      const res = await fetchFn(nominatim, {
        headers: { 'User-Agent': 'GtStore-delivery/1.0', Accept: 'application/json' },
      });
      if (!res.ok) return null;
      const rows = await res.json();
      const hit = Array.isArray(rows) ? rows[0] : null;
      if (!hit) return null;
      const lat = Number(hit.lat);
      const lng = Number(hit.lon);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      return { lat, lng, source: 'nominatim' };
    } catch {
      return null;
    }
  }

  async resolveCoords(input = {}) {
    let lat = input.lat != null && input.lat !== '' ? Number(input.lat) : null;
    let lng = input.lng != null && input.lng !== '' ? Number(input.lng) : null;
    if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
    const query = [input.city, input.address || input.region]
      .map((x) => String(x || '').trim())
      .filter(Boolean)
      .join(', ');
    if (!query) return { lat: null, lng: null };
    const geo = await this.geocodeAddress(query);
    return geo || { lat: null, lng: null };
  }
  methods(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.deliveryMethods || [])
      .filter((x) => x.shopId === shopId)
      .sort((a, b) => a.sortOrder - b.sortOrder);
  }
  publicMethods(slug) {
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const rows = (state.deliveryMethods || [])
      .filter((x) => x.shopId === shop.id && x.active)
      .sort((a, b) => a.sortOrder - b.sortOrder);
    return rows.length
      ? rows
      : [
          {
            id: 'pickup',
            shopId: shop.id,
            provider: 'pickup',
            name: 'Самовывоз',
            price: 0,
            active: true,
            sortOrder: 0,
          },
          {
            id: 'courier',
            shopId: shop.id,
            provider: 'courier',
            name: 'Курьер',
            price: 350,
            active: true,
            sortOrder: 1,
          },
        ];
  }
  async create(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    assert(
      providers.some((p) => p.id === input.provider),
      'DELIVERY_PROVIDER_INVALID',
      'Неизвестный провайдер',
    );
    assert(
      String(input.name || '').trim(),
      'DELIVERY_NAME_REQUIRED',
      'Укажите название способа доставки',
    );
    return this.store.transaction(userId, (db) => {
      db.deliveryMethods ||= [];
      const row = {
        id: id('dlv'),
        shopId,
        provider: input.provider,
        name: String(input.name).trim(),
        description: String(input.description || ''),
        price: money(input.price),
        freeFrom: input.freeFrom == null ? null : money(input.freeFrom),
        active: input.active !== false,
        sortOrder: Number(input.sortOrder) || 0,
        settings: input.settings || {},
        createdAt: now(),
        updatedAt: now(),
      };
      db.deliveryMethods.push(row);
      return row;
    });
  }
  async update(userId, workspaceId, shopId, methodId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const row = (db.deliveryMethods || []).find(
        (x) => x.id === methodId && x.shopId === shopId,
      );
      assert(row, 'DELIVERY_METHOD_NOT_FOUND', 'Способ доставки не найден', 404);
      for (const key of ['name', 'description', 'active', 'sortOrder', 'settings'])
        if (input[key] !== undefined) row[key] = input[key];
      if (input.price !== undefined) row.price = money(input.price);
      if (input.freeFrom !== undefined)
        row.freeFrom = input.freeFrom == null ? null : money(input.freeFrom);
      row.updatedAt = now();
      return row;
    });
  }
  async remove(userId, workspaceId, shopId, methodId) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, (db) => {
      const i = (db.deliveryMethods || []).findIndex(
        (x) => x.id === methodId && x.shopId === shopId,
      );
      assert(i >= 0, 'DELIVERY_METHOD_NOT_FOUND', 'Способ доставки не найден', 404);
      return db.deliveryMethods.splice(i, 1)[0];
    });
  }
  async quote(slug, input = {}) {
    const state = this.store.snapshot();
    const shop = state.shops.find((s) => s.slug === slug);
    assert(shop, 'SHOP_NOT_FOUND', 'Магазин не найден', 404);
    const methods = this.publicMethods(slug);
    const subtotal = money(input.subtotal);
    const weightKg = Math.max(0.1, Number(input.weightKg || input.weight || 0.5));
    const zoneKey = detectZone(input.city, input.region || input.address);
    const zone = cityZones[zoneKey];
    const coords = await this.resolveCoords(input);
    const geoZone = this.matchZone(shop.id, coords.lat, coords.lng);
    const pvzId = String(input.pickupPointId || input.pvzId || '');
    const settings = this.apishipSettings(shop);
    const carrierAware = methods.some((m) =>
      ['apiship', 'cdek', 'boxberry', 'russian_post', 'yandex', 'dpd'].includes(m.provider),
    );
    let liveTariffs = null;
    if (settings.live && carrierAware && input.city) {
      try {
        const client = new ApishipClient(this.rawApishipToken(shop), { fetch: this.fetch });
        liveTariffs = await client.calculator({
          from: { city: settings.senderCity || 'Москва' },
          to: { city: String(input.city) },
          weight: weightKg,
          assessedCost: subtotal,
        });
      } catch {
        liveTariffs = null;
      }
    }
    return methods.map((m) => {
      const baseEta =
        m.provider === 'pickup'
          ? 0
          : m.provider === 'courier'
            ? 1
            : m.provider === 'apiship' || m.provider === 'cdek'
              ? 2
              : m.provider === 'boxberry' || m.provider === 'yandex'
                ? 3
                : 5;
      let price =
        m.freeFrom != null && subtotal >= m.freeFrom ? 0 : money(m.price);
      let zoneLabel = zone.label;
      let matchedZoneId = null;
      if (m.provider === 'courier' && geoZone) {
        matchedZoneId = geoZone.id;
        zoneLabel = geoZone.name;
        price =
          geoZone.freeFrom != null && subtotal >= geoZone.freeFrom
            ? 0
            : money(geoZone.price);
      } else if (price > 0 && m.provider !== 'pickup') {
        const weightFee =
          Math.max(0, weightKg - 1) * (m.provider === 'courier' ? 40 : 55);
        price = money(price * zone.multiplier + weightFee);
        if (m.settings?.basePrice != null) {
          price = money(
            Number(m.settings.basePrice) * zone.multiplier + weightFee,
          );
        }
        if (m.provider === 'apiship' && pvzId) price = money(price * 0.92);
      }
      let etaDays = m.provider === 'pickup' ? 0 : baseEta + zone.etaBonus;
      const liveMatch =
        m.provider === 'apiship'
          ? (liveTariffs || []).slice().sort((a, b) => a.price - b.price)[0] || null
          : (liveTariffs || []).find((t) => t.carrier === apishipCarrierCode[m.provider]) || null;
      if (liveMatch && liveMatch.price > 0) {
        price = money(liveMatch.price);
        if (liveMatch.etaDays) etaDays = liveMatch.etaDays;
      }
      return {
        ...m,
        calculatedPrice: price,
        etaDays,
        zone: matchedZoneId || zoneKey,
        zoneLabel,
        courierZoneId: matchedZoneId,
        courierZonePrice: matchedZoneId != null ? money(geoZone.price) : null,
        lat: coords.lat,
        lng: coords.lng,
        pickupPointId: pvzId || null,
        weightKg,
        live: Boolean(liveMatch),
        source: liveMatch ? 'apiship-live' : 'simulated',
        trackingAvailable: Boolean(
          providers.find((p) => p.id === m.provider)?.supportsTracking,
        ),
        supportsPvz: Boolean(
          providers.find((p) => p.id === m.provider)?.supportsPvz,
        ),
        quoteId: id('qt'),
        quotedAt: now(),
      };
    });
  }
  shipments(userId, workspaceId, shopId) {
    const { state } = this.ensure(userId, workspaceId, shopId);
    return (state.shipments || [])
      .filter((x) => x.shopId === shopId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async createShipment(userId, workspaceId, shopId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    return this.store.transaction(userId, async (db) => {
      db.shipments ||= [];
      db.shipmentEvents ||= [];
      const order = (db.orders || []).find(
        (o) => o.id === input.orderId && o.shopId === shopId,
      );
      assert(order, 'ORDER_NOT_FOUND', 'Заказ не найден', 404);
      assert(
        !db.shipments.some(
          (s) =>
            s.orderId === order.id && !['cancelled', 'delivered'].includes(s.status),
        ),
        'SHIPMENT_EXISTS',
        'Для заказа уже есть активная отправка',
      );
      const method = (db.deliveryMethods || []).find(
        (m) => m.id === input.methodId && m.shopId === shopId,
      );
      const provider = method?.provider || order.deliveryMethod || 'courier';
      const shipmentId = id('shp');
      const shop = db.shops.find((s) => s.id === shopId);
      const settings = this.apishipSettings(shop);
      let liveTracking = '';
      let liveExternalId = '';
      if (
        settings.live &&
        !input.trackingNumber &&
        (provider === 'apiship' || apishipCarriers.some((c) => c.code === provider))
      ) {
        try {
          const client = new ApishipClient(this.rawApishipToken(shop), { fetch: this.fetch });
          const created = await client.createOrder({
            providerKey: provider === 'apiship' ? undefined : provider,
            senderCity: settings.senderCity,
            recipient: { name: order.customer?.name || '', phone: order.customer?.phone || '' },
            address: String(input.address || order.address || ''),
            weight: 1,
            assessedCost: order.total,
          });
          if (created?.tracking) {
            liveTracking = created.tracking;
            liveExternalId = created.externalId || '';
          }
        } catch {
          liveTracking = '';
        }
      }
      const tracking =
        String(input.trackingNumber || '').trim() ||
        liveTracking ||
        (provider === 'pickup' ? '' : trackingNumberFor(provider, shipmentId));
      const row = {
        id: shipmentId,
        shopId,
        orderId: order.id,
        methodId: method?.id || null,
        provider,
        status: 'created',
        trackingNumber: tracking,
        externalId: liveExternalId || null,
        live: Boolean(liveTracking),
        address: String(input.address || order.address || ''),
        city: String(input.city || ''),
        recipient: order.customer?.name || '',
        phone: order.customer?.phone || '',
        cost: money(input.cost ?? method?.price ?? order.deliveryPrice),
        etaDays: Number(input.etaDays || 0) || null,
        createdAt: now(),
        updatedAt: now(),
      };
      db.shipments.push(row);
      db.shipmentEvents.push({
        id: id('sev'),
        shipmentId: row.id,
        type: 'created',
        status: 'created',
        message: tracking
          ? `Создано отправление, трек ${tracking}`
          : 'Создано отправление',
        at: now(),
        actor: userId,
      });
      return row;
    });
  }
  async updateShipment(userId, workspaceId, shopId, shipmentId, input = {}) {
    this.ensure(userId, workspaceId, shopId, 'manager');
    const allowed = [
      'created',
      'ready',
      'shipped',
      'in_transit',
      'delivered',
      'cancelled',
      'failed',
    ];
    return this.store.transaction(userId, (db) => {
      db.shipmentEvents ||= [];
      const row = (db.shipments || []).find(
        (s) => s.id === shipmentId && s.shopId === shopId,
      );
      assert(row, 'SHIPMENT_NOT_FOUND', 'Отправление не найдено', 404);
      if (input.status !== undefined) {
        assert(
          allowed.includes(input.status),
          'SHIPMENT_STATUS_INVALID',
          'Некорректный статус отправления',
        );
        row.status = input.status;
        const labels = {
          created: 'Создано',
          ready: 'Готово к передаче',
          shipped: 'Передано в доставку',
          in_transit: 'В пути',
          delivered: 'Доставлено',
          cancelled: 'Отменено',
          failed: 'Сбой доставки',
        };
        db.shipmentEvents.push({
          id: id('sev'),
          shipmentId: row.id,
          type: 'status_changed',
          status: row.status,
          message: String(input.message || labels[row.status] || row.status),
          at: now(),
          actor: userId,
        });
        const order = (db.orders || []).find((o) => o.id === row.orderId);
        if (
          order &&
          input.status === 'shipped' &&
          ['ready', 'assembling', 'paid', 'confirmed'].includes(order.status)
        )
          order.status = 'shipped';
        if (order && input.status === 'delivered') order.status = 'completed';
      }
      if (input.trackingNumber !== undefined)
        row.trackingNumber = String(input.trackingNumber || '');
      row.updatedAt = now();
      return row;
    });
  }
  trackingPublic(shipmentId) {
    const state = this.store.snapshot();
    const row = (state.shipments || []).find((s) => s.id === shipmentId);
    assert(row, 'SHIPMENT_NOT_FOUND', 'Отправление не найдено', 404);
    const events = (state.shipmentEvents || [])
      .filter((e) => e.shipmentId === shipmentId)
      .sort((a, b) => a.at.localeCompare(b.at));
    return {
      id: row.id,
      provider: row.provider,
      status: row.status,
      trackingNumber: row.trackingNumber,
      address: row.address,
      etaDays: row.etaDays,
      updatedAt: row.updatedAt,
      events,
      timeline: events.map((e) => ({
        at: e.at,
        status: e.status,
        message: e.message || e.status,
      })),
    };
  }
}
