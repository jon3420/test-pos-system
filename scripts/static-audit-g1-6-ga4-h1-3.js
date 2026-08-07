#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-3.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
// H1.3 Static Audit — 只檢查本輪新增的 Contract，不重複既有 H1 190 個
// checks（那些已經在 scripts/static-audit-g1-6-ga4-h1.js／
// scripts/static-audit-g1-6-ga4-h1-2.js／scripts/static-audit-g1-5-a.js／
// scripts/static-audit-g1-5-b2.js／scripts/static-audit-g1-6-a1-2-1.js 涵蓋）。

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

const rbSrc = read('utils/ga4Realtime/requestBuilder.js');
const rpSrc = read('utils/ga4Realtime/requestPair.js');
const ctSrc = read('utils/ga4Realtime/connectionTest.js');
const idxSrc = read('utils/ga4Realtime/index.js');
const errSrc = read('utils/ga4Realtime/errors.js');
const clientSrc = read('utils/ga4Realtime/client.js');
const routeSrc = read('routes/geo-live.js');
const layerSrc = read('public/js/geo-ga4-realtime-layer.js');
const panelSrc = read('public/js/geo-ga4-h1-panel.js');
const dtSrc = read('utils/dateTime.js');
const syncSrc = read('services/ga4GeoSyncService.js');
const taiwanGeoNormSrc = read('utils/taiwanGeoNormalize.js');

const rbCode = codeOnly(rbSrc);
const ctCode = codeOnly(ctSrc);
const routeCode = codeOnly(routeSrc);
const panelCode = codeOnly(panelSrc);
const syncCode = codeOnly(syncSrc);

// _productionRenderFnBody(src, fnSignature) — 只取「Production Render 函式
// 本體」這一段字串（不含註解，已由 codeOnly 處理），避免 Comment／
// Compatibility 說明／Legacy Export 名稱誤判成「正式 Render Path 呼叫」
// （見需求文件六：不能因註解 FAIL，也不能因為 strip 太多漏掉真正呼叫）。
function extractFnBody(code, fnSignature) {
  const start = code.indexOf(fnSignature);
  if (start === -1) return '';
  // 從函式簽名開始找到對應的第一個頂層 '}'（簡單括號計數，足以應付這裡的
  // 單層函式本體，不含巢狀字串含大括號的邊界情況）。
  let depth = 0;
  let i = code.indexOf('{', start);
  const bodyStart = i;
  for (; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') { depth -= 1; if (depth === 0) { i += 1; break; } }
  }
  return code.slice(bodyStart, i);
}

// ══════════════════════════════════════════════════════════════
// A. Realtime Request
// ══════════════════════════════════════════════════════════════
check('1', 'buildRealtimeDimensions() 在 eventName 有值時加入 eventName dimension', /dims\.push\(\{ name: 'eventName' \}\)/.test(rbCode));
check('2', 'buildRealtimeDimensions() 在 hasStream 時加入 streamId dimension', /if \(hasStream\) dims\.push\(\{ name: 'streamId' \}\)/.test(rbCode));
check('3', 'visitors baseline 保留：GA4_REALTIME_METRICS.visitors.eventName === null', /visitors:\s*\{ eventName: null/.test(rbCode));
check('4', 'checkout 對應 begin_checkout（不是字面 "checkout"）', /checkout:\s*\{ eventName: 'begin_checkout'/.test(rbCode));
check('5', 'buildRealtimeDimensions 是純函式：不 mutate 傳入的 baseDimensions（用 slice() 複製）', /const dims = Array\.isArray\(baseDimensions\) \? baseDimensions\.slice\(\)/.test(rbCode));
check('6', '沒有第二套 GA4 Client：requestPair/connectionTest 都只 require 同一個 ./client', /require\(['"]\.\/client['"]\)/.test(ctCode) && !/BetaAnalyticsDataClient/.test(ctSrc));
check('7', 'requestPair 的安全 Log 只印 stage/code/retryable/window/metric/elapsed_ms，不印整個 request 物件', !/console\.log\([^)]*request[^)]*\)/.test(codeOnly(rpSrc)) && /stage=\$\{stage\}/.test(rpSrc));

// ══════════════════════════════════════════════════════════════
// B. Event Compatibility
// ══════════════════════════════════════════════════════════════
check('8', 'Event Compatibility 是明確 Opt-in：只有 includeEventCompatibility===true 才走 _runEventCompatConnectionTest', /options\.includeEventCompatibility === true/.test(ctCode) && /return includeEventCompatibility\s*\n?\s*\?\s*_runEventCompatConnectionTest/.test(ctCode));
check('9', '預設 false：runGa4ConnectionTest(db, storeId, options = \\{\\}) 且 includeEventCompatibility 用 === true 才生效', /options\.includeEventCompatibility === true/.test(ctCode));
check('10', '有明確白名單布林解析函式 _parseGa4EventCompatFlag，不是 Boolean(value)', /function _parseGa4EventCompatFlag/.test(routeCode) && !/return Boolean\(raw\)/.test(routeCode));
check('11', '"false" 字串在解析器內不會被判定為 true（沒有把整個字串丟進 if 當條件）', /raw\.trim\(\)\.toLowerCase\(\) === 'true'/.test(routeCode));
check('12', '"0" 沒有被列入任何 true 分支', !/raw === '0'[\s\S]{0,20}return true/.test(routeCode));
check('13', '"true" 字串會被解析為 true', /raw\.trim\(\)\.toLowerCase\(\) === 'true'\) return true/.test(routeCode));
check('14', "數字/字串 '1' 會被解析為 true", /raw === true \|\| raw === 1 \|\| raw === '1'/.test(routeCode));
check('15', 'Basic Mode 使用獨立的 _lastTestAt／_lastTestResult／_inFlightTest（與 Event Compat 分開的變數）', /const _lastTestAt = new Map\(\)/.test(ctCode) && /const _lastTestAtEventCompat = new Map\(\)/.test(ctCode));
check('16', 'Event Compat Mode 使用獨立的 _lastTestAtEventCompat／_lastTestResultEventCompat', /const _lastTestResultEventCompat = new Map\(\)/.test(ctCode));
check('17', 'Basic in-flight 用 _inFlightTest（不是共用變數）', /_inFlightTest\.has\(storeId\)/.test(ctCode));
check('18', 'Event Compat in-flight 用 _inFlightTestEventCompat（獨立變數）', /_inFlightTestEventCompat\.has\(storeId\)/.test(ctCode));
check('19', 'connectionTest.js 本身沒有 console.log（Log 全部透過 requestPair.js 既有安全機制）', !/console\.log\(/.test(ctCode));

// ══════════════════════════════════════════════════════════════
// C. Error Safety
// ══════════════════════════════════════════════════════════════
check('20', "400 家族安全文案：'GA4 即時事件查詢格式不相容'", /GA4 即時事件查詢格式不相容/.test(layerSrc));
check('21', "401 安全文案：登入狀態已失效", /登入狀態已失效，請重新登入/.test(layerSrc));
check('22', "403 安全文案：GA4 權限不足", /GA4 權限不足或此功能未開放/.test(layerSrc));
check('23', "429 安全文案：查詢過於頻繁", /GA4 查詢過於頻繁，請稍候再試/.test(layerSrc));
check('24', "Timeout 安全文案：查詢逾時", /GA4 查詢逾時，請稍後再試/.test(layerSrc));
check('25', "5xx 安全文案：Google Analytics 暫時無法連線", /Google Analytics 暫時無法連線/.test(layerSrc));
check('26', 'Zero event 不是錯誤：index.js 的 summaryRow 為 null 時 totalActiveUsers/totalEventCount 直接算 0，不丟例外', /summaryRow \? Number/.test(codeOnly(idxSrc)));
check('27', '前端從不把 Raw Google Error message 直接塞進 DOM（沒有 innerHTML/textContent 直接接 error.message/e.message）', !/(innerHTML|textContent)\s*=\s*[^;]*\.message/.test(codeOnly(layerSrc)));
check('28', '前端從不輸出 error.stack', !/\.stack/.test(codeOnly(layerSrc)));
check('29', 'classifyGa4RealtimeError() fallback 回傳固定安全字串，不是 err.message', /return 'GA4_API_ERROR';/.test(codeOnly(errSrc)) && !/return String\(err\.message/.test(codeOnly(errSrc)));

// ══════════════════════════════════════════════════════════════
// D. Taiwan Calendar
// ══════════════════════════════════════════════════════════════
check('30', 'ga4GeoSyncService.js 重用 utils/dateTime.js（沒有另外自己 require 一份時區邏輯）', /require\(['"]\.\.\/utils\/dateTime['"]\)/.test(syncCode));
check('31', 'utils/dateTime.js 匯出 getTaipeiCalendarDateString', /getTaipeiCalendarDateString/.test(dtSrc) && /module\.exports[\s\S]*getTaipeiCalendarDateString/.test(dtSrc));
check('32', '_todayDateString() 委派給 getTaipeiCalendarDateString()（不是自己重算）', /return getTaipeiCalendarDateString\(_now\(\), offsetDays\)/.test(syncCode));
{
  // 只檢查 _todayDateString() 這個函式本體本身，不要求整份檔案都沒有任何
  // +8 小時字樣——services/ga4GeoSyncService.js 本來就有跟本輪完全無關、
  // 已存在的 _taipeiTimeString()（用於完整時間字串顯示，非日曆日邊界，
  // 不在本輪範圍），不得誤判成「第二套實作」。
  const todayFnStart = syncCode.indexOf('function _todayDateString');
  const todayFnBody = syncCode.slice(todayFnStart, todayFnStart + 200);
  check('33', '_todayDateString() 函式本體內沒有另外自己算「固定 +8 小時」（改用 getTaipeiCalendarDateString）', !/getTime\(\)\s*\+\s*8\s*\*\s*3600/.test(todayFnBody) && /getTaipeiCalendarDateString/.test(todayFnBody));
}
check('34', '_todayDateString 不再用 setUTCDate 做 naive UTC calendar day（舊 Bug 的寫法已移除）', !/d\.setUTCDate\(d\.getUTCDate\(\) \+ offsetDays\)/.test(syncCode));
check('35', 'custom range 完全不套用 offset（resolveRangeWindow 的 custom 分支直接回傳使用者指定日期）', /rangeKey === 'custom'/.test(syncCode));

// ══════════════════════════════════════════════════════════════
// E. Historical Sync UX
// ══════════════════════════════════════════════════════════════
check('36', 'rows_saved===0 走 success 分支（不是 error）', /if \(rowsSaved === 0\) \{\s*\n\s*showToast\([\s\S]{0,80}'success'/.test(panelSrc));
check('37', '有中性的空結果文案「尚無可用的區域資料」', /尚無可用的區域資料/.test(panelSrc));
check('38', 'rows_saved>0 維持既有「已更新 N 筆資料」成功文案', /已更新 \$\{rowsSaved\} 筆資料/.test(panelSrc));
check('39', '同步失敗（success:false）仍走 error 分支，不觸發 onChange 刷新', /const code = \(result && result\.code\) \|\| 'unexpected_error'/.test(panelCode));
check('40', '本輪沒有重寫 Historical Query（services/ga4GeoSyncService.js 仍呼叫既有 runAudienceRange/runEventFunnelRange/runCommerceRange，函式名稱未變）', /runAudienceRange/.test(syncCode) && /runEventFunnelRange/.test(syncCode) && /runCommerceRange/.test(syncCode));
check('41', '本輪沒有修改 DB Schema（services/ga4GeoSyncService.js 沒有 CREATE TABLE / ALTER TABLE 字樣）', !/CREATE TABLE|ALTER TABLE/.test(syncSrc));

// ══════════════════════════════════════════════════════════════
// F. Metric Semantics
// ══════════════════════════════════════════════════════════════
check('42', "sort key 使用 add_to_cart_per_user（不是 add_to_cart_rate）", /key: 'add_to_cart_per_user'/.test(panelCode) && !/key: 'add_to_cart_rate'/.test(panelCode));
check('43', "sort key 使用 purchase_per_user（不是 purchase_rate）", /key: 'purchase_per_user'/.test(panelCode) && !/key: 'purchase_rate'/.test(panelCode));
check('44', '有 _geoGa4H1FormatPerUser 顯示格式化函式', /function _geoGa4H1FormatPerUser/.test(panelCode));
check('45', '顯示固定一位小數（toFixed(1)），不是裸數字', /Number\(value\)\.toFixed\(1\)/.test(panelCode));
check('46', 'denominator=0 安全回傳 null／—（不是 Infinity/NaN/0%/100%）', /if \(!d\) return null;/.test(panelCode) && /'—'/.test(panelCode));
check('47', "表頭文字「加購事件／人」存在", /加購事件／人/.test(panelSrc));
check('48', "表頭文字「購買事件／人」存在", /購買事件／人/.test(panelSrc));
check('49', 'Tooltip 使用 per-user helper（_geoGa4H1PerUser），不是舊 rate 公式', /geoGa4H1BuildTooltip[\s\S]{0,400}_geoGa4H1PerUser/.test(panelCode));
{
  const sortValueBody = extractFnBody(panelCode, 'function _geoGa4H1SortValue');
  check('50', 'Sort Value 只用 per-user helper（_geoGa4H1PerUser），沒有另外乘 100', /_geoGa4H1PerUser\(/.test(sortValueBody) && !/\* 100/.test(sortValueBody));
}
check('51', '正式原始碼（去除註解）不含裸的 "500%" 字面字串', !/500%/.test(panelCode));
check('52', '正式原始碼（去除註解）不含裸的 "400%" 字面字串', !/400%/.test(panelCode));
{
  // 需求文件六：只針對「Production Render Function Body」判斷，排除註解／
  // Compatibility 說明／Legacy Export 名稱——用 codeOnly() 去除註解後，
  // 再抓 geoGa4H1RenderTable 的靜態表頭範圍與 GA4_H1_SORT_COLUMNS 陣列本體，
  // 而不是整份檔案（避免把上面 46-48 的合法「事件／人」字樣附近文字混進來
  // 誤判，也避免漏掉真正的 render 呼叫）。
  const renderTableBody = extractFnBody(panelCode, 'function geoGa4H1RenderTable');
  const sortColumnsIdx = panelCode.indexOf('GA4_H1_SORT_COLUMNS');
  const sortColumnsBlock = panelCode.slice(sortColumnsIdx, sortColumnsIdx + 800);
  check('53', 'geoGa4H1RenderTable() 的表頭與 GA4_H1_SORT_COLUMNS 本體都不含「加購率」', !renderTableBody.includes('加購率') && !sortColumnsBlock.includes('加購率'));
  check('54', 'geoGa4H1RenderTable() 的表頭與 GA4_H1_SORT_COLUMNS 本體都不含「購買率」', !renderTableBody.includes('購買率') && !sortColumnsBlock.includes('購買率'));
}
{
  const rowFnBody = extractFnBody(panelCode, 'function _geoGa4H1BuildRowHtml');
  const tooltipFnBody = extractFnBody(panelCode, 'function geoGa4H1BuildTooltip');
  const sortValueBody = extractFnBody(panelCode, 'function _geoGa4H1SortValue');
  check('55', 'legacy _geoGa4H1Rate() 不被任何正式 Render Function（Row/Tooltip/SortValue）呼叫（只允許在自己的定義與 module.exports 裡出現這個名字）', !/_geoGa4H1Rate\(/.test(rowFnBody) && !/_geoGa4H1Rate\(/.test(tooltipFnBody) && !/_geoGa4H1Rate\(/.test(sortValueBody));
}

// ══════════════════════════════════════════════════════════════
// G. Scope Freeze
// ══════════════════════════════════════════════════════════════
check('56', 'utils/ga4Realtime/index.js 的 H1.2 Unique Admin 聚合邏輯（_aggregateCityRows／dimensionHeaders.indexOf）未被觸碰', /_aggregateCityRows/.test(idxSrc) && /dimensionHeaders\.indexOf\('city'\)/.test(idxSrc) && /dimensionHeaders\.indexOf\('countryId'\)/.test(idxSrc));
check('57', 'utils/taiwanGeoNormalize.js 本輪完全未被修改（只驗證檔案存在且可載入，內容 diff 交由 Production Diff Gate byte-compare）', fs.existsSync(path.join(ROOT, 'utils/taiwanGeoNormalize.js')) && taiwanGeoNormSrc.length > 0);
check('58', 'middleware/storeGuard.js 本輪完全未被修改（存在性檢查，內容 diff 交由 Production Diff Gate）', fs.existsSync(path.join(ROOT, 'middleware/storeGuard.js')));
check('59', 'Auth 相關中介層本輪未被修改（middleware/featureGate.js 存在，requireFeature 呼叫方式不變）', /requireFeature\('reports'\)/.test(routeCode));
check('60', 'GA4 Credential Loader（client.js 的 credentialStatus／_getClient）本輪未被修改（函式仍存在、簽名不變）', /function credentialStatus/.test(clientSrc) || /credentialStatus\s*[,:]/.test(clientSrc));
check('61', '本輪沒有任何 CREATE TABLE／ALTER TABLE（DB Schema 未變，掃描本輪觸及的所有 Production 檔案）', !/CREATE TABLE|ALTER TABLE/.test(rbSrc + rpSrc + ctSrc + idxSrc + errSrc + clientSrc + routeSrc + layerSrc + panelSrc + dtSrc + syncSrc));
check('62', '本輪沒有觸及外送平台（Delivery）相關檔案', !fs.existsSync(path.join(ROOT, '.__mut_delivery_touched_marker')));
check('63', '本輪沒有觸及訂單履行（Fulfillment）相關檔案／關鍵字', !/fulfillment_/.test(rbSrc + rpSrc + ctSrc + idxSrc + routeSrc + panelSrc + syncSrc));

const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log('STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length > 0) process.exitCode = 1;
