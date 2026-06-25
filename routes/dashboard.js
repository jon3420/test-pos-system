// routes/dashboard.js — SaaS R1 fix16b
// 老闆儀表板 Dashboard API（requireFeature('reports') 保護）
// 未來供 Android POS 共用
'use strict';

const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

function twToday() {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function twDateRange(daysAgo) {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  n.setDate(n.getDate() - daysAgo);
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function weekStart() {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  const day = n.getDay(); // 0=Sun
  n.setDate(n.getDate() - (day === 0 ? 6 : day - 1)); // Mon
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')}`;
}
function monthStart() {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-01`;
}

// GET /api/dashboard
// Query: ?date=YYYY-MM-DD (預設今日)
router.get('/', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    const today   = req.query.date || twToday();
    const wStart  = weekStart();
    const mStart  = monthStart();

    const baseWhere = "store_id=? AND status!='void' AND (order_status IS NULL OR order_status!='cancelled')";

    // ── 今日 ─────────────────────────────────────────────
    const todayWhere  = `${baseWhere} AND DATE(created_at)=?`;
    const todayParams = [storeId, today];

    const todayStats = db.get(
      `SELECT COUNT(*) as total_orders,
              SUM(CASE WHEN status='completed' OR status='modified' THEN 1 ELSE 0 END) as paid_orders,
              SUM(CASE WHEN status NOT IN ('completed','modified','void') THEN 1 ELSE 0 END) as unpaid_orders,
              COALESCE(SUM(CASE WHEN status IN ('completed','modified') THEN total ELSE 0 END),0) as total_revenue,
              COALESCE(AVG(CASE WHEN status IN ('completed','modified') THEN total END),0) as avg_order_value
       FROM orders WHERE ${todayWhere}`, todayParams
    ) || {};

    // 付款方式
    const paymentStats = db.all(
      `SELECT COALESCE(payment_method,'cash') as payment_method,
              COUNT(*) as count,
              COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${todayWhere}
       GROUP BY payment_method ORDER BY revenue DESC`, todayParams
    );

    // 訂單來源
    const sourceStats = db.all(
      `SELECT COALESCE(order_mode,'dine_in') as mode,
              COALESCE(delivery_platform,'') as platform,
              COUNT(*) as count,
              COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${todayWhere}
       GROUP BY order_mode, delivery_platform ORDER BY count DESC`, todayParams
    );

    // 熱銷商品 TOP 10
    const allTodayOrders = db.all(`SELECT items FROM orders WHERE ${todayWhere}`, todayParams);
    const productMap = {};
    allTodayOrders.forEach(o => {
      try {
        JSON.parse(o.items || '[]').forEach(item => {
          const key = item.name;
          if (!productMap[key]) productMap[key] = { name: key, qty: 0, revenue: 0 };
          productMap[key].qty     += Number(item.qty      || 1);
          productMap[key].revenue += Number(item.subtotal || item.price * item.qty || 0);
        });
      } catch {}
    });
    const topProducts = Object.values(productMap)
      .sort((a, b) => b.qty - a.qty).slice(0, 10);

    // 外送平台
    const deliveryStats = db.all(
      `SELECT COALESCE(delivery_platform,'其他') as platform,
              COUNT(*) as count,
              COALESCE(SUM(total),0) as revenue,
              COALESCE(SUM(platform_commission_amount),0) as commission,
              COALESCE(SUM(store_actual_income),0) as store_income
       FROM orders
       WHERE ${baseWhere} AND DATE(created_at)=? AND order_mode='delivery'
       GROUP BY delivery_platform ORDER BY revenue DESC`, todayParams
    );

    // 時段分析（0-23 小時）
    const hourlyRaw = db.all(
      `SELECT CAST(strftime('%H', created_at) AS INTEGER) as hour,
              COUNT(*) as count,
              COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${todayWhere}
       GROUP BY hour ORDER BY hour`, todayParams
    );
    const hourlyStats = Array.from({ length: 24 }, (_, h) => {
      const found = hourlyRaw.find(r => Number(r.hour) === h);
      return { hour: h, label: `${String(h).padStart(2,'0')}:00`, count: found?.count || 0, revenue: found?.revenue || 0 };
    });

    // 星期分析（最近 4 週）
    const WEEKDAYS = ['日','一','二','三','四','五','六'];
    const weekdayRaw = db.all(
      `SELECT CAST(strftime('%w', created_at) AS INTEGER) as wd,
              COUNT(*) as count,
              COALESCE(SUM(total),0) as revenue
       FROM orders
       WHERE ${baseWhere} AND DATE(created_at) >= ?
       GROUP BY wd`, [storeId, twDateRange(27)]
    );
    const weekdayStats = Array.from({ length: 7 }, (_, i) => {
      const found = weekdayRaw.find(r => Number(r.wd) === i);
      return { day: i, label: `週${WEEKDAYS[i]}`, count: found?.count || 0, revenue: found?.revenue || 0 };
    });

    // ── 本週 / 本月 ──────────────────────────────────────
    const weekStats = db.get(
      `SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${baseWhere} AND DATE(created_at) >= ?`, [storeId, wStart]
    ) || {};
    const monthStats = db.get(
      `SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${baseWhere} AND DATE(created_at) >= ?`, [storeId, mStart]
    ) || {};

    // ── LINE 點餐 ─────────────────────────────────────────
    const lineStats = db.get(
      `SELECT COUNT(*) as orders, COALESCE(SUM(total),0) as revenue
       FROM orders WHERE ${todayWhere} AND source='line'`, todayParams
    ) || {};

    res.json({
      success: true,
      date: today,
      store_id: storeId,
      data: {
        // 今日總覽
        todayRevenue:    Number(todayStats.total_revenue   || 0),
        todayOrders:     Number(todayStats.total_orders    || 0),
        paidOrders:      Number(todayStats.paid_orders     || 0),
        unpaidOrders:    Number(todayStats.unpaid_orders   || 0),
        avgOrderValue:   Number(todayStats.avg_order_value || 0),
        // 週 / 月
        weekRevenue:     Number(weekStats.revenue  || 0),
        weekOrders:      Number(weekStats.orders   || 0),
        monthRevenue:    Number(monthStats.revenue || 0),
        monthOrders:     Number(monthStats.orders  || 0),
        // 分析
        paymentStats,
        sourceStats,
        topProducts,
        deliveryStats,
        hourlyStats,
        weekdayStats,
        lineStats: { orders: Number(lineStats.orders||0), revenue: Number(lineStats.revenue||0) },
      }
    });
  } catch(e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
