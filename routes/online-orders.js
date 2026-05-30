// routes/online-orders.js — SaaS R1 fix1（多店隔離版）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

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
    const storeId = req.storeId || 'store_001';
    const { status, limit = 200, offset = 0 } = req.query;
    let where = "WHERE store_id=? AND source='line'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND order_status=?'; params.push(status); }
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
    const storeId = req.storeId || 'store_001';
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
    const storeId = req.storeId || 'store_001';
    const order = findOrder(db, req.params.id, storeId);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    res.json({ success: true, data: { order_number: order.order_number, order_status: order.order_status, uuid: order.uuid } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
