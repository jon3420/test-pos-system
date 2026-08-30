// utils/cartRecovery.js
// H1.4.10 Phase 4A — CART RECOVERY STATE ENGINE
//
// 職責：只做「未完成購物車／結帳／付款」的狀態機（job 建立、活動 refresh、
// 取消、converted、idempotency、current-recoverable 查詢）。
//
// 本 Phase 4A 明確不做的事（留待 Phase 4B 之後）：
//   - 不寄送任何 LINE Push／簡訊／Email
//   - 不接 n8n webhook
//   - 不做 recovery consent UI
//   - 不核發優惠券
//   - 不建立 Meta re-target audience
//
// 設計原則（需求文件九）：狀態機規則全部集中在這支檔案，不散落在
// routes/analytics.js／routes/line-orders.js／routes/linepay.js 各寫一份。
// 這些 route 檔案只需要「事件寫入成功後」呼叫這裡的 onAnalyticsEvent()。
//
// Fail-open（需求文件九）：任何 DB 例外只能安全 log warning，絕不能：
//   - 阻止 add_to_cart／checkout／submit order／payment confirm
//   - 讓呼叫端的既有流程 throw

'use strict';

const STAGES = ['cart_abandoned', 'checkout_abandoned', 'payment_abandoned'];
const ACTIVE_STATUSES = ['pending', 'waiting'];
const STATUS_WHITELIST = ['pending', 'waiting', 'processing', 'sent', 'converted', 'cancelled', 'failed', 'not_contactable', 'not_configured'];

const DEFAULTS = {
  cart_recovery_enabled: '0',
  cart_recovery_cart_delay_minutes: 60,
  cart_recovery_checkout_delay_minutes: 30,
  cart_recovery_payment_delay_minutes: 15,
  cart_recovery_max_attempts: 1,
};

// 需求文件十二：current recoverable 只看最近 24 小時內到期的 job；超過視為
// 歷史分析資料，不算「目前可追回」。
const CURRENT_RECOVERABLE_HORIZON_HOURS = 24;

function _safe(fn, fallback) {
  try { return fn(); } catch (e) {
    console.warn('[cartRecovery] fail-open:', e.message);
    return fallback;
  }
}

function _nowIso() {
  // 與 sqlite 內建 datetime('now') 相同格式（UTC，'YYYY-MM-DD HH:MM:SS'），確保
  // TEXT 欄位可以直接字串比較排序，不需要額外轉換。
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}
function _plusMinutesIso(mins) {
  return new Date(Date.now() + mins * 60000).toISOString().slice(0, 19).replace('T', ' ');
}

function _getSetting(db, storeId, key, fallback) {
  return _safe(() => {
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    if (!row || row.value === undefined || row.value === null || row.value === '') return fallback;
    return row.value;
  }, fallback);
}

function isRecoveryEnabled(db, storeId) {
  return _getSetting(db, storeId, 'cart_recovery_enabled', DEFAULTS.cart_recovery_enabled) === '1';
}

function getDelayMinutes(db, storeId, stage) {
  const keyMap = {
    cart_abandoned: ['cart_recovery_cart_delay_minutes', DEFAULTS.cart_recovery_cart_delay_minutes],
    checkout_abandoned: ['cart_recovery_checkout_delay_minutes', DEFAULTS.cart_recovery_checkout_delay_minutes],
    payment_abandoned: ['cart_recovery_payment_delay_minutes', DEFAULTS.cart_recovery_payment_delay_minutes],
  };
  const entry = keyMap[stage];
  if (!entry) return 60;
  const [key, fallback] = entry;
  const raw = _getSetting(db, storeId, key, String(fallback));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getMaxAttempts(db, storeId) {
  const raw = _getSetting(db, storeId, 'cart_recovery_max_attempts', String(DEFAULTS.cart_recovery_max_attempts));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : DEFAULTS.cart_recovery_max_attempts;
}

// 需求文件六：idempotency key。cart/checkout stage 用 cart_id；payment stage
// 有 order_id 時優先用 order_id（同一張 LINE Pay 訂單只能有一筆
// payment_abandoned），這是比 cart_id 更可靠的識別（購物車在送單後可能已被
// 清空，但 order 本身是穩定的）。
function _idempotencyKey(stage, { cartId, orderId }) {
  if (stage === 'payment_abandoned' && orderId) return `order:${orderId}:${stage}`;
  if (cartId) return `cart:${cartId}:${stage}`;
  return null; // 沒有 cart_id 也沒有 order_id：無法建立可靠 idempotency key，呼叫端應跳過
}

function _findActiveJob(db, storeId, stage, idempotencyKey) {
  if (!idempotencyKey) return null;
  return _safe(() => db.get(
    `SELECT * FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND idempotency_key=? AND status IN ('pending','waiting') LIMIT 1`,
    [storeId, stage, idempotencyKey]
  ), null);
}

// ══════════════════════════════════════════════════════════════════
// resolveAuthoritativeOrderForPaymentStart()：Recovery Engine 的
// order-resolution 安全邊界（本輪 Reality Audit 重大發現，見
// H1.4.10_PHASE4A_CART_RECOVERY_REALITY_AUDIT.md）。
//
// 絕對不接受任何 client 可控的 order_id。唯一可信路徑：
//   1. 用 store_id + cart_id 回查最近一筆 server-authoritative 的
//      submit_order 事件（analytics_events.order_id 是後端建立訂單時寫入
//      的 uuid，不是前端宣稱的值——見 routes/line-orders.js）。
//   2. 再用該 order_id 去 orders 表二次確認（store_id 相符、真的存在），
//      並取得 orders.total 作為唯一 authoritative 金額來源。
// 任一步驟找不到，一律回傳 null（安全跳過，不猜測、不建立 job），
// 由呼叫端（onAnalyticsEvent）決定不建立 payment_abandoned。
// ══════════════════════════════════════════════════════════════════
function resolveAuthoritativeOrderForPaymentStart(db, storeId, cartId) {
  return _safe(() => {
    if (!storeId || !cartId) return null;
    const submitOrderEvt = db.get(
      `SELECT order_id FROM analytics_events
       WHERE store_id=? AND cart_id=? AND event_name='submit_order' AND order_id IS NOT NULL AND order_id<>''
       ORDER BY id DESC LIMIT 1`,
      [storeId, cartId]
    );
    if (!submitOrderEvt || !submitOrderEvt.order_id) return null;
    const orderId = submitOrderEvt.order_id;
    // 二次確認：同一 store_id 底下真的存在這筆訂單（uuid 與 id 在
    // routes/line-orders.js 建立時是同一個值，兩者都查一次確保相容既有
    // orders 資料）。
    const orderRow = db.get(
      `SELECT id, uuid, total FROM orders WHERE store_id=? AND (uuid=? OR id=?) LIMIT 1`,
      [storeId, orderId, orderId]
    );
    if (!orderRow) return null; // 訂單不存在或不屬於這家店，安全跳過，不猜測
    const total = Number(orderRow.total);
    return { orderId, total: Number.isFinite(total) ? total : null };
  }, null);
}

// ══════════════════════════════════════════════════════════════════
// scheduleXxxRecovery()：建立或 refresh 一個 stage 的 job。
//
// 需求文件十六／十七／十八：同 cart/order 重複活動（例如 add_to_cart 按 5
// 次、checkout_submit_click 重複點）不得建立第二筆 job，只更新
// last_event/last_event_at/due_at（refresh，讓倒數重新從最新活動算起）。
// ══════════════════════════════════════════════════════════════════
function _scheduleStage(db, storeId, stage, ctx) {
  return _safe(() => {
    if (!isRecoveryEnabled(db, storeId)) return null; // 需求文件二十五
    const { cartId = '', visitorId = '', sessionId = '', orderId = '', lineUserId = '', triggerEvent, lastEvent, recoverableValue = null } = ctx;
    const idempotencyKey = _idempotencyKey(stage, { cartId, orderId });
    if (!idempotencyKey) return null; // 沒有可靠識別依據，安全跳過，不建立來路不明的 job

    const delayMinutes = getDelayMinutes(db, storeId, stage);
    const maxAttempts = getMaxAttempts(db, storeId);
    const now = _nowIso();
    const dueAt = _plusMinutesIso(delayMinutes);

    const existing = _findActiveJob(db, storeId, stage, idempotencyKey);
    if (existing) {
      // Refresh：只更新活動時間與 due_at，不建立第二筆（需求文件十六／十七／十八）。
      // order_id/line_user_id 若這次呼叫有提供更完整的資訊（例如訂單建立後才
      // 補上 order_id），additive 補上，不覆蓋既有非空值成空值。
      db.run(
        `UPDATE cart_recovery_jobs SET
           last_event=?, last_event_at=?, due_at=?, updated_at=?,
           order_id=CASE WHEN ?<>'' THEN ? ELSE order_id END,
           line_user_id=CASE WHEN ?<>'' THEN ? ELSE line_user_id END,
           recoverable_value=CASE WHEN ? IS NOT NULL THEN ? ELSE recoverable_value END
         WHERE id=?`,
        [lastEvent || triggerEvent, now, dueAt, now, orderId, orderId, lineUserId, lineUserId, recoverableValue, recoverableValue, existing.id]
      );
      _fireWakeUp(db, storeId, stage, dueAt);
      return { id: existing.id, created: false };
    }

    const insertResult = db.run(
      `INSERT INTO cart_recovery_jobs
        (store_id, cart_id, visitor_id, session_id, order_id, line_user_id, stage, status,
         trigger_event, last_event, recoverable_value, due_at, last_event_at,
         attempt_count, max_attempts, idempotency_key, created_at, updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [storeId, cartId, visitorId, sessionId, orderId, lineUserId, stage, 'pending',
        triggerEvent, lastEvent || triggerEvent, recoverableValue, dueAt, now,
        0, maxAttempts, idempotencyKey, now, now]
    );
    _fireWakeUp(db, storeId, stage, dueAt);
    return { id: insertResult && insertResult.lastInsertRowid, created: true };
  }, null);
}

// 需求文件七／十三：POS → n8n Wake-Up，fire-and-forget、完全 fail-open
// （不 await，不阻擋任何顧客流程），只在 job 第一次建立或 due_at 被刷新時
// 觸發。utils/cartRecoveryOrchestration.js 內部會自行判斷
// cart_recovery_n8n_enabled 是否開啟，這裡不重複判斷。
function _fireWakeUp(db, storeId, stage, dueAt) {
  try {
    const orchestration = require('./cartRecoveryOrchestration');
    orchestration.sendWakeUp(db, storeId, { stage, dueAt }).catch(() => {});
  } catch (e) { /* Orchestration 模組載入失敗也不能影響 Recovery 狀態機本身 */ }
}

function scheduleCartRecovery(db, storeId, ctx) { return _scheduleStage(db, storeId, 'cart_abandoned', ctx); }
function scheduleCheckoutRecovery(db, storeId, ctx) { return _scheduleStage(db, storeId, 'checkout_abandoned', ctx); }
function schedulePaymentRecovery(db, storeId, ctx) { return _scheduleStage(db, storeId, 'payment_abandoned', ctx); }

// 純活動 refresh（不建立新 job，也不需要 recovery_enabled 之外的額外檢查——
// 若沒有現有 active job 就直接安全略過，不會意外建立一筆）。用於
// checkout_submit_click／checkout_validation_failed 這類「diagnostic，只更新
// 既有 checkout job 的活動時間」情境（需求文件十七）。
function refreshStageActivity(db, storeId, stage, { cartId = '', orderId = '', lastEvent }) {
  return _safe(() => {
    const idempotencyKey = _idempotencyKey(stage, { cartId, orderId });
    const existing = _findActiveJob(db, storeId, stage, idempotencyKey);
    if (!existing) return null;
    const delayMinutes = getDelayMinutes(db, storeId, stage);
    const now = _nowIso();
    const dueAt = _plusMinutesIso(delayMinutes);
    db.run(`UPDATE cart_recovery_jobs SET last_event=?, last_event_at=?, due_at=?, updated_at=? WHERE id=?`,
      [lastEvent, now, dueAt, now, existing.id]);
    _fireWakeUp(db, storeId, stage, dueAt);
    return { id: existing.id, refreshed: true };
  }, null);
}

// ══════════════════════════════════════════════════════════════════
// cancelRecoveryJobs()：取消指定 stage 的 pending/waiting job（需求文件四）。
// ══════════════════════════════════════════════════════════════════
function cancelRecoveryJobs(db, storeId, { cartId = '', orderId = '' }, stages, reason) {
  return _safe(() => {
    if (!cartId && !orderId) return 0;
    const now = _nowIso();
    let total = 0;
    (stages || []).forEach((stage) => {
      const idempotencyKey = _idempotencyKey(stage, { cartId, orderId });
      if (!idempotencyKey) return;
      // 同時用 cart_id／order_id 兩種角度找，避免 payment stage 已經有
      // order_id 但呼叫端這次只帶了 cart_id 之類的邊界情況遺漏。
      const result = db.run(
        `UPDATE cart_recovery_jobs SET status='cancelled', cancel_reason=?, cancelled_at=?, updated_at=?
         WHERE store_id=? AND stage=? AND status IN ('pending','waiting') AND (idempotency_key=? OR (cart_id<>'' AND cart_id=?) OR (order_id<>'' AND order_id=?))`,
        [reason || '', now, now, storeId, stage, idempotencyKey, cartId, orderId]
      );
      total += (result && result.changes) || 0;
    });
    return total;
  }, 0);
}

// ══════════════════════════════════════════════════════════════════
// markRecoveryConverted()：payment_success／purchase 出現時，該 cart/order
// 底下「所有」stage 的 pending/waiting job 一律 converted（需求文件四）。
// ══════════════════════════════════════════════════════════════════
function markRecoveryConverted(db, storeId, { cartId = '', orderId = '' }, reason) {
  return _safe(() => {
    if (!cartId && !orderId) return 0;
    const now = _nowIso();
    const conditions = [];
    const params = [storeId];
    if (cartId) { conditions.push('cart_id=?'); params.push(cartId); }
    if (orderId) { conditions.push('order_id=?'); params.push(orderId); }
    // 需求文件九／十：'sent' 代表提醒已經送出，但顧客之後才成交——這正是
    // 「提醒後成交」的核心情境，必須也轉成 converted（否則這些 job 會卡在
    // sent 狀態，Reminder Conversion Rate／Recovered Revenue 永遠算不出來）。
    // 只有 pending/waiting/sent 是「正常送達流程中」的狀態才轉換；
    // failed／not_contactable／not_configured 保留原始 delivery outcome，
    // 不無腦覆寫（那些狀態本身就是有意義的診斷資訊）。
    const result = db.run(
      `UPDATE cart_recovery_jobs SET status='converted', converted_at=?, updated_at=?, cancel_reason=?
       WHERE store_id=? AND status IN ('pending','waiting','sent') AND (${conditions.join(' OR ')})`,
      [now, now, reason || '', ...params]
    );
    return (result && result.changes) || 0;
  }, 0);
}

// ══════════════════════════════════════════════════════════════════
// onAnalyticsEvent()：單一事件驅動入口，由 utils/analyticsLog.js 的
// insertEvent() 在寫入成功後呼叫（需求文件九）。呼叫端已保證這是「真的成功
// 寫入 analytics_events 的事件」，這裡只需要依 event_name 分派狀態轉移。
//
// 絕對 fail-open：外層已經 try/catch 包住這支函式的呼叫，這裡內部也全部走
// _safe()，任何錯誤都只 log，不 throw、不影響呼叫端。
// ══════════════════════════════════════════════════════════════════
function onAnalyticsEvent(db, fields) {
  _safe(() => {
    const storeId = fields.store_id;
    if (!storeId) return;
    const cartId = fields.cart_id || '';
    const orderId = fields.order_id || '';
    const visitorId = fields.visitor_id || '';
    const sessionId = fields.session_id || '';
    // 需求文件十一：可信 line_user_id 只能來自呼叫端已經驗證過的來源
    // （member_session／orders.line_user_id），這裡完全不解析 metadata 或其他
    // 前端可控欄位，只信任 insertEvent() 既有的 fields.line_user_id 參數
    // （該參數本身的信任邊界由呼叫端負責，Recovery Engine 不重新驗證，但也
    // 絕不接受任何客戶端能自由填寫的替代欄位）。
    const lineUserId = fields.line_user_id || '';
    const eventName = fields.event_name;

    switch (eventName) {
      case 'add_to_cart': {
        if (!cartId) return;
        scheduleCartRecovery(db, storeId, { cartId, visitorId, sessionId, lineUserId, triggerEvent: eventName, lastEvent: eventName });
        return;
      }
      case 'checkout_click': {
        cancelRecoveryJobs(db, storeId, { cartId }, ['cart_abandoned'], 'checkout_click');
        if (!cartId) return;
        scheduleCheckoutRecovery(db, storeId, { cartId, visitorId, sessionId, lineUserId, triggerEvent: eventName, lastEvent: eventName });
        return;
      }
      case 'checkout_submit_click':
      case 'checkout_validation_failed': {
        // 需求文件十七：只是 checkout activity refresh，不建立新 job。
        if (!cartId) return;
        refreshStageActivity(db, storeId, 'checkout_abandoned', { cartId, lastEvent: eventName });
        return;
      }
      case 'submit_order': {
        // 需求文件四／二十：submit_order 只取消 cart/checkout recovery，絕對
        // 不得全域封鎖 payment_abandoned——LINE Pay 是先建單才導轉付款，
        // payment_started 會在這之後才發生。
        cancelRecoveryJobs(db, storeId, { cartId }, ['cart_abandoned', 'checkout_abandoned'], 'submit_order');
        return;
      }
      case 'payment_started': {
        // 需求文件十八：只有「線上付款」（本專案目前只有 linepay 會經過第三方
        // 導轉確認流程）才建立 payment_abandoned；現金等其他方式選擇即完成，
        // 不存在「使用者去付款但沒回來」這種可追回情境。
        const paymentMethod = fields.metadata && fields.metadata.payment_method;
        if (paymentMethod !== 'linepay') return;

        // ══════════════════════════════════════════════════════════
        // 重大架構修正（本輪 Reality Audit 發現）：
        //
        // 前端 `_trackEvent('payment_started', ...)` 目前完全不附帶
        // order_id（見 public/line-order.html／line-shipping.html 呼叫點），
        // 這是既有、正確的 Analytics 語意（payment_started 是 cart-centric
        // client event，不需要、也不應該由 client 提供 order_id——client 端
        // 可以任意宣稱任何 order_id，若直接採信會讓 Recovery job 綁錯訂單、
        // 金額綁錯、甚至造成跨使用者的錯誤提醒，破壞 payment recovery 的
        // 安全邊界）。
        //
        // 真實 LINE Pay 順序（見 routes/line-orders.js）：submit_order 一定
        // 早於 payment_started 發生，且 submit_order 的 order_id 是
        // server-authoritative（來自後端建立訂單時的 uuid，不是前端宣稱的
        // 值）。因此這裡改用 store_id + cart_id 回查最近一筆 submit_order，
        // 解析出可信 order_id，再用該 order_id 查 orders 表取得
        // authoritative total——完全不信任 fields.order_id 這個 client 可控
        // 欄位（即使呼叫端夾帶也直接忽略，不 fallback）。
        // ══════════════════════════════════════════════════════════
        if (!cartId) return;
        const resolved = resolveAuthoritativeOrderForPaymentStart(db, storeId, cartId);
        if (!resolved) return; // 找不到對應的 server-authoritative 訂單，安全跳過，不猜測、不建立
        schedulePaymentRecovery(db, storeId, {
          cartId, orderId: resolved.orderId, visitorId, sessionId, lineUserId,
          triggerEvent: eventName, lastEvent: eventName, recoverableValue: resolved.total,
        });
        return;
      }
      case 'payment_success':
      case 'purchase': {
        // 需求文件四／十：只能由這裡（也就是只有真正寫入成功的
        // server-authoritative 事件）觸發 converted，client 偽造
        // payment_success 早在 routes/analytics.js 就被拒絕，根本不會走到
        // insertEvent()，因此也不會走到這裡。
        markRecoveryConverted(db, storeId, { cartId, orderId }, eventName);
        // 需求文件十二～十四：同一個 centralized conversion hook 順便讓已經
        // 發出去的 Recovery 連結失效，不在 routes/linepay.js／
        // routes/line-orders.js／routes/line-shipping.js 各寫一份 token
        // invalidation。fail-open：這裡失敗不影響上面的 job conversion，也
        // 不影響呼叫端的付款確認流程本身。
        try {
          const { invalidateRecoveryResumeTokens } = require('./lineCheckoutHandoff');
          invalidateRecoveryResumeTokens(db, storeId, { cartId, orderId });
        } catch (e) { console.warn('[cartRecovery] invalidateRecoveryResumeTokens failed:', e.message); }
        return;
      }
      default:
        return; // 其他事件與 Recovery 無關，直接忽略
    }
  }, undefined);
}

// ══════════════════════════════════════════════════════════════════
// getRecoverableJobs()：current recoverable 查詢（需求文件十二）。
// ══════════════════════════════════════════════════════════════════
function getRecoverableJobs(db, storeId, { stage = null } = {}) {
  return _safe(() => {
    const now = _nowIso();
    const horizonStart = new Date(Date.now() - CURRENT_RECOVERABLE_HORIZON_HOURS * 3600000).toISOString().slice(0, 19).replace('T', ' ');
    const params = [storeId, now, horizonStart];
    let sql = `SELECT * FROM cart_recovery_jobs
      WHERE store_id=? AND status IN ('pending','waiting')
        AND due_at<=? AND due_at>=?`;
    if (stage) { sql += ' AND stage=?'; params.push(stage); }
    sql += ' ORDER BY due_at ASC';
    return db.all(sql, params) || [];
  }, []);
}

module.exports = {
  STAGES, ACTIVE_STATUSES, STATUS_WHITELIST, DEFAULTS, CURRENT_RECOVERABLE_HORIZON_HOURS,
  isRecoveryEnabled, getDelayMinutes, getMaxAttempts,
  scheduleCartRecovery, scheduleCheckoutRecovery, schedulePaymentRecovery,
  refreshStageActivity, cancelRecoveryJobs, markRecoveryConverted,
  onAnalyticsEvent, getRecoverableJobs, resolveAuthoritativeOrderForPaymentStart,
  // 測試/內部使用
  _idempotencyKey, _findActiveJob, _nowIso, _plusMinutesIso,
};
