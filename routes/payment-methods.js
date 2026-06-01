// routes/payment-methods.js — SaaS R1 fix16k-03
// 根本修正 v3：
//   1. 所有 DB 操作統一用 db.run() / db.get() / db.all() wrapper（不直接呼叫 db._db.run/exec with params）
//   2. debug endpoint 也執行 ensurePaymentMethodsSchema + ensureDefaultPaymentMethods，seed 後再 SELECT
//   3. debug 回傳增加 seedResult / allRows / storeCounts
//   4. GET / 確保 schema + seed + SELECT 流程完整，不再有 0 筆 → 500 的死路
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
  store_id:                       "TEXT NOT NULL DEFAULT 'store_001'",
  name:                           "TEXT NOT NULL DEFAULT ''",
  code:                           "TEXT NOT NULL DEFAULT ''",
  icon:                           "TEXT DEFAULT ''",
  is_active:                      "INTEGER DEFAULT 1",
  enabled:                        "INTEGER DEFAULT 1",
  sort_order:                     "INTEGER DEFAULT 0",
  is_default:                     "INTEGER DEFAULT 0",
  enable_for_dine_in:             "INTEGER DEFAULT 1",
  enable_for_takeout:             "INTEGER DEFAULT 1",
  enable_for_delivery:            "INTEGER DEFAULT 1",
  allow_edit_when_platform_order: "INTEGER DEFAULT 1",
  gateway_code:                   "TEXT DEFAULT ''",
  created_at:                     "TEXT DEFAULT (datetime('now','localtime'))",
  updated_at:                     "TEXT DEFAULT (datetime('now','localtime'))",
};

// ── getPragmaCols ─────────────────────────────────────────
// 每次都重新 PRAGMA，無快取
// 注意：PRAGMA table_info 是靜態 SQL，exec() 不需要參數，沒問題
function getPragmaCols(db) {
  const cols = new Set();
  try {
    const rows = db._db.exec('PRAGMA table_info(payment_methods)');
    const vals = rows && rows[0] ? rows[0].values : [];
    vals.forEach(r => cols.add(String(r[1]).toLowerCase()));
    console.log('[PM] PRAGMA cols:', [...cols].join(','));
  } catch(e) {
    console.error('[PM] PRAGMA error:', e.message);
  }
  return cols;
}

// ── ensurePaymentMethodsSchema ────────────────────────────
// 補缺少的欄位 + code backfill
// 全程使用 db._db.run(staticSql) 或 db.run(sql, params) wrapper
function ensurePaymentMethodsSchema(db) {
  const cols = getPragmaCols(db);

  // ALTER TABLE ADD COLUMN（靜態 SQL，無參數，exec 也可，但用 _db.run 最安全）
  for (const [col, def] of Object.entries(REQUIRED_COLS)) {
    if (!cols.has(col.toLowerCase())) {
      try {
        db._db.run(`ALTER TABLE payment_methods ADD COLUMN ${col} ${def}`);
        db._save();
        cols.add(col.toLowerCase());
        console.log('[PM] ADD COLUMN:', col);
      } catch(e) {
        if (!e.message.includes('duplicate column')) {
          console.error('[PM] ALTER error:', col, e.message);
        }
      }
    }
  }

  // code backfill：用 db.run() wrapper（帶 params）
  if (cols.has('code') && cols.has('name')) {
    for (const [name, code] of Object.entries(NAME_TO_CODE)) {
      try {
        db.run(
          `UPDATE payment_methods SET code=? WHERE LOWER(name)=LOWER(?) AND (code IS NULL OR TRIM(code)='')`,
          [code, name]
        );
      } catch(e) {
        console.error('[PM] code backfill error:', name, e.message);
      }
    }
  }
}

// ── ensureDefaultPaymentMethods ───────────────────────────
// 回傳 { inserted, skipped } 供 debug 使用
// 全程使用 db.run() / db.get() wrapper，確保 _save() 被呼叫
function ensureDefaultPaymentMethods(storeId, db) {
  const cols = getPragmaCols(db);

  // Step 1: 清掉此店 code 為空的殘留記錄（防舊版 bug 造成的髒資料）
  if (cols.has('store_id') && cols.has('code')) {
    try {
      db.run(
        `DELETE FROM payment_methods WHERE store_id=? AND (code IS NULL OR TRIM(code)='')`,
        [storeId]
      );
    } catch(e) {
      console.error('[PM] delete empty code error:', e.message);
    }
  }

  // Step 2: 組 INSERT 欄位清單（只包含實際存在的欄位）
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

  const insertSql = `INSERT INTO payment_methods (${insertCols.join(',')}) VALUES (${insertCols.map(()=>'?').join(',')})`;
  const checkSql  = `SELECT id FROM payment_methods WHERE store_id=? AND code=? LIMIT 1`;

  console.log(`[PM] seed start: store=${storeId}`);
  console.log(`[PM] insertSql:`, insertSql);

  let inserted = 0, skipped = 0;

  for (const [name, code, icon, is_active, sort_order, is_default,
    dine, takeout, delivery, allow_edit, gateway_code] of DEFAULT_PM) {
    try {
      // 用 db.get() wrapper（prepare+bind，正確帶參數）
      const existing = db.get(checkSql, [storeId, code]);
      if (existing && existing.id) {
        skipped++;
        console.log(`[PM]   skip (exists): ${code}`);
        continue;
      }

      // 不存在 → 用 db.run() wrapper INSERT（prepare+bind + _save）
      const vals = [storeId, name, code];
      if (cols.has('icon'))                           vals.push(icon);
      if (cols.has('is_active'))                      vals.push(is_active);
      if (cols.has('enabled'))                        vals.push(is_active);  // enabled 同步 is_active
      if (cols.has('sort_order'))                     vals.push(sort_order);
      if (cols.has('is_default'))                     vals.push(is_default);
      if (cols.has('enable_for_dine_in'))             vals.push(dine);
      if (cols.has('enable_for_takeout'))             vals.push(takeout);
      if (cols.has('enable_for_delivery'))            vals.push(delivery);
      if (cols.has('allow_edit_when_platform_order')) vals.push(allow_edit);
      if (cols.has('gateway_code'))                   vals.push(gateway_code);

      db.run(insertSql, vals);
      inserted++;
      console.log(`[PM]   inserted: ${code}`);
    } catch(e) {
      console.error(`[PM] INSERT error: store=${storeId} code=${code}`, e.message);
    }
  }

  console.log(`[PM] seed done: store=${storeId} inserted=${inserted} skipped=${skipped}`);
  return { inserted, skipped };
}

// ═══════════════════════════════════════════════════════════
// ── GET /api/payment-methods/debug ─────────────────────────
// fix16k-03: 先 ensure schema + seed，再 SELECT，回傳 seedResult
// ═══════════════════════════════════════════════════════════
router.get('/debug', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    if (!storeId || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN', message:'缺少 storeId' });
    }

    // Step 1: schema 補齊
    let schemaErr = null;
    try { ensurePaymentMethodsSchema(db); }
    catch(e) { schemaErr = e.message; console.error('[PM/debug] schema error:', e.message); }

    // Step 2: seed（並取得 seedResult）
    let seedResult = { inserted:0, skipped:0, error: null };
    try {
      const r = ensureDefaultPaymentMethods(storeId, db);
      seedResult.inserted = r.inserted;
      seedResult.skipped  = r.skipped;
    } catch(e) {
      seedResult.error = e.message;
      console.error('[PM/debug] seed error:', e.message);
    }

    // Step 3: schema info
    let schema = [], indexes = [];
    try {
      const r = db._db.exec('PRAGMA table_info(payment_methods)');
      schema  = r && r[0] ? r[0].values.map(v =>
        ({cid:v[0], name:v[1], type:v[2], notnull:v[3], dflt:v[4], pk:v[5]})) : [];
    } catch(e) { schema = [{error:e.message}]; }
    try {
      indexes = db.all(`SELECT type,name,sql FROM sqlite_master WHERE tbl_name='payment_methods'`);
    } catch(e) { indexes = [{error:e.message}]; }

    // Step 4: seed 後重新 SELECT（這是關鍵：seed 之後才讀）
    let rows = [];
    try {
      rows = db.all(
        'SELECT id, store_id, name, code, is_active, enabled FROM payment_methods WHERE store_id=? ORDER BY sort_order, id',
        [storeId]
      );
    } catch(e) { rows = [{error:e.message}]; }

    // Step 5: allRows（全表，不限 store_id）
    let allRows = [];
    try {
      allRows = db.all(
        'SELECT id, store_id, name, code, is_active, enabled FROM payment_methods ORDER BY store_id, sort_order LIMIT 100'
      );
    } catch(e) { allRows = [{error:e.message}]; }

    // Step 6: storeCounts
    let storeCounts = [];
    try {
      storeCounts = db.all('SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id');
    } catch(e) { storeCounts = [{error:e.message}]; }

    res.json({
      success: true,
      storeId,
      seedResult,
      schemaErr,
      schema,
      indexes,
      rows,          // 此 storeId 的付款方式（seed 後）
      allRows,       // 全表
      storeCounts,   // 各店數量
    });
  } catch(e) {
    console.error('[PM/debug] UNHANDLED:', e.message);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ── GET /api/payment-methods ───────────────────────────────
// fix16k-03: ensure schema → ensure seed → SELECT
// ═══════════════════════════════════════════════════════════
router.get('/', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    console.log('[PM] GET / start, storeId:', storeId);
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }

    // Step 1: schema 補齊
    try { ensurePaymentMethodsSchema(db); }
    catch(e) { console.error('[PM] schema error:', e.message); }

    // Step 2: seed
    try { ensureDefaultPaymentMethods(storeId, db); }
    catch(e) { console.error('[PM] seed error:', e.message); }

    // Step 3: 查詢（seed 之後才讀）
    const { mode, active } = req.query;
    let sql    = 'SELECT * FROM payment_methods WHERE store_id=?';
    const params = [storeId];
    if (active !== undefined) { sql += ' AND is_active=?'; params.push(Number(active)); }
    if (mode === 'dine_in')   sql += ' AND enable_for_dine_in=1';
    if (mode === 'takeout')   sql += ' AND enable_for_takeout=1';
    if (mode === 'delivery')  sql += ' AND enable_for_delivery=1';
    sql += ' ORDER BY sort_order ASC, id ASC';

    let methods = [];
    try {
      methods = db.all(sql, params);
      console.log('[PM] rows found:', methods.length, 'for store:', storeId);
    } catch(e) {
      console.error('[PM] SELECT error:', e.message);
      return res.status(500).json({ success:false, message:'查詢失敗：' + e.message });
    }

    // Step 4: 仍為 0 筆 → 回傳詳細 debug，不 crash
    // fix16k-03b: db.all() 是同步函式，不是 Promise，不可用 .catch()
    if (methods.length === 0) {
      let allRows = [], storeCnts = [];
      try { allRows   = db.all('SELECT store_id, code FROM payment_methods LIMIT 100'); } catch {}
      try { storeCnts = db.all('SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id'); } catch {}
      console.error('[PM] SEED_FAILED after ensure', { storeId, storeCnts });
      return res.status(500).json({
        success: false,
        error:   'PAYMENT_METHOD_SEED_FAILED',
        message: '付款方式初始化失敗，請重新登入或聯絡系統管理員',
        debug:   { storeId, storeCnts },
      });
    }

    // Step 5: gateway 過濾（只在 active 參數存在時才過濾）
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
    console.error('[PM] UNHANDLED:', e.message, e.stack);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ── PUT /api/payment-methods/:id ───────────────────────────
// ═══════════════════════════════════════════════════════════
router.put('/:id', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;
    if (!storeId || storeId === 'default') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }
    const ex = db.get(
      'SELECT * FROM payment_methods WHERE id=? AND store_id=?',
      [req.params.id, storeId]
    );
    if (!ex) return res.status(404).json({ success:false, message:'付款方式不存在' });

    const {
      name, icon, is_active, sort_order, is_default,
      enable_for_dine_in, enable_for_takeout, enable_for_delivery,
      allow_edit_when_platform_order
    } = req.body;

    const newActive = is_active !== undefined ? Number(is_active) : ex.is_active;

    db.run(
      `UPDATE payment_methods SET
         name=?, icon=?, is_active=?, enabled=?, sort_order=?, is_default=?,
         enable_for_dine_in=?, enable_for_takeout=?, enable_for_delivery=?,
         allow_edit_when_platform_order=?,
         updated_at=datetime('now','localtime')
       WHERE id=? AND store_id=?`,
      [
        name    ?? ex.name,
        icon    ?? ex.icon,
        newActive,
        newActive, // enabled 同步 is_active
        sort_order   !== undefined ? Number(sort_order)   : ex.sort_order,
        is_default   !== undefined ? Number(is_default)   : ex.is_default,
        enable_for_dine_in             !== undefined ? Number(enable_for_dine_in)             : ex.enable_for_dine_in,
        enable_for_takeout             !== undefined ? Number(enable_for_takeout)             : ex.enable_for_takeout,
        enable_for_delivery            !== undefined ? Number(enable_for_delivery)            : ex.enable_for_delivery,
        allow_edit_when_platform_order !== undefined ? Number(allow_edit_when_platform_order) : ex.allow_edit_when_platform_order,
        req.params.id,
        storeId,
      ]
    );

    res.json({
      success: true,
      data: db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?', [req.params.id, storeId]),
    });
  } catch(e) {
    console.error('[PM] PUT error:', e.message);
    res.status(500).json({ success:false, message:e.message });
  }
});

module.exports = router;
module.exports.ensureDefaultPaymentMethods = ensureDefaultPaymentMethods;
module.exports.ensurePaymentMethodsSchema  = ensurePaymentMethodsSchema;
