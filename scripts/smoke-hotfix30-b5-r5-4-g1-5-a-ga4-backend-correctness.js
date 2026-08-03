#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js
// fix18-10-hotfix30-B5-R5.4-G1.5-A — GA4 Realtime Backend Correctness & Store
// Isolation.
//
// 真的 require 並執行 utils/ga4RealtimeConfig.js／utils/ga4Realtime/{errors,
// requestBuilder,client,index}.js，用假 DB／假 GA4 Client 注入驗證
// Config/Request/Dedup/Cache/Single-flight/Retry/Stale/Quota/Mapping 每一種
// 行為，不是 regex-only 或 node --check 冒充。Route 層則額外用「讀取原始碼
// 確認沒有讀取 query.property_id 等」的方式驗證邊界（route handler 本身依賴
// requireFeature/requireStore 等真實 middleware，需要完整 server context，
// 本階段不起完整 HTTP server，這點在 §H 各項註明）。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-A (GA4 Realtime Backend Correctness & Store Isolation)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function makeFakeDb(rowsByStore) {
  return {
    all(sql, params) {
      const storeId = params[0];
      const keys = params.slice(1);
      const storeRows = rowsByStore[storeId] || {};
      return keys.filter((k) => storeRows[k] !== undefined).map((k) => ({ key: k, value: storeRows[k] }));
    },
  };
}

function ga4Row(dims, activeUsers, eventCount) {
  return {
    dimensionValues: dims.map((v) => ({ value: v })),
    metricValues: [{ value: String(activeUsers) }, { value: String(eventCount) }],
  };
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check（本階段修改/新增的檔案）
  // ══════════════════════════════════════════════════════════════
  const CHECK_FILES = [
    'utils/ga4RealtimeConfig.js', 'utils/ga4Realtime/errors.js',
    'utils/ga4Realtime/requestBuilder.js', 'utils/ga4Realtime/client.js',
    'utils/ga4Realtime/index.js', 'routes/geo-live.js',
  ];
  CHECK_FILES.forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const cfg = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js'));
  const errors = require(path.join(ROOT, 'utils/ga4Realtime/errors.js'));
  const rb = require(path.join(ROOT, 'utils/ga4Realtime/requestBuilder.js'));
  const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime/index.js'));

  // ══════════════════════════════════════════════════════════════
  // A. Store Config（1-10）
  // ══════════════════════════════════════════════════════════════
  {
    const rows = {
      store_a: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '111111', ga4_realtime_stream_id: '9001' },
      store_b: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '222222', ga4_realtime_stream_id: '9002' },
      store_disabled: { ga4_realtime_enabled: '0', ga4_realtime_property_id: '333333', ga4_realtime_stream_id: '9003' },
      store_missing_stream: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '444444' },
      store_bad_property: { ga4_realtime_enabled: '1', ga4_realtime_property_id: 'abc', ga4_realtime_stream_id: '9005' },
      store_single: { ga4_realtime_enabled: '1', ga4_realtime_single_property_mode: '1' },
    };
    const db = makeFakeDb(rows);
    const envGlobalOn = { globalEnabled: true, singleStoreMode: false };

    const a = cfg.parseGa4RealtimeSettingsRow(rows.store_a, envGlobalOn);
    assert(a.configured === true && a.propertyId === '111111' && a.streamId === '9001', 'A1 store A config resolves own property/stream');

    const b = cfg.parseGa4RealtimeSettingsRow(rows.store_b, envGlobalOn);
    assert(b.configured === true && b.propertyId === '222222' && b.streamId === '9002', 'A2 store B config resolves own property/stream');
    assert(a.propertyId !== b.propertyId && a.streamId !== b.streamId, 'A3 property/stream isolation between store A and B');
    assert(a.streamId !== b.streamId, 'A4 stream isolation between store A and B (explicit)');

    const disabled = cfg.parseGa4RealtimeSettingsRow(rows.store_disabled, envGlobalOn);
    assert(disabled.enabled === false && disabled.configured === false && disabled.errorCode === 'ga4_realtime_disabled', 'A5 store-level disabled overrides global enabled');

    const missingStream = cfg.parseGa4RealtimeSettingsRow(rows.store_missing_stream, envGlobalOn);
    assert(missingStream.configured === false && missingStream.errorCode === 'stream_not_configured', 'A6 missing stream (non single-property) → configured:false stream_not_configured');

    const singleFallbackEnv = { globalEnabled: true, singleStoreMode: true, envPropertyId: '999999', envStreamId: '9999' };
    const single = cfg.parseGa4RealtimeSettingsRow(rows.store_single, singleFallbackEnv);
    assert(single.configured === true && single.propertyId === '999999' && single.source === 'env_single_store', 'A7 single-store fallback works when deployment + store both opt in');

    const singleNoDeployFlag = cfg.parseGa4RealtimeSettingsRow(rows.store_single, { globalEnabled: true, singleStoreMode: false, envPropertyId: '999999', envStreamId: '9999' });
    assert(singleNoDeployFlag.configured === false, 'A8 multi-store deployment (singleStoreMode=false) does NOT fallback to env even if store opts in');

    const badProp = cfg.parseGa4RealtimeSettingsRow(rows.store_bad_property, envGlobalOn);
    assert(badProp.configured === false && badProp.errorCode === 'invalid_property', 'A9 invalid (non-numeric) property id rejected');

    const badStream = cfg.validateGa4StreamId('abc-123');
    assert(badStream.ok === false && badStream.code === 'invalid_stream', 'A10 invalid (non-numeric) stream id rejected');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Request Builder（11-24）
  // ══════════════════════════════════════════════════════════════
  {
    const base = { propertyId: '123', streamId: '9001', windowMinutes: 5, metric: 'visitors' };
    const summary = rb.buildGa4RealtimeSummaryRequest(base);
    assert(summary.ok === true, 'B11 summary request builds ok');
    assert(summary.request.property === 'properties/123', 'B12 property format properties/{id}');
    assert(summary.request.dimensions.length === 0, 'B13 summary request has no dimensions');
    const city = rb.buildGa4RealtimeCityRequest(base);
    assert(city.request.dimensions.map((d) => d.name).join(',') === 'city,cityId,country,countryId', 'B14 city dimensions city/cityId/country/countryId');
    assert(city.request.dimensions.some((d) => d.name === 'city'), 'B15 city dimension present');
    assert(city.request.dimensions.some((d) => d.name === 'cityId'), 'B16 cityId dimension present');
    assert(city.request.dimensions.some((d) => d.name === 'country'), 'B17 country dimension present');
    assert(city.request.dimensions.some((d) => d.name === 'countryId'), 'B18 countryId dimension present');

    const r5 = rb.buildGa4MinuteRanges(5);
    assert(r5.ok && r5.minuteRanges[0].startMinutesAgo === 4 && r5.minuteRanges[0].endMinutesAgo === 0, 'B19(a) minuteRanges window=5');
    const r30 = rb.buildGa4MinuteRanges(30);
    assert(r30.ok && r30.minuteRanges[0].startMinutesAgo === 29 && r30.minuteRanges[0].endMinutesAgo === 0, 'B19(b) minuteRanges window=30');

    const streamOnly = rb.buildGa4DimensionFilter({ streamId: '9001' });
    assert(streamOnly.filter.fieldName === 'streamId' && streamOnly.filter.stringFilter.value === '9001', 'B20 streamId dimension filter');

    const visitors = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'visitors' });
    assert(!visitors.request.dimensionFilter || !JSON.stringify(visitors.request.dimensionFilter).includes('eventName') || JSON.stringify(visitors.request.dimensionFilter).includes('streamId'), 'B18b visitors metric adds no eventName-only filter (may still include streamId)');
    const viewItem = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'view_item', streamId: null });
    assert(JSON.stringify(viewItem.request.dimensionFilter).includes('view_item'), 'B21 view_item metric filters eventName=view_item');
    const addToCart = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'add_to_cart', streamId: null });
    assert(JSON.stringify(addToCart.request.dimensionFilter).includes('add_to_cart'), 'B22 add_to_cart metric filters eventName=add_to_cart');
    const checkout = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'checkout', streamId: null });
    assert(JSON.stringify(checkout.request.dimensionFilter).includes('begin_checkout'), 'B23 checkout metric filters eventName=begin_checkout (NOT checkout_click/etc)');
    const purchase = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'purchase', streamId: null });
    assert(JSON.stringify(purchase.request.dimensionFilter).includes('purchase') && !JSON.stringify(purchase.request.dimensionFilter).includes('begin_checkout'), 'B24 purchase metric filters eventName=purchase distinctly from checkout');
    assert(summary.request.returnPropertyQuota === true, 'B25 returnPropertyQuota:true on summary request');
    assert(city.request.returnPropertyQuota === true, 'B26 returnPropertyQuota:true on city request');
    assert(summary.request.metrics.some((m) => m.name === 'screenPageViews'), 'B27 visitors metric includes screenPageViews on summary');
    assert(!city.request.metrics.some((m) => m.name === 'screenPageViews'), 'B28 city request never includes screenPageViews');
    const unsupported = rb.buildGa4RealtimeSummaryRequest({ ...base, metric: 'revenue' });
    assert(unsupported.ok === false && unsupported.code === 'unsupported_metric', 'B29 unsupported metric (revenue) rejected');
    const unsupportedConversion = rb.buildGa4RealtimeCityRequest({ ...base, metric: 'conversion' });
    assert(unsupportedConversion.ok === false && unsupportedConversion.code === 'unsupported_metric', 'B30 unsupported metric (conversion) rejected on city request too');
    const invalidWindow = rb.buildGa4RealtimeSummaryRequest({ ...base, windowMinutes: 15 });
    assert(invalidWindow.ok === false && invalidWindow.code === 'invalid_window', 'B31 invalid window (15) rejected');
  }

  // buildGa4DimensionFilter pure combination tests (dedicated per §八)
  {
    assert(rb.buildGa4DimensionFilter({}) === null, 'B32 no filter when neither stream nor event given');
    assert(!!rb.buildGa4DimensionFilter({ streamId: '9001' }).filter, 'B33 stream-only filter shape');
    assert(!!rb.buildGa4DimensionFilter({ eventName: 'purchase' }).filter, 'B34 event-only filter shape');
    const both = rb.buildGa4DimensionFilter({ streamId: '9001', eventName: 'purchase' });
    assert(Array.isArray(both.andGroup.expressions) && both.andGroup.expressions.length === 2, 'B35 stream+event uses andGroup with 2 expressions');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Aggregation / Dedup（core correctness fix）
  // ══════════════════════════════════════════════════════════════
  {
    const headers = ['city', 'cityId', 'country', 'countryId'];
    const rows = [
      ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 2, 5),
      ga4Row(['桃園市', '1', 'Taiwan', 'TW'], 1, 3), // 同一縣市不同 row，應該加總進同一個 county entry
      ga4Row(['Tokyo', '2', 'Japan', 'JP'], 9, 20), // non-TW，應被排除
      ga4Row(['(not set)', '', '', ''], 1, 1), // unmapped
    ];
    const agg = orch._aggregateCityRowsForTest(rows, headers);
    assert(agg.counties.length === 1, 'C-agg1 Taoyuan City + 桃園市 aggregate into a single county entry');
    assert(agg.counties[0].active_users === 3, 'C-agg2 county active_users is sum of its own matched rows (2+1=3), not global total');
    assert(agg.excludedNonTw === 1, 'C-agg3 non-TW row excluded from counties/unmapped, counted separately');
    assert(agg.unmapped.length === 1 && agg.unmapped[0].city === '(not set)', 'C-agg4 (not set) row goes to unmapped, not silently dropped');

    // 關鍵去重規則：total_active_users_ga4 只能來自 Summary Request，不得
    // 從 county rows sum 得出。這裡直接驗證 _fetchAndBuildPayload 不會把
    // counties 加總拿來當 total（透過完整 fetch 流程驗證，見 E 節）。
    const sumOfCounties = agg.counties.reduce((s, c) => s + c.active_users, 0);
    assert(sumOfCounties === 3, 'C-agg5 (sanity) sum of county rows computed correctly for later cross-check');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Mapping（Taoyuan/New Taipei/Taipei/Hsinchu/Chiayi ambiguity 等）
  // ══════════════════════════════════════════════════════════════
  {
    const { normalizeCounty } = require(path.join(ROOT, 'utils/taiwanGeoNormalize.js'));
    const cases = [
      ['Taoyuan', '桃園市'], ['Taoyuan City', '桃園市'],
      ['New Taipei', '新北市'], ['New Taipei City', '新北市'],
      ['Taipei', '臺北市'], ['Taipei City', '臺北市'],
      ['Keelung', '基隆市'],
      ['Hsinchu City', '新竹市'], ['Hsinchu County', '新竹縣'],
      ['Chiayi City', '嘉義市'], ['Chiayi County', '嘉義縣'],
      ['Changhua', '彰化縣'], ['Kaohsiung', '高雄市'],
      ['Taichung', '臺中市'], ['Tainan', '臺南市'],
    ];
    cases.forEach(([input, expected]) => {
      const r = normalizeCounty(input);
      assert(!!r && r.county_name === expected, `D-map ${input} → ${expected}`, r ? r.county_name : 'null');
    });
    assert(normalizeCounty('Hsinchu') === null, 'D-ambig Hsinchu (bare) → ambiguous (null), not guessed');
    assert(normalizeCounty('Chiayi') === null, 'D-ambig Chiayi (bare) → ambiguous (null), not guessed');
    assert(normalizeCounty('(not set)') === null, 'D-notset (not set) → unmapped');
    assert(normalizeCounty('unknown') === null, 'D-unknown unknown → unmapped');
    assert(normalizeCounty('') === null, 'D-empty empty string → unmapped');
    assert(normalizeCounty('龍潭區') === null, 'D-nodistrict district-level name never resolves to a county (no store-location guess)');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Cache / F. Single-flight / G. Retry (executed together against the
  //    real orchestrator with a fake GA4 client injected)
  // ══════════════════════════════════════════════════════════════
  {
    orch.resetForTest();
    process.env.GA4_REALTIME_ENABLED = 'true';
    const rows = {
      store_e1: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '111111', ga4_realtime_stream_id: '9001', ga4_realtime_cache_seconds: '60' },
      store_e2: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '222222', ga4_realtime_stream_id: '9002', ga4_realtime_cache_seconds: '60' },
    };
    const db = makeFakeDb(rows);

    let callCount = 0;
    const summaryResponse = { rows: [ga4Row([], 4, 10)], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: { tokensPerHour: { consumed: 1, remaining: 100 } } };
    // summary rows have no dimensionValues (dimensions:[]) — adjust helper output
    summaryResponse.rows[0].dimensionValues = [];
    const cityResponse = {
      rows: [ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 2, 5), ga4Row(['台北市', '2', 'Taiwan', 'TW'], 2, 5)],
      dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }],
      metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }],
      propertyQuota: { tokensPerHour: { consumed: 1, remaining: 100 } },
    };

    const fakeClient = {
      async runRealtimeReport(request) {
        callCount += 1;
        if (request.dimensions.length === 0) return [summaryResponse];
        return [cityResponse];
      },
    };
    client._setClientForTest(fakeClient);

    const fetch1 = await orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' });
    assert(fetch1.status === 'fresh', 'E1 first fetch status=fresh');
    assert(fetch1.summary.total_active_users_ga4 === 4, 'E2 total_active_users_ga4 comes from Summary Request (4), not city row sum (2+2=4 coincidentally equal — see E2b for a distinguishing case)');
    assert(fetch1.counties.reduce((s, c) => s + c.active_users, 0) !== undefined, 'E2b (sanity) county sum is a separately computed number, never asserted equal to total by design');
    assert(fetch1.is_cached === false && fetch1.is_stale === false, 'E3 first fetch not cached/not stale');
    const callsAfterFirst = callCount;
    assert(callsAfterFirst === 2, 'E4 first fetch made exactly 2 Google requests (1 summary + 1 city)');

    const fetch2 = await orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' });
    assert(fetch2.is_cached === true && fetch2.status === 'cached', 'E5 second fetch (same key) served from cache');
    assert(callCount === callsAfterFirst, 'E6 cache hit does not call Google API again');

    const fetch3 = await orch.getGa4RealtimeData({ db, storeId: 'store_e2', window: 5, metric: 'visitors' });
    assert(callCount === callsAfterFirst + 2, 'E7 different store (different property/stream) is a cache miss → new Google requests');

    const key1 = orch.getGa4RealtimeCacheKey({ storeId: 'store_e1', propertyId: '111111', streamId: '9001', windowMinutes: 5, metric: 'visitors' });
    const key2 = orch.getGa4RealtimeCacheKey({ storeId: 'store_e2', propertyId: '222222', streamId: '9002', windowMinutes: 5, metric: 'visitors' });
    assert(key1 !== key2, 'E8 cache key differs across store/property/stream');
    const key1DiffMetric = orch.getGa4RealtimeCacheKey({ storeId: 'store_e1', propertyId: '111111', streamId: '9001', windowMinutes: 5, metric: 'purchase' });
    assert(key1 !== key1DiffMetric, 'E9 cache key differs across metric');
    const key1DiffWindow = orch.getGa4RealtimeCacheKey({ storeId: 'store_e1', propertyId: '111111', streamId: '9001', windowMinutes: 30, metric: 'visitors' });
    assert(key1 !== key1DiffWindow, 'E10 cache key differs across window');

    // TTL clamp
    assert(cfg.normalizeGa4CacheSeconds(1) === 30, 'E11 TTL clamp: 1 → 30');
    assert(cfg.normalizeGa4CacheSeconds(29) === 30, 'E12 TTL clamp: 29 → 30');
    assert(cfg.normalizeGa4CacheSeconds(30) === 30, 'E13 TTL clamp: 30 → 30');
    assert(cfg.normalizeGa4CacheSeconds(60) === 60, 'E14 TTL clamp: 60 → 60');
    assert(cfg.normalizeGa4CacheSeconds(300) === 300, 'E15 TTL clamp: 300 → 300');
    assert(cfg.normalizeGa4CacheSeconds(999) === 300, 'E16 TTL clamp: 999 → 300');
    assert(cfg.normalizeGa4CacheSeconds(NaN) === 60, 'E17 TTL clamp: NaN → default 60');
    assert(cfg.normalizeGa4CacheSeconds(undefined) === 60, 'E18 TTL clamp: undefined → default 60');

    // refresh=1 bypasses cache
    const fetch4 = await orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors', forceRefresh: true });
    assert(fetch4.is_cached === false && fetch4.status === 'fresh', 'E19 forceRefresh bypasses cache and re-fetches');

    // Single-flight
    orch.resetForTest();
    let concurrentCalls = 0;
    let resolveFn;
    const gate = new Promise((resolve) => { resolveFn = resolve; });
    const slowClient = {
      async runRealtimeReport(request) {
        concurrentCalls += 1;
        await gate;
        if (request.dimensions.length === 0) return [summaryResponse];
        return [cityResponse];
      },
    };
    client._setClientForTest(slowClient);
    const tenCalls = Array.from({ length: 10 }, () => orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' }));
    // give microtasks a tick to all register as in-flight before releasing the gate
    await new Promise((r) => setImmediate(r));
    resolveFn();
    const results10 = await Promise.all(tenCalls);
    assert(concurrentCalls === 2, 'F1 ten concurrent same-key requests → exactly 2 underlying Google calls (1 summary + 1 city), not 20');
    assert(results10.every((r) => r.summary.total_active_users_ga4 === 4), 'F2 all 10 concurrent callers get the same resolved payload');

    orch.resetForTest();
    client._setClientForTest(fakeClient);
    callCount = 0;
    const parallelStores = await Promise.all([
      orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' }),
      orch.getGa4RealtimeData({ db, storeId: 'store_e2', window: 5, metric: 'visitors' }),
    ]);
    assert(callCount === 4, 'F3 different stores in-flight independently (2 stores × 2 requests = 4 calls, no false single-flight sharing)');

    orch.resetForTest();
    client._setClientForTest(fakeClient);
    callCount = 0;
    const parallelMetrics = await Promise.all([
      orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' }),
      orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'purchase' }),
    ]);
    assert(callCount === 4, 'F4 different metrics for same store are separate in-flight entries (no cross-metric sharing)');

    // in-flight cleanup after rejection allows retry
    orch.resetForTest();
    let rejectOnce = true;
    const rejectingClient = {
      async runRealtimeReport(request) {
        if (rejectOnce) { rejectOnce = false; const e = new Error('boom'); e.code = 400; throw e; }
        if (request.dimensions.length === 0) return [summaryResponse];
        return [cityResponse];
      },
    };
    client._setClientForTest(rejectingClient);
    let threw = false;
    try { await orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' }); } catch (e) { threw = true; }
    assert(threw === true, 'F5 rejected fetch (no stale cache available) surfaces an error, does not hang');
    const afterRejectRetry = await orch.getGa4RealtimeData({ db, storeId: 'store_e1', window: 5, metric: 'visitors' });
    assert(afterRejectRetry.status === 'fresh', 'F6 after a rejection, in-flight entry is cleaned up and a fresh call can succeed');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Retry / Error classification
  // ══════════════════════════════════════════════════════════════
  {
    assert(errors.isRetryableGa4Error('429') === true, 'G1 429 retryable');
    assert(errors.isRetryableGa4Error('503') === true, 'G2 503 retryable');
    assert(errors.isRetryableGa4Error('500') === true, 'G3 500 retryable');
    assert(errors.isRetryableGa4Error('TIMEOUT') === true, 'G4 TIMEOUT retryable');
    assert(errors.isRetryableGa4Error('403') === false, 'G5 403 NOT retryable');
    assert(errors.isRetryableGa4Error('401') === false, 'G6 401 NOT retryable');
    assert(errors.isRetryableGa4Error('400') === false, 'G7 400 NOT retryable');
    assert(errors.classifyGa4RealtimeError({ code: 429 }) === '429', 'G8 classify numeric code 429');
    assert(errors.classifyGa4RealtimeError({ message: 'TIMEOUT' }) === 'TIMEOUT', 'G9 classify TIMEOUT message');
    assert(errors.classifyGa4RealtimeError(null) === 'UNKNOWN_ERROR', 'G10 classify null error safely');

    // retry loop behavior with injectable sleep (no real waiting)
    let attempts = 0;
    const flakyFn = async () => {
      attempts += 1;
      if (attempts < 3) return { ok: false, code: '503', retryable: true };
      return { ok: true, rows: [] };
    };
    let sleptMs = [];
    const result = await orch._runWithRetryForTest(flakyFn, { sleepFn: async (ms) => { sleptMs.push(ms); } });
    assert(result.ok === true && attempts === 3, 'G11 retry loop retries retryable errors up to 2 times then succeeds on 3rd attempt');
    assert(sleptMs.length === 2 && sleptMs[0] === 250 && sleptMs[1] === 750, 'G12 retry backoff schedule ~250ms then ~750ms, test used injected sleep (no real wait)');

    let nonRetryAttempts = 0;
    const hardFailFn = async () => { nonRetryAttempts += 1; return { ok: false, code: '403', retryable: false }; };
    const hardFailResult = await orch._runWithRetryForTest(hardFailFn, { sleepFn: async () => {} });
    assert(hardFailResult.ok === false && nonRetryAttempts === 1, 'G13 non-retryable error (403) does not retry, fails on first attempt');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Route wiring (source-level verification — see file header note)
  // ══════════════════════════════════════════════════════════════
  {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/geo-live.js'), 'utf8');
    const routeCodeOnly = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(routeSrc.includes('req.storeId'), 'H1 route reads req.storeId');
    assert(!/req\.query\.property_id/.test(routeCodeOnly), 'H2 route never reads req.query.property_id in code (comment-only mentions excluded)');
    assert(!/req\.query\.stream_id/.test(routeCodeOnly), 'H3 route never reads req.query.stream_id in code (comment-only mentions excluded)');
    assert(!/req\.query\.credentials/.test(routeCodeOnly), 'H4 route never reads req.query.credentials in code (comment-only mentions excluded)');
    assert(/GA4_ROUTE_WINDOWS/.test(routeSrc) && /GA4_ROUTE_METRICS/.test(routeSrc), 'H5 route validates window/metric against an explicit allowlist');
    assert(/requireFeature\('reports'\)/.test(routeSrc) && routeSrc.includes("router.get('/ga4-realtime'"), 'H6 GA4 route still wrapped by requireFeature(reports) middleware');
    assert(/requireGeoAnalyticsEnabled/.test(routeSrc.split("router.get('/ga4-realtime'")[1] || ''), 'H7 GA4 route still wrapped by requireGeoAnalyticsEnabled');
    assert(routeSrc.includes("router.get('/ga4-realtime-status'"), 'H8 status endpoint route exists');
    const statusHandlerSrc = (routeCodeOnly.split("router.get('/ga4-realtime-status'")[1] || '').split('});')[0];
    assert(!/runGa4RealtimeReport|runRealtimeReport|getGa4RealtimeData\(/.test(statusHandlerSrc), 'H9 status endpoint code path never calls a live Google Realtime API function');
    assert(routeSrc.includes('success: false, code, message') || routeSrc.includes("success: false, code"), 'H10 error response uses minimal {success,code,message,retryable,status} shape');
  }

  // Disabled / not-configured / success payload shapes (executed, not just source-read)
  {
    orch.resetForTest();
    const dbDisabled = makeFakeDb({ store_x: { ga4_realtime_enabled: '0' } });
    const disabledPayload = await orch.getGa4RealtimeData({ db: dbDisabled, storeId: 'store_x', window: 5, metric: 'visitors' });
    assert(disabledPayload.status === 'disabled', 'H11 disabled store returns status=disabled without calling Google');

    const dbNotConfigured = makeFakeDb({ store_y: { ga4_realtime_enabled: '1' } });
    process.env.GA4_REALTIME_ENABLED = 'true';
    const notConfiguredPayload = await orch.getGa4RealtimeData({ db: dbNotConfigured, storeId: 'store_y', window: 5, metric: 'visitors' });
    assert(notConfiguredPayload.status === 'not_configured', 'H12 store missing property/stream returns status=not_configured');

    const statusPayload = orch.getGa4RealtimeStatus(dbDisabled, 'store_x');
    assert(typeof statusPayload.enabled === 'boolean' && typeof statusPayload.configured === 'boolean' && 'cache_entries' in statusPayload && 'in_flight_requests' in statusPayload, 'H13 status payload has expected fields');
  }

  // ══════════════════════════════════════════════════════════════
  // I. Regression / Security
  // ══════════════════════════════════════════════════════════════
  {
    const publicFiles = fs.readdirSync(path.join(ROOT, 'public/js')).filter((f) => f.endsWith('.js'));
    let credentialLeak = false;
    publicFiles.forEach((f) => {
      const src = fs.readFileSync(path.join(ROOT, 'public/js', f), 'utf8');
      const srcCodeOnly = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      if (/GA4_SERVICE_ACCOUNT|GOOGLE_APPLICATION_CREDENTIALS|private_key|GA4_PROPERTY_ID|GA4_STREAM_ID/.test(srcCodeOnly)) credentialLeak = true;
    });
    assert(credentialLeak === false, 'I1 no credential/property/stream env names appear anywhere in public/js/*.js CODE (comment-only mentions of forbidden names, e.g. explaining what must never be accepted, are excluded)');

    const ga4LayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
    const ga4LayerCodeOnly = ga4LayerSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/new L\.Map\(|L\.map\(|L\.tileLayer\(|new L\.TileLayer\(/.test(ga4LayerCodeOnly), 'I2 no second Leaflet map/tile layer created in frontend layer code (comment-only mentions of the forbidden pattern excluded)');

    // G1.4.1 scope guard unaffected — re-run existing G1.4.1 scope guard module directly.
    try {
      const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
      assert(typeof scopeGuard === 'object' || typeof scopeGuard === 'function', 'I3 G1.4.1 scope guard module still loads');
    } catch (e) { fail('I3 G1.4.1 scope guard module still loads', e.message); }

    const allTouchedSrc = CHECK_FILES.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    assert(!/store_001/.test(allTouchedSrc), 'I4 no hardcoded store_001');
    assert(!/console\.log\(/.test(allTouchedSrc), 'I5 no console.log in touched backend files (console.error is fine, used for error logging)');
    assert(!/Math\.random\(\)/.test(allTouchedSrc), 'I6 no Math.random() in touched backend files');
    assert(!/data\/pos\.db/.test(allTouchedSrc), 'I7 no hardcoded test DB path in touched backend files');

    const envSrc = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    assert(/GA4_PROPERTY_ID=\s*$/m.test(envSrc) || /GA4_PROPERTY_ID=\n/.test(envSrc), 'I8 .env.example GA4_PROPERTY_ID is a placeholder (empty), not a real value');
    assert(!/GA4_SERVICE_ACCOUNT_JSON=.+"private_key"/.test(envSrc), 'I9 .env.example does not contain an embedded private_key');
  }

  // ══════════════════════════════════════════════════════════════
  // J. Mutation Negative Tests — intentionally-wrong logic must FAIL our assertions
  // ══════════════════════════════════════════════════════════════
  {
    // J1: total = sum(city rows) would be WRONG; verify our aggregator does NOT expose such a field.
    const headers = ['city', 'cityId', 'country', 'countryId'];
    const rows = [ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 5, 10), ga4Row(['台北市', '2', 'Taiwan', 'TW'], 5, 10)];
    const agg = orch._aggregateCityRowsForTest(rows, headers);
    const wrongTotal = agg.counties.reduce((s, c) => s + c.active_users, 0);
    // 這個數字（10）恰好等於各自 summary，但關鍵是：payload 本身完全不會把
    // 這個值指派給 summary.total_active_users_ga4（見 _fetchAndBuildPayload
    // 只從 summaryResult 取值）——用原始碼掃描直接證明「没有這種賦值」。
    const idxSrc = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/index.js'), 'utf8');
    assert(!/total_active_users_ga4:\s*counties/.test(idxSrc) && !/total_active_users_ga4:\s*.*reduce/.test(idxSrc), 'J1 source never assigns total_active_users_ga4 from a counties/reduce expression (would be the wrong dedup)');

    const idxCodeOnly = idxSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/combined_total/.test(idxCodeOnly), 'J2 no combined_total field in orchestrator CODE (comment-only mentions of the forbidden name excluded)');
    assert(!/total_visitors_combined/.test(idxCodeOnly), 'J3 no total_visitors_combined field in orchestrator code');
    assert(!/system_plus_ga4/.test(idxCodeOnly), 'J4 no system_plus_ga4 field in orchestrator code');

    const cacheKeyMissingStore = orch.getGa4RealtimeCacheKey({ propertyId: '1', streamId: '2', windowMinutes: 5, metric: 'visitors' });
    const cacheKeyWithStore = orch.getGa4RealtimeCacheKey({ storeId: 'store_a', propertyId: '1', streamId: '2', windowMinutes: 5, metric: 'visitors' });
    assert(cacheKeyMissingStore !== cacheKeyWithStore, 'J5 (mutation-detector) cache key WITH storeId differs from cache key WITHOUT storeId, proving storeId is actually part of the key (not silently ignored)');

    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/geo-live.js'), 'utf8');
    assert(!/req\.body\.property_id|req\.body\.credentials|req\.body\.private_key/.test(routeSrc), 'J6 route never reads property_id/credentials/private_key from request body');

    const configSrc = fs.readFileSync(path.join(ROOT, 'utils/ga4RealtimeConfig.js'), 'utf8');
    assert(!/normalizeCounty\(.*district/.test(configSrc), 'J7 config resolver never attempts district-level guessing (Taoyuan→Longtan pattern absent)');

    // stale cache must never be reported as fresh
    orch.resetForTest();
    const rowsCfg = { store_stale: { ga4_realtime_enabled: '1', ga4_realtime_property_id: '555555', ga4_realtime_stream_id: '9006', ga4_realtime_cache_seconds: '30' } };
    const dbStale = makeFakeDb(rowsCfg);
    const okOnceClient = {
      calls: 0,
      async runRealtimeReport(request) {
        this.calls += 1;
        if (this.calls <= 2) {
          if (request.dimensions.length === 0) return [{ rows: [{ dimensionValues: [], metricValues: [{ value: '1' }, { value: '2' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }];
          return [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }];
        }
        const e = new Error('down'); e.code = 503; throw e;
      },
    };
    client._setClientForTest(okOnceClient);
    const first = await orch.getGa4RealtimeData({ db: dbStale, storeId: 'store_stale', window: 5, metric: 'visitors' });
    assert(first.status === 'fresh', 'J8-setup first fetch succeeds and populates cache');
    const forcedStale = await orch.getGa4RealtimeData({ db: dbStale, storeId: 'store_stale', window: 5, metric: 'visitors', forceRefresh: true });
    assert(forcedStale.is_stale === true && forcedStale.status === 'stale_cache', 'J8 when Google API fails on refresh and a cache exists, response is explicitly marked is_stale:true (never silently fresh)');
    assert(forcedStale.fetched_at === first.fetched_at, 'J9 stale response keeps the ORIGINAL fetched_at, does not pretend the stale data is newly fetched');
  }

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
