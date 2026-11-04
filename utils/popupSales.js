// utils/popupSales.js — R53 快閃場次商品販售管理（獨立通路、獨立場次、獨立資料）
//
// 權威規則：
//   - 每個快閃場次、每個商品的販售設定只存在 popup_session_product_sales，
//     與一般 LINE「今日販售管理」（products.line_quota_* / line_preorder_*）完全無關，
//     本檔不讀寫任何 products.line_quota_* 欄位。
//   - 沒有設定列 = 預設「啟用、不限量、無每筆限購」；R52 selected 場次若
//     popup_session_products.quota_qty>0，視為「限量 quota_qty」（相容既有語意）。
//   - 數量帳本沿用 popup_order_allocations（status='active' 才占用），R53 新增
//     stock_state：'reserved'（LINE Pay 等待付款保留）／'committed'（已成立）。
//     剩餘 = 總販售數量 − 已保留 − 已成立；status='released' 代表已釋放（只會釋放一次）。
//   - 所有檢查都在呼叫端的 durable transaction 內以 fresh 查詢執行；前端顯示的
//     剩餘數量只是提示，不作為下單依據。
'use strict';

const pp = require('./popupPickup');

const STOCK_MODES = new Set(['unlimited', 'limited']);
const MAX_STOCK = 1000000;
const MAX_PER_ORDER = 999;

function _hasColumn(raw, table, col) {
  const r = raw.exec(`PRAGMA table_info(${table})`);
  if (!r.length) return false;
  const nameIdx = r[0].columns.indexOf('name');
  return r[0].values.some((v) => v[nameIdx] === col);
}
function _hasTable(raw, name) {
  const r = raw.exec("SELECT name FROM sqlite_master WHERE type='table' AND name=?", [name]);
  return !!(r.length && r[0].values.length);
}

// 交易內 migration（additive、idempotent）。
function _migrate(raw) {
  raw.run(`CREATE TABLE IF NOT EXISTS popup_session_product_sales (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id         TEXT NOT NULL,
    session_id       TEXT NOT NULL,
    product_id       INTEGER NOT NULL,
    sale_enabled     INTEGER NOT NULL DEFAULT 1,
    stock_mode       TEXT NOT NULL DEFAULT 'unlimited',
    stock_total      INTEGER NOT NULL DEFAULT 0,
    per_order_limit  INTEGER NOT NULL DEFAULT 0,
    manual_sold_out  INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT DEFAULT (datetime('now','localtime')),
    updated_at       TEXT DEFAULT (datetime('now','localtime'))
  )`);
  raw.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_popup_sales_uniq ON popup_session_product_sales(store_id, session_id, product_id)');
  raw.run('CREATE INDEX IF NOT EXISTS idx_popup_sales_session ON popup_session_product_sales(session_id)');
  if (_hasTable(raw, 'popup_order_allocations') && !_hasColumn(raw, 'popup_order_allocations', 'stock_state')) {
    raw.run("ALTER TABLE popup_order_allocations ADD COLUMN stock_state TEXT NOT NULL DEFAULT ''");
  }
  if (_hasTable(raw, 'popup_order_allocations')) {
    // R52（或回滾期間 R52 程式）寫入、尚未分類的 active 占用：依付款 attempt 判斷。
    // pending／failed（改現金前保留中）＝ reserved；其餘＝ committed。已釋放列不動。
    if (_hasTable(raw, 'popup_payment_attempts')) {
      raw.run(`UPDATE popup_order_allocations SET stock_state='reserved'
               WHERE stock_state='' AND status='active' AND EXISTS (
                 SELECT 1 FROM popup_payment_attempts a
                 WHERE a.order_id=popup_order_allocations.order_id AND a.store_id=popup_order_allocations.store_id
                   AND a.status IN ('pending','failed'))`);
    }
    raw.run("UPDATE popup_order_allocations SET stock_state='committed' WHERE stock_state='' AND status='active'");
  }
}

function _needsMigration(raw) {
  if (!_hasTable(raw, 'popup_session_product_sales')) return true;
  if (_hasTable(raw, 'popup_order_allocations')) {
    if (!_hasColumn(raw, 'popup_order_allocations', 'stock_state')) return true;
    const r = raw.exec("SELECT 1 FROM popup_order_allocations WHERE stock_state='' AND status='active' LIMIT 1");
    if (r.length && r[0].values.length) return true;
  }
  return false;
}

// 只可在交易外呼叫（啟動時、各 route 進入交易前）：migration 並 durable 寫入。
function ensurePopupSalesSchema(db) {
  if (!_needsMigration(db._db)) return false;
  db.runDurableTransaction(() => { _migrate(db._db); });
  return true;
}
// 交易內／外皆可：只在記憶體 DB 補齊（不記憶化；外層 rollback 時 DDL 一併 rollback，下次會重做）。
function ensureRaw(db) {
  if (_needsMigration(db._db)) _migrate(db._db);
}
// 啟動時 migration（utils/db.js initDb 呼叫；additive、idempotent）。
function migrateRawAtStartup(raw) {
  if (_needsMigration(raw)) { _migrate(raw); return true; }
  return false;
}

function _int(v) { return Number(v) || 0; }

function getSalesRow(db, storeId, sessionId, productId) {
  ensureRaw(db);
  return db.get(
    'SELECT * FROM popup_session_product_sales WHERE store_id=? AND session_id=? AND product_id=?',
    [storeId, sessionId, productId]
  ) || null;
}

// 有效設定（sp：selected 場次的 popup_session_products 列；all_takeout 傳 null）
function effectiveConfig(salesRow, sp) {
  const legacyQuota = sp ? _int(sp.quota_qty) : 0;
  if (salesRow) {
    const limited = salesRow.stock_mode === 'limited';
    return {
      sale_enabled: _int(salesRow.sale_enabled) === 1,
      stock_mode: limited ? 'limited' : 'unlimited',
      stock_total: limited ? _int(salesRow.stock_total) : null,
      per_order_limit: _int(salesRow.per_order_limit) > 0 ? _int(salesRow.per_order_limit) : null,
      manual_sold_out: _int(salesRow.manual_sold_out) === 1,
      configured: true,
      updated_at: salesRow.updated_at || null,
    };
  }
  return {
    sale_enabled: true,
    stock_mode: legacyQuota > 0 ? 'limited' : 'unlimited',
    stock_total: legacyQuota > 0 ? legacyQuota : null,
    per_order_limit: null,
    manual_sold_out: false,
    configured: false,
    updated_at: null,
  };
}

function usage(db, storeId, sessionId, productId) {
  ensureRaw(db);
  const row = db.get(
    `SELECT COALESCE(SUM(CASE WHEN stock_state='reserved' THEN qty ELSE 0 END),0) AS reserved,
            COALESCE(SUM(CASE WHEN stock_state='reserved' THEN 0 ELSE qty END),0) AS committed
     FROM popup_order_allocations WHERE store_id=? AND session_id=? AND product_id=? AND status='active'`,
    [storeId, sessionId, productId]
  );
  return { reserved: row ? _int(row.reserved) : 0, committed: row ? _int(row.committed) : 0 };
}

function getSpRow(db, storeId, session, productId) {
  if (session.product_scope !== 'selected') return null;
  return db.get(
    'SELECT product_id, enabled, quota_qty FROM popup_session_products WHERE session_id=? AND store_id=? AND product_id=?',
    [session.id, storeId, productId]
  ) || null;
}

// 單一商品在此場次的完整販售狀態（交易內、交易外皆可呼叫；值一律 fresh）。
function productSaleState(db, storeId, session, productId) {
  const sp = getSpRow(db, storeId, session, productId);
  const inSession = session.product_scope === 'selected' ? !!(sp && _int(sp.enabled) === 1) : true;
  const cfg = effectiveConfig(getSalesRow(db, storeId, session.id, productId), sp);
  const u = usage(db, storeId, session.id, productId);
  const remaining = cfg.stock_mode === 'limited' ? Math.max(0, cfg.stock_total - u.reserved - u.committed) : null;
  const soldOut = cfg.manual_sold_out || (remaining !== null && remaining <= 0);
  return { in_session: inSession, ...cfg, reserved: u.reserved, committed: u.committed, remaining, sold_out: soldOut };
}

// 結帳權威檢查：grouped = Map(product_id -> qty)；names = Map(product_id -> 顯示名稱)。
// 任一商品不足即整張訂單失敗，並一次回傳所有衝突（結構化），不建立訂單／付款／名額。
function assertCheckoutStock(db, storeId, session, grouped, names) {
  const conflicts = [];
  grouped.forEach((qty, productId) => {
    const st = productSaleState(db, storeId, session, productId);
    const name = (names && names.get(productId)) || '';
    if (!st.in_session) { conflicts.push({ product_id: productId, name, reason: 'not_in_session', requested: qty, available: 0 }); return; }
    if (!st.sale_enabled) { conflicts.push({ product_id: productId, name, reason: 'disabled', requested: qty, available: 0 }); return; }
    if (st.manual_sold_out) { conflicts.push({ product_id: productId, name, reason: 'sold_out', requested: qty, available: 0 }); return; }
    let available = st.remaining;
    if (st.per_order_limit !== null && (available === null || st.per_order_limit < available)) available = st.per_order_limit;
    if (st.per_order_limit !== null && qty > st.per_order_limit && (st.remaining === null || st.per_order_limit <= st.remaining)) {
      conflicts.push({ product_id: productId, name, reason: 'over_limit', requested: qty, available: st.per_order_limit, per_order_limit: st.per_order_limit });
      return;
    }
    if (st.remaining !== null && qty > st.remaining) {
      conflicts.push({ product_id: productId, name, reason: st.remaining <= 0 ? 'sold_out' : 'insufficient', requested: qty, available: Math.max(0, available) });
    }
  });
  if (!conflicts.length) return;
  const first = conflicts[0];
  const extra = { conflicts, product_id: first.product_id, remaining: first.available };
  if (conflicts.some((c) => c.reason === 'not_in_session' || c.reason === 'disabled')) {
    const c = conflicts.find((x) => x.reason === 'not_in_session' || x.reason === 'disabled');
    pp.fail('POPUP_PRODUCT_NOT_IN_SESSION', `商品「${c.name || c.product_id}」不在此場次可售清單中`, 409, extra);
  }
  if (conflicts.some((c) => c.reason === 'over_limit')) {
    const c = conflicts.find((x) => x.reason === 'over_limit');
    pp.fail('POPUP_PRODUCT_OVER_LIMIT', `商品「${c.name || c.product_id}」每筆訂單最多 ${c.per_order_limit} 份`, 409, extra);
  }
  pp.fail('POPUP_PRODUCT_SOLD_OUT', `商品「${first.name || first.product_id}」剩餘份數不足`, 409, extra);
}

// LINE Pay 付款成功：reserved → committed（每筆只轉一次；重複呼叫 0 rows）。
function commitReservedForOrder(db, storeId, orderId) {
  ensureRaw(db);
  db._db.run(
    "UPDATE popup_order_allocations SET stock_state='committed' WHERE store_id=? AND order_id=? AND status='active' AND stock_state='reserved'",
    [storeId, orderId]
  );
  return db._db.getRowsModified();
}

// ── 管理端 ─────────────────────────────────────────────────────────────
function candidateProducts(db, storeId, session) {
  const { resolveLineProductPricing } = require('./lineProductPricing');
  const cols = `p.id AS product_id, p.name, p.price, p.takeaway_price, p.line_name, p.line_price, p.enabled, p.show_on_line,
    p.sale_status, p.line_sold_out, p.line_takeout_enabled, p.image, p.line_image_url, p.category, p.line_category`;
  const rows = session.product_scope === 'selected'
    ? db.all(`SELECT ${cols} FROM popup_session_products sp JOIN products p ON p.id=sp.product_id AND p.store_id=sp.store_id
              WHERE sp.session_id=? AND sp.store_id=? AND sp.enabled=1 ORDER BY p.sort_order ASC, p.id ASC`, [session.id, storeId])
    : db.all(`SELECT ${cols} FROM products p WHERE p.store_id=? AND p.enabled=1 AND p.show_on_line=1 ORDER BY p.sort_order ASC, p.id ASC`, [storeId]);
  return rows.map((r) => {
    const pr = resolveLineProductPricing(r);
    return { row: r, orderable: !!pr.is_line_takeout_orderable, name: pr.name || r.name, price: pr.price };
  }).filter((x) => x.orderable || session.product_scope === 'selected');
}

function sessionTimingState(session, campaignStatus, now) {
  return pp.resolvePopupSessionState({
    campaignStatus, sessionStatus: session.status, pickupDate: session.pickup_date,
    pickupStartTime: session.pickup_start_time, pickupEndTime: session.pickup_end_time,
    orderOpenAt: session.order_open_at, orderCutoffAt: session.order_cutoff_at, now: now || Date.now(),
  }).state;
}

// 批次套用目標是否允許：預設只允許「尚未開放下單」（含草稿、暫停但尚未開放）；
// include_open=true 時另允許「下單中」。已截止、取貨中、已結束、已取消、已封存一律拒絕。
function batchTargetAllowed(session, campaignStatus, includeOpen, now) {
  if (['cancelled', 'archived'].includes(session.status) || campaignStatus === 'archived') return { ok: false, reason: '場次已取消或封存' };
  const state = sessionTimingState({ ...session, status: session.status === 'draft' || session.status === 'paused' ? 'published' : session.status },
    campaignStatus === 'draft' || campaignStatus === 'paused' ? 'published' : campaignStatus, now);
  if (state === 'scheduled') return { ok: true, state };
  if (state === 'ordering_open') return includeOpen ? { ok: true, state } : { ok: false, reason: '場次已開放下單（已開始）' };
  return { ok: false, reason: state === 'ended' ? '場次已結束' : '場次已截止或取貨中' };
}

function listSessionSales(db, storeId, session) {
  const { resolvePopupProductImage } = require('./popupCheckout');
  return candidateProducts(db, storeId, session).map(({ row, orderable, name, price }) => {
    const st = productSaleState(db, storeId, session, row.product_id);
    const imgRes = resolvePopupProductImage ? resolvePopupProductImage(row, session.public_code) : null;
    const img = imgRes && typeof imgRes === 'object' ? imgRes.url : imgRes;
    let status;
    if (!orderable) status = 'product_unavailable';
    else if (!st.sale_enabled) status = 'disabled';
    else if (st.manual_sold_out) status = 'manual_sold_out';
    else if (st.sold_out) status = 'sold_out';
    else status = 'on_sale';
    return {
      product_id: row.product_id, name, price, image_url: img || null, category: row.line_category || row.category || '',
      product_orderable: orderable,
      sale_enabled: st.sale_enabled, stock_mode: st.stock_mode, stock_total: st.stock_total,
      reserved: st.reserved, committed: st.committed, remaining: st.remaining,
      per_order_limit: st.per_order_limit, manual_sold_out: st.manual_sold_out, sold_out: st.sold_out,
      status, configured: st.configured, updated_at: st.updated_at,
    };
  });
}

function _isNonNegInt(v) { return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0; }

// 驗證單一商品的更新欄位（只接受白名單欄位，型別嚴格）。
function normalizeSalesPatch(raw, idx) {
  if (!raw || typeof raw !== 'object') pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}] 格式錯誤`);
  const out = {};
  if (raw.sale_enabled !== undefined) {
    if (typeof raw.sale_enabled !== 'boolean') pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].sale_enabled 必須是 true/false`);
    out.sale_enabled = raw.sale_enabled;
  }
  if (raw.stock_mode !== undefined) {
    if (!STOCK_MODES.has(raw.stock_mode)) pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].stock_mode 只能是 unlimited 或 limited`);
    out.stock_mode = raw.stock_mode;
  }
  if (raw.stock_total !== undefined) {
    if (!_isNonNegInt(raw.stock_total) || raw.stock_total > MAX_STOCK) pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].stock_total 必須是 0~${MAX_STOCK} 的整數`);
    out.stock_total = raw.stock_total;
  }
  if (raw.per_order_limit !== undefined) {
    if (raw.per_order_limit !== null && (!_isNonNegInt(raw.per_order_limit) || raw.per_order_limit > MAX_PER_ORDER)) {
      pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].per_order_limit 必須是 0~${MAX_PER_ORDER} 的整數（0 或 null 表示不限）`);
    }
    out.per_order_limit = raw.per_order_limit || 0;
  }
  if (raw.manual_sold_out !== undefined) {
    if (typeof raw.manual_sold_out !== 'boolean') pp.fail('POPUP_VALIDATION_ERROR', `items[${idx}].manual_sold_out 必須是 true/false`);
    out.manual_sold_out = raw.manual_sold_out;
  }
  return out;
}

// 交易內：對單一場次套用多個商品更新。回傳 { updated, rejected:[{product_id,reason,message}] }。
// strict=true 時任何拒絕都整批失敗（單一場次管理）；false 時略過（批次套用其他場次）。
function applySalesUpdatesInTransaction(db, storeId, session, updates, strict) {
  const candidates = new Map(candidateProducts(db, storeId, session).map((c) => [Number(c.row.product_id), c]));
  const rejected = [];
  let updated = 0;
  updates.forEach(({ product_id: productId, patch }) => {
    const cand = candidates.get(productId);
    if (!cand) { rejected.push({ product_id: productId, reason: 'not_in_session', message: '商品不在此場次可售範圍' }); return; }
    const sp = getSpRow(db, storeId, session, productId);
    const before = effectiveConfig(getSalesRow(db, storeId, session.id, productId), sp);
    const next = {
      sale_enabled: patch.sale_enabled !== undefined ? patch.sale_enabled : before.sale_enabled,
      stock_mode: patch.stock_mode !== undefined ? patch.stock_mode : before.stock_mode,
      stock_total: patch.stock_total !== undefined ? patch.stock_total : (before.stock_total || 0),
      per_order_limit: patch.per_order_limit !== undefined ? patch.per_order_limit : (before.per_order_limit || 0),
      manual_sold_out: patch.manual_sold_out !== undefined ? patch.manual_sold_out : before.manual_sold_out,
    };
    if (next.stock_mode === 'limited') {
      const u = usage(db, storeId, session.id, productId);
      const used = u.reserved + u.committed;
      if (next.stock_total < used) {
        rejected.push({ product_id: productId, reason: 'below_used', message: `總販售數量不得低於已保留＋已成立（${used}）`, used, reserved: u.reserved, committed: u.committed });
        return;
      }
    }
    db._db.run(
      `INSERT INTO popup_session_product_sales (store_id, session_id, product_id, sale_enabled, stock_mode, stock_total, per_order_limit, manual_sold_out, updated_at)
       VALUES (?,?,?,?,?,?,?,?,datetime('now','localtime'))
       ON CONFLICT(store_id, session_id, product_id) DO UPDATE SET sale_enabled=excluded.sale_enabled, stock_mode=excluded.stock_mode,
         stock_total=excluded.stock_total, per_order_limit=excluded.per_order_limit, manual_sold_out=excluded.manual_sold_out,
         updated_at=excluded.updated_at`,
      [storeId, session.id, productId, next.sale_enabled ? 1 : 0, next.stock_mode, next.stock_mode === 'limited' ? next.stock_total : 0,
        next.per_order_limit || 0, next.manual_sold_out ? 1 : 0]
    );
    // selected 場次：同步鏡射到既有 quota_qty，讓場次表單與 R52 相容路徑看到同一個數字。
    if (sp) {
      db._db.run('UPDATE popup_session_products SET quota_qty=?, updated_at=datetime(\'now\',\'localtime\') WHERE session_id=? AND store_id=? AND product_id=?',
        [next.stock_mode === 'limited' ? next.stock_total : 0, session.id, storeId, productId]);
    }
    updated += 1;
  });
  if (strict && rejected.length) {
    pp.fail('POPUP_SALES_UPDATE_REJECTED', rejected[0].message, 409, { rejected });
  }
  return { updated, rejected };
}

// 場次表單（R52 PATCH）重寫 popup_session_products 後：quota_qty 有變更的商品，
// 若已有販售設定列，同步更新其限量設定；新上限不得低於已使用量。
function syncQuotaFromSessionFormInTransaction(db, storeId, sessionId, beforeProducts, afterProducts) {
  const beforeMap = new Map((beforeProducts || []).map((p) => [Number(p.product_id), _int(p.quota_qty)]));
  (afterProducts || []).forEach((p) => {
    const pid = Number(p.product_id);
    const q = _int(p.quota_qty);
    if (beforeMap.has(pid) && beforeMap.get(pid) === q) return;
    const u = usage(db, storeId, sessionId, pid);
    if (q > 0 && q < u.reserved + u.committed) {
      pp.fail('POPUP_STOCK_BELOW_USED', `商品 id=${pid} 份數上限不得低於已保留＋已成立（${u.reserved + u.committed}）`, 409, { product_id: pid, used: u.reserved + u.committed });
    }
    const row = getSalesRow(db, storeId, sessionId, pid);
    if (row) {
      db._db.run("UPDATE popup_session_product_sales SET stock_mode=?, stock_total=?, updated_at=datetime('now','localtime') WHERE id=?",
        [q > 0 ? 'limited' : 'unlimited', q > 0 ? q : 0, row.id]);
    }
  });
}

module.exports = {
  STOCK_MODES, ensurePopupSalesSchema, ensureRaw, migrateRawAtStartup, getSalesRow, effectiveConfig, usage, productSaleState, assertCheckoutStock,
  commitReservedForOrder, candidateProducts, listSessionSales, normalizeSalesPatch, applySalesUpdatesInTransaction,
  batchTargetAllowed, sessionTimingState, syncQuotaFromSessionFormInTransaction,
};
