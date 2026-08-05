#!/usr/bin/env node
// scripts/run-g1-6-a1-2-1-manual-qa.js
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// Geo Event Taiwan Time & Estimate Marker Verification Hotfix
//
// 完全隔離的 QA Fixture／Harness（需求文件八～十）：驗證「Known District
// 資料進來後，Estimate Marker 是否真的出現」，用真實的
// utils/geoVisitLog.js（getGeoLiveMarkerModel／getGeoVisitAreas／
// getRecentGeoVisits）＋真實的 utils/dateTime.js，資料來源是
// scripts/lib/qa-temp-db.js 建立的隔離 temp DB（絕不是 data/pos.db）。
//
// 用法：
//   node scripts/run-g1-6-a1-2-1-manual-qa.js         → 跑完斷言就結束（CI 用）
//   node scripts/run-g1-6-a1-2-1-manual-qa.js --serve → 額外啟動 127.0.0.1
//                                                        本機 HTTP Server，
//                                                        供人工瀏覽器視覺檢查
//                                                        （Ctrl+C 結束並清除
//                                                        temp DB）。
//
// 誠實揭露：--serve 模式提供的是「真實 API Handler + 真實前端靜態檔案」，
// 不是完整的 Express App（因為 utils/db.js 的 DB_PATH 是寫死的
// data/pos.db，本工具刻意不修改 Production DB Layer，見需求文件九）。
// 這裡的 /api/geo-live/marker-model 與 /api/geo-analytics/visitor-log 端點
// 直接呼叫跟 routes/geo-live.js／routes/analytics-geo.js 完全相同的
// utils/geoVisitLog.js 函式，回應形狀逐欄核對一致；但 Express
// middleware／Session／Feature Gate 這層本身不在本 Harness 覆蓋範圍內。
// 真正在瀏覽器裡打開 Chrome/Edge/Safari 檢查地圖畫面仍是 NOT TESTED（見
// R5.4-G1.6-A1.2.1_MANUAL_QA_CHECKLIST.md）。

'use strict';

const path = require('path');
const http = require('http');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const { createTempQaDb } = require('./lib/qa-temp-db');
const geoVisitLog = require(path.join(ROOT, 'utils/geoVisitLog'));
const geoLiveCoordinate = require(path.join(ROOT, 'utils/geoLiveCoordinate'));
const dateTime = require(path.join(ROOT, 'utils/dateTime'));

const STORE_ID = 'qa_geo_store';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function nowTaipeiMorning() {
  // 固定用一個「台灣上午」的時間點造資料，避免測試本身跨過午夜邊界產生
  // flaky 結果（跟需求文件現場畫面時間帶一致：2026-08-05 09:xx 台灣時間）。
  return new Date('2026-08-05T02:00:00.000Z'); // = 2026-08-05 10:00:00 Asia/Taipei
}

async function seedFixtures(db) {
  const now = nowTaipeiMorning();
  const nowIso = now.toISOString().replace('T', ' ').slice(0, 19);

  // A. Known District：桃園市中壢區 → 預期 1 個 district_centroid Estimate Marker
  geoVisitLog.logGeoVisit(db, {
    store_id: STORE_ID, visitor_id: 'qa_v_district', session_id: 'qa_s_district',
    event_name: 'view_product', event_time: nowIso,
    geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip',
  });

  // B. Known County Only：桃園市（無 district）→ 預期 1 個 county_centroid
  //    Estimate Marker。
  geoVisitLog.logGeoVisit(db, {
    store_id: STORE_ID, visitor_id: 'qa_v_county', session_id: 'qa_s_county',
    event_name: 'view_product', event_time: nowIso,
    geo_city: '桃園市', geo_district: null, geo_source: 'ip',
  });

  // C. Unknown：city/district 皆缺 → 預期不畫 Marker，unknown_count +1。
  geoVisitLog.logGeoVisit(db, {
    store_id: STORE_ID, visitor_id: 'qa_v_unknown', session_id: 'qa_s_unknown',
    event_name: 'view_product', event_time: nowIso,
    geo_city: null, geo_district: null, geo_source: 'unknown',
  });

  // D. Exact Control：有合法 lat/lng（geo_live_coordinates）且同時也有
  //    中壢區 → 預期只畫 Exact，不得同時畫 Estimate（去重）。
  geoVisitLog.logGeoVisit(db, {
    store_id: STORE_ID, visitor_id: 'qa_v_exact', session_id: 'qa_s_exact',
    event_name: 'view_product', event_time: nowIso,
    geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip',
  });
  geoLiveCoordinate.recordLiveCoordinate(db, {
    store_id: STORE_ID, visitor_id: 'qa_v_exact', session_id: 'qa_s_exact',
    lat: 24.9536, lng: 121.2250, accuracy_m: 20, source: 'browser_geolocation',
    captured_at: nowIso,
  });

  return { now, nowIso };
}

async function runAssertions() {
  const { db, cleanup } = await createTempQaDb({ persist: false });
  try {
    const { now } = await seedFixtures(db);
    const opts = { range: 'today', now };

    // ── 8-6/7/8/9: Known District ───────────────────────────────
    const model = geoVisitLog.getGeoLiveMarkerModel(db, STORE_ID, opts);
    assert(model.status === 'ok', 'QA-01 marker-model status=ok（Catalog 可用，非 Blocked）', JSON.stringify(model.status));
    assert(model.capabilities.catalog_available === true, 'QA-02 capabilities.catalog_available=true');
    assert(model.exact_points.length === 1, 'QA-03 exact_points 恰好 1 個（Exact Control）', String(model.exact_points.length));

    const districtMarkers = model.estimate_points.filter((p) => p.accuracy === 'district_centroid');
    const countyMarkers = model.estimate_points.filter((p) => p.accuracy === 'county_centroid');
    assert(districtMarkers.length === 1, 'QA-04 district_centroid Estimate Marker 恰好 1 個（中壢區）', String(districtMarkers.length));
    assert(countyMarkers.length === 1, 'QA-05 county_centroid Estimate Marker 恰好 1 個（桃園市無 district）', String(countyMarkers.length));
    if (districtMarkers[0]) {
      assert(districtMarkers[0].coordinate_source === 'nlsc_official_boundary_representative_point', 'QA-06 district marker coordinate_source 為官方代表點');
      assert(Number.isFinite(districtMarkers[0].lat) && Number.isFinite(districtMarkers[0].lng), 'QA-07 district marker 有合法 lat/lng');
    }
    if (countyMarkers[0]) {
      assert(!countyMarkers[0].district, 'QA-08 county marker 沒有猜 district（維持縣市層級）');
    }

    // ── Unknown 政策 ──────────────────────────────────────────
    assert(model.unknown_count === 1, 'QA-09 unknown_count = 1（只有 qa_v_unknown）', String(model.unknown_count));
    const allMarkerVisitorCount = model.exact_points.length + model.estimate_points.reduce((s, p) => s + p.unique_visitors, 0);
    assert(allMarkerVisitorCount === 3, 'QA-10 Unknown 訪客完全沒有貢獻任何 Marker（3 = exact 1 + district 1 + county 1）', String(allMarkerVisitorCount));

    // ── Exact/Estimate 去重（qa_v_exact 不得又出現在 estimate_points）──
    const exactKeys = new Set(model.exact_points.map((p) => p.visitor_key));
    const estimateHasExactVisitor = model.estimate_points.some((p) => p._visitorKeys instanceof Set && [...p._visitorKeys].some((k) => exactKeys.has(k)));
    assert(!estimateHasExactVisitor, 'QA-11 Exact Control 訪客不會同時出現在 estimate_points（去重）');
    assert(model.summary.exact_entities === 1 && model.summary.district_estimate_entities === 1 && model.summary.county_estimate_entities === 1 && model.summary.unknown_entities === 1,
      'QA-12 summary 四個計數與四個 fixture entity 一一對應', JSON.stringify(model.summary));

    // ── getGeoVisitAreas（Visitor Ranking / Coverage 面板）────────
    const areas = geoVisitLog.getGeoVisitAreas(db, STORE_ID, opts);
    const knownAreas = areas.filter((a) => !a.is_unknown);
    const unknownAreas = areas.filter((a) => a.is_unknown);
    assert(knownAreas.length >= 2, 'QA-13 getGeoVisitAreas 回傳中壢區與桃園市兩個已知區域', String(knownAreas.length));
    assert(unknownAreas.length === 1 && unknownAreas[0].visitor_count === 1, 'QA-14 getGeoVisitAreas Unknown 區塊 visitor_count=1');

    // ── getRecentGeoVisits（Recent Geo Events：時間轉換驗證）────────
    const recent = geoVisitLog.getRecentGeoVisits(db, STORE_ID, { limit: 20 });
    assert(recent.length === 4, 'QA-15 getRecentGeoVisits 回傳 4 筆（4 個 fixture entity 各 1 個事件）', String(recent.length));
    recent.forEach((r, i) => {
      assert(!!r.event_time, `QA-16-${i} 舊欄位 event_time 仍存在（向後相容）`);
      assert(!!r.event_time_utc, `QA-17-${i} 新欄位 event_time_utc 存在`);
      assert(/Z$/.test(r.event_time_utc || ''), `QA-18-${i} event_time_utc 以 Z 結尾（ISO UTC）`);
      const taipei = dateTime.formatTaipeiDateTime(r.event_time_utc);
      assert(taipei === '2026-08-05 10:00:00', `QA-19-${i} 換算 Asia/Taipei 顯示為 2026-08-05 10:00:00`, taipei);
      assert(!/^vis_/.test(r.visitor_mask) === false && !r.visitor_mask.includes('qa_v_'), `QA-20-${i} visitor_mask 已遮罩，不洩漏原始 visitor_id`, r.visitor_mask);
    });

    // ── resolveTimeRangeSince('today') Taipei 邊界（核心 Bug 修正）────
    const sinceToday = geoVisitLog.resolveTimeRangeSince('today', now);
    const expectedRange = dateTime.getTaipeiDayUtcRange(now);
    assert(sinceToday === expectedRange.startUtc, 'QA-21 resolveTimeRangeSince(today) 使用台灣日曆日 00:00 換算的 UTC 邊界（不是 UTC 日曆日）', `${sinceToday} vs ${expectedRange.startUtc}`);
    // 2026-08-05T02:00Z 是台灣 2026-08-05 10:00，UTC 日曆日一樣是 08-05——
    // 換一個真正會暴露舊 Bug 的時間點：UTC 08-04 20:00（台灣 08-05 04:00）。
    const edgeCase = new Date('2026-08-04T20:00:00.000Z');
    const sinceEdge = geoVisitLog.resolveTimeRangeSince('today', edgeCase);
    const oldBuggyValue = `${edgeCase.toISOString().slice(0, 10)} 00:00:00`; // 舊實作會回這個（錯誤的 UTC 日曆日）
    assert(sinceEdge !== oldBuggyValue, 'QA-22 邊界案例（UTC 08-04 20:00＝台灣 08-05 04:00）不再使用錯誤的 UTC 日曆日', sinceEdge);
    assert(sinceEdge === '2026-08-04 16:00:00', 'QA-23 邊界案例的 today 下限正確等於台灣 08-05 00:00 換算的 UTC 16:00（前一天）', sinceEdge);

    // ── 24h rolling window 不受影響 ──────────────────────────────
    const since24h = geoVisitLog.resolveTimeRangeSince('24h', now);
    const expected24h = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    assert(since24h === expected24h, 'QA-24 24h 仍是 rolling window，未被台灣今日邏輯覆蓋', since24h);

    return { db, cleanup, model, areas, recent };
  } catch (e) {
    fail('QA-FATAL harness 執行未拋出未預期例外', e.stack || e.message);
    cleanup();
    throw e;
  }
}

// ── 正式 DB 拒絕測試（需求文件八之 4）──────────────────────────────
function runProductionDbGuardTest() {
  const { assertPathIsSafe } = require('./lib/qa-temp-db');
  try {
    assertPathIsSafe(path.join(ROOT, 'data', 'pos.db'));
    fail('QA-25 指向 data/pos.db 的路徑必須被拒絕', '未拋出例外');
  } catch (e) {
    pass('QA-25 指向 data/pos.db 的路徑必須被拒絕');
  }
  try {
    assertPathIsSafe(path.join(ROOT, 'somewhere', 'not-tmp.db'));
    fail('QA-26 非 os.tmpdir() 底下的路徑必須被拒絕', '未拋出例外');
  } catch (e) {
    pass('QA-26 非 os.tmpdir() 底下的路徑必須被拒絕');
  }
}

function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('MANUAL QA HARNESS SUMMARY — R5.4-G1.6-A1.2.1 Known District Estimate Marker Verification');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ── --serve 模式：啟動 127.0.0.1 本機 Server 供人工瀏覽器檢查 ─────────
function startServeMode(qaState) {
  const { db } = qaState;
  const opts = { range: 'today', now: nowTaipeiMorning() };

  const server = http.createServer((req, res) => {
    const url = req.url.split('?')[0];
    if (url === '/api/geo-live/marker-model') {
      const model = geoVisitLog.getGeoLiveMarkerModel(db, STORE_ID, opts);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: model }));
      return;
    }
    if (url === '/api/geo-analytics/visitor-log') {
      const summary = geoVisitLog.getGeoVisitSummary(db, STORE_ID, opts);
      const areas = geoVisitLog.getGeoVisitAreas(db, STORE_ID, opts);
      const recent = geoVisitLog.getRecentGeoVisits(db, STORE_ID, { limit: 20 });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, data: { range: 'today', summary, areas, recent } }));
      return;
    }
    // 靜態檔案：直接從 public/ 讀，供人工在瀏覽器打開頁面用（僅供視覺
    // 檢查排版，不代表這裡已經完整接線 Dashboard 的 Tab/Auth/Session）。
    let filePath = path.join(ROOT, 'public', url === '/' ? '/qa-index.html' : url);
    if (!filePath.startsWith(path.join(ROOT, 'public'))) { res.writeHead(403); res.end('forbidden'); return; }
    fs.readFile(filePath, (err, content) => {
      if (err) { res.writeHead(404); res.end('not found: ' + url); return; }
      res.writeHead(200);
      res.end(content);
    });
  });

  // 只綁 127.0.0.1，隨機 Port（需求文件九之 6）。
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    console.log('\n----------------------------------------------------------------------');
    console.log(`QA Manual Browser Harness 已啟動：http://127.0.0.1:${port}/`);
    console.log(`  GET http://127.0.0.1:${port}/api/geo-live/marker-model`);
    console.log(`  GET http://127.0.0.1:${port}/api/geo-analytics/visitor-log`);
    console.log('  Ctrl+C 結束並清除 temp DB。');
    console.log('----------------------------------------------------------------------\n');
  });

  process.on('SIGINT', () => {
    console.log('\n[qa-harness] 收到 Ctrl+C，清除 temp DB 並結束...');
    server.close(() => {
      qaState.cleanup();
      process.exit(0);
    });
  });
}

async function main() {
  runProductionDbGuardTest();
  const qaState = await runAssertions();
  printSummary();

  if (process.argv.includes('--serve')) {
    startServeMode(qaState);
    return; // 保持 process 活著直到 Ctrl+C
  }
  qaState.cleanup();
}

main().catch((e) => {
  console.error('[qa-harness] fatal:', e);
  process.exitCode = 1;
});
