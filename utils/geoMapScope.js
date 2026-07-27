// utils/geoMapScope.js — fix18-10-hotfix30-B5-R5.2-B2（商家可設定地圖聚焦範圍）
//
// 這是 Geo Intelligence Map「聚焦範圍」設定的唯一權威來源（單一 pure
// function 集合），供 routes/settings.js 的 GET/PATCH /api/settings/geo-map
// 與 smoke test 共用同一份規則。不得在其他檔案各自重寫一份 enum／驗證邏輯
// （見需求文件四、十四：不得為 Geo Map 另建第二套設定框架）。
//
// 本檔案不直接存取 DB／req，只吃/吐 plain object，方便單元測試與跨端共用。

'use strict';

const GEO_MAP_SCOPE_MODES = Object.freeze(['store_location', 'districts', 'custom_bounds', 'data_bounds']);

// 沿用既有 settings key-value 表，本輪新增的 key 白名單（需求文件三）。
const GEO_MAP_SETTINGS_KEYS = Object.freeze([
  'geo_map_scope_mode',
  'geo_map_default_zoom',
  'geo_map_city_code',
  'geo_map_district_codes',
  'geo_map_bounds',
  'geo_map_geojson_source',
  'geo_map_auto_fit_bounds',
]);

const GEO_MAP_DEFAULTS = Object.freeze({
  geo_map_scope_mode: 'store_location',
  geo_map_default_zoom: 12,
  geo_map_city_code: null,
  geo_map_district_codes: [],
  geo_map_bounds: null,
  geo_map_geojson_source: null,
  geo_map_auto_fit_bounds: true,
});

// 需求文件八：不得 fallback 桃園——沒有任何有效設定時的全域安全預設。
const GEO_MAP_TAIWAN_FALLBACK = Object.freeze({ center: [23.7, 121.0], zoom: 7 });

const ZOOM_MIN = 1;
const ZOOM_MAX = 20;

// 需求文件七：GeoJSON Source 安全規則——只允許站內相對路徑，不得是任意
// http(s)/javascript:/data: URL，也不得用 `..` 做 path traversal，也不得是
// `//host` 這種 protocol-relative URL。
function isUnsafeSourceUrl(src) {
  if (src === null || src === undefined) return false;
  const s = String(src).trim();
  if (!s) return false;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return true; // 任何帶 scheme 的 URL（http:, https:, javascript:, data: ...）
  if (s.startsWith('//')) return true; // protocol-relative
  if (s.includes('..')) return true; // path traversal
  if (!s.startsWith('/')) return true; // 必須是站內絕對相對路徑（以 / 開頭），不接受相對於目前頁面的猜測路徑
  return false;
}

function validateGeoMapBounds(bounds) {
  if (bounds === null || bounds === undefined) return { ok: true, value: null };
  if (typeof bounds !== 'object' || Array.isArray(bounds)) return { ok: false, message: 'geo_map_bounds 必須是物件（south/west/north/east）' };
  const { south, west, north, east } = bounds;
  for (const [k, v] of Object.entries({ south, west, north, east })) {
    const n = Number(v);
    if (v === undefined || v === null || v === '' || !Number.isFinite(n)) {
      return { ok: false, message: `geo_map_bounds.${k} 必須是數字` };
    }
  }
  const s = Number(south), w = Number(west), n2 = Number(north), e = Number(east);
  if (s < -90 || n2 > 90) return { ok: false, message: 'geo_map_bounds 緯度超出範圍（必須介於 -90～90）' };
  if (w < -180 || e > 180) return { ok: false, message: 'geo_map_bounds 經度超出範圍（必須介於 -180～180）' };
  if (!(s < n2)) return { ok: false, message: 'geo_map_bounds south 必須小於 north' };
  if (!(w < e)) return { ok: false, message: 'geo_map_bounds west 必須小於 east' };
  return { ok: true, value: { south: s, west: w, north: n2, east: e } };
}

// 供 PATCH /api/settings/geo-map 使用：body 是 req.body（可能只帶部分欄位，
// 只驗證這次實際送出的欄位，未送出的欄位不驗證——沿用既有 PATCH 端點慣例）。
function validateGeoMapSettingsPatch(body) {
  const b = body || {};

  if (b.geo_map_scope_mode !== undefined && !GEO_MAP_SCOPE_MODES.includes(b.geo_map_scope_mode)) {
    return { ok: false, message: `geo_map_scope_mode 必須是 ${GEO_MAP_SCOPE_MODES.join(' / ')} 其中之一` };
  }

  if (b.geo_map_default_zoom !== undefined) {
    const z = Number(b.geo_map_default_zoom);
    if (!Number.isFinite(z) || z < ZOOM_MIN || z > ZOOM_MAX) {
      return { ok: false, message: `geo_map_default_zoom 必須介於 ${ZOOM_MIN}~${ZOOM_MAX} 之間的數字` };
    }
  }

  if (b.geo_map_city_code !== undefined && b.geo_map_city_code !== null && b.geo_map_city_code !== '') {
    if (typeof b.geo_map_city_code !== 'string') return { ok: false, message: 'geo_map_city_code 必須是字串' };
  }

  if (b.geo_map_district_codes !== undefined) {
    let arr = b.geo_map_district_codes;
    if (typeof arr === 'string') {
      if (arr.trim() === '') arr = [];
      else {
        try { arr = JSON.parse(arr); } catch (e) { return { ok: false, message: 'geo_map_district_codes 不是合法的 JSON 陣列' }; }
      }
    }
    if (!Array.isArray(arr) || !arr.every((x) => typeof x === 'string')) {
      return { ok: false, message: 'geo_map_district_codes 必須是字串陣列' };
    }
  }

  if (b.geo_map_bounds !== undefined) {
    let bounds = b.geo_map_bounds;
    if (typeof bounds === 'string') {
      if (bounds.trim() === '') bounds = null;
      else {
        try { bounds = JSON.parse(bounds); } catch (e) { return { ok: false, message: 'geo_map_bounds 不是合法的 JSON' }; }
      }
    }
    const check = validateGeoMapBounds(bounds);
    if (!check.ok) return check;
  }

  if (b.geo_map_geojson_source !== undefined && b.geo_map_geojson_source !== null && String(b.geo_map_geojson_source).trim() !== '') {
    if (isUnsafeSourceUrl(b.geo_map_geojson_source)) {
      return { ok: false, message: 'geo_map_geojson_source 不允許任意外部或不安全來源，只能是系統白名單內的站內相對路徑' };
    }
  }

  if (b.geo_map_auto_fit_bounds !== undefined) {
    const v = String(b.geo_map_auto_fit_bounds).toLowerCase();
    if (!['0', '1', 'true', 'false'].includes(v)) {
      return { ok: false, message: 'geo_map_auto_fit_bounds 必須是布林值' };
    }
  }

  return { ok: true };
}

function _safeJsonParse(raw, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  if (typeof raw !== 'string') return raw;
  try { return JSON.parse(raw); } catch (e) { return fallback; }
}

// 把「整份 store settings key-value」轉成 GET /api/settings/geo-map 的回應
// 形狀（需求文件五）。優先沿用既有 store_lat/store_lng（需求文件三），不
// 重複存一份座標。任何解析失敗一律安全退回 GEO_MAP_DEFAULTS，不拋錯、不讓
// 地圖因為設定格式壞掉就整段消失（需求文件十三）。
function parseGeoMapSettingsRow(rawSettings) {
  const s = rawSettings || {};

  const scopeModeRaw = s.geo_map_scope_mode;
  const scopeMode = GEO_MAP_SCOPE_MODES.includes(scopeModeRaw) ? scopeModeRaw : GEO_MAP_DEFAULTS.geo_map_scope_mode;

  const zoomRaw = Number(s.geo_map_default_zoom);
  const zoom = Number.isFinite(zoomRaw) && zoomRaw >= ZOOM_MIN && zoomRaw <= ZOOM_MAX ? zoomRaw : GEO_MAP_DEFAULTS.geo_map_default_zoom;

  let districtCodes = _safeJsonParse(s.geo_map_district_codes, []);
  if (!Array.isArray(districtCodes)) districtCodes = [];
  districtCodes = districtCodes.filter((x) => typeof x === 'string');

  let bounds = _safeJsonParse(s.geo_map_bounds, null);
  const boundsCheck = validateGeoMapBounds(bounds);
  bounds = boundsCheck.ok ? boundsCheck.value : null;

  const cityCode = (s.geo_map_city_code !== undefined && s.geo_map_city_code !== null && s.geo_map_city_code !== '') ? String(s.geo_map_city_code) : null;
  const geojsonSource = (s.geo_map_geojson_source !== undefined && s.geo_map_geojson_source !== null && s.geo_map_geojson_source !== '') ? String(s.geo_map_geojson_source) : null;

  const autoFitRaw = s.geo_map_auto_fit_bounds;
  const autoFitBounds = (autoFitRaw === undefined || autoFitRaw === null || autoFitRaw === '')
    ? GEO_MAP_DEFAULTS.geo_map_auto_fit_bounds
    : !(String(autoFitRaw) === '0' || String(autoFitRaw).toLowerCase() === 'false');

  const latRaw = s.store_lat;
  const lngRaw = s.store_lng;
  const lat = (latRaw !== undefined && latRaw !== null && String(latRaw).trim() !== '' && Number.isFinite(Number(latRaw))) ? Number(latRaw) : null;
  const lng = (lngRaw !== undefined && lngRaw !== null && String(lngRaw).trim() !== '' && Number.isFinite(Number(lngRaw))) ? Number(lngRaw) : null;

  return {
    scope_mode: scopeMode,
    default_zoom: zoom,
    store_location: { lat, lng },
    city_code: cityCode,
    district_codes: districtCodes,
    bounds,
    geojson_source: geojsonSource,
    auto_fit_bounds: autoFitBounds,
  };
}

// 需求文件八：單一 pure helper，決定地圖初始 viewport（優先順序完全依
// scope_mode 決定該用哪一組資料，資料無效時一律落到台灣全域 fallback，
// 不得混用其他模式的資料、不得 fallback 桃園）。
function geoResolveInitialViewport(options) {
  const o = options || {};
  const autoFit = o.autoFitBounds !== false;
  const fallback = { type: 'center', center: GEO_MAP_TAIWAN_FALLBACK.center, zoom: GEO_MAP_TAIWAN_FALLBACK.zoom, source: 'taiwan_fallback' };

  if (o.scopeMode === 'custom_bounds') {
    if (autoFit && _isValidBoundsObj(o.customBounds)) return { type: 'bounds', bounds: o.customBounds, source: 'custom_bounds' };
    return fallback;
  }
  if (o.scopeMode === 'districts') {
    if (autoFit && _isValidBoundsObj(o.districtBounds)) return { type: 'bounds', bounds: o.districtBounds, source: 'districts' };
    return fallback;
  }
  if (o.scopeMode === 'data_bounds') {
    if (autoFit && _isValidBoundsObj(o.dataBounds)) return { type: 'bounds', bounds: o.dataBounds, source: 'data_bounds' };
    return fallback;
  }
  if (o.scopeMode === 'store_location') {
    if (Number.isFinite(o.storeLat) && Number.isFinite(o.storeLng)) {
      return { type: 'center', center: [o.storeLat, o.storeLng], zoom: Number.isFinite(o.zoom) ? o.zoom : GEO_MAP_DEFAULTS.geo_map_default_zoom, source: 'store_location' };
    }
    return fallback;
  }
  return fallback;
}
function _isValidBoundsObj(b) {
  if (!b || typeof b !== 'object') return false;
  const { south, west, north, east } = b;
  return [south, west, north, east].every((v) => typeof v === 'number' && Number.isFinite(v))
    && south < north && west < east && south >= -90 && north <= 90 && west >= -180 && east <= 180;
}

// 需求文件七：GeoJSON 邊界來源解析——只依 settings.city_code 在 manifest 內查表，
// 沒有對應就不載入邊界（不得自動 fallback 桃園），且來源必須通過安全檢查。
function geoResolveBoundarySource(settings, manifest) {
  const s = settings || {};
  const m = manifest || {};
  const cities = m.cities || {};
  if (!s.city_code) return null;
  const entry = cities[s.city_code];
  if (!entry || !entry.source) return null;
  const src = String(entry.source);
  if (isUnsafeSourceUrl(src)) return null;
  return src;
}

module.exports = {
  GEO_MAP_SCOPE_MODES,
  GEO_MAP_SETTINGS_KEYS,
  GEO_MAP_DEFAULTS,
  GEO_MAP_TAIWAN_FALLBACK,
  isUnsafeSourceUrl,
  validateGeoMapBounds,
  validateGeoMapSettingsPatch,
  parseGeoMapSettingsRow,
  geoResolveInitialViewport,
  geoResolveBoundarySource,
};
