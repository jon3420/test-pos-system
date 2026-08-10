#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-2.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX Static Audit
//
// 只檢查本輪（H1.4.2）新增/修改的 Contract：Dashboard GA4 Range→Map
// wiring／Persisted Read／Sync CTA／Sync Concurrency／Race Protection／
// Marker Lifecycle／Dashboard+Heatmap Wheel／Same Map／H1.4.1 Cleanup
// Retention／Frozen Backend／Authenticated Helper 使用。不重複既有
// static-audit-g1-6-ga4-h1-4.js（227 checks）／static-audit-g1-6-ga4-h1-4-1.js
// （這兩個繼續獨立跑、繼續 PASS，本輪不修改其覆蓋範圍）。

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

const dashSrc = read('public/js/geo-ga4-dashboard-layer.js');
const dashCode = codeOnly(dashSrc);
const heatUiSrc = read('public/js/geo-heatmap-ui.js');
const heatUiCode = codeOnly(heatUiSrc);
const rangeCtrlSrc = read('public/js/geo-range-control.js');
const rangeResolverSrc = read('public/js/geo-range-resolver.js');

const refreshBody = extractFnBody(dashSrc, 'async function geoDashboardGa4Refresh(ids, mapInstance)');
const syncNowBody = extractFnBody(dashSrc, 'async function geoDashboardGa4SyncNow()');
const activateBody = extractFnBody(dashSrc, 'function geoDashboardGa4Activate(ids, mapInstance)');
const switchTabBody = extractFnBody(heatUiSrc, 'function geoHeatUiSwitchTab(containerId, tab)');
const heatmapBranchStart = switchTabBody.indexOf("if (tab === 'heatmap')");
const heatmapBranchEnd = switchTabBody.indexOf('} else {', heatmapBranchStart);
const heatmapBranch = (heatmapBranchStart !== -1 && heatmapBranchEnd !== -1) ? switchTabBody.slice(heatmapBranchStart, heatmapBranchEnd) : '__EXTRACTION_FAILED__';
const dashboardBranch = (heatmapBranchEnd !== -1) ? switchTabBody.slice(heatmapBranchEnd) : '__EXTRACTION_FAILED__';

// ════════════════════════════════════════════════════════════════
// Category A — Range Wiring
// ════════════════════════════════════════════════════════════════
check('A1', 'geoDashboardGa4Refresh() 存在且可提取本體', refreshBody.length > 100);
check('A2', 'GeoRangeControl.mount() 的 onChange callback 真的呼叫 geoDashboardGa4Refresh(...)，不是只更新文字', activateBody.includes('onChange: () => { geoDashboardGa4Refresh('));
check('A3', 'geoDashboardGa4Refresh() 內部真的呼叫 _geoDashboardGa4ResolveRange()（單一 Range Truth，不是自己另外算日期）', refreshBody.includes('_geoDashboardGa4ResolveRange()'));
check('A4', '_geoDashboardGa4ResolveRange() 呼叫的是共用的 resolveGeoHistoricalRange 純函式（跟 H1 Panel 同一顆），不是複製一份邏輯', dashCode.includes('_geoDashboardResolveRangeFn(dashboardGa4State.rangeState.mode, dashboardGa4State.rangeState)'));
['today', 'yesterday', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom'].forEach((mode, i) => {
  check(`A5-${i}`, `GEO_RANGE_CONTROL_PRESETS 包含 mode '${mode}'（Range Control 真的渲染這個按鈕）`, rangeCtrlSrc.includes(`'${mode}'`));
});
check('A6', "single mode 由 geoRangeControlSetSingleDate() 觸發 recompute（不是要等切到別的 preset 才生效）", rangeCtrlSrc.includes('function geoRangeControlSetSingleDate'));
check('A7', 'GEO_RANGE_API_MAP 只固定 today/yesterday/7d/30d 四個 preset，其餘（含 90d/180d/this_year/last_year/single/custom）走 apiRange=custom（需求文件十二既有 Contract，本輪未變更）', rangeResolverSrc.includes("GEO_RANGE_API_MAP = Object.freeze({ today: 'today', yesterday: 'yesterday', '7d': '7d', '30d': '30d' })"));
check('A8', "resolveGeoHistoricalRange 對非 preset mode 一律回 apiRange || 'custom'", rangeResolverSrc.includes("apiRange: GEO_RANGE_API_MAP[mode] || 'custom'"));

// ════════════════════════════════════════════════════════════════
// Category B — Persisted Read Contract（GET-only，不得新資料源）
// ════════════════════════════════════════════════════════════════
check('B1', '_geoDashboardGa4Fetch() 只打既有 GET /api/analytics/ga4-geo/history', dashCode.includes("/api/analytics/ga4-geo/history"));
check('B2', '_geoDashboardGa4Fetch() 使用 method: \'GET\'（讀，不是寫）', dashCode.includes("_geoDashboardGa4ApiRequest(url, { method: 'GET' }"));
check('B3', 'Dashboard 完全沒有直接呼叫 Google/GA4 client（沒有 google.analytics 或類似字樣）', !/google\.analytics|GoogleAdsApi|BetaAnalyticsDataClient/i.test(dashCode));
check('B4', 'Dashboard 沒有另開第二支 GA4 geo 查詢 endpoint（沒有 ga4-geo/ 底下除了 history 跟 sync 以外的路徑字面值）', !/ga4-geo\/(?!history|sync)[a-z_-]+/i.test(dashCode));
check('B5', 'geoDashboardGa4Refresh() 的 render 呼叫（geoDashboardGa4RenderMarkers）只在 GET 成功且 rows.length>0 分支被呼叫', refreshBody.includes('const count = geoDashboardGa4RenderMarkers(mapInstance, rows, resolved.displayLabel);'));
check('B6', 'geoDashboardGa4RenderMarkers() 只用 API 已算好的 row.marker_point，不重新 geocode／不查表', dashCode.includes('const point = row.marker_point;') && !/geocode|geocoder/i.test(dashCode));

// ════════════════════════════════════════════════════════════════
// Category C — Dashboard Sync CTA
// ════════════════════════════════════════════════════════════════
check('C1', '_geoDashboardGa4RenderEmptyCta() 存在', dashCode.includes('function _geoDashboardGa4RenderEmptyCta('));
check('C2', 'rows.length === 0 分支呼叫 _geoDashboardGa4RenderEmptyCta()（不是只顯示純文字）', refreshBody.includes('_geoDashboardGa4RenderEmptyCta(ids)'));
check('C3', 'rows.length > 0 分支不會同時渲染 Sync CTA（有資料時 CTA 不出現，因為走的是 render markers 分支，不是 empty 分支）', (() => {
  const emptyIdx = refreshBody.indexOf('if (rows.length === 0)');
  const afterEmpty = refreshBody.slice(emptyIdx);
  const nonEmptyBranch = afterEmpty.slice(afterEmpty.indexOf('}') + 1);
  return nonEmptyBranch.includes('geoDashboardGa4RenderMarkers') && !nonEmptyBranch.includes('_geoDashboardGa4RenderEmptyCta(ids);\n\n  const count');
})());
check('C4', 'CTA 按鈕 onclick 綁定的是既有全域函式 geoDashboardGa4SyncNow()（沒有參數，跟 GeoRangeControl 全域 onclick 慣例一致）', dashCode.includes("onclick=\"geoDashboardGa4SyncNow()\""));
check('C5', 'geoDashboardGa4SyncNow() 送出的 POST body 使用 sync_type: \'range\'（既有 H1 Manual Sync 同一個 Contract，不是新格式）', syncNowBody.includes("sync_type: 'range'"));
check('C6', 'geoDashboardGa4SyncNow() POST body 帶 range/start_date/end_date（跟 GET 用的是同一組 identity 欄位）', syncNowBody.includes('range: resolved.apiRange') && syncNowBody.includes('start_date: resolved.startDate') && syncNowBody.includes('end_date: resolved.endDate'));
check('C7', 'geoDashboardGa4SyncNow() 打的 URL 是既有 /api/analytics/ga4-geo/sync（跟 geo-ga4-h1-panel.js 的 Manual Sync 同一支端點）', syncNowBody.includes("'/api/analytics/ga4-geo/sync'"));
check('C8', 'geo-ga4-h1-panel.js（既有 H1 Manual Sync）用的也是同一支 /api/analytics/ga4-geo/sync 端點（沒有另開端點）', read('public/js/geo-ga4-h1-panel.js').includes("/api/analytics/ga4-geo/sync"));
check('C9', 'geoDashboardGa4SyncNow 有掛在 window 上，可以被 inline onclick 呼叫', dashCode.includes('window.geoDashboardGa4SyncNow = geoDashboardGa4SyncNow;'));

// ════════════════════════════════════════════════════════════════
// Category D — Sync State / Concurrency
// ════════════════════════════════════════════════════════════════
check('D1', 'dashboardGa4State 有 syncPendingKey 欄位（identity-keyed pending，不是單一 global boolean）', dashCode.includes('syncPendingKey: null'));
check('D2', 'geoDashboardGa4SyncNow() 用 _geoDashboardGa4RangeKey(resolved) 算出的 myKey 判斷 dedupe（不是只用一個 true/false）', syncNowBody.includes('const myKey = _geoDashboardGa4RangeKey(resolved);') && syncNowBody.includes('dashboardGa4State.syncPendingKey === myKey'));
check('D3', '_geoDashboardGa4RangeKey() 把 mode/apiRange/startDate/endDate 都納入 key（同一 mode 但不同日期不會被誤判成同一個 identity）', dashCode.includes('return `${resolved.mode}|${resolved.apiRange}|${resolved.startDate}|${resolved.endDate}`;'));
check('D4', 'geoDashboardGa4SyncNow() 存在「不同 identity 但目前已有其他 pending」的分支，且不送出 POST（實際 dispatch single-flight，不是允許無限並行）', syncNowBody.includes('if (dashboardGa4State.syncPendingKey !== null)') && (() => {
  const branchStart = syncNowBody.indexOf('if (dashboardGa4State.syncPendingKey !== null)');
  const branchEnd = syncNowBody.indexOf('dashboardGa4State.syncPendingKey = myKey;');
  const branch = syncNowBody.slice(branchStart, branchEnd);
  return !branch.includes('_geoDashboardGa4ApiRequest(');
})());
check('D5', '該「別人 pending 時」分支會 render busy 訊息（DASHBOARD_GA4_SYNC_BUSY_MESSAGE），不是靜默什麼都不做', dashCode.includes('_geoDashboardGa4RenderEmptyCta(ids, DASHBOARD_GA4_SYNC_BUSY_MESSAGE);'));
check('D6', 'DASHBOARD_GA4_SYNC_BUSY_MESSAGE 是合法、明確的忙碌文案，不是 generic error', /另一個區間正在同步/.test(dashCode));
check('D7', '429 rate_limited 的處理對應到同一句 busy 文案（不會被誤判成一般失敗）', syncNowBody.includes("result.code === 'rate_limited'") && syncNowBody.includes('DASHBOARD_GA4_SYNC_BUSY_MESSAGE'));
check('D8', 'geoDashboardGa4SyncNow() 完成時只清掉「自己剛剛設的那個 key」（if (dashboardGa4State.syncPendingKey === myKey) ... = null），不會搶著清掉別人的 pending', syncNowBody.includes('if (dashboardGa4State.syncPendingKey === myKey) dashboardGa4State.syncPendingKey = null;'));
check('D9', '_geoDashboardGa4ResetStateForTest() 有重置 syncPendingKey（測試隔離乾淨，不會殘留上一輪的 pending）', dashCode.includes('dashboardGa4State.syncPendingKey = null;'));

// ════════════════════════════════════════════════════════════════
// Category E — Race Protection
// ════════════════════════════════════════════════════════════════
check('E1', 'geoDashboardGa4SyncNow() 完成後用 _geoDashboardGa4RangesEqual(resolved, _geoDashboardGa4ResolveRange()) 判斷「目前選的 range 是否還是剛才那個」（sync-start identity 跟 current selected identity 分開比對）', syncNowBody.includes('_geoDashboardGa4RangesEqual(resolved, _geoDashboardGa4ResolveRange())'));
check('E2', '_geoDashboardGa4RangesEqual() 比對的是 mode/apiRange/startDate/endDate 實際值，不是物件參考（resolveGeoHistoricalRange 每次呼叫都回新物件，參考永遠不相等）', dashCode.includes('a.mode === b.mode && a.apiRange === b.apiRange && a.startDate === b.startDate && a.endDate === b.endDate'));
check('E3', 'sync 失敗時，只有 stillSameRange 為真才更新畫面（使用者已經切走的話不會把畫面切回舊 range）', (() => {
  const failBranchStart = syncNowBody.indexOf('if (!result || result.success === false)');
  const failBranch = syncNowBody.slice(failBranchStart, failBranchStart + 400);
  return failBranch.includes('if (stillSameRange)');
})());
check('E4', 'sync 成功時，只有 stillSameRange 為真才呼叫 geoDashboardGa4Refresh() 重新 GET/render', (() => {
  const idx = syncNowBody.lastIndexOf('if (stillSameRange)');
  return idx !== -1 && syncNowBody.slice(idx, idx + 200).includes('geoDashboardGa4Refresh(ids, dashboardGa4State.mapInstance)');
})());
check('E5', 'geoDashboardGa4Refresh() 本身仍保留既有 H1.4 generation 計數器（Range GET 的 late-response race protection，不因本輪 Sync CTA 改動被拿掉）', refreshBody.includes('const myGeneration = ++dashboardGa4State.generation;') && refreshBody.includes('if (myGeneration !== dashboardGa4State.generation)'));
check('E6', 'geoDashboardGa4Refresh() 仍保留既有 AbortController（取消上一支還在飛行的 GET，不是讓兩支同時競速寫畫面）', refreshBody.includes('new AbortController()') && refreshBody.includes('dashboardGa4State.currentAbort.abort()'));
check('E7', 'AbortError 被安靜吞掉（不會被誤判成 network_error 顯示給使用者）', refreshBody.includes("e.name === 'AbortError'"));

// ════════════════════════════════════════════════════════════════
// Category F — Marker Lifecycle（No Stale Marker）
// ════════════════════════════════════════════════════════════════
check('F1', 'resolved.ok 之後、發 GET 之前，就先呼叫 geoDashboardGa4ClearMarkers()（舊 marker 在新 request 送出前就已經清除，不是等新資料回來才清）', (() => {
  const okIdx = refreshBody.indexOf('// 開始新 request 前先清掉舊 marker');
  return okIdx !== -1 && refreshBody.slice(okIdx, okIdx + 150).includes('geoDashboardGa4ClearMarkers();');
})());
check('F2', 'resolved.ok === false 分支也呼叫 geoDashboardGa4ClearMarkers()（驗證錯誤時不留舊 marker）', (() => {
  const idx = refreshBody.indexOf('if (!resolved.ok)');
  return idx !== -1 && refreshBody.slice(idx, idx + 250).includes('geoDashboardGa4ClearMarkers();');
})());
check('F3', 'body.success===false（GET 失敗）分支也呼叫 geoDashboardGa4ClearMarkers()（錯誤時不留舊 marker）', (() => {
  const idx = refreshBody.indexOf('if (!body || body.success === false)');
  return idx !== -1 && refreshBody.slice(idx, idx + 200).includes('geoDashboardGa4ClearMarkers();');
})());
check('F4', 'rows.length === 0 分支也呼叫 geoDashboardGa4ClearMarkers()（empty 不是「保留舊 marker」的分支）', (() => {
  const idx = refreshBody.indexOf('if (rows.length === 0)');
  return idx !== -1 && refreshBody.slice(idx, idx + 150).includes('geoDashboardGa4ClearMarkers();');
})());
check('F5', 'source 中不存在「rows 為空就 return，不清 marker」的寫法（沒有 empty-preserve branch）', !/rows\.length === 0\)\s*\{\s*(?!.*geoDashboardGa4ClearMarkers)[^}]*return/.test(refreshBody.replace(/geoDashboardGa4ClearMarkers\(\);/g, 'CLEARED();')) || refreshBody.includes('geoDashboardGa4ClearMarkers();\n    _geoDashboardGa4RenderEmptyCta'));
check('F6', 'geoDashboardGa4ClearMarkers() 呼叫的是 layerGroup.clearLayers()（真的清除 Leaflet layer，不是只清狀態變數）', dashCode.includes('dashboardGa4State.layerGroup.clearLayers();'));
check('F7', 'geoDashboardGa4RenderMarkers() 一開始也呼叫一次 geoDashboardGa4ClearMarkers()（同一個 range 重新整理不會疊加 marker）', extractFnBody(dashSrc, 'function geoDashboardGa4RenderMarkers(mapInstance, rows, displayLabel)').includes('geoDashboardGa4ClearMarkers();'));
check('F8', 'geoDashboardGa4RenderMarkers() 只有一個 LayerGroup owner（_geoDashboardGa4EnsureGroup 只在 !dashboardGa4State.layerGroup 時才 new 一個，不會重複建立）', dashCode.includes('if (!dashboardGa4State.layerGroup && typeof L !== \'undefined\''));
check('F9', 'geoDashboardGa4Refresh() 回傳值明確標出 rows 數量／error／superseded 三種語意（讓呼叫端可以正確判斷「同步後仍是空」而不是誤判成功=有資料）', refreshBody.includes('return { rows: 0 };') && refreshBody.includes('return { rows: count };') && refreshBody.includes("return { superseded: true };"));

// ════════════════════════════════════════════════════════════════
// Category G — Dashboard Wheel
// ════════════════════════════════════════════════════════════════
check('G1', 'geoDashboardMapActivate() 呼叫 geoDashboardMapDisableWheel()（activate 一律先回到 disabled，不記住上一輪狀態）', extractFnBody(heatUiSrc, 'function geoDashboardMapActivate(mapContainerId)').includes('geoDashboardMapDisableWheel();'));
check('G2', 'geoDashboardMapDisableWheel() 真的呼叫 map.scrollWheelZoom.disable()', extractFnBody(heatUiSrc, 'function geoDashboardMapDisableWheel()').includes('map.scrollWheelZoom.disable()'));
check('G3', 'geoDashboardMapEnableWheel() 真的呼叫 map.scrollWheelZoom.enable()，且只在使用者點地圖時被呼叫（_geoDashboardMapOnMapClick）', extractFnBody(heatUiSrc, 'function geoDashboardMapEnableWheel()').includes('map.scrollWheelZoom.enable()') && extractFnBody(heatUiSrc, 'function _geoDashboardMapOnMapClick()').includes('geoDashboardMapEnableWheel()'));
check('G4', '_geoDashboardMapOnKeydown() 監聽 Escape，呼叫 geoDashboardMapDisableWheel()', extractFnBody(heatUiSrc, 'function _geoDashboardMapOnKeydown(e)').includes("e.key === 'Escape'") && extractFnBody(heatUiSrc, 'function _geoDashboardMapOnKeydown(e)').includes('geoDashboardMapDisableWheel()'));
check('G5', '_geoDashboardMapOnOutsideClick() 用 canvas.contains(e.target) 判斷是否點在地圖外，點外面才 disable', extractFnBody(heatUiSrc, 'function _geoDashboardMapOnOutsideClick(e)').includes('canvas.contains(e.target)'));
check('G6', 'geoDashboardMapBindWheelLifecycle() 是 idempotent（已經 bound 就直接 return true，不會重複 addEventListener）', extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)').includes('if (dashboardMapInteractionState.bound) return true;'));
check('G7', 'GEO_DASHBOARD_MAP_WHEEL_HINT 有 disabled/enabled 兩種文案，跟 hint 元素同步更新', heatUiCode.includes("disabled: '點擊地圖後可使用滾輪縮放'") && heatUiCode.includes("enabled: '滾輪縮放已啟用・按 Esc 關閉'"));

// ════════════════════════════════════════════════════════════════
// Category G（續）— DOM Element Identity Contract（Real Production
// Bug #2 固定）：idempotent bind 判斷不能只看 mapContainerId 字串，必須
// 也追蹤實際綁定的 DOM element 參考，refresh 造成的 DOM 節點替換必須
// 觸發 rebind。
// ════════════════════════════════════════════════════════════════
check('G8', 'dashboardMapInteractionState 有 boundCanvasEl 欄位（記住實際綁定的 DOM 節點參考，不只是 containerId 字串）', heatUiCode.includes('boundCanvasEl: null'));
check('G9', 'geoDashboardMapBindWheelLifecycle() 在 bind 之前，先用 document.getElementById(mapContainerId) 取得目前「活著」的 DOM 節點（每次呼叫都重新查，不是只在第一次查）', (() => {
  const bindBody = extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)');
  const canvasIdx = bindBody.indexOf('const canvas = document.getElementById(mapContainerId);');
  return canvasIdx !== -1 && canvasIdx < bindBody.indexOf('if (dashboardMapInteractionState.bound) return true;');
})());
check('G10', 'geoDashboardMapBindWheelLifecycle() 判斷「domNodeReplaced」（目前活著的 DOM 節點 !== 上次綁定時記住的節點），不是只比對 containerId 字串是否相同', (() => {
  const bindBody = extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)');
  return /dashboardMapInteractionState\.boundCanvasEl !== null && dashboardMapInteractionState\.boundCanvasEl !== canvas/.test(bindBody);
})());
check('G11', 'containerChanged 或 domNodeReplaced 任一為真，都會先呼叫 _geoDashboardMapUnbindWheelLifecycle() 再重新綁定（不是「id 一樣就直接 return」）', (() => {
  const bindBody = extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)');
  return /if \(dashboardMapInteractionState\.bound && \(containerChanged \|\| domNodeReplaced\)\) \{\s*\n\s*_geoDashboardMapUnbindWheelLifecycle\(\);/.test(bindBody);
})());
check('G12', '重新綁定後，boundCanvasEl 會更新成「這次真正 addEventListener 的那個節點」，讓下一次呼叫可以正確比對', (() => {
  const bindBody = extractFnBody(heatUiSrc, 'function geoDashboardMapBindWheelLifecycle(mapContainerId)');
  return bindBody.includes('dashboardMapInteractionState.boundCanvasEl = canvas;');
})());
check('G13', '_geoDashboardMapUnbindWheelLifecycle() 優先用 boundCanvasEl 這個「當初實際綁定的節點參考」去 removeEventListener，不是重新 document.getElementById() 查一次「現在的」節點（現在的節點可能已經是別的，用現在的節點 remove 舊 listener 沒有意義）', (() => {
  const unbindBody = extractFnBody(heatUiSrc, 'function _geoDashboardMapUnbindWheelLifecycle()');
  return unbindBody.includes('const canvas = dashboardMapInteractionState.boundCanvasEl');
})());
check('G14', '_geoDashboardMapUnbindWheelLifecycle() 完成後清空 boundCanvasEl（避免比對到已經失效的舊參考）', extractFnBody(heatUiSrc, 'function _geoDashboardMapUnbindWheelLifecycle()').includes('dashboardMapInteractionState.boundCanvasEl = null;'));
check('G15', '_geoDashboardMapResetInteractionStateForTest() 也重置 boundCanvasEl（測試隔離乾淨）', extractFnBody(heatUiSrc, 'function _geoDashboardMapResetInteractionStateForTest()').includes('boundCanvasEl'));

// ════════════════════════════════════════════════════════════════
// Category H — Heatmap Wheel（H1.4.2 新 Contract）
// ════════════════════════════════════════════════════════════════
check('H1', 'geoHeatUiSwitchTab() 的 heatmap 分支成功提取', heatmapBranch !== '__EXTRACTION_FAILED__' && heatmapBranch.length > 50);
check('H2', 'heatmap 分支呼叫既有 geoDashboardMapActivate()（重用 Dashboard 同一套 click-to-activate lifecycle）', heatmapBranch.includes('geoDashboardMapActivate('));
check('H3', 'heatmap 分支【不再】呼叫 geoDashboardMapDeactivateForHeatmap()（H1.4.1 舊的 auto-enable 路徑已移除呼叫）', !heatmapBranch.includes('geoDashboardMapDeactivateForHeatmap()'));
check('H4', '整個 geo-heatmap-ui.js 裡，geoDashboardMapDeactivateForHeatmap() 沒有任何呼叫端（dead but harmless：函式保留、呼叫點清空）', (() => {
  const callSites = heatUiCode.split('geoDashboardMapDeactivateForHeatmap()').length - 1; // 含函式定義本身那一次
  return callSites === 1; // 只剩 function 定義那一次出現，沒有任何呼叫
})());
check('H5', 'dashboard 分支（else）也呼叫 geoDashboardMapActivate()（切回 Dashboard 一樣重新 lock）', dashboardBranch.includes('geoDashboardMapActivate('));
check('H6', 'Heatmap 與 Dashboard 用同一個 mapContainerId／同一套 hint DOM（geoHeatUiState.mapContainerId 是唯一來源，沒有另外建一個 heatmap 專屬 container id）', heatmapBranch.includes('geoHeatUiState.mapContainerId'));
check('H7', 'source 中不存在任何「切到 heatmap 就 scrollWheelZoom.enable()」的可觸達呼叫（唯一可觸達的 .enable() 呼叫點只在 geoDashboardMapEnableWheel() 內部，經由使用者點擊觸發；H1.4.1 舊的 geoDashboardMapDeactivateForHeatmap() 函式體內雖然還留著同一行字面值，但 H4 已證明它沒有任何呼叫端，是死碼，不影響 Contract）', (() => {
  const deadFnBody = extractFnBody(heatUiSrc, 'function geoDashboardMapDeactivateForHeatmap()');
  const codeWithoutDeadFn = heatUiCode.replace(codeOnly(deadFnBody), '');
  const enableCalls = codeWithoutDeadFn.match(/scrollWheelZoom\.enable\(\)/g) || [];
  return enableCalls.length === 1; // 只剩 geoDashboardMapEnableWheel() 內那一處
})());

// ════════════════════════════════════════════════════════════════
// Category (G/H 續) — 兩個 Tab 完全一致 + Leaflet controls 不受影響
// ════════════════════════════════════════════════════════════════
check('GH1', 'Dashboard 與 Heatmap 共用同一份 dashboardMapInteractionState（沒有另建一個 heatmapMapInteractionState，兩邊行為天生一致，不會漂移）', heatUiCode.includes('let dashboardMapInteractionState = {') && (heatUiCode.match(/dashboardMapInteractionState/g) || []).length > 5 && !heatUiCode.includes('heatmapMapInteractionState'));
check('GH2', 'zoomIn/zoomOut（Leaflet +/- control）完全沒有被本輪 wheel 邏輯呼叫或攔截', !heatUiCode.includes('.zoomIn(') && !heatUiCode.includes('.zoomOut('));
check('GH3', 'dragging 沒有被 wheel lifecycle 相關函式提及／停用（本輪只控制 scrollWheelZoom）', !/dashboardMapInteractionState[\s\S]{0,300}dragging/.test(heatUiCode) && !/geoDashboardMap(Enable|Disable)Wheel[\s\S]{0,200}dragging/.test(heatUiCode));

// ════════════════════════════════════════════════════════════════
// Category I — Same Map
// ════════════════════════════════════════════════════════════════
check('I1', 'geoDashboardGa4Activate()／geoDashboardGa4Refresh() 都不呼叫 L.map(（不建立第二張地圖，重用呼叫端傳入的既有 mapInstance）', !activateBody.includes('L.map(') && !refreshBody.includes('L.map('));
check('I2', 'geoDashboardGa4SyncNow() 也不建立地圖，只重用 dashboardGa4State.mapInstance', !syncNowBody.includes('L.map('));
check('I3', 'geoHeatUiSwitchTab() 兩個分支都不呼叫 L.map(（切分頁不建第二張地圖，重用 window.geoMapState.instance）', !switchTabBody.includes('L.map('));
check('I4', 'geoDashboardGa4Activate()／geoDashboardGa4Refresh() 都是透過參數傳入的 mapInstance 操作地圖，不是自己 new 一個 state', activateBody.includes('mapInstance') && refreshBody.includes('mapInstance'));

// ════════════════════════════════════════════════════════════════
// Category J — H1.4.1 Cleanup Retention
// ════════════════════════════════════════════════════════════════
const giSrcForCleanup = read('public/js/geo-intelligence.js');
const refreshKpiBody = extractFnBody(giSrcForCleanup, 'async function refreshGeoDashboardKpiBlock(containerId)');
const dashTemplateStart = refreshKpiBody.indexOf('<div id="${containerId}-panel-dashboard"');
const dashTemplateEnd = refreshKpiBody.indexOf('${heatPanelHtml}');
const dashTemplate = (dashTemplateStart !== -1 && dashTemplateEnd !== -1) ? refreshKpiBody.slice(dashTemplateStart, dashTemplateEnd) : '__EXTRACTION_FAILED__';
check('J1', 'Dashboard template 片段成功提取（本輪未修改 geo-intelligence.js 的這段，沿用 H1.4.1 既有 Contract）', dashTemplate !== '__EXTRACTION_FAILED__' && dashTemplate.length > 50);
check('J2', 'Dashboard template 片段不插入 ${kpiCards}（POS Geo KPI diagnostics 仍不在 Dashboard）', !dashTemplate.includes('${kpiCards}'));
check('J3', 'Dashboard template 片段不插入 renderGeoQualityBlock(', !dashTemplate.includes('renderGeoQualityBlock('));
check('J4', 'Dashboard template 片段不含 legacy ranking owner (-legacy-ranking)', !dashTemplate.includes('-legacy-ranking'));
check('J5', 'Dashboard template 片段不含 old 8-metric selector owner (-metric-bar)', !dashTemplate.includes('-metric-bar'));
check('J6', 'Dashboard template 片段不含「目前所有訪客皆為未知區域」等 Acquisition Geo warning 文字', !dashTemplate.includes('目前所有訪客皆為未知區域'));
check('J7', 'Dashboard template 片段不含「營運決策中心」/decision-card（Recommended Actions）', !dashTemplate.includes('營運決策中心') && !dashTemplate.includes('geo-decision-card'));
check('J8', 'Heatmap panel（geoHeatUiRenderPanel）仍然存在且被組進版面（詳細分析仍保留在 Heatmap）', giSrcForCleanup.includes('geoHeatUiRenderPanel') && refreshKpiBody.includes('${heatPanelHtml}'));
check('J9', 'Ranking ID 不重複：legacy ranking 用 -legacy-ranking，Heatmap engine ranking 用 -ranking，兩個不同字面值', heatUiCode.includes('-legacy-ranking') || giSrcForCleanup.includes('-legacy-ranking'));

// ════════════════════════════════════════════════════════════════
// Category K — Frozen Backend（本輪 Production Backend 必須 byte-identical）
// ════════════════════════════════════════════════════════════════
const H1_4_1_ROOT = path.join(ROOT, '..', 'baseline-h1-4-1-frozen-check');
let frozenCheckable = false;
try {
  frozenCheckable = fs.existsSync(path.join(ROOT, '..', 'fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.1-GEO-DASHBOARD-CLEANUP'));
} catch (e) { frozenCheckable = false; }
const BACKEND_FILES = [
  'services/ga4GeoSyncService.js', 'routes/ga4-geo.js', 'utils/db.js',
  'middleware/adminGuard.js', 'middleware/storeGuard.js', 'middleware/licenseGuard.js', 'middleware/featureGate.js',
];
BACKEND_FILES.forEach((rel, i) => {
  check(`K${i + 1}`, `${rel} 存在（frozen backend 檔案存在性 precondition）`, fs.existsSync(path.join(ROOT, rel)));
});
check('K8', 'routes/ga4-geo.js 的 Manual Sync 節流仍是既有 _lastManualSync（per-store, 5000ms），本輪未修改 Backend 節流邏輯', read('routes/ga4-geo.js').includes('MANUAL_SYNC_MIN_INTERVAL_MS = 5000') && read('routes/ga4-geo.js').includes('_lastManualSync.get(req.storeId)'));
check('K9', 'services/ga4GeoSyncService.js 的 resolveRangeWindow() 仍是既有實作（today/yesterday/7d/30d 用 server clock 重算，其餘信任前端 start/end），本輪未修改', read('services/ga4GeoSyncService.js').includes('function resolveRangeWindow(rangeKey, customStart, customEnd)'));
check('K10', 'services/ga4GeoSyncService.js 的 UNIQUE key 仍包含 range_start_date/range_end_date（persisted identity 靠日期，不是 range_key 標籤），本輪未修改', read('services/ga4GeoSyncService.js').includes('range_start_date, range_end_date'));
check('K11', 'dashCode（geo-ga4-dashboard-layer.js）沒有出現 require(\'../services\') 或 require(\'../routes\') 等直接 import 後端模組的寫法（前端檔案不該直接依賴 Backend 內部模組）', !dashCode.includes("require('../services") && !dashCode.includes("require('../routes"));

// ════════════════════════════════════════════════════════════════
// Category L — Security / Authenticated Helper 使用
// ════════════════════════════════════════════════════════════════
check('L1', '_geoDashboardGa4ApiRequest() 優先使用 window.apiFetch（既有 authenticated helper），不是無條件用裸 fetch', dashCode.includes("const winApiFetch = (typeof window !== 'undefined') ? window.apiFetch : undefined;"));
check('L2', 'geoDashboardGa4SyncNow() 送出的 POST 走 _geoDashboardGa4ApiRequest()（同一個 helper），不是另外寫一個 fetch(...) 呼叫', syncNowBody.includes('_geoDashboardGa4ApiRequest('));
check('L3', 'geoDashboardGa4SyncNow() 的 POST body JSON 沒有 store_id 欄位（store scoping 交給既有 requireStore 中介層，不是前端自己夾帶）', !syncNowBody.includes('store_id'));
check('L4', 'geo-ga4-dashboard-layer.js 整份檔案沒有出現 store_id 這個識別字（前端完全不處理 store 範圍，不新增任何 store 覆寫路徑）', !dashCode.includes('store_id'));
check('L5', 'geoDashboardGa4SyncNow() 沒有把任何 credential/token 字面值寫進 request body 或 URL', !/api[_-]?key|secret|password|token\s*[:=]\s*['"]/.test(syncNowBody));
check('L6', '401/403 的既有 auth 分類（auth_required/feature_disabled）在 _geoDashboardGa4ApiRequest() 內仍保留，本輪未破壞既有 Auth Contract', dashCode.includes("res.status === 401 ? 'auth_required' : 'feature_disabled'"));

// ════════════════════════════════════════════════════════════════
// Category M — Parse Sanity
// ════════════════════════════════════════════════════════════════
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-dashboard-layer.js')]);
  check('M1', 'node --check geo-ga4-dashboard-layer.js 通過', true);
} catch (e) { check('M1', 'node --check geo-ga4-dashboard-layer.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-heatmap-ui.js')]);
  check('M2', 'node --check geo-heatmap-ui.js 通過', true);
} catch (e) { check('M2', 'node --check geo-heatmap-ui.js 通過', false); }
check('M3', 'geo-ga4-dashboard-layer.js module.exports 有完整暴露本輪新函式（geoDashboardGa4SyncNow 等），供 test runtime require() 使用', dashCode.includes('geoDashboardGa4SyncNow,') && dashCode.includes('_geoDashboardGa4RangesEqual'));

try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-range-control.js')]);
  check('M4', 'node --check geo-range-control.js 通過', true);
} catch (e) { check('M4', 'node --check geo-range-control.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-range-resolver.js')]);
  check('M5', 'node --check geo-range-resolver.js 通過', true);
} catch (e) { check('M5', 'node --check geo-range-resolver.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-intelligence.js')]);
  check('M6', 'node --check geo-intelligence.js 通過', true);
} catch (e) { check('M6', 'node --check geo-intelligence.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-ga4-h1-panel.js')]);
  check('M7', 'node --check geo-ga4-h1-panel.js 通過', true);
} catch (e) { check('M7', 'node --check geo-ga4-h1-panel.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'routes/ga4-geo.js')]);
  check('M8', 'node --check routes/ga4-geo.js 通過（Frozen Backend 仍是合法可解析的 JS）', true);
} catch (e) { check('M8', 'node --check routes/ga4-geo.js 通過', false); }
try {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/ga4GeoSyncService.js')]);
  check('M9', 'node --check services/ga4GeoSyncService.js 通過（Frozen Backend 仍是合法可解析的 JS）', true);
} catch (e) { check('M9', 'node --check services/ga4GeoSyncService.js 通過', false); }

// ════════════════════════════════════════════════════════════════
// Category N — Data-shape / Tooltip / Label Contract（追加，避免遺漏
// H1.4 既有的顯示語意在本輪被無意間破壞）
// ════════════════════════════════════════════════════════════════
check('N1', 'geoDashboardGa4RenderMarkers() 只針對 normalization_status===\'ok\' 的 row 畫 marker（跳過 unknown/failed）', dashCode.includes("if (row.normalization_status !== 'ok') return;"));
check('N2', 'geoDashboardGa4RenderMarkers() 用 Number.isFinite 驗證 lat/lng（不會因為缺角座標畫出 NaN marker）', dashCode.includes('Number.isFinite(point.lat)') && dashCode.includes('Number.isFinite(point.lng)'));
check('N3', '_geoDashboardGa4BuildTooltip() 不對多個 row 加總 active_users（每個 row 各自一個 marker，不產生「總訪客」數字）', !dashCode.includes('activeUsers +=') && !dashCode.includes('totalActiveUsers'));
check('N4', 'DASHBOARD_GA4_FRIENDLY_LABELS 涵蓋 today/yesterday/7d/30d/90d/180d/this_year/last_year 八個 preset 的中文對照', ['today', 'yesterday', "'7d'", "'30d'", "'90d'", "'180d'", 'this_year', 'last_year'].every((k) => dashCode.includes(k)));
check('N5', 'geoDashboardGa4RangeLabel() 對 single/custom 這兩個沒有口語化對照的 mode，直接 fallback 用 resolved.displayLabel', dashCode.includes('return friendly || resolved.displayLabel;'));
check('N6', '_geoDashboardGa4RenderLabel() 對 friendlyLabel===actualRange 的情況（single/custom）不重複顯示兩行一樣的文字', dashCode.includes('const showActualRangeSeparately = friendlyLabel !== actualRange;'));
check('N7', 'CTA 文案「立即同步並顯示」與提示「同步完成後會自動更新地圖」都是本輪新增的字面值，實際出現在 render 函式裡（不是只在註解）', codeOnly(dashSrc).includes('立即同步並顯示') && codeOnly(dashSrc).includes('同步完成後會自動更新地圖'));

// ════════════════════════════════════════════════════════════════
// Category O — Test/Runtime 自我一致性（本輪新增的 test scripts 是否
// 真的存在、且引用了正確的 production 檔案，避免 Regression Runner 之後
// 撿到一個空殼）
// ════════════════════════════════════════════════════════════════
check('O1', 'scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js 存在', fs.existsSync(path.join(ROOT, 'scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js')));
check('O2', 'scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js 存在', fs.existsSync(path.join(ROOT, 'scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js')));
check('O3', 'Browser Target Runtime 真的 require/eval 了 geo-ga4-dashboard-layer.js（不是測了一個不相關的檔案）', read('scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js').includes('geo-ga4-dashboard-layer.js'));
check('O4', 'Browser Target Runtime 真的 require/eval 了 geo-heatmap-ui.js', read('scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js').includes('geo-heatmap-ui.js'));
check('O5', 'Persisted Identity Runtime 真的 require 了 services/ga4GeoSyncService.js（不是 mock）', read('scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js').includes("require(path.join(ROOT, 'services/ga4GeoSyncService'))"));
check('O6', 'Persisted Identity Runtime 真的 require 了前端 geo-range-resolver.js（Sync identity 跟 GET identity 用同一顆 resolver，不是各自硬編日期）', read('scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js').includes("require(path.join(ROOT, 'public/js/geo-range-resolver.js'))"));
check('O7', 'Persisted Identity Runtime 涵蓋全部 10 種 mode（today/yesterday/7d/30d/90d/180d/this_year/last_year/single/custom）', ['today', 'yesterday', "'7d'", "'30d'", "'90d'", "'180d'", 'this_year', 'last_year', 'single', 'custom'].every((k) => read('scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js').includes(k)));


const passed = checks.filter((c) => c.ok);
const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'PASS' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('H1.4.2 GA4 RANGE-MAP-WHEEL STATIC AUDIT SUMMARY');
console.log(`  PASS:  ${passed.length}`);
console.log(`  FAIL:  ${failed.length}`);
console.log(`  TOTAL: ${checks.length}`);
console.log('======================================================================');
if (failed.length > 0) process.exitCode = 1;
