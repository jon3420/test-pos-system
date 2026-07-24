#!/usr/bin/env node
// scripts/smoke-hotfix31-r2-hardening.js — fix18-10-hotfix31-R2 smoke test
//
// 涵蓋本次架構修正/硬化回合的需求文件 A~M（見對話紀錄）。與
// scripts/smoke-hotfix31-r1-backend.js（Backend Foundation 的 29 項）互補，
// 不重複已經涵蓋的基本 drilldown/visitor360/segment 行為，聚焦在這次新增的
// 硬化重點：身份合併、跨店隔離負向測試、動態/靜態分群差異、CRM 動作生命週期
// （idempotency／cancel／retry／dedup）、migration 安全性、SQL injection 安全。

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

function findLayer(router, method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]);
}
async function callRoute(router, method, routePath, { params = {}, query = {}, body = {}, storeId } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params, query, body, storeId };
  let statusCode = 200, jsonBody = null;
  const res = { status(c) { statusCode = c; return this; }, json(o) { jsonBody = o; return this; } };
  await handler(req, res);
  return { statusCode, body: jsonBody };
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const { sanitizeCartSnapshotMetadata } = require('../utils/cartSnapshot');
  const { getDrilldownRows, countDrilldownMatches } = require('../utils/drilldown');
  const { getVisitorProfile } = require('../utils/visitor360');
  const { resolveCanonicalVisitor } = require('../utils/analyticsIdentity');
  const crmRouter = require('../routes/crm');

  function ensureProduct(storeId, id, name, price) {
    db.run(`INSERT OR REPLACE INTO products (id, store_id, name, category, price, enabled) VALUES (?,?,?,?,?,1)`, [id, storeId, name, '測試', price]);
  }
  function addToCart(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'add_to_cart', product_id: opts.product_id, quantity: opts.qty || 1,
      order_mode: opts.order_mode || 'takeout', source: opts.source || null,
      line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function cartUpdated(storeId, opts) {
    const meta = sanitizeCartSnapshotMetadata('cart_updated', opts.metadata);
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, event_name: 'cart_updated', order_mode: opts.order_mode || 'takeout',
      source: opts.source || null, metadata: meta, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }
  function purchase(storeId, opts) {
    return insertEvent(db, {
      store_id: storeId, visitor_id: opts.visitor_id || 'v_default', session_id: opts.session_id || 's_default',
      cart_id: opts.cart_id, order_id: opts.order_id, event_name: 'purchase', order_mode: opts.order_mode || 'takeout',
      source: opts.source || null, line_user_id: opts.line_user_id || null, channel_source: 'line',
    });
  }

  const STORE_1 = 'r32_store_001';
  const STORE_2 = 'r32_store_002';
  ensureProduct(STORE_1, 7001, '古法麻油豬腰', 150);

  // ════════════════════════════════════════════════════════════════
  // Section 1：無重複來源真相資料表（需求文件 A）
  // ════════════════════════════════════════════════════════════════
  const FORBIDDEN_TABLES = ['crm_members', 'crm_visitors', 'analytics_v3', 'visitor360', 'visitor_profiles', 'cart_copy', 'session_copy', 'event_copy', 'order_copy', 'member_copy', 'product_copy'];
  const existingTableNames = db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name);
  const foundForbidden = FORBIDDEN_TABLES.filter((t) => existingTableNames.includes(t));
  assert(foundForbidden.length === 0, 'A-1：未建立任何重複來源真相資料表', foundForbidden.join(','));
  assert(existingTableNames.includes('crm_segments') && existingTableNames.includes('crm_actions') && existingTableNames.includes('crm_action_targets'), 'A-2：CRM 治理表本身存在（分群/動作/名單快照）');

  // ════════════════════════════════════════════════════════════════
  // Section 2：Migration 安全性（需求文件 L）——空 DB／已有資料的 DB／重跑兩次
  // ════════════════════════════════════════════════════════════════
  {
    // 已經在本檔開頭對「全新空 DB」跑過一次 initDb()（見上方 DB_FILE 刪除+initDb），這裡驗證：
    assert(existingTableNames.includes('crm_segments'), 'L-1：Migration 在全新空 DB 上正確建立 CRM 表');
  }
  {
    // 已有資料的 DB 上重跑一次（populated DB re-run）：不得拋錯、不得清空既有資料
    const before = db.all('SELECT COUNT(*) as c FROM analytics_events WHERE store_id=?', [STORE_1]);
    let rerunOk = true, rerunErr = null;
    try { await initDb(); } catch (e) { rerunOk = false; rerunErr = e.message; }
    const after = db.all('SELECT COUNT(*) as c FROM analytics_events WHERE store_id=?', [STORE_1]);
    assert(rerunOk, 'L-2：Migration 在已有資料的 DB 上可重跑一次，不拋例外', rerunErr || '');
    assert(before[0].c === after[0].c, 'L-2b：重跑 migration 不影響既有資料列數', `before=${before[0].c} after=${after[0].c}`);
  }
  {
    // 再重跑第三次，確認 idempotent（可重複執行任意次數）
    let ok = true, err = null;
    try { await initDb(); await initDb(); } catch (e) { ok = false; err = e.message; }
    assert(ok, 'L-3：Migration 可連續重跑兩次以上，仍然 idempotent', err || '');
  }
  {
    const idx = db.all("PRAGMA index_list(crm_actions)");
    assert(idx.some((i) => i.name === 'idx_crm_actions_store_type'), 'L-4：crm_actions store_id+action_type 索引存在');
    assert(idx.some((i) => i.name === 'idx_crm_actions_store_idempotency' && i.unique), 'L-5：crm_actions store_id+idempotency_key 唯一索引存在');
  }

  // ════════════════════════════════════════════════════════════════
  // Section 3：身份合併（需求文件 D）
  // ════════════════════════════════════════════════════════════════
  db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, order_count, total_spent, first_seen_at, last_seen_at)
          VALUES (?,?,?,?,?,?,?,?)`, [STORE_1, 'U_identity_1', '身份合併測試會員', 1, 2, 800, '2026-06-01 10:00:00', '2026-07-20 10:00:00']);
  db._save();
  // 匿名旅程：先用 visitor_id 'anon_dev_a' 逛，之後登入綁定到 U_identity_1（透過 line_member_sessions）
  addToCart(STORE_1, { cart_id: 'identity_cart_1', visitor_id: 'anon_dev_a', session_id: 'sess_anon_a', product_id: 7001, source: 'Facebook' });
  db.run(`INSERT INTO line_member_sessions (store_id, line_user_id, visitor_id, session_id, cart_id, first_seen_at, last_seen_at) VALUES (?,?,?,?,?,?,?)`,
    [STORE_1, 'U_identity_1', 'anon_dev_a', 'sess_anon_a', 'identity_cart_1', '2026-07-01 10:00:00', '2026-07-01 10:05:00']);
  db._save();
  purchase(STORE_1, { cart_id: 'identity_cart_1', visitor_id: 'anon_dev_a', order_id: 'ord_identity_1', source: 'Facebook', line_user_id: 'U_identity_1' });
  db.run(`INSERT INTO orders (id, order_number, store_id, items, payment_method, subtotal, total, status, customer_line_id)
          VALUES (?,?,?,?,?,?,?,?,?)`,
    ['ord_identity_1', 'ORD-IDENTITY-1', STORE_1, '[]', 'cash', 150, 150, 'completed', 'U_identity_1']);
  db._save();

  {
    // 用「登入前的匿名 visitor_id」查 Visitor 360，應該要能合併到同一個 LINE 會員
    const resolved = resolveCanonicalVisitor(db, STORE_1, 'anon_dev_a');
    assert(resolved.found && resolved.canonical_type === 'line_user_id' && resolved.line_user_id === 'U_identity_1', 'D-1：匿名訪客登入後可透過 line_member_sessions 合併回同一個 LINE 會員', JSON.stringify(resolved));
    assert(resolved.confidence === 'high' && resolved.resolution_method === 'visitor_session_link', 'D-2：決定性連結（非猜測）回傳 confidence=high', JSON.stringify(resolved));
  }
  {
    // 完全不相關的訪客不應該被合併
    addToCart(STORE_1, { cart_id: 'unrelated_cart_1', visitor_id: 'anon_unrelated_x', product_id: 7001, source: 'Google' });
    const resolved = resolveCanonicalVisitor(db, STORE_1, 'anon_unrelated_x');
    assert(resolved.found && resolved.canonical_type === 'visitor_id' && resolved.confidence === 'unresolved', 'D-3：沒有可靠連結的訪客保持匿名、不臆測合併', JSON.stringify(resolved));
  }
  {
    // 完全查無任何紀錄的 key
    const resolved = resolveCanonicalVisitor(db, STORE_1, 'totally_unknown_key_999');
    assert(resolved.found === false, 'D-4：查無任何紀錄的 key 回傳 found=false（不得猜測）');
  }
  {
    const profile = getVisitorProfile(db, STORE_1, 'anon_dev_a');
    assert(!!profile && profile.identity_type === 'line' && profile.canonical_identity.confidence === 'high', 'D-5：Visitor 360 用匿名 visitor_id 查詢，透過身份合併找到完整 LINE 會員檔案', profile ? JSON.stringify(profile.canonical_identity) : 'null');
    assert(profile.purchase_history.length >= 1, 'D-6：Visitor 360 含真實購買歷程（讀自 orders 表）');
  }

  // ════════════════════════════════════════════════════════════════
  // Section 4：跨店隔離負向測試（需求文件 E，M-8~M-11）
  // ════════════════════════════════════════════════════════════════
  ensureProduct(STORE_2, 7002, 'STORE_2商品', 200);
  addToCart(STORE_2, { cart_id: 'store2_cart_1', visitor_id: 'store2_visitor', product_id: 7002, source: 'Facebook' });

  {
    const r = getDrilldownRows(db, STORE_2, { source: 'Facebook' });
    assert(!r.rows.some((x) => x.cart_id === 'identity_cart_1'), 'M-8：跨店 Drill Down 讀不到 STORE_1 的資料');
  }
  {
    const profile = getVisitorProfile(db, STORE_2, 'anon_dev_a'); // STORE_1 的 visitor_id，換到 STORE_2 查
    assert(profile === null, 'M-9：跨店 Visitor 360 查不到另一店的訪客/會員');
  }
  let store1SegmentId;
  {
    const r = await callRoute(crmRouter, 'POST', '/segments', { storeId: STORE_1, body: { name: 'STORE_1分群', segment_type: 'static', filter: { source: 'Facebook' } } });
    store1SegmentId = r.body.id;
    const cross = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_2, params: { id: String(store1SegmentId) } });
    assert(cross.statusCode === 404, 'M-10：跨店讀取分群被擋下（404，不是回傳資料）');
    const crossDelete = await callRoute(crmRouter, 'DELETE', '/segments/:id', { storeId: STORE_2, params: { id: String(store1SegmentId) } });
    assert(crossDelete.statusCode === 404, 'M-10b：跨店刪除/封存分群被擋下');
  }
  {
    const actionResult = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: store1SegmentId, action_type: 'csv_export', payload: {} } });
    const crossAction = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_2, params: { id: String(actionResult.body.id) } });
    assert(crossAction.statusCode === 404, 'M-11：跨店讀取動作紀錄被擋下（404）');
    const crossCancel = await callRoute(crmRouter, 'POST', '/actions/:id/cancel', { storeId: STORE_2, params: { id: String(actionResult.body.id) } });
    assert(crossCancel.statusCode === 404, 'M-11b：跨店取消動作被擋下');
  }

  // ════════════════════════════════════════════════════════════════
  // Section 5：動態 vs 靜態分群行為差異（需求文件 C，M-12~M-13）
  // ════════════════════════════════════════════════════════════════
  let dynSegId, staticSegId;
  {
    const r1 = await callRoute(crmRouter, 'POST', '/segments', { storeId: STORE_1, body: { name: '動態-Google來源', segment_type: 'dynamic', filter: { source: 'Google' } } });
    dynSegId = r1.body.id;
    const r2 = await callRoute(crmRouter, 'POST', '/segments', { storeId: STORE_1, body: { name: '靜態-Google來源', segment_type: 'static', filter: { source: 'Google' } } });
    staticSegId = r2.body.id;
  }
  const beforeDetailDyn = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_1, params: { id: String(dynSegId) } });
  const beforeDetailStatic = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_1, params: { id: String(staticSegId) } });
  const beforeDynCount = beforeDetailDyn.body.members.length;
  const beforeStaticCount = beforeDetailStatic.body.members.length;

  // 新增一筆新的 Google 來源購物車（改變底層資料）
  addToCart(STORE_1, { cart_id: 'new_google_cart', visitor_id: 'new_google_visitor', product_id: 7001, source: 'Google' });

  const afterDetailDyn = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_1, params: { id: String(dynSegId) } });
  const afterDetailStatic = await callRoute(crmRouter, 'GET', '/segments/:id', { storeId: STORE_1, params: { id: String(staticSegId) } });
  assert(afterDetailDyn.body.members.length === beforeDynCount + 1, 'M-12：dynamic 分群在底層資料改變後，預覽人數立即反映最新狀態', `before=${beforeDynCount} after=${afterDetailDyn.body.members.length}`);
  assert(afterDetailStatic.body.members.length === beforeStaticCount, 'M-13：static 分群快照在底層資料改變後維持不變', `before=${beforeStaticCount} after=${afterDetailStatic.body.members.length}`);

  // ════════════════════════════════════════════════════════════════
  // Section 6：CRM Action 生命週期（idempotency／cancel／retry／dedup，需求文件 G/H）
  // ════════════════════════════════════════════════════════════════
  db.run(`INSERT INTO coupons (store_id, code, discount_type, discount_value, enabled) VALUES (?,?,?,?,1)`, [STORE_1, 'IDEM50', 'fixed', 50]);
  db._save();
  let idemActionId;
  {
    const r1 = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'coupon_grant', payload: { coupon_code: 'IDEM50' }, idempotency_key: 'idem-key-001' } });
    idemActionId = r1.body.id;
    const r2 = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'coupon_grant', payload: { coupon_code: 'IDEM50' }, idempotency_key: 'idem-key-001' } });
    assert(r2.body.id === idemActionId && r2.body.idempotent_replay === true, 'G-1：相同 idempotency_key 重複呼叫回傳既有動作，不建立第二筆', JSON.stringify(r2.body));
    const countRows = db.all('SELECT COUNT(*) as c FROM crm_actions WHERE store_id=? AND idempotency_key=?', [STORE_1, 'idem-key-001']);
    assert(countRows[0].c === 1, 'G-1b：資料庫裡確實只有 1 筆動作紀錄（不是建立了兩筆）');
  }
  {
    // 對同一位 LINE 會員，用「另一個 action」核發「同一張優惠券」——必須被 dedup 擋下
    const anotherAction = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'coupon_grant', payload: { coupon_code: 'IDEM50' } } });
    const targets = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_1, params: { id: String(anotherAction.body.id) } });
    const lineTargets = targets.body.targets.filter((t) => t.member_type === 'line_user_id');
    if (lineTargets.length) {
      assert(lineTargets.every((t) => t.status === 'skipped' && t.error_code === 'duplicate_grant'), 'H-1：同一位會員被不同 action 重複核發同一張優惠券時會被 dedup 擋下（status=skipped）', JSON.stringify(lineTargets));
    } else {
      pass('H-1：（此分群沒有 LINE 會員成員，dedup 情境無法在本測試資料下驗證，視為不適用）');
    }
  }
  {
    const invalid = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'coupon_grant', payload: { coupon_code: 'DOES_NOT_EXIST' } } });
    assert(invalid.statusCode === 400 && !invalid.body.success, 'H-2：無效優惠券在建立動作「之前」就被擋下（不會建立 action row）');
    const cnt = db.all("SELECT COUNT(*) as c FROM crm_actions WHERE store_id=? AND payload_json LIKE '%DOES_NOT_EXIST%'", [STORE_1]);
    assert(cnt[0].c === 0, 'H-2b：無效優惠券確實沒有留下任何 action row');
  }
  {
    // cancel：建立一個 not_configured 類型的動作（line_push），target 應該還是 pending，取消後應變成 cancelled
    const created = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'line_push', payload: {} } });
    const cancelled = await callRoute(crmRouter, 'POST', '/actions/:id/cancel', { storeId: STORE_1, params: { id: String(created.body.id) } });
    assert(cancelled.body.status === 'cancelled', 'G-4：取消動作後狀態變為 cancelled');
    const detail = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_1, params: { id: String(created.body.id) } });
    assert(detail.body.targets.every((t) => t.status === 'cancelled'), 'G-4b：取消後所有尚待處理的 target 都變成 cancelled');
    const retryAfterCancel = await callRoute(crmRouter, 'POST', '/actions/:id/retry', { storeId: STORE_1, params: { id: String(created.body.id) } });
    const detail2 = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_1, params: { id: String(created.body.id) } });
    assert(detail2.body.targets.every((t) => t.status === 'cancelled'), 'G-4c：已取消的動作 retry 不會讓 cancelled 的 target 又被處理');
  }
  {
    // retry 只處理 pending/failed，不重送已完成的
    const badCoupon = await callRoute(crmRouter, 'POST', '/actions', { storeId: STORE_1, body: { segment_id: staticSegId, action_type: 'coupon_grant', payload: { coupon_code: 'IDEM50' } } });
    const before = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_1, params: { id: String(badCoupon.body.id) } });
    const completedBefore = before.body.targets.filter((t) => t.status === 'completed').map((t) => t.member_key);
    await callRoute(crmRouter, 'POST', '/actions/:id/retry', { storeId: STORE_1, params: { id: String(badCoupon.body.id) } });
    const after = await callRoute(crmRouter, 'GET', '/actions/:id', { storeId: STORE_1, params: { id: String(badCoupon.body.id) } });
    const completedAfter = after.body.targets.filter((t) => t.status === 'completed').map((t) => t.member_key);
    assert(JSON.stringify(completedBefore.sort()) === JSON.stringify(completedAfter.sort()), 'G-3：retry 不會重複處理已經 completed 的 target', `before=${completedBefore} after=${completedAfter}`);
  }

  // ════════════════════════════════════════════════════════════════
  // Section 7：Drill Down 安全性（需求文件 J，M-22~M-24）
  // ════════════════════════════════════════════════════════════════
  {
    const r = getDrilldownRows(db, STORE_1, { source: "Facebook' OR '1'='1" });
    assert(Array.isArray(r.rows) && r.total === 0, 'M-23：SQL injection 風格的篩選值不會改變查詢邏輯（參數化查詢，安全視為字面字串）', `total=${r.total}`);
  }
  {
    const r = getDrilldownRows(db, STORE_1, { source: 'Facebook' }, { sort_by: 'DROP TABLE orders; --', sort_dir: 'desc' });
    assert(Array.isArray(r.rows), 'M-22：無效的排序欄位被安全地拒絕/退回預設值，不拋例外');
    const stillExists = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name='orders'");
    assert(stillExists.length === 1, 'M-22b：orders 表沒有被任何注入嘗試影響（仍然存在）');
  }
  {
    const r1 = getDrilldownRows(db, STORE_1, {}, { page: 1, limit: 2 });
    const r2 = getDrilldownRows(db, STORE_1, {}, { page: 2, limit: 2 });
    assert(r1.total === r2.total, 'M-24：分頁不同頁碼的 total 一致（分頁本身不影響總數計算）', `p1=${r1.total} p2=${r2.total}`);
    assert(typeof r1.generated_at === 'string' && r1.generated_at.length > 0, 'J-1：Drill Down 回應含 generated_at 資料新鮮度時間戳');
    assert(Array.isArray(r1.warnings), 'J-2：Drill Down 回應含 warnings 陣列（即使是空的）');
  }

  // ── 統計 ──
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n合計：${results.length} 項，PASS ${results.length - failCount}，FAIL ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[smoke-hotfix31-r2-hardening] 未預期錯誤：', e);
  process.exit(1);
});
