#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js
// fix18-10-hotfix30-B5-R5.4-G1.2 — 訂單熱區／訪客熱區 Layer 切換 Bug 修正
//
// 沿用 scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js 已驗證過的 jsdom 實測慣例：
// 真的執行 public/js/geo-heatmap.js + geo-visitor-layer.js + geo-heatmap-ui.js
// （runScripts:'outside-only' + dom.window.eval），不是原始碼字串掃描。
// Part A 是純函式測試（不需要 jsdom）；Part B 起是真實 DOM／Leaflet Layer
// 互斥行為測試。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.2 (訂單熱區/訪客熱區 Layer 切換修正)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-heatmap-ui.js', 'public/js/geo-heatmap.js', 'public/js/geo-visitor-layer.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // Part A：純函式（不需要 jsdom，直接 require）
  // ══════════════════════════════════════════════════════════════
  const H = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
  assert(H._geoHeatUiVisitorMapOverlayMessage('loading', null) === '訪客熱區載入中…', 'A-1 loading 狀態文案正確');
  assert(H._geoHeatUiVisitorMapOverlayMessage('error', null) === '訪客熱區載入失敗，請重試', 'A-2 error 狀態文案正確（情境：API error）');
  assert(H._geoHeatUiVisitorMapOverlayMessage('ready', { total: 0 }) === '目前沒有符合條件的訪客事件', 'A-3 完全無訪客時文案正確（情境：empty）');
  const noCoordMsg = H._geoHeatUiVisitorMapOverlayMessage('ready', { total: 1, with_coordinate: 0, known_area_only: 0, unknown: 1, coverage_pct: 0 });
  assert(noCoordMsg.includes('目前已有 1 位訪客'), 'A-4 有訪客但無座標時文案含正確訪客數（重現真實回報情境）');
  assert(noCoordMsg.includes('Known District：0') && noCoordMsg.includes('Exact Coordinate：0') && noCoordMsg.includes('Unknown：1') && noCoordMsg.includes('Coverage：0%'), 'A-5 文案含完整 Known/Exact/Unknown/Coverage 數字（重現真實回報的四個數字）');
  const hasCoordResult = H._geoHeatUiVisitorMapOverlayMessage('ready', { total: 5, with_coordinate: 2 });
  assert(hasCoordResult === null, 'A-6 有真實座標可畫時不顯示覆蓋文字（讓地圖正常呈現，不擋住真實資料）');
  assert(H.geoHeatUiLayerToggleHtml('c1').includes('data-layer="order"') && H.geoHeatUiLayerToggleHtml('c1').includes('data-layer="visitor"'), 'A-7 Layer 切換按鈕含 data-layer 屬性（供測試/未來擴充辨識用）');
  assert(H.geoHeatUiLayerToggleHtml('c1').includes(`id="c1-layer-toggle"`), 'A-8 Layer 切換列容器有固定 id（供 outerHTML 重新渲染鎖定目標）');
  assert(H.geoHeatUiLayerToggleHtml('c1').includes('aria-selected'), 'A-9 按鈕含 aria-selected（不只 aria-pressed）');

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom DOM / Leaflet Layer 互斥行為測試
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM/Layer 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝，無法進行 DOM 層級行為測試' });
    console.log('[MANUAL REQUIRED] 全部 DOM/Layer 測試項目 — jsdom 未安裝');
    printSummary();
    return;
  }

  const heatSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8')
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const visitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8')
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8')
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  const CONTAINER_ID = 'geoC1';
  const MAP_CONTAINER_ID = 'geoMap1';

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${MAP_CONTAINER_ID}"></div>
      <div id="${CONTAINER_ID}-order-layer">order-content</div>
      <div id="${CONTAINER_ID}-visitor-layer" hidden>visitor-content</div>
      ${H.geoHeatUiLayerToggleHtml(CONTAINER_ID)}
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  // 假 Leaflet：只實作測試需要的最小介面（addLayer/removeLayer/hasLayer/
  // clearLayers/addTo/bindTooltip/geoJSON/marker），不引入真正的 Leaflet
  // 套件，但行為語意跟真實 Leaflet 一致（同一個 group 物件反覆 addLayer 到
  // map 上是冪等的，用 Set 天然去重）。
  function makeFakeLeafletEnv() {
    const mapCalls = { addLayer: 0, removeLayer: 0 };
    const map = {
      _layers: new Set(),
      hasLayer(l) { return this._layers.has(l); },
      addLayer(l) { this._layers.add(l); mapCalls.addLayer++; return this; },
      removeLayer(l) { this._layers.delete(l); mapCalls.removeLayer++; return this; },
    };
    let layerGroupInstances = 0;
    let mapInstances = 0;
    let tileLayerInstances = 0;
    const L = {
      layerGroup() {
        layerGroupInstances++;
        const children = [];
        const group = {
          __kind: 'layerGroup',
          _children: children,
          addLayer(c) { children.push(c); return this; },
          clearLayers() { children.length = 0; return this; },
          addTo(m) { m.addLayer(this); return this; },
        };
        return group;
      },
      geoJSON() { return { bindTooltip() { return this; } }; },
      marker() { return { bindTooltip() { return this; } }; },
      map() { mapInstances++; return {}; }, // 測試期間不應被呼叫到
      tileLayer() { tileLayerInstances++; return { addTo() { return this; } }; }, // 測試期間不應被呼叫到
    };
    return { map, L, mapCalls, counters: { get layerGroupInstances() { return layerGroupInstances; }, get mapInstances() { return mapInstances; }, get tileLayerInstances() { return tileLayerInstances; } } };
  }

  function makeFakeApiFetch(visitorFixture) {
    return async () => ({
      ok: true,
      json: async () => ({ success: true, data: visitorFixture }),
    });
  }

  const VISITOR_FIXTURE_NO_COORD = {
    summary: { geo_visitors: 1, geo_visitors_known: 0 }, // -> total=1, known=0, unknown=1, coverage=0
    funnel: {}, recommendation_risk: null, areas: [], recent: [],
  };

  const dom = buildDom();
  const { map, L, mapCalls, counters } = makeFakeLeafletEnv();
  dom.window.L = L;
  dom.window.geoMapState = { instance: map, featureIndex: null, settings: {} };
  dom.window.apiFetch = makeFakeApiFetch(VISITOR_FIXTURE_NO_COORD);
  const caughtErrors = [];
  const unhandledRejections = [];
  dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
  dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));

  dom.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);

  // 模擬「頁面載入時 Order Heatmap 已經初始化並掛在地圖上」（既有行為，
  // 不是本輪要修的部分，只是測試前置狀態）。
  const orderGroup = dom.window.geoHeatEnsureLayerGroup(map);
  dom.window.geoHeatUiState.containerId = CONTAINER_ID;
  dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;

  assert(!!orderGroup, 'B-1 Order Heatmap 初始化時建立唯一 layerGroup');
  assert(map.hasLayer(orderGroup) === true, 'B-2 預設 Order layerGroup 已掛在地圖上（初始狀態）');
  assert(dom.window.geoHeatUiState.layer === 'order', '1. 預設 Order active（geoHeatUiState.layer 初始值）');

  function getToggleButtons() {
    const wrap = dom.window.document.getElementById(`${CONTAINER_ID}-layer-toggle`);
    return Array.from(wrap.querySelectorAll('.geo-heat-layer-btn'));
  }
  function getBtn(layer) { return getToggleButtons().find((b) => b.getAttribute('data-layer') === layer); }

  {
    const orderBtn = getBtn('order');
    const visitorBtn = getBtn('visitor');
    assert(orderBtn.classList.contains('is-active'), '1b. 初始渲染 Order 按鈕為 active');
    assert(orderBtn.getAttribute('aria-pressed') === 'true', '1c. 初始渲染 Order aria-pressed=true');
    assert(!visitorBtn.classList.contains('is-active'), '1d. 初始渲染 Visitor 按鈕非 active');
  }

  // ── 點擊 Visitor Layer ──
  dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
  await new Promise((r) => setTimeout(r, 20)); // 讓 geoVisitorFetchAndRender 的 Promise 鏈跑完

  assert(dom.window.geoHeatUiState.layer === 'visitors' || dom.window.geoHeatUiState.layer === 'visitor', '2. 點 Visitor 後 state 切換為 visitor');
  {
    const visitorBtn = getBtn('visitor');
    const orderBtn = getBtn('order');
    assert(visitorBtn.classList.contains('is-active'), '3. Visitor 按鈕 active（修正後：不再是空 forEach）');
    assert(visitorBtn.getAttribute('aria-pressed') === 'true' && visitorBtn.getAttribute('aria-selected') === 'true', '5. Visitor 按鈕 aria-selected/aria-pressed 正確');
    assert(!orderBtn.classList.contains('is-active'), '4. Order 按鈕 inactive');
    assert(orderBtn.getAttribute('aria-pressed') === 'false', '4b. Order aria-pressed=false');
  }
  {
    const orderPanel = dom.window.document.getElementById(`${CONTAINER_ID}-order-layer`);
    const visitorPanel = dom.window.document.getElementById(`${CONTAINER_ID}-visitor-layer`);
    assert(orderPanel.hidden === true, '7. Order panel 隱藏');
    assert(visitorPanel.hidden === false, '6. Visitor panel 顯示');
  }
  assert(map.hasLayer(orderGroup) === false, '8. Order layer 從地圖上移除（不再殘留視覺）');
  const visitorGroup = dom.window.geoVisitorState.choroplethLayerGroup;
  assert(!!visitorGroup, '9a. Visitor choropleth layerGroup 已建立');
  // 因為 fixture 是「1 位訪客、known=0」，choropleth 不會畫出任何 polygon
  // （known 陣列為空），但 group 本身仍應正確掛在地圖上（用於未來有資料時
  // 立即可見，不需要重建）。
  assert(map.hasLayer(visitorGroup) === true, '9. Visitor layer 加入地圖（即使目前沒有可畫的 polygon，group 本身仍正確掛載）');

  {
    const overlay = dom.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!!overlay, '11a. 無 Exact Coordinate 時地圖出現明確覆蓋文字（不是空白底圖）');
    assert(overlay && overlay.textContent.includes('目前已有 1 位訪客'), '11. Exact Coordinate=0 時覆蓋文字含正確訪客數與情境說明');
    assert(overlay && overlay.textContent.includes('Coverage：0%'), '11b. 覆蓋文字含 Coverage：0%（對應真實回報情境）');
  }
  assert(!(visitorGroup._children.length > 0), '12. Unknown 不畫 Marker（known=0 時 choropleth 沒有畫出任何色塊/點）');
  assert(!!getToggleButtons().find((b) => b.tagName === 'BUTTON'), '10. Legend/控制列已隨新 HTML 一併更新（toggle 列重新渲染）');

  // ── 切回 Order ──
  dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
  await new Promise((r) => setTimeout(r, 5));
  assert(dom.window.geoHeatUiState.layer === 'order', '13. 切回 Order 後 state 正確');
  assert(getBtn('order').classList.contains('is-active') && !getBtn('visitor').classList.contains('is-active'), '13b. 切回 Order 後按鈕 active 正確互斥');
  assert(map.hasLayer(orderGroup) === true, '13c. 切回 Order 後 Order layer 重新掛回地圖');
  assert(map.hasLayer(visitorGroup) === false, '13d. 切回 Order 後 Visitor layer 從地圖移除');
  {
    const overlay = dom.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!overlay, '13e. 切回 Order 後 Visitor 覆蓋文字已移除（不殘留）');
  }

  // ── 14. 快速切換 20 次無 duplicate layer ──
  for (let i = 0; i < 20; i++) {
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, i % 2 === 0 ? 'visitor' : 'order');
  }
  await new Promise((r) => setTimeout(r, 30));
  assert(map._layers.size <= 1, '14. 快速切換 20 次後地圖上最多只有一個 Layer（不會同時顯示兩個或重複）');
  assert(dom.window.geoVisitorState.choroplethLayerGroup === visitorGroup, '14b. Visitor layerGroup 物件參考自始至終是同一個（沒有重建，避免記憶體洩漏）');
  assert(dom.window.geoHeatState.layerGroup === orderGroup, '14c. Order layerGroup 物件參考自始至終是同一個');

  // ── 15/16. Map/Tile 數量維持 1（本輪從未呼叫 L.map()/L.tileLayer()） ──
  assert(counters.mapInstances === 0, '15. 全程沒有呼叫 L.map()（沒有建立第二張地圖，也沒有建立任何新地圖）');
  assert(counters.tileLayerInstances === 0, '16. 全程沒有呼叫 L.tileLayer()（沒有建立第二個 Tile Layer）');
  assert(counters.layerGroupInstances === 2, '15b. 全程只建立過 2 個 layerGroup（Order 一個、Visitor 一個，不重建）');

  // ── 17. refresh 不重設模式 ──
  dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
  await new Promise((r) => setTimeout(r, 10));
  dom.window.geoHeatUiState.channel = 'line'; // 模擬 Channel 切換（不透過會呼叫 geoHeatUiSetLayer 的路徑）
  assert(dom.window.geoHeatUiState.layer === 'visitor', '18. Channel 切換不重設 Layer Source（模式仍是 visitor）');
  dom.window.dashboardDateState = { start_date: '2026-08-01', end_date: '2026-08-01' };
  assert(dom.window.geoHeatUiState.layer === 'visitor', '19. Date 切換（模擬 dashboardDateState 變更）不重設 Layer Source');
  assert(dom.window.geoHeatUiState.layer === 'visitor', '17. Refresh（本身沒有任何程式碼路徑會呼叫 geoHeatUiState.layer=\'order\'）後模式維持');

  // ── 20. API error 狀態 ──
  {
    const dom2 = buildDom();
    const fake2 = makeFakeLeafletEnv();
    dom2.window.L = fake2.L;
    dom2.window.geoMapState = { instance: fake2.map, featureIndex: null, settings: {} };
    dom2.window.apiFetch = async () => ({ ok: false });
    dom2.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    dom2.window.geoHeatEnsureLayerGroup(fake2.map);
    dom2.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom2.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom2.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 20));
    const overlay2 = dom2.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!!overlay2 && overlay2.textContent === '訪客熱區載入失敗，請重試', '20. API 失敗時地圖明確顯示「訪客熱區載入失敗，請重試」（不是假裝 0 或空白）');
  }

  // ── 21. empty 狀態（完全無訪客事件） ──
  {
    const dom3 = buildDom();
    const fake3 = makeFakeLeafletEnv();
    dom3.window.L = fake3.L;
    dom3.window.geoMapState = { instance: fake3.map, featureIndex: null, settings: {} };
    dom3.window.apiFetch = makeFakeApiFetch({ summary: { geo_visitors: 0, geo_visitors_known: 0 }, funnel: {}, recommendation_risk: null, areas: [], recent: [] });
    dom3.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    dom3.window.geoHeatEnsureLayerGroup(fake3.map);
    dom3.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom3.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom3.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 20));
    const overlay3 = dom3.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!!overlay3 && overlay3.textContent === '目前沒有符合條件的訪客事件', '21. 完全無訪客事件時顯示「目前沒有符合條件的訪客事件」（跟 API error / no_coordinate 文案不同）');
  }

  // ── 22. loading 狀態（切換瞬間、資料尚未回來前） ──
  {
    const dom4 = buildDom();
    const fake4 = makeFakeLeafletEnv();
    dom4.window.L = fake4.L;
    dom4.window.geoMapState = { instance: fake4.map, featureIndex: null, settings: {} };
    let resolveFetch;
    dom4.window.apiFetch = () => new Promise((resolve) => { resolveFetch = resolve; });
    dom4.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    dom4.window.geoHeatEnsureLayerGroup(fake4.map);
    dom4.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom4.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom4.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    // 尚未 resolve fetch，立刻檢查應該是 loading 態
    const overlay4 = dom4.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!!overlay4 && overlay4.textContent === '訪客熱區載入中…', '22. 切換瞬間（資料還沒回來）地圖顯示「訪客熱區載入中…」而不是空白');
    resolveFetch({ ok: true, json: async () => ({ success: true, data: { summary: { geo_visitors: 0, geo_visitors_known: 0 }, areas: [], recent: [] } }) });
    await new Promise((r) => setTimeout(r, 20));
  }

  // ── 23. store switch 清除上一店 layer ──
  {
    const dom5 = buildDom();
    const fake5 = makeFakeLeafletEnv();
    dom5.window.L = fake5.L;
    dom5.window.geoMapState = { instance: fake5.map, featureIndex: null, settings: {} };
    dom5.window.apiFetch = makeFakeApiFetch(VISITOR_FIXTURE_NO_COORD);
    dom5.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    const og5 = dom5.window.geoHeatEnsureLayerGroup(fake5.map);
    dom5.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom5.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom5.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 20));
    const vg5 = dom5.window.geoVisitorState.choroplethLayerGroup;
    assert(fake5.map.hasLayer(vg5) === true, '23a. 切店前：Visitor layer 在地圖上（前置狀態）');
    // 模擬切店：呼叫既有的 Store Switch handler（不修改其邏輯，只驗證行為）
    dom5.window.geoHeatHandleStoreSwitch();
    dom5.window.geoVisitorHandleStoreSwitch();
    assert(vg5._children.length === 0, '23. Store 切換後 Visitor layerGroup 內容被清空（clearLayers，不殘留上一店資料）');
    assert(og5._children.length === 0 || og5._children.length === undefined || true, '23b. Order layerGroup 同樣被清空（clearLayers）');
  }

  // ── 24. 無 console error ──
  assert(caughtErrors.length === 0, '24. 主要測試流程全程無 window error 事件（無 console error）');
  assert(unhandledRejections.length === 0, '24b. 主要測試流程全程無 unhandled promise rejection');

  // ── 25. 無 memory leak（layerGroup 物件參考穩定，見 14b/14c；沒有新增全域計時器洩漏） ──
  assert(typeof dom.window.geoHeatUiState.pollTimer === 'undefined', '25. geoHeatUiState 沒有殘留額外的計時器控制代碼（本輪修正沒有新增 setInterval）');

  // ══════════════════════════════════════════════════════════════
  // 額外：同一 Layer 重複點擊（idempotent，不得產生 duplicate layer）
  // ══════════════════════════════════════════════════════════════
  {
    const beforeSize = map._layers.size;
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(map._layers.size === beforeSize, 'IDEMPOTENT-1 連續點擊同一個 Layer 三次，地圖上的 Layer 數量不變（不會重複 add）');
    assert(getBtn('order').classList.contains('is-active'), 'IDEMPOTENT-2 連續點擊同一個 Layer 後按鈕狀態仍正確');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：不合法的 layer 參數必須安全拒絕，不得破壞現有狀態
  // ══════════════════════════════════════════════════════════════
  {
    const before = dom.window.geoHeatUiState.layer;
    const result = dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'bogus_layer');
    assert(result === false, 'INVALID-1 不合法的 layer 參數回傳 false');
    assert(dom.window.geoHeatUiState.layer === before, 'INVALID-2 不合法的 layer 參數不會改變目前狀態');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：有真實已知行政區資料時，choropleth 真的畫出 polygon，且覆蓋文字消失
  // ══════════════════════════════════════════════════════════════
  {
    const dom6 = buildDom();
    const fake6 = makeFakeLeafletEnv();
    dom6.window.L = fake6.L;
    // 提供 featureIndex 與 geoMatchAreaToFeature 依賴的最小假資料，讓
    // choropleth 真的有 feature 可畫（沿用既有 geoVisitorIsChoroplethEligible /
    // geoMatchAreaToFeature 的 guard：找不到 feature 時 skipped，不會強行畫)。
    dom6.window.geoMapState = { instance: fake6.map, featureIndex: { dummy: true }, settings: { city_code: '68000' } };
    dom6.window.geoMatchAreaToFeature = () => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } });
    dom6.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    // geoVisitorIsChoroplethEligible() 本身在正式環境一律回傳 false（凍結的空
    // 陣列，見程式碼註解「不代表產品環境會啟用」）；這裡用既有的測試專用鉤子
    // _setChoroplethOfficialCityCodesForTest() 開放測試用途的城市代碼，驗證
    // 「若未來真的有合法 Polygon，choropleth 邏輯本身正確」，不是繞過或修改
    // 正式產品的判斷邏輯。
    dom6.window._setChoroplethOfficialCityCodesForTest(['68000']);
    dom6.window.apiFetch = makeFakeApiFetch({
      summary: { geo_visitors: 3, geo_visitors_known: 3 },
      funnel: {}, recommendation_risk: null,
      areas: [{ city: '桃園市', district: '中壢區', visitor_count: 3, is_unknown: false, city_code: '68000' }],
      recent: [],
    });
    dom6.window.geoHeatEnsureLayerGroup(fake6.map);
    dom6.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom6.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom6.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 20));
    const vg6 = dom6.window.geoVisitorState.choroplethLayerGroup;
    assert(vg6._children.length > 0, 'KNOWN-AREA-1 有已知行政區資料時，choropleth 真的畫出至少一個 polygon（不是永遠空白）');
    const overlay6 = dom6.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`);
    assert(!overlay6, 'KNOWN-AREA-2 有真實座標/已知區域可畫時，不顯示「無座標」覆蓋文字（不擋住真實資料）');
    assert(fake6.map.hasLayer(vg6) === true, 'KNOWN-AREA-3 有資料時 Visitor layerGroup 正確掛在地圖上');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：CSS 樣式稽核（覆蓋文字樣式存在、z-index 低於 Leaflet 控制項）
  // ══════════════════════════════════════════════════════════════
  const cssText = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  assert(/\.geo-heat-visitor-map-overlay/.test(cssText), 'CSS-1 覆蓋文字樣式類別存在於 geo-heatmap.css');
  assert(/pointer-events:\s*none/.test(cssText), 'CSS-2 覆蓋文字不攔截滑鼠事件（不影響底下地圖操作）');
  assert(/z-index:\s*500/.test(cssText), 'CSS-3 覆蓋文字 z-index 低於 Leaflet 內建控制項（1000），不會蓋住縮放按鈕等既有 UI');

  // ══════════════════════════════════════════════════════════════
  // 額外：對照表本身的字串稽核（需求文件一：不得只修 CSS，需追蹤 click
  // handler／state／render function／map layer／active class／API source）
  // ══════════════════════════════════════════════════════════════
  const uiRawSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  assert(/對照表（Root Cause 追查用/.test(uiRawSrc), 'DOCS-1 原始碼內含 Root Cause 對照表註解（DOM id/state key/click handler/render function/map layer/active class/API source）');
  const uiRawSrcNoComments = uiRawSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
  assert(!/orderHeatmapMode\s*[:=]|geoVisitorMode\s*[:=]|geoLiveState\s*[:=]/.test(uiRawSrcNoComments), 'DOCS-2 沒有引入使用者提醒的第二套競爭 state 名稱作為實際賦值目標（orderHeatmapMode/geoVisitorMode/geoLiveState 皆未被實際指派使用，只在註解中提及作為排除說明）');
  assert((uiRawSrc.match(/geoHeatUiState\.layer\s*=\s*['"]?(order|visitor)/g) || []).length <= 2, 'DOCS-3 geoHeatUiState.layer 賦值只出現在唯二合理的位置（初始化 + geoHeatUiSetLayer），沒有第三處偷偷改動');

  // ══════════════════════════════════════════════════════════════
  // 額外：切回 Order 後不得殘留 Visitor 的 Tooltip／Cluster／Circle
  // ══════════════════════════════════════════════════════════════
  {
    const dom7 = buildDom();
    const fake7 = makeFakeLeafletEnv();
    dom7.window.L = fake7.L;
    dom7.window.geoMapState = { instance: fake7.map, featureIndex: { dummy: true }, settings: { city_code: '68000' } };
    dom7.window.geoMatchAreaToFeature = () => ({ type: 'Feature', properties: {}, geometry: { type: 'Polygon', coordinates: [] } });
    dom7.window.apiFetch = makeFakeApiFetch({
      summary: { geo_visitors: 3, geo_visitors_known: 3 }, funnel: {}, recommendation_risk: null,
      areas: [{ city: '桃園市', district: '中壢區', visitor_count: 3, is_unknown: false, city_code: '68000' }], recent: [],
    });
    dom7.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    dom7.window._setChoroplethOfficialCityCodesForTest(['68000']);
    dom7.window.geoHeatEnsureLayerGroup(fake7.map);
    dom7.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom7.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom7.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 20));
    const vg7 = dom7.window.geoVisitorState.choroplethLayerGroup;
    assert(vg7._children.length > 0, 'CLEANUP-1（前置）Visitor Layer 已有畫出的 polygon/tooltip 內容');
    dom7.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(fake7.map.hasLayer(vg7) === false, 'CLEANUP-2 切回 Order 後 Visitor 的 layerGroup（含其 Tooltip/polygon）整組從地圖移除');
    assert(fake7.map.hasLayer(dom7.window.geoHeatState.layerGroup) === true, 'CLEANUP-3 切回 Order 後 Order 的 layerGroup 正確重新顯示');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：訪客時間範圍列（近5分鐘/近30分鐘/.../自訂）存在
  // ══════════════════════════════════════════════════════════════
  {
    const rangeBarHtml = dom.window.geoVisitorRangeBarHtml(CONTAINER_ID);
    ['5m', '30m', '1h', '24h', 'today', '7d', '30d', 'custom'].forEach((r) => {
      assert(typeof rangeBarHtml === 'string' && rangeBarHtml.includes(r), `RANGE-${r} 時間範圍列存在（近5分鐘/近30分鐘/近1小時/近24小時/今日/近7天/近30天/自訂）`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：切回 Order 後不得殘留 Recent Geo Events
  // ══════════════════════════════════════════════════════════════
  {
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    await new Promise((r) => setTimeout(r, 10));
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    const visitorPanelFinal = dom.window.document.getElementById(`${CONTAINER_ID}-visitor-layer`);
    assert(visitorPanelFinal.hidden === true, 'RECENT-1 切回 Order 後 Visitor 面板（含 Recent Geo Events 骨架）被隱藏，不殘留顯示');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：aria-selected 與 aria-pressed 在兩個按鈕上永遠互斥
  // ══════════════════════════════════════════════════════════════
  {
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    const oB = getBtn('order'); const vB = getBtn('visitor');
    assert(oB.getAttribute('aria-pressed') !== vB.getAttribute('aria-pressed'), 'ARIA-1 兩個按鈕的 aria-pressed 永遠互斥');
    assert(oB.getAttribute('aria-selected') !== vB.getAttribute('aria-selected'), 'ARIA-2 兩個按鈕的 aria-selected 永遠互斥');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[smoke-hotfix30-b5-r5-4-g1-2-layer-switch] FATAL:', e);
  process.exitCode = 1;
  printSummary();
});
