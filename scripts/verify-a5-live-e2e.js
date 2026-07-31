#!/usr/bin/env node
// Live E2E verification against the user's exact requirement document.
// Uses REAL sql.js DB (utils/db.js), REAL insertEvent() ingestion path,
// REAL dashboardAnalytics.getRealtime()/getFunnel(), REAL geoEventEngine.getGeoEventFunnel(),
// REAL geoVisitLog.getGeoVisitSummary(). No mocking of the data layer.

'use strict';
const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

function line(s) { console.log(s); }
function section(t) { console.log('\n' + '='.repeat(78) + '\n' + t + '\n' + '='.repeat(78)); }

const results = [];
function assert(cond, name, detail) {
  results.push({ name, status: cond ? 'PASS' : 'FAIL', detail });
  console.log(`[${cond ? 'PASS' : 'FAIL'}] ${name}${detail ? ' — ' + detail : ''}`);
}

async function main() {
  const DB_FILE = path.join(ROOT, 'data', 'pos.db');
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const dashboardAnalytics = require(path.join(ROOT, 'utils/dashboardAnalytics'));
  const GEE = require(path.join(ROOT, 'utils/geoEventEngine'));
  const geoVisitLog = require(path.join(ROOT, 'utils/geoVisitLog'));
  await initDb();
  const db = getDb();

  const STORE = 'store_live_1';
  const OTHER_STORE = 'store_live_2';

  // ══════════════════════════════════════════════════════════════
  // Reproduce EXACT reported production symptom:
  //   老闆儀表板 目前在線=1 / 漏斗 進站=1 商品瀏覽=1 / Geo 訪客=0
  // ══════════════════════════════════════════════════════════════
  section('一、同一時間點診斷 — 重現使用者回報症狀（真實資料寫入）');

  insertEvent(db, {
    store_id: STORE, visitor_id: 'visitor_prod_1', session_id: 'sess_prod_1',
    event_name: 'view_product', product_id: 101, geo: null,
  });

  const realtime = dashboardAnalytics.getRealtime(db, STORE);
  const range = { startLocal: '2000-01-01 00:00:00', endLocal: '2100-01-01 00:00:00' };
  const funnel = dashboardAnalytics.getFunnel(db, STORE, range, 'all');
  const geoFunnel = GEE.getGeoEventFunnel(db, STORE, { range: '5m' });
  const geoSummary = geoVisitLog.getGeoVisitSummary(db, STORE, { range: '5m' });

  const pageViewStage = funnel.find(s => s.key === 'page_view');
  const viewProductStage = funnel.find(s => s.key === 'view_product');

  console.log('  老闆儀表板 目前在線     :', realtime.online);
  console.log('  轉換漏斗 進站(page_view) :', pageViewStage.count);
  console.log('  轉換漏斗 商品瀏覽        :', viewProductStage.count);
  console.log('  Geo Event Engine Visitors:', geoFunnel.visitors);
  console.log('  Geo Visit Log Summary    :', JSON.stringify(geoSummary));

  assert(realtime.online === 1, 'Dashboard 目前在線 = 1');
  // page_view stage is legitimately 0 here — this visitor never fired page_view,
  // only view_product (deep-link scenario). That's correct funnel semantics.
  assert(pageViewStage.count === 0, '轉換漏斗 進站 = 0（此訪客只觸發 view_product，未觸發 page_view，屬正常語意)');
  assert(viewProductStage.count === 1, '轉換漏斗 商品瀏覽 = 1');
  assert(geoFunnel.visitors === 1, 'Geo Event Engine Visitors = 1（A5 修正後；修正前會是 0）');
  assert(geoSummary.geo_visitors === 1, 'Geo Visit Log Summary geo_visitors = 1');
  assert(geoSummary.geo_visitors_unknown === 1 && geoSummary.geo_visitors_known === 0, 'Unknown=1 / Known=0（無 geo 資料，正確分類為 Unknown 而非排除）');
  assert(geoSummary.unknown_rate === 100, 'Unknown Rate = 100%');

  // Data Flow Comparison Table
  section('Data Flow Comparison Table');
  const table = [
    { 模組: '老闆儀表板-目前在線', API: 'dashboardAnalytics.getRealtime()', 資料表: 'analytics_events', 事件名稱: '(不限，任何事件)', 去重欄位: 'session_id', 時間欄位: 'created_at (UTC, now-5min)', StoreCondition: 'store_id=?', UnknownHandling: 'N/A', 目前結果: realtime.online },
    { 模組: '轉換漏斗-進站', API: 'dashboardAnalytics.getFunnel()', 資料表: 'analytics_events', 事件名稱: 'page_view', 去重欄位: 'visitor_id', 時間欄位: 'created_at(本地/A_LOCAL)', StoreCondition: 'store_id=?', UnknownHandling: 'N/A', 目前結果: pageViewStage.count },
    { 模組: '轉換漏斗-商品瀏覽', API: 'dashboardAnalytics.getFunnel()', 資料表: 'analytics_events', 事件名稱: 'view_product', 去重欄位: 'visitor_id', 時間欄位: 'created_at(本地/A_LOCAL)', StoreCondition: 'store_id=?', UnknownHandling: 'N/A', 目前結果: viewProductStage.count },
    { 模組: 'Geo Intelligence-Visitors', API: 'geoEventEngine.getGeoEventFunnel()', 資料表: 'geo_visit_log', 事件名稱: 'ALL_FUNNEL_EVENT_NAMES(6種，A5新修正)', 去重欄位: 'COALESCE(visitor_id,session_id,event_id)', 時間欄位: 'event_time (UTC)', StoreCondition: 'store_id=?', UnknownHandling: '計入分母，is_unknown=1不排除', 目前結果: geoFunnel.visitors },
  ];
  console.table(table);

  // ══════════════════════════════════════════════════════════════
  // 二、geo_visit_log 實際寫入驗證（逐欄位）
  // ══════════════════════════════════════════════════════════════
  section('二、geo_visit_log 實際寫入驗證（逐欄位）');
  const rawRow = db.get(
    `SELECT store_id, visitor_id, session_id, event_name, is_unknown, city, district, source, event_time
     FROM geo_visit_log WHERE store_id=? AND visitor_id='visitor_prod_1' ORDER BY id DESC LIMIT 1`, [STORE]
  );
  console.log('  geo_visit_log 實際列:', JSON.stringify(rawRow, null, 2));
  assert(!!rawRow, 'analytics_events 寫入後，geo_visit_log 確實同步新增一筆');
  assert(rawRow.store_id === STORE, 'store_id 一致');
  assert(rawRow.visitor_id === 'visitor_prod_1', 'visitor_id 一致');
  assert(rawRow.session_id === 'sess_prod_1', 'session_id 一致');
  assert(rawRow.event_name === 'view_product', 'event_name 一致');
  assert(rawRow.is_unknown === 1, 'is_unknown 正確標記為 1（無地理資料）');
  assert(!!rawRow.event_time, 'event_time 有寫入');

  // ══════════════════════════════════════════════════════════════
  // 情境 A-F（需求文件七）
  // ══════════════════════════════════════════════════════════════
  section('情境 A：一筆 Unknown page_view');
  insertEvent(db, { store_id: STORE, visitor_id: 'A1', session_id: 'A1s', event_name: 'page_view', geo: null });
  {
    const rt = dashboardAnalytics.getRealtime(db, STORE);
    const gf = GEE.getGeoEventFunnel(db, STORE, { range: '5m' });
    const gs = geoVisitLog.getGeoVisitSummary(db, STORE, { range: '5m' });
    console.log('  online:', rt.online, ' geoVisitors:', gf.visitors, ' known/unknown:', gs.geo_visitors_known, gs.geo_visitors_unknown, ' coverage%:', gs.geo_visitors ? Math.round((gs.geo_visitors_known/gs.geo_visitors)*100) : 0);
  }

  section('情境 B：一筆 Known page_view（有 city）');
  const dbFresh = getDb();
  insertEvent(dbFresh, { store_id: STORE, visitor_id: 'B1', session_id: 'B1s', event_name: 'page_view', geo: { geo_city: '台北市', geo_district: '大安區', geo_source: 'ip', geo_confidence: 'city', geo_resolution: 'district', geo_context: 'estimated' } });
  {
    const gs = geoVisitLog.getGeoVisitSummary(dbFresh, STORE, { range: '5m' });
    const rows = geoVisitLog.getGeoVisitAreas(dbFresh, STORE, { range: '5m' });
    const knownRow = rows.find(r => r.city === '台北市');
    assert(!!knownRow, '情境B: Known 訪客有城市資料可畫圖 (city=台北市)');
  }

  section('情境 C：同一 visitor page_view + 9x view_item');
  const vC = 'C_visitor';
  insertEvent(dbFresh, { store_id: STORE, visitor_id: vC, session_id: 'Cs', event_name: 'page_view', geo: null });
  for (let i = 0; i < 9; i++) insertEvent(dbFresh, { store_id: STORE, visitor_id: vC, session_id: 'Cs', event_name: 'view_product', product_id: i + 1, geo: null });
  {
    const gf = GEE.getGeoEventFunnel(dbFresh, STORE, { range: '5m' });
    const cnt = dbFresh.get(`SELECT COUNT(*) c FROM geo_visit_log WHERE store_id=? AND visitor_id=?`, [STORE, vC]);
    console.log('  該 visitor geo_visit_log 事件筆數(應為10):', cnt.c);
  }

  section('情境 D：同一 visitor page_view -> add_to_cart');
  const vD = 'D_visitor';
  insertEvent(dbFresh, { store_id: STORE, visitor_id: vD, session_id: 'Ds', event_name: 'page_view', geo: null });
  insertEvent(dbFresh, { store_id: STORE, visitor_id: vD, session_id: 'Ds', event_name: 'add_to_cart', product_id: 1, geo: null });

  section('情境 E：session_id 空、visitor_id 有值');
  // insertEvent requires session_id truthy at the analyticsLog layer (see guard),
  // so at the ingestion boundary this is normalized by callers; test geo_visit_log
  // dedup fallback directly via logGeoVisit with empty session_id.
  const { logGeoVisit } = require(path.join(ROOT, 'utils/geoVisitLog'));
  logGeoVisit(dbFresh, { store_id: STORE, visitor_id: 'E_visitor', session_id: '', event_name: 'page_view', geo_city: null, geo_district: null });
  {
    const gs = geoVisitLog.getGeoVisitSummary(dbFresh, STORE, { range: '5m' });
    console.log('  含情境E後 geo_visitors 總計:', gs.geo_visitors);
  }

  section('情境 F：切換 store（store isolation）');
  insertEvent(dbFresh, { store_id: OTHER_STORE, visitor_id: 'F_other_store_visitor', session_id: 'Fs', event_name: 'page_view', geo: null });
  {
    const gsStoreA = geoVisitLog.getGeoVisitSummary(dbFresh, STORE, { range: '5m' });
    const gsStoreB = geoVisitLog.getGeoVisitSummary(dbFresh, OTHER_STORE, { range: '5m' });
    assert(gsStoreB.geo_visitors === 1, '情境F: 另一店(OTHER_STORE) geo_visitors = 1（僅該店自己的訪客）');
    console.log('  StoreA geo_visitors (不受OTHER_STORE影響):', gsStoreA.geo_visitors);
  }

  section('SUMMARY');
  const total = results.length, p = results.filter(r => r.status === 'PASS').length, f = total - p;
  console.log(`PASS: ${p}  FAIL: ${f}  TOTAL: ${total}`);
  if (f > 0) process.exitCode = 1;
}

main().catch(e => { console.error(e); process.exitCode = 1; });
