// utils/geoResolver.js — fix18-10-hotfix30-B5-R5.1-A Geo Data Foundation
//
// 兩條完全分開的解析路徑（二、Visitor Geo 與 Delivery Geo 必須分開）：
//   resolveVisitorGeo()   — IP 推定，供 page_view / view_item / add_to_cart /
//                           begin_checkout / LINE redirect 前行為使用。
//   normalizeDeliveryGeo()— 正式地址解析，供 delivery address entered /
//                           submit_order / purchase / delivery fee /
//                           delivery distance / out_of_range 使用。
// 呼叫端（utils/analyticsLog.js insertEvent()）必須依事件類型只呼叫其中一種，
// 不得把兩者結果寫進同一組「不知道是推定還是正式地址」的欄位。

'use strict';

const {
  GEO_SOURCE, GEO_CONFIDENCE, GEO_RESOLUTION, GEO_CONTEXT, GEO_VERSION_CURRENT,
  UNKNOWN_GEO, distanceBandFor,
} = require('./geoConstants');
const { getTrustedClientIp, truncateIpForResolution } = require('./geoSanitizer');
const { getGeoFeatureFlags } = require('./geoFeatureFlags');

// ── IP → 行政區 provider（可插拔，本輪預設無 provider）───────────────────
// 專案盤點結論：目前 package.json 沒有任何 IP geolocation 套件/服務設定
// （無 GEO_IP_PROVIDER、無對應 API key），且 sandbox/部署網路清單也未包含
// 任何 IP geolocation 供應商網域。本輪 R5.1-A 的責任是把「介面、隱私規則、
// unknown fallback、欄位模型」建好且可回滾；實際要串接哪一家 IP geolocation
// 服務（MaxMind GeoLite2 本地資料庫、ipapi、廠商 API…）需要另外決定供應商與
// 授權方式，不在本輪臆測。預設 provider 一律回傳 unknown，不影響任何既有流程。
let _ipGeoProvider = async function _defaultIpGeoProvider(_truncatedIp) {
  return null; // 尚未設定 provider → 一律視為無法判定
};

// 供未來（R5.1-B 或部署設定階段）注入真正的 provider，例如：
//   setIpGeoProvider(async (truncatedIpCidr) => ({ country, region, city, confidence }));
// provider 只會收到已截斷、不可定位單一使用者的 IP/CIDR（見 truncateIpForResolution），
// 絕對不會收到完整原始 IP。
function setIpGeoProvider(fn) {
  if (typeof fn === 'function') _ipGeoProvider = fn;
}

// req 是否存在信任層級足夠讓我們相信 header 沒被客戶端偽造，本輪保守回傳
// getTrustedClientIp() 的結果即可（見 geoSanitizer.js 說明），不做額外猜測。
async function resolveVisitorGeo(req, flagsOverride) {
  const flags = flagsOverride || getGeoFeatureFlags();

  // 全域關閉 IP Geo → 一律 unknown，完全不觸碰任何 IP header（隱私原則最保守路徑）
  if (!flags.GEO_VISITOR_IP_ENABLED) {
    return { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };
  }

  try {
    const rawIp = getTrustedClientIp(req);
    if (!rawIp) return { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };

    const truncated = truncateIpForResolution(rawIp);
    if (!truncated) return { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };

    const resolved = await _ipGeoProvider(truncated);
    if (!resolved || (!resolved.city && !resolved.region && !resolved.country)) {
      return { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };
    }

    // IP 縣市 → medium；IP 只到行政區/國家層級 → low（建議規則，見需求文件三）
    const resolution = resolved.city ? GEO_RESOLUTION.CITY
      : resolved.region ? GEO_RESOLUTION.REGION
      : resolved.country ? GEO_RESOLUTION.COUNTRY
      : GEO_RESOLUTION.UNKNOWN;
    const confidence = resolved.city ? GEO_CONFIDENCE.MEDIUM
      : GEO_CONFIDENCE.LOW;

    return {
      geo_country: resolved.country || null,
      geo_region: resolved.region || null,
      geo_city: resolved.city || null,
      geo_district: null, // IP 推定不承諾到區級，避免假裝比實際更精確
      geo_postal_code: null,
      geo_source: GEO_SOURCE.IP,
      geo_confidence: confidence,
      geo_resolution: resolution,
      // fix18-10-hotfix30-B5-R5.1-B：Visitor Geo 一律 geo_context='visitor'，
      // 且 Visitor Geo 絕不帶距離欄位（三、資料模型補強——不得用 IP 座標/推定
      // 位置計算店家距離）。
      geo_context: GEO_CONTEXT.VISITOR,
      geo_version: GEO_VERSION_CURRENT,
    };
  } catch (e) {
    // 任何失敗都退回 unknown，絕不讓 Geo 解析影響事件寫入或拋出例外
    return { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };
  }
}

// ── 正式地址 → Geo 維度（Google Maps 地址解析 / 正式訂單地址 / 結構化欄位）───
// Google Geocoding API 的 address_components 才有結構化的
// administrative_area_level_1（縣市）/ level_2 或 level_3（鄉鎮市區）/
// locality / postal_code。專案盤點結論：現有 routes/maps.js 的
// /api/maps/geocode 目前只回傳 { lat, lng, formatted_address }，尚未把
// Google 回應的 address_components 往下傳。本函式依優先序支援三種輸入：
//   (a) 直接提供 city/district（例：routes/line-shipping.js 訂單本來就有
//       結構化的 shipping_city/shipping_district 欄位，來自前端下拉選單，
//       不需要地址解析——confidence 直接視為 high）。
//   (b) 已有 address_components（未來 maps.js 補上 fields 後可直接餵）。
//   (c) 只有 formatted_address 字串時，用台灣地址慣例的「市/縣＋區/鄉/鎮」
//       粗略切出 city/district（confidence 降級為 medium，resolution 降到
//       city，不假裝是 high/district，避免資料可信度虛報）。
// geoContext 未指定時依 source 推定預設值（向後相容 R5.1-A 既有呼叫端）：
// delivery_address → fulfillment；shipping_address → shipping。
function normalizeDeliveryGeo({
  source, geoContext, addressComponents, formattedAddress,
  city: directCity, district: directDistrict, postalCode: directPostal,
  distanceKm, deliveryZone,
} = {}) {
  if (source !== GEO_SOURCE.DELIVERY_ADDRESS && source !== GEO_SOURCE.SHIPPING_ADDRESS) {
    return { ...UNKNOWN_GEO };
  }
  const context = geoContext || (source === GEO_SOURCE.SHIPPING_ADDRESS ? GEO_CONTEXT.SHIPPING : GEO_CONTEXT.FULFILLMENT);
  if (context !== GEO_CONTEXT.FULFILLMENT && context !== GEO_CONTEXT.SHIPPING) {
    // 防禦性：正式地址只允許代表履約或宅配用途，不得被誤標成 visitor/gps。
    return { ...UNKNOWN_GEO };
  }

  let city = null, district = null, region = null, country = null, postal = null;
  let resolution = GEO_RESOLUTION.UNKNOWN;
  let confidence = GEO_CONFIDENCE.UNKNOWN;

  if ((directCity && String(directCity).trim()) || (directDistrict && String(directDistrict).trim())) {
    city = directCity ? String(directCity).trim() : null;
    district = directDistrict ? String(directDistrict).trim() : null;
    postal = directPostal ? String(directPostal).trim() : null;
    if (district) { resolution = GEO_RESOLUTION.DISTRICT; confidence = GEO_CONFIDENCE.HIGH; }
    else if (city) { resolution = GEO_RESOLUTION.CITY; confidence = GEO_CONFIDENCE.HIGH; }
  } else if (Array.isArray(addressComponents) && addressComponents.length > 0) {
    // fix18-10-hotfix30-B5-R5.1-B（第四階段）：台灣行政區 fallback 優先順序——
    //   district: administrative_area_level_3 → sublocality_level_1 → sublocality
    //   city:     administrative_area_level_2 → locality
    //   region:   administrative_area_level_1
    // 用明確優先序查找，不是「陣列裡先出現哪個就用哪個」。
    const byType = (types) => {
      for (const t of types) {
        const hit = addressComponents.find((c) => Array.isArray(c.types) && c.types.includes(t));
        if (hit && hit.long_name) return hit.long_name;
      }
      return null;
    };
    country = byType(['country']);
    region = byType(['administrative_area_level_1']);
    city = byType(['administrative_area_level_2', 'locality']);
    district = byType(['administrative_area_level_3', 'sublocality_level_1', 'sublocality']);
    postal = byType(['postal_code']);
    if (district) { resolution = GEO_RESOLUTION.DISTRICT; confidence = GEO_CONFIDENCE.HIGH; }
    else if (city) { resolution = GEO_RESOLUTION.CITY; confidence = GEO_CONFIDENCE.HIGH; }
    else if (region) { resolution = GEO_RESOLUTION.REGION; confidence = GEO_CONFIDENCE.MEDIUM; }
  } else if (typeof formattedAddress === 'string' && formattedAddress.trim()) {
    // 粗略 fallback：只用字串樣式切「OO市/OO縣」＋「OO區/OO鄉/OO鎮/OO市」，
    // 抓不到就整組回 unknown，不猜測。中文字元範圍本身已涵蓋「台」與「臺」
    // 兩種寫法，不需要額外正規化（過度正規化反而可能把「臺北」誤寫成「台北」，
    // 與訂單原始地址不一致，故意保留原字）。
    const m = formattedAddress.match(/([\u4e00-\u9fa5]{2,3}[縣市])([\u4e00-\u9fa5]{1,4}[區鄉鎮市])?/);
    if (m) {
      city = m[1] || null;
      district = m[2] || null;
      if (district) { resolution = GEO_RESOLUTION.DISTRICT; confidence = GEO_CONFIDENCE.MEDIUM; }
      else if (city) { resolution = GEO_RESOLUTION.CITY; confidence = GEO_CONFIDENCE.MEDIUM; }
    }
  }

  // 只有 fulfillment/shipping 才允許帶距離（three、資料模型補強），這裡兩者都符合，
  // 但仍統一走 distanceBandFor()，避免各呼叫端各自算距離帶。
  const geo_distance_km = (distanceKm === null || distanceKm === undefined) ? null : Number(distanceKm);
  const geo_distance_band = distanceBandFor(geo_distance_km);

  return {
    geo_country: country,
    geo_region: region,
    geo_city: city,
    geo_district: district,
    geo_postal_code: postal,
    geo_source: source,
    geo_confidence: confidence,
    geo_resolution: resolution,
    geo_context: context,
    geo_version: GEO_VERSION_CURRENT,
    geo_distance_km: Number.isFinite(geo_distance_km) ? geo_distance_km : null,
    geo_distance_band,
    geo_delivery_zone: deliveryZone || null,
  };
}

// ── 共用的事件層 Geo 白名單（第一階段：line-orders.js / line-shipping.js 共用）──
// 無論 orderGeo 是從 normalizeDeliveryGeo() 或未來其他來源算出來的，寫進
// evtBase.geo 之前一律再過一次這個白名單，只留允許的 12 個欄位，防止任何
// 呼叫端不小心把 delivery_address / formatted_address / lat / lng / place_id /
// 顧客電話等敏感欄位夾帶進 analytics_events。傳入 null/undefined 時回傳
// unknown context（外帶等無履約地址情境）。
const FULFILLMENT_EVENT_GEO_FIELDS = [
  'geo_country', 'geo_region', 'geo_city', 'geo_district', 'geo_postal_code',
  'geo_source', 'geo_confidence', 'geo_resolution', 'geo_context', 'geo_version',
  'geo_distance_km', 'geo_distance_band', 'geo_delivery_zone',
];
function buildFulfillmentEventGeo(geo) {
  if (!geo || typeof geo !== 'object') {
    return { ...UNKNOWN_GEO, geo_distance_km: null, geo_distance_band: null, geo_delivery_zone: null };
  }
  const out = {};
  for (const f of FULFILLMENT_EVENT_GEO_FIELDS) out[f] = (f in geo) ? geo[f] : (UNKNOWN_GEO[f] ?? null);
  return out;
}

module.exports = {
  resolveVisitorGeo,
  normalizeDeliveryGeo,
  setIpGeoProvider,
  resolveVisitorGeoCached,
  buildFulfillmentEventGeo,
  _visitorGeoCacheSizeForTest: () => _visitorGeoCache.size,
};

// ── 呼叫頻率控制（七之 1：request/session/cache 層級的最少呼叫策略）──────
// 同一 visitor／同一匿名 session 在合理 TTL 內只解析一次，避免每個事件都
// 呼叫外部 IP geolocation provider。Cache key 用不可逆雜湊（sha256），不保存
// 完整 IP、也不保存明文 session_id／visitor_id，只是本次請求解析結果的
// 短期記憶體 cache（進場即建立、行程重啟即清空，不落地）。
const crypto = require('crypto');
const _visitorGeoCache = new Map(); // hashKey -> { geo, expiresAt }
const VISITOR_GEO_CACHE_TTL_MS = 15 * 60 * 1000; // 15 分鐘，合理 TTL，避免同一人整個瀏覽過程重複呼叫
const VISITOR_GEO_CACHE_MAX_ENTRIES = 5000; // 防止長時間運行下無限成長（fail-safe 上限，超過就整批清空）

function _hashCacheKey(storeId, sessionKey) {
  return crypto.createHash('sha256').update(`${storeId || ''}:${sessionKey || ''}`).digest('hex');
}

// 供 routes/analytics.js 等前台事件寫入路徑使用：cacheKey 建議傳
// `${storeId}:${session_id}`（未登入匿名使用者的合理去重單位）。
// provider timeout / error 一律 fail-open，回傳 unknown，不阻擋事件寫入。
async function resolveVisitorGeoCached(req, { storeId, sessionKey, flags } = {}) {
  const key = _hashCacheKey(storeId, sessionKey);
  const cached = _visitorGeoCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.geo;

  if (_visitorGeoCache.size > VISITOR_GEO_CACHE_MAX_ENTRIES) _visitorGeoCache.clear();

  let geo;
  try {
    geo = await resolveVisitorGeo(req, flags);
  } catch (e) {
    geo = { ...UNKNOWN_GEO, geo_context: GEO_CONTEXT.VISITOR };
  }
  _visitorGeoCache.set(key, { geo, expiresAt: Date.now() + VISITOR_GEO_CACHE_TTL_MS });
  return geo;
}
