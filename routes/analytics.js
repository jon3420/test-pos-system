// routes/analytics.js — fix18-10-hotfix23-A Analytics Foundation
//
// POST /api/analytics/events
//   前台轉換事件收集端點（page_view / view_product / add_to_cart /
//   remove_from_cart / begin_checkout / payment_started）。
//
// 安全規則（依需求文件 A4）：
//   1. store_id 必須存在（由 requireStore middleware 驗證並掛在 req.storeId）。
//   2. event_name 必須在白名單內。
//   3. product_id / quantity 型別與範圍驗證。
//   4. metadata 限制大小（4KB），超過直接丟棄該欄位（不擋整筆事件）。
//   5. created_at 一律由資料庫 datetime('now') 產生，不接受前端指定。
//   6. purchase 事件不接受由本端點寫入（submit_order 亦同）——回 403。
//   7. 加入簡易 rate limit，避免同一 session 狂刷。
//   8. 所有查詢以 store_id 隔離。
//
// 不塞進 line-orders.js，獨立成本檔案。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireFeature } = require('../middleware/featureGate'); // fix18-10-hotfix30-B5-R5：新端點需 reports 授權
const {
  EVENT_WHITELIST,
  isValidEventName,
  insertEvent,
} = require('../utils/analyticsLog');
const { resolveDateRange, DashboardDateError } = require('../utils/dashboardDate');
const {
  recordFirstCart,
} = require('../utils/lineMemberStats'); // fix18-10-hotfix23-E
const { verifyMemberSession } = require('../utils/lineMemberSession'); // fix18-10-hotfix23-E：安全 Member Session
const {
  getKpi, getFixedWeekMonth, getFunnel, getRealtime, getCartAnalysis, getProductRanking,
  getPayments, getSources, getRepeatCustomers, getIncomplete,
  getHealthScore, getRecommendations,
  // fix18-10-hotfix23-C（Dashboard V3，附加運算，皆為新函式，不影響上面 Hotfix23-B 既有邏輯）
  getPreviousRange, getKpiComparison, getHealthScoreV2, getTrend30d,
  getProductTiers, getForecast, getTodaySummary, getTodoList, getDailyTip,
  // fix18-10-hotfix23-D（Ads Attribution Foundation，同樣是附加運算，不影響既有欄位）
  getAdsAttribution,
  // fix18-10-hotfix23-E（LINE 會員漏斗 × Customer Journey × CRM Health，附加運算）
  getLineMemberFunnel, getLineCrmKpi, getLineCrmHealth,
  // fix18-10-hotfix30-B（取餐方式衝突 Analytics × 規則式建議，沿用既有 Dashboard API）
  getFulfillmentConflicts, getFulfillmentConflictRecommendations,
  // fix18-10-hotfix30-B5-R5（⏰ 訂單時段分析 × 餐飲時段摘要）
  getOrderHourAnalysis, getOrderPeriodAnalysis,
} = require('../utils/dashboardAnalytics');
// fix18-10-hotfix30-B5-R5（Cart Detail × Accurate Cart Snapshot）
const {
  sanitizeCartSnapshotMetadata, getOpenCartRows, getCartDetail, AGE_BUCKET_QUERY_MAP,
} = require('../utils/cartSnapshot');
// fix18-10-hotfix31-R1（Operation Analytics Drill Down × Visitor 360，Backend Foundation）
const { getDrilldownRows, DIMENSION_COLUMN_MAP, SORT_FIELD_MAP } = require('../utils/drilldown');
const { getVisitorProfile } = require('../utils/visitor360');
// fix18-10-hotfix31-R4（Visitor 360 Audience List × Revisit Score × Customer Status）
const {
  getVisitorAudienceList,
  SORT_FIELD_MAP: AUDIENCE_SORT_FIELD_MAP,
} = require('../utils/visitorAudience');
// fix18-10-hotfix24-A（POS Analytics V2：不新增 API 端點，只掛在既有 dashboard 底下）
const {
  getProductFunnel, getCartAbandonmentByProduct, getProductRankings,
  getSourcePerformance, getCampaignPerformance, getAdsDashboard,
  getCrmOverview, getAiInsightsV2,
} = require('../utils/analyticsV2');
// fix18-10-hotfix24-A1（Part 2/3/4：Tracking Health × Purchase 去重稽核 × Funnel Validation）
const { getAnalyticsHealthReport } = require('../utils/analyticsHealth');
const { getTrackingPeriodInfo } = require('../utils/dashboardDate');
// fix18-10-hotfix24-A3（Identity Resolver × Channel Dimensions）
const { ORDER_CHANNELS, ORDER_CHANNEL_LABELS } = require('../utils/channelResolver');
const { getFunnelSummary, getIdentityBasis } = require('../utils/dashboardAnalytics');

// 前台一般事件端點不接受 submit_order / purchase，以及 LINE 會員入口中「真實性
// 只能由後端確認」的事件（登入結果、好友狀態、CRM 購買事件）：這些只能由後端在
// 真正驗證成功 / 訂單真正成立 / 付款真正成功時寫入（見 routes/line-member.js、
// routes/line-orders.js、routes/line-shipping.js、routes/linepay.js）。
const SERVER_ONLY_EVENTS = new Set([
  'submit_order', 'purchase',
  'line_login_success', 'line_login_failed', 'friend_status_checked',
  'friend_added', 'friend_removed', 'friend_restored',
  'member_login', 'member_profile_updated', 'member_first_cart',
  'member_first_purchase', 'member_repeat_purchase', 'member_source_updated',
]);

// ── 簡易 in-memory rate limit（同一 session_id）───────────────────
// 單一 process 記憶體即可，不需要額外套件；重啟後重置屬預期行為。
// 規則：每個 session_id 每 60 秒最多 60 筆事件。
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const RATE_LIMIT_MAX = 60;
const rateBucket = new Map(); // key: store_id + '|' + session_id → { count, windowStart }

// 避免記憶體無限成長：定期清除過期 bucket
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of rateBucket.entries()) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) rateBucket.delete(key);
  }
}, 5 * 60 * 1000).unref?.();

function checkRateLimit(storeId, sessionId) {
  const key = `${storeId}|${sessionId}`;
  const now = Date.now();
  let entry = rateBucket.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry = { count: 0, windowStart: now };
    rateBucket.set(key, entry);
  }
  entry.count += 1;
  return entry.count <= RATE_LIMIT_MAX;
}

// fix18-10-hotfix30-B 第八點：fulfillment_method_* / mode_conflict 的 metadata
// 欄位級白名單——不信任前端傳來的任意 metadata 結構，只挑出允許的欄位，並對
// affected_products 做數量上限（20 項）與 product_name 長度截斷，且明確排除
// 電話／地址／姓名／Token／LINE User ID 等個資欄位（即使前端不小心夾帶也會被丟棄）。
const FULFILLMENT_EVENTS = new Set([
  'fulfillment_method_view', 'fulfillment_method_selected',
  'fulfillment_method_unavailable', 'fulfillment_method_auto_switched', 'mode_conflict',
]);
const MAX_AFFECTED_PRODUCTS = 20;
const MAX_PRODUCT_NAME_LEN = 60;
function sanitizeFulfillmentMetadata(eventName, metadata) {
  if (!FULFILLMENT_EVENTS.has(eventName)) return metadata; // 其他事件維持既有行為，不受影響
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const out = {};
  if (metadata.cart_id !== undefined) out.cart_id = String(metadata.cart_id).slice(0, 100);
  if (metadata.reason !== undefined) out.reason = String(metadata.reason).slice(0, 60);
  if (metadata.from_mode === 'takeout' || metadata.from_mode === 'delivery') out.from_mode = metadata.from_mode;
  if (metadata.to_mode === 'takeout' || metadata.to_mode === 'delivery') out.to_mode = metadata.to_mode;
  if (metadata.current_mode === 'takeout' || metadata.current_mode === 'delivery') out.current_mode = metadata.current_mode;
  if (Array.isArray(metadata.affected_products)) {
    out.affected_products = metadata.affected_products.slice(0, MAX_AFFECTED_PRODUCTS).map(item => {
      if (!item || typeof item !== 'object') return null;
      const pid = Number(item.product_id);
      const safe = {};
      if (Number.isFinite(pid) && pid > 0) safe.product_id = Math.trunc(pid);
      if (item.product_name !== undefined) safe.product_name = String(item.product_name).slice(0, MAX_PRODUCT_NAME_LEN);
      // available_modes 只接受布林值形式的 takeout/delivery 摘要，不接受其他任意欄位
      if (typeof item.takeout === 'boolean' || typeof item.delivery === 'boolean') {
        safe.available_modes = { takeout: !!item.takeout, delivery: !!item.delivery };
      } else if (item.available_modes && typeof item.available_modes === 'object') {
        safe.available_modes = { takeout: !!item.available_modes.takeout, delivery: !!item.available_modes.delivery };
      }
      return Object.keys(safe).length ? safe : null;
    }).filter(Boolean);
  }
  return out;
}

// ── POST /api/analytics/events ──────────────────────────────────
router.post('/events', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId; // requireStore middleware 已驗證 store 存在且啟用

    const {
      visitor_id, session_id, cart_id, event_name,
      product_id, quantity, order_mode,
      source, medium, campaign, referrer, landing_page,
      fbclid, gclid, metadata,
      // fix18-10-hotfix23-E：LINE 會員入口 —— 若顧客已登入，前端會附上（後端簽發的）
      // member_session，只用來做「第一次加入購物車」CRM 記錄，不影響事件本身是否
      // 寫入。一律經 verifyMemberSession 驗證，驗證失敗一律當作未登入。
      member_session,
    } = req.body || {};

    // ── 基本必填欄位 ──
    if (!visitor_id || typeof visitor_id !== 'string' || !visitor_id.trim()) {
      return res.status(400).json({ success: false, message: '缺少 visitor_id' });
    }
    if (!session_id || typeof session_id !== 'string' || !session_id.trim()) {
      return res.status(400).json({ success: false, message: '缺少 session_id' });
    }
    if (!event_name || typeof event_name !== 'string') {
      return res.status(400).json({ success: false, message: '缺少 event_name' });
    }

    // ── event_name 白名單 + server-only 事件擋下 ──
    if (SERVER_ONLY_EVENTS.has(event_name)) {
      return res.status(403).json({
        success: false,
        message: `event_name "${event_name}" 只能由伺服器寫入，前端不可直接送出`,
      });
    }
    if (!isValidEventName(event_name)) {
      return res.status(400).json({
        success: false,
        message: `不支援的 event_name（允許：${EVENT_WHITELIST.join(', ')}）`,
      });
    }

    // ── rate limit（同一 session_id）──
    if (!checkRateLimit(storeId, session_id)) {
      return res.status(429).json({ success: false, message: '事件送出過於頻繁，請稍後再試' });
    }

    // ── product_id / quantity 型別與範圍驗證 ──
    let pid = null;
    if (product_id !== undefined && product_id !== null && product_id !== '') {
      const n = Number(product_id);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        return res.status(400).json({ success: false, message: 'product_id 格式錯誤' });
      }
      pid = n;
    }
    let qty = 1;
    if (quantity !== undefined && quantity !== null && quantity !== '') {
      const n = Number(quantity);
      if (!Number.isFinite(n) || n < 1 || n > 999 || !Number.isInteger(n)) {
        return res.status(400).json({ success: false, message: 'quantity 格式錯誤（允許範圍 1~999）' });
      }
      qty = n;
    }

    // ── metadata 大小限制（超過則整個丟棄，不擋事件本身）── 交由 insertEvent 處理

    // ── fix18-10-hotfix24-A3：共用 Identity Resolver（需求文件四）──────────────
    // 前台一般事件一律附帶 member_session，只在驗證通過（本店已知、未過期、簽章
    // 正確）時才把 line_user_id 當作最高優先的身份依據；驗證失敗一律視為未登入，
    // 退回用 session_id 辨識（不得使用未驗證的前端聲稱值）。這裡只驗證一次，
    // 結果同時供下面 insertEvent() 的 identity resolver 與既有 CRM first_cart
    // 記錄共用，不必重複驗證。
    let knownLineUserId = null;
    if (member_session) {
      try { knownLineUserId = verifyMemberSession(member_session, storeId); } catch (e2) { knownLineUserId = null; }
    }

    const ok = insertEvent(db, {
      store_id: storeId,
      visitor_id: visitor_id.trim(),
      session_id: session_id.trim(),
      cart_id: cart_id || null,
      order_id: null, // 一般事件不帶 order_id（submit_order/purchase 由後端寫入時才帶）
      event_name,
      product_id: pid,
      quantity: qty,
      order_mode: order_mode || null,
      source: source || null,
      medium: medium || null,
      campaign: campaign || null,
      referrer: referrer || null,
      landing_page: landing_page || null,
      fbclid: fbclid || null,
      gclid: gclid || null,
      // fix18-10-hotfix30-B5-R5：cart_updated / cart_restored 的 metadata 欄位級白名單
      // （sanitizeFulfillmentMetadata 對其他事件維持既有行為，兩者互不影響對方事件）。
      metadata: sanitizeCartSnapshotMetadata(event_name, sanitizeFulfillmentMetadata(event_name, metadata)) || null,
      // fix18-10-hotfix24-A3：Identity × Channel × Page Type（需求文件四／六／七）
      line_user_id: knownLineUserId || null,
      // 前台一般事件只可能來自 LINE 點餐／宅配頁面（POS 收銀端本身不呼叫這支 API，
      // 見需求文件十一），因此渠道判斷以 'line' 為訂單來源基準。
      channel_source: 'line',
    });

    if (!ok) {
      return res.status(500).json({ success: false, message: '事件寫入失敗' });
    }

    // ── fix18-10-hotfix23-E：第一次 add_to_cart 記錄 CRM first_cart（需求文件八）──
    // 只在 member_session 驗證通過（本店已知、未過期、簽章正確）時才記錄；
    // 未知/偽造/過期的 session 一律被 verifyMemberSession 擋下，不建立資料。
    // 失敗絕不影響事件本身是否成功寫入（已經 res.json 前完成，且包在 try/catch）。
    if (event_name === 'add_to_cart' && knownLineUserId) {
      try {
        recordFirstCart(db, storeId, knownLineUserId, pid);
      } catch (crmErr) {
        console.warn('[analytics] first_cart CRM hook failed:', crmErr.message);
      }
    }

    res.json({ success: true });
  } catch (e) {
    console.error('[analytics] POST /events error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix23-B：老闆儀表板 V2 × Conversion Analytics
// GET /api/analytics/dashboard?preset=today|yesterday|week|month|lastmonth|single|custom
//                              &start_date=&end_date=&timezone=Asia/Taipei
//
// 一次回傳所有區塊需要的資料，前端不得每張卡片各自打 API（需求文件四）。
// 舊的 GET /api/dashboard（routes/dashboard.js）維持不動，兩支 API 並存。
// ══════════════════════════════════════════════════════════════════
router.get('/dashboard', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;

    let range;
    try {
      range = resolveDateRange(req.query);
    } catch (e) {
      if (e instanceof DashboardDateError) {
        return res.status(400).json({ success: false, message: e.message });
      }
      throw e;
    }

    // fix18-10-hotfix24-A3（需求文件十一）：?channel= 篩選，沿用既有
    // /api/analytics/dashboard，不是第二套 API。未帶 channel 或帶不合法值
    // 一律當作 'all'，不報錯（需求文件七：舊呼叫必須保持相容）。
    const rawChannel = (req.query.channel || 'all').trim();
    const channel = (rawChannel === 'all' || ORDER_CHANNELS.includes(rawChannel)) ? rawChannel : 'all';

    const kpi = getKpi(db, storeId, range, channel);
    const fixedWeekMonth = getFixedWeekMonth(db, storeId);
    const funnel = getFunnel(db, storeId, range, channel);
    const realtime = getRealtime(db, storeId);
    // fix18-10-hotfix31-R4（需求文件 B/C，Channel Count Consistency 根因修正）：
    // 這幾個區塊過去沒有接住 channel 參數，導致選了「LINE 外送」之後 KPI／Funnel
    // 換成外送數字，但 Cart Abandonment／商品排行／付款分析／來源／回購／未完成訂單
    // 仍然顯示全渠道數字——這是「渠道資料只出現在『全部』底下」這個回報問題的根因。
    const cart = getCartAnalysis(db, storeId, range, channel);
    const products = getProductRanking(db, storeId, range, channel);
    const payments = getPayments(db, storeId, range, channel);
    const sources = getSources(db, storeId, range, kpi, channel);
    const repeat_customers = getRepeatCustomers(db, storeId, range, channel);
    const incomplete = getIncomplete(db, storeId, range, channel);
    const health_score = getHealthScore(kpi, funnel, cart, repeat_customers, payments);
    const recommendations = getRecommendations(funnel, cart, payments, repeat_customers);

    // analytics_events 是否有足夠資料（用來判斷 Conversion 區塊要不要顯示「尚無足夠資料」）
    const hasAnalyticsData = funnel.some(f => f.count > 0);

    // ── fix18-10-hotfix23-C｜Dashboard V3 附加運算 ──────────────────────
    // 全部只讀取上面已經算好的資料／同一個 db，不新增重複查詢的 API 端點。
    const previousRange = getPreviousRange(range);
    const previousKpi = getKpi(db, storeId, previousRange, channel);
    const kpi_comparison = getKpiComparison(kpi, previousKpi);
    const health_score_v2 = getHealthScoreV2(kpi_comparison, funnel, cart, repeat_customers, payments, health_score);
    const trend_30d = getTrend30d(db, storeId);
    const product_tiers = getProductTiers(products);
    const forecast = getForecast(kpi, range);
    const today_summary = getTodaySummary(realtime, forecast, kpi);
    const todo_list = getTodoList(db, storeId, incomplete, repeat_customers);
    const ai_daily_tip = getDailyTip(recommendations, product_tiers, products, cart);

    // ── fix18-10-hotfix23-D｜Ads Attribution Foundation 附加運算 ─────────
    // 一樣附加在同一次 API 回應裡，不新增端點；解析 metadata 失敗不得讓整支 API 500
    // （getAdsAttribution 內部已對每筆 metadata_json 做 try/catch）。
    let ads_attribution;
    try {
      ads_attribution = getAdsAttribution(db, storeId, range);
    } catch (adErr) {
      console.error('[analytics] ads_attribution computation failed:', adErr.message);
      ads_attribution = {
        mode: 'last_touch', sources: [], campaigns: [], revenue: { last_touch: 0, first_touch: 0 },
        first_touch_available: false, note: '廣告來源資料計算失敗',
        by_mode: { last_touch: { sources: [], campaigns: [], revenue: 0 }, first_touch: { insufficient_data: true, message: '廣告來源資料計算失敗', sources: [], campaigns: [], revenue: 0 } },
      };
    }

    // ── fix18-10-hotfix23-E｜LINE 會員入口 × Customer Journey × CRM Health ──
    // 同樣附加運算，失敗不得讓整支 API 500。
    let line_member_funnel, line_crm_kpi, line_crm_health;
    try {
      line_member_funnel = getLineMemberFunnel(db, storeId, range);
    } catch (lmErr) {
      console.error('[analytics] line_member_funnel computation failed:', lmErr.message);
      line_member_funnel = { insufficient_data: true, message: 'LINE 會員漏斗資料計算失敗', stages: [] };
    }
    try {
      line_crm_kpi = getLineCrmKpi(db, storeId, range);
    } catch (lmErr) {
      console.error('[analytics] line_crm_kpi computation failed:', lmErr.message);
      line_crm_kpi = { insufficient_data: true, message: 'LINE 會員 KPI 計算失敗' };
    }
    try {
      line_crm_health = getLineCrmHealth(line_crm_kpi);
    } catch (lmErr) {
      console.error('[analytics] line_crm_health computation failed:', lmErr.message);
      line_crm_health = { insufficient_data: true, message: 'LINE CRM 健康度計算失敗' };
    }

    // ── fix18-10-hotfix24-A｜POS Analytics V2 附加運算 ────────────────
    // 全部沿用上面已算好的資料／同一個 db，任何一段失敗都不得讓整支 API 500。
    let analytics_v2;
    try {
      // fix18-10-hotfix31-R4（需求文件 B/C）：同上，analytics_v2 底下的商品漏斗／
      // 來源分析／Campaign 分析也要接住同一個 channel，跟 KPI/Funnel 保持一致。
      const productFunnel = getProductFunnel(db, storeId, range, channel);
      const cartAbandonment = getCartAbandonmentByProduct(productFunnel);
      const productRankings = getProductRankings(productFunnel);
      const sourcePerformance = getSourcePerformance(db, storeId, range, channel);
      const campaigns = getCampaignPerformance(db, storeId, range, channel);
      const adsDashboard = getAdsDashboard(sourcePerformance);
      // fix18-10-hotfix31-R4 已知限制：CRM Dashboard（getCrmOverview）彙總的是
      // 「LINE 會員本身」（line_members 表），不是「某個渠道底下的事件」——同一位
      // 會員可能同時透過 LINE 外帶與 LINE 外送下單，「這個會員屬於哪個渠道」沒有
      // 單一答案，因此本輪刻意不對 CRM Dashboard 套用 channel 篩選（沿用需求文件
      // 十九「新增欄位不得破壞既有欄位語意」的同一個保守原則），並在 CHANGELOG
      // 明確記錄為已知限制，而不是假裝套用了篩選。
      const crm = getCrmOverview(db, storeId, range);
      const aiInsights = getAiInsightsV2(cartAbandonment, sourcePerformance, productFunnel, crm);
      // 需求文件十一：資料量不足時顯示固定訊息，而不是空陣列或報錯
      const aiInsightsFinal = hasAnalyticsData
        ? aiInsights
        : [{ type: 'insufficient_data', severity: 'info',
             problem: '目前資料量不足',
             evidence: '此區間尚無足夠的瀏覽與訂單事件',
             actions: [], values: {},
             message: '目前資料量不足，累積更多瀏覽與訂單後才能提供可靠建議。' }];
      analytics_v2 = {
        insufficient_data: !hasAnalyticsData,
        rule_engine_only: true, // 需求文件十一：本版僅 Rule Engine，未串接外部 AI API
        product_funnel: hasAnalyticsData ? productFunnel : [],
        cart_abandonment: hasAnalyticsData ? cartAbandonment : { rows: [], top_abandon_products: [] },
        product_rankings: hasAnalyticsData ? productRankings : {
          top_sales: [], top_revenue: [], top_conversion: [], highest_cart: [], lowest_conversion: [], highest_abandon: [],
          min_sample_threshold: 5, excluded_low_sample_count: 0,
        },
        source_performance: sourcePerformance,
        campaigns,
        ads_dashboard: adsDashboard,
        crm,
        ai_insights: aiInsightsFinal,
      };
    } catch (v2Err) {
      console.error('[analytics] analytics_v2 computation failed:', v2Err.message, v2Err.stack);
      analytics_v2 = {
        insufficient_data: true,
        rule_engine_only: true,
        message: 'POS Analytics V2 計算失敗',
        product_funnel: [], cart_abandonment: { rows: [], top_abandon_products: [] },
        product_rankings: { top_sales: [], top_revenue: [], top_conversion: [], highest_cart: [], lowest_conversion: [], highest_abandon: [] },
        source_performance: [], campaigns: { available: false, message: '尚未取得 Campaign 資料', rows: [] },
        ads_dashboard: [], crm: { insufficient_data: true, message: 'CRM 資料計算失敗', total_members: 0 },
        ai_insights: [],
      };
    }

    // ── fix18-10-hotfix24-A3｜Funnel Summary × Identity Basis × Channel Meta ──
    // 全部是新增欄位，既有 funnel/kpi 等既有欄位結構完全不變（需求文件十九）。
    let funnel_summary, identity_basis;
    try {
      funnel_summary = getFunnelSummary(funnel);
    } catch (fsErr) {
      console.error('[analytics] funnel_summary computation failed:', fsErr.message);
      funnel_summary = null;
    }
    try {
      identity_basis = getIdentityBasis(db, storeId, range, channel);
    } catch (ibErr) {
      console.error('[analytics] identity_basis computation failed:', ibErr.message);
      identity_basis = { identity_basis: null, identity_is_estimated: null, sample_size: 0 };
    }

    // ── fix18-10-hotfix30-B5-R5（需求文件二十二）：⏰ 訂單時段分析 × 餐飲時段摘要 ──
    // 沿用同一個 range／channel（不新增第二套日期或渠道邏輯，不新增 API 端點）。
    let order_hour_analysis, order_period_analysis;
    try {
      order_hour_analysis = getOrderHourAnalysis(db, storeId, range, channel);
      order_period_analysis = getOrderPeriodAnalysis(order_hour_analysis);
    } catch (ohErr) {
      console.error('[analytics] order_hour_analysis computation failed:', ohErr.message);
      order_hour_analysis = {
        basis: 'order_created_at', basis_label: '訂單成立時間', timezone: 'Asia/Taipei',
        total_orders: 0, total_revenue: 0, peak_hour: null, peak_period: null,
        rows: Array.from({ length: 24 }, (_, h) => ({ hour: h, label: `${String(h).padStart(2,'0')}:00–${String(h).padStart(2,'0')}:59`, orders: 0, revenue: 0, avg_order_value: 0, order_share: 0, revenue_share: 0 })),
      };
      order_period_analysis = [];
    }

    // ── fix18-10-hotfix30-B5-R5（需求文件「Cart Detail × Accurate Cart Snapshot」）：
    // 【B. 目前未完成購物車】KPI 摘要（獨立於「所選期間」）。詳細逐筆清單走
    // 下面新增的分頁端點 GET /api/analytics/cart-abandonment，這裡只附加彙總
    // 數字到既有 cart 物件裡（保留 cart 原欄位，只新增 current_open_summary）。
    let cartOpenSummary;
    try {
      cartOpenSummary = getOpenCartRows(db, storeId, { page: 1, limit: 1 }).current_open_summary;
    } catch (cartErr) {
      console.error('[analytics] cart current_open_summary computation failed:', cartErr.message);
      cartOpenSummary = { open_carts: 0, open_amount: 0, over_24h: 0, line_identified: 0 };
    }
    if (cart && typeof cart === 'object') cart.current_open_summary = cartOpenSummary;

    // ── fix18-10-hotfix30-B（需求文件第一、二點）：取餐方式衝突 Analytics ──────
    // 沿用同一個 range（不新增第二套日期邏輯），沿用同一支 GET /dashboard（不新增 API）。
    let fulfillment_conflicts, fulfillment_recommendations;
    try {
      fulfillment_conflicts = getFulfillmentConflicts(db, storeId, range);
      fulfillment_recommendations = getFulfillmentConflictRecommendations(fulfillment_conflicts);
    } catch (fcErr) {
      console.error('[analytics] fulfillment_conflicts computation failed:', fcErr.message);
      fulfillment_conflicts = {
        insufficient_data: true, message: '取餐方式衝突資料計算失敗',
        total_conflicts: 0, affected_carts: 0, resolved_carts: 0, unresolved_carts: 0,
        conversion_rate: null, top_products: [], top_reasons: [],
      };
      fulfillment_recommendations = [];
    }

    res.json({
      success: true,
      range: {
        preset: range.preset,
        start_date: range.start_date,
        end_date: range.end_date,
        timezone: range.timezone,
      },
      kpi: {
        revenue: kpi.revenue,
        orders: kpi.orders,
        avg_order_value: kpi.avg_order_value,
        paid_orders: kpi.paid_orders,
        unpaid_orders: kpi.unpaid_orders,
        is_today: kpi.is_today,
        payment_stats: kpi.paymentStats,
        top_products: kpi.topProducts,
        week_revenue: fixedWeekMonth.week_revenue,
        week_orders: fixedWeekMonth.week_orders,
        month_revenue: fixedWeekMonth.month_revenue,
        month_orders: fixedWeekMonth.month_orders,
      },
      funnel: hasAnalyticsData ? funnel : { insufficient_data: true, message: '尚無足夠的轉換事件資料', stages: funnel },
      realtime,
      cart: hasAnalyticsData ? cart : { insufficient_data: true, message: '尚無足夠的轉換事件資料' },
      products: hasAnalyticsData ? products : [],
      payments: hasAnalyticsData ? payments : { rows: [], note: '尚無足夠的轉換事件資料' },
      sources,
      repeat_customers,
      incomplete,
      health_score,
      recommendations: hasAnalyticsData ? recommendations : [],

      // fix18-10-hotfix23-C（Dashboard V3）—— 全部是新增欄位，既有欄位一律不變
      kpi_comparison,
      health_score_v2,
      trend_30d,
      product_tiers,
      forecast,
      today_summary,
      todo_list,
      ai_daily_tip,

      // fix18-10-hotfix23-D（Ads Attribution Foundation）—— 新增欄位
      ads_attribution,

      // fix18-10-hotfix23-E（LINE 會員入口 × Customer Journey × CRM Health）—— 新增欄位
      line_member_funnel,
      line_crm_kpi,
      line_crm_health,

      // fix18-10-hotfix24-A（POS Analytics V2：Product Funnel × Cart Abandonment ×
      // Source Performance × Campaign × Ads Dashboard × CRM × AI Insights）—— 新增欄位
      analytics_v2,

      // fix18-10-hotfix24-A1（Part 7：舊資料與新資料分離）—— 新增欄位，不影響既有欄位
      tracking_meta: getTrackingPeriodInfo(range),

      // fix18-10-hotfix24-A3（Identity Resolver × Channel Dimensions × Funnel Accuracy）
      // —— 全部新增欄位，既有 funnel／kpi 陣列與物件結構完全不變（需求文件十九）。
      funnel_summary,
      identity_basis: identity_basis.identity_basis,
      identity_is_estimated: identity_basis.identity_is_estimated,
      channel_filter: {
        current: channel,
        available: ['all', ...ORDER_CHANNELS.filter(c => c !== 'unknown')],
        labels: { all: '全部', ...ORDER_CHANNEL_LABELS },
      },

      // fix18-10-hotfix30-B（取餐方式衝突 Analytics × 規則式建議）—— 新增欄位，
      // 既有欄位結構完全不變。
      fulfillment_conflicts,
      fulfillment_recommendations,

      // fix18-10-hotfix30-B5-R5（⏰ 訂單時段分析 × 餐飲時段摘要）—— 新增欄位，
      // 既有欄位結構完全不變。cart.current_open_summary 也是新增欄位（見上方）。
      order_hour_analysis,
      order_period_analysis,
    });
  } catch (e) {
    console.error('[analytics] GET /dashboard error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix24-A1｜Part 2/3/4：Tracking Health × Purchase 去重稽核 × Funnel Validation
// GET /api/analytics/health?preset=today|yesterday|week|month|lastmonth|single|custom
//                          &start_date=&end_date=&timezone=Asia/Taipei
//
// 純唯讀診斷端點，掛在同一個 router 底下（不是第二套 Analytics API）：
//   - tracking_health：最後事件時間／近5分鐘事件數／今日各事件總數／是否停止追蹤
//   - purchase_dedup_audit：稽核是否有重複 purchase（寫入時已由 logServerEvent +
//     DB unique index 防止，這裡只是唯讀確認防護生效）
//   - utm_audit：稽核是否還有 NULL/空字串的 source/campaign（新事件已在寫入時正規化）
//   - funnel_validation：Analytics purchase 訂單數 vs orders 表付款訂單數，
//     差異超過 ±1% 顯示「⚠ Funnel 與訂單資料不一致」
// ══════════════════════════════════════════════════════════════════
router.get('/health', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const report = getAnalyticsHealthReport(db, storeId, req.query);
    res.json({ success: true, ...report });
  } catch (e) {
    console.error('[analytics] GET /health error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5｜【未完成購物車明細】分頁 API
// GET /api/analytics/cart-abandonment?status=&age_bucket=&identity=&order_mode=&page=&limit=
//
// 獨立於「所選期間」（見 utils/cartSnapshot.js getOpenCartRows() 註解）：
// 只看「目前」未完成、最近 30 天內仍有活動的購物車，不受今天有沒有新的
// add_to_cart 影響。requireFeature('reports') 保護，同一組 store guard。
// 所有查詢一律以 store_id 隔離；cart_id 一律參數化查詢，不做字串拼接。
// ══════════════════════════════════════════════════════════════════
const ORDER_MODE_FILTERS = new Set(['all', 'takeout', 'delivery', 'shipping']);
const IDENTITY_FILTERS = new Set(['all', 'line', 'visitor']);
const STATUS_FILTERS = new Set(['all', 'active', 'checkout', 'abandoned']);

router.get('/cart-abandonment', requireFeature('reports'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const q = req.query || {};

    const orderMode = ORDER_MODE_FILTERS.has(q.order_mode) ? q.order_mode : 'all';
    const identity = IDENTITY_FILTERS.has(q.identity) ? q.identity : 'all';
    const status = STATUS_FILTERS.has(q.status) ? q.status : 'all';
    const ageBucket = (q.age_bucket && Object.prototype.hasOwnProperty.call(AGE_BUCKET_QUERY_MAP, q.age_bucket)) ? q.age_bucket : 'all';
    // limit 最大 100（需求文件）
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const page = Math.max(1, parseInt(q.page, 10) || 1);

    const result = getOpenCartRows(db, storeId, { page, limit, status, age_bucket: ageBucket, identity, order_mode: orderMode });
    res.json({
      success: true,
      page: result.page,
      limit: result.limit,
      total: result.total,
      total_pages: Math.max(1, Math.ceil(result.total / result.limit)),
      current_open_summary: result.current_open_summary,
      rows: result.rows,
      filters: { status, age_bucket: ageBucket, identity, order_mode: orderMode },
    });
  } catch (e) {
    console.error('[analytics] GET /cart-abandonment error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// GET /api/analytics/cart-abandonment/:cartId — 單一購物車詳情 + 完整事件時間軸。
// cart_id 透過 db.all/db.get 的參數化查詢傳入（見 utils/cartSnapshot.js），不拼字串。
// 完整 LINE UID 預設不回傳（line_uid_full 只在權限允許時附上，本版預留擴充點，
// 尚未接上實際角色權限判斷，先保守回傳 undefined，前端一律走遮罩顯示）。
router.get('/cart-abandonment/:cartId', requireFeature('reports'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const cartId = String(req.params.cartId || '').slice(0, 200);
    if (!cartId) return res.status(400).json({ success: false, message: '缺少 cartId' });

    const detail = getCartDetail(db, storeId, cartId, { includeFullUid: false });
    if (!detail) return res.status(404).json({ success: false, message: '找不到這個購物車（可能不存在或不屬於此店家）' });
    res.json({ success: true, cart: detail });
  } catch (e) {
    console.error('[analytics] GET /cart-abandonment/:cartId error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix31-R1｜Operation Analytics Drill Down
// GET /api/analytics/drilldown?event_name=&source=&campaign=&medium=&order_mode=
//   &identity_type=&order_channel=&page_type=&date_from=&date_to=&page=&limit=
//   &include_purchased=
//
// 需求文件四：「所有圖表皆為 Filter」——點任何 KPI／圖表區塊都能查出符合條件的
// 訪客/會員/Session/購物車清單。這裡只接受白名單維度（見 DIMENSION_COLUMN_MAP），
// 不接受任意欄位名稱。與 /cart-abandonment 的差異：這裡不排除已購買的購物車
// （Drill Down 需要能看到「已成交」的人），/cart-abandonment 仍維持原本只看
// 未完成購物車的行為，兩者互不影響。
// ══════════════════════════════════════════════════════════════════
router.get('/drilldown', requireFeature('reports'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const q = req.query || {};

    const filters = {};
    Object.keys(DIMENSION_COLUMN_MAP).forEach((key) => {
      if (q[key] !== undefined && q[key] !== '') filters[key] = String(q[key]).slice(0, 200);
    });
    if (q.date_from) filters.date_from = String(q.date_from).slice(0, 32);
    if (q.date_to) filters.date_to = String(q.date_to).slice(0, 32);
    if (q.product_id) filters.product_id = q.product_id;
    if (q.min_amount) filters.min_amount = q.min_amount;
    if (q.max_amount) filters.max_amount = q.max_amount;
    if (q.cart_status) filters.cart_status = q.cart_status;
    if (q.identity_state) filters.identity_state = q.identity_state;
    if (q.friend_status) filters.friend_status = q.friend_status;
    if (q.age_bucket) filters.age_bucket = q.age_bucket;

    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const includePurchased = q.include_purchased !== 'false';
    const sortBy = SORT_FIELD_MAP[q.sort_by] ? q.sort_by : undefined;
    const sortDir = q.sort_dir;

    const result = getDrilldownRows(db, storeId, filters, { page, limit, include_purchased: includePurchased, sort_by: sortBy, sort_dir: sortDir });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[analytics] GET /drilldown error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix31-R1｜Visitor 360（會員360）
// GET /api/analytics/visitor/:key — key 可以是 line_user_id 或 visitor_id
// ══════════════════════════════════════════════════════════════════
router.get('/visitor/:key', requireFeature('reports'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const key = String(req.params.key || '').slice(0, 200);
    if (!key) return res.status(400).json({ success: false, message: '缺少 key' });

    const profile = getVisitorProfile(db, storeId, key, { includeFullUid: false });
    if (!profile) return res.status(404).json({ success: false, message: '找不到這位訪客/會員（可能不存在或不屬於此店家）' });
    res.json({ success: true, visitor: profile });
  } catch (e) {
    console.error('[analytics] GET /visitor/:key error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix31-R4｜Visitor 360 Audience List（需求文件 G/H/I/J）
// GET /api/analytics/visitor-360?identity=&friend_status=&visit_frequency=
//   &purchase_behavior=&activity=&min_visit_count=&max_visit_count=&min_cart_count=
//   &max_cart_count=&min_order_count=&max_order_count=&min_revenue=&max_revenue=
//   &min_aov=&max_aov=&min_revisit_score=&max_revisit_score=&source=&campaign=
//   &channel=&order_mode=&sort_by=&sort_dir=&page=&limit=
//
// 每一列是一個「人」（canonical visitor/member），不是一筆事件、不是一張購物車。
// Server-side 分頁（需求文件 G：不得把整店訪客都撈到瀏覽器）。點任何一列的
// 「詳情」按鈕，前端應直接重用既有 GET /api/analytics/visitor/:key。
// ══════════════════════════════════════════════════════════════════
router.get('/visitor-360', requireFeature('reports'), (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const q = req.query || {};

    const filters = {
      identity: q.identity, friend_status: q.friend_status,
      visit_frequency: q.visit_frequency, purchase_behavior: q.purchase_behavior,
      activity: q.activity,
      min_visit_count: q.min_visit_count, max_visit_count: q.max_visit_count,
      min_cart_count: q.min_cart_count, max_cart_count: q.max_cart_count,
      min_order_count: q.min_order_count, max_order_count: q.max_order_count,
      min_revenue: q.min_revenue, max_revenue: q.max_revenue,
      min_aov: q.min_aov, max_aov: q.max_aov,
      min_revisit_score: q.min_revisit_score, max_revisit_score: q.max_revisit_score,
      source: q.source, campaign: q.campaign, channel: q.channel, order_mode: q.order_mode,
    };
    const limit = Math.min(100, Math.max(1, parseInt(q.limit, 10) || 20));
    const page = Math.max(1, parseInt(q.page, 10) || 1);
    const sortBy = AUDIENCE_SORT_FIELD_MAP[q.sort_by] ? q.sort_by : undefined;
    const sortDir = q.sort_dir;

    const result = getVisitorAudienceList(db, storeId, filters, { page, limit, sort_by: sortBy, sort_dir: sortDir });
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('[analytics] GET /visitor-360 error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});
