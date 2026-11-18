// utils/popupOrderTime.js — R54.4／MBV2-HF1-C5.4.2：快閃訂單時間契約（寫入、遷移、歷史判讀、顯示）
//
// 資料契約（沿用既有欄位，不改欄位型別）
//   orders.created_at／orders.updated_at（pickup_type='popup'）＝台北牆上時間「YYYY-MM-DD HH:MM:SS」（無時區字尾）。
//   - created_at：R53 起由結帳以台北時間寫入（routes/popup-public.js）；本輪改由 taipeiString() 產生，結果相同。
//   - updated_at：舊版各寫入點使用 SQLite datetime('now','localtime')＝「主機時區」，主機為 UTC 時會比建立時間早 8 小時；
//     廚房狀態寫入點使用 ISO 帶 Z。本輪以兩個觸發器集中處理（只作用於快閃訂單），各寫入點不必自行處理：
//       TRG_ORDERS   任何寫入 orders.updated_at 的 UPDATE（含共用訂單路由、LINE Pay 共用服務、廚房）→ 改為台北時間並標記來源
//       TRG_ATTEMPTS 快閃付款紀錄 status 改變（付款失敗／待核對／逾時等只改付款紀錄的路徑）→ 同步更新訂單的狀態更新時間
//     觸發器只寫 orders.updated_at 與來源標記，不改付款紀錄的任何欄位（付款期限 expires_at、核對排程、重試時間皆不受影響）。
//   - 來源標記（新增、可為 NULL）：orders.popup_created_tz／popup_updated_tz＝'Asia/Taipei' 表示該欄位已確定是台北時間。
//     必要性：修正後寫入的台北時間與舊版主機時區寫入的值格式完全相同，沒有標記就無法區分新舊資料。
//
// 台灣自 1979 年起不實施日光節約時間，台北＝UTC+8 固定；SQL 端以 strftime(...,'now','+8 hours') 計算，
//   與主機 TZ 無關（不修改整個服務的 TZ）。付款期限、epoch 毫秒、核對排程等 UTC／epoch 時間不經過本模組。
//
// 歷史資料（標記為 NULL 的舊資料）只在讀取時判讀，不改寫任何舊時間：
//   建立時間：
//     a. 帶 Z／±hh:mm → 依其時區解析
//     b. 同一交易寫入的名額紀錄 popup_order_allocations.created_at（主機 localtime）比 created_at 早剛好 8 小時
//        → 主機為 UTC、created_at 為台北（R53 起的寫法）→ 已知台北
//     c. 同一交易建立的付款紀錄 expires_at（epoch 毫秒、絕對時刻）：只有一種解讀落在「建立後 5～60 分鐘到期」的合法範圍
//        → 依該解讀
//     d. 其他 → 來源不明（保留原值，標示時區未確認）
//   更新時間：
//     a. 帶 Z／±hh:mm → 依其時區解析
//     b. 與 created_at 完全相同（建立後未再更新）→ 沿用建立時間的判讀
//     c. 已付款：付款紀錄同一敘述寫入的 confirmed_at（SQLite datetime('now')＝UTC）與 updated_at（localtime），
//        且付款紀錄 updated_at 與訂單 updated_at 一致 → 由兩者差值（0 或 8 小時）確認主機時區
//     d. 其他（含「更新時間早於建立時間」）→ 來源不明，不自動加 8 小時
'use strict';

const TZ_NAME = 'Asia/Taipei';
const TPE_OFFSET_MS = 8 * 3600e3;
const SQL_TPE_NOW = "strftime('%Y-%m-%d %H:%M:%S','now','+8 hours')";
const TRG_ORDERS = 'trg_c542_popup_order_updated_tpe';
const TRG_ATTEMPTS = 'trg_c542_popup_attempt_touch_order';
const TIMEOUT_MIN_MS = 5 * 60000;   // 與 utils/popupPayment TIMEOUT_MIN／MAX 相同
const TIMEOUT_MAX_MS = 60 * 60000;
const TOL_MS = 5000;

const NAIVE_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const EXPLICIT_RE = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?\s*(Z|[+-]\d{2}:?\d{2})$/i;

const pad = (n, l = 2) => String(n).padStart(l, '0');
function taipeiParts(ms) {
  const d = new Date(Number(ms) + TPE_OFFSET_MS);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
}
// 寫入用：台北牆上時間「YYYY-MM-DD HH:MM:SS」
function taipeiString(ms = Date.now()) {
  const p = taipeiParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}`;
}
// 顯示用：台北「YYYY-MM-DD HH:MM」
function formatTaipei(ms) {
  if (!Number.isFinite(ms)) return '';
  const p = taipeiParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`;
}
function isoTaipei(ms) {
  if (!Number.isFinite(ms)) return null;
  const p = taipeiParts(ms);
  return `${p.y}-${pad(p.mo)}-${pad(p.d)}T${pad(p.h)}:${pad(p.mi)}:${pad(p.s)}+08:00`;
}
// 無時區字串 → 以指定偏移解析（offsetMs：該牆上時間領先 UTC 的毫秒數）
function naiveToMs(s, offsetMs) {
  const m = NAIVE_RE.exec(String(s || '').trim());
  if (!m) return null;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0));
  return Number.isFinite(t) ? t - offsetMs : null;
}
function explicitToMs(s) {
  const m = EXPLICIT_RE.exec(String(s || '').trim());
  if (!m) return null;
  let off = 0;
  if (m[8].toUpperCase() !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(m[8]);
    off = (z[1] === '-' ? -1 : 1) * ((+z[2]) * 60 + (+z[3])) * 60000;
  }
  const ms = m[7] ? Math.round(Number('0.' + m[7]) * 1000) : 0;
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0), ms);
  return Number.isFinite(t) ? t - off : null;
}
const isExplicit = (s) => EXPLICIT_RE.test(String(s || '').trim());

// ── 遷移（additive、idempotent；啟動時執行，可重複執行）─────────────────────
function _cols(raw, t) {
  try { const r = raw.exec(`PRAGMA table_info(${t})`); return (r[0] ? r[0].values : []).map((v) => v[1]); } catch (e) { return []; }
}
function _hasTrigger(raw, name) {
  try { const r = raw.exec("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?", [name]); return !!(r[0] && r[0].values.length); } catch (e) { return false; }
}
const ORDERS_TRIGGER_SQL = `CREATE TRIGGER ${TRG_ORDERS} AFTER UPDATE OF updated_at ON orders
  WHEN NEW.pickup_type='popup' AND (NEW.updated_at IS NOT ${SQL_TPE_NOW} OR NEW.popup_updated_tz IS NOT '${TZ_NAME}')
  BEGIN
    UPDATE orders SET updated_at=${SQL_TPE_NOW}, popup_updated_tz='${TZ_NAME}' WHERE rowid=NEW.rowid;
  END`;
const ATTEMPTS_TRIGGER_SQL = `CREATE TRIGGER ${TRG_ATTEMPTS} AFTER UPDATE OF status ON popup_payment_attempts
  WHEN NEW.status IS NOT OLD.status
  BEGIN
    UPDATE orders SET updated_at=${SQL_TPE_NOW}, popup_updated_tz='${TZ_NAME}'
      WHERE id=NEW.order_id AND store_id=NEW.store_id AND pickup_type='popup';
  END`;
// refresh=true（啟動）：重建觸發器以套用最新定義；false（執行中補建）：只在缺少時建立
function migrate(raw, opts = {}) {
  const out = { columns_added: [], orders_trigger: false, attempts_trigger: false };
  const oc = _cols(raw, 'orders');
  if (!oc.length) return out;
  for (const c of ['popup_created_tz', 'popup_updated_tz']) {
    if (!oc.includes(c)) { raw.run(`ALTER TABLE orders ADD COLUMN ${c} TEXT DEFAULT NULL`); out.columns_added.push(c); }
  }
  const refresh = opts.refresh !== false;
  if (refresh) raw.run(`DROP TRIGGER IF EXISTS ${TRG_ORDERS}`);
  if (!_hasTrigger(raw, TRG_ORDERS)) raw.run(ORDERS_TRIGGER_SQL);
  out.orders_trigger = true;
  if (_cols(raw, 'popup_payment_attempts').length) {
    if (refresh) raw.run(`DROP TRIGGER IF EXISTS ${TRG_ATTEMPTS}`);
    if (!_hasTrigger(raw, TRG_ATTEMPTS)) raw.run(ATTEMPTS_TRIGGER_SQL);
    out.attempts_trigger = true;
  }
  return out;
}
function ensure(raw) { return migrate(raw, { refresh: false }); }

// 新建快閃訂單（結帳交易內）：標記建立／更新時間皆為台北。欄位不存在（遷移未完成）時只略過標記，不影響結帳。
function markNewOrderInTransaction(db, orderId, storeId) {
  try {
    const oc = _cols(db._db, 'orders');
    if (!oc.includes('popup_created_tz')) return false;
    db._db.run(`UPDATE orders SET popup_created_tz='${TZ_NAME}', popup_updated_tz='${TZ_NAME}' WHERE id=? AND store_id=?`, [orderId, storeId]);
    return true;
  } catch (e) { return false; }
}

// ── 讀取時判讀 ────────────────────────────────────────────────────────
function _shown(value, basis, source) {
  const raw = value == null ? '' : String(value);
  let ms = null;
  if (isExplicit(raw)) { ms = explicitToMs(raw); basis = 'explicit'; }
  else if (basis === TZ_NAME) ms = naiveToMs(raw, TPE_OFFSET_MS);
  else if (basis === 'UTC') ms = naiveToMs(raw, 0);
  if (ms != null && Number.isFinite(ms)) {
    return { text: formatTaipei(ms), iso: isoTaipei(ms), known: true, basis, source };
  }
  return { text: raw.replace('T', ' ').slice(0, 16), iso: null, known: false, basis: 'unknown', source: source || 'no_trusted_evidence' };
}
function _safeAll(db, sql, params) { try { return db.all(sql, params) || []; } catch (e) { return []; } }

// C5.4.2 補修：來源標記與同交易的可信證據互相矛盾時（例如舊版搬家合併把來源備份的標記補到本地另一個時間值上），
//   以證據為準；正常寫入的標記與證據不會矛盾（觸發器寫入的台北時間與主機 localtime 證據相差 8 小時或相同，皆與標記一致）。
function _evidenceCreated(db, order, attempts) {
  const v = order.created_at;
  const asUtc = naiveToMs(v, 0);
  if (asUtc == null) return null;
  const al = _safeAll(db, 'SELECT MIN(created_at) AS c FROM popup_order_allocations WHERE store_id=? AND order_id=?', [order.store_id, order.id]);
  const allocUtc = al[0] && al[0].c ? naiveToMs(al[0].c, 0) : null;
  if (allocUtc != null && Math.abs((asUtc - allocUtc) - TPE_OFFSET_MS) <= TOL_MS) return { basis: TZ_NAME, source: 'allocation_host_utc' };
  const first = (attempts || []).slice().sort((a, b) => Number(a.rid || 0) - Number(b.rid || 0))[0];
  const exp = first ? Number(first.expires_at) : NaN;
  if (Number.isFinite(exp) && exp > 0) {
    const inWin = (ms) => ms != null && exp - ms >= TIMEOUT_MIN_MS - TOL_MS && exp - ms <= TIMEOUT_MAX_MS + TOL_MS;
    const tpe = naiveToMs(v, TPE_OFFSET_MS);
    if (inWin(tpe) && !inWin(asUtc)) return { basis: TZ_NAME, source: 'payment_deadline' };
    if (inWin(asUtc) && !inWin(tpe)) return { basis: 'UTC', source: 'payment_deadline' };
  }
  return null;
}
function _evidenceUpdated(order, attempts) {
  const v = order.updated_at || order.created_at;
  const asUtc = naiveToMs(v, 0);
  if (asUtc == null) return null;
  for (const a of attempts || []) {
    if (!a.confirmed_at || !a.updated_at || isExplicit(a.updated_at)) continue;
    const confUtc = naiveToMs(a.confirmed_at, 0); const attUpd = naiveToMs(a.updated_at, 0);
    if (confUtc == null || attUpd == null || Math.abs(attUpd - asUtc) > TOL_MS) continue;
    const off = attUpd - confUtc;
    if (Math.abs(off) <= TOL_MS) return { basis: 'UTC', source: 'payment_confirmed_at' };
    if (Math.abs(off - TPE_OFFSET_MS) <= TOL_MS) return { basis: TZ_NAME, source: 'payment_confirmed_at' };
  }
  return null;
}
function classifyCreated(db, order, attempts) {
  const v = order.created_at;
  if (isExplicit(v)) return _shown(v, 'explicit', 'explicit_offset');
  if (order.popup_created_tz === TZ_NAME) {
    const ev = _evidenceCreated(db, order, attempts);
    if (ev && ev.basis !== TZ_NAME) return _shown(v, ev.basis, ev.source + '_overrides_marker');
    return _shown(v, TZ_NAME, 'marker');
  }
  const asUtc = naiveToMs(v, 0);
  if (asUtc == null) return _shown(v, null, 'unparseable');
  // b. 同一交易的名額紀錄（主機 localtime）
  const al = _safeAll(db, 'SELECT MIN(created_at) AS c FROM popup_order_allocations WHERE store_id=? AND order_id=?', [order.store_id, order.id]);
  const allocUtc = al[0] && al[0].c ? naiveToMs(al[0].c, 0) : null;
  if (allocUtc != null && Math.abs((asUtc - allocUtc) - TPE_OFFSET_MS) <= TOL_MS) return _shown(v, TZ_NAME, 'allocation_host_utc');
  // c. 同一交易建立的付款紀錄到期時刻（epoch 毫秒）
  const first = (attempts || []).slice().sort((a, b) => Number(a.rid || 0) - Number(b.rid || 0))[0];
  const exp = first ? Number(first.expires_at) : NaN;
  if (Number.isFinite(exp) && exp > 0) {
    const inWin = (ms) => ms != null && exp - ms >= TIMEOUT_MIN_MS - TOL_MS && exp - ms <= TIMEOUT_MAX_MS + TOL_MS;
    const tpe = naiveToMs(v, TPE_OFFSET_MS), utc = asUtc;
    if (inWin(tpe) && !inWin(utc)) return _shown(v, TZ_NAME, 'payment_deadline');
    if (inWin(utc) && !inWin(tpe)) return _shown(v, 'UTC', 'payment_deadline');
  }
  return _shown(v, null, 'no_trusted_evidence');
}
function classifyUpdated(db, order, attempts, created) {
  const v = order.updated_at || order.created_at;
  if (isExplicit(v)) return _shown(v, 'explicit', 'explicit_offset');
  if (order.popup_updated_tz === TZ_NAME) {
    const ev = _evidenceUpdated(order, attempts);
    if (ev && ev.basis !== TZ_NAME) return _shown(v, ev.basis, ev.source + '_overrides_marker');
    return _shown(v, TZ_NAME, 'marker');
  }
  if (String(v) === String(order.created_at)) return created.known ? { ...created, source: 'same_as_created' } : _shown(v, null, 'same_as_created_unknown');
  const asUtc = naiveToMs(v, 0);
  if (asUtc != null) {
    for (const a of attempts || []) {
      if (!a.confirmed_at || !a.updated_at || isExplicit(a.updated_at)) continue;
      const confUtc = naiveToMs(a.confirmed_at, 0); const attUpd = naiveToMs(a.updated_at, 0);
      if (confUtc == null || attUpd == null || Math.abs(attUpd - asUtc) > TOL_MS) continue;
      const off = attUpd - confUtc;
      if (Math.abs(off) <= TOL_MS) return _shown(v, 'UTC', 'payment_confirmed_at');
      if (Math.abs(off - TPE_OFFSET_MS) <= TOL_MS) return _shown(v, TZ_NAME, 'payment_confirmed_at');
    }
  }
  return _shown(v, null, 'no_trusted_evidence');
}
// 對外：{ created, updated }，每項 { text:'YYYY-MM-DD HH:MM'（台北）, iso, known, basis, source }
function orderTimes(db, order, attempts) {
  if (!order) return null;
  const created = classifyCreated(db, order, attempts);
  const updated = classifyUpdated(db, order, attempts, created);
  return { tz: TZ_NAME, created, updated };
}

module.exports = {
  TZ_NAME, TPE_OFFSET_MS, SQL_TPE_NOW, TRG_ORDERS, TRG_ATTEMPTS,
  taipeiParts, taipeiString, formatTaipei, isoTaipei, naiveToMs, explicitToMs, isExplicit,
  migrate, ensure, markNewOrderInTransaction, orderTimes, classifyCreated, classifyUpdated,
};
