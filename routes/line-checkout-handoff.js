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

// ── fix18-10-hotfix29-B（需求文件五）：Handoff 診斷回報端點 ───────────────
// 簡易 in-memory rate limit（同一 store + IP），沿用 routes/line-member.js
// 的既有手法，不新增共用模組。每 60 秒最多 30 次（診斷事件本來就該遠比
// 一般 API 呼叫少，30 次已足夠涵蓋「開 Dialog → 重試 → fallback」整條流程）。
const DIAG_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const DIAG_RATE_LIMIT_MAX = 30;
const diagRateBucket = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of diagRateBucket.entries()) {
    if (now - entry.windowStart > DIAG_RATE_LIMIT_WINDOW_MS) diagRateBucket.delete(key);
  }
}, 5 * 60 * 1000).unref?.();
function checkDiagRateLimit(storeId, ip) {
  const key = `${storeId}|${ip}`;
  const now = Date.now();
  let entry = diagRateBucket.get(key);
  if (!entry || now - entry.windowStart > DIAG_RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    diagRateBucket.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= DIAG_RATE_LIMIT_MAX;
}

// 需求文件三：合法階段名稱白名單，不接受任意字串（避免塞入無意義/超長資料）。
const HANDOFF_DIAG_STAGES = new Set([
  'dialog_opened', 'prepare_started', 'request_started', 'request_completed',
  'response_parsed', 'response_validated', 'ui_applied', 'auto_launch_scheduled',
  'auto_launch_attempted', 'fallback_entered', 'retry_started', 'retry_completed',
]);
// 需求文件七／十五：合法錯誤碼白名單，對應前端顯示用的 HOF-* 代碼。
const HANDOFF_DIAG_ERROR_CODES = new Set([
  'HANDOFF_TIMEOUT', 'HANDOFF_NETWORK', 'HANDOFF_HTTP_4XX', 'HANDOFF_HTTP_5XX',
  'HANDOFF_INVALID_JSON', 'HANDOFF_MISSING_CART_CODE', 'HANDOFF_MISSING_LINE_URL',
  'HANDOFF_UI_APPLY_FAILED', 'HANDOFF_EMPTY_CART', 'HANDOFF_UNKNOWN',
]);
const HANDOFF_DIAG_DEVICES = new Set(['iphone', 'android', 'other']);
const HANDOFF_DIAG_BROWSERS = new Set(['messenger_webview', 'instagram_webview', 'line_liff', 'other']);

function sanitizeDiagString(v, maxLen) {
  if (typeof v !== 'string') return null;
  const s = v.slice(0, maxLen).replace(/[^a-zA-Z0-9_\-]/g, '');
  return s || null;
}
function sanitizeDiagInt(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const r = Math.trunc(n);
  if (r < min || r > max) return null;
  return r;
}

// POST /api/line-checkout-handoff/diagnostics
// 需求文件五：payload 僅允許固定欄位，不接受 token／完整 UID／購物車內容／
// 任意 object；診斷本身失敗絕不可拋出例外阻擋顧客結帳（呼叫端也是
// fire-and-forget，這裡的 try/catch 是第二道保險）。
router.post('/diagnostics', (req, res) => {
  try {
    const storeId = req.storeId;
    const ip = req.ip || req.headers['x-forwarded-for'] || '';
    if (!checkDiagRateLimit(storeId, ip)) {
      // 需求文件五：不得影響結帳主流程，rate limit 也只回應本端點本身。
      return res.status(429).json({ ok: false, reason: 'rate_limited' });
    }

    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const stage = HANDOFF_DIAG_STAGES.has(body.stage) ? body.stage : 'unknown';
    const attempt = sanitizeDiagInt(body.attempt, 1, 5) || 1;
    const httpStatus = sanitizeDiagInt(body.http_status, 100, 599);
    const errorCode = HANDOFF_DIAG_ERROR_CODES.has(body.error_code) ? body.error_code : null;
    const hasCartCode = body.has_cart_code === true;
    const hasLineOaMessageUrl = body.has_line_oa_message_url === true;
    const fallbackReason = sanitizeDiagString(body.fallback_reason, 60);
    const device = HANDOFF_DIAG_DEVICES.has(body.device) ? body.device : 'other';
    const browser = HANDOFF_DIAG_BROWSERS.has(body.browser) ? body.browser : 'other';

    try {
      const db = getDb();
      const { logServerEvent } = require('../utils/analyticsLog');
      logServerEvent(db, {
        store_id: storeId,
        visitor_id: `handoff_diag_${storeId}`,
        session_id: `handoff_diag_${storeId}_${Date.now()}`,
        event_name: 'line_checkout_handoff_diagnostics',
        metadata: {
          stage, attempt, http_status: httpStatus, error_code: errorCode,
          has_cart_code: hasCartCode, has_line_oa_message_url: hasLineOaMessageUrl,
          fallback_reason: fallbackReason, device, browser,
        },
      });
    } catch (e) { /* 診斷寫入失敗不得影響回應 */ }

    res.json({ ok: true });
  } catch (e) {
    // 需求文件五：診斷 API 失敗不得阻擋顧客，一律回 200 讓前端 fire-and-forget 收尾。
    res.json({ ok: false });
  }
});

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
