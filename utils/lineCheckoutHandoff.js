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
/**
 * H1.4.10 Phase 4B（需求文件十九～二十二）：Recovery Push 內的安全連結。
 * 沿用同一張 line_cart_handoff_tokens 表（additive purpose='recovery_resume'
 * 欄位），不建立第二張 Recovery Token table。
 *
 * 與既有 checkout handoff token 的關鍵差異：
 *   - 建立當下就已知道 line_user_id（Recovery job 早就綁定過，不需要等
 *     webhook 才綁定），所以這裡直接把 line_user_id 存進 row，不走
 *     pending→bound 的狀態機。
 *   - TTL 24 小時（不是 checkout token 的 30 分鐘），但不得超過 Recovery
 *     Job 的可追回 horizon（也是 24 小時，見 utils/cartRecovery.js
 *     CURRENT_RECOVERABLE_HORIZON_HOURS）。
 *   - URL 只放這裡產生的 token 本身（cryptographically random），不放
 *     cart_id／line_user_id／order_id 當可操作參數；也絕不把姓名/電話/地址
 *     放進 cart_json 快照（cartQtyItems 只允許 product_id+qty，與既有
 *     createCartHandoffToken 的 rawRequestedItems 做法一致）。
 */
const RECOVERY_TOKEN_TTL_MINUTES = 24 * 60;

const RECOVERY_PAGE_TYPES = new Set(['line_order', 'line_shipping']);

function createRecoveryResumeToken(db, storeId, { cartId, lineUserId, cartQtyItems, orderId = '', resumeType = 'cart', pageType, ttlMinutes }) {
  if (!storeId || !cartId || !lineUserId) return { ok: false, reason: 'missing_required_fields' };
  // 需求文件三：token 必須知道自己原本屬於哪一頁，否則同一個 token 被貼到
  // 錯的 LIFF/頁面時 backend 無從拒絕。沒有合法 pageType 一律安全拒絕，不猜測。
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_page_type' };
  const token = generateFullToken();
  const now = _nowLocal();
  // line_cart_handoff_tokens 對 (store_id, cart_code) 有 UNIQUE index（給既有
  // checkout handoff 短碼查詢用）。recovery_resume token 不使用短碼，但仍必須
  // 給一個店內唯一值，否則第二筆 recovery token 會撞到既有 checkout token 的
  // UNIQUE 限制（cart_code 預設空字串，多筆 recovery token 會互相衝突）。
  let cartCode = generateCartCode();
  for (let i = 0; i < 5; i++) {
    const clash = db.get('SELECT id FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [storeId, cartCode]);
    if (!clash) break;
    cartCode = generateCartCode();
  }
  // 需求文件十八：Token TTL 不得晚於 Recovery Job 的 current-recoverable
  // horizon；呼叫端（utils/cartRecoveryDelivery.js）負責算出「不超過 24 小時
  // 且不超過 job 剩餘可追回時間」的實際分鐘數傳進來，這裡只在沒收到明確值時
  // fallback 回原本的 24 小時（維持向下相容）。
  const effectiveTtl = Number.isFinite(Number(ttlMinutes)) && Number(ttlMinutes) > 0
    ? Math.min(Number(ttlMinutes), RECOVERY_TOKEN_TTL_MINUTES)
    : RECOVERY_TOKEN_TTL_MINUTES;
  const expiresAt = _addMinutes(effectiveTtl);
  const rawRequestedItems = (Array.isArray(cartQtyItems) ? cartQtyItems : [])
    .map(i => ({ product_id: Number(i.product_id), qty: Number(i.qty) }))
    .filter(i => i.product_id && i.qty > 0);
  const cartPayload = JSON.stringify({ items: rawRequestedItems });

  db.run(
    `INSERT INTO line_cart_handoff_tokens
      (token, store_id, status, purpose, cart_code, recovery_cart_id, cart_json, line_user_id, order_id, resume_type, recovery_page_type, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [token, storeId, 'bound', 'recovery_resume', cartCode, cartId, cartPayload, lineUserId, orderId || '', resumeType, pageType, now, expiresAt]
  );
  return { ok: true, token, expiresAt };
}

/**
 * restoreRecoveryToken(db, storeId, fullToken, lineUserId)
 *
 * 驗證：store 相符、purpose=recovery_resume、未過期、未 consumed/cancelled、
 * line_user_id 相符。任一條件不符一律安全拒絕，不猜測、不 fallback。
 */
function restoreRecoveryToken(db, storeId, fullToken, lineUserId, requestPageType) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose=?', [storeId, fullToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') db.run("UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!row.line_user_id || row.line_user_id !== lineUserId) return { ok: false, reason: 'uid_mismatch' };

  const pageType = row.recovery_page_type || '';
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_target' };
  // 需求文件五：request 端可以額外傳「目前實際在哪一頁」，這不是身分依據，
  // 只是讓 backend 能拒絕「shipping token 被拿去 line-order 頁面 restore」
  // 這種情境。requestPageType 是選填的（呼叫端沒傳就跳過這道檢查，交給
  // 呼叫端自行決定要不要驗證）。
  if (requestPageType && RECOVERY_PAGE_TYPES.has(requestPageType) && requestPageType !== pageType) {
    return { ok: false, reason: 'wrong_page' };
  }

  if (row.status === 'bound') {
    db.run("UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=?", [now, row.id]);
  }

  const resumeType = row.resume_type || 'cart';
  if (resumeType === 'payment') {
    // Payment resume 不還原成「購物車」——它綁定的是既有訂單，cart_json 對
    // 這個 resume_type 不具意義（見 utils/cartRecoveryDelivery.js 的
    // resolveRecoveryTarget()：payment stage 從不寫入 cart_json）。
    return { ok: true, cartId: row.recovery_cart_id, resumeType, pageType, orderId: row.order_id || '', expires_at: row.expires_at };
  }

  let cartPayload = {};
  try { cartPayload = JSON.parse(row.cart_json || '{}'); } catch {}
  const recompute = recomputeCart(db, storeId, (cartPayload.items || []).map(i => ({ product_id: i.product_id, qty: i.qty })), null, null);

  return {
    ok: true,
    cartId: row.recovery_cart_id,
    resumeType,
    pageType,
    orderId: row.order_id || '',
    cart: { items: recompute.items, subtotal: recompute.subtotal, discount: recompute.discount, total: Math.max(0, recompute.subtotal - recompute.discount) },
    has_unavailable_items: recompute.has_unavailable_items,
    expires_at: row.expires_at,
  };
}

/**
 * cancelRecoveryToken(db, storeId, fullToken)：需求文件十九——processor 在
 * create token 之後、真正 send 之前的最後一次 recheck 若發現不再 eligible
 * （已購買／已付款／consent 被收回／unfollow），剛建立、還沒使用的 token
 * 必須安全作廢，不留下「已取消 Recovery 但仍可被點開」的有效 token。
 */
function cancelRecoveryToken(db, storeId, fullToken) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose=?', [storeId, fullToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  db.run("UPDATE line_cart_handoff_tokens SET status='cancelled' WHERE id=?", [row.id]);
  return { ok: true };
}

/**
 * invalidateRecoveryResumeTokens(db, storeId, { cartId, orderId })
 *
 * 需求文件十二／十三：成交（purchase／payment_success）之後，已經發出去給
 * 顧客的 Recovery 連結必須立即失效——顧客可能收到提醒、去別處完成訂單，
 * 幾分鐘後才點開舊提醒，這時 restore／resume-payment 都必須安全拒絕，不能
 * 讓舊連結繼續有效。
 *
 * 只作用於 purpose='recovery_resume' 的 row，絕不觸碰 purpose='checkout'
 * 既有 handoff token（那是完全不同的功能）。只轉移「還可能被使用」的狀態
 * （bound/opened/payment_requested/payment_requesting），已經是
 * cancelled/consumed/expired 的不重複處理。
 */
function invalidateRecoveryResumeTokens(db, storeId, { cartId = '', orderId = '' }) {
  if (!cartId && !orderId) return 0;
  const conditions = [];
  const params = [storeId];
  if (cartId) { conditions.push('recovery_cart_id=?'); params.push(cartId); }
  if (orderId) { conditions.push('order_id=?'); params.push(orderId); }
  const result = db.run(
    `UPDATE line_cart_handoff_tokens SET status='cancelled'
     WHERE store_id=? AND purpose='recovery_resume'
       AND status IN ('bound','opened','payment_requested','payment_requesting')
       AND (${conditions.join(' OR ')})`,
    params
  );
  return (result && result.changes) || 0;
}

/**
 * 需求文件二十六：Payment Resume Request 的 atomic claim。同一個
 * recovery_token 被快速點兩次（或兩個分頁同時送出）時，只能有一個 request
 * 真正走到呼叫 LINE Pay API 那一步。用一次 atomic UPDATE...WHERE 搶佔，
 * changes!==1 代表已經有別的 request 搶到了。
 */
function claimPaymentResumeTokenForRequest(db, storeId, fullToken) {
  const result = db.run(
    `UPDATE line_cart_handoff_tokens SET status='payment_requesting'
     WHERE store_id=? AND token=? AND purpose='recovery_resume' AND resume_type='payment'
       AND status IN ('bound','opened')`,
    [storeId, fullToken]
  );
  return !!(result && result.changes === 1);
}

/** LINE Pay Request 成功：標記 payment_requested（不 consume，需求文件二十七
 * ——顧客取消付款後仍可從同一則提醒再次嘗試）。 */
function markPaymentResumeRequested(db, storeId, fullToken) {
  db.run(
    `UPDATE line_cart_handoff_tokens SET status='payment_requested', opened_at=? WHERE store_id=? AND token=? AND purpose='recovery_resume' AND resume_type='payment'`,
    [_nowLocal(), storeId, fullToken]
  );
}

/** LINE Pay Request 失敗：安全退回可重試狀態，不永久鎖死（需求文件二十八）。 */
function releasePaymentResumeClaim(db, storeId, fullToken) {
  db.run(
    `UPDATE line_cart_handoff_tokens SET status='opened' WHERE store_id=? AND token=? AND purpose='recovery_resume' AND resume_type='payment' AND status='payment_requesting'`,
    [storeId, fullToken]
  );
}

/**
 * resetPaymentResumeForRetry(db, storeId, fullToken, lineUserId)
 *
 * 需求文件八：「付款取消後再試」必須是獨立、明確的動作，不能靠放寬 claim
 * 條件（那正是先前 duplicate request 的根源）。只有 token 目前確實是
 * payment_requested（代表已經成功建立過一次 LINE Pay Request，使用者現在
 * 從 LINE Pay 頁面取消回來）才能重置回 opened，讓下一次點擊可以再 claim
 * 一次。呼叫端（routes/cart-recovery.js）負責在呼叫前先確認 order 尚未
 * paid、尚無 payment_success/purchase。
 */
function resetPaymentResumeForRetry(db, storeId, fullToken, lineUserId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose=? AND resume_type=?', [storeId, fullToken, 'recovery_resume', 'payment']);
  if (!row) return { ok: false, reason: 'not_found' };
  if (!row.line_user_id || row.line_user_id !== lineUserId) return { ok: false, reason: 'uid_mismatch' };
  if (row.status !== 'payment_requested') return { ok: false, reason: 'invalid_state' };
  const result = db.run(`UPDATE line_cart_handoff_tokens SET status='opened' WHERE id=? AND status='payment_requested'`, [row.id]);
  if (!(result && result.changes === 1)) return { ok: false, reason: 'invalid_state' };
  return { ok: true, orderId: row.order_id || '' };
}

/**
 * consumeRecoveryToken(db, storeId, fullToken)：訂單成立後消費（與既有
 * consumeCartToken 語意一致，但只作用在 purpose=recovery_resume 的 row，
 * 不影響 checkout token 的 consumeCartToken()）。
 */
function consumeRecoveryToken(db, storeId, fullToken) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose=?', [storeId, fullToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  const now = _nowLocal();
  db.run("UPDATE line_cart_handoff_tokens SET status='consumed', consumed_at=? WHERE id=?", [now, row.id]);
  return { ok: true };
}

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

module.exports = {
  generateFullToken, generateCartCode, maskCartCode, recomputeCart,
  createCartHandoffToken, bindTokenToLineUser, restoreCartToken, consumeCartToken,
  resolveAddFriendUrl,
  // H1.4.10 Phase 4B 新增：Recovery Push 安全連結（沿用同一張表，purpose 區分）
  createRecoveryResumeToken, restoreRecoveryToken, consumeRecoveryToken, cancelRecoveryToken,
  invalidateRecoveryResumeTokens,
  claimPaymentResumeTokenForRequest, markPaymentResumeRequested, releasePaymentResumeClaim,
  resetPaymentResumeForRetry,
  TOKEN_TTL_MINUTES,
};
