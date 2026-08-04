// utils/ga4Realtime/requestBuilder.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime Report — Request Builder（純函式，不呼叫 SDK/網路，方便單元
// 測試每一種 dimensions/metrics/filter/minuteRanges 組合是否正確）。
//
// 兩種 Request（見需求文件五）：
//   Summary Request：無 dimensions，只回官方加總的 activeUsers/eventCount，
//     是 total_active_users_ga4 唯一合法來源（不得從 City Request 的 rows
//     加總得出）。
//   City Request：city/cityId/country/countryId 四個維度，供地圖聚合/
//     mapping／unmapped 分析用，其 activeUsers 只代表該 row 自己的數值。

'use strict';

const GA4_REALTIME_WINDOWS = Object.freeze([5, 30]);

// 需求文件七：Metric Mapping——單一權威常數，client/route/測試都只讀這裡。
const GA4_REALTIME_METRICS = Object.freeze({
  visitors:    { eventName: null,             includeScreenPageViews: true },
  view_item:   { eventName: 'view_item',       includeScreenPageViews: false },
  add_to_cart: { eventName: 'add_to_cart',      includeScreenPageViews: false },
  checkout:    { eventName: 'begin_checkout',   includeScreenPageViews: false },
  purchase:    { eventName: 'purchase',         includeScreenPageViews: false },
});
const GA4_REALTIME_METRIC_KEYS = Object.freeze(Object.keys(GA4_REALTIME_METRICS));

function isSupportedGa4Metric(metric) {
  return GA4_REALTIME_METRIC_KEYS.includes(metric);
}

// buildGa4MinuteRanges(windowMinutes) → { ok, minuteRanges|code }
function buildGa4MinuteRanges(windowMinutes) {
  if (!GA4_REALTIME_WINDOWS.includes(windowMinutes)) {
    return { ok: false, code: 'invalid_window' };
  }
  if (windowMinutes === 5) {
    return { ok: true, minuteRanges: [{ name: 'last_5_minutes', startMinutesAgo: 4, endMinutesAgo: 0 }] };
  }
  return { ok: true, minuteRanges: [{ name: 'last_30_minutes', startMinutesAgo: 29, endMinutesAgo: 0 }] };
}

function _exactStringFilter(fieldName, value) {
  return { filter: { fieldName, stringFilter: { matchType: 'EXACT', value: String(value) } } };
}

// buildGa4DimensionFilter({ streamId, eventName }) → dimensionFilter 物件或
// null（兩者都沒有時不加 filter）。呼叫端必須先驗證過 streamId/eventName
// 本身合法，這裡不做驗證，只負責組合結構（見需求文件八：純函式，只測試
// 組合邏輯）。
function buildGa4DimensionFilter({ streamId, eventName } = {}) {
  const hasStream = streamId !== undefined && streamId !== null && String(streamId).trim() !== '';
  const hasEvent = eventName !== undefined && eventName !== null && String(eventName).trim() !== '';
  if (!hasStream && !hasEvent) return null;
  if (hasStream && !hasEvent) return _exactStringFilter('streamId', streamId);
  if (!hasStream && hasEvent) return _exactStringFilter('eventName', eventName);
  return {
    andGroup: {
      expressions: [
        _exactStringFilter('streamId', streamId),
        _exactStringFilter('eventName', eventName),
      ],
    },
  };
}

// buildGa4RealtimeSummaryRequest({ propertyId, streamId, windowMinutes, metric })
//   → { ok, request } 或 { ok:false, code }
function buildGa4RealtimeSummaryRequest({ propertyId, streamId, windowMinutes, metric }) {
  if (!isSupportedGa4Metric(metric)) return { ok: false, code: 'unsupported_metric' };
  const rangeResult = buildGa4MinuteRanges(windowMinutes);
  if (!rangeResult.ok) return rangeResult;

  const metricDef = GA4_REALTIME_METRICS[metric];
  const metrics = [{ name: 'activeUsers' }, { name: 'eventCount' }];
  if (metricDef.includeScreenPageViews) metrics.push({ name: 'screenPageViews' });

  const dimensionFilter = buildGa4DimensionFilter({ streamId, eventName: metricDef.eventName });

  return {
    ok: true,
    request: {
      property: `properties/${propertyId}`,
      dimensions: [],
      metrics,
      ...(dimensionFilter ? { dimensionFilter } : {}),
      minuteRanges: rangeResult.minuteRanges,
      returnPropertyQuota: true,
    },
  };
}

// buildGa4RealtimeCityRequest({ propertyId, streamId, windowMinutes, metric })
//
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：最小化為 city／countryId 兩個維度
// （見 R5.4-G1.5-B2.4_CITY_REQUEST_REALITY_AUDIT.md 第三節）。
//   - _aggregateCityRows() 實際只讀取 city／countryId，cityId／country 從
//     未被使用，是多餘、未使用的正式 Request 維度。
//   - 縮減維度＝縮減 GA4 Realtime Dimensions 相容性風險與回應大小，且不
//     影響既有 County Mapping（county mapping 只吃 city 字串）。
//   - _aggregateCityRows() 對「舊格式」（city/cityId/country/countryId 四
//     維）仍向後相容——它用 dimensionHeaders.indexOf() 找欄位位置，找不到
//     的欄位回 -1 也不會出錯，所以舊 fixture／舊 cache entry 一樣能解析。
function buildGa4RealtimeCityRequest({ propertyId, streamId, windowMinutes, metric }) {
  if (!isSupportedGa4Metric(metric)) return { ok: false, code: 'unsupported_metric' };
  const rangeResult = buildGa4MinuteRanges(windowMinutes);
  if (!rangeResult.ok) return rangeResult;

  const metricDef = GA4_REALTIME_METRICS[metric];
  const dimensionFilter = buildGa4DimensionFilter({ streamId, eventName: metricDef.eventName });

  return {
    ok: true,
    request: {
      property: `properties/${propertyId}`,
      dimensions: [{ name: 'city' }, { name: 'countryId' }],
      metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      ...(dimensionFilter ? { dimensionFilter } : {}),
      minuteRanges: rangeResult.minuteRanges,
      returnPropertyQuota: true,
    },
  };
}

module.exports = {
  GA4_REALTIME_WINDOWS,
  GA4_REALTIME_METRICS,
  GA4_REALTIME_METRIC_KEYS,
  isSupportedGa4Metric,
  buildGa4MinuteRanges,
  buildGa4DimensionFilter,
  buildGa4RealtimeSummaryRequest,
  buildGa4RealtimeCityRequest,
};
