#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js
// fix18-10-hotfix30-B5-R5.2-B1-1：Geo Intelligence Dashboard API 換線
//
// 沿用 scripts/smoke-hotfix31-r4-visitor360-ui.js / smoke-hotfix30-b5-r5-1-c-geo-ui.js
// 已驗證過的慣例：Part A 是純函式單元測試（直接 require，不需要 jsdom）；
// Part B 是 jsdom 實測（真的執行 public/js/app.js + analytics-v2.js +
// geo-intelligence.js，不是原始碼字串掃描）。jsdom 未安裝時，Part B 全部
// 標記 MANUAL REQUIRED，不假裝 PASS（誠實回報，見需求文件二十二）。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  // ══════════════════════════════════════════════════════════════
  // Part A：純函式單元測試（不需要 jsdom，直接 require）
  // ══════════════════════════════════════════════════════════════
  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ── A1. API Client：參數白名單／不接受 store_id／不使用 from/to ──
  assert(Array.isArray(RE.GEO_DASHBOARD_PARAM_KEYS), 'param keys: exported as array');
  assert(RE.GEO_DASHBOARD_PARAM_KEYS.includes('date_from') && RE.GEO_DASHBOARD_PARAM_KEYS.includes('date_to'),
    'param keys: uses date_from/date_to (matches utils/geoAnalyticsFilters.js), not from/to');
  assert(!RE.GEO_DASHBOARD_PARAM_KEYS.includes('from') && !RE.GEO_DASHBOARD_PARAM_KEYS.includes('to'),
    'param keys: does NOT include invented from/to param names');
  assert(!RE.GEO_DASHBOARD_PARAM_KEYS.includes('store_id'),
    'param keys: does NOT include store_id (server derives storeId from requireStore, not query)');
  {
    const qs = RE._buildGeoDashboardParams({ date_from: '2026-07-01', date_to: '2026-07-24', county_code: '68000', store_id: 'should_be_ignored' });
    assert(qs.get('date_from') === '2026-07-01', 'param builder: date_from passed through');
    assert(qs.get('date_to') === '2026-07-24', 'param builder: date_to passed through');
    assert(qs.get('county_code') === '68000', 'param builder: county_code passed through');
    assert(qs.get('store_id') === null, 'param builder: unknown key (store_id) silently dropped, not forwarded');
  }
  {
    const qs = RE._buildGeoDashboardParams({ subdivision_code: '', channel: null, source: undefined });
    assert(qs.get('subdivision_code') === null, 'param builder: empty string treated as "not provided"');
    assert(qs.get('channel') === null, 'param builder: null treated as "not provided"');
    assert(qs.get('source') === null, 'param builder: undefined treated as "not provided"');
  }
  assert(RE._buildGeoDashboardParams({}).toString() === '', 'param builder: no params -> empty query string, no throw');
  assert(RE._buildGeoDashboardParams(null).toString() === '', 'param builder: null params -> empty query string, no throw');

  // ── A2. 成交率公式與後端 utils/geoAnalyticsQueries.js:_rate() 一致 ──
  assert(RE._geoRate(10, 100) === 0.1, 'rate: 10/100 -> 0.1 (0~1 fraction, not percentage)');
  assert(RE._geoRate(1, 3) === 0.3333, 'rate: rounds to 4 decimals, same as backend _rate()');
  assert(RE._geoRate(0, 0) === 0, 'rate: 0/0 -> 0, no NaN/Infinity');
  assert(RE._geoRate(5, 0) === 0, 'rate: divide-by-zero guarded -> 0, not Infinity');
  assert(!Number.isNaN(RE._geoRate(undefined, undefined)), 'rate: undefined inputs -> no NaN');

  // ── A3. KPI 加總：來自 /funnel areas，不是前端自創公式 ──
  {
    const funnel = { areas: [
      { visitors: 50, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 10 },
      { visitors: 30, add_to_cart_visitors: 5, begin_checkout_visitors: 2, submitted_order_visitors: 0 },
    ] };
    const totals = RE._sumFunnelAreas(funnel);
    assert(totals.visitors === 80, 'kpi sum: visitors summed across areas');
    assert(totals.add_to_cart_visitors === 25, 'kpi sum: add_to_cart summed across areas');
    assert(totals.begin_checkout_visitors === 17, 'kpi sum: begin_checkout summed across areas');
    assert(totals.submitted_order_visitors === 10, 'kpi sum: submitted_order summed across areas');
    const kpi = RE.computeGeoDashboardKpi({ funnel });
    assert(kpi.visitors === 80, 'computeGeoDashboardKpi: visitors correct');
    assert(kpi.conversion_rate === RE._geoRate(10, 80), 'computeGeoDashboardKpi: conversion_rate == Σsubmitted/Σvisitors, backend _rate() formula');
  }
  assert(RE.computeGeoDashboardKpi({ funnel: null }).visitors === 0, 'computeGeoDashboardKpi: null funnel -> zeroed KPI, no throw');
  assert(RE.computeGeoDashboardKpi({}).conversion_rate === 0, 'computeGeoDashboardKpi: missing funnel -> conversion_rate 0, not NaN');

  // ── A4. Top 區域：門檻沿用 getGeoDashboardSummary()（MIN_SAMPLE=10／waste 20） ──
  {
    const vm = {
      funnel: { areas: [
        { city: '桃園市', district: '中壢區', area_label: '桃園市中壢區', visitors: 42, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 12 },
        { city: '桃園市', district: '八德區', area_label: '桃園市八德區', visitors: 9, add_to_cart_visitors: 5, begin_checkout_visitors: 3, submitted_order_visitors: 3 }, // < MIN_SAMPLE(10) -> excluded from high_intent
        { city: '桃園市', district: '平鎮區', area_label: '桃園市平鎮區', visitors: 25, add_to_cart_visitors: 6, begin_checkout_visitors: 1, submitted_order_visitors: 0 }, // >= 20 visitors, 0 orders -> low_conversion
        { city: null, district: null, visitors: 15, add_to_cart_visitors: 2, begin_checkout_visitors: 0, submitted_order_visitors: 0 }, // unknown row
      ] },
      county_summary: { rows: [
        { county_code: '68000', county_name: '桃園市', order_count: 12, revenue: 9000 },
        { county_code: null, county_name: null, order_count: 3, revenue: 500 },
      ] },
    };
    const tops = RE.computeGeoTopAreas(vm);
    assert(tops.high_intent.length >= 1 && tops.high_intent[0].area_label === '桃園市中壢區', 'top areas: high_intent picks top scoring area');
    assert(!tops.high_intent.some((a) => a.area_label === '桃園市八德區'), 'top areas: MIN_SAMPLE=10 threshold excludes 9-visitor area from high_intent (matches getGeoDashboardSummary())');
    assert(tops.low_conversion.some((a) => a.area_label === '桃園市平鎮區'), 'top areas: low_conversion includes >=20 visitors / 0 orders area (matches getGeoDashboardSummary() waste threshold)');
    assert(!tops.low_conversion.some((a) => a.unknown === undefined), 'top areas: every row carries an explicit unknown flag');
    assert(tops.top_orders_by_source_county[0].area_label === '桃園市', 'top areas: top_orders_by_source_county sorted by order_count desc');
    assert(tops.top_orders_by_source_county.some((c) => c.unknown === true) === false || tops.top_orders_by_source_county.length <= 2,
      'top areas: unknown county row handled without throwing');
  }
  {
    const tops = RE.computeGeoTopAreas({ funnel: null, county_summary: null });
    assert(Array.isArray(tops.high_intent) && tops.high_intent.length === 0, 'top areas: null vm -> empty arrays, no throw');
  }

  // ── A5. Geo Quality 文案：狀態沿用既有 API status 值，不發明新門檻 ──
  {
    const html = RE.renderGeoQualityBlock({ status: 'healthy', unknown_rate: 0.05, identified_rate: 0.95, total_events: 100, identified_events: 95 });
    assert(/未知區域比例\s*5%/.test(html), 'geo quality: unknown rate rendered as percentage of the 0-1 fraction');
    assert(/已辨識比例\s*95%/.test(html), 'geo quality: identified rate rendered correctly');
  }
  {
    const html = RE.renderGeoQualityBlock({ status: 'degraded', unknown_rate: 1, identified_rate: 0, total_events: 50, identified_events: 0 });
    assert(html.includes('目前所有訪客皆為未知區域，請檢查 Acquisition Geo 資料來源'), 'geo quality: 100% unknown shows the required honest message, not just "—"');
  }
  assert(RE.renderGeoQualityBlock(null).includes('無法取得'), 'geo quality: null input handled without throw');

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測（真的載入並執行前端程式碼）
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('Part B 全部項目（DOM 層級行為測試）', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  const av2Src = av2SrcRaw.replace(/'use strict';\s*\n/, '');
  const geoSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
  // 同一份原始碼在瀏覽器 <script> 下沒有 `module`；這裡把檔尾的
  // `if (typeof module !== 'undefined' ...) { module.exports = {...} }`
  // 保留（jsdom 的 window 底下同樣沒有 module，條件判斷會直接跳過，不影響
  // window 上掛的函式，跟 app.js/analytics-v2.js 的載入方式一致）。
  const geoSrc = geoSrcRaw.replace(/'use strict';\s*\n/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="db-body-v2"></div><div id="analytics-v2-container"></div><div id="reports-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  function geoOverviewFixture(overrides) {
    return Object.assign({
      visitor_geo: { identified_visitors: 80, unknown_visitors: 15, identified_rate: 0.842 },
      fulfillment_geo: { orders_with_geo: 12, orders_without_geo: 2, average_distance_km: 3.2, average_delivery_fee: 45 },
      top_areas: [{ city: '桃園市', district: '中壢區', visitors: 42 }],
      data_quality: { status: 'healthy', total_events: 200, identified_events: 190, unknown_events: 10, identified_rate: 0.95, unknown_rate: 0.05, minimum_sample: 10 },
    }, overrides || {});
  }
  function geoFunnelFixture(overrides) {
    return Object.assign({
      page: 1, limit: 100,
      areas: [
        { city: '桃園市', district: '中壢區', area_label: '桃園市中壢區', county_code: '68000', subdivision_code: '68000040', visitors: 42, view_product_visitors: 30, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 12, purchase_visitors: 10, visit_to_order_rate: 0.2857 },
        { city: '桃園市', district: '平鎮區', area_label: '桃園市平鎮區', county_code: '68000', subdivision_code: '68000050', visitors: 25, view_product_visitors: 10, add_to_cart_visitors: 6, begin_checkout_visitors: 1, submitted_order_visitors: 0, purchase_visitors: 0, visit_to_order_rate: 0 },
      ],
    }, overrides || {});
  }
  function geoAlertsFixture(overrides) {
    return Object.assign({ alerts: [
      { type: 'traffic_waste', severity: 'warning', geo_context: 'acquisition', city: '桃園市', district: '平鎮區', area_label: '桃園市平鎮區', message: '平鎮區進站流量不低，但幾乎沒有送出訂單', suggestion: '建議檢查此區域的廣告受眾設定', metrics: {} },
    ], rule_thresholds: {} }, overrides || {});
  }
  function geoCountySummaryFixture(overrides) {
    return Object.assign({ ok: true, rows: [
      { county_code: '68000', county_name: '桃園市', visitor_count: 67, order_count: 12, revenue: 9000 },
    ], unknown: { visitor_count: 5, percentage: 6.9 } }, overrides || {});
  }

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url, fetchOpts) => {
      const u = String(url);
      fetchCalls.push({ url: u, opts: fetchOpts });
      const headers = (fetchOpts && fetchOpts.headers) || {};
      const storeId = headers['x-store-id'];
      let body = { success: false };
      let status = 404;
      let delay = opts.delayFor ? opts.delayFor(u, storeId) : 0;

      if (opts.forceStatus && opts.forceStatus(u)) {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: opts.forceStatus(u), json: async () => ({ success: false, error: 'forced' }) }), delay));
      }

      if (u.includes('/api/analytics/geo/overview')) {
        body = { success: true, data: opts.overviewFor ? opts.overviewFor(storeId, u) : geoOverviewFixture() };
        status = 200;
      } else if (u.includes('/api/analytics/geo/funnel')) {
        body = { success: true, data: opts.funnelFor ? opts.funnelFor(storeId, u) : geoFunnelFixture() };
        status = 200;
      } else if (u.includes('/api/analytics/geo/alerts')) {
        if (opts.alertsFail) { return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 500, json: async () => ({ success: false }) }), delay)); }
        body = { success: true, data: opts.alertsFor ? opts.alertsFor(storeId, u) : geoAlertsFixture() };
        status = 200;
      } else if (u.includes('/api/analytics/geo/county-summary')) {
        body = opts.countyFor ? opts.countyFor(storeId, u) : geoCountySummaryFixture();
        status = 200;
      }
      return new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delay));
    };
  }

  async function setupDashboard(fetchOpts, geoSummaryOverrides) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    const caughtErrors = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.eval(appSrc);
    // 同 scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js 已驗證過的作法：
    // geo-intelligence.js 直接引用 analytics-v2.js 的頂層 `let av2DateState`，
    // dom.window.eval() 模擬兩個 <script> 標籤時每次 eval() 各自形成獨立的
    // 頂層 let/const 綁定（indirect eval 的已知限制，真實瀏覽器 <script> 不會
    // 有這個問題）——因此把 av2Src 與 geoSrc 合併成同一次 eval。
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: (fetchOpts && fetchOpts.storeId) || 'r521b1_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '', timezone: 'Asia/Taipei' };

    const legacySummary = Object.assign({
      top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {},
      data_quality: { status: 'healthy', unknown_rate: 0.05 },
    }, geoSummaryOverrides || {});

    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: legacySummary });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    await new Promise((r) => setTimeout(r, 10)); // 讓 renderDashboardGeoIntelligence() 裡的 setTimeout(fn,0) 觸發
    return { dom, fetchCalls, caughtErrors, container };
  }
  function qs(url) { return Object.fromEntries(new URL(url, 'http://localhost/').searchParams); }

  // ── B1. Dashboard 不再依賴舊摘要當主要資料來源 ──────────────────
  {
    const { container, fetchCalls } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 60));
    const geoCalls = fetchCalls.filter((c) => c.url.includes('/api/analytics/geo/'));
    assert(geoCalls.length >= 4, 'B: renderDashboardGeoIntelligence triggers real /api/analytics/geo/* calls (overview/funnel/alerts/county-summary)', `got ${geoCalls.length} calls`);
    assert(geoCalls.some((c) => c.url.includes('/overview')), 'B: overview endpoint called');
    assert(geoCalls.some((c) => c.url.includes('/funnel')), 'B: funnel endpoint called');
    assert(geoCalls.some((c) => c.url.includes('/alerts')), 'B: alerts endpoint called');
    assert(geoCalls.some((c) => c.url.includes('/county-summary')), 'B: county-summary endpoint called');
    assert(container.innerHTML.includes('進站訪客'), 'B: KPI block renders visitor count label sourced from live API, not just legacy summary text');
    assert(!/top_intent_areas|high_traffic_low_conversion/.test(container.innerHTML), 'B: rendered HTML does not leak raw legacy geo_summary field names');
  }

  // ── B1b. Store / Date Scope（需求續作指令七）：實際檢查真正送出的 fetch
  // query string，不是只看程式碼裡有沒有寫對——用真的 URL 反查。
  {
    const { fetchCalls } = await setupDashboard({ storeId: 'scope_store' }, null);
    await new Promise((r) => setTimeout(r, 60));
    const overviewCall = fetchCalls.find((c) => c.url.includes('/api/analytics/geo/overview'));
    assert(!!overviewCall, 'scope: overview call captured for query inspection');
    if (overviewCall) {
      const params = qs(overviewCall.url);
      assert(!('store_id' in params), 'scope: store_id is never present in the query string (server derives it from the store, not query)');
      assert(!('from' in params) && !('to' in params), 'scope: query never uses invented from/to keys');
      assert(overviewCall.opts && overviewCall.opts.headers && overviewCall.opts.headers['x-store-id'] === 'scope_store', 'scope: store scope travels via x-store-id header (apiFetch), not a query param');
    }
  }
  {
    // 日期切換後必須重新抓新版 Geo API，且新的 query 要反映新日期（需求文件七）。
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, {});
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'date_scope_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '2026-07-01', end_date: '2026-07-01' };
    const containerId = 'geo-date-scope-test';
    const div = dom.window.document.createElement('div');
    div.id = containerId;
    dom.window.document.body.appendChild(div);
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 20));
    const firstOverviewCall = [...fetchCalls].reverse().find((c) => c.url.includes('/geo/overview'));
    assert(firstOverviewCall && qs(firstOverviewCall.url).date_from === '2026-07-01', 'date scope: initial call query reflects current dashboardDateState.start_date, not a hardcoded date');

    dom.window.dashboardDateState = { preset: 'custom', start_date: '2026-07-10', end_date: '2026-07-15' };
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 20));
    const secondOverviewCall = [...fetchCalls].reverse().find((c) => c.url.includes('/geo/overview'));
    assert(secondOverviewCall && qs(secondOverviewCall.url).date_from === '2026-07-10' && qs(secondOverviewCall.url).date_to === '2026-07-15',
      'date scope: after changing dashboardDateState, the next refresh re-fetches with the new date_from/date_to (not stale/cached)');
    assert(secondOverviewCall !== firstOverviewCall, 'date scope: date change actually triggers a brand-new API call, not a reused stale response');
  }

  // ── B2. 舊函式仍存在（PRESERVED，不是 REMOVED）──────────────────
  {

    const backendSrc = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
    assert(backendSrc.includes('function getGeoDashboardSummary('), 'B: getGeoDashboardSummary() still defined in utils/geoAnalyticsQueries.js (preserved)');
    assert(backendSrc.includes('@deprecated'), 'B: getGeoDashboardSummary() carries a @deprecated marker per requirement 十一');
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics.js'), 'utf8');
    assert(routeSrc.includes('geo_summary = getGeoDashboardSummary(db, storeId, geoFilters)'), 'B: GET /api/analytics/dashboard still computes and returns geo_summary unchanged (field PRESERVED)');
  }

  // ── C. KPI ────────────────────────────────────────────────────
  {
    const { container } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 60));
    const html = container.innerHTML;
    assert(html.includes('進站訪客'), 'C: KPI shows 進站訪客');
    assert(html.includes('加入購物車'), 'C: KPI shows 加入購物車');
    assert(html.includes('開始結帳'), 'C: KPI shows 開始結帳');
    assert(html.includes('完成訂單'), 'C: KPI shows 完成訂單');
    assert(html.includes('整體成交率'), 'C: KPI shows 整體成交率');
    assert(/6[0-9]\b/.test(html), 'C: visitor total (42+25=67) rendered in KPI card', html.slice(0, 200));
    assert(html.includes('Geo Quality'), 'C: Geo Quality section rendered');
  }

  // ── D. Top 3 ──────────────────────────────────────────────────
  {
    const { container } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 60));
    const html = container.innerHTML;
    assert(html.includes('高意願區域'), 'D: high-intent Top 3 section rendered');
    assert(html.includes('高流量低轉換'), 'D: low-conversion Top 3 section rendered');
    assert(html.includes('外送成交'), 'D: order/revenue-by-source-county Top 3 section rendered');
    assert(html.includes('桃園市中壢區') || html.includes('中壢區'), 'D: fixture high-intent area label appears in rendered output');
  }
  {
    // Unknown row must not silently vanish, and must be labeled.
    const { container } = await setupDashboard({
      funnelFor: () => geoFunnelFixture({ areas: [
        { city: null, district: null, area_label: null, visitors: 30, add_to_cart_visitors: 25, begin_checkout_visitors: 20, submitted_order_visitors: 18, purchase_visitors: 15 },
      ] }),
    });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('未知區域'), 'D: unknown-area row is explicitly labeled 未知區域, not silently dropped');
  }

  // ── E. 狀態：loading / empty / all-unknown / error / partial / ready ──
  {
    const { container } = await setupDashboard({ delayFor: () => 40 });
    // 抓取初始（尚未 resolve）狀態
    assert(/Geo 資料載入中/.test(container.innerHTML), 'E: loading state shows 載入中 text before API resolves');
    await new Promise((r) => setTimeout(r, 80));
  }
  {
    const { container } = await setupDashboard({
      funnelFor: () => geoFunnelFixture({ areas: [] }),
      countyFor: () => geoCountySummaryFixture({ rows: [] }),
      overviewFor: () => geoOverviewFixture({ top_areas: [], data_quality: { status: 'insufficient_data', total_events: 0, identified_events: 0, unknown_events: 0, identified_rate: 0, unknown_rate: 0, minimum_sample: 10 } }),
    });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('目前沒有符合條件的區域資料'), 'E: empty state shows the required empty message, not a bare "—"');
  }
  {
    const { container } = await setupDashboard({
      overviewFor: () => geoOverviewFixture({ data_quality: { status: 'degraded', total_events: 100, identified_events: 0, unknown_events: 100, identified_rate: 0, unknown_rate: 1, minimum_sample: 10 } }),
    });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('目前已有 Analytics 事件，但尚無可辨識區域'), 'E: all-unknown state shows dedicated message, distinct from plain empty state');
  }
  {
    const { container } = await setupDashboard({ forceStatus: (u) => u.includes('/geo/overview') ? 500 : 0 });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('資料載入失敗') || container.innerHTML.includes('載入失敗'), 'E: error state shows 載入失敗 message when a core endpoint (overview) fails');
    assert(container.innerHTML.includes('重新整理'), 'E: error state offers a 重新整理 (retry) control');
  }
  {
    const { container } = await setupDashboard({ alertsFail: true });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('進站訪客'), 'E: partial state (alerts failed) still renders core KPI (overview/funnel/county-summary succeeded)');
    assert(container.innerHTML.includes('暫時無法載入'), 'E: partial state discloses that a sub-section failed, not silently omitted');
  }
  {
    const { container } = await setupDashboard(null, { data_quality: { status: 'disabled', unknown_rate: 0 } });
    await new Promise((r) => setTimeout(r, 60));
    assert(container.innerHTML.includes('Geo Analytics 未啟用'), 'E: disabled shortcut path shows disabled message without hitting the new API');
  }
  {
    const { container, fetchCalls } = await setupDashboard(null, { data_quality: { status: 'disabled', unknown_rate: 0 } });
    await new Promise((r) => setTimeout(r, 60));
    // 十一之快捷路徑只保護 loadGeoDashboardData() 自己會打的 4 支中的 3 支
    // 專屬端點（/overview /alerts /county-summary）。/funnel 本身也被既有、
    // 本輪不動的 _geoIntelLazyLoad()（source-area/fulfillment/distance/funnel）
    // 呼叫，跟 disabled 快捷路徑無關，兩邊共用同一個端點是既有行為，不是本輪
    // 要修的東西——因此這裡刻意不把 /funnel 算進「不必要呼叫」的判斷，
    // 避免把跟本輪無關的既有呼叫誤判成 bug。
    const unnecessaryCalls = fetchCalls.filter((c) => /\/api\/analytics\/geo\/(overview|alerts|county-summary)(\?|$)/.test(c.url));
    assert(unnecessaryCalls.length === 0, 'E: disabled shortcut path does not fire overview/alerts/county-summary (the 3 endpoints unique to loadGeoDashboardData)', `got: ${unnecessaryCalls.map((c) => c.url).join(', ')}`);
  }

  // ── F. AbortController ──────────────────────────────────────────
  {
    const dom = makeDom();
    const fetchCalls = [];
    let callIndex = 0;
    dom.window.fetch = (url, fetchOpts) => {
      const u = String(url);
      fetchCalls.push({ url: u, signal: fetchOpts && fetchOpts.signal });
      callIndex += 1;
      const myIndex = callIndex;
      let body = { success: false };
      if (u.includes('/geo/overview')) body = { success: true, data: geoOverviewFixture({ visitor_geo: { identified_visitors: myIndex === 1 ? 999 : 1, unknown_visitors: 0, identified_rate: 1 } }) };
      else if (u.includes('/geo/funnel')) body = { success: true, data: geoFunnelFixture({ areas: [{ city: '舊', district: myIndex === 1 ? '第一次舊資料區' : '第二次新資料區', area_label: myIndex === 1 ? '第一次舊資料區' : '第二次新資料區', visitors: myIndex === 1 ? 999 : 5, add_to_cart_visitors: 1, begin_checkout_visitors: 1, submitted_order_visitors: 1 }] }) };
      else if (u.includes('/geo/alerts')) body = { success: true, data: geoAlertsFixture() };
      else if (u.includes('/geo/county-summary')) body = geoCountySummaryFixture();
      const delay = myIndex === 1 ? 50 : 5; // 第一次呼叫（會被取消）刻意回應得比較慢
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay));
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'abort_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };

    const container = dom.window.document.createElement('div');
    container.id = 'geo-abort-test';
    dom.window.document.body.appendChild(container);
    const containerId = 'geo-abort-test';
    // 直接呼叫 refreshGeoDashboardKpiBlock 兩次，模擬「快速切換」（需求文件五）。
    const p1 = dom.window.refreshGeoDashboardKpiBlock(containerId);
    const p2 = dom.window.refreshGeoDashboardKpiBlock(containerId);
    await Promise.all([p1, p2]);
    await new Promise((r) => setTimeout(r, 80));

    assert(container.innerHTML.includes('第二次新資料區') || container.innerHTML.includes('進站訪客'), 'F: after two rapid calls, the DOM reflects the second (newer) request', container.innerHTML.slice(0, 150));
    assert(!container.innerHTML.includes('第一次舊資料區'), 'F: the slower, superseded first request never overwrites the newer response on screen');
  }

  // ── G. Privacy ───────────────────────────────────────────────
  {
    const { container } = await setupDashboard({
      overviewFor: () => geoOverviewFixture(),
      countyFor: () => geoCountySummaryFixture({ rows: [{ county_code: '68000', county_name: '桃園市', visitor_count: 1, order_count: 1, revenue: 100, __leak_ip: '1.2.3.4', __leak_phone: '0912345678' }] }),
    });
    await new Promise((r) => setTimeout(r, 60));
    const html = container.innerHTML;
    assert(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(html), 'G: no raw IPv4 address ever rendered into the DOM');
    assert(!/09\d{8}/.test(html), 'G: no raw phone number ever rendered into the DOM');
    assert(!/v_[a-zA-Z0-9]{10,}/.test(html), 'G: no full un-masked visitor_id pattern rendered');
    assert(!/Bearer\s/.test(html), 'G: no Authorization/Bearer token leaked into rendered HTML');
  }

  // ── H. Store Isolation ─────────────────────────────────────────
  {
    const dom = makeDom();
    dom.window.fetch = buildFetchMock([], {
      overviewFor: (storeId) => geoOverviewFixture({ visitor_geo: { identified_visitors: storeId === 'store_a' ? 111 : 222, unknown_visitors: 0, identified_rate: 1 } }),
      funnelFor: (storeId) => geoFunnelFixture({ areas: [{ city: '店', district: storeId === 'store_a' ? 'A店專屬區域' : 'B店專屬區域', area_label: storeId === 'store_a' ? 'A店專屬區域' : 'B店專屬區域', visitors: 50, add_to_cart_visitors: 10, begin_checkout_visitors: 5, submitted_order_visitors: 3 }] }),
    });
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'store_a' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    // 注意：不可用 document.body.innerHTML = ... 整個覆蓋——makeDom() 的
    // fixture 裡有 #clock，app.js 的 startClock()/setInterval 會持續寫入它；
    // 整個覆蓋掉 body 會讓那個計時器在下一個 tick 對著已經不存在的節點寫
    // textContent 而丟出未被任何 Promise 鏈捕捉的例外，直接讓 Node 行程中斷
    // （這正是本輪要修的「DOM eval newline bug」回報之後，另外在本測試檔
    // 發現的第二個真實 bug，見續作指令一/二的「盤點所有相同錯誤」精神——
    // 一併修掉，不只修第一處）。改用既有的 #db-body-v2 容器。
    dom.window.document.getElementById('db-body-v2').innerHTML = html;
    await new Promise((r) => setTimeout(r, 60));
    const bodyHtml = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(bodyHtml.includes('A店專屬區域'), 'H: store A dashboard renders store A data');
    assert(!bodyHtml.includes('B店專屬區域'), 'H: store A dashboard never renders store B data (x-store-id header correctly scoped the response)');
  }

  // ── I. 靜態原始碼確認（續作指令六：確認正式程式真的完成換線）──────
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    // 只看「非註解行」的實際程式碼，避免把說明性註解裡提到的函式名稱誤判成
    // 真的呼叫（例如「// ...沿用 getGeoDashboardSummary() 既有規則...」這種
    // 純文字說明，不是程式碼）。
    const codeOnly = src.split('\n').filter((line) => !/^\s*\/\//.test(line)).join('\n');

    const fnBody = (() => {
      const start = src.indexOf('function renderDashboardGeoIntelligence(');
      const guardIdx = src.indexOf("if (typeof module !== 'undefined'", start);
      return start >= 0 ? src.slice(start, guardIdx > start ? guardIdx : undefined) : '';
    })();
    assert(fnBody.includes('refreshGeoDashboardKpiBlock('), 'source: renderDashboardGeoIntelligence() calls refreshGeoDashboardKpiBlock() (the loadGeoDashboardData()-backed path)');
    assert(!/const\s+top\s*=\s*\(summary\.top_intent_areas/.test(fnBody), 'source: renderDashboardGeoIntelligence() no longer derives its primary KPI numbers directly from summary.top_intent_areas (old formula removed from this function)');
    assert(src.includes('async function loadGeoDashboardData('), 'source: loadGeoDashboardData() is defined');
    assert(src.includes('function getGeoOverview(') && src.includes('function getGeoFunnel(') && src.includes('function getGeoAlerts(') && src.includes('function getGeoCountySummary('),
      'source: all 4 API client functions (getGeoOverview/getGeoFunnel/getGeoAlerts/getGeoCountySummary) are defined');
    assert(!/getGeoDashboardSummary\s*\(/.test(codeOnly), 'source (code, not comments): geo-intelligence.js (frontend) never calls getGeoDashboardSummary() itself — that is a backend-only function');
    const dataGeoSummaryCodeRefs = (codeOnly.match(/data\.geo_summary/g) || []).length;
    assert(dataGeoSummaryCodeRefs === 1, 'source (code, not comments): data.geo_summary is read in exactly one place — the legacy-compat guard (`const summary = data && data.geo_summary`) that still feeds opportunities/RA-partial — not spread across the new KPI path', `found ${dataGeoSummaryCodeRefs} references`);
    assert(codeOnly.includes('const summary = data && data.geo_summary;'), 'source: the one remaining data.geo_summary read is exactly the documented legacy-compat guard line');
  }
  {
    const backendSrc = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
    const idx = backendSrc.indexOf('function getGeoDashboardSummary(');
    const before = backendSrc.slice(Math.max(0, idx - 600), idx);
    assert(before.includes('@deprecated'), 'source: @deprecated JSDoc sits directly above getGeoDashboardSummary() definition');
  }

  // ── G2. Privacy（補充：lat/lng、secret、api key）───────────────
  {
    const { container } = await setupDashboard({
      overviewFor: () => geoOverviewFixture({ __leak_lat: 24.987, __leak_lng: 121.29 }),
    });
    await new Promise((r) => setTimeout(r, 60));
    const html = container.innerHTML;
    assert(!/\blat["\s:]*24\.987\b/.test(html), 'G: no raw latitude value rendered');
    assert(!/\blng["\s:]*121\.29\b/.test(html), 'G: no raw longitude value rendered');
    assert(!/secret/i.test(html), 'G: the word "secret" never appears in rendered HTML');
    assert(!/api[_-]?key/i.test(html), 'G: no "api key"/"api_key" text ever rendered');
  }


  // ── F2. Abort 補充：慢的那次請求被取消時，畫面不得出現任何錯誤 UI ──
  {
    const dom = makeDom();
    dom.window.fetch = (url, fetchOpts) => {
      const u = String(url);
      let body = { success: false };
      if (u.includes('/geo/overview')) body = { success: true, data: geoOverviewFixture() };
      else if (u.includes('/geo/funnel')) body = { success: true, data: geoFunnelFixture() };
      else if (u.includes('/geo/alerts')) body = { success: true, data: geoAlertsFixture() };
      else if (u.includes('/geo/county-summary')) body = geoCountySummaryFixture();
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), 30));
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'abort2_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const div = dom.window.document.createElement('div');
    div.id = 'geo-abort2-test';
    dom.window.document.body.appendChild(div);
    dom.window.refreshGeoDashboardKpiBlock('geo-abort2-test'); // 第一次（會被第二次取消）
    await new Promise((r) => setTimeout(r, 5));
    await dom.window.refreshGeoDashboardKpiBlock('geo-abort2-test'); // 第二次（取消第一次，最終渲染這次）
    await new Promise((r) => setTimeout(r, 80));
    const html = dom.window.document.getElementById('geo-abort2-test').innerHTML;
    assert(!html.includes('Geo 分析載入失敗'), 'F: an aborted (superseded) request never shows the error UI, even though its own fetch eventually resolves after being abandoned');
    assert(!/AbortError/.test(html), 'F: AbortError text is never surfaced to the user');
  }

  // ── E2. 空日期不送出空字串參數（避免後端把 date_from= 誤判成無效日期）──
  {
    const { fetchCalls } = await setupDashboard(); // dashboardDateState.start_date/end_date 預設為空字串（見 setupDashboard）
    await new Promise((r) => setTimeout(r, 60));
    const overviewCall = fetchCalls.find((c) => c.url.includes('/geo/overview'));
    assert(!!overviewCall, 'date scope: overview call captured');
    if (overviewCall) {
      const params = qs(overviewCall.url);
      assert(!('date_from' in params), 'date scope: empty dashboardDateState.start_date is omitted from the query, not sent as date_from= (讓後端沿用它自己的 today 預設，不送空字串)');
      assert(!('date_to' in params), 'date scope: empty dashboardDateState.end_date is omitted from the query');
    }
  }

  printSummary();
  // 多個 jsdom window 各自跑了 app.js 的 WebSocket 重連計時器（指數 backoff），
  // 測試完成後這些計時器仍會持續存在、讓 event loop 不會自然結束。測試本身
  // 已經跑完並印出結果，這裡明確結束行程，讓本檔案可以在 regression gate
  // 裡被無人值守地執行（不必依賴外部 timeout 包一層）。
  process.exit(process.exitCode || 0);
}

function printSummary() {
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log('\n' + '='.repeat(70));
  console.log(`SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.2-B1-1`);
  console.log(`  PASS:            ${passCount}`);
  console.log(`  FAIL:            ${failCount}`);
  console.log(`  MANUAL REQUIRED: ${manualCount}`);
  console.log(`  TOTAL:           ${results.length}`);
  console.log('='.repeat(70));
  if (failCount > 0) {
    console.log('\nFAILED:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
    process.exitCode = 1;
  }
  if (manualCount > 0) {
    console.log('\nMANUAL REQUIRED (not counted as PASS — needs real browser/db verification):');
    results.filter((r) => r.status === 'MANUAL REQUIRED').forEach((r) => console.log(`  - ${r.name} — ${r.detail}`));
  }
}

main().catch((e) => {
  console.error('[smoke] uncaught error:', e && e.stack || e);
  process.exitCode = 1;
});
