// routes/product-demand.js — R54.4／MBV2-HF1-C3：商品想買登記 API
//
// 顧客端（掛在 /api/product-demand，requireStore + requireFeature('line_order')）：
//   GET  /config           是否開放登記、有效天數、通知是否可用（後端判定）
//   POST /mine             本人有效登記（body: member_session[, product_id]）
//   POST /register         新增／更新本人登記（body: member_session, product_id, desired_qty,
//                          fulfillment_pref[, notify_consent]）
//   POST /cancel           取消本人登記（body: member_session, request_id 或 product_id）
//   POST /consent/revoke   撤回本人對某商品的通知同意（body: member_session, product_id）
//   身分只來自 verifyMemberSession(member_session, req.storeId)；body 帶 line_user_id 一律忽略。
//   member_session 放在 POST body，不放 URL。
//
// 後台（掛在 /api/product-demand-admin，requireStaffJwt：store_id 只信任 JWT）：
//   GET   /summary                   商品需求清單（有效登記人數、期望總份數）
//   GET   /products/:id              單一商品登記明細
//   PATCH /products/:id/collect      個別商品開關需求收集 { enabled }
//   PATCH /settings                  { enabled, ttl_days, notify_enabled }
//   GET   /snapshot[?product_id=]    （C4.2）唯讀整合：總表＋通知能力＋（選定商品）明細與批次，同一資料時點
//
// R54.4／MBV2-HF1-C4 補貨通知（同一個 adminRouter，沿用 requireStaffJwt＋line_order；store 只信任 JWT）：
//   GET   /restock/capability                 通知能力、必要設定是否完整、啟用狀態
//   PATCH /restock/settings                   { send_enabled }（預設關閉）
//   POST  /restock/preview                    { product_id, fulfillment_mode, supply_date } → 伺服器計算名單並保存批次
//   POST  /restock/batches/:uuid/confirm      店家確認發送（原子轉移；重複呼叫不會重複建立）
//   POST  /restock/batches/:uuid/resume       明確續送（沿用原逐筆紀錄與 retry key）
//   POST  /restock/batches/:uuid/cancel       取消尚未送出的項目
//   GET   /restock/batches[?product_id=]      批次清單與進度
//   GET   /restock/batches/:uuid              批次明細（重新整理後仍可查）
// 顧客端新增：GET /product-ref?ref=<product_uuid>（商品直達：以穩定識別取得目前公開商品 ID）
//
// 登記、訂閱與通知都不建立訂單、不收款、不更動任何額度欄位。
// 只有店家按「確認發送」／「續送」才會透過 utils/linePush.js 呼叫 LINE。
'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const { verifyMemberSession } = require('../utils/lineMemberSession');
const PD = require('../utils/productDemand');
const RN = require('../utils/restockNotify');

function sendErr(res, e, tag) {
  if (e instanceof PD.DemandError || e instanceof RN.RestockError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
  console.error(`[product-demand] ${tag}:`, e && e.message);
  return res.status(500).json({ success: false, code: 'INTERNAL_ERROR', message: '系統忙碌，請稍後再試' });
}
function identify(req, res) {
  const ms = req.body && req.body.member_session;
  const uid = typeof ms === 'string' && ms ? verifyMemberSession(ms, req.storeId) : null;
  if (!uid) {
    res.status(401).json({ success: false, code: 'MEMBER_NOT_IDENTIFIED', message: '請先以 LINE 會員登入' });
    return null;
  }
  return uid;
}

const publicRouter = express.Router();
publicRouter.get('/config', (req, res) => {
  try {
    const c = PD.getConfig(getDb(), req.storeId);
    res.json({ success: true, data: { enabled: c.enabled, max_qty: c.max_qty, ttl_days: c.ttl_days, notify_available: c.notify_available,
      consent_text: c.notify_available ? c.consent_text : '', consent_text_version: c.notify_available ? c.consent_text_version : '' } });
  } catch (e) { sendErr(res, e, 'config'); }
});
// 商品直達：只接受穩定識別，回傳目前仍公開的商品 ID；不需要也不接受會員身分
publicRouter.get('/product-ref', (req, res) => {
  try { res.json({ success: true, data: RN.resolveProductRef(getDb(), req.storeId, req.query.ref) }); }
  catch (e) { sendErr(res, e, 'product-ref'); }
});
publicRouter.post('/mine', (req, res) => {
  try {
    const uid = identify(req, res); if (!uid) return;
    const pid = req.body.product_id != null ? Number(req.body.product_id) : null;
    res.json({ success: true, data: PD.listMine(getDb(), req.storeId, uid, Number.isInteger(pid) && pid > 0 ? pid : null) });
  } catch (e) { sendErr(res, e, 'mine'); }
});
publicRouter.post('/register', (req, res) => {
  try {
    const uid = identify(req, res); if (!uid) return;
    const b = req.body || {};
    const r = PD.register(getDb(), req.storeId, uid, {
      product_id: b.product_id, desired_qty: b.desired_qty, fulfillment_pref: b.fulfillment_pref, notify_consent: b.notify_consent,
    });
    res.json({ success: true, data: r });
  } catch (e) { sendErr(res, e, 'register'); }
});
publicRouter.post('/cancel', (req, res) => {
  try {
    const uid = identify(req, res); if (!uid) return;
    res.json({ success: true, data: PD.cancel(getDb(), req.storeId, uid, req.body || {}) });
  } catch (e) { sendErr(res, e, 'cancel'); }
});
publicRouter.post('/consent/revoke', (req, res) => {
  try {
    const uid = identify(req, res); if (!uid) return;
    res.json({ success: true, data: PD.revokeConsent(getDb(), req.storeId, uid, req.body || {}) });
  } catch (e) { sendErr(res, e, 'revoke'); }
});

const adminRouter = express.Router();
adminRouter.get('/summary', (req, res) => {
  try { res.json({ success: true, data: PD.adminSummary(getDb(), req.storeId) }); }
  catch (e) { sendErr(res, e, 'admin summary'); }
});
adminRouter.get('/products/:id', (req, res) => {
  try { res.json({ success: true, data: PD.adminDetail(getDb(), req.storeId, req.params.id) }); }
  catch (e) { sendErr(res, e, 'admin detail'); }
});
// R54.4／MBV2-HF1-C4.2：後台自動更新用的唯讀整合查詢。總表、目前展開商品的明細與通知批次在同一個同步區段內
// 讀取（同一資料時點），沿用 adminSummary／adminDetail／listBatches／getCapability 的既有驗證與統計規則
// （有效登記排除取消與過期）。只讀取：不建立預覽、不確認、不續送、不寫入任何資料。
adminRouter.get('/snapshot', (req, res) => {
  try {
    const db = getDb();
    const sid = req.storeId;
    const out = { server_time: new Date().toISOString(), store_id: sid, summary: PD.adminSummary(db, sid), capability: RN.getCapability(db, sid),
      product_id: null, detail: null, detail_error: '', batches: null };
    const raw = req.query.product_id;
    if (raw != null && raw !== '') {
      const pid = Number(raw);
      if (!Number.isInteger(pid) || pid <= 0) throw new PD.DemandError('INVALID_PRODUCT', '商品參數不正確', 400);
      out.product_id = pid;
      try { out.detail = PD.adminDetail(db, sid, pid); }
      catch (e) { if (e instanceof PD.DemandError && e.status === 404) out.detail_error = e.code; else throw e; }
      out.batches = RN.listBatches(db, sid, pid);
    }
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: out });
  } catch (e) { sendErr(res, e, 'admin snapshot'); }
});
adminRouter.patch('/products/:id/collect', (req, res) => {
  try {
    const en = req.body && (req.body.enabled === true || req.body.enabled === 1 || req.body.enabled === '1');
    res.json({ success: true, data: PD.setProductCollect(getDb(), req.storeId, req.params.id, en) });
  } catch (e) { sendErr(res, e, 'admin collect'); }
});
adminRouter.patch('/settings', (req, res) => {
  try { res.json({ success: true, data: PD.setSettings(getDb(), req.storeId, req.body || {}) }); }
  catch (e) { sendErr(res, e, 'admin settings'); }
});

// ── R54.4／MBV2-HF1-C4：補貨通知（店家手動）────────────────────────────
function actorOf(req) { const a = req.auth || {}; return String(a.role || 'staff') + ':' + String(a.store_id || req.storeId || ''); }
adminRouter.get('/restock/capability', (req, res) => {
  try { res.json({ success: true, data: RN.getCapability(getDb(), req.storeId) }); }
  catch (e) { sendErr(res, e, 'restock capability'); }
});
adminRouter.patch('/restock/settings', (req, res) => {
  try {
    const b = req.body || {};
    const en = b.send_enabled === true || b.send_enabled === 1 || b.send_enabled === '1';
    res.json({ success: true, data: RN.setSendEnabled(getDb(), req.storeId, en) });
  } catch (e) { sendErr(res, e, 'restock settings'); }
});
adminRouter.post('/restock/preview', (req, res) => {
  try {
    const b = req.body || {};
    res.json({ success: true, data: RN.previewBatch(getDb(), req.storeId, {
      product_id: b.product_id, fulfillment_mode: b.fulfillment_mode, supply_date: b.supply_date,
    }, actorOf(req)) });
  } catch (e) { sendErr(res, e, 'restock preview'); }
});
adminRouter.post('/restock/batches/:uuid/confirm', (req, res) => {
  try { res.json({ success: true, data: RN.confirmBatch(getDb(), req.storeId, req.params.uuid, actorOf(req)) }); }
  catch (e) { sendErr(res, e, 'restock confirm'); }
});
adminRouter.post('/restock/batches/:uuid/resume', (req, res) => {
  try { res.json({ success: true, data: RN.resumeBatch(getDb(), req.storeId, req.params.uuid, actorOf(req)) }); }
  catch (e) { sendErr(res, e, 'restock resume'); }
});
adminRouter.post('/restock/batches/:uuid/cancel', (req, res) => {
  try { res.json({ success: true, data: RN.cancelBatch(getDb(), req.storeId, req.params.uuid) }); }
  catch (e) { sendErr(res, e, 'restock cancel'); }
});
adminRouter.get('/restock/batches', (req, res) => {
  try { res.json({ success: true, data: RN.listBatches(getDb(), req.storeId, req.query.product_id) }); }
  catch (e) { sendErr(res, e, 'restock list'); }
});
adminRouter.get('/restock/batches/:uuid', (req, res) => {
  try { res.json({ success: true, data: RN.batchDetail(getDb(), req.storeId, req.params.uuid) }); }
  catch (e) { sendErr(res, e, 'restock detail'); }
});

module.exports = { publicRouter, adminRouter };
