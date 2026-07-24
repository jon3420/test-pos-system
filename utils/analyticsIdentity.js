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

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix31-R2｜Read-time 身份合併（Visitor 360 / Drill Down 專用）
//
// 上面的 resolveIdentity() 是「寫入當下」用 fields 直接算出 identity_key
// （給 analyticsLog.js 寫入 analytics_events 用）。這裡新增的
// resolveCanonicalVisitor() 是「讀取當下」的合併查詢：給一個任意 key
// （可能是 visitor_id／session_id／cart_id／line_user_id 其中一種，呼叫端
// 不需要事先知道是哪一種），找出這個 key 背後「最可靠」對應到的身份。
//
// 這不是第二套身份系統——合併規則完全建立在上面 IDENTITY_TYPES／
// KEY_PREFIX／ESTIMATED_TYPES 已定義的同一套優先順序之上，只是額外查詢
// line_members／line_member_sessions（這兩張表本來就是既有 LINE CRM 基礎
// 設施，見 fix18-10-hotfix23-E），把「同一人跨裝置／匿名轉會員」的既有
// 資料串起來，不新建任何身份判斷邏輯或資料表。
//
// 合併規則（需求文件 D，僅使用「決定性」連結，不臆測）：
//   1. key 本身就是已知的 line_user_id（line_members 有這筆會員）
//      → 直接視為該 LINE 會員，confidence='high'。
//   2. key 是曾經被記錄過「這個 visitor_id／session_id／cart_id 屬於某個
//      LINE 會員」的匿名識別碼（line_member_sessions，在真正的 LINE 登入
//      當下寫入，不是事後猜測）→ 視為該 LINE 會員，confidence='high'。
//   3. key 在 analytics_events 出現過，但沒有任何 LINE 連結紀錄
//      → 保持匿名，回推出真正的 visitor_id（key 可能傳進來的是
//      session_id／cart_id），confidence='unresolved'，明確不合併。
//   4. key 完全查無任何紀錄 → found=false（呼叫端應回 404，不得猜測）。
//
// 絕對不做的事（需求文件 D.4／D.5）：不使用 IP 做任何合併判斷、不因為
// 「看起來像同一人」的弱假設（例如同商品/同時段）就合併——只走上面 1/2
// 兩種有實際資料庫紀錄佐證的決定性連結。
//
// Store 隔離：storeId 為必要參數，所有查詢一律 WHERE store_id=?，不同店家
// 的 line_user_id／visitor_id 就算字串相同也絕不互相合併或讀取。
// ══════════════════════════════════════════════════════════════════

function _getLinkedVisitorIds(db, storeId, lineUserId) {
  try {
    const rows = db.all(
      "SELECT DISTINCT visitor_id FROM line_member_sessions WHERE store_id=? AND line_user_id=? AND visitor_id != ''",
      [storeId, lineUserId]
    );
    return rows.map((r) => r.visitor_id);
  } catch (e) { return []; }
}

function resolveCanonicalVisitor(db, storeId, rawKey) {
  const key = _clean(rawKey);
  if (!db || !storeId || !key) return { found: false };

  // 規則 1：key 本身就是已知的 LINE 會員
  let lm = null;
  try { lm = db.get('SELECT line_user_id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, key]); } catch (e) { lm = null; }
  if (lm && lm.line_user_id) {
    return {
      found: true,
      canonical_type: 'line_user_id',
      line_user_id: key,
      visitor_id: null,
      resolution_method: 'direct_line_member',
      confidence: 'high',
      linked_visitor_ids: _getLinkedVisitorIds(db, storeId, key),
    };
  }

  // 規則 2：key（可能是 visitor_id／session_id／cart_id）曾在 LINE 登入當下
  // 被記錄與某個 line_user_id 綁定（line_member_sessions，決定性連結）
  let link = null;
  try {
    link = db.get(
      `SELECT line_user_id FROM line_member_sessions
       WHERE store_id=? AND (visitor_id=? OR session_id=? OR cart_id=?)
       ORDER BY last_seen_at DESC LIMIT 1`,
      [storeId, key, key, key]
    );
  } catch (e) { link = null; }
  if (link && link.line_user_id) {
    const lm2 = db.get('SELECT line_user_id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, link.line_user_id]);
    if (lm2) {
      return {
        found: true,
        canonical_type: 'line_user_id',
        line_user_id: link.line_user_id,
        visitor_id: null,
        resolution_method: 'visitor_session_link',
        confidence: 'high',
        linked_visitor_ids: _getLinkedVisitorIds(db, storeId, link.line_user_id),
      };
    }
  }

  // 規則 3：沒有任何 LINE 連結——保持匿名。key 可能傳進來的是 session_id／
  // cart_id，回推真正的 visitor_id（同一張 analytics_events，不新建查詢對象）。
  let visitorId = key;
  let resolutionMethod = 'anonymous_no_link';
  let foundAny = false;
  try {
    const row = db.get(
      `SELECT visitor_id FROM analytics_events
       WHERE store_id=? AND (visitor_id=? OR session_id=? OR cart_id=?) AND visitor_id IS NOT NULL AND visitor_id != ''
       ORDER BY id ASC LIMIT 1`,
      [storeId, key, key, key]
    );
    if (row && row.visitor_id) {
      foundAny = true;
      if (row.visitor_id !== key) { visitorId = row.visitor_id; resolutionMethod = 'session_or_cart_lookup'; }
    }
  } catch (e) { foundAny = false; }

  if (!foundAny) {
    // key 完全查無任何紀錄（既非 LINE 會員、也不是任何已知 session/cart/visitor）
    return { found: false };
  }

  return {
    found: true,
    canonical_type: 'visitor_id',
    line_user_id: null,
    visitor_id: visitorId,
    resolution_method: resolutionMethod,
    confidence: 'unresolved', // 匿名訪客：明確標示「未解析成可靠身份」，不臆測合併
    linked_visitor_ids: [visitorId],
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
  resolveCanonicalVisitor,
};
