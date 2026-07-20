#!/usr/bin/env node
// scripts/migrate-hotfix30-a-product-mode.js
// ──────────────────────────────────────────────────────────
// fix18-10-hotfix30-A：LINE 點餐單一商品入口 × 結帳選擇外帶外送
// 用途：為 products 表補上「商品是否啟用外帶／外送」欄位
//       （需求文件第五點：getProductAvailableModes 判斷依據之一）
//       預設值皆為 1（啟用），對既有商品行為零影響，
//       商家/後台若要設定「某商品僅外帶」或「某商品僅外送」，
//       未來可直接寫入這兩欄。不清空任何資料，可重複執行。
//
// 執行方式：
//   node scripts/migrate-hotfix30-a-product-mode.js
// ──────────────────────────────────────────────────────────

'use strict';

const path = require('path');
const fs   = require('fs');

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

let initSqlJs;
try {
  initSqlJs = require('sql.js');
} catch (e) {
  console.error('❌ 無法載入 sql.js，請先執行 npm install');
  process.exit(1);
}

async function main() {
  const SQL   = await initSqlJs();
  const buf   = fs.readFileSync(DB_PATH);
  const sqlDb = new SQL.Database(buf);

  function save() {
    const out = sqlDb.export();
    fs.writeFileSync(DB_PATH, Buffer.from(out));
  }
  function run(sql, params = []) { sqlDb.run(sql, params); }
  function all(sql, params = []) {
    const stmt = sqlDb.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }

  const colRows   = all('PRAGMA table_info(products)');
  const existCols = new Set(colRows.map(r => r.name));

  console.log('\n── products 表現有欄位（共 ' + colRows.length + ' 個）─────────────────');
  colRows.forEach(r => process.stdout.write(r.name + '  '));
  console.log('\n');

  const MODE_COLS = [
    { name: 'line_takeout_enabled',  type: 'INTEGER DEFAULT 1' },
    { name: 'line_delivery_enabled', type: 'INTEGER DEFAULT 1' },
  ];

  console.log('── Migration ───────────────────────────────────────────');
  let added = 0, skipped = 0;

  for (const col of MODE_COLS) {
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

  // 既有資料若欄位值為 NULL（例如欄位是舊版直接用 SQL 手動加的），一律補正為 1（啟用），
  // 確保「零設定＝維持原行為」。
  try {
    run(`UPDATE products SET line_takeout_enabled=1 WHERE line_takeout_enabled IS NULL`);
    run(`UPDATE products SET line_delivery_enabled=1 WHERE line_delivery_enabled IS NULL`);
  } catch (e) {
    console.error('  ERROR 補正 NULL 值：', e.message);
  }

  if (added > 0) {
    save();
    console.log(`\n💾 已寫回 DB（新增 ${added} 個欄位）`);
  } else {
    console.log('\n✅ 所有欄位均已存在，DB 無需修改。');
    save(); // 仍儲存，以套用上面的 NULL 補正
  }

  console.log('\n── 驗證：PRAGMA table_info(products) ──────────────────');
  const afterCols = all('PRAGMA table_info(products)').map(r => r.name);
  MODE_COLS.forEach(c => {
    const ok = afterCols.includes(c.name);
    console.log(`  ${ok ? '✅' : '❌'} ${c.name}`);
  });

  console.log('\n── 驗證：SELECT 前 5 筆 ────────────────────────────────');
  const rows = all('SELECT id, name, line_takeout_enabled, line_delivery_enabled FROM products LIMIT 5');
  if (rows.length === 0) {
    console.log('  （products 表目前無資料）');
  } else {
    rows.forEach(r => console.log(`  #${r.id} ${r.name}: takeout=${r.line_takeout_enabled} delivery=${r.line_delivery_enabled}`));
  }

  console.log('\n✅ Migration 完成。');
}

main().catch(e => { console.error('❌ Migration 失敗：', e); process.exit(1); });
