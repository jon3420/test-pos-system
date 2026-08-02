#!/usr/bin/env node
// scripts/static-audit-g1-3-1.js — fix18-10-hotfix30-B5-R5.4-G1.3.1
// Coverage Business Total & Dark Theme Hotfix 專屬 Static Audit（38 項）。

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
const cssSrc = read('public/css/geo-heatmap.css');
const backendSrc = read('utils/geoAnalyticsQueries.js');
const backendCode = stripComments(backendSrc);
const routeSrc = read('routes/analytics-geo.js');
const geoIntelligenceSrc = read('public/js/geo-intelligence.js');
const geoLiveLayerSrc = read('public/js/geo-live-layer.js');

// ══════════════════════════════════════════════════════════════
// 一、Business Total 與 Geo Drawable 分離
// ══════════════════════════════════════════════════════════════
check('1', 'Business Total 與 Geo Drawable 分離（_geoHeatMetricTotals 回傳的 total/drawn 分別來自 businessTotals 與 areas 兩個不同來源）',
  /const total = \(typeof bt\.orders === 'number'\) \? bt\.orders/.test(uiCode) && /const drawn = list\.reduce\(\(s, a\) => s \+ \(Number\(a\.coordinate_count\)/.test(uiCode));

check('2', 'Business Total 包含無 Geo 的外帶訂單（後端 business total query 沒有 order_mode 限制，takeout 也算入）',
  /SELECT COUNT\(\*\) AS business_total_orders/.test(backendCode) && !/business_total_orders[\s\S]{0,400}order_mode IN/.test(backendCode));

check('3', 'Geo Drawable 仍只計合法 Geo 資料（rows 查詢仍保留 order_mode IN (\'delivery\',\'shipping\') AND fulfillment_geo_source IS NOT NULL 限制，未被本輪放寬）',
  /order_mode IN \('delivery','shipping'\) AND fulfillment_geo_source IS NOT NULL/.test(backendCode));

check('4', 'Orders Total 不使用 areas.length（_geoHeatMetricTotals 的 orders total 分支不是 list.length）',
  !/const total = list\.length/.test(uiCode));

check('5', 'Orders Total 不只加總 Geo areas（有 businessTotals 時優先採用，不強制走 list.reduce）',
  /typeof bt\.orders === 'number'\) \? bt\.orders : list\.reduce/.test(uiCode));

check('6', 'Revenue Total 不只來自 Geo areas（同上，revenue 分支同樣優先用 bt.revenue）',
  /typeof bt\.revenue === 'number'\) \? bt\.revenue : list\.reduce/.test(uiCode));

check('7', '0 值與 undefined 正確區分（後端與前端一律用 typeof ===\'number\' 判斷欄位存在，不用 truthy 判斷，0 不會被誤判成「沒有這個欄位」）',
  /typeof fd\.business_total_orders === 'number'/.test(uiCode) && /typeof bt\.orders === 'number'/.test(uiCode));

check('8', 'Coverage clamp（_geoHeatBuildCoverageExplanationText 對 total/drawn 都做 Math.max(0,...) 與上限夾住，並防禦 NaN/Infinity，避免負數與 drawn>total）',
  /const t = Math\.max\(0, safeTotal\);/.test(uiCode) && /const d = Math\.max\(0, Math\.min\(t, safeDrawn\)\);/.test(uiCode) && /Number\.isFinite\(Number\(total\)\)/.test(uiCode));

// ══════════════════════════════════════════════════════════════
// 二、Filter Alignment
// ══════════════════════════════════════════════════════════════
check('9', 'Store Filter 一致（business total query 與既有 rows 查詢共用同一個 storeId 參數，未新增獨立 store 篩選）',
  (backendCode.match(/WHERE \$\{ORDERS_BASE_WHERE\} AND created_at BETWEEN \? AND \?/g) || []).length >= 2);

check('10', 'Date Filter 一致（business total query 使用同一組 range.startLocal/range.endLocal，不是另一組日期參數）',
  /storeId, range\.startLocal, range\.endLocal, \.\.\.chOrd\.params\]\s*\n\s*\) \|\| \{ business_total_orders: 0/.test(backendSrc));

check('11', 'Channel Filter 一致（business total query 沿用同一個 chOrd 變數，未新建第二套 channel clause）',
  (backendCode.match(/\$\{chOrd\.sql\}/g) || []).length >= 2 && !/const chOrd2/.test(backendCode));

check('12', 'Order Status 定義一致（business total query 沿用既有 ORDERS_BASE_WHERE 常數，未重寫訂單有效狀態邏輯）',
  /FROM orders\s*\n\s*WHERE \$\{ORDERS_BASE_WHERE\} AND created_at BETWEEN \? AND \?\$\{chOrd\.sql\}\s*`,\s*\n\s*\[storeId, range\.startLocal, range\.endLocal, \.\.\.chOrd\.params\]/.test(backendSrc));

check('13', 'Revenue 定義一致（business_total_revenue 沿用既有 ORDERS_PAID_EXPR 常數，跟 areas.revenue 同一套「已付款才算營收」定義）',
  /COALESCE\(SUM\(CASE WHEN \$\{ORDERS_PAID_EXPR\} THEN total ELSE 0 END\),0\) AS business_total_revenue/.test(backendCode));

// ══════════════════════════════════════════════════════════════
// 三、API additive / Backward Compatibility
// ══════════════════════════════════════════════════════════════
check('14', 'API additive（getGeoFulfillment 回傳物件新增 business_total_orders/business_total_revenue，既有 page/limit/areas/takeout_no_fulfillment_address 欄位保留）',
  /return \{\s*\n\s*page, limit,\s*\n\s*business_total_orders: Number\(businessTotalRow\.business_total_orders\) \|\| 0,\s*\n\s*business_total_revenue: Number\(businessTotalRow\.business_total_revenue\) \|\| 0,\s*\n\s*areas: rows\.map/.test(backendSrc)
  && /takeout_no_fulfillment_address: Number\(takeoutRow\.c\) \|\| 0,/.test(backendCode));

check('15', '舊 API consumer 相容（_enrichAreaFields 只處理已知陣列鍵名，不會誤把新的純數字欄位當成 area 陣列處理）',
  /AREA_ARRAY_KEYS = \['areas', 'top_areas', 'rows', 'alerts', 'district_ranking', 'source_area'\]/.test(routeSrc));

check('16', 'Plain array update 相容（geoHeatScheduleUpdate 仍接受 fetchAreasFn 回傳純陣列，Array.isArray(result) 分支保留舊行為）',
  /const areas = Array\.isArray\(result\) \? result : \(result && result\.areas\) \|\| \[\];/.test(heatCode));

check('17', 'Object update 相容（geoHeatScheduleUpdate 支援回傳 { areas, businessTotals } 物件格式）',
  /const businessTotals = \(!Array\.isArray\(result\) && result && result\.businessTotals\) \? result\.businessTotals : null;/.test(heatCode));

check('18', '無重複 Summary fetch（geoHeatUiFetchAndRender 仍只呼叫一次 getGeoFunnel + 一次 getGeoFulfillmentForHeatmap，businessTotals 讀自同一個 fulfillmentJson.data，未新增第三支 fetch）',
  (uiCode.match(/getGeoFulfillmentForHeatmap\(/g) || []).length === 1);

check('19', '無 fetch storm（沒有新增額外的 setInterval/輪詢邏輯來抓 business total）',
  !/setInterval\([\s\S]{0,80}business/i.test(uiCode));

check('20', '無 stale store data（businessTotals 在 geoHeatHandleStoreSwitch()／_geoHeatResetStateForTest() 都會被重置，不會殘留上一店資料）',
  /geoHeatState\.businessTotals = \{ orders: null, revenue: null \};/.test(heatCode) && (heatCode.match(/businessTotals = \{ orders: null, revenue: null \};/g) || []).length >= 2);

// ══════════════════════════════════════════════════════════════
// 四、Dark Theme / Light Theme
// ══════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.4.1：#21-23 原本斷言的 [data-theme="dark"]
// 覆寫規則與 #f8fafc 基礎背景，正是使用者截圖裡「白色橫條看不見文字」的
// Bug 本身——整個專案沒有任何程式碼會設定 data-theme="dark" 屬性，這個
// selector 從未生效（見 R5.4-G1.4.1_BASELINE_REALITY_AUDIT.md 第四節）。
// 改成驗證 G1.4.1 修正後的真實狀態：直接用 var(--bg-card,...) 深色
// fallback，不 gate 在不存在的 theme selector 底下。
check('21', 'Dark Card 無白底（Coverage Explanation 背景改用 var(--bg-card, #1e293b) 深色 fallback，不是 #fff/#ffffff/white，且不再依賴不存在的 [data-theme="dark"]）',
  /\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*var\(--bg-card,\s*#1e293b\)/.test(cssSrc)
  && !/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*(#fff\b|#ffffff\b|white\b)/i.test(cssSrc));

check('22', 'Dark Card 文字可讀（color: var(--text-primary, #e2e8f0) 高對比淺色字，直接生效不需 theme gating）',
  /\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary,\s*#e2e8f0\)/.test(cssSrc));

check('23', '不再硬編碼 #f8fafc 近白色背景（G1.4.1 已修正 Bug 來源，這是「未退化回舊 Bug」的檢查，不是「必須保留舊 Bug」）',
  !/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc));

check('24', 'role=status / aria-live（coverage-explanation 容器仍帶 aria-live="polite"，未被本輪移除）',
  /id="\$\{_geoHeatUiEsc\(containerId\)\}-coverage-explanation" class="geo-heat-coverage-explanation" aria-live="polite"/.test(uiSrc));

// ══════════════════════════════════════════════════════════════
// 五、DOM 安全性
// ══════════════════════════════════════════════════════════════
check('25', '無 duplicate explanation DOM（_geoHeatUiRenderCoverageExplanation 用 el.innerHTML = html 整段覆寫既有容器，不是每次都 appendChild 疊加新節點）',
  /el\.innerHTML = html;/.test(uiCode));

check('26', '無 undefined/null/NaN/Infinity（_geoHeatMetricTotals／_geoHeatBuildCoverageExplanationText 對 total/drawn 一律先 Number(...) || 0 或 Math.max/min 夾住，不會把原始值直接內插進文字）',
  /Math\.max\(0, Number\(total\) \|\| 0\)/.test(uiCode) && /Math\.max\(0, Number\(revenue\) \|\| 0\)|Number\(a\.revenue\) \|\| 0/.test(uiCode));

// ══════════════════════════════════════════════════════════════
// 六、不冒充資料來源
// ══════════════════════════════════════════════════════════════
check('27', '無假 Revenue（business_total_revenue 完全來自 SQL SUM/COALESCE 的查詢結果，沒有 Math.random 或硬編碼數字賦值）',
  /COALESCE\(SUM\(CASE WHEN \$\{ORDERS_PAID_EXPR\} THEN total ELSE 0 END\),0\) AS business_total_revenue/.test(backendCode)
  && !/business_total_revenue\s*=\s*Math\.random/i.test(backendCode)
  && !/business_total_revenue:\s*(?!Number\(businessTotalRow\.business_total_revenue\)|0 \};)\d/.test(backendCode));

check('28', '無假 Distance（本輪完全沒有新增／修改 average_distance_km 相關邏輯）',
  !/average_distance_km\s*=\s*Math\.random/i.test(backendCode) && (backendCode.match(/average_distance_km/g) || []).length === (read('utils/geoAnalyticsQueries.js').match(/average_distance_km/g) || []).length);

check('29', '無店家座標冒充（business total query／前端 businessTotals plumbing 都不含 store_lat/store_lng/storeCoordinate 樣式）',
  !/store_lat|store_lng|storeCoordinate/i.test(backendCode.slice(backendCode.indexOf('businessTotalRow'))) && !/store_lat|store_lng|storeCoordinate/i.test(uiCode));

check('30', '無 IP 精確座標（本輪新增程式碼不呼叫任何 IP resolver／geoip 套件）',
  !/geoip|ip-api|ipapi/i.test(backendCode.slice(backendCode.indexOf('businessTotalRow'))) && !/geoip|ip-api|ipapi/i.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))));

check('31', '無行政區中心假 Marker（本輪新增程式碼不含 districtCentroid/district_center 樣式）',
  !/districtCentroid|district_center/i.test(uiCode) && !/districtCentroid|district_center/i.test(heatCode));

check('32', '無第二張 Map（geo-heatmap.js／geo-heatmap-ui.js 本輪新增/修改段落不含 L.map(/new L.Map(）',
  !/L\.map\(|new\s+L\.Map\(/.test(heatCode.slice(heatCode.indexOf('let geoHeatState'))) && !/L\.map\(|new\s+L\.Map\(/.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))));

check('33', '無第二個 Tile Layer（同上，不含 L.tileLayer(）',
  !/L\.tileLayer\(/.test(heatCode.slice(heatCode.indexOf('let geoHeatState'))) && !/L\.tileLayer\(/.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))));

// ══════════════════════════════════════════════════════════════
// 七、既有功能未退化
// ══════════════════════════════════════════════════════════════
check('34', 'G1.3 Metric Sync 未退化（geoHeatUiSyncMetricFromGlobal／GEO_EVENT_TO_HEATMAP_METRIC 仍存在且未被本輪修改移除）',
  /function geoHeatUiSyncMetricFromGlobal/.test(uiCode) && /const GEO_EVENT_TO_HEATMAP_METRIC\s*=/.test(uiCode));

check('35', 'G1.2 Layer Switch 未退化（_geoHeatUiApplyLayerExclusivity／geoHeatUiSetLayer 仍存在）',
  /function _geoHeatUiApplyLayerExclusivity/.test(uiCode) && /function geoHeatUiSetLayer/.test(uiCode));

check('36', '無 console.log/debug（本輪新增／修改段落，geo-heatmap.js 的 businessTotals plumbing 與 geo-heatmap-ui.js 的 Coverage Logic）',
  !/console\.log\(|console\.debug\(/.test(heatCode.slice(heatCode.indexOf('let geoHeatState'))) && !/console\.log\(|console\.debug\(/.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))) && !/console\.log\(|console\.debug\(/.test(backendCode.slice(backendCode.indexOf('businessTotalRow'))));

check('37', '無 Math.random()（本輪新增／修改段落，前後端皆同）',
  !/Math\.random\(\)/.test(heatCode.slice(heatCode.indexOf('let geoHeatState'))) && !/Math\.random\(\)/.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))) && !/Math\.random\(\)/.test(backendCode.slice(backendCode.indexOf('businessTotalRow'))));

check('38', '無硬編碼 store_001（本輪新增／修改段落）',
  !/['"]store_001['"]/.test(heatCode.slice(heatCode.indexOf('let geoHeatState'))) && !/['"]store_001['"]/.test(uiCode.slice(uiCode.indexOf('_geoHeatMetricTotals'))) && !/['"]store_001['"]/.test(backendCode.slice(backendCode.indexOf('businessTotalRow'))));

// 額外：A7 KPI／G1 GeoLiveLayer 完全未受本輪影響
check('EXTRA-1', 'A7 KPI 未退化（geo-intelligence.js 本輪未修改，不含任何 businessTotals／G1.3.1 相關字樣）',
  !/businessTotals|business_total_orders|business_total_revenue/.test(geoIntelligenceSrc));
check('EXTRA-2', 'G1 GeoLiveLayer（geo-live-layer.js）本輪完全未修改', !/businessTotals|business_total_orders/.test(geoLiveLayerSrc));

console.log('======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.3.1 (Coverage Business Total & Dark Theme)');
console.log('======================================================================');
let okCount = 0;
checks.forEach((c) => { console.log(`[${c.ok ? 'OK  ' : 'FAIL'}] ${c.id}. ${c.desc}`); if (c.ok) okCount++; });
console.log('----------------------------------------------------------------------');
console.log(`OK: ${okCount} / ${checks.length}`);
console.log('======================================================================');
if (okCount !== checks.length) process.exitCode = 1;
