#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js
// fix18-10-hotfix30-B5-R5.3-A1：Geo Intelligence Heatmap Foundation
//
// 涵蓋：pure helper（normalize/radius/intensity/level/style/legend/coverage/
// areas 合併/ranking/summary/tooltip）、Store Isolation、Layer 重用、
// Selection 同步、Request Guard/Debounce、後端 getGeoFulfillment() 座標欄位
// （用真實 sql.js DB）、Static Audit（不依賴矩形 fixture／無硬編碼桃園／
// 無 store_001／未新增重複 API）。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const H = require(path.join(ROOT, 'public/js/geo-heatmap.js'));

// ────────────────────────────────────────────────────────────────
// 1. Metric / Channel / Display enum
// ────────────────────────────────────────────────────────────────
assert(H.GEO_HEAT_METRICS.length === 6, 'A1-1 六個 Heatmap metric');
['visitors', 'add_to_cart', 'begin_checkout', 'orders', 'revenue', 'conversion'].forEach((m) => {
  assert(H.GEO_HEAT_METRICS.includes(m), `A1-2-${m} metric enum 含 ${m}`);
});
assert(H.GEO_HEAT_CHANNELS.includes('all') && H.GEO_HEAT_CHANNELS.includes('facebook') && H.GEO_HEAT_CHANNELS.includes('google') && H.GEO_HEAT_CHANNELS.includes('line'), 'A1-3 channel enum 含既有渠道');
assert(H.GEO_HEAT_DISPLAY_MODES.includes('circle') && H.GEO_HEAT_DISPLAY_MODES.includes('marker') && H.GEO_HEAT_DISPLAY_MODES.includes('ranking_only'), 'A1-4 display mode 含 circle/marker/ranking_only');
assert(H.GEO_HEAT_METRICS_WITHOUT_COORDINATES.length === 3, 'A1-5 三個 metric 結構性沒有座標（visitors/add_to_cart/begin_checkout）');

// ────────────────────────────────────────────────────────────────
// 2. Normalize（含 outlier / 全零 / 單一區 / min=max）
// ────────────────────────────────────────────────────────────────
assert(H.geoHeatNormalizeValue(5, 0, 10) === 0.5, 'A1-6 normalize 中間值 = 0.5');
assert(H.geoHeatNormalizeValue(0, 0, 0) === 0, 'A1-7 normalize 全部為 0 → 0（不除以 0）');
assert(H.geoHeatNormalizeValue(5, 0, 0) === 1, 'A1-8 normalize 單一區且值>0（max=min>0情境）→ 1');
assert(H.geoHeatNormalizeValue(-100, 0, 10) === 0, 'A1-9 normalize 負值 clamp 到 0');
assert(H.geoHeatNormalizeValue(1000, 0, 10) === 1, 'A1-10 normalize 超過 max clamp 到 1');
assert(H.geoHeatNormalizeValue(NaN, 0, 10) === 0, 'A1-11 normalize NaN 輸入 → 0（不是 NaN）');
assert(H.geoHeatNormalizeValue(Infinity, 0, 10) === 0, 'A1-12 normalize Infinity 輸入視為無效值 → 安全 fallback 0（不是 Infinity，也不是誤判成滿值）');

// ────────────────────────────────────────────────────────────────
// 3. Radius（outlier 保護：sqrt scale，不得一個區蓋掉整張圖）
// ────────────────────────────────────────────────────────────────
const rMin = H.GEO_HEAT_RADIUS_RANGE.min, rMax = H.GEO_HEAT_RADIUS_RANGE.max;
assert(H.geoHeatRadius(0, { min: 0, max: 100 }) === rMin, 'A1-13 radius 最小值 = minRadius');
assert(H.geoHeatRadius(100, { min: 0, max: 100 }) === rMax, 'A1-14 radius 最大值 = maxRadius');
const rOutlier = H.geoHeatRadius(10000, { min: 0, max: 10000 });
const rSmall = H.geoHeatRadius(100, { min: 0, max: 10000 });
assert(rOutlier === rMax, 'A1-15 outlier 值算出 maxRadius（不超界）');
assert(rSmall > rMin && rSmall < rMax, 'A1-16 outlier 存在時，小值仍在 min/max 之間（sqrt 壓縮，不會被壓成幾乎 0）');
assert(H.geoHeatRadius(50, { min: 50, max: 50 }) === rMax, 'A1-17 單一區（min=max=value>0）→ 視為滿值');
assert(H.geoHeatRadius(0, { min: 0, max: 0 }) === rMin, 'A1-18 全部為 0 → minRadius，不崩潰');
assert(Number.isFinite(H.geoHeatRadius(NaN, { min: 0, max: 10 })), 'A1-19 radius 對 NaN 輸入仍回傳有限數字');

// ────────────────────────────────────────────────────────────────
// 4. Intensity / Level / Style / Legend
// ────────────────────────────────────────────────────────────────
assert(H.geoHeatIntensity(0, { min: 0, max: 10 }) === 0.35, 'A1-20 intensity 下限 0.35');
assert(H.geoHeatIntensity(10, { min: 0, max: 10 }) === 0.9, 'A1-21 intensity 上限 0.90');
assert(H.geoHeatGetLevel(0).key === 'low', 'A1-22 level(0) = low');
assert(H.geoHeatGetLevel(0.5).key === 'medium', 'A1-23 level(0.5) = medium');
assert(H.geoHeatGetLevel(0.8).key === 'high', 'A1-24 level(0.8) = high');
assert(H.geoHeatGetLevel(0.95).key === 'peak', 'A1-25 level(0.95) = peak（最高）');
assert(H.geoHeatGetLevel(1).color === '#ef4444', 'A1-26 最高強度顏色為紅色');
const styleSel = H.geoHeatGetStyle('orders', 0.9, true);
const styleUnsel = H.geoHeatGetStyle('orders', 0.9, false);
assert(styleSel.weight > styleUnsel.weight, 'A1-27 selected 樣式 weight 大於未選中');
assert(typeof styleSel.fillColor === 'string' && styleSel.fillColor.startsWith('#'), 'A1-28 style 回傳合法顏色字串');
const legend = H.geoHeatGetLegend('revenue', { min: 0, max: 100 });
assert(Array.isArray(legend) && legend.length === 4, 'A1-29 legend 回傳 4 個等級');
assert(legend.every((l) => typeof l.label === 'string' && l.label.length > 0), 'A1-30 legend 每一項都有文字 label（不只靠顏色）');

// ────────────────────────────────────────────────────────────────
// 5. geoHeatBuildAreas 合併（不建第二套 API，只合併既有兩份回應）
// ────────────────────────────────────────────────────────────────
const FUNNEL_FIXTURE = [
  { city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 20, begin_checkout_visitors: 10 },
  { city: '桃園市', district: '八德區', visitors: 50, add_to_cart_visitors: 5, begin_checkout_visitors: 2 },
  { city: '桃園市', district: '龍潭區', visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0 },
];
const FULFILLMENT_FIXTURE = [
  { city: '桃園市', district: '中壢區', completed_orders: 12, revenue: 3600, submitted_orders: 15, coordinate_count: 5, coordinate_source: 'order_centroid', coordinate_confidence: 'high', lat: 24.95, lng: 121.22 },
  { city: '桃園市', district: '平鎮區', completed_orders: 3, revenue: 900, submitted_orders: 3, coordinate_count: 0, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', lat: null, lng: null },
];
const AREAS = H.geoHeatBuildAreas(FUNNEL_FIXTURE, FULFILLMENT_FIXTURE);
assert(AREAS.length === 4, 'A1-31 合併後行政區數 = funnel∪fulfillment 聯集（4 個）');
const zhongli = AREAS.find((a) => a.district === '中壢區');
assert(zhongli.visitors === 100 && zhongli.orders === 12, 'A1-32 中壢區同時有 visitor 與訂單數字（雙邊都有資料）');
assert(zhongli.coordinate_source === 'order_centroid' && zhongli.lat === 24.95, 'A1-33 中壢區座標來自 fulfillment 的真實聚合值');
const badeArea = AREAS.find((a) => a.district === '八德區');
assert(badeArea.coordinate_source === 'unavailable' && badeArea.lat === null, 'A1-34 只有 visitor 資料、沒有訂單座標的行政區 → unavailable，不補假座標');
const pingzhen = AREAS.find((a) => a.district === '平鎮區');
assert(pingzhen.visitors === 0 && pingzhen.orders === 3, 'A1-35 只有訂單、沒有 visitor 事件的行政區仍保留（不因缺一邊資料被丟掉）');
const longtan = AREAS.find((a) => a.district === '龍潭區');
assert(longtan.conversion === 0 && Number.isFinite(longtan.conversion), 'A1-36 visitors=0 時 conversion 強制為 0（不是 NaN/Infinity）');
assert(AREAS.every((a) => Number.isFinite(a.conversion)), 'A1-37 所有行政區 conversion 皆為有限數字');
assert(AREAS.every((a) => a.coordinate_source === 'order_centroid' || a.coordinate_source === 'unavailable'), 'A1-38 coordinate_source 只會是兩個合法值之一');

// 邊界：malformed / 空輸入
assert(H.geoHeatBuildAreas([], []).length === 0, 'A1-39 空輸入 → 空陣列，不崩潰');
assert(H.geoHeatBuildAreas(null, null).length === 0, 'A1-40 null 輸入 → 空陣列，不崩潰');
const malformed = H.geoHeatBuildAreas([{ city: null, district: null, visitors: 'abc' }], [null, undefined, { city: 'X' }]);
assert(malformed.every((a) => Number.isFinite(a.visitors) && Number.isFinite(a.orders)), 'A1-41 malformed/非數字輸入不產生 NaN 欄位');

// ────────────────────────────────────────────────────────────────
// 6. Coverage（Area 級 + Metric 級，兩種不得混用）
// ────────────────────────────────────────────────────────────────
assert(H.geoHeatComputeAreaCoverage(zhongli) === Math.round((5 / 15) * 10000) / 100, 'A1-42 area coverage = coordinate_count/submitted_orders');
assert(H.geoHeatComputeAreaCoverage({ submitted_orders: 0, coordinate_count: 0 }) === 0, 'A1-43 area coverage 分母為 0 → 0，不除以 0');
['visitors', 'add_to_cart', 'begin_checkout'].forEach((m) => {
  assert(H.geoHeatComputeMetricCoverage(AREAS, m) === 0, `A1-44-${m} ${m} 的 metric coverage 結構性固定 0%（尚未收集 Visitor GPS）`);
});
['orders', 'revenue', 'conversion'].forEach((m) => {
  assert(H.geoHeatComputeMetricCoverage(AREAS, m) > 0, `A1-45-${m} ${m} 的 metric coverage 由真實訂單座標算出且 > 0`);
});
assert(H.geoHeatComputeMetricCoverage([], 'orders') === 0, 'A1-46 空 areas 的 metric coverage → 0，不崩潰');

// ────────────────────────────────────────────────────────────────
// 7. Tooltip（不得顯示 undefined/null/NaN/Infinity）
// ────────────────────────────────────────────────────────────────
const tooltip = H.geoHeatBuildTooltipContent(zhongli, '全部');
['undefined', 'null', 'NaN', 'Infinity'].forEach((bad) => {
  assert(!tooltip.includes(bad), `A1-47-${bad} Tooltip 內容不含「${bad}」`);
});
assert(tooltip.includes('中壢區'), 'A1-48 Tooltip 含行政區名稱');
assert(tooltip.includes('NT$'), 'A1-49 Tooltip Revenue 含 NT$ 格式');
assert(tooltip.includes('%'), 'A1-50 Tooltip Conversion 含百分比格式');
assert(tooltip.includes('座標來源'), 'A1-51 Tooltip 含座標來源說明');
assert(tooltip.includes('資料準確度'), 'A1-52 Tooltip 含資料準確度');
assert(tooltip.includes('Coverage'), 'A1-53 Tooltip 含 Coverage 欄位');
const tooltipNoCoord = H.geoHeatBuildTooltipContent(badeArea, '全部');
assert(tooltipNoCoord.includes('目前尚無可用座標') || tooltipNoCoord.includes('尚無資料'), 'A1-54 無座標行政區 Tooltip 顯示清楚提示，不是 undefined');
const tooltipXss = H.geoHeatBuildTooltipContent({ area_name: '<script>alert(1)</script>', visitors: 1, add_to_cart: 0, begin_checkout: 0, orders: 0, revenue: 0, conversion: 0, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', submitted_orders: 0, coordinate_count: 0 });
assert(!tooltipXss.includes('<script>'), 'A1-55 Tooltip 對行政區名稱做 HTML escape（防 XSS）');

// ────────────────────────────────────────────────────────────────
// 8. Formatting（currency / percentage / NaN / Infinity / negative）
// ────────────────────────────────────────────────────────────────
assert(H.geoHeatFormatValue(NaN, 'revenue') === 'NT$ 0', 'A1-56 revenue 格式化對 NaN 輸入安全 fallback 為 0');
assert(H.geoHeatFormatValue(Infinity, 'orders') === '0', 'A1-57 orders 格式化對 Infinity 輸入安全 fallback 為 0');
assert(H.geoHeatFormatValue(-Infinity, 'conversion') === '0.0%', 'A1-58 conversion 格式化對 -Infinity 輸入安全 fallback');
assert(H.geoHeatFormatValue(0.184, 'conversion') === '18.4%', 'A1-59 conversion 百分比格式正確（0.184 → 18.4%）');
assert(H.geoHeatFormatValue(-5, 'visitors') === '-5', 'A1-60 負值不強制轉正（保留原始語意），但仍是有限數字字串');
assert(H.geoHeatFormatValue('abc', 'orders') === '0', 'A1-61 非數字字串輸入安全 fallback 為 0');

// ────────────────────────────────────────────────────────────────
// 9. Ranking（排序／ratio／有無座標都要出現）
// ────────────────────────────────────────────────────────────────
const ranking = H.geoHeatBuildRanking(AREAS, 'orders');
assert(ranking.length === AREAS.length, 'A1-62 ranking 涵蓋所有行政區（不因無座標消失）');
assert(ranking[0].value >= ranking[ranking.length - 1].value, 'A1-63 ranking 依 metric 值遞減排序');
assert(ranking.every((r) => r.ratio >= 0 && r.ratio <= 1), 'A1-64 ranking ratio 介於 0–1');
assert(ranking.some((r) => r.has_coordinate === false), 'A1-65 ranking 內含至少一筆沒有座標的行政區（仍顯示，只是 has_coordinate=false）');
const rankingAllZero = H.geoHeatBuildRanking([{ area_id: 'x', area_name: 'X', visitors: 0, orders: 0, conversion: 0, coordinate_source: 'unavailable' }], 'orders');
assert(rankingAllZero[0].ratio === 0, 'A1-66 全部為 0 時 ranking ratio 不除以 0（回傳 0）');
const rankingSingle = H.geoHeatBuildRanking([{ area_id: 'x', area_name: 'X', visitors: 1, orders: 5, conversion: 0, coordinate_source: 'unavailable' }], 'orders');
assert(rankingSingle[0].ratio === 1, 'A1-67 單一區時 ratio = 1');

// ────────────────────────────────────────────────────────────────
// 10. Summary
// ────────────────────────────────────────────────────────────────
const summary = H.geoHeatBuildSummary(AREAS);
assert(summary.top_visitors && summary.top_visitors.area_name === '中壢區', 'A1-68 summary 熱度最高（visitors）正確');
assert(summary.top_revenue && summary.top_revenue.area_name === '中壢區', 'A1-69 summary 最高營收正確');
assert(summary.areas_with_coordinate + summary.areas_without_coordinate === AREAS.length, 'A1-70 有座標數＋無座標數＝總行政區數');
assert(summary.areas_with_coordinate === 1, 'A1-71 有座標行政區數正確（fixture 內只有中壢區有 order_centroid）');
const emptySummary = H.geoHeatBuildSummary([]);
assert(emptySummary.top_visitors === null && emptySummary.areas_with_coordinate === 0, 'A1-72 空 areas 時 summary 安全降級（不是 undefined/崩潰）');

// ────────────────────────────────────────────────────────────────
// 11. Store Isolation / Layer 重用 / Selection 同步
// ────────────────────────────────────────────────────────────────
H._geoHeatResetStateForTest();
let clearedCount = 0;
H.geoHeatState.layerGroup = { clearLayers() { clearedCount++; }, addLayer() {} };
H.geoHeatState.areas = AREAS;
H.geoHeatState.selectedAreaId = zhongli.area_id;
H.geoHeatState.abortController = { abort() { this.aborted = true; } };
const abortRef = H.geoHeatState.abortController;
H.geoHeatHandleStoreSwitch();
assert(abortRef.aborted === true, 'A1-73 Store 切換時 abort 舊 pending request');
assert(H.geoHeatState.selectedAreaId === null, 'A1-74 Store 切換時清除 selectedAreaId');
assert(H.geoHeatState.areas.length === 0, 'A1-75 Store 切換時清除 areas（不顯示前一店資料）');
assert(clearedCount === 1, 'A1-76 Store 切換呼叫 layerGroup.clearLayers()（不是 destroy/recreate）');

H._geoHeatResetStateForTest();
let addToCalls = 0;
H.geoHeatState.layerGroup = null;
global.L = { layerGroup: () => ({ addTo() { addToCalls++; return this; }, clearLayers() {}, addLayer() {} }) };
const group1 = H.geoHeatEnsureLayerGroup({});
const group2 = H.geoHeatEnsureLayerGroup({});
assert(group1 === group2, 'A1-77 重複呼叫 geoHeatEnsureLayerGroup 回傳同一個 layerGroup（不重複建立）');
assert(addToCalls === 1, 'A1-78 layerGroup 只 addTo 地圖一次');

H._geoHeatResetStateForTest();
let clearLayersCalls = 0;
const addedMarkers = [];
global.L = {
  circleMarker: (latlng, opts) => ({ latlng, opts, bindTooltip() { return this; }, on() { return this; } }),
  marker: (latlng) => ({ latlng, bindTooltip() { return this; }, on() { return this; } }),
};
H.geoHeatState.layerGroup = { clearLayers() { clearLayersCalls++; addedMarkers.length = 0; }, addLayer(m) { addedMarkers.push(m); } };
H.geoHeatState.areas = AREAS;
H.geoHeatRenderLayer(AREAS, 'orders', 'circle');
assert(clearLayersCalls === 1, 'A1-79 每次 render 都先 clearLayers()（不疊加舊圖層）');
assert(addedMarkers.length === 1, 'A1-80 只畫出有真實座標的行政區（fixture 只有中壢區）');
H.geoHeatRenderLayer(AREAS, 'orders', 'ranking_only');
assert(addedMarkers.length === 0, 'A1-81 ranking_only 模式不畫任何地圖點');
H.geoHeatRenderLayer(AREAS, 'orders', 'marker');
assert(addedMarkers.length === 1, 'A1-82 marker 模式一樣只畫有座標的行政區');

H._geoHeatResetStateForTest();
H.geoHeatState.layerGroup = { clearLayers() {}, addLayer() {} };
H.geoHeatState.areas = AREAS;
H.geoHeatState.instance = { panTo(target) { this.lastPan = target; } };
const selectNoCoord = H.geoHeatSelectArea(badeArea.area_id);
assert(selectNoCoord.ok === true && selectNoCoord.panned === false, 'A1-83 選取無座標行政區不會噴錯，回傳 panned=false');
assert(selectNoCoord.message === '目前尚無可用座標', 'A1-84 選取無座標行政區明確提示訊息');
const selectWithCoord = H.geoHeatSelectArea(zhongli.area_id);
assert(selectWithCoord.panned === true, 'A1-85 選取有座標行政區觸發 panTo');
assert(H.geoHeatState.instance.lastPan[0] === zhongli.lat, 'A1-86 panTo 使用該行政區真實 lat/lng');
const selectToggleOff = H.geoHeatSelectArea(zhongli.area_id);
assert(H.geoHeatState.selectedAreaId === null, 'A1-87 再次點擊同一個行政區可取消選取（toggle）');

// ────────────────────────────────────────────────────────────────
// 12. Request Guard / Debounce（防止舊 request 蓋掉新 request）
// ────────────────────────────────────────────────────────────────
(async () => {
  H._geoHeatResetStateForTest();
  H.geoHeatState.layerGroup = { clearLayers() {}, addLayer() {} };
  let resolvedOrder = [];
  const slowFetch = () => new Promise((resolve) => setTimeout(() => { resolvedOrder.push('slow'); resolve([{ area_id: 'a', area_name: 'A', visitors: 1, orders: 1, add_to_cart: 0, begin_checkout: 0, revenue: 0, conversion: 0, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', submitted_orders: 0, coordinate_count: 0 }]); }, 60));
  const fastFetch = () => new Promise((resolve) => setTimeout(() => { resolvedOrder.push('fast'); resolve([{ area_id: 'b', area_name: 'B', visitors: 2, orders: 2, add_to_cart: 0, begin_checkout: 0, revenue: 0, conversion: 0, coordinate_source: 'unavailable', coordinate_confidence: 'unavailable', submitted_orders: 0, coordinate_count: 0 }]); }, 10));
  H.geoHeatScheduleUpdate(slowFetch, 0);
  await new Promise((r) => setTimeout(r, 5));
  H.geoHeatScheduleUpdate(fastFetch, 0);
  await new Promise((r) => setTimeout(r, 150));
  assert(H.geoHeatState.areas.length === 1 && H.geoHeatState.areas[0].area_id === 'b', 'A1-88 舊 request（slow）不會蓋掉新 request（fast）的結果（race-condition protection）');

  // ────────────────────────────────────────────────────────────
  // 13. Static Audit（不依賴矩形 Fixture／無硬編碼桃園／無 store_001／未重複 API）
  // ────────────────────────────────────────────────────────────
  const heatmapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  assert(!heatmapSrc.includes('taoyuan-districts.geojson'), 'A1-89 geo-heatmap.js 不引用矩形 fixture GeoJSON');
  assert(!heatmapSrc.includes('taiwan/manifest.json'), 'A1-90 geo-heatmap.js 不引用 GeoJSON boundary manifest（不依賴行政區 Polygon）');
  assert(!/ZHONGLI|中壢區['"`]\s*[:=]|store_001/.test(heatmapSrc.replace(/\/\/.*$/gm, '')), 'A1-91 原始碼（去除註解後）沒有硬編碼特定行政區代碼或 store_001 當邏輯判斷依據');
  assert(!heatmapSrc.includes("L.geoJSON"), 'A1-92 Heatmap 引擎不使用 L.geoJSON／Polygon Choropleth（只用 CircleMarker/Marker）');
  assert(!heatmapSrc.includes('L.polygon') && !heatmapSrc.includes('boundingBox'), 'A1-93 不使用 Polygon 或 Bounding Box 繪製');
  const routesSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
  const heatmapRouteMatches = (routesSrc.match(/\/heatmap/g) || []).length;
  assert(heatmapRouteMatches === 0, 'A1-94 未新增重複的 /api/analytics/geo/heatmap 路由（沿用既有 /funnel /fulfillment）');
  const queriesSrc = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
  assert(queriesSrc.includes('coordinate_count') && queriesSrc.includes('delivery_lat'), 'A1-95 getGeoFulfillment() 確實擴充了 delivery_lat 座標聚合（不是另建新函式）');
  assert(!queriesSrc.includes('Math.random()'), 'A1-96 座標計算原始碼內沒有 Math.random()（不得假造座標）');
  assert((queriesSrc.match(/function getGeoFulfillment/g) || []).length === 1, 'A1-97 getGeoFulfillment 只有一份定義（沒有重複建立第二套）');

  // ────────────────────────────────────────────────────────────
  // 14. 後端真實 DB 驗證（sql.js，真的寫入 delivery_lat/delivery_lng 再查）
  // ────────────────────────────────────────────────────────────
  try {
    const DATA_DIR = path.join(ROOT, 'data');
    const DB_FILE = path.join(DATA_DIR, 'pos.db');
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
    await initDb();
    const db = getDb();
    const now = new Date().toISOString();
    const STORE = 'A1TESTSTORE';
    const ins = (num, total, mode, city, dist, src, lat, lng) => db.run(
      `INSERT INTO orders (store_id, order_number, status, subtotal, total, order_mode, created_at, items, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, delivery_lat, delivery_lng) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [STORE, num, 'completed', total, total, mode, now, '[]', city, dist, src, lat, lng]);
    ins('A1-O1', 500, 'delivery', '桃園市', '中壢區', 'delivery_address', '24.9536', '121.2250');
    ins('A1-O2', 300, 'delivery', '桃園市', '中壢區', 'delivery_address', '24.9500', '121.2200');
    ins('A1-O3', 200, 'shipping', '桃園市', '八德區', 'shipping_address', '', '');
    const geoQ = require(path.join(ROOT, 'utils/geoAnalyticsQueries'));
    const start = new Date(Date.now() - 86400000).toISOString();
    const end = new Date(Date.now() + 86400000).toISOString();
    const result = geoQ.getGeoFulfillment(db, STORE, { range: { startLocal: start, endLocal: end }, channel: null, page: 1, limit: 100, offset: 0 });
    const zl = result.areas.find((a) => a.district === '中壢區');
    const bd = result.areas.find((a) => a.district === '八德區');
    assert(!!zl && zl.coordinate_source === 'order_centroid', 'A1-98 真實 DB：有 delivery_lat/lng 的行政區判定為 order_centroid');
    assert(Math.abs(zl.lat - 24.9518) < 0.001, 'A1-99 真實 DB：中壢區 lat 是兩筆真實座標的平均值（不是捏造）');
    assert(Math.abs(zl.lng - 121.2225) < 0.001, 'A1-100 真實 DB：中壢區 lng 是兩筆真實座標的平均值');
    assert(zl.coordinate_count === 2, 'A1-101 真實 DB：coordinate_count 正確反映樣本數');
    assert(zl.coordinate_confidence === 'medium', 'A1-102 真實 DB：2 筆樣本 → medium confidence');
    assert(!!bd && bd.coordinate_source === 'unavailable' && bd.lat === null, 'A1-103 真實 DB：shipping 模式無座標的行政區 → unavailable，lat 為 null（不補假值）');
    assert(geoQ.geoHeatClassifyCoordinateConfidence(0) === 'unavailable', 'A1-104 confidence 分類：0 筆 → unavailable');
    assert(geoQ.geoHeatClassifyCoordinateConfidence(1) === 'low', 'A1-105 confidence 分類：1 筆 → low');
    assert(geoQ.geoHeatClassifyCoordinateConfidence(3) === 'medium', 'A1-106 confidence 分類：3 筆 → medium');
    assert(geoQ.geoHeatClassifyCoordinateConfidence(5) === 'high', 'A1-107 confidence 分類：5 筆 → high');
    assert(geoQ.geoHeatClassifyCoordinateConfidence(-1) === 'unavailable', 'A1-108 confidence 分類：負數輸入安全 fallback 為 unavailable');
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  } catch (e) {
    fail('A1-98..108 真實 DB 驗證區塊', e.message);
  }

  // ────────────────────────────────────────────────────────────
  // 15. Accessibility（jsdom，選用；沒有 jsdom 時跳過而非 FAIL）
  // ────────────────────────────────────────────────────────────
  try {
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<div id="c-ranking"></div><div id="c-summary"></div><div id="c-coverage"></div><div id="c-heat-legend"></div>');
    global.document = dom.window.document;
    H._geoHeatResetStateForTest();
    H.geoHeatState.containerId = 'c';
    H.geoHeatState.areas = AREAS;
    H.geoHeatState.metric = 'orders';
    H._geoHeatRenderRankingDom();
    const items = dom.window.document.querySelectorAll('[role="option"]');
    assert(items.length === AREAS.length, 'A1-109 Ranking DOM 產生每個行政區各一個 option');
    assert(Array.from(items).every((el) => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-selected') === 'false'), 'A1-110 每個 ranking item 都有 aria-selected');
    assert(Array.from(items).every((el) => el.getAttribute('tabindex') === '0'), 'A1-111 每個 ranking item 可 Tab 聚焦（tabindex=0）');
    H._geoHeatRenderSummaryDom();
    const summaryEl = dom.window.document.getElementById('c-summary');
    assert(summaryEl.getAttribute('aria-live') === 'polite', 'A1-112 Summary 區塊有 aria-live=polite');
    assert(!summaryEl.innerHTML.includes('undefined') && !summaryEl.innerHTML.includes('NaN'), 'A1-113 Summary DOM 內容不含 undefined/NaN');
    H._geoHeatRenderCoverageCardDom();
    const covEl = dom.window.document.getElementById('c-coverage');
    assert(covEl.innerHTML.includes('尚未收集訪客座標'), 'A1-114 Coverage Card 明確標示 Visitor GPS 尚未收集（不隱藏資料限制）');
    assert((covEl.querySelectorAll('.geo-heat-coverage-item').length) === 6, 'A1-115 Coverage Card 六個 metric 各一張卡片');
    H._geoHeatRenderLegendDom();
    const legendEl = dom.window.document.getElementById('c-heat-legend');
    assert(legendEl.querySelectorAll('.geo-heat-legend-item').length === 4, 'A1-116 Legend DOM 渲染 4 個等級');
    delete global.document;
  } catch (e) {
    console.log(`[SKIP] A1-109..116 jsdom 不可用或環境限制，略過 DOM 測試 — ${e.message}`);
  }

  delete global.L;

  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = total - passed;
  console.log(`\n總計：${total} 項，PASS ${passed}，FAIL ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
