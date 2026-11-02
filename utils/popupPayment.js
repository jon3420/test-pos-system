// utils/popupPayment.js — R50
//
// 🚐 快閃取餐「獨立付款方式管理」與線上付款生命週期的單一事實來源。
//
// 設計重點（R50 Reality Audit 結論）：
//   - 快閃是獨立通路：付款規則存在 settings key `popup_payment_settings`（全店快閃
//     預設）與 `popup_payment_campaign_overrides`（活動層級 inherit/custom）。這兩個
//     key 不在 routes/settings.js 的 ALL_ALLOWED 內，一般設定儲存無法覆寫；快閃設定
//     也完全不寫一般外帶／外送／宅配／POS 的任何設定。
//   - 未曾儲存過快閃付款設定的店家（含所有舊資料）維持 R48/R49 既有行為（legacy：
//     沿用 utils/popupCheckout.js 的 LINE 外帶付款判斷），不改變任何既有現金訂單語意。
//     一旦店家在「💳 付款方式管理」儲存，快閃付款即完全依快閃自己的設定，不再讀取
//     一般 LINE 外帶付款設定，也不依賴 LINE 點餐營業總開關（line_order_enabled）
//     或 currentMode。
//   - 金流 provider 一律沿用既有 adapter：LINE Pay 的 credential 只從既有
//     payment_gateways（utils/linePayClient.getLinePayConfig）讀取；Request 沿用
//     utils/linePayService.requestLinePayPayment；Confirm 沿用 linePayClient 的
//     signLinePayPost/makePostHeaders。不新增任何 secret 欄位、不回傳任何 secret。
//   - 信用卡目前系統沒有任何線上刷卡 adapter，因此永遠是「尚未完成金流設定」。
//   - 付款狀態沿用既有 canonical 欄位：orders.payment_status（pending/paid/failed/
//     cancelled）、orders.refund_status（pending_refund/refunded）；
//     popup_payment_attempts.status 是 provider 交易帳本（pending/paid/failed/
//     expired/cancelled），用於冪等與逾時，不是第二套訂單狀態。對外的 R50 狀態
//     （pending_payment/paid/payment_failed/payment_expired/cancelled/
//     refund_pending/refunded）由 derivePopupPaymentState() 從兩者推導。
'use strict';

const crypto = require('crypto');

const SETTINGS_KEY = 'popup_payment_settings';
const OVERRIDES_KEY = 'popup_payment_campaign_overrides';
const METHOD_CODES = ['cash', 'linepay', 'transfer', 'credit_card', 'platform'];
const ONLINE_CODES = new Set(['linepay', 'credit_card']);
const METHOD_LABELS = { cash: '現金', linepay: 'LINE Pay', transfer: '轉帳', credit_card: '信用卡', platform: '平台付款' };
const TIMEOUT_MIN = 5;
const TIMEOUT_MAX = 60;
const DESC_MAX = 200;

class PopupPaymentError extends Error {
  constructor(code, message, status, extra) { super(message); this.code = code; this.status = status || 400; this.extra = extra; }
}
const pfail = (code, message, status, extra) => { throw new PopupPaymentError(code, message, status, extra); };

// ── schema（idempotent；只在快閃付款路徑上呼叫，舊 DB 啟動不受影響）─────────
const _schemaReady = new WeakSet();
function ensurePopupPaymentSchema(db) {
  const raw = db._db;
  if (_schemaReady.has(raw)) return;
  raw.run(`CREATE TABLE IF NOT EXISTS popup_payment_attempts (
    attempt_id TEXT PRIMARY KEY,
    store_id TEXT NOT NULL,
    order_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    amount INTEGER NOT NULL,
    currency TEXT NOT NULL DEFAULT 'TWD',
    status TEXT NOT NULL DEFAULT 'pending',
    transaction_id TEXT DEFAULT '',
    fail_reason TEXT DEFAULT '',
    expires_at INTEGER NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_popup_pay_attempt_token ON popup_payment_attempts(token_hash)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_popup_pay_attempt_store_status ON popup_payment_attempts(store_id, status, expires_at)');
  raw.run(`CREATE TABLE IF NOT EXISTS popup_checkout_requests (
    store_id TEXT NOT NULL,
    idem_key TEXT NOT NULL,
    order_id TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    PRIMARY KEY (store_id, idem_key)
  )`);
  _schemaReady.add(raw);
}
function _hasTable(db, name) {
  return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
}

// ── settings ───────────────────────────────────────────────────────────
function _getSetting(db, storeId, key) {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : null;
}
function isPopupPaymentConfigured(db, storeId) {
  const v = _getSetting(db, storeId, SETTINGS_KEY);
  if (!v) return false;
  try { const o = JSON.parse(v); return !!o && o.version === 1; } catch (e) { return false; }
}
function defaultPopupPaymentSettings() {
  const methods = {};
  METHOD_CODES.forEach((c) => { methods[c] = { enabled: c === 'cash', description: '' }; });
  return { version: 1, methods, customer_choice: true, online_only: false, default_method: 'cash', timeout_minutes: 15, allow_fallback_cash: false, expire_cancel_release: true };
}
function loadPopupPaymentSettings(db, storeId) {
  const v = _getSetting(db, storeId, SETTINGS_KEY);
  if (!v) return null;
  try {
    const o = JSON.parse(v);
    if (!o || o.version !== 1) return null;
    return o;
  } catch (e) { return null; }
}
function loadCampaignOverrides(db, storeId) {
  const v = _getSetting(db, storeId, OVERRIDES_KEY);
  if (!v) return {};
  try { const o = JSON.parse(v); return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {}; } catch (e) { return {}; }
}

// ── provider readiness（server 判斷；不回傳任何 credential）───────────────
function providerReadiness(db, storeId, code, settings) {
  const desc = settings && settings.methods && settings.methods[code] ? String(settings.methods[code].description || '').trim() : '';
  if (code === 'cash') return { ready: true, reason: null };
  if (code === 'linepay') {
    const { getLinePayConfig } = require('./linePayClient');
    const cfg = getLinePayConfig(db, storeId, true);
    if (!_cbKey()) return { ready: false, reason: '伺服器尚未設定 JWT_SECRET，無法簽署付款回呼' };
    if (cfg && cfg.channelId && cfg.channelSecret) return { ready: true, reason: null, mode: cfg.mode === 'live' || cfg.mode === 'prod' ? 'live' : 'test' };
    return { ready: false, reason: 'LINE Pay 尚未在「金流設定」啟用，或缺少 Channel 設定' };
  }
  if (code === 'credit_card') return { ready: false, reason: '目前系統尚未串接線上信用卡金流' };
  if (code === 'transfer') return desc ? { ready: true, reason: null } : { ready: false, reason: '請先填寫顧客看到的轉帳說明（帳號等）' };
  if (code === 'platform') return desc ? { ready: true, reason: null } : { ready: false, reason: '請先填寫顧客看到的平台付款說明' };
  return { ready: false, reason: '不支援的付款方式' };
}

function describeMethods(db, storeId, settings) {
  const s = settings || defaultPopupPaymentSettings();
  return METHOD_CODES.map((code) => {
    const r = providerReadiness(db, storeId, code, s);
    const m = s.methods[code] || { enabled: false, description: '' };
    return { code, label: METHOD_LABELS[code], online: ONLINE_CODES.has(code), enabled: !!m.enabled, description: String(m.description || ''), ready: r.ready, reason: r.reason };
  });
}

function _isBool(v) { return v === true || v === false; }
function validateAndNormalizeSettings(db, storeId, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '付款設定格式錯誤');
  const out = { version: 1, methods: {} };
  const m = input.methods;
  if (!m || typeof m !== 'object' || Array.isArray(m)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', 'methods 格式錯誤');
  Object.keys(m).forEach((k) => { if (!METHOD_CODES.includes(k)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', `不支援的付款方式：${String(k).slice(0, 30)}`); });
  METHOD_CODES.forEach((c) => {
    const it = m[c] || { enabled: false, description: '' };
    if (!_isBool(it.enabled)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', `${METHOD_LABELS[c]} 的啟用狀態必須是布林值`);
    if (it.description !== undefined && typeof it.description !== 'string') pfail('POPUP_PAYMENT_SETTINGS_INVALID', '說明必須是文字');
    const d = String(it.description || '').trim();
    if (d.length > DESC_MAX) pfail('POPUP_PAYMENT_SETTINGS_INVALID', `說明不得超過 ${DESC_MAX} 字`);
    out.methods[c] = { enabled: it.enabled, description: d };
  });
  ['customer_choice', 'online_only', 'allow_fallback_cash', 'expire_cancel_release'].forEach((k) => {
    if (!_isBool(input[k])) pfail('POPUP_PAYMENT_SETTINGS_INVALID', `${k} 必須是布林值`);
    out[k] = input[k];
  });
  const t = input.timeout_minutes;
  if (!Number.isInteger(t) || t < TIMEOUT_MIN || t > TIMEOUT_MAX) pfail('POPUP_PAYMENT_SETTINGS_INVALID', `線上付款逾時分鐘數必須是 ${TIMEOUT_MIN}～${TIMEOUT_MAX} 的整數`);
  out.timeout_minutes = t;
  if (!METHOD_CODES.includes(input.default_method)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '預設付款方式不正確');
  out.default_method = input.default_method;
  const usable = METHOD_CODES.filter((c) => out.methods[c].enabled && providerReadiness(db, storeId, c, out).ready && (!out.online_only || ONLINE_CODES.has(c)));
  const notReadyEnabled = METHOD_CODES.filter((c) => out.methods[c].enabled && !providerReadiness(db, storeId, c, out).ready);
  if (notReadyEnabled.length) pfail('POPUP_PAYMENT_METHOD_NOT_READY', `以下付款方式尚未完成設定，不能啟用：${notReadyEnabled.map((c) => METHOD_LABELS[c]).join('、')}`, 409, { methods: notReadyEnabled });
  if (usable.length === 0) pfail('POPUP_PAYMENT_NO_USABLE_METHOD', out.online_only ? '「僅限線上付款」時至少需要一種已啟用且可用的線上付款方式' : '至少需要一種已啟用且可用的付款方式', 409);
  if (!usable.includes(out.default_method)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '預設付款方式必須是已啟用且可用的付款方式', 409);
  if (out.allow_fallback_cash && !(out.methods.cash.enabled && !out.online_only)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '允許付款失敗改現金時，必須啟用現金且不可設為僅限線上付款', 409);
  return out;
}

function savePopupPaymentSettings(db, storeId, input, actor) {
  const norm = validateAndNormalizeSettings(db, storeId, input);
  norm.updated_at = new Date().toISOString();
  norm.updated_by = typeof actor === 'string' ? actor.slice(0, 60) : '';
  db.runDurableTransaction(() => {
    ensurePopupPaymentSchema(db);
    db._db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, SETTINGS_KEY, JSON.stringify(norm)]);
  });
  return norm;
}

// ── 活動 inherit / custom ──────────────────────────────────────────────
function getCampaignOverride(db, storeId, campaignId) {
  const o = loadCampaignOverrides(db, storeId)[campaignId];
  if (o && o.mode === 'custom' && Array.isArray(o.methods)) return { mode: 'custom', methods: o.methods.filter((c) => METHOD_CODES.includes(c)) };
  return { mode: 'inherit', methods: [] };
}
function saveCampaignOverride(db, storeId, campaignId, input) {
  if (!input || typeof input !== 'object') pfail('POPUP_PAYMENT_SETTINGS_INVALID', '活動付款設定格式錯誤');
  if (input.mode !== 'inherit' && input.mode !== 'custom') pfail('POPUP_PAYMENT_SETTINGS_INVALID', 'mode 必須是 inherit 或 custom');
  const all = loadCampaignOverrides(db, storeId);
  if (input.mode === 'inherit') {
    delete all[campaignId];
  } else {
    const s = loadPopupPaymentSettings(db, storeId);
    if (!s) pfail('POPUP_PAYMENT_NOT_CONFIGURED', '請先在「💳 付款方式管理」儲存快閃全店預設，才能自訂活動付款方式', 409);
    if (!Array.isArray(input.methods) || input.methods.length === 0) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '自訂付款方式至少需選一種');
    const base = storeUsableMethods(db, storeId, s);
    const uniq = [];
    input.methods.forEach((c) => {
      if (typeof c !== 'string' || !METHOD_CODES.includes(c)) pfail('POPUP_PAYMENT_SETTINGS_INVALID', '不支援的付款方式');
      if (!base.includes(c)) pfail('POPUP_PAYMENT_METHOD_NOT_ALLOWED', `「${METHOD_LABELS[c]}」不是快閃預設中已啟用且可用的付款方式`, 409);
      if (!uniq.includes(c)) uniq.push(c);
    });
    all[campaignId] = { mode: 'custom', methods: uniq, updated_at: new Date().toISOString() };
  }
  db.runDurableTransaction(() => {
    db._db.run('INSERT OR REPLACE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, OVERRIDES_KEY, JSON.stringify(all)]);
  });
  return getCampaignOverride(db, storeId, campaignId);
}

function storeUsableMethods(db, storeId, settings) {
  const s = settings || loadPopupPaymentSettings(db, storeId);
  if (!s) return [];
  return METHOD_CODES.filter((c) => s.methods[c] && s.methods[c].enabled && providerReadiness(db, storeId, c, s).ready && (!s.online_only || ONLINE_CODES.has(c)));
}

// 活動實際可用付款方式（server-authoritative；顧客端與結帳共用同一份規則）。
function effectiveCampaignMethods(db, storeId, campaignId) {
  const s = loadPopupPaymentSettings(db, storeId);
  if (!s) return null; // legacy：未設定快閃付款
  let list = storeUsableMethods(db, storeId, s);
  const ov = getCampaignOverride(db, storeId, campaignId);
  if (ov.mode === 'custom') list = list.filter((c) => ov.methods.includes(c));
  if (!s.customer_choice && list.length) list = list.includes(s.default_method) ? [s.default_method] : [list[0]];
  return list;
}

function publicPaymentInfo(db, storeId, campaignId) {
  const s = loadPopupPaymentSettings(db, storeId);
  if (!s) return null;
  const list = effectiveCampaignMethods(db, storeId, campaignId);
  return {
    configured: true,
    accepting: list.length > 0,
    methods: list.map((c) => ({ code: c, label: METHOD_LABELS[c], online: ONLINE_CODES.has(c), description: s.methods[c].description || '' })),
    default_method: list.includes(s.default_method) ? s.default_method : (list[0] || null),
    online_only: !!s.online_only,
    timeout_minutes: s.timeout_minutes,
  };
}

// ── 結帳：快閃付款方式權威判斷（供 validatePopupCheckoutAuthority 的 resolver 用）──
function makeCheckoutPaymentResolver(db, storeId) {
  return (paymentMethodCode, { campaign }) => {
    const list = effectiveCampaignMethods(db, storeId, campaign.id) || [];
    if (list.length === 0) pfail('POPUP_PAYMENT_NO_USABLE_METHOD', '此快閃活動目前沒有可用的付款方式，暫停接單', 409);
    const s = loadPopupPaymentSettings(db, storeId);
    const code = paymentMethodCode === undefined ? (list.includes(s.default_method) ? s.default_method : list[0]) : paymentMethodCode;
    if (typeof code !== 'string' || !code.trim()) pfail('POPUP_VALIDATION_ERROR', 'payment_method 必須是非空字串');
    if (!list.includes(code)) pfail('POPUP_PAYMENT_METHOD_NOT_ALLOWED', '此付款方式不適用於此快閃活動', 400);
    return code;
  };
}

// ── token / 簽章（callback 參數以既有 JWT_SECRET 做 HMAC；不新增 secret）─────
function newToken() { return crypto.randomBytes(24).toString('hex'); }
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }
function _cbKey() { return process.env.JWT_SECRET || ''; } // 沿用既有部署環境變數 JWT_SECRET；未設定時線上付款視為不可用（見 providerReadiness）
function callbackSig(attemptId, orderNumber, amount) {
  return crypto.createHmac('sha256', _cbKey()).update(`popup-pay|${attemptId}|${orderNumber}|${amount}`).digest('hex');
}
function verifyCallbackSig(attemptId, orderNumber, amount, sig) {
  if (!_cbKey() || typeof sig !== 'string' || !/^[0-9a-f]{64}$/.test(sig)) return false;
  const a = Buffer.from(callbackSig(attemptId, orderNumber, amount), 'hex'), b = Buffer.from(sig, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// 交易內呼叫：建立 pending 付款 attempt（呼叫端已在 runDurableTransaction 內）。
function createAttemptInTransaction(db, { storeId, orderId, sessionId, provider, amount, timeoutMinutes, now }) {
  ensurePopupPaymentSchema(db);
  const token = newToken();
  const attemptId = crypto.randomUUID();
  const expiresAt = (now || Date.now()) + timeoutMinutes * 60000;
  db._db.run(
    `INSERT INTO popup_payment_attempts (attempt_id, store_id, order_id, session_id, provider, token_hash, amount, currency, status, expires_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [attemptId, storeId, orderId, sessionId, provider, hashToken(token), amount, 'TWD', 'pending', expiresAt]
  );
  return { token, attemptId, expiresAt };
}

function findAttemptByToken(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{48}$/.test(token)) return null;
  if (!_hasTable(db, 'popup_payment_attempts')) return null;
  return db.get('SELECT * FROM popup_payment_attempts WHERE token_hash=?', [hashToken(token)]);
}
function findAttemptById(db, attemptId) {
  if (typeof attemptId !== 'string' || !/^[0-9a-f-]{36}$/.test(attemptId)) return null;
  if (!_hasTable(db, 'popup_payment_attempts')) return null;
  return db.get('SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [attemptId]);
}

// 釋放：取消訂單＋釋放份數（只在 attempt 單次轉態成功後呼叫；release 本身也是冪等）。
function _cancelOrderAndRelease(db, attempt, paymentStatus) {
  const { releasePopupOrderAllocations } = require('./popupCheckout');
  db._db.run(
    `UPDATE orders SET order_status='cancelled', payment_status=?, updated_at=datetime('now','localtime')
     WHERE id=? AND store_id=? AND payment_status='pending'`,
    [paymentStatus, attempt.order_id, attempt.store_id]
  );
  return releasePopupOrderAllocations(db, attempt.store_id, attempt.order_id, attempt.session_id);
}

// 單次轉態：只有 status='pending' 的 attempt 會被改動（並行／重複呼叫都只有一次生效）。
function _transitionAttempt(db, attemptId, to, reason, fromFailedToo) {
  db._db.run(
    `UPDATE popup_payment_attempts SET status=?, fail_reason=?, updated_at=datetime('now','localtime') WHERE attempt_id=? AND ${fromFailedToo ? "status IN ('pending','failed')" : "status='pending'"}`,
    [to, reason || '', attemptId]
  );
  return db._db.getRowsModified() === 1;
}

// server-side lazy reconciliation：逾時 pending 付款 → expired；依設定取消並釋放名額。
function reconcileExpiredPopupPayments(db, storeId, now) {
  if (!_hasTable(db, 'popup_payment_attempts')) return { expired: 0, released: 0 };
  const t = now || Date.now();
  // 'failed'（允許改現金而暫時保留名額者）到期同樣收斂為 expired，避免名額被永久佔用。
  const rows = db.all("SELECT * FROM popup_payment_attempts WHERE store_id=? AND status IN ('pending','failed') AND expires_at<=?", [storeId, t]);
  if (!rows.length) return { expired: 0, released: 0 };
  const s = loadPopupPaymentSettings(db, storeId) || defaultPopupPaymentSettings();
  let expired = 0, released = 0;
  db.runDurableTransaction(() => {
    rows.forEach((a) => {
      if (_transitionAttempt(db, a.attempt_id, 'expired', 'timeout', true)) {
        expired += 1;
        if (s.expire_cancel_release) released += _cancelOrderAndRelease(db, a, 'cancelled');
      }
    });
  });
  return { expired, released };
}

function markAttemptFailed(db, attempt, reason) {
  const s = loadPopupPaymentSettings(db, attempt.store_id) || defaultPopupPaymentSettings();
  let changed = false;
  db.runDurableTransaction(() => {
    changed = _transitionAttempt(db, attempt.attempt_id, 'failed', reason);
    if (changed && !s.allow_fallback_cash) _cancelOrderAndRelease(db, attempt, 'failed');
  });
  return changed;
}

function markAttemptPaid(db, attempt, transactionId) {
  let changed = false;
  db.runDurableTransaction(() => {
    changed = _transitionAttempt(db, attempt.attempt_id, 'paid', '');
    if (changed) {
      db._db.run("UPDATE popup_payment_attempts SET transaction_id=? WHERE attempt_id=?", [String(transactionId || ''), attempt.attempt_id]);
      db._db.run(
        `UPDATE orders SET payment_status='paid', updated_at=datetime('now','localtime') WHERE id=? AND store_id=? AND payment_status='pending'`,
        [attempt.order_id, attempt.store_id]
      );
    }
  });
  return changed;
}

// 付款失敗後改現金（只在店家允許時；保留原名額，不重扣）。
function switchFailedAttemptToCash(db, attempt) {
  const s = loadPopupPaymentSettings(db, attempt.store_id);
  if (!s || !s.allow_fallback_cash || !(s.methods.cash && s.methods.cash.enabled)) pfail('POPUP_PAYMENT_FALLBACK_NOT_ALLOWED', '此快閃活動不允許付款失敗後改用現金', 409);
  if (attempt.status !== 'failed') pfail('POPUP_PAYMENT_FALLBACK_NOT_ALLOWED', '目前付款狀態無法改用現金', 409);
  const order = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [attempt.order_id, attempt.store_id]);
  if (!order || order.order_status === 'cancelled' || order.payment_status !== 'pending') pfail('POPUP_PAYMENT_FALLBACK_NOT_ALLOWED', '此訂單已無法改用現金', 409);
  db.runDurableTransaction(() => {
    db._db.run("UPDATE popup_payment_attempts SET status='cancelled', fail_reason='switched_to_cash', updated_at=datetime('now','localtime') WHERE attempt_id=? AND status='failed'", [attempt.attempt_id]);
    if (db._db.getRowsModified() !== 1) pfail('POPUP_PAYMENT_FALLBACK_NOT_ALLOWED', '目前付款狀態無法改用現金', 409);
    db._db.run("UPDATE orders SET payment_method='cash', payment_category='cash', updated_at=datetime('now','localtime') WHERE id=? AND store_id=? AND payment_status='pending'", [attempt.order_id, attempt.store_id]);
  });
  return true;
}

// 對外狀態（沿用既有 canonical 欄位推導；不輸出內部碼給顧客，顧客文字見 label）。
function derivePopupPaymentState(order, attempt) {
  if (!order) return 'unknown';
  if (order.refund_status === 'refunded') return 'refunded';
  if (order.refund_status === 'pending_refund') return 'refund_pending';
  if (order.payment_status === 'paid' || (attempt && attempt.status === 'paid')) return 'paid';
  if (attempt && attempt.status === 'expired') return 'payment_expired';
  if (attempt && attempt.status === 'failed') return 'payment_failed';
  if (order.order_status === 'cancelled') return 'cancelled';
  if (attempt && attempt.status === 'pending') return 'pending_payment';
  if (order.payment_method === 'cash') return 'pay_at_pickup';
  return 'pending_confirmation';
}
const STATE_LABELS = {
  pending_payment: '等待付款', paid: '已付款', payment_failed: '付款未完成', payment_expired: '付款逾時',
  cancelled: '訂單已取消', refund_pending: '退款處理中', refunded: '已退款', pay_at_pickup: '取貨時付款',
  pending_confirmation: '待店家確認付款', unknown: '付款狀態確認中',
};
function stateLabel(state) { return STATE_LABELS[state] || STATE_LABELS.unknown; }

module.exports = {
  SETTINGS_KEY, OVERRIDES_KEY, METHOD_CODES, ONLINE_CODES, METHOD_LABELS, TIMEOUT_MIN, TIMEOUT_MAX,
  PopupPaymentError, ensurePopupPaymentSchema, isPopupPaymentConfigured, defaultPopupPaymentSettings,
  loadPopupPaymentSettings, loadCampaignOverrides, providerReadiness, describeMethods, validateAndNormalizeSettings,
  savePopupPaymentSettings, getCampaignOverride, saveCampaignOverride, storeUsableMethods, effectiveCampaignMethods,
  publicPaymentInfo, makeCheckoutPaymentResolver, newToken, hashToken, callbackSig, verifyCallbackSig,
  createAttemptInTransaction, findAttemptByToken, findAttemptById, reconcileExpiredPopupPayments,
  markAttemptFailed, markAttemptPaid, switchFailedAttemptToCash, derivePopupPaymentState, stateLabel,
};
