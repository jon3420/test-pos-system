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
  // fix18-10-hotfix30-B5-R5.2-A（Stage 6.3：county/subdivision 篩選，SQL 必須
  // parameterized，且必須同時支援新事件的官方代碼欄位與舊事件只有中文名稱的
  // 情況）——優先用 geo_county_code/geo_subdivision_code 比對（新事件），
  // 該欄位為 NULL 時 fallback 用 geo_city/geo_district 中文名稱比對（舊事件，
  // read-time 相容）。filters.countyCode/subdivisionCode 已經在
  // parseGeoAnalyticsFilters() 用 validateAreaFilters() 驗證過是資料集裡真實
  // 存在的代碼，這裡只需要查回對應中文名稱即可安全比對，不接受任意字串。
  if (filters.subdivisionCode) {
    const { getSubdivisionByCode } = require('./taiwanGeoNormalize');
    const sub = getSubdivisionByCode(filters.subdivisionCode);
    if (sub) {
      clauses.push('(geo_subdivision_code = ? OR (geo_subdivision_code IS NULL AND geo_district = ?))');
      params.push(sub.subdivision_code, sub.subdivision_name);
    }
  } else if (filters.countyCode) {
    const { getCountyByCode } = require('./taiwanGeoNormalize');
    const county = getCountyByCode(filters.countyCode);
    if (county) {
      clauses.push('(geo_county_code = ? OR (geo_county_code IS NULL AND geo_city = ?))');
      params.push(county.county_code, county.county_name);
    }
  }
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
      SELECT ae.identity_key, ae.geo_city, ae.geo_district, ae.geo_county_code, ae.geo_subdivision_code
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

// fix18-10-hotfix30-B5-R5.2-A（Stage 7.9）：對 visitor_geo_attributed CTE（別名
// vga）套用 county/subdivision 篩選，用同一個「新事件用代碼、代碼為 NULL 時
// fallback 中文名稱」的 hybrid 規則（見 _commonEventFilterClause 同一套邏輯，
// 這裡欄位改成帶 vga. 前綴，因為呼叫端都是以 CTE 別名 vga 查詢）。
function _vgaAreaFilterClause(filters) {
  if (filters.subdivisionCode) {
    const { getSubdivisionByCode } = require('./taiwanGeoNormalize');
    const sub = getSubdivisionByCode(filters.subdivisionCode);
    if (sub) {
      return {
        sql: ' AND (vga.geo_subdivision_code = ? OR (vga.geo_subdivision_code IS NULL AND vga.geo_district = ?))',
        params: [sub.subdivision_code, sub.subdivision_name],
      };
    }
  } else if (filters.countyCode) {
    const { getCountyByCode } = require('./taiwanGeoNormalize');
    const county = getCountyByCode(filters.countyCode);
    if (county) {
      return {
        sql: ' AND (vga.geo_county_code = ? OR (vga.geo_county_code IS NULL AND vga.geo_city = ?))',
        params: [county.county_code, county.county_name],
      };
    }
  }
  return { sql: '', params: [] };
}

// ────────────────────────────────────────────────────────────────
// /overview
// ────────────────────────────────────────────────────────────────
function getGeoOverview(db, storeId, filters) {
  const { range, channel } = filters;
  const chEvt = _channelEventsClause(channel);
  const chOrd = _channelOrdersClause(channel);
  const hasAreaFilter = !!(filters.countyCode || filters.subdivisionCode);
  const vgaArea = _vgaAreaFilterClause(filters);

  const attribution = _visitorGeoAttributionCTE(storeId, range);
  const visitorRow = db.get(
    `${attribution.sql}
     SELECT
       COUNT(DISTINCT CASE WHEN vga.geo_city IS NOT NULL OR vga.geo_district IS NOT NULL THEN vga.identity_key END) AS identified,
       COUNT(DISTINCT vga.identity_key) AS total
     FROM visitor_geo_attributed vga
     WHERE 1=1${vgaArea.sql}`,
    [...attribution.params, ...vgaArea.params]
  ) || { identified: 0, total: 0 };

  // fix18-10-hotfix30-B5-R5.2-A（Stage 7.9.1／7.9.6）：有行政區篩選時，
  // 「總訪客數」改成「這個縣市/行政區內識別到的訪客數」（也就是
  // visitorRow.identified），而不是全店訪客數——否則會出現「top_areas 已經
  // 篩選中壢區，但 visitor_count 還是全店」這種不一致。沒有篩選時，維持
  // 既有行為：totalVisitorsRow 是全店訪客數（含未知），unknown 正常顯示。
  let identifiedVisitors;
  let totalVisitors;
  let unknownVisitors;
  if (hasAreaFilter) {
    identifiedVisitors = Number(visitorRow.identified) || 0;
    totalVisitors = identifiedVisitors; // 篩選生效時，分母就是篩選後的資料集本身
    unknownVisitors = 0; // Stage 7.9.6：篩選特定行政區時，unknown 不計入
  } else {
    const totalVisitorsRow = db.get(
      `SELECT COUNT(DISTINCT identity_key) c FROM analytics_events
       WHERE store_id=? AND geo_context='visitor' AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}`,
      [storeId, GEO_FUNNEL_EVENTS.visit, range.startLocal, range.endLocal, ...chEvt.params]
    ) || { c: 0 };
    identifiedVisitors = Number(visitorRow.identified) || 0;
    totalVisitors = Number(totalVisitorsRow.c) || 0;
    unknownVisitors = Math.max(0, totalVisitors - identifiedVisitors);
  }

  // fix18-10-hotfix30-B5-R5.2-A（Stage 7.9.5）：/overview 是 acquisition
  // context，fulfillment_geo 這個區塊本來就是「全店履約 Geo 覆蓋率」的獨立
  // 統計（跟 visitor acquisition geo 是不同資料來源），不套用 county/
  // subdivision 篩選——套用的話等於要把某張訂單「用哪個 visitor 的 acquisition
  // geo 下的單」反查回來才能過濾，這是 /county-summary 在
  // geo_context=fulfillment 分支要做的事，不在這裡重做一次。誠實記錄於
  // CHANGELOG Known Limitations。
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

  // fix18-10-hotfix30-B5-R5.2-A（Stage 7.9.7）：county filter 生效時，
  // top_areas 只回該縣市底下的 subdivisions；subdivision filter 生效時，
  // 最多只會有一列（就是那個 subdivision 自己）。未知區域（geo_city/
  // geo_district 皆 NULL）本來就被 WHERE 排除，不會進熱門排行。
  const topAreasRows = db.all(
    `${attribution.sql}
     SELECT COALESCE(vga.geo_city,'') AS city, COALESCE(vga.geo_district,'') AS district,
            COUNT(DISTINCT vga.identity_key) AS visitors
     FROM visitor_geo_attributed vga
     WHERE (vga.geo_city IS NOT NULL OR vga.geo_district IS NOT NULL)${vgaArea.sql}
     GROUP BY vga.geo_city, vga.geo_district
     ORDER BY visitors DESC
     LIMIT 10`,
    [...attribution.params, ...vgaArea.params]
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
  // fix18-10-hotfix30-B5-R5.2-B1-3（需求文件 4.2–4.4：人數／次數分離）——
  // 「人數」用上面既有的 DISTINCT identity_key（不變，已被前幾輪 regression
  // 驗證過）；「次數」是同一批事件的原始筆數，按 identity_key 先 COUNT(*)
  // 分組一次（identity_key 上唯一），再用同一個 vga 分組 SUM 起來，不會因為
  // LEFT JOIN 造成筆數重複（每個 identity_key 在 count CTE 裡只有一列）。
  function countCTE(eventName, alias) {
    return `
      ${alias} AS (
        SELECT identity_key, COUNT(*) AS event_count
        FROM analytics_events
        WHERE store_id = ? AND event_name = ? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
        GROUP BY identity_key
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
    ${stepCTE(GEO_FUNNEL_EVENTS.purchase, 'step_purchase')},
    ${countCTE(GEO_FUNNEL_EVENTS.productView, 'count_view')},
    ${countCTE(GEO_FUNNEL_EVENTS.cart, 'count_cart')},
    ${countCTE(GEO_FUNNEL_EVENTS.checkout, 'count_checkout')}
    SELECT
      vga.geo_city AS city, vga.geo_district AS district,
      COUNT(DISTINCT step_visit.identity_key) AS visitors,
      COUNT(DISTINCT step_view.identity_key) AS view_product_visitors,
      COUNT(DISTINCT step_cart.identity_key) AS add_to_cart_visitors,
      COUNT(DISTINCT step_checkout.identity_key) AS begin_checkout_visitors,
      COUNT(DISTINCT step_submit.identity_key) AS submitted_order_visitors,
      COUNT(DISTINCT step_purchase.identity_key) AS purchase_visitors,
      COALESCE(SUM(count_view.event_count), 0) AS view_product_events,
      COALESCE(SUM(count_cart.event_count), 0) AS add_to_cart_events,
      COALESCE(SUM(count_checkout.event_count), 0) AS begin_checkout_events
    FROM visitor_geo_attributed vga
    LEFT JOIN step_visit ON step_visit.identity_key = vga.identity_key
    LEFT JOIN step_view ON step_view.identity_key = vga.identity_key
    LEFT JOIN step_cart ON step_cart.identity_key = vga.identity_key
    LEFT JOIN step_checkout ON step_checkout.identity_key = vga.identity_key
    LEFT JOIN step_submit ON step_submit.identity_key = vga.identity_key
    LEFT JOIN step_purchase ON step_purchase.identity_key = vga.identity_key
    LEFT JOIN count_view ON count_view.identity_key = vga.identity_key
    LEFT JOIN count_cart ON count_cart.identity_key = vga.identity_key
    LEFT JOIN count_checkout ON count_checkout.identity_key = vga.identity_key
    GROUP BY vga.geo_city, vga.geo_district
    HAVING (visitors + view_product_visitors + add_to_cart_visitors + begin_checkout_visitors + submitted_order_visitors + purchase_visitors) > 0
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
    ...evtParams(GEO_FUNNEL_EVENTS.productView),
    ...evtParams(GEO_FUNNEL_EVENTS.cart),
    ...evtParams(GEO_FUNNEL_EVENTS.checkout),
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
      // fix18-10-hotfix30-B5-R5.2-B1-3（需求文件 4.2–4.4）：事件「次數」與
      // 「人數」分開回傳，不得把次數誤當成人數（例如 1 人 view_product 12 次
      // 必須是 view_product_visitors=1、view_product_events=12）。
      const viewEvents = Number(r.view_product_events) || 0;
      const cartEvents = Number(r.add_to_cart_events) || 0;
      const checkoutEvents = Number(r.begin_checkout_events) || 0;
      return {
        city: r.city || null,
        district: r.district || null,
        visitors, view_product_visitors: view, add_to_cart_visitors: cart,
        begin_checkout_visitors: checkout, submitted_order_visitors: submitted, purchase_visitors: purchase,
        view_product_events: viewEvents, add_to_cart_events: cartEvents, begin_checkout_events: checkoutEvents,
        // 需求文件五：漏斗轉換率（分母為 0 一律 0，_rate() 已內建 NaN/Infinity 防護）
        visit_to_view_rate: _rate(view, visitors),
        view_to_cart_rate: _rate(cart, view),
        cart_to_checkout_rate: _rate(checkout, cart),
        checkout_to_purchase_rate: _rate(purchase, checkout),
        visit_to_purchase_rate: _rate(purchase, visitors),
        // 舊欄位保留相容（既有 regression 依賴，語意不變：checkout_to_order_rate
        // 是「開始結帳→送出訂單」，不是「開始結帳→完成購買」，兩者刻意分開）
        visit_to_cart_rate: _rate(cart, visitors),
        checkout_to_order_rate: _rate(submitted, checkout),
        visit_to_order_rate: _rate(submitted, visitors),
        // 需求文件八：每階段流失人數（相鄰兩階段人數差，一律 >= 0）
        dropoff: {
          visit_to_view: Math.max(0, visitors - view),
          view_to_cart: Math.max(0, view - cart),
          cart_to_checkout: Math.max(0, cart - checkout),
          checkout_to_purchase: Math.max(0, checkout - purchase),
        },
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
  // fix18-10-hotfix30-B5-R5.2-A（Stage 6.3）：履約 context 用
  // fulfillment_geo_county_code/fulfillment_geo_subdivision_code，跟 Visitor
  // context 的 geo_county_code 完全分開的欄位（禁止用 acquisition 覆蓋
  // fulfillment，反之亦然）。同樣是「新欄位優先、NULL 時 fallback 中文名稱」。
  let areaClause = '';
  const areaParams = [];
  if (filters.subdivisionCode) {
    const { getSubdivisionByCode } = require('./taiwanGeoNormalize');
    const sub = getSubdivisionByCode(filters.subdivisionCode);
    if (sub) {
      areaClause = ' AND (fulfillment_geo_subdivision_code = ? OR (fulfillment_geo_subdivision_code IS NULL AND fulfillment_geo_district = ?))';
      areaParams.push(sub.subdivision_code, sub.subdivision_name);
    }
  } else if (filters.countyCode) {
    const { getCountyByCode } = require('./taiwanGeoNormalize');
    const county = getCountyByCode(filters.countyCode);
    if (county) {
      areaClause = ' AND (fulfillment_geo_county_code = ? OR (fulfillment_geo_county_code IS NULL AND fulfillment_geo_city = ?))';
      areaParams.push(county.county_code, county.county_name);
    }
  }
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
       SUM(CASE WHEN order_mode='delivery' AND delivery_fee=0 THEN 1 ELSE 0 END) AS free_delivery_orders,
       -- fix18-10-hotfix30-B5-R5.3-A1（Geo Intelligence Heatmap Foundation）：
       -- 唯一合法的真實座標來源——只有 order_mode='delivery' 且顧客當時提供過
       -- delivery_lat/delivery_lng（TEXT，非空字串）的訂單才計入。不得對
       -- shipping/pickup/takeout 或空字串座標取平均（會把 0/NULL 誤當成座標）。
       COUNT(CASE WHEN order_mode='delivery' AND delivery_lat IS NOT NULL AND delivery_lat <> '' AND delivery_lng IS NOT NULL AND delivery_lng <> '' THEN 1 END) AS coordinate_count,
       AVG(CASE WHEN order_mode='delivery' AND delivery_lat IS NOT NULL AND delivery_lat <> '' AND delivery_lng IS NOT NULL AND delivery_lng <> '' THEN CAST(delivery_lat AS REAL) END) AS avg_delivery_lat,
       AVG(CASE WHEN order_mode='delivery' AND delivery_lat IS NOT NULL AND delivery_lat <> '' AND delivery_lng IS NOT NULL AND delivery_lng <> '' THEN CAST(delivery_lng AS REAL) END) AS avg_delivery_lng
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?
       AND order_mode IN ('delivery','shipping') AND fulfillment_geo_source IS NOT NULL
       ${cityClause}${districtClause}${sourceClause}${confClause}${areaClause}${chOrd.sql}
     GROUP BY fulfillment_geo_city, fulfillment_geo_district
     ORDER BY revenue DESC
     LIMIT ? OFFSET ?`,
    [storeId, range.startLocal, range.endLocal, ...extraParams, ...areaParams, ...chOrd.params, limit, offset]
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

  // fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件三、四）：Business Total ——
  // 上面的 `rows`/GROUP BY 查詢刻意只涵蓋
  // `order_mode IN ('delivery','shipping') AND fulfillment_geo_source IS NOT NULL`，
  // 也就是「Geo Drawable」子集合，不是全店總量（這正是本輪要修的 bug：
  // 之前把這個子集合的加總誤當成 Business Total）。
  //
  // 這裡另外用「同一組」Store／Date Range／Channel 篩選（跟上面 rows 查詢
  // 共用 ORDERS_BASE_WHERE／range／chOrd，不新造篩選邏輯），但不套用
  // order_mode／fulfillment_geo_source／city／district 限制，算出真正的
  // 全店訂單數／營收（含 takeout、含沒有任何地理資料的訂單），作為
  // additive 欄位回傳。不修改上面任何既有欄位語意，也不改變訂單/營收/
  // Channel/Date Range 的既有定義（沿用同一個 ORDERS_BASE_WHERE／
  // ORDERS_PAID_EXPR／chOrd）。
  const businessTotalRow = db.get(
    `SELECT COUNT(*) AS business_total_orders,
            COALESCE(SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN total ELSE 0 END),0) AS business_total_revenue
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?${chOrd.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chOrd.params]
  ) || { business_total_orders: 0, business_total_revenue: 0 };

  return {
    page, limit,
    business_total_orders: Number(businessTotalRow.business_total_orders) || 0,
    business_total_revenue: Number(businessTotalRow.business_total_revenue) || 0,
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
        // fix18-10-hotfix30-B5-R5.3-A1：coordinate_source 只有兩個合法值——
        // 'order_centroid'（真的算出平均座標）或 'unavailable'（沒有任何一筆
        // delivery 訂單帶座標）。不得無條件標成 order_centroid（那等於在沒有
        // 座標時假裝有）。
        coordinate_count: Number(r.coordinate_count) || 0,
        coordinate_source: (Number(r.coordinate_count) || 0) > 0 ? 'order_centroid' : 'unavailable',
        coordinate_confidence: geoHeatClassifyCoordinateConfidence(Number(r.coordinate_count) || 0),
        lat: r.avg_delivery_lat != null ? Number(r.avg_delivery_lat) : null,
        lng: r.avg_delivery_lng != null ? Number(r.avg_delivery_lng) : null,
      };
    }),
    takeout_no_fulfillment_address: Number(takeoutRow.c) || 0,
  };
}

// ────────────────────────────────────────────────────────────────
// fix18-10-hotfix30-B5-R5.3-A1（需求文件四）：coordinate_count → confidence
// 純函式，供 route 與 Smoke 共用同一套門檻，不各自寫死一份判斷邏輯。
// 門檻選擇：0 筆＝完全沒有可信賴的樣本；1 筆＝有位置但無法排除單一離群值；
// 2–4 筆＝有一定樣本但仍偏少；≥5 筆＝視為足夠聚合成一個代表性中心點。
// ────────────────────────────────────────────────────────────────
function geoHeatClassifyCoordinateConfidence(coordinateCount) {
  const n = Number(coordinateCount) || 0;
  if (n <= 0) return 'unavailable';
  if (n === 1) return 'low';
  if (n <= 4) return 'medium';
  return 'high';
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

  // fix18-10-hotfix30-B5-R5.2-B1-3（Phase 1.1 Audit 結論）——修正前的
  // getGeoSourceArea() 有兩個問題：
  //   1. `visitors` 只綁 page_view 事件（GEO_FUNNEL_EVENTS.visit），且完全
  //      沒有 view_product（瀏覽商品）欄位，`HAVING visitors > 0` 導致只有
  //      view_product/add_to_cart/begin_checkout/purchase、沒有 page_view
  //      的訪客整列被丟掉——跟 getGeoFunnel()/getCountySummary() 這輪修過的
  //      同一種漏失問題。
  //   2. 完全沒有事件「次數」欄位（人數/次數混在一起，只有人數）。
  // 修正：新增 view_product_visitors，HAVING 改成「任一階段人數 > 0」，並
  // 補上 view_product_events/add_to_cart_events/begin_checkout_events（用
  // SUM(CASE WHEN...) 跟人數同一次 GROUP BY 算出，不必像 getGeoFunnel() 那樣
  // 另建 CTE——這裡本來就是單表 flat GROUP BY，不涉及跨事件 identity
  // attribution）。source/medium/campaign/channel/city/district 的既有分組
  // 與篩選範圍（common.sql／chEvt.sql）完全不動。
  const rows = db.all(
    `SELECT
       COALESCE(NULLIF(source,''),'direct') AS source,
       medium AS medium, campaign AS campaign,
       COALESCE(order_channel,'unknown') AS channel,
       geo_city AS city, geo_district AS district,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS view_product_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS add_to_cart_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS begin_checkout_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS submitted_order_visitors,
       COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS purchases,
       SUM(CASE WHEN event_name=? THEN 1 ELSE 0 END) AS view_product_events,
       SUM(CASE WHEN event_name=? THEN 1 ELSE 0 END) AS add_to_cart_events,
       SUM(CASE WHEN event_name=? THEN 1 ELSE 0 END) AS begin_checkout_events
     FROM analytics_events
     WHERE store_id=? AND geo_context='visitor' AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
     GROUP BY source, medium, campaign, channel, city, district
     HAVING (visitors + view_product_visitors + add_to_cart_visitors + begin_checkout_visitors + submitted_order_visitors + purchases) > 0
     ORDER BY visitors DESC
     LIMIT ? OFFSET ?`,
    [
      GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout,
      GEO_FUNNEL_EVENTS.submitOrder, GEO_FUNNEL_EVENTS.purchase,
      GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout,
      storeId, range.startLocal, range.endLocal, ...chEvt.params, ...common.params,
      limit, offset,
    ]
  ) || [];

  // 第八階段：total 用一次獨立的聚合 COUNT query（對「分組後的組合數」計數，
  // 不是對事件數計數），只多一條 SQL，不是逐筆 N+1。
  // Phase 1.1：total 的判定條件必須跟上面主查詢的 HAVING 一致，否則分頁
  // total_pages 會漏算「沒有 page_view 但有其他階段」的組合數。
  const totalRow = db.get(
    `SELECT COUNT(*) AS total FROM (
       SELECT source, medium, campaign, order_channel, geo_city, geo_district,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS visitors,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS view_product_visitors,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS add_to_cart_visitors,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS begin_checkout_visitors,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS submitted_order_visitors,
              COUNT(DISTINCT CASE WHEN event_name=? THEN identity_key END) AS purchases
       FROM analytics_events
       WHERE store_id=? AND geo_context='visitor' AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
       GROUP BY source, medium, campaign, order_channel, geo_city, geo_district
       HAVING (visitors + view_product_visitors + add_to_cart_visitors + begin_checkout_visitors + submitted_order_visitors + purchases) > 0
     )`,
    [
      GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart,
      GEO_FUNNEL_EVENTS.checkout, GEO_FUNNEL_EVENTS.submitOrder, GEO_FUNNEL_EVENTS.purchase,
      storeId, range.startLocal, range.endLocal, ...chEvt.params, ...common.params,
    ]
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
        visitors,
        view_product_visitors: Number(r.view_product_visitors) || 0,
        add_to_cart: Number(r.add_to_cart_visitors) || 0,
        begin_checkout: Number(r.begin_checkout_visitors) || 0,
        submitted_orders: submitted, purchases: Number(r.purchases) || 0,
        // fix18-10-hotfix30-B5-R5.2-B1-3（Phase 1.1）：事件次數，與上面人數
        // 欄位分開，不得混用（同 getGeoFunnel()/getCountySummary() 原則）。
        view_product_events: Number(r.view_product_events) || 0,
        add_to_cart_events: Number(r.add_to_cart_events) || 0,
        begin_checkout_events: Number(r.begin_checkout_events) || 0,
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
        type: 'traffic_waste', severity: 'warning', geo_context: 'acquisition', city: area.city, district: area.district,
        metrics: { visitors: area.visitors, add_to_cart_visitors: area.add_to_cart_visitors, submitted_order_visitors: area.submitted_order_visitors },
        message: `${area.district || area.city || '此區域'}進站流量不低，但幾乎沒有加入購物車或送出訂單，趨勢顯示轉換可能不理想。`,
        suggestion: '建議檢查此區域的廣告受眾設定或商品是否符合當地需求。',
        rule: { min_visitors: rules.GEO_ALERT_MIN_VISITORS, low_cart_rate: rules.GEO_ALERT_LOW_CART_RATE },
      });
    }
    if (area.begin_checkout_visitors > 0 && _rate(area.submitted_order_visitors, area.begin_checkout_visitors) < rules.GEO_ALERT_LOW_ORDER_RATE) {
      alerts.push({
        type: 'checkout_drop', severity: 'warning', geo_context: 'acquisition', city: area.city, district: area.district,
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
        type: 'delivery_cost_risk', severity: 'info', geo_context: 'fulfillment', city: area.city, district: area.district,
        metrics: { average_distance_km: area.average_distance_km, average_delivery_fee: area.average_delivery_fee, conversion_rate: _rate(area.completed_orders, area.submitted_orders) },
        message: `${area.district || area.city || '此區域'}距離較遠、外送費較高，完成付款的比例可能偏低。`,
        suggestion: '建議檢查此距離區間的外送費是否合理，或評估是否需要調整配送範圍。',
        rule: { low_order_rate: rules.GEO_ALERT_LOW_ORDER_RATE },
      });
    }
    if (area.out_of_range_attempts >= rules.GEO_ALERT_MIN_VISITORS) {
      alerts.push({
        type: 'out_of_range_demand', severity: 'info', geo_context: 'fulfillment', city: area.city, district: area.district,
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
      geo_context: null, scope: 'store', // 全店層級，不屬於任何單一區域，enrichment 略過（見 _enrichAreaFields），即使目前有 county/subdivision 篩選也保留顯示，避免使用者誤以為 Geo Quality 只評估篩選出來的那個區域（Stage 7.10.6）
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
//
// @deprecated fix18-10-hotfix30-B5-R5.2-B1-1 — Dashboard 首頁的 KPI／
// Geo Quality／Top 3 區塊已換線到 GET /api/analytics/geo/*（見
// public/js/geo-intelligence.js:loadGeoDashboardData()），不再讀取這支
// 函式的回傳值。保留本函式與 GET /api/analytics/dashboard 的
// data.geo_summary 欄位本身（不刪除、不變更回傳格式），因為尚未逐一確認
// 是否還有其他頁面／既有 regression 依賴這個欄位；若之後確認完全沒有其他
// 呼叫端使用，才可以在未來一輪安全移除。
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

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.2-A：GET /api/analytics/geo/county-summary
// ══════════════════════════════════════════════════════════════════
// geo_context=acquisition（預設）：以「進站來源」（Visitor Geo，見
// _visitorGeoAttributionCTE 的最早有效 geo_city/geo_district）為準，沿用
// getGeoFunnel() 完全同一套 identity_key 去重／attribution 邏輯，不建立
//第二套去重規則（需求文件二）。
//
// 縣市層級是「讀取時」在 Node.js 端把既有 geo_city/geo_district 聚合結果
// 用 resolveTaiwanAdministrativeArea() 轉成 county_code，再依 county_code
// SUM 起來——SQL 本身仍是既有 GROUP BY city/district 的聚合（小結果集，
// 通常遠小於原始事件數），JS 端只是多一層「按縣市再折疊」，不是把整張表
// 讀進記憶體分組（見需求文件十八效能原則）。
function _resolveAreaCodesForRow(city, district) {
  const { resolveTaiwanAdministrativeArea } = require('./taiwanGeoNormalize');
  try {
    return resolveTaiwanAdministrativeArea({ city, district });
  } catch (e) {
    return { resolution: 'unknown' };
  }
}

function getCountySummary(db, storeId, filters) {
  const { range, channel } = filters;
  const chEvt = _channelEventsClause(channel);
  const common = _commonEventFilterClause(filters);
  const attribution = _visitorGeoAttributionCTE(storeId, range);
  // purchase_revenue CTE 需要 JOIN analytics_events × orders，兩張表都有
  // created_at 欄位，直接用未限定的 A_LOCAL 會產生 SQLite "ambiguous column
  // name" 錯誤。這裡從同一個canonical 字串（ANALYTICS_CREATED_AT_LOCAL_EXPR）
  // 動態代換成 `ae.created_at`，而不是另外手寫一份時區規則，維持「不重寫時區
  // 邏輯」的既有原則（見檔案頂端註解）。
  const A_LOCAL_AE = A_LOCAL.replace(/\bcreated_at\b/, 'ae.created_at');

  function stepCTE(eventName, alias) {
    return `
      ${alias} AS (
        SELECT DISTINCT identity_key
        FROM analytics_events
        WHERE store_id = ? AND event_name = ? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
      )`;
  }
  function countCTE(eventName, alias) {
    return `
      ${alias} AS (
        SELECT identity_key, COUNT(*) AS event_count
        FROM analytics_events
        WHERE store_id = ? AND event_name = ? AND ${A_LOCAL} BETWEEN ? AND ?${chEvt.sql}${common.sql}
        GROUP BY identity_key
      )`;
  }
  const evtParams = (evt) => [storeId, evt, range.startLocal, range.endLocal, ...chEvt.params, ...common.params];

  const sql = `
    ${attribution.sql},
    ${stepCTE(GEO_FUNNEL_EVENTS.visit, 'step_visit')},
    ${stepCTE(GEO_FUNNEL_EVENTS.productView, 'step_view')},
    ${stepCTE(GEO_FUNNEL_EVENTS.cart, 'step_cart')},
    ${stepCTE(GEO_FUNNEL_EVENTS.checkout, 'step_checkout')},
    ${stepCTE(GEO_FUNNEL_EVENTS.purchase, 'step_purchase')},
    ${countCTE(GEO_FUNNEL_EVENTS.productView, 'count_view')},
    ${countCTE(GEO_FUNNEL_EVENTS.cart, 'count_cart')},
    ${countCTE(GEO_FUNNEL_EVENTS.checkout, 'count_checkout')},
    purchase_revenue AS (
      SELECT ae.identity_key, COUNT(DISTINCT ae.order_id) AS orders, COALESCE(SUM(o.total), 0) AS revenue
      FROM analytics_events ae
      JOIN orders o ON o.id = ae.order_id AND o.store_id = ae.store_id
      WHERE ae.store_id = ? AND ae.event_name = ? AND ${A_LOCAL_AE} BETWEEN ? AND ?
      GROUP BY ae.identity_key
    )
    SELECT
      vga.geo_city AS city, vga.geo_district AS district,
      COUNT(DISTINCT step_visit.identity_key) AS visitors,
      COUNT(DISTINCT step_view.identity_key) AS product_view_visitors,
      COUNT(DISTINCT step_cart.identity_key) AS cart_visitors,
      COUNT(DISTINCT step_checkout.identity_key) AS checkout_visitors,
      COUNT(DISTINCT step_purchase.identity_key) AS purchase_visitors,
      COALESCE(SUM(count_view.event_count), 0) AS product_view_events,
      COALESCE(SUM(count_cart.event_count), 0) AS cart_events,
      COALESCE(SUM(count_checkout.event_count), 0) AS checkout_events,
      COALESCE(SUM(pr.orders), 0) AS order_count,
      COALESCE(SUM(pr.revenue), 0) AS revenue
    FROM visitor_geo_attributed vga
    LEFT JOIN step_visit ON step_visit.identity_key = vga.identity_key
    LEFT JOIN step_view ON step_view.identity_key = vga.identity_key
    LEFT JOIN step_cart ON step_cart.identity_key = vga.identity_key
    LEFT JOIN step_checkout ON step_checkout.identity_key = vga.identity_key
    LEFT JOIN step_purchase ON step_purchase.identity_key = vga.identity_key
    LEFT JOIN count_view ON count_view.identity_key = vga.identity_key
    LEFT JOIN count_cart ON count_cart.identity_key = vga.identity_key
    LEFT JOIN count_checkout ON count_checkout.identity_key = vga.identity_key
    LEFT JOIN purchase_revenue pr ON pr.identity_key = vga.identity_key
    GROUP BY vga.geo_city, vga.geo_district
    HAVING (visitors + product_view_visitors + cart_visitors + checkout_visitors + purchase_visitors) > 0
  `;
  const params = [
    ...attribution.params,
    ...evtParams(GEO_FUNNEL_EVENTS.visit),
    ...evtParams(GEO_FUNNEL_EVENTS.productView),
    ...evtParams(GEO_FUNNEL_EVENTS.cart),
    ...evtParams(GEO_FUNNEL_EVENTS.checkout),
    ...evtParams(GEO_FUNNEL_EVENTS.purchase),
    ...evtParams(GEO_FUNNEL_EVENTS.productView),
    ...evtParams(GEO_FUNNEL_EVENTS.cart),
    ...evtParams(GEO_FUNNEL_EVENTS.checkout),
    storeId, GEO_FUNNEL_EVENTS.purchase, range.startLocal, range.endLocal,
  ];
  const districtRows = db.all(sql, params) || [];

  // 未辨識訪客（有 visitor-context 事件，但完全沒有 geo_city/geo_district）——
  // 獨立查詢，不跟上面已經篩過「至少有 geo」的 attribution CTE 混用。
  const unknownRow = db.get(
    `SELECT COUNT(DISTINCT identity_key) AS c FROM analytics_events
     WHERE store_id=? AND geo_context='visitor' AND geo_city IS NULL AND geo_district IS NULL
       AND ${A_LOCAL} BETWEEN ? AND ? AND identity_key IS NOT NULL
       AND event_name IN (?,?,?,?)`,
    [storeId, range.startLocal, range.endLocal, GEO_FUNNEL_EVENTS.visit, GEO_FUNNEL_EVENTS.productView, GEO_FUNNEL_EVENTS.cart, GEO_FUNNEL_EVENTS.checkout]
  ) || { c: 0 };
  const unknownVisitorCount = Number(unknownRow.c) || 0;

  // ── 依 county_code 折疊（district row → county 累加）─────────────────
  const countyMap = new Map(); // county_code -> aggregated row + set of resolved subdivision_codes
  let unknownSubdivisionAcrossAll = 0;

  districtRows.forEach((r) => {
    const resolved = _resolveAreaCodesForRow(r.city, r.district);
    const visitors = Number(r.visitors) || 0;
    if (resolved.resolution !== 'subdivision' && resolved.resolution !== 'county') {
      // 完全無法辨識縣市：這些訪客不計入任何 county 列，但仍計入回應層級的
      // unknown（跟上面「完全沒有 geo」的 unknownVisitorCount 概念不同——這裡
      // 是「有 geo_city/geo_district 字串，但無法對到本專案的行政區資料集」，
      // 例如國外 IP 或資料髒污）。
      unknownSubdivisionAcrossAll += visitors;
      return;
    }
    const key = resolved.county_code;
    if (!countyMap.has(key)) {
      countyMap.set(key, {
        county_code: resolved.county_code, county_name: resolved.county_name,
        visitor_count: 0, product_view_visitor_count: 0, cart_visitor_count: 0,
        checkout_visitor_count: 0, purchase_visitor_count: 0, order_count: 0, revenue: 0,
        product_view_event_count: 0, cart_event_count: 0, checkout_event_count: 0,
        _subdivisionCodes: new Set(), unknown_subdivision_visitor_count: 0,
      });
    }
    const c = countyMap.get(key);
    c.visitor_count += visitors;
    c.product_view_visitor_count += Number(r.product_view_visitors) || 0;
    c.cart_visitor_count += Number(r.cart_visitors) || 0;
    c.checkout_visitor_count += Number(r.checkout_visitors) || 0;
    c.purchase_visitor_count += Number(r.purchase_visitors) || 0;
    c.order_count += Number(r.order_count) || 0;
    c.revenue += Number(r.revenue) || 0;
    // 需求文件 4.2–4.4：次數與人數分開累加，不得混用（次數僅供 Drawer 補充顯示）
    c.product_view_event_count += Number(r.product_view_events) || 0;
    c.cart_event_count += Number(r.cart_events) || 0;
    c.checkout_event_count += Number(r.checkout_events) || 0;
    if (resolved.resolution === 'subdivision') c._subdivisionCodes.add(resolved.subdivision_code);
    else c.unknown_subdivision_visitor_count += visitors; // 縣市已知，但這一列沒有明確 subdivision
  });

  let rows = [...countyMap.values()].map((c) => ({
    county_code: c.county_code, county_name: c.county_name,
    visitor_count: c.visitor_count,
    product_view_visitor_count: c.product_view_visitor_count,
    cart_visitor_count: c.cart_visitor_count,
    checkout_visitor_count: c.checkout_visitor_count,
    purchase_visitor_count: c.purchase_visitor_count,
    product_view_event_count: c.product_view_event_count,
    cart_event_count: c.cart_event_count,
    checkout_event_count: c.checkout_event_count,
    order_count: c.order_count,
    revenue: round2(c.revenue),
    visitor_to_cart_rate: _percent(c.cart_visitor_count, c.visitor_count),
    cart_to_purchase_rate: _percent(c.purchase_visitor_count, c.cart_visitor_count),
    visitor_to_purchase_rate: _percent(c.purchase_visitor_count, c.visitor_count),
    resolved_subdivision_count: c._subdivisionCodes.size,
    unknown_subdivision_visitor_count: c.unknown_subdivision_visitor_count,
  }));

  // fix18-10-hotfix30-B5-R5.2-A（六、county_code 篩選）：篩選發生在聚合之後
  // ——total/unknown 統計仍反映整店全部縣市（誠實記錄於 CHANGELOG，不偷偷
  // 把 unknown 也窄化到單一縣市，避免「縣市已篩選」跟「未知比例」兩個數字
  // 語意打架）。
  if (filters.countyCode) {
    rows = rows.filter((r) => r.county_code === filters.countyCode);
  }

  const totalVisitorsAllRows = rows.reduce((s, r) => s + r.visitor_count, 0) + unknownVisitorCount + unknownSubdivisionAcrossAll;
  const totalUnknown = unknownVisitorCount + unknownSubdivisionAcrossAll;

  const sortKey = (filters.sort && rows[0] && Object.prototype.hasOwnProperty.call(rows[0], filters.sort)) ? filters.sort : 'cart_visitor_count';
  const order = filters.order === 'asc' ? 1 : -1;
  rows.sort((a, b) => order * ((a[sortKey] || 0) - (b[sortKey] || 0)));
  const limited = filters.limit ? rows.slice(0, filters.limit) : rows;

  return {
    ok: true,
    rows: limited,
    unknown: {
      visitor_count: totalUnknown,
      percentage: _percent(totalUnknown, totalVisitorsAllRows),
    },
  };
}

function _percent(numerator, denominator) {
  const n = Number(numerator) || 0;
  const d = Number(denominator) || 0;
  if (d <= 0) return 0;
  const r = (n / d) * 100;
  return Number.isFinite(r) ? Math.round(r * 100) / 100 : 0;
}
function round2(n) { return Math.round((Number(n) || 0) * 100) / 100; }

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
  getCountySummary,
  geoHeatClassifyCoordinateConfidence,
};
