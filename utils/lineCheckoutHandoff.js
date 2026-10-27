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
// R44.2F.2：token 狀態轉換（bound→opened、→expired）改走 durable transaction，避免 disk 寫入失敗時
// 「memory 已轉態、disk 沒有」。若已在 durable transaction 內（nested），退回同一個 raw 寫入（由外層統一提交）。
function _tokenStateUpdate(db, sql, params) {
  db.runDurableTransaction(() => { db._db.run(sql, params); });
}

function bindTokenToLineUser(db, storeId, cartCode, lineUserId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND cart_code=?', [storeId, cartCode]);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now) && row.status !== 'expired') {
    _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled' || row.status === 'expired') return { ok: false, reason: row.status };
  // 需求文件九：不可綁定第二個 UID——已綁定過的 token 只認第一個 UID
  if (row.line_user_id && row.line_user_id !== lineUserId) {
    return { ok: false, reason: 'already_bound_other_user' };
  }
  _tokenStateUpdate(db,
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
    if (row.status !== 'expired') _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  if (!row.line_user_id || row.line_user_id !== lineUserId) return { ok: false, reason: 'uid_mismatch' };
  if (!['bound', 'opened'].includes(row.status)) return { ok: false, reason: 'invalid_state' };

  if (row.status === 'bound') {
    _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=?", [now, row.id]);
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
 * R44.2F.1：在呼叫端的 durable transaction 內消費 token（raw db._db.run、不 auto-save）。
 * 合約沿用既有（需求文件十五）：token 不存在／已 consumed → 回 {ok:false,reason}，不阻擋訂單；
 * token 有效 → 必須「剛好」更新 1 列，否則 throw（整筆 order 一起 rollback，token 維持可重試）。
 */
function consumeCartTokenInTransaction(db, storeId, fullToken, orderId) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=?', [storeId, fullToken]);
  if (!row) return { ok: false, reason: 'not_found' };
  if (row.status === 'consumed') return { ok: false, reason: 'already_consumed' };
  db._db.run("UPDATE line_cart_handoff_tokens SET status='consumed', consumed_at=?, order_id=? WHERE id=? AND status<>'consumed'", [_nowLocal(), String(orderId || ''), row.id]);
  const n = db._db.getRowsModified ? db._db.getRowsModified() : 1;
  if (n !== 1) throw new Error('cart token consume affected ' + n + ' rows, expected exactly 1');
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

// H1.4.12 Phase 3B（Popup Recovery Identity Bridge，經核准的第三方案）：
// 'popup_order' 是新增的第三個 page type，跟既有 'line_order'／
// 'line_shipping' 共用完全相同的 token 狀態機、entropy、expiry、one-time
// consume 規則——唯一差異是多一層「popup_session_public_code 必須跟伺服器
// 驗證過的場次相符」的額外綁定（見 createRecoveryResumeToken／
// restoreRecoveryToken 下方的 popup 專屬分支）。identity 仍然必須是
// LINE member_session 反查出的 line_user_id，這裡不新增、也不允許任何
// token-only、visitor_id 或 client-supplied line_user_id 的替代路徑。
const RECOVERY_PAGE_TYPES = new Set(['line_order', 'line_shipping', 'popup_order']);

// popup_order token 建立時，必須拿「當下、伺服器驗證過」的場次 public_code
// 反查出所屬 store，不相信呼叫端傳入的 storeId 跟這個場次真的相符——這裡
// 刻意走跟 GET /popup-session/:code（routes/popup-public.js）完全相同的鏈路
// （先由裸 public_code 反查 store_id，再驗證 store orderable、popup 功能
// 開啟、session/campaign 都不是 draft），不另外發明一套較寬鬆的判斷。
function _resolvePopupSessionForToken(db, storeId, popupSessionPublicCode) {
  if (!popupSessionPublicCode || typeof popupSessionPublicCode !== 'string' || !popupSessionPublicCode.trim()) {
    return { ok: false, reason: 'missing_popup_session' };
  }
  const code = popupSessionPublicCode.trim();
  let popupCheckout, pp;
  try {
    popupCheckout = require('./popupCheckout');
    pp = require('./popupPickup');
  } catch (e) { return { ok: false, reason: 'popup_module_unavailable' }; }
  // 裸 code 反查 store_id（跟 routes/popup-public.js 的
  // resolveStoreIdByPublicCode() 同一條查詢，不信任呼叫端傳入的 storeId）。
  const storeRow = db.get('SELECT store_id FROM popup_sessions WHERE public_code=?', [code]);
  const derivedStoreId = storeRow ? storeRow.store_id : null;
  if (!derivedStoreId) return { ok: false, reason: 'popup_session_not_found' };
  // 呼叫端（建立 token 當下的 storeId，來自已驗證過的 member/store context）
  // 必須跟這個場次真正所屬的 store 一致，否則視為不同店，安全拒絕。
  if (derivedStoreId !== storeId) return { ok: false, reason: 'popup_session_store_mismatch' };
  let authority;
  try { authority = popupCheckout.fetchFreshStoreAuthority(db, derivedStoreId); } catch (e) { authority = null; }
  if (!authority || !authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled) {
    return { ok: false, reason: 'popup_session_not_found' };
  }
  if (!pp.isPopupPickupEnabled(db, derivedStoreId)) return { ok: false, reason: 'popup_session_not_found' };
  const found = popupCheckout.findPublicSessionByCode(db, derivedStoreId, code);
  if (!found || found.session.status === 'draft' || found.campaign.status === 'draft') {
    return { ok: false, reason: 'popup_session_not_found' };
  }
  return { ok: true, session: found.session, campaign: found.campaign, storeId: derivedStoreId };
}

function createRecoveryResumeToken(db, storeId, { cartId, lineUserId, cartQtyItems, orderId = '', resumeType = 'cart', pageType, ttlMinutes, popupSessionPublicCode }) {
  if (!storeId || !lineUserId) return { ok: false, reason: 'missing_required_fields' };
  // 需求文件三：token 必須知道自己原本屬於哪一頁，否則同一個 token 被貼到
  // 錯的 LIFF/頁面時 backend 無從拒絕。沒有合法 pageType 一律安全拒絕，不猜測。
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_page_type' };
  let resolvedPopupSessionCode = null;
  if (pageType === 'popup_order') {
    // popup 場次沒有一般 cart_recovery_jobs 的 cartId 概念，改由伺服器驗證過
    // 的場次 public_code 當綁定鍵；cartId 對這個 page type 沒有意義，不強制。
    const popupResolve = _resolvePopupSessionForToken(db, storeId, popupSessionPublicCode);
    if (!popupResolve.ok) return popupResolve;
    resolvedPopupSessionCode = popupResolve.session.public_code;
  } else if (!cartId) {
    return { ok: false, reason: 'missing_required_fields' };
  }
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

  // RC2 修正（規格二.3）：popup_order 建立時必須嚴格拒絕空 cart 及非安全
  // 整數，不得沿用標準 line_order/line_shipping 那種「先用 Number() 寬鬆
  // 轉型、篩選掉不合法的之後再悄悄產生空快照」的既有行為——那樣等於用
  // 「建立成功、但其實內容已經被默默清空」的 token 製造出跟
  // valid_empty_after_reconcile 難以區分的假象。標準 line_order/
  // line_shipping 的既有空 items 契約（允許建立、上面那段寬鬆 filter）
  // 完全不變，這裡只針對 pageType==='popup_order' 額外加一層。
  if (pageType === 'popup_order') {
    const rawInputItems = Array.isArray(cartQtyItems) ? cartQtyItems : [];
    if (rawInputItems.length === 0) return { ok: false, reason: 'empty_cart' };
    for (const it of rawInputItems) {
      const pid = it && it.product_id;
      const qty = it && it.qty;
      if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) return { ok: false, reason: 'invalid_cart_item' };
      if (typeof qty !== 'number' || !Number.isSafeInteger(qty) || qty <= 0) return { ok: false, reason: 'invalid_cart_item' };
    }
    if (rawRequestedItems.length === 0) return { ok: false, reason: 'empty_cart' };
  }

  const cartPayload = JSON.stringify({ items: rawRequestedItems });

  db.run(
    `INSERT INTO line_cart_handoff_tokens
      (token, store_id, status, purpose, cart_code, recovery_cart_id, cart_json, line_user_id, order_id, resume_type, recovery_page_type, popup_session_public_code, created_at, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [token, storeId, 'bound', 'recovery_resume', cartCode, cartId || '', cartPayload, lineUserId, orderId || '', resumeType, pageType, resolvedPopupSessionCode, now, expiresAt]
  );
  return { ok: true, token, expiresAt };
}

/**
 * restoreRecoveryToken(db, storeId, fullToken, lineUserId)
 *
 * 驗證：store 相符、purpose=recovery_resume、未過期、未 consumed/cancelled、
 * line_user_id 相符。任一條件不符一律安全拒絕，不猜測、不 fallback。
 */
function restoreRecoveryToken(db, storeId, fullToken, lineUserId, requestPageType, requestPopupSessionPublicCode) {
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose=?', [storeId, fullToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  const now = _nowLocal();
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  // 身分模型完全不變：popup_order token 仍然必須是「LINE member_session 反查
  // 出的 line_user_id」跟建立當下綁定的 line_user_id 相符，這裡沒有、也不會
  // 新增任何 token-only、visitor_id 或 client-supplied line_user_id 的替代
  // 驗證路徑（經核准的第三方案：身分模型不變，只多一層 popup session 綁定）。
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

  // ══════════════════════════════════════════════════════════════════
  // H1.4.12 Phase 3B（Popup Recovery Identity Bridge，經核准的第三方案）：
  // popup_order token 除了上面完全沿用既有身分驗證，還必須額外通過場次層級
  // 的綁定檢查：
  //   1. 呼叫端必須明確帶目前 URL 的 session public_code（requestPopupSessionPublicCode），
  //      沒帶一律安全拒絕——不得省略這個參數就通過（防止「拿 popup token 卻
  //      不驗證目前頁面到底是哪個 session」）。
  //   2. 必須跟 token 建立當下、已經驗證過的 popup_session_public_code 完全
  //      相符（session A 的 token 不能在 session B 使用；也不能只換掉 URL
  //      裡的 session code 就把同一個 token 挪去別的場次）。
  //   3. 用「當下 fresh」重新反查一次這個場次（不是只信任建立當下存的字
  //      串）——場次如果被下架/改成 draft/所屬 campaign 下架，一律安全拒絕，
  //      不會用一個「曾經有效」但現在其實不該再被使用的場次代碼繼續往下走。
  // 這裡刻意「不」做完整購物車還原（recomputeCart 對商品/quota/付款方式的
  // 完整 reconcile）——本輪範圍明確只到「身分 + 場次目標」驗證通過為止，
  // 完整 cart restore 留到下一輪，避免在同一個函式裡混雜兩種不同信任層級
  // 的邏輯，難以個別稽核。
  // ══════════════════════════════════════════════════════════════════
  if (pageType === 'popup_order') {
    if (row.status === 'bound') _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=?", [now, row.id]);
    if (!requestPopupSessionPublicCode || typeof requestPopupSessionPublicCode !== 'string' || !requestPopupSessionPublicCode.trim()) {
      return { ok: false, reason: 'missing_popup_session' };
    }
    const urlSessionCode = requestPopupSessionPublicCode.trim();
    if (!row.popup_session_public_code || row.popup_session_public_code !== urlSessionCode) {
      return { ok: false, reason: 'popup_session_mismatch' };
    }
    const fresh = _resolvePopupSessionForToken(db, storeId, urlSessionCode);
    if (!fresh.ok) return fresh;
    return {
      ok: true,
      resumeType: 'popup',
      pageType,
      popupSessionPublicCode: fresh.session.public_code,
      cart_restore_deferred: true, // 本輪明確範圍：只驗證到「目標場次可信」，完整購物車 reconcile 留到下一輪
      expires_at: row.expires_at,
    };
  }

  if (row.status === 'bound') {
    _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=?", [now, row.id]);
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

// H1.4.12 Phase 3B（Corrective Completion）：把 pageType 換算成「使用者最終
// 應該落地的 same-origin path」，只回傳寫死在這個 allowlist 裡的路徑，絕不
// 用 pageType/使用者輸入直接拼出任意網址——避免 open redirect。popup_order
// 需要 popupSessionPublicCode 才能組出完整路徑；其餘 pageType 沿用既有固定
// 頁面。（原本放在 utils/cartRecoveryDelivery.js，這裡搬過來是為了讓下面的
// resolveRecoveryTargetForVerifiedMember() 可以直接呼叫，不必讓這個檔案反過
// 來 require cartRecoveryDelivery.js 造成循環依賴——那個檔案本來就已經在
// require 這個檔案。）
const RECOVERY_TARGET_PATH_ALLOWLIST = {
  line_order: () => '/line-order.html',
  line_shipping: () => '/line-shipping.html',
  popup_order: (popupSessionPublicCode) => `/popup-order?session=${encodeURIComponent(popupSessionPublicCode)}`,
};
function resolveRecoveryTargetPath(pageType, popupSessionPublicCode) {
  const builder = RECOVERY_TARGET_PATH_ALLOWLIST[pageType];
  if (!builder) return { ok: false, reason: 'invalid_target' };
  if (pageType === 'popup_order') {
    if (!popupSessionPublicCode || typeof popupSessionPublicCode !== 'string' || !popupSessionPublicCode.trim()) {
      return { ok: false, reason: 'missing_popup_session' };
    }
    return { ok: true, path: builder(popupSessionPublicCode.trim()) };
  }
  return { ok: true, path: builder() };
}

// ══════════════════════════════════════════════════════════════════════
// H1.4.12 Phase 3B（Popup Recovery Identity Bridge — Corrective Completion）
//
// resolveRecoveryTargetForVerifiedMember(db, recoveryToken, memberSession)
//
// 這是「identity landing」唯一應該呼叫的函式：只認 token + member_session，
// 完全不接受、也不使用呼叫端傳入的 store_id／page_type／popup session
// code／target path／line_user_id／entry_context——這些全部從 token row
// 本身（建立當下已經伺服器驗證過）或 fresh 重新查詢反查出來。
//
// 只做「prepare／resolve target」該做的事：驗證身分、驗證 token 狀態、
// 算出安全 target，必要時把 bound 轉成 opened（冪等、條件 UPDATE，不覆寫
// 已經是 consumed/cancelled 的狀態）。絕不：
//   - 回傳購物車內容（cart_json／price／subtotal／total 一律不出現在回傳值）
//   - 把狀態轉成 consumed（那是下一階段「真正完成 restore」才做的事，
//     這裡完全不觸碰 consumed_at）
//   - 洩漏 line_user_id、內部 store/license/gateway 資料或 token row 原始內容
//
// 回傳值只有 { ok, reason? , pageType?, targetPath?, popupSessionPublicCode? }。
// ══════════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════════
// H1.4.12 Phase 3B（Popup Recovery LIFF Member Bootstrap — Corrective
// Increment，經核准的信任模型）
//
// bootstrapMemberSessionFromRecoveryToken(db, recoveryToken, lineIdToken)
//
// 這是 landing 拿到「已登入但還沒有 member_session」的 LINE ID Token 之後，
// 唯一應該呼叫的函式：只用 recovery_token 定位 token row/store/page type，
// 用 LINE 官方 verify primitive（utils/lineMemberAuth.js 的
// verifyLineIdToken()，跟一般會員登入 /api/line-member/verify 用的是同一個
// 函式，不重新發明一套驗證邏輯）證明 LINE 使用者身分，再用既有
// createMemberSession() 簽發跟一般流程完全同格式的 store-bound
// member_session。
//
// 絕對不做：
//   - 不接受、也不使用任何呼叫端傳入的 store_id/line_user_id/page_type/
//     session code/target path。
//   - 不把 token 轉成 opened／consumed（那是 resolveRecoveryTargetForVerifiedMember()
//     的責任，這裡完全不寫入 status/opened_at/consumed_at）。
//   - 不回傳 store_id、line_user_id、channel secret、decoded claims、
//     profile、token row 原始內容。
//   - 不接受 client 自稱、未經驗證的 decoded JWT claims。
//
// 回傳值只有 { ok, reason? , memberSession? }。
// ══════════════════════════════════════════════════════════════════════
async function bootstrapMemberSessionFromRecoveryToken(db, recoveryToken, lineIdToken) {
  if (!recoveryToken || typeof recoveryToken !== 'string') return { ok: false, reason: 'missing_token' };
  if (!lineIdToken || typeof lineIdToken !== 'string') return { ok: false, reason: 'missing_credential' };

  // 1. 只依 token 查 row，store 完全由 row 推導——跟
  //    resolveRecoveryTargetForVerifiedMember() 同一條規則，不信任任何
  //    呼叫端傳入的 store_id。
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=? AND purpose=?', [recoveryToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };
  const derivedStoreId = row.store_id;

  const now = _nowLocal();
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  // bootstrap 本身完全不轉移狀態——bound 或 opened（例如之前已經成功
  // bootstrap+resolve 過，但 navigation 失敗，使用者重試）都可以再次
  // bootstrap，不因為已經是 opened 就拒絕（規格四：bootstrap 重試不得
  // consume token，也不得因為已經 opened 過就卡住合法重試）。
  if (row.status !== 'bound' && row.status !== 'opened') return { ok: false, reason: 'invalid_status' };

  const pageType = row.recovery_page_type || '';
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_target' };

  // 5/6. fresh 驗證 store 本身仍然 orderable（active/license/line_order）。
  let popupCheckout;
  try { popupCheckout = require('./popupCheckout'); } catch (e) { return { ok: false, reason: 'exception' }; }
  let authority;
  try { authority = popupCheckout.fetchFreshStoreAuthority(db, derivedStoreId); } catch (e) { authority = null; }
  if (!authority || !authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled) {
    return { ok: false, reason: 'not_found' }; // 不可枚舉：跟 token 不存在同一種對外回應
  }

  // 7. popup_order 還要 fresh 驗證綁定的場次/活動沒有被下架/改成 draft。
  if (pageType === 'popup_order') {
    const fresh = _resolvePopupSessionForToken(db, derivedStoreId, row.popup_session_public_code);
    if (!fresh.ok) return { ok: false, reason: 'not_found' };
  }

  // 8. 依 derived store 的 LINE channel configuration，在後端驗證 LINE
  //    credential——跟一般會員登入 /api/line-member/verify 用的是同一個
  //    setting key、同一個驗證函式，不建立第二套較寬鬆的驗證路徑。
  const channelId = db.get("SELECT value FROM settings WHERE store_id=? AND key='line_member_login_channel_id'", [derivedStoreId]);
  const channelIdValue = channelId ? channelId.value : '';
  if (!channelIdValue) return { ok: false, reason: 'not_configured' };

  let verifyLineIdToken;
  try { ({ verifyLineIdToken } = require('./lineMemberAuth')); } catch (e) { return { ok: false, reason: 'exception' }; }
  const verifyResult = await verifyLineIdToken(lineIdToken, channelIdValue);
  if (!verifyResult.ok || !verifyResult.line_user_id) {
    // 不可枚舉：aud_mismatch／expired／no_sub／verify_failed 全部同一個對外
    // reason，細節只寫進 server log（呼叫端自行決定要不要記，這裡不強制
    // log，避免記錄到 raw id token）。
    return { ok: false, reason: 'invalid_credential' };
  }

  // 9. 用既有格式簽發 store-bound member_session——跟一般會員登入完全
  //    同一個函式、同一種簽章/TTL 規則，不改弱、也不新增第二套格式。
  let createMemberSession;
  try { ({ createMemberSession } = require('./lineMemberSession')); } catch (e) { return { ok: false, reason: 'exception' }; }
  const memberSession = createMemberSession({ store_id: derivedStoreId, line_user_id: verifyResult.line_user_id });
  if (!memberSession) return { ok: false, reason: 'exception' };

  return { ok: true, memberSession };
}

// H1.4.12 Phase 3B：popup landing 在呼叫 liff.init() 前，需要知道「這個
// recovery_token 所屬 store」設定的 popup 專用 LIFF ID——但 landing 本身
// 不knowledge store_id，所以一樣只能由 token 反查。這裡刻意「要求」
// line_popup_liff_id 必須明確設定，不 fallback 到 line_member_liff_id：
// 一般會員 LIFF 的 LINE Console Endpoint URL 未必允許導向 /popup-order，
// 假設兩者相容是不安全的猜測（見本輪 Reality Audit 回報）。缺少設定時
// fail closed，回報需要人工在 LINE Developers Console 設定/確認，不自行
// 假設相容、也不 fallback 成一般網頁 URL。
// RC2 修正（規格三）：liff-config 必須對這個 token 做一次完整的 fresh
// authority 重新驗證，不能只檢查 token 本身的狀態機——場次/活動可能在
// token 建立之後才被下架、store 可能被停權、popup 功能可能被關掉。只接受
// pageType==='popup_order'（liff-config 本來就是 popup landing 專用，其他
// page type 不需要、也不該回傳任何 LIFF ID）。disabled/draft/nonexistent/
// missing-setting 全部收斂成同一個不可區分的 reason，不洩漏究竟是哪一種
// 原因造成失敗。
function resolveLiffIdForRecoveryToken(db, recoveryToken) {
  const GENERIC_FAIL = { ok: false, reason: 'liff_config_unavailable' };
  if (!recoveryToken || typeof recoveryToken !== 'string') return GENERIC_FAIL;
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=? AND purpose=?', [recoveryToken, 'recovery_resume']);
  if (!row) return GENERIC_FAIL;
  const now = _nowLocal();
  if (_isExpired(row, now)) return GENERIC_FAIL;
  if (row.status === 'consumed' || row.status === 'cancelled') return GENERIC_FAIL;
  const pageType = row.recovery_page_type || '';
  if (pageType !== 'popup_order') return GENERIC_FAIL;

  // Fresh 驗證：store/license/line_order/popup_pickup_enabled/session與
  // campaign 非 draft，全部沿用跟其他 popup 公開端點同一份 SSOT
  // （_resolvePopupSessionForToken()，內部會呼叫
  // popupCheckout.fetchFreshStoreAuthority() 與 pp.isPopupPickupEnabled()），
  // 不另外寫一套較寬鬆的檢查。
  const fresh = _resolvePopupSessionForToken(db, row.store_id, row.popup_session_public_code);
  if (!fresh.ok) return GENERIC_FAIL;

  const liffRow = db.get("SELECT value FROM settings WHERE store_id=? AND key='line_popup_liff_id'", [row.store_id]);
  const liffId = liffRow ? liffRow.value : '';
  if (!liffId) return GENERIC_FAIL;
  return { ok: true, liffId };
}

function resolveRecoveryTargetForVerifiedMember(db, recoveryToken, memberSession) {
  if (!recoveryToken || typeof recoveryToken !== 'string') return { ok: false, reason: 'missing_token' };
  if (!memberSession || typeof memberSession !== 'string') return { ok: false, reason: 'member_not_identified' };

  // 1. 只依 token 查 row——這一步完全不需要、也不接受任何呼叫端傳入的
  //    store_id。row 不存在就是不存在，不區分「store 不符」還是「token 不
  //    存在」，回傳同一個不可枚舉的 reason。
  const row = db.get('SELECT * FROM line_cart_handoff_tokens WHERE token=? AND purpose=?', [recoveryToken, 'recovery_resume']);
  if (!row) return { ok: false, reason: 'not_found' };

  // 2. store 完全由 row 推導（token 建立當下已經驗證過的值），不是猜的、
  //    也不是呼叫端說了算。
  const derivedStoreId = row.store_id;

  // 3. 用 derived store 驗證 member session，取得 backend verified 的
  //    line_user_id——這是唯一的身分來源，不接受 client 自稱的 line_user_id。
  let verifyMemberSession;
  try { ({ verifyMemberSession } = require('./lineMemberSession')); } catch (e) { return { ok: false, reason: 'exception' }; }
  const verifiedLineUserId = verifyMemberSession(memberSession, derivedStoreId);
  if (!verifiedLineUserId) return { ok: false, reason: 'member_not_identified' };

  const now = _nowLocal();
  // 4. expiry／狀態機檢查（跟 restoreRecoveryToken 用同一套規則，不重複
  //    發明）。過期時允許把 status 轉成 'expired'（這是既有的終態標記行為，
  //    不是「消費」token 的意思，本身也不會設定 consumed_at）。
  if (_isExpired(row, now)) {
    if (row.status !== 'expired') _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='expired' WHERE id=?", [row.id]);
    return { ok: false, reason: 'expired' };
  }
  if (row.status === 'consumed') return { ok: false, reason: 'consumed' };
  if (row.status === 'cancelled') return { ok: false, reason: 'cancelled' };

  // 5. 身分比對——錯誤的使用者「不得」改變 token 狀態（不轉 opened、不做
  //    任何 UPDATE），避免攻擊者拿別人的 token 亂猜、亂試就能觸發狀態轉移
  //    或造成合法使用者之後被判定成「已經 opened 過了」之類的旁側效應。
  if (!row.line_user_id || row.line_user_id !== verifiedLineUserId) return { ok: false, reason: 'uid_mismatch' };

  // 6. page type 完全由 row 推導（建立當下已經驗證過的值）。
  const pageType = row.recovery_page_type || '';
  if (!RECOVERY_PAGE_TYPES.has(pageType)) return { ok: false, reason: 'invalid_target' };

  // 7/8/9. popup_order 的場次 code 同樣完全由 row 推導，並且 fresh 重新驗證
  //    一次（場次可能在 token 建立後被下架/改成 draft/campaign 下架）。
  let popupSessionPublicCode = null;
  if (pageType === 'popup_order') {
    popupSessionPublicCode = row.popup_session_public_code;
    const fresh = _resolvePopupSessionForToken(db, derivedStoreId, popupSessionPublicCode);
    if (!fresh.ok) return fresh;
    popupSessionPublicCode = fresh.session.public_code;
  }

  // 10. 用同一個 same-origin allowlist 產生 target，不自己拼字串。
  const targetResult = resolveRecoveryTargetPath(pageType, popupSessionPublicCode);
  if (!targetResult.ok) return targetResult;

  // bound → opened：條件 UPDATE（WHERE status='bound'），避免競態覆寫掉
  // 這期間可能已經被別的 request 轉成 consumed/cancelled 的狀態；同一個
  // verified user 對已經是 opened 的 token 重複呼叫這裡，本來就會直接跳過
  // 這個 UPDATE（WHERE 條件不成立，0 rows affected），達成冪等，不會因為
  // 「已經 opened 過」而被擋下或報錯。
  _tokenStateUpdate(db, "UPDATE line_cart_handoff_tokens SET status='opened', opened_at=? WHERE id=? AND status='bound'", [now, row.id]);

  return {
    ok: true,
    pageType,
    targetPath: targetResult.path,
    ...(pageType === 'popup_order' ? { popupSessionPublicCode } : {}),
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
  createCartHandoffToken, bindTokenToLineUser, restoreCartToken, consumeCartToken, consumeCartTokenInTransaction,
  resolveAddFriendUrl,
  // H1.4.10 Phase 4B 新增：Recovery Push 安全連結（沿用同一張表，purpose 區分）
  createRecoveryResumeToken, restoreRecoveryToken, consumeRecoveryToken, cancelRecoveryToken,
  invalidateRecoveryResumeTokens,
  claimPaymentResumeTokenForRequest, markPaymentResumeRequested, releasePaymentResumeClaim,
  resetPaymentResumeForRetry,
  TOKEN_TTL_MINUTES,
  RECOVERY_PAGE_TYPES,
  resolveRecoveryTargetPath,
  resolveRecoveryTargetForVerifiedMember,
  bootstrapMemberSessionFromRecoveryToken,
  resolveLiffIdForRecoveryToken,
  _nowLocal,
  _addMinutes,
  _isExpired,
};
