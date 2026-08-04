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
// fix18-10-hotfix26-F7：same_as_store 預設值推斷邏輯與 utils/pickupLocation.js 共用一份
const { resolveSameAsStoreFlag } = require('../utils/pickupLocation');
const { resolveAddFriendUrl } = require('../utils/lineCheckoutHandoff'); // fix18-10-hotfix29-C：加好友網址單一來源
const { normalizeDeliveryDistanceFeeRules } = require('../utils/deliveryFeeCalc'); // C3：距離級距滿額免運設定驗證單一來源
// fix18-10-hotfix30-B5-R5.2-B2：Geo Map 商家層級聚焦設定——單一 pure function
// 集合，GET/PATCH /api/settings/geo-map 與 smoke test 共用同一份規則，不得
// 另建第二套設定框架（需求文件四）。
const {
  GEO_MAP_SETTINGS_KEYS, validateGeoMapSettingsPatch, parseGeoMapSettingsRow,
} = require('../utils/geoMapScope');
// fix18-10-hotfix30-B5-R5.4-G1.5-B2：GA4 Realtime Settings —— 沿用同一份
// 白名單/驗證規則（utils/ga4RealtimeConfig.js），不建立第二套設定框架。
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.1：GET/PATCH 一律用 buildGa4RealtimeSettingsResponse()
// 組裝回應，Stored Settings（getGa4RealtimeStoredSettings）與 Effective Runtime
// Config（getGa4RealtimeConfig）分開回傳，不得再混為同一組欄位（見需求文件二/四）。
const {
  GA4_REALTIME_SETTINGS_KEYS, validateGa4RealtimeSettingsPatch, getGa4RealtimeConfig,
  getGa4RealtimeStoredSettings,
} = require('../utils/ga4RealtimeConfig');
const { invalidateGa4RealtimeCacheForStore } = require('../utils/ga4Realtime');
const ga4Client = require('../utils/ga4Realtime/client');

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
  // fix18-10-hotfix26-F3：外帶取餐地址（顧客結帳頁顯示用；純新增選填欄位，
  // 沒有設定時前端 fallback 使用 store_address，兩者都沒有時顯示「請洽店家確認取餐地點」）。
  'pickup_address',
  // fix18-10-hotfix26-F5：獨立「取餐地點」設定（與上面的 pickup_address 同一組功能的
  // 延伸，沿用同一個 line_order feature gate；不新增資料表，全部是 settings key-value）。
  'pickup_address_same_as_store', 'pickup_address_note',
  'pickup_lat', 'pickup_lng', 'pickup_coordinate_mode', 'pickup_coordinate_verified_at',
  'pickup_sync_delivery_origin',
  // fix18-10-hotfix26-F7：搜尋到明確 Google 商家後自動填入的商家名稱／Place ID。
  // place_id 只後端存取、不讓店家直接編輯（前端隱藏欄位保存）。
  'pickup_place_name', 'pickup_place_id',
  // fix18-10-hotfix26-F8（需求文件三／五／十二）：Messenger →「到 LINE 完成結帳」×
  // follow/unfollow webhook 需要的商家 LINE 官方帳號設定。
  // line_channel_secret 屬敏感值：一律不在 GET 回傳、不寫入 log／smoke test 輸出。
  'line_official_basic_id', 'line_add_friend_url', 'line_channel_secret',
  // fix18-10-hotfix27（需求文件四／五／八）：LINE Integration Center 新增欄位。
  // line_messaging_channel_id 只是顯示用途（非機密），line_channel_secret／
  // line_channel_token 沿用既有欄位，不重複造第二組。
  'line_official_name', 'line_official_home_url', 'line_messaging_channel_id',
  'line_checkout_handoff_enabled',
]);

// fix18-10-hotfix26-F5：上面 LINE_KEYS 內「取餐地點」設定 key 的清單（給 PUT /api/settings
// 內的專屬驗證/同步邏輯引用，避免驗證程式碼要重複打一次落落長的字串陣列）。
// fix18-10-hotfix26-F7：新增 pickup_place_name／pickup_place_id。
const PICKUP_LOCATION_KEYS = [
  'pickup_address_same_as_store', 'pickup_place_name', 'pickup_place_id', 'pickup_address', 'pickup_address_note',
  'pickup_lat', 'pickup_lng', 'pickup_coordinate_mode', 'pickup_coordinate_verified_at',
  'pickup_sync_delivery_origin',
];

// fix18-06：外送距離費率相關 key
const DELIVERY_FEE_KEYS = [
  'store_address', 'store_lat', 'store_lng',
  'delivery_distance_fee_enabled',
  'delivery_distance_fee_rules',   // JSON string
  'delivery_max_distance_km',
  'delivery_basic_fee',
  'delivery_free_threshold',
  // C3：舊版全店滿額免運欄位（legacy fallback 用）。目前後台沒有專屬 UI 修改
  // delivery_free_enabled / delivery_free_mode，但既然 utils/deliveryFeeCalc.js
  // 的 legacy fallback 會讀取它們，這裡先開放允許儲存，避免未來要補後台 UI 時
  // 還要再改一次允許清單。
  'delivery_free_enabled', 'delivery_free_mode',
  'coupon_apply_to_delivery_fee',
  // fix18-10-hotfix26-F7：店家商家名稱／Google Place ID／定位模式／校正時間。
  // store_place_id 只後端存取、不讓店家直接編輯（前端隱藏欄位保存）。
  'store_place_name', 'store_place_id', 'store_coordinate_mode', 'store_coordinate_verified_at',
];

// fix18-10-hotfix26-F7：PATCH /api/settings/store-location 只接受的欄位清單
// （避免整頁 settings 儲存互相覆蓋，見需求文件廿四／廿五）。
const STORE_LOCATION_KEYS = [
  'store_place_name', 'store_place_id', 'store_address', 'store_lat', 'store_lng',
  'store_coordinate_mode', 'store_coordinate_verified_at',
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
  // fix18-10-hotfix30-B5-R5.2-B2：Geo Map 聚焦範圍設定——沿用既有 key-value
  // settings 表，不另建第二套設定框架（需求文件四）。
  ...GEO_MAP_SETTINGS_KEYS,
];

// fix18-10-hotfix26-F5：lat/lng 範圍驗證（-90~90 / -180~180，不可 NaN）。
// 空字串視為「清空座標」允許通過（空值安全處理）。純函式，供 PUT /api/settings
// 與 smoke test（router.__test）共用同一份驗證邏輯。
function validatePickupLatLng(label, raw, min, max) {
  const s = raw === undefined ? '' : String(raw).trim();
  if (s === '') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return `${label} 格式錯誤（必須是數字）`;
  if (n < min || n > max) return `${label} 超出範圍（必須介於 ${min} ~ ${max}）`;
  return null;
}

// fix18-10-hotfix26-F5：產生 Asia/Taipei 目前時間的 ISO 字串（含 +08:00 offset），
// 供 pickup_coordinate_verified_at 使用。一律由後端產生，不信任前端傳入的時間。
function buildTaipeiVerifiedAtStamp() {
  const twNowDate = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const pad = (n) => String(n).padStart(2, '0');
  return `${twNowDate.getFullYear()}-${pad(twNowDate.getMonth()+1)}-${pad(twNowDate.getDate())}T${pad(twNowDate.getHours())}:${pad(twNowDate.getMinutes())}:${pad(twNowDate.getSeconds())}+08:00`;
}

// fix18-10-hotfix26-F5：同步外送距離計算起點（需求文件九）。
// 只有 pickup_sync_delivery_origin=true，且這次請求確實送了 pickup_lat/pickup_lng
// 兩者皆為合法數值時，才把 store_lat/store_lng 同步覆寫成取餐座標；絕不覆寫
// store_address（文件明確要求「只同步座標，不要自動覆蓋店家地址」）。sync 開關本身
// 若這次沒送，就讀資料庫目前已儲存的值來判斷（維持既有設定的同步狀態）。
// 獨立函式（吃 db/storeId/body），方便 smoke test 直接呼叫驗證，不需要真的發 HTTP request。
function applyPickupSyncToStoreCoords(db, storeId, body) {
  const syncFlagRaw = body.pickup_sync_delivery_origin !== undefined
    ? String(body.pickup_sync_delivery_origin)
    : (db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, 'pickup_sync_delivery_origin']) || {}).value;
  const syncEnabled = String(syncFlagRaw) === '1' || String(syncFlagRaw).toLowerCase() === 'true';

  if (!syncEnabled || body.pickup_lat === undefined || body.pickup_lng === undefined) return false;

  const latN = Number(String(body.pickup_lat).trim());
  const lngN = Number(String(body.pickup_lng).trim());
  if (!Number.isFinite(latN) || !Number.isFinite(lngN)) return false;

  ['store_lat', 'store_lng'].forEach((k) => {
    const v = k === 'store_lat' ? String(latN) : String(lngN);
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [v, storeId, k]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, v]);
  });
  return true;
}

// fix18-10-hotfix27（需求文件四／十四）：GET／PUT／WebSocket broadcast 三個
// 出口都會把整份 settings 送到前端，必須共用同一份遮蔽邏輯，避免漏改其中
//一處造成 Channel Secret／Access Token 明文外洩。
function redactSensitiveSettings(s) {
  const out = { ...s };
  if (Object.prototype.hasOwnProperty.call(out, 'line_channel_secret')) {
    out.line_channel_secret_set = !!(out.line_channel_secret && out.line_channel_secret.trim());
    delete out.line_channel_secret;
  }
  // line_channel_token：既有（F8 之前就存在）的「Bearer Token」欄位，目前
  // 基本設定頁的舊版 UI（set-line_channel_token）仍依賴這裡回傳明文才能正常
  // 運作，這是本輪沿用、非本輪新增的技術債（詳見完成報告誠實揭露），這裡
  // 暫不動它，只確保「新增」的 LINE Integration Center 走的是 /api/line-integration
  // /config 的另一組遮蔽欄位（channel_token_set/channel_token_masked），不從
  // 這裡拿明文。
  return out;
}

// GET /api/settings
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const settings = {};
    rows.forEach(r => { settings[r.key] = r.value; });
    // fix18-10-hotfix26-F8（需求文件十二）：Channel Secret 是簽章驗證用的敏感憑證，
    // 只允許寫入，不隨 GET /api/settings 回傳明文；前端用「是否已設定」的布林值顯示。
    res.json({ success: true, data: redactSensitiveSettings(settings) });
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

    // ── fix18-10-hotfix29-C（需求文件五）：LINE 整合中心正式欄位驗證 ────────
    // 與下面 line_member_add_friend_url 用同一套規則（格式＋拒絕 placeholder），
    // 確保兩個頁面存進資料庫的值都經過同一套檢查，不會一邊寬鬆一邊嚴格。
    if (req.body.line_add_friend_url !== undefined) {
      const officialUrl = String(req.body.line_add_friend_url).trim();
      if (officialUrl) {
        if (!/^https:\/\/(lin\.ee\/|line\.me\/)/i.test(officialUrl)) {
          return res.status(400).json({ success: false, message: '加入好友網址格式錯誤（必須是 https://lin.ee/ 或 https://line.me/ 開頭）' });
        }
        if (['https://lin.ee/xxxxx', 'https://lin.ee/xxxx', 'https://line.me/xxxxx'].includes(officialUrl.toLowerCase())) {
          return res.status(400).json({ success: false, message: '請輸入實際的加入好友網址，不要使用範例文字' });
        }
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
      if (friendUrl) {
        if (!/^https:\/\/(lin\.ee\/|line\.me\/)/i.test(friendUrl)) {
          return res.status(400).json({ success: false, message: '加好友網址格式錯誤（必須是 https://lin.ee/ 或 https://line.me/ 開頭）' });
        }
        // fix18-10-hotfix29-C（需求文件五）：只驗證前綴會讓表單 placeholder
        // 文字（例如「https://lin.ee/xxxxx」）被誤判成合法值存入資料庫，
        // 導致結帳頁顯示一個假的加好友網址。這裡明確拒絕已知 placeholder。
        if (['https://lin.ee/xxxxx', 'https://lin.ee/xxxx', 'https://line.me/xxxxx'].includes(friendUrl.toLowerCase())) {
          return res.status(400).json({ success: false, message: '請輸入實際的加好友網址，不要使用範例文字' });
        }
        // 需求文件五：只有舊欄位（LINE 會員登入設定頁）有送值、這次請求「沒有」
        // 同時送新欄位，且資料庫目前的正式欄位是空的時，才鏡射寫入——不覆蓋
        // 店家已經在 LINE 整合中心設定好的正式值，也不自動清掉舊欄位。
        if (req.body.line_add_friend_url === undefined) {
          const existingOfficial = existing.line_add_friend_url ? String(existing.line_add_friend_url).trim() : '';
          if (!existingOfficial) req.body.line_add_friend_url = friendUrl;
        }
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

    // ── fix18-10-hotfix26-F5：取餐地點設定驗證與同步（需求文件八／九）──────
    // 只在這次請求有實際送出「取餐地點」相關欄位時才處理，未送出時完全不動作
    // （沿用既有 PUT /api/settings「只更新有送值的 key」慣例）。
    if (Object.keys(req.body).some(k => PICKUP_LOCATION_KEYS.includes(k))) {
      const latErr = validatePickupLatLng('取餐緯度 (pickup_lat)', req.body.pickup_lat, -90, 90);
      if (latErr) return res.status(400).json({ success: false, message: latErr });
      const lngErr = validatePickupLatLng('取餐經度 (pickup_lng)', req.body.pickup_lng, -180, 180);
      if (lngErr) return res.status(400).json({ success: false, message: lngErr });

      const modeRaw = req.body.pickup_coordinate_mode !== undefined ? String(req.body.pickup_coordinate_mode).trim() : undefined;
      if (modeRaw !== undefined && modeRaw !== '' && !['auto', 'manual'].includes(modeRaw)) {
        return res.status(400).json({ success: false, message: 'pickup_coordinate_mode 必須是 auto 或 manual' });
      }

      // pickup_coordinate_verified_at 一律由後端用伺服器目前時間（Asia/Taipei）覆寫，
      // 不信任前端傳入的時間字串——只要這次請求有動到座標或校正模式，就重新蓋章。
      // （req.body 本身若有送這個欄位也會被這裡蓋掉，確保時間戳記真實可信。）
      if (req.body.pickup_lat !== undefined || req.body.pickup_lng !== undefined || modeRaw !== undefined) {
        req.body.pickup_coordinate_verified_at = buildTaipeiVerifiedAtStamp();
      }
    }

    // ── C3：距離級距＋各級距滿額免運設定驗證（需求文件四）───────────────
    // 只在這次請求有實際送出 delivery_distance_fee_rules 時才驗證/正規化；未送出時
    // 完全不動作（沿用既有 PUT /api/settings「只更新有送值的 key」慣例）。normalize
    // 邏輯集中在 utils/deliveryFeeCalc.js 的 normalizeDeliveryDistanceFeeRules()，
    // 前後端（送單重算 / 前台試算 / 這裡的設定驗證）都不可各自重寫一份判斷規則。
    if (req.body.delivery_distance_fee_rules !== undefined) {
      let parsedRules;
      try {
        parsedRules = typeof req.body.delivery_distance_fee_rules === 'string'
          ? JSON.parse(req.body.delivery_distance_fee_rules)
          : req.body.delivery_distance_fee_rules;
      } catch (e) {
        return res.status(400).json({ success: false, message: '距離級距規則不是合法的 JSON' });
      }
      const normResult = normalizeDeliveryDistanceFeeRules(parsedRules);
      if (!normResult.ok) {
        return res.status(400).json({ success: false, message: normResult.message });
      }
      // 正規化後的結果（例如 fixed/full 模式強制歸零的 free_discount）才是真正落地儲存的值，
      // 避免前端送來的原始字串裡帶有未經正規化的雜訊欄位。
      req.body.delivery_distance_fee_rules = JSON.stringify(normResult.rules);
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

    // ── fix18-10-hotfix26-F5：同步外送距離計算起點（需求文件九）───────────
    try {
      applyPickupSyncToStoreCoords(db, storeId, req.body);
    } catch (syncErr) {
      console.warn('[settings] pickup_sync_delivery_origin 同步失敗:', syncErr.message);
    }

    // ── WebSocket broadcast ───────────────────────────────
    try {
      const wss   = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s     = {};
      rows2.forEach(r => { s[r.key] = r.value; });
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: redactSensitiveSettings(s) });
    } catch {}

    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {};
    rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: redactSensitiveSettings(s) });
  } catch(e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix26-F5：供 scripts/smoke-hotfix26-f5.js 直接呼叫驗證，不需要真的
// 起 HTTP server（沿用 routes/line-analytics.js 既有的 router.__test 慣例）。
router.__test = {
  validatePickupLatLng,
  buildTaipeiVerifiedAtStamp,
  applyPickupSyncToStoreCoords,
  PICKUP_LOCATION_KEYS,
  // fix18-10-hotfix26-F7
  STORE_LOCATION_KEYS,
  validatePickupLocationSave,
  getCurrentSettingVal,
  // C3
  normalizeDeliveryDistanceFeeRules,
};

// fix18-10-hotfix26-F7：讀取單一 settings 目前值（給下面 PATCH 端點的驗證邏輯用，
// 判斷「這次請求沒送的欄位」目前資料庫值是什麼，因為 PATCH 可能只送部分欄位）。
function getCurrentSettingVal(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// fix18-10-hotfix26-F7（需求文件十二）：獨立取餐地點的儲存驗證，抽成純函式方便
// PATCH /pickup-location 與 smoke test 共用同一份規則。
// same_as_store=true 時允許 pickup 獨立欄位為空；
// same_as_store=false 時，要求 pickup_lat/pickup_lng 有效，且 pickup_place_name
// 或 pickup_address 至少一項有值——不再默默回退顯示店家地址。
function validatePickupLocationSave(db, storeId, body) {
  const latErr = validatePickupLatLng('取餐緯度 (pickup_lat)', body.pickup_lat, -90, 90);
  if (latErr) return { ok: false, message: latErr };
  const lngErr = validatePickupLatLng('取餐經度 (pickup_lng)', body.pickup_lng, -180, 180);
  if (lngErr) return { ok: false, message: lngErr };

  const modeRaw = body.pickup_coordinate_mode !== undefined ? String(body.pickup_coordinate_mode).trim() : undefined;
  if (modeRaw !== undefined && modeRaw !== '' && !['auto', 'manual'].includes(modeRaw)) {
    return { ok: false, message: 'pickup_coordinate_mode 必須是 auto 或 manual' };
  }

  const sameAsStoreRaw = body.pickup_address_same_as_store;
  const sameAsStore = sameAsStoreRaw !== undefined
    ? (String(sameAsStoreRaw) === '1' || String(sameAsStoreRaw).toLowerCase() === 'true')
    : resolveSameAsStoreFlag(db, storeId);

  if (!sameAsStore) {
    const finalLat = body.pickup_lat !== undefined ? body.pickup_lat : getCurrentSettingVal(db, storeId, 'pickup_lat', '');
    const finalLng = body.pickup_lng !== undefined ? body.pickup_lng : getCurrentSettingVal(db, storeId, 'pickup_lng', '');
    const finalPlaceName = body.pickup_place_name !== undefined ? body.pickup_place_name : getCurrentSettingVal(db, storeId, 'pickup_place_name', '');
    const finalAddress = body.pickup_address !== undefined ? body.pickup_address : getCurrentSettingVal(db, storeId, 'pickup_address', '');

    const latN = Number(String(finalLat).trim());
    const lngN = Number(String(finalLng).trim());
    const hasValidCoords = String(finalLat).trim() !== '' && String(finalLng).trim() !== '' && Number.isFinite(latN) && Number.isFinite(lngN);
    const hasNameOrAddress = !!(String(finalPlaceName || '').trim() || String(finalAddress || '').trim());

    if (!hasValidCoords || !hasNameOrAddress) {
      return { ok: false, message: '目前使用獨立取餐地點，請選擇商家地標或輸入取餐地址。' };
    }
  }
  return { ok: true };
}

// fix18-10-hotfix26-F7：PATCH /api/settings/pickup-location（需求文件廿四）。
// 只更新取餐地點相關欄位，絕不觸碰任何 store_* 欄位（唯一例外是
// pickup_sync_delivery_origin=true 時，透過既有 applyPickupSyncToStoreCoords() 同步
// store_lat/store_lng——這是 F5 就有的既有規則，不是本端點新增的行為）。
// 用獨立端點取代「整頁 PUT /api/settings」是為了避免 stale state 互相覆蓋
// （需求文件廿五）：後台只要送這個表單自己的欄位，不會不小心把其他分頁的舊值也
// 一起送出去蓋掉剛剛才儲存的新值。
router.patch('/pickup-location', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;

    const lic = getStoreLicense(storeId);
    if (!lic.active) {
      return res.status(403).json({ success: false, error: 'LICENSE_INACTIVE', message: '此店家授權已停用，請聯絡系統管理員' });
    }
    if (!lic.features.line_order) {
      return res.status(403).json({
        success: false, error: 'FEATURE_DISABLED', feature: 'line_order',
        message: '此功能未授權，請聯絡系統管理員升級方案（LINE 點餐設定需 line_order 授權）'
      });
    }

    const body = { ...(req.body || {}) };

    const validation = validatePickupLocationSave(db, storeId, body);
    if (!validation.ok) return res.status(400).json({ success: false, message: validation.message });

    const modeRaw = body.pickup_coordinate_mode !== undefined ? String(body.pickup_coordinate_mode).trim() : undefined;
    // verified_at 一律由後端蓋章，不信任前端傳入的時間（跟 PUT /api/settings 既有規則一致）。
    if (body.pickup_lat !== undefined || body.pickup_lng !== undefined || modeRaw !== undefined) {
      body.pickup_coordinate_verified_at = buildTaipeiVerifiedAtStamp();
    }

    // 只寫入 PICKUP_LOCATION_KEYS 白名單內、且這次請求有送值的欄位——不寫任何 store_* 欄位。
    PICKUP_LOCATION_KEYS.forEach((k) => {
      if (body[k] !== undefined) {
        const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(body[k]), storeId, k]);
        if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, String(body[k])]);
      }
    });

    // fix18-10-hotfix26-F5 既有邏輯：只同步 store_lat/store_lng，絕不覆寫 store_address。
    try { applyPickupSyncToStoreCoords(db, storeId, body); } catch (e) { console.warn('[settings] pickup_sync_delivery_origin 同步失敗:', e.message); }

    try {
      const wss = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s = {}; rows2.forEach(r => { s[r.key] = r.value; });
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: redactSensitiveSettings(s) });
    } catch {}

    // fix18-10-hotfix26-F7（需求文件廿五）：回傳「當下完整 settings」而不是只回傳這次
    // 寫入的欄位，前端拿這份回應整個 merge 進本地 cache，避免用舊 state 覆蓋新值。
    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {}; rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: redactSensitiveSettings(s) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix26-F7：PATCH /api/settings/store-location（需求文件廿四）。
// 只更新店家地址／外送起點相關欄位，絕不觸碰任何 pickup_* 欄位（需求文件十八）。
router.patch('/store-location', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = { ...(req.body || {}) };

    const latErr = validatePickupLatLng('店家緯度 (store_lat)', body.store_lat, -90, 90);
    if (latErr) return res.status(400).json({ success: false, message: latErr });
    const lngErr = validatePickupLatLng('店家經度 (store_lng)', body.store_lng, -180, 180);
    if (lngErr) return res.status(400).json({ success: false, message: lngErr });

    const modeRaw = body.store_coordinate_mode !== undefined ? String(body.store_coordinate_mode).trim() : undefined;
    if (modeRaw !== undefined && modeRaw !== '' && !['auto', 'manual'].includes(modeRaw)) {
      return res.status(400).json({ success: false, message: 'store_coordinate_mode 必須是 auto 或 manual' });
    }

    // verified_at 一律由後端蓋章，不信任前端傳入的時間。
    if (body.store_lat !== undefined || body.store_lng !== undefined || modeRaw !== undefined) {
      body.store_coordinate_verified_at = buildTaipeiVerifiedAtStamp();
    }

    // 只寫入 STORE_LOCATION_KEYS 白名單內、且這次請求有送值的欄位——不寫任何 pickup_* 欄位。
    STORE_LOCATION_KEYS.forEach((k) => {
      if (body[k] !== undefined) {
        const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(body[k]), storeId, k]);
        if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, String(body[k])]);
      }
    });

    try {
      const wss = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s = {}; rows2.forEach(r => { s[r.key] = r.value; });
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: redactSensitiveSettings(s) });
    } catch {}

    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {}; rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: redactSensitiveSettings(s) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix30-B5-R5.2-B2：GET /api/settings/geo-map（需求文件五）。
// 沿用既有 requireStore 注入的 req.storeId，不接受跨店讀取；沿用既有
// store_lat/store_lng（見 parseGeoMapSettingsRow()），不重複存一份座標。
router.get('/geo-map', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {}; rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: parseGeoMapSettingsRow(s) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix30-B5-R5.2-B2：PATCH /api/settings/geo-map（需求文件五）。
// 只更新 GEO_MAP_SETTINGS_KEYS 白名單內、且這次請求有送值的欄位——不動
// store_lat/store_lng（那兩個欄位一律透過既有 PATCH /store-location 維護，
// 見需求文件三「新增設定時避免重複存相同資料」）。
router.patch('/geo-map', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = { ...(req.body || {}) };

    const check = validateGeoMapSettingsPatch(body);
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });

    GEO_MAP_SETTINGS_KEYS.forEach((k) => {
      if (body[k] === undefined) return;
      let v = body[k];
      if ((k === 'geo_map_district_codes' || k === 'geo_map_bounds') && v !== null && typeof v !== 'string') {
        v = JSON.stringify(v);
      }
      if (v === null) v = '';
      const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(v), storeId, k]);
      if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, String(v)]);
    });

    try {
      const wss = req.app.get('wss');
      const rows2 = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
      const s2 = {}; rows2.forEach(r => { s2[r.key] = r.value; });
      broadcastToStore(wss, storeId, { type: 'settings_updated', data: redactSensitiveSettings(s2) });
    } catch {}

    const rows = db.all('SELECT key, value FROM settings WHERE store_id=?', [storeId]);
    const s = {}; rows.forEach(r => { s[r.key] = r.value; });
    res.json({ success: true, data: parseGeoMapSettingsRow(s) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

function _boolFromEnv(raw) {
  return String(raw).trim().toLowerCase() === 'true';
}

// _isPureNumericId(raw) — 只用來判斷 Stored Property/Stream 是否為「合法
// 純數字」（需求文件四：property_configured／stream_configured）。不得用
// 長度猜測是否填反（需求文件八），這裡只驗證格式，不比較長度。
function _isPureNumericId(raw) {
  const s = (raw === undefined || raw === null) ? '' : String(raw).trim();
  return s !== '' && /^[0-9]+$/.test(s);
}

// buildGa4RealtimeSettingsResponse(db, storeId) — fix18-10-hotfix30-B5-
// R5.4-G1.5-B2.1：GET／PATCH 共用同一份回應 Builder（需求文件五），避免
// 兩條 Route 分別組裝欄位、之後再度分歧。
//
// 明確區分兩種資料（需求文件二）：
//   Stored Settings   → Settings UI 顯示/編輯用，不受全域 Feature Flag 或
//                        憑證狀態影響。
//   Effective Runtime  → 目前系統是否「真的能執行」GA4（Global Flag +
//                        店家開關 + Property/Stream + Credential 都到位）。
function buildGa4RealtimeSettingsResponse(db, storeId) {
  const stored = getGa4RealtimeStoredSettings(db, storeId);
  const effective = getGa4RealtimeConfig(db, storeId);
  const cred = ga4Client.credentialStatus();

  return {
    success: true,
    data: {
      // Stored Settings —— 使用者在 settings 表實際儲存的值，Settings Form
      // 一律只信任這一組欄位（不受全域 Flag／憑證狀態影響，見需求文件二）。
      ga4_realtime_enabled: stored.ga4_realtime_enabled,
      ga4_realtime_property_id: stored.ga4_realtime_property_id,
      ga4_realtime_stream_id: stored.ga4_realtime_stream_id,
      ga4_realtime_single_property_mode: stored.ga4_realtime_single_property_mode,
      ga4_realtime_cache_seconds: stored.ga4_realtime_cache_seconds,
      ga4_realtime_auto_refresh_enabled: stored.ga4_realtime_auto_refresh_enabled,

      // Effective Runtime Config —— 目前系統「實際是否能執行」GA4，
      // 給 Runtime 狀態顯示／Connection Test 用，跟上面的 Stored Settings
      // 是分開的兩組欄位，不得合併（需求文件四）。
      global_enabled: _boolFromEnv(process.env.GA4_REALTIME_ENABLED),
      effective_enabled: effective.enabled,
      effective_configured: effective.configured,
      runtime_error_code: effective.errorCode || null,

      // Stored Property/Stream 是否為合法純數字（僅格式檢查，不比較長度，
      // 不得用來猜測 Property/Stream 是否填反，見需求文件八）。
      property_configured: _isPureNumericId(stored.ga4_realtime_property_id),
      stream_configured: _isPureNumericId(stored.ga4_realtime_stream_id),

      server_single_store_mode_available: _boolFromEnv(process.env.GA4_REALTIME_SINGLE_STORE_MODE),
      credential_available: !!cred.available,
      sdk_available: ga4Client.isSdkAvailable(),
    },
  };
}

// fix18-10-hotfix30-B5-R5.2-B2：供 smoke test 直接呼叫驗證，不需要真的起
// HTTP server（沿用既有 router.__test 慣例，見上方 hotfix26-F5 註解）。
// fix18-10-hotfix30-B5-R5.4-G1.5-B2：GET /api/settings/ga4-realtime。
// 沿用既有 requireStore 注入的 req.storeId，SQL 帶 WHERE store_id=?，
// 物理上不可能跨店讀取。只回傳「可以安全顯示的摘要」，不回傳憑證/
// env path/client_email/private key（見需求文件五）。
// fix18-10-hotfix30-B5-R5.4-G1.5-B2.1：改用 buildGa4RealtimeSettingsResponse()，
// 回傳 Stored Settings（不受全域 Flag／憑證影響）+ Effective Runtime（另外
// 分開的欄位），不得再用 Effective Config 回填 Settings 表單（需求文件一）。
router.get('/ga4-realtime', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    res.json(buildGa4RealtimeSettingsResponse(db, storeId));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// fix18-10-hotfix30-B5-R5.4-G1.5-B2：PATCH /api/settings/ga4-realtime。
// 只更新 GA4_REALTIME_SETTINGS_KEYS 白名單內、且這次請求有送值的欄位。
// 不接受 store_id／credentials／private_key／property_id(非白名單命名)／
// stream_id(非白名單命名) 等欄位（validateGa4RealtimeSettingsPatch 會擋）。
// 設定變更後立刻呼叫 invalidateGa4RealtimeCacheForStore()（需求文件七），
// 只清這個 store 的 cache，不影響其他店家。
router.patch('/ga4-realtime', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const body = { ...(req.body || {}) };

    const check = validateGa4RealtimeSettingsPatch(body);
    if (!check.ok) return res.status(400).json({ success: false, message: check.message });

    const keysToWrite = GA4_REALTIME_SETTINGS_KEYS.filter((k) => body[k] !== undefined);
    const anyRelevantChange = keysToWrite.length > 0;

    // fix18-10-hotfix30-B5-R5.4-G1.5-B2b：原子性寫入。
    //
    // Reality Audit 發現一個既有、真實存在的 bug：utils/db.js 包裝過的
    // db.run() 每次呼叫都會呼叫 save()（= sqlDb.export() + 寫檔），而
    // sqlDb.export() 在 sql.js 底層會提早結束目前開啟的 SQL transaction
    // ——這代表如果在 BEGIN 之後、COMMIT 之前呼叫「包裝過」的 db.run()，
    // 之後的 ROLLBACK 會直接丟出「cannot rollback - no transaction is
    // active」，而且第一筆寫入其實已經因為 export() 被提早、非預期地
    // autocommit，完全不是原子操作。
    //
    // 修法：跟 utils/db.js 內既有的 hotfix7 categories 遷移用同一種安全
    // 寫法——直接用 db._db（原始 sqlDb）跑 BEGIN/一連串 prepare-run-free/
    // COMMIT，只在 COMMIT 成功之後才呼叫一次 db._save()，過程中完全不
    // 呼叫包裝過的 db.run()（避免任何一次中途 export() 提早結束 transaction）。
    if (anyRelevantChange) {
      const rawDb = db._db;
      try {
        rawDb.run('BEGIN');
        keysToWrite.forEach((k) => {
          let v = body[k];
          if (v === null) v = '';
          const updateStmt = rawDb.prepare('UPDATE settings SET value=? WHERE store_id=? AND key=?');
          updateStmt.run([String(v), storeId, k]);
          const changes = rawDb.getRowsModified ? rawDb.getRowsModified() : 0;
          updateStmt.free();
          if (!changes) {
            const insertStmt = rawDb.prepare('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)');
            insertStmt.run([storeId, k, String(v)]);
            insertStmt.free();
          }
        });
        rawDb.run('COMMIT');
        db._save();
      } catch (writeErr) {
        try { rawDb.run('ROLLBACK'); } catch (rollbackErr) { /* 沒有真的開啟中的 transaction 時 ROLLBACK 本身會丟例外，安全忽略 */ }
        return res.status(500).json({ success: false, message: '設定儲存失敗，請稍後再試' });
      }
      // 只有在 COMMIT 成功之後才清該 store 的 cache／遞增 generation（需求
      // 文件三：Cache Invalidation 必須發生在 Commit 之後，不是之前）。
      invalidateGa4RealtimeCacheForStore(storeId);
    }

    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.1：PATCH 回應與 GET 共用同一份
    // Builder（buildGa4RealtimeSettingsResponse()），COMMIT 成功、cache
    // invalidate 之後才重新讀取 Stored Settings／Effective Runtime，避免
    // 兩條 Route 分別組裝欄位又再度分歧（需求文件五）。
    res.json(buildGa4RealtimeSettingsResponse(db, storeId));
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

router.__test = Object.assign(router.__test || {}, {
  validateGeoMapSettingsPatch, parseGeoMapSettingsRow, GEO_MAP_SETTINGS_KEYS,
  validateGa4RealtimeSettingsPatch, GA4_REALTIME_SETTINGS_KEYS,
  buildGa4RealtimeSettingsResponse,
});

module.exports = router;
