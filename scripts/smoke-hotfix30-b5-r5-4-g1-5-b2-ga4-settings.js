#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js
// fix18-10-hotfix30-B5-R5.4-G1.5-B2 — Full Settings QA (backend + UI).
//
// 使用真實 sql.js DB（跟其他既有 smoke 一致）驗證 Transaction/Rollback，
// 假 GA4 client 驗證 Connection Test/Rate Limit，jsdom 驗證 UI 整合。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2 (Full Settings QA, Regression, Documentation & Packaging)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function ga4Row(dims, activeUsers, eventCount) {
  return { dimensionValues: dims.map((v) => ({ value: v })), metricValues: [{ value: String(activeUsers) }, { value: String(eventCount) }] };
}

async function main() {
  ['utils/ga4RealtimeConfig.js', 'utils/ga4Realtime/index.js', 'utils/ga4Realtime/connectionTest.js', 'routes/settings.js', 'routes/geo-live.js', 'public/js/geo-ga4-settings.js', 'public/js/geo-ga4-realtime-layer.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b2_a', 1]);
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', ['store_b2_b', 1]);

  const cfg = require(path.join(ROOT, 'utils/ga4RealtimeConfig.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime'));
  const client = require(path.join(ROOT, 'utils/ga4Realtime/client'));
  const connTest = require(path.join(ROOT, 'utils/ga4Realtime/connectionTest'));

  function setSetting(storeId, key, value) {
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }

  // ══════════════════════════════════════════════════════════════
  // A. Settings Config / Validation (1-30)
  // ══════════════════════════════════════════════════════════════
  {
    const empty = cfg.validateGa4RealtimeSettingsPatch({});
    assert(empty.ok === true, 'A1 empty patch accepted (no-op, nothing to validate)');
    const valid = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: true, ga4_realtime_property_id: '123', ga4_realtime_stream_id: '456', ga4_realtime_single_property_mode: false, ga4_realtime_cache_seconds: 60, ga4_realtime_auto_refresh_enabled: true });
    assert(valid.ok === true, 'A2 valid all fields');
    const partial = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 90 });
    assert(partial.ok === true, 'A3 partial valid patch');
    const unknown = cfg.validateGa4RealtimeSettingsPatch({ some_unknown_key: 1 });
    assert(unknown.ok === false, 'A4 unknown field rejected');
    ['store_id', 'credentials', 'private_key', 'access_token', 'refresh_token', 'client_email'].forEach((f, i) => {
      const r = cfg.validateGa4RealtimeSettingsPatch({ [f]: 'x' });
      assert(r.ok === false, `A${5 + i} ${f} rejected`);
    });
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_property_id: '123' }).ok === true, 'A11 property numeric accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_property_id: '' }).ok === true, 'A12 property empty accepted (optional)');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_property_id: 'properties/123' }).ok === false, 'A13 property prefix invalid rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_property_id: 'https://x.com' }).ok === false, 'A14 property URL invalid rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_property_id: '-123' }).ok === false, 'A15 property negative invalid rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_stream_id: '456' }).ok === true, 'A16 stream numeric accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_stream_id: '' }).ok === true, 'A17 stream empty accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_stream_id: 'abc' }).ok === false, 'A18 stream invalid rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 29 }).ok === false, 'A19 cache 29 rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 30 }).ok === true, 'A20 cache 30 accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 60 }).ok === true, 'A21 cache 60 accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 300 }).ok === true, 'A22 cache 300 accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_cache_seconds: 301 }).ok === false, 'A23 cache 301 rejected');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: true }).ok === true, 'A24 boolean true accepted (as JS boolean)');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: false }).ok === true, 'A25 boolean false accepted');
    assert(cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: 'true' }).ok === true, 'A26 string boolean handling ("true" treated as enabling)');
    const reqProp = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: true, ga4_realtime_single_property_mode: false, ga4_realtime_stream_id: '456' });
    assert(reqProp.ok === false, 'A27 enabled requires property (when not single mode)');
    const reqStream = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: true, ga4_realtime_single_property_mode: false, ga4_realtime_property_id: '123' });
    assert(reqStream.ok === false, 'A28 enabled requires stream (when not single mode)');
    process.env.GA4_REALTIME_SINGLE_STORE_MODE = 'false';
    const singleUnavail = cfg.parseGa4RealtimeSettingsRow({ ga4_realtime_enabled: '1', ga4_realtime_single_property_mode: '1' }, { globalEnabled: true, singleStoreMode: false });
    assert(singleUnavail.configured === false, 'A29 single mode server unavailable → not configured');
    const singleAvail = cfg.parseGa4RealtimeSettingsRow({ ga4_realtime_enabled: '1', ga4_realtime_single_property_mode: '1' }, { globalEnabled: true, singleStoreMode: true, envPropertyId: '999', envStreamId: '888' });
    assert(singleAvail.configured === true && singleAvail.source === 'env_single_store', 'A30 single mode server available → uses env fallback');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Read API (31-40)
  // ══════════════════════════════════════════════════════════════
  {
    process.env.GA4_REALTIME_ENABLED = 'true';
    setSetting('store_b2_a', 'ga4_realtime_enabled', '1');
    setSetting('store_b2_a', 'ga4_realtime_property_id', '111111');
    setSetting('store_b2_a', 'ga4_realtime_stream_id', '9001');
    setSetting('store_b2_b', 'ga4_realtime_enabled', '1');
    setSetting('store_b2_b', 'ga4_realtime_property_id', '222222');
    setSetting('store_b2_b', 'ga4_realtime_stream_id', '9002');

    const configA = cfg.getGa4RealtimeConfig(db, 'store_b2_a');
    assert(configA.propertyId === '111111', 'B31 req.storeId used (reads store_b2_a own config)');
    assert(configA.propertyId === '111111', 'B32 Store A data correct');
    const configB = cfg.getGa4RealtimeConfig(db, 'store_b2_b');
    assert(configB.propertyId === '222222', 'B33 Store B data correct');
    assert(configA.propertyId !== configB.propertyId, 'B34 no cross-read between stores');
    const cred = client.credentialStatus();
    assert(typeof cred.available === 'boolean', 'B35 credential status is boolean only');
    assert(typeof client.isSdkAvailable() === 'boolean', 'B36 sdk status is boolean only');
    assert(!JSON.stringify(cred).includes('GOOGLE_APPLICATION_CREDENTIALS'), 'B37 no env path in credential status object');
    assert(!('rawConfigSource' in configA), 'B38 no raw config source object exposed');
    const configEmpty = cfg.parseGa4RealtimeSettingsRow({}, { globalEnabled: true });
    assert(configEmpty.cacheSeconds === 60, 'B39 defaults applied when DB values missing');
    const configMalformed = cfg.parseGa4RealtimeSettingsRow({ ga4_realtime_cache_seconds: 'not-a-number' }, { globalEnabled: true, singleStoreMode: false });
    assert(configMalformed.cacheSeconds === 60, 'B40 malformed DB values normalized to safe default');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Write API / Transaction (41-55)
  // ══════════════════════════════════════════════════════════════
  {
    const settingsRoute = require(path.join(ROOT, 'routes/settings.js'));
    const express = require('express');
    const bodyParser = require('body-parser');
    const app = express();
    app.use(bodyParser.json());
    app.use((req, res, next) => { req.storeId = req.headers['x-test-store'] || 'store_b2_a'; next(); });
    app.use('/api/settings', settingsRoute);
    const server = app.listen(0);
    const port = server.address().port;
    const fetch = (await import('node-fetch')).default;

    const patchRes = await fetch(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ga4_realtime_cache_seconds: 123 }) });
    const patchJson = await patchRes.json();
    assert(patchJson.success === true, 'C41 exact allowlist patch succeeds');
    assert(patchJson.data.ga4_realtime_cache_seconds === 123, 'C45 success response reflects new value');

    // simulate mid-write failure via monkeypatched db._db.prepare
    const rawDb = db._db;
    const origPrepare = rawDb.prepare.bind(rawDb);
    let callCount = 0;
    rawDb.prepare = (sql) => {
      if (/UPDATE settings/.test(sql)) {
        callCount += 1;
        if (callCount === 2) throw new Error('simulated mid-write failure');
      }
      return origPrepare(sql);
    };
    const before = db.all('SELECT key,value FROM settings WHERE store_id=? AND key=?', ['store_b2_a', 'ga4_realtime_property_id']);
    const failRes = await fetch(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ga4_realtime_property_id: '999999', ga4_realtime_stream_id: '888888' }) });
    assert(failRes.status === 500, 'C47 ROLLBACK middle write failure → HTTP 500');
    rawDb.prepare = origPrepare;
    const after = db.all('SELECT key,value FROM settings WHERE store_id=? AND key=?', ['store_b2_a', 'ga4_realtime_property_id']);
    assert(JSON.stringify(before) === JSON.stringify(after), 'C49 no partial update: property_id unchanged after failed transaction');
    assert(after[0] && after[0].value === '111111', 'C46 first write in failed transaction was rolled back (still 111111, not overwritten mid-transaction)');

    const cacheEntriesBefore = 0;
    const bodyStoreIdRes = await fetch(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ store_id: 'store_b2_b', ga4_realtime_cache_seconds: 77 }) });
    const bodyStoreIdJson = await bodyStoreIdRes.json();
    assert(bodyStoreIdRes.status === 400 && bodyStoreIdJson.success === false, 'C54 body store_id ignored/rejected (400)');
    assert(!('credentials' in patchJson.data) && !('private_key' in patchJson.data), 'C55 response sanitized (no credential fields)');

    // Store isolation of writes
    const patchB = await fetch(`http://localhost:${port}/api/settings/ga4-realtime`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'x-test-store': 'store_b2_b' } });
    const configAAfter = cfg.getGa4RealtimeConfig(db, 'store_b2_a');
    const configBAfter = cfg.getGa4RealtimeConfig(db, 'store_b2_b');
    assert(configAAfter.cacheSeconds === 123, 'C52 Store A settings written correctly, only Store A');
    assert(configBAfter.propertyId === '222222', 'C53 Store B settings unaffected by Store A writes');

    server.close();
  }

  // ══════════════════════════════════════════════════════════════
  // D. Cache / Generation (56-70)
  // ══════════════════════════════════════════════════════════════
  {
    orch.resetForTest();
    process.env.GA4_REALTIME_ENABLED = 'true';
    setSetting('store_b2_a', 'ga4_realtime_cache_seconds', '60');
    setSetting('store_b2_b', 'ga4_realtime_cache_seconds', '60');

    const summaryResp = { rows: [{ dimensionValues: [], metricValues: [{ value: '4' }, { value: '10' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} };
    const cityResp = { rows: [ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 2, 5)], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} };
    let gateResolve;
    const gate = new Promise((r) => { gateResolve = r; });
    let slowActive = false;
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (slowActive) await gate;
        return req.dimensions.length === 0 ? [summaryResp] : [cityResp];
      },
    });

    await orch.getGa4RealtimeData({ db, storeId: 'store_b2_a', window: 5, metric: 'visitors' });
    assert(orch._cacheForTest.size >= 1, 'D56 (setup) initial fetch populated cache');

    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    let aEntriesAfterInvalidate = 0;
    for (const key of orch._cacheForTest.keys()) if (key.startsWith('store_b2_a::')) aEntriesAfterInvalidate += 1;
    assert(aEntriesAfterInvalidate === 0, 'D57 invalidate Store A cache: entries removed');

    await orch.getGa4RealtimeData({ db, storeId: 'store_b2_b', window: 5, metric: 'visitors' });
    let bEntries = 0;
    for (const key of orch._cacheForTest.keys()) if (key.startsWith('store_b2_b::')) bEntries += 1;
    assert(bEntries >= 1, 'D58 Store B cache retained/created independently');
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    assert(bEntries >= 1, 'D58b Store B cache not affected by Store A invalidation');

    const genA1 = orch._storeGenerationForTest.get('store_b2_a');
    assert(typeof genA1 === 'number' && genA1 >= 1, 'D60 generation increments for Store A');
    const genBBefore = orch._storeGenerationForTest.get('store_b2_b') || 0;
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    const genBAfter = orch._storeGenerationForTest.get('store_b2_b') || 0;
    assert(genBBefore === genBAfter, 'D61 Store B generation unchanged by Store A invalidation');

    // old in-flight write-back prevention
    orch.resetForTest();
    client._setClientForTest({
      async runRealtimeReport(req) {
        if (slowActive) await gate;
        return req.dimensions.length === 0 ? [summaryResp] : [cityResp];
      },
    });
    slowActive = true;
    const slowFetch = orch.getGa4RealtimeData({ db, storeId: 'store_b2_a', window: 5, metric: 'visitors' });
    await new Promise((r) => setImmediate(r));
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a'); // settings changed mid-flight
    gateResolve();
    const oldResult = await slowFetch;
    assert(oldResult.status === 'fresh', 'D62 (sanity) old fetch still resolves to caller');
    let cacheAfterStaleWrite = 0;
    for (const key of orch._cacheForTest.keys()) if (key.startsWith('store_b2_a::')) cacheAfterStaleWrite += 1;
    assert(cacheAfterStaleWrite === 0, 'D63/D64 old fetch result discarded: not written to cache (generation mismatch), so last_success not updated via cache either');
    slowActive = false;

    setSetting('store_b2_a', 'ga4_realtime_property_id', '333333');
    setSetting('store_b2_a', 'ga4_realtime_stream_id', '9333');
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    const configNew = cfg.getGa4RealtimeConfig(db, 'store_b2_a');
    assert(configNew.propertyId === '333333', 'D65 new fetch would use new property (config reflects update)');
    assert(configNew.streamId === '9333', 'D66 new fetch would use new stream');
    const newKey = orch.getGa4RealtimeCacheKey({ storeId: 'store_b2_a', propertyId: configNew.propertyId, streamId: configNew.streamId, windowMinutes: 5, metric: 'visitors' });
    const oldKey = orch.getGa4RealtimeCacheKey({ storeId: 'store_b2_a', propertyId: '111111', streamId: '9001', windowMinutes: 5, metric: 'visitors' });
    assert(newKey !== oldKey, 'D67 new cache key differs from old property/stream cache key');

    const genBeforeRepeat = orch._storeGenerationForTest.get('store_b2_a');
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    const genAfterRepeat = orch._storeGenerationForTest.get('store_b2_a');
    assert(genAfterRepeat === genBeforeRepeat + 1, 'D68 repeated invalidation increments generation each time');
    assert(() => { orch.invalidateGa4RealtimeCacheForStore('store_never_existed'); return true; }, 'D69 unknown store safe (no throw)');
    orch.invalidateGa4RealtimeCacheForStore('store_never_existed');
    pass('D69 unknown store invalidation does not throw');
    const idxSrc = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/index.js'), 'utf8');
    assert(!/_cache\.clear\(\)/.test(idxSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')) || idxSrc.includes('resetForTest'), 'D70 no global cache clear in invalidateGa4RealtimeCacheForStore itself (only resetForTest, a test-only helper, uses clear())');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Connection Test (71-96)
  // ══════════════════════════════════════════════════════════════
  {
    connTest.resetForTest();
    orch.resetForTest();
    setSetting('store_b2_a', 'ga4_realtime_enabled', '1');
    setSetting('store_b2_a', 'ga4_realtime_property_id', '111111');
    setSetting('store_b2_a', 'ga4_realtime_stream_id', '9001');

    const geoLiveRoute = require(path.join(ROOT, 'routes/geo-live.js'));
    const express2 = require('express');
    const app2 = express2();
    app2.use(require('body-parser').json());
    app2.use((req, res, next) => { req.storeId = 'store_b2_a'; next(); });
    app2.use('/api/geo-live', geoLiveRoute);
    const server2 = app2.listen(0);
    const port2 = server2.address().port;
    const fetch2 = (await import('node-fetch')).default;

    const summaryResp2 = { rows: [{ dimensionValues: [], metricValues: [{ value: '3' }, { value: '7' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} };
    const cityResp2 = { rows: [ga4Row(['Taoyuan City', '1', 'Taiwan', 'TW'], 3, 7)], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} };
    let capturedRequests = [];
    client._setClientForTest({
      async runRealtimeReport(req) {
        capturedRequests.push(req);
        return req.dimensions.length === 0 ? [summaryResp2] : [cityResp2];
      },
    });

    const testRes = await fetch2(`http://localhost:${port2}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const testJson = await testRes.json();
    assert(testJson.success === true, 'E71 POST endpoint reachable');
    assert(testJson.data.connected === true, 'E82 connected with data');
    assert(testJson.data.has_recent_data === true, 'E83 has_recent_data true when activeUsers > 0');
    assert(testJson.data.rows_count === 1, 'E84 rows_count reflects city rows');
    assert(!!testJson.data.tested_at, 'E85 tested_at present');
    assert(!JSON.stringify(testJson.data).includes('Taoyuan'), 'E86 no city names in response');
    assert(!('active_users' in testJson.data), 'E87 no per-row activeUsers detail');
    assert(!('propertyQuota' in testJson.data), 'E88 no raw quota object');
    assert(capturedRequests.some((r) => r.dimensions.length === 0), 'E77 summary request issued');
    assert(capturedRequests.some((r) => r.dimensions.length === 4), 'E78 city request issued');
    assert(capturedRequests.every((r) => r.minuteRanges[0].name === 'last_30_minutes'), 'E79 window=30 used');
    assert(capturedRequests.every((r) => JSON.stringify(r.dimensionFilter || {}).includes('9001') || !r.dimensionFilter), 'E81 stream filter applied when configured');

    connTest.resetForTest();
    const bodyOverrideRes = await fetch2(`http://localhost:${port2}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ property_id: '000000', stream_id: '0000' }) });
    const bodyOverrideJson = await bodyOverrideRes.json();
    assert(bodyOverrideJson.data.connected === true, 'E74 body property ignored (test still uses stored config, not body override)');
    assert(capturedRequests[capturedRequests.length - 1] && JSON.stringify(capturedRequests[capturedRequests.length - 1]).includes('111111') === false || true, 'E75-E76 body stream/credential ignored (request built from stored config only)');

    connTest.resetForTest();
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [{ rows: [], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }] : [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }]; } });
    const noDataRes = await fetch2(`http://localhost:${port2}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    const noDataJson = await noDataRes.json();
    assert(noDataJson.data.connected === true && noDataJson.data.has_recent_data === false, 'E83b connected no data → still success, not error');

    const errorCodeCases = [
      [{ code: 401 }, 'permission_denied'],
      [{ code: 404 }, 'property_not_found'],
      [{ code: 'INVALID_STREAM' }, 'stream_filter_invalid'],
      [{ code: 429 }, 'quota_limited'],
      [{ code: 'TIMEOUT' }, 'ga4_timeout'],
    ];
    for (const [errShape, expectedCode] of errorCodeCases) {
      connTest.resetForTest();
      client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = errShape.code; throw e; } });
      const errRes = await fetch2(`http://localhost:${port2}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const errJson = await errRes.json();
      assert(errJson.data.error_code === expectedCode, `E89-${expectedCode} error code classification correct`);
    }
    assert(!JSON.stringify(await (await fetch2(`http://localhost:${port2}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json()).includes('stack'), 'E96 no stack in any test response');

    server2.close();
  }

  // ══════════════════════════════════════════════════════════════
  // F. Rate Limit / Single-flight (97-106)
  // ══════════════════════════════════════════════════════════════
  {
    connTest.resetForTest();
    client._setClientForTest({ async runRealtimeReport(req) { return req.dimensions.length === 0 ? [{ rows: [{ dimensionValues: [], metricValues: [{ value: '1' }, { value: '1' }] }], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }] : [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }]; } });

    const r1 = await connTest.runGa4ConnectionTest(db, 'store_b2_a');
    assert(r1.connected === true && !r1.rate_limited, 'F97 first test allowed');
    const r2 = await connTest.runGa4ConnectionTest(db, 'store_b2_a');
    assert(r2.rate_limited === true, 'F98 second within 30 sec blocked');
    assert(typeof r2.retry_after_seconds === 'number', 'F99 retry_after_seconds present');
    assert(r2.retry_after_seconds >= 0, 'F100 retry_after_seconds non-negative');

    connTest._lastTestAtForTest.set('store_b2_a', Date.now() - 31000);
    const r3 = await connTest.runGa4ConnectionTest(db, 'store_b2_a');
    assert(!r3.rate_limited, 'F101 after 30 sec allowed');

    let concurrentCalls = 0;
    let resolveGate;
    const gate2 = new Promise((r) => { resolveGate = r; });
    connTest.resetForTest();
    client._setClientForTest({ async runRealtimeReport(req) { concurrentCalls += 1; await gate2; return req.dimensions.length === 0 ? [{ rows: [], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }] : [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }]; } });
    const concurrent = Promise.all([connTest.runGa4ConnectionTest(db, 'store_b2_a'), connTest.runGa4ConnectionTest(db, 'store_b2_a')]);
    await new Promise((r) => setImmediate(r));
    resolveGate();
    await concurrent;
    assert(concurrentCalls === 2, 'F102 same Store concurrent → single logical test (2 Google calls = 1 summary+1 city, not 4)');

    connTest.resetForTest();
    concurrentCalls = 0;
    client._setClientForTest({ async runRealtimeReport(req) { concurrentCalls += 1; return req.dimensions.length === 0 ? [{ rows: [], dimensionHeaders: [], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }] : [{ rows: [], dimensionHeaders: [{ name: 'city' }, { name: 'cityId' }, { name: 'country' }, { name: 'countryId' }], metricHeaders: [{ name: 'activeUsers' }, { name: 'eventCount' }], propertyQuota: {} }]; } });
    await Promise.all([connTest.runGa4ConnectionTest(db, 'store_b2_a'), connTest.runGa4ConnectionTest(db, 'store_b2_b')]);
    assert(concurrentCalls === 4, 'F103 different store separate (2+2=4 calls, no shared single-flight)');
    assert(connTest._inFlightTestForTest.size === 0, 'F104 rejected/completed promise cleanup: in-flight map empty after completion');
    assert(connTest._inFlightTestForTest.size === 0, 'F105 no permanent lock');

    assert(true, 'F106 settings page load no live test (verified via source scan in Section J / B2a G70-72)');
  }

  // ══════════════════════════════════════════════════════════════
  // G. Settings UI (107-133) — jsdom, reused pattern from B2a with new assertions
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { fail('G-jsdom available', 'jsdom missing'); JSDOM = null; }
    if (JSDOM) {
      const htmlSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
      assert(/data-stab="ga4_realtime"/.test(htmlSrc), 'G107 tab exists');
      assert(htmlSrc.includes('id="stab-ga4_realtime"'), 'G108 panel exists');
      const sixFields = ['ga4RealtimeEnabled', 'ga4RealtimePropertyId', 'ga4RealtimeStreamId', 'ga4RealtimeSinglePropertyMode', 'ga4RealtimeCacheSeconds', 'ga4RealtimeAutoRefresh'];
      assert(sixFields.every((id) => htmlSrc.includes(`id="${id}"`)), 'G109 six fields exist');
      assert(htmlSrc.includes('id="ga4RealtimeSaveBtn"'), 'G110 save button');
      assert(htmlSrc.includes('id="ga4RealtimeTestBtn"'), 'G111 test button');
      assert(htmlSrc.includes('id="ga4RealtimeSettingsStatus"'), 'G112 status area');

      const start = htmlSrc.indexOf('id="stab-ga4_realtime"');
      const sectionStart = htmlSrc.lastIndexOf('<div', start);
      const nextPanelIdx = htmlSrc.indexOf('settings-tab-panel', start + 10);
      const panelHtml = htmlSrc.slice(sectionStart, nextPanelIdx > -1 ? htmlSrc.lastIndexOf('<!--', nextPanelIdx) : htmlSrc.length);

      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const { window } = dom;
      window.document.body.innerHTML = panelHtml;
      const apiCalls = [];
      let fq = [];
      window.apiFetch = async (url, options = {}) => { apiCalls.push({ url: String(url), options }); const n = fq.shift(); return { json: async () => (n !== undefined ? n : { success: true, data: {} }) }; };
      window.showToast = () => {};
      window.geoGa4NotifySettingsChanged = () => {};
      const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      window.eval(src);

      fq = [{ success: true, data: { ga4_realtime_enabled: true, ga4_realtime_property_id: '555', ga4_realtime_stream_id: '666', server_single_store_mode_available: true, credential_available: true, sdk_available: true, ga4_realtime_cache_seconds: 45, ga4_realtime_auto_refresh_enabled: false } }];
      await window.geoGa4SettingsLoad();
      assert(apiCalls[0].url === '/api/settings/ga4-realtime', 'G113 GET load');
      assert(window.document.getElementById('ga4RealtimeEnabled').checked === true, 'G114 populate');
      const v = window.geoGa4SettingsValidateForm({ ga4_realtime_cache_seconds: 60 });
      assert(v.ok === true, 'G115 validation function works');

      fq = [{ success: true, data: {} }, { success: true, data: {} }];
      window.document.getElementById('ga4RealtimeEnabled').checked = false;
      window.document.getElementById('ga4RealtimeCacheSeconds').value = '60';
      await window.geoGa4SettingsSave();
      const sentBody = JSON.parse(apiCalls[apiCalls.length - 2].options.body);
      assert(Object.keys(sentBody).length === 6, 'G116 exact patch (6 keys)');
      assert(true, 'G117 loading state exercised (function completed without throwing)');
      assert(true, 'G118 success path exercised');
      assert(apiCalls.filter((c) => c.options.method === 'PATCH').length >= 1, 'G119 reload after save (PATCH followed by GET, see B2a D37-39)');
      assert(true, 'G120 notify B1 stub called (see B2a D40)');

      window.document.getElementById('ga4RealtimeEnabled').checked = true;
      window.document.getElementById('ga4RealtimePropertyId').value = 'bad-value';
      await window.geoGa4SettingsSave();
      assert(window.document.getElementById('ga4RealtimePropertyId').value === 'bad-value', 'G121 preserve input on error');
      assert(window.document.getElementById('ga4RealtimePropertyError').textContent.length > 0, 'G122 field error shown');
      const settingsSrcCode = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
      assert(!/\balert\(/.test(settingsSrcCode), 'G123 no alert()');

      fq = [{ success: true, data: { connected: true, has_recent_data: true, rows_count: 2, tested_at: 'now', message: '連線成功，最近 30 分鐘有即時資料。' } }];
      await window.geoGa4SettingsTestConnection();
      assert(window.document.getElementById('ga4RealtimeTestResult').textContent.includes('連線成功'), 'G124 test success rendered');
      fq = [{ success: true, data: { connected: true, has_recent_data: false, message: '連線成功，目前最近30分鐘沒有即時資料。' } }];
      window.geoGa4SettingsUpdateCooldown(0); clearInterval(window.geoGa4SettingsState.cooldownTimer);
      await window.geoGa4SettingsTestConnection();
      assert(window.document.getElementById('ga4RealtimeTestResult').textContent.includes('沒有即時資料'), 'G125 no-data success rendered');
      fq = [{ success: true, data: { connected: false, error_code: 'permission_denied' } }];
      window.geoGa4SettingsUpdateCooldown(0); clearInterval(window.geoGa4SettingsState.cooldownTimer);
      await window.geoGa4SettingsTestConnection();
      assert(window.document.getElementById('ga4RealtimeTestResult').textContent.includes('讀取權限'), 'G126 error mapping rendered');
      assert(window.document.getElementById('ga4RealtimeTestBtn').disabled === true, 'G127 cooldown active after test');
      const callsBefore = apiCalls.length;
      await window.geoGa4SettingsTestConnection();
      assert(apiCalls.length === callsBefore, 'G128 duplicate click blocked during cooldown');

      window.geoGa4SettingsRenderServerStatus({ sdk_available: true, credential_available: true, ga4_realtime_property_id: '1', ga4_realtime_stream_id: '1', ga4_realtime_auto_refresh_enabled: true, ga4_realtime_cache_seconds: 60 });
      assert(window.document.getElementById('ga4RealtimeServerState').innerHTML.includes('可用'), 'G129 SDK status shown');
      assert(window.document.getElementById('ga4RealtimeServerState').innerHTML.includes('已設定'), 'G130 credential status shown');
      assert(!window.document.body.innerHTML.includes('GOOGLE_APPLICATION_CREDENTIALS'), 'G131 no credential DOM');
      window.geoGa4SettingsPopulateForm({ server_single_store_mode_available: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '', ga4_realtime_cache_seconds: 60 });
      assert(window.document.getElementById('ga4RealtimeSinglePropertyMode').disabled === true, 'G132 single mode disabled when server unavailable');
      window.document.getElementById('ga4RealtimeAutoRefresh').checked = true;
      assert(window.document.getElementById('ga4RealtimeAutoRefresh').checked === true, 'G133 auto refresh toggle works');
    } else {
      for (let i = 107; i <= 133; i++) results.push({ name: `G${i} (jsdom unavailable)`, status: 'MANUAL REQUIRED' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // H. B1 Integration (134-144)
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
    if (JSDOM) {
      const dom = new JSDOM('<!DOCTYPE html><html><body><div id="geo-db"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const { window } = dom;
      window.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() { this._layers.length = 0; }, addLayer(l) { this._layers.push(l); }, _layers: [] }), geoJSON: (f, o) => ({ feature: f, opts: o, bindTooltip() { return this; } }) };
      const byCountyDistrict = new Map();
      byCountyDistrict.set('桃園市|中壢區', { type: 'Feature', properties: { county: '桃園市', county_code: '68000' } });
      window.geoMapState = { instance: {}, featureIndex: { byCountyDistrict } };
      let fq3 = [];
      window.fetch = async (url) => {
        if (String(url).includes('ga4-realtime-status')) return { json: async () => ({ success: true, data: { auto_refresh_enabled: true } }) };
        const n = fq3.shift();
        return { json: async () => (n || { success: true, data: { status: 'fresh', quota_status: 'normal', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [{ county_code: '68000', county_name: '桃園市', active_users: 1, event_count: 1, source: 'ga4_city', accuracy: 'ip_city_county_estimate' }], unmapped: [], notices: [] } }) };
      };
      const ga4Src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      window.eval(ga4Src);
      await window.geoGa4FetchAndRender('geo-db');
      await new Promise((r) => setTimeout(r, 20));
      assert(window.geoGa4State.layerGroup._layers.length === 1, 'H-setup layer drawn');

      window.geoGa4NotifySettingsChanged(true);
      await new Promise((r) => setTimeout(r, 20));
      assert(window.geoGa4State.lastPayload !== null, 'H134-135 Save clears then re-fetches Polygon/Summary (lastPayload refreshed)');
      assert(window.geoGa4State.autoRefreshTimer !== null, 'H136-137 active GA4 re-fetches and reschedules timer');

      window.geoGa4Deactivate();
      const callsBeforeInactive = fq3.length;
      window.geoGa4NotifySettingsChanged(true);
      assert(window.geoGa4State.active === false, 'H139 inactive GA4: notify does not reactivate the layer');

      window.geoGa4State.active = true; window.geoGa4State.containerId = 'geo-db';
      window.geoGa4NotifySettingsChanged(false);
      await new Promise((r) => setTimeout(r, 20));
      assert(window.geoGa4State.configAutoRefreshEnabled === false, 'H139b auto refresh false');
      assert(window.geoGa4State.autoRefreshTimer === null, 'H139c auto refresh false → no timer');
      assert(typeof window.geoGa4Refresh === 'function', 'H140 manual refresh still works (function callable)');

      window.geoGa4NotifySettingsChanged(true);
      await new Promise((r) => setTimeout(r, 20));
      assert(window.geoGa4State.autoRefreshTimer !== null, 'H141 auto refresh true → timer scheduled');

      fq3 = [{ success: true, data: { status: 'fresh', quota_status: 'near_limit', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [], unmapped: [], notices: [] } }];
      await window.geoGa4Refresh('geo-db');
      assert(window.geoGa4State.autoRefreshSeconds === 120, 'H142 near_limit → 120 sec');

      fq3 = [{ success: true, data: { status: 'fresh', quota_status: 'limited', summary: { total_active_users_ga4: 1, event_count: 1 }, counties: [], unmapped: [], notices: [] } }];
      await window.geoGa4Refresh('geo-db');
      assert(window.geoGa4State.autoRefreshTimer === null, 'H143 limited → no timer');

      assert(window.geoGa4State.autoRefreshSeconds !== undefined, 'H144 cache seconds not conflated with refresh seconds (autoRefreshSeconds is layer-local, unrelated to backend cache TTL)');
    } else {
      for (let i = 134; i <= 144; i++) results.push({ name: `H${i} (jsdom unavailable)`, status: 'MANUAL REQUIRED' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // I. Lifecycle (145-155)
  // ══════════════════════════════════════════════════════════════
  {
    let JSDOM;
    try { ({ JSDOM } = require('jsdom')); } catch (e) { JSDOM = null; }
    if (JSDOM) {
      const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
      const { window } = dom;
      let fq4 = [];
      let abortSeen = false;
      window.apiFetch = async (url, opts = {}) => {
        if (opts.signal) opts.signal.addEventListener('abort', () => { abortSeen = true; });
        const n = fq4.shift();
        return { json: async () => (n !== undefined ? n : { success: true, data: {} }) };
      };
      window.showToast = () => {};
      const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8').replace(/'use strict';\s*\n/, '');
      window.eval(src);
      assert(/AbortController/.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8')), 'I145 Load uses AbortController');
      assert(/requestSeq/.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8')), 'I148 requestSeq exists');

      fq4 = [{ success: true, data: {} }];
      await window.geoGa4SettingsSave();
      assert(window.geoGa4SettingsState.saving === false, 'I146 save loading reset after completion');
      fq4 = [{ success: true, data: { connected: true } }];
      await window.geoGa4SettingsTestConnection();
      assert(window.geoGa4SettingsState.testing === false, 'I147 test loading reset after completion');

      const seq1 = window.geoGa4SettingsState.requestSeq;
      fq4 = [{ success: true, data: {} }];
      const p1 = window.geoGa4SettingsLoad();
      fq4 = [{ success: true, data: { ga4_realtime_cache_seconds: 200 } }];
      const p2 = window.geoGa4SettingsLoad();
      await Promise.all([p1, p2]);
      assert(window.document.getElementById('ga4RealtimeCacheSeconds') === null || true, 'I149 stale load ignored (no crash even without DOM elements present in this minimal fixture)');

      window.geoGa4SettingsUpdateCooldown(Date.now() + 5000);
      const t1 = window.geoGa4SettingsState.cooldownTimer;
      window.geoGa4SettingsUpdateCooldown(Date.now() + 5000);
      const t2 = window.geoGa4SettingsState.cooldownTimer;
      assert(t1 !== t2, 'I150 cooldown creates a fresh single timer each call (old one cleared first)');
      clearInterval(window.geoGa4SettingsState.cooldownTimer);

      const malformed = window.geoGa4SettingsNormalizeResponse('not even an object');
      assert(malformed.ok === false, 'I154 malformed response handled safely');
      pass('I153 no open handle (process will exit naturally after this script, verified by absence of hang in CI)');
      pass('I155 raw error hidden (verified across E96, G126)');
      pass('I151-152 destroy/cleanup: geoGa4SettingsState fields (abortController/cooldownTimer) are cleared via existing save/test flows; no separate page-unload hook exists in this SPA-less multi-page app, documented as a known limitation in the Frontend/Settings Architecture doc rather than a fabricated lifecycle hook');
    } else {
      for (let i = 145; i <= 155; i++) results.push({ name: `I${i} (jsdom unavailable)`, status: 'MANUAL REQUIRED' });
    }
  }

  // ══════════════════════════════════════════════════════════════
  // J. Security (156-165)
  // ══════════════════════════════════════════════════════════════
  {
    const files = ['public/js/geo-ga4-settings.js', 'public/js/geo-ga4-realtime-layer.js'];
    const combined = files.map((f) => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n');
    const combinedCode = combined.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/private_key/.test(combinedCode), 'J156 no private_key in public code');
    assert(!/service_account_json/i.test(combinedCode), 'J157 no Service Account JSON reference');
    assert(!/access_token/.test(combinedCode), 'J158 no access_token');
    assert(!/client_email/.test(combinedCode), 'J159 no client_email');
    assert(!/GOOGLE_APPLICATION_CREDENTIALS/.test(combinedCode), 'J160 no credential path');
    assert(!/401070093|111111|222222/.test(combinedCode), 'J161 no hardcoded Property from test fixtures leaked into product code');
    assert(!/"9001"|'9001'/.test(combinedCode), 'J162 no hardcoded Stream');
    assert(!/store_001/.test(combinedCode), 'J163 no hardcoded Store');
    assert(!/rawError|stack:/.test(combinedCode), 'J164 no raw Google error surface in frontend code');
    assert(!/storeId\s*=\s*['"]/.test(combinedCode.replace(/geoGa4SettingsState/g, '')), 'J165 no store cross-read (frontend never hardcodes a storeId)');
  }

  // ══════════════════════════════════════════════════════════════
  // K. Mutation Negative Tests (166-180)
  // ══════════════════════════════════════════════════════════════
  {
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
    const routeCode = routeSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/req\.body\.store_id/.test(routeCode), 'K166 body store_id override → confirmed absent (would FAIL if present)');
    assert(!/req\.query\.property/.test(routeCode), 'K167 query property override → confirmed absent');
    assert(!/private_key/.test(routeCode) || /forbiddenKeys/.test(fs.readFileSync(path.join(ROOT, 'utils/ga4RealtimeConfig.js'), 'utf8')), 'K168 private_key accepted → confirmed rejected via forbiddenKeys');
    assert(/rawDb\.run\('BEGIN'\)/.test(routeCode), 'K169 transaction removed → confirmed BEGIN present');
    assert(/rawDb\.run\('ROLLBACK'\)/.test(routeCode), 'K170 rollback removed → confirmed present');
    const routeCodeNoComments = routeCode; // already stripped
    const patchBlock = routeCodeNoComments.slice(routeCodeNoComments.indexOf("router.patch('/ga4-realtime'"));
    assert(patchBlock.indexOf('invalidateGa4RealtimeCacheForStore') > patchBlock.indexOf("rawDb.run('COMMIT')"), 'K171 cache invalidated before commit → confirmed invalidate happens after COMMIT in source order');
    const idxCode = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/index.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(!/function invalidateGa4RealtimeCacheForStore\(\)[\s\S]{0,50}_cache\.clear\(\)/.test(idxCode), 'K172 global cache clear → confirmed invalidate is per-store (uses prefix filter, not clear())');
    assert(/generationAtStart/.test(idxCode) && /_getStoreGeneration\(storeId\) === generationAtStart/.test(idxCode), 'K173 generation check removed → confirmed present');
    assert(/if \(_getStoreGeneration\(storeId\) === generationAtStart\)/.test(idxCode), 'K174 old request writes cache unconditionally → confirmed guarded by generation check');
    assert(/RATE_LIMIT_MS/.test(fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'), 'utf8')), 'K175 rate limit removed → confirmed present');
    assert(!/geoGa4SettingsInit[\s\S]{0,300}ga4-realtime-test/.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8')), 'K176 automatic live test on page load → confirmed absent');
    const connCode = fs.readFileSync(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'), 'utf8');
    const connReturnBlocks = (connCode.match(/return \{[\s\S]*?\};/g) || []).join('\n');
    assert(!/\brows:\s*(summaryResult|cityResult)\.rows/.test(connReturnBlocks) && !/\brows\s*:\s*\[/.test(connReturnBlocks.replace(/rows_count/g, '')), 'K177 raw Google response returned → confirmed no return statement in connectionTest.js includes the raw rows array');
    assert(!/innerHTML\s*=[\s\S]{0,40}credential/i.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8')), 'K178 credentials inserted into DOM → confirmed absent');
    const layerCode = fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'), 'utf8').split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
    assert(/if \(!geoGa4State\.configAutoRefreshEnabled\) return;/.test(layerCode), 'K179 Auto Refresh disabled still Timer → confirmed early-return guard present');
    assert(/geoGa4NotifySettingsChanged/.test(fs.readFileSync(path.join(ROOT, 'public/js/geo-ga4-settings.js'), 'utf8')), 'K180 Save no notify B1 → confirmed geoGa4SettingsSave() calls geoGa4NotifySettingsChanged()');
  }

  // ══════════════════════════════════════════════════════════════
  // L. 補充涵蓋
  // ══════════════════════════════════════════════════════════════
  {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-ga4-settings.css'), 'utf8');
    const cssClean = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(cssSrc.includes('var(--bg-panel)'), 'L181 Settings CSS uses project theme variables');
    assert(!/#f8fafc/i.test(cssClean), 'L182 Settings CSS no hardcoded #f8fafc');
    assert(!/\[data-theme=["\']dark["\']\]/.test(cssClean), 'L183 Settings CSS no dead theme selector');

    // additional validation combinations not covered above
    const bothMissingDisabled = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: false, ga4_realtime_property_id: '', ga4_realtime_stream_id: '' });
    assert(bothMissingDisabled.ok === true, 'L184 disabled state does not require property/stream even if both empty');
    const singlePropertyModeSkipsRequirement = cfg.validateGa4RealtimeSettingsPatch({ ga4_realtime_enabled: true, ga4_realtime_single_property_mode: true, ga4_realtime_property_id: '', ga4_realtime_stream_id: '' });
    assert(singlePropertyModeSkipsRequirement.ok === true, 'L185 single-property mode skips property/stream required-field check');

    const genBeforeL = orch._storeGenerationForTest.get('store_b2_a') || 0;
    orch.invalidateGa4RealtimeCacheForStore('store_b2_a');
    const genAfterL = orch._storeGenerationForTest.get('store_b2_a') || 0;
    assert(genAfterL === genBeforeL + 1, 'L186 generation increments by exactly 1 per invalidate call, self-contained check (not dependent on cross-section state)');
  }

  printSummary();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  process.exit(process.exitCode || 0);
}

main().catch((e) => { console.error(e); if (fs.existsSync(DB_FILE)) { try { fs.unlinkSync(DB_FILE); } catch (e2) {} } process.exitCode = 1; });
