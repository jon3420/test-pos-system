#!/usr/bin/env node
// scripts/backfill-hotfix31-r4-identity-links.js — fix18-10-hotfix31-R4
//
// 安全、可選的身份連結回填工具（需求文件 F/I）。
//
// 用法：
//   node scripts/backfill-hotfix31-r4-identity-links.js --store=store_001
//     → dry-run（預設，不寫入任何資料，只回報「會連結幾筆」）
//   node scripts/backfill-hotfix31-r4-identity-links.js --store=store_001 --apply
//     → 真的寫入 line_member_sessions（需要明確帶 --apply，不會不小心誤觸發）
//   node scripts/backfill-hotfix31-r4-identity-links.js --store=all
//     → 掃描資料庫內所有出現過的 store_id（一律各自獨立處理，不跨店比對）
//
// 本腳本不會在伺服器啟動流程中被呼叫（見 server.js），必須由人手動執行。
// 本次任務僅在本機測試用資料庫上執行，不對任何正式環境資料寫入。

'use strict';

const { initDb, getDb } = require('../utils/db');
const { backfillIdentityLinks } = require('../utils/identityBackfill');

function parseArgs(argv) {
  const out = { store: null, apply: false };
  argv.forEach((a) => {
    if (a === '--apply') out.apply = true;
    else if (a.startsWith('--store=')) out.store = a.slice('--store='.length);
  });
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.store) {
    console.error('用法：node scripts/backfill-hotfix31-r4-identity-links.js --store=<store_id|all> [--apply]');
    process.exitCode = 1;
    return;
  }

  await initDb();
  const db = getDb();

  let storeIds;
  if (args.store === 'all') {
    const rows = db.all('SELECT DISTINCT store_id FROM line_members');
    storeIds = rows.map((r) => r.store_id).filter(Boolean);
    if (!storeIds.length) {
      console.log('沒有任何店家有 LINE 會員資料，無需回填。');
      return;
    }
  } else {
    storeIds = [args.store];
  }

  console.log(`模式：${args.apply ? 'APPLY（會寫入資料庫）' : 'DRY-RUN（不會寫入，僅回報）'}`);
  console.log(`範圍店家：${storeIds.join(', ')}`);
  console.log('');

  const results = backfillIdentityLinks(db, storeIds, { apply: args.apply });
  let totalScanned = 0, totalLinked = 0, totalAlready = 0, totalUnresolved = 0, totalErrors = 0;

  results.forEach((r) => {
    console.log(`── store_id=${r.store_id} ──`);
    console.log(`  scanned=${r.scanned} linked=${r.linked} already_linked=${r.already_linked} unresolved=${r.unresolved} skipped=${r.skipped} errors=${r.errors}`);
    if (r.details.length) {
      r.details.slice(0, 20).forEach((d) => console.log('  detail:', JSON.stringify(d)));
      if (r.details.length > 20) console.log(`  ...（其餘 ${r.details.length - 20} 筆詳情省略）`);
    }
    totalScanned += r.scanned; totalLinked += r.linked; totalAlready += r.already_linked;
    totalUnresolved += r.unresolved; totalErrors += r.errors;
  });

  console.log('');
  console.log(`合計：scanned=${totalScanned} linked=${totalLinked} already_linked=${totalAlready} unresolved=${totalUnresolved} errors=${totalErrors}`);
  if (!args.apply) {
    console.log('這是 dry-run 結果，尚未寫入任何資料。確認無誤後，加上 --apply 才會真的寫入。');
  }
}

main().catch((e) => {
  console.error('[backfill] 執行失敗：', e.message, e.stack);
  process.exitCode = 1;
});
