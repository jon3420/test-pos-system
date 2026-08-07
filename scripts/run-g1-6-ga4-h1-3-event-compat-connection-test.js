#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// Event Compatibility Connection Test — Contract Gate。
//
// 驗證重點（見需求文件三～八、十一）：
//   Basic Mode（不傳 includeEventCompatibility，或明確 false）：
//     - 完全不呼叫 4 個 Event Metric Probe。
//     - Google Call 數與 H1.2 baseline 完全相同（Summary+City=2 次）。
//     - Response Shape 與 H1.2 baseline 完全相同（只多出恆為安全預設值的
//       event_compat_tested:false／*_ok:null 等新欄位，不影響既有欄位）。
//   Event Mode（includeEventCompatibility:true）：
//     - 額外呼叫 view_item/add_to_cart/checkout/purchase 4 個 Summary Only
//       Probe（Google Call 數 = 2 + 4 = 6）。
//     - 每個 Metric 各自的 ok/stage/code 正確回報。
//     - 絕不洩漏 Property／Stream／Credential／Raw Google Error。
//     - Single-flight／Rate Limit／Cache 與 Basic Mode 完全隔離，互不污染。
//     - Event Probe 失敗／逾時不影響 visitors 本身的 Summary/City 結果。
//
// 全部用真實函式呼叫（requestBuilder／requestPair／connectionTest），不是
// 只做字串掃描。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('EVENT COMPAT CONNECTION TEST — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  process.env.GA4_REALTIME_ENABLED = 'true';

  // ── 0. node --check（本檔案自身 + 本輪修改的所有 Production 檔案）──
  [
    'scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js',
    'utils/ga4Realtime/requestBuilder.js',
    'utils/ga4Realtime/requestPair.js',
    'utils/ga4Realtime/connectionTest.js',
    'utils/ga4Realtime/index.js',
    'routes/geo-live.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const DATA_DIR = path.join(ROOT, 'data');
  const DB_FILE = path.join(DATA_DIR, 'pos.db');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_ec_a', 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_ec_b', 1]);

  function setSetting(storeId, key, value) {
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  function configureStore(storeId, { propertyId = '111111', streamId = '9001' } = {}) {
    setSetting(storeId, 'ga4_realtime_enabled', '1');
    setSetting(storeId, 'ga4_realtime_property_id', propertyId);
    setSetting(storeId, 'ga4_realtime_stream_id', streamId);
  }

  const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
  const connTest = require(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'));

  function resetAll() {
    connTest.resetForTest();
    configureStore('store_ec_a');
    configureStore('store_ec_b');
  }

  // OK response helper: summary(dimensions.length===0-ish detection is not
  // reliable once eventName dims are added for event metrics, so instead we
  // key the fake client's behaviour off request.metrics — visitors metrics
  // include screenPageViews, event metrics don't; but simplest robust signal
  // is dimensionFilter presence: absent => visitors summary/city, present
  // => event metric probe.
  function summaryOkResponse() {
    return [{ rows: [{ dimensionValues: [], metricValues: [{ value: '1' }, { value: '2' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }];
  }
  function cityOkResponse() {
    return [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }];
  }

  // ══════════════════════════════════════════════════════════════
  // A. Basic Mode（1-7）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    let callCount = 0;
    const seenMetricProbes = [];
    client._setClientForTest({
      async runRealtimeReport(req) {
        callCount += 1;
        const hasEventFilter = !!(req.dimensionFilter && JSON.stringify(req.dimensionFilter).includes('eventName'));
        if (hasEventFilter) seenMetricProbes.push(JSON.stringify(req.dimensionFilter));
        return req.dimensions.length === 0 ? summaryOkResponse() : cityOkResponse();
      },
    });

    const rDefault = await connTest.runGa4ConnectionTest(db, 'store_ec_a');
    assert(rDefault.connected === true, '1. Basic Mode (no options) still connects like H1.2 baseline');
    assert(callCount === 2, '6. baseline Google call count unchanged (2: summary+city)', `got ${callCount}`);
    assert(seenMetricProbes.length === 0, '2. view_item probe not called in Basic Mode');
    assert(rDefault.event_compat_tested === false, 'Basic Mode: event_compat_tested:false');
    assert(rDefault.view_item_ok === null && rDefault.add_to_cart_ok === null && rDefault.checkout_ok === null && rDefault.purchase_ok === null,
      '3-5. add_to_cart/checkout/purchase probes not called (fields null) in Basic Mode');
    assert(typeof rDefault.connected === 'boolean' && typeof rDefault.property_accessible === 'boolean' && typeof rDefault.summary_request_ok === 'boolean',
      '7. baseline success shape unchanged (core fields present)');

    resetAll();
    callCount = 0;
    client._setClientForTest({
      async runRealtimeReport(req) { callCount += 1; return req.dimensions.length === 0 ? summaryOkResponse() : cityOkResponse(); },
    });
    const rExplicitFalse = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: false });
    assert(callCount === 2, 'Basic Mode (explicit false) call count unchanged', `got ${callCount}`);
    assert(rExplicitFalse.event_compat_tested === false, 'Basic Mode (explicit false): event_compat_tested:false');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Event Mode（8-19）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    let callCount = 0;
    const probedEvents = [];
    client._setClientForTest({
      async runRealtimeReport(req) {
        callCount += 1;
        const filterStr = req.dimensionFilter ? JSON.stringify(req.dimensionFilter) : '';
        if (req.dimensions.length === 0 && !filterStr) return summaryOkResponse(); // visitors summary
        if (req.dimensions.some((d) => d.name === 'city')) return cityOkResponse(); // visitors city
        // Event metric summary-only probe: dimensions includes eventName, no city.
        ['view_item', 'add_to_cart', 'begin_checkout', 'purchase'].forEach((ev) => {
          if (filterStr.includes(ev)) probedEvents.push(ev);
        });
        return summaryOkResponse();
      },
    });

    const rEvent = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: true });
    assert(rEvent.event_compat_tested === true, '8. explicit true → event_compat_tested:true');
    assert(rEvent.visitors_ok === true, '9. visitors probe (main summary) 正常');
    assert(callCount === 6, 'Event Mode Google call count = 6 (2 visitors + 4 event probes)', `got ${callCount}`);
    assert(probedEvents.includes('view_item'), '10. view_item probe called');
    assert(probedEvents.includes('add_to_cart'), '11. add_to_cart probe called');
    assert(probedEvents.includes('begin_checkout'), '12. checkout probe called (eventName=begin_checkout)');
    assert(probedEvents.includes('purchase'), '13. purchase probe called');
    assert(rEvent.view_item_ok === true && rEvent.add_to_cart_ok === true && rEvent.checkout_ok === true && rEvent.purchase_ok === true,
      'per-metric ok:true when probe succeeds');
    assert(rEvent.view_item_stage === 'summary' && rEvent.purchase_stage === 'summary', '14. per-metric stage present ("summary")');
    assert(rEvent.view_item_code === null && rEvent.purchase_code === null, '15. per-metric code null when ok');
    assert(typeof rEvent.request_variant === 'string' && rEvent.request_variant.length > 0, 'request_variant surfaced for diagnostics');

    const rawStr = JSON.stringify(rEvent);
    assert(!/111111/.test(rawStr), '17. no property ID in response');
    assert(!/9001/.test(rawStr), '18. no stream ID in response');
    // 19. 不得洩漏憑證內容——注意既有 H1.2 baseline Contract 本來就合法回傳
    // `credential_available` 這個布林欄位（見 connectionTest.js _baseTestResult），
    // 所以這裡只檢查憑證「內容」相關字樣（private_key／client_email／實際
    // credential 值 shape），不得誤判合法的 credential_available 欄位名稱。
    assert(!/private_key|client_email|"credentials"|BEGIN PRIVATE KEY/i.test(rawStr), '19. no credential content in response');
    assert(!/stack|Error:/i.test(rawStr), '16. no raw Google error in response');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Per-metric failure isolation（per-metric stage/code on failure）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        const filterStr = req.dimensionFilter ? JSON.stringify(req.dimensionFilter) : '';
        if (req.dimensions.length === 0 && !filterStr) return summaryOkResponse();
        if (req.dimensions.some((d) => d.name === 'city')) return cityOkResponse();
        if (filterStr.includes('view_item')) { const e = new Error('boom'); e.code = 400; throw e; }
        return summaryOkResponse();
      },
    });
    const r = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: true });
    assert(r.view_item_ok === false, 'view_item probe failure reported as ok:false');
    assert(r.view_item_code === '400', 'view_item probe failure code surfaced (safe classified code)');
    assert(r.add_to_cart_ok === true, '7. event compat failure (view_item) 不污染其他 metric (add_to_cart)');
    assert(r.visitors_ok === true, 'event compat failure 不污染 visitors 本身結果');
    assert(r.connected === true, 'event probe failure 不影響整體 connected（visitors summary+city 仍成功）');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Timeout isolation
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    process.env.GA4_REALTIME_TIMEOUT_MS = '30';
    client._setClientForTest({
      async runRealtimeReport(req) {
        const filterStr = req.dimensionFilter ? JSON.stringify(req.dimensionFilter) : '';
        if (req.dimensions.length === 0 && !filterStr) return summaryOkResponse();
        if (req.dimensions.some((d) => d.name === 'city')) return cityOkResponse();
        if (filterStr.includes('purchase')) { await new Promise((r) => setTimeout(r, 200)); return summaryOkResponse(); }
        return summaryOkResponse();
      },
    });
    const r = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: true });
    assert(r.purchase_ok === false, '8. purchase probe timeout reported as ok:false');
    assert(r.visitors_ok === true, '8. event compat timeout 不污染 basic (visitors) 結果');
    delete process.env.GA4_REALTIME_TIMEOUT_MS;
  }

  // ══════════════════════════════════════════════════════════════
  // E. Single-flight / Cache isolation（20-25）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    let basicCalls = 0;
    let eventCalls = 0;
    client._setClientForTest({
      async runRealtimeReport(req) {
        const filterStr = req.dimensionFilter ? JSON.stringify(req.dimensionFilter) : '';
        const isEventProbe = filterStr && !req.dimensions.some((d) => d.name === 'city') && req.dimensions.some((d) => d.name === 'eventName');
        if (isEventProbe) eventCalls += 1; else basicCalls += 1;
        return req.dimensions.length === 0 && !filterStr ? summaryOkResponse() : (req.dimensions.some((d) => d.name === 'city') ? cityOkResponse() : summaryOkResponse());
      },
    });

    // 20. single-flight within same mode
    const concurrentBasic = await Promise.all([
      connTest.runGa4ConnectionTest(db, 'store_ec_b'),
      connTest.runGa4ConnectionTest(db, 'store_ec_b'),
    ]);
    assert(basicCalls === 2, '20. normal test single-flight 仍正常 (concurrent same-store basic = 1 logical test = 2 calls)', `got ${basicCalls}`);
    assert(concurrentBasic[0].connected === concurrentBasic[1].connected, '20b. concurrent basic calls share the same logical result');

    resetAll();
    basicCalls = 0; eventCalls = 0;
    client._setClientForTest({
      async runRealtimeReport(req) {
        const filterStr = req.dimensionFilter ? JSON.stringify(req.dimensionFilter) : '';
        const isEventProbe = filterStr && !req.dimensions.some((d) => d.name === 'city') && req.dimensions.some((d) => d.name === 'eventName');
        if (isEventProbe) eventCalls += 1; else basicCalls += 1;
        return req.dimensions.length === 0 && !filterStr ? summaryOkResponse() : (req.dimensions.some((d) => d.name === 'city') ? cityOkResponse() : summaryOkResponse());
      },
    });
    const concurrentEvent = await Promise.all([
      connTest.runGa4ConnectionTest(db, 'store_ec_b', { includeEventCompatibility: true }),
      connTest.runGa4ConnectionTest(db, 'store_ec_b', { includeEventCompatibility: true }),
    ]);
    assert(eventCalls === 4, '21. event compat single-flight 也正常 (concurrent same-store event = 1 logical test = 4 event calls)', `got ${eventCalls}`);
    assert(concurrentEvent[0].event_compat_tested === true && concurrentEvent[1].event_compat_tested === true, 'concurrent event compat calls both see event_compat_tested:true');

    // 22. normal/event cache 不互相污染: run basic then event immediately, both should actually execute (not rate-limited against each other)
    resetAll();
    let totalCalls = 0;
    client._setClientForTest({ async runRealtimeReport(req) { totalCalls += 1; return req.dimensions.length === 0 && !req.dimensionFilter ? summaryOkResponse() : (req.dimensions.some((d) => d.name === 'city') ? cityOkResponse() : summaryOkResponse()); } });
    const basicFirst = await connTest.runGa4ConnectionTest(db, 'store_ec_a');
    const eventSecond = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: true });
    assert(basicFirst.rate_limited !== true, '22a. basic test not rate-limited on first call');
    assert(eventSecond.rate_limited !== true, '22b. event compat test right after basic test is NOT rate-limited against basic (cache isolation)');
    assert(eventSecond.event_compat_tested === true, '22c. event compat result actually has event fields (not reused from basic cache)');

    // 22d. reverse order: event first, then basic — basic should not inherit event fields as if it were rate-limited
    resetAll();
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 && !req.dimensionFilter ? summaryOkResponse() : (req.dimensions.some((d) => d.name === 'city') ? cityOkResponse() : summaryOkResponse()); } });
    const eventFirst = await connTest.runGa4ConnectionTest(db, 'store_ec_a', { includeEventCompatibility: true });
    const basicSecond = await connTest.runGa4ConnectionTest(db, 'store_ec_a');
    assert(basicSecond.rate_limited !== true, '22e. basic test right after event compat test is NOT rate-limited against event compat (cache isolation)');
    assert(eventFirst.event_compat_tested === true && basicSecond.event_compat_tested === false, '22f. each mode keeps its own contract shape, no cross-contamination');
  }

  // ══════════════════════════════════════════════════════════════
  // F. No listener / fake client residue（24-25）
  // ══════════════════════════════════════════════════════════════
  {
    assert(process.listenerCount('unhandledRejection') === 0, '24. no unhandledRejection listener residue');
    connTest.resetForTest();
    assert(connTest._inFlightTestForTest.size === 0, '25a. basic in-flight map empty after resetForTest');
    assert(connTest._lastTestAtEventCompatForTest.size === 0, '25b. event-compat map empty after resetForTest (no residue)');
  }

  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  printSummary();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
