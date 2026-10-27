#!/usr/bin/env node
// scripts/smoke-h1-4-12-line-counter-snapshot-security.js
// R44.1B：line_counter_allocation_snapshot 嚴格驗證安全矩陣。
// 每個 invalid case：先用真實 HTTP 建立合法訂單（真實扣過 counter/ingredient），
// 再只 raw-corrupt 該案指定欄位，然後走真實 cancel/void HTTP endpoint。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 line counter snapshot security (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-snapshot-sec-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-snapshot-sec';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  let server;
  try {
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_002','y','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({ mon: { open: '00:00', close: '23:59', enabled: true }, tue: { open: '00:00', close: '23:59', enabled: true }, wed: { open: '00:00', close: '23:59', enabled: true }, thu: { open: '00:00', close: '23:59', enabled: true }, fri: { open: '00:00', close: '23:59', enabled: true }, sat: { open: '00:00', close: '23:59', enabled: true }, sun: { open: '00:00', close: '23:59', enabled: true } })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
    db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key LIKE 'business_calendar%'");
    const PID = 7001, OTHER_STORE_PID = 7002, UNKNOWN_PID = 999999991;
    db._db.run(`DELETE FROM products WHERE id IN (${PID},${OTHER_STORE_PID})`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, sale_status, line_quota_enabled, line_quota_daily, line_quota_sold) VALUES (${PID}, 'store_001', 'SnapSecProduct', '主食', 100, 1, 1, 'available', 1, 100000, 41)`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_quota_sold) VALUES (${OTHER_STORE_PID}, 'store_002', 'CrossStoreProduct', '主食', 100, 1, 37)`);
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    const { requireStore } = require('../middleware/storeGuard'); const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-orders', requireStore, requireFeature('line_order'), require('../routes/line-orders'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
    const call = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${T1}` }, body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const cancelOrder = (id) => call('PATCH', `/api/orders/${id}/status`, { order_status: 'cancelled' });
    const voidOrder = (id) => call('POST', `/api/orders/${id}/void`, { reason: 'test', operator: 'test' });
    let phoneSeq = 0; const nextPhone = () => '0955330' + String(100 + (++phoneSeq));
    function ordersnap(id) { return db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [id]); }
    function voidLogCount(id) { return db.get("SELECT COUNT(*) AS c FROM order_logs WHERE order_id=? AND action='void'", [id]).c; }

    // ══════════════════════════════════════════════════════════════
    // Reality Audit rule table（見報告；本檔案只針對稽核發現的缺口與
    // 具代表性的 invalid case 建立真實測試，不是全部 24 案）。
    // ══════════════════════════════════════════════════════════════

    async function makeOrder(phone, qty) {
      const r = await call('POST', '/api/line-orders', {}, );
      return r;
    }
    async function makeRealOrder(phone, qty) {
      const r = await call('POST', '/api/line-orders', undefined);
      return r;
    }
    async function createRealOrder(phone, qty) {
      const r = await call('POST', '/api/line-orders', { customer_name: 'Sec' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty }] });
      if (!(r.status === 200 || r.status === 201)) return null;
      const row = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      return row ? row.id : null;
    }

    async function invalidCase(label, corruptFn, terminal) {
      const phone = nextPhone();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createRealOrder(phone, 2);
      assert(!!orderId, `INV-${label}-prereq-create prerequisite：真實建單必須成功`, '');
      if (!orderId) return;
      const before = ordersnap(orderId);
      const beforeLog = voidLogCount(orderId);
      corruptFn(orderId);
      db._save();
      const r = terminal === 'cancel' ? await cancelOrder(orderId) : await voidOrder(orderId);
      assert(r.status === 409, `INV-${label}-409 真實 409（${terminal}）`, `status=${r.status} ${JSON.stringify(r.json).slice(0, 120)}`);
      assert(!/at\s+\S+\.js:\d+|node_modules|SELECT|UPDATE|INSERT/i.test(JSON.stringify(r.json)), `INV-${label}-no-leak response 無 SQL／path／stack 洩漏`, '');
      assert(JSON.stringify(ordersnap(orderId)) === JSON.stringify(before), `INV-${label}-order-unchanged order status/order_status/void metadata 完全不變`, '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 2, `INV-${label}-counter-unchanged counter 維持「訂單仍占用」的值（未被錯誤恢復）`, '');
      assert(voidLogCount(orderId) === beforeLog, `INV-${label}-no-void-log void log 未新增`, '');
    }

    const corrupt = (orderId, value) => db._db.run('UPDATE orders SET line_counter_allocation_snapshot=? WHERE id=?', [value, orderId]);
    const corruptBucket = (orderId, value) => db._db.run('UPDATE orders SET line_counter_bucket=? WHERE id=?', [value, orderId]);

    // 1-14, 17-18: parser-level rejections（已確認由既有 parseAllocationSnapshot 檢查）
    await invalidCase('3-malformed-json', (id) => corrupt(id, '{not valid json'), 'cancel');
    await invalidCase('4-json-null', (id) => corrupt(id, 'null'), 'void');
    await invalidCase('5-json-array', (id) => corrupt(id, '[1,2,3]'), 'cancel');
    await invalidCase('6-version-missing', (id) => corrupt(id, JSON.stringify({ allocations: [] })), 'void');
    await invalidCase('7-version-0', (id) => corrupt(id, JSON.stringify({ version: 0, allocations: [] })), 'cancel');
    await invalidCase('8-version-2', (id) => corrupt(id, JSON.stringify({ version: 2, allocations: [] })), 'void');
    await invalidCase('9-version-string', (id) => corrupt(id, JSON.stringify({ version: '1', allocations: [] })), 'cancel');
    await invalidCase('10-allocations-missing', (id) => corrupt(id, JSON.stringify({ version: 1 })), 'void');
    await invalidCase('11-allocations-not-array', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: {} })), 'cancel');
    await invalidCase('12-top-level-extra-field', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [], extra: 'x' })), 'void');
    await invalidCase('13-allocation-extra-field', (id, pid = PID) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 2, extra: 'x' }] })), 'cancel');
    await invalidCase('14-allocation-missing-field', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota' }] })), 'void');
    await invalidCase('15a-product-id-zero', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: 0, counter_bucket: 'quota', qty: 2 }] })), 'cancel');
    await invalidCase('15b-product-id-negative', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: -1, counter_bucket: 'quota', qty: 2 }] })), 'void');
    await invalidCase('15c-product-id-decimal', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: 1.5, counter_bucket: 'quota', qty: 2 }] })), 'cancel');
    await invalidCase('15d-product-id-string', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: '1', counter_bucket: 'quota', qty: 2 }] })), 'void');
    await invalidCase('15e-product-id-unsafe', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: Number.MAX_SAFE_INTEGER + 1, counter_bucket: 'quota', qty: 2 }] })), 'cancel');
    await invalidCase('16a-qty-zero', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 0 }] })), 'void');
    await invalidCase('16b-qty-negative', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: -1 }] })), 'cancel');
    await invalidCase('16c-qty-decimal', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 1.5 }] })), 'void');
    await invalidCase('16d-qty-string', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: '2' }] })), 'cancel');
    await invalidCase('16e-qty-null', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: null }] })), 'void');
    await invalidCase('16f-qty-boolean', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: true }] })), 'cancel');
    await invalidCase('16g-qty-array', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: [1] }] })), 'void');
    await invalidCase('17-illegal-bucket', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'evil', qty: 2 }] })), 'cancel');
    await invalidCase('18-duplicate-aggregate-overflow', (id) => corrupt(id, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: Number.MAX_SAFE_INTEGER }, { product_id: PID, counter_bucket: 'quota', qty: 1 }] })), 'void');
    // 19: snapshot bucket 與 order-level bucket 不一致
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createRealOrder(phone, 2);
      assert(!!orderId, 'INV-19-prereq-create prerequisite：真實建單必須成功', '');
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'preorder', qty: 2 }] })); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 409, 'INV-19-bucket-mismatch-409 snapshot bucket 與 order-level bucket 不一致，真實 409', `status=${r.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 2, 'INV-19-counter-unchanged counter 未被誤恢復', '');
    }
    // 23/24：unknown product 與 cross-store product（本輪確認並修正的真實 P0）
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createRealOrder(phone, 2);
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: UNKNOWN_PID, counter_bucket: 'quota', qty: 2 }] })); db._save();
      const r = await cancelOrder(orderId);
      // cancel 的 route（PATCH /:id/status）既有、已知的行為：只轉發 {success,message}，
      // 不轉發 error 機器可讀代碼（void 的 route 有轉發）——這是很多輪之前就記錄過的
      // pre-existing 不一致，不是本輪新發現的 bug，這裡改用 message 內容比對。
      assert(r.status === 409 && /份數配額紀錄|LINE_COUNTER_ALLOCATION_PRODUCT_INVALID/.test(JSON.stringify(r.json)), 'INV-23-unknown-product-409 R44.1B 修正：snapshot 指向不存在的商品，真實 409 LINE_COUNTER_ALLOCATION_PRODUCT_INVALID（修正前會靜默成功、資源永遠不恢復）', JSON.stringify(r).slice(0, 150));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 2, 'INV-23-counter-unchanged 真正該恢復的 counter 維持「仍占用」狀態', '');
    }
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const otherStoreCounterBefore = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_STORE_PID]).v;
      const orderId = await createRealOrder(phone, 2);
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: OTHER_STORE_PID, counter_bucket: 'quota', qty: 2 }] })); db._save();
      const r = await voidOrder(orderId);
      // R44.1B-2 更正：新的 order.items 交叉驗證會比 affected-rows 檢查更早
      // 攔截這個案例（跨店商品根本不會出現在本店訂單的 order.items 裡），
      // 所以現在實際命中的是 QTY_MISMATCH（product 不在 order.items 也視為
      // 不一致）而不是 PRODUCT_INVALID——兩者都是合法的 fail-closed 409，
      // 這裡放寬成接受任一個，不強求特定觸發順序。
      assert(r.status === 409 && (r.json.error === 'LINE_COUNTER_ALLOCATION_PRODUCT_INVALID' || r.json.error === 'LINE_COUNTER_ALLOCATION_QTY_MISMATCH'), 'INV-24-cross-store-409 R44.1B 修正：snapshot 指向另一家店的商品，真實 409（修正前會靜默成功）', JSON.stringify(r).slice(0, 150));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 2, 'INV-24-own-store-counter-unchanged 本店商品 counter 維持「仍占用」', '');
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_STORE_PID]).v === otherStoreCounterBefore, 'INV-24-other-store-counter-unchanged 另一家店的商品 counter 完全未被跨店動到', '');
    }
    // NULL / 空字串（既有 R44 稽核已覆蓋，這裡補上明確去區分 snapshot-missing 與 snapshot-invalid 的證據）
    {
      const phone = nextPhone(); const orderId = await createRealOrder(phone, 2);
      db._db.run('UPDATE orders SET line_counter_allocation_snapshot=NULL WHERE id=?', [orderId]); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 409 && /份數配額快照|SNAPSHOT_MISSING/.test(JSON.stringify(r.json)), 'INV-1-sql-null-correctly-classified-missing snapshot=SQL NULL 正確分類為 snapshot-missing（不是 snapshot-invalid）', JSON.stringify(r).slice(0, 120));
    }
    {
      const phone = nextPhone(); const orderId = await createRealOrder(phone, 2);
      corrupt(orderId, ''); db._save();
      const r = await voidOrder(orderId);
      assert(r.status === 409 && r.json.error === 'LINE_COUNTER_ALLOCATION_SNAPSHOT_MISSING', 'INV-2-empty-string-correctly-classified-missing snapshot=空字串正確分類為 snapshot-missing', JSON.stringify(r).slice(0, 120));
    }

    // ══════════════════════════════════════════════════════════════
    // 合法控制案例
    // ══════════════════════════════════════════════════════════════
    // A：empty-v1 合法且終結
    {
      const phone = nextPhone(); const orderId = await createRealOrder(phone, 2);
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [] })); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 200, 'CTRL-A-empty-v1-succeeds empty-v1 被視為有效且終結性的 authority，cancel 成功（no-op，不 fallback）', `status=${r.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, 'CTRL-A-empty-v1-counter-unchanged empty-v1 之下 counter 不變（本案本來就故意設成空，不代表真實訂單應該不扣）', '');
    }
    // B：disabled product 仍可依 snapshot 釋放
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createRealOrder(phone, 2);
      db._db.run("UPDATE products SET enabled=0, sale_status='sold_out_today' WHERE id=?", [PID]); db._save();
      const r = await cancelOrder(orderId);
      db._db.run("UPDATE products SET enabled=1, sale_status='available' WHERE id=?", [PID]); db._save();
      assert(r.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, 'CTRL-B-disabled-product-still-releases 建立後商品被下架/售完，cancel 仍能依 snapshot 精確釋放（lookup 只要求同店存在，不要求目前可售）', '');
    }
    // D：mixed participating/non-participating（單一商品案例，沿用既有 46-mixed 測試精神）
    {
      const phone = nextPhone(); const orderId = await createRealOrder(phone, 2);
      const snap = JSON.parse(db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [orderId]).s);
      assert(snap.allocations.length === 1 && snap.allocations[0].product_id === PID, 'CTRL-D-snapshot-only-participating snapshot 只包含真正參與 counter 的商品（單一參與商品案例，驗證 snapshot 不會覆蓋整個 order.items）', JSON.stringify(snap));
      await cancelOrder(orderId);
    }

    // ══════════════════════════════════════════════════════════════
    // R44.1B-2：三個真實 P0（同店錯商品／qty 過小／qty 過大）已在
    // production 修正前用獨立 script 重現（見報告），這裡轉成永久
    // regression，透過真實 HTTP + raw-corrupt snapshot 走 cancel/void。
    // ══════════════════════════════════════════════════════════════
    const NONPARTICIPATING_PID = 7003;
    db._db.run(`DELETE FROM products WHERE id=${NONPARTICIPATING_PID}`);
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, line_quota_sold) VALUES (${NONPARTICIPATING_PID}, 'store_001', 'SameStoreOther', '主食', 100, 1, 31)`);
    db._save();
    async function createMixedOrder(phone) {
      const r = await call('POST', '/api/line-orders', { customer_name: 'Mix' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 3 }] });
      if (!(r.status === 200 || r.status === 201)) return null;
      const row = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone]);
      return row ? row.id : null;
    }
    // A（本輪 pre-fix P0）：同店錯商品
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v; const other0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v;
      const orderId = await createMixedOrder(phone);
      assert(!!orderId, 'INV-20-prereq-create prerequisite：真實建單必須成功', '');
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: NONPARTICIPATING_PID, counter_bucket: 'quota', qty: 3 }] })); db._save();
      const r1 = await cancelOrder(orderId);
      assert(r1.status === 409, 'INV-20-product-not-in-items-cancel R44.1B-2 修正：snapshot 指向同店但實際上未購買的商品，cancel 真實 409（修正前會扣錯商品、真正購買的商品永遠不恢復）', `status=${r1.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 3 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v === other0, 'INV-20-both-products-unchanged 真正購買的商品與被誤指的商品皆完全不變（沒有任何一邊被錯誤動到）', '');
    }
    // B（本輪 pre-fix P0）：qty 過小
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createMixedOrder(phone);
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 2 }] })); db._save();
      const r = await voidOrder(orderId);
      assert(r.status === 409, 'INV-21-qty-too-small-void R44.1B-2 修正：snapshot qty(2) 小於實際購買 qty(3)，void 真實 409（修正前會永久少恢復 1）', `status=${r.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 3, 'INV-21-counter-unchanged counter 維持訂單仍占用的完整 3', '');
    }
    // C（本輪 pre-fix P0）：qty 過大
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createMixedOrder(phone);
      corrupt(orderId, JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 4 }] })); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 409, 'INV-22-qty-too-large-cancel R44.1B-2 修正：snapshot qty(4) 大於實際購買 qty(3)，cancel 真實 409（修正前會多恢復，counter 低於真實占用量、有超賣風險）', `status=${r.status}`);
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 3, 'INV-22-counter-unchanged counter 維持訂單仍占用的完整 3', '');
    }
    // order.items 本身損壞
    {
      const phone = nextPhone(); const orderId = await createMixedOrder(phone);
      db._db.run("UPDATE orders SET items='{not valid json' WHERE id=?", [orderId]); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 409, 'INV-25-items-malformed-json order.items 本身是 malformed JSON，cancel 真實 409', `status=${r.status}`);
    }
    {
      const phone = nextPhone(); const orderId = await createMixedOrder(phone);
      db._db.run("UPDATE orders SET items='null' WHERE id=?", [orderId]); db._save();
      const r = await voidOrder(orderId);
      assert(r.status === 409, 'INV-26-items-null order.items 是 JSON null，void 真實 409', `status=${r.status}`);
    }
    {
      const phone = nextPhone(); const orderId = await createMixedOrder(phone);
      db._db.run("UPDATE orders SET items='{}' WHERE id=?", [orderId]); db._save();
      const r = await cancelOrder(orderId);
      assert(r.status === 409, 'INV-27-items-non-array order.items 是 object 而非 array，cancel 真實 409', `status=${r.status}`);
    }
    // A：duplicate item rows（合法控制）
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const r = await call('POST', '/api/line-orders', { customer_name: 'Dup' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 1 }, { product_id: PID, qty: 2 }] });
      assert(r.status === 200 || r.status === 201, 'CTRL-A-dup-prereq-create prerequisite：duplicate item rows 建單必須成功', `status=${r.status}`);
      const order = db.get('SELECT id, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      const snap = JSON.parse(order.s);
      assert(snap.allocations.length === 1 && snap.allocations[0].qty === 3, 'CTRL-A-dup-snapshot-aggregated snapshot 正確聚合成 1 筆 qty=3（總和）', JSON.stringify(snap));
      const rc = await cancelOrder(order.id);
      assert(rc.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0, 'CTRL-A-dup-cancel-restores-once cancel 成功且只恢復總 qty=3 一次', '');
    }

    // B：mixed products——A 與 B 真的同時出現在同一張訂單的 order.items，
    // 但只有 A 建立時參與 counter（NONPARTICIPATING_PID 沒有設定
    // line_quota_enabled，符合「建立時不參與」）。
    {
      const phone = nextPhone();
      const qA0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const qB0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v;
      const r = await call('POST', '/api/line-orders', { customer_name: 'MixReal' + phone, customer_phone: phone, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 2 }, { product_id: NONPARTICIPATING_PID, qty: 5 }] });
      assert(r.status === 200 || r.status === 201, 'CTRL-B-mixed-prereq-create prerequisite：同時包含參與/不參與商品的訂單建立必須成功', `status=${r.status}`);
      const order = db.get('SELECT id, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone=?', [phone]);
      const snap = JSON.parse(order.s);
      assert(snap.allocations.length === 1 && snap.allocations[0].product_id === PID && snap.allocations[0].qty === 2, 'CTRL-B-mixed-snapshot-only-A snapshot 只包含真正參與的 A，不含 B（不要求 snapshot 覆蓋全部 order.items）', JSON.stringify(snap));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === qA0 + 2 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v === qB0, 'CTRL-B-mixed-create-only-A-counted 建立後只有 A 的 counter +2，B 完全不變', '');
      const rc = await cancelOrder(order.id);
      assert(rc.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === qA0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v === qB0, 'CTRL-B-mixed-cancel-A-restored-B-unchanged cancel 成功，A 精確恢復，B byte-identical 不變', '');
      const phone2 = nextPhone();
      const rv = await call('POST', '/api/line-orders', { customer_name: 'MixReal2' + phone2, customer_phone: phone2, order_type: 'takeout', payment_method: 'cash', items: [{ product_id: PID, qty: 3 }, { product_id: NONPARTICIPATING_PID, qty: 1 }] });
      assert(rv.status === 200 || rv.status === 201, 'CTRL-B-mixed-void-prereq-create prerequisite：第二筆 mixed order 建立必須成功', `status=${rv.status}`);
      const order2 = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone2]);
      const qA1 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v; const qB1 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v;
      const rvVoid = await voidOrder(order2.id);
      assert(rvVoid.status === 200 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === qA1 - 3 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [NONPARTICIPATING_PID]).v === qB1, 'CTRL-B-mixed-void-A-restored-B-unchanged void 同樣成功，A 精確恢復，B byte-identical 不變', '');
    }

    // ══════════════════════════════════════════════════════════════
    // R44.1B-3：product-existence preflight 永久 regression。
    // pre-fix 真實重現（獨立 script，非本 suite）已證明：修正前案例 C
    // （合法 allocation 與 unknown allocation 混在同一個 snapshot、且
    // order.items 也同時包含兩者讓 qty cross-validation 通過）會先真的
    // 執行合法那筆的 counter UPDATE，才在第二筆偵測到失敗——因為兩個真實
    // caller（cancel/void）都在 db.runDurableTransaction() 內呼叫並在
    // !ok 時 throw，SQL 層級 ROLLBACK 會撤銷已執行的 UPDATE，所以
    // production 目前並未因此留下壞資料；但為了不僅依賴呼叫端的
    // rollback，這裡已經加上 preflight，使 UPDATE 呼叫次數在這類案例下
    // 直接是 0（不會執行任何一筆）。下面用真實 HTTP + db._db.run tracker
    // 證明 UPDATE seam 命中次數。
    // ══════════════════════════════════════════════════════════════
    function installUpdateTracker() {
      const origRaw = db._db.run.bind(db._db); let hits = 0;
      db._db.run = function (sql, params) { if (typeof sql === 'string' && sql.includes('UPDATE products SET line_quota_sold')) hits++; return origRaw(sql, params); };
      return { hits: () => hits, restore: () => { delete db._db.run; } };
    }
    // A：snapshot 與 order.items 同時改成不存在的 product
    {
      const phone = nextPhone(); const orderId = await createMixedOrder(phone);
      db._db.run(`UPDATE orders SET items=?, line_counter_allocation_snapshot=? WHERE id=?`, [JSON.stringify([{ product_id: 999999992, qty: 3 }]), JSON.stringify({ version: 1, allocations: [{ product_id: 999999992, counter_bucket: 'quota', qty: 3 }] }), orderId]); db._save();
      const t = installUpdateTracker();
      const r = await cancelOrder(orderId); t.restore();
      assert(r.status === 409 && t.hits() === 0, 'PREFLIGHT-A-unknown-product-zero-updates snapshot／order.items 同時指向不存在的商品，真實 409 且 counter UPDATE seam 命中 0 次（preflight 在任何 UPDATE 前擋下）', JSON.stringify({ status: r.status, hits: t.hits() }));
    }
    // B：snapshot 與 order.items 同時改成 cross-store product
    {
      const phone = nextPhone(); const orderId = await createMixedOrder(phone);
      db._db.run(`UPDATE orders SET items=?, line_counter_allocation_snapshot=? WHERE id=?`, [JSON.stringify([{ product_id: OTHER_STORE_PID, qty: 3 }]), JSON.stringify({ version: 1, allocations: [{ product_id: OTHER_STORE_PID, counter_bucket: 'quota', qty: 3 }] }), orderId]); db._save();
      const otherBefore = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_STORE_PID]).v;
      const t = installUpdateTracker();
      const r = await voidOrder(orderId); t.restore();
      assert(r.status === 409 && t.hits() === 0 && db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [OTHER_STORE_PID]).v === otherBefore, 'PREFLIGHT-B-cross-store-zero-updates snapshot／order.items 同時指向另一家店的商品，真實 409，UPDATE seam 命中 0 次，對方店商品完全不變', JSON.stringify({ status: r.status, hits: t.hits() }));
    }
    // C：混合合法＋不合法 allocation，兩者都在 order.items 裡（讓 qty cross-validation 通過），驗證 UPDATE seam 仍是 0
    {
      const phone = nextPhone(); const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v;
      const orderId = await createMixedOrder(phone);
      db._db.run(`UPDATE orders SET items=?, line_counter_allocation_snapshot=? WHERE id=?`, [
        JSON.stringify([{ product_id: PID, qty: 3 }, { product_id: 999999993, qty: 1 }]),
        JSON.stringify({ version: 1, allocations: [{ product_id: PID, counter_bucket: 'quota', qty: 3 }, { product_id: 999999993, counter_bucket: 'quota', qty: 1 }] }),
        orderId]); db._save();
      const t = installUpdateTracker();
      const r = await cancelOrder(orderId); t.restore();
      assert(r.status === 409 && t.hits() === 0, 'PREFLIGHT-C-mixed-valid-invalid-zero-updates 混合合法＋unknown allocation（qty cross-validation 對兩者都會通過），真實 409 且 UPDATE seam 命中 0 次——合法那筆也完全沒有被動到', JSON.stringify({ status: r.status, hits: t.hits() }));
      assert(db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [PID]).v === q0 + 3, 'PREFLIGHT-C-legit-product-untouched 合法商品（本來就真的購買）的 counter 完全沒有被 UPDATE 過，維持訂單仍占用的值', '');
    }

    assert(fs.readdirSync(path.dirname(process.env.POS_DB_PATH)).filter((f) => f.includes('.tmp-')).length === 0, 'FINAL-no-temp-residue 全程結束後無 durable temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
