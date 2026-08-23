// utils/analyticsV2.js — fix18-10-hotfix24-A｜POS Analytics V2
//
// 📊 POS Analytics V2｜營運分析中心 的計算核心。
//
// 最高原則（依需求文件一）：
//   - 不新增第二套 Analytics API，全部掛在既有 GET /api/analytics/dashboard 底下
//     （見 routes/analytics.js 的 analytics_v2 欄位）。
//   - 不新增資料表（analytics_dashboard / analytics_products / analytics_sources /
//     analytics_campaign / analytics_funnel / analytics_ai 一律不建立）。
//   - 全部由既有 analytics_events / orders / products / line_members 即時計算。
//   - 任何一段計算失敗都不得讓整支 API 500（呼叫端 routes/analytics.js 已用
//     try/catch 包住每一段，這裡的函式也對內部弱點做防禦）。
//   - 廣告成本（Cost/ROAS/CPA/CAC）尚未串接任何 Ads API，一律誠實顯示「尚未串接」，
//     絕不假造數字。

'use strict';

const { ANALYTICS_CREATED_AT_LOCAL_EXPR: A_LOCAL } = require('./dashboardDate');
const { round2, getProductRanking, channelEventsWhereClause } = require('./dashboardAnalytics');
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 二次修正）：canonical unique_users 必須重用既有的 Visitor 360／Drill Down
// 身份合併 resolver（fix18-10-hotfix31-R2），不得再用單純 COUNT(DISTINCT
// visitor_id) 當作「不重複人數」——那會把「同一位 LINE 會員在登入前後產生
// 的兩個不同匿名 visitor_id」誤算成兩個人。resolveCanonicalVisitor() 是
// per-key 查詢（見該檔案註解），這裡對「合格事件列去重後的 visitor_id
// 清單」逐一呼叫（不是逐事件呼叫，數量遠小於事件數），再依它回傳的
// canonical key（LINE 會員→line_user_id；未連結匿名訪客→維持原始
// visitor_id）去重，不另寫第二套合併演算法。
const { resolveCanonicalVisitor, resolveCanonicalVisitors, createCanonicalIdentityContext, resolveInContext } = require('./analyticsIdentity');

// 對一批「合格事件列」的 distinct visitor_id 清單，用既有 canonical identity
// batch resolver（resolveCanonicalVisitors，跟 Visitor 360 用的 per-key
// resolveCanonicalVisitor 共用同一套規則順序，只是批次查詢，不是逐 visitor
// 查詢，避免 O(visitor 數) 甚至 O(商品數×階段數×visitor數) 的 N+1）。
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 四次修正）：request-scoped identity cache——同一次 getProductFunnel()／
// getGlobalFunnelCanonicalMetrics() 呼叫內，同一個 visitor_id 只解析一次，
// 不管它出現在多少個商品、多少個 stage。呼叫端（getProductFunnel()）建立
// 一個 Map 傳給每一次 _canonicalUniqueUserCount()；沒有傳 cache 的
// standalone 呼叫端（例如既有測試直接呼叫底層 helper）仍會自動建立一個
// 只在該次呼叫內有效的暫時 cache，行為不變、不會缺東西。
function _canonicalUniqueUserCount(db, storeId, visitorIds, identityContext) {
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（六次修正）：改吃正式
  // identity context（見 utils/analyticsIdentity.js createCanonicalIdentityContext／
  // resolveInContext），不是裸 Map。standalone 呼叫端沒傳 context 時，
  // 這裡臨時建立一個只在這次呼叫內有效的 context，行為不變、不會缺東西。
  const context = identityContext || createCanonicalIdentityContext(storeId);
  const distinctRawIds = [...new Set(visitorIds.filter(Boolean))];
  if (!distinctRawIds.length) return 0;
  const canonicalMap = resolveInContext(db, context, storeId, distinctRawIds);
  const keys = new Set();
  distinctRawIds.forEach((id) => keys.add(canonicalMap.get(_cleanForLocalDedupe(id))));
  return keys.size;
}
// resolveInContext() 內部用 analyticsIdentity.js 的 _clean() 正規化 key，
// 這裡的 distinctRawIds 也可能含未正規化的原始字串；用同一種簡單正規化
// （trim）取 map，避免大小寫／前後空白造成查表落空。跟 _clean() 的實際
// 正規化規則保持等價（_clean 本身也只是 trim + 排除空字串，見該檔案）。
function _cleanForLocalDedupe(id) { return typeof id === 'string' ? id.trim() : id; }


// ────────────────────────────────────────────────────────────────
// 來源分類：把 utm_source / source / referer 正規化成報表用的固定分類。
// 沿用 Hotfix23-A 既有欄位，不新增欄位、不新增事件定義。
// 依需求文件八：facebook/fb/meta→Facebook；google→Google；line/liff→LINE；
// instagram/ig→Instagram；direct/空來源→Direct；其餘一律歸類 Other（不得漏分類）。
// ────────────────────────────────────────────────────────────────
function classifySource(rawSource, referrer) {
  const s = String(rawSource || '').toLowerCase().trim();
  const r = String(referrer || '').toLowerCase().trim();
  if (s.includes('fb') || s.includes('facebook') || s.includes('meta') || r.includes('facebook.com') || r.includes('fb.com')) return 'Facebook';
  if (s.includes('google') || r.includes('google.')) return 'Google';
  if (s.includes('line') || s.includes('liff') || r.includes('line.me') || r.includes('liff')) return 'LINE';
  if (s.includes('ig') || s.includes('instagram') || r.includes('instagram.com')) return 'Instagram';
  if (!s || s === 'direct' || s === 'unknown') return 'Direct';
  return 'Other';
}

// ────────────────────────────────────────────────────────────────
// 一、商品漏斗（Product Funnel）＋ 購物車放棄（依商品）＋ 熱門商品多維排行
//
// 直接擴充既有 getProductRanking() 的結果（不重複查詢 view/add/purchase），
// 只額外補上「開始結帳」與「營收」兩個維度：
//   - checkout：以 cart_id 為橋樑 —— 該商品出現在哪些 cart_id 的 add_to_cart 事件，
//     再看這些 cart_id 裡有沒有 begin_checkout 事件（同一次結帳流程 cart_id 不變，
//     沿用 Hotfix23-B getPayments() 已驗證過的橋接手法）。
//   - revenue：purchase_qty × 目前商品售價（商品已下架則以 0 計，不報錯）。
//
// ⚠️ 已知統計限制（依需求文件六，誠實記錄，不假裝精準）：
//   1. 「加入購物車」以 cart_id 為單位，不是以 session_id 或 member 為單位。
//      同一顧客若中途清空重建 cart_id（例如切換裝置、清除瀏覽器資料），會被視為
//      兩個獨立購物車，可能高估放棄數；目前事件定義（Hotfix23-A）沒有回傳
//      cart 建立時間或 TTL，無法進一步去重，這裡採「保守但一致」的做法：
//      同一個 cart_id 只要出現過 add_to_cart 就計入一次「加入購物車」。
//   2. 放棄金額是「放棄人數 × 目前商品售價」的估計值，不是購物車當下實際金額快照
//      （事件本身沒有存價格），商品若之後改價或下架，估計值會與實際情況有落差；
//      所有回傳欄位一律加上 estimated_ 前綴 / is_estimate 旗標，前端必須標示「估計值」。
// ────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION）：
// 三種正式統計口徑（additive，不取代、不刪除上面既有的 view_people／
// cart_people／purchase_people 等舊欄位語意）：
//   event_count   = 通過 store／channel／Asia/Taipei 日期／有效 cart_id
//                   （非 NULL、非空字串、TRIM 後非空白）與商品關聯後的
//                   canonical event rows 數
//   unique_users  = 同一批合格 rows 依 visitor_id 去重人數
//   unique_carts  = 同一批合格 rows 依 cart_id 去重購物車數
// 這三者故意分開回傳，不得互相取代或混用（事件次數≠人數≠購物車數）。
// ────────────────────────────────────────────────────────────────
const VALID_CART_ID_SQL = ` AND cart_id IS NOT NULL AND cart_id != '' AND TRIM(cart_id) != ''`;

// 對「已知合法 cart_id 白名單」（例如某商品的 add_to_cart cart 集合）做
// event_count/unique_users/unique_carts 統計；cartIdWhitelist 為 null 時
// 表示不限制 cart_id 白名單（但仍套用 VALID_CART_ID_SQL 排除空白/NULL）。
function _canonicalMetricsForEvent(db, storeId, range, channel, eventName, cartIdWhitelist, identityCache) {
  const chClause = channelEventsWhereClause(channel);
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（二次修正）：改成撈原始列
  // （visitor_id／cart_id），event_count／unique_carts 用 JS 算（跟原本 SQL
  // COUNT 結果等價，只是要留原始 visitor_id 清單給 resolver 用），
  // unique_users 改用 _canonicalUniqueUserCount()（既有 Visitor 360 resolver），
  // 不再用 COUNT(DISTINCT visitor_id)。
  let sql = `SELECT visitor_id, cart_id FROM analytics_events
             WHERE store_id=? AND event_name=?${VALID_CART_ID_SQL}
               AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`;
  const params = [storeId, eventName, range.startLocal, range.endLocal, ...chClause.params];
  if (Array.isArray(cartIdWhitelist)) {
    if (!cartIdWhitelist.length) return { event_count: 0, unique_users: 0, unique_carts: 0 };
    sql += ` AND cart_id IN (${cartIdWhitelist.map(() => '?').join(',')})`;
    params.push(...cartIdWhitelist);
  }
  const rows = db.all(sql, params) || [];
  return {
    event_count: rows.length,
    unique_users: _canonicalUniqueUserCount(db, storeId, rows.map((r) => r.visitor_id), identityCache),
    unique_carts: new Set(rows.map((r) => r.cart_id)).size,
  };
}

// 某商品的「合格 add_to_cart cart_id 集合」（store／channel／日期／有效 cart_id／
// 該商品 product_id 關聯後的 DISTINCT cart_id）。這是商品 checkout 交集運算的
// 左邊集合（見下方 _canonicalCheckoutMetricsForProduct）。
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 十三次修正——修正真正的 production N+1 bug）：先前 getProductFunnel() 對
// 每一列商品都各自呼叫 _canonicalAddToCartMetricsForProduct／
// _canonicalCheckoutMetricsForProduct（內部又呼叫 _productAddToCartCartIds
// ＋一次 checkout 交集查詢）／_canonicalPurchaseMetricsForProduct，總共
// 4 支查詢 × N 個商品，其中 purchase 查詢的 SQL 文字甚至完全不因商品而
// 變（沒有 product_id 條件），卻還是被重複執行 N 次。改成 batch 版本：
// add_to_cart／checkout_click／purchase 三個事件各自只查一次（外加一次
// orders 批次查詢），取得整個 store/channel/range 的合格 rows，在 JS 端
// 依 product_id 分組／過濾，取代「每個商品各自查一次 DB」。SQL 語意
// （valid cart_id、store/channel/日期隔離、checkout 的 cart 交集定義、
// purchase 需要「真正的 purchase event ＋ order items 真的含這個商品」、
// 重複 order item 不重複計算、canonical identity 共用同一個 context）
// 完全不變，只是把「查詢時機」從逐商品改成一次性批次＋JS 分組。

// 批次撈出整個 store/channel/range 的 add_to_cart rows，依 product_id 分組。
function _batchAddToCartRowsByProduct(db, storeId, range, channel) {
  const chClause = channelEventsWhereClause(channel);
  const rows = db.all(
    `SELECT product_id, visitor_id, cart_id FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND product_id IS NOT NULL${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chClause.params]
  );
  const byProduct = new Map();
  rows.forEach((r) => {
    if (!byProduct.has(r.product_id)) byProduct.set(r.product_id, []);
    byProduct.get(r.product_id).push(r);
  });
  return byProduct;
}

// 批次撈出整個 store/channel/range 的 checkout_click rows（不分商品，商品層
// 級的交集在 JS 端用 cart_id 過濾，不是靠 SQL IN (...) 白名單再查一次）。
function _batchCheckoutClickRows(db, storeId, range, channel) {
  const chClause = channelEventsWhereClause(channel);
  return db.all(
    `SELECT cart_id, visitor_id FROM analytics_events
     WHERE store_id=? AND event_name='checkout_click'${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chClause.params]
  );
}

// 批次撈出整個 store/channel/range 的 purchase rows，以及它們對應 order 的
// 商品組成（orders.items 批次查詢一次，解析成 Map<order_uuid, Set<product_id>>，
// 跟先前逐商品版本用 .some() 判斷完全等價，只是先解析好、共用）。
function _batchPurchaseRowsWithOrderItems(db, storeId, range, channel) {
  const chClause = channelEventsWhereClause(channel);
  const purchaseRows = db.all(
    `SELECT visitor_id, cart_id, order_id FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chClause.params]
  );
  if (!purchaseRows.length) return { purchaseRows: [], orderProductsMap: new Map() };
  const orderIds = [...new Set(purchaseRows.map((r) => r.order_id))];
  const placeholders = orderIds.map(() => '?').join(',');
  const orders = db.all(`SELECT uuid, items FROM orders WHERE store_id=? AND uuid IN (${placeholders})`, [storeId, ...orderIds]);
  const orderProductsMap = new Map();
  orders.forEach((o) => {
    try {
      const items = JSON.parse(o.items || '[]');
      orderProductsMap.set(o.uuid, new Set(items.map((it) => Number(it.product_id))));
    } catch (e) {
      orderProductsMap.set(o.uuid, new Set()); // 解析失敗一律當作不含任何商品，不報錯（跟原本行為一致）
    }
  });
  return { purchaseRows, orderProductsMap };
}

// 從批次資料（不再對每個商品各自查 DB）計算單一商品的三階段 canonical
// 統計。跟先前逐商品版本的語意完全等價：checkout 用「該商品 add_to_cart
// 的 cart 集合 ∩ checkout_click 的 cart 集合」；purchase 用「真正的
// purchase event ＋ order items 真的含這個商品」，重複 order item 不重複
// 計算（orderProductsMap 每個 order 只有一個 Set，天然去重）。
function _canonicalMetricsForProductFromBatch(db, storeId, productId, addToCartByProduct, checkoutRows, purchaseRows, orderProductsMap, identityContext) {
  const addRows = addToCartByProduct.get(productId) || [];
  const addToCart = {
    event_count: addRows.length,
    unique_users: _canonicalUniqueUserCount(db, storeId, addRows.map((r) => r.visitor_id), identityContext),
    unique_carts: new Set(addRows.map((r) => r.cart_id)).size,
  };

  const productCartIds = new Set(addRows.map((r) => r.cart_id));
  const checkoutRowsForProduct = productCartIds.size ? checkoutRows.filter((r) => productCartIds.has(r.cart_id)) : [];
  const checkoutClick = checkoutRowsForProduct.length ? {
    event_count: checkoutRowsForProduct.length,
    unique_users: _canonicalUniqueUserCount(db, storeId, checkoutRowsForProduct.map((r) => r.visitor_id), identityContext),
    unique_carts: new Set(checkoutRowsForProduct.map((r) => r.cart_id)).size,
  } : { event_count: 0, unique_users: 0, unique_carts: 0 };

  const purchaseRowsForProduct = purchaseRows.filter((r) => {
    const set = orderProductsMap.get(r.order_id);
    return set && set.has(Number(productId));
  });
  const purchase = {
    event_count: purchaseRowsForProduct.length,
    unique_users: _canonicalUniqueUserCount(db, storeId, purchaseRowsForProduct.map((r) => r.visitor_id), identityContext),
    unique_carts: new Set(purchaseRowsForProduct.map((r) => r.cart_id)).size,
  };

  return { add_to_cart: addToCart, checkout_click: checkoutClick, purchase };
}

function _productAddToCartCartIds(db, storeId, range, channel, productId) {
  const chClause = channelEventsWhereClause(channel);
  const rows = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND product_id=?${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, productId, range.startLocal, range.endLocal, ...chClause.params]
  );
  return rows.map(r => r.cart_id);
}
//   該商品 add_to_cart 的 DISTINCT cart ∩ checkout_click 的 DISTINCT cart
// 對交集內的 cart，取這些 cart 的 checkout_click event rows 做
// event_count／unique_users；unique_carts＝交集集合大小本身。
// Orphan checkout（沒有該商品 add_to_cart 證據的 cart）：可以正常算進全局
// checkout，但這裡的交集運算本身就已經排除它們，不會被誤歸入這個商品。
function _canonicalCheckoutMetricsForProduct(db, storeId, range, channel, productId, identityCache) {
  const productCartIds = _productAddToCartCartIds(db, storeId, range, channel, productId);
  if (!productCartIds.length) return { event_count: 0, unique_users: 0, unique_carts: 0 };
  const chClause = channelEventsWhereClause(channel);
  const placeholders = productCartIds.map(() => '?').join(',');
  const checkoutCartIdsForProduct = db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='checkout_click'${VALID_CART_ID_SQL}
       AND cart_id IN (${placeholders})
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, ...productCartIds, range.startLocal, range.endLocal, ...chClause.params]
  ).map(r => r.cart_id);
  if (!checkoutCartIdsForProduct.length) return { event_count: 0, unique_users: 0, unique_carts: 0 };
  return _canonicalMetricsForEvent(db, storeId, range, channel, 'checkout_click', checkoutCartIdsForProduct, identityCache);
}

// 某商品的正式 purchase canonical 統計。定義（需求文件四）：
//   正式 canonical purchase event（有效 cart_id、store/channel/日期合格）
//   ＋ 該 event 對應的真實 order_id 在 orders.items 裡確實含這個 product_id
// 兩個條件都要滿足，缺一不可：只有 add/checkout 不算購買；order items 含
// 商品但沒有正式 purchase 事件不算；purchase 事件存在但 order items 不含
// 該商品也不算；submit_order 不是 purchase，不得替代。
function _canonicalPurchaseMetricsForProduct(db, storeId, range, channel, productId, identityCache) {
  const chClause = channelEventsWhereClause(channel);
  const purchaseRows = db.all(
    `SELECT visitor_id, cart_id, order_id FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chClause.params]
  );
  if (!purchaseRows.length) return { event_count: 0, unique_users: 0, unique_carts: 0 };
  const orderIds = [...new Set(purchaseRows.map(r => r.order_id))];
  const placeholders = orderIds.map(() => '?').join(',');
  const orders = db.all(`SELECT uuid, items FROM orders WHERE store_id=? AND uuid IN (${placeholders})`, [storeId, ...orderIds]);
  const orderHasProduct = new Set();
  orders.forEach(o => {
    try {
      const items = JSON.parse(o.items || '[]');
      if (items.some(it => Number(it.product_id) === Number(productId))) orderHasProduct.add(o.uuid);
    } catch (e) { /* 解析失敗一律當作不含該商品，不報錯 */ }
  });
  const qualifyingRows = purchaseRows.filter(r => orderHasProduct.has(r.order_id));
  const uniqueUsers = _canonicalUniqueUserCount(db, storeId, qualifyingRows.map(r => r.visitor_id), identityCache);
  const uniqueCarts = new Set(qualifyingRows.map(r => r.cart_id)).size;
  return { event_count: qualifyingRows.length, unique_users: uniqueUsers, unique_carts: uniqueCarts };
}

// 某商品的 add_to_cart canonical 統計——直接用 product_id 過濾（不是靠
// cart_id 白名單間接篩選，避免同一購物車裡「別的商品」的 add_to_cart 事件
// 被誤算進這個商品的 event_count）。
function _canonicalAddToCartMetricsForProduct(db, storeId, range, channel, productId, identityCache) {
  const chClause = channelEventsWhereClause(channel);
  const rows = db.all(
    `SELECT visitor_id, cart_id FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND product_id=?${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, productId, range.startLocal, range.endLocal, ...chClause.params]
  ) || [];
  return {
    event_count: rows.length,
    unique_users: _canonicalUniqueUserCount(db, storeId, rows.map((r) => r.visitor_id), identityCache),
    unique_carts: new Set(rows.map((r) => r.cart_id)).size,
  };
}

// 全局（不分商品）三階段 canonical 統計——獨立計算，不是商品列的加總
// （同一 cart 可能同時出現在多個商品列，全局集合本身天然去重，不會被
// 商品列加總膨脹；見需求文件五：P1 checkout event_count + P2 checkout
// event_count ≠ 全局 checkout event_count）。
function getGlobalFunnelCanonicalMetrics(db, storeId, range, channel, identityContext) {
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（六次修正）：接受一個可選的
  // request-scoped identity context（見 utils/analyticsIdentity.js），同一次
  // request 若 getProductFunnel() 也在跑，兩者可以共用同一份已解析過的
  // visitor_id→canonical key 對照，不必重新查 identity tables。standalone
  // 呼叫（不傳這個參數）仍會自動建立一個只在這次呼叫內有效的暫時 context。
  const context = identityContext || createCanonicalIdentityContext(storeId, channel);
  return {
    add_to_cart: _canonicalMetricsForEvent(db, storeId, range, channel, 'add_to_cart', null, context),
    checkout_click: _canonicalMetricsForEvent(db, storeId, range, channel, 'checkout_click', null, context),
    purchase: _canonicalMetricsForEvent(db, storeId, range, channel, 'purchase', null, context),
  };
}

// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 五次修正）：先收集這次分析「所有商品、所有 stage」總共會用到的 visitor_id
// 聯集，一次性 prime 進 identityCache，而不是讓每個商品第一次遇到新
// visitor 時才觸發一次 resolveCanonicalVisitors()。lazy cache（先前版本）
// 雖然同一個 visitor 只解析一次，但如果 40 個商品各自對應完全不重疊的
// visitor 集合，仍會變成 40 次「這批是新的，去查」的批次呼叫——SQL 次數
// 還是隨商品數增加。這裡改成：查一次「這個 store／channel／日期區間內，
// add_to_cart／checkout_click／purchase 三個 stage 加起來的所有合格
// visitor_id」，一次性批次解析，之後不管有幾個商品、幾個 stage，identity
// table 查詢次數都固定（不隨商品數或 stage 數增加）。
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，
// 七次修正）：這是正式、對外 export 的 production API（不是 test-only
// hook），Route 必須在呼叫 getProductFunnel()／getGlobalFunnelCanonicalMetrics()
// 之前明確呼叫這個函式，把「這個 store／channel／日期區間內，add_to_cart／
// checkout_click／purchase 三個 stage 加起來的所有合格 visitor_id」一次性
// prime 進 context。這樣 product 與 global 兩個 helper 的正確性（以及
// 「不會重複查 identity table」這個效能保證）不會依賴「剛好先呼叫哪一個」
// ——因為 Route 自己已經在呼叫任何一個 helper 之前就把該查的都查完了。
// helper 內部仍保留呼叫這個函式（見 getProductFunnel()），是為了讓
// standalone（沒有透過 Route、沒有先手動 prime）的呼叫端依然正確——
// resolveInContext() 本身已經對「已經在 context 裡的 visitor_id」直接跳過，
// 所以 Route 已經 prime 過的狀況下，這裡重複呼叫不會產生任何新查詢
// （見下方 getProductFunnel() 內的呼叫，等於 no-op）。
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（九次修正——修正真實 bug）：
// primedScopes 不是純 bookkeeping，是真正的 prime 完成狀態閘門。之前版本
// 這個函式從來沒有真的檢查 primedScopes，只在最後寫入它，所以 Route 顯式
// prime 一次之後，getProductFunnel() 內部的安全網呼叫仍然會把 visitor
// union discovery 這條 SQL 重新查一次（雖然 identity 解析本身因為
// canonicalByVisitor 已經有結果而不會重查，但 discovery 這條 SQL 本身
// 沒有被跳過）——這是先前報告錯誤宣稱「product 階段新增 evidence SQL = 0」
// 時沒有算進去的真實重複查詢。現在改為：
//   1. 先查 primedScopes 有沒有這個 (channel, 日期區間) 的 scope key，
//      有就直接 return，不重新查 discovery、也不呼叫 resolveInContext。
//   2. 沒有的話才真正執行 discovery＋resolveInContext。
//   3. 只有在 resolveInContext 成功「之後」才把這個 scope key 寫進
//      primedScopes——如果 discovery 或 resolveInContext 拋出例外，
//      scope 不會被標記完成，下一次呼叫會重新完整執行一次（見
//      run-h1-4-8-product-funnel-semantics-runtime.js 的 PRIME_RETRY 測試）。
// scope key 正規化：channel 用 `channel || 'all'`（跟現有 channelEventsWhereClause
// 對「未指定 channel」的處理方式一致），日期用 range.startLocal／endLocal
// 這兩個已經是正規化過的字串（由 utils/dashboardDate.js resolveDateRange()
// 產生，不是使用者輸入的原始字串），不會因為格式差異產生誤判碰撞。
// 目前 stage union 固定只包含 add_to_cart／checkout_click／purchase 這三個
// canonical stage（本輪範圍），還沒有 view，之後加入 view-only canonical
// 時需要另外決定是否要用不同的 scope key 前綴區分（先誠實記錄在這裡，
// 不在本輪動手）。
function primeFunnelIdentityContext(db, storeId, range, channel, context) {
  const scopeKey = `${channel || 'all'}|${range.startLocal}|${range.endLocal}`;
  if (context.primedScopes && context.primedScopes.has(scopeKey)) return; // 真正的 no-op：已經 prime 過這個 scope
  const chClause = channelEventsWhereClause(channel);
  const rows = db.all(
    `SELECT DISTINCT visitor_id FROM analytics_events
     WHERE store_id=? AND event_name IN ('add_to_cart','checkout_click','purchase')${VALID_CART_ID_SQL}
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`,
    [storeId, range.startLocal, range.endLocal, ...chClause.params]
  );
  const allIds = rows.map((r) => r.visitor_id).filter(Boolean);
  resolveInContext(db, context, storeId, allIds); // 可能拋出例外——此時不執行下面這行，scope 不會被標記完成
  if (context.primedScopes) context.primedScopes.add(scopeKey);
}

function getProductFunnel(db, storeId, range, channel, sharedIdentityContext) {
  // fix18-10-hotfix31-R4（需求文件 B/C）：Product Funnel／Cart Abandonment by Product
  // 必須跟頂層 channel 選擇器用同一個定義，否則選了「LINE 外送」看到的還是全渠道商品排行。
  const ranking = getProductRanking(db, storeId, range, channel); // 沿用既有函式，不重算 view/cart/purchase
  if (!ranking.length) return [];

  // 目前售價（已下架商品沒有 price，revenue 以 0 計，不報錯）
  const priceMap = {};
  const idList = ranking.map(r => r.product_id);
  if (idList.length) {
    const placeholders = idList.map(() => '?').join(',');
    db.all(`SELECT id, price FROM products WHERE store_id=? AND id IN (${placeholders})`, [storeId, ...idList])
      .forEach(pr => { priceMap[pr.id] = Number(pr.price || 0); });
  }

  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（四次修正）：request-scoped
  // identity cache——這整個 getProductFunnel() 呼叫（不管有幾個商品、每個
  // 商品 3 個 stage）共用同一份 Map，同一個 visitor_id 只會被
  // resolveCanonicalVisitors() 解析一次，不會隨商品數 × stage 數線性增加
  // identity table 查詢次數。若呼叫端（routes/analytics.js）已經建立一份
  // 跨 global／product 共用的 cache，就直接沿用那一份，不新建第二份。
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（六次修正）：正式 identity
  // context（不是裸 Map）。standalone 呼叫（沒傳 sharedIdentityContext）
  // 會自動建立一個安全、store-scoped 的臨時 context。
  const identityContext = sharedIdentityContext || createCanonicalIdentityContext(storeId, channel);
  // 一次性 prime，避免依商品數線性增加 identity 查詢次數（見上方函式註解）。
  // 若呼叫端傳入的 sharedIdentityContext 已經被 prime 過（例如 Route 端已經
  // 呼叫過一次 _primeIdentityCacheForFunnel），這裡對已經在 context 裡的
  // visitor_id 不會重複查詢（resolveInContext 內部本身也會先過濾 missing）。
  primeFunnelIdentityContext(db, storeId, range, channel, identityContext);

  // 十三次修正：三個 stage 各自只批次查詢一次（不是每個商品各查一次），
  // 在 JS 端依 product_id 分組／依 cart_id 交集過濾，取代先前的 N+1。
  const addToCartByProduct = _batchAddToCartRowsByProduct(db, storeId, range, channel);
  const checkoutRows = _batchCheckoutClickRows(db, storeId, range, channel);
  const { purchaseRows, orderProductsMap } = _batchPurchaseRowsWithOrderItems(db, storeId, range, channel);

  return ranking.map(row => {
    // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（CHECKOUT-ANALYTICS-UNIFICATION，二次修正）：
    // canonical 先算好，legacy 的 `checkout`（購物車數）欄位直接派生自
    // canonical.checkout_click.unique_carts——同一次查詢結果，不是兩套
    // 平行 SQL（先前版本 checkoutCartCount 是靠另一組 productCarts／
    // checkoutCartIds batch 查詢算出來的，跟這裡的 canonical 是兩次獨立
    // 運算，即使數值理論上該相等，也違反「canonical 只能聚合一次」的原則，
    // 已移除那套平行查詢）。
    const canonical = _canonicalMetricsForProductFromBatch(db, storeId, row.product_id, addToCartByProduct, checkoutRows, purchaseRows, orderProductsMap, identityContext);
    const checkoutCartCount = canonical.checkout_click.unique_carts;
    const revenue = round2((priceMap[row.product_id] || 0) * row.purchase_qty);
    const abandon = Math.max(0, row.cart_people - row.purchase_people);
    const abandonRate = row.cart_people > 0 ? round2(abandon / row.cart_people * 100) : null;
    // 估計放棄金額 = 放棄人數 × 目前售價（不是真實購物車金額快照，商品可能已改價／
    // 已下架；前端必須標示「估計值」，不得當成精確數字呈現）。
    const estimatedAbandonedAmount = round2((priceMap[row.product_id] || 0) * abandon);
    return {
      product_id: row.product_id,
      product_name: row.product_name,
      is_delisted: row.is_delisted,
      // ── Legacy 欄位盤點（誠實記錄每個欄位的真實語意，供交付報告引用）──
      // view：view_people，getProductRanking() 的 COUNT(DISTINCT visitor_id)
      //   for view_product。這是「人數」，語意穩定，不是任何 stage 的別名，
      //   canonical 沒有對應的 view_product 統計（Gate B 範圍只涵蓋
      //   add_to_cart／checkout_click／purchase 三階段），維持原樣不動。
      view: row.view_people,
      // add_to_cart：row.cart_people，getProductRanking() 的 COUNT(DISTINCT
      //   visitor_id) for add_to_cart，「不去重 cart_id 是否有效」（沒有
      //   VALID_CART_ID_SQL 過濾）。這跟 canonical.add_to_cart.unique_users
      //   在「有效 cart_id」這個篩選條件上不同，是刻意保留的既有語意，不是
      //   同一個 canonical 值的別名——不強行映射，避免偷改既有 API 語意。
      add_to_cart: row.cart_people,
      // checkout：現在直接等於 canonical.checkout_click.unique_carts（同一次
      // canonical 查詢結果派生，不是第二次查詢）。
      checkout: checkoutCartCount,
      // purchase：row.purchase_people，getProductRanking() 用 orders.items 反查
      //   的「不重複 order uuid 數」（命名為 purchase_people 但實際語意是
      //   「訂單數」，不是人數也不是購物車數——既有命名本身有語意落差，這裡
      //   如實記錄，不擅自改名或重新定義，避免破壞既有 API 回應形狀）。
      purchase: row.purchase_people,
      purchase_qty: row.purchase_qty,
      revenue,
      // 三段轉換率（防除以 0，全部回傳 null 代表無法計算，前端不得顯示假數字）
      // ⚠️ 誠實記錄：這三個既有轉換率把「人數」（view_people/cart_people/
      // purchase_people）跟「購物車數」（checkoutCartCount）混用作分子分母，
      // 是 H1.4.8 之前就存在的既有語意（getProductRanking 的既有欄位設計），
      // 本輪不重新定義既有 API 回應語意，只在 canonical 區塊提供正確的
      // cart/cart、user/user 純口徑轉換率（見下方 canonical_rates），第一方
      // UI 改讀那裡，不讀這三個舊欄位做「前往結帳率」「購買率」顯示。
      view_to_add_rate: row.view_people > 0 ? round2(row.cart_people / row.view_people * 100) : null,
      add_to_checkout_rate: row.cart_people > 0 ? round2(checkoutCartCount / row.cart_people * 100) : null,
      checkout_to_purchase_rate: checkoutCartCount > 0 ? round2(row.purchase_people / checkoutCartCount * 100) : null,
      conversion_rate: row.view_people > 0 ? round2(row.purchase_people / row.view_people * 100) : null, // overall (view→purchase)
      abandon_count: abandon,
      abandon_rate: abandonRate,
      estimated_abandoned_amount: estimatedAbandonedAmount,
      estimated_abandoned_amount_is_estimate: true, // 前端必須標示「估計值」
      // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8：canonical 三口徑（additive，
      // 唯一權威來源，legacy 的 `checkout` 欄位已從這裡派生，見上方）。
      canonical,
      // 純 cart/cart、user/user 口徑轉換率，不混用人數與購物車數。
      // 前往結帳率 = checkout_click.unique_carts / add_to_cart.unique_carts
      // 購買率     = purchase.unique_carts / add_to_cart.unique_carts
      canonical_rates: {
        checkout_rate: canonical.add_to_cart.unique_carts > 0
          ? round2(canonical.checkout_click.unique_carts / canonical.add_to_cart.unique_carts * 100) : null,
        purchase_rate: canonical.add_to_cart.unique_carts > 0
          ? round2(canonical.purchase.unique_carts / canonical.add_to_cart.unique_carts * 100) : null,
      },
    };
  });
}

// 購物車放棄（依商品）—— 直接由 getProductFunnel() 結果整理，不另外查詢、不建表
function getCartAbandonmentByProduct(funnel) {
  if (!funnel.length) return { rows: [], top_abandon_products: [] };
  const rows = funnel
    .filter(f => f.add_to_cart > 0)
    .map(f => ({
      product_id: f.product_id,
      product_name: f.product_name,
      add_to_cart: f.add_to_cart,
      purchase: f.purchase,
      abandon: f.abandon_count,
      abandon_rate: f.abandon_rate,
      estimated_abandoned_amount: f.estimated_abandoned_amount,
      estimated_abandoned_amount_is_estimate: true, // 前端必須標示「估計值」，見 getProductFunnel 註解
    }));
  const top_abandon_products = [...rows]
    .sort((a, b) => (b.abandon_rate || 0) - (a.abandon_rate || 0))
    .slice(0, 10);
  return { rows, top_abandon_products };
}

// 熱門商品多維排行 —— 全部由 getProductFunnel() 排序而來，不另建 Product Analytics Table
//
// 樣本門檻（依需求文件七）：轉換率類排行（Top Conversion / Lowest Conversion）若樣本數
// （view 數）過少，例如只有 1 次瀏覽就成交 = 100% 轉換率，會嚴重誤導經營判斷。
// 採用一個保守、寫在程式碼中的最低樣本門檻 MIN_SAMPLE_FOR_CONVERSION_RANKING，
// 樣本不足的商品不會進入 Top/Lowest Conversion 排行（但仍會出現在 Top Sales /
// Top Revenue / Highest Cart 等不受樣本代表性影響的排行中）。
const MIN_SAMPLE_FOR_CONVERSION_RANKING = 5;

function getProductRankings(funnel) {
  const withCart = funnel.filter(f => f.add_to_cart > 0);
  const withView = funnel.filter(f => f.view > 0);
  const withReliableView = withView.filter(f => f.view >= MIN_SAMPLE_FOR_CONVERSION_RANKING);
  const excludedLowSample = withView.length - withReliableView.length;

  const sortDesc = (arr, key) => [...arr].sort((a, b) => (b[key] || 0) - (a[key] || 0)).slice(0, 10)
    .map((p, i) => ({ rank: i + 1, sample_size: p.view, ...p }));
  const sortAsc = (arr, key) => [...arr].sort((a, b) => (a[key] ?? Infinity) - (b[key] ?? Infinity)).slice(0, 10)
    .map((p, i) => ({ rank: i + 1, sample_size: p.view, ...p }));

  return {
    top_sales: sortDesc(funnel, 'purchase_qty'),
    top_revenue: sortDesc(funnel, 'revenue'),
    top_conversion: sortDesc(withReliableView, 'conversion_rate'),
    highest_cart: sortDesc(funnel, 'add_to_cart'),
    lowest_conversion: sortAsc(withReliableView, 'conversion_rate'),
    highest_abandon: sortDesc(withCart, 'abandon_rate'),
    min_sample_threshold: MIN_SAMPLE_FOR_CONVERSION_RANKING,
    excluded_low_sample_count: excludedLowSample, // 因樣本不足被排除在 Top/Lowest Conversion 之外的商品數
  };
}

// ────────────────────────────────────────────────────────────────
// 二、來源分析（Source Performance）—— Facebook / Google / LINE / IG / Direct
// 依 analytics_events 的 page_view（sessions）+ purchase（orders/revenue）整合，
// 沿用既有 getSources() 的 UTM/source 欄位，不新增欄位。
// ────────────────────────────────────────────────────────────────
function getSourcePerformance(db, storeId, range, channel) {
  // fix18-10-hotfix31-R4（需求文件 B/C）：Source Performance 必須跟頂層 channel 選擇器一致。
  const chClause = channelEventsWhereClause(channel);
  const p = [storeId, range.startLocal, range.endLocal, ...chClause.params];

  const sessionRows = db.all(
    `SELECT COALESCE(NULLIF(source,''),'') as source, COALESCE(NULLIF(referrer,''),'') as referrer,
            COUNT(DISTINCT session_id) as sessions
     FROM analytics_events
     WHERE store_id=? AND event_name='page_view' AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}
     GROUP BY source, referrer`, p
  );

  const purchaseRows = db.all(
    `SELECT DISTINCT order_id, source, referrer FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`, p
  );

  const buckets = {
    Facebook: { sessions: 0, orders: 0, revenue: 0 },
    Google: { sessions: 0, orders: 0, revenue: 0 },
    LINE: { sessions: 0, orders: 0, revenue: 0 },
    Instagram: { sessions: 0, orders: 0, revenue: 0 },
    Direct: { sessions: 0, orders: 0, revenue: 0 },
    Other: { sessions: 0, orders: 0, revenue: 0 },
  };

  sessionRows.forEach(r => {
    const cat = classifySource(r.source, r.referrer);
    buckets[cat].sessions += Number(r.sessions || 0);
  });

  const orderIds = [...new Set(purchaseRows.map(r => r.order_id))];
  let orderRevenue = {};
  if (orderIds.length) {
    const placeholders = orderIds.map(() => '?').join(',');
    db.all(`SELECT uuid, total FROM orders WHERE store_id=? AND uuid IN (${placeholders})`, [storeId, ...orderIds])
      .forEach(o => { orderRevenue[o.uuid] = Number(o.total || 0); });
  }
  purchaseRows.forEach(r => {
    const cat = classifySource(r.source, r.referrer);
    buckets[cat].orders += 1;
    buckets[cat].revenue += orderRevenue[r.order_id] || 0;
  });

  return Object.entries(buckets).map(([name, v]) => ({
    source: name,
    sessions: v.sessions,
    orders: v.orders,
    revenue: round2(v.revenue),
    conversion_rate: v.sessions > 0 ? round2(v.orders / v.sessions * 100) : null,
  }));
}

// ────────────────────────────────────────────────────────────────
// 三、Campaign 分析（utm_campaign）—— 若無資料，誠實顯示「尚未取得 Campaign」，不報錯
// ────────────────────────────────────────────────────────────────
function getCampaignPerformance(db, storeId, range, channel) {
  // fix18-10-hotfix31-R4（需求文件 B/C）：Campaign 分析必須跟頂層 channel 選擇器一致。
  const chClause = channelEventsWhereClause(channel);
  const p = [storeId, range.startLocal, range.endLocal, ...chClause.params];
  const campaignRows = db.all(
    `SELECT campaign, COUNT(DISTINCT session_id) as visitors FROM analytics_events
     WHERE store_id=? AND event_name='page_view' AND campaign IS NOT NULL AND campaign != ''
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql} GROUP BY campaign`, p
  );
  if (!campaignRows.length) {
    return { available: false, message: '尚未取得 Campaign 資料', rows: [] };
  }

  const purchaseRows = db.all(
    `SELECT DISTINCT order_id, campaign FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND campaign IS NOT NULL AND campaign != ''
       AND ${A_LOCAL} BETWEEN ? AND ?${chClause.sql}`, p
  );
  const orderIds = [...new Set(purchaseRows.map(r => r.order_id))];
  let orderRevenue = {};
  if (orderIds.length) {
    const placeholders = orderIds.map(() => '?').join(',');
    db.all(`SELECT uuid, total FROM orders WHERE store_id=? AND uuid IN (${placeholders})`, [storeId, ...orderIds])
      .forEach(o => { orderRevenue[o.uuid] = Number(o.total || 0); });
  }
  const byCampaign = {};
  campaignRows.forEach(r => { byCampaign[r.campaign] = { visitors: r.visitors, orders: 0, revenue: 0 }; });
  purchaseRows.forEach(r => {
    if (!byCampaign[r.campaign]) byCampaign[r.campaign] = { visitors: 0, orders: 0, revenue: 0 };
    byCampaign[r.campaign].orders += 1;
    byCampaign[r.campaign].revenue += orderRevenue[r.order_id] || 0;
  });

  const rows = Object.entries(byCampaign).map(([campaign, v]) => ({
    campaign,
    visitors: v.visitors,
    orders: v.orders,
    revenue: round2(v.revenue),
    conversion_rate: v.visitors > 0 ? round2(v.orders / v.visitors * 100) : null,
  })).sort((a, b) => b.revenue - a.revenue);

  return { available: true, message: null, rows };
}

// ────────────────────────────────────────────────────────────────
// 四、廣告 Dashboard —— Sessions/Orders/Revenue/Conversion 為真實資料（沿用來源分析），
// Cost/ROAS/CPA/CAC 尚未串接任何 Ads API，一律誠實顯示「尚未串接／尚未計算」，不可假造。
// 依需求文件九：Meta Ads API／Google Ads API 狀態、廣告花費、ROAS、CPA、CAC 皆須
// 明確標示尚未取得，不得讓 UI 誤以為是真實數值（cost/roas/cpa/cac 一律回傳 null）。
// ────────────────────────────────────────────────────────────────
function getAdsDashboard(sourcePerformance) {
  const AD_SOURCES = new Set(['Facebook', 'Google']);
  return sourcePerformance.map(s => ({
    source: s.source,
    sessions: s.sessions,
    orders: s.orders,
    revenue: s.revenue,
    conversion_rate: s.conversion_rate,
    cost: null,               // 廣告花費：尚未取得
    roas: null,                // ROAS：尚未計算
    cpa: null,                 // CPA：尚未計算
    cac: null,                 // CAC：尚未計算
    meta_ads_api_connected: s.source === 'Facebook' ? false : null,
    google_ads_api_connected: s.source === 'Google' ? false : null,
    note: AD_SOURCES.has(s.source)
      ? (s.source === 'Facebook' ? '尚未串接 Meta Ads API' : '尚未串接 Google Ads API')
      : null,
  }));
}

// ────────────────────────────────────────────────────────────────
// 五、CRM Dashboard —— 完全沿用 line_members，不建立第二套 CRM 資料。
//
// 會員 ↔ 訂單關聯規則：完全沿用既有 Hotfix23-E 的關聯方式（line_members.order_count /
// total_spent / first_purchase_at / last_purchase_at，由 utils/lineMemberStats.js 在
// 訂單真正成立/付款成功時寫入，見 routes/line-orders.js、routes/linepay.js）。
// 不自行用 email、電話或猜測方式二次比對訂單，避免產生不可信的關聯。
// ────────────────────────────────────────────────────────────────
function getCrmOverview(db, storeId, range) {
  const totals = db.get(
    `SELECT COUNT(*) as total_members,
            COALESCE(AVG(CASE WHEN order_count>0 THEN total_spent/order_count END),0) as avg_order_value
     FROM line_members WHERE store_id=?`, [storeId]
  ) || {};
  const totalMembers = Number(totals.total_members || 0);
  if (!totalMembers) {
    return { insufficient_data: true, message: '尚無 LINE 會員資料', total_members: 0 };
  }

  const newMembers = Number((db.get(
    `SELECT COUNT(*) c FROM line_members WHERE store_id=? AND first_seen_at BETWEEN ? AND ?`,
    [storeId, range.startLocal, range.endLocal]
  ) || {}).c || 0);

  const repeatRow = db.get(
    `SELECT SUM(CASE WHEN order_count>1 THEN 1 ELSE 0 END) as repeat_c,
            SUM(CASE WHEN order_count>=1 THEN 1 ELSE 0 END) as buyer_c
     FROM line_members WHERE store_id=?`, [storeId]
  ) || {};
  const buyerCount = Number(repeatRow.buyer_c || 0);
  const repeatCount = Number(repeatRow.repeat_c || 0);
  const repeatRate = buyerCount > 0 ? round2(repeatCount / buyerCount * 100) : null;

  const recentPurchase = db.all(
    `SELECT display_name, last_order_at, total_spent FROM line_members
     WHERE store_id=? AND last_order_at != '' ORDER BY last_order_at DESC LIMIT 10`, [storeId]
  );

  const inactive30 = Number((db.get(
    `SELECT COUNT(*) c FROM line_members
     WHERE store_id=? AND last_order_at != '' AND last_order_at < datetime('now','localtime','-30 days')`,
    [storeId]
  ) || {}).c || 0);
  const inactive90 = Number((db.get(
    `SELECT COUNT(*) c FROM line_members
     WHERE store_id=? AND last_order_at != '' AND last_order_at < datetime('now','localtime','-90 days')`,
    [storeId]
  ) || {}).c || 0);

  // VIP／一般會員：以累積消費金額排序取前 20% 視為 VIP（純規則，非另建資料表／欄位）
  const spendRows = db.all(
    `SELECT id, total_spent FROM line_members WHERE store_id=? ORDER BY total_spent DESC`, [storeId]
  );
  const vipCount = Math.max(0, Math.ceil(spendRows.length * 0.2));
  const vip = spendRows.slice(0, vipCount).length;
  const regular = spendRows.length - vip;

  return {
    insufficient_data: false,
    total_members: totalMembers,
    new_members: newMembers,
    paying_members: buyerCount,     // 有消費會員
    repeat_members: repeatCount,    // 回購會員
    repeat_rate: repeatRate,
    avg_order_value: round2(Number(totals.avg_order_value || 0)),
    recent_purchases: recentPurchase,
    inactive_30d: inactive30,
    inactive_90d: inactive90,
    vip_members: vip,
    regular_members: regular,
  };
}

// ────────────────────────────────────────────────────────────────
// 六、AI Insights —— 純 Rule Engine（依需求文件十一），第一版不得串任何 AI API。
// 每一則建議固定回傳：severity（嚴重程度）／problem（問題）／evidence（判斷依據，
// 純文字）／actions（建議行動）／values（相關數值，給前端直接顯示，不用再自己拼字串）。
//
// ⚠️ 規則 6「30 天未回購會員增加」的已知限制：目前沒有歷史快照資料表可比較「增加」
// 這個趨勢（依需求文件「不得新增第二套 Analytics 資料表」，本期不新建 snapshot 表），
// 因此改用「目前 30 天未回購會員佔比是否偏高」作為保守替代指標，不聲稱偵測到真正的
// 時間趨勢；若未來要做真正的趨勢比較，應該在既有 line_members 相關表上擴充欄位，而
// 不是新建 analytics_ai 之類的第二套表。
// ────────────────────────────────────────────────────────────────
const MIN_VIEW_SAMPLE_FOR_AI = 5; // 與排行榜共用同一個保守樣本門檻概念，避免規則被極少樣本誤觸發

function getAiInsightsV2(cartAbandonment, sourcePerformance, funnel, crm) {
  const insights = [];

  // 規則 1：放棄率 > 70% 的商品
  (cartAbandonment.top_abandon_products || []).forEach(p => {
    if (p.abandon_rate !== null && p.abandon_rate > 70) {
      insights.push({
        type: 'cart_abandonment_high',
        severity: 'high',
        problem: `「${p.product_name}」購物車放棄率過高`,
        evidence: `加入購物車 ${p.add_to_cart} 人，僅 ${p.purchase} 人完成付款，放棄率 ${p.abandon_rate}%`,
        actions: ['檢查價格', '檢查運費', '強化結帳誘因', '評估優惠券'],
        values: { product_name: p.product_name, add_to_cart: p.add_to_cart, purchase: p.purchase, abandon_rate: p.abandon_rate },
      });
    }
  });

  // 規則 2：商品曝光高但加入購物車率低（view_to_add_rate 明顯偏低）
  // H1.4.5-PRODUCT-EXPOSURE-TO-CART-RATE：f.view 來源是 internal view_product（商品卡
  // 曝光不重複人數），只改老闆看到的文字語意（瀏覽→曝光），不改樣本門檻、平均值計算、
  // 異常判斷公式與 view_to_add_rate 這個 API 欄位名稱。
  const withReliableView = funnel.filter(f => f.view >= MIN_VIEW_SAMPLE_FOR_AI && f.view_to_add_rate !== null);
  if (withReliableView.length) {
    const avgViewToAdd = withReliableView.reduce((s, f) => s + f.view_to_add_rate, 0) / withReliableView.length;
    withReliableView.forEach(f => {
      if (f.view_to_add_rate < avgViewToAdd * 0.5) {
        insights.push({
          type: 'low_view_to_cart',
          severity: 'medium',
          problem: `「${f.product_name}」曝光高但加入購物車率偏低`,
          evidence: `曝光 ${f.view} 人，僅 ${f.add_to_cart} 人加入購物車（${f.view_to_add_rate}%，同期平均 ${round2(avgViewToAdd)}%）`,
          actions: ['改善商品圖片', '改善商品描述', '檢查售價與份量呈現'],
          values: { product_name: f.product_name, view: f.view, add_to_cart: f.add_to_cart, view_to_add_rate: f.view_to_add_rate },
        });
      }
    });
  }

  // 規則 3：加入購物車高但付款率低（checkout_to_purchase_rate 偏低，或有 checkout 但完全沒 purchase）
  funnel.filter(f => f.checkout >= 3).forEach(f => {
    if (f.checkout_to_purchase_rate !== null && f.checkout_to_purchase_rate < 50) {
      insights.push({
        type: 'low_checkout_to_purchase',
        severity: 'high',
        problem: `「${f.product_name}」已進入結帳但付款完成率偏低`,
        evidence: `開始結帳 ${f.checkout} 次，完成付款 ${f.purchase} 人（${f.checkout_to_purchase_rate}%）`,
        actions: ['檢查結帳流程', '檢查付款方式', '檢查外送費或最低消費設定'],
        values: { product_name: f.product_name, checkout: f.checkout, purchase: f.purchase, checkout_to_purchase_rate: f.checkout_to_purchase_rate },
      });
    }
  });

  // 規則 4：Facebook Sessions 高但 Conversion 低
  const fb = sourcePerformance.find(s => s.source === 'Facebook');
  if (fb && fb.sessions >= 10 && (fb.conversion_rate === null || fb.conversion_rate < 1)) {
    insights.push({
      type: 'facebook_underperforming',
      severity: 'medium',
      problem: 'Facebook 帶來流量但轉換率偏低',
      evidence: `Facebook Sessions ${fb.sessions}，訂單 ${fb.orders} 筆，轉換率 ${_fmtPctForLog(fb.conversion_rate)}`,
      actions: ['檢查廣告受眾與落地頁一致性', '檢查廣告素材是否過度承諾'],
      values: { source: 'Facebook', sessions: fb.sessions, orders: fb.orders, conversion_rate: fb.conversion_rate },
    });
  }

  // 規則 5：LINE Conversion 高於其他來源
  const line = sourcePerformance.find(s => s.source === 'LINE');
  const others = sourcePerformance.filter(s => s.source !== 'LINE' && s.sessions > 0 && s.conversion_rate !== null);
  if (line && line.sessions >= 5 && line.conversion_rate !== null && others.length) {
    const avgOthers = others.reduce((sum, s) => sum + s.conversion_rate, 0) / others.length;
    if (line.conversion_rate > avgOthers) {
      insights.push({
        type: 'line_outperforming',
        severity: 'positive',
        problem: 'LINE 轉換率明顯高於其他來源',
        evidence: `LINE 轉換率 ${line.conversion_rate}%，其他來源平均 ${round2(avgOthers)}%`,
        actions: ['增加 LINE 會員經營', '強化回購活動'],
        values: { source: 'LINE', conversion_rate: line.conversion_rate, other_sources_avg_conversion_rate: round2(avgOthers) },
      });
    }
  }

  // 規則 6：30 天未回購會員佔比偏高（見函式上方註解：以「目前佔比」取代「趨勢」）
  if (crm && !crm.insufficient_data && crm.paying_members > 0) {
    const inactiveRate = round2(crm.inactive_30d / crm.paying_members * 100);
    if (inactiveRate > 40) {
      insights.push({
        type: 'inactive_members_high',
        severity: 'medium',
        problem: '30 天未回購的會員佔比偏高',
        evidence: `有消費會員 ${crm.paying_members} 人中，${crm.inactive_30d} 人超過 30 天未回購（${inactiveRate}%）`,
        actions: ['規劃回購提醒', '規劃會員限定活動'],
        values: { paying_members: crm.paying_members, inactive_30d: crm.inactive_30d, inactive_rate: inactiveRate },
      });
    }
  }

  return insights;
}
function _fmtPctForLog(v) { return v === null || v === undefined ? '—' : v + '%'; }

module.exports = {
  getProductFunnel,
  getCartAbandonmentByProduct,
  getProductRankings,
  getSourcePerformance,
  getCampaignPerformance,
  getAdsDashboard,
  getCrmOverview,
  getAiInsightsV2,
  classifySource,
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8：additive canonical 三口徑，
  // 供測試與未來 UI 消費端直接使用，不用重新實作一份查詢。
  getGlobalFunnelCanonicalMetrics,
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.8（七次修正）：Route 必須顯式
  // 呼叫這個函式 prime context，不得依賴 getProductFunnel() 內部剛好先
  // prime。
  primeFunnelIdentityContext,
};
