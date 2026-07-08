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
  // LINE 接單與可售管理中心 v1
  'takeout_enabled', 'takeout_cutoff_time', 'takeout_prep_minutes',
  'takeout_allow_next_day', 'takeout_business_hours',
  'delivery_cutoff_time', 'delivery_prep_minutes',
  'delivery_allow_next_day', 'delivery_business_hours',
  'next_day_min_hours',
  // fix18-06: 今日臨時最後接單時間（有日期綁定，隔天自動失效）
  'takeout_today_cutoff_time', 'takeout_today_cutoff_date',
  'delivery_today_cutoff_time', 'delivery_today_cutoff_date',
  // Hotfix15 LINE 營業中心 V3：顧客可提前預訂天數（0~60，預設14）
  'line_preorder_days_limit',
  // Hotfix17：商家公告中心
  'line_announcement_enabled', 'line_announcement_type',
  'line_announcement_title', 'line_announcement_body', 'line_announcement_image_url',
  'line_announcement_button_text', 'line_announcement_button_action', 'line_announcement_button_url',
  'line_announcement_category_id', 'line_announcement_product_id',
  'line_announcement_start_date', 'line_announcement_end_date',
  'line_announcement_closable', 'line_announcement_display_mode',
  'line_announcement_frequency', 'line_announcement_version',
  'line_announcement_auto_holiday',
]);

// fix18-06：外送距離費率相關 key
const DELIVERY_FEE_KEYS = [
  'store_address', 'store_lat', 'store_lng',
  'delivery_distance_fee_enabled',
  'delivery_distance_fee_rules',   // JSON string
  'delivery_max_distance_km',
  'delivery_basic_fee',
  'delivery_free_threshold',
  'coupon_apply_to_delivery_fee',
];

// fix18-10-hotfix18：LINE 冷藏宅配中心 V1 設定 key
const SHIPPING_KEYS = [
  'shipping_enabled', 'shipping_title', 'shipping_description', 'shipping_notice',
  'shipping_storage_note', 'shipping_fee', 'shipping_free_threshold',
  'shipping_min_order_amount', 'shipping_arrival_days_limit', 'shipping_lead_days',
  'shipping_closed_weekdays', 'shipping_payment_methods', 'shipping_carrier_name',
  'shipping_allow_arrival_date', 'shipping_upsell_enabled',
];

// fix18-08：外送平台抽成率 key
const COMMISSION_KEYS = [
  'ubereats_commission_rate',
  'foodpanda_commission_rate',
  'line_commission_rate',
  'pos_commission_rate',
  'phone_commission_rate',
  'other_commission_rate',
  'unknown_commission_rate',
];

// 所有允許修改的 key（包含 LINE key）
const ALL_ALLOWED = [
  'shop_name', 'n8n_webhook_url', 'line_channel_token', 'tax_rate', 'receipt_footer',
  'printer_enabled', 'printer_type', 'printer_ip', 'printer_port',
  'printer_name', 'printer_share_name', 'auto_print', 'auto_drawer',
  'shop_logo', 'shop_cover', 'shop_address',
  'shop_google_map', 'shop_hours', 'shop_announcement',
  // Phase 3：AI 行銷中心 Brand Context
  'shop_slogan', 'shop_line_url', 'shop_facebook_url', 'shop_instagram_url',
  'brand_tone', 'brand_cta_template',
  'n8n_new_order_webhook', 'n8n_status_change_webhook',
  // v18-features: Android 平板功能權限（JSON 字串）
  'android_features',
  ...DELIVERY_FEE_KEYS,
  ...LINE_KEYS,
  ...COMMISSION_KEYS,
  ...SHIPPING_KEYS,
];

// GET /api/settings
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
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
    const storeId = req.storeId;

    // ── fix14：檢查是否修改 LINE key ───────────────────────
    const requestedKeys = Object.keys(req.body);
    const hasLineKey    = requestedKeys.some(k => LINE_KEYS.has(k) || SHIPPING_KEYS.includes(k));

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
