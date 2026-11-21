// utils/productDemand.js — R54.4／MBV2-HF1-C3：商品「想買登記」（補貨需求登記基礎）
//
// C3 範圍（只做登記，不發送任何通知）；C4 起通知發送見 utils/restockNotify.js：
//   - 顧客以既有 LINE 會員登入（member_session，後端驗簽）登記想買份數與取餐偏好；
//     不接受前端自行指定會員身分（line_user_id 只來自 verifyMemberSession）。
//   - 同一店別、同一商品、同一會員在同一有效週期只保留一筆（status='active' 的部分唯一索引）；
//     重複提交只更新原筆，不增加人數、不累加份數。
//   - 登記、修改、取消都不建立訂單、不收款、不扣今日／預購額度、不保留庫存（本檔不碰
//     orders／products 的任何額度欄位）。
//   - 需求（product_demand_requests）與通知同意（product_demand_consents）分開保存；登入、
//     加好友、曾下單都不視為通知同意。
//   - 通知是否可用由後端決定：NOTIFY_CHANNEL_IMPLEMENTED（程式能力）且店家設定開啟。本輪
//     尚未接通 LINE 補貨通知，NOTIFY_CHANNEL_IMPLEMENTED=false，因此一律回報不可用，
//     也不會建立 granted 的通知同意。
//
// 未來擴充保留（本輪不實作）：requests.restock_batch_id／notified_at／converted_order_id
// 欄位與 status 'notified'／'converted'，供後續補貨批次、發送紀錄與訂單轉換追蹤使用。
'use strict';

const crypto = require('crypto');

const MAX_QTY = 99;
const DEFAULT_TTL_DAYS = 30;
const MIN_TTL_DAYS = 1;
const MAX_TTL_DAYS = 180;
// R54.4／MBV2-HF1-C4：LINE 補貨通知發送流程已接通（utils/restockNotify.js：同意週期、資格檢查、
// 批次、防重送、備份還原保護）。程式具備能力不等於可用：notify_available 仍須
// 店家開啟 restock_notify_enabled（預設關閉）＋ LINE 權杖＋ LIFF 連結設定完整，由後端判定。
const NOTIFY_CHANNEL_IMPLEMENTED = true;
const CONSENT_TEXT_VERSION = 'restock-notify-c4-v1';
const PREFS = ['takeout', 'delivery', 'any'];
// R54.4／MBV2-HF1-C4.5：消費者訂閱方式（店別設定；與「啟用 LINE 補貨通知發送」總開關分開）
//   opt_in             ：消費者自行勾選（預設；舊資料、未知值一律回到此模式）
//   register_subscribe ：登記即訂閱（顧客按「登記並通知我」明確提交即為本次授權）
// 切換模式不會修改任何既有同意紀錄；授權只來自顧客本次明確提交，並保存文案版本與來源。
const SUBSCRIBE_MODES = ['opt_in', 'register_subscribe'];
const REGISTER_CONSENT_TEXT = '送出即訂閱本商品補貨通知一次，可隨時取消。商品恢復供應或開放預購時，透過 LINE 通知我。';
const REGISTER_CONSENT_TEXT_VERSION = 'restock-notify-c45-register-v1';
function normalizeSubscribeMode(v) { return SUBSCRIBE_MODES.includes(String(v || '')) ? String(v) : 'opt_in'; }

const SETTING_KEYS = {
  enabled: 'product_demand_enabled',            // '1'＝顯示想買登記入口（預設開啟）
  ttlDays: 'product_demand_ttl_days',           // 登記有效天數（預設 30）
  notifyEnabled: 'product_demand_notify_enabled', // C3 舊鍵：C4 起不再作為發送開關（避免升級後自動啟用）
  subscribeMode: 'restock_notify_subscribe_mode', // C4.5：消費者訂閱方式（預設 opt_in）
};
function RN() { return require('./restockNotify'); }
function DS() { return require('./demandSettlement'); }

// ── Schema（safe migration：只用 CREATE TABLE/INDEX IF NOT EXISTS、ALTER ADD COLUMN）──
function migrate(raw) {
  raw.run(`CREATE TABLE IF NOT EXISTS product_demand_requests (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    request_uuid          TEXT NOT NULL,
    store_id              TEXT NOT NULL,
    product_id            INTEGER NOT NULL,
    product_name_snapshot TEXT DEFAULT '',
    line_user_id          TEXT NOT NULL,
    desired_qty           INTEGER NOT NULL DEFAULT 1,
    fulfillment_pref      TEXT NOT NULL DEFAULT 'any',
    status                TEXT NOT NULL DEFAULT 'active',
    cycle_no              INTEGER NOT NULL DEFAULT 1,
    source                TEXT DEFAULT 'line_order',
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now')),
    expires_at            TEXT NOT NULL,
    cancelled_at          TEXT DEFAULT '',
    restock_batch_id      INTEGER DEFAULT NULL,
    notified_at           TEXT DEFAULT NULL,
    converted_order_id    TEXT DEFAULT NULL
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pdr_uuid ON product_demand_requests(request_uuid)');
  raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdr_active_unique
           ON product_demand_requests(store_id, product_id, line_user_id) WHERE status='active'`);
  raw.run('CREATE INDEX IF NOT EXISTS idx_pdr_store_product ON product_demand_requests(store_id, product_id, status)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_pdr_store_user ON product_demand_requests(store_id, line_user_id)');

  raw.run(`CREATE TABLE IF NOT EXISTS product_demand_consents (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    consent_uuid          TEXT NOT NULL,
    store_id              TEXT NOT NULL,
    product_id            INTEGER NOT NULL,
    line_user_id          TEXT NOT NULL,
    request_uuid          TEXT DEFAULT '',
    channel               TEXT NOT NULL DEFAULT 'line',
    status                TEXT NOT NULL DEFAULT 'granted',
    consent_text_version  TEXT DEFAULT '',
    granted_at            TEXT DEFAULT '',
    revoked_at            TEXT DEFAULT '',
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now'))
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pdc_uuid ON product_demand_consents(consent_uuid)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_pdc_store_user_product ON product_demand_consents(store_id, line_user_id, product_id)');

  // 商品層級的需求收集開關（店家可個別關閉）；預設 1＝收集
  const cols = [];
  const st = raw.prepare('PRAGMA table_info(products)');
  try { while (st.step()) cols.push(st.getAsObject().name); } finally { st.free(); }
  if (cols.length && !cols.includes('demand_collect_enabled')) {
    raw.run('ALTER TABLE products ADD COLUMN demand_collect_enabled INTEGER DEFAULT 1');
  }
}

function _setting(db, storeId, key, def) {
  const r = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return r && r.value != null && r.value !== '' ? String(r.value) : def;
}
function clampTtl(v) {
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return DEFAULT_TTL_DAYS;
  return Math.min(MAX_TTL_DAYS, Math.max(MIN_TTL_DAYS, n));
}
function getConfig(db, storeId) {
  const enabled = _setting(db, storeId, SETTING_KEYS.enabled, '1') === '1';
  const ttlDays = clampTtl(_setting(db, storeId, SETTING_KEYS.ttlDays, String(DEFAULT_TTL_DAYS)));
  const cap = RN().getCapability(db, storeId);
  const subscribeMode = normalizeSubscribeMode(_setting(db, storeId, SETTING_KEYS.subscribeMode, 'opt_in'));
  const reg = subscribeMode === 'register_subscribe';
  return {
    enabled,
    ttl_days: ttlDays,
    max_qty: MAX_QTY,
    notify_channel_implemented: NOTIFY_CHANNEL_IMPLEMENTED,
    notify_setting_enabled: cap.send_enabled,
    notify_config_complete: cap.config_complete,
    notify_missing: cap.missing,
    notify_available: NOTIFY_CHANNEL_IMPLEMENTED && enabled && cap.notify_available,
    subscribe_mode: subscribeMode,
    consent_text: reg ? REGISTER_CONSENT_TEXT : cap.consent_text,
    consent_text_version: reg ? REGISTER_CONSENT_TEXT_VERSION : CONSENT_TEXT_VERSION,
  };
}

function maskUid(uid) {
  const s = String(uid || '');
  if (s.length <= 8) return s ? s.slice(0, 2) + '…' : '';
  return s.slice(0, 5) + '…' + s.slice(-4);
}

// 有效狀態：active 但已過期者視為 expired（讀取時不寫入）
const EFFECTIVE_STATUS_SQL = `CASE WHEN status='active' AND expires_at <= datetime('now') THEN 'expired' ELSE status END`;
const ACTIVE_WHERE = `status='active' AND expires_at > datetime('now')`;

function supportedPrefs(prod) {
  const t = Number(prod.line_takeout_enabled ?? 1) !== 0;
  const d = Number(prod.line_delivery_enabled ?? 1) !== 0;
  const out = [];
  if (t) out.push('takeout');
  if (d) out.push('delivery');
  if (t && d) out.push('any');
  return out;
}

class DemandError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 400; }
}

// 商品是否可登記：沿用既有隱藏規則，隱藏的商品不因登記功能重新曝光。
function loadEligibleProduct(db, storeId, productId) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw new DemandError('INVALID_PRODUCT', '商品不存在', 400);
  const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  if (!prod) throw new DemandError('PRODUCT_NOT_FOUND', '商品不存在', 404);
  if (Number(prod.enabled) !== 1 || Number(prod.show_on_line ?? 1) !== 1) throw new DemandError('PRODUCT_NOT_AVAILABLE', '此商品目前未在 LINE 點餐頁提供', 404);
  if (!supportedPrefs(prod).length) throw new DemandError('PRODUCT_NOT_AVAILABLE', '此商品目前未在 LINE 點餐頁提供', 404);
  if (Number(prod.demand_collect_enabled ?? 1) === 0) throw new DemandError('COLLECT_DISABLED', '此商品目前未開放補貨登記', 403);
  return prod;
}

function parseQty(v) {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_QTY) {
    throw new DemandError('INVALID_QTY', `登記份數須為 1～${MAX_QTY} 的整數`, 400);
  }
  return v;
}

// R54.4／MBV2-HF1-C6.2：reservedRaw＝本週期「訂購中」訂單綁定份數（未截斷；見 utils/demandSettlement.qtyView）
function rowOut(r, reservedRaw) {
  if (!r) return null;
  const q = DS().qtyView(r.desired_qty, r.settled_qty, reservedRaw || 0);
  return {
    request_id: r.id, request_uuid: r.request_uuid || null, product_id: r.product_id, desired_qty: Number(r.desired_qty),
    fulfillment_pref: r.fulfillment_pref, status: r.eff_status || r.status,
    created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
    // C6.2：原登記／已完成／訂購中／尚待購買（同一份定義）
    registered_qty: q.registered_qty, settled_qty: q.settled_qty, reserved_qty: q.reserved_qty, remaining_qty: q.remaining_qty, to_buy_qty: q.to_buy_qty,
    completed_at: r.completed_at || null,
  };
}
function _reserved(db, storeId, uuid) { try { return DS().reservedMap(db, storeId, [uuid]).get(String(uuid)) || 0; } catch { return 0; } }

// R54.4／MBV2-HF1-C4：通知同意綁定登記週期（request_uuid）。
//   'granted'（本週期有效）｜'revoked'｜'reconfirm_required'（匯入或舊版，需顧客重新確認）｜'none'
//   沒有 requestUuid（相容舊呼叫）時，取本人此商品目前有效週期。
function consentStatusFor(db, storeId, lineUserId, productId, requestUuid) {
  let ru = requestUuid;
  if (ru == null) {
    const r = db.get(`SELECT request_uuid FROM product_demand_requests WHERE store_id=? AND line_user_id=? AND product_id=? AND ${ACTIVE_WHERE}`,
      [storeId, lineUserId, productId]);
    if (!r) return 'none';
    ru = r.request_uuid;
  }
  let c = db.get(`SELECT status, reconfirm_required FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND request_uuid=?
                    ORDER BY id DESC LIMIT 1`, [storeId, lineUserId, productId, ru]);
  if (!c) {
    // 僅供「顯示」：C3 以前可能存在未綁定週期（request_uuid=''）的同意紀錄。沿用其狀態顯示
    // （granted 一律顯示為需重新確認）；發送資格判斷（restockNotify.cycleConsent）永遠只認綁定本週期的同意。
    const legacy = db.get(`SELECT status, 1 AS reconfirm_required FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND COALESCE(request_uuid,'')=''
                           ORDER BY id DESC LIMIT 1`, [storeId, lineUserId, productId]);
    if (legacy) c = legacy;
  }
  return RN().consentState(c);
}

// 本人有效登記（可指定商品）
function listMine(db, storeId, lineUserId, productId) {
  const params = [storeId, lineUserId];
  let extra = '';
  if (productId != null) { extra = ' AND product_id=?'; params.push(Number(productId)); }
  const rows = db.all(`SELECT *, ${EFFECTIVE_STATUS_SQL} AS eff_status FROM product_demand_requests
                       WHERE store_id=? AND line_user_id=? AND ${ACTIVE_WHERE}${extra} ORDER BY id ASC`, params);
  // R54.4／MBV2-HF1-C3.1：本人管理既有登記不受商品目前是否公開／是否收集影響。
  // 只回傳「本人自己的登記」用到的商品名稱；不會讓隱藏商品出現在公開商品列表，也不提供購買。
  // can_modify：新增／修改份數仍依最新設定（功能開關、商品可見、收集開關），由 register() 再次把關。
  const cfg = getConfig(db, storeId);
  let rmap = new Map();
  try { rmap = DS().reservedMap(db, storeId, rows.map((r) => r.request_uuid)); } catch { rmap = new Map(); }
  return rows.map((r) => {
    const prod = db.get('SELECT id, name, line_name, enabled, show_on_line, line_takeout_enabled, line_delivery_enabled, COALESCE(demand_collect_enabled,1) AS demand_collect_enabled FROM products WHERE id=? AND store_id=?', [r.product_id, storeId]);
    const visible = !!prod && Number(prod.enabled) === 1 && Number(prod.show_on_line ?? 1) === 1 && supportedPrefs(prod).length > 0;
    const canModify = cfg.enabled && visible && Number(prod.demand_collect_enabled) !== 0;
    return Object.assign(rowOut(r, rmap.get(String(r.request_uuid)) || 0), {
      product_name: prod ? String(prod.line_name || prod.name || '') : String(r.product_name_snapshot || ''),
      can_modify: canModify,
      supported_prefs: visible ? supportedPrefs(prod) : [],
      notify_consent: consentStatusFor(db, storeId, lineUserId, r.product_id, r.request_uuid),
      restock_notify: RN().requestNotifyState(db, storeId, r.request_uuid),
    });
  });
}

// ── R54.4／MBV2-HF1-C5.1：「訂閱／重新訂閱補貨通知」是獨立的同意操作 ─────────────────────────
//   - 只新增本週期的同意紀錄；不更新份數、取餐偏好、有效期限或登記週期，也不建立登記。
//   - 在同一個交易中核對：店別、後端驗證的會員、商品、指定的登記週期（request_id）仍為有效（active 且未過期）。
//     已取消、已過期、或已換成新週期 → 409 REQUEST_CHANGED，不寫入任何資料（舊表單不能復活登記或授權另一週期）。
//   - 保留訂閱方式與文案版本檢查（CONSENT_MODE_CHANGED）。本週期已有效同意時重送＝不變（不新增紀錄）。
//   - C5.2：舊版前端（register 帶 consent_action='subscribe'）沒有可驗證的週期識別時一律 409 REQUEST_CHANGED
//     （C5.1 曾以份數與偏好相同推定同一週期，會授權到「以相同內容重建」的新週期，已移除）。
function subscribe(db, storeId, lineUserId, body, opts = {}) {
  // R54.4／MBV2-HF1-C5.2：必須指定可驗證的登記週期（request_uuid；C5.1 頁面送 request_id）。
  //   - 舊版頁面（沒有週期識別）一律 409 REQUEST_CHANGED：不以商品、份數、偏好相同推定同一週期，也不由後端補入「目前有效週期」。
  //   - 在同一個交易中核對店別、後端驗證的會員、商品、週期仍為 active 且未過期；只新增該週期的同意。
  const cfg = getConfig(db, storeId);
  const pid = Number(body.product_id);
  if (!Number.isInteger(pid) || pid <= 0) throw new DemandError('INVALID_PRODUCT', '商品不存在', 400);
  const changed = () => new DemandError('REQUEST_CHANGED', '這筆補貨登記可能已在其他裝置變更、取消、過期或重新建立，請重新整理頁面並確認登記內容後再訂閱。', 409);
  const ruuid = body.request_uuid != null && body.request_uuid !== '' ? String(body.request_uuid) : null;
  const rid = body.request_id != null && body.request_id !== '' ? Number(body.request_id) : null;
  const hasRef = (ruuid && /^[0-9a-f-]{36}$/i.test(ruuid)) || (Number.isInteger(rid) && rid > 0);
  if (!hasRef) {
    if (opts.legacy) throw changed();
    throw new DemandError('INVALID_REQUEST', '缺少要訂閱的登記', 400);
  }
  if (!cfg.notify_available) {
    return { outcome: 'unchanged', request: null, consent_outcome: 'notify_unavailable', notify_available: false, subscribe_mode: cfg.subscribe_mode };
  }
  const clientMode = body.consent_mode == null || body.consent_mode === '' ? null : String(body.consent_mode);
  const clientVer = body.consent_text_version == null || body.consent_text_version === '' ? null : String(body.consent_text_version);
  if (clientMode != null && (clientMode !== cfg.subscribe_mode || (clientVer != null && clientVer !== cfg.consent_text_version))) {
    throw new DemandError('CONSENT_MODE_CHANGED', '店家已更新補貨通知的訂閱方式，請確認新的說明後再送出。', 409);
  }
  let requestRow = null;
  let consentOutcome = 'none';
  db.runDurableTransaction(() => {
    const raw = db._db;
    const one = (sql, params) => { const st = raw.prepare(sql); try { st.bind(params); return st.step() ? st.getAsObject() : null; } finally { st.free(); } };
    requestRow = ruuid
      ? one('SELECT * FROM product_demand_requests WHERE request_uuid=? AND store_id=? AND product_id=? AND line_user_id=?', [ruuid, storeId, pid, lineUserId])
      : one('SELECT * FROM product_demand_requests WHERE id=? AND store_id=? AND product_id=? AND line_user_id=?', [rid, storeId, pid, lineUserId]);
    // 同時帶 request_uuid 與 request_id 時兩者必須指向同一筆
    if (requestRow && ruuid && Number.isInteger(rid) && rid > 0 && Number(requestRow.id) !== rid) requestRow = null;
    if (!requestRow || requestRow.status !== 'active') throw changed();
    const live = one(`SELECT 1 AS x FROM product_demand_requests WHERE id=? AND ${ACTIVE_WHERE}`, [requestRow.id]);
    if (!live) throw changed();
    const cur = one(`SELECT * FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND request_uuid=? ORDER BY id DESC LIMIT 1`,
      [storeId, lineUserId, pid, requestRow.request_uuid]);
    if (cur && cur.status === 'granted' && Number(cur.reconfirm_required) !== 1) { consentOutcome = 'unchanged'; return; }
    const ver = clientMode == null ? CONSENT_TEXT_VERSION : cfg.consent_text_version;
    const txt = clientMode == null ? (RN().CONSENT_TEXT || '') : (cfg.consent_text || '');
    raw.run(`INSERT INTO product_demand_consents (consent_uuid, store_id, product_id, line_user_id, request_uuid, channel, status,
               consent_text_version, consent_text, consent_source, granted_at, created_at, updated_at)
             VALUES (?,?,?,?,?,'line','granted',?,?,'customer_subscribe',datetime('now'),datetime('now'),datetime('now'))`,
    [crypto.randomUUID(), storeId, pid, lineUserId, requestRow.request_uuid, ver, txt]);
    consentOutcome = 'granted';
  });
  const fresh = db.get(`SELECT *, ${EFFECTIVE_STATUS_SQL} AS eff_status FROM product_demand_requests WHERE id=?`, [requestRow.id]);
  const prod = db.get('SELECT id, name, line_name, enabled, show_on_line, line_takeout_enabled, line_delivery_enabled FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  const out = rowOut(fresh, _reserved(db, storeId, fresh.request_uuid));
  out.product_name = prod ? String(prod.line_name || prod.name || '') : String(fresh.product_name_snapshot || '');
  out.can_modify = true;
  out.supported_prefs = prod ? supportedPrefs(prod) : [];
  out.notify_consent = consentStatusFor(db, storeId, lineUserId, pid, fresh.request_uuid);
  out.restock_notify = RN().requestNotifyState(db, storeId, fresh.request_uuid);
  return { outcome: 'unchanged', request: out, consent_outcome: consentOutcome, notify_available: cfg.notify_available, subscribe_mode: cfg.subscribe_mode };
}

// 新增或更新本人登記（同一有效週期只有一筆）
function register(db, storeId, lineUserId, body) {
  // C5.1：舊版前端的「訂閱／重新訂閱」（consent_action='subscribe'）改走獨立同意操作，不再把表單快取的份數寫回登記
  if (body && body.consent_action === 'subscribe') {
    return subscribe(db, storeId, lineUserId, body, { legacy: true });
  }
  const cfg = getConfig(db, storeId);
  if (!cfg.enabled) throw new DemandError('FEATURE_DISABLED', '目前未開放補貨登記', 403);
  const prod = loadEligibleProduct(db, storeId, body.product_id);
  const qty = parseQty(body.desired_qty);
  const prefs = supportedPrefs(prod);
  let pref = body.fulfillment_pref == null || body.fulfillment_pref === '' ? null : String(body.fulfillment_pref);
  if (pref == null) pref = prefs.includes('any') ? 'any' : prefs[0];
  if (!PREFS.includes(pref) || !prefs.includes(pref)) throw new DemandError('INVALID_PREF', '取餐偏好不在此商品支援的方式內', 400);
  const wantConsent = body.notify_consent === true;
  const revokeConsent = body.notify_consent === false;
  const expectSettled = body.expect_settled_qty == null || body.expect_settled_qty === '' ? null : Math.trunc(Number(body.expect_settled_qty));
  // C4.5：本次授權必須對應「目前」的訂閱方式與文案版本。顧客開著表單時店家切換方式 → 拒絕（不寫入任何資料），
  // 由前端重新讀取設定、保留輸入、清楚更新提示後讓顧客再次確認。舊版前端（未帶 consent_mode）仍視為明確勾選。
  const clientMode = body.consent_mode == null || body.consent_mode === '' ? null : String(body.consent_mode);
  const clientVer = body.consent_text_version == null || body.consent_text_version === '' ? null : String(body.consent_text_version);
  const action = body.consent_action == null ? '' : String(body.consent_action);
  if (wantConsent && cfg.notify_available && clientMode != null
      && (clientMode !== cfg.subscribe_mode || (clientVer != null && clientVer !== cfg.consent_text_version))) {
    throw new DemandError('CONSENT_MODE_CHANGED', '店家已更新補貨通知的訂閱方式，請確認新的說明後再送出。', 409);
  }

  let outcome = 'created';
  let requestRow;
  let consentOutcome = 'none';
  db.runDurableTransaction(() => {
    const raw = db._db;
    // 已過期的舊登記先轉為 expired，才能開始新的有效週期
    raw.run(`UPDATE product_demand_requests SET status='expired', updated_at=datetime('now')
             WHERE store_id=? AND product_id=? AND line_user_id=? AND status='active' AND expires_at <= datetime('now')`,
    [storeId, prod.id, lineUserId]);
    const existing = db.get(`SELECT * FROM product_demand_requests WHERE store_id=? AND product_id=? AND line_user_id=? AND status='active'`,
      [storeId, prod.id, lineUserId]);
    if (existing) {
      // R54.4／MBV2-HF1-C6.2：已有訂單成立（已完成份數）的週期
      //   - 前端帶 expect_settled_qty（表單開啟時看到的已完成份數）而伺服器已不同 → 409，不寫入（避免以舊畫面計算的總份數覆寫）
      //   - 登記份數不得少於或等於已完成份數（不再需要時請取消登記）；不改動任何訂單或已扣減紀錄
      const settledNow = Math.max(0, Number(existing.settled_qty) || 0);
      if (expectSettled != null && expectSettled !== settledNow) {
        throw new DemandError('REQUEST_CHANGED', '你的已購買份數剛更新，請重新確認登記內容後再送出。', 409);
      }
      if (settledNow > 0 && qty <= settledNow) {
        throw new DemandError('QTY_NOT_ABOVE_SETTLED', `此登記已購買 ${settledNow} 份，登記份數須大於已購買份數；若不再需要，請取消登記。`, 400);
      }
      if (Number(existing.desired_qty) === qty && existing.fulfillment_pref === pref) outcome = 'unchanged';
      else {
        raw.run(`UPDATE product_demand_requests SET desired_qty=?, fulfillment_pref=?, updated_at=datetime('now') WHERE id=?`,
          [qty, pref, existing.id]);
        outcome = 'updated';
      }
      requestRow = db.get('SELECT * FROM product_demand_requests WHERE id=?', [existing.id]);
    } else {
      const cyc = db.get(`SELECT COALESCE(MAX(cycle_no),0)+1 AS n FROM product_demand_requests WHERE store_id=? AND product_id=? AND line_user_id=?`,
        [storeId, prod.id, lineUserId]);
      const uuid = crypto.randomUUID();
      raw.run(`INSERT INTO product_demand_requests
               (request_uuid, store_id, product_id, product_name_snapshot, line_user_id, desired_qty, fulfillment_pref,
                status, cycle_no, source, created_at, updated_at, expires_at)
               VALUES (?,?,?,?,?,?,?,'active',?,'line_order',datetime('now'),datetime('now'),datetime('now', ?))`,
      [uuid, storeId, prod.id, String(prod.line_name || prod.name || ''), lineUserId, qty, pref, Number(cyc.n) || 1, `+${cfg.ttl_days} days`]);
      requestRow = db.get('SELECT * FROM product_demand_requests WHERE request_uuid=?', [uuid]);
    }
    // R54.4／MBV2-HF1-C4：通知同意
    //   - 只有後端判定通知可用時，且 body.notify_consent === true（顧客明確勾選）才建立 granted。
    //   - 同意綁定本次登記週期 request_uuid；新週期不沿用上一週期的授權（上一週期的 granted 標示為 expired）。
    //   - 本週期已有有效同意時再送 true＝不變（修改份數不會被當成重新同意，也不新增同意紀錄）。
    //   - 撤回永遠允許，不受功能開關影響。
    if (outcome === 'created') {
      raw.run(`UPDATE product_demand_consents SET status='expired', ended_at=datetime('now'), updated_at=datetime('now')
               WHERE store_id=? AND line_user_id=? AND product_id=? AND status='granted' AND request_uuid<>?`,
      [storeId, lineUserId, prod.id, requestRow.request_uuid]);
    }
    // C4.5：授權來源
    //   舊版前端（未帶 consent_mode）：明確勾選 → customer_checkbox（C4 文案版本）
    //   opt_in：勾選 → customer_checkbox；「訂閱通知」按鈕 → customer_subscribe
    //   register_subscribe：新登記按「登記並通知我」→ register_submit；既有登記只有明確按「訂閱／重新訂閱通知」
    //                       （consent_action='subscribe'）才授權——單純修改份數或取餐偏好不會重新授權。
    let source = null;
    if (wantConsent && cfg.notify_available) {
      if (clientMode == null) source = 'customer_checkbox';
      else if (action === 'subscribe') source = 'customer_subscribe';
      else if (cfg.subscribe_mode === 'opt_in') source = 'customer_checkbox';
      else if (outcome === 'created' && action === 'register_subscribe') source = 'register_submit';
    }
    if (wantConsent && cfg.notify_available && !source) {
      consentOutcome = 'not_applied';
    } else if (wantConsent && cfg.notify_available) {
      const cur = db.get(`SELECT * FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND request_uuid=?
                          ORDER BY id DESC LIMIT 1`, [storeId, lineUserId, prod.id, requestRow.request_uuid]);
      if (cur && cur.status === 'granted' && Number(cur.reconfirm_required) !== 1) {
        consentOutcome = 'unchanged';
      } else {
        const ver = clientMode == null ? CONSENT_TEXT_VERSION : cfg.consent_text_version;
        const txt = clientMode == null ? (RN().CONSENT_TEXT || '') : (cfg.consent_text || '');
        raw.run(`INSERT INTO product_demand_consents (consent_uuid, store_id, product_id, line_user_id, request_uuid, channel, status,
                   consent_text_version, consent_text, consent_source, granted_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,'line','granted',?,?,?,datetime('now'),datetime('now'),datetime('now'))`,
        [crypto.randomUUID(), storeId, prod.id, lineUserId, requestRow.request_uuid, ver, txt, source]);
        consentOutcome = 'granted';
      }
    } else if (wantConsent && !cfg.notify_available) {
      consentOutcome = 'notify_unavailable';
    } else if (revokeConsent) {
      raw.run(`UPDATE product_demand_consents SET status='revoked', revoked_at=datetime('now'), updated_at=datetime('now')
               WHERE store_id=? AND line_user_id=? AND product_id=? AND status='granted'`, [storeId, lineUserId, prod.id]);
      consentOutcome = 'revoked';
    }
  });
  const out = rowOut(requestRow, _reserved(db, storeId, requestRow.request_uuid));
  out.product_name = String(prod.line_name || prod.name || '');
  out.can_modify = true;
  out.supported_prefs = prefs;
  out.notify_consent = consentStatusFor(db, storeId, lineUserId, prod.id, requestRow.request_uuid);
  out.restock_notify = RN().requestNotifyState(db, storeId, requestRow.request_uuid);
  return { outcome, request: out, consent_outcome: consentOutcome, notify_available: cfg.notify_available, subscribe_mode: cfg.subscribe_mode };
}

// 取消本人登記（只能取消自己的、同店別的有效登記）；同時撤回該商品的通知同意
function cancel(db, storeId, lineUserId, body) {
  const rid = body.request_id != null ? Number(body.request_id) : null;
  const pid = body.product_id != null ? Number(body.product_id) : null;
  if (!(Number.isInteger(rid) && rid > 0) && !(Number.isInteger(pid) && pid > 0)) throw new DemandError('INVALID_REQUEST', '缺少要取消的登記', 400);
  let row;
  if (Number.isInteger(rid) && rid > 0) {
    row = db.get(`SELECT * FROM product_demand_requests WHERE id=? AND store_id=? AND line_user_id=? AND ${ACTIVE_WHERE}`, [rid, storeId, lineUserId]);
  } else {
    row = db.get(`SELECT * FROM product_demand_requests WHERE product_id=? AND store_id=? AND line_user_id=? AND ${ACTIVE_WHERE}`, [pid, storeId, lineUserId]);
  }
  if (!row) throw new DemandError('NOT_FOUND', '找不到可取消的登記', 404);
  db.runDurableTransaction(() => {
    const raw = db._db;
    raw.run(`UPDATE product_demand_requests SET status='cancelled', cancelled_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND status='active'`, [row.id]);
    raw.run(`UPDATE product_demand_consents SET status='revoked', revoked_at=datetime('now'), updated_at=datetime('now')
             WHERE store_id=? AND line_user_id=? AND product_id=? AND status='granted'`, [storeId, lineUserId, row.product_id]);
  });
  return { cancelled: true, request_id: row.id, product_id: row.product_id };
}

// 撤回通知同意（不影響想買登記本身）
function revokeConsent(db, storeId, lineUserId, body) {
  const pid = Number(body.product_id);
  if (!Number.isInteger(pid) || pid <= 0) throw new DemandError('INVALID_PRODUCT', '商品不存在', 400);
  let changed = 0;
  db.runDurableTransaction(() => {
    db._db.run(`UPDATE product_demand_consents SET status='revoked', revoked_at=datetime('now'), updated_at=datetime('now')
                WHERE store_id=? AND line_user_id=? AND product_id=? AND status='granted'`, [storeId, lineUserId, pid]);
    changed = db._db.getRowsModified();
  });
  return { revoked: changed > 0, notify_consent: consentStatusFor(db, storeId, lineUserId, pid) };
  // 撤回不改變「本週期已通知」的事實（restock_notify_deliveries 不受影響）
}

// ── 後台 ──────────────────────────────────────────────────────────────
// 商品需求清單：LINE 可見商品＋任何有登記紀錄的商品。統計排除取消與過期。
function adminSummary(db, storeId) {
  const prods = db.all(`SELECT id, name, line_name, enabled, show_on_line, sale_status, line_takeout_enabled, line_delivery_enabled,
                               COALESCE(demand_collect_enabled,1) AS demand_collect_enabled
                        FROM products WHERE store_id=? ORDER BY sort_order, id`, [storeId]);
  const agg = db.all(`SELECT product_id, COUNT(DISTINCT line_user_id) AS active_users, COALESCE(SUM(desired_qty),0) AS total_qty,
                             MAX(updated_at) AS last_updated_at
                      FROM product_demand_requests WHERE store_id=? AND ${ACTIVE_WHERE} GROUP BY product_id`, [storeId]);
  const hist = db.all(`SELECT product_id, COUNT(*) AS all_rows FROM product_demand_requests WHERE store_id=? GROUP BY product_id`, [storeId]);
  const aggMap = new Map(agg.map((a) => [Number(a.product_id), a]));
  const histMap = new Map(hist.map((h) => [Number(h.product_id), Number(h.all_rows)]));
  // R54.4／MBV2-HF1-C6.2：有效登記的份數拆分（原登記＝total_qty；已完成／訂購中／尚待購買）與已完成週期數（歷史）
  const qmap = settlementByProduct(db, storeId);
  const out = [];
  for (const p of prods) {
    const visible = Number(p.enabled) === 1 && Number(p.show_on_line ?? 1) === 1 && supportedPrefs(p).length > 0;
    const a = aggMap.get(Number(p.id));
    const allRows = histMap.get(Number(p.id)) || 0;
    if (!visible && !allRows) continue;
    out.push({
      product_id: p.id, name: p.line_name || p.name, sale_status: p.sale_status || 'available',
      enabled: Number(p.enabled), show_on_line: Number(p.show_on_line ?? 1), line_visible: visible,
      demand_collect_enabled: Number(p.demand_collect_enabled) !== 0 ? 1 : 0,
      active_users: a ? Number(a.active_users) : 0, total_qty: a ? Number(a.total_qty) : 0,
      last_updated_at: a ? a.last_updated_at : null, history_rows: allRows,
      ...(qmap.get(Number(p.id)) || { settled_qty: 0, reserved_qty: 0, to_buy_qty: a ? Number(a.total_qty) : 0, completed_requests: 0 }),
    });
  }
  return { config: getConfig(db, storeId), products: out };
}

// R54.4／MBV2-HF1-C6.2：每個商品（有效登記）的已完成／訂購中／尚待購買份數，以及已完成週期數（歷史，不計入有效需求）
function settlementByProduct(db, storeId) {
  const out = new Map();
  let act = [];
  try {
    act = db.all(`SELECT product_id, request_uuid, desired_qty, COALESCE(settled_qty,0) AS settled_qty FROM product_demand_requests WHERE store_id=? AND ${ACTIVE_WHERE}`, [storeId]);
  } catch { return out; }
  let rmap = new Map();
  try { rmap = DS().reservedMap(db, storeId, act.map((r) => r.request_uuid)); } catch { rmap = new Map(); }
  for (const r of act) {
    const q = DS().qtyView(r.desired_qty, r.settled_qty, rmap.get(String(r.request_uuid)) || 0);
    const cur = out.get(Number(r.product_id)) || { settled_qty: 0, reserved_qty: 0, to_buy_qty: 0, completed_requests: 0 };
    cur.settled_qty += q.settled_qty; cur.reserved_qty += q.reserved_qty; cur.to_buy_qty += q.to_buy_qty;
    out.set(Number(r.product_id), cur);
  }
  try {
    for (const c of db.all("SELECT product_id, COUNT(*) AS n FROM product_demand_requests WHERE store_id=? AND status='completed' GROUP BY product_id", [storeId])) {
      const cur = out.get(Number(c.product_id)) || { settled_qty: 0, reserved_qty: 0, to_buy_qty: 0, completed_requests: 0 };
      cur.completed_requests = Number(c.n) || 0;
      out.set(Number(c.product_id), cur);
    }
  } catch { /* 欄位尚未遷移 */ }
  return out;
}

// R54.4／MBV2-HF1-C6.2：本人已完成的登記（歷史，最近 90 天，最多 20 筆）；不影響有效登記清單
function listMineCompleted(db, storeId, lineUserId) {
  const rows = db.all(`SELECT * FROM product_demand_requests WHERE store_id=? AND line_user_id=? AND status='completed'
                       AND COALESCE(completed_at, updated_at) >= datetime('now','-90 days') ORDER BY COALESCE(completed_at, updated_at) DESC, id DESC LIMIT 20`, [storeId, lineUserId]);
  return rows.map((r) => {
    const prod = db.get('SELECT name, line_name FROM products WHERE id=? AND store_id=?', [r.product_id, storeId]);
    const o = rowOut(r, 0);
    return { product_id: o.product_id, product_name: prod ? String(prod.line_name || prod.name || '') : String(r.product_name_snapshot || ''),
      status: 'completed', registered_qty: o.registered_qty, settled_qty: o.settled_qty, completed_at: o.completed_at, created_at: o.created_at };
  });
}

function adminDetail(db, storeId, productId) {
  const pid = Number(productId);
  const p = db.get('SELECT id, name, line_name, sale_status, enabled, show_on_line, COALESCE(demand_collect_enabled,1) AS demand_collect_enabled FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  if (!p) throw new DemandError('PRODUCT_NOT_FOUND', '商品不存在', 404);
  const rows = db.all(`SELECT r.*, CASE WHEN r.status='active' AND r.expires_at <= datetime('now') THEN 'expired' ELSE r.status END AS eff_status,
                              m.display_name AS member_display_name
                       FROM product_demand_requests r
                       LEFT JOIN line_members m ON m.store_id=r.store_id AND m.line_user_id=r.line_user_id
                       WHERE r.store_id=? AND r.product_id=? ORDER BY r.id DESC LIMIT 500`, [storeId, pid]);
  const active = rows.filter((r) => r.eff_status === 'active');
  let rmap = new Map();
  try { rmap = DS().reservedMap(db, storeId, rows.map((r) => r.request_uuid)); } catch { rmap = new Map(); }
  const qv = (r) => DS().qtyView(r.desired_qty, r.settled_qty, r.eff_status === 'active' ? (rmap.get(String(r.request_uuid)) || 0) : 0);
  const sumActive = (k) => active.reduce((s, r) => s + qv(r)[k], 0);
  return {
    product: { product_id: p.id, name: p.line_name || p.name, sale_status: p.sale_status || 'available', demand_collect_enabled: Number(p.demand_collect_enabled) !== 0 ? 1 : 0 },
    active_users: new Set(active.map((r) => r.line_user_id)).size,
    total_qty: active.reduce((s, r) => s + Number(r.desired_qty || 0), 0),
    // C6.2：有效登記的份數拆分；已完成週期另計（歷史）
    settled_qty: sumActive('settled_qty'), reserved_qty: sumActive('reserved_qty'), to_buy_qty: sumActive('to_buy_qty'),
    completed_requests: rows.filter((r) => r.eff_status === 'completed').length,
    rows: rows.map((r) => ({
      request_id: r.id, member: maskUid(r.line_user_id), member_display_name: r.member_display_name || '',
      desired_qty: Number(r.desired_qty), fulfillment_pref: r.fulfillment_pref, status: r.eff_status,
      created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at, cancelled_at: r.cancelled_at || '',
      notify_consent: consentStatusFor(db, storeId, r.line_user_id, pid, r.request_uuid),
      restock_notify: RN().requestNotifyState(db, storeId, r.request_uuid),
      ...(() => { const q = qv(r); return { settled_qty: q.settled_qty, reserved_qty: q.reserved_qty, to_buy_qty: q.to_buy_qty, completed_at: r.completed_at || null }; })(),
    })),
  };
}

function setProductCollect(db, storeId, productId, enabled) {
  const pid = Number(productId);
  const p = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  if (!p) throw new DemandError('PRODUCT_NOT_FOUND', '商品不存在', 404);
  db.run('UPDATE products SET demand_collect_enabled=? WHERE id=? AND store_id=?', [enabled ? 1 : 0, pid, storeId]);
  return { product_id: pid, demand_collect_enabled: enabled ? 1 : 0 };
}

function setSettings(db, storeId, body) {
  const upd = {};
  if (body.enabled !== undefined) upd[SETTING_KEYS.enabled] = body.enabled === true || body.enabled === 1 || body.enabled === '1' ? '1' : '0';
  if (body.ttl_days !== undefined) {
    const n = Math.trunc(Number(body.ttl_days));
    if (!Number.isFinite(n) || n < MIN_TTL_DAYS || n > MAX_TTL_DAYS) throw new DemandError('INVALID_TTL', `有效天數須為 ${MIN_TTL_DAYS}～${MAX_TTL_DAYS}`, 400);
    upd[SETTING_KEYS.ttlDays] = String(n);
  }
  // C4：補貨通知發送開關寫入 restock_notify_enabled（C3 舊鍵 product_demand_notify_enabled 不再生效）
  if (body.notify_enabled !== undefined) upd[RN().SEND_SETTING_KEY] = body.notify_enabled === true || body.notify_enabled === 1 || body.notify_enabled === '1' ? '1' : '0';
  // C4.5：消費者訂閱方式（與發送總開關分開保存；不修改任何既有同意紀錄）
  if (body.subscribe_mode !== undefined) {
    if (!SUBSCRIBE_MODES.includes(String(body.subscribe_mode))) throw new DemandError('INVALID_SUBSCRIBE_MODE', '訂閱方式不正確', 400);
    upd[SETTING_KEYS.subscribeMode] = String(body.subscribe_mode);
  }
  db.runDurableTransaction(() => {
    for (const [k, v] of Object.entries(upd)) {
      db._db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, k, v]);
    }
  });
  return getConfig(db, storeId);
}

module.exports = {
  MAX_QTY, DEFAULT_TTL_DAYS, NOTIFY_CHANNEL_IMPLEMENTED, CONSENT_TEXT_VERSION, SETTING_KEYS,
  SUBSCRIBE_MODES, REGISTER_CONSENT_TEXT, REGISTER_CONSENT_TEXT_VERSION, normalizeSubscribeMode,
  DemandError, migrate, getConfig, listMine, listMineCompleted, settlementByProduct, register, subscribe, cancel, revokeConsent,
  adminSummary, adminDetail, setProductCollect, setSettings, maskUid, supportedPrefs,
};
