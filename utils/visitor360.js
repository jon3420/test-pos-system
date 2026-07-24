// utils/visitor360.js — fix18-10-hotfix31-R2「Visitor 360（會員360）」
// （R1 版本已重寫：改用共用的 utils/analyticsIdentity.js 身份解析，不再自行
// 定義一套獨立的 resolveIdentity——避免「第二套競爭身份系統」問題）
//
// 目的（需求文件六）：點任何會員／訪客，展開完整旅程——第一次來店的來源、
// 第二次、第三次…直到完成購買，加上累積消費／訂單數／平均客單／最近一次。
//
// 架構原則（本次硬化重點）：
//   - Visitor 360 永遠是「即時運算的檢視」，不建立任何持久化資料表儲存
//     計算結果。每次呼叫都重新查詢 analytics_events／line_members／orders，
//     資料異動後下一次呼叫立刻反映最新狀態。
//   - 身份合併規則唯一入口是 utils/analyticsIdentity.js 的
//     resolveCanonicalVisitor()，本模組不自行判斷「這是不是同一人」。
//   - LTV／訂單數對 LINE 會員一律直接讀 line_members（既有欄位，由
//     utils/lineMemberStats.js 在訂單真正成立時維護），不重新加總計算，
//     避免兩套算法算出不同數字。匿名訪客沒有 line_members 資料時，才退回
//     用 orders 表（既有正式訂單資料表）加總，且只在有 purchase 事件可
//     對應到 order_id 時才這麼做——不臆測。
//   - 找不到可靠連結時，identity 保持未解析狀態（confidence='unresolved'），
//     不強行合併，並在回應中明確標示。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
const { resolveCanonicalVisitor } = require('./analyticsIdentity');
const { buildRowsForCartIds } = require('./drilldown');
let maskLineUserId;
try {
  ({ maskLineUserId } = require('./lineMemberStats'));
} catch (e) {
  maskLineUserId = (id) => { const s = String(id || ''); return s.length <= 8 ? (s ? s[0] + '****' : '') : s.slice(0, 5) + '****' + s.slice(-4); };
}

function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }

const MAX_JOURNEY_EVENTS = 2000; // 單一訪客/會員事件量上限，避免極端長尾帳號拖垮查詢
const MAX_CART_HISTORY = 50;
const MAX_ORDER_HISTORY = 50;

function getEventsForIdentity(db, storeId, identity) {
  const clauses = [];
  const params = [storeId];
  if (identity.canonical_type === 'line_user_id') {
    clauses.push('identity_key=?');
    params.push(`line_user:${identity.line_user_id}`);
  }
  const visitorIds = identity.linked_visitor_ids || [];
  if (visitorIds.length) {
    clauses.push(`visitor_id IN (${visitorIds.map(() => '?').join(',')})`);
    params.push(...visitorIds);
  }
  if (!clauses.length) return [];
  return db.all(
    `SELECT event_name, source, campaign, medium, referrer, session_id, cart_id, order_id, product_id,
            ${A_LOCAL} as created_at_local
     FROM analytics_events
     WHERE store_id=? AND (${clauses.join(' OR ')})
     ORDER BY id ASC
     LIMIT ${MAX_JOURNEY_EVENTS}`,
    params
  );
}

/**
 * 把事件流水帳分組成「第幾次來訪」的旅程列表——每個 session_id 第一次出現的
 * 事件即代表那一次來訪的來源/入口，符合需求文件六的「第一次…第二次…第三次…」
 * 範例格式。
 */
function buildJourney(events) {
  const seen = new Set();
  const journey = [];
  events.forEach((e) => {
    const sid = e.session_id || null;
    const key = sid || `_no_session_${e.created_at_local}_${e.event_name}`;
    if (seen.has(key)) return;
    seen.add(key);
    journey.push({
      session_id: sid,
      source: e.source || 'Direct',
      campaign: e.campaign || null,
      medium: e.medium || null,
      first_event: e.event_name,
      first_seen_at: e.created_at_local,
    });
  });
  journey.sort((a, b) => (a.first_seen_at || '').localeCompare(b.first_seen_at || ''));
  return journey.map((j, idx) => ({ visit_number: idx + 1, ...j }));
}

/**
 * fix18-10-hotfix31-R4（需求文件 E：Customer Journey）
 *
 * 把低階事件流水帳（raw timeline，仍完整保留、不刪除）轉換成「有business意義的
 * 里程碑」摘要，供 Visitor 360 detail 顯示在 Session Timeline 之上。
 *
 * 原則：
 *   - 完全 runtime 運算，不建立 customer_journey 資料表、不持久化。
 *   - 只用既有資料組裝（analytics_events／orders／line_members／
 *     line_member_sessions／utils/analyticsIdentity.js 的身份解析結果），
 *     不新增第二套事件定義。
 *   - 每個里程碑一律標示 inferred:true/false——inferred=false 代表直接對應
 *     某一筆真實事件（1:1），inferred=true 代表由多筆同類事件「合併」而成
 *     （例如同一次來訪裡連續瀏覽 3 個商品，合併成一則「商品瀏覽」）。
 *   - 目前沒有優惠券相關的 analytics 事件或欄位可查（見 CHANGELOG 已知限制），
 *     因此不產生「套用優惠券」里程碑——沒有真實資料就不假裝有這個里程碑
 *     （需求文件 E.12：Do not invent missing milestones）。
 *   - 時間一律使用事件既有的 Asia/Taipei 本地時間字串（created_at_local），
 *     不重新計算時區、不竄改原始時間戳。
 */
function _daysBetween(aLocal, bLocal) {
  if (!aLocal || !bLocal) return null;
  const a = new Date(String(aLocal).replace(' ', 'T'));
  const b = new Date(String(bLocal).replace(' ', 'T'));
  const diff = (b - a) / 86400000;
  return Number.isFinite(diff) ? diff : null;
}
function _revisitLabel(daysGap) {
  if (daysGap === null) return '再次來訪';
  if (daysGap < 1) return '同日再次來訪';
  if (daysGap < 2) return '隔日再次來訪';
  const d = Math.round(daysGap);
  return `${d} 天後回訪`;
}

function buildCustomerJourney(events, { lineRow, identity } = {}) {
  const milestones = [];
  const push = (type, label, at, inferred, extra = {}) => {
    milestones.push({ type, label, at: at || null, inferred: !!inferred, ...extra });
  };

  let sessionSeen = new Set();
  let lastSessionId = undefined;
  let firstVisitDone = false;
  let prevEventAt = null; // 前一筆事件的時間，用來算「距離上次來訪幾天」
  let pendingGroup = null; // { type, label, count, firstAt }
  let purchaseCount = 0;
  let anyCartMilestoneEver = false;
  let loginMilestoneEmitted = false;
  let upgradeMilestoneEmitted = false;

  function flushGroup() {
    if (!pendingGroup) return;
    const label = pendingGroup.count > 1 ? `${pendingGroup.label}（${pendingGroup.count} 次）` : pendingGroup.label;
    push(pendingGroup.type, label, pendingGroup.firstAt, pendingGroup.count > 1, { event_count: pendingGroup.count });
    pendingGroup = null;
  }
  function addToGroup(type, label, at) {
    if (pendingGroup && pendingGroup.type === type) { pendingGroup.count += 1; return; }
    flushGroup();
    pendingGroup = { type, label, count: 1, firstAt: at };
  }

  events.forEach((e) => {
    const sid = e.session_id || null;
    const isNewSession = sid && sid !== lastSessionId && !sessionSeen.has(sid);
    if (isNewSession) {
      sessionSeen.add(sid);
      flushGroup();
      if (!firstVisitDone) {
        firstVisitDone = true;
        push('first_visit', `${e.source || 'Direct'} 首次來訪`, e.created_at_local, false);
      } else {
        const gap = _daysBetween(prevEventAt, e.created_at_local);
        push('revisit', `${_revisitLabel(gap)}（${e.source || 'Direct'}）`, e.created_at_local, true, { days_since_previous: gap });
      }
    }
    lastSessionId = sid || lastSessionId;
    prevEventAt = e.created_at_local || prevEventAt;

    switch (e.event_name) {
      case 'view_product':
        addToGroup('product_view', '商品瀏覽', e.created_at_local);
        break;
      case 'add_to_cart':
        addToGroup('add_to_cart', anyCartMilestoneEver ? '再次加入購物車' : '加入購物車', e.created_at_local);
        anyCartMilestoneEver = true;
        break;
      case 'begin_checkout':
        flushGroup();
        push('begin_checkout', '開始結帳', e.created_at_local, false);
        break;
      case 'line_login_success':
      case 'member_login':
        if (!loginMilestoneEmitted) {
          flushGroup();
          push('line_login', 'LINE Login', e.created_at_local, false);
          loginMilestoneEmitted = true;
        }
        break;
      case 'friend_added':
        flushGroup();
        push('friend_added', '加入 LINE 好友', e.created_at_local, false);
        break;
      case 'purchase':
        flushGroup();
        purchaseCount += 1;
        push(purchaseCount === 1 ? 'first_purchase' : 'repeat_purchase',
          purchaseCount === 1 ? '完成首購' : '完成回購', e.created_at_local, false, { order_id: e.order_id || null });
        break;
      default:
        break;
    }
  });
  flushGroup();

  // 匿名訪客升級為 LINE 會員：不是一筆單一事件，是「身份解析結果」本身
  // （utils/analyticsIdentity.js resolveCanonicalVisitor 的 resolution_method）。
  // 插入時間點：找不到更精準的時間就用第一筆「已知歸屬這位 LINE 會員」事件的時間。
  if (identity && identity.canonical_type === 'line_user_id' && identity.resolution_method === 'visitor_session_link' && !upgradeMilestoneEmitted) {
    const firstLineEvt = events.find((e) => e.event_name && e.event_name !== 'purchase') || events[0];
    milestones.push({
      type: 'anonymous_upgraded', label: '匿名訪客升級為 LINE 會員',
      at: (firstLineEvt && firstLineEvt.created_at_local) || null,
      inferred: true, // 這是由身份解析結果推導出的里程碑，不是單一事件
    });
    upgradeMilestoneEmitted = true;
  }

  // 加入 LINE 好友：如果事件流水帳裡沒有 friend_added 事件，但 line_members 有
  // friend_since，仍然揭露這個真實已知的里程碑（來自既有 friend tracking 基礎設施）。
  if (lineRow && lineRow.friend_since && !milestones.some((m) => m.type === 'friend_added')) {
    milestones.push({ type: 'friend_added', label: '加入 LINE 好友', at: lineRow.friend_since, inferred: false });
  }

  // 依時間排序（大部分本來就是照事件順序，身份升級/好友補充可能是事後插入的，統一排序一次）
  milestones.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));

  // 最近活動：最後一筆事件本身（即使跟上面某個里程碑重複，這裡是明確標示「目前狀態」用）
  if (events.length) {
    const last = events[events.length - 1];
    milestones.push({ type: 'recent_activity', label: '最近活動', at: last.created_at_local, inferred: false, event_name: last.event_name });
  }

  return milestones;
}

/**
 * 訂單/購買歷程——直接讀既有 orders 表（正式訂單資料，不重新計算），
 * 只用 analytics_events 的 purchase 事件找出這個人的 order_id 清單，
 * 再用 store_id + order_id 去 orders 表查真正的訂單金額/時間/狀態。
 */
function getPurchaseHistory(db, storeId, orderIds) {
  if (!orderIds.length) return { orders: [], total_revenue: 0 };
  const placeholders = orderIds.map(() => '?').join(',');
  const rows = db.all(
    `SELECT id, order_number, total, status, created_at
     FROM orders WHERE store_id=? AND id IN (${placeholders})
     ORDER BY created_at DESC LIMIT ${MAX_ORDER_HISTORY}`,
    [storeId, ...orderIds]
  );
  const valid = rows.filter((r) => r.status !== 'voided' && r.status !== 'cancelled');
  const totalRevenue = valid.reduce((s, r) => s + Number(r.total || 0), 0);
  return { orders: rows, total_revenue: round2(totalRevenue) };
}

/**
 * 購物車歷程——重用 utils/drilldown.js 的批次列組裝邏輯（同一份程式碼，
 * 不是另外重寫一份購物車金額估算），只是候選 cart_id 來源換成「這個人
 * 名下所有 cart_id」而不是「符合某個篩選條件的 cart_id」。
 */
function getCartHistory(db, storeId, cartIds) {
  if (!cartIds.length) return [];
  const rows = buildRowsForCartIds(db, storeId, cartIds.slice(0, MAX_CART_HISTORY), { includePurchased: true });
  return rows
    .sort((a, b) => (b.last_activity_at || '').localeCompare(a.last_activity_at || ''))
    .map((r) => {
      const { _age_bucket, _line_uid_raw, _visitor_id_raw, ...pub } = r;
      return pub;
    });
}

/**
 * Visitor 360 主入口。回傳 null 代表查無此人（既非已知 LINE 會員，也沒有任何
 * analytics_events 紀錄、也查不到任何連結）——呼叫端應回 404，不得臆測。
 *
 * @param {object} db
 * @param {string} storeId 一律來自已驗證的 req.storeId，呼叫端不得另外傳入
 *                 未經驗證的 store_id（見 routes/analytics.js）。
 * @param {string} key 可以是 line_user_id / visitor_id / session_id / cart_id，
 *                 呼叫端不需要事先知道是哪一種。
 */
function getVisitorProfile(db, storeId, key, { includeFullUid = false } = {}) {
  if (!db || !storeId || !key) return null;

  const identity = resolveCanonicalVisitor(db, storeId, key);
  if (!identity.found) return null;

  const events = getEventsForIdentity(db, storeId, identity);

  let lineRow = null;
  if (identity.canonical_type === 'line_user_id') {
    lineRow = db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, identity.line_user_id]);
  }
  if (!events.length && !lineRow) return null;

  const journey = buildJourney(events);
  const purchaseEvents = events.filter((e) => e.event_name === 'purchase');
  const orderIds = [...new Set(purchaseEvents.map((e) => e.order_id).filter(Boolean))];
  const cartIds = [...new Set(events.map((e) => e.cart_id).filter(Boolean))];
  const anonymousVisitorIds = [...new Set(events.map((e) => e.visitor_id).filter(Boolean))];

  const cartHistory = getCartHistory(db, storeId, cartIds);

  // LTV：LINE 會員一律直接讀 line_members（既有正式欄位，唯一算法來源）。
  // 匿名訪客沒有 line_members 資料時，才退回用 orders 表（既有正式訂單表）
  // 依 purchase 事件對應到的 order_id 加總——不是重新發明一套計算方式，
  // 只是換一個既有資料表當來源，且只在真的有 order_id 可對應時才計算。
  let ltv = null;
  let purchaseHistory = { orders: [], total_revenue: 0 };
  if (lineRow) {
    const orderCount = Number(lineRow.order_count || 0);
    ltv = {
      total_spent: round2(lineRow.total_spent),
      order_count: orderCount,
      avg_order_value: orderCount > 0 ? round2(Number(lineRow.total_spent || 0) / orderCount) : 0,
      first_order_at: lineRow.first_order_at || null,
      last_order_at: lineRow.last_order_at || null,
      source: 'line_members', // 明確標示這個數字的來源表，供稽核
    };
    purchaseHistory = getPurchaseHistory(db, storeId, orderIds);
  } else if (orderIds.length) {
    purchaseHistory = getPurchaseHistory(db, storeId, orderIds);
    const orderCount = purchaseHistory.orders.length;
    ltv = {
      total_spent: purchaseHistory.total_revenue,
      order_count: orderCount,
      avg_order_value: orderCount > 0 ? round2(purchaseHistory.total_revenue / orderCount) : 0,
      first_order_at: orderCount ? purchaseHistory.orders[orderCount - 1].created_at : null,
      last_order_at: orderCount ? purchaseHistory.orders[0].created_at : null,
      source: 'orders', // 匿名訪客：退回用 orders 表加總，明確標示與 line_members 不同來源
    };
  }

  const lineUidRaw = lineRow ? lineRow.line_user_id : null;

  return {
    member_key: key,
    canonical_identity: {
      // 需求文件 D.7：回傳身份解析的信心程度與依據，不隱藏合併邏輯
      type: identity.canonical_type,
      resolution_method: identity.resolution_method,
      confidence: identity.confidence,
    },
    identity_type: identity.canonical_type === 'line_user_id' ? 'line' : 'visitor',
    display_name: lineRow ? (lineRow.display_name || null) : null,
    line_uid_masked: lineUidRaw ? maskLineUserId(lineUidRaw) : null,
    line_uid_full: includeFullUid ? lineUidRaw : undefined,
    is_friend: lineRow ? !!lineRow.is_friend : null,
    friend_status: lineRow ? (lineRow.friend_status || 'unknown') : null,
    anonymous_visitor_ids: anonymousVisitorIds, // 需求文件 B：匿名訪客識別碼清單
    linked_visitor_count: (identity.linked_visitor_ids || []).length,
    first_seen_at: journey.length ? journey[0].first_seen_at : (lineRow ? lineRow.first_seen_at : null),
    last_seen_at: lineRow ? (lineRow.last_seen_at || null) : (journey.length ? journey[journey.length - 1].first_seen_at : null),
    total_visits: journey.length,
    journey,
    // fix18-10-hotfix31-R4（需求文件 E：Customer Journey）——raw_timeline 是完整保留
    // 的低階事件流水帳（Session Timeline 的資料來源，不刪除、不取代），customer_journey
    // 是在它之上組出的「有business意義的里程碑」摘要，供 Visitor 360 detail 優先顯示。
    raw_timeline: events.map((e) => ({
      event_name: e.event_name, source: e.source || null, campaign: e.campaign || null,
      medium: e.medium || null, session_id: e.session_id || null, cart_id: e.cart_id || null,
      order_id: e.order_id || null, product_id: e.product_id || null, at: e.created_at_local,
    })),
    customer_journey: buildCustomerJourney(events, { lineRow, identity }),
    cart_history: cartHistory,
    purchase_history: purchaseHistory.orders,
    ltv,
    purchase_count: purchaseEvents.length,
    linked_order_ids: orderIds.slice(0, 20),
    data_generated_at: new Date().toISOString(), // 明確標示這是即時運算的檢視，不是持久化結果
  };
}

module.exports = {
  getVisitorProfile,
  buildJourney,
  buildCustomerJourney,
};
