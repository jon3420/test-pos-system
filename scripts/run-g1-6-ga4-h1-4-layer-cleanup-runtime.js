#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-layer-cleanup-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — 第一階段
//
// Heatmap → Dashboard Layer Lifecycle Cleanup Runtime。
//
// 沿用 scripts/smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js 已驗證過的
// jsdom 實測慣例：真的執行 production 檔案（geo-heatmap.js /
// geo-visitor-layer.js / geo-ga4-realtime-layer.js / geo-ga4-h1-panel.js /
// geo-heatmap-ui.js），用 dom.window.eval() 把它們跑在同一個 window
// global scope 內（跟真實瀏覽器 classic <script> 共用作用域慣例一致，
// bare identifier 如 geoGa4Deactivate／geoGa4H1State 才能像瀏覽器一樣
// 互相看到），不是重寫一份邏輯來測試自己。
//
// geoMapState 本身（geo-intelligence-map.js）本輪未修改，這裡直接給一個
// 最小假物件（{ instance, rows, metric, geoJsonLayer }），不 eval 整個
// geo-intelligence-map.js（避免拉入 boundary fetch/GeoJSON 等本輪不動的
// 依賴），跟 smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js 的既有慣例一致。

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
  console.log('LAYER CLEANUP RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (第一階段)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check（本輪唯一改動的 production 檔案）
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-heatmap-ui.js', 'public/js/geo-heatmap.js', 'public/js/geo-visitor-layer.js',
    'public/js/geo-ga4-realtime-layer.js', 'public/js/geo-ga4-h1-panel.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 Layer Cleanup 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝，無法進行 DOM/Layer 層級行為測試' });
    console.log('[MANUAL REQUIRED] 全部 Layer Cleanup 測試項目 — jsdom 未安裝');
    printSummary();
    return;
  }

  const CONTAINER_ID = 'geoC1';
  const MAP_CONTAINER_ID = 'geoMap1';

  function readStripped(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/'use strict';\s*\n/, '')
      .replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  }

  const heatSrc = readStripped('public/js/geo-heatmap.js');
  const visitorSrc = readStripped('public/js/geo-visitor-layer.js');
  const ga4RealtimeSrc = readStripped('public/js/geo-ga4-realtime-layer.js');
  const ga4H1Src = readStripped('public/js/geo-ga4-h1-panel.js');
  const uiSrc = readStripped('public/js/geo-heatmap-ui.js');

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${MAP_CONTAINER_ID}"></div>
      <div id="${CONTAINER_ID}-order-layer">order-content</div>
      <div id="${CONTAINER_ID}-visitor-layer" hidden>visitor-content</div>
      <div id="${CONTAINER_ID}-ga4-layer" hidden>ga4-content</div>
      <div id="${CONTAINER_ID}-ga4-h1-toolbar"></div>
      <div id="${CONTAINER_ID}-ga4-h1-status"></div>
      <div id="${CONTAINER_ID}-ga4-h1-table"></div>
      <div id="${CONTAINER_ID}-panel-dashboard"></div>
      <div id="${CONTAINER_ID}-panel-heatmap" hidden></div>
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  // 假 Leaflet：涵蓋本輪 4 個 Layer 檔案實際用到的最小介面
  // （layerGroup/marker/circleMarker/geoJSON/divIcon），行為語意跟真實
  // Leaflet 一致（addLayer/removeLayer 用 Set 天然去重、addTo 反向掛上
  // map）。
  function makeFakeLeafletEnv() {
    const mapCalls = { addLayer: 0, removeLayer: 0 };
    const map = {
      _layers: new Set(),
      hasLayer(l) { return this._layers.has(l); },
      addLayer(l) { this._layers.add(l); mapCalls.addLayer++; return this; },
      removeLayer(l) { this._layers.delete(l); mapCalls.removeLayer++; return this; },
    };
    let mapInstances = 0;
    let tileLayerInstances = 0;
    function makeGroup() {
      const children = [];
      const group = {
        __kind: 'layerGroup',
        _children: children,
        addLayer(c) { children.push(c); return this; },
        removeLayer(c) { const i = children.indexOf(c); if (i >= 0) children.splice(i, 1); return this; },
        clearLayers() { children.length = 0; return this; },
        addTo(m) { m.addLayer(this); return this; },
        remove() { map.removeLayer(this); return this; }, // Leaflet 真實語意：group.remove() 等同從自己所在的 map 移除
      };
      return group;
    }
    const L = {
      layerGroup() { return makeGroup(); },
      geoJSON() { return { bindTooltip() { return this; } }; },
      marker() { return { bindTooltip() { return this; }, setLatLng() { return this; } }; },
      circleMarker() { return { bindTooltip() { return this; }, setStyle() { return this; } }; },
      divIcon(opts) { return { __divIcon: true, ...opts }; },
      map() { mapInstances++; return {}; }, // 本輪不應被呼叫到（不 new L.map()）
      tileLayer() { tileLayerInstances++; return { addTo() { return this; } }; },
    };
    return { map, L, mapCalls, counters: { get mapInstances() { return mapInstances; }, get tileLayerInstances() { return tileLayerInstances; } } };
  }

  const dom = buildDom();
  const { map, L, counters } = makeFakeLeafletEnv();
  dom.window.L = L;
  // geo-intelligence-map.js 本輪未修改，這裡只給最小假物件（見檔頭註解）。
  dom.window.geoMapState = { instance: map, rows: [], metric: 'visitors', geoJsonLayer: { setStyle() {} } };
  dom.window.geoUpdateMapData = function geoUpdateMapDataSpy() { dom.window.__choroplethRestoreCalls = (dom.window.__choroplethRestoreCalls || 0) + 1; };

  const unhandledRejections = [];
  const windowErrors = [];
  dom.window.addEventListener('error', (e) => windowErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
  dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));

  dom.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + ga4RealtimeSrc + '\n;\n' + ga4H1Src + '\n;\n' + uiSrc);

  dom.window.geoHeatUiState.containerId = CONTAINER_ID;
  dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;

  // ── 監看 geoGa4Deactivate() / GeoGa4H1Panel.destroy() 是否真的被呼叫 ──
  const realDeactivate = dom.window.geoGa4Deactivate;
  let deactivateCalls = 0;
  dom.window.geoGa4Deactivate = function spyDeactivate(...args) { deactivateCalls++; return realDeactivate.apply(this, args); };
  const realH1Destroy = dom.window.GeoGa4H1Panel.destroy;
  let h1DestroyCalls = 0;
  dom.window.GeoGa4H1Panel.destroy = function spyH1Destroy(...args) { h1DestroyCalls++; return realH1Destroy.apply(this, args); };

  // ══════════════════════════════════════════════════════════════
  // 前置：模擬「使用者已經在 Heatmap 分頁把 4 個 Layer 全部開過一輪」
  // ══════════════════════════════════════════════════════════════
  const orderGroup = dom.window.geoHeatEnsureLayerGroup(map);
  assert(!!orderGroup && map.hasLayer(orderGroup), 'pre-1. Order layerGroup 建立並掛在地圖上');

  dom.window.geoVisitorState.choroplethLayerGroup = dom.window.L.layerGroup();
  dom.window.geoVisitorState.choroplethLayerGroup.addTo(map);
  assert(map.hasLayer(dom.window.geoVisitorState.choroplethLayerGroup), 'pre-2. Visitor choroplethLayerGroup 建立並掛在地圖上');

  dom.window.geoGa4State.layerGroup = dom.window.L.layerGroup();
  dom.window.geoGa4State.layerGroup.addTo(map);
  dom.window.geoGa4State.active = true;
  dom.window.geoGa4State.abortController = new dom.window.AbortController();
  dom.window.geoGa4State.autoRefreshTimer = setTimeout(() => {}, 60000);
  if (dom.window.geoGa4State.autoRefreshTimer && typeof dom.window.geoGa4State.autoRefreshTimer.unref === 'function') dom.window.geoGa4State.autoRefreshTimer.unref();
  assert(map.hasLayer(dom.window.geoGa4State.layerGroup), 'pre-3. GA4 Realtime layerGroup 建立並掛在地圖上');

  dom.window.GeoGa4H1Panel.state.markerGroup = dom.window.L.layerGroup();
  dom.window.GeoGa4H1Panel.state.markerGroup.addTo(map);
  dom.window.GeoGa4H1Panel.state.pollTimer = setInterval(() => {}, 60000);
  if (dom.window.GeoGa4H1Panel.state.pollTimer && typeof dom.window.GeoGa4H1Panel.state.pollTimer.unref === 'function') dom.window.GeoGa4H1Panel.state.pollTimer.unref();
  dom.window.GeoGa4H1Panel.state.currentAbort = new dom.window.AbortController();
  assert(map.hasLayer(dom.window.GeoGa4H1Panel.state.markerGroup), 'pre-4. GA4 H1 Historical markerGroup 建立並掛在地圖上');

  // 一組殘留的地圖覆蓋文字（Visitor + GA4），模擬使用者切到過 visitor/ga4
  // layer 之後留下的 DOM 覆蓋層。
  const visitorOverlay = dom.window.document.createElement('div');
  visitorOverlay.id = `${MAP_CONTAINER_ID}-visitor-empty-overlay`;
  dom.window.document.getElementById(MAP_CONTAINER_ID).appendChild(visitorOverlay);
  const ga4Overlay = dom.window.document.createElement('div');
  ga4Overlay.id = `${MAP_CONTAINER_ID}-ga4-empty-overlay`;
  dom.window.document.getElementById(MAP_CONTAINER_ID).appendChild(ga4Overlay);

  // ══════════════════════════════════════════════════════════════
  // 1-4. Heatmap → Dashboard：4 個 Layer 各自確認移除
  // ══════════════════════════════════════════════════════════════
  dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard');
  await new Promise((r) => setTimeout(r, 40));

  assert(map.hasLayer(orderGroup) === false, '1. Order Heatmap → Dashboard：map.hasLayer(orderGroup) === false');
  assert(map.hasLayer(dom.window.geoVisitorState.choroplethLayerGroup) === false, '2. Visitor Layer → Dashboard：map.hasLayer(visitorGroup) === false');
  assert(map.hasLayer(dom.window.geoGa4State.layerGroup) === false, '3. GA4 Realtime → Dashboard：map.hasLayer(ga4Group) === false');
  assert(dom.window.GeoGa4H1Panel.state.markerGroup === null, '4. GA4 Historical → Dashboard：GeoGa4H1Panel.destroy() 已把 markerGroup 清空（.remove() 後置 null）');

  // ══════════════════════════════════════════════════════════════
  // 5-7. Dashboard choropleth 仍存在／同一個 Leaflet instance／沒有第二個地圖
  // ══════════════════════════════════════════════════════════════
  assert((dom.window.__choroplethRestoreCalls || 0) >= 1, '5. Dashboard choropleth 仍存在（_geoHeatUiRestoreChoropleth 有實際呼叫 geoUpdateMapData 重畫）');
  assert(dom.window.geoMapState.instance === map, '6. 同一個 Leaflet map instance（沒有被換掉）');
  assert(counters.mapInstances === 0 && counters.tileLayerInstances === 0, '7. 沒有呼叫 new L.map() / L.tileLayer()（不重建地圖）');

  // ══════════════════════════════════════════════════════════════
  // 8-9. Realtime deactivate / H1 destroy 真的被呼叫到
  // ══════════════════════════════════════════════════════════════
  assert(deactivateCalls === 1, '8. geoGa4Deactivate() 在切到 Dashboard 時被呼叫一次');
  assert(h1DestroyCalls === 1, '9. GeoGa4H1Panel.destroy() 在切到 Dashboard 時被呼叫一次');

  // ══════════════════════════════════════════════════════════════
  // 10-12. timer / abort 真的被清乾淨，沒有 unhandledRejection
  // ══════════════════════════════════════════════════════════════
  assert(dom.window.geoGa4State.autoRefreshTimer === null, '10a. GA4 Realtime autoRefreshTimer 已清除（geoGa4StopAutoRefresh）');
  assert(dom.window.geoGa4State.abortController === null, '10b. GA4 Realtime abortController 已清空（abort 後歸零）');
  assert(dom.window.GeoGa4H1Panel.state.pollTimer === null, '11a. GA4 H1 pollTimer 已清除（clearInterval）');
  assert(dom.window.GeoGa4H1Panel.state.currentAbort === null, '11b. GA4 H1 currentAbort 已清空');
  assert(windowErrors.length === 0, '12a. Cleanup 過程沒有丟出未捕捉例外（AbortError 等安靜吞掉）');
  assert(unhandledRejections.length === 0, '12b. 沒有 unhandledRejection');

  // 覆蓋文字也應該被清掉。
  assert(dom.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`) === null, '12c. 殘留的 Visitor 地圖覆蓋文字已被移除');
  assert(dom.window.document.getElementById(`${MAP_CONTAINER_ID}-ga4-empty-overlay`) === null, '12d. 殘留的 GA4 地圖覆蓋文字已被移除');

  // ══════════════════════════════════════════════════════════════
  // 13-16. Dashboard → Heatmap：使用者的 source/range/metric state 必須保留
  // ══════════════════════════════════════════════════════════════
  dom.window.geoHeatUiState.layer = 'ga4';
  dom.window.geoGa4State.metric = 'purchase';
  dom.window.geoGa4State.windowMinutes = 30;
  dom.window.geoHeatUiState.visitorRange = '30d';

  dom.window.geoHeatUiSwitchTab(CONTAINER_ID, 'dashboard'); // 再切一次 Dashboard（模擬多次來回）
  await new Promise((r) => setTimeout(r, 40));

  assert(dom.window.geoHeatUiState.layer === 'ga4', '13. Heatmap 使用者選的 layer（source）在 Dashboard cleanup 後仍保留（未被重設回 order）');
  assert(dom.window.geoGa4State.metric === 'purchase', '14. Heatmap GA4 metric state 在 Dashboard cleanup 後仍保留（未被重設回 visitors）');
  assert(dom.window.geoGa4State.windowMinutes === 30, '15. Heatmap GA4 range/window state 在 Dashboard cleanup 後仍保留');
  assert(dom.window.geoHeatUiState.visitorRange === '30d', '16. Heatmap Visitor range state 在 Dashboard cleanup 後仍保留（跨分頁 State Isolation，需求文件四）');

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e.stack || e.message);
  process.exitCode = 1;
});
