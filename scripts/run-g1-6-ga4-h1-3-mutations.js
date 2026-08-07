#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-3-mutations.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// Mutation Suite — 每一組故意把正式碼改回「已知錯誤／已修正前」的行為，
// 證明本輪新增的 Contract／Test 真的會攔截，不是空話。每組都：
//   1. 對「真正的正式原始碼」做 byte-exact 字串替換（mutateOnce/mutateAll，
//      先驗證命中次數，命中數不對就直接丟例外，不會悄悄跳過)。
//   2. 把 mutated 版本寫成暫存檔（跟原始檔同目錄，讓 require('./x')/
//      require('../y') 這類相對路徑照樣解析得到；沒有 require 依賴的檔案
//      才寫到 os.tmpdir()）。
//   3. 分別跑「mutated 版」與「真正正式版」，證明：mutated 版 FAIL、
//      正式版 PASS。
//   4. 用完刪除暫存檔，不留 Residue。

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('MUTATION SUITE — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function mutateOnce(src, searchStr, replaceStr) {
  const count = src.split(searchStr).length - 1;
  if (count !== 1) throw new Error(`mutateOnce: expected exactly 1 occurrence, found ${count} — "${searchStr.slice(0, 90)}..."`);
  const idx = src.indexOf(searchStr);
  return src.slice(0, idx) + replaceStr + src.slice(idx + searchStr.length);
}

const tempFiles = [];
function writeAdjacent(originalPath, mutatedSrc, tag) {
  const dir = path.dirname(originalPath);
  const base = path.basename(originalPath, '.js');
  const p = path.join(dir, `.__mut_${base}_${tag}_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, mutatedSrc, 'utf8');
  tempFiles.push(p);
  delete require.cache[p];
  return p;
}
function writeTmp(mutatedSrc, tag) {
  const p = path.join(os.tmpdir(), `mut-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(p, mutatedSrc, 'utf8');
  tempFiles.push(p);
  delete require.cache[p];
  return p;
}
function cleanupTempFiles() {
  tempFiles.forEach((p) => { try { fs.unlinkSync(p); } catch (e) { /* already gone */ } });
  tempFiles.length = 0;
}

async function main() {
  process.env.GA4_REALTIME_ENABLED = 'true';

  const RB_PATH = path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js');
  const CT_PATH = path.join(ROOT, 'utils/ga4Realtime/connectionTest.js');
  const ROUTE_PATH = path.join(ROOT, 'routes/geo-live.js');
  const SYNC_PATH = path.join(ROOT, 'services/ga4GeoSyncService.js');
  const PANEL_PATH = path.join(ROOT, 'public/js/geo-ga4-h1-panel.js');
  const DT_PATH = path.join(ROOT, 'utils/dateTime.js');
  const IDX_PATH = path.join(ROOT, 'utils/ga4Realtime/index.js');

  const rbSrc = fs.readFileSync(RB_PATH, 'utf8');
  const ctSrc = fs.readFileSync(CT_PATH, 'utf8');
  const routeSrc = fs.readFileSync(ROUTE_PATH, 'utf8');
  const syncSrc = fs.readFileSync(SYNC_PATH, 'utf8');
  const panelSrc = fs.readFileSync(PANEL_PATH, 'utf8');
  const dtSrc = fs.readFileSync(DT_PATH, 'utf8');
  const idxSrc = fs.readFileSync(IDX_PATH, 'utf8');

  const ERR_PATH = path.join(ROOT, 'utils/ga4Realtime/errors.js');
  const errSrc = fs.readFileSync(ERR_PATH, 'utf8');

  function stripComments(src) {
    return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  }

  // ══════════════════════════════════════════════════════════════
  // A. Remove eventName dimension for event metric (keep filter)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(rbSrc,
      "  dims.push({ name: 'eventName' });\n  if (hasStream) dims.push({ name: 'streamId' });",
      "  // MUTATION-A: eventName dimension intentionally NOT pushed, filter still references it\n  if (hasStream) dims.push({ name: 'streamId' });");
    const p = writeTmp(mutated, 'a-requestBuilder');
    const mutRb = require(p);
    const realRb = require(RB_PATH);

    let mutatedCaughtAtLeastOne = false;
    let realAllOk = true;
    for (const metric of ['view_item', 'add_to_cart', 'checkout', 'purchase']) {
      const mutReq = mutRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: '9001', windowMinutes: 5, metric });
      const mutDims = mutReq.request.dimensions.map((d) => d.name);
      const mutHasFilterButNotDim = JSON.stringify(mutReq.request.dimensionFilter).includes('eventName') && !mutDims.includes('eventName');
      if (mutHasFilterButNotDim) mutatedCaughtAtLeastOne = true;

      const realReq = realRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: '9001', windowMinutes: 5, metric });
      const realDims = realReq.request.dimensions.map((d) => d.name);
      if (!realDims.includes('eventName')) realAllOk = false;
    }
    assert(mutatedCaughtAtLeastOne, 'A. mutated source: filter references eventName but dimensions omit it (at least one event metric affected)');
    assert(realAllOk, 'A2. real source: every event metric still includes eventName in both filter and dimensions (Contract intact)');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Stream filter present but stream dimension removed
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(rbSrc,
      "  dims.push({ name: 'eventName' });\n  if (hasStream) dims.push({ name: 'streamId' });",
      "  dims.push({ name: 'eventName' });\n  // MUTATION-B: streamId dimension intentionally NOT pushed even when hasStream is true");
    const p = writeTmp(mutated, 'b-requestBuilder');
    const mutRb = require(p);
    const realRb = require(RB_PATH);

    const mutReq = mutRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: '9001', windowMinutes: 5, metric: 'view_item' });
    const mutDims = mutReq.request.dimensions.map((d) => d.name);
    const mutFilterHasStream = JSON.stringify(mutReq.request.dimensionFilter).includes('9001');
    assert(mutFilterHasStream && !mutDims.includes('streamId'), 'B. mutated source: streamId filter present but streamId dimension missing (Variant B Contract violated)');

    const realReq = realRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: '9001', windowMinutes: 5, metric: 'view_item' });
    const realDims = realReq.request.dimensions.map((d) => d.name);
    assert(realDims.includes('streamId'), 'B2. real source: streamId dimension present when streamId filter is used (Contract intact)');

    const realVisitors = realRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: '9001', windowMinutes: 5, metric: 'visitors' });
    assert(realVisitors.request.dimensions.length === 0, 'B3. visitors baseline unaffected by this mutation area (still dimensions:[])');
  }

  // ══════════════════════════════════════════════════════════════
  // C. view_item mapping changed to a wrong/broken event name
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(rbSrc,
      "  view_item:   { eventName: 'view_item',       includeScreenPageViews: false },",
      "  view_item:   { eventName: 'view_item_broken', includeScreenPageViews: false }, // MUTATION-C");
    const p = writeTmp(mutated, 'c-requestBuilder');
    const mutRb = require(p);
    const realRb = require(RB_PATH);

    const mutReq = mutRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'view_item' });
    assert(JSON.stringify(mutReq.request.dimensionFilter).includes('view_item_broken'), 'C. mutated source: view_item now filters the wrong/broken event name');

    const realReq = realRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'view_item' });
    assert(JSON.stringify(realReq.request.dimensionFilter).includes('"view_item"') && !JSON.stringify(realReq.request.dimensionFilter).includes('view_item_broken'), 'C2. real source: view_item correctly filters "view_item"');
  }

  // ══════════════════════════════════════════════════════════════
  // D. checkout mapping changed from begin_checkout back to "checkout"
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(rbSrc,
      "  checkout:    { eventName: 'begin_checkout',   includeScreenPageViews: false },",
      "  checkout:    { eventName: 'checkout',         includeScreenPageViews: false }, // MUTATION-D");
    const p = writeTmp(mutated, 'd-requestBuilder');
    const mutRb = require(p);
    const realRb = require(RB_PATH);

    const mutReq = mutRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'checkout' });
    assert(JSON.stringify(mutReq.request.dimensionFilter).includes('"checkout"') && !JSON.stringify(mutReq.request.dimensionFilter).includes('begin_checkout'), 'D. mutated source: checkout now filters the wrong literal "checkout" event');

    const realReq = realRb.buildGa4RealtimeSummaryRequest({ propertyId: '1', streamId: null, windowMinutes: 5, metric: 'checkout' });
    assert(JSON.stringify(realReq.request.dimensionFilter).includes('begin_checkout'), 'D2. real source: checkout correctly filters "begin_checkout"');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Event Compat Probe becomes unconditional (basic mode also runs it)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(ctSrc,
      "  return includeEventCompatibility\n    ? _runEventCompatConnectionTest(db, storeId)\n    : _runBasicConnectionTest(db, storeId);",
      "  // MUTATION-E: always runs the Event Compatibility probes, ignoring includeEventCompatibility\n  return _runEventCompatConnectionTest(db, storeId);");
    const p = writeAdjacent(CT_PATH, mutated, 'e');
    const mutCt = require(p);
    const realCt = require(CT_PATH);

    const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
    await initDb();
    const db = getDb();
    db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_mut_e', 1]);
    function setSetting(storeId, key, value) {
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
      if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
    }
    setSetting('store_mut_e', 'ga4_realtime_enabled', '1');
    setSetting('store_mut_e', 'ga4_realtime_property_id', '111111');
    setSetting('store_mut_e', 'ga4_realtime_stream_id', '9001');

    const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
    let callCount = 0;
    client._setClientForTest({ async runRealtimeReport(req) { callCount += 1; const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name); return [{ rows: [], dimensionHeaders: dn.map((n) => ({ name: n })), metricHeaders: mn.map((n) => ({ name: n })), propertyQuota: {} }]; } });

    mutCt.resetForTest();
    callCount = 0;
    await mutCt.runGa4ConnectionTest(db, 'store_mut_e'); // no options => should be "basic" but mutation forces event-compat probes
    const mutatedBasicCallCount = callCount;
    assert(mutatedBasicCallCount === 6, 'E. mutated source: calling with NO options still triggers Event Compatibility probes (6 Google calls instead of 2) — F102/F103-equivalent contract violated', `got ${mutatedBasicCallCount}`);

    realCt.resetForTest();
    callCount = 0;
    await realCt.runGa4ConnectionTest(db, 'store_mut_e');
    assert(callCount === 2, 'E2. real source: calling with no options stays Basic Mode (2 Google calls)', `got ${callCount}`);
  }

  // ══════════════════════════════════════════════════════════════
  // F. Basic/Event Cache Shared (isolation removed)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(ctSrc,
      "async function _runEventCompatConnectionTest(db, storeId) {\n  const now = Date.now();\n  const last = _lastTestAtEventCompat.get(storeId);\n  if (last && (now - last) < RATE_LIMIT_MS && !_inFlightTestEventCompat.has(storeId)) {\n    const prev = _lastTestResultEventCompat.get(storeId);\n    const retryAfterSeconds = Math.max(0, Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000));\n    return { ...(prev || {}), rate_limited: true, retry_after_seconds: retryAfterSeconds, message: prev ? prev.message : `請稍候 ${retryAfterSeconds} 秒後再測試連線。` };\n  }\n\n  if (_inFlightTestEventCompat.has(storeId)) {\n    return _inFlightTestEventCompat.get(storeId);\n  }\n\n  const testPromise = _runTestNow(db, storeId, true)\n    .then((result) => {\n      _lastTestAtEventCompat.set(storeId, Date.now());\n      _lastTestResultEventCompat.set(storeId, result);\n      return result;\n    })\n    .catch(() => {\n      const fallback = { ..._baseTestResult(new Date().toISOString(), ga4Client.isSdkAvailable(), false), message: '連線測試發生未預期錯誤，請稍後再試。', error_code: 'ga4_unavailable' };\n      _lastTestAtEventCompat.set(storeId, Date.now());\n      _lastTestResultEventCompat.set(storeId, fallback);\n      return fallback;\n    })\n    .finally(() => { _inFlightTestEventCompat.delete(storeId); });\n\n  _inFlightTestEventCompat.set(storeId, testPromise);\n  return testPromise;\n}",
      "async function _runEventCompatConnectionTest(db, storeId) {\n  // MUTATION-F: shares the Basic Mode cache/in-flight/last-result maps\n  // entirely (read AND write), instead of using its own dedicated maps.\n  const now = Date.now();\n  const last = _lastTestAt.get(storeId);\n  if (last && (now - last) < RATE_LIMIT_MS && !_inFlightTest.has(storeId)) {\n    const prev = _lastTestResult.get(storeId);\n    const retryAfterSeconds = Math.max(0, Math.ceil((RATE_LIMIT_MS - (now - last)) / 1000));\n    return { ...(prev || {}), rate_limited: true, retry_after_seconds: retryAfterSeconds, message: prev ? prev.message : `請稍候 ${retryAfterSeconds} 秒後再測試連線。` };\n  }\n\n  if (_inFlightTest.has(storeId)) {\n    return _inFlightTest.get(storeId);\n  }\n\n  const testPromise = _runTestNow(db, storeId, true)\n    .then((result) => {\n      _lastTestAt.set(storeId, Date.now());\n      _lastTestResult.set(storeId, result);\n      return result;\n    })\n    .catch(() => {\n      const fallback = { ..._baseTestResult(new Date().toISOString(), ga4Client.isSdkAvailable(), false), message: '連線測試發生未預期錯誤，請稍後再試。', error_code: 'ga4_unavailable' };\n      _lastTestAt.set(storeId, Date.now());\n      _lastTestResult.set(storeId, fallback);\n      return fallback;\n    })\n    .finally(() => { _inFlightTest.delete(storeId); });\n\n  _inFlightTest.set(storeId, testPromise);\n  return testPromise;\n}");
    const p = writeAdjacent(CT_PATH, mutated, 'f');
    const mutCt = require(p);
    const realCt = require(CT_PATH);

    const { getDb } = require(path.join(ROOT, 'utils/db.js'));
    const db = getDb();
    function setSettingF(storeId, key, value) {
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
      if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
    }
    ['store_mut_f', 'store_mut_f2'].forEach((sid) => {
      db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [sid, 1]);
      setSettingF(sid, 'ga4_realtime_enabled', '1');
      setSettingF(sid, 'ga4_realtime_property_id', '111111');
      setSettingF(sid, 'ga4_realtime_stream_id', '9001');
    });
    const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
    client._setClientForTest({ async runRealtimeReport(req) { const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name); return [{ rows: [], dimensionHeaders: dn.map((n) => ({ name: n })), metricHeaders: mn.map((n) => ({ name: n })), propertyQuota: {} }]; } });

    // basic -> event: basic runs first (populates _lastTestAt), then event (shares cache) should immediately be treated as rate-limited if isolation is broken.
    mutCt.resetForTest();
    const basicFirst = await mutCt.runGa4ConnectionTest(db, 'store_mut_f');
    const eventSecond = await mutCt.runGa4ConnectionTest(db, 'store_mut_f', { includeEventCompatibility: true });
    const mutatedSharesCache = eventSecond.rate_limited === true || eventSecond.event_compat_tested !== true;
    assert(mutatedSharesCache, 'F. mutated source: basic → event immediately after shares the same cache (event probe result missing/rate-limited)', JSON.stringify(eventSecond).slice(0, 150));

    realCt.resetForTest();
    const realBasicFirst = await realCt.runGa4ConnectionTest(db, 'store_mut_f');
    const realEventSecond = await realCt.runGa4ConnectionTest(db, 'store_mut_f', { includeEventCompatibility: true });
    assert(realEventSecond.rate_limited !== true && realEventSecond.event_compat_tested === true, 'F2. real source: basic → event isolation intact (event probe still runs, not rate-limited by basic)');

    // event -> basic direction
    mutCt.resetForTest();
    const eventFirst = await mutCt.runGa4ConnectionTest(db, 'store_mut_f2', { includeEventCompatibility: true });
    const basicSecond = await mutCt.runGa4ConnectionTest(db, 'store_mut_f2');
    const mutatedSharesCacheReverse = basicSecond.rate_limited === true;
    assert(mutatedSharesCacheReverse, 'F3. mutated source: event → basic direction also shares the cache (basic immediately rate-limited)');

    realCt.resetForTest();
    await realCt.runGa4ConnectionTest(db, 'store_mut_f2', { includeEventCompatibility: true });
    const realBasicSecond = await realCt.runGa4ConnectionTest(db, 'store_mut_f2');
    assert(realBasicSecond.rate_limited !== true, 'F4. real source: event → basic direction stays isolated (basic not rate-limited by event)');

    realCt.resetForTest();
  }

  // ══════════════════════════════════════════════════════════════
  // G. event_compat "false" treated as true (Boolean() coercion regression)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(routeSrc,
      "function _parseGa4EventCompatFlag(raw) {\n  if (raw === true || raw === 1 || raw === '1') return true;\n  if (typeof raw === 'string' && raw.trim().toLowerCase() === 'true') return true;\n  return false;\n}",
      "function _parseGa4EventCompatFlag(raw) {\n  // MUTATION-G: naive JS truthy coercion — a non-empty string like \"false\" becomes true\n  return Boolean(raw);\n}");
    const p = writeAdjacent(ROUTE_PATH, mutated, 'g');
    const mutRoute = require(p);
    const realRoute = require(ROUTE_PATH);

    assert(mutRoute._parseGa4EventCompatFlagForTest('false') === true, 'G. mutated source: "false" (string) is WRONGLY coerced to true by Boolean()');
    assert(realRoute._parseGa4EventCompatFlagForTest('false') === false, 'G2. real source: "false" (string) correctly stays false (explicit whitelist parser)');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Zero event treated as an API error
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(idxSrc,
      "  if (!summaryResult.ok) throw new Ga4RealtimeError(summaryResult.code, summaryResult.retryable, 502, 'summary');",
      "  // MUTATION-H: also throws when the result set is legitimately empty (0 events), not just on a real API failure\n  if (!summaryResult.ok || !summaryResult.rows || summaryResult.rows.length === 0) throw new Ga4RealtimeError(summaryResult.code || 'EMPTY_TREATED_AS_ERROR', summaryResult.retryable, 502, 'summary');");
    const p = writeAdjacent(IDX_PATH, mutated, 'h');
    const mutIdx = require(p);
    const realIdx = require(IDX_PATH);

    const { getDb } = require(path.join(ROOT, 'utils/db.js'));
    const db = getDb();
    function setSetting(storeId, key, value) {
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
      if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
    }
    db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_mut_h', 1]);
    setSetting('store_mut_h', 'ga4_realtime_enabled', '1');
    setSetting('store_mut_h', 'ga4_realtime_property_id', '111111');
    setSetting('store_mut_h', 'ga4_realtime_stream_id', '9001');
    const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));

    mutIdx.resetForTest();
    client._setClientForTest({ async runRealtimeReport(req) { const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name); return [{ rows: [], dimensionHeaders: dn.map((n) => ({ name: n })), metricHeaders: mn.map((n) => ({ name: n })), propertyQuota: {} }]; } });
    let mutThrew = false;
    try { await mutIdx.getGa4RealtimeData({ db, storeId: 'store_mut_h', window: 30, metric: 'purchase', forceRefresh: true }); } catch (e) { mutThrew = true; }
    assert(mutThrew, 'H. mutated source: a legitimate 0-event result now throws (zero misclassified as API error)');

    realIdx.resetForTest();
    client._setClientForTest({ async runRealtimeReport(req) { const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name); return [{ rows: [], dimensionHeaders: dn.map((n) => ({ name: n })), metricHeaders: mn.map((n) => ({ name: n })), propertyQuota: {} }]; } });
    let realThrew = false;
    let realData = null;
    try { realData = await realIdx.getGa4RealtimeData({ db, storeId: 'store_mut_h', window: 30, metric: 'purchase', forceRefresh: true }); } catch (e) { realThrew = true; }
    assert(!realThrew && realData && realData.summary.total_active_users_ga4 === 0, 'H2. real source: 0-event result resolves normally (success, not an error)');
  }

  // ══════════════════════════════════════════════════════════════
  // I. API error treated as zero event (error swallowed)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(idxSrc,
      "  if (!summaryResult.ok) throw new Ga4RealtimeError(summaryResult.code, summaryResult.retryable, 502, 'summary');",
      "  // MUTATION-I: a real Summary failure is silently swallowed and reported\n  // as if it were a legitimate empty (zero-event) success, instead of\n  // throwing.\n  if (!summaryResult.ok) { summaryResult.ok = true; summaryResult.rows = []; summaryResult.metricHeaders = ['activeUsers', 'eventCount']; }");
    const p = writeAdjacent(IDX_PATH, mutated, 'i');
    const mutIdx = require(p);
    const realIdx = require(IDX_PATH);

    const { getDb } = require(path.join(ROOT, 'utils/db.js'));
    const db = getDb();
    function setSetting(storeId, key, value) {
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
      if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
    }
    db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_mut_i', 1]);
    setSetting('store_mut_i', 'ga4_realtime_enabled', '1');
    setSetting('store_mut_i', 'ga4_realtime_property_id', '111111');
    setSetting('store_mut_i', 'ga4_realtime_stream_id', '9001');
    const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));

    mutIdx.resetForTest();
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 400; throw e; } });
    let mutThrew = false;
    let mutData = null;
    try { mutData = await mutIdx.getGa4RealtimeData({ db, storeId: 'store_mut_i', window: 30, metric: 'purchase', forceRefresh: true }); } catch (e) { mutThrew = true; }
    assert(!mutThrew && mutData && mutData.summary.total_active_users_ga4 === 0, 'I. mutated source: a real API 400 error is silently reported as a successful zero-event result');

    realIdx.resetForTest();
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 400; throw e; } });
    let realThrew = false;
    try { await realIdx.getGa4RealtimeData({ db, storeId: 'store_mut_i', window: 30, metric: 'purchase', forceRefresh: true }); } catch (e) { realThrew = true; }
    assert(realThrew, 'I2. real source: a real API 400 error correctly throws (not silently swallowed as zero)');
  }

  // ══════════════════════════════════════════════════════════════
  // J. Taipei date helper reverted to UTC calendar day
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(dtSrc,
      "  const shifted = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day) + Number(offsetDays || 0), 12, 0, 0));\n  const y = shifted.getUTCFullYear();\n  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');\n  const d = String(shifted.getUTCDate()).padStart(2, '0');\n  return `${y}-${m}-${d}`;",
      "  // MUTATION-J: reverted to naive UTC calendar day, ignoring the Asia/Taipei parts computed above\n  const naive = new Date(base.getTime());\n  naive.setUTCDate(naive.getUTCDate() + Number(offsetDays || 0));\n  return naive.toISOString().slice(0, 10);");
    const p = writeTmp(mutated, 'j-dateTime');
    const mutDt = require(p);
    const realDt = require(DT_PATH);

    // Taiwan 00:01 (2026-08-06T16:01:00Z) must be 2026-08-07 in Taipei, but the naive UTC mutation reads the raw UTC date (2026-08-06).
    const mutResult = mutDt.getTaipeiCalendarDateString(new Date('2026-08-06T16:01:00.000Z'), 0);
    assert(mutResult === '2026-08-06', 'J. mutated source: Taiwan 00:01 boundary case now WRONGLY returns the UTC date (2026-08-06, off by one day)', mutResult);

    const realResult = realDt.getTaipeiCalendarDateString(new Date('2026-08-06T16:01:00.000Z'), 0);
    assert(realResult === '2026-08-07', 'J2. real source: Taiwan 00:01 boundary case correctly returns 2026-08-07');
  }

  // ══════════════════════════════════════════════════════════════
  // K. 7d range off-by-one
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(syncSrc,
      "  if (rangeKey === '7d') return { ok: true, start_date: _todayDateString(-6), end_date: _todayDateString(0) };",
      "  if (rangeKey === '7d') return { ok: true, start_date: _todayDateString(-5), end_date: _todayDateString(0) }; // MUTATION-K: off-by-one");
    const p = writeAdjacent(SYNC_PATH, mutated, 'k');
    const mutSvc = require(p);
    const realSvc = require(SYNC_PATH);

    mutSvc._setClockForTest(() => new Date('2026-08-07T04:00:00.000Z'));
    const mutWindow = mutSvc.resolveRangeWindow('7d');
    assert(mutWindow.start_date === '2026-08-02', 'K. mutated source: 7d start_date is off by one (2026-08-02 instead of 2026-08-01)', mutWindow.start_date);
    mutSvc._resetClockForTest();

    realSvc._setClockForTest(() => new Date('2026-08-07T04:00:00.000Z'));
    const realWindow = realSvc.resolveRangeWindow('7d');
    assert(realWindow.start_date === '2026-08-01', 'K2. real source: 7d start_date correctly 2026-08-01');
    realSvc._resetClockForTest();
  }

  // ══════════════════════════════════════════════════════════════
  // L. rows_saved=0 shows a red Error instead of a neutral success message
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(panelSrc,
      "      if (rowsSaved === 0) {\n        showToast('同步成功，目前 GA4 報表尚無可用的區域資料。即時資料與標準報表的處理時間不同，稍後再同步即可。', 'success');\n      } else if (rowsSaved !== null) {",
      "      if (rowsSaved === 0) {\n        showToast('GA4 連線發生錯誤，請稍後再試。', 'error'); // MUTATION-L\n      } else if (rowsSaved !== null) {");
    const p = writeTmp(mutated, 'l-panel');

    function freshPanel(modPath, toastCalls) {
      delete require.cache[modPath];
      const dom = new JSDOM('<div></div>');
      global.window = dom.window;
      global.document = dom.window.document;
      global.showToast = (msg, type) => toastCalls.push({ msg, type });
      return require(modPath);
    }

    const mutToasts = [];
    const mutPanel = freshPanel(p, mutToasts);
    await mutPanel._geoGa4H1HandleSyncResult({ success: true, rows_saved: 0 }, () => Promise.resolve());
    assert(mutToasts.length === 1 && mutToasts[0].type === 'error', 'L. mutated source: rows_saved=0 now shows a red error toast (regression caught)');

    const realToasts = [];
    const realPanel = freshPanel(PANEL_PATH, realToasts);
    await realPanel._geoGa4H1HandleSyncResult({ success: true, rows_saved: 0 }, () => Promise.resolve());
    assert(realToasts.length === 1 && realToasts[0].type === 'success', 'L2. real source: rows_saved=0 still shows a neutral success toast');
  }

  // ══════════════════════════════════════════════════════════════
  // M/N. Per-user metric multiplied by 100 again (regression to the old % bug)
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(panelSrc,
      "  if (!d) return null;\n  return Math.round((n / d) * 10) / 10;",
      "  if (!d) return null;\n  return Math.round((n / d) * 1000) / 10; // MUTATION-M/N: back to the old ×100 percentage formula");
    const p = writeTmp(mutated, 'mn-panel');
    delete require.cache[p];
    global.window = undefined; global.document = undefined;
    const mutPanel = require(p);
    delete require.cache[PANEL_PATH];
    const realPanel = require(PANEL_PATH);

    assert(mutPanel._geoGa4H1PerUser(10, 2) === 500, 'M. mutated source: add_to_cart_per_user(10,2) wrongly returns 500 (×100 regression)');
    assert(mutPanel._geoGa4H1PerUser(8, 2) === 400, 'N. mutated source: purchase_per_user(8,2) wrongly returns 400 (×100 regression)');
    assert(realPanel._geoGa4H1PerUser(10, 2) === 5, 'M2. real source: add_to_cart_per_user(10,2) correctly returns 5');
    assert(realPanel._geoGa4H1PerUser(8, 2) === 4, 'N2. real source: purchase_per_user(8,2) correctly returns 4');
  }

  // ══════════════════════════════════════════════════════════════
  // O/P. Old "加購率"/"購買率" header text reintroduced
  // ══════════════════════════════════════════════════════════════
  {
    const mutatedO = mutateOnce(panelSrc,
      "  { key: 'add_to_cart_per_user', label: '加購事件／人', type: 'number' },",
      "  { key: 'add_to_cart_per_user', label: '加購率', type: 'number' }, // MUTATION-O");
    const mutatedON = mutateOnce(mutatedO,
      "  { key: 'purchase_per_user', label: '購買事件／人', type: 'number' },",
      "  { key: 'purchase_per_user', label: '購買率', type: 'number' }, // MUTATION-N-header (P)");
    const mutatedFull = mutateOnce(mutatedON,
      "<th>交易數</th><th>營收</th><th>加購事件／人</th><th>購買事件／人</th><th>最近同步</th>",
      "<th>交易數</th><th>營收</th><th>加購率</th><th>購買率</th><th>最近同步</th>");
    const p = writeTmp(mutatedFull, 'op-panel');
    delete require.cache[p];
    global.window = undefined; global.document = undefined;
    const mutSrc2 = fs.readFileSync(p, 'utf8');
    assert(mutSrc2.includes('加購率') && mutSrc2.includes('購買率'), 'O/P. mutated source now contains legacy 加購率／購買率 header text');

    const realSrc2 = fs.readFileSync(PANEL_PATH, 'utf8');
    const realSrc2Code = stripComments(realSrc2);
    assert(!realSrc2Code.includes('加購率') && !realSrc2Code.includes('購買率'), 'O2/P2. real source (excluding comments) contains no 加購率／購買率 anywhere in actual code');
  }

  // ══════════════════════════════════════════════════════════════
  // Q. Legacy _geoGa4H1Rate re-wired back into the production render path
  // ══════════════════════════════════════════════════════════════
  {
    const mutated = mutateOnce(panelSrc,
      "  const addToCartPerUser = _geoGa4H1PerUser(r.add_to_cart_count, activeUsers);",
      "  const addToCartPerUser = _geoGa4H1Rate(r.add_to_cart_count, activeUsers); // MUTATION-Q: legacy alias reintroduced into render path");
    const p = writeTmp(mutated, 'q-panel');
    const mutSrc2 = fs.readFileSync(p, 'utf8');
    // Static-audit-style check: production row-render function body should only call _geoGa4H1PerUser, never _geoGa4H1Rate.
    const mutRowFnBody = mutSrc2.slice(mutSrc2.indexOf('function _geoGa4H1BuildRowHtml'), mutSrc2.indexOf('function _geoGa4H1BuildRowHtml') + 700);
    assert(/_geoGa4H1Rate\(/.test(mutRowFnBody), 'Q. mutated source: _geoGa4H1BuildRowHtml() now calls the legacy _geoGa4H1Rate() directly (render-path regression)');

    const realSrc2 = fs.readFileSync(PANEL_PATH, 'utf8');
    const realRowFnBody = realSrc2.slice(realSrc2.indexOf('function _geoGa4H1BuildRowHtml'), realSrc2.indexOf('function _geoGa4H1BuildRowHtml') + 700);
    assert(!/_geoGa4H1Rate\(/.test(realRowFnBody), 'Q2. real source: _geoGa4H1BuildRowHtml() never calls _geoGa4H1Rate() (only _geoGa4H1PerUser)');
  }

  // ══════════════════════════════════════════════════════════════
  // R. Raw Google error message leaked via the error classifier
  //
  // 注意：一開始嘗試直接在 routes/geo-live.js 的 catch 區塊把 e.message
  // 接進 JSON response，結果證明「不會」洩漏——因為 Ga4RealtimeError 的
  // constructor 是 `super(code)`，此時 code 已經是
  // utils/ga4Realtime/errors.js classifyGa4RealtimeError() 分類過的安全
  // 代碼字串，raw Google error 在更早的 client.js／errors.js 這一層就已經
  // 被丟棄，不會留到 route 層——這是額外一層防護縱深的證據，值得記在
  // Reality Audit 裡。所以這裡改成直接對 classifyGa4RealtimeError() 本身
  // 做 Mutation，並讓 client.js 改用被 Mutate 過的 errors.js，才能真正
  // 示範「如果安全分類被破壞，raw 內容確實會一路洩漏到 client.js 回傳值
  // (code 欄位)，進而流向 route 的 JSON Response」。
  // ══════════════════════════════════════════════════════════════
  {
    const mutatedErrors = mutateOnce(errSrc,
      "  return 'GA4_API_ERROR';",
      "  return String(err.message || err); // MUTATION-R: raw error message leaked as the classified code");
    const mutErrPath = writeAdjacent(ERR_PATH, mutatedErrors, 'r-errors');

    const CLIENT_PATH = path.join(ROOT, 'utils/ga4Realtime/client.js');
    const clientSrc = fs.readFileSync(CLIENT_PATH, 'utf8');
    const mutatedClient = mutateOnce(clientSrc, "require('./errors')", `require(${JSON.stringify(mutErrPath)})`);
    const mutClientPath = writeAdjacent(CLIENT_PATH, mutatedClient, 'r-client');

    const mutClient = require(mutClientPath);
    const realClient = require(CLIENT_PATH);

    mutClient._setClientForTest({ async runRealtimeReport() { throw new Error('SECRET_RAW_GOOGLE_TEXT_a1b2c3'); } });
    const mutResult = await mutClient.runGa4RealtimeReport({ property: 'properties/1', dimensions: [], metrics: [], minuteRanges: [] }, {});
    assert(!mutResult.ok && String(mutResult.code).includes('SECRET_RAW_GOOGLE_TEXT_a1b2c3'), 'R. mutated classifier: raw Google error message leaks into client.js\'s returned `code` field');

    realClient._setClientForTest({ async runRealtimeReport() { throw new Error('SECRET_RAW_GOOGLE_TEXT_a1b2c3'); } });
    const realResult = await realClient.runGa4RealtimeReport({ property: 'properties/1', dimensions: [], metrics: [], minuteRanges: [] }, {});
    assert(!realResult.ok && !String(realResult.code).includes('SECRET_RAW_GOOGLE_TEXT_a1b2c3') && !JSON.stringify(realResult).includes('SECRET_RAW_GOOGLE_TEXT_a1b2c3'), 'R2. real classifier: raw Google error message never appears anywhere in client.js\'s returned result');
  }

  cleanupTempFiles();
  try {
    const dbFile = path.join(ROOT, 'data', 'pos.db');
    if (fs.existsSync(dbFile)) fs.unlinkSync(dbFile);
  } catch (e) { /* best effort */ }
  console.log(`[RESIDUE] unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}, temp files remaining: ${tempFiles.length}`);
  printSummary();
}

main().catch((e) => {
  console.error(e);
  cleanupTempFiles();
  process.exitCode = 1;
});
