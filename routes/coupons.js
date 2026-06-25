// routes/coupons.js — fix18-05 優惠券折扣系統 v1
// 功能：
//   GET    /api/coupons           — 列出該店所有優惠券（含使用次數）
//   POST   /api/coupons           — 新增優惠券
//   PATCH  /api/coupons/:id       — 編輯 / 啟停用
//   DELETE /api/coupons/:id       — 刪除優惠券
//   POST   /api/coupons/validate  — 驗證優惠券（LINE 前台用，不需 JWT）
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');
const { getStoreFeatures } = require('../middleware/featureGate');

// ── 工具：台灣時間字串 ──────────────────────────────────
function twNowStr() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
}

// ── 工具：code 正規化（大寫 + trim）────────────────────
function normalizeCode(code) {
  return String(code || '').trim().toUpperCase();
}

// ── 工具：計算折扣金額 ──────────────────────────────────
// discount_type: 'fixed' | 'percent'
// 回傳整數（無條件捨去），且不超過 subtotal
function calcDiscount(coupon, subtotal) {
  let disc = 0;
  if (coupon.discount_type === 'fixed') {
    disc = Number(coupon.discount_value);
  } else if (coupon.discount_type === 'percent') {
    disc = Math.floor(subtotal * Number(coupon.discount_value) / 100);
  }
  return Math.min(Math.max(0, disc), subtotal);
}

// ── 核心驗證邏輯（validate + 下單時重複使用）───────────
// 回傳 { ok, coupon, discount_amount, final_total, message }
function validateCoupon(db, storeId, code, subtotal, customerPhone) {
  const normalCode = normalizeCode(code);
  if (!normalCode) return { ok: false, message: '請輸入優惠券代碼' };

  // 1. 優惠券是否存在
  const coupon = db.get(
    'SELECT * FROM coupons WHERE store_id=? AND code=?',
    [storeId, normalCode]
  );
  if (!coupon) return { ok: false, message: `優惠券「${normalCode}」不存在` };

  // 2. 是否啟用
  if (!Number(coupon.enabled)) return { ok: false, message: '此優惠券已停用' };

  // 3. 有效期間
  const nowStr = twNowStr();
  if (coupon.start_at && coupon.start_at > nowStr)
    return { ok: false, message: '此優惠券尚未開始使用' };
  if (coupon.end_at && coupon.end_at < nowStr)
    return { ok: false, message: '此優惠券已過期' };

  // 4. 最低消費
  const sub = Number(subtotal) || 0;
  if (Number(coupon.min_amount) > 0 && sub < Number(coupon.min_amount))
    return { ok: false, message: `未達最低消費 NT$${coupon.min_amount}` };

  // 5. 總使用次數
  if (Number(coupon.max_usage) > 0) {
    const used = db.get(
      'SELECT COUNT(*) as c FROM coupon_redemptions WHERE store_id=? AND coupon_id=?',
      [storeId, coupon.id]
    );
    if (Number(used.c) >= Number(coupon.max_usage))
      return { ok: false, message: '此優惠券已達使用上限' };
  }

  // 6. 同電話使用次數
  if (Number(coupon.max_usage_per_phone) > 0) {
    const phone = String(customerPhone || '').trim();
    if (!phone) return { ok: false, message: '請填寫電話後再使用優惠券' };
    const perPhone = db.get(
      'SELECT COUNT(*) as c FROM coupon_redemptions WHERE store_id=? AND coupon_id=? AND customer_phone=?',
      [storeId, coupon.id, phone]
    );
    if (Number(perPhone.c) >= Number(coupon.max_usage_per_phone))
      return { ok: false, message: '此優惠券每支電話限使用' + coupon.max_usage_per_phone + '次，已達上限' };
  }

  // 7. 計算折扣（折扣不可大於訂單金額）
  const discount_amount = calcDiscount(coupon, sub);
  if (discount_amount <= 0)
    return { ok: false, message: '此優惠券折扣為 0，無法套用' };

  const final_total = sub - discount_amount;

  return {
    ok: true,
    coupon: {
      id: coupon.id,
      code: coupon.code,
      name: coupon.name,
      discount_type: coupon.discount_type,
      discount_value: coupon.discount_value,
    },
    discount_amount,
    final_total,
  };
}

// ── GET /api/coupons — 列出優惠券 ──────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const coupons = db.all(
      `SELECT c.*,
         (SELECT COUNT(*) FROM coupon_redemptions r WHERE r.coupon_id=c.id AND r.store_id=c.store_id) as usage_count
       FROM coupons c
       WHERE c.store_id=?
       ORDER BY c.id DESC`,
      [storeId]
    );
    res.json({ success: true, data: coupons });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/coupons/validate — 驗證優惠券（LINE 前台）
// 注意：此路由必須在 POST /api/coupons 之前宣告，避免 :id 衝突
router.post('/validate', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { code, subtotal, customer_phone } = req.body;

    // fix18-05: 檢查 coupon feature 是否啟用
    const features = getStoreFeatures(storeId);
    if (features.coupon !== true) {
      return res.status(403).json({
        success: false,
        error:   'COUPON_FEATURE_DISABLED',
        message: '優惠券功能未啟用，請聯絡店家'
      });
    }

    const result = validateCoupon(db, storeId, code, subtotal, customer_phone);
    if (!result.ok) return res.status(400).json({ success: false, message: result.message });

    res.json({
      success: true,
      coupon: result.coupon,
      discount_amount: result.discount_amount,
      final_total: result.final_total,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── POST /api/coupons — 新增優惠券 ────────────────────
router.post('/', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const {
      code, name, discount_type, discount_value,
      min_amount, start_at, end_at,
      max_usage, max_usage_per_phone, enabled
    } = req.body;

    const normalCode = normalizeCode(code);
    if (!normalCode) return res.status(400).json({ success: false, message: '請輸入優惠券代碼' });
    if (!name) return res.status(400).json({ success: false, message: '請輸入優惠券名稱' });
    if (!['fixed', 'percent'].includes(discount_type))
      return res.status(400).json({ success: false, message: '折扣類型必須為 fixed 或 percent' });
    if (!Number(discount_value) || Number(discount_value) <= 0)
      return res.status(400).json({ success: false, message: '折扣金額必須大於 0' });
    if (discount_type === 'percent' && Number(discount_value) > 100)
      return res.status(400).json({ success: false, message: '百分比折扣不可超過 100' });

    // 檢查 code 唯一性
    const existing = db.get('SELECT id FROM coupons WHERE store_id=? AND code=?', [storeId, normalCode]);
    if (existing) return res.status(400).json({ success: false, message: `代碼「${normalCode}」已存在` });

    const nowStr = twNowStr();
    const result = db.run(
      `INSERT INTO coupons
         (store_id, code, name, discount_type, discount_value,
          min_amount, start_at, end_at, max_usage, max_usage_per_phone, enabled,
          created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        storeId, normalCode, name.trim(), discount_type, Number(discount_value),
        Number(min_amount) || 0,
        start_at || '',
        end_at   || '',
        Number(max_usage) || 0,
        Number(max_usage_per_phone) || 0,
        enabled === false || enabled === 0 ? 0 : 1,
        nowStr, nowStr
      ]
    );
    const newCoupon = db.get('SELECT * FROM coupons WHERE id=?', [result.lastInsertRowid]);
    res.json({ success: true, data: newCoupon });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PATCH /api/coupons/:id — 編輯 / 啟停用 ───────────
router.patch('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { id } = req.params;

    const existing = db.get('SELECT * FROM coupons WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '優惠券不存在' });

    const {
      code, name, discount_type, discount_value,
      min_amount, start_at, end_at,
      max_usage, max_usage_per_phone, enabled
    } = req.body;

    // 若傳入 code，需正規化並檢查唯一性
    let normalCode = existing.code;
    if (code !== undefined) {
      normalCode = normalizeCode(code);
      if (!normalCode) return res.status(400).json({ success: false, message: '代碼不可為空' });
      const dup = db.get(
        'SELECT id FROM coupons WHERE store_id=? AND code=? AND id!=?',
        [storeId, normalCode, id]
      );
      if (dup) return res.status(400).json({ success: false, message: `代碼「${normalCode}」已被其他優惠券使用` });
    }

    // percent 折扣驗證
    const newDiscType  = discount_type  !== undefined ? discount_type  : existing.discount_type;
    const newDiscValue = discount_value !== undefined ? Number(discount_value) : Number(existing.discount_value);
    if (newDiscType === 'percent' && newDiscValue > 100)
      return res.status(400).json({ success: false, message: '百分比折扣不可超過 100' });

    const nowStr = twNowStr();
    db.run(
      `UPDATE coupons SET
         code=?, name=?, discount_type=?, discount_value=?,
         min_amount=?, start_at=?, end_at=?,
         max_usage=?, max_usage_per_phone=?, enabled=?,
         updated_at=?
       WHERE id=? AND store_id=?`,
      [
        normalCode,
        name      !== undefined ? name.trim()           : existing.name,
        newDiscType,
        newDiscValue,
        min_amount !== undefined ? Number(min_amount)   : Number(existing.min_amount),
        start_at   !== undefined ? (start_at || '')     : existing.start_at,
        end_at     !== undefined ? (end_at   || '')     : existing.end_at,
        max_usage  !== undefined ? Number(max_usage)    : Number(existing.max_usage),
        max_usage_per_phone !== undefined
          ? Number(max_usage_per_phone)
          : Number(existing.max_usage_per_phone),
        enabled !== undefined ? (Number(enabled) ? 1 : 0) : Number(existing.enabled),
        nowStr,
        id, storeId
      ]
    );
    const updated = db.get('SELECT * FROM coupons WHERE id=? AND store_id=?', [id, storeId]);
    res.json({ success: true, data: updated });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── DELETE /api/coupons/:id — 刪除 ────────────────────
router.delete('/:id', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { id } = req.params;
    const existing = db.get('SELECT id FROM coupons WHERE id=? AND store_id=?', [id, storeId]);
    if (!existing) return res.status(404).json({ success: false, message: '優惠券不存在' });
    db.run('DELETE FROM coupons WHERE id=? AND store_id=?', [id, storeId]);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// 匯出 validateCoupon 供 line-orders.js 使用
module.exports = router;
module.exports.validateCoupon = validateCoupon;
