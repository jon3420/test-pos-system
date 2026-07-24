// utils/visitorAudience.js — fix18-10-hotfix31-R4「Visitor 360 Audience List」
//
// 目的（需求文件 G/H/I/J/K）：Operation Analytics 裡「所有訪客/會員」的一頁式列表——
// 每一列是一個「人」（canonical visitor/member），不是一筆事件、不是一張購物車。
// 支援分頁、篩選（身份／好友狀態／回訪頻率／購買行為／活躍度／數值區間／來源歸因）、
// 排序、回訪分數、顧客狀態標籤，並與既有 CRM 分群基礎（utils/drilldown.js resolveMemberKeys
// 的既有介面）相容，讓 Visitor 360 篩選出來的名單也能建立分群。
//
// 架構原則（沿用 utils/visitor360.js 已建立的慣例，不建立第二套身份/合併系統）：
//   - 唯一的身份合併規則來源是 utils/analyticsIdentity.js（line_members ×
//     line_member_sessions 的既有決定性連結），本模組只是把「單一訪客的合併結果」
//     擴大成「整店所有訪客的合併結果」，合併邏輯本身不重新發明。
//   - LTV／訂單數對 LINE 會員一律直接讀 line_members 既有欄位（同 visitor360.js），
//     不重新加總計算。
//   - 即時運算的檢視，不建立持久化資料表儲存計算結果（回傳 generated_at）。
//   - 效能：批次查詢（IN 子句），不對每個訪客/會員各自查一次事件表；候選集合有
//     硬上限（MAX_ANONYMOUS_VISITORS／MAX_LINE_MEMBERS），超過時回傳 warnings，
//     不悄悄截斷（需求文件 M）。
//   - 所有查詢一律以 store_id 隔離。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
let maskLineUserId;
try {
  ({ maskLineUserId } = require('./lineMemberStats'));
} catch (e) {
  maskLineUserId = (id) => { const s = String(id || ''); return s.length <= 8 ? (s ? s[0] + '****' : '') : s.slice(0, 5) + '****' + s.slice(-4); };
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function _inParams(list) { return list.map(() => '?').join(','); }

// 需求文件 L（隱私）：匿名訪客 ID 在 UI 上一律顯示縮短版本，不曝露完整原始 ID。
function shortDisplayKey(rawKey) {
  const s = String(rawKey || '');
  if (s.length <= 10) return s ? s.slice(0, 4) + '…' : '';
  return s.slice(0, 6) + '…' + s.slice(-4);
}

// 候選集合上限（需求文件 M：效能／防止極端規模拖垮查詢）。超過上限時回傳 warnings，
// 不悄悄截斷結果（需求文件 J 的既有慣例，這裡沿用同一原則）。
const MAX_LINE_MEMBERS = 5000;
const MAX_ANONYMOUS_VISITORS = 5000;

// ══════════════════════════════════════════════════════════════════
// 篩選欄位白名單（需求文件 H）——所有可篩選/可排序欄位一律白名單，
// 拒絕任意欄位名稱（沿用 utils/drilldown.js 既有慣例）。
// ══════════════════════════════════════════════════════════════════
const IDENTITY_FILTERS = new Set(['all', 'anonymous', 'line_member', 'anonymous_upgraded', 'unresolved']);
const FRIEND_FILTERS = new Set(['all', 'friend', 'not_friend', 'unknown']);
const VISIT_FREQ_FILTERS = new Set(['all', 'first_time', '2plus', '3plus', 'high']);
const PURCHASE_BEHAVIOR_FILTERS = new Set([
  'all', 'never_purchased', 'has_purchased', 'repeat', '2plus_orders',
  'cart_no_order', 'multi_cart_no_purchase', 'checkout_no_purchase',
]);
const ACTIVITY_FILTERS = new Set([
  'all', 'last_24h', 'last_7d', 'last_30d', 'inactive_30d', 'inactive_60d', 'inactive_90d',
]);

const SORT_FIELD_MAP = {
  last_activity: 'last_seen_at',
  visit_count: 'visit_count',
  cart_count: 'cart_count',
  checkout_count: 'checkout_count',
  order_count: 'order_count',
  total_revenue: 'total_revenue',
  avg_order_value: 'avg_order_value',
  last_purchase: 'last_purchase_at',
  revisit_score: 'revisit_score',
};
const DEFAULT_SORT = 'last_activity';

// 高回訪門檻（需求文件 H「高回訪訪客」）—— 純規則常數，非資料庫欄位
const HIGH_REVISIT_VISIT_COUNT = 5;

function _sanitizeFilters(raw = {}) {
  const f = {};
  f.identity = IDENTITY_FILTERS.has(raw.identity) ? raw.identity : 'all';
  f.friend_status = FRIEND_FILTERS.has(raw.friend_status) ? raw.friend_status : 'all';
  f.visit_frequency = VISIT_FREQ_FILTERS.has(raw.visit_frequency) ? raw.visit_frequency : 'all';
  f.purchase_behavior = PURCHASE_BEHAVIOR_FILTERS.has(raw.purchase_behavior) ? raw.purchase_behavior : 'all';
  f.activity = ACTIVITY_FILTERS.has(raw.activity) ? raw.activity : 'all';

  ['min_visit_count', 'max_visit_count', 'min_cart_count', 'max_cart_count',
    'min_order_count', 'max_order_count', 'min_revenue', 'max_revenue',
    'min_aov', 'max_aov', 'min_revisit_score', 'max_revisit_score'].forEach((k) => {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '') {
      const v = Number(raw[k]);
      if (Number.isFinite(v)) f[k] = v;
    }
  });

  // Attribution：source / campaign / channel / order_mode（需求文件 H）——自由文字值，
  // 但一律用參數化查詢比對，不做字串拼接；長度做防禦性截斷。
  ['source', 'campaign', 'channel', 'order_mode'].forEach((k) => {
    if (raw[k] !== undefined && raw[k] !== null && raw[k] !== '' && raw[k] !== 'all') {
      f[k] = String(raw[k]).slice(0, 100);
    }
  });

  return f;
}

// ══════════════════════════════════════════════════════════════════
// 回訪分數（需求文件 I）—— 透明、可解釋、store-scoped、即時運算，不持久化成
// 第二個資料來源。回傳分數本身 + 逐項解釋（供 Visitor 360 detail 顯示）。
// ══════════════════════════════════════════════════════════════════
function computeRevisitScore({ visitCount, cartCount, checkoutCount, orderCount, lastSeenAt, repeatOrderCount }) {
  const items = [];
  let score = 0;

  const visitPoints = Math.min(visitCount, 10) * 2; // 每次 +2，上限 10 次計分（20 分封頂）
  if (visitCount > 0) { items.push({ label: `來訪 ${visitCount} 次`, points: visitPoints }); score += visitPoints; }

  const cartPoints = cartCount * 3;
  if (cartCount > 0) { items.push({ label: `購物車 ${cartCount} 次`, points: cartPoints }); score += cartPoints; }

  const checkoutPoints = checkoutCount * 4;
  if (checkoutCount > 0) { items.push({ label: `開始結帳 ${checkoutCount} 次`, points: checkoutPoints }); score += checkoutPoints; }

  const orderPoints = orderCount * 10;
  if (orderCount > 0) { items.push({ label: `訂單 ${orderCount} 筆`, points: orderPoints }); score += orderPoints; }

  // 回購加成：訂單數 >=2 時額外 +5（需求文件 I「repeat purchase bonus」）
  if (orderCount >= 2) { items.push({ label: '回購加成', points: 5 }); score += 5; }

  // 久未活動調整：距最後活動時間越久，扣分越多（衰減，非持久化）
  let decay = 0;
  if (lastSeenAt) {
    const days = (Date.now() - new Date(String(lastSeenAt).replace(' ', 'T') + 'Z').getTime()) / 86400000;
    if (days > 90) decay = -10;
    else if (days > 60) decay = -5;
    else if (days > 30) decay = -1;
  }
  if (decay !== 0) { items.push({ label: '久未活動調整', points: decay }); score += decay; }

  score = Math.max(0, Math.round(score));
  return {
    score,
    is_analytical_score: true, // 需求文件 I：明確標示這是分析用分數，不是營收或購買機率
    disclaimer: '回訪分數是分析用的參考分數，不代表營收或購買機率。',
    explanation: items,
  };
}

// ══════════════════════════════════════════════════════════════════
// 顧客狀態標籤（需求文件 J）—— 規則式、可解釋，允許多個標籤同時成立。
// ══════════════════════════════════════════════════════════════════
function deriveCustomerStatusTags({ identity, visitCount, cartCount, checkoutCount, orderCount, totalRevenue, lastSeenAt, highValueThreshold }) {
  const tags = [];
  if (identity === 'unresolved') { tags.push('身份未解析'); return tags; }

  const daysSinceLastSeen = lastSeenAt
    ? (Date.now() - new Date(String(lastSeenAt).replace(' ', 'T') + 'Z').getTime()) / 86400000
    : null;

  if (visitCount <= 1) tags.push('新訪客');
  else tags.push('回訪訪客');

  if (orderCount === 0 && (cartCount >= 2 || checkoutCount >= 1) && visitCount >= 2) tags.push('高互動未購買');
  if (orderCount === 0 && checkoutCount >= 1) tags.push('已開始結帳未購買');
  if (orderCount === 1) tags.push('首購客');
  if (orderCount >= 2) tags.push('回購客');
  if (highValueThreshold && totalRevenue >= highValueThreshold) tags.push('高價值顧客');
  if (daysSinceLastSeen !== null && daysSinceLastSeen > 60) tags.push('久未回訪顧客');

  return tags;
}

// ══════════════════════════════════════════════════════════════════
// 資料組裝：一次查詢整店範圍，批次組出「每一位訪客/會員」的列
// ══════════════════════════════════════════════════════════════════

function _buildLinkedVisitorMap(db, storeId) {
  // visitor_id -> line_user_id（決定性連結，見 utils/analyticsIdentity.js 規則 2）
  const rows = db.all(
    "SELECT DISTINCT line_user_id, visitor_id FROM line_member_sessions WHERE store_id=? AND visitor_id != ''",
    [storeId]
  );
  const map = {};
  rows.forEach((r) => { if (!map[r.visitor_id]) map[r.visitor_id] = r.line_user_id; });
  return map;
}

function _aggregateLineMemberEvents(db, storeId, lineMembers, visitorToUid) {
  const uidList = lineMembers.map((m) => m.line_user_id);
  const linkedVisitorIds = Object.keys(visitorToUid);
  if (!uidList.length) return {};

  const identityKeys = uidList.map((u) => `line_user:${u}`);
  const clauses = [`identity_key IN (${_inParams(identityKeys)})`];
  const params = [storeId, ...identityKeys];
  if (linkedVisitorIds.length) {
    clauses.push(`visitor_id IN (${_inParams(linkedVisitorIds)})`);
    params.push(...linkedVisitorIds);
  }

  const rows = db.all(
    `SELECT identity_key, visitor_id, session_id, cart_id, order_id, event_name,
            source, order_channel, order_mode, campaign, ${A_LOCAL} as created_at_local
     FROM analytics_events
     WHERE store_id=? AND (${clauses.join(' OR ')})`,
    params
  );

  const byUid = {};
  uidList.forEach((u) => { byUid[u] = []; });
  rows.forEach((r) => {
    let uid = null;
    if (r.identity_key && r.identity_key.startsWith('line_user:')) uid = r.identity_key.slice('line_user:'.length);
    else if (r.visitor_id && visitorToUid[r.visitor_id]) uid = visitorToUid[r.visitor_id];
    if (uid && byUid[uid]) byUid[uid].push(r);
  });
  return byUid;
}

function _summarizeEvents(events) {
  const sessions = new Set();
  const carts = new Set();
  const checkoutCarts = new Set();
  let firstAt = null, lastAt = null, lastEvt = null;
  events.forEach((e) => {
    if (e.session_id) sessions.add(e.session_id);
    if (e.event_name === 'add_to_cart' && e.cart_id) carts.add(e.cart_id);
    if (e.event_name === 'begin_checkout' && e.cart_id) checkoutCarts.add(e.cart_id);
    const t = e.created_at_local;
    if (t && (!firstAt || t < firstAt)) firstAt = t;
    if (t && (!lastAt || t > lastAt)) { lastAt = t; lastEvt = e; }
  });
  return {
    visit_count: sessions.size,
    cart_count: carts.size,
    checkout_count: checkoutCarts.size,
    first_visit_at: firstAt,
    last_visit_at: lastAt,
    recent_source: lastEvt ? (lastEvt.source || null) : null,
    recent_channel: lastEvt ? (lastEvt.order_channel || null) : null,
    recent_order_mode: lastEvt ? (lastEvt.order_mode || null) : null,
    recent_campaign: lastEvt ? (lastEvt.campaign || null) : null,
  };
}

function _friendStatusLabel(row) {
  if (!row) return { code: 'unknown', label: '好友狀態尚未確認' };
  const status = row.friend_status || (row.is_friend === 1 ? 'friend' : (row.is_friend === 0 ? 'not_friend' : 'unknown'));
  if (status === 'friend') return { code: 'friend', label: '已確認為 LINE 好友' };
  if (status === 'not_friend') return { code: 'not_friend', label: '已確認尚未加入好友' };
  return { code: 'unknown', label: '好友狀態尚未確認' };
}

/**
 * 主入口：組出整店範圍的訪客/會員清單（未分頁、未篩選前的完整資料），供
 * getVisitorAudienceList() 篩選/排序/分頁，也供 resolveVisitorAudienceMemberKeys()
 * 建立分群使用（兩者共用同一份資料組裝邏輯，不重複查詢兩次）。
 */
function buildAudienceUniverse(db, storeId) {
  const warnings = [];

  const lineMembers = db.all('SELECT * FROM line_members WHERE store_id=? ORDER BY id ASC', [storeId]);
  let lineMembersTruncated = false;
  let effectiveLineMembers = lineMembers;
  if (lineMembers.length > MAX_LINE_MEMBERS) {
    lineMembersTruncated = true;
    effectiveLineMembers = lineMembers.slice(0, MAX_LINE_MEMBERS);
    warnings.push(`LINE 會員數量超過上限（${MAX_LINE_MEMBERS}），列表可能不完整。`);
  }

  const visitorToUid = _buildLinkedVisitorMap(db, storeId);
  const linkedVisitorIdSet = new Set(Object.keys(visitorToUid));
  const eventsByUid = _aggregateLineMemberEvents(db, storeId, effectiveLineMembers, visitorToUid);

  const rows = [];

  effectiveLineMembers.forEach((m) => {
    const events = eventsByUid[m.line_user_id] || [];
    const summary = _summarizeEvents(events);
    const hasAnonymousHistory = events.some((e) => e.visitor_id && linkedVisitorIdSet.has(e.visitor_id) && visitorToUid[e.visitor_id] === m.line_user_id);
    const identity = hasAnonymousHistory ? 'anonymous_upgraded' : 'line_member';
    const friend = _friendStatusLabel(m);
    const orderCount = Number(m.order_count || 0);
    const totalRevenue = round2(m.total_spent || 0);
    const avgOrderValue = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;
    const lastSeenAt = m.last_seen_at || summary.last_visit_at || null;

    rows.push({
      member_key: m.line_user_id,
      canonical_key: m.line_user_id,
      display_key: maskLineUserId(m.line_user_id),
      member_type: 'line_user_id',
      identity,
      identity_label: identity === 'anonymous_upgraded' ? '已由匿名訪客升級為 LINE 會員' : 'LINE 會員',
      // 需求文件 D：識別信心與依據——決定性連結一律 confidence='high'，
      // evidence 標明是「直接 LINE 會員」還是「透過 line_member_sessions 決定性連結合併」。
      identity_confidence: 'high',
      identity_evidence: identity === 'anonymous_upgraded' ? 'visitor_session_link（決定性連結：cart_id/session_id 對應到已驗證的 LINE 登入）' : 'direct_line_member（本人直接以 LINE 登入建立會員資料）',
      display_name: m.display_name || null,
      line_uid_masked: maskLineUserId(m.line_user_id),
      friend_status: friend.code,
      friend_status_label: friend.label,
      last_friend_check_at: m.last_friend_check_at || m.last_friend_check || null,
      first_visit_at: m.first_seen_at || summary.first_visit_at || null,
      last_seen_at: lastSeenAt,
      visit_count: summary.visit_count,
      session_count: summary.visit_count,
      cart_count: summary.cart_count,
      checkout_count: summary.checkout_count,
      order_count: orderCount,
      total_revenue: totalRevenue,
      avg_order_value: avgOrderValue,
      last_purchase_at: m.last_order_at || null,
      recent_source: summary.recent_source,
      recent_channel: summary.recent_channel,
      recent_order_mode: summary.recent_order_mode,
      recent_campaign: summary.recent_campaign,
    });
  });

  // ── 匿名訪客（從未與 LINE 會員建立可靠連結）─────────────────────
  const linkedIdsForExclusion = [...linkedVisitorIdSet];
  let anonWhere = "store_id=? AND visitor_id IS NOT NULL AND visitor_id != ''";
  const anonParams = [storeId];
  if (linkedIdsForExclusion.length) {
    anonWhere += ` AND visitor_id NOT IN (${_inParams(linkedIdsForExclusion)})`;
    anonParams.push(...linkedIdsForExclusion);
  }
  // 同時排除本身就是 line_user_id 的 visitor_id（理論上不會發生，防禦性處理）
  const lineUidSet = new Set(lineMembers.map((m) => m.line_user_id));

  const anonAgg = db.all(
    `SELECT visitor_id,
            COUNT(DISTINCT session_id) as visit_count,
            COUNT(DISTINCT CASE WHEN event_name='add_to_cart' THEN cart_id END) as cart_count,
            COUNT(DISTINCT CASE WHEN event_name='begin_checkout' THEN cart_id END) as checkout_count,
            COUNT(DISTINCT CASE WHEN event_name='purchase' THEN order_id END) as order_count,
            MIN(${A_LOCAL}) as first_visit_at,
            MAX(${A_LOCAL}) as last_visit_at,
            SUM(CASE WHEN identity_type IS NULL THEN 1 ELSE 0 END) as legacy_event_count,
            COUNT(*) as total_event_count
     FROM analytics_events
     WHERE ${anonWhere}
     GROUP BY visitor_id
     ORDER BY last_visit_at DESC
     LIMIT ${MAX_ANONYMOUS_VISITORS + 1}`,
    anonParams
  ).filter((r) => !lineUidSet.has(r.visitor_id));

  let anonTruncated = false;
  let effectiveAnon = anonAgg;
  if (anonAgg.length > MAX_ANONYMOUS_VISITORS) {
    anonTruncated = true;
    effectiveAnon = anonAgg.slice(0, MAX_ANONYMOUS_VISITORS);
    warnings.push(`匿名訪客數量超過上限（${MAX_ANONYMOUS_VISITORS}），列表可能不完整，建議加上篩選條件縮小範圍。`);
  }

  // 最後一筆事件的 source/channel/order_mode/campaign（單獨批次查詢，避免上面
  // GROUP BY 聚合查詢混雜多筆事件的欄位值）
  const anonVisitorIds = effectiveAnon.map((r) => r.visitor_id);
  let lastTouchMap = {};
  if (anonVisitorIds.length) {
    const lastRows = db.all(
      `SELECT ae.visitor_id, ae.source, ae.order_channel, ae.order_mode, ae.campaign
       FROM analytics_events ae
       INNER JOIN (
         SELECT visitor_id, MAX(${A_LOCAL}) as max_created
         FROM analytics_events WHERE store_id=? AND visitor_id IN (${_inParams(anonVisitorIds)})
         GROUP BY visitor_id
       ) latest ON latest.visitor_id=ae.visitor_id AND latest.max_created=${A_LOCAL.replace('created_at', 'ae.created_at')}
       WHERE ae.store_id=?`,
      [storeId, ...anonVisitorIds, storeId]
    );
    lastRows.forEach((r) => { lastTouchMap[r.visitor_id] = r; });
  }

  // 訂單金額：purchase 事件 -> order_id -> orders 表金額（批次查詢，不逐筆）
  let orderRevenueByVisitor = {};
  if (anonVisitorIds.length) {
    const purchaseRows = db.all(
      `SELECT visitor_id, order_id FROM analytics_events
       WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL
         AND visitor_id IN (${_inParams(anonVisitorIds)})`,
      [storeId, ...anonVisitorIds]
    );
    const orderIds = [...new Set(purchaseRows.map((r) => r.order_id))];
    let orderTotals = {};
    if (orderIds.length) {
      db.all(`SELECT uuid, id, total, status, created_at FROM orders WHERE store_id=? AND (uuid IN (${_inParams(orderIds)}) OR id IN (${_inParams(orderIds)}))`,
        [storeId, ...orderIds, ...orderIds])
        .forEach((o) => {
          if (o.status === 'voided' || o.status === 'cancelled') return;
          orderTotals[o.uuid || o.id] = { total: Number(o.total || 0), created_at: o.created_at };
        });
    }
    purchaseRows.forEach((r) => {
      const info = orderTotals[r.order_id];
      if (!info) return;
      if (!orderRevenueByVisitor[r.visitor_id]) orderRevenueByVisitor[r.visitor_id] = { total: 0, count: 0, lastAt: null };
      orderRevenueByVisitor[r.visitor_id].total += info.total;
      orderRevenueByVisitor[r.visitor_id].count += 1;
      if (!orderRevenueByVisitor[r.visitor_id].lastAt || info.created_at > orderRevenueByVisitor[r.visitor_id].lastAt) {
        orderRevenueByVisitor[r.visitor_id].lastAt = info.created_at;
      }
    });
  }

  effectiveAnon.forEach((r) => {
    const isLegacy = Number(r.total_event_count || 0) > 0 && Number(r.legacy_event_count || 0) === Number(r.total_event_count || 0);
    const orderInfo = orderRevenueByVisitor[r.visitor_id] || { total: 0, count: 0, lastAt: null };
    const orderCount = Number(r.order_count || 0);
    const totalRevenue = round2(orderInfo.total);
    const avgOrderValue = orderCount > 0 ? round2(totalRevenue / orderCount) : 0;
    const lastTouch = lastTouchMap[r.visitor_id] || {};

    rows.push({
      member_key: r.visitor_id,
      canonical_key: r.visitor_id,
      display_key: shortDisplayKey(r.visitor_id),
      member_type: 'visitor_id',
      identity: isLegacy ? 'unresolved' : 'anonymous',
      identity_label: isLegacy ? '身份尚未解析' : '僅匿名訪客',
      identity_confidence: isLegacy ? 'unknown' : 'unresolved',
      identity_evidence: isLegacy ? '舊資料缺少身份標記欄位，無法判斷' : 'anonymous_no_link（未查得任何決定性 LINE 連結證據）',
      display_name: null,
      line_uid_masked: null,
      friend_status: null,
      friend_status_label: '匿名訪客尚未與 LINE 身份建立可靠關聯',
      last_friend_check_at: null,
      first_visit_at: r.first_visit_at,
      last_seen_at: r.last_visit_at,
      visit_count: Number(r.visit_count || 0),
      session_count: Number(r.visit_count || 0),
      cart_count: Number(r.cart_count || 0),
      checkout_count: Number(r.checkout_count || 0),
      order_count: orderCount,
      total_revenue: totalRevenue,
      avg_order_value: avgOrderValue,
      last_purchase_at: orderInfo.lastAt || null,
      recent_source: lastTouch.source || null,
      recent_channel: lastTouch.order_channel || null,
      recent_order_mode: lastTouch.order_mode || null,
      recent_campaign: lastTouch.campaign || null,
    });
  });

  return {
    rows,
    warnings,
    truncated: lineMembersTruncated || anonTruncated,
    generated_at: new Date().toISOString(),
  };
}

// 高價值顧客門檻：以目前全店消費金額排序，取前 20%（純規則，沿用
// utils/analyticsV2.js getCrmOverview() VIP 門檻同一套「前 20%」概念，避免兩套定義）
function _computeHighValueThreshold(rows) {
  const spendSorted = rows.map((r) => r.total_revenue).filter((v) => v > 0).sort((a, b) => b - a);
  if (!spendSorted.length) return Infinity;
  const vipCount = Math.max(1, Math.ceil(spendSorted.length * 0.2));
  return spendSorted[vipCount - 1];
}

function _matchesFilters(row, f, highValueThreshold) {
  if (f.identity !== 'all' && row.identity !== f.identity) return false;
  if (f.friend_status !== 'all' && row.friend_status !== f.friend_status) return false;

  if (f.visit_frequency !== 'all') {
    const vc = row.visit_count;
    if (f.visit_frequency === 'first_time' && vc > 1) return false;
    if (f.visit_frequency === '2plus' && vc < 2) return false;
    if (f.visit_frequency === '3plus' && vc < 3) return false;
    if (f.visit_frequency === 'high' && vc < HIGH_REVISIT_VISIT_COUNT) return false;
  }

  if (f.purchase_behavior !== 'all') {
    const oc = row.order_count, cc = row.cart_count, chk = row.checkout_count;
    if (f.purchase_behavior === 'never_purchased' && oc > 0) return false;
    if (f.purchase_behavior === 'has_purchased' && oc === 0) return false;
    if (f.purchase_behavior === 'repeat' && oc < 2) return false;
    if (f.purchase_behavior === '2plus_orders' && oc < 2) return false;
    if (f.purchase_behavior === 'cart_no_order' && !(cc > 0 && oc === 0)) return false;
    if (f.purchase_behavior === 'multi_cart_no_purchase' && !(cc >= 2 && oc === 0)) return false;
    if (f.purchase_behavior === 'checkout_no_purchase' && !(chk > 0 && oc === 0)) return false;
  }

  if (f.activity !== 'all') {
    const lastSeen = row.last_seen_at;
    const days = lastSeen ? (Date.now() - new Date(String(lastSeen).replace(' ', 'T') + 'Z').getTime()) / 86400000 : Infinity;
    if (f.activity === 'last_24h' && !(days <= 1)) return false;
    if (f.activity === 'last_7d' && !(days <= 7)) return false;
    if (f.activity === 'last_30d' && !(days <= 30)) return false;
    if (f.activity === 'inactive_30d' && !(days > 30)) return false;
    if (f.activity === 'inactive_60d' && !(days > 60)) return false;
    if (f.activity === 'inactive_90d' && !(days > 90)) return false;
  }

  if (f.min_visit_count !== undefined && row.visit_count < f.min_visit_count) return false;
  if (f.max_visit_count !== undefined && row.visit_count > f.max_visit_count) return false;
  if (f.min_cart_count !== undefined && row.cart_count < f.min_cart_count) return false;
  if (f.max_cart_count !== undefined && row.cart_count > f.max_cart_count) return false;
  if (f.min_order_count !== undefined && row.order_count < f.min_order_count) return false;
  if (f.max_order_count !== undefined && row.order_count > f.max_order_count) return false;
  if (f.min_revenue !== undefined && row.total_revenue < f.min_revenue) return false;
  if (f.max_revenue !== undefined && row.total_revenue > f.max_revenue) return false;
  if (f.min_aov !== undefined && row.avg_order_value < f.min_aov) return false;
  if (f.max_aov !== undefined && row.avg_order_value > f.max_aov) return false;

  if (f.source !== undefined && row.recent_source !== f.source) return false;
  if (f.campaign !== undefined && row.recent_campaign !== f.campaign) return false;
  if (f.channel !== undefined && row.recent_channel !== f.channel) return false;
  if (f.order_mode !== undefined && row.recent_order_mode !== f.order_mode) return false;

  if (f.min_revisit_score !== undefined && row._revisit_score < f.min_revisit_score) return false;
  if (f.max_revisit_score !== undefined && row._revisit_score > f.max_revisit_score) return false;

  return true;
}

function _applySort(rows, sortBy, sortDir) {
  const field = SORT_FIELD_MAP[sortBy] || SORT_FIELD_MAP[DEFAULT_SORT];
  const dir = sortDir === 'asc' ? 'asc' : 'desc';
  const mul = dir === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    let av = field === 'revisit_score' ? a._revisit_score : a[field];
    let bv = field === 'revisit_score' ? b._revisit_score : b[field];
    let cmp;
    if (av === null || av === undefined) cmp = (bv === null || bv === undefined) ? 0 : 1;
    else if (bv === null || bv === undefined) cmp = -1;
    else if (typeof av === 'number' || typeof bv === 'number') cmp = (Number(av) - Number(bv)) * mul;
    else cmp = String(av).localeCompare(String(bv)) * mul;
    // 需求文件 D.10：穩定排序 tie-breaker——當主要排序欄位相同時（例如多個訪客
    // revisit_score 都是 0），一律用 canonical_key 字母順序當次要排序鍵，確保
    // 分頁在同一份資料上多次查詢時，順序完全一致（不依賴不保證穩定的底層排序）。
    if (cmp === 0) cmp = String(a.canonical_key || '').localeCompare(String(b.canonical_key || ''));
    return cmp;
  });
}

/**
 * Visitor 360 Audience 主入口——分頁、篩選、排序後的清單（需求文件 G/H）。
 */
function getVisitorAudienceList(db, storeId, rawFilters = {}, opts = {}) {
  const filters = _sanitizeFilters(rawFilters);
  const universe = buildAudienceUniverse(db, storeId);
  const highValueThreshold = _computeHighValueThreshold(universe.rows);

  // 附加回訪分數與顧客狀態標籤（每一列都要，篩選/排序需要用到分數）
  const enriched = universe.rows.map((row) => {
    const scoreInfo = computeRevisitScore({
      visitCount: row.visit_count, cartCount: row.cart_count,
      checkoutCount: row.checkout_count, orderCount: row.order_count,
      lastSeenAt: row.last_seen_at,
    });
    const tags = deriveCustomerStatusTags({
      identity: row.identity, visitCount: row.visit_count, cartCount: row.cart_count,
      checkoutCount: row.checkout_count, orderCount: row.order_count,
      totalRevenue: row.total_revenue, lastSeenAt: row.last_seen_at,
      highValueThreshold,
    });
    return {
      ...row,
      _revisit_score: scoreInfo.score,
      revisit_score: scoreInfo.score,
      revisit_score_breakdown: scoreInfo.explanation, // 需求文件 D/E：逐項加總必須等於 revisit_score
      revisit_score_disclaimer: scoreInfo.disclaimer,
      average_order_value: row.avg_order_value, // 需求文件 D 命名別名，與既有 avg_order_value 並存
      customer_status_tags: tags,
    };
  });

  let rows = enriched.filter((r) => _matchesFilters(r, filters, highValueThreshold));
  rows = _applySort(rows, opts.sort_by, opts.sort_dir);

  const total = rows.length;
  // 需求文件 G：對外的分頁 API 一律限制每頁最多 100 筆（沿用 utils/drilldown.js
  // 同一個上限慣例）。但分群快照（resolveVisitorAudienceMemberKeys）需要取得
  // 「全部符合條件的人」，不是一頁——這裡用 opts._internal_uncapped 讓內部呼叫端
  // （同一個檔案內）跳過 100 上限，公開路由 routes/analytics.js 一律不會設這個旗標，
  // 對外分頁行為完全不受影響。
  const limit = opts._internal_uncapped
    ? Math.min(2000, Math.max(1, Math.trunc(Number(opts.limit) || 20)))
    : Math.min(100, Math.max(1, Math.trunc(Number(opts.limit) || 20)));
  const page = Math.max(1, Math.trunc(Number(opts.page) || 1));
  const start = (page - 1) * limit;
  const pageRows = rows.slice(start, start + limit).map((r) => {
    const { _revisit_score, ...pub } = r;
    return pub;
  });

  return {
    rows: pageRows,
    total,
    page,
    limit,
    total_pages: Math.max(1, Math.ceil(total / limit)),
    filters,
    warnings: universe.warnings,
    generated_at: universe.generated_at,
    high_value_threshold: highValueThreshold === Infinity ? null : highValueThreshold,
  };
}

// ══════════════════════════════════════════════════════════════════
// CRM 分群整合（需求文件 K）——沿用既有 utils/drilldown.js resolveMemberKeys()
// 的輸出格式（member_key/member_type/display_name），讓 routes/crm.js 既有的
// 靜態分群快照邏輯可以直接吃這裡的結果，不用重寫一套分群儲存邏輯。
// ══════════════════════════════════════════════════════════════════
function resolveVisitorAudienceMemberKeys(db, storeId, rawFilters = {}, { limit = 2000 } = {}) {
  // 分群快照需要「全部符合條件」的人，不是分頁後的一頁，這裡用 _internal_uncapped
  // 跳過對外 API 的 100 筆分頁上限。
  const full = getVisitorAudienceList(db, storeId, rawFilters, { page: 1, limit: 2000, _internal_uncapped: true });
  return full.rows.slice(0, limit).map((r) => ({
    member_key: r.canonical_key,
    member_type: r.member_type,
    display_name: r.display_name,
    total: r.total_revenue,
    last_activity_at: r.last_seen_at,
  }));
}

function countVisitorAudienceMatches(db, storeId, rawFilters = {}) {
  // 需求文件 M：支援 count-only 查詢（分群預覽人數不用組完整列）。目前實作仍會
  // 組出完整列才計數（與 utils/drilldown.js countDrilldownMatches 在有衍生欄位
  // 篩選時的行為一致），但 total 是「篩選後、分頁前」的真實總數，不受分頁上限影響。
  const result = getVisitorAudienceList(db, storeId, rawFilters, { page: 1, limit: 1, _internal_uncapped: true });
  return result.total;
}

module.exports = {
  IDENTITY_FILTERS,
  FRIEND_FILTERS,
  VISIT_FREQ_FILTERS,
  PURCHASE_BEHAVIOR_FILTERS,
  ACTIVITY_FILTERS,
  SORT_FIELD_MAP,
  MAX_LINE_MEMBERS,
  MAX_ANONYMOUS_VISITORS,
  computeRevisitScore,
  deriveCustomerStatusTags,
  buildAudienceUniverse,
  getVisitorAudienceList,
  resolveVisitorAudienceMemberKeys,
  countVisitorAudienceMatches,
};
