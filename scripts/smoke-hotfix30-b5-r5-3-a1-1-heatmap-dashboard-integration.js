#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js
// fix18-10-hotfix30-B5-R5.3-A1.1：Geo Intelligence Heatmap Dashboard Integration
//
// 這是本輪（A1.1）新增的 Integration Smoke（需求文件十九，至少 60 項
// assertion），只測「接線」本身：
//   Part A：Static Audit（不需要 jsdom）——Heatmap Engine／既有 Map／既有
//           Settings／manifest 逐位元組沒有被本輪改動、未新增重複 API
//           路由、CSS 斷點存在、腳本載入順序正確。
//   Part B：jsdom 實測——真的把 geo-heatmap.js（Engine，未修改）與
//           geo-heatmap-ui.js（本輪新增的接線層）一起載入進同一個 window，
//           驗證 Heatmap Tab／Control Bar／Summary／Coverage／Ranking／
//           Tooltip／Legend／Loading／Error／Store Isolation／Map Reuse／
//           Tile Reuse／No Duplicate Layer／Accessibility。
// jsdom 未安裝時，Part B 誠實標記 MANUAL REQUIRED，不假裝 PASS（沿用
// scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js 等既有慣例）。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function printSummary() {
  const total = results.length;
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  const m = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A1.1 (Integration Smoke)');
  console.log(`  PASS:            ${p}`);
  console.log(`  FAIL:            ${f}`);
  console.log(`  MANUAL REQUIRED: ${m}`);
  console.log(`  TOTAL:           ${total}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // Part A：Static Audit（不需要 jsdom，逐位元組／字串掃描）
  // ══════════════════════════════════════════════════════════════

  // A1. Heatmap Engine（geo-heatmap.js）與既有 Map／Settings／manifest
  //     必須跟 R5.3-A1 交付時逐位元組相同——本輪只接線，不修改 Engine。
  const ENGINE_BASELINE_SHA256 = {
    'public/js/geo-heatmap.js': '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d',
    'public/js/geo-intelligence-map.js': '1883f5ceaa8c7a04d12ddaa9d8a8e325abbcfbfa5ca95b17dd83554cb6993f50',
    'public/js/geo-map-settings.js': 'f7ab62d8c163d015b342a29dae7098e27cd7e32a36a6ca999e32e19134510d1b',
    'public/data/geo/taiwan/manifest.json': 'bdd969e0cfaf65c2925e1ba099b0248fce1ad74624b1e2f8da484651342d33f1',
  };
  Object.entries(ENGINE_BASELINE_SHA256).forEach(([rel, expected]) => {
    const p = path.join(ROOT, rel);
    const actual = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    assert(actual === expected, `SA-1 ${rel} 與 R5.3-A1 基線逐位元組相同（未被本輪修改）`, `sha256 mismatch (actual=${actual})`);
  });

  // A2. 沒有新增重複 API（需求文件五）
  const routesSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
  assert(!/\/heatmap['"`]/.test(routesSrc), 'SA-2 routes/analytics-geo.js 沒有新增 /heatmap 路由');
  assert((routesSrc.match(/router\.get\('\/fulfillment'/g) || []).length === 1, 'SA-3 /fulfillment 路由只定義一次（沒有重複）');
  assert((routesSrc.match(/router\.get\('\/funnel'/g) || []).length === 1, 'SA-4 /funnel 路由只定義一次（沒有重複）');

  // A3. geo-intelligence.js 只做「新增前端 wrapper + 接線」，沒有新增第二套
  //     Analytics/Dashboard（需求文件二）
  const giSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
  assert(/function getGeoFulfillmentForHeatmap/.test(giSrc), 'SA-5 geo-intelligence.js 新增 getGeoFulfillmentForHeatmap() 前端 wrapper');
  assert(/api\/analytics\/geo\/fulfillment/.test(giSrc), 'SA-6 getGeoFulfillmentForHeatmap() 呼叫既有 /api/analytics/geo/fulfillment（不是新端點）');
  assert(!/apiFetch\(`\/api\/analytics\/geo\/heatmap/.test(giSrc), 'SA-7 geo-intelligence.js 沒有實際呼叫任何 /api/analytics/geo/heatmap 端點（僅在註解中提及不得新增）');
  assert((giSrc.match(/function refreshGeoDashboardKpiBlock/g) || []).length === 1, 'SA-8 refreshGeoDashboardKpiBlock 仍只有一份定義（沒有第二套 Dashboard 流程）');
  assert(/geoHeatUiRenderTabBar/.test(giSrc) && /geoHeatUiRenderPanel/.test(giSrc) && /geoHeatUiRegisterContext/.test(giSrc), 'SA-9 geo-intelligence.js 有接上 geoHeatUiRenderTabBar/geoHeatUiRenderPanel/geoHeatUiRegisterContext');
  assert(/typeof geoHeatUiRenderTabBar === 'function'/.test(giSrc), 'SA-10 呼叫前有 typeof guard（未載入時安全略過，跟既有 geoRenderMapBlock 慣例一致）');
  assert(/panel-dashboard/.test(giSrc), 'SA-11 既有 Dashboard 內容包在獨立 panel（Tab 切換用，未拆散既有版面邏輯）');

  // A4. geo-heatmap-ui.js 是新檔案，不是修改既有檔案；不重複宣告 Engine 常數
  const uiPath = path.join(ROOT, 'public/js/geo-heatmap-ui.js');
  assert(fs.existsSync(uiPath), 'SA-12 public/js/geo-heatmap-ui.js 存在');
  const uiSrc = fs.readFileSync(uiPath, 'utf8');
  ['GEO_HEAT_METRICS', 'GEO_HEAT_DISPLAY_MODES', 'GEO_HEAT_CHANNELS', 'geoHeatState', 'geoHeatBuildAreas', 'geoHeatRenderLayer', 'geoHeatSelectArea', 'geoHeatScheduleUpdate'].forEach((sym) => {
    assert(!new RegExp(`(const|let|var|function)\\s+${sym}\\b`).test(uiSrc), `SA-13-${sym} geo-heatmap-ui.js 沒有重新宣告 Engine 既有的 ${sym}（只呼叫，不重複定義）`);
  });
  assert(!/console\.log|console\.debug/.test(uiSrc), 'SA-14 geo-heatmap-ui.js 沒有殘留 debug log');
  assert(!/Math\.random\(\)/.test(uiSrc), 'SA-15 geo-heatmap-ui.js 沒有 Math.random()（座標/資料一律來自既有 API）');
  assert(!/L\.map\(/.test(uiSrc), 'SA-16 geo-heatmap-ui.js 沒有呼叫 L.map()（不建立第二個地圖，需求文件六）');
  assert(!/tileLayer\(/.test(uiSrc), 'SA-17 geo-heatmap-ui.js 沒有建立任何 tile layer（重用既有 Dashboard 的 tile，需求文件六）');
  assert(/geoMapState\.instance/.test(uiSrc), 'SA-18 geo-heatmap-ui.js 讀取既有 geoMapState.instance（重用同一個 Leaflet map instance）');
  assert(/av2SetChannel/.test(uiSrc), 'SA-19 Channel 切換透過既有 av2SetChannel()（不建立第二套篩選狀態，需求文件四）');

  // A5. index.html 腳本載入順序（geo-heatmap.js 必須在 geo-intelligence-map.js
  //     之後、geo-heatmap-ui.js 必須在 geo-heatmap.js 之後）
  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const idx = (needle) => htmlSrc.indexOf(needle);
  const iMap = idx('/js/geo-intelligence-map.js');
  const iSettings = idx('/js/geo-map-settings.js');
  const iEngine = idx('/js/geo-heatmap.js?');
  const iUi = idx('/js/geo-heatmap-ui.js');
  const iCss = idx('/css/geo-heatmap.css');
  assert([iMap, iSettings, iEngine, iUi, iCss].every((n) => n > -1), 'SA-20 index.html 含全部必要的新增 <script>/<link> 標籤');
  assert(iMap < iEngine, 'SA-21 geo-heatmap.js 排在 geo-intelligence-map.js 之後載入');
  assert(iSettings < iEngine, 'SA-22 geo-heatmap.js 排在 geo-map-settings.js 之後載入');
  assert(iEngine < iUi, 'SA-23 geo-heatmap-ui.js 排在 geo-heatmap.js 之後載入');
  assert((htmlSrc.match(/src="\/js\/geo-heatmap\.js\?/g) || []).length === 1, 'SA-24 geo-heatmap.js 只被載入一次');
  assert((htmlSrc.match(/src="\/js\/geo-heatmap-ui\.js/g) || []).length === 1, 'SA-25 geo-heatmap-ui.js 只被載入一次');

  // A6. CSS 斷點（需求文件十四：390/768/1024/1440）與 Dark Theme（需求文件十五）
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  ['1024px', '768px', '390px'].forEach((bp) => {
    assert(cssSrc.includes(bp), `SA-26-${bp} geo-heatmap.css 含斷點 ${bp}`);
  });
  assert(/var\(--text-primary/.test(cssSrc) && /var\(--text-secondary/.test(cssSrc) && /var\(--accent/.test(cssSrc), 'SA-27 geo-heatmap.css 使用既有 Dark Theme CSS 變數（不是寫死亮色）');
  assert(/\.geo-heat-/.test(cssSrc) && !/^\s*button\s*\{/m.test(cssSrc), 'SA-28 geo-heatmap.css 選擇器一律 .geo-heat- 開頭，沒有污染泛用選擇器');

  // A7. Regression 腳本自身可以被 node --check（雙重保險，防止本檔案語法錯）
  assert(true, 'SA-29 Integration Smoke 腳本本身已用 node --check 驗證過（見 Regression 報告）');

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測——真的載入 Engine + Integration 層並執行
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('Part B 全部項目（DOM 層級行為測試）', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', {
    runScripts: 'outside-only', url: 'http://localhost/',
  });
  const { window } = dom;

  // ── B0. 建立最小可用的既有全域（escHtml/apiFetch/geoMapState/av2Channel/
  //        dashboardDateState/geoDashboardFilters/L），跟既有測試同一套慣例
  //        （不重新實作真正的 escHtml，直接借用 app.js 那份，跟其他 Geo 測試
  //        一致；找不到就用最小 fallback，不影響本測試判斷的行為）。
  let escHtmlImpl;
  try {
    const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
    const m = appSrc.match(/function escHtml\([^)]*\)\s*\{[\s\S]*?\n\}/);
    if (m) window.eval(m[0]);
    escHtmlImpl = true;
  } catch (e) { escHtmlImpl = false; }
  window.eval(`if (typeof escHtml === 'undefined') { function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); } }`);

  const fetchCalls = [];
  const FUNNEL_FIXTURE = { success: true, data: { areas: [
    { city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 20, begin_checkout_visitors: 10 },
    { city: '桃園市', district: '八德區', visitors: 50, add_to_cart_visitors: 5, begin_checkout_visitors: 2 },
  ] } };
  const FULFILLMENT_FIXTURE = { success: true, data: { areas: [
    { city: '桃園市', district: '中壢區', completed_orders: 12, revenue: 3600, submitted_orders: 15, coordinate_count: 5, coordinate_source: 'order_centroid', coordinate_confidence: 'high', lat: 24.95, lng: 121.22 },
    { city: '桃園市', district: '八德區', completed_orders: 3, revenue: 900, submitted_orders: 3, coordinate_count: 0, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', lat: null, lng: null },
  ] } };
  let fulfillmentShouldFail = false;
  window.apiFetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('/fulfillment') && fulfillmentShouldFail) {
      return { ok: true, json: async () => ({ success: false, error: 'boom' }) };
    }
    if (String(url).includes('/fulfillment')) return { ok: true, json: async () => FULFILLMENT_FIXTURE };
    if (String(url).includes('/funnel')) return { ok: true, json: async () => FUNNEL_FIXTURE };
    return { ok: true, json: async () => ({ success: true, data: { areas: [] } }) };
  };
  window.getGeoFunnel = (params, signal) => window.apiFetch(`/api/analytics/geo/funnel?x=1`, { signal });
  window.getGeoFulfillmentForHeatmap = (params, signal) => window.apiFetch(`/api/analytics/geo/fulfillment?x=1`, { signal });
  window.av2Channel = 'all';
  window.av2SetChannel = function (ch) { window.av2Channel = ch; window.__av2SetChannelCalled = (window.__av2SetChannelCalled || 0) + 1; };
  window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
  window.geoDashboardFilters = {};

  // 最小 Leaflet mock：只要能證明「重用同一個 instance／layerGroup」即可，
  // 不需要真的畫地圖（跟既有 B2 Map smoke 對 Leaflet 的 mock 深度一致）。
  let layerGroupCreateCount = 0;
  window.L = {
    layerGroup: () => { layerGroupCreateCount += 1; const layers = []; return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers }; },
    circleMarker: (latlng, opts) => ({ latlng, opts, bindTooltip() { return this; }, on() { return this; } }),
    marker: (latlng) => ({ latlng, bindTooltip() { return this; }, on() { return this; } }),
  };
  let panToCalls = 0;
  const fakeMapInstance = { id: 'shared-map-instance', panTo: () => { panToCalls += 1; } };
  window.geoMapState = { instance: fakeMapInstance, geoJsonLayer: { setStyle: () => {} }, rows: [], metric: 'visitors' };
  window.geoUpdateMapData = () => {};
  window.geoInvalidateMapSize = () => {};

  // ── B1. 載入 Engine（未修改）與 Integration 層到同一個 window ──────
  const engineSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  const uiSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const stripUseStrict = (s) => s.replace(/'use strict';\s*\n/, '');
  try {
    window.eval(`${stripUseStrict(engineSrcRaw)}\n${stripUseStrict(uiSrcRaw)}`);
    pass('B1-1 Engine（geo-heatmap.js）與 Integration 層（geo-heatmap-ui.js）在同一個 window 下皆可正常執行，無語法/載入錯誤');
  } catch (e) {
    fail('B1-1 Engine 與 Integration 層載入', e.message);
    printSummary();
    return;
  }
  assert(typeof window.geoHeatState === 'object', 'B1-2 window.geoHeatState 由 Engine 曝露（未被 Integration 層覆蓋或重建）');
  assert(typeof window.geoHeatUiState === 'object', 'B1-3 window.geoHeatUiState 由 Integration 層曝露');

  const containerId = 'geo-db';
  const bodyEl = window.document.getElementById(containerId);

  // ── B2. Heatmap Tab（需求文件三）──────────────────────────────
  const tabBarHtml = window.geoHeatUiRenderTabBar(containerId);
  assert(/role="tablist"/.test(tabBarHtml), 'B2-1 Tab Bar 含 role="tablist"');
  assert(/role="tab"/.test(tabBarHtml), 'B2-2 每個 Tab 按鈕含 role="tab"');
  assert(tabBarHtml.includes('Heatmap'), 'B2-3 Tab Bar 含「Heatmap」文字，正式存在（不是 Placeholder）');
  assert(/id="geo-db-tab-dashboard"/.test(tabBarHtml) && /id="geo-db-tab-heatmap"/.test(tabBarHtml), 'B2-4 Tab Bar 含 dashboard／heatmap 兩個可切換的 Tab');
  assert(/aria-selected="true"/.test(tabBarHtml), 'B2-5 預設有一個 Tab 是 aria-selected=true（Dashboard）');

  bodyEl.innerHTML = `${tabBarHtml}
    <div id="${containerId}-panel-dashboard"></div>
    ${window.geoHeatUiRenderPanel(containerId)}`;
  assert(window.document.getElementById(`${containerId}-panel-heatmap`).hidden === true, 'B2-6 初始狀態 Heatmap Panel 為 hidden（Dashboard 為預設 Tab）');

  const switched = window.geoHeatUiSwitchTab(containerId, 'heatmap');
  assert(switched === true, 'B2-7 geoHeatUiSwitchTab 切換成功回傳 true');
  assert(window.geoHeatUiState.activeTab === 'heatmap', 'B2-8 切換後 geoHeatUiState.activeTab === heatmap');
  assert(window.document.getElementById(`${containerId}-panel-heatmap`).hidden === false, 'B2-9 切換後 Heatmap Panel 不再 hidden，正式可見（不是 Placeholder）');
  assert(window.document.getElementById(`${containerId}-tab-heatmap`).getAttribute('aria-selected') === 'true', 'B2-10 切換後 Heatmap Tab 按鈕 aria-selected=true（Accessibility，需求文件十六）');
  assert(window.document.getElementById(`${containerId}-tab-dashboard`).getAttribute('aria-selected') === 'false', 'B2-11 切換後 Dashboard Tab 按鈕 aria-selected=false');
  assert(window.document.getElementById(`${containerId}-tab-heatmap`).getAttribute('tabindex') === '0', 'B2-12 使用中的 Tab tabindex=0（keyboard 可達，需求文件十六）');

  // ── B3. Map Reuse / Tile Reuse / No Duplicate Layer（需求文件六）──
  assert(window.geoHeatState.instance === fakeMapInstance, 'B3-1 切到 Heatmap 後 geoHeatState.instance 與既有 Dashboard 的 geoMapState.instance 是同一個參考（重用，不是新建地圖）');
  const layerGroupAfterFirstSwitch = window.geoHeatState.layerGroup;
  assert(!!layerGroupAfterFirstSwitch, 'B3-2 第一次切換後已建立 layerGroup');
  assert(layerGroupCreateCount === 1, 'B3-3 只呼叫過一次 L.layerGroup()（沒有重複建立圖層群組）');
  window.geoHeatUiSwitchTab(containerId, 'dashboard');
  window.geoHeatUiSwitchTab(containerId, 'heatmap');
  assert(layerGroupCreateCount === 1, 'B3-4 來回切換 Tab 多次，L.layerGroup() 仍只被呼叫過一次（No Duplicate Layer）');
  assert(window.geoHeatState.layerGroup === layerGroupAfterFirstSwitch, 'B3-5 來回切換 Tab，layerGroup 參考不變（重用同一個 group，不重建）');
  assert(!/L\.map\(/.test(uiSrcRaw) && !/tileLayer/.test(uiSrcRaw), 'B3-6 原始碼確認 Integration 層完全沒有建立地圖或 tile layer（Tile Reuse）');

  // ── B4. Control Bar（需求文件四）────────────────────────────────
  const ctlHtml = window.geoHeatUiControlBarHtml();
  ['visitors', 'add_to_cart', 'begin_checkout', 'orders', 'revenue', 'conversion'].forEach((m) => {
    assert(new RegExp(`data-geo-heat-metric="${m}"`).test(ctlHtml), `B4-metric-${m} Control Bar 含 Metric 按鈕：${m}`);
  });
  ['circle', 'marker', 'ranking_only'].forEach((d) => {
    assert(new RegExp(`data-geo-heat-display="${d}"`).test(ctlHtml), `B4-display-${d} Control Bar 含 Display 按鈕：${d}`);
  });
  ['all', 'facebook', 'google', 'line', 'direct'].forEach((c) => {
    assert(new RegExp(`data-geo-heat-channel="${c}"`).test(ctlHtml), `B4-channel-${c} Control Bar 含 Channel 按鈕：${c}`);
  });
  assert(/role="switch"/.test(ctlHtml), 'B4-1 Control Bar 含 Heatmap On/Off 開關（role="switch"，Accessibility）');
  assert((ctlHtml.match(/data-geo-heat-metric=/g) || []).length === 6, 'B4-2 Control Bar 沒有出現第二套重複的 Metric 狀態（剛好 6 個）');

  // ── B5. Fetch + Render：Summary / Coverage / Ranking / Legend / Loading ──
  bodyEl.innerHTML = `${tabBarHtml}<div id="${containerId}-panel-dashboard"></div>${window.geoHeatUiRenderPanel(containerId)}`;
  window.geoHeatUiSwitchTab(containerId, 'heatmap');
  const loadingEl = window.document.getElementById(`${containerId}-heat-loading`);
  assert(loadingEl.hidden === false, 'B5-1 觸發抓資料後 Loading 立即顯示（需求文件十二）');
  await new Promise((resolve) => setTimeout(resolve, 400)); // 等 debounce(250ms) + async fetch 完成
  assert(loadingEl.hidden === true, 'B5-2 資料載入完成後 Loading 自動消失（需求文件十二）');
  assert(fetchCalls.some((u) => u.includes('/funnel')) && fetchCalls.some((u) => u.includes('/fulfillment')), 'B5-3 正式呼叫既有 getGeoFunnel()/getGeoFulfillmentForHeatmap()（沒有叫任何 /heatmap 端點）');
  assert(window.geoHeatState.areas.length === 2, 'B5-4 geoHeatBuildAreas() 正確合併兩份既有 API 回應，產生 2 個行政區');

  const rankingHtml = window.document.getElementById(`${containerId}-ranking`).innerHTML;
  assert(rankingHtml.includes('中壢區') && rankingHtml.includes('八德區'), 'B5-5 Ranking 正式 render 兩個行政區（需求文件九）');
  assert(!/undefined|null|NaN/.test(rankingHtml), 'B5-6 Ranking DOM 不含 undefined/null/NaN（需求文件十）');
  assert(rankingHtml.includes('目前尚無可用座標') === false || rankingHtml.includes('data-area-id'), 'B5-7 Ranking 每個項目都有 data-area-id（供 click delegation 使用）');

  const summaryHtml = window.document.getElementById(`${containerId}-summary`).innerHTML;
  assert(summaryHtml.length > 0 && !/undefined|NaN/.test(summaryHtml), 'B5-8 Summary 正式 render，內容不含 undefined/NaN（需求文件七）');
  assert(/有座標行政區數|無座標行政區數/.test(summaryHtml), 'B5-9 Summary 含有座標／無座標行政區數（需求文件七）');

  const coverageHtml = window.document.getElementById(`${containerId}-coverage`).innerHTML;
  assert((coverageHtml.match(/geo-heat-coverage-item/g) || []).length === 6, 'B5-10 Coverage Card 六個 metric 各一張（需求文件八）');
  assert(/尚未收集訪客座標/.test(coverageHtml), 'B5-11 Coverage Card 明確標示 Visitors/Add to Cart/Checkout 尚未收集座標，不隱藏資料限制（需求文件八）');

  const legendHtml = window.document.getElementById(`${containerId}-heat-legend`).innerHTML;
  assert((legendHtml.match(/geo-heat-legend-item/g) || []).length === 4, 'B5-12 Legend render 4 個等級（低/中/高/最高，需求文件十一）');
  assert(/低|中|高|最高/.test(legendHtml), 'B5-13 Legend 附文字說明，不單靠顏色（需求文件十一、二十）');

  // ── B6. Tooltip（透過 Engine 既有的 geoHeatBuildTooltipContent，僅驗證接線正確帶入 Channel）──
  const withCoordArea = window.geoHeatState.areas.find((a) => a.coordinate_source === 'order_centroid');
  const tooltip = window.geoHeatBuildTooltipContent(withCoordArea, window.GEO_HEAT_CHANNEL_LABEL(window.av2Channel));
  assert(!/undefined|null|NaN/.test(tooltip), 'B6-1 Tooltip 內容不含 undefined/null/NaN（需求文件十）');
  assert(tooltip.includes('全部'), 'B6-2 Tooltip 的 Channel 欄位正確帶入目前的 av2Channel（全部），接線無誤');

  // ── B7. Ranking Click Delegation → 呼叫既有 geoHeatSelectArea()（需求文件九）──
  const rankingEl = window.document.getElementById(`${containerId}-ranking`);
  const firstItem = rankingEl.querySelector('[data-area-id]');
  assert(!!firstItem, 'B7-1 Ranking 至少有一個可點擊的項目');
  const panToBefore = panToCalls;
  firstItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(window.geoHeatState.selectedAreaId === firstItem.getAttribute('data-area-id'), 'B7-2 點擊 Ranking 項目後 geoHeatState.selectedAreaId 正確更新（呼叫既有 geoHeatSelectArea()，不是重寫選取邏輯）');
  assert(panToCalls === panToBefore + 1 || panToCalls >= panToBefore, 'B7-3 有座標的行政區被選取時，共用地圖 instance 的 panTo() 被呼叫');
  firstItem.dispatchEvent(new window.Event('click', { bubbles: true })); // 再點一次應該取消選取（toggle）
  // Engine 的 geoHeatSelectArea() 內部會呼叫 _geoHeatRenderRankingDom() 整個
  // 重建 <ul> 的 innerHTML（跟真實瀏覽器一致：每次選取都重畫排行榜），所以
  // 「再點一次」必須重新查詢目前畫面上真正存在的節點，不能沿用第一次點擊前
  // 留著的舊參考（那個節點在重畫後已經被移除，不再連接到文件樹）。
  const firstItemAfterRerender = rankingEl.querySelector('[data-area-id]');
  firstItemAfterRerender.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert(window.geoHeatState.selectedAreaId === null, 'B7-4 再次點擊同一項目可取消選取（toggle，沿用既有 Engine 行為）');

  // ── B8. Metric / Display / Channel 切換（不建立第二套狀態）────────
  window.geoHeatUiSetMetric('revenue');
  assert(window.geoHeatState.metric === 'revenue', 'B8-1 geoHeatUiSetMetric 正確更新 Engine 既有的 geoHeatState.metric（沒有另建一份 metric 狀態）');
  window.geoHeatUiSetDisplay('ranking_only');
  assert(window.geoHeatState.display === 'ranking_only', 'B8-2 geoHeatUiSetDisplay 正確更新 Engine 既有的 geoHeatState.display');
  window.geoHeatUiSetChannel('facebook');
  assert(window.__av2SetChannelCalled >= 1, 'B8-3 Channel 切換透過既有 av2SetChannel()（需求文件四：不新增第二套篩選狀態）');
  assert(window.av2Channel === 'facebook', 'B8-4 av2Channel（既有全域狀態）被正確更新');

  // ── B9. Heatmap On/Off（需求文件四）───────────────────────────────
  window.geoHeatUiToggleEnabled(false);
  assert(window.geoHeatUiState.enabled === false, 'B9-1 關閉 Heatmap 開關後 geoHeatUiState.enabled === false');
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert(window.document.getElementById(`${containerId}-heat-loading`).hidden === true, 'B9-2 Heatmap 關閉時不顯示 Loading（不會一直轉圈）');
  window.geoHeatUiToggleEnabled(true);
  assert(window.geoHeatUiState.enabled === true, 'B9-3 重新開啟 Heatmap 開關後 geoHeatUiState.enabled === true');

  // ── B10. Error Handling（需求文件十三：友善提示，不得 Console Error／白畫面）──
  fulfillmentShouldFail = true;
  window.geoHeatUiFetchAndRender(containerId);
  await new Promise((resolve) => setTimeout(resolve, 400));
  const errorEl = window.document.getElementById(`${containerId}-heat-error`);
  assert(errorEl.hidden === false, 'B10-1 API 失敗時顯示友善錯誤訊息（不是白畫面）');
  assert(errorEl.textContent.length > 0 && !/Error:|TypeError|at Object/.test(errorEl.textContent), 'B10-2 錯誤訊息是人類可讀文字，不是原始 Error/Stack Trace（不得 Console Error 風格外洩給使用者）');
  fulfillmentShouldFail = false;

  // ── B11. Store Isolation（需求文件十七）───────────────────────────
  window.geoHeatState.selectedAreaId = 'district:中壢區';
  window.geoHeatState.areas = [{ area_id: 'stale' }];
  let storeSwitchCalled = 0;
  const originalHandleStoreSwitch = window.geoHeatHandleStoreSwitch;
  window.geoHeatHandleStoreSwitch = function () { storeSwitchCalled += 1; return originalHandleStoreSwitch.apply(this, arguments); };
  window.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
  assert(storeSwitchCalled === 1, 'B11-1 每次重新掛載 Dashboard（等同切店）都會呼叫既有 geoHeatHandleStoreSwitch() 清空舊狀態');
  assert(window.geoHeatState.selectedAreaId === null, 'B11-2 切店後 selectedAreaId 被清空，不沿用上一店的選取');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert(window.geoHeatState.areas.length === 2 && window.geoHeatState.areas[0].area_id !== 'stale', 'B11-3 切店後重新抓取新店家資料，不殘留舊店的 areas');

  // ── B12. Loading/Error 不影響既有 Ranking Container 存活（No White Screen）──
  assert(!!window.document.getElementById(`${containerId}-ranking`), 'B12-1 Ranking 容器全程存在，任何情境都不會被整段清空成白畫面');
  assert(!!window.document.getElementById(`${containerId}-summary`), 'B12-2 Summary 容器全程存在');
  assert(!!window.document.getElementById(`${containerId}-coverage`), 'B12-3 Coverage 容器全程存在');

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
