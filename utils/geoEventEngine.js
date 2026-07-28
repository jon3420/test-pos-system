// utils/geoEventEngine.js — fix18-10-hotfix30-B5-R5.3-A2
// Geo Event Engine｜訪客行為地理事件引擎
//
// 這不是第二套 Geo Log，也不是第二套 Analytics——完全建立在既有
// geo_visit_log（見 utils/geoVisitLog.js）之上，單一查詢層
// getGeoEventFunnel() 一次回傳完整漏斗（Visitors/View Item/Add To Cart/
// Checkout/Purchase/Revenue/Abandonment/Conversion），不為每個 Tab 建一套
// SQL，不為每個指標建一支新 API（見 R5.3-A2_DATA_DECISION.md）。
//
// 正式事件分類（需求文件四）——沿用本專案 utils/analyticsLog.js 既有的
// EVENT_WHITELIST 實際事件名稱，不發明不存在的事件：
//   Visitors  : page_view（本專案實際事件）／session_start（本專案目前
//               沒有這個事件，列在分類表中只是為了未來相容，不影響現況）
//   View Item : view_product（本專案的 view_item 對應事件，名稱不同但
//               語意相同——瀏覽商品）
//   Add To Cart: add_to_cart
//   Checkout  : begin_checkout
//   Purchase  : purchase（本專案只有這一個正式購買完成事件，沒有
//               checkout_payment_complete，沿用既有定義，不重複計算）
// 非漏斗核心事件（scroll/user_engagement/heartbeat）本專案目前也没有這些
// 事件名稱；分類表仍保留它們對應到 'other'，只出現在 Recent Log，不計入
// 任何漏斗指標。

'use strict';

const { VISITOR_KEY_SQL, GEO_VISIT_LOG_TIME_RANGES, resolveTimeRangeSince } = require('./geoVisitLog');

// ════════════════════════════════════════════════════════════════
// 一、正式事件分類 Helper（需求文件四）
// ════════════════════════════════════════════════════════════════
const GEO_EVENT_CLASS = Object.freeze({
  VISITOR: 'visitor', VIEW_ITEM: 'view_item', ADD_TO_CART: 'add_to_cart',
  CHECKOUT: 'checkout', PURCHASE: 'purchase', OTHER: 'other',
});
// 單一分類表，供 SQL 產生 CASE WHEN 用，也供 JS 端（geoEventClassify）用，
// 兩邊共用同一份對照，不允許各自維護一份不一致的清單。
const GEO_EVENT_NAME_MAP = Object.freeze({
  page_view: GEO_EVENT_CLASS.VISITOR,
  session_start: GEO_EVENT_CLASS.VISITOR, // 本專案目前沒有此事件，保留相容
  view_product: GEO_EVENT_CLASS.VIEW_ITEM, // 本專案的 view_item 對應事件
  add_to_cart: GEO_EVENT_CLASS.ADD_TO_CART,
  begin_checkout: GEO_EVENT_CLASS.CHECKOUT,
  purchase: GEO_EVENT_CLASS.PURCHASE, // 本專案唯一的正式購買完成事件
});
function geoEventClassify(eventName) {
  return GEO_EVENT_NAME_MAP[eventName] || GEO_EVENT_CLASS.OTHER;
}
// 事件名稱清單（給 SQL IN (...) 用），避免在多個查詢裡各自重複寫死字串。
const VISITOR_EVENT_NAMES = Object.keys(GEO_EVENT_NAME_MAP).filter((k) => GEO_EVENT_NAME_MAP[k] === GEO_EVENT_CLASS.VISITOR);
const PURCHASE_EVENT_NAMES = Object.keys(GEO_EVENT_NAME_MAP).filter((k) => GEO_EVENT_NAME_MAP[k] === GEO_EVENT_CLASS.PURCHASE);

function _sqlInList(names) { return names.map((n) => `'${n.replace(/'/g, "''")}'`).join(','); }

// ════════════════════════════════════════════════════════════════
// 二、Conversion（需求文件九）——0 分母一律回傳 0，絕不 NaN/Infinity
// ════════════════════════════════════════════════════════════════
function _safeRate(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  const r = n / d;
  return Number.isFinite(r) ? Math.round(r * 10000) / 100 : 0; // 百分比，兩位小數
}

// ════════════════════════════════════════════════════════════════
// 三、getGeoEventFunnel()——單一查詢層，一次回傳完整漏斗
// ════════════════════════════════════════════════════════════════
// options: { range, customStart, channel }
// channel 篩選：本輪沒有在 geo_visit_log 新增 channel 欄位（稽核結論：
// analytics_events 的 channel 概念由既有 order_channel/source 欄位承載，
// geo_visit_log 是攤平後的 Geo 專用查詢層，不重複儲存 channel——若呼叫端
// 需要依 channel 篩選，本輪先支援「不篩選」，channel 參數保留給未來若
// geo_visit_log 真的加上 channel 欄位時使用，目前傳入會被忽略，不會報錯）。
function getGeoEventFunnel(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  try {
    // 3a. 全店總覽（Summary 用）——一次查完，不分別查 6 次。
    const overviewRow = db.get(
      `SELECT
        COUNT(DISTINCT CASE WHEN event_name IN (${_sqlInList(VISITOR_EVENT_NAMES)}) THEN ${VISITOR_KEY_SQL} END) AS visitors,
        COUNT(DISTINCT CASE WHEN event_name='view_product' THEN ${VISITOR_KEY_SQL} END) AS view_item_visitors,
        COUNT(DISTINCT CASE WHEN event_name='add_to_cart' THEN ${VISITOR_KEY_SQL} END) AS add_to_cart_visitors,
        COUNT(DISTINCT CASE WHEN event_name='begin_checkout' THEN ${VISITOR_KEY_SQL} END) AS begin_checkout_visitors,
        COUNT(DISTINCT CASE WHEN event_name IN (${_sqlInList(PURCHASE_EVENT_NAMES)}) THEN ${VISITOR_KEY_SQL} END) AS purchase_visitors,
        COUNT(DISTINCT CASE WHEN event_name IN (${_sqlInList(PURCHASE_EVENT_NAMES)}) THEN order_id END) AS purchase_orders_raw,
        COUNT(DISTINCT CASE WHEN is_unknown=0 THEN ${VISITOR_KEY_SQL} END) AS known_visitors,
        COUNT(DISTINCT CASE WHEN is_unknown=1 THEN ${VISITOR_KEY_SQL} END) AS unknown_visitors_raw
       FROM geo_visit_log WHERE store_id=? AND event_time >= ?`,
      [storeId, since]
    ) || {};

    const visitors = Number(overviewRow.visitors) || 0;
    const viewItemVisitors = Number(overviewRow.view_item_visitors) || 0;
    const addToCartVisitors = Number(overviewRow.add_to_cart_visitors) || 0;
    const checkoutVisitors = Number(overviewRow.begin_checkout_visitors) || 0;
    const purchaseVisitors = Number(overviewRow.purchase_visitors) || 0;
    // purchase_orders：COUNT(DISTINCT order_id) 只算「非 NULL」的 order_id
    // （SQLite COUNT(DISTINCT col) 本來就會忽略 NULL），這裡額外查一次
    // order_id 是否存在，才能誠實回報「尚無可用訂單識別資料」而不是顯示 0。
    const anyOrderIdRow = db.get(
      `SELECT COUNT(*) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name IN (${_sqlInList(PURCHASE_EVENT_NAMES)}) AND order_id IS NOT NULL`,
      [storeId, since]
    ) || { c: 0 };
    const hasOrderIdData = Number(anyOrderIdRow.c) > 0;
    const purchaseOrders = hasOrderIdData ? (Number(overviewRow.purchase_orders_raw) || 0) : null; // null = 「尚無可用訂單識別資料」

    // 需求文件「不得再出現 Geo Visitors=0 但 Unknown=100%」：分母永遠是
    // 這次查詢真正算出的 visitors（不是另外查一次），分子是 unknown_visitors，
    // visitors=0 時 unknown_rate 明確為 0。
    const unknownVisitors = Math.max(0, visitors - (Number(overviewRow.known_visitors) || 0));
    const unknownRate = visitors > 0 ? Math.round((unknownVisitors / visitors) * 1000) / 10 : 0;

    // 3b. Revenue：Analytics 本身沒有原生營收欄位（稽核結論見
    //     R5.3-A2_DATA_DECISION.md）。改成即時 JOIN 既有 orders 表的 total，
    //     明確標示來源是 Order Data，不新增 geo_visit_log.revenue 欄位。
    let revenue = null; // null = 「目前沒有可用營收事件資料」
    let revenueSource = null;
    if (hasOrderIdData) {
      try {
        const orderIdsRows = db.all(
          `SELECT DISTINCT order_id FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name IN (${_sqlInList(PURCHASE_EVENT_NAMES)}) AND order_id IS NOT NULL`,
          [storeId, since]
        ) || [];
        const orderIds = orderIdsRows.map((r) => r.order_id).filter(Boolean);
        if (orderIds.length) {
          const placeholders = orderIds.map(() => '?').join(',');
          const revRow = db.get(
            `SELECT SUM(total) s FROM orders WHERE store_id=? AND id IN (${placeholders})`,
            [storeId, ...orderIds]
          );
          if (revRow && revRow.s !== null && revRow.s !== undefined) {
            revenue = Number(revRow.s) || 0;
            revenueSource = 'order_data'; // 明確標示來源，不得跟 Analytics Revenue 混算（本專案無此概念）
          }
        }
      } catch (e) { /* orders 表查詢失敗時安全回退成「尚無可用營收資料」，不拋出例外 */ }
    }

    // 3c. Abandonment（需求文件八）——正式邏輯是集合差集，不是數字相減。
    const cartAbandonment = _countSetDifference(db, storeId, since, 'add_to_cart', PURCHASE_EVENT_NAMES);
    const checkoutAbandonment = _countSetDifference(db, storeId, since, 'begin_checkout', PURCHASE_EVENT_NAMES);

    return {
      range: opts.range || 'today',
      visitors,
      view_item_visitors: viewItemVisitors,
      add_to_cart_visitors: addToCartVisitors,
      begin_checkout_visitors: checkoutVisitors,
      purchase_visitors: purchaseVisitors,
      purchase_orders: purchaseOrders, // null = 尚無可用訂單識別資料
      revenue, // null = 目前沒有可用營收事件資料
      revenue_source: revenueSource, // 'order_data' 或 null
      cart_abandonment_visitors: cartAbandonment,
      checkout_abandonment_visitors: checkoutAbandonment,
      known_district_visitors: Number(overviewRow.known_visitors) || 0,
      unknown_visitors: unknownVisitors,
      unknown_rate: unknownRate,
      visitor_to_cart_rate: _safeRate(addToCartVisitors, visitors),
      cart_to_checkout_rate: _safeRate(checkoutVisitors, addToCartVisitors),
      checkout_to_purchase_rate: _safeRate(purchaseVisitors, checkoutVisitors),
      visitor_to_purchase_rate: _safeRate(purchaseVisitors, visitors),
      cart_conversion_rate: _safeRate(purchaseVisitors, addToCartVisitors),
      checkout_conversion_rate: _safeRate(purchaseVisitors, checkoutVisitors),
    };
  } catch (e) {
    console.warn('[geoEventEngine] getGeoEventFunnel failed:', e.message);
    return {
      range: opts.range || 'today', visitors: 0, view_item_visitors: 0, add_to_cart_visitors: 0,
      begin_checkout_visitors: 0, purchase_visitors: 0, purchase_orders: null, revenue: null,
      revenue_source: null, cart_abandonment_visitors: 0, checkout_abandonment_visitors: 0,
      known_district_visitors: 0, unknown_visitors: 0, unknown_rate: 0,
      visitor_to_cart_rate: 0, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0,
      visitor_to_purchase_rate: 0, cart_conversion_rate: 0, checkout_conversion_rate: 0,
    };
  }
}

// 集合差集：eventAName 的 visitor_key 集合，扣掉「在同一時間範圍內，任何
// purchase 事件（purchaseEventNames）出現過」的 visitor_key 集合。用 SQL
// NOT IN 子查詢直接算差集，不是先各自 COUNT 再相減（相減在 purchase 數
// 大於 add_to_cart 數的極端情況下會產生負數，需求文件明確禁止）。
function _countSetDifference(db, storeId, since, eventAName, purchaseEventNames) {
  try {
    const row = db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log
       WHERE store_id=? AND event_time >= ? AND event_name=?
       AND ${VISITOR_KEY_SQL} NOT IN (
         SELECT ${VISITOR_KEY_SQL} FROM geo_visit_log
         WHERE store_id=? AND event_time >= ? AND event_name IN (${_sqlInList(purchaseEventNames)})
       )`,
      [storeId, since, eventAName, storeId, since]
    ) || { c: 0 };
    return Math.max(0, Number(row.c) || 0); // 集合差集天生不會是負數，max(0,...) 只是最後一道防線
  } catch (e) {
    console.warn('[geoEventEngine] _countSetDifference failed:', e.message);
    return 0;
  }
}

// ════════════════════════════════════════════════════════════════
// 四、Recommendation Risk（需求文件十九）——規則式，不冒充 AI
// ════════════════════════════════════════════════════════════════
const RECOMMENDATION_RISK_MESSAGES = Object.freeze({
  basis: '規則式計算，非 AI',
  insufficient: 'Insufficient Data',
});
// 極簡規則版本（沿用既有 geoComputeRecommendedActions() 系列規則精神，本輪
// 不重寫既有 Rule Engine，只在 Geo Event Engine 這一層提供最小可用摘要，
// 需要完整規則明細時導向既有 Decision Center）。至少涵蓋需求文件列出的
// 六種風險來源判斷所需的原始數字，交由既有規則引擎或前端顯示層決定門檻。
function buildRecommendationRiskSummary(funnel) {
  const f = funnel || {};
  const hasEnoughData = (f.visitors || 0) >= 10; // 樣本量門檻，沿用既有 Decision Center 慣例（不足時顯示 Insufficient Data）
  return {
    basis: RECOMMENDATION_RISK_MESSAGES.basis,
    sufficient_data: hasEnoughData,
    message: hasEnoughData ? null : RECOMMENDATION_RISK_MESSAGES.insufficient,
    signals: hasEnoughData ? {
      high_visitor_low_conversion: (f.visitors || 0) > 0 && (f.visitor_to_purchase_rate || 0) < 1,
      high_cart_low_checkout: (f.add_to_cart_visitors || 0) > 0 && (f.cart_to_checkout_rate || 0) < 30,
      high_checkout_low_purchase: (f.begin_checkout_visitors || 0) > 0 && (f.checkout_to_purchase_rate || 0) < 50,
      high_unknown: (f.unknown_rate || 0) > 50,
      low_coverage: (f.visitors || 0) > 0 && ((f.known_district_visitors || 0) / (f.visitors || 1)) < 0.5,
      // 外送距離過高：本引擎不查詢 orders 距離資料（避免跨資料源耦合），
      // 交由既有 Decision Center／Order Heatmap Coverage 的距離分析負責，
      // 這裡固定 false，不假裝有這個訊號的原始資料。
      delivery_distance_too_high: false,
    } : null,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_EVENT_CLASS, GEO_EVENT_NAME_MAP, VISITOR_EVENT_NAMES, PURCHASE_EVENT_NAMES,
    geoEventClassify, getGeoEventFunnel, buildRecommendationRiskSummary,
    RECOMMENDATION_RISK_MESSAGES,
    GEO_VISIT_LOG_TIME_RANGES,
  };
}
