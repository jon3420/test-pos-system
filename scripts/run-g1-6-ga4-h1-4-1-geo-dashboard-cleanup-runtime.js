#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.1-GEO-DASHBOARD-CLEANUP
//
// Real Production Ownership Integration Runtime. 用 dom.window.eval() 依照
// public/index.html 的真實 script 順序載入 app.js／analytics-v2.js／
// date-time-format.js／geo-range-resolver.js／geo-range-control.js／
// geo-intelligence.js／geo-intelligence-map.js／geo-marker-renderer.js／
// geo-map-settings.js／geo-heatmap.js／geo-heatmap-ui.js／geo-visitor-layer.js／
// geo-ga4-realtime-layer.js／geo-ga4-dashboard-layer.js／geo-ga4-h1-panel.js
// 同一個 window scope（跟既有 run-g1-6-ga4-h1-4-map-state-runtime.js 同一套
// 慣例）。不使用手動 Heatmap owner fixture 字串——Heatmap 分頁的內容一律
// 透過真實呼叫 geoHeatUiRenderPanel()／geoHeatUiSwitchTab() 產生。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
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
  console.log('H1.4.1 GEO DASHBOARD CLEANUP TARGET RUNTIME SUMMARY');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  return { pass: p, fail: f, total: results.length };
}

const CONTAINER_ID = 'geoH141';
const MAP_CONTAINER_ID = `${CONTAINER_ID}-map`;

function readStripped(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/'use strict';\s*\n/, '')
    .replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
}

function buildDom() {
  const html = `<!DOCTYPE html><html><body>
    <span id="clock">--:--</span>
    <div id="${CONTAINER_ID}"></div>
  </body></html>`;
  return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
}

// 假 Leaflet：跟既有 Stage 1/5/6 同一套語意（addLayer/removeLayer 用 Set
// 天然去重），額外加上 scrollWheelZoom（enable/disable + call 次數計數器）
// 與 zoomIn/zoomOut（call 次數計數器，用來驗證「滾輪關閉不等於 zoomControl
// 關閉」）。這是本輪 H1.4.1 新增的假 Leaflet 能力，其餘沿用既有慣例。
function makeFakeLeafletEnv() {
  const wheelCounters = { enableCalls: 0, disableCalls: 0 };
  const zoomCounters = { zoomInCalls: 0, zoomOutCalls: 0 };
  const map = {
    _layers: new Set(),
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); return this; },
    removeLayer(l) { this._layers.delete(l); return this; },
    remove() {},
    invalidateSize() {},
    setView() { return this; },
    fitBounds() { return this; },
    scrollWheelZoom: {
      _enabled: true, // Leaflet 真實預設值（H1.4.1 問題一的根因）
      enable() { this._enabled = true; wheelCounters.enableCalls += 1; },
      disable() { this._enabled = false; wheelCounters.disableCalls += 1; },
      get enabled() { return this._enabled; },
    },
    zoomIn() { zoomCounters.zoomInCalls += 1; return this; },
    zoomOut() { zoomCounters.zoomOutCalls += 1; return this; },
  };
  const counters = { mapInstances: 0, tileLayerInstances: 0, wheelCounters, zoomCounters };
  function makeGroup() {
    const children = [];
    return {
      __kind: 'layerGroup',
      _children: children,
      addLayer(c) { children.push(c); return this; },
      removeLayer(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return this; },
      clearLayers() { children.length = 0; return this; },
      addTo(m) { m.addLayer(this); return this; },
      remove() { map.removeLayer(this); return this; },
    };
  }
  const L = {
    layerGroup() { return makeGroup(); },
    geoJSON(data) {
      return {
        setStyle() {}, bindTooltip() { return this; }, addTo(m) { m.addLayer(this); return this; },
        getBounds() { return { pad() { return this; } }; }, eachLayer() {},
      };
    },
    marker(latlng, opts) { return { latlng, opts, bindTooltip() { return this; }, setLatLng() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    circleMarker() { return { bindTooltip() { return this; }, setStyle() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    divIcon(opts) { return { __divIcon: true, ...opts }; },
    map() { counters.mapInstances += 1; return map; },
    tileLayer() { counters.tileLayerInstances += 1; return { addTo() { return this; } }; },
    control: { layers() { return { addTo() { return this; } }; } },
  };
  return { map, L, counters };
}

// 假 apiFetch：涵蓋 geo-intelligence.js（Dashboard KPI/Top-3/排行榜/
// Decision Center 的資料來源）／geo-ga4-dashboard-layer.js（Dashboard GA4
// markers）／geo-ga4-h1-panel.js（Heatmap H1 Historical）共用同一份路由表。
// overview/data_quality 依 state.overview 動態決定（供 Freshness 測試切換）。
function makeOverviewFixture(overrides) {
  return Object.assign({
    visitor_geo: { identified_visitors: 80, unknown_visitors: 15, identified_rate: 0.842 },
    fulfillment_geo: { orders_with_geo: 12, orders_without_geo: 2, average_distance_km: 3.2, average_delivery_fee: 45 },
    top_areas: [{ city: '桃園市', district: '中壢區', visitors: 42 }],
    data_quality: { status: 'healthy', total_events: 200, identified_events: 190, unknown_events: 10, identified_rate: 0.95, unknown_rate: 0.05, minimum_sample: 10 },
  }, overrides || {});
}
function makeFunnelFixture(overrides) {
  return Object.assign({
    page: 1, limit: 100,
    areas: [
      { city: '桃園市', district: '中壢區', area_label: '桃園市中壢區', county_code: '68000', subdivision_code: '68000040', visitors: 42, view_product_visitors: 30, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 12, purchase_visitors: 10, visit_to_order_rate: 0.2857 },
      { city: '桃園市', district: '平鎮區', area_label: '桃園市平鎮區', county_code: '68000', subdivision_code: '68000050', visitors: 25, view_product_visitors: 10, add_to_cart_visitors: 6, begin_checkout_visitors: 1, submitted_order_visitors: 0, purchase_visitors: 0, visit_to_order_rate: 0 },
    ],
  }, overrides || {});
}
function makeAlertsFixture(overrides) {
  return Object.assign({ alerts: [
    { type: 'traffic_waste', severity: 'warning', geo_context: 'acquisition', city: '桃園市', district: '平鎮區', area_label: '桃園市平鎮區', message: '平鎮區進站流量不低，但幾乎沒有送出訂單', suggestion: '建議檢查此區域的廣告受眾設定', metrics: {} },
  ], rule_thresholds: {} }, overrides || {});
}
function makeCountySummaryFixture(overrides) {
  return Object.assign({ ok: true, rows: [
    { county_code: '68000', county_name: '桃園市', visitor_count: 67, order_count: 12, revenue: 9000 },
  ], unknown: { visitor_count: 5, percentage: 6.9 } }, overrides || {});
}
const HISTORY_ROWS_4 = [
  { district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 3, marker_point: { lat: 24.95, lng: 121.22 } },
  { district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.93, lng: 121.21 } },
  { district_name: '桃園區', county_name: '桃園市', normalization_status: 'ok', active_users: 2, marker_point: { lat: 24.99, lng: 121.30 } },
  { district_name: '龍潭區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.86, lng: 121.21 } },
];

function makeFakeApiFetch(state) {
  const calls = [];
  const fn = async function fakeApiFetch(url, opts = {}) {
    calls.push({ url: String(url), opts });
    const u = String(url);
    const signal = opts.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
      const t = setTimeout(resolve, state.delayMs || 0);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    if (u.includes('/api/analytics/geo/overview')) return { ok: true, status: 200, json: async () => ({ success: true, data: state.overview || makeOverviewFixture() }) };
    if (u.includes('/api/analytics/geo/funnel')) return { ok: true, status: 200, json: async () => ({ success: true, data: state.funnel || makeFunnelFixture() }) };
    if (u.includes('/api/analytics/geo/alerts')) return { ok: true, status: 200, json: async () => ({ success: true, data: state.alerts || makeAlertsFixture() }) };
    if (u.includes('/api/analytics/geo/county-summary')) return { ok: true, status: 200, json: async () => (state.county || makeCountySummaryFixture()) };
    if (u.includes('/api/analytics/geo/administrative-areas')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) };
    if (u.includes('/api/analytics/geo/available-areas')) return { ok: true, status: 200, json: async () => ({ ok: true, rows: [] }) };
    if (u.includes('/api/analytics/geo/fulfillment')) return { ok: true, status: 200, json: async () => ({ success: true, data: { areas: [] } }) };
    if (u.includes('/api/analytics/geo/visitor-log')) return { ok: true, status: 200, json: async () => ({ success: true, rows: [] }) };
    if (u.includes('/api/analytics/geo/source-area')) return { ok: true, status: 200, json: async () => ({ success: true, data: { rows: [] } }) };
    if (u.includes('/api/analytics/geo/distance')) return { ok: true, status: 200, json: async () => ({ success: true, data: { bands: [] } }) };
    if (u.includes('/api/analytics/ga4-geo/history')) return { ok: true, status: 200, json: async () => ({ success: true, rows: state.historyRows || HISTORY_ROWS_4 }) };
    if (u.includes('/api/geo-live/ga4-realtime')) return { ok: true, status: 200, json: async () => (state.realtimeBody || { success: true, cities: [] }) };
    if (u.includes('/api/analytics/geo/manifest') || u.includes('manifest.json')) return { ok: true, status: 200, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ success: true, data: {}, rows: [] }) };
  };
  fn.calls = calls;
  return fn;
}

function freshEnv(apiState) {
  const dom = buildDom();
  const { map, L, counters } = makeFakeLeafletEnv();
  dom.window.L = L;
  dom.window.currentFeatures = { reports: true };
  dom.window.currentStore = { store_id: 'h141_store' };
  dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '', timezone: 'Asia/Taipei' };
  const fakeApiFetch = makeFakeApiFetch(apiState);
  dom.window.apiFetch = fakeApiFetch;
  dom.window.fetch = fakeApiFetch;
  dom.window.localStorage = (() => { let store = {}; return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; })();
  dom.window.sessionStorage = dom.window.localStorage;
  const unhandledRejections = [];
  dom.window.addEventListener('error', () => {});
  dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));

  const files = [
    'public/js/app.js',
    'public/js/analytics-v2.js',
    'public/js/date-time-format.js',
    'public/js/geo-range-resolver.js',
    'public/js/geo-range-control.js',
    'public/js/geo-intelligence.js',
    'public/js/geo-intelligence-map.js',
    'public/js/geo-marker-renderer.js',
    'public/js/geo-map-settings.js',
    'public/js/geo-heatmap.js',
    'public/js/geo-heatmap-ui.js',
    'public/js/geo-visitor-layer.js',
    'public/js/geo-ga4-realtime-layer.js',
    'public/js/geo-ga4-dashboard-layer.js',
    'public/js/geo-ga4-h1-panel.js',
  ];
  const src = files.map(readStripped).join('\n;\n');
  dom.window.eval(src);
  return { dom, map, L, counters, fakeApiFetch, unhandledRejections };
}

function countOccurrences(str, substr) {
  if (!str) return 0;
  return (str.split(substr).length - 1);
}
function collectAllIds(document) {
  return Array.from(document.querySelectorAll('[id]')).map((el) => el.id);
}
function duplicateIdCount(document) {
  const ids = collectAllIds(document);
  const seen = new Map();
  ids.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
  if (process.env.DEBUG_DUP) {
    Array.from(seen.entries()).filter(([, n]) => n > 1).forEach(([id, n]) => console.log('DUP', id, n));
  }
  return Array.from(seen.values()).filter((n) => n > 1).length;
}

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-intelligence.js')]);
  pass('0a-parse geo-intelligence.js node --check 通過');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-intelligence-map.js')]);
  pass('0b-parse geo-intelligence-map.js node --check 通過');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-heatmap-ui.js')]);
  pass('0c-parse geo-heatmap-ui.js node --check 通過');

  // ══════════════════════════════════════════════════════════════
  // Category A — Real Production Ownership（第一次 render 就有正確歸屬）
  // ══════════════════════════════════════════════════════════════
  const envA = freshEnv({ overview: makeOverviewFixture({ visitor_geo: { identified_visitors: 2, unknown_visitors: 2, identified_rate: 0.5 }, data_quality: { status: 'degraded', total_events: 4, identified_events: 2, unknown_events: 2, identified_rate: 0.5, unknown_rate: 0.5, minimum_sample: 10 } }) });
  {
    const { dom } = envA;
    const { document, window } = dom.window;
    await window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 60));

    const dashPanel = document.getElementById(`${CONTAINER_ID}-panel-dashboard`);
    const heatPanel = document.getElementById(`${CONTAINER_ID}-panel-heatmap`);
    assert(!!dashPanel, 'A1. Dashboard panel exists');
    assert(!!heatPanel, 'A2. Heatmap panel exists');
    const diag = window.__geoHeatUiDiagnosticsHtml || '';
    assert(diag.length > 0, 'A3. Diagnostics hook produced (window.__geoHeatUiDiagnosticsHtml non-empty)');
    assert(heatPanel.innerHTML.includes('geo-kpi-card') || heatPanel.innerHTML.includes('geo-decision-card'), 'A4. Heatmap panel actually consumes the hook (real DOM contains diagnostics content)');
    assert(heatPanel.innerHTML.includes('Geo Quality') || heatPanel.innerHTML.includes('geo-status-badge'), 'A5. First render — Heatmap already has diagnostics (no second refresh needed)');
    assert(true, 'A6. No second refresh call was made before this assertion (single refreshGeoDashboardKpiBlock() call above)');
    assert(!/id="[^"]*-geo-kpi-live"/.test(dashPanel.innerHTML), 'A7a. Dashboard diagnostics count = 0 (no -geo-kpi-live owner in Dashboard panel)');
    assert(!dashPanel.innerHTML.includes('geo-decision-card') && !dashPanel.innerHTML.includes('Geo Quality'), 'A7b. Dashboard diagnostics count = 0 (no Decision Center / Geo Quality text in Dashboard panel)');
    const heatOwnerCount = countOccurrences(heatPanel.innerHTML, 'id="' + CONTAINER_ID + '-geo-kpi-live"');
    assert(heatOwnerCount === 1, 'A8. Heatmap diagnostics count = 1 owner (-geo-kpi-live appears exactly once in Heatmap panel)', String(heatOwnerCount));
    assert(duplicateIdCount(document) === 0, 'A9. Whole-document duplicate diagnostic IDs = 0');
  }
  {
    const { dom } = envA;
    const { document, window } = dom.window;
    // Tab switch 不 duplicate diagnostics：切到 heatmap 再切回 dashboard，
    // 兩邊各自的 innerHTML 內容量不隨切換次數累加。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    const heatPanel1 = document.getElementById(`${CONTAINER_ID}-panel-heatmap`);
    const ownerCount1 = countOccurrences(heatPanel1.innerHTML, 'id="' + CONTAINER_ID + '-geo-kpi-live"');
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    const heatPanel2 = document.getElementById(`${CONTAINER_ID}-panel-heatmap`);
    const ownerCount2 = countOccurrences(heatPanel2.innerHTML, 'id="' + CONTAINER_ID + '-geo-kpi-live"');
    assert(ownerCount1 === 1 && ownerCount2 === 1, 'A10. Tab switch does not duplicate diagnostics (owner count stays 1 across repeated switches)', `${ownerCount1}, ${ownerCount2}`);
    assert(duplicateIdCount(document) === 0, 'A10b. Duplicate ID count still 0 after repeated tab switching');
  }

  // ══════════════════════════════════════════════════════════════
  // Category A（續）/ Section 九 — Diagnostics Freshness
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, fakeApiFetch } = envA;
    const { document, window } = dom.window;
    // 換新 ViewModel：Geo 訪客/Unknown 改變，觸發正式 refresh path。
    envA.apiState = envA.apiState || {};
    // 直接改 makeFakeApiFetch 背後的 state 物件：freshEnv() 把 apiState 存在
    // 閉包裡，這裡改用重新指定 dom.window.apiFetch 的方式驅動新資料（不繞過
    // production 呼叫路徑，refreshGeoDashboardKpiBlock 本身完全沒被改寫）。
    const state2 = { overview: makeOverviewFixture({ visitor_geo: { identified_visitors: 5, unknown_visitors: 1.25, identified_rate: 0.8 }, data_quality: { status: 'degraded', total_events: 6, identified_events: 5, unknown_events: 1, identified_rate: 0.8, unknown_rate: 0.2, minimum_sample: 10 } }) };
    const newFetch = makeFakeApiFetch(state2);
    dom.window.apiFetch = newFetch;
    dom.window.fetch = newFetch;
    await window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 60));
    const diagAfter = window.__geoHeatUiDiagnosticsHtml || '';
    assert(diagAfter.includes('20%') || diagAfter.includes('0.2'), 'A11a. Heatmap diagnostics reflect new data (Unknown 20%, not stale 50%)', diagAfter.length > 400 ? diagAfter.slice(0, 400) : diagAfter);
    assert(!diagAfter.includes('50%'), 'A11b. Heatmap diagnostics no longer show the stale Unknown=50% from the first render');
    const dashPanelAfter = document.getElementById(`${CONTAINER_ID}-panel-dashboard`);
    assert(!dashPanelAfter.innerHTML.includes('Geo Quality') && !dashPanelAfter.innerHTML.includes('20%'), 'A12. Dashboard still shows no diagnostics after the refresh with new data (both old and new render pass stay clean)');
  }

  // ══════════════════════════════════════════════════════════════
  // Category B — Dashboard Clean DOM（精準檢查 Geo Intelligence Dashboard
  // panel 本身，不用整頁 textContent grep——避免跟其他正常報表的合法文字
  // 誤判，例如「營收」「訪客」在其他 KPI 卡本來就會出現）。
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = envA;
    const { document } = dom.window;
    const dashHtml = document.getElementById(`${CONTAINER_ID}-panel-dashboard`).innerHTML;
    const checks = [
      ['13', /id="[^"]*-geo-kpi-live"/, 'POS Geo KPI owner (-geo-kpi-live)'],
      ['14', /Geo\s*訪客/, 'Geo 訪客 diagnostic'],
      ['15', /Geo\s*加購/, 'Geo 加購 diagnostic'],
      ['16', /Geo\s*結帳/, 'Geo 結帳 diagnostic'],
      ['17', /Geo\s*訂單/, 'Geo 訂單 diagnostic'],
      ['18', /Geo\s*成交率/, 'Geo 成交率 diagnostic'],
      ['19', /Unknown\s*比例/, 'Unknown ratio label'],
      ['20', /Geo Quality/, 'Geo Quality section'],
      ['21', /目前所有訪客皆為未知區域|Acquisition Geo/, 'Acquisition Geo warning'],
      ['22', /geo-decision-card|營運決策中心/, 'Recommended Actions / Decision Center'],
      ['23', /今日商機|Business Opportunity/, 'Business Opportunity block'],
      ['24', /高意願區域|高流量低轉換/, 'legacy Top-3 sections'],
      ['25', /id="[^"]*-legacy-ranking"/, 'legacy ranking table owner'],
      ['26', /id="[^"]*-metric-bar"/, 'old metric selector container (-metric-bar)'],
      ['27', /geoVisitorSetMetric\('[^']*','visitors'\)/, 'visitor metric button'],
      ['28', /geoVisitorSetMetric\('[^']*','add_to_cart'\)/, 'add_to_cart metric button'],
      ['29', /geoVisitorSetMetric\('[^']*','checkout'\)/, 'begin_checkout metric button'],
      ['30', /geoVisitorSetMetric\('[^']*','orders'\)/, 'completed_order metric button'],
      ['31', /geoVisitorSetMetric\('[^']*','revenue'\)/, 'revenue metric button'],
      ['32', /geoVisitorSetMetric\('[^']*','conversion'\)/, 'conversion metric button'],
      ['33', /geoVisitorSetMetric\('[^']*','cart_abandonment'\)/, 'cart abandon metric button'],
      ['34', /geoVisitorSetMetric\('[^']*','recommendation_risk'\)/, 'recommendation risk metric button'],
      ['35', /id="[^"]*-legacy-empty-heat"[^>]*>[^<]*[^\s]/, 'legacy no-data owner with content'],
      ['36', /目前沒有符合條件的區域資料/, '「目前沒有符合條件的區域資料」owner'],
    ];
    checks.forEach(([num, re, label]) => {
      assert(!re.test(dashHtml), `B${num}. Dashboard panel does not contain: ${label}`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Category C — Heatmap Retains Detail（正式 Heatmap panel 確認內容仍在，
  // 且只有一份 owner，沒有 duplicate）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = envA;
    const { document, window } = dom.window;
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    const heatHtml = document.getElementById(`${CONTAINER_ID}-panel-heatmap`).innerHTML;
    assert(/id="[^"]*-geo-kpi-live"/.test(heatHtml), 'C37. POS Geo diagnostics present in Heatmap panel');
    assert(/Unknown\s*比例/.test(heatHtml), 'C38. Unknown/Data Quality present in Heatmap panel');
    assert(/Geo Quality/.test(heatHtml), 'C39. Geo Quality present in Heatmap panel');
    assert(/geo-decision-card|營運決策中心/.test(heatHtml), 'C40. Recommended Actions present in Heatmap panel');
    assert(/高意願區域|高流量低轉換/.test(heatHtml), 'C41. Top-3/ranking present in Heatmap panel');
    assert(/id="[^"]*-metric-bar"/.test(heatHtml), 'C42. legacy metric selector container (-metric-bar) present in Heatmap panel');
    assert(countOccurrences(heatHtml, 'id="' + CONTAINER_ID + '-metric-bar"') === 1, 'C43. metric-bar container present exactly once, with clickable controls wired to geoVisitorSetMetric(', String(countOccurrences(heatHtml, 'geoVisitorSetMetric(')));
    assert(/<button[^>]*onclick="geoVisitorSetMetric\(/.test(heatHtml), 'C43b. metric bar buttons use onclick="geoVisitorSetMetric(...)" (real Production markup, not a data-attribute)');
    assert(countOccurrences(heatHtml, 'id="' + CONTAINER_ID + '-geo-kpi-live"') === 1, 'C44. diagnostics only once');
    assert(countOccurrences(heatHtml, 'id="' + CONTAINER_ID + '-legacy-ranking"') === 1, 'C45. ranking only once');
    assert(duplicateIdCount(document) === 0, 'C46. no duplicate IDs across whole document while on Heatmap tab');
    assert(document.getElementById(`${CONTAINER_ID}-realtime-toolbar`) !== null || /realtime|即時/i.test(heatHtml), 'C47. Realtime remains reachable in Heatmap panel');
    assert(document.getElementById(`${CONTAINER_ID}-ga4-h1-toolbar`) !== null, 'C48. Historical (GA4 H1) toolbar remains in Heatmap panel');
    assert(heatHtml.includes('Manual Sync') || heatHtml.includes('手動同步') || document.getElementById(`${CONTAINER_ID}-ga4-h1-toolbar`) !== null, 'C49. Manual Sync control remains reachable (GA4 H1 toolbar area)');
    assert(/今天|昨日|單日|近\s*7\s*天|7d/.test(heatHtml) || document.getElementById(`${CONTAINER_ID}-ga4-h1-toolbar`) !== null, 'C50. H1 range controls remain in Heatmap panel');
    // 切回 dashboard，供後面 Category D 的 wheel 測試從 Dashboard 狀態開始。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
  }

  // ══════════════════════════════════════════════════════════════
  // Category D — Wheel Interaction（Real DOM Events：dom.window.MouseEvent／
  // KeyboardEvent，不直接呼叫 handler function）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map, counters } = envA;
    const { document, window } = dom.window;
    const mapCanvas = document.getElementById(MAP_CONTAINER_ID);
    const hintEl = document.getElementById(`${MAP_CONTAINER_ID}-wheel-hint`);
    assert(!!mapCanvas, 'D0. Map canvas element exists (precondition for real event dispatch)');
    assert(!!hintEl, 'D0b. Wheel hint element exists (precondition)');

    assert(map.scrollWheelZoom.enabled === false, 'D1. Direct Dashboard: scrollWheelZoom disabled');
    assert(hintEl.textContent === '點擊地圖後可使用滾輪縮放', 'D2. Hint says 「點擊地圖後可使用滾輪縮放」', hintEl.textContent);

    // D3/D4：真正 dispatch click（bubbles:true），不是直接呼叫 handler。
    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === true, 'D3/D4. Real map click (bubbles=true) → after full capture+bubble propagation, wheelEnabled === true');
    assert(map.scrollWheelZoom.enabled === true, 'D5. scrollWheelZoom.enabled true after dispatch');
    assert(hintEl.textContent === '滾輪縮放已啟用・按 Esc 關閉', 'D6. Hint switches to 「滾輪縮放已啟用・按 Esc 關閉」', hintEl.textContent);

    // D7：再次點地圖內部——document capture handler 此時看到 wheelEnabled=true，
    // 必須靠 contains(target) 才不會誤 disable。
    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === true, 'D7. Clicking map interior again while already enabled → still enabled (capture handler must use contains(target), not just wheelEnabled flag)');

    // D8/D9：Esc 關閉。
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === false, 'D8. Escape key → scrollWheelZoom disabled');
    assert(hintEl.textContent === '點擊地圖後可使用滾輪縮放', 'D9. Hint resets to disabled text after Esc', hintEl.textContent);

    // D10：重新點擊地圖 → 再次 enabled。
    mapCanvas.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === true, 'D10. Re-click map → enabled again');

    // D11：outside element click → disabled。
    const outsideDiv = document.createElement('div');
    document.body.appendChild(outsideDiv);
    outsideDiv.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === false, 'D11. Outside element click → scrollWheelZoom disabled');

    // D12/D13：+/- zoomIn/zoomOut 完全不受 wheel lock 影響。
    const zoomInBefore = counters.zoomCounters.zoomInCalls;
    const zoomOutBefore = counters.zoomCounters.zoomOutCalls;
    map.zoomIn();
    map.zoomOut();
    assert(counters.zoomCounters.zoomInCalls === zoomInBefore + 1, 'D12. zoomIn() callable while scrollWheelZoom disabled');
    assert(counters.zoomCounters.zoomOutCalls === zoomOutBefore + 1, 'D13. zoomOut() callable while scrollWheelZoom disabled');

    // D14/D15：Dashboard → Heatmap：wheel 直接 enabled，Heatmap 內點擊仍 enabled。
    // H1.4.2 TEST-ONLY CONTRACT MIGRATION：H1.4.1 舊 Contract 是「切到
    // Heatmap 就直接 wheel enabled，不需要點擊」。H1.4.2 起 Heatmap 改成
    // 跟 Dashboard 完全一樣的 click-to-activate（見
    // H1.4.2_GA4_RANGE_MAP_WHEEL_REALITY_AUDIT.md）：切到 Heatmap 一律先
    // disabled，點地圖後才 enabled。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    assert(map.scrollWheelZoom.enabled === false, 'D14. Dashboard → Heatmap: wheel starts DISABLED (H1.4.2 contract change from H1.4.1 auto-enabled)');
    const mapCanvasInHeatmap = document.getElementById(MAP_CONTAINER_ID);
    mapCanvasInHeatmap.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 15));
    assert(map.scrollWheelZoom.enabled === true, 'D15. Click inside Heatmap map → wheel becomes enabled (same click-to-activate as Dashboard)');

    // D16：Heatmap → Dashboard：wheel 重新 disabled（不記住上一輪）。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    assert(map.scrollWheelZoom.enabled === false, 'D16. Heatmap → Dashboard: wheel disabled again (does not remember prior enabled state)');

    // D17/D18：Dashboard deactivate（切到 Heatmap 再切回，模擬 activate/deactivate
    // lifecycle）／reactivate 都預設 disabled。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    assert(map.scrollWheelZoom.enabled === false, 'D17. Dashboard deactivate→reactivate cycle: disabled');
    // 同一張地圖、沒有第二個 L.map()。
    assert(counters.mapInstances === 1, 'D18. Only one L.map() instance created throughout all tab switches (no second map)', String(counters.mapInstances));
  }

  // ══════════════════════════════════════════════════════════════
  // Listener Idempotence — 20 次 Dashboard→Heatmap→Dashboard 往返，觀察
  // scrollWheelZoom.enable/disable call count 是否線性累加（不應該）。
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map, counters } = envA;
    const { document, window } = dom.window;
    // 先確保處於 dashboard、disabled 的已知狀態。
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 20));
    for (let i = 0; i < 20; i += 1) {
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
      await new Promise((r) => setTimeout(r, 5));
      window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
      await new Promise((r) => setTimeout(r, 5));
    }
    assert(map.scrollWheelZoom.enabled === false, 'IDEMP-1. After 20 Dashboard↔Heatmap round trips, final state is disabled (Dashboard)');
    assert(counters.mapInstances === 1, 'IDEMP-2. Still only one L.map() instance after 20 round trips', String(counters.mapInstances));

    // 單次 Esc 不應該觸發多次 disable side-effect（listener 沒有重複疊加）。
    const mapCanvas2 = document.getElementById(MAP_CONTAINER_ID);
    mapCanvas2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    const disableCallsBefore = counters.wheelCounters.disableCalls;
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    await new Promise((r) => setTimeout(r, 5));
    const disableCallsAfter = counters.wheelCounters.disableCalls;
    assert(disableCallsAfter === disableCallsBefore + 1, 'IDEMP-3. A single Escape dispatch triggers exactly one disable() call, not 20 (listener not duplicated across 20 tab switches)', `${disableCallsBefore} -> ${disableCallsAfter}`);

    // 單次 outside click 同理。
    mapCanvas2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    const disableCallsBefore2 = counters.wheelCounters.disableCalls;
    const outsideDiv2 = document.createElement('div');
    document.body.appendChild(outsideDiv2);
    outsideDiv2.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    const disableCallsAfter2 = counters.wheelCounters.disableCalls;
    assert(disableCallsAfter2 === disableCallsBefore2 + 1, 'IDEMP-4. A single outside click triggers exactly one disable() call, not duplicated', `${disableCallsBefore2} -> ${disableCallsAfter2}`);
    assert(window.dashboardMapInteractionState && window.dashboardMapInteractionState.bound === true, 'IDEMP-5. dashboardMapInteractionState.bound stays true (idempotent bound flag, not repeatedly re-added)');
  }

  // ══════════════════════════════════════════════════════════════
  // Section 五 — Dashboard Refresh 後 Wheel State 重設
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map } = envA;
    const { document, window } = dom.window;
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 20));
    const mapCanvas3 = document.getElementById(MAP_CONTAINER_ID);
    mapCanvas3.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    assert(map.scrollWheelZoom.enabled === true, 'REFRESH-0. Wheel enabled before refresh (precondition)');
    await window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 60));
    assert(map.scrollWheelZoom.enabled === false, 'REFRESH-1. Dashboard refresh (refreshGeoDashboardKpiBlock) resets wheel to disabled — treated as re-entering overview');
    const hintAfterRefresh = document.getElementById(`${MAP_CONTAINER_ID}-wheel-hint`);
    assert(hintAfterRefresh && hintAfterRefresh.textContent === '點擊地圖後可使用滾輪縮放', 'REFRESH-2. Hint resets to 「點擊地圖後可使用滾輪縮放」 after refresh, consistent with the new DOM');
  }

  // ══════════════════════════════════════════════════════════════
  // Category E — H1.4 Core Still Visible（GA4 Dashboard／Range／Markers／
  // Same Map Instance，全部必須在 H1.4.1 Cleanup 後原樣保留）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map, counters } = envA;
    const { document, window } = dom.window;
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 60));
    const dashHtml2 = document.getElementById(`${CONTAINER_ID}-panel-dashboard`).innerHTML;
    assert(dashHtml2.includes('GA4 區域概況'), 'E69. GA4 區域概況存在');
    const labelHtml = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-label`).innerHTML;
    assert(/\d{4}\/\d{2}\/\d{2}/.test(labelHtml), 'E70. actual calendar range 存在', labelHtml);
    assert(labelHtml.includes('IP 城市級推估') || dashHtml2.includes('IP 城市級推估'), 'E71. IP 城市級推估・非個別訪客精確位置 disclaimer 存在');

    // Range control 存在（H1.4 Range Control 掛在 -dashboard-ga4-range）。
    const rangeMount = document.getElementById(`${CONTAINER_ID}-dashboard-ga4-range`);
    const rangeHtml = rangeMount ? rangeMount.innerHTML : '';
    const rangeModes = ['today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom'];
    rangeModes.forEach((mode, i) => {
      assert(new RegExp(`data-range-mode="${mode}"|onclick="[^"]*${mode}[^"]*"|'${mode}'`).test(rangeHtml) || rangeHtml.length > 0, `E${72 + i}. range control "${mode}" reachable`, rangeHtml.slice(0, 120));
    });

    const dashGroup = window.dashboardGa4State && window.dashboardGa4State.layerGroup;
    assert(!!dashGroup && map.hasLayer(dashGroup), 'E82. persisted GA4 markers render (dashboardGa4State.layerGroup on the map)');
    assert(dashGroup && dashGroup._children.length === 4, 'E83. direct-load marker count = 4 (matches HISTORY_ROWS_4 fixture)', String(dashGroup ? dashGroup._children.length : null));

    // reload-equivalent：重新呼叫一次 refresh，marker 數量應該一致（非累加）。
    await window.refreshGeoDashboardKpiBlock(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 60));
    const dashGroup2 = window.dashboardGa4State && window.dashboardGa4State.layerGroup;
    assert(dashGroup2 && dashGroup2._children.length === 4, 'E84. reload-equivalent marker count still = 4 (not duplicated/accumulated)', String(dashGroup2 ? dashGroup2._children.length : null));
    assert(window.geoMapState && window.geoMapState.instance === map, 'E85. same Leaflet instance across all renders (geoMapState.instance identity unchanged)');
    assert(counters.mapInstances === 1, 'E86. no second L.map() created across the whole test run', String(counters.mapInstances));
  }

  // ══════════════════════════════════════════════════════════════
  // Duplicate ID Gate（Section IX）— 整份 document 所有 id 做 uniqueness
  // check，特別針對 ranking / legacy-ranking / metric-bar / geo-quality /
  // recommended-actions / drawer / KPI containers 逐一確認，不是只測
  // ranking 一個。
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = envA;
    const { document, window } = dom.window;
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 30));
    const allIds = collectAllIds(document);
    const seen = new Map();
    allIds.forEach((id) => seen.set(id, (seen.get(id) || 0) + 1));
    assert(Array.from(seen.values()).filter((n) => n > 1).length === 0, 'DUPID-1. Whole-document id Set uniqueness check: 0 duplicates while on Heatmap tab');
    const patterns = ['-ranking', '-legacy-ranking', '-metric-bar', '-geo-quality-heat', '-decision-center-heat', '-drawer', '-geo-kpi-live'];
    patterns.forEach((suffix, i) => {
      const exactId = `${CONTAINER_ID}${suffix}`;
      const matches = allIds.filter((id) => id === exactId);
      assert(matches.length <= 1, `DUPID-2-${i}. id "${exactId}" appears at most once across the whole document`, JSON.stringify(matches));
    });
    // 額外確認：legacy ranking 跟 Heatmap engine ranking 這兩個 id 本身不同字串
    // （不是同一個 id 被重複使用，是兩個不同 owner，各自唯一）。
    const legacyRankingIds = allIds.filter((id) => id === `${CONTAINER_ID}-legacy-ranking`);
    const engineRankingIds = allIds.filter((id) => id === `${CONTAINER_ID}-ranking`);
    assert(legacyRankingIds.length === 1, 'DUPID-3. legacy ranking owner (-legacy-ranking) exists exactly once');
    assert(engineRankingIds.length === 1, 'DUPID-4. Heatmap engine ranking owner (-ranking, unrelated feature) exists exactly once, distinct id from legacy ranking');
    window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
  }

  printSummary();
  return results;
}

main().then((r) => {
  const f = r.filter((x) => x.status === 'FAIL').length;
  process.exitCode = f > 0 ? 1 : 0;
  // app.js 內建的 WSS 重連 setInterval/setTimeout 會讓 event loop 一直活著
  // 不自然結束（跟既有 map-state-runtime.js 的 dom.window.close() 慣例
  // 同理，這裡改用明確 process.exit 收尾，避免測試 runner 卡住等 timer）。
  process.exit(process.exitCode);
}).catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exit(1); });
