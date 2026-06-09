#!/usr/bin/env node
// scripts/migrate-preorder.js
// ──────────────────────────────────────────────────────────
// 用途：為 products 表補上 LINE 預購數量欄位
//       可在 Zeabur Console 執行，不清空任何資料
//
// 執行方式：
//   node scripts/migrate-preorder.js
// ──────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const fs   = require('fs');

// ── 1. 找 DB 路徑 ────────────────────────────────────────
//   優先順序：
//     a. 環境變數 DB_PATH
//     b. 專案根目錄 data/pos.db（與 utils/db.js 一致）
//     c. 當前工作目錄 data/pos.db

const candidates = [
  process.env.DB_PATH,
  path.join(__dirname, '../data/pos.db'),
  path.join(process.cwd(), 'data/pos.db'),
  path.join(__dirname, '../pos.db'),
  path.join(process.cwd(), 'pos.db'),
].filter(Boolean);

let DB_PATH = null;
for (const p of candidates) {
  if (fs.existsSync(p)) { DB_PATH = p; break; }
}

if (!DB_PATH) {
  console.error('❌ 找不到 SQLite 資料庫。嘗試的路徑：');
  candidates.forEach(p => console.error('   ', p));
  console.error('\n請設定環境變數 DB_PATH 指向實際 .db 檔案路徑後重新執行。');
  process.exit(1);
}

console.log('✅ DB 路徑：', DB_PATH);

// ── 2. 開啟 DB（sql.js，與主程式相同） ──────────────────
let initSqlJs;
try {
  initSqlJs = require('sql.js');
} catch (e) {
  console.error('❌ 無法載入 sql.js，請先執行 npm install');
  process.exit(1);
}

async function main() {
  const SQL    = await initSqlJs();
  const buf    = fs.readFileSync(DB_PATH);
  const sqlDb  = new SQL.Database(buf);

  function save() {
    const out = sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(out));
  }

  function run(sql, params = []) {
    sqlDb.run(sql, params);
  }

  function all(sql, params = []) {
    const stmt = sqlDb.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  // ── 3. 取得目前 products 表欄位清單 ─────────────────────
  const colRows    = all('PRAGMA table_info(products)');
  const existCols  = new Set(colRows.map(r => r.name));

  console.log('\n── products 表現有欄位（共 ' + colRows.length + ' 個）─────────────────');
  colRows.forEach(r => process.stdout.write(r.name + '  '));
  console.log('\n');

  // ── 4. 要補上的 preorder 欄位定義 ───────────────────────
  const PREORDER_COLS = [
    { name: 'line_preorder_enabled',       type: 'INTEGER DEFAULT 0' },
    { name: 'line_preorder_daily',         type: 'INTEGER DEFAULT 0' },
    { name: 'line_preorder_sold',          type: 'INTEGER DEFAULT 0' },
    { name: 'line_preorder_low_threshold', type: 'INTEGER DEFAULT 0' },
    { name: 'line_preorder_high_threshold',type: 'INTEGER DEFAULT 0' },
  ];

  // ── 5. 逐一 ALTER TABLE，缺少才補 ───────────────────────
  console.log('── Migration ───────────────────────────────────────────');
  let added = 0, skipped = 0;

  for (const col of PREORDER_COLS) {
    if (existCols.has(col.name)) {
      console.log(`  SKIP  ${col.name}（已存在）`);
      skipped++;
    } else {
      try {
        run(`ALTER TABLE products ADD COLUMN ${col.name} ${col.type}`);
        console.log(`  ADD   ${col.name}  ✅`);
        added++;
      } catch (e) {
        console.error(`  ERROR ${col.name}：`, e.message);
      }
    }
  }

  if (added > 0) {
    save();
    console.log(`\n💾 已寫回 DB（新增 ${added} 個欄位）`);
  } else {
    console.log('\n✅ 所有欄位均已存在，DB 無需修改。');
  }

  // ── 6. 驗證：確認 5 個欄位全部存在 ─────────────────────
  console.log('\n── 驗證：PRAGMA table_info(products) ──────────────────');
  const afterCols  = all('PRAGMA table_info(products)').map(r => r.name);
  const preorderOk = PREORDER_COLS.every(c => afterCols.includes(c.name));

  PREORDER_COLS.forEach(c => {
    const ok = afterCols.includes(c.name);
    console.log(`  ${ok ? '✅' : '❌'} ${c.name}`);
  });

  // ── 7. 驗證：SELECT 前 5 筆資料 ─────────────────────────
  console.log('\n── 驗證：SELECT 前 5 筆 preorder 欄位 ─────────────────');
  if (preorderOk) {
    const rows = all(
      'SELECT id, name, line_preorder_enabled, line_preorder_daily, line_preorder_sold ' +
      'FROM products LIMIT 5'
    );
    if (rows.length === 0) {
      console.log('  （products 表目前無資料）');
    } else {
      console.log('  id  | name                     | enabled | daily | sold');
      console.log('  ' + '-'.repeat(58));
      rows.forEach(r => {
        const name = (r.name || '').padEnd(24).slice(0, 24);
        console.log(
          `  ${String(r.id).padEnd(3)} | ${name} | ${r.line_preorder_enabled}       | ${r.line_preorder_daily}     | ${r.line_preorder_sold}`
        );
      });
    }
  } else {
    console.error('  ❌ 部分欄位仍不存在，請查看上方錯誤訊息。');
  }

  // ── 8. 確認 line_quota_* 欄位未受影響 ───────────────────
  console.log('\n── 確認 line_quota_* 欄位未受影響 ─────────────────────');
  const quotaCols = ['line_quota_enabled','line_quota_daily','line_quota_sold',
                     'line_quota_low_threshold','line_quota_high_threshold'];
  quotaCols.forEach(c => {
    const ok = afterCols.includes(c);
    console.log(`  ${ok ? '✅' : '⚠️ '} ${c}`);
  });

  sqlDb.close();

  console.log('\n' + '─'.repeat(60));
  if (preorderOk) {
    console.log('✅ Migration 完成。可正常使用預購數量管理功能。');
  } else {
    console.log('❌ Migration 未完全成功，請檢查上方錯誤訊息。');
    process.exit(1);
  }
}

main().catch(e => {
  console.error('❌ 執行失敗：', e.message || e);
  process.exit(1);
});
