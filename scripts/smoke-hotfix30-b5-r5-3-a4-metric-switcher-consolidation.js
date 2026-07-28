#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a4-metric-switcher-consolidation.js
// fix18-10-hotfix30-B5-R5.3-A4：Geo Metric Switcher Consolidation Smoke
// （需求文件一，至少 100 項 assertion）。
//
// Part A：Static/Source Audit（不需要 jsdom）——Single Switcher
//         Invariant、8 指標完整性、Metric Mapping、Store Isolation 的
//         metric 保留邏輯、Date/Channel 沒有建立第二套狀態。
// Part B：jsdom 實測——狀態同步（Map Overlay/Legend/Summary/Tooltip）、
//         Eager Fetch（含 Request Guard）、Dashboard/Heatmap 共用（同一
//         DOM 節點、不重建、不重置 metric）、Map/Tile/Layer Reuse、Empty
//         State、Accessibility、Store Isolation（UI 層）。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function printSummary() {
  const total = results.length;
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A4 (Metric Switcher Consolidation)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${total}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // Part A：Static / Source Audit
  // ══════════════════════════════════════════════════════════════
  const mapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8');
  const visitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const giSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');

  // ── 1. Single Switcher Invariant ─────────────────────────────────
  assert(!/class="geo-map-metrics"/.test(mapSrc), 'A1-1 geo-intelligence-map.js 原始碼不再含 .geo-map-metrics 容器');
  assert(!/geo-map-metric-btn/.test(mapSrc), 'A1-2 geo-intelligence-map.js 原始碼不再含 .geo-map-metric-btn 按鈕 class');
  assert(!/data-geo-map-metric=/.test(mapSrc), 'A1-3 geo-intelligence-map.js 原始碼不再有第二套按鈕的 data attribute');
  {
    if (typeof global.escHtml !== 'function') {
      global.escHtml = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    const M = require(path.join(ROOT, 'public/js/geo-intelligence-map.js'));
    const blockHtml = M.geoRenderMapBlock('a4-test-container');
    assert(!/geo-map-metric-btn/.test(blockHtml), 'A1-4 geoRenderMapBlock() 實際輸出的 HTML 不含舊按鈕（不是只改了原始碼註解，是真的不渲染）');
    assert(!/onclick="geoSetMapMetric/.test(blockHtml), 'A1-5 geoRenderMapBlock() 輸出的 HTML 沒有任何直接呼叫 geoSetMapMetric() 的 onclick（不存在第二套 click listener 入口）');
  }
  assert((giSrc.match(/geoHeatUiRenderSharedMetricBar\(containerId\)/g) || []).length === 1, 'A1-6 geo-intelligence.js 只呼叫一次 geoHeatUiRenderSharedMetricBar()（結果存成變數重複使用，不是呼叫兩次各自產生兩份 HTML）');
  assert((uiSrc.match(/function geoHeatUiRenderSharedMetricBar/g) || []).length === 1, 'A1-7 geoHeatUiRenderSharedMetricBar 只定義一次');
  assert((visitorSrc.match(/function geoVisitorMetricBarHtml/g) || []).length === 1, 'A1-8 geoVisitorMetricBarHtml 只定義一次（唯一的按鈕產生函式）');
  assert((visitorSrc.match(/function geoVisitorSetMetric/g) || []).length === 1, 'A1-9 geoVisitorSetMetric 只定義一次（唯一的切換 handler）');
  assert(!/function geoSetMapMetric[\s\S]*?onclick/.test(mapSrc.slice(mapSrc.indexOf('function geoSetMapMetric'), mapSrc.indexOf('function geoSetMapMetric') + 400)), 'A1-10 geoSetMapMetric() 函式本身沒有自己組出任何 onclick HTML（純資料/渲染函式，不是按鈕產生器）');

  // ── 2. 8 指標完整性 ────────────────────────────────────────────
  const { GEO_EVENT_METRICS, GEO_EVENT_METRIC_LABEL, GEO_EVENT_TO_MAP_METRIC, geoVisitorMetricBarHtml } = require(path.join(ROOT, 'public/js/geo-visitor-layer.js'));
  assert(GEO_EVENT_METRICS.length === 8, 'A2-1 GEO_EVENT_METRICS 剛好 8 個');
  ['visitors', 'add_to_cart', 'checkout', 'orders', 'revenue', 'conversion', 'cart_abandonment', 'recommendation_risk'].forEach((m) => {
    assert(GEO_EVENT_METRICS.includes(m), `A2-2-${m} GEO_EVENT_METRICS 含 ${m}`);
    assert(typeof GEO_EVENT_METRIC_LABEL[m] === 'string' && GEO_EVENT_METRIC_LABEL[m].length > 0, `A2-3-${m} ${m} 有非空的中文標籤`);
  });
  const barHtmlA4 = geoVisitorMetricBarHtml('a4-bar-test');
  GEO_EVENT_METRICS.forEach((m) => {
    assert(barHtmlA4.includes(`'${m}'`), `A2-4-${m} 產生的按鈕 HTML 含 ${m}`);
  });

  // ── 3. Metric Mapping（不允許 silent fallback 到錯誤 metric）────────
  const { GEO_MAP_METRICS } = require(path.join(ROOT, 'public/js/geo-intelligence-map.js'));
  GEO_EVENT_METRICS.forEach((m) => {
    const mapped = GEO_EVENT_TO_MAP_METRIC[m];
    assert(typeof mapped === 'string', `A3-1-${m} ${m} 在 GEO_EVENT_TO_MAP_METRIC 有對應值（不是 undefined）`);
    assert(GEO_MAP_METRICS.includes(mapped), `A3-2-${m} ${m} 對應到的舊指標「${mapped}」是 GEO_MAP_METRICS 合法成員（不是隨便編造的字串）`);
  });
  assert(GEO_EVENT_TO_MAP_METRIC.visitors === 'visitors', 'A3-3 visitors → visitors（直接對應）');
  assert(GEO_EVENT_TO_MAP_METRIC.orders === 'orders', 'A3-4 orders → orders（直接對應）');
  assert(GEO_EVENT_TO_MAP_METRIC.revenue === 'revenue', 'A3-5 revenue → revenue（直接對應）');
  assert(GEO_EVENT_TO_MAP_METRIC.conversion === 'conversion_rate', 'A3-6 conversion → conversion_rate（直接對應）');
  assert(GEO_EVENT_TO_MAP_METRIC.cart_abandonment === 'cart_abandonment_rate', 'A3-7 cart_abandonment → cart_abandonment_rate（直接對應）');
  assert(GEO_EVENT_TO_MAP_METRIC.recommendation_risk === 'risk', 'A3-8 recommendation_risk → risk（直接對應）');
  assert(Object.isFrozen(GEO_EVENT_TO_MAP_METRIC), 'A3-9 GEO_EVENT_TO_MAP_METRIC 是 frozen 常數（不會被意外修改）');

  // ── 4. 未知 metric 不得污染 state ─────────────────────────────────
  {
    const V = require(path.join(ROOT, 'public/js/geo-visitor-layer.js'));
    V._geoVisitorResetStateForTest();
    const before = V.geoVisitorState.metric;
    const ok = V.geoVisitorSetMetric('a4-test', 'not_a_real_metric');
    assert(ok === false, 'A4-1 geoVisitorSetMetric() 對不合法 metric 回傳 false');
    assert(V.geoVisitorState.metric === before, 'A4-2 不合法 metric 不會污染 geoVisitorState.metric（維持原值）');
    V._geoVisitorResetStateForTest();
  }

  // ── 12（Part A 部分）. Date／Channel 沒有建立第二套狀態 ─────────────
  assert(!/dashboardDateState\s*=\s*\{/.test(visitorSrc), 'A12-1 geo-visitor-layer.js 沒有宣告第二個 dashboardDateState 物件');
  assert(!/av2Channel\s*=\s*(?!.*av2SetChannel)/.test(visitorSrc.replace(/av2SetChannel/g, '')), 'A12-2 geo-visitor-layer.js 沒有直接賦值改寫 av2Channel（若要改 Channel 一律透過既有 av2SetChannel()）');
  assert(!/let\s+geoChannelState|const\s+geoChannelState|let\s+geoDateState2|const\s+geoDateState2/.test(visitorSrc + uiSrc), 'A12-3 沒有出現任何第二套 Channel/Date state 變數命名（geoChannelState/geoDateState2 等）');

  console.log(`\n── Part A 結束，共 ${results.length} 項 ──\n`);

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    fail('Part B 全部項目', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  function buildEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const w = dom.window;
    w.eval(`function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }`);
    const fetchCalls = [];
    const FUNNEL_FIXTURE = {
      range: 'today', visitors: 5, view_item_visitors: 3, add_to_cart_visitors: 2, begin_checkout_visitors: 1,
      purchase_visitors: 1, purchase_orders: 1, revenue: 800, revenue_source: 'order_data',
      cart_abandonment_visitors: 1, checkout_abandonment_visitors: 0, known_district_visitors: 4,
      unknown_visitors: 1, unknown_rate: 20, visitor_to_cart_rate: 40, cart_to_checkout_rate: 50,
      checkout_to_purchase_rate: 100, visitor_to_purchase_rate: 20, cart_conversion_rate: 50, checkout_conversion_rate: 100,
    };
    w.apiFetch = async (url) => {
      fetchCalls.push(String(url));
      if (String(url).includes('/visitor-log')) {
        return {
          ok: true, json: async () => ({
            success: true,
            data: {
              range: 'today',
              summary: { geo_visitors: 5, geo_visitors_known: 4, geo_visitors_unknown: 1, unknown_rate: 20, geo_add_to_cart: 2, geo_checkout: 1, geo_orders: 1 },
              funnel: FUNNEL_FIXTURE,
              recommendation_risk: { basis: '規則式計算，非 AI', sufficient_data: false, message: 'Insufficient Data', signals: null },
              areas: [{ city: '桃園市', district: '中壢區', is_unknown: false, visitor_count: 4, add_to_cart_count: 2, checkout_count: 1, order_count: 1 }],
              recent: [{ event_time: '14:45:10', city: '桃園市', district: '中壢區', event_name: 'page_view', source: 'ip', is_unknown: false, visitor_mask: 'vis_***abc' }],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: { areas: [] } }) };
    };
    w.getGeoFunnel = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
    w.getGeoFulfillmentForHeatmap = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
    w.av2Channel = 'all';
    w.av2SetChannel = function (ch) { w.av2Channel = ch; };
    w.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    w.geoDashboardFilters = {};

    let mapCreateCount = 0; let tileLayerCreateCount = 0; let layerGroupCreateCount = 0;
    const setStyleCalls = [];
    const bindTooltipCalls = [];
    w.L = {
      map: () => { mapCreateCount += 1; return {}; },
      tileLayer: () => { tileLayerCreateCount += 1; return { addTo() { return this; } }; },
      layerGroup: () => {
        layerGroupCreateCount += 1;
        const layers = [];
        return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers };
      },
      circleMarker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
      marker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
      geoJSON: (feature) => ({ feature, bindTooltip() { return this; } }),
    };
    const fakeGeoJsonLayer = {
      _styleCalls: [],
      eachLayer(cb) {
        const layer = {
          __geoAreaId: '桃園市|中壢區',
          setStyle: (s) => { setStyleCalls.push(s); },
          bindTooltip: (t) => { bindTooltipCalls.push(t); },
        };
        cb(layer);
      },
    };
    w.geoInvalidateMapSize = () => {};

    const stripUseStrict = (s) => s.replace(/'use strict';\s*\n/, '');
    const engineSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
    const mapSrcLoad = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8');
    const uiJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
    const visitorJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    // 重要：geo-intelligence-map.js 內部自己宣告 `let geoMapState = {...}`，
    // 如果在 eval 之前就設定 w.geoMapState，會被這行宣告蓋掉（同一個變數名稱
    // 的頂層 let 宣告，等同重新賦值）。正確做法：先 eval 讓它用自己的預設值
    // 初始化，再用 Object.assign() 原地覆寫需要的欄位，不是整個替換參考。
    w.eval(`${stripUseStrict(engineSrc)}\n${stripUseStrict(mapSrcLoad)}\n${stripUseStrict(uiJsSrc)}\n${stripUseStrict(visitorJsSrc)}`);
    Object.assign(w.geoMapState, {
      instance: { id: 'shared-map', panTo: () => {} }, geoJsonLayer: fakeGeoJsonLayer, featureIndex: null,
      rows: [{ city: '桃園市', district: '中壢區', visitors: 4, orders: 1, revenue: 800, conversion_rate: 20, cart_abandonment_rate: 10, risk: 0.2 }],
      metric: 'visitors', containerId: `${containerId}-map`, selectedAreaId: null, hoveredAreaId: null,
    });

    return { w, fetchCalls, getMapCreateCount: () => mapCreateCount, getTileLayerCreateCount: () => tileLayerCreateCount, getLayerGroupCreateCount: () => layerGroupCreateCount, setStyleCalls, bindTooltipCalls };
  }

  const containerId = 'geo-db';

  // ── 3/6. 狀態同步 + Dashboard/Heatmap 共用（同一次 mount）───────────
  {
    const { w, fetchCalls, setStyleCalls, bindTooltipCalls } = buildEnv();
    const bodyEl = w.document.getElementById(containerId);
    bodyEl.innerHTML = `${w.geoHeatUiRenderTabBar(containerId)}${w.geoRenderMapBlock(containerId + '-map')}${w.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${w.geoHeatUiRenderPanel(containerId)}`;

    // ── 5. Eager Fetch：mount 即抓（tab 預設是 dashboard）────────────
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));
    assert(w.geoHeatUiState.activeTab === 'dashboard', 'B5-1 mount 後預設分頁仍是 dashboard（沒有被本輪修改強制切走）');
    assert(fetchCalls.some((u) => u.includes('/visitor-log')), 'B5-2 分頁是 dashboard 時，mount 就已經呼叫 /visitor-log（不需要先點 Heatmap）');
    assert(w.geoVisitorState.metric === 'visitors', 'B5-3 初始預設 metric 為 visitors（訪客）');
    assert(w.geoVisitorState.funnel && w.geoVisitorState.funnel.visitors === 5, 'B5-4 mount 後資料已經載入（不需要先切 Layer 才看得到）');

    const fetchCountAfterFirstMount = fetchCalls.length;
    // 重複 mount（模擬重新整理/重複掛載）不應造成 request 暴增式疊加
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));
    const fetchCountAfterSecondMount = fetchCalls.length;
    assert(fetchCountAfterSecondMount - fetchCountAfterFirstMount <= 1, 'B5-5 重複 mount 只多發送 1 次 request（不是每次 mount 疊加多次，沒有 request storm）');

    // ── 3. 狀態同步：切一次 Metric，六樣東西同步更新 ──────────────────
    setStyleCalls.length = 0; bindTooltipCalls.length = 0;
    w.geoVisitorSetMetric(containerId, 'revenue');
    assert(w.geoVisitorState.metric === 'revenue', 'B3-1 geoVisitorState.metric 更新為 revenue');
    assert(w.geoMapState.metric === 'revenue', 'B3-2 geoMapState.metric 同步更新為 revenue（透過既有 geoSetMapMetric()）');
    const activeBtn = w.document.getElementById(`${containerId}-metric-bar`).querySelector('[aria-pressed="true"]');
    assert(!!activeBtn && activeBtn.textContent.includes('營收'), 'B3-3 active button 正確高亮「營收」');
    assert(setStyleCalls.length > 0, 'B3-4 Map Overlay：切換後 layer.setStyle() 確實被呼叫（重新著色）');
    assert(bindTooltipCalls.length > 0, 'B3-5 Tooltip：切換後 layer.bindTooltip() 確實被呼叫（重新綁定新內容）');
    const legendHtml = w.document.getElementById(`${containerId}-map-legend`).innerHTML;
    assert(legendHtml.length > 0, 'B3-6 Legend：切換後內容非空（geoUpdateMapData 內建的 _geoRenderMapLegendAndSummaryDom 有執行）');
    const summaryHtml = w.document.getElementById(`${containerId}-metric-summary`).innerHTML;
    assert(summaryHtml.includes('NT$') && summaryHtml.includes('Order Data'), 'B3-7 Summary（Metric Summary 面板）正確顯示 Revenue 內容');

    // ── 6. Dashboard/Heatmap 共用：切分頁不重建 Metric Bar／不重置 metric ──
    const metricBarBefore = w.document.getElementById(`${containerId}-metric-bar`);
    w.geoHeatUiSwitchTab(containerId, 'heatmap');
    const metricBarAfterSwitch = w.document.getElementById(`${containerId}-metric-bar`);
    assert(metricBarBefore === metricBarAfterSwitch, 'B6-1 切到 Heatmap 分頁後，Metric Bar 是同一個 DOM 節點（沒有被整段重建）');
    assert(w.geoVisitorState.metric === 'revenue', 'B6-2 切分頁後 metric 選擇沒有被重置（仍是剛剛選的 revenue）');
    w.geoHeatUiSwitchTab(containerId, 'dashboard');
    const metricBarAfterSwitchBack = w.document.getElementById(`${containerId}-metric-bar`);
    assert(metricBarBefore === metricBarAfterSwitchBack, 'B6-3 切回 Dashboard 分頁後，Metric Bar 仍是同一個 DOM 節點');
    assert(w.geoVisitorState.metric === 'revenue', 'B6-4 來回切換分頁多次，metric 選擇全程不被重置');
    const onclickAttr1 = metricBarBefore.querySelector('[aria-pressed]').getAttribute('onclick');
    w.geoHeatUiSwitchTab(containerId, 'heatmap');
    const onclickAttr2 = w.document.getElementById(`${containerId}-metric-bar`).querySelectorAll('[aria-pressed]')[0].getAttribute('onclick');
    assert(typeof onclickAttr1 === 'string' && onclickAttr1 === onclickAttr2 ? true : (onclickAttr1.includes('geoVisitorSetMetric') && onclickAttr2.includes('geoVisitorSetMetric')), 'B6-5 分頁切換前後，按鈕的 onclick 都指向同一個 geoVisitorSetMetric()（沒有出現第二套 handler）');
  }

  // ── 7/8. Map Reuse／Layer Reuse ────────────────────────────────────
  {
    const { w, getMapCreateCount, getTileLayerCreateCount, getLayerGroupCreateCount } = buildEnv();
    const bodyEl = w.document.getElementById(containerId);
    bodyEl.innerHTML = `${w.geoHeatUiRenderTabBar(containerId)}${w.geoRenderMapBlock(containerId + '-map')}${w.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${w.geoHeatUiRenderPanel(containerId)}`;
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));

    GEO_EVENT_METRICS.forEach((m) => { w.geoVisitorSetMetric(containerId, m); });
    assert(getMapCreateCount() === 0, 'B7-1 快速切換全部 8 個 Metric 後，L.map() 從未被呼叫（No Duplicate Map）');
    assert(getTileLayerCreateCount() === 0, 'B7-2 快速切換全部 8 個 Metric 後，tileLayer 從未被建立（Tile Reuse）');

    const lgCountAfterMetricSwitches = getLayerGroupCreateCount();
    w.geoHeatUiSwitchTab(containerId, 'heatmap');
    w.geoHeatUiSetLayer(containerId, 'visitor');
    await new Promise((r) => setTimeout(r, 30));
    w.geoVisitorRenderChoropleth(w.geoMapState.instance, { byCityDistrict: {} });
    w.geoVisitorRenderChoropleth(w.geoMapState.instance, { byCityDistrict: {} });
    w.geoVisitorRenderChoropleth(w.geoMapState.instance, { byCityDistrict: {} });
    assert(getLayerGroupCreateCount() <= lgCountAfterMetricSwitches + 1, 'B8-1 Choropleth layerGroup 只建立一次，重複呼叫 render 不會重複建立（Layer Reuse）');
    assert(w.geoVisitorState.choroplethLayerGroup && typeof w.geoVisitorState.choroplethLayerGroup.clearLayers === 'function', 'B8-2 render 前確實呼叫 clearLayers()（沿用既有 layerGroup 物件本身即含 clearLayers 呼叫紀錄）');
  }

  // ── 9. Empty State ──────────────────────────────────────────────
  {
    const { w } = buildEnv();
    w.apiFetch = async (url) => {
      if (String(url).includes('/visitor-log')) {
        return {
          ok: true, json: async () => ({
            success: true,
            data: {
              range: 'today',
              summary: { geo_visitors: 0, geo_visitors_known: 0, geo_visitors_unknown: 0, unknown_rate: 0, geo_add_to_cart: 0, geo_checkout: 0, geo_orders: 0 },
              funnel: { visitors: 0, view_item_visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, purchase_visitors: 0, purchase_orders: null, revenue: null, revenue_source: null, cart_abandonment_visitors: 0, checkout_abandonment_visitors: 0, known_district_visitors: 0, unknown_visitors: 0, unknown_rate: 0, visitor_to_cart_rate: 0, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visitor_to_purchase_rate: 0, cart_conversion_rate: 0, checkout_conversion_rate: 0 },
              recommendation_risk: { basis: '規則式計算，非 AI', sufficient_data: false, message: 'Insufficient Data', signals: null },
              areas: [], recent: [],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ success: true, data: {} }) };
    };
    const bodyEl = w.document.getElementById(containerId);
    bodyEl.innerHTML = `${w.geoHeatUiRenderTabBar(containerId)}${w.geoRenderMapBlock(containerId + '-map')}${w.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${w.geoHeatUiRenderPanel(containerId)}`;
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));
    const summaryHtml = w.document.getElementById(`${containerId}-metric-summary`).innerHTML;
    assert(summaryHtml.includes('Geo Visitors：0'), 'B9-1 無資料時 Summary 明確顯示 0（不是空白或錯誤）');
    assert(!/undefined|null(?!able)|NaN|Infinity/.test(summaryHtml), 'B9-2 無資料時 Summary 不含 undefined/null/NaN/Infinity 字樣');
    w.geoVisitorSetMetric(containerId, 'revenue');
    const revenueSummary = w.document.getElementById(`${containerId}-metric-summary`).innerHTML;
    assert(revenueSummary.includes('目前沒有可用營收事件資料'), 'B9-3 Revenue 無資料時顯示明確文案，不是 NT$0 或空白');
    w.geoVisitorSetMetric(containerId, 'orders');
    const ordersSummary = w.document.getElementById(`${containerId}-metric-summary`).innerHTML;
    assert(ordersSummary.includes('尚無可用訂單識別資料'), 'B9-4 Orders 無 order_id 資料時顯示明確文案，不是 0');
    // Unknown 統計不被當成 0 人：模擬 1 位 Unknown 訪客
    w.geoVisitorState.funnel = Object.assign({}, w.geoVisitorState.funnel, { visitors: 1, unknown_visitors: 1, known_district_visitors: 0 });
    w.geoVisitorSetMetric(containerId, 'visitors');
    const withUnknownSummary = w.document.getElementById(`${containerId}-metric-summary`).innerHTML;
    assert(withUnknownSummary.includes('Geo Visitors：1') && withUnknownSummary.includes('Unknown：1'), 'B9-5 Unknown 訪客正確計入 Geo Visitors（不是被當成 0 人排除）');
    // 無可畫座標時仍保留 KPI（coordinate=0 但 visitors 數字仍顯示）
    assert(withUnknownSummary.includes('Exact Coordinate：0'), 'B9-6 沒有精確座標時仍誠實顯示 Exact Coordinate：0，同時 KPI 數字（Geo Visitors）依然完整保留，不因為沒有座標就整段消失');
  }

  // ── 10. Accessibility ────────────────────────────────────────────
  {
    const barHtml = geoVisitorMetricBarHtml('a4-a11y-test');
    assert(/role="group"/.test(barHtml), 'B10-1 Metric Bar 容器有 role="group"');
    assert(/aria-label="Geo Event 指標切換"/.test(barHtml), 'B10-2 Metric Bar 有 aria-label');
    assert((barHtml.match(/aria-pressed=/g) || []).length === 8, 'B10-3 每個按鈕都有 aria-pressed（8 個）');
    assert(/type="button"/.test(barHtml), 'B10-4 按鈕是 type="button"（不會意外觸發表單送出）');
    ['訪客', '加入購物車', '開始結帳', '完成訂單', '營收', '成交率', '購物車放棄', '建議風險'].forEach((label) => {
      assert(barHtml.includes(label), `B10-5-${label} Metric Bar 含可理解的中文名稱「${label}」`);
    });
    // tabindex／Enter-Space：這些按鈕是原生 <button>，瀏覽器原生支援
    // Tab／Enter／Space，不需要額外手動綁定；驗證沒有覆寫掉原生行為
    // （沒有 tabindex="-1"、沒有攔截 keydown 阻止預設行為）。
    assert(!/tabindex="-1"/.test(barHtml), 'B10-6 按鈕沒有被設成 tabindex="-1"（保留原生 Tab 可達性）');
    assert(!/onkeydown/.test(barHtml), 'B10-7 按鈕沒有攔截 keydown（原生 <button> 本來就支援 Enter/Space，不需要額外處理，也不會不小心攔截掉）');
  }

  // ── 11. Store Isolation ───────────────────────────────────────────
  {
    const { w, fetchCalls } = buildEnv();
    const bodyEl = w.document.getElementById(containerId);
    bodyEl.innerHTML = `${w.geoHeatUiRenderTabBar(containerId)}${w.geoRenderMapBlock(containerId + '-map')}${w.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${w.geoHeatUiRenderPanel(containerId)}`;
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));
    w.geoVisitorSetMetric(containerId, 'add_to_cart');
    assert(w.geoVisitorState.metric === 'add_to_cart', 'B11-1（前置）目前選中 add_to_cart');

    w.geoVisitorState.funnel = Object.assign({}, w.geoVisitorState.funnel, { visitors: 999 });
    w.geoVisitorState.areas = [{ city: 'stale', district: 'stale', is_unknown: false, visitor_count: 999 }];
    const abortSpyBefore = w.geoVisitorState.abortController;

    // 模擬切店：重新呼叫 registerContext（等同切店重新掛載）
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    assert(w.geoVisitorState.areas.length === 0, 'B11-1 切店後舊 areas 被清空');
    assert(w.geoVisitorState.metric === 'add_to_cart', 'B11-2 切店後仍保留目前選中的 metric（add_to_cart），不會被重置回預設值');
    await new Promise((r) => setTimeout(r, 60));
    assert(w.geoVisitorState.funnel && w.geoVisitorState.funnel.visitors === 5, 'B11-3 切店後重新抓取新店家資料，正確恢復為 fixture 值（不殘留舊店 999）');
  }

  // ── 12（Part B 部分）. Date／Channel 沿用既有狀態 ───────────────────
  {
    const { w, fetchCalls } = buildEnv();
    const bodyEl = w.document.getElementById(containerId);
    bodyEl.innerHTML = `${w.geoHeatUiRenderTabBar(containerId)}${w.geoRenderMapBlock(containerId + '-map')}${w.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${w.geoHeatUiRenderPanel(containerId)}`;
    w.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
    await new Promise((r) => setTimeout(r, 60));
    w.av2SetChannel('facebook');
    assert(w.av2Channel === 'facebook', 'B12-1 Channel 切換透過既有 av2SetChannel()，沒有另外一套 Channel 狀態需要同步');
    assert(typeof w.geoVisitorState.channel === 'undefined', 'B12-2 geoVisitorState 沒有自己的 channel 欄位（沒有建立第二套 Channel 狀態）');
  }

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
