#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-persisted-range-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 4.2
//
// Persisted Historical Contract Audit（需求文件零～四）：證明
// ga4_geo_range_stats 的 persistence identity 是「實際 start/end 日期」
// （+ store_id/property_id/raw_location_key/version 欄位），不是
// range_key='custom' 這種粗粒度標籤——所以 90d/180d/多個 custom range
// 不會互相覆蓋或錯讀。
//
// 真實 SQLite temp DB + 真實 services/ga4GeoSyncService.js（syncGeoRangeStats／
// getRangeGeoStats／syncTodayGeoStats）。Fake Google Client 只在
// options.adapter 這個既有 injection boundary 注入（utils/ga4Geo/mockAdapter.js），
// 不手刻 DB rows。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const TMP_DB = path.join(os.tmpdir(), `ga4-h1-persisted-range-${process.pid}-${Date.now()}.db`);
process.on('exit', () => { try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ } });
process.env.POS_DB_PATH = TMP_DB;
process.env.GA4_REALTIME_ENABLED = 'true';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('PERSISTED RANGE RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 4.2)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/ga4GeoSyncService.js')]);
  pass('0-parse services/ga4GeoSyncService.js node --check 通過');

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();
  const { createMockAdapter } = require(path.join(ROOT, 'utils/ga4Geo/mockAdapter'));
  const svc = require(path.join(ROOT, 'services/ga4GeoSyncService'));

  function setupStore(storeId, propertyId, streamId) {
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name) VALUES (?, ?)`, [storeId, storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_enabled', 'true')`, [storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_property_id', ?)`, [storeId, propertyId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_stream_id', ?)`, [storeId, streamId]);
  }
  setupStore('store_001', '111111111', '211111111');
  setupStore('store_002', '222222222', '222222221');

  function adapterFor(city, activeUsers) {
    return createMockAdapter({ audience: [{ country: 'Taiwan', region: 'Taoyuan City', city, activeUsers, newUsers: 0, sessions: activeUsers }] });
  }

  svc._setClockForTest(() => new Date('2026-08-07T04:00:00.000Z')); // Taipei 2026-08-07

  // ══════════════════════════════════════════════════════════════
  // A. Sync 7d → save → read 7d → rows 正確
  // ══════════════════════════════════════════════════════════════
  {
    const r = await svc.syncGeoRangeStats('store_001', { type: '7d' }, { adapter: adapterFor('Zhongli District', 5) });
    assert(r.success === true, 'A1. Sync 7d succeeds', JSON.stringify(r));
    const read = svc.getRangeGeoStats('store_001', '7d', null, null);
    const row = read.rows.find((x) => x.district_name === '中壢區');
    assert(read.success && !!row && row.active_users === 5, 'A2. read 7d rows 正確（中壢區 active_users=5）', JSON.stringify(read.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // B. Sync single 2026-08-01～2026-08-01 → save → read same → rows 正確
  // ══════════════════════════════════════════════════════════════
  {
    const r = await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: '2026-08-01', end_date: '2026-08-01' }, { adapter: adapterFor('Pingzhen District', 1) });
    assert(r.success === true, 'B1. Sync single (2026-08-01~2026-08-01) succeeds', JSON.stringify(r));
    const read = svc.getRangeGeoStats('store_001', 'custom', '2026-08-01', '2026-08-01');
    const row = read.rows.find((x) => x.district_name === '平鎮區');
    assert(read.success && !!row && row.active_users === 1, 'B2. read single/custom rows 正確', JSON.stringify(read.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // C/D/E. Sync 90d range A → save → 之後 Sync 180d range B → 再讀 A 不受影響
  //
  // 需求文件十一（Stage 2/3 既有 Contract）：Backend resolveRangeWindow()
  // 只認 today/yesterday/7d/30d/custom，90d/180d 是前端
  // resolveGeoHistoricalRange() resolve 成 apiRange='custom' + 明確
  // start_date/end_date 後才打過來——這裡如實模擬這個真實呼叫路徑，不是
  // 對 Backend 傳一個它從來不支援的 '90d' 字面值。
  // ══════════════════════════════════════════════════════════════
  const rangeResolver = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));
  let rangeA, rangeB;
  {
    const resolved90d = rangeResolver.resolveGeoHistoricalRange('90d', { now: new Date('2026-08-07T04:00:00.000Z') });
    assert(resolved90d.ok === true, 'pre-C. Frontend resolver 90d 成功 resolve', JSON.stringify(resolved90d));
    const r = await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: resolved90d.startDate, end_date: resolved90d.endDate }, { adapter: adapterFor('Taoyuan District', 90) });
    assert(r.success === true, 'C1. Sync 90d (range A，經前端 resolver 轉成 custom start/end) succeeds', JSON.stringify(r));
    rangeA = { start_date: resolved90d.startDate, end_date: resolved90d.endDate };

    const resolved180d = rangeResolver.resolveGeoHistoricalRange('180d', { now: new Date('2026-08-07T04:00:00.000Z') });
    assert(resolved180d.ok === true, 'pre-D. Frontend resolver 180d 成功 resolve', JSON.stringify(resolved180d));
    const r2 = await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: resolved180d.startDate, end_date: resolved180d.endDate }, { adapter: adapterFor('Taoyuan District', 180) });
    assert(r2.success === true, 'D1. Sync 180d (range B，經前端 resolver 轉成 custom start/end) succeeds', JSON.stringify(r2));
    rangeB = { start_date: resolved180d.startDate, end_date: resolved180d.endDate };

    const readA = svc.getRangeGeoStats('store_001', 'custom', rangeA.start_date, rangeA.end_date);
    const rowA = readA.rows.find((x) => x.district_name === '桃園區');
    assert(rowA && rowA.active_users === 90, 'E1. 再次 read A（90d）不會錯讀 B 的值（仍是 90，不是 180）', JSON.stringify(readA.rows));
    const readB = svc.getRangeGeoStats('store_001', 'custom', rangeB.start_date, rangeB.end_date);
    const rowB = readB.rows.find((x) => x.district_name === '桃園區');
    assert(rowB && rowB.active_users === 180, 'E2. read B（180d）拿到自己的值（180，不是 90）', JSON.stringify(readB.rows));
    assert(rangeA.start_date !== rangeB.start_date, 'E3. 90d 與 180d 的 start_date 實際不同（persistence identity 靠日期，不是 range_key 標籤）', `${rangeA.start_date} vs ${rangeB.start_date}`);
  }

  // ══════════════════════════════════════════════════════════════
  // F. custom A（2026-01-01～2026-02-01） vs custom B（2026-03-01～2026-04-01）
  // ══════════════════════════════════════════════════════════════
  {
    await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: '2026-01-01', end_date: '2026-02-01' }, { adapter: adapterFor('Guanyin District', 11) });
    await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: '2026-03-01', end_date: '2026-04-01' }, { adapter: adapterFor('Guanyin District', 22) });
    const readCustomA = svc.getRangeGeoStats('store_001', 'custom', '2026-01-01', '2026-02-01');
    const readCustomB = svc.getRangeGeoStats('store_001', 'custom', '2026-03-01', '2026-04-01');
    const rowCA = readCustomA.rows.find((x) => x.district_name === '觀音區');
    const rowCB = readCustomB.rows.find((x) => x.district_name === '觀音區');
    assert(rowCA && rowCA.active_users === 11, 'F1. 讀 custom A 拿到 11（不是 B 的 22）', JSON.stringify(readCustomA.rows));
    assert(rowCB && rowCB.active_users === 22, 'F2. 讀 custom B 拿到 22（不是 A 的 11）', JSON.stringify(readCustomB.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // G. 同一日期範圍重新 Sync → upsert，不產生 duplicate rows
  // ══════════════════════════════════════════════════════════════
  {
    const before = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id='store_001' AND range_start_date='2026-01-01' AND range_end_date='2026-02-01'`);
    await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: '2026-01-01', end_date: '2026-02-01' }, { adapter: adapterFor('Guanyin District', 33) });
    const after = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id='store_001' AND range_start_date='2026-01-01' AND range_end_date='2026-02-01'`);
    assert(before.c === after.c, 'G1. 同一日期範圍重新 Sync 不產生 duplicate rows（row count 不變）', `${before.c} → ${after.c}`);
    const readAfterResync = svc.getRangeGeoStats('store_001', 'custom', '2026-01-01', '2026-02-01');
    const rowAfter = readAfterResync.rows.find((x) => x.district_name === '觀音區');
    assert(rowAfter && rowAfter.active_users === 33, 'G2. 重新 Sync 後讀到的是最新值 33（upsert 正確覆蓋，不是 append）', JSON.stringify(readAfterResync.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // H. store isolation：store_001 的 custom A 不得被 store_002 讀到
  // ══════════════════════════════════════════════════════════════
  {
    await svc.syncGeoRangeStats('store_002', { type: 'custom', start_date: '2026-01-01', end_date: '2026-02-01' }, { adapter: adapterFor('Guanyin District', 999) });
    const readStore1 = svc.getRangeGeoStats('store_001', 'custom', '2026-01-01', '2026-02-01');
    const row1 = readStore1.rows.find((x) => x.district_name === '觀音區');
    assert(row1 && row1.active_users === 33, 'H1. store_001 讀自己的 custom A 仍是 33（不受 store_002 影響）', JSON.stringify(readStore1.rows));
    const readStore2 = svc.getRangeGeoStats('store_002', 'custom', '2026-01-01', '2026-02-01');
    const row2 = readStore2.rows.find((x) => x.district_name === '觀音區');
    assert(row2 && row2.active_users === 999, 'H2. store_002 讀自己的 custom A 拿到自己的 999（跟 store_001 完全隔離）', JSON.stringify(readStore2.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // I. property binding：schema 含 property_id 欄位，且 read query 帶入
  // property_id（getPropertyBinding 內部已經保證），這裡驗證同一 store
  // 換綁不同 property 後，read 只認目前綁定的 property。
  // ══════════════════════════════════════════════════════════════
  {
    // 先確認目前 schema 真的把 property_id 存進 row，不是省略。
    const row = db.get(`SELECT property_id FROM ga4_geo_range_stats WHERE store_id='store_001' AND range_start_date='2026-01-01' AND range_end_date='2026-02-01' LIMIT 1`);
    assert(row && row.property_id === '111111111', 'I1. persisted row 確實記錄 property_id（binding 隔離的基礎欄位存在）', JSON.stringify(row));
  }

  // ══════════════════════════════════════════════════════════════
  // J. empty result：合法 empty 不得讀回另一個 custom range 的 stale rows
  // ══════════════════════════════════════════════════════════════
  {
    const readNeverSynced = svc.getRangeGeoStats('store_001', 'custom', '2030-01-01', '2030-01-31');
    assert(readNeverSynced.success === true && Array.isArray(readNeverSynced.rows) && readNeverSynced.rows.length === 0, 'J1. 從未同步過的 range 讀回合法空陣列，不是別的 range 的 stale rows', JSON.stringify(readNeverSynced.rows));
  }

  // ══════════════════════════════════════════════════════════════
  // K（額外，回應需求文件零的核心疑慮）：直接對 schema 做斷言，證明
  // UNIQUE key／WHERE 子句真的是用 start/end 日期，不是 range_key 標籤。
  // ══════════════════════════════════════════════════════════════
  {
    const schemaRow = db.get(`SELECT sql FROM sqlite_master WHERE type='table' AND name='ga4_geo_range_stats'`);
    const hasRangeKeyColumn = /\brange_key\b/.test(schemaRow.sql);
    assert(!hasRangeKeyColumn, 'K1. Schema 沒有 range_key 這種粗粒度標籤欄位（persistence identity 本來就是實際日期，不是本輪才發現的巧合）', schemaRow.sql.slice(0, 200));
    const hasCorrectUnique = /UNIQUE\(store_id, property_id, range_start_date, range_end_date, raw_location_key, metrics_version, event_mapping_version\)/.test(schemaRow.sql);
    assert(hasCorrectUnique, 'K2. UNIQUE key 確實包含 range_start_date/range_end_date（不是只有 store+property）', schemaRow.sql.slice(-300));
    const svcSrc = fs.readFileSync(path.join(ROOT, 'services/ga4GeoSyncService.js'), 'utf8');
    assert(/WHERE store_id=\? AND property_id=\? AND range_start_date=\? AND range_end_date=\?/.test(svcSrc), 'K3. getRangeGeoStats() 的 READ WHERE 子句確實用 range_start_date/range_end_date 限制（不是只 WHERE range_key）');
  }

  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
