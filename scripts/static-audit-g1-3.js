#!/usr/bin/env node
// scripts/static-audit-g1-3.js — fix18-10-hotfix30-B5-R5.4-G1.3
// Geo Metric Sync & Coverage Explanation 專屬 Static Audit（30 項）。

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
const visitorSrc = read('public/js/geo-visitor-layer.js');
const geoLiveLayerSrc = read('public/js/geo-live-layer.js');
const geoIntelligenceSrc = read('public/js/geo-intelligence.js');

check('1', 'Mapping 集中管理（GEO_EVENT_TO_HEATMAP_METRIC 只定義一次）', (uiSrc.match(/const GEO_EVENT_TO_HEATMAP_METRIC\s*=/g) || []).length === 1);
check('2', 'Global/Heatmap Metric 一致（geoHeatUiSyncMetricFromGlobal 是唯一同步入口）', /function geoHeatUiSyncMetricFromGlobal/.test(uiCode) && /geoHeatUiSyncMetricFromGlobal\(metric\)/.test(visitorSrc));
check('3', '無 Revenue/Orders 狀態分裂（geoHeatUiSyncMetricFromGlobal 對每個 mapped metric 都會更新 geoHeatState.metric）', /geoHeatState\.metric = mapped/.test(uiCode));
check('4', '無 silent fallback Orders（mapped 為 null 時不寫入 geoHeatState.metric，只記錄 unmappedGlobalMetric）', /geoHeatUiState\.unmappedGlobalMetric = mapped \? null : globalMetric/.test(uiCode));
check('5', '無重複 Metric state 新增（geoHeatUiState 本身沒有新增 .metric 欄位）', !/geoHeatUiState\s*=\s*\{[^}]*\bmetric\s*:/s.test(uiSrc.slice(0, uiSrc.indexOf('function geoHeatUiSyncMetricFromGlobal'))));
check('6', 'Sync 有 guard（_geoMetricSyncInProgress reentrancy guard 存在）', /let _geoMetricSyncInProgress = false/.test(uiCode));
check('7', '無 recursive loop（geoHeatUiSyncMetricFromGlobal 開頭立即檢查 guard 並提前返回）', /if \(_geoMetricSyncInProgress\) return false;/.test(uiCode));
check('8', 'Refresh 不重設（geoHeatUiState.layer 相關賦值次數與 G1.2 一致，本輪未新增其他重設路徑）', !/geoHeatState\.metric\s*=\s*['"]orders['"]/.test(uiCode.replace(/geoHeatState\.metric = mapped/, '')));
check('9', 'Date 不重設（dashboardDateState 相關程式碼不含 geoHeatState.metric 賦值）', !/dashboardDateState[\s\S]{0,200}geoHeatState\.metric\s*=/.test(uiCode));
check('10', 'Channel 不重設（geoHeatUiSetChannel 函式本體不含 geoHeatState.metric 賦值）', !/function geoHeatUiSetChannel[\s\S]*?geoHeatState\.metric\s*=[\s\S]*?\n\}/.test(uiCode));
check('11', 'Display 不重設（geoHeatUiSetDisplay 函式本體不含 geoHeatState.metric 賦值）', !/function geoHeatUiSetDisplay[\s\S]*?geoHeatState\.metric\s*=[\s\S]*?\n\}/.test(uiCode));
check('12', 'Layer Switch 不重設（geoHeatUiSetLayer 函式本體不含 geoHeatState.metric 賦值）', !/function geoHeatUiSetLayer[\s\S]*?geoHeatState\.metric\s*=[\s\S]*?\n  return true;/.test(uiCode));
check('13', 'API metric 一致（Order Heatmap Engine 既有 API 呼叫直接讀 geoHeatState.metric，未新增查詢參數欄位）', !/params\.metric\s*=/.test(uiCode));
check('14', 'Summary metric 一致（_geoHeatRenderSummaryDom 呼叫方式本輪未修改，仍讀 geoHeatState.metric）', /_geoHeatRenderSummaryDom\(\)/.test(uiCode));
check('15', 'Ranking metric 一致（_geoHeatRenderRankingDom 呼叫方式本輪未修改）', /_geoHeatRenderRankingDom\(\)/.test(uiCode));
check('16', 'Circle metric 一致（geoHeatRenderLayer 呼叫時傳入 geoHeatState.metric，未新增第二個 metric 參數來源）', /geoHeatRenderLayer\(geoHeatState\.areas, geoHeatState\.metric/.test(uiCode));
check('17', 'Marker metric 一致（同上，circle/marker/heat 共用同一次 geoHeatRenderLayer 呼叫）', (uiCode.match(/geoHeatRenderLayer\(geoHeatState\.areas, geoHeatState\.metric/g) || []).length >= 3);
check('18', 'Heat weight 一致（geoHeatComputeStats/geoHeatGetLegend 呼叫均使用 geoHeatState.metric）', /geoHeatGetLegend\(geoHeatState\.metric/.test(heatSrc));
check('19', 'Coverage 使用真實數字（_geoHeatMetricTotals 完全讀取既有 area 欄位 submitted_orders/coordinate_count/revenue，未新增隨機或硬編碼數字）', /a\.submitted_orders/.test(uiCode) && /a\.coordinate_count/.test(uiCode) && /a\.revenue/.test(uiCode));
check('20', '無假 Revenue（_geoHeatMetricTotals 的 revenue 加總完全來自既有 area.revenue 欄位）', /list\.reduce\(\(s, a\) => s \+ \(Number\(a\.revenue\)/.test(uiCode));
check('21', '無假 Distance（_geoHeatBuildDeliveryOptimizationText 在沒有真實 distance 資料時只回傳說明文字，不產生數字）', /function _geoHeatBuildDeliveryOptimizationText/.test(uiCode) && /今日沒有外送訂單/.test(uiSrc));
check('22', '無店家座標冒充（Coverage/Sync 相關函式不含 storeLat/storeCoord 樣式）', !/storeLat|store_lat|storeCoord/i.test(uiCode));
check('23', '無 IP 精確座標（Coverage Explanation 邏輯不呼叫任何 IP resolver）', !/geoResolver|ip-api|ipapi/i.test(uiCode.slice(uiCode.indexOf('_geoHeatBuildCoverageExplanationText'))));
check('24', '無第二張 Map（geo-heatmap-ui.js 本輪新增程式碼不含 new L.map(）', !/new\s+L\.map\(/.test(uiCode));
check('25', '無第二個 Tile Layer（不含 L.tileLayer(）', !/L\.tileLayer\(/.test(uiCode));
check('26', 'G1.2 未退化（_geoHeatUiApplyLayerExclusivity/_geoHeatUiRenderVisitorMapOverlay 仍存在且未被本輪修改移除）', /function _geoHeatUiApplyLayerExclusivity/.test(uiCode) && /function _geoHeatUiRenderVisitorMapOverlay/.test(uiCode));
check('27', 'A7 KPI 未退化（geo-intelligence.js 本輪未修改）', geoIntelligenceSrc.length > 0 && !/geoHeatUiSyncMetricFromGlobal|_geoHeatBuildCoverageExplanationText/.test(geoIntelligenceSrc));
check('28', '無 console.log/debug（G1.3 新增函式區塊）', !/console\.log\(|console\.debug\(/.test(uiCode.slice(uiCode.indexOf('GEO_EVENT_TO_HEATMAP_METRIC'))));
check('29', '無 Math.random()（G1.3 新增函式區塊）', !/Math\.random\(\)/.test(uiCode.slice(uiCode.indexOf('GEO_EVENT_TO_HEATMAP_METRIC'))));
check('30', '無硬編碼 store_001（G1.3 新增函式區塊）', !/['"]store_001['"]/.test(uiCode.slice(uiCode.indexOf('GEO_EVENT_TO_HEATMAP_METRIC'))));

// 額外：G1 GeoLiveLayer 完全未受本輪影響（獨立模組，防止誤植跨模組耦合）
check('EXTRA-1', 'G1 GeoLiveLayer（geo-live-layer.js）本輪完全未修改', !/geoHeatUiSyncMetricFromGlobal|GEO_EVENT_TO_HEATMAP_METRIC/.test(geoLiveLayerSrc));
check('EXTRA-2', 'Order Heatmap Engine（geo-heatmap.js）本輪完全未修改', !/geoHeatUiSyncMetricFromGlobal|_geoHeatBuildCoverageExplanationText/.test(heatSrc));

console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.3 (Geo Metric Sync & Coverage Explanation)');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => { console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`); if (c.ok) okCount++; });
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
