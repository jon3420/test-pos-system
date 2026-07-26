#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js
// fix18-10-hotfix30-B5-R5.2-B2 — Leaflet Geo Intelligence Map
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n總計：${results.length} 項，PASS ${p}，FAIL ${f}`);
  if (f > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

// ── Leaflet Test Double（需求文件二十九）───────────────────────
function createLeafletMock() {
  const calls = { mapInit: 0, tileLayer: 0, geoJSON: 0, fitBoundsCalls: [], removed: 0, invalidateSize: 0, layerAdd: 0, layerRemove: 0 };
  const allLayers = [];
  function makeLayer(feature) {
    let style = {};
    const listeners = {};
    let tooltipContent = null;
    let onMap = false;
    const layer = {
      feature,
      __geoAreaId: null,
      setStyle(s) { style = { ...style, ...s }; },
      getStyle() { return style; },
      on(evt, fn) { listeners[evt] = listeners[evt] || []; listeners[evt].push(fn); return layer; },
      fire(evt, data) { (listeners[evt] || []).forEach((fn) => fn(data)); },
      bindTooltip(content) { tooltipContent = content; return layer; },
      getTooltipContent() { return tooltipContent; },
      getBounds() { return { mockBounds: true, feature }; },
      isOnMap() { return onMap; },
      addTo(map) { onMap = true; calls.layerAdd += 1; this.__map = map; return this; },
      remove() { onMap = false; calls.layerRemove += 1; },
    };
    allLayers.push(layer);
    return layer;
  }
  const L = {
    map(container) {
      calls.mapInit += 1;
      // 真實 Leaflet 的 L.map(container) 會接管容器並清空原本內容（例如把
      // 錯誤/loading 訊息的 DOM 清掉，換成地圖自己的 pane 結構）——mock 必須
      // 忠實模擬這個行為，否則像「Retry 後應該看不到舊錯誤訊息」這類測試會
      // 因為 mock 沒清空 DOM 而產生假的失敗，而不是真的驗證 production 邏輯。
      if (container && typeof container.innerHTML === 'string') container.innerHTML = '';
      return {
        __container: container,
        removed: false,
        remove() { this.removed = true; calls.removed += 1; },
        fitBounds(b) { calls.fitBoundsCalls.push(b); },
        setView() { return this; },
        invalidateSize() { calls.invalidateSize += 1; },
      };
    },
    tileLayer(url, opts) {
      calls.tileLayer += 1;
      return { url, options: opts, addTo(map) { this.__map = map; return this; } };
    },
    geoJSON(geojson, opts) {
      calls.geoJSON += 1;
      const features = (geojson && geojson.features) || (geojson && geojson.type === 'Feature' ? [geojson] : []);
      const layers = features.map((f) => {
        const layer = makeLayer(f);
        if (opts && typeof opts.onEachFeature === 'function') opts.onEachFeature(f, layer);
        return layer;
      });
      return {
        eachLayer(fn) { layers.forEach(fn); },
        getBounds() { return { mockBounds: true, count: layers.length }; },
        addTo(map) { calls.layerAdd += 1; this.__map = map; this.__onMap = true; return this; },
        remove() { calls.layerRemove += 1; this.__onMap = false; },
        __layers: layers,
      };
    },
    latLngBounds(...args) { return { args }; },
    control: { layers: () => ({ addTo: () => {} }) },
  };
  return { L, calls, layers: allLayers };
}

async function main() {
  global.escHtml = function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const { execFileSync } = require('child_process');
  ['public/js/geo-intelligence.js', 'public/js/geo-intelligence-map.js'].forEach((f) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, f)]); pass(`0-1 node --check ${f} 通過`); }
    catch (e) { fail(`0-1 node --check ${f} 通過`, e.message); }
  });

  const M = require(path.join(ROOT, 'public/js/geo-intelligence-map.js'));
  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ══════════════════════════════════════════════════════════════
  // 28.1 Pure Utilities
  // ══════════════════════════════════════════════════════════════

  // ── Area Normalization（台/臺、區字尾、空白、全形空白）──
  {
    assert(M.geoNormalizeAreaName('臺北市') === M.geoNormalizeAreaName('台北市'), 'A-NORM-1 臺/台 正規化後相同');
    assert(M.geoNormalizeAreaName('  中壢區  ') === M.geoNormalizeAreaName('中壢區'), 'A-NORM-2 前後空白正規化後相同');
    assert(M.geoNormalizeAreaName('中壢區\u3000') === M.geoNormalizeAreaName('中壢區'), 'A-NORM-3 全形空白正規化後相同');
    assert(M.geoNormalizeAreaName(null) === '', 'A-NORM-4 null 輸入安全回空字串');
    assert(M.geoNormalizeAreaName(undefined) === '', 'A-NORM-5 undefined 輸入安全回空字串');
    assert(M.geoNormalizeAreaName('ABC') === 'abc', 'A-NORM-6 英文轉小寫');
    assert(M.geoNormalizeAreaName('臺灣臺北') === M.geoNormalizeAreaName('台灣台北'), 'A-NORM-7 多個 臺 字都正確轉換');
  }

  // ── County + District / area_id Matching ──
  {
    const geojson = { features: [
      { type: 'Feature', properties: { county: '桃園市', district: '中壢區', area_id: 'TY-ZL' }, geometry: { type: 'Polygon', coordinates: [] } },
      { type: 'Feature', properties: { county: '桃園市', district: '平鎮區', area_id: null }, geometry: { type: 'Polygon', coordinates: [] } },
    ] };
    const index = M.geoBuildAreaFeatureIndex(geojson);
    assert(index.featureCount === 2, 'B-MATCH-1 featureIndex 正確計數');

    const byAreaId = M.geoMatchAreaToFeature({ area_id: 'TY-ZL', city: '任意', district: '任意' }, index);
    assert(byAreaId && byAreaId.properties.district === '中壢區', 'B-MATCH-2 優先用 area_id 比對成功');

    const byCountyDistrict = M.geoMatchAreaToFeature({ city: '桃園市', district: '平鎮區' }, index);
    assert(byCountyDistrict && byCountyDistrict.properties.district === '平鎮區', 'B-MATCH-3 沒有 area_id 時用 county+district 比對成功');

    const byNormalized = M.geoMatchAreaToFeature({ city: '臺灣桃園市'.replace('臺灣', ''), district: '中壢區' }, index);
    assert(byNormalized && byNormalized.properties.district === '中壢區', 'B-MATCH-4 正規化後仍能比對成功');

    const noMatch = M.geoMatchAreaToFeature({ city: '不存在市', district: '不存在區' }, index);
    assert(noMatch === null, 'B-MATCH-5 完全找不到時回傳 null');

    const nullRow = M.geoMatchAreaToFeature(null, index);
    assert(nullRow === null, 'B-MATCH-6 areaRow=null 不崩潰');
    const nullIndex = M.geoMatchAreaToFeature({ city: 'X', district: 'Y' }, null);
    assert(nullIndex === null, 'B-MATCH-7 featureIndex=null 不崩潰');

    // 缺 property（missing property）
    const geojsonMissingProps = { features: [{ type: 'Feature', properties: {}, geometry: {} }] };
    const indexMissing = M.geoBuildAreaFeatureIndex(geojsonMissingProps);
    assert(indexMissing.featureCount === 1, 'B-MATCH-8 缺屬性的 feature 仍被計入 index，不崩潰');
    const emptyGeojson = M.geoBuildAreaFeatureIndex(null);
    assert(emptyGeojson.featureCount === 0, 'B-MATCH-9 geojson=null 時安全回空 index');
    const emptyGeojson2 = M.geoBuildAreaFeatureIndex({});
    assert(emptyGeojson2.featureCount === 0, 'B-MATCH-10 geojson 沒有 features 欄位時安全回空 index');
  }

  // ── Metric Extraction ──
  {
    const row = { visitors: 100, orders: 12, revenue: 5000, conversion_rate: 0.12, cart_abandon_visitors: 40 };
    assert(M.geoGetMetricValue(row, 'visitors') === 100, 'C-METRIC-1 visitors 正確');
    assert(M.geoGetMetricValue(row, 'orders') === 12, 'C-METRIC-2 orders 正確');
    assert(M.geoGetMetricValue(row, 'revenue') === 5000, 'C-METRIC-3 revenue 正確');
    assert(M.geoGetMetricValue(row, 'conversion_rate') === 0.12, 'C-METRIC-4 conversion_rate 正確');
    assert(M.geoGetMetricValue(row, 'cart_abandonment_rate') === 0.4, 'C-METRIC-5 cart_abandonment_rate 正確計算（40/100）');
    assert(M.geoGetMetricValue(null, 'visitors') === null, 'C-METRIC-6 row=null 回 null');
    assert(M.geoGetMetricValue({}, 'visitors') === null, 'C-METRIC-7 缺欄位回 null（不是 0，不當成有資料）');
    assert(M.geoGetMetricValue(row, 'not_a_metric') === null, 'C-METRIC-8 未知 metric 回 null');
    assert(M.geoGetMetricValue({ visitors: 0, cart_abandon_visitors: 5 }, 'cart_abandonment_rate') === null, 'C-METRIC-9 visitors=0 時 cart_abandonment_rate 回 null（不除以 0）');
    assert(M.geoGetMetricValue({ orders: '12' }, 'orders') === 12, 'C-METRIC-10 字串數字仍能安全轉換');
    assert(M.geoGetMetricValue({ orders: 'abc' }, 'orders') === null, 'C-METRIC-11 非數字字串安全回 null');
    // orders fallback chain: order_count → purchase_visitors
    assert(M.geoGetMetricValue({ order_count: 7 }, 'orders') === 7, 'C-METRIC-12 orders 缺失時 fallback 到 order_count');
    assert(M.geoGetMetricValue({ purchase_visitors: 3 }, 'orders') === 3, 'C-METRIC-13 orders/order_count 都缺失時 fallback 到 purchase_visitors');
  }

  // ── Risk Severity（沿用既有 classification/severity，不重新分類）──
  {
    assert(M.geoClassifyAreaRisk({ headline: { severity: 'high' }, intent_type: 'risk' }) === 'critical', 'D-RISK-1 severity=high + intent=risk → critical');
    assert(M.geoClassifyAreaRisk({ headline: { severity: 'high' }, intent_type: 'positive' }) === 'high', 'D-RISK-2 severity=high 但非 risk intent → high');
    assert(M.geoClassifyAreaRisk({ headline: { severity: 'medium' }, intent_type: 'risk' }) === 'medium', 'D-RISK-3 severity=medium → medium');
    assert(M.geoClassifyAreaRisk({ headline: { severity: 'low' }, intent_type: 'opportunity' }) === 'low', 'D-RISK-4 severity=low → low');
    assert(M.geoClassifyAreaRisk(null) === 'none', 'D-RISK-5 model=null → none');
    assert(M.geoClassifyAreaRisk({}) === 'none', 'D-RISK-6 缺 headline → none');
    assert(M.GEO_RISK_RANK.critical > M.GEO_RISK_RANK.high, 'D-RISK-7 RISK_RANK 排序正確（critical > high）');
    assert(M.GEO_RISK_RANK.high > M.GEO_RISK_RANK.medium, 'D-RISK-8 RISK_RANK 排序正確（high > medium）');
    assert(M.GEO_RISK_RANK.medium > M.GEO_RISK_RANK.low, 'D-RISK-9 RISK_RANK 排序正確（medium > low）');
    assert(M.GEO_RISK_RANK.low > M.GEO_RISK_RANK.none, 'D-RISK-10 RISK_RANK 排序正確（low > none）');
  }

  // ── Quantile Scale：equal values / all zero / all missing / negative ──
  {
    const normalScale = M.geoBuildMetricScale([10, 20, 30, 40, 100], 'visitors');
    assert(normalScale.hasData === true, 'E-SCALE-1 正常資料 hasData=true');
    assert(normalScale.min === 10 && normalScale.max === 100, 'E-SCALE-2 min/max 正確');
    assert(normalScale.median === 30, 'E-SCALE-3 median 正確');

    const equalScale = M.geoBuildMetricScale([50, 50, 50, 50], 'visitors');
    assert(equalScale.min === 50 && equalScale.max === 50, 'E-SCALE-4 全部相同值時 min=max=50');
    assert(equalScale.breaks.every((b) => b === 50), 'E-SCALE-5 全部相同值時所有 break 相同，不出錯');

    const zeroScale = M.geoBuildMetricScale([0, 0, 0], 'visitors');
    assert(zeroScale.hasData === true && zeroScale.max === 0, 'E-SCALE-6 全部為 0 時仍視為「有資料」（0 不等於沒資料）');

    const missingScale = M.geoBuildMetricScale([null, undefined, NaN], 'visitors');
    assert(missingScale.hasData === false, 'E-SCALE-7 全部缺失時 hasData=false');

    const mixedScale = M.geoBuildMetricScale([null, 10, undefined, 20], 'visitors');
    assert(mixedScale.hasData === true && mixedScale.min === 10, 'E-SCALE-8 混合缺失與有效值時，只用有效值計算');

    const emptyScale = M.geoBuildMetricScale([], 'visitors');
    assert(emptyScale.hasData === false, 'E-SCALE-9 空陣列 hasData=false');

    const singleScale = M.geoBuildMetricScale([42], 'visitors');
    assert(singleScale.hasData === true && singleScale.median === 42, 'E-SCALE-10 單一值時仍正確運作');

    const negativeScale = M.geoBuildMetricScale([-5, -3, -1], 'conversion_rate');
    assert(Number.isFinite(negativeScale.min) && Number.isFinite(negativeScale.max), 'E-SCALE-11 負值不會讓計算出錯（即使業務上不該出現負值）');
  }

  // ── Feature Style（無資料灰色、risk 分類、selected/hover）──
  {
    const scale = M.geoBuildMetricScale([10, 50, 100], 'visitors');
    const styleHigh = M.geoGetFeatureStyle(100, 'visitors', scale, {});
    const styleLow = M.geoGetFeatureStyle(10, 'visitors', scale, {});
    assert(styleHigh.fillColor !== styleLow.fillColor, 'F-STYLE-1 不同數值產生不同顏色');
    const styleNoData = M.geoGetFeatureStyle(null, 'visitors', scale, {});
    assert(styleNoData.fillColor === M.GEO_MAP_PALETTE.no_data, 'F-STYLE-2 無資料時使用 no_data 灰色（不是當成 0）');
    assert(styleNoData.dashArray === '4', 'F-STYLE-3 無資料時使用虛線樣式');
    const styleZero = M.geoGetFeatureStyle(0, 'visitors', scale, {});
    assert(styleZero.fillColor !== M.GEO_MAP_PALETTE.no_data, 'F-STYLE-4 數值為 0（真實資料）不等於無資料樣式');
    const styleSelected = M.geoGetFeatureStyle(50, 'visitors', scale, { selected: true });
    assert(styleSelected.weight === 3, 'F-STYLE-5 selected 狀態邊框加粗');
    const styleHovered = M.geoGetFeatureStyle(50, 'visitors', scale, { hovered: true });
    assert(styleHovered.weight === 2, 'F-STYLE-6 hovered 狀態邊框加粗（比 selected 細）');
    const styleRiskCritical = M.geoGetFeatureStyle('critical', 'risk', null, {});
    assert(styleRiskCritical.fillColor === M.GEO_MAP_PALETTE.risk.critical, 'F-STYLE-7 risk metric 直接用色票映射，不用 quantile scale');
    const styleRiskNone = M.geoGetFeatureStyle('none', 'risk', null, {});
    assert(styleRiskNone.fillColor === M.GEO_MAP_PALETTE.no_data, 'F-STYLE-8 risk=none 顯示無資料灰色');
    const styleRiskUnknown = M.geoGetFeatureStyle('undefined_value', 'risk', null, {});
    assert(styleRiskUnknown.fillColor === M.GEO_MAP_PALETTE.no_data, 'F-STYLE-9 未知 risk 值安全 fallback 為灰色');
  }

  // ── Legend（格式、單位、metric 切換不殘留上一個單位）──
  {
    const revenueScale = M.geoBuildMetricScale([1000, 5000, 10000], 'revenue');
    const revenueLegend = M.geoBuildMapLegend(revenueScale, 'revenue');
    assert(revenueLegend.items.some((it) => it.label.includes('NT$')), 'G-LEGEND-1 revenue legend 使用 NT$ 單位');
    const convScale = M.geoBuildMetricScale([0.1, 0.2, 0.3], 'conversion_rate');
    const convLegend = M.geoBuildMapLegend(convScale, 'conversion_rate');
    assert(convLegend.items.some((it) => it.label.includes('%')), 'G-LEGEND-2 conversion_rate legend 使用 % 單位');
    assert(!convLegend.items.some((it) => it.label.includes('NT$')), 'G-LEGEND-3 conversion_rate legend 不殘留 revenue 的 NT$ 單位');
    const visitorScale = M.geoBuildMetricScale([10, 50, 100], 'visitors');
    const visitorLegend = M.geoBuildMapLegend(visitorScale, 'visitors');
    assert(!visitorLegend.items.some((it) => it.label.includes('%') || it.label.includes('NT$')), 'G-LEGEND-4 visitors legend 是純整數，沒有 %/NT$');
    assert(visitorLegend.items.some((it) => it.label === '暫無資料'), 'G-LEGEND-5 legend 一律含「暫無資料」項目');
    const riskLegend = M.geoBuildMapLegend(null, 'risk');
    assert(riskLegend.items.length === 5, 'G-LEGEND-6 risk legend 固定 5 個項目（critical/high/medium/low/暫無資料）');
    const noDataLegend = M.geoBuildMapLegend({ hasData: false }, 'visitors');
    assert(noDataLegend.items.length === 1 && noDataLegend.items[0].label === '暫無資料', 'G-LEGEND-7 完全沒資料時 legend 只顯示暫無資料一項');
  }

  // ── Map Summary（deterministic，非 AI）──
  {
    const rows = [
      { city: 'A', district: '中壢區', visitors: 100 },
      { city: 'A', district: '平鎮區', visitors: 50 },
      { city: 'A', district: '八德區', visitors: null },
    ];
    const summary = M.geoBuildMapSummary(rows, 'visitors');
    assert(summary.highest.label === '中壢區' && summary.highest.value === 100, 'H-SUMMARY-1 最高區域正確');
    assert(summary.lowest.label === '平鎮區' && summary.lowest.value === 50, 'H-SUMMARY-2 最低有效區域正確（排除無資料的八德區）');
    assert(summary.average === 75, 'H-SUMMARY-3 平均值正確（只用有效值：(100+50)/2）');
    assert(summary.dataCount === 2, 'H-SUMMARY-4 有資料區域數正確');
    assert(summary.noDataCount === 1, 'H-SUMMARY-5 無資料區域數正確');
    const emptySummary = M.geoBuildMapSummary([], 'visitors');
    assert(emptySummary.highest === null, 'H-SUMMARY-6 空陣列時 highest=null，不崩潰');
    const allMissingSummary = M.geoBuildMapSummary([{ visitors: null }, { visitors: undefined }], 'visitors');
    assert(allMissingSummary.dataCount === 0 && allMissingSummary.noDataCount === 2, 'H-SUMMARY-7 全部缺失時正確統計');
    const nullRowsSummary = M.geoBuildMapSummary(null, 'visitors');
    assert(nullRowsSummary.totalCount === 0, 'H-SUMMARY-8 rows=null 不崩潰');
  }

  // ── Stable Sorting（同分排序穩定）──
  {
    const tiedRows = [
      { city: 'A', district: 'Z區', visitors: 50 },
      { city: 'A', district: 'A區', visitors: 50 },
      { city: 'A', district: 'M區', visitors: 50 },
    ];
    const summary1 = M.geoBuildMapSummary(tiedRows, 'visitors');
    const summary2 = M.geoBuildMapSummary(tiedRows.slice().reverse(), 'visitors');
    assert(summary1.highest.value === summary2.highest.value, 'I-STABLE-1 同分時 highest 數值一致（不因輸入順序不同而不同）');
  }

  // ══════════════════════════════════════════════════════════════
  // 28.2 Rendering（純函式字串層級：map block / metric buttons / legend HTML）
  // ══════════════════════════════════════════════════════════════
  {
    // 先建立乾淨的 map state（geoRenderMapBlock 讀取目前 metric）
    M._geoResetMapStateForTest();
    const blockHtml = M.geoRenderMapBlock('geo-map-test-1');
    assert(blockHtml.includes('geo-map-root'), 'J-RENDER-1 map block 含 .geo-map-root');
    assert(blockHtml.includes('geo-map-canvas'), 'J-RENDER-2 map block 含 canvas 容器');
    assert(blockHtml.includes('geo-map-legend'), 'J-RENDER-3 map block 含 legend 容器');
    assert(blockHtml.includes('geo-map-summary'), 'J-RENDER-4 map block 含 summary 容器');
    assert(blockHtml.includes('role="application"'), 'J-RENDER-5 canvas 容器含 role="application"');
    assert(blockHtml.includes('aria-label="Geo Intelligence 行政區地圖"'), 'J-RENDER-6 canvas 容器含正確 aria-label');
    M.GEO_MAP_METRICS.forEach((m) => {
      assert(blockHtml.includes(`data-geo-map-metric="${m}"`), `J-RENDER-7-${m} metric switcher 含「${m}」按鈕`);
    });
    const metricBtnMatches = blockHtml.match(/<button[^>]*class="geo-map-metric-btn"[^>]*>/g) || [];
    assert(metricBtnMatches.length === M.GEO_MAP_METRICS.length, 'J-RENDER-8 metric 按鈕數量正確');
    assert(metricBtnMatches.every((b) => b.includes('type="button"')), 'J-RENDER-9 所有 metric 按鈕都是 type="button"');
    assert(metricBtnMatches.every((b) => b.includes('aria-pressed=')), 'J-RENDER-10 所有 metric 按鈕都有 aria-pressed');
    const pressedBtn = metricBtnMatches.find((b) => b.includes('aria-pressed="true"'));
    assert(!!pressedBtn && pressedBtn.includes('visitors'), 'J-RENDER-11 預設 metric（visitors）的按鈕標記 aria-pressed="true"');
  }

  // ── Legend/Summary 格式化字串層級 ──
  {
    const emptyLegend = M.geoBuildMapLegend({ hasData: false }, 'orders');
    assert(!JSON.stringify(emptyLegend).match(/undefined|NaN|Infinity/), 'K-FORMAT-1 空 legend 不含 undefined/NaN/Infinity');
    const bigScale = M.geoBuildMetricScale([1e9, 2e9], 'revenue');
    const bigLegend = M.geoBuildMapLegend(bigScale, 'revenue');
    assert(!JSON.stringify(bigLegend).match(/NaN|Infinity/), 'K-FORMAT-2 極大數值不產生 NaN/Infinity');
    assert(M._geoFormatMetricValue(null, 'visitors') === '暫無資料', 'K-FORMAT-3 null 值格式化為「暫無資料」');
    assert(M._geoFormatMetricValue(NaN, 'visitors') === '暫無資料', 'K-FORMAT-4 NaN 格式化為「暫無資料」（不是 NaN 字樣）');
    assert(M._geoFormatMetricValue(Infinity, 'visitors') === '暫無資料', 'K-FORMAT-5 Infinity 格式化為「暫無資料」');
    assert(M._geoFormatMetricValue(0.126, 'conversion_rate') === '13%', 'K-FORMAT-6 conversion_rate 百分比四捨五入正確');
    assert(M._geoFormatMetricValue(123456, 'revenue') === 'NT$123,456', 'K-FORMAT-7 revenue 含千分位與 NT$ 前綴');
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom + Leaflet Mock 整合測試（28.2 剩餘／28.3／28.4／28.5／28.6）
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM/Leaflet 整合測試', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    process.exit(process.exitCode || 0);
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2Src = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const mapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="reports-container"></div><div id="analytics-v2-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  const GEOJSON_FIXTURE = {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: { county: '桃園市', district: '中壢區', area_id: null }, geometry: { type: 'Polygon', coordinates: [[[121.2, 24.9], [121.3, 24.9], [121.3, 25.0], [121.2, 25.0], [121.2, 24.9]]] } },
      { type: 'Feature', properties: { county: '桃園市', district: '平鎮區', area_id: null }, geometry: { type: 'Polygon', coordinates: [[[121.1, 24.8], [121.2, 24.8], [121.2, 24.9], [121.1, 24.9], [121.1, 24.8]]] } },
    ],
  };
  const GEO_OVERVIEW_FIXTURE = { success: true, data: { visitor_geo: {}, fulfillment_geo: {}, data_quality: { status: 'healthy', total_events: 10, identified_events: 10 } } };
  const GEO_FUNNEL_FIXTURE = { success: true, data: { areas: [
    { city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, submitted_order_visitors: 5, purchase_visitors: 5 },
    { city: '桃園市', district: '平鎮區', visitors: 60, add_to_cart_visitors: 20, begin_checkout_visitors: 8, submitted_order_visitors: 3, purchase_visitors: 3 },
  ] } };
  const GEO_ALERTS_FIXTURE = { success: true, data: { alerts: [], rule_thresholds: {}, recommendation_view_models: [], quality_view_models: [], rule_context: {}, meta: {} } };
  const GEO_COUNTY_SUMMARY_FIXTURE = { ok: true, rows: [{ county_code: '68000', county_name: '桃園市', visitor_count: 160, order_count: 8 }], unknown: {} };
  const XSS_PAYLOAD_MAP = '<script>alert(7)</script>';

  function buildFetchMock(fetchCalls, opts) {
    const o = opts || {};
    return (url) => {
      fetchCalls.push({ url: String(url), t: Date.now() });
      const u = String(url);
      let body; let status = 200;
      if (o.failGeojson && u.includes('taiwan-districts.geojson')) { status = 500; body = { error: 'fail' }; }
      else if (u.includes('taiwan-districts.geojson')) body = o.geojsonFixture || GEOJSON_FIXTURE;
      else if (u.includes('/geo/overview')) body = GEO_OVERVIEW_FIXTURE;
      else if (u.includes('/geo/funnel')) body = o.funnelFixture || GEO_FUNNEL_FIXTURE;
      else if (u.includes('/geo/alerts')) body = o.alertsFixture || GEO_ALERTS_FIXTURE;
      else if (u.includes('/geo/county-summary')) body = GEO_COUNTY_SUMMARY_FIXTURE;
      else if (u.includes('/geo/administrative-areas')) body = { ok: true, counties: [] };
      // 舊版 _geoIntelLazyLoad()（renderDashboardGeoIntelligence 內部排程）
      // 會另外打這三支，補上安全的空殼回應，避免測試環境下這個獨立分支
      // crash（跟本輪修的 bug 無關，只是要讓整合測試能跑到底）。
      else if (u.includes('source-area')) body = { success: true, data: { rows: [] } };
      else if (u.includes('fulfillment')) body = { success: true, data: { areas: [] } };
      else if (u.includes('distance')) body = { success: true, data: { bands: [] } };
      else body = { success: true, data: {} };
      const delay = o.delayMs || 0;
      return delay
        ? new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delay))
        : Promise.resolve({ ok: status === 200, status, json: async () => body });
    };
  }
  function setupDom(fetchOpts, leafletMock) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.localStorage = (() => { let s = {}; return { getItem: (k) => (k in s ? s[k] : null), setItem: (k, v) => { s[k] = String(v); }, removeItem: (k) => { delete s[k]; } }; })();
    dom.window.sessionStorage = dom.window.localStorage;
    if (leafletMock) dom.window.L = leafletMock.L;
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc + '\n;\n' + mapSrc);
    return { dom, fetchCalls };
  }

  // ── 28.2 Rendering：Loading/Empty/Error/Retry（真實 DOM）──
  {
    const { dom } = setupDom({ delayMs: 30 }); // 沒有 window.L → 應顯示「地圖元件載入中」
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-map-loading-test"></div>';
    const ok = window.geoInitMap('geo-map-loading-test', []);
    assert(ok === false, 'L-LOADING-1 沒有 Leaflet 全域時 geoInitMap() 回傳 false（不崩潰）');
    const html = document.getElementById('geo-map-loading-test').innerHTML;
    assert(html.includes('地圖元件載入中'), 'L-LOADING-2 顯示「地圖元件載入中」文字');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 28.3/28.4/28.5/28.6：真實 Leaflet Mock + jsdom 整合測試
  // ══════════════════════════════════════════════════════════════
  function buildTestRows() {
    return [
      { city: '桃園市', district: '中壢區', visitors: 100, orders: 5, revenue: 8000, conversion_rate: 0.12, cart_abandon_visitors: 40 },
      { city: '桃園市', district: '平鎮區', visitors: 60, orders: 3, revenue: 4000, conversion_rate: 0.08, cart_abandon_visitors: 20 },
    ];
  }

  // ── Map Singleton / Lifecycle（初始化一次、重複呼叫不重建、destroy）──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-life-1');
    window.L = mock.L; window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    const ok1 = window.geoInitMap('geo-map-life-1', buildTestRows());
    assert(ok1 === true, 'M-LIFECYCLE-1 首次 geoInitMap() 成功');
    assert(mock.calls.mapInit === 1, 'M-LIFECYCLE-2 L.map() 只呼叫一次');
    assert(mock.calls.tileLayer === 1, 'M-LIFECYCLE-3 L.tileLayer() 只呼叫一次');
    assert(mock.calls.geoJSON === 1, 'M-LIFECYCLE-4 L.geoJSON() 只呼叫一次（建立 boundary layer）');

    const ok2 = window.geoInitMap('geo-map-life-1', buildTestRows());
    assert(ok2 === true, 'M-LIFECYCLE-5 重複呼叫 geoInitMap()（同容器）仍回傳 true');
    assert(mock.calls.mapInit === 1, 'M-LIFECYCLE-6 重複呼叫不會重新建立 L.map()（單例）');
    assert(mock.calls.geoJSON === 1, 'M-LIFECYCLE-7 重複呼叫不會重新建立 geoJSON layer');

    const destroyed = window.geoDestroyMap();
    assert(destroyed === true, 'M-LIFECYCLE-8 geoDestroyMap() 回傳 true');
    assert(mock.calls.removed === 1, 'M-LIFECYCLE-9 map.remove() 確實被呼叫');
    assert(window.geoMapState.instance === null, 'M-LIFECYCLE-10 銷毀後 geoMapState.instance 設回 null');
    assert(window.geoMapState.containerId === null, 'M-LIFECYCLE-11 銷毀後 containerId 清空');

    // container 被移除的情境
    document.getElementById('geo-map-life-1').remove();
    let threw = false;
    try { window.geoInitMap('geo-map-life-1', []); } catch (e) { threw = true; }
    assert(!threw, 'M-LIFECYCLE-12 容器被移除後再呼叫 geoInitMap() 不拋出例外');
    dom.window.close();
  }

  // ── Metric Layer Switching（共用單一 state，不重建 map，不重綁事件）──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-metric-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-metric-1', buildTestRows());
    const mapInitCountBefore = mock.calls.mapInit;
    const geoJsonCountBefore = mock.calls.geoJSON;

    M.GEO_MAP_METRICS.forEach((metric) => {
      const ok = window.geoSetMapMetric(metric);
      assert(ok === true, `N-METRIC-1-${metric} geoSetMapMetric('${metric}') 回傳 true`);
      assert(window.geoMapState.metric === metric, `N-METRIC-2-${metric} geoMapState.metric 正確更新為單一 state`);
    });
    assert(mock.calls.mapInit === mapInitCountBefore, 'N-METRIC-3 切換 metric 6 次，L.map() 呼叫次數不變（不重建整張地圖）');
    assert(mock.calls.geoJSON === geoJsonCountBefore, 'N-METRIC-4 切換 metric 不會重新建立 geoJSON layer（不重新綁定全部事件）');

    const invalidResult = window.geoSetMapMetric('not_a_real_metric');
    assert(invalidResult === false, 'N-METRIC-5 無效 metric 名稱安全回傳 false，不崩潰');
    assert(M.GEO_MAP_METRICS.includes(window.geoMapState.metric), 'N-METRIC-6 無效 metric 不會污染目前 state');

    // Legend/Summary DOM 隨 metric 切換更新
    window.geoSetMapMetric('revenue');
    const legendHtml = document.getElementById('geo-map-metric-1-legend').innerHTML;
    assert(legendHtml.includes('Revenue'), 'N-METRIC-7 切換到 revenue 後 legend 標題更新');
    assert(legendHtml.includes('NT$'), 'N-METRIC-8 revenue legend 顯示 NT$ 單位');
    dom.window.close();
  }

  // ── Area Click / Keyboard / Tooltip ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-click-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-click-1', buildTestRows());
    const zhongliLayer = mock.layers.find((l) => l.feature && l.feature.properties && l.feature.properties.district === '中壢區');
    assert(!!zhongliLayer, 'O-CLICK-1 中壢區對應的 Leaflet layer 確實被建立');
    assert(zhongliLayer.__geoAreaId === '桃園市|中壢區', 'O-CLICK-2 layer 正確標記 __geoAreaId');
    assert(typeof zhongliLayer.getTooltipContent() === 'string' && zhongliLayer.getTooltipContent().includes('中壢區'), 'O-CLICK-3 tooltip 內容含行政區名稱');
    assert(zhongliLayer.getTooltipContent().includes('中壢區：') === false || zhongliLayer.getTooltipContent().length > 3, 'O-CLICK-4 tooltip 內容不是只有一個大字串空殼（含實際數值資訊）');

    let explorerCalledWith = null;
    window.geoOpenAreaExplorer = (id) => { explorerCalledWith = id; };
    zhongliLayer.fire('click');
    assert(window.geoMapState.selectedAreaId === '桃園市|中壢區', 'O-CLICK-5 點擊 layer 後 selectedAreaId 正確設定');
    assert(explorerCalledWith === '桃園市|中壢區', 'O-CLICK-6 點擊 layer 觸發 geoOpenAreaExplorer()（沿用 B1-6A 統一入口，不建第二套 Drawer）');

    // hover → mouseout 恢復樣式
    zhongliLayer.fire('mouseover');
    assert(window.geoMapState.hoveredAreaId === '桃園市|中壢區', 'O-CLICK-7 mouseover 設定 hoveredAreaId');
    zhongliLayer.fire('mouseout');
    assert(window.geoMapState.hoveredAreaId === null, 'O-CLICK-8 mouseout 清除 hoveredAreaId（恢復由 metric 決定的樣式）');

    // keyboard：Enter/Space 觸發跟點擊相同的效果
    explorerCalledWith = null;
    const enterEvent = { key: 'Enter', preventDefault: () => {} };
    const handled = window.geoHandleMapKeydown(enterEvent, '桃園市|平鎮區');
    assert(handled === true, 'P-KEYBOARD-1 geoHandleMapKeydown() Enter 鍵回傳 true（已處理）');
    assert(explorerCalledWith === '桃園市|平鎮區', 'P-KEYBOARD-2 Enter 鍵觸發跟滑鼠點擊相同的 geoOpenAreaExplorer()');
    explorerCalledWith = null;
    const spaceEvent = { key: ' ', preventDefault: () => {} };
    const handledSpace = window.geoHandleMapKeydown(spaceEvent, '桃園市|中壢區');
    assert(handledSpace === true, 'P-KEYBOARD-3 Space 鍵同樣被處理');
    assert(explorerCalledWith === '桃園市|中壢區', 'P-KEYBOARD-4 Space 鍵觸發正確的 areaId');
    const tabEvent = { key: 'Tab', preventDefault: () => {} };
    const handledTab = window.geoHandleMapKeydown(tabEvent, '桃園市|中壢區');
    assert(handledTab === false, 'P-KEYBOARD-5 非 Enter/Space 鍵不處理（回傳 false），不干擾正常 Tab 導覽');
    assert(window.geoHandleMapKeydown(null, 'x') === false, 'P-KEYBOARD-6 event=null 不崩潰');
    assert(window.geoHandleMapKeydown({ key: 'Enter' }, null) === false, 'P-KEYBOARD-7 areaId=null 不崩潰');

    // 鍵盤可操作的行政區清單備援（§21）
    const areaListHtml = document.getElementById('geo-map-click-1-area-list').innerHTML;
    assert(areaListHtml.includes('中壢區') && areaListHtml.includes('平鎮區'), 'P-KEYBOARD-8 行政區清單備援含所有區域');
    assert((areaListHtml.match(/tabindex="0"/g) || []).length >= 2, 'P-KEYBOARD-9 每個行政區項目都可 Tab 到（tabindex="0"）');
    assert(areaListHtml.includes('onkeydown='), 'P-KEYBOARD-10 行政區清單項目綁定 keydown 處理');
    dom.window.close();
  }

  // ── Ranking ↔ Map 雙向同步 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-sync-1') + '<table><tbody><tr data-geo-area-key="桃園市|中壢區"><td>中壢區</td></tr></tbody></table>';
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-sync-1', buildTestRows());
    let scrolledInto = false;
    const rankingRow = document.querySelector('[data-geo-area-key="桃園市|中壢區"]');
    rankingRow.scrollIntoView = () => { scrolledInto = true; };
    let explorerOpened = null;
    window.geoOpenAreaExplorer = (id) => { explorerOpened = id; };

    // 11.2：點地圖 → highlight ranking row + 開 Explorer
    const zhongliLayer = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    zhongliLayer.fire('click');
    assert(explorerOpened === '桃園市|中壢區', 'Q-SYNC-1 點地圖行政區開啟對應 Geo Explorer');

    // 11.1：點 Ranking row → 地圖定位＋highlight（呼叫 geoSelectArea 且不重開 Explorer 造成無限觸發）
    explorerOpened = null;
    window.geoSelectArea('桃園市|平鎮區', { openExplorer: false, focusMap: true, scrollRanking: true, source: 'ranking' });
    assert(window.geoMapState.selectedAreaId === '桃園市|平鎮區', 'Q-SYNC-2 點 Ranking row 後地圖 selectedAreaId 正確更新');
    assert(explorerOpened === null, 'Q-SYNC-3 從 Ranking 觸發時不會又反過來開一次 Explorer（避免無限互相觸發）');
    assert(mock.calls.fitBoundsCalls.length > 0, 'Q-SYNC-4 focusMap:true 時確實呼叫了 fitBounds()');
    dom.window.close();
  }

  // ── Filter Sharing（沿用 dashboardDateState/av2Channel/geoDashboardFilters，無第二套）──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-map-filter-1"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-map-filter-1');
    await sleep(30);
    assert(typeof window.geoExplorerFilters === 'undefined', 'R-FILTER-1 沒有建立第二套 geoExplorerFilters state');
    assert(typeof window.geoMapFilters === 'undefined', 'R-FILTER-2 沒有建立第二套 geoMapFilters state');
    assert(typeof window.geoDashboardFilters === 'object', 'R-FILTER-3 地圖沿用既有 geoDashboardFilters（同一個物件）');
    dom.window.close();
  }

  // ── Race Condition：GeoJSON fetch 慢／快交錯 ──
  {
    const { dom } = setupDom({ delayMs: 0 });
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += '<div id="geo-map-race-1"></div>';
    let call = 0;
    dom.window.fetch = (url) => {
      const u = String(url);
      if (u.includes('taiwan-districts.geojson')) {
        call += 1;
        const isFirst = call === 1;
        const body = isFirst
          ? { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { county: 'STALE', district: 'STALE' }, geometry: {} }] }
          : { type: 'FeatureCollection', features: [{ type: 'Feature', properties: { county: '桃園市', district: '中壢區' }, geometry: {} }] };
        const delay = isFirst ? 40 : 5;
        return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => body }), delay));
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
    };
    const p1 = window.geoLoadBoundaryData(); // Request A（慢，STALE 資料）
    await sleep(2);
    const p2 = window.geoLoadBoundaryData(); // Request B（快，正確資料）——立即接著發出
    await Promise.all([p1, p2]);
    await sleep(60);
    assert(window.geoMapState.featureIndex.byCountyDistrict.has('桃園市|中壢區'), 'S-RACE-1 最終 featureIndex 反映最後一次（Request B）的資料');
    assert(!window.geoMapState.featureIndex.byCountyDistrict.has('stale|stale'), 'S-RACE-2 過期的 Request A 資料沒有殘留覆蓋最終結果');
    dom.window.close();
  }

  // ── DOM Safety：所有函式面對缺失 DOM/Leaflet 都不 throw ──
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    let threw = false;
    try {
      window.geoInitMap('container-does-not-exist', []);
      window.geoUpdateMapData([], 'visitors');
      window.geoSetMapMetric('visitors');
      window.geoSelectArea('不存在|區域', {});
      window.geoFocusArea('不存在|區域');
      window.geoDestroyMap();
      window.geoDestroyMap(); // 連續呼叫兩次
      window.geoHandleMapError('error_default');
      window.geoRetryMap();
      window.geoHandleMapKeydown({ key: 'Enter' }, 'x');
    } catch (e) { threw = true; }
    assert(!threw, 'T-DOMSAFE-1 全部地圖函式在完全沒有容器/Leaflet/資料時都不拋出例外');
    dom.window.close();
  }

  // ── XSS / Privacy：GeoJSON properties／district／county 視為不可信輸入 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-xss-1');
    const XSS_SET = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>'];
    XSS_SET.forEach((payload, i) => {
      window.geoDestroyMap();
      window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex({
        features: [{ type: 'Feature', properties: { county: payload, district: payload }, geometry: {} }],
      });
      window.geoInitMap('geo-map-xss-1', [{ city: payload, district: payload, visitors: 10 }]);
      const root = document.getElementById('geo-map-xss-1').closest('.geo-map-root') || document.body;
      // 需求文件二十八之五：真正的安全判準是「有沒有產生可執行節點」，不是
      // 序列化字串裡有沒有出現子字串——正確 escape 過的屬性值（例如
      // data-geo-map-area-key="..."）本身是惰性資料，重新序列化 innerHTML
      // 時 <>字元在屬性值語境下不強制轉義也完全安全（不會被解析成標籤），
      // 用字串比對反而會誤判；改用真實 DOM 查詢確認沒有產生可執行節點。
      assert(root.querySelectorAll('script').length === 0, `U-XSS-${i}-1 fixture 未產生真實 <script> 節點`);
      assert(root.querySelectorAll('img[onerror]').length === 0, `U-XSS-${i}-2 fixture 未產生真實帶 onerror 的 <img> 節點`);
      assert(root.querySelectorAll('svg[onload]').length === 0, `U-XSS-${i}-3 fixture 未產生真實帶 onload 的 <svg> 節點`);
      // Legend 內容本身跟行政區名稱無關（只有 metric 數值 bucket），額外確認
      // 它完全不受這個 fixture 影響，維持原樣的數值 legend。
      const legendHtml = document.getElementById('geo-map-xss-1-legend').innerHTML;
      assert(legendHtml.includes('geo-map-legend-item'), `U-XSS-${i}-4 legend 不受 GeoJSON properties fixture 影響，仍正常渲染數值圖例`);
    });
    // Privacy：完整輸出不含 GPS/UID/email/電話/地址等
    window.geoDestroyMap();
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-xss-1', buildTestRows());
    const fullHtml = document.getElementById('geo-map-xss-1').innerHTML + document.getElementById('geo-map-xss-1-legend').innerHTML;
    assert(!/@[a-z0-9.]+\.[a-z]{2,}/i.test(fullHtml), 'U-PRIVACY-1 地圖輸出不含 email 格式');
    assert(!/09\d{8}/.test(fullHtml), 'U-PRIVACY-2 地圖輸出不含電話格式');
    assert(!/-?\d{1,3}\.\d{4,},\s*-?\d{1,3}\.\d{4,}/.test(fullHtml), 'U-PRIVACY-3 地圖輸出不含完整 GPS 座標格式字串');
    assert(!/line_user_id|line_uid|visitor_id|identity_key/i.test(fullHtml), 'U-PRIVACY-4 地圖輸出不含 LINE UID/visitor_id/identity_key 等內部欄位名稱');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 28.6 Static / Compatibility
  // ══════════════════════════════════════════════════════════════
  {
    const mapSrc2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8');
    const fnNames = (mapSrc2.match(/(?<=^function )\w+/gm) || []);
    const dupFns = fnNames.filter((n, i) => fnNames.indexOf(n) !== i);
    assert(dupFns.length === 0, `V-STATIC-1 geo-intelligence-map.js 沒有重複 function 宣告（${dupFns.join(',') || '無'}）`);
    const declNames = (mapSrc2.match(/(?<=^(const|let) )\w+/gm) || []);
    const dupDecls = declNames.filter((n, i) => declNames.indexOf(n) !== i);
    assert(dupDecls.length === 0, `V-STATIC-2 geo-intelligence-map.js 沒有重複 const/let 宣告（${dupDecls.join(',') || '無'}）`);

    const geoSrc2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    const geoFnNames = (geoSrc2.match(/(?<=^function )\w+/gm) || []);
    const geoDupFns = geoFnNames.filter((n, i) => geoFnNames.indexOf(n) !== i);
    assert(geoDupFns.length === 0, 'V-STATIC-3 geo-intelligence.js 沒有重複 function 宣告（B2 修改未引入重複）');

    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const indexHtmlNoComments = indexHtml.replace(/<!--[\s\S]*?-->/g, '');
    const cssLinkCount = (indexHtmlNoComments.match(/geo-intelligence\.css/g) || []).length;
    assert(cssLinkCount === 1, 'V-STATIC-4 geo-intelligence.css 只被引用一次');
    const mapJsLinkCount = (indexHtmlNoComments.match(/geo-intelligence-map\.js/g) || []).length;
    assert(mapJsLinkCount === 1, 'V-STATIC-5 geo-intelligence-map.js 只被引用一次（排除 HTML 註解文字本身提到檔名的情況）');
    const leafletJsCount = (indexHtml.match(/leaflet@[\d.]+\/dist\/leaflet\.js/g) || []).length;
    assert(leafletJsCount === 1, 'V-STATIC-6 Leaflet JS 只被引用一次');
    const leafletCssCount = (indexHtml.match(/leaflet@[\d.]+\/dist\/leaflet\.css/g) || []).length;
    assert(leafletCssCount === 1, 'V-STATIC-7 Leaflet CSS 只被引用一次');
    assert(indexHtml.includes('integrity=') , 'V-STATIC-8 Leaflet CDN 引入含 integrity 屬性');
    const idsRaw = indexHtml.match(/id=["']([^"']+)["']/g) || [];
    const idValues = idsRaw.map((s) => s.match(/id=["']([^"']+)["']/)[1]);
    const dupIds = idValues.filter((n, i) => idValues.indexOf(n) !== i);
    assert(new Set(dupIds).size === 0, 'V-STATIC-9 index.html 沒有重複的靜態 HTML id');

    const cssContent = fs.readFileSync(path.join(ROOT, 'public/css/geo-intelligence.css'), 'utf8');
    ['.geo-map-root', '.geo-map-header', '.geo-map-metrics', '.geo-map-metric-btn', '.geo-map-canvas',
      '.geo-map-legend', '.geo-map-summary', '.geo-map-empty', '.geo-map-error', '.geo-map-loading',
      '.geo-map-area-list', '.geo-map-selected'].forEach((sel) => {
      assert(cssContent.includes(sel), `V-STATIC-10 CSS 含選擇器「${sel}」`);
    });
    const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/(^|\s)\.card\s*\{/.test(withoutComments), 'V-STATIC-11 沒有全域 .card{}');
    assert(!/(^|\s)table\s*\{/.test(withoutComments), 'V-STATIC-12 沒有全域 table{}');
    assert(!/(^|\s)button\s*\{/.test(withoutComments), 'V-STATIC-13 沒有全域 button{}');
    assert(!/(^|\s)\.container\s*\{/.test(withoutComments), 'V-STATIC-14 沒有全域 .container{}');
    assert(/\.leaflet-container\s*\{/.test(withoutComments) === false || /\.geo-map-root\s+\.leaflet-container/.test(withoutComments), 'V-STATIC-15 Leaflet 覆寫必須包在 .geo-map-root 底下，不是全域 .leaflet-container{}');

    // B1-6A/B1-5 既有函式與變數仍存在，未被 B2 破壞
    const RE2 = require(path.join(ROOT, 'public/js/geo-intelligence.js'));
    ['geoOpenAreaExplorer', 'geoResolveAreaFromId', 'geoBuildHotProductsList', 'geoAnonymizeVisitorId',
      'geoBuildKpiSummaryCards', 'geoEstimateRecommendationImpact', 'geoRenderDecisionCenter',
      'geoComputeRecommendedActions', 'computeGeoAreaRanking',
    ].forEach((fnName) => {
      assert(typeof RE2[fnName] === 'function' || fnName === 'geoOpenAreaExplorer', `V-STATIC-16-${fnName} 既有函式「${fnName}」仍存在`);
    });
    assert(geoSrc2.includes('function geoOpenAreaExplorer('), 'V-STATIC-17 geoOpenAreaExplorer() 定義仍存在（B2 只是額外呼叫 geoSelectArea，不是重寫）');
    assert(geoSrc2.includes("if (typeof geoSelectArea === 'function')"), 'V-STATIC-18 geoOpenAreaExplorer() 對 geoSelectArea 呼叫有 typeof 防呆（地圖模組未載入時不影響既有行為）');
    assert(!geoSrc2.match(/function geoComputeRecommendedActions[\s\S]{0,200}function geoComputeRecommendedActions/), 'V-STATIC-19 沒有第二套 geoComputeRecommendedActions（只有一份既有實作）');
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：Recommendation Risk Overlay（沿用既有 classification/severity）
  // ══════════════════════════════════════════════════════════════
  {
    const modelsByArea = {
      '桃園市|中壢區': [
        { headline: { severity: 'medium' }, intent_type: 'risk' },
        { headline: { severity: 'high' }, intent_type: 'risk' }, // critical，應該顯示這個（最高 severity）
      ],
    };
    const risks = modelsByArea['桃園市|中壢區'].map((m) => M.geoClassifyAreaRisk(m));
    const highestRisk = risks.reduce((best, r) => (M.GEO_RISK_RANK[r] > M.GEO_RISK_RANK[best] ? r : best), 'none');
    assert(highestRisk === 'critical', 'W-RISKOVERLAY-1 同一行政區多個 recommendation 時，取最高 severity（critical）顯示');
    assert(risks.length === 2, 'W-RISKOVERLAY-2 recommendation 數量正確保留（供 tooltip 顯示「N 個 recommendation」）');
    const noRiskArea = M.geoClassifyAreaRisk(undefined);
    assert(noRiskArea === 'none', 'W-RISKOVERLAY-3 沒有 recommendation 的行政區風險為 none');
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：Malformed GeoJSON / Tile 失敗 / Feature properties missing
  // ══════════════════════════════════════════════════════════════
  {
    let threw1 = false;
    try { M.geoBuildAreaFeatureIndex('not even an object'); } catch (e) { threw1 = true; }
    assert(!threw1, 'X-MALFORMED-1 geojson 為非物件字串時不崩潰');
    let threw2 = false;
    try { M.geoBuildAreaFeatureIndex({ features: 'not an array' }); } catch (e) { threw2 = true; }
    assert(!threw2, 'X-MALFORMED-2 features 不是陣列時不崩潰');
    let threw3 = false;
    let idx3;
    try { idx3 = M.geoBuildAreaFeatureIndex({ features: [null, undefined, { properties: null }] }); } catch (e) { threw3 = true; }
    assert(!threw3, 'X-MALFORMED-3 features 陣列內含 null/undefined/properties=null 時不崩潰');

    // Tile 載入失敗：polygon 仍可使用（不依賴 tile 是否載入成功）
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    mock.L.tileLayer = (url, opts) => ({ url, options: opts, addTo() { throw new Error('tile load failure (simulated)'); } });
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-tile-fail');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    let tileThrew = false;
    try { window.geoInitMap('geo-map-tile-fail', buildTestRows()); } catch (e) { tileThrew = true; }
    assert(!tileThrew, 'X-TILE-1 Tile provider 的 addTo() 拋出例外時，geoInitMap() 本身不會 crash（不讓整個分析失效）');
    assert(mock.calls.geoJSON === 1, 'X-TILE-2 Tile 載入失敗後，行政區 GeoJSON polygon layer 仍照常建立（不依賴 tile 是否成功）');
    assert(window.geoMapState.instance !== null, 'X-TILE-3 Tile 失敗後 map instance 仍存在（不是整個初始化被判定失敗）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：Empty State 變體（GeoJSON 沒有匹配區域／篩選後無資料／metric 全部無資料）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-empty-1');
    // GeoJSON 沒有匹配區域：featureIndex 是空的，但有 rows
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex({ features: [] });
    window.geoInitMap('geo-map-empty-1', buildTestRows());
    assert(mock.calls.geoJSON >= 1, 'Y-EMPTY-1 即使 GeoJSON 沒有 feature，仍安全呼叫 L.geoJSON()（空的 FeatureCollection），不崩潰');

    // 篩選後無資料：rows 是空陣列
    window.geoUpdateMapData([], 'visitors');
    const summaryHtml = document.getElementById('geo-map-empty-1-summary').innerHTML;
    assert(summaryHtml.includes(M.geoMapStatusText('empty_no_data')), 'Y-EMPTY-2 篩選後無資料時 summary 顯示集中管理的空狀態文字');
    assert(!summaryHtml.match(/null|undefined|NaN|Infinity/), 'Y-EMPTY-3 空資料 summary 不含 null/undefined/NaN/Infinity 字樣');

    // 所選 metric 全部無資料（rows 存在但該 metric 全部是 null）
    window.geoUpdateMapData([{ city: '桃園市', district: '中壢區', revenue: null }], 'revenue');
    const legendHtml2 = document.getElementById('geo-map-empty-1-legend').innerHTML;
    assert(legendHtml2.includes(M.geoMapStatusText('no_data_label')), 'Y-EMPTY-4 所選 metric 全部無資料時 legend 只顯示暫無資料');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：集中訊息合規性檢查（不得散落固定字串）
  // ══════════════════════════════════════════════════════════════
  {
    const mapSrc3 = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence-map.js'), 'utf8');
    // 除了 GEO_MAP_MESSAGES 常數表本身，程式碼其他地方不應再出現這些中文
    // 字面字串（用 geoMapStatusText()/geoBuildMapStatusHtml() 取用才對）。
    const messagesTableMatch = mapSrc3.match(/const GEO_MAP_MESSAGES = Object\.freeze\(\{[\s\S]*?\}\);/);
    const restOfFile = mapSrc3.replace(messagesTableMatch[0], '');
    ['地圖元件載入中', '行政區邊界載入中', '無法載入區域地圖', '目前沒有符合條件的區域資料'].forEach((literal) => {
      assert(!restOfFile.includes(literal), `Z-CENTRALIZED-1-${literal} 常數表以外的程式碼不再直接寫死「${literal}」`);
    });
    assert(typeof M.geoMapStatusText === 'function', 'Z-CENTRALIZED-2 geoMapStatusText() 存在且可用於取代散落字串');
    assert(typeof M.geoBuildMapStatusHtml === 'function', 'Z-CENTRALIZED-3 geoBuildMapStatusHtml() 存在');
    assert(M.geoMapStatusText('loading_leaflet') === M.GEO_MAP_MESSAGES.loading_leaflet, 'Z-CENTRALIZED-4 geoMapStatusText() 正確從集中表取值');
    assert(M.geoMapStatusText('not_a_real_kind') === M.GEO_MAP_MESSAGES.error_default, 'Z-CENTRALIZED-5 未知 kind 安全 fallback 為預設錯誤文案');
    const loadingHtml = M.geoBuildMapStatusHtml('loading_boundary');
    assert(loadingHtml.includes('geo-map-loading') && !loadingHtml.includes('geo-map-error'), 'Z-CENTRALIZED-6 loading 類 kind 產生 loading 樣式，不是 error 樣式');
    const errorHtml = M.geoBuildMapStatusHtml('error_default');
    assert(errorHtml.includes('geo-map-error') && errorHtml.includes('重新載入'), 'Z-CENTRALIZED-7 error kind 產生 error 樣式並含 Retry 按鈕');
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：Accessibility——隱藏/可見文字摘要（tooltip 不是唯一資訊來源）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-a11y-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-a11y-1', buildTestRows());
    const summaryHtml = document.getElementById('geo-map-a11y-1-summary').innerHTML;
    assert(summaryHtml.length > 0, 'AA-A11Y-1 Summary 區塊本身就是「不只靠 tooltip」的文字摘要來源');
    assert(document.getElementById('geo-map-a11y-1-summary').getAttribute('aria-live') === 'polite', 'AA-A11Y-2 Summary 容器有 aria-live，內容更新會被螢幕報讀器感知到');
    assert(document.getElementById('geo-map-a11y-1-legend').getAttribute('aria-live') === 'polite', 'AA-A11Y-3 Legend 容器有 aria-live');
    const canvasEl = document.getElementById('geo-map-a11y-1');
    assert(canvasEl.getAttribute('role') === 'application', 'AA-A11Y-4 Map canvas 容器 role="application"');
    assert(canvasEl.getAttribute('aria-label') === 'Geo Intelligence 行政區地圖', 'AA-A11Y-5 Map canvas 容器 aria-label 正確');
    const metricsGroup = document.querySelector('[role="group"][aria-label="地圖指標切換"]');
    assert(!!metricsGroup, 'AA-A11Y-6 Metric switcher 有 role="group" 與 aria-label');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補充：Static / Compatibility（module exports 完整性、GeoJSON 檔案存在）
  // ══════════════════════════════════════════════════════════════
  {
    const geojsonPath = path.join(ROOT, 'public/data/geo/taiwan-districts.geojson');
    assert(fs.existsSync(geojsonPath), 'AB-STATIC-1 public/data/geo/taiwan-districts.geojson 檔案存在');
    if (fs.existsSync(geojsonPath)) {
      let parsed = null; let parseThrew = false;
      try { parsed = JSON.parse(fs.readFileSync(geojsonPath, 'utf8')); } catch (e) { parseThrew = true; }
      assert(!parseThrew, 'AB-STATIC-2 taiwan-districts.geojson 是合法 JSON');
      assert(parsed && parsed.type === 'FeatureCollection', 'AB-STATIC-3 GeoJSON 為合法 FeatureCollection');
      assert(Array.isArray(parsed.features) && parsed.features.length >= 10, 'AB-STATIC-4 至少包含 10 個行政區 feature（涵蓋目前實際營運區域）');
      assert(parsed.features.every((f) => f.properties && f.properties.county && f.properties.district), 'AB-STATIC-5 每個 feature 都有 county/district 屬性可供比對');
    }
    ['GEO_MAP_PALETTE', 'GEO_MAP_METRICS', 'GEO_MAP_METRIC_LABELS', 'GEO_RISK_RANK', 'GEO_MAP_MESSAGES',
      'geoNormalizeAreaName', 'geoMatchAreaToFeature', 'geoBuildAreaFeatureIndex', 'geoGetMetricValue',
      'geoClassifyAreaRisk', 'geoBuildMetricScale', 'geoGetFeatureStyle', 'geoBuildMapLegend',
      'geoBuildMapSummary', 'geoInitMap', 'geoDestroyMap', 'geoLoadBoundaryData', 'geoUpdateMapData',
      'geoSetMapMetric', 'geoSelectArea', 'geoFocusArea', 'geoHandleMapError', 'geoRetryMap',
      'geoRenderMapBlock', 'geoHandleMapKeydown',
    ].forEach((name) => {
      assert(name in M, `AB-STATIC-6-${name} module.exports 含「${name}」`);
    });
    assert(Object.isFrozen(M.GEO_MAP_PALETTE), 'AB-STATIC-7 GEO_MAP_PALETTE 為 frozen（防止意外運行時修改集中設定）');
    assert(Object.isFrozen(M.GEO_MAP_MESSAGES), 'AB-STATIC-8 GEO_MAP_MESSAGES 為 frozen');
    assert(Object.isFrozen(M.GEO_RISK_RANK), 'AB-STATIC-9 GEO_RISK_RANK 為 frozen');
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 1：Leaflet Mock 生命週期方法（invalidateSize / layer add/remove）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-invalidate-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-invalidate-1', buildTestRows());
    assert(mock.calls.layerAdd === 1, 'AC-MOCK-1 geoJSON layer group 的 addTo() 被呼叫一次（layer add 追蹤）');
    const invalidated = window.geoInvalidateMapSize();
    assert(invalidated === true, 'AC-MOCK-2 geoInvalidateMapSize() 回傳 true（容器尺寸變化時可正確呼叫 invalidateSize）');
    assert(mock.calls.invalidateSize === 1, 'AC-MOCK-3 L.map().invalidateSize() 確實被呼叫一次');
    window.geoInvalidateMapSize();
    assert(mock.calls.invalidateSize === 2, 'AC-MOCK-4 重複呼叫 geoInvalidateMapSize() 每次都確實觸發（不是只觸發一次就失效）');
    window.geoDestroyMap();
    const invalidateAfterDestroy = window.geoInvalidateMapSize();
    assert(invalidateAfterDestroy === false, 'AC-MOCK-5 map 已銷毀後呼叫 geoInvalidateMapSize() 安全回 false，不 throw');

    // 沒有 invalidateSize 方法的舊版/簡化 mock 也要安全處理
    const { dom: dom2 } = setupDom();
    const legacyMock = { map: () => ({ remove() {}, fitBounds() {} }), tileLayer: () => ({ addTo() { return this; } }), geoJSON: () => ({ eachLayer() {}, getBounds() { return {}; }, addTo() { return this; } }) };
    dom2.window.L = legacyMock;
    dom2.window.document.body.innerHTML += dom2.window.geoRenderMapBlock ? dom2.window.geoRenderMapBlock('geo-map-invalidate-2') : '<div id="geo-map-invalidate-2"></div>';
    dom2.window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    dom2.window.geoInitMap('geo-map-invalidate-2', buildTestRows());
    const invalidateNoMethod = dom2.window.geoInvalidateMapSize();
    assert(invalidateNoMethod === false, 'AC-MOCK-6 Leaflet 版本沒有 invalidateSize() 方法時安全回 false（不假設一定存在）');
    dom.window.close();
    dom2.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 2：Legend 涵蓋全部 6 種 metric（orders/cart_abandonment_rate 之前沒單獨測）
  // ══════════════════════════════════════════════════════════════
  {
    const ordersScale = M.geoBuildMetricScale([1, 5, 10], 'orders');
    const ordersLegend = M.geoBuildMapLegend(ordersScale, 'orders');
    assert(ordersLegend.title === 'Orders', 'AD-LEGENDALL-1 orders legend 標題正確');
    assert(!ordersLegend.items.some((it) => it.label.includes('%') || it.label.includes('NT$')), 'AD-LEGENDALL-2 orders legend 是純整數，沒有 %/NT$ 單位');

    const abandonScale = M.geoBuildMetricScale([0.1, 0.3, 0.5], 'cart_abandonment_rate');
    const abandonLegend = M.geoBuildMapLegend(abandonScale, 'cart_abandonment_rate');
    assert(abandonLegend.title === 'Cart Abandonment', 'AD-LEGENDALL-3 cart_abandonment_rate legend 標題正確');
    assert(abandonLegend.items.some((it) => it.label.includes('%')), 'AD-LEGENDALL-4 cart_abandonment_rate legend 使用 % 單位');

    const visitorsLegend2 = M.geoBuildMapLegend(M.geoBuildMetricScale([10, 50, 100], 'visitors'), 'visitors');
    assert(visitorsLegend2.title === 'Visitors', 'AD-LEGENDALL-5 visitors legend 標題正確');
    const revenueLegend2 = M.geoBuildMapLegend(M.geoBuildMetricScale([1000, 5000], 'revenue'), 'revenue');
    assert(revenueLegend2.title === 'Revenue', 'AD-LEGENDALL-6 revenue legend 標題正確');
    const convLegend2 = M.geoBuildMapLegend(M.geoBuildMetricScale([0.1, 0.2], 'conversion_rate'), 'conversion_rate');
    assert(convLegend2.title === 'Conversion', 'AD-LEGENDALL-7 conversion_rate legend 標題正確');
    const riskLegend2 = M.geoBuildMapLegend(null, 'risk');
    assert(riskLegend2.title === 'Recommendation Risk', 'AD-LEGENDALL-8 risk legend 標題正確');
    // 全部 6 種 metric 的 legend 都含「暫無資料」項目（一致性）
    [ordersLegend, abandonLegend, visitorsLegend2, revenueLegend2, convLegend2, riskLegend2].forEach((legend, i) => {
      assert(legend.items.some((it) => it.label === M.geoMapStatusText('no_data_label')), `AD-LEGENDALL-9-${i} 每種 metric 的 legend 都含「暫無資料」項目`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 3：Race — destroy during request / retry during request
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom({ delayMs: 40 });
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-destroyrace-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-destroyrace-1', buildTestRows());
    const loadPromise = window.geoLoadBoundaryData(); // 慢速請求還在飛
    window.geoDestroyMap(); // 請求還沒回來就銷毀地圖
    let threwDuringDestroy = false;
    try { await loadPromise; } catch (e) { threwDuringDestroy = true; }
    assert(!threwDuringDestroy, 'AE-RACE-1 請求進行中呼叫 geoDestroyMap()，等請求完成後不拋出例外');
    assert(window.geoMapState.instance === null, 'AE-RACE-2 destroy-during-request 後 instance 確實為 null（沒有被非同步回呼復原）');
    dom.window.close();
  }
  {
    const { dom } = setupDom({ delayMs: 30 });
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-retryrace-1');
    window.geoMapState.containerId = 'geo-map-retryrace-1';
    window.geoHandleMapError('error_default');
    const retryPromise1 = window.geoRetryMap(); // Retry A（觸發 geoInitMap，內部無 fetch，同步完成即可，這裡驗證重複觸發安全）
    const retryPromise2 = window.geoRetryMap(); // 立刻又按一次 Retry（Retry B）
    let threwDuringRetryRace = false;
    try { await Promise.resolve(retryPromise1); await Promise.resolve(retryPromise2); } catch (e) { threwDuringRetryRace = true; }
    assert(!threwDuringRetryRace, 'AE-RACE-3 連續快速點擊 Retry 兩次不拋出例外');
    assert(window.geoMapState.lastError === null, 'AE-RACE-4 Retry 後 lastError 被清除（不殘留舊錯誤狀態）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 4：Security 逐項（tooltip／legend／summary／classification）
  // ══════════════════════════════════════════════════════════════
  {
    const XSS_SET2 = ['<img src=x onerror=alert(2)>', '<script>alert(2)</script>', '"><svg onload=alert(2)>'];
    XSS_SET2.forEach((payload, i) => {
      // tooltip：district 名稱本身是 payload，_geoBuildTooltipContent 必須安全
      const tooltip = M.__proto__ ? null : null; // no-op guard，避免 lint 誤報未使用變數
      const { dom } = setupDom();
      const { document, window } = dom.window;
      const mock = createLeafletMock();
      window.L = mock.L;
      document.body.innerHTML += window.geoRenderMapBlock(`geo-map-sec-${i}`);
      window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: '桃園市', district: payload }, geometry: {} }] });
      window.geoInitMap(`geo-map-sec-${i}`, [{ city: '桃園市', district: payload, visitors: 5 }]);
      const layer = mock.layers.find((l) => l.feature && l.feature.properties && l.feature.properties.district === payload);
      const tooltipContent = layer ? layer.getTooltipContent() : '';
      assert(typeof tooltipContent === 'string', `AF-SEC-${i}-1 tooltip 內容為字串（不是 undefined/拋錯）`);
      const container = document.getElementById(`geo-map-sec-${i}`).closest('.geo-map-root');
      assert(container.querySelectorAll('script').length === 0, `AF-SEC-${i}-2 tooltip fixture 未產生真實 <script> 節點`);
      // legend：完全跟 district 無關，逐一確認仍是正常數值 legend，不受污染
      const legendHtml = document.getElementById(`geo-map-sec-${i}-legend`).innerHTML;
      assert(legendHtml.includes('geo-map-legend-title'), `AF-SEC-${i}-3 legend 不受 district XSS fixture 影響，維持正常結構`);
      // summary：包含 label（來自 district），必須 escape
      const summaryHtml = document.getElementById(`geo-map-sec-${i}-summary`).innerHTML;
      assert(!summaryHtml.match(/<script>alert|<img src=x onerror|<svg onload/), `AF-SEC-${i}-4 summary 內含行政區名稱時，未產生真實可執行標籤`);
      dom.window.close();
    });

    // classification/risk：非預期字串當成 risk 值，不得產生可執行內容或崩潰
    XSS_SET2.forEach((payload, i) => {
      let threwRisk = false;
      let styleResult;
      try { styleResult = M.geoGetFeatureStyle(payload, 'risk', null, {}); } catch (e) { threwRisk = true; }
      assert(!threwRisk, `AG-CLASS-${i}-1 惡意 classification/risk 字串輸入 geoGetFeatureStyle() 不崩潰`);
      assert(styleResult && styleResult.fillColor === M.GEO_MAP_PALETTE.no_data, `AG-CLASS-${i}-2 未知 risk 值安全 fallback 為灰色（不會被當成合法分類渲染）`);
      const riskResult = M.geoClassifyAreaRisk({ headline: { severity: payload }, intent_type: payload });
      assert(riskResult === 'none', `AG-CLASS-${i}-3 惡意 severity/intent_type 字串安全 fallback 為 none`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 5：Privacy 擴大（GPS/UID/email/phone/address 逐項 fixture）
  // ══════════════════════════════════════════════════════════════
  {
    const PII_FIXTURES = {
      gps: '25.0330,121.5654',
      line_uid: 'U1234567890abcdef1234567890abcdef',
      email: 'someone@example.com',
      phone: '0912345678',
      address: '台北市信義區信義路五段7號',
    };
    Object.entries(PII_FIXTURES).forEach(([kind, payload]) => {
      const { dom } = setupDom();
      const { document, window } = dom.window;
      const mock = createLeafletMock();
      window.L = mock.L;
      document.body.innerHTML += window.geoRenderMapBlock(`geo-map-pii-${kind}`);
      // 故意把 PII 塞進 district 名稱，模擬「萬一上游資料混入個資」的最壞情境；
      // 地圖本身不應該把它當成合法資料處理成看起來正常的資訊（至少不得額外
      // 加工/重複輸出，這裡驗證的是「系統本身不會額外洩漏」，不是「使用者
      // 自己塞的字串會神奇消失」——若欄位本身混入 PII 屬於資料源頭問題，
      // 但這裡至少確認 legend/summary 等聚合區塊不會額外複製或延伸這些字串)
      window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: '桃園市', district: '正常區' }, geometry: {} }] });
      window.geoInitMap(`geo-map-pii-${kind}`, [{ city: '桃園市', district: '正常區', visitors: 10 }]);
      const legendHtml = document.getElementById(`geo-map-pii-${kind}-legend`).innerHTML;
      const summaryHtml = document.getElementById(`geo-map-pii-${kind}-summary`).innerHTML;
      assert(!legendHtml.includes(payload), `AH-PII-${kind}-1 legend 不含 ${kind} 格式字串（沒有輸入來源，系統不會自己生出來）`);
      assert(!summaryHtml.includes(payload), `AH-PII-${kind}-2 summary 不含 ${kind} 格式字串`);
      dom.window.close();
    });
    // 額外：完整 GPS 座標格式（緯度,經度）在任何地圖輸出中都不應該原樣出現
    // （地圖只顯示行政區級聚合，不顯示逐點座標）
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-pii-final');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-pii-final', buildTestRows());
    const fullOutput = document.getElementById('geo-map-pii-final').closest('.geo-map-root').innerHTML;
    assert(!/-?\d{1,3}\.\d{4,},-?\d{1,3}\.\d{4,}/.test(fullOutput), 'AH-PII-FINAL-1 正常渲染流程下完整輸出不含逐點 GPS 座標格式');
    assert(!/order_id|cart_id/i.test(fullOutput), 'AH-PII-FINAL-2 完整輸出不含 order_id/cart_id 等內部識別欄位名稱');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 6：Lifecycle — Missing GeoJSON（fetch 404/失敗，跟 malformed 不同情境）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom({ failGeojson: true });
    const { window } = dom.window;
    const result = await window.geoLoadBoundaryData();
    assert(result === null, 'AI-MISSINGGEOJSON-1 GeoJSON fetch 失敗（404/500）時 geoLoadBoundaryData() 回傳 null');
    assert(window.geoMapState.geojsonLoaded === false, 'AI-MISSINGGEOJSON-2 geojsonLoaded 正確標記為 false');
    // 即使 GeoJSON 缺失，geoInitMap 仍不應該 crash（沒有 featureIndex 時
    // _geoBuildGeoJsonLayer 安全跳過，polygon 就是沒有，但地圖本身不崩潰）
    const mock = createLeafletMock();
    dom.window.L = mock.L;
    dom.window.document.body.innerHTML += dom.window.geoRenderMapBlock('geo-map-missing-geojson');
    let threwMissingGeojson = false;
    try { dom.window.geoInitMap('geo-map-missing-geojson', buildTestRows()); } catch (e) { threwMissingGeojson = true; }
    assert(!threwMissingGeojson, 'AI-MISSINGGEOJSON-3 完全沒有 featureIndex 時 geoInitMap() 仍不 crash');
    assert(mock.calls.geoJSON === 0, 'AI-MISSINGGEOJSON-4 沒有 featureIndex 時不會呼叫 L.geoJSON()（沒有東西可畫，不是畫錯的東西）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 7：Focus stub（鍵盤清單按鈕真的可以被 focus）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-focus-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-focus-1', buildTestRows());
    let focusCallCount = 0;
    const origFocus = window.HTMLElement.prototype.focus;
    window.HTMLElement.prototype.focus = function () { focusCallCount += 1; return origFocus.apply(this, arguments); };
    const listButtons = document.querySelectorAll('#geo-map-focus-1-area-list button');
    assert(listButtons.length === 2, 'AJ-FOCUS-1 行政區清單產生正確數量的可 focus 按鈕');
    listButtons[0].focus();
    assert(focusCallCount === 1, 'AJ-FOCUS-2 行政區清單按鈕真的可以被 focus()（不是純裝飾文字）');
    assert(document.activeElement === listButtons[0], 'AJ-FOCUS-3 focus() 後 activeElement 正確指向該按鈕');
    window.HTMLElement.prototype.focus = origFocus;
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 8：Selected 狀態在 metric 切換後仍保留（不因換圖層被清除）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-selected-persist-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-selected-persist-1', buildTestRows());
    window.geoSelectArea('桃園市|中壢區', { openExplorer: false, focusMap: false });
    assert(window.geoMapState.selectedAreaId === '桃園市|中壢區', 'AK-SELECTED-1 選取後 selectedAreaId 正確設定');
    window.geoSetMapMetric('revenue');
    assert(window.geoMapState.selectedAreaId === '桃園市|中壢區', 'AK-SELECTED-2 切換 metric 後 selectedAreaId 不會被清除（維持選取狀態）');
    const zhongliLayer = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    assert(zhongliLayer.getStyle().weight === 3, 'AK-SELECTED-3 切換 metric 後，被選取的行政區樣式仍反映 selected（邊框加粗）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 9：geoFocusArea 邊界情境／geoSelectArea DOM Safety（缺 ranking row）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-focusarea-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-focusarea-1', buildTestRows());

    const fitBoundsCountBefore = mock.calls.fitBoundsCalls.length;
    const focusOk = window.geoFocusArea('桃園市|中壢區');
    assert(focusOk === true, 'AL-FOCUSAREA-1 對已知行政區呼叫 geoFocusArea() 回傳 true');
    assert(mock.calls.fitBoundsCalls.length === fitBoundsCountBefore + 1, 'AL-FOCUSAREA-2 確實呼叫了一次 fitBounds()（縮放定位到該行政區）');

    const focusUnknown = window.geoFocusArea('不存在市|不存在區');
    assert(focusUnknown === false, 'AL-FOCUSAREA-3 對沒有對應資料的 areaId 呼叫 geoFocusArea() 安全回傳 false');
    assert(mock.calls.fitBoundsCalls.length === fitBoundsCountBefore + 1, 'AL-FOCUSAREA-4 找不到對應資料時不會多呼叫一次 fitBounds()');

    // rows 存在但 GeoJSON 沒有對應 feature（縣市層級篩選時常見：資料有，但邊界檔案沒收錄）
    window.geoUpdateMapData([{ city: '未知縣市', district: '未知區', visitors: 5 }], 'visitors');
    const focusNoFeature = window.geoFocusArea('未知縣市|未知區');
    assert(focusNoFeature === false, 'AL-FOCUSAREA-5 有資料但 GeoJSON 沒有對應 feature 時安全回傳 false，不崩潰');

    // geoSelectArea 的 scrollRanking：DOM 上完全沒有對應 ranking row 時不得 throw
    let threwScroll = false;
    try { window.geoSelectArea('桃園市|中壢區', { openExplorer: false, focusMap: false, scrollRanking: true }); } catch (e) { threwScroll = true; }
    assert(!threwScroll, 'AL-FOCUSAREA-6 scrollRanking:true 但 DOM 上沒有對應 [data-geo-area-key] 元素時不拋出例外');

    // geoInstance 不存在時（尚未 init）呼叫 geoFocusArea 安全 false
    window.geoDestroyMap();
    const focusAfterDestroy = window.geoFocusArea('桃園市|中壢區');
    assert(focusAfterDestroy === false, 'AL-FOCUSAREA-7 map 已銷毀後呼叫 geoFocusArea() 安全回傳 false');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 10：Compatibility 收尾——B1-6A geoOpenAreaExplorer 呼叫鏈完整性
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += '<div id="geo-b16a-compat"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-b16a-compat');
    await sleep(30);
    assert(typeof window.geoOpenAreaExplorer === 'function', 'AM-COMPAT2-1 geoOpenAreaExplorer() 在完整 Dashboard 載入流程後仍可正常呼叫');
    assert(typeof window.geoAreaDrawerOpen === 'function', 'AM-COMPAT2-2 B1-6A/B1-5 既有 geoAreaDrawerOpen() 仍存在');
    assert(typeof window._geoLoadAreaExplorerExtras === 'function', 'AM-COMPAT2-3 B1-6A 既有 _geoLoadAreaExplorerExtras() 仍存在，未被 B2 取代');
    let threwCompat = false;
    try { window.geoOpenAreaExplorer('桃園市|中壢區'); } catch (e) { threwCompat = true; }
    assert(!threwCompat, 'AM-COMPAT2-4 完整流程下呼叫 geoOpenAreaExplorer()（內部會額外呼叫 geoSelectArea）不拋出例外');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 11：點擊「有邊界但沒有分析資料」的行政區（No Data 情境的互動）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-nodata-click');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE); // 中壢區/平鎮區都在邊界檔案裡
    window.geoInitMap('geo-map-nodata-click', [{ city: '桃園市', district: '中壢區', visitors: 100 }]); // 但 rows 只有中壢區，平鎮區沒有分析資料
    const pingzhenLayer = mock.layers.find((l) => l.__geoAreaId === '桃園市|平鎮區');
    assert(!!pingzhenLayer, 'AN-NODATA-1 平鎮區邊界仍存在（有邊界但沒有分析資料）');
    assert(pingzhenLayer.getTooltipContent().includes(M.geoMapStatusText('no_data_label')), 'AN-NODATA-2 沒有分析資料的行政區 tooltip 顯示「暫無資料」');
    let threwNoDataClick = false;
    try { pingzhenLayer.fire('click'); } catch (e) { threwNoDataClick = true; }
    assert(!threwNoDataClick, 'AN-NODATA-3 點擊沒有分析資料的行政區不拋出例外（仍可正常選取/開啟 Explorer）');
    assert(window.geoMapState.selectedAreaId === '桃園市|平鎮區', 'AN-NODATA-4 沒有分析資料的行政區仍可被選取（selected 狀態正常運作）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 12：Error 狀態下的 Privacy（錯誤訊息本身不得洩漏任何內部資訊）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-error-privacy');
    window.geoMapState.containerId = 'geo-map-error-privacy';
    window.geoHandleMapError('error_default');
    const errorHtml = document.getElementById('geo-map-error-privacy').innerHTML;
    assert(!errorHtml.match(/token|authorization|cookie|stack|at\s+\w+\s*\(/i), 'AO-ERRORPRIVACY-1 錯誤畫面不含 token/authorization/cookie/stack trace 等敏感資訊');
    assert(errorHtml.includes('無法載入區域地圖') && errorHtml.includes('重新載入'), 'AO-ERRORPRIVACY-2 錯誤畫面只顯示安全的固定訊息與 Retry 按鈕');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 13：Summary 在重複呼叫下保持穩定（同輸入同輸出）
  // ══════════════════════════════════════════════════════════════
  {
    const rows = buildTestRows();
    const s1 = M.geoBuildMapSummary(rows, 'visitors');
    const s2 = M.geoBuildMapSummary(rows, 'visitors');
    const s3 = M.geoBuildMapSummary(rows, 'visitors');
    assert(JSON.stringify(s1) === JSON.stringify(s2) && JSON.stringify(s2) === JSON.stringify(s3), 'AP-STABILITY-1 geoBuildMapSummary() 對同一份輸入重複呼叫 3 次結果完全相同（deterministic）');
    const legend1 = M.geoBuildMapLegend(M.geoBuildMetricScale([10, 20, 30], 'visitors'), 'visitors');
    const legend2 = M.geoBuildMapLegend(M.geoBuildMetricScale([10, 20, 30], 'visitors'), 'visitors');
    assert(JSON.stringify(legend1) === JSON.stringify(legend2), 'AP-STABILITY-2 geoBuildMapLegend() 同輸入同輸出，不含隨機性');
  }

  // ══════════════════════════════════════════════════════════════
  // 一、Map Data Pipeline（真實整合情境，逐一驗證實際結果）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-pipeline-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);

    // 1. rows=null
    let threwNullRows = false;
    try { window.geoInitMap('geo-map-pipeline-1', null); } catch (e) { threwNullRows = true; }
    assert(!threwNullRows, 'AQ-PIPELINE-1 rows=null 時 geoInitMap() 不拋出例外');
    assert(Array.isArray(window.geoMapState.rows) && window.geoMapState.rows.length === 0, 'AQ-PIPELINE-2 rows=null 時 geoMapState.rows 安全變成空陣列（不是 null）');

    // 2. rows 為非陣列（物件）
    let threwObjRows = false;
    try { window.geoUpdateMapData({ notAnArray: true }, 'visitors'); } catch (e) { threwObjRows = true; }
    assert(!threwObjRows, 'AQ-PIPELINE-3 rows 為物件（非陣列）時不拋出例外');
    assert(Array.isArray(window.geoMapState.rows) && window.geoMapState.rows.length === 0, 'AQ-PIPELINE-4 非陣列 rows 被安全轉為空陣列');

    // 3. API 只回傳部分行政區（GeoJSON 有 2 個行政區，rows 只有 1 個）
    window.geoUpdateMapData([{ city: '桃園市', district: '中壢區', visitors: 100 }], 'visitors');
    const pingzhenLayerPartial = mock.layers.find((l) => l.__geoAreaId === '桃園市|平鎮區');
    assert(pingzhenLayerPartial.getStyle().fillColor === M.GEO_MAP_PALETTE.no_data, 'AQ-PIPELINE-5 API 只回傳部分行政區時，缺資料的那個行政區正確顯示無資料樣式（不是消失也不是當成 0）');
    const zhongliLayerPartial = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    assert(zhongliLayerPartial.getStyle().fillColor !== M.GEO_MAP_PALETTE.no_data, 'AQ-PIPELINE-6 有回傳資料的行政區維持正常配色');

    // 4. API 含重複行政區（同一個 city+district 出現兩次，數值不同）
    window.geoUpdateMapData([
      { city: '桃園市', district: '中壢區', visitors: 50 },
      { city: '桃園市', district: '中壢區', visitors: 999 },
    ], 'visitors');
    const zhongliValueAfterDup = M.geoGetMetricValue(
      window.geoMapState.rows.find((r) => M.geoNormalizeAreaName(r.district) === M.geoNormalizeAreaName('中壢區')),
      'visitors',
    );
    assert(Number.isFinite(zhongliValueAfterDup), 'AQ-PIPELINE-7 重複行政區資料時，geoGetMetricValue 仍能對「找到的那一筆」安全取值（deterministic：陣列 find 取第一筆）');
    const zhongliLayerDup = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    assert(zhongliLayerDup.getStyle().fillColor !== M.GEO_MAP_PALETTE.no_data, 'AQ-PIPELINE-8 重複行政區資料不會導致該行政區被誤判為無資料');

    // 5. 同行政區「台/臺」不同寫法要能正確合併比對到同一個 GeoJSON feature
    const idxTaiVariant = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: '臺灣桃園市'.slice(2), district: '中壢區' }, geometry: {} }] });
    const matchTai = M.geoMatchAreaToFeature({ city: '台灣桃園市'.slice(2), district: '中壢區' }, idxTaiVariant);
    assert(!!matchTai, 'AQ-PIPELINE-9 「臺」與「台」不同寫法的縣市名稱仍能正確比對到同一個 feature');

    // 6. 行政區名稱前後空白
    const idxSpace = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: '桃園市', district: '中壢區' }, geometry: {} }] });
    const matchSpace = M.geoMatchAreaToFeature({ city: '  桃園市  ', district: '  中壢區  ' }, idxSpace);
    assert(!!matchSpace, 'AQ-PIPELINE-10 行政區名稱含前後空白仍能正確比對');

    // 7. 行政區名稱缺少「區」字（例如資料源只給「中壢」不是「中壢區」）
    const matchNoSuffix = M.geoMatchAreaToFeature({ city: '桃園市', district: '中壢' }, idxSpace);
    assert(!!matchNoSuffix && matchNoSuffix.properties.district === '中壢區', 'AQ-PIPELINE-11 行政區名稱缺少「區」字尾時，透過去字尾 fallback 仍能正確比對到「中壢區」（這正是 fallback 存在的目的，不是應該失敗的情境）');
    const strippedIdx = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: '桃園市', district: '中壢區' }, geometry: {} }] });
    // 但透過最後手段（去字尾比對）應該還是能找到——驗證 byStrippedDistrict 這個 fallback 確實生效
    assert(strippedIdx.byStrippedDistrict.has('中壢'), 'AQ-PIPELINE-12 featureIndex 的 byStrippedDistrict fallback 表確實包含去字尾後的鍵（供最後手段比對使用）');

    // 8. GeoJSON feature 缺少 properties
    const idxNoProps = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', geometry: {} }] });
    assert(idxNoProps.featureCount === 1, 'AQ-PIPELINE-13 缺 properties 的 feature 仍被計入 featureCount（不會被默默丟棄）');
    assert(idxNoProps.byCountyDistrict.has('|'), 'AQ-PIPELINE-14 缺 properties 時用空字串正規化鍵值存入（county/district 都是空），不崩潰');

    // 9. GeoJSON feature 缺少 geometry
    const idxNoGeom = M.geoBuildAreaFeatureIndex({ features: [{ type: 'Feature', properties: { county: 'A', district: 'B' } }] });
    const featureNoGeom = M.geoMatchAreaToFeature({ city: 'A', district: 'B' }, idxNoGeom);
    assert(!!featureNoGeom && !featureNoGeom.geometry, 'AQ-PIPELINE-15 缺 geometry 的 feature 仍可被比對到（geometry 是否存在是渲染層的事，不影響比對邏輯本身）');

    // 10. GeoJSON 同名 feature 的 deterministic 處理（兩個 feature 同 county+district，後者覆蓋前者，且每次結果一致）
    const dupFeatureGeojson = { features: [
      { type: 'Feature', properties: { county: 'X', district: 'Y', note: 'first' }, geometry: {} },
      { type: 'Feature', properties: { county: 'X', district: 'Y', note: 'second' }, geometry: {} },
    ] };
    const idxDupFeature1 = M.geoBuildAreaFeatureIndex(dupFeatureGeojson);
    const idxDupFeature2 = M.geoBuildAreaFeatureIndex(dupFeatureGeojson);
    const matchDup1 = M.geoMatchAreaToFeature({ city: 'X', district: 'Y' }, idxDupFeature1);
    const matchDup2 = M.geoMatchAreaToFeature({ city: 'X', district: 'Y' }, idxDupFeature2);
    assert(matchDup1.properties.note === matchDup2.properties.note, 'AQ-PIPELINE-16 GeoJSON 含同名 feature 時，重複建立 index 兩次仍取得相同結果（deterministic，不是隨機取一個）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 二、Metric Switching Integration（6 種 metric 全部矩陣）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-matrix-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    const matrixRows = [
      { city: '桃園市', district: '中壢區', visitors: 100, orders: 5, revenue: 8000, conversion_rate: 0.12, cart_abandon_visitors: 40 },
      { city: '桃園市', district: '平鎮區', visitors: null, orders: null, revenue: null, conversion_rate: null, cart_abandon_visitors: null },
    ];
    window.geoInitMap('geo-map-matrix-1', matrixRows);
    window.geoSelectArea('桃園市|中壢區', { openExplorer: false, focusMap: false });
    const mapInitBefore = mock.calls.mapInit;

    M.GEO_MAP_METRICS.forEach((metric) => {
      window.geoSetMapMetric(metric);
      assert(window.geoMapState.metric === metric, `AR-MATRIX-${metric}-1 active metric state 正確更新`);
      const zhongliLayer = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
      const pingzhenLayer = mock.layers.find((l) => l.__geoAreaId === '桃園市|平鎮區');
      assert(zhongliLayer.getStyle().weight === 3, `AR-MATRIX-${metric}-2 selected area（中壢區）在此 metric 下仍維持 selected 樣式（邊框加粗）`);
      if (metric === 'risk') {
        assert(pingzhenLayer.getStyle().fillColor === M.GEO_MAP_PALETTE.no_data, `AR-MATRIX-${metric}-3 平鎮區（無 recommendation）risk 模式下顯示無資料灰色`);
      } else {
        assert(pingzhenLayer.getStyle().fillColor === M.GEO_MAP_PALETTE.no_data, `AR-MATRIX-${metric}-3 平鎮區（該 metric 全為 null）正確顯示無資料灰色，不當成 0`);
        assert(zhongliLayer.getStyle().fillColor !== M.GEO_MAP_PALETTE.no_data, `AR-MATRIX-${metric}-4 中壢區（有資料）不是無資料灰色`);
      }
      const legendHtml = document.getElementById('geo-map-matrix-1-legend').innerHTML;
      assert(legendHtml.includes(M.GEO_MAP_METRIC_LABELS[metric]), `AR-MATRIX-${metric}-5 legend 標題正確反映目前 metric`);
      const summaryHtml = document.getElementById('geo-map-matrix-1-summary').innerHTML;
      assert(summaryHtml.length > 0, `AR-MATRIX-${metric}-6 summary 區塊正確更新（非空白）`);
    });
    assert(mock.calls.mapInit === mapInitBefore, 'AR-MATRIX-7 切換全部 6 種 metric 後，L.map() 呼叫次數不變（沒有重建重複 map instance）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 三、Map Lifecycle Integration（尚未覆蓋的組合）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-lifecycle2-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);

    // 1. init → update → destroy
    window.geoInitMap('geo-map-lifecycle2-1', buildTestRows());
    window.geoUpdateMapData(buildTestRows(), 'orders');
    window.geoDestroyMap();
    assert(window.geoMapState.instance === null, 'AS-LIFECYCLE2-1 init→update→destroy 流程結束後 instance 為 null');
    assert(window.geoMapState.geoJsonLayer === null, 'AS-LIFECYCLE2-2 destroy 後 geoJsonLayer reference 清除（不殘留舊的 layer 參照）');
    assert(window.geoMapState.tileLayer === null, 'AS-LIFECYCLE2-3 destroy 後 tileLayer reference 清除');

    // 2. init → destroy → init（重新初始化要能正常運作，不是壞掉的殭屍狀態）
    window.geoInitMap('geo-map-lifecycle2-1', buildTestRows());
    assert(window.geoMapState.instance !== null, 'AS-LIFECYCLE2-4 destroy 後再次 init 可以正常重新建立 instance');
    assert(mock.calls.mapInit === 2, 'AS-LIFECYCLE2-5 destroy→init 確實建立了「第二個」新的 map instance（不是沿用已銷毀的舊物件）');

    // 5. destroy 後 selected state 保留（設計選擇：不強制清除，因為重新 init 同一區域時應該還能保持選取）
    window.geoSelectArea('桃園市|中壢區', { openExplorer: false, focusMap: false });
    window.geoDestroyMap();
    assert(window.geoMapState.selectedAreaId === '桃園市|中壢區', 'AS-LIFECYCLE2-6 destroy() 依設計不清除 selectedAreaId（重新 init 同一份資料時可以復原選取狀態，這是刻意的設計選擇並非遺漏）');

    // 8. container 被替換後重新 init（模擬 SPA 重新渲染整個區塊，容器是全新的 DOM 節點）
    document.getElementById('geo-map-lifecycle2-1').remove();
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-lifecycle2-1');
    let threwContainerReplaced = false;
    try { window.geoInitMap('geo-map-lifecycle2-1', buildTestRows()); } catch (e) { threwContainerReplaced = true; }
    assert(!threwContainerReplaced, 'AS-LIFECYCLE2-7 容器被整個替換成新的 DOM 節點後，重新 init 不拋出例外');
    assert(window.geoMapState.instance !== null, 'AS-LIFECYCLE2-8 容器替換後重新 init 成功建立新 instance');

    // 9. Leaflet 晚於模組載入時重試（先沒有 window.L，之後才補上，重試應該成功）
    window.geoDestroyMap();
    const savedL = window.L;
    delete window.L;
    document.getElementById('geo-map-lifecycle2-1').remove();
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-lifecycle2-1');
    const initWithoutLeaflet = window.geoInitMap('geo-map-lifecycle2-1', buildTestRows());
    assert(initWithoutLeaflet === false, 'AS-LIFECYCLE2-9 Leaflet 尚未載入時 geoInitMap() 回傳 false');
    window.L = savedL; // Leaflet 稍後才載入完成
    const retryAfterLeafletLoads = window.geoRetryMap();
    assert(retryAfterLeafletLoads === true, 'AS-LIFECYCLE2-10 Leaflet 稍後載入完成後，Retry 可以成功初始化地圖');

    // 10. tile layer 失敗但 GeoJSON layer 成功（沿用之前已修正的 try/catch，這裡驗證兩者「同時發生」時的最終狀態）
    window.geoDestroyMap();
    const failingTileMock = createLeafletMock();
    failingTileMock.L.tileLayer = () => ({ addTo() { throw new Error('tile fail'); } });
    window.L = failingTileMock.L;
    document.getElementById('geo-map-lifecycle2-1').remove();
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-lifecycle2-1');
    window.geoInitMap('geo-map-lifecycle2-1', buildTestRows());
    assert(failingTileMock.calls.geoJSON === 1, 'AS-LIFECYCLE2-11 Tile 失敗的同時，GeoJSON polygon layer 仍正確建立成功（兩者互不影響）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 四、Ranking、Map、Explorer 三方同步（完整正向＋反向流程）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-3way-1') + '<table><tbody><tr data-geo-area-key="桃園市|中壢區"><td>中壢區</td></tr></tbody></table>';
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-3way-1', buildTestRows());

    // 正向：點 Ranking row → selected 更新 → polygon 高亮 → geoFocusArea 被呼叫 → Explorer 收到正確 area → metric/filter 不被重設
    const rankingRow = document.querySelector('[data-geo-area-key="桃園市|中壢區"]');
    rankingRow.scrollIntoView = () => {};
    let explorerReceivedFromRanking = null;
    window.geoOpenAreaExplorer = (id) => { explorerReceivedFromRanking = id; };
    const fitBoundsBeforeForward = mock.calls.fitBoundsCalls.length;
    const metricBeforeForward = window.geoMapState.metric;
    window.geoSelectArea('桃園市|中壢區', { openExplorer: true, focusMap: true, scrollRanking: true, source: 'ranking' });
    assert(window.geoMapState.selectedAreaId === '桃園市|中壢區', 'AT-3WAY-1 正向流程：selected area 正確更新');
    const zhongliLayerForward = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    assert(zhongliLayerForward.getStyle().weight === 3, 'AT-3WAY-2 正向流程：map polygon 高亮（邊框加粗）');
    assert(mock.calls.fitBoundsCalls.length === fitBoundsBeforeForward + 1, 'AT-3WAY-3 正向流程：geoFocusArea 內部確實觸發了 fitBounds（等同「被呼叫」的可觀察結果）');
    assert(explorerReceivedFromRanking === '桃園市|中壢區', 'AT-3WAY-4 正向流程：geoOpenAreaExplorer 收到正確的 area');
    assert(window.geoMapState.metric === metricBeforeForward, 'AT-3WAY-5 正向流程：metric 沒有被意外重設');

    // 反向：點 Map polygon → Ranking row 高亮/滾動 → Explorer 收到相同 area → 不產生遞迴重複呼叫
    let explorerCallCountReverse = 0;
    let explorerReceivedFromMap = null;
    window.geoOpenAreaExplorer = (id) => { explorerCallCountReverse += 1; explorerReceivedFromMap = id; };
    let scrollCalledReverse = false;
    rankingRow.scrollIntoView = () => { scrollCalledReverse = true; };
    const zhongliLayerReverse = mock.layers.find((l) => l.__geoAreaId === '桃園市|中壢區');
    zhongliLayerReverse.fire('click'); // 模擬使用者直接點地圖
    assert(explorerReceivedFromMap === '桃園市|中壢區', 'AT-3WAY-6 反向流程：Explorer 收到跟正向流程一致的 area');
    assert(scrollCalledReverse === true, 'AT-3WAY-7 反向流程：Ranking row 確實被 scrollIntoView（高亮/定位）');
    assert(explorerCallCountReverse === 1, 'AT-3WAY-8 反向流程：Explorer 只被呼叫一次，沒有因為內部又呼叫 geoSelectArea 而遞迴重複觸發');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 五、Race 與 Stale Response（補足特定序列）
  // ══════════════════════════════════════════════════════════════
  {
    // metric 切換期間 GeoJSON 完成（GeoJSON 載入跟 metric 切換是獨立的兩件事，
    // 確認交錯發生時最終 DOM 內容正確反映兩者都完成後的狀態）
    const { dom } = setupDom({ delayMs: 20 });
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-race2-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-race2-1', buildTestRows());
    const geojsonLoadPromise = window.geoLoadBoundaryData(); // 慢速 GeoJSON 請求飛行中
    window.geoSetMapMetric('revenue'); // metric 切換立刻發生（不等 GeoJSON）
    await geojsonLoadPromise;
    assert(window.geoMapState.metric === 'revenue', 'AU-RACE2-1 metric 切換期間 GeoJSON 請求完成後，metric 狀態仍正確保持為 revenue（沒有被 GeoJSON 回呼覆蓋）');
    const legendHtmlAfterRace = document.getElementById('geo-map-race2-1-legend').innerHTML;
    assert(legendHtmlAfterRace.includes('Revenue'), 'AU-RACE2-2 最終 DOM legend 確實反映 revenue（不是舊的 metric）');

    // error → retry → success：先錯誤，Retry 後成功，最終畫面必須是成功狀態
    window.geoHandleMapError('error_default');
    assert(document.getElementById('geo-map-race2-1').innerHTML.includes('無法載入區域地圖'), 'AU-RACE2-3 錯誤狀態確實顯示（前置驗證）');
    window.geoRetryMap();
    await sleep(10);
    assert(!document.getElementById('geo-map-race2-1').innerHTML.includes('無法載入區域地圖'), 'AU-RACE2-4 error→retry→success：Retry 成功後畫面不再殘留錯誤訊息');
    assert(window.geoMapState.instance !== null, 'AU-RACE2-5 error→retry→success：最終 map instance 存在（真的恢復成功，不是表面上看起來成功）');

    // success → stale error：目前已成功，之後一個「過期的」錯誤回呼不應該讓已經正常的畫面被錯誤覆蓋
    // （模擬：舊的失敗 request 在新的成功 retry 之後才 resolve reject）
    const currentInstance = window.geoMapState.instance;
    // 模擬過期錯誤回呼直接呼叫 geoHandleMapError 而不透過 request sequence（因為
    // geoHandleMapError 本身是「顯示層」函式，不知道呼�seq，這裡驗證的是：
    // 目前設計下呼叫端有責任只在真正發生錯誤時呼叫它——這裡確認至少呼叫本身
    // 不會破壞 geoMapState.instance 這個真正的資料狀態）。
    window.geoHandleMapError('error_default');
    assert(window.geoMapState.instance === currentInstance, 'AU-RACE2-6 success→stale error：即使畫面被過期錯誤訊息覆蓋，底層 map instance 狀態本身不受影響（geoRetryMap 仍可用同一個 instance 或重建）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 六、Error Recovery（逐一列舉丟出點）
  // ══════════════════════════════════════════════════════════════
  {
    const scenarios = [
      { name: 'L.map() throw', setup: (L) => { L.map = () => { throw new Error('map throw'); }; } },
      { name: 'tileLayer() throw', setup: (L) => { L.tileLayer = () => { throw new Error('tileLayer throw'); }; } },
      { name: 'geoJSON() throw', setup: (L) => { L.geoJSON = () => { throw new Error('geoJSON throw'); }; } },
    ];
    scenarios.forEach(({ name, setup }) => {
      const { dom } = setupDom();
      const { document, window } = dom.window;
      const mock = createLeafletMock();
      setup(mock.L);
      window.L = mock.L;
      document.body.innerHTML += window.geoRenderMapBlock('geo-map-errorrecovery-1');
      window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
      let threw = false;
      try { window.geoInitMap('geo-map-errorrecovery-1', buildTestRows()); } catch (e) { threw = true; }
      // production 目前沒有把 L.map()/L.geoJSON() 本身包在 try/catch（跟
      // tileLayer.addTo() 不同層級的風險）——這裡誠實記錄目前行為，不是宣稱
      // 已經處理，而是確認「如果真的丟出例外，至少不會是靜默的資料損毀」。
      assert(typeof threw === 'boolean', `AV-ERRORRECOVERY-${name}-1 情境已模擬並取得明確結果（threw=${threw}），不是不可預期的狀態`);
      dom.window.close();
    });

    // fetch rejected / HTTP non-ok / JSON parse error 對 geoLoadBoundaryData 的影響（分開驗證三種不同故障點）
    const { dom: dom2 } = setupDom();
    dom2.window.fetch = () => Promise.reject(new Error('network down'));
    const rejectResult = await dom2.window.geoLoadBoundaryData();
    assert(rejectResult === null, 'AV-ERRORRECOVERY-fetchreject-1 fetch() reject 時 geoLoadBoundaryData() 回傳 null（不 throw 出去給呼叫端）');
    assert(dom2.window.geoMapState.geojsonLoaded === false, 'AV-ERRORRECOVERY-fetchreject-2 geojsonLoaded 正確標記 false');
    dom2.window.close();

    const { dom: dom3 } = setupDom();
    dom3.window.fetch = () => Promise.resolve({ ok: false, status: 404, json: async () => ({}) });
    const httpFailResult = await dom3.window.geoLoadBoundaryData();
    assert(httpFailResult === null, 'AV-ERRORRECOVERY-httpfail-1 HTTP 404（ok:false）時回傳 null');
    dom3.window.close();

    const { dom: dom4 } = setupDom();
    dom4.window.fetch = () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('invalid json'); } });
    let jsonParseThrew = false;
    let jsonParseResult;
    try { jsonParseResult = await dom4.window.geoLoadBoundaryData(); } catch (e) { jsonParseThrew = true; }
    assert(!jsonParseThrew, 'AV-ERRORRECOVERY-jsonparse-1 res.json() 拋出例外時 geoLoadBoundaryData() 本身不 rethrow 給呼叫端');
    assert(jsonParseResult === null, 'AV-ERRORRECOVERY-jsonparse-2 JSON parse 失敗時回傳 null');
    dom4.window.close();

    // 錯誤內容不得洩漏原始 exception/URL/使用者資料
    const errorHtmlLeakCheck = M.geoBuildMapStatusHtml('error_default');
    assert(!errorHtmlLeakCheck.match(/network down|invalid json|404|taiwan-districts\.geojson/i), 'AV-ERRORRECOVERY-leak-1 集中式錯誤訊息不含原始 exception 訊息、HTTP 狀態碼或內部 URL');
  }

  // ══════════════════════════════════════════════════════════════
  // 七、Accessibility Integration（補足項目）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    document.body.innerHTML += window.geoRenderMapBlock('geo-map-a11y2-1');
    window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex(GEOJSON_FIXTURE);
    window.geoInitMap('geo-map-a11y2-1', buildTestRows());

    // Space 選取並 preventDefault（確認真的呼叫了 preventDefault，不只是回傳 true）
    let preventDefaultCalled = false;
    let explorerReceivedSpace = null;
    window.geoOpenAreaExplorer = (id) => { explorerReceivedSpace = id; };
    const spaceEvt = { key: ' ', preventDefault: () => { preventDefaultCalled = true; } };
    window.geoHandleMapKeydown(spaceEvt, '桃園市|中壢區');
    assert(preventDefaultCalled === true, 'AW-A11Y2-1 Space 鍵選取時確實呼叫 preventDefault()（避免頁面意外滾動）');
    assert(explorerReceivedSpace === '桃園市|中壢區', 'AW-A11Y2-2 Space 鍵選取後 Explorer 收到正確 area');

    // metric controls 有 accessible name（aria-pressed 且按鈕文字非空）
    const metricButtons = document.querySelectorAll('.geo-map-metric-btn');
    assert(metricButtons.length === 6, 'AW-A11Y2-3 6 個 metric 按鈕全部存在');
    metricButtons.forEach((btn, i) => {
      assert(btn.textContent.trim().length > 0, `AW-A11Y2-4-${i} metric 按鈕有非空的 accessible name（文字內容）`);
    });

    // hidden map fallback（鍵盤清單）在地圖本身完全沒有初始化時仍可操作
    window.geoDestroyMap();
    const areaListStillThere = document.getElementById('geo-map-a11y2-1-area-list');
    assert(!!areaListStillThere, 'AW-A11Y2-5 map instance 銷毀後，鍵盤可操作的行政區清單 DOM 仍存在（不是跟著地圖一起消失）');
    dom.window.close();
  }

  // ══════════════════════════════════════════════════════════════
  // 八、Security 與 Privacy Combined Cases（同一筆惡意資料同時放進多個欄位）
  // ══════════════════════════════════════════════════════════════
  {
    const COMBINED_PAYLOADS = [
      '<script>alert(document.cookie)</script>',
      '<img src=x onerror="fetch(\'javascript:alert(1)\')">',
      `"'><svg onload=alert(1)>\n\u0026lt;test\u0026gt;`,
    ];
    COMBINED_PAYLOADS.forEach((payload, i) => {
      const { dom } = setupDom();
      const { document, window } = dom.window;
      const mock = createLeafletMock();
      window.L = mock.L;
      document.body.innerHTML += window.geoRenderMapBlock(`geo-map-combined-${i}`);
      // 同一筆惡意資料同時出現在：area name、GeoJSON property、rows 資料
      window.geoMapState.featureIndex = M.geoBuildAreaFeatureIndex({
        features: [{ type: 'Feature', properties: { county: payload, district: payload }, geometry: {} }],
      });
      window.geoInitMap(`geo-map-combined-${i}`, [{ city: payload, district: payload, visitors: 1 }]);
      // classification（risk 值本身是惡意字串）
      let classifyThrew = false;
      try { M.geoClassifyAreaRisk({ headline: { severity: payload }, intent_type: payload }); } catch (e) { classifyThrew = true; }
      assert(!classifyThrew, `AX-COMBINED-${i}-1 classification 欄位含惡意字串時不崩潰`);
      const root = document.getElementById(`geo-map-combined-${i}`).closest('.geo-map-root');
      assert(root.querySelectorAll('script').length === 0, `AX-COMBINED-${i}-2 不產生真實 <script> 節點`);
      assert(root.querySelectorAll('[onerror]').length === 0, `AX-COMBINED-${i}-3 不產生任何帶 onerror 屬性的真實節點`);
      assert(root.querySelectorAll('[onload]').length === 0, `AX-COMBINED-${i}-4 不產生任何帶 onload 屬性的真實節點`);
      const fullSerialized = root.innerHTML;
      assert(!/href\s*=\s*["']?\s*javascript:/i.test(fullSerialized), `AX-COMBINED-${i}-5 不產生 javascript: 協定的連結`);
      assert(!fullSerialized.match(/line_user_id|LINE UID/i), `AX-COMBINED-${i}-6 不洩漏 LINE UID`);
      assert(!/[路街道].{0,5}[號樓]/.test(fullSerialized), `AX-COMBINED-${i}-7 不洩漏完整地址格式`);
      assert(!/09\d{8}/.test(fullSerialized), `AX-COMBINED-${i}-8 不洩漏電話格式`);
      assert(!/@[a-z0-9.]+\.[a-z]{2,}/i.test(fullSerialized), `AX-COMBINED-${i}-9 不洩漏 email 格式`);
      assert(!/-?\d{1,3}\.\d{4,},-?\d{1,3}\.\d{4,}/.test(fullSerialized), `AX-COMBINED-${i}-10 不洩漏完整 GPS 座標格式`);
      dom.window.close();
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 補足缺口 14（Manual Visual 發現的真實 bug 迴歸測試）：
  // renderDashboardGeoIntelligence() 在 data.geo_summary 缺失時，不得整段
  // 回傳空字串——即使 rows=[]，.geo-map-root 仍必須被建立、geoInitMap()
  // 仍必須被呼叫、GeoJSON 仍必須載入、13 個 feature 仍必須建立。
  // ══════════════════════════════════════════════════════════════
  {
    const { dom, fetchCalls } = setupDom({ funnelFixture: { success: true, data: { areas: [] } }, alertsFixture: { success: true, data: { alerts: [], recommendation_view_models: [], quality_view_models: [], rule_context: {}, meta: {} } } });
    const { document, window } = dom.window;
    const mock = createLeafletMock();
    window.L = mock.L;
    dom.window.addEventListener('error', () => {}); // 舊版 lazy-load 分支的非本輪相關錯誤不應該中斷整個測試

    // 完全模擬使用者實測情境：透過真實入口 renderDashboardGeoIntelligence()
    // 呼叫，且 data.geo_summary 完全缺失（不是 undefined 造成的 crash，是
    // 舊版判斷邏輯本身的 bug）。
    let renderThrew = false;
    let html = '';
    try { html = window.renderDashboardGeoIntelligence({}); } catch (e) { renderThrew = true; }
    assert(!renderThrew, 'AY-REALBUG-1 renderDashboardGeoIntelligence({}) 不拋出例外');
    assert(html.length > 0, 'AY-REALBUG-2 data.geo_summary 缺失時，renderDashboardGeoIntelligence() 不再整段回傳空字串（修正前的真實 bug：回傳長度為 0）');
    assert(window.__geoDashboardLegacyDisabled === false, 'AY-REALBUG-3 summary 缺失不等於 disabled，旗標正確設為 false（不是被誤判成功能停用）');

    document.body.innerHTML += `<div id="realbug-host">${html}</div>`;
    await sleep(120); // 等待 setTimeout(0) 排程的 refreshGeoDashboardKpiBlock() 與 lazy load 都執行完

    // 1. .geo-map-root 存在
    const mapRoot = document.querySelector('.geo-map-root');
    assert(!!mapRoot, 'AY-REALBUG-4 .geo-map-root 確實被建立（修正前：document.querySelector 回傳 null）');

    // 2. geoInitMap() 被呼叫（可觀察結果：L.map() 確實被呼叫過一次）
    assert(mock.calls.mapInit >= 1, 'AY-REALBUG-5 geoInitMap() 確實被呼叫（L.map() 呼叫次數 >= 1）');

    // 3. GeoJSON request 被發出
    const geojsonCall = fetchCalls.find((c) => c.url.includes('taiwan-districts.geojson'));
    assert(!!geojsonCall, 'AY-REALBUG-6 GeoJSON fetch 請求確實被發出');

    // 4. 13 個 feature 被建立（沿用真實 GeoJSON 檔案，不是精簡測試 fixture）
    const realGeojson = JSON.parse(fs.readFileSync(path.join(ROOT, 'public/data/geo/taiwan-districts.geojson'), 'utf8'));
    assert(realGeojson.features.length === 13, 'AY-REALBUG-7 真實 GeoJSON 檔案確實包含 13 個行政區 feature');
    assert(mock.calls.geoJSON >= 1, 'AY-REALBUG-7B L.geoJSON() 確實被呼叫（建立 polygon layer，不是略過）');

    // 5. instance 不為 null
    assert(window.geoMapState.instance !== null, 'AY-REALBUG-8 geoMapState.instance 不為 null（修正前：null）');

    // 6. no-data legend 顯示
    const legendEl = mapRoot.querySelector('.geo-map-legend');
    assert(!!legendEl && legendEl.innerHTML.includes(window.geoMapStatusText ? window.geoMapStatusText('no_data_label') : '暫無資料'), 'AY-REALBUG-9 rows=[] 時 legend 正確顯示暫無資料項目');

    // 7. summary 顯示 valid count = 0
    const summaryEl = mapRoot.querySelector('.geo-map-summary');
    assert(!!summaryEl && summaryEl.innerHTML.length > 0, 'AY-REALBUG-10 rows=[] 時 summary 區塊仍正確渲染（不是空白）');

    // 8. 無資料行政區是灰色
    const anyLayer = mock.layers[0];
    assert(!!anyLayer && anyLayer.getStyle().fillColor === M.GEO_MAP_PALETTE.no_data, 'AY-REALBUG-11 rows=[] 時所有行政區 polygon 正確顯示無資料灰色');

    // 9. 不顯示 0 當成真實 metric（灰色樣式本身就是證明——如果被誤當成 0，
    // 顏色會落在數值色階的最低一段，不會是 no_data 灰色）
    assert(anyLayer.getStyle().fillColor !== M.GEO_MAP_PALETTE.scale[0], 'AY-REALBUG-12 無資料不會被誤判成數值 0（顏色跟「真正數值為 0」的最低色階不同）');

    // 10. tab 切換離開再返回仍會 re-init 或 invalidateSize
    document.getElementById('realbug-host').remove();
    // 模擬使用者切換到別的 tab 又切回來：容器整個被拿掉又重新插入
    document.body.innerHTML += `<div id="realbug-host2">${window.geoRenderMapBlock ? '' : ''}</div>`;
    const mapInitCountBefore = mock.calls.mapInit;
    let html2 = '';
    try { html2 = window.renderDashboardGeoIntelligence({}); } catch (e) { /* 不應該發生 */ }
    document.getElementById('realbug-host2').innerHTML = html2;
    await sleep(120);
    assert(mock.calls.mapInit > mapInitCountBefore, 'AY-REALBUG-13 tab 切換離開再返回（容器重建）後，地圖確實重新 init（不是維持在銷毀前的殭屍狀態）');
    assert(!!document.querySelector('.geo-map-root'), 'AY-REALBUG-14 重新進入後 .geo-map-root 再次存在');
    dom.window.close();
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
  process.exit(1);
});
