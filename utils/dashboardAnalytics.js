// utils/dashboardAnalytics.js — fix18-10-hotfix23-B
//
// GET /api/analytics/dashboard 的計算核心。只讀取既有的 orders 表與 Hotfix23-A 的
// analytics_events 表，不新增／不修改任何事件定義（依需求文件「不修改 Analytics 事件定義」）。
//
// 時區處理：見 utils/dashboardDate.js 開頭註解。orders.created_at 是 Asia/Taipei 本地字串，
// analytics_events.created_at 是 UTC 字串，查詢時用 ANALYTICS_CREATED_AT_LOCAL_EXPR 轉換。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');

// 訂單「已付款／有效」判斷，與既有 routes/dashboard.js 完全一致（不得另創新邏輯）
const ORDERS_BASE_WHERE = "store_id=? AND status!='void' AND (order_status IS NULL OR order_status!='cancelled')";
const ORDERS_PAID_EXPR = "(status IN ('completed','modified'))";

// ────────────────────────────────────────────────────────────────
// 1. KPI（沿用既有 routes/dashboard.js 邏輯，改成任意日期區間）
// ────────────────────────────────────────────────────────────────
function getKpi(db, storeId, range) {
  const where = `${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?`;
  const params = [storeId, range.startLocal, range.endLocal];
  const row = db.get(
    `SELECT COUNT(*) as total_orders,
            SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN 1 ELSE 0 END) as paid_orders,
            SUM(CASE WHEN NOT ${ORDERS_PAID_EXPR} THEN 1 ELSE 0 END) as unpaid_orders,
            COALESCE(SUM(CASE WHEN ${ORDERS_PAID_EXPR} THEN total ELSE 0 END),0) as revenue,
            COALESCE(AVG(CASE WHEN ${ORDERS_PAID_EXPR} THEN total END),0) as avg_order_value
     FROM orders WHERE ${where}`, params
  ) || {};
  const paymentStats = db.all(
    `SELECT COALESCE(payment_method,'cash') as payment_method, COUNT(*) as count,
            COALESCE(SUM(total),0) as revenue
     FROM orders WHERE ${where} GROUP BY payment_method ORDER BY revenue DESC`, params
  );
  const sourceStats = db.all(
    `SELECT COALESCE(order_mode,'dine_in') as mode, COALESCE(delivery_platform,'') as platform,
            COUNT(*) as count, COALESCE(SUM(total),0) as revenue
     FROM orders WHERE ${where} GROUP BY order_mode, delivery_platform ORDER BY count DESC`, params
  );
  const allOrders = db.all(`SELECT items FROM orders WHERE ${where}`, params);
  const productMap = {};
  allOrders.forEach(o => {
    try {
      JSON.parse(o.items || '[]').forEach(item => {
        const key = item.name;
        if (!productMap[key]) productMap[key] = { name: key, qty: 0, revenue: 0 };
        productMap[key].qty += Number(item.qty || 1);
        productMap[key].revenue += Number(item.subtotal || item.price * item.qty || 0);
      });
    } catch (e) {}
  });
  const topProducts = Object.values(productMap).sort((a, b) => b.qty - a.qty).slice(0, 10);

  return {
    revenue: Number(row.revenue || 0),
    orders: Number(row.total_orders || 0),
    avg_order_value: Number(row.avg_order_value || 0),
    paid_orders: Number(row.paid_orders || 0),
    unpaid_orders: Number(row.unpaid_orders || 0),
    is_today: range.preset === 'today',
    paymentStats, sourceStats, topProducts,
  };
}

// ────────────────────────────────────────────────────────────────
// 1b. 週/月營收（既有 KPI，維持「現在的本週／本月」語意，不隨日期篩選改變——
//     這是既有老闆儀表板一直以來的固定參考指標，與 preset 選擇的查詢區間是兩件事）
// ────────────────────────────────────────────────────────────────
function getFixedWeekMonth(db, storeId) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const mon = new Date(now); const dow = now.getDay();
  mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  const wStart = `${fmt(mon)} 00:00:00`;
  const mStart = `${fmt(new Date(now.getFullYear(), now.getMonth(), 1))} 00:00:00`;
  const nowStr = `${fmt(now)} ${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;

  const week = db.get(
    `SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND ${ORDERS_PAID_EXPR} AND created_at BETWEEN ? AND ?`,
    [storeId, wStart, nowStr]
  ) || {};
  const month = db.get(
    `SELECT COUNT(*) orders, COALESCE(SUM(total),0) revenue FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND ${ORDERS_PAID_EXPR} AND created_at BETWEEN ? AND ?`,
    [storeId, mStart, nowStr]
  ) || {};
  return {
    week_revenue: Number(week.revenue || 0), week_orders: Number(week.orders || 0),
    month_revenue: Number(month.revenue || 0), month_orders: Number(month.orders || 0),
  };
}

// ────────────────────────────────────────────────────────────────
// 2. 轉換漏斗（distinct visitor_id / order_id，不得用事件總次數）
// ────────────────────────────────────────────────────────────────
function getFunnel(db, storeId, range) {
  const evtWhere = `store_id=? AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?`;
  const p = (evt) => [storeId, evt, range.startLocal, range.endLocal];

  const distinctVisitors = (evt) => Number((db.get(
    `SELECT COUNT(DISTINCT visitor_id) c FROM analytics_events WHERE ${evtWhere}`, p(evt)
  ) || {}).c || 0);
  const distinctOrders = (evt) => Number((db.get(
    `SELECT COUNT(DISTINCT order_id) c FROM analytics_events WHERE ${evtWhere} AND order_id IS NOT NULL`, p(evt)
  ) || {}).c || 0);

  const stages = [
    { key: 'page_view', label: '進站', count: distinctVisitors('page_view') },
    { key: 'view_product', label: '商品瀏覽', count: distinctVisitors('view_product') },
    { key: 'add_to_cart', label: '加入購物車', count: distinctVisitors('add_to_cart') },
    { key: 'begin_checkout', label: '開始結帳', count: distinctVisitors('begin_checkout') },
    { key: 'submit_order', label: '送出訂單', count: distinctOrders('submit_order') },
    { key: 'purchase', label: '完成付款', count: distinctOrders('purchase') },
  ];

  const entryCount = stages[0].count;
  return stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].count : null;
    return {
      ...s,
      step_conversion_rate: prev !== null ? (prev > 0 ? round2(s.count / prev * 100) : null) : null,
      overall_conversion_rate: entryCount > 0 ? round2(s.count / entryCount * 100) : null,
    };
  });
}

function round2(n) { return Math.round(n * 100) / 100; }

// ────────────────────────────────────────────────────────────────
// 3. 近 5 分鐘狀態（永遠相對「現在」，不受日期篩選影響——這是即時性指標）
// ────────────────────────────────────────────────────────────────
function getRealtime(db, storeId) {
  // 近 5 分鐘：analytics_events.created_at 是 UTC，用資料庫自己的 UTC now 減 5 分鐘比較，
  // 不需要換算時區（同一個時鐘基準即可）。
  const rows = db.all(
    `SELECT session_id, event_name, MAX(created_at) as last_at
     FROM analytics_events
     WHERE store_id=? AND created_at >= datetime('now','-5 minutes')
     GROUP BY session_id
     ORDER BY last_at DESC`, [storeId]
  );
  // 每个 session 只留「最後一筆事件」，因為 GROUP BY session_id 配 MAX(created_at) 不保證
  // event_name 對應到那個時間點，這裡改用子查詢法更嚴謹一點：
  const sessions = db.all(
    `SELECT ae.session_id, ae.event_name
     FROM analytics_events ae
     INNER JOIN (
       SELECT session_id, MAX(created_at) as max_created
       FROM analytics_events
       WHERE store_id=? AND created_at >= datetime('now','-5 minutes')
       GROUP BY session_id
     ) latest ON latest.session_id=ae.session_id AND latest.max_created=ae.created_at
     WHERE ae.store_id=?`, [storeId, storeId]
  );
  const online = new Set();
  let browsing = 0, inCart = 0, paying = 0;
  const cartEvents = new Set(['add_to_cart', 'remove_from_cart', 'begin_checkout']);
  sessions.forEach(s => {
    if (online.has(s.session_id)) return; // 同一 session 若有多筆同時間戳，只算一次
    online.add(s.session_id);
    if (s.event_name === 'view_product') browsing++;
    else if (cartEvents.has(s.event_name)) inCart++;
    else if (s.event_name === 'payment_started') paying++;
  });
  return {
    window: '近 5 分鐘',
    online: online.size,
    browsing_product: browsing,
    in_cart: inCart,
    paying,
  };
}

// ────────────────────────────────────────────────────────────────
// 4. 購物車分析
// ────────────────────────────────────────────────────────────────
function getCartAnalysis(db, storeId, range) {
  // 加入購物車人數（distinct visitor）
  const addToCartVisitors = Number((db.get(
    `SELECT COUNT(DISTINCT visitor_id) c FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  // 有效 cart_id 清單（該區間內有 add_to_cart 且 cart_id 非空）
  const carts = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND cart_id IS NOT NULL AND cart_id != ''
       AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ).map(r => r.cart_id);

  if (!carts.length) {
    return {
      add_to_cart_visitors: addToCartVisitors,
      completed_carts: 0, incomplete_carts: 0, abandonment_rate: null,
      estimated_abandoned_amount: 0, avg_dwell_seconds: null,
      abandon_time_buckets: emptyBuckets(),
      note: carts.length === 0 ? '此區間尚無購物車事件' : null,
    };
  }

  const placeholders = carts.map(() => '?').join(',');
  // 哪些 cart_id 有 purchase（完成購買）
  const purchasedCarts = new Set(db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND cart_id IN (${placeholders})`,
    [storeId, ...carts]
  ).map(r => r.cart_id));

  const completedCarts = purchasedCarts.size;
  const incompleteCartIds = carts.filter(c => !purchasedCarts.has(c));
  const incompleteCarts = incompleteCartIds.length;
  const abandonmentRate = carts.length > 0 ? round2(incompleteCarts / carts.length * 100) : null;

  // 未完成購物車估計金額：用該 cart_id 底下 add_to_cart 事件的 product_id + quantity，
  // 對照目前 products 表現價估算（商品已下架則跳過該項，不報錯）
  let estimatedAmount = 0;
  if (incompleteCartIds.length) {
    const icPlaceholders = incompleteCartIds.map(() => '?').join(',');
    const cartItems = db.all(
      `SELECT cart_id, product_id, SUM(quantity) as qty
       FROM analytics_events
       WHERE store_id=? AND event_name='add_to_cart' AND cart_id IN (${icPlaceholders}) AND product_id IS NOT NULL
       GROUP BY cart_id, product_id`,
      [storeId, ...incompleteCartIds]
    );
    const productIds = [...new Set(cartItems.map(r => r.product_id))];
    let priceMap = {};
    if (productIds.length) {
      const ppPlaceholders = productIds.map(() => '?').join(',');
      db.all(`SELECT id, price FROM products WHERE store_id=? AND id IN (${ppPlaceholders})`, [storeId, ...productIds])
        .forEach(p => { priceMap[p.id] = Number(p.price || 0); });
    }
    cartItems.forEach(ci => {
      const price = priceMap[ci.product_id];
      if (price !== undefined) estimatedAmount += price * Number(ci.qty || 0);
      // 商品已下架（找不到價格）→ 該項目跳過，不計入估算金額，也不報錯
    });
  }

  // 平均停留時間：該 cart_id 第一筆事件到最後一筆事件的秒差，取平均（僅限有 ≥2 筆事件的購物車）
  const dwellRows = db.all(
    `SELECT cart_id, MIN(created_at) as first_at, MAX(created_at) as last_at, COUNT(*) as cnt
     FROM analytics_events
     WHERE store_id=? AND cart_id IN (${placeholders})
     GROUP BY cart_id HAVING cnt >= 2`,
    [storeId, ...carts]
  );
  let avgDwellSeconds = null;
  if (dwellRows.length) {
    const total = dwellRows.reduce((sum, r) => {
      const diffSec = (new Date(r.last_at.replace(' ', 'T') + 'Z') - new Date(r.first_at.replace(' ', 'T') + 'Z')) / 1000;
      return sum + Math.max(0, diffSec);
    }, 0);
    avgDwellSeconds = Math.round(total / dwellRows.length);
  }

  // 放棄時間桶：未完成購物車「最後一次事件」距離現在的時間
  const buckets = emptyBuckets();
  if (incompleteCartIds.length) {
    const icPlaceholders2 = incompleteCartIds.map(() => '?').join(',');
    const lastEvt = db.all(
      `SELECT cart_id, MAX(created_at) as last_at FROM analytics_events
       WHERE store_id=? AND cart_id IN (${icPlaceholders2}) GROUP BY cart_id`,
      [storeId, ...incompleteCartIds]
    );
    const now = Date.now();
    lastEvt.forEach(r => {
      const lastMs = new Date(r.last_at.replace(' ', 'T') + 'Z').getTime();
      const minutesAgo = (now - lastMs) / 60000;
      if (minutesAgo <= 30) buckets['30分鐘內']++;
      else if (minutesAgo <= 60) buckets['30分鐘~1小時']++;
      else if (minutesAgo <= 60 * 24) buckets['1~24小時']++;
      else if (minutesAgo <= 60 * 24 * 3) buckets['1~3天']++;
      else if (minutesAgo <= 60 * 24 * 7) buckets['3~7天']++;
      else buckets['7天以上']++;
    });
  }

  return {
    add_to_cart_visitors: addToCartVisitors,
    completed_carts: completedCarts,
    incomplete_carts: incompleteCarts,
    abandonment_rate: abandonmentRate,
    estimated_abandoned_amount: Math.round(estimatedAmount),
    avg_dwell_seconds: avgDwellSeconds,
    abandon_time_buckets: buckets,
  };
}
function emptyBuckets() {
  return { '30分鐘內': 0, '30分鐘~1小時': 0, '1~24小時': 0, '1~3天': 0, '3~7天': 0, '7天以上': 0 };
}

// ────────────────────────────────────────────────────────────────
// 5. 商品轉換排行
// ────────────────────────────────────────────────────────────────
function getProductRanking(db, storeId, range) {
  const p = [storeId, range.startLocal, range.endLocal];
  const viewRows = db.all(
    `SELECT product_id, COUNT(DISTINCT visitor_id) c FROM analytics_events
     WHERE store_id=? AND event_name='view_product' AND product_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY product_id`, p
  );
  const cartRows = db.all(
    `SELECT product_id, COUNT(DISTINCT visitor_id) people, SUM(quantity) qty FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND product_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY product_id`, p
  );
  // 成交：透過 purchase 事件的 order_id 反查該訂單 items（analytics_events 本身 purchase
  // 不帶 product_id 明細，商品層級成交要從 orders.items 反查，避免修改事件定義）
  const purchaseOrderIds = db.all(
    `SELECT DISTINCT order_id FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.order_id);

  const purchaseMap = {}; // product_id(by name match) -> {people:Set, qty}
  if (purchaseOrderIds.length) {
    const placeholders = purchaseOrderIds.map(() => '?').join(',');
    const orders = db.all(`SELECT uuid, items FROM orders WHERE store_id=? AND uuid IN (${placeholders})`, [storeId, ...purchaseOrderIds]);
    orders.forEach(o => {
      try {
        JSON.parse(o.items || '[]').forEach(item => {
          const pid = item.product_id;
          if (pid === undefined || pid === null) return;
          if (!purchaseMap[pid]) purchaseMap[pid] = { orderSet: new Set(), qty: 0 };
          purchaseMap[pid].orderSet.add(o.uuid);
          purchaseMap[pid].qty += Number(item.qty || 1);
        });
      } catch (e) {}
    });
  }

  const allProductIds = new Set([
    ...viewRows.map(r => r.product_id),
    ...cartRows.map(r => r.product_id),
    ...Object.keys(purchaseMap).map(Number),
  ]);
  if (!allProductIds.size) return [];

  const idList = [...allProductIds];
  const placeholders2 = idList.map(() => '?').join(',');
  const productInfo = {};
  db.all(`SELECT id, name FROM products WHERE store_id=? AND id IN (${placeholders2})`, [storeId, ...idList])
    .forEach(pr => { productInfo[pr.id] = pr.name; });

  const viewMap = Object.fromEntries(viewRows.map(r => [r.product_id, r.c]));
  const cartMap = Object.fromEntries(cartRows.map(r => [r.product_id, { people: r.people, qty: r.qty }]));

  return idList.map(pid => {
    const viewCount = Number(viewMap[pid] || 0);
    const cartInfo = cartMap[pid] || { people: 0, qty: 0 };
    const purch = purchaseMap[pid] || { orderSet: new Set(), qty: 0 };
    const purchasePeople = purch.orderSet.size;
    const cartPeople = Number(cartInfo.people || 0);
    const notPurchasedPeople = Math.max(0, cartPeople - purchasePeople);
    return {
      product_id: pid,
      product_name: productInfo[pid] || `已下架商品 #${pid}`,
      is_delisted: !productInfo[pid],
      view_people: viewCount,
      cart_people: cartPeople,
      cart_qty: Number(cartInfo.qty || 0),
      purchase_people: purchasePeople,
      purchase_qty: Number(purch.qty || 0),
      not_purchased_people: notPurchasedPeople,
      cart_to_purchase_rate: cartPeople > 0 ? round2(purchasePeople / cartPeople * 100) : null,
    };
  });
}

// ────────────────────────────────────────────────────────────────
// 6. 付款流程分析
// ────────────────────────────────────────────────────────────────
// payment_started 事件本身不帶 payment_method（Hotfix23-A 事件定義未收集這個欄位，本期
// 不修改事件定義），因此用 cart_id 當橋樑：payment_started.cart_id === submit_order.cart_id
// （同一次結帳流程 cart_id 不變），再從 submit_order.order_id 查 orders.payment_method。
function getPayments(db, storeId, range) {
  const p = [storeId, range.startLocal, range.endLocal];

  const startedCarts = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='payment_started' AND cart_id IS NOT NULL AND cart_id != ''
       AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.cart_id);

  if (!startedCarts.length) {
    return { rows: [], note: '此區間尚無付款開始事件' };
  }

  const placeholders = startedCarts.map(() => '?').join(',');
  const bridgeRows = db.all(
    `SELECT cart_id, order_id FROM analytics_events
     WHERE store_id=? AND event_name='submit_order' AND cart_id IN (${placeholders})`,
    [storeId, ...startedCarts]
  );
  const cartToOrder = Object.fromEntries(bridgeRows.map(r => [r.cart_id, r.order_id]));
  const orderIds = [...new Set(Object.values(cartToOrder).filter(Boolean))];

  let orderInfo = {};
  if (orderIds.length) {
    const opl = orderIds.map(() => '?').join(',');
    db.all(`SELECT uuid, payment_method FROM orders WHERE store_id=? AND uuid IN (${opl})`, [storeId, ...orderIds])
      .forEach(o => { orderInfo[o.uuid] = o.payment_method || 'unknown'; });
  }
  const purchasedOrderIds = new Set(orderIds.length ? db.all(
    `SELECT DISTINCT order_id FROM analytics_events WHERE store_id=? AND event_name='purchase' AND order_id IN (${orderIds.map(()=>'?').join(',')})`,
    [storeId, ...orderIds]
  ).map(r => r.order_id) : []);

  const byMethod = {}; // method -> {started, succeeded}
  startedCarts.forEach(cid => {
    const orderId = cartToOrder[cid];
    const method = orderId ? (orderInfo[orderId] || 'unknown') : 'unknown（未送出訂單）';
    if (!byMethod[method]) byMethod[method] = { started: 0, succeeded: 0 };
    byMethod[method].started++;
    if (orderId && purchasedOrderIds.has(orderId)) byMethod[method].succeeded++;
  });

  const rows = Object.entries(byMethod).map(([method, v]) => ({
    payment_method: method,
    started: v.started,
    succeeded: v.succeeded,
    failed_or_interrupted: v.started - v.succeeded,
    success_rate: v.started > 0 ? round2(v.succeeded / v.started * 100) : null,
  }));
  return { rows };
}

// ────────────────────────────────────────────────────────────────
// 7. 訂單來源分析（既有來源 + Analytics UTM 來源）
// ────────────────────────────────────────────────────────────────
function getSources(db, storeId, range, kpi) {
  // 既有來源（沿用 orders.order_mode/delivery_platform，已在 getKpi 內算過，這裡直接複用）
  const existingSources = kpi.sourceStats;

  // Analytics 來源：以 page_view 的 distinct visitor 為準（沒有 UTM 時 source 已是
  // 'direct'/'unknown'，由 Hotfix23-A 前端 _deriveSource() 決定，這裡不偽造）
  const analyticsSources = db.all(
    `SELECT COALESCE(NULLIF(source,''),'unknown') as source, COUNT(DISTINCT visitor_id) as visitors
     FROM analytics_events
     WHERE store_id=? AND event_name='page_view' AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY source ORDER BY visitors DESC`,
    [storeId, range.startLocal, range.endLocal]
  );
  return { order_sources: existingSources, analytics_sources: analyticsSources };
}

// ────────────────────────────────────────────────────────────────
// 8. 回購分析（以電話辨識，同店不跨店合併）
// ────────────────────────────────────────────────────────────────
function getRepeatCustomers(db, storeId, range) {
  const where = `${ORDERS_BASE_WHERE} AND ${ORDERS_PAID_EXPR} AND created_at BETWEEN ? AND ? AND customer_phone IS NOT NULL AND customer_phone != ''`;
  const rows = db.all(
    `SELECT customer_phone, DATE(created_at) as d FROM orders WHERE ${where}`,
    [storeId, range.startLocal, range.endLocal]
  );
  if (!rows.length) {
    return {
      new_customers: 0, repeat_customers: 0, new_ratio: null, repeat_ratio: null,
      avg_repeat_days: null, identifiable_customers: 0,
    };
  }
  const byPhone = {};
  rows.forEach(r => {
    if (!byPhone[r.customer_phone]) byPhone[r.customer_phone] = new Set();
    byPhone[r.customer_phone].add(r.d); // 同一天多筆訂單只算一個「日」，避免同日加購誤算
  });
  let newCustomers = 0, repeatCustomers = 0, repeatDaySpanTotal = 0;
  Object.values(byPhone).forEach(daySet => {
    if (daySet.size >= 2) {
      repeatCustomers++;
      const days = [...daySet].sort();
      const span = (new Date(days[days.length - 1]) - new Date(days[0])) / 86400000;
      repeatDaySpanTotal += span;
    } else {
      newCustomers++;
    }
  });
  const identifiable = Object.keys(byPhone).length;
  return {
    new_customers: newCustomers,
    repeat_customers: repeatCustomers,
    new_ratio: identifiable > 0 ? round2(newCustomers / identifiable * 100) : null,
    repeat_ratio: identifiable > 0 ? round2(repeatCustomers / identifiable * 100) : null,
    avg_repeat_days: repeatCustomers > 0 ? round2(repeatDaySpanTotal / repeatCustomers) : null,
    identifiable_customers: identifiable,
  };
}

// ────────────────────────────────────────────────────────────────
// 9. 未完成訂單分析
// ────────────────────────────────────────────────────────────────
function getIncomplete(db, storeId, range) {
  const p = [storeId, range.startLocal, range.endLocal];

  // 購物車未結帳：有 add_to_cart，但同一 cart_id 沒有 begin_checkout
  const cartsWithAdd = new Set(db.all(
    `SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='add_to_cart'
       AND cart_id IS NOT NULL AND cart_id!='' AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.cart_id));
  const cartsWithCheckout = new Set(db.all(
    `SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='begin_checkout'
       AND cart_id IS NOT NULL AND cart_id!='' AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.cart_id));
  const cartsWithSubmit = new Set(db.all(
    `SELECT DISTINCT cart_id FROM analytics_events WHERE store_id=? AND event_name='submit_order'
       AND cart_id IS NOT NULL AND cart_id!='' AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.cart_id));

  const cartNotCheckedOut = [...cartsWithAdd].filter(c => !cartsWithCheckout.has(c)).length;
  const checkoutNotSubmitted = [...cartsWithCheckout].filter(c => !cartsWithSubmit.has(c)).length;

  // 已送單等待付款：submit_order 有，但 purchase 沒有（同一 order_id）
  const submittedOrderIds = new Set(db.all(
    `SELECT DISTINCT order_id FROM analytics_events WHERE store_id=? AND event_name='submit_order'
       AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.order_id));
  const purchasedOrderIds = new Set(db.all(
    `SELECT DISTINCT order_id FROM analytics_events WHERE store_id=? AND event_name='purchase'
       AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.order_id));
  const awaitingPaymentIds = [...submittedOrderIds].filter(id => !purchasedOrderIds.has(id));
  const awaitingPayment = awaitingPaymentIds.length;

  // LINE Pay 中斷：上面 awaiting 中，payment_method='linepay' 的子集
  let linepayInterrupted = 0;
  if (awaitingPaymentIds.length) {
    const opl = awaitingPaymentIds.map(() => '?').join(',');
    linepayInterrupted = Number((db.get(
      `SELECT COUNT(*) c FROM orders WHERE store_id=? AND uuid IN (${opl}) AND payment_method='linepay'`,
      [storeId, ...awaitingPaymentIds]
    ) || {}).c || 0);
  }

  // 待確認宅配訂單：order_mode='shipping'，order_status 仍是 pending（尚未人工確認/出貨）
  const pendingShipping = Number((db.get(
    `SELECT COUNT(*) c FROM orders WHERE store_id=? AND order_mode='shipping'
       AND (order_status IS NULL OR order_status='pending') AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  return {
    cart_not_checked_out: cartNotCheckedOut,
    checkout_not_submitted: checkoutNotSubmitted,
    awaiting_payment: awaitingPayment,
    linepay_interrupted: linepayInterrupted,
    pending_shipping_confirmation: pendingShipping,
  };
}

// ────────────────────────────────────────────────────────────────
// 10. 經營健康度
// ────────────────────────────────────────────────────────────────
// 權重：營收達成度 30／訪客→購買轉換率 25／購物車完成率 20／回購率 15／付款成功率 10
// 資料不足時明確列出缺少項目，不直接算 0 分。
function getHealthScore(kpi, funnel, cart, repeat, payments, opts = {}) {
  const missing = [];
  let score = 0;

  // 營收達成度：需要「目標營收」才能算達成度，本期沒有目標營收設定功能 → 一律視為資料不足
  const revenueTarget = opts.revenueTarget || null;
  let revenueScore = null;
  if (revenueTarget && revenueTarget > 0) {
    revenueScore = Math.min(30, round2(kpi.revenue / revenueTarget * 30));
  } else {
    missing.push('營收目標（尚未設定，無法計算營收達成度）');
  }

  // 訪客→購買轉換率：需要「進站」distinct visitor > 0
  const entry = funnel[0].count;
  const purchaseStage = funnel[funnel.length - 1].count;
  let convScore = null;
  if (entry > 0) {
    const rate = purchaseStage / entry; // 0~1
    convScore = round2(Math.min(1, rate) * 25);
  } else {
    missing.push('進站人數（此區間尚無 page_view 事件）');
  }

  // 購物車完成率
  let cartScore = null;
  const totalCarts = cart.completed_carts + cart.incomplete_carts;
  if (totalCarts > 0) {
    cartScore = round2((cart.completed_carts / totalCarts) * 20);
  } else {
    missing.push('購物車事件（此區間尚無 add_to_cart 事件）');
  }

  // 回購率
  let repeatScore = null;
  if (repeat.identifiable_customers > 0) {
    repeatScore = round2((repeat.repeat_ratio || 0) / 100 * 15);
  } else {
    missing.push('可辨識顧客（此區間尚無帶電話的已完成訂單）');
  }

  // 付款成功率
  let paymentScore = null;
  const totalStarted = (payments.rows || []).reduce((s, r) => s + r.started, 0);
  const totalSucceeded = (payments.rows || []).reduce((s, r) => s + r.succeeded, 0);
  if (totalStarted > 0) {
    paymentScore = round2((totalSucceeded / totalStarted) * 10);
  } else {
    missing.push('付款開始事件（此區間尚無 payment_started 事件）');
  }

  const parts = [revenueScore, convScore, cartScore, repeatScore, paymentScore];
  const validParts = parts.filter(p => p !== null);

  if (missing.length >= 3) {
    // 太多缺項，整體視為資料不足，不硬湊分數
    return { score: null, status: 'insufficient_data', missing };
  }

  // 依「有資料的權重項目」等比例重新正規化到 100 分，避免因缺項被拖累成假分數
  const weightMap = { 0: 30, 1: 25, 2: 20, 3: 15, 4: 10 };
  let earned = 0, availableWeight = 0;
  parts.forEach((val, idx) => {
    if (val !== null) { earned += val; availableWeight += weightMap[idx]; }
  });
  const finalScore = availableWeight > 0 ? Math.round(earned / availableWeight * 100) : null;

  return {
    score: finalScore,
    status: finalScore === null ? 'insufficient_data' : (finalScore >= 80 ? 'good' : finalScore >= 60 ? 'ok' : 'warning'),
    missing: missing.length ? missing : undefined,
    breakdown: {
      revenue_achievement: revenueScore,
      visitor_to_purchase: convScore,
      cart_completion: cartScore,
      repeat_rate: repeatScore,
      payment_success: paymentScore,
    },
  };
}

// ────────────────────────────────────────────────────────────────
// 11. 規則式經營建議（不呼叫 AI API，純規則，每條需附觸發數據）
// ────────────────────────────────────────────────────────────────
function getRecommendations(funnel, cart, payments, repeat) {
  const recs = [];
  const pv = funnel.find(f => f.key === 'page_view').count;
  const vp = funnel.find(f => f.key === 'view_product').count;
  const atc = funnel.find(f => f.key === 'add_to_cart').count;
  const bc = funnel.find(f => f.key === 'begin_checkout').count;

  if (pv >= 20 && vp > 0 && vp / pv < 0.3) {
    recs.push({
      text: '訪客多但商品瀏覽偏低，首頁或商品圖片吸引力可能不足',
      metric: `進站 ${pv} 人，商品瀏覽 ${vp} 人（${round2(vp/pv*100)}%）`,
    });
  }
  if (vp >= 20 && atc > 0 && atc / vp < 0.2) {
    recs.push({
      text: '商品瀏覽多但加購偏低，價格、規格或商品說明可能不夠吸引',
      metric: `商品瀏覽 ${vp} 人，加入購物車 ${atc} 人（${round2(atc/vp*100)}%）`,
    });
  }
  if (atc >= 10 && bc > 0 && bc / atc < 0.3) {
    recs.push({
      text: '加購多但開始結帳偏低，運費資訊或購物車流程可能造成阻力',
      metric: `加入購物車 ${atc} 人，開始結帳 ${bc} 人（${round2(bc/atc*100)}%）`,
    });
  }
  (payments.rows || []).forEach(r => {
    if (r.started >= 5 && r.success_rate !== null && r.success_rate < 60) {
      recs.push({
        text: `「${r.payment_method}」付款開始多但成功率偏低，金流或付款方式可能有問題`,
        metric: `開始付款 ${r.started} 次，成功 ${r.succeeded} 次（成功率 ${r.success_rate}%）`,
      });
    }
  });
  if (cart.incomplete_carts >= 5 && cart.abandonment_rate !== null && cart.abandonment_rate > 60) {
    recs.push({
      text: '購物車放棄率偏高，建議檢查運費、免運門檻、最低訂購金額',
      metric: `未完成購物車 ${cart.incomplete_carts} 個，放棄率 ${cart.abandonment_rate}%`,
    });
  }
  if (repeat.identifiable_customers >= 10 && repeat.repeat_ratio !== null && repeat.repeat_ratio < 20) {
    recs.push({
      text: '回購率偏低，建議推出回購券或加強 LINE 會員提醒',
      metric: `可辨識顧客 ${repeat.identifiable_customers} 人，回購占比 ${repeat.repeat_ratio}%`,
    });
  }
  return recs;
}

// ────────────────────────────────────────────────────────────────
// 12. fix18-10-hotfix23-C｜Dashboard V3 附加運算
//     （全部只讀取既有資料來源／既有 getXxx() 結果，不新增資料表、
//      不重複打既有 API，單純在同一次 /api/analytics/dashboard 回應裡
//      多附加幾個欄位。）
// ────────────────────────────────────────────────────────────────

// 12a. 上一期間（同長度、緊接在目前查詢區間之前）——供 KPI 成長比較使用
function getPreviousRange(range) {
  const spanDays = Math.round((new Date(range.end_date) - new Date(range.start_date)) / 86400000) + 1;
  const prevEnd = new Date(range.start_date); prevEnd.setDate(prevEnd.getDate() - 1);
  const prevStart = new Date(prevEnd); prevStart.setDate(prevStart.getDate() - (spanDays - 1));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start_date = fmt(prevStart), end_date = fmt(prevEnd);
  return {
    preset: range.preset, start_date, end_date, timezone: range.timezone,
    startLocal: `${start_date} 00:00:00`,
    endLocal: `${end_date} 23:59:59`, // 上一期間必定已結束，不會有「累積到目前時間」的情況
  };
}

// 12b. KPI 成長比較（▲／▼／—、百分比、顏色）
function _trend(curr, prev) {
  if (prev === 0 || prev === null || prev === undefined) {
    if (curr > 0) return { delta_pct: null, arrow: '▲', color: 'green', note: '上一期間無資料，無法計算百分比' };
    return { delta_pct: null, arrow: '—', color: 'gray', note: null };
  }
  const pct = round2((curr - prev) / prev * 100);
  if (pct > 0) return { delta_pct: pct, arrow: '▲', color: 'green', note: null };
  if (pct < 0) return { delta_pct: pct, arrow: '▼', color: 'red', note: null };
  return { delta_pct: 0, arrow: '—', color: 'gray', note: null };
}
function getKpiComparison(currentKpi, previousKpi) {
  const fields = ['revenue', 'orders', 'avg_order_value', 'paid_orders', 'unpaid_orders'];
  const out = {};
  fields.forEach(f => {
    const curr = Number(currentKpi[f] || 0);
    const prev = Number(previousKpi[f] || 0);
    out[f] = { current: curr, previous: prev, diff: round2(curr - prev), ..._trend(curr, prev) };
  });
  return out;
}

// 12c. 經營健康度 V2（星級拆解，供首頁「★★★★★」呈現）
// 星級只是既有健康度子分數的可視化重新分級，不另外重算一套規則。
function _toStars(value, thresholds) {
  // thresholds: [t5,t4,t3,t2]，value 越大分數越高
  if (value === null || value === undefined) return null;
  if (value >= thresholds[0]) return 5;
  if (value >= thresholds[1]) return 4;
  if (value >= thresholds[2]) return 3;
  if (value >= thresholds[3]) return 2;
  return 1;
}
function getHealthScoreV2(kpiComparison, funnel, cart, repeat, payments, healthScoreV1) {
  const revenueGrowthPct = kpiComparison.revenue.delta_pct;
  const revenueStars = revenueGrowthPct === null ? null : _toStars(revenueGrowthPct, [20, 10, 0, -10]);

  const entry = funnel[0] ? funnel[0].count : 0;
  const purchase = funnel[funnel.length - 1] ? funnel[funnel.length - 1].count : 0;
  const convRate = entry > 0 ? purchase / entry * 100 : null;
  const conversionStars = convRate === null ? null : _toStars(convRate, [5, 3, 1.5, 0.5]);

  const repeatStars = (repeat && repeat.identifiable_customers > 0)
    ? _toStars(repeat.repeat_ratio || 0, [40, 25, 15, 5]) : null;

  let abandonStars = null;
  if (cart && !cart.insufficient_data && cart.abandonment_rate !== null && cart.abandonment_rate !== undefined) {
    // 放棄率越低越好，反向對應星級
    abandonStars = _toStars(100 - cart.abandonment_rate, [70, 55, 40, 25]);
  }

  const linepayRow = (payments.rows || []).find(r => r.payment_method === 'linepay');
  const linepayStars = (linepayRow && linepayRow.started > 0 && linepayRow.success_rate !== null)
    ? _toStars(linepayRow.success_rate, [90, 75, 60, 40]) : null;

  const dims = [
    { key: 'revenue', label: '營收', stars: revenueStars },
    { key: 'conversion', label: '轉換率', stars: conversionStars },
    { key: 'repeat', label: '回購率', stars: repeatStars },
    { key: 'abandonment', label: '放棄率', stars: abandonStars },
    { key: 'linepay', label: 'LINE Pay', stars: linepayStars },
  ];
  const available = dims.filter(d => d.stars !== null);
  const overallScore = available.length
    ? Math.round(available.reduce((s, d) => s + d.stars, 0) / available.length / 5 * 100)
    : (healthScoreV1 ? healthScoreV1.score : null);

  const alerts = [];
  if (abandonStars !== null && abandonStars <= 2) {
    alerts.push({
      text: '⚠ 今日購物車放棄率偏高',
      suggestions: ['降低外送門檻', '增加優惠券', '檢查付款流程'],
    });
  }
  if (linepayStars !== null && linepayStars <= 2) {
    alerts.push({
      text: '⚠ LINE Pay 今日成功率下降',
      suggestions: ['檢查金流設定', '確認 LINE Pay 服務狀態'],
    });
  }

  return {
    score: overallScore,
    status: overallScore === null ? 'insufficient_data' : (overallScore >= 80 ? 'good' : overallScore >= 60 ? 'ok' : 'warning'),
    dimensions: dims,
    alerts,
  };
}

// 12d. 近 30 天趨勢（營收／訂單／客單／回購率），單一查詢、不重複打既有 API
function getTrend30d(db, storeId) {
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const fmt = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const start = new Date(now); start.setDate(start.getDate() - 29);
  const startStr = `${fmt(start)} 00:00:00`;
  const endStr = `${fmt(now)} 23:59:59`;

  const rows = db.all(
    `SELECT DATE(created_at) as d, COALESCE(total,0) as total, customer_phone
     FROM orders
     WHERE ${ORDERS_BASE_WHERE} AND ${ORDERS_PAID_EXPR} AND created_at BETWEEN ? AND ?`,
    [storeId, startStr, endStr]
  );

  const byDay = {};
  for (let i = 0; i < 30; i++) {
    const d = new Date(start); d.setDate(d.getDate() + i);
    byDay[fmt(d)] = { date: fmt(d), revenue: 0, orders: 0, repeat_customers: 0, identifiable_customers: 0 };
  }
  rows.forEach(r => {
    if (byDay[r.d]) { byDay[r.d].revenue += Number(r.total || 0); byDay[r.d].orders += 1; }
  });

  // 回購率：每個電話號碼的「全店史上第一次消費日」，該日之後同電話再次出現即為回購
  const phones = [...new Set(rows.map(r => r.customer_phone).filter(Boolean))];
  let firstDateMap = {};
  if (phones.length) {
    const ph = phones.map(() => '?').join(',');
    db.all(
      `SELECT customer_phone, MIN(DATE(created_at)) as first_date FROM orders
       WHERE store_id=? AND status!='void' AND (order_status IS NULL OR order_status!='cancelled')
         AND ${ORDERS_PAID_EXPR} AND customer_phone IN (${ph}) GROUP BY customer_phone`,
      [storeId, ...phones]
    ).forEach(r => { firstDateMap[r.customer_phone] = r.first_date; });
  }
  const seenByDay = {}; // day -> Set(phone) 該日已計算過的顧客（去重，避免同日多筆訂單重複計算）
  rows.forEach(r => {
    if (!r.customer_phone || !byDay[r.d]) return;
    if (!seenByDay[r.d]) seenByDay[r.d] = new Set();
    if (seenByDay[r.d].has(r.customer_phone)) return;
    seenByDay[r.d].add(r.customer_phone);
    byDay[r.d].identifiable_customers++;
    if (firstDateMap[r.customer_phone] && firstDateMap[r.customer_phone] < r.d) {
      byDay[r.d].repeat_customers++;
    }
  });

  return Object.values(byDay).map(d => ({
    date: d.date,
    revenue: Math.round(d.revenue),
    orders: d.orders,
    avg_order_value: d.orders > 0 ? round2(d.revenue / d.orders) : 0,
    repeat_rate: d.identifiable_customers > 0 ? round2(d.repeat_customers / d.identifiable_customers * 100) : null,
  }));
}

// 12e. 商品分級（🔥爆款／⭐潛力／⚠低轉換）——沿用 getProductRanking() 的結果分類，不重打查詢
function getProductTiers(products) {
  if (!products || !products.length) return { hot: [], potential: [], low_conversion: [] };
  const withSales = products.filter(p => p.purchase_qty > 0);
  const hot = [...withSales].sort((a, b) => b.purchase_qty - a.purchase_qty).slice(0, 3).map(p => p.product_id);
  const potential = [];
  const lowConversion = [];
  products.forEach(p => {
    if (hot.includes(p.product_id)) return;
    if (p.cart_people >= 5 && p.cart_to_purchase_rate !== null) {
      if (p.cart_to_purchase_rate >= 15) potential.push(p.product_id);
      else lowConversion.push(p.product_id);
    }
  });
  return { hot, potential, low_conversion: lowConversion };
}

// 12f. 今日預估營收（規則式：目前營收 ÷ 已營業時間 × 今日總營業時間，不用 AI）
// 假設：預設營業時間 10:00～22:00（共 12 小時）。目前系統尚無「營業時間」設定欄位，
// 這是本階段的簡化假設，未來若加入營業時間設定，這裡直接替換常數即可。
const DEFAULT_BUSINESS_START_HOUR = 10;
const DEFAULT_BUSINESS_END_HOUR = 22;
function getForecast(kpi, range) {
  if (range.preset !== 'today') {
    return { applicable: false, message: '營收預估僅適用於「今日」區間' };
  }
  const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const nowHour = now.getHours() + now.getMinutes() / 60;
  const elapsed = Math.max(0.1, Math.min(nowHour - DEFAULT_BUSINESS_START_HOUR, DEFAULT_BUSINESS_END_HOUR - DEFAULT_BUSINESS_START_HOUR));
  const totalHours = DEFAULT_BUSINESS_END_HOUR - DEFAULT_BUSINESS_START_HOUR;
  const forecastRevenue = Math.round(Math.max(kpi.revenue, kpi.revenue / elapsed * totalHours));
  return {
    applicable: true,
    current_revenue: kpi.revenue,
    elapsed_hours: round2(elapsed),
    total_business_hours: totalHours,
    forecast_revenue: forecastRevenue,
  };
}

// 12g. 今日重點摘要（首頁「📌 今日重點」／「Good Evening 老闆」卡片用）
function getTodaySummary(realtime, forecast, kpi) {
  const topProduct = (kpi.topProducts && kpi.topProducts[0]) ? kpi.topProducts[0].name : null;
  return {
    ordering_now: (realtime.browsing_product || 0) + (realtime.in_cart || 0),
    paying_now: realtime.paying || 0,
    in_cart_now: realtime.in_cart || 0,
    forecast_revenue: forecast.applicable ? forecast.forecast_revenue : null,
    hot_product: topProduct,
  };
}

// 12h. 今日待處理事項（📋 首頁最上方）
function getTodoList(db, storeId, incomplete, repeat) {
  const todos = [];
  if (incomplete.linepay_interrupted > 0) {
    todos.push({ level: 'red', icon: '🔴', text: `${incomplete.linepay_interrupted} 筆 LINE Pay 中斷` });
  }
  const cartUnfinished = (incomplete.cart_not_checked_out || 0) + (incomplete.checkout_not_submitted || 0);
  if (cartUnfinished > 0) {
    todos.push({ level: 'yellow', icon: '🟡', text: `${cartUnfinished} 人購物車未完成` });
  }
  if (repeat && repeat.repeat_customers > 0) {
    todos.push({ level: 'green', icon: '🟢', text: `今日已有 ${repeat.repeat_customers} 位回購客` });
  }
  let lowStockCount = 0;
  try {
    lowStockCount = Number((db.get(
      `SELECT COUNT(*) c FROM products WHERE store_id=? AND enabled=1 AND inventory_enabled=1
         AND current_stock_grams <= low_stock_alert`, [storeId]
    ) || {}).c || 0);
  } catch (e) { lowStockCount = 0; }
  if (lowStockCount > 0) {
    todos.push({ level: 'orange', icon: '🟠', text: `${lowStockCount} 項商品庫存不足` });
  }
  return todos;
}

// 12i. 每日一句 AI 經營建議（Rule Based，從既有 recommendations／商品分級/購物車資料挑一條最重要的）
function getDailyTip(recommendations, productTiers, products, cart) {
  if (productTiers.hot.length) {
    const top = products.find(p => p.product_id === productTiers.hot[0]);
    if (top) return `今天「${top.product_name}」成交率最高，建議將其設為首頁主推商品。`;
  }
  if (cart && !cart.insufficient_data && cart.abandonment_rate !== null && cart.abandonment_rate > 60) {
    return '今日購物車放棄率偏高，建議提供 LINE Pay 優惠或免運活動。';
  }
  if (recommendations && recommendations.length) {
    return recommendations[0].text;
  }
  return null;
}

// ────────────────────────────────────────────────────────────────
// 13. fix18-10-hotfix23-D｜廣告來源分析（Last Touch／First Touch 一次算完）
//     沿用 analytics_events 既有欄位；First Touch 需要解析 metadata_json，
//     sql.js 對 JSON 函式支援有限，改在 JS 端解析（與既有 topProducts 解析
//     orders.items JSON 的做法一致）。解析失敗一律當作沒有 first_touch 資料，
//     不得讓整支 API 500（需求文件十四／十六）。
// ────────────────────────────────────────────────────────────────
const AD_SOURCE_STAGE_EVENTS = [
  ['page_view', 'visitor_id'],
  ['view_product', 'visitor_id'],
  ['add_to_cart', 'visitor_id'],
  ['begin_checkout', 'visitor_id'],
  ['submit_order', 'order_id'],
  ['purchase', 'order_id'],
];

function _safeParseMetadata(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return (parsed && typeof parsed === 'object') ? parsed : null;
  } catch (e) {
    return null; // 舊資料或壞資料一律當作沒有 metadata，不拋錯（需求文件十四）
  }
}

// 每個階段一次 SQL 查詢，同時依 (campaign, source) 分組——這一份結果同時拿來組
// 「來源漏斗表」（依 source 加總）與「Campaign 明細表」（camp+source 各自一列），
// 避免來源表、campaign 表各打一輪查詢（需求文件七／八：不得 N+1 query）。
function _lastTouchStageRows(db, storeId, range, eventName, distinctCol) {
  return db.all(
    `SELECT COALESCE(NULLIF(campaign,''),'（未設定活動）') as camp,
            COALESCE(NULLIF(source,''),'unknown') as src,
            COUNT(DISTINCT ${distinctCol}) as c
     FROM analytics_events
     WHERE store_id=? AND event_name=? AND ${distinctCol} IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY camp, src`,
    [storeId, eventName, range.startLocal, range.endLocal]
  );
}

// 廣告營收：只認 purchase 事件對應的真實 orders.total，來源判定用傳入的 sourceOf(orderId) 函式
// （這樣同一份 order_id 清單可以分別套用 last-touch／first-touch 的來源判斷邏輯）。
function _sumAdRevenue(db, storeId, purchaseOrderIds, sourceOf) {
  const adOrderIds = purchaseOrderIds.filter(id => {
    const src = sourceOf(id);
    return src && src !== 'direct' && src !== 'unknown';
  });
  if (!adOrderIds.length) return 0;
  const ph = adOrderIds.map(() => '?').join(',');
  const sum = db.get(
    `SELECT COALESCE(SUM(total),0) as revenue FROM orders WHERE store_id=? AND uuid IN (${ph})`,
    [storeId, ...adOrderIds]
  ) || {};
  return Math.round(Number(sum.revenue || 0));
}

function getAdsAttribution(db, storeId, range) {
  // ── Last Touch：6 個階段各一次 SQL group-by（camp, src）──────────
  const lastTouchRowsByStage = {};
  AD_SOURCE_STAGE_EVENTS.forEach(([evt, distinctCol]) => {
    lastTouchRowsByStage[evt] = _lastTouchStageRows(db, storeId, range, evt, distinctCol);
  });

  // ── First Touch：整批撈原始事件列，在 JS 端解析 metadata_json 分組 ──
  const rawRows = db.all(
    `SELECT event_name, visitor_id, order_id, metadata_json FROM analytics_events
     WHERE store_id=? AND event_name IN ('page_view','view_product','add_to_cart','begin_checkout','submit_order','purchase')
       AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  );
  let hasFirstTouchData = false;
  const distinctColByEvent = Object.fromEntries(AD_SOURCE_STAGE_EVENTS);
  // firstTouchRowsByStage[evt] 用 Map<camp|src, Set(distinctKey)>，格式與 last-touch 對齊
  const firstTouchSetsByStage = {};
  AD_SOURCE_STAGE_EVENTS.forEach(([evt]) => { firstTouchSetsByStage[evt] = {}; });
  // 記錄每個 order_id 的 first_touch source（供廣告營收判斷用）
  const orderFirstTouchSource = {};
  const orderLastTouchSource = {};
  rawRows.forEach(r => {
    const meta = _safeParseMetadata(r.metadata_json);
    const ft = meta && meta.first_touch ? meta.first_touch : null;
    const ftSource = ft && ft.source ? String(ft.source) : null;
    if (ftSource) hasFirstTouchData = true;
    const src = ftSource || 'unknown';
    const camp = (ft && ft.campaign) ? String(ft.campaign) : '（未設定活動）';
    const key = distinctColByEvent[r.event_name] === 'order_id' ? r.order_id : r.visitor_id;
    if (r.event_name === 'purchase' && r.order_id) orderFirstTouchSource[r.order_id] = src;
    if (!key) return;
    const mapKey = camp + '|' + src;
    if (!firstTouchSetsByStage[r.event_name][mapKey]) {
      firstTouchSetsByStage[r.event_name][mapKey] = { camp, src, set: new Set() };
    }
    firstTouchSetsByStage[r.event_name][mapKey].set.add(key);
  });
  // last-touch 的 purchase 來源／活動（廣告營收判斷＋分組用）——(camp,src) 分組後無法還原
  // 單筆 order_id，另外查一次單純 order_id+source+campaign 清單。
  const orderLastTouchCampaign = {};
  const orderFirstTouchCampaign = {};
  rawRows.forEach(r => {
    if (r.event_name !== 'purchase' || !r.order_id) return;
    const meta = _safeParseMetadata(r.metadata_json);
    const ft = meta && meta.first_touch ? meta.first_touch : null;
    orderFirstTouchCampaign[r.order_id] = (ft && ft.campaign) ? String(ft.campaign) : '（未設定活動）';
  });
  const purchaseOrderSourceRows = db.all(
    `SELECT DISTINCT order_id, COALESCE(NULLIF(source,''),'unknown') as src,
            COALESCE(NULLIF(campaign,''),'（未設定活動）') as camp
     FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  );
  purchaseOrderSourceRows.forEach(r => {
    orderLastTouchSource[r.order_id] = r.src;
    orderLastTouchCampaign[r.order_id] = r.camp;
  });
  const allPurchaseOrderIds = purchaseOrderSourceRows.map(r => r.order_id);

  // 一次查出所有相關訂單的 total，供「每一列（來源／活動）」的廣告營收欄位使用
  // （需求文件七／八：來源表、Campaign 表都要有「廣告營收」欄）。
  const orderTotalMap = {};
  if (allPurchaseOrderIds.length) {
    const ph = allPurchaseOrderIds.map(() => '?').join(',');
    db.all(
      `SELECT uuid, COALESCE(total,0) as total FROM orders WHERE store_id=? AND uuid IN (${ph})`,
      [storeId, ...allPurchaseOrderIds]
    ).forEach(r => { orderTotalMap[r.uuid] = Number(r.total || 0); });
  }
  function _revenueByKey(keyOf) {
    const map = {};
    allPurchaseOrderIds.forEach(id => {
      const key = keyOf(id);
      if (key === undefined || key === null) return;
      map[key] = (map[key] || 0) + (orderTotalMap[id] || 0);
    });
    return map;
  }
  const revenueBySourceLast = _revenueByKey(id => orderLastTouchSource[id]);
  const revenueBySourceFirst = _revenueByKey(id => orderFirstTouchSource[id]);
  const revenueByCampSrcLast = _revenueByKey(id => (orderLastTouchCampaign[id] || '（未設定活動）') + '|' + (orderLastTouchSource[id] || 'unknown'));
  const revenueByCampSrcFirst = _revenueByKey(id => (orderFirstTouchCampaign[id] || '（未設定活動）') + '|' + (orderFirstTouchSource[id] || 'unknown'));

  // ── 組表：來源漏斗（依 source 加總所有 campaign）──────────────
  function buildSourceTable(rowsByStage, revenueBySource) {
    const bySource = {}; // src -> { page_view, view_product, ... }
    AD_SOURCE_STAGE_EVENTS.forEach(([evt]) => {
      (rowsByStage[evt] || []).forEach(r => {
        const src = r.src;
        if (!bySource[src]) bySource[src] = {};
        bySource[src][evt] = (bySource[src][evt] || 0) + Number(r.c || 0);
      });
    });
    return Object.entries(bySource).map(([src, stages]) => {
      const entry = stages.page_view || 0;
      const purchase = stages.purchase || 0;
      return {
        source: src,
        entry,
        view_product: stages.view_product || 0,
        add_to_cart: stages.add_to_cart || 0,
        begin_checkout: stages.begin_checkout || 0,
        submit_order: stages.submit_order || 0,
        purchase,
        conversion_rate: entry > 0 ? round2(purchase / entry * 100) : null,
        ad_revenue: Math.round(revenueBySource[src] || 0),
      };
    }).sort((a, b) => b.entry - a.entry);
  }

  // ── 組表：Campaign 明細（camp + source 各一列）─────────────────
  function buildCampaignTable(rowsByStage, revenueByCampSrc) {
    const byCampSrc = {}; // "camp|src" -> { camp, src, stages }
    AD_SOURCE_STAGE_EVENTS.forEach(([evt]) => {
      (rowsByStage[evt] || []).forEach(r => {
        const key = r.camp + '|' + r.src;
        if (!byCampSrc[key]) byCampSrc[key] = { campaign: r.camp, source: r.src, stages: {} };
        byCampSrc[key].stages[evt] = (byCampSrc[key].stages[evt] || 0) + Number(r.c || 0);
      });
    });
    return Object.values(byCampSrc).map(row => {
      const entry = row.stages.page_view || 0;
      const purchase = row.stages.purchase || 0;
      const key = row.campaign + '|' + row.source;
      return {
        campaign: row.campaign,
        source: row.source,
        entry,
        view_product: row.stages.view_product || 0,
        add_to_cart: row.stages.add_to_cart || 0,
        begin_checkout: row.stages.begin_checkout || 0,
        submit_order: row.stages.submit_order || 0,
        purchase,
        conversion_rate: entry > 0 ? round2(purchase / entry * 100) : null,
        ad_revenue: Math.round(revenueByCampSrc[key] || 0),
      };
      // 排序規則（需求文件八）：完成付款最多 → 再按加購最多
    }).sort((a, b) => (b.purchase - a.purchase) || (b.add_to_cart - a.add_to_cart));
  }

  // first-touch rowsByStage 需要轉成跟 last-touch 同樣的 [{camp,src,c}] 陣列格式
  const firstTouchRowsByStage = {};
  Object.keys(firstTouchSetsByStage).forEach(evt => {
    firstTouchRowsByStage[evt] = Object.values(firstTouchSetsByStage[evt]).map(v => ({
      camp: v.camp, src: v.src, c: v.set.size,
    }));
  });

  const lastTouchSources = buildSourceTable(lastTouchRowsByStage, revenueBySourceLast);
  const lastTouchCampaigns = buildCampaignTable(lastTouchRowsByStage, revenueByCampSrcLast);
  const firstTouchSources = buildSourceTable(firstTouchRowsByStage, revenueBySourceFirst);
  const firstTouchCampaigns = buildCampaignTable(firstTouchRowsByStage, revenueByCampSrcFirst);

  const lastTouchRevenue = _sumAdRevenue(db, storeId, allPurchaseOrderIds, id => orderLastTouchSource[id]);
  const firstTouchRevenue = hasFirstTouchData
    ? _sumAdRevenue(db, storeId, allPurchaseOrderIds, id => orderFirstTouchSource[id])
    : 0;

  const firstTouchNote = hasFirstTouchData ? '' : 'First Touch 資料自 Hotfix23-D 上線後開始累積';

  return {
    // 預設模式（Last Touch）攤平在頂層，方便只需要單一模式的消費端直接使用
    mode: 'last_touch',
    sources: lastTouchSources,
    campaigns: lastTouchCampaigns,
    revenue: { last_touch: lastTouchRevenue, first_touch: firstTouchRevenue },
    first_touch_available: hasFirstTouchData,
    note: firstTouchNote,
    // 兩種模式的完整資料都給，前端切換只需要重新 render，不必再打一次 API（需求文件九第 4 點）
    by_mode: {
      last_touch: { sources: lastTouchSources, campaigns: lastTouchCampaigns, revenue: lastTouchRevenue },
      first_touch: hasFirstTouchData
        ? { sources: firstTouchSources, campaigns: firstTouchCampaigns, revenue: firstTouchRevenue }
        : { insufficient_data: true, message: firstTouchNote, sources: [], campaigns: [], revenue: 0 },
    },
  };
}

// ────────────────────────────────────────────────────────────────
// fix18-10-hotfix23-E：LINE 會員入口 × Customer Journey 漏斗
// 沿用 getFunnel() 同一套 COUNT(DISTINCT ...) 原則，不把事件次數當人數。
// 漏斗最後幾階（完成付款／首次購買／回購）改用 line_members 表本身的
// 累計欄位計算，因為那些欄位已經是「去重過的會員層級」統計，不需要再從
// analytics_events 重新聚合一次。
// ────────────────────────────────────────────────────────────────
function getLineMemberFunnel(db, storeId, range) {
  const evtWhere = `store_id=? AND event_name=? AND ${A_LOCAL} BETWEEN ? AND ?`;
  const p = (evt) => [storeId, evt, range.startLocal, range.endLocal];
  const distinctVisitors = (evt) => Number((db.get(
    `SELECT COUNT(DISTINCT visitor_id) c FROM analytics_events WHERE ${evtWhere}`, p(evt)
  ) || {}).c || 0);
  const distinctOrders = (evt) => Number((db.get(
    `SELECT COUNT(DISTINCT order_id) c FROM analytics_events WHERE ${evtWhere} AND order_id IS NOT NULL`, p(evt)
  ) || {}).c || 0);

  const loggedInMembers = Number((db.get(
    `SELECT COUNT(DISTINCT line_user_id) c FROM line_member_history
     WHERE store_id=? AND event_name='login' AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);
  const friendAddedMembers = Number((db.get(
    `SELECT COUNT(DISTINCT line_user_id) c FROM line_member_history
     WHERE store_id=? AND event_name IN ('friend_added','friend_restored') AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);
  const firstPurchaseMembers = Number((db.get(
    `SELECT COUNT(DISTINCT line_user_id) c FROM line_member_history
     WHERE store_id=? AND event_name='first_purchase' AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);
  const repeatPurchaseMembers = Number((db.get(
    `SELECT COUNT(DISTINCT line_user_id) c FROM line_member_history
     WHERE store_id=? AND event_name='repeat_purchase' AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  const stages = [
    { key: 'page_view', label: '進站', count: distinctVisitors('page_view') },
    { key: 'line_gate_view', label: '看到 LINE Gate', count: distinctVisitors('line_gate_view') },
    { key: 'line_login', label: 'LINE Login', count: loggedInMembers },
    { key: 'friend_added', label: '加入好友', count: friendAddedMembers },
    { key: 'add_to_cart', label: '加入購物車', count: distinctVisitors('add_to_cart') },
    { key: 'submit_order', label: '送出訂單', count: distinctOrders('submit_order') },
    { key: 'purchase', label: '完成付款', count: distinctOrders('purchase') },
    { key: 'first_purchase', label: '首次購買', count: firstPurchaseMembers },
    { key: 'repeat_purchase', label: '回購', count: repeatPurchaseMembers },
  ];
  const entryCount = stages[0].count;
  const mapped = stages.map((s, i) => {
    const prev = i > 0 ? stages[i - 1].count : null;
    return {
      ...s,
      step_conversion_rate: prev !== null ? (prev > 0 ? round2(s.count / prev * 100) : null) : null,
      overall_conversion_rate: entryCount > 0 ? round2(s.count / entryCount * 100) : null,
    };
  });

  // 首購營收／回購營收：從 history 的 metadata_json 取出 order_id 對應到 orders 表金額，
  // 不信任前端傳入的金額（recordMemberPurchase 寫入 history 時已用後端確認過的金額，
  // 這裡改讀 orders.total 是為了與其他營收欄位口徑一致，非重新採信前端）。
  const revByStage = (stageEvent) => Number((db.get(
    `SELECT COALESCE(SUM(o.total),0) v
     FROM line_member_history h
     JOIN orders o ON o.store_id=h.store_id AND o.id = json_extract(h.metadata_json,'$.order_id')
     WHERE h.store_id=? AND h.event_name=? AND h.created_at BETWEEN ? AND ?`,
    [storeId, stageEvent, range.startLocal, range.endLocal]
  ) || {}).v || 0);

  // 上面的 JOIN 依賴 SQLite JSON1 擴充功能（sql.js 已內建），若環境不支援則安全 fallback為 0
  let firstPurchaseRevenue = 0, repeatPurchaseRevenue = 0;
  try { firstPurchaseRevenue = revByStage('first_purchase'); } catch { firstPurchaseRevenue = 0; }
  try { repeatPurchaseRevenue = revByStage('repeat_purchase'); } catch { repeatPurchaseRevenue = 0; }

  // 會員營收／非會員營收：以 orders.line_user_id 是否有值區分，口徑與 getKpi()
  // 的 revenue 完全一致（同一 ORDERS_PAID_EXPR），確保兩者相加等於總營收。
  const memberRevenueRow = db.get(
    `SELECT COALESCE(SUM(CASE WHEN line_user_id IS NOT NULL AND line_user_id!='' AND ${ORDERS_PAID_EXPR} THEN total ELSE 0 END),0) as member_revenue,
            COALESCE(SUM(CASE WHEN (line_user_id IS NULL OR line_user_id='') AND ${ORDERS_PAID_EXPR} THEN total ELSE 0 END),0) as non_member_revenue
     FROM orders WHERE ${ORDERS_BASE_WHERE} AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {};

  return {
    stages: mapped,
    revenue: {
      member_revenue: round2(Number(memberRevenueRow.member_revenue || 0)),
      non_member_revenue: round2(Number(memberRevenueRow.non_member_revenue || 0)),
      first_purchase_revenue: round2(firstPurchaseRevenue),
      repeat_purchase_revenue: round2(repeatPurchaseRevenue),
    },
  };
}

// ────────────────────────────────────────────────────────────────
// fix18-10-hotfix23-E：會員生命週期 KPI（需求文件十二）
// ────────────────────────────────────────────────────────────────
function getLineCrmKpi(db, storeId, range) {
  const totals = db.get(
    `SELECT COUNT(*) as total_members,
            SUM(CASE WHEN is_friend=1 THEN 1 ELSE 0 END) as friends,
            SUM(CASE WHEN is_blocked=1 THEN 1 ELSE 0 END) as blocked,
            SUM(CASE WHEN is_blocked=0 AND friend_since!='' THEN 1 ELSE 0 END) as unblocked,
            SUM(CASE WHEN first_purchase_at!='' THEN 1 ELSE 0 END) as first_buyers,
            SUM(CASE WHEN order_count>1 THEN 1 ELSE 0 END) as repeat_buyers,
            COALESCE(SUM(total_spent),0) as member_revenue,
            COALESCE(AVG(CASE WHEN order_count>0 THEN total_spent/order_count END),0) as avg_member_order_value,
            COALESCE(AVG(lifetime_value),0) as avg_ltv
     FROM line_members WHERE store_id=?`,
    [storeId]
  ) || {};

  const loggedInMembers = Number((db.get(
    `SELECT COUNT(DISTINCT line_user_id) c FROM line_member_history
     WHERE store_id=? AND event_name='login' AND created_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  // 平均回購天數：同一會員 first_purchase_at → last_purchase_at 的天數平均（僅回購會員）
  const repeatDaysRow = db.get(
    `SELECT AVG(julianday(last_purchase_at) - julianday(first_purchase_at)) as avg_days
     FROM line_members WHERE store_id=? AND order_count>1 AND first_purchase_at!='' AND last_purchase_at!=''`,
    [storeId]
  ) || {};

  const totalMembers = Number(totals.total_members || 0);
  return {
    insufficient_data: totalMembers === 0,
    total_members: totalMembers,
    friends: Number(totals.friends || 0),
    blocked: Number(totals.blocked || 0),
    unblocked: Number(totals.unblocked || 0),
    logged_in_members: loggedInMembers,
    first_buyers: Number(totals.first_buyers || 0),
    repeat_buyers: Number(totals.repeat_buyers || 0),
    member_revenue: round2(Number(totals.member_revenue || 0)),
    avg_member_order_value: round2(Number(totals.avg_member_order_value || 0)),
    avg_repeat_days: totals.repeat_buyers > 0 && repeatDaysRow.avg_days != null ? round2(Number(repeatDaysRow.avg_days)) : null,
    avg_ltv: round2(Number(totals.avg_ltv || 0)),
  };
}

// ────────────────────────────────────────────────────────────────
// fix18-10-hotfix23-E：LINE CRM 健康度（需求文件十三）—— 純規則式，不呼叫 AI。
// 權重：好友率25／封鎖率20／登入率15／首購率20／回購率20
// ────────────────────────────────────────────────────────────────
function getLineCrmHealth(crmKpi) {
  if (!crmKpi || crmKpi.insufficient_data || !crmKpi.total_members) {
    return { insufficient_data: true, message: '資料不足，尚無足夠的 LINE 會員資料計算健康度', score: null, stars: null, breakdown: [], suggestions: [] };
  }
  const total = crmKpi.total_members;
  const friendRate = total > 0 ? crmKpi.friends / total : 0;
  const blockRate = total > 0 ? crmKpi.blocked / total : 0;
  const loginRate = total > 0 ? crmKpi.logged_in_members / total : 0;
  const firstBuyRate = crmKpi.logged_in_members > 0 ? crmKpi.first_buyers / crmKpi.logged_in_members : 0;
  const repeatRate = crmKpi.first_buyers > 0 ? crmKpi.repeat_buyers / crmKpi.first_buyers : 0;

  const friendScore = round2(Math.min(1, friendRate) * 25);
  const blockScore = round2(Math.max(0, 1 - blockRate) * 20);
  const loginScore = round2(Math.min(1, loginRate) * 15);
  const firstBuyScore = round2(Math.min(1, firstBuyRate) * 20);
  const repeatScore = round2(Math.min(1, repeatRate) * 20);
  const score = round2(friendScore + blockScore + loginScore + firstBuyScore + repeatScore);
  const stars = Math.max(1, Math.min(5, Math.round(score / 20)));

  const suggestions = [];
  if (blockRate >= 0.2) suggestions.push('最近 LINE 封鎖率偏高，建議降低推播頻率。');
  if (loginRate >= 0.3 && firstBuyRate < 0.2) suggestions.push('LINE 登入會員多，但首購率偏低，建議優化首次下單優惠。');
  if (firstBuyRate >= 0.3 && repeatRate < 0.2) suggestions.push('首購表現良好，但回購偏低，建議推出回購券或會員專屬活動。');
  if (friendRate >= 0.5 && loginRate < 0.2) suggestions.push('好友數高但登入會員偏低，建議調整 LINE 入口與登入引導。');

  return {
    insufficient_data: false,
    score, stars,
    breakdown: [
      { key: 'friend_rate', label: '好友率', value: round2(friendRate * 100), score: friendScore, max: 25 },
      { key: 'block_rate', label: '封鎖率', value: round2(blockRate * 100), score: blockScore, max: 20 },
      { key: 'login_rate', label: '登入率', value: round2(loginRate * 100), score: loginScore, max: 15 },
      { key: 'first_buy_rate', label: '首購率', value: round2(firstBuyRate * 100), score: firstBuyScore, max: 20 },
      { key: 'repeat_rate', label: '回購率', value: round2(repeatRate * 100), score: repeatScore, max: 20 },
    ],
    suggestions,
  };
}

module.exports = {
  getKpi, getFixedWeekMonth, getFunnel, getRealtime, getCartAnalysis, getProductRanking,
  getPayments, getSources, getRepeatCustomers, getIncomplete,
  getHealthScore, getRecommendations, round2,
  // fix18-10-hotfix23-C（Dashboard V3）
  getPreviousRange, getKpiComparison, getHealthScoreV2, getTrend30d,
  getProductTiers, getForecast, getTodaySummary, getTodoList, getDailyTip,
  // fix18-10-hotfix23-D（Ads Attribution Foundation）
  getAdsAttribution,
  // fix18-10-hotfix23-E（LINE 會員入口 × Customer Journey × CRM Health）
  getLineMemberFunnel, getLineCrmKpi, getLineCrmHealth,
  ORDERS_PAID_EXPR, ORDERS_BASE_WHERE,
};
