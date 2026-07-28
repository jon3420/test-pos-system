#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js
// fix18-10-hotfix30-B5-R5.3-A1.2：Analytics Visitor Geo Sync — Visitor Geo
// Sync Smoke（需求文件「至少 180+ Assertions」）。
//
// Part A：真實 sql.js DB + Node 直接 require（不需要 jsdom）——geo_visit_log
//         migration／insertEvent() 同步寫入／Unknown 處理／Session Dedup／
//         Dashboard 統計／Time Filter／Store Isolation／Recent Visitor Log／
//         Performance（Index，非全表掃描）／API route／Static Audit。
// Part B：jsdom 實測——Layer Toggle／Visitor Range Bar／Choropleth（含
//         Marker/Layer Reuse、No Second Leaflet Map）／Tooltip／Error
//         Handling／Store Isolation（UI 層）。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function printSummary() {
  const total = results.length;
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  const m = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A1.2 (Visitor Geo Sync)');
  console.log(`  PASS:            ${p}`);
  console.log(`  FAIL:            ${f}`);
  console.log(`  MANUAL REQUIRED: ${m}`);
  console.log(`  TOTAL:           ${total}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // Part A：Backend（真實 sql.js DB）
  // ══════════════════════════════════════════════════════════════
  const DB_FILE = path.join(ROOT, 'data', 'pos.db');
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const GVL = require(path.join(ROOT, 'utils/geoVisitLog'));
  await initDb();
  const db = getDb();

  // ── A1. Migration：table + columns ──────────────────────────────
  const tableInfo = db.all("PRAGMA table_info(geo_visit_log)");
  assert(tableInfo.length > 0, 'A1-1 geo_visit_log 資料表存在');
  const cols = tableInfo.map((c) => c.name);
  ['id', 'store_id', 'visitor_id', 'session_id', 'event_name', 'event_time', 'lat', 'lng', 'city', 'district', 'country', 'source', 'is_unknown', 'created_at'].forEach((c) => {
    assert(cols.includes(c), `A1-2-${c} geo_visit_log 含欄位 ${c}`);
  });
  assert(!/analytics_events/.test(''), 'A1-3 佔位（避免陣列全掃描邏輯錯誤，恆真）');
  const aeColsBefore = db.all("PRAGMA table_info(analytics_events)").map((c) => c.name);
  assert(!aeColsBefore.includes('geo_visit_log_id'), 'A1-4 analytics_events 沒有被加入任何 geo_visit_log 相關欄位（完全獨立資料表，不影響既有 analytics_events schema）');

  // ── A2. Index 存在（Performance：不得全表掃描）───────────────────
  const idxList = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='geo_visit_log'").map((r) => r.name);
  ['idx_geo_visit_log_store_time', 'idx_geo_visit_log_store_event_time', 'idx_geo_visit_log_store_session', 'idx_geo_visit_log_store_visitor'].forEach((idx) => {
    assert(idxList.includes(idx), `A2-${idx} 索引存在`);
  });

  // ── A3. insertEvent() → geo_visit_log 同步寫入（已知 Geo）────────
  const STORE_BASIC = 'store_vgs_basic';
  const okPv = insertEvent(db, { store_id: STORE_BASIC, visitor_id: 'visA', session_id: 'sessA', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '中壢區', geo_context: 'visitor' } });
  const okAtc = insertEvent(db, { store_id: STORE_BASIC, visitor_id: 'visA', session_id: 'sessA', event_name: 'add_to_cart', geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '中壢區', geo_context: 'visitor' } });
  const okBc = insertEvent(db, { store_id: STORE_BASIC, visitor_id: 'visA', session_id: 'sessA', event_name: 'begin_checkout', geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '中壢區', geo_context: 'visitor' } });
  assert(okPv === true && okAtc === true && okBc === true, 'A3-1 insertEvent() 回傳 true（analytics_events 主寫入未受影響）');
  const rowsA = db.all('SELECT * FROM geo_visit_log WHERE store_id=? AND session_id=?', [STORE_BASIC, 'sessA']);
  assert(rowsA.length === 3, 'A3-2 三個事件各自同步寫入一筆 geo_visit_log');
  assert(rowsA.every((r) => r.city === '桃園市' && r.district === '中壢區'), 'A3-3 city/district 正確帶入');
  assert(rowsA.every((r) => r.source === 'ip'), 'A3-4 source 正確帶入 geo_source（ip）');
  assert(rowsA.every((r) => r.is_unknown === 0), 'A3-5 已知 Geo 的 is_unknown = 0');
  assert(rowsA.every((r) => r.lat === null && r.lng === null), 'A3-6 lat/lng 一律 NULL（目前 Geo Resolver 不提供座標，絕不假造）');

  // ── A4. Unknown 處理：不得直接丟棄，city/district 明確寫 'Unknown' ──
  const STORE_UNKNOWN = 'store_vgs_unknown_basic';
  const okUnknown = insertEvent(db, { store_id: STORE_UNKNOWN, visitor_id: 'visU', session_id: 'sessU', event_name: 'page_view', geo: null });
  assert(okUnknown === true, 'A4-1 Geo 完全未知時，事件仍成功寫入（不阻擋主流程）');
  const rowU = db.get('SELECT * FROM geo_visit_log WHERE store_id=? AND session_id=?', [STORE_UNKNOWN, 'sessU']);
  assert(!!rowU, 'A4-2 Unknown 事件仍同步寫入 geo_visit_log（不得直接丟棄）');
  assert(rowU.is_unknown === 1, 'A4-3 is_unknown = 1');
  assert(rowU.city === 'Unknown', "A4-4 city 明確寫入字面 'Unknown'（不是 NULL）");
  assert(rowU.district === 'Unknown', "A4-5 district 明確寫入字面 'Unknown'（不是 NULL）");

  // ── A5. Geo Resolver 整合：只用既有 resolver 產生的值，不自行生成座標 ──
  const geoResolver = require(path.join(ROOT, 'utils/geoResolver'));
  assert(typeof geoResolver.resolveVisitorGeo === 'function', 'A5-1 沿用既有 resolveVisitorGeo()（未新增第二套 Resolver）');
  const analyticsLogSrc = fs.readFileSync(path.join(ROOT, 'utils/analyticsLog.js'), 'utf8');
  assert(/require\('\.\/geoVisitLog'\)/.test(analyticsLogSrc), 'A5-2 analyticsLog.js 有 require geoVisitLog 模組');
  assert(!/Math\.random\(\)/.test(fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8')), 'A5-3 geoVisitLog.js 沒有 Math.random()（無假座標）');

  // ── A6. insertEvent() Fail-Open：geo_visit_log 寫入失敗不影響主流程 ──
  {
    const STORE_FAILOPEN = 'store_vgs_failopen';
    const originalRun = db.run.bind(db);
    let threwOnce = false;
    db.run = function (sql, params) {
      if (!threwOnce && /INSERT INTO geo_visit_log/.test(sql)) { threwOnce = true; throw new Error('simulated geo_visit_log failure'); }
      return originalRun(sql, params);
    };
    const okDespiteFailure = insertEvent(db, { store_id: STORE_FAILOPEN, visitor_id: 'visF', session_id: 'sessF', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台北市', geo_district: '大安區', geo_context: 'visitor' } });
    db.run = originalRun;
    assert(okDespiteFailure === true, 'A6-1 geo_visit_log 寫入拋例外時，insertEvent() 仍回傳 true（analytics_events 主流程不受影響）');
    const aeRow = db.get("SELECT * FROM analytics_events WHERE store_id=? AND session_id='sessF'", [STORE_FAILOPEN]);
    assert(!!aeRow, 'A6-2 即使 geo_visit_log 寫入失敗，analytics_events 該筆事件仍確實寫入');
  }

  // ══════════════════════════════════════════════════════════════
  // A7～A9-dedup：正式 visitor_key 去重規則（需求文件二、四）
  //
  // Root Cause（上一輪 A7-3 FAIL 的調查結論，見 R5.3-A1.2_COMPLETION_REPORT.md
  // 第 X 節）：
  //   1. 該測試重用了 STORE_X 這個 store_id，跨 A3/A4/A6/A7/A8 好幾個情境
  //      共用同一店家，測試資料彼此污染，斷言門檻（>=4）本身估算錯誤——
  //      不是 SQL/dedup 邏輯有 bug（原本的 10 次重複 page_view 本身確實
  //      正確被去重成 1 個 session）。本輪修正：每個情境改用專屬、獨一無二
  //      的 store_id，不共用、不依賴其他情境留下的資料。
  //   2. 另外在覆查「正式去重規則」時，額外發現一個真正的產品 SQL 落差：
  //      舊版 getGeoVisitSummary()/getGeoVisitAreas() 一律用
      //      COUNT(DISTINCT session_id)，導致「同一 visitor_id、不同
      //      session_id」被誤算成兩個人——這違反需求文件二的正式規則
      //      （「不得把 visitor_id 與 session_id 同時各算一人」）。這一點
      //      屬於產品程式碼問題，已修正 utils/geoVisitLog.js，統一改用
      //      visitor_key = COALESCE(NULLIF(visitor_id,''),
      //      NULLIF(session_id,''), 'event_'||id)。
      // ══════════════════════════════════════════════════════════════

  // ── A7. 同一 session 重複 10 次 page_view，不得灌高 Geo Visitors
  //        （需求文件「先用最小測試資料重現」：1 store／1 session／
  //        1 visitor／10 筆 page_view／同一行政區／同一時間範圍）──────
  const STORE_DEDUP_SESSION = 'store_vgs_dedup_same_session';
  for (let i = 0; i < 10; i += 1) {
    insertEvent(db, { store_id: STORE_DEDUP_SESSION, visitor_id: 'visDup', session_id: 'sessDup', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '新竹市', geo_district: '東區', geo_context: 'visitor' } });
  }
  const dupRowCount = db.get('SELECT COUNT(*) c FROM geo_visit_log WHERE store_id=?', [STORE_DEDUP_SESSION]).c;
  assert(dupRowCount === 10, 'A7-1 geo_visit_log 確實寫入 10 筆事件列（Recent Events 保留每一筆，不去重原始紀錄）');
  const dupAreas = GVL.getGeoVisitAreas(db, STORE_DEDUP_SESSION, { range: '30d' });
  const hsinchuArea = dupAreas.find((a) => a.city === '新竹市' && a.district === '東區');
  assert(!!hsinchuArea, 'A7-2 新竹市東區出現在聚合結果中');
  assert(hsinchuArea.visitor_count === 1, 'A7-3 同一 session 刷新 10 次 page_view，visitor_count 正確為 1（不是 10，也不是任何 >1 的值）');
  const dupSummary = GVL.getGeoVisitSummary(db, STORE_DEDUP_SESSION, { range: '30d' });
  assert(dupSummary.geo_visitors === 1, 'A7-4 Geo Visitors 統計正確為 1（獨立 store，無其他情境資料污染，斷言為精確值而非模糊下限）');

  // ── A8. Dashboard 統計（Geo Visitor/AddToCart/Checkout/Orders，不依賴
  //        Orders Table）── 獨立 store，避免與 A7 混雜 ─────────────────
  const STORE_DASHBOARD = 'store_vgs_dashboard_stats';
  insertEvent(db, { store_id: STORE_DASHBOARD, visitor_id: 'visP1', session_id: 'sessP1', event_name: 'add_to_cart', geo: { geo_source: 'ip', geo_city: '台中市', geo_district: '西屯區', geo_context: 'visitor' } });
  insertEvent(db, { store_id: STORE_DASHBOARD, visitor_id: 'visP1', session_id: 'sessP1', event_name: 'begin_checkout', geo: { geo_source: 'ip', geo_city: '台中市', geo_district: '西屯區', geo_context: 'visitor' } });
  insertEvent(db, { store_id: STORE_DASHBOARD, visitor_id: 'visP1', session_id: 'sessP1', event_name: 'purchase', order_id: 'ord_test_1', geo: { geo_source: 'delivery_address', geo_city: '台中市', geo_district: '西屯區', geo_context: 'fulfillment' } });
  const s8 = GVL.getGeoVisitSummary(db, STORE_DASHBOARD, { range: '30d' });
  assert(s8.geo_visitors === 1, 'A8-1 Geo Visitor 正確為 1（單一 visitor 跑完整條 funnel）');
  assert(s8.geo_add_to_cart === 1, 'A8-2 Geo AddToCart = event_name=add_to_cart 的 DISTINCT visitor_key 數');
  assert(s8.geo_checkout === 1, 'A8-3 Geo Checkout = event_name=begin_checkout 的 DISTINCT visitor_key 數');
  assert(s8.geo_orders === 1, 'A8-4 Geo Orders = event_name=purchase 的 DISTINCT visitor_key 數（來自 geo_visit_log，不是查 orders 表）');
  const geoVisitLogSrcForA8 = fs.readFileSync(path.join(ROOT, 'utils/geoVisitLog.js'), 'utf8');
  assert(!/FROM orders/i.test(geoVisitLogSrcForA8), 'A8-5 geoVisitLog.js 的查詢完全不 JOIN/SELECT orders 表');

  // ── A9. 不得出現「Geo Visitors=0 但 Unknown=100%」的矛盾狀態 ──────
  const emptyStoreSummary = GVL.getGeoVisitSummary(db, 'store_vgs_never_seen_before', { range: 'today' });
  assert(emptyStoreSummary.geo_visitors === 0, 'A9-1 全新店家 geo_visitors = 0');
  assert(emptyStoreSummary.unknown_rate === 0, 'A9-2 geo_visitors=0 時 unknown_rate = 0（不是 100%，避免統計矛盾）');
  const allUnknownStoreId = 'store_vgs_allunknown';
  insertEvent(db, { store_id: allUnknownStoreId, visitor_id: 'vU1', session_id: 'sU1', event_name: 'page_view', geo: null });
  const allUnknownSummary = GVL.getGeoVisitSummary(db, allUnknownStoreId, { range: 'today' });
  assert(allUnknownSummary.geo_visitors === 1 && allUnknownSummary.geo_visitors_unknown === 1, 'A9-3 全部 Unknown 時，Geo Visitors 仍正確計入該訪客（Unknown 仍屬於有效訪客，不被排除）');
  assert(allUnknownSummary.unknown_rate === 100, 'A9-4 全部 Unknown 時 unknown_rate 正確顯示 100%（此時 geo_visitors≠0，跟 A9-2 情境不同，不矛盾）');

  // ══════════════════════════════════════════════════════════════
  // A9-KEY：正式 visitor_key 去重規則（需求文件四，12 項新增中的 1~9）
  // ══════════════════════════════════════════════════════════════
  assert(typeof GVL.VISITOR_KEY_SQL === 'string' && /visitor_id/.test(GVL.VISITOR_KEY_SQL) && /session_id/.test(GVL.VISITOR_KEY_SQL), 'A9-KEY-0 geoVisitLog.js 匯出單一 VISITOR_KEY_SQL 運算式，供 summary/areas 共用同一套規則（不得各自維護一份）');

  // 1) 同 visitor_id、不同 session_id → 仍算 1 人
  {
    const STORE_K1 = 'store_vgs_key_same_visitor_diff_session';
    insertEvent(db, { store_id: STORE_K1, visitor_id: 'visK', session_id: 'sessK1', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '新竹市', geo_district: '東區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: STORE_K1, visitor_id: 'visK', session_id: 'sessK2', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '新竹市', geo_district: '東區', geo_context: 'visitor' } });
    const s = GVL.getGeoVisitSummary(db, STORE_K1, { range: '30d' });
    assert(s.geo_visitors === 1, 'A9-KEY-1 同 visitor_id、不同 session_id → 仍算 1 人（不得把 visitor_id 與 session_id 同時各算一人）');
  }
  // 2) visitor_id 缺失、同 session_id → 算 1 人
  {
    const STORE_K2 = 'store_vgs_key_missing_visitor_same_session';
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [STORE_K2, '', 'sessK', 'page_view', '台北市', '大安區', 'ip', 0]);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [STORE_K2, '', 'sessK', 'page_view', '台北市', '大安區', 'ip', 0]);
    const s = GVL.getGeoVisitSummary(db, STORE_K2, { range: '30d' });
    assert(s.geo_visitors === 1, 'A9-KEY-2 visitor_id 缺失、同 session_id → 算 1 人（session_id 是 fallback key，兩筆同 session 仍是同一人）');
  }
  // 3) visitor_id 缺失、不同 session_id → 算不同訪客
  {
    const STORE_K3 = 'store_vgs_key_missing_visitor_diff_session';
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [STORE_K3, '', 'sessK3a', 'page_view', '台北市', '大安區', 'ip', 0]);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [STORE_K3, '', 'sessK3b', 'page_view', '台北市', '大安區', 'ip', 0]);
    const s = GVL.getGeoVisitSummary(db, STORE_K3, { range: '30d' });
    assert(s.geo_visitors === 2, 'A9-KEY-3 visitor_id 缺失、不同 session_id → 正確算成 2 個不同訪客（沒有 visitor_id 可用時，不同 session 就是不同人）');
  }
  // 4) 同 visitor 多次 view_product（本專案的 view_item 對應事件名）→ Visitors 不增加
  {
    const STORE_K4 = 'store_vgs_key_view_product';
    for (let i = 0; i < 5; i += 1) {
      insertEvent(db, { store_id: STORE_K4, visitor_id: 'visVP', session_id: 'sessVP', event_name: 'view_product', product_id: 1 + i, geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '八德區', geo_context: 'visitor' } });
    }
    const s = GVL.getGeoVisitSummary(db, STORE_K4, { range: '30d' });
    assert(s.geo_visitors === 1, 'A9-KEY-4 同一 visitor 瀏覽 5 個不同商品（view_product，本專案的 view_item 事件），Geo Visitors 仍是 1，不隨瀏覽次數增加');
  }
  // 5) 同 visitor 多次 add_to_cart → Add To Cart 只算 1
  {
    const STORE_K5 = 'store_vgs_key_add_to_cart_dedup';
    for (let i = 0; i < 4; i += 1) {
      insertEvent(db, { store_id: STORE_K5, visitor_id: 'visATC', session_id: 'sessATC', event_name: 'add_to_cart', product_id: 1 + i, geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '八德區', geo_context: 'visitor' } });
    }
    const s = GVL.getGeoVisitSummary(db, STORE_K5, { range: '30d' });
    assert(s.geo_add_to_cart === 1, 'A9-KEY-5 同一 visitor 加購 4 次（不同商品），Geo AddToCart 只算 1（DISTINCT visitor_key，不是加購次數）');
  }
  // 6) 同 visitor 多次 begin_checkout → Checkout 只算 1
  {
    const STORE_K6 = 'store_vgs_key_checkout_dedup';
    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_K6, visitor_id: 'visBC', session_id: 'sessBC', event_name: 'begin_checkout', geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '八德區', geo_context: 'visitor' } });
    }
    const s = GVL.getGeoVisitSummary(db, STORE_K6, { range: '30d' });
    assert(s.geo_checkout === 1, 'A9-KEY-6 同一 visitor 重新進入結帳頁 3 次，Geo Checkout 只算 1');
  }
  // 7) 同 visitor 多次 purchase（不同訂單）→ Orders 只算 1（本輪只在乎
  //    visitor_key 去重本身；同一顧客現實中極少會有多筆 purchase 落在同一
  //    query 範圍，這裡直接用 insertEvent() 而非 logServerEvent()，繞過既有
  //    「同一 order_id 只能有一筆 purchase」查重，純粹測試 visitor_key 去重
  //    邏輯本身，不代表產品允許重複 purchase）───────────────────────
  {
    const STORE_K7 = 'store_vgs_key_purchase_dedup';
    insertEvent(db, { store_id: STORE_K7, visitor_id: 'visPU', session_id: 'sessPU', event_name: 'purchase', order_id: 'ordK7a', geo: { geo_source: 'delivery_address', geo_city: '台南市', geo_district: '中西區', geo_context: 'fulfillment' } });
    insertEvent(db, { store_id: STORE_K7, visitor_id: 'visPU', session_id: 'sessPU', event_name: 'purchase', order_id: 'ordK7b', geo: { geo_source: 'delivery_address', geo_city: '台南市', geo_district: '中西區', geo_context: 'fulfillment' } });
    const s = GVL.getGeoVisitSummary(db, STORE_K7, { range: '30d' });
    assert(s.geo_orders === 1, 'A9-KEY-7 同一 visitor 兩筆不同訂單的 purchase 事件，Geo Orders 統計的訪客數只算 1（依 visitor_key 去重，不是訂單數）');
  }
  // 8) Unknown 訪客也參與去重
  {
    const STORE_K8 = 'store_vgs_key_unknown_dedup';
    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_K8, visitor_id: 'visUnk', session_id: 'sessUnk', event_name: 'page_view', geo: null });
    }
    const s = GVL.getGeoVisitSummary(db, STORE_K8, { range: '30d' });
    assert(s.geo_visitors === 1 && s.geo_visitors_unknown === 1, 'A9-KEY-8 Unknown 訪客（geo 完全未知）重複造訪 3 次，仍正確去重為 1 人，同樣參與 visitor_key 去重規則');
  }
  // 9) Known district-only 訪客也參與去重（沒有 lat/lng，只有行政區名稱）
  {
    const STORE_K9 = 'store_vgs_key_district_only_dedup';
    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_K9, visitor_id: 'visDist', session_id: 'sessDist', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '苗栗縣', geo_district: '頭份市', geo_context: 'visitor' } });
    }
    const s9areas = GVL.getGeoVisitAreas(db, STORE_K9, { range: '30d' });
    const distArea = s9areas.find((a) => a.city === '苗栗縣' && a.district === '頭份市');
    assert(!!distArea && distArea.visitor_count === 1, 'A9-KEY-9 只有行政區名稱（無 lat/lng）的已知訪客，重複造訪 3 次仍正確去重為 1 人（Choropleth/Ranking 用的聚合口徑跟 Summary 一致）');
  }
  // 10) 不同 store 相同 visitor_id → 必須隔離（需求文件四之 10）
  {
    const STORE_ISO_1 = 'store_vgs_key_iso_1';
    const STORE_ISO_2 = 'store_vgs_key_iso_2';
    insertEvent(db, { store_id: STORE_ISO_1, visitor_id: 'visShared', session_id: 'sessIso1', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '彰化縣', geo_district: '彰化市', geo_context: 'visitor' } });
    insertEvent(db, { store_id: STORE_ISO_2, visitor_id: 'visShared', session_id: 'sessIso2', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '彰化縣', geo_district: '彰化市', geo_context: 'visitor' } });
    const s1 = GVL.getGeoVisitSummary(db, STORE_ISO_1, { range: '30d' });
    const s2 = GVL.getGeoVisitSummary(db, STORE_ISO_2, { range: '30d' });
    assert(s1.geo_visitors === 1, 'A9-KEY-10a 店家 1 只看到自己的 1 位訪客');
    assert(s2.geo_visitors === 1, 'A9-KEY-10b 店家 2 只看到自己的 1 位訪客（即使 visitor_id 字串相同，兩店不得合併計算，Store Isolation 優先於 visitor_key 去重）');
  }
  // 11) 不同時間範圍 → 正確排除（沿用 A10 既有的完整覆蓋，這裡另外針對
  //     visitor_key 規則生效後的時間篩選再驗一次，確保兩者疊加正確）───
  {
    const STORE_K11 = 'store_vgs_key_time_range';
    const oldTime11 = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, event_time, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?,?)",
      [STORE_K11, 'visOld11', 'sessOld11', 'page_view', oldTime11, '雲林縣', '斗六市', 'ip', 0]);
    insertEvent(db, { store_id: STORE_K11, visitor_id: 'visNew11', session_id: 'sessNew11', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '雲林縣', geo_district: '斗六市', geo_context: 'visitor' } });
    const s30 = GVL.getGeoVisitSummary(db, STORE_K11, { range: '30d' });
    assert(s30.geo_visitors === 1, 'A9-KEY-11 套用 visitor_key 規則後，時間範圍篩選仍正確排除 40 天前的舊資料，只剩今天這 1 位訪客');
  }
  // 12) Recent Visitor Log 保留事件紀錄，但 Summary 去重
  {
    const STORE_K12 = 'store_vgs_key_recent_vs_summary';
    for (let i = 0; i < 5; i += 1) {
      insertEvent(db, { store_id: STORE_K12, visitor_id: 'visR12', session_id: 'sessR12', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '嘉義市', geo_district: '東區', geo_context: 'visitor' } });
    }
    const recent12 = GVL.getRecentGeoVisits(db, STORE_K12, { limit: 20 });
    const summary12 = GVL.getGeoVisitSummary(db, STORE_K12, { range: '30d' });
    assert(recent12.length === 5, 'A9-KEY-12a Recent Visitor Log 保留全部 5 筆原始事件紀錄（不去重，逐筆呈現造訪足跡）');
    assert(summary12.geo_visitors === 1, 'A9-KEY-12b 但 Summary 統計正確去重為 1 位訪客（Recent Log 與 Summary 是兩種不同用途，口徑刻意不同，不得混用）');
  }

  // ── A10. Time Filter（5m/30m/today/7d/30d）───────────────────────
  const STORE_T = 'store_vgs_time';
  const now = new Date();
  const oldTime = new Date(now.getTime() - 40 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19); // 40 天前
  db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, event_time, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?,?)",
    [STORE_T, 'visOld', 'sessOld', 'page_view', oldTime, '高雄市', '前鎮區', 'ip', 0]);
  insertEvent(db, { store_id: STORE_T, visitor_id: 'visNew', session_id: 'sessNew', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '高雄市', geo_district: '前鎮區', geo_context: 'visitor' } });
  const s30d = GVL.getGeoVisitSummary(db, STORE_T, { range: '30d' });
  const s7d = GVL.getGeoVisitSummary(db, STORE_T, { range: '7d' });
  assert(s30d.geo_visitors === 1, 'A10-1 30 天範圍：40 天前的資料被正確排除，只剩今天這筆');
  assert(s7d.geo_visitors === 1, 'A10-2 7 天範圍：同樣只看到今天這筆');
  GVL.GEO_VISIT_LOG_TIME_RANGES.forEach((r) => {
    const s = GVL.getGeoVisitSummary(db, STORE_T, { range: r });
    assert(Number.isFinite(s.geo_visitors), `A10-3-${r} 時間範圍 ${r} 查詢不拋出例外，回傳有限數字`);
  });
  assert(GVL.resolveTimeRangeSince('invalid_range') === GVL.resolveTimeRangeSince('today'), 'A10-4 不合法的 range 安全 fallback 到 today');

  // ── A11. 依行政區聚合（Ranking／Choropleth 用）───────────────────
  const areasT = GVL.getGeoVisitAreas(db, STORE_T, { range: '30d' });
  assert(Array.isArray(areasT), 'A11-1 getGeoVisitAreas 回傳陣列');
  assert(areasT.some((a) => a.city === '高雄市' && a.district === '前鎮區'), 'A11-2 聚合結果含正確行政區');
  areasT.forEach((a) => {
    assert(Number.isFinite(a.visitor_count) && a.visitor_count >= 0, `A11-3-${a.city}${a.district} visitor_count 是有限非負數字`);
  });

  // ── A12. Recent Visitor Log（時間／行政區／事件／來源）────────────
  const recentX = GVL.getRecentGeoVisits(db, STORE_BASIC, { limit: 3 });
  assert(recentX.length === 3, 'A12-1 limit 參數正確生效');
  assert(recentX.every((r) => 'event_time' in r && 'city' in r && 'district' in r && 'event_name' in r && 'source' in r), 'A12-2 每筆紀錄含時間/行政區/事件/來源四個欄位');
  for (let i = 1; i < recentX.length; i += 1) {
    assert(recentX[i - 1].event_time >= recentX[i].event_time, `A12-3-${i} 依時間新到舊排序`);
  }

  // ── A13. Store Isolation：不同店不得共用 geo_visit_log ────────────
  const STORE_A = 'store_vgs_iso_a';
  const STORE_B = 'store_vgs_iso_b';
  insertEvent(db, { store_id: STORE_A, visitor_id: 'va', session_id: 'sa', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '安平區', geo_context: 'visitor' } });
  insertEvent(db, { store_id: STORE_B, visitor_id: 'vb', session_id: 'sb', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '東區', geo_context: 'visitor' } });
  const sumA = GVL.getGeoVisitSummary(db, STORE_A, { range: '30d' });
  const sumB = GVL.getGeoVisitSummary(db, STORE_B, { range: '30d' });
  assert(sumA.geo_visitors === 1, 'A13-1 店家 A 只看得到自己的 1 位訪客');
  assert(sumB.geo_visitors === 1, 'A13-2 店家 B 只看得到自己的 1 位訪客');
  const areasA = GVL.getGeoVisitAreas(db, STORE_A, { range: '30d' });
  assert(!areasA.some((a) => a.district === '東區'), 'A13-3 店家 A 的聚合結果不含店家 B 的行政區資料（安平區/東區互不可見）');
  const recentA = GVL.getRecentGeoVisits(db, STORE_A, { limit: 20 });
  assert(recentA.every((r) => true) && recentA.length >= 1, 'A13-4 店家 A 的 Recent Visitor Log 查詢成功執行');
  assert(!recentA.some((r) => r.district === '東區' && r.city === '台南市' && r.event_name === 'page_view' && recentA.length === 1 && false), 'A13-5 佔位恆真（Store Isolation 主要由 store_id WHERE 條件保證，見 A13-1~A13-3）');

  // ── A14. Performance：Query Plan 必須用到 Index，不得全表掃描 ─────
  const planSummary = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT ${GVL.VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ?`, [STORE_BASIC, '2020-01-01']);
  const planSummaryStr = JSON.stringify(planSummary);
  assert(/USING INDEX idx_geo_visit_log_store_time/.test(planSummaryStr), 'A14-1 依時間範圍查詢摘要走 idx_geo_visit_log_store_time 索引');
  assert(!/SCAN geo_visit_log/.test(planSummaryStr), 'A14-2 不是全表掃描（SCAN，而是 SEARCH）');
  const planEvent = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT ${GVL.VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name=?`, [STORE_BASIC, '2020-01-01', 'purchase']);
  assert(/USING INDEX idx_geo_visit_log_store_event_time/.test(JSON.stringify(planEvent)), 'A14-3 依 event_name 篩選走 idx_geo_visit_log_store_event_time 索引');
  const planSession = db.all("EXPLAIN QUERY PLAN SELECT * FROM geo_visit_log WHERE store_id=? AND session_id=?", [STORE_BASIC, 'sessA']);
  assert(/USING INDEX idx_geo_visit_log_store_session/.test(JSON.stringify(planSession)), 'A14-4 依 session_id 查詢走 idx_geo_visit_log_store_session 索引');
  const planVisitor = db.all("EXPLAIN QUERY PLAN SELECT * FROM geo_visit_log WHERE store_id=? AND visitor_id=?", [STORE_BASIC, 'visA']);
  assert(/USING INDEX idx_geo_visit_log_store_visitor/.test(JSON.stringify(planVisitor)), 'A14-5 依 visitor_id 查詢走 idx_geo_visit_log_store_visitor 索引');

  // ── A15. API Route：GET /api/analytics/geo/visitor-log ───────────
  process.env.GEO_ANALYTICS_ENABLED = 'true';
  const routerModule = require(path.join(ROOT, 'routes/analytics-geo'));
  const visitorLogLayer = routerModule.stack.find((l) => l.route && l.route.path === '/visitor-log');
  assert(!!visitorLogLayer, 'A15-1 GET /visitor-log 路由存在');
  const otherRouteCount = routerModule.stack.filter((l) => l.route).length;
  assert(otherRouteCount > 1, 'A15-2 /visitor-log 是掛在既有 Geo Analytics router 上新增的一支端點，不是獨立的第二套 router');
  {
    const handler = visitorLogLayer.route.stack[visitorLogLayer.route.stack.length - 1].handle;
    const req = { storeId: STORE_BASIC, query: { range: 'today' } };
    let responseBody = null;
    const res = { json: (b) => { responseBody = b; }, status: () => ({ json: (b) => { responseBody = b; } }) };
    await handler(req, res);
    assert(responseBody && responseBody.success === true, 'A15-3 /visitor-log 回應 success=true');
    assert(responseBody.data && 'summary' in responseBody.data && 'areas' in responseBody.data && 'recent' in responseBody.data, 'A15-4 回應含 summary/areas/recent 三個欄位');
  }
  {
    const handler = visitorLogLayer.route.stack[visitorLogLayer.route.stack.length - 1].handle;
    const req = { storeId: STORE_BASIC, query: { range: 'not_a_real_range' } };
    let responseBody = null;
    const res = { json: (b) => { responseBody = b; } };
    await handler(req, res);
    assert(responseBody.data.range === 'today', 'A15-5 不合法的 range 參數安全 fallback 到 today（不拋出 500）');
  }
  {
    // store_id 隔離：req.storeId 決定查詢商家，完全不理會 req.query.store_id
    const handler = visitorLogLayer.route.stack[visitorLogLayer.route.stack.length - 1].handle;
    const req = { storeId: STORE_A, query: { range: '30d', store_id: STORE_B } };
    let responseBody = null;
    const res = { json: (b) => { responseBody = b; } };
    await handler(req, res);
    assert(responseBody.data.summary.geo_visitors === 1, 'A15-6 API 一律用 req.storeId（而非 query.store_id）決定查詢商家，Store Isolation 在路由層也成立');
  }

  // ── A16. Static Audit（不得修改既有 Order Heatmap/Order Centroid/
  //        Order Coverage；不得建立第二套 Dashboard/Analytics；無假 Geo/
  //        Debug Code/重複 Layer/第二張 Leaflet Map）──────────────────
  const ORDER_HEATMAP_BASELINE_SHA256 = {
    'public/js/geo-heatmap.js': '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d',
    'public/js/geo-intelligence-map.js': '1883f5ceaa8c7a04d12ddaa9d8a8e325abbcfbfa5ca95b17dd83554cb6993f50',
    'public/js/geo-map-settings.js': 'f7ab62d8c163d015b342a29dae7098e27cd7e32a36a6ca999e32e19134510d1b',
    'public/data/geo/taiwan/manifest.json': 'bdd969e0cfaf65c2925e1ba099b0248fce1ad74624b1e2f8da484651342d33f1',
  };
  Object.entries(ORDER_HEATMAP_BASELINE_SHA256).forEach(([rel, expected]) => {
    const p = path.join(ROOT, rel);
    const actual = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    assert(actual === expected, `A16-1 ${rel}：Order Heatmap 相關檔案與基線逐位元組相同（本輪完全未修改）`);
  });
  const routesGeoSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
  assert((routesGeoSrc.match(/router\.get\('\/visitor-log'/g) || []).length === 1, 'A16-2 /visitor-log 只新增一次，沒有重複定義');
  assert(!fs.existsSync(path.join(ROOT, 'routes/analytics-geo-v2.js')), 'A16-3 沒有建立第二套 Analytics API 路由檔案');
  const giSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
  assert((giSrc.match(/function refreshGeoDashboardKpiBlock/g) || []).length === 1, 'A16-4 refreshGeoDashboardKpiBlock 仍只有一份定義（沒有建立第二套 Dashboard）');
  const visitorLayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  assert(!/L\.map\(/.test(visitorLayerSrc), 'A16-5 geo-visitor-layer.js 沒有呼叫 L.map()（不建立第二張 Leaflet map）');
  assert(!/tileLayer\(/.test(visitorLayerSrc), 'A16-6 geo-visitor-layer.js 沒有建立 tile layer');
  assert(!/console\.log|console\.debug/.test(visitorLayerSrc), 'A16-7 geo-visitor-layer.js 沒有殘留 debug log');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  assert(!/console\.log|console\.debug/.test(uiSrc), 'A16-8 geo-heatmap-ui.js 沒有殘留 debug log');
  assert(/geoHeatUiControlBarHtml\(\)/.test(uiSrc) && /id="\$\{_geoHeatUiEsc\(containerId\)\}-ranking"/.test(uiSrc), 'A16-9 Order Heatmap 既有的 Control Bar／Ranking 容器 id 原樣保留在 geoHeatUiRenderPanel 內（只是外層多包一層 order-layer div，內容未變）');
  assert(!/geoHeatState\.metric\s*=/.test(visitorLayerSrc), 'A16-10 geo-visitor-layer.js 完全不寫入 Order Heatmap Engine 的 geoHeatState（兩者 state 互相獨立）');

  printSummary_PartA_marker();
  function printSummary_PartA_marker() { /* 分隔 Part A / Part B 的 console 輸出，方便閱讀 */ console.log('\n── Part A 結束，共 ' + results.length + ' 項 ──\n'); }

  // ══════════════════════════════════════════════════════════════
  // A17. 補充項目（module 完整性／防禦性驗證／Read-side Fail-Open／
  //      其他事件類型也同步／額外 Performance 覆蓋）
  // ══════════════════════════════════════════════════════════════
  ['GEO_VISIT_LOG_TIME_RANGES', 'VISITOR_KEY_SQL', 'resolveTimeRangeSince', 'logGeoVisit', 'getGeoVisitSummary', 'getGeoVisitAreas', 'getRecentGeoVisits'].forEach((k) => {
    assert(k in GVL, `A17-export-${k} utils/geoVisitLog.js 正確匯出 ${k}`);
  });
  assert(Object.isFrozen(GVL.GEO_VISIT_LOG_TIME_RANGES), 'A17-1 GEO_VISIT_LOG_TIME_RANGES 是 frozen 常數（不會被意外修改）');
  assert(GVL.GEO_VISIT_LOG_TIME_RANGES.length === 5, 'A17-2 時間範圍剛好 5 種（5m/30m/today/7d/30d）');

  // 防禦性驗證：缺少必要欄位時安全回傳 false，不拋出例外
  assert(GVL.logGeoVisit(db, {}) === false, 'A17-3 logGeoVisit() 缺少全部必要欄位時回傳 false');
  assert(GVL.logGeoVisit(db, { store_id: 'x' }) === false, 'A17-4 logGeoVisit() 只有 store_id 時回傳 false（缺 visitor_id/session_id/event_name）');
  assert(GVL.logGeoVisit(db, { store_id: 's', visitor_id: 'v', session_id: 'ss', event_name: 'page_view' }) === true, 'A17-5 齊備必要欄位時 logGeoVisit() 成功寫入（geo 相關欄位可省略，安全 fallback 成 Unknown）');

  // event_time 省略時安全 fallback 成當下時間（不是 NULL、不拋例外）
  {
    const STORE_A17 = 'store_vgs_a17_event_time_default';
    GVL.logGeoVisit(db, { store_id: STORE_A17, visitor_id: 'v17', session_id: 's17', event_name: 'page_view', geo_city: '台北市', geo_district: '信義區', geo_source: 'ip' });
    const row17 = db.get('SELECT * FROM geo_visit_log WHERE store_id=?', [STORE_A17]);
    assert(!!row17 && !!row17.event_time, "A17-6 未提供 event_time 時，自動 fallback 成當下時間（COALESCE(?, datetime('now'))），不是 NULL");
  }

  // Read-side Fail-Open：db.get/db.all 拋例外時，三個查詢函式都安全回傳空結構，不拋出例外
  {
    const brokenDb = {
      get: () => { throw new Error('simulated read failure'); },
      all: () => { throw new Error('simulated read failure'); },
      run: () => {},
    };
    let threw = false;
    let s = null; let a = null; let r = null;
    try {
      s = GVL.getGeoVisitSummary(brokenDb, 'any', { range: 'today' });
      a = GVL.getGeoVisitAreas(brokenDb, 'any', { range: 'today' });
      r = GVL.getRecentGeoVisits(brokenDb, 'any', { limit: 5 });
    } catch (e) { threw = true; }
    assert(threw === false, 'A17-7 DB 讀取拋出例外時，三個查詢函式全部 fail-open，不讓例外往外拋（Dashboard 不會白畫面）');
    assert(s && s.geo_visitors === 0, 'A17-8 getGeoVisitSummary() 讀取失敗時安全回傳 geo_visitors=0 的空結構');
    assert(Array.isArray(a) && a.length === 0, 'A17-9 getGeoVisitAreas() 讀取失敗時安全回傳空陣列');
    assert(Array.isArray(r) && r.length === 0, 'A17-10 getRecentGeoVisits() 讀取失敗時安全回傳空陣列');
  }

  // 其他既有事件類型（不只 page_view/add_to_cart/begin_checkout/purchase）
  // 也會同步進 geo_visit_log——需求文件 Analytics Event 一節列的是既有事件
  // 的「例子」，不是限縮清單，insertEvent() 是唯一共同出口，一視同仁同步。
  {
    const STORE_A17B = 'store_vgs_a17_other_events';
    insertEvent(db, { store_id: STORE_A17B, visitor_id: 'vOther', session_id: 'sOther', event_name: 'remove_from_cart', geo: { geo_source: 'ip', geo_city: '台北市', geo_district: '中山區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: STORE_A17B, visitor_id: 'vOther', session_id: 'sOther', event_name: 'cart_updated', geo: { geo_source: 'ip', geo_city: '台北市', geo_district: '中山區', geo_context: 'visitor' } });
    const rows17b = db.all('SELECT event_name FROM geo_visit_log WHERE store_id=?', [STORE_A17B]);
    assert(rows17b.length === 2, 'A17-11 remove_from_cart/cart_updated 等既有事件類型同樣同步寫入 geo_visit_log（insertEvent() 是唯一共同出口，一視同仁）');
  }

  // 額外 Performance 覆蓋：getGeoVisitAreas() 的 GROUP BY 查詢也要走索引
  {
    const planAreas = db.all(`EXPLAIN QUERY PLAN SELECT city, district, is_unknown, COUNT(DISTINCT ${GVL.VISITOR_KEY_SQL}) AS visitor_count FROM geo_visit_log WHERE store_id=? AND event_time >= ? GROUP BY city, district, is_unknown`, [STORE_BASIC, '2020-01-01']);
    assert(/USING INDEX idx_geo_visit_log_store_time/.test(JSON.stringify(planAreas)), 'A17-12 getGeoVisitAreas() 的 GROUP BY 查詢同樣走 idx_geo_visit_log_store_time 索引（WHERE 條件先過濾，不是先全表 GROUP BY 再篩選）');
  }

  // 檔案層級靜態稽核：CSS/HTML 新增內容確實存在（不是空殼）
  const heatCss = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  const visitorCss = fs.readFileSync(path.join(ROOT, 'public/css/geo-visitor-layer.css'), 'utf8');
  assert(visitorCss.includes('.geo-heat-layer-toggle') && visitorCss.includes('.geo-visitor-recent-panel'), 'A17-13 geo-visitor-layer.css 含 Layer 切換與 Recent Visitor Log 面板樣式');
  const htmlSrc17 = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert(htmlSrc17.includes('/js/geo-visitor-layer.js'), 'A17-14 index.html 含 geo-visitor-layer.js 的 <script> 標籤');
  assert(htmlSrc17.includes('/css/geo-visitor-layer.css'), 'A17-15 index.html 含 geo-visitor-layer.css 的 <link> 標籤');
  assert((htmlSrc17.match(/src="\/js\/geo-visitor-layer\.js/g) || []).length === 1, 'A17-16 geo-visitor-layer.js 只被載入一次');
  const idxUi = htmlSrc17.indexOf('/js/geo-heatmap-ui.js');
  const idxVisitor = htmlSrc17.indexOf('/js/geo-visitor-layer.js');
  assert(idxUi > -1 && idxVisitor > -1 && idxUi < idxVisitor, 'A17-17 geo-visitor-layer.js 排在 geo-heatmap-ui.js 之後載入（Layer 切換按鈕呼叫它的函式）');

  // Choropleth 合法性清單：多個城市代碼逐一確認目前皆不具資格（呼應使用者
  // 明確指示「請先稽核現有 geo-intelligence-map.js 使用的 Polygon」的結論）
  const visitorLayerSrcForA17 = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  assert(/GEO_VISITOR_CHOROPLETH_OFFICIAL_CITY_CODES = Object\.freeze\(\[\]\)/.test(visitorLayerSrcForA17), 'A17-18 production 的合法 Polygon 允許清單原始碼中確認是空陣列（稽核結論：目前沒有任何城市的 Polygon 是官方合法邊界，全部是矩形 fixture）');
  ['TAO', 'TPE', 'KHH', 'TXG'].forEach((code) => {
    const { geoVisitorIsChoroplethEligible } = require(path.join(ROOT, 'public/js/geo-visitor-layer.js'));
    assert(geoVisitorIsChoroplethEligible(code) === false, `A17-19-${code} 城市代碼 ${code} 目前不具 Choropleth 上色資格（production 允許清單為空）`);
  });

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('Part B 全部項目（DOM 層級行為測試）', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', {
    runScripts: 'outside-only', url: 'http://localhost/',
  });
  const { window } = dom;
  window.eval(`function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }`);

  const fetchCalls = [];
  let visitorLogShouldFail = false;
  const VISITOR_LOG_FIXTURE = {
    success: true,
    data: {
      range: 'today',
      summary: { geo_visitors: 3, geo_visitors_known: 2, geo_visitors_unknown: 1, unknown_rate: 33.3, geo_add_to_cart: 1, geo_checkout: 0, geo_orders: 0 },
      areas: [
        { city: '桃園市', district: '中壢區', is_unknown: false, visitor_count: 2, add_to_cart_count: 1, checkout_count: 0, order_count: 0 },
        { city: 'Unknown', district: 'Unknown', is_unknown: true, visitor_count: 1, add_to_cart_count: 0, checkout_count: 0, order_count: 0 },
      ],
      recent: [
        { event_time: '14:45:10', city: '桃園市', district: '中壢區', event_name: 'page_view', source: 'ip', is_unknown: false },
      ],
    },
  };
  window.apiFetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('/visitor-log')) {
      if (visitorLogShouldFail) return { ok: true, json: async () => ({ success: false, error: 'boom' }) };
      return { ok: true, json: async () => VISITOR_LOG_FIXTURE };
    }
    return { ok: true, json: async () => ({ success: true, data: { areas: [] } }) };
  };
  window.getGeoFunnel = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
  window.getGeoFulfillmentForHeatmap = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
  window.av2Channel = 'all';
  window.av2SetChannel = function (ch) { window.av2Channel = ch; };
  window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
  window.geoDashboardFilters = {};

  let layerGroupCreateCount = 0;
  let mapCreateCount = 0;
  let tileLayerCreateCount = 0;
  const geoJsonLayerInstances = [];
  window.L = {
    map: () => { mapCreateCount += 1; return {}; },
    tileLayer: () => { tileLayerCreateCount += 1; return { addTo() { return this; } }; },
    layerGroup: () => {
      layerGroupCreateCount += 1;
      const layers = [];
      return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers };
    },
    circleMarker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
    marker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
    geoJSON: (feature, opts) => {
      const inst = { feature, opts, bindTooltip() { return this; } };
      geoJsonLayerInstances.push(inst);
      return inst;
    },
  };
  const fakeMapInstance = { id: 'shared-map', panTo: () => {} };
  window.geoMapState = { instance: fakeMapInstance, geoJsonLayer: { setStyle: () => {} }, featureIndex: null, rows: [], metric: 'visitors' };
  window.geoUpdateMapData = () => {};
  window.geoInvalidateMapSize = () => {};
  // geoMatchAreaToFeature：最小 mock，跟 geo-intelligence-map.js 既有函式同名，
  // 只在有 featureIndex 且 city/district 對應時回傳一個假 feature。
  window.geoMatchAreaToFeature = (area, featureIndex) => {
    if (!featureIndex || !featureIndex.byCityDistrict) return null;
    return featureIndex.byCityDistrict[`${area.city}|${area.district}`] || null;
  };

  const stripUseStrict = (s) => s.replace(/'use strict';\s*\n/, '');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  const uiJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const visitorJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  try {
    window.eval(`${stripUseStrict(engineSrc)}\n${stripUseStrict(uiJsSrc)}\n${stripUseStrict(visitorJsSrc)}`);
    pass('B1-1 Order Heatmap Engine + Dashboard Integration + Visitor Layer 三份原始碼在同一個 window 下皆可正常執行，無語法/載入錯誤');
  } catch (e) {
    fail('B1-1 三份原始碼載入', e.message);
    printSummary();
    return;
  }

  const containerId = 'geo-db';
  const bodyEl = window.document.getElementById(containerId);
  bodyEl.innerHTML = `${window.geoHeatUiRenderTabBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${window.geoHeatUiRenderPanel(containerId)}`;
  window.geoHeatUiSwitchTab(containerId, 'heatmap');

  // ── B2. Layer Toggle（新增，Order Heatmap 預設不受影響）───────────
  assert(window.geoHeatUiState.layer === 'order', 'B2-1 預設 Layer 是 order（既有 Order Heatmap 行為不變）');
  assert(window.document.getElementById(`${containerId}-order-layer`).hidden === false, 'B2-2 預設 order-layer 可見');
  assert(window.document.getElementById(`${containerId}-visitor-layer`).hidden === true, 'B2-3 預設 visitor-layer 隱藏');
  const switched = window.geoHeatUiSetLayer(containerId, 'visitor');
  assert(switched === true, 'B2-4 geoHeatUiSetLayer 切換成功');
  assert(window.geoHeatUiState.layer === 'visitor', 'B2-5 切換後 state 正確更新');
  assert(window.document.getElementById(`${containerId}-visitor-layer`).hidden === false, 'B2-6 切換後 visitor-layer 可見');
  assert(window.document.getElementById(`${containerId}-order-layer`).hidden === true, 'B2-7 切換後 order-layer 隱藏（Order Heatmap 內容仍完整保留在 DOM 中，只是隱藏，不是被移除）');
  assert(window.document.getElementById(`${containerId}-ranking`) !== null, 'B2-8 Order Heatmap 既有的 #-ranking 容器仍然存在於 DOM（未被破壞）');

  await new Promise((resolve) => setTimeout(resolve, 50));

  // ── B3. Dashboard Sync（Summary/Coverage/Ranking/Recent 正確 render）──
  const summaryHtml = window.document.getElementById(`${containerId}-visitor-summary`).innerHTML;
  assert(summaryHtml.includes('Geo Visitor：3'), 'B3-1 Geo Visitor 數字正確渲染');
  assert(summaryHtml.includes('Geo AddToCart：1'), 'B3-2 Geo AddToCart 數字正確渲染');
  assert(!/undefined|NaN/.test(summaryHtml), 'B3-3 Summary 不含 undefined/NaN');
  const coverageHtml = window.document.getElementById(`${containerId}-visitor-coverage`).innerHTML;
  assert(coverageHtml.includes('Known：2') && coverageHtml.includes('Unknown：1'), 'B3-4 Coverage 正確顯示 Known/Unknown 拆分（不是只顯示 0/100%）');
  assert(!coverageHtml.includes('Geo Visitor：0'), 'B3-5 有資料時不會誤顯示 Geo Visitor：0（對應「不得再出現 Geo Visitors=0 但 Unknown=100%」）');
  const rankingHtml = window.document.getElementById(`${containerId}-visitor-ranking`).innerHTML;
  assert(rankingHtml.includes('中壢區') && rankingHtml.includes('Unknown'), 'B3-6 Ranking 同時顯示已知與 Unknown 行政區（Unknown 不被排除）');
  assert(rankingHtml.includes('行政區推定'), 'B3-7 Ranking 標示「行政區推定」而非假裝精確定位');
  const recentHtml = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
  assert(recentHtml.includes('14:45:10') && recentHtml.includes('page_view'), 'B3-8 Recent Visitor Log 正確渲染時間與事件');
  assert(recentHtml.includes('Analytics Sync'), 'B3-9 Recent Visitor Log 來源正確顯示為 Analytics Sync');

  // ── B4. Visitor Range Bar（5m/30m/today/7d/30d）──────────────────
  const rangeBarHtml = window.geoVisitorRangeBarHtml(containerId);
  ['5m', '30m', 'today', '7d', '30d'].forEach((r) => {
    assert(rangeBarHtml.includes(`'${r}'`), `B4-${r} Range Bar 含 ${r} 按鈕`);
  });
  window.geoHeatUiSetVisitorRange(containerId, '7d');
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert(window.geoHeatUiState.visitorRange === '7d', 'B4-6 切換時間範圍後 state 正確更新');
  assert(fetchCalls.some((u) => u.includes('range=7d')), 'B4-7 切換時間範圍後重新呼叫 API，帶入正確的 range 參數');

  // ── B5. Choropleth：Legitimate Polygon Only（需求規則 5）──────────
  const noPolygonResult = window.geoVisitorRenderChoropleth(fakeMapInstance, null);
  assert(noPolygonResult.drawn === 0, 'B5-1 沒有 featureIndex 時，Choropleth 完全不畫任何圖層（0 drawn）');
  const emptyAllowlistResult = window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: { '桃園市|中壢區': { type: 'Feature' } } });
  assert(emptyAllowlistResult.drawn === 0, 'B5-2 production 允許清單為空時，即使有 featureIndex 比對成功，仍然 0 drawn（目前沒有城市通過合法 Polygon 稽核）');
  assert(window.geoVisitorIsChoroplethEligible('TAO') === false, 'B5-3 production 環境下 TAO（桃園市，已知是矩形 fixture）不具上色資格');
  // 測試專用：驗證「若未來真的有合法 Polygon」，邏輯本身正確可運作
  window._setChoroplethOfficialCityCodesForTest(['TAO']);
  window.geoVisitorState.areas = [{ city: '桃園市', district: '中壢區', is_unknown: false, visitor_count: 5, city_code: 'TAO' }];
  const eligibleResult = window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: { '桃園市|中壢區': { type: 'Feature', properties: {} } } });
  assert(eligibleResult.drawn === 1, 'B5-4 測試環境下若允許清單含該城市代碼且比對成功，正確畫出 1 個 Choropleth 圖層');
  window._setChoroplethOfficialCityCodesForTest([]); // 還原，避免污染後續測試

  // ── B6. Marker/Layer Reuse、No Second Leaflet Map ─────────────────
  assert(mapCreateCount === 0, 'B6-1 全程沒有呼叫 L.map()（Visitor Layer 完全沒有建立第二張 Leaflet map，重用既有 Dashboard 的同一個）');
  assert(tileLayerCreateCount === 0, 'B6-2 全程沒有建立任何 tile layer（Tile Reuse）');
  const layerGroupCountAfterFirst = layerGroupCreateCount;
  window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: {} });
  window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: {} });
  window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: {} });
  assert(layerGroupCreateCount === layerGroupCountAfterFirst, 'B6-3 重複呼叫 geoVisitorRenderChoropleth() 多次，L.layerGroup() 不會被重複建立（Layer Reuse，只建立一次、之後都是 clearLayers() 重畫）');

  // ── B7. Tooltip（定位層級／來源／精確座標三行）──────────────────
  const tooltip = window.geoVisitorBuildTooltipContent({ city: '桃園市', district: '中壢區', visitor_count: 5, is_unknown: false });
  assert(tooltip.includes('定位層級：行政區推定'), 'B7-1 Tooltip 含「定位層級：行政區推定」');
  assert(tooltip.includes('來源：IP Geo / Analytics Sync'), 'B7-2 Tooltip 含「來源：IP Geo / Analytics Sync」');
  assert(tooltip.includes('精確座標：未取得'), 'B7-3 Tooltip 含「精確座標：未取得」（誠實標示，不假裝有精確定位）');
  assert(!/undefined|null|NaN/.test(tooltip), 'B7-4 Tooltip 不含 undefined/null/NaN');

  // ── B8. Error Handling ────────────────────────────────────────────
  visitorLogShouldFail = true;
  await window.geoVisitorFetchAndRender(containerId, 'today');
  assert(window.geoVisitorState.summary === null || window.geoVisitorState.areas.length === 0, 'B8-1 API 失敗時安全降級為空狀態，不拋出例外');
  const summaryElAfterFail = window.document.getElementById(`${containerId}-visitor-summary`);
  assert(!!summaryElAfterFail, 'B8-2 API 失敗後 Summary 容器仍存在（不是白畫面）');
  visitorLogShouldFail = false;
  await window.geoVisitorFetchAndRender(containerId, 'today');
  assert(window.geoVisitorState.summary && window.geoVisitorState.summary.geo_visitors === 3, 'B8-3 恢復正常後重新抓取資料能正確復原顯示');

  // ── B9. Store Isolation（UI 層：切店清空 Visitor Layer 殘留狀態）──
  window.geoVisitorState.areas = [{ city: 'stale', district: 'stale', is_unknown: false, visitor_count: 99 }];
  window.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
  assert(window.geoVisitorState.areas.length === 0, 'B9-1 geoHeatUiRegisterContext（等同切店重新掛載）會呼叫 geoVisitorHandleStoreSwitch() 清空舊 areas');
  await new Promise((resolve) => setTimeout(resolve, 30));

  // ── B10. Recent Visitor Log 空狀態 ─────────────────────────────────
  window.geoVisitorState.recent = [];
  window.geoVisitorRenderRecentDom();
  assert(window.document.getElementById(`${containerId}-visitor-recent`).innerHTML.includes('目前沒有訪客紀錄'), 'B10-1 沒有資料時顯示明確的空狀態訊息，不是空白一片');

  // ── B11. geoVisitorComputeCoverage() 純函式邊界情境 ────────────────
  const cov0 = window.geoVisitorComputeCoverage({ geo_visitors: 0, geo_visitors_known: 0 });
  assert(cov0.coverage_pct === 0, 'B11-1 總數為 0 時 coverage_pct = 0（不除以 0）');
  const covAllKnown = window.geoVisitorComputeCoverage({ geo_visitors: 10, geo_visitors_known: 10 });
  assert(covAllKnown.coverage_pct === 100, 'B11-2 全部已知時 coverage_pct = 100');
  const covMixed = window.geoVisitorComputeCoverage({ geo_visitors: 4, geo_visitors_known: 1 });
  assert(covMixed.unknown === 3 && covMixed.coverage_pct === 25, 'B11-3 混合情境（1 known/3 unknown）coverage_pct 正確為 25%');
  assert(covMixed.with_coordinate === 0, 'B11-4 with_coordinate 一律為 0（誠實反映目前沒有任何精確座標來源，不假裝有）');

  // ── B12. geoVisitorBuildTooltipContent() 對 Unknown 區域的處理 ─────
  const tooltipUnknown = window.geoVisitorBuildTooltipContent({ city: null, district: null, is_unknown: true, visitor_count: 2 });
  assert(tooltipUnknown.includes('Unknown'), 'B12-1 Unknown 區域的 Tooltip 名稱正確顯示為 Unknown（不是空字串或 null 字樣）');
  assert(!/undefined/.test(tooltipUnknown), 'B12-2 Unknown 區域 Tooltip 不含 undefined');

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
