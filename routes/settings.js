// routes/settings.js — SaaS R1 fix14
// fix14：LINE 相關設定 key 需通過 line_order feature gate
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { getStoreLicense }  = require('../middleware/featureGate');
// fix18-10-hotfix23-E1：line_member_return_url allowlist 驗證
const { validateLineMemberReturnUrl } = require('../utils/returnUrlValidator');

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
  // fix18-10-hotfix22A：付款方式改為與冷藏宅配一致的「通路獨立開關」架構（JSON 陣列，
  // 例如 '["cash","linepay","transfer"]'）。未設定時，後端會自動 fallback 沿用上面的
  // 全域 line_payment_*_enabled 設定，確保既有店家設定不受影響、行為不變。
  'takeout_payment_methods', 'delivery_payment_methods',
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

// fix18-10-hotfix21：冷藏宅配「物流 API 設定架構預留」key（V1 只做架構，不串接正式物流商）
const SHIPPING_API_KEYS = [
  'shipping_api_enabled', 'shipping_provider', 'shipping_api_key', 'shipping_api_secret',
  'shipping_customer_id', 'shipping_sender_name', 'shipping_sender_phone',
  'shipping_sender_address', 'shipping_test_mode',
];

// fix18-10-hotfix22D：冷藏宅配公告 key — 與 LINE_KEYS 內的 line_announcement_* 完全獨立，
// 不共用、不互相覆蓋（見 routes/line-shipping.js getShippingAnnouncement()）。
const SHIPPING_ANNOUNCEMENT_KEYS = [
  'shipping_announcement_enabled', 'shipping_announcement_type',
  'shipping_announcement_title', 'shipping_announcement_body', 'shipping_announcement_image_url',
  'shipping_announcement_button_text', 'shipping_announcement_button_action', 'shipping_announcement_button_url',
  'shipping_announcement_start_date', 'shipping_announcement_end_date',
  'shipping_announcement_closable', 'shipping_announcement_display_mode',
  'shipping_announcement_frequency', 'shipping_announcement_version',
  'shipping_announcement_auto_holiday',
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

// fix18-10-hotfix23-D：廣告追蹤設定（Meta Pixel／GA4）。刻意不放 CAPI Access Token／
// Test Event Code——本版沒有實作 Conversion API，避免店家誤以為已經完成串接
// （需求文件五／需求文件八）。Pixel ID、Measurement ID 本身不是密鑰，前端本來就會明碼
// 嵌入頁面，GET /api/settings 照既有行為原樣回傳沒有額外風險。
const ANALYTICS_KEYS = [
  'analytics_meta_pixel_enabled', 'analytics_meta_pixel_id',
  'analytics_ga4_enabled', 'analytics_ga4_measurement_id',
];

// fix18-10-hotfix23-E：LINE 會員入口設定 key
const LINE_MEMBER_KEYS = [
  'line_member_gate_enabled', 'line_member_gate_mode', 'line_member_require_friend',
  'line_member_allow_skip', 'line_member_add_friend_url', 'line_member_basic_id',
  'line_member_login_channel_id', 'line_member_liff_id', 'line_member_return_url',
  'line_member_title', 'line_member_description', 'line_member_friend_button_text',
  'line_member_login_button_text', 'line_member_skip_button_text',
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
  ...SHIPPING_API_KEYS,
  ...SHIPPING_ANNOUNCEMENT_KEYS,
  ...ANALYTICS_KEYS,
  ...LINE_MEMBER_KEYS,
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
    const hasLineKey    = requestedKeys.some(k => LINE_KEYS.has(k) || SHIPPING_KEYS.includes(k) || SHIPPING_API_KEYS.includes(k) || SHIPPING_ANNOUNCEMENT_KEYS.includes(k) || LINE_MEMBER_KEYS.includes(k));

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

    // ── fix18-10-hotfix23-D：廣告追蹤 ID 基本格式驗證（需求文件五第 2 點）──
    // 只在有實際送值時才驗證；空字串（清空設定）永遠允許。
    if (req.body.analytics_meta_pixel_id !== undefined && String(req.body.analytics_meta_pixel_id).trim() !== '') {
      if (!/^\d{6,20}$/.test(String(req.body.analytics_meta_pixel_id).trim())) {
        return res.status(400).json({ success: false, message: 'Meta Pixel ID 格式錯誤（應為 6~20 位數字）' });
      }
    }
    if (req.body.analytics_ga4_measurement_id !== undefined && String(req.body.analytics_ga4_measurement_id).trim() !== '') {
      if (!/^G-[A-Z0-9]{6,12}$/i.test(String(req.body.analytics_ga4_measurement_id).trim())) {
        return res.status(400).json({ success: false, message: 'GA4 Measurement ID 格式錯誤（應為 G- 開頭，例如 G-XXXXXXXXXX）' });
      }
    }

    // ── fix18-10-hotfix23-E：LINE 會員入口設定驗證（需求文件四）───────────
    // 只在有實際送值 / 有啟用時才擋，未啟用時允許欄位保留舊值不清除。
    if (Object.keys(req.body).some(k => LINE_MEMBER_KEYS.includes(k))) {
      const existingRows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const existing = {}; existingRows.forEach(r => { existing[r.key] = r.value; });
      const merged = { ...existing, ...req.body };

      const gateEnabled = String(merged.line_member_gate_enabled) === '1' || merged.line_member_gate_enabled === true;
      if (gateEnabled) {
        if (!merged.line_member_liff_id || !String(merged.line_member_liff_id).trim()) {
          return res.status(400).json({ success: false, message: '啟用 LINE 會員入口時，LIFF ID 不可空白' });
        }
        if (!merged.line_member_login_channel_id || !String(merged.line_member_login_channel_id).trim()) {
          return res.status(400).json({ success: false, message: '啟用 LINE 會員入口時，LINE Login Channel ID 不可空白' });
        }
      }
      const friendUrl = merged.line_member_add_friend_url ? String(merged.line_member_add_friend_url).trim() : '';
      if (friendUrl && !/^https:\/\/(lin\.ee\/|line\.me\/)/i.test(friendUrl)) {
        return res.status(400).json({ success: false, message: '加好友網址格式錯誤（必須是 https://lin.ee/ 或 https://line.me/ 開頭）' });
      }
      const basicId = merged.line_member_basic_id ? String(merged.line_member_basic_id).trim() : '';
      if (basicId && !/^@?[A-Za-z0-9_-]{2,30}$/.test(basicId)) {
        return res.status(400).json({ success: false, message: 'LINE 官方帳號 Basic ID 格式錯誤' });
      }
      // fix18-10-hotfix23-E1：只在這次請求「實際有送值」修改 return_url 時才驗證，
      // 未啟用 Gate／未修改此欄位時，允許保留既有（可能是舊規則儲存的）合法舊值，
      // 不因為舊值而擋下這次請求裡其他欄位的儲存；但非法的舊值不會被「重新儲存」。
      if (req.body.line_member_return_url !== undefined) {
        const returnUrl = String(req.body.line_member_return_url).trim();
        if (returnUrl) {
          const check = validateLineMemberReturnUrl(returnUrl, { req });
          if (!check.ok) {
            // line_member_return_url_rejected（server-only 安全記錄）：
            // 只記 hostname／reason，不記完整網址（可能含 query 敏感資料）。
            let rejectedHostname = '';
            try { rejectedHostname = new URL(returnUrl).hostname; } catch (e) { rejectedHostname = '(unparseable)'; }
            console.warn(`[settings] line_member_return_url_rejected store_id=${storeId} hostname=${rejectedHostname} reason=${check.reason}`);
            return res.status(400).json({
              success: false,
              message: '登入返回網址不在允許的網域內，請使用目前 POS 系統網域的 HTTPS 網址。',
            });
          }
        }
      }
      const mode = merged.line_member_gate_mode ? String(merged.line_member_gate_mode).trim() : '';
      if (mode && !['disabled', 'checkout', 'entry'].includes(mode)) {
        return res.status(400).json({ success: false, message: '入口模式必須是 disabled / checkout / entry 其中之一' });
      }
      const textFields = ['line_member_title', 'line_member_description', 'line_member_friend_button_text', 'line_member_login_button_text', 'line_member_skip_button_text'];
      for (const f of textFields) {
        if (merged[f] !== undefined && String(merged[f]).length > 200) {
          return res.status(400).json({ success: false, message: `${f} 文字過長（上限 200 字）` });
        }
      }

      // fix18-10-hotfix25（需求文件十五）：登入成功返回網址已改由前端依「來源頁」
      // 自動判斷（見 public/js/line-member-gate.js），不再是每店必填、不再開放
      // 店家手動輸入固定網址。這裡只在啟用 Gate 且店家「完全沒有送值」時，
      // 由後端依系統網域自動補一份 fallback URL 寫入（單純供舊資料相容／後台
      // 顯示參考用；前端目前不會讀取這個值來決定跳轉目的地）。產生失敗（例如
      // 沒有設定 PUBLIC_BASE_URL/APP_BASE_URL 且無法信任 request host）時直接
      // 略過，不阻擋這次設定儲存。
      if (gateEnabled && req.body.line_member_return_url === undefined) {
        const base = process.env.PUBLIC_BASE_URL || process.env.APP_BASE_URL || '';
        if (base) {
          try {
            const autoUrl = new URL('/line-order.html', base);
            autoUrl.searchParams.set('store_id', storeId);
            const check = validateLineMemberReturnUrl(autoUrl.toString(), { req });
            if (check.ok) req.body.line_member_return_url = autoUrl.toString();
          } catch (e) { /* 產生失敗就略過，不擋這次儲存 */ }
        }
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
