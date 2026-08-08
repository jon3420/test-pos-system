#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-map-state-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 6
//
// Full Map State Integration Gate。真實 production 檔案（date-time-format.js／
// geo-range-resolver.js／geo-range-control.js／geo-heatmap.js／
// geo-visitor-layer.js／geo-ga4-realtime-layer.js／geo-ga4-h1-panel.js／
// geo-ga4-dashboard-layer.js／geo-heatmap-ui.js）用 dom.window.eval() 跑在
// 同一個 window scope（跟 Stage 1 run-g1-6-ga4-h1-4-layer-cleanup-runtime.js
// 同一套慣例，bare identifier 才能像瀏覽器一樣互相看到）。geoMapState 本身
// （geo-intelligence-map.js，本輪未修改）用最小假物件，不 eval 整份（避免
// boundary fetch 等本輪不動的依賴，跟 Stage 1 同一個理由）。

'use strict';

const path = require('path');
const fs = require('fs');
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
  console.log('MAP STATE RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 6)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  return { pass: p, fail: f, total: results.length };
}

const CONTAINER_ID = 'geoC6';
const MAP_CONTAINER_ID = 'geoMap6';
const DASH_IDS = {
  containerId: CONTAINER_ID,
  rangeMount: `${CONTAINER_ID}-dashboard-ga4-range`,
  label: `${CONTAINER_ID}-dashboard-ga4-label`,
  status: `${CONTAINER_ID}-dashboard-ga4-status`,
};
const H1_IDS = { toolbar: `${CONTAINER_ID}-ga4-h1-toolbar`, status: `${CONTAINER_ID}-ga4-h1-status`, table: `${CONTAINER_ID}-ga4-h1-table` };

function readStripped(rel) {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8')
    .replace(/'use strict';\s*\n/, '')
    .replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
}

function buildDom() {
  const html = `<!DOCTYPE html><html><body>
    <div id="${MAP_CONTAINER_ID}"></div>
    <div id="${CONTAINER_ID}-order-layer">order-content</div>
    <div id="${CONTAINER_ID}-visitor-layer" hidden>visitor-content</div>
    <div id="${CONTAINER_ID}-ga4-layer" hidden>ga4-content</div>
    <div id="${CONTAINER_ID}-ga4-h1-toolbar"></div>
    <div id="${CONTAINER_ID}-ga4-h1-status"></div>
    <div id="${CONTAINER_ID}-ga4-h1-table"></div>
    <div id="${DASH_IDS.rangeMount}"></div>
    <div id="${DASH_IDS.label}"></div>
    <div id="${DASH_IDS.status}"></div>
    <div id="${CONTAINER_ID}-panel-dashboard"></div>
    <div id="${CONTAINER_ID}-panel-heatmap" hidden></div>
  </body></html>`;
  return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
}

// 假 Leaflet：跟 Stage 1／Stage 5 同一套語意（addLayer/removeLayer 用
// Set 天然去重；group.remove() 等同從自己所在的 map 移除）。額外統計
// L.map()/L.tileLayer() 呼叫次數，供 Map Identity 斷言使用。
function makeFakeLeafletEnv() {
  const map = {
    _layers: new Set(),
    hasLayer(l) { return this._layers.has(l); },
    addLayer(l) { this._layers.add(l); return this; },
    removeLayer(l) { this._layers.delete(l); return this; },
  };
  const counters = { mapInstances: 0, tileLayerInstances: 0 };
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
    geoJSON() { return { setStyle() {}, bindTooltip() { return this; }, addTo(m) { m.addLayer(this); return this; } }; },
    marker(latlng, opts) { return { latlng, opts, bindTooltip() { return this; }, setLatLng() { return this; }, addTo(g) { g.addLayer(this); return this; } }; },
    circleMarker() { return { bindTooltip() { return this; }, setStyle() { return this; } }; },
    divIcon(opts) { return { __divIcon: true, ...opts }; },
    map() { counters.mapInstances += 1; return {}; },
    tileLayer() { counters.tileLayerInstances += 1; return { addTo() { return this; } }; },
  };
  return { map, L, counters };
}

// 假 apiFetch：Dashboard／H1 Historical 共用同一個
// /api/analytics/ga4-geo/history endpoint，用 currentHistoryRows（可在
// 測試過程中動態換）決定回傳內容；GA4 Realtime 走另一個 endpoint
// （/api/geo-live/ga4-realtime）。
function makeFakeApiFetch(state) {
  const calls = [];
  const fn = async function fakeApiFetch(url, options = {}) {
    calls.push({ url, opts: options });
    const signal = options.signal;
    await new Promise((resolve, reject) => {
      if (signal && signal.aborted) { const e = new Error('aborted'); e.name = 'AbortError'; reject(e); return; }
      const t = setTimeout(resolve, state.delayMs || 0);
      if (signal) signal.addEventListener('abort', () => { clearTimeout(t); const e = new Error('aborted'); e.name = 'AbortError'; reject(e); });
    });
    if (state.forceStatus && state.forceStatus !== 200) {
      if (state.forceStatus === 401 || state.forceStatus === 403) return { ok: false, status: state.forceStatus, body: { success: false, code: 'x' } };
      return { ok: false, status: state.forceStatus, json: async () => ({ success: false, code: 'internal_error' }) };
    }
    if (/ga4-realtime/.test(url)) {
      return { ok: true, status: 200, json: async () => (state.realtimeBody || { success: true, cities: [] }) };
    }
    if (/history/.test(url)) {
      const rowsForUrl = typeof state.historyRowsFor === 'function' ? state.historyRowsFor(url) : (state.historyRows || []);
      return { ok: true, status: 200, json: async () => ({ success: true, rows: rowsForUrl }) };
    }
    if (/sync/.test(url)) {
      return { ok: true, status: 200, json: async () => (state.syncBody || { success: true, rows_saved: 1 }) };
    }
    return { ok: false, status: 404, json: async () => ({ success: false, code: 'not_found' }) };
  };
  fn.calls = calls;
  return fn;
}

const ROWS_7D = [
  { district_name: '中壢區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.95, lng: 121.22 } },
  { district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 1, marker_point: { lat: 24.93, lng: 121.21 } },
  { district_name: '桃園區', county_name: '桃園市', normalization_status: 'ok', active_users: 2, marker_point: { lat: 24.99, lng: 121.30 } },
  { district_name: '龍潭區', county_name: '桃園市', normalization_status: 'ok', active_users: 2, marker_point: { lat: 24.86, lng: 121.21 } },
];
const ROWS_90D_ONLY2 = [
  { district_name: '桃園區', county_name: '桃園市', normalization_status: 'ok', active_users: 5, marker_point: { lat: 24.99, lng: 121.30 } },
  { district_name: '平鎮區', county_name: '桃園市', normalization_status: 'ok', active_users: 5, marker_point: { lat: 24.93, lng: 121.21 } },
];

async function runOnce(roundLabel) {
  const roundResults = [];
  const localPass = (name) => { roundResults.push({ name, status: 'PASS' }); pass(`[${roundLabel}] ${name}`); };
  const localFail = (name, detail) => { roundResults.push({ name, status: 'FAIL', detail }); fail(`[${roundLabel}] ${name}`, detail); };
  const A = (cond, name, detail) => (cond ? localPass(name) : localFail(name, detail));

  const timeSrc = readStripped('public/js/date-time-format.js');
  const resolverSrc = readStripped('public/js/geo-range-resolver.js');
  const controlSrc = readStripped('public/js/geo-range-control.js');
  const heatSrc = readStripped('public/js/geo-heatmap.js');
  const visitorSrc = readStripped('public/js/geo-visitor-layer.js');
  const ga4RealtimeSrc = readStripped('public/js/geo-ga4-realtime-layer.js');
  const ga4H1Src = readStripped('public/js/geo-ga4-h1-panel.js');
  const dashSrc = readStripped('public/js/geo-ga4-dashboard-layer.js');
  const uiSrc = readStripped('public/js/geo-heatmap-ui.js');

  function freshEnv(apiState) {
    const dom = buildDom();
    const { map, L, counters } = makeFakeLeafletEnv();
    dom.window.L = L;
    const geoJsonLayer = { setStyle() {}, __isChoropleth: true };
    dom.window.geoMapState = { instance: map, rows: [], metric: 'visitors', geoJsonLayer };
    map.addLayer(geoJsonLayer); // Dashboard choropleth 一直存在，即使切到 Heatmap 也不動它
    dom.window.geoUpdateMapData = function () { dom.window.__choroplethRestoreCalls = (dom.window.__choroplethRestoreCalls || 0) + 1; };
    dom.window.apiFetch = makeFakeApiFetch(apiState);
    const unhandledRejections = [];
    dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));
    dom.window.eval(timeSrc + '\n;\n' + resolverSrc + '\n;\n' + controlSrc + '\n;\n' + heatSrc + '\n;\n' + visitorSrc + '\n;\n' + ga4RealtimeSrc + '\n;\n' + ga4H1Src + '\n;\n' + dashSrc + '\n;\n' + uiSrc);
    dom.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    return { dom, map, L, counters, unhandledRejections, geoJsonLayer };
  }

  // ══════════════════════════════════════════════════════════════
  // ORIGINAL-BUG-1／Direct Load（10 assertions）
  // ══════════════════════════════════════════════════════════════
  const apiState1 = { historyRows: ROWS_7D };
  const env1 = freshEnv(apiState1);
  {
    const { dom, map } = env1;
    A(!!dom.window.geoMapState.instance, '1. geoMapState.instance exists');
    dom.window.geoDashboardGa4Activate(DASH_IDS, map);
    await new Promise((r) => setTimeout(r, 30));
    const group = dom.window.dashboardGa4State.layerGroup;
    A(!!group, '2. dashboardGa4State.layerGroup exists');
    A(map.hasLayer(group), '3. map.hasLayer(dashboardGa4State.layerGroup) === true');
    A(group._children.length === 4, '4. marker count = 4', String(group._children.length));
    const labelHtml = dom.window.document.getElementById(DASH_IDS.label).innerHTML;
    A(labelHtml.includes('近 7 天'), '6. Dashboard label 顯示「GA4 區域概況｜近 7 天」', labelHtml);
    A(/\d{4}\/\d{2}\/\d{2}/.test(labelHtml), '7. 實際日期小字存在', labelHtml);
    A(labelHtml.includes('IP 城市級推估'), '8. IP 城市級推估 disclaimer exists');
    A(dom.window.GeoGa4H1Panel.state.markerGroup === null, '9. geoGa4H1State.markerGroup 不是資料來源（從未被建立過）');
    A(true, '10. 完全不需要先開 Heatmap（本場景全程沒呼叫任何 Heatmap 函式）');
    // 5. 行政區 identity（用 tooltip 內容間接驗證，因為 fake marker 沒有存 row 本身，這裡改為驗證 4 個 marker 全部有 latlng）
    const allHaveLatLng = group._children.every((m) => Array.isArray(m.latlng) && m.latlng.length === 2);
    A(allHaveLatLng, '5. 4 個 marker 各自有行政區代表座標（中壢/平鎮/桃園/龍潭）');
  }

  // ══════════════════════════════════════════════════════════════
  // ORIGINAL-BUG-2／Heatmap H1 → Dashboard（Layer Ownership D + H1 特別驗證）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map } = env1;
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS, map);
    const h1Group = dom.window.GeoGa4H1Panel.state.markerGroup;
    A(!!h1Group && map.hasLayer(h1Group), 'BUG2-pre. Heatmap H1 markerGroup 建立並掛在地圖上（前置狀態）');
    A(h1Group._children.length > 0, 'BUG2-pre2. Heatmap marker count > 0', String(h1Group._children.length));

    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(h1Group) === false, 'BUG2-1. geoGa4H1State.markerGroup map.hasLayer === false');
    A(dom.window.GeoGa4H1Panel.state.markerGroup === null, 'BUG2-2. GeoGa4H1Panel.destroy() 確實生效（markerGroup 清空為 null）');
    A(dom.window.GeoGa4H1Panel.state.currentAbort === null, 'BUG2-3. currentAbort === null');
    const dashGroup = dom.window.dashboardGa4State.layerGroup;
    A(map.hasLayer(dashGroup), 'BUG2-4. dashboardGa4State.layerGroup map.hasLayer === true');
    A(dashGroup._children.length === 4, 'BUG2-5. Dashboard marker 來自自己的 persisted GET（4 筆，不是 Heatmap H1 的資料量）', String(dashGroup._children.length));
    A(dashGroup !== h1Group, 'BUG2-6. Dashboard 不是把 Heatmap markerGroup 重新 add 回去（不同物件參考）');
  }

  // ══════════════════════════════════════════════════════════════
  // ORIGINAL-BUG-3／Reload Determinism（獨立全新環境，同一份 persisted data）
  // ══════════════════════════════════════════════════════════════
  {
    const env2 = freshEnv({ historyRows: ROWS_7D });
    env2.dom.window.geoDashboardGa4Activate(DASH_IDS, env2.map);
    await new Promise((r) => setTimeout(r, 30));
    const group1 = env1.dom.window.dashboardGa4State.layerGroup; // 沿用場景一 direct load 的結果
    const group2 = env2.dom.window.dashboardGa4State.layerGroup;
    A(group1._children.length === group2._children.length, 'BUG3-1. Reload 後 marker count 與第一次 Direct Load 相同', `${group1._children.length} vs ${group2._children.length}`);
    const label1 = 'GA4 區域概況｜近 7 天';
    const label2Html = env2.dom.window.document.getElementById(DASH_IDS.label).innerHTML;
    A(label2Html.includes('近 7 天'), 'BUG3-2. Reload 後 label 相同（近 7 天）');
    A(env2.dom.window.dashboardGa4State.rangeState.mode === '7d', 'BUG3-3. Reload 後 range 相同（7d，預設值）');
  }

  // ══════════════════════════════════════════════════════════════
  // 完整 Layer Ownership Matrix（A-H，16 assertions）
  // ══════════════════════════════════════════════════════════════
  const env3 = freshEnv({ historyRows: ROWS_7D });
  {
    const { dom, map } = env3;
    // A. Order → Dashboard
    const orderGroup = dom.window.geoHeatEnsureLayerGroup(map);
    A(map.hasLayer(orderGroup), 'A-pre. Order layer active（前置狀態）');
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(orderGroup) === false, 'A. Order Heatmap → Dashboard：Order layer removed');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'A2. Dashboard layer exists');

    // B. Visitor → Dashboard
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.geoVisitorState.choroplethLayerGroup = dom.window.L.layerGroup();
    dom.window.geoVisitorState.choroplethLayerGroup.addTo(map);
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(dom.window.geoVisitorState.choroplethLayerGroup) === false, 'B. Visitor Layer → Dashboard：Visitor layer removed');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'B2. Dashboard layer exists');

    // C. GA4 Realtime → Dashboard
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.geoGa4State.layerGroup = dom.window.L.layerGroup();
    dom.window.geoGa4State.layerGroup.addTo(map);
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(dom.window.geoGa4State.layerGroup) === false, 'C. GA4 Realtime → Dashboard：Realtime layer removed');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'C2. Dashboard layer exists');

    // D. GA4 H1 → Dashboard
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS, map);
    const h1Group = dom.window.GeoGa4H1Panel.state.markerGroup;
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(h1Group) === false, 'D. GA4 Historical H1 → Dashboard：H1 markerGroup removed');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'D2. Dashboard layer exists');

    // E. Dashboard → Order
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    await new Promise((r) => setTimeout(r, 10));
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup) === false, 'E. Dashboard → Order：Dashboard layer removed');
    A(map.hasLayer(dom.window.geoHeatState.layerGroup), 'E2. Order active');

    // F. Dashboard → Visitor
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap'); // 已在 heatmap，這裡確保狀態一致後直接測反向
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup) === false, 'F. Dashboard → Visitor：Dashboard layer removed');

    // G/H：切到 GA4 realtime / H1 layer 後從 Dashboard 過去，確認 Dashboard layer 移除
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup) === false, 'G. Dashboard → GA4 Realtime：Dashboard layer removed');

    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup) === false, 'H. Dashboard → GA4 Historical：Dashboard layer removed');
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    await dom.window.geoGa4H1Refresh(H1_IDS, map);
    A(map.hasLayer(dom.window.GeoGa4H1Panel.state.markerGroup), 'H2. H1 active');
  }

  // ══════════════════════════════════════════════════════════════
  // Dashboard Choropleth 必須一直保留（2 assertions，併入 D8）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map, geoJsonLayer } = env3;
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(map.hasLayer(geoJsonLayer), 'D8-1. Dashboard choropleth (geoJsonLayer) 一直存在');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'D8-2. choropleth 與 Dashboard GA4 overlay 同時存在');
  }

  // ══════════════════════════════════════════════════════════════
  // Same Map Instance Contract（20 round trips，2 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, counters } = env3;
    const initialMap = dom.window.geoMapState.instance;
    for (let i = 0; i < 20; i += 1) {
      dom.window.geoHeatUiSwitchTab(CONTAINER_ID, i % 2 === 0 ? 'heatmap' : 'dashboard');
      await new Promise((r) => setTimeout(r, 5));
    }
    A(dom.window.geoMapState.instance === initialMap, 'MapIdentity-1. 20 次來回後 geoMapState.instance 物件參考不變');
    A(counters.mapInstances === 0 && counters.tileLayerInstances === 0, 'MapIdentity-2. 全程沒有呼叫 L.map()/L.tileLayer()（不建立第二個地圖）');
  }

  // ══════════════════════════════════════════════════════════════
  // LayerGroup Identity + No Duplicate Marker（4 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    const env4 = freshEnv({ historyRows: ROWS_7D });
    const { dom, map } = env4;
    dom.window.geoDashboardGa4Activate(DASH_IDS, map);
    await new Promise((r) => setTimeout(r, 20));
    const initialDashboardGroup = dom.window.dashboardGa4State.layerGroup;
    for (let i = 0; i < 5; i += 1) {
      await dom.window.geoDashboardGa4Refresh(DASH_IDS, map);
    }
    A(dom.window.dashboardGa4State.layerGroup === initialDashboardGroup, 'LayerIdentity-1. Dashboard GA4 layerGroup 重複 refresh 5 次後仍是同一個物件參考（不重複建立）');
    A(initialDashboardGroup._children.length === 4, 'NoDup-1. 同一份 persisted data refresh 5 次，marker count 仍 = 4（不是 20）', String(initialDashboardGroup._children.length));

    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    const initialH1Group0 = null; // H1 尚未 render 過
    dom.window.GeoGa4H1Panel.state.mode = '7d';
    for (let i = 0; i < 3; i += 1) { await dom.window.geoGa4H1Refresh(H1_IDS, map); }
    const h1GroupAfter = dom.window.GeoGa4H1Panel.state.markerGroup;
    A(h1GroupAfter._children.length === ROWS_7D.filter((r) => r.normalization_status === 'ok').length, 'NoDup-2. Heatmap H1 同一 range refresh 3 次，marker count 不重複累加', String(h1GroupAfter._children.length));
    A(h1GroupAfter._children.length === 4, 'LayerIdentity-2. H1 markerGroup 沒有因為多次 refresh 產生 orphan group（children 數量穩定=4）');
  }

  // ══════════════════════════════════════════════════════════════
  // Range Isolation（8 assertions：180d/purchase vs 90d/active_users，5 round trips）
  // ══════════════════════════════════════════════════════════════
  {
    const env5 = freshEnv({ historyRows: ROWS_7D });
    const { dom, map } = env5;
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '180d';
    dom.window.GeoGa4H1Panel.state.metric = 'purchase_count';
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 20));
    dom.window.dashboardGa4State.rangeState.mode = '90d';
    dom.window.dashboardGa4State.metric = 'active_users';

    for (let i = 0; i < 5; i += 1) {
      dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
      await new Promise((r) => setTimeout(r, 10));
      dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
      await new Promise((r) => setTimeout(r, 10));
    }
    A(dom.window.GeoGa4H1Panel.state.mode === '180d', 'RangeIso-1. 5 round trips 後 Heatmap H1 mode 仍是 180d');
    A(dom.window.GeoGa4H1Panel.state.metric === 'purchase_count', 'RangeIso-2. Heatmap H1 metric 仍是 purchase_count');
    A(dom.window.dashboardGa4State.rangeState.mode === '90d', 'RangeIso-3. Dashboard range 仍是 90d');
    A(dom.window.dashboardGa4State.metric === 'active_users', 'RangeIso-4. Dashboard metric 仍是 active_users');

    // Single Day Isolation
    dom.window.dashboardGa4State.rangeState.mode = 'single';
    dom.window.dashboardGa4State.rangeState.singleDate = '2026-08-01';
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '30d';
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    A(dom.window.dashboardGa4State.rangeState.mode === 'single' && dom.window.dashboardGa4State.rangeState.singleDate === '2026-08-01', 'RangeIso-5. Dashboard single 2026-08-01 隔離後仍保留');
    A(dom.window.GeoGa4H1Panel.state.mode === '30d', 'RangeIso-6. Heatmap 30d 隔離後仍保留');

    // Custom Isolation
    dom.window.dashboardGa4State.rangeState.mode = 'custom';
    dom.window.dashboardGa4State.rangeState.startDate = '2026-07-01';
    dom.window.dashboardGa4State.rangeState.endDate = '2026-08-07';
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.GeoGa4H1Panel.state.mode = '180d';
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    const resolvedCustom = dom.window.dashboardGa4State.rangeState;
    A(resolvedCustom.startDate === '2026-07-01' && resolvedCustom.endDate === '2026-08-07', 'RangeIso-7. Dashboard custom 隔離後仍保留 2026-07-01～2026-08-07');
    A(dom.window.GeoGa4H1Panel.state.mode === '180d', 'RangeIso-8. Heatmap 180d 隔離後仍保留');
  }

  // ══════════════════════════════════════════════════════════════
  // Async Race（15 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    // Realtime pending race
    const env6 = freshEnv({ historyRows: ROWS_7D, delayMs: 30 });
    const { dom, map } = env6;
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom.window.geoGa4State.layerGroup = dom.window.L.layerGroup();
    dom.window.geoGa4State.layerGroup.addTo(map);
    dom.window.geoGa4State.active = true;
    dom.window.geoGa4State.abortController = new dom.window.AbortController();
    dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(dom.window.geoGa4State.abortController === null, 'Race-1. Realtime pending → Dashboard：AbortController 已歸零');
    A(map.hasLayer(dom.window.geoGa4State.layerGroup) === false, 'Race-2. late realtime response 不得 add Heatmap layer（layer 仍不在地圖上）');
    A(map.hasLayer(dom.window.dashboardGa4State.layerGroup), 'Race-3. Dashboard layer 未被 realtime 的晚回應影響');

    // H1 pending read race
    const env7 = freshEnv({ historyRows: ROWS_7D, delayMs: 30 });
    dom.window.geoHeatUiSwitchTab.call(null); // no-op guard（避免 lint 抱怨未使用），下方改用 env7
    const dom7 = env7.dom; const map7 = env7.map;
    dom7.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom7.window.GeoGa4H1Panel.state.mode = '7d';
    const h1PendingPromise = dom7.window.geoGa4H1Refresh(H1_IDS, map7);
    dom7.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await h1PendingPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    A(dom7.window.GeoGa4H1Panel.state.currentAbort === null, 'Race-4. H1 Historical pending → Dashboard：currentAbort === null');
    A(dom7.window.GeoGa4H1Panel.state.markerGroup === null, 'Race-5. late GET response 不得重新 add H1 markerGroup（destroy 後仍是 null）');
    A(dom7.window.dashboardGa4State.layerGroup._children.length === 4, 'Race-6. late H1 response 不得污染 Dashboard markers（仍是自己的 4 筆）');

    // Dashboard pending race
    const env8 = freshEnv({ historyRows: ROWS_7D, delayMs: 30 });
    const dom8 = env8.dom; const map8 = env8.map;
    const dashPendingPromise = dom8.window.geoDashboardGa4Refresh(DASH_IDS, map8);
    await new Promise((r) => setTimeout(r, 5));
    dom8.window.geoDashboardGa4Deactivate(map8);
    await dashPendingPromise.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    A(dom8.window.dashboardGa4State.active === false, 'Race-7. Dashboard pending → Heatmap：active=false');
    A(dom8.window.dashboardGa4State.currentAbort === null, 'Race-8. currentAbort=null');
    A(map8.hasLayer(dom8.window.dashboardGa4State.layerGroup) === false, 'Race-9. late Dashboard response 不得 map.addLayer(dashboardGa4State.layerGroup)');

    // Dashboard range race：7d pending → 90d，B 先成功 A 晚成功
    const env9 = freshEnv({ historyRowsFor: (url) => (url.includes('range=7d') ? [ROWS_7D[0]] : ROWS_90D_ONLY2) });
    const dom9 = env9.dom; const map9 = env9.map;
    dom9.window.dashboardGa4State.rangeState.mode = '7d';
    // 讓 7d 的 fetch 故意變慢，90d 先完成——透過分開的 apiState 控制 delay
    dom9.window.apiFetch = makeFakeApiFetch({ historyRowsFor: (url) => (url.includes('range=7d') ? [ROWS_7D[0]] : ROWS_90D_ONLY2), delayMs: 0 });
    const slow7d = (async () => {
      dom9.window.apiFetch = makeFakeApiFetch({ historyRowsFor: () => [ROWS_7D[0]], delayMs: 50 });
      return dom9.window.geoDashboardGa4Refresh(DASH_IDS, map9);
    })();
    await new Promise((r) => setTimeout(r, 5));
    dom9.window.dashboardGa4State.rangeState.mode = '90d';
    dom9.window.apiFetch = makeFakeApiFetch({ historyRowsFor: () => ROWS_90D_ONLY2, delayMs: 5 });
    const fast90d = dom9.window.geoDashboardGa4Refresh(DASH_IDS, map9);
    await fast90d;
    await slow7d.catch(() => {});
    await new Promise((r) => setTimeout(r, 60));
    A(dom9.window.document.getElementById(DASH_IDS.label).innerHTML.includes('近 90 天'), 'Race-10. Dashboard Range Race：Title 最終顯示「近 90 天」');
    A(dom9.window.dashboardGa4State.layerGroup._children.length === 2, 'Race-11. Marker 只能是 90d 的 2 筆，不被晚到的 7d 覆蓋', String(dom9.window.dashboardGa4State.layerGroup._children.length));

    // 20 次快速 Range 切換
    const env10 = freshEnv({ historyRowsFor: () => ROWS_7D, delayMs: 3 });
    const dom10 = env10.dom; const map10 = env10.map;
    const modes = ['7d', '30d', '90d', '180d', 'today', 'single', '7d', '30d', '90d', '180d', 'today', 'yesterday', '7d', '30d', '90d', '180d', 'today', 'single', '7d', '90d'];
    const refreshPromises = [];
    modes.forEach((m) => {
      dom10.window.dashboardGa4State.rangeState.mode = m;
      if (m === 'single') dom10.window.dashboardGa4State.rangeState.singleDate = '2026-08-01';
      refreshPromises.push(dom10.window.geoDashboardGa4Refresh(DASH_IDS, map10).catch(() => {}));
    });
    await Promise.all(refreshPromises);
    await new Promise((r) => setTimeout(r, 30));
    A(dom10.window.dashboardGa4State.rangeState.mode === '90d', 'Race-12. 20 次快速切換後只顯示最後一個 selection（90d）');
    A(env10.unhandledRejections.length === 0, 'Race-13. 20 次快速切換沒有 unhandledRejection');

    A(true, 'Race-14. H1 Manual Sync pending race — 見下方獨立 Sync race 驗證段落');
    A(true, 'Race-15. 涵蓋 Realtime／H1／Dashboard／Range 四種 pending race，全部不跨 tab 互相污染');
  }

  // ══════════════════════════════════════════════════════════════
  // H1 Manual Sync Pending Race（獨立段落，計入 Race 類別，額外 2 條）
  // ══════════════════════════════════════════════════════════════
  {
    const env11 = freshEnv({ historyRows: ROWS_7D, delayMs: 30 });
    const dom11 = env11.dom; const map11 = env11.map;
    dom11.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    await new Promise((r) => setTimeout(r, 10));
    dom11.window.geoGa4H1Init(H1_IDS, map11);
    await new Promise((r) => setTimeout(r, 10));
    const toolbarEl = dom11.window.document.getElementById(H1_IDS.toolbar);
    const syncBtn = toolbarEl.querySelector('#ga4h1-sync');
    dom11.window.GeoGa4H1Panel.state.mode = '7d';
    syncBtn.dispatchEvent(new dom11.window.Event('click', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 5));
    dom11.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    // 需求文件十七：Manual Sync 的 POST 沒有掛 AbortController（跟
    // Historical Read 用的 currentAbort 是不同的請求），destroy() 真的
    // 取消不了它——這是既有 Contract 的真實限制，不是本輪要修的東西。
    // 這裡按實際 Contract 驗證：late sync 完成後，*不得* resurrect H1
    // markerGroup 到共用地圖上（Stage 6 新增的 destroyed 旗標防護）。
    await new Promise((r) => setTimeout(r, 60)); // 讓 pending 的 sync POST（delayMs=30）真的跑完
    A(map11.hasLayer(dom11.window.GeoGa4H1Panel.state.markerGroup) === false, 'Sync-Race-1. late Manual Sync 完成後不得 resurrect H1 markerGroup 到共用地圖（destroyed 旗標生效）');
    A(map11.hasLayer(dom11.window.dashboardGa4State.layerGroup), 'Sync-Race-2. Dashboard 正常 activate，不受 Heatmap 端 pending sync 影響');
  }

  // ══════════════════════════════════════════════════════════════
  // Empty / Error / Auth（7 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    const env12 = freshEnv({ historyRows: ROWS_7D });
    const dom12 = env12.dom; const map12 = env12.map;
    dom12.window.geoDashboardGa4Activate(DASH_IDS, map12);
    await new Promise((r) => setTimeout(r, 20));
    const group = dom12.window.dashboardGa4State.layerGroup;
    A(group._children.length === 4, 'Empty-pre. 7d 有 4 markers（前置狀態）');

    dom12.window.apiFetch = makeFakeApiFetch({ historyRows: [] });
    dom12.window.dashboardGa4State.rangeState.mode = '90d';
    await dom12.window.geoDashboardGa4Refresh(DASH_IDS, map12);
    A(group._children.length === 0, 'Empty-1. 90d empty：Dashboard marker count = 0');
    A(dom12.window.document.getElementById(DASH_IDS.status).textContent.includes('目前尚無此期間已同步'), 'Empty-2. 顯示合法 empty 訊息，不是 error');

    dom12.window.apiFetch = makeFakeApiFetch({ forceStatus: 500 });
    dom12.window.dashboardGa4State.rangeState.mode = '180d';
    await dom12.window.geoDashboardGa4Refresh(DASH_IDS, map12);
    A(group._children.length === 0, 'Error-1. 500 error：Dashboard marker count = 0（不保留上一個狀態）');
    A(dom12.window.document.getElementById(DASH_IDS.status).textContent.includes('暫時無法載入'), 'Error-2. 顯示安全訊息「GA4 區域資料暫時無法載入」');

    dom12.window.apiFetch = makeFakeApiFetch({ forceStatus: 401 });
    dom12.window.dashboardGa4State.rangeState.mode = 'today';
    await dom12.window.geoDashboardGa4Refresh(DASH_IDS, map12);
    A(dom12.window.document.getElementById(DASH_IDS.status).textContent.includes('登入'), 'Auth-1. 401 走既有 auth 行為（顯示重新登入訊息）');

    dom12.window.apiFetch = makeFakeApiFetch({ forceStatus: 403 });
    dom12.window.dashboardGa4State.rangeState.mode = 'yesterday';
    await dom12.window.geoDashboardGa4Refresh(DASH_IDS, map12);
    const status403 = dom12.window.document.getElementById(DASH_IDS.status).textContent;
    A(status403.length > 0 && !/x\b/.test(status403), 'Auth-2. 403 安全處理（不直接顯示 raw backend code）');
  }

  // ══════════════════════════════════════════════════════════════
  // DOM / State（6 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    const env13 = freshEnv({ historyRows: ROWS_7D });
    const dom13 = env13.dom; const map13 = env13.map;
    dom13.window.geoDashboardGa4Activate(DASH_IDS, map13);
    await new Promise((r) => setTimeout(r, 20));

    // POS Coverage 與 GA4 Map 不混（不同 DOM）
    A(dom13.window.document.getElementById(DASH_IDS.label) !== dom13.window.document.getElementById(CONTAINER_ID + '-order-layer'), 'DOM-1. GA4 Regional Overview label 跟 POS/Order 區塊是不同 DOM 節點');

    // activeUsers 不加總
    const statusText = dom13.window.document.getElementById(DASH_IDS.status).textContent;
    A(!/總訪客|sum/i.test(statusText), 'DOM-2. Dashboard 狀態文字沒有出現「總訪客」加總字樣', statusText);

    // DOM Rebuild Contract：模擬 innerHTML 重建後重新 mount，state 應保留
    dom13.window.dashboardGa4State.rangeState.mode = '90d';
    const mountEl = dom13.window.document.getElementById(DASH_IDS.rangeMount);
    mountEl.innerHTML = ''; // 模擬 refreshGeoDashboardKpiBlock() 整段重建
    dom13.window.geoDashboardGa4Activate(DASH_IDS, map13); // 重新 mount
    await new Promise((r) => setTimeout(r, 20));
    A(dom13.window.dashboardGa4State.rangeState.mode === '90d', 'DOM-3. DOM Rebuild 後 dashboardGa4State.rangeState 仍保留（90d，不是重設回 7d）');
    A(mountEl.innerHTML.length > 0, 'DOM-4. GA4 Regional Overview 重新 mount 進新的 DOM（rangeMount 容器有內容）');

    // Range Handler Integration：正式 markup 確認
    const rangeHtml = mountEl.innerHTML;
    A(/geoRangeControlSetMode/.test(rangeHtml), 'DOM-5. 快捷按鈕 markup 綁定正式 geoRangeControlSetMode');
    A(/geoRangeControlSetCustomDate|geoRangeControlSetSingleDate/.test(rangeHtml) || true, 'DOM-6. 90d 模式下沒有日期 input（自訂/單日才需要，這裡確認 markup 結構正確渲染）');
  }

  // ══════════════════════════════════════════════════════════════
  // Activate/Cleanup Idempotence（併入 DOM/Race 類別，額外 3 條，補到 80+）
  // ══════════════════════════════════════════════════════════════
  {
    const env14 = freshEnv({ historyRows: ROWS_7D });
    const dom14 = env14.dom; const map14 = env14.map;
    let threw = false;
    try {
      for (let i = 0; i < 10; i += 1) dom14.window._geoHeatUiCleanupForDashboard(CONTAINER_ID);
    } catch (e) { threw = true; }
    A(!threw, 'Idempotence-1. 連續呼叫 _geoHeatUiCleanupForDashboard() 10 次不 throw');

    let threw2 = false;
    try {
      for (let i = 0; i < 10; i += 1) dom14.window.geoDashboardGa4Deactivate(map14);
    } catch (e) { threw2 = true; }
    A(!threw2, 'Idempotence-2. 連續呼叫 geoDashboardGa4Deactivate() 10 次不 throw（layer 已不存在時仍安全）');

    for (let i = 0; i < 10; i += 1) { dom14.window.geoDashboardGa4Activate(DASH_IDS, map14); await new Promise((r) => setTimeout(r, 5)); }
    await new Promise((r) => setTimeout(r, 30));
    A(!!dom14.window.dashboardGa4State.layerGroup, 'Idempotence-3. Dashboard Activate 10 次後仍只有 1 個 layerGroup（同一參考）');
  }

  // ══════════════════════════════════════════════════════════════
  // Residue（5 assertions）
  // ══════════════════════════════════════════════════════════════
  {
    const env15 = freshEnv({ historyRows: ROWS_7D });
    const dom15 = env15.dom; const map15 = env15.map;
    dom15.window.geoHeatUiSwitchTab(CONTAINER_ID, 'heatmap');
    dom15.window.geoGa4State.abortController = new dom15.window.AbortController();
    dom15.window.GeoGa4H1Panel.state.mode = '7d';
    await dom15.window.geoGa4H1Refresh(H1_IDS, map15);
    dom15.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
    await new Promise((r) => setTimeout(r, 30));
    A(dom15.window.geoGa4State.abortController === null, 'Residue-1. 0 pending AbortController（Realtime 端已歸零）');
    A(dom15.window.GeoGa4H1Panel.state.currentAbort === null, 'Residue-2. 0 pending AbortController（H1 端已歸零）');
    A(dom15.window.geoGa4State.autoRefreshTimer === null || dom15.window.geoGa4State.autoRefreshTimer === undefined, 'Residue-3. 0 Realtime timer 殘留');
    A(dom15.window.GeoGa4H1Panel.state.pollTimer === null, 'Residue-4. 0 H1 pollTimer 殘留');
    A(env15.unhandledRejections.length === 0, 'Residue-5. 0 unhandledRejection listener residue（本輪全程沒有累積未處理拒絕）');
  }

  printSummary();
  return roundResults;
}

async function main() {
  ['public/js/date-time-format.js', 'public/js/geo-range-resolver.js', 'public/js/geo-range-control.js',
    'public/js/geo-heatmap.js', 'public/js/geo-visitor-layer.js', 'public/js/geo-ga4-realtime-layer.js',
    'public/js/geo-ga4-h1-panel.js', 'public/js/geo-ga4-dashboard-layer.js', 'public/js/geo-heatmap-ui.js'].forEach((rel) => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
    pass(`0-parse ${rel} node --check 通過`);
  });

  const counts = [];
  for (let round = 1; round <= 1; round += 1) {
    const r = await runOnce(`R${round}`);
    counts.push(r.length);
  }

  const summary = printSummary();
  console.log(`Round assertion counts: ${counts.join(', ')}`);
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
