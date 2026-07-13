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

module.exports = {
  getKpi, getFixedWeekMonth, getFunnel, getRealtime, getCartAnalysis, getProductRanking,
  getPayments, getSources, getRepeatCustomers, getIncomplete,
  getHealthScore, getRecommendations, round2,
};
