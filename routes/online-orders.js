// routes/online-orders.js — SaaS R1 fix1（多店隔離版）+ fix18-02 confirm-payment
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { applyOrderStatusChange } = require('../utils/orderStatusFlow'); // hotfix13：Android 呼叫的這支 API，跟 Web 共用同一份取消/退款/回補邏輯

// ── fix18-02：safe migration，啟動時確保 confirm-payment 相關欄位存在 ──
function ensureConfirmPaymentColumns(db) {
  const cols = [
    "ALTER TABLE orders ADD COLUMN paid_at TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN payment_confirm_source TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN payment_confirm_note TEXT DEFAULT ''",
    "ALTER TABLE orders ADD COLUMN payment_confirm_by TEXT DEFAULT ''",
  ];
  cols.forEach(sql => { try { db.run(sql); } catch {} });
}

// 廣域查詢（限 store_id 範圍）
function findOrder(db, rawId, storeId) {
  return db.get(
    `SELECT * FROM orders WHERE store_id=? AND (id=? OR uuid=? OR order_number=?) LIMIT 1`,
    [storeId, rawId, rawId, rawId]
  );
}

// GET /api/online-orders
router.get('/', (req, res) => {
  try {
    const db = getDb();
    ensureConfirmPaymentColumns(db);
    const storeId = req.storeId;
    const { status, limit = 200, offset = 0, date } = req.query;
    let where = "WHERE store_id=? AND source='line'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND order_status=?'; params.push(status); }
    // fix18-01 支援：date 參數過濾（Android OrdersFragment 合併 LINE 訂單用）
    if (date) { where += ' AND DATE(created_at)=?'; params.push(date); }
    const orders = db.all(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ).map(o => ({
      ...o,
      items: typeof o.items === 'string' ? JSON.parse(o.items || '[]') : (o.items || [])
    }));
    const counts = db.all(
      `SELECT order_status, COUNT(*) as cnt FROM orders WHERE store_id=? AND source='line' GROUP BY order_status`,
      [storeId]
    );
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c.order_status] = Number(c.cnt); });
    res.json({ success: true, data: orders, status_counts: statusCounts });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// PATCH /api/online-orders/:id/status
// hotfix13-BUG4/5/6/7：這支是 Android 平板實際呼叫的狀態變更 API。
// 過去這裡自己寫了一份「只更新欄位」的邏輯，跟 orders.js／line-orders.js 兩份都不一樣，
// 取消訂單時既不會回補庫存、也不會處理 LINE Pay 待退款。
// 現在改成呼叫 utils/orderStatusFlow.applyOrderStatusChange()，
// 三支路由（也就是 Web 後台 + Android 平板）共用同一份商業邏輯，行為保證一致。
router.patch('/:id/status', (req, res) => {
  try {
    const db    = getDb();
    const storeId = req.storeId;
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.order_status;

    const order = findOrder(db, rawId, storeId);
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', rawId });

    const result = applyOrderStatusChange(db, storeId, order, newStatus);
    if (!result.ok) {
      return res.status(result.code).json({ success: false, error: 'INVALID_STATUS', message: result.message, status: newStatus });
    }

    const orderNo = order.order_number;
    const verified = db.get(
      `SELECT id, uuid, order_number, status, order_status, kitchen_status, updated_at, refund_status FROM orders WHERE order_number=? AND store_id=?`,
      [orderNo, storeId]
    );

    if (!verified || verified.order_status !== newStatus)
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED', expected: newStatus, actual: verified?.order_status });

    try {
      const wss = req.app.get('wss');
      const fullOrder = result.data;
      // ★ fix6：只廣播給同 store_id 的 WebSocket client
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: fullOrder });
      if (newStatus === 'accepted') {
        broadcastToStore(wss, storeId, { type: 'new_line_order', order: fullOrder });
      }
    } catch {}

    res.json({
      success: true,
      data: verified,
      requires_refund: result.requiresRefund,
      message: result.message,
    });
  } catch (e) {
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// GET /api/online-orders/:id/status
router.get('/:id/status', (req, res) => {
  try {
    const db    = getDb();
    const storeId = req.storeId;
    const order = findOrder(db, req.params.id, storeId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    res.json({ success: true, data: { order_number: order.order_number, order_status: order.order_status, uuid: order.uuid } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// PATCH /api/online-orders/:id/confirm-payment
// 現場確認收款（LINE Pay pending → paid）
// fix18-02
// ══════════════════════════════════════════════════════════
router.patch('/:id/confirm-payment', (req, res) => {
  try {
    const db      = getDb();
    ensureConfirmPaymentColumns(db);
    const storeId = req.storeId;
    const rawId   = req.params.id;
    const deviceId = req.headers['x-device-id'] || req.body?.device_id || 'unknown';
    // hotfix13-BUG3：允許同時把付款方式改成現金（例如客人臨櫃改付現金），
    // 單一 API 給 Web 跟 Android 共用，不必為了「LinePay 改現金」另外複製一套邏輯。
    const { payment_method } = req.body || {};

    const order = findOrder(db, rawId, storeId);
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', rawId });

    // 只處理 LINE Pay 待確認的訂單（改現金也只適用「原本是 LinePay 且尚未付款」的情境）
    if (order.payment_method !== 'linepay')
      return res.status(400).json({ success: false, error: 'NOT_LINEPAY', payment_method: order.payment_method });

    // 已付款不重複操作（但允許已付款訂單事後校正付款方式？— 不允許，避免帳務混亂，維持原邏輯）
    if (order.payment_status === 'paid')
      return res.status(400).json({ success: false, error: 'ALREADY_PAID', payment_status: order.payment_status });

    const finalPaymentMethod = payment_method === 'cash' ? 'cash' : order.payment_method;
    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET
        payment_method=?,
        payment_category=?,
        payment_status='paid',
        paid_at=?,
        payment_confirm_source='manual',
        payment_confirm_note=?,
        payment_confirm_by=?,
        updated_at=?
       WHERE order_number=? AND store_id=?`,
      [finalPaymentMethod, finalPaymentMethod === 'cash' ? 'cash' : 'non_cash', now,
       finalPaymentMethod === 'cash' ? '現場確認收款（改現金付款）' : '現場確認收款', deviceId, now,
       order.order_number, storeId]
    );

    const updated = db.get('SELECT * FROM orders WHERE order_number=? AND store_id=?', [order.order_number, storeId]);

    // 廣播給 Web POS
    try {
      const wss = req.app.get('wss');
      broadcastToStore(wss, storeId, {
        type:           'linepay_paid',
        order_uuid:     order.uuid,
        order_number:   order.order_number,
        payment_status: 'paid',
        payment_method: finalPaymentMethod,
        confirm_source: 'manual'
      });
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: updated });
    } catch(e) { console.error('[confirm-payment] broadcast error:', e.message); }

    res.json({
      success: true,
      data: { order_number: order.order_number, payment_method: finalPaymentMethod, payment_status: 'paid', paid_at: now },
      // hotfix13-BUG3：告訴呼叫端（Web / Android）現在是現金付款，該去開錢櫃了
      is_cash_now: finalPaymentMethod === 'cash',
    });
  } catch(e) {
    console.error('[confirm-payment] error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
