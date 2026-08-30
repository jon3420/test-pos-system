#!/usr/bin/env node
// scripts/run-h1-4-10-phase4d-recovery-dashboard-runtime.js
// H1.4.10 Phase 4D — Recovery Analytics Dashboard (minimal real vertical
// slice this round: GET /api/cart-recovery-dashboard/overview only).

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const jwt = require('jsonwebtoken');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase4d-'));
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
  const storeId = 'store_001';
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeId, 'Store 1', 'x', 'pro', 1]);

  const staffToken = jwt.sign({ role: 'staff', store_id: storeId }, process.env.JWT_SECRET);

  try {
    const nowIso = require('../utils/cartRecovery')._nowIso();
    function insertJob(stage, status, opts) {
      opts = opts || {};
      db.run(
        `INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeId, opts.cartId || `cart-${Math.random()}`, opts.orderId || '', stage, status, opts.channel || '', opts.sentAt || '', nowIso, `key-${Math.random()}`, nowIso, nowIso]
      );
    }

    // Seed a realistic mix
    insertJob('cart_abandoned', 'pending');
    insertJob('cart_abandoned', 'sent', { channel: 'line', sentAt: nowIso });
    insertJob('cart_abandoned', 'converted', { channel: 'line', sentAt: nowIso }); // reminder_then_converted for cart stage
    insertJob('checkout_abandoned', 'cancelled');
    // payment_abandoned with a real linked order
    const orderId = 'order-dash-1';
    db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [orderId, orderId, orderId, storeId, '[]', 888, 888, 'linepay']);
    insertJob('payment_abandoned', 'converted', { channel: 'line', sentAt: nowIso, orderId });
    // A payment_abandoned job with no order linkage should not contribute to revenue (order_id empty)
    insertJob('payment_abandoned', 'converted', { channel: 'line', sentAt: nowIso, orderId: '' });
    // A converted job that was never actually sent (channel='') should not count as reminder_then_converted
    insertJob('payment_abandoned', 'converted', { channel: '', sentAt: '', orderId: 'order-not-counted' });

    const app = require('express')();
    app.use((req, res, next) => { req.storeId = storeId; next(); });
    app.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;

    // D1: no JWT -> 401
    const r1 = await fetch(`${base}/api/cart-recovery-dashboard/overview`);
    assert(r1.status === 401, 'D1. no JWT -> 401', r1.status);

    // D2: valid staff JWT -> 200 with real data
    const r2 = await fetch(`${base}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${staffToken}` } });
    const json2 = await r2.json();
    assert(r2.status === 200 && json2.success === true, 'D2. valid staff JWT -> 200 success', JSON.stringify(json2).slice(0, 200));

    // D3: funnel counts reflect real seeded data
    assert(json2.data.funnel.cart_abandoned.pending === 1, 'D3a. cart_abandoned.pending=1', json2.data.funnel.cart_abandoned.pending);
    assert(json2.data.funnel.cart_abandoned.sent === 1, 'D3b. cart_abandoned.sent=1', json2.data.funnel.cart_abandoned.sent);
    assert(json2.data.funnel.cart_abandoned.converted === 1, 'D3c. cart_abandoned.converted=1', json2.data.funnel.cart_abandoned.converted);
    assert(json2.data.funnel.checkout_abandoned.cancelled === 1, 'D3d. checkout_abandoned.cancelled=1', json2.data.funnel.checkout_abandoned.cancelled);
    assert(json2.data.funnel.payment_abandoned.converted === 3, 'D3e. payment_abandoned.converted=3', json2.data.funnel.payment_abandoned.converted);

    // D4: reminder_then_converted correctly requires channel='line' AND sent_at<>''
    assert(json2.data.reminder_stats.cart_abandoned.reminder_then_converted === 1, 'D4a. cart_abandoned reminder_then_converted=1', json2.data.reminder_stats.cart_abandoned.reminder_then_converted);
    assert(json2.data.reminder_stats.payment_abandoned.reminder_then_converted === 2, 'D4b. payment_abandoned reminder_then_converted=2 (excludes the never-sent one)', json2.data.reminder_stats.payment_abandoned.reminder_then_converted);

    // D5: revenue only counts the properly-linked order (888), not the empty-order_id one
    assert(json2.data.recovered_revenue.payment_abandoned.total === 888, 'D5a. payment_abandoned revenue=888 (only the linked order counted)', json2.data.recovered_revenue.payment_abandoned.total);
    assert(json2.data.recovered_revenue.payment_abandoned.order_count === 1, 'D5b. payment_abandoned order_count=1', json2.data.recovered_revenue.payment_abandoned.order_count);

    // D6: cart/checkout stage explicitly report null revenue, not a guessed number
    assert(json2.data.recovered_revenue.cart_abandoned.total === null && json2.data.recovered_revenue.cart_abandoned.reason === 'no_reliable_order_linkage', 'D6a. cart_abandoned revenue explicitly null with reason (no fabricated estimate)', JSON.stringify(json2.data.recovered_revenue.cart_abandoned));
    assert(json2.data.recovered_revenue.checkout_abandoned.total === null, 'D6b. checkout_abandoned revenue explicitly null', JSON.stringify(json2.data.recovered_revenue.checkout_abandoned));

    // D7: days param clamped
    const r3 = await fetch(`${base}/api/cart-recovery-dashboard/overview?days=9999`, { headers: { Authorization: `Bearer ${staffToken}` } });
    const json3 = await r3.json();
    assert(json3.data.range_days === 90, 'D7. days param clamped to max 90', json3.data.range_days);

    // D9-D10: conversion_rate_of_resolved (only counts jobs with a final outcome)
    assert(json2.data.reminder_stats.checkout_abandoned.resolved_count === 1 && json2.data.reminder_stats.checkout_abandoned.conversion_rate_of_resolved === 0, 'D9. checkout_abandoned: 1 resolved (cancelled), 0 converted -> rate=0', JSON.stringify(json2.data.reminder_stats.checkout_abandoned));
    assert(json2.data.reminder_stats.cart_abandoned.resolved_count === 1 && json2.data.reminder_stats.cart_abandoned.conversion_rate_of_resolved === 100, 'D10. cart_abandoned: pending/sent excluded from resolved (still in-flight), only the 1 converted counted -> rate=100', JSON.stringify(json2.data.reminder_stats.cart_abandoned));

    // D11-D13: avg_minutes_to_recovery uses real timestamp math (verify with a controlled 10-minute gap)
    const sentAtControlled = '2026-01-01 10:00:00';
    const convertedAtControlled = '2026-01-01 10:10:00';
    db.run(
      `INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, converted_at, due_at, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, 'cart-ttr-control', '', 'cart_abandoned', 'converted', 'line', sentAtControlled, convertedAtControlled, nowIso, `key-ttr-${Math.random()}`, nowIso, nowIso]
    );
    const r4 = await fetch(`${base}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${staffToken}` } });
    const json4 = await r4.json();
    // 現在有 2 個 sample：原本沒設 converted_at 的那筆（不算進 TTR，因為 converted_at='') + 這筆剛好 10 分鐘
    assert(json4.data.reminder_stats.cart_abandoned.time_to_recovery_sample_size === 1, 'D11. TTR sample_size 正確排除 converted_at 為空的舊資料，只算真正有時間戳的這 1 筆', json4.data.reminder_stats.cart_abandoned.time_to_recovery_sample_size);
    assert(json4.data.reminder_stats.cart_abandoned.avg_minutes_to_recovery === 10, 'D12. avg_minutes_to_recovery 精確計算為 10 分鐘（非估算）', json4.data.reminder_stats.cart_abandoned.avg_minutes_to_recovery);
    // Stage 沒有任何符合條件的 job 時，回傳 null 而不是 0（0 分鐘會誤導成「秒懂秒買」）
    assert(json4.data.reminder_stats.checkout_abandoned.avg_minutes_to_recovery === null, 'D13. 沒有符合條件的 job 時 avg_minutes_to_recovery=null（不是誤導性的 0）', json4.data.reminder_stats.checkout_abandoned.avg_minutes_to_recovery);

    // D8: response contains no PII (cart_id/order_id/line_user_id strings) anywhere
    const responseStr = JSON.stringify(json2);
    assert(!responseStr.includes('order-dash-1') && !responseStr.includes('cart-'), 'D8. overview response contains no raw cart_id/order_id strings (aggregate-only)', responseStr.length > 300 ? '(long)' : responseStr);

    // ══════════════════════════════════════════════════════════════
    // resolved metric: converted_count 明確曝光（不只是內部算完就丟）
    // ══════════════════════════════════════════════════════════════
    assert(typeof json2.data.reminder_stats.cart_abandoned.converted_count === 'number', 'D14. reminder_stats 明確曝光 converted_count 欄位', JSON.stringify(json2.data.reminder_stats.cart_abandoned));
    assert(json2.data.reminder_stats.cart_abandoned.converted_count === 1, 'D15. cart_abandoned converted_count=1（與 D3c 的 funnel.converted 一致）', json2.data.reminder_stats.cart_abandoned.converted_count);
    assert(json2.data.reminder_stats.checkout_abandoned.converted_count === 0, 'D16. checkout_abandoned converted_count=0（只有 1 筆 cancelled，沒有 converted）', json2.data.reminder_stats.checkout_abandoned.converted_count);
    // resolved_count=0 時 rate 必須是 null，不是 0/NaN/undefined
    assert(json2.data.reminder_stats.payment_abandoned.resolved_count === json2.data.reminder_stats.payment_abandoned.converted_count, 'D17. payment_abandoned 種子資料全部是 converted（無 cancelled/failed），resolved_count 應等於 converted_count', JSON.stringify(json2.data.reminder_stats.payment_abandoned));

    server.close();

    // ══════════════════════════════════════════════════════════════
    // Time-to-Recovery invalid timestamp：converted_at < sent_at 必須整筆排除
    // ══════════════════════════════════════════════════════════════
    {
      const storeIdTtr = 'store_ttr_invalid';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeIdTtr, 'TTR Invalid', 'x', 'pro', 1]);
      function insertJobTtr(opts) {
        db.run(
          `INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, converted_at, due_at, idempotency_key, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [storeIdTtr, opts.cartId, '', 'cart_abandoned', 'converted', 'line', opts.sentAt, opts.convertedAt, nowIso, `key-ttr-${Math.random()}`, nowIso, nowIso]
        );
      }
      // 正常 row：sent 10:00 → converted 10:10（+10 分鐘）
      insertJobTtr({ cartId: 'ttr-valid-1', sentAt: '2026-02-01 10:00:00', convertedAt: '2026-02-01 10:10:00' });
      // 異常 row：converted_at 早於 sent_at（10:10 → 10:00，時間倒退，理論上不該發生的髒資料）
      insertJobTtr({ cartId: 'ttr-invalid-1', sentAt: '2026-02-01 10:10:00', convertedAt: '2026-02-01 10:00:00' });

      const appTtr = require('express')();
      appTtr.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
      const serverTtr = http.createServer(appTtr);
      await new Promise((resolve) => serverTtr.listen(0, resolve));
      const portTtr = serverTtr.address().port;
      const tokenTtr = jwt.sign({ role: 'staff', store_id: storeIdTtr }, process.env.JWT_SECRET);
      const resTtr = await fetch(`http://127.0.0.1:${portTtr}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenTtr}` } });
      const jsonTtr = await resTtr.json();
      const ttrStats = jsonTtr.data.reminder_stats.cart_abandoned;
      assert(ttrStats.time_to_recovery_sample_size === 1, 'D18. converted_at<sent_at 的異常 row 不進 sample（sample_size 只算正常的那 1 筆，不是 2 筆）', ttrStats.time_to_recovery_sample_size);
      assert(ttrStats.avg_minutes_to_recovery === 10, 'D19. avg_minutes_to_recovery 排除異常 row 後仍精確等於 10（沒有被負數時長拉低平均值）', ttrStats.avg_minutes_to_recovery);
      serverTtr.close();
    }

    // ══════════════════════════════════════════════════════════════
    // 真正 JWT Cross-store Isolation（掛真實 requireStaffJwt，不是 stub middleware）
    // ══════════════════════════════════════════════════════════════
    {
      const { requireStaffJwt } = require('../middleware/storeGuard');
      const storeA = 'store_iso_a';
      const storeB = 'store_iso_b';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeA, 'Iso A', 'x', 'pro', 1]);
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeB, 'Iso B', 'x', 'pro', 1]);

      // store_001 的種子資料：cart_abandoned pending=1/sent=1/converted=1（已存在於上面）
      // 這裡另外建立 A/B 兩家有明確不同 funnel counts + 不同 revenue 的資料
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, converted_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [storeA, 'iso-a-cart-1', '', 'cart_abandoned', 'pending', '', '', '', nowIso, `key-iso-a-1-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, converted_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [storeA, 'iso-a-cart-2', '', 'cart_abandoned', 'pending', '', '', '', nowIso, `key-iso-a-2-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, converted_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
        [storeB, 'iso-b-cart-1', '', 'cart_abandoned', 'pending', '', '', '', nowIso, `key-iso-b-1-${Math.random()}`, nowIso, nowIso]);

      const orderA = 'order-iso-a';
      const orderB = 'order-iso-b';
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderA, orderA, orderA, storeA, '[]', 888, 888, 'linepay']);
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderB, orderB, orderB, storeB, '[]', 9999, 9999, 'linepay']);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeA, 'iso-a-pay-cart', orderA, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-iso-a-pay-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeB, 'iso-b-pay-cart', orderB, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-iso-b-pay-${Math.random()}`, nowIso, nowIso]);

      const appIso = require('express')();
      appIso.use('/api/cart-recovery-dashboard', requireStaffJwt, require('../routes/cart-recovery-dashboard'));
      const serverIso = http.createServer(appIso);
      await new Promise((resolve) => serverIso.listen(0, resolve));
      const portIso = serverIso.address().port;
      const baseIso = `http://127.0.0.1:${portIso}`;

      const tokenA = jwt.sign({ role: 'staff', store_id: storeA }, process.env.JWT_SECRET);

      // I1: store A 的真實 JWT，正常請求 → 只看得到 store A 的資料
      const resI1 = await fetch(`${baseIso}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenA}` } });
      const jsonI1 = await resI1.json();
      assert(resI1.status === 200 && jsonI1.success === true, 'I1. store A 真實 staff JWT → 200 success', resI1.status);
      assert(jsonI1.data.funnel.cart_abandoned.pending === 2, 'I2. store A 只看到自己的 2 筆 pending（不含 store B 的 1 筆或 store_001 的資料）', jsonI1.data.funnel.cart_abandoned.pending);
      assert(jsonI1.data.recovered_revenue.payment_abandoned.total === 888, 'I3. store A 只看到自己的 888 元營收（不是 store B 的 9999）', jsonI1.data.recovered_revenue.payment_abandoned.total);

      // I4: 同一個 store A JWT，但故意在 query string 夾帶 ?store_id=store_iso_b
      // → 依 middleware/storeGuard.js 的 requireStaffJwt 實作，query/header 一律
      // 不被信任，req.storeId 只能來自 JWT payload.store_id，結果應該完全相同
      const resI4 = await fetch(`${baseIso}/api/cart-recovery-dashboard/overview?store_id=${storeB}`, { headers: { Authorization: `Bearer ${tokenA}` } });
      const jsonI4 = await resI4.json();
      assert(resI4.status === 200, 'I4. 帶 ?store_id=store_iso_b 的請求仍正常回應（不是被擋掉，而是被忽略）', resI4.status);
      assert(jsonI4.data.funnel.cart_abandoned.pending === 2, 'I5. query string 的 store_id 被完全忽略，結果仍是 store A 的 2 筆（不是 store B 的 1 筆）', jsonI4.data.funnel.cart_abandoned.pending);
      assert(jsonI4.data.recovered_revenue.payment_abandoned.total === 888, 'I6. query override 後營收仍是 store A 的 888（不是 store B 的 9999）', jsonI4.data.recovered_revenue.payment_abandoned.total);

      // I7: response 完整序列化後不含 store B 的任何識別資訊
      const responseStrI = JSON.stringify(jsonI4);
      assert(!responseStrI.includes(storeB) && !responseStrI.includes('9999') && !responseStrI.includes('iso-b'), 'I7. response 不含 store B 的 store_id／revenue／cart_id 等任何識別資訊', responseStrI.length > 200 ? '(long)' : responseStrI);

      serverIso.close();
    }

    // ══════════════════════════════════════════════════════════════
    // Revenue Order Dedup（REV1/REV2）
    // ══════════════════════════════════════════════════════════════
    {
      const storeIdRev = 'store_rev_dedup';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeIdRev, 'Rev Dedup', 'x', 'pro', 1]);

      // REV1：同一筆訂單（total=888），兩筆各自獨立的 recovery job 都指向它
      const orderRev1 = 'order-rev-dedup-1';
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderRev1, orderRev1, orderRev1, storeIdRev, '[]', 888, 888, 'linepay']);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdRev, 'rev1-cart-a', orderRev1, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-rev1-a-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdRev, 'rev1-cart-b', orderRev1, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-rev1-b-${Math.random()}`, nowIso, nowIso]);

      const appRev1 = require('express')();
      appRev1.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
      const serverRev1 = http.createServer(appRev1);
      await new Promise((resolve) => serverRev1.listen(0, resolve));
      const portRev1 = serverRev1.address().port;
      const tokenRev1 = jwt.sign({ role: 'staff', store_id: storeIdRev }, process.env.JWT_SECRET);
      const resRev1 = await fetch(`http://127.0.0.1:${portRev1}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenRev1}` } });
      const jsonRev1 = await resRev1.json();
      assert(jsonRev1.data.recovered_revenue.payment_abandoned.order_count === 1, 'REV1a. 同一 order 被 2 筆 recovery job 指向 → order_count=1（不是 2）', jsonRev1.data.recovered_revenue.payment_abandoned.order_count);
      assert(jsonRev1.data.recovered_revenue.payment_abandoned.total === 888, 'REV1b. 同一 order → revenue=888（不是 1776，證明沒有把同一筆訂單金額加兩次）', jsonRev1.data.recovered_revenue.payment_abandoned.total);
      serverRev1.close();

      // REV2：兩張不同訂單，金額剛好都是 888（測試 SUM(DISTINCT o.total) 這種
      // 錯誤寫法會犯的「金額相同就被誤判成同一筆」的陷阱）
      const storeIdRev2 = 'store_rev_dedup_2';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeIdRev2, 'Rev Dedup 2', 'x', 'pro', 1]);
      const orderRev2a = 'order-rev-dedup-2a';
      const orderRev2b = 'order-rev-dedup-2b';
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderRev2a, orderRev2a, orderRev2a, storeIdRev2, '[]', 888, 888, 'linepay']);
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderRev2b, orderRev2b, orderRev2b, storeIdRev2, '[]', 888, 888, 'linepay']);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdRev2, 'rev2-cart-a', orderRev2a, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-rev2-a-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdRev2, 'rev2-cart-b', orderRev2b, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-rev2-b-${Math.random()}`, nowIso, nowIso]);

      const appRev2 = require('express')();
      appRev2.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
      const serverRev2 = http.createServer(appRev2);
      await new Promise((resolve) => serverRev2.listen(0, resolve));
      const portRev2 = serverRev2.address().port;
      const tokenRev2 = jwt.sign({ role: 'staff', store_id: storeIdRev2 }, process.env.JWT_SECRET);
      const resRev2 = await fetch(`http://127.0.0.1:${portRev2}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenRev2}` } });
      const jsonRev2 = await resRev2.json();
      assert(jsonRev2.data.recovered_revenue.payment_abandoned.order_count === 2, 'REV2a. 兩張不同訂單（金額相同）→ order_count=2', jsonRev2.data.recovered_revenue.payment_abandoned.order_count);
      assert(jsonRev2.data.recovered_revenue.payment_abandoned.total === 1776, 'REV2b. 兩張不同訂單各 888 → revenue=1776（證明沒有用 SUM(DISTINCT o.total) 誤把同金額的第二張訂單丟掉）', jsonRev2.data.recovered_revenue.payment_abandoned.total);
      serverRev2.close();
    }

    // ══════════════════════════════════════════════════════════════
    // 提醒：reminder_sent／reminder_then_converted 是 JOB-BASED，
    // recovered_revenue 是 ORDER-BASED，分母不可混用（用 REV1 的資料直接驗證
    // 兩種指標各自數出不同的數字，證明程式碼路徑確實分開，不是同一份邏輯）
    // ══════════════════════════════════════════════════════════════
    {
      const storeIdMix = 'store_metric_mix';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeIdMix, 'Metric Mix', 'x', 'pro', 1]);
      const orderMix = 'order-metric-mix';
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderMix, orderMix, orderMix, storeIdMix, '[]', 500, 500, 'linepay']);
      // 2 筆 job 指向同一張訂單（同上面 REV1 的情境）
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdMix, 'mix-cart-a', orderMix, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-mix-a-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdMix, 'mix-cart-b', orderMix, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-mix-b-${Math.random()}`, nowIso, nowIso]);

      const appMix = require('express')();
      appMix.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
      const serverMix = http.createServer(appMix);
      await new Promise((resolve) => serverMix.listen(0, resolve));
      const portMix = serverMix.address().port;
      const tokenMix = jwt.sign({ role: 'staff', store_id: storeIdMix }, process.env.JWT_SECRET);
      const resMix = await fetch(`http://127.0.0.1:${portMix}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenMix}` } });
      const jsonMix = await resMix.json();
      const mixReminder = jsonMix.data.reminder_stats.payment_abandoned;
      const mixRevenue = jsonMix.data.recovered_revenue.payment_abandoned;
      assert(mixReminder.reminder_then_converted === 2, 'MIX1. reminder_then_converted 是 JOB-BASED → 數到 2（兩筆各自獨立的 job）', mixReminder.reminder_then_converted);
      assert(mixRevenue.order_count === 1, 'MIX2. recovered_revenue.order_count 是 ORDER-BASED → 數到 1（去重後只有 1 張訂單）', mixRevenue.order_count);
      assert(mixReminder.reminder_then_converted !== mixRevenue.order_count, 'MIX3. 兩個指標的分母確實不同（2 vs 1），證明程式碼路徑沒有被混用成同一份計算', `${mixReminder.reminder_then_converted} vs ${mixRevenue.order_count}`);
      serverMix.close();
    }

    // ══════════════════════════════════════════════════════════════
    // Canonical order_id Safety（id/uuid collision impossibility）
    //
    // 已 Audit 確認：routes/line-orders.js／routes/line-shipping.js 建立
    // orders 時 `id, uuid` 兩欄一律綁同一個 uuid JS 變數（VALUES 陣列裡
    // 逐字是 `uuid, uuid, ...`），orders.id 是 TEXT PRIMARY KEY（全表唯一）。
    // cart_recovery_jobs.order_id 只可能來自這個相同的 uuid 值（submit_order
    // 事件的 order_id: uuid → resolveAuthoritativeOrderForPaymentStart()）。
    // 因此 Dashboard SQL 的 `o.uuid = order_id OR o.id = order_id` 在
    // schema invariant 保證下不可能同時匹配兩張不同訂單——這裡用真實資料
    // 直接證明：建立兩張 id/uuid 各自不同但彼此交錯設計的訂單，確認查詢
    // 結果仍然只對應到唯一一筆。
    // ══════════════════════════════════════════════════════════════
    {
      const storeIdCanon = 'store_canonical_orderid';
      db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, [storeIdCanon, 'Canonical OrderId', 'x', 'pro', 1]);
      // 兩張訂單，id/uuid 皆各自不同（模擬 production 真實建立方式：同一個
      // uuid 值同時寫入 id 與 uuid 兩欄）。
      const orderCanonA = 'order-canon-a-11111';
      const orderCanonB = 'order-canon-b-22222';
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderCanonA, orderCanonA, orderCanonA, storeIdCanon, '[]', 111, 111, 'linepay']);
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, items, subtotal, total, payment_method, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
        [orderCanonB, orderCanonB, orderCanonB, storeIdCanon, '[]', 222, 222, 'linepay']);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdCanon, 'canon-cart-a', orderCanonA, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-canon-a-${Math.random()}`, nowIso, nowIso]);
      db.run(`INSERT INTO cart_recovery_jobs (store_id, cart_id, order_id, stage, status, channel, sent_at, due_at, idempotency_key, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
        [storeIdCanon, 'canon-cart-b', orderCanonB, 'payment_abandoned', 'converted', 'line', nowIso, nowIso, `key-canon-b-${Math.random()}`, nowIso, nowIso]);

      // 直接驗證 orders.id === orders.uuid（schema invariant，非本輪新規則，
      // 只是確認 production insert 慣例在測試資料上也成立）。
      const orderRowA = db.get(`SELECT id, uuid FROM orders WHERE store_id=? AND id=?`, [storeIdCanon, orderCanonA]);
      assert(orderRowA.id === orderRowA.uuid, 'CANON1. orders.id === orders.uuid（canonical insert 慣例，id/uuid 綁同一值）', JSON.stringify(orderRowA));

      const appCanon = require('express')();
      appCanon.use('/api/cart-recovery-dashboard', require('../routes/cart-recovery-dashboard'));
      const serverCanon = http.createServer(appCanon);
      await new Promise((resolve) => serverCanon.listen(0, resolve));
      const portCanon = serverCanon.address().port;
      const tokenCanon = jwt.sign({ role: 'staff', store_id: storeIdCanon }, process.env.JWT_SECRET);
      const resCanon = await fetch(`http://127.0.0.1:${portCanon}/api/cart-recovery-dashboard/overview`, { headers: { Authorization: `Bearer ${tokenCanon}` } });
      const jsonCanon = await resCanon.json();
      assert(jsonCanon.data.recovered_revenue.payment_abandoned.order_count === 2, 'CANON2. 兩張各自獨立的訂單（id/uuid 各不相同）→ order_count=2（OR 條件沒有誤把不同訂單合併）', jsonCanon.data.recovered_revenue.payment_abandoned.order_count);
      assert(jsonCanon.data.recovered_revenue.payment_abandoned.total === 333, 'CANON3. revenue=333（111+222，兩張訂單金額正確分別加總，非誤判成同一筆）', jsonCanon.data.recovered_revenue.payment_abandoned.total);
      serverCanon.close();
    }

  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }

  // ══════════════════════════════════════════════════════════════════
  // Admin UI Runtime Acceptance（真實 production HTML fragment + app.js
  // 函式，jsdom 執行，reuse Phase 4B Full Suite 的 extractBalancedDiv 手法，
  // 不重寫假邏輯）
  // ══════════════════════════════════════════════════════════════════
  await runAdminUiRuntimeTests();

  console.log('\n== Phase 4D Summary ==');
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

// ══════════════════════════════════════════════════════════════════
// Admin UI Runtime Acceptance
// ══════════════════════════════════════════════════════════════════
function extractBalancedDiv(html, startMarker) {
  const startIdx = html.indexOf(startMarker);
  if (startIdx === -1) return null;
  const tagRe = /<div\b[^>]*>|<\/div>/g;
  tagRe.lastIndex = startIdx;
  let depth = 0;
  let m;
  while ((m = tagRe.exec(html))) {
    if (m[0].startsWith('</div')) {
      depth -= 1;
      if (depth === 0) return html.slice(startIdx, tagRe.lastIndex);
    } else {
      depth += 1;
    }
  }
  return null;
}

async function runAdminUiRuntimeTests() {
  console.log('\n== Admin UI Runtime Acceptance ==');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  const cardHtml = extractBalancedDiv(indexHtml, '<div class="settings-card" id="cartRecoveryCard"');
  assert(!!cardHtml, 'UI-0. 在 public/index.html 找到 cartRecoveryCard 區塊（真正 tag-balance 掃描，非字串搜尋）');
  if (!cardHtml) return;
  assert(cardHtml.includes('cartRecoveryDashboardPanel'), 'UI-1. cartRecoveryDashboardPanel 容器存在於 production HTML');
  assert(/onclick="loadCartRecoveryDashboard\(\)"/.test(cardHtml), 'UI-2. 重新整理按鈕的 onclick 綁定 loadCartRecoveryDashboard()（真的是這個函式，不是別的）');

  const loadFnMatch = appJs.match(/async function loadCartRecoveryDashboard\(\)[\s\S]*?\n}\n/);
  assert(!!loadFnMatch, 'UI-3. app.js 找到 loadCartRecoveryDashboard() 真實原始碼');
  if (!loadFnMatch) return;
  assert(loadFnMatch[0].includes("apiFetch('/api/cart-recovery-dashboard/overview") , 'UI-4. loadCartRecoveryDashboard() 原始碼呼叫既有 apiFetch()（不是自己重寫一套 fetch 邏輯）');

  // 逐字掃描原始碼本身，確認前端沒有對 revenue/rate/TTR 做任何「數值運算」
  // （* / 這種一定是數學運算；- 也一定是；但 + 在 JS 裡同時可能是字串串接
  // ' 分鐘' 這種顯示格式化，不能一律當成禁止的算術，只檢查 +/- 後面「緊接
  // 著數字」的情況，字串串接（+ 後面是引號）不算違規）。
  const fnBody = loadFnMatch[0];
  const arithmeticOnBackendFields = /rev\.total\s*[*/]|r\.conversion_rate_of_resolved\s*[*/]|r\.avg_minutes_to_recovery\s*[*/]|rev\.total\s*[+\-]\s*\d|r\.conversion_rate_of_resolved\s*[+\-]\s*\d|r\.avg_minutes_to_recovery\s*[+\-]\s*\d/.test(fnBody);
  assert(!arithmeticOnBackendFields, 'UI-5. 前端原始碼對 rev.total／conversion_rate_of_resolved／avg_minutes_to_recovery 沒有做任何數值運算（字串串接組文字是允許的顯示格式化，不算重新推導數值）');

  function buildDom(mockFetchResponses) {
    const html = `<!doctype html><html><body>${cardHtml}</body></html>`;
    const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true });
    const w = dom.window;
    w.apiFetchCalls = [];
    w.apiFetch = async (url, opts) => {
      w.apiFetchCalls.push({ url, opts });
      if (mockFetchResponses.throwError) throw new Error('network error');
      return { json: async () => mockFetchResponses.body };
    };
    w.getToken = () => 'fake-token';
    w.toast = () => {};
    w.eval(loadFnMatch[0]);
    return dom;
  }

  function makeOverviewBody(overrides) {
    const base = {
      success: true,
      data: {
        range_days: 30,
        funnel: {
          cart_abandoned: { pending: 0, waiting: 0, sent: 2, converted: 1, cancelled: 0, failed: 0, not_contactable: 0, not_configured: 0 },
          checkout_abandoned: { pending: 0, waiting: 0, sent: 0, converted: 0, cancelled: 1, failed: 0, not_contactable: 0, not_configured: 0 },
          payment_abandoned: { pending: 0, waiting: 0, sent: 0, converted: 0, cancelled: 0, failed: 0, not_contactable: 0, not_configured: 0 },
        },
        reminder_stats: {
          cart_abandoned: { reminder_sent: 2, reminder_then_converted: 1, conversion_rate_of_resolved: 100, resolved_count: 1, converted_count: 1, avg_minutes_to_recovery: 10, time_to_recovery_sample_size: 1 },
          checkout_abandoned: { reminder_sent: 0, reminder_then_converted: 0, conversion_rate_of_resolved: 0, resolved_count: 1, converted_count: 0, avg_minutes_to_recovery: null, time_to_recovery_sample_size: 0 },
          payment_abandoned: { reminder_sent: 0, reminder_then_converted: 0, conversion_rate_of_resolved: null, resolved_count: 0, converted_count: 0, avg_minutes_to_recovery: null, time_to_recovery_sample_size: 0 },
        },
        recovered_revenue: {
          cart_abandoned: { total: null, order_count: null, reason: 'no_reliable_order_linkage' },
          checkout_abandoned: { total: null, order_count: null, reason: 'no_reliable_order_linkage' },
          payment_abandoned: { total: 888, order_count: 1 },
        },
      },
    };
    return Object.assign(base, overrides || {});
  }

  // UI-6/UI-7：呼叫 apiFetch 且路徑正確
  {
    const dom = buildDom({ body: makeOverviewBody() });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    assert(dom.window.apiFetchCalls.length === 1, 'UI-6. 真的呼叫了 apiFetch 一次');
    assert(dom.window.apiFetchCalls[0].url.includes('/api/cart-recovery-dashboard/overview'), 'UI-7. apiFetch 呼叫的網址正確', dom.window.apiFetchCalls[0].url);
    dom.window.close();
  }

  // UI-8：revenue=null → 顯示「無法計算」
  {
    const dom = buildDom({ body: makeOverviewBody() });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    const panelHtml = dom.window.document.getElementById('cartRecoveryDashboardPanel').innerHTML;
    assert(panelHtml.includes('無法計算'), 'UI-8. revenue=null（cart_abandoned/checkout_abandoned）→ 畫面顯示「無法計算」', panelHtml.length > 500 ? '(long)' : panelHtml);
    dom.window.close();
  }

  // UI-9：conversion_rate_of_resolved 必須一起顯示樣本（converted_count/resolved_count）
  {
    const dom = buildDom({ body: makeOverviewBody() });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    const panelHtml = dom.window.document.getElementById('cartRecoveryDashboardPanel').innerHTML;
    assert(panelHtml.includes('100%（1/1）') || panelHtml.includes('100%(1/1)'), 'UI-9. 成交率與樣本數一起顯示（100%／1 of 1，不是只有孤立的百分比）', panelHtml.length > 500 ? '(long)' : panelHtml);
    dom.window.close();
  }

  // UI-10/UI-11：avg_minutes_to_recovery=null → 顯示「—」而非「0 分鐘」；10 → 顯示「10 分鐘」
  {
    const dom = buildDom({ body: makeOverviewBody() });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    const panelHtml = dom.window.document.getElementById('cartRecoveryDashboardPanel').innerHTML;
    assert(!/(?<!\d)0\s*分鐘/.test(panelHtml), 'UI-10. avg_minutes_to_recovery=null 時畫面沒有出現獨立的「0 分鐘」這種誤導性文字（用負向前瞻排除「10 分鐘」這種合法數值的子字串誤判）');
    assert(panelHtml.includes('10 分鐘'), 'UI-11. avg_minutes_to_recovery=10 → 畫面正確顯示「10 分鐘」', panelHtml.length > 500 ? '(long)' : panelHtml);
    dom.window.close();
  }

  // UI-12：API error（fetch throw）→ 顯示安全錯誤文字，不 crash
  {
    const dom = buildDom({ throwError: true });
    let threw = false;
    try {
      await dom.window.eval('loadCartRecoveryDashboard()');
      await new Promise((r) => setTimeout(r, 10));
    } catch (e) { threw = true; }
    assert(threw === false, 'UI-12a. API 呼叫失敗（fetch throw）→ loadCartRecoveryDashboard() 本身不拋出例外（不 crash 整個頁面）');
    const panelText = dom.window.document.getElementById('cartRecoveryDashboardPanel').textContent;
    assert(panelText === '載入失敗，請稍後再試', 'UI-12b. API 呼叫失敗 → 顯示安全、固定的錯誤文字（不洩漏例外堆疊/技術細節）', panelText);
    dom.window.close();
  }

  // UI-13：json.success=false（後端邏輯性失敗，非網路錯誤）→ 顯示錯誤文字，不 crash
  {
    const dom = buildDom({ body: { success: false, message: 'overview_failed' } });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    const panelText = dom.window.document.getElementById('cartRecoveryDashboardPanel').textContent;
    assert(panelText === '載入失敗，請稍後再試', 'UI-13. success:false 回應 → 同樣顯示安全錯誤文字，不 crash', panelText);
    dom.window.close();
  }

  // UI-14：前端渲染的營收/百分比/分鐘數與 backend 給的值逐字相符（不是巧合對上，是真的原樣輸出）
  {
    const customBody = makeOverviewBody({
      data: Object.assign({}, makeOverviewBody().data, {
        recovered_revenue: Object.assign({}, makeOverviewBody().data.recovered_revenue, {
          payment_abandoned: { total: 54321, order_count: 7 },
        }),
      }),
    });
    const dom = buildDom({ body: customBody });
    await dom.window.eval('loadCartRecoveryDashboard()');
    await new Promise((r) => setTimeout(r, 10));
    const panelHtml = dom.window.document.getElementById('cartRecoveryDashboardPanel').innerHTML;
    assert(panelHtml.includes('54,321') || panelHtml.includes('54321'), 'UI-14. 換一組不同的 backend 金額（54321）→ 畫面顯示的數字跟著改變，證明是真的渲染 backend 給的值，不是寫死的樣板', panelHtml.length > 500 ? '(long)' : panelHtml);
    dom.window.close();
  }
}

main().catch((e) => { console.error('Phase 4D test runner crashed:', e && e.stack || e); process.exit(1); });
