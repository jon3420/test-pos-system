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
  ];
  prodMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

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

  // ── settings ──────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS settings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(store_id, key)
  )`);
  // 嘗試從舊格式 migrate
  try {
    const oldSettings = w.all('SELECT key, value FROM settings WHERE store_id IS NULL');
    oldSettings.forEach(row => {
      try {
        w._db.run('INSERT OR IGNORE INTO settings (store_id, key, value) VALUES (?,?,?)',
          ['store_001', row.key, row.value]);
      } catch {}
    });
    w._save();
  } catch {}
  try { w._db.run('ALTER TABLE settings ADD COLUMN store_id TEXT NOT NULL DEFAULT \'store_001\''); w._save(); } catch {}
  try { w._db.run(`UPDATE settings SET store_id='store_001' WHERE store_id IS NULL OR store_id=''`); w._save(); } catch {}

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

  const pmCount = w.get("SELECT COUNT(*) as c FROM payment_methods WHERE store_id='store_001'");
  if (!pmCount || Number(pmCount.c) === 0) {
    const methods = [
      ['現金','cash','💵',1,1,1,1,1,1,1,''],
      ['刷卡','card','💳',1,2,0,1,1,0,1,''],
      ['LINE Pay','linepay','💚',1,3,0,1,1,1,1,'linepay'],
      ['街口支付','jkopay','🟠',0,4,0,1,1,1,1,'jkopay'],
      ['轉帳','transfer','🏦',1,5,0,0,1,1,1,''],
      ['平台付款','platform','📱',1,6,0,0,0,1,1,''],
    ];
    methods.forEach(([name,code,icon,active,sort,isdef,dine,take,deliv,allow,gw]) =>
      w._db.run(
        'INSERT INTO payment_methods (store_id,name,code,icon,is_active,sort_order,is_default,enable_for_dine_in,enable_for_takeout,enable_for_delivery,allow_edit_when_platform_order,gateway_code) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
        ['store_001',name,code,icon,active,sort,isdef,dine,take,deliv,allow,gw]
      )
    );
    w._save();
  }

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

  const gwCount = w.get("SELECT COUNT(*) as c FROM payment_gateways WHERE store_id='store_001'");
  if (!gwCount || Number(gwCount.c) === 0) {
    [['LINE Pay','linepay'],['綠界 ECPay','ecpay'],['藍新 NewebPay','newebpay'],
     ['街口支付','jkopay'],['全支付','pxpay'],['Apple Pay','applepay'],
     ['Google Pay','googlepay'],['信用卡刷卡機','creditcard_terminal']
    ].forEach(([name,code]) => w._db.run('INSERT INTO payment_gateways (store_id,name,code) VALUES (?,?,?)',['store_001',name,code]));
    w._save();
  }

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
  const sd = (storeId, k, v) => {
    if (!w.get('SELECT id FROM settings WHERE store_id=? AND key=?', [storeId, k]))
      w._db.run('INSERT INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, k, v]);
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
  w._save();

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
    const PRO_FEATURES = JSON.stringify({
      order: true, orders: true, products: true, reports: true, print: true,
      inventory: true, line_order: true, delivery: true,
      marketing: false, member: false, coupon: false, label_print: true
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
}

module.exports = { getDb, initDb };
