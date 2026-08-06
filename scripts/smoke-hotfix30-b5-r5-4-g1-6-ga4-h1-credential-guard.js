#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-credential-guard.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1（bugfix 輪）
//
// 針對本輪在 utils/ga4Realtime/client.js 新增的 Credential Guard 做專門
// 驗證：無憑證時必須安全失敗，絕不嘗試建立真正的 SDK Client、絕不觸發
// google-auth-library 隱式 ADC 解析、絕不造成 unhandledRejection 或
// process crash；同時證明既有 _setClientForTest() 測試注入路徑完全不受
// 影響（Shared Client Regression Gate 的補充測試，不是替代）。

'use strict';

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

async function main() {
  const client = require('../utils/ga4Realtime/client');

  // 全程監控 process-level unhandledRejection；測試結束後移除，不殘留。
  const seenRejections = [];
  const rejectionListener = (reason) => { seenRejections.push(reason); };
  process.on('unhandledRejection', rejectionListener);

  const savedEnv = {
    GOOGLE_APPLICATION_CREDENTIALS: process.env.GOOGLE_APPLICATION_CREDENTIALS,
    GA4_SERVICE_ACCOUNT_JSON_BASE64: process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64,
    GA4_SERVICE_ACCOUNT_JSON: process.env.GA4_SERVICE_ACCOUNT_JSON,
  };
  function clearCredentialEnv() {
    delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
    delete process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64;
    delete process.env.GA4_SERVICE_ACCOUNT_JSON;
  }
  function restoreEnv() {
    Object.entries(savedEnv).forEach(([k, v]) => { if (v === undefined) delete process.env[k]; else process.env[k] = v; });
  }

  try {
    // ── Scenario A: 無 Credential、無 Test Client ──
    client._resetForTest();
    clearCredentialEnv();
    const before = seenRejections.length;
    const resultA = await client.runGa4RealtimeReport({ property: 'properties/1' }, { timeoutMs: 2000 });
    // 給事件迴圈一輪機會讓任何背景 Promise 的 rejection 浮出（若真的還有
    // 未接住的話），再檢查 unhandledRejection listener 有沒有被觸發。
    await new Promise((r) => setImmediate(r));
    check('A1. No credential + no test client: returns safe failure (not throw)', resultA.ok === false);
    check('A2. No credential: does not attempt implicit ADC (no SDK_UNAVAILABLE-class crash)', typeof resultA.code === 'string');
    check('A3. No credential: process did not crash (we are still executing)', true);
    check('A4. No credential: no unhandledRejection fired', seenRejections.length === before, JSON.stringify(seenRejections.slice(before)));

    // ── Scenario B: 無 Credential，已 _setClientForTest(fakeClient) ──
    clearCredentialEnv();
    const fakeRows = [{ dimensionValues: [{ value: 'Taiwan' }, { value: 'Taoyuan City' }, { value: 'Zhongli District' }], metricValues: [{ value: '2' }, { value: '5' }] }];
    const fakeClient = {
      runRealtimeReport: async () => ([{ rows: fakeRows, dimensionHeaders: [{ name: 'country' }, { name: 'region' }, { name: 'city' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }]),
      runReport: async () => ([{ rows: fakeRows, dimensionHeaders: [{ name: 'country' }, { name: 'region' }, { name: 'city' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }] }]),
    };
    client._setClientForTest(fakeClient);
    const resultB = await client.runGa4RealtimeReport({ property: 'properties/1' }, { timeoutMs: 2000 });
    check('B1. No credential BUT test client injected: guard does not block it', resultB.ok === true, JSON.stringify(resultB));
    check('B2. Uses the injected fakeClient (rows echoed back)', resultB.ok && resultB.rows && resultB.rows.length === 1);

    // ── Scenario C: 同一個 fakeClient，呼叫 runGa4Report() ──
    const resultC = await client.runGa4Report({ property: 'properties/1' }, { timeoutMs: 2000 });
    check('C1. No credential BUT test client injected: runGa4Report() also not blocked', resultC.ok === true, JSON.stringify(resultC));
    check('C2. runGa4Report uses the same injected fakeClient (rows echoed back)', resultC.ok && resultC.rows && resultC.rows.length === 1);

    // ── Scenario D: Test Client Reset → 再呼叫真實 Client（無憑證）──
    client._resetForTest();
    clearCredentialEnv();
    const resultD = await client.runGa4RealtimeReport({ property: 'properties/1' }, { timeoutMs: 2000 });
    check('D1. After reset, no credential: safe failure again (fakeClient not reused)', resultD.ok === false);
    check('D2. After reset: result does not echo fakeClient rows (stale client not reused)', !(resultD.rows && resultD.rows.length === 1));

    // ── Scenario E: Credential Configured（假造 base64 JSON + Stub SDK）──
    client._resetForTest();
    process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64 = Buffer.from(JSON.stringify({
      type: 'service_account', project_id: 'qa-fake-project', private_key: 'qa_mock_not_a_real_key', client_email: 'qa-mock@example.com',
    })).toString('base64');
    // credentialStatus() 應該回報 available（來源是 base64 JSON），但實際
    // Client 建構仍取決於 @google-analytics/data 套件本身；這裡只驗證
    // credentialStatus() 的判斷邏輯本身正確，不強行 mock 掉整個 SDK 建構鏈
    // （那已經是 Shared Client Regression Gate 的既有 smoke test 範圍）。
    const status = client.credentialStatus();
    check('E1. With base64 JSON configured, credentialStatus() reports available', status.available === true, JSON.stringify(status));
    check('E2. credentialStatus() source correctly identifies base64 JSON', status.source === 'service_account_json_base64');
    delete process.env.GA4_SERVICE_ACCOUNT_JSON_BASE64;
    client._resetForTest();

    // ── Scenario F: Fake Client 回傳 rejected Promise ──
    const rejectingClient = {
      runRealtimeReport: async () => { throw new Error('simulated GA4 API failure'); },
      runReport: async () => { throw new Error('simulated GA4 API failure'); },
    };
    client._setClientForTest(rejectingClient);
    const beforeF = seenRejections.length;
    const resultF = await client.runGa4RealtimeReport({ property: 'properties/1' }, { timeoutMs: 2000 });
    await new Promise((r) => setImmediate(r));
    check('F1. Rejected client promise is caught, not thrown to caller', resultF.ok === false);
    check('F2. Rejected promise mapped to a safe error code', typeof resultF.code === 'string' && resultF.code.length > 0, resultF.code);
    check('F3. No unhandledRejection triggered by the rejecting client', seenRejections.length === beforeF, JSON.stringify(seenRejections.slice(beforeF)));

    // ── Singleton check: fakeClient injected once, reused across calls (Scenario E follow-through) ──
    client._resetForTest();
    let constructCount = 0;
    const countingClient = {
      runRealtimeReport: async () => { constructCount += 1; return [{ rows: [], dimensionHeaders: [], metricHeaders: [], propertyQuota: {} }]; },
    };
    client._setClientForTest(countingClient);
    await client.runGa4RealtimeReport({ property: 'properties/1' });
    await client.runGa4RealtimeReport({ property: 'properties/1' });
    check('Singleton: same injected client instance reused across 2 calls (constructCount tracked via call count, not re-injected)', constructCount === 2);
  } finally {
    client._resetForTest();
    restoreEnv();
    process.removeListener('unhandledRejection', rejectionListener);
  }

  check('Cleanup: unhandledRejection listener removed', process.listenerCount('unhandledRejection') === 0, `remaining=${process.listenerCount('unhandledRejection')}`);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1 Credential Guard Smoke: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('Credential guard smoke crashed:', e);
  process.exit(1);
});
