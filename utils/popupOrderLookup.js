// utils/popupOrderLookup.js — R53 快閃訂單查詢／我的訂單／詳情／再購
//
// 查詢規則沿用一般 LINE 訂單（routes/line-orders.js POST /query、/history）：
//   - 電話：去除「-」與空白；去除後 ≥6 位數字＝完整電話，否則取末 3 碼。
//   - 「今日」＝台北時間（Asia/Taipei）日曆日，與 date(created_at) 比對。
//   - 「最近 3 天」＝date(created_at) >= 台北今日 − 3 天（含今日共 4 個日曆日，與一般 LINE 相同）。
//   - 姓名：前後去空白後做部分比對（SQLite LIKE，ASCII 不分大小寫；不做全半形轉換，與一般 LINE 相同）。
//   - 訂單編號＋電話：電話末 3 碼相符即通過（與一般 LINE 相同）。
// 快閃比一般 LINE 嚴格之處（不得較弱）：
//   - 只查 pickup_type='popup' 且同一 store_id 的訂單；一般 LINE／POS／宅配訂單一律不出現。
//   - 訂單編號必須搭配電話；完整電話必須是合法台灣手機格式；姓名中的 % _ 會被跳脫。
//   - 查詢成功後發一次性 opaque token（只存 SHA-256，30 分鐘到期），之後列表／詳情／再購
//     只能用 token；PII 不放 URL、不記 log、前端不存 localStorage。
//   - 查無資料／驗證失敗一律同一個一般化訊息。
'use strict';

const crypto = require('crypto');
const { normalizeTaiwanMobile } = require('../public/js/phone-utils');

const TOKEN_TTL_MS = 30 * 60 * 1000;
const PAGE_SIZE = 10;
const GENERIC_NOT_FOUND = '找不到符合資料的快閃訂單，請確認輸入內容。';

function twNow() { return new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' })); }
function twDateStr(d) {
  const dt = d || twNow();
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}
function taipeiToday(nowDate) { return twDateStr(nowDate || twNow()); }
function taipeiThreeDaysAgo(nowDate) { const d = new Date(nowDate || twNow()); d.setDate(d.getDate() - 3); return twDateStr(d); }
function cleanPhone(raw) { return String(raw || '').trim().replace(/[-\s]/g, ''); }
function isFullPhone(cleaned) { return /^\d{6,}$/.test(cleaned); }
function escapeLike(s) { return String(s).replace(/[\\%_]/g, (c) => '\\' + c); }

function ensureLookupSchema(db) {
  db._db.run(`CREATE TABLE IF NOT EXISTS popup_lookup_sessions (
    token_hash  TEXT PRIMARY KEY,
    store_id    TEXT NOT NULL,
    scope_json  TEXT NOT NULL,
    expires_at  INTEGER NOT NULL,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime'))
  )`);
}
function hashToken(t) { return crypto.createHash('sha256').update(String(t)).digest('hex'); }

// 依查詢輸入建立 scope（只回傳 mode 與比對條件，不查 DB）。
// 回傳 { ok:true, scope } 或 { ok:false, error:'VALIDATION'|'INVALID_PHONE' }
function buildScope(input) {
  const rawPhone = cleanPhone(input.phone);
  const rawName = String(input.customer_name || '').trim();
  const rawOrderNo = String(input.order_number || '').trim();
  if (!rawPhone) return { ok: false, error: 'VALIDATION', message: '請輸入電話或電話後三碼' };
  if (rawOrderNo.length > 80 || rawName.length > 100 || rawPhone.length > 20) return { ok: false, error: 'VALIDATION', message: '輸入內容過長' };
  if (rawOrderNo) {
    if (!/^\d{3,}$/.test(rawPhone)) return { ok: false, error: 'VALIDATION', message: '電話後三碼請輸入3位數字' };
    return { ok: true, scope: { mode: 'order', order_number: rawOrderNo, phone_input: rawPhone } };
  }
  if (isFullPhone(rawPhone)) {
    const n = normalizeTaiwanMobile(rawPhone);
    if (!n.valid) return { ok: false, error: 'INVALID_PHONE', message: '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）' };
    return { ok: true, scope: { mode: 'phone', phone: n.local } };
  }
  const last3 = rawPhone.slice(-3);
  if (!/^\d{3}$/.test(last3)) return { ok: false, error: 'VALIDATION', message: '電話後三碼請輸入3位數字' };
  if (rawName) return { ok: true, scope: { mode: 'last3_name', last3, name: rawName } };
  return { ok: true, scope: { mode: 'last3_today', last3 } };
}

// scope → SQL 條件（一律含 store_id 與 pickup_type='popup'）。
function scopeWhere(storeId, scope, nowDate) {
  const base = "store_id=? AND pickup_type='popup'";
  if (scope.mode === 'order') return { where: `${base} AND order_number=?`, params: [storeId, scope.order_number] };
  if (scope.mode === 'phone') return { where: `${base} AND customer_phone=?`, params: [storeId, scope.phone] };
  if (scope.mode === 'last3_name') {
    return { where: `${base} AND substr(customer_phone,-3)=? AND customer_name LIKE ? ESCAPE '\\' AND date(created_at) >= ?`,
      params: [storeId, scope.last3, `%${escapeLike(scope.name)}%`, taipeiThreeDaysAgo(nowDate)] };
  }
  if (scope.mode === 'last3_today') {
    return { where: `${base} AND substr(customer_phone,-3)=? AND date(created_at)=?`, params: [storeId, scope.last3, taipeiToday(nowDate)] };
  }
  throw new Error('unknown scope');
}

function verifyOrderScope(order, scope) {
  if (!order || scope.mode !== 'order') return !!order;
  const stored = String(order.customer_phone || '');
  const cleaned = scope.phone_input;
  return stored === cleaned || stored.endsWith(cleaned.slice(-3)) || (cleaned.length >= 4 && stored.endsWith(cleaned));
}

function countScope(db, storeId, scope, nowDate) {
  const w = scopeWhere(storeId, scope, nowDate);
  if (scope.mode === 'order') {
    const o = db.get(`SELECT * FROM orders WHERE ${w.where}`, w.params);
    return verifyOrderScope(o, scope) ? 1 : 0;
  }
  const r = db.get(`SELECT COUNT(*) AS c FROM orders WHERE ${w.where}`, w.params);
  return r ? Number(r.c) : 0;
}

function listScope(db, storeId, scope, page, nowDate) {
  const w = scopeWhere(storeId, scope, nowDate);
  const p = Math.max(1, Math.min(10000, Number.isSafeInteger(page) ? page : 1));
  if (scope.mode === 'order') {
    const o = db.get(`SELECT * FROM orders WHERE ${w.where}`, w.params);
    return verifyOrderScope(o, scope) ? [o] : [];
  }
  return db.all(`SELECT * FROM orders WHERE ${w.where} ORDER BY created_at DESC, order_number DESC LIMIT ? OFFSET ?`,
    [...w.params, PAGE_SIZE, (p - 1) * PAGE_SIZE]);
}

function findOrderInScope(db, storeId, scope, orderNumber, nowDate) {
  if (typeof orderNumber !== 'string' || !orderNumber || orderNumber.length > 80) return null;
  const w = scopeWhere(storeId, scope, nowDate);
  const o = db.get(`SELECT * FROM orders WHERE ${w.where} AND order_number=?`, [...w.params, orderNumber]);
  return verifyOrderScope(o, scope) ? o : null;
}

function issueToken(db, storeId, scope) {
  ensureLookupSchema(db);
  const token = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  db.runDurableTransaction(() => {
    db._db.run('DELETE FROM popup_lookup_sessions WHERE expires_at<? OR revoked=1', [now]);
    db._db.run('INSERT INTO popup_lookup_sessions (token_hash, store_id, scope_json, expires_at) VALUES (?,?,?,?)',
      [hashToken(token), storeId, JSON.stringify(scope), now + TOKEN_TTL_MS]);
  });
  return { token, expires_at: new Date(now + TOKEN_TTL_MS).toISOString() };
}

// 回傳 { ok, storeId, scope } 或 { ok:false, error:'EXPIRED'|'INVALID' }
function resolveToken(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return { ok: false, error: 'INVALID' };
  ensureLookupSchema(db);
  const row = db.get('SELECT * FROM popup_lookup_sessions WHERE token_hash=?', [hashToken(token)]);
  if (!row || Number(row.revoked) === 1) return { ok: false, error: 'INVALID' };
  if (Number(row.expires_at) <= Date.now()) return { ok: false, error: 'EXPIRED' };
  let scope = null;
  try { scope = JSON.parse(row.scope_json); } catch (e) { return { ok: false, error: 'INVALID' }; }
  return { ok: true, storeId: row.store_id, scope };
}

function revokeToken(db, token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  ensureLookupSchema(db);
  let changed = 0;
  db.runDurableTransaction(() => {
    db._db.run('UPDATE popup_lookup_sessions SET revoked=1 WHERE token_hash=? AND revoked=0', [hashToken(token)]);
    changed = db._db.getRowsModified();
  });
  return changed === 1;
}

// ── 顧客可理解的狀態 ─────────────────────────────────────────────────
const PAYMENT_METHOD_LABELS = { cash: '現金', linepay: 'LINE Pay', transfer: '轉帳', credit_card: '信用卡', platform: '平台付款' };
const ORDER_STATUS_LABELS = { pending: '已成立', accepted: '已成立', preparing: '準備中', ready: '可取餐', completed: '已完成', cancelled: '已取消' };

function latestAttempt(db, order) {
  try {
    return db.get('SELECT status FROM popup_payment_attempts WHERE order_id=? AND store_id=? ORDER BY created_at DESC, rowid DESC LIMIT 1', [order.id, order.store_id]) || null;
  } catch (e) { return null; } // R52 以前沒有付款表
}

function consumerStatus(order, attempt) {
  const a = attempt ? attempt.status : null;
  let payment;
  if (order.refund_status === 'refunded') payment = '已退款';
  else if (order.refund_status === 'pending_refund') payment = '退款處理中';
  else if (order.payment_status === 'paid' || a === 'paid') payment = '已付款';
  else if (a === 'expired') payment = '已逾期';
  else if (a === 'failed') payment = '付款失敗';
  else if (a === 'pending') payment = '待付款';
  else if (order.order_status === 'cancelled') payment = '未付款';
  else if (order.payment_method === 'cash') payment = '取貨時付款';
  else payment = '付款確認中';

  const orderLabel = ORDER_STATUS_LABELS[order.order_status] || '處理中';
  let overall;
  if (order.refund_status === 'refunded' || order.refund_status === 'pending_refund') overall = payment;
  else if (order.order_status === 'cancelled') overall = a === 'expired' ? '已逾期' : (a === 'failed' ? '付款失敗' : '已取消');
  else if (a === 'pending') overall = '待付款';
  else if (a === 'failed') overall = '付款失敗';
  else if (payment === '付款確認中' && order.order_status === 'pending') overall = '付款確認中';
  else overall = orderLabel;
  return { status_label: overall, order_status_label: orderLabel, payment_status_label: payment };
}

function parseItems(order) {
  let items = [];
  try { items = JSON.parse(order.items || '[]'); } catch (e) { items = []; }
  if (!Array.isArray(items)) items = [];
  return items.map((it) => {
    const qty = Number(it && it.qty) || 0;
    const price = Number(it && it.price) || 0;
    return { product_id: Number(it && it.product_id) || null, name: String((it && it.name) || ''), price, qty, subtotal: price * qty };
  });
}

function maskPhone(p) {
  const s = String(p || '');
  if (s.length < 4) return '***';
  return s.slice(0, 2) + '*'.repeat(Math.max(0, s.length - 5)) + s.slice(-3);
}

// 列表摘要（不含電話／姓名以外的內部欄位）
function summaryView(db, order) {
  const items = parseItems(order);
  const st = consumerStatus(order, latestAttempt(db, order));
  const summary = items.slice(0, 2).map((i) => `${i.name}×${i.qty}`).join('、') + (items.length > 2 ? `…等${items.length}項` : '');
  return {
    order_number: order.order_number,
    created_at: order.created_at,
    campaign_name: order.popup_campaign_name_snapshot || '',
    session_name: order.popup_session_name_snapshot || '',
    pickup_date: order.popup_pickup_date_snapshot || '',
    pickup_start_time: order.popup_pickup_start_time_snapshot || '',
    pickup_end_time: order.popup_pickup_end_time_snapshot || '',
    place_name: order.pickup_place_name_snapshot || '',
    items_summary: summary,
    total: Number(order.total || 0),
    payment_method_label: PAYMENT_METHOD_LABELS[order.payment_method] || '其他',
    ...st,
  };
}

function detailView(db, order) {
  const items = parseItems(order);
  return {
    ...summaryView(db, order),
    address: order.pickup_address_snapshot || '',
    address_note: order.pickup_address_note_snapshot || '',
    customer_name: order.customer_name || '',
    phone_masked: maskPhone(order.customer_phone),
    note: order.note || '',
    items,
    total_qty: items.reduce((n, i) => n + i.qty, 0),
    updated_at: order.updated_at || order.created_at,
  };
}

module.exports = {
  TOKEN_TTL_MS, PAGE_SIZE, GENERIC_NOT_FOUND, twNow, twDateStr, taipeiToday, taipeiThreeDaysAgo, cleanPhone, isFullPhone,
  escapeLike, buildScope, scopeWhere, countScope, listScope, findOrderInScope, issueToken, resolveToken, revokeToken,
  consumerStatus, summaryView, detailView, parseItems, maskPhone, ensureLookupSchema,
};
