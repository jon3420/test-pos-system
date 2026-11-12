// utils/restockNotify.js — R54.4／MBV2-HF1-C4：LINE 補貨通知（店家手動批次）
//
// 範圍：顧客主動訂閱（product_demand_consents，綁定登記週期 request_uuid）→ 店家預覽 →
//       店家按「確認發送」→ 逐筆以 utils/linePush.js 送出（固定 X-Line-Retry-Key）→
//       顧客點商品直達連結（product_uuid）→ 依現有流程下單。
// 不做：自動補貨觸發、排程、群發、轉換歸因。修改庫存／商品狀態不會觸發任何訊息。
//
// 防重（全部靠資料庫，不靠前端或記憶體）：
//   - restock_notify_deliveries 的部分唯一索引 (store_id, request_uuid) WHERE claim=1：
//     同一登記週期（request_uuid）在所有批次中最多只有一筆「占用通知名額」的紀錄。
//   - 批次狀態以單一 UPDATE … WHERE status=? 原子轉移（previewed→sending、paused→sending），
//     連點、兩位管理員同時確認、重送相同請求都只會有一次生效。
//   - 每筆發送前，先在 durable transaction 內把 pending/retry_wait 原子改成 sending、
//     attempt_count+1、寫入首次嘗試時間，落地後才呼叫 LINE；網路呼叫不在交易內。
//   - retry_key 在建立逐筆紀錄時產生並保存，之後所有重試、續送都沿用同一把 key。
//
// 狀態語意：accepted＝「LINE API 已受理」（HTTP 200 或官方 retry-key 已受理的 409），
// 不代表顧客已收到或已讀。結果不明（逾時、連線中斷、送出後服務中斷）不視為沒送出。
'use strict';

const crypto = require('crypto');
const linePushModule = require('./linePush');

const CONSENT_TEXT_VERSION = 'restock-notify-c4-v1';
const CONSENT_TEXT = '商品恢復供應或開放預購時，透過 LINE 通知我。';
const LEGACY_CONSENT_VERSIONS = ['restock-notify-v1', ''];
const SEND_SETTING_KEY = 'restock_notify_enabled'; // C4 新增；預設 '0'（安裝或升級後不會自動啟用）
const PREVIEW_TTL_MINUTES = 30;
// LINE 官方：retry key 自第一次請求起 24 小時內有效。保留 1 小時安全邊界。
const RETRY_KEY_VALID_HOURS = 24;
const RETRY_WINDOW_MS = (RETRY_KEY_VALID_HOURS - 1) * 3600e3;

function envInt(name, def, min, max) {
  const n = Math.trunc(Number(process.env[name]));
  if (!Number.isFinite(n) || process.env[name] === undefined || process.env[name] === '') return def;
  return Math.min(max, Math.max(min, n));
}
function maxAttempts() { return envInt('RESTOCK_NOTIFY_MAX_ATTEMPTS', 4, 1, 10); }
function backoffMs(attempt) {
  // 第 n 次失敗後的等待（毫秒）。可用 RESTOCK_NOTIFY_BACKOFF_MS="2000,10000,30000" 調整。
  const raw = String(process.env.RESTOCK_NOTIFY_BACKOFF_MS || '2000,10000,30000');
  const arr = raw.split(',').map((x) => Math.max(0, Math.trunc(Number(x)))).filter((x) => Number.isFinite(x));
  const list = arr.length ? arr : [2000, 10000, 30000];
  return list[Math.min(attempt - 1, list.length - 1)];
}
function inRunWaitLimitMs() { return envInt('RESTOCK_NOTIFY_MAX_INLINE_WAIT_MS', 60000, 0, 600000); }
function lineTimeoutMs() { return envInt('RESTOCK_NOTIFY_LINE_TIMEOUT_MS', 8000, 500, 30000); }
function sendIntervalMs() { return envInt('RESTOCK_NOTIFY_SEND_INTERVAL_MS', 100, 0, 5000); }

// ── 時間（資料庫以 UTC 'YYYY-MM-DD HH:MM:SS' 保存，與 datetime('now') 一致）──
function utcStr(ms) { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); }
function nowStr() { return utcStr(Date.now()); }
function parseUtc(s) { if (!s) return NaN; return Date.parse(String(s).replace(' ', 'T') + 'Z'); }

// ── raw helpers（可在交易內使用）──
function rawAll(raw, sql, params) {
  const st = raw.prepare(sql);
  try { if (params && params.length) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; }
  finally { st.free(); }
}
function rawGet(raw, sql, params) { return rawAll(raw, sql, params)[0] || null; }
function rawRun(raw, sql, params) { raw.run(sql, params || []); return raw.getRowsModified(); }
function colNames(raw, table) {
  try { return rawAll(raw, `PRAGMA table_info(${table})`).map((c) => c.name); } catch { return []; }
}

// ══════════════════════════════════════════════════════════════════════
//  Schema（向前相容：只 CREATE IF NOT EXISTS／ALTER ADD COLUMN）
// ══════════════════════════════════════════════════════════════════════
function migrate(raw) {
  // 1. 商品穩定識別（商品直達連結用；備份還原後數字 ID 改變或被占用時仍能正確對應）
  const pcols = colNames(raw, 'products');
  if (pcols.length && !pcols.includes('product_uuid')) raw.run('ALTER TABLE products ADD COLUMN product_uuid TEXT DEFAULT NULL');
  if (pcols.length) {
    raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_products_store_uuid ON products(store_id, product_uuid)
             WHERE product_uuid IS NOT NULL AND product_uuid <> ''`);
    backfillProductUuids(raw);
  }

  // 2. 通知同意：補欄位（同意來源、完整文案、需重新確認、週期結束時間）
  const ccols = colNames(raw, 'product_demand_consents');
  if (ccols.length) {
    const add = (c, def) => { if (!ccols.includes(c)) raw.run(`ALTER TABLE product_demand_consents ADD COLUMN ${c} ${def}`); };
    add('reconfirm_required', 'INTEGER NOT NULL DEFAULT 0');
    add('consent_source', "TEXT DEFAULT ''");
    add('consent_text', "TEXT DEFAULT ''");
    add('ended_at', "TEXT DEFAULT ''");
    add('import_source', "TEXT DEFAULT ''");
    raw.run('CREATE INDEX IF NOT EXISTS idx_pdc_store_request ON product_demand_consents(store_id, request_uuid)');
    // C3 以前的版本沒有可用的通知能力，不可能產生有效同意；若資料中存在舊版文案的 granted，
    // 一律標示為「需重新確認」，不得自動變成可發送授權。
    raw.run(`UPDATE product_demand_consents SET reconfirm_required=1
             WHERE status='granted' AND reconfirm_required=0 AND COALESCE(consent_text_version,'') IN (${LEGACY_CONSENT_VERSIONS.map(() => '?').join(',')})`,
    LEGACY_CONSENT_VERSIONS);
  }

  // 3. 批次
  raw.run(`CREATE TABLE IF NOT EXISTS restock_notify_batches (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_uuid            TEXT NOT NULL,
    store_id              TEXT NOT NULL,
    product_id            INTEGER NOT NULL,
    product_uuid          TEXT DEFAULT '',
    product_name_snapshot TEXT DEFAULT '',
    fulfillment_mode      TEXT NOT NULL,
    supply_date           TEXT NOT NULL,
    notice_kind           TEXT NOT NULL,
    message_text          TEXT NOT NULL,
    link_url              TEXT NOT NULL,
    message_hash          TEXT NOT NULL,
    status                TEXT NOT NULL DEFAULT 'previewed',
    preview_json          TEXT DEFAULT '{}',
    candidate_count       INTEGER NOT NULL DEFAULT 0,
    created_by            TEXT DEFAULT '',
    confirmed_by          TEXT DEFAULT '',
    pause_reason          TEXT DEFAULT '',
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now')),
    preview_expires_at    TEXT DEFAULT NULL,
    confirmed_at          TEXT DEFAULT NULL,
    completed_at          TEXT DEFAULT NULL,
    import_source         TEXT DEFAULT ''
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnb_uuid ON restock_notify_batches(batch_uuid)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rnb_store_product ON restock_notify_batches(store_id, product_id, id)');

  // 4. 逐筆發送紀錄
  raw.run(`CREATE TABLE IF NOT EXISTS restock_notify_deliveries (
    id                    INTEGER PRIMARY KEY AUTOINCREMENT,
    delivery_uuid         TEXT NOT NULL,
    batch_uuid            TEXT NOT NULL,
    store_id              TEXT NOT NULL,
    product_id            INTEGER NOT NULL,
    request_uuid          TEXT NOT NULL,
    cycle_no              INTEGER DEFAULT NULL,
    consent_uuid          TEXT DEFAULT '',
    line_user_id          TEXT NOT NULL,
    retry_key             TEXT DEFAULT NULL,
    claim                 INTEGER DEFAULT NULL,
    status                TEXT NOT NULL,
    exclusion_reason      TEXT DEFAULT '',
    attempt_count         INTEGER NOT NULL DEFAULT 0,
    max_attempts          INTEGER NOT NULL DEFAULT 4,
    first_attempt_at      TEXT DEFAULT NULL,
    last_attempt_at       TEXT DEFAULT NULL,
    next_attempt_at       TEXT DEFAULT NULL,
    accepted_at           TEXT DEFAULT NULL,
    last_http_status      INTEGER DEFAULT NULL,
    error_code            TEXT DEFAULT '',
    line_request_id       TEXT DEFAULT '',
    accepted_request_id   TEXT DEFAULT '',
    created_at            TEXT DEFAULT (datetime('now')),
    updated_at            TEXT DEFAULT (datetime('now')),
    import_source         TEXT DEFAULT ''
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnd_uuid ON restock_notify_deliveries(delivery_uuid)');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnd_retry_key ON restock_notify_deliveries(retry_key) WHERE retry_key IS NOT NULL');
  // 同一店別、同一登記週期，最多一筆占用通知名額的紀錄（跨批次、跨管理員、跨重啟）
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnd_cycle_claim ON restock_notify_deliveries(store_id, request_uuid) WHERE claim=1');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnd_batch_request ON restock_notify_deliveries(batch_uuid, request_uuid)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rnd_batch_status ON restock_notify_deliveries(batch_uuid, status)');
}

function backfillProductUuids(raw) {
  const rows = rawAll(raw, "SELECT id FROM products WHERE product_uuid IS NULL OR product_uuid=''");
  for (const r of rows) raw.run('UPDATE products SET product_uuid=? WHERE id=?', [crypto.randomUUID(), r.id]);
  return rows.length;
}

// R54.4／MBV2-HF1-C4.1：同店同週期已有已受理證據（不論 claim）時，本地尚未完成的其他工作一律停止並標示「本週期已通知」。
// 匯入（同一交易內）與服務啟動時執行，讓既有 C4 資料與剛匯入的歷史立即受到保護；不刪列、不改 retry key、不動已受理列。
function blockConflictsRaw(raw, storeId) {
  const params = [];
  let scope = '';
  if (storeId) { scope = ' AND d.store_id=?'; params.push(storeId); }
  const rowsC = rawAll(raw, `SELECT d.* FROM restock_notify_deliveries d
                             WHERE d.status IN ('pending','retry_wait','held','unknown')${scope}
                               AND EXISTS (SELECT 1 FROM restock_notify_deliveries a WHERE a.store_id=d.store_id AND a.request_uuid=d.request_uuid
                                           AND a.status='accepted' AND a.delivery_uuid<>d.delivery_uuid)`, params);
  let n = 0;
  for (const r of rowsC) n += blockRowRaw(raw, r, 'already_notified');
  return n;
}

// 服務啟動時：上次執行中被中斷的發送不得自動續送。
//   - 逐筆 sending（已落地、已可能交給 LINE、尚未寫回結果）→ unknown（結果待確認）
//   - 批次 sending → paused（須由店家明確續送）
// 只改狀態，不呼叫任何外部 API。
function recoverInterruptedOnBoot(raw) {
  const n = rawRun(raw, `UPDATE restock_notify_deliveries SET status='unknown', error_code='interrupted', updated_at=datetime('now')
                         WHERE status='sending'`);
  const b = rawRun(raw, `UPDATE restock_notify_batches SET status='paused', pause_reason='server_restart', updated_at=datetime('now')
                         WHERE status='sending'`);
  const conflicts = blockConflictsRaw(raw, null);
  return { deliveries: n, batches: b, conflicts };
}

// ══════════════════════════════════════════════════════════════════════
//  設定與能力
// ══════════════════════════════════════════════════════════════════════
function _setting(db, storeId, key, def) {
  const r = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return r && r.value != null && r.value !== '' ? String(r.value) : def;
}
function storeDisplayName(db, storeId) {
  const s = _setting(db, storeId, 'shop_name', '');
  if (s) return s;
  try { const r = db.get('SELECT store_name FROM stores WHERE store_id=?', [storeId]); if (r && r.store_name) return String(r.store_name); } catch {}
  return storeId;
}
function getCapability(db, storeId) {
  const sendEnabled = _setting(db, storeId, SEND_SETTING_KEY, '0') === '1';
  const demandEnabled = _setting(db, storeId, 'product_demand_enabled', '1') === '1';
  const token = _setting(db, storeId, 'line_channel_token', '');
  const liff = _setting(db, storeId, 'line_member_liff_id', '');
  const missing = [];
  if (!demandEnabled) missing.push('demand_disabled');
  if (!token) missing.push('line_channel_token');
  if (!liff) missing.push('line_member_liff_id');
  const complete = missing.length === 0;
  return {
    code_implemented: true,
    send_enabled: sendEnabled,
    config_complete: complete,
    missing,
    token_configured: !!token,
    // 只檢查權杖「存在」，從未以 API 驗證，因此不得標示為已驗證可發送
    token_verified: false,
    link_configured: !!liff,
    notify_available: sendEnabled && complete,
    consent_text: CONSENT_TEXT,
    consent_text_version: CONSENT_TEXT_VERSION,
  };
}
function setSendEnabled(db, storeId, enabled) {
  db.runDurableTransaction(() => {
    db._db.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, SEND_SETTING_KEY, enabled ? '1' : '0']);
  });
  return getCapability(db, storeId);
}

// ══════════════════════════════════════════════════════════════════════
//  商品穩定識別與直達連結
// ══════════════════════════════════════════════════════════════════════
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function ensureProductUuidRaw(raw, storeId, productId) {
  const p = rawGet(raw, 'SELECT product_uuid FROM products WHERE id=? AND store_id=?', [productId, storeId]);
  if (!p) return null;
  if (p.product_uuid) return String(p.product_uuid);
  const u = crypto.randomUUID();
  raw.run('UPDATE products SET product_uuid=? WHERE id=? AND store_id=?', [u, productId, storeId]);
  return u;
}
function buildProductLink(db, storeId, productUuid, mode, date) {
  const liff = _setting(db, storeId, 'line_member_liff_id', '');
  if (!liff || !productUuid) return null;
  const q = new URLSearchParams({ store_id: storeId, product_ref: productUuid, src: 'restock', m: mode, d: date });
  return `https://liff.line.me/${encodeURIComponent(liff)}?${q.toString()}`;
}
// 公開端點：以穩定識別找到商品；只回傳目前仍在 LINE 公開的商品 ID（不回傳其他資料）
function resolveProductRef(db, storeId, ref) {
  const s = String(ref || '').trim();
  if (!UUID_RE.test(s)) return { found: false, reason: 'invalid_ref' };
  const p = db.get('SELECT id, enabled, show_on_line, line_takeout_enabled, line_delivery_enabled FROM products WHERE store_id=? AND product_uuid=?', [storeId, s]);
  if (!p) return { found: false, reason: 'not_found' };
  const visible = Number(p.enabled) === 1 && Number(p.show_on_line ?? 1) === 1
    && (Number(p.line_takeout_enabled ?? 1) !== 0 || Number(p.line_delivery_enabled ?? 1) !== 0);
  if (!visible) return { found: false, reason: 'not_available' };
  return { found: true, product_id: Number(p.id) };
}

// ══════════════════════════════════════════════════════════════════════
//  訊息
// ══════════════════════════════════════════════════════════════════════
const WEEK = ['日', '一', '二', '三', '四', '五', '六'];
function fmtDateZh(ymd) {
  const [y, m, d] = String(ymd).split('-').map(Number);
  const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return `${m}/${d}（週${WEEK[w]}）`;
}
const MODE_LABEL = { takeout: '外帶自取', delivery: '外送' };
const DISCLAIMER = '數量有限，實際供應以系統為準；本通知不代表訂單成立，也不保留商品。';
function buildMessage({ storeName, productName, noticeKind, mode, date, link }) {
  const head = noticeKind === 'preorder' ? '你登記的商品已開放預購' : '你登記的商品已恢復供應';
  return [
    `【${storeName}】${head}`,
    `商品：${productName}`,
    `${noticeKind === 'preorder' ? '預購日期' : '供應日期'}：${fmtDateZh(date)}`,
    `取餐方式：${MODE_LABEL[mode] || mode}`,
    `查看商品並訂購：${link}`,
    DISCLAIMER,
    '如不想再收到此商品的通知，可在點餐頁「我的想買登記」取消。',
  ].join('\n');
}
function sha256(s) { return crypto.createHash('sha256').update(String(s)).digest('hex'); }

// ══════════════════════════════════════════════════════════════════════
//  資格（預覽、確認、每筆發送前共用同一套判斷）
// ══════════════════════════════════════════════════════════════════════
class RestockError extends Error {
  constructor(code, message, status) { super(message); this.code = code; this.status = status || 400; }
}
function orderability(db, storeId, productId, mode, date) {
  // 沿用 routes/line-orders.js 的既有販售／額度／營業判斷（唯讀）
  const { evaluateProductOrderability } = require('../routes/line-orders');
  return evaluateProductOrderability(db, storeId, productId, mode, date);
}
function getFriendStatusSafe(db, storeId, uid) {
  // 沿用 Recovery 使用的可信好友來源（line_members.is_friend）；封鎖視同非好友
  const { getFriendStatus } = require('./cartRecoveryDelivery');
  const st = getFriendStatus(db, storeId, uid);
  if (st === 'friend') {
    try { const m = db.get('SELECT is_blocked FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, uid]); if (m && Number(m.is_blocked) === 1) return 'not_friend'; } catch {}
  }
  return st;
}
// 本週期的有效同意（必須綁定同一 request_uuid、同一商品、未撤回、不需重新確認）
function cycleConsent(db, storeId, req) {
  return db.get(`SELECT * FROM product_demand_consents WHERE store_id=? AND line_user_id=? AND product_id=? AND request_uuid=?
                 ORDER BY id DESC LIMIT 1`, [storeId, req.line_user_id, req.product_id, req.request_uuid]) || null;
}
function consentState(c) {
  if (!c) return 'none';
  if (c.status === 'granted') return Number(c.reconfirm_required) === 1 ? 'reconfirm_required' : 'granted';
  if (c.status === 'revoked') return 'revoked';
  return c.status || 'none';
}
// 「目前由哪一筆工作占用名額」（claim=1，部分唯一索引保證同店同週期最多一筆）
function claimFor(db, storeId, requestUuid) {
  return db.get('SELECT batch_uuid, delivery_uuid, status FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND claim=1', [storeId, requestUuid]) || null;
}
// R54.4／MBV2-HF1-C4.1：「本週期是否已有通知證據」與名額占用分開判斷，不看 claim。
//   accepted：同店同週期任一列 status='accepted'（不論 claim 是否為 NULL、不論來自本地或匯入的批次）
//   attempted：同店同週期「其他」列曾交給 LINE（attempt_count>0）且不是確定失敗（failed）→ 可能已受理，
//              不得再用另一把 retry key 送出。
//   ownDelivery：排除正在處理的這一筆本身（它自己的重試沿用同一把 key，由次數／時間窗另外控管）。
function cycleEvidence(db, storeId, requestUuid, ownDelivery) {
  const own = String(ownDelivery || '');
  const acc = db.get(`SELECT delivery_uuid FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND status='accepted' AND delivery_uuid<>? LIMIT 1`,
    [storeId, requestUuid, own]);
  if (acc) return 'accepted';
  const att = db.get(`SELECT delivery_uuid FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND delivery_uuid<>? AND attempt_count>0 AND status<>'failed' LIMIT 1`,
    [storeId, requestUuid, own]);
  if (att) return 'attempted';
  return 'none';
}
// 回傳 { ok, reason, consent_uuid }；reason 為固定代碼
function evaluateRecipient(db, storeId, req, mode, opts = {}) {
  if (!req) return { ok: false, reason: 'not_found' };
  if (req.status === 'cancelled') return { ok: false, reason: 'cancelled' };
  const exp = parseUtc(req.expires_at);
  if (req.status === 'expired' || (req.status === 'active' && Number.isFinite(exp) && exp <= Date.now())) return { ok: false, reason: 'expired' };
  if (req.status !== 'active') return { ok: false, reason: 'not_active' };
  if (!opts.ignoreClaim) {
    const ev = cycleEvidence(db, storeId, req.request_uuid, opts.ownDelivery);
    if (ev === 'accepted') return { ok: false, reason: 'already_notified' };
    if (ev === 'attempted') return { ok: false, reason: 'possibly_notified' };
    const c = claimFor(db, storeId, req.request_uuid);
    if (c && (!opts.ownBatch || c.batch_uuid !== opts.ownBatch)) return { ok: false, reason: c.status === 'accepted' ? 'already_notified' : 'in_other_batch' };
  }
  const cs = cycleConsent(db, storeId, req);
  const st = consentState(cs);
  if (st === 'none') return { ok: false, reason: 'no_consent' };
  if (st === 'revoked') return { ok: false, reason: 'consent_revoked' };
  if (st === 'reconfirm_required') return { ok: false, reason: 'consent_reconfirm_required' };
  if (st !== 'granted') return { ok: false, reason: 'no_consent' };
  if (!(req.fulfillment_pref === 'any' || req.fulfillment_pref === mode)) return { ok: false, reason: 'pref_mismatch' };
  const member = db.get('SELECT id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, req.line_user_id]);
  if (!member) return { ok: false, reason: 'member_not_found' };
  const fs = getFriendStatusSafe(db, storeId, req.line_user_id);
  if (fs === 'not_friend') return { ok: false, reason: 'not_friend' };
  if (fs !== 'friend') return { ok: false, reason: 'friend_unknown' };
  return { ok: true, reason: null, consent_uuid: cs.consent_uuid };
}

const EXCLUSION_KEYS = ['already_notified', 'possibly_notified', 'in_other_batch', 'no_consent', 'consent_revoked', 'consent_reconfirm_required',
  'expired', 'cancelled', 'not_active', 'not_friend', 'friend_unknown', 'member_not_found', 'pref_mismatch', 'collect_disabled', 'product_not_orderable', 'config_incomplete'];
// 這些原因代表「本週期不得再以任何 key 發送／此批次內容不可再用」，手動續送不會恢復
const PERMANENT_BLOCK = ['already_notified', 'possibly_notified', 'link_mismatch'];
// 曾交給 LINE 但結果不明的錯誤代碼（被擋下時保留「結果待確認」狀態，而不是改成未送出）
const UNKNOWN_RESULT_CODES = ['timeout', 'network_error', 'server_error', 'interrupted', 'conflict_unclassified', 'imported_unfinished', 'retry_window_expired'];

// R54.4／MBV2-HF1-C4.1：商品層級的發送閘門＝收集開關（關閉後不可再發出新的補貨通知）＋既有可訂購判斷
function productGate(db, storeId, productId, mode, date) {
  const p = db.get('SELECT demand_collect_enabled FROM products WHERE id=? AND store_id=?', [Number(productId), storeId]);
  if (p && Number(p.demand_collect_enabled ?? 1) === 0) return { ok: false, reason: 'collect_disabled', message: '商品已關閉想買登記收集' };
  return orderability(db, storeId, productId, mode, date);
}
const gateReason = (g) => (g.reason === 'collect_disabled' ? 'collect_disabled' : 'product_not_orderable');

// R54.4／MBV2-HF1-C4.1：批次的訊息快照與連結必須屬於「目前」店別、LIFF、指定商品與供應情境。
// 跨店匯入、同店還原後 LIFF 或商品識別改變時不相符 → 不可直接續送（也不可修改原訊息沿用原 key）。
function batchContext(db, storeId, b) {
  const p = db.get('SELECT product_uuid FROM products WHERE id=? AND store_id=?', [Number(b.product_id), storeId]);
  if (!p) return { ok: false, detail: 'product_missing' };
  if (!p.product_uuid || String(p.product_uuid) !== String(b.product_uuid || '')) return { ok: false, detail: 'product_ref_changed' };
  const expected = buildProductLink(db, storeId, String(p.product_uuid), b.fulfillment_mode, b.supply_date);
  if (!expected || expected !== b.link_url) return { ok: false, detail: 'link_changed' };
  if (sha256(b.message_text) !== b.message_hash || !String(b.message_text).includes(b.link_url)) return { ok: false, detail: 'message_snapshot_invalid' };
  return { ok: true };
}
const CONTEXT_MISMATCH_MSG = '此批次的商品連結或店別設定與目前不符（可能由其他店別匯入，或 LIFF／商品識別已變更），已停止續送。從未送出的項目已作廢並釋放名額，請重新預覽後再確認發送；已送出或結果不明的項目保留原紀錄，不會改訊息或換新 key 補送。';
// 不相符時：從未交給 LINE 的未完成項目作廢並釋放名額；曾嘗試／結果不明者原樣保留（含 claim 與 retry key）；
// 批次改為終止狀態 cancelled（pause_reason='link_mismatch'）保留歷史——任何版本（含回退後的 C4）都不會再續送這份舊訊息。
function voidMismatchedBatchRaw(raw, batchUuid) {
  rawRun(raw, `UPDATE restock_notify_deliveries SET status='blocked', exclusion_reason='link_mismatch', claim=NULL, updated_at=datetime('now')
               WHERE batch_uuid=? AND status IN ('pending','retry_wait','held') AND attempt_count=0`, [batchUuid]);
  rawRun(raw, `UPDATE restock_notify_batches SET status='cancelled', pause_reason='link_mismatch', updated_at=datetime('now')
               WHERE batch_uuid=? AND status IN ('paused','sending','completed')`, [batchUuid]);
}
// 發送前重新檢查不通過時的落地方式
function blockRowRaw(raw, row, reason) {
  if (Number(row.attempt_count) === 0 && PERMANENT_BLOCK.includes(reason)) {
    // 本週期已有通知證據：擋下但「保留」名額（舊版程式只認 claim，回退後也不會再把這個週期排入新批次）
    return rawRun(raw, `UPDATE restock_notify_deliveries SET status='blocked', exclusion_reason=?, next_attempt_at=NULL, updated_at=datetime('now')
                        WHERE id=? AND status IN ('pending','retry_wait','held','unknown')`, [reason, row.id]);
  }
  if (Number(row.attempt_count) === 0) {
    // 從未交給 LINE：擋下並釋放週期名額（已受理證據另有紀錄時，名額釋放不影響防重）
    return rawRun(raw, `UPDATE restock_notify_deliveries SET status='blocked', exclusion_reason=?, claim=NULL, updated_at=datetime('now')
                        WHERE id=? AND status IN ('pending','retry_wait','held','unknown')`, [reason, row.id]);
  }
  // 曾交給 LINE：保留名額與 retry key；結果不明者維持「結果待確認」，其餘標示擋下
  const st = UNKNOWN_RESULT_CODES.includes(String(row.error_code || '')) ? 'unknown' : 'blocked';
  return rawRun(raw, `UPDATE restock_notify_deliveries SET status=?, exclusion_reason=?, next_attempt_at=NULL, updated_at=datetime('now')
                      WHERE id=? AND status IN ('pending','retry_wait','held','unknown')`, [st, reason, row.id]);
}

function validateTarget(db, storeId, body) {
  const pid = Number(body.product_id);
  if (!Number.isInteger(pid) || pid <= 0) throw new RestockError('INVALID_PRODUCT', '請選擇商品', 400);
  const mode = body.fulfillment_mode;
  if (mode !== 'takeout' && mode !== 'delivery') throw new RestockError('INVALID_MODE', '請選擇外帶自取或外送', 400);
  const date = String(body.supply_date || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T00:00:00Z'))) throw new RestockError('INVALID_DATE', '供應日期格式錯誤', 400);
  const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  if (!prod) throw new RestockError('PRODUCT_NOT_FOUND', '商品不存在', 404);
  return { pid, mode, date, prod };
}

// ══════════════════════════════════════════════════════════════════════
//  預覽（伺服器計算名單並保存批次；名單之後不再擴充）
// ══════════════════════════════════════════════════════════════════════
function computePreview(db, storeId, target) {
  const { pid, mode, date, prod } = target;
  const cap = getCapability(db, storeId);
  const ord = productGate(db, storeId, pid, mode, date);
  const collect = Number(prod.demand_collect_enabled ?? 1) !== 0;
  // 每位會員只看最新一個登記週期（避免把舊週期的取消／過期與目前有效登記重複計算）
  const all = db.all(`SELECT r.* FROM product_demand_requests r
                      WHERE r.store_id=? AND r.product_id=? AND r.id = (
                        SELECT r2.id FROM product_demand_requests r2 WHERE r2.store_id=r.store_id AND r2.product_id=r.product_id
                          AND r2.line_user_id=r.line_user_id ORDER BY r2.cycle_no DESC, r2.id DESC LIMIT 1)
                      ORDER BY r.id ASC`, [storeId, pid]);
  const exclusions = Object.fromEntries(EXCLUSION_KEYS.map((k) => [k, 0]));
  const candidates = [];
  let activeUsers = 0, totalQty = 0, consentedUsers = 0, eligibleQty = 0;
  for (const r of all) {
    const isActive = r.status === 'active' && parseUtc(r.expires_at) > Date.now();
    if (isActive) { activeUsers++; totalQty += Number(r.desired_qty) || 0; }
    const ev = evaluateRecipient(db, storeId, r, mode);
    if (isActive && ['granted'].includes(consentState(cycleConsent(db, storeId, r)))) consentedUsers++;
    if (!ev.ok) { exclusions[ev.reason] = (exclusions[ev.reason] || 0) + 1; continue; }
    if (!ord.ok) { exclusions[gateReason(ord)]++; continue; }
    if (!cap.notify_available) { exclusions.config_incomplete++; continue; }
    candidates.push(r.request_uuid);
    eligibleQty += Number(r.desired_qty) || 0;
  }
  return { cap, ord, collect, activeUsers, totalQty, consentedUsers, eligibleQty, exclusions, candidates };
}

function previewBatch(db, storeId, body, actor) {
  const target = validateTarget(db, storeId, body);
  const { pid, mode, date, prod } = target;
  const pv = computePreview(db, storeId, target);
  const storeName = storeDisplayName(db, storeId);
  const productName = String((prod.line_name || '').trim() || prod.name || '');
  const noticeKind = pv.ord.ok ? pv.ord.notice_kind : (date > require('../routes/line-orders').twDateStr() ? 'preorder' : 'restock');
  const blockers = [];
  if (!pv.cap.send_enabled) blockers.push('send_disabled');
  if (!pv.cap.config_complete) blockers.push('config_incomplete');
  if (!pv.ord.ok) blockers.push(gateReason(pv.ord));
  if (!pv.candidates.length) blockers.push('no_eligible_recipient');
  let batchUuid = null, link = null, message = null, expiresAt = null;
  db.runDurableTransaction(() => {
    const raw = db._db;
    const productUuid = ensureProductUuidRaw(raw, storeId, pid);
    link = buildProductLink(db, storeId, productUuid, mode, date);
    message = buildMessage({ storeName, productName, noticeKind, mode, date, link: link || '（連結設定不完整）' });
    if (blockers.length || !link) return;
    batchUuid = crypto.randomUUID();
    expiresAt = utcStr(Date.now() + PREVIEW_TTL_MINUTES * 60e3);
    const stats = {
      active_users: pv.activeUsers, total_qty: pv.totalQty, consented_users: pv.consentedUsers,
      eligible_count: pv.candidates.length, eligible_qty: pv.eligibleQty, exclusions: pv.exclusions,
      orderability: pv.ord,
    };
    raw.run(`INSERT INTO restock_notify_batches (batch_uuid, store_id, product_id, product_uuid, product_name_snapshot, fulfillment_mode,
               supply_date, notice_kind, message_text, link_url, message_hash, status, preview_json, candidate_count, created_by,
               created_at, updated_at, preview_expires_at)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,'previewed',?,?,?,datetime('now'),datetime('now'),?)`,
    [batchUuid, storeId, pid, productUuid, productName, mode, date, noticeKind, message, link, sha256(message),
      JSON.stringify({ stats, candidates: pv.candidates }), pv.candidates.length, String(actor || ''), expiresAt]);
  });
  const remaining = pv.ord.ok ? pv.ord.remaining : null;
  return {
    batch_uuid: batchUuid,
    can_send: !!batchUuid,
    blockers,
    capability: pv.cap,
    product: { product_id: pid, name: productName, sale_status: prod.sale_status || 'available', demand_collect_enabled: pv.collect ? 1 : 0 },
    fulfillment_mode: mode, supply_date: date, notice_kind: noticeKind,
    orderability: pv.ord,
    stats: {
      active_users: pv.activeUsers, total_qty: pv.totalQty, consented_users: pv.consentedUsers,
      eligible_count: pv.candidates.length, eligible_qty: pv.eligibleQty, exclusions: pv.exclusions,
      available_qty: remaining, // null＝額度未設上限
      available_less_than_desired: remaining != null && remaining < pv.totalQty,
    },
    message_text: message,
    link_url: link,
    preview_expires_at: expiresAt,
    note: '期望總份數只是需求統計，不代表訂單或庫存保留。',
  };
}

// ══════════════════════════════════════════════════════════════════════
//  確認發送（原子轉移；建立逐筆紀錄並占用週期名額；之後才在背景逐筆送出）
// ══════════════════════════════════════════════════════════════════════
const activeWorkers = new Map(); // batch_uuid → Promise（同一程序內避免重複執行；跨重啟由資料庫狀態把關）

function getBatchRow(db, storeId, batchUuid) {
  const b = db.get('SELECT * FROM restock_notify_batches WHERE batch_uuid=? AND store_id=?', [String(batchUuid || ''), storeId]);
  if (!b) throw new RestockError('BATCH_NOT_FOUND', '找不到此通知批次', 404);
  return b;
}

function confirmBatch(db, storeId, batchUuid, actor, opts = {}) {
  const b0 = getBatchRow(db, storeId, batchUuid);
  if (b0.status !== 'previewed') {
    return { batch_uuid: b0.batch_uuid, already: true, status: b0.status, message: '此批次已確認過，不會重複建立發送' };
  }
  const cap = getCapability(db, storeId);
  if (!cap.notify_available) throw new RestockError('NOTIFY_UNAVAILABLE', '補貨通知未啟用或必要設定不完整', 409);
  // C4.1：預覽之後若 LIFF／商品識別改變，這份訊息快照就不能再用 → 作廢預覽、要求重新預覽
  const ctxChk = batchContext(db, storeId, b0);
  if (!ctxChk.ok) {
    db.runDurableTransaction(() => { rawRun(db._db, "UPDATE restock_notify_batches SET status='expired', pause_reason='link_mismatch', updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'", [b0.batch_uuid]); });
    throw new RestockError('BATCH_CONTEXT_MISMATCH', '預覽後商品連結或店別設定已改變，請重新預覽後再確認發送', 409);
  }
  let result = null;
  db.runDurableTransaction(() => {
    const raw = db._db;
    // 原子轉移：只有一個請求能把 previewed 改成 sending
    const changed = rawRun(raw, `UPDATE restock_notify_batches SET status='sending', confirmed_by=?, confirmed_at=datetime('now'), updated_at=datetime('now')
                                 WHERE batch_uuid=? AND store_id=? AND status='previewed' AND preview_expires_at > datetime('now')`,
    [String(actor || ''), b0.batch_uuid, storeId]);
    if (changed !== 1) {
      const cur = rawGet(raw, 'SELECT status, preview_expires_at FROM restock_notify_batches WHERE batch_uuid=?', [b0.batch_uuid]);
      if (cur && cur.status === 'previewed') {
        rawRun(raw, "UPDATE restock_notify_batches SET status='expired', updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'", [b0.batch_uuid]);
        result = { expired: true };
      } else result = { already: true, status: cur && cur.status };
      return;
    }
    const ord = productGate(db, storeId, b0.product_id, b0.fulfillment_mode, b0.supply_date);
    const pj = JSON.parse(b0.preview_json || '{}');
    const cands = Array.isArray(pj.candidates) ? pj.candidates : [];
    let queued = 0, excluded = 0;
    for (const ru of cands) {
      const req = rawGet(raw, 'SELECT * FROM product_demand_requests WHERE store_id=? AND request_uuid=? AND product_id=?', [storeId, ru, b0.product_id]);
      let ev = req ? evaluateRecipient(db, storeId, req, b0.fulfillment_mode) : { ok: false, reason: 'not_found' };
      if (ev.ok && !ord.ok) ev = { ok: false, reason: gateReason(ord) };
      const base = [crypto.randomUUID(), b0.batch_uuid, storeId, b0.product_id, ru, req ? req.cycle_no : null, req ? req.line_user_id : ''];
      if (!ev.ok) {
        raw.run(`INSERT INTO restock_notify_deliveries (delivery_uuid, batch_uuid, store_id, product_id, request_uuid, cycle_no, line_user_id,
                   status, exclusion_reason, max_attempts) VALUES (?,?,?,?,?,?,?,'excluded',?,?)`, [...base, ev.reason, maxAttempts()]);
        excluded++; continue;
      }
      try {
        raw.run(`INSERT INTO restock_notify_deliveries (delivery_uuid, batch_uuid, store_id, product_id, request_uuid, cycle_no, line_user_id,
                   consent_uuid, retry_key, claim, status, max_attempts) VALUES (?,?,?,?,?,?,?,?,?,1,'pending',?)`,
        [...base, ev.consent_uuid || '', crypto.randomUUID(), maxAttempts()]);
        queued++;
      } catch (e) {
        if (!/UNIQUE/i.test(String(e && e.message))) throw e;
        // 唯一限制：同週期已有其他批次占用 → 只記錄排除，不建立第二筆有效發送
        raw.run(`INSERT INTO restock_notify_deliveries (delivery_uuid, batch_uuid, store_id, product_id, request_uuid, cycle_no, line_user_id,
                   status, exclusion_reason, max_attempts) VALUES (?,?,?,?,?,?,?,'excluded','in_other_batch',?)`, [...base, maxAttempts()]);
        excluded++;
      }
    }
    if (!queued) rawRun(raw, "UPDATE restock_notify_batches SET status='completed', completed_at=datetime('now'), updated_at=datetime('now') WHERE batch_uuid=?", [b0.batch_uuid]);
    result = { queued, excluded };
  });
  if (result && result.expired) throw new RestockError('PREVIEW_EXPIRED', '預覽已逾時，請重新預覽後再確認發送', 409);
  if (result && result.already) return { batch_uuid: b0.batch_uuid, already: true, status: result.status, message: '此批次已確認過，不會重複建立發送' };
  if (result.queued && opts.startWorker !== false) startWorker(db, storeId, b0.batch_uuid);
  return { batch_uuid: b0.batch_uuid, already: false, queued: result.queued, excluded: result.excluded, status: result.queued ? 'sending' : 'completed' };
}

// ══════════════════════════════════════════════════════════════════════
//  逐筆送出（背景；網路呼叫不在交易內）
// ══════════════════════════════════════════════════════════════════════
function startWorker(db, storeId, batchUuid) {
  if (activeWorkers.has(batchUuid)) return activeWorkers.get(batchUuid);
  const p = (async () => {
    try { await runBatch(db, storeId, batchUuid); }
    catch (e) {
      console.warn('[restockNotify] worker error:', e && e.message);
      try { db.runDurableTransaction(() => { db._db.run("UPDATE restock_notify_batches SET status='paused', pause_reason='worker_error', updated_at=datetime('now') WHERE batch_uuid=? AND status='sending'", [batchUuid]); }); } catch {}
    } finally { activeWorkers.delete(batchUuid); }
  })();
  activeWorkers.set(batchUuid, p);
  return p;
}
function waitForWorker(batchUuid) { return activeWorkers.get(batchUuid) || Promise.resolve(); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function runBatch(db, storeId, batchUuid) {
  let pauseReason = '';
  const startedAt = Date.now();
  const skip = new Set(); // 同一輪內無法取得發送資格的列，不再重複選取（避免忙迴圈）
  // C4.1：已用完總次數（自動重試＋手動續送）的列不得再被選取；舊資料中仍為待重試者改為結果待確認（保留原錯誤代碼）
  db.runDurableTransaction(() => {
    rawRun(db._db, `UPDATE restock_notify_deliveries SET status='unknown', next_attempt_at=NULL, updated_at=datetime('now')
                    WHERE batch_uuid=? AND status IN ('pending','retry_wait') AND attempt_count>0 AND attempt_count >= max_attempts`, [batchUuid]);
  });
  for (;;) {
    const b = db.get('SELECT * FROM restock_notify_batches WHERE batch_uuid=? AND store_id=?', [batchUuid, storeId]);
    if (!b || b.status !== 'sending') return; // 被取消或暫停
    // C4.1：訊息快照與連結必須屬於目前店別／LIFF／商品／供應情境；不符即作廢未送出項目並暫停
    if (!batchContext(db, storeId, b).ok) {
      db.runDurableTransaction(() => { voidMismatchedBatchRaw(db._db, batchUuid); });
      return;
    }
    const now = nowStr();
    const skipIds = [...skip];
    const due = db.get(`SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND store_id=? AND status IN ('pending','retry_wait')
                        AND attempt_count < max_attempts AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
                        ${skipIds.length ? `AND id NOT IN (${skipIds.map(() => '?').join(',')})` : ''} ORDER BY id ASC LIMIT 1`, [batchUuid, storeId, now, ...skipIds]);
    if (!due) {
      const waiting = db.get(`SELECT MIN(next_attempt_at) AS t FROM restock_notify_deliveries WHERE batch_uuid=? AND status='retry_wait' AND attempt_count < max_attempts`, [batchUuid]);
      const t = waiting && waiting.t ? parseUtc(waiting.t) : NaN;
      if (Number.isFinite(t) && (t - Date.now()) <= inRunWaitLimitMs() && (Date.now() - startedAt) < 10 * 60e3) {
        await sleep(Math.max(50, t - Date.now() + 20));
        continue;
      }
      if (Number.isFinite(t)) pauseReason = 'retry_pending';
      break;
    }
    // ── 發送前重新檢查（同步；與預覽、確認、續送使用同一套判斷）──
    const cap = getCapability(db, storeId);
    if (!cap.notify_available) { pauseReason = cap.send_enabled ? 'config_incomplete' : 'send_disabled'; break; }
    const req = db.get('SELECT * FROM product_demand_requests WHERE store_id=? AND request_uuid=?', [storeId, due.request_uuid]);
    let ev = evaluateRecipient(db, storeId, req, b.fulfillment_mode, { ownBatch: batchUuid, ownDelivery: due.delivery_uuid });
    if (ev.ok && req.product_id !== b.product_id) ev = { ok: false, reason: 'not_found' };
    if (ev.ok) {
      const gate = productGate(db, storeId, b.product_id, b.fulfillment_mode, b.supply_date);
      if (!gate.ok) ev = { ok: false, reason: gate.reason === 'collect_disabled' ? 'collect_disabled' : 'product_not_orderable:' + gate.reason };
    }
    if (ev.ok && due.first_attempt_at && Date.now() - parseUtc(due.first_attempt_at) > RETRY_WINDOW_MS) ev = { ok: false, reason: 'retry_window_expired' };
    if (!ev.ok) {
      db.runDurableTransaction(() => {
        const raw = db._db;
        if (ev.reason === 'retry_window_expired') {
          rawRun(raw, `UPDATE restock_notify_deliveries SET status='unknown', error_code='retry_window_expired', updated_at=datetime('now')
                       WHERE id=? AND status IN ('pending','retry_wait')`, [due.id]);
        } else {
          blockRowRaw(raw, due, ev.reason);
        }
      });
      skip.add(due.id);
      continue;
    }
    // ── 落地「正在送出」後才呼叫 LINE ──
    let claimed = false;
    db.runDurableTransaction(() => {
      claimed = rawRun(db._db, `UPDATE restock_notify_deliveries SET status='sending', attempt_count=attempt_count+1,
                                 first_attempt_at=COALESCE(first_attempt_at, datetime('now')), last_attempt_at=datetime('now'),
                                 next_attempt_at=NULL, updated_at=datetime('now')
                                 WHERE id=? AND status IN ('pending','retry_wait') AND retry_key IS NOT NULL
                                   AND attempt_count < max_attempts`, [due.id]) === 1;
    });
    if (!claimed) { skip.add(due.id); continue; }
    const row = db.get('SELECT * FROM restock_notify_deliveries WHERE id=?', [due.id]);
    const token = _setting(db, storeId, 'line_channel_token', '');
    const res = await linePushModule.sendLinePush({
      channelAccessToken: token,
      lineUserId: row.line_user_id,
      messages: [{ type: 'text', text: b.message_text }],
      retryKey: row.retry_key,
      timeoutMs: lineTimeoutMs(),
      detailed: true,
    });
    const stop = applyResult(db, row, res, b);
    if (stop) { pauseReason = stop; break; }
    if (sendIntervalMs()) await sleep(sendIntervalMs());
  }
  finalizeBatch(db, storeId, batchUuid, pauseReason);
}

// 寫回單筆結果；回傳非空字串代表整批需暫停（權杖／額度／未設定）
function applyResult(db, row, res, batch) {
  const cls = (res && res.result_class) || 'unknown_retryable';
  const http = Number(res && res.status) || null;
  const reqId = (res && res.request_id) || '';
  const accId = (res && res.accepted_request_id) || '';
  const code = String((res && res.error_code) || '').slice(0, 40);
  let stop = '';
  db.runDurableTransaction(() => {
    const raw = db._db;
    const upd = (sql, p) => rawRun(raw, sql, p);
    if (cls === 'accepted' || cls === 'accepted_conflict') {
      upd(`UPDATE restock_notify_deliveries SET status='accepted', accepted_at=datetime('now'), last_http_status=?, error_code=?,
             line_request_id=?, accepted_request_id=?, updated_at=datetime('now') WHERE id=? AND status='sending'`,
      [http, cls === 'accepted_conflict' ? 'retry_key_already_accepted' : '', reqId, accId || (cls === 'accepted' ? reqId : ''), row.id]);
      // 只記錄資訊欄位；不改登記狀態（status 仍為 active，唯一限制不受影響）
      upd(`UPDATE product_demand_requests SET notified_at=COALESCE(notified_at, datetime('now')) WHERE store_id=? AND request_uuid=?`, [row.store_id, row.request_uuid]);
      return;
    }
    const attempts = Number(row.attempt_count) || 1;
    const withinWindow = !row.first_attempt_at || (Date.now() - parseUtc(row.first_attempt_at)) <= RETRY_WINDOW_MS;
    if (cls === 'unknown_retryable' || cls === 'rate_limited') {
      if (attempts < (Number(row.max_attempts) || maxAttempts()) && withinWindow) {
        upd(`UPDATE restock_notify_deliveries SET status='retry_wait', next_attempt_at=?, last_http_status=?, error_code=?, line_request_id=?,
               updated_at=datetime('now') WHERE id=? AND status='sending'`, [utcStr(Date.now() + backoffMs(attempts)), http, code, reqId, row.id]);
      } else {
        // 已達上限：逾時／5xx → 結果不明；429 速率限制 → 確定未受理，保留待店家續送
        const st = cls === 'rate_limited' ? 'held' : 'unknown';
        upd(`UPDATE restock_notify_deliveries SET status=?, last_http_status=?, error_code=?, line_request_id=?, updated_at=datetime('now')
               WHERE id=? AND status='sending'`, [st, http, code, reqId, row.id]);
      }
      return;
    }
    if (cls === 'quota' || cls === 'auth' || cls === 'not_configured') {
      upd(`UPDATE restock_notify_deliveries SET status='held', last_http_status=?, error_code=?, line_request_id=?, updated_at=datetime('now')
             WHERE id=? AND status='sending'`, [http, code || cls, reqId, row.id]);
      stop = cls === 'quota' ? 'monthly_limit' : (cls === 'auth' ? 'auth_error' : 'not_configured');
      return;
    }
    if (cls === 'unknown_final') {
      upd(`UPDATE restock_notify_deliveries SET status='unknown', last_http_status=?, error_code=?, line_request_id=?, updated_at=datetime('now')
             WHERE id=? AND status='sending'`, [http, code, reqId, row.id]);
      return;
    }
    // rejected／invalid_input：確定未受理，且重試不會改變結果
    upd(`UPDATE restock_notify_deliveries SET status='failed', last_http_status=?, error_code=?, line_request_id=?, updated_at=datetime('now')
           WHERE id=? AND status='sending'`, [http, code || cls, reqId, row.id]);
  });
  void batch;
  return stop;
}

function finalizeBatch(db, storeId, batchUuid, pauseReason) {
  db.runDurableTransaction(() => {
    const raw = db._db;
    // C4.1：已用完總次數的 held 不算「待處理」（不會再被續送），避免批次永遠停在暫停
    const open = rawGet(raw, `SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE batch_uuid=?
                              AND (status IN ('pending','retry_wait','sending') OR (status='held' AND attempt_count < max_attempts))`, [batchUuid]);
    if (pauseReason || (open && Number(open.c) > 0)) {
      rawRun(raw, `UPDATE restock_notify_batches SET status='paused', pause_reason=?, updated_at=datetime('now') WHERE batch_uuid=? AND status='sending'`,
        [pauseReason || 'retry_pending', batchUuid]);
    } else {
      rawRun(raw, `UPDATE restock_notify_batches SET status='completed', pause_reason='', completed_at=datetime('now'), updated_at=datetime('now')
                   WHERE batch_uuid=? AND status='sending'`, [batchUuid]);
    }
  });
}

// ══════════════════════════════════════════════════════════════════════
//  店家明確續送／取消
// ══════════════════════════════════════════════════════════════════════
// 續送規則（C4.1）：
//   - 批次內容（訊息快照＋連結）必須屬於目前店別／LIFF／商品，否則從未嘗試者作廢、其餘保留並拒絕續送（409）。
//   - 只恢復「沿用原逐筆紀錄與原 retry key」的項目：held／unknown 且 attempt_count < max_attempts（總上限，含手動續送）
//     且首次嘗試仍在 23 小時時間窗內，且沒有永久阻擋原因（已通知／可能已通知／連結不符）。
//   - 恢復前以與預覽、確認、送出前相同的判斷重新檢查；不符者立即擋下並標示原因。
function resumeBatch(db, storeId, batchUuid, actor, opts = {}) {
  const b0 = getBatchRow(db, storeId, batchUuid);
  if (activeWorkers.has(b0.batch_uuid) || b0.status === 'sending') return { batch_uuid: b0.batch_uuid, already: true, status: 'sending' };
  if (b0.status === 'cancelled' && b0.pause_reason === 'link_mismatch') throw new RestockError('BATCH_CONTEXT_MISMATCH', CONTEXT_MISMATCH_MSG, 409);
  if (!['paused', 'completed'].includes(b0.status)) throw new RestockError('BATCH_NOT_RESUMABLE', '此批次目前不可續送', 409);
  const cap = getCapability(db, storeId);
  if (!cap.notify_available) throw new RestockError('NOTIFY_UNAVAILABLE', '補貨通知未啟用或必要設定不完整', 409);
  if (!batchContext(db, storeId, b0).ok) {
    db.runDurableTransaction(() => { voidMismatchedBatchRaw(db._db, b0.batch_uuid); });
    throw new RestockError('BATCH_CONTEXT_MISMATCH', CONTEXT_MISMATCH_MSG, 409);
  }
  let resumed = 0, ok = false, blocked = 0;
  db.runDurableTransaction(() => {
    const raw = db._db;
    const cutoff = utcStr(Date.now() - RETRY_WINDOW_MS);
    // 舊資料：已用完次數卻仍為待發送／待重試 → 結果待確認（保留原錯誤代碼）
    rawRun(raw, `UPDATE restock_notify_deliveries SET status='unknown', next_attempt_at=NULL, updated_at=datetime('now')
                 WHERE batch_uuid=? AND status IN ('pending','retry_wait') AND attempt_count>0 AND attempt_count >= max_attempts`, [b0.batch_uuid]);
    // 超過有效期限的結果不明項目：標示，不換新 key、不補送
    rawRun(raw, `UPDATE restock_notify_deliveries SET error_code='retry_window_expired', updated_at=datetime('now')
                 WHERE batch_uuid=? AND status='unknown' AND first_attempt_at IS NOT NULL AND first_attempt_at <= ?`, [b0.batch_uuid, cutoff]);
    const cands = rawAll(raw, `SELECT * FROM restock_notify_deliveries WHERE batch_uuid=? AND retry_key IS NOT NULL
                                 AND (status IN ('pending','retry_wait') OR (status IN ('held','unknown')
                                      AND attempt_count < max_attempts AND (first_attempt_at IS NULL OR first_attempt_at > ?)
                                      AND COALESCE(exclusion_reason,'') NOT IN (${PERMANENT_BLOCK.map(() => '?').join(',')})))
                               ORDER BY id`, [b0.batch_uuid, cutoff, ...PERMANENT_BLOCK]);
    const gate = productGate(db, storeId, b0.product_id, b0.fulfillment_mode, b0.supply_date);
    for (const d of cands) {
      const req = rawGet(raw, 'SELECT * FROM product_demand_requests WHERE store_id=? AND request_uuid=?', [storeId, d.request_uuid]);
      let ev = evaluateRecipient(db, storeId, req, b0.fulfillment_mode, { ownBatch: b0.batch_uuid, ownDelivery: d.delivery_uuid });
      if (ev.ok && !gate.ok) ev = { ok: false, reason: gateReason(gate) };
      if (!ev.ok) { blocked += blockRowRaw(raw, d, ev.reason); continue; }
      if (d.status === 'held' || d.status === 'unknown') {
        resumed += rawRun(raw, `UPDATE restock_notify_deliveries SET status='retry_wait', exclusion_reason='', next_attempt_at=NULL, updated_at=datetime('now')
                                WHERE id=? AND status IN ('held','unknown') AND attempt_count < max_attempts`, [d.id]);
      } else {
        resumed += rawRun(raw, `UPDATE restock_notify_deliveries SET next_attempt_at=NULL, updated_at=datetime('now') WHERE id=?`, [d.id]);
      }
    }
    const open = rawGet(raw, `SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE batch_uuid=? AND status IN ('pending','retry_wait') AND attempt_count < max_attempts`, [b0.batch_uuid]);
    if (!open || !Number(open.c)) {
      // 沒有可續送的項目：批次收尾（已用完次數的 held 不再算待處理）
      const left = rawGet(raw, `SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE batch_uuid=? AND status='held' AND attempt_count < max_attempts`, [b0.batch_uuid]);
      if (!left || !Number(left.c)) rawRun(raw, `UPDATE restock_notify_batches SET status='completed', pause_reason='', completed_at=COALESCE(completed_at, datetime('now')), updated_at=datetime('now')
                                                 WHERE batch_uuid=? AND status='paused'`, [b0.batch_uuid]);
      return;
    }
    ok = rawRun(raw, `UPDATE restock_notify_batches SET status='sending', pause_reason='', updated_at=datetime('now')
                      WHERE batch_uuid=? AND status IN ('paused','completed')`, [b0.batch_uuid]) === 1;
  });
  if (!ok) return { batch_uuid: b0.batch_uuid, already: false, resumed: 0, blocked, status: getBatchRow(db, storeId, batchUuid).status, message: blocked ? '可續送的項目已在重新檢查時擋下（原因見明細）' : '沒有可續送的項目（可能已達嘗試上限、超過重試期限或已有通知紀錄）' };
  if (opts.startWorker !== false) startWorker(db, storeId, b0.batch_uuid);
  void actor;
  return { batch_uuid: b0.batch_uuid, already: false, resumed, blocked, status: 'sending' };
}

function cancelBatch(db, storeId, batchUuid) {
  const b0 = getBatchRow(db, storeId, batchUuid);
  if (activeWorkers.has(b0.batch_uuid)) throw new RestockError('BATCH_RUNNING', '批次正在送出中，請待本輪結束（暫停）後再取消', 409);
  if (!['previewed', 'paused'].includes(b0.status)) throw new RestockError('BATCH_NOT_CANCELLABLE', '此批次目前不可取消', 409);
  db.runDurableTransaction(() => {
    const raw = db._db;
    // 從未交給 LINE 的項目：取消並釋放週期名額；曾嘗試過的保留名額（可能已受理）
    rawRun(raw, `UPDATE restock_notify_deliveries SET status='cancelled', claim=NULL, updated_at=datetime('now')
                 WHERE batch_uuid=? AND status IN ('pending','retry_wait','held') AND attempt_count=0`, [b0.batch_uuid]);
    rawRun(raw, `UPDATE restock_notify_deliveries SET status='unknown', error_code=CASE WHEN error_code='' THEN 'cancelled_after_attempt' ELSE error_code END,
                 updated_at=datetime('now') WHERE batch_uuid=? AND status IN ('retry_wait') AND attempt_count>0`, [b0.batch_uuid]);
    rawRun(raw, `UPDATE restock_notify_deliveries SET status='cancelled', updated_at=datetime('now')
                 WHERE batch_uuid=? AND status IN ('pending','held') AND attempt_count>0`, [b0.batch_uuid]);
    rawRun(raw, `UPDATE restock_notify_batches SET status='cancelled', updated_at=datetime('now') WHERE batch_uuid=? AND status IN ('previewed','paused')`, [b0.batch_uuid]);
  });
  return { batch_uuid: b0.batch_uuid, status: 'cancelled' };
}

// ══════════════════════════════════════════════════════════════════════
//  查詢（重新整理後仍可查到進度與明細）
// ══════════════════════════════════════════════════════════════════════
const DELIVERY_STATES = ['pending', 'sending', 'retry_wait', 'held', 'accepted', 'unknown', 'failed', 'blocked', 'excluded', 'cancelled'];
function batchCounts(db, batchUuid) {
  const rows = db.all('SELECT status, COUNT(*) AS c FROM restock_notify_deliveries WHERE batch_uuid=? GROUP BY status', [batchUuid]);
  const out = Object.fromEntries(DELIVERY_STATES.map((k) => [k, 0]));
  for (const r of rows) out[r.status] = Number(r.c);
  return out;
}
function batchOut(db, b) {
  let stats = null;
  try { stats = JSON.parse(b.preview_json || '{}').stats || null; } catch {}
  return {
    batch_uuid: b.batch_uuid, product_id: b.product_id, product_name: b.product_name_snapshot, fulfillment_mode: b.fulfillment_mode,
    supply_date: b.supply_date, notice_kind: b.notice_kind, status: b.status, pause_reason: b.pause_reason || '',
    candidate_count: Number(b.candidate_count) || 0, created_at: b.created_at, confirmed_at: b.confirmed_at, completed_at: b.completed_at,
    preview_expires_at: b.preview_expires_at, created_by: b.created_by, confirmed_by: b.confirmed_by, import_source: b.import_source || '',
    running: activeWorkers.has(b.batch_uuid), counts: batchCounts(db, b.batch_uuid), preview_stats: stats,
  };
}
function listBatches(db, storeId, productId) {
  const params = [storeId];
  let extra = '';
  if (productId != null && productId !== '') { extra = ' AND product_id=?'; params.push(Number(productId)); }
  return db.all(`SELECT * FROM restock_notify_batches WHERE store_id=?${extra} ORDER BY id DESC LIMIT 50`, params).map((b) => batchOut(db, b));
}
function maskUid(uid) {
  const s = String(uid || '');
  if (s.length <= 8) return s ? s.slice(0, 2) + '…' : '';
  return s.slice(0, 5) + '…' + s.slice(-4);
}
function batchDetail(db, storeId, batchUuid) {
  const b = getBatchRow(db, storeId, batchUuid);
  const cutoff = Date.now() - RETRY_WINDOW_MS;
  const rows = db.all(`SELECT d.*, m.display_name AS member_display_name FROM restock_notify_deliveries d
                       LEFT JOIN line_members m ON m.store_id=d.store_id AND m.line_user_id=d.line_user_id
                       WHERE d.batch_uuid=? AND d.store_id=? ORDER BY d.id ASC`, [b.batch_uuid, storeId]);
  return {
    ...batchOut(db, b),
    message_text: b.message_text,
    link_url: b.link_url,
    deliveries: rows.map((d) => ({
      delivery_uuid: d.delivery_uuid, member: maskUid(d.line_user_id), member_display_name: d.member_display_name || '',
      status: d.status, exclusion_reason: d.exclusion_reason || '', attempt_count: Number(d.attempt_count) || 0,
      first_attempt_at: d.first_attempt_at, last_attempt_at: d.last_attempt_at, next_attempt_at: d.next_attempt_at,
      accepted_at: d.accepted_at, last_http_status: d.last_http_status, error_code: d.error_code || '',
      line_request_id: d.line_request_id || '', accepted_request_id: d.accepted_request_id || '',
      retry_window_expired: !!(d.first_attempt_at && parseUtc(d.first_attempt_at) <= cutoff && d.status === 'unknown'),
      max_attempts: Number(d.max_attempts) || 0,
      attempts_exhausted: Number(d.attempt_count) >= Number(d.max_attempts) && ['unknown', 'held', 'blocked'].includes(d.status),
      import_source: d.import_source || '',
    })),
  };
}

// 顧客端／後台：本登記週期的通知狀態（不揭露其他會員）
// C4.1：已受理證據不看 claim（匯入的已受理歷史可能是 claim=NULL）；結果不明不算已受理。
function requestNotifyState(db, storeId, requestUuid) {
  const acc = db.get(`SELECT 1 AS x FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND status='accepted' LIMIT 1`, [storeId, requestUuid]);
  if (acc) return 'accepted';
  const d = db.get(`SELECT status FROM restock_notify_deliveries WHERE store_id=? AND request_uuid=? AND claim=1`, [storeId, requestUuid]);
  if (!d) return 'none';
  return 'in_progress';
}

module.exports = {
  CONSENT_TEXT, CONSENT_TEXT_VERSION, SEND_SETTING_KEY, RETRY_KEY_VALID_HOURS, RETRY_WINDOW_MS, EXCLUSION_KEYS, DISCLAIMER,
  RestockError, migrate, recoverInterruptedOnBoot, blockConflictsRaw, backfillProductUuids,
  getCapability, setSendEnabled, resolveProductRef, buildProductLink, buildMessage,
  evaluateRecipient, consentState, cycleConsent, cycleEvidence, productGate, batchContext, previewBatch, confirmBatch, resumeBatch, cancelBatch,
  listBatches, batchDetail, requestNotifyState, startWorker, waitForWorker, runBatch, applyResult,
  _activeWorkers: activeWorkers,
};
