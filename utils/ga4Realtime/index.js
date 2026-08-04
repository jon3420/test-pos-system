// utils/ga4Realtime/index.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime Visitor Geo Layer — Backend Orchestrator
//   Config Resolution × Summary/City Dual Request × Dedup × Cache ×
//   Single-flight × Retry × Stale Fallback × Quota × County Mapping
//
// 本輪（G1.5-A）修正 G1.5 草稿最嚴重的問題：total_active_users_ga4 不得從
// City rows 加總（見需求文件九）。正式規則：
//   summary.total_active_users_ga4  ← 只能來自「無 dimensions 的 Summary
//                                      Request」的官方 activeUsers。
//   counties[].active_users         ← 只代表該 county 自己聚合列的數值，
//                                      不得宣稱其加總等於 total。
//
// 不得出現的欄位（見需求文件九）：combined_total／total_visitors_combined／
// system_plus_ga4。本檔案完全沒有這些欄位，也沒有把系統 Visitor 人數傳進來。

'use strict';

const { normalizeCounty, normalizeDistrictToParentCounty } = require('../taiwanGeoNormalize');
const { getGa4RealtimeConfig } = require('../ga4RealtimeConfig');
const {
  GA4_REALTIME_WINDOWS, isSupportedGa4Metric,
  buildGa4RealtimeSummaryRequest, buildGa4RealtimeCityRequest,
} = require('./requestBuilder');
const { isRetryableGa4Error } = require('./errors');
const { runGa4RealtimeRequestPair } = require('./requestPair');
const ga4Client = require('./client');

const DISCLAIMER = 'GA4 位置由 IP 推估，僅供區域趨勢分析，非精確定位。';
const QUOTA_NOTICE_LOW_DATA = 'Google Analytics 可能基於隱私保護省略部分低量資料。';

// GA4RealtimeError：orchestrator 在「沒有任何 stale cache 可回退」時丟出，
// 由 route 層轉成 { success:false, code, message, retryable, status } 的最小
// 錯誤形狀（見需求文件十七：Error response 不得回 stack/rawError/credential）。
class Ga4RealtimeError extends Error {
  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：新增 stage（'summary'|'city'|null）
  // ——只有 Summary 失敗（或 Request Builder 驗證失敗）才會走到這個例外；
  // City 單獨失敗改成 Partial Success（見 _fetchAndBuildPayload），不再
  // throw。route 層可把 stage 一併回給前端做安全診斷（見需求文件八）。
  constructor(code, retryable, httpStatus, stage) {
    super(code);
    this.code = code;
    this.retryable = !!retryable;
    this.httpStatus = httpStatus || 502;
    this.stage = stage || null;
  }
}

// ── Cache Key（需求文件十一：必須含 storeId/propertyId/streamId/window/metric）
function getGa4RealtimeCacheKey({ storeId, propertyId, streamId, windowMinutes, metric }) {
  return [storeId, propertyId, streamId || 'nostream', windowMinutes, metric].join('::');
}

// ── Quota 正規化：兩個 Request 各自的 quotaStatus，取較嚴重者。
const QUOTA_SEVERITY = { normal: 0, unknown: 0, near_limit: 1, limited: 2 };
function normalizeGa4QuotaStatus(a, b) {
  const sa = QUOTA_SEVERITY[a] || 0;
  const sb = QUOTA_SEVERITY[b] || 0;
  if (sa >= sb) return QUOTA_SEVERITY[a] !== undefined ? a : 'unknown';
  return b;
}

// ── in-memory cache + single-flight（模組層變數：同一 process 內所有店家
//    共用同一個 Map，但 key 本身已經包含 storeId，物理上不會互相污染）。
const _cache = new Map(); // cacheKey -> { data, fetchedAt, expiresAt, lastSuccessfulAt }
const _inFlight = new Map(); // cacheKey -> Promise
// fix18-10-hotfix30-B5-R5.4-G1.5-B2：每店一組 generation token。設定變更
// （enabled/property/stream/single-property-mode/cache seconds）時遞增該
// store 的 generation，任何「開始 fetch 時 generation 是舊的」的 in-flight
// 結果，完成後一律不得寫回 cache（見需求文件七：不可讓舊 in-flight 把舊
// Property 資料寫回新 cache）。
const _storeGeneration = new Map(); // storeId -> number

function _getStoreGeneration(storeId) {
  return _storeGeneration.get(storeId) || 0;
}

// invalidateGa4RealtimeCacheForStore(storeId) — 只清「這個 store」的 cache
// entry，不得使用 _cache.clear() 清掉全 SaaS 所有店（見需求文件七）。
function invalidateGa4RealtimeCacheForStore(storeId) {
  const prefix = `${storeId}::`;
  for (const key of Array.from(_cache.keys())) {
    if (key.startsWith(prefix)) _cache.delete(key);
  }
  // in-flight 的舊請求不強制中止（Client 端沒有可靠的取消機制），但遞增
  // generation 之後，_fetchAndBuildPayload 完成時会比對 generation，
  // 發現已經過期就不寫回 cache（見下面 getGa4RealtimeData 內的判斷）。
  _storeGeneration.set(storeId, _getStoreGeneration(storeId) + 1);
}

function resetForTest() {
  _cache.clear();
  _inFlight.clear();
  _storeGeneration.clear();
  _storeLastSuccessAt.clear();
  _storeLastErrorCode.clear();
  ga4Client._resetForTest();
  require('./connectionTest').resetForTest();
}

function _sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// _runWithRetry(fn, opts) — 最多重試 2 次（共 3 次嘗試），只重試
// isRetryableGa4Error() 判定為 true 的結果；退避約 250ms/750ms（可注入
// sleepFn 供測試跳過真實等待）。fn 必須回傳 client.js 的
// { ok, code, retryable, ... } 形狀，不丟例外。
async function _runWithRetry(fn, opts = {}) {
  const sleepFn = opts.sleepFn || _sleep;
  const backoffs = [250, 750];
  let lastResult = null;
  for (let attempt = 0; attempt <= backoffs.length; attempt++) {
    lastResult = await fn();
    if (lastResult.ok) return lastResult;
    if (!lastResult.retryable || attempt === backoffs.length) return lastResult;
    await sleepFn(backoffs[attempt]);
  }
  return lastResult;
}

// _aggregateCityRows(rows, dimensionHeaders) → { counties, unmapped, excludedNonTw }
// 只用既有 normalizeCounty()（已驗證涵蓋 Taoyuan/New Taipei/Hsinchu City/
// Hsinchu County/Chiayi City/Chiayi County 等 alias，且 bare "Hsinchu"／
// "Chiayi" 正確回傳 null=ambiguous，不會誤猜）。country 非 TW 一律排除，
// 不畫入台灣地圖。
//
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：正式 City Request 已縮減為
// city／countryId 兩個維度（見 requestBuilder.js／
// R5.4-G1.5-B2.4_CITY_REQUEST_REALITY_AUDIT.md 第三節）。本函式只讀取
// city／countryId，從未讀取 cityId／country，因此：
//   - 不得假設 cityId／country 一定存在於 dimensionHeaders。
//   - indexOf() 對不存在的維度回傳 -1，下面的存取都用 `idx.x >= 0` 防禦，
//     所以舊 fixture／舊 cache（四維：city/cityId/country/countryId）與
//     新 Request（兩維：city/countryId）都能正確解析（向後相容）。
function _aggregateCityRows(rows, dimensionHeaders) {
  const idx = {
    city: dimensionHeaders.indexOf('city'),
    countryId: dimensionHeaders.indexOf('countryId'),
  };
  const metricIdx = { activeUsers: 0, eventCount: 1 };

  const countyMap = new Map();
  const unmapped = [];
  let excludedNonTw = 0;

  for (const row of rows || []) {
    const dv = row.dimensionValues || [];
    const mv = row.metricValues || [];
    const city = idx.city >= 0 && dv[idx.city] ? dv[idx.city].value : null;
    const countryId = idx.countryId >= 0 && dv[idx.countryId] ? dv[idx.countryId].value : null;
    const activeUsers = Number((mv[metricIdx.activeUsers] && mv[metricIdx.activeUsers].value) || 0);
    const eventCount = Number((mv[metricIdx.eventCount] && mv[metricIdx.eventCount].value) || 0);

    if (countryId && countryId !== 'TW') { excludedNonTw += 1; continue; }

    const normalizedCity = city && city !== '(not set)' && city.toLowerCase() !== 'unknown' ? city : null;
    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.5：GA4「city」維度對台灣常回傳的是
    // 「行政區」（例如 "Longtan District"／"Taoyuan District"），不是縣市
    // 本身，normalizeCounty() 只認得縣市層級別名，所以這類 row 原本一律
    // 掉進 unmapped。這裡新增 normalizeDistrictToParentCounty() 作為
    // fallback——只認得明確白名單裡的行政區字串（見
    // utils/taiwanGeoNormalize.js 的 DISTRICT_PARENT_ALIASES 與已記錄的
    // Taoyuan District 全國唯一性衝突風險），不做任何「去掉 District 字尾
    // 剩下文字就當縣市」的通用猜測，也完全不影響 Hsinchu／Chiayi 裸名稱
    // 仍然回 null（ambiguous）的既有保護。
    const county = normalizedCity
      ? (normalizeCounty(normalizedCity) || normalizeDistrictToParentCounty(normalizedCity))
      : null;
    if (county) {
      const key = county.county_code;
      if (!countyMap.has(key)) {
        countyMap.set(key, { county_code: key, county_name: county.county_name, active_users: 0, event_count: 0, source: 'ga4_city', accuracy: 'ip_city_county_estimate' });
      }
      const entry = countyMap.get(key);
      entry.active_users += activeUsers;
      entry.event_count += eventCount;
    } else {
      unmapped.push({ city: city || '(not set)', active_users: activeUsers, event_count: eventCount });
    }
  }

  return {
    counties: Array.from(countyMap.values()).sort((a, b) => b.active_users - a.active_users),
    unmapped,
    excludedNonTw,
  };
}

function _emptyPayload(status, errorCode, extra = {}) {
  return {
    source: 'ga4_realtime',
    accuracy: 'ip_city_county_estimate',
    window_minutes: extra.window_minutes || null,
    metric: extra.metric || null,
    fetched_at: null,
    cache_age_seconds: null,
    is_cached: false,
    is_stale: false,
    status,
    quota_status: 'unknown',
    summary: { total_active_users_ga4: 0, event_count: 0, screen_page_views: null, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
    counties: [],
    unmapped: [],
    notices: [DISCLAIMER],
    error_code: errorCode || null,
    ...extra,
  };
}

// getGa4RealtimeData({ db, storeId, window, metric, forceRefresh, sleepFn })
//   → 完整 payload（永遠 resolve，除非沒有任何 stale cache 可回退才丟出
//     Ga4RealtimeError，由 route 轉換成最小錯誤形狀）。
async function getGa4RealtimeData({ db, storeId, window, metric, forceRefresh = false, sleepFn } = {}) {
  const windowMinutes = Number(window);
  const config = getGa4RealtimeConfig(db, storeId);

  if (!config.enabled) {
    return _emptyPayload('disabled', 'ga4_realtime_disabled', { window_minutes: windowMinutes || null, metric: metric || null });
  }
  if (!config.configured) {
    return _emptyPayload('not_configured', config.errorCode, { window_minutes: windowMinutes || null, metric: metric || null });
  }
  if (!GA4_REALTIME_WINDOWS.includes(windowMinutes)) {
    throw new Ga4RealtimeError('invalid_window', false, 400);
  }
  if (!isSupportedGa4Metric(metric)) {
    throw new Ga4RealtimeError('unsupported_metric', false, 400);
  }
  if (!ga4Client.isSdkAvailable()) {
    return _emptyPayload('not_configured', 'SDK_UNAVAILABLE', { window_minutes: windowMinutes, metric });
  }

  const cacheKey = getGa4RealtimeCacheKey({ storeId, propertyId: config.propertyId, streamId: config.streamId, windowMinutes, metric });
  const now = Date.now();
  const cached = _cache.get(cacheKey);

  if (!forceRefresh && cached && cached.expiresAt > now) {
    return {
      ..._clonePayload(cached.data),
      is_cached: true, is_stale: false, status: 'cached',
      cache_age_seconds: Math.floor((now - cached.fetchedAt) / 1000),
    };
  }

  if (_inFlight.has(cacheKey)) {
    const data = await _inFlight.get(cacheKey);
    return _clonePayload(data);
  }

  const generationAtStart = _getStoreGeneration(storeId);
  const fetchPromise = _fetchAndBuildPayload({ config, storeId, windowMinutes, metric, sleepFn })
    .then((payload) => {
      // fix18-10-hotfix30-B5-R5.4-G1.5-B2：若設定在這次 fetch 進行期間被
      // 改過（generation 已經前進），這筆結果是舊設定算出來的，不得寫回
      // cache（否則使用者剛改完 Property，畫面卻閃回舊 Property 的資料）。
      //
      // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：Partial Success
      // （payload.status === 'partial'）不得寫進一般 Full Cache（見需求
      // 文件三）：
      //   - Partial 的 counties 一律是空陣列，寫進 cache 等於用「暫時打不
      //     開城市資料」蓋掉使用者上一次真正成功的完整縣市資料，下次
      //     cache-hit 會誤把「沒有城市資料」當成快取結果回傳。
      //   - 若目前沒有既有 Full Cache，這裡什麼都不寫，單純把 partial
      //     payload 回給這次 Request；下次 fetch（無論 auto refresh 或
      //     手動 refresh）會重新嘗試 City Request，一旦成功就正常建立
      //     Full Cache，不受這次 partial 影響。
      //   - 若目前已有 Full Cache，這裡直接跳過寫入，讓舊的 Full Cache
      //     繼續存在、繼續可被下一次 cache-hit 使用，直到它自然過期或被
      //     下一次「Summary+City 都成功」的 fetch 換掉。
      if (_getStoreGeneration(storeId) === generationAtStart && payload.status !== 'partial') {
        _cache.set(cacheKey, {
          data: payload,
          fetchedAt: Date.now(),
          expiresAt: Date.now() + config.cacheSeconds * 1000,
          lastSuccessfulAt: Date.now(),
        });
      }
      // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：last_success_at／
      // last_error_code（getGa4RealtimeStatus 用）代表「完整 Geo 資料上次
      // 成功時間」，Partial 只是 Summary 成功、City 沒成功，不算完整成功，
      // 不得更新這個時間戳（否則 status endpoint 會誤導使用者以為地圖資料
      // 剛剛更新過）。但 Partial 也不是「錯誤」（HTTP 200，success:true），
      // 所以也不寫入 last_error_code。
      if (payload.status !== 'partial') {
        _storeLastSuccessAt.set(storeId, payload.fetched_at);
        _storeLastErrorCode.set(storeId, null);
      }
      return payload;
    })
    .catch((err) => {
      _storeLastErrorCode.set(storeId, (err && err.code) || 'GA4_API_ERROR');
      // 失敗時：有 expired cache 可用就回退成 stale，沒有就把錯誤往上拋，
      // 由呼叫端（route）決定要回什麼 HTTP 狀態碼。
      if (cached) {
        const stalePayload = {
          ..._clonePayload(cached.data),
          is_cached: true, is_stale: true, status: 'stale_cache',
          cache_age_seconds: Math.floor((Date.now() - cached.fetchedAt) / 1000),
        };
        return stalePayload;
      }
      throw err;
    })
    .finally(() => { _inFlight.delete(cacheKey); });

  _inFlight.set(cacheKey, fetchPromise);
  return fetchPromise;
}

function _clonePayload(p) {
  return JSON.parse(JSON.stringify(p));
}

async function _fetchAndBuildPayload({ config, storeId, windowMinutes, metric, sleepFn }) {
  const summaryReq = buildGa4RealtimeSummaryRequest({ propertyId: config.propertyId, streamId: config.streamId, windowMinutes, metric });
  const cityReq = buildGa4RealtimeCityRequest({ propertyId: config.propertyId, streamId: config.streamId, windowMinutes, metric });
  if (!summaryReq.ok) throw new Ga4RealtimeError(summaryReq.code, false, 400, 'summary');
  if (!cityReq.ok) throw new Ga4RealtimeError(cityReq.code, false, 400, 'city');

  const timeoutMs = Number(process.env.GA4_REALTIME_TIMEOUT_MS) || 10000;

  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：改用共用的 runGa4RealtimeRequestPair
  // （見 requestPair.js），保留原本的重試邏輯（每個 stage 各自 retry，不是
  // 兩個 stage 綁在一起重試），並新增安全診斷 log（stage/code/retryable/
  // window/metric/elapsed_ms，見需求文件四）。
  const { summaryResult, cityResult } = await runGa4RealtimeRequestPair({
    summaryRequest: summaryReq.request,
    cityRequest: cityReq.request,
    windowMinutes,
    metric,
    runFn: (request) => _runWithRetry(() => ga4Client.runGa4RealtimeReport(request, { timeoutMs }), { sleepFn }),
  });

  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：Summary 失敗——總數與核心 GA4
  // Request 都不可用，仍視為整體失敗（見需求文件五 Rule A），route 層轉成
  // 502。
  if (!summaryResult.ok) throw new Ga4RealtimeError(summaryResult.code, summaryResult.retryable, 502, 'summary');

  const summaryRow = (summaryResult.rows && summaryResult.rows[0]) || null;
  const summaryMetricIdx = { activeUsers: summaryResult.metricHeaders.indexOf('activeUsers'), eventCount: summaryResult.metricHeaders.indexOf('eventCount'), screenPageViews: summaryResult.metricHeaders.indexOf('screenPageViews') };
  const totalActiveUsers = summaryRow ? Number((summaryRow.metricValues[summaryMetricIdx.activeUsers] || {}).value || 0) : 0;
  const totalEventCount = summaryRow ? Number((summaryRow.metricValues[summaryMetricIdx.eventCount] || {}).value || 0) : 0;
  const totalScreenPageViews = (summaryMetricIdx.screenPageViews >= 0 && summaryRow)
    ? Number((summaryRow.metricValues[summaryMetricIdx.screenPageViews] || {}).value || 0)
    : null;

  // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：Summary 成功＋City 失敗 →
  // Partial Success（見需求文件五 Rule C）。不再整個 502：Summary 卡片
  // 仍可顯示，地圖不著色，不得使用假的縣市資料／店家地址替代／畫
  // Marker／Circle（counties 一律回空陣列）。這個 payload 從呼叫端
  // （getGa4RealtimeData）的角度看跟 fresh payload 一樣是正常 resolve，
  // 會被寫進 route 的 200 success:true 回應。
  if (!cityResult.ok) {
    return {
      source: 'ga4_realtime',
      accuracy: 'ip_city_county_estimate',
      window_minutes: windowMinutes,
      metric,
      fetched_at: new Date().toISOString(),
      cache_age_seconds: 0,
      is_cached: false,
      is_stale: false,
      status: 'partial',
      quota_status: summaryResult.quotaStatus || 'unknown',
      summary: {
        total_active_users_ga4: totalActiveUsers,
        event_count: totalEventCount,
        screen_page_views: totalScreenPageViews,
        mapped_counties: 0,
        unmapped_city_rows: 0,
        excluded_non_tw_rows: 0,
      },
      counties: [],
      unmapped: [],
      notices: [
        'GA4 即時總覽已取得，但城市區域資料暫時無法載入。',
        DISCLAIMER,
      ],
      error_code: 'city_request_failed',
      error_stage: 'city',
    };
  }

  const { counties, unmapped, excludedNonTw } = _aggregateCityRows(cityResult.rows, cityResult.dimensionHeaders);

  const quotaStatus = normalizeGa4QuotaStatus(summaryResult.quotaStatus, cityResult.quotaStatus);
  const notices = [DISCLAIMER];
  if (unmapped.length) notices.push(`有 ${unmapped.length} 筆城市資料無法安全對應到台灣縣市，未顯示於地圖。`);
  notices.push(QUOTA_NOTICE_LOW_DATA);

  return {
    source: 'ga4_realtime',
    accuracy: 'ip_city_county_estimate',
    window_minutes: windowMinutes,
    metric,
    fetched_at: new Date().toISOString(),
    cache_age_seconds: 0,
    is_cached: false,
    is_stale: false,
    status: 'fresh',
    quota_status: quotaStatus,
    summary: {
      total_active_users_ga4: totalActiveUsers,
      event_count: totalEventCount,
      screen_page_views: totalScreenPageViews,
      mapped_counties: counties.length,
      unmapped_city_rows: unmapped.length,
      excluded_non_tw_rows: excludedNonTw,
    },
    counties,
    unmapped,
    notices,
    error_code: null,
  };
}

// getGa4RealtimeStatus(db, storeId) — 診斷用，不呼叫 Google API（見需求文件
// 十八：預設不得消耗 quota）。
const _storeLastSuccessAt = new Map(); // storeId -> ISO string
const _storeLastErrorCode = new Map(); // storeId -> code|null

function getGa4RealtimeStatus(db, storeId) {
  const config = getGa4RealtimeConfig(db, storeId);
  const cred = ga4Client.credentialStatus();
  let cacheEntries = 0;
  let inFlightForStore = 0;
  for (const key of _cache.keys()) { if (key.startsWith(`${storeId}::`)) cacheEntries += 1; }
  for (const key of _inFlight.keys()) { if (key.startsWith(`${storeId}::`)) inFlightForStore += 1; }
  const testStatus = require('./connectionTest').getLastTestStatus(storeId);

  return {
    enabled: config.enabled,
    configured: config.configured,
    credential_available: !!cred.available,
    property_configured: !!config.propertyId,
    stream_configured: !!config.streamId,
    single_store_mode: !!config.singlePropertyMode,
    sdk_available: ga4Client.isSdkAvailable(),
    last_success_at: _storeLastSuccessAt.get(storeId) || null,
    last_error_code: _storeLastErrorCode.get(storeId) || config.errorCode || null,
    last_test_at: testStatus.last_test_at,
    last_test_status: testStatus.last_test_status,
    cache_entries: cacheEntries,
    in_flight_requests: inFlightForStore,
    cache_seconds: config.cacheSeconds,
    auto_refresh_enabled: config.autoRefreshEnabled,
    auto_refresh_seconds: null, // 由前端依 quota_status 動態決定（見 geo-ga4-realtime-layer.js），status endpoint 不預先假設
  };
}

module.exports = {
  DISCLAIMER,
  Ga4RealtimeError,
  getGa4RealtimeCacheKey,
  normalizeGa4QuotaStatus,
  getGa4RealtimeData,
  getGa4RealtimeStatus,
  invalidateGa4RealtimeCacheForStore,
  resetForTest,
  _aggregateCityRowsForTest: _aggregateCityRows,
  _runWithRetryForTest: _runWithRetry,
  _cacheForTest: _cache,
  _inFlightForTest: _inFlight,
  _storeGenerationForTest: _storeGeneration,
  _setStoreLastSuccessForTest: (storeId, iso) => _storeLastSuccessAt.set(storeId, iso),
  _setStoreLastErrorForTest: (storeId, code) => _storeLastErrorCode.set(storeId, code),
};
