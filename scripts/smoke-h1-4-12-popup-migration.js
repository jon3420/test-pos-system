#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-migration.js
// H1.4.12 Phase 1.2｜快閃取餐排程中心 — migration 真實暫存 DB 測試（再修正版）。
//
// Phase 1.2 修正重點（對應 H1.4.12_PHASE1_2_CORRECTION_REPORT.md）：
//   1. TEXT→INTEGER 轉換 preflight：canonical 正整數字串判斷（拒絕空白/正負號/
//      小數/前導零/超出安全整數範圍）+ 轉型後在對應唯一鍵範圍內的碰撞檢查。
//   2. 單表重建具備原子性：BEGIN → 建新表 → 搬資料 → 驗證筆數與逐列資料 →
//      DROP 舊表 → RENAME → 建索引 → 驗證 schema → COMMIT，COMMIT 成功後才
//      _save()；任一步驟失敗 ROLLBACK，磁碟檔案完全不變。
//   3. Index 精確定義驗證（PRAGMA index_list / index_info）：table、UNIQUE、
//      欄位數量、順序、名稱，不只看名稱是否存在；同名但定義錯誤的 index 會
//      被安全 DROP + 重建（重建前一樣要做重複資料檢查）。
//   4. 補回 Phase 1 的重要覆蓋（store 隔離／各種重複值拒絕／跨重啟資料完整
//      保留／多店 backfill），不是用新測試「取代」舊測試，是疊加。
//   5. 新增 Scenario F（轉型碰撞：'1' vs '01'）與 Scenario G（假同名 index）。
//
// 不使用 regex 搜尋檔案文字；全部透過真實 utils/db.js + sql.js 對暫存資料庫執行。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const initSqlJsRaw = require('sql.js');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 1.2 popup pickup migration (TZ=${process.env.TZ || '(system default)'})`);
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

const expectedTables = [
  'popup_campaigns', 'popup_locations', 'popup_sessions',
  'popup_session_products', 'popup_order_allocations', 'popup_session_change_logs',
];
const expectedOrderCols = [
  'pickup_type', 'popup_campaign_id', 'popup_session_id',
  'popup_campaign_name_snapshot', 'popup_session_name_snapshot',
  'popup_session_public_code_snapshot', 'popup_pickup_date_snapshot',
  'popup_pickup_start_time_snapshot', 'popup_pickup_end_time_snapshot',
];

function freshDbModule() {
  const dbModulePath = require.resolve('../utils/db');
  delete require.cache[dbModulePath];
  return require(dbModulePath);
}

function newTmpDbPath(label) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `h1412-${label}-`));
  return { tmpDir, dbPath: path.join(tmpDir, 'test.db') };
}

function getIndexDef(db, table, indexName) {
  const list = db.all(`PRAGMA index_list(${table})`);
  const found = list.find((r) => r.name === indexName);
  if (!found) return null;
  const info = db.all(`PRAGMA index_info(${indexName})`).slice().sort((a, b) => a.seqno - b.seqno);
  return { unique: Number(found.unique) === 1, columns: info.map((r) => r.name) };
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO A: 全新安裝 —— INTEGER product_id、精確唯一索引、store 隔離、
// 各種重複值拒絕、冪等釋放、3 次重啟資料完整保留（不只驗證表存在）。
// ══════════════════════════════════════════════════════════════════════
async function scenarioA_freshInstall() {
  const { tmpDir, dbPath } = newTmpDbPath('fresh');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();

  const tableNames = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  expectedTables.forEach((t) => assert(tableNames.has(t), `A1-table ${t} 全新安裝即建立`));

  const orderCols = db.all('PRAGMA table_info(orders)').map((c) => c.name);
  expectedOrderCols.forEach((c) => assert(orderCols.includes(c), `A2-column orders.${c} 全新安裝即建立`));

  const spProductIdType = db.all('PRAGMA table_info(popup_session_products)').find((c) => c.name === 'product_id');
  assert(spProductIdType && String(spProductIdType.type).toUpperCase() === 'INTEGER', 'A3-type popup_session_products.product_id 為 INTEGER', JSON.stringify(spProductIdType));
  const allocProductIdType = db.all('PRAGMA table_info(popup_order_allocations)').find((c) => c.name === 'product_id');
  assert(allocProductIdType && String(allocProductIdType.type).toUpperCase() === 'INTEGER', 'A3-type popup_order_allocations.product_id 為 INTEGER', JSON.stringify(allocProductIdType));

  // A4: 精確 index 定義驗證（table/unique/欄位順序/名稱），不只看名稱
  const idx1 = getIndexDef(db, 'popup_campaigns', 'idx_popup_campaigns_public_code');
  assert(idx1 && idx1.unique && idx1.columns.join(',') === 'public_code', 'A4-index idx_popup_campaigns_public_code 精確定義正確', JSON.stringify(idx1));
  const idx2 = getIndexDef(db, 'popup_sessions', 'idx_popup_sessions_public_code');
  assert(idx2 && idx2.unique && idx2.columns.join(',') === 'public_code', 'A4-index idx_popup_sessions_public_code 精確定義正確', JSON.stringify(idx2));
  const idx3 = getIndexDef(db, 'popup_session_products', 'idx_popup_session_products_uniq');
  assert(idx3 && idx3.unique && idx3.columns.join(',') === 'session_id,product_id', 'A4-index idx_popup_session_products_uniq 精確定義正確', JSON.stringify(idx3));
  const idx4 = getIndexDef(db, 'popup_order_allocations', 'idx_popup_alloc_unique');
  assert(idx4 && idx4.unique && idx4.columns.join(',') === 'store_id,session_id,order_id,product_id', 'A4-index idx_popup_alloc_unique 精確定義正確', JSON.stringify(idx4));

  const flag = db.get("SELECT value FROM settings WHERE store_id='store_001' AND key='popup_pickup_enabled'");
  assert(flag && flag.value === '0', 'A5-settings store_001 popup_pickup_enabled 預設 0', JSON.stringify(flag));

  // ── store 隔離（資料層可分離性，用 WHERE store_id=? 驗證，不誤稱為 API IDOR）──
  db._db.run(`INSERT INTO popup_campaigns (id, store_id, public_code, name, status) VALUES (?,?,?,?,?)`,
    ['campA1', 'store_001', 'campA1-code', 'Store1 活動', 'published']);
  db._db.run(`INSERT INTO popup_campaigns (id, store_id, public_code, name, status) VALUES (?,?,?,?,?)`,
    ['campB1', 'store_002', 'campB1-code', 'Store2 活動', 'published']);
  db._save();
  const store1Camps = db.all('SELECT id FROM popup_campaigns WHERE store_id=?', ['store_001']);
  assert(store1Camps.length === 1 && store1Camps[0].id === 'campA1', 'A6-isolation store_001 用 WHERE store_id=? 只查得到自己的活動（資料層可分離性）', JSON.stringify(store1Camps));
  const store2Camps = db.all('SELECT id FROM popup_campaigns WHERE store_id=?', ['store_002']);
  assert(store2Camps.length === 1 && store2Camps[0].id === 'campB1', 'A6-isolation store_002 用 WHERE store_id=? 只查得到自己的活動（資料層可分離性）', JSON.stringify(store2Camps));
  const allCamps = db.all('SELECT id FROM popup_campaigns');
  assert(allCamps.length === 2, 'A6-isolation 不帶 store_id 條件查詢會看到兩店資料（證明隔離是查詢條件做到的，不是資料庫自動做的）', JSON.stringify(allCamps));

  // ── 重複 public_code / session_products / allocations 一律被拒絕 ──
  let dupCampaignThrew = false;
  try {
    db._db.run(`INSERT INTO popup_campaigns (id, store_id, public_code, name, status) VALUES (?,?,?,?,?)`,
      ['campA1-dup', 'store_002', 'campA1-code', '重複代碼測試', 'draft']);
  } catch (e) { dupCampaignThrew = true; }
  assert(dupCampaignThrew, 'A7-uniqueness 重複 popup_campaigns.public_code 被拒絕');

  db._db.run(
    `INSERT INTO popup_sessions (id, store_id, campaign_id, public_code, name, pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at, status)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    ['sessA', 'store_001', 'campA1', 'sessA-code', '場次A', '2026-09-18', '17:30', '19:00',
      '2026-09-01T00:00:00+08:00', '2026-09-17T21:00:00+08:00', 'published']
  );
  db._save();
  let dupSessionThrew = false;
  try {
    db._db.run(
      `INSERT INTO popup_sessions (id, store_id, campaign_id, public_code, name, pickup_date, pickup_start_time, pickup_end_time, order_open_at, order_cutoff_at, status)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      ['sessA-dup', 'store_001', 'campA1', 'sessA-code', '重複場次', '2026-09-19', '17:30', '19:00',
        '2026-09-01T00:00:00+08:00', '2026-09-18T21:00:00+08:00', 'published']
    );
  } catch (e) { dupSessionThrew = true; }
  assert(dupSessionThrew, 'A8-uniqueness 重複 popup_sessions.public_code 被拒絕');

  const PRODUCT_ID = 501;
  db._db.run(
    `INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES (?,?,?,?,?)`,
    ['store_001', 'sessA', PRODUCT_ID, 1, 10]
  );
  db._save();
  let dupSpThrew = false;
  try {
    db._db.run(
      `INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES (?,?,?,?,?)`,
      ['store_001', 'sessA', PRODUCT_ID, 1, 20]
    );
  } catch (e) { dupSpThrew = true; }
  assert(dupSpThrew, 'A9-uniqueness 重複 popup_session_products(session_id,product_id) 被拒絕');

  db._db.run(
    `INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)`,
    ['store_001', 'sessA', 'order-1', PRODUCT_ID, 2, 'active']
  );
  db._save();
  let dupAllocThrew = false;
  try {
    db._db.run(
      `INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)`,
      ['store_001', 'sessA', 'order-1', PRODUCT_ID, 1, 'active']
    );
  } catch (e) { dupAllocThrew = true; }
  assert(dupAllocThrew, 'A10-uniqueness 重複 popup_order_allocations(store,session,order,product) 被拒絕');

  // ── 冪等釋放 ──
  function releaseOnce() {
    db._db.run(
      `UPDATE popup_order_allocations SET status='released', released_at=datetime('now','localtime')
       WHERE order_id=? AND product_id=? AND session_id=? AND status='active'`,
      ['order-1', PRODUCT_ID, 'sessA']
    );
    return db._db.getRowsModified();
  }
  const r1 = releaseOnce();
  const r2 = releaseOnce();
  db._save();
  assert(r1 === 1, 'A11-idempotent 第一次釋放更新 1 筆（狀態轉換 active→released）');
  assert(r2 === 0, 'A11-idempotent 重複呼叫釋放不再變動任何列（只證明狀態轉換冪等，非份數負數保護——後者待 Phase 3 扣減交易邏輯）');

  // ── 跨三次重啟，「資料內容」（不只是表存在）完整保留 ──
  for (let round = 2; round <= 4; round++) {
    dbmod = freshDbModule();
    const dbN = await dbmod.initDb();
    const tablesN = new Set(dbN.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
    expectedTables.forEach((t) => assert(tablesN.has(t), `A12-round${round} table ${t} 重新啟動後仍存在`));

    const campN = dbN.get("SELECT name, status FROM popup_campaigns WHERE id='campA1'");
    assert(campN && campN.name === 'Store1 活動' && campN.status === 'published', `A12-round${round} 活動資料內容完整保留`, JSON.stringify(campN));
    const sessN = dbN.get("SELECT name, pickup_date FROM popup_sessions WHERE id='sessA'");
    assert(sessN && sessN.name === '場次A' && sessN.pickup_date === '2026-09-18', `A12-round${round} 場次資料內容完整保留`, JSON.stringify(sessN));
    const allocN = dbN.get("SELECT status, qty FROM popup_order_allocations WHERE order_id='order-1' AND product_id=?", [PRODUCT_ID]);
    assert(allocN && allocN.status === 'released' && Number(allocN.qty) === 2, `A12-round${round} allocation 資料內容（狀態+qty）完整保留`, JSON.stringify(allocN));

    const idxN = getIndexDef(dbN, 'popup_order_allocations', 'idx_popup_alloc_unique');
    assert(idxN && idxN.unique && idxN.columns.length === 4, `A12-round${round} idx_popup_alloc_unique 重啟後仍精確存在`, JSON.stringify(idxN));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// helper：手動組出「pre-H1.4.12」最小舊版 schema，寫成 sqlite 檔案。
// ══════════════════════════════════════════════════════════════════════
async function buildLegacyPreH1412Fixture(dbPath) {
  const SQL = await initSqlJsRaw();
  const raw = new SQL.Database();

  raw.run(`CREATE TABLE stores (
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
  raw.run(`INSERT INTO stores (store_id, store_name, contact_name, plan, active) VALUES
    ('store_001', '脆豬腰', '店長', 'pro', 1),
    ('store_101', 'Legacy 分店一', '店長A', 'pro', 1),
    ('store_102', 'Legacy 分店二', '店長B', 'pro', 1)`);

  raw.run(`CREATE TABLE products (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id TEXT NOT NULL DEFAULT 'store_001',
    name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '主食',
    price REAL NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER DEFAULT 0,
    image TEXT DEFAULT ''
  )`);
  raw.run(`INSERT INTO products (id, store_id, name, category, price, enabled) VALUES
    (9001, 'store_101', 'Legacy 排骨飯', '主食', 120, 1),
    (9002, 'store_101', 'Legacy 珍珠奶茶', '飲料', 60, 1)`);

  raw.run(`CREATE TABLE settings (
    store_id TEXT NOT NULL DEFAULT 'store_001',
    key      TEXT NOT NULL,
    value    TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (store_id, key)
  )`);
  raw.run(`INSERT INTO settings (store_id, key, value) VALUES
    ('store_101', 'shop_name', 'Legacy 分店一'),
    ('store_101', 'tax_rate', '5'),
    ('store_102', 'popup_pickup_enabled', '1')`); // store_102 事先手動開啟，升級後不得被覆蓋

  raw.run(`CREATE TABLE orders (
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
    created_at TEXT DEFAULT (datetime('now','localtime')),
    order_mode TEXT DEFAULT 'dine_in'
  )`);
  raw.run(`INSERT INTO orders (id, order_number, store_id, customer_name, customer_phone, items, payment_method, subtotal, total, order_mode, status, created_at) VALUES
    ('legacy-sentinel-takeout', 'LS-TAKEOUT-1', 'store_101', 'Sentinel Taker', '0911111111', '[{"n":"排骨飯","q":1}]', 'cash', 120, 120, 'takeout', 'completed', '2026-01-05 12:00:00'),
    ('legacy-sentinel-delivery', 'LS-DELIVERY-1', 'store_101', 'Sentinel Deliveree', '0922222222', '[{"n":"珍珠奶茶","q":2}]', 'cash', 120, 120, 'delivery', 'completed', '2026-01-06 18:30:00'),
    ('legacy-sentinel-takeout-2', 'LS-TAKEOUT-2', 'store_102', 'Sentinel Taker Two', '0933333333', '[{"n":"排骨飯","q":1}]', 'cash', 120, 120, 'takeout', 'completed', '2026-01-07 12:00:00')`);

  fs.writeFileSync(dbPath, Buffer.from(raw.export()));
  raw.close();
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO B: 真正的舊版升級（多店 backfill、sentinel 資料逐值比對、3 次重跑）
// ══════════════════════════════════════════════════════════════════════
async function scenarioB_realLegacyUpgrade() {
  const { tmpDir, dbPath } = newTmpDbPath('legacy');
  await buildLegacyPreH1412Fixture(dbPath);
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();

  const tableNames = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
  expectedTables.forEach((t) => assert(tableNames.has(t), `B1-table ${t} 舊版升級後建立`));
  const orderCols = db.all('PRAGMA table_info(orders)').map((c) => c.name);
  expectedOrderCols.forEach((c) => assert(orderCols.includes(c), `B2-column orders.${c} 舊版升級後建立`));

  // 多店 backfill：store_101 的舊外帶/舊外送 + store_102 的舊外帶，皆正確
  const takeoutOrder = db.get("SELECT pickup_type FROM orders WHERE id='legacy-sentinel-takeout'");
  assert(takeoutOrder && takeoutOrder.pickup_type === 'store', 'B3-backfill store_101 舊外帶 sentinel 訂單 pickup_type=store', JSON.stringify(takeoutOrder));
  const deliveryOrder = db.get("SELECT pickup_type FROM orders WHERE id='legacy-sentinel-delivery'");
  assert(deliveryOrder && deliveryOrder.pickup_type === '', 'B4-backfill store_101 舊外送 sentinel 訂單 pickup_type 維持空字串', JSON.stringify(deliveryOrder));
  const takeoutOrder2 = db.get("SELECT pickup_type FROM orders WHERE id='legacy-sentinel-takeout-2'");
  assert(takeoutOrder2 && takeoutOrder2.pickup_type === 'store', 'B4b-backfill store_102（另一家店）舊外帶 sentinel 訂單同樣正確 backfill', JSON.stringify(takeoutOrder2));

  const storeCount = db.get('SELECT COUNT(*) as c FROM stores').c;
  assert(storeCount === 3, 'B5-sentinel stores 筆數不變（3 家）', String(storeCount));
  const store101 = db.get("SELECT store_name, plan, active FROM stores WHERE store_id='store_101'");
  assert(store101 && store101.store_name === 'Legacy 分店一' && store101.plan === 'pro' && store101.active === 1,
    'B5-sentinel store_101 欄位值完全不變', JSON.stringify(store101));

  const product9001 = db.get('SELECT name, category, price, enabled FROM products WHERE id=9001');
  assert(product9001 && product9001.name === 'Legacy 排骨飯' && Number(product9001.price) === 120,
    'B6-sentinel products id=9001 欄位值完全不變', JSON.stringify(product9001));

  const settingTaxRate = db.get("SELECT value FROM settings WHERE store_id='store_101' AND key='tax_rate'");
  assert(settingTaxRate && settingTaxRate.value === '5', 'B7-sentinel settings tax_rate 值不變', JSON.stringify(settingTaxRate));

  const orderCountAfter = db.get('SELECT COUNT(*) as c FROM orders').c;
  assert(orderCountAfter === 3, 'B8-sentinel orders 筆數不變（3 筆）', String(orderCountAfter));

  const flag101 = db.get("SELECT value FROM settings WHERE store_id='store_101' AND key='popup_pickup_enabled'");
  assert(flag101 && flag101.value === '0', 'B9-featureflag store_101（未設定過）補成 0', JSON.stringify(flag101));
  const flag102 = db.get("SELECT value FROM settings WHERE store_id='store_102' AND key='popup_pickup_enabled'");
  assert(flag102 && flag102.value === '1', 'B9-featureflag store_102（預先設為 1）維持 1，未被覆蓋', JSON.stringify(flag102));

  for (let round = 2; round <= 3; round++) {
    dbmod = freshDbModule();
    const dbN = await dbmod.initDb();
    const storeCountN = dbN.get('SELECT COUNT(*) as c FROM stores').c;
    assert(storeCountN === 3, `B10-round${round} stores 筆數仍為 3`, String(storeCountN));
    const orderCountN = dbN.get('SELECT COUNT(*) as c FROM orders').c;
    assert(orderCountN === 3, `B10-round${round} orders 筆數仍為 3`, String(orderCountN));
    const flag102N = dbN.get("SELECT value FROM settings WHERE store_id='store_102' AND key='popup_pickup_enabled'");
    assert(flag102N && flag102N.value === '1', `B10-round${round} store_102 flag 仍為 1（未被重跑覆蓋）`, JSON.stringify(flag102N));
  }

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO C: Phase 1 舊版 TEXT product_id schema —— 合法數字字串安全重建。
// ══════════════════════════════════════════════════════════════════════
async function scenarioC_phase1TextSchemaRepairValid() {
  const { tmpDir, dbPath } = newTmpDbPath('phase1text-valid');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();
  db._db.run('DROP TABLE popup_session_products');
  db._db.run('DROP TABLE popup_order_allocations');
  db._db.run(`CREATE TABLE popup_session_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, session_id TEXT NOT NULL,
    product_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, quota_qty INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db._db.run(`CREATE TABLE popup_order_allocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, session_id TEXT NOT NULL, order_id TEXT NOT NULL,
    product_id TEXT NOT NULL, qty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now','localtime')), released_at TEXT NOT NULL DEFAULT ''
  )`);
  db._db.run(`INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES
    ('store_001', 'sessC', '601', 1, 5)`);
  db._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
    ('store_001', 'sessC', 'order-C1', '601', 3, 'active')`);
  db._save();

  const preRepairType = db.all('PRAGMA table_info(popup_session_products)').find((c) => c.name === 'product_id');
  assert(preRepairType && String(preRepairType.type).toUpperCase() === 'TEXT', 'C0-setup 手動降級後 product_id 確實是 TEXT（測試前提成立）', JSON.stringify(preRepairType));

  dbmod = freshDbModule();
  const db2 = await dbmod.initDb();

  const postType = db2.all('PRAGMA table_info(popup_session_products)').find((c) => c.name === 'product_id');
  assert(postType && String(postType.type).toUpperCase() === 'INTEGER', 'C1-repair popup_session_products.product_id 修復為 INTEGER', JSON.stringify(postType));
  const allocPostType = db2.all('PRAGMA table_info(popup_order_allocations)').find((c) => c.name === 'product_id');
  assert(allocPostType && String(allocPostType.type).toUpperCase() === 'INTEGER', 'C1-repair popup_order_allocations.product_id 修復為 INTEGER', JSON.stringify(allocPostType));

  const spRow = db2.get("SELECT product_id, quota_qty FROM popup_session_products WHERE session_id='sessC'");
  assert(spRow && Number(spRow.product_id) === 601 && Number(spRow.quota_qty) === 5, 'C2-data 修復後 popup_session_products 資料值保留', JSON.stringify(spRow));
  const allocRow = db2.get("SELECT product_id, qty, status FROM popup_order_allocations WHERE order_id='order-C1'");
  assert(allocRow && Number(allocRow.product_id) === 601 && Number(allocRow.qty) === 3 && allocRow.status === 'active', 'C3-data 修復後 popup_order_allocations 資料值保留', JSON.stringify(allocRow));

  const idxAfterRepair = getIndexDef(db2, 'popup_order_allocations', 'idx_popup_alloc_unique');
  assert(idxAfterRepair && idxAfterRepair.unique && idxAfterRepair.columns.length === 4, 'C4-index 修復後精確唯一索引存在', JSON.stringify(idxAfterRepair));

  let dupThrew = false;
  try {
    db2._db.run(
      `INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES (?,?,?,?,?,?)`,
      ['store_001', 'sessC', 'order-C1', 601, 1, 'active']
    );
  } catch (e) { dupThrew = true; }
  assert(dupThrew, 'C5-uniqueness 修復後唯一索引同樣拒絕重複 tuple');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO D: 舊 TEXT schema 混有非 canonical 資料 —— 明確拋錯，atomic 保證
// 拒絕發生在任何 DROP/RENAME/轉換之前，原表型別與資料完全不變。
// ══════════════════════════════════════════════════════════════════════
async function scenarioD_phase1TextSchemaInvalidDataThrows() {
  const { tmpDir, dbPath } = newTmpDbPath('phase1text-invalid');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();
  db._db.run('DROP TABLE popup_session_products');
  db._db.run(`CREATE TABLE popup_session_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, session_id TEXT NOT NULL,
    product_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, quota_qty INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  db._db.run(`INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES
    ('store_001', 'sessD', 'not-a-number', 1, 5)`);
  db._save();

  dbmod = freshDbModule();
  let threw = false;
  let errMsg = '';
  try {
    await dbmod.initDb();
  } catch (e) { threw = true; errMsg = e.message; }
  assert(threw, 'D1-fail-loud 非 canonical product_id 資料存在時，initDb() 明確拋錯（不靜默略過）', errMsg);
  assert(threw && /popup_session_products/.test(errMsg) && /product_id/.test(errMsg), 'D2-error-context 錯誤訊息包含表名與 product_id 說明', errMsg);

  const SQL = await initSqlJsRaw();
  const raw = new SQL.Database(fs.readFileSync(dbPath));
  const typeStmt = raw.prepare("SELECT type FROM pragma_table_info('popup_session_products') WHERE name='product_id'");
  typeStmt.step();
  const typeRow = typeStmt.getAsObject();
  typeStmt.free();
  assert(typeRow && String(typeRow.type).toUpperCase() === 'TEXT', 'D3-atomicity 拋錯後 product_id 型別仍是 TEXT（未曾開始轉換，遑論 DROP/RENAME）', JSON.stringify(typeRow));

  const stmt = raw.prepare("SELECT product_id FROM popup_session_products WHERE session_id='sessD'");
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  assert(row && row.product_id === 'not-a-number', 'D4-data-safety 拋錯後原始異常資料完全未被刪除或竄改', JSON.stringify(row));
  raw.close();

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO E: 唯一索引建立前偵測到既有重複 allocation tuple —— 明確拋錯。
// ══════════════════════════════════════════════════════════════════════
async function scenarioE_duplicateAllocationsOnUpgradeThrows() {
  const { tmpDir, dbPath } = newTmpDbPath('dup-alloc');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();
  db._db.run('DROP INDEX IF EXISTS idx_popup_alloc_unique');
  db._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
    ('store_001', 'sessE', 'order-E1', 701, 1, 'active')`);
  db._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
    ('store_001', 'sessE', 'order-E1', 701, 1, 'active')`);
  db._save();

  const dupCountBefore = db.get(`
    SELECT COUNT(*) as c FROM popup_order_allocations
    WHERE store_id='store_001' AND session_id='sessE' AND order_id='order-E1' AND product_id=701
  `).c;
  assert(dupCountBefore === 2, 'E0-setup 手動塞入 2 筆重複 tuple 成功（測試前提成立：唯一索引已被移除）', String(dupCountBefore));

  dbmod = freshDbModule();
  let threw = false;
  let errMsg = '';
  try {
    await dbmod.initDb();
  } catch (e) { threw = true; errMsg = e.message; }
  assert(threw, 'E1-fail-loud migration 重跑時偵測到重複 allocation，明確拋錯', errMsg);
  assert(threw && /popup_order_allocations/.test(errMsg) && /重複/.test(errMsg), 'E2-error-context 錯誤訊息說明是哪張表、哪種重複問題', errMsg);

  const SQL = await initSqlJsRaw();
  const raw = new SQL.Database(fs.readFileSync(dbPath));
  const stmt = raw.prepare(`
    SELECT COUNT(*) as c FROM popup_order_allocations
    WHERE store_id='store_001' AND session_id='sessE' AND order_id='order-E1' AND product_id=701
  `);
  stmt.step();
  const row = stmt.getAsObject();
  stmt.free();
  assert(row && row.c === 2, 'E3-data-safety 拋錯後重複資料仍是 2 筆（未被靜默刪除任何一筆）', JSON.stringify(row));
  raw.close();

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO F（新增）：轉型碰撞 —— 同一唯一鍵範圍內 '1' 與 '01' 同時存在。
// Migration 必須在修改任何資料前明確拒絕（不論是被 canonical 格式檢查攔下，
// 或被碰撞檢查攔下，兩者皆屬於「preflight 階段」，都必須發生在 DROP／
// RENAME／CAST 轉換之前）。
// ══════════════════════════════════════════════════════════════════════
async function scenarioF_collisionOnCast() {
  const { tmpDir, dbPath } = newTmpDbPath('collision');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();
  db._db.run('DROP TABLE popup_session_products');
  db._db.run(`CREATE TABLE popup_session_products (
    id INTEGER PRIMARY KEY AUTOINCREMENT, store_id TEXT NOT NULL, session_id TEXT NOT NULL,
    product_id TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, quota_qty INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now','localtime')), updated_at TEXT DEFAULT (datetime('now','localtime'))
  )`);
  // 同一個 session_id 下，'1' 與 '01' 轉成整數後都是 1 —— 唯一鍵碰撞。
  db._db.run(`INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES
    ('store_001', 'sessF', '1', 1, 5)`);
  db._db.run(`INSERT INTO popup_session_products (store_id, session_id, product_id, enabled, quota_qty) VALUES
    ('store_001', 'sessF', '01', 1, 7)`);
  db._save();

  const rowCountBefore = db.get("SELECT COUNT(*) as c FROM popup_session_products WHERE session_id='sessF'").c;
  assert(rowCountBefore === 2, 'F0-setup 手動塞入 product_id=\'1\' 與 \'01\' 成功（測試前提成立）', String(rowCountBefore));

  dbmod = freshDbModule();
  let threw = false;
  let errMsg = '';
  try {
    await dbmod.initDb();
  } catch (e) { threw = true; errMsg = e.message; }
  assert(threw, 'F1-fail-loud \'1\' 與 \'01\' 並存時，initDb() 在修改資料前明確拒絕', errMsg);

  const SQL = await initSqlJsRaw();
  const raw = new SQL.Database(fs.readFileSync(dbPath));

  const typeStmt = raw.prepare("SELECT type FROM pragma_table_info('popup_session_products') WHERE name='product_id'");
  typeStmt.step();
  const typeRow = typeStmt.getAsObject();
  typeStmt.free();
  assert(typeRow && String(typeRow.type).toUpperCase() === 'TEXT', 'F2-atomicity 拒絕後 product_id 型別仍是 TEXT（未被轉換）', JSON.stringify(typeRow));

  const rowsStmt = raw.prepare("SELECT product_id, quota_qty FROM popup_session_products WHERE session_id='sessF' ORDER BY product_id");
  const rowsAfter = [];
  while (rowsStmt.step()) rowsAfter.push(rowsStmt.getAsObject());
  rowsStmt.free();
  assert(rowsAfter.length === 2, 'F3-data-safety 拒絕後資料列數仍是 2 筆（未被刪除）', JSON.stringify(rowsAfter));
  const v1 = rowsAfter.find((r) => r.product_id === '1');
  const v01 = rowsAfter.find((r) => r.product_id === '01');
  assert(v1 && Number(v1.quota_qty) === 5, 'F4-data-safety 原始值 \'1\' 完全不變', JSON.stringify(v1));
  assert(v01 && Number(v01.quota_qty) === 7, 'F4-data-safety 原始值 \'01\' 完全不變（未被 CAST 覆蓋或去重）', JSON.stringify(v01));

  const idxListStmt = raw.prepare("SELECT COUNT(*) as c FROM sqlite_master WHERE type='table' AND name='popup_session_products_new_h1412'");
  idxListStmt.step();
  const leftoverTmp = idxListStmt.getAsObject();
  idxListStmt.free();
  assert(leftoverTmp && leftoverTmp.c === 0, 'F5-atomicity 失敗的暫存重建表未殘留在資料庫中（ROLLBACK 乾淨）', JSON.stringify(leftoverTmp));

  raw.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
// SCENARIO G（新增）：假同名 index —— idx_popup_alloc_unique 存在但定義錯誤
// （非 UNIQUE、欄位錯誤）。Migration 必須偵測出定義不符、不能只看名稱就通過
// postcondition；本情境下沒有真實重複資料，因此可以安全修復成正確定義，
// 修復後真正的重複 INSERT 必須被拒絕。
// ══════════════════════════════════════════════════════════════════════
async function scenarioG_fakeSameNameIndex() {
  const { tmpDir, dbPath } = newTmpDbPath('fake-index');
  process.env.POS_DB_PATH = dbPath;

  let dbmod = freshDbModule();
  let db = await dbmod.initDb();

  // 破壞成「假同名 index」：非 UNIQUE、且欄位錯誤（只有 order_id 一欄）。
  db._db.run('DROP INDEX idx_popup_alloc_unique');
  db._db.run('CREATE INDEX idx_popup_alloc_unique ON popup_order_allocations(order_id)');
  db._save();

  const fakeIdx = getIndexDef(db, 'popup_order_allocations', 'idx_popup_alloc_unique');
  assert(fakeIdx && !fakeIdx.unique && fakeIdx.columns.join(',') === 'order_id', 'G0-setup 手動建立假同名 index 成功（測試前提成立：非 UNIQUE、欄位錯誤）', JSON.stringify(fakeIdx));

  // 此時插入「應該重複」的 tuple 竟然不會被擋下（因為假 index 沒有 UNIQUE 語意）——
  // 證明「單憑名稱存在」不能代表保護有效，這正是本情境要修復的問題。
  db._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
    ('store_001', 'sessG', 'order-G-preexisting', 801, 1, 'active')`);
  let wronglyAllowedDup = false;
  try {
    db._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
      ('store_001', 'sessG', 'order-G-preexisting', 801, 1, 'active')`);
    wronglyAllowedDup = true; // 假 index 沒擋下重複，符合預期的「假保護」情境
  } catch (e) { /* 若環境剛好擋下也無妨，不影響後續驗證 */ }
  db._save();
  // 清掉這筆用來證明假保護無效的多餘資料，避免影響 migration 重跑時的重複檢查。
  db._db.run(`DELETE FROM popup_order_allocations WHERE order_id='order-G-preexisting'`);
  db._save();

  // 重新啟動，觸發偵測與修復
  dbmod = freshDbModule();
  const db2 = await dbmod.initDb();

  const fixedIdx = getIndexDef(db2, 'popup_order_allocations', 'idx_popup_alloc_unique');
  assert(fixedIdx && fixedIdx.unique, 'G1-repair 修復後 idx_popup_alloc_unique 是 UNIQUE', JSON.stringify(fixedIdx));
  assert(fixedIdx && fixedIdx.columns.join(',') === 'store_id,session_id,order_id,product_id', 'G2-repair 修復後欄位為 store_id,session_id,order_id,product_id', JSON.stringify(fixedIdx));

  // 修復後，真正的重複 INSERT 必須被資料庫拒絕（不再是假保護）。
  db2._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
    ('store_001', 'sessG', 'order-G1', 802, 1, 'active')`);
  let dupThrewAfterFix = false;
  try {
    db2._db.run(`INSERT INTO popup_order_allocations (store_id, session_id, order_id, product_id, qty, status) VALUES
      ('store_001', 'sessG', 'order-G1', 802, 1, 'active')`);
  } catch (e) { dupThrewAfterFix = true; }
  assert(dupThrewAfterFix, 'G3-verify 修復後真正的重複 INSERT 被資料庫拒絕（不再只是名稱存在）');

  fs.rmSync(tmpDir, { recursive: true, force: true });
}

// ══════════════════════════════════════════════════════════════════════
async function main() {
  await scenarioA_freshInstall();
  await scenarioB_realLegacyUpgrade();
  await scenarioC_phase1TextSchemaRepairValid();
  await scenarioD_phase1TextSchemaInvalidDataThrows();
  await scenarioE_duplicateAllocationsOnUpgradeThrows();
  await scenarioF_collisionOnCast();
  await scenarioG_fakeSameNameIndex();
}

main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); process.exitCode = 1; });
