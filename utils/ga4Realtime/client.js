// utils/ga4Realtime/client.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime Data API — 唯一持有 Google 憑證的檔案。
//
// 設計原則：
//   - 前端一律不持有、不接觸任何 Google 憑證或 Property ID。所有呼叫都在
//     這個檔案內完成，只把「已經解析過的 rows/summary/quota」往上層回傳。
//   - lazy require('@google-analytics/data')：套件未安裝時 module 仍可
//     require 成功，呼叫端一律走 fail-open（見 isSdkAvailable）。
//   - 單一 lazy singleton client（見需求文件五：不得每次 API request new
//     一個 Client）。
//   - 憑證載入順序（需求文件四）：
//       1. GOOGLE_APPLICATION_CREDENTIALS（標準 ADC 檔案路徑，交給 SDK 自己讀）
//       2. GA4_SERVICE_ACCOUNT_JSON_BASE64（base64 編碼過的完整 service account JSON）
//       3. GA4_SERVICE_ACCOUNT_JSON（未編碼的完整 JSON 字串）
//       4. 都沒有 → 交給 SDK 走預設 Application Default Credentials 解析鏈
//   - JSON parse 失敗一律分類成 credential_invalid，不把原始字串或
//     private_key 內容放進任何錯誤訊息／log。

'use strict';

const { withTimeout } = require('../geoProviders/base');
const { classifyGa4RealtimeError, isRetryableGa4Error } = require('./errors');

const name = 'ga4_realtime';

let _ClientCtor = null;
let _loadError = null;
function _loadSdk() {
  if (_ClientCtor || _loadError) return;
  try {
    // eslint-disable-next-line global-require
    const mod = require('@google-analytics/data');
    _ClientCtor = mod.BetaAnalyticsDataClient;
  } catch (e) {
    _loadError = e;
  }
}

function isSdkAvailable() {
  _loadSdk();
  return !!_ClientCtor;
}

// credentialStatus()：不含任何憑證內容，只回「哪一種來源可用」，供
// status endpoint／Reality Audit 使用，絕不外洩 private_key/client_email。
function credentialStatus() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) return { available: true, source: 'application_default_credentials_file' };
  if (process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64) {
    try {
      JSON.parse(Buffer.from(process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8'));
      return { available: true, source: 'service_account_json_base64' };
    } catch (e) {
      return { available: false, source: 'service_account_json_base64', code: 'credential_invalid' };
    }
  }
  if (process.env.GA4_SERVICE_ACCOUNT_JSON) {
    try {
      JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON);
      return { available: true, source: 'service_account_json' };
    } catch (e) {
      return { available: false, source: 'service_account_json', code: 'credential_invalid' };
    }
  }
  // 沒有任何本檔案認得出的來源；不代表 ADC 一定會失敗（平台可能有內建身分），
  // 只是本檔案沒有明確設定值可回報。
  return { available: false, source: 'application_default_credentials_implicit' };
}

// _buildClientOptions()：組出 BetaAnalyticsDataClient constructor options。
// 丟出的 Error 一律只帶安全訊息（'credential_invalid'），不含原始 JSON 內容。
function _buildClientOptions() {
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return {}; // 交給 SDK 自己用標準 ADC 檔案路徑解析
  }
  if (process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64) {
    try {
      const decoded = Buffer.from(process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64, 'base64').toString('utf8');
      return { credentials: JSON.parse(decoded) };
    } catch (e) {
      const err = new Error('credential_invalid');
      err.code = 'CREDENTIAL_INVALID';
      throw err;
    }
  }
  if (process.env.GA4_SERVICE_ACCOUNT_JSON) {
    try {
      return { credentials: JSON.parse(process.env.GA4_SERVICE_ACCOUNT_JSON) };
    } catch (e) {
      const err = new Error('credential_invalid');
      err.code = 'CREDENTIAL_INVALID';
      throw err;
    }
  }
  return {}; // 交給 SDK 走隱含 ADC 解析鏈
}

let _client = null;
function _getClient() {
  _loadSdk();
  if (!_ClientCtor) return null;
  if (!_client) {
    _client = new _ClientCtor(_buildClientOptions());
  }
  return _client;
}

// 測試專用：注入假的 client（不可在 production code path 呼叫）。
function _setClientForTest(fakeClient) {
  _client = fakeClient;
}
function _resetForTest() {
  _client = null;
  _loadError = null;
}

function _parseQuota(response) {
  const q = response && response.propertyQuota;
  if (!q) return 'unknown';
  // Google 回傳每個 quota bucket 都有 consumed/remaining；只要任何一個
  // bucket remaining 很低就視為 near_limit／limited，不把完整物件往外傳。
  const buckets = Object.values(q).filter((b) => b && typeof b === 'object' && 'remaining' in b);
  if (!buckets.length) return 'unknown';
  const minRemaining = Math.min(...buckets.map((b) => Number(b.remaining)).filter((n) => Number.isFinite(n)));
  if (!Number.isFinite(minRemaining)) return 'unknown';
  if (minRemaining <= 0) return 'limited';
  if (minRemaining <= 5) return 'near_limit';
  return 'normal';
}

// runGa4RealtimeReport(request, { timeoutMs }) — 執行單一 Realtime Report
// 呼叫（不重試，重試邏輯在 utils/ga4Realtime/index.js 的 orchestrator）。
//   → { ok:true, response:{ rows, quotaStatus } }
//   → { ok:false, code, retryable, message }（一律 fail-open，絕不 throw）
async function runGa4RealtimeReport(request, options = {}) {
  const client = _getClient();
  if (!client) {
    return { ok: false, provider: name, code: 'SDK_UNAVAILABLE', retryable: false, message: '@google-analytics/data not installed or not loadable' };
  }
  const timeoutMs = Number(options.timeoutMs) || 10000;

  try {
    const [response] = await withTimeout(client.runRealtimeReport(request), timeoutMs);
    const rows = (response && response.rows) || [];
    const dimensionHeaders = (response && response.dimensionHeaders) || [];
    const metricHeaders = (response && response.metricHeaders) || [];
    return {
      ok: true,
      provider: name,
      rows,
      dimensionHeaders: dimensionHeaders.map((h) => h.name),
      metricHeaders: metricHeaders.map((h) => h.name),
      quotaStatus: _parseQuota(response),
    };
  } catch (e) {
    const code = classifyGa4RealtimeError(e);
    return { ok: false, provider: name, code, retryable: isRetryableGa4Error(code), message: 'GA4 Realtime API request failed' };
  }
}

module.exports = {
  name,
  isSdkAvailable,
  credentialStatus,
  runGa4RealtimeReport,
  _setClientForTest,
  _resetForTest,
  _parseQuotaForTest: _parseQuota,
};
