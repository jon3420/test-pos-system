// routes/online-orders.js — SaaS R1 fix1（多店隔離版）+ fix18-02 confirm-payment
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

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
router.patch('/:id/status', (req, res) => {
  try {
    const db    = getDb();
    const storeId = req.storeId;
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.order_status;

    const valid = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!newStatus || !valid.includes(newStatus))
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', status: newStatus });

    const order = findOrder(db, rawId, storeId);
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', rawId });

    const orderNo = order.order_number;
    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');

    db.run(
      `UPDATE orders SET status=?, order_status=?, kitchen_status=?, updated_at=? WHERE order_number=? AND store_id=?`,
      [newStatus, newStatus, newStatus, now, orderNo, storeId]
    );

    const verified = db.get(
      `SELECT id, uuid, order_number, status, order_status, kitchen_status, updated_at FROM orders WHERE order_number=? AND store_id=?`,
      [orderNo, storeId]
    );

    if (!verified || verified.order_status !== newStatus)
      return res.status(500).json({ success: false, error: 'VERIFY_FAILED', expected: newStatus, actual: verified?.order_status });

    try {
      const wss = req.app.get('wss');
      const fullOrder = db.get('SELECT * FROM orders WHERE order_number=? AND store_id=?', [orderNo, storeId]);
      // ★ fix6：只廣播給同 store_id 的 WebSocket client
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: fullOrder });
    } catch {}

    res.json({ success: true, data: verified });
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

    const order = findOrder(db, rawId, storeId);
    if (!order)
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', rawId });

    // 只處理 LINE Pay
    if (order.payment_method !== 'linepay')
      return res.status(400).json({ success: false, error: 'NOT_LINEPAY', payment_method: order.payment_method });

    // 已付款不重複操作
    if (order.payment_status === 'paid')
      return res.status(400).json({ success: false, error: 'ALREADY_PAID', payment_status: order.payment_status });

    const now = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
    db.run(
      `UPDATE orders SET
        payment_status='paid',
        paid_at=?,
        payment_confirm_source='manual',
        payment_confirm_note='現場確認收款',
        payment_confirm_by=?,
        updated_at=?
       WHERE order_number=? AND store_id=?`,
      [now, deviceId, now, order.order_number, storeId]
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
        confirm_source: 'manual'
      });
      broadcastToStore(wss, storeId, { type: 'order_status_changed', order: updated });
    } catch(e) { console.error('[confirm-payment] broadcast error:', e.message); }

    res.json({ success: true, data: { order_number: order.order_number, payment_status: 'paid', paid_at: now } });
  } catch(e) {
    console.error('[confirm-payment] error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
