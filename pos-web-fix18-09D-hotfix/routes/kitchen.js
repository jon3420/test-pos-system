// routes/kitchen.js — SaaS R1 fix1（多店隔離版）
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// GET /api/kitchen/orders
router.get('/orders', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const orders = db.all(
      `SELECT id, order_number, order_mode, order_status,
              kitchen_status, table_number, pickup_name,
              customer_name, delivery_platform, platform_order_no,
              items, note, created_at
       FROM orders
       WHERE store_id=?
         AND kitchen_status IN ('pending','preparing')
         AND status NOT IN ('void')
         AND order_status NOT IN ('cancelled')
       ORDER BY created_at ASC`,
      [storeId]
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

// PUT /api/kitchen/orders/:id/status
router.put('/orders/:id/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { status } = req.body;
    const valid = ['pending', 'preparing', 'done'];
    if (!valid.includes(status))
      return res.status(400).json({ success: false, message: '無效狀態值，可用：pending / preparing / done' });
    // 確認訂單屬於此店
    const order = db.get('SELECT id FROM orders WHERE id=? AND store_id=?', [req.params.id, storeId]);
    if (!order) return res.status(404).json({ success: false, message: '訂單不存在' });
    const now = new Date().toISOString();
    db.run(`UPDATE orders SET kitchen_status=?, updated_at=? WHERE id=? AND store_id=?`,
      [status, now, req.params.id, storeId]);
    res.json({ success: true, message: '製作狀態已更新', status });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/kitchen/done
router.get('/done', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const orders = db.all(
      `SELECT id, order_number, order_mode, kitchen_status, pickup_name, table_number, created_at
       FROM orders
       WHERE store_id=? AND kitchen_status='done' AND status != 'void'
       ORDER BY updated_at DESC LIMIT 30`,
      [storeId]
    );
    res.json({ success: true, data: orders });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
