// routes/cart-recovery-dashboard.js
// H1.4.10 Phase 4D — Recovery Analytics Dashboard（Reality Audit 摘要見文件）
//
// 只讀 API，requireStaffJwt（管理者專用），一律以 req.storeId 隔離查詢
// （沿用 routes/line-analytics.js 既有慣例）。
//
// Reality Audit 重要發現（本輪限縮範圍的原因）：
//   - cart_abandoned／checkout_abandoned 這兩個 stage 的 job，submit_order
//     發生時只會被 cancelRecoveryJobs() 取消，不會像 _scheduleStage() 的
//     refresh 路徑那樣回填 order_id——因為 submit_order 對這兩個 stage而言
//     從來不是「refresh」而是「cancel」。這代表這兩個 stage 的 job row
//     幾乎不會有 order_id，無法可靠 JOIN 回 orders 表算出「這筆提醒真的
//     追回多少營收」。
//   - payment_abandoned stage 不同：job 建立時（schedulePaymentRecovery）
//     一定帶著 order_id（來自 cart_recovery.js 的 payment_started 分支，
//     resolveAuthoritativeOrderForPaymentStart() 解析出的真實訂單），可以
//     可靠 JOIN orders 拿到 authoritative total。
//   - 因此本輪 Recovered Revenue 只對 payment_abandoned 計算，cart／
//     checkout stage 明確回傳 revenue:null（不用任何估算公式假造數字）。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireStaffJwt } = require('../middleware/storeGuard');

const STAGES = ['cart_abandoned', 'checkout_abandoned', 'payment_abandoned'];
const STATUSES = ['pending', 'waiting', 'sent', 'converted', 'cancelled', 'failed', 'not_contactable', 'not_configured'];

function parseDateRange(req) {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 30));
  const since = new Date(Date.now() - days * 86400000).toISOString().slice(0, 19).replace('T', ' ');
  return { days, since };
}

// ══════════════════════════════════════════════════════════════════
// GET /api/cart-recovery-dashboard/overview?days=30
// ══════════════════════════════════════════════════════════════════
router.get('/overview', requireStaffJwt, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { days, since } = parseDateRange(req);

    // ── Funnel：每個 stage × status 的真實筆數（不估算）──
    const funnel = {};
    STAGES.forEach((stage) => {
      funnel[stage] = {};
      STATUSES.forEach((status) => { funnel[stage][status] = 0; });
    });
    const rows = db.all(
      `SELECT stage, status, COUNT(*) c FROM cart_recovery_jobs
       WHERE store_id=? AND created_at>=? GROUP BY stage, status`,
      [storeId, since]
    ) || [];
    rows.forEach((r) => {
      if (funnel[r.stage] && r.status in funnel[r.stage]) funnel[r.stage][r.status] = r.c;
    });

    // ── Reminder Sent / Reminder → Converted（狀態導向，不是估算）──
    // 「真的送出過提醒（channel='line'）且後來 converted」與「總共送出過幾次
    // 提醒（不論結果）」分開算，避免把「本來就會買」跟「提醒後才買」混為一談
    // ——這裡誠實只能說「converted 的 job 之前有沒有被標記過 sent」，不能
    // 宣稱因果關係。
    const reminderStats = {};
    STAGES.forEach((stage) => {
      const sentEverRow = db.get(
        `SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND created_at>=? AND channel='line' AND (status='sent' OR sent_at<>'')`,
        [storeId, stage, since]
      );
      const sentThenConvertedRow = db.get(
        `SELECT COUNT(*) c FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND created_at>=? AND channel='line' AND sent_at<>'' AND status='converted'`,
        [storeId, stage, since]
      );
      reminderStats[stage] = {
        reminder_sent: sentEverRow ? sentEverRow.c : 0,
        reminder_then_converted: sentThenConvertedRow ? sentThenConvertedRow.c : 0,
      };

      // ── Drop-off / Conversion Rate（只對已經有「最終結果」的 job 計算，
      // pending/waiting/sent 還在進行中，不該被當成分母的一部分，否則
      // rate 會被還沒跑完的 job 稀釋、造成誤導）──
      const resolvedRow = db.get(
        `SELECT
           SUM(CASE WHEN status='converted' THEN 1 ELSE 0 END) converted,
           SUM(CASE WHEN status IN ('converted','cancelled','failed','not_contactable','not_configured') THEN 1 ELSE 0 END) resolved
         FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND created_at>=?`,
        [storeId, stage, since]
      );
      const resolvedCount = resolvedRow ? resolvedRow.resolved : 0;
      const convertedCount = resolvedRow ? resolvedRow.converted : 0;
      reminderStats[stage].conversion_rate_of_resolved = resolvedCount > 0 ? Math.round((convertedCount / resolvedCount) * 10000) / 100 : null;
      reminderStats[stage].resolved_count = resolvedCount;
      reminderStats[stage].converted_count = convertedCount;

      // ── Time to Recovery（只對真的「送過提醒且之後轉換」的 job 計算，用
      // SQLite julianday() 算 sent_at→converted_at 的分鐘數，不用猜的）。
      // 額外要求 converted_at>=sent_at——理論上不該有「轉換時間早於送出時間」
      // 這種資料（時鐘漂移／手動改資料／未來 bug 都可能產生），一旦出現絕不
      // 能讓負數時長悄悄拉低平均值，必須整筆排除在樣本外。──
      const ttrRow = db.get(
        `SELECT AVG((julianday(converted_at) - julianday(sent_at)) * 24 * 60) avg_minutes, COUNT(*) sample_size
         FROM cart_recovery_jobs
         WHERE store_id=? AND stage=? AND created_at>=?
           AND channel='line'
           AND sent_at IS NOT NULL AND sent_at<>''
           AND status='converted'
           AND converted_at IS NOT NULL AND converted_at<>''
           AND converted_at>=sent_at`,
        [storeId, stage, since]
      );
      reminderStats[stage].avg_minutes_to_recovery = (ttrRow && ttrRow.sample_size > 0 && ttrRow.avg_minutes !== null) ? Math.round(ttrRow.avg_minutes * 10) / 10 : null;
      reminderStats[stage].time_to_recovery_sample_size = ttrRow ? ttrRow.sample_size : 0;
    });

    // ── Recovered Revenue（見檔頭 Reality Audit：只有 payment_abandoned
    // 可靠 JOIN orders，其餘 stage 明確回傳 null，不假造估算值）。
    //
    // Order-based dedup：同一張訂單可能對應到不只一筆 cart_recovery_jobs。
    // 若直接「job JOIN orders 再 SUM」，同一 order_id 出現在兩筆 job row 時
    // o.total 會被重複加總、虛報營收。正確做法是先在子查詢把 job 依
    // order_id 去重（DB-side DISTINCT），再 JOIN orders 一次，COUNT/SUM
    // 都是對「不重複的訂單」做，不是對「job row」做。
    //
    // 上一輪一度懷疑這個 SQL 寫法在長時間、大量交錯查詢的測試環境下有
    // sql.js/WASM 層的不穩定聚合結果，因此改成 JS 端 Set 去重再逐筆查
    // orders。後續定位到當時真正的失敗原因其實是測試本身的 JWT store_id
    // 與預期不符（requireStaffJwt 用 JWT payload.store_id 覆蓋了測試原本
    // 想用 stub 設定的 req.storeId），與這支 SQL 完全無關——用獨立、乾淨的
    // debug script 直接驗證過這支 SQL 本身在「兩張不同訂單、金額相同」的
    // 情境下能正確得到 order_count=2／revenue=1776。既然已排除 SQL 本身有
    // 問題，就不需要為了一個不存在的疑慮，把 production 改成更複雜、要多
    // 打 N+1 次查詢的 JS-side 版本，改回這一份 DB-side 寫法。刻意不用
    // SUM(DISTINCT o.total)（那個寫法在兩張不同訂單剛好同金額時會把其中
    // 一張憑空丟掉，是更隱蔽的錯誤，不是真正的去重）。
    const paymentRevenueRow = db.get(
      `SELECT COALESCE(SUM(o.total), 0) revenue, COUNT(*) order_count
       FROM (
         SELECT DISTINCT j.order_id AS order_id
         FROM cart_recovery_jobs j
         WHERE j.store_id=? AND j.stage='payment_abandoned' AND j.created_at>=?
           AND j.channel='line' AND j.sent_at<>'' AND j.status='converted' AND j.order_id<>''
       ) recovered_orders
       JOIN orders o ON o.store_id=? AND (o.uuid = recovered_orders.order_id OR o.id = recovered_orders.order_id)`,
      [storeId, since, storeId]
    );
    const paymentRevenueTotal = paymentRevenueRow ? Number(paymentRevenueRow.revenue) : 0;
    const paymentOrderCount = paymentRevenueRow ? paymentRevenueRow.order_count : 0;

    return res.json({
      success: true,
      data: {
        range_days: days,
        funnel,
        reminder_stats: reminderStats,
        recovered_revenue: {
          payment_abandoned: {
            total: paymentRevenueTotal,
            order_count: paymentOrderCount,
          },
          cart_abandoned: { total: null, order_count: null, reason: 'no_reliable_order_linkage' },
          checkout_abandoned: { total: null, order_count: null, reason: 'no_reliable_order_linkage' },
        },
      },
    });
  } catch (e) {
    console.error('[cart-recovery-dashboard] GET /overview error:', e.message);
    res.status(500).json({ success: false, message: 'overview_failed' });
  }
});

module.exports = router;
