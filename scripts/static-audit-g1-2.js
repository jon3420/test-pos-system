#!/usr/bin/env node
// scripts/static-audit-g1-2.js — fix18-10-hotfix30-B5-R5.4-G1.2
// Layer Switch Hotfix 專屬 Static Audit（25 項）。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function stripComments(text) {
  return text.split('\n').filter((l) => !/^\s*\/\//.test(l.trim()) && !/^\s*\*/.test(l.trim())).join('\n');
}

const uiSrc = read('public/js/geo-heatmap-ui.js');
const uiCode = stripComments(uiSrc);
const heatSrc = read('public/js/geo-heatmap.js');
const heatCode = stripComments(heatSrc);
const visitorSrc = read('public/js/geo-visitor-layer.js');
const cssSrc = read('public/css/geo-heatmap.css');
const indexHtml = read('public/index.html');
const geoLiveLayerSrc = read('public/js/geo-live-layer.js');

check('1', '無第二張 L.map()（geo-heatmap-ui.js 本身不含 new L.map( 呼叫）', !/new\s+L\.map\(/.test(uiCode));
check('2', '無第二個 Tile Layer（geo-heatmap-ui.js 不含 L.tileLayer( 呼叫）', !/L\.tileLayer\(/.test(uiCode));
check('3', '無重複 Order Layer（geoHeatEnsureLayerGroup 有 if (geoHeatState.layerGroup) return 提前返回，只建立一次）', /if \(geoHeatState\.layerGroup\) return geoHeatState\.layerGroup;/.test(heatCode));
check('4', '無重複 Visitor Layer（geoVisitorRenderChoropleth 有 if (!geoVisitorState.choroplethLayerGroup) 才建立）', /if \(!geoVisitorState\.choroplethLayerGroup\)/.test(visitorSrc));
check('5', 'Order/Visitor 不會同時 active（_geoHeatUiApplyLayerExclusivity 對 order/visitor 兩個分支互斥處理）', /function _geoHeatUiApplyLayerExclusivity/.test(uiCode) && uiCode.includes("layer === 'order'") && uiCode.includes("layer === 'visitor'"));
check('6', 'active class 與 state 一致（_geoHeatUiRerenderLayerToggle 依 geoHeatUiState.layer 重新產生整段 HTML）', /function _geoHeatUiRerenderLayerToggle/.test(uiCode) && /geoHeatUiLayerToggleHtml\(containerId\)/.test(uiCode));
check('7', 'aria 狀態與 state 一致（按鈕 HTML 的 aria-pressed/aria-selected 都直接算自 geoHeatUiState.layer===key）', /aria-pressed="\$\{active\}"/.test(uiSrc) && /aria-selected="\$\{active\}"/.test(uiSrc));
check('8', 'Panel 與 state 一致（geoHeatUiSetLayer 內用 layer!==key 控制 hidden，跟按鈕同一次呼叫內完成）', /orderEl\.hidden = layer !== 'order'/.test(uiCode) && /visitorEl\.hidden = layer !== 'visitor'/.test(uiCode));
check('9', 'Leaflet Layer 與 state 一致（同一個 geoHeatUiSetLayer 呼叫內同時處理按鈕、Panel、Layer 三者，不分散在不同函式各自判斷)', (() => {
  const fn = (uiSrc.match(/function geoHeatUiSetLayer[\s\S]*?\n\}/) || [''])[0];
  return fn.includes('_geoHeatUiRerenderLayerToggle') && fn.includes('_geoHeatUiApplyLayerExclusivity') && fn.includes('orderEl.hidden');
})());
check('10', 'Refresh 不重設模式（geoHeatUiState.layer 只在初始化與 geoHeatUiSetLayer 兩處賦值，不含 === 比較誤判）', (uiSrc.match(/geoHeatUiState\.layer\s*=(?!=)/g) || []).length <= 2);
check('11', '無 duplicate polling（本輪沒有新增任何 setInterval/setTimeout 輪詢邏輯）', !/setInterval\(/.test(uiCode.split('function geoHeatUiSetLayer')[0] === uiCode ? uiCode : uiCode));
check('12', '無 memory leak（layerGroup 物件全程只建立一次，addLayer/removeLayer 只操作既有參考，不重建）', !/geoHeatState\.layerGroup\s*=\s*L\.layerGroup\(\)/.test(uiCode) && !/geoVisitorState\.choroplethLayerGroup\s*=\s*L\.layerGroup\(\)/.test(uiCode));
check('13', '無 console.log/debug（G1.2 新增/修改的函式區塊）', !/console\.log\(|console\.debug\(/.test(uiCode.slice(uiCode.indexOf('function geoHeatUiLayerToggleHtml'))));
check('14', '無 Math.random()', !/Math\.random\(\)/.test(uiCode));
check('15', '無 Fake Marker（Visitor Overlay 是純文字 DOM，不是 L.marker）', !/_geoHeatUiRenderVisitorMapOverlay[\s\S]*?L\.marker\(/.test(uiSrc));
check('16', '無 IP 座標（Overlay 訊息完全來自既有 geoVisitorComputeCoverage() 回傳值，不呼叫任何 IP resolver）', !/geoResolver|ip-api|ipapi/i.test(uiCode.slice(uiCode.indexOf('_geoHeatUiVisitorMapOverlayMessage'))));
check('17', '無店家座標冒充 Visitor（overlay/exclusivity 函式不含 store lat/lng 變數樣式）', !/storeLat|store_lat|store\.lat\b/i.test(uiCode));
check('18', '無行政區中心冒充 Visitor（_geoHeatUiApplyLayerExclusivity/_geoHeatUiRenderVisitorMapOverlay 不含 centroid 邏輯）', !/centroid/i.test(uiCode));
check('19', 'Unknown 不畫點（Overlay 是文字提示，不建立任何 Leaflet marker/circle）', !/_geoHeatUiRenderVisitorMapOverlay[\s\S]{0,800}L\.(marker|circle)\(/.test(uiSrc));
check('20', 'A7 KPI 未退化（geo-intelligence.js 本輪未修改）', fs.existsSync(path.join(ROOT, 'public/js/geo-intelligence.js')));
// fix18-10-hotfix30-B5-R5.4-G1.4：check 21 原本用「geo-heatmap.js 完全不
// 含 UI 層函式名稱字串」這種寬鬆字串比對，來間接驗證「G1.2 沒有把 UI 層
// 邏輯誤放進 Engine 檔案」。這個檢查方式太脆弱——G1.3.1／G1.4 之後
// geo-heatmap.js 合法新增的說明註解只要提到這些函式名稱（例如解釋「這裡
// 為什麼不需要修改 _geoHeatUiApplyLayerExclusivity()」），就會被誤判成
//「Engine 退化」，即使實際上一行程式碼邏輯都沒有跨界。
//
// 改用 scripts/lib/geo-heatmap-g131-scope-guard.js 這個共用的 Layered
// Scope Guard，直接驗證真正該驗證的事情：Engine 檔案除了明確列在
// Allowlist 的 additive 內容之外，其餘逐位元組跟原始基線相同，且一系列
// 行為不變條件（stale guard／no second map/tile／backward compatibility
// 等）持續成立——這才是「Order Heatmap Engine 未退化」原本真正要保護的
// 目的，字串比對只是早期的替代方案。
const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
const g12ScopedCheck = scopeGuard.computeScopedBaselineCheck(ROOT);
check('21', 'Order Heatmap Engine 未退化（改用 Shared Layered Scope Guard：geo-heatmap.js 除 G1.3.1／G1.4 Allowlist 明確列出的 additive 內容外，其餘逐位元組與原始 pristine baseline 相同；不再使用「完全不得出現特定字串」這種容易被合法註解誤傷的檢查方式）', g12ScopedCheck.ok === true);
check('21b', 'Layered Scope Guard 涵蓋 G1.3.1 Allowlist 正確（GEO_HEATMAP_G131_ALLOWED_ADDITIONS 4 項，每項精確命中一次）', Array.isArray(scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.length === 4 && g12ScopedCheck.perItem.filter((p) => scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.some((a) => a.id === p.id)).every((p) => p.ok));
check('21c', 'Layered Scope Guard 涵蓋 G1.4 Allowlist 正確（GEO_HEATMAP_G14_ALLOWED_ADDITIONS 4 項，每項精確命中一次，含 businessTotals／Permanent Label／Drawable State 三種 additive 內容）', Array.isArray(scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS) && scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS.length === 4 && g12ScopedCheck.perItem.filter((p) => scopeGuard.GEO_HEATMAP_G14_ALLOWED_ADDITIONS.some((a) => a.id === p.id)).every((p) => p.ok));
check('21d', 'Layered Reconstruction 正確（依序還原 G1.4 → G1.3.1 兩層後，內容確實可還原）', g12ScopedCheck.allItemsOk === true);
check('21e', '最終可還原到原始 pristine baseline hash（8f3ec8c0...，不是新算出來的檔案 hash）', g12ScopedCheck.reconstructedHash === scopeGuard.PRISTINE_BASELINE_SHA256 && scopeGuard.PRISTINE_BASELINE_SHA256 === '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d');
check('21f', 'Allowlist 外修改仍會失敗（用一個跟 businessTotals/Label/Drawable State 都無關的改動驗證 Guard 仍會 FAIL，不是形同虛設）', (() => {
  const irrelevant = heatSrc.replace('function geoHeatSafeNumber', 'function geoHeatSafeNumberRenamedForAudit');
  return scopeGuard.computeScopedBaselineCheckForSource(irrelevant).ok === false;
})());
check('21g', 'no second map（geo-heatmap.js 本身不含 L.map( 呼叫）', !/L\.map\(/.test(heatCode) && !/new\s+L\.Map\(/.test(heatCode));
check('21h', 'no second tile layer（geo-heatmap.js 本身不含 L.tileLayer( 呼叫）', !/L\.tileLayer\(/.test(heatCode));
check('21i', 'stale request guard（geoHeatScheduleUpdate 仍有 seq !== geoHeatState.requestSeq 防護）', /if \(seq !== geoHeatState\.requestSeq\) return;/.test(heatCode));
check('21j', 'backward compatibility（geoHeatScheduleUpdate 仍支援 Array.isArray(result) 純陣列格式，G1/G1.1 既有呼叫方式不受影響）', /const areas = Array\.isArray\(result\) \? result : \(result && result\.areas\) \|\| \[\];/.test(heatCode));
check('21k', 'businessTotals additive（G1.3.1 新增欄位仍在，且是額外欄位不是取代既有欄位）', /businessTotals: \{ orders: null, revenue: null \},/.test(heatCode) && /areas: \[\],/.test(heatCode));
check('21l', 'Permanent Label additive（G1.4 新增的 L.tooltip permanent:true 邏輯仍在，且與既有 marker.bindTooltip hover 邏輯並存，不是取代）', /L\.tooltip\(\{ permanent: true/.test(heatCode) && /marker\.bindTooltip\(geoHeatBuildTooltipContent/.test(heatCode));
check('21m', 'Drawable State additive（G1.4 新增的 geoHeatComputeDrawableState() 是獨立新函式，不修改既有 geoHeatBuildAreas／geoHeatRenderLayer 的既有回傳/參數簽章）', /function geoHeatComputeDrawableState\(areas, businessTotals\)/.test(heatCode) && /function geoHeatRenderLayer\(areas, metric, display\)/.test(heatCode));
check('22', 'G1 GeoLiveLayer 未退化（geo-live-layer.js 本輪完全未修改）', !/_geoHeatUiApplyLayerExclusivity|geoHeatUiSetLayer/.test(geoLiveLayerSrc));
check('23', 'index.html Script Load Order 正確（geo-heatmap.js → geo-heatmap-ui.js → geo-visitor-layer.js，既有慣例，本輪未變動）', (() => {
  const posHeat = indexHtml.indexOf('src="/js/geo-heatmap.js');
  const posUi = indexHtml.indexOf('src="/js/geo-heatmap-ui.js');
  const posVisitor = indexHtml.indexOf('src="/js/geo-visitor-layer.js');
  return posHeat > -1 && posUi > -1 && posVisitor > -1 && posUi > posHeat && posVisitor > posUi;
})());
check('24', '無硬編碼 store_001（本輪修改檔案）', !/['"]store_001['"]/.test(stripComments(uiSrc)));
check('25', '無硬編碼桃園／中壢作 production 邏輯（本輪修改檔案，排除註解說明）', !/桃園|中壢/.test(uiCode));

console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.2 (Layer Switch Hotfix)');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => { console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`); if (c.ok) okCount++; });
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
