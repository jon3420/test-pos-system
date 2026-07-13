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
const {
  EVENT_WHITELIST,
  isValidEventName,
  insertEvent,
} = require('../utils/analyticsLog');
const { resolveDateRange, DashboardDateError } = require('../utils/dashboardDate');
const {
  getKpi, getFixedWeekMonth, getFunnel, getRealtime, getCartAnalysis, getProductRanking,
  getPayments, getSources, getRepeatCustomers, getIncomplete,
  getHealthScore, getRecommendations,
} = require('../utils/dashboardAnalytics');

// 前台一般事件端點不接受 submit_order / purchase：這兩者只能由後端在
// 訂單真正成立 / 付款真正成功時寫入（見 routes/line-orders.js、
// routes/line-shipping.js、routes/linepay.js）。
const SERVER_ONLY_EVENTS = new Set(['submit_order', 'purchase']);

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
      metadata: metadata || null,
    });

    if (!ok) {
      return res.status(500).json({ success: false, message: '事件寫入失敗' });
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

    const kpi = getKpi(db, storeId, range);
    const fixedWeekMonth = getFixedWeekMonth(db, storeId);
    const funnel = getFunnel(db, storeId, range);
    const realtime = getRealtime(db, storeId);
    const cart = getCartAnalysis(db, storeId, range);
    const products = getProductRanking(db, storeId, range);
    const payments = getPayments(db, storeId, range);
    const sources = getSources(db, storeId, range, kpi);
    const repeat_customers = getRepeatCustomers(db, storeId, range);
    const incomplete = getIncomplete(db, storeId, range);
    const health_score = getHealthScore(kpi, funnel, cart, repeat_customers, payments);
    const recommendations = getRecommendations(funnel, cart, payments, repeat_customers);

    // analytics_events 是否有足夠資料（用來判斷 Conversion 區塊要不要顯示「尚無足夠資料」）
    const hasAnalyticsData = funnel.some(f => f.count > 0);

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
    });
  } catch (e) {
    console.error('[analytics] GET /dashboard error:', e.message, e.stack);
    res.status(500).json({ success: false, message: e.message });
  }
});
