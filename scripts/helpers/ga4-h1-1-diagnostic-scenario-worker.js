#!/usr/bin/env node
// scripts/helpers/ga4-h1-1-diagnostic-scenario-worker.js — fix18-10-hotfix30-
// B5-R5.4-G1.6-GA4-H1.1-AUTH
//
// 每個 Scenario 在自己「全新的 Node process」裡執行（由
// run-g1-6-ga4-h1-1-ga4-diagnostic-contract.js 用 child_process.spawnSync()
// 啟動）。因為是全新 process，require() 完全沒有「跨 Scenario 共用舊
// module 實例」的問題——這正是取代之前手動清 require.cache 造成 stale
// reference 的根本解法。
//
// Worker 本身「很笨」：只負責用真實 route／middleware／client 測試基礎
// 設施（_setClientForTest）實際跑一次指定的 Scenario，把「原始事實」
// （HTTP 回應、process 事件）用單行 JSON 印到 stdout 最後一行。所有
// Assertion 判斷都留給 Parent（run-g1-6-ga4-h1-1-ga4-diagnostic-
// contract.js）做，Worker 不自己決定 PASS/FAIL。
//
// 輸入：process.argv[2] 是一段 JSON（scenario 設定），至少包含
//   { scenario: 'auth' | 'credential' | 'sdk_unavailable' | 'property_unset'
//            | 'permission_denied' | 'invalid_argument' | 'network_failure'
//            | 'reject_promise' | 'summary_ok_city_fail' | 'full_success'
//            | 'safe_output_scan',
//     tmpDbPath: string }
//
// 輸出：stdout 最後一行是 JSON.stringify(result)；exit code 0 代表 Worker
// 本身跑完沒有 crash（不代表 Scenario 內容"通過"，那是 Parent 的判斷）。

'use strict';

const http = require('http');
const path = require('path');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..', '..');
const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';

function httpRequest(port, method, urlPath, { headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath,
      headers: { 'Content-Type': 'application/json', ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {}), ...headers },
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(chunks); } catch (e) { /* non-JSON */ }
        resolve({ status: res.statusCode, body: json, raw: chunks });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function storeToken(storeId) {
  return jwt.sign({ role: 'store', store_id: storeId, store_name: storeId }, JWT_SECRET, { expiresIn: '1h' });
}

// makeFakeGa4Client(kind) — 唯一的 Fake Client 建構點。每個 kind 都回傳
// production 程式實際會讀取的形狀：runRealtimeReport(request) →
// Promise（resolve 一個「陣列裡包一個 report 物件」，跟真實
// @google-analytics/data SDK 的 [response] 解構慣例一致；reject 時是一個
// Error，帶 code/message/details/status，安全假值不含真實 Property ID）。
function makeFakeGa4Client(kind, opts = {}) {
  const isCity = (request) => Array.isArray(request.dimensions) && request.dimensions.length > 0;
  const successResponse = (activeUsers) => [{
    rows: [{ dimensionValues: [], metricValues: [{ value: String(activeUsers) }, { value: '10' }] }],
    dimensionHeaders: [],
    metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }],
    propertyQuota: { tokensPerDay: { remaining: 1000 } },
  }];
  const successCityResponse = () => [{
    rows: [{ dimensionValues: [{ value: 'Taipei' }, { value: 'TW' }], metricValues: [{ value: '3' }, { value: '5' }] }],
    dimensionHeaders: [{ name: 'city' }, { name: 'countryId' }],
    metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }],
    propertyQuota: { tokensPerDay: { remaining: 999 } },
  }];

  return {
    // 內部私有標記，只存在於這個物件自己身上，絕不應該出現在任何 HTTP
    // 回應裡——safe_output_scan Scenario 專門掃這個字串來證明 Fake Client
    // 內部資料真的不會外漏（需求文件五之 27）。
    __fakeClientInternalMarker: 'qa_fake_client_internal_marker_do_not_leak',
    async runRealtimeReport(request) {
      const stage = isCity(request) ? 'city' : 'summary';
      if (kind === 'permission_denied') {
        const err = new Error('qa_permission_denied');
        err.code = 403;
        err.status = 'PERMISSION_DENIED';
        err.details = 'qa_fake_permission_denied_detail';
        throw err;
      }
      if (kind === 'invalid_argument') {
        const err = new Error('qa_invalid_argument');
        err.code = 400;
        err.status = 'INVALID_ARGUMENT';
        err.details = 'qa_fake_invalid_argument_detail';
        throw err;
      }
      if (kind === 'network_failure') {
        const err = new Error('qa_network_failure_ECONNRESET');
        err.code = 'ECONNRESET';
        throw err;
      }
      if (kind === 'reject_promise') {
        return Promise.reject(Object.assign(new Error('qa_rejected_promise'), { code: 500 }));
      }
      if (kind === 'summary_ok_city_fail') {
        if (stage === 'summary') return successResponse(opts.activeUsers || 7);
        const err = new Error('qa_city_stage_failure');
        err.code = 500;
        throw err;
      }
      if (kind === 'full_success') {
        return stage === 'summary' ? successResponse(opts.activeUsers || 12) : successCityResponse();
      }
      // default：不應該被呼叫到（例如 credential/sdk_unavailable/
      // property_unset Scenario 根本不會走到需要打 Google 的階段）。
      throw new Error('qa_unexpected_fake_client_call');
    },
  };
}

async function main() {
  const cfg = JSON.parse(process.argv[2] || '{}');
  const scenario = cfg.scenario;
  const unhandledRejections = [];
  const onUnhandled = (reason) => { unhandledRejections.push(String(reason && reason.message || reason)); };
  process.on('unhandledRejection', onUnhandled);

  process.env.POS_DB_PATH = cfg.tmpDbPath;
  process.env.GA4_REALTIME_ENABLED = 'true';
  // 需求文件四：Worker process 一律先清掉可能污染 credential_available
  // 判定的真實憑證環境變數（每個 Worker 都是全新 process，不會互相污染，
  // 但仍要防禦「執行環境本身」不小心設了這些變數）。
  delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
  delete process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64;
  delete process.env.GA4_SERVICE_ACCOUNT_JSON;

  const result = { scenario, ok: true, http: {}, facts: {}, error: null };

  try {
    const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
    await initDb();
    const db = getDb();

    const SECRET_PROPERTY_ID = cfg.propertyId || '399988877';
    const SECRET_STREAM_ID = cfg.streamId || '588877766';

    function setupStore(storeId, { propertyId = null, streamId = null, ga4Enabled = true } = {}) {
      db.run('INSERT OR IGNORE INTO stores (store_id, store_name) VALUES (?, ?)', [storeId, storeId]);
      db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_enabled', ?)", [storeId, ga4Enabled ? 'true' : 'false']);
      if (propertyId) db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_property_id', ?)", [storeId, propertyId]);
      if (streamId) db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_stream_id', ?)", [storeId, streamId]);
    }

    setupStore('store_diag_ok', { propertyId: SECRET_PROPERTY_ID, streamId: SECRET_STREAM_ID });
    setupStore('store_diag_b', { propertyId: '111100002', streamId: '222200003' });
    setupStore('store_diag_unconfigured', {});

    // 每個 Worker process 只 require 一次，全新載入，沒有任何跨 Scenario
    // 的 stale reference 問題（見需求文件二／三）。
    let sdkPoisonPath = null;
    let sdkPoisonOriginal;
    if (scenario === 'sdk_unavailable') {
      sdkPoisonPath = require.resolve('@google-analytics/data');
      sdkPoisonOriginal = require.cache[sdkPoisonPath];
      require.cache[sdkPoisonPath] = { id: sdkPoisonPath, filename: sdkPoisonPath, loaded: true, exports: {} };
    }

    const ga4Client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
    require(path.join(ROOT, 'utils/ga4Realtime/index.js'));
    const connectionTest = require(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'));
    const { requireStore } = require(path.join(ROOT, 'middleware/storeGuard.js'));
    const geoLiveRouter = require(path.join(ROOT, 'routes/geo-live.js'));

    result.facts.sdkAvailableBeforeInject = ga4Client.isSdkAvailable();

    const fakeClientKinds = ['permission_denied', 'invalid_argument', 'network_failure', 'reject_promise', 'summary_ok_city_fail', 'full_success', 'safe_output_scan'];
    if (fakeClientKinds.includes(scenario)) {
      const kind = (scenario === 'safe_output_scan') ? (cfg.safeOutputScanKind || 'summary_ok_city_fail') : scenario;
      ga4Client._setClientForTest(makeFakeGa4Client(kind, cfg.fakeOpts || {}));
    }

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use('/api/geo-live', requireStore, geoLiveRouter);
    const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
    const port = server.address().port;

    try {
      if (scenario === 'auth') {
        result.http.noAuthStatus = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status');
        result.http.noAuthTest = await httpRequest(port, 'POST', '/api/geo-live/ga4-realtime-test');
        result.http.invalidJwt = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer not-a-real-jwt' } });
        result.http.validJwt = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
        // 需求文件五之 5／6：query/body store_id 覆寫攻擊——用一個「狀態
        // 明顯不同」的店家（store_diag_unconfigured：property_configured
        // 一定是 false）當攻擊目標，而不是另一個同樣已設定的店家（兩個都
        // 設定過 Property 的店家，/status 回應的 boolean 欄位形狀會完全
        // 相同，比較 JSON 字串無法證明任何事，見本輪除錯記錄）。
        const overrideTargetStoreId = 'store_diag_unconfigured';
        const okAuthHeader = { Authorization: 'Bearer ' + storeToken('store_diag_ok') };
        result.http.queryOverrideAttempt = await httpRequest(port, 'GET', `/api/geo-live/ga4-realtime-status?store_id=${overrideTargetStoreId}`, { headers: okAuthHeader });
        result.http.bodyOverrideAttempt = await httpRequest(port, 'POST', '/api/geo-live/ga4-realtime-test', { headers: okAuthHeader, body: { store_id: overrideTargetStoreId } });
        result.http.directB = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer ' + storeToken(overrideTargetStoreId) } });
      } else if (scenario === 'credential') {
        result.http.status = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
      } else if (scenario === 'sdk_unavailable') {
        result.http.test = await httpRequest(port, 'POST', '/api/geo-live/ga4-realtime-test', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
      } else if (scenario === 'property_unset') {
        result.http.status = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_unconfigured') } });
      } else if (['permission_denied', 'invalid_argument', 'network_failure', 'reject_promise', 'summary_ok_city_fail', 'full_success'].includes(scenario)) {
        result.http.test = await httpRequest(port, 'POST', '/api/geo-live/ga4-realtime-test', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
      } else if (scenario === 'safe_output_scan') {
        result.http.test = await httpRequest(port, 'POST', '/api/geo-live/ga4-realtime-test', { headers: { 'x-secret-test-header': 'qa_should_never_echo', Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
        result.http.status = await httpRequest(port, 'GET', '/api/geo-live/ga4-realtime-status', { headers: { Authorization: 'Bearer ' + storeToken('store_diag_ok') } });
      } else {
        throw new Error(`unknown scenario: ${scenario}`);
      }

      // 讓任何 microtask/rejection 有機會在關閉 server 前浮現（需求文件五
      // 之 13：Fake Client rejected Promise 不得造成 unhandledRejection）。
      await new Promise((r) => setTimeout(r, 20));
    } finally {
      server.close();
    }

    result.facts.secretPropertyId = SECRET_PROPERTY_ID;
    result.facts.secretStreamId = SECRET_STREAM_ID;
    result.facts.sdkAvailableAfterScenario = ga4Client.isSdkAvailable();
    result.facts.unhandledRejections = unhandledRejections;

    // Reset fake client（需求文件三之 9／需求文件五：Worker 結束前必須
    // reset，不留殘留給——雖然這個 process 本身即將結束，仍照規範執行，
    // 作為「即使未來改成長駐 Worker Pool 也安全」的防禦性寫法）。
    ga4Client._resetForTest();
    connectionTest.resetForTest();
    if (sdkPoisonPath) {
      if (sdkPoisonOriginal) require.cache[sdkPoisonPath] = sdkPoisonOriginal;
      else delete require.cache[sdkPoisonPath];
    }
  } catch (e) {
    result.ok = false;
    result.error = { message: e && e.message, stack: e && e.stack };
  }

  process.removeListener('unhandledRejection', onUnhandled);
  result.facts.unhandledRejectionListenerCountAtExit = process.listenerCount('unhandledRejection');

  // 唯一輸出：最後一行印出完整 JSON（Parent 只解析最後一行，前面任何
  // Production 程式碼自己的 console.log/console.warn 都不會污染解析）。
  console.log('###WORKER_RESULT###' + JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => {
  console.log('###WORKER_RESULT###' + JSON.stringify({ scenario: (JSON.parse(process.argv[2] || '{}').scenario), ok: false, error: { message: e && e.message, stack: e && e.stack }, http: {}, facts: {} }));
  process.exit(1);
});
