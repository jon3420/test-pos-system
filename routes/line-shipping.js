// routes/line-shipping.js — fix18-10-hotfix18：LINE 冷藏宅配中心 V1
//
// 設計原則：
//   1. 完全獨立於 routes/line-orders.js（外帶/外送），不共用購物車/驗證流程。
//   2. 訂單仍寫入既有 orders 表，但使用獨立欄位：
//        order_source = 'line_shipping'
//        fulfillment_type = 'shipping'
//        order_mode = 'shipping'（供 Web 後台清單辨識用的既有欄位）
//   3. V1 不串接黑貓 API，只保留 tracking_number / carrier_name / shipping_note 欄位供手動填寫。
//   4. shipping_status 為獨立狀態欄位，不影響既有 order_status 狀態機（避免動到外帶/外送/廚房流程）。
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { broadcastToStore } = require('../utils/wssBroadcast');
const { v4: uuidv4 } = require('uuid');
// hotfix22-C：冷藏宅配優惠券支援 — 直接共用既有優惠券引擎（routes/coupons.js），
// 不重做驗證規則（期限／最低消費／每人次數上限／tenant 隔離皆沿用同一份邏輯），
// 也不影響 routes/line-shipping.js 本來「不共用外帶/外送購物車與驗證流程」的獨立設計。
const { validateCoupon } = require('./coupons');
const { getStoreFeatures } = require('../middleware/featureGate');
// fix18-10-hotfix22D：冷藏宅配公告的「自動休假公告」唯讀共用 routes/line-orders.js 已匯出的
// Business Calendar 查詢函式（不修改 Business Calendar 本身、不影響 LINE 點餐公告既有邏輯）。
const { getCalendarDateInfo } = require('./line-orders');

// ── helpers（獨立於 line-orders.js，避免耦合既有外帶/外送邏輯）──────────
function getSetting(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}
function twNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
}
function twDateStr(d) {
  const dt = d || twNow();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function parseLocalDate(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return new Date(y, (m || 1) - 1, d || 1);
}
function addDays(dateStr, n) {
  const d = parseLocalDate(dateStr);
  d.setDate(d.getDate() + n);
  return twDateStr(d);
}
function weekdayKey(dateStr) {
  const keys = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  return keys[parseLocalDate(dateStr).getDay()];
}
function orderNumber() {
  const n = new Date(), p = (v, l = 2) => String(v).padStart(l, '0');
  return `SHIP-${n.getFullYear()}${p(n.getMonth() + 1)}${p(n.getDate())}-${p(n.getHours())}${p(n.getMinutes())}${p(n.getSeconds())}`;
}
async function triggerN8nWebhook(db, storeId, event, payload) {
  try {
    const url = getSetting(db, storeId, 'n8n_webhook_url', '');
    if (!url) return;
    const fetch = require('node-fetch');
    fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event, ...payload, triggered_at: new Date().toISOString() }),
      timeout: 5000,
    }).catch(() => {});
  } catch {}
}

function getShippingSettings(db, storeId) {
  const keys = [
    'shipping_enabled', 'shipping_title', 'shipping_description', 'shipping_notice',
    'shipping_storage_note', 'shipping_fee', 'shipping_free_threshold',
    'shipping_min_order_amount', 'shipping_arrival_days_limit', 'shipping_lead_days',
    'shipping_closed_weekdays', 'shipping_payment_methods', 'shipping_carrier_name',
    'shipping_allow_arrival_date', 'shipping_upsell_enabled',
    // 沿用既有店家基本資料
    'shop_name', 'shop_logo', 'shop_address',
  ];
  const s = {};
  keys.forEach(k => { s[k] = getSetting(db, storeId, k, ''); });
  s.shipping_enabled            = s.shipping_enabled === '1';
  s.shipping_allow_arrival_date = s.shipping_allow_arrival_date !== '0';
  s.shipping_upsell_enabled     = s.shipping_upsell_enabled !== '0';
  s.shipping_fee                = Number(s.shipping_fee || 0) || 0;
  s.shipping_free_threshold     = Number(s.shipping_free_threshold || 0) || 0;
  s.shipping_min_order_amount   = Number(s.shipping_min_order_amount || 0) || 0;
  s.shipping_arrival_days_limit = Number(s.shipping_arrival_days_limit || 14) || 14;
  s.shipping_lead_days          = Number(s.shipping_lead_days || 1) || 1;
  try { s.shipping_closed_weekdays = JSON.parse(s.shipping_closed_weekdays || '[]'); } catch { s.shipping_closed_weekdays = []; }
  try { s.shipping_payment_methods = JSON.parse(s.shipping_payment_methods || '[]'); } catch { s.shipping_payment_methods = ['cash', 'transfer']; }
  return s;
}

// ── fix18-10-hotfix22D：冷藏宅配公告（完全獨立於 LINE 點餐商家公告 line_announcement_*）──
// 設計原則：
//   1. 獨立一套 settings key（shipping_announcement_*），與 line_announcement_* 不共用、不互相覆蓋。
//   2. 資料形狀（enabled/type/title/body/image_url/button_*/display_mode/frequency/version/…）
//      刻意與 LINE 點餐公告一致，方便前台共用同一套 renderAnnouncement 邏輯，但兩者資料來源
//      （settings key 前綴）完全分開，符合「不得共用 LINE 點餐公告」的要求。
//   3. 自動休假公告：唯讀查詢 Business Calendar（getCalendarDateInfo），只有「今日被行事曆設定
//      為公休（mode==='closed'）」時才自動產生休假公告，不影響 Business Calendar 本身、也不影響
//      LINE 點餐公告自己的自動休假判斷（那一份沿用 getDateClosedStatus()，本函式完全不呼叫它）。
const SHIPPING_ANNOUNCEMENT_ICONS = {
  general: '📢', holiday: '🏖️', promo: '🎉', new_product: '🆕',
  delivery: '📦', member: '🎁', custom: '✨',
};
function fmtMDShortLocal(s) {
  if (!s) return '';
  const p = String(s).split('-');
  return p.length >= 3 ? `${Number(p[1])}/${Number(p[2])}` : s;
}
function getShippingAnnouncement(db, storeId) {
  const keys = [
    'shipping_announcement_enabled', 'shipping_announcement_type',
    'shipping_announcement_title', 'shipping_announcement_body', 'shipping_announcement_image_url',
    'shipping_announcement_button_text', 'shipping_announcement_button_action', 'shipping_announcement_button_url',
    'shipping_announcement_start_date', 'shipping_announcement_end_date',
    'shipping_announcement_closable', 'shipping_announcement_display_mode',
    'shipping_announcement_frequency', 'shipping_announcement_version',
    'shipping_announcement_auto_holiday',
  ];
  const s = {};
  keys.forEach(k => { s[k] = getSetting(db, storeId, k, ''); });

  const todayStr = twDateStr();
  const announceEnabled = s.shipping_announcement_enabled === '1';
  const startD = s.shipping_announcement_start_date || '';
  const endD   = s.shipping_announcement_end_date || '';
  const withinRange = (!startD || todayStr >= startD) && (!endD || todayStr <= endD);
  const hasContent  = !!(s.shipping_announcement_title || s.shipping_announcement_body);

  let announcement = { enabled: announceEnabled, active: false, source: 'none', target: 'shipping' };

  if (announceEnabled && withinRange && hasContent) {
    const type = s.shipping_announcement_type || 'general';
    announcement = {
      enabled: true,
      active: true,
      target: 'shipping',
      type,
      icon: SHIPPING_ANNOUNCEMENT_ICONS[type] || '📢',
      title: s.shipping_announcement_title || '',
      body: s.shipping_announcement_body || '',
      image_url: s.shipping_announcement_image_url || '',
      button_text: s.shipping_announcement_button_text || '我知道了',
      button_action: s.shipping_announcement_button_action || 'close',
      button_url: s.shipping_announcement_button_url || '',
      start_date: startD,
      end_date: endD,
      closable: s.shipping_announcement_closable !== '0',
      display_mode: s.shipping_announcement_display_mode || 'modal',
      frequency: s.shipping_announcement_frequency || 'version',
      version: s.shipping_announcement_version || '1',
      source: 'manual',
    };
  } else {
    // 沒有生效中的手動公告 → 是否自動產生休假公告（僅在 Business Calendar 命中「公休」時，預設開啟）
    const autoHoliday = s.shipping_announcement_auto_holiday !== '0';
    if (autoHoliday) {
      let cal = { matched: false };
      try { cal = getCalendarDateInfo(db, storeId, todayStr); } catch { cal = { matched: false }; }
      if (cal.matched && cal.mode === 'closed') {
        const rangeTxt = cal.start_date === cal.end_date
          ? fmtMDShortLocal(cal.start_date)
          : `${fmtMDShortLocal(cal.start_date)}～${fmtMDShortLocal(cal.end_date)}`;
        const bodyLines = [rangeTxt];
        if (cal.show_reason && cal.reason) bodyLines.push(cal.reason);
        if (cal.resume_date) bodyLines.push(`${fmtMDShortLocal(cal.resume_date)} 恢復出貨`);
        announcement = {
          enabled: announceEnabled,
          active: true,
          target: 'shipping',
          type: 'holiday',
          icon: SHIPPING_ANNOUNCEMENT_ICONS.holiday,
          title: '目前暫停出貨',
          body: bodyLines.join('\n'),
          image_url: '',
          button_text: '我知道了',
          button_action: 'close',
          button_url: '',
          start_date: cal.start_date || '',
          end_date: cal.end_date || '',
          closable: true,
          display_mode: 'banner',
          frequency: 'always',
          version: cal.resume_date || '1',
          source: 'auto_holiday',
          resume_date: cal.resume_date || '',
        };
      }
    }
  }
  return announcement;
}

// ── 運費計算（V1 規則：單一固定運費 + 滿額免運 + 最低訂購金額）────────
function calcShippingFee(settings, subtotal) {
  const sub = Number(subtotal) || 0;
  const freeThreshold = settings.shipping_free_threshold;
  const baseFee = settings.shipping_fee;
  const meetsFree = freeThreshold > 0 && sub >= freeThreshold;
  const fee = meetsFree ? 0 : baseFee;
  const freeDiscount = meetsFree ? baseFee : 0;
  return {
    subtotal: sub,
    shipping_fee: fee,
    free_threshold: freeThreshold,
    free_discount: freeDiscount,
    meets_free: meetsFree,
    remaining_for_free: meetsFree ? 0 : Math.max(0, freeThreshold - sub),
    below_min_order: settings.shipping_min_order_amount > 0 && sub < settings.shipping_min_order_amount,
    min_order_amount: settings.shipping_min_order_amount,
    total: sub + fee,
  };
}

// ── 到貨日期驗證 ────────────────────────────────────────────────────
function validateArrivalDate(settings, arrivalType, arrivalDate) {
  if (arrivalType === 'asap' || !arrivalType) return { ok: true };
  if (!settings.shipping_allow_arrival_date) {
    return { ok: false, message: '目前未開放指定到貨日期' };
  }
  if (!arrivalDate) return { ok: false, message: '請選擇希望到貨日期' };
  const todayStr = twDateStr();
  const earliest = addDays(todayStr, settings.shipping_lead_days);
  const latest   = addDays(todayStr, settings.shipping_arrival_days_limit);
  if (arrivalDate < earliest) return { ok: false, message: `最早可選 ${earliest} 到貨` };
  if (arrivalDate > latest)   return { ok: false, message: `最晚可選 ${latest} 到貨` };
  const wd = weekdayKey(arrivalDate);
  if ((settings.shipping_closed_weekdays || []).includes(wd)) {
    return { ok: false, message: `${arrivalDate} 當日不配送，請選擇其他日期` };
  }
  return { ok: true };
}

// ── GET /api/line-shipping/shop — 宅配頁設定 + 可宅配商品 ─────────────
router.get('/shop', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const settings = getShippingSettings(db, storeId);

    const rawProducts = db.all(
      `SELECT * FROM products
       WHERE store_id=? AND enabled=1 AND shipping_enabled=1
       ORDER BY shipping_sort_order ASC, sort_order ASC, id ASC`,
      [storeId]
    );

    // fix18-10-hotfix19：多通路商品獨立顯示。宅配頁優先使用 shipping_* 欄位，
    // 若空才 fallback 回 POS 主商品欄位（不 fallback 到 LINE 通路欄位，兩通路互不影響）。
    const toShippingProduct = (p) => ({
      id: p.id,
      name: (p.shipping_name && p.shipping_name.trim()) ? p.shipping_name : p.name,
      spec: p.shipping_spec || '',
      image: p.shipping_image_url || p.image || '',
      description: (p.shipping_description && p.shipping_description.trim()) ? p.shipping_description : (p.description || ''),
      storage_note: settings.shipping_storage_note,
      price: Number(p.shipping_price) > 0 ? Number(p.shipping_price) : Number(p.price) || 0,
      is_upsell: Number(p.shipping_upsell) === 1,
      share_line_stock: Number(p.shipping_share_line_stock) !== 0,
      // 若共用 LINE 份數，回傳剩餘份數供前台顯示（V1/V2 僅顯示，不在此攔截，攔截於 validate-cart / orders）
      quota_remaining: (Number(p.shipping_share_line_stock) !== 0 && Number(p.line_quota_enabled))
        ? Math.max(0, Number(p.line_quota_daily || 0) - Number(p.line_quota_sold || 0))
        : null,
    });

    const products = rawProducts.filter(p => !Number(p.shipping_upsell)).map(toShippingProduct);
    const upsellProducts = settings.shipping_upsell_enabled
      ? rawProducts.filter(p => Number(p.shipping_upsell)).map(toShippingProduct)
      : [];

    const todayStr = twDateStr();
    // hotfix22-C：優惠券功能開關（與 /api/line-shop 相同判斷邏輯，供前台決定是否顯示優惠券輸入區）
    const shipFeatures = getStoreFeatures(storeId);
    res.json({
      success: true,
      data: {
        store: {
          name: getSetting(db, storeId, 'shop_name', ''),
          logo: getSetting(db, storeId, 'shop_logo', ''),
          address: getSetting(db, storeId, 'shop_address', ''),
        },
        settings,
        products,
        upsell_products: upsellProducts,
        shipping_notice: settings.shipping_notice,
        payment_methods: settings.shipping_payment_methods,
        today: todayStr,
        earliest_date: addDays(todayStr, settings.shipping_lead_days),
        latest_date: addDays(todayStr, settings.shipping_arrival_days_limit),
        closed_weekdays: settings.shipping_closed_weekdays,
        coupon_feature_enabled: shipFeatures.coupon === true,
        // fix18-10-hotfix22D：冷藏宅配公告（與 LINE 點餐公告完全獨立的資料來源，見 getShippingAnnouncement()）
        announcement: getShippingAnnouncement(db, storeId),
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/line-shipping/notice — 冷藏宅配公告（獨立端點）───────────────
// fix18-10-hotfix22D：對應規格【五】提出的兩種方案，這裡採「共用 target=shipping」的做法，
// 掛在既有的 /api/line-shipping router 下（不新增獨立 router、不影響 /api/merchant-notice
// 這類其他既有公告 API；GET /shop 也已內含同一份 announcement，此端點供只需要公告本身、
// 不需整個 /shop payload 的情境使用）。
router.get('/notice', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    res.json({ success: true, data: { announcement: getShippingAnnouncement(db, storeId) } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/line-shipping/validate-cart — 驗證購物車/運費/免運/最低金額/到貨日 ──
router.post('/validate-cart', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { items, arrival_type, arrival_date } = req.body;
    const settings = getShippingSettings(db, storeId);

    if (!settings.shipping_enabled) {
      return res.status(403).json({ success: false, message: '冷藏宅配目前未開放' });
    }
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '購物車不能為空' });
    }

    let subtotal = 0;
    const checkedItems = [];
    for (const item of items) {
      const pid = item.product_id || item.id;
      const prod = pid ? db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]) : null;
      if (!prod || !prod.enabled || !Number(prod.shipping_enabled)) {
        return res.status(400).json({ success: false, message: `商品「${item.name || ''}」不可宅配或已下架` });
      }
      const qty = Number(item.qty || 1);
      // 若共用 LINE 份數，驗證剩餘份數（不扣，只驗證）
      if (Number(prod.shipping_share_line_stock) !== 0 && Number(prod.line_quota_enabled)) {
        const remaining = Math.max(0, Number(prod.line_quota_daily || 0) - Number(prod.line_quota_sold || 0));
        if (remaining <= 0) {
          return res.status(400).json({ success: false, message: `「${prod.name}」份數已售完` });
        }
        if (remaining < qty) {
          return res.status(400).json({ success: false, message: `「${prod.name}」剩餘份數不足（剩 ${remaining} 份）` });
        }
      }
      const price = Number(prod.shipping_price) > 0 ? Number(prod.shipping_price) : Number(prod.price) || 0;
      subtotal += price * qty;
      checkedItems.push({ product_id: prod.id, name: prod.name, price, qty });
    }

    const feeResult = calcShippingFee(settings, subtotal);
    if (feeResult.below_min_order) {
      return res.status(400).json({
        success: false,
        message: `未達最低訂購金額 NT$${settings.shipping_min_order_amount}`,
        reason: 'below_min_order',
        data: feeResult,
      });
    }

    if (arrival_type) {
      const dateCheck = validateArrivalDate(settings, arrival_type, arrival_date);
      if (!dateCheck.ok) {
        return res.status(400).json({ success: false, message: dateCheck.message, reason: 'invalid_arrival_date' });
      }
    }

    res.json({ success: true, data: { ...feeResult, items: checkedItems } });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── POST /api/line-shipping/orders — 建立宅配訂單 ─────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const {
      items,
      recipient_name, phone, postal_code, city, district, address, address_note,
      arrival_type, arrival_date,
      payment_method, note, coupon_code,
    } = req.body;

    const settings = getShippingSettings(db, storeId);
    if (!settings.shipping_enabled) {
      return res.status(403).json({ success: false, message: '冷藏宅配目前未開放' });
    }

    // hotfix22-B：LINE Pay 冷藏宅配正式付款流程已確認可用（Request/Confirm/Webhook
    // 皆透過共用的 orders 表以 uuid 辨識，不區分 takeout/delivery/shipping），
    // 移除舊版強制擋下。付款方式是否開放仍受 shipping_payment_methods 白名單控管（見下方檢查）。
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: '購物車不能為空' });
    }
    if (!recipient_name || !phone) {
      return res.status(400).json({ success: false, message: '請填寫收件人姓名與電話' });
    }
    if (!address || !String(address).trim()) {
      return res.status(400).json({ success: false, message: '請填寫收件地址' });
    }

    // ── 商品重新驗證 + 計價（後端不信任前端金額）──────────────────────
    let subtotal = 0;
    const finalItems = [];
    for (const item of items) {
      const pid = item.product_id || item.id;
      const prod = pid ? db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]) : null;
      if (!prod || !prod.enabled || !Number(prod.shipping_enabled)) {
        return res.status(400).json({ success: false, message: `商品「${item.name || ''}」不可宅配或已下架` });
      }
      const qty = Number(item.qty || 1);
      if (Number(prod.shipping_share_line_stock) !== 0 && Number(prod.line_quota_enabled)) {
        const remaining = Math.max(0, Number(prod.line_quota_daily || 0) - Number(prod.line_quota_sold || 0));
        if (remaining <= 0 || remaining < qty) {
          return res.status(400).json({ success: false, message: `「${prod.name}」份數不足，無法送單` });
        }
      }
      const price = Number(prod.shipping_price) > 0 ? Number(prod.shipping_price) : Number(prod.price) || 0;
      subtotal += price * qty;
      finalItems.push({ product_id: prod.id, name: (prod.shipping_name && prod.shipping_name.trim()) ? prod.shipping_name : prod.name, price, qty, spec: prod.shipping_spec || '' });
    }

    // ── hotfix22-C：最低訂購金額檢查（沿用「折扣前」原始小計，與免運門檻規則各自獨立）──
    const minOrderCheck = calcShippingFee(settings, subtotal);
    if (minOrderCheck.below_min_order) {
      return res.status(400).json({
        success: false,
        message: `未達最低訂購金額 NT$${settings.shipping_min_order_amount}`,
        reason: 'below_min_order',
      });
    }

    // ── hotfix22-C：優惠券後端重新驗證（不信任前端傳來的 discount_amount）──────────
    // 直接共用 routes/coupons.js 的 validateCoupon()，V1 規則：優惠券只折「商品小計」，
    // 不折宅配運費；validateCoupon() 內部本來就會把折扣上限鎖在傳入的 subtotal 以內，
    // 這裡只要用「不含運費」的 subtotal 呼叫，就自動滿足「折扣不得超過商品小計」且
    // 「不折運費」，不需要另外重寫折扣上限判斷。
    let discAmt = 0;
    let appliedCouponId = null;
    let appliedCouponCode = '';
    const normalCouponCode = coupon_code ? String(coupon_code).trim().toUpperCase() : '';
    if (normalCouponCode) {
      const storeFeatures = getStoreFeatures(storeId);
      if (storeFeatures.coupon !== true) {
        return res.status(403).json({
          success: false,
          error: 'COUPON_FEATURE_DISABLED',
          message: '優惠券功能未啟用',
        });
      }
      const cvResult = validateCoupon(db, storeId, normalCouponCode, subtotal, phone);
      if (!cvResult.ok) {
        return res.status(400).json({ success: false, message: cvResult.message, reason: 'coupon_invalid' });
      }
      discAmt           = cvResult.discount_amount;
      appliedCouponId   = cvResult.coupon.id;
      appliedCouponCode = cvResult.coupon.code;
    }

    // ── hotfix22-C：免運門檻規則 —— 固定採用「折扣後商品小計」計算（與前端 calcFee() 一致）──
    //   discounted_subtotal = max(0, subtotal - discount_amount)
    //   discounted_subtotal >= free_shipping_threshold → shipping_fee = 0，否則收基本運費
    //   total = discounted_subtotal + shipping_fee
    // 不得發生「前端顯示免運，後端卻重新加運費」的不一致，所以前後端共用同一套算法。
    const discountedSubtotal = Math.max(0, subtotal - discAmt);
    const feeResult = calcShippingFee(settings, discountedSubtotal);
    // 應付金額 = 商品小計 - 優惠折扣 + 宅配運費（運費本身不受折扣影響）
    const finalTotal = discountedSubtotal + feeResult.shipping_fee;

    // ── 到貨日期驗證 ─────────────────────────────────────────────────
    const finalArrivalType = arrival_type === 'date' ? 'date' : 'asap';
    const dateCheck = validateArrivalDate(settings, finalArrivalType, arrival_date);
    if (!dateCheck.ok) {
      return res.status(400).json({ success: false, message: dateCheck.message, reason: 'invalid_arrival_date' });
    }

    // ── 付款方式驗證 ─────────────────────────────────────────────────
    const allowedPayments = settings.shipping_payment_methods || ['cash', 'transfer'];
    if (!payment_method || !allowedPayments.includes(payment_method)) {
      return res.status(400).json({ success: false, message: `付款方式「${payment_method || ''}」目前未開放` });
    }

    // ── 建立訂單（寫入既有 orders 表，獨立欄位辨識）───────────────────
    const now = twNow();
    const uuid = uuidv4();
    const orderNo = orderNumber();
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    const nowStr = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
    const itemsJson = JSON.stringify(finalItems);
    const total = finalTotal;

    db.run(
      `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, original_total, coupon_code, total,
        note, sync_status, device_id, source, created_at, updated_at,
        fulfillment_type, order_source,
        shipping_recipient_name, shipping_phone, shipping_postal_code, shipping_city,
        shipping_district, shipping_address, shipping_address_note,
        shipping_arrival_type, shipping_arrival_date, shipping_fee, shipping_free_discount,
        shipping_carrier_name, shipping_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuid, uuid, orderNo, storeId, 'shipping', 'pending', 'pending',
        recipient_name, phone,
        itemsJson, payment_method, payment_method === 'cash' ? 'cash' : 'non_cash', 'pending',
        subtotal, discAmt > 0 ? 'coupon' : 'none', discAmt, subtotal, appliedCouponCode, total,
        note || '', 'synced', 'LINE', 'line', nowStr, nowStr,
        'shipping', 'line_shipping',
        recipient_name, phone, postal_code || '', city || '',
        district || '', address, address_note || '',
        finalArrivalType, finalArrivalType === 'date' ? (arrival_date || '') : '', feeResult.shipping_fee, feeResult.free_discount,
        settings.shipping_carrier_name || '', 'pending',
      ]
    );

    // ── hotfix22-C：寫入 coupon_redemptions（訂單建立成功後，與 line-orders.js 相同做法）──
    if (appliedCouponId) {
      try {
        db.run(
          `INSERT OR IGNORE INTO coupon_redemptions
             (store_id, coupon_id, coupon_code, order_id, order_number,
              customer_phone, discount_amount, original_total, final_total, created_at)
           VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [
            storeId, appliedCouponId, appliedCouponCode,
            uuid, orderNo,
            String(phone || '').trim(),
            discAmt, subtotal, total, nowStr
          ]
        );
      } catch (rErr) {
        console.error('[line-shipping] coupon_redemptions 寫入失敗:', rErr.message);
        // redemption 寫入失敗不中斷訂單，但記錄錯誤（與 line-orders.js 行為一致）
      }
    }

    // ── 扣 LINE 共用份數（若商品設定共用）──────────────────────────
    finalItems.forEach(item => {
      const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [item.product_id, storeId]);
      if (!prod) return;
      if (Number(prod.shipping_share_line_stock) !== 0 && (Number(prod.line_quota_daily) > 0 || Number(prod.line_quota_enabled))) {
        db.run(
          `UPDATE products SET line_quota_sold = MAX(0, line_quota_sold + ?), updated_at=datetime('now','localtime') WHERE id=? AND store_id=?`,
          [Number(item.qty), item.product_id, storeId]
        );
      }
    });

    const newOrder = db.get('SELECT * FROM orders WHERE uuid=? AND store_id=?', [uuid, storeId]);
    try {
      const wss = req.app?.get ? req.app.get('wss') : null;
      broadcastToStore(wss, storeId, { type: 'line_shipping_order_created', order: { ...newOrder, items: finalItems } });
    } catch {}
    triggerN8nWebhook(db, storeId, 'line_shipping_new_order', {
      order_number: orderNo, recipient_name, phone, total, items: finalItems,
    });

    res.json({
      success: true,
      data: {
        order_number: orderNo, uuid, total,
        subtotal, shipping_fee: feeResult.shipping_fee, free_discount: feeResult.free_discount,
        coupon_code: appliedCouponCode, discount_amount: discAmt,
        arrival_type: finalArrivalType, arrival_date: finalArrivalType === 'date' ? arrival_date : '',
        recipient_name, phone, address, payment_method,
        items: finalItems,
      },
    });
  } catch (e) {
    console.error('[line-shipping] POST error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── Hotfix22：客戶端「我的訂單」查詢共用 helper（獨立於 line-orders.js 的 safeOrder，避免耦合）──
const SHIP_STATUS_LABELS = {
  pending: '待確認', accepted: '已接單', packing: '包裝中', shipped: '已出貨',
  delivered: '已送達', completed: '已完成', cancelled: '已取消', returned: '退貨',
};
const SHIP_PAYMENT_STATUS_LABELS = {
  pending: '待付款', paid: '付款成功', failed: '付款失敗', refunded: '退款', cancelled: '取消',
};
const SHIP_PAYMENT_METHOD_LABELS = { cash: '現金', linepay: 'LINE Pay', transfer: '轉帳', credit_card: '信用卡', platform: '平台付款' };

function isFullPhoneShip(input) { return /^\d{6,}$/.test(String(input || '').replace(/[-\s]/g, '')); }

function safeShippingOrder(order) {
  let items = [];
  try { items = typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); } catch {}
  const phone = String(order.shipping_phone || order.customer_phone || '');
  const shipStatus = order.shipping_status || 'pending';
  const payStatus = order.payment_status || 'pending';
  return {
    order_number: order.order_number,
    created_at: order.created_at,
    status: shipStatus,
    status_label: SHIP_STATUS_LABELS[shipStatus] || shipStatus,
    payment_status: payStatus,
    payment_status_label: SHIP_PAYMENT_STATUS_LABELS[payStatus] || payStatus,
    payment_method: order.payment_method || '',
    payment_method_label: SHIP_PAYMENT_METHOD_LABELS[order.payment_method] || order.payment_method || '',
    carrier_name: order.carrier_name || order.shipping_carrier_name || '',
    tracking_number: order.tracking_number || '',
    arrival_type: order.shipping_arrival_type || 'asap',
    arrival_date: order.shipping_arrival_date || '',
    recipient_name: order.shipping_recipient_name || '',
    phone_last3: phone.slice(-3),
    phone,
    address: `${order.shipping_city || ''}${order.shipping_district || ''}${order.shipping_address || ''}`,
    items,
    subtotal: Number(order.subtotal || 0),
    shipping_fee: Number(order.shipping_fee || 0),
    coupon_code: order.coupon_code || '',
    discount_amount: Number(order.discount_amount || 0),
    total: Number(order.total || 0),
    note: order.note || '',
  };
}

// ── POST /api/line-shipping/history — 客戶端「我的訂單」（依電話查詢歷史宅配訂單）──
// 沿用 /api/line-orders/history 相同的查詢慣例（完整電話 → 全部歷史；後三碼 → 需搭配姓名，僅查最近3天），
// 但只查 fulfillment_type='shipping' 的訂單，與 LINE 外帶/外送歷史查詢完全獨立、互不影響。
router.post('/history', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawPhone = String(req.body.phone || '').trim();
    const rawName = String(req.body.customer_name || '').trim();
    if (!rawPhone) return res.status(400).json({ success: false, message: '請輸入電話' });

    const now = twNow();
    const threeDaysAgo = (() => { const d = new Date(now); d.setDate(d.getDate() - 3); return twDateStr(d); })();

    if (isFullPhoneShip(rawPhone)) {
      const cleaned = rawPhone.replace(/[-\s]/g, '');
      const orders = db.all(
        `SELECT * FROM orders WHERE store_id=? AND fulfillment_type='shipping' AND shipping_phone=? ORDER BY created_at DESC LIMIT 30`,
        [storeId, cleaned]
      );
      if (!orders.length) return res.status(404).json({ success: false, message: '查無宅配訂單記錄，請確認電話號碼' });
      return res.json({ success: true, orders: orders.map(safeShippingOrder) });
    }
    if (!rawName) return res.status(400).json({ success: false, message: '電話後三碼查詢需搭配姓名' });
    const last3 = rawPhone.slice(-3);
    if (!/^\d{3}$/.test(last3)) return res.status(400).json({ success: false, message: '電話後三碼請輸入3位數字' });
    const orders = db.all(
      `SELECT * FROM orders WHERE store_id=? AND fulfillment_type='shipping' AND substr(shipping_phone,-3)=? AND shipping_recipient_name LIKE ? AND date(created_at) >= ? ORDER BY created_at DESC LIMIT 30`,
      [storeId, last3, `%${rawName}%`, threeDaysAgo]
    );
    if (!orders.length) return res.status(404).json({ success: false, message: '查無最近3天宅配訂單，請確認資料或詢問店員' });
    return res.json({ success: true, orders: orders.map(safeShippingOrder) });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/line-shipping/order/:orderNo — 查詢宅配訂單 ──────────────
router.get('/order/:orderNo', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const order = db.get(
      `SELECT * FROM orders WHERE store_id=? AND order_number=? AND fulfillment_type='shipping'`,
      [storeId, req.params.orderNo]
    );
    if (!order) return res.status(404).json({ success: false, message: '找不到訂單' });
    let items = [];
    try { items = typeof order.items === 'string' ? JSON.parse(order.items || '[]') : (order.items || []); } catch {}
    res.json({
      success: true,
      data: {
        order_number: order.order_number,
        status: order.shipping_status || order.order_status,
        recipient_name: order.shipping_recipient_name,
        phone: order.shipping_phone,
        address: `${order.shipping_city || ''}${order.shipping_district || ''}${order.shipping_address || ''}`,
        address_note: order.shipping_address_note,
        arrival_type: order.shipping_arrival_type,
        arrival_date: order.shipping_arrival_date,
        items,
        subtotal: Number(order.subtotal || 0),
        shipping_fee: Number(order.shipping_fee || 0),
        coupon_code: order.coupon_code || '',
        discount_amount: Number(order.discount_amount || 0),
        total: Number(order.total || 0),
        payment_method: order.payment_method,
        payment_status: order.payment_status || 'pending',
        payment_status_label: SHIP_PAYMENT_STATUS_LABELS[order.payment_status] || order.payment_status || '待付款',
        carrier_name: order.carrier_name || order.shipping_carrier_name || '',
        tracking_number: order.tracking_number || '',
        shipping_note: order.shipping_note || '',
        created_at: order.created_at,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/line-shipping/admin/orders — Web 後台宅配訂單列表 ────────
// fix18-10-hotfix21：新增 date / date_from / date_to 篩選，供「訂單紀錄」
// 與「LINE 預購管理」的日期快選（含單日）共用同一套查詢邏輯。
router.get('/admin/orders', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { status, limit = 50, offset = 0, date, date_from, date_to } = req.query;
    let where = "WHERE store_id=? AND fulfillment_type='shipping'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND shipping_status=?'; params.push(status); }
    if (date) { where += ' AND DATE(created_at)=?'; params.push(date); }
    else if (date_from && date_to) { where += ' AND DATE(created_at)>=? AND DATE(created_at)<=?'; params.push(date_from, date_to); }
    const orders = db.all(
      `SELECT * FROM orders ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      [...params, Number(limit), Number(offset)]
    ).map(o => ({ ...o, items: typeof o.items === 'string' ? JSON.parse(o.items || '[]') : (o.items || []) }));
    const counts = db.all(
      `SELECT shipping_status, COUNT(*) as cnt FROM orders WHERE store_id=? AND fulfillment_type='shipping' GROUP BY shipping_status`,
      [storeId]
    );
    const statusCounts = {};
    counts.forEach(c => { statusCounts[c.shipping_status || 'pending'] = Number(c.cnt); });
    res.json({ success: true, data: orders, status_counts: statusCounts });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /api/line-shipping/admin/orders/:id/status — 更新宅配狀態 ───
const SHIPPING_STATUSES = ['pending', 'accepted', 'packing', 'shipped', 'delivered', 'completed', 'cancelled'];
router.patch('/admin/orders/:id/status', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawId = req.params.id;
    const newStatus = req.body.status || req.body.shipping_status;
    if (!SHIPPING_STATUSES.includes(newStatus)) {
      return res.status(400).json({ success: false, message: '無效的宅配狀態' });
    }
    const order = db.get(
      `SELECT * FROM orders WHERE store_id=? AND fulfillment_type='shipping' AND (order_number=? OR id=? OR uuid=?)`,
      [storeId, rawId, rawId, rawId]
    );
    if (!order) return res.status(404).json({ success: false, message: '找不到宅配訂單：' + rawId });

    // 選填：物流單號 / 物流公司 / 備註（V1 手動填寫）
    const { tracking_number, carrier_name, shipping_note } = req.body;
    const sets = ['shipping_status=?'];
    const vals = [newStatus];
    if (tracking_number !== undefined) { sets.push('tracking_number=?'); vals.push(tracking_number); }
    if (carrier_name !== undefined) { sets.push('carrier_name=?'); vals.push(carrier_name); }
    if (shipping_note !== undefined) { sets.push('shipping_note=?'); vals.push(shipping_note); }

    // 同步既有 order_status（讓報表能反映完成/取消，其餘中間狀態維持 pending，不影響外帶/外送狀態機邏輯）
    if (newStatus === 'completed') { sets.push('order_status=?'); vals.push('completed'); }
    else if (newStatus === 'cancelled') { sets.push('order_status=?'); vals.push('cancelled'); }
    else if (newStatus === 'accepted') { sets.push('order_status=?'); vals.push('accepted'); }

    sets.push("updated_at=datetime('now','localtime')");
    vals.push(order.id, storeId);
    db.run(`UPDATE orders SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);

    const updated = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId]);
    try {
      const wss = req.app.get('wss');
      broadcastToStore(wss, storeId, { type: 'line_shipping_status_changed', order: updated });
    } catch {}
    triggerN8nWebhook(db, storeId, 'line_shipping_status_changed', {
      order_number: order.order_number, old_status: order.shipping_status, new_status: newStatus,
    });

    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── PATCH /api/line-shipping/admin/orders/:id/tracking — fix18-10-hotfix19 ──
// 專屬更新物流資訊（carrier_name / tracking_number / shipping_note），
// 與 /status 端點分開，方便 Web 後台只更新物流欄位而不變動宅配狀態。
router.patch('/admin/orders/:id/tracking', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const rawId = req.params.id;
    const order = db.get(
      `SELECT * FROM orders WHERE store_id=? AND fulfillment_type='shipping' AND (order_number=? OR id=? OR uuid=?)`,
      [storeId, rawId, rawId, rawId]
    );
    if (!order) return res.status(404).json({ success: false, message: '找不到宅配訂單：' + rawId });

    const { carrier_name, tracking_number, shipping_note } = req.body;
    const sets = []; const vals = [];
    if (carrier_name !== undefined) { sets.push('carrier_name=?'); vals.push(carrier_name); }
    if (tracking_number !== undefined) { sets.push('tracking_number=?'); vals.push(tracking_number); }
    if (shipping_note !== undefined) { sets.push('shipping_note=?'); vals.push(shipping_note); }
    if (!sets.length) return res.status(400).json({ success: false, message: '沒有要更新的物流欄位' });

    sets.push("updated_at=datetime('now','localtime')");
    vals.push(order.id, storeId);
    db.run(`UPDATE orders SET ${sets.join(',')} WHERE id=? AND store_id=?`, vals);

    const updated = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [order.id, storeId]);
    try {
      const wss = req.app.get('wss');
      broadcastToStore(wss, storeId, { type: 'line_shipping_tracking_updated', order: updated });
    } catch {}

    res.json({ success: true, data: updated });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

module.exports = router;
