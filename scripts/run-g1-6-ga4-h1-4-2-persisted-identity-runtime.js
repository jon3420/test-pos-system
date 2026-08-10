#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX
//
// Persisted Identity Round-Trip — 針對本輪 Issue 1 Reality Audit 的核心
// 問題「D. 正式 persisted store 是否存在該 identity？E. 如果不存在，是
// 沒同步過還是 identity mismatch？」，用真正的 services/ga4GeoSyncService.js
// + 真正 SQLite temp DB（不是 fixture mock），對全部 10 種 Dashboard Range
// mode 逐一證明：
//
//   Manual Sync 寫入時用的 identity（apiRange + start_date/end_date）
//   ===
//   Dashboard GET 讀取時用的 identity
//
// 兩者是否完全一致（同一個 resolveGeoHistoricalRange() 呼叫結果，分別餵給
// syncGeoRangeStats() 與 getRangeGeoStats()，跟 routes/ga4-geo.js 的真實
// 呼叫方式一致：GET 用 ALLOWED_RANGES 白名單 + start_date/end_date；
// today/yesterday/7d/30d 由 Backend resolveRangeWindow() 用自己的 server
// clock 重新算 window，90d/180d/this_year/last_year/single/custom 全部走
// apiRange='custom'，Backend 直接信任前端傳來的 start_date/end_date）。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const TMP_DB = path.join(os.tmpdir(), `ga4-h1-4-2-identity-${process.pid}-${Date.now()}.db`);
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
  console.log('H1.4.2 PERSISTED IDENTITY ROUND-TRIP SUMMARY');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  return { pass: p, fail: f, total: results.length };
}

async function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/ga4GeoSyncService.js')]);
  pass('0-parse services/ga4GeoSyncService.js node --check 通過');

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();
  const { createMockAdapter } = require(path.join(ROOT, 'utils/ga4Geo/mockAdapter'));
  const svc = require(path.join(ROOT, 'services/ga4GeoSyncService'));
  const rangeResolver = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));

  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name) VALUES ('store_h142', 'store_h142')`);
  db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_h142', 'ga4_realtime_enabled', 'true')`);
  db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_h142', 'ga4_realtime_property_id', '999999999')`);
  db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES ('store_h142', 'ga4_realtime_stream_id', '999999991')`);

  const NOW = new Date('2026-08-10T04:00:00.000Z'); // Taipei 2026-08-10 12:00
  svc._setClockForTest(() => NOW);

  function adapterFor(city, activeUsers) {
    return createMockAdapter({ audience: [{ country: 'Taiwan', region: 'Taoyuan City', city, activeUsers, newUsers: 0, sessions: activeUsers }] });
  }

  // 10 種 Dashboard Range mode——完全依照 geo-ga4-dashboard-layer.js /
  // geo-ga4-h1-panel.js 真實會送出的參數：mode → resolveGeoHistoricalRange()
  // → { apiRange, startDate, endDate }。single/custom 需要日期輸入，這裡用
  // 固定測試日期。
  const MODES = [
    { mode: 'today', opts: {} },
    { mode: 'yesterday', opts: {} },
    { mode: '7d', opts: {} },
    { mode: '30d', opts: {} },
    { mode: '90d', opts: {} },
    { mode: '180d', opts: {} },
    { mode: 'this_year', opts: {} },
    { mode: 'last_year', opts: {} },
    { mode: 'single', opts: { singleDate: '2026-08-01' } },
    { mode: 'custom', opts: { startDate: '2026-07-01', endDate: '2026-07-10' } },
  ];

  let activeUsersCounter = 0;
  const cities = ['中壢區', '平鎮區', '桃園區', '龍潭區', '八德區', '楊梅區', '大溪區', '蘆竹區', '大園區', '觀音區'];

  for (let i = 0; i < MODES.length; i += 1) {
    const { mode, opts } = MODES[i];
    const resolved = rangeResolver.resolveGeoHistoricalRange(mode, { ...opts, now: NOW });
    assert(resolved.ok === true, `ID-${mode}-1. frontend resolveGeoHistoricalRange('${mode}') resolves ok`, JSON.stringify(resolved));
    if (!resolved.ok) continue; // eslint-disable-line no-continue

    activeUsersCounter += 1;
    const activeUsers = activeUsersCounter;
    const cityName = cities[i % cities.length];

    // ── Manual Sync 寫入 identity（跟 geo-ga4-h1-panel.js syncHandler／
    // 本輪新增的 geoDashboardGa4SyncNow() 送出的 body 完全同一組欄位：
    // sync_type='range', range: resolved.apiRange, start_date/end_date）。
    const syncResult = await svc.syncGeoRangeStats('store_h142', { type: resolved.apiRange, start_date: resolved.startDate, end_date: resolved.endDate }, { adapter: adapterFor(cityName, activeUsers) });
    assert(syncResult.success === true, `ID-${mode}-2. Manual Sync 用 apiRange='${resolved.apiRange}' start=${resolved.startDate} end=${resolved.endDate} 寫入成功`, JSON.stringify(syncResult));

    // ── Dashboard GET 讀取 identity（跟 _geoDashboardGa4Fetch() 送出的
    // query 完全同一組欄位：range=resolved.apiRange [+ start_date/end_date
    // if apiRange==='custom']）。
    const readResult = svc.getRangeGeoStats('store_h142', resolved.apiRange, resolved.startDate, resolved.endDate);
    assert(readResult.success !== false, `ID-${mode}-3. Dashboard GET 用同一組 identity 讀取成功（沒有 error code）`, JSON.stringify(readResult));
    const row = (readResult.rows || []).find((r) => r.district_name === cityName);
    assert(!!row && row.active_users === activeUsers, `ID-${mode}-4. Dashboard GET 讀到剛剛 Sync 寫入的同一份資料（${cityName}=${activeUsers}），identity 一致，非 mismatch`, JSON.stringify(readResult.rows));
  }

  // ── 交叉驗證：不同 mode 之間不會互相污染（今天 vs 昨天 vs 7d 各自獨立）。
  {
    const rToday = rangeResolver.resolveGeoHistoricalRange('today', { now: NOW });
    const rYesterday = rangeResolver.resolveGeoHistoricalRange('yesterday', { now: NOW });
    assert(rToday.startDate !== rYesterday.startDate, 'CROSS-1. today 與 yesterday 的實際日期不同（identity 靠日期，不會撞在一起）', `${rToday.startDate} vs ${rYesterday.startDate}`);
    const readToday = svc.getRangeGeoStats('store_h142', rToday.apiRange, rToday.startDate, rToday.endDate);
    const readYesterday = svc.getRangeGeoStats('store_h142', rYesterday.apiRange, rYesterday.startDate, rYesterday.endDate);
    const rowToday = (readToday.rows || []).find((r) => r.district_name === cities[0]);
    const rowYesterday = (readYesterday.rows || []).find((r) => r.district_name === cities[1]);
    assert(!!rowToday && !!rowYesterday && rowToday.active_users !== rowYesterday.active_users, 'CROSS-2. today 讀到自己的值，yesterday 讀到自己的值，互不覆蓋');
  }

  // ── 從未同步過的全新 range：必須讀到合法空陣列（不是別的 range 的殘留、
  // 也不是拿到某個預設值）——這正是正式部署畫面看到的
  // 「目前尚無此期間已同步的 GA4 區域資料」情境的真實觸發點。
  {
    const neverSynced = svc.getRangeGeoStats('store_h142', 'custom', '2030-01-01', '2030-01-31');
    assert(neverSynced.success !== false && Array.isArray(neverSynced.rows) && neverSynced.rows.length === 0, 'GAP-1. 從未同步過的 range 讀回空陣列（不是 error，也不是別的 range 的 stale rows）', JSON.stringify(neverSynced));
  }

  const summary = printSummary();
  console.log('\n──────────────────────────────────────────────────────────────────');
  if (summary.fail === 0) {
    console.log('RESULT: Persisted identity 完全一致（Manual Sync 寫入 identity === Dashboard GET 讀取 identity，全部 10 種 mode 逐一證明）。');
    console.log('結論：Issue 1 root cause 分類為 [B] Dashboard Persisted Data UX Gap，不是 [A] identity mismatch bug。');
  } else {
    console.log('RESULT: 發現 identity mismatch —— 上面標記 FAIL 的 mode 就是 Sync 寫入 identity 與 Dashboard GET 讀取 identity 不一致的地方。');
    console.log('結論：Issue 1 root cause 分類為 [A] Persisted identity bug，須先修正 identity 計算，不能只加 Sync CTA。');
  }
  if (summary.fail > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
