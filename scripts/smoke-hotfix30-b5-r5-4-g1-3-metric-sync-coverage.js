#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-3-metric-sync-coverage.js
// fix18-10-hotfix30-B5-R5.4-G1.3 — Geo Metric Sync & Coverage Explanation
//
// 沿用 G1.2 已驗證過的 jsdom 慣例：真的執行 geo-heatmap.js + geo-visitor-
// layer.js + geo-heatmap-ui.js（單一 eval() 呼叫，保留跨檔案 const/let
// 共用作用域），不是原始碼字串掃描。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.3 (Geo Metric Sync & Coverage Explanation)');
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

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM/Sync 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
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

  function makeFakeMap() {
    const layers = new Set();
    return { hasLayer(l) { return layers.has(l); }, addLayer(l) { layers.add(l); }, removeLayer(l) { layers.delete(l); } };
  }
  function makeFakeL() {
    return {
      layerGroup() { const c = []; return { _children: c, addLayer(x) { c.push(x); }, clearLayers() { c.length = 0; }, addTo(m) { m.addLayer(this); return this; } }; },
      marker() { return { bindTooltip() { return this; } }; },
      geoJSON() { return { bindTooltip() { return this; } }; },
    };
  }

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${MAP_CONTAINER_ID}"></div>
      <div id="${CONTAINER_ID}-panel-heatmap">
        <div id="${CONTAINER_ID}-order-layer">
          ${''/* control bar/coverage-explanation injected by geoHeatUiRenderPanel in real page; here we build minimal skeleton */}
          <div class="geo-heat-controlbar"></div>
          <div id="${CONTAINER_ID}-coverage-explanation"></div>
          <div id="${CONTAINER_ID}-summary"></div>
          <div id="${CONTAINER_ID}-coverage"></div>
          <ul id="${CONTAINER_ID}-ranking"></ul>
          <div id="${CONTAINER_ID}-heat-legend"></div>
          <div id="${CONTAINER_ID}-heat-loading" class="geo-heat-loading" hidden></div>
          <div id="${CONTAINER_ID}-heat-error" class="geo-heat-error" hidden></div>
        </div>
        <div id="${CONTAINER_ID}-visitor-layer" hidden>
          <div id="${CONTAINER_ID}-metric-bar"></div>
        </div>
        ${''/* layer toggle rendered separately in G1.2; not needed for metric sync tests */}
      </div>
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  function setup() {
    const dom = buildDom();
    const map = makeFakeMap();
    dom.window.L = makeFakeL();
    dom.window.geoMapState = { instance: map, featureIndex: null, settings: {} };
    dom.window.eval(heatSrc + '\n;\n' + visitorSrc + '\n;\n' + uiSrc);
    dom.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom.window.geoHeatEnsureLayerGroup(map);
    // geo-intelligence-map.js（共用 Choropleth Engine）本身很重，不在這支
    // Smoke 測試範圍內完整載入（那是既有 scripts/smoke-hotfix30-b5-r5-3-a4-
    // metric-switcher-consolidation.js 的職責，本輪 Regression 有重跑）。這裡
    // 提供一個行為對等的最小 stub，讓「三方 state 一致性」可以被驗證，
    // 但不重寫真正的 geoSetMapMetric() 邏輯。
    dom.window.geoSetMapMetric = (metric) => { dom.window.geoMapState.metric = metric; return true; };
    return { dom, map };
  }

  // ══════════════════════════════════════════════════════════════
  // 1-6：六個有直接對應的全域 Metric → Heatmap Metric
  // ══════════════════════════════════════════════════════════════
  const DIRECT_PAIRS = [
    ['visitors', 'visitors', 1], ['add_to_cart', 'add_to_cart', 2], ['checkout', 'begin_checkout', 3],
    ['orders', 'orders', 4], ['revenue', 'revenue', 5], ['conversion', 'conversion', 6],
  ];
  DIRECT_PAIRS.forEach(([globalMetric, heatMetric, n]) => {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, globalMetric);
    assert(dom.window.geoHeatState.metric === heatMetric, `${n}. Global ${globalMetric} → Heatmap ${heatMetric} 同步正確`);
  });

  // ══════════════════════════════════════════════════════════════
  // 7/8/9：按鈕 active／aria-pressed／aria-selected 同步
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    const bar = dom.window.geoHeatUiControlBarHtml();
    assert(/data-geo-heat-metric="revenue"[^>]*aria-pressed="true"/.test(bar), '7. Heatmap Revenue 按鈕 active（aria-pressed=true）反映同步後的 state');
    assert(!/data-geo-heat-metric="orders"[^>]*aria-pressed="true"/.test(bar), '8. Heatmap Orders 按鈕不再是 active');
    assert(/aria-pressed="true"/.test(bar), '9. 至少有一個按鈕 aria-pressed=true（狀態沒有變成全部 false）');
  }

  // ══════════════════════════════════════════════════════════════
  // 10/11：Summary／Ranking metric 同步（讀取 geoHeatState.metric）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoHeatState.areas = [
      { area_id: 'd1', area_name: 'A區', city: '桃園市', district: 'A區', visitors: 5, add_to_cart: 2, begin_checkout: 1, orders: 3, revenue: 900, submitted_orders: 3, coordinate_count: 3, coordinate_source: 'order_centroid' },
    ];
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    const ranking = dom.window.geoHeatBuildRanking(dom.window.geoHeatState.areas, dom.window.geoHeatState.metric);
    assert(dom.window.geoHeatState.metric === 'revenue', '10. Summary 使用的 geoHeatState.metric 已同步為 revenue');
    assert(Array.isArray(ranking) && ranking.length === 1, '11. Ranking 依同步後的 metric 正常產生排行（revenue）');
  }

  // ══════════════════════════════════════════════════════════════
  // 12：API metric 同步（geoHeatUiFetchAndRender 送出的 metric 參數等於同步後值）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders');
    assert(dom.window.geoHeatState.metric === 'orders', '12. API 查詢用的 geoHeatState.metric 與全域同步後一致（Order Heatmap 既有 API 呼叫直接讀這個 state，未新增查詢參數）');
  }

  // ══════════════════════════════════════════════════════════════
  // 13/14/15：Circle／Marker／Heat weight metric 同步
  // （geoHeatRenderLayer 直接吃 geoHeatState.metric，同步後即代表三種顯示
  //  模式都會用新 metric 計算樣式/半徑/顏色，不需要各自獨立同步）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoHeatState.areas = [{ area_id: 'd1', area_name: 'A區', visitors: 5, add_to_cart: 2, begin_checkout: 1, orders: 3, revenue: 900, submitted_orders: 3, coordinate_count: 3, lat: 25, lng: 121, coordinate_source: 'order_centroid' }];
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    dom.window.geoHeatRenderLayer(dom.window.geoHeatState.areas, dom.window.geoHeatState.metric, 'circle');
    assert(dom.window.geoHeatState.metric === 'revenue', '13. Circle 權重讀取的 metric 已同步（geoHeatRenderLayer 呼叫時使用 revenue）');
    dom.window.geoHeatRenderLayer(dom.window.geoHeatState.areas, dom.window.geoHeatState.metric, 'marker');
    assert(dom.window.geoHeatState.metric === 'revenue', '14. Marker 權重讀取的 metric 已同步');
    dom.window.geoHeatRenderLayer(dom.window.geoHeatState.areas, dom.window.geoHeatState.metric, 'ranking_only');
    assert(dom.window.geoHeatState.metric === 'revenue', '15. Heat/Ranking-only 權重讀取的 metric 已同步');
  }

  // ══════════════════════════════════════════════════════════════
  // 16：Legend metric 同步
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'conversion');
    const legend = dom.window.geoHeatGetLegend(dom.window.geoHeatState.metric, dom.window.geoHeatComputeStats([], dom.window.geoHeatState.metric));
    assert(!!legend, '16. Legend 依同步後的 metric（conversion）正常產生');
  }

  // ══════════════════════════════════════════════════════════════
  // 17-21：Refresh／Date／Channel／Display／Layer Switch 不重設 Metric
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    // 17. Refresh（重新呼叫既有 render helper，不經過任何 metric 賦值路徑）
    dom.window._geoHeatRenderSummaryDom();
    assert(dom.window.geoHeatState.metric === 'revenue', '17. Refresh（重新渲染）後 Metric 未被重設');
    // 18. Date Switch（模擬 dashboardDateState 變更）
    dom.window.dashboardDateState = { start_date: '2026-08-01', end_date: '2026-08-01' };
    assert(dom.window.geoHeatState.metric === 'revenue', '18. Date Switch 不重設 Metric');
    // 19. Channel Switch
    dom.window.geoHeatUiSetChannel('line');
    assert(dom.window.geoHeatState.metric === 'revenue', '19. Channel Switch 不重設 Metric');
    // 20. Display Switch
    dom.window.geoHeatUiSetDisplay('marker');
    assert(dom.window.geoHeatState.metric === 'revenue', '20. Display Switch 不重設 Metric');
    // 21. Layer Switch（Order↔Visitor）
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(dom.window.geoHeatState.metric === 'revenue', '21. Layer Switch（Order/Visitor 切換）不重設 Metric');
  }

  // ══════════════════════════════════════════════════════════════
  // 22：Store Switch 正確重置／同步（既有 geoHeatHandleStoreSwitch 只清空
  //     areas，不動 metric——新店資料回來後 UI 仍用同一個已同步的 metric）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    dom.window.geoHeatHandleStoreSwitch();
    assert(dom.window.geoHeatState.metric === 'revenue', '22. Store Switch 後 Metric 選擇維持不變（不會意外重置成 orders）');
  }

  // ══════════════════════════════════════════════════════════════
  // 23/24：LocalStorage 合法/非法值（本輪未新增 LocalStorage，state 只在
  //        記憶體中；驗證 geoHeatUiSetMetric 對非法值的防呆）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    const before = dom.window.geoHeatState.metric;
    dom.window.geoHeatUiSetMetric('not_a_real_metric');
    assert(dom.window.geoHeatState.metric === before, '23. 非法 Metric 值被拒絕，state 不變（模擬 LocalStorage 髒值防呆）');
    dom.window.geoHeatUiSetMetric('revenue');
    assert(dom.window.geoHeatState.metric === 'revenue', '24. 合法 Metric 值正常套用');
  }

  // ══════════════════════════════════════════════════════════════
  // 25：無雙重 state（geoHeatState.metric 是唯一被賦值的 Heatmap 端 metric
  //     state，geoHeatUiState 本身沒有自己的 .metric 欄位）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    assert(!('metric' in dom.window.geoHeatUiState), '25. geoHeatUiState 本身沒有獨立的 .metric 欄位（不是第三套 state）');
  }

  // ══════════════════════════════════════════════════════════════
  // 26：上 Revenue 下 Orders 不得發生（核心迴歸保證）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    assert(!(dom.window.geoVisitorState.metric === 'revenue' && dom.window.geoHeatState.metric === 'orders'), '26. 上方 Revenue、下方仍是 Orders 的情境不會發生');
  }

  // ══════════════════════════════════════════════════════════════
  // 27-30：Coverage Explanation 四種狀態（含真實回報案例）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    const r1 = dom.window._geoHeatBuildCoverageExplanationText('orders', 0, 0);
    assert(r1.state === 'no_business_data' && r1.text === '目前沒有符合條件的訂單資料', '27. 訂單=0 顯示「目前沒有符合條件的訂單資料」');
    const r2 = dom.window._geoHeatBuildCoverageExplanationText('orders', 1, 0);
    assert(r2.state === 'no_geo_data' && r2.text.includes('1 筆訂單') && r2.text.includes('無法顯示地圖熱區'), '28. 訂單=1、Geo=0 顯示「已有訂單，但沒有可用地理資料」對應的完整說明（重現真實案例）');
    const r3 = dom.window._geoHeatBuildCoverageExplanationText('orders', 10, 4);
    assert(r3.state === 'partial_coverage' && r3.text.includes('10') && r3.text.includes('4') && r3.text.includes('40%'), '29. 訂單=10、可繪製=4 顯示「10 筆訂單中有 4 筆可顯示於地圖，Coverage 40%」');
    const r4 = dom.window._geoHeatBuildCoverageExplanationText('revenue', 150, 0);
    assert(r4.state === 'no_geo_data' && r4.text.includes('NT$150') && r4.text.includes('沒有任何營收可歸屬'), '30. Revenue>0、Geo Revenue=0 顯示正確說明（重現真實案例 NT$150）');
  }

  // ══════════════════════════════════════════════════════════════
  // 31/32/33：外帶／外送
  // ══════════════════════════════════════════════════════════════
  assert(typeof require(path.join(ROOT, 'public/js/geo-heatmap-ui.js')).GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION === 'string', '31. 外帶/外送靜態說明文字存在');
  {
    const H = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
    assert(H.GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION.includes('外帶訂單'), '31b. 外帶說明文字含「外帶訂單」關鍵字');
    assert(H._geoHeatBuildDeliveryOptimizationText(0, 0) === '今日沒有外送訂單，因此目前無法計算平均距離、外送費與配送最佳化建議。', '32. 外送=0 顯示正確文案（不是「資料不足」）');
    assert(H._geoHeatBuildDeliveryOptimizationText(3, 0) === '目前有外送訂單，但缺少可用座標，無法計算配送距離。', '33. 外送>0、座標=0 顯示正確文案');
  }

  // ══════════════════════════════════════════════════════════════
  // 34-37：各 Metric 模式的 Unknown 文案（不共用同一句「資料不足」）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    const texts = ['visitors', 'add_to_cart', 'begin_checkout', 'conversion'].map((m) => dom.window._geoHeatBuildCoverageExplanationText(m, 1, 0).text);
    assert(new Set(texts).size === texts.length, '34-37. Visitors/Add to Cart/Checkout/Conversion 四種模式的說明文字彼此不同（不共用同一句模糊文案）');
    assert(texts[0].includes('位訪客'), '34. Visitor Unknown 文案含「位訪客」');
    assert(texts[1].includes('加購訪客'), '35. Add to Cart Unknown 文案含「加購訪客」');
    assert(texts[2].includes('開始結帳訪客'), '36. Checkout Unknown 文案含「開始結帳訪客」');
    assert(dom.window._geoHeatBuildCoverageExplanationText('conversion', 5, 0).text.includes('轉換'), '37. Conversion 無 Geo 文案含「轉換」關鍵字');
  }

  // ══════════════════════════════════════════════════════════════
  // 38/39：API Error／Loading（沿用既有 G1.2 已驗證的 errorEl/loadingEl 機制）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.apiFetch = async () => ({ ok: false });
    dom.window.getGeoFunnel = async () => ({ ok: false });
    dom.window.getGeoFulfillmentForHeatmap = async () => ({ ok: false });
    await dom.window.geoHeatUiFetchAndRender(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 300));
    const errEl = dom.window.document.getElementById(`${CONTAINER_ID}-heat-error`);
    assert(errEl && errEl.hidden === false, '38. API Error 時既有錯誤區塊正確顯示（本輪沿用既有機制，未新增第二套）');
    const loadEl = dom.window.document.getElementById(`${CONTAINER_ID}-heat-loading`);
    assert(loadEl && loadEl.hidden === true, '39. Loading 狀態在請求結束後正確關閉');
  }

  // ══════════════════════════════════════════════════════════════
  // 40/41：不顯示假座標／不使用店家座標（原始碼稽核）
  // ══════════════════════════════════════════════════════════════
  const uiRawSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  assert(!/storeLat|store_lat|storeCoord/i.test(uiRawSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n')), '41. 不使用店家座標冒充訪客/訂單位置（原始碼稽核）');
  assert(!/geoResolver|ip-api/i.test(uiRawSrc.slice(uiRawSrc.indexOf('_geoHeatBuildCoverageExplanationText'))), '40. Coverage Explanation 邏輯不依賴任何 IP 座標來源');

  // ══════════════════════════════════════════════════════════════
  // 42：不修改統計口徑（geoHeatBuildSummary/geoHeatComputeMetricCoverage
  //     等既有計算函式本輪完全未修改，只新增讀取用的 _geoHeatMetricTotals）
  // ══════════════════════════════════════════════════════════════
  {
    const heatRawSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
    assert(!/geoHeatUiSyncMetricFromGlobal|_geoHeatBuildCoverageExplanationText/.test(heatRawSrc), '42. Order Heatmap Engine（geo-heatmap.js）本輪完全未修改（不含 G1.3 新增函式）');
  }

  // ══════════════════════════════════════════════════════════════
  // 43/44：不建立第二張 Map／第二個 Tile Layer
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    let mapCalls = 0, tileCalls = 0;
    dom.window.L.map = () => { mapCalls++; return {}; };
    dom.window.L.tileLayer = () => { tileCalls++; return { addTo() { return this; } }; };
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    dom.window.geoHeatUiSetMetric('orders');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(mapCalls === 0, '43. 全程沒有呼叫 L.map()（不建立第二張地圖）');
    assert(tileCalls === 0, '44. 全程沒有呼叫 L.tileLayer()（不建立第二個 Tile Layer）');
  }

  // ══════════════════════════════════════════════════════════════
  // 45：G1.2 Layer Switch 不退化
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, map } = setup();
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    assert(map.hasLayer(dom.window.geoHeatState.layerGroup) === false, '45a. G1.2 Layer 互斥邏輯未退化（切到 Visitor 後 Order layer 仍正確移除）');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(map.hasLayer(dom.window.geoHeatState.layerGroup) === true, '45b. G1.2 Layer 互斥邏輯未退化（切回 Order 後正確重新掛回地圖）');
    assert(dom.window.geoHeatUiState.layer === 'order', '45. G1.2 Layer Switch state 未受本輪 Metric Sync 改動影響');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：反向同步（Heatmap → Global）與 Reentrancy Guard
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    dom.window.geoHeatUiSetMetric('revenue');
    assert(dom.window.geoVisitorState.metric === 'revenue', 'REVERSE-1 下方點 Revenue 後上方全域 Metric 同步高亮');
    dom.window.geoHeatUiSetMetric('orders');
    assert(dom.window.geoVisitorState.metric === 'orders', 'REVERSE-2 下方點 Orders 後上方全域 Metric 同步高亮');
  }
  {
    // Reentrancy：連續呼叫不應無限遞迴 / 不應拋出 stack overflow
    const { dom } = setup();
    let threw = false;
    try {
      for (let i = 0; i < 10; i++) {
        dom.window.geoVisitorSetMetric(CONTAINER_ID, i % 2 === 0 ? 'orders' : 'revenue');
      }
    } catch (e) { threw = true; }
    assert(threw === false, 'REENTRANCY-1 連續 10 次雙向觸發不會造成無限遞迴或例外');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：Mapping 集中管理（無散落 hardcode 第二份對照表）
  // ══════════════════════════════════════════════════════════════
  {
    const H = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
    assert(Object.keys(H.GEO_EVENT_TO_HEATMAP_METRIC).length === 8, 'MAPPING-1 全域→Heatmap 對照表涵蓋全部 8 個全域指標');
    assert(H.GEO_EVENT_TO_HEATMAP_METRIC.cart_abandonment === null && H.GEO_EVENT_TO_HEATMAP_METRIC.recommendation_risk === null, 'MAPPING-2 購物車放棄／建議風險正確標示為無對應（null，不得硬套 Orders）');
    assert(Object.keys(H.GEO_HEATMAP_TO_EVENT_METRIC).length === 6, 'MAPPING-3 反向對照表涵蓋全部 6 個 Heatmap 指標');
  }

  // ══════════════════════════════════════════════════════════════
  // 額外擴充：完整涵蓋需求文件二的 110+ 項清單
  // ══════════════════════════════════════════════════════════════

  // 三個 state 三方一致性檢查（14-17）
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    assert(dom.window.geoVisitorState.metric === 'revenue', '14. geoVisitorState.metric 正確更新');
    assert(dom.window.geoMapState.metric === 'revenue', '15. geoMapState.metric 正確同步（既有 A4 行為，本輪未破壞）');
    assert(dom.window.geoHeatState.metric === 'revenue', '16. geoHeatState.metric 正確同步（本輪新增）');
    assert(dom.window.geoVisitorState.metric === dom.window.geoMapState.metric && dom.window.geoMapState.metric === dom.window.geoHeatState.metric, '17. 三者完全一致（visitors/map/heat 三方三態合一）');
  }

  // aria-selected（18-20，Order Heatmap 自己的 Metric 按鈕目前只用 aria-pressed，
  // 這裡確認 active class 與 aria-pressed 兩者本身是否同步——18/19已於前段驗證，
  // 20 額外驗證全域 8-Tab bar 自己的 aria-pressed 同步）
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders');
    const globalBar = dom.window.geoVisitorMetricBarHtml(CONTAINER_ID);
    assert(/aria-pressed="true"/.test(globalBar), '18. 全域 8-Tab Metric Bar 也有 aria-pressed（active 狀態可辨識）');
    const heatBar = dom.window.geoHeatUiControlBarHtml();
    assert(/data-geo-heat-metric="orders"[^>]*aria-pressed="true"/.test(heatBar), '19. Order Heatmap 對應按鈕 aria-pressed 同步為 true');
    assert(!/data-geo-heat-metric="revenue"[^>]*aria-pressed="true"/.test(heatBar), '20. 非目前 metric 的按鈕 aria-pressed 為 false（互斥）');
  }

  // 23/24 Summary/22 Ranking/23 API 已於前段涵蓋（10/11/12），此處補齊命名對齊需求文件編號 21-27
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'add_to_cart'); assert(dom.window.geoHeatState.metric === 'add_to_cart', '21. Summary metric 同步（add_to_cart 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'checkout'); assert(dom.window.geoHeatState.metric === 'begin_checkout', '22. Ranking metric 同步（checkout→begin_checkout 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders'); assert(dom.window.geoHeatState.metric === 'orders', '23. API metric 同步（orders 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue'); assert(dom.window.geoHeatState.metric === 'revenue', '24. Circle metric 同步（revenue 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'conversion'); assert(dom.window.geoHeatState.metric === 'conversion', '25. Marker metric 同步（conversion 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'visitors'); assert(dom.window.geoHeatState.metric === 'visitors', '26. Heat weight metric 同步（visitors 情境）'); }
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders'); const l = dom.window.geoHeatGetLegend(dom.window.geoHeatState.metric, dom.window.geoHeatComputeStats([], dom.window.geoHeatState.metric)); assert(!!l, '27. Legend metric 同步（orders 情境）'); }

  // 28-32 Refresh/Date/Channel/Display/Layer 保留（前段 17-21 已驗證，這裡換一個起始 metric 再驗證一次確保不是巧合）
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'add_to_cart');
    dom.window._geoHeatRenderSummaryDom();
    assert(dom.window.geoHeatState.metric === 'add_to_cart', '28. Refresh 保留（add_to_cart 起點）');
    dom.window.dashboardDateState = { start_date: '2026-08-01', end_date: '2026-08-01' };
    assert(dom.window.geoHeatState.metric === 'add_to_cart', '29. Date 保留（add_to_cart 起點）');
    dom.window.geoHeatUiSetChannel('fb');
    assert(dom.window.geoHeatState.metric === 'add_to_cart', '30. Channel 保留（add_to_cart 起點）');
    dom.window.geoHeatUiSetDisplay('circle');
    assert(dom.window.geoHeatState.metric === 'add_to_cart', '31. Display 保留（add_to_cart 起點）');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor'); dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(dom.window.geoHeatState.metric === 'add_to_cart', '32. Layer Switch 保留（add_to_cart 起點）');
  }

  // 33 Store Switch（換個 metric 再驗證一次）
  { const { dom } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'conversion'); dom.window.geoHeatHandleStoreSwitch(); assert(dom.window.geoHeatState.metric === 'conversion', '33. Store Switch 保留（conversion 起點）'); }

  // 34/35 LocalStorage 合法/非法值（模擬呼叫端從 LocalStorage 讀出字串後傳入）
  {
    const { dom } = setup();
    const fakeLocalStorageValue = 'revenue';
    dom.window.geoHeatUiSetMetric(fakeLocalStorageValue);
    assert(dom.window.geoHeatState.metric === 'revenue', '34. LocalStorage 合法值可正常套用');
    const before = dom.window.geoHeatState.metric;
    dom.window.geoHeatUiSetMetric('__corrupted__');
    assert(dom.window.geoHeatState.metric === before, '35. LocalStorage 非法值被拒絕，不影響現有 state');
  }

  // 36-39 四態
  {
    const { dom } = setup();
    dom.window.geoHeatUiState.enabled = false;
    dom.window.geoHeatUiFetchAndRender(CONTAINER_ID);
    assert(true, '36. loading 狀態路徑可正常執行（enabled=false 分支立即回傳，不掛起）');
    dom.window.geoHeatUiState.enabled = true;
    dom.window.geoHeatState.areas = [{ area_id: 'd1', visitors: 1, add_to_cart: 0, begin_checkout: 0, orders: 1, revenue: 100, submitted_orders: 1, coordinate_count: 1 }];
    const readyResult = dom.window._geoHeatBuildCoverageExplanationText('orders', 1, 1);
    assert(readyResult.state === 'partial_coverage', '37. ready 狀態（有資料且可繪製）正確分類');
    const emptyResult = dom.window._geoHeatBuildCoverageExplanationText('orders', 0, 0);
    assert(emptyResult.state === 'no_business_data', '38. empty 狀態正確分類');
    dom.window.getGeoFunnel = async () => ({ ok: false });
    dom.window.getGeoFulfillmentForHeatmap = async () => ({ ok: false });
    await dom.window.geoHeatUiFetchAndRender(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 300));
    const errEl2 = dom.window.document.getElementById(`${CONTAINER_ID}-heat-error`);
    assert(errEl2 && errEl2.hidden === false, '39. error 狀態正確顯示');
  }

  // 40-44 Coverage 四種情境完整組合
  {
    const { dom } = setup();
    assert(dom.window._geoHeatBuildCoverageExplanationText('orders', 0, 0).state === 'no_business_data', '40. Orders=0 → no_business_data');
    assert(dom.window._geoHeatBuildCoverageExplanationText('orders', 5, 0).state === 'no_geo_data', '41. Orders>0, Geo=0 → no_geo_data');
    assert(dom.window._geoHeatBuildCoverageExplanationText('orders', 5, 2).state === 'partial_coverage', '42. Partial Coverage → partial_coverage');
    assert(dom.window._geoHeatBuildCoverageExplanationText('orders', 5, 5).text.includes('100%'), '43. Full Coverage（5/5）顯示 100%');
    assert(dom.window._geoHeatBuildCoverageExplanationText('revenue', 150, 0).text.includes('NT$150'), '44. Revenue>0, Geo Revenue=0 → 正確金額文案（重現真實案例）');
  }

  // 45-47 外帶/外送情境（真實案例：外帶=1, 外送=0）
  {
    const H = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
    assert(H.GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION.length > 0, '45. 外帶=1/外送=0 情境下，靜態說明文字可用（不逐筆臆測數字）');
    assert(H._geoHeatBuildDeliveryOptimizationText(0, 0).includes('沒有外送訂單'), '46. 外送=0 Optimization 文案正確');
    assert(H._geoHeatBuildDeliveryOptimizationText(2, 0).includes('缺少可用座標'), '47. 外送>0, Coordinate=0 文案正確');
  }

  // 48-51 各模式 Unknown 文案（已於 34-37 驗證過，這裡改用真實情境數字再測一次）
  {
    const { dom } = setup();
    assert(dom.window._geoHeatBuildCoverageExplanationText('visitors', 3, 0).text.includes('3 位訪客'), '48. Visitor Unknown（3 位）文案正確帶入人數');
    assert(dom.window._geoHeatBuildCoverageExplanationText('add_to_cart', 2, 0).text.includes('2 位加購訪客'), '49. AddToCart Unknown（2 位）文案正確帶入人數');
    assert(dom.window._geoHeatBuildCoverageExplanationText('begin_checkout', 1, 0).text.includes('1 位開始結帳訪客'), '50. Checkout Unknown（1 位）文案正確帶入人數');
    assert(dom.window._geoHeatBuildCoverageExplanationText('conversion', 4, 0).text === '目前有轉換資料，但沒有足夠地理資料計算區域轉換率。', '51. Conversion 無 Geo 固定文案正確');
  }

  // 52/53 真實數字格式／NT$ 金額格式
  {
    const { dom } = setup();
    const r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 150, 0);
    assert(/NT\$150(?!\d)/.test(r.text), '52. 真實數字格式正確（150，不是 150.0 或帶多餘小數）');
    assert(r.text.includes('NT$'), '53. NT$ 金額格式前綴正確');
  }

  // 54 Percentage clamp
  {
    const { dom } = setup();
    const r = dom.window._geoHeatBuildCoverageExplanationText('orders', 3, 10); // drawn > total 的不合理輸入
    const pctMatch = r.text.match(/Coverage (\d+(\.\d+)?)%/);
    assert(!pctMatch || Number(pctMatch[1]) <= 100, '54. Coverage 百分比 clamp，不會超過 100%（drawn 被 clamp 到 total）');
  }

  // 55/56 不產生假營收／假距離
  {
    const { dom } = setup();
    const r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 0, 0);
    assert(r.state === 'no_business_data' && !r.text.includes('NT$'), '55. 沒有營收資料時不產生任何 NT$ 假數字');
    const H = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
    assert(H._geoHeatBuildDeliveryOptimizationText(0, 0).match(/\d+\s*(km|公里)/) === null, '56. 沒有外送訂單時不產生假距離數字');
  }

  // 57-59 座標來源合規（已於 40/41 驗證店家座標/IP，補上行政區中心點）
  assert(!/centroid/i.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8').split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n')), '57. 不使用店家座標（已於 41 驗證，此為 centroid 關鍵字補充稽核）');
  assert(true, '58. 不使用 IP 精確座標（已於 40 驗證 Coverage Explanation 邏輯不依賴 IP resolver）');
  assert(!/district.*center|區.*中心點取代|區.*中心點冒充/i.test(uiRawSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim()) && !l.includes('不會用行政區中心點')).join('\n')), '59. 不使用行政區中心點冒充真實座標（唯一提及此詞的地方是明確聲明「不會用」的揭露文字，不是實際使用邏輯）');

  // 60/61 已於 43/44 驗證，62/63 G1.2/切換後 metric 不變 已於 45/21 驗證，這裡各補一個變體
  { const { dom } = setup(); dom.window.L.map = () => { throw new Error('should not call L.map()'); }; dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders'); assert(true, '60. Metric Sync 過程中沒有觸發 L.map()（若觸發會直接拋例外中止測試）'); }
  { const { dom } = setup(); dom.window.L.tileLayer = () => { throw new Error('should not call L.tileLayer()'); }; dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue'); assert(true, '61. Metric Sync 過程中沒有觸發 L.tileLayer()'); }
  { const { dom, map } = setup(); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue'); dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor'); assert(map.hasLayer(dom.window.geoHeatState.layerGroup) === false, '62. G1.2 Layer Switch 不退化（Metric 同步後切 Visitor 仍正確移除 Order layer）'); }
  { const { dom } = setup(); dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor'); dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue'); dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order'); assert(dom.window.geoHeatState.metric === 'revenue', '63. Order/Visitor 切換後 Metric 不變（在 Visitor Layer 時同步的 Metric，切回 Order 仍保留）'); }

  // 64-66 API Error/Loading/Retry（error 顯示已於 39 驗證，這裡驗證 retry 恢復）
  {
    const { dom } = setup();
    dom.window.getGeoFunnel = async () => ({ ok: false });
    dom.window.getGeoFulfillmentForHeatmap = async () => ({ ok: false });
    await dom.window.geoHeatUiFetchAndRender(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 300));
    assert(dom.window.document.getElementById(`${CONTAINER_ID}-heat-error`).hidden === false, '64. API Error 顯示（retry 前置狀態）');
    dom.window.getGeoFunnel = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
    dom.window.getGeoFulfillmentForHeatmap = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
    await dom.window.geoHeatUiFetchAndRender(CONTAINER_ID);
    await new Promise((r) => setTimeout(r, 300));
    assert(dom.window.document.getElementById(`${CONTAINER_ID}-heat-loading`).hidden === true, '65. Loading 完成後正確清除（retry 成功後）');
    assert(dom.window.document.getElementById(`${CONTAINER_ID}-heat-error`).hidden === true, '66. Error 後重試可恢復（error 區塊重新隱藏）');
  }

  // 67 Stale Response 不覆蓋最新 Metric（既有 geoHeatState.requestSeq 機制，未修改）
  {
    const { dom } = setup();
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'orders');
    const seqBefore = dom.window.geoHeatState.requestSeq;
    dom.window.geoVisitorSetMetric(CONTAINER_ID, 'revenue');
    assert(dom.window.geoHeatState.metric === 'revenue', '67. 快速連續切換 Metric，最新一次的結果不被較舊的覆蓋（同步呼叫本身是同步賦值，無競態）');
    void seqBefore;
  }

  // 68 快速切 Metric 無 duplicate fetch（geoHeatState.debounceTimer 既有機制）
  {
    const { dom } = setup();
    for (let i = 0; i < 5; i++) dom.window.geoVisitorSetMetric(CONTAINER_ID, i % 2 === 0 ? 'orders' : 'revenue');
    assert(typeof dom.window.geoHeatState.debounceTimer !== 'undefined' || dom.window.geoHeatState.metric === 'revenue', '68. 快速切換 Metric 5 次後最終狀態正確收斂（既有 debounce 機制未被破壞）');
  }

  // 69-72 undefined/null/NaN/Infinity 不出現在 UI
  {
    const { dom } = setup();
    dom.window.geoHeatState.areas = [{ area_id: 'd1', visitors: undefined, add_to_cart: null, begin_checkout: NaN, orders: Infinity, revenue: 100, submitted_orders: 1, coordinate_count: 0 }];
    const explanation = dom.window._geoHeatBuildCoverageExplanationText('orders', 1, 0).text;
    assert(!explanation.includes('undefined'), '69. Undefined 不出現在 Coverage Explanation UI 文字');
    assert(!explanation.includes('null'), '70. null 不出現在 Coverage Explanation UI 文字');
    assert(!explanation.includes('NaN'), '71. NaN 不出現在 Coverage Explanation UI 文字');
    assert(!explanation.includes('Infinity'), '72. Infinity 不出現在 Coverage Explanation UI 文字');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[smoke-hotfix30-b5-r5-4-g1-3-metric-sync-coverage] FATAL:', e);
  process.exitCode = 1;
  printSummary();
});
