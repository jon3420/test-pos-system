// routes/settings.js — v16 整合版
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

router.get('/', (req, res) => {
  try {
    const db   = getDb();
    const rows = db.all('SELECT key, value FROM settings');
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    res.json({ success: true, data: settings });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

router.put('/', (req, res) => {
  try {
    const db      = getDb();
    const allowed = [
      'shop_name', 'n8n_webhook_url', 'line_channel_token', 'tax_rate', 'receipt_footer',
      'printer_enabled', 'printer_type', 'printer_ip', 'printer_port',
      'printer_name', 'printer_share_name', 'auto_print', 'auto_drawer',
      // LINE 點餐基本設定
      'shop_logo', 'shop_cover', 'shop_address',
      'shop_google_map', 'shop_hours', 'shop_announcement',
      'line_order_enabled', 'line_order_min_amount',
      'n8n_new_order_webhook', 'n8n_status_change_webhook',
      // v16 整合新增
      'line_ordering_enabled',
      'line_business_hours_enabled',
      'line_business_hours',
      'pickup_enabled',
      'delivery_enabled',
      'pickup_business_hours_enabled',
      'delivery_business_hours_enabled',
      'line_today_closed',
      'line_today_closed_date',
      // 預約取餐進階設定
      'same_day_preorder_minutes',
      'next_day_preorder_hours',
      'line_closed_weekdays',
      'line_closed_dates',
      // LINE 付款方式開關
      'line_payment_cash_enabled',
      'line_payment_linepay_enabled',
      'line_payment_transfer_enabled',
      'line_payment_platform_enabled',
      'line_payment_credit_card_enabled',
    ];
    allowed.forEach(k => {
      if (req.body[k] !== undefined) {
        const ex = db.get('SELECT key FROM settings WHERE key=?', [k]);
        if (ex) db.run('UPDATE settings SET value=? WHERE key=?', [String(req.body[k]), k]);
        else    db.run('INSERT INTO settings (key,value) VALUES (?,?)', [k, String(req.body[k])]);
      }
    });
    // 廣播設定更新（讓 LINE 頁面即時反應）
    try {
      const wss = req.app.get('wss');
      if (wss) {
        const rows2 = db.all('SELECT key, value FROM settings');
        const s = {};
        rows2.forEach(r => { s[r.key] = r.value; });
        const msg = JSON.stringify({ type: 'settings_updated', data: s });
        wss.clients?.forEach(c => { if (c.readyState === 1) c.send(msg); });
      }
    } catch {}
    const rows = db.all('SELECT key, value FROM settings');
    const s    = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: s });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
