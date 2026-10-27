#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-product-mode-migration.js
// R44.2F.3B 一：line_takeout_enabled／line_delivery_enabled 欄位的永久
// cold-start migration regression。真正獨立 child process（async execFile，
// 不阻塞本程序），同一個 temp DB 檔案跨三次冷啟動。
'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { execFile } = require('child_process'); const execFileP = require('util').promisify(execFile);
const results = [];
function assert(cond, name, detail) { results.push({ name, ok: !!cond }); console.log(cond ? `[PASS] ${name}` : `[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function summary() {
  const p = results.filter((r) => r.ok).length, f = results.length - p;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 popup product mode migration (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}
async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-mode-mig-'));
  const dbPath = path.join(tmpDir, 'legacy.db');
  const projectRoot = path.join(__dirname, '..');
  try {
    // Cold start #0：用真正的 sql.js 建立一個「不含這兩欄」的 legacy-shaped DB
    // ——直接用 initDb() 建正常 schema，再手動用一張沒有這兩欄的新表把
    // products 資料搬過去、drop 掉舊表、改名，模擬「這兩欄從未 migrate 過」
    // 的真實 legacy 狀態（sql.js 不支援 DROP COLUMN，這是唯一能得到「該欄
    // 真的不存在」狀態的方法，不是用猜的）。
    const out0 = await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        const cols = db.all("PRAGMA table_info(products)").map(c => c.name).filter(n => n !== 'line_takeout_enabled' && n !== 'line_delivery_enabled');
        db._db.run('CREATE TABLE products_legacy_shape AS SELECT ' + cols.join(',') + ' FROM products');
        db._db.run('DROP TABLE products');
        db._db.run('ALTER TABLE products_legacy_shape RENAME TO products');
        db._db.run("INSERT INTO products (id, store_id, name, category, price, enabled) VALUES (7001, 'store_001', 'LegacyModeProduct', '主食', 50, 1)");
        db._save();
        const check = db.all("PRAGMA table_info(products)").map(c => c.name);
        console.log(JSON.stringify({ hasTakeout: check.includes('line_takeout_enabled'), hasDelivery: check.includes('line_delivery_enabled') }));
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });
    const r0 = JSON.parse(out0.stdout.trim().split('\n').pop());
    assert(r0.hasTakeout === false && r0.hasDelivery === false, '0-legacy-db-confirmed-missing 初始 legacy DB 真的不含這兩欄（不是假設）', JSON.stringify(r0));

    // Cold start #1：真實 initDb() 應該補上這兩欄，legacy row 預設值皆為 1。
    const out1 = await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        const cols = db.all("PRAGMA table_info(products)");
        const takeoutCount = cols.filter(c => c.name === 'line_takeout_enabled').length;
        const deliveryCount = cols.filter(c => c.name === 'line_delivery_enabled').length;
        const row = db.get('SELECT line_takeout_enabled, line_delivery_enabled FROM products WHERE id=7001');
        console.log(JSON.stringify({ takeoutCount, deliveryCount, row }));
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });
    const r1 = JSON.parse(out1.stdout.trim().split('\n').pop());
    assert(r1.takeoutCount === 1 && r1.deliveryCount === 1, '1-columns-added-exactly-once cold start #1：兩欄各恰好存在一次', JSON.stringify(r1));
    assert(r1.row.line_takeout_enabled === 1 && r1.row.line_delivery_enabled === 1, '1-legacy-row-default-1 legacy product 兩欄預設值皆為 1', JSON.stringify(r1.row));

    // 明確改為 0
    const outSet = await execFileP('node', ['-e', `
      process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
      const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
      (async () => {
        await initDb();
        const db = getDb();
        db._db.run('UPDATE products SET line_takeout_enabled=0, line_delivery_enabled=0 WHERE id=7001');
        db._save();
        console.log('done');
      })();
    `], { cwd: projectRoot, env: process.env, timeout: 20000 });
    assert(outSet.stdout.includes('done'), 'set-explicit-zero 明確把兩欄改成 0', outSet.stdout);

    // Cold start #2／#3：欄位仍各只有一個，明確的 0 不得被重設回 1，且
    // popupCheckout.js 真正的 fresh-authority reconcile query 可正常執行。
    async function coldStart(n) {
      const out = await execFileP('node', ['-e', `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(projectRoot, 'utils/db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          const cols = db.all("PRAGMA table_info(products)");
          const takeoutCount = cols.filter(c => c.name === 'line_takeout_enabled').length;
          const deliveryCount = cols.filter(c => c.name === 'line_delivery_enabled').length;
          const row = db.get('SELECT line_takeout_enabled, line_delivery_enabled FROM products WHERE id=7001');
          let reconcileOk = true, reconcileErr = null;
          try {
            const popupCheckout = require(${JSON.stringify(path.join(projectRoot, 'utils/popupCheckout.js'))});
            popupCheckout.reconcilePopupCartItemsAgainstFreshAuthority(db, 'store_001', { id: 'sess-x', pickup_date: '2026-12-25' }, [{ product_id: 7001, qty: 1 }]);
          } catch (e) { reconcileOk = false; reconcileErr = e.message; }
          console.log(JSON.stringify({ takeoutCount, deliveryCount, row, reconcileOk, reconcileErr }));
        })();
      `], { cwd: projectRoot, env: process.env, timeout: 20000 });
      return JSON.parse(out.stdout.trim().split('\n').pop());
    }
    const r2 = await coldStart(2);
    assert(r2.takeoutCount === 1 && r2.deliveryCount === 1, '2-columns-still-one cold start #2：欄位仍各只有一個（沒有重複 ALTER）', JSON.stringify(r2));
    assert(r2.row.line_takeout_enabled === 0 && r2.row.line_delivery_enabled === 0, '2-explicit-zero-preserved 明確的 0 沒有被 migration 重設回 1', JSON.stringify(r2.row));
    assert(r2.reconcileOk === true, '2-reconcile-query-works popupCheckout.js 真正的 fresh-authority reconcile query 可正常執行（不是 no such column）', JSON.stringify(r2));
    const r3 = await coldStart(3);
    assert(JSON.stringify(r3) === JSON.stringify(r2), '3-byte-identical-to-cold-start-2 cold start #3 與 #2 結果完全一致', JSON.stringify({ r2, r3 }));
  } catch (e) { console.error('[FATAL]', e); assert(false, 'fatal', e.message); }
  finally { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} }
  summary();
}
main();
