// utils/geoAnalyticsQueries.js — fix18-10-hotfix30-B5-R5.1-B
// Geo Event Wiring × Geo Analytics API × Data Quality — 第五階段：Geo Analytics 查詢層
//
// 原則：
//   - 每個函式都明確接收 (db, storeId, filters, ...)，不從全域或 query string
//     自行取得其他 store（十二、第七階段：store isolation）。
//   - SQL 聚合為主，不把整表讀進 Node.js 再分組（十八、效能要求）。
//   - 沿用既有 ANALYTICS_CREATED_AT_LOCAL_EXPR / ORDER_CHANNEL_SQL_EXPR /
//     ORDERS_BASE_WHERE / ORDERS_PAID_EXPR，不重寫時區、channel、revenue 口徑。
//   - Visitor Funnel 只讀 geo_context='visitor'；Fulfillment 只讀
//     orders.fulfillment_geo_*，兩者資料來源完全分開（不得混用）。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
const { ORDER_CHANNEL_SQL_EXPR, ORDER_CHANNELS } = require('./channelResolver');
const { DISTANCE_BANDS, DISTANCE_BAND_UNKNOWN } = require('./geoConstants');

const ORDERS_BASE_WHERE = "store_id=? AND status!='void' AND (order_status IS NULL OR order_status!='cancelled')";
const ORDERS_PAID_EXPR = "(status IN ('completed','modified'))";

// 第八階段：實際事件名稱集中定義一次，不在多個 SQL 重複硬寫。
// 專案盤點結論（見 CHANGELOG）：目前 view_item 不存在，實際事件是
// view_product；submit_order 與 purchase 是兩個獨立事件（submit_order 於
// 訂單建立時寫入，purchase 於非 LINE Pay 訂單立即或 LINE Pay /confirm 成功
// 時寫入——purchase 才代表「完成付款」，submit_order 只代表「送出訂單」，
// 兩者不是同一件事，不得虛構成同一個階段）。
const GEO_FUNNEL_EVENTS = Object.freeze({
  visit: 'page_view',
  productView: 'view_product',
  cart: 'add_to_cart',
  checkout: 'begin_checkout',
  submitOrder: 'submit_order',
  purchase: 'purchase',
});

function _rate(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  const r = n / d;
  return Number.isFinite(r) ? Math.round(r * 10000) / 10000 : 0; // 4 位小數，避免 API 回傳過長浮點
}

function _channelEventsClause(channel) {
  if (!channel || !ORDER_CHANNELS.includes(channel)) return { sql: '', params: [] };
  return { sql: ` AND COALESCE(order_channel,'unknown') = ?`, params: [channel] };
}
function _channelOrdersClause(channel) {
  if (!channel || !ORDER_CHANNELS.includes(channel)) return { sql: '', params: [] };
  return { sql: ` AND ${ORDER_CHANNEL_SQL_EXPR} = ?`, params: [channel] };
}

// 共用的 filters → SQL 片段（source/medium/campaign/city/district/
// geo_source/geo_confidence），所有欄位都走參數化 `?`，不拼字串。
function _commonEventFilterClause(filters) {
  const clauses = [];
  const params = [];
  if (filters.source) { clauses.push('source = ?'); params.push(filters.source); }
  if (filters.medium) { clauses.push('medium = ?'); params.push(filters.medium); }
  if (filters.campaign) { clauses.push('campaign = ?'); params.push(filters.campaign); }
  if (filters.geo_source) { clauses.push('geo_source = ?'); params.push(filters.geo_source); }
  if (filters.geo_confidence) { clauses.push('geo_confidence = ?'); params.push(filters.geo_confidence); }
  if (filters.city) { clauses.push('geo_city = ?'); params.push(filters.city); }
  if (filters.district) { clauses.push('geo_district = ?'); params.push(filters.district); }
  return { sql: clauses.length ? ' AND ' + clauses.join(' AND ') : '', params };
}

// ────────────────────────────────────────────────────────────────
// 第九階段：Visitor Geo Attribution —— 同一 store + canonical visitor
// （identity_key）+ 同一分析期間，優先使用「最早可辨識」的 visitor-context
// Geo，補回同一人後續沒有 Geo 的事件，不得因此把後續步驟全部算 unknown，
// 也絕不用 Delivery/Shipping Geo 回填 Visitor Geo（兩個 CTE 完全分開）。
// ────────────────────────────────────────────────────────────────
function _visitorGeoAttributionCTE(storeId, range) {
  const sql = `
    WITH visitor_geo_earliest AS (
      SELECT identity_key, MIN(${A_LOCAL}) AS first_seen
      FROM analytics_events
      WHERE store_id = ? AND geo_context = 'visitor'
        AND (geo_city IS NOT NULL OR geo_district IS NOT NULL)
        AND ${A_LOCAL} BETWEEN ? AND ?
        AND identity_key IS NOT NULL
      GROUP BY identity_key
    ),
    visitor_geo_attributed AS (
      SELECT ae.identity_key, ae.geo_city, ae.geo_district
      FROM analytics_events ae
      JOIN visitor_geo_earliest e
        ON e.identity_key = ae.identity_key AND e.first_seen = ${A_LOCAL}
      WHERE ae.store_id = ? AND ae.geo_context = 'visitor'
      GROUP BY ae.identity_key
    )
  `;
  const params = [storeId, range.startLocal, range.endLocal, storeId];
  return { sql, params };
}

// ────────────────────────────────────────────────────────────────
// /overview
// ────────────────────────────────────────────────────────────────
function getGeoOverview(db, storeId, filters) {
  const { range, channel } = filters;
  const chEvt = _channelEventsClause(channel);
  const chOrd = _channelOrdersClause(channel);

  const attribution = _visitorGeoAttributionCTE(storeId, range);
  const visitorRow = db.get(
    `${attribution.sql}
     SELECT
       COUNT(DISTINCT CASE WHEN vga.geo_city IS NOT NULL OR vga.geo_district IS NOT NULL THEN vga.identity_key END) AS identified,
       COUNT(DISTINCT vga.identity_key) AS total
     FROM visitor_geo_attributed vga`,
    attribution.params
  ) || { identified: 0, total: 0 };

  const totalVisitorsRow = db.get(
    `SELECT COUNT(DISTINCT identity_key) c FROM analytics_events
     WHERE store_id=? AND geo_context='visitor' AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}`,
    [storeId, GEO_FUNNEL_EVENTS.visit, range.startLocal, range.endLocal, ...chEvt.params]
  ) || { c: 0 };

  const identifiedVisitors = Number(visitorRow.identified) || 0;
  const totalVisitors = Number(totalVisitorsRow.c) || 0;
  const unknownVisitors = Math.max(0, totalVisitors - identifiedVisitors);

  const fulfillmentRow = db.get(
    `SELECT
       SUM(CASE WHEN order_mode IN ('delivery','shipping') AND fulfillment_geo_source IS NOT NULL THEN 1 ELSE 0 END) AS with_geo,
       SUM(CASE WHEN order_mode IN ('delivery','shipping') AND fulfillment_geo_source IS NULL THEN 1 ELSE 0 END) AS without_geo,
       AVG(CASE WHEN order_mode='delivery' THEN delivery_distance_km END) AS avg_distance,
       AVG(CASE WHEN order_mode='delivery' THEN delivery_fee END) AS avg_fee
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?${chOrd.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chOrd.params]
  ) || {};

  const topAreasRows = db.all(
    `${attribution.sql}
     SELECT COALESCE(vga.geo_city,'') AS city, COALESCE(vga.geo_district,'') AS district,
            COUNT(DISTINCT vga.identity_key) AS visitors
     FROM visitor_geo_attributed vga
     WHERE vga.geo_city IS NOT NULL OR vga.geo_district IS NOT NULL
     GROUP BY vga.geo_city, vga.geo_district
     ORDER BY visitors DESC
     LIMIT 10`,
    attribution.params
  ) || [];

  return {
    visitor_geo: {
      identified_visitors: identifiedVisitors,
      unknown_visitors: unknownVisitors,
      identified_rate: _rate(identifiedVisitors, totalVisitors),
    },
    fulfillment_geo: {
      orders_with_geo: Number(fulfillmentRow.with_geo) || 0,
      orders_without_geo: Number(fulfillmentRow.without_geo) || 0,
      average_distance_km: Number(fulfillmentRow.avg_distance) || 0,
      average_delivery_fee: Number(fulfillmentRow.avg_fee) || 0,
    },
    top_areas: topAreasRows.map((r) => ({ city: r.city || null, district: r.district || null, visitors: Number(r.visitors) || 0 })),
    data_quality: getGeoQuality(db, storeId, filters, { skipDistribution: true }),
  };
}

// ────────────────────────────────────────────────────────────────
// /funnel —— 十一、每個區域回傳 unique-person 漏斗
// ────────────────────────────────────────────────────────────────
function getGeoFunnel(db, storeId, filters) {
  const { range, channel, page, limit, offset } = filters;
  const chEvt = _channelEventsClause(channel);
  const common = _commonEventFilterClause(filters);
  const attribution = _visitorGeoAttributionCTE(storeId, range);

  function stepCTE(eventName, alias) {
    return `
      ${alias} AS (
        SELECT DISTINCT identity_key
        FROM analytics_events
        WHERE store_id = ? AND event_name = ? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
      )`;
  }
  const evtParams = (evt) => [storeId, evt, range.startLocal, range.endLocal, ...chEvt.params, ...common.params];

  const sql = `
    ${attribution.sql},
    ${stepCTE(GEO_FUNNEL_EVENTS.visit, 'step_visit')},
    ${stepCTE(GEO_FUNNEL_EVENTS.productView, 'step_view')},
    ${stepCTE(GEO_FUNNEL_EVENTS.cart, 'step_cart')},
    ${stepCTE(GEO_FUNNEL_EVENTS.checkout, 'step_checkout')},
    ${stepCTE(GEO_FUNNEL_EVENTS.submitOrder, 'step_submit')},
    ${stepCTE(GEO_FUNNEL_EVENTS.purchase, 'step_purchase')}
    SELECT
      vga.geo_city AS city, vga.geo_district AS district,
      COUNT(DISTINCT step_visit.identity_key) AS visitors,
      COUNT(DISTINCT step_view.identity_key) AS view_product_visitors,
      COUNT(DISTINCT step_cart.identity_key) AS add_to_cart_visitors,
      COUNT(DISTINCT step_checkout.identity_key) AS begin_checkout_visitors,
      COUNT(DISTINCT step_submit.identity_key) AS submitted_order_visitors,
      COUNT(DISTINCT step_purchase.identity_key) AS purchase_visitors
    FROM visitor_geo_attributed vga
    LEFT JOIN step_visit ON step_visit.identity_key = vga.identity_key
    LEFT JOIN step_view ON step_view.identity_key = vga.identity_key
    LEFT JOIN step_cart ON step_cart.identity_key = vga.identity_key
    LEFT JOIN step_checkout ON step_checkout.identity_key = vga.identity_key
    LEFT JOIN step_submit ON step_submit.identity_key = vga.identity_key
    LEFT JOIN step_purchase ON step_purchase.identity_key = vga.identity_key
    GROUP BY vga.geo_city, vga.geo_district
    HAVING visitors > 0
    ORDER BY visitors DESC
    LIMIT ? OFFSET ?
  `;
  const params = [
    ...attribution.params,
    ...evtParams(GEO_FUNNEL_EVENTS.visit),
    ...evtParams(GEO_FUNNEL_EVENTS.productView),
    ...evtParams(GEO_FUNNEL_EVENTS.cart),
    ...evtParams(GEO_FUNNEL_EVENTS.checkout),
    ...evtParams(GEO_FUNNEL_EVENTS.submitOrder),
    ...evtParams(GEO_FUNNEL_EVENTS.purchase),
    limit, offset,
  ];
  const rows = db.all(sql, params) || [];

  return {
    page, limit,
    areas: rows.map((r) => {
      const visitors = Number(r.visitors) || 0;
      const view = Number(r.view_product_visitors) || 0;
      const cart = Number(r.add_to_cart_visitors) || 0;
      const checkout = Number(r.begin_checkout_visitors) || 0;
      const submitted = Number(r.submitted_order_visitors) || 0;
      const purchase = Number(r.purchase_visitors) || 0;
      return {
        city: r.city || null,
        district: r.district || null,
        visitors, view_product_visitors: view, add_to_cart_visitors: cart,
        begin_checkout_visitors: checkout, submitted_order_visitors: submitted, purchase_visitors: purchase,
        visit_to_view_rate: _rate(view, visitors),
        visit_to_cart_rate: _rate(cart, visitors),
        cart_to_checkout_rate: _rate(checkout, cart),
        checkout_to_order_rate: _rate(submitted, checkout),
        visit_to_order_rate: _rate(submitted, visitors),
        visit_to_purchase_rate: _rate(purchase, visitors),
      };
    }),
  };
}

// ────────────────────────────────────────────────────────────────
// /fulfillment —— 十二、以 orders.fulfillment_geo_* 為主要來源
// ────────────────────────────────────────────────────────────────
function getGeoFulfillment(db, storeId, filters) {
  const { range, channel, page, limit, offset } = filters;
  const chOrd = _channelOrdersClause(channel);
  const cityClause = filters.city ? ' AND fulfillment_geo_city = ?' : '';
  const districtClause = filters.district ? ' AND fulfillment_geo_district = ?' : '';
  const sourceClause = filters.geo_source ? ' AND fulfillment_geo_source = ?' : '';
  const confClause = filters.geo_confidence ? ' AND fulfillment_geo_confidence = ?' : '';
  const extraParams = [
    ...(filters.city ? [filters.city] : []),
    ...(filters.district ? [filters.district] : []),
    ...(filters.geo_source ? [filters.geo_source] : []),
    ...(filters.geo_confidence ? [filters.geo_confidence] : []),
  ];

  const rows = db.all(
    `SELECT
       fulfillment_geo_city AS city, fulfillment_geo_district AS district,
       COUNT(*) AS submitted_orders,
       SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN 1 ELSE 0 END) AS completed_orders,
       SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN total ELSE 0 END) AS revenue,
       AVG(CASE WHEN ${ORDERS_PAID_EXPR} THEN total END) AS average_order_value,
       AVG(CASE WHEN order_mode='delivery' THEN delivery_distance_km END) AS average_distance_km,
       AVG(CASE WHEN order_mode='delivery' THEN delivery_fee END) AS average_delivery_fee,
       SUM(CASE WHEN order_mode='delivery' AND delivery_fee=0 THEN 1 ELSE 0 END) AS free_delivery_orders
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?
       AND order_mode IN ('delivery','shipping') AND fulfillment_geo_source IS NOT NULL
       ${cityClause}${districtClause}${sourceClause}${confClause}${chOrd.sql}
     GROUP BY fulfillment_geo_city, fulfillment_geo_district
     ORDER BY revenue DESC
     LIMIT ? OFFSET ?`,
    [storeId, range.startLocal, range.endLocal, ...extraParams, ...chOrd.params, limit, offset]
  ) || [];

  const oorRows = db.all(
    `SELECT geo_city AS city, geo_district AS district, COUNT(*) AS attempts
     FROM analytics_events
     WHERE store_id=? AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY geo_city, geo_district`,
    [storeId, 'delivery_out_of_range', range.startLocal, range.endLocal]
  ) || [];
  const oorMap = new Map(oorRows.map((r) => [`${r.city || ''}|${r.district || ''}`, Number(r.attempts) || 0]));

  const takeoutRow = db.get(
    `SELECT COUNT(*) c FROM orders WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ? AND order_mode='takeout'${chOrd.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chOrd.params]
  ) || { c: 0 };

  return {
    page, limit,
    areas: rows.map((r) => {
      const submitted = Number(r.submitted_orders) || 0;
      const completed = Number(r.completed_orders) || 0;
      const revenue = Number(r.revenue) || 0;
      const key = `${r.city || ''}|${r.district || ''}`;
      return {
        city: r.city || null,
        district: r.district || null,
        submitted_orders: submitted,
        completed_orders: completed,
        revenue,
        average_order_value: Number(r.average_order_value) || 0,
        average_distance_km: Number(r.average_distance_km) || 0,
        average_delivery_fee: Number(r.average_delivery_fee) || 0,
        free_delivery_orders: Number(r.free_delivery_orders) || 0,
        out_of_range_attempts: oorMap.get(key) || 0,
      };
    }),
    takeout_no_fulfillment_address: Number(takeoutRow.c) || 0,
  };
}

// ────────────────────────────────────────────────────────────────
// /distance —— 十三、固定回傳所有距離帶，即使為 0
// ────────────────────────────────────────────────────────────────
function getGeoDistance(db, storeId, filters) {
  const { range, channel } = filters;
  const chOrd = _channelOrdersClause(channel);
  const chEvt = _channelEventsClause(channel);

  const bandCaseExpr = `
    CASE
      WHEN delivery_distance_km IS NULL THEN 'unknown'
      WHEN delivery_distance_km < 3 THEN '0-3km'
      WHEN delivery_distance_km < 5 THEN '3-5km'
      WHEN delivery_distance_km < 8 THEN '5-8km'
      WHEN delivery_distance_km < 10 THEN '8-10km'
      WHEN delivery_distance_km < 15 THEN '10-15km'
      ELSE '15km+'
    END`;

  const orderRows = db.all(
    `SELECT ${bandCaseExpr} AS band,
            COUNT(*) AS submitted_orders,
            SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN 1 ELSE 0 END) AS completed_orders,
            SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN total ELSE 0 END) AS revenue,
            AVG(delivery_fee) AS average_delivery_fee
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ? AND order_mode='delivery'${chOrd.sql}
     GROUP BY band`,
    [storeId, range.startLocal, range.endLocal, ...chOrd.params]
  ) || [];
  const orderMap = new Map(orderRows.map((r) => [r.band, r]));

  function eventBandCounts(eventName) {
    const rows = db.all(
      `SELECT geo_distance_band AS band, COUNT(*) AS c
       FROM analytics_events
       WHERE store_id=? AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}
       GROUP BY geo_distance_band`,
      [storeId, eventName, range.startLocal, range.endLocal, ...chEvt.params]
    ) || [];
    const map = new Map();
    rows.forEach((r) => map.set(r.band || DISTANCE_BAND_UNKNOWN, Number(r.c) || 0));
    return map;
  }
  const feeCalcEvents = eventBandCounts('delivery_fee_calculated');
  const checkoutEvents = eventBandCounts(GEO_FUNNEL_EVENTS.checkout);

  const bandKeys = [...DISTANCE_BANDS.map((b) => b.key), DISTANCE_BAND_UNKNOWN];
  return {
    bands: bandKeys.map((band) => {
      const o = orderMap.get(band) || {};
      const submitted = Number(o.submitted_orders) || 0;
      const completed = Number(o.completed_orders) || 0;
      return {
        band,
        address_resolved_events: 0,
        fee_calculation_events: feeCalcEvents.get(band) || 0,
        checkout_visit_events: checkoutEvents.get(band) || 0,
        submitted_orders: submitted,
        completed_orders: completed,
        conversion_rate: _rate(completed, submitted),
        average_delivery_fee: Number(o.average_delivery_fee) || 0,
        revenue: Number(o.revenue) || 0,
      };
    }),
  };
}

// ────────────────────────────────────────────────────────────────
// /source-area —— 十四、marketing source/medium/campaign × order channel × geo district 分開
// ────────────────────────────────────────────────────────────────
function getGeoSourceArea(db, storeId, filters) {
  const { range, channel, page, limit, offset } = filters;
  const chEvt = _channelEventsClause(channel);
  const common = _commonEventFilterClause(filters);

  const rows = db.all(
    `SELECT
       COALESCE(NULLIF(source,''),'direct') AS source,
       medium AS medium, campaign AS campaign,
       COALESCE(order_channel,'unknown') AS channel,
       geo_city AS city, geo_district AS district,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS add_to_cart_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS begin_checkout_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS submitted_order_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS purchases
     FROM analytics_events
     WHERE store_id=? AND geo_context='visitor' AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
     GROUP BY source, medium, campaign, channel, city, district
     HAVING visitors > 0
     ORDER BY visitors DESC
     LIMIT ? OFFSET ?`,
    [
      GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout,
      GEO_FUNNEL_EVENTS.submitOrder, GEO_FUNNEL_EVENTS.purchase,
      storeId, range.startLocal, range.endLocal, ...chEvt.params, ...common.params,
      limit, offset,
    ]
  ) || [];

  // 第八階段：total 用一次獨立的聚合 COUNT query（對「分組後的組合數」計數，
  // 不是對事件數計數），只多一條 SQL，不是逐筆 N+1。
  const totalRow = db.get(
    `SELECT COUNT(*) AS total FROM (
       SELECT source, medium, campaign, order_channel, geo_city, geo_district,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS visitors
       FROM analytics_events
       WHERE store_id=? AND geo_context='visitor' AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
       GROUP BY source, medium, campaign, order_channel, geo_city, geo_district
       HAVING visitors > 0
     )`,
    [GEO_FUNNEL_EVENTS.visit, storeId, range.startLocal, range.endLocal, ...chEvt.params, ...common.params]
  ) || { total: 0 };
  const total = Number(totalRow.total) || 0;

  return {
    page, limit, total, total_pages: limit > 0 ? Math.ceil(total / limit) : 0,
    rows: rows.map((r) => {
      const visitors = Number(r.visitors) || 0;
      const submitted = Number(r.submitted_order_visitors) || 0;
      return {
        source: r.source, medium: r.medium || null, campaign: r.campaign || null,
        channel: r.channel, city: r.city || null, district: r.district || null,
        visitors, add_to_cart: Number(r.add_to_cart_visitors) || 0,
        begin_checkout: Number(r.begin_checkout_visitors) || 0,
        submitted_orders: submitted, purchases: Number(r.purchases) || 0,
        conversion_rate: _rate(submitted, visitors),
      };
    }),
  };
}

// ────────────────────────────────────────────────────────────────
// /quality —— 十五、Geo Data Quality
// ────────────────────────────────────────────────────────────────
const GEO_QUALITY_MIN_SAMPLE = 20;

function getGeoQuality(db, storeId, filters, opts = {}) {
  const { range, channel } = filters;
  const chEvt = _channelEventsClause(channel);

  const totalRow = db.get(
    `SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}
       AND event_name IN (?,?,?,?)`,
    [storeId, range.startLocal, range.endLocal, ...chEvt.params,
      GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout]
  ) || { c: 0 };
  const total = Number(totalRow.c) || 0;

  const confRow = db.get(
    `SELECT
       SUM(CASE WHEN geo_confidence='high' THEN 1 ELSE 0 END) AS high_count,
       SUM(CASE WHEN geo_confidence='medium' THEN 1 ELSE 0 END) AS medium_count,
       SUM(CASE WHEN geo_confidence='low' THEN 1 ELSE 0 END) AS low_count,
       SUM(CASE WHEN COALESCE(geo_confidence,'unknown')='unknown' THEN 1 ELSE 0 END) AS unknown_count,
       SUM(CASE WHEN geo_context='visitor' THEN 1 ELSE 0 END) AS visitor_count,
       SUM(CASE WHEN geo_context IN ('fulfillment','shipping') THEN 1 ELSE 0 END) AS fulfillment_count,
       SUM(CASE WHEN geo_city IS NOT NULL OR geo_district IS NOT NULL THEN 1 ELSE 0 END) AS identified_count
     FROM analytics_events
     WHERE store_id=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}
       AND event_name IN (?,?,?,?)`,
    [storeId, range.startLocal, range.endLocal, ...chEvt.params,
      GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout]
  ) || {};

  const highCount = Number(confRow.high_count) || 0;
  const mediumCount = Number(confRow.medium_count) || 0;
  const lowCount = Number(confRow.low_count) || 0;
  const unknownCount = Number(confRow.unknown_count) || 0;
  const identifiedCount = Number(confRow.identified_count) || 0;
  const unknownEvents = Math.max(0, total - identifiedCount);

  const unknownRate = _rate(unknownCount, total);
  const { getGeoAlertRules } = require('./geoAlertRules');
  const rules = getGeoAlertRules();

  let status = 'healthy';
  if (total < GEO_QUALITY_MIN_SAMPLE) status = 'insufficient_data';
  else if (unknownRate >= rules.GEO_ALERT_UNKNOWN_RATE) status = 'degraded';

  const result = {
    total_events: total,
    identified_events: identifiedCount,
    unknown_events: unknownEvents,
    identified_rate: _rate(identifiedCount, total),
    high_count: highCount, medium_count: mediumCount, low_count: lowCount, unknown_confidence_count: unknownCount,
    high_rate: _rate(highCount, total), medium_rate: _rate(mediumCount, total),
    low_rate: _rate(lowCount, total), unknown_rate: unknownRate,
    visitor_geo_rate: _rate(confRow.visitor_count, total),
    fulfillment_geo_rate: _rate(confRow.fulfillment_count, total),
    status,
    minimum_sample: GEO_QUALITY_MIN_SAMPLE,
  };
  if (!opts.skipDistribution) {
    result.by_context = db.all(
      `SELECT COALESCE(geo_context,'unknown') AS k, COUNT(*) c FROM analytics_events
       WHERE store_id=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql} GROUP BY k`,
      [storeId, range.startLocal, range.endLocal, ...chEvt.params]
    ) || [];
    result.by_source = db.all(
      `SELECT COALESCE(geo_source,'unknown') AS k, COUNT(*) c FROM analytics_events
       WHERE store_id=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql} GROUP BY k`,
      [storeId, range.startLocal, range.endLocal, ...chEvt.params]
    ) || [];
    result.by_confidence = db.all(
      `SELECT COALESCE(geo_confidence,'unknown') AS k, COUNT(*) c FROM analytics_events
       WHERE store_id=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql} GROUP BY k`,
      [storeId, range.startLocal, range.endLocal, ...chEvt.params]
    ) || [];
  }
  return result;
}

// ────────────────────────────────────────────────────────────────
// /alerts —— 十六、Geo Alerts（規則見 utils/geoAlertRules.js）
// ────────────────────────────────────────────────────────────────
function getGeoAlerts(db, storeId, filters) {
  const { getGeoAlertRules } = require('./geoAlertRules');
  const rules = getGeoAlertRules();
  const funnel = getGeoFunnel(db, storeId, { ...filters, limit: 100, offset: 0, page: 1 });
  const fulfillment = getGeoFulfillment(db, storeId, { ...filters, limit: 100, offset: 0, page: 1 });
  const quality = getGeoQuality(db, storeId, filters);

  const alerts = [];
  for (const area of funnel.areas) {
    if (area.visitors < rules.GEO_ALERT_MIN_VISITORS) continue;
    if (area.visit_to_cart_rate < rules.GEO_ALERT_LOW_CART_RATE && area.submitted_order_visitors === 0) {
      alerts.push({
        type: 'traffic_waste', severity: 'warning', city: area.city, district: area.district,
        metrics: { visitors: area.visitors, add_to_cart_visitors: area.add_to_cart_visitors, submitted_order_visitors: area.submitted_order_visitors },
        message: `${area.district || area.city || '此區域'}進站流量不低，但幾乎沒有加入購物車或送出訂單，趨勢顯示轉換可能不理想。`,
        suggestion: '建議檢查此區域的廣告受眾設定或商品是否符合當地需求。',
        rule: { min_visitors: rules.GEO_ALERT_MIN_VISITORS, low_cart_rate: rules.GEO_ALERT_LOW_CART_RATE },
      });
    }
    if (area.begin_checkout_visitors > 0 && _rate(area.submitted_order_visitors, area.begin_checkout_visitors) < rules.GEO_ALERT_LOW_ORDER_RATE) {
      alerts.push({
        type: 'checkout_drop', severity: 'warning', city: area.city, district: area.district,
        metrics: { begin_checkout_visitors: area.begin_checkout_visitors, submitted_order_visitors: area.submitted_order_visitors },
        message: `${area.district || area.city || '此區域'}開始結帳的人數中，實際送出訂單的比例偏低，可能與外送費、配送範圍或付款方式有關。`,
        suggestion: '建議檢查結帳流程與外送費用是否讓此區域顧客卻步。',
        rule: { low_order_rate: rules.GEO_ALERT_LOW_ORDER_RATE },
      });
    }
  }
  for (const area of fulfillment.areas) {
    if (area.average_distance_km > 0 && area.average_delivery_fee > 0 && _rate(area.completed_orders, area.submitted_orders) < rules.GEO_ALERT_LOW_ORDER_RATE) {
      alerts.push({
        type: 'delivery_cost_risk', severity: 'info', city: area.city, district: area.district,
        metrics: { average_distance_km: area.average_distance_km, average_delivery_fee: area.average_delivery_fee, conversion_rate: _rate(area.completed_orders, area.submitted_orders) },
        message: `${area.district || area.city || '此區域'}距離較遠、外送費較高，完成付款的比例可能偏低。`,
        suggestion: '建議檢查此距離區間的外送費是否合理，或評估是否需要調整配送範圍。',
        rule: { low_order_rate: rules.GEO_ALERT_LOW_ORDER_RATE },
      });
    }
    if (area.out_of_range_attempts >= rules.GEO_ALERT_MIN_VISITORS) {
      alerts.push({
        type: 'out_of_range_demand', severity: 'info', city: area.city, district: area.district,
        metrics: { out_of_range_attempts: area.out_of_range_attempts },
        message: `${area.district || area.city || '此區域'}有多次嘗試外送但超出配送範圍的紀錄，趨勢顯示此區域可能有未滿足的需求。`,
        suggestion: '建議檢查是否值得擴大此方向的配送範圍。',
        rule: { min_visitors: rules.GEO_ALERT_MIN_VISITORS },
      });
    }
  }
  if (quality.status !== 'healthy') {
    alerts.push({
      type: 'data_quality', severity: quality.status === 'insufficient_data' ? 'info' : 'warning',
      city: null, district: null,
      metrics: { unknown_rate: quality.unknown_rate, total_events: quality.total_events, status: quality.status },
      message: quality.status === 'insufficient_data'
        ? '目前樣本數不足，Geo 分析的可信度可能有限。'
        : '目前無法辨識區域的事件比例偏高，可能反映 IP 推定或地址解析故障。',
      suggestion: '建議檢查 Visitor IP Geo Provider 或 Google Maps 地址解析是否正常運作。',
      rule: { unknown_rate_threshold: rules.GEO_ALERT_UNKNOWN_RATE, min_sample: quality.minimum_sample },
    });
  }
  return { alerts, rule_thresholds: rules };
}

// ────────────────────────────────────────────────────────────────
// /dashboard geo_summary（十七、老闆儀表板精簡摘要，最多 3 筆）
// ────────────────────────────────────────────────────────────────
function getGeoDashboardSummary(db, storeId, filters) {
  const funnel = getGeoFunnel(db, storeId, { ...filters, limit: 100, offset: 0, page: 1 });
  const fulfillment = getGeoFulfillment(db, storeId, { ...filters, limit: 100, offset: 0, page: 1 });
  const quality = getGeoQuality(db, storeId, filters, { skipDistribution: true });

  const MIN_SAMPLE = 10;
  const scored = funnel.areas
    .filter((a) => a.visitors >= MIN_SAMPLE)
    .map((a) => ({
      city: a.city, district: a.district,
      visitors: a.visitors, submitted_order_visitors: a.submitted_order_visitors,
      begin_checkout_visitors: a.begin_checkout_visitors,
      score: a.submitted_order_visitors * 5 + a.begin_checkout_visitors,
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const wasteThresholdVisitors = 20;
  const wasteAreas = funnel.areas
    .filter((a) => a.visitors >= wasteThresholdVisitors && a.submitted_order_visitors === 0)
    .sort((a, b) => b.visitors - a.visitors)
    .slice(0, 3)
    .map((a) => ({ city: a.city, district: a.district, visitors: a.visitors, add_to_cart_visitors: a.add_to_cart_visitors }));

  return {
    top_intent_areas: scored,
    score_basis: 'completed_orders(submitted_order_visitors) × 5 + begin_checkout_visitors',
    minimum_sample: MIN_SAMPLE,
    high_traffic_low_conversion: wasteAreas,
    fulfillment_summary: {
      orders_with_geo: fulfillment.areas.reduce((s, a) => s + a.submitted_orders, 0),
      takeout_no_fulfillment_address: fulfillment.takeout_no_fulfillment_address,
    },
    data_quality: { unknown_rate: quality.unknown_rate, status: quality.status },
  };
}

module.exports = {
  GEO_FUNNEL_EVENTS,
  getGeoOverview,
  getGeoFunnel,
  getGeoFulfillment,
  getGeoDistance,
  getGeoSourceArea,
  getGeoAlerts,
  getGeoQuality,
  getGeoDashboardSummary,
};
