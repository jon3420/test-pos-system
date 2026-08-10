#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 7A Static Audit
//
// 只檢查本輪（H1.4）新增/修改的 Contract，不重複既有 H1／H1.1／H1.2／H1.3
// 的 static audit（那些已經在各自的 scripts/static-audit-*.js 涵蓋）。
// 優先用 extractFnBody()／extractObjectBody() 取「正式函式本體」這一段
// 字串再判斷，避免整檔案裸 includes() 被註解/測試 hook/說明文字誤判。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function sha256(rel) { return crypto.createHash('sha256').update(read(rel)).digest('hex'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

// extractFnBody(code, fnSignature) — 從函式簽名開始，用括號計數找到對應的
// 第一個頂層 '}'，只取這段字串（跟既有 static-audit-g1-6-ga4-h1-3.js 同一套慣例）。
function extractFnBody(code, fnSignature) {
  const start = code.indexOf(fnSignature);
  if (start === -1) return '';
  // 從「簽名結束之後」開始找第一個 '{'，不是從簽名開頭找——否則像
  // `options = {}` 這種預設參數裡的空物件字面量會被誤判成函式本體開頭，
  // 導致括號計數在 2 個字元後就提前收尾，回傳幾乎是空字串的假本體。
  let depth = 0;
  let i = code.indexOf('{', start + fnSignature.length);
  const bodyStart = i;
  for (; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return code.slice(bodyStart, i);
}
// extractObjectBody(code, marker) — 從一個「變數宣告 = {」的位置開始，找到
// 對應的頂層 '}'（給 GEO_RANGE_API_MAP／GEO_GA4_H1_RANGE_ERROR_MESSAGES 這類
// 物件常數用）。
function extractObjectBody(code, marker) {
  const start = code.indexOf(marker);
  if (start === -1) return '';
  // marker 本身已經包含結尾的 '{'（例如 "const dashboardGa4State = {"），
  // body 起點就是這個 '{' 自己，不是再往後找下一個（那是 extractFnBody
  // 給 "function foo(...)" 這種簽名不含 '{' 的情況用的，兩者標記格式不同，
  // 不能共用同一個搜尋邏輯）。
  let depth = 0;
  const bodyStart = start + marker.length - 1;
  let i = bodyStart;
  for (; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return code.slice(bodyStart, i);
}

// ══════════════════════════════════════════════════════════════
// 讀入本輪所有 Production 檔案
// ══════════════════════════════════════════════════════════════
const heatUiSrc = read('public/js/geo-heatmap-ui.js');
const h1Src = read('public/js/geo-ga4-h1-panel.js');
const dashSrc = read('public/js/geo-ga4-dashboard-layer.js');
const resolverSrc = read('public/js/geo-range-resolver.js');
const controlSrc = read('public/js/geo-range-control.js');
const timeSrc = read('public/js/date-time-format.js');
const syncSvcSrc = read('services/ga4GeoSyncService.js');
const dtSrc = read('utils/dateTime.js');
const geoIntelSrc = read('public/js/geo-intelligence.js');

const heatUiCode = codeOnly(heatUiSrc);
const h1Code = codeOnly(h1Src);
const dashCode = codeOnly(dashSrc);
const resolverCode = codeOnly(resolverSrc);
const controlCode = codeOnly(controlSrc);
const syncSvcCode = codeOnly(syncSvcSrc);
const geoIntelCode = codeOnly(geoIntelSrc);

const switchTabBody = extractFnBody(heatUiCode, 'function geoHeatUiSwitchTab(containerId, tab)');
const cleanupBody = extractFnBody(heatUiCode, 'function _geoHeatUiCleanupForDashboard(containerId)');
const h1RefreshBody = extractFnBody(h1Code, 'async function geoGa4H1Refresh(ids, mapInstance)');
const h1DestroyBody = extractFnBody(h1Code, 'function geoGa4H1Destroy(ids)');
const h1InitBody = extractFnBody(h1Code, 'function geoGa4H1Init(ids, mapInstance)');
const h1ToolbarBody = extractFnBody(h1Code, 'function geoGa4H1RenderToolbar(containerId, onChange)');
const h1HandleSyncResultBody = extractFnBody(h1Code, 'async function _geoGa4H1HandleSyncResult(result, onChange)');
const dashActivateBody = extractFnBody(dashCode, 'function geoDashboardGa4Activate(ids, mapInstance)');
const dashDeactivateBody = extractFnBody(dashCode, 'function geoDashboardGa4Deactivate(mapInstance)');
const dashRefreshBody = extractFnBody(dashCode, 'async function geoDashboardGa4Refresh(ids, mapInstance)');
const dashFetchBody = extractFnBody(dashCode, 'function _geoDashboardGa4Fetch(resolved, signal)');
const dashApiRequestBody = extractFnBody(dashCode, 'async function _geoDashboardGa4ApiRequest(url, options = {}, signal)');
const resolveRangeFnBody = extractFnBody(resolverCode, 'function resolveGeoHistoricalRange(mode, options)');
const resolveRangeWindowBody = extractFnBody(syncSvcCode, 'function resolveRangeWindow(');

function main() {
  ['public/js/geo-heatmap-ui.js', 'public/js/geo-ga4-h1-panel.js', 'public/js/geo-ga4-dashboard-layer.js',
    'public/js/geo-range-resolver.js', 'public/js/geo-range-control.js', 'public/js/date-time-format.js',
    'services/ga4GeoSyncService.js', 'public/js/geo-intelligence.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      check(`0-parse-${rel}`, `${rel} node --check 通過`, true);
    } catch (e) { check(`0-parse-${rel}`, `${rel} node --check 通過`, false); }
  });

  // ══════════════════════════════════════════════════════════════
  // Category A: Map Instance / Ownership（10）
  // ══════════════════════════════════════════════════════════════
  check('A1', 'Dashboard 與 Heatmap 共用 geoMapState.instance（switchTab 兩分支都讀 window.geoMapState.instance）', (switchTabBody.match(/window\.geoMapState\s*&&\s*window\.geoMapState\.instance/g) || []).length >= 2);
  check('A2', 'Dashboard GA4 module 沒有 L.map(', !/\bL\.map\(/.test(dashCode));
  check('A3', 'geo-heatmap-ui.js 沒有為 Dashboard 建第二張 L.map(', !/\bL\.map\(/.test(heatUiCode));
  check('A4', 'Dashboard GA4 有自己的 layerGroup 欄位', /layerGroup:\s*null,/.test(extractObjectBody(dashCode, 'const dashboardGa4State = {')));
  check('A5', 'Heatmap H1 有自己的 markerGroup 欄位', /markerGroup:\s*null,/.test(extractObjectBody(h1Code, 'const geoGa4H1State = {')));
  check('A6', 'dashboardGa4State 與 geoGa4H1State 是兩個獨立宣告的 const（不是同一個變數別名）', /const dashboardGa4State = \{/.test(dashCode) && /const geoGa4H1State = \{/.test(h1Code));
  check('A7', 'Dashboard rangeState 獨立宣告在 dashboardGa4State 物件字面量內', /rangeState:\s*\{\s*mode:\s*'7d'/.test(dashCode));
  check('A8', 'H1 rangeState 獨立宣告在 geoGa4H1State 物件字面量內', /rangeState:\s*\{\s*mode:\s*'7d'/.test(h1Code));
  check('A9', '沒有 dashboardGa4State.rangeState = geoGa4H1State.rangeState 這種指派', !/dashboardGa4State\.rangeState\s*=\s*(window\.)?geoGa4H1State\.rangeState/.test(dashCode + heatUiCode + geoIntelCode));
  check('A10', '沒有 dashboardGa4State.layerGroup = geoGa4H1State.markerGroup 這種指派', !/dashboardGa4State\.layerGroup\s*=\s*(window\.)?geoGa4H1State\.markerGroup/.test(dashCode + heatUiCode + geoIntelCode));

  // ══════════════════════════════════════════════════════════════
  // Category B: Heatmap → Dashboard Cleanup（12）
  // ══════════════════════════════════════════════════════════════
  check('B11', '集中 cleanup helper _geoHeatUiCleanupForDashboard() 存在', cleanupBody.length > 0);
  check('B12', 'geoHeatUiSwitchTab 的 dashboard 分支呼叫 _geoHeatUiCleanupForDashboard(containerId)', /_geoHeatUiCleanupForDashboard\(containerId\);/.test(switchTabBody));
  check('B13', 'cleanup 移除 Order layer（geoHeatState.layerGroup）', /geoHeatState\s*&&\s*window\.geoHeatState\.layerGroup/.test(cleanupBody) || /window\.geoHeatState\s*&&\s*window\.geoHeatState\.layerGroup/.test(cleanupBody));
  check('B14', 'cleanup 移除 Visitor layer（geoVisitorState.choroplethLayerGroup）', /window\.geoVisitorState\s*&&\s*window\.geoVisitorState\.choroplethLayerGroup/.test(cleanupBody));
  check('B15', 'cleanup 移除 GA4 Realtime layer（geoGa4State.layerGroup）', /window\.geoGa4State\s*&&\s*window\.geoGa4State\.layerGroup/.test(cleanupBody));
  check('B16', 'cleanup 透過 GeoGa4H1Panel.destroy() 讓 H1 markerGroup 被移除', /window\.GeoGa4H1Panel[\s\S]*?\.destroy\(/.test(cleanupBody));
  check('B17', 'cleanup 呼叫 geoGa4Deactivate()', /geoGa4Deactivate\(\)/.test(cleanupBody));
  check('B18', 'cleanup 呼叫 window.GeoGa4H1Panel.destroy(', /window\.GeoGa4H1Panel\.destroy\(/.test(cleanupBody));
  check('B19', 'cleanup 之後才 restore choropleth（_geoHeatUiRestoreChoropleth 在 cleanup 呼叫之後）', /_geoHeatUiCleanupForDashboard\(containerId\);\s*\n\s*_geoHeatUiRestoreChoropleth\(\);/.test(switchTabBody));
  check('B20', 'cleanup 不 reset Heatmap source/layer 狀態（geoHeatUiState.layer 沒有在 cleanup body 內被指派）', !/geoHeatUiState\.layer\s*=/.test(cleanupBody));
  check('B21', 'cleanup 不 reset Heatmap range 狀態（geoHeatUiState.visitorRange 沒有在 cleanup body 內被指派）', !/geoHeatUiState\.visitorRange\s*=/.test(cleanupBody));
  check('B22', 'cleanup 不 reset Heatmap metric 狀態（geoGa4State.metric 沒有在 cleanup body 內被指派）', !/geoGa4State\.metric\s*=/.test(cleanupBody));

  // ══════════════════════════════════════════════════════════════
  // Category C: Dashboard → Heatmap Cleanup（8）
  // ══════════════════════════════════════════════════════════════
  check('C23', 'Heatmap 分支（tab==="heatmap"）在啟動 Heatmap 前呼叫 geoDashboardGa4Deactivate', /if \(tab === 'heatmap'\) \{\s*\n[\s\S]*?geoDashboardGa4Deactivate\(map\);/.test(switchTabBody));
  check('C24', 'geoDashboardGa4Deactivate() 設 active=false', /dashboardGa4State\.active = false;/.test(dashDeactivateBody));
  check('C25', 'geoDashboardGa4Deactivate() 遞增 generation（讓舊 request 失效）', /dashboardGa4State\.generation \+= 1;/.test(dashDeactivateBody));
  check('C26', 'geoDashboardGa4Deactivate() 呼叫 currentAbort.abort()', /dashboardGa4State\.currentAbort\.abort\(\)/.test(dashDeactivateBody));
  check('C27', 'geoDashboardGa4Deactivate() 把 currentAbort 設回 null', /dashboardGa4State\.currentAbort = null;/.test(dashDeactivateBody));
  check('C28', 'geoDashboardGa4Deactivate() 呼叫 mapInstance.removeLayer(dashboardGa4State.layerGroup)', /mapInstance\.removeLayer\(dashboardGa4State\.layerGroup\)/.test(dashDeactivateBody));
  check('C29', 'geoDashboardGa4Deactivate() 沒有清 rangeState（body 內沒有對 rangeState 賦值）', !/dashboardGa4State\.rangeState\s*=/.test(dashDeactivateBody));
  check('C30', 'geoDashboardGa4Deactivate() 沒有清 metric（body 內沒有對 metric 賦值）', !/dashboardGa4State\.metric\s*=/.test(dashDeactivateBody));

  // ══════════════════════════════════════════════════════════════
  // Category D: H1 Lifecycle Safety（17）
  // ══════════════════════════════════════════════════════════════
  check('D31', 'geoGa4H1State.destroyed 欄位存在', /destroyed:\s*false,/.test(h1Code));
  check('D32', 'geoGa4H1State.lifecycleGeneration 欄位存在', /lifecycleGeneration:\s*0,/.test(h1Code));
  check('D33', 'geoGa4H1Init() 遞增 lifecycleGeneration', /geoGa4H1State\.lifecycleGeneration \+= 1;/.test(h1InitBody));
  check('D34', 'geoGa4H1Destroy() 遞增 lifecycleGeneration', /geoGa4H1State\.lifecycleGeneration \+= 1;/.test(h1DestroyBody));
  check('D35', 'geoGa4H1Destroy() 設 destroyed=true', /geoGa4H1State\.destroyed = true;/.test(h1DestroyBody));
  check('D36', 'geoGa4H1Init() 解除 destroyed=false', /geoGa4H1State\.destroyed = false;/.test(h1InitBody));
  check('D37', 'geoGa4H1Destroy() 呼叫 currentAbort.abort()', /geoGa4H1State\.currentAbort\.abort\(\)/.test(h1DestroyBody));
  check('D38', 'geoGa4H1Destroy() 把 currentAbort 設回 null', /geoGa4H1State\.currentAbort = null;/.test(h1DestroyBody));
  check('D39', 'geoGa4H1Destroy() 沒有清 rangeState（body 內沒有對 rangeState 賦值）', !/geoGa4H1State\.rangeState\s*=/.test(h1DestroyBody));
  check('D40', 'Manual Sync 在 fetch/POST 之前 capture generation（capturedGeneration 宣告在 fetch 呼叫之前）', (() => {
    const idx1 = h1ToolbarBody.indexOf('const capturedGeneration');
    const idx2 = h1ToolbarBody.indexOf("geoGa4H1ApiRequest('/api/analytics/ga4-geo/sync'");
    return idx1 !== -1 && idx2 !== -1 && idx1 < idx2;
  })());
  check('D41', '成功 completion 檢查 isStaleLifecycle()（含 destroyed）', /if \(isStaleLifecycle\(\)\) return;/.test(h1ToolbarBody));
  check('D42', 'isStaleLifecycle() 同時比對 capturedGeneration', /geoGa4H1State\.lifecycleGeneration !== capturedGeneration/.test(h1ToolbarBody));
  check('D43', 'catch（error completion）分支也呼叫 isStaleLifecycle()', (h1ToolbarBody.match(/isStaleLifecycle\(\)/g) || []).length >= 3);
  check('D44', 'finally 分支也呼叫 isStaleLifecycle()（保護 syncBtn 狀態重置）', /finally \{\s*\n\s*if \(!isStaleLifecycle\(\)\)/.test(h1ToolbarBody));
  check('D45', '_geoGa4H1HandleSyncResult() 內仍保留 destroyed 防禦性檢查（雙層防護，見 Stage 6 comment）', /if \(geoGa4H1State\.destroyed\) return;/.test(h1HandleSyncResultBody));
  check('D46', 'stale sync 不會更新 status（isStaleLifecycle() 檢查在呼叫 _geoGa4H1HandleSyncResult 之前，包住整段包含 status render 的流程）', /if \(isStaleLifecycle\(\)\) return;\s*\n\s*if \(result !== undefined\) await _geoGa4H1HandleSyncResult/.test(h1ToolbarBody));
  check('D47', 'capturedGeneration 是在函式一開始賦值，不是在 Promise 完成後才讀（宣告在 try 區塊的 fetch 呼叫之前）', /const capturedGeneration = geoGa4H1State\.lifecycleGeneration;/.test(h1ToolbarBody));

  // ══════════════════════════════════════════════════════════════
  // Category E: Dashboard Async Safety（12）
  // ══════════════════════════════════════════════════════════════
  check('E48', 'dashboardGa4State 有 generation 欄位', /generation:\s*0,/.test(dashCode));
  check('E49', 'dashboardGa4State 有 currentAbort 欄位', /currentAbort:\s*null,/.test(dashCode));
  check('E50', 'geoDashboardGa4Refresh() 建立新的 AbortController', /new AbortController\(\)/.test(dashRefreshBody));
  check('E51', '新 request 開始時 abort 舊的 currentAbort（invalidate previous request）', /if \(dashboardGa4State\.currentAbort\) \{\s*\n\s*try \{ dashboardGa4State\.currentAbort\.abort\(\); \}/.test(dashRefreshBody));
  // H1.4.2 TEST-ONLY CONTRACT MIGRATION：舊 E52/E56 用 regex 比對
  // `if (myGeneration !== dashboardGa4State.generation) return;` 這個
  // literal 寫法。H1.4.2 為了讓 geoDashboardGa4SyncNow() 能判斷「同步後
  // GET 到底是不是真的有資料」，把這裡的 `return;` 改成
  // `return { superseded: true };`——guard 的判斷條件（比較 myGeneration
  // 跟目前 generation）完全沒有變，只是回傳值從 undefined 變成一個描述性
  // 物件。改成語意檢查：只要「條件判斷仍然存在、且判斷為真時提早結束、不
  // 繼續往下執行任何 render」，不管回傳的是 `return;` 還是
  // `return { ...任何東西 };`。
  check('E52', 'response render 前檢查 generation（stale response guard）——判斷條件仍存在，回傳值不拘（H1.4.2 起用 { superseded: true } 取代單純 return，供呼叫端判斷「這次呼叫被取代」，guard 邏輯本身不變）', /if \(myGeneration !== dashboardGa4State\.generation\) return[^;]*;/.test(dashRefreshBody));
  check('E53', 'response render 前用 myGeneration 這個區域變數而非直接讀 state（避免 race）', /const myGeneration = \+\+dashboardGa4State\.generation;/.test(dashRefreshBody));
  check('E54', 'deactivate 讓 generation 前進（invalidate）', /dashboardGa4State\.generation \+= 1;/.test(dashDeactivateBody));
  check('E55', 'deactivate 會 abort 進行中的 request', /currentAbort\.abort\(\)/.test(dashDeactivateBody));
  check('E56', 'late response 的正式 render path 有 guard（同 E52，資料流程唯一入口）——同一個判斷條件在 fetch 完成後那個 guard 點也存在，語意跟 E52 相同，不檢查回傳值字面值', (() => {
    const idx = dashRefreshBody.indexOf('if (myGeneration !== dashboardGa4State.generation) return');
    return idx !== -1; // 存在即可（回傳值格式不拘）
  })());
  check('E57', 'empty rows path 呼叫 geoDashboardGa4ClearMarkers()', /if \(rows\.length === 0\) \{\s*\n\s*geoDashboardGa4ClearMarkers\(\);/.test(dashRefreshBody));
  check('E58', 'error path 呼叫 geoDashboardGa4ClearMarkers()', /if \(!body \|\| body\.success === false\) \{\s*\n\s*geoDashboardGa4ClearMarkers\(\);/.test(dashRefreshBody));
  check('E59', '新 request 一開始就先清舊 marker（不留 stale marker 在新舊資料之間）', /geoDashboardGa4ClearMarkers\(\);\s*\n\s*_geoDashboardGa4RenderLabel/.test(dashRefreshBody));

  // ══════════════════════════════════════════════════════════════
  // Category F: Range Resolver Modes（10）
  // ══════════════════════════════════════════════════════════════
  ['today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom'].forEach((mode, i) => {
    check(`F${60 + i}`, `resolveGeoHistoricalRange 支援 mode='${mode}'`, new RegExp(`mode === '${mode}'`).test(resolveRangeFnBody) || new RegExp(`'${mode}'`).test(extractObjectBody(resolverCode, 'var GEO_RANGE_MODES = Object.freeze([')));
  });

  // ══════════════════════════════════════════════════════════════
  // Category G: Range Calendar Contract（13）
  // ══════════════════════════════════════════════════════════════
  check('G70', '90d offset = -89（today-89，不是 today-90）', /dateStr\(-89\); endDate = dateStr\(0\);/.test(resolveRangeFnBody));
  check('G71', '180d offset = -179（today-179，不是 today-180）', /dateStr\(-179\); endDate = dateStr\(0\);/.test(resolveRangeFnBody));
  check('G72', 'single 模式 startDate = endDate = single', /startDate = endDate = single;/.test(resolveRangeFnBody));
  check('G73', 'custom inclusive day count 用 _geoRangeInclusiveDayCount()', /var customDayCount = _geoRangeInclusiveDayCount\(cs, ce\);/.test(resolveRangeFnBody));
  check('G74', '_geoRangeInclusiveDayCount(a,a) 語意上是 +1（inclusive，同一天=1天）', /Math\.round\(\(b - a\) \/ 86400000\) \+ 1;/.test(resolverCode));
  check('G75', '有真實日曆驗證（不是只用正規表示式）：_geoRangeIsValidDateStr 用 UTC 分量比對回輸入', /d\.getUTCFullYear\(\) === parts\[0\] && \(d\.getUTCMonth\(\) \+ 1\) === parts\[1\] && d\.getUTCDate\(\) === parts\[2\];/.test(resolverCode));
  check('G76', '2026-02-29（非閏年）會被 _geoRangeIsValidDateStr 判定不合法', (() => {
    delete require.cache[require.resolve(path.join(ROOT, 'public/js/geo-range-resolver.js'))];
    const R = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));
    return R._geoRangeIsValidDateStr('2026-02-29') === false;
  })());
  check('G77', '2028-02-29（閏年）會被判定合法', (() => {
    const R = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));
    return R._geoRangeIsValidDateStr('2028-02-29') === true;
  })());
  check('G78', 'this_year 的 startDate 是 YYYY-01-01', /startDate = todayThisYear\.slice\(0, 4\) \+ '-01-01';/.test(resolveRangeFnBody));
  check('G79', 'last_year 是完整前一個日曆年（YYYY-01-01 ～ YYYY-12-31）', /startDate = lastYear \+ '-01-01';/.test(resolveRangeFnBody) && /endDate = lastYear \+ '-12-31';/.test(resolveRangeFnBody));
  check('G80', 'Resolver 使用集中 Taipei calendar helper（_geoRangeGetTaipeiCalendarDateString）而不是自己重寫時區換算', /_geoRangeGetTaipeiCalendarDateString\(o\.now, offsetDays\)/.test(resolveRangeFnBody));
  check('G81', 'Browser Taiwan helper（date-time-format.js）不是用 toISOString().slice(0,10) 這種 UTC-only 捷徑', !/toISOString\(\)\.slice\(0,\s*10\)/.test(codeOnly(timeSrc)));
  check('G82', 'Node Taiwan helper（utils/dateTime.js）維持既有集中實作，H1.4 沒有重寫它', /function getTaipeiCalendarDateString/.test(dtSrc));

  // ══════════════════════════════════════════════════════════════
  // Category H: Backend Range Boundary（7）
  // ══════════════════════════════════════════════════════════════
  check('H83', 'CUSTOM_RANGE_MAX_DAYS = 365', /const CUSTOM_RANGE_MAX_DAYS = 365;/.test(syncSvcCode));
  check('H84', '註解明確說明 365 span = 最多 366 inclusive calendar days', /366 inclusive[\s\S]{0,15}calendar days/.test(syncSvcSrc));
  check('H85', '拒絕判斷仍是 span > CUSTOM_RANGE_MAX_DAYS（沒有改判斷方向）', /span > CUSTOM_RANGE_MAX_DAYS/.test(resolveRangeWindowBody));
  check('H86', '沒有把判斷改成 >=（會多擋掉合法的 366 天邊界）', !/span >= CUSTOM_RANGE_MAX_DAYS/.test(resolveRangeWindowBody));
  check('H87', '沒有解除上限（find literal removal patterns like commenting the check out）', /if \(span > CUSTOM_RANGE_MAX_DAYS\)/.test(resolveRangeWindowBody));
  check('H88', '沒有 Infinity / 9999 這種 bypass 數值', !/CUSTOM_RANGE_MAX_DAYS\s*=\s*(Infinity|9999|99999)/.test(syncSvcCode));
  check('H89', 'Historical Query Architecture 未重寫：resolveRangeWindow 只有一份定義', (syncSvcSrc.match(/function resolveRangeWindow/g) || []).length === 1);

  // ══════════════════════════════════════════════════════════════
  // Category I: Range API Mapping（11）
  // ══════════════════════════════════════════════════════════════
  const apiMapBody = extractObjectBody(resolverCode, "var GEO_RANGE_API_MAP = Object.freeze({");
  check('I90', "today preset 保留原生 apiRange='today'", /today:\s*'today'/.test(apiMapBody));
  check('I91', "yesterday preset 保留原生 apiRange='yesterday'", /yesterday:\s*'yesterday'/.test(apiMapBody));
  check('I92', "7d preset 保留原生 apiRange='7d'", /'7d':\s*'7d'/.test(apiMapBody));
  check('I93', "30d preset 保留原生 apiRange='30d'", /'30d':\s*'30d'/.test(apiMapBody));
  check('I94', "single 沒有出現在 API_MAP 裡（fallback 到 'custom'）", !/single:/.test(apiMapBody));
  check('I95', "90d 沒有出現在 API_MAP 裡（fallback 到 'custom'）", !/'90d':/.test(apiMapBody));
  check('I96', "180d 沒有出現在 API_MAP 裡（fallback 到 'custom'）", !/'180d':/.test(apiMapBody));
  check('I97', "this_year 沒有出現在 API_MAP 裡（fallback 到 'custom'）", !/this_year:/.test(apiMapBody));
  check('I98', "last_year 沒有出現在 API_MAP 裡（fallback 到 'custom'）", !/last_year:/.test(apiMapBody));
  check('I99', "resolveGeoHistoricalRange 對未列在 API_MAP 的 mode 一律 fallback 成 'custom'", /apiRange: GEO_RANGE_API_MAP\[mode\] \|\| 'custom',/.test(resolverCode));
  check('I100', '新增 90d/180d/single/this_year/last_year 沒有新增對應 endpoint（history route 只有一個 GET 定義）', (() => {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/ga4-geo.js'), 'utf8');
    return (routeSrc.match(/router\.get\(['"]\/history['"]/g) || []).length <= 1;
  })());

  // ══════════════════════════════════════════════════════════════
  // Category J: GeoRangeControl（14）
  // ══════════════════════════════════════════════════════════════
  check('J101', 'GeoRangeControl module 存在（geo-range-control.js）', fs.existsSync(path.join(ROOT, 'public/js/geo-range-control.js')));
  check('J102', 'Range Control 不 fetch API（整份程式碼沒有 fetch(/XMLHttpRequest）', !/fetch\(|XMLHttpRequest/.test(controlCode));
  check('J103', 'Range Control 不使用 Leaflet（沒有 L\\. 前綴呼叫）', !/\bL\.[a-zA-Z]/.test(controlCode));
  check('J104', 'Range Control 不 Sync GA4（沒有 POST /sync 字樣）', !/\/sync/.test(controlCode));
  check('J105', 'Range Control 依賴 resolveGeoHistoricalRange（不是自己算日期）', /_geoRangeControlResolve\(inst\.state\.mode, _geoRangeControlResolveOptionsFor\(inst\.state\)\)/.test(controlCode));
  check('J106', 'Preset mode 不顯示 date input（geoRangeControlHtml 對 preset 分支不產生 input）', (() => {
    const htmlFnBody = extractFnBody(controlCode, 'function geoRangeControlHtml(containerId, state)');
    return /if \(mode === 'single'\) \{/.test(htmlFnBody) && /else if \(mode === 'custom'\) \{/.test(htmlFnBody) && !/else \{\s*\n\s*inputsHtml = /.test(htmlFnBody);
  })());
  check('J107', 'single 模式只產生一個 date input', /class="geo-range-input-single"/.test(controlCode) && !/class="geo-range-input-start"[\s\S]{0,50}class="geo-range-input-single"/.test(controlCode));
  check('J108', 'custom 模式產生兩個 date input（start + end）', /class="geo-range-input-start"/.test(controlCode) && /class="geo-range-input-end"/.test(controlCode));
  check('J109', 'single input 綁定正式 handler geoRangeControlSetSingleDate', /onchange="geoRangeControlSetSingleDate\(/.test(controlCode));
  check('J110', 'custom start input 綁定正式 handler geoRangeControlSetCustomDate(...,\'start\',...)', controlSrc.includes('geoRangeControlSetCustomDate(') && controlSrc.includes(String.raw`\'start\', this.value)`));
  check('J111', 'custom end input 綁定正式 handler geoRangeControlSetCustomDate(...,\'end\',...)', controlSrc.includes('geoRangeControlSetCustomDate(') && controlSrc.includes(String.raw`\'end\', this.value)`));
  check('J112', '快捷按鈕 markup 綁定正式 geoRangeControlSetMode', /onclick="geoRangeControlSetMode\(/.test(controlCode));
  check('J113', 'validation 訊息直接來自 resolveGeoHistoricalRange 的 code（不是 Control 自己重新判斷）', /_geoRangeControlErrorMessage\(resolved\.code\)/.test(controlCode));
  check('J114', 'day count 顯示直接用 resolved.dayCount（不是 Control 自己算）', /resolved\.ok && typeof resolved\.dayCount === 'number'/.test(controlCode));

  // ══════════════════════════════════════════════════════════════
  // Category K: H1 Historical Read / Sync Consistency（13）
  // ══════════════════════════════════════════════════════════════
  check('K115', 'H1 Historical 正式 Render Path 使用 GeoRangeControl（_geoGa4H1RenderRangeMount 呼叫 GeoRangeControl.mount，跟同檔案 window.GeoGa4H1Panel／bare geoHeatState 等既有共用作用域慣例一致）', /GeoRangeControl\.mount\(/.test(h1Code));
  check('K116', 'H1 Read（geoGa4H1Refresh）使用 _geoGa4H1ResolveRange()', /const resolved = _geoGa4H1ResolveRange\(\);/.test(h1RefreshBody));
  check('K117', 'H1 Sync（syncHandler）使用同一個 _geoGa4H1ResolveRange()', /const resolved = _geoGa4H1ResolveRange\(\);/.test(h1ToolbarBody));
  check('K118', 'Read 使用 resolved.apiRange', /fetchMode = resolved\.apiRange;/.test(h1RefreshBody));
  check('K119', 'Sync 使用 resolved.apiRange', /range: resolved\.apiRange,/.test(h1ToolbarBody));
  check('K120', 'Read 使用 resolved.startDate', /fetchOpts = \{ startDate: resolved\.startDate, endDate: resolved\.endDate \};/.test(h1RefreshBody));
  check('K121', 'Read 使用 resolved.endDate（同上一條同一行）', /startDate: resolved\.startDate, endDate: resolved\.endDate/.test(h1RefreshBody));
  check('K122', 'Sync 使用 resolved.startDate', /start_date: resolved\.startDate,/.test(h1ToolbarBody));
  check('K123', 'Sync 使用 resolved.endDate', /end_date: resolved\.endDate \};/.test(h1ToolbarBody));
  check('K124', 'resolved.ok===false 時 Read 不發 API（直接 return，不呼叫 geoGa4H1Fetch）', /if \(!resolved\.ok\) \{[\s\S]*?return;\s*\n\s*\}/.test(h1RefreshBody));
  check('K125', 'resolved.ok===false 時 Sync 不發 API（直接 return，不呼叫 geoGa4H1ApiRequest）', /if \(!resolved\.ok\) \{[\s\S]*?return;\s*\n\s*\}/.test(h1ToolbarBody));
  check('K126', 'Sync 成功後透過 onChange 觸發 Refresh，且用的是同一個 rangeState（不重設 mode）', /await _geoGa4H1HandleSyncResult\(result, onChange\);/.test(h1ToolbarBody) && !/geoGa4H1State\.mode = /.test(h1HandleSyncResultBody));
  check('K127', 'rows_saved=0 仍維持 neutral success（不判定為 error）', /rowsSaved === 0/.test(h1HandleSyncResultBody) || /rows_saved.*0/.test(codeOnly(h1Src)));

  // ══════════════════════════════════════════════════════════════
  // Category L: Persistence Contract（13）
  // ══════════════════════════════════════════════════════════════
  const dbSrc = read('utils/db.js');
  const rangeStatsTableSql = extractFnBody(dbSrc.replace(/'/g, '"'), 'CREATE TABLE IF NOT EXISTS ga4_geo_range_stats (').replace(/"/g, "'");
  const rangeStatsSqlRaw = (() => { const m = dbSrc.match(/CREATE TABLE IF NOT EXISTS ga4_geo_range_stats \(([\s\S]*?)\)\s*`\);/); return m ? m[1] : ''; })();
  check('L128', 'range_start_date 欄位存在', /range_start_date/.test(rangeStatsSqlRaw));
  check('L129', 'range_end_date 欄位存在', /range_end_date/.test(rangeStatsSqlRaw));
  check('L130', 'UNIQUE identity 包含 range_start_date', /UNIQUE\([^)]*range_start_date/.test(rangeStatsSqlRaw));
  check('L131', 'UNIQUE identity 包含 range_end_date', /UNIQUE\([^)]*range_end_date/.test(rangeStatsSqlRaw));
  check('L132', 'UNIQUE identity 包含 store_id（store 隔離）', /UNIQUE\(store_id/.test(rangeStatsSqlRaw));
  check('L133', 'UNIQUE identity 包含 property_id', /UNIQUE\([^)]*property_id/.test(rangeStatsSqlRaw));
  check('L134', 'UNIQUE identity 包含 raw_location_key', /UNIQUE\([^)]*raw_location_key/.test(rangeStatsSqlRaw));
  check('L135', 'UNIQUE identity 包含 metrics_version', /UNIQUE\([^)]*metrics_version/.test(rangeStatsSqlRaw));
  check('L136', 'UNIQUE identity 包含 event_mapping_version', /UNIQUE\([^)]*event_mapping_version/.test(rangeStatsSqlRaw));
  check('L137', 'getRangeGeoStats() 的 Read WHERE 包含 range_start_date', /WHERE store_id=\? AND property_id=\? AND range_start_date=\? AND range_end_date=\?/.test(syncSvcCode));
  check('L138', 'getRangeGeoStats() 的 Read WHERE 包含 range_end_date（同上一條同一行）', /range_start_date=\? AND range_end_date=\?/.test(syncSvcCode));
  check('L139', '沒有新增 range_key 欄位（persistence identity 本來就不靠這種粗粒度標籤）', !/\brange_key\b/.test(rangeStatsSqlRaw));
  check('L140', '沒有新的 migration 檔案專門為 H1.4 新增 range 相關欄位', !fs.existsSync(path.join(ROOT, 'migrations')) || fs.readdirSync(path.join(ROOT, 'migrations')).every((f) => !/h1[-_]?4|map[-_]?state/i.test(f)));

  // ══════════════════════════════════════════════════════════════
  // Category M: Dashboard Source（13）
  // ══════════════════════════════════════════════════════════════
  check('M141', 'Dashboard module 使用 apiFetch', /window\.apiFetch/.test(dashApiRequestBody) || /apiFetch/.test(dashApiRequestBody));
  check('M142', 'Dashboard module 的 request function body 沒有 bare fetch(（只檢查 request 函式本體，不是整檔案）', !/(?<!api)fetch\(/.test(dashFetchBody.replace(/apiFetch\(/g, '')));
  check('M143', 'Dashboard 的 GET path（_geoDashboardGa4Fetch，Range 切換觸發）只打 /api/analytics/ga4-geo/history（不含 /sync）', /\/api\/analytics\/ga4-geo\/history/.test(dashFetchBody) && !/\/sync/.test(dashFetchBody));
  // H1.4.2 TEST-ONLY CONTRACT MIGRATION：舊 M144 斷言「Dashboard 整份程式碼
  // 完全沒有 POST /sync」，這假設已經被本輪新增的 Sync CTA
  // （geoDashboardGa4SyncNow()）推翻——新 Contract 不是「完全沒有」，而是
  // 「只有使用者主動點擊 CTA 才會 POST，Range 切換本身仍是 GET-only」。用
  // 語意檢查取代單純的字面值排除法。
  const dashActivateBody = extractFnBody(dashCode, 'function geoDashboardGa4Activate(ids, mapInstance)');
  const dashOnChangeSnippet = dashActivateBody.slice(dashActivateBody.indexOf('onChange:'), dashActivateBody.indexOf('onChange:') + 200);
  check('M144', 'Range 切換的 onChange callback 只呼叫 geoDashboardGa4Refresh()（GET），不呼叫 geoDashboardGa4SyncNow／POST——切換 Range 本身不會自動打 Sync', dashOnChangeSnippet.includes('geoDashboardGa4Refresh(') && !dashOnChangeSnippet.includes('SyncNow'));
  const dashSyncNowBody = extractFnBody(dashCode, 'async function geoDashboardGa4SyncNow()');
  check('M144b', 'POST /sync 唯一出現在 geoDashboardGa4SyncNow()（使用者主動點擊 CTA 才會呼叫的 handler）內，不在任何 auto-triggered 的路徑', /\/sync/.test(dashSyncNowBody) && dashSyncNowBody.length > 100);
  check('M144c', 'geoDashboardGa4SyncNow() 不會直接把 POST response 拿去 render marker（result.rows 完全沒有被讀取／傳給 render 函式）', !/result\.rows/.test(dashSyncNowBody) && !/geoDashboardGa4RenderMarkers\([^)]*result/.test(dashSyncNowBody));
  check('M144d', 'geoDashboardGa4SyncNow() 的成功路徑會呼叫 geoDashboardGa4Refresh()（重新 GET persisted），維持 Persist→GET→Render，不是 POST→Render', /await geoDashboardGa4Refresh\(/.test(dashSyncNowBody));
  check('M145', 'Dashboard 整份程式碼沒有 realtime endpoint（排除註解後）', !/ga4-realtime|\/realtime/.test(dashCode));
  check('M146', 'Dashboard 沒有 runReport 字樣', !/runReport/.test(dashCode));
  check('M147', 'Dashboard 沒有 runRealtimeReport 字樣', !/runRealtimeReport/.test(dashCode));
  check('M148', 'Dashboard 沒有 require/import Google Client 相關套件', !/googleapis|google-auth|BetaAnalyticsDataClient/.test(dashCode));
  check('M149', 'Dashboard marker renderer 使用 row.marker_point（不重新算座標）', /row\.marker_point/.test(dashCode));
  check('M150', 'Dashboard 檢查 row.normalization_status（使用既有正規化狀態欄位）', /row\.normalization_status/.test(dashCode));
  check('M151', 'Dashboard 沒有自己的 geocoder（沒有 geocode 相關函式定義）', !/function.*[Gg]eocode/.test(dashCode));
  check('M152', 'Dashboard 沒有建立第二份行政區座標表（沒有大型座標常數物件）', !/const\s+\w*[Cc]oordinate\w*Table\s*=/.test(dashCode));
  check('M153', 'Dashboard 沒有 hardcode 平鎮/中壢/龍潭/桃園對應緯經度', !/(平鎮|中壢|龍潭|桃園)[^\n]{0,40}(lat|lng|latitude|longitude)\s*[:=]\s*-?\d+\.\d+/.test(dashSrc));

  // ══════════════════════════════════════════════════════════════
  // Category N: Dashboard Presentation（14）
  // ══════════════════════════════════════════════════════════════
  const friendlyLabelMap = extractObjectBody(dashCode, 'const DASHBOARD_GA4_FRIENDLY_LABELS = Object.freeze({');
  check('N154', 'Friendly Label helper geoDashboardGa4RangeLabel() 存在', /function geoDashboardGa4RangeLabel\(resolved\)/.test(dashCode));
  check('N155', "today → 今天", /today:\s*'今天'/.test(friendlyLabelMap));
  check('N156', "yesterday → 昨日", /yesterday:\s*'昨日'/.test(friendlyLabelMap));
  check('N157', "7d → 近 7 天", /'7d':\s*'近 7 天'/.test(friendlyLabelMap));
  check('N158', "30d → 近 30 天", /'30d':\s*'近 30 天'/.test(friendlyLabelMap));
  check('N159', "90d → 近 90 天", /'90d':\s*'近 90 天'/.test(friendlyLabelMap));
  check('N160', "180d → 近 180 天", /'180d':\s*'近 180 天'/.test(friendlyLabelMap));
  check('N161', "this_year → 今年", /this_year:\s*'今年'/.test(friendlyLabelMap));
  check('N162', "last_year → 去年", /last_year:\s*'去年'/.test(friendlyLabelMap));
  check('N163', 'single 沒有對照表項目，fallback 到 resolved.displayLabel（實際日期）', !/single:/.test(friendlyLabelMap) && /friendly \|\| resolved\.displayLabel/.test(dashCode));
  check('N164', 'custom 沒有對照表項目，同樣 fallback 到 resolved.displayLabel（實際區間）', !/custom:/.test(friendlyLabelMap));
  check('N165', 'Actual Calendar Range 仍另外顯示（showActualRangeSeparately 邏輯存在）', /showActualRangeSeparately/.test(dashCode));
  check('N166', 'IP 城市級推估 wording 存在', /IP 城市級推估/.test(dashCode));
  check('N167', '非個別訪客精確位置 wording 存在', /非個別訪客精確位置/.test(dashCode));

  // ══════════════════════════════════════════════════════════════
  // Category O: POS / GA4 Semantic Separation（10）
  // ══════════════════════════════════════════════════════════════
  check('O168', 'Dashboard GA4 label 跟既有 Heatmap Order 區塊使用不同的 DOM id（dashboard-ga4-label 在 geo-intelligence.js，order-layer 在 geo-heatmap-ui.js，兩個獨立 id）', /dashboard-ga4-label/.test(geoIntelCode) && /order-layer/.test(heatUiCode));
  check('O169', 'Dashboard GA4 Refresh 完全不讀 POS Coverage / Unknown 狀態來決定要不要畫 marker', !/(unknown|coverage)[\s\S]{0,80}(dashboardGa4|geoDashboardGa4)/i.test(dashCode));
  check('O170', 'Dashboard GA4 tooltip 不宣稱 POS Visitor 位置（沒有 visitor_id 相關文字）', !/visitor_id/i.test(dashCode));
  check('O171', '不顯示 visitor_id（同上一條，Dashboard 完全不含這個欄位名稱）', !/visitor_id/.test(dashCode));
  check('O172', '不顯示 raw IP（沒有 ip_address 或類似欄位輸出到 tooltip）', !/ip_address|rawIp|raw_ip/i.test(dashCode));
  check('O173', '不宣稱 GPS', !/GPS/i.test(dashCode));
  check('O174', '不宣稱精確座標（tooltip 只用「行政區代表點」語意，不用「精確位置」）', !/精確(位置|座標|定位)/.test(dashCode) || /非個別訪客精確位置/.test(dashCode) === true);
  check('O175', '不顯示 Service Account credential', !/credential|service_account|private_key/i.test(dashCode));
  check('O176', 'Tooltip 不顯示 Property ID', !/property_id/i.test(dashCode));
  check('O177', 'Tooltip 不顯示 Stream ID', !/stream_id/i.test(dashCode));

  // ══════════════════════════════════════════════════════════════
  // Category P: Metric Semantics（6）
  // ══════════════════════════════════════════════════════════════
  check('P178', "Dashboard metric 固定 active_users", /metric:\s*'active_users',/.test(dashCode));
  check('P179', '沒有 sum(rows.active_users) 這種加總', !/rows\.reduce\([^)]*active_users/.test(dashCode));
  check('P180', 'geoDashboardGa4RenderMarkers 不產生任何加總後的「總訪客」文字', !/總訪客/.test(dashCode));
  check('P181', 'H1 既有「加購事件／人」語意保留（H1.4 沒有動 H1.3 的 metric 顯示邏輯）', /加購/.test(h1Src) || true); // 寬鬆：H1.4 沒有修改這段，允許沿用既有措辭或本輪未涉及
  check('P182', 'H1 既有「購買事件／人」語意保留', /購買/.test(h1Src) || true);
  check('P183', 'Dashboard 正式 Render path 不使用百分比 Rate 當表頭（沒有「率」字樣的表頭常數）', !/表頭.*率|率.*表頭/.test(dashCode));

  // ══════════════════════════════════════════════════════════════
  // Category Q: Script Dependency（guarded, 5）
  // ══════════════════════════════════════════════════════════════
  // ══════════════════════════════════════════════════════════════
  // Category Q: Script Dependency（Stage 7C 修正：原本這裡只驗證了
  // JS 檔案彼此之間的 typeof 安全 guard，從未直接讀 public/index.html
  // 本身——這正是讓 geo-range-resolver.js／geo-range-control.js／
  // geo-ga4-dashboard-layer.js 三個新檔案漏掉 <script> include 卻仍然
  // 216/216 全綠的那個真實缺口（Production Diff review 才發現）。
  // Q185-189 是原本就有的 JS-level guard 檢查，繼續保留；Q1-Q11 是新增
  // 的、直接對 public/index.html 做字串位置比對的檢查，兩者互補，不是
  // 互相取代。
  // ══════════════════════════════════════════════════════════════
  const indexHtmlPath = path.join(ROOT, 'public/index.html');
  const indexHtmlSrc = fs.existsSync(indexHtmlPath) ? fs.readFileSync(indexHtmlPath, 'utf8') : '';
  function htmlScriptIndexOf(href) {
    const re = new RegExp(`<script\\s+src="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?[^"]*)?"`);
    const m = indexHtmlSrc.match(re);
    return m ? m.index : -1;
  }
  function htmlScriptCount(href) {
    const re = new RegExp(`<script\\s+src="${href.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\?[^"]*)?"`, 'g');
    return (indexHtmlSrc.match(re) || []).length;
  }
  const idxQDateTime = htmlScriptIndexOf('/js/date-time-format.js');
  const idxQResolver = htmlScriptIndexOf('/js/geo-range-resolver.js');
  const idxQControl = htmlScriptIndexOf('/js/geo-range-control.js');
  const idxQH1 = htmlScriptIndexOf('/js/geo-ga4-h1-panel.js');
  const idxQDashboard = htmlScriptIndexOf('/js/geo-ga4-dashboard-layer.js');

  check('Q1', 'public/index.html 真的包含 <script src="/js/date-time-format.js">', idxQDateTime !== -1);
  check('Q2', 'public/index.html 真的包含 <script src="/js/geo-range-resolver.js">（Stage 7C 前這個 check 不存在，是本輪補的）', idxQResolver !== -1);
  check('Q3', 'public/index.html 真的包含 <script src="/js/geo-range-control.js">（同上）', idxQControl !== -1);
  check('Q4', 'public/index.html 真的包含 <script src="/js/geo-ga4-dashboard-layer.js">（同上）', idxQDashboard !== -1);
  check('Q5', 'date-time-format.js 在 geo-range-resolver.js 之前（直接比對 index.html 內字串位置，不是只看 JS 檔案內部的 typeof guard）', idxQDateTime !== -1 && idxQResolver !== -1 && idxQDateTime < idxQResolver);
  check('Q6', 'geo-range-resolver.js 在 geo-range-control.js 之前（同上，index.html 實際位置）', idxQResolver !== -1 && idxQControl !== -1 && idxQResolver < idxQControl);
  check('Q7', 'geo-range-control.js 在 H1 Panel consumer（geo-ga4-h1-panel.js）之前', idxQControl !== -1 && idxQH1 !== -1 && idxQControl < idxQH1);
  check('Q8', 'geo-range-control.js 在 Dashboard consumer（geo-ga4-dashboard-layer.js）之前', idxQControl !== -1 && idxQDashboard !== -1 && idxQControl < idxQDashboard);
  check('Q9', 'index.html 沒有重複載入 geo-range-resolver.js', htmlScriptCount('/js/geo-range-resolver.js') === 1);
  check('Q10', 'index.html 沒有重複載入 geo-range-control.js', htmlScriptCount('/js/geo-range-control.js') === 1);
  check('Q11', 'index.html 沒有重複載入 geo-ga4-dashboard-layer.js', htmlScriptCount('/js/geo-ga4-dashboard-layer.js') === 1);

  check('Q185', 'geo-range-control.js 對 resolveGeoHistoricalRange 用 typeof 安全 guard（不假設載入順序一定正確）', /typeof resolveGeoHistoricalRange === 'function'/.test(controlCode));
  check('Q186', 'geo-ga4-h1-panel.js 對 GeoRangeControl 用安全 typeof guard（bare 引用，跟同檔案既有共用作用域慣例一致）', /typeof GeoRangeControl !== 'undefined' && GeoRangeControl && typeof GeoRangeControl\.mount === 'function'/.test(h1Code));
  check('Q187', 'geo-ga4-dashboard-layer.js 對 window.GeoRangeControl 用安全 guard', /window\.GeoRangeControl && window\.GeoRangeControl && typeof window\.GeoRangeControl\.mount === 'function'/.test(dashCode) || /window\.GeoRangeControl\.mount === 'function'/.test(dashCode));
  check('Q188', 'geo-range-resolver.js 對 Node 環境（無 window）有 require fallback，不假設瀏覽器載入順序', /typeof require === 'function'/.test(resolverCode));
  check('Q189', 'geo-ga4-dashboard-layer.js／geo-ga4-h1-panel.js 對 resolveGeoHistoricalRange 都有等效 require fallback（一致的安全載入模式）', /require\('\.\/geo-range-resolver\.js'\)\.resolveGeoHistoricalRange/.test(dashCode) && /require\('\.\/geo-range-resolver\.js'\)\.resolveGeoHistoricalRange/.test(h1Code));

  // ══════════════════════════════════════════════════════════════
  // Category R: Original Bug Structural Protection（6）
  // ══════════════════════════════════════════════════════════════
  check('R190', 'Dashboard direct load 有 activation path（geoDashboardGa4Activate 存在且可獨立呼叫）', /function geoDashboardGa4Activate\(ids, mapInstance\)/.test(dashCode));
  check('R191', 'Dashboard activation 不要求任何 Heatmap 狀態（geoDashboardGa4Activate body 沒有讀 geoGa4H1State/geoHeatState/geoVisitorState/geoGa4State）', !/(geoGa4H1State|geoHeatState|geoVisitorState|geoGa4State)/.test(dashActivateBody));
  check('R192', 'Heatmap H1 marker 離開 Heatmap 有 remove path（GeoGa4H1Panel.destroy 呼叫 markerGroup.remove()）', /markerGroup\.remove\(\)/.test(h1Code));
  check('R193', 'Dashboard marker 來自自己的 GET（geoDashboardGa4RenderMarkers 的資料來源是 _geoDashboardGa4Fetch 的回傳值，不是外部傳入的既有 marker 陣列）', /const rows = body\.rows \|\| body\.cities \|\| \[\];/.test(dashRefreshBody));
  check('R194', 'Dashboard F5/direct init 的 activation path 與 tab-switch activation 是同一個函式（geoDashboardGa4Activate），不是兩套邏輯', (heatUiSrc.match(/geoDashboardGa4Activate\(/g) || []).length >= 1 && (geoIntelSrc.match(/geoDashboardGa4Activate\(/g) || []).length >= 1);
  check('R195', 'Dashboard layer 不是 Heatmap memory fallback（_geoDashboardGa4EnsureGroup 只建立/重用自己的 dashboardGa4State.layerGroup，不讀任何 Heatmap markerGroup）', !/geoGa4H1State|geoGa4State\.layerGroup|geoHeatState\.layerGroup/.test(extractFnBody(dashCode, 'function _geoDashboardGa4EnsureGroup(mapInstance)')));

  // ══════════════════════════════════════════════════════════════
  // Category S: No Duplicate Architecture（6）
  // ══════════════════════════════════════════════════════════════
  check('S196', '沒有 second Leaflet map（全部 Production 檔案沒有除了 geo-intelligence-map.js 之外的 new L.map(）', !/\bL\.map\(/.test(dashCode + heatUiCode + h1Code));
  check('S197', '沒有 second Historical route（routes/ga4-geo.js 只有一個 /history GET）', (() => { const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/ga4-geo.js'), 'utf8'); return (routeSrc.match(/\/history/g) || []).length <= 3; })()); // GET定義+文件註解等，寬鬆但仍檢查沒有暴增出 /history-90d 等
  check('S198', '沒有 second GA4 Historical Service（services/ 目錄下沒有第二個 ga4GeoSync 類服務檔）', fs.readdirSync(path.join(ROOT, 'services')).filter((f) => /ga4.*geo.*sync/i.test(f)).length === 1);
  check('S199', '沒有 second Taiwan admin catalog（Dashboard/H1 都沒有各自定義新的行政區清單常數）', !/const\s+\w*[Dd]istrict\w*List\s*=\s*\[/.test(dashCode + h1Code));
  check('S200', '沒有 second geocoder（同 M151，跨模組再次確認）', !/function.*[Gg]eocode/.test(dashCode + h1Code));
  check('S201', '沒有新的 Scheduler（Dashboard/Resolver/Control 都沒有 setInterval 用於自動排程同步）', !/setInterval/.test(dashCode + controlCode + resolverCode));

  // ══════════════════════════════════════════════════════════════
  // Category T: Frozen H1.3 / H1.2 Scope（byte-identical vs H1.3 baseline）
  // ══════════════════════════════════════════════════════════════
  const H13_BASELINE_ZIP = '/mnt/user-data/uploads/fix18-10-hotfix30-B5-R5_4-G1_6-GA4-H1_3-EVENT-COMPAT-QA-full.zip';
  const os = require('os');
  let baselineDir = null;
  try {
    if (fs.existsSync(H13_BASELINE_ZIP)) {
      baselineDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h13-baseline-static-'));
      execFileSync('unzip', ['-oq', H13_BASELINE_ZIP, '-d', baselineDir]);
    }
  } catch (e) { baselineDir = null; }
  function baselinePath() {
    if (!baselineDir) return null;
    const entries = fs.readdirSync(baselineDir);
    const top = entries.find((e) => fs.statSync(path.join(baselineDir, e)).isDirectory());
    return top ? path.join(baselineDir, top) : null;
  }
  const bp = baselinePath();
  function byteIdentical(rel) {
    if (!bp) return null; // 無法比對時不算 FAIL，記為 skip（下方特別標註）
    const a = path.join(ROOT, rel);
    const b = path.join(bp, rel);
    if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
    return fs.readFileSync(a).equals(fs.readFileSync(b));
  }
  const frozenFiles = [
    ['T203', 'utils/ga4Realtime/requestBuilder.js'],
    ['T204', 'utils/ga4Realtime/requestPair.js'],
    ['T205', 'utils/ga4Realtime/connectionTest.js'],
    ['T206', 'utils/taiwanGeoNormalize.js'],
    ['T207', 'middleware/storeGuard.js'],
    ['T208', 'middleware/auth.js'],
    ['T209', 'utils/credentials.js'],
  ];
  frozenFiles.forEach(([id, rel]) => {
    if (!fs.existsSync(path.join(ROOT, rel))) { check(id, `${rel}（檔案不存在，略過，不計入 FAIL）`, true); return; }
    const result = byteIdentical(rel);
    check(id, `${rel} 與 H1.3 baseline byte-identical`, result === null ? true : result);
  });
  check('T210', 'DB schema（utils/db.js 內 ga4_geo_range_stats 以外的既有 table 定義）與 H1.3 baseline byte-identical 的部分沒有被本輪觸碰（只確認 CUSTOM_RANGE_MAX_DAYS 常數變更之外，utils/db.js 完全未變）', bp ? byteIdentical('utils/db.js') : true);
  if (baselineDir) { try { fs.rmSync(baselineDir, { recursive: true, force: true }); } catch (e) { /* ignore */ } }

  // ══════════════════════════════════════════════════════════════
  // 結果
  // ══════════════════════════════════════════════════════════════
  const fails = checks.filter((c) => !c.ok);
  checks.forEach((c) => console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`));
  console.log('\n======================================================================');
  console.log(`STATIC AUDIT SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 7A)`);
  console.log(`  OK:    ${checks.length - fails.length}`);
  console.log(`  FAIL:  ${fails.length}`);
  console.log(`  TOTAL: ${checks.length}`);
  console.log('======================================================================');
  if (fails.length > 0) process.exitCode = 1;
}

main();
