// routes/settings.js — SaaS R1（多店隔離版）
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');

// GET /api/settings
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// PUT /api/settings
router.put('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId || 'store_001';
    const allowed = [
      'shop_name', 'n8n_webhook_url', 'line_channel_token', 'tax_rate', 'receipt_footer',
      'printer_enabled', 'printer_type', 'printer_ip', 'printer_port',
      'printer_name', 'printer_share_name', 'auto_print', 'auto_drawer',
      'shop_logo', 'shop_cover', 'shop_address',
      'shop_google_map', 'shop_hours', 'shop_announcement',
      'line_order_enabled', 'line_order_min_amount',
      'n8n_new_order_webhook', 'n8n_status_change_webhook',
      'line_ordering_enabled', 'line_business_hours_enabled', 'line_business_hours',
      'pickup_enabled', 'delivery_enabled',
      'pickup_business_hours_enabled', 'delivery_business_hours_enabled',
      'line_today_closed', 'line_today_closed_date',
      'same_day_preorder_minutes', 'next_day_preorder_hours',
      'line_closed_weekdays', 'line_closed_dates',
      'line_payment_cash_enabled', 'line_payment_linepay_enabled',
      'line_payment_transfer_enabled', 'line_payment_platform_enabled',
      'line_payment_credit_card_enabled',
    ];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        const ex = db.get('SELECT id FROM settings WHERE store_id=? AND key=?', [storeId, k]);
        if (ex) db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(req.body[k]), storeId, k]);
        else    db.run('INSERT INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, String(req.body[k])]);
      }
    });
    try {
      const wss   = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s     = {};
      rows2.forEach(r => { s[r.key] = r.value; });
      // ★ fix6：只廣播給同 store_id 的 WebSocket client
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: s });
    } catch {}
    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: s });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
