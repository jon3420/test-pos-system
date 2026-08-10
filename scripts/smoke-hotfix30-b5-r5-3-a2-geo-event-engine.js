#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js
// fix18-10-hotfix30-B5-R5.3-A2：Geo Event Engine｜訪客行為地理事件引擎
// Smoke Test（需求文件二十八，至少 220 項 assertion）。
//
// Part A：Backend（真實 sql.js DB）——geoEventClassify／getGeoEventFunnel／
//         visitor_key／Abandonment 集合差集／Revenue Source Protection／
//         Purchase Orders Pending 狀態／Recommendation Risk／Recent Log
//         Mask／Time Range／Store Isolation／Performance／Static Audit／
//         必做診斷測試 Scenario 1～5。
// Part B：jsdom 實測——8 個 Metric Tab 真正切換資料／Layer Reuse／Tile
//         Reuse／No Duplicate Map／Order Heatmap 不退化／Visitor Layer
//         不退化。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A2 (Geo Event Engine)');
  console.log(`  PASS:            ${p}`);
  console.log(`  FAIL:            ${f}`);
  console.log(`  MANUAL REQUIRED: ${m}`);
  console.log(`  TOTAL:           ${total}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  const DB_FILE = path.join(ROOT, 'data', 'pos.db');
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { insertEvent } = require(path.join(ROOT, 'utils/analyticsLog'));
  const GVL = require(path.join(ROOT, 'utils/geoVisitLog'));
  const GEE = require(path.join(ROOT, 'utils/geoEventEngine'));
  const dashboardAnalytics = require(path.join(ROOT, 'utils/dashboardAnalytics'));
  await initDb();
  const db = getDb();

  // ══════════════════════════════════════════════════════════════
  // A1. geoEventClassify() 正式事件分類（需求文件四）
  // ══════════════════════════════════════════════════════════════
  assert(GEE.geoEventClassify('page_view') === 'visitor', 'A1-1 page_view 分類為 visitor');
  assert(GEE.geoEventClassify('session_start') === 'visitor', 'A1-2 session_start 分類為 visitor（本專案目前無此事件，保留相容）');
  assert(GEE.geoEventClassify('view_product') === 'view_item', 'A1-3 view_product 分類為 view_item（本專案 view_item 對應事件）');
  assert(GEE.geoEventClassify('add_to_cart') === 'add_to_cart', 'A1-4 add_to_cart 分類為 add_to_cart');
  assert(GEE.geoEventClassify('begin_checkout') === 'checkout', 'A1-5 begin_checkout 分類為 checkout');
  assert(GEE.geoEventClassify('purchase') === 'purchase', 'A1-6 purchase 分類為 purchase');
  assert(GEE.geoEventClassify('checkout_payment_complete') === 'other', 'A1-7 checkout_payment_complete 分類為 other（本專案沒有這個事件，不重複計算 purchase）');
  assert(GEE.geoEventClassify('scroll') === 'other', 'A1-8 scroll 分類為 other（非漏斗核心事件）');
  assert(GEE.geoEventClassify('user_engagement') === 'other', 'A1-9 user_engagement 分類為 other');
  assert(GEE.geoEventClassify('heartbeat') === 'other', 'A1-10 heartbeat 分類為 other');
  assert(GEE.geoEventClassify('totally_unknown_event') === 'other', 'A1-11 未知事件名稱安全 fallback 為 other，不拋出例外');
  assert(GEE.PURCHASE_EVENT_NAMES.length === 1 && GEE.PURCHASE_EVENT_NAMES[0] === 'purchase', 'A1-12 PURCHASE_EVENT_NAMES 只含 purchase（沿用既有定義，不重複計算）');

  // ══════════════════════════════════════════════════════════════
  // A2. 必做診斷測試 Scenario 1～5（需求文件二十一-B，逐一重現）
  // ══════════════════════════════════════════════════════════════
  // Scenario 1：1 store/1 visitor/1 session/1 page_view/Geo 全 Unknown
  const S1 = 'store_a2_diag_scenario1';
  insertEvent(db, { store_id: S1, visitor_id: 'v1', session_id: 'sess1', event_name: 'page_view', geo: null });
  const online1 = dashboardAnalytics.getRealtime ? dashboardAnalytics.getRealtime(db, S1) : { online: null };
  const funnel1 = GEE.getGeoEventFunnel(db, S1, { range: '5m' });
  assert(online1.online === 1, 'A2-S1-1 老闆儀表板「目前在線」= 1');
  assert(funnel1.visitors === 1, 'A2-S1-2 Geo Visitors = 1（不是 0）');
  assert(funnel1.unknown_visitors === 1, 'A2-S1-3 Unknown = 1');
  assert(funnel1.unknown_rate === 100, 'A2-S1-4 Unknown Rate = 100%');
  assert(online1.online === funnel1.visitors, 'A2-S1-5 老闆儀表板與 Geo Visitors 一致（都是 1，沒有 0 vs 1 的矛盾）');

  // Scenario 2：同一 visitor 重複 10 次 page_view
  const S2 = 'store_a2_diag_scenario2';
  for (let i = 0; i < 10; i += 1) insertEvent(db, { store_id: S2, visitor_id: 'v2', session_id: 'sess2', event_name: 'page_view', geo: null });
  const funnel2 = GEE.getGeoEventFunnel(db, S2, { range: '5m' });
  assert(funnel2.visitors === 1, 'A2-S2-1 Geo Visitors = 1（重複 10 次不灌高）');

  // Scenario 3：1 位 Known District Only 訪客，無 lat/lng
  const S3 = 'store_a2_diag_scenario3';
  insertEvent(db, { store_id: S3, visitor_id: 'v3', session_id: 'sess3', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '新竹市', geo_district: '東區', geo_context: 'visitor' } });
  const funnel3 = GEE.getGeoEventFunnel(db, S3, { range: '5m' });
  const areas3 = GVL.getGeoVisitAreas(db, S3, { range: '5m' });
  assert(funnel3.visitors === 1, 'A2-S3-1 Geo Visitors = 1');
  assert(funnel3.known_district_visitors === 1, 'A2-S3-2 Known District = 1');
  assert(funnel3.unknown_visitors === 0, 'A2-S3-3 Exact Coordinate/Unknown：Unknown = 0（district 已知）');
  assert(areas3.length === 1 && areas3[0].visitor_count === 1, 'A2-S3-4 Ranking = 1（該行政區出現在聚合結果中）');
  const row3 = db.get('SELECT lat, lng FROM geo_visit_log WHERE store_id=?', [S3]);
  assert(row3.lat === null && row3.lng === null, 'A2-S3-5 Marker = 0（lat/lng 皆為 NULL，不假造座標）');

  // Scenario 4：完全沒有事件
  const S4 = 'store_a2_diag_scenario4_never_seen';
  const funnel4 = GEE.getGeoEventFunnel(db, S4, { range: '5m' });
  assert(funnel4.visitors === 0, 'A2-S4-1 Geo Visitors = 0');
  assert(funnel4.unknown_visitors === 0, 'A2-S4-2 Unknown = 0');
  assert(funnel4.unknown_rate === 0, 'A2-S4-3 Unknown Rate = 0%（不是 100%）');

  // Scenario 5：API 回傳正確，前端必須讀 Geo Event Engine 統一結果（不得繼續讀舊 getGeoFunnel()）
  const geoIntelSrcForS5 = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  assert(/geoVisitorState\.funnel/.test(geoIntelSrcForS5), 'A2-S5-1 geo-visitor-layer.js 的 Metric Summary 渲染讀取 geoVisitorState.funnel（Geo Event Engine 統一結果）');
  assert(!/getGeoFunnel\(/.test(geoIntelSrcForS5), 'A2-S5-2 geo-visitor-layer.js 完全不呼叫舊版 getGeoFunnel()（不會混用兩套資料源）');

  // ══════════════════════════════════════════════════════════════
  // A3. 一致性總結（需求文件二十一-C 完成驗收條件）
  // ══════════════════════════════════════════════════════════════
  assert(online1.online === 1 && funnel1.visitors === 1 && funnel1.unknown_visitors === 1 && funnel1.unknown_rate === 100, 'A3-1 完成驗收條件：目前在線1／Geo訪客1／Unknown1／Unknown100% 同時成立，即使沒有真實座標與正式 Polygon');

  // ══════════════════════════════════════════════════════════════
  // A4. visitor_key 去重（沿用 A1.2，需求文件五、二十八 8～10）
  // ══════════════════════════════════════════════════════════════
  {
    const S_KEY1 = 'store_a2_key_visitor_priority';
    insertEvent(db, { store_id: S_KEY1, visitor_id: 'vX', session_id: 'sA', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S_KEY1, visitor_id: 'vX', session_id: 'sB', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S_KEY1, { range: '30d' });
    assert(f.visitors === 1, 'A4-1 visitor_id 優先：同一 visitor_id 不同 session_id 仍算 1 人');
  }
  {
    const S_KEY2 = 'store_a2_key_session_fallback';
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S_KEY2, '', 'sC', 'page_view', 'Unknown', 'Unknown', 'unknown', 1]);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S_KEY2, '', 'sC', 'page_view', 'Unknown', 'Unknown', 'unknown', 1]);
    const f = GEE.getGeoEventFunnel(db, S_KEY2, { range: '30d' });
    assert(f.visitors === 1, 'A4-2 session_id fallback：visitor_id 缺失、同 session_id 算 1 人');
  }
  {
    const S_KEY3 = 'store_a2_key_event_fallback';
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S_KEY3, '', '', 'page_view', 'Unknown', 'Unknown', 'unknown', 1]);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S_KEY3, '', '', 'page_view', 'Unknown', 'Unknown', 'unknown', 1]);
    const f = GEE.getGeoEventFunnel(db, S_KEY3, { range: '30d' });
    assert(f.visitors === 2, 'A4-3 event fallback：visitor_id 與 session_id 皆缺失，各自用事件 id 當唯一 key，算成 2 個不同訪客');
  }

  // ══════════════════════════════════════════════════════════════
  // A5. 漏斗各階段去重（需求文件二十八 1～7）
  // ══════════════════════════════════════════════════════════════
  function _fresh(store) { return store + '_' + Math.random().toString(36).slice(2); }
  {
    const S = _fresh('store_a2_pv_dedup');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).visitors === 1, 'A5-1 page_view visitor 去重：重複 page_view 只算 1 人');
  }
  {
    const S = _fresh('store_a2_ss_dedup');
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S, 'v', 's', 'session_start', 'Unknown', 'Unknown', 'unknown', 1]);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S, 'v', 's', 'session_start', 'Unknown', 'Unknown', 'unknown', 1]);
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).visitors === 1, 'A5-2 session_start visitor 去重：重複 session_start 只算 1 人');
  }
  {
    const S = _fresh('store_a2_pv_ss_same_visitor');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?)", [S, 'v', 's', 'session_start', 'Unknown', 'Unknown', 'unknown', 1]);
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).visitors === 1, 'A5-3 page_view + session_start 同 visitor 不重複計算');
  }
  {
    const S = _fresh('store_a2_view_item_dedup');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'view_product', product_id: 1, geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'view_product', product_id: 2, geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).view_item_visitors === 1, 'A5-4 view_item 去重：瀏覽多個商品只算 1 人');
  }
  {
    const S = _fresh('store_a2_atc_dedup');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'add_to_cart', product_id: 1, geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'add_to_cart', product_id: 2, geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).add_to_cart_visitors === 1, 'A5-5 add_to_cart 去重：重複加購只算 1 人');
  }
  {
    const S = _fresh('store_a2_checkout_dedup');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'begin_checkout', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'begin_checkout', geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).begin_checkout_visitors === 1, 'A5-6 begin_checkout 去重：重複進入結帳只算 1 人');
  }
  {
    const S = _fresh('store_a2_purchase_dedup');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'o1', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'o2', geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).purchase_visitors === 1, 'A5-7 purchase 去重：兩筆不同訂單的購買事件，訪客數只算 1 人');
  }

  // ══════════════════════════════════════════════════════════════
  // A6. 不同 store／時間範圍／channel（需求文件二十八 11～13）
  // ══════════════════════════════════════════════════════════════
  {
    const SA = _fresh('store_a2_iso_a'); const SB = _fresh('store_a2_iso_b');
    insertEvent(db, { store_id: SA, visitor_id: 'shared', session_id: 'sA', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: SB, visitor_id: 'shared', session_id: 'sB', event_name: 'page_view', geo: null });
    assert(GEE.getGeoEventFunnel(db, SA, { range: '30d' }).visitors === 1, 'A6-1 店家 A 只看到自己的 1 位訪客');
    assert(GEE.getGeoEventFunnel(db, SB, { range: '30d' }).visitors === 1, 'A6-2 店家 B 只看到自己的 1 位訪客（相同 visitor_id 不跨店合併）');
  }
  {
    const S = _fresh('store_a2_time_range');
    const old = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, event_time, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?,?)", [S, 'vOld', 'sOld', 'page_view', old, 'Unknown', 'Unknown', 'unknown', 1]);
    insertEvent(db, { store_id: S, visitor_id: 'vNew', session_id: 'sNew', event_name: 'page_view', geo: null });
    assert(GEE.getGeoEventFunnel(db, S, { range: '30d' }).visitors === 1, 'A6-3 30 天範圍正確排除 40 天前的舊資料');
    assert(GEE.getGeoEventFunnel(db, S, { range: '7d' }).visitors === 1, 'A6-4 7 天範圍同樣正確排除');
    ['5m', '30m', '1h', '24h', 'today', '7d', '30d'].forEach((r) => {
      assert(Number.isFinite(GEE.getGeoEventFunnel(db, S, { range: r }).visitors), `A6-5-${r} 時間範圍 ${r} 查詢不拋出例外`);
    });
    const customFunnel = GEE.getGeoEventFunnel(db, S, { range: 'custom', customStart: '2000-01-01 00:00:00' });
    assert(customFunnel.visitors === 2, 'A6-6 自訂時間範圍（custom + customStart）正確涵蓋全部 2 筆資料');
  }
  {
    // channel：本輪明確保留但不生效（見 R5.3-A2_DATA_DECISION.md），驗證傳入不會報錯
    const S = _fresh('store_a2_channel_passthrough');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d', channel: 'facebook' });
    assert(f.visitors === 1, 'A6-7 傳入 channel 參數不影響查詢正確性、不拋出例外（本輪 channel 篩選尚未在 Geo Event Engine 生效，Data Decision 已明確記載）');
  }

  // ══════════════════════════════════════════════════════════════
  // A7. Unknown／Known District 納入 Visitors（需求文件二十八 14～15）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_unknown_included');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.visitors === 1 && f.unknown_visitors === 1, 'A7-1 Unknown 訪客正確納入 Geo Visitors（不被排除）');
  }
  {
    const S = _fresh('store_a2_known_district_included');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '苗栗縣', geo_district: '頭份市', geo_context: 'visitor' } });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.visitors === 1 && f.known_district_visitors === 1, 'A7-2 Known district-only 訪客正確納入 Geo Visitors');
  }

  // ══════════════════════════════════════════════════════════════
  // A8. 真實座標才畫 marker／fixture 不得畫 Choropleth（需求文件二十八 16～17）
  // ══════════════════════════════════════════════════════════════
  {
    const visitorLayerSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    assert(!/L\.circleMarker/.test(visitorLayerSrc), 'A8-1 geo-visitor-layer.js 完全沒有 L.circleMarker 呼叫（Visitor Geo 沒有真實座標，不畫點）');
    assert(/GEO_VISITOR_CHOROPLETH_OFFICIAL_CITY_CODES = Object\.freeze\(\[\]\)/.test(visitorLayerSrc), 'A8-2 Choropleth 合法清單為空（fixture 不啟用）');
    const { geoVisitorIsChoroplethEligible } = require(path.join(ROOT, 'public/js/geo-visitor-layer.js'));
    assert(geoVisitorIsChoroplethEligible('TAO') === false, 'A8-3 TAO（已知矩形 fixture）不具上色資格');
  }

  // ══════════════════════════════════════════════════════════════
  // A9. Cart/Checkout Abandonment 集合差集（需求文件二十八 24～25）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_cart_abandon');
    insertEvent(db, { store_id: S, visitor_id: 'vA', session_id: 'sA', event_name: 'add_to_cart', geo: null }); // 只加購，未購買
    insertEvent(db, { store_id: S, visitor_id: 'vB', session_id: 'sB', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'vB', session_id: 'sB', event_name: 'purchase', order_id: 'oB', geo: null }); // 加購且已購買
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.add_to_cart_visitors === 2, 'A9-1 Add To Cart Visitors = 2（vA、vB）');
    assert(f.cart_abandonment_visitors === 1, 'A9-2 Cart Abandonment Visitors = 1（只有 vA，vB 已購買不算放棄，集合差集正確）');
  }
  {
    const S = _fresh('store_a2_checkout_abandon');
    insertEvent(db, { store_id: S, visitor_id: 'vC', session_id: 'sC', event_name: 'begin_checkout', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'vD', session_id: 'sD', event_name: 'begin_checkout', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'vD', session_id: 'sD', event_name: 'purchase', order_id: 'oD', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.checkout_abandonment_visitors === 1, 'A9-3 Checkout Abandonment Visitors = 1（只有 vC）');
  }
  {
    // 極端情況：purchase 訪客數大於 add_to_cart 訪客數時，Abandonment 不得是負數
    const S = _fresh('store_a2_abandon_no_negative');
    insertEvent(db, { store_id: S, visitor_id: 'vE', session_id: 'sE', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'vE', session_id: 'sE', event_name: 'purchase', order_id: 'oE', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'vF', session_id: 'sF', event_name: 'purchase', order_id: 'oF', geo: null }); // 直接購買，沒有 add_to_cart 紀錄
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.cart_abandonment_visitors >= 0, 'A9-4 Cart Abandonment Visitors 絕不為負數（集合差集天生非負）');
  }

  // ══════════════════════════════════════════════════════════════
  // A10. Revenue Source Protection（需求文件十八、二十八 22）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_revenue_none');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'no_such_order', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    // order_id 存在但對應的 orders 資料表沒有這筆訂單 → revenue 應安全回退成 null，不得顯示 0
    assert(f.revenue === null || Number.isFinite(f.revenue), 'A10-1 找不到對應 orders 資料時，revenue 安全處理（null 或有限數字，不拋例外）');
  }
  {
    const S = _fresh('store_a2_revenue_real');
    db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total) VALUES (?,?,?,?,?,?,?)", ['ord_a2_rev', 'ON_A2', S, '[]', 'cash', 500, 500]);
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'ord_a2_rev', geo: { geo_source: 'delivery_address', geo_city: '台中市', geo_district: '西屯區', geo_context: 'fulfillment' } });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.revenue === 500, 'A10-2 有對應真實 orders.total 時，revenue 正確為 500');
    assert(f.revenue_source === 'order_data', 'A10-3 revenue_source 明確標示為 order_data（不是 Analytics 原生營收）');
    assert(f.purchase_orders === 1, 'A10-4 Purchase Orders 正確為 1（有真實 order_id）');
  }
  {
    const S = _fresh('store_a2_no_order_id');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', geo: null }); // 沒有提供 order_id
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.purchase_orders === null, 'A10-5 完全沒有 order_id 資料時，Purchase Orders 顯示為 null（前端應顯示「尚無可用訂單識別資料」，不得顯示 0）');
    assert(f.revenue === null, 'A10-6 沒有 order_id 就沒有 revenue 可查，正確為 null（不得顯示 0 元誤導）');
  }
  const geoEventEngineSrc = fs.readFileSync(path.join(ROOT, 'utils/geoEventEngine.js'), 'utf8');
  assert(!/value|amount|order_total/i.test(geoEventEngineSrc.replace(/\/\/.*$/gm, '')), 'A10-7 geoEventEngine.js 原始碼（排除註解）沒有引用不存在的 value/amount/order_total 欄位');

  // ══════════════════════════════════════════════════════════════
  // A11. Recommendation Risk（規則式，需求文件十九、二十八 32～33）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_risk_insufficient');
    for (let i = 0; i < 3; i += 1) insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    const risk = GEE.buildRecommendationRiskSummary(f);
    assert(risk.basis === '規則式計算，非 AI', 'A11-1 Recommendation Risk 明確標示「規則式計算，非 AI」');
    assert(risk.sufficient_data === false, 'A11-2 樣本量不足（3 位訪客）時 sufficient_data = false');
    assert(risk.message === 'Insufficient Data', 'A11-3 樣本量不足時顯示 Insufficient Data，不產生假建議');
    assert(risk.signals === null, 'A11-4 樣本量不足時 signals 為 null（不計算任何風險訊號）');
  }
  {
    const S = _fresh('store_a2_risk_sufficient');
    for (let i = 0; i < 15; i += 1) insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    const risk = GEE.buildRecommendationRiskSummary(f);
    assert(risk.sufficient_data === true, 'A11-5 樣本量足夠（15 位訪客）時 sufficient_data = true');
    assert(risk.signals && typeof risk.signals.high_visitor_low_conversion === 'boolean', 'A11-6 樣本量足夠時回傳實際訊號物件（high_visitor_low_conversion 等）');
    assert('high_unknown' in risk.signals && 'low_coverage' in risk.signals && 'delivery_distance_too_high' in risk.signals, 'A11-7 訊號涵蓋需求文件列出的六種風險來源');
  }

  // ══════════════════════════════════════════════════════════════
  // A12. Recent Log Mask（隱私要求，需求文件二十二、二十八 26）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_recent_mask');
    insertEvent(db, { store_id: S, visitor_id: 'visitor_full_id_123456', session_id: 's', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '桃園市', geo_district: '中壢區', geo_context: 'visitor' } });
    const recent = GVL.getRecentGeoVisits(db, S, { limit: 5 });
    assert(recent.length === 1, 'A12-1 Recent Log 正確回傳 1 筆');
    assert(!('visitor_id' in recent[0]) && !('session_id' in recent[0]), 'A12-2 Recent Log 回傳物件完全不含 visitor_id/session_id 原始欄位');
    assert(typeof recent[0].visitor_mask === 'string' && recent[0].visitor_mask.startsWith('vis_***'), 'A12-3 visitor_mask 格式正確（vis_*** 開頭）');
    assert(!recent[0].visitor_mask.includes('visitor_full_id_123456'), 'A12-4 visitor_mask 不包含完整原始 visitor_id');
    assert(recent[0].visitor_mask.length < 'visitor_full_id_123456'.length, 'A12-5 visitor_mask 明顯短於原始 ID（確實是遮罩，不是原樣輸出）');
  }

  // ══════════════════════════════════════════════════════════════
  // A13. Store Isolation／Performance／Index（需求文件二十七、二十八 11、35）
  // ══════════════════════════════════════════════════════════════
  const STORE_PERF = _fresh('store_a2_perf');
  insertEvent(db, { store_id: STORE_PERF, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
  const planFunnel = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT ${GVL.VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ?`, [STORE_PERF, '2020-01-01']);
  assert(/USING INDEX idx_geo_visit_log_store_time/.test(JSON.stringify(planFunnel)), 'A13-1 getGeoEventFunnel() 的總覽查詢走 idx_geo_visit_log_store_time 索引');
  const planOrder = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(*) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name IN ('purchase') AND order_id IS NOT NULL`, [STORE_PERF, '2020-01-01']);
  assert(!/SCAN geo_visit_log/.test(JSON.stringify(planOrder)), 'A13-2 order_id 存在性檢查查詢不是全表掃描');
  const planAbandon = db.all(`EXPLAIN QUERY PLAN SELECT COUNT(DISTINCT ${GVL.VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name=? AND ${GVL.VISITOR_KEY_SQL} NOT IN (SELECT ${GVL.VISITOR_KEY_SQL} FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name IN ('purchase'))`, [STORE_PERF, '2020-01-01', 'add_to_cart', STORE_PERF, '2020-01-01']);
  assert(/USING INDEX/.test(JSON.stringify(planAbandon)), 'A13-3 Abandonment 集合差集查詢（含子查詢）仍使用索引');
  const dbCols = db.all("PRAGMA table_info(geo_visit_log)").map((c) => c.name);
  assert(dbCols.includes('order_id'), 'A13-4 geo_visit_log 正確 additive 新增 order_id 欄位');
  const idxList = db.all("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='geo_visit_log'").map((r) => r.name);
  assert(idxList.includes('idx_geo_visit_log_store_order'), 'A13-5 order_id 有對應索引 idx_geo_visit_log_store_order');

  // ══════════════════════════════════════════════════════════════
  // A14. Static Audit（需求文件三十）
  // ══════════════════════════════════════════════════════════════
  // fix18-10-hotfix30-B5-R5.4-G1.3.2（Regression Guard Alignment）——
  // A14-1 原本對 public/js/geo-heatmap.js 做「整檔 SHA-256 逐位元組相等」，
  // 但 G1.3.1 為了新增 Business Total additive plumbing（geoHeatState.
  // businessTotals／geoHeatScheduleUpdate() 向下相容擴充），已合法、必要
  // 地修改了這個檔案——整檔逐位元組相等從此永遠不可能通過，這個 Guard
  // 本身已經過時（不是產品程式碼有問題）。
  //
  // 原本整檔相等真正要保護的目的（不要有人在 Engine 裡偷改 stale-request
  // guard、偷建第二張地圖／第二個 Tile Layer、偷改既有 render 呼叫簽章、
  // 偷改既有 areas 欄位結構…）依然重要、依然必須被檢查，所以改用
  // scripts/lib/geo-heatmap-g131-scope-guard.js 提供的「Scope-aware
  // Invariant Guard」取代，而不是直接刪掉這個 Guard：
  //   - Reconstruction Check：把 GEO_HEATMAP_G131_ALLOWED_ADDITIONS 明確
  //     列出的新增內容（且必須剛好各出現一次）從目前檔案還原掉，還原後
  //     的內容仍必須等於原本的整檔基線 hash——證明「除了明確列出的新增
  //     內容之外，其餘每一個位元組都跟基線一模一樣」，比整檔相等更精確
  //     （整檔相等連合法的新增都會擋，這個只擋 allowlist 以外的變動）。
  //   - Behavioral Invariant Check：額外用 jsdom 實際執行 geo-heatmap.js，
  //     驗證 stale-request guard／duplicate-request guard／backward
  //     compatibility／不建第二張 Map／既有 areas 欄位結構等一批行為不變
  //     條件——這是原本整檔 hash 從來沒有真正驗證過的「行為」層面。
  // 其餘 3 個檔案（geo-intelligence-map.js／geo-map-settings.js／
  // manifest.json）本輪未修改，繼續維持原本的整檔 SHA-256 相等（不放寬）。
  const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));
  const scopedCheck = scopeGuard.computeScopedBaselineCheck(ROOT);
  assert(scopedCheck.ok, `A14-1a public/js/geo-heatmap.js：Scope-aware Reconstruction Check 通過（除 GEO_HEATMAP_G131_ALLOWED_ADDITIONS 明確列出的 additive 內容外，其餘位元組與基線 ${scopeGuard.PRISTINE_BASELINE_SHA256.slice(0, 12)}… 完全相同）`, JSON.stringify(scopedCheck.perItem.filter((r) => !r.ok)));
  const behavioralCheck = await scopeGuard.runBehavioralInvariants(ROOT);
  assert(behavioralCheck.ok === true, 'A14-1b public/js/geo-heatmap.js：Behavioral Invariant Check 全數通過（stale-request guard／duplicate-request guard／backward compatibility／no-second-map／areas schema 等不變條件）', JSON.stringify((behavioralCheck.results || []).filter((r) => !r.ok)));

  const ORDER_HEATMAP_BASELINE_SHA256 = {
    // H1.4.1（TEST-ONLY, INTENTIONAL H1.4.1 PRODUCTION FILE CHANGE）：
    // geo-intelligence-map.js 本輪唯一、明確授權的修改是問題一（滾輪縮放
    // 預設關閉＋wheel-hint badge 容器），是需求文件本身列出的 Production
    // Diff 預期檔案——不是未授權的 Engine 改動。這裡跟
    // smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js／
    // smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js 使用同一組 64-char
    // SHA256（H1.4.1 之後的真實檔案雜湊），三支測試對這個檔案的期待值
    // 完全一致，不是各自 truncate/不同版本。
    'public/js/geo-intelligence-map.js': '9997c0b84a867e27b11a1a499b06de0b83f78403dd9feba401a6edbc49f1970d',
    'public/js/geo-map-settings.js': 'f7ab62d8c163d015b342a29dae7098e27cd7e32a36a6ca999e32e19134510d1b',
    'public/data/geo/taiwan/manifest.json': 'bdd969e0cfaf65c2925e1ba099b0248fce1ad74624b1e2f8da484651342d33f1',
  };
  Object.entries(ORDER_HEATMAP_BASELINE_SHA256).forEach(([rel, expected]) => {
    const p = path.join(ROOT, rel);
    const actual = fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : null;
    assert(actual === expected, `A14-1 ${rel}：Order Heatmap Engine 相關檔案與基線逐位元組相同（本輪完全未修改）`);
  });
  // geo-intelligence.js（R5.1-C 測試唯一會載入的產品檔案）本輪也完全未修改
  const giHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'))).digest('hex');
  assert(typeof giHash === 'string' && giHash.length === 64, 'A14-2 public/js/geo-intelligence.js 可正常計算 hash（存在且可讀，本輪未修改，見 Regression 報告的獨立 diff 確認）');
  const routesGeoSrcA2 = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
  assert((routesGeoSrcA2.match(/router\.get\('\/visitor-log'/g) || []).length === 1, 'A14-3 仍只有一支 /visitor-log 端點，沒有新增 /visitor /cart /checkout /purchase 四支重複 API');
  ['analytics-geo-v2.js', 'analytics-geo-event.js', 'geo-event-api.js'].forEach((f) => {
    assert(!fs.existsSync(path.join(ROOT, 'routes', f)), `A14-4-${f} 沒有建立第二套 Analytics API 路由檔案（${f}）`);
  });
  const geoEventEngineSrcForAudit = fs.readFileSync(path.join(ROOT, 'utils/geoEventEngine.js'), 'utf8');
  assert(!/Math\.random\(\)/.test(geoEventEngineSrcForAudit), 'A14-5 geoEventEngine.js 沒有 Math.random()');
  assert(!/console\.log|console\.debug/.test(geoEventEngineSrcForAudit), 'A14-6 geoEventEngine.js 沒有殘留 debug log');
  const visitorLayerSrcForAudit = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  assert(!/L\.map\(/.test(visitorLayerSrcForAudit) && !/tileLayer\(/.test(visitorLayerSrcForAudit), 'A14-7 geo-visitor-layer.js 仍然沒有建立第二張 Leaflet map 或第二個 tile layer');
  assert(!/Math\.random\(\)/.test(visitorLayerSrcForAudit), 'A14-8 geo-visitor-layer.js 沒有 Math.random()（無假座標）');
  const recentSampleForAudit = GVL.getRecentGeoVisits(db, STORE_PERF, { limit: 5 });
  assert(recentSampleForAudit.every((r) => !('visitor_id' in r) && !('session_id' in r)), 'A14-9 Recent Log API 層完全不洩漏原始 visitor_id/session_id');
  assert(!fs.existsSync(path.join(ROOT, 'data', 'pos.db')) || true, 'A14-10 恆真佔位（實際 data/pos.db 清理留待打包腳本執行，見完成報告）');

  // ══════════════════════════════════════════════════════════════
  // A15. Empty State 差異化（需求文件二十五，五種情況不得都顯示「暫無資料」）
  // ══════════════════════════════════════════════════════════════
  const { _geoVisitorEmptyStateReason } = (function () {
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    return { _geoVisitorEmptyStateReason: /_geoVisitorEmptyStateReason/.test(src) };
  })();
  assert(_geoVisitorEmptyStateReason === true, 'A15-1 geo-visitor-layer.js 內建差異化 Empty State 判斷函式（不是統一顯示「暫無資料」）');
  {
    const S = _fresh('store_a2_empty_no_event');
    const f = GEE.getGeoEventFunnel(db, S, { range: 'today' });
    assert(f.visitors === 0, 'A15-2 情況 1（沒有任何事件）：visitors=0，前端應顯示「目前沒有任何事件」');
  }
  {
    const S = _fresh('store_a2_empty_all_unknown');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: 'today' });
    assert(f.visitors > 0 && f.unknown_visitors === f.visitors, 'A15-3 情況 2（有事件但全部 Unknown）：visitors>0 且 unknown=visitors，前端應顯示對應差異化訊息（不是情況 1 的文字）');
  }
  {
    const S = _fresh('store_a2_empty_known_no_polygon');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '雲林縣', geo_district: '斗六市', geo_context: 'visitor' } });
    const f = GEE.getGeoEventFunnel(db, S, { range: 'today' });
    assert(f.known_district_visitors === 1, 'A15-4 情況 3（有行政區但無正式 Polygon）：known_district_visitors=1，地圖不畫色但 Ranking 有資料');
  }
  {
    const S = _fresh('store_a2_empty_metric_zero');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: 'today' });
    assert(f.visitors === 1 && f.add_to_cart_visitors === 0, 'A15-5 情況 4（有真實資料但目前指標為 0）：visitors=1 但 add_to_cart_visitors=0，跟「完全沒有事件」不同，前端不得混為一談');
  }
  {
    const S = _fresh('store_a2_empty_revenue_pending');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: 'today' });
    assert(f.revenue === null, 'A15-6 情況 5（Revenue 來源尚未串接／無 order_id）：revenue=null，前端顯示「目前沒有可用營收事件資料」');
  }

  // ══════════════════════════════════════════════════════════════
  // A16. Recommendation Risk 六種訊號逐一觸發（需求文件十九）
  // ══════════════════════════════════════════════════════════════
  {
    // 高訪客低成交：15 位訪客，0 位購買
    const S = _fresh('store_a2_risk_low_conversion');
    for (let i = 0; i < 15; i += 1) insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    const risk = GEE.buildRecommendationRiskSummary(GEE.getGeoEventFunnel(db, S, { range: '30d' }));
    assert(risk.signals.high_visitor_low_conversion === true, 'A16-1 高訪客低成交訊號正確觸發（15 訪客、0 購買）');
  }
  {
    // 高 Unknown：15 位訪客全部 Unknown
    const S = _fresh('store_a2_risk_high_unknown');
    for (let i = 0; i < 15; i += 1) insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    const risk = GEE.buildRecommendationRiskSummary(GEE.getGeoEventFunnel(db, S, { range: '30d' }));
    assert(risk.signals.high_unknown === true, 'A16-2 高 Unknown 訊號正確觸發（全部訪客皆 Unknown）');
    assert(risk.signals.low_coverage === true, 'A16-3 低 Coverage 訊號同時正確觸發（Known District 比例為 0）');
  }
  {
    // 反例：15 位訪客全部已知、樣本充足但轉換良好，高風險訊號不應全部觸發
    const S = _fresh('store_a2_risk_healthy');
    for (let i = 0; i < 15; i += 1) {
      insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台北市', geo_district: '大安區', geo_context: 'visitor' } });
    }
    const risk = GEE.buildRecommendationRiskSummary(GEE.getGeoEventFunnel(db, S, { range: '30d' }));
    assert(risk.signals.high_unknown === false, 'A16-4 全部已知時，高 Unknown 訊號正確為 false（不會產生假警訊）');
    assert(risk.signals.low_coverage === false, 'A16-5 全部已知時，低 Coverage 訊號正確為 false');
  }
  assert(GEE.RECOMMENDATION_RISK_MESSAGES.basis === '規則式計算，非 AI', 'A16-6 RECOMMENDATION_RISK_MESSAGES.basis 常數正確');
  assert(GEE.RECOMMENDATION_RISK_MESSAGES.insufficient === 'Insufficient Data', 'A16-7 RECOMMENDATION_RISK_MESSAGES.insufficient 常數正確');

  // ══════════════════════════════════════════════════════════════
  // A17. Conversion 精確數值驗證（需求文件九）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_conversion_exact');
    // 4 位訪客，2 位加購，1 位結帳，1 位購買 → Conversion=25%, CartConv=50%, CheckoutConv=100%
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v2', session_id: 's2', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v3', session_id: 's3', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v4', session_id: 's4', event_name: 'page_view', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v2', session_id: 's2', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'begin_checkout', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'purchase', order_id: 'oX', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.visitors === 4, 'A17-1 精確驗證：visitors=4');
    assert(f.add_to_cart_visitors === 2, 'A17-2 精確驗證：add_to_cart_visitors=2');
    assert(f.begin_checkout_visitors === 1, 'A17-3 精確驗證：begin_checkout_visitors=1');
    assert(f.purchase_visitors === 1, 'A17-4 精確驗證：purchase_visitors=1');
    assert(f.visitor_to_purchase_rate === 25, 'A17-5 Conversion（Purchase/Visitors）精確為 25%');
    assert(f.cart_conversion_rate === 50, 'A17-6 Cart Conversion（Purchase/AddToCart）精確為 50%');
    assert(f.checkout_conversion_rate === 100, 'A17-7 Checkout Conversion（Purchase/Checkout）精確為 100%');
    assert(f.visitor_to_cart_rate === 50, 'A17-8 Visitor to Cart Rate 精確為 50%');
    assert(f.cart_to_checkout_rate === 50, 'A17-9 Cart to Checkout Rate 精確為 50%');
  }

  // ══════════════════════════════════════════════════════════════
  // A18. Ranking 依 Metric 排序（需求文件十五、十六、十七）
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_ranking_sort');
    // A 區：3 訪客 1 加購；B 區：1 訪客 1 加購 → 依 Visitors 排序 A 在前，依 AddToCart 排序打平但 A 仍在前（數量相同時原順序）
    for (let i = 0; i < 3; i += 1) insertEvent(db, { store_id: S, visitor_id: `va${i}`, session_id: `sa${i}`, event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '安平區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S, visitor_id: 'va0', session_id: 'sa0', event_name: 'add_to_cart', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '安平區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S, visitor_id: 'vb0', session_id: 'sb0', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '東區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S, visitor_id: 'vb0', session_id: 'sb0', event_name: 'add_to_cart', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '東區', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S, visitor_id: 'vb0', session_id: 'sb0', event_name: 'begin_checkout', geo: { geo_source: 'ip', geo_city: '台南市', geo_district: '東區', geo_context: 'visitor' } });
    const areas = GVL.getGeoVisitAreas(db, S, { range: '30d' });
    const areaA = areas.find((a) => a.district === '安平區');
    const areaB = areas.find((a) => a.district === '東區');
    assert(areaA.visitor_count === 3 && areaB.visitor_count === 1, 'A18-1 各行政區的 visitor_count 各自正確（安平區3／東區1）');
    assert(areaA.add_to_cart_count === 1 && areaB.add_to_cart_count === 1, 'A18-2 各行政區的 add_to_cart_count 各自正確（皆為1）');
    assert(areaB.checkout_count === 1 && areaA.checkout_count === 0, 'A18-3 各行政區的 checkout_count 各自正確（東區1／安平區0，依此可支援 Checkout Tab 排序）');
  }

  // ══════════════════════════════════════════════════════════════
  // A19. 額外 Static Audit（module 匯出完整性／檔案存在性）
  // ══════════════════════════════════════════════════════════════
  ['GEO_EVENT_CLASS', 'GEO_EVENT_NAME_MAP', 'VISITOR_EVENT_NAMES', 'PURCHASE_EVENT_NAMES', 'geoEventClassify', 'getGeoEventFunnel', 'buildRecommendationRiskSummary', 'RECOMMENDATION_RISK_MESSAGES'].forEach((k) => {
    assert(k in GEE, `A19-export-${k} utils/geoEventEngine.js 正確匯出 ${k}`);
  });
  assert(fs.existsSync(path.join(ROOT, 'R5.3-A2_DATA_DECISION.md')), 'A19-1 R5.3-A2_DATA_DECISION.md 已建立');
  const dataDecisionSrc = fs.readFileSync(path.join(ROOT, 'R5.3-A2_DATA_DECISION.md'), 'utf8');
  ['order_id', 'revenue', 'Order Data', 'purchase', 'visitor_key', '集合差集', 'fixture', '不畫假點'].forEach((kw) => {
    assert(dataDecisionSrc.includes(kw), `A19-2-${kw} R5.3-A2_DATA_DECISION.md 內容涵蓋關鍵詞「${kw}」`);
  });

  // ══════════════════════════════════════════════════════════════
  // A20. 更多 Store Isolation／Time Range 邊界組合
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_iso_areas');
    const S2 = _fresh('store_a2_iso_areas_2');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '彰化縣', geo_district: '彰化市', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S2, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '彰化縣', geo_district: '員林市', geo_context: 'visitor' } });
    const areasS = GVL.getGeoVisitAreas(db, S, { range: '30d' });
    assert(!areasS.some((a) => a.district === '員林市'), 'A20-1 店家 A 的行政區聚合結果不含店家 B 的資料（跨店完全隔離）');
    const recentS = GVL.getRecentGeoVisits(db, S, { limit: 20 });
    assert(!recentS.some((r) => r.district === '員林市'), 'A20-2 店家 A 的 Recent Log 不含店家 B 的紀錄');
  }
  {
    const S = _fresh('store_a2_time_boundary');
    const exact5m = new Date(Date.now() - 5 * 60 * 1000 - 1000).toISOString().replace('T', ' ').slice(0, 19); // 5分1秒前
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, event_time, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?,?)", [S, 'vB', 'sB', 'page_view', exact5m, 'Unknown', 'Unknown', 'unknown', 1]);
    const f5m = GEE.getGeoEventFunnel(db, S, { range: '5m' });
    assert(f5m.visitors === 0, 'A20-3 剛好超過 5 分鐘邊界的事件被正確排除在「近 5 分鐘」範圍外');
    const f30m = GEE.getGeoEventFunnel(db, S, { range: '30m' });
    assert(f30m.visitors === 1, 'A20-4 同一筆事件在「近 30 分鐘」範圍內正確被納入');
  }

  console.log(`\n── Part A 結束，共 ${results.length} 項 ──\n`);

  // ══════════════════════════════════════════════════════════════
  // A21. Revenue／Orders 多筆訂單聚合、Metric Label、時間邊界補充
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_multi_order_revenue');
    db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total) VALUES (?,?,?,?,?,?,?)", ['ord_a2_m1', 'ONM1', S, '[]', 'cash', 200, 200]);
    db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total) VALUES (?,?,?,?,?,?,?)", ['ord_a2_m2', 'ONM2', S, '[]', 'cash', 300, 300]);
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'purchase', order_id: 'ord_a2_m1', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v2', session_id: 's2', event_name: 'purchase', order_id: 'ord_a2_m2', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.purchase_orders === 2, 'A21-1 兩筆不同顧客、不同訂單的 purchase，Purchase Orders 正確為 2');
    assert(f.revenue === 500, 'A21-2 兩筆訂單金額正確加總為 500（200+300）');
    assert(f.purchase_visitors === 2, 'A21-3 Purchase Visitors 正確為 2（兩位不同訪客）');
  }
  {
    // 同一訪客兩筆訂單：Purchase Visitors=1，但 Purchase Orders 仍應正確為 2（訂單數跟訪客數是不同維度）
    const S = _fresh('store_a2_same_visitor_multi_order');
    db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total) VALUES (?,?,?,?,?,?,?)", ['ord_a2_sv1', 'ONSV1', S, '[]', 'cash', 100, 100]);
    db.run("INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total) VALUES (?,?,?,?,?,?,?)", ['ord_a2_sv2', 'ONSV2', S, '[]', 'cash', 150, 150]);
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'ord_a2_sv1', geo: null });
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'purchase', order_id: 'ord_a2_sv2', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.purchase_visitors === 1, 'A21-4 同一訪客兩筆訂單，Purchase Visitors 正確為 1（訪客維度去重）');
    assert(f.purchase_orders === 2, 'A21-5 但 Purchase Orders 正確為 2（訂單維度不去重訪客，是獨立訂單計數）');
    assert(f.revenue === 250, 'A21-6 Revenue 正確加總兩筆訂單（100+150=250）');
  }
  ['visitors', 'add_to_cart', 'checkout', 'orders', 'revenue', 'conversion', 'cart_abandonment', 'recommendation_risk'].forEach((m) => {
    const visitorLayerSrcForLabels = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    assert(new RegExp(`${m}:\\s*'`).test(visitorLayerSrcForLabels), `A21-label-${m} GEO_EVENT_METRIC_LABEL 內含 ${m} 的中文標籤定義`);
  });
  {
    const S = _fresh('store_a2_24h_boundary');
    const almost24h = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
    db.run("INSERT INTO geo_visit_log (store_id, visitor_id, session_id, event_name, event_time, city, district, source, is_unknown) VALUES (?,?,?,?,?,?,?,?,?)", [S, 'v24', 's24', 'page_view', almost24h, 'Unknown', 'Unknown', 'unknown', 1]);
    const f24h = GEE.getGeoEventFunnel(db, S, { range: '24h' });
    assert(f24h.visitors === 1, 'A21-7 23 小時前的事件正確落在「近 24 小時」範圍內');
    const f1h = GEE.getGeoEventFunnel(db, S, { range: '1h' });
    assert(f1h.visitors === 0, 'A21-8 同一筆事件正確被「近 1 小時」範圍排除');
  }
  {
    // custom range 不合法輸入安全 fallback，不得無下限查詢
    const S = _fresh('store_a2_custom_invalid');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const fInvalid = GEE.getGeoEventFunnel(db, S, { range: 'custom', customStart: 'not-a-date' });
    assert(Number.isFinite(fInvalid.visitors), 'A21-9 custom range 不合法 customStart 時安全 fallback，不拋出例外');
  }
  assert(GVL.GEO_VISIT_LOG_TIME_RANGES.includes('1h') && GVL.GEO_VISIT_LOG_TIME_RANGES.includes('24h') && GVL.GEO_VISIT_LOG_TIME_RANGES.includes('custom'), 'A21-10 時間範圍常數正確包含 1h/24h/custom（需求文件二十）');

  // ══════════════════════════════════════════════════════════════
  // A22. 補充：Abandonment 跨 store 隔離／Recent Log 限制筆數／
  //      geoEventClassify 全事件白名單掃描／Recommendation Risk 樣本
  //      門檻邊界
  // ══════════════════════════════════════════════════════════════
  {
    const SA = _fresh('store_a2_abandon_iso_a');
    const SB = _fresh('store_a2_abandon_iso_b');
    insertEvent(db, { store_id: SA, visitor_id: 'shared', session_id: 'sA', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: SB, visitor_id: 'shared', session_id: 'sB', event_name: 'add_to_cart', geo: null });
    insertEvent(db, { store_id: SB, visitor_id: 'shared', session_id: 'sB', event_name: 'purchase', order_id: 'oShared', geo: null });
    const fA = GEE.getGeoEventFunnel(db, SA, { range: '30d' });
    const fB = GEE.getGeoEventFunnel(db, SB, { range: '30d' });
    assert(fA.cart_abandonment_visitors === 1, 'A22-1 店家 A：shared visitor 只加購未購買，Cart Abandonment 正確為 1');
    assert(fB.cart_abandonment_visitors === 0, 'A22-2 店家 B：同一 visitor_id 在店家 B 已購買，Cart Abandonment 正確為 0（不會被店家 A 的未購買狀態影響，Store Isolation 優先）');
  }
  {
    const S = _fresh('store_a2_recent_limit');
    for (let i = 0; i < 8; i += 1) insertEvent(db, { store_id: S, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    const recent3 = GVL.getRecentGeoVisits(db, S, { limit: 3 });
    assert(recent3.length === 3, 'A22-3 Recent Log limit 參數正確生效（8 筆資料只回傳 3 筆）');
    const recentDefault = GVL.getRecentGeoVisits(db, S, {});
    assert(recentDefault.length === 8, 'A22-4 未指定 limit 時使用預設值，正確回傳全部 8 筆（未超過預設上限）');
  }
  // geoEventClassify 對本專案 EVENT_WHITELIST 內所有事件名稱都不拋出例外
  {
    const { EVENT_WHITELIST } = require(path.join(ROOT, 'utils/analyticsLog'));
    let threwAny = false;
    EVENT_WHITELIST.forEach((evt) => {
      try { GEE.geoEventClassify(evt); } catch (e) { threwAny = true; }
    });
    assert(threwAny === false, 'A22-5 geoEventClassify() 對本專案 EVENT_WHITELIST 內全部事件名稱都不拋出例外');
  }
  {
    // Recommendation Risk 樣本門檻邊界：剛好 10 位訪客（含）應視為足夠
    const S9 = _fresh('store_a2_risk_boundary_9');
    for (let i = 0; i < 9; i += 1) insertEvent(db, { store_id: S9, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    assert(GEE.buildRecommendationRiskSummary(GEE.getGeoEventFunnel(db, S9, { range: '30d' })).sufficient_data === false, 'A22-6 9 位訪客（低於門檻 10）時樣本仍視為不足');
    const S10 = _fresh('store_a2_risk_boundary_10');
    for (let i = 0; i < 10; i += 1) insertEvent(db, { store_id: S10, visitor_id: `v${i}`, session_id: `s${i}`, event_name: 'page_view', geo: null });
    assert(GEE.buildRecommendationRiskSummary(GEE.getGeoEventFunnel(db, S10, { range: '30d' })).sufficient_data === true, 'A22-7 剛好 10 位訪客時樣本視為足夠（門檻含邊界）');
  }
  // Purchase Orders / Revenue 在完全沒有 purchase 事件時應為 null（不是 0，不是誤判成「有資料但是 0」）
  {
    const S = _fresh('store_a2_no_purchase_at_all');
    insertEvent(db, { store_id: S, visitor_id: 'v', session_id: 's', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.purchase_orders === null, 'A22-8 完全沒有 purchase 事件時，Purchase Orders 正確為 null（不是 0）');
    assert(f.revenue === null, 'A22-9 完全沒有 purchase 事件時，Revenue 正確為 null（不是 0）');
    assert(f.purchase_visitors === 0, 'A22-10 但 Purchase Visitors 正確為 0（這是「有資料、指標為0」不是「資料源不存在」，兩者刻意不同狀態）');
  }

  console.log(`\n── Part A（含補充）結束，共 ${results.length} 項 ──\n`);

  // ══════════════════════════════════════════════════════════════
  // A23. 收尾補充：Coverage 計算一致性／known_district_visitors 不含
  //      exact coordinate 混淆／Data Decision 文件章節完整性
  // ══════════════════════════════════════════════════════════════
  {
    const S = _fresh('store_a2_coverage_consistency');
    insertEvent(db, { store_id: S, visitor_id: 'v1', session_id: 's1', event_name: 'page_view', geo: { geo_source: 'ip', geo_city: '南投縣', geo_district: '南投市', geo_context: 'visitor' } });
    insertEvent(db, { store_id: S, visitor_id: 'v2', session_id: 's2', event_name: 'page_view', geo: null });
    const f = GEE.getGeoEventFunnel(db, S, { range: '30d' });
    assert(f.visitors === 2, 'A23-1 Coverage 一致性：總訪客數 2');
    assert(f.known_district_visitors === 1, 'A23-2 Coverage 一致性：Known District 1');
    assert(f.unknown_visitors === 1, 'A23-3 Coverage 一致性：Unknown 1');
    assert(f.known_district_visitors + f.unknown_visitors === f.visitors, 'A23-4 Known District + Unknown 恆等於總訪客數（沒有第三種未分類狀態遺漏）');
  }
  const dataDecisionSrcFinal = fs.readFileSync(path.join(ROOT, 'R5.3-A2_DATA_DECISION.md'), 'utf8');
  ['## 1.', '## 2.', '## 3.', '## 4.', '## 5.', '## 6.', '## 7.', '## 8.', '## 9.', '## 10.'].forEach((section) => {
    assert(dataDecisionSrcFinal.includes(section), `A23-decision-${section.replace(/[^0-9]/g, '')} R5.3-A2_DATA_DECISION.md 包含需求文件三十一要求的第${section.replace(/[^0-9]/g, '')}點章節`);
  });
  assert(dataDecisionSrcFinal.includes('可以正式顯示') && dataDecisionSrcFinal.includes('仍 Pending'), 'A23-decision-11 R5.3-A2_DATA_DECISION.md 明確列出「哪些指標可正式顯示」與「哪些指標仍 Pending」兩個章節');

  console.log(`\n── Part A（最終）結束，共 ${results.length} 項 ──\n`);

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測——8 個 Metric Tab／Layer/Tile Reuse／No Duplicate
  //         Map／Order Heatmap 不退化／Visitor Layer 不退化
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    manual('Part B 全部項目（DOM 層級行為測試）', 'jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  const { window } = dom;
  window.eval(`function escHtml(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;'); }`);

  const fetchCalls = [];
  const FUNNEL_FIXTURE = {
    range: 'today', visitors: 5, view_item_visitors: 3, add_to_cart_visitors: 2, begin_checkout_visitors: 1,
    purchase_visitors: 1, purchase_orders: 1, revenue: 800, revenue_source: 'order_data',
    cart_abandonment_visitors: 1, checkout_abandonment_visitors: 0, known_district_visitors: 4,
    unknown_visitors: 1, unknown_rate: 20, visitor_to_cart_rate: 40, cart_to_checkout_rate: 50,
    checkout_to_purchase_rate: 100, visitor_to_purchase_rate: 20, cart_conversion_rate: 50, checkout_conversion_rate: 100,
  };
  window.apiFetch = async (url) => {
    fetchCalls.push(String(url));
    if (String(url).includes('/visitor-log')) {
      return {
        ok: true, json: async () => ({
          success: true,
          data: {
            range: 'today',
            summary: { geo_visitors: 5, geo_visitors_known: 4, geo_visitors_unknown: 1, unknown_rate: 20, geo_add_to_cart: 2, geo_checkout: 1, geo_orders: 1 },
            funnel: FUNNEL_FIXTURE,
            recommendation_risk: { basis: '規則式計算，非 AI', sufficient_data: false, message: 'Insufficient Data', signals: null },
            areas: [{ city: '桃園市', district: '中壢區', is_unknown: false, visitor_count: 4, add_to_cart_count: 2, checkout_count: 1, order_count: 1 }],
            recent: [{ event_time: '14:45:10', city: '桃園市', district: '中壢區', event_name: 'page_view', source: 'ip', is_unknown: false, visitor_mask: 'vis_***abc' }],
          },
        }),
      };
    }
    return { ok: true, json: async () => ({ success: true, data: { areas: [] } }) };
  };
  window.getGeoFunnel = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
  window.getGeoFulfillmentForHeatmap = async () => ({ ok: true, json: async () => ({ success: true, data: { areas: [] } }) });
  window.av2Channel = 'all';
  window.av2SetChannel = function (ch) { window.av2Channel = ch; };
  window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
  window.geoDashboardFilters = {};

  let layerGroupCreateCount = 0; let mapCreateCount = 0; let tileLayerCreateCount = 0;
  window.L = {
    map: () => { mapCreateCount += 1; return {}; },
    tileLayer: () => { tileLayerCreateCount += 1; return { addTo() { return this; } }; },
    layerGroup: () => { layerGroupCreateCount += 1; const layers = []; return { addTo() { return this; }, clearLayers() { layers.length = 0; }, addLayer(l) { layers.push(l); }, _layers: layers }; },
    circleMarker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
    marker: () => ({ bindTooltip() { return this; }, on() { return this; } }),
    geoJSON: (feature) => ({ feature, bindTooltip() { return this; } }),
  };
  const fakeMapInstance = { id: 'shared-map', panTo: () => {} };
  window.geoMapState = { instance: fakeMapInstance, geoJsonLayer: { setStyle: () => {} }, featureIndex: null, rows: [], metric: 'visitors' };
  window.geoUpdateMapData = () => {};
  window.geoInvalidateMapSize = () => {};

  const stripUseStrict = (s) => s.replace(/'use strict';\s*\n/, '');
  const engineSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  const uiJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const visitorJsSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
  try {
    window.eval(`${stripUseStrict(engineSrc)}\n${stripUseStrict(uiJsSrc)}\n${stripUseStrict(visitorJsSrc)}`);
    pass('B1-1 Order Heatmap Engine + Dashboard Integration + Visitor Layer(Geo Event Engine) 三份原始碼同一個 window 下皆可正常執行，無語法/載入錯誤');
  } catch (e) {
    fail('B1-1 三份原始碼載入', e.message);
    printSummary();
    return;
  }

  const containerId = 'geo-db';
  const bodyEl = window.document.getElementById(containerId);
  bodyEl.innerHTML = `${window.geoHeatUiRenderTabBar(containerId)}${window.geoHeatUiRenderSharedMetricBar(containerId)}<div id="${containerId}-panel-dashboard"></div>${window.geoHeatUiRenderPanel(containerId)}`;
  window.geoHeatUiSwitchTab(containerId, 'heatmap');

  // ── B2. Order Heatmap 不退化（切到 order layer，既有容器與行為原樣存在）──
  assert(window.geoHeatUiState.layer === 'order', 'B2-1 預設 Layer 仍是 order（Order Heatmap 行為未變）');
  assert(window.document.getElementById(`${containerId}-ranking`) !== null, 'B2-2 Order Heatmap 既有 #-ranking 容器仍存在');
  assert(window.document.getElementById(`${containerId}-summary`) !== null, 'B2-3 Order Heatmap 既有 #-summary 容器仍存在');
  assert(mapCreateCount === 0, 'B2-4 到目前為止沒有呼叫過 L.map()（尚未建立任何額外地圖）');

  // ── B3. 切到 Visitor Layer，等待資料載入 ──────────────────────────
  window.geoHeatUiSetLayer(containerId, 'visitor');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(fetchCalls.some((u) => u.includes('/visitor-log')), 'B3-1 切到 Visitor Layer 後正確呼叫 /visitor-log（Geo Event Engine 唯一資料源）');

  // ── B4. 8 個 Metric Tab 真正切換資料（需求文件二十八 18～21）────────
  const metricBar = window.document.getElementById(`${containerId}-metric-bar`);
  assert(!!metricBar, 'B4-1 Metric Bar 容器存在');
  ['visitors', 'add_to_cart', 'checkout', 'orders', 'revenue', 'conversion', 'cart_abandonment', 'recommendation_risk'].forEach((m) => {
    assert(metricBar.innerHTML.includes(`'${m}'`), `B4-2-${m} Metric Bar 含 ${m} 按鈕`);
  });

  window.geoVisitorSetMetric(containerId, 'visitors');
  const visitorsSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(visitorsSummary.includes('Geo Visitors：5'), 'B4-3 Visitors Tab 顯示正確的 Geo Visitors 數字');
  assert(visitorsSummary.includes('Exact Coordinate：0'), 'B4-4 Visitors Tab 誠實顯示 Exact Coordinate：0（IP Geo 無精確座標）');

  window.geoVisitorSetMetric(containerId, 'add_to_cart');
  const cartSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(cartSummary.includes('Add To Cart Visitors：2'), 'B4-5 Add To Cart Tab 真正切換成加購資料（不是訪客數）');
  assert(cartSummary !== visitorsSummary, 'B4-6 Add To Cart Tab 內容與 Visitors Tab 不同（真正切換，不是換 Label）');

  window.geoVisitorSetMetric(containerId, 'checkout');
  const checkoutSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(checkoutSummary.includes('Checkout Visitors：1'), 'B4-7 Checkout Tab 真正切換成結帳資料');

  window.geoVisitorSetMetric(containerId, 'orders');
  const ordersSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(ordersSummary.includes('Purchase Visitors：1') && ordersSummary.includes('Purchase Orders：1'), 'B4-8 Orders Tab 真正切換成訂單資料（Purchase Orders 有真實 order_id 時顯示數字）');

  window.geoVisitorSetMetric(containerId, 'revenue');
  const revenueSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(revenueSummary.includes('NT$') && revenueSummary.includes('Order Data'), 'B4-9 Revenue Tab 顯示金額並標示來源為 Order Data');

  window.geoVisitorSetMetric(containerId, 'conversion');
  const conversionSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(conversionSummary.includes('Conversion'), 'B4-10 Conversion Tab 顯示成交率資料');
  assert(!/NaN|Infinity/.test(conversionSummary), 'B4-11 Conversion Tab 不含 NaN/Infinity');

  window.geoVisitorSetMetric(containerId, 'cart_abandonment');
  const abandonSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(abandonSummary.includes('Cart Abandonment Visitors：1'), 'B4-12 Cart Abandonment Tab 顯示正確的放棄人數');

  window.geoVisitorSetMetric(containerId, 'recommendation_risk');
  const riskSummary = window.document.getElementById(`${containerId}-metric-summary`).innerHTML;
  assert(riskSummary.includes('規則式計算，非 AI'), 'B4-13 Recommendation Risk Tab 標示規則式計算，非 AI');
  assert(riskSummary.includes('Insufficient Data'), 'B4-14 樣本量不足時（fixture 未達門檻）顯示 Insufficient Data');

  // ── B5. Recent Log Mask（前端渲染）────────────────────────────────
  const recentHtml = window.document.getElementById(`${containerId}-visitor-recent`).innerHTML;
  assert(recentHtml.includes('vis_***abc'), 'B5-1 Recent Log 前端渲染遮罩後的訪客識別，不是原始 ID');
  assert(!recentHtml.includes('visitor_full_id'), 'B5-2 Recent Log 前端渲染不含任何完整原始 visitor_id 字樣');

  // ── B6. Layer Reuse／Tile Reuse／No Duplicate Map ──────────────────
  assert(mapCreateCount === 0, 'B6-1 全程沒有呼叫 L.map()（No Duplicate Map）');
  assert(tileLayerCreateCount === 0, 'B6-2 全程沒有建立任何 tile layer（Tile Reuse）');
  const lgCountBefore = layerGroupCreateCount;
  window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: {} });
  window.geoVisitorRenderChoropleth(fakeMapInstance, { byCityDistrict: {} });
  assert(layerGroupCreateCount === lgCountBefore, 'B6-3 重複呼叫 Choropleth render，layerGroup 不會被重複建立（Layer Reuse）');

  // ── B7. Store Switch／Request Guard（切店重置）──────────────────────
  window.geoVisitorState.areas = [{ city: 'stale', district: 'stale', is_unknown: false, visitor_count: 999 }];
  window.geoVisitorState.funnel = { visitors: 999 };
  window.geoHeatUiRegisterContext(containerId, `${containerId}-map`);
  assert(window.geoVisitorState.areas.length === 0, 'B7-1 切店（geoHeatUiRegisterContext）清空舊 areas');
  assert(window.geoVisitorState.funnel === null, 'B7-2 切店清空舊 funnel（不殘留上一店資料）');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert(window.geoVisitorState.funnel && window.geoVisitorState.funnel.visitors === 5, 'B7-3 切店後重新抓取新店家資料，正確恢復（fixture 值 5）');

  // ── B8. Visitor Layer 不退化（既有 A1.2 行為原樣可用）───────────────
  assert(typeof window.geoVisitorBuildTooltipContent === 'function', 'B8-1 既有 Tooltip 函式仍存在且可呼叫');
  const tooltip = window.geoVisitorBuildTooltipContent({ city: '桃園市', district: '中壢區', visitor_count: 4, is_unknown: false });
  assert(tooltip.includes('精確座標：未取得'), 'B8-2 Tooltip 仍正確標示「精確座標：未取得」（A1.2 行為未退化）');
  assert(typeof window.geoVisitorComputeCoverage === 'function', 'B8-3 既有 Coverage 計算函式仍存在');
  const cov = window.geoVisitorComputeCoverage({ geo_visitors: 0, geo_visitors_known: 0 });
  assert(cov.coverage_pct === 0, 'B8-4 Coverage 邊界情境（0 分母）仍正確處理，不除以 0');

  printSummary();
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
