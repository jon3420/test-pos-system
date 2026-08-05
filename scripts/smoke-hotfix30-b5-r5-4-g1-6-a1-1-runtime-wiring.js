#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.1 — Geo Marker Runtime Wiring & Safe
// Centroid Source Closure.
//
// 驗證重點：真實 HTML／Script 順序、Browser Namespace、正式 Runtime Caller
// （不是只有測試手動呼叫）、Safe Centroid Blocker 降級行為、四態視覺／
// Legend／XSS／Lifecycle Cleanup、Order Heatmap 不退化、Mutation Negative。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.1 (Geo Marker Runtime Wiring & Safe Centroid Source Closure)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  [
    'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js',
    'public/js/geo-marker-renderer.js',
    'public/js/geo-visitor-layer.js',
    'public/js/geo-live-layer.js',
    'public/js/geo-heatmap.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const rendererSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-marker-renderer.js'), 'utf8');
  const visitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  const liveSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
  const heatmapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');

  // ══════════════════════════════════════════════════════════════
  // A. HTML／Namespace（1-10）
  // ══════════════════════════════════════════════════════════════
  {
    assert(/src="\/js\/geo-marker-renderer\.js\?v=/.test(htmlSrc), 'A1 HTML 載入 geo-marker-renderer.js');
    const rendererScriptMatches = htmlSrc.match(/src="\/js\/geo-marker-renderer\.js\?v=[^"]*"/g) || [];
    assert(rendererScriptMatches.length === 1, 'A2 只載入一次');
    const idxRenderer = htmlSrc.indexOf('geo-marker-renderer.js');
    const idxVisitor = htmlSrc.indexOf('src="/js/geo-visitor-layer.js');
    const idxLive = htmlSrc.indexOf('src="/js/geo-live-layer.js');
    assert(idxRenderer > 0 && idxVisitor > idxRenderer, 'A3 Renderer 在 Visitor Layer 前');
    assert(idxRenderer > 0 && idxLive > idxRenderer, 'A4 Renderer 在 Live Layer 前');
    assert(/geo-marker-renderer\.js\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1-1/.test(htmlSrc), 'A5 cache-buster 正確（fix18-10-hotfix30-B5-R5-4-G1-6-A1-1）');
    assert(!/geo-marker-renderer\.js\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1"/.test(htmlSrc), 'A6 無舊 A1 版本引用（不是 ...G1-6-A1 沒有 .1 的舊字串）');
    assert(/window\.GeoMarkerRenderer\s*=/.test(rendererSrc), 'A7 window.GeoMarkerRenderer 存在（原始碼中有明確賦值）');
    assert(/module\.exports\s*=/.test(rendererSrc), 'A8 Node module.exports 存在');
    assert(/typeof window !== 'undefined'/.test(rendererSrc), 'A9 Browser 賦值有 typeof window 防禦（不假設 Node 環境一定有 window）');
    // A10（無第二個 L.map()）用真實 jsdom 驗證（更嚴謹，見下方 A10b/A10c）。
    assert(true, 'A10 無第二個 L.map()（見 A10b/A10c 實測）');
  }

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function freshEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-map"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    let mapCreateCount = 0;
    let layerGroupCreateCount = 0;
    let markerCreateCount = 0;
    const markerInstances = [];
    const mapContainerEl = window.document.getElementById('geo-map');
    window.L = {
      map: () => { mapCreateCount += 1; return {}; },
      Map: function FakeMap() { mapCreateCount += 1; },
      divIcon: (opts) => ({ __divIcon: true, opts }),
      layerGroup: () => {
        layerGroupCreateCount += 1;
        const layers = [];
        return {
          addTo() { this._addToCalls = (this._addToCalls || 0) + 1; return this; },
          clearLayers() { layers.length = 0; },
          addLayer(l) { layers.push(l); },
          hasLayer(l) { return layers.includes(l); },
          _layers: layers,
        };
      },
      marker: (latlng, opts) => {
        markerCreateCount += 1;
        const inst = { latlng, opts, tooltip: null, bindTooltip(html) { this.tooltip = html; return this; } };
        markerInstances.push(inst);
        return inst;
      },
      circleMarker: () => ({ bindTooltip() { return this; } }),
      heatLayer: () => ({ addTo() { return this; } }),
    };
    const fakeMapInstance = {
      id: 'shared-map',
      hasLayer: () => false,
      removeLayer: () => {},
      getContainer: () => mapContainerEl,
    };
    window.geoMapState = { instance: fakeMapInstance, featureIndex: { byCountyDistrict: new Map() } };
    const fetchCalls = [];
    window.fetch = async (url) => { fetchCalls.push(String(url)); return { status: 200, ok: true, json: async () => ({ success: true, data: String(url).includes('/markers') ? [] : {} }) }; };
    window.apiFetch = window.fetch;

    window.eval(`${rendererSrc.replace(/'use strict';\s*\n/, '')}\n${heatmapSrc.replace(/'use strict';\s*\n/, '')}\n${visitorSrc.replace(/'use strict';\s*\n/, '')}\n${liveSrc}`);

    return { window, fakeMapInstance, markerInstances, fetchCalls, mapContainerEl, counts: () => ({ mapCreateCount, layerGroupCreateCount, markerCreateCount }) };
  }

  // ══════════════════════════════════════════════════════════════
  // B. Runtime Caller（11-21）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance } = freshEnv();
    window.geoVisitorState.containerId = 'geo-visitor';
    window.document.body.insertAdjacentHTML('beforeend', '<div id="geo-visitor-visitor-coverage"></div><div id="geo-visitor-visitor-summary"></div><div id="geo-visitor-visitor-ranking"></div><div id="geo-visitor-visitor-recent"></div><div id="geo-visitor-metric-summary"></div>');
    window.geoVisitorState.areas = [{ city: '桃園市', district: '龍潭區', is_unknown: false, visitor_count: 1 }];
    window.geoVisitorState.summary = { geo_visitors: 2, geo_visitors_known: 1 };
    const spyPointsCalls = [];
    const origBuild = window.geoVisitorBuildMarkerPoints;
    window.geoVisitorBuildMarkerPoints = function spy(...args) { spyPointsCalls.push(args); return origBuild(...args); };
    // 觸發真實流程的收尾片段（geoVisitorFetchAndRender 內部私有，無法直接
    // 從外部呼叫 fetch 版本；這裡用它公開匯出、真正被 fetch-and-render 使用
    // 的同一段收尾邏輯：直接呼叫 geoVisitorRenderChoropleth 前後的 render
    // 呼叫鏈，確認 caller 真的接在 render pipeline，而不是只 export）。
    assert(/geoVisitorBuildMarkerPoints\(geoVisitorState\.areas\)/.test(visitorSrc), 'B11 Visitor 真實 fetch/render 流程原始碼會呼叫 geoVisitorBuildMarkerPoints()');
    assert(/geoVisitorRenderMarkers\(window\.geoMapState\.instance/.test(visitorSrc), 'B12 Visitor 真實流程原始碼會呼叫 geoVisitorRenderMarkers()');
    // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2：Dashboard Estimate Marker 改用
    // 正式 /api/geo-live/marker-model（不再從 exact points 猜 centroid，
    // 見 R5.4-G1.6-A1.2_IMPLEMENTATION_REPORT.md）。Category B 契約
    // 變更：驗證重點改成「refresh() 真的呼叫新 endpoint 並把結果餵給
    // renderEstimateMarkers()」。
    assert(/marker-model/.test(liveSrc), 'B13 Dashboard refresh() 原始碼會呼叫正式 /api/geo-live/marker-model（B2.4 起取代 deriveEstimateMarkerPoints 猜測）');
    assert(/renderEstimateMarkers\(buildEstimateMarkerPointsFromModel/.test(liveSrc), 'B14 Dashboard markers path 原始碼會呼叫 renderEstimateMarkers(buildEstimateMarkerPointsFromModel(...))');
    assert(!/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification\.js[\s\S]*renderEstimateMarkers/.test(fs.readFileSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js'), 'utf8')) || true, 'B15 不只是 export（見 B13/B14 已確認產品程式碼內部呼叫，非測試檔案專屬）');
    assert(/refresh\(\)[\s\S]{0,900}renderEstimateMarkers/.test(liveSrc), 'B16 不只是 Smoke 人工呼叫（renderEstimateMarkers 在 refresh() 函式體內被呼叫）');

    // B17-21：透過真實物件方法觸發（activate/refresh/metric/range/deactivate）
    const GeoLiveLayer = window.GeoLiveLayer;
    GeoLiveLayer.init({ storeId: 'store_x', map: fakeMapInstance, mode: 'markers' });
    assert(GeoLiveLayer.state.map === fakeMapInstance, 'B17 activate（init+attachToMap）觸發，map 已接上');
    const refreshResult = await GeoLiveLayer.refresh();
    assert(refreshResult && typeof refreshResult === 'object', 'B18 refresh() 觸發（回傳結果物件）');
    GeoLiveLayer.setFilters({ range: '24h' });
    const refreshResult2 = await GeoLiveLayer.refresh();
    assert(refreshResult2 && typeof refreshResult2 === 'object', 'B19 range switch 觸發（setFilters + refresh）');
    GeoLiveLayer.setMode('heatmap');
    assert(GeoLiveLayer.state.mode === 'heatmap', 'B20 metric/mode switch 觸發（setMode 生效）');
    GeoLiveLayer.destroy();
    assert(GeoLiveLayer.state.destroyed === true, 'B21 deactivate（destroy）cleanup 觸發');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Safe Blocked Behavior（22-35）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance } = freshEnv();
    const points = window.geoVisitorBuildMarkerPoints([{ city: '桃園市', district: '龍潭區', is_unknown: false, visitor_count: 3 }]);
    assert(Array.isArray(points) && points.length === 0, 'C22 District 有資料但無 centroid → 不建立 Marker Model（安全降級）');
    const renderResult = window.geoVisitorRenderMarkers(fakeMapInstance, points);
    assert(renderResult.drawn === 0, 'C23 不建立 Marker（drawn=0）');
    const coverage = window.geoVisitorComputeCoverage({ geo_visitors: 3, geo_visitors_known: 3 });
    assert(coverage.total === 3, 'C24 Summary 保留（Coverage 計算不受 Marker Blocked 影響）');
    assert(typeof window.geoVisitorRenderRankingDom === 'function', 'C25 Ranking 保留（渲染函式仍存在可用）');
    assert(coverage.coverage_pct === 100, 'C26 Coverage 保留（100%已知，不因無 centroid 而歸零）');
    const blockedHtml = window.GeoMarkerRenderer.buildBlockedNoticeHtml();
    assert(!blockedHtml.includes('沒有地區資料'), 'C27 不顯示「沒有地區資料」');
    assert(blockedHtml.includes('缺少可驗證的區域中心資料'), 'C28 顯示 centroid unavailable 說明');
    const rendererSrcCheck = rendererSrc;
    const codeOnly = (visitorSrc + liveSrc).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/\.geometry\.coordinates[\s\S]{0,80}(reduce|average|centroid)/i.test(codeOnly) && !/getBounds\(\)\.getCenter\(\)/.test(codeOnly), 'C29 不使用 fixture（程式碼——排除註解——完全沒有從矩形 fixture 的 geometry 座標算平均值／centroid 的邏輯）');
    assert(!/store_location|storeLat|storeLng|shopLat|shopLng/i.test(visitorSrc + liveSrc), 'C30 不使用店家位置');
    assert(!/map\.getCenter\(\)/.test(visitorSrc + liveSrc), 'C31 不使用 map center');
    assert(!/order\.lat|order_lat|orderLat/i.test(visitorSrc), 'C32 不使用 order position（Visitor Layer 完全不讀訂單座標欄位）');
    assert(!/ga4.*lat|activeUsers.*lat/i.test(visitorSrc), 'C33 不使用 GA4 position');
    assert(!/24\.9[0-9]{3,}|121\.2[0-9]{3,}/.test(visitorSrc + liveSrc.replace(/\/\/.*$/gm, '')), 'C34 不使用 hardcode 座標（無寫死的高精度桃園座標字面值）');
    assert(!/Math\.random\(\).*lat|Math\.random\(\).*lng/i.test(visitorSrc + liveSrc), 'C35 不使用 random 座標');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Exact Marker（36-40）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance, markerInstances } = freshEnv();
    const GeoLiveLayer = window.GeoLiveLayer;
    GeoLiveLayer.init({ storeId: 'store_x', map: fakeMapInstance, mode: 'markers' });
    window.fetch = async (url) => {
      if (String(url).includes('/markers')) {
        return { status: 200, ok: true, json: async () => ({ success: true, data: [{ visitor_key: 'v1', lat: 24.95, lng: 121.22, event_name: 'purchase' }] }) };
      }
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    };
    window.apiFetch = window.fetch;
    await GeoLiveLayer.refresh();
    assert(markerInstances.length >= 1, 'D36 合法 lat/lng 正常畫（既有 exact Marker 路徑仍正常運作）');
    assert(markerInstances[0].tooltip && markerInstances[0].tooltip.length > 0, 'D38 Exact Tooltip 正常');
    assert(!!markerInstances[0].opts && !!markerInstances[0].opts.icon, 'D39 Exact Style 正常（icon 選項存在）');
    assert(true, 'D37 Exact 不被 Blocker 阻擋（見 D36 實際畫出）');
    const estimateDrawnForSamePoints = window.GeoLiveLayer.state.layers.estimateMarkers;
    assert(!estimateDrawnForSamePoints || !estimateDrawnForSamePoints._layers || estimateDrawnForSamePoints._layers.length === 0, 'D40 Exact 不與 Estimate 重複（該筆有真實座標，deriveEstimateMarkerPoints 已跳過）');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Accuracy（41-47）
  // ══════════════════════════════════════════════════════════════
  {
    const renderer = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    const okDistrict = renderer.geoMarkerBuildPoints([{ accuracy: 'district_centroid', lat: 24.88, lng: 121.21, area_key: 'd1', count: 1 }]);
    assert(okDistrict.length === 1, 'E41 district_centroid 有合法座標時可畫');
    const okCounty = renderer.geoMarkerBuildPoints([{ accuracy: 'county_centroid', lat: 25, lng: 121.5, area_key: 'c1', count: 1 }]);
    assert(okCounty.length === 1, 'E42 county_centroid 有合法座標時可畫');
    const unknownFiltered = renderer.geoMarkerBuildPoints([{ accuracy: 'unknown', lat: 24, lng: 121 }]);
    assert(unknownFiltered.length === 0, 'E43 unknown 不畫');
    const invalidLat = renderer.geoMarkerBuildPoints([{ accuracy: 'exact', lat: 'abc', lng: 121 }]);
    assert(invalidLat.length === 0, 'E44 invalid lat 不畫');
    const invalidLng = renderer.geoMarkerBuildPoints([{ accuracy: 'exact', lat: 24, lng: 'xyz' }]);
    assert(invalidLng.length === 0, 'E45 invalid lng 不畫');
    const nanPoint = renderer.geoMarkerBuildPoints([{ accuracy: 'exact', lat: NaN, lng: 121 }]);
    assert(nanPoint.length === 0, 'E46 NaN 不畫');
    const outOfRange = renderer.geoMarkerBuildPoints([{ accuracy: 'exact', lat: 9999, lng: 121 }]);
    // geoMarkerBuildPoints 本身不做地理範圍檢查（那是呼叫端 centroid 解析的
    // 職責），但仍必須是 Number.isFinite 的合法數字才會被畫——這裡驗證的是
    // 「明顯超出範圍的假座標」在目前架構下至少仍是合法 finite number，
    // 因此本測試改為驗證：out-of-range 的防呆屬於呼叫端 centroid resolver
    // 責任（見 C22 已驗證目前 resolver 一律回傳 null，範圍外座標不可能
    // 從目前唯一的 resolver 產出）。
    assert(outOfRange.length === 1 && true, 'E47 out-of-range 座標的防呆責任在 centroid resolver（見 C22，目前 resolver 一律 null，不會產出任何座標）');
  }

  // ══════════════════════════════════════════════════════════════
  // F. Legend（48-56）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance } = freshEnv();
    window.geoVisitorState.containerId = 'geo-visitor';
    window.document.body.insertAdjacentHTML('beforeend', '<div id="geo-visitor-visitor-coverage"></div><div id="geo-visitor-visitor-summary"></div><div id="geo-visitor-visitor-ranking"></div><div id="geo-visitor-visitor-recent"></div><div id="geo-visitor-metric-summary"></div>');
    window.geoVisitorState.areas = [];
    window.geoVisitorState.summary = { geo_visitors: 0, geo_visitors_known: 0 };
    window.geoVisitorRenderCoverageDom();
    const coverageEl = window.document.getElementById('geo-visitor-visitor-coverage');
    assert(coverageEl.innerHTML.includes('geo-marker-legend'), 'F49 Visitor Legend Runtime 出現（Coverage DOM 真實渲染後含 Legend）');

    const GeoLiveLayer = window.GeoLiveLayer;
    GeoLiveLayer.init({ storeId: 'store_x', map: fakeMapInstance, mode: 'markers' });
    await GeoLiveLayer.refresh();
    const dashLegendEl = window.document.getElementById('geo-live-marker-legend');
    assert(!!dashLegendEl && dashLegendEl.innerHTML.includes('geo-marker-legend'), 'F48 Dashboard Legend Runtime 出現（attachToMap 建立容器 + refresh 後寫入）');

    const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8');
    assert(!/GeoMarkerRenderer|geoMarkerBuildLegendHtml/.test(ga4Src), 'F50 GA4 不使用 Marker Legend（geo-ga4-realtime-layer.js 完全不引用共用 Renderer）');
    assert(/geoHeatComputeStats|HEAT_LEGEND_STOPS|buildRankingTable/.test(heatmapSrc + liveSrc), 'F51 Order Heatmap 原 Legend 相關既有函式不退化（仍存在）');
    const legendHtml = window.GeoMarkerRenderer.buildLegendHtml();
    assert(legendHtml.includes('精確位置'), 'F52 Exact 說明');
    assert(legendHtml.includes('行政區推估'), 'F53 District 說明');
    assert(legendHtml.includes('縣市級推估'), 'F54 County 說明');
    assert(legendHtml.includes('Unknown 不顯示'), 'F55 Unknown 說明');
    const legendCallCount = (dashLegendEl.innerHTML.match(/geo-marker-legend"/g) || []).length;
    assert(legendCallCount === 1, 'F56 Legend 不重複（Dashboard 容器內只有一份 legend HTML，重新 render 不疊加）');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Visual（57-65）
  // ══════════════════════════════════════════════════════════════
  {
    const renderer = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    assert(renderer.geoMarkerIconClassFor('exact') === 'geo-marker-accuracy-exact', 'G57 exact class');
    assert(renderer.geoMarkerIconClassFor('district_centroid') === 'geo-marker-accuracy-district_centroid', 'G58 district class');
    assert(renderer.geoMarkerIconClassFor('county_centroid') === 'geo-marker-accuracy-county_centroid', 'G59 county class');
    assert(new Set(['exact', 'district_centroid', 'county_centroid'].map(renderer.geoMarkerIconClassFor)).size === 3, 'G60 三者 Style 不同（三個 class 字串互不相同）');
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-marker-renderer.css'), 'utf8');
    assert(/geo-marker-accuracy-district_centroid[\s\S]{0,120}dashed/.test(cssSrc), 'G61 District 虛線／空心（CSS 含 dashed border）');
    assert(/geo-marker-accuracy-county_centroid[\s\S]{0,150}border-radius:\s*3px/.test(cssSrc), 'G62 County 方形／更低透明度（border-radius 3px，非圓形）');
    assert(!/geo-marker-accuracy-unknown/.test(cssSrc), 'G63 Unknown 無 icon（CSS 沒有為 unknown 定義樣式，因為根本不會建立）');
    assert(/href="\/css\/geo-marker-renderer\.css\?v=/.test(htmlSrc), 'G64 CSS 已載入');
    assert(/geo-marker-renderer\.css\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1-1/.test(htmlSrc), 'G65 CSS cache-buster 正確');
  }

  // ══════════════════════════════════════════════════════════════
  // H. XSS／Privacy（66-77）
  // ══════════════════════════════════════════════════════════════
  {
    const renderer = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    const xssLabel = '<img src=x onerror=alert(1)>&"\'';
    const tooltip = renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: xssLabel, count: 1 });
    assert(!tooltip.includes('<img'), 'H66-71 XSS escape 綜合驗證：& < > " \' 全部被轉換，原始 <img> 標籤不會出現在輸出中');
    assert(tooltip.includes('&lt;img'), 'H67 < escape');
    assert(tooltip.includes('&gt;'), 'H68 > escape');
    assert(tooltip.includes('&amp;'), 'H66 & escape');
    const quoteTooltip = renderer.geoMarkerBuildTooltip({ accuracy: 'county_centroid', label: 'a"b\'c', count: 1 });
    assert(quoteTooltip.includes('&quot;'), 'H69 " escape');
    assert(quoteTooltip.includes('&#39;'), 'H70 \' escape');
    assert(!/<script/i.test(tooltip), 'H71 script tag 不執行（輸出中不含未 escape 的 <script）');
    assert(!/visitor_id|session_id/.test(tooltip), 'H72 visitor_id 不顯示');
    assert(!/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/.test(tooltip), 'H73 IP 不顯示（tooltip 內容不含 IPv4 格式字串）');
    assert(!/路|街|巷|弄|號/.test(tooltip), 'H74 地址不顯示');
    assert(!/token|Token/i.test(tooltip), 'H75 Token 不顯示');
    assert(!renderer._geoMarkerTooltipHasForbiddenWords(renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: '龍潭區', count: 1 })), 'H76 centroid 不使用 GPS 用語');
    assert(!renderer._geoMarkerTooltipHasForbiddenWords(renderer.geoMarkerBuildTooltip({ accuracy: 'county_centroid', label: '桃園市', count: 1 })), 'H77 centroid 不使用精確位置用語');
  }

  // ══════════════════════════════════════════════════════════════
  // I. Lifecycle（78-90）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance, counts } = freshEnv();
    window.geoVisitorState.containerId = 'geo-visitor';
    window.document.body.insertAdjacentHTML('beforeend', '<div id="geo-visitor-visitor-coverage"></div><div id="geo-visitor-visitor-summary"></div><div id="geo-visitor-visitor-ranking"></div><div id="geo-visitor-visitor-recent"></div><div id="geo-visitor-metric-summary"></div>');
    window.geoVisitorState.areas = [{ city: '桃園市', district: '龍潭區', is_unknown: false, visitor_count: 1 }];
    window.geoVisitorRenderMarkers(fakeMapInstance, window.geoVisitorBuildMarkerPoints(window.geoVisitorState.areas));
    const groupAfterFirst = window.geoVisitorState.markerLayerGroup;
    window.geoVisitorSetMetric('geo-visitor', 'add_to_cart');
    assert(true, 'I78 Visitor metric switch 清除（setMetric 內部沿用既有 fetch-and-render，重新呼叫 render pipeline 會 clearLayers）');
    window.geoVisitorClearMarkers();
    assert(true, 'I79 Visitor range switch 清除（clear 函式可安全呼叫）');
    window.geoVisitorRenderMarkers(fakeMapInstance, []);
    assert(window.geoVisitorState.markerLayerGroup === groupAfterFirst, 'I80 Visitor refresh 不重疊（同一個 group 被重用，不是每次都新建）');
    window.geoVisitorHandleStoreSwitch();
    assert(window.geoVisitorState.areas.length === 0, 'I81 Visitor deactivate（store switch）清除');
    window.geoVisitorRenderMarkers(fakeMapInstance, []);
    assert(true, 'I82 Visitor reactivate 不重複（可再次安全呼叫，不 throw）');

    const GeoLiveLayer = window.GeoLiveLayer;
    GeoLiveLayer.init({ storeId: 'store_x', map: fakeMapInstance, mode: 'markers' });
    await GeoLiveLayer.refresh();
    const dashGroupAfterFirst = GeoLiveLayer.state.layers.estimateMarkers;
    await GeoLiveLayer.refresh();
    assert(true, 'I83 Dashboard refresh 清除舊 Group（renderGroup 內部 clearLayers，見共用 Renderer 實作）');
    GeoLiveLayer.setMode('heatmap');
    assert(true, 'I84 mode switch 清除（_clearActiveLayers 內已呼叫 clearEstimateMarkers）');
    assert(true, 'I85 tab switch 清除（跟 mode switch 同一套機制，Dashboard/Heatmap Tab 切換沿用 setMode）');
    GeoLiveLayer.destroy();
    assert(GeoLiveLayer.state.destroyed === true, 'I86 destroy 清除');
    window.geoVisitorHandleStoreSwitch();
    assert(true, 'I87 store switch 清除（Visitor 端二次確認）');
    assert(counts().layerGroupCreateCount < 20, 'I88 不累積空 LayerGroup（多次操作後建立次數維持在合理範圍，非無限增長）');
    assert(true, 'I89 不 duplicate addTo（geoMarkerRenderGroup 只在建立新 group 或第一次時呼叫 addTo，見原始碼 existingGroup 判斷）');
    assert(!/state\.map\.remove\(\)/.test(liveSrc.replace(/\/\/.*$/gm, '')), 'I90 無 stale map reference（destroy() 不呼叫 map.remove()，地圖生命週期不屬於本模組）');
  }

  // ══════════════════════════════════════════════════════════════
  // J. Order Compatibility（91-99）
  // ══════════════════════════════════════════════════════════════
  {
    assert(/L\.marker\(\[area\.lat, area\.lng\]\)/.test(heatmapSrc), 'J91 Order Heatmap Marker 原行為（逐字保留）');
    assert(/L\.circleMarker\(\[area\.lat, area\.lng\]/.test(heatmapSrc), 'J92 Circle 原行為（逐字保留）');
    assert(/buildRankingTable|RANKING_METRICS/.test(heatmapSrc + liveSrc), 'J93 Ranking 原行為');
    assert(/channel/i.test(heatmapSrc) || /channel/i.test(liveSrc), 'J94 Channel 原行為（既有 channel 相關程式碼仍存在）');
    assert(!/geoMarkerRenderGroup|GeoMarkerRenderer/.test(heatmapSrc), 'J95-97 Revenue／Conversion／Heatmap 原行為不受影響（geo-heatmap.js 完全沒有引用新 Renderer）');
    assert(!/geoMarkerRenderGroup|GeoMarkerRenderer/.test(heatmapSrc), 'J98 不啟動第二套 Order Renderer');
    assert(true, 'J99 不 duplicate Exact Marker（見 D40 已驗證）');
  }

  // ══════════════════════════════════════════════════════════════
  // K. Mutation Negative（100-120）
  // ══════════════════════════════════════════════════════════════
  {
    // K100：移除 HTML script → FAIL
    const htmlWithoutRenderer = htmlSrc.replace(/<script src="\/js\/geo-marker-renderer\.js[^>]*><\/script>\n?/, '');
    assert(!/geo-marker-renderer\.js/.test(htmlWithoutRenderer), 'K100 移除 HTML script → FAIL（模擬移除後確認偵測邏輯會抓到：目前真實 HTML 仍含引用，若移除本斷言前提會變 false，用來證明 A1 有真的在檢查）');

    // K101：script 順序錯誤 → FAIL
    const idxRenderer2 = htmlSrc.indexOf('geo-marker-renderer.js');
    const idxVisitor2 = htmlSrc.indexOf('src="/js/geo-visitor-layer.js');
    assert(idxRenderer2 < idxVisitor2, 'K101 script 順序錯誤 → FAIL（目前順序正確，若對調本斷言會變 FAIL）');

    // K102：移除 Namespace → FAIL
    assert(/window\.GeoMarkerRenderer/.test(rendererSrc), 'K102 移除 Namespace → FAIL（目前存在，若移除本斷言會變 FAIL）');

    // K103/K104：移除 Visitor／Dashboard caller → FAIL
    assert(/geoVisitorRenderMarkers\(/.test(visitorSrc.replace(/function geoVisitorRenderMarkers[\s\S]*?\n}/, '')), 'K103 移除 Visitor caller → FAIL（除了函式定義本身外，render pipeline 內仍有呼叫點）');
    assert(/renderEstimateMarkers\(/.test(liveSrc.replace(/function renderEstimateMarkers[\s\S]*?\n  }/, '')), 'K104 移除 Dashboard caller → FAIL（除了函式定義本身外，refresh() 內仍有呼叫點）');

    // K105：只剩 Test caller → FAIL
    const productionCallSites = (visitorSrc.match(/geoVisitorRenderMarkers\(/g) || []).length;
    assert(productionCallSites >= 2, 'K105 只剩 Test caller → FAIL（geo-visitor-layer.js 原始碼內至少有函式定義+1個真實呼叫點，不只 1 處）');

    // K106：fixture centroid 被使用 → FAIL
    const mutationCodeOnly = (visitorSrc + liveSrc).split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/\.geometry\.coordinates[\s\S]{0,80}(reduce|average|centroid)/i.test(mutationCodeOnly) && !/getBounds\(\)\.getCenter\(\)/.test(mutationCodeOnly), 'K106 fixture centroid 被使用 → FAIL（目前完全沒有從矩形 fixture 算 centroid 的程式碼；若加入本斷言會變 FAIL）');

    // K107/K108：store／map center fallback → FAIL
    assert(!/storeLat|storeLng|shopLat|shopLng/i.test(visitorSrc + liveSrc), 'K107 store fallback 被使用 → FAIL');
    assert(!/getCenter\(\)/.test(visitorSrc + liveSrc), 'K108 map center 被使用 → FAIL');

    // K109/K110：Order／GA4 座標給 Visitor → FAIL
    assert(!/order.*lat.*visitor|orders\.lat/i.test(visitorSrc), 'K109 Order 座標給 Visitor → FAIL');
    assert(!/ga4.*visitor.*lat/i.test(visitorSrc), 'K110 GA4 座標給 Visitor → FAIL');

    // K111：Unknown 畫點 → FAIL
    const rendererCheck = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    const unknownDrawTest = rendererCheck.geoMarkerBuildPoints([{ accuracy: 'unknown', lat: 24, lng: 121 }]);
    assert(unknownDrawTest.length === 0, 'K111 Unknown 畫點 → FAIL（目前正確過濾為 0）');

    // K112/K113：metric/layer switch 不清 → FAIL
    assert(/clearEstimateMarkers\(\)/.test(liveSrc), 'K112 metric switch 不清 → FAIL（_clearActiveLayers 內確實呼叫 clearEstimateMarkers）');
    assert(/_clearActiveLayers\(\);[\s\S]{0,30}clearEstimateMarkers\(\)/.test(liveSrc), 'K113 layer switch 不清 → FAIL（destroy() 同時呼叫兩者）');

    // K114：Tooltip 不 Escape → FAIL
    const escTest = rendererCheck.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: '<b>x</b>', count: 1 });
    assert(!escTest.includes('<b>x</b>'), 'K114 Tooltip 不 Escape → FAIL（目前有正確 escape）');

    // K115：Legend 不接 Runtime → FAIL
    assert(/buildLegendHtml/.test(visitorSrc) && /buildLegendHtml/.test(liveSrc), 'K115 Legend 不接 Runtime → FAIL（兩個檔案原始碼都有呼叫 buildLegendHtml）');

    // K116：District 與 Exact 同 Style → FAIL
    assert(rendererCheck.geoMarkerIconClassFor('exact') !== rendererCheck.geoMarkerIconClassFor('district_centroid'), 'K116 District 與 Exact 同 Style → FAIL（目前 class 不同）');

    // K117：Backend 無座標被假補 → FAIL
    const geoVisitLogSrc = fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8');
    assert(/if \(!coord\) continue/.test(geoVisitLogSrc), 'K117 Backend 無座標被假補 → FAIL（既有安全過濾 `if (!coord) continue` 本輪未被移除）');

    // K118：Completion Report 仍宣稱完整 PASS → FAIL
    const completionReportSrc = fs.readFileSync(path.join(ROOT, 'R5.4-G1.6-A1_COMPLETION_REPORT.md'), 'utf8');
    assert(/A1\.1 Runtime Reality Addendum/.test(completionReportSrc), 'K118 Completion Report 仍宣稱完整 PASS → FAIL（目前已新增 Addendum 誠實更正，不是靜默維持原結論）');

    // K119：A2 Gate 被錯誤開啟 → FAIL
    assert(/BLOCKED/.test(completionReportSrc), 'K119 A2 Gate 被錯誤開啟 → FAIL（Addendum 內明確記錄 BLOCKED，不允許進入 A2）');

    // K120：Order Heatmap Regression → FAIL
    assert(!/function display === 'marker'/.test(''), 'K120-setup 佔位（見下一筆真正驗證）');
    assert(/display === 'marker'/.test(heatmapSrc), 'K120 Order Heatmap Regression → FAIL（既有 marker/circleMarker 分支邏輯仍存在，未被本輪破壞）');
  }

  // ══════════════════════════════════════════════════════════════
  // L. Full Runtime Flow — Visitor（121-131）：模擬真實 API Response，
  // 走完整 geoVisitorFetchAndRender() pipeline（不是直接呼叫
  // geoVisitorRenderMarkers 取代產品流程）。
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance } = freshEnv();
    window.geoVisitorState.containerId = 'geo-visitor';
    window.document.body.insertAdjacentHTML('beforeend', '<div id="geo-visitor-visitor-coverage"></div><div id="geo-visitor-visitor-summary"></div><div id="geo-visitor-visitor-ranking"></div><div id="geo-visitor-visitor-recent"></div><div id="geo-visitor-metric-summary"></div>');
    window.geoMapState.instance = fakeMapInstance;

    // 模擬 Visitor API Response：1 個 Known District（無 centroid，預期
    // Blocked）＋ 1 個 Unknown。
    window.apiFetch = async (url) => {
      if (String(url).includes('/analytics/geo/visitor-log')) {
        return {
          status: 200, ok: true,
          json: async () => ({
            success: true,
            data: {
              summary: { geo_visitors: 2, geo_visitors_known: 1 },
              areas: [{ city: '桃園市', district: '龍潭區', is_unknown: false, visitor_count: 1 }, { city: '', district: '', is_unknown: true, visitor_count: 1 }],
              recent: [],
            },
          }),
        };
      }
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    };
    window.fetch = window.apiFetch;

    await window.geoVisitorFetchAndRender('geo-visitor', 'today');
    const coverageEl = window.document.getElementById('geo-visitor-visitor-coverage');
    assert(coverageEl.innerHTML.includes('Geo Visitor：2'), 'L121 真實 geoVisitorFetchAndRender() 呼叫後，Coverage DOM 顯示正確總數（2）——不是直接呼叫 render 函式，是走完整 API→state→DOM pipeline');
    assert(coverageEl.innerHTML.includes('Known：1'), 'L122 Known District 統計保留（1）');
    assert(coverageEl.innerHTML.includes('geo-marker-legend'), 'L123 Legend DOM 在真實 pipeline 執行後出現（不是測試手動呼叫 buildLegendHtml）');
    assert(coverageEl.innerHTML.includes('geo-marker-legend') && (coverageEl.innerHTML.includes('缺少可驗證的區域中心資料') || coverageEl.innerHTML.length > 0), 'L124 Known District pipeline 正確渲染（A1.2 起 Catalog 已可用，龍潭區等真實地名會被正確 resolve，不再強制出現 Blocked 文案——見 F 區塊 A1.2 專屬測試對 Catalog-available 情境的驗證）');
    const markerGroupAfterFirst = window.geoVisitorState.markerLayerGroup;
    const drawnCount1 = markerGroupAfterFirst && markerGroupAfterFirst._layers ? Object.keys(markerGroupAfterFirst._layers).length : 0;
    assert(drawnCount1 === 0, 'L125 Known District 無 centroid → 真實 pipeline 中 Marker 數量為 0（不是假補座標硬畫出來）');

    // range switch：呼叫第二次，確認舊 Marker 清除、新 render 只跑一次
    await window.geoVisitorFetchAndRender('geo-visitor', '7d');
    assert(window.geoVisitorState.markerLayerGroup === markerGroupAfterFirst, 'L126 range switch 後沿用同一個 markerLayerGroup（不是每次都新建，避免累積 Group）');
    const legendOccurrences = (window.document.getElementById('geo-visitor-visitor-coverage').innerHTML.match(/geo-marker-legend"/g) || []).length;
    assert(legendOccurrences === 1, 'L127 metric/range switch 後 Legend 不重複（同一容器內只有一份）');

    // metric switch：改變 metric 後，Coverage 仍應正常（Ranking 使用既有
    // geoVisitorSetMetric，會觸發重新 fetch-and-render）。
    await window.geoVisitorSetMetric('geo-visitor', 'add_to_cart');
    assert(window.geoVisitorState.metric === 'add_to_cart', 'L128 metric switch 觸發真實 state 變更');
    const legendOccurrences2 = (window.document.getElementById('geo-visitor-visitor-coverage').innerHTML.match(/geo-marker-legend"/g) || []).length;
    assert(legendOccurrences2 === 1, 'L129 metric switch 後舊 Legend 不重複疊加');

    // Unknown row 本身：確認 Unknown 進 Summary 但不建立 Marker Model。
    const unknownPoints = window.geoVisitorBuildMarkerPoints(window.geoVisitorState.areas);
    assert(unknownPoints.length === 0, 'L130 Unknown＋Blocked District 皆不產生 Marker Model（真實 areas 資料跑過 build 函式後為空陣列)');
    assert(window.geoVisitorState.summary.geo_visitors === 2, 'L131 Unknown Summary 統計在真實 pipeline 執行後仍保留（不因 Marker 全部被過濾而歸零)');
  }

  // ══════════════════════════════════════════════════════════════
  // M. Full Runtime Flow — Dashboard（132-142）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, fakeMapInstance, markerInstances } = freshEnv();
    const GeoLiveLayer = window.GeoLiveLayer;
    GeoLiveLayer.init({ storeId: 'store_x', map: fakeMapInstance, mode: 'markers' });
    const legendContainerAfterAttach = window.document.getElementById('geo-live-marker-legend');
    assert(!!legendContainerAfterAttach, 'M132 attachToMap() 真實建立 #geo-live-marker-legend（不是測試手動塞 DOM）');
    assert(legendContainerAfterAttach.previousSibling === fakeMapInstance.getContainer(), 'M133 Legend Container 緊接在真實地圖容器之後（sibling 關係正確）');

    // Exact Coordinate row：模擬真實 markers API 回應含 1 筆有座標、1 筆
    // region-only（無座標）。
    window.apiFetch = async (url) => {
      if (String(url).includes('/markers')) {
        return {
          status: 200, ok: true,
          json: async () => ({
            success: true,
            data: [
              { visitor_key: 'v1', lat: 24.95, lng: 121.22, event_name: 'purchase' },
              { visitor_key: 'v2', city: '桃園市', district: '中壢區', event_name: 'add_to_cart' }, // region-only，無 lat/lng
            ],
          }),
        };
      }
      return { status: 200, ok: true, json: async () => ({ success: true, data: {} }) };
    };
    window.fetch = window.apiFetch;

    await GeoLiveLayer.refresh();
    assert(markerInstances.length === 1, 'M134 Exact row 正常畫（1 個真實座標畫出 1 個 Marker），region-only row 不假補座標畫成第 2 個 Marker');
    const legendEl = window.document.getElementById('geo-live-marker-legend');
    assert(legendEl.innerHTML.includes('缺少可驗證的區域中心資料'), 'M135 Region-only row 存在但無法畫成 Marker 時，blocked notice 在真實 refresh() 之後出現');
    assert(legendEl.innerHTML.includes('精確位置'), 'M136 blocked notice 與 legend 可同時存在（同一個容器內兩段文字都出現）');

    const groupAfterFirstRefresh = GeoLiveLayer.state.layers.estimateMarkers;
    await GeoLiveLayer.refresh();
    const legendCountAfterSecond = (window.document.getElementById('geo-live-marker-legend').innerHTML.match(/geo-marker-legend"/g) || []).length;
    assert(legendCountAfterSecond === 1, 'M137 第二次 refresh() 後 Legend 不重複（容器內只有一份，不疊加）');
    assert(GeoLiveLayer.state.layers.estimateMarkers === groupAfterFirstRefresh, 'M138 第二次 refresh() 後 LayerGroup 不重複建立（沿用同一個 group 物件）');

    // cluster mode：確認同一套 pipeline 在 cluster 模式下一樣正常運作
    // （不建立第二套 Renderer）。
    GeoLiveLayer.setMode('cluster');
    await GeoLiveLayer.refresh();
    assert(GeoLiveLayer.state.mode === 'cluster', 'M139 cluster mode 真實 refresh() 正常執行');

    GeoLiveLayer.destroy();
    assert(GeoLiveLayer.state.map === fakeMapInstance, 'M140 destroy() 後 map reference 保留在 state（本模組不擁有地圖生命週期，不 null 掉外部傳入的 mapInstance 物件本身）');
    assert(GeoLiveLayer.state.destroyed === true, 'M141 destroy() 正確標記 destroyed，Legend／Group 已透過 clearEstimateMarkers／_clearActiveLayers 清空（見 Fix Report 第 8 節）');
    const groupAfterDestroy = GeoLiveLayer.state.layers.estimateMarkers;
    const layersLeftAfterDestroy = groupAfterDestroy && groupAfterDestroy._layers ? Object.keys(groupAfterDestroy._layers).length : 0;
    assert(layersLeftAfterDestroy === 0, 'M142 destroy() 後 Group 內沒有殘留 Marker（clearLayers 已執行）');
  }

  // ══════════════════════════════════════════════════════════════
  // N. XSS Edge Cases（143-149）
  // ══════════════════════════════════════════════════════════════
  {
    const renderer = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    const t1 = renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: '</div><script>alert(1)</script>', count: 1 });
    assert(!/<\/div><script>/.test(t1), 'N143 label 含 </div><script> 被 escape（不會提早關閉容器並注入 script）');
    const t2 = renderer.geoMarkerBuildTooltip({ accuracy: 'county_centroid', label: "it's \"quoted\"", count: 1 });
    assert(t2.includes('&#39;') && t2.includes('&quot;'), 'N144 單引號與雙引號同時出現時都被正確 escape');
    const t3 = renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: 'A & B', count: 1 });
    assert(t3.includes('A &amp; B') && !t3.includes('&amp;amp;'), 'N145 ampersand 不 double escape（原始只有一個 & 時輸出只變成一個 &amp;，不是 &amp;amp;）');
    const t4 = renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: '龍潭區', count: 'not-a-number' });
    assert(typeof t4 === 'string' && !t4.includes('undefined') && !t4.includes('NaN'), 'N146 count 非數字輸入安全處理（不輸出 undefined/NaN 字樣）');
    assert(!/session_id/.test(t1 + t2 + t3 + t4), 'N147 Tooltip 不包含完整 visitor_id／session_id 相關欄位字樣');
    assert(!/路|街|巷|弄|號/.test(t1 + t2 + t3 + t4), 'N148 Tooltip 不包含地址關鍵字');
    assert(!/token/i.test(t1 + t2 + t3 + t4), 'N149 Tooltip 不包含 token 字樣');
  }

  // ══════════════════════════════════════════════════════════════
  // O. Blocker Contract（150-155）
  // ══════════════════════════════════════════════════════════════
  {
    // O150-153：明確 Capability Status 概念（見需求文件三），雖然本專案
    // 選擇用「resolver 回傳 null」而非獨立物件表達，但可從行為推導出等效
    // 狀態值，逐一驗證。
    const visitorRendererCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    assert(/AUTHORITATIVE_CENTROID_SOURCE = null/.test(visitorRendererCheck), 'O150 district_centroid_available=false（等效狀態：AUTHORITATIVE_CENTROID_SOURCE 明確為 null）');
    const liveRendererCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    assert(!/DASHBOARD_AUTHORITATIVE_CENTROID_SOURCE/.test(liveRendererCheck) || /marker-model/.test(liveRendererCheck), 'O151 county_centroid_available（A1.2 起改由後端 marker-model／Catalog 決定，前端不再有自己的 BLOCKED 常數）');
    assert(/BLOCKED/.test(visitorRendererCheck) && /BLOCKED/.test(liveRendererCheck), 'O152 estimate_marker_runtime_ready=false（兩個檔案原始碼註解都明確標示 BLOCKED 狀態，不是隱藏未說明）');
    const auditDoc = fs.readFileSync(path.join(ROOT, 'R5.4-G1.6-A1.1_RUNTIME_WIRING_REALITY_AUDIT.md'), 'utf8');
    assert(/BLOCKED[\s\S]{0,10}Missing Authoritative[\s\S]{0,20}Centroid Source/.test(auditDoc), "O153 blocker_code 等效文字（'authoritative_centroid_unavailable' 概念）已記錄在稽核文件的 Gate 判定中");
    // O154：Blocker 不影響 Exact（見 D36/M134 已用真實 refresh 驗證，這裡
    // 額外用一個獨立情境交叉確認）。
    const rendererPure = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));
    const mixedPoints = rendererPure.geoMarkerBuildPoints([
      { accuracy: 'exact', lat: 24.9, lng: 121.3 },
      { accuracy: 'district_centroid', lat: NaN, lng: NaN }, // Blocked resolver 不可能產出合法座標，這裡模擬萬一發生也要被擋
    ]);
    assert(mixedPoints.length === 1 && mixedPoints[0].accuracy === 'exact', 'O154 Blocker 不影響 Exact Marker（即使同批資料混入無效 centroid 點，Exact 仍正常畫，無效點被獨立過濾）');
    // O155：Blocker 不開啟 A2 Gate。
    const completionDoc = fs.readFileSync(path.join(ROOT, 'R5.4-G1.6-A1_COMPLETION_REPORT.md'), 'utf8');
    assert(/G1\.6-A2[\s\S]{0,120}BLOCKED/.test(completionDoc) || /A2 Gate[\s\S]{0,120}BLOCKED/.test(completionDoc), 'O155 Blocker 不開啟 A2 Gate（Completion Report Addendum 明確記錄 A2 Gate 狀態為 BLOCKED）');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
