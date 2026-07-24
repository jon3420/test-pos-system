// utils/geoConstants.js — fix18-10-hotfix30-B5-R5.1-A Geo Data Foundation
//
// 共用列舉常數。單一定義來源，避免 geoResolver / geoSanitizer / 未來的
// routes/analytics/geo/* 各自寫死字串造成不一致。

'use strict';

// 資料來源：IP 推定 vs 正式地址（絕不可混用）
const GEO_SOURCE = Object.freeze({
  IP: 'ip',
  DELIVERY_ADDRESS: 'delivery_address',
  SHIPPING_ADDRESS: 'shipping_address',
  GPS: 'gps',
  UNKNOWN: 'unknown',
});
const GEO_SOURCE_VALUES = Object.freeze(Object.values(GEO_SOURCE));

const GEO_CONFIDENCE = Object.freeze({
  HIGH: 'high',
  MEDIUM: 'medium',
  LOW: 'low',
  UNKNOWN: 'unknown',
});
const GEO_CONFIDENCE_VALUES = Object.freeze(Object.values(GEO_CONFIDENCE));

const GEO_RESOLUTION = Object.freeze({
  COUNTRY: 'country',
  REGION: 'region',
  CITY: 'city',
  DISTRICT: 'district',
  POSTAL_CODE: 'postal_code',
  COORDINATE: 'coordinate',
  UNKNOWN: 'unknown',
});
const GEO_RESOLUTION_VALUES = Object.freeze(Object.values(GEO_RESOLUTION));

// fix18-10-hotfix30-B5-R5.1-B：geo_context —— 這筆 Geo「代表什麼用途」，
// 跟 geo_source（「資料怎麼來」）是兩個不同維度，不得混用。
// visitor    = 進站 IP 推定區域（page_view/view_product/add_to_cart/begin_checkout）
// fulfillment= 外送正式履約地址
// shipping   = 宅配正式收件地址
// gps        = 顧客明確授權的裝置定位（本輪未實作來源，先保留列舉值）
// unknown    = 無法分類
const GEO_CONTEXT = Object.freeze({
  VISITOR: 'visitor',
  FULFILLMENT: 'fulfillment',
  SHIPPING: 'shipping',
  GPS: 'gps',
  UNKNOWN: 'unknown',
});
const GEO_CONTEXT_VALUES = Object.freeze(Object.values(GEO_CONTEXT));

// 只有這兩種 context 允許夾帶距離資訊（三、不刪除 geo_distance_km 但限制語意）。
const DISTANCE_ALLOWED_CONTEXTS = Object.freeze([GEO_CONTEXT.FULFILLMENT, GEO_CONTEXT.SHIPPING]);

// geo_version：目前 Geo 解析邏輯的版本號，供未來邏輯升級時分辨資料版本。
// R5.1-A 建立欄位時沒有寫入版本號的資料一律視為版本 1（見 db.js migration 註解與
// CHANGELOG_HOTFIX30_B5_R5_1_B 的「Geo Schema Version」章節，統一口徑：
// NULL === 1，讀取端一律用 `geo_version || 1` 正規化，不強制回填舊資料）。
const GEO_VERSION_CURRENT = 1;

// 距離帶（十、距離分析）
const DISTANCE_BANDS = Object.freeze([
  { key: '0-3km', min: 0, max: 3 },
  { key: '3-5km', min: 3, max: 5 },
  { key: '5-8km', min: 5, max: 8 },
  { key: '8-10km', min: 8, max: 10 },
  { key: '10-15km', min: 10, max: 15 },
  { key: '15km+', min: 15, max: Infinity },
]);
const DISTANCE_BAND_UNKNOWN = 'unknown';

function isValidGeoSource(v) { return GEO_SOURCE_VALUES.includes(v); }
function isValidGeoConfidence(v) { return GEO_CONFIDENCE_VALUES.includes(v); }
function isValidGeoResolution(v) { return GEO_RESOLUTION_VALUES.includes(v); }
function isValidGeoContext(v) { return GEO_CONTEXT_VALUES.includes(v); }

// 安全預設值：任何 resolver 失敗或資訊不足時一律退回這組值，
// 絕不臆測（不得依店家地址／訂單 channel／referrer／瀏覽器語言猜測區域）。
const UNKNOWN_GEO = Object.freeze({
  geo_country: null,
  geo_region: null,
  geo_city: null,
  geo_district: null,
  geo_postal_code: null,
  geo_source: GEO_SOURCE.UNKNOWN,
  geo_confidence: GEO_CONFIDENCE.UNKNOWN,
  geo_resolution: GEO_RESOLUTION.UNKNOWN,
  geo_context: GEO_CONTEXT.UNKNOWN,
  geo_version: GEO_VERSION_CURRENT,
});

// 讀取端正規化：舊資料 geo_version 可能是 NULL（R5.1-A 建欄位時尚未寫版本號），
// 統一視為版本 1，不強制回填舊資料（見 changelog「Geo Schema Version」）。
function normalizeGeoVersion(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : GEO_VERSION_CURRENT;
}

function distanceBandFor(km) {
  if (km === null || km === undefined || !Number.isFinite(Number(km)) || Number(km) < 0) {
    return DISTANCE_BAND_UNKNOWN;
  }
  const n = Number(km);
  for (const band of DISTANCE_BANDS) {
    if (n >= band.min && n < band.max) return band.key;
  }
  return DISTANCE_BAND_UNKNOWN;
}

module.exports = {
  GEO_SOURCE, GEO_SOURCE_VALUES,
  GEO_CONFIDENCE, GEO_CONFIDENCE_VALUES,
  GEO_RESOLUTION, GEO_RESOLUTION_VALUES,
  GEO_CONTEXT, GEO_CONTEXT_VALUES, DISTANCE_ALLOWED_CONTEXTS,
  GEO_VERSION_CURRENT,
  DISTANCE_BANDS, DISTANCE_BAND_UNKNOWN,
  isValidGeoSource, isValidGeoConfidence, isValidGeoResolution, isValidGeoContext,
  UNKNOWN_GEO, distanceBandFor, normalizeGeoVersion,
};
