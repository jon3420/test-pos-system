#!/usr/bin/env node
// scripts/backfill-geo-visit-log.js — fix18-10-hotfix30-B5-R5.3-A3
//
// Single Source of Truth 補洞：`geo_visit_log` 從 R5.3-A1.2 才開始透過
// `utils/analyticsLog.js` 的 `insertEvent()` hook 同步寫入。任何在這個
// hook 存在「之前」就已經寫進 `analytics_events` 的歷史事件，從來沒有機會
// 觸發過這個 hook，所以完全沒有對應的 `geo_visit_log` 列——這是「Analytics
// Dashboard 有正確資料，但 Geo Intelligence 顯示 0」最可能的根因之一
// （見 R5.3-A3_ANALYTICS_DATA_FLOW_AUDIT.md）。
//
// 這支腳本不是第二套統計邏輯，只是把既有 `insertEvent()` 寫入路徑「本來
// 就會做的事」，對歷史資料補跑一次：讀取 `analytics_events` 既有欄位
// （event_name/visitor_id/session_id/geo_city/geo_district/geo_source/
// order_id/created_at），呼叫既有 `utils/geoVisitLog.js` 的 `logGeoVisit()`
// 寫入對應列——跟即時寫入路徑呼叫的是同一個函式，同一套邏輯。
//
// 冪等（可重複執行、安全）：用 `source_event_id` 追蹤「這筆 analytics_events
// 是否已經同步過」，只處理 `geo_visit_log` 裡還沒有對應 `source_event_id`
// 的歷史事件，不會重複寫入、不會產生兩倍計數。
//
// 用法：
//   node scripts/backfill-geo-visit-log.js [--store=<store_id>] [--dry-run]
//   不帶 --store 時，對資料庫內所有 store_id 執行。
//   --dry-run 只印出將會補寫的筆數，不實際寫入。

'use strict';

const { initDb, getDb } = require('../utils/db');
const { logGeoVisit } = require('../utils/geoVisitLog');

function parseArgs(argv) {
  const args = { store: null, dryRun: false };
  argv.forEach((a) => {
    if (a === '--dry-run') args.dryRun = true;
    else if (a.startsWith('--store=')) args.store = a.slice('--store='.length);
  });
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  await initDb();
  const db = getDb();

  // 找出所有「已經寫進 analytics_events，但 geo_visit_log 裡完全沒有對應
  // source_event_id」的歷史事件——這正是 hook 部署之前留下的資料缺口。
  const storeClause = args.store ? 'AND ae.store_id = ?' : '';
  const params = args.store ? [args.store] : [];
  const pending = db.all(
    `SELECT ae.id, ae.store_id, ae.visitor_id, ae.session_id, ae.event_name, ae.created_at,
            ae.order_id, ae.geo_city, ae.geo_district, ae.geo_country, ae.geo_source
     FROM analytics_events ae
     WHERE NOT EXISTS (
       SELECT 1 FROM geo_visit_log gvl WHERE gvl.source_event_id = ae.id
     ) ${storeClause}
     ORDER BY ae.id ASC`,
    params
  ) || [];

  console.log(`[backfill] 找到 ${pending.length} 筆尚未同步到 geo_visit_log 的歷史事件${args.store ? `（store_id=${args.store}）` : '（全部店家）'}。`);

  if (args.dryRun) {
    console.log('[backfill] --dry-run 模式，不實際寫入。');
    const byStore = {};
    pending.forEach((r) => { byStore[r.store_id] = (byStore[r.store_id] || 0) + 1; });
    Object.entries(byStore).forEach(([storeId, count]) => console.log(`  - ${storeId}: ${count} 筆`));
    return;
  }

  let ok = 0; let failed = 0;
  pending.forEach((row) => {
    const success = logGeoVisit(db, {
      store_id: row.store_id,
      visitor_id: row.visitor_id,
      session_id: row.session_id,
      event_name: row.event_name,
      event_time: row.created_at,
      geo_city: row.geo_city,
      geo_district: row.geo_district,
      geo_country: row.geo_country,
      geo_source: row.geo_source,
      order_id: row.order_id,
      source_event_id: row.id,
    });
    if (success) ok += 1; else failed += 1;
  });

  console.log(`[backfill] 完成：成功補寫 ${ok} 筆，失敗 ${failed} 筆（失敗的事件不影響既有 analytics_events，可重新執行本腳本再次嘗試，已同步過的不會重複寫入）。`);
}

main().catch((e) => {
  console.error('[backfill] 執行失敗：', e.message);
  process.exitCode = 1;
});
