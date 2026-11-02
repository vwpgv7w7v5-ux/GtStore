/** ApiShip-compatible carrier catalog (simulated when no live token). */
export const apishipCarriers = [
  { code: 'cdek', name: 'СДЭК', kinds: ['pvz', 'courier', 'postamat'] },
  { code: 'boxberry', name: 'Boxberry', kinds: ['pvz', 'courier'] },
  { code: 'russianpost', name: 'Почта России', kinds: ['pvz', 'courier', 'post'] },
  { code: 'dpd', name: 'DPD', kinds: ['pvz', 'courier'] },
  { code: 'dellin', name: 'Деловые Линии', kinds: ['terminal', 'courier'] },
  { code: 'pek', name: 'ПЭК', kinds: ['terminal', 'courier'] },
  { code: 'kit', name: 'КИТ', kinds: ['terminal', 'courier'] },
  { code: 'jde', name: 'JDE', kinds: ['terminal', 'courier'] },
  { code: 'cse', name: 'CSE', kinds: ['courier'] },
  { code: 'dostavista', name: 'Достависта', kinds: ['courier'] },
  { code: 'yandex', name: 'Яндекс Доставка', kinds: ['courier', 'pvz'] },
  { code: 'ozonrocket', name: 'Ozon Rocket', kinds: ['pvz', 'courier'] },
  { code: 'fivepost', name: '5Post', kinds: ['pvz', 'postamat'] },
  { code: 'halva', name: 'Халва', kinds: ['pvz'] },
  { code: 'pickpoint', name: 'PickPoint', kinds: ['pvz', 'postamat'] },
  { code: 'sberlogistics', name: 'СберЛогистика', kinds: ['pvz', 'courier'] },
  { code: 'wildberries', name: 'WB ПВЗ', kinds: ['pvz'] },
  { code: 'lamoda', name: 'Lamoda', kinds: ['pvz', 'courier'] },
  { code: 'ups', name: 'UPS', kinds: ['courier'] },
  { code: 'dhl', name: 'DHL', kinds: ['courier'] },
  { code: 'fedex', name: 'FedEx', kinds: ['courier'] },
  { code: 'tnt', name: 'TNT', kinds: ['courier'] },
  { code: 'pony', name: 'Pony Express', kinds: ['courier', 'pvz'] },
  { code: 'axiomus', name: 'Axiomus', kinds: ['pvz', 'courier'] },
  { code: 'logsis', name: 'Logsis', kinds: ['courier'] },
  { code: 'baikalsr', name: 'Байкал Сервис', kinds: ['terminal'] },
  { code: 'energija', name: 'Энергия', kinds: ['terminal'] },
  { code: 'gtd', name: 'GTD', kinds: ['terminal'] },
  { code: 'vozovoz', name: 'Возовоз', kinds: ['terminal'] },
  { code: 'nrg', name: 'НРГ', kinds: ['terminal'] },
  { code: 'zhelDor', name: 'ЖелДорЭкспедиция', kinds: ['terminal'] },
  { code: 'meest', name: 'Meest', kinds: ['pvz', 'courier'] },
  { code: 'nova', name: 'Nova Poshta', kinds: ['pvz', 'courier'] },
  { code: 'courierist', name: 'Курьерист', kinds: ['courier'] },
  { code: 'bringly', name: 'Bringly', kinds: ['courier'] },
  { code: 'smart', name: 'Smart Delivery', kinds: ['courier'] },
  { code: 'topdelivery', name: 'TopDelivery', kinds: ['pvz', 'courier'] },
  { code: 'shiptor', name: 'Shiptor', kinds: ['pvz', 'courier'] },
  { code: 'redexpress', name: 'RedExpress', kinds: ['courier'] },
  { code: 'imax', name: 'IML', kinds: ['pvz', 'courier'] },
  { code: 'cityexpress', name: 'City Express', kinds: ['courier'] },
  { code: 'spsr', name: 'SPSR', kinds: ['courier'] },
  { code: 'garantpost', name: 'Гарантпост', kinds: ['courier'] },
  { code: 'apiship', name: 'ApiShip (агрегатор)', kinds: ['pvz', 'courier', 'post'] },
];

export function seedPickupPoints(city = 'Москва', carrier = 'cdek') {
  const centers = {
    москва: { lat: 55.7558, lng: 37.6173 },
    'санкт-петербург': { lat: 59.9343, lng: 30.3351 },
    новосибирск: { lat: 55.0084, lng: 82.9357 },
    екатеринбург: { lat: 56.8389, lng: 60.6057 },
    казань: { lat: 55.7961, lng: 49.1064 },
  };
  const key = String(city || 'москва')
    .toLowerCase()
    .replace(/ё/g, 'е');
  const base =
    Object.entries(centers).find(([name]) => key.includes(name))?.[1] ||
    centers['москва'];
  const carrierMeta =
    apishipCarriers.find((c) => c.code === carrier) ||
    apishipCarriers.find((c) => c.code === 'cdek');
  return [0, 1, 2, 3, 4, 5].map((i) => ({
    id: `pvz_${carrier}_${i + 1}`,
    carrier: carrierMeta.code,
    carrierName: carrierMeta.name,
    name: `${carrierMeta.name} ПВЗ #${i + 1}`,
    address: `${city}, ул. Примерная, ${10 + i * 3}`,
    city,
    lat: Number((base.lat + (i % 3) * 0.012 - 0.01).toFixed(6)),
    lng: Number((base.lng + Math.floor(i / 3) * 0.015 - 0.01).toFixed(6)),
    workTime: '09:00–21:00',
    phone: '+7 (800) 100-00-00',
    type: i % 2 === 0 ? 'pvz' : 'postamat',
    cod: true,
    cash: true,
  }));
}
