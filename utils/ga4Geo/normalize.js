// utils/ga4Geo/normalize.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// GA4 城市彙總 → 台灣行政區 正規化轉接層。
//
// 不建立第二套台灣地名表（需求文件六）：完全沿用既有
// utils/taiwanGeoNormalize.js 的 resolveTaiwanAdministrativeArea()，這裡只
// 負責「把 GA4 country/region/city 三個 dimension 轉成該函式期待的
// 輸入形狀」，以及把回傳的 resolution 轉成本輪資料表要的
// normalization_status / administrative_level 欄位。
//
// GA4 的 city dimension 在台灣資料通常回傳「鄉鎮市區」層級（例如
// "Zhongli District"），region dimension 回傳「縣市」層級（例如
// "Taoyuan City"）——對應既有 resolver 的 district / region 參數，不是
// city 參數（city 參數在既有 resolver 裡代表縣市層級，命名沿用 R5.1-D
// 舊介面，見 taiwanGeoNormalize.js 內註解）。

'use strict';

const { resolveTaiwanAdministrativeArea } = require('../taiwanGeoNormalize');
const { resolveAdministrativeRepresentativePoint } = require('../authoritativeAdminPointCatalog');

const NOT_SET_VALUES = new Set(['(not set)', 'unknown', '', 'not set', 'null', 'undefined']);

function _isNotSet(v) {
  if (v === null || v === undefined) return true;
  return NOT_SET_VALUES.has(String(v).trim().toLowerCase());
}

function buildRawLocationKey({ country, region, city }) {
  const c = _isNotSet(country) ? '(not set)' : String(country).trim();
  const r = _isNotSet(region) ? '(not set)' : String(region).trim();
  const ci = _isNotSet(city) ? '(not set)' : String(city).trim();
  return `${c.toLowerCase()}||${r.toLowerCase()}||${ci.toLowerCase()}`;
}

function _isTaiwanCountry(country) {
  if (_isNotSet(country)) return null; // 無法判斷（country dimension 缺失）
  const n = String(country).trim().toLowerCase();
  return n === 'taiwan' || n === 'tw';
}

// normalizeGa4Location({ country, region, city }) →
//   {
//     raw_location_key, country_raw, region_raw, city_raw,
//     country_code, county_code, county_name, district_code, district_name,
//     normalization_status: 'ok'|'ambiguous'|'unknown'|'overseas_or_other',
//     administrative_level: 'district'|'county'|null,
//   }
// 絕不猜測（見需求文件六）：ambiguous 一律回傳 ambiguous，不挑一個候選塞進去。
function normalizeGa4Location({ country, region, city } = {}) {
  const raw_location_key = buildRawLocationKey({ country, region, city });
  const base = {
    raw_location_key,
    country_raw: country === undefined ? null : country,
    region_raw: region === undefined ? null : region,
    city_raw: city === undefined ? null : city,
  };

  const allNotSet = _isNotSet(country) && _isNotSet(region) && _isNotSet(city);
  if (allNotSet) {
    return {
      ...base,
      country_code: null, county_code: null, county_name: null,
      district_code: null, district_name: null,
      normalization_status: 'unknown', administrative_level: null,
    };
  }

  const taiwanCheck = _isTaiwanCountry(country);
  if (taiwanCheck === false) {
    // 明確非台灣國家 → overseas_or_other，完全不套用台灣 Catalog（需求文件六）。
    return {
      ...base,
      country_code: null, county_code: null, county_name: null,
      district_code: null, district_name: null,
      normalization_status: 'overseas_or_other', administrative_level: null,
    };
  }

  // country 是 Taiwan，或 country dimension 缺失（沿用既有 resolver 預設行為：
  // 缺失時視為 TW，見 taiwanGeoNormalize.js resolveTaiwanAdministrativeArea()
  // 內 base.country_code 邏輯）。
  const resolved = resolveTaiwanAdministrativeArea({
    country: taiwanCheck ? 'TW' : undefined,
    region: _isNotSet(region) ? undefined : region,
    district: _isNotSet(city) ? undefined : city,
  });

  if (resolved.resolution === 'subdivision') {
    return {
      ...base,
      country_code: 'TW',
      county_code: resolved.county_code, county_name: resolved.county_name,
      district_code: resolved.subdivision_code, district_name: resolved.subdivision_name,
      normalization_status: 'ok', administrative_level: 'district',
    };
  }
  if (resolved.resolution === 'county') {
    return {
      ...base,
      country_code: 'TW',
      county_code: resolved.county_code, county_name: resolved.county_name,
      district_code: null, district_name: null,
      normalization_status: 'ok', administrative_level: 'county',
    };
  }
  if (resolved.resolution === 'ambiguous') {
    return {
      ...base,
      country_code: 'TW', county_code: null, county_name: null,
      district_code: null, district_name: null,
      normalization_status: 'ambiguous', administrative_level: null,
    };
  }
  // resolved.resolution === 'unknown'
  return {
    ...base,
    country_code: taiwanCheck ? 'TW' : null,
    county_code: null, county_name: null, district_code: null, district_name: null,
    normalization_status: 'unknown', administrative_level: null,
  };
}

// resolveMarkerPoint(normalizedRow) → representative point row | null
// 只在 normalization_status==='ok' 時才查表（ambiguous/unknown/overseas 一律
// 不畫 Marker，見需求文件十三）。
function resolveMarkerPoint(row) {
  if (!row || row.normalization_status !== 'ok') return null;
  return resolveAdministrativeRepresentativePoint({
    district_code: row.district_code,
    county_code: row.county_code,
    county_name: row.county_name,
  });
}

module.exports = { normalizeGa4Location, buildRawLocationKey, resolveMarkerPoint, _isNotSet };
