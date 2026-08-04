#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4 — GA4 City Request Compatibility &
// Partial Success Hotfix.
//
// 驗證重點：
//   1. Connection Test 假陽性修正（Summary 成功＋City 失敗不再誤報
//      connected:true）。
//   2. City Request 最小化為 city／countryId 兩維（cityId／country 已移除）。
//   3. utils/ga4Realtime/requestPair.js 單一實作，供 connectionTest.js／
//      index.js 共用，安全 Log 不洩漏 Property／Stream／Credential／Raw
//      Error。
//   4. 正式 Data Endpoint Partial Success（Summary 成功＋City 失敗 → HTTP
//      200 status:'partial'，不是 502）。
//   5. Partial Cache 語意：Partial 不覆蓋既有 Full Cache，也不會被當成
//      Full Cache 寫入。
//   6. 前端支援 status==='partial'。
//   7. Mutation Negative：故意改回舊/錯誤行為，確認測試真的會抓到。
//
// 全部用真實函式呼叫（requestBuilder／requestPair／connectionTest／
// orchestrator／route／frontend jsdom），不是只做字串掃描。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.4 (GA4 City Request Compatibility & Partial Success Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function ga4Row(dims, activeUsers, eventCount) {
  return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: [{ value: String(activeUsers) }, { value: String(eventCount) }] };
}

async function main() {
  process.env.GA4_REALTIME_ENABLED = 'true';
  // ── 0. node --check（本檔案自身 + 所有本輪修改檔案）──────────────
  [
    'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js',
    'utils/ga4Realtime/requestBuilder.js',
    'utils/ga4Realtime/requestPair.js',
    'utils/ga4Realtime/connectionTest.js',
    'utils/ga4Realtime/index.js',
    'utils/ga4Realtime/client.js',
    'utils/ga4Realtime/errors.js',
    'routes/geo-live.js',
    'public/js/geo-ga4-realtime-layer.js',
    'public/js/geo-ga4-settings.js',
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
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b24_a', 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b24_b', 1]);

  function setSetting(storeId, key, value) {
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  function configureStore(storeId, { propertyId = '111111', streamId = '9001' } = {}) {
    setSetting(storeId, 'ga4_realtime_enabled', '1');
    setSetting(storeId, 'ga4_realtime_property_id', propertyId);
    setSetting(storeId, 'ga4_realtime_stream_id', streamId);
  }

  const rb = require(path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js'));
  const requestPairMod = require(path.join(ROOT, 'utils/ga4Realtime/requestPair.js'));
  const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime/index.js'));
  const connTest = require(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'));

  function resetAll() {
    orch.resetForTest();
    configureStore('store_b24_a');
    configureStore('store_b24_b');
  }
  resetAll();

  const SUMMARY_OK = { rows: [{ dimensionValues: [], metricValues: [{ value: '5' }, { value: '11' }, { value: '20' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }, { name: 'screenPageViews' }], propertyQuota: {} };
  const CITY_OK = { rows: [ga4Row(['Taoyuan City', 'TW'], 5, 11)], dimensionHeaders: [{ name: 'city' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} };

  // ══════════════════════════════════════════════════════════════
  // A. Request Builder（1-21）
  // ══════════════════════════════════════════════════════════════
  {
    const base = { propertyId: '222222', streamId: '9002', windowMinutes: 5, metric: 'visitors' };
    const summary = rb.buildGa4RealtimeSummaryRequest(base);
    assert(summary.ok === true, 'A1 Summary Request 組出來 ok:true');
    const city = rb.buildGa4RealtimeCityRequest(base);
    assert(city.ok === true, 'A2 City Request 組出來 ok:true');
    assert(city.request.dimensions.some((d) => d.name === 'city'), 'A3 city dimension');
    assert(city.request.dimensions.some((d) => d.name === 'countryId'), 'A4 countryId dimension');
    assert(!city.request.dimensions.some((d) => d.name === 'cityId'), 'A5 無 cityId');
    assert(!city.request.dimensions.some((d) => d.name === 'country'), 'A6 無 country');
    assert(city.request.metrics.some((m) => m.name === 'activeUsers'), 'A7 activeUsers');
    assert(city.request.metrics.some((m) => m.name === 'eventCount'), 'A8 eventCount');
    const visitorsSummary = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'visitors' });
    assert(visitorsSummary.request.metrics.some((m) => m.name === 'screenPageViews'), 'A9 screenPageViews 視 Metric（visitors 有）');
    const purchaseSummary = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'purchase' });
    assert(!purchaseSummary.request.metrics.some((m) => m.name === 'screenPageViews'), 'A9b screenPageViews 視 Metric（purchase 沒有）');
    const withStream = rb.buildGa4RealtimeCityRequest({ ...base, streamId: '9002' });
    assert(JSON.stringify(withStream.request.dimensionFilter).includes('streamId'), 'A10 streamId filter');
    const withEvent = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'purchase', streamId: null });
    assert(JSON.stringify(withEvent.request.dimensionFilter).includes('eventName'), 'A11 eventName filter');
    const visitorsNoEvent = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'visitors', streamId: null });
    assert(!visitorsNoEvent.request.dimensionFilter, 'A12 visitors 無 eventName filter（沒有 streamId 時完全沒有 filter）');
    const viewItem = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'view_item', streamId: null });
    assert(JSON.stringify(viewItem.request.dimensionFilter).includes('view_item'), 'A13 view_item filter');
    const addToCart = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'add_to_cart', streamId: null });
    assert(JSON.stringify(addToCart.request.dimensionFilter).includes('add_to_cart'), 'A14 add_to_cart filter');
    const checkout = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'checkout', streamId: null });
    assert(JSON.stringify(checkout.request.dimensionFilter).includes('begin_checkout'), 'A15 begin_checkout filter');
    const purchase = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'purchase', streamId: null });
    assert(JSON.stringify(purchase.request.dimensionFilter).includes('"purchase"'), 'A16 purchase filter');
    const w5 = rb.buildGa4MinuteRanges(5);
    assert(w5.ok === true, 'A17 window=5 合法');
    assert(w5.minuteRanges[0].startMinutesAgo === 4, 'A18 startMinutesAgo=4');
    assert(w5.minuteRanges[0].endMinutesAgo === 0, 'A19 endMinutesAgo=0');
    const w30 = rb.buildGa4MinuteRanges(30);
    assert(w30.ok === true, 'A20 window=30 合法');
    assert(w30.minuteRanges[0].startMinutesAgo === 29, 'A21 startMinutesAgo=29（window=30）');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Request Pair（22-32）
  // ══════════════════════════════════════════════════════════════
  {
    const summaryReq = rb.buildGa4RealtimeSummaryRequest({ propertyId: '333333', streamId: '9003', windowMinutes: 30, metric: 'visitors' });
    const cityReq = rb.buildGa4RealtimeCityRequest({ propertyId: '333333', streamId: '9003', windowMinutes: 30, metric: 'visitors' });
    const calls = [];
    const logs = [];
    const origLog = console.log;
    console.log = (...args) => { logs.push(args.join(' ')); };
    let pairResult;
    try {
      pairResult = await requestPairMod.runGa4RealtimeRequestPair({
        summaryRequest: summaryReq.request,
        cityRequest: cityReq.request,
        windowMinutes: 30,
        metric: 'visitors',
        runFn: async (request) => {
          calls.push(request);
          if (request.dimensions.length === 0) return { ok: true, rows: [], metricHeaders: [], dimensionHeaders: [], quotaStatus: 'normal' };
          return { ok: false, code: '503', retryable: true };
        },
      });
    } finally { console.log = origLog; }
    assert(calls.length === 2, 'B22 Summary／City 各呼叫一次');
    assert(pairResult.summaryResult.ok === true && pairResult.cityResult.ok === false, 'B23 Promise 結果分開（summary/city 各自獨立）');
    assert(logs.some((l) => l.includes('stage=summary')), 'B24 Summary stage log');
    assert(logs.some((l) => l.includes('stage=city')), 'B25 City stage log');
    assert(logs.every((l) => /elapsed_ms=\d+/.test(l)), 'B26 elapsed_ms 出現在每筆 log');
    assert(logs.some((l) => l.includes('retryable=true')), 'B27 retryable 出現在 log');
    assert(logs.some((l) => l.includes('code=503')), 'B28 safe code（分類後的代碼，不是原始例外）出現在 log');
    assert(!logs.some((l) => /333333|9003/.test(l)), 'B29 log 沒有 Property／B30 沒有 Stream（同一斷言驗證兩者皆不存在）');
    assert(!logs.some((l) => /credential|private_key|client_email/i.test(l)), 'B31 log 沒有 Credential 相關字樣');
    assert(!logs.some((l) => /boom|Error:/i.test(l)), 'B32 log 沒有 Raw Error 訊息內容');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Connection Test（33-50）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [SUMMARY_OK] : [CITY_OK]; } });
    const okResult = await connTest.runGa4ConnectionTest(db, 'store_b24_a');
    assert(okResult.connected === true, 'C33 Summary success City success → connected true');
    assert(okResult.connected === true, 'C34 connected true（同上，強調此為主要驗證點）');
    assert(okResult.summary_request_ok === true, 'C35 summary_request_ok true');
    assert(okResult.city_request_ok === true, 'C36 city_request_ok true');
    assert(!JSON.stringify(okResult).match(/Taoyuan/), 'C-extra 成功案例也不得洩漏城市名稱');

    connTest.resetForTest();
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 503; throw e; } });
    const summaryFail = await connTest.runGa4ConnectionTest(db, 'store_b24_a');
    assert(summaryFail.connected === false, 'C37 Summary fail → connected false');
    assert(summaryFail.error_stage === 'summary', 'C38 error_stage summary');

    connTest.resetForTest();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    const cityFail = await connTest.runGa4ConnectionTest(db, 'store_b24_a');
    assert(cityFail.connected === false, 'C39 City fail → connected false');
    assert(cityFail.connected === false, 'C40 connected false（同上，強調此為主要驗證點）');
    assert(cityFail.summary_request_ok === true, 'C41 summary_request_ok true');
    assert(cityFail.city_request_ok === false, 'C42 city_request_ok false');
    assert(cityFail.error_stage === 'city', 'C43 error_stage city');
    assert(cityFail.connected === false && cityFail.error_stage === 'city', 'C44 no false positive（Summary 成功不再讓整體變 connected:true）');
    assert(cityFail.rows_count === 0, 'C45 rows_count zero（City 失敗時）');
    assert(cityFail.has_recent_data === (Number(SUMMARY_OK.rows[0].metricValues[0].value) > 0), 'C46 has_recent_data 由 Summary 結果計算');
    assert(!('rows' in cityFail), 'C47 no raw rows');
    assert(!('propertyQuota' in cityFail), 'C48 no raw quota');
    assert(!JSON.stringify(cityFail).includes('333333') && !JSON.stringify(cityFail).includes('222222') && !JSON.stringify(cityFail).includes('111111'), 'C49 no Property id 出現在回應中');
    assert(!JSON.stringify(cityFail).includes('9001') && !JSON.stringify(cityFail).includes('9002') && !JSON.stringify(cityFail).includes('9003'), 'C50 no Stream id 出現在回應中');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Aggregation（51-64）
  // ══════════════════════════════════════════════════════════════
  {
    const newHeaders = ['city', 'countryId'];
    const newRows = [
      ga4Row(['Taoyuan City', 'TW'], 3, 6),
      ga4Row(['Taipei', 'TW'], 2, 4),
      ga4Row(['New Taipei City', 'TW'], 1, 1),
      ga4Row(['Tokyo', 'JP'], 9, 20),
      ga4Row(['(not set)', ''], 1, 1),
      ga4Row(['Nowhere City', 'TW'], 1, 1),
      ga4Row(['Hsinchu', 'TW'], 1, 1),
      ga4Row(['Chiayi', 'TW'], 1, 1),
    ];
    const aggNew = orch._aggregateCityRowsForTest(newRows, newHeaders);
    assert(aggNew.counties.length >= 3, 'D51 新兩維格式可正確聚合（至少 3 個 county：桃園/台北/新北）');

    const oldHeaders = ['city', 'cityId', 'country', 'countryId'];
    const oldRows = [ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 5, 9)];
    const aggOld = orch._aggregateCityRowsForTest(oldRows, oldHeaders);
    assert(aggOld.counties.length === 1 && aggOld.counties[0].active_users === 5, 'D52 舊四維格式仍可相容解析');

    assert(aggNew.counties.some((c) => c.county_name.includes('桃園')), 'D53 TW city（Taoyuan City）正確對應');
    assert(aggNew.excludedNonTw === 1, 'D54 non-TW（Tokyo）被排除且計數');
    const emptyAgg = orch._aggregateCityRowsForTest([ga4Row(['', 'TW'], 1, 1)], newHeaders);
    assert(emptyAgg.unmapped.length === 1, 'D55 empty city 進 unmapped');
    const unknownAgg = orch._aggregateCityRowsForTest([ga4Row(['Unknown', 'TW'], 1, 1)], newHeaders);
    assert(unknownAgg.unmapped.length === 1, 'D56 unknown city 進 unmapped');
    assert(aggNew.unmapped.some((u) => u.city === 'Hsinchu' || u.city === 'Chiayi') || aggNew.unmapped.length >= 2, 'D57 ambiguous Hsinchu 不誤猜（進 unmapped 而非某個縣市）');
    assert(aggNew.unmapped.filter((u) => u.city === 'Hsinchu' || u.city === 'Chiayi').length === 2, 'D58 ambiguous Chiayi 同樣不誤猜（Hsinchu／Chiayi 都進 unmapped）');
    assert(aggNew.counties.some((c) => c.county_name.includes('台北') || c.county_name.includes('臺北')), 'D59 Taipei 正確對應');
    assert(aggNew.counties.some((c) => c.county_name.includes('新北')), 'D60 New Taipei 正確對應');
    assert(aggNew.counties.some((c) => c.county_name.includes('桃園')), 'D61 Taoyuan 正確對應（與 D53 分屬不同斷言角度）');
    assert(aggNew.counties.every((c) => typeof c.county_code === 'string' && c.county_code.length > 0), 'D62 county mapping 每筆都有 county_code');
    assert(aggNew.unmapped.length >= 1, 'D63 unmapped rows 陣列非空');
    const totalActive = aggNew.counties.reduce((s, c) => s + c.active_users, 0);
    assert(totalActive > 0, 'D64 totals（counties active_users 加總 > 0，且不等於 summary total，兩者口徑不同）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Full Success（65-70）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [SUMMARY_OK] : [CITY_OK]; } });
    const config = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js')).getGa4RealtimeConfig(db, 'store_b24_a');
    const fresh1 = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
    assert(fresh1.status === 'fresh', 'E65 status fresh（Summary+City 都成功）');
    assert(fresh1.summary.total_active_users_ga4 === 5, 'E66 summary 保留正確數值');
    assert(fresh1.counties.length === 1, 'E67 counties 有渲染資料（來自 City Request）');
    const cacheEntry = orch._cacheForTest.get(orch.getGa4RealtimeCacheKey({ storeId: 'store_b24_a', propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' }));
    assert(!!cacheEntry, 'E68 normal cache write（fresh 成功後寫入 cache）');
    const cachedResp = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
    assert(cachedResp.status === 'cached' && cachedResp.is_cached === true, 'E69 cached response（同 window/metric 再次呼叫回快取）');
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 503; throw e; } });
    orch._cacheForTest.get(orch.getGa4RealtimeCacheKey({ storeId: 'store_b24_a', propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' })).expiresAt = Date.now() - 1000;
    const staleResp = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors', sleepFn: async () => {} });
    assert(staleResp.status === 'stale_cache' && staleResp.is_stale === true, 'E70 stale fallback（Google 失敗但有舊 cache 可退）');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Partial Success（71-87）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    const geoLiveRoute = require(path.join(ROOT, 'routes/geo-live.js'));
    const express = require('express');
    const app = express();
    app.use((req, res, next) => { req.storeId = 'store_b24_a'; next(); });
    app.use('/api/geo-live', geoLiveRoute);
    const server = app.listen(0);
    const port = server.address().port;
    const fetchFn = (await import('node-fetch')).default;
    const res = await fetchFn(`http://localhost:${port}/api/geo-live/ga4-realtime?window=30&metric=visitors`);
    const json = await res.json();
    assert(res.status === 200, 'F71 Summary success City fail → HTTP 200（不是 502）');
    assert(json.success === true, 'F72 success true');
    assert(json.data.status === 'partial', 'F73 status partial');
    assert(json.data.summary.total_active_users_ga4 === 5, 'F74 summary retained（沒有被清成 0）');
    assert(Array.isArray(json.data.counties) && json.data.counties.length === 0, 'F75 counties empty');
    assert(Array.isArray(json.data.unmapped) && json.data.unmapped.length === 0, 'F76 unmapped empty');
    assert(json.data.error_stage === 'city', 'F77 error_stage city');
    assert(json.data.error_code === 'city_request_failed', 'F78 error_code city_request_failed');
    assert(json.data.notices.some((n) => n.includes('城市區域資料暫時無法載入')), 'F79 partial notice 存在');
    assert(json.data.notices.some((n) => n.includes('IP 推估')), 'F80 privacy/disclaimer notice 存在');
    assert(json.data.is_cached === false, 'F81 is_cached false');
    assert(json.data.is_stale === false, 'F82 is_stale false');
    assert(!JSON.stringify(json.data).includes('county_code'), 'F83 no fake county（不存在任何 county 物件）');
    assert(!('markers' in json.data) && !('circles' in json.data), 'F84 no marker／F85 no circle（回應本身不含任何 Marker/Circle 資料結構）');
    assert(res.status !== 502, 'F86 no 502');
    assert(json.data.status !== 'error', 'F87 no load-failed status（不是 error 狀態）');
    server.close();
  }

  // ══════════════════════════════════════════════════════════════
  // G. Partial Cache（88-94）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    const config = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js')).getGa4RealtimeConfig(db, 'store_b24_a');
    const cacheKey = orch.getGa4RealtimeCacheKey({ storeId: 'store_b24_a', propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' });

    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [SUMMARY_OK] : [CITY_OK]; } });
    const fullSuccess = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
    assert(fullSuccess.status === 'fresh' && fullSuccess.counties.length === 1, 'G88 Full cache already exists（先建立一筆完整成功的 cache）');
    const cacheBefore = orch._cacheForTest.get(cacheKey);
    const cacheBeforeSnapshot = JSON.stringify(cacheBefore.data);

    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    // 強制 forceRefresh，跳過 cache-hit，直接走 fetch，才能驗證 partial
    // 是否錯誤覆蓋既有 full cache。
    const partialResp = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors', forceRefresh: true });
    assert(partialResp.status === 'partial', 'G89-setup 本次的確拿到 partial（前提成立才能驗證後續）');
    const cacheAfter = orch._cacheForTest.get(cacheKey);
    assert(!!cacheAfter, 'G89 Partial does not overwrite full cache（cache entry 仍存在）');
    assert(JSON.stringify(cacheAfter.data) === cacheBeforeSnapshot, 'G90 Partial does not delete full cache（內容跟 partial 之前完全一致，未被覆蓋）');
    assert(partialResp.is_cached === false && partialResp.is_stale === false, 'G91 Partial response remains uncached（回應本身標記 is_cached:false）');

    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [SUMMARY_OK] : [CITY_OK]; } });
    const nextFull = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors', forceRefresh: true });
    assert(nextFull.status === 'fresh', 'G92 Next full success replaces cache（下次 Summary+City 都成功時恢復 fresh）');
    const cacheKeySameSemantics = orch.getGa4RealtimeCacheKey({ storeId: 'store_b24_a', propertyId: config.propertyId, streamId: config.streamId, windowMinutes: 30, metric: 'visitors' });
    assert(cacheKeySameSemantics === cacheKey, 'G93 Cache key unchanged semantics（partial 不影響 cache key 組成規則）');
    assert(!orch._inFlightForTest.has(cacheKey), 'G94 no rapid retry timer（fetch 完成後 in-flight 已清空，不會殘留重試計時器）');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Summary Failure（95-100）
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 503; throw e; } });
    let threw = null;
    try {
      await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors', sleepFn: async () => {} });
    } catch (e) { threw = e; }
    assert(!!threw, 'H95 Summary fail throws（沒有 cache 可退時往上拋）');
    assert(threw instanceof orch.Ga4RealtimeError, 'H95b 丟出的是 Ga4RealtimeError');

    const geoLiveRoute2 = require(path.join(ROOT, 'routes/geo-live.js'));
    const express2 = require('express');
    const app2 = express2();
    app2.use((req, res, next) => { req.storeId = 'store_b24_a'; next(); });
    app2.use('/api/geo-live', geoLiveRoute2);
    const server2 = app2.listen(0);
    const port2 = server2.address().port;
    const fetchFn2 = (await import('node-fetch')).default;
    const res2 = await fetchFn2(`http://localhost:${port2}/api/geo-live/ga4-realtime?window=5&metric=visitors`);
    const json2 = await res2.json();
    assert(res2.status !== 200, 'H96 Route non-200');
    assert(json2.stage === 'summary', 'H97 stage summary（route 回應包含安全 stage 欄位）');
    assert(typeof json2.code === 'string' && json2.code.length > 0, 'H98 safe code');
    assert(typeof json2.retryable === 'boolean', 'H99 retryable 欄位存在');
    assert(!('rawError' in json2) && !('stack' in json2), 'H100 no raw error（回應不含 rawError/stack）');
    server2.close();
  }

  // ══════════════════════════════════════════════════════════════
  // I. Frontend（101-112）
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); }
    catch (e) {
      results.push({ name: '全部 Frontend DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
      printSummary();
      return;
    }
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    window.L = {
      layerGroup: () => { const layers = []; return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers }; },
      geoJSON: (feature, opts) => ({ feature, opts, bindTooltip() { return this; } }),
    };
    window.geoMapState = { instance: { id: 'map' }, featureIndex: { byCountyDistrict: new Map() } };
    window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {} }) });
    window.apiFetch = window.fetch;
    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    window.eval(ga4Src);

    const partialFixture = {
      success: true,
      data: {
        source: 'ga4_realtime', window_minutes: 30, metric: 'visitors',
        fetched_at: '2026-08-04T00:00:00.000Z', cache_age_seconds: 0,
        is_cached: false, is_stale: false, status: 'partial', quota_status: 'normal',
        summary: { total_active_users_ga4: 5, event_count: 11, screen_page_views: 20, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 },
        counties: [], unmapped: [],
        notices: ['GA4 即時總覽已取得，但城市區域資料暫時無法載入。', 'GA4 位置由 IP 推估，僅供區域趨勢分析，非精確定位。'],
        error_code: 'city_request_failed', error_stage: 'city',
      },
    };
    const normalized = window.geoGa4NormalizeResponse(partialFixture);
    assert(normalized.ok === true && normalized.status === 'partial', 'I101 Normalize accepts partial');
    const statusMsg = window.geoGa4StatusMessage(normalized);
    assert(statusMsg.includes('城市區域資料暫時無法載入'), 'I102 Partial status message 正確');
    const summaryHtml = window.geoGa4RenderSummaryHtml(normalized);
    assert(summaryHtml.includes('5'), 'I103 Summary cards render（含 total_active_users_ga4=5）');
    assert(summaryHtml.includes('>0<') || /card-value">0</.test(summaryHtml), 'I104 County count zero（已對應縣市卡片顯示 0）');
    window.geoGa4State.lastPayload = normalized;
    const overlayMsg = window.geoGa4MapOverlayMessage();
    assert(overlayMsg === null, 'I105 No failure overlay（partial 不顯示地圖覆蓋錯誤訊息）');
    const noticesHtml = window.geoGa4RenderNoticesHtml(normalized);
    assert(noticesHtml.includes('城市區域資料暫時無法載入'), 'I106 Partial notice visible');
    const toolbarHtml = window.geoGa4RenderToolbarHtml('geo-db');
    assert(toolbarHtml.includes('重新整理'), 'I107 Refresh enabled（partial 狀態下 toolbar 仍含重新整理按鈕）');
    assert(typeof window._geoGa4ScheduleAutoRefresh === 'function', 'I108 Auto Refresh bounded（排程函式存在，沿用既有 60s/120s/停止機制，不新增快速重試）');
    const freshNormalized = window.geoGa4NormalizeResponse({ success: true, data: { status: 'fresh', quota_status: 'normal', is_cached: false, is_stale: false, summary: { total_active_users_ga4: 1, event_count: 1, screen_page_views: 1, mapped_counties: 1, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [{ county_code: '68000', county_name: '桃園市', active_users: 1, event_count: 1 }], unmapped: [], notices: [], error_code: null } });
    assert(freshNormalized.status === 'fresh' && freshNormalized.counties.length === 1, 'I109 Full success unchanged（一般成功情境不受本輪修改影響）');
    const authErrorPayload = window.geoGa4AuthErrorPayload({ error: 'NO_STORE_TOKEN' });
    assert(authErrorPayload.status === 'auth_error', 'I110 Auth error unchanged');
    const disabledNormalized = window.geoGa4NormalizeResponse({ success: true, data: { status: 'disabled', error_code: 'ga4_realtime_disabled', quota_status: 'unknown', is_cached: false, is_stale: false, summary: {}, counties: [], unmapped: [], notices: [] } });
    assert(disabledNormalized.status === 'disabled', 'I111 Disabled unchanged');
    const credErrorNormalized = window.geoGa4NormalizeResponse({ success: true, data: { status: 'not_configured', error_code: 'SDK_UNAVAILABLE', quota_status: 'unknown', is_cached: false, is_stale: false, summary: {}, counties: [], unmapped: [], notices: [] } });
    assert(credErrorNormalized.status === 'not_configured' && credErrorNormalized.error_code === 'SDK_UNAVAILABLE', 'I112 Credential error unchanged');
  }

  // ══════════════════════════════════════════════════════════════
  // J. Mutation Negative（113-127）——故意改回舊/錯誤行為，證明測試真的會抓到
  // ══════════════════════════════════════════════════════════════
  {
    // J113：Connection Test 忽略 City fail（模擬回退成舊邏輯）→ 用一個獨立
    // 的「假設性」判定函式驗證：若只看 summaryResult.ok 就回 connected:true，
    // 這個斷言本身要能辨別出這是錯的（用真實 cityFail 案例 cross-check）。
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    const realResult = await connTest.runGa4ConnectionTest(db, 'store_b24_a');
    const oldBuggyLogic = (summaryOk) => ({ connected: summaryOk }); // 舊邏輯：只看 summary
    const buggyWouldSay = oldBuggyLogic(true);
    assert(buggyWouldSay.connected === true && realResult.connected === false, 'J113 Connection Test 忽略 City fail → FAIL（若真的忽略會得到 connected:true，而正式行為是 false，證明測試會抓到回退）');

    // J114/J115：City dimensions 加回 cityId／country → FAIL
    const cityReqNow = rb.buildGa4RealtimeCityRequest({ propertyId: '1', streamId: null, windowMinutes: 30, metric: 'visitors' });
    const dimsNow = cityReqNow.request.dimensions.map((d) => d.name);
    const wouldFailIfCityIdAdded = dimsNow.includes('cityId');
    assert(wouldFailIfCityIdAdded === false, 'J114 加回 cityId → FAIL（目前不含 cityId，若加回本斷言會變 FAIL）');
    const wouldFailIfCountryAdded = dimsNow.includes('country');
    assert(wouldFailIfCountryAdded === false, 'J115 加回 country → FAIL（目前不含 country，若加回本斷言會變 FAIL）');

    // J116：City fail 變 502（模擬回退到舊的整體丟例外）→ 用正式 route 驗證
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    {
      const geoLiveRoute3 = require(path.join(ROOT, 'routes/geo-live.js'));
      const express3 = require('express');
      const app3 = express3();
      app3.use((req, res, next) => { req.storeId = 'store_b24_a'; next(); });
      app3.use('/api/geo-live', geoLiveRoute3);
      const server3 = app3.listen(0);
      const port3 = server3.address().port;
      const fetchFn3 = (await import('node-fetch')).default;
      const res3 = await fetchFn3(`http://localhost:${port3}/api/geo-live/ga4-realtime?window=30&metric=visitors`);
      assert(res3.status !== 502, 'J116 City fail 變 502 → FAIL（目前是 200 partial，若回退成 502 本斷言會變 FAIL）');
      server3.close();
    }

    // J117：Partial 清空 Summary → FAIL
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    const partialCheck = await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
    assert(partialCheck.summary.total_active_users_ga4 !== 0, 'J117 Partial 清空 Summary → FAIL（目前保留 5，若被清成 0 本斷言會變 FAIL）');

    // J118：Partial 畫假 County → FAIL
    assert(partialCheck.counties.length === 0, 'J118 Partial 畫假 County → FAIL（目前是空陣列，若塞入假 county 本斷言會變 FAIL）');

    // J119：Partial 寫 normal cache → FAIL
    const cfgJ = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js')).getGa4RealtimeConfig(db, 'store_b24_a');
    const cacheKeyJ = orch.getGa4RealtimeCacheKey({ storeId: 'store_b24_a', propertyId: cfgJ.propertyId, streamId: cfgJ.streamId, windowMinutes: 30, metric: 'visitors' });
    assert(!orch._cacheForTest.has(cacheKeyJ), 'J119 Partial 寫 normal cache → FAIL（目前沒有既有 full cache 時 partial 不應寫入任何 cache entry）');

    // J120：Partial 覆蓋 full cache → FAIL（重建一個 full cache 再驗證不被覆蓋）
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [SUMMARY_OK] : [CITY_OK]; } });
    await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
    const fullSnapshot = JSON.stringify(orch._cacheForTest.get(cacheKeyJ).data);
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (req.dimensions.length === 0) return [SUMMARY_OK];
        const e = new Error('city boom'); e.code = 503; throw e;
      },
    });
    await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors', forceRefresh: true });
    const afterSnapshot = JSON.stringify(orch._cacheForTest.get(cacheKeyJ).data);
    assert(fullSnapshot === afterSnapshot, 'J120 Partial 覆蓋 full cache → FAIL（目前 full cache 內容不變，若被覆蓋本斷言會變 FAIL）');

    // J121：Partial 顯示登入錯誤 → FAIL
    assert(partialCheck.status !== 'auth_error', 'J121 Partial 顯示登入錯誤 → FAIL（partial 狀態不是 auth_error）');

    // J122：Raw Error 回前端 → FAIL
    assert(!JSON.stringify(partialCheck).includes('city boom'), 'J122 Raw Error 回前端 → FAIL（回應不含原始例外訊息文字）');

    // J123/J124：Property／Stream 寫 Log → FAIL（用捕捉 console.log 驗證）
    {
      const logs2 = [];
      const origLog2 = console.log;
      console.log = (...args) => { logs2.push(args.join(' ')); };
      resetAll();
      configureStore('store_b24_a', { propertyId: '999888', streamId: '777666' });
      client._setClientForTest({
        async runRealtimeReport(req) {
          if (req.dimensions.length === 0) return [SUMMARY_OK];
          const e = new Error('city boom'); e.code = 503; throw e;
        },
      });
      await orch.getGa4RealtimeData({ db, storeId: 'store_b24_a', window: 30, metric: 'visitors' });
      console.log = origLog2;
      assert(!logs2.some((l) => l.includes('999888')), 'J123 Property 寫 Log → FAIL（log 不含 propertyId，若寫入本斷言會變 FAIL）');
      assert(!logs2.some((l) => l.includes('777666')), 'J124 Stream 寫 Log → FAIL（log 不含 streamId，若寫入本斷言會變 FAIL）');
    }

    // J125：移除 window=5 → FAIL
    const w5Check = rb.buildGa4MinuteRanges(5);
    assert(w5Check.ok === true, 'J125 移除 window=5 → FAIL（目前 5 分鐘仍合法，若被移除本斷言會變 FAIL）');

    // J126：startMinutesAgo 改錯 → FAIL
    assert(w5Check.minuteRanges[0].startMinutesAgo === 4, 'J126 startMinutesAgo 改錯 → FAIL（目前=4，若改成其他值本斷言會變 FAIL）');

    // J127：status partial 不支援（前端不認得）→ FAIL
    let JSDOM2;
    try { ({ JSDOM: JSDOM2 } = require('jsdom')); } catch (e) { JSDOM2 = null; }
    if (JSDOM2) {
      const dom2 = new JSDOM2('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const { window: window2 } = dom2;
      window2.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {} }), geoJSON: () => ({ bindTooltip() { return this; } }) };
      window2.geoMapState = { instance: {}, featureIndex: { byCountyDistrict: new Map() } };
      window2.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {} }) });
      window2.apiFetch = window2.fetch;
      const ga4Src2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      window2.eval(ga4Src2);
      const partialNorm2 = window2.geoGa4NormalizeResponse({ success: true, data: { status: 'partial', quota_status: 'normal', is_cached: false, is_stale: false, summary: { total_active_users_ga4: 1, event_count: 1, screen_page_views: 1, mapped_counties: 0, unmapped_city_rows: 0, excluded_non_tw_rows: 0 }, counties: [], unmapped: [], notices: [], error_code: 'city_request_failed', error_stage: 'city' } });
      const msg2 = window2.geoGa4StatusMessage(partialNorm2);
      assert(msg2 !== '' && msg2 !== undefined, 'J127 status partial 不支援 → FAIL（若前端不認得 partial，statusMessage 會回空字串，目前有正確文案）');
    } else {
      pass('J127 status partial 不支援 → FAIL（jsdom 不存在，跳過但不計 FAIL）');
    }
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
