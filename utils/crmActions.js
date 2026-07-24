// utils/crmActions.js — fix18-10-hotfix31-R2「CRM Action 生命週期 × 執行引擎」
//
// 目的：把「動作要怎麼執行」的邏輯從 routes/crm.js 抽出來，讓 create／retry
// 共用同一套執行器，而不是在路由檔案裡各寫一次（避免 retry 跟 create 邏輯
// 分岔）。這裡不建立任何新的「來源真相」資料表——實際名單、優惠券、會員資料
// 全部即時查詢既有的 crm_segment_members／coupons／line_members，本模組只是
// 把「執行」與「稽核」的邏輯集中管理。
//
// 誠實原則（需求文件 F／G／H，最重要的一條）：
//   沒有真正落地的第三方管道（LINE Messaging API／Email／SMS／Webhook／
//   Meta CAPI／Google Ads Audience）之前，一律回報 not_configured，target
//   維持 pending，絕不假裝已送達。
//   目前只有兩種動作「本機就能真的完成」，不需要等待任何外部整合：
//     - coupon_grant：核發的本質是「記錄會員 ↔ 優惠券的關聯」，這件事本身
//       不需要外部管道就能真實完成（crm_action_targets 那筆 row 本身就是
//       這個關聯的正式紀錄）。真正把訊息「送到顧客手上」（LINE推播/簡訊/
//       email 通知）仍然需要對應管道，那是另一件事，本版誠實地不假裝完成。
//     - csv_export：匯出的本質是「產生資料」，不需要外部 API，本模組直接
//       產生真正的 CSV 內容回傳，不是假裝匯出成功。

'use strict';

// 需求文件 F：可擴充的 action_type 架構，不是只認識 LINE。
const ACTION_TYPES = new Set([
  'coupon_grant',
  'line_push',
  'email',
  'sms',
  'webhook',
  'meta_audience_export',
  'google_audience_export',
  'csv_export',
]);

// 目前「本機就能真的完成、不需要等待任何尚未串接的外部管道」的動作類型。
// 其餘全部一律回報 not_configured（見上方誠實原則）。
const CHANNEL_AVAILABLE = new Set(['coupon_grant', 'csv_export']);

const ACTION_STATUSES = new Set(['draft', 'pending', 'running', 'completed', 'partially_completed', 'failed', 'cancelled', 'not_configured']);
const TARGET_STATUSES = new Set(['pending', 'processing', 'completed', 'failed', 'skipped', 'cancelled']);

function nowStr() {
  return new Date().toLocaleString('sv', { timeZone: 'Asia/Taipei' }).replace('T', ' ');
}

function safeJsonParse(raw, fallback) {
  if (!raw) return fallback;
  try { const v = JSON.parse(raw); return (v && typeof v === 'object') ? v : fallback; } catch (e) { return fallback; }
}

/**
 * 驗證優惠券（需求文件 H）：必須屬於同一店家、必須啟用、必須在有效期間內。
 * 直接重用既有 coupons 表與既有驗證欄位語意（沿用 routes/coupons.js
 * validateCoupon() 的同一套規則：store_id 隔離、enabled、start_at/end_at），
 * 不另外發明一套優惠券驗證邏輯。
 */
function validateCouponForAction(db, storeId, couponCode) {
  const code = String(couponCode || '').trim().toUpperCase();
  if (!code) return { ok: false, message: '缺少優惠券代碼' };
  const coupon = db.get('SELECT * FROM coupons WHERE store_id=? AND code=?', [storeId, code]);
  if (!coupon) return { ok: false, message: `優惠券「${code}」不存在` };
  if (!Number(coupon.enabled)) return { ok: false, message: `優惠券「${code}」已停用` };
  const nowLocal = nowStr();
  if (coupon.start_at && coupon.start_at > nowLocal) return { ok: false, message: `優惠券「${code}」尚未開始使用` };
  if (coupon.end_at && coupon.end_at < nowLocal) return { ok: false, message: `優惠券「${code}」已過期` };
  return { ok: true, coupon, code };
}

/**
 * 執行（或續跑）一個 action：只處理 status IN ('pending','failed') 的 target，
 * 已經 completed／skipped／cancelled 的 target 完全不動——這同時滿足
 * 「重試不得重送已完成的對象」與「取消後不得繼續處理剩餘對象」兩個需求，
 * 因為 cancel 一律先把待處理 target 標成 cancelled，之後 retry 自然就不會
 * 再選到它們。
 */
function executeAction(db, storeId, actionId) {
  const action = db.get('SELECT * FROM crm_actions WHERE store_id=? AND id=?', [storeId, actionId]);
  if (!action) return null;
  if (action.status === 'cancelled') return { status: 'cancelled', skipped: true };

  const now = nowStr();
  const pendingTargets = db.all(
    `SELECT * FROM crm_action_targets WHERE store_id=? AND action_id=? AND status IN ('pending','failed')`,
    [storeId, actionId]
  );

  if (!CHANNEL_AVAILABLE.has(action.action_type)) {
    // 尚未串接任何管道——target 維持原狀（pending），不假裝處理過。
    db.run(
      `UPDATE crm_actions SET status='not_configured', started_at=CASE WHEN started_at='' THEN ? ELSE started_at END WHERE store_id=? AND id=?`,
      [now, storeId, actionId]
    );
    return { status: 'not_configured', processed: 0 };
  }

  const payload = safeJsonParse(action.payload_json, {});

  if (action.action_type === 'coupon_grant') {
    const check = validateCouponForAction(db, storeId, payload.coupon_code);
    if (!check.ok) {
      pendingTargets.forEach((t) => {
        db.run(`UPDATE crm_action_targets SET status='failed', error=?, error_code='coupon_invalid', updated_at=? WHERE store_id=? AND id=?`, [check.message, now, storeId, t.id]);
      });
      db.run(
        `UPDATE crm_actions SET status='failed', error_code='coupon_invalid', result_message=?, started_at=CASE WHEN started_at='' THEN ? ELSE started_at END, completed_at=? WHERE store_id=? AND id=?`,
        [check.message, now, now, storeId, actionId]
      );
      return { status: 'failed', message: check.message };
    }
    const dedupKey = `coupon_grant:${check.code}`;
    pendingTargets.forEach((t) => {
      // 需求文件 H：清楚定義匿名訪客是否符合資格——coupon_grant 需要一個
      // 之後真的能通知到的持久身份，匿名訪客沒有（只有一次性的 visitor_id），
      // 因此明確判定為不符資格，status='skipped'，不是失敗也不是完成。
      if (t.member_type !== 'line_user_id') {
        db.run(
          `UPDATE crm_action_targets SET status='skipped', error='匿名訪客沒有可通知的持久身份，coupon_grant 僅適用 LINE 會員', error_code='ineligible_anonymous', updated_at=? WHERE store_id=? AND id=?`,
          [now, storeId, t.id]
        );
        return;
      }
      // 需求文件 H：防止「同一位會員」被「不同的 action」重複核發「同一張優惠券」。
      const dup = db.get(
        `SELECT 1 as x FROM crm_action_targets
         WHERE store_id=? AND member_key=? AND dedup_key=? AND status='completed' AND action_id != ?
         LIMIT 1`,
        [storeId, t.member_key, dedupKey, actionId]
      );
      if (dup) {
        db.run(
          `UPDATE crm_action_targets SET status='skipped', error='此會員已由其他動作核發過同一張優惠券，避免重複核發', error_code='duplicate_grant', dedup_key=?, updated_at=? WHERE store_id=? AND id=?`,
          [dedupKey, now, storeId, t.id]
        );
        return;
      }
      // 真正的「association」：這筆 crm_action_targets row 本身就是核發紀錄。
      db.run(
        `UPDATE crm_action_targets SET status='completed', dedup_key=?, sent_at=?, updated_at=? WHERE store_id=? AND id=?`,
        [dedupKey, now, now, storeId, t.id]
      );
    });
  } else if (action.action_type === 'csv_export') {
    // 匯出本身不需要外部管道，直接標記完成（真的產生了資料，見 routes/crm.js
    // 組 CSV 內容回傳給呼叫端，本函式只負責狀態機）。
    pendingTargets.forEach((t) => {
      db.run(`UPDATE crm_action_targets SET status='completed', sent_at=?, updated_at=? WHERE store_id=? AND id=?`, [now, now, storeId, t.id]);
    });
  }

  const allTargets = db.all('SELECT status FROM crm_action_targets WHERE store_id=? AND action_id=?', [storeId, actionId]);
  const completed = allTargets.filter((t) => t.status === 'completed').length;
  const failed = allTargets.filter((t) => t.status === 'failed').length;
  const skipped = allTargets.filter((t) => t.status === 'skipped').length;
  const pending = allTargets.filter((t) => t.status === 'pending').length;

  let overallStatus;
  if (pending > 0) overallStatus = 'running'; // 本版同步執行，理論上不會停在這個狀態，保守保留
  else if (failed > 0 && completed > 0) overallStatus = 'partially_completed';
  else if (failed > 0 && completed === 0) overallStatus = 'failed';
  else overallStatus = 'completed'; // 只剩 completed/skipped，沒有 pending/failed

  db.run(
    `UPDATE crm_actions SET status=?, success_count=?, fail_count=?, skipped_count=?,
       started_at=CASE WHEN started_at='' THEN ? ELSE started_at END, completed_at=?
     WHERE store_id=? AND id=?`,
    [overallStatus, completed, failed, skipped, now, now, storeId, actionId]
  );

  return { status: overallStatus, success_count: completed, fail_count: failed, skipped_count: skipped };
}

/**
 * 取消動作：把「還沒處理」的 target 標成 cancelled，已經 completed／skipped
 * 的 target 維持不變（需求文件 G.4：取消不得影響已完成的部分）。已經是
 * 終態（completed／failed／cancelled）的 action 呼叫取消視為 no-op。
 */
function cancelAction(db, storeId, actionId) {
  const action = db.get('SELECT * FROM crm_actions WHERE store_id=? AND id=?', [storeId, actionId]);
  if (!action) return null;
  if (['completed', 'failed', 'cancelled'].includes(action.status)) {
    return { already_terminal: true, status: action.status };
  }
  const now = nowStr();
  db.run(
    `UPDATE crm_action_targets SET status='cancelled', updated_at=? WHERE store_id=? AND action_id=? AND status='pending'`,
    [now, storeId, actionId]
  );
  db.run(`UPDATE crm_actions SET status='cancelled', cancelled_at=? WHERE store_id=? AND id=?`, [now, storeId, actionId]);
  return { status: 'cancelled' };
}

module.exports = {
  ACTION_TYPES,
  ACTION_STATUSES,
  TARGET_STATUSES,
  CHANNEL_AVAILABLE,
  nowStr,
  safeJsonParse,
  validateCouponForAction,
  executeAction,
  cancelAction,
};
