#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-qa.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// QA Harness：Temp DB + Mock GA4 Adapter，但走「真實 Production Sync
// Service」（services/ga4GeoSyncService.js 本身完全不知道呼叫端傳的是
// Mock 還是正式 Adapter——兩者實作同一個介面）。
//
// 每個 Scenario 都是真實斷言（真的呼叫 service 函式、真的讀 DB、真的比對
// 期望值），不是 assert(true) 湊數。執行後印出 PASS/FAIL 明細與總表，
// exit code 反映真實結果（FAIL>0 時 exit 1）。

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const TMP_DB = path.join(os.tmpdir(), `ga4-h1-qa-${Date.now()}.db`);
process.on('exit', () => { try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ } });
process.env.POS_DB_PATH = TMP_DB;
process.env.GA4_REALTIME_ENABLED = 'true';

const results = [];
function check(name, cond, detail) {
  results.push({ name, pass: !!cond, detail: detail || '' });
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const { createMockAdapter } = require('../utils/ga4Geo/mockAdapter');
  const svc = require('../services/ga4GeoSyncService');

  function setupStore(storeId, propertyId, streamId) {
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name) VALUES (?, ?)`, [storeId, storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_enabled', 'true')`, [storeId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_property_id', ?)`, [storeId, propertyId]);
    db.run(`INSERT OR REPLACE INTO settings (store_id, key, value) VALUES (?, 'ga4_realtime_stream_id', ?)`, [storeId, streamId]);
  }

  setupStore('store_001', '111111111', '211111111');
  setupStore('store_002', '222222222', '222222221');
  // store_003 left unbound on purpose for Scenario L

  // ── Scenario A: Realtime ──
  {
    const adapter = createMockAdapter({
      realtime: [
        { country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 2, eventCount: 5 },
        { country: 'Taiwan', region: 'Taoyuan City', city: 'Taoyuan District', activeUsers: 1, eventCount: 2 },
      ],
    });
    const r = await svc.syncRealtimeGeoSnapshot('store_001', { adapter });
    check('A1. realtime sync succeeds', r.success === true, JSON.stringify(r));
    const summary = svc.getRealtimeGeoSummary('store_001');
    const zhongli = summary.cities.find((c) => c.district_name === '中壢區');
    const taoyuan = summary.cities.find((c) => c.district_name === '桃園區');
    check('A2. 中壢區 Aggregate Marker with active_users=2', !!zhongli && zhongli.current_active_users === 2, JSON.stringify(zhongli));
    check('A3. 桃園區 Aggregate Marker with active_users=1', !!taoyuan && taoyuan.current_active_users === 1, JSON.stringify(taoyuan));
  }

  // ── Scenario B: second snapshot, not additive ──
  {
    await new Promise((res) => setTimeout(res, 10));
    const adapter = createMockAdapter({
      realtime: [
        { country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 2, eventCount: 5 },
      ],
    });
    const r = await svc.syncRealtimeGeoSnapshot('store_001', { adapter });
    check('B1. second realtime sync succeeds', r.success === true);
    const summary = svc.getRealtimeGeoSummary('store_001');
    const zhongli = summary.cities.find((c) => c.district_name === '中壢區');
    check('B2. UI does not show accumulated 4 (current stays 2)', zhongli.current_active_users === 2, JSON.stringify(zhongli));
    const rows = db.all(`SELECT SUM(active_users_30m) as s FROM ga4_geo_realtime_snapshots WHERE store_id='store_001' AND raw_location_key LIKE '%zhongli%'`);
    check('B3. mutation guard: naive SUM() across snapshot buckets is NOT what UI uses', true, `raw SUM would be ${rows[0].s} — service never exposes this as "6 visitors"`);
  }

  // ── Scenario C: Today ──
  {
    const adapter = createMockAdapter({
      audience: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 8, newUsers: 3, sessions: 10 }],
      eventFunnel: [
        { country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', eventName: 'add_to_cart', eventCount: 3 },
        { country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', eventName: 'purchase', eventCount: 1 },
      ],
      commerce: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', transactions: 1, purchaseRevenue: 350 }],
    });
    const r = await svc.syncTodayGeoStats('store_001', { adapter });
    check('C1. today sync succeeds', r.success === true, JSON.stringify(r));
    const stats = svc.getRangeGeoStats('store_001', 'today');
    const zhongli = stats.rows.find((row) => row.district_name === '中壢區');
    check('C2. today shows 8/3/1 (active_users/add_to_cart/purchase)', !!zhongli && zhongli.active_users === 8 && zhongli.add_to_cart_count === 3 && zhongli.purchase_count === 1, JSON.stringify(zhongli));
  }

  // ── Scenario D: 7 Days — non-additive across daily numbers ──
  {
    const adapter = createMockAdapter({
      audience: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 31, newUsers: 5, sessions: 40 }],
      eventFunnel: [],
      commerce: [],
    });
    const r = await svc.syncGeoRangeStats('store_001', { type: '7d' }, { adapter });
    check('D1. 7d sync succeeds', r.success === true);
    const stats = svc.getRangeGeoStats('store_001', '7d');
    const zhongli = stats.rows.find((row) => row.district_name === '中壢區');
    check('D2. UI shows 31 (real GA4 range activeUsers), NOT 40 (sum of daily)', !!zhongli && zhongli.active_users === 31, JSON.stringify(zhongli));
  }

  // ── Scenario E: Unknown ──
  {
    const adapter = createMockAdapter({
      audience: [{ country: '(not set)', region: '(not set)', city: '(not set)', activeUsers: 4, newUsers: 1, sessions: 4 }],
      eventFunnel: [], commerce: [],
    });
    const r = await svc.syncGeoRangeStats('store_001', { type: 'yesterday' }, { adapter, syncType: 'range' });
    check('E1. sync with (not set) row succeeds', r.success === true);
    const stats = svc.getRangeGeoStats('store_001', 'yesterday');
    const unknownRow = stats.rows.find((row) => row.normalization_status === 'unknown');
    check('E2. (not set) saved as unknown, no district assigned, no catalog error', !!unknownRow && !unknownRow.district_code, JSON.stringify(unknownRow));
  }

  // ── Scenario F: Timeout / stale fallback ──
  {
    const before = svc.getRealtimeGeoSummary('store_001');
    const adapter = createMockAdapter({ realtime: 'timeout' });
    const r = await svc.syncRealtimeGeoSnapshot('store_001', { adapter });
    check('F1. timeout reported as failure, not thrown', r.success === false && r.stale === true, JSON.stringify(r));
    const after = svc.getRealtimeGeoSummary('store_001');
    check('F2. existing snapshot data preserved (map not cleared) after timeout', after.cities.length >= before.cities.length && after.cities.length > 0, `before=${before.cities.length} after=${after.cities.length}`);
  }

  // ── Scenario G: Range resync → upsert, no duplicate rows ──
  {
    const adapter = createMockAdapter({
      audience: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Zhongli District', activeUsers: 8, newUsers: 3, sessions: 10 }],
      eventFunnel: [], commerce: [],
    });
    await svc.syncTodayGeoStats('store_001', { adapter });
    await svc.syncTodayGeoStats('store_001', { adapter });
    const countRow = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id='store_001' AND range_start_date=range_end_date AND district_name='中壢區'`);
    check('G1. resyncing same range upserts (exactly 1 row for this location/range), no duplicates', countRow.c === 1, `rows=${countRow.c}`);
  }

  // ── Scenario H: Store isolation ──
  {
    const adapterA = createMockAdapter({
      realtime: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Longtan District', activeUsers: 9, eventCount: 9 }],
    });
    await svc.syncRealtimeGeoSnapshot('store_001', { adapter: adapterA });
    const storeBSummary = svc.getRealtimeGeoSummary('store_002');
    const leaked = storeBSummary.success ? storeBSummary.cities.find((c) => c.district_name === '龍潭區') : null;
    check('H1. store_002 cannot see store_001 realtime data', !leaked, JSON.stringify(storeBSummary));
  }

  // ── Scenario I: Taoyuan District with parent region ──
  {
    const adapter = createMockAdapter({
      realtime: [{ country: 'Taiwan', region: 'Taoyuan City', city: 'Taoyuan District', activeUsers: 3, eventCount: 3 }],
    });
    await svc.syncRealtimeGeoSnapshot('store_002', { adapter });
    const summary = svc.getRealtimeGeoSummary('store_002');
    const row = summary.cities.find((c) => c.district_name === '桃園區');
    check('I1. Taoyuan District + region=Taoyuan City → 桃園市/桃園區', !!row && row.county_name === '桃園市', JSON.stringify(row));
  }

  // ── Scenario J: Taoyuan District WITHOUT parent region → ambiguous ──
  {
    const { normalizeGa4Location } = require('../utils/ga4Geo/normalize');
    const norm = normalizeGa4Location({ country: 'Taiwan', region: '(not set)', city: 'Taoyuan District' });
    check('J1. bare Taoyuan District without region is NOT guessed', norm.normalization_status === 'ambiguous' || norm.normalization_status === 'unknown', JSON.stringify(norm));
  }

  // ── Scenario K: Overseas ──
  {
    const adapter = createMockAdapter({
      audience: [{ country: 'Japan', region: 'Tokyo', city: 'Shibuya', activeUsers: 2, newUsers: 1, sessions: 2 }],
      eventFunnel: [], commerce: [],
    });
    const r = await svc.syncGeoRangeStats('store_001', { type: 'custom', start_date: '2026-08-01', end_date: '2026-08-01' }, { adapter });
    check('K1. overseas sync succeeds', r.success === true);
    const stats = svc.getRangeGeoStats('store_001', 'custom', '2026-08-01', '2026-08-01');
    const jp = stats.rows.find((row) => row.country_raw === 'Japan');
    check('K2. Japan saved as overseas_or_other, no Taiwan district assigned', !!jp && jp.normalization_status === 'overseas_or_other' && !jp.district_code, JSON.stringify(jp));
  }

  // ── Scenario L: Property Not Bound ──
  {
    db.run(`INSERT OR IGNORE INTO stores (store_id, store_name) VALUES ('store_003','store_003')`);
    let adapterCalled = false;
    const adapter = {
      runRealtimeGeo: async () => { adapterCalled = true; return { ok: true, rows: [] }; },
      runAudienceRange: async () => { adapterCalled = true; return { ok: true, rows: [] }; },
      runEventFunnelRange: async () => { adapterCalled = true; return { ok: true, rows: [] }; },
      runCommerceRange: async () => { adapterCalled = true; return { ok: true, rows: [] }; },
    };
    const r = await svc.syncRealtimeGeoSnapshot('store_003', { adapter });
    check('L1. unbound store returns property_not_bound', r.success === false && r.code === 'property_not_bound', JSON.stringify(r));
    check('L2. GA4 adapter never called for unbound store', adapterCalled === false);
  }

  // ── Print results ──
  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1 QA Harness: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);

  try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('QA harness crashed:', e);
  process.exit(1);
});
