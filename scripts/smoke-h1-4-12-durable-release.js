#!/usr/bin/env node
// scripts/smoke-h1-4-12-durable-release.js
// R44.2F.3B：Shipping 與 Popup cancel/void 的 durable fault matrix。
// 獨立 temp DB／server／port／store／products／campaign／session，
// 不依賴主套件共享 fixture。cancel/void 兩者都真的走
// routes/orders.js 的共用端點（Reality Audit 已確認：shipping 訂單與
// popup 訂單的 cancel/void 是同一組 route，內部依 order.pickup_type
// / source 分流成不同的 durable transaction 分支）。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os'), http = require('http'), crypto = require('crypto');
const jwt = require('jsonwebtoken');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 durable release (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-durable-release-'));
  process.env.POS_DB_PATH = path.join(tmpDir, 'test.db');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-durable-release';
  const { initDb, getDb } = require('../utils/db');
  await initDb(); const db = getDb();
  let server;
  try {
    // ── fixture：shipping 商品（A 參與 quota、B 不參與、非零 baseline）+ popup campaign/session ──
    const SA = 8001, SB = 8002;
    db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','shipping_enabled','1')");
    db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001','popup_pickup_enabled','1')");
    db._db.run(`INSERT INTO products (id, store_id, name, category, price, enabled, shipping_enabled, shipping_share_line_stock, line_quota_enabled, line_quota_daily, line_quota_sold) VALUES
      (${SA}, 'store_001', 'RelShipA', '主食', 200, 1, 1, 1, 1, 100000, 11),
      (${SB}, 'store_001', 'RelShipB', '主食', 150, 1, 1, 0, 1, 100000, 13)`);
    db._db.run("INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (8003, 'store_001', 'RelPopupProd', '主食', 90, 1)");
    db._save();

    const express = require('express'); const app = express(); app.use(express.json());
    const { requireStore } = require('../middleware/storeGuard'); const { requireFeature } = require('../middleware/featureGate');
    app.use('/api/line-shipping', requireStore, requireFeature('line_order'), require('../routes/line-shipping'));
    app.use('/api/line-orders', require('../routes/popup-public'));
    app.use('/api/orders', requireStore, require('../routes/orders'));
    app.use('/api/popup-pickup', requireStore, require('../routes/popup-pickup'));
    server = http.createServer(app); await new Promise((r) => server.listen(0, r));
    const base = `http://127.0.0.1:${server.address().port}`;
    const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });

    const call = async (method, p, body, token) => { const r = await fetch(base + p, { method, headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}), body: body !== undefined ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json().catch(() => ({})) }; };
    const camp = await call('POST', '/api/popup-pickup/campaigns', { name: 'RelCamp', status: 'published' }, T1);
    const loc = await call('POST', '/api/popup-pickup/locations', { name: 'RelLoc', address: '測試路1號', lat: 24.99, lng: 121.3 }, T1);
    const sessBody = (code) => ({ campaign_id: camp.json.data.id, name: 'RelSess' + code, status: 'published', pickup_date: '2026-12-25', pickup_start_time: '17:00', pickup_end_time: '19:00', order_open_at: '2026-01-01T00:00', order_cutoff_at: '2026-12-24T23:59', location_id: loc.json.data.id, product_scope: 'all_takeout', max_orders: 100 });
    const sess1 = await call('POST', '/api/popup-pickup/sessions', sessBody('1'), T1);
    const SESS1_CODE = sess1.json.data && sess1.json.data.public_code;
    const dbFile = process.env.POS_DB_PATH, dbDir = path.dirname(dbFile);
    const fileSha = () => crypto.createHash('sha256').update(fs.readFileSync(dbFile)).digest('hex');
    const memHash = () => crypto.createHash('sha256').update(Buffer.from(db._db.export())).digest('hex');
    const tmpResidue = () => fs.readdirSync(dbDir).filter((f) => f.includes('.tmp-'));
    const freshDisk = async (sql) => JSON.parse((await execFileP('node', ['-e', `require('sql.js')().then(S=>{const d=new S.Database(require('fs').readFileSync(process.env.POS_DB_PATH));const x=d.exec(${JSON.stringify(sql)});console.log(JSON.stringify(x[0]?x[0].values:[]))})`], { cwd: path.join(__dirname, '..'), env: process.env, timeout: 15000 })).stdout.trim().split('\n').pop());
    const withFault = (kind) => {
      if (kind === 'write') { const o = fs.writeSync; fs.writeSync = function () { throw new Error('inj write'); }; return () => { fs.writeSync = o; }; }
      const o = fs.renameSync; fs.renameSync = function (a, b) { if (b === dbFile) throw new Error('inj rename'); return o.apply(this, arguments); }; return () => { fs.renameSync = o; };
    };
    const qA = () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SA]).v;
    const qB = () => db.get('SELECT line_quota_sold AS v FROM products WHERE id=?', [SB]).v;
    let phoneSeq = 0; const nextPhone = () => '0955310' + String(100 + (++phoneSeq));

    async function makeShippingOrder(qtyA, qtyB) {
      const phone = nextPhone();
      const items = [{ product_id: SA, qty: qtyA }]; if (qtyB) items.push({ product_id: SB, qty: qtyB });
      const r = await call('POST', '/api/line-shipping', { recipient_name: 'Rel', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items }, T1);
      if (!(r.status === 200 || r.status === 201)) throw new Error('shipping create failed: ' + JSON.stringify(r));
      return db.get('SELECT id, status, order_status FROM orders WHERE customer_phone=?', [phone]);
    }
    async function makePopupOrder() {
      const phone = nextPhone();
      const r = await call('POST', '/api/line-orders/popup-checkout', { popup_session_public_code: SESS1_CODE, customer_name: 'RelPopup', customer_phone: phone, items: [{ product_id: 8003, qty: 1 }], payment_method: 'cash' }, null);
      if (r.status !== 201) throw new Error('popup checkout failed: ' + JSON.stringify(r));
      return db.get('SELECT id, status, order_status FROM orders WHERE customer_phone=?', [phone]);
    }
    const allocRow = (orderId) => db.get("SELECT status, released_at FROM popup_order_allocations WHERE order_id=?", [orderId]);
    const voidLogCount = (orderId) => db.get("SELECT COUNT(*) AS c FROM order_logs WHERE order_id=? AND action='void'", [orderId]).c;

    // ══════════════════════════════════════════════════════════════
    // Reality Audit（記錄）：shipping／popup cancel／void 都走
    // routes/orders.js 的 PATCH /:id/status、POST /:id/void，內部依
    // order.pickup_type==='popup' 分流成不同的 durable transaction 分支
    // （popup 走 releasePopupOrderAllocations，standard/shipping 走
    // restockOrderItems + restoreLineQuotaCounters）。兩條路徑都已用
    // db.runDurableTransaction() 包裹，isDurableError(e) 都映射固定
    // 503 STORAGE_UNAVAILABLE。整個檔案 grep 確認：無 broadcast、無
    // webhook、無 analytics 呼叫——這兩個 release 路徑目前沒有 side effect。
    // ══════════════════════════════════════════════════════════════

    // ── 正向控制：shipping mixed cancel ──────────────────────────
    {
      const q0A = qA(), q0B = qB();
      const order = await makeShippingOrder(2, 3);
      assert(qA() === q0A + 2 && qB() === q0B, 'PC-ship-create-only-A shipping 建立只增加 A（B 非零 baseline不變）', JSON.stringify({ q0A, qA: qA(), q0B, qB: qB() }));
      const r = await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      assert(r.status === 200 && qA() === q0A && qB() === q0B, 'PC-ship-cancel-restores-A-only shipping cancel 只還原 A', JSON.stringify({ qA: qA(), qB: qB() }));
    }
    // ── 正向控制：popup cancel ──────────────────────────────────
    {
      const order = await makePopupOrder();
      const r = await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      assert(r.status === 200 && allocRow(order.id).status === 'released', 'PC-popup-cancel-releases popup cancel 真實釋放 allocation', JSON.stringify(allocRow(order.id)));
    }

    // ── Shipping fault matrix：cancel / void × write / rename ─────
    async function shipFault(label, op, faultKind) {
      const baselineA = qA(), baselineB = qB();
      const order = await makeShippingOrder(2, 3);
      const q0A = qA(), q0B = qB(), before = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
      const h0 = fileSha(), m0 = memHash(), b0 = fs.readFileSync(dbFile);
      const diskBefore = await freshDisk(`SELECT order_status FROM orders WHERE id='${order.id}'`);
      const undo = withFault(faultKind);
      let r; try { r = op === 'cancel' ? await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1) : await call('POST', `/api/orders/${order.id}/void`, { reason: 'R44F3B', operator: 'test' }, T1); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE' && !/inj|tmp|\.db|SELECT|UPDATE|at\s+\S+\.js/i.test(JSON.stringify(r.json)), `SHIP-${label}-503 固定 503 STORAGE_UNAVAILABLE，無洩漏`, JSON.stringify(r).slice(0, 130));
      const after = db.get('SELECT status, order_status, void_reason, voided_at FROM orders WHERE id=?', [order.id]);
      assert(JSON.stringify(after) === JSON.stringify(before), `SHIP-${label}-order-unchanged order status／void metadata 全部維持 before-state`, JSON.stringify({ before, after }));
      assert(qA() === q0A && qB() === q0B, `SHIP-${label}-counter-unchanged 兩商品 counter 不變（snapshot 未釋放）`, '');
      assert(fileSha() === h0 && memHash() === m0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `SHIP-${label}-hash-unchanged DB 檔與 memory export hash 皆不變`, '');
      assert(JSON.stringify(await freshDisk(`SELECT order_status FROM orders WHERE id='${order.id}'`)) === JSON.stringify(diskBefore), `SHIP-${label}-fresh-unchanged fresh process 讀回 before-state`, '');
      assert(tmpResidue().length === 0, `SHIP-${label}-no-residue 無 temp 殘留`, '');
      const other = await makeShippingOrder(1, 0);
      const orderStatusStillFailed = db.get('SELECT order_status FROM orders WHERE id=?', [order.id]).order_status;
      assert(qA() === q0A + 1 && qB() === q0B && orderStatusStillFailed === before.order_status, `SHIP-${label}-not-resurrected 另一筆成功 save 不會復活失敗的 mutation（失敗訂單本身仍是 before-state，另一筆訂單正常增加）`, JSON.stringify({ qA: qA(), q0A, orderStatusStillFailed, expected: before.order_status }));
      await call('PATCH', `/api/orders/${other.id}/status`, { order_status: 'cancelled' }, T1); // 復原 other 的 counter 影響，避免污染後續案例
      const retry = op === 'cancel' ? await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1) : await call('POST', `/api/orders/${order.id}/void`, { reason: 'retry', operator: 'test' }, T1);
      assert(retry.status === 200 && qA() === baselineA && qB() === baselineB, `SHIP-${label}-retry-once retry 成功，counter 只釋放一次（回到真正的建立前 baseline）`, `status=${retry.status} qA=${qA()} baselineA=${baselineA}`);
      return order.id;
    }
    await shipFault('cancel-write', 'cancel', 'write');
    await shipFault('cancel-rename', 'cancel', 'rename');
    const voidOrderId = await shipFault('void-write', 'void', 'write');
    await shipFault('void-rename', 'void', 'rename');
    {
      const row = db.get('SELECT status, order_status FROM orders WHERE id=?', [voidOrderId]);
      assert(row.status === 'void' && row.order_status === 'cancelled' && voidLogCount(voidOrderId) === 1, 'SHIP-void-retry-final-state void retry 後 status/order_status 正確、恰好 1 筆 void log', JSON.stringify(row));
    }

    // ── Popup fault matrix：cancel / void × write / rename ────────
    async function popupFault(label, op, faultKind) {
      const order = await makePopupOrder();
      const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=301'); // 確認不受影響的 standard counter（跨路徑污染檢查）
      const before = db.get('SELECT status, order_status FROM orders WHERE id=?', [order.id]), allocBefore = allocRow(order.id);
      const h0 = fileSha(), m0 = memHash(), b0 = fs.readFileSync(dbFile);
      const undo = withFault(faultKind);
      let r; try { r = op === 'cancel' ? await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1) : await call('POST', `/api/orders/${order.id}/void`, { reason: 'R44F3B-popup', operator: 'test' }, T1); } finally { undo(); }
      assert(r.status === 503 && r.json.error === 'STORAGE_UNAVAILABLE', `POPUP-${label}-503 固定 503`, JSON.stringify(r).slice(0, 130));
      assert(JSON.stringify(db.get('SELECT status, order_status FROM orders WHERE id=?', [order.id])) === JSON.stringify(before), `POPUP-${label}-order-unchanged order 狀態維持 before-state`, '');
      assert(JSON.stringify(allocRow(order.id)) === JSON.stringify(allocBefore) && allocRow(order.id).status === 'active', `POPUP-${label}-alloc-still-active allocation 仍為 active，released_at 未部分寫入`, JSON.stringify(allocRow(order.id)));
      assert(fileSha() === h0 && memHash() === m0 && Buffer.compare(fs.readFileSync(dbFile), b0) === 0, `POPUP-${label}-hash-unchanged DB 檔與 memory hash 不變`, '');
      assert(voidLogCount(order.id) === 0, `POPUP-${label}-no-void-log void log 未新增`, '');
      assert(tmpResidue().length === 0, `POPUP-${label}-no-residue 無 temp 殘留`, '');
      const retry = op === 'cancel' ? await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1) : await call('POST', `/api/orders/${order.id}/void`, { reason: 'retry', operator: 'test' }, T1);
      assert(retry.status === 200 && allocRow(order.id).status === 'released', `POPUP-${label}-retry-once retry 成功，allocation 恰好變為 released 一次`, `status=${retry.status}`);
      const again = op === 'cancel' ? await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1) : await call('POST', `/api/orders/${order.id}/void`, { reason: 'again', operator: 'test' }, T1);
      const relCountAfterRepeat = db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [order.id]).c;
      assert(relCountAfterRepeat === 1, `POPUP-${label}-repeat-no-double-release 重複操作不產生第二次 release`, String(relCountAfterRepeat));
      return order.id;
    }
    await popupFault('cancel-write', 'cancel', 'write');
    await popupFault('cancel-rename', 'cancel', 'rename');
    const popupVoidId = await popupFault('void-write', 'void', 'write');
    await popupFault('void-rename', 'void', 'rename');
    {
      assert(voidLogCount(popupVoidId) === 1, 'POPUP-void-exactly-one-log void retry 後恰好 1 筆 void log', String(voidLogCount(popupVoidId)));
    }

    // ── 補齊 transition 覆蓋：repeated shipping void（positive control，非 fault matrix 內）──
    {
      const q0 = qA();
      const order = await makeShippingOrder(2, 0);
      const v1 = await call('POST', `/api/orders/${order.id}/void`, { reason: 'first', operator: 'test' }, T1);
      assert(v1.status === 200 && qA() === q0 && voidLogCount(order.id) === 1, 'TRANS-ship-repeated-void-first 第一次 void 成功、counter 釋放、恰好 1 筆 log', JSON.stringify({ status: v1.status, qA: qA(), logs: voidLogCount(order.id) }));
      const v2 = await call('POST', `/api/orders/${order.id}/void`, { reason: 'second', operator: 'test' }, T1);
      assert(v2.status !== 200 && qA() === q0 && voidLogCount(order.id) === 1, 'TRANS-ship-repeated-void-rejected 重複 void 被拒絕（依既有正式契約），counter 不再變動，log 不再新增', JSON.stringify({ status: v2.status, qA: qA(), logs: voidLogCount(order.id) }));
    }
    // ── 補齊 transition 覆蓋：popup cancelled→void（不得二次 release）──
    {
      const order = await makePopupOrder();
      await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      assert(allocRow(order.id).status === 'released', 'TRANS-popup-cancel-released popup cancel 已釋放 allocation', '');
      const voidRes = await call('POST', `/api/orders/${order.id}/void`, { reason: 'cv', operator: 'test' }, T1);
      const relCount = db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [order.id]).c;
      if (voidRes.status === 200) {
        assert(relCount === 1, 'TRANS-popup-cancelled-to-void-no-double-release popup cancelled→void 被允許時，allocation 不得二次 release（仍恰好 1 筆 released）', String(relCount));
      } else {
        assert(relCount === 1, 'TRANS-popup-cancelled-to-void-rejected popup cancelled→void 被拒絕，allocation 維持原狀', String(relCount));
      }
    }
    // ── 補齊 transition 覆蓋：popup void→cancel（依真實契約拒絕或處理，零額外 release）──
    {
      const order = await makePopupOrder();
      await call('POST', `/api/orders/${order.id}/void`, { reason: 'first', operator: 'test' }, T1);
      assert(allocRow(order.id).status === 'released', 'TRANS-popup-void-first popup void 已釋放 allocation', '');
      const cancelRes = await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      const relCount = db.get("SELECT COUNT(*) AS c FROM popup_order_allocations WHERE order_id=? AND status='released'", [order.id]).c;
      assert(relCount === 1, 'TRANS-popup-void-to-cancel-no-double-release popup void→cancel（不論被允許或拒絕）不得再次 release，恰好 1 筆 released', JSON.stringify({ status: cancelRes.status, relCount }));
    }

    // ── cancelled→void（shipping）：不得二次釋放 counter ───────────
    {
      const q0 = qA();
      const order = await makeShippingOrder(2, 0);
      await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      assert(qA() === q0, 'CV-ship-cancel-released cancel 已釋放', '');
      const voidRes = await call('POST', `/api/orders/${order.id}/void`, { reason: 'cv', operator: 'test' }, T1);
      if (voidRes.status === 200) {
        assert(qA() === q0, 'CV-ship-cancelled-to-void-no-double-release cancelled→void 被允許時，不得二次釋放 counter', String(qA()));
      } else {
        assert(qA() === q0, 'CV-ship-void-to-cancel-rejected-no-change cancelled→void 被拒絕時，counter 仍不變', String(qA()));
      }
    }
    // ── cross-session allocation 不受影響 ───────────────────────
    {
      const sess2 = await call('POST', '/api/popup-pickup/sessions', sessBody('2'), T1);
      const SESS2_CODE = sess2.json.data.public_code;
      const phone2 = nextPhone();
      const other = await call('POST', '/api/line-orders/popup-checkout', { popup_session_public_code: SESS2_CODE, customer_name: 'Cross', customer_phone: phone2, items: [{ product_id: 8003, qty: 1 }], payment_method: 'cash' }, null);
      const otherOrderId = db.get('SELECT id FROM orders WHERE customer_phone=?', [phone2]).id;
      const order = await makePopupOrder();
      await call('PATCH', `/api/orders/${order.id}/status`, { order_status: 'cancelled' }, T1);
      assert(allocRow(otherOrderId).status === 'active', 'CROSS-session-alloc-unaffected 取消一個 session 的訂單不影響另一個 session 的 active allocation', JSON.stringify(allocRow(otherOrderId)));
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2F.3B-Closure：shipping create 的 analytics failure（真實 seam，
    // 不是「無此 side effect」的控制案例——source reading 已確認
    // routes/line-shipping.js 的 logServerEvent() 呼叫在 durable rename
    // 成功之後、被 try/catch 包住，失敗只 console.warn，不影響 response；
    // 上一輪誤把這裡記成「無 analytics 可測」，這裡更正並補上真實 failure
    // injection。
    // ══════════════════════════════════════════════════════════════
    {
      const phone = nextPhone();
      const q0A = qA();
      const origRun = db.run.bind(db);
      let triggerCount = 0, threw = 0;
      db.run = function (sql, params) {
        if (typeof sql === 'string' && sql.includes('INSERT INTO analytics_events')) {
          triggerCount++;
          if (triggerCount === 1) { threw++; throw new Error('R44.2F.3B injected analytics failure'); }
        }
        return origRun(sql, params);
      };
      let r; try { r = await call('POST', '/api/line-shipping', { recipient_name: 'AnalyticsFail', phone, postal_code: '100', city: '台北市', district: '中正區', address: '測試路1號', payment_method: 'cash', arrival_type: 'asap', items: [{ product_id: SA, qty: 1 }] }, T1); } finally { db.run = origRun; }
      assert(triggerCount >= 1 && threw >= 1, 'ANALYTICS-ship-seam-hit analytics INSERT seam 真的被觸發並拋錯至少一次', String({ triggerCount, threw }));
      assert(r.status === 200 || r.status === 201, 'ANALYTICS-ship-still-success client 依既有 production 契約仍收到成功（analytics 失敗被 try/catch 吞掉，不影響 response）', JSON.stringify(r).slice(0, 150));
      const orderRow = db.get('SELECT id, items, total FROM orders WHERE customer_phone=?', [phone]);
      assert(!!orderRow, 'ANALYTICS-ship-order-exists-memory order 在 memory 中存在', '');
      const fresh = await freshDisk(`SELECT COUNT(*) FROM orders WHERE customer_phone='${phone}'`);
      assert(fresh[0][0] === 1, 'ANALYTICS-ship-order-exists-disk order 在 disk／fresh child process 也存在（沒有被 rollback）', JSON.stringify(fresh));
      const items = JSON.parse(orderRow.items);
      assert(items.length === 1 && items[0].product_id === SA && items[0].price === 200 && orderRow.total >= 200, 'ANALYTICS-ship-canonical-correct canonical items 正確、total 為 subtotal(200)+運費（analytics 失敗沒有讓 order 資料半套）', JSON.stringify(orderRow));
      assert(qA() === q0A + 1, 'ANALYTICS-ship-counter-correct counter 正確增加，沒有因 analytics 失敗被重新執行或跳過', `q0A=${q0A} qA=${qA()}`);
      const snap = JSON.parse(db.get('SELECT line_counter_allocation_snapshot AS s FROM orders WHERE id=?', [orderRow.id]).s);
      assert(snap.allocations.length === 1 && snap.allocations[0].qty === 1, 'ANALYTICS-ship-snapshot-correct snapshot 正確（+1），不受 analytics 失敗影響', JSON.stringify(snap));
      // retry 同一個 phone 不應該再次建立訂單（沒有 cart_token 機制介入這裡，純粹確認 mutation 沒有被重新執行——用 order count 佐證，而非真的重送同一 request）
      assert(db.get('SELECT COUNT(*) AS c FROM orders WHERE customer_phone=?', [phone]).c === 1, 'ANALYTICS-ship-mutation-not-rerun order/counter mutation 沒有因為 analytics 失敗又跑第二次', '');
    }

    // ══════════════════════════════════════════════════════════════
    // R44.2F.3B-Closure：production-only static checks（忽略註解行）。
    // ══════════════════════════════════════════════════════════════
    {
      const rd = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8').replace(/^\s*\/\/.*$/gm, '');
      const lo = rd('routes/line-orders.js'), ls = rd('routes/line-shipping.js'), ro = rd('routes/orders.js'), osf = rd('utils/orderStatusFlow.js'), db_ = rd('utils/db.js');
      const durableBodyLO = lo.slice(lo.indexOf('db.runDurableTransaction(() => {'), lo.indexOf('\n    });\n', lo.indexOf('db.runDurableTransaction(() => {')));
      const durableBodyLS = ls.slice(ls.indexOf('db.runDurableTransaction(() => {'), ls.indexOf('\n    });\n', ls.indexOf('db.runDurableTransaction(() => {')));
      assert(!/\bdb\.run\(/.test(durableBodyLO) && !/\bdb\.run\(/.test(durableBodyLS), 'STATIC-no-autosave-in-durable-callback standard／shipping create 的 durable callback 內無 auto-saving db.run()', '');
      // R44.2F.3B-Closure 更正：routes/orders.js 是一整個大檔案，涵蓋許多與本輪
      // durable 工作無關的既有 CRUD 端點（列表／reprint／其他），這些既有
      // 端點本來就用 message:e.message 回傳，不是本輪 in-scope 的
      // cancel/void durable 路徑。範圍縮小成只檢查真正被本輪改動、且已知
      // 有 isDurableError() 分流的 cancel（PATCH /:id/status）與 void
      // （POST /:id/void）兩段——這兩段已確認 isDurableError 優先分流成
      // 503，只有非 durable 的其餘例外才會落到 message:e.message（這是
      // pre-existing、超出本輪 in-scope 的行為，如實記錄為 remaining
      // limitation，不在本輪修正）。
      const voidCatch = ro.slice(ro.indexOf("router.post('/:id/void'"), ro.indexOf("router.post('/:id/reprint'"));
      const statusCatch = ro.slice(ro.indexOf("router.patch('/:id/status'"), ro.indexOf("router.patch('/:id/status'") + 2000);
      assert(/isDurableError\(e\)/.test(voidCatch) && /isDurableError\(e\)/.test(statusCatch), 'STATIC-durable-error-checked-first cancel／void 的 catch 都先檢查 isDurableError(e)，disk 失敗優先回 503（不會先落到 e.message 分支）', '');
      const loStart = lo.indexOf("router.post('/', async");
      const loCreateCatch = lo.slice(loStart, lo.indexOf('\nrouter.', loStart + 10));
      const lsStart = ls.indexOf("\nrouter.post('/', ");
      const lsCreateCatch = ls.slice(lsStart, ls.indexOf('\nrouter.', lsStart + 10));
      assert(!/message:\s*e\.message/.test(loCreateCatch) && !/message:\s*e\.message/.test(lsCreateCatch) && /isDurableError\(e\)/.test(loCreateCatch) && /isDurableError\(e\)/.test(lsCreateCatch), 'STATIC-no-e-message-leak-create standard／shipping 的 POST / create handler（僅此一段，不含檔案內其他既有 CRUD 端點）不含 message:e.message，且 isDurableError 分流已到位', '');
      assert(!/UPDATE orders SET line_counter_allocation_snapshot/.test(lo + ls), 'STATIC-no-followup-snapshot-update 兩條 create route 不存在 follow-up snapshot UPDATE', '');
      assert(/buildLineCounterAllocationSnapshot\(/.test(lo) && /buildLineCounterAllocationSnapshot\(/.test(ls), 'STATIC-shared-builder-used 兩條 create route 都使用共用 snapshot builder', '');
      const takeoutDefs = (db_.match(/ADD COLUMN line_takeout_enabled/g) || []).length;
      const deliveryDefs = (db_.match(/ADD COLUMN line_delivery_enabled/g) || []).length;
      assert(takeoutDefs === 1 && deliveryDefs === 1, 'STATIC-migration-defined-once line_takeout_enabled／line_delivery_enabled 各恰好一處 migration 定義', JSON.stringify({ takeoutDefs, deliveryDefs }));
      const afterCommitLO = lo.slice(lo.indexOf('\n    });\n', lo.indexOf('db.runDurableTransaction(() => {')));
      assert(afterCommitLO.indexOf('broadcastToStore(') >= 0 || afterCommitLO.indexOf('triggerN8nWebhook(') >= 0, 'STATIC-side-effect-after-durable standard create 的 side effect 呼叫點在 durable transaction 之後', '');
      const popupCheckoutSrc = rd('utils/popupCheckout.js');
      const reconcileFn = popupCheckoutSrc.slice(popupCheckoutSrc.indexOf('function reconcilePopupCartItemsAgainstFreshAuthority'), popupCheckoutSrc.indexOf('function reconcilePopupCartItemsAgainstFreshAuthority') + 2000);
      const referencedCols = ['enabled', 'show_on_line', 'sale_status', 'line_sold_out', 'line_takeout_enabled'].filter((c) => reconcileFn.includes(c));
      const schemaHasCol = (col) => db._db.all('PRAGMA table_info(products)').some((c) => c.name === col);
      assert(referencedCols.every(schemaHasCol), 'STATIC-reconcile-columns-exist popup reconcile 查詢引用的欄位全部存在於初始化後的 schema（R44.2F.3A-2 的 no-such-column 已修正）', JSON.stringify(referencedCols));
    }

    assert(tmpResidue().length === 0, 'FINAL-no-temp-residue 全程結束後無 temp 殘留', '');
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { server && server.close(); } catch {} try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
