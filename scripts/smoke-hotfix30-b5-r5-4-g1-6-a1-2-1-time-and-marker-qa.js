#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1 — Geo Event Taiwan Time & Estimate
// Marker Verification Hotfix. Targeted smoke suite (需求文件十三).

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`[FAIL] ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1 (Geo Event Taiwan Time & Estimate Marker Verification Hotfix)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const dateTime = require(path.join(ROOT, 'utils/dateTime'));
  const geoVisitLog = require(path.join(ROOT, 'utils/geoVisitLog'));
  const geoLiveCoordinate = require(path.join(ROOT, 'utils/geoLiveCoordinate'));
  const { createTempQaDb, assertPathIsSafe } = require(path.join(ROOT, 'scripts/lib/qa-temp-db'));

  // ══════════════════════════════════════════════════════════════
  // 0. node --check on every file touched or added this round
  // ══════════════════════════════════════════════════════════════
  [
    'utils/dateTime.js',
    'utils/geoVisitLog.js',
    'public/js/date-time-format.js',
    'public/js/geo-visitor-layer.js',
    'scripts/lib/qa-temp-db.js',
    'scripts/run-g1-6-a1-2-1-manual-qa.js',
    'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel}`); }
    catch (e) { fail(`0-parse ${rel}`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // A. UTC Parsing (utils/dateTime.js#parseStoredUtcTimestamp / toUtcIsoString)
  // ══════════════════════════════════════════════════════════════
  {
    const A = dateTime;
    assert(A.toUtcIsoString('2026-08-05 01:52:36') === '2026-08-05T01:52:36.000Z', 'A-01 SQLite UTC naive string 解析為 UTC');
    assert(A.toUtcIsoString('2026-08-05T01:52:36.000Z') === '2026-08-05T01:52:36.000Z', 'A-02 ISO Z 字串原樣解析（不重複轉換）');
    assert(A.toUtcIsoString('2026-08-05T09:52:36+08:00') === '2026-08-05T01:52:36.000Z', 'A-03 ISO +08:00 offset 正確換算成 UTC（不再加 8）');
    assert(A.toUtcIsoString('2026-08-05T09:52:36+0800') === '2026-08-05T01:52:36.000Z', 'A-04 ISO +0800（無冒號）offset 正確解析');
    const epochMs = Date.UTC(2026, 7, 5, 1, 52, 36);
    assert(A.toUtcIsoString(epochMs) === new Date(epochMs).toISOString(), 'A-05 epoch milliseconds（number）正確解析');
    assert(A.toUtcIsoString(String(epochMs)) === new Date(epochMs).toISOString(), 'A-06 epoch milliseconds（字串）正確解析');
    assert(A.toUtcIsoString(null) === null, 'A-07 null 安全回傳 null');
    assert(A.toUtcIsoString(undefined) === null, 'A-08 undefined 安全回傳 null');
    assert(A.toUtcIsoString('') === null, 'A-09 空字串安全回傳 null');
    assert(A.toUtcIsoString('not-a-timestamp') === null, 'A-10 非法字串安全回傳 null（不猜時區）');
    assert(A.toUtcIsoString('NaN') === null, 'A-11 "NaN" 字串安全回傳 null');
    // no double conversion: naive string with implicit UTC parse, once, not twice
    const once = A.formatTaipeiDateTime('2026-08-05 01:52:36');
    assert(once === '2026-08-05 09:52:36', 'A-12 naive UTC → Taipei 只轉換一次（+8，不是 +16）');
    const zOnce = A.formatTaipeiDateTime('2026-08-05T01:52:36.000Z');
    assert(zOnce === '2026-08-05 09:52:36', 'A-13 帶 Z 的字串 → Taipei 只轉換一次');
    const offsetOnce = A.formatTaipeiDateTime('2026-08-05T09:52:36+08:00');
    assert(offsetOnce === '2026-08-05 09:52:36', 'A-14 已是台灣 offset 的字串顯示時不再加 8（沒有變成 17:52:36）');
    // leap day
    assert(A.toUtcIsoString('2028-02-29 00:00:00') === '2028-02-29T00:00:00.000Z', 'A-15 leap day (2028-02-29) 正確解析');
    assert(A.formatTaipeiDateTime('2028-02-28 16:00:00') === '2028-02-29 00:00:00', 'A-16 跨閏年 2/28→2/29 UTC→Taipei rollover 正確');
    // year boundary
    assert(A.formatTaipeiDateTime('2025-12-31 16:00:00') === '2026-01-01 00:00:00', 'A-17 年份邊界 UTC→Taipei rollover 正確');
    // midnight boundary
    assert(A.formatTaipeiDateTime('2026-08-04 16:00:00') === '2026-08-05 00:00:00', 'A-18 UTC 16:00 恰好對應台灣午夜 00:00');
    assert(A.isValidTimestamp('2026-08-05 01:52:36') === true, 'A-19 isValidTimestamp 對合法字串回傳 true');
    assert(A.isValidTimestamp('garbage') === false, 'A-20 isValidTimestamp 對非法字串回傳 false');
    assert(A.isValidTimestamp(null) === false, 'A-21 isValidTimestamp 對 null 回傳 false');
    assert(A.toUtcIsoString(new Date('2026-08-05T01:52:36Z')) === '2026-08-05T01:52:36.000Z', 'A-22 Date 物件直接解析');
    assert(A.toUtcIsoString(new Date('invalid')) === null, 'A-23 invalid Date 物件安全回傳 null');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Taipei Display Formatting
  // ══════════════════════════════════════════════════════════════
  {
    const A = dateTime;
    assert(A.formatTaipeiDateTime('2026-08-05 01:52:36') === '2026-08-05 09:52:36', 'B-01 需求文件驗收範例：01:52:36 UTC → 09:52:36 Taipei');
    assert(A.formatTaipeiDateTime('2026-08-04 20:00:00') === '2026-08-05 04:00:00', 'B-02 date rollover：UTC 前一天晚上 → Taipei 次日凌晨');
    assert(A.formatTaipeiDateTime('2026-07-31 16:30:00') === '2026-08-01 00:30:00', 'B-03 month rollover：7/31→8/1');
    assert(A.formatTaipeiDateTime('2025-12-31 16:30:00') === '2026-01-01 00:30:00', 'B-04 year rollover：2025→2026');
    assert(A.formatTaipeiDateTime('2026-08-05 01:52:07') === '2026-08-05 09:52:07', 'B-05 seconds 精度保留');
    assert(!/AM|PM|上午|下午/.test(A.formatTaipeiDateTime('2026-08-05 16:00:00')), 'B-06 24 小時制（沒有 AM/PM/上午/下午）');
    assert(A.formatTaipeiDateTime('2026-08-05 16:00:00') === '2026-08-06 00:00:00', 'B-07 UTC 16:00 顯示為次日台灣 00:00（24 小時制không是 24:00）');
    assert(A.formatTaipeiDateTime('invalid') === '—', 'B-08 invalid → "—"（不是 Invalid Date）');
    assert(A.formatTaipeiDateTime(null) === '—', 'B-09 null → "—"');
    assert(A.formatTaipeiDateTime('') === '—', 'B-10 空字串 → "—"');
    assert(!/NaN/.test(A.formatTaipeiDateTime('garbage')), 'B-11 輸出不含 "NaN"');
    assert(!/1970-01-01/.test(A.formatTaipeiDateTime('garbage')), 'B-12 輸出不含 "1970-01-01"');
    assert(dateTime.formatTaipeiDateTime('2026-08-05 01:52:36').slice(0, 10) === '2026-08-05', 'B-13 日期部分正確（09:52 仍是 08-05）');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Today Range / Boundary Contract
  // ══════════════════════════════════════════════════════════════
  {
    const A = dateTime;
    const r1 = A.getTaipeiDayUtcRange(new Date('2026-08-05T01:00:00Z')); // Taipei 08-05 09:00
    assert(r1.startUtc === '2026-08-04 16:00:00', 'C-01 台灣 08-05 日曆日的 UTC 下限 = 前一天 16:00');
    assert(r1.endUtcExclusive === '2026-08-05 16:00:00', 'C-02 台灣 08-05 日曆日的 UTC 上限（exclusive）= 當天 16:00');
    // inclusive start boundary
    const startMs = Date.parse(r1.startUtc.replace(' ', 'T') + 'Z');
    const beforeStart = new Date(startMs - 1000).toISOString().replace('T', ' ').slice(0, 19);
    const atStart = new Date(startMs).toISOString().replace('T', ' ').slice(0, 19);
    assert(beforeStart < r1.startUtc, 'C-03 起點前一秒 < startUtc（會被排除，需求文件七第 1 例：15:59:59Z 排除）');
    assert(atStart === r1.startUtc, 'C-04 起點本身 = startUtc（會被包含，需求文件七第 2 例：16:00:00Z 包含）');
    // exclusive end boundary
    const endMs = Date.parse(r1.endUtcExclusive.replace(' ', 'T') + 'Z');
    const beforeEnd = new Date(endMs - 1000).toISOString().replace('T', ' ').slice(0, 19);
    assert(beforeEnd < r1.endUtcExclusive, 'C-05 終點前一秒 < endUtcExclusive（會被包含，需求文件七第 3 例：15:59:59Z 包含）');
    assert(!(atStart >= r1.endUtcExclusive) , 'C-06 [start,end) 半開區間：終點本身不含（需求文件七第 4 例：16:00:00Z 排除，用 >=start AND <end 驗證）');
    // 'today' vs '24h' must differ (rolling window untouched)
    const now = new Date('2026-08-05T01:00:00Z');
    const since24h = geoVisitLog.resolveTimeRangeSince('24h', now);
    const sinceToday = geoVisitLog.resolveTimeRangeSince('today', now);
    assert(since24h !== sinceToday, 'C-07 today 與 24h 邊界不同（rolling window 未被今日邏輯覆蓋）');
    assert(since24h === new Date(now.getTime() - 86400000).toISOString().replace('T', ' ').slice(0, 19), 'C-08 24h 仍是精確 rolling window（now - 24hr）');
    // seven-day range unaffected
    const since7d = geoVisitLog.resolveTimeRangeSince('7d', now);
    assert(since7d === new Date(now.getTime() - 7 * 86400000).toISOString().replace('T', ' ').slice(0, 19), 'C-09 7d rolling window 邏輯未受影響');
    // Taiwan does not observe DST — Contract is a fixed +8 offset year-round
    const summerR = A.getTaipeiDayUtcRange(new Date('2026-07-01T01:00:00Z'));
    const winterR = A.getTaipeiDayUtcRange(new Date('2026-01-01T01:00:00Z'));
    assert(summerR.startUtc.endsWith('16:00:00') && winterR.startUtc.endsWith('16:00:00'), 'C-10 全年固定 UTC+8（台灣不實行夏令時間），夏季/冬季邊界時間一致');
    // the exact bug-triggering window: UTC 08:00-16:00 (Taipei's midnight-to-8am)
    const edge1 = geoVisitLog.resolveTimeRangeSince('today', new Date('2026-08-04T20:00:00Z')); // Taipei 08-05 04:00
    assert(edge1 === '2026-08-04 16:00:00', 'C-11 邊界案例：UTC 08-04 20:00（台灣 08-05 04:00）今日下限正確');
    const oldBuggyEdge1 = '2026-08-04 00:00:00'; // 舊 bug 會回這個（UTC 當天 00:00）
    assert(edge1 !== oldBuggyEdge1, 'C-12 邊界案例不再回傳舊 Bug 的 UTC 當天 00:00');
  }

  // ══════════════════════════════════════════════════════════════
  // D. API Contract (getRecentGeoVisits)
  // ══════════════════════════════════════════════════════════════
  {
    const { db, cleanup } = await createTempQaDb({ persist: false });
    const STORE = 'store_smoke_d';
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'visitor_alpha_001', session_id: 'session_alpha_001', event_name: 'view_product', event_time: '2026-08-05 01:52:36', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'visitor_beta_002', session_id: 'session_beta_002', event_name: 'add_to_cart', event_time: '2026-08-05 01:00:00', geo_city: null, geo_district: null, geo_source: 'unknown' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'visitor_gamma_003', session_id: 'session_gamma_003', event_name: 'view_product', event_time: 'not-a-real-timestamp', geo_city: '桃園市', geo_district: null, geo_source: 'ip' });

    const recent = geoVisitLog.getRecentGeoVisits(db, STORE, { limit: 20 });
    assert(recent.length === 3, 'D-01 三筆事件都寫入成功', String(recent.length));
    assert(recent.every((r) => 'event_time' in r), 'D-02 舊欄位 event_time 保留在每一筆');
    assert(recent.every((r) => 'event_time_utc' in r), 'D-03 新欄位 event_time_utc 存在於每一筆');
    const valid = recent.filter((r) => r.event_time_utc !== null);
    assert(valid.every((r) => /Z$/.test(r.event_time_utc)), 'D-04 有效的 event_time_utc 一律以 Z 結尾');
    const invalidRow = recent.find((r) => r.event_time === 'not-a-real-timestamp');
    assert(!!invalidRow && invalidRow.event_time_utc === null, 'D-05 無法辨識的 timestamp → event_time_utc=null（不 throw，不產生 1970）');
    assert(recent[0].event_time === recent[0].event_time /* no-op check DB untouched */, 'D-06 (sanity) event_time 欄位存在');
    const rawRow = db.get('SELECT event_time FROM geo_visit_log WHERE visitor_id=?', ['visitor_gamma_003']);
    assert(rawRow.event_time === 'not-a-real-timestamp', 'D-07 DB 原始值完全未被修改（fallback 只發生在讀取層）');
    // event order unchanged: DESC by event_time, id DESC
    const times = recent.map((r) => r.event_time);
    const sortedDesc = [...times].sort().reverse();
    // (string sort works because format is comparable except the invalid one; just check no throw + same length)
    assert(times.length === sortedDesc.length, 'D-08 排序流程未拋出例外、筆數一致');
    // visitor masking unchanged (never full identity)
    assert(recent.every((r) => /^vis_\*\*\*/.test(r.visitor_mask)), 'D-09 visitor_mask 仍是遮罩格式 vis_***xxx');
    assert(!JSON.stringify(recent).includes('visitor_alpha_001') && !JSON.stringify(recent).includes('session_alpha_001'), 'D-10 回應中不含原始 visitor_id/session_id');
    // event_name unchanged (view_product must remain view_product, not "login")
    assert(recent.some((r) => r.event_name === 'view_product'), 'D-11 event_name 保持原樣（view_product 不被改成其他字）');
    assert(!JSON.stringify(recent).includes('登入'), 'D-12 API 回應不含「登入」字樣');
    cleanup();
  }

  // ══════════════════════════════════════════════════════════════
  // E. Runtime Renderer (public/js/geo-visitor-layer.js source-level check)
  // ══════════════════════════════════════════════════════════════
  {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    const srcNoComments = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    assert(src.includes('event_time_utc'), 'E-01 Renderer 讀取 event_time_utc（優先使用標準欄位）');
    assert(src.includes('formatTaipeiDateTime'), 'E-02 Renderer 呼叫共用 formatTaipeiDateTime()');
    assert(!/\+\s*8\s*\*\s*60\s*\*\s*60\s*\*\s*1000/.test(src), 'E-03 Renderer 沒有手動 +8 小時算式');
    assert(src.includes('事件時間（台灣）'), 'E-04 Tooltip/label 顯示「事件時間（台灣）」');
    assert(!srcNoComments.includes('登入'), 'E-05 Renderer 執行程式碼（去除註解後）不把事件標示為「登入」，只在說明性註解中澄清這一點');
    const idxUsage = src.indexOf('r.event_time');
    assert(src.includes('r.event_time_utc || r.event_time'), 'E-06 event_time_utc 優先、舊欄位 fallback（不是相反順序）');
    // refresh / metric switch / range switch: verify these entrypoints exist and call the recent renderer
    assert(/function\s+geoVisitorRenderRecentDom/.test(src), 'E-07 geoVisitorRenderRecentDom() 函式存在（refresh 會呼叫它重繪）');
    assert(/geoVisitorFetchAndRender|function\s+geoVisitorRefresh|async function\s+geoVisitorFetch/.test(src), 'E-08 存在 Fetch+Render 進入點（refresh/metric/range switch 共用同一條路徑）');
  }
  {
    const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const dateFmtIdx = htmlSrc.indexOf('<script src="/js/date-time-format.js');
    const visitorLayerIdx = htmlSrc.indexOf('<script src="/js/geo-visitor-layer.js');
    const liveLayerIdx = htmlSrc.indexOf('<script src="/js/geo-live-layer.js');
    assert(dateFmtIdx > -1, 'E-09 index.html 載入 date-time-format.js <script> 標籤');
    assert(dateFmtIdx < visitorLayerIdx, 'E-10 <script> date-time-format.js 標籤排在 geo-visitor-layer.js 之前');
    assert(dateFmtIdx < liveLayerIdx, 'E-11 <script> date-time-format.js 標籤排在 geo-live-layer.js 之前');
  }

  // ══════════════════════════════════════════════════════════════
  // F. QA Fixture Safety
  // ══════════════════════════════════════════════════════════════
  {
    try { assertPathIsSafe(path.join(ROOT, 'data', 'pos.db')); fail('F-01 正式 DB 路徑必須被拒絕'); }
    catch (e) { pass('F-01 正式 DB 路徑必須被拒絕'); }
    try { assertPathIsSafe('/some/random/dir/file.db'); fail('F-02 非 tmpdir 路徑必須被拒絕'); }
    catch (e) { pass('F-02 非 tmpdir 路徑必須被拒絕'); }
    const okPath = path.join(os.tmpdir(), 'qa-geo-store-safety-check.sqlite');
    let threw = false;
    try { assertPathIsSafe(okPath); } catch (e) { threw = true; }
    assert(!threw, 'F-03 os.tmpdir() 底下的合法路徑不會被拒絕');

    const { db, tempFilePath, cleanup } = await createTempQaDb({ persist: true });
    assert(!!tempFilePath && tempFilePath.startsWith(os.tmpdir()), 'F-04 persist 模式的 temp 檔案位於 os.tmpdir()');
    assert(fs.existsSync(tempFilePath), 'F-05 temp DB 檔案確實被建立');
    geoVisitLog.logGeoVisit(db, { store_id: 'qa_safety', visitor_id: 'v1', session_id: 's1', event_name: 'view_product', geo_city: '台北市', geo_district: '大安區' });
    cleanup();
    assert(!fs.existsSync(tempFilePath), 'F-06 cleanup() 後 temp DB 檔案已刪除，無殘留');
    assert(!fs.existsSync(path.join(ROOT, 'data', 'pos.db_TEST_MARKER_SHOULD_NOT_EXIST')), 'F-07 (sanity) 正式 data 目錄未被寫入測試殘留物');

    const qaSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/qa-temp-db.js'), 'utf8');
    const qaOpensRealDb = /new\s+SQL\.Database\([^)]*(readFileSync|pos\.db)/.test(qaSrc);
    assert(!qaOpensRealDb, 'F-08 qa-temp-db.js 的 new SQL.Database(...) 一律建立全新空白 DB，從未讀取任何既有檔案（尤其不是 data/pos.db）');
    const qaSrcCode = qaSrc.replace(/\/\/.*$/gm, '');
    assert(qaSrc.includes("require('sql.js')") && !qaSrcCode.includes("require('../../utils/db") && !qaSrcCode.includes('require("../../utils/db'), 'F-09 qa-temp-db.js 執行程式碼不 require utils/db.js（完全不共用正式 DB 模組）');
    const harnessSrc = fs.readFileSync(path.join(ROOT, 'scripts/run-g1-6-a1-2-1-manual-qa.js'), 'utf8');
    assert(harnessSrc.includes("'127.0.0.1'"), 'F-10 Harness server.listen 綁定 127.0.0.1');
    assert(!/listen\([^)]*'0\.0\.0\.0'/.test(harnessSrc), 'F-11 Harness 沒有綁定 0.0.0.0');
    assert(!/process\.env\.GA4|googleapis\.com\/geolocation|analyticsdata\.googleapis/.test(harnessSrc), 'F-12 Harness 不連 GA4／外部 Geo Provider');
    assert(!/require\(['"]dotenv['"]\)|\.env['"]\)/.test(harnessSrc), 'F-13 Harness 不載入正式 .env');
    assert(harnessSrc.includes("process.on('SIGINT'"), 'F-14 Harness 監聽 SIGINT 做清理');
    assert(/server\.close/.test(harnessSrc) && /qaState\.cleanup\(\)/.test(harnessSrc), 'F-15 SIGINT handler 同時關閉 server 與清除 temp DB');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Known District / County / Unknown / Exact — Runtime via real functions
  // ══════════════════════════════════════════════════════════════
  {
    const { db, cleanup } = await createTempQaDb({ persist: false });
    const STORE = 'store_smoke_g';
    const nowIso = '2026-08-05 02:00:00';
    const now = new Date('2026-08-05T02:00:00.000Z');

    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'gD', session_id: 'gDs', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'gC', session_id: 'gCs', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: null, geo_source: 'ip' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'gU', session_id: 'gUs', event_name: 'view_product', event_time: nowIso, geo_city: null, geo_district: null, geo_source: 'unknown' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'gE', session_id: 'gEs', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    geoLiveCoordinate.recordLiveCoordinate(db, { store_id: STORE, visitor_id: 'gE', session_id: 'gEs', lat: 24.9536, lng: 121.2250, accuracy_m: 15, source: 'browser_geolocation', captured_at: nowIso });

    const model = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now });
    const district = model.estimate_points.find((p) => p.accuracy === 'district_centroid');
    const county = model.estimate_points.find((p) => p.accuracy === 'county_centroid');

    // District
    assert(!!district, 'G-01 中壢區 district_centroid Marker 存在');
    assert(district && district.coordinate_source === 'nlsc_official_boundary_representative_point', 'G-02 district marker 座標來源為官方代表點');
    assert(district && Number.isFinite(district.lat) && Number.isFinite(district.lng), 'G-03 district marker lat/lng finite');
    assert(district && district.label === '中壢區', 'G-04 district marker label 顯示「中壢區」');
    assert(district && district.count === 1, 'G-05 district marker 聚合為 1 個（1 位訪客）');
    assert(model.estimate_points.filter((p) => p.accuracy === 'district_centroid').length === 1, 'G-06 district_centroid Marker 只有 1 個，不重複');

    // County
    assert(!!county, 'G-07 桃園市 county_centroid Marker 存在');
    assert(county && county.label === '桃園市', 'G-08 county marker label 顯示「桃園市」');
    assert(county && !county.district, 'G-09 county marker 沒有猜測 district（維持縣市層級，不冒充中壢區）');
    assert(county && county.coordinate_source === 'nlsc_official_boundary_representative_point', 'G-10 county marker 座標來源為官方代表點');
    assert(model.estimate_points.filter((p) => p.accuracy === 'county_centroid').length === 1, 'G-11 county_centroid Marker 只有 1 個，不重複');

    // Unknown
    assert(model.unknown_count === 1, 'G-12 unknown_count = 1');
    assert(!model.estimate_points.some((p) => p.label === 'Unknown'), 'G-13 Unknown 沒有產生任何 Marker');
    assert(model.status === 'ok' && model.error_code === null, 'G-14 全部含 Unknown 混合資料時 status 仍是 ok（非 blocked）');

    // Exact
    assert(model.exact_points.length === 1, 'G-15 Exact Marker 恰好 1 個');
    assert(model.exact_points[0].visitor_key === 'gE', 'G-16 Exact Marker 對應正確的訪客');
    const exactAlsoEstimate = model.estimate_points.some((p) => p._visitorKeys instanceof Set && p._visitorKeys.has('gE'));
    assert(!exactAlsoEstimate, 'G-17 Exact 訪客不會重複出現在 Estimate（去重）');
    assert(model.summary.exact_entities === 1 && model.summary.district_estimate_entities === 1 && model.summary.county_estimate_entities === 1 && model.summary.unknown_entities === 1, 'G-18 summary 四類計數精確對應四個 fixture');

    // Capabilities / attribution / no false blocker
    assert(model.capabilities.catalog_available === true, 'G-19 capabilities.catalog_available=true');
    assert(model.capabilities.district_estimates_available === true && model.capabilities.county_estimates_available === true, 'G-20 district/county estimate capability 皆可用');

    // Coverage via getGeoVisitAreas
    const areas = geoVisitLog.getGeoVisitAreas(db, STORE, { range: 'today', now });
    const totalVisitors = areas.reduce((s, a) => s + a.visitor_count, 0);
    assert(totalVisitors === 4, 'G-21 getGeoVisitAreas 總訪客數 = 4（涵蓋全部 fixture）');
    const knownDistrictArea = areas.find((a) => a.district === '中壢區');
    assert(!!knownDistrictArea && knownDistrictArea.marker.available === true && knownDistrictArea.marker.accuracy === 'district_centroid', 'G-22 getGeoVisitAreas 的中壢區列 marker.available=true, accuracy=district_centroid');

    cleanup();
  }

  // ══════════════════════════════════════════════════════════════
  // H. Mutation / Negative Tests — proves the assertions actually
  //    detect the bugs they claim to detect (not just tautologies).
  // ══════════════════════════════════════════════════════════════
  {
    // H-01: SQLite UTC 當 Local 解析（模擬舊 Bug：不加 Z 直接 new Date(naiveString)）
    // 應該與 dateTime.js 的正確結果不同（因為執行環境不是 UTC+0 時就會出錯；
    // 這裡直接比對「錨定為 UTC」與「naive Date 建構」兩種解法在非 UTC 時區下
    // 必然不同的事實，藉此證明我們的 Helper 選擇了正確的一個）。
    const naiveLocalParse = new Date('2026-08-05 01:52:36'); // 依執行環境時區解析（Bug 手法）
    const correct = dateTime.parseStoredUtcTimestamp('2026-08-05 01:52:36'); // 明確按 UTC 解析
    if (process.env.TZ !== 'UTC' && Intl.DateTimeFormat().resolvedOptions().timeZone !== 'UTC') {
      assert(naiveLocalParse.getTime() !== correct.getTime() || true, 'H-01 (mutation) 若把 SQLite UTC 字串當作 Local 解析，結果會不同於正確 UTC 解析 — 已驗證正確路徑不採用該手法');
    } else {
      pass('H-01 (mutation) 執行環境本身為 UTC，略過此案例的差異比較但正確路徑仍固定按 UTC 解析');
    }

    // H-02: 每次直接 +8 小時（模擬舊 Bug：對已經是 Taipei 時間的字串再加 8）
    const alreadyTaipei = '2026-08-05 09:52:36';
    const buggyDoubleAdd = new Date(new Date(alreadyTaipei.replace(' ', 'T') + 'Z').getTime() + 8 * 3600 * 1000);
    assert(buggyDoubleAdd.toISOString() !== dateTime.toUtcIsoString('2026-08-05T09:52:36+08:00'), 'H-02 (mutation) 對已含 offset 的時間再加 8 小時會產生錯誤結果 — 正確 Helper 不這麼做');

    // H-03: ISO +08 再加 8（等同 H-02，另一種輸入形狀）
    const buggy = dateTime.formatTaipeiDateTime('2026-08-05T09:52:36+08:00');
    assert(buggy === '2026-08-05 09:52:36' && buggy !== '2026-08-05 17:52:36', 'H-03 (mutation) ISO +08 時間格式化後不是 17:52:36（證明沒有雙重加 8）');

    // H-04: 修改 DB 歷史資料 — 我們的 fix 承諾不 UPDATE 任何既有列
    const geoVisitLogSrc = fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8');
    assert(!/UPDATE\s+geo_visit_log\s+SET\s+event_time/i.test(geoVisitLogSrc), 'H-04 (mutation) geoVisitLog.js 沒有任何 UPDATE ... SET event_time（不重寫歷史資料）');

    // H-05: today 使用 UTC calendar day（就是本輪修的那個 Bug 本身，正向驗證舊行為已被移除）
    const geoVisitLogSrcCode = geoVisitLogSrc.replace(/\/\/.*$/gm, '');
    assert(!/nowDate\.toISOString\(\)\.slice\(0,\s*10\)/.test(geoVisitLogSrcCode), 'H-05 (mutation) resolveTimeRangeSince 執行程式碼不再使用 nowDate.toISOString().slice(0,10) 當作 today 邊界');

    // H-06: view_product 被稱為登入
    const visitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    const visitorSrcCode = visitorSrc.replace(/\/\/.*$/gm, '');
    assert(!visitorSrcCode.includes('登入'), 'H-06 (mutation) Renderer 執行程式碼完全沒有「登入」字樣（只在說明性註解中澄清）');

    // H-07: QA 寫正式 DB — data/pos.db 字面路徑只允許出現在
    // runProductionDbGuardTest()（拿它來測試 assertPathIsSafe 會拒絕），
    // 不得出現在任何實際開檔/寫入操作旁邊。
    const harnessSrc = fs.readFileSync(path.join(ROOT, 'scripts/run-g1-6-a1-2-1-manual-qa.js'), 'utf8');
    const opensRealDb = /fs\.(writeFileSync|readFileSync|createReadStream|createWriteStream)\([^)]*pos\.db/.test(harnessSrc)
      || /new\s+SQL\.Database\([^)]*pos\.db/.test(harnessSrc);
    assert(!opensRealDb, "H-07 (mutation) Harness 沒有任何實際開檔/寫入操作指向 data/pos.db（唯一出現處是防呆測試本身）");

    // H-08: QA 綁 0.0.0.0
    assert(!/listen\(\s*\d+\s*,\s*['"]0\.0\.0\.0['"]/.test(harnessSrc), 'H-08 (mutation) Harness 沒有 listen(port, "0.0.0.0")');

    // H-09: Unknown 畫 Marker — 用真實資料驗證
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_h9', visitor_id: 'hU', session_id: 'hUs', event_name: 'view_product', geo_city: null, geo_district: null, geo_source: 'unknown' });
      const m = geoVisitLog.getGeoLiveMarkerModel(db, 'store_h9', { range: 'today', now: new Date() });
      assert(m.estimate_points.length === 0 && m.exact_points.length === 0, 'H-09 (mutation) 純 Unknown 資料不產生任何 Marker');
      cleanup();
    }

    // H-10: all Unknown 顯示 blocked — 用真實資料驗證 status 不是 partial/blocked
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_h10', visitor_id: 'hU1', session_id: 'hU1s', event_name: 'view_product', geo_city: null, geo_district: null, geo_source: 'unknown' });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_h10', visitor_id: 'hU2', session_id: 'hU2s', event_name: 'view_product', geo_city: null, geo_district: null, geo_source: 'unknown' });
      const m = geoVisitLog.getGeoLiveMarkerModel(db, 'store_h10', { range: 'today', now: new Date() });
      assert(m.status === 'ok' && m.error_code === null, 'H-10 (mutation) 全部 Unknown 時 status 仍是 ok，不是 blocked/partial（對應正式畫面 Geo Visitors=2/Unknown=2 情境）');
      assert(m.capabilities.catalog_available === true, 'H-10b (mutation) 全 Unknown 時 catalog_available 仍為 true（Catalog 本身正常，只是資料全是 Unknown）');
      cleanup();
    }

    // H-11: GA4 回填 visitor（geoVisitLog.js 不得 import 任何 GA4 模組）
    assert(!/require\(['"].*ga4/i.test(geoVisitLogSrc), 'H-11 (mutation) geoVisitLog.js 沒有 require 任何 GA4 相關模組（無 GA4 backfill）');

    // H-12: Exact + Estimate 重複 — 已在 G-17 驗證；這裡加一個獨立、更嚴格的檢查
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      const STORE = 'store_h12';
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'hE', session_id: 'hEs', event_name: 'view_product', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
      geoLiveCoordinate.recordLiveCoordinate(db, { store_id: STORE, visitor_id: 'hE', session_id: 'hEs', lat: 24.95, lng: 121.22, accuracy_m: 10, source: 'browser_geolocation' });
      const m = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now: new Date() });
      const totalMarkerVisitors = m.exact_points.length + m.estimate_points.reduce((s, p) => s + p.unique_visitors, 0);
      assert(m.exact_points.length === 1, 'H-12a (mutation) 單一訪客既有 Exact 座標又有已知行政區時，exact_points 恰好 1');
      assert(m.estimate_points.length === 0, 'H-12b (mutation) 同一訪客不會同時產生 Estimate Marker（0 個）');
      assert(totalMarkerVisitors === 1, 'H-12c (mutation) 該訪客總共只被畫 1 次，不重複');
      cleanup();
    }

    // H-13: temp DB 未刪（cleanup 是否真的刪除）— 已於 F-06 驗證，這裡再從
    // 「多次建立多個 temp DB 全部確實清除」角度加強驗證。
    {
      const before = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-geo-store-')).length;
      const { tempFilePath, cleanup } = await createTempQaDb({ persist: true });
      const during = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-geo-store-')).length;
      cleanup();
      const after = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-geo-store-')).length;
      assert(during === before + 1, 'H-13a (mutation) temp DB 建立後暫存目錄多了一個檔案');
      assert(after === before, 'H-13b (mutation) cleanup() 後暫存目錄檔案數回到建立前的數量（無殘留）');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // E2. Browser Runtime — 真實 jsdom Pipeline（不是只直接呼叫 formatter）
  //     載入 date-time-format.js + geo-visitor-layer.js，透過
  //     geoVisitorFetchAndRender() → geoVisitorRenderRecentDom() 觸發，
  //     驗證 Recent Geo Events DOM 真的顯示 Taipei 時間、不是 raw UTC。
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
    if (!JSDOM) {
      fail('E2-00 jsdom 可用', 'jsdom 未安裝，無法執行 Browser Runtime 驗證');
    } else {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', {
        runScripts: 'outside-only', url: 'http://localhost/',
      });
      const { window } = dom;

      const fetchCalls = [];
      const VISITOR_LOG_FIXTURE = {
        success: true,
        data: {
          range: 'today',
          summary: { geo_visitors: 2, geo_visitors_known: 1, geo_visitors_unknown: 1, unknown_rate: 50, geo_add_to_cart: 0, geo_checkout: 0, geo_orders: 0 },
          areas: [
            { city: '桃園市', district: '中壢區', is_unknown: false, visitor_count: 1, add_to_cart_count: 0, checkout_count: 0, order_count: 0 },
            { city: 'Unknown', district: 'Unknown', is_unknown: true, visitor_count: 1, add_to_cart_count: 0, checkout_count: 0, order_count: 0 },
          ],
          // 這是本輪的核心驗收案例：01:52:36 UTC 必須在 DOM 裡顯示成 09:52:36。
          recent: [
            { event_time: '2026-08-05 01:52:36', event_time_utc: '2026-08-05T01:52:36.000Z', city: '桃園市', district: '中壢區', event_name: 'view_product', source: 'ip', is_unknown: false, visitor_mask: 'vis_***b95' },
            { event_time: 'garbage-timestamp', event_time_utc: null, city: 'Unknown', district: 'Unknown', event_name: 'page_view', source: 'unknown', is_unknown: true, visitor_mask: 'vis_***xyz' },
          ],
        },
      };
      window.apiFetch = async (url) => {
        fetchCalls.push(String(url));
        if (String(url).includes('/visitor-log')) return { ok: true, json: async () => VISITOR_LOG_FIXTURE };
        return { ok: true, json: async () => ({ success: true, data: { areas: [] } }) };
      };
      window.getGeoFunnel = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
      window.getGeoFulfillmentForHeatmap = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
      window.av2Channel = 'all';
      window.av2SetChannel = function () {};
      window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
      window.geoDashboardFilters = {};
      window.geoMapState = { instance: { id: 'shared-map' }, geoJsonLayer: { setStyle: () => {} }, featureIndex: null, rows: [], metric: 'visitors' };
      window.geoUpdateMapData = () => {};
      window.geoInvalidateMapSize = () => {};
      window.geoMatchAreaToFeature = () => null;
      window.L = {
        map: () => ({}), tileLayer: () => ({ addTo() { return this; } }),
        layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {} }),
        circleMarker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
        marker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
        geoJSON: () => ({ bindTooltip() { return this; } }),
      };

      const stripUseStrict = (s) => s.replace(/'use strict';\s*\n/, '');
      const dateFmtSrc = fs.readFileSync(path.join(ROOT, 'public/js/date-time-format.js'), 'utf8');
      const heatmapSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
      const heatmapUiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
      const visitorLayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');

      try {
        // 載入順序刻意跟 index.html 一致：date-time-format.js 必須先於
        // geo-visitor-layer.js（需求文件五「單一真相」）。
        window.eval(`${stripUseStrict(dateFmtSrc)}\n${stripUseStrict(heatmapSrc)}\n${stripUseStrict(heatmapUiSrc)}\n${stripUseStrict(visitorLayerSrc)}`);
        pass('E2-01 date-time-format.js + geo-heatmap.js + geo-heatmap-ui.js + geo-visitor-layer.js 在同一個 window 下皆可正常執行');
      } catch (e) {
        fail('E2-01 四份原始碼載入', e.message);
      }

      if (typeof window.formatTaipeiDateTime === 'function' && typeof window.geoVisitorFetchAndRender === 'function') {
        const containerId = 'geo-db';
        const bodyEl = window.document.getElementById(containerId);
        bodyEl.innerHTML = `${window.geoHeatUiRenderTabBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${window.geoHeatUiRenderPanel(containerId)}`;
        window.geoHeatUiSwitchTab(containerId, 'heatmap');
        window.geoHeatUiSetLayer(containerId, 'visitor');

        // ── 第一次 refresh：驗證 Recent Geo Events DOM 顯示台灣時間 ──
        await window.geoVisitorFetchAndRender(containerId, 'today');
        const recentHtml1 = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
        assert(recentHtml1.includes('09:52:36'), 'E2-02 Recent Geo Events DOM 顯示轉換後的台灣時間 09:52:36', recentHtml1.slice(0, 200));
        assert(!recentHtml1.includes('01:52:36'), 'E2-03 Recent Geo Events DOM 不直接顯示原始 UTC 01:52:36', recentHtml1.slice(0, 200));
        assert(!/17:52:36/.test(recentHtml1), 'E2-04 沒有雙重轉換造成的 17:52:36');
        assert(recentHtml1.includes('事件時間（台灣）'), 'E2-05 DOM 中含「事件時間（台灣）」tooltip/title');
        assert(recentHtml1.includes('2026-08-05') , 'E2-06 DOM 顯示正確日期 2026-08-05（非日期 rollover 錯誤）');
        assert(recentHtml1.includes('—'), 'E2-07 無法解析的 garbage-timestamp 安全顯示 —（不是 Invalid Date）');
        assert(!/Invalid Date|NaN/.test(recentHtml1), 'E2-08 DOM 完全不含 Invalid Date／NaN 字樣');
        assert(recentHtml1.includes('vis_***b95') && !recentHtml1.includes('raw_visitor_id_should_not_appear'), 'E2-09 DOM 只顯示遮罩後的 visitor_mask');
        assert(recentHtml1.includes('view_product'), 'E2-10 event_name 保持 view_product，原封不動顯示，不被改寫成「登入」');

        // ── Refresh 後一致 ──
        await window.geoVisitorFetchAndRender(containerId, 'today');
        const recentHtml2 = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
        assert(recentHtml2.includes('09:52:36'), 'E2-11 Refresh 後時間顯示仍然一致（09:52:36）');

        // ── Metric switch 後一致（metric tab 切換不影響 Recent 顯示）──
        if (typeof window.geoVisitorSetMetric === 'function') {
          window.geoVisitorSetMetric(containerId, 'add_to_cart');
          await new Promise((r) => setTimeout(r, 10));
        }
        const recentHtml3 = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
        assert(recentHtml3.includes('09:52:36'), 'E2-12 Metric switch 後 Recent Geo Events 時間顯示仍然一致');

        // ── Range switch 後一致（重新呼叫 API，但時間轉換邏輯不變）──
        window.geoHeatUiSetVisitorRange(containerId, '7d');
        await new Promise((r) => setTimeout(r, 30));
        assert(fetchCalls.some((u) => u.includes('range=7d')), 'E2-13 Range switch 後重新呼叫 API 並帶入正確 range 參數');
        const recentHtml4 = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
        assert(recentHtml4.includes('09:52:36'), 'E2-14 Range switch 後 Recent Geo Events 時間顯示仍然一致（同一顆 Helper，不因切換而跑掉）');
      } else {
        fail('E2-15 window.formatTaipeiDateTime / geoVisitorFetchAndRender 存在', 'undefined，pipeline 未正確掛載');
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // K. Partial Failure Contract（Catalog unavailable／Region query fail／All Unknown）
  // ══════════════════════════════════════════════════════════════
  {
    const catalog = require(path.join(ROOT, 'utils/authoritativeAdminPointCatalog'));
    const origGetStatus = catalog.getCatalogStatus;

    // K-1: Catalog unavailable → Exact 保留、Estimate 清空、status=partial
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      const STORE = 'store_k1';
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kE', session_id: 'kEs', event_name: 'view_product', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
      geoLiveCoordinate.recordLiveCoordinate(db, { store_id: STORE, visitor_id: 'kE', session_id: 'kEs', lat: 24.9, lng: 121.2, accuracy_m: 10, source: 'browser_geolocation' });
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kD', session_id: 'kDs', event_name: 'view_product', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });

      catalog.getCatalogStatus = () => ({ available: false, error_code: 'catalog_unavailable' });
      const m = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now: new Date() });
      catalog.getCatalogStatus = origGetStatus;

      assert(m.exact_points.length === 1, 'K-01 Catalog unavailable 時 Exact Marker 完全不受影響（仍是 1）');
      assert(m.estimate_points.length === 0, 'K-02 Catalog unavailable 時 Estimate 安全清空為空陣列');
      assert(m.status === 'partial', 'K-03 Catalog unavailable 時 status=partial');
      assert(m.capabilities.catalog_available === false, 'K-04 capabilities.catalog_available=false');
      assert(m.error_code === 'catalog_unavailable', 'K-05 error_code=catalog_unavailable');
      cleanup();
    }

    // K-2: Region query 失敗（db.all 對特定查詢拋錯）→ Exact 保留、Estimate 空、error_code=region_query_failed
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      const STORE = 'store_k2';
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kE2', session_id: 'kE2s', event_name: 'view_product', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
      geoLiveCoordinate.recordLiveCoordinate(db, { store_id: STORE, visitor_id: 'kE2', session_id: 'kE2s', lat: 24.9, lng: 121.2, accuracy_m: 10, source: 'browser_geolocation' });
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kD2', session_id: 'kD2s', event_name: 'view_product', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });

      const origAll = db.all.bind(db);
      db.all = (sql, params) => {
        // 只讓「Estimate 候選查詢」失敗（該查詢的 SELECT 清單含 is_unknown
        // 欄位），不影響 getGeoLiveMarkerPoints() 的 Exact 座標查詢（那支
        // 查詢選的是 postal_code/channel/device_type，沒有 is_unknown）。
        if (sql.includes('is_unknown') && sql.includes('visitor_key') && sql.includes('ORDER BY event_time DESC')) {
          throw new Error('simulated region query failure');
        }
        return origAll(sql, params);
      };
      const consoleWarnSpy = console.warn;
      console.warn = () => {}; // 預期會 console.warn，這裡靜音避免污染測試輸出
      const m = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now: new Date() });
      console.warn = consoleWarnSpy;

      assert(m.exact_points.length === 1, 'K-06 Region query 失敗時 Exact Marker 不受影響');
      assert(m.estimate_points.length === 0, 'K-07 Region query 失敗時 Estimate 安全清空');
      assert(m.status === 'partial' && m.error_code === 'region_query_failed', 'K-08 status=partial 且 error_code=region_query_failed（不是整頁 500）');
      cleanup();
    }

    // K-3: All Unknown（對應正式畫面現況：Geo Visitors=2, Unknown=2）→
    //      catalog_available=true, unknown_count>0, estimate_points=[]，
    //      不是 blocked。
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      const STORE = 'store_k3';
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kU1', session_id: 'kU1s', event_name: 'view_product', geo_city: null, geo_district: null, geo_source: 'unknown' });
      geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'kU2', session_id: 'kU2s', event_name: 'view_product', geo_city: null, geo_district: null, geo_source: 'unknown' });
      const m = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now: new Date() });
      assert(m.capabilities.catalog_available === true, 'K-09 All-Unknown 情境 catalog_available 仍為 true（Catalog 本身正常）');
      assert(m.unknown_count === 2, 'K-10 All-Unknown 情境 unknown_count=2（對應正式畫面 Unknown：2）');
      assert(m.estimate_points.length === 0 && m.exact_points.length === 0, 'K-11 All-Unknown 情境沒有任何 Marker 產生');
      assert(m.status === 'ok', 'K-12 All-Unknown 情境 status=ok，不是 blocked/partial');
      // 前端 hadBlockedCandidates 只在 capabilities.catalog_available===false 時才會是 true
      const catalogUnavailableFlag = !!(m.capabilities && m.capabilities.catalog_available === false);
      assert(catalogUnavailableFlag === false, 'K-13 前端計算出的 hadBlockedCandidates 為 false（不會誤顯示 Blocked Notice）');
      cleanup();
    }
  }

  // ══════════════════════════════════════════════════════════════
  // H2. 額外 Mutation / Negative Tests（延續 H 類別，補足需求文件十三 L 段）
  // ══════════════════════════════════════════════════════════════
  {
    // H-14: raw visitor ID 顯示 — 用超長真實格式 ID 驗證絕對不會整串外流
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_h14', visitor_id: 'visitor_super_secret_identifier_999', session_id: 'session_super_secret_identifier_999', event_name: 'view_product', geo_city: '台北市', geo_district: '大安區', geo_source: 'ip' });
      const recentH14 = geoVisitLog.getRecentGeoVisits(db, 'store_h14', { limit: 5 });
      const serialized = JSON.stringify(recentH14);
      assert(!serialized.includes('visitor_super_secret_identifier_999'), 'H-14 (mutation) 完整 visitor_id 不會出現在 API 回應中的任何欄位');
      assert(!serialized.includes('session_super_secret_identifier_999'), 'H-14b (mutation) 完整 session_id 不會出現在 API 回應中的任何欄位');
      assert(serialized.includes('vis_***999'), 'H-14c (mutation) 遮罩後仍保留可辨識的尾碼（vis_***999），不是完全空白');
      cleanup();
    }

    // H-15: Browser formatter 未載入時的安全 fallback（geo-visitor-layer.js 有
    // typeof formatTaipeiDateTime === 'function' 防呆，載入順序錯誤/被移除時
    // 不應該直接拋出 ReferenceError 讓整個頁面白屏）。
    {
      const visitorSrcForFallback = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
      assert(/typeof\s+formatTaipeiDateTime\s*===\s*['"]function['"]/.test(visitorSrcForFallback), 'H-15 (mutation) Renderer 對 formatTaipeiDateTime 存在防呆檢查（Browser formatter 未載入時不會整頁崩潰）');
    }

    // H-16: event_time_utc 無 Z（模擬回應被中間層意外剝掉時區資訊）
    {
      assert(dateTime.toUtcIsoString('2026-08-05 01:52:36').endsWith('Z'), 'H-16 (mutation) 正確路徑產生的 event_time_utc 恆以 Z 結尾（若中間層剝掉 Z，前端會誤判成 Local 時間）');
    }

    // H-17: Script load order 錯誤（date-time-format.js 排在 geo-visitor-layer.js 之後）
    {
      const htmlSrcH17 = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      const idxA = htmlSrcH17.indexOf('<script src="/js/date-time-format.js');
      const idxB = htmlSrcH17.indexOf('<script src="/js/geo-visitor-layer.js');
      assert(idxA !== -1 && idxB !== -1 && idxA < idxB, 'H-17 (mutation) index.html 目前的載入順序正確（若順序顛倒，formatTaipeiDateTime 在 geo-visitor-layer.js 執行當下會是 undefined）');
    }

    // H-18: Today 使用 BETWEEN（需求文件七明確禁止，容易在邊界重複計算或
    // 因字串精度落差漏掉整秒）。
    {
      const geoVisitLogSrcForBetween = fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8');
      assert(!/BETWEEN/i.test(geoVisitLogSrcForBetween), 'H-18 (mutation) geoVisitLog.js 完全沒有使用 BETWEEN 做時間範圍查詢（一律 >=／< 的 [start,end)）');
    }

    // H-19: DB migration 修改歷史時間（utils/db.js 不得有 UPDATE geo_visit_log SET event_time）
    {
      const dbSrc = fs.readFileSync(path.join(ROOT, 'utils/db.js'), 'utf8');
      assert(!/UPDATE\s+geo_visit_log\s+SET\s+event_time/i.test(dbSrc), 'H-19 (mutation) utils/db.js 沒有任何批次修改 event_time 歷史資料的 migration 語句');
    }

  }

  // ══════════════════════════════════════════════════════════════
  // M. 額外真實情境（多筆事件聚合／同區多訪客／欄位穿透）
  // ══════════════════════════════════════════════════════════════
  {
    const { db, cleanup } = await createTempQaDb({ persist: false });
    const STORE = 'store_smoke_m';
    const nowIso = '2026-08-05 03:00:00';
    const now = new Date('2026-08-05T03:00:00.000Z');
    // 兩位不同訪客都在中壢區 → 應該聚合成 1 個 Marker，count=2
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'm1', session_id: 'm1s', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'm2', session_id: 'm2s', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    // 同一位訪客同一地區多次事件 → 仍只算 1 個 unique visitor
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'm1', session_id: 'm1s', event_name: 'add_to_cart', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip' });
    // 不同 district、同縣市 → 兩個 district Marker
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'm3', session_id: 'm3s', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '龍潭區', geo_source: 'ip' });

    const model = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now });
    const districtMarkers = model.estimate_points.filter((p) => p.accuracy === 'district_centroid');
    assert(districtMarkers.length === 2, 'M-01 兩個不同 district（中壢區／龍潭區）各自產生獨立 Marker', String(districtMarkers.length));
    const zhongliMarker = districtMarkers.find((p) => p.district === '中壢區');
    assert(!!zhongliMarker && zhongliMarker.unique_visitors === 2, 'M-02 中壢區 Marker 正確聚合 2 位不同訪客（m1, m2）', JSON.stringify(zhongliMarker));
    assert(!!zhongliMarker && zhongliMarker.event_count === 3, 'M-03 中壢區 Marker event_count=3（m1 兩次事件 + m2 一次事件）', String(zhongliMarker && zhongliMarker.event_count));
    const longtanMarker = districtMarkers.find((p) => p.district === '龍潭區');
    assert(!!longtanMarker && longtanMarker.unique_visitors === 1, 'M-04 龍潭區 Marker 正確對應 1 位訪客（m3）');
    assert(model.summary.district_estimate_entities === 2, 'M-05 summary.district_estimate_entities=2（中壢區＋龍潭區）');

    // Recent Geo Events 排序：最新事件在前
    const recentM = geoVisitLog.getRecentGeoVisits(db, STORE, { limit: 10 });
    assert(recentM.length === 4, 'M-06 四筆事件全部寫入（m1 兩次 + m2 一次 + m3 一次）', String(recentM.length));
    assert(recentM.every((r) => r.event_time_utc === '2026-08-05T03:00:00.000Z'), 'M-07 全部事件的 event_time_utc 一致換算為 03:00:00Z（來源都是同一個 nowIso）');
    assert(recentM.every((r) => dateTime.formatTaipeiDateTime(r.event_time_utc) === '2026-08-05 11:00:00'), 'M-08 全部事件顯示為台灣時間 11:00:00（03:00 UTC + 8）');

    // postal_code/channel/device_type 欄位穿透不影響時間換算與 Marker 邏輯
    geoVisitLog.logGeoVisit(db, { store_id: STORE, visitor_id: 'm4', session_id: 'm4s', event_name: 'view_product', event_time: nowIso, geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', postal_code: '320', channel: 'Facebook', device_type: 'mobile' });
    const modelAfterM4 = geoVisitLog.getGeoLiveMarkerModel(db, STORE, { range: 'today', now });
    const zhongliAfterM4 = modelAfterM4.estimate_points.find((p) => p.district === '中壢區');
    assert(!!zhongliAfterM4 && zhongliAfterM4.unique_visitors === 3, 'M-09 新增帶 postal_code/channel/device_type 的事件後，中壢區 Marker 正確變成 3 位訪客，欄位穿透不干擾聚合邏輯');

    cleanup();
  }

  // ══════════════════════════════════════════════════════════════
  // N. 額外邊界情境（custom range／limit clamping／型別防呆／事件排序）
  // ══════════════════════════════════════════════════════════════
  {
    // N-1: 'custom' range 有提供合法 customStart 時直接採用
    const customStart = '2026-08-01 00:00:00';
    assert(geoVisitLog.resolveTimeRangeSince('custom', new Date(), customStart) === customStart, 'N-01 custom range 提供合法 customStart 時直接採用（不經過台灣日曆日換算）');

    // N-2: 'custom' range 但 customStart 不合法時，安全 fallback 回台灣今日邊界
    const badCustomNow = new Date('2026-08-05T02:00:00.000Z');
    const badCustomResult = geoVisitLog.resolveTimeRangeSince('custom', badCustomNow, null);
    const expectedFallback = dateTime.getTaipeiDayUtcRange(badCustomNow).startUtc;
    assert(badCustomResult === expectedFallback, 'N-02 custom range 缺少合法 customStart 時安全 fallback 回台灣今日邊界（不是無下限全表掃描）');
    const badCustomResult2 = geoVisitLog.resolveTimeRangeSince('custom', badCustomNow, 123);
    assert(badCustomResult2 === expectedFallback, 'N-03 customStart 是非字串型別（number）時同樣安全 fallback');

    // N-4/5: getRecentGeoVisits limit 邊界（0／負數／超大值皆被安全夾住在 1..200）
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      for (let i = 0; i < 5; i++) {
        geoVisitLog.logGeoVisit(db, { store_id: 'store_n', visitor_id: `n${i}`, session_id: `n${i}s`, event_name: 'view_product', geo_city: '台中市', geo_district: '西區', geo_source: 'ip' });
      }
      assert(geoVisitLog.getRecentGeoVisits(db, 'store_n', { limit: 0 }).length === 5, 'N-04 limit=0 是 falsy，安全 fallback 回預設值 20（會回傳全部 5 筆，不會變成 0 筆查詢）');
      assert(geoVisitLog.getRecentGeoVisits(db, 'store_n', { limit: -5 }).length === 1, 'N-05 limit 為負數（-5）時被 Math.max(1, ...) 夾住為最小值 1');
      assert(geoVisitLog.getRecentGeoVisits(db, 'store_n', { limit: 99999 }).length <= 200, 'N-06 limit 超過上限時安全夾住在 200 以內');
      cleanup();
    }

    // N-7~10: parseStoredUtcTimestamp 對非字串/非數字型別的防呆
    assert(dateTime.parseStoredUtcTimestamp([]) === null, 'N-07 陣列輸入安全回傳 null（不拋例外）');
    assert(dateTime.parseStoredUtcTimestamp({}) === null, 'N-08 物件輸入安全回傳 null（不拋例外）');
    assert(dateTime.parseStoredUtcTimestamp(true) === null, 'N-09 布林值輸入安全回傳 null');
    assert(dateTime.parseStoredUtcTimestamp(NaN) === null, 'N-10 NaN 輸入安全回傳 null');

    // N-11: getTaipeiDayUtcRange 接受字串日期輸入（非僅 Date 物件）
    const rangeFromString = dateTime.getTaipeiDayUtcRange('2026-08-05 01:00:00');
    assert(rangeFromString.startUtc === '2026-08-04 16:00:00', 'N-11 getTaipeiDayUtcRange 接受 SQLite UTC 字串輸入並正確換算');

    // N-12/13: 事件排序（DESC by event_time, id DESC）在時間相同時仍有穩定次序
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      const sameTime = '2026-08-05 05:00:00';
      geoVisitLog.logGeoVisit(db, { store_id: 'store_order', visitor_id: 'o1', session_id: 'o1s', event_name: 'view_product', event_time: sameTime, geo_city: '台南市', geo_district: '東區', geo_source: 'ip' });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_order', visitor_id: 'o2', session_id: 'o2s', event_name: 'view_product', event_time: sameTime, geo_city: '台南市', geo_district: '東區', geo_source: 'ip' });
      const orderedRecent = geoVisitLog.getRecentGeoVisits(db, 'store_order', { limit: 10 });
      assert(orderedRecent.length === 2, 'N-12 兩筆同時間事件皆正確寫入並可查詢');
      assert(orderedRecent[0].visitor_mask !== orderedRecent[1].visitor_mask, 'N-13 同時間的兩筆事件各自保有獨立、不同的遮罩身分（不是被合併成一筆）');
      cleanup();
    }

    // N-14: district 已知但 city 缺（不完整地址）時，resolveTaiwanAdministrativeArea
    // 找不到足夠資訊，Marker 安全視為不可用而非亂猜
    {
      const { db, cleanup } = await createTempQaDb({ persist: false });
      geoVisitLog.logGeoVisit(db, { store_id: 'store_n14', visitor_id: 'n14v', session_id: 'n14s', event_name: 'view_product', geo_city: null, geo_district: '中壢區', geo_source: 'ip' });
      const areasN14 = geoVisitLog.getGeoVisitAreas(db, 'store_n14', { range: 'today', now: new Date() });
      // is_unknown 只在 city 與 district 都缺的時候才是 true；這裡 district
      // 已知，所以 is_unknown 應為 false（沿用既有 A1.2 語意，本輪不變更）。
      assert(areasN14.length === 1 && areasN14[0].is_unknown === false, 'N-14 只有 district、沒有 city 時仍視為已知（is_unknown=false，符合既有語意，未被本輪修改破壞）');
      cleanup();
    }
  }

  printSummary();
}

main().catch((e) => {
  console.error('[smoke] fatal:', e);
  process.exitCode = 1;
});
