// routes/payment-methods.js — SaaS R1 fix16k-2
// fix16k-2: 無快取、每次 PRAGMA、詳細 debug log、強制補齊
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 6 筆預設付款方式 ─────────────────────────────────────
const NAME_TO_CODE = {
  '現金':'cash','刷卡':'card','LINE Pay':'linepay',
  '街口支付':'jkopay','轉帳':'transfer','平台付款':'platform',
};
const DEFAULT_PM = [
  // [name, code, icon, is_active, sort_order, is_default,
  //  enable_for_dine_in, enable_for_takeout, enable_for_delivery,
  //  allow_edit_when_platform_order, gateway_code]
  ['現金',    'cash',     '💵', 1, 1, 1, 1, 1, 1, 1, ''],
  ['刷卡',    'card',     '💳', 0, 2, 0, 1, 1, 0, 1, ''],
  ['LINE Pay','linepay',  '💚', 0, 3, 0, 1, 1, 1, 1, 'linepay'],
  ['街口支付','jkopay',   '🟠', 0, 4, 0, 1, 1, 1, 1, 'jkopay'],
  ['轉帳',    'transfer', '🏦', 0, 5, 0, 0, 1, 1, 1, ''],
  ['平台付款','platform', '📱', 0, 6, 0, 0, 0, 1, 1, ''],
];

// 需確保存在的欄位（欄位名 → SQLite 型別定義）
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

// ─────────────────────────────────────────────────────────
// getPragmaCols(db) — 每次呼叫都重新 PRAGMA，無快取
// ─────────────────────────────────────────────────────────
function getPragmaCols(db) {
  const result = new Set();
  try {
    // sql.js wrapper: _db.exec 回傳 [{columns, values}]
    const rows = db._db.exec('PRAGMA table_info(payment_methods)');
    const vals = rows && rows[0] ? rows[0].values : [];
    vals.forEach(r => result.add(String(r[1]).toLowerCase()));
    console.log('[payment-methods] PRAGMA cols:', [...result].join(','));
  } catch(e) {
    console.error('[payment-methods] PRAGMA table_info error:', e.message);
  }
  return result;
}

// ─────────────────────────────────────────────────────────
// ensurePaymentMethodsSchema(db)
// 每次呼叫都重新 PRAGMA，補齊缺少欄位 + code backfill + UNIQUE INDEX
// ─────────────────────────────────────────────────────────
function ensurePaymentMethodsSchema(db) {
  const cols = getPragmaCols(db);

  // Step 1: ALTER TABLE ADD COLUMN 補齊缺少欄位
  for (const [col, def] of Object.entries(REQUIRED_COLS)) {
    if (!cols.has(col.toLowerCase())) {
      const sql = `ALTER TABLE payment_methods ADD COLUMN ${col} ${def}`;
      try {
        db._db.run(sql);
        db._save();
        cols.add(col.toLowerCase());
        console.log(`[payment-methods] ADD COLUMN: ${col}`);
      } catch(e) {
        console.error('[payment-methods] ERROR', {
          step: 'ALTER_TABLE', col, sql, message: e.message
        });
      }
    }
  }

  // Step 2: code backfill（依 name → code 對應，舊版遷移）
  if (cols.has('code') && cols.has('name')) {
    for (const [name, code] of Object.entries(NAME_TO_CODE)) {
      const sql = `UPDATE payment_methods SET code=? WHERE LOWER(name)=LOWER(?) AND (code IS NULL OR TRIM(code)='')`;
      try {
        db._db.run(sql, [code, name]);
      } catch(e) {
        console.error('[payment-methods] ERROR', { step:'CODE_BACKFILL', name, code, message:e.message });
      }
    }
    db._save();
  }

  // Step 3: 清重複 + UNIQUE INDEX
  if (cols.has('store_id') && cols.has('code')) {
    try {
      db._db.run(`DELETE FROM payment_methods WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM payment_methods GROUP BY store_id, code
      )`);
      db._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
        ON payment_methods(store_id, code)`);
      db._save();
    } catch(e) {
      console.error('[payment-methods] ERROR', { step:'UNIQUE_INDEX', message:e.message });
    }
  }
}

// ─────────────────────────────────────────────────────────
// ensureDefaultPaymentMethods(storeId, db)
// 強制補入 6 筆，使用 INSERT OR IGNORE（需 UNIQUE INDEX）
// 每個 INSERT 失敗都 console.error
// ─────────────────────────────────────────────────────────
function ensureDefaultPaymentMethods(storeId, db) {
  // 每次重新取欄位（無快取）
  const cols = getPragmaCols(db);

  // 先清掉 code 為空的舊殘留
  if (cols.has('store_id') && cols.has('code')) {
    try {
      db._db.run(
        `DELETE FROM payment_methods WHERE store_id=? AND (code IS NULL OR TRIM(code)='')`,
        [storeId]
      );
      db._save();
    } catch(e) {
      console.error('[payment-methods] ERROR', { step:'DELETE_EMPTY_CODE', storeId, message:e.message });
    }
  }

  // 動態建立 INSERT 欄位清單
  const insertCols = ['store_id','name','code'];
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

  const sql = `INSERT OR IGNORE INTO payment_methods (${insertCols.join(',')}) VALUES (${insertCols.map(()=>'?').join(',')})`;
  console.log('[payment-methods] INSERT sql:', sql);

  for (const [name,code,icon,is_active,sort_order,is_default,
    enable_for_dine_in,enable_for_takeout,enable_for_delivery,
    allow_edit_when_platform_order,gateway_code] of DEFAULT_PM) {
    const vals = [storeId, name, code];
    if (cols.has('icon'))                           vals.push(icon);
    if (cols.has('is_active'))                      vals.push(is_active);
    if (cols.has('enabled'))                        vals.push(is_active); // enabled 同 is_active
    if (cols.has('sort_order'))                     vals.push(sort_order);
    if (cols.has('is_default'))                     vals.push(is_default);
    if (cols.has('enable_for_dine_in'))             vals.push(enable_for_dine_in);
    if (cols.has('enable_for_takeout'))             vals.push(enable_for_takeout);
    if (cols.has('enable_for_delivery'))            vals.push(enable_for_delivery);
    if (cols.has('allow_edit_when_platform_order')) vals.push(allow_edit_when_platform_order);
    if (cols.has('gateway_code'))                   vals.push(gateway_code);

    try {
      db._db.run(sql, vals);
    } catch(e) {
      console.error('[payment-methods] ERROR', {
        step:'INSERT', storeId, code, sql,
        params: vals, message: e.message, stack: e.stack
      });
    }
  }
  try { db._save(); } catch {}
}

// ─────────────────────────────────────────────────────────
// ★ DEBUG: GET /api/payment-methods/debug
// 必須在 /:id 路由前面
// ─────────────────────────────────────────────────────────
router.get('/debug', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    // Schema
    let schema = [];
    try {
      const rows = db._db.exec('PRAGMA table_info(payment_methods)');
      schema = rows && rows[0] ? rows[0].values.map(r => ({
        cid:r[0], name:r[1], type:r[2], notnull:r[3], dflt_value:r[4], pk:r[5]
      })) : [];
    } catch(e) { schema = [{ error: e.message }]; }

    // Indexes
    let indexes = [];
    try {
      indexes = db.all(
        `SELECT type,name,sql FROM sqlite_master WHERE tbl_name='payment_methods' ORDER BY type,name`
      );
    } catch(e) { indexes = [{ error: e.message }]; }

    // Rows
    let rows = [];
    try {
      rows = storeId
        ? db.all('SELECT * FROM payment_methods WHERE store_id=? LIMIT 20', [storeId])
        : db.all('SELECT * FROM payment_methods LIMIT 20');
    } catch(e) { rows = [{ error: e.message }]; }

    // All stores count
    let storeCounts = [];
    try {
      storeCounts = db.all('SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id');
    } catch {}

    res.json({ success:true, storeId, schema, indexes, rows, storeCounts });
  } catch(e) {
    res.status(500).json({ success:false, message:e.message, stack:e.stack });
  }
});

// ─────────────────────────────────────────────────────────
// GET /api/payment-methods
// ─────────────────────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const db = getDb();

    // Step 1: storeId
    const storeId = req.storeId;
    console.log('[payment-methods] start GET, storeId:', storeId);
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      console.error('[payment-methods] ERROR', { step:'STOREID_MISSING', storeId });
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }

    // Step 2: schema 修正（無快取，每次 PRAGMA）
    try {
      ensurePaymentMethodsSchema(db);
    } catch(e) {
      console.error('[payment-methods] ERROR', { step:'ENSURE_SCHEMA', storeId, message:e.message, stack:e.stack });
      // 繼續執行，不中斷
    }

    // Step 3: seed 預設付款方式
    try {
      ensureDefaultPaymentMethods(storeId, db);
    } catch(e) {
      console.error('[payment-methods] ERROR', { step:'ENSURE_DEFAULTS', storeId, message:e.message, stack:e.stack });
      // 繼續執行
    }

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
      console.error('[payment-methods] ERROR', { step:'SELECT', storeId, sql, message:e.message, stack:e.stack });
      return res.status(500).json({ success:false, message:'查詢付款方式失敗：' + e.message });
    }

    // Step 5: 若仍 0 筆 → 500 + debug
    if (methods.length === 0) {
      // 印出完整 debug
      let debugInfo = {};
      try {
        const cols = db._db.exec('PRAGMA table_info(payment_methods)');
        const allRows = db.all('SELECT store_id,code FROM payment_methods LIMIT 50');
        debugInfo = { cols: cols[0]?.values?.map(r=>r[1]), allRows };
      } catch {}
      console.error('[payment-methods] PAYMENT_METHOD_SEED_FAILED', {
        storeId, ...debugInfo
      });
      return res.status(500).json({
        success: false,
        error:   'PAYMENT_METHOD_SEED_FAILED',
        message: '付款方式初始化失敗，請重新登入或聯絡系統管理員',
        debug:   { storeId, ...debugInfo },
      });
    }

    // gateway 過濾（只在 ?active= 時）
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
    console.error('[payment-methods] UNHANDLED ERROR:', e.message, e.stack);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ─────────────────────────────────────────────────────────
// PUT /api/payment-methods/:id
// ─────────────────────────────────────────────────────────
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
      [name ?? ex.name, icon ?? ex.icon,
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
    console.error('[payment-methods] PUT ERROR:', e.message);
    res.status(500).json({ success:false, message:e.message });
  }
});

module.exports = router;
module.exports.ensureDefaultPaymentMethods = ensureDefaultPaymentMethods;
module.exports.ensurePaymentMethodsSchema  = ensurePaymentMethodsSchema;
