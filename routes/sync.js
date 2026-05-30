// routes/sync.js — SaaS R1 fix1（多店隔離版）
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// GET /api/sync/config  — Android 啟動時下載最新設定
router.get('/config', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const products       = db.all('SELECT * FROM products WHERE store_id=? AND enabled=1 ORDER BY sort_order, id', [storeId]);
    const categories     = db.all('SELECT * FROM categories WHERE store_id=? AND is_active=1 ORDER BY sort_order, id', [storeId]);
    const paymentMethods = db.all('SELECT * FROM payment_methods WHERE store_id=? AND is_active=1 ORDER BY sort_order, id', [storeId]);
    const platforms      = db.all('SELECT * FROM delivery_platforms WHERE store_id=? AND is_active=1 ORDER BY id', [storeId]);
    const settingsRows   = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const settings = {};
    settingsRows.forEach(s => { settings[s.key] = s.value; });

    res.json({
      success: true,
      data: { products, categories, paymentMethods, platforms, settings },
      store_id: storeId,
      synced_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// POST /api/sync/orders  — Android 批次上傳離線訂單
router.post('/orders', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const { device_id, orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0)
      return res.json({ success: true, synced: 0, failed: 0, duplicate: 0, results: [] });

    // 登記裝置
    if (device_id) {
      const now = new Date().toISOString();
      const existing = db.get('SELECT id FROM devices WHERE device_id=? AND store_id=?', [device_id, storeId]);
      if (existing) {
        db.run('UPDATE devices SET last_seen_at=? WHERE device_id=? AND store_id=?', [now, device_id, storeId]);
      } else {
        db.run('INSERT INTO devices (store_id,device_id,last_seen_at) VALUES (?,?,?)', [storeId, device_id, now]);
      }
    }

    const results = [];

    for (const order of orders) {
      const uuid = order.uuid || null;

      // 防重複（限 store_id 範圍）
      if (uuid) {
        const existing = db.get('SELECT id FROM orders WHERE store_id=? AND uuid=?', [storeId, uuid]);
        if (existing) {
          results.push({ uuid, status: 'duplicate', message: '已存在，跳過' });
          continue;
        }
      }

      try {
        const orderNo     = order.order_no || order.orderNumber || order.order_number || ('SYNC-' + Date.now());
        const orderMode   = order.order_type || order.orderMode  || order.order_mode  || 'dine_in';
        const items       = typeof order.items === 'string' ? order.items : JSON.stringify(order.items || []);
        const subtotal    = Number(order.subtotal)       || 0;
        const total       = Number(order.total)          || 0;
        const discType    = order.discount_type  || order.discountType  || 'none';
        const discAmount  = Number(order.discount_amount || order.discountAmount)  || 0;
        const payMethod   = order.payment_method || order.paymentMethod || 'cash';
        const payStatus   = order.payment_status || order.paymentStatus || 'paid';
        const rcvAmt      = Number(order.received_amount || order.receivedAmount)  || 0;
        const chgAmt      = Number(order.change_amount   || order.changeAmount)    || 0;
        const ordStatus   = order.order_status   || order.status         || 'completed';
        const commRate    = Number(order.commission_rate         || order.platformCommissionRate)   || 0;
        const commAmt     = Number(order.commission_amount       || order.platformCommissionAmount) || 0;
        const storeIncome = Number(order.store_revenue           || order.storeActualIncome)        || (total - commAmt);
        const createdAt   = order.created_at     || order.createdAt      || new Date().toISOString();
        const now         = new Date().toISOString();

        db.run(
          `INSERT INTO orders (
            store_id, uuid, order_number, order_mode, order_status,
            table_number, guest_count, pickup_name, pickup_time,
            customer_name, customer_phone,
            delivery_platform, platform_order_no, delivery_address, estimated_delivery,
            items, subtotal, discount_type, discount_amount, delivery_fee, total,
            platform_commission_rate, platform_commission_amount, store_actual_income,
            payment_method, payment_status, received_amount, change_amount,
            note, sync_status, device_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            storeId, uuid, orderNo, orderMode, ordStatus,
            order.table_no || order.tableNumber || order.table_number || '',
            Number(order.people_count || order.guestCount) || 0,
            order.pickup_name || order.pickupName || '',
            order.pickup_time || order.pickupTime || '',
            order.customer_name || order.customerName || '',
            order.customer_phone || order.customerPhone || '',
            order.delivery_platform || order.deliveryPlatform || '',
            order.platform_order_no || order.platformOrderNo || '',
            order.delivery_address || order.deliveryAddress || '',
            order.delivery_time || order.estimatedDelivery || '',
            items, subtotal, discType, discAmount,
            Number(order.delivery_fee || order.deliveryFee) || 0, total,
            commRate, commAmt, storeIncome,
            payMethod, payStatus, rcvAmt, chgAmt,
            order.note || '', 'synced',
            device_id || order.device_id || '',
            createdAt, now
          ]
        );
        results.push({ uuid, status: 'synced' });
      } catch (insertErr) {
        console.error('[sync] insert error:', insertErr.message, 'uuid:', uuid);
        results.push({ uuid, status: 'failed', message: insertErr.message });
      }
    }

    const synced    = results.filter(r => r.status === 'synced').length;
    const failed    = results.filter(r => r.status === 'failed').length;
    const duplicate = results.filter(r => r.status === 'duplicate').length;

    res.json({ success: true, synced, failed, duplicate, results });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/sync/status
router.get('/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const deviceStats = db.all(
      `SELECT device_id,
              COUNT(*) as total_orders,
              SUM(CASE WHEN sync_status='synced' THEN 1 ELSE 0 END) as synced,
              SUM(CASE WHEN sync_status='pending' THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN sync_status='failed'  THEN 1 ELSE 0 END) as failed,
              MAX(created_at) as last_order_at
       FROM orders
       WHERE store_id=? AND device_id != ''
       GROUP BY device_id`,
      [storeId]
    );
    const devices = db.all('SELECT * FROM devices WHERE store_id=? ORDER BY last_seen_at DESC', [storeId]);
    res.json({ success: true, data: { deviceStats, devices } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
