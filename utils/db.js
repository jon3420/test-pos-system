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
    // hotfix13-BUG6：LinePay 已付款訂單取消時的待退款流程
    'ALTER TABLE orders ADD COLUMN refund_status TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN refund_note TEXT DEFAULT ""',
    'ALTER TABLE orders ADD COLUMN refunded_at TEXT DEFAULT ""',
    // fix18-10-hotfix23-E：LINE 會員入口 —— 訂單會員綁定（未登入訂單維持空字串，不影響
    // 既有訂單；沿用專案既有「try/catch ALTER TABLE」safe migration 慣例，可重複執行）
    'ALTER TABLE orders ADD COLUMN line_user_id TEXT DEFAULT ""',
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

  // ── fix18-10-hotfix12：delivery_platforms UNIQUE(store_id,name) ──────────
  // 舊版 delivery_platforms 可能有 UNIQUE(name)，導致跨店新增同名平台失敗
  // 修正方式同 hotfix11 ingredients：先清 tmp，再 PRAGMA 查，再重建
  try {
    // 步驟 0：清遺留 tmp/new 表
    const _dpLeftover = (w._db.exec("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'delivery_platforms_%tmp' OR name LIKE 'delivery_platforms_%new')"))?.[0]?.values || [];
    for (const [_tn] of _dpLeftover) {
      try { w._db.run(`DROP TABLE IF EXISTS "${_tn}"`); console.log('[DB] hotfix12: 清除遺留表', _tn); }
      catch(_et) { console.warn('[DB] hotfix12: 無法清除', _tn, _et.message); }
    }

    // 步驟 1：印出目前 schema
    const _dpSql  = (w._db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_platforms'")?.[0]?.values?.[0]?.[0]) || '';
    const _dpIdxs = (w._db.exec("PRAGMA index_list('delivery_platforms')")?.[0]?.values) || [];
    console.log('[DB] hotfix12: delivery_platforms TABLE SQL =>', _dpSql);
    console.log('[DB] hotfix12: PRAGMA index_list =>', JSON.stringify(_dpIdxs));

    // 步驟 2：偵測 UNIQUE(name) — 查每個 unique index 的欄位
    let _dpNeedRebuild = false;
    for (const _ir of _dpIdxs) {
      const _isUniq = _ir[2] === 1;
      const _iName  = _ir[1];
      const _iCols  = (w._db.exec(`SELECT name FROM pragma_index_info('${_iName}')`)?.[0]?.values || []).map(r => r[0]);
      console.log(`[DB] hotfix12:   index "${_iName}" cols=${JSON.stringify(_iCols)} unique=${_isUniq}`);
      if (_isUniq && _iCols.length === 1 && _iCols[0] === 'name') {
        _dpNeedRebuild = true;
        console.log('[DB] hotfix12:   ⚠️  UNIQUE(name) 偵測到，需重建');
      }
    }

    // 步驟 3：重建（不用 transaction）
    if (_dpNeedRebuild) {
      console.log('[DB] hotfix12: 開始重建 delivery_platforms → UNIQUE(store_id, name)...');
      const _dpColRows = w._db.exec("PRAGMA table_info(delivery_platforms)")?.[0]?.values || [];
      const _dpCols    = _dpColRows.map(r => r[1]);
      const _dpSafeDefault = (_dflt) => {
        if (_dflt === null || _dflt === undefined) return '';
        const _s = String(_dflt);
        return /\(/.test(_s) ? ` DEFAULT (${_s})` : ` DEFAULT ${_s}`;
      };
      const _dpColDefs = _dpColRows.map(r => {
        const [, _cn, _ct, _nn, _dflt, _isPk] = r;
        if (_isPk) return `${_cn} INTEGER PRIMARY KEY AUTOINCREMENT`;
        let _def = `${_cn} ${_ct || 'TEXT'}`;
        if (_nn) _def += ' NOT NULL';
        _def += _dpSafeDefault(_dflt);
        return _def;
      }).join(',\n    ');

      const _dpTmp = 'delivery_platforms_h12_new';
      try { w._db.run(`DROP TABLE IF EXISTS "${_dpTmp}"`); } catch {}

      try {
        w._db.run(`CREATE TABLE "${_dpTmp}" (\n    ${_dpColDefs},\n    UNIQUE(store_id, name)\n  )`);
        const _dpOld = w._db.exec('SELECT COUNT(*) FROM delivery_platforms')?.[0]?.values?.[0]?.[0] || 0;
        w._db.run(`INSERT OR IGNORE INTO "${_dpTmp}" (${_dpCols.join(',')}) SELECT ${_dpCols.join(',')} FROM delivery_platforms`);
        const _dpNew = w._db.exec(`SELECT COUNT(*) FROM "${_dpTmp}"`)?.[0]?.values?.[0]?.[0] || 0;
        if (_dpOld !== _dpNew) console.warn(`[DB] hotfix12: 重建跳過 ${_dpOld - _dpNew} 筆重複（同 store_id+name）`);
        w._db.run('DROP TABLE delivery_platforms');
        w._db.run(`ALTER TABLE "${_dpTmp}" RENAME TO delivery_platforms`);
        w._save();
        console.log(`[DB] hotfix12: ✅ 重建完成，保留 ${_dpNew} 筆`);
      } catch(_e2) {
        console.error('[DB] hotfix12: ❌ 重建失敗:', _e2.message);
        try { w._db.run(`DROP TABLE IF EXISTS "${_dpTmp}"`); } catch {}
      }
    } else {
      console.log('[DB] hotfix12: delivery_platforms schema OK，確保 UNIQUE(store_id,name) index 存在');
      try {
        w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_delivery_platforms_store_name ON delivery_platforms(store_id, name)');
        w._save();
      } catch {}
    }

    // 步驟 4：驗證
    const _dpFinalSql  = (w._db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='delivery_platforms'")?.[0]?.values?.[0]?.[0]) || '';
    const _dpFinalIdxs = (w._db.exec("PRAGMA index_list('delivery_platforms')")?.[0]?.values) || [];
    console.log('[DB] hotfix12: [驗證] TABLE SQL =>', _dpFinalSql);
    for (const _ir of _dpFinalIdxs) {
      const _ic = (w._db.exec(`SELECT name FROM pragma_index_info('${_ir[1]}')`)?.[0]?.values || []).map(r => r[0]);
      console.log(`[DB] hotfix12: [驗證]   index "${_ir[1]}" cols=${JSON.stringify(_ic)} unique=${_ir[2]===1}`);
    }

    // 步驟 5：跨店同名防彈測試
    try {
      w._db.run(`INSERT OR IGNORE INTO delivery_platforms (store_id,name,commission_rate,is_active) VALUES ('__h12_s1__','__h12_test__',0,1)`);
      w._db.run(`INSERT OR IGNORE INTO delivery_platforms (store_id,name,commission_rate,is_active) VALUES ('__h12_s2__','__h12_test__',0,1)`);
      const _tc = w._db.exec("SELECT COUNT(*) FROM delivery_platforms WHERE name='__h12_test__'")?.[0]?.values?.[0]?.[0] || 0;
      w._db.run(`DELETE FROM delivery_platforms WHERE name='__h12_test__'`);
      w._save();
      if (_tc >= 2) console.log('[DB] hotfix12: ✅ 跨店同名測試通過');
      else console.error('[DB] hotfix12: ❌ 跨店同名測試失敗，UNIQUE(name) 仍存在！count=', _tc);
    } catch(_et) { console.error('[DB] hotfix12: ❌ 跨店同名測試例外:', _et.message); }
  } catch(_e) { console.error('[DB] hotfix12: 頂層失敗:', _e.message); }


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
  // Phase 3：AI 行銷中心 Brand Context 用（新增，全部 INSERT OR IGNORE，不影響既有 key）
  sd(sid,'shop_slogan',''); sd(sid,'shop_line_url',''); sd(sid,'shop_facebook_url','');
  sd(sid,'shop_instagram_url',''); sd(sid,'brand_tone',''); sd(sid,'brand_cta_template','');
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
  // ── C3：距離級距滿額免運 metadata（非破壞性新增；欄位已存在時 catch 吞掉即可，
  // 不重建 orders 表、不改變既有 delivery_fee 欄位語意——delivery_fee 依然只存
  // 最終實收外送費，delivery_fee_meta 是額外的 JSON 明細快照，供後台顯示用）──
  try { w._db.run('ALTER TABLE orders ADD COLUMN delivery_fee_meta TEXT DEFAULT ""'); w._save(); } catch {}
  // delivery_address & delivery_fee 已在 orderMigrations 中，不重複新增

  // ── fix18-06 → C3：settings seed（外送距離費率設定）──────────
  // C3：新店/尚未設定過規則的店，預設改用新版「距離級距＋各級距獨立滿額免運」schema
  // （需求文件三）。這裡沿用既有 deliverySeeds.forEach()「只在 key 完全不存在時才寫入」
  // 的邏輯（見下方 if (!existing)），因此绝不會覆蓋任何已經設定過規則的既有店家；
  // 「套用建議級距」按鈕（後台 UI）使用同一份預設值，見 DELIVERY_FEE_SUGGESTED_RULES。
  const DELIVERY_FEE_SUGGESTED_RULES = require('./deliveryFeeSuggestedRules');
  const deliveryFeeRulesDefault = JSON.stringify(DELIVERY_FEE_SUGGESTED_RULES);
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

  // ── Business Calendar V2：營業行事曆（特殊營業日 / 休假日期覆蓋層）──
  // safe migration：只用 CREATE TABLE IF NOT EXISTS，絕不 DROP / 重建 / 清空既有資料
  // 專案沒有 tenant_id 概念，沿用既有慣例，僅用 store_id 隔離
  w._db.run(`CREATE TABLE IF NOT EXISTS store_business_calendar (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id             TEXT NOT NULL,
    start_date           TEXT NOT NULL,
    end_date             TEXT NOT NULL,
    mode                 TEXT NOT NULL DEFAULT 'closed',
    reason               TEXT DEFAULT '',
    show_reason          INTEGER DEFAULT 1,
    takeout_enabled      INTEGER DEFAULT 1,
    delivery_enabled     INTEGER DEFAULT 1,
    takeout_start_time   TEXT DEFAULT '',
    takeout_end_time     TEXT DEFAULT '',
    delivery_start_time  TEXT DEFAULT '',
    delivery_end_time    TEXT DEFAULT '',
    created_at           TEXT DEFAULT (datetime('now','localtime')),
    updated_at           TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();

  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_store_business_calendar_range ON store_business_calendar(store_id, start_date, end_date)');
    w._save();
  } catch(e) { console.warn('[DB] store_business_calendar index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix18：LINE 冷藏宅配中心 V1 ─────────────────────────
  // 原則：safe migration，只用 ALTER TABLE ADD COLUMN / CREATE TABLE IF NOT EXISTS，
  // 絕不 DROP / 重建既有 orders、products 資料表或既有欄位。
  // ══════════════════════════════════════════════════════════════════

  // ── orders 補欄位（宅配訂單專用，獨立於外帶/外送欄位）──────────────
  const shippingOrderCols = [
    ['fulfillment_type',        'TEXT DEFAULT ""'],
    ['order_source',            'TEXT DEFAULT ""'],
    ['shipping_recipient_name', 'TEXT DEFAULT ""'],
    ['shipping_phone',          'TEXT DEFAULT ""'],
    ['shipping_postal_code',    'TEXT DEFAULT ""'],
    ['shipping_city',           'TEXT DEFAULT ""'],
    ['shipping_district',       'TEXT DEFAULT ""'],
    ['shipping_address',        'TEXT DEFAULT ""'],
    ['shipping_address_note',   'TEXT DEFAULT ""'],
    ['shipping_arrival_type',   'TEXT DEFAULT ""'],
    ['shipping_arrival_date',   'TEXT DEFAULT ""'],
    ['shipping_fee',            'REAL DEFAULT 0'],
    ['shipping_free_discount',  'REAL DEFAULT 0'],
    ['shipping_carrier_name',   'TEXT DEFAULT ""'],
    ['shipping_status',         'TEXT DEFAULT ""'],
    // V1 保留欄位（不串黑貓 API，僅供未來擴充/手動填寫）
    ['tracking_number',         'TEXT DEFAULT ""'],
    ['carrier_name',            'TEXT DEFAULT ""'],
    ['shipping_note',           'TEXT DEFAULT ""'],
  ];
  shippingOrderCols.forEach(([col, def]) => {
    try { w._db.run(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); w._save(); } catch {}
  });

  // ── products 補欄位（可宅配商品設定）────────────────────────────────
  const shippingProductCols = [
    ['shipping_enabled',           'INTEGER DEFAULT 0'],
    ['shipping_name',              'TEXT DEFAULT ""'],
    ['shipping_spec',              'TEXT DEFAULT ""'],
    ['shipping_sort_order',        'INTEGER DEFAULT 0'],
    ['shipping_upsell',            'INTEGER DEFAULT 0'],
    ['shipping_share_line_stock',  'INTEGER DEFAULT 1'],
  ];
  shippingProductCols.forEach(([col, def]) => {
    try { w._db.run(`ALTER TABLE products ADD COLUMN ${col} ${def}`); w._save(); } catch {}
  });

  // ── settings seed（冷藏宅配設定，全部 INSERT OR IGNORE，不影響既有 key）──
  const shippingSeeds = [
    ['shipping_enabled',              '0'],
    ['shipping_title',                '冷藏宅配'],
    ['shipping_description',          ''],
    ['shipping_notice',               ''],
    ['shipping_storage_note',         '收到後請立即冷藏，建議 48 小時內食用完畢'],
    ['shipping_fee',                  '200'],
    ['shipping_free_threshold',       '1500'],
    ['shipping_min_order_amount',     '150'],
    ['shipping_arrival_days_limit',   '14'],
    ['shipping_lead_days',            '1'],
    ['shipping_closed_weekdays',      '[]'],
    ['shipping_payment_methods',      JSON.stringify(['cash','transfer'])],
    ['shipping_carrier_name',         '黑貓冷藏宅配'],
    ['shipping_allow_arrival_date',   '1'],
    ['shipping_upsell_enabled',       '1'],
  ];
  shippingSeeds.forEach(([k, v]) => {
    try {
      w._db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', ['store_001', k, v]);
      w._save();
    } catch(e) { console.warn('[DB] shipping seed:', k, e.message); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix19：LINE 冷藏宅配中心 V2 — 多通路商品獨立欄位 ─────
  // 原則：safe migration，若欄位已存在（Hotfix18 已建立 shipping_name /
  // shipping_spec）則略過；只新增缺少的欄位，不動既有資料。
  // ══════════════════════════════════════════════════════════════════
  const multiChannelProductCols = [
    // LINE 通路（line_name/line_price/line_description/line_image_url 已存在，僅補 line_spec）
    ['line_spec',               'TEXT DEFAULT ""'],
    // 宅配通路（shipping_name/shipping_spec 已存在，僅補以下三個）
    ['shipping_price',          'REAL DEFAULT 0'],
    ['shipping_description',    'TEXT DEFAULT ""'],
    ['shipping_image_url',      'TEXT DEFAULT ""'],
  ];
  multiChannelProductCols.forEach(([col, def]) => {
    try { w._db.run(`ALTER TABLE products ADD COLUMN ${col} ${def}`); w._save(); } catch {}
  });

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix21：物流 API 架構預留 V1 ──────────────────────────
  // 原則：safe migration，只用 ALTER TABLE ADD COLUMN / INSERT OR IGNORE，
  // 絕不 DROP / 重建既有 orders 資料表或既有欄位；不改既有訂單資料。
  // 這一版不會有任何流程寫入下列欄位，僅預留架構供未來版本擴充。
  // ══════════════════════════════════════════════════════════════════
  const shippingApiOrderCols = [
    ['shipping_provider',        'TEXT DEFAULT ""'],
    ['shipping_api_status',      'TEXT DEFAULT ""'],
    ['shipping_api_updated_at',  'TEXT DEFAULT ""'],
    ['shipping_api_message',     'TEXT DEFAULT ""'],
  ];
  shippingApiOrderCols.forEach(([col, def]) => {
    try { w._db.run(`ALTER TABLE orders ADD COLUMN ${col} ${def}`); w._save(); } catch {}
  });

  // ── settings 預設值（物流 API 設定，全部 INSERT OR IGNORE，不影響既有 key）──
  const shippingApiSeeds = [
    ['shipping_api_enabled', '0'],
    ['shipping_provider',    'manual'],
    ['shipping_test_mode',   '1'],
  ];
  shippingApiSeeds.forEach(([k, v]) => {
    try {
      w._db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', ['store_001', k, v]);
      w._save();
    } catch(e) { console.warn('[DB] shipping api seed:', k, e.message); }
  });

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix23-A：Analytics Foundation（前台轉換事件基礎）───────
  // 原則：safe migration，只用 CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT
  // EXISTS，絕不 DROP / 重建既有資料表。全新獨立資料表，不影響既有報表系統、
  // POS、Android、LINE 外帶外送、冷藏宅配、LINE Pay、優惠券等既有功能。
  // 依專案慣例以 store_id 隔離；本表不含 tenant_id（專案沒有 tenant_id 概念）。
  // ══════════════════════════════════════════════════════════════════
  w._db.run(`CREATE TABLE IF NOT EXISTS analytics_events (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        TEXT NOT NULL,
    visitor_id      TEXT NOT NULL,
    session_id      TEXT NOT NULL,
    cart_id         TEXT,
    order_id        TEXT,
    event_name      TEXT NOT NULL,
    product_id      INTEGER,
    quantity        INTEGER DEFAULT 1,
    order_mode      TEXT,
    source          TEXT,
    medium          TEXT,
    campaign        TEXT,
    referrer        TEXT,
    landing_page    TEXT,
    fbclid          TEXT,
    gclid           TEXT,
    metadata_json   TEXT,
    created_at      TEXT DEFAULT (datetime('now'))
  )`);
  w._save();

  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_created ON analytics_events(store_id, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_event_created ON analytics_events(store_id, event_name, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_visitor ON analytics_events(store_id, visitor_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_session ON analytics_events(store_id, session_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_cart ON analytics_events(store_id, cart_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_product_created ON analytics_events(store_id, product_id, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_order_event ON analytics_events(store_id, order_id, event_name)');
    // fix18-10-hotfix23-D：廣告歸因查詢新增的索引（稽核既有索引後補上缺少的兩個，
    // 其餘 store_id+event_name+created_at／store_id+visitor_id／store_id+order_id 等
    // 既有索引已足夠涵蓋，未重複建立）
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_source_created ON analytics_events(store_id, source, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_campaign_created ON analytics_events(store_id, campaign, created_at)');
    // 防重複寫入 defense-in-depth：logServerEvent() 內已用同步查重擋下重複 purchase/
    // submit_order（Node 單執行緒、查重與寫入之間沒有 await，天然不會被其他請求插入），
    // 這裡再加一道 partial unique index 作保險，即使未來查重邏輯被繞過也不會產生髒資料。
    w._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_analytics_order_event_unique
      ON analytics_events(store_id, order_id, event_name)
      WHERE order_id IS NOT NULL AND event_name IN ('submit_order','purchase')`);
    w._save();
  } catch(e) { console.warn('[DB] analytics_events index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix24-A3：Identity Resolver × Channel × Page Type ─────
  // safe migration：只用 ALTER TABLE ADD COLUMN（PRAGMA 檢查後才補建，同一套
  // 慣例見上面 products 的 _preorderColDefs），絕不 DROP／重建 analytics_events，
  // 絕不新增資料表。舊資料列這些欄位一律是 NULL，讀取端一律當作
  // identity_type=null / order_channel='unknown' / page_type='unknown' 處理
  // （見 utils/analyticsLog.js insertEvent() 與 utils/channelResolver.js）。
  // ══════════════════════════════════════════════════════════════════
  const _analyticsIdentityColDefs = [
    ['identity_key',      'TEXT'],
    ['identity_type',     'TEXT'],
    ['is_estimated_identity', 'INTEGER'],
    ['order_channel',     'TEXT'],
    ['page_type',         'TEXT'],
  ];
  try {
    const _aeExistCols = w.all('PRAGMA table_info(analytics_events)').map(r => r.name);
    let _aeAdded = 0;
    for (const [col, def] of _analyticsIdentityColDefs) {
      if (!_aeExistCols.includes(col)) {
        try {
          w._db.run(`ALTER TABLE analytics_events ADD COLUMN ${col} ${def}`);
          w._save();
          _aeAdded++;
          console.log(`[DB] ✅ analytics_events 補建欄位: ${col}`);
        } catch (e2) {
          console.error(`[DB] ❌ analytics_events 補建失敗 ${col}:`, e2.message);
        }
      }
    }
    if (_aeAdded === 0) console.log('[DB] ✅ analytics_events identity/channel 欄位均已存在');
  } catch (e) {
    console.error('[DB] ❌ PRAGMA table_info(analytics_events) 失敗:', e.message);
  }
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_identity ON analytics_events(store_id, identity_key)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_channel_created ON analytics_events(store_id, order_channel, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_page_type ON analytics_events(store_id, page_type)');
    w._save();
  } catch(e) { console.warn('[DB] analytics_events identity/channel index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix30-B5-R5.1-A：Geo Intelligence — Geo Data Foundation ──
  // safe migration：同上一段 identity/channel 欄位的慣例——只用 PRAGMA
  // table_info 檢查後的 ALTER TABLE ADD COLUMN，絕不 DROP／重建
  // analytics_events，不新增平行的第二套事件系統。舊資料列這些欄位一律是
  // NULL，讀取端一律當作 geo_source='unknown' / geo_confidence='unknown' /
  // geo_resolution='unknown' 處理（見 utils/geoConstants.js UNKNOWN_GEO 與
  // utils/analyticsLog.js insertEvent()）。
  //
  // 決策記錄（十六、資料庫與索引 — 「metadata 擴充 vs 新增專用 dimension
  // table」）：本輪選擇在 analytics_events / orders 上直接擴充欄位，不建立
  // analytics_geo_dimensions 平行表。理由：(1) 這批欄位都是低基數字串
  // （縣市/區/來源/信心/距離帶），不是需要另外正規化的長文字或高頻寫入的
  // 巢狀結構；(2) 直接擴充可用既有的 (store_id, created_at) 系列索引查詢
  // 模式，不需額外 JOIN；(3) 完全比照 hotfix24-A3 identity/channel 欄位已
  // 驗證過的 safe-migration 慣例，回滾方式相同（欄位保留、忽略即可）。
  // 若未來查詢量證明需要專用表，可再評估、不影響本輪。
  // ══════════════════════════════════════════════════════════════════
  const _geoColDefs = [
    ['geo_country',       'TEXT'],
    ['geo_region',        'TEXT'],
    ['geo_city',          'TEXT'],
    ['geo_district',      'TEXT'],
    ['geo_postal_code',   'TEXT'],
    ['geo_source',        'TEXT'],
    ['geo_confidence',    'TEXT'],
    ['geo_resolution',    'TEXT'],
    ['geo_distance_km',   'REAL'],
    ['geo_distance_band', 'TEXT'],
    ['geo_delivery_zone', 'TEXT'],
  ];
  try {
    const _aeGeoExistCols = w.all('PRAGMA table_info(analytics_events)').map(r => r.name);
    let _aeGeoAdded = 0;
    for (const [col, def] of _geoColDefs) {
      if (!_aeGeoExistCols.includes(col)) {
        try {
          w._db.run(`ALTER TABLE analytics_events ADD COLUMN ${col} ${def}`);
          w._save();
          _aeGeoAdded++;
          console.log(`[DB] ✅ analytics_events 補建 Geo 欄位: ${col}`);
        } catch (e2) {
          console.error(`[DB] ❌ analytics_events Geo 欄位補建失敗 ${col}:`, e2.message);
        }
      }
    }
    if (_aeGeoAdded === 0) console.log('[DB] ✅ analytics_events Geo 欄位均已存在');
  } catch (e) {
    console.error('[DB] ❌ PRAGMA table_info(analytics_events) (geo) 失敗:', e.message);
  }
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_district_created ON analytics_events(store_id, geo_district, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_geosource_created ON analytics_events(store_id, geo_source, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_distanceband_created ON analytics_events(store_id, geo_distance_band, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] analytics_events geo index:', e.message); }

  // orders 表：履約區域（正式外送/宅配地址解析結果），與上面 analytics_events
  // 的 Visitor Geo 完全分開的欄位（避免二者混用），供 R5.1-B 履約區域分析／
  // 距離分析直接讀取，不必每次查詢重新解析地址字串。
  const _orderGeoColDefs = [
    ['fulfillment_geo_city',       'TEXT'],
    ['fulfillment_geo_district',   'TEXT'],
    ['fulfillment_geo_source',     'TEXT'],
    ['fulfillment_geo_confidence', 'TEXT'],
    ['fulfillment_geo_resolution', 'TEXT'],
    ['fulfillment_distance_band',  'TEXT'],
  ];
  try {
    const _ordersGeoExistCols = w.all('PRAGMA table_info(orders)').map(r => r.name);
    let _ordersGeoAdded = 0;
    for (const [col, def] of _orderGeoColDefs) {
      if (!_ordersGeoExistCols.includes(col)) {
        try {
          w._db.run(`ALTER TABLE orders ADD COLUMN ${col} ${def}`);
          w._save();
          _ordersGeoAdded++;
          console.log(`[DB] ✅ orders 補建 Geo 欄位: ${col}`);
        } catch (e2) {
          console.error(`[DB] ❌ orders Geo 欄位補建失敗 ${col}:`, e2.message);
        }
      }
    }
    if (_ordersGeoAdded === 0) console.log('[DB] ✅ orders Geo 欄位均已存在');
  } catch (e) {
    console.error('[DB] ❌ PRAGMA table_info(orders) (geo) 失敗:', e.message);
  }
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_orders_store_fulfillment_district ON orders(store_id, fulfillment_geo_district, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] orders fulfillment geo index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix30-B5-R5.1-B：Geo Event Wiring — Schema 補強 ──────
  // 向後相容加法修正，不 DROP／不重建／不刪除 R5.1-A 已建立的任何欄位
  // （見需求文件三）。新增：
  //   geo_context — 這筆 Geo 代表的用途（visitor/fulfillment/shipping/gps/
  //                 unknown），跟 geo_source（資料怎麼來）是不同維度。
  //   geo_version — Geo 解析邏輯版本號，供未來升級時分辨資料版本；
  //                 舊資料（R5.1-A 已寫入、沒有這個欄位時的資料）一律是
  //                 NULL，讀取端統一用 utils/geoConstants.js
  //                 normalizeGeoVersion() 視為版本 1，不強制回填。
  // ══════════════════════════════════════════════════════════════════
  const _geoContextColDefs = [
    ['geo_context', 'TEXT'],
    ['geo_version', 'INTEGER'],
  ];
  try {
    const _aeCtxExistCols = w.all('PRAGMA table_info(analytics_events)').map(r => r.name);
    let _aeCtxAdded = 0;
    for (const [col, def] of _geoContextColDefs) {
      if (!_aeCtxExistCols.includes(col)) {
        try {
          w._db.run(`ALTER TABLE analytics_events ADD COLUMN ${col} ${def}`);
          w._save();
          _aeCtxAdded++;
          console.log(`[DB] ✅ analytics_events 補建 Geo Context 欄位: ${col}`);
        } catch (e2) {
          console.error(`[DB] ❌ analytics_events Geo Context 欄位補建失敗 ${col}:`, e2.message);
        }
      }
    }
    if (_aeCtxAdded === 0) console.log('[DB] ✅ analytics_events Geo Context 欄位均已存在');
  } catch (e) {
    console.error('[DB] ❌ PRAGMA table_info(analytics_events) (geo context) 失敗:', e.message);
  }
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_geocontext_created ON analytics_events(store_id, geo_context, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] analytics_events geo_context index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix23-E：LINE 會員入口 × LIFF 登入 × 好友狀態綁定 ──────
  // 原則同 Hotfix23-A：safe migration，只用 CREATE TABLE IF NOT EXISTS /
  // CREATE INDEX IF NOT EXISTS，全新獨立資料表，不影響既有 POS / Android /
  // LINE 外帶外送 / 冷藏宅配 / LINE Pay / 優惠券 / Business Calendar。
  // 以 store_id 隔離；UNIQUE(store_id, line_user_id) 確保同一店家內
  // 同一 LINE 使用者只有一筆會員資料，不同店家可各自獨立存在同一 line_user_id。
  // ══════════════════════════════════════════════════════════════════
  w._db.run(`CREATE TABLE IF NOT EXISTS line_members (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        TEXT NOT NULL,
    line_user_id    TEXT NOT NULL,
    display_name    TEXT DEFAULT '',
    picture_url     TEXT DEFAULT '',
    is_friend       INTEGER DEFAULT NULL,
    first_seen_at   TEXT DEFAULT (datetime('now','localtime')),
    last_seen_at    TEXT DEFAULT (datetime('now','localtime')),
    first_order_at  TEXT DEFAULT '',
    last_order_at   TEXT DEFAULT '',
    order_count     INTEGER DEFAULT 0,
    total_spent     REAL DEFAULT 0,
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    updated_at      TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_line_members_store_user ON line_members(store_id, line_user_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_last_seen ON line_members(store_id, last_seen_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_last_order ON line_members(store_id, last_order_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_is_friend ON line_members(store_id, is_friend)');
    w._save();
  } catch(e) { console.warn('[DB] line_members index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix23-E（續）：LINE CRM Foundation × Customer Journey ──
  // 同樣是 safe migration：CREATE TABLE IF NOT EXISTS / ALTER TABLE 皆包在
  // try/catch，可重複執行、不 DROP、不影響既有資料。
  // ══════════════════════════════════════════════════════════════════
  const lineMemberCrmMigrations = [
    "ALTER TABLE line_members ADD COLUMN is_blocked INTEGER DEFAULT 0",
    "ALTER TABLE line_members ADD COLUMN friend_since TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_friend_check TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_login_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN first_touch_source TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN first_touch_campaign TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_touch_source TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_touch_campaign TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN first_product_id INTEGER DEFAULT NULL",
    "ALTER TABLE line_members ADD COLUMN first_cart_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN first_purchase_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_purchase_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN lifetime_value REAL DEFAULT 0",
    // fix18-10-hotfix26-F1（需求文件七）：好友狀態同步來源與「真正轉換時間」。
    // friend_source 只記錄「最後一次成功查到好友狀態」的來源（liff_friendship／
    // login_verify／checkout_recheck／manual_recheck／webhook_follow／
    // webhook_unfollow／unknown），friend_status_changed_at 只在 is_friend 真的
    // 從 true↔false 轉換時才更新（狀態不變時只更新 last_friend_check，不動這欄）。
    "ALTER TABLE line_members ADD COLUMN friend_source TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN friend_status_changed_at TEXT DEFAULT ''",
  ];
  lineMemberCrmMigrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ══════════════════════════════════════════════════════════════════
  // ── fix18-10-hotfix26-F8（需求文件八～二十一）：好友 webhook 即時同步 ×
  //    CRM 封存/恢復 × 手動新增 × CSV 匯入 的資料表基礎。
  // 原則不變：safe migration，只用 CREATE TABLE IF NOT EXISTS / ALTER TABLE
  // ADD COLUMN（皆包 try/catch，可重複執行），不 DROP、不影響既有資料，
  // 舊欄位（is_friend／friend_since／last_friend_check／friend_source／
  // friend_status_changed_at）全部保留並持續同步寫入，向下相容。
  // ══════════════════════════════════════════════════════════════════
  const lineMemberF8Migrations = [
    // 好友狀態摘要欄位（新增，與舊 is_friend 並存同步）
    "ALTER TABLE line_members ADD COLUMN friend_status TEXT DEFAULT 'unknown'",
    "ALTER TABLE line_members ADD COLUMN last_friend_check_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_friend_source TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN first_follow_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_follow_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_unfollow_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN last_refollow_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN refollow_count INTEGER DEFAULT 0",
    // CRM 封存／恢復（需求文件十九／二十）
    "ALTER TABLE line_members ADD COLUMN crm_status TEXT DEFAULT 'active'",
    "ALTER TABLE line_members ADD COLUMN archived_at TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN archived_reason TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN archived_by TEXT DEFAULT ''",
    // 手動新增 / CSV 匯入未綁定會員（需求文件二十二～二十七）
    "ALTER TABLE line_members ADD COLUMN phone TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN email TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN note TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN tags TEXT DEFAULT ''",
    "ALTER TABLE line_members ADD COLUMN member_source TEXT DEFAULT 'line_login'",
    "ALTER TABLE line_members ADD COLUMN merged_into_id INTEGER DEFAULT NULL",
    // 永久刪除個資（需求文件二十一）
    "ALTER TABLE line_members ADD COLUMN pii_deleted_at TEXT DEFAULT ''",
  ];
  lineMemberF8Migrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_friend_status ON line_members(store_id, friend_status)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_crm_status ON line_members(store_id, crm_status)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_line_members_store_phone ON line_members(store_id, phone)');
    w._save();
  } catch(e) { console.warn('[DB] line_members F8 index:', e.message); }

  // ── line_friend_events：好友事件流水帳（需求文件十一）。append-only，
  //    任何後續狀態更新都「不可覆蓋」已寫入的歷史事件列。────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS line_friend_events (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    line_user_id  TEXT NOT NULL,
    member_id     INTEGER DEFAULT NULL,
    event_type    TEXT NOT NULL,
    source        TEXT DEFAULT '',
    event_at      TEXT DEFAULT (datetime('now','localtime')),
    metadata_json TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lfe_store_user ON line_friend_events(store_id, line_user_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lfe_store_event_at ON line_friend_events(store_id, event_at)');
    w._save();
  } catch(e) { console.warn('[DB] line_friend_events index:', e.message); }

  // ── line_cart_handoff_tokens：Messenger →「到 LINE 完成結帳」一次性 cart token
  //    （需求文件五／六）。與 store_id 綁定，過期／已使用皆可查。────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS line_cart_handoff_tokens (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    token           TEXT NOT NULL UNIQUE,
    store_id        TEXT NOT NULL,
    cart_json       TEXT DEFAULT '',
    subtotal        REAL DEFAULT 0,
    delivery_mode   TEXT DEFAULT '',
    attribution_json TEXT DEFAULT '',
    line_user_id    TEXT DEFAULT '',
    used_at         TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    expires_at      TEXT NOT NULL
  )`);
  w._save();
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lcht_store_token ON line_cart_handoff_tokens(store_id, token)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lcht_expires ON line_cart_handoff_tokens(expires_at)');
    w._save();
  } catch(e) { console.warn('[DB] line_cart_handoff_tokens index:', e.message); }

  // ── fix18-10-hotfix26-F8-B（需求文件四）：Cart Token 狀態機 × 短碼 × Checkout
  //    Context × 消費紀錄。safe migration，沿用 F8-A 已建立的資料表，只 ADD COLUMN。
  const cartHandoffF8BMigrations = [
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN cart_code TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN status TEXT DEFAULT 'pending'",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN checkout_context_json TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN consumed_at TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN order_id TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN created_ip TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN created_user_agent TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN bound_at TEXT DEFAULT ''",
    "ALTER TABLE line_cart_handoff_tokens ADD COLUMN opened_at TEXT DEFAULT ''",
  ];
  cartHandoffF8BMigrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lcht_store_code ON line_cart_handoff_tokens(store_id, cart_code)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lcht_store_status ON line_cart_handoff_tokens(store_id, status)');
    w._save();
  } catch(e) { console.warn('[DB] line_cart_handoff_tokens F8-B index:', e.message); }

  // ── line_member_history：CRM Timeline（好友歷程／購買歷程等事件流水帳）───
  w._db.run(`CREATE TABLE IF NOT EXISTS line_member_history (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    line_user_id  TEXT NOT NULL,
    event_name    TEXT NOT NULL,
    old_value     TEXT DEFAULT '',
    new_value     TEXT DEFAULT '',
    metadata_json TEXT DEFAULT '',
    created_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_history_store ON line_member_history(store_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_history_store_user ON line_member_history(store_id, line_user_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_history_store_event ON line_member_history(store_id, event_name)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_history_store_created ON line_member_history(store_id, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] line_member_history index:', e.message); }

  // ── line_member_sessions：把匿名 Analytics 流程（visitor_id/session_id/cart_id）
  //    與登入後的 line_user_id 串接，供 Customer Journey 使用 ─────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS line_member_sessions (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    line_user_id  TEXT NOT NULL,
    visitor_id    TEXT DEFAULT '',
    session_id    TEXT DEFAULT '',
    cart_id       TEXT DEFAULT '',
    first_seen_at TEXT DEFAULT (datetime('now','localtime')),
    last_seen_at  TEXT DEFAULT (datetime('now','localtime')),
    created_at    TEXT DEFAULT (datetime('now','localtime')),
    updated_at    TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lm_sessions_unique ON line_member_sessions(store_id, line_user_id, visitor_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_sessions_store_user ON line_member_sessions(store_id, line_user_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_sessions_store_visitor ON line_member_sessions(store_id, visitor_id)');
    w._save();
  } catch(e) { console.warn('[DB] line_member_sessions index:', e.message); }

  // ── line_member_order_links：訂單成交 (purchase) 與會員消費累加的防重複表 ──
  // UNIQUE(store_id, order_id) — 同一張訂單只能觸發一次首購/回購累加，即使
  // logServerEvent 的 purchase 查重被繞過，這裡仍是最後一道保險。
  w._db.run(`CREATE TABLE IF NOT EXISTS line_member_order_links (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    order_id     TEXT NOT NULL,
    created_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lm_order_links_unique ON line_member_order_links(store_id, order_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_lm_order_links_store_user ON line_member_order_links(store_id, line_user_id)');
    w._save();
  } catch(e) { console.warn('[DB] line_member_order_links index:', e.message); }

  // ── fix18-10-hotfix26-F4：訂單「取餐門市 / 取餐地址」快照 ──────────────
  // 目的：訂單建立當下把門市名稱／取餐地址／座標寫死存進訂單本身，避免日後
  // 店家修改地址設定後，舊訂單的完成頁／查詢訂單／我的訂單跟著顯示錯誤地址。
  // 沿用既有「try/catch ALTER TABLE」safe migration 慣例：可重複執行、不破壞
  // 舊資料、舊訂單允許為 NULL（顯示時由 utils/pickupLocation.js fallback 處理）。
  // 只新增欄位，不重建 orders 表、不新增新資料表。
  const pickupSnapshotMigrations = [
    'ALTER TABLE orders ADD COLUMN pickup_store_name_snapshot TEXT DEFAULT NULL',
    'ALTER TABLE orders ADD COLUMN pickup_address_snapshot TEXT DEFAULT NULL',
    'ALTER TABLE orders ADD COLUMN pickup_lat_snapshot TEXT DEFAULT NULL',
    'ALTER TABLE orders ADD COLUMN pickup_lng_snapshot TEXT DEFAULT NULL',
    // fix18-10-hotfix26-F5：取餐說明快照（獨立取餐地址時的補充說明，例如「請從騎樓
    // 入口取餐」）。只在外帶訂單建立當下由後端從 settings 寫入，不信任前端傳入。
    'ALTER TABLE orders ADD COLUMN pickup_address_note_snapshot TEXT DEFAULT NULL',
    // fix18-10-hotfix26-F7：取餐商家名稱／Google Place ID 快照。搜尋到明確商家後
    // 「使用此座標」自動填入的商家名稱/Place ID，跟著訂單一起凍結，讓導航能優先用
    // Place ID（比純座標準確）。外送/宅配訂單維持 NULL。
    'ALTER TABLE orders ADD COLUMN pickup_place_name_snapshot TEXT DEFAULT NULL',
    'ALTER TABLE orders ADD COLUMN pickup_place_id_snapshot TEXT DEFAULT NULL',
  ];
  pickupSnapshotMigrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ── line_member_tags：本版只預留 schema，不做自動標籤／推播／AI 分群 ──────
  w._db.run(`CREATE TABLE IF NOT EXISTS line_member_tags (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id     TEXT NOT NULL,
    line_user_id TEXT NOT NULL,
    tag_code     TEXT NOT NULL,
    tag_name     TEXT DEFAULT '',
    created_at   TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_lm_tags_unique ON line_member_tags(store_id, line_user_id, tag_code)');
    w._save();
  } catch(e) { console.warn('[DB] line_member_tags index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix30-B5-R5｜Cart Detail × Accurate Cart Snapshot × Order Hour Analysis
  //
  // 只新增索引（CREATE INDEX IF NOT EXISTS），不新增資料表、不修改任何既有欄位：
  //   - orders(store_id, created_at)：目前完全沒有這個索引（稽核發現，見
  //     CHANGELOG_HOTFIX30_B5_R5_CART_DETAIL_ORDER_HOURS.md），訂單時段分析／
  //     KPI／Funnel 等所有依日期區間查 orders 表的既有功能都會受益，不是本版
  //     新建立的查詢模式。
  //   - analytics_events(store_id, cart_id, created_at)：既有索引只有
  //     (store_id, cart_id)，這裡補上 created_at 讓「找出某購物車最後一筆
  //     cart_updated 快照」「候選購物車最後活動時間」等查詢可以吃到索引。
  // ══════════════════════════════════════════════════════════════════
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_orders_store_created ON orders(store_id, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_analytics_store_cart_created ON analytics_events(store_id, cart_id, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] hotfix30-B5-R5 index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix31-R1｜CRM Action Center × Operation Analytics Drill Down
  // （Backend Foundation：資料庫 schema + 讀取 API 基礎）
  //
  // 原則同前面所有 Analytics/CRM 擴充：safe migration，只用
  // CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS，全新獨立資料表，
  // 不 DROP、不修改既有 analytics_events／line_members／coupons 等任何既有
  // 欄位或資料，不建立第二套 Analytics/CRM 系統——這四張表只是「篩選條件的
  // 儲存」與「執行動作的紀錄」，實際的訪客/會員/購物車資料仍然全部讀自既有
  // analytics_events／line_members（見 utils/drilldown.js、utils/visitor360.js）。
  //
  // - crm_segments：儲存「分群」定義。segment_type='dynamic' 時 filter_json
  //   是即時篩選條件（每次讀取都重新查詢 analytics_events/line_members，
  //   人數會隨資料變動而變動）；segment_type='static' 時建立當下就把符合條件
  //   的名單快照進 crm_segment_members，之後不再變動（除非重新建立）。
  // - crm_segment_members：static 分群的快照名單。member_key 依 member_type
  //   可能是 line_user_id 或 visitor_id（因為並非所有訪客都有 LINE 身分）。
  // - crm_actions：CRM 執行動作的紀錄（發送優惠券／LINE 推播／建立再行銷名單）。
  //   本版（Backend Foundation）尚未串接 LINE Messaging API 推播與 Meta CAPI／
  //   GA4 Audience／LINE OA Segment 匯出（專案目前完全沒有 LINE Channel Access
  //   Token 設定與推播基礎設施，屬全新第三方整合，不在本版範圍），因此
  //   action_type='line_push' / 'retargeting_export' 建立後 status 固定回傳
  //   'not_configured'，明確告知尚未串接，不假裝已送出。action_type=
  //   'coupon_grant' 沿用既有 coupons 表驗證優惠券是否存在/啟用，可以真實記錄
  //   「這個名單預計核發哪張優惠券」，但實際派送（LINE 推播/簡訊/email）
  //   同樣需要等對應管道串接後才能真正送達，本版誠實記錄為 'recorded'。
  // - crm_action_targets：每個 action 底下每一位名單成員的個別狀態，供後續
  //   接上真實推播/發送管道時，可以逐一更新每個人的成功/失敗狀態，不需要
  //   重新設計資料表。
  // ══════════════════════════════════════════════════════════════════
  w._db.run(`CREATE TABLE IF NOT EXISTS crm_segments (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id            TEXT NOT NULL,
    name                TEXT NOT NULL,
    description         TEXT DEFAULT '',
    segment_type        TEXT NOT NULL DEFAULT 'dynamic',
    filter_json         TEXT NOT NULL DEFAULT '{}',
    member_count_cache  INTEGER DEFAULT 0,
    cache_updated_at    TEXT DEFAULT '',
    created_by          TEXT DEFAULT '',
    created_at          TEXT DEFAULT (datetime('now','localtime')),
    updated_at          TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_segments_store ON crm_segments(store_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_segments_store_created ON crm_segments(store_id, created_at)');
    w._save();
  } catch(e) { console.warn('[DB] crm_segments index:', e.message); }

  w._db.run(`CREATE TABLE IF NOT EXISTS crm_segment_members (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    segment_id    INTEGER NOT NULL,
    member_key    TEXT NOT NULL,
    member_type   TEXT NOT NULL,
    display_name  TEXT DEFAULT '',
    snapshot_json TEXT DEFAULT '',
    added_at      TEXT DEFAULT (datetime('now','localtime'))
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_segment_members_unique ON crm_segment_members(store_id, segment_id, member_key)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_segment_members_store_segment ON crm_segment_members(store_id, segment_id)');
    w._save();
  } catch(e) { console.warn('[DB] crm_segment_members index:', e.message); }

  w._db.run(`CREATE TABLE IF NOT EXISTS crm_actions (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id        TEXT NOT NULL,
    action_type     TEXT NOT NULL,
    name            TEXT DEFAULT '',
    segment_id      INTEGER DEFAULT NULL,
    payload_json    TEXT DEFAULT '{}',
    status          TEXT NOT NULL DEFAULT 'pending',
    target_count    INTEGER DEFAULT 0,
    success_count   INTEGER DEFAULT 0,
    fail_count      INTEGER DEFAULT 0,
    result_message  TEXT DEFAULT '',
    created_by      TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now','localtime')),
    started_at      TEXT DEFAULT '',
    completed_at    TEXT DEFAULT ''
  )`);
  w._save();
  try {
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_actions_store_created ON crm_actions(store_id, created_at)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_actions_store_segment ON crm_actions(store_id, segment_id)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_actions_store_status ON crm_actions(store_id, status)');
    w._save();
  } catch(e) { console.warn('[DB] crm_actions index:', e.message); }

  w._db.run(`CREATE TABLE IF NOT EXISTS crm_action_targets (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id      TEXT NOT NULL,
    action_id     INTEGER NOT NULL,
    member_key    TEXT NOT NULL,
    member_type   TEXT NOT NULL,
    status        TEXT NOT NULL DEFAULT 'pending',
    error         TEXT DEFAULT '',
    sent_at       TEXT DEFAULT ''
  )`);
  w._save();
  try {
    w._db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_action_targets_unique ON crm_action_targets(store_id, action_id, member_key)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_action_targets_store_action ON crm_action_targets(store_id, action_id)');
    w._save();
  } catch(e) { console.warn('[DB] crm_action_targets index:', e.message); }

  // ══════════════════════════════════════════════════════════════════
  // fix18-10-hotfix31-R2｜CRM Action 生命週期硬化（Architecture Correction）
  //
  // 需求文件 C／F／G／H／L：
  //   - segment 需要 enabled/archived 狀態（軟刪除，不得真的 DELETE 掉歷史分群）。
  //   - action 需要 idempotency_key（同一個 key 重複呼叫 POST /actions 不得
  //     建立第二筆動作，見 routes/crm.js）、cancelled_at、error_code、
  //     skipped_count（獨立於 fail_count，區分「執行失敗」與「不符資格被跳過」）。
  //   - target 需要 dedup_key（同一位會員在不同 action 之間是否已經拿過同一張
  //     優惠券的判斷依據，見 utils/crmActions.js）、error_code、updated_at
  //     （retry 需要知道哪些 target 是「這次」被更新的）。
  //
  // 全部只用 ALTER TABLE ADD COLUMN（try/catch，可重複執行、不破壞既有資料），
  // 不 DROP、不重建任何一張表。
  // ══════════════════════════════════════════════════════════════════
  const crmR2Migrations = [
    "ALTER TABLE crm_segments ADD COLUMN enabled INTEGER DEFAULT 1",
    "ALTER TABLE crm_actions ADD COLUMN idempotency_key TEXT DEFAULT ''",
    "ALTER TABLE crm_actions ADD COLUMN cancelled_at TEXT DEFAULT ''",
    "ALTER TABLE crm_actions ADD COLUMN error_code TEXT DEFAULT ''",
    "ALTER TABLE crm_actions ADD COLUMN skipped_count INTEGER DEFAULT 0",
    "ALTER TABLE crm_action_targets ADD COLUMN dedup_key TEXT DEFAULT ''",
    "ALTER TABLE crm_action_targets ADD COLUMN error_code TEXT DEFAULT ''",
    "ALTER TABLE crm_action_targets ADD COLUMN updated_at TEXT DEFAULT ''",
  ];
  crmR2Migrations.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });
  try {
    // 需求文件 L：store_id + status／store_id + action_type／store_id + idempotency_key／
    // store_id + target identity 等常用查詢組合的索引。
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_actions_store_type ON crm_actions(store_id, action_type)');
    // idempotency_key 只在非空字串時要求唯一（同店家內），沿用既有 partial unique index
    // 慣例（見上面 idx_analytics_order_event_unique）。
    w._db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_crm_actions_store_idempotency
      ON crm_actions(store_id, idempotency_key) WHERE idempotency_key != ''`);
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_action_targets_store_member_dedup ON crm_action_targets(store_id, member_key, dedup_key, status)');
    w._db.run('CREATE INDEX IF NOT EXISTS idx_crm_segments_store_enabled ON crm_segments(store_id, enabled)');
    w._save();
  } catch(e) { console.warn('[DB] crm R2 hardening index:', e.message); }
}

module.exports = { getDb, initDb };

// Note: migration_logs table is created on-demand in routes/migration.js
// to keep backward compatibility with existing DB instances.
