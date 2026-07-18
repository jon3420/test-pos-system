// routes/line-checkout-handoff.js — fix18-10-hotfix26-F8-B（需求文件五／六／十二）
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const {
  createCartHandoffToken, restoreCartToken, maskCartCode,
} = require('../utils/lineCheckoutHandoff');
const { verifyMemberSession } = require('../utils/lineMemberSession');

function getSetting(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// 需求文件六：組出 https://line.me/R/oaMessage/{basic_id}/?{message}，訊息只放 cart_code。
function buildOaMessageUrl(basicId, cartCode) {
  if (!basicId) return '';
  const message = `我要結帳 ${cartCode}`;
  return `https://line.me/R/oaMessage/${encodeURIComponent(basicId)}/?${encodeURIComponent(message)}`;
}

// POST /api/line-checkout-handoff/create
router.post('/create', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { cart, checkout_context, attribution } = req.body || {};

    const cartItems = cart && Array.isArray(cart.items) ? cart.items : [];
    if (!cartItems.length) return res.status(400).json({ success: false, message: '購物車不能為空' });
    if (cartItems.length > 100) return res.status(400).json({ success: false, message: '購物車商品數量異常' });

    const result = createCartHandoffToken(db, storeId, {
      cartQtyItems: cartItems.map(i => ({ product_id: i.product_id, qty: i.qty })),
      checkoutContext: checkout_context || {},
      attribution: attribution || {},
      createdIp: req.ip || req.headers['x-forwarded-for'] || '',
      createdUserAgent: req.headers['user-agent'] || '',
    });

    try {
      const { logServerEvent } = require('../utils/analyticsLog');
      logServerEvent(db, {
        store_id: storeId,
        visitor_id: (req.body && req.body.visitor_id) || `handoff_${result.cartCode}`,
        session_id: (req.body && req.body.session_id) || `handoff_${result.cartCode}`,
        event_name: 'line_checkout_handoff_created',
        metadata: { cart_code_masked: maskCartCode(result.cartCode), item_count: cartItems.length },
      });
    } catch (e) { /* Analytics 失敗不擋主流程 */ }

    const basicId = getSetting(db, storeId, 'line_official_basic_id', '');
    const lineOaMessageUrl = buildOaMessageUrl(basicId, result.cartCode);

    res.json({
      ok: true,
      cart_code: result.cartCode,
      expires_at: result.expiresAt,
      subtotal: result.subtotal,
      discount: result.discount,
      total: result.total,
      has_unavailable_items: result.hasUnavailableItems,
      line_oa_message_url: lineOaMessageUrl,
      // 需求文件七 fallback：no basic_id 設定時前端只能顯示複製代碼
      line_oa_configured: !!basicId,
    });
  } catch (e) {
    console.error('[line-checkout-handoff] create error:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

// POST /api/line-checkout-handoff/restore
router.post('/restore', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { cart_token, member_session } = req.body || {};
    if (!cart_token || !member_session) {
      return res.status(400).json({ ok: false, message: '缺少 cart_token 或 member_session' });
    }
    // 需求文件十二：不信任前端直接傳的 line_user_id，一律用伺服器簽章過的
    // member_session 反解（沿用 utils/lineMemberSession.js 既有機制，與訂單
    // 建立、好友驗證等端點使用同一套信任邊界）。
    const line_user_id = verifyMemberSession(member_session, storeId);
    if (!line_user_id) {
      return res.status(401).json({ ok: false, reason: 'session_invalid', message: '尚未登入或登入已過期，請重新透過 LINE 開啟結帳連結。' });
    }

    const result = restoreCartToken(db, storeId, String(cart_token), line_user_id);
    if (!result.ok) {
      const messages = {
        not_found: '找不到此結帳連結，請重新從購物車發起結帳。',
        expired: '此結帳連結已過期，請重新從購物車發起結帳。',
        consumed: '此結帳連結已完成或已失效。',
        cancelled: '此結帳連結已取消。',
        uid_mismatch: '此結帳連結與目前登入的 LINE 帳號不符。',
        invalid_state: '此結帳連結目前無法使用，請重新從購物車發起結帳。',
      };
      return res.status(409).json({ ok: false, reason: result.reason, message: messages[result.reason] || '無法還原購物車' });
    }

    try {
      const { logServerEvent } = require('../utils/analyticsLog');
      const crypto = require('crypto');
      const tokenFingerprint = crypto.createHash('sha256').update(String(cart_token)).digest('hex').slice(0, 16);
      logServerEvent(db, {
        store_id: storeId,
        visitor_id: `restore_${line_user_id}`,
        session_id: `restore_${tokenFingerprint}`,
        event_name: 'line_checkout_cart_restored', line_user_id, metadata: {},
      });
    } catch (e) {}

    res.json({
      ok: true,
      cart: result.cart,
      checkout_context: result.checkout_context,
      has_unavailable_items: result.has_unavailable_items,
      notice: result.has_unavailable_items ? '部分商品資訊已更新，請確認最新內容後再結帳。' : '',
      expires_at: result.expires_at,
    });
  } catch (e) {
    console.error('[line-checkout-handoff] restore error:', e.message);
    res.status(500).json({ ok: false, message: e.message });
  }
});

module.exports = router;
