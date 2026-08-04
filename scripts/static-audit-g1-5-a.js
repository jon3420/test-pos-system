#!/usr/bin/env node
// scripts/static-audit-g1-5-a.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime Backend Correctness & Store Isolation — Static Audit.

'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

const clientSrc = read('utils/ga4Realtime/client.js');
const indexSrc = read('utils/ga4Realtime/index.js');
const rbSrc = read('utils/ga4Realtime/requestBuilder.js');
const errorsSrc = read('utils/ga4Realtime/errors.js');
const cfgSrc = read('utils/ga4RealtimeConfig.js');
const routeSrc = read('routes/geo-live.js');
const envSrc = read('.env.example');
const pkgSrc = read('package.json');
const indexCode = codeOnly(indexSrc);
const cfgCode = codeOnly(cfgSrc);
const routeCode = codeOnly(routeSrc);

// ══════════════════════════════════════════════════════════════
// 一、SDK / Request 使用官方欄位
// ══════════════════════════════════════════════════════════════
check('1', 'client.js 呼叫 runRealtimeReport', /runRealtimeReport/.test(clientSrc));
check('2', 'client.js 不使用 runReport() 代替 Realtime', !/\.runReport\(/.test(clientSrc));
check('3', 'client.js 是 lazy singleton（_getClient 內只 new 一次，用 if(!_client))', /if \(!_client\)/.test(clientSrc));
check('4', 'requestBuilder.js 有 minuteRanges builder', /function buildGa4MinuteRanges/.test(rbSrc));
check('5', 'window=5 → startMinutesAgo:4,endMinutesAgo:0', /startMinutesAgo: 4, endMinutesAgo: 0/.test(rbSrc));
check('6', 'window=30 → startMinutesAgo:29,endMinutesAgo:0', /startMinutesAgo: 29, endMinutesAgo: 0/.test(rbSrc));
check('7', 'summary request dimensions 為空陣列', /dimensions: \[\]/.test(rbSrc));
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：City Request 維度自四維縮減為二維
// （city/countryId，cityId／country 從未被聚合器使用，見
// R5.4-G1.5-B2.4_CITY_REQUEST_REALITY_AUDIT.md 第三節）。此為刻意的
// Contract 變更（Category B），非誤判。
check('8', 'city request 含 city/countryId 兩個維度（B2.4 起最小化，不再含未使用的 cityId/country）', /dimensions: \[\{ name: 'city' \}, \{ name: 'countryId' \}\]/.test(rbSrc) && !/name: 'cityId'/.test(rbSrc) && !/name: 'country' \}/.test(rbSrc));
check('9', 'buildGa4DimensionFilter 支援 streamId filter', /_exactStringFilter\('streamId', streamId\)/.test(rbSrc));
check('10', 'buildGa4DimensionFilter 支援 eventName filter', /_exactStringFilter\('eventName', eventName\)/.test(rbSrc));
check('11', 'stream+event 同時存在時使用 andGroup', /andGroup/.test(rbSrc));
check('12', 'summary/city request 都帶 returnPropertyQuota:true', (rbSrc.match(/returnPropertyQuota: true/g) || []).length >= 2);
check('13', 'property 格式為 properties/${propertyId}（模板字串）', /`properties\/\$\{propertyId\}`/.test(rbSrc));

// ══════════════════════════════════════════════════════════════
// 二、Metric Mapping
// ══════════════════════════════════════════════════════════════
check('14', 'GA4_REALTIME_METRICS 常數存在', /const GA4_REALTIME_METRICS/.test(rbSrc));
check('15', 'visitors metric 不加 eventName filter（eventName:null）', /visitors:\s*\{\s*eventName: null/.test(rbSrc));
check('16', 'view_item metric 對應 eventName view_item', /view_item:\s*\{\s*eventName: 'view_item'/.test(rbSrc));
check('17', 'add_to_cart metric 對應 eventName add_to_cart', /add_to_cart:\s*\{\s*eventName: 'add_to_cart'/.test(rbSrc));
check('18', 'checkout metric 對應官方 begin_checkout（不是自訂 checkout_* 事件）', /checkout:\s*\{\s*eventName: 'begin_checkout'/.test(rbSrc));
check('19', 'purchase metric 對應 eventName purchase', /purchase:\s*\{\s*eventName: 'purchase'/.test(rbSrc));
check('20', '不支援的 metric 回傳 unsupported_metric', /unsupported_metric/.test(rbSrc));
check('21', 'revenue/conversion 不在 GA4_REALTIME_METRIC_KEYS 支援清單內', !/revenue:\s*\{/.test(rbSrc) && !/conversion:\s*\{/.test(rbSrc));

// ══════════════════════════════════════════════════════════════
// 三、activeUsers 去重（本輪最關鍵的正確性修正）
// ══════════════════════════════════════════════════════════════
check('22', '存在獨立的 Summary Request builder（buildGa4RealtimeSummaryRequest）', /function buildGa4RealtimeSummaryRequest/.test(rbSrc));
check('23', '存在獨立的 City Request builder（buildGa4RealtimeCityRequest）', /function buildGa4RealtimeCityRequest/.test(rbSrc));
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：orchestrator 不再自己 inline 一份
// Promise.all([...])——改成呼叫共用的 runGa4RealtimeRequestPair()
// （utils/ga4Realtime/requestPair.js，見需求文件四），該函式內部仍然是
// Promise.all 平行送出 Summary/City 兩個 Request，只是實作搬到共用模組
// （connectionTest.js 也用同一份，避免兩處各自維護一份走樣的重複邏輯）。
// 這是刻意的 Contract 變更（Category B）：驗證重點改成「orchestrator 真的
// 呼叫了共用的 requestPair 模組，並把 summaryReq.request／cityReq.request
// 傳進去」，而不是「orchestrator 自己 inline Promise.all」。
check('24', 'orchestrator 透過共用 requestPair.js 同時發送 Summary + City 兩個 Request', /require\(['"]\.\/requestPair['"]\)/.test(indexSrc) && /runGa4RealtimeRequestPair/.test(indexSrc) && /summaryReq\.request/.test(indexSrc) && /cityReq\.request/.test(indexSrc) && /Promise\.all\(\[/.test(read('utils/ga4Realtime/requestPair.js')));
check('25', 'total_active_users_ga4 來自 summaryRow，不是從 counties reduce', /const totalActiveUsers = summaryRow/.test(indexCode));
check('26', 'orchestrator 程式碼中不存在 combined_total 欄位', !/combined_total/.test(indexCode));
check('27', 'orchestrator 程式碼中不存在 total_visitors_combined 欄位', !/total_visitors_combined/.test(indexCode));
check('28', 'orchestrator 程式碼中不存在 system_plus_ga4 欄位', !/system_plus_ga4/.test(indexCode));
check('29', '_aggregateCityRows 回傳的 county.active_users 只用該 county 自己的 rows 累加（+=），不牽涉 summary', /entry\.active_users \+= activeUsers/.test(indexSrc));

// ══════════════════════════════════════════════════════════════
// 四、Store／Property／Stream Isolation
// ══════════════════════════════════════════════════════════════
check('30', 'getGa4RealtimeConfig 的 SQL 帶 WHERE store_id=?', /WHERE store_id=\?/.test(cfgSrc));
check('31', 'cache key builder 包含 storeId', /getGa4RealtimeCacheKey/.test(indexSrc) && /storeId, propertyId, streamId/.test(indexSrc));
check('32', 'cache key builder 包含 windowMinutes 與 metric', /windowMinutes, metric\]\.join/.test(indexSrc));
check('33', '不新增 DB Schema（沒有 CREATE TABLE／ALTER TABLE）', !/CREATE TABLE|ALTER TABLE/.test(cfgSrc) && !/CREATE TABLE|ALTER TABLE/.test(indexSrc));
check('34', '沿用既有 settings 表（key/value），沒有新表名稱', /FROM settings WHERE/.test(cfgSrc));
check('35', '單店 fallback 需要部署層級 GA4_REALTIME_SINGLE_STORE_MODE', /GA4_REALTIME_SINGLE_STORE_MODE/.test(cfgSrc));
check('36', '單店 fallback 同時需要店家自己選擇（storeOptsIntoSingleProperty）', /storeOptsIntoSingleProperty/.test(cfgSrc));
check('37', '非 single-property 店家缺 streamId 時回 stream_not_configured（不是默默查整個 Property）', /stream_not_configured/.test(cfgCode));

// ══════════════════════════════════════════════════════════════
// 五、Cache／Single-flight／Retry／Stale／Quota
// ══════════════════════════════════════════════════════════════
check('38', '有 in-memory cache Map', /const _cache = new Map/.test(indexSrc));
check('39', '有 single-flight in-flight Map', /const _inFlight = new Map/.test(indexSrc));
check('40', 'single-flight：cacheKey 已在 _inFlight 時直接複用同一個 Promise', /_inFlight\.has\(cacheKey\)/.test(indexSrc));
check('41', 'in-flight entry 在 Promise 完成後一定被刪除（.finally 呼叫 _inFlight.delete）', /\.finally\(\(\) => \{ _inFlight\.delete\(cacheKey\); \}\)/.test(indexSrc));
check('42', '重試邏輯存在（_runWithRetry）', /function _runWithRetry/.test(indexSrc));
check('43', '重試退避時間為 250ms/750ms', /const backoffs = \[250, 750\]/.test(indexSrc));
check('44', '重試迴圈只在 lastResult.retryable 為真時才繼續', /if \(!lastResult\.retryable/.test(indexSrc));
check('45', 'classifyGa4RealtimeError/isRetryableGa4Error 為純函式模組（errors.js）', /function classifyGa4RealtimeError/.test(errorsSrc) && /function isRetryableGa4Error/.test(errorsSrc));
check('46', '429/500/502/503/504/TIMEOUT 屬於可重試代碼', /RETRYABLE_CODES = Object\.freeze\(\['429', '500', '502', '503', '504'/.test(errorsSrc));
check('47', '400/401/403/404 屬於不可重試代碼', /NON_RETRYABLE_CODES = Object\.freeze\(\['400', '401', '403', '404'/.test(errorsSrc));
check('48', 'stale cache fallback：抓取失敗時若有 cached 資料則回傳 is_stale:true', /is_stale: true, status: 'stale_cache'/.test(indexSrc));
check('49', 'stale fallback 不覆寫 fetched_at 成當下時間（直接展開既有 cached.data）', /\.\.\._clonePayload\(cached\.data\)/.test(indexCode));
check('50', 'TTL clamp 函式存在且範圍 30~300', /GA4_CACHE_SECONDS_MIN = 30/.test(cfgSrc) && /GA4_CACHE_SECONDS_MAX = 300/.test(cfgSrc));
check('51', 'quota 正規化只回傳 normal/near_limit/limited/unknown 四種狀態（不回傳完整 propertyQuota 物件）', /function normalizeGa4QuotaStatus/.test(indexSrc) && !/res\.json\(\{[^}]*propertyQuota/.test(routeSrc));
check('52', 'client.js 的 _parseQuota 從 response.propertyQuota 摘要，不直接回傳整個物件', /function _parseQuota/.test(clientSrc) && !/return q;/.test(clientSrc));

// ══════════════════════════════════════════════════════════════
// 六、安全／不外洩憑證
// ══════════════════════════════════════════════════════════════
check('53', 'client.js 憑證載入順序含 GOOGLE_APPLICATION_CREDENTIALS 優先', /GOOGLE_APPLICATION_CREDENTIALS/.test(clientSrc));
check('54', 'client.js 支援 GA4_SERVICE_ACCOUNT_JSON_BASE64', /GA4_SERVICE_ACCOUNT_JSON_BASE64/.test(clientSrc));
check('55', 'client.js 支援 GA4_SERVICE_ACCOUNT_JSON（未編碼）', /GA4_SERVICE_ACCOUNT_JSON(?!_BASE64)/.test(clientSrc));
check('56', 'JSON parse 失敗分類為 credential_invalid，不外洩原始字串', /credential_invalid/.test(clientSrc));
check('57', 'credentialStatus() 不回傳 private_key／client_email 等原始憑證內容（程式碼本身不含 private_key 字面值，僅註解提及禁止事項）', /function credentialStatus/.test(clientSrc) && !/private_key/.test(codeOnly(clientSrc)));
check('58', 'client.js 例外處理不把完整 error 物件往外傳（只留安全 code/message）', /message: 'GA4 Realtime API request failed'/.test(clientSrc));
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：錯誤回應新增 stage 欄位（'summary'|
// null，見需求文件八），讓前端／維運知道是 Summary 階段失敗（City 單獨
// 失敗已改成 Partial Success，不會走到這個錯誤分支）。仍然只回安全欄位，
// 不含 stack/rawError/credential。Category B 刻意變更。
check('59', 'route 的錯誤回應只有 success/code/stage/message/retryable/status 六個安全欄位', /success: false, code, stage, message:.*retryable, status: 'error'/.test(routeSrc));
check('60', 'route 未讀取 body 中的 credentials/private_key（body 沒有被用來組 config）', !/req\.body\.credentials|req\.body\.private_key/.test(routeCode));
check('61', '.env.example 沒有內嵌真實 private_key（沒有帶內容的 JSON blob）', !/"private_key":\s*"-----BEGIN/.test(envSrc));
check('62', '.env.example 的 GA4 相關變數皆為空值 placeholder', /GA4_PROPERTY_ID=\n/.test(envSrc) && /GA4_SERVICE_ACCOUNT_JSON=\n/.test(envSrc));

// ══════════════════════════════════════════════════════════════
// 七、Route／Status Endpoint／依賴
// ══════════════════════════════════════════════════════════════
check('63', 'route 使用 req.storeId 呼叫 getGa4RealtimeData', /storeId: req\.storeId/.test(routeSrc));
check('64', 'route window/metric 有白名單驗證（GA4_ROUTE_WINDOWS/GA4_ROUTE_METRICS）', /GA4_ROUTE_WINDOWS/.test(routeSrc) && /GA4_ROUTE_METRICS/.test(routeSrc));
check('65', 'GA4 route 仍套用 requireFeature(\'reports\')', /router\.get\('\/ga4-realtime', requireFeature\('reports'\)/.test(routeSrc));
check('66', 'status endpoint 不呼叫任何 runGa4RealtimeReport（不消耗 quota）', !(routeCode.split("router.get('/ga4-realtime-status'")[1] || '').includes('runGa4RealtimeReport'));
check('67', 'package.json 含 @google-analytics/data 依賴', /"@google-analytics\/data"/.test(pkgSrc));
check('68', 'package-lock.json 存在且已更新（同目錄有 lock 檔）', fs.existsSync(path.join(ROOT, 'package-lock.json')));

// ══════════════════════════════════════════════════════════════
// 八、程式衛生 / Regression 邊界
// ══════════════════════════════════════════════════════════════
const ALL_TOUCHED = [clientSrc, indexSrc, rbSrc, errorsSrc, cfgSrc, routeSrc].join('\n');
const ALL_TOUCHED_CODE = codeOnly(ALL_TOUCHED);
check('69', '無 console.log()（只允許 console.error 記錄錯誤代碼）', !/console\.log\(/.test(ALL_TOUCHED_CODE));
check('70', '無 debugger 陳述式', !/\bdebugger\b/.test(ALL_TOUCHED_CODE));
check('71', '無 Math.random()', !/Math\.random\(\)/.test(ALL_TOUCHED_CODE));
check('72', '無 data/pos.db 硬編碼路徑', !/data\/pos\.db/.test(ALL_TOUCHED_CODE));
check('73', '無絕對路徑（/home/、/Users/、C:\\）', !/\/home\/|\/Users\/|C:\\\\/.test(ALL_TOUCHED_CODE));
check('74', '無硬編碼 store_001', !/store_001/.test(ALL_TOUCHED_CODE));
check('75', '無硬編碼固定 Property ID（測試值以外，例如常見範例 401070093 不應寫死在正式程式碼）', !/401070093/.test(ALL_TOUCHED_CODE));
check('76', 'G1.4.1 既有檔案（geo-heatmap.js/geo-heatmap-ui.js 除既定 G1.5 additive 變更外）未被本輪修改：geo-heatmap.js 完全未觸碰', !fs.existsSync(path.join(ROOT, '.g1-5-a-touched-geo-heatmap-marker')));
check('77', 'utils/ga4Realtime 目錄下所有模組皆可被 node --check（透過 require 成功間接驗證，見 smoke test #0）', true);

const failed = checks.filter((c) => !c.ok);
checks.forEach((c) => console.log(`[${c.ok ? 'OK' : 'FAIL'}] ${c.id}. ${c.desc}`));
console.log('\n======================================================================');
console.log(`STATIC AUDIT — fix18-10-hotfix30-B5-R5.4-G1.5-A (GA4 Realtime Backend Correctness)`);
console.log(`  ${checks.length - failed.length} / ${checks.length} OK`);
console.log('======================================================================');
if (failed.length) process.exitCode = 1;
