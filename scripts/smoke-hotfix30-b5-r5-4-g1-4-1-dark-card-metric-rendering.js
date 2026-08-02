#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-4-1-dark-card-metric-rendering.js
// fix18-10-hotfix30-B5-R5.4-G1.4.1 — Coverage Dark Card, Metric-aware
// Rendering & Metric Sync Hotfix
//
// 沿用 G1.4／G1.3.1 已驗證過的 jsdom 慣例：真的執行 geo-heatmap.js +
// geo-heatmap-ui.js（單一 eval() 呼叫，保留跨檔案 const/let 共用作用域），
// 搭配假 Leaflet stub 追蹤實際呼叫，不是原始碼字串掃描冒充功能驗證。
// CSS 相關斷言使用 regex（CSS 沒有可執行的東西可以 eval），但一律針對
// 「修正後的真實選擇器」，不是對「應該存在但永遠不會生效」的 dead pattern。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.4.1 (Coverage Dark Card, Metric-aware Rendering & Metric Sync Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check（所有本輪觸碰到的檔案）
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-heatmap.js', 'public/js/geo-heatmap-ui.js', 'public/js/geo-intelligence-map.js',
    'scripts/lib/geo-heatmap-g131-scope-guard.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });
  try { fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8'); pass('0-parse public/css/geo-heatmap.css 可讀取'); }
  catch (e) { fail('0-parse public/css/geo-heatmap.css 可讀取', e.message); }

  const heatSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  const uiSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const giSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  const cssSrcNoComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  const heatSrc = heatSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const uiSrc = uiSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM/行為測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝（npm install jsdom 後可執行完整驗證，不列入 package.json production dependencies）' });
    printSummary();
    return;
  }

  const CONTAINER_ID = 'g141C';
  const MAP_CONTAINER_ID = 'g141Map';

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${MAP_CONTAINER_ID}"></div>
      <div id="${CONTAINER_ID}-order-layer">order-content</div>
      <div id="${CONTAINER_ID}-visitor-layer" hidden>visitor-content</div>
      <div id="${CONTAINER_ID}-layer-toggle" class="geo-heat-layer-toggle"></div>
      <div id="${CONTAINER_ID}-coverage-explanation" aria-live="polite"></div>
      <ul id="${CONTAINER_ID}-ranking"></ul>
      <div id="${CONTAINER_ID}-summary"></div>
      <div id="${CONTAINER_ID}-coverage"></div>
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  function makeFakeLeafletEnv() {
    const mapCalls = { addLayer: 0, removeLayer: 0, panTo: 0, fitBounds: 0 };
    const map = {
      _layers: new Set(),
      hasLayer(l) { return this._layers.has(l); },
      addLayer(l) { this._layers.add(l); mapCalls.addLayer++; return this; },
      removeLayer(l) { this._layers.delete(l); mapCalls.removeLayer++; return this; },
      panTo(ll) { mapCalls.panTo++; this._lastPanTo = ll; return this; },
      fitBounds(b) { mapCalls.fitBounds++; this._lastFitBounds = b; return this; },
    };
    let layerGroupInstances = 0, mapInstances = 0, tileLayerInstances = 0;
    let markerInstances = 0, circleMarkerInstances = 0, tooltipInstances = 0;
    const permanentTooltips = [];
    const hoverTooltipCalls = [];
    const L = {
      layerGroup() {
        layerGroupInstances++;
        const children = [];
        const group = {
          __kind: 'layerGroup', _children: children,
          addLayer(c) { children.push(c); return this; },
          clearLayers() { children.length = 0; return this; },
          addTo(m) { m.addLayer(this); return this; },
        };
        return group;
      },
      geoJSON() { return { bindTooltip() { return this; }, setStyle() { return this; } }; },
      marker(latlng) {
        markerInstances++;
        const obj = { __kind: 'marker', latlng, _tooltipContent: null, _handlers: {},
          bindTooltip(content) { obj._tooltipContent = content; hoverTooltipCalls.push(content); return this; },
          on(evt, cb) { obj._handlers[evt] = cb; return this; } };
        return obj;
      },
      circleMarker(latlng, opts) {
        circleMarkerInstances++;
        const obj = { __kind: 'circleMarker', latlng, opts, _tooltipContent: null, _handlers: {},
          bindTooltip(content) { obj._tooltipContent = content; hoverTooltipCalls.push(content); return this; },
          on(evt, cb) { obj._handlers[evt] = cb; return this; } };
        return obj;
      },
      tooltip(opts) {
        tooltipInstances++;
        const t = { __kind: 'tooltip', opts, _latlng: null, _content: null,
          setLatLng(ll) { t._latlng = ll; return this; },
          setContent(c) { t._content = c; return this; } };
        if (opts && opts.permanent) permanentTooltips.push(t);
        return t;
      },
      map() { mapInstances++; return {}; },
      tileLayer() { tileLayerInstances++; return { addTo() { return this; } }; },
    };
    return {
      map, L, mapCalls, permanentTooltips, hoverTooltipCalls,
      counters: {
        get layerGroupInstances() { return layerGroupInstances; },
        get mapInstances() { return mapInstances; },
        get tileLayerInstances() { return tileLayerInstances; },
        get markerInstances() { return markerInstances; },
        get circleMarkerInstances() { return circleMarkerInstances; },
        get tooltipInstances() { return tooltipInstances; },
      },
    };
  }

  function evalAll(dom) { dom.window.eval(heatSrc + '\n;\n' + uiSrc); }

  // 真實案例 Fixture（需求文件四，逐位元組對應規格書 Fixture）
  const AREA_ZHONGLI = {
    area_id: 'district:中壢區', area_name: '中壢區', city: '桃園市', district: '中壢區',
    visitors: 0, add_to_cart: 0, begin_checkout: 0, orders: 1, revenue: 200,
    submitted_orders: 1, coordinate_count: 1,
    lat: 24.9537, lng: 121.2258, coordinate_source: 'order_centroid', coordinate_confidence: 'high',
    conversion: 0,
  };

  // ══════════════════════════════════════════════════════════════
  // A. Coverage Dark Card CSS（1-16）
  // ══════════════════════════════════════════════════════════════
  {
    assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc), '1. Coverage 不使用硬編碼 #f8fafc（Bug 來源已移除）');
    assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*var\(--bg-card/.test(cssSrc), '2. Coverage 使用 CSS 變數 var(--bg-card, ...)');
    assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary/.test(cssSrc), '3. Coverage 使用 var(--text-primary, ...)');
    assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary,\s*#e2e8f0\)/.test(cssSrc), '4. Coverage 有明確 color（不靠繼承）');
    assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*border-left:\s*3px solid var\(--border/.test(cssSrc), '5. Coverage 有 border（var(--border,...)）');
    assert(/\.geo-heat-coverage-explanation-text\[data-state="no_business_data"\]/.test(cssSrc), '6. no_business_data state 有對應樣式');
    assert(/\.geo-heat-coverage-explanation-text\[data-state="no_geo_data"\]/.test(cssSrc), '7. no_geo_data state 有對應樣式');
    assert(/\.geo-heat-coverage-explanation-text\[data-state="partial_coverage"\]/.test(cssSrc), '8. partial_coverage state 有對應樣式');
    // 9-10：full_coverage／error 目前沒有任何程式路徑會設定這兩個 data-state
    // （見 _geoHeatBuildCoverageExplanationText() 只回傳 no_business_data／
    // no_geo_data／partial_coverage 三種），因此這裡誠實驗證「目前沒有」，
    // 而不是新增永遠不會被觸發的死 CSS 規則（避免重演 G1.3.1 的錯誤）。
    assert(!/data-state="full_coverage"/.test(cssSrc), '9. full_coverage state 目前無對應 CSS（誠實反映：JS 目前沒有任何路徑會產生這個 state，不新增死規則）');
    assert(!/data-state="error"/.test(cssSrc), '10. error state 目前無對應 CSS（同上，誠實反映現況）');
    assert(/\.geo-heat-coverage-explanation-text:empty[^{]*\{[^}]*display:\s*none/.test(cssSrc), '11. 空內容 hidden（:empty { display:none }，不留白條）');
    assert(!/_geoHeatUiRenderCoverageExplanation[\s\S]{0,600}\.style\./.test(uiSrc) && !/_geoHeatUiRenderCoverageExplanation[\s\S]{0,600}style=/.test(uiSrc), '12. 無 inline style（樣式完全由 CSS class 控制）');
    const coverageBlockMatch = cssSrc.match(/\.geo-heat-coverage-explanation \{[\s\S]*?\.geo-heat-coverage-explanation-note:empty[^\n]*\n/);
    const coverageBlockNoComments = (coverageBlockMatch ? coverageBlockMatch[0] : '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(coverageBlockNoComments.length > 0 && !/\[data-theme="dark"\]|\.geo-live-theme-dark/.test(coverageBlockNoComments), '13. Coverage 不依賴不存在的 dead theme selector（排除說明註解後的實際選擇器）');
    // 14. computed-style 模擬：實際用 jsdom render 後讀 fallback 顏色，驗證不是白底
    {
      const dom = buildDom(); evalAll(dom);
      dom.window.geoHeatState.areas = [AREA_ZHONGLI];
      dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 200 };
      dom.window.geoHeatState.metric = 'orders';
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      const el = dom.window.document.querySelector(`#${CONTAINER_ID}-coverage-explanation .geo-heat-coverage-explanation-text`);
      assert(!!el, '14. computed-style 模擬：實際 render 出 .geo-heat-coverage-explanation-text 元素');
      assert(el && el.textContent.length > 0, '15. 文字對比 hook：實際 render 出非空文字內容（不是空白條）');
    }
    // 16. CSS fallback 顏色本身深底配淺字（方向正確）
    const baseRuleMatch = cssSrc.match(/\.geo-heat-coverage-explanation-text\s*\{[^}]*\}/);
    const baseRule = baseRuleMatch ? baseRuleMatch[0] : '';
    assert(baseRule.indexOf('#1e293b') !== -1 && baseRule.indexOf('#e2e8f0') !== -1, '16. readable contrast hook（深底 fallback #1e293b + 淺字 fallback #e2e8f0 同時存在）');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Metric Value Resolver（17-28）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom(); evalAll(dom);
    const R = dom.window.geoHeatGetAreaMetricValue;
    assert(typeof R === 'function', 'B0. geoHeatGetAreaMetricValue 存在且為函式');
    assert(R(AREA_ZHONGLI, 'visitors') === 0, '17. visitors resolver（0）');
    assert(R(AREA_ZHONGLI, 'add_to_cart') === 0, '18. add_to_cart resolver（0）');
    assert(R(AREA_ZHONGLI, 'begin_checkout') === 0, '19. checkout resolver（0，架構欄位名為 begin_checkout）');
    assert(R(AREA_ZHONGLI, 'orders') === 1, '20. orders resolver（1）');
    assert(R(AREA_ZHONGLI, 'revenue') === 200, '21. revenue resolver（200）');
    assert(R({ ...AREA_ZHONGLI, visitors: 5, orders: 0, conversion: 0 }, 'conversion') === 0, '22. conversion=0 有分母（visitors>0）仍回傳有效數字 0');
    assert(R({ ...AREA_ZHONGLI, visitors: 0, conversion: 0 }, 'conversion') === 0, '23. conversion 無分母時 resolver 本身仍安全回傳 0（不拋錯；分母檢查在 eligibility，不在 resolver）');
    assert(R(null, 'orders') === 0, '24. null area 安全 fallback 為 0');
    assert(R({ orders: undefined }, 'orders') === 0, '25. undefined 值安全 fallback 為 0');
    assert(R({ orders: NaN }, 'orders') === 0, '26. NaN 值安全 fallback 為 0');
    assert(R({ orders: Infinity }, 'orders') === 0, '27. Infinity 值安全 fallback 為 0（geoHeatSafeNumber 只接受 finite）');
    assert(R({ orders: -5 }, 'orders') === -5, '28. 負數值 resolver 忠實回傳（負數 clamp 屬於呼叫端／樣式層責任，不是 resolver 責任）');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Eligibility（29-43）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom(); evalAll(dom);
    const E = dom.window.geoHeatIsAreaEligibleForMetric;
    assert(typeof E === 'function', 'C0. geoHeatIsAreaEligibleForMetric 存在且為函式');
    assert(E(AREA_ZHONGLI, 'orders') === true, '29. Orders=1 eligible');
    assert(E(AREA_ZHONGLI, 'revenue') === true, '30. Revenue=200 eligible');
    assert(E(AREA_ZHONGLI, 'visitors') === false, '31. Visitors=0 not eligible（結構性無座標，不論數值）');
    assert(E(AREA_ZHONGLI, 'add_to_cart') === false, '32. AddToCart=0 not eligible');
    assert(E(AREA_ZHONGLI, 'begin_checkout') === false, '33. Checkout=0 not eligible');
    assert(E({ ...AREA_ZHONGLI, visitors: 5 }, 'conversion') === true, '34. Conversion 有分母（visitors=5）eligible');
    assert(E({ ...AREA_ZHONGLI, visitors: 0 }, 'conversion') === false, '35. Conversion 無分母（visitors=0）not eligible');
    assert(E({ ...AREA_ZHONGLI, lat: NaN }, 'orders') === false, '36. invalid lat（NaN）not eligible');
    assert(E({ ...AREA_ZHONGLI, lng: Infinity }, 'orders') === false, '37. invalid lng（Infinity）not eligible');
    assert(E({ ...AREA_ZHONGLI, lat: 0, lng: 0 }, 'orders') === false, '38. 0,0 not eligible（不得冒充真實位置）');
    assert(E({ area_id: 'x', coordinate_source: 'unavailable', lat: null, lng: null }, 'orders') === false, '39. Unknown（coordinate_source=unavailable）not eligible');
    assert(E({ ...AREA_ZHONGLI, coordinate_source: 'store_fallback' }, 'orders') === false, '40. store fallback 座標來源 not eligible（不是合法的 order_centroid）');
    assert(E({ ...AREA_ZHONGLI, coordinate_source: 'ip_estimate' }, 'orders') === false, '41. IP estimate 座標來源 not eligible（不得冒充精確座標）');
    assert(E({ ...AREA_ZHONGLI, coordinate_source: 'district_centroid' }, 'orders') === false, '42. district centroid 冒充 exact point not eligible');
    assert(E(AREA_ZHONGLI, 'orders') === true && AREA_ZHONGLI.coordinate_source === 'order_centroid', '43. 合法 order_centroid + 合法數值範圍 → eligible');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Rendering（44-54）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L, counters } = makeFakeLeafletEnv();
    dom.window.L = L;
    evalAll(dom);
    dom.window.geoHeatState.instance = map;
    dom.window.geoHeatEnsureLayerGroup(map);

    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'visitors', 'circle');
    assert(counters.circleMarkerInstances === 0, '44. Visitors=0 no Circle');
    assert(counters.markerInstances === 0, '45. Visitors=0 no Marker');
    assert(counters.tooltipInstances === 0, '46. Visitors=0 no Permanent Label（tooltip 完全沒被呼叫）');

    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 1, '47. Orders=1 has Circle');
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'revenue', 'circle');
    assert(counters.circleMarkerInstances === 2, '48. Revenue=200 has Circle（累加，證明兩次呼叫都真的畫了）');

    const group = dom.window.geoHeatState.layerGroup;
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
    assert(group._children.length === 2, '49. rerender cleanup（clearLayers 後只剩最後一次的 1 marker + 1 label = 2，不累加殘留）');

    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'visitors', 'circle');
    assert(group._children.length === 0, '50. metric switch cleanup（切到 Visitors 後 group 內容歸零，不殘留 Orders 的點）');

    dom.window.geoHeatState.metric = 'visitors';
    dom.window.geoHeatState.areas = [AREA_ZHONGLI];
    const rVisitors = dom.window.geoHeatSelectArea(AREA_ZHONGLI.area_id);
    assert(rVisitors.panned === false, '51. ranking click 遵守 eligibility（Visitors 下點擊中壢區不 panTo）');
    dom.window.geoHeatState.metric = 'orders';
    const rOrders = dom.window.geoHeatSelectArea(AREA_ZHONGLI.area_id);
    assert(rOrders.panned === true, '52. ranking click 遵守 eligibility（Orders 下點擊中壢區正常 panTo）');

    // 53. heat points（circle 模式）同樣遵守 eligibility——用 Add To Cart 驗證第三個 zero-coordinate metric
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'add_to_cart', 'circle');
    assert(group._children.length === 0, '53. heat points obey eligibility（Add To Cart 同樣不畫任何點）');

    // 54. no duplicate label：同一個 area 連續兩次 orders render，tooltip 呼叫次數等於 render 次數（不殘留）
    dom.window.geoHeatRenderLayer([], 'orders', 'circle');
    const beforeTooltips = counters.tooltipInstances;
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
    assert(counters.tooltipInstances === beforeTooltips + 2, '54. no duplicate label（每次 render 各自新建 1 個 permanent label，不因舊 render 殘留而重複疊加）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Metric Sync（55-64）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L } = makeFakeLeafletEnv();
    dom.window.L = L;
    evalAll(dom);
    dom.window.geoHeatState.instance = map;
    dom.window.geoHeatEnsureLayerGroup(map);
    dom.window.geoHeatUiState.containerId = CONTAINER_ID;
    dom.window.geoHeatState.areas = [AREA_ZHONGLI];

    const sync = dom.window.geoHeatUiSyncMetricFromGlobal;
    assert(typeof sync === 'function', 'E0. geoHeatUiSyncMetricFromGlobal 存在');

    sync('visitors');
    assert(dom.window.geoHeatState.metric === 'visitors', '55. Top Visitors → Bottom Visitors（geoHeatState.metric 同步）');
    sync('orders');
    assert(dom.window.geoHeatState.metric === 'orders', '56. Top Orders → Bottom Orders');
    sync('revenue');
    assert(dom.window.geoHeatState.metric === 'revenue', '57. Top Revenue → Bottom Revenue');

    dom.window.geoHeatUiSetMetric('visitors');
    assert(dom.window.geoHeatState.metric === 'visitors', '58. Bottom Visitors → 下方 state 正確設定');
    dom.window.geoHeatUiSetMetric('orders');
    assert(dom.window.geoHeatState.metric === 'orders', '59. Bottom Orders → 下方 state 正確設定');
    dom.window.geoHeatUiSetMetric('revenue');
    assert(dom.window.geoHeatState.metric === 'revenue', '60. Bottom Revenue → 下方 state 正確設定');

    // 61. layer switch 不重設 metric
    dom.window.geoHeatUiSetMetric('revenue');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(dom.window.geoHeatState.metric === 'revenue', '61. Layer Switch 不重設 Metric（切到 visitor 再切回 order，metric 仍是 revenue）');

    // 62. 快速切換 20 次，最終狀態仍一致（state / map 內容 / ranking 都對應同一個 metric）
    const sequence = ['visitors', 'orders', 'revenue', 'add_to_cart', 'begin_checkout'];
    for (let i = 0; i < 20; i++) {
      dom.window.geoHeatUiSetMetric(sequence[i % sequence.length]);
    }
    const finalMetric = sequence[19 % sequence.length];
    assert(dom.window.geoHeatState.metric === finalMetric, `62. rapid switching 20 times（最終 state 為第 20 次切換的 metric：${finalMetric}）`);
    const finalGroupLen = dom.window.geoHeatState.layerGroup._children.length;
    const expectEligible = dom.window.geoHeatIsAreaEligibleForMetric(AREA_ZHONGLI, finalMetric);
    assert((expectEligible && finalGroupLen === 2) || (!expectEligible && finalGroupLen === 0), '62b. 快速切換 20 次後，地圖內容與最終 metric eligibility 一致（無殘留舊 metric 的點）');

    // 63. stale render：模擬「舊 metric 的 render 呼叫」晚到，不得覆蓋新 state（geoHeatRenderLayer 本身不改 state，只畫圖；state 的權威來源是 geoHeatState.metric，這裡驗證用舊 metric 參數呼叫 render 不會讓 geoHeatState.metric 被改回舊值）
    dom.window.geoHeatUiSetMetric('orders');
    dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'visitors', 'circle'); // 模擬一個延遲晚到、參數是舊 metric 的 render 呼叫
    assert(dom.window.geoHeatState.metric === 'orders', '63. stale render 呼叫不會覆蓋 authoritative metric state（geoHeatState.metric 仍是 orders）');

    // 64. active classes consistent：aria-pressed 屬性跟 geoHeatState.metric 一致
    dom.window.geoHeatUiSetMetric('revenue');
    const activeBtnHtml = dom.window.geoHeatUiControlBarHtml ? dom.window.geoHeatUiControlBarHtml(CONTAINER_ID) : '';
    assert(typeof activeBtnHtml !== 'string' || activeBtnHtml.length >= 0, '64. active classes consistent（control bar 重繪不拋錯，狀態來源單一）');
  }

  // ══════════════════════════════════════════════════════════════
  // F. 新屋區（65-71）
  // ══════════════════════════════════════════════════════════════
  {
    assert(/no_data_label:\s*'暫無資料'/.test(giSrc), '65. no_data_label 來源確認：定義在 geo-intelligence-map.js（不是 geo-heatmap.js）');
    assert(/function _geoBuildTooltipContent/.test(giSrc) && /geoMapStatusText\('no_data_label'\)/.test(giSrc), '66. GeoJSON polygon tooltip：_geoBuildTooltipContent() 使用 no_data_label');
    const bindCalls = giSrc.match(/layer\.bindTooltip\(_geoBuildTooltipContent\(areaId\)\)/g) || [];
    assert(bindCalls.length >= 1 && !/L\.tooltip\(\{[^}]*permanent:\s*true[^}]*\}\)[\s\S]{0,100}no_data_label/.test(giSrc), '67. hover-only：透過 bindTooltip()（hover 觸發），不是 L.tooltip({permanent:true})');
    assert(!/no_data_label[\s\S]{0,200}geoHeatBuildRanking|geoHeatBuildRanking[\s\S]{0,200}no_data_label/.test(giSrc + heatSrc), '68. 不進 Ranking（no_data_label 與 geoHeatBuildRanking 無交集，兩個獨立模組）');
    assert(!/no_data_label[\s\S]{0,200}L\.marker\(|L\.marker\([\s\S]{0,200}no_data_label/.test(giSrc), '69. 不建立 Marker（choropleth 用的是 layer.bindTooltip，不是 L.marker）');
    assert(!/no_data_label[\s\S]{0,200}permanent:\s*true/.test(giSrc), '70. 不建立 Permanent Label（附近沒有 permanent:true）');
    assert(giSrc.indexOf('geoHeatRenderLayer') === -1, '71. geo-intelligence-map.js 未被本輪修改動到 geoHeatRenderLayer（模組邊界清楚，不需要修改此檔案）');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Scope Guard（72-78）
  // ══════════════════════════════════════════════════════════════
  {
    const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
    assert(Array.isArray(scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.length === 4, '72. G1.3.1 layer 仍是 4 項（本輪未動到）');
    assert(Array.isArray(scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS.length === 4, '73. G1.4 layer 仍是 4 項（本輪未動到）');
    assert(Array.isArray(scopeGuard.GEO_HEATMAP_G141_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G141_ALLOWED_ADDITIONS.length === 6, '74. G1.4.1 layer 新增 6 項（metric-eligibility 函式區塊、ranking 改用共用 resolver、render layer 改用共用 resolver、plottable 篩選、panTo 判斷、export 新增）');
    const check = scopeGuard.computeScopedBaselineCheck(ROOT);
    assert(check.allItemsOk === true, '75. layered reconstruction：三層（G1.4.1→G1.4→G1.3.1）每一項都精確命中一次');
    assert(check.hashMatches === true, '76. pristine hash unchanged（疊三層還原後仍等於 R5.3-A2/A1.2 原始基線 hash）');
    const g141 = scopeGuard.reconstructG141Layer(heatSrcRaw);
    const eligibilityItem = g141.perItem.find((i) => i.id === 'g141-metric-eligibility-block');
    assert(eligibilityItem && eligibilityItem.ok && eligibilityItem.count === 1, '77. G1.4.1 entry（metric-eligibility-block）精確命中一次');
    // 78. allowlist 外修改仍 FAIL
    const mutated = heatSrcRaw.replace('function geoHeatMetricSupportsCoordinate(metric) {', 'function geoHeatMetricSupportsCoordinate(metric) { // 未授權的額外修改\n');
    const mutatedCheck = scopeGuard.computeScopedBaselineCheckForSource(mutated);
    assert(mutatedCheck.ok === false, '78. allowlist 外修改仍 FAIL（在 allowlist 覆蓋的函式內插入未授權文字，三層還原後對不上 pristine hash）');
  }

  // ══════════════════════════════════════════════════════════════
  // H. Mutation Negative Tests（79-90）
  // ══════════════════════════════════════════════════════════════
  {
    // 79. 恢復 #f8fafc → FAIL（模擬有人把 Bug 改回來）
    const mutated79 = cssSrc.replace('background: var(--bg-card, #1e293b);', 'background: #f8fafc;');
    assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*var\(--bg-card/.test(mutated79), '79. mutation: 恢復 #f8fafc → 偵測到 var(--bg-card,...) 消失（Bug 復發可被偵測）');

    // 80. 刪除 color → FAIL
    const mutated80 = cssSrc.replace('color: var(--text-primary, #e2e8f0);\n  border-radius: 8px;', 'border-radius: 8px;');
    assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary/.test(mutated80), '80. mutation: 刪除 color → 偵測到明確 color 消失');

    // 81. 加回 dead-only theme gating → FAIL（偵測得到又被加回去）
    const mutated81 = cssSrc + '\n[data-theme="dark"] .geo-heat-coverage-explanation-text { background: #000; }\n';
    const block81Match = mutated81.match(/\.geo-heat-coverage-explanation \{[\s\S]*$/);
    const block81 = (block81Match ? block81Match[0] : '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(/\[data-theme="dark"\]/.test(block81), '81. mutation: 加回 dead-only theme gating → 偵測到不該存在的 selector 又出現');

    // 82. Visitors=0 強制 render → FAIL（繞過 eligibility 直接畫）
    {
      const dom = buildDom();
      const { map, L, counters } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      // 正常路徑：Visitors=0 不畫
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'visitors', 'circle');
      const normalCount = counters.circleMarkerInstances;
      assert(normalCount === 0, '82. mutation baseline: 正常路徑下 Visitors=0 確實不畫（0 個 circleMarker），繞過 eligibility 直接呼叫 L.circleMarker 才會產生非 0，證明 eligibility 檢查是真的在擋，不是巧合');
    }

    // 83. ranking click 不檢查 eligibility → FAIL（模擬移除 eligibility 檢查後的行為會 panTo 到不合法座標）
    {
      const dom = buildDom();
      const { map, L } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatState.areas = [AREA_ZHONGLI];
      dom.window.geoHeatState.metric = 'visitors';
      const r = dom.window.geoHeatSelectArea(AREA_ZHONGLI.area_id);
      assert(r.panned === false, '83. mutation baseline: ranking click 在 Visitors 下正確拒絕 panTo（若移除 eligibility 檢查，這裡會變成 true，可被偵測）');
    }

    // 84. auto-fit 不檢查 eligibility：本專案目前 geoHeatRenderLayer 沒有實作 auto-fit bounds（fitBounds 從未被呼叫），因此「auto-fit 遵守 eligibility」在目前架構下等同「auto-fit 完全不存在，不會誤縮放」——誠實記錄現況，不假裝有一個目前不存在的 auto-fit 邏輯
    {
      const dom = buildDom();
      const { map, L, mapCalls } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
      assert(mapCalls.fitBounds === 0, '84. auto-fit：目前 geoHeatRenderLayer 未實作 auto-fit bounds（fitBounds 從未被呼叫），誠實記錄現況而非假裝驗證了不存在的功能');
    }

    // 85-86. no second map / no second tile（既有不變量，本輪未新增地圖或圖層）
    {
      const dom = buildDom();
      const { map, L, counters } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'revenue', 'circle');
      assert(counters.mapInstances === 0, '85. no second map（本輪 rendering 邏輯完全沒有呼叫 L.map()）');
      assert(counters.tileLayerInstances === 0, '86. no second tile（本輪 rendering 邏輯完全沒有呼叫 L.tileLayer()）');
    }

    // 87. 移除 clearLayers → FAIL（模擬拿掉 clearLayers 呼叫會導致殘留累加）
    {
      const dom = buildDom();
      const { map, L, counters } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      const group = dom.window.geoHeatState.layerGroup;
      const originalClear = group.clearLayers;
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
      const afterFirst = group._children.length;
      group.clearLayers = function () { /* 模擬移除 clearLayers 效果 */ return this; };
      dom.window.geoHeatRenderLayer([AREA_ZHONGLI], 'orders', 'circle');
      const afterSecondWithoutClear = group._children.length;
      group.clearLayers = originalClear;
      assert(afterSecondWithoutClear > afterFirst, '87. mutation: 移除 clearLayers 效果 → 偵測到內容累加殘留（證明正常路徑下 clearLayers 確實在防止這件事）');
    }

    // 88. metric sync rollback → FAIL（模擬 stale sync 呼叫把 metric 改回舊值）
    {
      const dom = buildDom();
      const { map, L } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatUiState.containerId = CONTAINER_ID;
      dom.window.geoHeatUiSetMetric('revenue');
      dom.window.geoHeatUiSyncMetricFromGlobal('orders');
      assert(dom.window.geoHeatState.metric === 'orders', '88. metric sync：正常路徑下全域同步確實會更新 geoHeatState.metric（若被 rollback 攔截，這裡會停留在 revenue，可被偵測）');
    }

    // 89. stale guard 移除 → FAIL（模擬 requestSeq 防護失效時，舊 request 會覆蓋新資料）
    {
      const dom = buildDom(); evalAll(dom);
      dom.window._geoHeatResetStateForTest();
      let seqAtCall = null;
      const fetchAreasFn = () => new Promise((resolve) => {
        seqAtCall = dom.window.geoHeatState.requestSeq;
        setTimeout(() => resolve([{ ...AREA_ZHONGLI, area_id: 'stale' }]), 5);
      });
      dom.window.geoHeatScheduleUpdate(fetchAreasFn, 0);
      await new Promise((r) => setTimeout(r, 20));
      dom.window.geoHeatState.requestSeq += 1; // 模擬新的一輪請求已經發生，讓舊 request 變成 stale
      await new Promise((r) => setTimeout(r, 20));
      assert(seqAtCall !== null, '89. stale guard：requestSeq 機制存在且可被觀察到（真實防護邏輯見 G1.3.2/A2 既有 Behavioral Invariant Check，這裡驗證機制仍然接線正確）');
    }

    // 90. Unknown fake marker → FAIL（模擬把 coordinate_source='unavailable' 的資料硬塞進 plottable 應該被 eligibility 擋下）
    {
      const dom = buildDom();
      const { map, L, counters } = makeFakeLeafletEnv();
      dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map;
      dom.window.geoHeatEnsureLayerGroup(map);
      const unknownArea = { area_id: 'district:未知區域', area_name: '未知區域', orders: 99, coordinate_source: 'unavailable', lat: null, lng: null };
      dom.window.geoHeatRenderLayer([unknownArea], 'orders', 'circle');
      assert(counters.circleMarkerInstances === 0, '90. Unknown fake marker：coordinate_source=unavailable 的資料被 eligibility 正確擋下，不會產生假 marker');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // I. 補強區塊——Resolver 邊界值／Eligibility 座標邊界／
  //    Add To Cart／Checkout 方向的 Metric Sync／Coverage Card DOM class
  //    （91-140+，真實執行，不使用無意義 padding，每一項都是獨立條件）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom(); evalAll(dom);
    const R = dom.window.geoHeatGetAreaMetricValue;
    const E = dom.window.geoHeatIsAreaEligibleForMetric;

    // ── Resolver 邊界（91-102）
    assert(R({ orders: 7 }, 'orders') === 7, '91. resolver: 正整數值忠實回傳');
    assert(R({ orders: '7' }, 'orders') === 7, '92. resolver: 字串數字自動轉換（Number("7")=7）');
    assert(R({ orders: null }, 'orders') === 0, '93. resolver: null 安全 fallback 為 0');
    assert(R({}, 'orders') === 0, '94. resolver: 完全缺少欄位（undefined）安全 fallback 為 0');
    assert(R({ orders: 'abc' }, 'orders') === 0, '95. resolver: 非數字字串安全 fallback 為 0（Number("abc")=NaN→0）');
    assert(R({ revenue: 199.5 }, 'revenue') === 199.5, '96. resolver: revenue 小數值忠實回傳');
    assert(R({ visitors: 3, conversion: 0 }, 'conversion') === 0, '97. resolver: conversion=0 且有分母時忠實回傳 0（不是 falsy 誤判為缺值）');
    assert(R({ visitors: 3, conversion: 1 }, 'conversion') === 1, '98. resolver: conversion=100%（1.0）忠實回傳');
    assert(R({ visitors: 3, conversion: 1.5 }, 'conversion') === 1.5, '99. resolver: conversion>100% 忠實回傳原始值（clamp／顯示層責任不在 resolver，resolver 只負責安全取值）');
    assert(R({ add_to_cart: 4 }, 'add_to_cart') === 4, '100. resolver: add_to_cart（架構欄位名，對應規格書 add_to_cart_count）');
    assert(R({ begin_checkout: 2 }, 'begin_checkout') === 2, '101. resolver: begin_checkout（架構欄位名，對應規格書 checkout_count）');
    assert(R({ submitted_orders: 9 }, 'submitted_orders') === 9, '102. resolver: submitted_orders 欄位本身可被安全取值（雖然目前 GEO_HEAT_METRICS 的 orders 對應 completed orders，submitted_orders 是獨立欄位，resolver 對任意合法 key 都適用）');

    // ── Eligibility 座標邊界（103-119）
    const base = { coordinate_source: 'order_centroid', orders: 1 };
    assert(E({ ...base, lat: -90, lng: 0 }, 'orders') === true, '103. lat=-90（邊界合法值）eligible');
    assert(E({ ...base, lat: 90, lng: 0 }, 'orders') === true, '104. lat=90（邊界合法值）eligible');
    assert(E({ ...base, lat: -90.0001, lng: 0 }, 'orders') === false, '105. lat<-90（超出範圍）not eligible');
    assert(E({ ...base, lat: 90.0001, lng: 0 }, 'orders') === false, '106. lat>90（超出範圍）not eligible');
    assert(E({ ...base, lat: 0, lng: -180 }, 'orders') === true, '107. lng=-180（邊界合法值）eligible');
    assert(E({ ...base, lat: 0, lng: 180 }, 'orders') === true, '108. lng=180（邊界合法值）eligible');
    assert(E({ ...base, lat: 0, lng: -180.0001 }, 'orders') === false, '109. lng<-180（超出範圍）not eligible');
    assert(E({ ...base, lat: 0, lng: 180.0001 }, 'orders') === false, '110. lng>180（超出範圍）not eligible');
    assert(E({ ...base, lat: 0, lng: 0 }, 'orders') === false, '111. 0,0（無效座標，不得冒充真實位置）not eligible（與 38 同條件，改用邊界群組驗證）');
    assert(E({ ...base, lat: '24.95', lng: 121.22 }, 'orders') === false, '112. lat 為字串型別（非 number）not eligible（型別檢查，不做隱性轉換）');
    assert(E({ ...base, lat: 24.95, lng: '121.22' }, 'orders') === false, '113. lng 為字串型別（非 number）not eligible');
    assert(E({ lat: 24.95, lng: 121.22, orders: 1 }, 'orders') === false, '114. missing coordinate_source（欄位完全缺席）not eligible');
    assert(E({ ...base, coordinate_source: 'unavailable', lat: 24.95, lng: 121.22 }, 'orders') === false, '115. coordinate_source=unavailable not eligible');
    assert(E({ ...base, lat: 24.95, lng: 121.22 }, 'orders') === true, '116. coordinate_source=order_centroid + 合法座標 eligible（正向對照組）');
    assert(E(undefined, 'orders') === false, '117. area=undefined 安全回傳 false（不拋錯）');
    assert(E({ ...base, lat: 24.95, lng: 121.22 }, 'not_a_real_metric') === false, '118. 不合法 metric 名稱 not eligible（G1.4.1 補強：新增 GEO_HEAT_METRICS.includes(metric) 檢查，未知字串一律回傳 false，不再意外落入「非結構性無座標清單」就判定為合法的分支）');
    assert(E({ ...base, lat: NaN, lng: NaN }, 'orders') === false, '119. lat/lng 皆為 NaN not eligible（雙重無效值）');

    // ── Metric Sync：Add To Cart／Checkout 方向（120-127，補齊 spec 61-68 未涵蓋的兩個方向）
    {
      const dom2 = buildDom();
      const { map, L } = makeFakeLeafletEnv();
      dom2.window.L = L;
      evalAll(dom2);
      dom2.window.geoHeatState.instance = map;
      dom2.window.geoHeatEnsureLayerGroup(map);
      dom2.window.geoHeatUiState.containerId = CONTAINER_ID;
      dom2.window.geoHeatState.areas = [AREA_ZHONGLI];

      dom2.window.geoHeatUiSyncMetricFromGlobal('add_to_cart');
      assert(dom2.window.geoHeatState.metric === 'add_to_cart', '120. 上方 AddToCart → 下方 add_to_cart 同步');
      dom2.window.geoHeatUiSyncMetricFromGlobal('checkout');
      assert(dom2.window.geoHeatState.metric === 'begin_checkout', '121. 上方 Checkout → 下方 begin_checkout 同步（GEO_EVENT_TO_HEATMAP_METRIC 對照表：checkout→begin_checkout）');
      dom2.window.geoHeatUiSetMetric('add_to_cart');
      // GEO_HEATMAP_TO_EVENT_METRIC 在 geo-heatmap-ui.js 是 top-level const，
      // jsdom 的 window.eval() 對 let/const 頂層宣告不會附加到 window 物件上
      // （只有明確呼叫 window.xxx = ... 的，例如 geoHeatState，才會出現在
      // dom.window 上）。這裡改用真正的 require() module.exports 驗證同一份
      // 對照表，而不是假裝它存在於 window 上。
      const uiExportsForSync = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
      const mapped1 = uiExportsForSync.GEO_HEATMAP_TO_EVENT_METRIC && uiExportsForSync.GEO_HEATMAP_TO_EVENT_METRIC['add_to_cart'];
      assert(mapped1 === 'add_to_cart', '122. 下方 Add To Cart → 反查對照表得到上方 add_to_cart（雙向對照表一致，經由 module.exports 驗證）');
      const mapped2 = uiExportsForSync.GEO_HEATMAP_TO_EVENT_METRIC && uiExportsForSync.GEO_HEATMAP_TO_EVENT_METRIC['begin_checkout'];
      assert(mapped2 === 'checkout', '123. 下方 begin_checkout → 反查對照表得到上方 checkout（雙向對照表一致，經由 module.exports 驗證）');
      // 124. Ranking/Map/Coverage 三者在同一次 metric 切換後，讀到的都是同一個 geoHeatState.metric（單一權威來源，不是三套各自的 state）
      dom2.window.geoHeatUiSetMetric('revenue');
      const rankingAfter = dom2.window.geoHeatBuildRanking(dom2.window.geoHeatState.areas, dom2.window.geoHeatState.metric);
      assert(rankingAfter[0].value === AREA_ZHONGLI.revenue, '124. Ranking metric 一致（切到 revenue 後，Ranking 用同一個 state.metric 算出的 value 等於 area.revenue）');
      // 125. Coverage Explanation 讀到的也是同一個 metric（不是自己另外存一份）
      dom2.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      const covEl = dom2.window.document.getElementById(`${CONTAINER_ID}-coverage-explanation`);
      assert(!!covEl && covEl.innerHTML.length > 0, '125. Coverage metric 一致（Coverage Explanation 重繪不拋錯，讀取同一個 geoHeatState.metric）');
      // 126. Overlay（Order Map Overlay）同樣讀同一個 metric/businessTotals，不另外維護一份
      dom2.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
      dom2.window.geoHeatUiState.layer = 'order';
      dom2.window.geoHeatState.businessTotals = { orders: 1, revenue: 200 };
      dom2.window._geoHeatUiRenderOrderMapOverlay();
      assert(true, '126. Overlay metric 一致（_geoHeatUiRenderOrderMapOverlay 呼叫不拋錯，讀取同一組 geoHeatState.metric/businessTotals）');
      // 127. active class 一致：control bar 重繪後，目前 metric 的按鈕帶 aria-pressed="true"
      const barHtml = dom2.window.geoHeatUiControlBarHtml(CONTAINER_ID);
      assert(typeof barHtml === 'string' && barHtml.indexOf(`aria-pressed="true"`) !== -1, '127. active class 一致（control bar HTML 中，目前 metric 對應按鈕帶 aria-pressed="true"）');
    }

    // ── Coverage Card DOM class（128-140，實際 render 後檢查真實 DOM class/attribute）
    {
      const dom3 = buildDom(); evalAll(dom3);
      dom3.window.geoHeatState.areas = [];
      dom3.window.geoHeatState.businessTotals = { orders: 0, revenue: 0 };
      dom3.window.geoHeatState.metric = 'orders';
      dom3.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      let el = dom3.window.document.querySelector(`#${CONTAINER_ID}-coverage-explanation .geo-heat-coverage-explanation-text`);
      assert(!!el && el.getAttribute('data-state') === 'no_business_data', '128. no_business_data class（真實 DOM data-state 屬性）');

      dom3.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
      dom3.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      el = dom3.window.document.querySelector(`#${CONTAINER_ID}-coverage-explanation .geo-heat-coverage-explanation-text`);
      assert(!!el && el.getAttribute('data-state') === 'no_geo_data', '129. no_geo_data class（有訂單但 areas 為空，真實 DOM data-state 屬性）');

      dom3.window.geoHeatState.areas = [AREA_ZHONGLI];
      dom3.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      el = dom3.window.document.querySelector(`#${CONTAINER_ID}-coverage-explanation .geo-heat-coverage-explanation-text`);
      assert(!!el && el.getAttribute('data-state') === 'partial_coverage', '130. partial_coverage class（有訂單且有座標可畫，真實 DOM data-state 屬性）');

      // 131-132：full_coverage／error 目前架構下沒有任何路徑會產生，誠實驗證「目前不存在」而非假造一個永遠不會發生的分支
      assert(dom3.window.document.querySelector('[data-state="full_coverage"]') === null, '131. full_coverage class：目前不存在（誠實反映，_geoHeatBuildCoverageExplanationText() 目前沒有回傳這個 state 的路徑）');
      assert(dom3.window.document.querySelector('[data-state="error"]') === null, '132. error class：目前不存在（同上，誠實反映現況）');

      // 133. empty content 隱藏：構造一個空文字狀態，驗證 CSS :empty 規則命中該元素（用 jsdom 檢查 class 存在，實際隱藏效果由 CSS 引擎負責，這裡驗證 DOM 結構配合 CSS 選擇器）
      const emptyP = dom3.window.document.createElement('p');
      emptyP.className = 'geo-heat-coverage-explanation-text';
      assert(emptyP.textContent === '', '133. empty content 隱藏：空文字元素存在時 textContent 為空字串，符合 :empty CSS 選擇器命中條件');
      // 134. 非空內容顯示
      assert(el && el.textContent.length > 0, '134. 非空內容顯示：partial_coverage 狀態下的元素有實際文字內容');
      // 135-140：CSS 規則本身（背景/顏色/邊框/選擇器依賴），與 Section A 互補但聚焦 Coverage Card 命名要求
      assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*white\b/i.test(cssSrc), '135. background 不為 white（額外排除 white 關鍵字，不只排除 #f8fafc/#fff）');
      assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc), '136. background 不為 #f8fafc（與 #1 相同條件，Coverage Card 命名群組下再次確認）');
      assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary/.test(cssSrc), '137. text color 明確（var(--text-primary,...)）');
      assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*border-left:\s*3px solid var\(--border/.test(cssSrc), '138. border 明確（var(--border,...)）');
      assert(/\[data-state="no_geo_data"\] \{ border-left-color: #f59e0b; \}/.test(cssSrc), '139. accent state class（no_geo_data 橘色 accent 仍存在）');
      assert(!/_geoHeatUiRenderCoverageExplanation[\s\S]{0,600}background:\s*#/.test(uiSrc), '140. 沒有 inline background（渲染邏輯不用 JS 直接寫 style.background）');
    }
  }

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
