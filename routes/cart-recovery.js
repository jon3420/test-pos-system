// routes/cart-recovery.js
// H1.4.10 Phase 4B — Cart Recovery Consent API
//
// 唯一端點：POST /api/cart-recovery/consent
//
// 安全邊界（見 Reality Audit）：這支路由完全不接受、也不信任 client 提供的
// line_user_id。唯一可信身分來源是 member_session（透過既有
// verifyMemberSession() 驗證），與 routes/line-member.js 的
// /link-context、routes/analytics.js 的 client event 身分解析邏輯完全一致。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { verifyMemberSession } = require('../utils/lineMemberSession');
const { grantConsent, revokeConsent } = require('../utils/cartRecoveryConsent');
const { restoreRecoveryToken, consumeRecoveryToken, claimPaymentResumeTokenForRequest, markPaymentResumeRequested, releasePaymentResumeClaim, resetPaymentResumeForRetry } = require('../utils/lineCheckoutHandoff');
const { requestLinePayPayment } = require('../utils/linePayService');

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/consent
//
// Request body 只允許：member_session, cart_id, visitor_id, session_id,
// consent（true/false）。即使夾帶 line_user_id 也完全忽略（需求文件六）。
// ══════════════════════════════════════════════════════════════════
router.post('/consent', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { member_session, cart_id, visitor_id, session_id, consent } = req.body || {};

    if (!cart_id || typeof cart_id !== 'string' || !cart_id.trim()) {
      return res.status(200).json({ success: false, reason: 'missing_cart_id' });
    }
    if (typeof consent !== 'boolean') {
      return res.status(200).json({ success: false, reason: 'missing_consent_value' });
    }

    // 需求文件九：沒有可信 member_session 時，不能建立 consent=granted，但
    // 也絕不能因此擋住點餐/結帳/下單——這支 API 本來就是選用的加值功能，
    // 失敗時前端只是不提供可用的 checkbox，不影響其他任何流程。
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }

    if (consent === true) {
      const result = grantConsent(db, storeId, {
        cartId: cart_id.trim(),
        visitorId: typeof visitor_id === 'string' ? visitor_id.slice(0, 200) : '',
        sessionId: typeof session_id === 'string' ? session_id.slice(0, 200) : '',
        lineUserId,
        source: 'checkbox',
      });
      return res.json({ success: !!result.success, status: 'granted' });
    }

    const result = revokeConsent(db, storeId, { cartId: cart_id.trim() });
    return res.json({ success: !!result.success, status: 'revoked' });
  } catch (e) {
    console.error('[cart-recovery] POST /consent error:', e.message);
    // 不得讓例外破壞下單流程（與 routes/line-member.js /link-context 一致的原則）
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/restore
//
// 需求文件九～十二：Recovery Push 內的安全連結 restore API。只接受
// member_session + recovery_token，絕不接受、也絕不信任 client 提供的
// line_user_id／cart_id／order_id。
//
// cart_abandoned／checkout_abandoned：回還原後的購物車內容（product_id+qty
// 重新計價，不信任 token 快照裡的金額——與既有 restoreCartToken() 同一原則）。
// 不自動觸發 checkout_click／submit_order／purchase 之類 canonical 事件，
// 純粹是 UI 還原。
//
// payment_abandoned：這個 token 綁定的是既有訂單，不是購物車，這裡只回
// 「這筆訂單存在、尚未付款」的最小必要資訊，實際建立 LINE Pay 付款請求
// 由 /resume-payment 負責（見下方，目前為已知限制，見 Implementation Report）。
// ══════════════════════════════════════════════════════════════════
router.post('/restore', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { member_session, recovery_token, page_type } = req.body || {};

    if (!recovery_token || typeof recovery_token !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_token' });
    }
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }

    // page_type 不是身分依據，只是「目前實際在哪一頁」的宣告，用來讓
    // restoreRecoveryToken() 拒絕跨頁誤用（需求文件五：shipping token 不能
    // 在 line-order 頁 restore，反之亦然）。
    const result = restoreRecoveryToken(db, storeId, recovery_token, lineUserId, page_type);
    if (!result.ok) {
      // 需求文件十：not_found/expired/wrong_store(隱含於查詢條件)/uid_mismatch/
      // consumed/cancelled/wrong_page 全部安全拒絕，不回傳 token row 原始內容。
      return res.status(200).json({ success: false, reason: result.reason });
    }

    // 需求文件二／三：defense-in-depth——token status 理論上已經被
    // centralized conversion hook（utils/cartRecovery.js onAnalyticsEvent 的
    // purchase/payment_success 分支）同步 invalidate，但不假設它一定同步。
    // 額外直接查對應 cart_recovery_jobs 的最新狀態：正常 Recovery URL 是
    // LINE Push 成功「之後」才交給顧客的，所以合法值只有 sent；
    // converted/cancelled 一律安全拒絕，不回傳內部 job 細節。
    const stageByResumeType = { cart: 'cart_abandoned', checkout: 'checkout_abandoned', payment: 'payment_abandoned' };
    const stage = stageByResumeType[result.resumeType];
    if (stage) {
      const jobQuery = result.resumeType === 'payment'
        ? db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND order_id<>'' AND order_id IS NOT NULL ORDER BY id DESC LIMIT 1`, [storeId, stage])
        : db.get(`SELECT status FROM cart_recovery_jobs WHERE store_id=? AND stage=? AND cart_id=? ORDER BY id DESC LIMIT 1`, [storeId, stage, result.cartId]);
      // 找不到對應 job 時不阻擋（可能是較舊資料或測試情境），但只要找到了且
      // 狀態不是 sent，就一律安全拒絕。
      if (jobQuery && jobQuery.status !== 'sent') {
        return res.status(200).json({ success: false, reason: 'already_completed' });
      }
    }

    if (result.resumeType === 'payment') {
      // 需求文件十五：只回「這是一筆可繼續付款的 Recovery」，order_id 完全
      // 不回前端（前端不需要，也不該知道）。
      return res.json({ success: true, resume_type: 'payment' });
    }

    return res.json({
      success: true,
      resume_type: result.resumeType,
      cart_id: result.cartId,
      cart: result.cart,
      has_unavailable_items: result.has_unavailable_items,
    });
  } catch (e) {
    console.error('[cart-recovery] POST /restore error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/resume-payment
//
// 需求文件九～十七：payment_abandoned 的 Existing Order Resume。絕不建立
// 第二張訂單，絕不信任 client 傳入的 order_id／total／items／customer 資料。
// client 只傳 member_session + recovery_token。
// ══════════════════════════════════════════════════════════════════
router.post('/resume-payment', async (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { member_session, recovery_token } = req.body || {};

    if (!recovery_token || typeof recovery_token !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_token' });
    }
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }

    const tokenResult = restoreRecoveryToken(db, storeId, recovery_token, lineUserId);
    if (!tokenResult.ok) {
      return res.status(200).json({ success: false, reason: tokenResult.reason });
    }
    if (tokenResult.resumeType !== 'payment' || !tokenResult.orderId) {
      return res.status(200).json({ success: false, reason: 'invalid_purpose' });
    }

    // 需求文件十二：只信任 token 綁定的 order_id（server-side row），不接受
    // 任何 client body 欄位；order 必須 store_id 相符才能查到。
    const order = db.get('SELECT * FROM orders WHERE store_id=? AND (uuid=? OR id=?)', [storeId, tokenResult.orderId, tokenResult.orderId]);
    if (!order) {
      return res.status(200).json({ success: false, reason: 'order_not_found' });
    }

    // 需求文件十四：已付款／已成交一律拒絕，不得再建立付款請求。
    if (order.payment_status === 'paid') {
      return res.status(200).json({ success: false, reason: 'already_paid' });
    }
    const alreadyConverted = db.get(
      `SELECT id FROM analytics_events WHERE store_id=? AND order_id=? AND event_name IN ('payment_success','purchase') LIMIT 1`,
      [storeId, order.uuid]
    );
    if (alreadyConverted) {
      return res.status(200).json({ success: false, reason: 'already_converted' });
    }

    // 需求文件二十三／二十六：Atomic Claim——真正呼叫 LINE Pay API 前先搶佔
    // token，避免同一個 recovery_token 被快速點兩次（或兩個分頁同時送出）
    // 各自建立一次 LINE Pay Request。搶不到的 request 直接安全拒絕，不依賴
    // 前端 disabled button 當唯一防線。
    const claimed = claimPaymentResumeTokenForRequest(db, storeId, recovery_token);
    if (!claimed) {
      return res.status(200).json({ success: false, reason: 'payment_request_in_progress' });
    }

    const host = `${req.protocol}://${req.get('host')}`;
    const redirectUrl = `${host}/api/linepay/confirm?store_id=${encodeURIComponent(storeId)}`;
    // 需求文件九：取消付款導回時應該回到「同一則 Recovery 提醒」，而不是隨便
    // 一個固定頁面——這樣使用者取消後還能看到「繼續 LINE Pay 付款」按鈕再試
    // 一次。用 tokenResult.pageType（來自 token DB row，非 client）組回正確
    // LIFF Recovery URL；沒有 LIFF ID 時才 fallback 一般網址（與
    // utils/cartRecoveryDelivery.js buildRecoveryUrl() 同一套 LIFF-first 原則，
    // 但這裡允許 fallback，因為使用者已經在付款流程中，不是全新的 Push 通路）。
    const { buildRecoveryUrl } = require('../utils/cartRecoveryDelivery');
    const urlResult = buildRecoveryUrl(db, storeId, { token: recovery_token, pageType: tokenResult.pageType });
    const cancelUrl = urlResult.ok
      ? `${urlResult.url}&linepay=cancel`
      : `${host}/${tokenResult.pageType === 'line_shipping' ? 'line-shipping.html' : 'line-order.html'}?store_id=${encodeURIComponent(storeId)}&recovery_token=${encodeURIComponent(recovery_token)}&linepay=cancel`;

    // 需求文件十三：金流請求一律用 DB order 建構（見 utils/linePayService.js
    // requestLinePayPayment()，完全不接受 client amount/items），不得建立
    // 第二張訂單——這裡只對「既有 order」發起付款請求，不呼叫任何建立訂單
    // 的 API。
    const payResult = await requestLinePayPayment({ db, storeId, order, redirectUrl, cancelUrl });
    if (!payResult.success) {
      // 需求文件二十八：LINE API 失敗，安全退回可重試狀態，不永久鎖死。
      releasePaymentResumeClaim(db, storeId, recovery_token);
      return res.status(200).json({ success: false, reason: payResult.reason || 'line_api_error' });
    }

    // 需求文件二十七：成功後標記 payment_requested，不 consume——顧客在
    // LINE Pay 頁面取消後，仍可從同一則提醒訊息再次嘗試（Phase 4A payment
    // job idempotency 已保證不會產生第二筆 job；LINE Pay 官方那邊重複
    // request 本身也是合法操作，同一張未付款訂單可以再次建立付款請求）。
    markPaymentResumeRequested(db, storeId, recovery_token);

    // 需求文件十六～二十：Recovery payment_started 改為 backend authority。
    // Recovery Payment 頁本來就不 restore cart，前端可能完全沒有原 cart_id、
    // 或帶著錯誤/不相關的 cart_id——backend 這裡的 token row 才是可靠來源
    // （tokenResult.cartId = token.recovery_cart_id，orderId = token 綁定的
    // 真實訂單）。只在 LINE Pay Request 真正成功後才寫，且完全不使用任何
    // client 提供的 cart_id/order_id/amount，metadata 只有 payment_method，
    // 沿用 Phase 4A 既有 payment_started 語意與 sanitizer 白名單。
    try {
      const { logServerEvent, getOrderTrackingContext } = require('../utils/analyticsLog');
      const ctx = getOrderTrackingContext(db, storeId, order.uuid) || {};
      logServerEvent(db, {
        store_id: storeId,
        visitor_id: ctx.visitor_id || `recovery_${tokenResult.cartId}`,
        session_id: ctx.session_id || `recovery_${tokenResult.cartId}`,
        cart_id: tokenResult.cartId,
        order_id: order.uuid,
        event_name: 'payment_started',
        order_mode: ctx.order_mode || order.order_mode || null,
        metadata: { payment_method: 'linepay' },
      });
    } catch (e) { console.warn('[cart-recovery] payment_started logging failed:', e.message); }

    return res.json({ success: true, payment_url: payResult.payment_url });
  } catch (e) {
    console.error('[cart-recovery] POST /resume-payment error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /api/cart-recovery/payment-cancelled
//
// 需求文件八：獨立、明確的「付款取消後允許再試一次」動作。絕不靠放寬
// claim 條件解決重試問題（那正是本輪抓到的 duplicate request 根源）。
// 只允許 payment_requested → opened 這一種轉移，且要求呼叫端提供的
// member_session 能解析出與 token 綁定相符的 line_user_id，並重新確認
// order 尚未 paid、尚無 payment_success/purchase。
//
// 絕不：把 order 標 failed、把 payment job cancelled、寫 payment_success、
// 寫 purchase——這裡只負責「允許重新建立付款請求」這一件事。
// ══════════════════════════════════════════════════════════════════
router.post('/payment-cancelled', (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const { member_session, recovery_token } = req.body || {};

    if (!recovery_token || typeof recovery_token !== 'string') {
      return res.status(200).json({ success: false, reason: 'missing_token' });
    }
    if (!member_session || typeof member_session !== 'string') {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }
    const lineUserId = verifyMemberSession(member_session, storeId);
    if (!lineUserId) {
      return res.status(200).json({ success: false, reason: 'member_not_identified' });
    }

    // 需求文件八：重新確認 order 狀態，任一條件不符一律拒絕 reset。
    const tokenRow = db.get(
      `SELECT * FROM line_cart_handoff_tokens WHERE store_id=? AND token=? AND purpose='recovery_resume' AND resume_type='payment'`,
      [storeId, recovery_token]
    );
    if (!tokenRow) {
      return res.status(200).json({ success: false, reason: 'not_found' });
    }
    if (tokenRow.order_id) {
      const order = db.get('SELECT * FROM orders WHERE store_id=? AND (uuid=? OR id=?)', [storeId, tokenRow.order_id, tokenRow.order_id]);
      if (order && order.payment_status === 'paid') {
        return res.status(200).json({ success: false, reason: 'already_paid' });
      }
      const alreadyConverted = db.get(
        `SELECT id FROM analytics_events WHERE store_id=? AND order_id=? AND event_name IN ('payment_success','purchase') LIMIT 1`,
        [storeId, tokenRow.order_id]
      );
      if (alreadyConverted) {
        return res.status(200).json({ success: false, reason: 'already_converted' });
      }
    }

    const result = resetPaymentResumeForRetry(db, storeId, recovery_token, lineUserId);
    if (!result.ok) {
      return res.status(200).json({ success: false, reason: result.reason });
    }
    return res.json({ success: true });
  } catch (e) {
    console.error('[cart-recovery] POST /payment-cancelled error:', e.message);
    res.status(200).json({ success: false, reason: 'exception' });
  }
});

module.exports = router;
