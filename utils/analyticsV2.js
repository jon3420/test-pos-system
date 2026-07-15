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
const { round2, getProductRanking } = require('./dashboardAnalytics');

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
function getProductFunnel(db, storeId, range) {
  const ranking = getProductRanking(db, storeId, range); // 沿用既有函式，不重算 view/cart/purchase
  if (!ranking.length) return [];

  const p = [storeId, range.startLocal, range.endLocal];

  // 每個商品的 add_to_cart cart_id 清單
  const cartRows = db.all(
    `SELECT product_id, cart_id FROM analytics_events
     WHERE store_id=? AND event_name='add_to_cart' AND product_id IS NOT NULL
       AND cart_id IS NOT NULL AND cart_id != '' AND ${A_LOCAL} BETWEEN ? AND ?`, p
  );
  const productCarts = {}; // product_id -> Set(cart_id)
  cartRows.forEach(r => {
    if (!productCarts[r.product_id]) productCarts[r.product_id] = new Set();
    productCarts[r.product_id].add(r.cart_id);
  });

  // 有 begin_checkout 的 cart_id 集合
  const checkoutCartIds = new Set(db.all(
    `SELECT DISTINCT cart_id FROM analytics_events
     WHERE store_id=? AND event_name='begin_checkout' AND cart_id IS NOT NULL AND cart_id != ''
       AND ${A_LOCAL} BETWEEN ? AND ?`, p
  ).map(r => r.cart_id));

  // 目前售價（已下架商品沒有 price，revenue 以 0 計，不報錯）
  const priceMap = {};
  const idList = ranking.map(r => r.product_id);
  if (idList.length) {
    const placeholders = idList.map(() => '?').join(',');
    db.all(`SELECT id, price FROM products WHERE store_id=? AND id IN (${placeholders})`, [storeId, ...idList])
      .forEach(pr => { priceMap[pr.id] = Number(pr.price || 0); });
  }

  return ranking.map(row => {
    const carts = productCarts[row.product_id] || new Set();
    const checkoutCartCount = [...carts].filter(cid => checkoutCartIds.has(cid)).length;
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
      view: row.view_people,
      add_to_cart: row.cart_people,
      checkout: checkoutCartCount,
      purchase: row.purchase_people,
      purchase_qty: row.purchase_qty,
      revenue,
      // 三段轉換率（防除以 0，全部回傳 null 代表無法計算，前端不得顯示假數字）
      view_to_add_rate: row.view_people > 0 ? round2(row.cart_people / row.view_people * 100) : null,
      add_to_checkout_rate: row.cart_people > 0 ? round2(checkoutCartCount / row.cart_people * 100) : null,
      checkout_to_purchase_rate: checkoutCartCount > 0 ? round2(row.purchase_people / checkoutCartCount * 100) : null,
      conversion_rate: row.view_people > 0 ? round2(row.purchase_people / row.view_people * 100) : null, // overall (view→purchase)
      abandon_count: abandon,
      abandon_rate: abandonRate,
      estimated_abandoned_amount: estimatedAbandonedAmount,
      estimated_abandoned_amount_is_estimate: true, // 前端必須標示「估計值」
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
function getSourcePerformance(db, storeId, range) {
  const p = [storeId, range.startLocal, range.endLocal];

  const sessionRows = db.all(
    `SELECT COALESCE(NULLIF(source,''),'') as source, COALESCE(NULLIF(referrer,''),'') as referrer,
            COUNT(DISTINCT session_id) as sessions
     FROM analytics_events
     WHERE store_id=? AND event_name='page_view' AND ${A_LOCAL} BETWEEN ? AND ?
     GROUP BY source, referrer`, p
  );

  const purchaseRows = db.all(
    `SELECT DISTINCT order_id, source, referrer FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND ${A_LOCAL} BETWEEN ? AND ?`, p
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
function getCampaignPerformance(db, storeId, range) {
  const p = [storeId, range.startLocal, range.endLocal];
  const campaignRows = db.all(
    `SELECT campaign, COUNT(DISTINCT session_id) as visitors FROM analytics_events
     WHERE store_id=? AND event_name='page_view' AND campaign IS NOT NULL AND campaign != ''
       AND ${A_LOCAL} BETWEEN ? AND ? GROUP BY campaign`, p
  );
  if (!campaignRows.length) {
    return { available: false, message: '尚未取得 Campaign 資料', rows: [] };
  }

  const purchaseRows = db.all(
    `SELECT DISTINCT order_id, campaign FROM analytics_events
     WHERE store_id=? AND event_name='purchase' AND order_id IS NOT NULL AND campaign IS NOT NULL AND campaign != ''
       AND ${A_LOCAL} BETWEEN ? AND ?`, p
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

  // 規則 2：商品瀏覽高但加入購物車率低（view_to_add_rate 明顯偏低）
  const withReliableView = funnel.filter(f => f.view >= MIN_VIEW_SAMPLE_FOR_AI && f.view_to_add_rate !== null);
  if (withReliableView.length) {
    const avgViewToAdd = withReliableView.reduce((s, f) => s + f.view_to_add_rate, 0) / withReliableView.length;
    withReliableView.forEach(f => {
      if (f.view_to_add_rate < avgViewToAdd * 0.5) {
        insights.push({
          type: 'low_view_to_cart',
          severity: 'medium',
          problem: `「${f.product_name}」瀏覽量高但加入購物車率偏低`,
          evidence: `瀏覽 ${f.view} 人，僅 ${f.add_to_cart} 人加入購物車（${f.view_to_add_rate}%，同期平均 ${round2(avgViewToAdd)}%）`,
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
};
