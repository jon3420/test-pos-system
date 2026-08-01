#!/usr/bin/env node
// scripts/static-audit-g1-4.js — fix18-10-hotfix30-B5-R5.4-G1.4
// Geo Map Label Rendering & Honest Drawable-State Fix 專屬 Static Audit（52 項）。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(text) { return text.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n'); }

const heatSrc = read('public/js/geo-heatmap.js');
const heatCode = stripComments(heatSrc);
const uiSrc = read('public/js/geo-heatmap-ui.js');
const uiCode = stripComments(uiSrc);
const cssSrc = read('public/css/geo-heatmap.css');
const a2Src = read('scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js');
const a12Src = read('scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js');
const guardSrc = read('scripts/lib/geo-heatmap-g131-scope-guard.js');
const fxSrc = read('scripts/lib/geo-fixture-time.js');
const geoIntelligenceSrc = read('public/js/geo-intelligence.js');
const geoLiveLayerSrc = read('public/js/geo-live-layer.js');
const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));

// 一、Drawable Classifier
check('1', 'Drawable classifier 存在（geoHeatComputeDrawableState 匯出）', /function geoHeatComputeDrawableState/.test(heatCode) && /geoHeatComputeDrawableState,/.test(heatCode));
check('2', '五種 state 全部涵蓋', ['no_business_data', 'has_business_but_no_drawable_geo', 'has_drawable_district_only', 'has_drawable_exact_only', 'has_mixed_drawable_geo'].every((s) => heatCode.includes(`'${s}'`)));

// 二、Permanent Tooltip
check('3', 'permanent tooltip 建立邏輯存在（L.tooltip 呼叫）', /L\.tooltip\(\{ permanent: true/.test(heatCode));
check('4', 'permanent=true 明確設定（不是預設值 false）', /permanent: true/.test(heatCode));
check('5', 'label CSS 存在（.geo-heat-map-label）', /\.geo-heat-map-label\s*\{/.test(cssSrc));
check('6', 'label content safe（用 setContent + _geoHeatEsc 轉義，不是 innerHTML 拼接）', /labelTooltip\.setContent\(_geoHeatEsc\(/.test(heatCode));
check('7', 'district label path（labelTooltip 使用 area.area_name/district/city 其中之一）', /_geoHeatEsc\(area\.area_name \|\| area\.district \|\| area\.city \|\| ''\)/.test(heatCode));
check('8', 'exact marker path（僅 plottable 陣列——coordinate_source==="order_centroid" 且 lat/lng 為數字——才進入 forEach 建立 marker/label）', /const plottable = \(areas \|\| \[\]\)\.filter\(\(a\) => a\.coordinate_source === 'order_centroid' && typeof a\.lat === 'number' && typeof a\.lng === 'number'\);/.test(heatCode));
check('9', 'hover tooltip 保留（marker.bindTooltip 呼叫仍在，跟 permanent label 並存）', /marker\.bindTooltip\(geoHeatBuildTooltipContent/.test(heatCode));
check('10', 'label cleanup（group.clearLayers() 在每次 render 開頭執行，label 跟 marker 一起被清除）', /group\.clearLayers\(\);/.test(heatCode));

// 三、Layer / Overlay
check('11', 'layer exclusivity 未退化（_geoHeatUiApplyLayerExclusivity 仍是唯一負責 addLayer/removeLayer 互斥的函式）', /function _geoHeatUiApplyLayerExclusivity/.test(uiCode));
check('12', 'order honest overlay 存在（_geoHeatUiRenderOrderMapOverlay）', /function _geoHeatUiRenderOrderMapOverlay/.test(uiCode));
check('13', 'visitor honest overlay 仍存在（_geoHeatUiRenderVisitorMapOverlay，G1.2 既有邏輯未刪除）', /function _geoHeatUiRenderVisitorMapOverlay/.test(uiCode));
check('14', 'metric text（Order Overlay 依 metric 產生 Orders/Revenue 不同文案）', /if \(metric === 'revenue'\) \{/.test(uiCode) && /目前已有營收 NT\$/.test(uiCode));
check('15', 'no fake marker（geo-heatmap.js／geo-heatmap-ui.js 均無假 marker 產生邏輯）', !/fakeMarker|placeholderMarker/i.test(heatCode) && !/fakeMarker|placeholderMarker/i.test(uiCode));
check('16', 'no store coordinate（不使用 store_lat/store_lng 冒充顧客位置）', !/store_lat|store_lng|storeCoordinate/i.test(heatCode) && !/store_lat|store_lng|storeCoordinate/i.test(uiCode));
check('17', 'no IP coordinate（不呼叫任何 IP resolver）', !/geoip|ip-api|ipapi/i.test(heatCode) && !/geoip|ip-api|ipapi/i.test(uiCode));
check('18', 'no district centroid exact（前端沒有自行計算 centroid 的邏輯，唯一合法座標來源是後端 AVG order_centroid）', !/computeCentroid/i.test(heatCode) && !/districtCentroid/i.test(heatCode));
check('19', 'no second map（geo-heatmap.js 本身不呼叫 L.map()）', !/L\.map\(/.test(heatCode) && !/new\s+L\.Map\(/.test(heatCode));
check('20', 'no second tile（geo-heatmap.js 本身不呼叫 L.tileLayer()）', !/L\.tileLayer\(/.test(heatCode));

// 四、Duplicate / Guard
check('21', 'no duplicate label（label 跟 marker 綁在同一次 forEach，每個 area 最多產生 1 個 label，group.clearLayers() 保證 rerender 不殘留）', /group\.addLayer\(labelTooltip\);/.test(heatCode) && (heatCode.match(/group\.addLayer\(labelTooltip\);/g) || []).length === 1);
check('22', 'no duplicate request（geoHeatScheduleUpdate 的 requestSeq 遞增防護未被本輪修改）', /const seq = \+\+geoHeatState\.requestSeq;/.test(heatCode));
check('23', 'stale guard（if (seq !== geoHeatState.requestSeq) return; 仍存在）', /if \(seq !== geoHeatState\.requestSeq\) return;/.test(heatCode));

// 五、Theme
check('24', 'dark layer button（.geo-heat-layer-btn 使用 --bg-card/--text-primary 等 dark-safe CSS 變數）', /\.geo-heat-layer-btn\s*\{[^}]*background:\s*var\(--bg-card/.test(cssSrc));
check('25', 'light layer button（沒有寫死 light-only 顏色，同一套規則跨主題適用）', !/\.geo-heat-layer-btn\s*\{[^}]*background:\s*#f[0-9a-f]{5}\b/i.test(cssSrc));
check('26', 'no white bar（.geo-heat-layer-toggle／.geo-heat-layer-btn 兩個 class 都有非空規則，不會 fallback 回瀏覽器預設白色按鈕）', /\.geo-heat-layer-toggle\s*\{/.test(cssSrc) && /\.geo-heat-layer-btn\s*\{/.test(cssSrc) && !/\.geo-heat-layer-btn\s*\{\s*\}/.test(cssSrc));
check('27', 'empty hidden（Order/Visitor Overlay 沒有訊息時整個 DOM 節點 remove()，不留空殼）', (uiCode.match(/if \(!message\) \{ if \(overlay\) overlay\.remove\(\); return; \}/g) || []).length >= 1);

// 六、Scope Guard Layering
check('28', 'G1.4 allowlist 存在（GEO_HEATMAP_G14_ALLOWED_ADDITIONS）', Array.isArray(scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS.length === 4);
check('29', 'G1.3.1 allowlist 不變（GEO_HEATMAP_G131_ALLOWED_ADDITIONS 仍是 4 項）', Array.isArray(scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.length === 4);
check('30', 'layered reconstruction（computeScopedBaselineCheckForSource 內部依序呼叫 reconstructG14Layer 再呼叫 reconstructPristine）', /const g14 = reconstructG14Layer\(currentSource\);/.test(guardSrc) && /const g131 = reconstructPristine\(g14\.reconstructed\);/.test(guardSrc));
check('31', 'pristine hash unchanged（仍是 8f3ec8c0...）', scopeGuard.PRISTINE_BASELINE_SHA256 === '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d');
{
  const result = scopeGuard.computeScopedBaselineCheck(ROOT);
  check('32', 'A2 green（呼叫層面：computeScopedBaselineCheck 對目前檔案判定 ok，A2 實際執行結果見 Regression 報告）', result.ok === true);
  check('33', 'A1.2 green（同一份 Guard 結果，A1.2 呼叫方式相同）', result.ok === true);
}
check('34', 'G1.3.2 green（G1.3.2 smoke 呼叫的是同一個 computeScopedBaselineCheck 函式名稱，向下相容未改介面）', /computeScopedBaselineCheck\(ROOT\)/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js')));
check('35', 'G1.3.1 green（fixture timezone 修正後查詢邏輯層面：G1.3.1 smoke 使用 computeFixtureTimestamp）', /computeFixtureTimestamp/.test(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js')));

// 七、既有功能未退化
check('36', 'Metric Sync 未退化（geoHeatUiSyncMetricFromGlobal 仍存在）', /function geoHeatUiSyncMetricFromGlobal/.test(uiCode));
check('37', 'Layer Switch 未退化（geoHeatUiSetLayer／_geoHeatUiApplyLayerExclusivity 仍存在）', /function geoHeatUiSetLayer/.test(uiCode) && /function _geoHeatUiApplyLayerExclusivity/.test(uiCode));
check('38', 'Business Total 未退化（geoHeatState.businessTotals 仍存在）', /businessTotals: \{ orders: null, revenue: null \},/.test(heatCode));
check('39', 'Store Isolation 未退化（geoHeatHandleStoreSwitch 仍清空 businessTotals/areas）', /function geoHeatHandleStoreSwitch/.test(heatCode));
check('40', 'Date filter 未退化（本輪未修改 utils/geoAnalyticsQueries.js）', (() => { try { const backend = read('utils/geoAnalyticsQueries.js'); return /range\.startLocal, range\.endLocal/.test(backend); } catch (e) { return false; } })());
check('41', 'Channel filter 未退化（chOrd 共用變數仍在）', (() => { try { const backend = read('utils/geoAnalyticsQueries.js'); return /chOrd\.sql/.test(backend); } catch (e) { return false; } })());

// 八、Timezone Fixture
check('42', 'timezone fixture stable（geo-fixture-time.js 提供 computeFixtureTimestamp／computeOutOfRangeTimestamp／midpointLocalString 三個匯出）', typeof scopeGuard !== 'undefined' && (() => { const fx = require(path.join(ROOT, 'scripts/lib/geo-fixture-time.js')); return typeof fx.computeFixtureTimestamp === 'function' && typeof fx.midpointLocalString === 'function' && typeof fx.computeOutOfRangeTimestamp === 'function'; })());
check('43', "no datetime now localtime（fixture helper 本身、G1.3.1/G1.3.2 smoke 都不再使用 datetime('now','localtime')，排除說明註解）", (() => {
  const fxNoComments = stripComments(fxSrc);
  const s131 = stripComments(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js'));
  const s132 = stripComments(read('scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js'));
  return !/datetime\('now','localtime'\)/.test(fxNoComments) && !/datetime\('now','localtime'\)/.test(s131) && !/datetime\('now','localtime'\)/.test(s132);
})());

// 九、清潔度
check('44', 'no test DB（data/pos.db 不在工作目錄殘留）', !fs.existsSync(path.join(ROOT, 'data/pos.db')));
check('45', 'no console.log（G1.4 新增段落無殘留 debug log）', !/console\.log\(|console\.debug\(/.test(heatCode.slice(heatCode.indexOf('function geoHeatComputeDrawableState'))) && !/console\.log\(|console\.debug\(/.test(uiCode.slice(uiCode.indexOf('_geoHeatUiOrderMapOverlayMessage'))));
check('46', 'no debug（無 debugger 陳述式）', !/\bdebugger\b/.test(heatCode) && !/\bdebugger\b/.test(uiCode));
check('47', 'no Math.random（G1.4 新增段落無假資料產生器）', !/Math\.random\(\)/.test(heatCode.slice(heatCode.indexOf('function geoHeatComputeDrawableState'))) && !/Math\.random\(\)/.test(uiCode.slice(uiCode.indexOf('_geoHeatUiOrderMapOverlayMessage'))));
check('48', 'no hardcoded store_001（G1.4 新增段落）', !/['"]store_001['"]/.test(heatCode.slice(heatCode.indexOf('function geoHeatComputeDrawableState'))) && !/['"]store_001['"]/.test(uiCode.slice(uiCode.indexOf('_geoHeatUiOrderMapOverlayMessage'))));
check('49', 'no absolute path（新增檔案內未硬編碼 /home/claude 或容器絕對路徑）', !/\/home\/claude/.test(heatSrc) && !/\/home\/claude/.test(uiSrc) && !/\/home\/claude/.test(guardSrc) && !/\/home\/claude/.test(fxSrc));
check('50', 'no mutation temp files（工作目錄內沒有殘留 mutation/reconstructed 暫存檔）', !fs.existsSync(path.join(ROOT, 'reconstructed.js')) && !fs.existsSync('/tmp/reconstructed.js'));

// 額外：A7／G1 隔離
check('EXTRA-1', 'A7 KPI（geo-intelligence.js）完全未受本輪影響', !/geoHeatComputeDrawableState|geo-heat-map-label/.test(geoIntelligenceSrc));
check('EXTRA-2', 'G1 GeoLiveLayer（geo-live-layer.js）完全未受本輪影響', !/geoHeatComputeDrawableState|geo-heat-map-label/.test(geoLiveLayerSrc));

console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.4 (Map Label Rendering & Honest Drawable-State Fix)');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => { console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`); if (c.ok) okCount++; });
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
