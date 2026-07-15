// utils/analyticsIdentity.js — fix18-10-hotfix24-A3｜共用 Analytics Identity Resolver
//
// 目的（需求文件四／五）：全系統只有「這一個」判斷「同一人是誰」的地方。
// 老闆儀表板、POS Analytics V2、Funnel、Cart Abandonment、CRM Dashboard、
// Source Performance、Customer Journey、回購分析都必須呼叫這裡，不得各自
// 用 session／cart／line_user 各寫一套邏輯（需求文件十）。
//
// 身份辨識優先順序（需求文件四，依專案目前實際存在的欄位實作）：
//   1. line_member_id / member_id（本專案的會員系統以 LINE 登入為準，
//      member_id 與 line_user_id 是同一個值，因此兩者合併為同一優先層級）
//   2. line_user_id（已用 utils/lineMemberSession.js 的 verifyMemberSession()
//      驗證過簽章／效期／店別，不接受前端直接聲稱的 line_user_id）
//   3. customer_id（訂單上的會員／客戶紀錄，本專案目前對應 customer_phone /
//      customers 表；保留欄位供未來擴充獨立的 customer_id）
//   4. session_id（前台一律會提供，缺其他身份時的預設辨識依據）
//   5. cart_id（連 session_id 都沒有時的最後手段；理論上不會發生，因為
//      POST /api/analytics/events 已強制要求 session_id 必填，這裡只是防禦）
//
// 絕對不得把 IP、product_id、order_item_id、event id、event row count、
// product_name、referer、單獨的 user_agent 當作身份主鍵（需求文件四「禁止使用」）。
// IP 完全不出現在這個模組裡——不是「優先度最低」，是「根本不參與」身份判斷。
//
// Store 隔離（需求文件五情境 E）：這個模組刻意「不」把 store_id 塞進
// identity_key 字串本身（維持與需求文件範例格式一致：'line_user:Uxxxxxxxx'）。
// 所有呼叫端（analytics_events / orders 查詢）本來就一律有 WHERE store_id=?，
// store_id + identity_key 的組合才是實際的唯一識別鍵，identity_key 字串
// 本身不需要也不應該重複帶入 store scope。呼叫端絕不能把不同 store_id 底下
// 的 identity_key 拿來互相比對／合併。

'use strict';

// identity_type 標準值（依優先順序排列）
const IDENTITY_TYPES = ['line_user_id', 'customer_id', 'session_id', 'cart_id'];

// 只有 session_id / cart_id 屬於「估算」身份（同一人换裝置／换瀏覽器就會被
// 判定成不同人）；line_user_id / customer_id 是可靠身份，is_estimated=false。
const ESTIMATED_TYPES = new Set(['session_id', 'cart_id']);

const KEY_PREFIX = {
  line_user_id: 'line_user',
  customer_id: 'customer',
  session_id: 'session',
  cart_id: 'cart',
};

function _clean(v) {
  if (v === undefined || v === null) return '';
  const s = String(v).trim();
  return s;
}

/**
 * 解析單一使用者的身份。
 * @param {object} fields
 * @param {string} [fields.line_member_id] 會員系統 ID（本專案與 line_user_id 同義）
 * @param {string} [fields.member_id]      同上，保留相容命名
 * @param {string} [fields.line_user_id]   已驗證過的 LINE user id（不接受未驗證輸入）
 * @param {string} [fields.customer_id]    客戶／會員紀錄 ID（本專案目前少用，保留擴充）
 * @param {string} [fields.session_id]
 * @param {string} [fields.cart_id]
 * @returns {{identity_key: string|null, identity_type: string|null, is_estimated: boolean}}
 */
function resolveIdentity(fields) {
  fields = fields || {};
  const lineUserId = _clean(fields.line_member_id) || _clean(fields.member_id) || _clean(fields.line_user_id);
  const customerId = _clean(fields.customer_id);
  const sessionId = _clean(fields.session_id);
  const cartId = _clean(fields.cart_id);

  let type = null, raw = '';
  if (lineUserId) { type = 'line_user_id'; raw = lineUserId; }
  else if (customerId) { type = 'customer_id'; raw = customerId; }
  else if (sessionId) { type = 'session_id'; raw = sessionId; }
  else if (cartId) { type = 'cart_id'; raw = cartId; }

  if (!type) {
    return { identity_key: null, identity_type: null, is_estimated: true };
  }
  return {
    identity_key: `${KEY_PREFIX[type]}:${raw}`,
    identity_type: type,
    is_estimated: ESTIMATED_TYPES.has(type),
  };
}

// identity_basis 顯示用中文名稱（供 Tracking Health／各儀表板 UI 說明用）
const IDENTITY_TYPE_LABELS = {
  line_user_id: 'LINE 會員',
  customer_id: '客戶紀錄',
  session_id: 'Session（估算）',
  cart_id: '購物車（估算）',
};

function identityBasisLabel(identityType) {
  return IDENTITY_TYPE_LABELS[identityType] || '—';
}

// ── 彙總某一批 analytics_events 資料列（已含 identity_type 欄位）的主要身份基礎 ──
// 用於 Tracking Health／API 頂層 identity_basis 說明「這段時間主要是靠什麼辨識使用者」。
// 不做任何身份合併，純粹統計某個 identity_type 出現次數最多。
function summarizeIdentityBasis(rows) {
  if (!rows || !rows.length) {
    return { identity_basis: null, identity_is_estimated: null, sample_size: 0 };
  }
  const counts = {};
  rows.forEach(r => {
    const t = r && r.identity_type;
    if (!t) return;
    counts[t] = (counts[t] || 0) + 1;
  });
  const types = Object.keys(counts);
  if (!types.length) {
    return { identity_basis: null, identity_is_estimated: null, sample_size: rows.length };
  }
  types.sort((a, b) => counts[b] - counts[a]);
  const top = types[0];
  return {
    identity_basis: top,
    identity_is_estimated: ESTIMATED_TYPES.has(top),
    sample_size: rows.length,
  };
}

module.exports = {
  IDENTITY_TYPES,
  ESTIMATED_TYPES,
  KEY_PREFIX,
  resolveIdentity,
  IDENTITY_TYPE_LABELS,
  identityBasisLabel,
  summarizeIdentityBasis,
};
