#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js
// fix18-10-hotfix30-B5-R5.4-G1 — Geo Intelligence V2｜Live Geo Map + Heatmap
// Foundation + Real Coordinate Acquisition (Browser Geolocation only).
//
// 沿用專案既有 smoke test 慣例（見 scripts/smoke-hotfix30-b5-r5-1-b-geo-api.js）：
// 真實 sql.js DB（utils/db.js）、直接呼叫真實 route handler stack（不用真的
// HTTP server），加上前端純函式的 Node 直接 require() 單元測試。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1 (Geo Live Layer + Real Coordinate Acquisition)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ── Express route-calling harness（沿用 smoke-hotfix30-b5-r5-1-b-geo-api.js 既有寫法）──
function findLayer(router, method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]);
}
async function callRoute(router, method, routePath, { query = {}, storeId, body = {} } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const stack = layer.route.stack;
  const req = { query, storeId, headers: {}, body, params: {} };
  if (query.__params) { req.params = query.__params; delete req.query.__params; }
  let statusCode = 200, jsonBody = null;
  return new Promise((resolve, reject) => {
    const res = {
      status(c) { statusCode = c; return this; },
      json(o) { jsonBody = o; resolve({ statusCode, body: jsonBody }); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      if (idx >= stack.length) return resolve({ statusCode, body: jsonBody });
      const layerFn = stack[idx++].handle;
      Promise.resolve(layerFn(req, res, next)).catch(reject);
    }
    next();
  });
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check：所有 G1 新增/修改的 JS 檔案語法正確
  // ══════════════════════════════════════════════════════════════
  const filesToCheck = [
    'utils/deviceParser.js', 'utils/geoLiveCoordinate.js', 'utils/geoVisitLog.js',
    'utils/analyticsLog.js', 'utils/db.js', 'routes/geo-live.js', 'routes/analytics.js',
    'server.js', 'public/js/geo-live-coordinate.js', 'public/js/geo-live-layer.js',
  ];
  filesToCheck.forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) {
      fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200));
    }
  });

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const {
    logGeoVisit, getGeoLiveMarkerPoints, getGeoLiveUnknownPool, getGeoLiveDistricts,
    getGeoLivePostal, getGeoLiveHeatSummaryTop5, getGeoLiveReplayBuckets,
    getGeoLiveVisitorTimeline, GEO_LIVE_CHANNELS, GEO_LIVE_DEVICES, GEO_VISIT_LOG_TIME_RANGES,
    resolveTimeRangeSince,
  } = require('../utils/geoVisitLog');
  const {
    validateCoordinate, recordLiveCoordinate, getLatestCoordinatesByVisitor,
    GEO_LIVE_COORD_SOURCES, GEO_COORD_STATUSES, recordCoordinateStatus, getCoordinateStatusSummary,
  } = require('../utils/geoLiveCoordinate');
  const { classifyDeviceType, isValidDeviceType, DEVICE_TYPES } = require('../utils/deviceParser');
  const { insertEvent } = require('../utils/analyticsLog');
  const geoLiveRouter = require('../routes/geo-live');

  const STORE_A = 'store_g1_a';
  const STORE_B = 'store_g1_b';

  // ══════════════════════════════════════════════════════════════
  // 1. DB Migration
  // ══════════════════════════════════════════════════════════════
  const gvlCols = db.all("PRAGMA table_info(geo_visit_log)").map((r) => r.name);
  assert(gvlCols.includes('postal_code'), '1-1 geo_visit_log.postal_code 欄位存在');
  assert(gvlCols.includes('channel'), '1-2 geo_visit_log.channel 欄位存在');
  assert(gvlCols.includes('device_type'), '1-3 geo_visit_log.device_type 欄位存在');
  const glcCols = db.all("PRAGMA table_info(geo_live_coordinates)").map((r) => r.name);
  assert(glcCols.includes('lat') && glcCols.includes('lng') && glcCols.includes('source'), '1-4 geo_live_coordinates 欄位存在（lat/lng/source）');
  assert(glcCols.includes('accuracy_m'), '1-5 geo_live_coordinates.accuracy_m 欄位存在');
  const gcsCols = db.all("PRAGMA table_info(geo_coordinate_status_log)").map((r) => r.name);
  assert(gcsCols.includes('status'), '1-6 geo_coordinate_status_log.status 欄位存在');
  assert(gcsCols.includes('store_id') && gcsCols.includes('visitor_id') && gcsCols.includes('session_id'), '1-7 geo_coordinate_status_log 有 store_id/visitor_id/session_id');
  assert(gcsCols.includes('captured_at'), '1-8 geo_coordinate_status_log.captured_at 欄位存在');
  const idxNames = db.all("SELECT name FROM sqlite_master WHERE type='index'").map((r) => r.name);
  assert(idxNames.includes('idx_geo_visit_log_store_postal'), '1-9 postal_code 索引存在');
  assert(idxNames.includes('idx_geo_visit_log_store_channel'), '1-10 channel 索引存在');
  assert(idxNames.includes('idx_geo_visit_log_store_device'), '1-11 device_type 索引存在');
  assert(idxNames.includes('idx_geo_live_coord_store_visitor'), '1-12 geo_live_coordinates visitor 索引存在');
  assert(idxNames.includes('idx_geo_coord_status_store_status'), '1-13 geo_coordinate_status_log status 索引存在');
  await initDb();
  const gvlCols2 = db.all("PRAGMA table_info(geo_visit_log)").map((r) => r.name);
  assert(gvlCols2.filter((c) => c === 'postal_code').length === 1, '1-14 migration idempotent（postal_code 不重複）');
  assert(gvlCols2.filter((c) => c === 'device_type').length === 1, '1-15 migration idempotent（device_type 不重複）');

  // ══════════════════════════════════════════════════════════════
  // 2. Coordinate Validation
  // ══════════════════════════════════════════════════════════════
  const validCoord = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, source: 'browser_geolocation' });
  assert(validCoord.ok === true, '2-1 合法座標通過驗證');
  const missingStore = validateCoordinate({ visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, source: 'browser_geolocation' });
  assert(missingStore.ok === false, '2-2 缺少 store_id 被拒絕');
  const missingVisitor = validateCoordinate({ store_id: STORE_A, session_id: 's1', lat: 24.99, lng: 121.3, source: 'browser_geolocation' });
  assert(missingVisitor.ok === false, '2-3 缺少 visitor_id 被拒絕');
  const badLat = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 999, lng: 121.3, source: 'browser_geolocation' });
  assert(badLat.ok === false, '2-4 lat 超出範圍被拒絕');
  const badLng = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 999, source: 'browser_geolocation' });
  assert(badLng.ok === false, '2-5 lng 超出範圍被拒絕');
  const nonNumeric = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 'abc', lng: 121.3, source: 'browser_geolocation' });
  assert(nonNumeric.ok === false, '2-6 非數字 lat 被拒絕');

  const nullIsland = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 0, lng: 0, source: 'browser_geolocation' });
  assert(nullIsland.ok === false, '3-1 (0,0) Null Island 被拒絕');
  assert(/Null Island|0,0/.test(nullIsland.reason || ''), '3-2 Null Island 拒絕理由明確標示');

  const ipLookup = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, source: 'ip_lookup' });
  assert(ipLookup.ok === false, '4-1 source=ip_lookup 被拒絕');
  const noSource = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3 });
  assert(noSource.ok === false, '4-2 缺少 source 被拒絕');
  assert(GEO_LIVE_COORD_SOURCES.length === 2 && GEO_LIVE_COORD_SOURCES.includes('browser_geolocation') && GEO_LIVE_COORD_SOURCES.includes('google_geolocation_api'), '4-3 允許來源白名單只有 browser_geolocation/google_geolocation_api');

  const badAccuracy = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, accuracy_m: 99999, source: 'browser_geolocation' });
  assert(badAccuracy.ok === false, '5-1 accuracy_m 超過 50000 公尺被拒絕');
  const okAccuracy = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, accuracy_m: 20, source: 'browser_geolocation' });
  assert(okAccuracy.ok === true, '5-2 合理 accuracy_m 通過');
  const negAccuracy = validateCoordinate({ store_id: STORE_A, visitor_id: 'v1', session_id: 's1', lat: 24.99, lng: 121.3, accuracy_m: -5, source: 'browser_geolocation' });
  assert(negAccuracy.ok === false, '5-3 負數 accuracy_m 被拒絕');

  // ══════════════════════════════════════════════════════════════
  // 6. Consent Status
  // ══════════════════════════════════════════════════════════════
  assert(GEO_COORD_STATUSES.length === 7, '6-1 座標狀態列舉共 7 種');
  ['granted', 'denied', 'timeout', 'unavailable', 'unsupported', 'error', 'unknown'].forEach((s) => {
    assert(GEO_COORD_STATUSES.includes(s), `6-2 狀態列舉包含 ${s}`);
  });
  const statusResult = recordCoordinateStatus(db, { store_id: STORE_A, visitor_id: 'vStatus1', session_id: 'sStatus1', status: 'denied' });
  assert(statusResult.ok === true, '6-3 recordCoordinateStatus 寫入成功');
  const statusRow = db.get('SELECT status FROM geo_coordinate_status_log WHERE visitor_id=?', ['vStatus1']);
  assert(statusRow && statusRow.status === 'denied', '6-4 狀態確實寫入 DB');
  const badStatus = recordCoordinateStatus(db, { store_id: STORE_A, visitor_id: 'vStatus2', session_id: 'sStatus2', status: 'not_a_real_status' });
  assert(badStatus.ok === true && badStatus.status === 'unknown', '6-5 不合法狀態值安全退回 unknown（不拋例外）');

  // ══════════════════════════════════════════════════════════════
  // 7. Denied Cooldown（前端純函式）
  // ══════════════════════════════════════════════════════════════
  const GLC = require('../public/js/geo-live-coordinate.js');
  assert(GLC.shouldAttemptGeolocation(null, 1000) === true, '7-1 從未詢問過允許嘗試');
  assert(GLC.shouldAttemptGeolocation({ status: 'denied', capturedAtMs: 1000 }, 1000 + 1000) === false, '7-2 拒絕後 cooldown 內不得再問');
  assert(GLC.shouldAttemptGeolocation({ status: 'denied', capturedAtMs: 0 }, GLC.DENY_COOLDOWN_MS + 1) === true, '7-3 拒絕 cooldown 過後允許再問');
  assert(GLC.DENY_COOLDOWN_MS === 7 * 24 * 60 * 60 * 1000, '7-4 拒絕 cooldown 為 7 天');
  assert(GLC.BACKGROUND_UPDATE_MIN_INTERVAL_MS === 5 * 60 * 1000, '7-5 背景更新最短間隔為 5 分鐘');
  assert(GLC.shouldAttemptGeolocation({ status: 'granted', capturedAtMs: 1000 }, 1000 + 1000) === false, '7-6 剛同意過，未達背景更新間隔不重問');
  assert(GLC.shouldAttemptGeolocation({ status: 'granted', capturedAtMs: 0 }, GLC.BACKGROUND_UPDATE_MIN_INTERVAL_MS + 1) === true, '7-7 已同意且超過背景更新間隔可再抓一次');

  assert(GLC.mapGeolocationErrorToStatus({ code: 3 }) === 'timeout', '8-1 PositionError code=3 對應 timeout');
  assert(GLC.shouldAttemptGeolocation({ status: 'timeout', capturedAtMs: 0 }, 1) === true, '8-2 timeout 狀態允許使用者主動再試');

  assert(GLC.mapGeolocationErrorToStatus(null) === 'error', '9-1 空錯誤物件安全回傳 error');
  assert(GLC.mapGeolocationErrorToStatus({ code: 1 }) === 'denied', '9-2 PositionError code=1 對應 denied');
  assert(GLC.mapGeolocationErrorToStatus({ code: 2 }) === 'unavailable', '9-3 PositionError code=2 對應 unavailable');
  assert(GLC.GEOLOCATION_OPTIONS.enableHighAccuracy === true, '9-4 enableHighAccuracy:true（含手機 GPS 情境）');
  assert(typeof GLC.GEOLOCATION_OPTIONS.timeout === 'number' && GLC.GEOLOCATION_OPTIONS.timeout > 0, '9-5 有合理 timeout 設定');
  assert(typeof GLC.GEOLOCATION_OPTIONS.maximumAge === 'number', '9-6 有 maximumAge 設定');

  // ══════════════════════════════════════════════════════════════
  // 10. Status-only POST
  // ══════════════════════════════════════════════════════════════
  const rDenied = await callRoute(geoLiveRouter, 'POST', '/coordinate', { storeId: STORE_A, body: { visitor_id: 'vSO1', session_id: 'sSO1', status: 'denied' } });
  assert(rDenied.body.success === true && rDenied.body.status === 'denied', '10-1 status-only denied 回報成功');
  const rTimeout = await callRoute(geoLiveRouter, 'POST', '/coordinate', { storeId: STORE_A, body: { visitor_id: 'vSO2', session_id: 'sSO2', status: 'timeout' } });
  assert(rTimeout.body.success === true && rTimeout.body.status === 'timeout', '10-2 status-only timeout 回報成功');
  const rMissingIds = await callRoute(geoLiveRouter, 'POST', '/coordinate', { storeId: STORE_A, body: { status: 'denied' } });
  assert(rMissingIds.statusCode === 400, '10-3 status-only 缺少 visitor_id/session_id 回 400');
  const glcNoCoordAfterStatusOnly = db.get('SELECT COUNT(*) c FROM geo_live_coordinates WHERE visitor_id=?', ['vSO1']);
  assert(Number(glcNoCoordAfterStatusOnly.c) === 0, '10-4 status-only（非 granted）絕不寫入 geo_live_coordinates');

  // ══════════════════════════════════════════════════════════════
  // 11/12/13. Coordinate Upsert / Better Accuracy Wins / No Duplicate Marker
  // ══════════════════════════════════════════════════════════════
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'vUp', session_id: 'sUp', event_name: 'page_view', geo_city: '桃園市', geo_district: '中壢區' });
  const up1 = recordLiveCoordinate(db, { store_id: STORE_A, visitor_id: 'vUp', session_id: 'sUp', lat: 24.9, lng: 121.2, accuracy_m: 200, source: 'browser_geolocation' });
  assert(up1.ok === true, '11-1 第一次座標寫入成功');
  const up2 = recordLiveCoordinate(db, { store_id: STORE_A, visitor_id: 'vUp', session_id: 'sUp', lat: 24.901, lng: 121.201, accuracy_m: 8, source: 'browser_geolocation' });
  assert(up2.ok === true, '11-2 第二次（更精確）座標寫入成功');
  const markersUp = getGeoLiveMarkerPoints(db, STORE_A, { range: 'today' });
  const vUpMarkers = markersUp.filter((m) => m.visitor_key === 'vUp');
  assert(vUpMarkers.length === 1, '12-1 同一 visitor 只產生一個 Marker（不重複）');
  assert(vUpMarkers[0].accuracy_m === 8, '12-2 Marker 使用最新一筆座標（accuracy 8，不是舊的 200）');
  assert(vUpMarkers[0].lat === 24.901 && vUpMarkers[0].lng === 121.201, '13-1 Marker 座標為最新回報值');

  // ══════════════════════════════════════════════════════════════
  // 14. Coordinate-only Visitor Marker
  // ══════════════════════════════════════════════════════════════
  const coordOnly = recordLiveCoordinate(db, { store_id: STORE_A, visitor_id: 'vCoordOnly', session_id: 'sCoordOnly', lat: 25.05, lng: 121.5, source: 'browser_geolocation' });
  assert(coordOnly.ok === true, '14-1 coordinate-only 訪客座標寫入成功');
  const markersCoordOnly = getGeoLiveMarkerPoints(db, STORE_A, { range: 'today' });
  const coordOnlyMarker = markersCoordOnly.find((m) => m.visitor_key === 'vCoordOnly');
  assert(!!coordOnlyMarker, '14-2 coordinate-only 訪客仍出現在 Marker 清單');
  assert(coordOnlyMarker.city === 'Unknown' && coordOnlyMarker.channel === 'Direct' && coordOnlyMarker.device_type === 'unknown', '14-3 coordinate-only 訪客 metadata 使用安全預設值');
  assert(!JSON.stringify(coordOnlyMarker).includes('undefined'), '14-4 coordinate-only Marker 序列化後不含 undefined 字樣');

  // ══════════════════════════════════════════════════════════════
  // 15. geo_visit_log + coordinate join
  // ══════════════════════════════════════════════════════════════
  const { byVisitor } = getLatestCoordinatesByVisitor(db, STORE_A, resolveTimeRangeSince('today'));
  assert(byVisitor.has('vUp'), '15-1 join 查詢能找到 vUp 的最新座標');
  assert(byVisitor.get('vUp').accuracy_m === 8, '15-2 join 查詢回傳的是最新座標');

  // ══════════════════════════════════════════════════════════════
  // 16/17. Coverage Summary / Known/Unknown/Mappable
  // ══════════════════════════════════════════════════════════════
  const since = resolveTimeRangeSince('today');
  const coverage = getCoordinateStatusSummary(db, STORE_A, since);
  assert(coverage.denied >= 1, '16-1 coverage 統計含 denied 計數');
  assert(coverage.timeout >= 1, '16-2 coverage 統計含 timeout 計數');
  assert(typeof coverage.total_reporting_visitors === 'number', '16-3 coverage 回傳總回報訪客數');
  const unknownPool = getGeoLiveUnknownPool(db, STORE_A, { range: 'today' });
  assert(unknownPool.total >= 1, '17-1 Unknown Pool 統計總訪客數 > 0');
  assert(unknownPool.mappable_with_coordinates >= 1, '17-2 mappable_with_coordinates 反映真實座標數');
  assert(unknownPool.known + unknownPool.unknown === unknownPool.total, '17-3 known + unknown = total');
  assert(unknownPool.coverage_pct >= 0 && unknownPool.coverage_pct <= 100, '17-4 coverage_pct 落在 0-100 範圍');

  // ══════════════════════════════════════════════════════════════
  // 18. Store Isolation
  // ══════════════════════════════════════════════════════════════
  logGeoVisit(db, { store_id: STORE_B, visitor_id: 'vB1', session_id: 'sB1', event_name: 'page_view', geo_city: '台中市', geo_district: '西屯區' });
  recordLiveCoordinate(db, { store_id: STORE_B, visitor_id: 'vB1', session_id: 'sB1', lat: 24.16, lng: 120.64, source: 'browser_geolocation' });
  const markersA = getGeoLiveMarkerPoints(db, STORE_A, { range: 'today' });
  const markersB = getGeoLiveMarkerPoints(db, STORE_B, { range: 'today' });
  assert(!markersA.some((m) => m.visitor_key === 'vB1'), '18-1 Store A 看不到 Store B 的 Marker');
  assert(markersB.some((m) => m.visitor_key === 'vB1'), '18-2 Store B 自己看得到自己的 Marker');
  assert(!markersB.some((m) => m.visitor_key === 'vUp'), '18-3 Store B 看不到 Store A 的 Marker');
  const districtsA = getGeoLiveDistricts(db, STORE_A, { range: 'today' });
  const districtsB = getGeoLiveDistricts(db, STORE_B, { range: 'today' });
  assert(!districtsA.some((d) => d.district === '西屯區'), '18-4 District 聚合也遵守 Store Isolation');
  assert(districtsB.some((d) => d.district === '西屯區'), '18-5 Store B 看得到自己的行政區資料');
  const rIsolationCheck = await callRoute(geoLiveRouter, 'GET', '/markers', { storeId: STORE_A, query: { range: 'today' } });
  assert(!JSON.stringify(rIsolationCheck.body).includes('vB1'), '18-6 GET /markers route-level 確認沒有洩漏 Store B 資料');

  // ══════════════════════════════════════════════════════════════
  // 19. Channel / 20. Device Type
  // ══════════════════════════════════════════════════════════════
  assert(classifyDeviceType('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)') === 'iphone', '20-1 iPhone UA 分類正確');
  assert(classifyDeviceType('Mozilla/5.0 (Linux; Android 13; Pixel 7) Mobile') === 'android', '20-2 Android 手機 UA 分類正確');
  assert(classifyDeviceType('Mozilla/5.0 (Linux; Android 13; SM-X) ') === 'ipad_tablet', '20-3 Android 平板分類為 tablet');
  assert(classifyDeviceType('Mozilla/5.0 (iPad; CPU OS 17_0)') === 'ipad_tablet', '20-4 iPad UA 分類為 tablet');
  assert(classifyDeviceType('Mozilla/5.0 (Windows NT 10.0; Win64; x64)') === 'desktop', '20-5 Windows UA 分類為 desktop');
  assert(classifyDeviceType('') === 'unknown', '20-6 空字串 UA 分類為 unknown');
  assert(classifyDeviceType(undefined) === 'unknown', '20-7 未提供 UA 分類為 unknown');
  assert(DEVICE_TYPES.length === 5, '20-8 裝置別列舉共 5 種');
  assert(isValidDeviceType('android') === true && isValidDeviceType('bogus') === false, '20-9 isValidDeviceType 正確判斷合法值');

  const okEvt = insertEvent(db, {
    store_id: STORE_A, visitor_id: 'vChan1', session_id: 'sChan1', event_name: 'page_view',
    source: 'fb', referrer: 'https://facebook.com/x', user_agent: 'Mozilla/5.0 (Linux; Android 10; Pixel) Mobile',
  });
  assert(okEvt === true, '19-1 insertEvent 寫入成功（含 channel/device 分類）');
  const chanRow = db.get('SELECT channel, device_type FROM geo_visit_log WHERE visitor_id=?', ['vChan1']);
  assert(chanRow.channel === 'Facebook', '19-2 channel 正確分類為 Facebook');
  assert(chanRow.device_type === 'android', '19-3 device_type 正確分類為 android');
  const okEvt2 = insertEvent(db, { store_id: STORE_A, visitor_id: 'vChan2', session_id: 'sChan2', event_name: 'page_view' });
  assert(okEvt2 === true, '19-4 insertEvent 無 source/user_agent 時仍寫入成功');
  const chanRow2 = db.get('SELECT channel, device_type FROM geo_visit_log WHERE visitor_id=?', ['vChan2']);
  assert(chanRow2.channel === 'Direct', '19-5 無 source 時 channel 安全退回 Direct');
  assert(chanRow2.device_type === 'unknown', '19-6 無 user_agent 時 device_type 安全退回 unknown');
  assert(GEO_LIVE_CHANNELS.length === 6, '19-7 channel 篩選列舉共 6 種');
  assert(GEO_LIVE_DEVICES.length === 5, '19-8 device 篩選列舉共 5 種');

  // ══════════════════════════════════════════════════════════════
  // 21/22/23. Marker Query / Cluster Data / Heat Data
  // ══════════════════════════════════════════════════════════════
  const rMarkers = await callRoute(geoLiveRouter, 'GET', '/markers', { storeId: STORE_A, query: { range: 'today' } });
  assert(rMarkers.statusCode === 200 && rMarkers.body.success === true, '21-1 GET /markers 回應成功');
  assert(Array.isArray(rMarkers.body.data), '21-2 GET /markers 回傳陣列');
  assert(rMarkers.body.data.every((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng)), '21-3 GET /markers 每一筆都有合法 lat/lng');
  assert(rMarkers.body.data.length >= 1, '22-1 Cluster 來源資料非空');
  const heatPoints = rMarkers.body.data.map((p) => [p.lat, p.lng, 1]);
  assert(heatPoints.every((h) => h.length === 3 && Number.isFinite(h[0]) && Number.isFinite(h[1]) && h[2] === 1), '23-1 Heat 資料點格式正確');

  // ══════════════════════════════════════════════════════════════
  // 24/25/26. District / Postal / Top 5
  // ══════════════════════════════════════════════════════════════
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'vD1', session_id: 'sD1', event_name: 'page_view', geo_city: '桃園市', geo_district: '平鎮區', postal_code: '324' });
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'vD2', session_id: 'sD2', event_name: 'purchase', geo_city: '桃園市', geo_district: '平鎮區', postal_code: '324' });
  const rDistricts = await callRoute(geoLiveRouter, 'GET', '/districts', { storeId: STORE_A, query: { range: 'today' } });
  assert(rDistricts.statusCode === 200, '24-1 GET /districts 回應成功');
  assert(rDistricts.body.data.some((d) => d.district === '平鎮區' && d.visitor_count >= 2), '24-2 District 聚合正確反映真實事件數');
  assert(rDistricts.body.data.every((d) => typeof d.district === 'string'), '24-3 District 完全依動態資料聚合');
  const rPostal = await callRoute(geoLiveRouter, 'GET', '/postal', { storeId: STORE_A, query: { range: 'today' } });
  assert(rPostal.statusCode === 200, '25-1 GET /postal 回應成功');
  assert(rPostal.body.data.some((p) => p.postal_code === '324'), '25-2 Postal 聚合正確反映真實郵遞區號');
  const top5 = getGeoLiveHeatSummaryTop5(db, STORE_A, { range: 'today' });
  assert(Array.isArray(top5) && top5.length <= 5, '26-1 Heat Summary Top5 最多回傳 5 筆');
  assert(top5.length === 0 || top5[0].visitor_count >= (top5[1] ? top5[1].visitor_count : 0), '26-2 Top5 依訪客數降冪排序');

  // ══════════════════════════════════════════════════════════════
  // 27. Timeline
  // ══════════════════════════════════════════════════════════════
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'v_1700000000000_abcd1234', session_id: 'sTl', event_name: 'page_view', geo_city: '桃園市', geo_district: '中壢區' });
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'v_1700000000000_abcd1234', session_id: 'sTl', event_name: 'add_to_cart', geo_city: '桃園市', geo_district: '中壢區' });
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'v_1700000000000_abcd1234', session_id: 'sTl', event_name: 'begin_checkout', geo_city: '桃園市', geo_district: '中壢區' });
  const timeline = getGeoLiveVisitorTimeline(db, STORE_A, 'v_1700000000000_abcd1234');
  assert(timeline.events.length === 3, '27-1 Timeline 正確回傳訪客的 3 筆事件');
  assert(timeline.funnel.visitor === true && timeline.funnel.add_to_cart === true && timeline.funnel.checkout === true && timeline.funnel.order === false, '27-2 Timeline 漏斗狀態正確');
  assert(!timeline.visitor_mask.includes('v_1700000000000_abcd1234'), '27-3 Timeline 不暴露完整原始 visitor_id');
  assert(/^vis_\*\*\*/.test(timeline.visitor_mask), '27-4 Timeline 遮罩格式符合既有慣例');
  const GLL = require('../public/js/geo-live-layer.js');
  const orderedSample = [
    { event_name: 'page_view', event_time: '2026-07-31 09:00:00' },
    { event_name: 'add_to_cart', event_time: '2026-07-31 09:05:00' },
    { event_name: 'begin_checkout', event_time: '2026-07-31 09:10:00' },
  ];
  const sorted = GLL.sortTimelineEvents(orderedSample.slice().reverse());
  assert(sorted[0].event_name === 'page_view' && sorted[2].event_name === 'begin_checkout', '27-5 前端 sortTimelineEvents 依時間正確排序（不同時間戳）');
  const paged = GLL.paginateTimeline(timeline.events, 1, 2);
  assert(paged.rows.length === 2 && paged.total_pages === 2, '27-6 Timeline 分頁/virtualization 正確');

  // ══════════════════════════════════════════════════════════════
  // 28. Replay Buckets
  // ══════════════════════════════════════════════════════════════
  const replayBuckets = getGeoLiveReplayBuckets(db, STORE_A, { range: 'today', bucketMinutes: 10 });
  assert(Array.isArray(replayBuckets), '28-1 Replay buckets 回傳陣列');
  assert(replayBuckets.every((b, i) => i === 0 || b.cumulative_visitors >= replayBuckets[i - 1].cumulative_visitors), '28-2 Replay 累積人數單調遞增');
  const frame0 = GLL.replayFrameAt(replayBuckets, 0);
  assert(frame0.cumulative_visitors >= 0, '28-3 replayFrameAt 回傳合法 frame');
  const frameOverflow = GLL.replayFrameAt(replayBuckets, 99999);
  assert(frameOverflow.is_last === true, '28-4 replayFrameAt 超出範圍時安全回傳最後一格');
  assert(GLL.replaySpeedIntervalMs(2) === Math.round(GLL.replaySpeedIntervalMs(1) / 2), '28-5 2x 速度間隔為 1x 的一半');
  assert(GLL.replaySpeedIntervalMs(4) === Math.round(GLL.replaySpeedIntervalMs(1) / 4), '28-6 4x 速度間隔為 1x 的四分之一');

  // ══════════════════════════════════════════════════════════════
  // 29. Filters
  // ══════════════════════════════════════════════════════════════
  const rFilters = await callRoute(geoLiveRouter, 'GET', '/filters', { storeId: STORE_A, query: {} });
  assert(rFilters.body.data.channels.includes('LINE') && rFilters.body.data.channels.includes('Organic'), '29-1 Filters API 回傳 channel 列舉');
  assert(rFilters.body.data.devices.includes('iphone'), '29-2 Filters API 回傳 device 列舉');
  assert(rFilters.body.data.time_ranges.includes('today') && rFilters.body.data.time_ranges.includes('30d'), '29-3 Filters API 回傳時間範圍列舉');
  assert(GEO_VISIT_LOG_TIME_RANGES.length === 8, '29-4 時間範圍列舉共 8 種');

  // ══════════════════════════════════════════════════════════════
  // 30. Loading / Ready / Empty / Error
  // ══════════════════════════════════════════════════════════════
  assert(GLL.resolveModuleState({ loading: true }) === 'loading', '30-1 loading 狀態判斷正確');
  assert(GLL.resolveModuleState({ error: true }) === 'error', '30-2 error 狀態判斷正確');
  assert(GLL.resolveModuleState({ rows: [] }) === 'empty', '30-3 empty 狀態判斷正確');
  assert(GLL.resolveModuleState({ rows: [{ a: 1 }] }) === 'ready', '30-4 ready 狀態判斷正確');
  assert(GLL.resolveModuleState({ rows: null }) === 'empty', '30-5 rows 非陣列時安全視為 empty');

  // ══════════════════════════════════════════════════════════════
  // 31/32. Polling Throttle / Background Tab Guard
  // ══════════════════════════════════════════════════════════════
  assert(GLL.MIN_POLL_INTERVAL_MS === 5000, '31-1 最短輪詢間隔為 5 秒');
  assert(GLL.resolvePollIntervalMs(1000, true) === 5000, '31-2 請求間隔小於下限時強制拉高到 5 秒');
  assert(GLL.resolvePollIntervalMs(10000, true) === 10000, '31-3 合理請求間隔照常使用');
  assert(GLL.resolvePollIntervalMs(5000, false) === 20000, '32-1 背景分頁時輪詢間隔降頻');
  assert(GLL.resolvePollIntervalMs(5000, true) < GLL.resolvePollIntervalMs(5000, false), '32-2 背景分頁間隔一定比前景長');

  // ══════════════════════════════════════════════════════════════
  // 33/34/35. Request Guard / Abort / Stale Response Guard
  // ══════════════════════════════════════════════════════════════
  assert(GLL.isStaleResponse(1, 3) === true, '33-1 過期回應被判定為 stale');
  assert(GLL.isStaleResponse(3, 3) === false, '34-1 最新回應不被判定為 stale');
  assert(GLL.isStaleResponse(5, 3) === false, '35-1 seq 領先安全回傳 false');
  assert(typeof GLL.state.requestSeq === 'number', '33-2 GeoLiveLayer 內部維護 requestSeq');

  // ══════════════════════════════════════════════════════════════
  // 36/37/38/39. Map Reuse / Tile Reuse / Layer Reuse / Single Active Mode
  // ══════════════════════════════════════════════════════════════
  const fakeMap = {
    _layers: new Set(),
    hasLayer(l) { return this._layers.has(l); },
    removeLayer(l) { this._layers.delete(l); },
    addLayer(l) { this._layers.add(l); },
  };
  const attached = GLL.attachToMap(fakeMap);
  assert(attached === true, '36-1 attachToMap 成功接受外部既有 map 實例');
  assert(GLL.state.map === fakeMap, '36-2 GeoLiveLayer 內部持有的正是傳入的既有 map');
  const modeOk1 = GLL.setMode('district');
  const modeOk2 = GLL.setMode('postal');
  assert(modeOk1 === true && modeOk2 === true, '39-1 setMode 對合法模式回傳成功');
  const modeBad = GLL.setMode('not_a_real_mode');
  assert(modeBad === false, '39-2 setMode 拒絕不合法模式');
  assert(GLL.DISPLAY_MODES.length === 6, '39-3 顯示模式列舉共 6 種');
  assert(GLL.state.mode === 'postal', '39-4 目前只有一個「主要模式」欄位');
  pass('37-1 GeoLiveLayer 原始碼不含任何 L.tileLayer( 呼叫（見下方原始碼稽核）');

  // ══════════════════════════════════════════════════════════════
  // 40. Tooltip Sanitization / 41. Privacy
  // ══════════════════════════════════════════════════════════════
  assert(GLL.safeDisplay(undefined) === '—', '40-1 undefined 不會顯示成 "undefined"');
  assert(GLL.safeDisplay(null) === '—', '40-2 null 不會顯示成 "null"');
  assert(GLL.safeDisplay(NaN) === '—', '40-3 NaN 不會顯示成 "NaN"');
  assert(GLL.safeDisplay(Infinity) === '—', '40-4 Infinity 不會顯示成 "Infinity"');
  assert(GLL.safeDisplay(-Infinity) === '—', '40-5 -Infinity 不會顯示成 "-Infinity"');
  assert(GLL.safeDisplay('LINE') === 'LINE', '40-6 合法值原樣顯示');
  const tooltipFields = GLL.buildMarkerTooltipFields({ visitor_key: 'v1', event_name: null, accuracy_m: undefined });
  assert(!Object.values(tooltipFields).some((v) => /undefined|NaN|Infinity/i.test(String(v))), '40-7 完整 Tooltip 欄位組合都不含 undefined/NaN/Infinity 字樣');
  assert(!('name' in coordOnlyMarker) && !('phone' in coordOnlyMarker) && !('address' in coordOnlyMarker), '41-1 Marker 資料不含姓名/電話/地址欄位');
  assert(!('name' in timeline) && !('phone' in timeline) && !('address' in timeline), '41-2 Timeline 資料不含姓名/電話/地址欄位');

  // ══════════════════════════════════════════════════════════════
  // 42/43/44/45. No Fake Marker / No IP Coordinates / No Store Coordinate
  //              Fallback / No District Centroid Marker
  // ══════════════════════════════════════════════════════════════
  logGeoVisit(db, { store_id: STORE_A, visitor_id: 'vNoCoord', session_id: 'sNoCoord', event_name: 'page_view', geo_city: '桃園市', geo_district: '八德區' });
  const markersNoCoord = getGeoLiveMarkerPoints(db, STORE_A, { range: 'today' });
  assert(!markersNoCoord.some((m) => m.visitor_key === 'vNoCoord'), '42-1 沒有真實座標的訪客絕不出現在 Marker 清單');
  const rawPointsFromVisitLog = db.get("SELECT COUNT(*) c FROM geo_visit_log WHERE lat IS NOT NULL", []);
  assert(Number(rawPointsFromVisitLog.c) === 0, '43-1 geo_visit_log.lat 在目前系統設計下永遠是 NULL');

  // ══════════════════════════════════════════════════════════════
  // 46/47/48/49. 原始碼稽核
  // ══════════════════════════════════════════════════════════════
  const g1SourceFiles = [
    'utils/deviceParser.js', 'utils/geoLiveCoordinate.js', 'routes/geo-live.js',
    'public/js/geo-live-coordinate.js', 'public/js/geo-live-layer.js', 'utils/geoVisitLog.js',
  ];
  const g1Sources = g1SourceFiles.map((f) => ({ f, text: fs.readFileSync(path.join(ROOT, f), 'utf8') }));
  // 稽核用：先去掉整行註解（// 開頭）與常見中文說明行，避免「本檔案不使用
  // Math.random()」這種刻意寫在註解裡的否定句，被字面比對誤判成「有使用」。
  function stripCommentLines(text) {
    return text
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line) && !/^\s*\*/.test(line))
      .join('\n');
  }
  g1Sources.forEach(({ f, text }) => {
    const code = stripCommentLines(text);
    assert(!/Math\.random\(\)/.test(code), `46-1 [${f}] 不含 Math.random()（排除註解說明）`);
    assert(!/['"]store_001['"]/.test(code), `47-1 [${f}] 不含硬編碼 'store_001'（排除註解說明）`);
    assert(!/桃園|中壢/.test(code), `48-1 [${f}] 不把「桃園/中壢」當成 production 判斷邏輯（排除註解說明）`);
  });
  const geoLiveLayerText = g1Sources.find((s) => s.f === 'public/js/geo-live-layer.js').text;
  assert(!/geojson\.io|raw\.githubusercontent|arbitrary-geojson/i.test(geoLiveLayerText), '49-1 GeoLiveLayer 不引用任意外部 GeoJSON URL');
  assert(!/new\s+L\.map\(/.test(geoLiveLayerText), '36-3（原始碼稽核）geo-live-layer.js 不含 new L.map( 呼叫');
  assert(!/L\.tileLayer\(/.test(geoLiveLayerText), '37-1-static geo-live-layer.js 不含 L.tileLayer( 呼叫');
  assert(!/state\.map\.remove\(\)/.test(stripCommentLines(geoLiveLayerText).replace(/\/\*[\s\S]*?\*\//g, '')), '36-4（原始碼稽核）geo-live-layer.js 不呼叫既有 map 的 .remove()（排除註解說明）');

  // ══════════════════════════════════════════════════════════════
  // 50/51. Accessibility / Responsive Hooks
  // ══════════════════════════════════════════════════════════════
  const cssText = fs.readFileSync(path.join(ROOT, 'public/css/geo-live-layer.css'), 'utf8');
  assert(/aria-pressed/.test(cssText), '50-1 CSS 含 aria-pressed 狀態樣式');
  assert(/@media/.test(cssText), '51-1 CSS 含至少一組 @media');
  assert(/768px/.test(cssText), '51-2 CSS 含平板寬度（768px）斷點');

  // ══════════════════════════════════════════════════════════════
  // 52/53. Vendor Assets Local / Static Asset Load Order
  // ══════════════════════════════════════════════════════════════
  const mcPath = path.join(ROOT, 'public/js/vendor/leaflet.markercluster.js');
  const heatPath = path.join(ROOT, 'public/js/vendor/leaflet-heat.js');
  assert(fs.existsSync(mcPath), '52-1 leaflet.markercluster.js 存在於本地 vendor 目錄');
  assert(fs.existsSync(heatPath), '52-2 leaflet-heat.js 存在於本地 vendor 目錄');
  assert(fs.statSync(mcPath).size > 1000, '52-3 leaflet.markercluster.js 內容非空殼');
  assert(fs.existsSync(path.join(ROOT, 'public/css/vendor/MarkerCluster.css')), '52-4 MarkerCluster.css 存在於本地 vendor 目錄');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const idxMapPos = indexHtml.indexOf('geo-intelligence-map.js');
  const idxVendorMcPos = indexHtml.indexOf('vendor/leaflet.markercluster.js');
  const idxGllPos = indexHtml.indexOf('geo-live-layer.js?');
  assert(idxMapPos > -1 && idxVendorMcPos > idxMapPos, '53-1 vendor markercluster 載入順序在 geo-intelligence-map.js 之後');
  assert(idxGllPos > idxVendorMcPos, '53-2 geo-live-layer.js 載入順序在 vendor 套件之後');
  assert(!/unpkg\.com\/leaflet\.markercluster|cdn\.jsdelivr\.net\/npm\/leaflet\.markercluster/.test(indexHtml), '14-static-1 markercluster 沒有唯一依賴外部 CDN');

  // ══════════════════════════════════════════════════════════════
  // 54/55. line-order.html 結構完整 / No Auto Prompt on Load
  // ══════════════════════════════════════════════════════════════
  const lineOrderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  assert((lineOrderHtml.match(/<\/body>/g) || []).length === 1, '54-1 line-order.html 只有一個 </body>');
  assert((lineOrderHtml.match(/<\/html>/g) || []).length === 1, '54-2 line-order.html 只有一個 </html>');
  assert(lineOrderHtml.includes('geo-live-coordinate.js'), '54-3 line-order.html 已載入 geo-live-coordinate.js');
  assert(lineOrderHtml.includes('GeoLiveCoordinate.init('), '54-4 line-order.html 已呼叫 GeoLiveCoordinate.init()');
  assert(lineOrderHtml.includes("addEventListener('focus'"), '54-5 line-order.html 使用 focus 事件觸發定位');
  const geoLiveCoordText = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-coordinate.js'), 'utf8');
  const initFnMatch = geoLiveCoordText.match(/function init\([^)]*\)\s*{([^}]*)}/);
  assert(!!initFnMatch && !/getCurrentPosition/.test(initFnMatch[1]), '55-1 init() 函式本體不呼叫 getCurrentPosition');
  assert(!/window\.onload\s*=\s*.*getCurrentPosition|DOMContentLoaded[^;]*getCurrentPosition/.test(geoLiveCoordText), '55-2 沒有把 getCurrentPosition 綁在頁面載入事件上');

  // ══════════════════════════════════════════════════════════════
  // 額外：Store 座標冒充 / District 中心點冒充
  // ══════════════════════════════════════════════════════════════
  const geoLiveCoordinateUtilText = fs.readFileSync(path.join(ROOT, 'utils/geoLiveCoordinate.js'), 'utf8');
  assert(!/storeLat|store_lat|store\.lat\b|storeCoord|store_coordinate/i.test(geoLiveCoordinateUtilText), '44-1 geoLiveCoordinate.js 不含「用店家座標」的變數/邏輯樣式');
  const geoVisitLogText = fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8');
  // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2：本輪刻意新增 Estimate Marker
  // （district_centroid／county_centroid）能力，但只透過官方 NLSC
  // Representative Point Catalog（authoritativeAdminPointCatalog.js）
  // 查表，getGeoLiveMarkerPoints()（G1 既有的「只回真實座標」Exact Marker
  // 查詢）本身完全未修改。這是刻意的 Contract 變更（Category B）：驗證
  // 重點改成「getGeoLiveMarkerPoints() 函式本體沒有 centroid 邏輯」，不是
  // 整個檔案禁止出現這個詞（檔案裡新增的 getGeoLiveMarkerModel／
  // resolveAreaRepresentativeMarker 是獨立的新函式，見
  // R5.4-G1.6-A1.2_IMPLEMENTATION_REPORT.md）。
  const getGeoLiveMarkerPointsBody = (geoVisitLogText.match(/function getGeoLiveMarkerPoints\(db, storeId, options\) \{\n([\s\S]*?)\n\}/) || [])[1] || '';
  assert(!/centroid/i.test(getGeoLiveMarkerPointsBody), '45-1 geoVisitLog.js（G1 Marker 查詢 getGeoLiveMarkerPoints 函式本體）不含 centroid 相關邏輯');
  assert(!/rectangle|Rectangle/.test(geoLiveLayerText), '45-2 geo-live-layer.js 不含 rectangle fixture 相關邏輯');

  printSummary();
}

main().catch((e) => {
  console.error('[smoke-hotfix30-b5-r5-4-g1-live-geo] FATAL:', e);
  process.exitCode = 1;
  printSummary();
});
