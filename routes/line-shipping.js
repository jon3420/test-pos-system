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
      },
    });
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
      payment_method, note,
    } = req.body;

    const settings = getShippingSettings(db, storeId);
    if (!settings.shipping_enabled) {
      return res.status(403).json({ success: false, message: '冷藏宅配目前未開放' });
    }
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

    const feeResult = calcShippingFee(settings, subtotal);
    if (feeResult.below_min_order) {
      return res.status(400).json({
        success: false,
        message: `未達最低訂購金額 NT$${settings.shipping_min_order_amount}`,
        reason: 'below_min_order',
      });
    }

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
    const total = feeResult.total;

    db.run(
      `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, original_total, total,
        note, sync_status, device_id, source, created_at, updated_at,
        fulfillment_type, order_source,
        shipping_recipient_name, shipping_phone, shipping_postal_code, shipping_city,
        shipping_district, shipping_address, shipping_address_note,
        shipping_arrival_type, shipping_arrival_date, shipping_fee, shipping_free_discount,
        shipping_carrier_name, shipping_status
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        uuid, uuid, orderNo, storeId, 'shipping', 'pending', 'pending',
        recipient_name, phone,
        itemsJson, payment_method, payment_method === 'cash' ? 'cash' : 'non_cash', 'pending',
        subtotal, 'none', 0, subtotal, total,
        note || '', 'synced', 'LINE', 'line', nowStr, nowStr,
        'shipping', 'line_shipping',
        recipient_name, phone, postal_code || '', city || '',
        district || '', address, address_note || '',
        finalArrivalType, finalArrivalType === 'date' ? (arrival_date || '') : '', feeResult.shipping_fee, feeResult.free_discount,
        settings.shipping_carrier_name || '', 'pending',
      ]
    );

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
        total: Number(order.total || 0),
        payment_method: order.payment_method,
        carrier_name: order.carrier_name || order.shipping_carrier_name || '',
        tracking_number: order.tracking_number || '',
        shipping_note: order.shipping_note || '',
        created_at: order.created_at,
      },
    });
  } catch (e) { res.status(500).json({ success: false, message: e.message }); }
});

// ── GET /api/line-shipping/admin/orders — Web 後台宅配訂單列表 ────────
router.get('/admin/orders', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { status, limit = 50, offset = 0 } = req.query;
    let where = "WHERE store_id=? AND fulfillment_type='shipping'";
    const params = [storeId];
    if (status && status !== 'all') { where += ' AND shipping_status=?'; params.push(status); }
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
