// utils/popupOrderStatus.js — R54.4／MBV2-HF1-C5.4.2：快閃訂單「成立／付款／履約」對外狀態（後端單一判定）
//
// 核心規則：已保存訂購紀錄 ≠ 已完成線上付款；不可直接向顧客顯示「已成立」。
//   - 付款狀態沿用 utils/paymentDisplay.derive（C5.4：多筆付款紀錄依可信證據合併——已付款 > 待退款 > 待核對 >
//     最新一筆的確定結果；較新的一筆失敗不推翻較早的已付款或待核對）。
//   - 成立狀態由付款狀態、取消／退款與付款方式契約推導；履約進度（已接單、準備中、可取餐、已完成）如實保留、分開輸出。
//   - 本模組只讀取，不寫入任何資料（不扣／放名額、不成交、不通知）。
//
// 付款方式契約（本輪不新增付款方式）
//   現金（含成功改用現金）          → 已成立，取貨時付款
//   LINE Pay／信用卡（有付款紀錄）    → 依付款紀錄：待付款＝尚未成立；確定失敗／取消＝未成立；逾期＝未成立（逾期）；
//                                      待核對／Confirm 未定＝付款結果確認中；後端確認付款＝已成立
//   轉帳、平台付款                    → 既有契約為下單即保留名額、由店家確認收款 → 已成立，待店家確認收款
//   線上付款方式但沒有付款紀錄        → 舊版（未啟用快閃付款設定）建立的訂單沒有線上付款流程，沿用店家確認收款契約
//   0 元：依其付款方式契約（快閃沒有 0 元專用流程）
'use strict';

const PD = require('./paymentDisplay');

const ONLINE = new Set(['linepay', 'credit_card']);
const isCancelled = (o) => !!o && (o.order_status === 'cancelled' || o.status === 'void');

const EST_LABELS = {
  established: '已成立',
  established_pay_at_pickup: '已成立，取貨時付款',
  established_offline_pending: '已成立，待店家確認收款',
  awaiting_payment: '尚未成立，待付款',
  payment_incomplete: '未成立，付款未完成',
  payment_expired: '未成立，付款逾期',
  payment_under_review: '付款結果確認中，請勿重複付款',
  cancelled: '已取消',
  cancelled_expired: '已取消（付款逾期）',
  cancelled_under_review: '已取消（付款結果確認中，請勿重複付款）',
  cancelled_paid_refund_pending: '已取消、已付款・待退款',
  cancelled_refunded: '已取消、已退款',
  refund_pending: '已付款・待退款',
  refunded: '已退款',
};
// 列表徽章（短）
const BADGE = {
  awaiting_payment: '待付款（尚未成立）', payment_incomplete: '付款未完成（未成立）', payment_expired: '付款逾期（未成立）',
  payment_under_review: '付款結果確認中', cancelled: '已取消', cancelled_expired: '已取消（付款逾期）', cancelled_under_review: '付款結果確認中',
  cancelled_paid_refund_pending: '已付款・待退款', refund_pending: '已付款・待退款', cancelled_refunded: '已退款', refunded: '已退款',
};
const FULFILLMENT_LABELS = { pending: '待店家接單', accepted: '已接單', preparing: '準備中', ready: '可取餐', delivering: '配送中', completed: '已完成' };
const PROGRESSED = new Set(['preparing', 'ready', 'delivering', 'completed']);
const PAYMENT_LABELS = {
  refunded: '已退款', paid_refund_pending: '已付款・待退款', paid: '已付款', under_review: '付款結果確認中，請勿重複付款',
  pay_at_pickup: '取貨時付款', awaiting_payment: '待付款', offline_pending: '待店家確認收款',
};
const METHOD_LABELS = { cash: '現金', linepay: 'LINE Pay', transfer: '轉帳', credit_card: '信用卡', platform: '平台付款' };

function _hasTable(db, name) {
  try { return !!db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]); } catch (e) { return false; }
}
// 付款紀錄（依建立先後；R52 以前沒有付款表 → 空陣列）
function loadAttempts(db, order) {
  if (!order || order.id == null || !_hasTable(db, 'popup_payment_attempts')) return [];
  try {
    return db.all(`SELECT status, fail_reason, failure_basis, confirm_state, created_at, updated_at, confirmed_at, expires_at, rowid AS rid
                   FROM popup_payment_attempts WHERE store_id=? AND order_id=? ORDER BY created_at ASC, rowid ASC`, [order.store_id, String(order.id)]);
  } catch (e) {
    try { return db.all('SELECT status, fail_reason, created_at, expires_at, rowid AS rid FROM popup_payment_attempts WHERE store_id=? AND order_id=? ORDER BY created_at ASC, rowid ASC', [order.store_id, String(order.id)]); } catch (e2) { return []; }
  }
}

// 純函式：order＋付款紀錄（依建立先後）→ 對外狀態
function derive(order, attempts) {
  const o = order || {};
  const list = Array.isArray(attempts) ? attempts : [];
  const pd = PD.derive(o, list, 'popup');
  const cancelled = isCancelled(o);
  const latest = list.length ? list[list.length - 1] : null;
  const method = String(o.payment_method || '');
  let e;
  switch (pd.state) {
    case 'refunded': e = cancelled ? 'cancelled_refunded' : 'refunded'; break;
    case 'paid_refund_pending': e = cancelled ? 'cancelled_paid_refund_pending' : 'refund_pending'; break;
    case 'paid': e = cancelled ? 'cancelled_paid_refund_pending' : 'established'; break;
    case 'under_review': e = cancelled ? 'cancelled_under_review' : 'payment_under_review'; break;
    default:
      if (cancelled) e = latest && latest.status === 'expired' ? 'cancelled_expired' : 'cancelled';
      else if (method === 'cash') e = 'established_pay_at_pickup';
      else if (ONLINE.has(method) && list.length) {
        if (latest.status === 'pending') e = 'awaiting_payment';
        else if (latest.status === 'expired') e = 'payment_expired';
        else e = 'payment_incomplete'; // failed／aborted_cancelled／其他確定未付款
      } else e = String(o.payment_status || '') === 'failed' ? 'payment_incomplete' : 'established_offline_pending';
  }
  const established = e.startsWith('established') ? true : (e === 'payment_under_review' || e === 'cancelled_under_review' ? null : false);
  const status = String(o.order_status || '');
  // 履約進度：如實輸出（不因成立判定改寫或倒退）；未成立且仍是初始狀態時不顯示進度
  let fulfillment = null;
  if (!cancelled && FULFILLMENT_LABELS[status] && (established === true || status !== 'pending')) fulfillment = status;
  // 付款文字
  let payLabel = PAYMENT_LABELS[pd.state] || pd.label;
  if (e === 'established_offline_pending') payLabel = PAYMENT_LABELS.offline_pending;
  else if (pd.state === 'failed') payLabel = latest && latest.status === 'expired' ? '付款逾時（未扣款）' : '付款失敗，本次付款未完成';
  else if (pd.state === 'not_charged_cancelled') payLabel = latest && latest.status === 'expired' ? '付款逾時（未扣款）' : '未付款';
  // 徽章
  let badge;
  if (established === true) badge = PROGRESSED.has(status) ? FULFILLMENT_LABELS[status] : '已成立';
  else badge = BADGE[e] || EST_LABELS[e];
  const notEstablishedRecord = ['awaiting_payment', 'payment_incomplete', 'payment_expired', 'cancelled', 'cancelled_expired'].includes(e);
  return {
    establishment: e,
    establishment_label: EST_LABELS[e],
    established,
    payment_state: pd.state,
    payment_status_label: payLabel,
    payment_method_label: METHOD_LABELS[method] || '其他',
    fulfillment,
    fulfillment_label: fulfillment ? FULFILLMENT_LABELS[fulfillment] : null,
    status_label: badge,
    // 舊欄位相容：order_status_label 不再是履約對照表，改為與成立判定一致的文字（避免舊畫面顯示「已成立」）
    order_status_label: established === true && PROGRESSED.has(status) ? FULFILLMENT_LABELS[status] : EST_LABELS[e],
    // 未成立紀錄：「重新下單」（帶商品回購物流程，建立新訂單）；不是補繳原訂單
    reorder_label: notEstablishedRecord ? '重新下單' : '再購',
    reorder_is_new_order: true,
  };
}
function forOrder(db, order, attempts) {
  if (!order) return null;
  return derive(order, attempts || loadAttempts(db, order));
}

module.exports = { EST_LABELS, FULFILLMENT_LABELS, PAYMENT_LABELS, loadAttempts, derive, forOrder };
