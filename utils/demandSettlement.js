// utils/demandSettlement.js — R54.4／MBV2-HF1-C6.2：補貨登記份數與訂單連動（訂單商品 → 會員登記週期 → 對應份數）
//
// 份數定義（後台統計、會員「我的補貨登記」、商品卡、CSV 匯出共用）
//   原登記 registered ＝ desired_qty（顧客登記的份數；本週期的目標）
//   已完成 settled    ＝ min(settled_qty, desired_qty)（有效訂單已成立、實際扣減的份數）
//   剩餘   remaining  ＝ max(0, desired_qty − settled_qty)
//   訂購中 reserved   ＝ min(待付款訂單綁定份數, remaining)（LINE Pay 已建立訂單、等待付款）
//   尚待購買 to_buy   ＝ remaining − reserved
//
// 訂單關聯 product_demand_order_links（每張訂單、每個商品一列；唯一索引 store_id＋order_uuid＋product_id）
//   - 以「穩定訂單 UUID＋商品＋登記週期 request_uuid」識別，不使用顯示訂單編號。
//   - 綁定在訂單建立的同一個 durable 交易內（SAVEPOINT：綁定失敗只回滾綁定本身，不影響訂單；之後以獨立交易補綁一次）。
//   - 只綁定「下單當下」本人有效（active 且未過期）的登記週期；之後只會影響該週期（不會扣到後來的新週期）。
//   - 綁定時記錄訂單該商品份數 order_qty；實際扣減時才以「當時剩餘」計算 applied_qty（不會扣成負數或超過原登記）。
//   - state：reserved（訂購中）｜settled（已扣減）｜released（解除訂購中，需求保留）｜reverted（取消回復，終態）｜review（待核對，不自動處理）
//
// 狀態對應（只依後端確認的訂單／付款狀態；不讀前端「結帳成功」文字）
//   開啟通知、預選數量、加入或移除購物車 → 不建立任何關聯、不扣減
//   現金與其他非 LINE Pay 付款：後端建立有效訂單（同一交易）→ settled
//   LINE Pay：建立訂單 → reserved；orders.payment_status='paid'（commitPaid 交易）→ settled
//   LINE Pay 付款失敗（付款嘗試 failed／aborted_cancelled）或逾期（付款請求超過保留時間仍未送出 Confirm）→ released；
//     之後若查得已付款（待核對恢復）→ settled
//   有效訂單在未履約前取消（applyOrderStatusChange 取消、未完成訂單作廢）→ 依原綁定回復（reverted），只回復當時扣減的 applied_qty
//   已完成（已履約）訂單作廢、或無法確認作廢前狀態 → review（不自動回復、不重建需求或通知同意）
//   C6.2 狀態邊界修正：
//   - 作廢前履約狀態一律經 classifyVoidPrior() 分類（即時 hook、啟動補齊、定期補齊共用）：
//       completed＝已履約；pending／accepted／preparing／ready／delivering＝有證據的未履約；cancelled＝已取消；
//       NULL、空字串、其他值、沒有作廢待辦＝未知 → 待核對，不自動回復（不從付款或紀錄狀態反推）。
//   - 延遲綁定與「成立／付款／履約／作廢」交錯：結果與準時綁定再經過相同事件一致。
//       已履約（或履約未知）作廢＋購買證據（非 LINE Pay 有效訂單，或後端確認 paid）→ 先依原週期補記扣減，再轉 review（保留份數）；
//       沒有購買證據（LINE Pay 未付款／付款不明）→ review、扣 0（payment_unconfirmed），不因履約欄位推定已付款。
//   - 新增扣減前，在同一交易內核對原週期狀態與實際有效期限（julianday，UTC，與既有 expires_at 規則同一時間基準）：
//       自然到期（status 仍 active）→ 扣 0（cycle_closed:expired_at）；期限無法解析 → review、扣 0（cycle_validity_unknown）。
//       已扣減的歷史份數不重新判斷期限（不清除、不重複回復）。
//   - 基準已產生的錯誤終態：只依可信證據補處理（repairLegacy，啟動補齊執行；可重複執行）。
//   已履約後退款：不處理（不自動重新建立需求或通知同意）
//
// 防重：所有轉換都以「目前 state」為條件（UPDATE … WHERE state IN (…)），同一訂單重複 callback、查詢、恢復、補登、重啟只會套用一次。
// 歷史：不刪除任何登記或關聯；登記完成改為 status='completed'（移出有效需求統計），仍可在後台明細與匯出查詢。
// 不發送任何通知、不建立或修改通知同意、不改動訂單。所有呼叫端都 fail-open（失敗只記錄，不阻擋訂單或付款）。
'use strict';

const crypto = require('crypto');

const LINK_TABLE = 'product_demand_order_links';
// LINE Pay 付款請求的保留時間（LINE Pay 付款網址預設 20 分鐘失效；保留 30 分鐘後仍未送出 Confirm 視為逾期）
const LP_RESERVE_TTL_SEC = (() => {
  const v = Math.trunc(Number(process.env.PD_SETTLE_LP_TTL_SEC));
  return Number.isFinite(v) && v >= 1 ? v : 1800;
})();
const LIVE_ATTEMPT_STATES = ['confirm_pending', 'review', 'paid_duplicate', 'imported_history'];
const OPEN_REQUEST_STATES = ['requesting', 'requested'];

function rawAll(raw, sql, params) { const st = raw.prepare(sql); try { if (params) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); } }
function rawGet(raw, sql, params) { return rawAll(raw, sql, params)[0] || null; }
function colNames(raw, t) { try { return rawAll(raw, `PRAGMA table_info(${t})`).map((c) => c.name); } catch { return []; } }

// ══════════════════════════════════════════════════════════════════════
//  遷移（additive、idempotent；不刪資料、不重建表、不回溯處理升級前的歷史訂單）
// ══════════════════════════════════════════════════════════════════════
function migrate(raw) {
  const rc = colNames(raw, 'product_demand_requests');
  if (!rc.length) return { ok: false };
  if (!rc.includes('settled_qty')) raw.run('ALTER TABLE product_demand_requests ADD COLUMN settled_qty INTEGER DEFAULT 0');
  if (!rc.includes('completed_at')) raw.run('ALTER TABLE product_demand_requests ADD COLUMN completed_at TEXT DEFAULT NULL');
  raw.run(`CREATE TABLE IF NOT EXISTS ${LINK_TABLE} (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    link_uuid       TEXT NOT NULL,
    store_id        TEXT NOT NULL,
    order_uuid      TEXT NOT NULL,
    order_number    TEXT DEFAULT '',
    product_id      INTEGER NOT NULL,
    request_uuid    TEXT NOT NULL,
    line_user_id    TEXT NOT NULL,
    order_qty       INTEGER NOT NULL DEFAULT 0,
    applied_qty     INTEGER NOT NULL DEFAULT 0,
    state           TEXT NOT NULL DEFAULT 'reserved',
    payment_method  TEXT DEFAULT '',
    note            TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now')),
    updated_at      TEXT DEFAULT (datetime('now')),
    settled_at      TEXT DEFAULT NULL,
    released_at     TEXT DEFAULT NULL,
    reverted_at     TEXT DEFAULT NULL,
    import_source   TEXT DEFAULT ''
  )`);
  raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdol_uuid ON ${LINK_TABLE}(link_uuid)`);
  raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdol_order_product ON ${LINK_TABLE}(store_id, order_uuid, product_id)`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_pdol_request ON ${LINK_TABLE}(store_id, request_uuid, state)`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_pdol_state ON ${LINK_TABLE}(state, store_id)`);
  migrateTasks(raw); // C6.2 補修：持久化待辦與補齊游標（additive、idempotent；不回溯建立歷史訂單的待辦）
  // 回退期間舊版修改份數後可能出現「已完成份數 ≥ 原登記」仍為有效：視為已完成（不改份數、不刪資料）
  raw.run(`UPDATE product_demand_requests SET status='completed', completed_at=COALESCE(completed_at, datetime('now')), updated_at=datetime('now')
           WHERE status='active' AND COALESCE(settled_qty,0) > 0 AND COALESCE(settled_qty,0) >= desired_qty`);
  return { ok: true };
}

// ══════════════════════════════════════════════════════════════════════
//  份數計算（共用定義）
// ══════════════════════════════════════════════════════════════════════
function qtyView(desired, settledRaw, reservedRaw) {
  const d = Math.max(0, Number(desired) || 0);
  const s = Math.min(d, Math.max(0, Number(settledRaw) || 0));
  const remaining = Math.max(0, d - (Number(settledRaw) || 0));
  const reserved = Math.min(remaining, Math.max(0, Number(reservedRaw) || 0));
  return { registered_qty: d, settled_qty: s, remaining_qty: remaining, reserved_qty: reserved, to_buy_qty: remaining - reserved };
}
// 某些登記週期目前「訂購中」的訂單份數（未截斷）
function reservedMap(db, storeId, requestUuids) {
  const m = new Map();
  if (!requestUuids || !requestUuids.length) return m;
  const uniq = [...new Set(requestUuids.filter(Boolean).map(String))];
  for (let i = 0; i < uniq.length; i += 200) {
    const part = uniq.slice(i, i + 200);
    const rows = db.all(`SELECT request_uuid, SUM(order_qty) AS q FROM ${LINK_TABLE} WHERE store_id=? AND state='reserved' AND request_uuid IN (${part.map(() => '?').join(',')}) GROUP BY request_uuid`,
      [storeId, ...part]);
    for (const r of rows) m.set(String(r.request_uuid), Number(r.q) || 0);
  }
  return m;
}
function linksForRequest(db, storeId, requestUuid) {
  return db.all(`SELECT l.order_uuid, l.order_number, l.product_id, l.order_qty, l.applied_qty, l.state, l.payment_method, l.note, l.created_at, l.settled_at, l.released_at, l.reverted_at,
                        COALESCE(l.import_source,'') AS import_source, o.order_status, o.payment_status, o.status AS order_record_status, o.refund_status
                 FROM ${LINK_TABLE} l LEFT JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
                 WHERE l.store_id=? AND l.request_uuid=? ORDER BY l.id ASC`, [storeId, String(requestUuid || '')]);
}

// ══════════════════════════════════════════════════════════════════════
//  原子操作（只在 durable 交易內以 raw 執行；全部以目前 state 為條件，重複呼叫不重複套用）
// ══════════════════════════════════════════════════════════════════════
// C6.2 狀態邊界修正：原週期實際有效性（只用於「新增扣減」；同一交易內、資料庫 UTC 時間基準）
//   'valid'｜'expired'（status 仍 active 但 expires_at 已過）｜'unknown'（NULL、空白或無法解析）
function cycleValidity(raw, req) {
  const e = req && req.expires_at != null ? String(req.expires_at).trim() : '';
  if (!e) return 'unknown';
  const v = rawGet(raw, "SELECT julianday(?) AS e, julianday('now') AS n", [e]);
  if (!v || v.e == null || v.n == null) return 'unknown';
  return Number(v.e) > Number(v.n) ? 'valid' : 'expired';
}
function settleRaw(raw, link) {
  const req = rawGet(raw, 'SELECT * FROM product_demand_requests WHERE store_id=? AND request_uuid=?', [link.store_id, link.request_uuid]);
  let applied = 0, note = '', complete = 0, ns = 0, validity = null;
  if (!req) note = 'cycle_missing';
  else if ((req.status === 'active' || req.status === 'completed') && (validity = cycleValidity(raw, req)) !== 'valid') {
    note = validity === 'expired' ? 'cycle_closed:expired_at' : 'cycle_validity_unknown';
  } else if (req.status === 'active' || req.status === 'completed') {
    const desired = Math.max(0, Number(req.desired_qty) || 0);
    const settled = Math.max(0, Number(req.settled_qty) || 0);
    const rem = Math.max(0, desired - settled);
    applied = Math.min(Math.max(0, Number(link.order_qty) || 0), rem);
    ns = settled + applied;
    complete = applied > 0 && req.status === 'active' && ns >= desired ? 1 : 0;
    note = applied > 0 ? (complete ? 'completed' : '') : 'nothing_remaining';
  } else note = 'cycle_closed:' + req.status;
  if (validity === 'unknown') {
    // 沒有可靠有效性證據：不扣減，轉待核對（可由關聯查到原因）
    raw.run(`UPDATE ${LINK_TABLE} SET state='review', applied_qty=0, note=?, updated_at=datetime('now') WHERE id=? AND state IN ('reserved','released')`, [note, link.id]);
    return { changed: raw.getRowsModified() === 1, applied: 0, review: true };
  }
  // 先以目前 state 為條件轉換關聯（防重），成功後才扣減登記
  raw.run(`UPDATE ${LINK_TABLE} SET state='settled', applied_qty=?, settled_at=datetime('now'), note=?, updated_at=datetime('now')
           WHERE id=? AND state IN ('reserved','released')`, [applied, note, link.id]);
  const changed = raw.getRowsModified() === 1;
  if (changed && applied > 0) {
    raw.run(`UPDATE product_demand_requests SET settled_qty=?, status=CASE WHEN ?=1 THEN 'completed' ELSE status END,
               completed_at=CASE WHEN ?=1 THEN datetime('now') ELSE completed_at END, updated_at=datetime('now') WHERE id=?`, [ns, complete, complete, req.id]);
  }
  return { changed, applied: changed ? applied : 0 };
}
function revertRaw(raw, link, reason) {
  let note = reason || 'order_cancelled';
  const applied = Math.max(0, Number(link.applied_qty) || 0);
  const req = applied > 0 ? rawGet(raw, 'SELECT * FROM product_demand_requests WHERE store_id=? AND request_uuid=?', [link.store_id, link.request_uuid]) : null;
  let ns = 0, reopen = 0;
  if (applied > 0 && req) {
    const settled = Math.max(0, Number(req.settled_qty) || 0);
    ns = Math.max(0, settled - applied);
    if (req.status === 'completed' && ns < Number(req.desired_qty)) {
      // 只在同一週期仍在有效期限內、且本人此商品沒有另一個有效週期時才恢復為有效（不復活取消／過期週期、不覆寫新週期）
      const live = rawGet(raw, "SELECT 1 AS x FROM product_demand_requests WHERE id=? AND expires_at > datetime('now')", [req.id]);
      const other = rawGet(raw, "SELECT 1 AS x FROM product_demand_requests WHERE store_id=? AND product_id=? AND line_user_id=? AND status='active' AND id<>?",
        [req.store_id, req.product_id, req.line_user_id, req.id]);
      reopen = live && !other ? 1 : 0;
      note += reopen ? ':reopened' : ':cycle_not_reopened';
    } else if (req.status !== 'active' && req.status !== 'completed') note += ':cycle_closed:' + req.status;
  } else if (applied > 0) note += ':cycle_missing';
  raw.run(`UPDATE ${LINK_TABLE} SET state='reverted', reverted_at=datetime('now'), note=?, updated_at=datetime('now') WHERE id=? AND state='settled'`, [note, link.id]);
  const changed = raw.getRowsModified() === 1;
  if (changed && applied > 0 && req) {
    raw.run(`UPDATE product_demand_requests SET settled_qty=?, status=CASE WHEN ?=1 THEN 'active' ELSE status END,
               completed_at=CASE WHEN ?=1 THEN NULL ELSE completed_at END, updated_at=datetime('now') WHERE id=?`, [ns, reopen, reopen, req.id]);
  }
  return changed;
}
function releaseRaw(raw, link, reason) {
  raw.run(`UPDATE ${LINK_TABLE} SET state='released', released_at=datetime('now'), note=?, updated_at=datetime('now') WHERE id=? AND state='reserved'`, [reason || '', link.id]);
  return raw.getRowsModified() === 1;
}
function reReserveRaw(raw, link) {
  raw.run(`UPDATE ${LINK_TABLE} SET state='reserved', released_at=NULL, note='re_reserved', updated_at=datetime('now') WHERE id=? AND state='released'`, [link.id]);
  return raw.getRowsModified() === 1;
}
function reviewRaw(raw, link, reason) {
  raw.run(`UPDATE ${LINK_TABLE} SET state='review', note=?, updated_at=datetime('now') WHERE id=? AND state='settled'`, [reason || 'review', link.id]);
  return raw.getRowsModified() === 1;
}
// C6.2 狀態邊界修正：已履約（或履約未知）作廢、尚未扣減（延遲綁定或付款後才綁定）且有購買證據 →
//   先依原週期與可信份數補記扣減（含有效性核對），再轉待核對（保留份數）。同一交易內完成；任何一步失敗整筆回滾。
function _voidSettleRaw(raw, link, reason) {
  const r = settleRaw(raw, link);
  const cur = rawGet(raw, `SELECT state, applied_qty, note FROM ${LINK_TABLE} WHERE id=?`, [link.id]);
  if (cur && cur.state === 'settled') {
    const note = Number(cur.applied_qty) > 0 ? reason : `${reason}:${cur.note || 'nothing_applied'}`;
    raw.run(`UPDATE ${LINK_TABLE} SET state='review', note=?, updated_at=datetime('now') WHERE id=? AND state='settled'`, [note, link.id]);
  }
  return { changed: !!(r && r.changed), applied: r ? r.applied : 0 };
}
// 已履約（或履約未知）作廢、沒有購買證據（LINE Pay 未付款／付款不明）→ 不扣減，轉待核對
function unconfirmedReviewRaw(raw, link, reason) {
  raw.run(`UPDATE ${LINK_TABLE} SET state='review', applied_qty=0, note=?, updated_at=datetime('now') WHERE id=? AND state IN ('reserved','released')`,
    [`${reason}:payment_unconfirmed`, link.id]);
  return raw.getRowsModified() === 1;
}

// ══════════════════════════════════════════════════════════════════════
//  綁定（訂單建立交易內）
// ══════════════════════════════════════════════════════════════════════
function aggregateItems(items) {
  let arr = items;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr || '[]'); } catch { arr = []; } }
  const m = new Map();
  for (const it of Array.isArray(arr) ? arr : []) {
    const pid = Number(it && (it.product_id != null ? it.product_id : it.id));
    const q = Math.max(0, Math.trunc(Number(it && it.qty) || 0));
    if (!Number.isInteger(pid) || pid <= 0 || !q) continue;
    m.set(pid, (m.get(pid) || 0) + q);
  }
  return m;
}
// ══════════════════════════════════════════════════════════════════════
//  C6.2 補修：持久化待辦（product_demand_settle_tasks）
//    kind='bind'：訂單建立的同一個 durable 交易內，逐商品保存「當時經後端驗證的店別、會員、訂單 UUID、商品、
//                 登記 request_uuid／週期、canonical 份數、付款方式」。之後的補綁只使用這份證據，不重新尋找目前的有效登記。
//    kind='void'：作廢的同一個 durable 交易內，保存交易中重新讀取的原履約狀態（order_status）與紀錄狀態（status）。
//    state：pending（待處理）｜done（已完成）｜review（待核對：例如訂單已不存在）。
//    失敗：attempts＋1、next_at 退避（15 秒起倍增、最長 30 分鐘），不放棄；定期補齊以持久游標公平輪替處理；啟動時的補齊不等待退避。
// ══════════════════════════════════════════════════════════════════════
const TASK_TABLE = 'product_demand_settle_tasks';
const CURSOR_TABLE = 'product_demand_sweep_cursors';
const utcNow = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const backoffUtc = (attempts) => new Date(Date.now() + Math.min(15 * 2 ** Math.max(0, Math.min(attempts, 8) - 1), 1800) * 1000).toISOString().slice(0, 19).replace('T', ' ');
function migrateTasks(raw) {
  raw.run(`CREATE TABLE IF NOT EXISTS ${TASK_TABLE} (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    task_uuid           TEXT NOT NULL,
    store_id            TEXT NOT NULL,
    order_uuid          TEXT NOT NULL,
    order_number        TEXT DEFAULT '',
    kind                TEXT NOT NULL,
    product_id          INTEGER NOT NULL DEFAULT 0,
    line_user_id        TEXT DEFAULT '',
    request_uuid        TEXT DEFAULT '',
    cycle_no            INTEGER DEFAULT NULL,
    order_qty           INTEGER NOT NULL DEFAULT 0,
    payment_method      TEXT DEFAULT '',
    prior_order_status  TEXT DEFAULT NULL,
    prior_record_status TEXT DEFAULT NULL,
    state               TEXT NOT NULL DEFAULT 'pending',
    attempts            INTEGER NOT NULL DEFAULT 0,
    last_error          TEXT DEFAULT '',
    next_at             TEXT DEFAULT NULL,
    result              TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now')),
    updated_at          TEXT DEFAULT (datetime('now')),
    done_at             TEXT DEFAULT NULL
  )`);
  raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdst_uuid ON ${TASK_TABLE}(task_uuid)`);
  raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_pdst_order_kind_product ON ${TASK_TABLE}(store_id, order_uuid, kind, product_id)`);
  raw.run(`CREATE INDEX IF NOT EXISTS idx_pdst_state ON ${TASK_TABLE}(state, store_id, id)`);
  raw.run(`CREATE TABLE IF NOT EXISTS ${CURSOR_TABLE} (name TEXT PRIMARY KEY, last_id INTEGER NOT NULL DEFAULT 0, updated_at TEXT DEFAULT (datetime('now')))`);
}
// 訂單交易內：保存綁定意圖（不使用 SAVEPOINT；保存失敗＝訂單交易失敗，交由既有 durable 交易回滾）
// o: { storeId, orderUuid, orderNumber, lineUserId, items, paymentMethod }
function _recordIntentsRaw(raw, o) {
  let n = 0;
  for (const [pid, qty] of aggregateItems(o.items)) {
    const req = rawGet(raw, `SELECT request_uuid, cycle_no FROM product_demand_requests WHERE store_id=? AND product_id=? AND line_user_id=? AND status='active' AND expires_at > datetime('now')`,
      [o.storeId, pid, o.lineUserId]);
    if (!req) continue;
    raw.run(`INSERT OR IGNORE INTO ${TASK_TABLE} (task_uuid, store_id, order_uuid, order_number, kind, product_id, line_user_id, request_uuid, cycle_no, order_qty, payment_method, state, created_at, updated_at)
             VALUES (?,?,?,?,'bind',?,?,?,?,?,?,'pending',datetime('now'),datetime('now'))`,
    [crypto.randomUUID(), o.storeId, String(o.orderUuid), String(o.orderNumber || ''), pid, o.lineUserId, req.request_uuid, Number(req.cycle_no) || null, qty, String(o.paymentMethod || '')]);
    n += raw.getRowsModified() ? 1 : 0;
  }
  return n;
}
// 依待辦證據建立關聯（只用待辦保存的 request_uuid、會員、份數）；opts.settleNow：訂單交易內的非 LINE Pay 訂單立即扣減
function _applyTaskRaw(raw, task, opts = {}) {
  const ex = rawGet(raw, `SELECT * FROM ${LINK_TABLE} WHERE store_id=? AND order_uuid=? AND product_id=?`, [task.store_id, task.order_uuid, task.product_id]);
  if (!ex) {
    const o = rawGet(raw, 'SELECT uuid FROM orders WHERE store_id=? AND uuid=?', [task.store_id, task.order_uuid]);
    if (!o) {
      raw.run(`UPDATE ${TASK_TABLE} SET state='review', result='order_missing', updated_at=datetime('now') WHERE id=? AND state='pending'`, [task.id]);
      return { done: false, review: true };
    }
    raw.run(`INSERT INTO ${LINK_TABLE} (link_uuid, store_id, order_uuid, order_number, product_id, request_uuid, line_user_id, order_qty, applied_qty, state, payment_method, created_at, updated_at)
             VALUES (?,?,?,?,?,?,?,?,0,'reserved',?,datetime('now'),datetime('now'))`,
    [crypto.randomUUID(), task.store_id, task.order_uuid, task.order_number || '', task.product_id, task.request_uuid, task.line_user_id, Number(task.order_qty) || 0, task.payment_method || '']);
    if (opts.settleNow) {
      const link = rawGet(raw, `SELECT * FROM ${LINK_TABLE} WHERE store_id=? AND order_uuid=? AND product_id=?`, [task.store_id, task.order_uuid, task.product_id]);
      if (link) settleRaw(raw, link);
    }
  }
  raw.run(`UPDATE ${TASK_TABLE} SET state='done', result=?, done_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND state='pending'`, [ex ? 'link_exists' : 'linked', task.id]);
  return { done: true };
}
// 套用某訂單所有待處理的綁定待辦；每個商品各自一個 SAVEPOINT（部分成功不連帶回滾其他商品），失敗記錄嘗試次數與退避時間
function _bindRaw(raw, o) {
  const tasks = rawAll(raw, `SELECT * FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND kind='bind' AND state='pending' ORDER BY id`, [o.storeId, String(o.orderUuid)]);
  let bound = 0, failed = 0;
  for (const t of tasks) {
    raw.run('SAVEPOINT pd_task');
    try {
      const r = module.exports._applyTaskRaw(raw, t, { settleNow: !!o.settleNow });
      raw.run('RELEASE pd_task');
      if (r.done) bound++;
    } catch (e) {
      raw.run('ROLLBACK TO pd_task'); raw.run('RELEASE pd_task');
      failed++;
      raw.run(`UPDATE ${TASK_TABLE} SET attempts=attempts+1, last_error=?, next_at=?, updated_at=datetime('now') WHERE id=?`, [String(e && e.message || e).slice(0, 200), backoffUtc((Number(t.attempts) || 0) + 1), t.id]);
    }
  }
  return { bound, failed, tasks: tasks.length };
}
function _noteFailure(db, storeId, orderUuid, err) {
  try {
    db.runDurableTransaction(() => {
      for (const t of rawAll(db._db, `SELECT id, attempts FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND kind='bind' AND state='pending'`, [storeId, String(orderUuid)])) {
        db._db.run(`UPDATE ${TASK_TABLE} SET attempts=attempts+1, last_error=?, next_at=?, updated_at=datetime('now') WHERE id=?`, [String(err && err.message || err).slice(0, 200), backoffUtc((Number(t.attempts) || 0) + 1), t.id]);
      }
    });
  } catch { /* 記錄失敗也不影響；待辦仍為 pending，之後仍會處理 */ }
}
// 訂單交易內：先保存待辦（必須成功），再以 SAVEPOINT 嘗試立即綁定（失敗只回滾綁定，待辦保留）
function bindInTx(db, o) {
  if (!o || !o.lineUserId || !o.orderUuid) return { ok: true, bound: 0 };
  const raw = db._db;
  const n = module.exports._recordIntentsRaw(raw, o);
  if (!n) return { ok: true, bound: 0, recorded: 0 };
  let sp = false;
  try {
    raw.run('SAVEPOINT pd_settle_bind'); sp = true;
    const r = module.exports._bindRaw(raw, { ...o, settleNow: String(o.paymentMethod || '') !== 'linepay' });
    raw.run('RELEASE pd_settle_bind');
    return { ok: r.failed === 0, bound: r.bound, recorded: n };
  } catch (e) {
    if (sp) { try { raw.run('ROLLBACK TO pd_settle_bind'); raw.run('RELEASE pd_settle_bind'); } catch { /* 交易本身由呼叫端處理 */ } }
    return { ok: false, error: e && e.message, recorded: n };
  }
}
// 交易後（或定期補齊）處理某訂單的綁定待辦：獨立交易建立關聯，再依訂單目前狀態同步（扣減／訂購中／取消）
function processOrderTasks(db, storeId, orderUuid) {
  let r;
  try {
    db.runDurableTransaction(() => { r = module.exports._bindRaw(db._db, { storeId, orderUuid, settleNow: false }); });
  } catch (e) { _noteFailure(db, storeId, orderUuid, e); throw e; }
  const s = module.exports.syncOrder(db, storeId, orderUuid, {});
  return { ...r, changed: s.changed || 0 };
}
function bindLate(db, o) {
  if (!o || !o.lineUserId || !o.orderUuid) return { ok: true, bound: 0 };
  const r = processOrderTasks(db, o.storeId, o.orderUuid);
  return { ok: !r.failed, bound: r.bound };
}
// 作廢交易內（UPDATE 之前）：保存交易中重新讀取的原履約狀態；只有已綁定或有待處理綁定的訂單才需要
function recordVoidTaskRaw(raw, storeId, orderId) {
  const o = rawGet(raw, 'SELECT uuid, order_number, order_status, status FROM orders WHERE id=? AND store_id=?', [orderId, storeId]);
  if (!o || !o.uuid) return false;
  const has = rawGet(raw, `SELECT 1 AS x FROM ${LINK_TABLE} WHERE store_id=? AND order_uuid=? AND COALESCE(import_source,'')='' LIMIT 1`, [storeId, o.uuid])
    || rawGet(raw, `SELECT 1 AS x FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND kind='bind' AND state='pending' LIMIT 1`, [storeId, o.uuid]);
  if (!has) return false;
  raw.run(`INSERT OR IGNORE INTO ${TASK_TABLE} (task_uuid, store_id, order_uuid, order_number, kind, product_id, prior_order_status, prior_record_status, state, created_at, updated_at)
           VALUES (?,?,?,?,'void',0,?,?,'pending',datetime('now'),datetime('now'))`,
  [crypto.randomUUID(), storeId, o.uuid, String(o.order_number || ''), o.order_status == null ? '' : String(o.order_status), o.status == null ? '' : String(o.status)]);
  return true;
}

// ══════════════════════════════════════════════════════════════════════
//  依訂單目前狀態同步（hook 與定期補齊共用；可重複呼叫）
// ══════════════════════════════════════════════════════════════════════
function ageSecUtc(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + 'Z'); return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity; }
function ageSecTaipei(s) { const t = Date.parse(String(s || '').replace(' ', 'T') + '+08:00'); return Number.isFinite(t) ? (Date.now() - t) / 1000 : Infinity; }
const isCancelledOrder = (o) => !!o && (o.order_status === 'cancelled' || o.status === 'void');
// C6.2 狀態邊界修正：作廢前履約狀態的唯一分類（即時 hook、啟動補齊、定期補齊共用）
//   正式流程允許值見 utils/orderStatusFlow.js ORDER_STATUSES。
const FULFILLED_ORDER_STATUSES = ['completed'];
const OPEN_ORDER_STATUSES = (() => {
  try { return require('./orderStatusFlow').ORDER_STATUSES.filter((x) => x !== 'completed' && x !== 'cancelled'); }
  catch { return ['pending', 'accepted', 'preparing', 'ready', 'delivering']; }
})();
function classifyVoidPrior(vt) {
  if (!vt) return { cls: 'unknown', reason: 'void_prior_state_unknown' }; // 沒有作廢待辦（升級前或舊版作廢）
  const v = vt.prior_order_status == null ? '' : String(vt.prior_order_status).trim();
  if (!v) return { cls: 'unknown', reason: 'void_prior_state_missing' }; // NULL／空字串
  if (FULFILLED_ORDER_STATUSES.includes(v)) return { cls: 'fulfilled', reason: 'void_after_completed' };
  if (OPEN_ORDER_STATUSES.includes(v)) return { cls: 'open', reason: 'order_cancelled' };
  if (v === 'cancelled') return { cls: 'cancelled', reason: 'order_cancelled' };
  return { cls: 'unknown', reason: 'void_prior_state_invalid' };
}
// 購買證據：非 LINE Pay 有效訂單（成立即生效），或 LINE Pay 且後端已確認 paid。履約欄位與紀錄狀態都不是付款證據。
const hasPurchaseEvidence = (o) => !!o && (String(o.payment_method || '') !== 'linepay' || o.payment_status === 'paid');
// opts.voidPrior：classifyVoidPrior() 的結果（syncOrder 只依作廢交易內保存的待辦計算）。相容舊呼叫：字串 'open'／'completed'。
function targetFor(db, o, opts = {}) {
  if (isCancelledOrder(o)) {
    if (o.status === 'void') {
      let vp = opts.voidPrior;
      if (typeof vp === 'string') vp = vp === 'open' ? { cls: 'open', reason: 'order_cancelled' } : vp === 'completed' ? { cls: 'fulfilled', reason: 'void_after_completed' } : null;
      if (!vp) vp = classifyVoidPrior(null);
      if (vp.cls === 'open' || vp.cls === 'cancelled') return { action: 'cancel', reason: 'order_cancelled', prior: vp.cls };
      return { action: 'review_void', reason: vp.reason, prior: vp.cls, purchase: hasPurchaseEvidence(o) };
    }
    return { action: 'cancel', reason: 'order_cancelled' };
  }
  if (String(o.payment_method || '') !== 'linepay') return { action: 'settle' };
  if (o.payment_status === 'paid') return { action: 'settle' };
  const atts = db.all('SELECT status, confirm_calls, created_at FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=?', [o.store_id, o.uuid]);
  const live = atts.some((a) => LIVE_ATTEMPT_STATES.includes(String(a.status))
    || (OPEN_REQUEST_STATES.includes(String(a.status)) && (Number(a.confirm_calls) > 0 || ageSecUtc(a.created_at) < LP_RESERVE_TTL_SEC)));
  if (live) return { action: 'reserve' };
  if (!atts.length && ageSecTaipei(o.created_at) < LP_RESERVE_TTL_SEC) return { action: 'reserve' };
  const failed = atts.some((a) => a.status === 'failed' || a.status === 'aborted_cancelled');
  return { action: 'release', reason: failed ? 'payment_failed' : 'payment_expired' };
}
function syncOrder(db, storeId, orderUuid, opts = {}) {
  const links = db.all(`SELECT * FROM ${LINK_TABLE} WHERE store_id=? AND order_uuid=? AND COALESCE(import_source,'')=''`, [storeId, String(orderUuid || '')]);
  // C6.2 補修：作廢待辦（交易中保存的原履約狀態）是作廢前狀態的唯一可信來源；沒有待辦時不採信記憶體中的狀態
  const vt = db.get(`SELECT * FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND kind='void' ORDER BY id DESC LIMIT 1`, [storeId, String(orderUuid || '')]);
  const doneVoid = (result) => { if (vt && vt.state === 'pending') db.run(`UPDATE ${TASK_TABLE} SET state='done', result=?, done_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND state='pending'`, [result || 'synced', vt.id]); };
  if (!links.length) { if (vt && vt.state === 'pending' && !db.get(`SELECT 1 AS x FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND kind='bind' AND state='pending'`, [storeId, String(orderUuid)])) doneVoid('no_links'); return { links: 0, changed: 0 }; }
  const o = db.get('SELECT * FROM orders WHERE store_id=? AND uuid=?', [storeId, String(orderUuid)]);
  if (!o) return { links: links.length, changed: 0, skipped: 'order_missing' };
  const t = targetFor(db, o, { ...opts, voidPrior: classifyVoidPrior(vt) });
  // 作廢待辦的結果：實際動作（待核對註明原因），供追查「已處理」與業務上的「待核對」
  const vtResult = t.action === 'review_void' ? `review:${t.reason}${t.purchase ? '' : ':payment_unconfirmed'}` : t.action;
  const needs = links.some((l) => (t.action === 'settle' && ['reserved', 'released'].includes(l.state))
    || (t.action === 'reserve' && l.state === 'released')
    || (t.action === 'release' && l.state === 'reserved')
    || (t.action === 'cancel' && ['reserved', 'settled'].includes(l.state))
    || (t.action === 'review_void' && ['reserved', 'released', 'settled'].includes(l.state)));
  if (!needs) { if (o.status === 'void') doneVoid(vtResult); return { links: links.length, changed: 0, target: t.action }; }
  let changed = 0;
  db.runDurableTransaction(() => {
    const raw = db._db;
    if (vt && vt.state === 'pending' && o.status === 'void') raw.run(`UPDATE ${TASK_TABLE} SET state='done', result=?, done_at=datetime('now'), updated_at=datetime('now') WHERE id=? AND state='pending'`, [vtResult, vt.id]);
    for (const l0 of links) {
      const l = rawGet(raw, `SELECT * FROM ${LINK_TABLE} WHERE id=?`, [l0.id]); // 交易內重新讀取
      if (!l) continue;
      let ok = false;
      if (t.action === 'settle' && (l.state === 'reserved' || l.state === 'released')) ok = settleRaw(raw, l).changed;
      else if (t.action === 'reserve' && l.state === 'released') ok = reReserveRaw(raw, l);
      else if (t.action === 'release' && l.state === 'reserved') ok = releaseRaw(raw, l, t.reason);
      else if (t.action === 'cancel' && l.state === 'reserved') ok = releaseRaw(raw, l, 'order_cancelled');
      else if (t.action === 'cancel' && l.state === 'settled') ok = revertRaw(raw, l, 'order_cancelled');
      else if (t.action === 'review_void' && l.state === 'settled') ok = reviewRaw(raw, l, t.reason);
      else if (t.action === 'review_void' && (l.state === 'reserved' || l.state === 'released')) {
        ok = t.purchase ? module.exports._voidSettleRaw(raw, l, t.reason).changed : unconfirmedReviewRaw(raw, l, t.reason);
      }
      if (ok) changed++;
    }
  });
  return { links: links.length, changed, target: t.action };
}
// ══════════════════════════════════════════════════════════════════════
//  定期與啟動時補齊（C6.2 補修：公平輪替）
//    - 四類工作：待辦（task）、訂購中（reserved）、解除後可能已付款（released）、已扣減但訂單已取消／作廢（cancel）。
//    - 每類「依店別」取資料：每店每輪配額＝max(5, floor(上限 / 有資料的店數))，依 id 由游標往後取；
//      取到的比配額少 → 游標歸零（下一輪從頭），否則游標移到本輪最後一筆。游標保存在資料庫（重啟後接續，不回到開頭）。
//    - 處理中每 25 筆保存一次游標；單筆失敗只記錄，繼續處理其他筆（游標照常前進，下一圈再處理）。
//    - 只處理本機資料；不呼叫外部 API、不發送通知、不改付款判定；匯入資料（import_source）不處理。
// ══════════════════════════════════════════════════════════════════════
const SWEEP_LIMIT = (() => { const v = Math.trunc(Number(process.env.PD_SETTLE_SWEEP_LIMIT)); return Number.isFinite(v) && v >= 10 ? v : 200; })();
const SWEEP_CATS = {
  task: {
    stores: () => `SELECT DISTINCT store_id FROM ${TASK_TABLE} WHERE state='pending' AND (next_at IS NULL OR next_at<=?)`, sp: (o) => [o.boot ? '9999-12-31' : utcNow()],
    rows: () => `SELECT id, store_id, order_uuid FROM ${TASK_TABLE} WHERE store_id=? AND state='pending' AND (next_at IS NULL OR next_at<=?) AND id>? ORDER BY id LIMIT ?`, rp: (sid, cur, n, o) => [sid, o.boot ? '9999-12-31' : utcNow(), cur, n],
  },
  reserved: {
    stores: () => `SELECT DISTINCT store_id FROM ${LINK_TABLE} WHERE state='reserved' AND COALESCE(import_source,'')=''`, sp: () => [],
    rows: () => `SELECT id, store_id, order_uuid FROM ${LINK_TABLE} WHERE store_id=? AND state='reserved' AND COALESCE(import_source,'')='' AND id>? ORDER BY id LIMIT ?`, rp: (sid, cur, n) => [sid, cur, n],
  },
  released: {
    stores: () => `SELECT DISTINCT store_id FROM ${LINK_TABLE} WHERE state='released' AND COALESCE(import_source,'')=''`, sp: () => [],
    rows: () => `SELECT l.id, l.store_id, l.order_uuid FROM ${LINK_TABLE} l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
                 WHERE l.store_id=? AND l.state='released' AND COALESCE(l.import_source,'')='' AND COALESCE(o.order_status,'')<>'cancelled' AND COALESCE(o.status,'')<>'void'
                   AND (o.payment_status='paid' OR (o.created_at >= datetime('now','+8 hours','-3 days') AND EXISTS (SELECT 1 FROM linepay_payment_attempts a WHERE a.store_id=l.store_id AND a.order_uuid=l.order_uuid
                        AND a.status IN ('confirm_pending','review','paid_duplicate','imported_history','requesting','requested'))))
                   AND l.id>? ORDER BY l.id LIMIT ?`, rp: (sid, cur, n) => [sid, cur, n],
  },
  cancel: {
    stores: () => `SELECT DISTINCT l.store_id FROM ${LINK_TABLE} l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid WHERE l.state='settled' AND COALESCE(l.import_source,'')='' AND (o.order_status='cancelled' OR o.status='void')`, sp: () => [],
    rows: () => `SELECT l.id, l.store_id, l.order_uuid FROM ${LINK_TABLE} l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
                 WHERE l.store_id=? AND l.state='settled' AND COALESCE(l.import_source,'')='' AND (o.order_status='cancelled' OR o.status='void') AND l.id>? ORDER BY l.id LIMIT ?`, rp: (sid, cur, n) => [sid, cur, n],
  },
};
let _sweepRound = 0;
function _cursorGet(db, name) { const r = db.get(`SELECT last_id FROM ${CURSOR_TABLE} WHERE name=?`, [name]); return r ? Number(r.last_id) || 0 : 0; }
function _cursorSet(db, name, id) { db.run(`INSERT INTO ${CURSOR_TABLE} (name, last_id, updated_at) VALUES (?,?,datetime('now')) ON CONFLICT(name) DO UPDATE SET last_id=excluded.last_id, updated_at=excluded.updated_at`, [name, id]); }
function _sweepOne(db, cat, storeId, orderUuid) {
  if (cat === 'task') {
    const kinds = db.all(`SELECT DISTINCT kind FROM ${TASK_TABLE} WHERE store_id=? AND order_uuid=? AND state='pending'`, [storeId, orderUuid]).map((k) => k.kind);
    let changed = 0;
    if (kinds.includes('bind')) changed += processOrderTasks(db, storeId, orderUuid).changed || 0;
    if (kinds.includes('void')) changed += module.exports.syncOrder(db, storeId, orderUuid, { sweep: true }).changed || 0;
    return changed;
  }
  return module.exports.syncOrder(db, storeId, orderUuid, { sweep: true }).changed || 0;
}
// ══════════════════════════════════════════════════════════════════════
//  C6.2 狀態邊界修正：基準（DURABLE_RECOVERY_FIX）已產生的錯誤終態，只依可信證據補處理（啟動補齊執行；可重複執行）
//   A 型：released＋applied_qty 0＋note 'void_after_completed'＋訂單已作廢＋作廢待辦 done 且保存的原狀態為 completed
//         ＋同訂單同商品的綁定待辦 done（同一 request_uuid）。
//         有購買證據 → 依原週期補記扣減（含有效性核對）並待核對（note …:legacy_repaired）；
//         沒有購買證據 → 不扣減、待核對（…:payment_unconfirmed:legacy_review）。
//   C 型：reverted＋note 'order_cancelled…'＋訂單已作廢＋作廢待辦保存的原狀態屬「未知」（NULL／空字串／不合法）
//         → 不自動改份數（回復當時也缺乏證據）；在關聯 note 與作廢待辦 result 標記 legacy_review，供人工核對。
//   其餘歷史資料不回溯處理。
// ══════════════════════════════════════════════════════════════════════
// ── C6.2 歷史待核對掃描漏標修正 ──────────────────────────────────────────
//   原本 C 型以「先 LIMIT 500、取出後才分類」查詢：前 500 筆若都是合法原狀態（被略過），後段應標記的資料永遠排不到。
//   修正：
//   (1) SQL 在 LIMIT 之前先排除「原狀態屬已知合法值」的紀錄（與 classifyVoidPrior 同一組合法值；
//       SQL 只去除 ASCII 空白，JS trim 去除的空白更多，因此 SQL 結果是 JS「未知」判定的超集，不會漏掉任何應標記者）；
//   (2) 以 l.id 遞增的掃描游標分批（每批 LEGACY_BATCH 筆），即使超集中有被 JS 判為合法而略過的紀錄，游標仍向後推進；
//   (3) 每輪補齊最多 LEGACY_BATCHES_PER_ROUND 批（有界工作量），未掃完的下一輪接續；整輪掃完即停止，不再查詢；
//   (4) 單筆失敗不影響其他筆（每筆 SAVEPOINT）；掃完一輪若有失敗，LEGACY_RETRY_MS 後再掃一輪（只掃未標記的候選）；
//   (5) 游標只在記憶體：已完成的標記已持久化並由 SQL 排除，程序重啟後從頭掃「尚未標記」者即等同續行，不需新增資料表。
//   C 型只更新關聯 note、作廢待辦 result 與 updated_at；不改份數、關聯 state／applied_qty、登記週期。A 型門檻不變。
const LEGACY_BATCH = 500;
const LEGACY_BATCHES_PER_ROUND = 4;
const LEGACY_RETRY_MS = Math.max(1000, Number(process.env.PD_LEGACY_RETRY_MS) || 5 * 60 * 1000);
const KNOWN_PRIOR_STATUSES = () => [...FULFILLED_ORDER_STATUSES, ...OPEN_ORDER_STATUSES, 'cancelled'];
// SQL 中與 JS String.prototype.trim 相容的子集（ASCII 空白：tab、LF、VT、FF、CR、space）
const SQL_TRIM_PRIOR = "trim(v.prior_order_status, ' '||char(9)||char(10)||char(11)||char(12)||char(13))";
// C 型單筆標記（測試替身可在此注入單筆失敗；實際寫入以目前狀態為條件，不重複追加、不覆寫正常紀錄）
function _markLegacyReviewRaw(raw, row, vp) {
  raw.run(`UPDATE ${LINK_TABLE} SET note=note||?, updated_at=datetime('now')
           WHERE id=? AND store_id=? AND order_uuid=? AND state='reverted' AND COALESCE(import_source,'')='' AND note NOT LIKE '%legacy_review%'`,
  [`:legacy_review:${vp.reason}`, row.id, row.store_id, row.order_uuid]);
  if (raw.getRowsModified() !== 1) return false;
  raw.run(`UPDATE ${TASK_TABLE} SET result=?, updated_at=datetime('now')
           WHERE id=? AND store_id=? AND order_uuid=? AND kind='void' AND COALESCE(result,'') NOT LIKE 'legacy_review%'`,
  [`legacy_review:${vp.reason}`, row.vid, row.store_id, row.order_uuid]);
  return true;
}
// 單一批次：A、C 型各自從游標之後取至多 limit 筆
function repairLegacyBatch(db, o = {}) {
  const limit = Math.max(1, Number(o.limit) || LEGACY_BATCH);
  const out = { a: 0, c: 0, skipped: 0, failed: 0, rowsA: 0, rowsC: 0, lastA: Number(o.fromA) || 0, lastC: Number(o.fromC) || 0 };
  let rowsA = [];
  try {
    rowsA = db.all(`SELECT l.id FROM ${LINK_TABLE} l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
                    WHERE l.id>? AND l.state='released' AND COALESCE(l.import_source,'')='' AND COALESCE(l.applied_qty,0)=0 AND l.note='void_after_completed' AND o.status='void'
                      AND EXISTS (SELECT 1 FROM ${TASK_TABLE} v WHERE v.store_id=l.store_id AND v.order_uuid=l.order_uuid AND v.kind='void' AND v.state='done' AND v.prior_order_status='completed')
                      AND EXISTS (SELECT 1 FROM ${TASK_TABLE} b WHERE b.store_id=l.store_id AND b.order_uuid=l.order_uuid AND b.kind='bind' AND b.state='done' AND b.product_id=l.product_id AND b.request_uuid=l.request_uuid)
                    ORDER BY l.id LIMIT ?`, [out.lastA, limit]);
  } catch { rowsA = []; out.failed++; }
  out.rowsA = rowsA.length;
  for (const r of rowsA) {
    out.lastA = Number(r.id);
    try {
      db.runDurableTransaction(() => {
        const raw = db._db;
        const l = rawGet(raw, `SELECT * FROM ${LINK_TABLE} WHERE id=?`, [r.id]);
        if (!l || l.state !== 'released' || l.note !== 'void_after_completed') return;
        const o = rawGet(raw, 'SELECT * FROM orders WHERE store_id=? AND uuid=?', [l.store_id, l.order_uuid]);
        if (hasPurchaseEvidence(o)) {
          module.exports._voidSettleRaw(raw, l, 'void_after_completed');
          raw.run(`UPDATE ${LINK_TABLE} SET note=note||':legacy_repaired', updated_at=datetime('now') WHERE id=? AND state='review'`, [l.id]);
        } else {
          raw.run(`UPDATE ${LINK_TABLE} SET state='review', note='void_after_completed:payment_unconfirmed:legacy_review', updated_at=datetime('now') WHERE id=? AND state='released'`, [l.id]);
        }
        out.a++;
      });
    } catch { out.failed++; }
  }
  const known = KNOWN_PRIOR_STATUSES();
  let rowsC = [];
  try {
    rowsC = db.all(`SELECT l.id, l.store_id, l.order_uuid, v.id AS vid, v.prior_order_status FROM ${LINK_TABLE} l JOIN orders o ON o.store_id=l.store_id AND o.uuid=l.order_uuid
                    JOIN ${TASK_TABLE} v ON v.id=(SELECT MAX(v2.id) FROM ${TASK_TABLE} v2 WHERE v2.store_id=l.store_id AND v2.order_uuid=l.order_uuid AND v2.kind='void' AND v2.state='done')
                    WHERE l.id>? AND l.state='reverted' AND COALESCE(l.import_source,'')='' AND o.status='void' AND l.note LIKE 'order_cancelled%' AND l.note NOT LIKE '%legacy_review%'
                      AND (v.prior_order_status IS NULL OR ${SQL_TRIM_PRIOR} NOT IN (${known.map(() => '?').join(',')}))
                    ORDER BY l.id LIMIT ?`, [out.lastC, ...known, limit]);
  } catch { rowsC = []; out.failed++; }
  out.rowsC = rowsC.length;
  if (rowsC.length) {
    out.lastC = Number(rowsC[rowsC.length - 1].id);
    let batchMarked = 0, batchFailed = 0, batchSkipped = 0;
    try {
      db.runDurableTransaction(() => {
        const raw = db._db;
        batchMarked = 0; batchFailed = 0; batchSkipped = 0;
        for (const r of rowsC) {
          const vp = classifyVoidPrior({ prior_order_status: r.prior_order_status });
          if (vp.cls !== 'unknown') { batchSkipped++; continue; } // 與 classifyVoidPrior 一致：合法值（含正規化後）不標記
          raw.run('SAVEPOINT pd_legacy_c');
          try {
            if (module.exports._markLegacyReviewRaw(raw, r, vp)) batchMarked++; else batchSkipped++;
            raw.run('RELEASE SAVEPOINT pd_legacy_c');
          } catch {
            try { raw.run('ROLLBACK TO SAVEPOINT pd_legacy_c'); raw.run('RELEASE SAVEPOINT pd_legacy_c'); } catch { /* 交易層級錯誤由外層處理 */ }
            batchFailed++;
          }
        }
      });
      out.c += batchMarked; out.skipped += batchSkipped; out.failed += batchFailed;
    } catch { out.failed += rowsC.length; }
  }
  return out;
}
// 一整輪（直到掃完）；供工具或測試直接呼叫。正常服務由 sweep() 以有界批次驅動。
function repairLegacy(db, opts = {}) {
  if (typeof opts === 'number') opts = { limit: opts };
  const tot = { a: 0, c: 0, skipped: 0, failed: 0, batches: 0 };
  let fromA = 0, fromC = 0;
  for (;;) {
    const r = repairLegacyBatch(db, { limit: opts.limit, fromA, fromC });
    tot.batches++; tot.a += r.a; tot.c += r.c; tot.skipped += r.skipped; tot.failed += r.failed;
    fromA = r.lastA; fromC = r.lastC;
    const lim = Math.max(1, Number(opts.limit) || LEGACY_BATCH);
    if (r.rowsA < lim && r.rowsC < lim) break;
  }
  return tot;
}
// sweep() 用的有界續行狀態（記憶體）
const _legacy = { pending: false, fromA: 0, fromC: 0, failedInPass: 0, retryAt: 0, pass: 0 };
function _legacyStart() { Object.assign(_legacy, { pending: true, fromA: 0, fromC: 0, failedInPass: 0, retryAt: 0, pass: _legacy.pass + 1 }); }
function _legacyStep(db) {
  const st = { pass: _legacy.pass, batches: 0, a: 0, c: 0, skipped: 0, failed: 0, fromA: _legacy.fromA, fromC: _legacy.fromC, done: false };
  for (let i = 0; i < LEGACY_BATCHES_PER_ROUND; i++) {
    const r = repairLegacyBatch(db, { limit: LEGACY_BATCH, fromA: _legacy.fromA, fromC: _legacy.fromC });
    st.batches++; st.a += r.a; st.c += r.c; st.skipped += r.skipped; st.failed += r.failed;
    _legacy.fromA = r.lastA; _legacy.fromC = r.lastC; _legacy.failedInPass += r.failed;
    if (r.rowsA < LEGACY_BATCH && r.rowsC < LEGACY_BATCH) {
      if (_legacy.failedInPass > 0) { // 有失敗：稍後只重掃尚未標記的候選
        Object.assign(_legacy, { fromA: 0, fromC: 0, failedInPass: 0, retryAt: Date.now() + LEGACY_RETRY_MS, pass: _legacy.pass + 1 });
        st.retry_in_ms = LEGACY_RETRY_MS;
      } else { _legacy.pending = false; st.done = true; }
      break;
    }
  }
  st.toA = _legacy.fromA; st.toC = _legacy.fromC;
  return st;
}
function sweep(db, limit = SWEEP_LIMIT, opts = {}) {
  if (typeof limit !== 'number') { opts = limit || {}; limit = SWEEP_LIMIT; }
  _sweepRound++;
  const out = { round: _sweepRound, orders: 0, changed: 0, failed: 0, cats: {} };
  if (opts.boot) _legacyStart();
  if (_legacy.pending && Date.now() >= _legacy.retryAt) {
    try { out.legacy = _legacyStep(db); out.changed += out.legacy.a + out.legacy.c; out.failed += out.legacy.failed; } catch (e) { out.legacy = { error: e && e.message }; }
    out.cats.legacy = out.legacy; // 隨 PD_SETTLE_SWEEP_LOG=1 的每輪明細輸出；掃完後不再出現
  }
  for (const [cat, C] of Object.entries(SWEEP_CATS)) {
    let stores = [];
    try { stores = db.all(C.stores(), C.sp(opts)).map((r) => String(r.store_id)).sort(); } catch (e) { out.cats[cat] = { error: e && e.message }; continue; }
    if (!stores.length) continue;
    const quota = Math.max(5, Math.floor(limit / stores.length));
    out.cats[cat] = {};
    for (const sid of stores) {
      const cname = `${cat}:${sid}`;
      const from = _cursorGet(db, cname);
      let rows = [];
      try { rows = db.all(C.rows(), C.rp(sid, from, quota, opts)); } catch (e) { out.cats[cat][sid] = { error: e && e.message }; continue; }
      const seen = new Set(); let n = 0, lastId = from;
      for (const r of rows) {
        lastId = Number(r.id);
        if (!seen.has(r.order_uuid)) {
          seen.add(r.order_uuid); out.orders++;
          try { out.changed += _sweepOne(db, cat, sid, String(r.order_uuid)); } catch (e) { out.failed++; }
          n++;
          if (n % 25 === 0) { try { _cursorSet(db, cname, lastId); } catch { /* 下一次保存 */ } }
        }
      }
      const wrapped = rows.length < quota;
      try { _cursorSet(db, cname, wrapped ? 0 : lastId); } catch { /* 保存失敗：下一輪從上次保存的位置繼續 */ }
      out.cats[cat][sid] = { from, to: lastId, rows: rows.length, orders: n, wrapped };
    }
  }
  return out;
}

// 單一入口：呼叫端（訂單、付款、取消、作廢）一律 fail-open
function safeSync(db, storeId, orderUuid, opts, tag) {
  try { return syncOrder(db, storeId, orderUuid, opts || {}); }
  catch (e) { console.warn(`[demand_settlement] ${tag || 'sync'} failed:`, e && e.message); return { error: true }; }
}

module.exports = {
  LINK_TABLE, LP_RESERVE_TTL_SEC, migrate, qtyView, reservedMap, linksForRequest,
  _bindRaw, bindInTx, bindLate, targetFor, syncOrder, safeSync, sweep, aggregateItems,
  // C6.2 補修
  TASK_TABLE, CURSOR_TABLE, SWEEP_LIMIT, _recordIntentsRaw, _applyTaskRaw, processOrderTasks, recordVoidTaskRaw,
  // C6.2 狀態邊界修正
  classifyVoidPrior, hasPurchaseEvidence, cycleValidity, _voidSettleRaw, repairLegacy,
  // 歷史待核對掃描漏標修正
  repairLegacyBatch, _markLegacyReviewRaw, LEGACY_BATCH, LEGACY_BATCHES_PER_ROUND, _legacyState: () => ({ ..._legacy }),
};
