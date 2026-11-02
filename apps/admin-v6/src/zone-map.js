/** Courier zone map — Yandex Maps (radius + polygon). */

const DEFAULT_CENTER = { lat: 55.7558, lng: 37.6173 };
const DEFAULT_RADIUS_KM = 5;

let ymapsReady = null;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
  );
}

export function zoneShapeLabel(z) {
  if (Array.isArray(z.polygon) && z.polygon.length >= 3) return `Полигон · ${z.polygon.length} точек`;
  if (z.radiusKm != null && z.center) return `Радиус · ${Number(z.radiusKm)} км`;
  return 'Не задана';
}

function centroid(points) {
  if (!points.length) return { ...DEFAULT_CENTER };
  const lat = points.reduce((s, p) => s + Number(p.lat), 0) / points.length;
  const lng = points.reduce((s, p) => s + Number(p.lng), 0) / points.length;
  return { lat, lng };
}

async function resolveYandexKey() {
  try {
    const fromLs = localStorage.getItem('gt_yandex_maps_key');
    if (fromLs) return fromLs.trim();
  } catch {}
  try {
    const base =
      localStorage.getItem('gt_api') ||
      window.GT_API ||
      (['4173', '4174'].includes(location.port)
        ? `${location.protocol}//${location.hostname}:4000/api/v6`
        : `${location.origin}/api/v6`);
    const res = await fetch(`${base}/public/config`);
    if (res.ok) {
      const data = await res.json();
      return String(data.yandexMapsApiKey || '').trim();
    }
  } catch {}
  return String(window.GT_YANDEX_MAPS_KEY || '').trim();
}

export function ensureYmaps() {
  if (window.ymaps?.Map) {
    return new Promise((resolve) => window.ymaps.ready(() => resolve(window.ymaps)));
  }
  if (ymapsReady) return ymapsReady;
  ymapsReady = (async () => {
    const key = await resolveYandexKey();
    await new Promise((resolve, reject) => {
      if (document.querySelector('script[data-ymaps]')) {
        const wait = () =>
          window.ymaps
            ? window.ymaps.ready(() => resolve())
            : setTimeout(wait, 40);
        wait();
        return;
      }
      const script = document.createElement('script');
      const params = new URLSearchParams({ lang: 'ru_RU', coordorder: 'latlong' });
      if (key) params.set('apikey', key);
      script.src = `https://api-maps.yandex.ru/2.1/?${params}`;
      script.async = true;
      script.dataset.ymaps = '1';
      script.onload = () => window.ymaps.ready(() => resolve());
      script.onerror = () => reject(new Error('Не удалось загрузить Яндекс.Карты'));
      document.head.append(script);
    });
    return window.ymaps;
  })();
  return ymapsReady;
}

function hexToRgba(hex, alpha) {
  const h = String(hex || '#C45A32').replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r},${g},${b},${alpha})`;
}

function zoneBounds(zones) {
  const points = [];
  (zones || []).forEach((z) => {
    if (z.polygon?.length) z.polygon.forEach((p) => points.push([Number(p.lat), Number(p.lng)]));
    else if (z.center) points.push([Number(z.center.lat), Number(z.center.lng)]);
  });
  return points;
}

function zonePriceText(z) {
  const price = Number(z.price || 0);
  const free = z.freeFrom != null ? ` · от ${Number(z.freeFrom).toLocaleString('ru-RU')} ₽ бесплатно` : '';
  return `${price.toLocaleString('ru-RU')} ₽${free}`;
}

function zoneCentroid(z) {
  if (z.polygon?.length >= 3) return centroid(z.polygon);
  if (z.center) return { lat: Number(z.center.lat), lng: Number(z.center.lng) };
  return null;
}

function addZoneGeometry(ymaps, map, z, { editable = false, onClick, withLabel = false } = {}) {
  const color = z.color || '#C45A32';
  const opts = {
    fillColor: hexToRgba(color, 0.22),
    strokeColor: color,
    strokeWidth: 2,
    opacity: 0.9,
  };
  const title = `${z.name || 'Зона'} · ${zonePriceText(z)}`;
  let geo = null;
  if (z.polygon?.length >= 3) {
    geo = new ymaps.Polygon(
      [z.polygon.map((p) => [Number(p.lat), Number(p.lng)])],
      {
        hintContent: title,
        balloonContentHeader: esc(z.name || 'Зона'),
        balloonContentBody: `<b>${esc(zonePriceText(z))}</b><br><small>${esc(zoneShapeLabel(z))}</small>`,
      },
      { ...opts, editorDrawingCursor: 'crosshair' },
    );
  } else if (z.center && z.radiusKm != null) {
    geo = new ymaps.Circle(
      [[Number(z.center.lat), Number(z.center.lng)], Number(z.radiusKm) * 1000],
      {
        hintContent: title,
        balloonContentHeader: esc(z.name || 'Зона'),
        balloonContentBody: `<b>${esc(zonePriceText(z))}</b><br><small>${esc(zoneShapeLabel(z))}</small>`,
      },
      opts,
    );
  }
  if (!geo) return null;
  map.geoObjects.add(geo);
  if (withLabel) {
    const c = zoneCentroid(z);
    if (c) {
      map.geoObjects.add(
        new ymaps.Placemark(
          [c.lat, c.lng],
          {
            iconContent: `${Number(z.price || 0).toLocaleString('ru-RU')} ₽`,
            hintContent: title,
          },
          {
            preset: 'islands#darkOrangeStretchyIcon',
            zIndex: 700,
          },
        ),
      );
    }
  }
  if (onClick) geo.events.add('click', () => onClick(z));
  if (editable) geo.editor.startEditing();
  return geo;
}

/**
 * Overview map of all courier zones.
 */
export async function mountZonesOverview(container, { zones = [], onEdit } = {}) {
  if (!container) return null;
  let ymaps;
  try {
    ymaps = await ensureYmaps();
  } catch (err) {
    container.innerHTML = `<div class="zone-map-fallback"><b>Карта временно недоступна</b><p>${esc(err.message || 'Попробуйте позже')}</p></div>`;
    return null;
  }
  container.innerHTML = '';
  const map = new ymaps.Map(container, {
    center: [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng],
    zoom: 10,
    controls: ['zoomControl', 'geolocationControl', 'searchControl', 'typeSelector'],
  }, {
    searchControlProvider: 'yandex#search',
  });

  const points = [];
  (zones || []).forEach((z) => {
    const geo = addZoneGeometry(ymaps, map, z, { onClick: onEdit, withLabel: true });
    if (!geo) return;
    const bounds = geo.geometry.getBounds?.();
    if (bounds) {
      points.push(bounds[0], bounds[1]);
    }
  });
  const all = zoneBounds(zones);
  if (all.length >= 2) {
    try { map.setBounds(ymaps.util.bounds.fromPoints(all), { checkZoomRange: true, zoomMargin: 40 }); }
    catch { map.setCenter(all[0], 11); }
  } else if (all.length === 1) {
    map.setCenter(all[0], 12);
  }
  return map;
}

/**
 * Modal editor: radius or polygon on Yandex Maps.
 */
export async function openZoneEditor({ zone = null, zones = [], onSave } = {}) {
  let ymaps;
  try {
    ymaps = await ensureYmaps();
  } catch (err) {
    alert(err.message || 'Не удалось загрузить карту. Попробуйте позже.');
    throw err;
  }
  const editing = Boolean(zone?.id);
  const initialMode = zone?.polygon?.length >= 3 ? 'polygon' : 'radius';

  const wrap = document.createElement('div');
  wrap.className = 'modal-wrap';
  wrap.innerHTML = `
    <form class="modal large zone-editor-modal">
      <div class="panel-head">
        <h2>${editing ? 'Район и цена доставки' : 'Новый район доставки'}</h2>
        <button type="button" class="x" aria-label="Закрыть">×</button>
      </div>
      <div class="zone-editor">
        <div class="zone-editor-side">
          <label>Район / название
            <input name="name" required maxlength="80" value="${esc(zone?.name || '')}" placeholder="Центр, Север, ЗАО…">
          </label>
          <label>Цена доставки в этом районе, ₽
            <input name="price" type="number" min="0" step="1" value="${Number(zone?.price ?? 350)}" required>
          </label>
          <label>Бесплатно от, ₽
            <input name="freeFrom" type="number" min="0" step="1" value="${zone?.freeFrom ?? ''}" placeholder="не задано">
          </label>
          <label>Цвет на карте
            <input name="color" type="color" value="${esc(zone?.color || '#C45A32')}">
          </label>
          <p class="zone-hint">Нарисуйте район на карте — у каждого района своя цена. При пересечении зон сработает более точная (меньшая) область.</p>
          <div class="zone-mode-tabs" role="tablist">
            <button type="button" class="zone-mode ${initialMode === 'radius' ? 'active' : ''}" data-mode="radius">Радиус</button>
            <button type="button" class="zone-mode ${initialMode === 'polygon' ? 'active' : ''}" data-mode="polygon">Многоугольник</button>
          </div>
          <div class="zone-mode-panel" data-panel="radius" ${initialMode === 'radius' ? '' : 'hidden'}>
            <p class="zone-hint">Кликните на карте, чтобы поставить центр. Перетащите метку или измените радиус.</p>
            <label>Радиус, км
              <input name="radiusKm" id="zone-radius-range" type="range" min="0.5" max="80" step="0.5" value="${Number(zone?.radiusKm ?? DEFAULT_RADIUS_KM)}">
            </label>
            <div class="zone-radius-readout"><b id="zone-radius-value">${Number(zone?.radiusKm ?? DEFAULT_RADIUS_KM)}</b><span>км</span></div>
          </div>
          <div class="zone-mode-panel" data-panel="polygon" ${initialMode === 'polygon' ? '' : 'hidden'}>
            <p class="zone-hint">Кликайте по карте, чтобы поставить точки многоугольника. Нужно минимум 3 точки.</p>
            <div class="zone-poly-actions">
              <button type="button" class="ghost compact" id="zone-undo-point">↩ Точка</button>
              <button type="button" class="ghost compact" id="zone-clear-poly">Очистить</button>
            </div>
            <small class="muted" id="zone-poly-count">Точек: ${zone?.polygon?.length || 0}</small>
          </div>
        </div>
        <div class="zone-editor-map-wrap">
          <div id="zone-editor-map" class="zone-editor-map"></div>
          <div class="zone-map-legend">Яндекс Карты · зоны доставки</div>
        </div>
      </div>
      <div class="modal-actions">
        <button type="button" class="ghost cancel">Отмена</button>
        <button type="submit" class="primary">Сохранить зону</button>
      </div>
      <div class="form-error"></div>
    </form>`;
  document.body.append(wrap);

  const form = wrap.querySelector('form');
  const errEl = wrap.querySelector('.form-error');
  let map = null;
  const close = () => {
    try { map?.destroy(); } catch {}
    wrap.remove();
  };
  wrap.querySelectorAll('.x, .cancel').forEach((b) => (b.onclick = close));

  const mapEl = wrap.querySelector('#zone-editor-map');
  const startCenter = zone?.center
    ? [Number(zone.center.lat), Number(zone.center.lng)]
    : [DEFAULT_CENTER.lat, DEFAULT_CENTER.lng];

  map = new ymaps.Map(mapEl, {
    center: startCenter,
    zoom: 11,
    controls: ['zoomControl', 'searchControl', 'typeSelector', 'geolocationControl'],
  }, {
    searchControlProvider: 'yandex#search',
    yandexMapDisablePoiInteractivity: true,
  });

  // Other zones as context
  (zones || []).forEach((z) => {
    if (z.id === zone?.id) return;
    addZoneGeometry(ymaps, map, {
      ...z,
      color: z.color || '#8a8178',
    });
  });

  let mode = initialMode;
  let center = zone?.center
    ? { lat: Number(zone.center.lat), lng: Number(zone.center.lng) }
    : { ...DEFAULT_CENTER };
  let radiusKm = Number(zone?.radiusKm ?? DEFAULT_RADIUS_KM);
  let polyPoints = Array.isArray(zone?.polygon)
    ? zone.polygon.map((p) => ({ lat: Number(p.lat), lng: Number(p.lng) }))
    : [];

  let draftCollection = new ymaps.GeoObjectCollection();
  map.geoObjects.add(draftCollection);

  const colorInput = form.querySelector('[name=color]');
  const radiusRange = form.querySelector('#zone-radius-range');
  const radiusValue = form.querySelector('#zone-radius-value');
  const polyCount = form.querySelector('#zone-poly-count');
  const activeColor = () => colorInput.value || '#C45A32';

  function clearDraft() {
    draftCollection.removeAll();
  }

  function redrawRadius() {
    clearDraft();
    if (mode !== 'radius') return;
    const placemark = new ymaps.Placemark(
      [center.lat, center.lng],
      { hintContent: 'Центр зоны' },
      { draggable: true, preset: 'islands#orangeDotIcon' },
    );
    placemark.events.add('drag', () => {
      const c = placemark.geometry.getCoordinates();
      center = { lat: c[0], lng: c[1] };
      const circle = draftCollection.get(1);
      if (circle) circle.geometry.setCoordinates([c, radiusKm * 1000]);
    });
    const circle = new ymaps.Circle(
      [[center.lat, center.lng], radiusKm * 1000],
      {},
      {
        fillColor: hexToRgba(activeColor(), 0.22),
        strokeColor: activeColor(),
        strokeWidth: 2,
        cursor: 'pointer',
      },
    );
    draftCollection.add(placemark);
    draftCollection.add(circle);
  }

  let polyDragTimer = null;
  function redrawPolygon() {
    clearDraft();
    if (mode !== 'polygon') return;
    polyCount.textContent = `Точек: ${polyPoints.length}`;
    if (polyPoints.length >= 2) {
      const poly = new ymaps.Polygon(
        [polyPoints.map((p) => [p.lat, p.lng])],
        {},
        {
          fillColor: hexToRgba(activeColor(), polyPoints.length >= 3 ? 0.22 : 0.08),
          strokeColor: activeColor(),
          strokeWidth: 2,
        },
      );
      draftCollection.add(poly);
    }
    polyPoints.forEach((p, idx) => {
      const mark = new ymaps.Placemark(
        [p.lat, p.lng],
        { hintContent: `Точка ${idx + 1}` },
        { draggable: true, preset: 'islands#orangeCircleDotIcon' },
      );
      mark.events.add('click', (e) => e.stopPropagation());
      mark.events.add('dragend', () => {
        const c = mark.geometry.getCoordinates();
        polyPoints[idx] = { lat: c[0], lng: c[1] };
        clearTimeout(polyDragTimer);
        polyDragTimer = setTimeout(() => redrawPolygon(), 0);
      });
      mark.events.add('drag', () => {
        const c = mark.geometry.getCoordinates();
        polyPoints[idx] = { lat: c[0], lng: c[1] };
        if (polyPoints.length < 2) return;
        const poly = draftCollection.get(0);
        if (poly?.geometry?.setCoordinates) {
          poly.geometry.setCoordinates([polyPoints.map((pt) => [pt.lat, pt.lng])]);
        }
      });
      draftCollection.add(mark);
    });
  }

  function setMode(next) {
    mode = next;
    form.querySelectorAll('.zone-mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
    form.querySelectorAll('.zone-mode-panel').forEach((p) => {
      p.hidden = p.dataset.panel !== mode;
    });
    if (mode === 'radius') redrawRadius();
    else redrawPolygon();
  }

  form.querySelectorAll('.zone-mode').forEach((btn) => {
    btn.onclick = () => setMode(btn.dataset.mode);
  });

  radiusRange.oninput = () => {
    radiusKm = Number(radiusRange.value);
    radiusValue.textContent = String(radiusKm);
    if (mode === 'radius') {
      const circle = draftCollection.get(1);
      if (circle?.geometry?.setRadius) circle.geometry.setRadius(radiusKm * 1000);
      else redrawRadius();
    }
  };
  colorInput.oninput = () => {
    if (mode === 'radius') redrawRadius();
    else redrawPolygon();
  };

  form.querySelector('#zone-undo-point').onclick = () => {
    polyPoints.pop();
    redrawPolygon();
  };
  form.querySelector('#zone-clear-poly').onclick = () => {
    polyPoints = [];
    redrawPolygon();
  };

  map.events.add('click', (e) => {
    const coords = e.get('coords'); // [lat, lng] because coordorder=latlong
    if (mode === 'radius') {
      center = { lat: coords[0], lng: coords[1] };
      redrawRadius();
      return;
    }
    polyPoints.push({ lat: coords[0], lng: coords[1] });
    redrawPolygon();
  });

  if (mode === 'radius') {
    if (!zone?.center) center = { ...DEFAULT_CENTER };
    redrawRadius();
  } else {
    redrawPolygon();
  }

  if (zone?.polygon?.length >= 3) {
    try {
      map.setBounds(
        ymaps.util.bounds.fromPoints(zone.polygon.map((p) => [Number(p.lat), Number(p.lng)])),
        { checkZoomRange: true, zoomMargin: 48 },
      );
    } catch {}
  } else if (zone?.center && zone.radiusKm != null) {
    try {
      const circle = new ymaps.Circle([[Number(zone.center.lat), Number(zone.center.lng)], Number(zone.radiusKm) * 1000]);
      map.setBounds(circle.geometry.getBounds(), { checkZoomRange: true, zoomMargin: 48 });
    } catch {
      map.setCenter([center.lat, center.lng], 11);
    }
  }

  form.onsubmit = async (e) => {
    e.preventDefault();
    errEl.textContent = '';
    const fd = new FormData(form);
    const name = String(fd.get('name') || '').trim();
    if (!name) {
      errEl.textContent = 'Укажите название зоны';
      return;
    }
    const price = Number(fd.get('price') || 0);
    const freeRaw = String(fd.get('freeFrom') || '').trim();
    const freeFrom = freeRaw === '' ? null : Number(freeRaw);
    const color = String(fd.get('color') || '#C45A32');

    let payload;
    if (mode === 'radius') {
      payload = {
        name,
        price,
        freeFrom,
        color,
        center,
        radiusKm,
        polygon: [],
      };
    } else {
      if (polyPoints.length < 3) {
        errEl.textContent = 'Для многоугольника нужно минимум 3 точки';
        return;
      }
      payload = {
        name,
        price,
        freeFrom,
        color,
        polygon: polyPoints.map((p) => ({ lat: p.lat, lng: p.lng })),
        center: centroid(polyPoints),
        radiusKm: null,
      };
    }

    try {
      await onSave(payload, zone);
      close();
    } catch (err) {
      errEl.textContent = err.message || 'Не удалось сохранить';
    }
  };
}

// Back-compat alias used nowhere critical
export const ensureLeaflet = ensureYmaps;
