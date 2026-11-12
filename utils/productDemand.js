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

const SETTING_KEYS = {
  enabled: 'product_demand_enabled',            // '1'＝顯示想買登記入口（預設開啟）
  ttlDays: 'product_demand_ttl_days',           // 登記有效天數（預設 30）
  notifyEnabled: 'product_demand_notify_enabled', // C3 舊鍵：C4 起不再作為發送開關（避免升級後自動啟用）
};
function RN() { return require('./restockNotify'); }

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
  return {
    enabled,
    ttl_days: ttlDays,
    max_qty: MAX_QTY,
    notify_channel_implemented: NOTIFY_CHANNEL_IMPLEMENTED,
    notify_setting_enabled: cap.send_enabled,
    notify_config_complete: cap.config_complete,
    notify_missing: cap.missing,
    notify_available: NOTIFY_CHANNEL_IMPLEMENTED && enabled && cap.notify_available,
    consent_text: cap.consent_text,
    consent_text_version: CONSENT_TEXT_VERSION,
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
  if (Number(prod.demand_collect_enabled ?? 1) === 0) throw new DemandError('COLLECT_DISABLED', '此商品目前未開放想買登記', 403);
  return prod;
}

function parseQty(v) {
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) v = Number(v.trim());
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > MAX_QTY) {
    throw new DemandError('INVALID_QTY', `想買份數須為 1～${MAX_QTY} 的整數`, 400);
  }
  return v;
}

function rowOut(r) {
  if (!r) return null;
  return {
    request_id: r.id, product_id: r.product_id, desired_qty: Number(r.desired_qty),
    fulfillment_pref: r.fulfillment_pref, status: r.eff_status || r.status,
    created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at,
  };
}

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
  return rows.map((r) => {
    const prod = db.get('SELECT id, name, line_name, enabled, show_on_line, line_takeout_enabled, line_delivery_enabled, COALESCE(demand_collect_enabled,1) AS demand_collect_enabled FROM products WHERE id=? AND store_id=?', [r.product_id, storeId]);
    const visible = !!prod && Number(prod.enabled) === 1 && Number(prod.show_on_line ?? 1) === 1 && supportedPrefs(prod).length > 0;
    const canModify = cfg.enabled && visible && Number(prod.demand_collect_enabled) !== 0;
    return Object.assign(rowOut(r), {
      product_name: prod ? String(prod.line_name || prod.name || '') : String(r.product_name_snapshot || ''),
      can_modify: canModify,
      supported_prefs: visible ? supportedPrefs(prod) : [],
      notify_consent: consentStatusFor(db, storeId, lineUserId, r.product_id, r.request_uuid),
      restock_notify: RN().requestNotifyState(db, storeId, r.request_uuid),
    });
  });
}

// 新增或更新本人登記（同一有效週期只有一筆）
function register(db, storeId, lineUserId, body) {
  const cfg = getConfig(db, storeId);
  if (!cfg.enabled) throw new DemandError('FEATURE_DISABLED', '目前未開放想買登記', 403);
  const prod = loadEligibleProduct(db, storeId, body.product_id);
  const qty = parseQty(body.desired_qty);
  const prefs = supportedPrefs(prod);
  let pref = body.fulfillment_pref == null || body.fulfillment_pref === '' ? null : String(body.fulfillment_pref);
  if (pref == null) pref = prefs.includes('any') ? 'any' : prefs[0];
  if (!PREFS.includes(pref) || !prefs.includes(pref)) throw new DemandError('INVALID_PREF', '取餐偏好不在此商品支援的方式內', 400);
  const wantConsent = body.notify_consent === true;
  const revokeConsent = body.notify_consent === false;

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
    if (wantConsent && cfg.notify_available) {
      const cur = db.get(`SELECT * FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND request_uuid=?
                          ORDER BY id DESC LIMIT 1`, [storeId, lineUserId, prod.id, requestRow.request_uuid]);
      if (cur && cur.status === 'granted' && Number(cur.reconfirm_required) !== 1) {
        consentOutcome = 'unchanged';
      } else {
        raw.run(`INSERT INTO product_demand_consents (consent_uuid, store_id, product_id, line_user_id, request_uuid, channel, status,
                   consent_text_version, consent_text, consent_source, granted_at, created_at, updated_at)
                 VALUES (?,?,?,?,?,'line','granted',?,?,'customer_checkbox',datetime('now'),datetime('now'),datetime('now'))`,
        [crypto.randomUUID(), storeId, prod.id, lineUserId, requestRow.request_uuid, CONSENT_TEXT_VERSION, cfg.consent_text || '']);
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
  const out = rowOut(requestRow);
  out.product_name = String(prod.line_name || prod.name || '');
  out.can_modify = true;
  out.supported_prefs = prefs;
  out.notify_consent = consentStatusFor(db, storeId, lineUserId, prod.id, requestRow.request_uuid);
  out.restock_notify = RN().requestNotifyState(db, storeId, requestRow.request_uuid);
  return { outcome, request: out, consent_outcome: consentOutcome, notify_available: cfg.notify_available };
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
    });
  }
  return { config: getConfig(db, storeId), products: out };
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
  return {
    product: { product_id: p.id, name: p.line_name || p.name, sale_status: p.sale_status || 'available', demand_collect_enabled: Number(p.demand_collect_enabled) !== 0 ? 1 : 0 },
    active_users: new Set(active.map((r) => r.line_user_id)).size,
    total_qty: active.reduce((s, r) => s + Number(r.desired_qty || 0), 0),
    rows: rows.map((r) => ({
      request_id: r.id, member: maskUid(r.line_user_id), member_display_name: r.member_display_name || '',
      desired_qty: Number(r.desired_qty), fulfillment_pref: r.fulfillment_pref, status: r.eff_status,
      created_at: r.created_at, updated_at: r.updated_at, expires_at: r.expires_at, cancelled_at: r.cancelled_at || '',
      notify_consent: consentStatusFor(db, storeId, r.line_user_id, pid, r.request_uuid),
      restock_notify: RN().requestNotifyState(db, storeId, r.request_uuid),
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
  db.runDurableTransaction(() => {
    for (const [k, v] of Object.entries(upd)) {
      db._db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, k, v]);
    }
  });
  return getConfig(db, storeId);
}

module.exports = {
  MAX_QTY, DEFAULT_TTL_DAYS, NOTIFY_CHANNEL_IMPLEMENTED, CONSENT_TEXT_VERSION, SETTING_KEYS,
  DemandError, migrate, getConfig, listMine, register, cancel, revokeConsent,
  adminSummary, adminDetail, setProductCollect, setSettings, maskUid, supportedPrefs,
};
