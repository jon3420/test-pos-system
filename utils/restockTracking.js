// utils/restockTracking.js — R54.4／MBV2-HF1-C5：補貨通知成效追蹤（點擊、加購、訂單與成交歸因）
//
// 漏斗：LINE 已受理 → 消費者點擊商品（最終頁實際開啟） → 加入購物車 → 訂單成立／成交
//
// 追蹤識別（tracking_id）
//   - C5 起的新批次在「預覽」建立訊息快照之前，由伺服器產生隨機、不含個資的追蹤識別，寫入批次並放進商品直達連結
//     （rt 參數）。確認、重試、續送沿用同一份訊息、連結、hash 與 retry key。舊批次（tracking_id 空白）連結與 hash 不變。
//   - 追蹤識別只用來對應「店別＋批次＋商品」：不具登入、查詢名單或發送通知的權限；查不到或不相符時一律回「未追蹤」，
//     不揭露是否存在。
//
// 收件人核對：點擊／加購只信任後端驗證的 member_session（verifyMemberSession），再核對該會員是否為此批次
//   「LINE 已受理」的收件人（restock_notify_deliveries.status='accepted'）。匿名、非收件人、結果不明者另列，不冒用原收件人。
//
// 歸因（第一版）：最後一次有效補貨通知點擊後 7×24 小時內下單
//   - 同店、同商品、同一位後端驗證會員；點擊必須晚於該收件人的受理時間、早於訂單建立時間（伺服器時間）。
//   - 多個有效點擊 → 歸給下單前最後一次；同一訂單同一商品只歸因一次（唯一索引）。
//   - 訂單建立時保存歸因快照（含通知日期／取餐方式與訂單實際選擇）；LINE Pay 付款完成沿用同一份快照。
//   - 不依賴前端回報：訂單歸因完全由後端以會員＋點擊紀錄計算，前端無法指定批次、金額或成功。
//
// 金額：只計入通知商品的成交明細。整單折扣（discount_amount）依「各商品明細金額（單價×數量）占商品小計比例」分攤，
//   以「分」為單位、最大餘數法處理尾差（同餘數依明細順序），外送費不計入、不分攤；折扣大於商品小計時以商品小計為上限。
//   系統沒有逐項（部分）退款資料：已作廢／已取消的訂單排除；已退款或待退款的訂單另列，金額不扣減部分退款（報表標示限制）。
//
// 失敗一律不阻擋瀏覽、加購、下單、付款或通知發送（所有寫入 fail-open）。
'use strict';

const crypto = require('crypto');

const RULE_VERSION = 'c5-last-click-7d-v1';
const WINDOW_MS = 7 * 24 * 3600e3;
const TRACKING_RE = /^[A-Za-z0-9_-]{16,40}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_RE = /^[A-Za-z0-9_-]{8,64}$/;
const CONFIRMED_BATCH_STATUSES = ['sending', 'paused', 'completed', 'cancelled'];

function rawAll(raw, sql, params) {
  const st = raw.prepare(sql);
  try { if (params) st.bind(params); const out = []; while (st.step()) out.push(st.getAsObject()); return out; } finally { st.free(); }
}
function colNames(raw, table) { try { return rawAll(raw, `PRAGMA table_info(${table})`).map((c) => c.name); } catch { return []; } }
function utcStr(ms) { return new Date(ms).toISOString().slice(0, 19).replace('T', ' '); }
function parseUtc(s) { if (!s) return NaN; return Date.parse(String(s).replace(' ', 'T') + 'Z'); }
// orders.created_at 由 routes/line-orders.js 以台北時間字串寫入
function parseTaipei(s) { if (!s) return NaN; const t = Date.parse(String(s).replace(' ', 'T') + '+08:00'); return t; }

// ══════════════════════════════════════════════════════════════════════
//  Schema（安全遷移：只 CREATE IF NOT EXISTS／ALTER ADD COLUMN；不刪資料、不重建訂單表）
// ══════════════════════════════════════════════════════════════════════
function migrate(raw) {
  const bcols = colNames(raw, 'restock_notify_batches');
  if (bcols.length) {
    if (!bcols.includes('tracking_id')) raw.run("ALTER TABLE restock_notify_batches ADD COLUMN tracking_id TEXT DEFAULT ''");
    raw.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_rnb_store_tracking ON restock_notify_batches(store_id, tracking_id)
             WHERE tracking_id IS NOT NULL AND tracking_id <> ''`);
  }
  raw.run(`CREATE TABLE IF NOT EXISTS restock_notify_clicks (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    click_uuid    TEXT NOT NULL,
    store_id      TEXT NOT NULL,
    batch_uuid    TEXT NOT NULL,
    product_id    INTEGER NOT NULL,
    open_key      TEXT NOT NULL,
    line_user_id  TEXT DEFAULT '',
    recipient     INTEGER DEFAULT NULL,
    visitor_id    TEXT DEFAULT '',
    session_id    TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now')),
    identified_at TEXT DEFAULT NULL,
    import_source TEXT DEFAULT ''
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnc_uuid ON restock_notify_clicks(click_uuid)');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnc_open ON restock_notify_clicks(store_id, batch_uuid, open_key)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rnc_member ON restock_notify_clicks(store_id, line_user_id, product_id, created_at)');
  raw.run(`CREATE TABLE IF NOT EXISTS restock_notify_cart_adds (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    add_uuid      TEXT NOT NULL,
    store_id      TEXT NOT NULL,
    batch_uuid    TEXT NOT NULL,
    product_id    INTEGER NOT NULL,
    click_uuid    TEXT DEFAULT '',
    event_key     TEXT NOT NULL,
    line_user_id  TEXT DEFAULT '',
    recipient     INTEGER DEFAULT NULL,
    quantity      INTEGER NOT NULL DEFAULT 1,
    created_at    TEXT DEFAULT (datetime('now')),
    import_source TEXT DEFAULT ''
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rna_uuid ON restock_notify_cart_adds(add_uuid)');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rna_event ON restock_notify_cart_adds(store_id, event_key)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rna_batch ON restock_notify_cart_adds(store_id, batch_uuid)');
  raw.run(`CREATE TABLE IF NOT EXISTS restock_notify_order_attributions (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    attr_uuid           TEXT NOT NULL,
    store_id            TEXT NOT NULL,
    order_uuid          TEXT NOT NULL,
    order_number        TEXT DEFAULT '',
    product_id          INTEGER NOT NULL,
    batch_uuid          TEXT NOT NULL,
    click_uuid          TEXT DEFAULT '',
    line_user_id        TEXT NOT NULL,
    clicked_at          TEXT DEFAULT NULL,
    order_created_at    TEXT DEFAULT NULL,
    notify_supply_date  TEXT DEFAULT '',
    notify_mode         TEXT DEFAULT '',
    order_mode          TEXT DEFAULT '',
    order_pickup        TEXT DEFAULT '',
    quantity            INTEGER NOT NULL DEFAULT 0,
    item_gross          REAL NOT NULL DEFAULT 0,
    discount_alloc      REAL NOT NULL DEFAULT 0,
    item_net            REAL NOT NULL DEFAULT 0,
    rule_version        TEXT DEFAULT '',
    source              TEXT DEFAULT 'order_create',
    created_at          TEXT DEFAULT (datetime('now')),
    import_source       TEXT DEFAULT ''
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnoa_uuid ON restock_notify_order_attributions(attr_uuid)');
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_rnoa_order_product ON restock_notify_order_attributions(store_id, order_uuid, product_id)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rnoa_batch ON restock_notify_order_attributions(store_id, batch_uuid)');
  // C5.1：報表聚合與分頁用索引（只新增索引，不改資料）
  if (bcols.length) raw.run('CREATE INDEX IF NOT EXISTS idx_rnb_store_confirmed ON restock_notify_batches(store_id, confirmed_at, id)');
  if (colNames(raw, 'restock_notify_deliveries').length) raw.run('CREATE INDEX IF NOT EXISTS idx_rnd_store_batch_status_user ON restock_notify_deliveries(store_id, batch_uuid, status, line_user_id)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rnc_store_batch_user ON restock_notify_clicks(store_id, batch_uuid, line_user_id, recipient)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_rna_store_batch_user ON restock_notify_cart_adds(store_id, batch_uuid, line_user_id, recipient)');
}

function newTrackingId() { return crypto.randomBytes(15).toString('base64url'); } // 20 字元，不含個資

// ══════════════════════════════════════════════════════════════════════
//  共用：批次與收件人核對
// ══════════════════════════════════════════════════════════════════════
function batchByTracking(db, storeId, rt) {
  const s = String(rt || '');
  if (!TRACKING_RE.test(s)) return null;
  const b = db.get(`SELECT batch_uuid, store_id, product_id, fulfillment_mode, supply_date, status, confirmed_at
                    FROM restock_notify_batches WHERE store_id=? AND tracking_id=?`, [storeId, s]);
  if (!b || !b.confirmed_at || !CONFIRMED_BATCH_STATUSES.includes(b.status)) return null;
  return b;
}
// 是否為此批次「LINE 已受理」的收件人（受理時間必須早於或等於 atUtc）
function recipientOf(db, storeId, batchUuid, uid, atUtc) {
  if (!uid) return null;
  const d = db.get(`SELECT accepted_at FROM restock_notify_deliveries WHERE store_id=? AND batch_uuid=? AND line_user_id=? AND status='accepted'
                    ORDER BY id ASC LIMIT 1`, [storeId, batchUuid, uid]);
  if (!d) return 0;
  const acc = parseUtc(d.accepted_at);
  if (Number.isFinite(acc) && atUtc && acc > parseUtc(atUtc)) return 0;
  return 1;
}

// ══════════════════════════════════════════════════════════════════════
//  點擊（最終點餐頁「實際開啟目標商品」後由前端送出；GET 連結、預覽抓取、讀取商品資料都不會呼叫）
//  open_key：同一則連結在同一分頁的開啟識別（必要導向、重新整理、事件重送沿用同一個），只用來去重。
// ══════════════════════════════════════════════════════════════════════
function recordOpen(db, storeId, body, uid) {
  const b = batchByTracking(db, storeId, body.rt);
  if (!b) return { tracked: false };
  const pid = Number(body.product_id);
  if (!Number.isInteger(pid) || pid !== Number(b.product_id)) return { tracked: false };
  const openKey = String(body.open_key || '');
  if (!KEY_RE.test(openKey)) return { tracked: false };
  const now = utcStr(Date.now());
  const ex = db.get('SELECT * FROM restock_notify_clicks WHERE store_id=? AND batch_uuid=? AND open_key=?', [storeId, b.batch_uuid, openKey]);
  if (ex) {
    // 同一次開啟稍後才完成會員辨識：只補上「原本沒有會員」的紀錄；已綁定的會員不得改成另一位
    if (uid && !ex.line_user_id) {
      const rec = recipientOf(db, storeId, b.batch_uuid, uid, ex.created_at);
      db.run(`UPDATE restock_notify_clicks SET line_user_id=?, recipient=?, identified_at=? WHERE id=? AND (line_user_id IS NULL OR line_user_id='')`,
        [uid, rec, now, ex.id]);
      return { tracked: true, duplicate: true, identified: true };
    }
    return { tracked: true, duplicate: true };
  }
  // 同一工作階段同一批次的開啟次數上限（避免以大量隨機 open_key 灌入資料）
  const sid = String(body.session_id || '').slice(0, 200);
  if (sid) {
    const n = db.get('SELECT COUNT(*) AS c FROM restock_notify_clicks WHERE store_id=? AND batch_uuid=? AND session_id=?', [storeId, b.batch_uuid, sid]);
    if (n && Number(n.c) >= 20) return { tracked: false, limited: true };
  }
  const rec = uid ? recipientOf(db, storeId, b.batch_uuid, uid, now) : null;
  db.run(`INSERT OR IGNORE INTO restock_notify_clicks (click_uuid, store_id, batch_uuid, product_id, open_key, line_user_id, recipient, visitor_id, session_id, created_at, identified_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  [crypto.randomUUID(), storeId, b.batch_uuid, pid, openKey, uid || '', rec, String(body.visitor_id || '').slice(0, 200), sid, now, uid ? now : null]);
  return { tracked: true };
}

// ══════════════════════════════════════════════════════════════════════
//  加入購物車（沿用前台真正加購成功的 add_to_cart 事件；由 routes/analytics.js 在寫入該事件後呼叫）
//  只計入「通知商品」；必須先有同一次開啟的點擊紀錄；event_key 去重（重送不重複，正常再次加購仍保留次數）。
// ══════════════════════════════════════════════════════════════════════
function recordCartAdd(db, storeId, info, uid) {
  if (!info || typeof info !== 'object') return { tracked: false };
  const b = batchByTracking(db, storeId, info.rt);
  if (!b) return { tracked: false };
  const pid = Number(info.product_id);
  if (!Number.isInteger(pid) || pid !== Number(b.product_id)) return { tracked: false };
  const openKey = String(info.open_key || ''), eventKey = String(info.event_key || '');
  if (!KEY_RE.test(openKey) || !KEY_RE.test(eventKey)) return { tracked: false };
  const click = db.get('SELECT click_uuid, line_user_id FROM restock_notify_clicks WHERE store_id=? AND batch_uuid=? AND open_key=?', [storeId, b.batch_uuid, openKey]);
  if (!click) return { tracked: false };
  const now = utcStr(Date.now());
  // C5.1：會員只以「本次」後端驗證成功的 session 為準。
  //   - 本次沒有有效會員（未登入、過期、偽造）→ 只保留匿名事件，不沿用歷史點擊者的身分。
  //   - 本次會員與該次開啟已綁定的會員不同 → 以本次會員記錄但不視為收件人（recipient=0，不計入漏斗），
  //     不改綁、不冒用、不合併成同一位；既有紀錄保留。
  const member = uid || '';
  let rec = null;
  if (member) rec = (click.line_user_id && click.line_user_id !== member) ? 0 : recipientOf(db, storeId, b.batch_uuid, member, now);
  const qty = Math.max(1, Math.min(999, Math.trunc(Number(info.quantity) || 1)));
  db.run(`INSERT OR IGNORE INTO restock_notify_cart_adds (add_uuid, store_id, batch_uuid, product_id, click_uuid, event_key, line_user_id, recipient, quantity, created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?)`,
  [crypto.randomUUID(), storeId, b.batch_uuid, pid, click.click_uuid, eventKey, member, rec, qty, now]);
  return { tracked: true };
}

// ══════════════════════════════════════════════════════════════════════
//  金額分攤（固定規則，見檔頭）：輸入各明細的分（整數），回傳每一明細分到的折扣（分）
// ══════════════════════════════════════════════════════════════════════
function allocateDiscountCents(lineCents, discountCents) {
  const total = lineCents.reduce((s, x) => s + x, 0);
  const D = Math.max(0, Math.min(Math.round(discountCents), total));
  if (!D || !total) return lineCents.map(() => 0);
  const raw = lineCents.map((c) => (D * c) / total);
  const base = raw.map((r) => Math.floor(r));
  let rest = D - base.reduce((s, x) => s + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => (b.frac - a.frac) || (a.i - b.i));
  for (let k = 0; k < order.length && rest > 0; k++, rest--) base[order[k].i]++;
  return base;
}
const toCents = (v) => Math.round(Number(v || 0) * 100);
const fromCents = (c) => Math.round(c) / 100;

// ══════════════════════════════════════════════════════════════════════
//  訂單歸因（訂單建立後由 routes/line-orders.js 呼叫；補登 reconcile 亦用此函式，可重跑不重複）
//  C5.1：
//    - 先唯讀計算「這張訂單還缺哪些商品的歸因」，再以一個獨立的 durable 交易一次寫入（全部成功或全部不寫），
//      不留下半套資料；與訂單／付款交易分開，失敗不回滾已成立的訂單或付款。
//    - 判斷單位是「店別＋訂單 uuid＋商品」：已存在的歸因（含 C5 留下的半套資料）原樣保留，只補缺少的商品。
//    - 視窗以實際保存的訂單建立時間（order_ms）計算，不使用補登時間。
// ══════════════════════════════════════════════════════════════════════
function planOrderAttribution(db, storeId, o) {
  const uid = String(o.line_user_id || '');
  if (!uid || !o.order_uuid) return [];
  const orderMs = Number.isFinite(o.order_ms) ? o.order_ms : Date.now();
  const orderUtc = utcStr(orderMs), fromUtc = utcStr(orderMs - WINDOW_MS);
  let items = o.items;
  if (typeof items === 'string') { try { items = JSON.parse(items || '[]'); } catch { items = []; } }
  if (!Array.isArray(items) || !items.length) return [];
  // 明細金額（分）與分攤
  const lines = items.map((it) => ({ pid: Number(it.product_id != null ? it.product_id : it.id), qty: Math.max(0, Math.trunc(Number(it.qty) || 0)), cents: toCents(Number(it.price || 0) * Number(it.qty || 0)) }));
  const alloc = allocateDiscountCents(lines.map((l) => l.cents), toCents(o.discount_amount));
  const byPid = new Map();
  lines.forEach((l, i) => {
    if (!Number.isInteger(l.pid) || l.pid <= 0) return;
    const cur = byPid.get(l.pid) || { qty: 0, gross: 0, disc: 0 };
    cur.qty += l.qty; cur.gross += l.cents; cur.disc += alloc[i];
    byPid.set(l.pid, cur);
  });
  const plan = [];
  for (const [pid, agg] of byPid) {
    if (db.get('SELECT 1 AS x FROM restock_notify_order_attributions WHERE store_id=? AND order_uuid=? AND product_id=?', [storeId, String(o.order_uuid), pid])) continue;
    const click = db.get(`SELECT c.click_uuid, c.batch_uuid, c.created_at, b.supply_date, b.fulfillment_mode
                          FROM restock_notify_clicks c
                          JOIN restock_notify_batches b ON b.store_id=c.store_id AND b.batch_uuid=c.batch_uuid
                          WHERE c.store_id=? AND c.line_user_id=? AND c.recipient=1 AND c.product_id=?
                            AND c.created_at >= ? AND c.created_at <= ?
                            AND EXISTS (SELECT 1 FROM restock_notify_deliveries d WHERE d.store_id=c.store_id AND d.batch_uuid=c.batch_uuid
                                         AND d.line_user_id=c.line_user_id AND d.status='accepted' AND d.accepted_at <= c.created_at)
                          ORDER BY c.created_at DESC, c.id DESC LIMIT 1`, [storeId, uid, pid, fromUtc, orderUtc]);
    if (!click) continue;
    plan.push([crypto.randomUUID(), storeId, String(o.order_uuid), String(o.order_number || ''), pid, click.batch_uuid, click.click_uuid, uid,
      click.created_at, orderUtc, click.supply_date || '', click.fulfillment_mode || '', String(o.order_mode || ''), String(o.pickup || ''),
      agg.qty, fromCents(agg.gross), fromCents(agg.disc), fromCents(agg.gross - agg.disc), RULE_VERSION, o.source || 'order_create']);
  }
  return plan;
}
function attributeOrder(db, storeId, o) {
  const plan = planOrderAttribution(db, storeId, o);
  if (!plan.length) return { attributed: 0 };
  let n = 0;
  const write = (raw) => {
    for (const row of plan) {
      raw.run(`INSERT OR IGNORE INTO restock_notify_order_attributions (attr_uuid, store_id, order_uuid, order_number, product_id, batch_uuid, click_uuid, line_user_id,
                clicked_at, order_created_at, notify_supply_date, notify_mode, order_mode, order_pickup, quantity, item_gross, discount_alloc, item_net, rule_version, source, created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))`, row);
      n += raw.getRowsModified() ? 1 : 0;
    }
  };
  // 同一訂單的所有商品歸因：一個交易，全部成功或全部不寫
  if (typeof db.runDurableTransaction === 'function') db.runDurableTransaction(() => write(db._db));
  else { db._db.run('BEGIN'); try { write(db._db); db._db.run('COMMIT'); } catch (e) { try { db._db.run('ROLLBACK'); } catch {} throw e; } }
  return { attributed: n };
}
// 補登：指定期間內有會員的 LINE 訂單，逐張補上「缺少的商品歸因」（不以整張訂單是否已有紀錄判斷）。
// 可重跑、不重複計算；回報掃描、補齊（訂單／明細）、略過、失敗數量。
function reconcileOrders(db, storeId, opts = {}) {
  const days = Math.max(1, Math.min(90, Math.trunc(Number(opts.days) || 30)));
  const since = new Date(Date.now() + 8 * 3600e3 - days * 86400e3).toISOString().slice(0, 19).replace('T', ' ');
  const rows = db.all(`SELECT uuid, order_number, line_user_id, items, discount_amount, order_mode, pickup_time, created_at
                       FROM orders WHERE store_id=? AND source='line' AND COALESCE(line_user_id,'')<>'' AND created_at >= ? AND COALESCE(uuid,'')<>''`,
  [storeId, since]);
  let scanned = 0, attributed = 0, completed = 0, skipped = 0, failed = 0;
  for (const r of rows) {
    scanned++;
    const ms = parseTaipei(r.created_at);
    if (!Number.isFinite(ms)) { skipped++; continue; }
    try {
      const out = attributeOrder(db, storeId, { order_uuid: r.uuid, order_number: r.order_number, line_user_id: r.line_user_id, items: r.items,
        discount_amount: r.discount_amount, order_mode: r.order_mode, pickup: r.pickup_time, order_ms: ms, source: 'reconcile' });
      if (out.attributed > 0) { attributed += out.attributed; completed++; } else skipped++;
    } catch (e) { failed++; /* 單筆失敗不影響其他 */ }
  }
  return { scanned, attributed, completed_orders: completed, skipped, failed, days };
}

// ══════════════════════════════════════════════════════════════════════
//  報表：以「通知批次」為群體（篩選：批次確認日期範圍［台北］、商品、取餐方式、批次）。
//  分子、分母都屬於同一批次群體，不混用事件日期。C5 以前的批次（沒有追蹤識別）標示「未建立追蹤」，數字為 null。
// ══════════════════════════════════════════════════════════════════════
function pct(n, d) { return d > 0 ? Math.round((n / d) * 10000) / 100 : null; }
// C5.1：總計依「完整篩選範圍」在資料庫聚合；明細另行分頁（page／page_size），分頁或每頁筆數不影響總計。
//   - 篩選（批次確認日期［台北］、商品、取餐方式、批次）總計與明細使用同一組條件。
//   - 指標口徑與 C5 相同：已核對點擊＝收件人（recipient=1）且為該批次 LINE 已受理收件人；加購、下單、成交只計已核對點擊者；
//     有效訂單排除作廢與取消；成交＝有 purchase 且（非 LINE Pay 或已付款）。未建立追蹤的舊批次只計已受理人數。
//   - 跨批次合計：人數依「批次＋會員」計，訂單數跨批次去重；合計比率只用有追蹤的批次。
const MAX_PAGE_SIZE = 200;
function batchWhere(storeId, q) {
  const where = ['b.store_id=?', 'b.confirmed_at IS NOT NULL'];
  const params = [storeId];
  const tz = "datetime(b.confirmed_at, '+8 hours')"; // confirmed_at 為 UTC；以台北日期篩選
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.from || ''))) { where.push(`date(${tz}) >= ?`); params.push(q.from); }
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(q.to || ''))) { where.push(`date(${tz}) <= ?`); params.push(q.to); }
  if (q.product_id != null && q.product_id !== '' && Number.isInteger(Number(q.product_id))) { where.push('b.product_id=?'); params.push(Number(q.product_id)); }
  if (q.mode === 'takeout' || q.mode === 'delivery') { where.push('b.fulfillment_mode=?'); params.push(q.mode); }
  if (q.batch_uuid && UUID_RE.test(String(q.batch_uuid))) { where.push('b.batch_uuid=?'); params.push(String(q.batch_uuid)); }
  // C6：手動／自動來源篩選（口徑相同，只是分開檢視；舊批次沒有欄位值時視為手動）
  if (q.source === 'manual' || q.source === 'auto') { where.push("COALESCE(b.source,'manual')=?"); params.push(q.source); }
  return { where: where.join(' AND '), params };
}
// 某批次的「已核對點擊者」判斷（X 為帶 line_user_id 的別名）
const VCLICK = (x) => `EXISTS (SELECT 1 FROM restock_notify_clicks vc WHERE vc.store_id=b.store_id AND vc.batch_uuid=b.batch_uuid AND vc.line_user_id=${x}.line_user_id AND vc.recipient=1
  AND EXISTS (SELECT 1 FROM restock_notify_deliveries vd WHERE vd.store_id=vc.store_id AND vd.batch_uuid=vc.batch_uuid AND vd.line_user_id=vc.line_user_id AND vd.status='accepted'))`;
const VALID_ATTR = `o.status IS NOT NULL AND o.status<>'void' AND COALESCE(o.order_status,'')<>'cancelled' AND ${VCLICK('a')}`;
const DEAL_ATTR = `EXISTS (SELECT 1 FROM analytics_events e WHERE e.store_id=a.store_id AND e.order_id=a.order_uuid AND e.event_name='purchase')
  AND (COALESCE(o.payment_method,'')<>'linepay' OR o.payment_status='paid')`;
const ATTR_FROM = `FROM restock_notify_order_attributions a JOIN orders o ON o.uuid=a.order_uuid AND o.store_id=a.store_id WHERE a.store_id=b.store_id AND a.batch_uuid=b.batch_uuid`;
const PER_BATCH_COLS = `
  b.id AS _id, b.batch_uuid, b.product_id, b.product_name_snapshot AS product_name, b.fulfillment_mode, b.supply_date, b.status, b.confirmed_at, COALESCE(b.source,'manual') AS source,
  (COALESCE(b.tracking_id,'')<>'') AS tracked,
  (SELECT COUNT(DISTINCT d.line_user_id) FROM restock_notify_deliveries d WHERE d.store_id=b.store_id AND d.batch_uuid=b.batch_uuid AND d.status='accepted') AS accepted_people,
  (SELECT COUNT(*) FROM restock_notify_clicks c WHERE c.store_id=b.store_id AND c.batch_uuid=b.batch_uuid) AS all_clicks,
  (SELECT COUNT(*) FROM restock_notify_clicks c WHERE c.store_id=b.store_id AND c.batch_uuid=b.batch_uuid AND c.recipient=1
     AND EXISTS (SELECT 1 FROM restock_notify_deliveries d WHERE d.store_id=c.store_id AND d.batch_uuid=c.batch_uuid AND d.line_user_id=c.line_user_id AND d.status='accepted')) AS click_count,
  (SELECT COUNT(DISTINCT c.line_user_id) FROM restock_notify_clicks c WHERE c.store_id=b.store_id AND c.batch_uuid=b.batch_uuid AND c.recipient=1
     AND EXISTS (SELECT 1 FROM restock_notify_deliveries d WHERE d.store_id=c.store_id AND d.batch_uuid=c.batch_uuid AND d.line_user_id=c.line_user_id AND d.status='accepted')) AS click_people,
  (SELECT COUNT(DISTINCT ad.line_user_id) FROM restock_notify_cart_adds ad WHERE ad.store_id=b.store_id AND ad.batch_uuid=b.batch_uuid AND ad.recipient=1 AND ${VCLICK('ad')}) AS add_people,
  (SELECT COUNT(DISTINCT a.line_user_id) ${ATTR_FROM} AND ${VALID_ATTR}) AS order_people,
  (SELECT COUNT(DISTINCT a.line_user_id) ${ATTR_FROM} AND ${VALID_ATTR} AND ${DEAL_ATTR}) AS deal_people,
  (SELECT COUNT(DISTINCT a.order_uuid) ${ATTR_FROM} AND ${VALID_ATTR}) AS orders,
  (SELECT COUNT(DISTINCT a.order_uuid) ${ATTR_FROM} AND ${VALID_ATTR} AND ${DEAL_ATTR}) AS deal_orders,
  (SELECT COALESCE(SUM(CAST(ROUND(a.item_net*100) AS INTEGER)),0) ${ATTR_FROM} AND ${VALID_ATTR} AND ${DEAL_ATTR}) AS amount_cents,
  (SELECT COUNT(*) ${ATTR_FROM} AND ${VALID_ATTR} AND ${DEAL_ATTR} AND COALESCE(o.refund_status,'') IN ('refunded','pending_refund')) AS refund_flagged`;
function batchRowOut(r) {
  const row = {
    batch_uuid: r.batch_uuid, product_id: r.product_id, product_name: r.product_name, fulfillment_mode: r.fulfillment_mode,
    supply_date: r.supply_date, status: r.status, confirmed_at: r.confirmed_at, tracked: !!Number(r.tracked), accepted_people: Number(r.accepted_people) || 0,
    source: r.source || 'manual', // C6
  };
  if (!row.tracked) {
    return Object.assign(row, { click_people: null, click_count: null, add_people: null, order_people: null, deal_people: null, orders: null, deal_orders: null, amount: null,
      other_opens: null, ctr: null, add_rate: null, click_deal_rate: null, notify_deal_rate: null, note: 'untracked' });
  }
  const cp = Number(r.click_people) || 0, acc = row.accepted_people, addp = Number(r.add_people) || 0, dp = Number(r.deal_people) || 0;
  return Object.assign(row, {
    click_people: cp, click_count: Number(r.click_count) || 0, add_people: addp, order_people: Number(r.order_people) || 0, deal_people: dp,
    orders: Number(r.orders) || 0, deal_orders: Number(r.deal_orders) || 0, amount: (Number(r.amount_cents) || 0) / 100,
    other_opens: (Number(r.all_clicks) || 0) - (Number(r.click_count) || 0), refund_flagged: Number(r.refund_flagged) || 0,
    ctr: pct(cp, acc), add_rate: pct(addp, cp), click_deal_rate: pct(dp, cp), notify_deal_rate: pct(dp, acc),
  });
}
function summary(db, storeId, q = {}) {
  const { where, params } = batchWhere(storeId, q);
  const pageSize = Math.max(1, Math.min(MAX_PAGE_SIZE, Math.trunc(Number(q.page_size) || 50)));
  // 總計：完整篩選範圍的批次聚合（資料庫內加總，不載入逐筆事件）
  const agg = db.get(`SELECT COUNT(*) AS batches, COALESCE(SUM(tracked),0) AS tracked_batches,
      COALESCE(SUM(accepted_people),0) AS accepted_people, COALESCE(SUM(CASE WHEN tracked THEN accepted_people ELSE 0 END),0) AS tracked_accepted_people,
      COALESCE(SUM(CASE WHEN tracked THEN click_people END),0) AS click_people, COALESCE(SUM(CASE WHEN tracked THEN click_count END),0) AS click_count,
      COALESCE(SUM(CASE WHEN tracked THEN add_people END),0) AS add_people, COALESCE(SUM(CASE WHEN tracked THEN order_people END),0) AS order_people,
      COALESCE(SUM(CASE WHEN tracked THEN deal_people END),0) AS deal_people, COALESCE(SUM(CASE WHEN tracked THEN amount_cents END),0) AS amount_cents,
      COALESCE(SUM(CASE WHEN tracked THEN all_clicks - click_count END),0) AS other_opens, COALESCE(SUM(CASE WHEN tracked THEN refund_flagged END),0) AS refund_flagged
    FROM (SELECT ${PER_BATCH_COLS} FROM restock_notify_batches b WHERE ${where})`, params) || {};
  // 訂單數跨批次去重（有追蹤的批次）
  const od = db.get(`SELECT COUNT(DISTINCT a.order_uuid) AS orders,
      COUNT(DISTINCT CASE WHEN ${DEAL_ATTR} THEN a.order_uuid END) AS deal_orders
    FROM restock_notify_batches b JOIN restock_notify_order_attributions a ON a.store_id=b.store_id AND a.batch_uuid=b.batch_uuid
    JOIN orders o ON o.uuid=a.order_uuid AND o.store_id=a.store_id
    WHERE ${where} AND COALESCE(b.tracking_id,'')<>'' AND ${VALID_ATTR}`, params) || {};
  const totalBatches = Number(agg.batches) || 0;
  const trackedBatches = Number(agg.tracked_batches) || 0;
  const totalPages = Math.max(1, Math.ceil(totalBatches / pageSize));
  const page = Math.max(1, Math.min(totalPages, Math.trunc(Number(q.page) || 1)));
  // 明細：同一條件，依確認時間新到舊分頁
  const rows = db.all(`SELECT ${PER_BATCH_COLS} FROM restock_notify_batches b WHERE ${where} ORDER BY b.confirmed_at DESC, b.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, (page - 1) * pageSize]).map(batchRowOut);
  const T = (v) => (trackedBatches ? Number(v) || 0 : null);
  const trackedAccepted = Number(agg.tracked_accepted_people) || 0;
  const totals = {
    batches: totalBatches, tracked_batches: trackedBatches, untracked_batches: totalBatches - trackedBatches,
    accepted_people: Number(agg.accepted_people) || 0, tracked_accepted_people: trackedAccepted,
    click_people: T(agg.click_people), click_count: T(agg.click_count), add_people: T(agg.add_people), order_people: T(agg.order_people),
    deal_people: T(agg.deal_people), orders: T(od.orders), deal_orders: T(od.deal_orders),
    amount: trackedBatches ? (Number(agg.amount_cents) || 0) / 100 : null, other_opens: T(agg.other_opens), refund_flagged: T(agg.refund_flagged),
  };
  totals.ctr = trackedBatches ? pct(totals.click_people, trackedAccepted) : null;
  totals.add_rate = trackedBatches ? pct(totals.add_people, totals.click_people) : null;
  totals.click_deal_rate = trackedBatches ? pct(totals.deal_people, totals.click_people) : null;
  totals.notify_deal_rate = trackedBatches ? pct(totals.deal_people, trackedAccepted) : null;
  // 商品篩選選項：本店所有已確認批次的商品（不只當頁），名稱取最近一次批次的快照
  const product_options = db.all(`SELECT b.product_id, (SELECT b2.product_name_snapshot FROM restock_notify_batches b2 WHERE b2.store_id=b.store_id AND b2.product_id=b.product_id
                                    AND b2.confirmed_at IS NOT NULL ORDER BY b2.confirmed_at DESC, b2.id DESC LIMIT 1) AS product_name, COUNT(*) AS batches
                                  FROM restock_notify_batches b WHERE b.store_id=? AND b.confirmed_at IS NOT NULL GROUP BY b.product_id ORDER BY product_name, b.product_id`, [storeId])
    .map((r) => ({ product_id: r.product_id, product_name: r.product_name || '', batches: Number(r.batches) || 0 }));
  return {
    rule: { version: RULE_VERSION, window_hours: 168, attribution: 'last_valid_click', amount: 'item_net_after_proportional_discount_excluding_delivery_fee' },
    filters: { from: q.from || null, to: q.to || null, product_id: q.product_id || null, mode: q.mode || null, batch_uuid: q.batch_uuid || null, source: q.source || null },
    totals, batches: rows,
    page: { page, page_size: pageSize, total_batches: totalBatches, total_pages: totalPages, has_more: page < totalPages },
    product_options,
  };
}

module.exports = {
  RULE_VERSION, WINDOW_MS, TRACKING_RE, migrate, newTrackingId, batchByTracking, recipientOf, recordOpen, recordCartAdd,
  allocateDiscountCents, planOrderAttribution, attributeOrder, reconcileOrders, summary,
};
