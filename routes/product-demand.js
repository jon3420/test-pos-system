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
//   PATCH /settings                  { enabled, ttl_days, notify_enabled, subscribe_mode }（C4.5：subscribe_mode＝opt_in｜register_subscribe）
//   GET   /snapshot[?product_id=]    （C4.2）唯讀整合：總表＋通知能力＋（選定商品）明細與批次，同一資料時點
//                                    （C6.1 列表操作優化）另含 auto：自動通知開關與參與商品 ID（唯讀）
//
// R54.4／MBV2-HF1-C4 補貨通知（同一個 adminRouter，沿用 requireStaffJwt＋line_order；store 只信任 JWT）：
//   GET   /restock/capability                 通知能力、必要設定是否完整、啟用狀態
//   PATCH /restock/settings                   { send_enabled }（預設關閉）
//   GET   /restock/date-options?product_id=&fulfillment_mode=[&date=]  （C4.5）唯讀日期檢查（不建立批次）
//   POST  /restock/preview                    { product_id, fulfillment_mode, supply_date } → 伺服器計算名單並保存批次
//   POST  /restock/batches/:uuid/confirm      店家確認發送（原子轉移；重複呼叫不會重複建立）
//   POST  /restock/batches/:uuid/resume       明確續送（沿用原逐筆紀錄與 retry key）
//   POST  /restock/batches/:uuid/cancel       取消尚未送出的項目
//   GET   /restock/batches[?product_id=]      批次清單與進度
//   GET   /restock/batches/:uuid              批次明細（重新整理後仍可查）
// 顧客端新增：GET /product-ref?ref=<product_uuid>（商品直達：以穩定識別取得目前公開商品 ID；讀取商品資料不計為點擊）
// C5：POST /track/open { rt, product_id, open_key, visitor_id, session_id[, member_session] }（最終頁實際開啟商品後）
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
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { enabled: c.enabled, max_qty: c.max_qty, ttl_days: c.ttl_days, notify_available: c.notify_available,
      // C4.5：訂閱方式（通知不可用時前端不顯示任何「會收到通知」的承諾）
      subscribe_mode: c.subscribe_mode,
      consent_text: c.notify_available ? c.consent_text : '', consent_text_version: c.notify_available ? c.consent_text_version : '' } });
  } catch (e) { sendErr(res, e, 'config'); }
});
// 商品直達：只接受穩定識別，回傳目前仍公開的商品 ID；不需要也不接受會員身分
publicRouter.get('/product-ref', (req, res) => {
  try { res.json({ success: true, data: RN.resolveProductRef(getDb(), req.storeId, req.query.ref) }); }
  catch (e) { sendErr(res, e, 'product-ref'); }
});
// R54.4／MBV2-HF1-C5：補貨通知商品「實際開啟」紀錄（最終點餐頁成功開啟目標商品後才送出）。
//   rt＝批次追蹤識別（只對應店別＋批次＋商品，不具任何權限）；open_key＝同一次開啟的去重識別。
//   會員只信任後端驗證的 member_session（可稍後以同一 open_key 補送，只補「尚無會員」的紀錄）。
//   回應只有 tracked（不揭露批次是否存在、收件人或名單）。失敗不影響瀏覽。
publicRouter.post('/track/open', (req, res) => {
  try {
    const b = req.body || {};
    const ms = typeof b.member_session === 'string' && b.member_session ? b.member_session : null;
    let uid = null;
    if (ms) { try { uid = verifyMemberSession(ms, req.storeId) || null; } catch { uid = null; } }
    const r = require('../utils/restockTracking').recordOpen(getDb(), req.storeId, b, uid);
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: { tracked: !!r.tracked } });
  } catch (e) { console.warn('[product-demand] track open:', e && e.message); res.json({ success: true, data: { tracked: false } }); }
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
      consent_mode: b.consent_mode, consent_action: b.consent_action, consent_text_version: b.consent_text_version,
    });
    res.json({ success: true, data: r });
  } catch (e) { sendErr(res, e, 'register'); }
});
// C5.1／C5.2：POST /subscribe { member_session, product_id, request_uuid（C5.2）| request_id（C5.1 頁面）, consent_mode, consent_text_version }
//   只新增本週期的通知同意；不更新份數、取餐偏好、有效期限或登記週期（見 utils/productDemand.js subscribe）
publicRouter.post('/subscribe', (req, res) => {
  try {
    const uid = identify(req, res); if (!uid) return;
    const b = req.body || {};
    res.json({ success: true, data: PD.subscribe(getDb(), req.storeId, uid, {
      product_id: b.product_id, request_uuid: b.request_uuid, request_id: b.request_id, consent_mode: b.consent_mode, consent_text_version: b.consent_text_version,
    }) });
  } catch (e) { sendErr(res, e, 'subscribe'); }
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
    // R54.4／MBV2-HF1-C6.1 列表操作優化：商品列表「恢復販售通知」欄所需的參與狀態（唯讀；同一資料時點、同一 JWT 店別）。
    //   只回傳全店開關、總開關、設定完整度與參與商品 ID；不含 epoch／商品參與版本（前端不模擬版本）。
    //   讀取失敗時只標記 auto_error，總表其餘部分照常回應（前端顯示「狀態待更新」，不當成未參與）。
    out.auto = null; out.auto_error = '';
    try {
      const ac = RA.getConfig(db, sid);
      out.auto = { enabled: !!ac.enabled, enabled_at: ac.enabled_at || null, send_enabled: !!ac.send_enabled, notify_available: !!ac.notify_available,
        config_complete: !!ac.config_complete, missing: ac.missing || [], participating_product_ids: ac.participating_products.map((p) => Number(p.product_id)) };
    } catch (e) { console.warn('[product-demand] snapshot auto:', e && e.message); out.auto = null; out.auto_error = 'AUTO_CONFIG_UNAVAILABLE'; }
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
// R54.4／MBV2-HF1-C4.5：選日期時的唯讀檢查（員工 JWT＋店別只信任 JWT；不建立批次、不寫入）
adminRouter.get('/restock/date-options', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: RN.dateOptions(getDb(), req.storeId, req.query || {}) });
  } catch (e) { sendErr(res, e, 'restock date-options'); }
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

// ── R54.4／MBV2-HF1-C6：恢復販售自動補貨通知（全店開關預設關閉；商品預設不參與）──────────────
//   GET   /restock/auto                     設定、適用商品、取餐方式與供應日期規則、總開關狀態
//   PATCH /restock/auto { enabled }         開啟（新觀測基線，不追發）／關閉（取消未處理事件；自動批次下一筆前暫停）
//   PATCH /restock/auto/products/:id { enabled }  商品是否參與自動通知
//   GET   /restock/auto/events[?product_id=]      觸發紀錄（時間、商品、日期／取餐方式、狀態、排除與未發送原因、批次）
const RA = require('../utils/restockAuto');
adminRouter.get('/restock/auto', (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: RA.getConfig(getDb(), req.storeId) }); }
  catch (e) { sendErr(res, e, 'restock auto config'); }
});
adminRouter.patch('/restock/auto', (req, res) => {
  try {
    const b = req.body || {};
    if (!(b.enabled === true || b.enabled === false || b.enabled === 1 || b.enabled === 0 || b.enabled === '1' || b.enabled === '0')) throw new RN.RestockError('INVALID_INPUT', 'enabled 必須是布林值', 400);
    const en = b.enabled === true || b.enabled === 1 || b.enabled === '1';
    res.json({ success: true, data: RA.setEnabled(getDb(), req.storeId, en, actorOf(req)) });
  } catch (e) { sendErr(res, e, 'restock auto set'); }
});
adminRouter.patch('/restock/auto/products/:id', (req, res) => {
  try {
    const b = req.body || {};
    const en = b.enabled === true || b.enabled === 1 || b.enabled === '1';
    res.json({ success: true, data: RA.setProductParticipation(getDb(), req.storeId, req.params.id, en) });
  } catch (e) { sendErr(res, e, 'restock auto product'); }
});
adminRouter.get('/restock/auto/events', (req, res) => {
  try { res.set('Cache-Control', 'no-store'); res.json({ success: true, data: RA.listEvents(getDb(), req.storeId, req.query || {}) }); }
  catch (e) { sendErr(res, e, 'restock auto events'); }
});

// ── R54.4／MBV2-HF1-C6：需求資料 CSV 匯出（商家營運用；不是 MBV2 搬家備份）──────────────
//   GET /export.csv?type=summary|details&product_id=&status=active|expired|cancelled&pref=&from=YYYY-MM-DD&to=YYYY-MM-DD[&only_active=1]
//   店別只信任員工 JWT；中文 UTF-8＋BOM；防公式注入；LINE 使用者識別遮罩；不輸出憑證、session、權杖。
adminRouter.get('/export.csv', (req, res) => {
  try {
    const q = req.query || {};
    const type = q.type === 'summary' ? 'summary' : 'details';
    const out = type === 'summary' ? require('../utils/demandExport').exportSummary(getDb(), req.storeId, q) : require('../utils/demandExport').exportDetails(getDb(), req.storeId, q);
    const d = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
    const name = `restock-demand-${type}-${d}.csv`;
    res.set('Content-Type', 'text/csv; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(type === 'summary' ? '補貨需求統計-' + d + '.csv' : '補貨需求明細-' + d + '.csv')}`);
    res.set('Cache-Control', 'no-store');
    res.set('X-Export-Rows', String(out.count));
    if (out.truncated) res.set('X-Export-Truncated', '1');
    res.send(out.csv);
  } catch (e) { sendErr(res, e, 'demand export'); }
});

// ── R54.4／MBV2-HF1-C5：補貨通知成效（掛在 /api/analytics/restock-notify；requireStaffJwt＋reports）────────
//   GET  /summary?from=&to=&product_id=&mode=&batch_uuid=   以通知批次為群體的漏斗（唯讀）
//   POST /reconcile { days }                                  補登：重算尚無歸因的 LINE 會員訂單（可重跑，不重複計算）
const reportRouter = express.Router();
reportRouter.get('/summary', (req, res) => {
  try {
    res.set('Cache-Control', 'no-store');
    res.json({ success: true, data: require('../utils/restockTracking').summary(getDb(), req.storeId, req.query || {}) });
  } catch (e) { sendErr(res, e, 'restock summary'); }
});
reportRouter.post('/reconcile', (req, res) => {
  try { res.json({ success: true, data: require('../utils/restockTracking').reconcileOrders(getDb(), req.storeId, req.body || {}) }); }
  catch (e) { sendErr(res, e, 'restock reconcile'); }
});

module.exports = { publicRouter, adminRouter, reportRouter };
