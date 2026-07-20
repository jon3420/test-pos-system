// routes/line-checkout-handoff.js — fix18-10-hotfix26-F8-B（需求文件五／六／十二）
'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const {
  createCartHandoffToken, restoreCartToken, maskCartCode, resolveAddFriendUrl,
  buildDirectLiffCheckoutUrl,
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
  // fix18-10-hotfix30（需求文件十二）：Direct LIFF Checkout 新增觀測階段——
  // 從「後端建好 direct_liff_url」一路到「LIFF 頁面真正還原購物車成功/失敗」，
  // 讓後台能看出使用者卡在哪一段（建立網址／自動或手動開啟／LIFF 載入／還原）。
  'direct_liff_url_created', 'direct_liff_auto_launch_scheduled', 'direct_liff_manual_clicked',
  'direct_liff_open_attempted', 'liff_checkout_loaded', 'cart_restore_started',
  'cart_restore_success', 'cart_restore_failed', 'fallback_to_oa',
  // fix18-10-hotfix30 Final（需求文件二）：訂單送出、Cart Token 正式被消耗
  // 時的終端事件——與 cart_restore_success（只代表「購物車已還原」）分開，
  // 因為 restore 成功之後顧客仍可能放棄結帳，token 要到訂單真的送出才算
  // 「consumed」。
  'cart_token_consumed',
]);
// 需求文件七／十五：合法錯誤碼白名單，對應前端顯示用的 HOF-* 代碼。
const HANDOFF_DIAG_ERROR_CODES = new Set([
  'HANDOFF_TIMEOUT', 'HANDOFF_NETWORK', 'HANDOFF_HTTP_4XX', 'HANDOFF_HTTP_5XX',
  'HANDOFF_INVALID_JSON', 'HANDOFF_MISSING_CART_CODE', 'HANDOFF_MISSING_LINE_URL',
  'HANDOFF_UI_APPLY_FAILED', 'HANDOFF_EMPTY_CART', 'HANDOFF_UNKNOWN',
  // fix18-10-hotfix29-C（需求文件九）：create API 明確錯誤分類，讓後台
  // Messenger Handoff 診斷不再只看到 error_code 是空值。
  'HANDOFF_STORE_ID_MISSING', 'HANDOFF_STORE_NOT_FOUND', 'HANDOFF_INVALID_CART',
  'HANDOFF_PRODUCT_ID_MISSING', 'HANDOFF_QUANTITY_INVALID', 'HANDOFF_BASIC_ID_MISSING',
  'HANDOFF_ADD_FRIEND_URL_MISSING', 'HANDOFF_CREATE_DB_FAILED', 'HANDOFF_CREATE_INTERNAL_ERROR',
  'HANDOFF_CART_SNAPSHOT_MISMATCH',
  // fix18-10-hotfix30（需求文件四）：LIFF ID 未設定，Direct LIFF URL 無法
  // 建立（不是 Basic ID 缺失，兩者是獨立設定，不能混用同一個代碼）。
  'HANDOFF_LIFF_ID_MISSING',
]);
const HANDOFF_DIAG_DEVICES = new Set(['iphone', 'android', 'other']);
const HANDOFF_DIAG_BROWSERS = new Set(['messenger_webview', 'instagram_webview', 'line_liff', 'other']);
// fix18-10-hotfix30（需求文件十二）：Direct LIFF 新增欄位的白名單列舉值——
// 只接受固定字串，不接受任意文字（與既有 stage／error_code 白名單同一套規則）。
const HANDOFF_DIAG_LAUNCH_TARGETS = new Set(['direct_liff', 'oa_message', 'cart_code']);
const HANDOFF_DIAG_RESTORE_RESULTS = new Set(['success', 'failed']);
const HANDOFF_DIAG_RESTORE_ERROR_CODES = new Set([
  'not_found', 'expired', 'consumed', 'cancelled', 'uid_mismatch', 'invalid_state', 'session_invalid',
]);

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
function sanitizeDiagBool(v) { return v === true ? true : (v === false ? false : null); }

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
    // 需求文件九／十：新增欄位，只接受安全範圍內的數字／布林值——不接受
    // 完整商品內容，只接受「數量」這種聚合統計。
    const uiCartCount = sanitizeDiagInt(body.ui_cart_count, 0, 100);
    const payloadCartCount = sanitizeDiagInt(body.payload_cart_count, 0, 100);
    const hasStoreId = sanitizeDiagBool(body.has_store_id);
    const hasBasicId = sanitizeDiagBool(body.has_basic_id);
    const hasAddFriendUrl = sanitizeDiagBool(body.has_add_friend_url);
    const responseOk = sanitizeDiagBool(body.response_ok);
    // fix18-10-hotfix30（需求文件十二）：Direct LIFF 新增欄位——一律白名單
    // 檢查，不接受任意字串／完整網址／完整 token（見檔案開頭的白名單常數）。
    const hasDirectLiffUrl = sanitizeDiagBool(body.has_direct_liff_url);
    const launchTarget = HANDOFF_DIAG_LAUNCH_TARGETS.has(body.launch_target) ? body.launch_target : null;
    const restoreResult = HANDOFF_DIAG_RESTORE_RESULTS.has(body.restore_result) ? body.restore_result : null;
    const restoreErrorCode = HANDOFF_DIAG_RESTORE_ERROR_CODES.has(body.restore_error_code) ? body.restore_error_code : null;
    const tokenConsumed = sanitizeDiagBool(body.token_consumed);
    // fix18-10-hotfix30 Final（需求文件二）：只回報「有沒有 cart_token」這個
    // 布林值，絕不接受／記錄完整 token 字串本身。
    const hasCartToken = sanitizeDiagBool(body.has_cart_token);

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
          ui_cart_count: uiCartCount, payload_cart_count: payloadCartCount,
          has_store_id: hasStoreId, has_basic_id: hasBasicId,
          has_add_friend_url: hasAddFriendUrl, response_ok: responseOk,
          has_direct_liff_url: hasDirectLiffUrl, launch_target: launchTarget,
          restore_result: restoreResult, restore_error_code: restoreErrorCode,
          token_consumed: tokenConsumed, has_cart_token: hasCartToken,
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
  const db = getDb();
  const storeId = req.storeId;

  // 需求文件六：安全摘要 log——只在失敗時記錄，不含完整購物車內容／token／
  // 顧客資料／Channel Secret／Channel Access Token／ID Token／Access Token。
  function logFailure(errorCode, httpStatus, cartItemCount, extra) {
    try {
      console.info('[LINE_HANDOFF_CREATE]', Object.assign({
        store_id: storeId,
        cart_item_count: cartItemCount,
        result: 'failed',
        error_code: errorCode,
        http_status: httpStatus,
      }, extra || {}));
    } catch (e) { /* log 失敗不得影響回應 */ }
  }

  try {
    // 需求文件六：store_id 由 requireStore middleware 保證存在，這裡仍加一層
    // 防禦性檢查（defense-in-depth），不假設上游一定正確設定。
    if (!storeId) {
      logFailure('HANDOFF_STORE_ID_MISSING', 400, 0);
      return res.status(400).json({ ok: false, error_code: 'HANDOFF_STORE_ID_MISSING', message: '缺少 store_id' });
    }
    const storeRow = db.get('SELECT id FROM stores WHERE store_id=?', [storeId]);
    if (!storeRow) {
      logFailure('HANDOFF_STORE_NOT_FOUND', 404, 0);
      return res.status(404).json({ ok: false, error_code: 'HANDOFF_STORE_NOT_FOUND', message: '找不到此店家' });
    }

    const { cart, checkout_context, attribution } = req.body || {};
    const cartItems = cart && Array.isArray(cart.items) ? cart.items : [];

    // 需求文件六（HANDOFF_EMPTY_CART）：這是本版根因修正的核心——前端現在
    // 一律會送出請求（即使購物車真的是空的），讓這裡用統一格式回應，而不是
    // 由前端自己短路猜測、吞掉真正的 error_code／http_status。
    if (!cartItems.length) {
      logFailure('HANDOFF_EMPTY_CART', 400, 0);
      return res.status(400).json({ ok: false, error_code: 'HANDOFF_EMPTY_CART', message: '購物車不能為空' });
    }
    if (cartItems.length > 100) {
      logFailure('HANDOFF_INVALID_CART', 400, cartItems.length);
      return res.status(400).json({ ok: false, error_code: 'HANDOFF_INVALID_CART', message: '購物車商品數量異常' });
    }

    // 需求文件六（HANDOFF_PRODUCT_ID_MISSING／HANDOFF_QUANTITY_INVALID）：
    // 結構驗證——不阻擋「部分商品已停售」這種既有、合法的 recomputeCart()
    // 過濾邏輯，只在「整批商品的 product_id／qty 結構本身就是壞的」時才擋。
    const structurallyValid = cartItems.filter(i => Number(i && i.product_id) > 0 && Number(i && i.qty) > 0);
    if (!structurallyValid.length) {
      const allBadProductId = cartItems.every(i => !(Number(i && i.product_id) > 0));
      const errorCode = allBadProductId ? 'HANDOFF_PRODUCT_ID_MISSING' : 'HANDOFF_QUANTITY_INVALID';
      logFailure(errorCode, 400, cartItems.length);
      return res.status(400).json({
        ok: false, error_code: errorCode,
        message: allBadProductId ? '購物車商品 ID 無效' : '購物車商品數量必須大於 0',
      });
    }

    let result;
    try {
      result = createCartHandoffToken(db, storeId, {
        cartQtyItems: cartItems.map(i => ({ product_id: i.product_id, qty: i.qty })),
        checkoutContext: checkout_context || {},
        attribution: attribution || {},
        createdIp: req.ip || req.headers['x-forwarded-for'] || '',
        createdUserAgent: req.headers['user-agent'] || '',
      });
    } catch (dbErr) {
      // 需求文件六：DB 寫入失敗（例如 UNIQUE 衝突、連線問題）與其他未預期的
      // 內部錯誤分開分類，方便從診斷判斷是資料庫問題還是程式邏輯問題。
      const isDbError = /SQLITE|database|db\b/i.test(String(dbErr && dbErr.message || ''));
      const errorCode = isDbError ? 'HANDOFF_CREATE_DB_FAILED' : 'HANDOFF_CREATE_INTERNAL_ERROR';
      logFailure(errorCode, 500, cartItems.length, { message: dbErr && dbErr.message });
      return res.status(500).json({ ok: false, error_code: errorCode, message: '建立結帳代碼失敗，請稍後再試' });
    }

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
    // 需求文件二／七：single source of truth——用同一個 resolveAddFriendUrl()，
    // 與 /api/line-shop、LINE Integration Center 共用同一套解析規則與優先序。
    const addFriendUrl = resolveAddFriendUrl({
      line_add_friend_url: getSetting(db, storeId, 'line_add_friend_url', ''),
      line_member_add_friend_url: getSetting(db, storeId, 'line_member_add_friend_url', ''),
    });

    // fix18-10-hotfix30（需求文件三／四）：Direct LIFF Checkout URL——只在
    // store 有設定 LIFF ID 時才建得出來；缺 LIFF ID 不能讓整個 Handoff
    // 失敗（維持既有 Bot Handoff 降級路徑），只回傳 direct_liff_url:null +
    // fallback_reason，交給前端決定要不要顯示提示。這裡刻意不把
    // result.token／組好的完整網址寫進任何 log（見需求文件三：不在 log
    // 紀錄完整 Token，不在 diagnostics 顯示完整 URL）。
    const liffId = getSetting(db, storeId, 'line_member_liff_id', '');
    const directLiffUrl = liffId
      ? buildDirectLiffCheckoutUrl({ liffId, storeId, cartToken: result.token })
      : null;
    if (!liffId) {
      logFailure('HANDOFF_LIFF_ID_MISSING', 200, cartItems.length, { result: 'success_with_warning', fallback_reason: 'LIFF_ID_MISSING' });
    }

    // 需求文件六「注意」：add_friend_url／Basic ID 缺失都不阻止 Cart Token 建立
    // 成功——只要 Basic ID 可以組出 OA message URL 就算成功，add_friend_url
    // 缺失只代表 fallback 按鈕不可用，這是既有 Hotfix29 設計好的行為，不改變。
    // 這裡只做非阻擋性的診斷 log，方便從後台看出「雖然成功，但缺了什麼」。
    if (!basicId) logFailure('HANDOFF_BASIC_ID_MISSING', 200, cartItems.length, { result: 'success_with_warning' });

    res.json({
      ok: true,
      cart_code: result.cartCode,
      expires_at: result.expiresAt,
      subtotal: result.subtotal,
      discount: result.discount,
      total: result.total,
      has_unavailable_items: result.hasUnavailableItems,
      // fix18-10-hotfix30（需求文件四）：Direct LIFF Checkout——新的主要導流
      // 網址；缺 LIFF ID 設定時為 null，前端 fallback 回舊有 OA／Cart Code 流程。
      direct_liff_url: directLiffUrl,
      fallback_reason: directLiffUrl ? null : 'LIFF_ID_MISSING',
      line_oa_message_url: lineOaMessageUrl,
      // 需求文件七 fallback：no basic_id 設定時前端只能顯示複製代碼
      line_oa_configured: !!basicId,
      // 需求文件七：single source of truth 的加好友網址，取代前端舊有只讀
      // config.add_friend_url（可能是另一個已經沒在用的欄位）的做法。
      add_friend_url: addFriendUrl,
    });
  } catch (e) {
    logFailure('HANDOFF_CREATE_INTERNAL_ERROR', 500, 0, { message: e.message });
    res.status(500).json({ ok: false, error_code: 'HANDOFF_CREATE_INTERNAL_ERROR', message: e.message });
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
