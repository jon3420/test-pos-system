// routes/sync.js  — Android POS 離線同步端點 (v13)
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── GET /api/sync/config ──────────────────────────────────────────────────
// Android 啟動時下載最新設定（商品 / 分類 / 付款方式 / 外送平台 / 設定）
router.get('/config', (req, res) => {
  try {
    const db = getDb();
    const products       = db.all('SELECT * FROM products WHERE enabled=1 ORDER BY sort_order, id');
    const categories     = db.all('SELECT * FROM categories WHERE is_active=1 ORDER BY sort_order, id');
    const paymentMethods = db.all('SELECT * FROM payment_methods WHERE is_active=1 ORDER BY sort_order, id');
    // 正確使用資料表名稱 delivery_platforms
    const platforms      = db.all('SELECT * FROM delivery_platforms WHERE is_active=1 ORDER BY id');
    const settingsRows   = db.all('SELECT key, value FROM settings');
    const settings = {};
    settingsRows.forEach(s => { settings[s.key] = s.value; });

    res.json({
      success: true,
      data: { products, categories, paymentMethods, platforms, settings },
      synced_at: new Date().toISOString()
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/sync/orders ─────────────────────────────────────────────────
// Android 批次上傳離線訂單
// Body: { device_id: string, orders: Order[] }
router.post('/orders', (req, res) => {
  try {
    const db = getDb();
    const { device_id, orders } = req.body;

    if (!Array.isArray(orders) || orders.length === 0) {
      return res.json({ success: true, synced: 0, failed: 0, duplicate: 0, results: [] });
    }

    // 登記或更新裝置最後上線時間
    if (device_id) {
      const now = new Date().toISOString();
      const existing = db.get('SELECT id FROM devices WHERE device_id=?', [device_id]);
      if (existing) {
        db.run('UPDATE devices SET last_seen_at=? WHERE device_id=?', [now, device_id]);
      } else {
        db.run('INSERT INTO devices (device_id, last_seen_at) VALUES (?,?)', [device_id, now]);
      }
    }

    const results = [];

    for (const order of orders) {
      const uuid = order.uuid || null;

      // 防重複：uuid 已存在就跳過
      if (uuid) {
        const existing = db.get('SELECT id FROM orders WHERE uuid=?', [uuid]);
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
            uuid, order_number, order_mode, order_status,
            table_number, guest_count,
            pickup_name, pickup_time,
            customer_name, customer_phone,
            delivery_platform, platform_order_no, delivery_address, estimated_delivery,
            items, subtotal, discount_type, discount_amount, delivery_fee, total,
            platform_commission_rate, platform_commission_amount, store_actual_income,
            payment_method, payment_status, received_amount, change_amount,
            note, sync_status, device_id, created_at, updated_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            uuid, orderNo, orderMode, ordStatus,
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
        console.error('[sync] insert error:', insertErr.message, 'order uuid:', uuid);
        results.push({ uuid, status: 'failed', message: insertErr.message });
      }
    }

    const synced    = results.filter(r => r.status === 'synced').length;
    const failed    = results.filter(r => r.status === 'failed').length;
    const duplicate = results.filter(r => r.status === 'duplicate').length;

    console.log(`[sync] device=${device_id} total=${orders.length} synced=${synced} failed=${failed} duplicate=${duplicate}`);

    res.json({ success: true, synced, failed, duplicate, results });
  } catch (e) {
    console.error('[sync] error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── GET /api/sync/status ──────────────────────────────────────────────────
// 查詢各裝置同步狀態（管理後台用）
router.get('/status', (req, res) => {
  try {
    const db = getDb();
    const deviceStats = db.all(
      `SELECT device_id,
              COUNT(*) as total_orders,
              SUM(CASE WHEN sync_status='synced' THEN 1 ELSE 0 END) as synced,
              SUM(CASE WHEN sync_status='pending' THEN 1 ELSE 0 END) as pending,
              SUM(CASE WHEN sync_status='failed'  THEN 1 ELSE 0 END) as failed,
              MAX(created_at) as last_order_at
       FROM orders
       WHERE device_id != ''
       GROUP BY device_id`
    );
    const devices = db.all('SELECT * FROM devices ORDER BY last_seen_at DESC');
    res.json({ success: true, data: { deviceStats, devices } });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
