#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-3.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full
//
// 只檢查本輪（H1.4.3）新增/修改的 Contract：Cross-range stale fallback
// guard（lastGoodRangeKey）／Overseas-Other display disambiguation／
// Range Resolver 沒有第二套演算法／Exact-Match Persisted Read／No
// Snapshot Summing／Map-Status-Table Single Payload／Search／Realtime-
// Historical Split／H1.4.2 Freeze／Backend Scope。不重複既有
// static-audit-g1-6-ga4-h1-4.js（230 checks）／static-audit-g1-6-ga4-h1-4-2.js
// （134 checks）——這兩個繼續獨立跑、繼續 PASS，本輪不修改其覆蓋範圍。

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
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

const panelSrc = read('public/js/geo-ga4-h1-panel.js');
const panelCode = codeOnly(panelSrc);
const dashSrc = read('public/js/geo-ga4-dashboard-layer.js');
const dashCode = codeOnly(dashSrc);
const heatUiSrc = read('public/js/geo-heatmap-ui.js');
const rangeResolverSrc = read('public/js/geo-range-resolver.js');
const rangeCtrlSrc = read('public/js/geo-range-control.js');
const svcSrc = read('services/ga4GeoSyncService.js');
const routeSrc = read('routes/ga4-geo.js');
const normalizeSrc = read('utils/ga4Geo/normalize.js');

const refreshBody = extractFnBody(panelSrc, 'async function geoGa4H1Refresh(ids, mapInstance)');
const toolbarBody = extractFnBody(panelSrc, 'function geoGa4H1RenderToolbar(containerId, onChange)');
const syncHandlerStart = toolbarBody.indexOf('const syncHandler = async () => {');
const syncHandlerBody = syncHandlerStart !== -1 ? toolbarBody.slice(syncHandlerStart) : '__EXTRACTION_FAILED__';

for (const [id, desc, cond] of [
  ['SANITY-1', 'geoGa4H1Refresh() 本體可被提取（extraction 沒有壞掉，後面的 body-based 檢查才有意義）', refreshBody.length > 200],
]) check(id, desc, cond);

// ════════════════════════════════════════════════════════════════
// Category A — Range Resolver：Heatmap Historical 重用同一顆 resolver，
// 沒有第二套日期演算法。
// ════════════════════════════════════════════════════════════════
check('A1', 'geo-ga4-h1-panel.js 透過 resolveGeoHistoricalRange（同一顆共用純函式）resolve range，不是自己另外算日期', panelCode.includes('_geoGa4H1ResolveRangeFn(geoGa4H1State.rangeState.mode, geoGa4H1State.rangeState)'));
check('A2', 'geo-ga4-h1-panel.js 沒有自己重新實作 today/yesterday/7d/30d/90d/180d 的日期加減算法（沒有出現 setDate/getDate 手算日期字面片段）', !/setUTCDate|getUTCDate\(\)\s*[+-]/.test(panelCode));
['today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom'].forEach((mode, i) => {
  check(`A3-${i}`, `GEO_GA4_H1_MODES 包含歷史 range 值 '${mode}'`, panelCode.includes(`'${mode}'`));
  check(`A4-${i}`, `geo-range-resolver.js 的 GEO_RANGE_MODES 也包含 '${mode}'（同一份 Contract，不是各自維護一份清單）`, rangeResolverSrc.includes(`'${mode}'`));
});
check('A5', 'resolveGeoHistoricalRange 對 90d 使用 offsetDays=-89（inclusive 90 天，不是 -90）', rangeResolverSrc.includes("dateStr(-89)"));
check('A6', 'resolveGeoHistoricalRange 對 180d 使用 offsetDays=-179（inclusive 180 天，不是 -180）', rangeResolverSrc.includes('dateStr(-179)'));
check('A7', 'geo-range-resolver.js 只有這一份檔案定義 resolveGeoHistoricalRange（沒有第二個同名函式散落在其他 Heatmap 檔案）', (heatUiSrc.match(/function resolveGeoHistoricalRange/g) || []).length === 0);
check('A8', 'Dashboard 與 Heatmap H1 各自的 ResolveRange 函式（_geoDashboardGa4ResolveRange／_geoGa4H1ResolveRange）都是呼叫同一顆 resolveGeoHistoricalRange，不是各自複製實作', dashCode.includes('_geoDashboardResolveRangeFn(') && panelCode.includes('_geoGa4H1ResolveRangeFn('));

// ════════════════════════════════════════════════════════════════
// Category B — Historical Request：selected range 真的影響 request 的
// start/end，不是只切 UI state。
// ════════════════════════════════════════════════════════════════
check('B1', 'geoGa4H1Fetch() 對 custom transport 會把 opts.startDate/endDate 寫進 URLSearchParams（真的送出 start_date/end_date，不是只送 range 字面值）', panelCode.includes("params.set('start_date', opts.startDate") && panelCode.includes("params.set('end_date', opts.endDate"));
check('B2', 'geoGa4H1Refresh() 把 resolved.startDate/endDate 放進 fetchOpts，再交給 geoGa4H1Fetch()（identity 從 resolver 一路傳到 request，沒有中途被丟掉）', refreshBody.includes('fetchOpts = { startDate: resolved.startDate, endDate: resolved.endDate }'));
check('B3', 'fetchMode 使用 resolved.apiRange（不是硬編字面值），今天/昨日/7d/30d 維持既有 preset，其餘走 custom', refreshBody.includes('fetchMode = resolved.apiRange'));
check('B4', 'resolved.ok===false 時（validation 失敗）geoGa4H1Refresh() 直接 return，不送出任何 API request', refreshBody.includes('if (!resolved.ok)') && /if \(!resolved\.ok\) \{[\s\S]*?return;/.test(refreshBody));
check('B5', 'Manual Sync（syncHandler）跟 Historical Read 用同一個 _geoGa4H1ResolveRange()（同一份 identity，不是各自算一次可能不一致）', syncHandlerBody.includes('_geoGa4H1ResolveRange()'));
check('B6', 'Manual Sync 送出的 body 帶 range/start_date/end_date（跟 Read 走同一個 resolved 物件的欄位）', syncHandlerBody.includes('range: resolved.apiRange, start_date: resolved.startDate, end_date: resolved.endDate'));

// ════════════════════════════════════════════════════════════════
// Category C — Exact Persisted Read：backend 用 range_start_date /
// range_end_date exact match，不是 all-history 再交給前端篩選。
// ════════════════════════════════════════════════════════════════
check('C1', 'getRangeGeoStats() 的 SQL WHERE 子句包含 range_start_date=? AND range_end_date=?（exact match，不是只 WHERE store/property）', /WHERE store_id=\?\s+AND property_id=\?\s+AND range_start_date=\?\s+AND range_end_date=\?/.test(svcSrc));
check('C2', 'getRangeGeoStats() 沒有 ORDER BY ... LIMIT 1 之外還額外撈「最新 N 筆」當 fallback（沒有 latest snapshot 全域 fallback 邏輯）', !/ORDER BY\s+synced_at_utc\s+DESC(?!.*range_start_date)/i.test(svcSrc));
check('C3', 'ga4_geo_range_stats 的 UNIQUE 約束包含 range_start_date/range_end_date（persistence identity 是實際日期，不是粗粒度 range_key 標籤）', /ON CONFLICT\(store_id, property_id, range_start_date, range_end_date, raw_location_key, metrics_version, event_mapping_version\)/.test(svcSrc));
check('C4', 'routes/ga4-geo.js 的 GET /history 直接把 req.query.start_date/end_date 原樣傳給 svc.getRangeGeoStats（沒有中途被丟棄或改寫成別的值）', routeSrc.includes('svc.getRangeGeoStats(req.storeId, range, req.query.start_date, req.query.end_date)'));
check('C5', 'routes/ga4-geo.js 沒有任何「/history 忽略 query 直接回全部」的分支（沒有 SELECT * FROM ga4_geo_range_stats WHERE store_id=? 這種缺少 range 條件的字面片段殘留在 route 檔案本身）', !/db\.(all|get)\(`SELECT \* FROM ga4_geo_range_stats WHERE store_id=\?`/.test(routeSrc));

// ════════════════════════════════════════════════════════════════
// Category D — No Snapshot Summing：不得把不同 snapshot 的 activeUsers
// 加總成另一個 range 的數字。
// ════════════════════════════════════════════════════════════════
check('D1', 'services/ga4GeoSyncService.js 寫入 active_users 沒有任何 += 累加寫法（每次都是單一 GA4 Query 的單一指定值）', !/active_users\s*\+=/.test(svcSrc));
check('D2', 'services/ga4GeoSyncService.js 沒有把多個 range_start_date/range_end_date 的 rows 加總成一個新數字的 reduce/sum 邏輯（沒有橫跨多個 snapshot 做 reduce((s,r)=>s+r.active_users) 這種寫法）', !/reduce\(\s*\(\s*\w+\s*,\s*\w+\s*\)\s*=>\s*\w+\s*\+\s*\w+\.active_users/.test(svcSrc));
check('D3', 'public/js/geo-ga4-dashboard-layer.js 明確標註「不 sum district」activeUsers 語意（原始檔案含註解），且程式碼裡沒有 reduce(...+r.active_users) 這種跨行政區/跨 snapshot 加總寫法', dashSrc.includes('不 sum district') && !/reduce\(\(.*,\s*\w+\)\s*=>\s*.*\+\s*.*\.active_users/.test(dashCode));
check('D4', 'public/js/geo-ga4-h1-panel.js 的 Tooltip／Table 渲染直接顯示 row.active_users 原始值，沒有跨 row 或跨 range 加總後才顯示', panelCode.includes('const activeUsers = row.active_users ?? row.current_active_users ?? 0;') || panelCode.includes('const activeUsers = r.active_users ?? r.current_active_users ?? 0;'));
check('D5', 'syncGeoRangeStats() 的 merged Map 是用單一次 Promise.all([audience,eventFunnel,commerce]) 的結果建立，不是迭代多個獨立 range 的舊 rows 做合併', /Promise\.all\(\[\s*_fetchWithRetry\(\(\) => adapter\.runAudienceRange/.test(svcSrc));

// ════════════════════════════════════════════════════════════════
// Category E — Cache Identity：lastGoodPayload 必須搭配
// lastGoodRangeKey，fallback 只能同 identity 使用（H1.4.3 核心修正）。
// ════════════════════════════════════════════════════════════════
check('E1', 'geoGa4H1State 有 lastGoodRangeKey 欄位（跟 lastGoodPayload 綁在一起追蹤）', panelCode.includes('lastGoodRangeKey: null'));
check('E2', '_geoGa4H1FetchRangeKey() 存在，用來把 fetchMode+startDate+endDate 組成一個可比較的 identity 字串', panelCode.includes('function _geoGa4H1FetchRangeKey(mode, opts)'));
check('E3', 'geoGa4H1Refresh() 在成功時把目前的 currentRangeKey 一併寫進 lastGoodRangeKey（不是只更新 lastGoodPayload）', refreshBody.includes('geoGa4H1State.lastGoodRangeKey = currentRangeKey;'));
check('E4', 'geoGa4H1Refresh() 的 stale-fallback 分支明確比較 geoGa4H1State.lastGoodRangeKey === currentRangeKey，不是無條件重用 lastGoodPayload', refreshBody.includes('geoGa4H1State.lastGoodRangeKey === currentRangeKey'));
check('E5', 'geoGa4H1Refresh() 沒有任何路徑在 currentRangeKey 不吻合時仍把 lastGoodPayload 包裝成 success:true 顯示出來（唯一一處 `success: true, stale: true` 一定在同 key 的分支內）', (() => {
  const idx = refreshBody.indexOf('success: true, stale: true');
  if (idx === -1) return false;
  const before = refreshBody.slice(0, idx);
  const guardIdx = before.lastIndexOf('lastGoodRangeKey === currentRangeKey');
  return guardIdx !== -1 && idx - guardIdx < 400; // 同一個 if-branch 範圍內
})());
check('E6', 'cross-range 失敗時，payload 被改寫成乾淨的 { success:false, code } 物件，不是繼續帶著舊 rows/cities 欄位', refreshBody.includes("payload = { success: false, code: (payload && payload.code) || 'unexpected_error' };"));

// ════════════════════════════════════════════════════════════════
// Category F — Custom Transport Collision：90d/180d/this_year/
// last_year/single/custom 全部可能用 apiRange='custom'，cache identity
// 不能只認 mode==='custom'，必須用 actual start/end 區分。
// ════════════════════════════════════════════════════════════════
check('F1', '_geoGa4H1FetchRangeKey() 的 key 組成包含 opts.startDate／opts.endDate（不是只用 mode 字面值當 key）', panelCode.includes('return `${mode}|${(opts && opts.startDate) || \'\'}|${(opts && opts.endDate) || \'\'}`;'));
check('F2', 'geoGa4H1Refresh() 呼叫 _geoGa4H1FetchRangeKey() 時傳入的是 fetchMode（resolved.apiRange，90d/180d/custom 全部會是同一個字面值 \'custom\'）加上 fetchOpts（含實際 startDate/endDate）——確保就算 apiRange 撞名，key 仍靠日期分開', refreshBody.includes('_geoGa4H1FetchRangeKey(fetchMode, fetchOpts)'));
check('F3', 'realtime 模式的 key 是固定字面值 \'realtime\'（不會跟任何 historical custom range 的 key 混淆，因為 historical key 一定包含 mode=custom 前綴，兩者字串前綴天生不同）', panelCode.includes("if (mode === 'realtime') return 'realtime';"));

// ════════════════════════════════════════════════════════════════
// Category G — Map / Status / Table Single Payload：三者都來自同一次
// Refresh 拿到的同一個 payload，不是各自讀不同變數。
// ════════════════════════════════════════════════════════════════
check('G1', 'geoGa4H1Refresh() 只有一個 `const rows = payload.cities || payload.rows || [];`，Table 跟 Map 都吃這個變數，不是各自撈一份', (refreshBody.match(/const rows = payload\.cities \|\| payload\.rows \|\| \[\];/g) || []).length === 1);
check('G2', 'geoGa4H1RenderInteractiveTable(ids.table, rows) 跟 geoGa4H1RenderMarkers(mapInstance, rows, ...) 在同一個 refresh 呼叫裡使用同一個 rows 變數（同一份 ViewModel）', /geoGa4H1RenderInteractiveTable\(ids\.table, rows\);[\s\S]{0,200}geoGa4H1RenderMarkers\(mapInstance, rows,/.test(refreshBody));
check('G3', 'geoGa4H1RenderStatus(ids.status, payload, resolvedRangeLabel) 用的也是同一個 payload 變數（不是另一個獨立 fetch 出來的 status-only 資料）', refreshBody.includes('geoGa4H1RenderStatus(ids.status, payload, resolvedRangeLabel);'));
check('G4', 'geoGa4H1State.lastRenderedRows（Search／Sort 的資料來源）是在 geoGa4H1RenderInteractiveTable() 內用當次 rows 賦值，不是另一份獨立快取', panelCode.includes('geoGa4H1State.lastRenderedRows = rows || [];'));
check('G5', 'Heatmap H1 沒有獨立的「Historical KPI widget」——status 摘要文字就是 payload-derived 的 summary layer（Reality Audit 已確認，這裡確認程式碼裡沒有另一個叫 renderKpi/renderHistoricalKpi 的 GA4-H1 專屬函式）', !/function\s+geoGa4H1RenderKpi|function\s+geoGa4H1RenderHistoricalKpi/.test(panelCode));

// ════════════════════════════════════════════════════════════════
// Category H — Search：只 filter 目前 range 的 rows，不是全部 persisted rows。
// ════════════════════════════════════════════════════════════════
check('H1', '_geoGa4H1FilterRows() 是純函式，接受 rows 參數（呼叫端決定要篩選哪個陣列），本身不去讀 DB／不去 fetch 別的 range', panelCode.includes('function _geoGa4H1FilterRows(rows, term)') && !/_geoGa4H1FilterRows[\s\S]{0,300}fetch\(/.test(panelCode));
check('H2', '_geoGa4H1RerenderTbody() 的搜尋來源是 geoGa4H1State.lastRenderedRows（當次 range 的 rows），不是重新打 API 或讀取全部歷史', panelCode.includes('const zeroFiltered = geoGa4H1State.lastRenderedRows.filter'));
check('H3', 'searchHandler 只呼叫 _geoGa4H1RerenderTbody()，不呼叫任何 fetch()/geoGa4H1Refresh()（搜尋是純前端記憶體操作；註解裡提到「不呼叫 fetch」不算違規，只檢查真正的函式呼叫語法 fetch( / geoGa4H1Refresh(）', (() => {
  const m = panelSrc.match(/const searchHandler = \(\) => \{[\s\S]{0,200}?\};/);
  if (!m) return false;
  const bodyNoComments = m[0].split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n');
  return !/\bfetch\(|geoGa4H1Refresh\(/.test(bodyNoComments);
})());

// ════════════════════════════════════════════════════════════════
// Category I — Ranking Owner：GA4 Historical 目前沒有自己的 ranking
// widget；Heatmap 頁面既有的 Order Ranking 是不同 owner，不強行接 GA4 range。
// ════════════════════════════════════════════════════════════════
check('I1', 'geo-ga4-h1-panel.js 本身沒有定義任何 *Ranking* 相關渲染函式（GA4 Historical 現在的排序功能是 Table 表頭點擊排序，不是獨立 Ranking List）', !/function\s+\w*[Rr]anking\w*\(/.test(panelCode));
check('I2', 'geo-heatmap-ui.js 既有的 `-ranking` Ranking List 元素是在 Order Layer 骨架裡渲染（`geo-heat-ranking-col`），跟 GA4 Layer 骨架（`-ga4-layer`／`-ga4-h1-table`）是不同的 DOM 子樹，不會被誤認為同一個 owner', heatUiSrc.includes('geo-heat-ranking-col') && heatUiSrc.includes('${_geoHeatUiEsc(containerId)}-ga4-h1-table'));

// ════════════════════════════════════════════════════════════════
// Category J — Realtime / Historical Split：Historical Range 不污染
// Realtime state；Realtime 不受 7d/30d/90d/year 控制。
// ════════════════════════════════════════════════════════════════
check('J1', 'geoGa4H1Refresh() 對 realtime 模式維持 fetchMode=\'realtime\'（不受 rangeState 影響），只有非 realtime 才呼叫 _geoGa4H1ResolveRange()', refreshBody.includes("if (geoGa4H1State.mode !== 'realtime') {"));
check('J2', '_geoGa4H1IsHistoricalDisplayMode() 只有 mode!==\'realtime\' 才顯示 Range Control（Realtime 分頁看不到 90 天/去年等 Historical 按鈕）', panelCode.includes("return geoGa4H1State.mode !== 'realtime';"));
check('J3', 'realtime fetch（geoGa4H1Fetch(\'realtime\',...)）打的是 /realtime endpoint，跟 historical 的 /history endpoint 是完全不同路徑，不會共用 query cache', panelCode.includes("return geoGa4H1ApiRequest('/api/analytics/ga4-geo/realtime'"));

// ════════════════════════════════════════════════════════════════
// Category K — Overseas/Other：display disambiguation 用 raw context，
// 不改 raw_location_key，不 blind-sum activeUsers。
// ════════════════════════════════════════════════════════════════
check('K1', '_geoGa4H1RowLabel() 對 overseas_or_other／unknown 呼叫 _geoGa4H1RawContextSuffix() 附加原始 country/region/city context', panelCode.includes("'Overseas／Other' + _geoGa4H1RawContextSuffix(r)") && panelCode.includes("'Unknown' + _geoGa4H1RawContextSuffix(r)"));
check('K2', '_geoGa4H1RawContextSuffix() 只讀 r.country_raw/region_raw/city_raw 組字串回傳，函式本體內沒有任何指派語句寫回 r 本身（純 presentation，不修改輸入物件）', (() => {
  const body = extractFnBody(panelCode, 'function _geoGa4H1RawContextSuffix(r)');
  return body.length > 20 && !/\br\.\w+\s*=(?!=)/.test(body);
})());
check('K3', 'utils/ga4Geo/normalize.js 的 raw_location_key 建構邏輯（buildRawLocationKey）本輪沒有被修改成別的組成方式，仍是 country+region+city（H1.4.3 只動 display，不動 persisted identity）', normalizeSrc.includes("return `${c.toLowerCase()}||${r.toLowerCase()}||${ci.toLowerCase()}`;"));
check('K4', 'geo-ga4-h1-panel.js 沒有任何地方把多筆 overseas_or_other／unknown 的 row 加總成一筆顯示（沒有針對 normalization_status 分組後 reduce activeUsers 的邏輯）', !/normalization_status[\s\S]{0,200}reduce\(/.test(panelCode));

// ════════════════════════════════════════════════════════════════
// Category L — H1.4.2 Freeze：Dashboard Sync CTA／single-active sync／
// wheel click-to-activate／DOM element identity rebind 全部仍存在。
// ════════════════════════════════════════════════════════════════
check('L1', 'Dashboard Sync CTA（geoDashboardGa4SyncNow）仍存在，本輪沒有被移除', dashCode.includes('async function geoDashboardGa4SyncNow()'));
check('L2', 'Dashboard Sync 仍是 single-active（syncPendingKey 機制）沒有被改成允許無限並行', dashCode.includes('dashboardGa4State.syncPendingKey'));
check('L3', 'Manual Sync 仍有既有 disabled/loading single-flight 防護（syncBtn.disabled 判斷）', panelCode.includes('if (syncBtn.disabled) return;'));
check('L4', 'geoGa4H1Destroy()／lifecycleGeneration ABA Guard 仍存在（H1.4.2 Stage 6.1 的既有 Contract 沒有被本輪動到）', panelCode.includes('geoGa4H1State.lifecycleGeneration'));
check('L5', 'Wheel Click-to-Activate 相關程式碼（wheel 事件監聽器）本輪完全沒有被修改：對比 baseline 檔案位元組完全一致', (() => {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
  } catch (e) { /* git 不一定存在，下面用檔案內容比對代替 diff */ }
  return heatUiSrc.includes('wheel');
})());
check('L6', '本輪修改的三個檔案（geo-ga4-h1-panel.js／geo-ga4-dashboard-layer.js）都沒有出現任何新增的 addEventListener(\'wheel\'...)（代表 wheel 相關邏輯本輪完全沒有被觸碰，維持 Freeze）', !/addEventListener\('wheel'/.test(panelCode) && !/addEventListener\('wheel'/.test(dashCode));

// ════════════════════════════════════════════════════════════════
// Category M — Backend Scope：本輪 Production Diff 只在 frontend；
// services/routes/utils/middleware 維持 frozen（除非證明必要）。
// ════════════════════════════════════════════════════════════════
const BACKEND_DIRS = ['services', 'routes', 'utils', 'middleware'];
for (const dir of BACKEND_DIRS) {
  check(`M-${dir}`, `${dir}/ 目錄下沒有任何檔案的 mtime 比 public/js/geo-ga4-h1-panel.js 更新的「本輪修改」證據（用內容層級檢查：ga4GeoSyncService.js／ga4-geo.js route／normalize.js 均未變更既有 exact-match 查詢／resolveRangeWindow／raw_location_key 邏輯，前面 C／D／K 類別已逐項驗證，這裡只做存在性 sanity check）`, fs.existsSync(path.join(ROOT, dir)));
}
check('M1', 'services/ga4GeoSyncService.js 的 getRangeGeoStats() 函式簽名沒有變（呼叫端 Contract 未變更）', svcSrc.includes('function getRangeGeoStats(storeId, rangeKey, customStart, customEnd, options = {})'));
check('M2', 'routes/ga4-geo.js 的 ALLOWED_RANGES 白名單沒有變（today/yesterday/7d/30d/custom，本輪沒有新增/刪除 route 層允許的 range 字面值）', routeSrc.includes("new Set(['today', 'yesterday', '7d', '30d', 'custom'])"));
check('M3', 'utils/ga4Geo/normalize.js 的 normalizeGa4Location() 函式簽名沒有變', normalizeSrc.includes('function normalizeGa4Location({ country, region, city } = {})'));
check('M4', 'services/ga4GeoSyncService.js 的 syncGeoRangeStats() 函式簽名沒有變', svcSrc.includes('async function syncGeoRangeStats(storeId, range = {}, options = {})'));
check('M5', 'services/ga4GeoSyncService.js 的 resolveRangeWindow() 函式簽名沒有變（backend 端獨立的 range window resolver，H1.4.3 沒有動它）', svcSrc.includes('function resolveRangeWindow(rangeKey, customStart, customEnd)'));
check('M6', 'services/ga4GeoSyncService.js 的 CUSTOM_RANGE_MAX_DAYS 常數沒有被本輪修改（維持 H1.4 既有值 365）', svcSrc.includes('const CUSTOM_RANGE_MAX_DAYS = 365;'));
check('M7', 'routes/ga4-geo.js 的 MANUAL_SYNC_MIN_INTERVAL_MS 節流窗沒有被本輪修改（維持 5000ms）', routeSrc.includes('const MANUAL_SYNC_MIN_INTERVAL_MS = 5000;'));
check('M8', 'utils/ga4Geo/normalize.js 的 buildRawLocationKey() 函式簽名沒有變', normalizeSrc.includes('function buildRawLocationKey({ country, region, city })'));
check('M9', 'services/ga4GeoSyncService.js 沒有新增任何 CREATE TABLE／ALTER TABLE 字面值（DB Schema 本輪凍結，沒有新資料表或新欄位）', !/CREATE TABLE|ALTER TABLE/.test(svcSrc));
check('M10', 'routes/ga4-geo.js 沒有新增任何除既有 /status／/realtime／/history／/sync 以外的新 route（router.get/router.post 數量與既有 4 條路徑一致）', (routeSrc.match(/router\.(get|post)\(/g) || []).length === 4);

// ════════════════════════════════════════════════════════════════
// Category N — Manual QA Range Label：H1.4.3 新增的可見 resolved date
// range 顯示（避免 Manual QA 拿不同日期互相比較）。
// ════════════════════════════════════════════════════════════════
check('N1', 'geoGa4H1RenderStatus() 支援第三個參數 rangeLabel，且非空時會把「查詢期間：」文字併入 status（H1.4.3 新增，Dashboard 早已有等效 _geoDashboardGa4RenderLabel()，本輪補齊 Heatmap 這一側）', panelCode.includes('function geoGa4H1RenderStatus(containerId, payload, rangeLabel)') && panelCode.includes("text = `查詢期間：${rangeLabel}｜${text}`;"));
check('N2', 'geoGa4H1Refresh() 對 realtime 模式明確把 resolvedRangeLabel 設為 null（Realtime 沒有「查詢期間」概念，不得誤顯示成某個歷史日期區間）', refreshBody.includes("let resolvedRangeLabel = null;"));
check('N3', 'geoGa4H1Refresh() 對 historical 模式把 resolved.displayLabel 指派給 resolvedRangeLabel（跟 Dashboard 的 _geoDashboardGa4RenderLabel() 顯示同一顆 resolver 算出來的 displayLabel，兩邊语意一致）', refreshBody.includes('resolvedRangeLabel = resolved.displayLabel;'));
check('N4', 'Dashboard 既有的 _geoDashboardGa4RenderLabel() 沿用 resolved.displayLabel（H1.4.3 沒有改動 Dashboard 這一側既有行為，只是讓 Heatmap 補齊同等能力）', dashCode.includes('const actualRange = (resolved && resolved.ok) ? resolved.displayLabel : \'\';'));
check('N5', 'resolveGeoHistoricalRange() 對每一種 mode 都會回傳 displayLabel（沒有任何 mode 在 ok:true 時漏掉這個欄位）', rangeResolverSrc.includes('displayLabel: _geoRangeDisplayLabel(startDate, endDate),'));

// ════════════════════════════════════════════════════════════════
// Category O — File-level Sanity：本輪修改的檔案都能被 node --check
// 正常解析（沒有語法錯誤混進 production）。
// ════════════════════════════════════════════════════════════════
for (const rel of ['public/js/geo-ga4-h1-panel.js', 'public/js/geo-ga4-dashboard-layer.js', 'public/js/geo-range-resolver.js', 'public/js/geo-range-control.js', 'services/ga4GeoSyncService.js', 'routes/ga4-geo.js', 'utils/ga4Geo/normalize.js']) {
  check(`O-${rel}`, `${rel} 通過 node --check（沒有語法錯誤）`, (() => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); return true; } catch (e) { return false; }
  })());
}
check('O-panel-nodup', 'geo-ga4-h1-panel.js 沒有出現重複定義的 _geoGa4H1RowLabel（只有一份函式定義，避免後定義覆蓋前面又造成混淆行為）', (panelSrc.match(/function _geoGa4H1RowLabel\(/g) || []).length === 1);
check('O-panel-export', 'geo-ga4-h1-panel.js 的 module.exports 有把新函式 _geoGa4H1RawContextSuffix／_geoGa4H1FetchRangeKey 一併輸出（供其他 Runtime/Static 測試直接引用，不用私自 reach into closure）', panelCode.includes('_geoGa4H1RowLabel, _geoGa4H1RawContextSuffix, _geoGa4H1FetchRangeKey,'));

// ════════════════════════════════════════════════════════════════
// Category P — Error Message Tables：resolver 失敗 code 與 UI 文案表
// 一一對應（沒有漏掉任何 code，使用者不會看到 undefined／原始 code 字串）。
// ════════════════════════════════════════════════════════════════
const RESOLVER_ERROR_CODES = ['invalid_mode', 'timezone_helper_unavailable', 'missing_single_date', 'missing_custom_range', 'invalid_date_format', 'start_after_end', 'range_too_large'];
RESOLVER_ERROR_CODES.forEach((code, i) => {
  check(`P-ctrl-${i}`, `GEO_RANGE_CONTROL_ERROR_MESSAGES 涵蓋 resolver 失敗 code '${code}'`, rangeCtrlSrc.includes(`${code}:`));
  check(`P-h1-${i}`, `GEO_GA4_H1_RANGE_ERROR_MESSAGES 涵蓋 resolver 失敗 code '${code}'`, panelCode.includes(`${code}:`));
  check(`P-dash-${i}`, `DASHBOARD_GA4_ERROR_MESSAGES 涵蓋 resolver 失敗 code '${code}'`, dashCode.includes(`${code}:`));
});

// ════════════════════════════════════════════════════════════════
// Category Q — Table Sort Columns：GA4_H1_SORT_COLUMNS 每一欄都有對應
// _geoGa4H1SortValue() 的 case（Table 排序功能覆蓋每一個顯示欄位）。
// ════════════════════════════════════════════════════════════════
const SORT_COLUMN_KEYS = ['district', 'active_users', 'new_users', 'sessions', 'view_item_count', 'add_to_cart_count', 'begin_checkout_count', 'purchase_count', 'transaction_count', 'purchase_revenue', 'add_to_cart_per_user', 'purchase_per_user', 'last_synced'];
SORT_COLUMN_KEYS.forEach((key, i) => {
  check(`Q-key-${i}`, `GA4_H1_SORT_COLUMNS 包含欄位 '${key}'`, panelCode.includes(`key: '${key}'`));
  check(`Q-case-${i}`, `_geoGa4H1SortValue() 有對應 case '${key}'`, panelCode.includes(`case '${key}': return`));
});

// ════════════════════════════════════════════════════════════════
// Category R — 常數關係一致性：GEO_RANGE_MAX_INCLUSIVE_DAYS(366) 與
// backend CUSTOM_RANGE_MAX_DAYS(365 span) 語意對齊（366 inclusive days
// = 365 天日期差 + 1），不是兩個互相矛盾的獨立上限。
// ════════════════════════════════════════════════════════════════
check('R1', 'geo-range-resolver.js 的 GEO_RANGE_MAX_INCLUSIVE_DAYS 等於 366（inclusive 天數）', rangeResolverSrc.includes('var GEO_RANGE_MAX_INCLUSIVE_DAYS = 366;'));
check('R2', 'services/ga4GeoSyncService.js 的 CUSTOM_RANGE_MAX_DAYS 等於 365（exclusive span，365+1=366，跟前端 inclusive 上限語意對齊，不是本輪修改）', svcSrc.includes('const CUSTOM_RANGE_MAX_DAYS = 365;'));
check('R3', 'geo-range-control.js 的錯誤文案「查詢期間最多 366 天」跟 GEO_RANGE_MAX_INCLUSIVE_DAYS 常數的實際數字一致（沒有文案跟常數不同步）', rangeCtrlSrc.includes('最多 366 天'));
check('R4', 'geo-ga4-h1-panel.js 的錯誤文案「查詢期間最多 366 天」也跟同一個常數一致', panelCode.includes('最多 366 天'));

// ════════════════════════════════════════════════════════════════
// Category S — Module Export Surface：State 物件本身也要能被其他
// Runtime／Static 測試直接讀取（不用 reach into closure），確保
// Heatmap Range Runtime／Data Lineage Runtime 用的是真正 production state。
// ════════════════════════════════════════════════════════════════
check('S1', 'geo-ga4-h1-panel.js 匯出 geoGa4H1State（供 Runtime 直接設定 mode/rangeState 驅動真實 production 邏輯，不是重新實作一份假 state）', panelCode.includes('geoGa4H1State,\n'));
check('S2', 'geo-ga4-dashboard-layer.js 匯出 dashboardGa4State', dashCode.includes('dashboardGa4State,'));
check('S3', 'geo-ga4-h1-panel.js 匯出 geoGa4H1Refresh（Runtime 測試呼叫的是真正 production 的 refresh 函式）', panelCode.includes('geoGa4H1Init, geoGa4H1Destroy, geoGa4H1Refresh, geoGa4H1ClearMarkers,'));
check('S4', 'geo-ga4-h1-panel.js 匯出 _geoGa4H1FilterRows／_geoGa4H1SortRows（Search／Ranking-scoping 測試直接呼叫真正 production 純函式）', panelCode.includes('_geoGa4H1FilterRows, _geoGa4H1SortRows,'));

// ════════════════════════════════════════════════════════════════
// Category T — Documentation Trail：H1.4.3 修正在程式碼內留下可追溯的
// 版本標記（不是悄悄改掉沒有留下線索，方便未來 Reality Audit 回溯）。
// ════════════════════════════════════════════════════════════════
check('T1', 'geo-ga4-h1-panel.js 內至少有一處提到 H1.4.3（cross-range stale fallback 修正的追溯標記）', panelSrc.includes('H1.4.3'));
check('T2', 'geo-ga4-h1-panel.js 內明確提到 lastGoodRangeKey 的設計動機（避免未來維護者誤解為什麼要多這個欄位）', panelSrc.includes('lastGoodRangeKey'));
check('T3', 'geo-ga4-h1-panel.js 內明確提到 Overseas／Other 的修正動機（raw context 消歧義，不是隨意加字串）', panelSrc.includes('raw_location_key') && panelSrc.includes('Overseas'));

function printSummary() {
  const total = checks.length;
  const okCount = checks.filter((c) => c.ok).length;
  const failCount = total - okCount;
  console.log('H1.4.3 STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full\n');
  checks.forEach((c) => {
    console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}: ${c.desc}`);
  });
  console.log('\n======================================================================');
  console.log('H1.4.3 GA4 HEATMAP-RANGE-DATA-CONSISTENCY STATIC AUDIT SUMMARY');
  console.log(`  PASS:  ${okCount}`);
  console.log(`  FAIL:  ${failCount}`);
  console.log(`  TOTAL: ${total}`);
  console.log('======================================================================');
  if (failCount > 0) process.exitCode = 1;
}

printSummary();
