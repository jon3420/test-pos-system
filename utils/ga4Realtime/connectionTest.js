// utils/ga4Realtime/connectionTest.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2
// GA4 Realtime Connection Test — 只讀、最小 Realtime Report 呼叫，驗證
// 「目前已儲存的該店設定」是否可用。
//
// 邊界（不得違反）：
//   - 不接受 Body 傳入的 Property／Stream／Credential，一律讀
//     getGa4RealtimeConfig(db, storeId) 已儲存的設定（見需求文件八）。
//   - Rate limit：同店 30 秒內最多一次「真的呼叫 Google」的測試，超過限制
//     直接回上一次的結果（不重打 API），並標記 rate_limited:true。
//   - Single-flight：同店併發測試共用同一個 Promise。
//   - 測試結果不寫進一般 Realtime data cache（_cache），只保存
//     last_test_at／last_test_status 這組非敏感摘要（供 status endpoint
//     顯示，見需求文件九）。

'use strict';

const { getGa4RealtimeConfig } = require('../ga4RealtimeConfig');
const { buildGa4RealtimeSummaryRequest, buildGa4RealtimeCityRequest, GA4_REQUEST_VARIANT } = require('./requestBuilder');
const { runGa4RealtimeRequestPair, runGa4RealtimeSingleRequest } = require('./requestPair');
const ga4Client = require('./client');

const RATE_LIMIT_MS = 30 * 1000;

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件三～八）：
// Event Compatibility Probe 是「額外、明確 Opt-in」的診斷能力，不得讓既有
// 「一般連線測試」自動多打 4 次 Google API：
//   - 預設（includeEventCompatibility 未傳或為 false）行為必須與 H1.2
//     baseline 完全相同——Google Call 數、Response Shape、Rate Limit／
//     Single-flight 語意都不變（見需求文件三、七）。
//   - 只有呼叫端明確傳 includeEventCompatibility:true，才會對四個 Event
//     Metric 各自送一次「Summary Only」Request（見需求文件四）。
//   - Probe 完全重用既有 ga4Client／requestBuilder／requestPair（安全
//     Log／錯誤分類），不建立第二套 Client／Credential／Cache（需求文件
//     五）。
//   - Rate Limit／Single-flight／Last-Result 快取的 key 額外區分
//     'basic'／'event_compat'（testMode，見需求文件八），避免一般測試
//     跟 Event Compatibility 測試互相拿到對方的快取結果。
const GA4_EVENT_COMPAT_METRICS = Object.freeze(['view_item', 'add_to_cart', 'checkout', 'purchase']);

// _testEventMetricCompat(config, metric, timeoutMs) — 單一 Event Metric 的
// Summary Only Probe。重用 requestPair.runGa4RealtimeSingleRequest()
// 既有的安全診斷 Log（stage/code/retryable/window/metric/elapsed_ms），
// 不在本檔案另外呼叫 console.log（見 scripts/static-audit-g1-5-b2.js
// check 75：本檔案是「無 console.log()」掃描範圍之一，新增的 Log 一律
// 透過既有 requestPair.js 完成，不得在本檔案直接印出）。
async function _testEventMetricCompat(config, metric, timeoutMs) {
  const built = buildGa4RealtimeSummaryRequest({ propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric });
  if (!built.ok) return { ok: false, stage: 'summary', code: built.code };
  const result = await runGa4RealtimeSingleRequest('summary', built.request, 30, metric, (request) => ga4Client.runGa4RealtimeReport(request, { timeoutMs }));
  return { ok: !!result.ok, stage: 'summary', code: result.ok ? null : (result.code || 'UNKNOWN') };
}

// _runEventCompatChecks(config, timeoutMs) → { view_item_ok, view_item_stage,
//   view_item_code, add_to_cart_ok, ..., checkout_ok, ..., purchase_ok, ... }
// 只有 includeEventCompatibility===true 時才會被呼叫（見 _runTestNow()）。
async function _runEventCompatChecks(config, timeoutMs) {
  const results = await Promise.all(GA4_EVENT_COMPAT_METRICS.map((m) => _testEventMetricCompat(config, m, timeoutMs)));
  const fields = { event_compat_tested: true, request_variant: GA4_REQUEST_VARIANT };
  GA4_EVENT_COMPAT_METRICS.forEach((m, i) => {
    fields[`${m}_ok`] = results[i].ok;
    fields[`${m}_stage`] = results[i].stage;
    fields[`${m}_code`] = results[i].code;
  });
  return fields;
}

// _emptyEventCompatFields() — Event Compatibility 欄位的安全預設值
// （event_compat_tested:false，其餘 *_ok/*_stage/*_code 一律 null＝未測試）。
// 這組欄位在 includeEventCompatibility===false（既有 H1.2 baseline 行為）
// 時也會出現在回應裡，但都是新增欄位，不影響既有測試讀取的既有欄位
// （見需求文件七：Basic Mode 下 Event-specific fields 可以是 null，但
// Contract 必須固定）。
function _emptyEventCompatFields() {
  const fields = { event_compat_tested: false, request_variant: GA4_REQUEST_VARIANT, visitors_ok: null };
  GA4_EVENT_COMPAT_METRICS.forEach((m) => {
    fields[`${m}_ok`] = null;
    fields[`${m}_stage`] = null;
    fields[`${m}_code`] = null;
  });
  return fields;
}

const _lastTestAt = new Map(); // storeId -> timestamp(ms)
const _lastTestResult = new Map(); // storeId -> sanitized result object
const _inFlightTest = new Map(); // storeId -> Promise

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件八）：Event
// Compatibility Probe 用完全獨立的一組 Map，物理上不與上面三個 H1.2
// baseline Map 共用任何 key／實例，一般連線測試與 Event Compatibility
// 測試不可能互相讀到對方的 Rate Limit／Single-flight／Last-Result（比用
// 同一個 Map 加 testMode 字串字尾更保守：完全沒有 key 命名衝突風險）。
const _lastTestAtEventCompat = new Map();
const _lastTestResultEventCompat = new Map();
const _inFlightTestEventCompat = new Map();

function resetForTest() {
  _lastTestAt.clear();
  _lastTestResult.clear();
  _inFlightTest.clear();
  _lastTestAtEventCompat.clear();
  _lastTestResultEventCompat.clear();
  _inFlightTestEventCompat.clear();
}

// getLastTestStatus(storeId) — 供 GET /ga4-realtime-status 顯示（見
// utils/ga4Realtime/index.js getGa4RealtimeStatus()）。固定讀「一般連線
// 測試」（H1.2 baseline，非 Event Compatibility Probe）的最近一次結果。
function getLastTestStatus(storeId) {
  const r = _lastTestResult.get(storeId);
  return {
    last_test_at: r ? r.tested_at : null,
    last_test_status: r ? (r.connected ? 'connected' : 'failed') : null,
  };
}

function _classifyTestFailure(errorResult) {
  const code = errorResult && errorResult.code;
  const map = {
    SDK_UNAVAILABLE: 'credential_unavailable',
    MISSING_PROPERTY: 'property_not_found',
    401: 'permission_denied',
    403: 'permission_denied',
    404: 'property_not_found',
    INVALID_CREDENTIALS: 'credential_invalid',
    INVALID_PROPERTY: 'property_not_found',
    INVALID_STREAM: 'stream_filter_invalid',
    TIMEOUT: 'ga4_timeout',
    429: 'quota_limited',
  };
  return map[code] || 'ga4_unavailable';
}

// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：Connection Test 假陽性修正（見需求
// 文件二／R5.4-G1.5-B2.4_CITY_REQUEST_REALITY_AUDIT.md）。舊版只檢查
// summaryResult.ok，Summary 成功＋City 失敗一律仍回 connected:true，但正式
// Data Endpoint 兩個 Request 都會檢查，City 失敗時整個 502——造成
// Connection Test 顯示成功、正式資料卻打不開的矛盾。
//
// 新規則（三種結果，不得再有第四種「city 失敗仍 connected:true」的情況）：
//   A. Summary 成功＋City 成功 → connected:true，error_stage:null。
//   B. Summary 失敗           → connected:false，error_stage:'summary'。
//   C. Summary 成功＋City 失敗 → connected:false（整體連線測試「不算通過」），
//                                 但 property_accessible/summary_request_ok
//                                 仍誠實回 true（因為 Summary 真的成功），
//                                 error_stage:'city'，並顯示專屬訊息，不與
//                                 完全連不上（case B）共用文案。
function _baseTestResult(testedAt, sdkAvailable, credentialAvailable) {
  return {
    connected: false, sdk_available: sdkAvailable, credential_available: credentialAvailable,
    property_accessible: false, stream_filter_valid: false,
    summary_request_ok: false, city_request_ok: false, realtime_request_ok: false,
    has_recent_data: false, rows_count: 0, tested_at: testedAt,
    error_stage: null, error_code: null, message: '',
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件七）：
    // 預設 event_compat_tested:false／欄位皆 null＝這次測試沒有要求 Event
    // Compatibility Probe（H1.2 baseline 呼叫方式，或 enabled/configured/
    // SDK 任一項不成立時，一律不消耗額外 Quota）。
    ..._emptyEventCompatFields(),
  };
}

async function _runTestNow(db, storeId, includeEventCompatibility) {
  const config = getGa4RealtimeConfig(db, storeId);
  const testedAt = new Date().toISOString();

  if (!config.enabled) {
    return { ..._baseTestResult(testedAt, ga4Client.isSdkAvailable(), false), message: 'GA4 即時推估圖層尚未啟用，請先啟用後再測試連線。', error_code: 'ga4_realtime_disabled' };
  }
  if (!config.configured) {
    return { ..._baseTestResult(testedAt, ga4Client.isSdkAvailable(), !!ga4Client.credentialStatus().available), message: '尚未完成 Property／Stream 設定，請先儲存設定後再測試連線。', error_code: config.errorCode };
  }
  if (!ga4Client.isSdkAvailable()) {
    return { ..._baseTestResult(testedAt, false, false), message: 'Server 尚未安裝 GA4 SDK，請聯絡系統管理員。', error_code: 'sdk_unavailable' };
  }

  const cred = ga4Client.credentialStatus();
  const summaryReq = buildGa4RealtimeSummaryRequest({ propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' });
  const cityReq = buildGa4RealtimeCityRequest({ propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' });

  const timeoutMs = Number(process.env.GA4_REALTIME_TIMEOUT_MS) || 10000;
  const { summaryResult, cityResult } = await runGa4RealtimeRequestPair({
    summaryRequest: summaryReq.ok ? summaryReq.request : null,
    cityRequest: cityReq.ok ? cityReq.request : null,
    windowMinutes: 30,
    metric: 'visitors',
    runFn: (request) => ga4Client.runGa4RealtimeReport(request, { timeoutMs }),
  });

  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件三、四）：
  // 只有明確要求 includeEventCompatibility===true 才額外對四個 Event
  // Metric 各自測一次 Summary Only Request——H1.2 baseline 呼叫方式
  // （不傳這個參數）完全不受影響，Google Call 數與 H1.2 一致。
  const eventCompatFields = includeEventCompatibility
    ? await _runEventCompatChecks(config, timeoutMs)
    : { ..._emptyEventCompatFields(), visitors_ok: summaryResult.ok };

  // Case B：Summary 失敗 → 整個連線測試失敗，City 是否成功不影響判定，但
  // city_request_ok 誠實依實際結果回報（見需求文件二 Rule B）。
  if (!summaryResult.ok) {
    return {
      ..._baseTestResult(testedAt, true, !!cred.available),
      ...eventCompatFields, visitors_ok: false,
      property_accessible: false, stream_filter_valid: false,
      summary_request_ok: false, city_request_ok: !!cityResult.ok,
      realtime_request_ok: false, error_stage: 'summary',
      message: '連線測試失敗，請確認 Property／Stream 設定與伺服器憑證。',
      error_code: _classifyTestFailure(summaryResult),
    };
  }

  const activeUsersIdx = summaryResult.metricHeaders.indexOf('activeUsers');
  const hasData = summaryResult.rows.length > 0
    && Number((summaryResult.rows[0].metricValues[activeUsersIdx] || {}).value || 0) > 0;

  // Case C：Summary 成功＋City 失敗 → 不得再顯示完整成功（需求文件二
  // Rule C）。property_accessible/stream_filter_valid 依 Summary 的結果
  // 判定為 true（Summary 能跑成功，代表 Property／Stream Filter 本身是
  // 合法的），但 connected 仍是 false，因為地圖資料需要的 City Request
  // 打不通。
  if (!cityResult.ok) {
    return {
      ..._baseTestResult(testedAt, true, !!cred.available),
      ...eventCompatFields, visitors_ok: true,
      property_accessible: true, stream_filter_valid: true,
      summary_request_ok: true, city_request_ok: false,
      realtime_request_ok: false, has_recent_data: hasData,
      error_stage: 'city', error_code: _classifyTestFailure(cityResult),
      message: 'GA4 基本連線成功，但城市區域資料請求失敗。',
    };
  }

  // Case A：Summary 成功＋City 成功。
  const rowsCount = (cityResult.rows) ? cityResult.rows.length : 0;
  return {
    ..._baseTestResult(testedAt, true, !!cred.available),
    ...eventCompatFields, visitors_ok: true,
    connected: true, property_accessible: true, stream_filter_valid: true,
    summary_request_ok: true, city_request_ok: true, realtime_request_ok: true,
    has_recent_data: hasData, rows_count: rowsCount, error_stage: null,
    message: hasData ? '連線成功，最近 30 分鐘有即時資料。' : '連線成功，目前最近30分鐘沒有即時資料。',
    error_code: null,
  };
}

// runGa4ConnectionTest(db, storeId, options) → sanitized result（不得回傳
// rawGoogle response／city 個別活躍人數／credentials／propertyQuota）。
//
// options.includeEventCompatibility（預設 false，見需求文件三、四）：
//   false（或省略）— 行為與 H1.2 baseline 完全相同。
//   true            — 額外執行 Event Compatibility Probe（需求文件八）。
//
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT（需求文件八）：Rate
// Limit／Single-flight／Last-Result 快取的 key 額外區分 testMode
// （'basic'／'event_compat'），避免一般測試跟 Event Compatibility 測試
// 互相拿到對方的快取結果（例如使用者剛按過一般連線測試，30 秒內又要求
// Event Compatibility Probe，不該直接回傳沒有 Event 欄位的舊結果）。
// runGa4ConnectionTest(db, storeId, options) → sanitized result（不得回傳
// rawGoogle response／city 個別活躍人數／credentials／propertyQuota）。
//
// options.includeEventCompatibility（預設 false，見需求文件三、四）：
//   false（或省略）— _runBasicConnectionTest()，與 H1.2 baseline 逐行相同
//                     （見下方，literal 保留供 static audit／既有測試
//                     hook 直接操作 _lastTestAtForTest 等 Map）。
//   true            — _runEventCompatConnectionTest()，走完全獨立的一組
//                     Map，額外執行 Event Compatibility Probe（需求文件
//                     八）。
async function runGa4ConnectionTest(db, storeId, options = {}) {
  const includeEventCompatibility = options.includeEventCompatibility === true;
  return includeEventCompatibility
    ? _runEventCompatConnectionTest(db, storeId)
    : _runBasicConnectionTest(db, storeId);
}

// _runBasicConnectionTest(db, storeId) — H1.2 baseline 行為，逐行未變
// （只是 _runTestNow() 多一個明確的 includeEventCompatibility=false 參數，
// 不影響任何既有分支）。見 scripts/static-audit-g1-5-b2.js check 32：
// 「per-store limiter（用 storeId 當 key）」直接掃描原始碼要求
// `_lastTestAt.get(storeId)` 這個 literal 存在，所以這裡刻意保留跟修改前
// 完全一樣的寫法，不透過任何額外的 key 組合函式包一層。
async function _runBasicConnectionTest(db, storeId) {
  const now = Date.now();
  const last = _lastTestAt.get(storeId);
  if (last && (now - last) < RATE_LIMIT_MS && !_inFlightTest.has(storeId)) {
    const prev = _lastTestResult.get(storeId);
    const retryAfterSeconds = Math.max(0, Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000));
    return { ...(prev || {}), rate_limited: true, retry_after_seconds: retryAfterSeconds, message: prev ? prev.message : `請稍候 ${retryAfterSeconds} 秒後再測試連線。` };
  }

  if (_inFlightTest.has(storeId)) {
    return _inFlightTest.get(storeId);
  }

  const testPromise = _runTestNow(db, storeId, false)
    .then((result) => {
      _lastTestAt.set(storeId, Date.now());
      _lastTestResult.set(storeId, result);
      return result;
    })
    .catch(() => {
      const fallback = { ..._baseTestResult(new Date().toISOString(), ga4Client.isSdkAvailable(), false), message: '連線測試發生未預期錯誤，請稍後再試。', error_code: 'ga4_unavailable' };
      _lastTestAt.set(storeId, Date.now());
      _lastTestResult.set(storeId, fallback);
      return fallback;
    })
    .finally(() => { _inFlightTest.delete(storeId); });

  _inFlightTest.set(storeId, testPromise);
  return testPromise;
}

// _runEventCompatConnectionTest(db, storeId) — 與上面邏輯完全對稱，唯一
// 差異是使用獨立的 _lastTestAtEventCompat／_lastTestResultEventCompat／
// _inFlightTestEventCompat 三個 Map，且呼叫 _runTestNow(..., true)（見
// 需求文件八：Cache／Single-flight 隔離）。
async function _runEventCompatConnectionTest(db, storeId) {
  const now = Date.now();
  const last = _lastTestAtEventCompat.get(storeId);
  if (last && (now - last) < RATE_LIMIT_MS && !_inFlightTestEventCompat.has(storeId)) {
    const prev = _lastTestResultEventCompat.get(storeId);
    const retryAfterSeconds = Math.max(0, Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000));
    return { ...(prev || {}), rate_limited: true, retry_after_seconds: retryAfterSeconds, message: prev ? prev.message : `請稍候 ${retryAfterSeconds} 秒後再測試連線。` };
  }

  if (_inFlightTestEventCompat.has(storeId)) {
    return _inFlightTestEventCompat.get(storeId);
  }

  const testPromise = _runTestNow(db, storeId, true)
    .then((result) => {
      _lastTestAtEventCompat.set(storeId, Date.now());
      _lastTestResultEventCompat.set(storeId, result);
      return result;
    })
    .catch(() => {
      const fallback = { ..._baseTestResult(new Date().toISOString(), ga4Client.isSdkAvailable(), false), message: '連線測試發生未預期錯誤，請稍後再試。', error_code: 'ga4_unavailable' };
      _lastTestAtEventCompat.set(storeId, Date.now());
      _lastTestResultEventCompat.set(storeId, fallback);
      return fallback;
    })
    .finally(() => { _inFlightTestEventCompat.delete(storeId); });

  _inFlightTestEventCompat.set(storeId, testPromise);
  return testPromise;
}

module.exports = {
  RATE_LIMIT_MS,
  runGa4ConnectionTest,
  getLastTestStatus,
  resetForTest,
  _lastTestAtForTest: _lastTestAt,
  _inFlightTestForTest: _inFlightTest,
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT：供
  // scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js 驗證 Cache／
  // Single-flight 隔離（需求文件十一 21/22）用，不供 Production code path
  // 使用。
  _lastTestAtEventCompatForTest: _lastTestAtEventCompat,
  _inFlightTestEventCompatForTest: _inFlightTestEventCompat,
  _lastTestResultEventCompatForTest: _lastTestResultEventCompat,
};
