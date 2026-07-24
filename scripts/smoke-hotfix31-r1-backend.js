#!/usr/bin/env node
// scripts/smoke-hotfix31-r1-backend.js — fix18-10-hotfix31-R1 smoke test
//
// 涵蓋範圍（Backend Foundation：DB schema + Drill Down / Visitor 360 / CRM 讀寫 API）：
//   R1-1 ~ R1-6  ：DB schema 稽核（4 張新表 + 索引皆存在，且沒有破壞既有欄位）
//   R1-7 ~ R1-14 ：utils/drilldown.js（依 source/event_name/order_mode 篩選、
//                  已購買是否納入、store_id 隔離、visitor_count）
//   R1-15 ~ R1-19：utils/visitor360.js（LINE 會員 LTV、旅程分段、匿名訪客、
//                  跨裝置/登入後串接、查無資料回傳 null）
//   R1-20 ~ R1-27：routes/crm.js 分群/動作邏輯（直接呼叫路由 handler，模擬
//                  req/res，不需要啟動真正的 HTTP server）
//
// 做法同既有慣例：直接呼叫真實程式碼（utils/drilldown.js、utils/visitor360.js、
// routes/crm.js），搭配 utils/db.js 的 sql.js 檔案資料庫寫入測試資料，不是另外
// 重寫一份簡化邏輯。

'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ── 模擬 Express req/res，直接呼叫 router 內的 handler（不需要啟動 HTTP server）──
function findLayer(router, method, routePath) {
  return router.stack.find(
    (l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]
  );
}
async function callRoute(router, method, routePath, { params = {}, query = {}, body = {}, storeId } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params, query, body, storeId };
  let statusCode = 200;
  let jsonBody = null;
  const res = {
    status(code) { statusCode = code; return this; },
    json(obj) { jsonBody = obj; return this; },
  };
  await handler(req, res);
  return { statusCode, body: jsonBody };
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const { sanitizeCartSnapshotMetadata } = require('../utils/cartSnapshot');
  const { getDrilldownRows, resolveMemberKeys } = require('../utils/drilldown');
  const { getVisitorProfile } = require('../utils/visitor360');
  const crmRouter = require('../routes/crm');

  function ensureProduct(storeId, id, name, price) {
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`,
      [id, storeId, name, '測試', price]);
  }
  function addToCart(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'add_to_cart', product_id: opts.product_id, quantity: opts.qty || 1,
      order_mode: opts.order_mode || 'takeout', source: opts.source || null, campaign: opts.campaign || null,
      line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function cartUpdated(storeId, opts) {
    const meta = sanitizeCartSnapshotMetadata('cart_updated', opts.metadata);
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'cart_updated', order_mode: opts.order_mode || 'takeout',
      source: opts.source || null, campaign: opts.campaign || null,
      metadata: meta, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function purchase(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, order_id: opts.order_id, event_name: 'purchase',
      order_mode: opts.order_mode || 'takeout', source: opts.source || null,
      line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function beginCheckout(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'begin_checkout', order_mode: opts.order_mode || 'takeout',
      source: opts.source || null, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }

  // ════════════════════════════════════════════════════════════════
  // R1-1 ~ R1-6：DB Schema 稽核
  // ════════════════════════════════════════════════════════════════
  const NEW_TABLES = ['crm_segments', 'crm_segment_members', 'crm_actions', 'crm_action_targets'];
  NEW_TABLES.forEach((t) => {
    const info = db.all(`PRAGMA table_info(${t})`);
    assert(info.length > 0, `R1 Schema：${t} 資料表存在`, info.length ? '' : '找不到欄位');
  });
  {
    const idx = db.all(`PRAGMA index_list(crm_segment_members)`);
    assert(idx.some((i) => i.unique), 'R1 Schema：crm_segment_members 有 UNIQUE 索引（防重複成員）');
  }
  {
    const idx = db.all(`PRAGMA index_list(crm_action_targets)`);
    assert(idx.some((i) => i.unique), 'R1 Schema：crm_action_targets 有 UNIQUE 索引（防重複 target）');
  }
  {
    // 既有 analytics_events 欄位完全沒有被破壞（迴歸稽核）
    const cols = db.all(`PRAGMA table_info(analytics_events)`).map((c) => c.name);
    assert(cols.includes('cart_id') && cols.includes('identity_key') && cols.includes('source'),
      'R1 Regression：analytics_events 既有欄位未被破壞');
  }

  // ════════════════════════════════════════════════════════════════
  // R1-7 ~ R1-14：utils/drilldown.js
  // ════════════════════════════════════════════════════════════════
  const STORE_A = 'r31_store_a';
  const STORE_B = 'r31_store_b';
  ensureProduct(STORE_A, 8001, '古法麻油豬腰', 150);
  ensureProduct(STORE_A, 8002, '皇家三寶', 350);

  // 兩筆 Facebook 來源的購物車：一筆放棄、一筆後來成交
  addToCart(STORE_A, { cart_id: 'dd_cart_1', visitor_id: 'dd_v1', product_id: 8001, source: 'Facebook', campaign: '母親節檔期' });
  cartUpdated(STORE_A, {
    cart_id: 'dd_cart_1', visitor_id: 'dd_v1', source: 'Facebook', campaign: '母親節檔期',
    metadata: { items: [{ product_id: 8001, name: '古法麻油豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, total: 150, order_mode: 'takeout', item_count: 1 },
  });

  addToCart(STORE_A, { cart_id: 'dd_cart_2', visitor_id: 'dd_v2', product_id: 8002, source: 'Facebook', campaign: '母親節檔期' });
  cartUpdated(STORE_A, {
    cart_id: 'dd_cart_2', visitor_id: 'dd_v2', source: 'Facebook', campaign: '母親節檔期',
    metadata: { items: [{ product_id: 8002, name: '皇家三寶', qty: 1, unit_price: 350, subtotal: 350 }], subtotal: 350, total: 350, order_mode: 'delivery', item_count: 1 },
  });
  beginCheckout(STORE_A, { cart_id: 'dd_cart_2', visitor_id: 'dd_v2', source: 'Facebook' });
  purchase(STORE_A, { cart_id: 'dd_cart_2', visitor_id: 'dd_v2', order_id: 'ord_dd_2', source: 'Facebook' });

  // 一筆 Google 來源，不應該出現在 Facebook 篩選結果
  addToCart(STORE_A, { cart_id: 'dd_cart_3', visitor_id: 'dd_v3', product_id: 8001, source: 'Google' });
  cartUpdated(STORE_A, {
    cart_id: 'dd_cart_3', visitor_id: 'dd_v3', source: 'Google',
    metadata: { items: [{ product_id: 8001, name: '古法麻油豬腰', qty: 1, unit_price: 150, subtotal: 150 }], subtotal: 150, total: 150, order_mode: 'takeout', item_count: 1 },
  });

  {
    const r = getDrilldownRows(db, STORE_A, { source: 'Facebook' }, { limit: 20 });
    assert(r.total === 2, 'R1-7：drilldown source=Facebook 找到 2 筆（含已購買）', `total=${r.total}`);
    assert(r.rows.some((x) => x.cart_id === 'dd_cart_1'), 'R1-8：drilldown 結果包含未成交的 Facebook 購物車');
    assert(r.rows.some((x) => x.cart_id === 'dd_cart_2' && x.status === 'purchased'), 'R1-9：drilldown 結果包含已成交的 Facebook 購物車，status=purchased');
    assert(!r.rows.some((x) => x.cart_id === 'dd_cart_3'), 'R1-10：drilldown source=Facebook 不包含 Google 來源的購物車');
  }
  {
    const r = getDrilldownRows(db, STORE_A, { source: 'Facebook' }, { include_purchased: false });
    assert(r.total === 1 && r.rows[0].cart_id === 'dd_cart_1', 'R1-11：include_purchased=false 排除已成交購物車', `total=${r.total}`);
  }
  {
    const r = getDrilldownRows(db, STORE_A, { event_name: 'begin_checkout' });
    assert(r.total === 1 && r.rows[0].cart_id === 'dd_cart_2', 'R1-12：drilldown event_name=begin_checkout 只找到有開始結帳的購物車');
  }
  {
    // Store isolation：STORE_B 完全沒有資料，篩選條件相同也不應該撈到 STORE_A 的資料
    const r = getDrilldownRows(db, STORE_B, { source: 'Facebook' });
    assert(r.total === 0, 'R1-13：drilldown store_id 隔離，STORE_B 查不到 STORE_A 的資料', `total=${r.total}`);
  }
  {
    const r = getDrilldownRows(db, STORE_A, { source: 'Facebook' });
    assert(typeof r.visitor_count === 'number' && r.visitor_count >= 2, 'R1-14：drilldown 回傳 visitor_count（不限有 cart_id 的事件）', `visitor_count=${r.visitor_count}`);
  }

  // ════════════════════════════════════════════════════════════════
  // R1-15 ~ R1-19：utils/visitor360.js
  // ════════════════════════════════════════════════════════════════
  db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, order_count, total_spent, first_order_at, last_order_at, first_seen_at, last_seen_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [STORE_A, 'U_visitor360_1', '測試會員小美', 1, 3, 1200, '2026-06-01 12:00:00', '2026-07-20 18:00:00', '2026-05-01 10:00:00', '2026-07-20 18:00:00']);
  db._save();

  addToCart(STORE_A, { cart_id: 'v360_cart_1', visitor_id: 'v360_visitor_a', session_id: 'v360_sess_1', product_id: 8001, source: 'Facebook', line_user_id: 'U_visitor360_1' });
  addToCart(STORE_A, { cart_id: 'v360_cart_2', visitor_id: 'v360_visitor_a', session_id: 'v360_sess_2', product_id: 8002, source: 'LINE推播', line_user_id: 'U_visitor360_1' });

  {
    const profile = getVisitorProfile(db, STORE_A, 'U_visitor360_1');
    assert(!!profile, 'R1-15：Visitor 360 找到已知 LINE 會員');
    assert(profile && profile.identity_type === 'line', 'R1-16：Visitor 360 識別為 LINE 會員身分');
    assert(profile && profile.ltv && profile.ltv.order_count === 3 && profile.ltv.total_spent === 1200, 'R1-17：Visitor 360 LTV 直接讀自 line_members（累積消費/訂單數）', profile ? JSON.stringify(profile.ltv) : 'null');
    assert(profile && profile.journey.length >= 2, 'R1-18：Visitor 360 旅程至少包含 2 次來訪（依 session 分段）', profile ? `visits=${profile.journey.length}` : 'null');
  }
  {
    // 匿名訪客（沒有 line_user_id），查無資料表示只有事件、沒有 LTV
    addToCart(STORE_A, { cart_id: 'anon_cart_1', visitor_id: 'v360_anon_1', product_id: 8001, source: 'Direct' });
    const profile = getVisitorProfile(db, STORE_A, 'v360_anon_1');
    assert(!!profile && profile.identity_type === 'visitor' && profile.ltv === null, 'R1-19：Visitor 360 匿名訪客沒有 LTV，仍能看到旅程', profile ? JSON.stringify({ identity_type: profile.identity_type, ltv: profile.ltv }) : 'null');
  }
  {
    const profile = getVisitorProfile(db, STORE_A, 'nonexistent_key_xyz');
    assert(profile === null, 'R1-19b：查無此人回傳 null（不是拋例外）');
  }

  // ════════════════════════════════════════════════════════════════
  // R1-20 ~ R1-27：routes/crm.js（分群 + 動作）
  // ════════════════════════════════════════════════════════════════
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', {
      storeId: STORE_A,
      body: { name: 'Facebook放棄名單', segment_type: 'dynamic', filter: { source: 'Facebook', include_purchased: false } },
    });
    assert(r.statusCode === 200 && r.body.success, 'R1-20：POST /segments 建立 dynamic 分群成功', JSON.stringify(r.body));
    global.__seg_dynamic_id = r.body.id;
  }
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', {
      storeId: STORE_A,
      body: { name: 'Facebook放棄名單(快照)', segment_type: 'static', filter: { source: 'Facebook' } },
    });
    assert(r.statusCode === 200 && r.body.success && r.body.member_count >= 2, 'R1-21：POST /segments 建立 static 分群並快照成員', JSON.stringify(r.body));
    global.__seg_static_id = r.body.id;
  }
  {
    const r = await callRoute(crmRouter, 'GET', '/segments', { storeId: STORE_A });
    assert(r.body.success && r.body.segments.length === 2, 'R1-22：GET /segments 列出剛建立的 2 個分群', `count=${r.body.segments.length}`);
  }
  {
    const r = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_A, params: { id: String(global.__seg_static_id) } });
    assert(r.body.success && r.body.members.length >= 2, 'R1-23：GET /segments/:id 回傳 static 分群的快照成員');
  }
  {
    // store 隔離：STORE_B 查不到 STORE_A 的分群
    const r = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_B, params: { id: String(global.__seg_static_id) } });
    assert(r.statusCode === 404, 'R1-24：CRM 分群 store_id 隔離，其他店家查不到');
  }
  {
    // 建立一張測試優惠券，驗證 coupon_grant 動作會真的檢查優惠券存在/啟用
    db.run(`INSERT INTO coupons (store_id, code, discount_type, discount_value, enabled) VALUES (?,?,?,?,1)`,
      [STORE_A, 'MOM50', 'fixed', 50]);
    db._save();
    const r = await callRoute(crmRouter, 'POST', '/actions', {
      storeId: STORE_A,
      body: { segment_id: global.__seg_static_id, action_type: 'coupon_grant', payload: { coupon_code: 'mom50' } },
    });
    // R2 硬化後：coupon_grant 是本機真的能完成的動作（見 utils/crmActions.js），
    // 但只有 LINE 會員符合資格，匿名訪客會被標記 skipped（不是失敗也不是完成）。
    assert(r.statusCode === 200 && r.body.success && r.body.status === 'completed' && r.body.success_count >= 1, 'R1-25：POST /actions coupon_grant 驗證優惠券存在，LINE 會員核發完成、匿名訪客被跳過', JSON.stringify(r.body));
  }
  {
    const r = await callRoute(crmRouter, 'POST', '/actions', {
      storeId: STORE_A,
      body: { segment_id: global.__seg_static_id, action_type: 'line_push', payload: { message: '您的購物車還在等您！' } },
    });
    assert(r.statusCode === 200 && r.body.status === 'not_configured', 'R1-26：POST /actions line_push 誠實回報尚未串接（not_configured），不假裝已送出', JSON.stringify(r.body));
  }
  {
    const r = await callRoute(crmRouter, 'POST', '/actions', {
      storeId: STORE_A,
      body: { segment_id: global.__seg_static_id, action_type: 'coupon_grant', payload: { coupon_code: 'NOTEXIST' } },
    });
    assert(r.statusCode === 400 && !r.body.success, 'R1-27：POST /actions coupon_grant 對不存在的優惠券回傳 400 錯誤（不假裝成功）');
  }

  // ── 統計 ──
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n合計：${results.length} 項，PASS ${results.length - failCount}，FAIL ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke-hotfix31-r1-backend] 未預期錯誤：', e);
  process.exit(1);
});
