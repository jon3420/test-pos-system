// utils/geoAnalyticsFilters.js — fix18-10-hotfix30-B5-R5.1-B
// Geo Event Wiring × Geo Analytics API × Data Quality — 第六階段：共用篩選與驗證
//
// 單一集中的 query-string → 篩選物件解析器，供 routes/analytics-geo.js 的所有
// endpoint 共用。原則（需求文件第六階段）：
//   - 列舉欄位（geo_context / geo_source / geo_confidence）必須白名單，非法值
//     一律當作「未篩選」處理（不報錯、不當機），不得把 query 值直接拼進 SQL。
//   - page >= 1，limit 預設 50、最大 100。
//   - 日期沿用 utils/dashboardDate.js 的 Asia/Taipei / resolveDateRange()，
//     不創造第二套時區口徑（需求文件九之 8）。
//   - 排序欄位（若支援）一律用固定映射，不接受 `ORDER BY ${req.query.sort}`
//     這種字串拼接。

'use strict';

const { resolveDateRange, DashboardDateError } = require('./dashboardDate');
const { GEO_CONTEXT_VALUES, GEO_SOURCE_VALUES, GEO_CONFIDENCE_VALUES } = require('./geoConstants');
const { ORDER_CHANNELS } = require('./channelResolver');

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

class GeoAnalyticsFilterError extends Error {}

function _sanitizeEnum(value, allowedValues) {
  if (value === undefined || value === null || value === '') return null;
  const s = String(value).trim();
  return allowedValues.includes(s) ? s : null; // 非法值 → 當作未篩選，不報錯
}

function _sanitizeStr(value, maxLen = 100) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// query.date_from / query.date_to 是本 API 系列的命名（需求文件），內部轉呼叫
// resolveDateRange({ preset:'custom', start_date, end_date }) 沿用同一套
// Asia/Taipei 驗證與邊界計算邏輯，不重寫日期規則。未提供時預設「今天」。
function parseGeoAnalyticsFilters(query = {}) {
  let range;
  try {
    if (query.date_from || query.date_to) {
      range = resolveDateRange({
        preset: 'custom',
        start_date: query.date_from,
        end_date: query.date_to,
      });
    } else {
      range = resolveDateRange({ preset: 'today' });
    }
  } catch (e) {
    if (e instanceof DashboardDateError) throw new GeoAnalyticsFilterError(e.message);
    throw e;
  }

  let page = Number(query.page);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.floor(page);

  let limit = Number(query.limit);
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_LIMIT;
  limit = Math.min(Math.floor(limit), MAX_LIMIT);

  const channel = _sanitizeEnum(query.channel, [...ORDER_CHANNELS, 'all']);

  return {
    range,
    page,
    limit,
    offset: (page - 1) * limit,
    channel: channel && channel !== 'all' ? channel : null,
    source: _sanitizeStr(query.source, 100),
    medium: _sanitizeStr(query.medium, 100),
    campaign: _sanitizeStr(query.campaign, 200),
    geo_context: _sanitizeEnum(query.geo_context, GEO_CONTEXT_VALUES),
    geo_source: _sanitizeEnum(query.geo_source, GEO_SOURCE_VALUES),
    geo_confidence: _sanitizeEnum(query.geo_confidence, GEO_CONFIDENCE_VALUES),
    city: _sanitizeStr(query.city, 100),
    district: _sanitizeStr(query.district, 100),
  };
}

// 固定排序欄位映射（第六階段：禁止 `ORDER BY ${req.query.sort}`）。
// 目前 Geo API 尚未對外開放自訂排序（回傳固定聚合結果，由前端自行排序/分頁
// 顯示），這裡先建立映射表與驗證函式，供未來真的要支援排序參數時使用，
// 避免屆時又臨時手動拼字串。
const SORT_COLUMNS = Object.freeze({
  visitors: 'visitors',
  conversion_rate: 'conversion_rate',
  revenue: 'revenue',
  submitted_orders: 'submitted_orders',
});
function resolveSortColumn(key, fallback = 'visitors') {
  return Object.prototype.hasOwnProperty.call(SORT_COLUMNS, key) ? SORT_COLUMNS[key] : fallback;
}

module.exports = {
  parseGeoAnalyticsFilters,
  GeoAnalyticsFilterError,
  SORT_COLUMNS,
  resolveSortColumn,
  DEFAULT_LIMIT,
  MAX_LIMIT,
};
