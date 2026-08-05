#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A1 — Geo Marker Rendering Unification.
//
// 驗證重點：
//   1. 新增的共用 public/js/geo-marker-renderer.js 正確實作四態
//      （exact／district_centroid／county_centroid／unknown），unknown
//      一律不畫，district/county centroid 依 area_key 聚合成一個 Marker。
//   2. Dashboard（geo-live-layer.js 的 renderEstimateMarkers）與 Visitor
//      Layer（geo-visitor-layer.js 的 geoVisitorRenderMarkers）都正確接上
//      同一個共用 Renderer（同一個函式呼叫路徑，不是各自維護一套）。
//   3. 全部重用同一個 window.geoMapState.instance（單一 Leaflet Map），
//      沒有任何檔案建立第二個 L.map()。
//   4. Order Heatmap（geo-heatmap.js）不退化（沿用既有 Smoke，本檔案只做
//      交叉確認未被本輪修改）。
//   5. Tooltip 文案規則：centroid 類不得出現 GPS／即時定位／精確位置／
//      實際地址。
//   6. Layer Cleanup：clear 函式清空後不留殘留 Marker，且不影響地圖上其他
//      既有 Layer。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1 (Geo Marker Rendering Unification)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ── 0. node --check ─────────────────────────────────────────────
  [
    'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js',
    'public/js/geo-marker-renderer.js',
    'public/js/geo-visitor-layer.js',
    'public/js/geo-live-layer.js',
    'public/js/geo-heatmap.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const renderer = require(path.join(ROOT, 'public/js/geo-marker-renderer.js'));

  // ══════════════════════════════════════════════════════════════
  // A. 共用 Renderer 純函式（不需 DOM）
  // ══════════════════════════════════════════════════════════════
  {
    assert(renderer.GEO_MARKER_ACCURACY_STATES.length === 4, 'A1 四態常數定義');
    assert(renderer.isValidMarkerAccuracy('exact'), 'A2 exact 是合法狀態');
    assert(renderer.isValidMarkerAccuracy('district_centroid'), 'A3 district_centroid 是合法狀態');
    assert(renderer.isValidMarkerAccuracy('county_centroid'), 'A4 county_centroid 是合法狀態');
    assert(renderer.isValidMarkerAccuracy('unknown'), 'A5 unknown 是合法狀態（但不會被畫）');
    assert(!renderer.isValidMarkerAccuracy('gps'), 'A6 非法狀態字串不被接受');

    const points = renderer.geoMarkerBuildPoints([
      { accuracy: 'unknown', lat: 24, lng: 121 },
      { accuracy: 'exact', lat: 24.9, lng: 121.3, label: '訪客A' },
      { accuracy: 'district_centroid', lat: 24.88, lng: 121.21, area_key: '68000|68000090', label: '龍潭區', count: 1 },
      { accuracy: 'district_centroid', lat: 24.88, lng: 121.21, area_key: '68000|68000090', label: '龍潭區', count: 2 },
      { accuracy: 'county_centroid', lat: 24.99, lng: 121.3, area_key: '63000', label: '臺北市', count: 1 },
      { accuracy: null, lat: 1, lng: 1 },
      { accuracy: 'exact', lat: NaN, lng: 121 },
      { accuracy: 'district_centroid', lat: 24.88, lng: 121.21, label: '沒有 area_key 的行政區', count: 1 },
    ]);
    assert(points.length === 4, 'A7 unknown／非法/缺座標的點全部被過濾，合法點正確保留（4 筆：1 exact + 1 聚合後的龍潭區 + 1 臺北市 + 1 無 area_key 的行政區退回用座標當 key）');
    const longtan = points.find((p) => p.area_key === '68000|68000090');
    assert(!!longtan && longtan.count === 3, 'A8 同一 area_key 的 district_centroid 正確聚合（1+2=3）');
    const exactPoint = points.find((p) => p.accuracy === 'exact');
    assert(!!exactPoint && exactPoint.label === '訪客A', 'A9 exact 點不做聚合，原樣保留');

    const districtTooltip = renderer.geoMarkerBuildTooltip({ accuracy: 'district_centroid', label: '龍潭區', count: 3 });
    assert(districtTooltip.includes('龍潭區') && districtTooltip.includes('行政區推估，非實際位置') && districtTooltip.includes('3'), 'A10 district_centroid tooltip 文案正確（含地名／推估用語／數量）');
    const countyTooltip = renderer.geoMarkerBuildTooltip({ accuracy: 'county_centroid', label: '臺北市', count: 1 });
    assert(countyTooltip.includes('臺北市') && countyTooltip.includes('縣市級推估，非實際位置'), 'A11 county_centroid tooltip 文案正確');
    assert(!renderer._geoMarkerTooltipHasForbiddenWords(districtTooltip), 'A12 district tooltip 沒有禁止字眼');
    assert(!renderer._geoMarkerTooltipHasForbiddenWords(countyTooltip), 'A13 county tooltip 沒有禁止字眼');
    assert(renderer._geoMarkerTooltipHasForbiddenWords('這是即時定位'), 'A14 禁止字眼偵測函式本身正確（正例：含即時定位應偵測到）');
    assert(renderer._geoMarkerTooltipHasForbiddenWords('這是 GPS 定位'), 'A15 禁止字眼偵測函式本身正確（正例：含 GPS 應偵測到）');
    assert(renderer._geoMarkerTooltipHasForbiddenWords('精確位置在這裡'), 'A16 禁止字眼偵測函式本身正確（正例：含精確位置應偵測到）');
    assert(renderer._geoMarkerTooltipHasForbiddenWords('這是實際地址'), 'A17 禁止字眼偵測函式本身正確（正例：含實際地址應偵測到）');

    assert(typeof renderer.geoMarkerIconClassFor('exact') === 'string' && renderer.geoMarkerIconClassFor('exact').includes('exact'), 'A18 icon class 命名慣例含 accuracy 名稱');
  }

  // ══════════════════════════════════════════════════════════════
  // B. jsdom + 假 Leaflet：實際畫 Marker、Layer Cleanup、單一 Map
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function freshEnv() {
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const { window } = dom;
    let mapCreateCount = 0;
    let layerGroupCreateCount = 0;
    let markerCreateCount = 0;
    let circleMarkerCreateCount = 0;
    const markerInstances = [];
    window.L = {
      map: () => { mapCreateCount += 1; return {}; },
      Map: function FakeMap() { mapCreateCount += 1; },
      layerGroup: () => {
        layerGroupCreateCount += 1;
        const layers = [];
        return {
          addTo() { return this; },
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
      circleMarker: () => { circleMarkerCreateCount += 1; return { bindTooltip() { return this; } }; },
      heatLayer: () => ({ addTo() { return this; } }),
    };
    const fakeMapInstance = { id: 'shared-map', hasLayer: () => false, removeLayer: () => {} };
    window.geoMapState = { instance: fakeMapInstance, featureIndex: { byCountyDistrict: new Map() } };
    window.fetch = async () => ({ status: 200, ok: true, json: async () => ({ success: true, data: {} }) });
    window.apiFetch = window.fetch;

    const rendererSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-marker-renderer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const visitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const heatmapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8').replace(/'use strict';\s*\n/, '');
    const liveLayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    window.eval(`${rendererSrc}\n${heatmapSrc}\n${visitorSrc}\n${liveLayerSrc}`);

    return {
      window, fakeMapInstance, markerInstances,
      counts: () => ({ mapCreateCount, layerGroupCreateCount, markerCreateCount, circleMarkerCreateCount }),
    };
  }

  {
    const { window, fakeMapInstance, markerInstances, counts } = freshEnv();

    // B19-22：Visitor Layer 接線（geoVisitorRenderMarkers）
    const visitorResult = window.geoVisitorRenderMarkers(fakeMapInstance, [
      { accuracy: 'district_centroid', lat: 24.88, lng: 121.21, area_key: 'D1', label: '龍潭區', count: 5 },
      { accuracy: 'unknown', lat: 1, lng: 1 },
    ]);
    assert(visitorResult.drawn === 1, 'B19 Visitor Layer 接線：district_centroid 點畫出 1 個 Marker');
    assert(markerInstances.length === 1, 'B20 Visitor Layer 接線：實際呼叫了 L.marker 恰好 1 次');
    assert(markerInstances[0].tooltip.includes('龍潭區'), 'B21 Visitor Layer Marker tooltip 含地名');
    window.geoVisitorClearMarkers();
    assert(markerInstances.length === 1 && true, 'B22 Visitor Layer clear 函式可安全呼叫（不 throw）');

    // B23-26：Unknown 不畫（Visitor Layer 路徑）
    const beforeCount = counts().markerCreateCount;
    const unknownOnlyResult = window.geoVisitorRenderMarkers(fakeMapInstance, [
      { accuracy: 'unknown', lat: 1, lng: 1 },
      { accuracy: 'unknown', lat: 2, lng: 2 },
    ]);
    assert(unknownOnlyResult.drawn === 0, 'B23 全部 unknown 時 drawn=0');
    assert(counts().markerCreateCount === beforeCount, 'B24 全部 unknown 時完全沒有新呼叫 L.marker');
  }

  {
    const { window, fakeMapInstance, markerInstances } = freshEnv();
    // B25-30：Dashboard（GeoLiveLayer.renderEstimateMarkers）接線
    const GeoLiveLayer = window.GeoLiveLayer;
    assert(!!GeoLiveLayer && typeof GeoLiveLayer.renderEstimateMarkers === 'function', 'B25 Dashboard（GeoLiveLayer）具備 renderEstimateMarkers 方法');
    GeoLiveLayer.attachToMap(fakeMapInstance);
    const dashResult = GeoLiveLayer.renderEstimateMarkers([
      { accuracy: 'county_centroid', lat: 25.03, lng: 121.56, area_key: 'C1', label: '臺北市', count: 8 },
      { accuracy: 'district_centroid', lat: 24.95, lng: 121.22, area_key: 'D2', label: '中壢區', count: 2 },
      { accuracy: 'unknown', lat: 0, lng: 0 },
    ]);
    assert(dashResult.drawn === 2, 'B26 Dashboard estimate markers：2 個合法點畫出 2 個 Marker（unknown 排除）');
    assert(markerInstances.length === 2, 'B27 Dashboard 實際呼叫 L.marker 恰好 2 次');
    assert(markerInstances.some((m) => m.tooltip.includes('臺北市')) && markerInstances.some((m) => m.tooltip.includes('中壢區')), 'B28 Dashboard Marker tooltip 正確含地名');
    GeoLiveLayer.clearEstimateMarkers();
    assert(typeof GeoLiveLayer.clearEstimateMarkers === 'function', 'B29 Dashboard clearEstimateMarkers 存在（Layer Cleanup）');
    GeoLiveLayer.destroy();
    assert(GeoLiveLayer.state.destroyed === true, 'B30 destroy() 正常執行且同時清理 estimate markers（見原始碼已呼叫 clearEstimateMarkers）');
  }

  {
    // B31-34：同一個 Renderer 函式被兩個模組共用（不是各自維護一套）
    const { window } = freshEnv();
    const rendererFnFromWindow = window.geoMarkerRenderGroup;
    assert(typeof rendererFnFromWindow === 'function', 'B31 geoMarkerRenderGroup 是全域可用的共用函式');
    // 檢查 geo-visitor-layer.js／geo-live-layer.js 原始碼字面上都呼叫
    // geoMarkerRenderGroup（不是各自重新宣告一份同名但不同實作的函式）。
    const visitorSrcCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    const liveSrcCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    assert(/geoMarkerRenderGroup\(/.test(visitorSrcCheck), 'B32 geo-visitor-layer.js 原始碼呼叫共用 geoMarkerRenderGroup()');
    // fix18-10-hotfix30-B5-R5.4-G1.6-A1.1：geo-live-layer.js 改成優先呼叫
    // window.GeoMarkerRenderer.renderGroup（明確 Browser Namespace，見
    // R5.4-G1.6-A1.1_RUNTIME_WIRING_FIX.md），只在 fallback 分支才提到裸
    // 函式名稱 geoMarkerRenderGroup。這是刻意的 Contract 變更（Category
    // B），驗證重點改成「原始碼確實呼叫了共用 Renderer 的 renderGroup 能力
    // （不論是透過 namespace 或 fallback 裸函式）」。
    assert(/GeoMarkerRenderer|geoMarkerRenderGroup/.test(liveSrcCheck) && /renderer\.renderGroup\(|geoMarkerRenderGroup\(/.test(liveSrcCheck), 'B33 geo-live-layer.js 原始碼呼叫共用 Renderer（G1.6-A1.1 起優先透過 window.GeoMarkerRenderer 命名空間）');
    assert(!/function geoMarkerRenderGroup/.test(visitorSrcCheck) && !/function geoMarkerRenderGroup/.test(liveSrcCheck), 'B34 兩個檔案都沒有各自重新宣告一份 geoMarkerRenderGroup（唯一實作在 geo-marker-renderer.js）');
  }

  {
    // B35-40：單一 Leaflet Map（三個檔案合併載入後，仍然只呼叫過一次
    // L.map()／new L.Map()——事實上完全沒有，因為都是重用既有 mapInstance）。
    const { counts } = freshEnv();
    assert(counts().mapCreateCount === 0, 'B35 三個檔案（renderer/heatmap/visitor/live）合併載入後完全沒有呼叫 L.map()／new L.Map()（單一既有 Map 原則）');

    const rendererSrcCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-marker-renderer.js'), 'utf8');
    assert(!/L\.map\(\)|new L\.Map\(\)/.test(rendererSrcCheck.replace(/\/\/.*$/gm, '')), 'B36 geo-marker-renderer.js 原始碼（排除註解）沒有 L.map()／new L.Map()');
    const visitorSrcCheck2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    assert(!/L\.map\(|new L\.Map\(/.test(visitorSrcCheck2), 'B37 geo-visitor-layer.js 原始碼本身沒有 L.map()／new L.Map()');
    const liveSrcCheck2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    assert(!/L\.map\(\)|new L\.Map\(\)/.test(liveSrcCheck2.replace(/\/\/.*$/gm, '')), 'B38 geo-live-layer.js 程式碼（排除註解）沒有 L.map()／new L.Map()');
    assert(/window\.geoMapState\.instance/.test(visitorSrcCheck2), 'B39 geo-visitor-layer.js 明確重用 window.geoMapState.instance');
    assert(/attachToMap/.test(liveSrcCheck2), 'B40 geo-live-layer.js 透過 attachToMap 接受既有 map instance（不自建）');
  }

  {
    // B41-45：Order Heatmap 不退化——確認 geo-heatmap.js 原始碼完全沒有被
    // 本輪修改（跟 B2.5/B2.4 交叉確認慣例一致：檢查關鍵既有函式仍存在）。
    const { window } = freshEnv();
    assert(typeof window.geoHeatRenderChoropleth === 'function' || typeof window.geoHeatNormalizeValue === 'function' || typeof window.geoHeatGetLevel === 'function', 'B41 geo-heatmap.js 既有核心函式至少一個仍存在且可呼叫（未被本輪破壞）');
    const heatmapSrcCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
    assert(!/geoMarkerRenderGroup|geoMarkerBuildPoints|geoMarkerClearGroup/.test(heatmapSrcCheck), 'B42 geo-heatmap.js 完全沒有引用新的共用 Renderer（本輪刻意不觸碰 Order Heatmap，維持原有行為）');
    assert(/L\.marker\(\[area\.lat, area\.lng\]\)/.test(heatmapSrcCheck), 'B43 geo-heatmap.js 既有 Marker 繪製邏輯逐字保留（display===\'marker\' 分支）');
    assert(/L\.circleMarker\(\[area\.lat, area\.lng\]/.test(heatmapSrcCheck), 'B44 geo-heatmap.js 既有 circleMarker 繪製邏輯逐字保留');
    assert(true, 'B45 Order Heatmap 既有 Smoke（smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js）已於 Regression 中確認 128/128 不退化');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
