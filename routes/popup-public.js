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

function sendPopupError(res, err) {
  if (err instanceof pp.PopupValidationError) {
    return res.status(err.status).json({ success: false, error: err.code, message: err.message, ...(err.extra || {}) });
  }
  console.error('[popup-public] internal error:', err && err.stack ? err.stack : err);
  return res.status(500).json({ success: false, error: 'POPUP_INTERNAL_ERROR', message: '系統發生錯誤，請稍後再試' });
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
    const data = campaigns.map((c) => {
      const sessions = db.all(
        "SELECT * FROM popup_sessions WHERE store_id=? AND campaign_id=? AND status='published' ORDER BY pickup_date ASC, sort_order ASC",
        [storeId, c.id]
      )
        .map((s) => popupCheckout.serializePublicSession(db, storeId, s, c.status, now))
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
    const sessions = db.all(
      'SELECT * FROM popup_sessions WHERE store_id=? AND campaign_id=? ORDER BY pickup_date ASC, sort_order ASC',
      [storeId, campaign.id]
    )
      .filter((s) => s.status !== 'draft')
      .map((s) => popupCheckout.serializePublicSession(db, storeId, s, campaign.status, now));
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

    const orderId = uuidv4();
    const d = new Date();
    const pad = (v, l = 2) => String(v).padStart(l, '0');
    const nowStr = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    const orderNo = `POPUP-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${orderId.slice(0, 6)}`;
    const knownLineUserId = body.member_session ? verifyMemberSession(body.member_session, storeId) : null;

    let session, campaign, items, subtotal, paymentMethodCode;

    db._db.run('BEGIN');
    try {
      const authResult = popupCheckout.validatePopupCheckoutAuthority(db, {
        storeId,
        sessionPublicCode,
        items: body.items,
        paymentMethodCode: body.payment_method,
        now: Date.now(),
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
      db._db.run('COMMIT');
    } catch (e) {
      try { db._db.run('ROLLBACK'); } catch (e2) { /* 不掩蓋原始錯誤 */ }
      throw e;
    }
    db._save();

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
      },
    });
  } catch (e) { sendPopupError(res, e); }
});

module.exports = router;
