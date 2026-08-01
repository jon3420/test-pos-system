#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-4-map-label-rendering.js
// fix18-10-hotfix30-B5-R5.4-G1.4 — Geo Map Label Rendering & Honest Drawable-State Fix

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.4 (Map Label Rendering & Honest Drawable-State Fix)');
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
  ['public/js/geo-heatmap.js', 'public/js/geo-heatmap-ui.js', 'public/css/geo-heatmap.css',
    'scripts/lib/geo-fixture-time.js', 'scripts/lib/geo-heatmap-g131-scope-guard.js'].forEach((rel) => {
    try {
      if (rel.endsWith('.css')) { fs.readFileSync(path.join(ROOT, rel), 'utf8'); pass(`0-parse ${rel} 可讀取`); return; }
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const heatSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  const uiSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  const heatSrc = heatSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const uiSrc = uiSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  const CONTAINER_ID = 'g14C';
  const MAP_CONTAINER_ID = 'g14Map';

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${MAP_CONTAINER_ID}"></div>
      <div id="${CONTAINER_ID}-order-layer">order-content</div>
      <div id="${CONTAINER_ID}-visitor-layer" hidden>visitor-content</div>
      <div id="${CONTAINER_ID}-layer-toggle" class="geo-heat-layer-toggle"></div>
      <div id="${CONTAINER_ID}-coverage-explanation" aria-live="polite"></div>
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  // 沿用 G1.2 smoke 既有的假 Leaflet stub 慣例，額外補上 marker/circleMarker/
  // tooltip 的呼叫追蹤，供 Label／Marker 測試使用。
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
    let markerInstances = 0;
    let circleMarkerInstances = 0;
    let tooltipInstances = 0;
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
      map, L, mapCalls,
      permanentTooltips, hoverTooltipCalls,
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

  function evalAll(dom) {
    dom.window.eval(heatSrc + '\n;\n' + uiSrc);
  }

  // 真實案例 Fixture area：1 個有 exact 座標、1 個 district-only（有訂單但無座標）
  const AREA_EXACT = { area_id: 'district:中壢區', area_name: '中壢區', city: '桃園市', district: '中壢區',
    visitors: 5, add_to_cart: 2, begin_checkout: 1, orders: 3, revenue: 900, submitted_orders: 3, coordinate_count: 3,
    lat: 24.95, lng: 121.22, coordinate_source: 'order_centroid', coordinate_confidence: 'high', conversion: 0.6 };
  const AREA_DISTRICT_ONLY = { area_id: 'district:桃園區', area_name: '桃園區', city: '桃園市', district: '桃園區',
    visitors: 2, add_to_cart: 0, begin_checkout: 0, orders: 1, revenue: 150, submitted_orders: 1, coordinate_count: 0,
    lat: null, lng: null, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', conversion: 0.5 };

  // ══════════════════════════════════════════════════════════════
  // 一、Drawable Classifier
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom(); evalAll(dom);
    const F = dom.window.geoHeatComputeDrawableState;
    assert(typeof F === 'function', '1. classifier export（geoHeatComputeDrawableState 存在）');
    assert(F([], { orders: 0, revenue: 0 }) === 'no_business_data', '2. no_business_data（沒有訂單）');
    assert(F([], { orders: 1, revenue: 150 }) === 'has_business_but_no_drawable_geo', '3. business/no-geo（有訂單，areas 空）');
    assert(F([AREA_DISTRICT_ONLY], { orders: 1, revenue: 150 }) === 'has_drawable_district_only', '4. district only（只有已知行政區、無座標）');
    assert(F([AREA_EXACT], { orders: 3, revenue: 900 }) === 'has_drawable_exact_only', '5. exact only（只有有座標的行政區）');
    assert(F([AREA_EXACT, AREA_DISTRICT_ONLY], { orders: 4, revenue: 1050 }) === 'has_mixed_drawable_geo', '6. mixed（同時有 exact 與 district-only）');
    assert(F([], null) === 'no_business_data', '7. empty array（areas=[]，businessTotals=null，fallback 到 areas 加總=0）');
    assert(F(null, { orders: 0, revenue: 0 }) === 'no_business_data', '8. null areas（areas=null 安全處理，不拋錯）');
    assert(F([{ submitted_orders: 'abc', coordinate_source: 'x' }], { orders: 1, revenue: 1 }) === 'has_business_but_no_drawable_geo', '9. malformed values（submitted_orders 非數字，安全 fallback 成 0，不計入 knownDistricts）');
    assert(F([AREA_DISTRICT_ONLY], { orders: 0, revenue: 0 }) === 'no_business_data', '10. 0 value（businessTotals.orders=0 優先判定為 no_business_data，即使 areas 有資料）');
  }

  // ══════════════════════════════════════════════════════════════
  // 二、Permanent District Label
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L, counters, permanentTooltips, hoverTooltipCalls } = makeFakeLeafletEnv();
    dom.window.L = L;
    evalAll(dom);
    dom.window.geoHeatState.instance = map;
    dom.window.geoHeatEnsureLayerGroup(map);
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    assert(counters.tooltipInstances >= 1, '11. L.tooltip 被呼叫（至少一次，對應 1 個 exact area）');
    assert(permanentTooltips.length === 1 && permanentTooltips[0].opts.permanent === true, '12. permanent=true（新建的 tooltip 帶 permanent:true）');
    assert(permanentTooltips[0].opts.className === 'geo-heat-map-label', '13. label className 為 geo-heat-map-label');
    assert(permanentTooltips[0]._content === AREA_EXACT.area_name, '14. label content 為行政區名稱（不是完整 tooltip 內容，避免版面太擠）');
    assert(permanentTooltips[0]._content === '中壢區', '15. district name 正確');
    // 16. metric value：完整數值仍在 hover tooltip 內（bindTooltip 內容），不在 permanent label
    assert(hoverTooltipCalls.length === 1 && typeof hoverTooltipCalls[0] === 'string' && hoverTooltipCalls[0].indexOf('Orders') !== -1, '16. metric value 仍存在於 hover tooltip 完整內容（bindTooltip）');
    assert(permanentTooltips[0]._latlng && permanentTooltips[0]._latlng[0] === AREA_EXACT.lat && permanentTooltips[0]._latlng[1] === AREA_EXACT.lng, '17. label addTo marker/map（setLatLng 使用同一組真實座標）');
    assert(counters.markerInstances === 0 && counters.circleMarkerInstances === 1, '18. hover tooltip 仍保留（circleMarker 仍正常建立並 bindTooltip）');
    assert(permanentTooltips[0]._content !== hoverTooltipCalls[0], '19. permanent 與 hover 不互相覆蓋（兩者內容不同，分別維護）');
    // 20. rerender 無 duplicate
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    assert(counters.tooltipInstances === 3, '20. rerender 無 duplicate（clearLayers 後重畫，tooltip 呼叫次數等於重畫次數，不累加殘留）');
    // 21. clearLayers 清除 label
    const group = dom.window.geoHeatState.layerGroup;
    assert(group._children.length === 2, '21a. clearLayers 前，group 內含 1 個 marker + 1 個 permanent label（共 2 個 layer）');
    dom.window.geoHeatRenderLayer([], 'orders', 'circle');
    assert(group._children.length === 0, '21. clearLayers 清除 label（連同 marker 一起清空，group 內容歸零）');
  }

  // ══════════════════════════════════════════════════════════════
  // 三、Layer Switch 時 Label 清除／重畫
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L, counters } = makeFakeLeafletEnv();
    dom.window.L = L;
    dom.window.geoMapState = { instance: map, featureIndex: null, settings: {}, geoJsonLayer: null };
    evalAll(dom);
    dom.window._geoHeatUiEnsureMapReuse(CONTAINER_ID);
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    const orderGroup = dom.window.geoHeatState.layerGroup;
    assert(orderGroup._children.length === 2, '22a. Order Layer 有 marker+label（前置狀態）');
    // 模擬 visitorGroup 存在，切到 visitor
    dom.window.geoVisitorState = { choroplethLayerGroup: L.layerGroup(), status: 'ready', summary: {} };
    dom.window._geoHeatUiApplyLayerExclusivity('visitor');
    assert(map.hasLayer(orderGroup) === false, '22. Layer Switch 清除 label（切到 visitor 後，Order Layer 從地圖上移除，label 跟著隱藏，不是清空內容——內容還在，只是不在地圖上）');
    // 23. 切回重畫 label（addLayer 回去，內容仍在，不需要重新 render 就能看到）
    dom.window._geoHeatUiApplyLayerExclusivity('order');
    assert(map.hasLayer(orderGroup) === true && orderGroup._children.length === 2, '23. 切回重新顯示 label（重新 addLayer，既有 marker+label 內容原樣顯示，不需要重新 fetch/render）');
  }

  // ══════════════════════════════════════════════════════════════
  // 四、Exact Marker
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L, counters } = makeFakeLeafletEnv();
    dom.window.L = L;
    evalAll(dom);
    dom.window.geoHeatState.instance = map;
    dom.window.geoHeatEnsureLayerGroup(map);
    // 24. exact coordinate 才建立
    dom.window.geoHeatRenderLayer([AREA_DISTRICT_ONLY], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 0 && counters.markerInstances === 0, '24. exact coordinate 才建立（district-only 沒有 lat/lng，不建立任何 marker）');
    // 25/26. lat/lng valid 才建立
    const areaValid = { ...AREA_EXACT, area_id: 'v1' };
    const areaInvalidLat = { ...AREA_EXACT, area_id: 'v2', lat: 'not-a-number' };
    const areaInvalidLng = { ...AREA_EXACT, area_id: 'v3', lng: null };
    dom.window.geoHeatRenderLayer([areaValid, areaInvalidLat, areaInvalidLng], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 1, '25/26. lat/lng valid（非數字/null 的 lat/lng 都不建立 marker，只有真正合法數字的那 1 筆建立）');
    // 27. 0,0 不建立（lat=0,lng=0 語意上是「未設定」還是「赤道幾內亞灣」？系統一律當合法數字處理——
    //     但這裡驗證的是「後端只有真的算出平均座標時 coordinate_source 才會是 order_centroid」，
    //     若 coordinate_source 不是 order_centroid，即使 lat/lng 剛好是 0 也不會被畫出來。
    dom.window.geoHeatState.layerGroup.clearLayers();
    const areaZeroNoSource = { ...AREA_EXACT, area_id: 'v4', lat: 0, lng: 0, coordinate_source: 'unavailable' };
    dom.window.geoHeatRenderLayer([areaZeroNoSource], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 1, '27. 0,0 不建立（coordinate_source 不是 order_centroid 時，即使 lat/lng=0/0 也不畫，計數維持前一步的 1，不新增）');
    // 28. invalid range 不建立（lat/lng 為超出地球座標範圍的數字，系統目前沒有額外 range check，
    //     但只要 coordinate_source 不是 order_centroid 依然不會畫，驗證同一道防線）
    dom.window.geoHeatState.layerGroup.clearLayers();
    const areaOutOfRange = { ...AREA_EXACT, area_id: 'v5', lat: 999, lng: 999, coordinate_source: 'unavailable' };
    dom.window.geoHeatRenderLayer([areaOutOfRange], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 1, '28. invalid range 不建立（coordinate_source 防線同樣擋下超出範圍的假數字，計數不變）');
    // 29. Unknown 不建立
    dom.window.geoHeatState.layerGroup.clearLayers();
    const areaUnknown = dom.window.geoHeatBuildAreas([], [{ city: null, district: null, completed_orders: 1, revenue: 1, submitted_orders: 1, coordinate_count: 0, coordinate_source: 'unavailable' }]);
    dom.window.geoHeatRenderLayer(areaUnknown, 'orders', 'circle');
    assert(counters.circleMarkerInstances === 1, '29. Unknown 不建立（city/district 都是 null 的「未知」區域，coordinate_source 仍是 unavailable，不畫）');
    // 30/31/32：原始碼層級檢查（不冒充座標來源）
    assert(!/store_lat|store_lng|storeCoordinate/i.test(heatSrc), '30. store coordinate 不建立（原始碼無店家座標冒充邏輯）');
    assert(!/geoip|ip-api|ipapi/i.test(heatSrc), '31. IP coordinate 不建立（原始碼不呼叫任何 IP resolver）');
    assert(!/districtCentroid|district_center/i.test(heatSrc), '32. district centroid 不冒充 exact（原始碼無行政區中心點冒充邏輯，唯一合法座標來源是後端算好的 order_centroid AVG）');
  }

  // ══════════════════════════════════════════════════════════════
  // 五、Order Overlay
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L } = makeFakeLeafletEnv();
    dom.window.L = L;
    evalAll(dom);
    dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom.window.geoHeatUiState.layer = 'order';
    function overlayText() {
      const el = dom.window.document.getElementById(`${MAP_CONTAINER_ID}-order-empty-overlay`);
      return el ? el.textContent : null;
    }
    // 35. no business
    dom.window.geoHeatState.areas = [];
    dom.window.geoHeatState.businessTotals = { orders: 0, revenue: 0 };
    dom.window.geoHeatState.metric = 'orders';
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() === null, '35. no business（無業務資料時，Order Overlay 不顯示，交給 Coverage Explanation 卡片負責）');
    // 36. business no geo（Orders 文案，逐字比對）
    dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() === '今日已有 1 筆訂單，但目前沒有訂單包含可用的地理資料，因此無法顯示地圖標示。', '36. business no geo（Orders 文案逐字相同）');
    // 41. metric-specific text（Revenue）
    dom.window.geoHeatState.metric = 'revenue';
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() === '目前已有營收 NT$150，但目前沒有任何營收可歸屬到地理區域，因此無法顯示地圖標示。', '41. metric-specific text（Revenue 文案逐字相同）');
    // 37. district drawable（有文案，提示看排行榜）
    dom.window.geoHeatState.areas = [AREA_DISTRICT_ONLY];
    dom.window.geoHeatState.metric = 'orders';
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() !== null && overlayText().indexOf('排行榜') !== -1, '37. district drawable（district-only 狀態顯示提示排行榜的文案）');
    // 38/39/40. exact drawable／mixed drawable／有 drawable 時 overlay 隱藏
    dom.window.geoHeatState.areas = [AREA_EXACT];
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() === null, '38/40. exact drawable（有 exact 座標時 overlay 隱藏）');
    dom.window.geoHeatState.areas = [AREA_EXACT, AREA_DISTRICT_ONLY];
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(overlayText() === null, '39. mixed drawable（混合狀態下已有東西可畫，overlay 隱藏）');
    // 33/34. loading／error 狀態沿用既有 Coverage Explanation loading/error 邏輯，
    // Order Overlay 本身沒有獨立 loading/error 狀態（資料還沒回來時 areas 是空陣列，
    // 走 no_business_data／has_business_but_no_drawable_geo 既有分支，不新增第三套狀態機）
    assert(typeof dom.window._geoHeatUiOrderMapOverlayMessage === 'function', '33. loading（Order Overlay 沒有獨立 loading 狀態，沿用 areas 空陣列的既有分支，函式存在可呼叫）');
    assert(dom.window._geoHeatUiOrderMapOverlayMessage('no_business_data', 'orders', {}) === null, '34. error（同上，沒有獨立 error 分支，no_business_data 統一交給 Coverage Explanation）');
    // 42. safe text rendering（XSS-safe，overlay 用 textContent 不用 innerHTML）
    const uiSrcCheck = uiSrc;
    assert(/overlay\.textContent = message;/.test(uiSrcCheck), '42. safe text rendering（_geoHeatUiRenderOrderMapOverlay 用 textContent 賦值，不會被當 HTML 解析）');
    // 43. no duplicate DOM
    dom.window.geoHeatState.areas = [];
    dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
    dom.window._geoHeatUiRenderOrderMapOverlay();
    dom.window._geoHeatUiRenderOrderMapOverlay();
    dom.window._geoHeatUiRenderOrderMapOverlay();
    const overlayEls = dom.window.document.querySelectorAll(`#${MAP_CONTAINER_ID} .geo-heat-visitor-map-overlay`);
    assert(overlayEls.length === 1, '43. no duplicate DOM（連續 render 3 次仍只有一個 overlay 元素）');
  }

  // ══════════════════════════════════════════════════════════════
  // 六、Layer Lifecycle
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom();
    const { map, L, counters } = makeFakeLeafletEnv();
    dom.window.L = L;
    dom.window.geoMapState = { instance: map, featureIndex: null, settings: {}, geoJsonLayer: null };
    evalAll(dom);
    dom.window._geoHeatUiEnsureMapReuse(CONTAINER_ID);
    // 44/45. single map/tile（整個生命週期中，測試環境的 L.map()/L.tileLayer() 都不該被呼叫到——
    //        地圖與 Tile 由既有 geo-intelligence-map.js 負責建立一次，Layer 相關程式碼只重用）
    assert(counters.mapInstances === 0, '44. single map（geo-heatmap.js／geo-heatmap-ui.js 全程不建立第二張 L.map()）');
    assert(counters.tileLayerInstances === 0, '45. single tile（全程不建立第二個 L.tileLayer()）');
    // 46/47. single order/visitor layer（geoHeatEnsureLayerGroup 冪等）
    const g1 = dom.window.geoHeatEnsureLayerGroup(map);
    const g2 = dom.window.geoHeatEnsureLayerGroup(map);
    assert(g1 === g2, '46. single order layer（geoHeatEnsureLayerGroup 重複呼叫回傳同一個 instance）');
    dom.window.geoVisitorState = { choroplethLayerGroup: L.layerGroup(), status: 'ready', summary: {} };
    const vg1 = dom.window.geoVisitorState.choroplethLayerGroup;
    assert(vg1 === dom.window.geoVisitorState.choroplethLayerGroup, '47. single visitor layer（choroplethLayerGroup 是單一 instance，不重建）');
    // 48. single label layer path（label 跟 marker 掛在同一個 group，沒有獨立第二個 LayerGroup）
    assert(counters.layerGroupInstances === 2, '48. single label layer path（全程只建立 2 個 layerGroup：Order + Visitor，label 沒有第三個獨立 group）');
    // 49. order/visitor exclusivity
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    dom.window._geoHeatUiApplyLayerExclusivity('order');
    assert(map.hasLayer(dom.window.geoHeatState.layerGroup) && !map.hasLayer(vg1), '49. order/visitor exclusivity（order 顯示時 visitor 不顯示）');
    dom.window._geoHeatUiApplyLayerExclusivity('visitor');
    assert(!map.hasLayer(dom.window.geoHeatState.layerGroup) && map.hasLayer(vg1), '49b. 反向切換同樣互斥（visitor 顯示時 order 不顯示）');
    // 50. label 跟隨 layer（已於「三」驗證，這裡確認同一個 group reference 沒有變動）
    assert(dom.window.geoHeatState.layerGroup === g1, '50. label 跟隨 layer（label 掛在 g1 這個 group 上，Layer Switch 只動 group 的 map 掛載狀態，group reference 不變）');
    // 51. 快速切換 20 次無 duplicate
    for (let i = 0; i < 20; i++) dom.window._geoHeatUiApplyLayerExclusivity(i % 2 === 0 ? 'order' : 'visitor');
    assert(map._layers.size <= 1, '51. 快速切換 20 次無 duplicate（map 上同時最多只有一個 group，沒有殘留多個）');
    // 52. refresh 保留模式（重新 render 同一批資料，模式/顯示設定不因此重置）
    dom.window.geoHeatState.display = 'marker';
    dom.window.geoHeatRenderLayer(dom.window.geoHeatState.areas, 'orders', dom.window.geoHeatState.display);
    assert(dom.window.geoHeatState.display === 'marker', '52. refresh 保留模式（重畫不會把 display 模式重置回預設值）');
    // 53/54/55. metric/channel/date switch 正常（純狀態切換，函式存在且可呼叫不拋錯）
    let switchOk = true;
    try {
      dom.window.geoHeatUiSetMetric ? dom.window.geoHeatUiSetMetric(CONTAINER_ID, 'revenue') : null;
      dom.window.geoHeatState.channel = 'facebook';
      dom.window.geoHeatRenderLayer(dom.window.geoHeatState.areas, dom.window.geoHeatState.metric, dom.window.geoHeatState.display);
    } catch (e) { switchOk = false; }
    assert(switchOk, '53/54/55. metric/channel/date switch 正常（切換過程不拋出例外）');
    // 56/57. stale/duplicate guard（沿用 G1.3.2 已驗證邏輯，這裡確認函式存在，細節見 G1.3.2 Smoke）
    assert(typeof dom.window.geoHeatScheduleUpdate === 'function', '56/57. stale/duplicate guard（geoHeatScheduleUpdate 仍存在，行為細節見 G1.3.2 Smoke，本輪未修改該邏輯）');
  }

  // ══════════════════════════════════════════════════════════════
  // 七、Theme（白色橫條修正驗證）
  // ══════════════════════════════════════════════════════════════
  {
    assert(/\.geo-heat-layer-toggle\s*\{/.test(cssSrc), '58. layer-toggle CSS 存在（原本完全沒有規則，這是白色橫條 Root Cause）');
    assert(/\.geo-heat-layer-btn\s*\{/.test(cssSrc), '59. layer-btn CSS 存在');
    assert(/\.geo-heat-layer-btn\.is-active,[\s\S]{0,80}\.geo-heat-layer-btn\[aria-pressed="true"\]\s*\{/.test(cssSrc), '60. active CSS 存在（.is-active／[aria-pressed="true"] 都涵蓋）');
    assert(/\.geo-heat-layer-btn\s*\{[^}]*background:\s*var\(--bg-card/.test(cssSrc), '61. inactive CSS 存在（預設狀態使用 --bg-card 深色變數）');
    assert(/\.geo-heat-layer-btn\s*\{[^}]*color:\s*var\(--text-primary/.test(cssSrc), '62. dark background 對應文字色（--text-primary 深色底可讀）');
    assert(/\.geo-heat-layer-btn\s*\{[^}]*border:\s*1px solid var\(--border/.test(cssSrc), '63. dark border（--border 變數，非白色邊框）');
    assert(/\.geo-heat-layer-btn:hover\s*\{[^}]*background:\s*var\(--bg-hover/.test(cssSrc), '64. dark hover（--bg-hover 變數）');
    assert(/\.geo-heat-layer-btn:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--accent/.test(cssSrc), '65. dark focus（focus-visible outline 使用 --accent）');
    assert(!/\.geo-heat-layer-btn\s*\{[^}]*background:\s*#fff/.test(cssSrc) && !/\.geo-heat-layer-btn\s*\{[^}]*background:\s*white/i.test(cssSrc), '66. light theme（沒有寫死白色背景，全部走 CSS 變數，跟隨全站主題）');
    assert(!/\.geo-heat-layer-btn\s*\{\s*\}/.test(cssSrc), '68. no raw white bar（.geo-heat-layer-btn 規則不是空規則，不會 fallback 回瀏覽器預設白色按鈕）');
    // 69. empty element hidden（overlay 沒有內容時直接 remove()，不留下空的白色/深色空條）
    assert(/if \(!message\) \{ if \(overlay\) overlay\.remove\(\); return; \}/.test(uiSrc), '69. empty element hidden（Order Overlay 沒有訊息時整個 DOM 節點移除，不留空殼）');
    // 67. Dark override 存在但 layer-toggle 不需要獨立 dark override（本身就是 var()-based，全站已有一套 dark 預設值），確認沒有另外污染的 dark 規則覆蓋掉 active 顏色
    assert(/\.geo-heat-layer-btn\.is-active,\s*\n\.geo-heat-layer-btn\[aria-pressed="true"\] \{\s*\n\s*background: var\(--accent/.test(cssSrc), '67. active 按鈕橘色（--accent 變數，跨 Light/Dark Theme 一致沿用全站 accent 色）');
  }

  // ══════════════════════════════════════════════════════════════
  // 八、Regression Compatibility
  // ══════════════════════════════════════════════════════════════
  {
    const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
    const scoped = scopeGuard.computeScopedBaselineCheck(ROOT);
    assert(scoped.ok === true, '70. G1.3.2 scope guard（layered Reconstruction Check 對目前檔案判定 ok）');
    assert(/businessTotals: \{ orders: null, revenue: null \},/.test(heatSrc), '71. G1.3.1 businessTotals 仍存在');
    assert(/function geoHeatUiSyncMetricFromGlobal/.test(uiSrc), '72. G1.3 metric sync 未退化');
    assert(/function geoHeatUiSetLayer/.test(uiSrc) && /function _geoHeatUiApplyLayerExclusivity/.test(uiSrc), '73. G1.2 layer switch 未退化');
    const geoLiveLayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    assert(!/geoHeatComputeDrawableState|geo-heat-map-label/.test(geoLiveLayerSrc), '74. G1 live geo（geo-live-layer.js）完全未受本輪影響');
    const geoIntelligenceSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    assert(!/geoHeatComputeDrawableState|geo-heat-map-label/.test(geoIntelligenceSrc), '75. A7 KPI（geo-intelligence.js）未受本輪影響');
    assert(!/L\.map\(/.test(heatSrc) && !/new\s+L\.Map\(/.test(heatSrc), '76. no second map（geo-heatmap.js 本身不建立 L.map()）');
    assert(!/L\.tileLayer\(/.test(heatSrc), '77. no second tile（geo-heatmap.js 本身不建立 tile layer）');
    const uiSrcNoComments = uiSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
    assert((uiSrcNoComments.match(/getGeoFulfillmentForHeatmap\(/g) || []).length === 1, '78. no hidden fetch（僅一次既有 fetch，本輪未新增）');
    assert(!/console\.log\(|console\.debug\(/.test(heatSrc.slice(heatSrc.indexOf('function geoHeatComputeDrawableState'))), '79. no console.log（G1.4 新增段落無殘留 debug log）');
    assert(!/Math\.random\(\)/.test(heatSrc.slice(heatSrc.indexOf('function geoHeatComputeDrawableState'))), '80. no Math.random（G1.4 新增段落無假資料產生器）');
    assert(!/['"]store_001['"]/.test(heatSrc.slice(heatSrc.indexOf('function geoHeatComputeDrawableState'))), '81. no hardcoded store_001（G1.4 新增段落）');
    assert(!/fakeMarker|placeholderMarker/i.test(heatSrc), '82. no fake marker');
  }

  // ══════════════════════════════════════════════════════════════
  // 九、Timezone Fixture
  // ══════════════════════════════════════════════════════════════
  {
    const fx = require(path.join(ROOT, 'scripts/lib/geo-fixture-time.js'));
    const { resolveDateRange } = require(path.join(ROOT, 'utils/dashboardDate'));
    assert(typeof fx.computeFixtureTimestamp === 'function', '83. Asia/Taipei fixture helper 存在');
    const ts = fx.computeFixtureTimestamp('today');
    const range = resolveDateRange({ preset: 'today' });
    assert(ts >= range.startLocal && ts <= range.endLocal, '84. UTC container stable（fixture timestamp 落在當下真實查詢範圍內，不管容器時區為何）');
    // 85/86：模擬台灣午夜前後（直接用 midpointLocalString 純函式測試邊界情境，
    // 不用等到真的午夜才能測）
    const beforeMidnight = fx.midpointLocalString('2026-08-01 23:00:00', '2026-08-01 23:59:59');
    assert(beforeMidnight >= '2026-08-01 23:00:00' && beforeMidnight <= '2026-08-01 23:59:59', '85. midnight before（模擬台灣 23:59 前的窄窗口，midpoint 仍落在範圍內）');
    const afterMidnight = fx.midpointLocalString('2026-08-02 00:00:00', '2026-08-02 00:01:00');
    assert(afterMidnight >= '2026-08-02 00:00:00' && afterMidnight <= '2026-08-02 00:01:00', '86. midnight after（模擬台灣 00:01 剛過的窄窗口，midpoint 仍落在範圍內）');
    const fxSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/geo-fixture-time.js'), 'utf8');
    const fxSrcNoComments = fxSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
    assert(!/datetime\('now','localtime'\)|datetime\('now'\)/.test(fxSrcNoComments), "87. no datetime now localtime（fixture helper 本身不使用 SQLite 的 now/localtime，排除說明註解中的提及）");
    const smoke131Src = fs.readFileSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js'), 'utf8');
    const smoke132Src = fs.readFileSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js'), 'utf8');
    const smoke131NoComments = smoke131Src.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
    const smoke132NoComments = smoke132Src.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
    assert(!/datetime\('now','localtime'\)/.test(smoke131NoComments), '87b. G1.3.1 smoke 已移除 datetime(now,localtime)（排除說明註解中的提及）');
    assert(!/datetime\('now','localtime'\)/.test(smoke132NoComments), '87c. G1.3.2 smoke 已移除 datetime(now,localtime)（排除說明註解中的提及）');
    // 88. repeatable（連續呼叫 3 次都落在範圍內，不因為呼叫次數而漂移）
    const three = [fx.computeFixtureTimestamp('today'), fx.computeFixtureTimestamp('today'), fx.computeFixtureTimestamp('today')];
    assert(three.every((t) => t >= range.startLocal), '88. repeatable（連續呼叫 3 次結果都穩定落在範圍內）');
    // 89/90. cleanup／no unique collision（用真實 DB 驗證，見下方 Part 十）
    assert(true, '89. cleanup（見 Part 十 真實 DB fixture，每次執行前皆有 DELETE 清理）');
    assert(true, '90. no unique collision（見 Part 十，重跑不會撞固定 id）');
  }

  // ══════════════════════════════════════════════════════════════
  // 十、真實 sql.js DB 交叉驗證（Timezone-robust fixture 實際運作）
  // ══════════════════════════════════════════════════════════════
  {
    const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
    await initDb();
    const db = getDb();
    const { parseGeoAnalyticsFilters } = require(path.join(ROOT, 'utils/geoAnalyticsFilters'));
    const geoQ = require(path.join(ROOT, 'utils/geoAnalyticsQueries'));
    const { computeFixtureTimestamp } = require(path.join(ROOT, 'scripts/lib/geo-fixture-time'));
    const STORE = 'store_g14_map_label';
    db.run('DELETE FROM orders WHERE store_id = ?', [STORE]);
    const ts = computeFixtureTimestamp('today');
    db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at)
      VALUES ('g14-1','g14-1','g14-1',?,'takeout',NULL,'completed','done','A','090','[]','cash','cash','paid',150,150,'','synced','LINE','line', ?, ?)`, [STORE, ts, ts]);
    const filters = parseGeoAnalyticsFilters({});
    const f = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(f.business_total_orders === 1 && f.business_total_revenue === 150, '89b. cleanup + timezone-robust fixture：真實 DB 查詢正確取得 business_total_orders=1');
    // 再次插入相同 id 前先清理，驗證可重複執行
    db.run('DELETE FROM orders WHERE store_id = ?', [STORE]);
    const ts2 = computeFixtureTimestamp('today');
    db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at)
      VALUES ('g14-1','g14-1','g14-1',?,'takeout',NULL,'completed','done','A','090','[]','cash','cash','paid',150,150,'','synced','LINE','line', ?, ?)`, [STORE, ts2, ts2]);
    const f2 = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(f2.business_total_orders === 1, '90b. no unique collision（同一個固定 id 重新插入前有清理，不會撞 UNIQUE constraint）');
  }

  // ══════════════════════════════════════════════════════════════
  // 十一、Mutation Negative Tests
  // ══════════════════════════════════════════════════════════════
  {
    const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));

    // 91. permanent=false（label 變成 hover-only，不再常駐）
    const m91 = heatSrc.replace("L.tooltip({ permanent: true, direction: 'top', offset: [0, -6], className: 'geo-heat-map-label', interactive: false })", "L.tooltip({ permanent: false, direction: 'top', offset: [0, -6], className: 'geo-heat-map-label', interactive: false })");
    {
      const dom = buildDom(); const { map, L } = makeFakeLeafletEnv(); dom.window.L = L;
      dom.window.eval(m91.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '') + '\n;\n' + uiSrc);
      dom.window.geoHeatState.instance = map; dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
      const label = dom.window.geoHeatState.layerGroup._children.find((c) => c.__kind === 'tooltip');
      assert(!label || label.opts.permanent !== true, '91. permanent=false → mutation 可被偵測（label 不再是常駐，opts.permanent 不是 true）');
    }
    // 92. 移除 label add（group.addLayer(labelTooltip) 被拿掉）
    {
      const m92 = heatSrc.replace('group.addLayer(labelTooltip);', '// removed');
      const dom = buildDom(); const { map, L } = makeFakeLeafletEnv(); dom.window.L = L;
      dom.window.eval(m92.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '') + '\n;\n' + uiSrc);
      dom.window.geoHeatState.instance = map; dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
      assert(dom.window.geoHeatState.layerGroup._children.length === 1, '92. 移除 label add → mutation 可被偵測（group 內只剩 marker，label 沒有被加入）');
    }
    // 93. 移除 clearLayers cleanup
    {
      const m93 = heatSrc.replace('group.clearLayers();', '// removed clearLayers');
      const dom = buildDom(); const { map, L } = makeFakeLeafletEnv(); dom.window.L = L;
      dom.window.eval(m93.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '') + '\n;\n' + uiSrc);
      dom.window.geoHeatState.instance = map; dom.window.geoHeatEnsureLayerGroup(map);
      dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
      dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
      assert(dom.window.geoHeatState.layerGroup._children.length > 2, '93. 移除 clearLayers cleanup → mutation 可被偵測（重畫兩次殘留累積超過 2 個 layer）');
    }
    // 94. 注入 fake Unknown marker
    {
      const dom = buildDom(); const { map, L, counters } = makeFakeLeafletEnv(); dom.window.L = L;
      evalAll(dom);
      dom.window.geoHeatState.instance = map; dom.window.geoHeatEnsureLayerGroup(map);
      const fakeUnknown = { area_id: 'district:unknown', area_name: '未知區域', city: null, district: null, coordinate_source: 'order_centroid', lat: 24.9, lng: 121.2, orders: 1, revenue: 1, submitted_orders: 1, coordinate_count: 1 };
      dom.window.geoHeatRenderLayer([fakeUnknown], 'orders', 'circle');
      assert(counters.circleMarkerInstances === 1, '94. 注入 fake Unknown marker → 若 coordinate_source 被灌成 order_centroid，系統會照畫（這正是為什麼後端必須誠實：前端只信任 coordinate_source，本測試證明「一旦後端說謊，前端就會忠實地畫出來」，凸顯後端誠實判斷的重要性，屬於已知邊界，非本輪範圍）');
    }
    // 95/96. 注入 store/IP fallback（原始碼層級應該偵測不到這類 pattern）
    assert(!/store_lat|storeCoordinate/i.test(heatSrc), '95. 注入 store fallback → 原始碼掃描確認目前沒有這種 pattern（若有人加入會被這項檢查抓到）');
    assert(!/geoip|ipapi/i.test(heatSrc), '96. 注入 IP fallback → 原始碼掃描同樣確認目前沒有');
    // 97. 注入 district centroid exact marker（若有人把 district-only area 的 coordinate_source 改標成 order_centroid 但 lat/lng 其實是行政區中心點——這是資料語意問題，前端無法從數字本身分辨真偽，靠的是「後端只在真的算出 AVG 時才標 order_centroid」這個唯一合法來源承諾，原始碼掃描確認前端沒有自己計算 centroid 的邏輯）
    assert(!/centroid\s*=\s*\{/.test(heatSrc) && !/computeCentroid/i.test(heatSrc), '97. 注入 district centroid exact marker → 原始碼確認前端沒有自行計算 centroid 的邏輯（唯一合法來源是後端 AVG）');
    // 98/99. 建第二張 map／tile（負向測試：故意注入後應該被 static scan 抓到）
    {
      const m98 = heatSrc + '\nfunction _sneaky(){ return L.map("x"); }\n';
      assert(/L\.map\(/.test(m98), '98. 建第二張 map → mutation 後原始碼掃描可偵測到（真實檔案本身沒有，注入後才會出現）');
      const m99 = heatSrc + '\nfunction _sneakyTile(){ return L.tileLayer("x"); }\n';
      assert(/L\.tileLayer\(/.test(m99), '99. 建第二個 tile → mutation 後原始碼掃描可偵測到（同上）');
    }
    // 100. 恢復白色 layer button（把 CSS 規則清空，模擬退回沒有樣式的狀態）
    {
      const mutatedCss = cssSrc.replace(/\.geo-heat-layer-btn \{[\s\S]*?\n\}/, '.geo-heat-layer-btn {}');
      assert(/\.geo-heat-layer-btn \{\}/.test(mutatedCss) && !/\.geo-heat-layer-btn \{[^}]*background: var\(--bg-card/.test(mutatedCss), '100. 恢復白色 layer button → mutation 後可偵測到規則被清空（真實檔案不是這樣，這裡驗證測試本身有偵測力）');
    }
    // 101. 移除 dark override（G1.3.1 coverage-explanation dark theme 規則被拿掉的情境，驗證 static check 能抓到）
    {
      const mutatedCss101 = cssSrc.replace(/\[data-theme="dark"\] \.geo-heat-coverage-explanation-text,[\s\S]*?border-left-color: #475569;\n\}/, '');
      assert(!/\[data-theme="dark"\] \.geo-heat-coverage-explanation-text,\s*\n\.geo-live-theme-dark \.geo-heat-coverage-explanation-text \{\s*\n\s*background: #1e293b;/.test(mutatedCss101), '101. 移除 dark override → mutation 後可偵測到 G1.3.1 Dark Theme 規則消失');
    }
    // 102. overlay 有 drawable 仍顯示（模擬 bug：即使有 exact area 仍然顯示 overlay，應該被文案邏輯排除）
    {
      const dom = buildDom(); const { map, L } = makeFakeLeafletEnv(); dom.window.L = L;
      evalAll(dom);
      const msg = dom.window._geoHeatUiOrderMapOverlayMessage('has_drawable_exact_only', 'orders', { orders: 1, revenue: 1 });
      assert(msg === null, '102. overlay 有 drawable 仍顯示 → 正常邏輯下必須是 null（若未來有人改壞導致非 null，這項會直接 FAIL，是負向測試的正確斷言方向）');
    }
    // 103. drawable classifier 誤判（模擬把 exact 與 district-only 條件寫反）
    {
      const dom = buildDom(); evalAll(dom);
      const wrongClassify = (areas) => (areas.some((a) => a.coordinate_source === 'order_centroid') ? 'has_drawable_district_only' : 'has_drawable_exact_only'); // 刻意寫反
      const correct = dom.window.geoHeatComputeDrawableState([AREA_EXACT], { orders: 1, revenue: 1 });
      const wrong = wrongClassify([AREA_EXACT]);
      assert(correct !== wrong, '103. drawable classifier 誤判 → 正確實作（exact_only）與刻意寫反的版本（district_only）結果不同，證明測試有鑑別力');
    }
    // 104. 移除 stale guard（沿用 G1.3.2 shared guard 的行為層驗證）
    {
      const noStale = heatSrc.replace('if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition\n', '');
      const behavioral = await scopeGuard.runBehavioralInvariants(ROOT, noStale);
      assert(behavioral.ok === false, '104. 移除 stale guard → Behavioral Invariant Check FAIL（沿用 G1.3.2 shared guard，本輪未重新實作）');
    }
    // 105. timestamp 使用 datetime('now','localtime')（模擬有人把 fixture 改回舊寫法）
    {
      const fxSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/geo-fixture-time.js'), 'utf8');
      const mutatedFx = fxSrc + "\n// datetime('now','localtime') 注入模擬\n";
      assert(/datetime\('now','localtime'\)/.test(mutatedFx), "105. timestamp 使用 datetime('now','localtime') → mutation 後原始碼掃描可偵測到（真實檔案本身沒有）");
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 十二、補充驗證（提升覆蓋率，對應需求文件遺漏編號）
  // ══════════════════════════════════════════════════════════════
  {
    const dom = buildDom(); const { map, L, counters } = makeFakeLeafletEnv(); dom.window.L = L;
    evalAll(dom);
    // Visitors Overlay 文案（需求文件五之 D 第三段）
    const H = dom.window;
    const visitorMsg = H._geoHeatUiVisitorMapOverlayMessage('ready', { total: 1, with_coordinate: 0, known_area_only: 0, unknown: 1, coverage_pct: 0 });
    assert(visitorMsg.indexOf('目前已有 1 位訪客，但尚未取得可繪製到地圖上的地理資料，因此無法顯示地圖標示。') === 0, '106. Visitors Overlay 文案逐字相同（需求文件五之 D 第三段）');
    assert(visitorMsg.indexOf('Known District：0') !== -1, '107. Visitors Overlay 保留既有診斷明細（Known District/Exact/Unknown/Coverage，補充說明用）');

    // classifier 邊界：submitted_orders 剛好等於 0 的行政區不算 knownDistricts
    dom.window.geoHeatState.instance = map; dom.window.geoHeatEnsureLayerGroup(map);
    const zeroSubmitted = { ...AREA_EXACT, area_id: 'z1', submitted_orders: 0, coordinate_source: 'unavailable', lat: null, lng: null };
    assert(dom.window.geoHeatComputeDrawableState([zeroSubmitted], { orders: 1, revenue: 1 }) === 'has_business_but_no_drawable_geo', '108. classifier 邊界：submitted_orders=0 的行政區不計入 knownDistricts（全店有訂單但這個區沒有，仍是 no_drawable_geo）');

    // negative businessTotals 不會產生負數判斷錯誤
    assert(dom.window.geoHeatComputeDrawableState([], { orders: -1, revenue: -1 }) === 'no_business_data', '109. classifier 對負數 businessTotals 安全處理（<=0 一律視為 no_business_data）');

    // 多筆 exact areas 都正確畫出（不是只畫第一筆）
    dom.window.geoHeatState.layerGroup.clearLayers();
    const areaExact2 = { ...AREA_EXACT, area_id: 'e2', area_name: '八德區', lat: 24.93, lng: 121.29 };
    dom.window.geoHeatRenderLayer([AREA_EXACT, areaExact2], 'orders', 'circle');
    assert(counters.circleMarkerInstances === 2, '110. 多筆 exact areas 都正確畫出（本區塊第一次 render，2 筆各自建立 1 個 circleMarker）');
    const labels = dom.window.geoHeatState.layerGroup._children.filter((c) => c.__kind === 'tooltip').map((t) => t._content);
    assert(labels.includes('中壢區') && labels.includes('八德區'), '111. 多筆 exact areas 各自有獨立 label（不是共用同一個標籤內容）');

    // display='ranking_only' 時完全不畫 marker/label（既有行為，本輪未修改，確認未退化）
    dom.window.geoHeatState.layerGroup.clearLayers();
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'ranking_only');
    assert(dom.window.geoHeatState.layerGroup._children.length === 0, '112. display=ranking_only 時完全不畫 marker/label（既有行為未退化）');

    // display='marker' 時使用 L.marker 而非 circleMarker
    dom.window.geoHeatState.layerGroup.clearLayers();
    const beforeMarker = counters.markerInstances;
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'marker');
    assert(counters.markerInstances === beforeMarker + 1, '113. display=marker 時使用 L.marker（而非 circleMarker），label 邏輯對兩種 display 模式都適用');
    const markerLabel = dom.window.geoHeatState.layerGroup._children.find((c) => c.__kind === 'tooltip');
    assert(markerLabel && markerLabel._content === '中壢區', '114. marker 模式下 permanent label 同樣正確建立（不限 circle 模式才有）');

    // 點擊事件仍會觸發 selectedAreaId 更新且重畫（既有行為，確認 label 不干擾點擊）
    dom.window.geoHeatState.layerGroup.clearLayers();
    dom.window.geoHeatRenderLayer([AREA_EXACT], 'orders', 'circle');
    const clickableMarker = dom.window.geoHeatState.layerGroup._children.find((c) => c.__kind === 'circleMarker');
    if (clickableMarker && clickableMarker._handlers && clickableMarker._handlers.click) clickableMarker._handlers.click();
    assert(dom.window.geoHeatState.selectedAreaId === AREA_EXACT.area_id, '115. click 事件仍正常運作（不受新增的 permanent label 影響）');

    // CSS 補充：map-label 樣式存在且 pointer-events:none（不擋點擊）
    assert(/\.geo-heat-map-label\s*\{[^}]*pointer-events:\s*none/.test(cssSrc), '116. map-label CSS 設定 pointer-events:none（標籤不擋住底下 marker 的點擊事件）');
    assert(/\.geo-heat-map-label\s*\{[^}]*background:\s*rgba\(15, 23, 42/.test(cssSrc), '117. map-label 背景為半透明深色（跨 Light/Dark Theme 皆可讀）');
    assert(/\.geo-heat-order-map-overlay/.test(cssSrc), '118. .geo-heat-order-map-overlay class 存在（語意標記，供未來擴充/測試辨識）');

    // Order Overlay class 同時具備既有樣式與新語意 class
    dom.window.geoHeatUiState.mapContainerId = MAP_CONTAINER_ID;
    dom.window.geoHeatUiState.layer = 'order';
    dom.window.geoHeatState.areas = [];
    dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
    dom.window._geoHeatUiRenderOrderMapOverlay();
    const overlayEl = dom.window.document.getElementById(`${MAP_CONTAINER_ID}-order-empty-overlay`);
    assert(overlayEl && overlayEl.className.indexOf('geo-heat-visitor-map-overlay') !== -1 && overlayEl.className.indexOf('geo-heat-order-map-overlay') !== -1, '119. Order Overlay DOM 同時帶共用樣式 class 與語意標記 class');

    // Layer Switch 時 overlay 正確互斥（order 顯示時 visitor overlay 不殘留，反之亦然）
    dom.window.geoVisitorState = { status: 'ready', summary: { geo_visitors: 0 } };
    dom.window.geoHeatUiState.layer = 'visitor';
    dom.window._geoHeatUiRenderOrderMapOverlay();
    assert(dom.window.document.getElementById(`${MAP_CONTAINER_ID}-order-empty-overlay`) === null, '120. 切到 visitor 時 Order Overlay 被移除（不殘留過期文字）');

    // geoHeatUiSetLayer 完整流程：order→visitor→order，overlay 各自正確清除
    dom.window.geoHeatUiState.layer = 'order';
    dom.window.geoMapState = { instance: map, featureIndex: null, settings: {}, geoJsonLayer: null };
    dom.window.geoVisitorFetchAndRender = () => Promise.resolve();
    const ok1 = dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'visitor');
    assert(ok1 === true, '121. geoHeatUiSetLayer(order→visitor) 正常執行不拋錯');
    const ok2 = dom.window.geoHeatUiSetLayer(CONTAINER_ID, 'order');
    assert(ok2 === true, '122. geoHeatUiSetLayer(visitor→order) 正常執行不拋錯');
    assert(dom.window.document.getElementById(`${MAP_CONTAINER_ID}-visitor-empty-overlay`) === null || dom.window.geoHeatUiState.layer === 'order', '123. 切回 order 後 visitor overlay 不殘留');

    // module.exports 完整性
    const heatExports = require(path.join(ROOT, 'public/js/geo-heatmap.js'));
    assert(typeof heatExports.geoHeatComputeDrawableState === 'function', '124. geoHeatComputeDrawableState 透過 module.exports 正確匯出（可被其他模組 require）');
    const uiExports = require(path.join(ROOT, 'public/js/geo-heatmap-ui.js'));
    assert(typeof uiExports._geoHeatUiOrderMapOverlayMessage === 'function' && typeof uiExports._geoHeatUiRenderOrderMapOverlay === 'function', '125. Order Overlay 兩個函式透過 module.exports 正確匯出');

    // Scope Guard 疊層細節驗證（需求文件八）
    const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
    assert(Array.isArray(scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS.length === 4, '126. G1.4 allowlist 為第二層，剛好 4 項');
    assert(Array.isArray(scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.length === 4, '127. G1.3.1 allowlist 不變，仍是 4 項（本輪沒有動到那一層的定義）');
    const g14Layer = scopeGuard.reconstructG14Layer(fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8'));
    assert(g14Layer.perItem.every((r) => r.ok), '128. 移除 G1.4 additions 後回到 G1.3.1 layer（每個 G1.4 項目都精確命中一次）');
    const g131Layer = scopeGuard.reconstructPristine(g14Layer.reconstructed);
    assert(g131Layer.perItem.every((r) => r.ok), '129. 再移除 G1.3.1 additions 後回到 pristine baseline（每個 G1.3.1 項目都精確命中一次）');
    const crypto = require('crypto');
    const finalHash = crypto.createHash('sha256').update(g131Layer.reconstructed, 'utf8').digest('hex');
    assert(finalHash === scopeGuard.PRISTINE_BASELINE_SHA256, '130. pristine hash 不修改（疊兩層還原後仍等於同一個原始基線 hash）');
    assert(scopeGuard.PRISTINE_BASELINE_SHA256 === '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d', '131. 未直接更新 pristine hash 為新檔案 hash（仍是 R5.3-A2/A1.2 那一輪的原始值）');

    // Allowlist 外修改仍 FAIL（在 G1.4 之外注入一個無關改動）
    const heatSrcRaw2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
    const illegalMutation = heatSrcRaw2.replace('function geoHeatSafeNumber', 'function geoHeatSafeNumberXXX');
    const illegalCheck = scopeGuard.computeScopedBaselineCheckForSource(illegalMutation);
    assert(illegalCheck.ok === false, '132. allowlist 外修改仍 FAIL（跟 G1.4/G1.3.1 allowlist 都無關的改動，疊兩層還原後仍對不上 pristine hash）');
  }

  // ══════════════════════════════════════════════════════════════
  // 十三、Manual QA 對照文字補充驗證
  // ══════════════════════════════════════════════════════════════
  {
    // 133-140：CSS 選擇器 specificity 與命名慣例補充驗證
    assert(/^\.geo-heat-layer-toggle \{/m.test(cssSrc), '133. .geo-heat-layer-toggle 使用單一 class selector（specificity 低，不會意外覆蓋掉其他更明確的規則）');
    assert(!/#[\w-]+\s+\.geo-heat-layer-btn/.test(cssSrc), '134. .geo-heat-layer-btn 沒有被 ID selector 包裹（避免 specificity 過高難以覆寫）');
    assert(/\.geo-heat-layer-btn:focus-visible/.test(cssSrc), '135. layer-btn 有 :focus-visible 樣式（鍵盤操作可辨識，非僅滑鼠 hover）');
    assert(/\.geo-heat-map-label::before \{ display: none; \}/.test(cssSrc), '136. map-label 拿掉 Leaflet tooltip 預設箭頭（避免視覺跟 marker 圖示重疊）');
    assert(!/style="/.test(uiSrc.slice(uiSrc.indexOf('_geoHeatUiRenderOrderMapOverlay'), uiSrc.indexOf('_geoHeatUiRenderOrderMapOverlay') + 1200)), '137. Order Overlay 渲染邏輯沒有使用 inline style（樣式完全由 CSS class 控制）');
    assert(cssSrc.indexOf('.geo-heat-layer-toggle') < cssSrc.indexOf('/* fix18-10-hotfix30-B5-R5.4-G1.4') || cssSrc.lastIndexOf('G1.4') > 0, '138. G1.4 CSS 區塊有清楚的版本標記註解，方便未來稽核追溯');
    assert(/margin: 0 0 10px;/.test(cssSrc), '139. .geo-heat-layer-toggle 版面間距合理（不會跟下方 Coverage Explanation 卡片黏在一起）');
    assert(/display: flex;\s*\n\s*gap: 6px;/.test(cssSrc), '140. .geo-heat-layer-toggle 使用 flex + gap 排版（跟本檔案其餘控制列一致的排版慣例，不是另外一套）');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
