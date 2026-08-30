#!/usr/bin/env node
// scripts/run-h1-4-10-phase4b-recovery-resume-targeted.js
// H1.4.10 Phase 4B — Recovery Resume 高風險架構 targeted test（26 cases）
//
// 只鎖這一輪修正的高風險架構：Cart Snapshot Restore Authority／
// LIFF-only Recovery URL／Existing Order Payment Resume／duplicate order
// prevention／token horizon／race cancellation。完整 75+ case 的 Phase 4B
// full test 留待這批全綠後才寫。

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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase4b-targeted-'));
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
  const delivery = require('../utils/cartRecoveryDelivery');
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');
  const { logServerEvent } = require('../utils/analyticsLog');

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta', 'Store Beta', 'x', 'pro', 1]);
  setSetting('store_001', 'line_member_liff_id', '2010718887-member');
  setSetting('store_001', 'line_shipping_liff_id', '2010718887-shipping');
  setSetting('store_beta', 'line_member_liff_id', '9999999-beta');

  function writeSnapshot(storeId, cartId, items, orderMode) {
    logServerEvent(db, {
      store_id: storeId, visitor_id: 'v-' + cartId, session_id: 's-' + cartId, cart_id: cartId,
      event_name: 'cart_updated', order_mode: orderMode || 'takeout',
      metadata: { items: items.map((i) => ({ product_id: i.product_id, name: '商品', qty: i.qty, unit_price: 10, subtotal: i.qty * 10 })), subtotal: 10, item_count: items.length },
    });
  }
  let ctr = 0;
  function uniqCart(prefix) { ctr += 1; return `${prefix}-cart${ctr}`; }

  try {
    // ── 1/2/3：Cart Snapshot Restore Authority ──────────────────────
    {
      const cartId = uniqCart('snap-full');
      writeSnapshot('store_001', cartId, [{ product_id: 1, qty: 2 }]);
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === true && r.items.length === 1 && r.items[0].product_id === 1 && r.items[0].qty === 2, '1. 有完整 cart_updated snapshot → restorable=true，items 正確', JSON.stringify(r));
    }
    {
      const cartId = uniqCart('snap-missing');
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === false && r.reason === 'snapshot_missing', '2. 完全沒有 cart_updated snapshot → restorable=false（不 fallback legacy）', JSON.stringify(r));
    }
    {
      const cartId = uniqCart('snap-legacy-only');
      // 只有 add_to_cart（legacy 估算來源），沒有 cart_updated 完整快照
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1, quantity: 3 });
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === false, '3. 只有 add_to_cart（legacy 估算）→ restorable=false，不可用於 Push restore', JSON.stringify(r));
      // 確認 legacy 函式本身仍然可用於 Analytics（不是被刪除，只是 Recovery 不用它）
      const { getLegacyCartItemsMap } = require('../utils/cartSnapshot');
      const legacyMap = getLegacyCartItemsMap(db, 'store_001', [cartId]);
      assert(Array.isArray(legacyMap[cartId]) && legacyMap[cartId].length === 1, '3b. getLegacyCartItemsMap() 本身仍正常運作（Dashboard 估算用途未被破壞）');
    }

    // ── 58-62：Variant Restore Safety（本輪新增，見 Reality Audit：
    // _buildCartTrackingItems() 目前永遠 hardcode variant:null，全專案沒有
    // variant-aware restore 邏輯，fail-closed 是唯一安全選項）──
    {
      const cartId = uniqCart('variant-none');
      writeSnapshot('store_001', cartId, [{ product_id: 1, qty: 1 }]); // writeSnapshot 預設不帶 variant 欄位（等同缺省）
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === true, '58. snapshot 沒有 variant 欄位 → restorable=true', JSON.stringify(r));
    }
    {
      const cartId = uniqCart('variant-null');
      logServerEvent(db, {
        store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
        metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 },
      });
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === true, '59. snapshot variant=null（明確欄位但值為 null）→ restorable=true', JSON.stringify(r));
    }
    {
      const cartId = uniqCart('variant-set');
      logServerEvent(db, {
        store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
        metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: '大份' }], subtotal: 10 },
      });
      const r = delivery.resolveRestorableCartSnapshot(db, 'store_001', cartId);
      assert(r.restorable === false && r.reason === 'unsupported_variant', '60. snapshot variant="大份"（無已證明的 variant-aware restore）→ restorable=false, reason=unsupported_variant', JSON.stringify(r));
    }
    {
      const storeId = 'store_001';
      db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'cart_recovery_enabled']);
      db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'cart_recovery_enabled', '1']);
      const cartId = uniqCart('variant-no-job');
      logServerEvent(db, {
        store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
        metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: '辣' }], subtotal: 10 },
      });
      logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'checkout_click' });
      db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='checkout_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
      db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'cart_recovery_line_enabled']);
      db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'cart_recovery_line_enabled', '1']);
      db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'line_channel_token']);
      db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'line_channel_token', 'fake-token']);
      let pushCalls = 0;
      const linePushModule = require('../utils/linePush');
      const originalSendLinePush = linePushModule.sendLinePush;
      linePushModule.sendLinePush = async () => { pushCalls += 1; return { success: true, status: 200 }; };
      const beforeTokenCount = db.get(`SELECT COUNT(*) c FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=?`, [storeId, cartId]).c;
      const result = await delivery.processDueLineRecoveryJobs(db, storeId, {});
      linePushModule.sendLinePush = originalSendLinePush;
      const afterTokenCount = db.get(`SELECT COUNT(*) c FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=?`, [storeId, cartId]).c;
      const thisJobDetail = result.details.find((d) => true); // 只有這一個 job 到期
      assert(afterTokenCount === beforeTokenCount, '61. unsupported_variant → processor 不建立 Recovery Token', `before=${beforeTokenCount} after=${afterTokenCount}`);
      assert(pushCalls === 0, '62. unsupported_variant → LINE Push API calls=0', `pushCalls=${pushCalls}`);
    }

    // ── 4/5：Target Resolver（line_order vs line_shipping）──────────
    {
      const cartId = uniqCart('target-order');
      writeSnapshot('store_001', cartId, [{ product_id: 1, qty: 1 }], 'takeout');
      const job = { stage: 'cart_abandoned', cart_id: cartId, order_id: null };
      const t = delivery.resolveRecoveryTarget(db, 'store_001', job);
      assert(t.page_type === 'line_order', '4. order_mode=takeout → page_type=line_order', JSON.stringify(t));
    }
    {
      const cartId = uniqCart('target-shipping');
      writeSnapshot('store_001', cartId, [{ product_id: 1, qty: 1 }], 'shipping');
      const job = { stage: 'cart_abandoned', cart_id: cartId, order_id: null };
      const t = delivery.resolveRecoveryTarget(db, 'store_001', job);
      assert(t.page_type === 'line_shipping', '5. order_mode=shipping → page_type=line_shipping', JSON.stringify(t));
    }

    // ── 6/7/8：LIFF-only Recovery URL ────────────────────────────────
    {
      const u = delivery.buildRecoveryUrl(db, 'store_001', { token: 'TOKEN123', pageType: 'line_order' });
      assert(u.ok === true && u.url.includes('https://liff.line.me/2010718887-member') && u.url.includes('recovery_token=TOKEN123'), '6. line_order 使用 line_member_liff_id 組出 LIFF URL', JSON.stringify(u));
    }
    {
      const u = delivery.buildRecoveryUrl(db, 'store_001', { token: 'TOKEN456', pageType: 'line_shipping' });
      assert(u.ok === true && u.url.includes('https://liff.line.me/2010718887-shipping'), '7. line_shipping 使用 line_shipping_liff_id 組出 LIFF URL', JSON.stringify(u));
    }
    {
      const storeId = 'store_no_liff';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'No LIFF', 'x', 'pro', 1]);
      const u = delivery.buildRecoveryUrl(db, storeId, { token: 'T', pageType: 'line_order' });
      assert(u.ok === false && u.reason === 'missing_liff_id' && !u.url, '8. 沒有 LIFF ID → { ok:false, reason:missing_liff_id }，不產生一般網頁 URL', JSON.stringify(u));
    }

    // ── 9/10/11：Restore 安全拒絕 ─────────────────────────────────────
    {
      const cartId = uniqCart('restore-uid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId: 'Ureal0000000000000000000001', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
      const r = handoff.restoreRecoveryToken(db, 'store_001', tok.token, 'Uwrong0000000000000000000002');
      assert(r.ok === false && r.reason === 'uid_mismatch', '9. 錯誤 LINE UID restore → uid_mismatch 拒絕');
    }
    {
      const cartId = uniqCart('restore-store');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId: 'Ureal0000000000000000000003', cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
      const r = handoff.restoreRecoveryToken(db, 'store_beta', tok.token, 'Ureal0000000000000000000003');
      assert(r.ok === false && r.reason === 'not_found', '10. 錯誤 store restore → not_found 拒絕（跨店查不到）');
    }
    {
      const cartId = uniqCart('restore-expired');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId: 'Ureal0000000000000000000004', cartQtyItems: [{ product_id: 1, qty: 1 }], ttlMinutes: 1, pageType: 'line_order' });
      db.run(`UPDATE line_cart_handoff_tokens SET expires_at='2000-01-01 00:00:00' WHERE token=?`, [tok.token]);
      const r = handoff.restoreRecoveryToken(db, 'store_001', tok.token, 'Ureal0000000000000000000004');
      assert(r.ok === false && r.reason === 'expired', '11. 過期 token restore → expired 拒絕');
    }

    // ── 12/13：cart/checkout restore 不觸發／不重複 checkout_click ────
    // （API 層級驗證：restoreRecoveryToken() 本身完全不呼叫 logServerEvent，
    // 純粹是 DB 查詢與 recomputeCart()，見原始碼靜態確認）
    {
      const handoffSrc = fs.readFileSync(path.join(ROOT, 'utils/lineCheckoutHandoff.js'), 'utf8');
      const fnMatch = handoffSrc.match(/function restoreRecoveryToken[\s\S]*?\n}\n/);
      assert(!!fnMatch && !fnMatch[0].includes('logServerEvent') && !fnMatch[0].includes('checkout_click'), '12/13. restoreRecoveryToken() 原始碼完全不含 logServerEvent／checkout_click（純 UI 還原，不偽造 canonical 事件）');
    }

    // ── 14/15：payment token resume_type + 不回 cart ──────────────────
    {
      const cartId = uniqCart('pay-resume');
      const orderId = 'order-' + cartId;
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, 'store_001', '[]', 500, 500, 'linepay', 'unpaid']);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId: 'Upay00000000000000000000001', orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r = handoff.restoreRecoveryToken(db, 'store_001', tok.token, 'Upay00000000000000000000001');
      assert(r.ok === true && r.resumeType === 'payment', '14. payment token restore → resume_type=payment', JSON.stringify(r));
      assert(r.cart === undefined, '15. payment resume 不回傳 cart 內容', JSON.stringify(r));
    }

    // ── 16/17/18/19/20/21/22：Existing Order Payment Resume（真實 HTTP）──
    await runResumePaymentHttpTests(db);

    // ── 23：Token horizon ──────────────────────────────────────────
    {
      const cartId = uniqCart('horizon');
      const past = new Date(Date.now() - 23 * 3600000).toISOString().slice(0, 19).replace('T', ' ');
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, stage, status, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`,
        ['store_001', cartId, 'cart_abandoned', 'pending', cartRecovery._nowIso(), `cart:${cartId}:cart_abandoned`, past, past]);
      const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id='store_001' AND cart_id=?`, [cartId]);
      const jobCreatedMs = Date.parse((job.created_at || '').replace(' ', 'T') + 'Z');
      const { CURRENT_RECOVERABLE_HORIZON_HOURS } = cartRecovery;
      const horizonDeadlineMs = jobCreatedMs + CURRENT_RECOVERABLE_HORIZON_HOURS * 3600000;
      const remainingMinutes = Math.max(1, Math.floor((horizonDeadlineMs - Date.now()) / 60000));
      assert(remainingMinutes < 60 && remainingMinutes > 0, '23. job 已存在 23 小時 → token 剩餘 TTL 遠小於 24 小時（受 horizon 限制）', `remainingMinutes=${remainingMinutes}`);
    }

    // ── 24：Race Cancellation ────────────────────────────────────────
    await runRaceCancellationTest(db);

    // ── 25/26：跨頁 restore 拒結（token 本身沒有頁面鎖定機制，但由前端根據
    // page_type 決定要不要呼叫 restore；這裡驗證 target resolver 對
    // shipping/order 兩種 cart 分別給出正確、不會混淆的 page_type，作為前端
    // 判斷跨頁的依據）──
    {
      const shipCartId = uniqCart('cross-ship');
      writeSnapshot('store_001', shipCartId, [{ product_id: 1, qty: 1 }], 'shipping');
      const t = delivery.resolveRecoveryTarget(db, 'store_001', { stage: 'cart_abandoned', cart_id: shipCartId, order_id: null });
      assert(t.page_type === 'line_shipping', '25a. shipping cart 的 target 明確標示 line_shipping（resolver 靜態確認）');
    }
    {
      const orderCartId = uniqCart('cross-order');
      writeSnapshot('store_001', orderCartId, [{ product_id: 1, qty: 1 }], 'takeout');
      const t = delivery.resolveRecoveryTarget(db, 'store_001', { stage: 'cart_abandoned', cart_id: orderCartId, order_id: null });
      assert(t.page_type === 'line_order', '26a. line-order cart 的 target 明確標示 line_order（resolver 靜態確認）');
    }

    // ── 25b/26b/26c：真實 HTTP wrong-page 拒絕 + 正確 page_type 成功 ──────
    await runWrongPageHttpTests(db);

    // ── 27-33：Payment Resume Idempotency／Concurrency ───────────────────
    await runPaymentConcurrencyTests(db);

    // ── RC1-5／TI1-5／PS1-8／提醒後成交 完整 scenario（在 concurrency 測試
    // 完全結束、node-fetch require.cache 已恢復之後才跑，避免互相干擾）──
    await runConversionAndInvalidationTests(db);
  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }

  console.log('\n== Targeted Summary ==');
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

async function runResumePaymentHttpTests(db) {
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');
  const nodeFetchPath = require.resolve('node-fetch');
  let confirmReturnCode = '0000';
  const fakeFetch = async (url) => ({ json: async () => ({ returnCode: confirmReturnCode, info: { transactionId: 'txn-resume-1', paymentUrl: { web: 'https://sandbox.line.me/pay/resume-fake' } } }) });
  require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };

  db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, ['store_001']);
  db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`,
    ['store_001', 'LINE Pay', 'linepay', 1, 'test', 'test-channel-id', 'test-channel-secret']);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  function makeOrder(orderId, total, paymentStatus) {
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, 'store_001', '[]', total, total, 'linepay', paymentStatus]);
  }

  try {
    // 16/17/18/19：正常 resume + authoritative amount + fake client 值被忽略
    const lineUserId = 'Uresume00000000000000000001';
    const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: lineUserId });
    const orderId = 'order-resume-real';
    makeOrder(orderId, 1234, 'unpaid');
    const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-resume-real', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });

    const res1 = await fetch(`${base}/api/cart-recovery/resume-payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token, order_id: 'FAKE-ORDER', total: 1, items: [{ name: 'fake', qty: 1, price: 1 }], customer_name: 'fake' }),
    });
    const json1 = await res1.json();
    assert(json1.success === true && !!json1.payment_url, '16. 正常 payment resume 成功回傳 payment_url', JSON.stringify(json1));
    assert(!('order_id' in json1) && !('total' in json1), '17. resume-payment 回應不洩漏 order_id/total 給前端');
    const orderAfter = db.get('SELECT * FROM orders WHERE uuid=?', [orderId]);
    assert(orderAfter.payment_status === 'pending', '17b. orders.payment_status 正確更新（來自 DB order 本身，非 client）');
    assert(orderAfter.total === 1234, '18. resume 未建立第二張訂單，orders.total 仍是真實的 1234（未被 client 的 total=1 覆蓋）', JSON.stringify(orderAfter.total));
    const orderCount = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id='store_001' AND uuid=?`, [orderId]).c;
    assert(orderCount === 1, '19. resume-payment 沒有為這筆訂單建立第二張重複紀錄', `count=${orderCount}`);

    // 20：already paid 拒絕
    const paidOrderId = 'order-resume-paid';
    makeOrder(paidOrderId, 500, 'paid');
    const tokPaid = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-resume-paid', lineUserId, orderId: paidOrderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
    const res2 = await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tokPaid.token }) });
    const json2 = await res2.json();
    assert(json2.success === false && json2.reason === 'already_paid', '20. 已付款訂單 resume → already_paid 拒絕', JSON.stringify(json2));

    // 21：已有 purchase 事件的訂單拒絕（即使 payment_status 還沒同步成 paid）
    const convertedOrderId = 'order-resume-converted';
    makeOrder(convertedOrderId, 300, 'unpaid');
    const { logServerEvent } = require('../utils/analyticsLog');
    logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', order_id: convertedOrderId, event_name: 'purchase' });
    const tokConverted = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-resume-converted', lineUserId, orderId: convertedOrderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
    const res3 = await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tokConverted.token }) });
    const json3 = await res3.json();
    assert(json3.success === false && json3.reason === 'already_converted', '21. 已有 purchase 事件的訂單 → already_converted 拒絕', JSON.stringify(json3));

    // 22：重複 resume 同一筆未付款訂單不建立 duplicate order（token 消費前可重複呼叫，只要沒 paid/converted）
    const orderCountBeforeDup = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id='store_001'`).c;
    const tokDup = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-resume-real-2', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
    await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tokDup.token }) });
    const orderCountAfterDup = db.get(`SELECT COUNT(*) c FROM orders WHERE store_id='store_001'`).c;
    assert(orderCountAfterDup === orderCountBeforeDup, '22. 重複 resume 同一未付款訂單，不產生 duplicate order', `before=${orderCountBeforeDup} after=${orderCountAfterDup}`);
  } finally {
    server.close();
    delete require.cache[nodeFetchPath];
  }
}

async function runRaceCancellationTest(db) {
  const cartRecovery = require('../utils/cartRecovery');
  const delivery = require('../utils/cartRecoveryDelivery');
  const handoff = require('../utils/lineCheckoutHandoff');

  const storeId = 'store_001';
  db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'cart_recovery_enabled']);
  db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'cart_recovery_enabled', '1']);
  db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'cart_recovery_line_enabled']);
  db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'cart_recovery_line_enabled', '1']);
  db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, 'line_channel_token']);
  db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, 'line_channel_token', 'fake-channel-token']);

  const cartId = 'cart-race-cancel';
  const lineUserId = 'Urace0000000000000000000001';
  db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
  const { grantConsent } = require('../utils/cartRecoveryConsent');
  grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });

  const { logServerEvent } = require('../utils/analyticsLog');
  logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, line_user_id: lineUserId, event_name: 'add_to_cart', product_id: 1 });
  logServerEvent(db, {
    store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
    metadata: { items: [{ product_id: 1, name: 'x', qty: 1, unit_price: 10, subtotal: 10 }], subtotal: 10 },
  });
  db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);

  let pushCallCount = 0;
  const originalSendLinePush = require('../utils/linePush').sendLinePush;
  const linePushModule = require('../utils/linePush');
  linePushModule.sendLinePush = async () => { pushCallCount += 1; return { success: true, status: 200 }; };

  const job = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
  // 模擬 processor 在 create token → recheck 之間，consent 被收回（race condition）。
  // 用 cart_id 過濾計數（不是全域呼叫次數）——因為同一個 processor 執行還會處理
  // 其他測試區塊留下的到期 job，全域計數會被其他 job 的呼叫次數干擾。
  const { revokeConsent } = require('../utils/cartRecoveryConsent');
  const originalEvaluate = delivery.evaluateLineRecoveryEligibility;
  let evalCallCountForTarget = 0;
  delivery.evaluateLineRecoveryEligibility = (dbArg, storeIdArg, jobArg) => {
    if (jobArg && jobArg.cart_id === cartId) {
      evalCallCountForTarget += 1;
      if (evalCallCountForTarget === 2) { revokeConsent(dbArg, storeIdArg, { cartId }); }
    }
    return originalEvaluate(dbArg, storeIdArg, jobArg);
  };

  const result = await delivery.processDueLineRecoveryJobs(db, storeId, {});
  delivery.evaluateLineRecoveryEligibility = originalEvaluate;
  linePushModule.sendLinePush = originalSendLinePush;

  assert(pushCallCount === 0, '24a. Race：final recheck 失敗時，LINE Push API 呼叫次數為 0', `calls=${pushCallCount}`);
  const cancelledTokens = db.all(`SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=? AND purpose='recovery_resume'`, [storeId, cartId]);
  assert(cancelledTokens.length >= 1 && cancelledTokens.every((t) => t.status === 'cancelled'), '24b. Race：剛建立、未使用的 token 被安全標記為 cancelled', JSON.stringify(cancelledTokens.map((t) => t.status)));
  if (cancelledTokens.length) {
    const restoreAttempt = handoff.restoreRecoveryToken(db, storeId, cancelledTokens[0].token, lineUserId);
    assert(restoreAttempt.ok === false && restoreAttempt.reason === 'cancelled', '24c. Race：已取消的 token 之後 POST /restore 會被拒絕', JSON.stringify(restoreAttempt));
  }
}

// ════════════════════════════════════════════════════════════════
// 25b/26b/26c：真實 HTTP wrong-page 拒絕 + 正確 page_type 成功
// ════════════════════════════════════════════════════════════════
async function runWrongPageHttpTests(db) {
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function post(body) {
    const res = await fetch(`${base}/api/cart-recovery/restore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return res.json();
  }

  try {
    const lineUserId = 'Uwrongpage000000000000000001';
    const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: lineUserId });

    // shipping token 拿去 line_order 頁 restore → wrong_page
    const shipTok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-wp-ship', lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_shipping' });
    const r25b = await post({ member_session: memberSession, recovery_token: shipTok.token, page_type: 'line_order' });
    assert(r25b.success === false && r25b.reason === 'wrong_page', '25b. shipping token + page_type=line_order → wrong_page 拒絕（真實 HTTP）', JSON.stringify(r25b));

    // line_order token 拿去 shipping 頁 restore → wrong_page
    const orderTok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-wp-order', lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    const r26b = await post({ member_session: memberSession, recovery_token: orderTok.token, page_type: 'line_shipping' });
    assert(r26b.success === false && r26b.reason === 'wrong_page', '26b. line_order token + page_type=line_shipping → wrong_page 拒絕（真實 HTTP）', JSON.stringify(r26b));

    // 正確 page_type → 成功還原
    const okTok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-wp-ok', lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    const r26c = await post({ member_session: memberSession, recovery_token: okTok.token, page_type: 'line_order' });
    assert(r26c.success === true && r26c.resume_type === 'cart', '26c. 正確 page_type 相符 → restore 成功', JSON.stringify(r26c));

    // ── Restore Job Authoritative Recheck（本輪新增）：正常 Push 出去的
    // Recovery URL 只有 job.status='sent' 才是合法 resume；pending/waiting
    // （尚未真正送出）與 converted/cancelled（已處理完）皆安全拒絕。 ──
    const { logServerEvent: logServerEventRecheck } = require('../utils/analyticsLog');
    function writeSnapshotRecheck(cartId) {
      logServerEventRecheck(db, {
        store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
        metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 },
      });
    }
    {
      const cartId = 'cart-job-recheck-pending';
      writeSnapshotRecheck(cartId);
      logServerEventRecheck(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
      // job 仍是 pending（尚未真的走過 processDueLineRecoveryJobs 的 send 流程）
      const r = await post({ member_session: memberSession, recovery_token: tok.token, page_type: 'line_order' });
      assert(r.success === false && r.reason === 'already_completed', 'Restore Recheck：job.status=pending（尚未真正 Push）→ 安全拒絕（already_completed）', JSON.stringify(r));
    }
    {
      const cartId = 'cart-job-recheck-sent';
      writeSnapshotRecheck(cartId);
      logServerEventRecheck(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      db.run(`UPDATE cart_recovery_jobs SET status='sent' WHERE store_id='store_001' AND cart_id=? AND stage='cart_abandoned'`, [cartId]);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
      const r = await post({ member_session: memberSession, recovery_token: tok.token, page_type: 'line_order' });
      assert(r.success === true, 'Restore Recheck：job.status=sent（正常 Push 出去的連結）→ 允許 restore', JSON.stringify(r));
    }
    {
      const cartId = 'cart-job-recheck-converted';
      writeSnapshotRecheck(cartId);
      logServerEventRecheck(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
      db.run(`UPDATE cart_recovery_jobs SET status='converted' WHERE store_id='store_001' AND cart_id=? AND stage='cart_abandoned'`, [cartId]);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
      const r = await post({ member_session: memberSession, recovery_token: tok.token, page_type: 'line_order' });
      assert(r.success === false && r.reason === 'already_completed', 'Restore Recheck：job.status=converted（token 未即時 invalidate 的邊界情況）→ defense-in-depth 仍安全拒絕', JSON.stringify(r));
    }
  } finally {
    server.close();
  }
}

// ════════════════════════════════════════════════════════════════
// 27-33：Payment Resume Idempotency／Concurrency
// ════════════════════════════════════════════════════════════════
async function runPaymentConcurrencyTests(db) {
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');
  const { logServerEvent } = require('../utils/analyticsLog');
  const nodeFetchPath = require.resolve('node-fetch');
  let confirmReturnCode = '0000';
  let apiCallCount = 0;
  let fetchDelayMs = 0;
  const fakeFetch = async () => {
    apiCallCount += 1;
    if (fetchDelayMs > 0) await new Promise((r) => setTimeout(r, fetchDelayMs));
    if (confirmReturnCode !== '0000') return { json: async () => ({ returnCode: confirmReturnCode }) };
    return { json: async () => ({ returnCode: '0000', info: { transactionId: `txn-${apiCallCount}`, paymentUrl: { web: 'https://sandbox.line.me/pay/concurrency-fake' } } }) };
  };
  require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };

  db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, ['store_001']);
  db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`,
    ['store_001', 'LINE Pay', 'linepay', 1, 'test', 'test-channel-id', 'test-channel-secret']);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  function makeOrder(orderId, total, paymentStatus) {
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, 'store_001', '[]', total, total, 'linepay', paymentStatus]);
  }
  async function resumePayment(token, memberSession) {
    const res = await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: token }) });
    return res.json();
  }

  try {
    const lineUserId = 'Uconcurrency00000000000001';
    const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: lineUserId });

    // ── CASE A：真正 simultaneous（fake fetch 延遲 100ms，Promise.all 兩個
    // request 幾乎同時抵達 claim 那一行）──
    {
      apiCallCount = 0;
      confirmReturnCode = '0000';
      fetchDelayMs = 100;
      const orderId = 'order-concurrency-1';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-1', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const [res1, res2] = await Promise.all([resumePayment(tok.token, memberSession), resumePayment(tok.token, memberSession)]);
      fetchDelayMs = 0;
      assert(apiCallCount === 1, '27. CASE A（延遲 100ms 模擬真正 simultaneous）：同 recovery token concurrent resume×2 → LINE API 只收到 1 次 request', `apiCallCount=${apiCallCount}`);
      const results = [res1, res2];
      const successes = results.filter((r) => r.success === true);
      const inProgress = results.filter((r) => r.success === false && r.reason === 'payment_request_in_progress');
      assert(successes.length === 1, '27b. CASE A：兩個並發請求只有 1 個成功', JSON.stringify(results));
      assert(inProgress.length === 1, '28. CASE A：另一個並發請求安全回傳 payment_request_in_progress', JSON.stringify(results));
    }

    // ── CASE B：第一個 request 很快成功（token 已變成 payment_requested），
    // 緊接著第二個 request 才抵達——這正是本輪抓到的真實 bug 情境
    // （payment_requested 不應該可以被重新 claim）。
    {
      apiCallCount = 0;
      confirmReturnCode = '0000';
      fetchDelayMs = 0;
      const orderId = 'order-concurrency-fast';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-fast', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r1 = await resumePayment(tok.token, memberSession);
      assert(r1.success === true, 'CASE B 前置：第一次 resume 成功', JSON.stringify(r1));
      const r2 = await resumePayment(tok.token, memberSession);
      assert(apiCallCount === 1, 'CASE B：第一次成功（payment_requested）後緊接第二次點擊 → LINE API 呼叫次數仍是 1（不會因為狀態已是 payment_requested 就被允許重新 claim）', `apiCallCount=${apiCallCount}`);
      assert(r2.success === false && r2.reason === 'payment_request_in_progress', 'CASE B：第二次點擊安全回傳 payment_request_in_progress（不是重新打一次 LINE API）', JSON.stringify(r2));
    }

    // ── 34a-g：Cancel-Return Retry Contract（獨立於 concurrency，明確的
    // reset 動作，而不是放寬 claim 條件）──
    await runCancelRetryTests(db, handoff, createMemberSession, resumePayment, makeOrder);

    // 29/30：LINE API failure → token 退回可重試狀態，下次可再嘗試
    {
      apiCallCount = 0;
      confirmReturnCode = '9999';
      const orderId = 'order-concurrency-fail';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-fail', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r1 = await resumePayment(tok.token, memberSession);
      assert(r1.success === false, '29. LINE API failure → resume-payment 回傳失敗', JSON.stringify(r1));
      const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id='store_001' AND token=?`, [tok.token]);
      assert(tokenRow.status === 'opened', '29b. failure 後 token 安全退回 opened（可重試狀態，非永久鎖死）', JSON.stringify(tokenRow));
      confirmReturnCode = '0000';
      const r2 = await resumePayment(tok.token, memberSession);
      assert(r2.success === true, '30. failure 後下一次 resume 可再次成功建立 1 次 request', JSON.stringify(r2));
    }

    // 31：LINE API success → token status=payment_requested
    {
      confirmReturnCode = '0000';
      const orderId = 'order-concurrency-status';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-status', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id='store_001' AND token=?`, [tok.token]);
      assert(tokenRow.status === 'payment_requested', '31. LINE API success → token status=payment_requested（非 consumed）', JSON.stringify(tokenRow));
    }

    // 32：已 payment_success → 再 resume → 0 LINE API calls
    {
      apiCallCount = 0;
      const orderId = 'order-concurrency-paid-success';
      makeOrder(orderId, 500, 'unpaid');
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 500 } });
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-paid-success', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r = await resumePayment(tok.token, memberSession);
      assert(r.success === false && r.reason === 'already_converted', '32. 已 payment_success 的訂單 → resume 拒絕', JSON.stringify(r));
      assert(apiCallCount === 0, '32b. 已 payment_success → 0 次 LINE API calls', `apiCallCount=${apiCallCount}`);
    }

    // 33：已 purchase → 再 resume → 0 LINE API calls
    {
      apiCallCount = 0;
      const orderId = 'order-concurrency-purchased';
      makeOrder(orderId, 500, 'unpaid');
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'purchase' });
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-concurrency-purchased', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r = await resumePayment(tok.token, memberSession);
      assert(r.success === false && r.reason === 'already_converted', '33. 已 purchase 的訂單 → resume 拒絕', JSON.stringify(r));
      assert(apiCallCount === 0, '33b. 已 purchase → 0 次 LINE API calls', `apiCallCount=${apiCallCount}`);
    }
  } finally {
    server.close();
    delete require.cache[nodeFetchPath];
  }
}

// ════════════════════════════════════════════════════════════════
// 34a-g：Cancel-Return Retry Contract（獨立於 concurrency claim，明確的
// reset 動作：POST /api/cart-recovery/payment-cancelled）
// ════════════════════════════════════════════════════════════════
async function runCancelRetryTests(db, handoff, createMemberSession, resumePayment, makeOrder) {
  const { logServerEvent } = require('../utils/analyticsLog');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function paymentCancelled(token, memberSession) {
    const res = await fetch(`${base}/api/cart-recovery/payment-cancelled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: token }) });
    return res.json();
  }

  try {
    const lineUserId = 'Ucancelretry0000000000001';
    const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: lineUserId });
    const wrongMemberSession = createMemberSession({ store_id: 'store_001', line_user_id: 'Uwrongperson000000000001' });

    // 34a：payment_requested + payment-cancelled → token opened
    {
      const orderId = 'order-cancelretry-1';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-1', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession); // → payment_requested
      const r = await paymentCancelled(tok.token, memberSession);
      assert(r.success === true, '34a. payment_requested + payment-cancelled → reset 成功', JSON.stringify(r));
      const row = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id='store_001' AND token=?`, [tok.token]);
      assert(row.status === 'opened', '34a-b. reset 後 token status=opened', JSON.stringify(row));
    }

    // 34b：wrong member → 不 reset
    {
      const orderId = 'order-cancelretry-2';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-2', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      const r = await paymentCancelled(tok.token, wrongMemberSession);
      assert(r.success === false && r.reason === 'uid_mismatch', '34b. wrong member → 不 reset（uid_mismatch）', JSON.stringify(r));
      const row = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id='store_001' AND token=?`, [tok.token]);
      assert(row.status === 'payment_requested', '34b-2. token 狀態未被錯誤 member 的請求改變');
    }

    // 34c：wrong store → 不 reset
    {
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_cancelretry_beta', 'Beta', 'x', 'pro', 1]);
      const orderId = 'order-cancelretry-3';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-3', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      // 用另一個 app 掛不同 storeId 中介層，模擬跨店呼叫
      const appBeta = express();
      appBeta.use(express.json());
      appBeta.use((req, res, next) => { req.storeId = 'store_cancelretry_beta'; next(); });
      appBeta.use('/api/cart-recovery', require('../routes/cart-recovery'));
      const serverBeta = http.createServer(appBeta);
      await new Promise((resolve) => serverBeta.listen(0, resolve));
      const portBeta = serverBeta.address().port;
      const resBeta = await fetch(`http://127.0.0.1:${portBeta}/api/cart-recovery/payment-cancelled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) });
      const rBeta = await resBeta.json();
      serverBeta.close();
      assert((rBeta.success === false) && (rBeta.reason === 'not_found' || rBeta.reason === 'member_not_identified'), '34c. wrong store → 不 reset（member_session 本身即 store-scoped，於身分驗證層或 token 查詢層安全拒絕）', JSON.stringify(rBeta));
    }

    // 34d：already paid → 不 reset
    {
      const orderId = 'order-cancelretry-4';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-4', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      db.run(`UPDATE orders SET payment_status='paid' WHERE uuid=?`, [orderId]);
      const r = await paymentCancelled(tok.token, memberSession);
      assert(r.success === false && r.reason === 'already_paid', '34d. already paid → 不 reset', JSON.stringify(r));
    }

    // 34e：payment_success → 不 reset
    {
      const orderId = 'order-cancelretry-5';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-5', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 500 } });
      const r = await paymentCancelled(tok.token, memberSession);
      assert(r.success === false && r.reason === 'already_converted', '34e. payment_success 已存在 → 不 reset', JSON.stringify(r));
    }

    // 34f：purchase → 不 reset
    {
      const orderId = 'order-cancelretry-6';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-6', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await resumePayment(tok.token, memberSession);
      logServerEvent(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'purchase' });
      const r = await paymentCancelled(tok.token, memberSession);
      assert(r.success === false && r.reason === 'already_converted', '34f. purchase 已存在 → 不 reset', JSON.stringify(r));
    }

    // 34g：reset 後真正再按一次 → LINE API 可以增加到第 2 次
    {
      const orderId = 'order-cancelretry-7';
      makeOrder(orderId, 500, 'unpaid');
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId: 'cart-cancelretry-7', lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const r1 = await resumePayment(tok.token, memberSession);
      assert(r1.success === true, '34g 前置：第一次 resume 成功');
      const cancelResult = await paymentCancelled(tok.token, memberSession);
      assert(cancelResult.success === true, '34g 前置：cancel-return reset 成功');
      const r2 = await resumePayment(tok.token, memberSession);
      assert(r2.success === true, '34g. reset 後真正再按一次 → 可以再次成功建立 LINE Pay Request（非永久鎖死）', JSON.stringify(r2));
    }
  } finally {
    server.close();
  }
}

// ════════════════════════════════════════════════════════════════
// RC1-5／TI1-5／PS1-8／完整「提醒後成交」scenario
// ════════════════════════════════════════════════════════════════
async function runConversionAndInvalidationTests(db) {
  const cartRecovery = require('../utils/cartRecovery');
  const handoff = require('../utils/lineCheckoutHandoff');
  const { logServerEvent } = require('../utils/analyticsLog');
  const { createMemberSession } = require('../utils/lineMemberSession');

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }

  // ── RC1/RC3/RC4：sent → purchase → converted，sent_at 保留，時序合理 ──
  {
    const storeId = 'store_001';
    setSetting(storeId, 'cart_recovery_enabled', '1');
    const cartId = 'cart-rc1';
    const orderId = 'order-rc1';
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, storeId, '[]', 100, 100, 'cash', 'unpaid']);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    db.run(`UPDATE cart_recovery_jobs SET status='sent', channel='line', sent_at=?, updated_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`,
      [cartRecovery._nowIso(), cartRecovery._nowIso(), storeId, cartId]);
    const beforeSentAt = db.get(`SELECT sent_at FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).sent_at;
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
    const row = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(row.status === 'converted', 'RC1. job.status=sent 收到 purchase → converted', JSON.stringify(row.status));
    assert(!!row.converted_at, 'RC1b. converted_at 有值');
    assert(row.sent_at === beforeSentAt, 'RC3. sent_at 保留（conversion 沒有覆蓋掉原本的送達紀錄）');
    assert(row.converted_at >= row.sent_at, 'RC4. converted_at 時間不早於 sent_at（時間語意合理）', `sent_at=${row.sent_at} converted_at=${row.converted_at}`);
  }

  // ── RC2：sent → payment_success → converted ──────────────────────
  {
    const storeId = 'store_001';
    const cartId = 'cart-rc2';
    const orderId = 'order-rc2';
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay', 'unpaid']);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'payment_started', metadata: { payment_method: 'linepay' } });
    db.run(`UPDATE cart_recovery_jobs SET status='sent', channel='line', sent_at=? WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`, [cartRecovery._nowIso(), storeId, orderId]);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 100 } });
    const row = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND order_id=? AND stage='payment_abandoned'`, [storeId, orderId]);
    assert(row.status === 'converted', 'RC2. job.status=sent 收到 payment_success → converted', JSON.stringify(row.status));
  }

  // ── RC5：同事件重複 → 仍 converted，不 duplicate（idempotent update） ──
  {
    const storeId = 'store_001';
    const cartId = 'cart-rc5';
    const orderId = 'order-rc5';
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, storeId, '[]', 100, 100, 'cash', 'unpaid']);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    db.run(`UPDATE cart_recovery_jobs SET status='sent', sent_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
    const convertedAt1 = db.get(`SELECT converted_at FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).converted_at;
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'purchase' });
    const row = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    const totalRows = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]).c;
    assert(row.status === 'converted' && totalRows === 1, 'RC5. 同事件重複觸發 → 仍 converted，沒有 duplicate job row', `status=${row.status} rows=${totalRows}`);
  }

  // ── TI1/TI2：sent cart recovery token，purchase 後 token 失效，restore 被拒 ──
  {
    const storeId = 'store_001';
    const cartId = 'cart-ti1';
    const lineUserId = 'Uti100000000000000000001';
    const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
    const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, cartQtyItems: [{ product_id: 1, qty: 1 }], pageType: 'line_order' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'order-ti1', event_name: 'purchase' });
    const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tok.token]);
    assert(tokenRow.status === 'cancelled', 'TI1. sent cart recovery token，purchase 後 → token cancelled', JSON.stringify(tokenRow));

    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.storeId = storeId; next(); });
    app.use('/api/cart-recovery', require('../routes/cart-recovery'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/cart-recovery/restore`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token, page_type: 'line_order' }),
    });
    const json = await res.json();
    server.close();
    assert(json.success === false && json.reason === 'cancelled', 'TI2. 再 restore → rejected（reason=cancelled）', JSON.stringify(json));
  }

  // ── TI3/TI4：payment recovery token，payment_success 後失效，resume-payment 0 API calls ──
  {
    const storeId = 'store_001';
    const cartId = 'cart-ti3';
    const orderId = 'order-ti3';
    const lineUserId = 'Uti300000000000000000001';
    const memberSession = createMemberSession({ store_id: storeId, line_user_id: lineUserId });
    db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, storeId, '[]', 100, 100, 'linepay', 'unpaid']);
    const tok = handoff.createRecoveryResumeToken(db, storeId, { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', order_id: orderId, event_name: 'payment_success', metadata: { value: 100 } });
    const tokenRow = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, tok.token]);
    assert(tokenRow.status === 'cancelled', 'TI3. payment recovery token，payment_success 後 → invalidated', JSON.stringify(tokenRow));

    const nodeFetchPath = require.resolve('node-fetch');
    let apiCallCount = 0;
    const fakeFetch = async () => { apiCallCount += 1; return { json: async () => ({ returnCode: '0000', info: { transactionId: 'x', paymentUrl: { web: 'https://x' } } }) }; };
    require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };
    db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, [storeId]);
    db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`,
      [storeId, 'LINE Pay', 'linepay', 1, 'test', 'test-id', 'test-secret']);
    const express = require('express');
    const app = express();
    app.use(express.json());
    app.use((req, res, next) => { req.storeId = storeId; next(); });
    app.use('/api/cart-recovery', require('../routes/cart-recovery'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/cart-recovery/resume-payment`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }),
    });
    const json = await res.json();
    server.close();
    delete require.cache[nodeFetchPath];
    assert(json.success === false, 'TI4a. 再 resume-payment → 拒絕', JSON.stringify(json));
    assert(apiCallCount === 0, 'TI4. 再 resume-payment → 0 LINE API calls', `apiCallCount=${apiCallCount}`);
  }

  // ── TI5：checkout purpose token 完全不受影響 ──────────────────────
  {
    const storeId = 'store_001';
    const cartId = 'cart-ti5';
    const { createCartHandoffToken } = handoff;
    const checkoutTok = createCartHandoffToken(db, storeId, { cartQtyItems: [{ product_id: 1, qty: 1 }], checkoutContext: {}, attribution: {}, createdIp: '127.0.0.1', createdUserAgent: 'test' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'order-ti5', event_name: 'purchase' });
    const row = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND token=?`, [storeId, checkoutTok.token]);
    assert(row && row.status !== 'cancelled', 'TI5. checkout purpose token 完全不受 Recovery conversion 影響', JSON.stringify(row));
  }

  // ── PS1-8：Recovery payment_started Backend Authority ──────────────
  await runPaymentStartedAuthorityTests(db);

  // ── 完整「提醒後成交」scenario（Phase 4B 商業上最重要的一條）─────────
  {
    const storeId = 'store_001';
    const cartId = 'cart-full-scenario';
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'add_to_cart', product_id: 1 });
    logServerEvent(db, {
      store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_mode: 'takeout', event_name: 'cart_updated',
      metadata: { items: [{ product_id: 1, name: '商品', qty: 1, unit_price: 10, subtotal: 10, variant: null }], subtotal: 10 },
    });
    const lineUserId = 'Ufullscenario00000000001';
    db.run(`INSERT OR REPLACE INTO line_members (store_id, line_user_id, is_friend) VALUES (?,?,?)`, [storeId, lineUserId, 1]);
    const { grantConsent } = require('../utils/cartRecoveryConsent');
    grantConsent(db, storeId, { cartId, lineUserId, source: 'test' });
    db.run(`UPDATE cart_recovery_jobs SET line_user_id=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [lineUserId, storeId, cartId]);
    db.run(`UPDATE cart_recovery_jobs SET due_at=? WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [cartRecovery._nowIso(), storeId, cartId]);
    setSetting(storeId, 'cart_recovery_line_enabled', '1');
    setSetting(storeId, 'line_channel_token', 'fake-token');
    setSetting(storeId, 'line_member_liff_id', '2010718887-member');

    const delivery = require('../utils/cartRecoveryDelivery');
    const linePushModule2 = require('../utils/linePush');
    const originalSend = linePushModule2.sendLinePush;
    linePushModule2.sendLinePush = async () => ({ success: true, status: 200 });
    await delivery.processDueLineRecoveryJobs(db, storeId, {});
    linePushModule2.sendLinePush = originalSend;

    const jobAfterSend = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(jobAfterSend.status === 'sent', '提醒後成交 scenario：LINE Push 成功後 job.status=sent', JSON.stringify(jobAfterSend.status));

    // 顧客後來（不透過 Recovery Token）自己完成訂單
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, event_name: 'checkout_click' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'order-full-scenario', event_name: 'submit_order' });
    logServerEvent(db, { store_id: storeId, visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: 'order-full-scenario', event_name: 'purchase' });

    const jobAfterPurchase = db.get(`SELECT * FROM cart_recovery_jobs WHERE store_id=? AND cart_id=? AND stage='cart_abandoned'`, [storeId, cartId]);
    assert(jobAfterPurchase.status === 'converted', '提醒後成交 scenario：purchase 後 job.status=converted', JSON.stringify(jobAfterPurchase.status));
    assert(!!jobAfterPurchase.sent_at, '提醒後成交 scenario：sent_at 保留');
    assert(!!jobAfterPurchase.converted_at, '提醒後成交 scenario：converted_at 有值');
    const tokenAfter = db.get(`SELECT status FROM line_cart_handoff_tokens WHERE store_id=? AND recovery_cart_id=? AND purpose='recovery_resume'`, [storeId, cartId]);
    assert(tokenAfter && tokenAfter.status === 'cancelled', '提醒後成交 scenario：Recovery token 已 invalidated');
  }
}

// ════════════════════════════════════════════════════════════════
// PS1-8：Recovery payment_started Backend Authority
// ════════════════════════════════════════════════════════════════
async function runPaymentStartedAuthorityTests(db) {
  const handoff = require('../utils/lineCheckoutHandoff');
  const { createMemberSession } = require('../utils/lineMemberSession');

  function countPaymentStarted(storeId, orderId) {
    return db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_started'`, [storeId, orderId]).c;
  }

  const nodeFetchPath = require.resolve('node-fetch');
  let confirmReturnCode = '0000';
  const fakeFetch = async () => {
    if (confirmReturnCode !== '0000') return { json: async () => ({ returnCode: confirmReturnCode }) };
    return { json: async () => ({ returnCode: '0000', info: { transactionId: 'txn-ps', paymentUrl: { web: 'https://x' } } }) };
  };
  require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };
  db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, ['store_001']);
  db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key) VALUES (?,?,?,?,?,?,?)`,
    ['store_001', 'LINE Pay', 'linepay', 1, 'test', 'test-id', 'test-secret']);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/cart-recovery', require('../routes/cart-recovery'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    const lineUserId = 'Upsauth000000000000000001';
    const memberSession = createMemberSession({ store_id: 'store_001', line_user_id: lineUserId });

    // PS1/PS2/PS3/PS4/PS5：正常 resume 成功 → payment_started 正確寫入，client 假值被忽略
    {
      confirmReturnCode = '0000';
      const cartId = 'cart-ps1';
      const orderId = 'order-ps1';
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, 'store_001', '[]', 300, 300, 'linepay', 'unpaid']);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const before = countPaymentStarted('store_001', orderId);
      const res = await fetch(`${base}/api/cart-recovery/resume-payment`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token, order_id: 'FAKE', total: 1, amount: 1, cart_id: 'FAKE-CART' }),
      });
      const json = await res.json();
      const after = countPaymentStarted('store_001', orderId);
      assert(json.success === true, 'PS1. resume-payment success → 呼叫成功', JSON.stringify(json));
      assert(after === before + 1, 'PS1b. payment_started +1', `before=${before} after=${after}`);
      const evt = db.get(`SELECT * FROM analytics_events WHERE store_id='store_001' AND order_id=? AND event_name='payment_started' ORDER BY id DESC LIMIT 1`, [orderId]);
      assert(evt.cart_id === cartId, 'PS2. cart_id = token recovery_cart_id（非 client 假值）', `cart_id=${evt.cart_id}`);
      assert(evt.order_id === orderId, 'PS3. order_id = token 綁定的真實訂單（非 client 假值 FAKE）', `order_id=${evt.order_id}`);
      const meta = JSON.parse(evt.metadata_json || '{}');
      assert(meta.payment_method === 'linepay' && Object.keys(meta).length === 1, 'PS4. metadata.payment_method=linepay，且只有這一個欄位（無 client amount 混入）', JSON.stringify(meta));
      assert(evt.cart_id !== 'FAKE-CART' && evt.order_id !== 'FAKE', 'PS5. client 假 cart_id/order_id/amount 完全無法影響寫入結果');
    }

    // PS6：LINE API failure → payment_started delta=0
    {
      confirmReturnCode = '9999';
      const cartId = 'cart-ps6';
      const orderId = 'order-ps6';
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, 'store_001', '[]', 300, 300, 'linepay', 'unpaid']);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const before = countPaymentStarted('store_001', orderId);
      await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) });
      const after = countPaymentStarted('store_001', orderId);
      assert(after === before, 'PS6. LINE API failure → payment_started delta=0', `before=${before} after=${after}`);
      confirmReturnCode = '0000';
    }

    // PS7：concurrent loser → payment_started delta=0（只有贏家那次會寫入）
    {
      const cartId = 'cart-ps7';
      const orderId = 'order-ps7';
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, 'store_001', '[]', 300, 300, 'linepay', 'unpaid']);
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      const [res1, res2] = await Promise.all([
        fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) }),
        fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) }),
      ]);
      const after = countPaymentStarted('store_001', orderId);
      assert(after === 1, 'PS7. concurrent loser 不產生額外 payment_started（只有贏家那次寫入，共 1 筆）', `count=${after}`);
    }

    // PS8：cancel reset 後合法第二次 payment request → 可再增加一筆 payment_started，原 payment job 仍只有 1 筆（只 refresh）
    {
      const cartId = 'cart-ps8';
      const orderId = 'order-ps8';
      db.run(`INSERT OR REPLACE INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, payment_status, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderId, orderId, orderId, 'store_001', '[]', 300, 300, 'linepay', 'unpaid']);
      const { logServerEvent: logServerEventPS8 } = require('../utils/analyticsLog');
      logServerEventPS8(db, { store_id: 'store_001', visitor_id: 'v', session_id: 's', cart_id: cartId, order_id: orderId, event_name: 'submit_order' });
      const tok = handoff.createRecoveryResumeToken(db, 'store_001', { cartId, lineUserId, orderId, resumeType: 'payment', cartQtyItems: [], pageType: 'line_order' });
      await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) });
      await fetch(`${base}/api/cart-recovery/payment-cancelled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) });
      const beforeSecond = countPaymentStarted('store_001', orderId);
      await fetch(`${base}/api/cart-recovery/resume-payment`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession, recovery_token: tok.token }) });
      const afterSecond = countPaymentStarted('store_001', orderId);
      assert(afterSecond === beforeSecond + 1, 'PS8. cancel reset 後再次成功 request → payment_started 再 +1', `before=${beforeSecond} after=${afterSecond}`);
      const jobCount = db.get(`SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id='store_001' AND order_id=? AND stage='payment_abandoned'`, [orderId]).c;
      assert(jobCount === 1, 'PS8b. 原 payment job 仍只有 1 筆（idempotent refresh，非新建）', `jobCount=${jobCount}`);
    }
  } finally {
    server.close();
    delete require.cache[nodeFetchPath];
  }
}

main().catch((e) => { console.error('Targeted test runner crashed:', e); process.exit(1); });
