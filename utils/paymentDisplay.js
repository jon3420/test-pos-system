// utils/paymentDisplay.js — R54.4／MBV2-HF1-C5.4：伺服器提供的統一付款顯示狀態與商品行金額
//
// 目的
//   1. 付款狀態與履約狀態分開：顧客端「我的訂單／查詢訂單／詳情／完成頁」、宅配頁、後台訂單與 LINE 預購管理
//      都使用同一份由伺服器計算的 payment_display，不再由各畫面依付款方式或網址參數自行推導。
//   2. 判斷只依可信資料：orders.payment_status／refund_status、LINE Pay 付款嘗試（linepay_payment_attempts）、
//      快閃付款嘗試（popup_payment_attempts）。不讀取返回網址或瀏覽器儲存值。
//   3. 多次付款嘗試：已付款 > 待退款 > 待核對（任何一筆仍不明）> 最新一筆的確定結果。
//      不會因最新一筆是確定失敗，就蓋過另一筆已付款或待核對的結果。
//   4. 商品行金額：使用下單時保存的資料（合法的歷史行小計；否則保存的單價×數量），合法的 0 元保留；
//      無法可靠取得時回傳 null（畫面顯示「金額資料不足」），不讀取商品目前價格、不改寫歷史訂單。
//
// 對外狀態（state → label）
//   awaiting_payment     等待付款
//   paid                 已付款
//   failed               付款失敗，本次付款未完成
//   under_review         付款結果確認中，請勿重複付款
//   pay_at_pickup        取餐時付款
//   paid_refund_pending  已付款・待退款
//   refunded             已退款
//   not_charged_cancelled 訂單已取消・未付款
//   offline_pending      待店家確認收款（轉帳、平台付款等非線上方式）
'use strict';

const LABELS = {
  awaiting_payment: '等待付款',
  paid: '已付款',
  failed: '付款失敗，本次付款未完成',
  under_review: '付款結果確認中，請勿重複付款',
  pay_at_pickup: '取餐時付款',
  paid_refund_pending: '已付款・待退款',
  refunded: '已退款',
  not_charged_cancelled: '訂單已取消・未付款',
  offline_pending: '待店家確認收款',
};
const TONES = {
  awaiting_payment: 'info', paid: 'success', failed: 'danger', under_review: 'warning', pay_at_pickup: 'info',
  paid_refund_pending: 'warning', refunded: 'muted', not_charged_cancelled: 'muted', offline_pending: 'info',
};
// 一般 LINE Pay 付款嘗試狀態分類（C5.2／C5.3 定義）
const LP_OPEN = new Set(['confirm_pending', 'review', 'paid_duplicate', 'imported_history']);
const LP_PAID = new Set(['paid']);
const LP_PAID_CANCELLED = new Set(['paid_cancelled']);
// 快閃付款嘗試狀態分類（C5.4 定義）
const PP_OPEN = new Set(['confirm_pending', 'review']);
const PP_PAID = new Set(['paid']);
const PP_PAID_CANCELLED = new Set(['paid_cancelled']);

function _hasTable(db, name) {
  try { return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]); } catch { return false; }
}
const isCancelled = (o) => !!o && (o.order_status === 'cancelled' || o.status === 'void');

function lineAttempts(db, storeId, orderUuid) {
  if (!orderUuid || !_hasTable(db, 'linepay_payment_attempts')) return [];
  try {
    return db.all('SELECT status, result_code, failure_basis, confirm_state, id FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=? ORDER BY id ASC', [storeId, orderUuid]);
  } catch {
    try { return db.all('SELECT status, result_code, id FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=? ORDER BY id ASC', [storeId, orderUuid]); } catch { return []; }
  }
}
function popupAttempts(db, storeId, orderId) {
  if (orderId == null || !_hasTable(db, 'popup_payment_attempts')) return [];
  try {
    return db.all('SELECT status, fail_reason, created_at, rowid AS rid FROM popup_payment_attempts WHERE store_id=? AND order_id=? ORDER BY created_at ASC, rowid ASC', [storeId, String(orderId)]);
  } catch { return []; }
}

// 核心判斷（純函式）：order＋付款嘗試清單（依建立先後排序）＋通路
function derive(order, attempts, channel) {
  const o = order || {};
  const method = String(o.payment_method || '');
  const ps = String(o.payment_status || '');
  const rs = String(o.refund_status || '');
  const open = channel === 'popup' ? PP_OPEN : LP_OPEN;
  const paidSet = channel === 'popup' ? PP_PAID : LP_PAID;
  const paidCancelledSet = channel === 'popup' ? PP_PAID_CANCELLED : LP_PAID_CANCELLED;
  const list = Array.isArray(attempts) ? attempts : [];
  const anyPaid = list.some((a) => paidSet.has(a.status));
  const anyPaidCancelled = list.some((a) => paidCancelledSet.has(a.status));
  const anyOpen = list.some((a) => open.has(a.status));
  const latest = list.length ? list[list.length - 1] : null;
  const cancelled = isCancelled(o);
  let state;
  if (rs === 'refunded') state = 'refunded';
  else if ((ps === 'paid' && (rs === 'pending_refund' || cancelled)) || anyPaidCancelled) state = 'paid_refund_pending';
  else if (ps === 'paid' || anyPaid) state = 'paid';
  else if (anyOpen) state = 'under_review';
  else if (method === 'cash') state = cancelled ? 'not_charged_cancelled' : 'pay_at_pickup';
  else if (method === 'linepay' || method === 'credit_card') {
    if (latest && latest.status === 'failed') state = cancelled ? 'not_charged_cancelled' : 'failed';
    else if (latest && ['expired', 'aborted_cancelled', 'cancelled'].includes(latest.status)) state = cancelled ? 'not_charged_cancelled' : 'failed';
    else if (!latest && (ps === 'failed' || ps === 'expired')) state = cancelled ? 'not_charged_cancelled' : 'failed';
    else state = cancelled ? 'not_charged_cancelled' : 'awaiting_payment';
  } else {
    // 轉帳、平台付款等：由店家確認收款
    state = cancelled ? 'not_charged_cancelled' : (ps === 'failed' ? 'failed' : 'offline_pending');
  }
  const underReview = state === 'under_review';
  // 顧客端「重新付款」只在後端確認目前沒有任何不明付款、且最近一次付款是確定未完成時提供
  //   一般 LINE 訂單：/api/linepay/request 允許（C5.3：PAYMENT_UNDER_REVIEW 才阻擋）
  //   快閃：沒有重新付款功能（只有依設定改現金），can_repay 一律 false
  const canRepay = channel !== 'popup' && method === 'linepay' && !cancelled && (state === 'failed' || state === 'awaiting_payment') && ps !== 'paid';
  return {
    state,
    label: LABELS[state],
    tone: TONES[state],
    under_review: underReview,
    blocks_repay: underReview || state === 'paid' || state === 'paid_refund_pending',
    can_repay: canRepay,
    refund: rs === 'refunded' ? 'done' : (state === 'paid_refund_pending' ? 'pending' : 'none'),
    method,
    method_label: { cash: '現金', linepay: 'LINE Pay', transfer: '轉帳', platform: '平台付款', credit_card: '信用卡' }[method] || method,
    attempts: list.length,
  };
}

function computePaymentDisplay(db, storeId, order) {
  if (!order) return null;
  const isPopup = String(order.pickup_type || '') === 'popup';
  try {
    const attempts = isPopup ? popupAttempts(db, storeId, order.id) : lineAttempts(db, storeId, order.uuid);
    return derive(order, attempts, isPopup ? 'popup' : 'line');
  } catch (e) {
    // 讀取失敗時不推定任何結果：以訂單本身的付款欄位判斷（仍不會把不明顯示成成功）
    return derive(order, [], isPopup ? 'popup' : 'line');
  }
}

// ── 商品行金額（不讀取商品現價、不改寫歷史資料）──
const isMoney = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
function toMoney(v) {
  if (isMoney(v)) return v;
  if (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v)) return Number(v); // 舊資料以字串保存的數字
  return null;
}
const round2 = (n) => Math.round(n * 100) / 100;
function normalizeItem(it) {
  if (!it || typeof it !== 'object') return { name: '', qty: null, unit_price: null, line_subtotal: null, line_subtotal_source: 'missing' };
  const qtyRaw = it.qty == null ? null : Number(it.qty);
  const qty = Number.isFinite(qtyRaw) && qtyRaw > 0 ? qtyRaw : null;
  const unit = toMoney(it.price);
  const stored = toMoney(it.subtotal != null ? it.subtotal : it.line_total);
  let line = null, src = 'missing';
  if (stored !== null) { line = round2(stored); src = 'stored'; }
  else if (unit !== null && qty !== null) { line = round2(unit * qty); src = 'price_x_qty'; }
  return { ...it, qty: qty == null ? it.qty : qty, unit_price: unit, line_subtotal: line, line_subtotal_source: src };
}
function amountBreakdown(order, items) {
  const o = order || {};
  const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
  const incomplete = items.some((i) => i.line_subtotal === null);
  const itemsTotal = incomplete ? null : round2(items.reduce((s, i) => s + i.line_subtotal, 0));
  const discount = num(o.discount_amount);
  const deliveryFee = num(o.delivery_fee);
  const shippingFee = num(o.shipping_fee);
  const total = num(o.total);
  // 差額：保存的總額 －（商品合計 － 折扣 ＋ 外送費 ＋ 運費）。只用於顯示，不改寫任何金額。
  const other = itemsTotal === null ? null : round2(total - (itemsTotal - discount + deliveryFee + shippingFee));
  return {
    items_total: itemsTotal, items_incomplete: incomplete, discount_amount: discount, delivery_fee: deliveryFee,
    shipping_fee: shippingFee, total, other_adjustment: other,
  };
}
function normalizeItems(rawItems) {
  return (Array.isArray(rawItems) ? rawItems : []).map(normalizeItem);
}

module.exports = { LABELS, derive, computePaymentDisplay, normalizeItem, normalizeItems, amountBreakdown, lineAttempts, popupAttempts };
