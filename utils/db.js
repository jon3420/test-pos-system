// utils/db.js - SQLite (純 JS 版本，使用 sql.js) — v18 SaaS Foundation R1
const initSqlJs = require('sql.js');
const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, '../data/pos.db');
const dataDir = path.join(__dirname, '../data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

let wrappedDb = null;

function wrap(sqlDb) {
  const save = () => {
    try {
      fs.writeFileSync(DB_PATH, Buffer.from(sqlDb.export()));
    } catch(e) { console.error('DB save error:', e.message); }
  };

  return {
    _db: sqlDb, _save: save,

    exec(sql) { sqlDb.run(sql); save(); },

    get(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const result = stmt.step() ? stmt.getAsObject() : undefined;
      stmt.free();
      return result;
    },

    all(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.bind(params);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    },

    run(sql, params = []) {
      const stmt = sqlDb.prepare(sql);
      stmt.run(Array.isArray(params) ? params : [params]);
      const changes = sqlDb.getRowsModified ? sqlDb.getRowsModified() : 0;
      stmt.free();
      const r = sqlDb.exec('SELECT last_insert_rowid() as id');
      save();
      return { lastInsertRowid: r[0]?.values[0][0] ?? null, changes };
    },

    prepare(sql) {
      const self = this;
      return {
        run: (...args) => self.run(sql, args.flat()),
        get: (...args) => self.get(sql, args.flat()),
        all: (...args) => self.all(sql, args.flat()),
      };
    },

    pragma() {},

    transaction(fn) {
      return (arg) => {
        sqlDb.run('BEGIN');
        try { fn(arg); sqlDb.run('COMMIT'); save(); }
        catch(e) { sqlDb.run('ROLLBACK'); throw e; }
      };
    }
  };
}

function getDb() {
  if (!wrappedDb) throw new Error('DB not initialized. Call initDb() first.');
  return wrappedDb;
}

async function initDb() {
  if (wrappedDb) return wrappedDb;
  const SQL = await initSqlJs();
  const sqlDb = fs.existsSync(DB_PATH)
    ? new SQL.Database(fs.readFileSync(DB_PATH))
    : new SQL.Database();

  wrappedDb = wrap(sqlDb);
  initTables(wrappedDb);
  return wrappedDb;
}

function initTables(w) {
  // ── stores（SaaS 多店管理主表）────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL UNIQUE,
    store_name TEXT NOT NULL,
    contact_name TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    plan TEXT NOT NULL DEFAULT 'basic',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── super_admins（總控台管理員）────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS super_admins (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // 初始化預設 super admin（密碼: admin1234，上線前請改）
  const saCount = w.get('SELECT COUNT(*) as c FROM super_admins');
  if (!saCount || Number(saCount.c) === 0) {
    // 簡單 hash（sha256 hex of 'admin1234'）
    const crypto = require('crypto');
    const hash = crypto.createHash('sha256').update('admin1234').digest('hex');
    w._db.run('INSERT INTO super_admins (username, password_hash) VALUES (?,?)',
      ['superadmin', hash]);
    w._save();
    console.log('[DB] Super admin 初始帳號已建立: superadmin / admin1234');
  }

  // ── 確保 store_001 脆豬腰 store 存在 ─────────────────
  const storeCount = w.get('SELECT COUNT(*) as c FROM stores');
  if (!storeCount || Number(storeCount.c) === 0) {
    w._db.run(
      `INSERT INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`,
      ['store_001', '脆豬腰', '店長', 'pro', 1]
    );
    w._save();
    console.log('[DB] 脆豬腰 (store_001) 已建立為第一家店');
  }

  // ── products ──────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '主食',
    price REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    image TEXT DEFAULT '',
    category_id INTEGER DEFAULT 0,
    inventory_enabled INTEGER DEFAULT 0,
    total_stock_grams REAL DEFAULT 0,
    allocated_grams REAL DEFAULT 0,
    current_stock_grams REAL DEFAULT 0,
    low_stock_alert INTEGER DEFAULT 5,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const prodMig = [
    'ALTER TABLE products ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\'',
    'ALTER TABLE products ADD COLUMN image TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN category_id INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN inventory_enabled INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN total_stock_grams REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN allocated_grams REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN current_stock_grams REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN low_stock_alert INTEGER DEFAULT 5',
    'ALTER TABLE products ADD COLUMN dine_in_price REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN takeaway_price REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN delivery_price REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN show_on_line INTEGER DEFAULT 1',
    'ALTER TABLE products ADD COLUMN line_name TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN line_price REAL DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_description TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN line_image_url TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN line_category TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN line_hot INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_promo INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_sold_out INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN sale_status TEXT DEFAULT \'available\'',
    'ALTER TABLE products ADD COLUMN sold_out_until TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN auto_restore_next_day INTEGER DEFAULT 1',
    'ALTER TABLE products ADD COLUMN line_category_id INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN product_barcode TEXT DEFAULT ""',
    // LINE 接單與可售管理中心 v1
    'ALTER TABLE products ADD COLUMN line_quota_enabled INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_quota_daily INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_quota_sold INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN line_quota_low_threshold INTEGER DEFAULT 2',
    'ALTER TABLE products ADD COLUMN line_quota_high_threshold INTEGER DEFAULT 10',
    'ALTER TABLE products ADD COLUMN line_sell_start TEXT DEFAULT ""',
    'ALTER TABLE products ADD COLUMN line_sell_end TEXT DEFAULT ""',
  ];
  // ── orders migration 獨立執行，不混入 prodMig
  // 原因：sql.js 若某條 run() 失敗後 db 進入 error state，
  //       後續同 loop 的 run() 可能靜默略過，
  //       導致 line_preorder_* 從未寫入。
  try { w._db.run('ALTER TABLE orders ADD COLUMN linepay_transaction_id TEXT DEFAULT ""'); w._save(); } catch {}
  prodMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ── line_preorder_* 欄位：PRAGMA 確認後逐欄位執行，確保 Zeabur 舊 DB 也能補建
  // 每次啟動都執行此區塊，缺欄位就立即 ALTER TABLE
  const _preorderColDefs = [
    ['line_preorder_enabled',        'INTEGER DEFAULT 0'],
    ['line_preorder_daily',          'INTEGER DEFAULT 0'],
    ['line_preorder_sold',           'INTEGER DEFAULT 0'],
    ['line_preorder_low_threshold',  'INTEGER DEFAULT 2'],
    ['line_preorder_high_threshold', 'INTEGER DEFAULT 10'],
  ];
  try {
    const _existCols = w._db.all('PRAGMA table_info(products)').map(r => r.name);
    let _added = 0;
    for (const [col, def] of _preorderColDefs) {
      if (!_existCols.includes(col)) {
        try {
          w._db.run(`ALTER TABLE products ADD COLUMN ${col} ${def}`);
          w._save();
          _added++;
          console.log(`[DB] ✅ 補建欄位: ${col}`);
        } catch (e2) {
          console.error(`[DB] ❌ 補建失敗 ${col}:`, e2.message);
        }
      }
    }
    if (_added === 0) {
      console.log('[DB] ✅ line_preorder_* 欄位均已存在');
    }
  } catch (e) {
    console.error('[DB] ❌ PRAGMA table_info(products) 失敗:', e.message);
  }

  // Migration: 補上所有現有商品的 store_id
  try {
    w._db.run(`UPDATE products SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`);
    w._save();
  } catch {}

  try {
    w._db.run(`UPDATE products SET
      dine_in_price  = CASE WHEN dine_in_price  = 0 THEN price ELSE dine_in_price  END,
      takeaway_price = CASE WHEN takeaway_price  = 0 THEN price ELSE takeaway_price  END,
      delivery_price = CASE WHEN delivery_price  = 0 THEN price ELSE delivery_price  END
      WHERE price > 0`);
    w._save();
  } catch {}

  // ── categories ────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL,
    icon TEXT DEFAULT '📌',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const catMig = [
    'ALTER TABLE categories ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\'',
  ];
  catMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });
  // Migration: 補上所有現有分類的 store_id
  try {
    w._db.run(`UPDATE categories SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`);
    w._save();
  } catch {}

  // fix18-10-hotfix7：偵測 categories 是否有 UNIQUE(name)（舊版遺留），若有則重建表格
  // 舊版 categories 可能帶有 UNIQUE(name) 導致跨店匯入衝突
  // 修正：重建為 UNIQUE(store_id, name)
  try {
    const catSql = (w._db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='categories'")[0]?.values?.[0]?.[0]) || '';
    const hasNameUnique = /name\s+TEXT[^,)]*UNIQUE/i.test(catSql) ||
      (w._db.exec("SELECT name,origin FROM pragma_index_list('categories') WHERE origin='u'")[0]?.values||[])
        .some(([idxName]) => {
          const cols = w._db.exec(`SELECT name FROM pragma_index_info('${idxName}')`)[0]?.values||[];
          return cols.length === 1 && cols[0][0] === 'name';
        });
    if (hasNameUnique) {
      console.log('[DB] fix18-10-hotfix7: categories 偵測到 UNIQUE(name)，重建為 UNIQUE(store_id, name)');
      w._db.run('BEGIN');
      try {
        w._db.run(`CREATE TABLE categories_h7_tmp (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          store_id TEXT NOT NULL DEFAULT 'store_001',
          name TEXT NOT NULL,
          icon TEXT DEFAULT '📌',
          sort_order INTEGER DEFAULT 0,
          is_active INTEGER DEFAULT 1,
          created_at TEXT DEFAULT (datetime('now','localtime')),
          updated_at TEXT DEFAULT (datetime('now','localtime')),
          UNIQUE(store_id, name)
        )`);
        w._db.run(`INSERT INTO categories_h7_tmp (id,store_id,name,icon,sort_order,is_active,created_at,updated_at)
          SELECT id,store_id,name,icon,sort_order,is_active,created_at,updated_at FROM categories`);
        w._db.run(`DROP TABLE categories`);
        w._db.run(`ALTER TABLE categories_h7_tmp RENAME TO categories`);
        w._db.run('COMMIT');
        w._save();
        console.log('[DB] fix18-10-hotfix7: categories 重建完成');
      } catch(e2) {
        try { w._db.run('ROLLBACK'); } catch {}
        console.error('[DB] fix18-10-hotfix7: categories 重建失敗:', e2.message);
      }
    } else {
      // 確保 UNIQUE(store_id, name) index 存在（新裝或已是新版 schema）
      try {
        w._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_store_name ON categories(store_id, name)`);
        w._save();
      } catch {}
    }
  } catch(e) {
    console.error('[DB] fix18-10-hotfix7: categories schema 檢查失敗:', e.message);
    // fallback：強制建立 UNIQUE INDEX（若表格結構允許）
    try { w._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_categories_store_name ON categories(store_id, name)`); w._save(); } catch {}
  }

  // ── inventory_logs ────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS inventory_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    product_id INTEGER, product_name TEXT,
    action TEXT, before_grams REAL DEFAULT 0,
    change_grams REAL DEFAULT 0, after_grams REAL DEFAULT 0,
    before_units INTEGER DEFAULT 0, after_units INTEGER DEFAULT 0,
    reason TEXT DEFAULT '', operator TEXT DEFAULT 'staff',
    order_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE inventory_logs ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE inventory_logs SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

  // ── ingredients（食材主表）────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS ingredients (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id           TEXT NOT NULL DEFAULT 'store_001',
    name               TEXT NOT NULL,
    unit               TEXT NOT NULL DEFAULT 'g',
    total_stock        REAL DEFAULT 0,
    frozen_stock       REAL DEFAULT 0,
    thawing_stock      REAL DEFAULT 0,
    refrigerated_stock REAL DEFAULT 0,
    scrapped_total     REAL DEFAULT 0,
    ingredient_barcode TEXT DEFAULT '',
    notes              TEXT DEFAULT '',
    created_at         TEXT DEFAULT (datetime('now','localtime')),
    updated_at         TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE ingredients ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE ingredients SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

  // ── ingredient_batches（批號管理）────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS ingredient_batches (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_id INTEGER NOT NULL,
    batch_no      TEXT NOT NULL,
    batch_barcode TEXT DEFAULT '',
    purchase_date TEXT DEFAULT '',
    quantity      REAL DEFAULT 0,
    unit          TEXT DEFAULT 'g',
    notes         TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── ingredient_logs（食材異動紀錄）───────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS ingredient_logs (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_id       INTEGER NOT NULL,
    ingredient_name     TEXT NOT NULL,
    batch_no            TEXT DEFAULT '',
    log_type            TEXT NOT NULL,
    before_frozen       REAL DEFAULT 0,
    before_thawing      REAL DEFAULT 0,
    before_refrigerated REAL DEFAULT 0,
    change_amount       REAL DEFAULT 0,
    after_frozen        REAL DEFAULT 0,
    after_thawing       REAL DEFAULT 0,
    after_refrigerated  REAL DEFAULT 0,
    reason              TEXT DEFAULT '',
    operator            TEXT DEFAULT 'staff',
    related_order_id    TEXT DEFAULT '',
    thaw_complete_time  TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── product_ingredient_formulas（商品扣料公式）───────
  w._db.run(`CREATE TABLE IF NOT EXISTS product_ingredient_formulas (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id       INTEGER NOT NULL,
    product_barcode  TEXT DEFAULT '',
    ingredient_id    INTEGER NOT NULL,
    amount_per_unit  REAL NOT NULL,
    notes            TEXT DEFAULT '',
    created_at       TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── ingredients migration ──────────────────────────────
  const ingMig = [
    'ALTER TABLE ingredients ADD COLUMN low_stock_threshold REAL DEFAULT 0',
    "ALTER TABLE ingredients ADD COLUMN operator TEXT DEFAULT ''",
    'ALTER TABLE ingredients ADD COLUMN default_thaw_hours REAL DEFAULT 0',
  ];
  ingMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ── fix18-10-hotfix11：強制驗證 ingredients UNIQUE(store_id,name) ──────────
  // 根本原因：hotfix10 用 ingredients_h10_tmp 重建，若上次 server 崩潰導致
  //           tmp 表遺留，CREATE TABLE 失敗 → ROLLBACK → UNIQUE(name) 仍存在。
  //
  // hotfix11 修正策略：
  //   1. 先清掉所有遺留的 ingredients_h??_tmp / h??_new 表
  //   2. 用 PRAGMA index_list 實際查每個 unique index 的欄位（不用 regex）
  //   3. 只要有任何 unique index 欄位只含 'name'（不含 store_id）→ 強制重建
  //   4. 重建完成後再次 PRAGMA 驗證，印出完整 schema
  //   5. 最終插入兩店同名資料做防彈測試
  try {
    // ── 步驟 0：清掉所有可能遺留的 tmp/new 表 ───────────────────────────────
    const _leftoverTbls = (w._db.exec("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'ingredients_%tmp' OR name LIKE 'ingredients_%new')"))?.[0]?.values || [];
    for (const [_tname] of _leftoverTbls) {
      try { w._db.run(`DROP TABLE IF EXISTS "${_tname}"`); console.log('[DB] hotfix11: 清除遺留表', _tname); }
      catch(_et) { console.warn('[DB] hotfix11: 無法清除', _tname, _et.message); }
    }

    // ── 步驟 1：印出目前 schema ────────────────────────────────────────────
    const _ingTableSql = (w._db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='ingredients'")?.[0]?.values?.[0]?.[0]) || '';
    const _ingIdxList  = (w._db.exec("PRAGMA index_list('ingredients')")?.[0]?.values) || [];
    console.log('[DB] hotfix11: ingredients TABLE SQL =>', _ingTableSql);
    console.log('[DB] hotfix11: PRAGMA index_list =>', JSON.stringify(_ingIdxList));

    // ── 步驟 2：逐一查每個 unique index 的欄位（不用 regex）───────────────
    let _hasNameOnlyUnique = false;
    for (const _idxRow of _ingIdxList) {
      const _isUnique = _idxRow[2] === 1;
      const _idxName  = _idxRow[1];
      const _idxCols  = (w._db.exec(`SELECT name FROM pragma_index_info('${_idxName}')`)?.[0]?.values || []).map(r => r[0]);
      console.log(`[DB] hotfix11:   index "${_idxName}" cols=${JSON.stringify(_idxCols)} unique=${_isUnique}`);
      if (_isUnique && _idxCols.length === 1 && _idxCols[0] === 'name') {
        _hasNameOnlyUnique = true;
        console.log(`[DB] hotfix11:   ⚠️  UNIQUE(name) 偵測到，需重建`);
      }
    }

    // ── 步驟 3：若需重建 → 不用 transaction，逐步執行 ─────────────────────
    if (_hasNameOnlyUnique) {
      console.log('[DB] hotfix11: 開始重建 ingredients → UNIQUE(store_id, name)...');
      const _ingColRows = w._db.exec("PRAGMA table_info(ingredients)")?.[0]?.values || [];
      const _ingCols    = _ingColRows.map(r => r[1]);
      // safeDefault: function-call defaults (e.g. datetime('now','localtime'))
      // must be wrapped in parens; PRAGMA table_info returns them WITHOUT outer parens
      const _safeDefault = (_dflt) => {
        if (_dflt === null || _dflt === undefined) return '';
        const _s = String(_dflt);
        return /\(/.test(_s) ? ` DEFAULT (${_s})` : ` DEFAULT ${_s}`;
      };
      const _colDefs    = _ingColRows.map(r => {
        const [, _cn, _ct, _nn, _dflt, _isPk] = r;
        if (_isPk) return `${_cn} INTEGER PRIMARY KEY AUTOINCREMENT`;
        let _def = `${_cn} ${_ct || 'TEXT'}`;
        if (_nn) _def += ' NOT NULL';
        _def += _safeDefault(_dflt);
        return _def;
      }).join(',\n    ');

      const _tmpName = 'ingredients_h11_new';
      try { w._db.run(`DROP TABLE IF EXISTS "${_tmpName}"`); } catch {}

      try {
        w._db.run(`CREATE TABLE "${_tmpName}" (\n    ${_colDefs},\n    UNIQUE(store_id, name)\n  )`);
        const _oldCount = w._db.exec('SELECT COUNT(*) FROM ingredients')?.[0]?.values?.[0]?.[0] || 0;
        w._db.run(`INSERT OR IGNORE INTO "${_tmpName}" (${_ingCols.join(',')}) SELECT ${_ingCols.join(',')} FROM ingredients`);
        const _newCount = w._db.exec(`SELECT COUNT(*) FROM "${_tmpName}"`)?.[0]?.values?.[0]?.[0] || 0;
        if (_oldCount !== _newCount) {
          console.warn(`[DB] hotfix11: 重建跳過 ${_oldCount - _newCount} 筆重複（同 store_id+name）`);
        }
        w._db.run('DROP TABLE ingredients');
        w._db.run(`ALTER TABLE "${_tmpName}" RENAME TO ingredients`);
        w._save();
        console.log(`[DB] hotfix11: ✅ 重建完成，保留 ${_newCount} 筆`);
      } catch(_e2) {
        console.error('[DB] hotfix11: ❌ 重建失敗:', _e2.message);
        try { w._db.run(`DROP TABLE IF EXISTS "${_tmpName}"`); } catch {}
      }
    } else {
      console.log('[DB] hotfix11: schema OK，確保 UNIQUE(store_id,name) index 存在');
      try {
        w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_ingredients_store_name ON ingredients(store_id, name)');
        w._save();
      } catch {}
    }

    // ── 步驟 4：驗證後印出最終 schema ────────────────────────────────────
    const _finalSql     = (w._db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='ingredients'")?.[0]?.values?.[0]?.[0]) || '';
    const _finalIdxList = (w._db.exec("PRAGMA index_list('ingredients')")?.[0]?.values) || [];
    console.log('[DB] hotfix11: [驗證] TABLE SQL =>', _finalSql);
    for (const _ir of _finalIdxList) {
      const _ic = (w._db.exec(`SELECT name FROM pragma_index_info('${_ir[1]}')`)?.[0]?.values || []).map(r => r[0]);
      console.log(`[DB] hotfix11: [驗證]   index "${_ir[1]}" cols=${JSON.stringify(_ic)} unique=${_ir[2]===1}`);
    }

    // ── 步驟 5：跨店同名防彈測試 ─────────────────────────────────────────
    try {
      w._db.run(`INSERT OR IGNORE INTO ingredients (store_id,name,unit,frozen_stock,total_stock) VALUES ('__h11_test_s1__','__h11_test__','g',0,0)`);
      w._db.run(`INSERT OR IGNORE INTO ingredients (store_id,name,unit,frozen_stock,total_stock) VALUES ('__h11_test_s2__','__h11_test__','g',0,0)`);
      const _tc = w._db.exec("SELECT COUNT(*) FROM ingredients WHERE name='__h11_test__'")?.[0]?.values?.[0]?.[0] || 0;
      w._db.run(`DELETE FROM ingredients WHERE name='__h11_test__'`);
      w._save();
      if (_tc >= 2) {
        console.log('[DB] hotfix11: ✅ 跨店同名測試通過');
      } else {
        console.error('[DB] hotfix11: ❌ 跨店同名測試失敗，UNIQUE(name) 仍存在！count=', _tc);
      }
    } catch(_et) {
      console.error('[DB] hotfix11: ❌ 跨店同名測試例外:', _et.message);
    }
  } catch(_e) {
    console.error('[DB] hotfix11: 頂層失敗:', _e.message);
  }


  // ── ingredient_thaw_batches ──────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS ingredient_thaw_batches (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    ingredient_id        INTEGER NOT NULL,
    ingredient_name      TEXT NOT NULL,
    amount               REAL NOT NULL,
    unit                 TEXT DEFAULT 'g',
    started_at           TEXT DEFAULT (datetime('now','localtime')),
    expected_complete_at TEXT DEFAULT '',
    completed_at         TEXT DEFAULT '',
    status               TEXT DEFAULT 'thawing',
    extended_count       INTEGER DEFAULT 0,
    notes                TEXT DEFAULT '',
    created_at           TEXT DEFAULT (datetime('now','localtime')),
    updated_at           TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── orders ────────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, order_number TEXT NOT NULL,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    customer_name TEXT DEFAULT '', customer_phone TEXT DEFAULT '',
    customer_line_id TEXT DEFAULT '', items TEXT NOT NULL,
    payment_method TEXT NOT NULL DEFAULT 'cash',
    subtotal REAL NOT NULL, total REAL NOT NULL, note TEXT DEFAULT '',
    status TEXT DEFAULT 'completed', webhook_sent INTEGER DEFAULT 0,
    received_amount REAL DEFAULT 0, change_amount REAL DEFAULT 0,
    void_reason TEXT DEFAULT '', voided_at TEXT DEFAULT '',
    updated_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const orderMigrations = [
    'ALTER TABLE orders ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\'',
    'ALTER TABLE orders ADD COLUMN received_amount REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN change_amount REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN void_reason TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN voided_at TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN updated_at TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN order_mode TEXT DEFAULT "dine_in"',
    'ALTER TABLE orders ADD COLUMN order_status TEXT DEFAULT "completed"',
    'ALTER TABLE orders ADD COLUMN table_number TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN guest_count INTEGER DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN pickup_name TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN pickup_time TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN delivery_platform TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN delivery_address TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN estimated_delivery TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN platform_commission_rate REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN platform_commission_amount REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN store_actual_income REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN delivery_fee REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN discount_amount REAL DEFAULT 0',
    'ALTER TABLE orders ADD COLUMN platform_order_no TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN delivery_status TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN uuid TEXT DEFAULT NULL',
    'ALTER TABLE orders ADD COLUMN sync_status TEXT DEFAULT "synced"',
    'ALTER TABLE orders ADD COLUMN device_id TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN kitchen_status TEXT DEFAULT "pending"',
    'ALTER TABLE orders ADD COLUMN payment_status TEXT DEFAULT "paid"',
    'ALTER TABLE orders ADD COLUMN discount_type TEXT DEFAULT "none"',
    'ALTER TABLE orders ADD COLUMN source TEXT DEFAULT "pos"',
    'ALTER TABLE orders ADD COLUMN customer_line_id TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN payment_method TEXT DEFAULT "cash"',
    'ALTER TABLE orders ADD COLUMN payment_category TEXT DEFAULT "cash"',
  ];
  orderMigrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // Migration: 補上所有現有訂單的 store_id
  try {
    w._db.run(`UPDATE orders SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`);
    w._save();
  } catch {}

  // payment_category 資料補全
  try {
    w._db.run(`
      UPDATE orders SET payment_category = CASE
        WHEN payment_method IN ('cash','現金','現場付款') THEN 'cash'
        ELSE 'non_cash'
      END
      WHERE payment_category IS NULL OR payment_category = ''
    `);
    w._save();
  } catch(e) { console.error('[db] payment_category migration error:', e.message); }

  // Migration: 修復 LINE 訂單 id
  try {
    w._db.run(`UPDATE orders SET id = uuid
            WHERE (id IS NULL OR id = '')
              AND uuid IS NOT NULL AND uuid != ''`);
    w._db.run(`UPDATE orders SET id = order_number
            WHERE (id IS NULL OR id = '')
              AND order_number IS NOT NULL AND order_number != ''`);
    w._save();
  } catch {}

  // ── order_logs ────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS order_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    order_id TEXT NOT NULL, order_number TEXT NOT NULL,
    action TEXT NOT NULL DEFAULT 'modify', reason TEXT DEFAULT '',
    operator TEXT DEFAULT 'staff', before_data TEXT DEFAULT '',
    after_data TEXT DEFAULT '', before_total REAL DEFAULT 0,
    after_total REAL DEFAULT 0, amount_diff REAL DEFAULT 0,
    before_payment TEXT DEFAULT '', after_payment TEXT DEFAULT '',
    before_received REAL DEFAULT 0, after_received REAL DEFAULT 0,
    before_change REAL DEFAULT 0, after_change REAL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE order_logs ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}

  // ── customers ─────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT DEFAULT '',
    phone TEXT, line_id TEXT DEFAULT '',
    total_spent REAL DEFAULT 0, visit_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE customers ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE customers SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

  // ── settings ─────────────────────────────────────────────────────────────────
  // fix8：徹底解決舊版 key PRIMARY KEY 問題
  //
  // 舊版 settings 可能有兩種問題 schema：
  //   (A) key TEXT PRIMARY KEY, value TEXT           ← 最老版本
  //   (B) id INTEGER PK, store_id, key, value        ← R1 初版
  //   (C) store_id, key, value (正確，但 key 可能仍是 PK) ← fix7 狀態
  //
  // 問題：只要 key 是 PRIMARY KEY，不同 store 就無法有同名 key（跨店衝突）。
  // ALTER TABLE 無法改變 PRIMARY KEY，唯一解法是重建表。
  //
  // 最終目標 schema：
  //   store_id TEXT NOT NULL DEFAULT 'store_001'
  //   key      TEXT NOT NULL
  //   value    TEXT NOT NULL DEFAULT ''
  //   PRIMARY KEY (store_id, key)        ← 複合 PK，允許不同 store 有同名 key
  //
  // 重建條件：key 欄位的 PRAGMA pk 值 > 0（表示 key 是 PRIMARY KEY 的一部分）
  //           且 store_id 欄位的 pk 值 = 0（表示複合 PK 尚未建立）
  // 可重複執行：CREATE TABLE settings_new → INSERT OR IGNORE → DROP → RENAME
  //             若 settings_new 已存在（上次重建未完成），先 DROP 再建

  (() => {
    // ── settings 表重建 Migration（fix8）─────────────────────
    //
    // 處理三種舊版 schema：
    //   A) key TEXT PRIMARY KEY, value TEXT                 ← 最老版，key 全域唯一
    //   B) id INTEGER PK, store_id, key, value             ← R1 初版，UNIQUE(store_id,key)
    //   C) key TEXT PK + store_id（ALTER TABLE 後加）       ← fix7 狀態
    //
    // 目標：PRIMARY KEY (store_id, key)，允許不同 store 有同名 key。
    //
    // 執行順序：
    //   1. PRAGMA 讀取現有欄位與 PK 資訊
    //   2. 表不存在 → 直接建立正確版本，結束
    //   3. 已是正確複合 PK → 補資料，結束
    //   4. 需重建：
    //      4a. 若缺少 store_id 欄位 → 先 ALTER TABLE ADD（確保搬移時有值）
    //      4b. 補填 store_id = 'store_001'
    //      4c. CREATE settings_new → INSERT OR IGNORE → DROP → RENAME

    // 步驟 1：取得現有 schema
    let pragmaRows = [];
    try {
      const r = w._db.exec('PRAGMA table_info(settings)');
      pragmaRows = r.length > 0 ? r[0].values : [];
    } catch {}

    const colMeta = {};
    pragmaRows.forEach(r => { colMeta[String(r[1]).toLowerCase()] = { pk: Number(r[5]) }; });

    const hasStoreId    = 'store_id' in colMeta;
    const hasKey        = 'key'      in colMeta;
    const hasValue      = 'value'    in colMeta;
    const tableNotExist = pragmaRows.length === 0;
    const alreadyCorrect = hasStoreId && hasKey &&
      colMeta['store_id'].pk > 0 && colMeta['key'].pk > 0;

    // 步驟 2：表不存在 → 建立正確版本
    if (tableNotExist) {
      console.log('[DB] settings: 建立新表（複合 PK）');
      w._db.run(`CREATE TABLE settings (
        store_id TEXT NOT NULL DEFAULT 'store_001',
        key      TEXT NOT NULL,
        value    TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (store_id, key)
      )`);
      w._save();
      return;
    }

    // 步驟 3：已是正確複合 PK → 只補資料，跳過重建
    if (alreadyCorrect) {
      console.log('[DB] settings: schema 正確（複合 PK），跳過重建');
      try {
        w._db.run("UPDATE settings SET store_id='store_001' WHERE store_id IS NULL OR store_id=''");
        w._save();
      } catch {}
      return;
    }

    // 步驟 4：需要重建
    console.log('[DB] settings: 偵測到舊版 schema，開始重建...', JSON.stringify(colMeta));

    // 步驟 4a：若缺少 store_id 欄位，先 ALTER TABLE ADD
    // 目的：確保後面 INSERT ... SELECT store_id FROM settings 不會崩潰
    if (!hasStoreId) {
      try {
        w._db.run("ALTER TABLE settings ADD COLUMN store_id TEXT NOT NULL DEFAULT 'store_001'");
        w._save();
        console.log('[DB] settings: 暫時新增 store_id 欄位（待重建完成）');
      } catch(e) {
        // 若 ALTER 失敗（極少情況），繼續嘗試重建
        console.warn('[DB] settings ALTER store_id 失敗，繼續重建:', e.message);
      }
    }

    // 步驟 4b：補填 store_id 空值
    try {
      w._db.run("UPDATE settings SET store_id='store_001' WHERE store_id IS NULL OR store_id=''");
      w._save();
    } catch {}

    // 步驟 4c：重建表
    try { w._db.run('DROP TABLE IF EXISTS settings_new'); } catch {}

    w._db.run(`CREATE TABLE settings_new (
      store_id TEXT NOT NULL DEFAULT 'store_001',
      key      TEXT NOT NULL,
      value    TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (store_id, key)
    )`);

    // 搬移資料（store_id 現在必定存在）
    if (hasValue) {
      w._db.run(`INSERT OR IGNORE INTO settings_new (store_id, key, value)
        SELECT COALESCE(NULLIF(TRIM(store_id), ''), 'store_001'),
               key,
               COALESCE(value, '')
        FROM settings`);
    } else if (hasKey) {
      w._db.run(`INSERT OR IGNORE INTO settings_new (store_id, key, value)
        SELECT 'store_001', key, '' FROM settings`);
    }

    w._db.run('DROP TABLE settings');
    w._db.run('ALTER TABLE settings_new RENAME TO settings');
    w._save();

    // 驗證
    const verify = w._db.exec('PRAGMA table_info(settings)');
    const verPk  = (verify[0]?.values || []).filter(r => Number(r[5]) > 0).map(r => r[1]);
    console.log('[DB] settings 重建完成，PRIMARY KEY:', verPk.join('+'));
    if (!verPk.includes('store_id') || !verPk.includes('key')) {
      console.error('[DB] settings 重建驗證失敗：複合 PK 未正確建立！');
    }
  })();

  // ── payment_methods ───────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL, code TEXT NOT NULL,
    icon TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0,
    enable_for_dine_in INTEGER DEFAULT 1, enable_for_takeout INTEGER DEFAULT 1,
    enable_for_delivery INTEGER DEFAULT 1, allow_edit_when_platform_order INTEGER DEFAULT 1,
    gateway_code TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE payment_methods ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE payment_methods SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

  // fix16k-04: 付款方式 schema 遷移 + 全店 backfill（啟動時執行）
  // 新增：偵測並重建含錯誤 UNIQUE(code) 的舊表，修正多店 SaaS 架構衝突
  try {
    const { ensurePaymentMethodsSchema, ensureDefaultPaymentMethods } = require('../routes/payment-methods');

    // 建立完整 db wrapper（run 包含 _save）
    const pmDb = {
      _db:   w._db,
      _save: () => w._save(),
      run:   (sql, params=[]) => {
        const stmt = w._db.prepare(sql);
        stmt.run(Array.isArray(params) ? params : [params]);
        stmt.free();
        w._save();
      },
      get:   (sql, params=[]) => w.get(sql, params),
      all:   (sql, params=[]) => w.all(sql, params),
    };

    // Step 1: schema 修復（含偵測 UNIQUE(code) → 重建表 + 補欄位 + 建正確 index）
    ensurePaymentMethodsSchema(pmDb);

    // Step 2: 逐店補齊 6 筆（含啟動時已存在的所有 stores）
    const allStores = w.all('SELECT store_id FROM stores');
    allStores.forEach(({ store_id }) => ensureDefaultPaymentMethods(store_id, pmDb));
    console.log('[DB] fix16k-04: 付款方式 backfill 完成，共掃描', allStores.length, '家店');
  } catch(e) { console.error('[DB] fix16k-04: backfill error:', e.message); }

  // ── payment_gateways ──────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS payment_gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL, code TEXT NOT NULL,
    is_active INTEGER DEFAULT 0, mode TEXT DEFAULT 'test',
    api_key TEXT DEFAULT '', secret_key TEXT DEFAULT '',
    merchant_id TEXT DEFAULT '', webhook_url TEXT DEFAULT '',
    callback_url TEXT DEFAULT '', extra_config TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE payment_gateways ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE payment_gateways SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}
  // fix16d: 建立 UNIQUE INDEX (store_id, code) — 讓 INSERT OR IGNORE 正確去重
  // 若有重複資料先清理，再建 index
  try {
    w._db.run(`DELETE FROM payment_gateways WHERE rowid NOT IN (
      SELECT MIN(rowid) FROM payment_gateways GROUP BY store_id, code
    )`);
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_store_code ON payment_gateways(store_id, code)');
    w._save();
  } catch(e) { console.warn('[DB] payment_gateways unique index:', e.message); }

  // fix16d: seedPaymentGateways — 確保每個店家都有 8 個 provider 記錄
  // 只新增缺少的 provider，不覆蓋既有設定
  const GW_PROVIDERS = [
    ['LINE Pay',          'linepay'],
    ['綠界 ECPay',        'ecpay'],
    ['藍新 NewebPay',     'newebpay'],
    ['街口支付',          'jkopay'],
    ['全支付',            'pxpay'],
    ['Apple Pay',         'applepay'],
    ['Google Pay',        'googlepay'],
    ['信用卡刷卡機',      'creditcard_terminal'],
  ];

  function seedPaymentGateways(storeId) {
    GW_PROVIDERS.forEach(([name, code]) => {
      // INSERT OR IGNORE：已存在的記錄不覆蓋
      w._db.run(
        `INSERT OR IGNORE INTO payment_gateways (store_id, name, code, is_active, mode, api_key, secret_key, merchant_id, webhook_url, callback_url, extra_config)
         VALUES (?, ?, ?, 0, 'test', '', '', '', '', '', '{}')`,
        [storeId, name, code]
      );
    });
    w._save();
  }

  // seed store_001
  seedPaymentGateways('store_001');

  // fix16d backfill：掃描所有 stores，補齊沒有 payment_gateways 的店家
  try {
    const allStores = w.all('SELECT store_id FROM stores WHERE active=1');
    allStores.forEach(({ store_id }) => seedPaymentGateways(store_id));
    console.log('[DB] fix16d: payment_gateways backfill 完成，共掃描', allStores.length, '家店');
  } catch(e) { console.error('[DB] fix16d: payment_gateways backfill error:', e.message); }

  // ── devices ───────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    device_id TEXT NOT NULL,
    device_name TEXT DEFAULT '',
    device_role TEXT DEFAULT 'POS',
    last_seen_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE devices ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}

  // ── delivery_platforms ────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS delivery_platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL,
    commission_rate REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  try { w._db.run('ALTER TABLE delivery_platforms ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE delivery_platforms SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

  const platCount = w.get("SELECT COUNT(*) as c FROM delivery_platforms WHERE store_id='store_001'");
  if (!platCount || Number(platCount.c) === 0) {
    const platforms = [
      ['Uber Eats', 30], ['Foodpanda', 35], ['電話訂單', 0],
      ['LINE訂單', 0], ['自送', 0], ['Lalamove', 0]
    ];
    platforms.forEach(([name, rate]) =>
      w._db.run('INSERT INTO delivery_platforms (store_id,name,commission_rate) VALUES (?,?,?)', ['store_001',name, rate])
    );
    w._save();
  }

  // ── Seed categories ────────────────────────────────────
  const catCount = w.get("SELECT COUNT(*) as c FROM categories WHERE store_id='store_001'");
  if (!catCount || Number(catCount.c) === 0) {
    [['主食','🍚',1],['小菜','🥗',2],['飲料','🧋',3]].forEach(([name,icon,sort]) =>
      w._db.run('INSERT INTO categories (store_id,name,icon,sort_order,is_active) VALUES (?,?,?,?,1)', ['store_001',name,icon,sort])
    );
    w._save();
  }

  // ── Seed products ─────────────────────────────────────
  const prodCount = w.get("SELECT COUNT(*) as c FROM products WHERE store_id='store_001'");
  if (!prodCount || Number(prodCount.c) === 0) {
    const catIdMap = {};
    w.all("SELECT id,name FROM categories WHERE store_id='store_001'").forEach(c => { catIdMap[c.name] = c.id; });
    const items = [
      ['冷拌麻油腰子','主食',150,1],['滷肉飯','主食',60,2],['排骨飯','主食',120,3],
      ['雞腿便當','主食',130,4],['燙青菜','小菜',30,5],['滷蛋','小菜',20,6],
      ['豆腐','小菜',35,7],['紅燒豆腐','小菜',45,8],['珍珠奶茶','飲料',50,9],
      ['紅茶','飲料',25,10],['綠茶','飲料',25,11],['冬瓜茶','飲料',30,12],
    ];
    items.forEach(([n,c,p,o]) => {
      const cid = catIdMap[c] || 0;
      w._db.run(
        'INSERT INTO products (store_id,name,category,category_id,price,sort_order) VALUES (?,?,?,?,?,?)', ['store_001',n,c,cid,p,o]
      );
    });
    w._save();
  }

  // ── Settings defaults（per-store）────────────────────
  // fix7：改用 SELECT key（不依賴 id 欄位），並改用 INSERT OR IGNORE
  const sd = (storeId, k, v) => {
    try {
      w._db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, v]);
    } catch(e) { console.error('[DB] sd() error:', e.message); }
  };
  const sid = 'store_001';
  sd(sid,'shop_name','脆豬腰'); sd(sid,'n8n_webhook_url',''); sd(sid,'line_channel_token','');
  sd(sid,'tax_rate','0'); sd(sid,'receipt_footer','感謝您的光臨！歡迎再次惠顧');
  sd(sid,'printer_enabled','0'); sd(sid,'printer_type','network');
  sd(sid,'printer_ip','192.168.1.100'); sd(sid,'printer_port','9100');
  sd(sid,'auto_print','0'); sd(sid,'auto_drawer','0');
  sd(sid,'shop_logo',''); sd(sid,'shop_cover',''); sd(sid,'shop_address','');
  sd(sid,'shop_google_map',''); sd(sid,'shop_hours',''); sd(sid,'shop_announcement','');
  sd(sid,'line_order_enabled','1'); sd(sid,'line_order_min_amount','0');
  sd(sid,'n8n_new_order_webhook',''); sd(sid,'n8n_status_change_webhook','');
  sd(sid,'line_ordering_enabled','1');
  sd(sid,'line_business_hours_enabled','0');
  sd(sid,'line_business_hours', JSON.stringify({
    mon:{open:'09:00',close:'21:00',enabled:true},
    tue:{open:'09:00',close:'21:00',enabled:true},
    wed:{open:'09:00',close:'21:00',enabled:true},
    thu:{open:'09:00',close:'21:00',enabled:true},
    fri:{open:'09:00',close:'21:00',enabled:true},
    sat:{open:'09:00',close:'21:00',enabled:true},
    sun:{open:'09:00',close:'21:00',enabled:false},
  }));
  sd(sid,'pickup_enabled','1'); sd(sid,'delivery_enabled','1');
  sd(sid,'pickup_business_hours_enabled','0'); sd(sid,'delivery_business_hours_enabled','0');
  sd(sid,'line_today_closed','0'); sd(sid,'line_today_closed_date','');
  sd(sid,'same_day_preorder_minutes','30'); sd(sid,'next_day_preorder_hours','2');
  sd(sid,'line_closed_weekdays','[]'); sd(sid,'line_closed_dates','[]');
  sd(sid,'line_payment_cash_enabled','1'); sd(sid,'line_payment_linepay_enabled','1');
  sd(sid,'line_payment_transfer_enabled','1'); sd(sid,'line_payment_platform_enabled','0');
  sd(sid,'line_payment_credit_card_enabled','0');

  // ── LINE 接單與可售管理中心 v1 ─────────────────────────
  // 外帶規則
  sd(sid,'takeout_enabled','1');
  sd(sid,'takeout_cutoff_time','');
  sd(sid,'takeout_prep_minutes','15');
  sd(sid,'takeout_allow_next_day','1');
  sd(sid,'takeout_business_hours', JSON.stringify({
    mon:{open:'11:00',close:'20:00',enabled:true},
    tue:{open:'11:00',close:'20:00',enabled:true},
    wed:{open:'11:00',close:'20:00',enabled:true},
    thu:{open:'11:00',close:'20:00',enabled:true},
    fri:{open:'11:00',close:'20:00',enabled:true},
    sat:{open:'11:00',close:'20:00',enabled:true},
    sun:{open:'11:00',close:'20:00',enabled:false},
  }));
  // 外送規則
  sd(sid,'delivery_cutoff_time','');
  sd(sid,'delivery_prep_minutes','30');
  sd(sid,'delivery_allow_next_day','1');
  sd(sid,'delivery_business_hours', JSON.stringify({
    mon:{open:'11:00',close:'21:00',enabled:true},
    tue:{open:'11:00',close:'21:00',enabled:true},
    wed:{open:'11:00',close:'21:00',enabled:true},
    thu:{open:'11:00',close:'21:00',enabled:true},
    fri:{open:'11:00',close:'21:00',enabled:true},
    sat:{open:'11:00',close:'21:00',enabled:true},
    sun:{open:'11:00',close:'21:00',enabled:false},
  }));
  // 公休日 / 店休日（已有 line_closed_weekdays / line_closed_dates，沿用）
  // 跨日最短預訂時間（小時）
  sd(sid,'next_day_min_hours','2');

  w._save();

  // ── fix18-05：orders 補欄位（safe migration）──────────
  // coupon_code / original_total — 優惠券折扣相關
  // discount_amount 已存在（orderMigrations 中），不重複新增
  try { w._db.run('ALTER TABLE orders ADD COLUMN coupon_code TEXT DEFAULT ""'); w._save(); } catch {}
  try { w._db.run('ALTER TABLE orders ADD COLUMN original_total REAL DEFAULT 0'); w._save(); } catch {}

  // ── fix18-05：coupons（優惠券主表）────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS coupons (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id           TEXT NOT NULL DEFAULT 'store_001',
    code               TEXT NOT NULL,
    name               TEXT NOT NULL DEFAULT '',
    discount_type      TEXT NOT NULL DEFAULT 'fixed',
    discount_value     REAL NOT NULL DEFAULT 0,
    min_amount         REAL NOT NULL DEFAULT 0,
    start_at           TEXT DEFAULT '',
    end_at             TEXT DEFAULT '',
    max_usage          INTEGER DEFAULT 0,
    max_usage_per_phone INTEGER DEFAULT 0,
    enabled            INTEGER NOT NULL DEFAULT 1,
    created_at         TEXT DEFAULT (datetime('now','localtime')),
    updated_at         TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(store_id, code)
  )`);
  w._save();

  // ── fix18-05：coupon_redemptions（使用紀錄）────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS coupon_redemptions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        TEXT NOT NULL DEFAULT 'store_001',
    coupon_id       INTEGER NOT NULL,
    coupon_code     TEXT NOT NULL,
    order_id        TEXT NOT NULL,
    order_number    TEXT NOT NULL,
    customer_phone  TEXT NOT NULL DEFAULT '',
    discount_amount REAL NOT NULL DEFAULT 0,
    original_total  REAL NOT NULL DEFAULT 0,
    final_total     REAL NOT NULL DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now','localtime'))
  )`);
  // 防止同一訂單重複寫入 redemption
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_coupon_redemptions_order ON coupon_redemptions(store_id, order_id)');
    w._save();
  } catch(e) { console.warn('[DB] coupon_redemptions unique index:', e.message); }
  w._save();

  // ── fix18-06：orders 補欄位（Google Maps 外送距離計費）──
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_address_note TEXT DEFAULT ""'); w._save(); } catch {}
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_lat TEXT DEFAULT ""'); w._save(); } catch {}
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_lng TEXT DEFAULT ""'); w._save(); } catch {}
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_distance_km REAL DEFAULT 0'); w._save(); } catch {}
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_maps_url TEXT DEFAULT ""'); w._save(); } catch {}
  // delivery_address & delivery_fee 已在 orderMigrations 中，不重複新增

  // ── fix18-06：settings seed（外送距離費率設定）──────────
  const deliveryFeeRulesDefault = JSON.stringify([
    { max_km: 3, fee: 50 },
    { max_km: 5, fee: 80 },
    { max_km: 7, fee: 120 },
  ]);
  const deliverySeeds = [
    ['store_address',                 ''],
    ['store_lat',                     ''],
    ['store_lng',                     ''],
    ['delivery_distance_fee_enabled', '1'],
    ['delivery_distance_fee_rules',   deliveryFeeRulesDefault],
    ['delivery_max_distance_km',      '7'],
    ['delivery_basic_fee',            '50'],
    ['delivery_free_threshold',       '1000'],
    ['coupon_apply_to_delivery_fee',  '0'],
  ];
  deliverySeeds.forEach(([k, v]) => {
    try {
      const existing = w.get('SELECT value FROM settings WHERE store_id=? AND key=?', ['store_001', k]);
      if (!existing) {
        w._db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', ['store_001', k, v]);
        w._save();
      }
    } catch(e) { console.warn('[DB] delivery seed:', k, e.message); }
  });

  // ── licenses ─────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS licenses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id   TEXT NOT NULL UNIQUE,
    store_name TEXT NOT NULL DEFAULT '預設店家',
    plan       TEXT NOT NULL DEFAULT 'basic',
    active     INTEGER NOT NULL DEFAULT 1,
    features   TEXT NOT NULL DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();

  const licCount = w.get('SELECT COUNT(*) as c FROM licenses');
  if (!licCount || Number(licCount.c) === 0) {
    // fix16d: Pro 方案標準 features（payment_api=true）
    const PRO_FEATURES = JSON.stringify({
      order: true, orders: true, products: true, reports: true, print: true,
      inventory: true, line_order: true, delivery: true,
      marketing: false, member: false, coupon: false, label_print: true,
      payment_api: true,
      payment_methods: true
    });
    w._db.run(
      `INSERT INTO licenses (store_id, store_name, plan, active, features) VALUES (?,?,?,?,?)`,
      ['store_001', '脆豬腰', 'pro', 1, PRO_FEATURES]
    );
    w._save();
  } else {
    // 若已有 default_store，更新為 store_001 脆豬腰
    try {
      w._db.run(`UPDATE licenses SET store_id='store_001', store_name='脆豬腰' WHERE store_id='default_store'`);
      w._save();
    } catch {}
  }

  // ── fix18-09F：商品分析群組 ────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS product_analysis_groups (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id    TEXT NOT NULL DEFAULT 'store_001',
    group_name  TEXT NOT NULL,
    description TEXT DEFAULT '',
    enabled     INTEGER NOT NULL DEFAULT 1,
    sort_order  INTEGER DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now','localtime')),
    updated_at  TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();

  w._db.run(`CREATE TABLE IF NOT EXISTS product_analysis_group_items (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL DEFAULT 'store_001',
    group_id     INTEGER NOT NULL,
    product_id   INTEGER DEFAULT 0,
    product_name TEXT NOT NULL DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (group_id) REFERENCES product_analysis_groups(id) ON DELETE CASCADE
  )`);
  w._save();

  // Index for fast lookup
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_pag_store ON product_analysis_groups(store_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_pagi_group ON product_analysis_group_items(group_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_pagi_store ON product_analysis_group_items(store_id)');
    w._save();
  } catch(e) { console.warn('[DB] product_analysis index:', e.message); }

  // ── fix18-09F-hotfix4：歷史品名別名表 ────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS product_analysis_group_aliases (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id   TEXT NOT NULL DEFAULT 'store_001',
    group_id   INTEGER NOT NULL,
    alias_name TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    FOREIGN KEY (group_id) REFERENCES product_analysis_groups(id) ON DELETE CASCADE
  )`);
  w._save();

  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_paga_group ON product_analysis_group_aliases(group_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_paga_store ON product_analysis_group_aliases(store_id)');
    w._save();
  } catch(e) { console.warn('[DB] product_analysis_aliases index:', e.message); }
}

module.exports = { getDb, initDb };

// Note: migration_logs table is created on-demand in routes/migration.js
// to keep backward compatibility with existing DB instances.
