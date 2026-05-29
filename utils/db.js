// utils/db.js - SQLite (純 JS 版本，使用 sql.js) — v16 整合版
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
      // ★ 必須在 stmt.free() 之前、任何其他 SQL 之前取得 getRowsModified()
      // 因為 sqlDb.exec('SELECT ...') 會重置 getRowsModified 計數
      const changes = sqlDb.getRowsModified ? sqlDb.getRowsModified() : 0;
      stmt.free();
      // 取 lastInsertRowid（只對 INSERT 有意義，UPDATE 維持原 id）
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
  // ── products ──────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
    // v16 整合新增
    'ALTER TABLE products ADD COLUMN line_category_id INTEGER DEFAULT 0',
    'ALTER TABLE products ADD COLUMN product_barcode TEXT DEFAULT ""',
  ];
  prodMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

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
    name TEXT NOT NULL UNIQUE,
    icon TEXT DEFAULT '📌',
    sort_order INTEGER DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── inventory_logs ────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS inventory_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER, product_name TEXT,
    action TEXT, before_grams REAL DEFAULT 0,
    change_grams REAL DEFAULT 0, after_grams REAL DEFAULT 0,
    before_units INTEGER DEFAULT 0, after_units INTEGER DEFAULT 0,
    reason TEXT DEFAULT '', operator TEXT DEFAULT 'staff',
    order_id TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── ingredients（食材主表）────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS ingredients (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    name               TEXT NOT NULL UNIQUE,
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

  // ── ingredients migration（低庫存警戒值）───────────────
  const ingMig = [
    'ALTER TABLE ingredients ADD COLUMN low_stock_threshold REAL DEFAULT 0',
    "ALTER TABLE ingredients ADD COLUMN operator TEXT DEFAULT ''",
  ];
  ingMig.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ── ingredient_thaw_batches（解凍批次管理）──────────────
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

  // ── new ingredient columns migration ──────────────────
  const ingMig2 = [
    'ALTER TABLE ingredients ADD COLUMN default_thaw_hours REAL DEFAULT 0',
  ];
  ingMig2.forEach(sql => { try { w._db.run(sql); w._save(); } catch {} });

  // ── orders ────────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY, order_number TEXT NOT NULL,
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

  // ── payment_category 資料補全 migration ──────────────
  // 對所有 payment_category 為空的舊訂單，依 payment_method 推算並填入
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

  // ── order_logs ────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS order_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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

  // ── customers ─────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT DEFAULT '',
    phone TEXT UNIQUE, line_id TEXT DEFAULT '',
    total_spent REAL DEFAULT 0, visit_count INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── settings ──────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);

  // ── payment_methods ───────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS payment_methods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, code TEXT NOT NULL UNIQUE, icon TEXT DEFAULT '',
    is_active INTEGER DEFAULT 1, sort_order INTEGER DEFAULT 0, is_default INTEGER DEFAULT 0,
    enable_for_dine_in INTEGER DEFAULT 1, enable_for_takeout INTEGER DEFAULT 1,
    enable_for_delivery INTEGER DEFAULT 1, allow_edit_when_platform_order INTEGER DEFAULT 1,
    gateway_code TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const pmCount = w.get('SELECT COUNT(*) as c FROM payment_methods');
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
        'INSERT INTO payment_methods (name,code,icon,is_active,sort_order,is_default,enable_for_dine_in,enable_for_takeout,enable_for_delivery,allow_edit_when_platform_order,gateway_code) VALUES (?,?,?,?,?,?,?,?,?,?,?)',
        [name,code,icon,active,sort,isdef,dine,take,deliv,allow,gw]
      )
    );
    w._save();
  }

  // ── payment_gateways ──────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS payment_gateways (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL, code TEXT NOT NULL UNIQUE,
    is_active INTEGER DEFAULT 0, mode TEXT DEFAULT 'test',
    api_key TEXT DEFAULT '', secret_key TEXT DEFAULT '',
    merchant_id TEXT DEFAULT '', webhook_url TEXT DEFAULT '',
    callback_url TEXT DEFAULT '', extra_config TEXT DEFAULT '{}',
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const gwCount = w.get('SELECT COUNT(*) as c FROM payment_gateways');
  if (!gwCount || Number(gwCount.c) === 0) {
    [['LINE Pay','linepay'],['綠界 ECPay','ecpay'],['藍新 NewebPay','newebpay'],
     ['街口支付','jkopay'],['全支付','pxpay'],['Apple Pay','applepay'],
     ['Google Pay','googlepay'],['信用卡刷卡機','creditcard_terminal']
    ].forEach(([name,code]) => w._db.run('INSERT INTO payment_gateways (name,code) VALUES (?,?)',[name,code]));
    w._save();
  }

  // ── devices ───────────────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT UNIQUE NOT NULL,
    device_name TEXT DEFAULT '',
    device_role TEXT DEFAULT 'POS',
    last_seen_at TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now','localtime'))
  )`);

  // ── delivery_platforms ────────────────────────────────
  w._db.run(`CREATE TABLE IF NOT EXISTS delivery_platforms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    commission_rate REAL DEFAULT 0,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now','localtime')),
    updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  const platCount = w.get('SELECT COUNT(*) as c FROM delivery_platforms');
  if (!platCount || Number(platCount.c) === 0) {
    const platforms = [
      ['Uber Eats', 30], ['Foodpanda', 35], ['電話訂單', 0],
      ['LINE訂單', 0], ['自送', 0], ['Lalamove', 0]
    ];
    platforms.forEach(([name, rate]) =>
      w._db.run('INSERT INTO delivery_platforms (name,commission_rate) VALUES (?,?)', [name, rate])
    );
    w._save();
  }

  // ── Seed categories ────────────────────────────────────
  const catCount = w.get('SELECT COUNT(*) as c FROM categories');
  if (!catCount || Number(catCount.c) === 0) {
    [['主食','🍚',1],['小菜','🥗',2],['飲料','🧋',3]].forEach(([name,icon,sort]) =>
      w._db.run('INSERT INTO categories (name,icon,sort_order,is_active) VALUES (?,?,?,1)', [name,icon,sort])
    );
    w._save();
  }

  // ── Seed products ─────────────────────────────────────
  const count = w.get('SELECT COUNT(*) as c FROM products');
  if (!count || Number(count.c) === 0) {
    // 取剛建立的分類 id
    const catIdMap = {};
    w.all('SELECT id,name FROM categories').forEach(c => { catIdMap[c.name] = c.id; });
    const items = [
      ['冷拌麻油腰子','主食',150,1],['滷肉飯','主食',60,2],['排骨飯','主食',120,3],
      ['雞腿便當','主食',130,4],['燙青菜','小菜',30,5],['滷蛋','小菜',20,6],
      ['豆腐','小菜',35,7],['紅燒豆腐','小菜',45,8],['珍珠奶茶','飲料',50,9],
      ['紅茶','飲料',25,10],['綠茶','飲料',25,11],['冬瓜茶','飲料',30,12],
    ];
    items.forEach(([n,c,p,o]) => {
      const cid = catIdMap[c] || 0;
      w._db.run(
        'INSERT INTO products (name,category,category_id,price,sort_order) VALUES (?,?,?,?,?)', [n,c,cid,p,o]
      );
    });
  }

  // ── Settings defaults ─────────────────────────────────
  const sd = (k,v) => { if (!w.get('SELECT key FROM settings WHERE key=?',[k])) w._db.run('INSERT INTO settings (key,value) VALUES (?,?)',[k,v]); };
  sd('shop_name','阿義餐車'); sd('n8n_webhook_url',''); sd('line_channel_token','');
  sd('tax_rate','0'); sd('receipt_footer','感謝您的光臨！歡迎再次惠顧');
  sd('printer_enabled','0'); sd('printer_type','network');
  sd('printer_ip','192.168.1.100'); sd('printer_port','9100');
  sd('auto_print','0'); sd('auto_drawer','0');
  // LINE 點餐設定
  sd('shop_logo',''); sd('shop_cover',''); sd('shop_address','');
  sd('shop_google_map',''); sd('shop_hours',''); sd('shop_announcement','');
  sd('line_order_enabled','1'); sd('line_order_min_amount','0');
  sd('n8n_new_order_webhook',''); sd('n8n_status_change_webhook','');
  // v16 整合新增
  sd('line_ordering_enabled','1');
  sd('line_business_hours_enabled','0');
  sd('line_business_hours', JSON.stringify({
    mon:{open:'09:00',close:'21:00',enabled:true},
    tue:{open:'09:00',close:'21:00',enabled:true},
    wed:{open:'09:00',close:'21:00',enabled:true},
    thu:{open:'09:00',close:'21:00',enabled:true},
    fri:{open:'09:00',close:'21:00',enabled:true},
    sat:{open:'09:00',close:'21:00',enabled:true},
    sun:{open:'09:00',close:'21:00',enabled:false},
  }));
  sd('pickup_enabled','1');
  sd('delivery_enabled','1');
  sd('pickup_business_hours_enabled','0');
  sd('delivery_business_hours_enabled','0');
  sd('line_today_closed','0');
  sd('line_today_closed_date','');
  // LINE 預約設定
  sd('same_day_preorder_minutes','30');
  sd('next_day_preorder_hours','2');
  sd('line_closed_weekdays','[]');
  sd('line_closed_dates','[]');
  // LINE 付款方式開關
  sd('line_payment_cash_enabled','1');
  sd('line_payment_linepay_enabled','1');
  sd('line_payment_transfer_enabled','1');
  sd('line_payment_platform_enabled','0');
  sd('line_payment_credit_card_enabled','0');
  w._save();
}

module.exports = { getDb, initDb };
