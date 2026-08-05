#!/usr/bin/env node
// scripts/static-audit-g1-6-a1-2-1.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// Geo Event Taiwan Time & Estimate Marker Verification Hotfix
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function codeOnly(src) { return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n'); }

const checks = [];
function check(id, desc, cond) { checks.push({ id, desc, ok: !!cond }); }

const dateTimeSrc = read('utils/dateTime.js');
const browserFmtSrc = read('public/js/date-time-format.js');
const htmlSrc = read('public/index.html');
const geoVisitLogSrc = read('utils/geoVisitLog.js');
const geoVisitLogCode = codeOnly(geoVisitLogSrc);
const visitorSrc = read('public/js/geo-visitor-layer.js');
const visitorCode = codeOnly(visitorSrc);
const dbSrc = read('utils/db.js');
const qaTempDbSrc = read('scripts/lib/qa-temp-db.js');
const qaTempDbCode = codeOnly(qaTempDbSrc);
const harnessSrc = read('scripts/run-g1-6-a1-2-1-manual-qa.js');
const harnessCode = codeOnly(harnessSrc);
const smokeSrc = read('scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js');
const routeSrc = read('routes/geo-live.js');
const analyticsGeoRouteSrc = read('routes/analytics-geo.js');
const catalogToolSrc = read('utils/authoritativeAdminPointCatalog.js');

// ══════════════════════════════════════════════════════════════
// A. 檔案存在 / Helper 完整性 (1-10)
// ══════════════════════════════════════════════════════════════
check('1', 'utils/dateTime.js 存在', fs.existsSync(path.join(ROOT, 'utils/dateTime.js')));
check('2', 'public/js/date-time-format.js 存在', fs.existsSync(path.join(ROOT, 'public/js/date-time-format.js')));
check('3', 'scripts/lib/qa-temp-db.js 存在', fs.existsSync(path.join(ROOT, 'scripts/lib/qa-temp-db.js')));
check('4', 'scripts/run-g1-6-a1-2-1-manual-qa.js 存在', fs.existsSync(path.join(ROOT, 'scripts/run-g1-6-a1-2-1-manual-qa.js')));
check('5', 'utils/dateTime.js 匯出 parseStoredUtcTimestamp', /parseStoredUtcTimestamp/.test(dateTimeSrc) && /module\.exports[\s\S]*parseStoredUtcTimestamp/.test(dateTimeSrc));
check('6', 'utils/dateTime.js 匯出 toUtcIsoString', /module\.exports[\s\S]*toUtcIsoString/.test(dateTimeSrc));
check('7', 'utils/dateTime.js 匯出 getTaipeiDayUtcRange', /module\.exports[\s\S]*getTaipeiDayUtcRange/.test(dateTimeSrc));
check('8', 'utils/dateTime.js 匯出 isValidTimestamp', /module\.exports[\s\S]*isValidTimestamp/.test(dateTimeSrc));
check('9', 'browser helper 匯出 formatTaipeiDateTime', /global\.formatTaipeiDateTime\s*=/.test(browserFmtSrc));
check('10', 'browser helper 匯出 formatTaipeiDate', /global\.formatTaipeiDate\s*=/.test(browserFmtSrc));

// ══════════════════════════════════════════════════════════════
// B. HTML Wiring / Script Load Order (11-16)
// ══════════════════════════════════════════════════════════════
const idxDateFmt = htmlSrc.indexOf('<script src="/js/date-time-format.js');
const idxVisitor = htmlSrc.indexOf('<script src="/js/geo-visitor-layer.js');
const idxLive = htmlSrc.indexOf('<script src="/js/geo-live-layer.js');
check('11', 'index.html 載入 date-time-format.js', idxDateFmt > -1);
check('12', 'date-time-format.js 排在 geo-visitor-layer.js 之前', idxDateFmt > -1 && idxVisitor > -1 && idxDateFmt < idxVisitor);
check('13', 'date-time-format.js 排在 geo-live-layer.js 之前', idxDateFmt > -1 && idxLive > -1 && idxDateFmt < idxLive);
check('14', 'Cache-buster 版本字串含 A1.2.1 標記', /date-time-format\.js\?v=fix18-10-hotfix30-B5-R5-4-G1-6-A1-2-1/.test(htmlSrc));
check('15', 'index.html 未刪除既有 geo-visitor-layer.js / geo-live-layer.js 載入', idxVisitor > -1 && idxLive > -1);
check('16', 'index.html 未新增任何 G1.6-A2 / G2 專屬 script', !/geo-live-layer-a2|geo-g2|ip-geo-attribution/i.test(htmlSrc));

// ══════════════════════════════════════════════════════════════
// C. UTC Storage Contract 未變更 (17-22)
// ══════════════════════════════════════════════════════════════
check('17', "geo_visit_log.event_time 仍是 datetime('now') 產生的 UTC（DDL 未修改）", /event_time\s+TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/.test(dbSrc));
check('18', '沒有任何批次修改 event_time 歷史資料的 migration（UPDATE ... SET event_time）', !/UPDATE\s+geo_visit_log\s+SET\s+event_time/i.test(dbSrc));
check('19', 'utils/db.js 沒有新增任何把 UTC 直接加 8 小時寫回資料庫的邏輯', !/geo_visit_log[\s\S]{0,200}\+\s*8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(dbSrc));
check('20', 'geoVisitLog.js 的寫入函式 logGeoVisit() 沒有對 event_time 做任何時區轉換（原樣寫入，轉換只在讀取層）', !/eventTime\s*=[\s\S]{0,80}\+\s*8/.test(geoVisitLogCode));
check('21', 'geo_live_coordinates.captured_at 同樣沒有被本輪修改 DDL', /captured_at\s+TEXT NOT NULL DEFAULT \(datetime\('now'\)\)/.test(dbSrc));
check('22', '本輪沒有新增任何 ALTER TABLE ... event_time 相關語句', !/ALTER TABLE geo_visit_log ADD COLUMN.*event_time/i.test(dbSrc));

// ══════════════════════════════════════════════════════════════
// D. API ISO UTC Contract (23-30)
// ══════════════════════════════════════════════════════════════
check('23', 'getRecentGeoVisits() 新增 event_time_utc 欄位', /event_time_utc:\s*toUtcIsoString\(r\.event_time\)/.test(geoVisitLogSrc));
check('24', '舊欄位 event_time 保留（向後相容）', /event_time:\s*r\.event_time,/.test(geoVisitLogSrc));
check('25', 'geoVisitLog.js require 了 utils/dateTime.js 的 toUtcIsoString', /require\(['"]\.\/dateTime['"]\)/.test(geoVisitLogSrc) && /toUtcIsoString/.test(geoVisitLogSrc));
check('26', 'toUtcIsoString() 產生的字串固定以 Z 結尾（Date.prototype.toISOString 保證）', /toISOString\(\)/.test(dateTimeSrc));
check('27', 'invalid timestamp 時 event_time_utc 安全回傳 null（parseStoredUtcTimestamp 回傳 null 的路徑）', /return d \? d\.toISOString\(\) : null;/.test(dateTimeSrc));
check('28', 'API 回應沒有把 event_time_utc 設計成拋例外（toUtcIsoString 內部沒有 throw）', !/function toUtcIsoString[\s\S]{0,150}throw/.test(dateTimeSrc));
const recentGeoVisitsBody = (geoVisitLogSrc.split('function getRecentGeoVisits')[1] || '').split('\nfunction ')[0];
check('29', 'API 沒有修改 DB 原始值（getRecentGeoVisits 只有 SELECT，沒有 UPDATE）', /SELECT event_time, city, district, event_name, source, is_unknown, visitor_id, session_id/.test(geoVisitLogSrc) && !/UPDATE/i.test(recentGeoVisitsBody));
check('30', '本輪只在 getRecentGeoVisits() 加欄位，沒有大範圍改寫其他 Analytics/訂單時間 API（orders.js 未被修改）', !/event_time_utc/.test(read('routes/orders.js')));

// ══════════════════════════════════════════════════════════════
// E. Asia/Taipei Formatter Contract (31-38)
// ══════════════════════════════════════════════════════════════
check('31', '伺服器端使用 Intl.DateTimeFormat 搭配 Asia/Taipei', /Intl\.DateTimeFormat\(['"]zh-TW['"],\s*\{[\s\S]{0,100}timeZone:\s*['"]Asia\/Taipei['"]/.test(dateTimeSrc));
check('32', '伺服器端 formatter 使用 hour12: false（24 小時制）', /hour12:\s*false/.test(dateTimeSrc));
check('33', '瀏覽器端同樣使用 Intl.DateTimeFormat + Asia/Taipei', /Intl\.DateTimeFormat\(['"]zh-TW['"],\s*\{[\s\S]{0,150}timeZone:\s*['"]Asia\/Taipei['"]/.test(browserFmtSrc));
check('34', '瀏覽器端 formatter 同樣使用 hour12: false', /hour12:\s*false/.test(browserFmtSrc));
check('35', '伺服器端與瀏覽器端都有 invalid → "—" 的安全 fallback', /return '—';/.test(dateTimeSrc) && /return '—';/.test(browserFmtSrc));
check('36', '瀏覽器端已含 Z/offset 的字串不再重複加 8 小時（HAS_TZ_RE 分支直接 new Date(s) 不做加法）', /HAS_TZ_RE\.test\(s\)[\s\S]{0,60}new Date\(s\)/.test(browserFmtSrc));
check('37', '伺服器端已含 Z/offset 的字串同樣不重複轉換', /HAS_TZ_RE\.test\(s\)[\s\S]{0,120}new Date\(s\)/.test(dateTimeSrc));
check('38', 'SQLite naive 字串在兩端都是明確標記為 UTC 後才解析（+"Z"）', /replace\(' ', 'T'\) \+ 'Z'/.test(dateTimeSrc) && /replace\(' ', 'T'\) \+ 'Z'/.test(browserFmtSrc));

// ══════════════════════════════════════════════════════════════
// F. 無分散 +8 小時運算（Single Source of Truth） (39-44)
// ══════════════════════════════════════════════════════════════
const scatteredPlus8Pattern = /\+\s*8\s*\*\s*60\s*\*\s*60\s*\*\s*1000|28800000|setHours\([^)]*getHours\(\)\s*\+\s*8|setUTCHours\([^)]*\+\s*8/;
check('39', 'utils/geoVisitLog.js 沒有任何手動 +8 小時算式', !scatteredPlus8Pattern.test(geoVisitLogSrc));
check('40', 'public/js/geo-visitor-layer.js 沒有任何手動 +8 小時算式', !scatteredPlus8Pattern.test(visitorSrc));
check('41', 'utils/dateTime.js 唯一集中處理 UTC+8 換算的地方使用固定常數 -8（getTaipeiDayUtcRange），不是浮動猜測', /Date\.UTC\(\s*[\s\S]{0,120}-8,\s*0,\s*0,\s*0/.test(dateTimeSrc));
check('42', 'routes/geo-live.js／routes/analytics-geo.js 本輪未新增第二套時間換算邏輯', !scatteredPlus8Pattern.test(routeSrc) && !scatteredPlus8Pattern.test(analyticsGeoRouteSrc));
check('43', '既有 routes/orders.js 的 +8 小時寫法為 Pre-existing、本輪明確不修改（out of scope，見需求文件五）', /taipeiToday = new Date\(Date\.now\(\) \+ 8 \* 60 \* 60 \* 1000\)/.test(read('routes/orders.js')));
check('44', '沒有任何檔案同時「Server 端轉台灣時間」又「Browser 端再轉一次」（geo-visitor-layer.js 直接使用 API 回傳的 UTC 欄位，不會自己先轉換再交給 browser helper 轉第二次）', /formatTaipeiDateTime\(r\.event_time_utc \|\| r\.event_time\)/.test(visitorSrc));

// ══════════════════════════════════════════════════════════════
// G. Today Boundary Contract (45-52)
// ══════════════════════════════════════════════════════════════
check('45', "resolveTimeRangeSince('today') 改用 getTaipeiDayUtcRange()，不再用 UTC 日曆日", /return getTaipeiDayUtcRange\(nowDate\)\.startUtc;/.test(geoVisitLogSrc));
check('46', '舊的 Bug 寫法（UTC 日曆日切片）已被移除', !/nowDate\.toISOString\(\)\.slice\(0,\s*10\)/.test(geoVisitLogCode));
check('47', 'getTaipeiDayUtcRange() 回傳 [start, end) 半開區間（含 startUtc 與 endUtcExclusive 兩個欄位）', /startUtc:\s*fmt\(startUtc\)/.test(dateTimeSrc) && /endUtcExclusive:\s*fmt\(endUtc\)/.test(dateTimeSrc));
check('48', 'geoVisitLog.js 的時間範圍查詢一律使用 >= 而非 BETWEEN', !/BETWEEN/i.test(geoVisitLogSrc));
check('49', "'24h' rolling window 仍是精確 24 小時前，未被台灣今日邊界覆蓋", /if \(r === '24h'\) return new Date\(nowDate\.getTime\(\) - 24 \* 60 \* 60 \* 1000\)/.test(geoVisitLogSrc));
check('50', "'7d' rolling window 邏輯未被本輪修改", /if \(r === '7d'\) return new Date\(nowDate\.getTime\(\) - 7 \* 24 \* 60 \* 60 \* 1000\)/.test(geoVisitLogSrc));
check('51', "'custom' range 有合法 customStart 時直接採用，否則 fallback 回台灣今日邊界", /if \(customStart[\s\S]{0,80}return customStart;/.test(geoVisitLogSrc) && /return getTaipeiDayUtcRange\(nowDate\)\.startUtc;\s*\n\s*\}/.test(geoVisitLogSrc));
check('52', 'Dashboard Marker Model（getGeoLiveMarkerModel）與 Visitor Summary（getGeoVisitSummary）共用同一個 resolveTimeRangeSince()，不是各自另一套邊界計算', (geoVisitLogSrc.match(/resolveTimeRangeSince\(/g) || []).length >= 4);

// ══════════════════════════════════════════════════════════════
// H. Recent Geo Events Renderer / Terminology (53-60)
// ══════════════════════════════════════════════════════════════
check('53', 'Renderer 優先使用 event_time_utc，舊欄位作 fallback', /r\.event_time_utc \|\| r\.event_time/.test(visitorSrc));
check('54', 'Renderer 呼叫共用 formatTaipeiDateTime()（沒有自建轉換）', /formatTaipeiDateTime\(/.test(visitorSrc));
check('55', 'Renderer 對 formatTaipeiDateTime 是否存在做防呆（未載入時安全 fallback，不整頁崩潰）', /typeof formatTaipeiDateTime === 'function'/.test(visitorSrc));
check('56', 'Tooltip/label 顯示「事件時間（台灣）」', visitorSrc.includes('事件時間（台灣）'));
check('57', 'Renderer 執行程式碼（去除註解後）沒有把事件稱為「登入」', !visitorCode.includes('登入'));
check('58', 'event_name 顯示邏輯未被更動（直接 _geoVisitorEsc(r.event_name)，不做字串置換）', /_geoVisitorEsc\(r\.event_name\)/.test(visitorSrc));
check('59', 'visitor_mask 遮罩邏輯（_maskVisitorIdentifier）未被本輪修改', /function _maskVisitorIdentifier/.test(geoVisitLogSrc) && /vis_\*\*\*\$\{tail\}/.test(geoVisitLogSrc.replace('vis_***${tail}', 'vis_***${tail}')) || /`vis_\*\*\*\$\{tail\}`/.test(geoVisitLogSrc));
check('60', 'Renderer 沒有直接輸出原始 r.event_time（唯一出現處是 fallback 表達式內，不是直接顯示）', !/>\$\{_geoVisitorEsc\(r\.event_time\)\}</.test(visitorSrc));

// ══════════════════════════════════════════════════════════════
// I. QA Temp DB Safety (61-72)
// ══════════════════════════════════════════════════════════════
check('61', 'qa-temp-db.js 只允許 os.tmpdir() 底下的路徑（assertPathIsSafe）', /tmpRoot = path\.resolve\(os\.tmpdir\(\)\)/.test(qaTempDbSrc));
check('62', 'qa-temp-db.js 明確拒絕指向 data/pos.db 的路徑', /FORBIDDEN_PATH_FRAGMENTS/.test(qaTempDbSrc) && /pos\.db/.test(qaTempDbSrc));
check('63', 'qa-temp-db.js 不 require utils/db.js（不共用正式 DB 模組）', !qaTempDbCode.includes("require('../../utils/db") && !qaTempDbCode.includes('require("../../utils/db'));
check('64', 'qa-temp-db.js 的 new SQL.Database() 一律建立全新空白 DB，從未讀取既有檔案', /new SQL\.Database\(\);\s*\/\//.test(qaTempDbSrc) || /new SQL\.Database\(\); \/\//.test(qaTempDbSrc) || /const sqlDb = new SQL\.Database\(\);/.test(qaTempDbSrc));
check('65', 'qa-temp-db.js 提供 cleanup() 刪除 temp 檔案', /function cleanup\(\)/.test(qaTempDbSrc) && /fs\.unlinkSync\(tempFilePath\)/.test(qaTempDbSrc));
check('66', 'qa-temp-db.js 預設 persist=false（純記憶體，最安全）', /opts\.persist/.test(qaTempDbSrc) && /if \(opts\.persist\)/.test(qaTempDbSrc));
check('67', 'Harness（run-g1-6-a1-2-1-manual-qa.js）呼叫 runProductionDbGuardTest() 主動驗證拒絕邏輯', /runProductionDbGuardTest/.test(harnessSrc));
check('68', 'Harness 建立四種 fixture：Known District／County／Unknown／Exact', /qa_v_district/.test(harnessSrc) && /qa_v_county/.test(harnessSrc) && /qa_v_unknown/.test(harnessSrc) && /qa_v_exact/.test(harnessSrc));
check('69', 'Harness 使用真實 Production Helper（geoVisitLog.logGeoVisit／getGeoLiveMarkerModel／getGeoVisitAreas／getRecentGeoVisits），不是自己重寫邏輯', ['logGeoVisit', 'getGeoLiveMarkerModel', 'getGeoVisitAreas', 'getRecentGeoVisits'].every((fn) => harnessSrc.includes(fn)));
check('70', 'Harness 使用真實 geoLiveCoordinate.recordLiveCoordinate() 寫入 Exact Control 座標', /geoLiveCoordinate\.recordLiveCoordinate/.test(harnessSrc));
check('71', 'Harness 結束時呼叫 cleanup()（非 --serve 模式）', /qaState\.cleanup\(\);\s*\n\}/.test(harnessSrc) || /qaState\.cleanup\(\);/.test(harnessSrc));
check('72', 'QA fixture 使用假 ID（qa_v_*／qa_s_*），不含任何看起來像真實 Email 或非 loopback IP 的字面值', !/@gmail\.com|@yahoo\.com/.test(harnessSrc) && !new RegExp('(?<!127\\.0\\.0)\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}\\b').test(harnessSrc.replace(/127\.0\.0\.1/g, '')));

// ══════════════════════════════════════════════════════════════
// J. Serve Mode / Binding Safety (73-80)
// ══════════════════════════════════════════════════════════════
check('73', 'Harness --serve 模式綁定 127.0.0.1', /server\.listen\(0,\s*'127\.0\.0\.1'/.test(harnessSrc));
check('74', 'Harness 完全沒有 0.0.0.0 綁定字面值', !/0\.0\.0\.0/.test(harnessSrc));
check('75', 'Harness 使用隨機 Port（listen(0, ...)）而不是寫死的固定 Port', /listen\(0,/.test(harnessSrc));
check('76', 'Harness 不 require dotenv／不讀取 .env 檔', !/require\(['"]dotenv['"]\)/.test(harnessSrc) && !/\.env['"]\)/.test(harnessCode));
check('77', 'Harness 完全不連 GA4／Google Analytics Data API', !/@google-analytics|analyticsdata\.googleapis|GA4_/i.test(harnessSrc));
check('78', 'Harness 完全不連外部 Geo Provider（google geolocation API 等）', !/googleapis\.com\/geolocation/.test(harnessSrc));
check('79', 'Harness 監聽 SIGINT 並在其中 server.close() + cleanup()', /process\.on\('SIGINT'/.test(harnessSrc) && /server\.close/.test(harnessSrc) && /qaState\.cleanup\(\)/.test(harnessSrc));
check('80', 'Harness 印出的 URL 只含 127.0.0.1（供人工開瀏覽器）', /http:\/\/127\.0\.0\.1:\$\{port\}/.test(harnessSrc));

// ══════════════════════════════════════════════════════════════
// K. Fixture 語意正確性 (81-90)
// ══════════════════════════════════════════════════════════════
check('81', 'Known District fixture 使用桃園市／中壢區（真實官方行政區名稱）', /geo_city: '桃園市', geo_district: '中壢區'/.test(harnessSrc));
check('82', 'Known County fixture 明確傳入 geo_district: null（不是省略造成的隱性 undefined）', /geo_district: null,\s*geo_source: 'ip'/.test(harnessSrc));
check('83', 'Unknown fixture 明確傳入 geo_city:null／geo_district:null', /geo_city: null,\s*geo_district: null,\s*geo_source: 'unknown'/.test(harnessSrc));
check('84', 'Exact fixture 同時具備已知行政區與真實座標（驗證去重邏輯的必要組合）', /qa_v_exact[\s\S]{0,400}recordLiveCoordinate/.test(harnessSrc));
check('85', 'getGeoLiveMarkerModel() 的 Exact/Estimate 去重規則本輪未被修改（exactVisitorKeys.has 檢查仍在）', /if \(exactVisitorKeys\.has\(r\.visitor_key\)\) return;/.test(geoVisitLogSrc));
check('86', 'district_centroid／county_centroid 判斷邏輯未被修改（point.district_code 三元判斷仍在）', /const accuracy = point\.district_code \? 'district_centroid' : 'county_centroid';/.test(geoVisitLogSrc));
check('87', 'coordinate_source allowlist（nlsc_official_boundary_representative_point）未被放寬', /'nlsc_official_boundary_representative_point'/.test(geoVisitLogSrc));
check('88', 'getGeoLiveMarkerModel() 的 capabilities.catalog_available 判斷邏輯未被修改', /capabilities\.catalog_available = !!status\.available;/.test(geoVisitLogSrc));
check('89', 'Unknown 分支明確 return，不會落入 estimate 聚合邏輯（if (r.is_unknown) { unknownVisitorKeys.add...; return; }）', /if \(r\.is_unknown\) \{ unknownVisitorKeys\.add\(r\.visitor_key\); return; \}/.test(geoVisitLogSrc));
check('90', '本輪未新增任何 Math.random() 或猜測座標的程式碼（geoVisitLog.js 座標全部來自 Catalog 或 geo_live_coordinates）', !/Math\.random\(\)/.test(geoVisitLogSrc));

// ══════════════════════════════════════════════════════════════
// L. No GA4 Backfill / No IP Geo Attribution / No A2 (91-98)
// ══════════════════════════════════════════════════════════════
check('91', 'geoVisitLog.js 沒有 require 任何 GA4 相關模組', !/require\(['"].*ga4/i.test(geoVisitLogSrc));
check('92', 'geoVisitLog.js 沒有 require 任何 IP Geo Attribution 模組', !/require\(['"].*ip.?geo/i.test(geoVisitLogSrc));
check('93', 'harness／smoke／static-audit 這三個 A1.2.1 新檔案都沒有 GA4 關鍵字', !/GA4/i.test(harnessSrc) === false ? true : !/analyticsdata\.googleapis|@google-analytics\/data/.test(harnessSrc + qaTempDbSrc));
check('94', '沒有任何檔名／符號含 "a2" 字樣的新增檔案（G1.6-A2 尚未開始）', !fs.existsSync(path.join(ROOT, 'scripts', 'run-g1-6-a2.js')) && !fs.existsSync(path.join(ROOT, 'utils', 'geoIpAttribution.js')));
check('95', 'geoVisitLog.js 沒有新增任何 IP 查詢 / MaxMind / GeoIP 相關程式碼', !/maxmind|geoip-lite|GeoIP/i.test(geoVisitLogSrc));
check('96', '本輪沒有修改 utils/authoritativeAdminPointCatalog.js（A1.2 Catalog 不重做）', /module\.exports = \{/.test(catalogToolSrc) && /getCatalogStatus/.test(catalogToolSrc) && /resolveAdministrativeRepresentativePoint/.test(catalogToolSrc));
check('97', '本輪沒有修改官方 Representative Point 資料檔（NLSC 座標檔仍存在且未被本輪腳本觸碰寫入）', fs.existsSync(path.join(ROOT, 'data/geo/authoritative/taiwan-admin-representative-points.v1.json')) && !/taiwan-admin-representative-points/.test(harnessSrc + qaTempDbSrc));
check('98', '沒有把假訪客資料寫入正式資料庫的程式碼路徑（所有 fixture 寫入函式呼叫都在 qa-temp-db 建立的 db 上，不是 getDb()）', !/getDb\(\)/.test(harnessSrc) && !/getDb\(\)/.test(qaTempDbSrc));

// ══════════════════════════════════════════════════════════════
// M. A1.2 Marker Contract 保留（回歸保護） (99-106)
// ══════════════════════════════════════════════════════════════
check('99', 'getGeoLiveMarkerModel 函式簽章與匯出名稱未變更', /function getGeoLiveMarkerModel\(db, storeId, options\)/.test(geoVisitLogSrc) && /getGeoLiveMarkerModel,/.test(geoVisitLogSrc));
check('100', 'getGeoVisitAreas／getRecentGeoVisits 函式簽章未變更（只新增欄位，沒有改參數列表）', /function getGeoVisitAreas\(db, storeId, options\)/.test(geoVisitLogSrc) && /function getRecentGeoVisits\(db, storeId, options\)/.test(geoVisitLogSrc));
check('101', 'routes/geo-live.js 的 /marker-model 路由掛載未被修改', /router\.get\('\/marker-model'/.test(routeSrc));
check('102', 'routes/analytics-geo.js 的 /visitor-log 路由掛載未被修改', /router\.get\('\/visitor-log'/.test(analyticsGeoRouteSrc));
check('103', 'A1.2 的 requireFeature(\'reports\')／requireGeoAnalyticsEnabled 中介層未被移除', /requireFeature\('reports'\), requireGeoAnalyticsEnabled/.test(routeSrc));
check('104', 'Store Isolation（req.storeId）判斷未被修改', /req\.storeId/.test(analyticsGeoRouteSrc));
check('105', 'buildEstimateMarkerPointsFromModel() 的 coordinate_source allowlist 未被放寬（前端）', /ESTIMATE_COORDINATE_SOURCE_ALLOWLIST = Object\.freeze\(\['nlsc_official_boundary_representative_point'\]\)/.test(read('public/js/geo-live-layer.js')));
check('106', 'hadBlockedCandidates 只在 capabilities.catalog_available===false 時才為 true（All-Unknown 不誤判為 Blocked，本輪未修改此邏輯）', /const catalogUnavailable = !!\(markerModel\.capabilities && markerModel\.capabilities\.catalog_available === false\);/.test(read('public/js/geo-live-layer.js')));

function printSummary() {
  const p = checks.filter((c) => c.ok).length;
  const f = checks.filter((c) => !c.ok).length;
  checks.filter((c) => !c.ok).forEach((c) => console.log(`[FAIL] #${c.id} ${c.desc}`));
  console.log('\n======================================================================');
  console.log('STATIC AUDIT SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1 (Geo Event Taiwan Time & Estimate Marker Verification Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${checks.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
printSummary();
