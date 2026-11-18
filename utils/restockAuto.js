// utils/restockAuto.js — R54.4／MBV2-HF1-C6：恢復販售自動補貨通知
//
// 目標：店家先開啟「恢復販售時自動發送補貨通知」（全店，預設關閉）並勾選參與的商品（預設不參與）。
//   之後店家「明確恢復販售」或「手動增加可售額度」使商品由不可訂購變為可訂購時，系統以既有可訂購判斷
//   （routes/line-orders.evaluateProductOrderability：Asia/Taipei、截止時間、行事曆、休息日、預訂範圍、額度）
//   找出受影響的取餐方式與最近可訂購日期，建立持久化事件，再交由既有補貨通知引擎（utils/restockNotify）
//   以「預覽 → 確認發送」相同的資格、快照、批次、逐筆投遞、retry key、同店同週期唯一 claim 與 C5 追蹤送出。
//   不另寫直接呼叫 LINE 的捷徑；手動「預覽 → 確認發送」維持不變。
//
// 觸發（只有下列實際寫入路徑會建立事件；見報告「觸發對照表」）
//   PATCH /api/products/:id/line-settings  sale_status→available、line_sold_out 1→0、上架、外帶／外送開啟、可售額度增加（含已售重設）
//   PATCH /api/products/:id/line-status    sale_status→available、show_on_line 0→1
//   PUT   /api/products/:id                enabled 0→1
//   POST  /api/products/reset-sold-out-today  店家按下「重置今日完售」（明確批量恢復）
//   不觸發：修改名稱／價格／備註、重複儲存相同狀態、GET／預覽、初始化、每日排程自動恢復、份數每日重設、
//           訂單取消回補、備份還原、搬家匯入、歷史同步（這些都不經過本模組的寫入掛勾）。
//   事件只在「寫入前不可訂購（或最近可訂購日較晚）→ 寫入後可訂購（或提早）」時建立，並記錄寫入前後各取餐方式的最近可訂購日。
//
// 持久化與防重送
//   - 事件與商品變更在同一個 durable 交易內寫入（restock_auto_events.status='queued'）；外部發送在交易提交後才進行。
//   - 處理以原子條件 UPDATE … WHERE status='queued' 領取；重啟時 processing → queued（每個取餐方式以既有批次檢查冪等）。
//   - 防重送完全沿用既有 restock_notify_deliveries 的「同店、同一登記週期只通知一次」證據與唯一 claim（手動、自動共用）。
//   - 自動開關以 epoch 標記：關閉時取消未處理事件，執行中的自動批次在下一筆送出前暫停；重新開啟產生新 epoch，
//     不追發停用期間的事件，也不因商品目前可售而補發（初次啟用只建立觀測基線）。
//
// R54.4／MBV2-HF1-C6.1：自動批次逐筆送出前的版本防護與中斷恢復
//   - 版本：全店 epoch（settings.restock_auto_notify_epoch，C6 既有）＋商品參與版本 products.restock_auto_version
//     （參與狀態真正改變才 +1；相同值重複儲存不變）。事件記錄 product_auto_version；自動批次記錄 auto_epoch／auto_product_version。
//     都存在資料庫檔，重啟後仍有效；不依記憶體旗標。
//   - 每一筆實際送出前（restockNotify.runBatch 的 durable claim 交易內）以 staleReasonRaw() 重新核對：
//     同店／同事件／同商品、自動開啟、epoch 相符、商品仍參與且版本相符；未被店家明確接手者才受此限制。
//     過時 → 批次暫停並記錄原因；從未交給 LINE 的項目改為「暫停（未受理）」並釋放週期名額；曾交給 LINE 者保留原 key 與證據。
//   - 事件恢復：既有自動批次不再一律視為完成。previewed → 重新驗證後沿用同一批次確認；過期／連結失配／不可訂購／版本失效 →
//     作廢該預覽並記錄原因，不重建新預覽；sending／paused／completed 沿用；cancelled／expired 尊重終態。
//   - 測試掛勾（after_preview／after_confirm）只在 RESTOCK_AUTO_TEST_HOOKS=1、RESTOCK_AUTO_TEST_GATE_DIR 已設定且
//     NODE_ENV 不是 production 時才生效；正式服務預設不啟用。
'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const RN = require('./restockNotify');

const KEY_ENABLED = 'restock_auto_notify_enabled';
const KEY_EPOCH = 'restock_auto_notify_epoch';
const KEY_ENABLED_AT = 'restock_auto_notify_enabled_at';
const MODE_PRIORITY = ['takeout', 'delivery']; // 「都可以」同時合格時：外帶優先（同一登記週期只通知一次，由唯一 claim 保證）
const EVENT_MAX_AGE_MS = 12 * 3600e3; // 過久未處理的事件不再發送（例如長時間停機後）
const SCAN_DAYS = 61;
const _running = new Map(); // store_id → Promise（同一程序內循序處理；跨程序以資料庫原子領取把關）

function rawAll(raw, sql, params) { const st = raw.prepare(sql); try { if (params && params.length) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } }
function rawGet(raw, sql, params) { return rawAll(raw, sql, params)[0] || null; }
function colNames(raw, t) { try { return rawAll(raw, `PRAGMA table_info(${t})`).map((c) => c.name); } catch { return []; } }

// ══════════════════════════════════════════════════════════════════════
//  遷移（additive、idempotent）
// ══════════════════════════════════════════════════════════════════════
function migrate(raw) {
  const pcols = colNames(raw, 'products');
  if (pcols.length && !pcols.includes('restock_auto_notify')) raw.run('ALTER TABLE products ADD COLUMN restock_auto_notify INTEGER NOT NULL DEFAULT 0');
  const bcols = colNames(raw, 'restock_notify_batches');
  if (bcols.length) {
    if (!bcols.includes('source')) raw.run("ALTER TABLE restock_notify_batches ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'");
    if (!bcols.includes('auto_event_uuid')) raw.run("ALTER TABLE restock_notify_batches ADD COLUMN auto_event_uuid TEXT NOT NULL DEFAULT ''");
    if (!bcols.includes('taken_over_by')) raw.run("ALTER TABLE restock_notify_batches ADD COLUMN taken_over_by TEXT NOT NULL DEFAULT ''");
  }
  raw.run(`CREATE TABLE IF NOT EXISTS restock_auto_events (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    event_uuid     TEXT NOT NULL,
    store_id       TEXT NOT NULL,
    product_id     INTEGER NOT NULL,
    product_name   TEXT NOT NULL DEFAULT '',
    trigger_source TEXT NOT NULL DEFAULT '',
    trigger_fields TEXT NOT NULL DEFAULT '{}',
    before_json    TEXT NOT NULL DEFAULT '{}',
    after_json     TEXT NOT NULL DEFAULT '{}',
    modes_json     TEXT NOT NULL DEFAULT '[]',
    status         TEXT NOT NULL DEFAULT 'queued',
    reason         TEXT NOT NULL DEFAULT '',
    detail_json    TEXT NOT NULL DEFAULT '[]',
    batch_uuids    TEXT NOT NULL DEFAULT '[]',
    epoch          INTEGER NOT NULL DEFAULT 0,
    actor          TEXT NOT NULL DEFAULT '',
    attempts       INTEGER NOT NULL DEFAULT 0,
    created_at     TEXT DEFAULT (datetime('now')),
    claimed_at     TEXT DEFAULT NULL,
    completed_at   TEXT DEFAULT NULL,
    import_source  TEXT NOT NULL DEFAULT ''
  )`);
  // C6.1：版本欄位（additive、idempotent）。既有 C6 事件／批次維持 NULL＝無法證明版本 → 不會被自動續送或恢復。
  const pcols2 = colNames(raw, 'products');
  if (pcols2.length && !pcols2.includes('restock_auto_version')) {
    raw.run('ALTER TABLE products ADD COLUMN restock_auto_version INTEGER NOT NULL DEFAULT 0');
    // 升級當下已參與的商品從版本 1 起算（之前沒有紀錄的切換歷史一律視為無法證明 → 舊事件／舊批次以 NULL 版本處理）
    raw.run('UPDATE products SET restock_auto_version=1 WHERE COALESCE(restock_auto_notify,0)=1');
  }
  const bcols2 = colNames(raw, 'restock_notify_batches');
  if (bcols2.length) {
    if (!bcols2.includes('auto_epoch')) raw.run('ALTER TABLE restock_notify_batches ADD COLUMN auto_epoch INTEGER DEFAULT NULL');
    if (!bcols2.includes('auto_product_version')) raw.run('ALTER TABLE restock_notify_batches ADD COLUMN auto_product_version INTEGER DEFAULT NULL');
  }
  const ecols = colNames(raw, 'restock_auto_events');
  if (ecols.length && !ecols.includes('product_auto_version')) raw.run('ALTER TABLE restock_auto_events ADD COLUMN product_auto_version INTEGER DEFAULT NULL');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rae_uuid ON restock_auto_events(event_uuid)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rae_store_status ON restock_auto_events(store_id, status, id)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rae_store_product ON restock_auto_events(store_id, product_id, id)');
}

// ══════════════════════════════════════════════════════════════════════
//  設定
// ══════════════════════════════════════════════════════════════════════
function _setting(db, storeId, key, def) {
  const r = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return r && r.value != null && r.value !== '' ? String(r.value) : def;
}
function isEnabled(db, storeId) { return _setting(db, storeId, KEY_ENABLED, '0') === '1'; }
function currentEpoch(db, storeId) { return Math.trunc(Number(_setting(db, storeId, KEY_EPOCH, '0'))) || 0; }
const RULES = {
  trigger: '店家明確恢復販售（販售狀態改為可販售、取消今日完售、上架、開啟外帶／外送）或手動增加可售額度，使商品由不可訂購變為可訂購時',
  modes: '外帶自取、外送（第一版不含宅配與快閃場次）；只通知取餐偏好相符的登記，「都可以」在多種方式同時合格時以外帶優先、同一登記週期只通知一次',
  date: '各取餐方式的最近可訂購日期，由伺服器依台北時間、最後接單時間、行事曆、休息日、可預訂範圍與額度計算；未來日期使用「開放預購」文案',
  not_triggered: '修改名稱／價格／備註、重複儲存相同狀態、每日自動恢復與份數重設、訂單取消回補、備份還原、搬家匯入都不會自動發送',
  consent: '只通知已同意且同意屬於目前登記週期、未撤回、未取消、仍為 LINE 好友的登記；啟用自動發送不會替任何人新增同意',
  master_switch: '必須同時開啟「補貨通知發送」總開關；總開關關閉時自動通知不會發送',
  baseline: '啟用時只建立觀測基線：已經可訂購的商品不會因啟用而追發',
};
function getConfig(db, storeId) {
  const cap = RN.getCapability(db, storeId);
  const products = db.all(`SELECT id, name, line_name, sale_status, demand_collect_enabled, restock_auto_notify FROM products
                           WHERE store_id=? AND COALESCE(restock_auto_notify,0)=1 ORDER BY sort_order ASC, id ASC`, [storeId])
    .map((p) => ({ product_id: p.id, name: String((p.line_name || '').trim() || p.name || ''), sale_status: p.sale_status || 'available', collect_enabled: Number(p.demand_collect_enabled ?? 1) !== 0 }));
  return {
    enabled: isEnabled(db, storeId), epoch: currentEpoch(db, storeId), enabled_at: _setting(db, storeId, KEY_ENABLED_AT, '') || null,
    send_enabled: cap.send_enabled, notify_available: cap.notify_available, config_complete: cap.config_complete, missing: cap.missing,
    will_send: isEnabled(db, storeId) && cap.notify_available,
    mode_priority: MODE_PRIORITY.slice(), rules: RULES, participating_products: products,
  };
}
function setEnabled(db, storeId, enabled, actor) {
  let cancelled = 0;
  db.runDurableTransaction(() => {
    const raw = db._db;
    const was = rawGet(raw, 'SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, KEY_ENABLED]);
    const wasOn = !!was && String(was.value) === '1';
    raw.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, KEY_ENABLED, enabled ? '1' : '0']);
    if (enabled && !wasOn) {
      // 新 epoch＝新的觀測基線；之前（停用期間）的事件不會被追發
      const ep = rawGet(raw, 'SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, KEY_EPOCH]);
      raw.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, KEY_EPOCH, String((Math.trunc(Number(ep && ep.value)) || 0) + 1)]);
      raw.run('INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, KEY_ENABLED_AT, new Date().toISOString()]);
    }
    if (!enabled) {
      raw.run(`UPDATE restock_auto_events SET status='cancelled', reason='auto_disabled', completed_at=datetime('now') WHERE store_id=? AND status='queued'`, [storeId]);
      cancelled = raw.getRowsModified();
    }
    // C6.1：版本或開關改變後，未在執行中的自動批次（暫停中／預覽中）立即依新狀態判定；執行中者由逐筆送出前的防護處理
    if (enabled !== wasOn) staleSweepRaw(raw, storeId, null);
  });
  void actor;
  return { ...getConfig(db, storeId), cancelled_events: cancelled };
}
function setProductParticipation(db, storeId, productId, enabled) {
  const pid = Number(productId);
  if (!Number.isInteger(pid) || pid <= 0) throw new RN.RestockError('INVALID_PRODUCT', '商品參數不正確', 400);
  const p = db.get('SELECT id FROM products WHERE id=? AND store_id=?', [pid, storeId]);
  if (!p) throw new RN.RestockError('PRODUCT_NOT_FOUND', '商品不存在', 404);
  let version = 0, changed = false;
  db.runDurableTransaction(() => {
    const raw = db._db;
    // C6.1：只有參與狀態真正改變才遞增版本（相同值重複儲存不切換版本、不觸發任何事）
    raw.run('UPDATE products SET restock_auto_notify=?, restock_auto_version=COALESCE(restock_auto_version,0)+1 WHERE id=? AND store_id=? AND COALESCE(restock_auto_notify,0)<>?',
      [enabled ? 1 : 0, pid, storeId, enabled ? 1 : 0]);
    changed = raw.getRowsModified() === 1;
    const r = rawGet(raw, 'SELECT restock_auto_version FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    version = Number(r && r.restock_auto_version) || 0;
    if (changed) staleSweepRaw(raw, storeId, pid);
  });
  return { product_id: pid, restock_auto_notify: enabled ? 1 : 0, restock_auto_version: version, changed };
}

// ══════════════════════════════════════════════════════════════════════
//  可訂購狀態（唯讀；沿用既有判斷）
// ══════════════════════════════════════════════════════════════════════
function nearestDates(db, storeId, productId) {
  const LO = require('../routes/line-orders');
  const today = LO.twDateStr(LO.twNow());
  const addDays = (ymd, n) => { const [y, m, d] = ymd.split('-').map(Number); return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10); };
  const out = {};
  for (const mode of MODE_PRIORITY) {
    out[mode] = null;
    for (let i = 0; i < SCAN_DAYS; i++) {
      const ds = addDays(today, i);
      const g = LO.evaluateProductOrderability(db, storeId, productId, mode, ds);
      if (g.ok) { out[mode] = { date: ds, notice_kind: g.notice_kind }; break; }
      if (g.reason === 'preorder_limit_exceeded' || g.reason === 'product_not_found' || g.reason === 'product_not_on_line' || g.reason === 'product_mode_not_supported') break;
    }
  }
  return out;
}

// 寫入前：只有全店自動開啟、且商品參與時才計算（其他情況完全不做額外工作）
function captureBefore(db, storeId, productIds) {
  if (!isEnabled(db, storeId)) return null;
  const ids = (Array.isArray(productIds) ? productIds : [productIds]).map(Number).filter((n) => Number.isInteger(n) && n > 0);
  if (!ids.length) return null;
  const rows = db.all(`SELECT * FROM products WHERE store_id=? AND COALESCE(restock_auto_notify,0)=1 AND id IN (${ids.map(() => '?').join(',')})`, [storeId, ...ids]);
  if (!rows.length) return null;
  const snap = { epoch: currentEpoch(db, storeId), products: {} };
  for (const p of rows) snap.products[p.id] = { row: p, dates: nearestDates(db, storeId, p.id) };
  return snap;
}

// 哪些欄位變動屬於「明確恢復販售或增加可售額度」
function triggerFields(before, after) {
  const f = {};
  const num = (v) => Number(v || 0);
  if (String(before.sale_status || 'available') !== 'available' && String(after.sale_status || 'available') === 'available') f.sale_status = [before.sale_status, after.sale_status];
  if (num(before.line_sold_out) === 1 && num(after.line_sold_out) === 0) f.line_sold_out = [1, 0];
  if (num(before.enabled) === 0 && num(after.enabled) === 1) f.enabled = [0, 1];
  if (num(before.show_on_line) === 0 && num(after.show_on_line) === 1) f.show_on_line = [0, 1];
  if (Number(before.line_takeout_enabled ?? 1) === 0 && Number(after.line_takeout_enabled ?? 1) === 1) f.line_takeout_enabled = [0, 1];
  if (Number(before.line_delivery_enabled ?? 1) === 0 && Number(after.line_delivery_enabled ?? 1) === 1) f.line_delivery_enabled = [0, 1];
  const remQ = (p) => (num(p.line_quota_enabled) ? num(p.line_quota_daily) - num(p.line_quota_sold) : Infinity);
  const remP = (p) => (num(p.line_preorder_enabled) ? num(p.line_preorder_daily) - num(p.line_preorder_sold) : Infinity);
  if (remQ(after) > remQ(before)) f.line_quota = [remQ(before) === Infinity ? null : remQ(before), remQ(after) === Infinity ? null : remQ(after)];
  if (remP(after) > remP(before)) f.line_preorder_quota = [remP(before) === Infinity ? null : remP(before), remP(after) === Infinity ? null : remP(after)];
  return f;
}

// 寫入後（呼叫端在同一個 durable 交易內、商品 UPDATE 之後呼叫）：建立事件。回傳建立的事件 uuid 陣列。
function recordAfterInTx(db, storeId, snap, source, actor) {
  if (!snap) return [];
  const raw = db._db;
  const made = [];
  for (const [pidStr, b] of Object.entries(snap.products)) {
    const pid = Number(pidStr);
    const after = rawGet(raw, 'SELECT * FROM products WHERE id=? AND store_id=?', [pid, storeId]);
    if (!after || Number(after.restock_auto_notify || 0) !== 1) continue;
    const fields = triggerFields(b.row, after);
    if (!Object.keys(fields).length) continue; // 不是恢復販售或增加額度（例如只改名稱、價格、重複儲存）
    const ad = nearestDates(db, storeId, pid);
    const modes = [];
    for (const mode of MODE_PRIORITY) {
      const bd = b.dates[mode], adm = ad[mode];
      if (adm && (!bd || adm.date < bd.date)) modes.push({ mode, date: adm.date, notice_kind: adm.notice_kind, before: bd ? bd.date : null });
    }
    if (!modes.length) continue; // 寫入後仍不可訂購、或可訂購日沒有提早 → 沒有可可靠對應的供應範圍
    const u = crypto.randomUUID();
    raw.run(`INSERT INTO restock_auto_events (event_uuid, store_id, product_id, product_name, trigger_source, trigger_fields, before_json, after_json, modes_json, status, epoch, actor, product_auto_version)
             VALUES (?,?,?,?,?,?,?,?,?,'queued',?,?,?)`,
    [u, storeId, pid, String((after.line_name || '').trim() || after.name || ''), String(source || ''), JSON.stringify(fields), JSON.stringify(b.dates), JSON.stringify(ad), JSON.stringify(modes), snap.epoch, String(actor || ''),
      Number(after.restock_auto_version) || 0]);
    made.push(u);
  }
  return made;
}

// ══════════════════════════════════════════════════════════════════════
//  處理（交易提交後；循序、原子領取）
// ══════════════════════════════════════════════════════════════════════
function kick(db, storeId) {
  if (_running.has(storeId)) { _running.get(storeId).again = true; return _running.get(storeId).p; }
  const st = { again: false, p: null };
  st.p = (async () => {
    try {
      do { st.again = false; await processQueued(db, storeId); } while (st.again);
    } catch (e) { console.warn('[restockAuto] process error:', e && e.message); }
    finally { _running.delete(storeId); }
  })();
  _running.set(storeId, st);
  return st.p;
}
function waitIdle(storeId) { const st = _running.get(storeId); return st ? st.p : Promise.resolve(); }

async function processQueued(db, storeId) {
  for (let guard = 0; guard < 200; guard++) {
    const ev = db.get("SELECT * FROM restock_auto_events WHERE store_id=? AND status='queued' ORDER BY id ASC LIMIT 1", [storeId]);
    if (!ev) return;
    let claimed = false;
    db.runDurableTransaction(() => {
      db._db.run("UPDATE restock_auto_events SET status='processing', attempts=attempts+1, claimed_at=datetime('now') WHERE event_uuid=? AND status='queued'", [ev.event_uuid]);
      claimed = db._db.getRowsModified() === 1;
    });
    if (!claimed) continue;
    let res;
    try { res = await processEvent(db, storeId, ev); }
    catch (e) { res = { status: 'failed', reason: 'error:' + String(e && e.message || '').slice(0, 80), details: [], batches: [] }; }
    db.runDurableTransaction(() => {
      db._db.run(`UPDATE restock_auto_events SET status=?, reason=?, detail_json=?, batch_uuids=?, completed_at=datetime('now') WHERE event_uuid=? AND status='processing'`,
        [res.status, res.reason || '', JSON.stringify(res.details || []), JSON.stringify(res.batches || []), ev.event_uuid]);
    });
  }
}

function skip(reason, details) { return { status: 'skipped', reason, details: details || [], batches: [] }; }

// ══════════════════════════════════════════════════════════════════════
//  C6.1：版本防護（逐筆送出前、恢復前、開關變更時共用同一套判斷）
// ══════════════════════════════════════════════════════════════════════
// 回傳 '' 代表仍可自動處理；否則為固定原因代碼。只看資料庫目前狀態（raw，交易內可呼叫）。
//   手動批次、已由店家明確接手（taken_over_by）的自動批次 → ''（不受自動模式／商品參與限制；共通資格另由既有檢查負責）
function staleReasonRaw(raw, storeId, batchUuid) {
  const b = rawGet(raw, 'SELECT * FROM restock_notify_batches WHERE batch_uuid=? AND store_id=?', [String(batchUuid || ''), storeId]);
  if (!b) return 'auto_batch_missing';
  if (String(b.source || 'manual') !== 'auto') return '';
  if (String(b.taken_over_by || '')) return '';
  if (String(b.import_source || '')) return 'auto_imported';
  const ev = b.auto_event_uuid ? rawGet(raw, 'SELECT * FROM restock_auto_events WHERE event_uuid=?', [String(b.auto_event_uuid)]) : null;
  if (!ev || String(ev.store_id) !== String(storeId) || Number(ev.product_id) !== Number(b.product_id) || String(ev.import_source || '')) return 'auto_event_mismatch';
  const en = rawGet(raw, 'SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, KEY_ENABLED]);
  if (!en || String(en.value) !== '1') return 'auto_disabled';
  if (b.auto_epoch == null || b.auto_product_version == null) return 'auto_version_unproven';
  const epr = rawGet(raw, 'SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, KEY_EPOCH]);
  const cur = Math.trunc(Number(epr && epr.value)) || 0;
  if (Number(b.auto_epoch) !== Number(ev.epoch) || Number(b.auto_epoch) !== cur) return 'auto_epoch_stale';
  const p = rawGet(raw, 'SELECT restock_auto_notify, restock_auto_version FROM products WHERE id=? AND store_id=?', [Number(b.product_id), storeId]);
  if (!p) return 'product_missing';
  if (Number(p.restock_auto_notify || 0) !== 1) return 'auto_product_not_participating';
  if (Number(p.restock_auto_version) !== Number(b.auto_product_version)) return 'auto_product_version_stale';
  return '';
}
// 過時自動批次的落地（同一交易內）：
//   - 從未交給 LINE（attempt_count=0）的 pending／retry_wait／held：狀態維持（未送出、未受理），記錄 exclusion_reason=原因，
//     並釋放週期名額（claim=NULL）→ 不會被標成已受理／已通知；新基線的合法通知可再通知同一登記，
//     店家明確續送（人工接手）時重新取得名額（見 restockNotify.resumeBatch），同週期已被占用則擋下。
//   - 曾交給 LINE 的項目（retry_wait／unknown 等，attempt_count>0）原樣保留：retry key、名額與錯誤代碼都不動，不換 key 重送。
//   - accepted／failed／blocked／excluded 原樣保留。
//   - 批次 sending／paused → paused（pause_reason=原因）；previewed（尚未確認、沒有逐筆紀錄）→ expired（pause_reason=原因）。
//   - 只有 sending 中的 worker、店家明確續送會再處理這些項目；暫停原因不是 server_restart，重啟不會自動撿回。
// C6.1 補修：批次已因「需要店家處理的外部原因」暫停時（總開關、設定、授權、額度、權杖、worker 例外），保留該暫停原因不覆寫；
//   版本失效原因記在被釋放的逐筆項目 exclusion_reason 上，兩者都可追查。
const EXTERNAL_PAUSE = ['send_disabled', 'config_incomplete', 'auth_error', 'monthly_limit', 'not_configured', 'worker_error'];
function applyStaleRaw(raw, batchUuid, reason) {
  raw.run(`UPDATE restock_notify_deliveries SET exclusion_reason=?, claim=NULL, next_attempt_at=NULL, updated_at=datetime('now')
           WHERE batch_uuid=? AND status IN ('pending','retry_wait','held') AND attempt_count=0`, [reason, batchUuid]);
  const released = raw.getRowsModified();
  raw.run(`UPDATE restock_notify_batches SET status='paused',
             pause_reason=CASE WHEN status='paused' AND pause_reason IN (${EXTERNAL_PAUSE.map(() => '?').join(',')}) THEN pause_reason ELSE ? END,
             updated_at=datetime('now') WHERE batch_uuid=? AND status IN ('sending','paused')`, [...EXTERNAL_PAUSE, reason, batchUuid]);
  raw.run(`UPDATE restock_notify_batches SET status='expired', pause_reason=?, updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'`, [reason, batchUuid]);
  return released;
}
// C6.1 補修：worker 的每個停止／暫停收尾共用。交易內重新讀取目前資料判定；只有確定過期的自動批次才釋放
//   從未交給 LINE（attempt_count=0）項目的名額；手動、已人工接手、版本仍有效者不動。可重複執行。
function releaseIfStaleRaw(raw, storeId, batchUuid) {
  const why = staleReasonRaw(raw, storeId, batchUuid);
  if (why) applyStaleRaw(raw, batchUuid, why);
  return why;
}
// 開關／商品參與變更時：同店（可限定商品）未在執行中的自動批次（paused／previewed）立即依新狀態判定。
// sending 中的批次由 worker 在下一筆 claim 前判定（不在這裡改動正在送出的列）。
function staleSweepRaw(raw, storeId, productId) {
  const rows = rawAll(raw, `SELECT batch_uuid FROM restock_notify_batches WHERE store_id=? AND source='auto' AND COALESCE(taken_over_by,'')=''
                            AND COALESCE(import_source,'')='' AND status IN ('paused','previewed')${productId ? ' AND product_id=?' : ''}`, productId ? [storeId, Number(productId)] : [storeId]);
  let n = 0;
  for (const r of rows) { const why = staleReasonRaw(raw, storeId, r.batch_uuid); if (why) { applyStaleRaw(raw, r.batch_uuid, why); n++; } }
  return n;
}

// ── 測試掛勾（正式服務預設不啟用）──
function testHooksEnabled() {
  return process.env.RESTOCK_AUTO_TEST_HOOKS === '1' && !!process.env.RESTOCK_AUTO_TEST_GATE_DIR && process.env.NODE_ENV !== 'production';
}
async function testGate(name, info) {
  if (!testHooksEnabled()) return;
  const dir = process.env.RESTOCK_AUTO_TEST_GATE_DIR;
  if (!fs.existsSync(path.join(dir, 'hold_' + name))) return;
  fs.writeFileSync(path.join(dir, 'reached_' + name), JSON.stringify(info || {}));
  while (!fs.existsSync(path.join(dir, 'release_' + name))) await new Promise((r) => setTimeout(r, 20));
}

// 沿用既有批次（同一事件、同一取餐方式）。previewed 才需要確認；其他狀態尊重原紀錄。
//   回傳 detail（result: batch／existing_batch／stopped）與是否算「已建立通知批次」。
async function continueAutoBatch(db, storeId, ev, b, mode) {
  const RNX = RN;
  if (b.status !== 'previewed') {
    if (['sending', 'paused', 'completed'].includes(b.status)) return { counted: true, detail: { mode, date: b.supply_date, result: 'existing_batch', batch_uuid: b.batch_uuid, status: b.status } };
    return { counted: false, detail: { mode, date: b.supply_date, result: 'stopped', batch_uuid: b.batch_uuid, reason: String(b.pause_reason || b.status) } };
  }
  const stop = (reason) => {
    db.runDurableTransaction(() => { db._db.run("UPDATE restock_notify_batches SET status='expired', pause_reason=?, updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'", [reason, b.batch_uuid]); });
    return { counted: false, detail: { mode, date: b.supply_date, result: 'stopped', batch_uuid: b.batch_uuid, reason } };
  };
  // 下列檢查與確認之間沒有 await：同一程序內不會被其他寫入插隊（開關、商品參與、設定都在同一個執行緒的 durable 交易內）
  const why = staleReasonRaw(db._db, storeId, b.batch_uuid);
  if (why) return stop(why);
  const cap = RNX.getCapability(db, storeId);
  if (!cap.send_enabled) return stop('send_disabled');
  if (!cap.config_complete) return stop('config_incomplete');
  const exp = Date.parse(String(b.preview_expires_at || '').replace(' ', 'T') + 'Z');
  if (!Number.isFinite(exp) || exp <= Date.now()) return stop('preview_expired');
  const gate = RNX.productGate(db, storeId, Number(b.product_id), b.fulfillment_mode, b.supply_date);
  if (!gate.ok) return stop(gate.reason === 'collect_disabled' ? 'collect_disabled' : 'date_not_orderable:' + gate.reason);
  let cf;
  try { cf = RNX.confirmBatch(db, storeId, b.batch_uuid, 'auto:' + ev.event_uuid, { startWorker: false }); }
  catch (e) {
    const code = e && e.code === 'PREVIEW_EXPIRED' ? 'preview_expired' : (e && e.code === 'BATCH_CONTEXT_MISMATCH' ? 'link_mismatch' : 'confirm_error:' + String(e && (e.code || e.message) || '').slice(0, 60));
    const cur = db.get('SELECT status FROM restock_notify_batches WHERE batch_uuid=?', [b.batch_uuid]);
    if (cur && cur.status === 'previewed') return stop(code);
    return { counted: false, detail: { mode, date: b.supply_date, result: 'stopped', batch_uuid: b.batch_uuid, reason: code } };
  }
  if (cf.already) return { counted: ['sending', 'paused', 'completed'].includes(cf.status), detail: { mode, date: b.supply_date, result: 'existing_batch', batch_uuid: b.batch_uuid, status: cf.status } };
  await testGate('after_confirm', { event_uuid: ev.event_uuid, batch_uuid: b.batch_uuid, mode });
  if (cf.queued) RNX.startWorker(db, storeId, b.batch_uuid); // worker 每一筆送出前仍會重新核對版本與資格
  let ex = {};
  try { const pj = JSON.parse(b.preview_json || '{}'); ex = pj.stats && pj.stats.exclusions ? Object.fromEntries(Object.entries(pj.stats.exclusions).filter(([, v]) => v)) : {}; } catch {}
  return { counted: true, detail: { mode, date: b.supply_date, notice_kind: b.notice_kind, result: 'batch', batch_uuid: b.batch_uuid, queued: cf.queued || 0, excluded: cf.excluded || 0, exclusions: ex, ...(cf.queued ? {} : { reason: 'no_eligible_recipient_at_confirm' }) } };
}

async function processEvent(db, storeId, ev) {
  // 發送前的全面重新檢查（事件建立後狀態可能已變）
  if (!isEnabled(db, storeId)) return skip('auto_disabled', expireEventPreviews(db, storeId, ev, 'auto_disabled'));
  if (Number(ev.epoch) !== currentEpoch(db, storeId)) return skip('auto_reenabled_new_baseline', expireEventPreviews(db, storeId, ev, 'auto_epoch_stale'));
  // C6.1：事件沒有商品參與版本（C6 舊資料）→ 無法證明版本，暫停待店家確認，不自動發送
  if (ev.product_auto_version == null) return { status: 'needs_review', reason: 'legacy_event_unverified', details: expireEventPreviews(db, storeId, ev, 'legacy_unverified'), batches: [] };
  const created = Date.parse(String(ev.created_at || '').replace(' ', 'T') + 'Z');
  if (Number.isFinite(created) && Date.now() - created > EVENT_MAX_AGE_MS) return skip('event_stale', expireEventPreviews(db, storeId, ev, 'event_stale'));
  const cap = RN.getCapability(db, storeId);
  if (!cap.send_enabled) return skip('send_disabled', expireEventPreviews(db, storeId, ev, 'send_disabled'));
  if (!cap.config_complete) return skip('config_incomplete', expireEventPreviews(db, storeId, ev, 'config_incomplete'));
  const prod = db.get('SELECT * FROM products WHERE id=? AND store_id=?', [Number(ev.product_id), storeId]);
  if (!prod) return skip('product_missing', expireEventPreviews(db, storeId, ev, 'product_missing'));
  if (Number(prod.restock_auto_notify || 0) !== 1) return skip('product_not_participating', expireEventPreviews(db, storeId, ev, 'auto_product_not_participating'));
  if (Number(prod.restock_auto_version) !== Number(ev.product_auto_version)) return skip('product_version_stale', expireEventPreviews(db, storeId, ev, 'auto_product_version_stale'));
  let modes = [];
  try { modes = JSON.parse(ev.modes_json || '[]'); } catch { modes = []; }
  const details = [], batches = [];
  for (const m of modes.slice().sort((a, b) => MODE_PRIORITY.indexOf(a.mode) - MODE_PRIORITY.indexOf(b.mode))) {
    // 冪等：同一事件、同一取餐方式「任何狀態」的既有批次都沿用，不重建（C6.1：不再把找到既有批次直接當成完成）
    const prev = db.get("SELECT * FROM restock_notify_batches WHERE store_id=? AND source='auto' AND auto_event_uuid=? AND fulfillment_mode=? ORDER BY id DESC LIMIT 1", [storeId, ev.event_uuid, m.mode]);
    if (prev) {
      const r = await continueAutoBatch(db, storeId, ev, prev, m.mode);
      details.push(r.detail); if (r.counted) batches.push(prev.batch_uuid);
      continue;
    }
    // 日期在事件建立後失效（截止、額度歸零、停售…）→ 不換日期，記錄原因
    const gate = RN.productGate(db, storeId, Number(ev.product_id), m.mode, m.date);
    if (!gate.ok) { details.push({ mode: m.mode, date: m.date, result: 'skipped', reason: gate.reason === 'collect_disabled' ? 'collect_disabled' : 'date_not_orderable:' + gate.reason }); continue; }
    const pv = RN.previewBatch(db, storeId, { product_id: Number(ev.product_id), fulfillment_mode: m.mode, supply_date: m.date }, 'auto:' + ev.event_uuid,
      { source: 'auto', event_uuid: ev.event_uuid, auto_epoch: Number(ev.epoch), auto_product_version: Number(ev.product_auto_version) });
    if (!pv.batch_uuid) {
      const ex = pv.stats && pv.stats.exclusions ? Object.fromEntries(Object.entries(pv.stats.exclusions).filter(([, v]) => v)) : {};
      details.push({ mode: m.mode, date: m.date, result: 'skipped', reason: (pv.blockers || []).join(',') || 'not_sendable', exclusions: ex });
      continue;
    }
    // 預覽已 durable 保存；之後的確認與重啟恢復走同一條路（continueAutoBatch）
    await testGate('after_preview', { event_uuid: ev.event_uuid, batch_uuid: pv.batch_uuid, mode: m.mode });
    const b = db.get('SELECT * FROM restock_notify_batches WHERE batch_uuid=? AND store_id=?', [pv.batch_uuid, storeId]);
    const r = await continueAutoBatch(db, storeId, ev, b, m.mode);
    details.push(r.detail); if (r.counted) batches.push(pv.batch_uuid);
  }
  if (!batches.length) return skip(details.map((d) => d.reason).filter(Boolean)[0] || 'no_mode_sendable', details);
  return { status: 'completed', reason: '', details, batches };
}
// 事件不再處理時，把它尚未確認的預覽作廢並記錄原因（不建立逐筆紀錄、不占名額）
function expireEventPreviews(db, storeId, ev, reason) {
  const out = [];
  const rows = db.all("SELECT batch_uuid, fulfillment_mode, supply_date FROM restock_notify_batches WHERE store_id=? AND source='auto' AND auto_event_uuid=? AND status='previewed'", [storeId, ev.event_uuid]);
  if (!rows.length) return out;
  db.runDurableTransaction(() => {
    for (const r of rows) {
      db._db.run("UPDATE restock_notify_batches SET status='expired', pause_reason=?, updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'", [reason, r.batch_uuid]);
      out.push({ mode: r.fulfillment_mode, date: r.supply_date, result: 'stopped', batch_uuid: r.batch_uuid, reason });
    }
  });
  return out;
}

// ══════════════════════════════════════════════════════════════════════
//  啟動與定期：恢復合法工作（不把匯入資料當成新工作）
// ══════════════════════════════════════════════════════════════════════
function bootRecover(db) {
  const out = { requeued: 0, resumed_batches: 0, stale_batches: 0, legacy_review: 0, stores: [] };
  db.runDurableTransaction(() => {
    const raw = db._db;
    raw.run("UPDATE restock_auto_events SET status='queued' WHERE status='processing' AND import_source=''");
    out.requeued = raw.getRowsModified();
    // C6.1：舊 C6 可能留下「事件已完成＋自動批次停在 previewed＋沒有逐筆紀錄」。
    //   能證明版本（C6.1 建立：批次有 auto_epoch／auto_product_version）→ 事件改回排隊，由 continueAutoBatch 重新驗證後沿用同一批次；
    //   無法證明（C6 舊資料：版本為 NULL）→ 作廢該預覽、事件標為待店家確認，不套用目前版本自動發送。
    const orphans = rawAll(raw, `SELECT b.batch_uuid, b.store_id, b.auto_epoch, b.auto_product_version, e.event_uuid, e.status AS est, e.detail_json
                                 FROM restock_notify_batches b JOIN restock_auto_events e ON e.event_uuid=b.auto_event_uuid AND e.store_id=b.store_id
                                 WHERE b.source='auto' AND b.status='previewed' AND COALESCE(b.import_source,'')='' AND COALESCE(b.taken_over_by,'')=''
                                   AND e.import_source='' AND e.status IN ('completed','skipped','failed')
                                   AND NOT EXISTS (SELECT 1 FROM restock_notify_deliveries d WHERE d.batch_uuid=b.batch_uuid)`);
    for (const o of orphans) {
      if (o.auto_epoch == null || o.auto_product_version == null) {
        raw.run("UPDATE restock_notify_batches SET status='expired', pause_reason='legacy_unverified', updated_at=datetime('now') WHERE batch_uuid=? AND status='previewed'", [o.batch_uuid]);
        let det = []; try { det = JSON.parse(o.detail_json || '[]'); } catch {}
        det.push({ result: 'stopped', batch_uuid: o.batch_uuid, reason: 'legacy_unverified' });
        raw.run("UPDATE restock_auto_events SET status='needs_review', reason='legacy_preview_unverified', detail_json=? WHERE event_uuid=?", [JSON.stringify(det), o.event_uuid]);
        out.legacy_review++;
      } else {
        raw.run("UPDATE restock_auto_events SET status='queued' WHERE event_uuid=? AND status IN ('completed','skipped','failed')", [o.event_uuid]);
        out.requeued++;
      }
    }
    // 暫停中的自動批次（未接手、非匯入）：版本或開關已不符者立即落地（釋放未送出項目的名額）；不改動符合者
    const stores = rawAll(raw, "SELECT DISTINCT store_id FROM restock_notify_batches WHERE source='auto' AND status IN ('paused','previewed')");
    for (const st of stores) out.stale_batches += staleSweepRaw(raw, st.store_id, null);
  });
  const stores = db.all("SELECT DISTINCT store_id FROM restock_auto_events WHERE status='queued' UNION SELECT DISTINCT store_id FROM restock_notify_batches WHERE source='auto' AND status='paused' AND pause_reason='server_restart'");
  for (const s of stores) {
    const sid = s.store_id;
    if (isEnabled(db, sid) && RN.getCapability(db, sid).notify_available) {
      // 自動批次因重啟暫停：只續送「從未交給 LINE」的項目（pending／retry_wait，沿用原 retry key）；結果不明者維持待店家確認。
      // C6.1：續送前以 staleReasonRaw 核對同事件、epoch、商品參與與版本（舊批次無版本 → 不續送）。
      const bs = db.all(`SELECT b.batch_uuid FROM restock_notify_batches b
                         WHERE b.store_id=? AND b.source='auto' AND b.status='paused' AND b.pause_reason='server_restart' AND COALESCE(b.import_source,'')=''
                           AND COALESCE(b.taken_over_by,'')=''`, [sid]);
      for (const b of bs) {
        let ok = false;
        db.runDurableTransaction(() => {
          if (staleReasonRaw(db._db, sid, b.batch_uuid)) return;
          const open = rawGet(db._db, "SELECT COUNT(*) AS c FROM restock_notify_deliveries WHERE batch_uuid=? AND status IN ('pending','retry_wait') AND attempt_count < max_attempts", [b.batch_uuid]);
          if (open && Number(open.c) > 0) {
            db._db.run("UPDATE restock_notify_batches SET status='sending', pause_reason='', updated_at=datetime('now') WHERE batch_uuid=? AND status='paused'", [b.batch_uuid]);
            ok = db._db.getRowsModified() === 1;
          }
        });
        if (ok) { RN.startWorker(db, sid, b.batch_uuid); out.resumed_batches++; }
      }
    }
    out.stores.push(sid);
    kick(db, sid);
  }
  return out;
}
function sweep(db) {
  const stores = db.all("SELECT DISTINCT store_id FROM restock_auto_events WHERE status='queued'");
  for (const s of stores) kick(db, s.store_id);
  return stores.length;
}

// ══════════════════════════════════════════════════════════════════════
//  查詢（後台紀錄）
// ══════════════════════════════════════════════════════════════════════
function listEvents(db, storeId, q = {}) {
  const params = [storeId];
  let extra = '';
  if (q.product_id != null && q.product_id !== '' && Number.isInteger(Number(q.product_id))) { extra += ' AND product_id=?'; params.push(Number(q.product_id)); }
  const lim = Math.max(1, Math.min(200, Math.trunc(Number(q.limit) || 50)));
  return db.all(`SELECT * FROM restock_auto_events WHERE store_id=?${extra} ORDER BY id DESC LIMIT ?`, [...params, lim]).map((e) => {
    const j = (s, d) => { try { return JSON.parse(s); } catch { return d; } };
    return {
      event_uuid: e.event_uuid, product_id: e.product_id, product_name: e.product_name, trigger_source: e.trigger_source, trigger_fields: j(e.trigger_fields, {}),
      modes: j(e.modes_json, []), status: e.status, reason: e.reason, details: j(e.detail_json, []), batch_uuids: j(e.batch_uuids, []),
      created_at: e.created_at, completed_at: e.completed_at, actor: e.actor, import_source: e.import_source || '',
      before: j(e.before_json, {}), after: j(e.after_json, {}),
    };
  });
}

module.exports = {
  KEY_ENABLED, KEY_EPOCH, MODE_PRIORITY, RULES, migrate, isEnabled, currentEpoch, getConfig, setEnabled, setProductParticipation,
  nearestDates, captureBefore, triggerFields, recordAfterInTx, kick, waitIdle, processQueued, processEvent, bootRecover, sweep, listEvents,
  staleReasonRaw, applyStaleRaw, staleSweepRaw, testHooksEnabled, // C6.1
  releaseIfStaleRaw, // C6.1 補修
};
