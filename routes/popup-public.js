// routes/popup-public.js — H1.4.12 Phase 3A.1
//
// 🚐 快閃取餐 — 公開查詢 + 結帳權威驗證（獨立掛載，不依賴 requireStore）。
//
// Corrective Audit 修正核心：session/campaign 的 public_code 是全域唯一值
// （popup_sessions.public_code / popup_campaigns.public_code 各自有
// UNIQUE INDEX），因此「這個 code 屬於哪個 store」必須由 code 本身反查
// 出來，不能信任 query/body/header 傳入的 store_id——即使剛好傳對了也不
// 代表可以被信任，惡意呼叫端可以夾帶任意 store_id。
//
// 唯一的例外是「永久店家入口」（GET /popup-entry）：這個端點本身沒有任何
// code 可以反查，本來就需要顧客端明確帶著 store_id（例如店家自己的 LIFF
// 選單／固定連結），因此明確要求 query.store_id，屬性上等同於既有
// GET /shop 這種「公開瀏覽單一店家」端點，不是「用 code 定位店家」的情境。
'use strict';

const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');

const { getDb } = require('../utils/db');
const { normalizeTaiwanMobile } = require('../public/js/phone-utils');
const { verifyMemberSession } = require('../utils/lineMemberSession');
const pp = require('../utils/popupPickup');
const popupCheckout = require('../utils/popupCheckout');

const ppay = require('../utils/popupPayment');
const { isDurableError } = require('../utils/db');
function sendPopupError(res, err) {
  if (err instanceof ppay.PopupPaymentError) {
    return res.status(err.status).json({ success: false, error: err.code, message: err.message });
  }
  if (err instanceof pp.PopupValidationError) {
    return res.status(err.status).json({ success: false, error: err.code, message: err.message, ...(err.extra || {}) });
  }
  console.error('[popup-public] internal error:', err && err.stack ? err.stack : err);
  if (isDurableError(err)) return res.status(503).json({ success: false, error: 'STORAGE_UNAVAILABLE', message: '系統忙碌中，請稍後再試' }); // R44.2F
  return res.status(500).json({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '系統發生錯誤，請稍後再試' });
}

function buildDisplayOrder(rows) {
  const { compareSessionsForDisplay } = require('../utils/popupRegion');
  const m = new Map();
  rows.slice().sort(compareSessionsForDisplay).forEach((r, i) => m.set(r.id, i + 1));
  return m;
}

function resolveStoreIdByPublicCode(db, table, publicCode) {
  if (typeof publicCode !== 'string' || !publicCode) return null;
  const row = db.get(`SELECT store_id FROM ${table} WHERE public_code=?`, [publicCode]);
  return row ? row.store_id : null;
}

// Phase 3A.3 修正：公開 GET 端點一律用 fetchFreshStoreAuthority()（直接查
// stores/licenses，不經過 middleware/featureGate.js 的 30 秒
// featureCache）——避免「授權剛被停用，但快取還沒過期」的縫隙讓已停權
// 店家的快閃活動/場次資料仍被公開查得到。跟結帳 transaction 內用的是
// 同一個函式，不是另外發明一套判斷。
function assertStoreOrderable(db, storeId, notFoundCode, notFoundMessage) {
  const authority = popupCheckout.fetchFreshStoreAuthority(db, storeId);
  if (!authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled) {
    pp.fail(notFoundCode, notFoundMessage, 404);
  }
}

router.get('/popup-entry', (req, res) => {
  try {
    const db = getDb();
    const storeId = String(req.query.store_id || '').trim();
    if (!storeId) {
      return res.status(400).json({ success: false, error: 'POPUP_VALIDATION_ERROR', message: '缺少 store_id' });
    }
    // Phase 3A.3 修正：同樣改用 fetchFreshStoreAuthority()（不經過 30 秒
    // featureCache），避免授權剛被停用時，這個列表端點因為快取還沒過期
    // 而繼續回傳已停權店家的快閃活動/場次。
    const authority = popupCheckout.fetchFreshStoreAuthority(db, storeId);
    if (!authority.storeActive || !authority.licenseActive || !authority.lineOrderEnabled || !pp.isPopupPickupEnabled(db, storeId)) {
      return res.json({ success: true, data: { enabled: false, campaigns: [] } });
    }
    const now = Date.now();
    const ORDERABLE_LIST_STATES = new Set(['scheduled', 'ordering_open', 'ordering_closed', 'pickup_active']);
    const campaigns = db.all(
      "SELECT * FROM popup_campaigns WHERE store_id=? AND status='published' ORDER BY sort_order ASC, created_at DESC",
      [storeId]
    );
    const rowsByCampaign = campaigns.map((c) => db.all(
      "SELECT * FROM popup_sessions WHERE store_id=? AND campaign_id=? AND status='published' ORDER BY pickup_date ASC, sort_order ASC",
      [storeId, c.id]
    ));
    // R51：全店穩定顯示順序（取餐開始時間由近到遠，相同時間用既有 id），前端地區
    // 分組後只依 display_order 排序；不輸出 id。
    const displayOrder = buildDisplayOrder([].concat(...rowsByCampaign));
    const data = campaigns.map((c, ci) => {
      const sessions = rowsByCampaign[ci]
        .map((s) => ({ ...popupCheckout.serializePublicSession(db, storeId, s, c.status, now), display_order: displayOrder.get(s.id) }))
        .filter((s) => ORDERABLE_LIST_STATES.has(s.effective_state));
      return { ...popupCheckout.serializePublicCampaign(c), sessions };
    }).filter((c) => c.sessions.length > 0);
    res.json({ success: true, data: { enabled: true, campaigns: data } });
  } catch (e) { sendPopupError(res, e); }
});

router.get('/popup-campaign/:publicCode', (req, res) => {
  try {
    const db = getDb();
    const code = req.params.publicCode;
    const storeId = resolveStoreIdByPublicCode(db, 'popup_campaigns', code);
    if (!storeId) return res.status(404).json({ success: false, error: 'POPUP_CAMPAIGN_NOT_FOUND', message: '找不到此快閃活動' });
    assertStoreOrderable(db, storeId, 'POPUP_CAMPAIGN_NOT_FOUND', '找不到此快閃活動');
    if (!pp.isPopupPickupEnabled(db, storeId)) {
      // Phase 3A.2 修正：故意跟「找不到此快閃活動」完全同一組 code/message，
      // 讓「活動存在但功能被關閉」與「活動根本不存在」在這一層無法被
      // response payload 區分出來。
      return res.status(404).json({ success: false, error: 'POPUP_CAMPAIGN_NOT_FOUND', message: '找不到此快閃活動' });
    }
    const campaign = popupCheckout.findPublicCampaignByCode(db, storeId, code);
    if (!campaign || campaign.status === 'draft') {
      return res.status(404).json({ success: false, error: 'POPUP_CAMPAIGN_NOT_FOUND', message: '找不到此快閃活動' });
    }
    const now = Date.now();
    const rows = db.all(
      'SELECT * FROM popup_sessions WHERE store_id=? AND campaign_id=? ORDER BY pickup_date ASC, sort_order ASC',
      [storeId, campaign.id]
    ).filter((s) => s.status !== 'draft');
    const displayOrder = buildDisplayOrder(rows); // R51
    const sessions = rows
      .map((s) => ({ ...popupCheckout.serializePublicSession(db, storeId, s, campaign.status, now), display_order: displayOrder.get(s.id) }));
    res.json({ success: true, data: { ...popupCheckout.serializePublicCampaign(campaign), sessions } });
  } catch (e) { sendPopupError(res, e); }
});

router.get('/popup-session/:publicCode', (req, res) => {
  try {
    const db = getDb();
    const code = req.params.publicCode;
    const storeId = resolveStoreIdByPublicCode(db, 'popup_sessions', code);
    if (!storeId) return res.status(404).json({ success: false, error: 'POPUP_SESSION_NOT_FOUND', message: '找不到此快閃場次' });
    assertStoreOrderable(db, storeId, 'POPUP_SESSION_NOT_FOUND', '找不到此快閃場次');
    if (!pp.isPopupPickupEnabled(db, storeId)) {
      // 同上：與「找不到此快閃場次」完全同一組 code/message，不可區分。
      return res.status(404).json({ success: false, error: 'POPUP_SESSION_NOT_FOUND', message: '找不到此快閃場次' });
    }
    if (ppay.isPopupPaymentConfigured(db, storeId)) ppay.reconcileExpiredPopupPayments(db, storeId); // R50 lazy reconcile（逾時付款釋放名額）
    const found = popupCheckout.findPublicSessionByCode(db, storeId, code);
    // Phase 3A.2 修正：session 自己不是 draft 還不夠——parent campaign 若是
    // draft，同樣視為「找不到」（不洩漏「session 存在，只是它的活動還沒
    // 發布」）。之前只檢查 session.status，漏了 campaign.status，會讓一個
    // published 的 session 掛在 draft 的 campaign 底下時仍被公開查得到。
    if (!found || found.session.status === 'draft' || found.campaign.status === 'draft') {
      return res.status(404).json({ success: false, error: 'POPUP_SESSION_NOT_FOUND', message: '找不到此快閃場次' });
    }
    const now = Date.now();
    const data = popupCheckout.serializePublicSession(db, storeId, found.session, found.campaign.status, now);
    res.json({ success: true, data: { ...data, campaign: popupCheckout.serializePublicCampaign(found.campaign) } });
  } catch (e) { sendPopupError(res, e); }
});

router.post('/popup-checkout', (req, res) => {
  try {
    const db = getDb();
    const body = req.body || {};

    if (!pp.isNonEmptyString(body.customer_name, 100)) {
      pp.fail('POPUP_VALIDATION_ERROR', 'customer_name 必填，且長度需在 1~100 字之間');
    }
    const phoneCheck = normalizeTaiwanMobile(body.customer_phone || '');
    if (!phoneCheck.valid) pp.fail('POPUP_VALIDATION_ERROR', '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）');
    const phone = phoneCheck.local;

    const primaryCode = body.popup_session_public_code;
    const aliasCode = body.session_public_code;
    if (primaryCode !== undefined && aliasCode !== undefined && primaryCode !== aliasCode) {
      pp.fail('POPUP_VALIDATION_ERROR', 'popup_session_public_code 與 session_public_code 同時存在但不同，請只使用其中一個欄位');
    }
    const sessionPublicCode = primaryCode !== undefined ? primaryCode : aliasCode;
    if (!pp.isNonEmptyString(sessionPublicCode, 200)) {
      pp.fail('POPUP_VALIDATION_ERROR', '缺少快閃場次代碼');
    }

    // Phase 3A.3 修正：BEGIN 之前只允許「驗證基本 request 型別」與「依
    // 全域唯一 public_code 初步取得 store_id」這兩件事——不得再用
    // getStoreLicense() 的 30 秒快取（或任何其他管道）做任何可以提前拒絕
    // checkout 的權威判斷（stores.active／licenses.active／
    // features.line_order／popup_pickup_enabled／session 狀態全部一律
    // 留給交易內的 validatePopupCheckoutAuthority() 用 fresh 查詢決定）。
    // 這裡的 storeId 只是「定位」用途：找不到 code 本身對應的 store_id
    // 時，直接回覆跟「場次不存在」相同的 404，因為這種情況下連要開哪個
    // store 的交易都無法決定，根本還沒有交易可以開。
    const storeId = resolveStoreIdByPublicCode(db, 'popup_sessions', sessionPublicCode);
    if (!storeId) pp.fail('POPUP_SESSION_NOT_FOUND', '找不到此快閃場次', 404);

    // R50：快閃付款設定（已儲存時才啟用；未設定＝legacy，下方流程與 R49 相同）。
    const popupPayConfigured = ppay.isPopupPaymentConfigured(db, storeId);
    let idemKey = null;
    if (popupPayConfigured) {
      ppay.reconcileExpiredPopupPayments(db, storeId);
      const rawKey = req.get('Idempotency-Key');
      if (typeof rawKey === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(rawKey)) {
        idemKey = rawKey;
        ppay.ensurePopupPaymentSchema(db);
        const prev = db.get('SELECT order_id FROM popup_checkout_requests WHERE store_id=? AND idem_key=?', [storeId, idemKey]);
        if (prev) {
          const o = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [prev.order_id, storeId]);
          if (o) {
            const its = (() => { try { return JSON.parse(o.items || '[]'); } catch (e) { return []; } })();
            return res.status(200).json({ success: true, data: {
              id: o.id, order_number: o.order_number, pickup_type: 'popup', idempotent_replay: true,
              popup_session_public_code: o.popup_session_public_code_snapshot, popup_campaign_name: o.popup_campaign_name_snapshot,
              popup_session_name: o.popup_session_name_snapshot, pickup_date: o.popup_pickup_date_snapshot,
              pickup_start_time: o.popup_pickup_start_time_snapshot, pickup_end_time: o.popup_pickup_end_time_snapshot,
              place_name: o.pickup_place_name_snapshot, address: o.pickup_address_snapshot, address_note: o.pickup_address_note_snapshot,
              items: its, subtotal: o.subtotal, total: o.total, total_qty: its.reduce((n, it) => n + (Number(it.qty) || 0), 0),
              customer_name: o.customer_name, customer_phone: o.customer_phone, note: o.note || '',
              payment_method: o.payment_method, payment_status: o.payment_status,
            } });
          }
        }
      }
    }

    const orderId = uuidv4();
    const d = new Date();
    const pad = (v, l = 2) => String(v).padStart(l, '0');
    const nowStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const orderNo = `POPUP-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${orderId.slice(0, 6)}`;
    const knownLineUserId = body.member_session ? verifyMemberSession(body.member_session, storeId) : null;

    let session, campaign, items, subtotal, paymentMethodCode, payAttempt = null, payTimeout = null;

    // R44.2F：durable transaction（COMMIT 後 disk 寫入失敗 → memory／disk 都回到 before-state，回 503）
    db.runDurableTransaction(() => {
      const authResult = popupCheckout.validatePopupCheckoutAuthority(db, {
        storeId,
        sessionPublicCode,
        items: body.items,
        paymentMethodCode: body.payment_method,
        now: Date.now(),
        ...(popupPayConfigured ? { paymentResolver: ppay.makeCheckoutPaymentResolver(db, storeId) } : {}),
      });
      session = authResult.session;
      campaign = authResult.campaign;
      items = authResult.items;
      subtotal = authResult.subtotal;
      paymentMethodCode = authResult.paymentMethodCode;

      const itemsJson = JSON.stringify(items);
      const pickupTimeVal = `${session.pickup_date} ${session.pickup_start_time}`;
      const paymentCategory = paymentMethodCode === 'cash' ? 'cash' : 'non_cash';

      db._db.run(
        `INSERT INTO orders (
          id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
          customer_name, customer_phone, customer_line_id,
          pickup_time, items, payment_method, payment_category, payment_status,
          subtotal, discount_type, discount_amount, original_total, coupon_code, total,
          note, sync_status, device_id, source, created_at, updated_at, line_user_id,
          pickup_type, popup_campaign_id, popup_session_id,
          popup_campaign_name_snapshot, popup_session_name_snapshot, popup_session_public_code_snapshot,
          popup_pickup_date_snapshot, popup_pickup_start_time_snapshot, popup_pickup_end_time_snapshot,
          pickup_store_name_snapshot, pickup_place_name_snapshot, pickup_place_id_snapshot,
          pickup_address_snapshot, pickup_address_note_snapshot,
          pickup_lat_snapshot, pickup_lng_snapshot
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          orderId, orderId, orderNo, storeId, 'takeout', 'pending', 'pending',
          body.customer_name.trim(), phone, body.customer_line_id || '',
          pickupTimeVal, itemsJson, paymentMethodCode, paymentCategory, 'pending',
          subtotal, 'none', 0, subtotal, '', subtotal,
          body.note || '', 'synced', 'LINE', 'line', nowStr, nowStr, knownLineUserId || '',
          'popup', session.campaign_id, session.id,
          campaign.name, session.name, session.public_code,
          session.pickup_date, session.pickup_start_time, session.pickup_end_time,
          '', session.place_name, session.place_id,
          session.address, session.address_note,
          session.lat, session.lng,
        ]
      );
      popupCheckout.allocatePopupOrderItemsInTransaction(db, storeId, session, orderId, items);
      // R50：線上付款 → 同一交易內建立唯一 pending 付款 attempt（名額已於上方保留，逾時由
      // lazy reconcile 釋放）；冪等鍵與訂單同交易寫入（UNIQUE(store_id, idem_key)）。
      if (popupPayConfigured && ppay.ONLINE_CODES.has(paymentMethodCode)) {
        payTimeout = ppay.loadPopupPaymentSettings(db, storeId).timeout_minutes;
        payAttempt = ppay.createAttemptInTransaction(db, { storeId, orderId, sessionId: session.id, provider: paymentMethodCode, amount: subtotal, timeoutMinutes: payTimeout });
      }
      if (popupPayConfigured && idemKey) {
        ppay.ensurePopupPaymentSchema(db);
        db._db.run('INSERT INTO popup_checkout_requests (store_id, idem_key, order_id) VALUES (?,?,?)', [storeId, idemKey, orderId]);
      }
    });

    res.status(201).json({
      success: true,
      data: {
        id: orderId,
        order_number: orderNo,
        pickup_type: 'popup',
        popup_session_public_code: session.public_code,
        popup_campaign_name: campaign.name,
        popup_session_name: session.name,
        pickup_date: session.pickup_date,
        pickup_start_time: session.pickup_start_time,
        pickup_end_time: session.pickup_end_time,
        place_name: session.place_name,
        address: session.address,
        address_note: session.address_note,
        items,
        subtotal,
        total: subtotal,
        // R49：完成頁所需的 server-authoritative 顧客／付款／件數資料（只回傳
        // 本次請求者自己剛送出、且已被後端正規化的值；不含任何內部 ID）。
        total_qty: items.reduce((n, it) => n + it.qty, 0),
        customer_name: body.customer_name.trim(),
        customer_phone: phone,
        note: typeof body.note === 'string' ? body.note : '',
        payment_method: paymentMethodCode,
        payment_status: 'pending',
        ...(popupPayConfigured ? { payment: payAttempt
          ? { required: true, method: paymentMethodCode, token: payAttempt.token, ref: payAttempt.attemptId, expires_at: new Date(payAttempt.expiresAt).toISOString(), timeout_minutes: payTimeout, state: 'pending_payment', state_label: ppay.stateLabel('pending_payment') }
          : { required: false, method: paymentMethodCode, state: paymentMethodCode === 'cash' ? 'pay_at_pickup' : 'pending_confirmation', state_label: ppay.stateLabel(paymentMethodCode === 'cash' ? 'pay_at_pickup' : 'pending_confirmation') } } : {}),
      },
    });
  } catch (e) { sendPopupError(res, e); }
});

// ══════════════════════════════════════════════════════════════════════
// R50：快閃線上付款（沿用既有 LINE Pay adapter；token 為付款憑證，只存 SHA-256）
// ══════════════════════════════════════════════════════════════════════
function popupPaymentSummary(db, attempt) {
  const order = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [attempt.order_id, attempt.store_id]);
  const fresh = db.get('SELECT * FROM popup_payment_attempts WHERE attempt_id=?', [attempt.attempt_id]);
  const state = ppay.derivePopupPaymentState(order, fresh);
  const s = ppay.loadPopupPaymentSettings(db, attempt.store_id);
  const items = (() => { try { return JSON.parse((order && order.items) || '[]'); } catch (e) { return []; } })();
  return {
    order_number: order ? order.order_number : null, ref: fresh.attempt_id, method: order ? order.payment_method : null,
    state, state_label: ppay.stateLabel(state), amount: fresh.amount, currency: fresh.currency,
    expires_at: new Date(Number(fresh.expires_at)).toISOString(),
    can_pay: fresh.status === 'pending' && Number(fresh.expires_at) > Date.now() && !!order && order.order_status !== 'cancelled',
    can_switch_to_cash: !!(s && s.allow_fallback_cash && s.methods.cash && s.methods.cash.enabled) && fresh.status === 'failed' && !!order && order.order_status !== 'cancelled' && order.payment_status === 'pending',
    order: order ? {
      popup_session_public_code: order.popup_session_public_code_snapshot, popup_campaign_name: order.popup_campaign_name_snapshot,
      popup_session_name: order.popup_session_name_snapshot, pickup_date: order.popup_pickup_date_snapshot,
      pickup_start_time: order.popup_pickup_start_time_snapshot, pickup_end_time: order.popup_pickup_end_time_snapshot,
      place_name: order.pickup_place_name_snapshot, address: order.pickup_address_snapshot, address_note: order.pickup_address_note_snapshot,
      items, total: order.total, customer_name: order.customer_name, note: order.note || '',
    } : null,
  };
}
// R51：不直接信任 Host header——canonical PUBLIC_BASE_URL／APP_BASE_URL 優先；沒有設定時
// 只有測試模式可用格式嚴格驗證過的 request host（見 utils/popupPayment.resolvePaymentReturnBase）。
function popupBaseUrl(req, mode) {
  return ppay.resolvePaymentReturnBase(req, mode);
}
function popupReturnUrl(req, db, attempt, result) {
  const order = db.get('SELECT popup_session_public_code_snapshot AS c FROM orders WHERE id=? AND store_id=?', [attempt.order_id, attempt.store_id]);
  const code = order && order.c ? order.c : '';
  return `/popup-order?session=${encodeURIComponent(code)}&popup_pay_ref=${encodeURIComponent(attempt.attempt_id)}&popup_pay_result=${encodeURIComponent(result)}`;
}

router.get('/popup-payment/status', (req, res) => {
  try {
    const db = getDb();
    const attempt = ppay.findAttemptByToken(db, String(req.query.token || ''));
    if (!attempt) return res.status(404).json({ success: false, error: 'POPUP_PAYMENT_NOT_FOUND', message: '找不到此付款' });
    ppay.reconcileExpiredPopupPayments(db, attempt.store_id);
    res.json({ success: true, data: popupPaymentSummary(db, attempt) });
  } catch (e) { sendPopupError(res, e); }
});

router.post('/popup-payment/linepay-request', async (req, res) => {
  try {
    const db = getDb();
    const attempt = ppay.findAttemptByToken(db, String((req.body || {}).token || ''));
    if (!attempt) return res.status(404).json({ success: false, error: 'POPUP_PAYMENT_NOT_FOUND', message: '找不到此付款' });
    ppay.reconcileExpiredPopupPayments(db, attempt.store_id);
    const fresh = ppay.findAttemptById(db, attempt.attempt_id);
    const order = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [fresh.order_id, fresh.store_id]);
    if (fresh.provider !== 'linepay') return res.status(409).json({ success: false, error: 'POPUP_PAYMENT_METHOD_NOT_READY', message: '此付款方式尚未開放線上付款' });
    if (fresh.status !== 'pending' || !order || order.order_status === 'cancelled' || Number(fresh.expires_at) <= Date.now()) {
      return res.status(409).json({ success: false, error: 'POPUP_PAYMENT_NOT_PAYABLE', message: '此付款已結束或逾時', data: popupPaymentSummary(db, fresh) });
    }
    if (!ppay.providerReadiness(db, fresh.store_id, 'linepay').ready) return res.status(409).json({ success: false, error: 'POPUP_PAYMENT_METHOD_NOT_READY', message: 'LINE Pay 目前無法使用' });
    const readiness = ppay.providerReadiness(db, fresh.store_id, 'linepay');
    const base = popupBaseUrl(req, readiness.mode);
    if (!base) return res.status(409).json({ success: false, error: 'POPUP_PAYMENT_METHOD_NOT_READY', message: 'LINE Pay 目前無法使用' });
    const sig = ppay.issueCallbackNonce(db, fresh.attempt_id); // R51：一次性 nonce（只存 hash），不依賴 JWT_SECRET
    if (!sig) return res.status(409).json({ success: false, error: 'POPUP_PAYMENT_NOT_PAYABLE', message: '此付款已結束或逾時' });
    const q = `ref=${encodeURIComponent(fresh.attempt_id)}&cb=${sig}`;
    const { requestLinePayPayment } = require('../utils/linePayService');
    const r = await requestLinePayPayment({ db, storeId: fresh.store_id, order: { ...order, total: fresh.amount },
      redirectUrl: `${base}/api/line-orders/popup-payment/linepay-confirm?${q}`, cancelUrl: `${base}/api/line-orders/popup-payment/linepay-cancel?${q}` });
    if (!r.success) return res.status(502).json({ success: false, error: 'POPUP_PAYMENT_PROVIDER_ERROR', message: 'LINE Pay 暫時無法建立付款，請稍後再試' });
    db.runDurableTransaction(() => {
      db._db.run("UPDATE popup_payment_attempts SET transaction_id=?, updated_at=datetime('now','localtime') WHERE attempt_id=? AND status='pending'", [String(r.transaction_id || ''), fresh.attempt_id]);
    });
    res.json({ success: true, data: { payment_url: r.payment_url, ref: fresh.attempt_id } });
  } catch (e) { sendPopupError(res, e); }
});

router.get('/popup-payment/linepay-confirm', async (req, res) => {
  const db = getDb();
  const attempt = ppay.findAttemptById(db, String(req.query.ref || ''));
  if (!attempt) return res.status(404).type('text/plain').send('payment not found');
  try {
    const order = db.get('SELECT * FROM orders WHERE id=? AND store_id=?', [attempt.order_id, attempt.store_id]);
    if (!order || !ppay.verifyAttemptCallback(attempt, order.order_number, String(req.query.cb || ''))) {
      return res.status(400).type('text/plain').send('invalid callback signature');
    }
    if (attempt.status === 'paid') return res.redirect(popupReturnUrl(req, db, attempt, 'paid')); // 重複 callback：冪等 no-op
    ppay.reconcileExpiredPopupPayments(db, attempt.store_id);
    const cur = ppay.findAttemptById(db, attempt.attempt_id);
    if (cur.status !== 'pending') return res.redirect(popupReturnUrl(req, db, cur, cur.status));
    const transactionId = String(req.query.transactionId || '');
    // LINE Pay transactionId 是 19 位數字；JSON number 會失去精度，因此一律以相同的 Number() 轉換比較（與既有 routes/linepay.js 儲存方式一致）。
    const sameTx = (a, b) => String(a) === String(b) || (Number.isFinite(Number(a)) && Number(a) === Number(b));
    if (!/^\d{1,30}$/.test(transactionId) || (cur.transaction_id && !sameTx(cur.transaction_id, transactionId)) || String(req.query.orderId || '') !== order.order_number) {
      ppay.markAttemptFailed(db, cur, 'callback_mismatch');
      return res.redirect(popupReturnUrl(req, db, cur, 'failed'));
    }
    const { getLinePayConfig, signLinePayPost, makePostHeaders } = require('../utils/linePayClient');
    const cfg = getLinePayConfig(db, cur.store_id, true);
    if (!cfg || !cfg.channelId || !cfg.channelSecret) { ppay.markAttemptFailed(db, cur, 'provider_not_ready'); return res.redirect(popupReturnUrl(req, db, cur, 'failed')); }
    const confirmBody = { amount: Number(cur.amount), currency: cur.currency };
    const uri = `/v3/payments/${transactionId}/confirm`;
    const nonce = uuidv4().replace(/-/g, '').slice(0, 32);
    const { bodyStr, signature } = signLinePayPost(cfg.channelSecret, uri, confirmBody, nonce);
    const fetch = require('node-fetch');
    let data = null;
    try {
      const apiRes = await fetch(cfg.apiBase + uri, { method: 'POST', headers: makePostHeaders(cfg.channelId, signature, nonce), body: bodyStr, timeout: 10000 });
      data = await apiRes.json();
    } catch (e) { data = null; }
    const info = data && data.info;
    const paidAmount = info && Array.isArray(info.payInfo) ? info.payInfo.reduce((n, p) => n + Number(p.amount || 0), 0) : null;
    const ok = data && data.returnCode === '0000' && info && sameTx(info.transactionId, transactionId)
      && (info.orderId === undefined || String(info.orderId) === order.order_number) && (paidAmount === null || paidAmount === Number(cur.amount));
    if (!ok) {
      ppay.markAttemptFailed(db, cur, data && data.returnCode === '0000' ? 'amount_or_id_mismatch' : 'provider_declined');
      return res.redirect(popupReturnUrl(req, db, cur, 'failed'));
    }
    ppay.markAttemptPaid(db, cur, transactionId);
    return res.redirect(popupReturnUrl(req, db, cur, 'paid'));
  } catch (e) {
    console.error('[popup-payment/confirm] error:', e && e.message ? e.message : 'unknown');
    return res.redirect(popupReturnUrl(req, db, attempt, 'error'));
  }
});

router.get('/popup-payment/linepay-cancel', (req, res) => {
  const db = getDb();
  const attempt = ppay.findAttemptById(db, String(req.query.ref || ''));
  if (!attempt) return res.status(404).type('text/plain').send('payment not found');
  try {
    const order = db.get('SELECT order_number FROM orders WHERE id=? AND store_id=?', [attempt.order_id, attempt.store_id]);
    if (!order || !ppay.verifyAttemptCallback(attempt, order.order_number, String(req.query.cb || ''))) {
      return res.status(400).type('text/plain').send('invalid callback signature');
    }
    if (attempt.status === 'pending') ppay.markAttemptFailed(db, attempt, 'customer_cancelled');
    return res.redirect(popupReturnUrl(req, db, attempt, 'cancelled'));
  } catch (e) { return res.redirect(popupReturnUrl(req, db, attempt, 'error')); }
});

router.post('/popup-payment/switch-to-cash', (req, res) => {
  try {
    const db = getDb();
    const attempt = ppay.findAttemptByToken(db, String((req.body || {}).token || ''));
    if (!attempt) return res.status(404).json({ success: false, error: 'POPUP_PAYMENT_NOT_FOUND', message: '找不到此付款' });
    ppay.reconcileExpiredPopupPayments(db, attempt.store_id);
    ppay.switchFailedAttemptToCash(db, ppay.findAttemptById(db, attempt.attempt_id));
    res.json({ success: true, data: popupPaymentSummary(db, attempt) });
  } catch (e) { sendPopupError(res, e); }
});

module.exports = router;
