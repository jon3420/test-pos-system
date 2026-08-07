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

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT：Realtime Event Metric
// Request Compatibility 修正（見 R5.4-G1.6-GA4-H1.3-EVENT-COMPAT_REALITY_AUDIT.md
// 五～十）。正式環境 view_item／add_to_cart／begin_checkout／purchase 這四個
// Event Metric 全部在 Summary／City Request 上失敗，唯一共同點是：兩者都對
// `eventName` 下了 dimensionFilter，但『eventName 本身完全沒有出現在
// dimensions 陣列裡』（Variant A）。GA4 Realtime Data API（BetaAnalyticsDataClient
// runRealtimeReport）對「filter 引用了未輸出的維度」的相容性沒有公開明確
// 保證，且正式環境的失敗模式與此假設一致；因此本輪預設改用 Variant B——
// filter 用到的維度（eventName／streamId）一律同時列進 dimensions（見
// buildRealtimeDimensions()）。visitors 完全不受影響（visitors 沒有
// eventName filter，見 GA4_REALTIME_METRICS.visitors.eventName === null）。
//
// 若部署後 Manual Diagnostic（scripts/run-g1-6-ga4-h1-3-realtime-event-compat.js
// 產生的正式診斷指令＋POST /api/geo-live/ga4-realtime-test 新增的
// view_item_ok／add_to_cart_ok／checkout_ok／purchase_ok 欄位）證明 Variant B
// 仍然失敗，改用 Variant C（只作診斷 fallback，見需求文件五 Variant C：
// dimensions 加 eventName 但不下 filter，後端只挑選 row.eventName===
// requestedEvent）需要另開一輪 hotfix，不得在本檔案外的地方繞過
// buildRealtimeDimensions() 自行組 Request（需求文件十：Pure Function 邊界）。
const GA4_REQUEST_VARIANT = 'B';

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

// buildRealtimeDimensions(baseDimensions, { eventName, streamId }) → dimensions[]
//
// 純函式（見需求文件十）：只在「這個 Request 真的會對 eventName 下
// dimensionFilter」（即 eventName 有值，例如 view_item/add_to_cart/
// begin_checkout/purchase）時，才把 eventName（＋streamId，若也有值）
// 一併加進 dimensions，讓 filter 引用的每個維度都同時是輸出維度
// （Variant B，見上方檔案頂部說明）。
//
// visitors 完全不受影響：visitors 的 eventName 一律是 null／undefined，
// hasEvent 為 false，這個函式直接原樣回傳 baseDimensions（不新增任何維度，
// 即使 streamId 有值）——刻意如此，因為既有 G1.5-A Request Builder Contract
// （B13/B14，見 scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js）
// 明確要求 visitors 的 Summary Request 維持 0 個 dimensions、City Request
// 維持恰好 city/countryId 兩個維度，不因為店家設定了 Stream 就多出
// streamId 維度。
function buildRealtimeDimensions(baseDimensions, { eventName, streamId } = {}) {
  const dims = Array.isArray(baseDimensions) ? baseDimensions.slice() : [];
  const hasEvent = eventName !== undefined && eventName !== null && String(eventName).trim() !== '';
  if (!hasEvent) return dims;
  const hasStream = streamId !== undefined && streamId !== null && String(streamId).trim() !== '';
  dims.push({ name: 'eventName' });
  if (hasStream) dims.push({ name: 'streamId' });
  return dims;
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

  const request = {
    property: `properties/${propertyId}`,
    dimensions: [],
    metrics,
    ...(dimensionFilter ? { dimensionFilter } : {}),
    minuteRanges: rangeResult.minuteRanges,
    returnPropertyQuota: true,
  };
  // Variant B（見檔案頂部＋buildRealtimeDimensions() 說明）：eventName 有值
  // 時才把它（＋streamId）併入 dimensions；visitors（eventName===null）
  // 維持 dimensions:[]，不受影響。
  request.dimensions = buildRealtimeDimensions(request.dimensions, { eventName: metricDef.eventName, streamId });

  return { ok: true, request };
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

  const request = {
    property: `properties/${propertyId}`,
    dimensions: [{ name: 'city' }, { name: 'countryId' }],
    metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
    ...(dimensionFilter ? { dimensionFilter } : {}),
    minuteRanges: rangeResult.minuteRanges,
    returnPropertyQuota: true,
  };
  // Variant B：同上，event metric 才會多出 eventName（＋streamId）維度；
  // visitors 維持恰好 city/countryId 兩個維度（見 buildRealtimeDimensions()
  // 說明／G1.5-A B14 Contract）。_aggregateCityRows() 是 Header-based
  // （dimensionHeaders.indexOf()），多出的維度不影響既有解析（需求文件十二）。
  request.dimensions = buildRealtimeDimensions(request.dimensions, { eventName: metricDef.eventName, streamId });

  return { ok: true, request };
}

module.exports = {
  GA4_REQUEST_VARIANT,
  GA4_REALTIME_WINDOWS,
  GA4_REALTIME_METRICS,
  GA4_REALTIME_METRIC_KEYS,
  isSupportedGa4Metric,
  buildGa4MinuteRanges,
  buildGa4DimensionFilter,
  buildRealtimeDimensions,
  buildGa4RealtimeSummaryRequest,
  buildGa4RealtimeCityRequest,
};
