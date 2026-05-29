// routes/kitchen.js — KDS 廚房顯示端點 (v13)
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── GET /api/kitchen/orders ───────────────────────────────────────────────
// 取得待製作 / 製作中訂單（廚房平板顯示用）
router.get('/orders', (req, res) => {
  try {
    const db = getDb();
    const orders = db.all(
      `SELECT id, order_number, order_mode, order_status,
              kitchen_status, table_number, pickup_name,
              customer_name,
              delivery_platform, platform_order_no,
              items, note, created_at
       FROM orders
       WHERE kitchen_status IN ('pending','preparing')
         AND status NOT IN ('void')
         AND order_status NOT IN ('cancelled')
       ORDER BY created_at ASC`
    );

    const result = orders.map(o => {
      let parsedItems = [];
      try { parsedItems = JSON.parse(o.items || '[]'); } catch {}
      return { ...o, items: parsedItems };
    });

    res.json({ success: true, data: result });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/kitchen/orders/:id/status ────────────────────────────────────
// 廚房更新製作狀態
// Body: { status: 'pending' | 'preparing' | 'done' }
router.put('/orders/:id/status', (req, res) => {
  try {
    const db = getDb();
    const { status } = req.body;
    const valid = ['pending', 'preparing', 'done'];
    if (!valid.includes(status)) {
      return res.status(400).json({ success: false, message: '無效狀態值，可用：pending / preparing / done' });
    }
    const now = new Date().toISOString();
    db.run(
      `UPDATE orders SET kitchen_status=?, updated_at=? WHERE id=?`,
      [status, now, req.params.id]
    );
    res.json({ success: true, message: '製作狀態已更新', status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/kitchen/done ─────────────────────────────────────────────────
// 已完成訂單（叫號用，最近 30 筆）
router.get('/done', (req, res) => {
  try {
    const db = getDb();
    const orders = db.all(
      `SELECT id, order_number, order_mode, kitchen_status, pickup_name, table_number, created_at
       FROM orders
       WHERE kitchen_status = 'done'
         AND status != 'void'
       ORDER BY updated_at DESC
       LIMIT 30`
    );
    res.json({ success: true, data: orders });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
