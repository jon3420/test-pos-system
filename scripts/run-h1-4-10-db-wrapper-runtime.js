#!/usr/bin/env node
// scripts/run-h1-4-10-db-wrapper-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-N8N-QA-FRIEND-SECRET-UX
//
// ══════════════════════════════════════════════════════════════════
// BASELINE HYGIENE FIX — 這不是 TASK A（Secret UI）也不是 TASK B（Friend
// Guide）。這是全面回歸測試過程中，在完全獨立、未經任何本輪修改的 frozen
// baseline ZIP 上兩次可重現地確認的既有 latent bug：
//
//   utils/db.js 的 initTables() 內，line_preorder_* 欄位 migration 那段
//   誤用了 w._db.all(...)——w._db 是「原始 sql.js Database 實例」，sql.js
//   從來就沒有 .all() 這個方法（只有 .run()/.exec()/.prepare()），這是
//   sql.js 本身的 API 現實，不是版本漂移。同一份檔案裡另外 17 處全部正確
//   使用 w.all(...)（initTables 裡 wrap() 回傳的 wrapper 物件自己實作的
//   .all()，見 utils/db.js 第 36-43 行），只有這一行是孤立的打字錯誤。
//
// Baseline Reproduction Audit（獨立解壓原始 ZIP、npm ci、乾淨 DB 環境）：
//   - utils/db.js 本輪修改前 SHA256 與 frozen baseline 完全一致，證明
//     Task A / Task B 完全沒有動過這個檔案。
//   - frozen baseline 兩次 fresh-run node scripts/smoke-hotfix29-c.js，
//     輸出 byte-for-byte 相同：自身 54 PASS / 0 FAIL / 2 MANUAL REQUIRED
//     （這部分完全符合預期 baseline），但其內部鏈式重跑的四支更早期
//     regression（smoke-hotfix27-cd.js／smoke-hotfix28.js／
//     smoke-hotfix29.js／smoke-hotfix29-b.js）全部因為同一個
//     `w._db.all is not a function` TypeError 而 exit code 1。
//
// 這裡只驗證這一行修正本身，不重新測整支 smoke-hotfix29-c（那支測試本身
// 見 scripts/smoke-hotfix29-c.js，本檔不重複實作）。
// ══════════════════════════════════════════════════════════════════

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function main() {
  console.log('== BASELINE HYGIENE FIX：utils/db.js w._db.all → w.all ==');

  // ────────────────────────────────────────────────────────────
  // DB-WRAPPER-4：production 原始碼裡不再存在 w._db.all( 這個誤用模式
  // （靜態確認，最直接、最不會誤判的檢查，先做這個）。
  // ────────────────────────────────────────────────────────────
  {
    const src = fs.readFileSync(path.join(ROOT, 'utils/db.js'), 'utf8');
    const matches = src.match(/w\._db\.all\(/g) || [];
    assert(matches.length === 0, 'DB-WRAPPER-4 utils/db.js 原始碼裡 w._db.all( 出現次數 = 0（已修正，且沒有殘留任何其他誤用）', `found=${matches.length}`);
    // 順便確認正確的 w.all( 用法數量沒有被誤刪（應該是原本 17 處 + 這次修正的 1 處 = 18 處）。
    const correctMatches = src.match(/(?<!_db\.)\bw\.all\(/g) || [];
    assert(correctMatches.length >= 18, `DB-WRAPPER-4b w.all( 正確用法至少 18 處（含這次修正的那一處），實際=${correctMatches.length}`);
  }

  // ────────────────────────────────────────────────────────────
  // DB-WRAPPER-1／2／3：真正跑一次 fresh initDb()，用隔離的臨時 DB 檔案
  // （透過 POS_DB_PATH env override，不動到專案本身的 data/pos.db），
  // 確認：
  //   1. 不會因為 products PRAGMA 而 crash（不拋出未被捕捉的例外）
  //   2. w.all('PRAGMA table_info(products)') 真的回傳 row objects，且
  //      每個 row 都有 name 欄位
  //   3. line_preorder_* 相關 migration 在全新 DB 上正常跑完（因為是全新
  //      DB，所有 line_preorder_* 欄位一開始就不存在，這裡驗證的正是
  //      「補建」路徑真的會執行、不會被那個 TypeError 擋住）
  // ────────────────────────────────────────────────────────────
  {
    const tmpDbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-wrapper-test-'));
    const tmpDbPath = path.join(tmpDbDir, 'pos-test.db');
    const consoleErrors = [];
    const origConsoleError = console.error;
    console.error = (...args) => { consoleErrors.push(args.map(String).join(' ')); origConsoleError.apply(console, args); };

    let initDb, getDb;
    let initThrew = null;
    let w = null;
    try {
      process.env.POS_DB_PATH = tmpDbPath;
      // 每次都要求全新 module instance（utils/db.js 用 module-level
      // wrappedDb 快取單例），避免吃到其他測試檔案已經 initDb() 過的舊實例。
      const dbModulePath = require.resolve(path.join(ROOT, 'utils/db.js'));
      delete require.cache[dbModulePath];
      ({ initDb, getDb } = require(dbModulePath));
      w = await initDb();
    } catch (e) {
      initThrew = e;
    } finally {
      console.error = origConsoleError;
      delete process.env.POS_DB_PATH;
    }

    // DB-WRAPPER-1
    assert(initThrew === null, 'DB-WRAPPER-1 fresh initDb() 在全新、隔離的臨時 DB 上完整跑完，不拋出未捕捉例外', initThrew ? String(initThrew && initThrew.stack) : '');
    const pragmaErrorLogs = consoleErrors.filter((l) => l.includes('PRAGMA table_info(products)') && l.includes('失敗'));
    assert(pragmaErrorLogs.length === 0, 'DB-WRAPPER-1b initDb() 過程中 console.error 沒有再出現「PRAGMA table_info(products) 失敗」（修正前這裡一定會印出來）', `count=${pragmaErrorLogs.length}`);

    // DB-WRAPPER-2：直接在同一個 wrapper 上重跑一次同樣的 PRAGMA 查詢，
    // 驗證它真的回傳 row objects、且有 name 欄位可用（不是只驗證「沒 crash」
    // 這種消極結果，而是驗證「回傳值真的可用」這個積極結果）。
    if (w) {
      let rows = null;
      let pragmaThrew = null;
      try { rows = w.all('PRAGMA table_info(products)'); } catch (e) { pragmaThrew = e; }
      assert(pragmaThrew === null, 'DB-WRAPPER-2 w.all(\'PRAGMA table_info(products)\') 直接呼叫不拋出例外', pragmaThrew ? String(pragmaThrew) : '');
      assert(Array.isArray(rows) && rows.length > 0, 'DB-WRAPPER-2b 回傳值是非空陣列（products 表本身有欄位）', `rows=${JSON.stringify(rows) && (Array.isArray(rows) ? rows.length : typeof rows)}`);
      const names = Array.isArray(rows) ? rows.map((r) => r.name) : [];
      assert(names.every((n) => typeof n === 'string' && n.length > 0), 'DB-WRAPPER-2c 每個 row 都有非空字串的 name 欄位（.map(r => r.name) 可正常使用）');
      assert(names.includes('id') && names.includes('store_id'), 'DB-WRAPPER-2d 回傳的欄位名稱包含預期的既有欄位（id／store_id），證明真的讀到 products 表結構，不是空殼');

      // DB-WRAPPER-3：line_preorder_* 欄位在全新 DB 上應該已經被補建完成
      // （因為是全新建表，一開始就不存在，migration 應該會把它們全部加上）。
      const preorderCols = ['line_preorder_enabled', 'line_preorder_daily', 'line_preorder_sold', 'line_preorder_low_threshold', 'line_preorder_high_threshold'];
      const missing = preorderCols.filter((c) => !names.includes(c));
      assert(missing.length === 0, 'DB-WRAPPER-3 line_preorder_* 五個欄位全部在全新 DB 的 products 表上成功補建（migration 路徑真的執行了，不是被那個 TypeError 擋在 catch 區塊裡從沒跑到）', `missing=${JSON.stringify(missing)}`);
    } else {
      fail('DB-WRAPPER-2', 'initDb() 失敗，wrapper 物件不存在，無法繼續驗證');
      fail('DB-WRAPPER-3', 'initDb() 失敗，wrapper 物件不存在，無法繼續驗證');
    }

    try { fs.rmSync(tmpDbDir, { recursive: true, force: true }); } catch (e) {}
  }

  console.log('\n== DB-WRAPPER Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch((e) => { console.error('DB-WRAPPER test runner crashed:', e); process.exit(1); });
