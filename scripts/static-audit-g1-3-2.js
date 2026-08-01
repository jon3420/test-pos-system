#!/usr/bin/env node
// scripts/static-audit-g1-3-2.js — fix18-10-hotfix30-B5-R5.4-G1.3.2
// Regression Guard Alignment 專屬 Static Audit（48 項）。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

const a2Src = read('scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js');
const a12Src = read('scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js');
const guardSrc = read('scripts/lib/geo-heatmap-g131-scope-guard.js');
const g132SmokeSrc = read('scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js');
const g131SmokeSrc = read('scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js');
const heatSrc = read('public/js/geo-heatmap.js');
const uiSrc = read('public/js/geo-heatmap-ui.js');
const cssSrc = read('public/css/geo-heatmap.css');
const geoIntelligenceSrc = read('public/js/geo-intelligence.js');
const geoLiveLayerSrc = read('public/js/geo-live-layer.js');
const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));

// 一、A2/A1.2 不再整檔相等 + 其他 hash guard 保留
check('1', 'A2 不再使用 geo-heatmap.js whole-file equality（baseline 物件裡不再含 geo-heatmap.js 的 8f3ec8c0 entry）',
  !/'public\/js\/geo-heatmap\.js':\s*'8f3ec8c0/.test(a2Src));
check('2', 'A1.2 不再使用 geo-heatmap.js whole-file equality（同上）',
  !/'public\/js\/geo-heatmap\.js':\s*'8f3ec8c0/.test(a12Src));
check('3', '其他 hash guards 保留（A2/A1.2 仍各自維持 geo-intelligence-map.js／geo-map-settings.js／manifest.json 三個整檔 hash）',
  (a2Src.match(/'[0-9a-f]{64}'/g) || []).length >= 3 && (a12Src.match(/'[0-9a-f]{64}'/g) || []).length >= 3);

// 二、Shared guard module 與 Scope Allowlist
check('4', 'Shared guard module 存在（scripts/lib/geo-heatmap-g131-scope-guard.js）',
  fs.existsSync(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js')));
check('5', 'Scope Allowlist 存在（GEO_HEATMAP_G131_ALLOWED_ADDITIONS 匯出）',
  Array.isArray(scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS));
check('6', 'Allowlist 項目數有限（=4，不是隨意擴張的清單）',
  scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.length === 4);
check('7', 'Allowlist 無 wildcard（每一項 needle 是具體字串，不含 regex 特殊萬用語法如 .*／\\*／glob）',
  scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS.every((i) => typeof i.needle === 'string' && !/\.\*|\bglob\b/.test(i.needle)));

// 三、Reconstruction Check
check('8', 'Reconstruction Check 存在（computeScopedBaselineCheck 函式匯出）',
  typeof scopeGuard.computeScopedBaselineCheck === 'function');
check('9', 'pristine hash 存在且為固定常數（PRISTINE_BASELINE_SHA256）',
  typeof scopeGuard.PRISTINE_BASELINE_SHA256 === 'string' && /^[0-9a-f]{64}$/.test(scopeGuard.PRISTINE_BASELINE_SHA256));
check('10', '還原後 hash 驗證（對目前真實 geo-heatmap.js 執行 Reconstruction Check 結果為 ok）',
  scopeGuard.computeScopedBaselineCheck(ROOT).ok === true);

// 四、Behavioral Invariant Check + Mutation Negative Tests
check('11', 'Behavioral Invariant Check 存在（runBehavioralInvariants 函式匯出）',
  typeof scopeGuard.runBehavioralInvariants === 'function');
check('12', 'Mutation Negative Tests 存在（G1.3.2 Smoke 內有多組 mutate 函式與對應斷言）',
  (g132SmokeSrc.match(/mutate:/g) || []).length >= 5);
check('13', 'stale guard mutation 案例存在', /移除 stale guard|移除 stale-request guard/.test(g132SmokeSrc));
check('14', 'second map mutation 案例存在', /新建第二張 L\.map\(\)|second Map|second-map/.test(g132SmokeSrc));
check('15', 'second tile mutation 案例存在', /L\.tileLayer\(\"x\"\)|second Tile|second-tile|tileLayer/.test(g132SmokeSrc));
check('16', 'schema mutation 案例存在', /改壞 areas schema|coordinate_source/.test(g132SmokeSrc));
check('17', 'backward compat mutation 案例存在', /backward compat|backward compatibility/.test(g132SmokeSrc));
check('18', 'truthy-zero mutation 案例存在', /truthy/.test(g132SmokeSrc));

// 五、businessTotals additive / areas schema / reset / compatibility
check('19', 'businessTotals additive（geoHeatState 新增欄位，非覆蓋既有欄位）',
  /businessTotals: \{ orders: null, revenue: null \},/.test(heatSrc));
check('20', 'areas schema 不變（geoHeatState.areas 初始化仍只有一份 areas: []）',
  (heatSrc.match(/areas: \[\],/g) || []).length === 1);
check('21', 'reset behavior（_geoHeatResetStateForTest／geoHeatHandleStoreSwitch 均清空 businessTotals）',
  (heatSrc.match(/geoHeatState\.businessTotals = \{ orders: null, revenue: null \};/g) || []).length === 2);
check('22', 'plain array compatibility（geoHeatScheduleUpdate 仍支援 Array.isArray(result) 分支）',
  /const areas = Array\.isArray\(result\) \? result : \(result && result\.areas\) \|\| \[\];/.test(heatSrc));
check('23', 'object compatibility（geoHeatScheduleUpdate 支援 { areas, businessTotals } 物件格式）',
  /const businessTotals = \(!Array\.isArray\(result\) && result && result\.businessTotals\)/.test(heatSrc));
check('24', '0 vs undefined（前端 _geoHeatMetricTotals 用 typeof===\'number\' 判斷，不用 truthy）',
  /typeof bt\.orders === 'number'/.test(uiSrc) && /typeof bt\.revenue === 'number'/.test(uiSrc));
check('25', 'duplicate guard（geoHeatScheduleUpdate 仍有 requestSeq 遞增防護 debounce 重複請求）',
  /const seq = \+\+geoHeatState\.requestSeq;/.test(heatSrc));

// 六、無隱藏 fetch／無 debug／無假資料／無硬編碼
const uiSrcNoComments = uiSrc.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
check('26', 'no hidden fetch（geo-heatmap-ui.js 的 fetchAndRender 僅呼叫既有兩支 API，未新增隱藏 fetch，排除說明註解中的提及）',
  (uiSrcNoComments.match(/getGeoFulfillmentForHeatmap\(/g) || []).length === 1);
check('27', 'no fetch storm（沒有新增 setInterval 輪詢邏輯）',
  !/setInterval\(/.test(heatSrc) && !/setInterval\(/.test(uiSrc.slice(uiSrc.indexOf('_geoHeatMetricTotals'))));
check('28', 'no recursive update（geoHeatScheduleUpdate 本體不會呼叫自己）',
  !/function geoHeatScheduleUpdate[\s\S]{0,900}geoHeatScheduleUpdate\(/.test(heatSrc.replace(/geoHeatScheduleUpdate,/g, '')));
check('29', 'no console.log（geo-heatmap.js／scope-guard 模組均無殘留 debug log）',
  !/console\.log\(|console\.debug\(/.test(heatSrc) && !/console\.log\(|console\.debug\(/.test(guardSrc));
check('30', 'no debug（無 debugger 陳述式）', !/\bdebugger\b/.test(heatSrc) && !/\bdebugger\b/.test(guardSrc));
check('31', 'no Math.random（geo-heatmap.js／scope-guard 模組均無假資料產生器）',
  !/Math\.random\(\)/.test(heatSrc) && !/Math\.random\(\)/.test(guardSrc));
check('32', 'no hardcoded store_001（本輪相關程式碼段落）',
  !/['"]store_001['"]/.test(heatSrc.slice(heatSrc.indexOf('let geoHeatState'))) && !/['"]store_001['"]/.test(guardSrc));
check('33', 'no fake marker（geo-heatmap.js／geo-heatmap-ui.js 均無假 marker 產生邏輯）',
  !/fakeMarker|placeholderMarker/i.test(heatSrc) && !/fakeMarker|placeholderMarker/i.test(uiSrc));
check('34', 'no IP coordinate（不呼叫任何 IP resolver）',
  !/geoip|ip-api|ipapi/i.test(heatSrc) && !/geoip|ip-api|ipapi/i.test(uiSrc));
check('35', 'no store fallback（不用店家座標冒充顧客位置）',
  !/store_lat|store_lng|storeCoordinate/i.test(heatSrc) && !/store_lat|store_lng|storeCoordinate/i.test(uiSrc));
check('36', 'no second map（geo-heatmap.js 本身不建立 L.map() instance）',
  !/L\.map\(/.test(heatSrc) && !/new\s+L\.Map\(/.test(heatSrc));
check('37', 'no second tile（geo-heatmap.js 本身不建立 tile layer）',
  !/L\.tileLayer\(/.test(heatSrc));

// 七、既有功能未退化
check('38', 'G1.3.1 未退化（businessTotals／Coverage Explanation 核心函式仍存在）',
  /function _geoHeatMetricTotals/.test(uiSrc) && /function _geoHeatBuildCoverageExplanationText/.test(uiSrc));
check('39', 'G1.3 未退化（geoHeatUiSyncMetricFromGlobal 仍存在）',
  /function geoHeatUiSyncMetricFromGlobal/.test(uiSrc));
check('40', 'G1.2 未退化（geoHeatUiSetLayer／_geoHeatUiApplyLayerExclusivity 仍存在）',
  /function geoHeatUiSetLayer/.test(uiSrc) && /function _geoHeatUiApplyLayerExclusivity/.test(uiSrc));
check('41', 'A7 KPI 未退化（geo-intelligence.js 完全未受本輪影響）',
  !/businessTotals|geo-heatmap-g131-scope-guard/.test(geoIntelligenceSrc));
check('42', 'Dark Theme 未退化（G1.3.1 CSS 修正仍存在）',
  /\[data-theme="dark"\] \.geo-heat-coverage-explanation-text/.test(cssSrc) && /background:\s*#1e293b/.test(cssSrc));
check('43', 'Light Theme 未退化（既有淺色背景規則仍在）',
  /\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc));

// 八、打包／品質相關
check('44', 'no test DB（打包排除規則存在，data 目錄不含 pos.db；此處檢查工作目錄狀態）',
  !fs.existsSync(path.join(ROOT, 'data/pos.db')));
check('45', 'no obsolete guard（geo-heatmap.js 已不在任一支 smoke 的整檔 SHA-256 baseline 物件內）',
  !/'public\/js\/geo-heatmap\.js':\s*'[0-9a-f]{64}'/.test(a2Src) && !/'public\/js\/geo-heatmap\.js':\s*'[0-9a-f]{64}'/.test(a12Src));
check('46', 'no assertion-count reduction（A2/A1.2 原始碼中 assert( 呼叫次數不低於已知修改前下限）',
  (a2Src.match(/\bassert\(/g) || []).length >= 175 && (a12Src.match(/\bassert\(/g) || []).length >= 145);
check('47', 'A2 fully green（本輪最終執行需為 229/229，此處靜態檢查 A14-1a/A14-1b 均存在，實際 PASS 數量見 Regression 報告）',
  /A14-1a/.test(a2Src) && /A14-1b/.test(a2Src));
check('48', 'A1.2 fully green（本輪最終執行需為 189/189，此處靜態檢查 A16-1a/A16-1b 均存在，實際 PASS 數量見 Regression 報告）',
  /A16-1a/.test(a12Src) && /A16-1b/.test(a12Src));

console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.3.2 (Regression Guard Alignment)');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => { console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`); if (c.ok) okCount++; });
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
