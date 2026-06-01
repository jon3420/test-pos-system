// routes/payment-methods.js — SaaS R1 fix16i
// fix16i: 完整 schema 相容處理 + 不靜默吃錯誤
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 預設 6 筆付款方式 ─────────────────────────────────────
// name → code 對應（舊版遷移用）
const NAME_TO_CODE = {
  '現金': 'cash', '刷卡': 'card', 'LINE Pay': 'linepay',
  '街口支付': 'jkopay', '轉帳': 'transfer', '平台付款': 'platform',
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

// 需要確保存在的所有欄位（欄位名 → ALTER TABLE 定義）
const REQUIRED_COLS = {
  store_id:                     "TEXT NOT NULL DEFAULT 'store_001'",
  name:                         "TEXT NOT NULL DEFAULT ''",
  code:                         "TEXT NOT NULL DEFAULT ''",
  icon:                         "TEXT DEFAULT ''",
  is_active:                    "INTEGER DEFAULT 1",
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

// ── 快取 ─────────────────────────────────────────────────
let _schemaReady  = false;
let _existingCols = null;

/**
 * ensurePaymentMethodsSchema(db)
 * Step 1: 補齊缺少的欄位 (ALTER TABLE ADD COLUMN)
 * Step 2: 若 code 為空白，依 name 補 code
 * Step 3: 建立 UNIQUE INDEX (store_id, code)
 */
function ensurePaymentMethodsSchema(db) {
  if (_schemaReady) return;

  // ── 取得現有欄位 ─────────────────────────────────────
  let colRows = [];
  try {
    colRows = db._db.exec('PRAGMA table_info(payment_methods)');
  } catch(e) {
    console.error('[payment-methods] PRAGMA table_info failed:', e.message);
    return;
  }
  const existingColNames = new Set(
    (colRows[0]?.values || []).map(r => String(r[1]).toLowerCase())
  );
  _existingCols = existingColNames;

  // ── Step 1: ALTER TABLE ADD COLUMN ───────────────────
  for (const [col, def] of Object.entries(REQUIRED_COLS)) {
    if (!existingColNames.has(col.toLowerCase())) {
      try {
        db._db.run(`ALTER TABLE payment_methods ADD COLUMN ${col} ${def}`);
        db._save();
        existingColNames.add(col.toLowerCase());
        console.log(`[payment-methods] 新增欄位: ${col}`);
      } catch(e) {
        console.error(`[payment-methods] ALTER TABLE ADD COLUMN ${col} failed:`, e.message);
      }
    }
  }
  _existingCols = existingColNames;

  // ── Step 2: 補 code（依 name 對應）─────────────────
  if (existingColNames.has('code') && existingColNames.has('name')) {
    try {
      for (const [name, code] of Object.entries(NAME_TO_CODE)) {
        db._db.run(
          `UPDATE payment_methods SET code=? WHERE LOWER(name)=LOWER(?) AND (code IS NULL OR code='')`,
          [code, name]
        );
      }
      db._save();
    } catch(e) {
      console.error('[payment-methods] code backfill failed:', e.message);
    }
  }

  // ── Step 3: 清重複 + 建 UNIQUE INDEX ─────────────────
  if (existingColNames.has('store_id') && existingColNames.has('code')) {
    try {
      db._db.run(`DELETE FROM payment_methods WHERE rowid NOT IN (
        SELECT MIN(rowid) FROM payment_methods GROUP BY store_id, code
      )`);
      db._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
        ON payment_methods(store_id, code)`);
      db._save();
    } catch(e) {
      console.error('[payment-methods] UNIQUE INDEX failed:', e.message);
    }
  }

  _schemaReady = true;
}

/**
 * ensureDefaultPaymentMethods(storeId, db)
 * 補齊 6 筆預設付款方式（INSERT OR IGNORE，不覆蓋既有設定）
 * 錯誤不靜默：console.error 顯示 storeId + code + message
 */
function ensureDefaultPaymentMethods(storeId, db) {
  ensurePaymentMethodsSchema(db);

  const cols = _existingCols || new Set();
  if (!cols.has('store_id') || !cols.has('code')) {
    console.error('[payment-methods] schema not ready, cannot seed:', storeId,
      'cols:', [...cols].join(','));
    return;
  }

  // 動態 INSERT 只含實際存在的欄位
  const insertCols = ['store_id', 'name', 'code'];
  if (cols.has('icon'))                           insertCols.push('icon');
  if (cols.has('is_active'))                      insertCols.push('is_active');
  if (cols.has('sort_order'))                     insertCols.push('sort_order');
  if (cols.has('is_default'))                     insertCols.push('is_default');
  if (cols.has('enable_for_dine_in'))             insertCols.push('enable_for_dine_in');
  if (cols.has('enable_for_takeout'))             insertCols.push('enable_for_takeout');
  if (cols.has('enable_for_delivery'))            insertCols.push('enable_for_delivery');
  if (cols.has('allow_edit_when_platform_order')) insertCols.push('allow_edit_when_platform_order');
  if (cols.has('gateway_code'))                   insertCols.push('gateway_code');

  const sql = `INSERT OR IGNORE INTO payment_methods
    (${insertCols.join(',')}) VALUES (${insertCols.map(() => '?').join(',')})`;

  // fix16i: 清理此 store 的空 code 殘留（舊版遷移後可能遺留）
  try {
    db.run(`DELETE FROM payment_methods WHERE store_id=? AND (code IS NULL OR TRIM(code)='')`,
      [storeId]);
    db._save?.();
  } catch {}

  for (const [name, code, icon, is_active, sort_order, is_default,
    enable_for_dine_in, enable_for_takeout, enable_for_delivery,
    allow_edit_when_platform_order, gateway_code] of DEFAULT_PM) {
    try {
      const vals = [storeId, name, code];
      if (cols.has('icon'))                           vals.push(icon);
      if (cols.has('is_active'))                      vals.push(is_active);
      if (cols.has('sort_order'))                     vals.push(sort_order);
      if (cols.has('is_default'))                     vals.push(is_default);
      if (cols.has('enable_for_dine_in'))             vals.push(enable_for_dine_in);
      if (cols.has('enable_for_takeout'))             vals.push(enable_for_takeout);
      if (cols.has('enable_for_delivery'))            vals.push(enable_for_delivery);
      if (cols.has('allow_edit_when_platform_order')) vals.push(allow_edit_when_platform_order);
      if (cols.has('gateway_code'))                   vals.push(gateway_code);

      db.run(sql, vals);
    } catch(e) {
      // fix16i: 不靜默吃錯誤
      console.error(`[payment-methods] seed failed: store=${storeId} code=${code} err=${e.message}`);
    }
  }
  db._save?.();
}

// ── GET /api/payment-methods ────────────────────────────
router.get('/', (req, res) => {
  try {
    const db      = getDb();
    // fix16j-2: 移除 fallback，requireStore 已保證 req.storeId 有值
    const storeId = req.storeId;
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      console.error('[payment-methods] GET missing storeId:', storeId);
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }

    // fix16i: Step 1 — 確保 schema（含欄位補齊 + UNIQUE INDEX）
    ensurePaymentMethodsSchema(db);

    // fix16i: Step 2 — 補齊 6 筆預設
    ensureDefaultPaymentMethods(storeId, db);

    // fix16i: Step 3 — 查詢
    const { mode, active } = req.query;
    let sql = 'SELECT pm.* FROM payment_methods pm WHERE pm.store_id=?';
    const p = [storeId];
    if (active !== undefined) { sql += ' AND pm.is_active=?'; p.push(Number(active)); }
    if (mode === 'dine_in')  sql += ' AND pm.enable_for_dine_in=1';
    if (mode === 'takeout')  sql += ' AND pm.enable_for_takeout=1';
    if (mode === 'delivery') sql += ' AND pm.enable_for_delivery=1';
    sql += ' ORDER BY pm.sort_order ASC, pm.id ASC';

    const methods = db.all(sql, p);

    // fix16i: Step 4 — 若仍 0 筆，回傳 500 而非假裝成功
    if (methods.length === 0) {
      console.error(`[payment-methods] PAYMENT_METHOD_SEED_FAILED: store=${storeId}`);
      console.error(`[payment-methods] PAYMENT_METHOD_SEED_FAILED: store=${storeId}`);
      return res.status(500).json({
        success: false, error: 'PAYMENT_METHOD_SEED_FAILED',
        message: '付款方式初始化失敗，請重新登入或聯絡系統管理員',
      });
    }

    // gateway 過濾（只在 ?active= 查詢時）
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
      return res.json({ success: true, data: filtered });
    }

    res.json({ success: true, data: methods });
  } catch(e) {
    console.error('[payment-methods] GET / error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

// ── PUT /api/payment-methods/:id ────────────────────────
router.put('/:id', (req, res) => {
  try {
    const db      = getDb();
    // fix16j-2: 移除 fallback
    const storeId = req.storeId;
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }
    const ex = db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?',
      [req.params.id, storeId]);
    if (!ex) return res.status(404).json({ success: false, message: '付款方式不存在' });
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
    res.json({ success: true,
      data: db.get('SELECT * FROM payment_methods WHERE id=? AND store_id=?',
        [req.params.id, storeId]) });
  } catch(e) {
    console.error('[payment-methods] PUT error:', e.message);
    res.status(500).json({ success: false, message: e.message });
  }
});

module.exports = router;
module.exports.ensureDefaultPaymentMethods = ensureDefaultPaymentMethods;
module.exports.ensurePaymentMethodsSchema  = ensurePaymentMethodsSchema;
