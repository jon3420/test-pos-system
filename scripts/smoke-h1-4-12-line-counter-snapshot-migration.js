#!/usr/bin/env node
// scripts/smoke-h1-4-12-line-counter-snapshot-migration.js
// R44.1B-4B Phase B 七：line_counter_allocation_snapshot 欄位的永久
// cold-start migration regression。真正獨立 child process（async execFile）。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 line counter snapshot migration (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-snap-mig-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  const projectRoot = path.join(__dirname, '..');
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-snap-mig'; // 設在 parent，讓所有 child process 透過 env: process.env 繼承同一把 secret
  try {
    // Cold start #0：真正沒有 snapshot column 的 legacy DB（搬表法，跟既有已驗證的 mode-migration suite 同一手法）。
    const out0 = await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        const cols = db.all("PRAGMA table_info(orders)").map(c => c.name).filter(n => n !== 'line_counter_allocation_snapshot');
        db._db.run('CREATE TABLE orders_legacy_shape AS SELECT ' + cols.join(',') + ' FROM orders');
        db._db.run('DROP TABLE orders');
        db._db.run('ALTER TABLE orders_legacy_shape RENAME TO orders');
        db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, created_at, updated_at) VALUES ('legacy-1','LEG1','store_001','takeout','pending','pending','Legacy','0900000001','[]','cash',0,0,'line','','quota','2026-01-01 00:00:00','2026-01-01 00:00:00')");
        db._save();
        const check = db.all("PRAGMA table_info(orders)").map(c => c.name);
        console.log(JSON.stringify({ hasSnapshotCol: check.includes('line_counter_allocation_snapshot') }));
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });
    const r0 = JSON.parse(out0.stdout.trim().split('\n').pop());
    assert(r0.hasSnapshotCol === false, '0-legacy-db-confirmed-missing 初始 legacy DB 真的不含 snapshot 欄位', JSON.stringify(r0));

    // Cold start #1：真實 initDb() 補上欄位，legacy row 為 SQL NULL。
    const out1 = await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        const cols = db.all("PRAGMA table_info(orders)").filter(c => c.name === 'line_counter_allocation_snapshot');
        const row = db.get("SELECT line_counter_allocation_snapshot FROM orders WHERE id='legacy-1'");
        console.log(JSON.stringify({ colCount: cols.length, legacyVal: row.line_counter_allocation_snapshot }));
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });
    const r1 = JSON.parse(out1.stdout.trim().split('\n').pop());
    assert(r1.colCount === 1, '1-column-added-once cold start #1：欄位恰好新增一次', JSON.stringify(r1));
    assert(r1.legacyVal === null, '1-legacy-row-null legacy row 為 SQL NULL（不猜測 backfill）', JSON.stringify(r1));

    // 寫入三種值
    await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, line_counter_allocation_snapshot, created_at, updated_at) VALUES ('valid-1','V1','store_001','takeout','pending','pending','V','0900000002','[]','cash',0,0,'line','10:00','quota', ?, '2026-01-02 00:00:00','2026-01-02 00:00:00')", [JSON.stringify({version:1,allocations:[{product_id:1,counter_bucket:'quota',qty:2}]})]);
        db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, line_counter_allocation_snapshot, created_at, updated_at) VALUES ('empty-1','E1','store_001','takeout','pending','pending','E','0900000003','[]','cash',0,0,'line','10:00','quota', ?, '2026-01-02 00:00:00','2026-01-02 00:00:00')", [JSON.stringify({version:1,allocations:[]})]);
        db._db.run("INSERT INTO orders (id, order_number, store_id, order_mode, order_status, status, customer_name, customer_phone, items, payment_method, subtotal, total, source, pickup_time, line_counter_bucket, line_counter_allocation_snapshot, created_at, updated_at) VALUES ('null-1','N1','store_001','takeout','pending','pending','N','0900000004','[]','cash',0,0,'line','10:00',NULL, NULL, '2026-01-02 00:00:00','2026-01-02 00:00:00')");
        db._save();
        console.log('done');
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });

    async function coldStart() {
      const out = await execFileP('node', ['-e', `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          const cols = db.all("PRAGMA table_info(orders)").filter(c => c.name === 'line_counter_allocation_snapshot');
          const rows = {
            legacy: db.get("SELECT line_counter_allocation_snapshot AS v FROM orders WHERE id='legacy-1'").v,
            valid: db.get("SELECT line_counter_allocation_snapshot AS v FROM orders WHERE id='valid-1'").v,
            empty: db.get("SELECT line_counter_allocation_snapshot AS v FROM orders WHERE id='empty-1'").v,
            nullRow: db.get("SELECT line_counter_allocation_snapshot AS v FROM orders WHERE id='null-1'").v,
          };
          console.log(JSON.stringify({ colCount: cols.length, rows }));
        })();
      `], { cwd: projectRoot, env: process.env, timeout: 20000 });
      return JSON.parse(out.stdout.trim().split('\n').pop());
    }
    const r2 = await coldStart();
    assert(r2.colCount === 1, '2-column-still-one cold start #2：欄位仍恰好一個', JSON.stringify(r2));
    assert(r2.rows.legacy === null && r2.rows.valid === JSON.stringify({ version: 1, allocations: [{ product_id: 1, counter_bucket: 'quota', qty: 2 }] }) && r2.rows.empty === JSON.stringify({ version: 1, allocations: [] }) && r2.rows.nullRow === null, '2-values-preserved 三種值 byte-identical 保留，沒有猜測 backfill', JSON.stringify(r2.rows));
    const r3 = await coldStart();
    assert(JSON.stringify(r3) === JSON.stringify(r2), '3-byte-identical-to-coldstart2 cold start #3 與 #2 完全一致', JSON.stringify({ r2, r3 }));

    // 新 standard order 寫入合法 v1，cold restart 後 cancel 成功並精確 restore
    {
      const out = await execFileP('node', ['-e', `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          db._db.run("INSERT OR REPLACE INTO licenses (store_id, store_name, plan, active, features) VALUES ('store_001','x','pro',1,?)", [JSON.stringify({ line_order: true, orders: true, products: true })]);
          db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_business_hours', ?)", [JSON.stringify({mon:{open:'00:00',close:'23:59',enabled:true},tue:{open:'00:00',close:'23:59',enabled:true},wed:{open:'00:00',close:'23:59',enabled:true},thu:{open:'00:00',close:'23:59',enabled:true},fri:{open:'00:00',close:'23:59',enabled:true},sat:{open:'00:00',close:'23:59',enabled:true},sun:{open:'00:00',close:'23:59',enabled:true}})]);
          db._db.run("INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_001', 'takeout_cutoff_time', '')");
          db._db.run("DELETE FROM settings WHERE store_id='store_001' AND key='takeout_today_cutoff_time'");
          db._db.run('DELETE FROM products WHERE id=5501');
          db._db.run("INSERT INTO products (id, store_id, name, category, price, enabled, show_on_line, sale_status, line_quota_enabled, line_quota_daily) VALUES (5501,'store_001','MigTestProduct','主食',80,1,1,'available',1,100000)");
          db._save();
          const express = require('express'); const app = express(); app.use(express.json());
          const { requireStore } = require(${JSON.stringify(path.join(projectRoot, 'middleware/storeGuard.js'))});
          const { requireFeature } = require(${JSON.stringify(path.join(projectRoot, 'middleware/featureGate.js'))});
          app.use('/api/line-orders', requireStore, requireFeature('line_order'), require(${JSON.stringify(path.join(projectRoot, 'routes/line-orders.js'))}));
          app.use('/api/orders', requireStore, require(${JSON.stringify(path.join(projectRoot, 'routes/orders.js'))}));
          const server = app.listen(0);
          const jwt = require('jsonwebtoken');
          const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET, { expiresIn: '1h' });
          const base = 'http://127.0.0.1:' + server.address().port;
          const r = await fetch(base + '/api/line-orders', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T1 }, body: JSON.stringify({ customer_name: 'MigCreate', customer_phone: '0955350001', order_type: 'takeout', payment_method: 'cash', items: [{ product_id: 5501, qty: 2 }] }) });
          const rj = await r.json();
          const row = db.get("SELECT id, line_counter_allocation_snapshot AS s FROM orders WHERE customer_phone='0955350001'");
          server.close();
          console.log(JSON.stringify({ httpStatus: r.status, snapshot: row && row.s }));
        })();
      `], { cwd: projectRoot, env: process.env, timeout: 20000 });
      const r = JSON.parse(out.stdout.trim().split('\n').pop());
      assert((r.httpStatus === 200 || r.httpStatus === 201) && JSON.parse(r.snapshot).allocations.length === 1, '4-standard-create-writes-v1 新 standard order 在冷啟動過的 DB 上寫入合法 v1 snapshot', JSON.stringify(r));
    }
    // cold restart 後 cancel 成功並精確 restore
    {
      const out = await execFileP('node', ['-e', `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          const q0 = db.get('SELECT line_quota_sold AS v FROM products WHERE id=5501').v;
          const express = require('express'); const app = express(); app.use(express.json());
          const { requireStore } = require(${JSON.stringify(path.join(projectRoot, 'middleware/storeGuard.js'))});
          app.use('/api/orders', requireStore, require(${JSON.stringify(path.join(projectRoot, 'routes/orders.js'))}));
          const server = app.listen(0);
          const jwt = require('jsonwebtoken');
          const T1 = jwt.sign({ role: 'store', store_id: 'store_001', store_name: 'store_001' }, process.env.JWT_SECRET || 'test-secret-snap-mig', { expiresIn: '1h' });
          const base = 'http://127.0.0.1:' + server.address().port;
          const order = db.get("SELECT id FROM orders WHERE customer_phone='0955350001'");
          const r = await fetch(base + '/api/orders/' + order.id + '/status', { method: 'PATCH', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + T1 }, body: JSON.stringify({ order_status: 'cancelled' }) });
          const qAfter = db.get('SELECT line_quota_sold AS v FROM products WHERE id=5501').v;
          server.close();
          console.log(JSON.stringify({ httpStatus: r.status, q0, qAfter }));
        })();
      `], { cwd: projectRoot, env: process.env, timeout: 20000 });
      const r = JSON.parse(out.stdout.trim().split('\n').pop());
      // q0 是 cancel 前（訂單已建立、counter 已 +2 之後）的值；cancel 成功後應該精確回到「建立前」的 0（本商品在這個 migration DB 裡是全新的，從未被別的訂單動過）。
      assert(r.httpStatus === 200 && r.q0 === 2 && r.qAfter === 0, '5-cold-restart-cancel-restores-exactly cold restart 後對這張訂單 cancel 成功，counter 精確恢復到建立前的 0（證明冷啟動沒有破壞可恢復性）', JSON.stringify(r));
    }
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
