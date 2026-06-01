// routes/payment-methods.js — SaaS R1 fix16k-2-final
// 根本修正：INSERT OR IGNORE 失效原因 = UNIQUE INDEX 不存在
// 改用 SELECT + INSERT 的 upsert 邏輯，完全不依賴 UNIQUE INDEX
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

const NAME_TO_CODE = {
  '現金':'cash','刷卡':'card','LINE Pay':'linepay',
  '街口支付':'jkopay','轉帳':'transfer','平台付款':'platform',
};

const DEFAULT_PM = [
  // [name, code, icon, is_active, sort_order, is_default,
  //  dine_in, takeout, delivery, allow_edit, gateway_code]
  ['現金',    'cash',     '💵', 1, 1, 1, 1, 1, 1, 1, ''],
  ['刷卡',    'card',     '💳', 0, 2, 0, 1, 1, 0, 1, ''],
  ['LINE Pay','linepay',  '💚', 0, 3, 0, 1, 1, 1, 1, 'linepay'],
  ['街口支付','jkopay',   '🟠', 0, 4, 0, 1, 1, 1, 1, 'jkopay'],
  ['轉帳',    'transfer', '🏦', 0, 5, 0, 0, 1, 1, 1, ''],
  ['平台付款','platform', '📱', 0, 6, 0, 0, 0, 1, 1, ''],
];

const REQUIRED_COLS = {
  store_id:                     "TEXT NOT NULL DEFAULT 'store_001'",
  name:                         "TEXT NOT NULL DEFAULT ''",
  code:                         "TEXT NOT NULL DEFAULT ''",
  icon:                         "TEXT DEFAULT ''",
  is_active:                    "INTEGER DEFAULT 1",
  enabled:                      "INTEGER DEFAULT 1",
  sort_order:                   "INTEGER DEFAULT 0",
  is_default:                   "INTEGER DEFAULT 0",
  enable_for_dine_in:           "INTEGER DEFAULT 1",
  enable_for_takeout:           "INTEGER DEFAULT 1",
  enable_for_delivery:          "INTEGER DEFAULT 1",
  allow_edit_when_platform_order: "INTEGER DEFAULT 1",
  gateway_code:                 "TEXT DEFAULT ''",
  created_at:                   "TEXT DEFAULT (datetime('now','localtime'))",
  updated_at:                   "TEXT DEFAULT (datetime('now','localtime'))",
};

// ── getPragmaCols — 每次都重新 PRAGMA，無快取 ─────────────
function getPragmaCols(db) {
  const cols = new Set();
  try {
    const rows = db._db.exec('PRAGMA table_info(payment_methods)');
    const vals = rows && rows[0] ? rows[0].values : [];
    vals.forEach(r => cols.add(String(r[1]).toLowerCase()));
    console.log('[payment-methods] PRAGMA cols:', [...cols].join(','));
  } catch(e) {
    console.error('[payment-methods] PRAGMA error:', e.message);
  }
  return cols;
}

// ── ensurePaymentMethodsSchema — 補欄位 + code backfill ──
function ensurePaymentMethodsSchema(db) {
  const cols = getPragmaCols(db);

  // ALTER TABLE ADD COLUMN
  for (const [col, def] of Object.entries(REQUIRED_COLS)) {
    if (!cols.has(col.toLowerCase())) {
      const sql = `ALTER TABLE payment_methods ADD COLUMN ${col} ${def}`;
      try {
        db._db.run(sql);
        db._save();
        cols.add(col.toLowerCase());
        console.log('[payment-methods] ADD COLUMN:', col);
      } catch(e) {
        console.error('[payment-methods] ALTER error:', { col, message: e.message });
      }
    }
  }

  // code backfill by name
  if (cols.has('code') && cols.has('name')) {
    for (const [name, code] of Object.entries(NAME_TO_CODE)) {
      try {
        db._db.run(
          `UPDATE payment_methods SET code=? WHERE LOWER(name)=LOWER(?) AND (code IS NULL OR TRIM(code)='')`,
          [code, name]
        );
      } catch(e) {
        console.error('[payment-methods] code backfill error:', { name, code, message: e.message });
      }
    }
    try { db._save(); } catch {}
  }
}

// ── ensureDefaultPaymentMethods — 核心修正 ───────────────
// 根本問題：INSERT OR IGNORE 在沒有 UNIQUE INDEX 時不去重，
// 結果是 INSERT 成功但因為沒有 UNIQUE INDEX 保護，
// 若 Zeabur DB 有舊版重複資料，UNIQUE INDEX 建立失敗，
// 後續 INSERT OR IGNORE 也失效 → 0 筆。
//
// 修正策略：改用 SELECT → 不存在才 INSERT（不依賴 UNIQUE INDEX）
function ensureDefaultPaymentMethods(storeId, db) {
  const cols = getPragmaCols(db);

  // 清掉 code 為空的殘留
  if (cols.has('store_id') && cols.has('code')) {
    try {
      db._db.run(
        `DELETE FROM payment_methods WHERE store_id=? AND (code IS NULL OR TRIM(code)='')`,
        [storeId]
      );
      db._save();
    } catch(e) {
      console.error('[payment-methods] delete empty code error:', e.message);
    }
  }

  // 動態欄位清單
  const insertCols = ['store_id', 'name', 'code'];
  if (cols.has('icon'))                           insertCols.push('icon');
  if (cols.has('is_active'))                      insertCols.push('is_active');
  if (cols.has('enabled'))                        insertCols.push('enabled');
  if (cols.has('sort_order'))                     insertCols.push('sort_order');
  if (cols.has('is_default'))                     insertCols.push('is_default');
  if (cols.has('enable_for_dine_in'))             insertCols.push('enable_for_dine_in');
  if (cols.has('enable_for_takeout'))             insertCols.push('enable_for_takeout');
  if (cols.has('enable_for_delivery'))            insertCols.push('enable_for_delivery');
  if (cols.has('allow_edit_when_platform_order')) insertCols.push('allow_edit_when_platform_order');
  if (cols.has('gateway_code'))                   insertCols.push('gateway_code');

  // fix16k-2-final: SELECT 先確認是否存在，不存在才 INSERT
  // 完全不依賴 UNIQUE INDEX，不使用 INSERT OR IGNORE
  const insertSql = `INSERT INTO payment_methods (${insertCols.join(',')}) VALUES (${insertCols.map(()=>'?').join(',')})`;
  const checkSql  = `SELECT id FROM payment_methods WHERE store_id=? AND code=? LIMIT 1`;
  console.log('[payment-methods] seed strategy: SELECT-then-INSERT (no UNIQUE INDEX dependency)');
  console.log('[payment-methods] INSERT sql:', insertSql);

  let inserted = 0, skipped = 0;
  for (const [name, code, icon, is_active, sort_order, is_default,
    dine, takeout, delivery, allow_edit, gateway_code] of DEFAULT_PM) {
    try {
      // 先查：已存在就跳過
      const existing = db._db.exec(checkSql, [storeId, code]);
      const exists   = existing && existing[0] && existing[0].values && existing[0].values.length > 0;
      if (exists) {
        skipped++;
        continue;
      }

      // 不存在 → INSERT
      const vals = [storeId, name, code];
      if (cols.has('icon'))                           vals.push(icon);
      if (cols.has('is_active'))                      vals.push(is_active);
      if (cols.has('enabled'))                        vals.push(is_active);
      if (cols.has('sort_order'))                     vals.push(sort_order);
      if (cols.has('is_default'))                     vals.push(is_default);
      if (cols.has('enable_for_dine_in'))             vals.push(dine);
      if (cols.has('enable_for_takeout'))             vals.push(takeout);
      if (cols.has('enable_for_delivery'))            vals.push(delivery);
      if (cols.has('allow_edit_when_platform_order')) vals.push(allow_edit);
      if (cols.has('gateway_code'))                   vals.push(gateway_code);

      db._db.run(insertSql, vals);
      inserted++;
    } catch(e) {
      console.error('[payment-methods] ERROR', {
        step: 'INSERT', storeId, code, sql: insertSql,
        message: e.message, stack: e.stack,
      });
    }
  }

  try { db._save(); } catch {}
  console.log(`[payment-methods] seed done: store=${storeId} inserted=${inserted} skipped=${skipped}`);
}

// ── DEBUG: GET /api/payment-methods/debug ────────────────
// 固定路徑，必須在 /:id 之前
router.get('/debug', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    let schema = [], indexes = [], rows = [], storeCounts = [];
    try {
      const r = db._db.exec('PRAGMA table_info(payment_methods)');
      schema  = r && r[0] ? r[0].values.map(v =>
        ({cid:v[0],name:v[1],type:v[2],notnull:v[3],dflt:v[4],pk:v[5]})) : [];
    } catch(e) { schema = [{error:e.message}]; }
    try {
      indexes = db.all(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name='payment_methods'`);
    } catch(e) { indexes = [{error:e.message}]; }
    try {
      rows = storeId
        ? db.all('SELECT * FROM payment_methods WHERE store_id=? LIMIT 20', [storeId])
        : db.all('SELECT * FROM payment_methods LIMIT 20');
    } catch(e) { rows = [{error:e.message}]; }
    try {
      storeCounts = db.all('SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id');
    } catch {}
    res.json({ success:true, storeId, schema, indexes, rows, storeCounts });
  } catch(e) {
    res.status(500).json({ success:false, message:e.message });
  }
});

// ── GET /api/payment-methods ─────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // Step 1: storeId
    const storeId = req.storeId;
    console.log('[payment-methods] start GET, storeId:', storeId);
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }

    // Step 2: schema 補齊
    try { ensurePaymentMethodsSchema(db); }
    catch(e) { console.error('[payment-methods] schema error:', e.message); }

    // Step 3: seed（SELECT-then-INSERT，不依賴 UNIQUE INDEX）
    try { ensureDefaultPaymentMethods(storeId, db); }
    catch(e) { console.error('[payment-methods] seed error:', e.message, e.stack); }

    // Step 4: 查詢
    const { mode, active } = req.query;
    let sql = 'SELECT pm.* FROM payment_methods pm WHERE pm.store_id=?';
    const params = [storeId];
    if (active !== undefined) { sql += ' AND pm.is_active=?'; params.push(Number(active)); }
    if (mode === 'dine_in')  sql += ' AND pm.enable_for_dine_in=1';
    if (mode === 'takeout')  sql += ' AND pm.enable_for_takeout=1';
    if (mode === 'delivery') sql += ' AND pm.enable_for_delivery=1';
    sql += ' ORDER BY pm.sort_order ASC, pm.id ASC';

    let methods = [];
    try {
      methods = db.all(sql, params);
      console.log('[payment-methods] rows found:', methods.length, 'for', storeId);
    } catch(e) {
      console.error('[payment-methods] SELECT error:', e.message);
      return res.status(500).json({ success:false, message:'查詢失敗：' + e.message });
    }

    // Step 5: 0 筆 → 500 + debug
    if (methods.length === 0) {
      let debugInfo = {};
      try {
        const allRows = db.all('SELECT store_id, code FROM payment_methods LIMIT 50');
        const cols    = db._db.exec('PRAGMA table_info(payment_methods)');
        debugInfo = {
          allRows,
          colNames: cols && cols[0] ? cols[0].values.map(v=>v[1]) : []
        };
      } catch {}
      console.error('[payment-methods] PAYMENT_METHOD_SEED_FAILED', { storeId, ...debugInfo });
      return res.status(500).json({
        success:false, error:'PAYMENT_METHOD_SEED_FAILED',
        message:'付款方式初始化失敗，請重新登入或聯絡系統管理員',
        debug:{ storeId, ...debugInfo },
      });
    }

    // gateway 過濾
    if (active !== undefined) {
      const filtered = methods.filter(m => {
        if (!m.gateway_code) return true;
        try {
          const gw = db.get(
            'SELECT is_active FROM payment_gateways WHERE store_id=? AND code=?',
            [storeId, m.gateway_code]
          );
          return gw && gw.is_active;
        } catch { return true; }
      });
      return res.json({ success:true, data:filtered });
    }

    res.json({ success:true, data:methods });
  } catch(e) {
    console.error('[payment-methods] UNHANDLED:', e.message, e.stack);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ── PUT /api/payment-methods/:id ─────────────────────────
router.put('/:id', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    if (!storeId || storeId === 'default') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }
    const ex = db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?',
      [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success:false, message:'付款方式不存在' });
    const {
      name, icon, is_active, sort_order, is_default,
      enable_for_dine_in, enable_for_takeout, enable_for_delivery,
      allow_edit_when_platform_order
    } = req.body;
    db.run(
      `UPDATE payment_methods SET name=?,icon=?,is_active=?,sort_order=?,is_default=?,
       enable_for_dine_in=?,enable_for_takeout=?,enable_for_delivery=?,
       allow_edit_when_platform_order=?,updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [name??ex.name, icon??ex.icon,
       is_active    !== undefined ? Number(is_active)    : ex.is_active,
       sort_order   !== undefined ? Number(sort_order)   : ex.sort_order,
       is_default   !== undefined ? Number(is_default)   : ex.is_default,
       enable_for_dine_in             !== undefined ? Number(enable_for_dine_in)             : ex.enable_for_dine_in,
       enable_for_takeout             !== undefined ? Number(enable_for_takeout)             : ex.enable_for_takeout,
       enable_for_delivery            !== undefined ? Number(enable_for_delivery)            : ex.enable_for_delivery,
       allow_edit_when_platform_order !== undefined ? Number(allow_edit_when_platform_order) : ex.allow_edit_when_platform_order,
       req.params.id, storeId]
    );
    res.json({ success:true,
      data: db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?',
        [req.params.id, storeId]) });
  } catch(e) {
    console.error('[payment-methods] PUT error:', e.message);
    res.status(500).json({ success:false, message:e.message });
  }
});

module.exports = router;
module.exports.ensureDefaultPaymentMethods = ensureDefaultPaymentMethods;
module.exports.ensurePaymentMethodsSchema  = ensurePaymentMethodsSchema;
