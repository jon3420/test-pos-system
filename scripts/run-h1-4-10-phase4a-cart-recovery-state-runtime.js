#!/usr/bin/env node
// scripts/run-h1-4-10-phase4a-cart-recovery-state-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-CRM (Phase 4A)
// CART RECOVERY STATE ENGINE
//
// 真正使用：temporary DB + 真正 utils/db.js migration + 真正
// utils/cartRecovery.js + 真正 utils/analyticsLog.js + 真實 HTTP
// routes/analytics.js（不複製一套假的 Recovery 狀態機進 test）。

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase4a-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';
  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const cartRecovery = require('../utils/cartRecovery');
  const { logServerEvent } = require('../utils/analyticsLog');

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta', 'Store Beta', 'x', 'pro', 1]);
  function enable(storeId) { setSetting(storeId, 'cart_recovery_enabled', '1'); }
  function getJobs(storeId, where, params) {
    return db.all(`SELECT * FROM cart_recovery_jobs WHERE store_id=? ${where ? 'AND ' + where : ''} ORDER BY id ASC`, [storeId, ...(params || [])]);
  }
  function getActiveJobs(storeId, stage, cartOrOrder) {
    const key = cartOrOrder.cartId ? 'cart_id' : 'order_id';
    const val = cartOrOrder.cartId || cartOrOrder.orderId;
    return getJobs(storeId, `stage=? AND ${key}=? AND status IN ('pending','waiting')`, [stage, val]);
  }
  let ctr = 0;
  function uniqIds(prefix) { ctr += 1; return { visitorId: `${prefix}-v${ctr}`, sessionId: `${prefix}-s${ctr}`, cartId: `${prefix}-cart${ctr}` }; }

  try {
    console.log('\n== 一、DB Migration ==');
    {
      const cols = db.all(`PRAGMA table_info(cart_recovery_jobs)`).map((c) => c.name);
      const required = ['id', 'store_id', 'cart_id', 'visitor_id', 'session_id', 'order_id', 'line_user_id',
        'stage', 'status', 'trigger_event', 'last_event', 'due_at', 'last_event_at', 'attempt_count',
        'max_attempts', 'channel', 'idempotency_key', 'created_at', 'updated_at', 'sent_at', 'converted_at',
        'cancelled_at', 'cancel_reason'];
      const missing = required.filter((c) => !cols.includes(c));
      assert(missing.length === 0, 'cart_recovery_jobs 欄位齊全（含 channel／sent_at 等 Phase 4B 預留欄位）', `missing: ${missing.join(',')}`);

      const idxList = db.all(`PRAGMA index_list(cart_recovery_jobs)`);
      const idxNames = idxList.map((i) => i.name);
      ['idx_cart_recovery_store', 'idx_cart_recovery_cart', 'idx_cart_recovery_order', 'idx_cart_recovery_due',
        'idx_cart_recovery_status', 'idx_cart_recovery_stage', 'idx_cart_recovery_idempotency'].forEach((idx) => {
        assert(idxNames.includes(idx), `Index ${idx} 存在`);
      });

      const dbSrc = fs.readFileSync(path.join(ROOT, 'utils/db.js'), 'utf8');
      assert(dbSrc.includes('CREATE TABLE IF NOT EXISTS cart_recovery_jobs'), 'utils/db.js 使用 CREATE TABLE IF NOT EXISTS');
      assert(!/DROP TABLE[^\n]*cart_recovery_jobs/i.test(dbSrc), '未 DROP cart_recovery_jobs 或任何既有資料表');
    }

    console.log('\n== 二、Settings Defaults ==');
    {
      const storeId = 'store_default_check';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Default Check', 'x', 'pro', 1]);
      assert(cartRecovery.isRecoveryEnabled(db, storeId) === false, 'cart_recovery_enabled 預設 = 0（未設定視為關閉）');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned') === 60, 'cart_recovery_cart_delay_minutes 預設 = 60');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'checkout_abandoned') === 30, 'cart_recovery_checkout_delay_minutes 預設 = 30');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'payment_abandoned') === 15, 'cart_recovery_payment_delay_minutes 預設 = 15');
      assert(cartRecovery.getMaxAttempts(db, storeId) === 1, 'cart_recovery_max_attempts 預設 = 1');

      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: 'cart-disabled', event_name: 'add_to_cart', product_id: 1 });
      const disabledJobs = getJobs(storeId, 'cart_id=?', ['cart-disabled']);
      assert(disabledJobs.length === 0, 'enabled=0 → add_to_cart 不建立 job');

      enable(storeId);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v2', session_id: 's2', cart_id: 'cart-enabled', event_name: 'add_to_cart', product_id: 1 });
      const enabledJobs = getJobs(storeId, 'cart_id=?', ['cart-enabled']);
      assert(enabledJobs.length === 1, 'enabled=1 → add_to_cart 正常建立 job');
    }

    console.log('\n== 三、Cart Stage ==');
    {
      const storeId = 'store_001'; enable(storeId);
      const { visitorId, sessionId, cartId } = uniqIds('c1');
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      const jobs = getActiveJobs(storeId, 'cart_abandoned', { cartId });
      assert(jobs.length === 1, 'C1 add_to_cart → 建立 1 個 cart_abandoned job');
      assert(['pending', 'waiting'].includes(jobs[0].status), 'C1 job status 為 pending/waiting', jobs[0].status);
      const dueAtMs = Date.parse(jobs[0].due_at.replace(' ', 'T') + 'Z');
      const expectMs = Date.now() + 60 * 60000;
      assert(Math.abs(dueAtMs - expectMs) < 5000, 'C1 due_at ≈ event time + 60 分鐘（誤差 <5 秒）', `due_at=${jobs[0].due_at}`);
    }
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('c2');
      let firstDueAt;
      for (let i = 0; i < 5; i++) {
        logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
        if (i === 0) firstDueAt = getActiveJobs(storeId, 'cart_abandoned', { cartId })[0].due_at;
      }
      const jobs = getActiveJobs(storeId, 'cart_abandoned', { cartId });
      assert(jobs.length === 1, 'C2 同 cart add_to_cart×5 → 有效 job 仍只有 1', `found ${jobs.length}`);
      assert(jobs[0].due_at >= firstDueAt, 'C3 第二次以後活動 → due_at 刷新到最新活動 + delay');
    }
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('c4');
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      const cartJobs = getJobs(storeId, `stage='cart_abandoned' AND cart_id=?`, [cartId]);
      assert(cartJobs.length === 1 && cartJobs[0].status === 'cancelled', 'C4 checkout_click → cart_abandoned cancelled');
      const checkoutJobs = getActiveJobs(storeId, 'checkout_abandoned', { cartId });
      assert(checkoutJobs.length === 1, 'C4 checkout_click → 建立 checkout_abandoned');
    }

    console.log('\n== 四、Checkout Stage ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('checkout');
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      const initial = getActiveJobs(storeId, 'checkout_abandoned', { cartId });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_submit_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_validation_failed' });
      const after = getActiveJobs(storeId, 'checkout_abandoned', { cartId });
      assert(after.length === 1, '同 cart checkout_click／checkout_submit_click／checkout_validation_failed 最後仍只有 1 個有效 checkout job', `found ${after.length}`);
      assert(after[0].id === initial[0].id, 'checkout_submit_click／checkout_validation_failed 更新的是同一筆 job（未新建）');
      assert(after[0].last_event === 'checkout_validation_failed', 'last_event 正確更新為最新活動（refresh 生效）');
    }

    console.log('\n== 五、submit_order Cancellation Semantics ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('submit');
      const orderId = `order-${cartId}`;
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      const cartJobs = getJobs(storeId, `stage='cart_abandoned' AND cart_id=?`, [cartId]);
      const checkoutJobs = getJobs(storeId, `stage='checkout_abandoned' AND cart_id=?`, [cartId]);
      assert(cartJobs.every((j) => j.status === 'cancelled'), 'submit_order → cart_abandoned 全數 cancelled');
      assert(checkoutJobs.every((j) => j.status === 'cancelled'), 'submit_order → checkout_abandoned 全數 cancelled');
    }

    console.log('\n== 六、LINE Pay 真實順序（submit_order 先於 payment_started）==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('linepay-order');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_submit_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      const paymentJobs = getActiveJobs(storeId, 'payment_abandoned', { orderId });
      assert(paymentJobs.length === 1, '(star) submit_order 已存在，payment_started 仍能建立 payment_abandoned（核心規則）', `found ${paymentJobs.length}`);
    }

    console.log('\n== 七、payment_started metadata Integration（真實 HTTP）==');
    await runPaymentMethodIntegrationTests(db);

    console.log('\n== 八、Payment Idempotency ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('payidem');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      for (let i = 0; i < 3; i++) {
        logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      }
      const jobs = getActiveJobs(storeId, 'payment_abandoned', { orderId });
      assert(jobs.length === 1, 'payment_started(linepay) x3（同 cart，經 cart->submit_order 解析出同一 order）-> 有效 payment job 仍只有 1');
    }

    console.log('\n== 九、Payment Conversion ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('p1');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, order_id: orderId, event_name: 'payment_success', metadata: { value: 100 } });
      const jobs = getJobs(storeId, `stage='payment_abandoned' AND order_id=?`, [orderId]);
      assert(jobs.length === 1 && jobs[0].status === 'converted', 'P1 payment_success -> payment job converted');
      const recoverable = cartRecovery.getRecoverableJobs(db, storeId, { stage: 'payment_abandoned' });
      assert(!recoverable.some((j) => j.order_id === orderId), 'P1 converted 後 current recoverable 查不到');
    }
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('p2');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'purchase' });
      const jobs = getJobs(storeId, `stage='payment_abandoned' AND order_id=?`, [orderId]);
      assert(jobs.length === 1 && jobs[0].status === 'converted', 'P2 purchase -> payment job converted');
    }
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('p3');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`,
        [cartRecovery._nowIso(), storeId, orderId]);
      const recoverable = cartRecovery.getRecoverableJobs(db, storeId, { stage: 'payment_abandoned' });
      assert(recoverable.some((j) => j.order_id === orderId), 'P3 LINE Pay 放棄（無 payment_success/purchase）-> 仍 current recoverable');
    }

    console.log('\n== 十、Full Convergence ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('converge');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, order_id: orderId, event_name: 'payment_success', metadata: { value: 1 } });
      const allJobs = getJobs(storeId, `cart_id=? OR order_id=?`, [cartId, orderId]);
      assert(allJobs.length >= 3, '同 cart/order 下 cart/checkout/payment 三個 stage 都有對應 job 記錄', `found ${allJobs.length}`);
      assert(allJobs.every((j) => j.status === 'cancelled' || j.status === 'converted'), '收到 purchase/payment_success 後，沒有任何 job 仍是 pending/waiting', JSON.stringify(allJobs.map((j) => `${j.stage}:${j.status}`)));
    }

    console.log('\n== 十一、Empty Cart 不誤取消 payment_abandoned ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('emptycart');
      const orderId = `order-${cartId}`;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay']);
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
      const cartJobs = getJobs(storeId, `stage='cart_abandoned' AND cart_id=?`, [cartId]);
      const checkoutJobs = getJobs(storeId, `stage='checkout_abandoned' AND cart_id=?`, [cartId]);
      assert(cartJobs.every((j) => j.status === 'cancelled') && checkoutJobs.every((j) => j.status === 'cancelled'), 'cart_abandoned/checkout_abandoned 已因 submit_order cancelled（等價於購物車清空情境）');
      const paymentJobs = getActiveJobs(storeId, 'payment_abandoned', { orderId });
      assert(paymentJobs.length === 1, '已建立的 payment_abandoned 不因（等價）購物車清空被誤取消，仍 pending', `found ${paymentJobs.length}`);
    }

    console.log('\n== 十二、Anonymous Cart ==');
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('anon');
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'checkout_click' });
      const jobs = getActiveJobs(storeId, 'checkout_abandoned', { cartId });
      assert(jobs.length === 1, '匿名顧客（無 line_user_id）可正常建立 cart_abandoned/checkout_abandoned');
      assert(!jobs[0].line_user_id, 'line_user_id 為空（NULL/空字串），不因匿名判定不可 recovery');
    }

    console.log('\n== 十三、Trusted LINE Identity ==');
    await runRawLineUidTest(db);

    console.log('\n== 十四、Store Isolation ==');
    {
      const cartId = 'shared-cart-id-across-stores';
      enable('store_beta');
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'vA', session_id: 'sA', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      logServerEvent(db, { store_id: 'store_beta', visitor_id: 'vB', session_id: 'sB', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      const jobsA = getActiveJobs('store_001', 'cart_abandoned', { cartId });
      const jobsB = getActiveJobs('store_beta', 'cart_abandoned', { cartId });
      assert(jobsA.length === 1 && jobsB.length === 1 && jobsA[0].id !== jobsB[0].id, 'store A/store B 各自獨立建立不同的 job（同一 cart_id 字串不互相干擾）');
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'vA', session_id: 'sA', cart_id: cartId, event_name: 'checkout_click' });
      const jobsBAfter = getActiveJobs('store_beta', 'cart_abandoned', { cartId });
      assert(jobsBAfter.length === 1, 'store A 的 checkout_click 不 cancel/convert/refresh store B 的 job');
    }

    console.log('\n== 十五、Idempotency ==');
    {
      const { cartId } = uniqIds('idem');
      assert(cartRecovery._idempotencyKey('cart_abandoned', { cartId }) === `cart:${cartId}:cart_abandoned`, 'cart stage idempotency key = cart:{cart_id}:{stage}');
      assert(cartRecovery._idempotencyKey('payment_abandoned', { cartId, orderId: 'order-x' }) === 'order:order-x:payment_abandoned', 'payment stage 有 order_id 時優先用 order:{order_id}:{stage}');
      assert(cartRecovery._idempotencyKey('payment_abandoned', { cartId: '', orderId: '' }) === null, '無 cart_id 也無 order_id -> null（安全跳過，不建立來路不明 job）');
    }

    console.log('\n== 十六、Delay Settings Override ==');
    {
      const storeId = 'store_custom_delay';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Custom Delay', 'x', 'pro', 1]);
      assert(cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned') === 60, '改設定前：cart delay 仍為預設 60');
      setSetting(storeId, 'cart_recovery_cart_delay_minutes', '90');
      setSetting(storeId, 'cart_recovery_checkout_delay_minutes', '45');
      setSetting(storeId, 'cart_recovery_payment_delay_minutes', '20');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'cart_abandoned') === 90, '改設定後：cart delay=90 生效（非 hardcode）');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'checkout_abandoned') === 45, '改設定後：checkout delay=45 生效');
      assert(cartRecovery.getDelayMinutes(db, storeId, 'payment_abandoned') === 20, '改設定後：payment delay=20 生效');

      enable(storeId);
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: 'cart-override', event_name: 'add_to_cart', product_id: 1 });
      const job = getActiveJobs(storeId, 'cart_abandoned', { cartId: 'cart-override' })[0];
      const dueAtMs = Date.parse(job.due_at.replace(' ', 'T') + 'Z');
      const expectMs = Date.now() + 90 * 60000;
      assert(Math.abs(dueAtMs - expectMs) < 5000, '新建立的 job 使用新設定值（due_at ~= +90 分鐘）', `due_at=${job.due_at}`);
    }

    console.log('\n== 十七、getRecoverableJobs() ==');
    {
      const storeId = 'store_001';
      const { cartId } = uniqIds('recoverable');
      const now = cartRecovery._nowIso();
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-pending', 'cart_abandoned', 'pending', now, `cart:${cartId}-pending:cart_abandoned`, now, now]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-converted', 'cart_abandoned', 'converted', now, `cart:${cartId}-converted:cart_abandoned`, now, now]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-cancelled', 'cart_abandoned', 'cancelled', now, `cart:${cartId}-cancelled:cart_abandoned`, now, now]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-notconfigured', 'cart_abandoned', 'not_configured', now, `cart:${cartId}-notconfigured:cart_abandoned`, now, now]);
      const recoverable = cartRecovery.getRecoverableJobs(db, storeId, { stage: 'cart_abandoned' });
      assert(recoverable.some((j) => j.cart_id === cartId + '-pending'), 'pending job 出現在 current recoverable');
      assert(!recoverable.some((j) => j.cart_id === cartId + '-converted'), 'converted job 不出現');
      assert(!recoverable.some((j) => j.cart_id === cartId + '-cancelled'), 'cancelled job 不出現');
      assert(!recoverable.some((j) => j.cart_id === cartId + '-notconfigured'), 'not_configured（Phase 4A 未使用的狀態）不誤算 current recoverable');
    }

    console.log('\n== 十八、24h Horizon ==');
    {
      const storeId = 'store_001';
      const { cartId } = uniqIds('horizon');
      const now = cartRecovery._nowIso();
      const farPast = new Date(Date.now() - 48 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-near', 'cart_abandoned', 'pending', now, `cart:${cartId}-near:cart_abandoned`, now, now]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at)
        VALUES (?,?,?,?,?,?,?,?)`, [storeId, cartId + '-far', 'cart_abandoned', 'pending', farPast, `cart:${cartId}-far:cart_abandoned`, farPast, farPast]);
      const recoverable = cartRecovery.getRecoverableJobs(db, storeId, { stage: 'cart_abandoned' });
      assert(recoverable.some((j) => j.cart_id === cartId + '-near'), '24h 內到期的 pending job 算 current recoverable');
      assert(!recoverable.some((j) => j.cart_id === cartId + '-far'), '超過 24h 的舊 job 不算 current recoverable（視為歷史分析）');
      const stillExists = db.get(`SELECT id FROM cart_recovery_jobs WHERE store_id=? AND cart_id=?`, [storeId, cartId + '-far']);
      assert(!!stillExists, '超過 24h 的舊 job 資料列本身沒有被刪除（歷史資料保留）');
    }

    console.log('\n== 十九、Recovery Amount ==');
    {
      const storeId = 'store_001';
      const { cartId } = uniqIds('amount');
      const orderId = `order-${cartId}`;
      cartRecovery.schedulePaymentRecovery(db, storeId, { cartId, orderId, triggerEvent: 'payment_started', lastEvent: 'payment_started', recoverableValue: 1234 });
      const job = getActiveJobs(storeId, 'payment_abandoned', { orderId })[0];
      assert(Number(job.recoverable_value) === 1234, 'payment stage：recoverableValue 由呼叫端傳入（模擬 DB order.total）正確存入，非猜測');
    }
    {
      const storeId = 'store_001';
      const { visitorId, sessionId, cartId } = uniqIds('noamount');
      logServerEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: sessionId, cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      const job = getActiveJobs(storeId, 'cart_abandoned', { cartId })[0];
      assert(job.recoverable_value === null || job.recoverable_value === undefined, 'cart stage 沒有 authoritative snapshot 來源時，recoverable_value 保持 NULL（不假造）', JSON.stringify(job.recoverable_value));
    }

    console.log('\n== 二十、Fail-open ==');
    {
      const storeId = 'store_001';
      const badDb = {
        run() { throw new Error('simulated cart_recovery_jobs failure'); },
        get() { throw new Error('simulated cart_recovery_jobs failure'); },
        all() { throw new Error('simulated cart_recovery_jobs failure'); },
      };
      let threw = false;
      try { cartRecovery.onAnalyticsEvent(badDb, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: 'cart-fail', event_name: 'add_to_cart' }); } catch (e) { threw = true; }
      assert(threw === false, 'Recovery DB 操作全部 throw 時，onAnalyticsEvent() 本身不拋出（fail-open）');

      const { logServerEvent: logServerEvent2 } = require('../utils/analyticsLog');
      const cartRecoveryModule = require('../utils/cartRecovery');
      const originalOnAnalyticsEvent = cartRecoveryModule.onAnalyticsEvent;
      cartRecoveryModule.onAnalyticsEvent = () => { throw new Error('simulated onAnalyticsEvent crash'); };
      let mainFlowOk = true;
      let insertOk = false;
      try {
        insertOk = logServerEvent2(db, { store_id: storeId, visitor_id: 'v-failopen', session_id: 's-failopen', cart_id: 'cart-failopen', event_name: 'add_to_cart', product_id: 1 });
      } catch (e) { mainFlowOk = false; }
      cartRecoveryModule.onAnalyticsEvent = originalOnAnalyticsEvent;
      assert(mainFlowOk === true, 'Recovery hook 本身拋出例外時，logServerEvent() 呼叫端不會被拋出的例外中斷');
      assert(insertOk === true, 'Recovery hook 失敗不影響 analytics_events 主事件本身成功寫入', `insertOk=${insertOk}`);
      const mainEventRow = db.get(`SELECT id FROM analytics_events WHERE store_id=? AND cart_id=? AND event_name='add_to_cart'`, [storeId, 'cart-failopen']);
      assert(!!mainEventRow, 'analytics_events 主表確實有這筆 add_to_cart（Recovery 失敗沒有讓事件主流程失敗）');
    }

    console.log('\n== 二十一、payment_success Security Regression ==');
    await runClientForgeryTest(db);

    console.log('\n== 二十二、Canonical Mapping 靜態檢查 ==');
    {
      const analyticsPlatformsJs = fs.readFileSync(path.join(ROOT, 'public/js/analytics-platforms.js'), 'utf8');
      const ga4MapMatch = analyticsPlatformsJs.match(/const GA4_EVENT_MAP = \{[\s\S]*?\};/);
      const metaMapMatch = analyticsPlatformsJs.match(/const META_EVENT_MAP = \{[\s\S]*?\};/);
      assert(ga4MapMatch[0].includes("checkout_click: 'begin_checkout'"), 'checkout_click -> GA4 begin_checkout 映射契約未變');
      assert(metaMapMatch[0].includes("checkout_click: 'InitiateCheckout'"), 'checkout_click -> Meta InitiateCheckout 映射契約未變');
      const cartRecoverySrc = fs.readFileSync(path.join(ROOT, 'utils/cartRecovery.js'), 'utf8');
      assert(!cartRecoverySrc.includes('trackPlatformEvent') && !cartRecoverySrc.includes('fbq(') && !cartRecoverySrc.includes('gtag('), 'utils/cartRecovery.js 完全不呼叫任何第三方 Analytics 平台函式（Recovery 只是 backend state）');
    }
  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }

  console.log('\n== Phase 4A Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

async function runPaymentMethodIntegrationTests(db) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/analytics', require('../routes/analytics'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function post(body) {
    const res = await fetch(`${base}/api/analytics/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }
  function makeAuthoritativeOrder(orderId, total) {
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`, [orderId, orderId, orderId, 'store_001', '[]', total, total, 'linepay']);
  }

  try {
    // ── LINE Pay 情境：先建立 server-authoritative submit_order + 真實 orders row ──
    const cartId = 'cart-int1';
    const realOrderId = 'order-integration-linepay';
    makeAuthoritativeOrder(realOrderId, 1234);
    const { logServerEvent } = require('../utils/analyticsLog');
    logServerEvent(db, { store_id: 'store_001', visitor_id: 'v-int1', session_id: 's-int1', cart_id: cartId, order_id: realOrderId, event_name: 'submit_order' });

    // client payment_started：故意夾帶假 order_id + 假 value/cart_value（皆不可信）
    const r1 = await post({
      visitor_id: 'v-int1', session_id: 's-int1', cart_id: cartId, event_name: 'payment_started',
      metadata: { payment_method: 'linepay', value: 1, cart_value: 999999 },
      order_id: 'FAKE-CLIENT-ORDER', // 需求：client order_id 絕對不可信
    });
    assert(r1.status === 200 && r1.json.success === true, 'payment_started(linepay) 真實 HTTP 呼叫成功（即使夾帶假 order_id 仍正常處理）');

    // Analytics 事件本身：用 cart_id 查（不是 order_id——client payment_started
    // 本來就不該有可信 order_id，這是既有、正確的 Analytics 語意，見 Reality Audit）。
    const analyticsRow = db.get(`SELECT metadata_json, order_id FROM analytics_events WHERE store_id='store_001' AND cart_id=? AND event_name='payment_started' ORDER BY id DESC LIMIT 1`, [cartId]);
    assert(!!analyticsRow, 'analytics_events 確實有這筆 payment_started（用 cart_id 查得到，而非 order_id）');
    if (analyticsRow) {
      const storedMeta = JSON.parse(analyticsRow.metadata_json || '{}');
      assert(storedMeta.payment_method === 'linepay', 'analytics_events metadata_json 內 payment_method 正確為 linepay（sanitizer 未誤刪）', JSON.stringify(storedMeta));
      assert(Object.keys(storedMeta).length === 1, 'payment_started metadata 白名單只允許 payment_method 一個欄位（value/cart_value 已被 sanitizer 濾除）', JSON.stringify(Object.keys(storedMeta)));
    }

    // Recovery job：必須是 cart→submit_order 解析出的「真」order_id，絕不是 client 夾帶的假值
    const jobs = db.all(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id=? AND stage='payment_abandoned' AND status IN ('pending','waiting')`, [cartId]);
    assert(jobs.length === 1, 'payment_method=linepay 經完整 HTTP pipeline -> payment_abandoned job 正確建立（cart->submit_order->orders 解析路徑）', `found ${jobs.length}`);
    if (jobs.length === 1) {
      assert(jobs[0].order_id === realOrderId, 'Recovery job.order_id 是 cart→submit_order 解析出的真實 order_id', `order_id=${jobs[0].order_id}`);
      assert(jobs[0].order_id !== 'FAKE-CLIENT-ORDER', 'Recovery job.order_id 絕不是 client 夾帶的偽造值 FAKE-CLIENT-ORDER');
      assert(jobs[0].cart_id === cartId, 'Recovery job.cart_id 正確');
      assert(Number(jobs[0].recoverable_value) === 1234, 'recoverable_value 來自 DB orders.total（=1234），不是 client 夾帶的 value=1／cart_value=999999', `recoverable_value=${jobs[0].recoverable_value}`);
    }

    // ── Cash：即使有 submit_order 存在，payment_method=cash 也不建立 payment job ──
    const cashCartId = 'cart-int2';
    const cashOrderId = 'order-integration-cash';
    makeAuthoritativeOrder(cashOrderId, 500);
    logServerEvent(db, { store_id: 'store_001', visitor_id: 'v-int2', session_id: 's-int2', cart_id: cashCartId, order_id: cashOrderId, event_name: 'submit_order' });
    const r2 = await post({ visitor_id: 'v-int2', session_id: 's-int2', cart_id: cashCartId, event_name: 'payment_started', metadata: { payment_method: 'cash' } });
    assert(r2.status === 200, 'payment_started(cash) 真實 HTTP 呼叫成功');
    const cashJobs = db.all(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id=? AND stage='payment_abandoned'`, [cashCartId]);
    assert(cashJobs.length === 0, 'payment_method=cash（即使有 submit_order 存在）→ 不建立 payment_abandoned job', `found ${cashJobs.length}`);

    // ── Transfer：同上 ──
    const transferCartId = 'cart-int3';
    const transferOrderId = 'order-integration-transfer';
    makeAuthoritativeOrder(transferOrderId, 500);
    logServerEvent(db, { store_id: 'store_001', visitor_id: 'v-int3', session_id: 's-int3', cart_id: transferCartId, order_id: transferOrderId, event_name: 'submit_order' });
    const r3 = await post({ visitor_id: 'v-int3', session_id: 's-int3', cart_id: transferCartId, event_name: 'payment_started', metadata: { payment_method: 'transfer' } });
    assert(r3.status === 200, 'payment_started(transfer) 真實 HTTP 呼叫成功');
    const transferJobs = db.all(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id=? AND stage='payment_abandoned'`, [transferCartId]);
    assert(transferJobs.length === 0, 'payment_method=transfer → 不建立 payment_abandoned job', `found ${transferJobs.length}`);

    // ── Store Isolation：store A/B 各自的 submit_order 不得互相解析 ──
    const sharedCartId = 'cart-int-shared-store-check';
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta_int', 'Store Beta Int', 'x', 'pro', 1]);
    const aOrderId = 'A-ORDER-INT';
    const bOrderId = 'B-ORDER-INT';
    makeAuthoritativeOrder(aOrderId, 111);
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`, [bOrderId, bOrderId, bOrderId, 'store_beta_int', '[]', 222, 222, 'linepay']);
    logServerEvent(db, { store_id: 'store_001', visitor_id: 'vA', session_id: 'sA', cart_id: sharedCartId, order_id: aOrderId, event_name: 'submit_order' });
    logServerEvent(db, { store_id: 'store_beta_int', visitor_id: 'vB', session_id: 'sB', cart_id: sharedCartId, order_id: bOrderId, event_name: 'submit_order' });
    const cartRecoveryMod = require('../utils/cartRecovery');
    const resolvedA = cartRecoveryMod.resolveAuthoritativeOrderForPaymentStart(db, 'store_001', sharedCartId);
    const resolvedB = cartRecoveryMod.resolveAuthoritativeOrderForPaymentStart(db, 'store_beta_int', sharedCartId);
    assert(resolvedA && resolvedA.orderId === aOrderId, 'store_001 解析出自己的 A-ORDER-INT（同 cart_id 字串不跨店混用）', JSON.stringify(resolvedA));
    assert(resolvedB && resolvedB.orderId === bOrderId, 'store_beta_int 解析出自己的 B-ORDER-INT', JSON.stringify(resolvedB));
    assert(resolvedA.orderId !== resolvedB.orderId, 'store A 解析結果與 store B 完全不同，查詢 submit_order 時 store_id 是強制條件');
  } finally {
    server.close();
  }
}

async function runRawLineUidTest(db) {
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/analytics', require('../routes/analytics'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const cartId = 'cart-raw-uid-test';
    const res = await fetch(`${base}/api/analytics/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        visitor_id: 'v-raw', session_id: 's-raw', cart_id: cartId, event_name: 'add_to_cart', product_id: 1,
        line_user_id: 'U_FAKE',
      }),
    });
    assert(res.status === 200, '真實 HTTP add_to_cart 呼叫成功（即使夾帶 raw line_user_id 仍正常處理，不報錯）');
    const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id=? AND stage='cart_abandoned' LIMIT 1`, [cartId]);
    assert(!!job, '仍正常建立 cart_abandoned job');
    assert(job.line_user_id !== 'U_FAKE', 'job.line_user_id 不是被夾帶的偽造值 U_FAKE（routes/analytics.js 只信任 member_session 解析出的結果）', `line_user_id=${job.line_user_id}`);
  } finally {
    server.close();
  }
}

async function runClientForgeryTest(db) {
  const cartRecovery = require('../utils/cartRecovery');
  const orderId = 'order-forge-test-4a';
  cartRecovery.schedulePaymentRecovery(db, 'store_001', { cartId: 'cart-forge-test-4a', orderId, triggerEvent: 'payment_started', lastEvent: 'payment_started' });

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/analytics', require('../routes/analytics'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const res = await fetch(`${base}/api/analytics/events`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visitor_id: 'v-forge', session_id: 's-forge', order_id: orderId, event_name: 'payment_success', metadata: { value: 999999 } }),
    });
    assert(res.status === 400 || res.status === 403, 'client 偽造 payment_success 依然被拒（Phase 3 既有 SERVER_ONLY 契約，Phase 4A 未破壞）', `status=${res.status}`);
    const dbCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id='store_001' AND event_name='payment_success' AND order_id=?`, [orderId]).c;
    assert(dbCount === 0, 'DB payment_success 事件計數為 0（未寫入）');
    const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND order_id=? AND stage='payment_abandoned'`, [orderId]);
    assert(job && job.status === 'pending', '偽造請求被拒後，原本的 payment_abandoned job 仍是 pending（未被誤 converted）', job && job.status);
  } finally {
    server.close();
  }
}

main().catch((e) => { console.error('Phase 4A test runner crashed:', e); process.exit(1); });
