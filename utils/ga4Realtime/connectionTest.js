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
const { buildGa4RealtimeSummaryRequest, buildGa4RealtimeCityRequest } = require('./requestBuilder');
const { runGa4RealtimeRequestPair } = require('./requestPair');
const ga4Client = require('./client');

const RATE_LIMIT_MS = 30 * 1000;

const _lastTestAt = new Map(); // storeId -> timestamp(ms)
const _lastTestResult = new Map(); // storeId -> sanitized result object
const _inFlightTest = new Map(); // storeId -> Promise

function resetForTest() {
  _lastTestAt.clear();
  _lastTestResult.clear();
  _inFlightTest.clear();
}

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
  };
}

async function _runTestNow(db, storeId) {
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

  // Case B：Summary 失敗 → 整個連線測試失敗，City 是否成功不影響判定，但
  // city_request_ok 誠實依實際結果回報（見需求文件二 Rule B）。
  if (!summaryResult.ok) {
    return {
      ..._baseTestResult(testedAt, true, !!cred.available),
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
    connected: true, property_accessible: true, stream_filter_valid: true,
    summary_request_ok: true, city_request_ok: true, realtime_request_ok: true,
    has_recent_data: hasData, rows_count: rowsCount, error_stage: null,
    message: hasData ? '連線成功，最近 30 分鐘有即時資料。' : '連線成功，目前最近30分鐘沒有即時資料。',
    error_code: null,
  };
}

// runGa4ConnectionTest(db, storeId) → sanitized result（不得回傳
// rawGoogle response／city 個別活躍人數／credentials／propertyQuota）。
async function runGa4ConnectionTest(db, storeId) {
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

  const testPromise = _runTestNow(db, storeId)
    .then((result) => {
      _lastTestAt.set(storeId, Date.now());
      _lastTestResult.set(storeId, result);
      return result;
    })
    .catch(() => {
      const fallback = { connected: false, sdk_available: ga4Client.isSdkAvailable(), credential_available: false, property_accessible: false, stream_filter_valid: false, realtime_request_ok: false, has_recent_data: false, rows_count: 0, tested_at: new Date().toISOString(), message: '連線測試發生未預期錯誤，請稍後再試。', error_code: 'ga4_unavailable' };
      _lastTestAt.set(storeId, Date.now());
      _lastTestResult.set(storeId, fallback);
      return fallback;
    })
    .finally(() => { _inFlightTest.delete(storeId); });

  _inFlightTest.set(storeId, testPromise);
  return testPromise;
}

module.exports = {
  RATE_LIMIT_MS,
  runGa4ConnectionTest,
  getLastTestStatus,
  resetForTest,
  _lastTestAtForTest: _lastTestAt,
  _inFlightTestForTest: _inFlightTest,
};
