// utils/lineCheckoutHandoff.js — fix18-10-hotfix26-F8-B（需求文件四～十九）
//
// Messenger →「到 LINE 完成結帳」的一次性 Cart Handoff Token。
//
// 設計重點：
//   - token：完整 secret（>=128-bit entropy，crypto.randomBytes(24) = 192 bits，
//     base64url 顯示），只用來做 LIFF restore，絕不出現在 URL query 明顯位置／
//     Log／CSV／Analytics（只存後端 DB，LIFF URL 用 query string 帶，但那是
//     HTTPS 加密連線+即用即棄，並非本檔案能控制的層次，已是業界慣例作法）。
//   - cart_code：短碼「CART-XXXXXX」，只給使用者看／貼到 LINE 對話框輸入，
//     單獨無法用來 restore 購物車（restore 一定要完整 token），符合需求文件
//     六「不要將購物車明細…敏感資料放進 URL」「只放 cart_code」。
//   - status 狀態機：pending → bound（webhook 綁定 UID）→ opened（LIFF 已讀取）
//     → consumed（訂單成立）；或 expired／cancelled。
'use strict';

const crypto = require('crypto');

const CART_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆字元 0/O/1/I/L
const TOKEN_TTL_MINUTES = 30;

function _nowLocal() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function _addMinutes(minutes) {
  const d = new Date(Date.now() + minutes * 60000);
  const twStr = d.toLocaleString('en-US', { timeZone: 'Asia/Taipei' });
  const dd = new Date(twStr);
  const p = n => String(n).padStart(2, '0');
  return `${dd.getFullYear()}-${p(dd.getMonth() + 1)}-${p(dd.getDate())} ${p(dd.getHours())}:${p(dd.getMinutes())}:${p(dd.getSeconds())}`;
}

function generateFullToken() {
  // 24 bytes = 192-bit entropy，遠超需求文件要求的 128-bit
  return crypto.randomBytes(24).toString('base64url');
}
function generateCartCode() {
  let s = '';
  const bytes = crypto.randomBytes(6);
  for (let i = 0; i < 6; i++) s += CART_CODE_ALPHABET[bytes[i] % CART_CODE_ALPHABET.length];
  return 'CART-' + s;
}
function maskCartCode(code) {
  if (!code) return '';
  return code.slice(0, 8) + '***'; // CART-A7***
}

/**
 * 需求文件五：後端自行重新驗證商品/價格/數量/折扣/總金額，不信任前端 total。
 * @param {object} db
 * @param {string} storeId
 * @param {Array<{product_id:number, qty:number}>} rawItems
 * @param {string} [couponCode]
 * @param {string} [customerPhone]
 */
function recomputeCart(db, storeId, rawItems, couponCode, customerPhone) {
  const items = [];
  let subtotal = 0;
  let hasUnavailable = false;
  for (const it of Array.isArray(rawItems) ? rawItems : []) {
    const pid = Number(it.product_id);
    const qty = Math.max(0, Number(it.qty) || 0);
    if (!pid || qty <= 0) continue;
    const prod = db.get('SELECT id, name, price, enabled FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    if (!prod || !Number(prod.enabled)) { hasUnavailable = true; continue; }
    const lineTotal = Number(prod.price) * qty;
    subtotal += lineTotal;
    items.push({ product_id: pid, name: prod.name, price: Number(prod.price), qty, line_total: lineTotal });
  }
  subtotal = Math.round(subtotal * 100) / 100;

  let discount = 0;
  let couponResult = null;
  if (couponCode) {
    try {
      const { validateCoupon } = require('../routes/coupons');
      couponResult = validateCoupon(db, storeId, couponCode, subtotal, customerPhone);
      if (couponResult && couponResult.ok) discount = couponResult.discount_amount;
    } catch (e) { console.warn('[lineCheckoutHandoff] coupon recompute failed:', e.message); }
  }

  return {
    items, subtotal, discount,
    coupon_ok: couponResult ? !!couponResult.ok : null,
    coupon_message: couponResult && !couponResult.ok ? couponResult.message : '',
    has_unavailable_items: hasUnavailable,
  };
}

/**
 * 需求文件四／五：建立一次性 Cart Handoff Token。
 */
function createCartHandoffToken(db, storeId, { cartQtyItems, checkoutContext, attribution, createdIp, createdUserAgent }) {
  const recompute = recomputeCart(db, storeId, cartQtyItems, checkoutContext && checkoutContext.coupon_code, checkoutContext && checkoutContext.customer_phone);

  const token = generateFullToken();
  let cartCode = generateCartCode();
  // 短碼碰撞極低機率，仍防呆重試（同店未過期 code 不可重複，UNIQUE index 也會擋）
  for (let i = 0; i < 5; i++) {
    const clash = db.get('SELECT id FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=? AND status NOT IN (?,?,?)', [storeId, cartCode, 'consumed', 'expired', 'cancelled']);
    if (!clash) break;
    cartCode = generateCartCode();
  }

  const now = _nowLocal();
  const expiresAt = _addMinutes(TOKEN_TTL_MINUTES);

  const deliveryMode = (checkoutContext && checkoutContext.order_type) || '';
  // 需求文件十三：restore 時要「重新」判斷商品是否停售/變價，不能只繼承建立當下
  // 的判斷結果——所以這裡存「原始請求的 product_id+qty」（包含當下已停售的），
  // 而不是 recomputeCart() 過濾後的 items（那份已經把停售商品拿掉了）。
  const rawRequestedItems = (Array.isArray(cartQtyItems) ? cartQtyItems : [])
    .map(i => ({ product_id: Number(i.product_id), qty: Number(i.qty) }))
    .filter(i => i.product_id && i.qty > 0);
  const cartPayload = JSON.stringify({ items: rawRequestedItems });
  const checkoutContextToStore = JSON.stringify(checkoutContext || {});
  const attributionToStore = JSON.stringify(attribution || {});

  db.run(
    `INSERT INTO line_cart_handoff_tokens
      (token, store_id, cart_code, status, cart_json, subtotal, delivery_mode,
       attribution_json, checkout_context_json, created_at, expires_at,
       created_ip, created_user_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      token, storeId, cartCode, 'pending', cartPayload, recompute.subtotal, deliveryMode,
      attributionToStore, checkoutContextToStore, now, expiresAt,
      createdIp || '', (createdUserAgent || '').slice(0, 500),
    ]
  );

  return {
    token, cartCode, expiresAt, subtotal: recompute.subtotal, discount: recompute.discount,
    total: Math.max(0, recompute.subtotal - recompute.discount),
    hasUnavailableItems: recompute.has_unavailable_items,
  };
}

function _isExpired(row, nowStr) {
  return !row.expires_at || row.expires_at < nowStr;
}

/**
 * 需求文件八～九：webhook 收到「我要結帳 CART-XXXXXX」，用短碼查詢並綁定 UID。
 * 找不到／過期／已消費，回傳 { ok:false, reason }，呼叫端決定要回覆什麼訊息。
 */
function bindTokenToLineUser(db, storeId, cartCode, lineUserId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [storeId, cartCode]);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now) && row.status !== 'expired') {
    db.run("UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled' || row.status === 'expired') return { ok: false, reason: row.status };
  // 需求文件九：不可綁定第二個 UID——已綁定過的 token 只認第一個 UID
  if (row.line_user_id && row.line_user_id !== lineUserId) {
    return { ok: false, reason: 'already_bound_other_user' };
  }
  db.run(
    "UPDATE line_cart_handoff_tokens SET line_user_id=?, status='bound', bound_at=? WHERE id=?",
    [lineUserId, now, row.id]
  );
  return { ok: true, token: row.token, cartCode: row.cart_code };
}

/**
 * 需求文件十二：LIFF Restore——完整 secret token + store_id + line_user_id 三者一致才能還原。
 *
 * fix18-10-hotfix30（需求文件九）：Direct LIFF Checkout 跳過了「進聊天室輸入
 * 我要結帳 CART-XXXXXX」這一步，代表 token 在使用者第一次點擊 Direct LIFF
 * 連結、進到這裡時，狀態機仍停在建立當下的 'pending'（過去只有 Bot Webhook
 * 收到訊息才會呼叫 bindTokenToLineUser() 把 pending→bound）。這裡補上「第一次
 * restore 時，若 token 還是 pending，直接綁定目前這個已通過 LIFF/member_session
 * 驗證的 line_user_id」，讓 Direct LIFF 與舊有聊天室 Bot Handoff 共用同一套
 * 狀態機、同一個 restore 函式——不新增第二套驗證邏輯。信任等級與舊流程一致：
 * 舊流程信任「知道完整 cart_code＋能在 LINE 官方帳號聊天室收到訊息的人」；
 * 這裡信任「知道完整 secret token（>=128-bit，只存在於 Direct LIFF URL）＋
 * 通過伺服器簽章 member_session 驗證的人」，安全性不低於舊流程。
 * 已經綁定過的 token（bound／opened，來自舊聊天室流程或本流程已跑過一次）
 * 完全不受影響，行為與 Hotfix26-F8-B 原版一致。
 */
function restoreCartToken(db, storeId, fullToken, lineUserId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [storeId, fullToken]);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') db.run("UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };

  if (row.status === 'pending' && !row.line_user_id) {
    // 需求文件九：Direct LIFF 第一次進站——原地把 pending 綁定成 bound，
    // 不需要先經過聊天室 Bot Webhook。
    db.run("UPDATE line_cart_handoff_tokens SET line_user_id=?, status='bound', bound_at=? WHERE id=?", [lineUserId, now, row.id]);
    row.line_user_id = lineUserId;
    row.status = 'bound';
  }

  if (!row.line_user_id || row.line_user_id !== lineUserId) return { ok: false, reason: 'uid_mismatch' };
  if (!['bound', 'opened'].includes(row.status)) return { ok: false, reason: 'invalid_state' };

  if (row.status === 'bound') {
    db.run("UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=?", [now, row.id]);
  }

  let cartPayload = {}; let checkoutContext = {};
  try { cartPayload = JSON.parse(row.cart_json || '{}'); } catch {}
  try { checkoutContext = JSON.parse(row.checkout_context_json || '{}'); } catch {}

  // 需求文件十三：還原後重新計算，不信任快照金額
  const recompute = recomputeCart(db, storeId, (cartPayload.items || []).map(i => ({ product_id: i.product_id, qty: i.qty })), checkoutContext.coupon_code, checkoutContext.customer_phone);

  return {
    ok: true,
    cart: { items: recompute.items, subtotal: recompute.subtotal, discount: recompute.discount, total: Math.max(0, recompute.subtotal - recompute.discount) },
    checkout_context: checkoutContext,
    has_unavailable_items: recompute.has_unavailable_items,
    expires_at: row.expires_at,
  };
}

/**
 * 需求文件十五：訂單成立後消費 token，同一 token 不可再產生第二筆訂單。
 */
function consumeCartToken(db, storeId, fullToken, orderId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [storeId, fullToken]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  const now = _nowLocal();
  db.run("UPDATE line_cart_handoff_tokens SET status='consumed', consumed_at=?, order_id=? WHERE id=?", [now, String(orderId || ''), row.id]);
  return { ok: true };
}

/**
 * fix18-10-hotfix29-C（需求文件二）：加入好友網址的單一真實來源解析。
 *
 * 背景：LINE 整合中心與 LINE 會員登入設定歷史上各自存了一個獨立欄位
 * （line_add_friend_url／line_member_add_friend_url），導致店家在其中一個
 * 頁面設定好網址，另一個頁面／結帳 Dialog 卻讀不到，誤顯示「商家尚未設定」。
 *
 * 優先序：line_add_friend_url（正式欄位）→ line_member_add_friend_url
 * （舊欄位，相容 fallback）→ official_account_add_friend_url（更舊的別名，
 * 若專案曾經用過）。不做破壞性 migration，只在讀取時統一解析。
 *
 * 同時過濾：
 *   - 空白／純空格
 *   - 已知的表單 placeholder 文字（例如 "https://lin.ee/xxxxx"），避免店家
 *     不小心把輸入框的提示文字存成正式設定
 *   - 格式不是 https://lin.ee/<id> 或 https://line.me/... 的值
 */
const ADD_FRIEND_URL_PLACEHOLDERS = new Set([
  'https://lin.ee/xxxxx',
  'https://lin.ee/xxxx',
  'https://line.me/xxxxx',
]);
function resolveAddFriendUrl(settings) {
  const s = settings || {};
  const candidates = [
    s.line_add_friend_url,
    s.line_member_add_friend_url,
    s.official_account_add_friend_url,
  ];
  for (const raw of candidates) {
    const value = String(raw || '').trim();
    if (!value) continue;
    if (ADD_FRIEND_URL_PLACEHOLDERS.has(value.toLowerCase())) continue;
    if (!/^https:\/\/(lin\.ee\/[A-Za-z0-9_-]+|line\.me\/[A-Za-z0-9_\-\/.]+)/i.test(value)) continue;
    return value;
  }
  return '';
}

/**
 * fix18-10-hotfix30（需求文件三）：Direct LIFF Checkout URL——單一組裝點。
 * 後端統一建立，前端不自行拼接（避免 liffId／store_id／cart_token 三者裡
 * 任何一個被前端用錯誤來源覆蓋）。
 *
 * 要求（需求文件三）：
 *   - liffId 由呼叫端從 store 正式設定（settings.line_member_liff_id）取得
 *   - storeId 由呼叫端傳入已驗證的店家 ID（req.storeId，不是前端可任意帶的值）
 *   - cartToken 是後端剛建立的完整 secret token（不是 cart_code 短碼）
 * 三者缺一即回傳 null，呼叫端負責決定 fallback（見需求文件四
 * fallback_reason: 'LIFF_ID_MISSING'）。
 */
function buildDirectLiffCheckoutUrl({ liffId, storeId, cartToken }) {
  if (!liffId || !storeId || !cartToken) return null;
  try {
    const url = new URL(`https://liff.line.me/${liffId}`);
    url.searchParams.set('mode', 'checkout');
    url.searchParams.set('store_id', storeId);
    url.searchParams.set('cart_token', cartToken);
    return url.toString();
  } catch (e) {
    return null;
  }
}

module.exports = {
  generateFullToken, generateCartCode, maskCartCode, recomputeCart,
  createCartHandoffToken, bindTokenToLineUser, restoreCartToken, consumeCartToken,
  resolveAddFriendUrl, buildDirectLiffCheckoutUrl,
  TOKEN_TTL_MINUTES,
};
