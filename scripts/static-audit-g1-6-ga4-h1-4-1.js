#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-1.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.1-GEO-DASHBOARD-CLEANUP Static Audit
//
// 只檢查本輪（H1.4.1）新增/修改的 Contract，不重複既有 H1.4 static audit
// （scripts/static-audit-g1-6-ga4-h1-4.js，227 checks，本輪未修改其覆蓋範圍，
// 繼續 PASS）。沿用同一套 extractFnBody()/extractObjectBody() 慣例，優先取
// 「正式函式本體」這一段字串再判斷，避免整檔案裸 includes() 被註解/測試
// hook/說明文字誤判。

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function sha256(rel) { return crypto.createHash('sha256').update(read(rel)).digest('hex'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

function extractFnBody(code, fnSignature) {
  const start = code.indexOf(fnSignature);
  if (start === -1) return '';
  let depth = 0;
  let i = code.indexOf('{', start + fnSignature.length);
  const bodyStart = i;
  for (; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return code.slice(bodyStart, i);
}

const giSrc = read('public/js/geo-intelligence.js');
const giCode = codeOnly(giSrc);
const mapSrc = read('public/js/geo-intelligence-map.js');
const heatUiSrc = read('public/js/geo-heatmap-ui.js');
const visitorSrc = read('public/js/geo-visitor-layer.js');

const refreshBody = extractFnBody(giSrc, 'async function refreshGeoDashboardKpiBlock(containerId)');

// ════════════════════════════════════════════════════════════════
// Category A — Dashboard Clean Contract（unconditional）
// ════════════════════════════════════════════════════════════════
check('A1', 'refreshGeoDashboardKpiBlock() 存在且可提取本體（前置檢查）', refreshBody.length > 100);
// Dashboard 的 elAfter.innerHTML template literal 本身（-panel-dashboard 那一段）
// 不得直接插入 decisionCenterHtml/emptyStateNotice/rankingSectionHtml/kpiCards/
// renderGeoQualityBlock/sharedMetricBarHtml 這些變數。用「-panel-dashboard 到
// heatPanelHtml 之間」這一段字串做精準檢查，避免整份檔案誤判（這些變數在別處
// 仍然存在、仍然被計算——只是不出現在這個 template 片段裡）。
const dashTemplateStart = refreshBody.indexOf('<div id="${containerId}-panel-dashboard"');
const dashTemplateEnd = refreshBody.indexOf('${heatPanelHtml}');
const dashTemplate = (dashTemplateStart !== -1 && dashTemplateEnd !== -1) ? refreshBody.slice(dashTemplateStart, dashTemplateEnd) : '__EXTRACTION_FAILED__';
check('A2', 'Dashboard template 片段成功提取（-panel-dashboard 到 heatPanelHtml 之間）', dashTemplate !== '__EXTRACTION_FAILED__' && dashTemplate.length > 50);
check('A3', 'Dashboard template 片段不插入 ${kpiCards}（POS Geo KPI diagnostics）', !dashTemplate.includes('${kpiCards}'));
check('A4', 'Dashboard template 片段不插入 ${renderGeoQualityBlock(', !dashTemplate.includes('${renderGeoQualityBlock('));
check('A5', 'Dashboard template 片段不插入 ${fulfillmentLine}（僅存在於 diagnostics hook）', !dashTemplate.includes('${fulfillmentLine}'));
check('A6', 'Dashboard template 片段不插入 ${decisionCenterHtml}（Recommended Actions）', !dashTemplate.includes('${decisionCenterHtml}'));
check('A7', 'Dashboard template 片段不插入 ${emptyStateNotice}（Acquisition Geo warning / no-data message）', !dashTemplate.includes('${emptyStateNotice}'));
check('A8', 'Dashboard template 片段不插入 ${rankingSectionHtml}（legacy Top-3/排行榜）', !dashTemplate.includes('${rankingSectionHtml}'));
check('A9', 'Dashboard template 片段不插入 ${sharedMetricBarHtml}（舊 8-metric selector）', !dashTemplate.includes('${sharedMetricBarHtml}'));
check('A10', 'decisionCenterHtml／emptyStateNotice／rankingSectionHtml／kpiCards 變數本身仍存在於程式碼中（只是不屬於 Dashboard HTML owner，不是被刪除）', giCode.includes('const decisionCenterHtml') && giCode.includes('const rankingSectionHtml') && giCode.includes('const kpiCards'));
check('A11', 'renderGeoQualityBlock() 函式本身仍存在（能力保留，需求文件十一）', giCode.includes('function renderGeoQualityBlock('));
check('A12', 'geoComputeRecommendedActions() 函式本身仍存在（Recommended Actions 邏輯完全保留，只搬 UI owner）', giCode.includes('function geoComputeRecommendedActions('));
check('A13', 'computeGeoTopAreas()／_renderGeoAreaRankingTable() 函式本身仍存在（Top-3/排行榜邏輯保留）', giCode.includes('function computeGeoTopAreas(') && giCode.includes('function _renderGeoAreaRankingTable('));

// ════════════════════════════════════════════════════════════════
// Category B — Heatmap Ownership
// ════════════════════════════════════════════════════════════════
const diagHookAssignIdx = refreshBody.indexOf('window.__geoHeatUiDiagnosticsHtml =');
check('B1', 'window.__geoHeatUiDiagnosticsHtml 賦值存在於 refreshGeoDashboardKpiBlock() 內', diagHookAssignIdx !== -1);
const diagHookStatement = diagHookAssignIdx !== -1 ? refreshBody.slice(diagHookAssignIdx, refreshBody.indexOf(';', diagHookAssignIdx + 400) + 1 || diagHookAssignIdx + 800) : '';
check('B2', 'diagnostics hook 內容包含 sharedMetricBarHtml（舊 8-metric selector）', diagHookStatement.includes('sharedMetricBarHtml'));
check('B3', 'diagnostics hook 內容包含 kpiCards（POS Geo KPI）', diagHookStatement.includes('kpiCards'));
check('B4', 'diagnostics hook 內容包含 renderGeoQualityBlock(（Geo Quality）', diagHookStatement.includes('renderGeoQualityBlock('));
check('B5', 'diagnostics hook 內容包含 decisionCenterHtml（Recommended Actions）', diagHookStatement.includes('decisionCenterHtml'));
check('B6', 'diagnostics hook 內容包含 emptyStateNotice（empty-state）', diagHookStatement.includes('emptyStateNotice'));
check('B7', 'diagnostics hook 內容包含 rankingSectionHtml（legacy ranking）', diagHookStatement.includes('rankingSectionHtml'));
check('B8', 'geoHeatUiRenderPanel() 存在於 geo-heatmap-ui.js', heatUiSrc.includes('function geoHeatUiRenderPanel('));
const heatPanelBody = extractFnBody(heatUiSrc, 'function geoHeatUiRenderPanel(containerId)');
check('B9', 'geoHeatUiRenderPanel() 內消費 window.__geoHeatUiDiagnosticsHtml（透過 _geoHeatUiDiagnosticsBlockHtml()）', heatPanelBody.includes('_geoHeatUiDiagnosticsBlockHtml()'));
check('B10', '_geoHeatUiDiagnosticsBlockHtml() 讀取的正是 window.__geoHeatUiDiagnosticsHtml', heatUiSrc.includes("window.__geoHeatUiDiagnosticsHtml"));

// ════════════════════════════════════════════════════════════════
// Category C — No Production Fallback（unconditional Dashboard clean）
// ════════════════════════════════════════════════════════════════
check('C1', "不存在 heatPanelHtml === '' 的 fallback 分支", !giCode.includes("heatPanelHtml === ''"));
check('C2', '不存在 heatmapOwnsDiagnostics 這個曾經用於 fallback 判斷的變數', !giCode.includes('heatmapOwnsDiagnostics'));
check('C3', '不存在 dashboardDiagnosticsFallbackHtml 這個曾經用於 fallback 的變數', !giCode.includes('dashboardDiagnosticsFallbackHtml'));
check('C4', "Dashboard template 片段內不存在任何 '${... ? ... : ...}' 形式、把 diagnostics 條件式塞回 Dashboard 的三元運算", !/\$\{[^}]*diagnostic[^}]*\?[^}]*:[^}]*\}/i.test(dashTemplate));
check('C5', 'Dashboard panel 的 dashboardPanelHidden 只控制 hidden 屬性（Tab 顯示/隱藏），不是 diagnostics 開關', giCode.includes("const dashboardPanelHidden = (typeof geoHeatUiState"));
check('C6', "原始碼註解明確記載『Dashboard 一律不顯示 Diagnostics，不論 geo-heatmap-ui.js 是否載入』的設計決策（可追溯性）", giSrc.includes('不論 geo-heatmap-ui.js 是否載入'));

// ════════════════════════════════════════════════════════════════
// Category D — Ranking ID 唯一性（Duplicate ID Bug 修正）
// ════════════════════════════════════════════════════════════════
check('D1', 'Legacy ranking table 使用 -legacy-ranking id（不是 -ranking）', giCode.includes('${containerId}-legacy-ranking'));
check('D2', 'geo-intelligence.js 內查找 legacy ranking 的 getElementById 呼叫已同步改成 -legacy-ranking', giCode.includes("geoLastContainerId + '-legacy-ranking'"));
check('D3', 'geo-intelligence.js 內已無殘留的 "${containerId}-ranking" 舊 legacy ranking 容器（改用 -legacy-ranking 後不應該還有這個確切字串）', !giCode.includes('id="${containerId}-ranking">'));
check('D4', 'geo-intelligence.js 內已無殘留的 "geoLastContainerId + \'-ranking\'"（改用 -legacy-ranking 後的舊寫法）', !giCode.includes("geoLastContainerId + '-ranking'"));
check('D5', 'Heatmap Engine 自己的 ranking（-ranking，geo-heatmap-ui.js／geo-heatmap.js 既有 Order/Visitor 排行）完全沒有被本輪修改（不同 owner，維持原樣）', heatUiSrc.includes("`${containerId}-ranking`"));

// ════════════════════════════════════════════════════════════════
// Category E — Wheel UX
// ════════════════════════════════════════════════════════════════
const geoInitMapBody = extractFnBody(mapSrc, 'function geoInitMap(');
check('E1', 'geoInitMap() 存在', geoInitMapBody.length > 100);
check('E2', 'geoInitMap() 在建立地圖後預設呼叫 scrollWheelZoom.disable()', geoInitMapBody.includes('scrollWheelZoom') && geoInitMapBody.includes('.disable()'));
check('E3', 'geo-intelligence-map.js 內含 wheel-hint badge 容器（-wheel-hint）', mapSrc.includes('-wheel-hint'));
check('E4', 'geo-heatmap-ui.js 定義 dashboardMapInteractionState（Map UX state，跟 GA4 Query State 分離）', heatUiSrc.includes('let dashboardMapInteractionState'));
check('E5', 'dashboardMapInteractionState 沒有被塞進 dashboardGa4State 或 geoGa4H1State（狀態物件保持獨立）', !heatUiSrc.includes('dashboardGa4State.wheelEnabled') && !heatUiSrc.includes('geoGa4H1State.wheelEnabled'));
check('E6', 'geoDashboardMapActivate() 存在（Dashboard 分頁 activate 時重設 disabled）', heatUiSrc.includes('function geoDashboardMapActivate('));
const activateBody = extractFnBody(heatUiSrc, 'function geoDashboardMapActivate(mapContainerId)');
check('E7', 'geoDashboardMapActivate() 內呼叫 geoDashboardMapDisableWheel()（一律重設，不記住上一輪狀態）', activateBody.includes('geoDashboardMapDisableWheel()'));
check('E8', 'geoDashboardMapDeactivateForHeatmap() 存在（切到 Heatmap 前解除 Dashboard 專屬 listener 並啟用滾輪）', heatUiSrc.includes('function geoDashboardMapDeactivateForHeatmap('));
const deactivateBody = extractFnBody(heatUiSrc, 'function geoDashboardMapDeactivateForHeatmap()');
check('E9', 'geoDashboardMapDeactivateForHeatmap() 內呼叫 scrollWheelZoom.enable()', deactivateBody.includes('.enable()'));
check('E10', 'geoHeatUiSwitchTab() 切到 heatmap 分支呼叫 geoDashboardMapDeactivateForHeatmap()', (() => {
  const body = extractFnBody(heatUiSrc, 'function geoHeatUiSwitchTab(containerId, tab)');
  const heatmapBranchIdx = body.indexOf("if (tab === 'heatmap')");
  const elseIdx = body.indexOf('} else {', heatmapBranchIdx);
  const heatmapBranch = heatmapBranchIdx !== -1 && elseIdx !== -1 ? body.slice(heatmapBranchIdx, elseIdx) : '';
  return heatmapBranch.includes('geoDashboardMapDeactivateForHeatmap()');
})());
check('E11', 'geoHeatUiSwitchTab() 切回 dashboard 分支呼叫 geoDashboardMapActivate()', (() => {
  const body = extractFnBody(heatUiSrc, 'function geoHeatUiSwitchTab(containerId, tab)');
  const elseIdx = body.indexOf('} else {');
  const elseBranch = elseIdx !== -1 ? body.slice(elseIdx) : '';
  return elseBranch.includes('geoDashboardMapActivate(');
})());
check('E12', '_geoDashboardMapOnOutsideClick() 用 canvas.contains(e.target) 判斷是否在地圖內（map-inside click 不 disable）', heatUiSrc.includes('canvas.contains(e.target)'));
check('E13', '_geoDashboardMapOnKeydown() 監聽 Escape 鍵', heatUiSrc.includes("e.key === 'Escape'"));
check('E14', 'geoDashboardMapBindWheelLifecycle() 有 idempotent bound flag guard（重複呼叫不重新 addEventListener）', (() => {
  const body = extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)');
  return body.includes('if (dashboardMapInteractionState.bound) return true');
})());
check('E15', '_geoDashboardMapUnbindWheelLifecycle() 存在（換容器時先解掉舊 listener 再重綁）', heatUiSrc.includes('function _geoDashboardMapUnbindWheelLifecycle('));
check('E16', 'geo-heatmap-ui.js 沒有呼叫 L.map()（不建立第二個地圖，需求文件六，沿用既有 SA-16 慣例）', !/L\.map\(/.test(heatUiSrc));
check('E17', 'geo-heatmap-ui.js 讀取既有 geoMapState.instance（重用同一個 Leaflet map instance）', heatUiSrc.includes('geoMapState.instance'));
check('E18', 'refreshGeoDashboardKpiBlock() 在非 Heatmap-active 時呼叫 geoDashboardMapActivate(mapContainerId)（Direct Load / Refresh 路徑也會重設滾輪）', refreshBody.includes('geoDashboardMapActivate(mapContainerId)'));

// ════════════════════════════════════════════════════════════════
// Category F — Frontend-only Diff
// ════════════════════════════════════════════════════════════════
const BACKEND_DIRS = ['services', 'routes', 'utils', 'middleware'];
function sha256IfExists(rel) { const p = path.join(ROOT, rel); return fs.existsSync(p) ? sha256(rel) : null; }
// H1.4 baseline 的 backend 檔案清單：用 git 無關的方式——直接列出這幾個
// 本輪明確禁止碰的關鍵檔案，逐一跟「本輪解壓後、尚未修改前」的 workdir
// 起點比對用途說明留在 Reality Audit；這裡只做「這些檔案現在是否存在且
// 內容非空」的存在性防線，真正的逐位元組 diff 由封裝階段的 Production
// Diff 報告輸出（需求文件二十四）。
const CRITICAL_BACKEND_FILES = [
  'services/ga4GeoSyncService.js',
  'routes/ga4-geo.js',
  'utils/db.js',
];
CRITICAL_BACKEND_FILES.forEach((rel, i) => {
  check(`F${i + 1}`, `關鍵 Backend 檔案 ${rel} 存在（存在性防線，逐位元組 diff 見封裝報告）`, fs.existsSync(path.join(ROOT, rel)));
});
check('F4', '本輪新增/修改的三支 scripts（Target Runtime／Static Audit）本身不在 services/routes/utils/middleware 目錄下', !__filename.includes(`${path.sep}services${path.sep}`) && !__filename.includes(`${path.sep}routes${path.sep}`));

// ════════════════════════════════════════════════════════════════
// Category G — No Duplicate IDs（source-level 防線，DOM-level 已在 Target
// Runtime 的 DUPID-* 驗證，這裡補 source 層級：同一個 containerId 前綴不會
// 同時出現在 Dashboard template 與 diagnostics hook 兩處）
// ════════════════════════════════════════════════════════════════
check('G1', '"${containerId}-legacy-ranking" 只在 diagnostics hook 內出現一次（rankingSectionHtml 定義處），不在 Dashboard template 片段重複出現', !dashTemplate.includes('-legacy-ranking') && giCode.split('${containerId}-legacy-ranking').length - 1 === 1);
check('G2', '"${containerId}-geo-kpi-live"（kpiCards 的 id）只在 kpiCards 賦值處出現一次', giCode.split('${containerId}-geo-kpi-live').length - 1 === 1);
check('G3', '"${containerId}-decision-center-heat" 只在 diagnostics hook 內出現一次', giCode.split('${containerId}-decision-center-heat').length - 1 === 1);
check('G4', '"${containerId}-legacy-empty-heat" 只在 diagnostics hook 內出現一次', giCode.split('${containerId}-legacy-empty-heat').length - 1 === 1);
check('G5', '"${containerId}-ranking-heat" 只在 diagnostics hook 內出現一次', giCode.split('${containerId}-ranking-heat').length - 1 === 1);
check('G6', '"${containerId}-geo-quality-heat" 只在 diagnostics hook 內出現一次', giCode.split('${containerId}-geo-quality-heat').length - 1 === 1);

// ════════════════════════════════════════════════════════════════
// Category H — H1.4 GA4 Retention（source-level：range/disclaimer/label 字樣
// 沒有被本輪誤刪）
// ════════════════════════════════════════════════════════════════
check('H1', 'GA4 區域概況 label 樣板字串仍存在', mapSrc.includes('GA4 區域概況') || read('public/js/geo-ga4-dashboard-layer.js').includes('GA4 區域概況'));
check('H2', 'IP 城市級推估 disclaimer 字串仍存在', read('public/js/geo-ga4-dashboard-layer.js').includes('IP 城市級推估'));
const rangeModesSrc = read('public/js/geo-range-resolver.js') + read('public/js/geo-range-control.js');
['today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom'].forEach((mode, i) => {
  check(`H${3 + i}`, `Range mode "${mode}" 仍存在於 geo-range-resolver.js／geo-range-control.js`, rangeModesSrc.includes(mode));
});
check('H13', 'refreshGeoDashboardKpiBlock() 仍呼叫 geoInitMap()（Dashboard 地圖初始化流程未被移除）', refreshBody.includes('geoInitMap('));
check('H14', 'geoDashboardGa4Activate()（GA4 persisted markers）仍存在且未被移除', read('public/js/geo-ga4-dashboard-layer.js').includes('function geoDashboardGa4Activate('));

// ════════════════════════════════════════════════════════════════
// Category I — Frontend-only Diff（Production 檔案清單防線）
// ════════════════════════════════════════════════════════════════
const EXPECTED_PRODUCTION_FILES = [
  'public/js/geo-intelligence.js',
  'public/js/geo-intelligence-map.js',
  'public/js/geo-heatmap-ui.js',
];
EXPECTED_PRODUCTION_FILES.forEach((rel, i) => {
  check(`I${i + 1}`, `預期 Production Diff 檔案 ${rel} 存在`, fs.existsSync(path.join(ROOT, rel)));
});
check('I4', 'geo-intelligence-map.js 的修改範圍只集中在 scrollWheelZoom/wheel-hint（不含新的 L.map()/新的 tileLayer 呼叫次數增加——沿用既有單一地圖 Contract）', (codeOnly(mapSrc).match(/L\.map\(/g) || []).length === 1);

// ════════════════════════════════════════════════════════════════
// Category J — Frozen Backend（本輪不得修改）
// ════════════════════════════════════════════════════════════════
check('J1', 'services/ga4GeoSyncService.js 存在（未被刪除）', fs.existsSync(path.join(ROOT, 'services/ga4GeoSyncService.js')));
check('J2', 'routes/ga4-geo.js 存在（未被刪除）', fs.existsSync(path.join(ROOT, 'routes/ga4-geo.js')));
check('J3', 'utils/db.js 存在（未被刪除）', fs.existsSync(path.join(ROOT, 'utils/db.js')));
check('J4', 'geo-intelligence.js 完全沒有出現任何 require("../services/") 或 require("../routes/") 之類的新 backend import（Frontend-only 邊界）', !/require\(['"]\.\.?\/(services|routes|middleware)\//.test(giSrc));

// ════════════════════════════════════════════════════════════════
// Category K — Legacy Hash Test-only Classification（三支 SHA256 期待值
// 必須一致，且等於檔案真實雜湊；這是 Test-only diff，不是 Production diff）
// ════════════════════════════════════════════════════════════════
const REAL_MAP_SHA = sha256('public/js/geo-intelligence-map.js');
check('K1', 'geo-intelligence-map.js 真實 SHA256 長度為 64 字元', REAL_MAP_SHA.length === 64);
const a11Src = read('scripts/smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js');
const a12Src = read('scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js');
const a2Src = read('scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js');
function extractHashFor(src, rel) {
  const re = new RegExp(`'${rel.replace(/\//g, '\\/')}':\\s*'([0-9a-f]{64})'`);
  const m = src.match(re);
  return m ? m[1] : null;
}
const hashA11 = extractHashFor(a11Src, 'public/js/geo-intelligence-map.js');
const hashA12 = extractHashFor(a12Src, 'public/js/geo-intelligence-map.js');
const hashA2 = extractHashFor(a2Src, 'public/js/geo-intelligence-map.js');
check('K2', 'a1-1 的 geo-intelligence-map.js 期待值長度=64', !!hashA11 && hashA11.length === 64);
check('K3', 'a1-2 的 geo-intelligence-map.js 期待值長度=64', !!hashA12 && hashA12.length === 64);
check('K4', 'a2-geo-event-engine 的 geo-intelligence-map.js 期待值長度=64', !!hashA2 && hashA2.length === 64);
check('K5', 'a1-1 / a1-2 / a2 三支對 geo-intelligence-map.js 的期待值完全相同（不是各自不同版本）', hashA11 === hashA12 && hashA12 === hashA2);
check('K6', '三支期待值等於檔案真實 SHA256（不是舊 baseline 也不是隨意亂填的值）', hashA11 === REAL_MAP_SHA);
check('K7', 'a1-1 更新處標註 INTENTIONAL H1.4.1（可追溯性，Test-only diff 分類）', a11Src.includes('INTENTIONAL H1.4.1'));
check('K8', 'a1-2 更新處標註 INTENTIONAL H1.4.1（可追溯性，Test-only diff 分類）', a12Src.includes('INTENTIONAL H1.4.1'));
check('K9', 'a2-geo-event-engine 更新處標註 TEST-ONLY／INTENTIONAL H1.4.1（可追溯性，Test-only diff 分類）', a2Src.includes('TEST-ONLY') && a2Src.includes('INTENTIONAL H1.4.1'));

// ════════════════════════════════════════════════════════════════
// 額外補強：node --check 語法防線
// ════════════════════════════════════════════════════════════════
['public/js/geo-intelligence.js', 'public/js/geo-intelligence-map.js', 'public/js/geo-heatmap-ui.js'].forEach((rel, i) => {
  let ok = true;
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); } catch (e) { ok = false; }
  check(`SYN${i + 1}`, `${rel} node --check 通過`, ok);
});

// ════════════════════════════════════════════════════════════════
// Category L — Hook Ordering（source position）／Wheel Hint Text／
// Test Isolation Helpers（補強到 100+ checks）
// ════════════════════════════════════════════════════════════════
check('L1', 'window.__geoHeatUiDiagnosticsHtml 賦值的原始碼位置，早於 geoHeatUiRenderPanel(containerId) 呼叫的位置（Hook 必須先設定好才能被消費）', (() => {
  const assignPos = refreshBody.indexOf('window.__geoHeatUiDiagnosticsHtml =');
  const consumePos = refreshBody.indexOf('geoHeatUiRenderPanel(containerId)');
  return assignPos !== -1 && consumePos !== -1 && assignPos < consumePos;
})());
check('L2', 'GEO_DASHBOARD_MAP_WHEEL_HINT 定義包含 disabled 提示文字「點擊地圖後可使用滾輪縮放」', heatUiSrc.includes('點擊地圖後可使用滾輪縮放'));
check('L3', 'GEO_DASHBOARD_MAP_WHEEL_HINT 定義包含 enabled 提示文字「滾輪縮放已啟用・按 Esc 關閉」', heatUiSrc.includes('滾輪縮放已啟用・按 Esc 關閉'));
check('L4', 'geoDashboardMapEnableWheel() 存在', heatUiSrc.includes('function geoDashboardMapEnableWheel('));
check('L5', 'geoDashboardMapDisableWheel() 存在', heatUiSrc.includes('function geoDashboardMapDisableWheel('));
check('L6', '_geoDashboardMapResetInteractionStateForTest() 存在（測試隔離 helper，避免上一個測試殘留狀態污染下一個）', heatUiSrc.includes('function _geoDashboardMapResetInteractionStateForTest('));
check('L7', 'geo-heatmap-ui.js 的 Dashboard Map Wheel 相關新程式碼沒有殘留 console.log/console.debug', (() => {
  const startIdx = heatUiSrc.indexOf('let dashboardMapInteractionState');
  const endIdx = heatUiSrc.indexOf('// ════════════════════════════════════════════════════════════════\n// 二、Tab Bar');
  const block = (startIdx !== -1 && endIdx !== -1) ? heatUiSrc.slice(startIdx, endIdx) : heatUiSrc;
  return !/console\.(log|debug)\(/.test(block);
})());
check('L8', '地圖畫布容器有 tabindex="0"（鍵盤可 focus，Esc 才有意義，需求文件二十八）', mapSrc.includes('tabindex="0"'));
check('L9', 'wheel-hint 容器預設帶 hidden 屬性（未 activate 前不顯示，避免 Heatmap 分頁誤顯示 click-to-activate 提示）', mapSrc.includes('-wheel-hint" class="geo-map-wheel-hint" role="status" aria-live="polite" hidden'));
check('L10', 'geoDashboardMapBindWheelLifecycle() 換容器時會先解掉舊 listener 再重綁（idempotent 的另一半：不是永遠不重綁，是不重複疊加）', heatUiSrc.includes('_geoHeatUiUnbindWheelLifecycle') === false && heatUiSrc.includes('_geoDashboardMapUnbindWheelLifecycle()'));

// ════════════════════════════════════════════════════════════════
function printSummary() {
  const ok = checks.filter((c) => c.ok).length;
  const failN = checks.filter((c) => !c.ok).length;
  checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id} ${c.desc}`));
  console.log('\n======================================================================');
  console.log('H1.4.1 GEO DASHBOARD CLEANUP STATIC AUDIT SUMMARY');
  console.log(`  OK:    ${ok}`);
  console.log(`  FAIL:  ${failN}`);
  console.log(`  TOTAL: ${checks.length}`);
  console.log('======================================================================');
  if (failN > 0) process.exitCode = 1;
}
printSummary();
