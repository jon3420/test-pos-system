// utils/analyticsHealth.js — fix18-10-hotfix24-A1｜Tracking Health × Funnel Validation
//
// 純診斷用途，全部是唯讀查詢，不新增資料表、不修改任何寫入邏輯。
// 掛在既有 routes/analytics.js router 底下的 GET /api/analytics/health，
// 不是另一套 Analytics API——只是同一個 router 多一支唯讀端點，方便店家與
// 開發者確認「沒有訂單」跟「Tracking 壞掉」是兩件事。

'use strict';

const { round2, ORDERS_BASE_WHERE, ORDERS_PAID_EXPR } = require('./dashboardAnalytics');
const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL, resolveDateRange } = require('./dashboardDate');
// fix18-10-hotfix24-A3（需求文件八／十六）：Identity Resolver × Channel／Page Type Resolver
const { summarizeIdentityBasis, identityBasisLabel } = require('./analyticsIdentity');
const { ORDER_CHANNELS, ORDER_CHANNEL_LABELS } = require('./channelResolver');

const STALE_THRESHOLD_MINUTES = 30; // 第二部分：超過 30 分鐘沒有事件 → 顯示 Tracking 已停止
const FUNNEL_DIFF_TOLERANCE_PCT = 1; // 第四部分：Analytics purchase 與 orders 差異超過 ±1% → 警告

const TRACKED_EVENT_NAMES = ['page_view', 'view_product', 'add_to_cart', 'begin_checkout', 'purchase'];

// ── 第二部分：Analytics Health（最後事件時間／近5分鐘事件數／今日各事件總數）──
// fix18-10-hotfix24-A3：新增 channel 可選參數（需求文件十六「目前渠道篩選」），
// 未提供或 'all' 時完全比照既有行為，不影響既有呼叫端。
function getTrackingHealth(db, storeId, channel) {
  const chWhere = (channel && channel !== 'all' && ORDER_CHANNELS.includes(channel))
    ? { sql: ` AND COALESCE(order_channel,'unknown') = ?`, params: [channel] }
    : { sql: '', params: [] };

  const lastRow = db.get(
    `SELECT MAX(created_at) as last_at FROM analytics_events WHERE store_id=?${chWhere.sql}`,
    [storeId, ...chWhere.params]
  ) || {};
  const lastEventAt = lastRow.last_at || null;

  // fix18-10-hotfix24-A3（需求文件十六）：最近一筆事件的身份基礎／渠道／頁面類型。
  // 純唯讀查詢，撈「最後一筆事件」本身的欄位，不做任何身份合併。
  const lastEventRow = db.get(
    `SELECT identity_type, is_estimated_identity, order_channel, page_type
     FROM analytics_events WHERE store_id=?${chWhere.sql}
     ORDER BY id DESC LIMIT 1`,
    [storeId, ...chWhere.params]
  );
  const lastEventIdentityType = lastEventRow ? (lastEventRow.identity_type || null) : null;
  const lastEventChannel = lastEventRow ? (lastEventRow.order_channel || 'unknown') : null;
  const lastEventPageType = lastEventRow ? (lastEventRow.page_type || 'unknown') : null;

  const last5MinCount = Number((db.get(
    `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND created_at >= datetime('now','-5 minutes')${chWhere.sql}`,
    [storeId, ...chWhere.params]
  ) || {}).c || 0);

  // 今日（Asia/Taipei 日曆日）各事件總數
  const todayRows = db.all(
    `SELECT event_name, COUNT(*) as c FROM analytics_events
     WHERE store_id=? AND ${A_LOCAL} >= datetime('now','+8 hours','start of day')${chWhere.sql}
     GROUP BY event_name`,
    [storeId, ...chWhere.params]
  );
  const todayByEvent = {};
  TRACKED_EVENT_NAMES.forEach(name => { todayByEvent[name] = 0; });
  todayRows.forEach(r => { if (todayByEvent[r.event_name] !== undefined) todayByEvent[r.event_name] = Number(r.c || 0); });
  const todayTotal = Object.values(todayByEvent).reduce((s, n) => s + n, 0);

  // identity_basis：這段資料（受同一 channel 篩選）主要是靠什麼辨識使用者
  let identityBasis = { identity_basis: null, identity_is_estimated: null, sample_size: 0 };
  try {
    const idRows = db.all(
      `SELECT identity_type FROM analytics_events WHERE store_id=?${chWhere.sql} LIMIT 5000`,
      [storeId, ...chWhere.params]
    );
    identityBasis = summarizeIdentityBasis(idRows);
  } catch (e) { /* 保守退回預設值，不影響其餘欄位 */ }

  let minutesSinceLastEvent = null;
  if (lastEventAt) {
    const lastMs = new Date(lastEventAt.replace(' ', 'T') + 'Z').getTime();
    minutesSinceLastEvent = round2((Date.now() - lastMs) / 60000);
  }

  // 是否正常：store 從未有任何事件（新店家／尚未上線 Tracking）不算「停止」，
  // 只有「曾經有事件、但超過門檻時間沒有新事件」才視為 Tracking 停止
  const isStale = lastEventAt !== null && minutesSinceLastEvent !== null && minutesSinceLastEvent > STALE_THRESHOLD_MINUTES;

  return {
    last_event_at: lastEventAt,
    minutes_since_last_event: minutesSinceLastEvent,
    events_last_5_min: last5MinCount,
    today_event_counts: todayByEvent,
    today_event_total: todayTotal,
    stale_threshold_minutes: STALE_THRESHOLD_MINUTES,
    is_tracking_active: lastEventAt === null ? null : !isStale, // null = 從未有過事件，不適用「停止」判斷
    warning: isStale ? '⚠ Analytics Tracking 已停止' : null,
    // fix18-10-hotfix24-A3（需求文件十六）
    identity_basis: identityBasis.identity_basis,
    identity_basis_label: identityBasisLabel(identityBasis.identity_basis),
    identity_is_estimated: identityBasis.identity_is_estimated,
    last_event_channel: lastEventChannel,
    last_event_channel_label: lastEventChannel ? (ORDER_CHANNEL_LABELS[lastEventChannel] || lastEventChannel) : '—',
    last_event_page_type: lastEventPageType,
    current_channel_filter: (channel && channel !== 'all') ? channel : 'all',
  };
}

// ── 第三部分：Purchase 去重稽核（寫入時已由 logServerEvent + DB unique index 防止，
//    這裡是唯讀稽核，確認防護確實生效，不做任何寫入或修正）──────────────────
function getPurchaseDuplicateAudit(db, storeId) {
  const dupRows = db.all(
    `SELECT order_id, COUNT(*) as c FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL
     GROUP BY order_id HAVING COUNT(*) > 1`,
    [storeId]
  );
  return {
    duplicate_purchase_order_count: dupRows.length,
    duplicate_order_ids: dupRows.slice(0, 20).map(r => r.order_id), // 最多列 20 筆供排查
    is_clean: dupRows.length === 0,
  };
}

// ── 第五部分：UTM 稽核（寫入時已由 insertEvent 正規化，這裡稽核既有資料是否
//    還殘留 Hotfix24-A1 之前寫入的 NULL/空字串，純唯讀，不做任何回填）───────
function getUtmAudit(db, storeId) {
  const nullSource = Number((db.get(
    `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND (source IS NULL OR source='')`,
    [storeId]
  ) || {}).c || 0);
  const nullCampaign = Number((db.get(
    `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND (campaign IS NULL OR campaign='')`,
    [storeId]
  ) || {}).c || 0);
  return {
    null_or_empty_source_count: nullSource,
    null_or_empty_campaign_count: nullCampaign,
    is_clean: nullSource === 0 && nullCampaign === 0,
    note: (nullSource > 0 || nullCampaign > 0)
      ? '這些是 Hotfix24-A1 UTM 正規化上線前寫入的舊事件，新事件不會再出現 NULL/空字串（見 utils/analyticsLog.js insertEvent）'
      : null,
  };
}

// ── 第四部分：Funnel Validation（Analytics purchase distinct order 數 vs orders 表實際付款筆數）──
function getFunnelValidation(db, storeId, range) {
  const analyticsPurchaseOrders = Number((db.get(
    `SELECT COUNT(DISTINCT order_id) c FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL
       AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  const ordersTablePaid = Number((db.get(
    `SELECT COUNT(*) c FROM orders WHERE ${ORDERS_BASE_WHERE} AND ${ORDERS_PAID_EXPR} AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  let diffPct = null;
  if (ordersTablePaid > 0) {
    diffPct = round2(Math.abs(analyticsPurchaseOrders - ordersTablePaid) / ordersTablePaid * 100);
  } else if (analyticsPurchaseOrders > 0) {
    diffPct = 100; // orders 表沒有付款訂單，但 Analytics 卻有 purchase，視為 100% 差異
  }

  const isConsistent = ordersTablePaid === 0 && analyticsPurchaseOrders === 0
    ? true
    : (diffPct !== null && diffPct <= FUNNEL_DIFF_TOLERANCE_PCT);

  return {
    analytics_purchase_orders: analyticsPurchaseOrders,
    orders_table_paid_orders: ordersTablePaid,
    diff_pct: diffPct,
    tolerance_pct: FUNNEL_DIFF_TOLERANCE_PCT,
    is_consistent: isConsistent,
    warning: isConsistent ? null : '⚠ Funnel 與訂單資料不一致',
  };
}

// ── 組裝：GET /api/analytics/health 回應 ─────────────────────────────
function getAnalyticsHealthReport(db, storeId, query) {
  let range;
  try {
    range = resolveDateRange(query || { preset: 'today' });
  } catch (e) {
    range = resolveDateRange({ preset: 'today' });
  }
  // fix18-10-hotfix24-A3（需求文件十六：「目前渠道篩選」）—— 與 GET /dashboard
  // 用同一套合法值判斷，不合法或未提供一律當作 'all'，不報錯。
  const rawChannel = ((query && query.channel) || 'all').trim();
  const channel = (rawChannel === 'all' || ORDER_CHANNELS.includes(rawChannel)) ? rawChannel : 'all';

  return {
    tracking_health: getTrackingHealth(db, storeId, channel),
    purchase_dedup_audit: getPurchaseDuplicateAudit(db, storeId),
    utm_audit: getUtmAudit(db, storeId),
    funnel_validation: getFunnelValidation(db, storeId, range),
    range: { preset: range.preset, start_date: range.start_date, end_date: range.end_date },
  };
}

module.exports = {
  getTrackingHealth,
  getPurchaseDuplicateAudit,
  getUtmAudit,
  getFunnelValidation,
  getAnalyticsHealthReport,
  STALE_THRESHOLD_MINUTES,
  FUNNEL_DIFF_TOLERANCE_PCT,
};
