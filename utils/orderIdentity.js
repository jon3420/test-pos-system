// utils/orderIdentity.js — R54.4／MBV2-HF1-C5.1：訂單唯一識別、顯示編號、LINE Pay 付款嘗試對應、歷史重號診斷
//
// 背景（C4.4／C5 既有問題）：訂單編號只到「秒」（LINE-YYYYMMDD-HHMMSS），同一秒建立的兩張訂單編號相同；
//   LINE Pay confirm 以 (order_number=? OR uuid=?) 取第一筆、搬家以 order_number 判定同一訂單 → 可能串單。
//
// C5.1 原則
//   1. 訂單的穩定唯一識別是 uuid（LINE 點餐、宅配：id＝uuid）／id（店內 POS）。所有新程式只以它定位訂單。
//   2. 新顯示編號：<既有前綴與秒級時間>-<4 碼隨機（不含易混淆字元）>，在同一個同步區段內「查重＋寫入」，
//      並以持久化部分唯一索引 (store_id, order_number) WHERE order_no_v=2 作為最後防線。
//      新格式必定帶 4 碼尾碼，舊格式沒有 → 新編號不會與任何歷史編號相同。
//   3. 歷史資料：不刪除、不合併、不重新編號、不改 uuid／付款狀態／交易識別。新增的唯一約束只作用於新編號
//      （order_no_v=2），歷史重號不會導致遷移失敗；歷史 uuid 重複只列入診斷。
//   4. LINE Pay：每次付款請求建立一筆付款嘗試（linepay_payment_attempts），保存店別＋訂單 uuid＋送給 LINE Pay 的
//      orderId＋transactionId（以字串保存 19 位數字，不經 JS Number）。callback 以嘗試識別唯一定位訂單並核對交易。
'use strict';

const crypto = require('crypto');

// 不含 0/O/1/I/L，避免顧客念錯或看錯
const SUFFIX_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const SUFFIX_LEN = 4;
const MAX_TRIES = 64;

function rawAll(raw, sql, params) {
  const st = raw.prepare(sql);
  try { if (params) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
function colNames(raw, table) { try { return rawAll(raw, `PRAGMA table_info(${table})`).map((c) => c.name); } catch { return []; } }

// 診斷結果（啟動遷移時產生；只在記憶體，供管理 API 與 log 使用）
const bootAudit = { ran: false, duplicate_number_groups: 0, duplicate_uuid_groups: 0, uuid_index: 'unknown', number_index: 'unknown' };

function migrate(raw) {
  const cols = colNames(raw, 'orders');
  if (!cols.length) return bootAudit;
  // 新欄位（只 ALTER ADD COLUMN；不改既有資料）
  if (!cols.includes('order_no_v')) raw.run('ALTER TABLE orders ADD COLUMN order_no_v INTEGER DEFAULT NULL');
  if (!cols.includes('import_origin_uuid')) raw.run("ALTER TABLE orders ADD COLUMN import_origin_uuid TEXT DEFAULT ''");
  if (!cols.includes('imported_at')) raw.run("ALTER TABLE orders ADD COLUMN imported_at TEXT DEFAULT ''");
  if (!cols.includes('import_origin_store')) raw.run("ALTER TABLE orders ADD COLUMN import_origin_store TEXT DEFAULT ''");
  // 新編號唯一約束：舊資料 order_no_v 一律為 NULL → 不受影響，不會因歷史重號導致遷移失敗
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_store_ordno_v2 ON orders(store_id, order_number) WHERE order_no_v=2');
  bootAudit.number_index = 'ok';
  // 查詢用索引（非唯一）
  raw.run('CREATE INDEX IF NOT EXISTS idx_orders_store_ordno ON orders(store_id, order_number)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_orders_store_uuid ON orders(store_id, uuid)');
  if (cols.includes('linepay_transaction_id')) raw.run('CREATE INDEX IF NOT EXISTS idx_orders_store_lptx ON orders(store_id, linepay_transaction_id)');
  // 穩定識別：orders.id 為 PRIMARY KEY（LINE 點餐、宅配 id＝uuid；店內 POS id 為 uuidv4）→ 已有持久化唯一約束。
  // 不另外對 uuid 建唯一索引：舊版搬家（routes/migration.js）使用 INSERT OR REPLACE，額外的唯一索引可能讓它刪除既有訂單。
  // 只稽核歷史 uuid 是否重複（診斷用），不改資料、不讓啟動失敗。
  const dupU = rawAll(raw, "SELECT COUNT(*) AS c FROM (SELECT store_id, uuid FROM orders WHERE uuid IS NOT NULL AND uuid<>'' GROUP BY store_id, uuid HAVING COUNT(*)>1)")[0];
  bootAudit.duplicate_uuid_groups = Number(dupU && dupU.c) || 0;
  bootAudit.uuid_index = 'primary_key_id';
  const dupN = rawAll(raw, "SELECT COUNT(*) AS c FROM (SELECT store_id, order_number FROM orders GROUP BY store_id, order_number HAVING COUNT(*)>1)")[0];
  bootAudit.duplicate_number_groups = Number(dupN && dupN.c) || 0;

  // LINE Pay 付款嘗試（每次付款請求一筆；本環境專屬，不隨搬家匯出，跨店不會被啟用）
  raw.run(`CREATE TABLE IF NOT EXISTS linepay_payment_attempts (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    attempt_uuid      TEXT NOT NULL,
    store_id          TEXT NOT NULL,
    order_uuid        TEXT NOT NULL,
    order_number      TEXT DEFAULT '',
    lp_order_id       TEXT NOT NULL,
    transaction_id    TEXT DEFAULT '',
    amount            REAL NOT NULL DEFAULT 0,
    currency          TEXT NOT NULL DEFAULT 'TWD',
    channel           TEXT DEFAULT 'line_order',
    status            TEXT NOT NULL DEFAULT 'requesting',
    result_code       TEXT DEFAULT '',
    created_at        TEXT DEFAULT (datetime('now')),
    updated_at        TEXT DEFAULT (datetime('now')),
    confirmed_at      TEXT DEFAULT NULL
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lpa_uuid ON linepay_payment_attempts(attempt_uuid)');
  // callback 以 attempt_uuid（唯一）定位，再核對 transactionId；交易識別只建一般索引（不因供應商回傳值重複而讓付款請求失敗）
  raw.run('CREATE INDEX IF NOT EXISTS idx_lpa_store_tx ON linepay_payment_attempts(store_id, transaction_id)');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lpa_store_lporder ON linepay_payment_attempts(store_id, lp_order_id)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_lpa_order ON linepay_payment_attempts(store_id, order_uuid)');
  bootAudit.ran = true;
  return bootAudit;
}

// ══════════════════════════════════════════════════════════════════════
//  顯示編號
// ══════════════════════════════════════════════════════════════════════
function pad(v, l = 2) { return String(v).padStart(l, '0'); }
// 與既有格式相同的秒級時間（伺服器本地時區，部署設定 TZ=Asia/Taipei）
function timeBase(prefix, d = new Date()) {
  return `${prefix}${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}
function randomSuffix() {
  let s = '';
  for (let i = 0; i < SUFFIX_LEN; i++) s += SUFFIX_ALPHABET[crypto.randomInt(SUFFIX_ALPHABET.length)];
  return s;
}
// 必須在「寫入訂單」的同一個同步區段呼叫（中間不得 await）。db 可為 wrapper（get）或 raw sql.js。
function allocateOrderNumber(db, storeId, prefix, now) {
  const base = timeBase(prefix, now || new Date());
  const exists = (n) => {
    if (typeof db.get === 'function') return !!db.get('SELECT 1 AS x FROM orders WHERE store_id=? AND order_number=? LIMIT 1', [storeId, n]);
    return rawAll(db, 'SELECT 1 AS x FROM orders WHERE store_id=? AND order_number=? LIMIT 1', [storeId, n]).length > 0;
  };
  for (let i = 0; i < MAX_TRIES; i++) {
    const n = `${base}-${randomSuffix()}`;
    if (!exists(n)) return n;
  }
  // 理論上不會發生（同一秒 31^4≈92 萬組合）；仍以完整隨機碼確保不重複，交由唯一索引最後把關
  return `${base}-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

// ══════════════════════════════════════════════════════════════════════
//  依參照定位訂單（不再以 OR 取第一筆）
//    依序：id → uuid → order_number（只有恰好一筆才採用；多筆回傳 ambiguous，不猜）
// ══════════════════════════════════════════════════════════════════════
function resolveOrderRef(db, storeId, ref, extraWhere = '', extraParams = []) {
  const r = String(ref == null ? '' : ref).trim();
  if (!r) return { order: null };
  const w = extraWhere ? ` AND ${extraWhere}` : '';
  let o = db.get(`SELECT * FROM orders WHERE store_id=? AND id=?${w}`, [storeId, r, ...extraParams]);
  if (o) return { order: o, by: 'id' };
  const byUuid = db.all(`SELECT * FROM orders WHERE store_id=? AND uuid=?${w} LIMIT 2`, [storeId, r, ...extraParams]);
  if (byUuid.length === 1) return { order: byUuid[0], by: 'uuid' };
  if (byUuid.length > 1) return { order: null, ambiguous: true, by: 'uuid', count: byUuid.length };
  const byNo = db.all(`SELECT * FROM orders WHERE store_id=? AND order_number=?${w} LIMIT 3`, [storeId, r, ...extraParams]);
  if (byNo.length === 1) return { order: byNo[0], by: 'order_number' };
  if (byNo.length > 1) return { order: null, ambiguous: true, by: 'order_number', count: byNo.length };
  return { order: null };
}
function sendAmbiguous(res) {
  return res.status(409).json({ success: false, error: 'ORDER_REF_AMBIGUOUS', message: '此訂單編號對應到多張歷史訂單，請改用訂單識別（uuid）操作或聯絡管理員核對。' });
}

// ══════════════════════════════════════════════════════════════════════
//  LINE Pay
// ══════════════════════════════════════════════════════════════════════
// LINE Pay transactionId 為 19 位整數（官方：以 64-bit long 或字串處理）。JSON.parse 會失去精度 →
// 一律從原始回應文字擷取。找不到時才退回解析後的值（只可能是較短的數字）。
function extractTransactionId(text, parsed) {
  const m = /"transactionId"\s*:\s*"?([A-Za-z0-9_-]{1,64})"?/.exec(String(text || ''));
  if (m) return m[1];
  const v = parsed && parsed.info && parsed.info.transactionId;
  return v == null ? '' : String(v);
}
// 讀取 LINE Pay 回應：優先取原始文字（保留 19 位交易識別精度）；沒有 text() 的回應物件（測試替身等）退回 json()
async function readLinePayResponse(res) {
  if (res && typeof res.text === 'function') { const text = await res.text(); let data = null; try { data = JSON.parse(text); } catch { data = null; } return { text, data }; }
  const data = res && typeof res.json === 'function' ? await res.json() : null;
  return { text: data ? JSON.stringify(data) : '', data };
}
// 交易識別只接受安全字元（官方為 19 位整數；比對一律以伺服器保存值為準，不依格式判斷真偽）
const TX_RE = /^[A-Za-z0-9_-]{1,64}$/;
function orderNumberUnique(db, storeId, order) {
  if (!order || !order.order_number) return false;
  if (Number(order.order_no_v) === 2) return true;
  const n = db.get('SELECT COUNT(*) AS c FROM orders WHERE store_id=? AND order_number=?', [storeId, order.order_number]);
  return Number(n && n.c) === 1;
}
// 送給 LINE Pay 的 orderId（≤100 字元）：
//   - 第一次請求：新訂單沿用顯示編號（便於商家後台對帳）；歷史重號的訂單加上 uuid 前 8 碼避免與另一張相同。
//   - 同一訂單再次請求（前一次未完成）：加上 -P<n>，避免 LINE Pay「相同 orderId 已有交易」（1172）。
function nextLpOrderId(db, storeId, order) {
  const uniq = orderNumberUnique(db, storeId, order);
  const base = uniq ? String(order.order_number) : `${order.order_number || 'ORDER'}-${String(order.uuid || order.id).replace(/-/g, '').slice(0, 8)}`;
  const n = db.get('SELECT COUNT(*) AS c FROM linepay_payment_attempts WHERE store_id=? AND order_uuid=?', [storeId, order.uuid]);
  const k = Number(n && n.c) || 0;
  let id = k === 0 ? base : `${base}-P${k + 1}`;
  for (let i = 0; db.get('SELECT 1 AS x FROM linepay_payment_attempts WHERE store_id=? AND lp_order_id=?', [storeId, id]); i++) {
    id = `${base}-P${k + 2 + i}`;
  }
  return id.slice(0, 100);
}
function createAttempt(db, storeId, order, amount, channel, merchantRef) {
  const attempt = {
    attempt_uuid: crypto.randomUUID(), store_id: storeId, order_uuid: String(order.uuid), order_number: String(order.order_number || ''),
    lp_order_id: nextLpOrderId(db, storeId, order), amount: Number(amount), currency: 'TWD', channel: channel || 'line_order',
  };
  db.run(`INSERT INTO linepay_payment_attempts (attempt_uuid, store_id, order_uuid, order_number, lp_order_id, amount, currency, channel, status)
          VALUES (?,?,?,?,?,?,?,?,'requesting')`,
  [attempt.attempt_uuid, storeId, attempt.order_uuid, attempt.order_number, attempt.lp_order_id, attempt.amount, attempt.currency, attempt.channel]);
  // C5.2：新格式付款嘗試與建立當時的商家設定（核對時商家設定若已更換 → 待人工核對）
  // C5.3：confirm_state='never'＝持久化紀錄證明尚未送出 Confirm（送出前會以條件式 durable 更新改為 sent）
  try { db.run("UPDATE linepay_payment_attempts SET state_version=3, merchant_ref=?, source=?, confirm_state='never' WHERE store_id=? AND attempt_uuid=?", [String(merchantRef || ''), String(channel || ''), storeId, attempt.attempt_uuid]); } catch (e) { /* 欄位尚未遷移時略過 */ }
  return attempt;
}
function attemptRequested(db, storeId, attemptUuid, transactionId) {
  db.run(`UPDATE linepay_payment_attempts SET status='requested', transaction_id=?, updated_at=datetime('now') WHERE store_id=? AND attempt_uuid=?`,
    [String(transactionId || ''), storeId, attemptUuid]);
}
function attemptFailed(db, storeId, attemptUuid, code) {
  // 付款請求（Request）階段失敗：尚未取得交易、也不可能送出 Confirm
  db.run(`UPDATE linepay_payment_attempts SET status='failed', result_code=?, updated_at=datetime('now') WHERE store_id=? AND attempt_uuid=? AND status<>'confirmed'`,
    [String(code || ''), storeId, attemptUuid]);
  try { db.run("UPDATE linepay_payment_attempts SET failure_basis='request_failed' WHERE store_id=? AND attempt_uuid=? AND status='failed' AND COALESCE(transaction_id,'')=''", [storeId, attemptUuid]); } catch (e) { /* 欄位尚未遷移時略過 */ }
}
function findAttempt(db, storeId, attemptUuid) {
  if (!/^[0-9a-f-]{36}$/i.test(String(attemptUuid || ''))) return null;
  return db.get('SELECT * FROM linepay_payment_attempts WHERE store_id=? AND attempt_uuid=?', [storeId, String(attemptUuid)]) || null;
}

// orders.linepay_transaction_id 欄位（正常部署都有；少數精簡測試資料庫沒有時，相關步驟略過，與既有程式的容錯一致）
function hasLpTxCol(db) {
  try { return db.all('PRAGMA table_info(orders)').some((c) => c.name === 'linepay_transaction_id'); } catch { return false; }
}
// callback 定位訂單（不使用有歧義的 OR 查詢）
//   回傳 { order, attempt, path } 或 { error: 'code' }
//   1. 新請求：confirmUrl 帶 attempt＝付款嘗試識別 → 核對店別、transactionId、orderId → 以嘗試保存的 order_uuid 取單
//   2. 升級前已建立的付款請求（沒有 attempt）：優先使用伺服器保存的 linepay_transaction_id（同店唯一才採用），
//      再核對 orderId；沒有可靠交易對應時，只在 orderId 恰好對應一張訂單、且該訂單保存的交易識別相符或空白時採用。
//      重號且沒有可靠交易對應 → 明確拒絕（ambiguous），不猜。搬家匯入的訂單不自動啟用來源環境的付款交易。
function resolveCallback(db, storeId, q) {
  const tx = String(q.transactionId || '');
  const oid = String(q.orderId || '');
  if (!TX_RE.test(tx) || !oid) return { error: 'missing_params' };
  if (q.attempt) {
    const a = findAttempt(db, storeId, q.attempt);
    if (!a) return { error: 'attempt_not_found' };
    if (a.transaction_id && a.transaction_id !== tx) return { error: 'transaction_mismatch', attempt: a };
    if (a.lp_order_id !== oid) return { error: 'order_mismatch', attempt: a };
    const order = db.get('SELECT * FROM orders WHERE store_id=? AND uuid=?', [storeId, a.order_uuid]);
    if (!order) return { error: 'order_not_found', attempt: a };
    return { order, attempt: a, path: 'attempt' };
  }
  // 舊流程相容
  const byTx = hasLpTxCol(db) ? db.all('SELECT * FROM orders WHERE store_id=? AND linepay_transaction_id=? LIMIT 2', [storeId, tx]) : [];
  let order = null;
  if (byTx.length > 1) return { error: 'ambiguous' };
  if (byTx.length === 1) {
    order = byTx[0];
    if (oid !== String(order.order_number) && oid !== String(order.uuid)) return { error: 'order_mismatch' };
  } else {
    const r = resolveOrderRef(db, storeId, oid);
    if (r.ambiguous) return { error: 'ambiguous' };
    if (!r.order) return { error: 'order_not_found' };
    order = r.order;
    if (order.linepay_transaction_id && String(order.linepay_transaction_id) !== tx) return { error: 'transaction_mismatch' };
  }
  // 搬家匯入的訂單：只有「同一店別」搬移（例如換主機）且交易識別與保存值完全相符時才可續用；跨店一律不自動啟用
  if (order.imported_at) {
    const sameStore = String(order.import_origin_store || '') === String(storeId);
    if (!sameStore || String(order.linepay_transaction_id || '') !== tx) return { error: 'imported_payment' };
  }
  return { order, attempt: null, path: 'legacy' };
}

// ══════════════════════════════════════════════════════════════════════
//  歷史重號診斷（唯讀）
// ══════════════════════════════════════════════════════════════════════
function diagnostics(db, storeId, opts = {}) {
  const limit = Math.max(1, Math.min(500, Math.trunc(Number(opts.limit) || 100)));
  const groups = db.all(`SELECT order_number, COUNT(*) AS n FROM orders WHERE store_id=? GROUP BY order_number HAVING COUNT(*)>1 ORDER BY order_number DESC LIMIT ?`, [storeId, limit]);
  const total = db.get('SELECT COUNT(*) AS c FROM (SELECT order_number FROM orders WHERE store_id=? GROUP BY order_number HAVING COUNT(*)>1)', [storeId]);
  const out = groups.map((g) => {
    const rows = db.all(`SELECT id, uuid, source, payment_method, payment_status, order_status, total, created_at, COALESCE(linepay_transaction_id,'') AS tx,
                                COALESCE(imported_at,'') AS imported_at
                         FROM orders WHERE store_id=? AND order_number=? ORDER BY created_at, id`, [storeId, g.order_number]);
    const pendingLinePay = rows.filter((r) => r.payment_method === 'linepay' && r.payment_status !== 'paid');
    return {
      order_number: g.order_number, count: Number(g.n),
      orders: rows.map((r) => ({ id: r.id, uuid: r.uuid || null, source: r.source, payment_method: r.payment_method, payment_status: r.payment_status,
        order_status: r.order_status, total: Number(r.total || 0), created_at: r.created_at, has_linepay_transaction: !!r.tx, imported: !!r.imported_at })),
      // 未完成的 LINE Pay 舊付款：有保存交易識別者可由交易識別唯一對應；沒有者 callback 會被拒絕並提示人工核對
      needs_review: pendingLinePay.some((r) => !r.tx),
    };
  });
  return {
    store_id: storeId, duplicate_groups: Number(total && total.c) || 0, groups: out,
    indexes: { order_number_v2_unique: bootAudit.number_index, stable_identity: bootAudit.uuid_index, duplicate_uuid_groups: bootAudit.duplicate_uuid_groups },
    note: '歷史重號不刪除、不合併、不重新編號；新訂單使用帶 4 碼尾碼的新編號，不會與歷史編號相同。',
  };
}

module.exports = {
  SUFFIX_ALPHABET, migrate, bootAudit, timeBase, allocateOrderNumber, resolveOrderRef, sendAmbiguous,
  extractTransactionId, readLinePayResponse, TX_RE, hasLpTxCol, orderNumberUnique, nextLpOrderId, createAttempt, attemptRequested, attemptFailed, findAttempt, resolveCallback, diagnostics,
};
