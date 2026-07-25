#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-2-area-ranking.js
// fix18-10-hotfix30-B5-R5.2-B1-2：行政區排行榜 + 區域 Funnel + Drill Down
//
// 沿用 scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js 已驗證過的
// 慣例：Part A 純函式單元測試（直接 require，不需要 jsdom）；Part B 是
// jsdom 實測（真的執行 app.js + analytics-v2.js + geo-intelligence.js）。
// jsdom 未安裝時 Part B 全部標記 MANUAL REQUIRED，不假裝 PASS。

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
  // Part A：純函式單元測試（排序／搜尋／分頁，不需要 jsdom）
  // ══════════════════════════════════════════════════════════════
  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  const fixtureAreas = () => ([
    { city: '桃園市', district: '中壢區', area_label: '桃園市中壢區', visitors: 50, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 10 },
    { city: '桃園市', district: '八德區', area_label: '桃園市八德區', visitors: 30, add_to_cart_visitors: 5, begin_checkout_visitors: 2, submitted_order_visitors: 1 },
    { city: '新北市', district: '板橋區', area_label: '新北市板橋區', visitors: 80, add_to_cart_visitors: 40, begin_checkout_visitors: 30, submitted_order_visitors: 25 },
    { city: null, district: null, visitors: 99999, add_to_cart_visitors: 99999, begin_checkout_visitors: 99999, submitted_order_visitors: 99999 }, // unknown 刻意給最大值，驗證仍排最後
  ]);

  // ── A1. 排序：訪客/加購/結帳/完成訂單/成交率，Unknown 永遠最後 ──
  {
    const sorted = RE._geoSortAreas(fixtureAreas(), 'visitors', 'desc');
    assert(sorted[0].district === '板橋區', 'sort: visitors desc — highest known area first');
    assert(RE._geoIsUnknownArea(sorted[sorted.length - 1]), 'sort: unknown area is last even though it has the largest raw numbers');
  }
  {
    const sorted = RE._geoSortAreas(fixtureAreas(), 'visitors', 'asc');
    assert(sorted[0].district === '八德區', 'sort: visitors asc — lowest known area first');
    assert(RE._geoIsUnknownArea(sorted[sorted.length - 1]), 'sort: unknown area still last under ascending order (not first)');
  }
  {
    const sorted = RE._geoSortAreas(fixtureAreas(), 'cart', 'desc');
    assert(sorted[0].district === '板橋區', 'sort: add_to_cart_visitors desc correct');
  }
  {
    const sorted = RE._geoSortAreas(fixtureAreas(), 'checkout', 'desc');
    assert(sorted[0].district === '板橋區', 'sort: begin_checkout_visitors desc correct');
  }
  {
    const sorted = RE._geoSortAreas(fixtureAreas(), 'orders', 'desc');
    assert(sorted[0].district === '板橋區', 'sort: submitted_order_visitors desc correct');
  }
  {
    const areas = [
      { city: 'A', district: 'X', visitors: 100, submitted_order_visitors: 10 }, // rate 0.1
      { city: 'A', district: 'Y', visitors: 50, submitted_order_visitors: 25 },  // rate 0.5
    ];
    const sorted = RE._geoSortAreas(areas, 'conversion', 'desc');
    assert(sorted[0].district === 'Y', 'sort: conversion rate desc uses submitted/visitors, not raw counts');
  }
  assert(RE._geoSortAreas([], 'visitors', 'desc').length === 0, 'sort: empty array -> empty array, no throw');

  // ── A2. 搜尋：依 area_label 子字串比對 ──
  {
    const found = RE._geoFilterAreasBySearch(fixtureAreas(), '中壢');
    assert(found.length === 1 && found[0].district === '中壢區', 'search: "中壢" matches 中壢區 only');
  }
  assert(RE._geoFilterAreasBySearch(fixtureAreas(), '').length === 4, 'search: empty query returns all areas unfiltered');
  assert(RE._geoFilterAreasBySearch(fixtureAreas(), '   ').length === 4, 'search: whitespace-only query treated as empty');
  assert(RE._geoFilterAreasBySearch(fixtureAreas(), '不存在的區').length === 0, 'search: no match -> empty array, not an error');
  assert(RE._geoFilterAreasBySearch(null, '中壢').length === 0, 'search: null areas -> empty array, no throw');

  // ── A3. Unknown 判斷與 Key/Label ──
  assert(RE._geoIsUnknownArea({ city: null, district: null }) === true, 'unknown check: both null -> unknown');
  assert(RE._geoIsUnknownArea({ city: '桃園市', district: null }) === false, 'unknown check: city present -> not unknown');
  assert(RE._geoAreaLabel({ area_label: '桃園市中壢區' }) === '桃園市中壢區', 'label: prefers area_label field');
  assert(RE._geoAreaLabel({ city: '桃園市', district: '中壢區' }) === '中壢區', 'label: falls back to district when area_label absent');
  assert(RE._geoAreaLabel({ city: null, district: null }) === '未知區域', 'label: unknown area labeled 未知區域, never blank');
  assert(RE._geoAreaKey({ area_key: 'k1' }) === 'k1', 'key: prefers area_key field');
  assert(RE._geoAreaKey({ city: '桃園市', district: '中壢區' }) === '桃園市|中壢區', 'key: falls back to city|district composite');
  assert(RE._geoAreaKey(null) === '', 'key: null area -> empty string, no throw');

  // ── A4. 分頁：>20 筆才需要，逐頁正確切片 ──
  {
    const manyAreas = Array.from({ length: 45 }, (_, i) => ({ city: 'C', district: `D${i}`, visitors: 45 - i, add_to_cart_visitors: 1, begin_checkout_visitors: 1, submitted_order_visitors: 1 }));
    const page1 = RE.computeGeoAreaRanking({ funnel: { areas: manyAreas } }, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 });
    assert(page1.rows.length === RE.GEO_RANKING_PAGE_SIZE, `pagination: page 1 has exactly ${RE.GEO_RANKING_PAGE_SIZE} rows`);
    assert(page1.total === 45, 'pagination: total reflects full filtered/sorted set, not just current page');
    assert(page1.totalPages === 3, 'pagination: 45 rows at 20/page -> 3 pages');
    assert(page1.rows[0].district === 'D0', 'pagination: page 1 starts with the highest-visitors row (D0=45)');
    const page3 = RE.computeGeoAreaRanking({ funnel: { areas: manyAreas } }, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 3 });
    assert(page3.rows.length === 5, 'pagination: last page has the remainder (45 - 40 = 5 rows)');
    const pageOverflow = RE.computeGeoAreaRanking({ funnel: { areas: manyAreas } }, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 99 });
    assert(pageOverflow.page === 3, 'pagination: requesting a page beyond totalPages clamps to the last valid page, does not crash or return empty');
  }
  {
    const fewAreas = fixtureAreas(); // 4 筆，< 20
    const ranking = RE.computeGeoAreaRanking({ funnel: { areas: fewAreas } }, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 });
    assert(ranking.totalPages === 1, 'pagination: fewer than page-size rows -> exactly 1 page');
  }
  assert(RE.computeGeoAreaRanking({ funnel: null }, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 }).total === 0, 'pagination: null funnel -> zero total, no throw');

  // ── A5. 排行榜+搜尋+排序 組合 ──
  {
    const areas = [
      { city: '桃園市', district: '中壢區', visitors: 10, submitted_order_visitors: 1 },
      { city: '桃園市', district: '中原區', visitors: 20, submitted_order_visitors: 2 }, // 也含"中" 字方便測試部分比對不誤傷
    ];
    const ranking = RE.computeGeoAreaRanking({ funnel: { areas } }, { sortKey: 'visitors', sortDir: 'asc', search: '中', page: 1 });
    assert(ranking.total === 2, 'combined: search narrows to matching areas before sort/paginate');
    assert(ranking.rows[0].district === '中壢區', 'combined: sort still applies after search filter (asc -> 中壢區 first)');
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測
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
  const geoSrc = geoSrcRaw.replace(/'use strict';\s*\n/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="db-body-v2"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  function geoOverviewFixture(overrides) {
    return Object.assign({
      visitor_geo: { identified_visitors: 160, unknown_visitors: 15, identified_rate: 0.914 },
      fulfillment_geo: { orders_with_geo: 30, orders_without_geo: 2, average_distance_km: 3.2, average_delivery_fee: 45 },
      top_areas: [{ city: '桃園市', district: '中壢區', visitors: 42 }],
      data_quality: { status: 'healthy', total_events: 300, identified_events: 285, unknown_events: 15, identified_rate: 0.95, unknown_rate: 0.05, minimum_sample: 10 },
    }, overrides || {});
  }
  function bigFunnelAreas(storeId) {
    // 22 筆有名有姓的行政區（觸發分頁）+ 1 筆 unknown，數字依 storeId 微調以便驗證 Store Isolation。
    const mul = storeId === 'store_b' ? 2 : 1;
    const named = Array.from({ length: 22 }, (_, i) => ({
      city: '桃園市', district: `第${i}區`, area_label: `桃園市第${i}區`,
      visitors: (100 - i) * mul, add_to_cart_visitors: (50 - i) * mul, begin_checkout_visitors: (20 - i) * mul, submitted_order_visitors: (10 - i) * mul, purchase_visitors: (8 - i) * mul,
    }));
    named.push({ city: null, district: null, visitors: 5, add_to_cart_visitors: 1, begin_checkout_visitors: 0, submitted_order_visitors: 0, purchase_visitors: 0 });
    return named;
  }
  function geoFunnelFixture(overrides, storeId) {
    return Object.assign({ page: 1, limit: 100, areas: bigFunnelAreas(storeId) }, overrides || {});
  }
  function geoAlertsFixture(overrides) {
    return Object.assign({ alerts: [
      { type: 'traffic_waste', severity: 'warning', geo_context: 'acquisition', city: '桃園市', district: '第1區', area_label: '桃園市第1區', message: '第1區進站流量不低，但幾乎沒有送出訂單', suggestion: '建議檢查此區域的廣告受眾設定', metrics: {} },
    ], rule_thresholds: {} }, overrides || {});
  }
  function geoCountySummaryFixture(overrides) {
    return Object.assign({ ok: true, rows: [
      { county_code: '68000', county_name: '桃園市', visitor_count: 67, order_count: 12, revenue: 9000 },
    ], unknown: { visitor_count: 5, percentage: 6.9 } }, overrides || {});
  }
  function adminAreasFixture(countyCode) {
    if (countyCode === '68000') {
      return { ok: true, county: { county_code: '68000', county_name: '桃園市' }, subdivisions: [
        { subdivision_code: '68000010', subdivision_name: '中壢區', subdivision_type: 'district', area_key: '68000|68000010', area_label: '桃園市－中壢區' },
        { subdivision_code: '68000020', subdivision_name: '八德區', subdivision_type: 'district', area_key: '68000|68000020', area_label: '桃園市－八德區' },
      ] };
    }
    return { ok: true, manifest: { county_count: 22, subdivision_count: 368, source_version: 'test', checksum: 'x' }, counties: [
      { county_code: '68000', county_name: '桃園市', subdivision_count: 13 },
      { county_code: '65000', county_name: '新北市', subdivision_count: 29 },
    ] };
  }

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url, fetchOpts) => {
      const u = String(url);
      fetchCalls.push({ url: u, opts: fetchOpts });
      const headers = (fetchOpts && fetchOpts.headers) || {};
      const storeId = headers['x-store-id'];
      let body = { success: false };
      let status = 404;
      const delay = opts.delayFor ? opts.delayFor(u, storeId) : 0;

      if (opts.forceStatus && opts.forceStatus(u)) {
        return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: opts.forceStatus(u), json: async () => ({ success: false, error: 'forced' }) }), delay));
      }
      if (u.includes('/api/analytics/geo/overview')) {
        body = { success: true, data: opts.overviewFor ? opts.overviewFor(storeId, u) : geoOverviewFixture() };
        status = 200;
      } else if (u.includes('/api/analytics/geo/funnel')) {
        body = { success: true, data: opts.funnelFor ? opts.funnelFor(storeId, u) : geoFunnelFixture(null, storeId) };
        status = 200;
      } else if (u.includes('/api/analytics/geo/alerts')) {
        if (opts.alertsFail) { return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 500, json: async () => ({ success: false }) }), delay)); }
        body = { success: true, data: opts.alertsFor ? opts.alertsFor(storeId, u) : geoAlertsFixture() };
        status = 200;
      } else if (u.includes('/api/analytics/geo/county-summary')) {
        if (opts.countyFail) { return new Promise((resolve) => setTimeout(() => resolve({ ok: false, status: 500, json: async () => ({ ok: false }) }), delay)); }
        body = opts.countyFor ? opts.countyFor(storeId, u) : geoCountySummaryFixture();
        status = 200;
      } else if (u.includes('/api/analytics/geo/administrative-areas')) {
        const qp = new URL(u, 'http://localhost/').searchParams;
        body = opts.adminAreasFor ? opts.adminAreasFor(qp.get('county_code')) : adminAreasFixture(qp.get('county_code'));
        status = 200;
      }
      return new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delay));
    };
  }

  // 不用猜測的固定 setTimeout 等待非同步渲染完成——改成輪詢真正的完成訊號
  // （容器不再顯示「Geo 資料載入中」骨架），最多等 maxMs。整個 suite 累積
  // 十幾個 jsdom window 之後，真實 resolve 時間會變動，靠猜測的固定延遲
  // 本身就是不穩定測試的根因。
  async function waitForGeoReady(getHtml, maxMs = 2000, stepMs = 5) {
    const start = Date.now();
    while (Date.now() - start < maxMs) {
      const html = getHtml();
      if (!/Geo 資料載入中/.test(html)) return html;
      await new Promise((r) => setTimeout(r, stepMs));
    }
    return getHtml(); // 逾時也回傳目前畫面，讓斷言用真實（可能仍在載入）內容失敗，而不是無限等待
  }

  async function setupDashboard(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    const caughtErrors = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: (fetchOpts && fetchOpts.storeId) || 'r522b12_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    // 註：不需要在這裡手動重設 geoDashboardFilters/geoRankingState 等——每次
    // makeDom() 都是全新的 jsdom window，該 window 自己 eval 出來的頂層 let
    // 狀態本來就是乾淨的初始值，render 時也會透過 _geoExposeWindowState()
    // 自動把真正的內部狀態掛到 window 上（見 geo-intelligence.js）。

    const legacySummary = { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: legacySummary });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    await waitForGeoReady(() => container.innerHTML);
    return { dom, fetchCalls, caughtErrors, container };
  }
  function qs(url) { return Object.fromEntries(new URL(url, 'http://localhost/').searchParams); }

  // ── B1. 行政區排行榜：欄位、資料來源 ──
  {
    const { container } = await setupDashboard();
    const html = container.innerHTML;
    assert(html.includes('行政區排行榜'), 'ranking: section heading rendered');
    assert(html.includes('桃園市第0區'), 'ranking: highest-visitor area (第0區) rendered on page 1');
    assert(html.includes('未知區域'), 'ranking: unknown row shown and labeled 未知區域, not silently dropped');
  }

  // ── B2. 排序 ──
  {
    const { dom, container } = await setupDashboard();
    // 找到「加入購物車」欄位表頭並點擊觸發排序
    const sortButtons = Array.from(dom.window.document.querySelectorAll('th[role="columnheader"]'));
    assert(sortButtons.length === 5, 'sort: 5 sortable column headers rendered (visitors/cart/checkout/orders/conversion)');
    dom.window.geoRankingSetSort('orders');
    await new Promise((r) => setTimeout(r, 5));
    const afterSort = container.innerHTML;
    const idx0 = afterSort.indexOf('第0區');
    const idx1 = afterSort.indexOf('第1區');
    assert(idx0 !== -1 && idx1 !== -1 && idx0 < idx1, 'sort: sorting by orders desc still puts 第0區 (highest orders) before 第1區');
    dom.window.geoRankingSetSort('orders'); // 再點一次同一欄 -> 反轉方向
    await new Promise((r) => setTimeout(r, 5));
    assert(dom.window.geoRankingState.sortDir === 'asc', 'sort: clicking the same column twice toggles direction (desc -> asc)');
  }

  // ── B3. 搜尋（純前端，不重新 fetch）──
  {
    const { dom, container, fetchCalls } = await setupDashboard();
    const callsBefore = fetchCalls.length;
    dom.window.geoRankingSetSearch('第0');
    await new Promise((r) => setTimeout(r, 5));
    const callsAfter = fetchCalls.length;
    assert(callsAfter === callsBefore, 'search: typing in the search box triggers NO new network request (client-side only, per requirement)');
    const html = container.innerHTML;
    assert(html.includes('第0區') && !html.includes('第5區'), 'search: only matching areas remain visible after search');
  }

  // ── B4. 分頁 ──
  {
    const { dom, container } = await setupDashboard();
    assert(container.innerHTML.includes('上一頁') && container.innerHTML.includes('下一頁'), 'pagination: controls rendered when >20 areas');
    assert(container.innerHTML.includes('第 1 頁'), 'pagination: starts on page 1');
    const callsBefore = 1; // sentinel, real check below is on fetchCalls length via closure
  }
  {
    const { dom, container, fetchCalls } = await setupDashboard();
    const before = fetchCalls.length;
    dom.window.geoRankingSetPage(2);
    await new Promise((r) => setTimeout(r, 5));
    assert(fetchCalls.length === before, 'pagination: changing page triggers NO new network request (client-side slice of already-loaded funnel.areas)');
    assert(container.innerHTML.includes('第 2 頁'), 'pagination: page 2 renders after clicking 下一頁-equivalent action');
  }

  // ── B5. 區域 Funnel 展開／收合 ──
  {
    const { dom, container } = await setupDashboard();
    assert(!container.innerHTML.includes('aria-expanded="true"'), 'funnel expand: collapsed by default (no row has aria-expanded="true")');
    const area0Key = '桃園市|第0區';
    dom.window.geoRankingToggleExpand(area0Key);
    await new Promise((r) => setTimeout(r, 5));
    const expandedHtml = container.innerHTML;
    assert(expandedHtml.includes('aria-expanded="true"'), 'funnel expand: expanding a row sets aria-expanded="true" on its toggle button');
    assert(/訪客[\s\S]*加入購物車[\s\S]*開始結帳[\s\S]*完成訂單/.test(expandedHtml), 'funnel expand: steps appear in the correct order (visitor -> cart -> checkout -> order)');
    dom.window.geoRankingToggleExpand(area0Key); // 收合
    await new Promise((r) => setTimeout(r, 5));
    assert(!container.innerHTML.includes('aria-expanded="true"'), 'funnel expand: toggling again collapses the row (back to aria-expanded="false")');
  }

  // ── B6. Drill Down Drawer ──
  {
    const { dom, fetchCalls } = await setupDashboard();
    const before = fetchCalls.length;
    dom.window.geoAreaDrawerOpen('桃園市|第0區');
    await new Promise((r) => setTimeout(r, 5));
    assert(fetchCalls.length === before, 'drawer: opening drill-down triggers NO new network request (uses already-loaded data)');
    const el = dom.window.document.querySelector('.geo-area-drawer');
    assert(!!el, 'drawer: opens and renders a .geo-area-drawer element');
    assert(el.innerHTML.includes('第0區'), 'drawer: shows the correct area label');
    assert(/訪客|加入購物車|開始結帳|完成訂單|成交率/.test(el.innerHTML), 'drawer: shows visitor/cart/checkout/order/conversion detail fields');
    assert(el.innerHTML.includes('Geo Quality'), 'drawer: includes Geo Quality info block');
    dom.window.geoAreaDrawerClose();
    await new Promise((r) => setTimeout(r, 5));
    assert(!dom.window.document.querySelector('.geo-area-drawer'), 'drawer: closes and removes the drawer element');
  }
  {
    // ESC 關閉
    const { dom } = await setupDashboard();
    dom.window.geoAreaDrawerOpen('桃園市|第0區');
    await new Promise((r) => setTimeout(r, 5));
    assert(!!dom.window.document.querySelector('.geo-area-drawer'), 'drawer ESC: drawer open before ESC');
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 5));
    assert(!dom.window.document.querySelector('.geo-area-drawer'), 'drawer ESC: Escape key closes the drawer');
  }
  {
    // ESC listener 只註冊一次（開關 30 次不應該疊加 30 個 listener）
    const { dom } = await setupDashboard();
    let threw = false;
    try {
      for (let i = 0; i < 30; i++) {
        dom.window.geoAreaDrawerOpen('桃園市|第0區');
        dom.window.geoAreaDrawerClose();
      }
    } catch (e) { threw = true; }
    await new Promise((r) => setTimeout(r, 5));
    assert(!threw, 'drawer memory: 30x open/close cycles does not throw');
  }

  // ── B7. 雙層縣市／行政區篩選 + Dashboard 同步 ──
  {
    const { dom, container, fetchCalls } = await setupDashboard();
    const beforeSwitch = fetchCalls.length;
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 30));
    const afterSwitch = fetchCalls.length;
    assert(afterSwitch > beforeSwitch, 'county filter: switching county triggers a real refetch (loadGeoDashboardData again)');
    const overviewCalls = fetchCalls.filter((c) => c.url.includes('/geo/overview'));
    const lastOverview = overviewCalls[overviewCalls.length - 1];
    assert(lastOverview && qs(lastOverview.url).county_code === '68000', 'county filter: the refetch actually includes county_code=68000 in the query');
    // Dashboard 同步：KPI、Top3 都應該還在（用同一次 render 產生，不是分開兩套）。
    const html = container.innerHTML;
    assert(html.includes('進站訪客') && html.includes('高意願區域'), 'county filter (Dashboard sync): KPI and Top3 sections still render after switching county — same render call, not a separate mechanism');
  }
  {
    // 縣市變更 -> 清除不相容的行政區篩選
    const { dom } = await setupDashboard();
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 30));
    await dom.window.geoDashboardSetSubdivision('68000010');
    await new Promise((r) => setTimeout(r, 30));
    assert(dom.window.geoDashboardFilters.subdivision_code === '68000010', 'subdivision filter: selecting a subdivision sets the filter');
    await dom.window.geoDashboardSetCounty('65000');
    await new Promise((r) => setTimeout(r, 30));
    assert(dom.window.geoDashboardFilters.subdivision_code === null, 'county filter: changing county clears the now-incompatible subdivision filter');
  }
  {
    // 兩層下拉選單本身：縣市清單來自 /administrative-areas
    const { dom, fetchCalls } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 30));
    const adminCalls = fetchCalls.filter((c) => c.url.includes('/administrative-areas'));
    assert(adminCalls.length >= 1, 'admin areas: /administrative-areas is called to populate the county dropdown');
    assert(dom.window.geoAdminAreasCache && dom.window.geoAdminAreasCache.counties.some((c) => c.county_name === '桃園市'), 'admin areas: county list cached with real county names, not hardcoded');
  }

  // ── B8. Top3 不得另外維護第二份（共用同一份 funnel 資料）──
  {
    const { dom } = await setupDashboard();
    const kpiTops = RE.computeGeoTopAreas(dom.window.geoLastVm);
    const ranking = RE.computeGeoAreaRanking(dom.window.geoLastVm, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 });
    assert(kpiTops.high_intent[0].area_label === ranking.rows[0].area_label, 'top3 dedup: Top 3 high-intent area and ranking table\'s #1 row come from the same underlying funnel.areas, not two separately-maintained datasets');
  }

  // ── B9. Loading / Empty / Partial / Error ──
  {
    // setupDashboard() 現在會輪詢到「不是 loading」才回傳（見上方
    // waitForGeoReady()），沒辦法再用它來觀察轉瞬即逝的 loading 狀態——這裡
    // 手動重現同一段初始化，但刻意「不等」非同步載入完成，只檢查
    // renderDashboardGeoIntelligence() 同步回傳、掛進 DOM 那一刻的畫面
    // （此時 KPI 容器必然還是初始骨架，因為驅動載入的 setTimeout(fn,0)
    // 連一次 macrotask 都還沒輪到）。
    const dom = makeDom();
    dom.window.fetch = buildFetchMock([], { delayFor: () => 40 });
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'loading_probe_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const legacySummary = { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: legacySummary });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    assert(/Geo 資料載入中/.test(container.innerHTML), 'loading: shows loading text before API resolves');
  }
  {
    const { container } = await setupDashboard({
      funnelFor: () => geoFunnelFixture({ areas: [] }),
      countyFor: () => geoCountySummaryFixture({ rows: [] }),
      overviewFor: () => geoOverviewFixture({ data_quality: { status: 'insufficient_data', total_events: 0, identified_events: 0, unknown_events: 0, identified_rate: 0, unknown_rate: 0, minimum_sample: 10 } }),
    });
    await new Promise((r) => setTimeout(r, 30));
    assert(container.innerHTML.includes('目前沒有符合條件的區域資料'), 'empty: whole dashboard block shows empty message when there is truly no data');
  }
  {
    const { container } = await setupDashboard({ countyFail: true });
    await new Promise((r) => setTimeout(r, 30));
    assert(container.innerHTML.includes('行政區排行榜暫時無法載入'), 'partial: county-summary failing shows "行政區排行榜暫時無法載入" for the ranking section specifically');
    assert(container.innerHTML.includes('進站訪客'), 'partial: Dashboard KPI still renders normally even though the ranking table is degraded');
  }
  {
    const { container } = await setupDashboard({ forceStatus: (u) => u.includes('/geo/overview') ? 500 : 0 });
    await new Promise((r) => setTimeout(r, 30));
    assert(container.innerHTML.includes('Geo 分析載入失敗'), 'error: only overview (required) failing produces the fatal whole-block error, per requirement 十六');
  }
  {
    const { container } = await setupDashboard({ forceStatus: (u) => u.includes('/geo/funnel') ? 500 : 0 });
    await new Promise((r) => setTimeout(r, 30));
    assert(container.innerHTML.includes('Geo 分析載入失敗'), 'error: funnel (also required) failing likewise produces the fatal whole-block error');
  }

  // ── B10. Unknown 顯示但不排第一 ──
  {
    const { dom } = await setupDashboard();
    const ranking = RE.computeGeoAreaRanking(dom.window.geoLastVm, { sortKey: 'visitors', sortDir: 'desc', search: '', page: 1 });
    assert(!RE._geoIsUnknownArea(ranking.rows[0]), 'unknown ordering: row #1 of the ranking table (sorted desc) is never the unknown row');
  }

  // ── B11. Store Isolation ──
  {
    const { dom: domA } = await setupDashboard({ storeId: 'store_a' });
    const { dom: domB } = await setupDashboard({ storeId: 'store_b' });
    const bodyA = domA.window.document.getElementById('db-body-v2').innerHTML;
    const bodyB = domB.window.document.getElementById('db-body-v2').innerHTML;
    assert(bodyA.includes('第0區') && bodyB.includes('第0區'), 'store isolation: both stores render their own area rows (sanity)');
    // store_b 的 funnel fixture visitors 數字是 store_a 的兩倍（mul=2），兩邊 KPI 加總必須不同。
    const kpiA = RE.computeGeoDashboardKpi(domA.window.geoLastVm);
    const kpiB = RE.computeGeoDashboardKpi(domB.window.geoLastVm);
    assert(kpiA.visitors !== kpiB.visitors, 'store isolation: KPI totals differ between stores (store B\'s response never bleeds into store A\'s render)');
  }
  {
    // Abort + Store 切換：慢的舊 store 回應不可覆蓋新 store 畫面。
    const dom = makeDom();
    let callIndex = 0;
    dom.window.fetch = (url, fetchOpts) => {
      callIndex += 1;
      const myIndex = callIndex;
      const u = String(url);
      let body = { success: false };
      if (u.includes('/geo/overview')) body = { success: true, data: geoOverviewFixture() };
      else if (u.includes('/geo/funnel')) body = { success: true, data: { page: 1, limit: 100, areas: [{ city: '店', district: myIndex === 1 ? '舊店資料' : '新店資料', area_label: myIndex === 1 ? '舊店資料' : '新店資料', visitors: 10, add_to_cart_visitors: 1, begin_checkout_visitors: 1, submitted_order_visitors: 1 }] } };
      else if (u.includes('/geo/alerts')) body = { success: true, data: geoAlertsFixture() };
      else if (u.includes('/geo/county-summary')) body = geoCountySummaryFixture();
      else if (u.includes('/administrative-areas')) body = adminAreasFixture(null);
      const delay = myIndex <= 4 ? 60 : 5; // 第一輪（4 支請求，會被取消）刻意慢
      return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay));
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'store_old' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const div = dom.window.document.createElement('div');
    div.id = 'store-switch-test';
    dom.window.document.body.appendChild(div);
    dom.window.refreshGeoDashboardKpiBlock('store-switch-test'); // 舊店（慢）
    await new Promise((r) => setTimeout(r, 5));
    dom.window.currentStore = { store_id: 'store_new' };
    await dom.window.refreshGeoDashboardKpiBlock('store-switch-test'); // 新店（快，應該取消舊的）
    await new Promise((r) => setTimeout(r, 80));
    const html = dom.window.document.getElementById('store-switch-test').innerHTML;
    assert(!html.includes('舊店資料'), 'store isolation + abort: switching store cancels the slower old-store request; it never overwrites the new store\'s view');
  }

  // ── B12. Privacy ──
  {
    const { container } = await setupDashboard({
      overviewFor: () => geoOverviewFixture({ __leak_ip: '8.8.8.8' }),
      funnelFor: () => geoFunnelFixture({ areas: [{ city: '桃園市', district: '中壢區', area_label: '桃園市中壢區', visitors: 10, add_to_cart_visitors: 1, begin_checkout_visitors: 1, submitted_order_visitors: 1, __leak_visitor_id: 'v_1234567890abcdefg', __leak_phone: '0912345678', __leak_name: '王小明' }] }),
    });
    await new Promise((r) => setTimeout(r, 30));
    const html = container.innerHTML;
    assert(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(html), 'privacy: no raw IPv4 rendered in ranking/drawer output');
    assert(!/v_[a-zA-Z0-9]{10,}/.test(html), 'privacy: no full un-masked visitor_id pattern rendered');
    assert(!/09\d{8}/.test(html), 'privacy: no raw phone number rendered');
    assert(!/Bearer\s/.test(html), 'privacy: no Authorization/Bearer token leaked');
    assert(!/lat["\s:]/i.test(html) && !/lng["\s:]/i.test(html), 'privacy: no raw lat/lng fields rendered');
    assert(!/token/i.test(html) && !/secret/i.test(html) && !/api[_-]?key/i.test(html), 'privacy: no token/secret/api key text rendered');
  }

  // ── B13. 排序：明確測 asc 與 desc 兩個方向都對 ──
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetSort('visitors'); // 目前預設就是 visitors desc，再點一次 -> asc
    await new Promise((r) => setTimeout(r, 5));
    const ascHtml = container.innerHTML;
    // 22 個已知區域＋分頁 20 筆/頁：升冪時 page 1 顯示 visitors 最低的 20 筆
    // （第21區..第2區），第0區／第1區（visitors 最高）反而在 page 2，不會
    // 同時出現在同一頁——因此比較「都保證落在 page 1」的一對：第21區
    // （最低）應該排在第20區之前。
    const idxLow = ascHtml.indexOf('第21區');
    const idxHigh = ascHtml.indexOf('第20區');
    assert(idxLow !== -1 && idxHigh !== -1 && idxLow < idxHigh, 'sort asc: ascending order puts the lowest-visitors known area before a higher one (within the same page)');
    dom.window.geoRankingSetSort('visitors'); // 再點一次 -> desc
    await new Promise((r) => setTimeout(r, 5));
    const descHtml = container.innerHTML;
    assert(descHtml.indexOf('第0區') < descHtml.indexOf('第1區'), 'sort desc: descending order restores highest-visitors area first');
  }

  // ── B14. 搜尋：空搜尋／查無結果 ──
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetSearch('第0');
    await new Promise((r) => setTimeout(r, 5));
    assert(container.innerHTML.includes('第0區'), 'search: narrows results first (sanity before clearing)');
    dom.window.geoRankingSetSearch('');
    await new Promise((r) => setTimeout(r, 5));
    assert(container.innerHTML.includes('第0區') && container.innerHTML.includes('第10區'), 'search: clearing the search box restores the full unfiltered list');
  }
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetSearch('這個行政區不存在xyz');
    await new Promise((r) => setTimeout(r, 5));
    assert(container.innerHTML.includes('目前沒有符合條件的行政區資料'), 'search: no-result query shows the empty-ranking message, not a blank/broken table');
  }

  // ── B15. 分頁邊界 ──
  {
    const { dom, container } = await setupDashboard();
    assert(container.innerHTML.includes('disabled') , 'pagination boundary: page 1\'s "上一頁" button is disabled (sanity: disabled attribute exists somewhere on page 1)');
    const page1Html = container.innerHTML;
    const prevBtnDisabled = /上一頁[^<]*<\/button>/.test(page1Html) || /disabled[^>]*>\s*上一頁/.test(page1Html) || /上一頁[\s\S]{0,0}/.test(page1Html);
    // 更精確：直接找上一頁按鈕的 disabled 屬性緊鄰在前
    assert(/disabled[^>]*>上一頁/.test(page1Html), 'pagination boundary: 上一頁 button carries the disabled attribute on page 1');
    dom.window.geoRankingSetPage(2);
    await new Promise((r) => setTimeout(r, 5));
    assert(!/disabled[^>]*>上一頁/.test(container.innerHTML), 'pagination boundary: 上一頁 button is enabled once past page 1');
    dom.window.geoRankingSetPage(999); // 超過總頁數
    await new Promise((r) => setTimeout(r, 5));
    assert(/disabled[^>]*>下一頁/.test(container.innerHTML), 'pagination boundary: 下一頁 button becomes disabled once clamped to the last page');
  }

  // ── B16. Admin Areas Cache：delta 計數，scope 明確 ──
  {
    const { dom, fetchCalls } = await setupDashboard();
    const countAdmin = () => fetchCalls.filter((c) => c.url.includes('/administrative-areas')).length;
    const before = countAdmin();
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    const afterFirst = countAdmin();
    assert(afterFirst - before === 1, 'admin cache: selecting a county for the first time fetches subdivisions exactly once (delta === 1)', `before=${before} afterFirst=${afterFirst}`);
    await dom.window.geoDashboardSetCounty('68000'); // 再選一次同一個縣市
    await new Promise((r) => setTimeout(r, 20));
    const afterSecond = countAdmin();
    assert(afterSecond - afterFirst === 0, 'admin cache: re-selecting the SAME county does not refetch its subdivisions (delta === 0, cached)', `afterFirst=${afterFirst} afterSecond=${afterSecond}`);
    await dom.window.geoDashboardSetCounty('65000'); // 換一個不同縣市
    await new Promise((r) => setTimeout(r, 20));
    const afterThird = countAdmin();
    assert(afterThird - afterSecond === 1, 'admin cache: switching to a DIFFERENT county fetches its subdivisions once (delta === 1, cache is per-county)', `afterSecond=${afterSecond} afterThird=${afterThird}`);
  }
  {
    // Cache scope 不得跨店：store A 選過桃園市之後，store B 第一次選桃園市仍要重新抓。
    const { dom: domA } = await setupDashboard({ storeId: 'cache_store_a' });
    await domA.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    const { dom: domB, fetchCalls: fetchCallsB } = await setupDashboard({ storeId: 'cache_store_b' });
    const beforeB = fetchCallsB.filter((c) => c.url.includes('/administrative-areas')).length;
    await domB.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    const afterB = fetchCallsB.filter((c) => c.url.includes('/administrative-areas')).length;
    assert(afterB - beforeB === 1, 'admin cache: store isolation — store B selecting 桃園市 for the first time still fetches (its own fresh jsdom window/module state is never shared with store A\'s cache)');
  }

  // ── B17. 全部行政區：清除 subdivision_code，不送 undefined/null/空字串 ──
  {
    const { dom, fetchCalls } = await setupDashboard();
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.geoDashboardSetSubdivision('68000010');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.geoDashboardSetSubdivision(''); // UI 的「全部行政區」選項 value=""
    await new Promise((r) => setTimeout(r, 20));
    const overviewCalls = fetchCalls.filter((c) => c.url.includes('/geo/overview'));
    const last = overviewCalls[overviewCalls.length - 1];
    const params = qs(last.url);
    assert(!('subdivision_code' in params), 'clear subdivision: switching back to 全部行政區 omits subdivision_code entirely from the query string');
    assert(params.subdivision_code !== 'undefined' && params.subdivision_code !== 'null', 'clear subdivision: never literally sends the string "undefined" or "null"');
    assert(params.county_code === '68000', 'clear subdivision: county_code is preserved when only the subdivision is cleared');
  }

  // ── B18. Response Parser：{success:false} 與 {ok:false} 都要正確進入失敗/局部失敗 ──
  {
    const dom = makeDom();
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('/geo/overview')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, error: 'boom' }) });
      if (u.includes('/geo/funnel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoFunnelFixture() }) });
      if (u.includes('/geo/alerts')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoAlertsFixture() }) });
      if (u.includes('/geo/county-summary')) return Promise.resolve({ ok: true, status: 200, json: async () => geoCountySummaryFixture() });
      if (u.includes('/administrative-areas')) return Promise.resolve({ ok: true, status: 200, json: async () => adminAreasFixture(null) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'parser_test_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    const finalHtml = await waitForGeoReady(() => container.innerHTML);
    assert(finalHtml.includes('Geo 分析載入失敗'), 'response parser: overview returning {success:false} (readJson) is correctly treated as a failed required call -> fatal error state');
  }
  {
    const dom = makeDom();
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('/geo/overview')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoOverviewFixture() }) });
      if (u.includes('/geo/funnel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoFunnelFixture() }) });
      if (u.includes('/geo/alerts')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoAlertsFixture() }) });
      if (u.includes('/geo/county-summary')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'boom' }) }); // readOkJson 的失敗形狀
      if (u.includes('/administrative-areas')) return Promise.resolve({ ok: true, status: 200, json: async () => adminAreasFixture(null) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'parser_test_store_2' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    const finalHtml = await waitForGeoReady(() => container.innerHTML);
    assert(!finalHtml.includes('Geo 分析載入失敗'), 'response parser: county-summary returning {ok:false} (readOkJson) is correctly treated as partial failure, NOT a fatal whole-block error');
    assert(finalHtml.includes('行政區排行榜暫時無法載入'), 'response parser: county-summary {ok:false} correctly degrades just the ranking section');
    assert(finalHtml.includes('進站訪客'), 'response parser: core KPI still renders when only the {ok:false}-shaped endpoint fails');
  }

  // ── B19. Date Scope：日期切換觸發排行榜重新計算 ──
  {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, {});
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'date_scope_b12_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '2026-07-01', end_date: '2026-07-01' };
    const containerId = 'date-scope-b12';
    const div = dom.window.document.createElement('div');
    div.id = containerId;
    dom.window.document.body.appendChild(div);
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 10));
    const firstFunnelCall = [...fetchCalls].reverse().find((c) => c.url.includes('/geo/funnel'));
    assert(firstFunnelCall && qs(firstFunnelCall.url).date_from === '2026-07-01', 'date scope: ranking table\'s underlying /funnel call reflects the current dashboardDateState');
    dom.window.dashboardDateState = { preset: 'custom', start_date: '2026-07-15', end_date: '2026-07-20' };
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 10));
    const secondFunnelCall = [...fetchCalls].reverse().find((c) => c.url.includes('/geo/funnel'));
    assert(secondFunnelCall && qs(secondFunnelCall.url).date_from === '2026-07-15' && qs(secondFunnelCall.url).date_to === '2026-07-20',
      'date scope: changing the date range triggers a fresh /funnel call with the new range, recalculating the ranking table');
  }

  // ── B20. Recommended Actions 同步（drawer 內建議動作用同一份已載入 alerts）──
  {
    const { dom } = await setupDashboard({
      alertsFor: () => ({ alerts: [
        { type: 'traffic_waste', severity: 'warning', geo_context: 'acquisition', city: '桃園市', district: '第1區', area_label: '桃園市第1區', message: '第1區的特別建議訊息', suggestion: '建議X', metrics: {} },
      ], rule_thresholds: {} }),
    });
    dom.window.geoAreaDrawerOpen('桃園市|第1區');
    await new Promise((r) => setTimeout(r, 5));
    const drawerEl = dom.window.document.querySelector('.geo-area-drawer');
    assert(!!drawerEl && drawerEl.innerHTML.includes('第1區的特別建議訊息'), 'recommended actions sync: drawer shows the alert message for its own area, sourced from the same already-loaded vm.alerts (not a separate fetch)');
    dom.window.geoAreaDrawerOpen('桃園市|第5區'); // 沒有相符 alert 的區域
    await new Promise((r) => setTimeout(r, 5));
    const drawerEl2 = dom.window.document.querySelector('.geo-area-drawer');
    assert(!!drawerEl2 && drawerEl2.innerHTML.includes('目前資料不足'), 'recommended actions sync: an area with no matching alert shows "目前資料不足", not a fabricated suggestion');
  }

  // ── B21. 搜尋：null／undefined 輸入（DOM 層級，不只 Part A 純函式）──
  {
    const { dom, container } = await setupDashboard();
    let threw = false;
    try { dom.window.geoRankingSetSearch(null); } catch (e) { threw = true; }
    await new Promise((r) => setTimeout(r, 5));
    assert(!threw, 'search DOM: geoRankingSetSearch(null) does not throw');
    assert(container.innerHTML.includes('第0區'), 'search DOM: null search behaves like empty search (shows full list)');
    let threw2 = false;
    try { dom.window.geoRankingSetSearch(undefined); } catch (e) { threw2 = true; }
    await new Promise((r) => setTimeout(r, 5));
    assert(!threw2, 'search DOM: geoRankingSetSearch(undefined) does not throw');
    assert(container.innerHTML.includes('第0區'), 'search DOM: undefined search behaves like empty search (shows full list)');
  }

  // ── B22. 排序：預設排序驗證（未點擊任何表頭前）──
  {
    const { container } = await setupDashboard();
    // 預設 sortKey='visitors', sortDir='desc' —— 第0區（visitors 最高）應該
    // 是第一列，且訪客欄表頭應該顯示降冪箭頭。
    const html = container.innerHTML;
    const rowStart = html.indexOf('<tbody>');
    const firstAreaIdx = html.indexOf('第', rowStart);
    assert(html.slice(firstAreaIdx, firstAreaIdx + 4).includes('第0區') || html.indexOf('第0區', rowStart) < html.indexOf('第1區', rowStart),
      'default sort: with no user interaction, table defaults to visitors-desc (highest first)');
    assert(/訪客\s*↓/.test(html), 'default sort: 訪客 column header shows the desc arrow by default');
  }

  // ── B23. 分頁：最後一頁內容正確（不是空的，也不是重複第一頁）──
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetPage(2);
    await new Promise((r) => setTimeout(r, 5));
    const page2Html = container.innerHTML;
    assert(page2Html.includes('第 2 頁'), 'pagination last page: page indicator shows 第 2 頁');
    // 23 筆（22 已知 + 1 unknown）分頁 20/頁 -> 第 2 頁應該有 3 筆，含 unknown。
    assert(page2Html.includes('未知區域'), 'pagination last page: the unknown row (sorted last) lands on the final page, not lost');
    // 注意：整個 db-body-v2 容器裡「高意願區域 Top 3」本來就會顯示第0區
    // （那是獨立於排行榜分頁的另一個區塊），所以「不外洩」只能檢查排行榜
    // 自己的子容器（id="${containerId}-ranking"），不能檢查整個容器。
    const rankingOnlyEl = dom.window.document.querySelector('[id$="-ranking"]');
    assert(!!rankingOnlyEl, 'pagination last page: ranking-only sub-container exists for scoped assertions');
    assert(!rankingOnlyEl.innerHTML.includes('第0區'), 'pagination last page: within the ranking table itself, page 1\'s top row (第0區) does not leak onto page 2');
  }

  // ── B24. Dashboard Sync：切換「行政區」（不只縣市）也要同步 KPI／Top3／建議 ──
  {
    const { dom, container } = await setupDashboard();
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.geoDashboardSetSubdivision('68000010');
    await new Promise((r) => setTimeout(r, 20));
    const html = container.innerHTML;
    assert(html.includes('進站訪客'), 'subdivision sync: KPI still renders after switching subdivision');
    assert(html.includes('高意願區域'), 'subdivision sync: Top3 still renders after switching subdivision');
    assert(html.includes('行政區排行榜'), 'subdivision sync: ranking table still renders after switching subdivision');
  }

  // ── B25. Cache Invalidation：日期切換後，即使縣市不變，也要拿最新資料（不是回傳過期快取）──
  {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = (url) => {
      const u = String(url);
      fetchCalls.push({ url: u });
      let body = { success: false };
      const currentStartDate = dom.window.dashboardDateState && dom.window.dashboardDateState.start_date;
      const isNewDate = currentStartDate === '2026-07-10';
      if (u.includes('/geo/overview')) body = { success: true, data: geoOverviewFixture() };
      else if (u.includes('/geo/funnel')) body = { success: true, data: { page: 1, limit: 100, areas: [{ city: '桃園市', district: isNewDate ? '新日期資料' : '舊日期資料', area_label: isNewDate ? '新日期資料' : '舊日期資料', visitors: 10, add_to_cart_visitors: 1, begin_checkout_visitors: 1, submitted_order_visitors: 1 }] } };
      else if (u.includes('/geo/alerts')) body = { success: true, data: geoAlertsFixture() };
      else if (u.includes('/geo/county-summary')) body = geoCountySummaryFixture();
      else if (u.includes('/administrative-areas')) body = adminAreasFixture(null);
      return Promise.resolve({ ok: true, status: 200, json: async () => body });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'cache_invalidation_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '2026-07-01', end_date: '2026-07-01' };
    const containerId = 'cache-invalidation-test';
    const div = dom.window.document.createElement('div');
    div.id = containerId;
    dom.window.document.body.appendChild(div);
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 10));
    assert(div.innerHTML.includes('舊日期資料'), 'cache invalidation: initial date range shows its own data');
    dom.window.dashboardDateState = { preset: 'custom', start_date: '2026-07-10', end_date: '2026-07-10' };
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 10));
    assert(div.innerHTML.includes('新日期資料') && !div.innerHTML.includes('舊日期資料'), 'cache invalidation: changing the date range replaces stale data, never shows a mix of old+new or stale-only');
  }

  // ── B26. Query Params：county_code／subdivision_code 同時存在時的組合 ──
  {
    const { fetchCalls } = await setupDashboard();
    // sanity：預設（無篩選）情況下兩者都不應該出現在 query 裡
    const overviewCalls = fetchCalls.filter((c) => c.url.includes('/geo/overview'));
    const params0 = qs(overviewCalls[overviewCalls.length - 1].url);
    assert(!('county_code' in params0), 'query params: no county filter selected -> county_code absent from query');
    assert(!('subdivision_code' in params0), 'query params: no subdivision filter selected -> subdivision_code absent from query');
  }
  {
    const { dom, fetchCalls } = await setupDashboard();
    await dom.window.geoDashboardSetCounty('68000');
    await new Promise((r) => setTimeout(r, 20));
    await dom.window.geoDashboardSetSubdivision('68000010');
    await new Promise((r) => setTimeout(r, 20));
    const overviewCalls = fetchCalls.filter((c) => c.url.includes('/geo/overview'));
    const params = qs(overviewCalls[overviewCalls.length - 1].url);
    assert(params.county_code === '68000' && params.subdivision_code === '68000010', 'query params: both county_code and subdivision_code present together when both are selected');
  }

  // ── B27. Parser：readJson()／readOkJson() 涵蓋 funnel 與 alerts 的 {success:false} ──
  {
    const dom = makeDom();
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('/geo/overview')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoOverviewFixture() }) });
      if (u.includes('/geo/funnel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, error: 'boom' }) });
      if (u.includes('/geo/alerts')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoAlertsFixture() }) });
      if (u.includes('/geo/county-summary')) return Promise.resolve({ ok: true, status: 200, json: async () => geoCountySummaryFixture() });
      if (u.includes('/administrative-areas')) return Promise.resolve({ ok: true, status: 200, json: async () => adminAreasFixture(null) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'parser_funnel_fail_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    const finalHtml = await waitForGeoReady(() => container.innerHTML);
    assert(finalHtml.includes('Geo 分析載入失敗'), 'response parser: funnel returning {success:false} is correctly treated as a failed required call -> fatal error state');
  }
  {
    const dom = makeDom();
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('/geo/overview')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoOverviewFixture() }) });
      if (u.includes('/geo/funnel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoFunnelFixture() }) });
      if (u.includes('/geo/alerts')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: false, error: 'boom' }) });
      if (u.includes('/geo/county-summary')) return Promise.resolve({ ok: true, status: 200, json: async () => geoCountySummaryFixture() });
      if (u.includes('/administrative-areas')) return Promise.resolve({ ok: true, status: 200, json: async () => adminAreasFixture(null) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'parser_alerts_fail_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    const finalHtml = await waitForGeoReady(() => container.innerHTML);
    assert(!finalHtml.includes('Geo 分析載入失敗'), 'response parser: alerts returning {success:false} is partial-failure tolerant, not fatal');
    assert(finalHtml.includes('進站訪客'), 'response parser: KPI still renders when only alerts (optional) fails');
    assert(finalHtml.includes('區域建議暫時無法載入'), 'response parser: alerts {success:false} correctly discloses which section degraded');
  }
  {
    // administrative-areas 回 {ok:false}：不應該讓整個 Dashboard 失敗，只是縣市下拉選單維持空的「全部縣市」。
    const dom = makeDom();
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('/geo/overview')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoOverviewFixture() }) });
      if (u.includes('/geo/funnel')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoFunnelFixture() }) });
      if (u.includes('/geo/alerts')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: geoAlertsFixture() }) });
      if (u.includes('/geo/county-summary')) return Promise.resolve({ ok: true, status: 200, json: async () => geoCountySummaryFixture() });
      if (u.includes('/administrative-areas')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ ok: false, error: 'boom' }) });
      return Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    };
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc); dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'parser_admin_fail_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const html = dom.window.renderDashboardGeoIntelligence({ geo_summary: { top_intent_areas: [], high_traffic_low_conversion: [], fulfillment_summary: {}, data_quality: { status: 'healthy' } } });
    const container = dom.window.document.getElementById('db-body-v2');
    container.innerHTML = html;
    const finalHtml = await waitForGeoReady(() => container.innerHTML);
    assert(finalHtml.includes('進站訪客'), 'response parser: administrative-areas {ok:false} does not block core KPI rendering');
    assert(!finalHtml.includes('Geo 分析載入失敗'), 'response parser: administrative-areas failure alone is not fatal (county picker just stays empty)');
  }

  // ── B28. 分頁邊界：page < 1 一律拒絕，不崩潰、不跳到奇怪頁碼 ──
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetPage(2);
    await new Promise((r) => setTimeout(r, 5));
    dom.window.geoRankingSetPage(0);
    await new Promise((r) => setTimeout(r, 5));
    assert(container.innerHTML.includes('第 2 頁'), 'pagination boundary: geoRankingSetPage(0) is rejected, page stays at the last valid value (2)');
    dom.window.geoRankingSetPage(-5);
    await new Promise((r) => setTimeout(r, 5));
    assert(container.innerHTML.includes('第 2 頁'), 'pagination boundary: geoRankingSetPage(-5) is rejected too, no crash, no negative page');
  }

  // ── B29. 靜態原始碼確認：readJson／readOkJson 各自用在對的端點 ──
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    assert(src.includes('const readOkJson = async'), 'source: readOkJson() is defined');
    assert(/const county = await readOkJson\(countySettled\)/.test(src), 'source: county-summary parsed via readOkJson() (raw {ok,...} shape)');
    assert(/const overview = await readJson\(overviewSettled\)/.test(src), 'source: overview parsed via readJson() ({success,data} shape)');
    assert(/const funnel = await readJson\(funnelSettled\)/.test(src), 'source: funnel parsed via readJson() ({success,data} shape)');
    assert(/const alerts = await readJson\(alertsSettled\)/.test(src), 'source: alerts parsed via readJson() ({success,data} shape)');
    assert(src.includes('function getGeoAdministrativeAreas('), 'source: getGeoAdministrativeAreas() client function defined');
    assert(src.includes('function getGeoAvailableAreas('), 'source: getGeoAvailableAreas() client function defined');
  }

  // ── B30. 統一 ViewModel：Ranking／Top3／Drawer／Funnel 展開共用同一份 vm.funnel.areas ──
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    // 靜態確認 computeGeoAreaRanking / computeGeoTopAreas / geoAreaDrawerOpen /
    // _renderGeoAreaFunnelSteps 全部讀 vm.funnel.areas（同一個資料源），不是
    // 各自獨立 fetch 或維護自己的陣列。
    assert(/computeGeoAreaRanking\(vm, state\)[\s\S]{0,200}vm\.funnel && vm\.funnel\.areas/.test(src), 'source: computeGeoAreaRanking() reads vm.funnel.areas');
    assert(/computeGeoTopAreas\(vm\)[\s\S]{0,200}vm\.funnel && vm\.funnel\.areas/.test(src), 'source: computeGeoTopAreas() reads the same vm.funnel.areas');
    assert(/geoAreaDrawerOpen[\s\S]{0,200}geoLastVm\.funnel\.areas/.test(src), 'source: geoAreaDrawerOpen() looks up the area from geoLastVm.funnel.areas, not a second fetch');
    assert(!/function.*Drawer[\s\S]{0,100}fetch\(/.test(src.split('geoAreaDrawerOpen')[1] ? src.split('geoAreaDrawerOpen')[1].slice(0, 800) : ''), 'source: drawer open path contains no fetch( call within its own body');
  }

  // ── B31. Empty 與 All-Unknown 兩種狀態文案不得混用 ──
  {
    const { container } = await setupDashboard({
      funnelFor: () => geoFunnelFixture({ areas: [] }),
      countyFor: () => geoCountySummaryFixture({ rows: [] }),
      overviewFor: () => geoOverviewFixture({ data_quality: { status: 'insufficient_data', total_events: 0, identified_events: 0, unknown_events: 0, identified_rate: 0, unknown_rate: 0, minimum_sample: 10 } }),
    });
    assert(!container.innerHTML.includes('目前已有 Analytics 事件，但尚無可辨識區域'), 'empty vs all-unknown: true-empty state does not show the all-unknown wording');
  }
  {
    const { container } = await setupDashboard({
      overviewFor: () => geoOverviewFixture({ data_quality: { status: 'degraded', total_events: 200, identified_events: 0, unknown_events: 200, identified_rate: 0, unknown_rate: 1, minimum_sample: 10 } }),
    });
    assert(!container.innerHTML.includes('目前沒有符合條件的區域資料'), 'empty vs all-unknown: all-unknown state (has events, zero identified) does not show the plain-empty wording');
    assert(container.innerHTML.includes('目前已有 Analytics 事件，但尚無可辨識區域'), 'empty vs all-unknown: all-unknown state shows its own distinct message');
  }

  // ── B32. Privacy：縣市/行政區下拉選單本身也不得洩漏敏感資訊 ──
  {
    const { dom } = await setupDashboard({
      adminAreasFor: (countyCode) => countyCode ? adminAreasFixture(countyCode) : { ok: true, manifest: {}, counties: [{ county_code: '68000', county_name: '桃園市', subdivision_count: 13, __leak_admin_email: 'admin@example.com', __leak_token: 'tok_secretvalue123' }] },
    });
    await new Promise((r) => setTimeout(r, 20));
    const selectHtml = dom.window.document.querySelector('select[aria-label="縣市"]').outerHTML;
    assert(!/tok_secretvalue123/.test(selectHtml), 'privacy: county dropdown never renders a leaked token value even if present on the raw API object');
    assert(!/admin@example\.com/.test(selectHtml), 'privacy: county dropdown never renders a leaked email value');
  }

  // ── B33. 排序：加購/結帳欄位也要能在 DOM 層級正確排序 ──
  {
    const { dom, container } = await setupDashboard();
    dom.window.geoRankingSetSort('cart');
    await new Promise((r) => setTimeout(r, 5));
    const cartHtml = container.innerHTML;
    assert(cartHtml.indexOf('第0區') < cartHtml.indexOf('第1區'), 'sort by cart: 第0區 (highest add_to_cart_visitors) sorts before 第1區');
    dom.window.geoRankingSetSort('checkout');
    await new Promise((r) => setTimeout(r, 5));
    const checkoutHtml = container.innerHTML;
    assert(checkoutHtml.indexOf('第0區') < checkoutHtml.indexOf('第1區'), 'sort by checkout: 第0區 (highest begin_checkout_visitors) sorts before 第1區');
    dom.window.geoRankingSetSort('conversion');
    await new Promise((r) => setTimeout(r, 5));
    assert(/成交率\s*↓/.test(container.innerHTML), 'sort by conversion: 成交率 column header shows the active sort arrow after clicking it');
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

function printSummary() {
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log('\n' + '='.repeat(70));
  console.log(`SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.2-B1-2`);
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
    console.log('\nMANUAL REQUIRED:');
    results.filter((r) => r.status === 'MANUAL REQUIRED').forEach((r) => console.log(`  - ${r.name} — ${r.detail}`));
  }
}

main().catch((e) => {
  console.error('[smoke] uncaught error:', e && e.stack || e);
  process.exitCode = 1;
});
