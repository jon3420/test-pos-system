#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-cart-migration.js
// H1.4.12 Phase 3B — popup_restore_receipts partial unique index migration,
// fail-closed verification.
//
// initDb() caches a module-level singleton (`if (wrappedDb) return wrappedDb`),
// so calling it twice in the SAME process never re-runs migrations against a
// persisted file — that would give a false negative for this test. Every
// case here spawns a genuinely fresh `node` child process pointed at the
// same on-disk DB file, which is what "cold start against existing data"
// actually means.
'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup restore receipts migration (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function runFreshInitDb(dbPath) {
  // 真正開一個全新 node process，載入同一個 DB 檔案，呼叫 initDb()——
  // 完全不共用目前這個測試 process 的 wrappedDb singleton。
  const script = `
    process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
    const { initDb } = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'db.js'))});
    initDb().then(() => { console.log('INITDB_OK'); process.exit(0); })
      .catch((e) => { console.log('INITDB_THREW:' + e.message); process.exit(1); });
  `;
  try {
    const out = execFileSync(process.execPath, ['-e', script], { encoding: 'utf8', timeout: 30000 });
    return { exitCode: 0, stdout: out };
  } catch (e) {
    return { exitCode: e.status, stdout: (e.stdout || '') + (e.stderr || '') };
  }
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 一、無重複資料：migration 成功、index 存在、重跑 idempotent。
  // ══════════════════════════════════════════════════════════════
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-migration-clean-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      const first = runFreshInitDb(dbPath);
      assert(first.exitCode === 0 && first.stdout.includes('INITDB_OK'), '1-clean-first-init 全新 DB（無重複資料）initDb() 成功', JSON.stringify(first));

      const { getDb } = require('../utils/db');
      // 用同一支測試 process 直接開檔查詢（不透過 initDb() singleton，避免混淆）。
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const raw = fs.readFileSync(dbPath);
      const rawDb = new SQL.Database(raw);
      const idxRows = rawDb.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_prr_token_single_prepared'");
      assert(idxRows.length > 0 && idxRows[0].values.length > 0, '1-clean-index-exists partial unique index 確實建立在 DB 檔案裡', JSON.stringify(idxRows));
      rawDb.close();

      const second = runFreshInitDb(dbPath);
      assert(second.exitCode === 0 && second.stdout.includes('INITDB_OK'), '1-clean-second-init 用全新 process 重跑 initDb()（同一個檔案）仍然成功，migration idempotent', JSON.stringify(second));
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二、有重複 status='prepared' rows：必須 fail closed。
  // ══════════════════════════════════════════════════════════════
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-migration-dup-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      // 先正常初始化一次，建立好所有 table/index。
      const first = runFreshInitDb(dbPath);
      assert(first.exitCode === 0, '2-dup-setup-first-init 建立初始資料庫成功', JSON.stringify(first));

      // 在一個獨立 process 裡：先 DROP 掉保護用的 partial unique index，
      // 再手動塞進兩筆同一個 token_id、status='prepared' 的 row（模擬
      // 「這個保護措施上線前就已經存在的衝突資料」），最後把 DB 存回磁碟。
      const setupScript = `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          db._db.run("INSERT INTO line_cart_handoff_tokens (token, store_id, status, purpose, cart_code, line_user_id, recovery_page_type, created_at, expires_at) VALUES ('dup-migration-test','store_001','opened','recovery_resume','DUPMIGCODE','Udup','popup_order','2099-01-01 00:00:00','2099-01-02 00:00:00')");
          const tokenId = db.get("SELECT id FROM line_cart_handoff_tokens WHERE token='dup-migration-test'").id;
          db._db.run('DROP INDEX IF EXISTS idx_prr_token_single_prepared');
          db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('duph1','store_001',?, 'Udup','sess1','d1','prepared','2099-01-01 00:00:00','2099-01-01 00:05:00','')", [tokenId]);
          db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('duph2','store_001',?, 'Udup','sess1','d2','prepared','2099-01-01 00:00:00','2099-01-01 00:05:00','')", [tokenId]);
          db._save();
          console.log('SETUP_OK:' + tokenId);
        })().catch((e) => { console.error('SETUP_FAILED:' + e.message); process.exit(1); });
      `;
      const setupOut = execFileSync(process.execPath, ['-e', setupScript], { encoding: 'utf8', timeout: 30000 });
      assert(setupOut.includes('SETUP_OK'), '2-dup-setup-conflicting-data 成功在獨立 process 裡佈置衝突資料（繞過應用層保護，直接操作 DB）', setupOut);

      // 現在用全新的第三個 process 冷啟動，載入這個已經有衝突資料的 DB 檔案。
      const coldStart = runFreshInitDb(dbPath);
      assert(coldStart.exitCode !== 0, '2-dup-coldstart-fails 冷啟動載入有衝突 prepared receipt 的 DB 時，initDb() 讓 process 非 0 結束（fail closed）', JSON.stringify(coldStart));
      assert(coldStart.stdout.includes('INITDB_THREW'), '2-dup-coldstart-threw initDb() 真的 throw/reject，不是靜默通過', coldStart.stdout);
      assert(!coldStart.stdout.includes('INITDB_OK'), '2-dup-coldstart-not-marked-ok 沒有輸出成功標記（沒有假裝 migration 完成）', coldStart.stdout);

      // 注意：initDb() 在同一次呼叫裡會依序跑非常多既有、各自獨立
      // auto-save 的 migration 步驟，這個修正的 fail-closed 只保證「發現
      // 衝突資料的這一步不會建立 index、不會刪除/挑選任何一筆衝突資料」，
      // 不是整個 DB 檔案在這次失敗的冷啟動過程中完全零位元組變動（那不是
      // 這個修正實際承諾、也不是這個現有 migration 架構的運作方式）。真正
      // 要驗證的是：衝突資料本身逐值不變、也沒有半成品 index。
      const initSqlJs = require('sql.js');
      const SQL = await initSqlJs();
      const rawDb = new SQL.Database(fs.readFileSync(dbPath));
      const idxAfter = rawDb.exec("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_prr_token_single_prepared'");
      const idxExists = idxAfter.length > 0 && idxAfter[0].values.length > 0;
      assert(!idxExists, '2-dup-no-partial-index 失敗的冷啟動嘗試沒有留下半成品的 partial unique index', JSON.stringify(idxAfter));
      const rows = rawDb.exec("SELECT receipt_hash, status FROM popup_restore_receipts WHERE receipt_hash IN ('duph1','duph2') ORDER BY receipt_hash");
      const values = rows[0] ? rows[0].values : [];
      assert(values.length === 2 && values[0][1] === 'prepared' && values[1][1] === 'prepared', '2-dup-both-rows-preserved 兩筆衝突的 prepared receipt 都還在、狀態都沒被改動', JSON.stringify(values));
      rawDb.close();
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════
  // 三、Index 建立 SQL 本身失敗時同樣必須中止初始化（模擬：先建立一個同名、
  // 型別不同的普通表/物件佔用該 index 名稱，讓 CREATE INDEX 失敗）。
  // ══════════════════════════════════════════════════════════════
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-migration-idxfail-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      const first = runFreshInitDb(dbPath);
      assert(first.exitCode === 0, '3-idxfail-setup-first-init 建立初始資料庫成功', JSON.stringify(first));

      const sabotageScript = `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          db._db.run('DROP INDEX IF EXISTS idx_prr_token_single_prepared');
          // 建立一個同名的『表』佔用這個名稱——SQLite 的 index/table 名稱共用同一個命名空間，
          // CREATE INDEX 撞到同名的 table 時會直接失敗，藉此模擬「index 建立 SQL 本身失敗」。
          db._db.run('CREATE TABLE idx_prr_token_single_prepared (x INTEGER)');
          db._save();
          console.log('SABOTAGE_OK');
        })().catch((e) => { console.error('SABOTAGE_FAILED:' + e.message); process.exit(1); });
      `;
      const sabotageOut = execFileSync(process.execPath, ['-e', sabotageScript], { encoding: 'utf8', timeout: 30000 });
      assert(sabotageOut.includes('SABOTAGE_OK'), '3-idxfail-setup 成功佔用 index 名稱，模擬 CREATE INDEX 會失敗的情境', sabotageOut);

      const coldStart = runFreshInitDb(dbPath);
      assert(coldStart.exitCode !== 0 && coldStart.stdout.includes('INITDB_THREW'), '3-idxfail-coldstart-fails CREATE INDEX 本身失敗時，initDb() 同樣中止（不是在缺少 index 保護的情況下繼續啟動）', JSON.stringify(coldStart));
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }

  // ══════════════════════════════════════════════════════════════
  // 四／五：既有 non-duplicate 資料（prepared/consumed/superseded 混合）
  // 保留；同一 token 一筆 prepared + 多筆 consumed/superseded 合法，
  // 兩筆 prepared 被 DB 拒絕。
  // ══════════════════════════════════════════════════════════════
  {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1412-migration-mixed-'));
    const dbPath = path.join(tmpDir, 'test.db');
    try {
      const first = runFreshInitDb(dbPath);
      assert(first.exitCode === 0, '4-mixed-setup-init 建立初始資料庫成功', JSON.stringify(first));

      const setupScript = `
        process.env.POS_DB_PATH = ${JSON.stringify(dbPath)};
        const { initDb, getDb } = require(${JSON.stringify(path.join(__dirname, '..', 'utils', 'db.js'))});
        (async () => {
          await initDb();
          const db = getDb();
          db._db.run("INSERT INTO line_cart_handoff_tokens (token, store_id, status, purpose, cart_code, line_user_id, recovery_page_type, created_at, expires_at) VALUES ('mixed-token','store_001','opened','recovery_resume','MIXEDCODE','Umixed','popup_order','2099-01-01 00:00:00','2099-01-02 00:00:00')");
          const tokenId = db.get("SELECT id FROM line_cart_handoff_tokens WHERE token='mixed-token'").id;
          db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('mixh1','store_001',?, 'Umixed','sess1','d1','consumed','2099-01-01 00:00:00','2099-01-01 00:05:00','2099-01-01 00:01:00')", [tokenId]);
          db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('mixh2','store_001',?, 'Umixed','sess1','d2','superseded','2099-01-01 00:00:00','2099-01-01 00:05:00','')", [tokenId]);
          db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('mixh3','store_001',?, 'Umixed','sess1','d3','prepared','2099-01-01 00:00:00','2099-01-01 00:05:00','')", [tokenId]);
          db._save();
          console.log('SETUP_OK');
          // 再試著插入第二筆 prepared——這次不 DROP index，應該被真正拒絕。
          try {
            db._db.run("INSERT INTO popup_restore_receipts (receipt_hash, store_id, token_id, line_user_id, popup_session_public_code, cart_digest, status, issued_at, expires_at, consumed_at) VALUES ('mixh4','store_001',?, 'Umixed','sess1','d4','prepared','2099-01-01 00:00:00','2099-01-01 00:05:00','')", [tokenId]);
            console.log('SECOND_PREPARED_INSERT_SUCCEEDED_BAD');
          } catch (e) {
            console.log('SECOND_PREPARED_INSERT_REJECTED_GOOD:' + e.message);
          }
        })().catch((e) => { console.error('SETUP_FAILED:' + e.message); process.exit(1); });
      `;
      const out = execFileSync(process.execPath, ['-e', setupScript], { encoding: 'utf8', timeout: 30000 });
      assert(out.includes('SETUP_OK'), '4-mixed-one-prepared-plus-others 一筆 prepared + consumed + superseded 混合資料可以正常共存', out);
      assert(out.includes('SECOND_PREPARED_INSERT_REJECTED_GOOD'), '5-second-prepared-rejected 同一個 token 再插入第二筆 prepared 被 DB 拒絕', out);
      assert(!out.includes('SECOND_PREPARED_INSERT_SUCCEEDED_BAD'), '5-second-prepared-not-succeeded 確認第二筆 prepared 沒有意外插入成功', out);

      const nextInit = runFreshInitDb(dbPath);
      assert(nextInit.exitCode === 0, '4-mixed-no-false-positive 這種合法的混合狀態不會被誤判成衝突，冷啟動仍然成功', JSON.stringify(nextInit));
    } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
