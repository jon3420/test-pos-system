// routes/settings.js — SaaS R1 fix14
// fix14：LINE 相關設定 key 需通過 line_order feature gate
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { getStoreLicense }  = require('../middleware/featureGate');

// LINE 相關設定 key — line_order=false 時不可修改
const LINE_KEYS = new Set([
  'line_order_enabled', 'line_order_min_amount',
  'line_ordering_enabled', 'line_business_hours_enabled', 'line_business_hours',
  'pickup_enabled', 'delivery_enabled',
  'pickup_business_hours_enabled', 'delivery_business_hours_enabled',
  'line_today_closed', 'line_today_closed_date',
  'same_day_preorder_minutes', 'next_day_preorder_hours',
  'line_closed_weekdays', 'line_closed_dates',
  'line_payment_cash_enabled', 'line_payment_linepay_enabled',
  'line_payment_transfer_enabled', 'line_payment_platform_enabled',
  'line_payment_credit_card_enabled',
]);

// 所有允許修改的 key（包含 LINE key）
const ALL_ALLOWED = [
  'shop_name', 'n8n_webhook_url', 'line_channel_token', 'tax_rate', 'receipt_footer',
  'printer_enabled', 'printer_type', 'printer_ip', 'printer_port',
  'printer_name', 'printer_share_name', 'auto_print', 'auto_drawer',
  'shop_logo', 'shop_cover', 'shop_address',
  'shop_google_map', 'shop_hours', 'shop_announcement',
  'n8n_new_order_webhook', 'n8n_status_change_webhook',
  ...LINE_KEYS,
];

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
    const db      = getDb();
    const storeId = req.storeId || 'store_001';

    // ── fix14：檢查是否修改 LINE key ───────────────────────
    const requestedKeys = Object.keys(req.body);
    const hasLineKey    = requestedKeys.some(k => LINE_KEYS.has(k));

    if (hasLineKey) {
      // 查授權
      const lic = getStoreLicense(storeId);
      if (!lic.active) {
        return res.status(403).json({
          success: false, error: 'LICENSE_INACTIVE',
          message: '此店家授權已停用，請聯絡系統管理員'
        });
      }
      if (!lic.features.line_order) {
        return res.status(403).json({
          success: false, error: 'FEATURE_DISABLED',
          feature: 'line_order',
          message: '此功能未授權，請聯絡系統管理員升級方案（LINE 點餐設定需 line_order 授權）'
        });
      }
    }

    // ── 寫入允許的 key ─────────────────────────────────────
    ALL_ALLOWED.forEach(k => {
      if (req.body[k] !== undefined) {
        const updated = db.run(
          'UPDATE settings SET value=? WHERE store_id=? AND key=?',
          [String(req.body[k]), storeId, k]
        );
        if (!updated.changes) {
          db.run(
            'INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)',
            [storeId, k, String(req.body[k])]
          );
        }
      }
    });

    // ── WebSocket broadcast ───────────────────────────────
    try {
      const wss   = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s     = {};
      rows2.forEach(r => { s[r.key] = r.value; });
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: s });
    } catch {}

    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: s });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
