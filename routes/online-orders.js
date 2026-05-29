/**
 * routes/online-orders.js  v18
 *
 * 直接掛載於 /api/online-orders，不透過 line-orders.js 的 /online 別名轉接。
 * 確保 PATCH /api/online-orders/:id/status 不會掉到 index.html fallback。
 */
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── Helper: 廣域查詢（uuid / order_number / id 任一符合）──────────────────────
function findOrder(db, rawId) {
  return db.get(
    `SELECT * FROM orders WHERE id=? OR uuid=? OR order_number=? LIMIT 1`,
    [rawId, rawId, rawId]
  );
}

// ── GET /api/online-orders  (同 line-orders /online)──────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const { status, limit = 200, offset = 0 } = req.query;
    let where = "WHERE source='line'";
    const params = [];
    if (status && status !== 'all') {
      where += ' AND order_status=?';
      params.push(status);
    }
    const orders = db.all(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ).map(o => ({
      ...o,
      items: typeof o.items === 'string' ? JSON.parse(o.items || '[]') : (o.items || [])
    }));
    const counts = db.all(
      `SELECT order_status, COUNT(*) as cnt FROM orders WHERE source='line' GROUP BY order_status`
    );
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c.order_status] = Number(c.cnt); });
    console.log('[GET /online] returning', orders.length, 'orders, statusCounts:', JSON.stringify(statusCounts));
    orders.forEach(o => console.log('[GET /online] order:', o.order_number, 'order_status=', o.order_status, 'uuid=', o.uuid));
    res.json({ success: true, data: orders, status_counts: statusCounts });
  } catch (e) {
    console.error('[GET /online] error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /api/online-orders/:id/status ──────────────────────────────────────
router.patch('/:id/status', (req, res) => {
  try {
    const db    = getDb();
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.order_status;

    console.log('[PATCH /online-orders/:id/status] === REQUEST ===');
    console.log('[PATCH /online-orders/:id/status] rawId  :', rawId);
    console.log('[PATCH /online-orders/:id/status] status :', newStatus);
    console.log('[PATCH /online-orders/:id/status] body   :', JSON.stringify(req.body));

    const valid = ['pending', 'accepted', 'preparing', 'ready', 'completed', 'cancelled'];
    if (!newStatus || !valid.includes(newStatus)) {
      return res.status(400).json({ success: false, error: 'INVALID_STATUS', status: newStatus });
    }

    // Step 1: 廣域查詢
    const order = findOrder(db, rawId);
    console.log('[PATCH /online-orders/:id/status] FOUND:',
      order ? `order_number=${order.order_number} uuid=${order.uuid} current=${order.order_status}` : 'NOT FOUND'
    );

    if (!order) {
      return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND', rawId });
    }

    const orderNo = order.order_number;
    const now     = new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');

    // Step 2: UPDATE — 三欄位全更新，用 order_number WHERE（最穩定）
    const result = db.run(
      `UPDATE orders SET status=?, order_status=?, kitchen_status=?, updated_at=? WHERE order_number=?`,
      [newStatus, newStatus, newStatus, now, orderNo]
    );

    console.log('[PATCH /online-orders/:id/status] UPDATE changes:', result.changes, 'orderNo:', orderNo);

    // Step 3: SELECT 驗證
    const verified = db.get(
      `SELECT id, uuid, order_number, status, order_status, kitchen_status, updated_at FROM orders WHERE order_number=?`,
      [orderNo]
    );
    console.log('[PATCH /online-orders/:id/status] VERIFY:', verified);

    if (!verified || verified.order_status !== newStatus) {
      console.error('[PATCH /online-orders/:id/status] ❌ VERIFY FAILED expected:', newStatus, 'got:', verified?.order_status);
      return res.status(500).json({
        success: false,
        error: 'VERIFY_FAILED',
        expected: newStatus,
        actual: verified?.order_status
      });
    }

    console.log('[PATCH /online-orders/:id/status] ✅ SUCCESS order_status=', verified.order_status);

    // Step 4: WSS broadcast
    try {
      const wss = req.app.get('wss');
      const fullOrder = db.get('SELECT * FROM orders WHERE order_number=?', [orderNo]);
      if (wss && fullOrder) {
        const msg = JSON.stringify({ type: 'order_status_changed', order: fullOrder });
        let sent = 0;
        wss.clients.forEach(c => { if (c.readyState === 1) { c.send(msg); sent++; } });
        console.log('[PATCH /online-orders/:id/status] WSS broadcast to', sent, 'clients');
      }
    } catch (wssErr) {
      console.warn('[PATCH /online-orders/:id/status] WSS error:', wssErr.message);
    }

    res.json({ success: true, data: verified });

  } catch (e) {
    console.error('[PATCH /online-orders/:id/status] ERROR:', e.message, e.stack);
    res.status(500).json({ success: false, error: 'INTERNAL_ERROR', message: e.message });
  }
});

// ── GET /api/online-orders/:id/status (健康檢查 / 狀態查詢)──────────────────
router.get('/:id/status', (req, res) => {
  try {
    const db    = getDb();
    const order = findOrder(db, req.params.id);
    if (!order) return res.status(404).json({ success: false, error: 'ORDER_NOT_FOUND' });
    res.json({ success: true, data: { order_number: order.order_number, order_status: order.order_status, uuid: order.uuid } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
