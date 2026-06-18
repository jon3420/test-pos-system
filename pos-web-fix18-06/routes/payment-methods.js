// routes/payment-methods.js — SaaS R1 fix16k-04
// 修正：Zeabur 舊 DB 的 payment_methods.code 有全域 UNIQUE constraint
// 導致多店 SaaS 架構下無法為不同店家插入相同 code（cash/card/...）
// 解法：偵測舊 constraint → 安全重建表 → 建立正確 UNIQUE(store_id, code) index → seed
'use strict';
const express = require('express');
const router  = express.Router();
const { getDb } = require('../utils/db');

// ── 預設付款方式 ──────────────────────────────────────────
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

const NAME_TO_CODE = {
  '現金':'cash','刷卡':'card','LINE Pay':'linepay',
  '街口支付':'jkopay','轉帳':'transfer','平台付款':'platform',
};

// 正確的新表 DDL（code 不加 UNIQUE，name 不加 UNIQUE）
const NEW_TABLE_DDL = `CREATE TABLE payment_methods_new (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id    TEXT    NOT NULL DEFAULT 'store_001',
  name        TEXT    NOT NULL DEFAULT '',
  code        TEXT    NOT NULL DEFAULT '',
  icon        TEXT    DEFAULT '',
  is_active   INTEGER DEFAULT 0,
  enabled     INTEGER DEFAULT 0,
  sort_order  INTEGER DEFAULT 0,
  is_default  INTEGER DEFAULT 0,
  enable_for_dine_in             INTEGER DEFAULT 1,
  enable_for_takeout             INTEGER DEFAULT 1,
  enable_for_delivery            INTEGER DEFAULT 0,
  allow_edit_when_platform_order INTEGER DEFAULT 0,
  gateway_code TEXT   DEFAULT '',
  created_at  TEXT    DEFAULT (datetime('now','localtime')),
  updated_at  TEXT    DEFAULT (datetime('now','localtime'))
)`;

// ── getPragmaCols ─────────────────────────────────────────
function getPragmaCols(db) {
  const cols = new Set();
  try {
    const rows = db._db.exec('PRAGMA table_info(payment_methods)');
    const vals = rows && rows[0] ? rows[0].values : [];
    vals.forEach(r => cols.add(String(r[1]).toLowerCase()));
  } catch(e) { console.error('[PM] PRAGMA error:', e.message); }
  return cols;
}

// ── detectBadUniqueConstraint ─────────────────────────────
// 偵測是否有錯誤的 UNIQUE(code) 或 code TEXT UNIQUE 限制
// 回傳 { hasBadUnique: bool, reason: string }
function detectBadUniqueConstraint(db) {
  try {
    // 1. 檢查 sqlite_master 的 index sql
    const master = db.all(
      `SELECT name, sql FROM sqlite_master WHERE tbl_name='payment_methods' AND type='index'`
    );
    for (const idx of master) {
      if (!idx.sql) continue;
      const sql = idx.sql.toUpperCase().replace(/\s+/g,' ');
      // 只有 (code) 的 unique index，不是 (store_id, code)
      if (/UNIQUE.*INDEX.*\(\s*CODE\s*\)/.test(sql) ||
          /UNIQUE.*INDEX.*\(\s*`CODE`\s*\)/.test(sql)) {
        return { hasBadUnique: true, reason: `index "${idx.name}" has UNIQUE(code): ${idx.sql}` };
      }
    }

    // 2. 用 PRAGMA index_list + index_info 偵測單欄 code 的 unique index
    const indexList = db._db.exec('PRAGMA index_list(payment_methods)');
    const idxRows = indexList && indexList[0] ? indexList[0].values : [];
    for (const idxRow of idxRows) {
      const idxName   = idxRow[1];
      const isUnique  = idxRow[2] === 1;
      if (!isUnique) continue;
      const infoResult = db._db.exec(`PRAGMA index_info(${idxName})`);
      const infoRows   = infoResult && infoResult[0] ? infoResult[0].values : [];
      // 只有一欄且該欄是 code → 壞 unique
      if (infoRows.length === 1 && infoRows[0][2] === 'code') {
        return { hasBadUnique: true, reason: `index "${idxName}" is UNIQUE(code) only` };
      }
    }

    // 3. 檢查 table DDL 裡有 code ... UNIQUE 或 UNIQUE(code)
    const tableDdl = db.all(
      `SELECT sql FROM sqlite_master WHERE tbl_name='payment_methods' AND type='table'`
    );
    for (const t of tableDdl) {
      if (!t.sql) continue;
      const sql = t.sql.toUpperCase().replace(/\s+/g,' ');
      if (/CODE\s+TEXT[^,)]*UNIQUE/.test(sql) || /UNIQUE\s*\(\s*CODE\s*\)/.test(sql)) {
        return { hasBadUnique: true, reason: `table DDL has UNIQUE on code alone: ${t.sql.substring(0,120)}` };
      }
    }
  } catch(e) {
    console.error('[PM] detectBadUnique error:', e.message);
  }
  return { hasBadUnique: false, reason: '' };
}

// ── rebuildPaymentMethodsTable ────────────────────────────
// 安全重建 payment_methods 表，移除舊 UNIQUE(code) 限制
// 保留已有資料（同 store_id + code 只保留 MIN(id) 那筆）
function rebuildPaymentMethodsTable(db) {
  console.log('[PM] *** 開始重建 payment_methods 表（移除錯誤 UNIQUE(code)）***');

  try {
    // Step 1: 建立新表（code 無 UNIQUE）
    db._db.run('DROP TABLE IF EXISTS payment_methods_new');
    db._db.run(NEW_TABLE_DDL);
    console.log('[PM] rebuild: payment_methods_new 已建立');

    // Step 2: 舊表有哪些欄位？動態組 SELECT（避免欄位不存在的 error）
    const oldCols = getPragmaCols(db);
    // 新表欄位清單（固定）
    const newColNames = [
      'store_id','name','code','icon','is_active','enabled','sort_order','is_default',
      'enable_for_dine_in','enable_for_takeout','enable_for_delivery',
      'allow_edit_when_platform_order','gateway_code','created_at','updated_at'
    ];
    // 只選舊表有的欄位
    const copyColNames = newColNames.filter(c => oldCols.has(c));
    const colList = copyColNames.join(',');

    // Step 3: 複製資料，同 store_id+code 只保留最小 id
    // 先把每個 store_id+code 的最小 id 找出來，再複製那些 id 的資料
    const copySql = `
      INSERT INTO payment_methods_new (${colList})
      SELECT ${colList}
      FROM payment_methods
      WHERE id IN (
        SELECT MIN(id) FROM payment_methods GROUP BY store_id, code
      )
    `;
    db._db.run(copySql);
    db._save();
    console.log('[PM] rebuild: 資料已複製（去重）');

    // Step 4: 驗證複製筆數
    const countNew = db._db.exec('SELECT COUNT(*) FROM payment_methods_new');
    const countOld = db._db.exec('SELECT COUNT(*) FROM payment_methods');
    const nNew = countNew && countNew[0] ? countNew[0].values[0][0] : '?';
    const nOld = countOld && countOld[0] ? countOld[0].values[0][0] : '?';
    console.log(`[PM] rebuild: old=${nOld} → new=${nNew} 筆`);

    // Step 5: DROP 舊表，RENAME 新表
    db._db.run('DROP TABLE payment_methods');
    db._db.run('ALTER TABLE payment_methods_new RENAME TO payment_methods');
    db._save();
    console.log('[PM] rebuild: 表已重命名為 payment_methods');

    // Step 6: 建立正確的 UNIQUE(store_id, code) index
    db._db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
      ON payment_methods(store_id, code)
    `);
    db._save();
    console.log('[PM] rebuild: UNIQUE(store_id, code) index 已建立');

    return { success: true, oldRows: nOld, newRows: nNew };
  } catch(e) {
    console.error('[PM] rebuild FAILED:', e.message, e.stack);
    return { success: false, error: e.message };
  }
}

// ── ensurePaymentMethodsSchema ────────────────────────────
// 1. 偵測舊 UNIQUE(code) → 重建表
// 2. 補缺少欄位
// 3. code backfill
// 4. 確保正確 UNIQUE(store_id, code) index
function ensurePaymentMethodsSchema(db) {
  // Step A: 偵測並修復錯誤 unique constraint
  const detection = detectBadUniqueConstraint(db);
  if (detection.hasBadUnique) {
    console.log('[PM] schema: 偵測到錯誤 unique constraint:', detection.reason);
    const rebuildResult = rebuildPaymentMethodsTable(db);
    console.log('[PM] schema: 重建結果:', JSON.stringify(rebuildResult));
  } else {
    console.log('[PM] schema: unique constraint 正常，不需重建');
  }

  // Step B: 補缺少欄位（ALTER TABLE ADD COLUMN）
  const REQUIRED_COLS = {
    store_id:                       "TEXT NOT NULL DEFAULT 'store_001'",
    name:                           "TEXT NOT NULL DEFAULT ''",
    code:                           "TEXT NOT NULL DEFAULT ''",
    icon:                           "TEXT DEFAULT ''",
    is_active:                      "INTEGER DEFAULT 0",
    enabled:                        "INTEGER DEFAULT 0",
    sort_order:                     "INTEGER DEFAULT 0",
    is_default:                     "INTEGER DEFAULT 0",
    enable_for_dine_in:             "INTEGER DEFAULT 1",
    enable_for_takeout:             "INTEGER DEFAULT 1",
    enable_for_delivery:            "INTEGER DEFAULT 0",
    allow_edit_when_platform_order: "INTEGER DEFAULT 0",
    gateway_code:                   "TEXT DEFAULT ''",
    created_at:                     "TEXT DEFAULT (datetime('now','localtime'))",
    updated_at:                     "TEXT DEFAULT (datetime('now','localtime'))",
  };

  const cols = getPragmaCols(db);
  for (const [col, def] of Object.entries(REQUIRED_COLS)) {
    if (!cols.has(col.toLowerCase())) {
      try {
        db._db.run(`ALTER TABLE payment_methods ADD COLUMN ${col} ${def}`);
        db._save();
        cols.add(col.toLowerCase());
        console.log('[PM] schema: ADD COLUMN', col);
      } catch(e) {
        if (!e.message.toLowerCase().includes('duplicate column')) {
          console.error('[PM] schema: ALTER error:', col, e.message);
        }
      }
    }
  }

  // Step C: code backfill（用 db.run wrapper，帶 params）
  for (const [name, code] of Object.entries(NAME_TO_CODE)) {
    try {
      db.run(
        `UPDATE payment_methods SET code=? WHERE LOWER(name)=LOWER(?) AND (code IS NULL OR TRIM(code)='')`,
        [code, name]
      );
    } catch(e) { console.error('[PM] schema: code backfill error:', name, e.message); }
  }

  // Step D: 確保正確 UNIQUE(store_id, code) index（若重建後已有則 IF NOT EXISTS 跳過）
  try {
    // 先清除任何只有 (code) 的 unique index（重建後應該已沒有，但防禦性清理）
    const indexList = db._db.exec('PRAGMA index_list(payment_methods)');
    const idxRows = indexList && indexList[0] ? indexList[0].values : [];
    for (const idxRow of idxRows) {
      const idxName  = idxRow[1];
      const isUnique = idxRow[2] === 1;
      if (!isUnique) continue;
      if (idxName === 'idx_payment_methods_store_code') continue; // 正確的，保留
      const infoResult = db._db.exec(`PRAGMA index_info(${idxName})`);
      const infoRows   = infoResult && infoResult[0] ? infoResult[0].values : [];
      if (infoRows.length === 1 && infoRows[0][2] === 'code') {
        try {
          db._db.run(`DROP INDEX IF EXISTS "${idxName}"`);
          db._save();
          console.log('[PM] schema: 已移除錯誤 index:', idxName);
        } catch(e) { console.error('[PM] schema: DROP INDEX error:', idxName, e.message); }
      }
    }
    db._db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
      ON payment_methods(store_id, code)
    `);
    db._save();
  } catch(e) { console.error('[PM] schema: ensure index error:', e.message); }

  console.log('[PM] schema: ensurePaymentMethodsSchema 完成');
}

// ── ensureDefaultPaymentMethods ───────────────────────────
// 為指定 storeId 補齊 6 筆預設付款方式
// 全程用 db.run() / db.get() wrapper（同步，帶 params，會呼叫 _save）
// 回傳 { inserted, skipped }
function ensureDefaultPaymentMethods(storeId, db) {
  const cols = getPragmaCols(db);

  // 清掉此店 code 為空的殘留記錄（舊版 bug 造成的髒資料）
  try {
    db.run(
      `DELETE FROM payment_methods WHERE store_id=? AND (code IS NULL OR TRIM(code)='')`,
      [storeId]
    );
  } catch(e) { console.error('[PM] seed: delete empty code error:', e.message); }

  // 動態組 INSERT 欄位（只包含實際存在的欄位）
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

  console.log(`[PM] seed: start store=${storeId}`);

  let inserted = 0, skipped = 0;
  for (const [name, code, icon, is_active, sort_order, is_default,
    dine, takeout, delivery, allow_edit, gateway_code] of DEFAULT_PM) {
    try {
      const existing = db.get(checkSql, [storeId, code]);
      if (existing && existing.id) {
        skipped++;
        continue;
      }
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
      db.run(insertSql, vals);
      inserted++;
      console.log(`[PM] seed:   inserted ${code} for ${storeId}`);
    } catch(e) {
      console.error(`[PM] seed: INSERT error store=${storeId} code=${code}:`, e.message);
    }
  }

  console.log(`[PM] seed: done store=${storeId} inserted=${inserted} skipped=${skipped}`);
  return { inserted, skipped };
}

// ═══════════════════════════════════════════════════════════
// ── GET /api/payment-methods/debug ─────────────────────────
// fix16k-04: 完整 schema + rebuild + seed + 豐富回傳
// ═══════════════════════════════════════════════════════════
router.get('/debug', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    if (!storeId || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN', message:'缺少 storeId' });
    }

    // Step 1: 偵測 bad unique（先回報，再修）
    const detection = detectBadUniqueConstraint(db);

    // Step 2: schema 補齊 + 重建（若需要）
    let schemaErr = null;
    try { ensurePaymentMethodsSchema(db); }
    catch(e) { schemaErr = e.message; console.error('[PM/debug] schema error:', e.message); }

    // Step 3: seed
    let seedResult = { inserted:0, skipped:0, error:null };
    try {
      const r = ensureDefaultPaymentMethods(storeId, db);
      seedResult.inserted = r.inserted;
      seedResult.skipped  = r.skipped;
    } catch(e) {
      seedResult.error = e.message;
      console.error('[PM/debug] seed error:', e.message);
    }

    // Step 4: schema info（重建後才讀）
    let schema = [], indexes = [], tableSql = '';
    try {
      const r = db._db.exec('PRAGMA table_info(payment_methods)');
      schema  = r && r[0] ? r[0].values.map(v =>
        ({ cid:v[0], name:v[1], type:v[2], notnull:v[3], dflt:v[4], pk:v[5] })) : [];
    } catch(e) { schema = [{ error:e.message }]; }
    try {
      indexes = db.all(
        `SELECT name, sql FROM sqlite_master WHERE tbl_name='payment_methods' AND type='index' ORDER BY name`
      );
    } catch(e) { indexes = [{ error:e.message }]; }
    try {
      const t = db.all(
        `SELECT sql FROM sqlite_master WHERE tbl_name='payment_methods' AND type='table' LIMIT 1`
      );
      tableSql = t && t[0] ? t[0].sql : '';
    } catch {}

    // Step 5: seed 後重新 SELECT rows
    let rows = [];
    try {
      rows = db.all(
        `SELECT id, store_id, name, code, is_active, enabled
         FROM payment_methods WHERE store_id=? ORDER BY sort_order, id`,
        [storeId]
      );
    } catch(e) { rows = [{ error:e.message }]; }

    // Step 6: allRows（全表）
    let allRows = [];
    try {
      allRows = db.all(
        `SELECT id, store_id, name, code, is_active, enabled
         FROM payment_methods ORDER BY store_id, sort_order LIMIT 200`
      );
    } catch(e) { allRows = [{ error:e.message }]; }

    // Step 7: storeCounts
    let storeCounts = [];
    try {
      storeCounts = db.all(
        `SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id ORDER BY store_id`
      );
    } catch(e) { storeCounts = [{ error:e.message }]; }

    res.json({
      success:   true,
      storeId,
      detection,   // { hasBadUnique, reason } — 重建前的狀態
      schemaErr,
      seedResult,  // { inserted, skipped, error }
      schema,
      tableSql,
      indexes,     // 重建後的 index 清單
      rows,        // 此 storeId seed 後的付款方式
      allRows,     // 全表（所有店家）
      storeCounts, // 各店 count
    });
  } catch(e) {
    console.error('[PM/debug] UNHANDLED:', e.message, e.stack);
    res.status(500).json({ success:false, message:e.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ── GET /api/payment-methods ───────────────────────────────
// fix16k-04: ensure schema（含重建）→ seed → SELECT
// ═══════════════════════════════════════════════════════════
router.get('/', (req, res) => {
  try {
    const db      = getDb();
    const storeId = req.storeId;

    console.log('[PM] GET / storeId:', storeId);
    if (!storeId || storeId === 'default' || storeId.trim() === '') {
      return res.status(401).json({ success:false, error:'NO_STORE_TOKEN',
        message:'缺少店家登入 token，請重新登入' });
    }

    // Step 1: schema（含偵測 bad unique + 重建 + 補欄位 + index）
    try { ensurePaymentMethodsSchema(db); }
    catch(e) { console.error('[PM] schema error:', e.message); }

    // Step 2: seed
    try { ensureDefaultPaymentMethods(storeId, db); }
    catch(e) { console.error('[PM] seed error:', e.message); }

    // Step 3: SELECT（seed 之後才讀）
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
      console.log('[PM] rows found:', methods.length, 'for', storeId);
    } catch(e) {
      console.error('[PM] SELECT error:', e.message);
      return res.status(500).json({ success:false, message:'查詢失敗：' + e.message });
    }

    // Step 4: 仍為 0 筆（seed 應已處理，此為最後防線）
    if (methods.length === 0) {
      let storeCnts = [];
      try { storeCnts = db.all('SELECT store_id, COUNT(*) as cnt FROM payment_methods GROUP BY store_id'); } catch {}
      console.error('[PM] SEED_FAILED', { storeId, storeCnts });
      return res.status(500).json({
        success: false, error: 'PAYMENT_METHOD_SEED_FAILED',
        message: '付款方式初始化失敗，請重新登入或聯絡系統管理員',
        debug: { storeId, storeCnts },
      });
    }

    // Step 5: gateway 過濾（只在 ?active= 時才過濾）
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
        name  ?? ex.name,
        icon  ?? ex.icon,
        newActive, newActive,
        sort_order   !== undefined ? Number(sort_order)   : ex.sort_order,
        is_default   !== undefined ? Number(is_default)   : ex.is_default,
        enable_for_dine_in             !== undefined ? Number(enable_for_dine_in)             : ex.enable_for_dine_in,
        enable_for_takeout             !== undefined ? Number(enable_for_takeout)             : ex.enable_for_takeout,
        enable_for_delivery            !== undefined ? Number(enable_for_delivery)            : ex.enable_for_delivery,
        allow_edit_when_platform_order !== undefined ? Number(allow_edit_when_platform_order) : ex.allow_edit_when_platform_order,
        req.params.id, storeId,
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
module.exports.ensureDefaultPaymentMethods  = ensureDefaultPaymentMethods;
module.exports.ensurePaymentMethodsSchema   = ensurePaymentMethodsSchema;
module.exports.detectBadUniqueConstraint    = detectBadUniqueConstraint;
module.exports.rebuildPaymentMethodsTable   = rebuildPaymentMethodsTable;
