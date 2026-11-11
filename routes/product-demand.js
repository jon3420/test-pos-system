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
//
// 本路由不建立訂單、不收款、不更動任何額度欄位，也不呼叫任何推播。
'use strict';

const express = require('express');
const { getDb } = require('../utils/db');
const { verifyMemberSession } = require('../utils/lineMemberSession');
const PD = require('../utils/productDemand');

function sendErr(res, e, tag) {
  if (e instanceof PD.DemandError) return res.status(e.status).json({ success: false, code: e.code, message: e.message });
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
    res.json({ success: true, data: { enabled: c.enabled, max_qty: c.max_qty, ttl_days: c.ttl_days, notify_available: c.notify_available } });
  } catch (e) { sendErr(res, e, 'config'); }
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

module.exports = { publicRouter, adminRouter };
