#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-3-realtime-event-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// Realtime Event Runtime Gate — 真正串接整條 Pipeline：
//   utils/ga4Realtime/requestBuilder.js
//   → utils/ga4Realtime/requestPair.js
//   → utils/ga4Realtime/client.js（唯一 Mock 注入點：_setClientForTest()）
//   → utils/ga4Realtime/index.js（Aggregator／County Mapping）
//   → routes/geo-live.js（真實 Express Router，透過真實 HTTP Server）
//   → public/js/geo-ga4-realtime-layer.js（真實檔案，經由真實 apiFetch 打
//     這個真實 HTTP Server，不是中途 mock 最終 response）。
//
// Fake Google Client 只從 client._setClientForTest() 這一個既有正式注入點
// 進入，不在 route／aggregator／frontend 中途插入假資料。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('REALTIME EVENT RUNTIME — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

const GA4_EVENT_NAME = { visitors: null, view_item: 'view_item', add_to_cart: 'add_to_cart', checkout: 'begin_checkout', purchase: 'purchase' };

function buildRow(dimHeaderNames, dimValuesMap, metricHeaderNames, metricValuesMap) {
  return {
    dimensionValues: dimHeaderNames.map((h) => ({ value: String((dimValuesMap && dimValuesMap[h]) ?? '') })),
    metricValues: metricHeaderNames.map((h) => ({ value: String((metricValuesMap && metricValuesMap[h]) ?? '0') })),
  };
}
function buildResponse(rows, dimHeaderNames, metricHeaderNames) {
  return [{
    rows,
    dimensionHeaders: dimHeaderNames.map((name) => ({ name })),
    metricHeaders: metricHeaderNames.map((name) => ({ name })),
    propertyQuota: {},
  }];
}

async function main() {
  process.env.GA4_REALTIME_ENABLED = 'true';

  // ── 0. node --check ──
  [
    'scripts/run-g1-6-ga4-h1-3-realtime-event-runtime.js',
    'utils/ga4Realtime/requestBuilder.js',
    'utils/ga4Realtime/requestPair.js',
    'utils/ga4Realtime/client.js',
    'utils/ga4Realtime/index.js',
    'routes/geo-live.js',
    'public/js/geo-ga4-realtime-layer.js',
  ].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const DATA_DIR = path.join(ROOT, 'data');
  const DB_FILE = path.join(DATA_DIR, 'pos.db');
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

  const { initDb, getDb } = require(path.join(ROOT, 'utils/db.js'));
  await initDb();
  const db = getDb();
  const STORE = 'store_re_a';
  db.run('INSERT OR IGNORE INTO stores (store_id, active) VALUES (?,?)', [STORE, 1]);
  function setSetting(storeId, key, value) {
    const updated = db.run('UPDATE settings SET value=? WHERE store_id=? AND key=?', [String(value), storeId, key]);
    if (!updated.changes) db.run('INSERT OR IGNORE INTO settings (store_id,key,value) VALUES (?,?,?)', [storeId, key, String(value)]);
  }
  setSetting(STORE, 'ga4_realtime_enabled', '1');
  setSetting(STORE, 'ga4_realtime_property_id', '111111');
  setSetting(STORE, 'ga4_realtime_stream_id', '9001');

  const client = require(path.join(ROOT, 'utils/ga4Realtime/client.js'));
  const orch = require(path.join(ROOT, 'utils/ga4Realtime/index.js'));
  const connTest = require(path.join(ROOT, 'utils/ga4Realtime/connectionTest.js'));
  const geoLiveRoute = require(path.join(ROOT, 'routes/geo-live.js'));
  const layer = require(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'));

  const express = require('express');
  const app = express();
  app.use(require('body-parser').json());
  app.use((req, res, next) => { req.storeId = STORE; next(); });
  app.use('/api/geo-live', geoLiveRoute);
  const server = app.listen(0);
  const port = server.address().port;
  const fetchImpl = (await import('node-fetch')).default;
  const BASE = `http://localhost:${port}/api/geo-live`;

  function resetAll() { orch.resetForTest(); connTest.resetForTest(); }

  async function getRealtime(metric, windowMinutes, refresh = true) {
    const url = `${BASE}/ga4-realtime?window=${windowMinutes}&metric=${metric}&refresh=${refresh ? '1' : '0'}`;
    const res = await fetchImpl(url);
    const json = await res.json();
    return { httpStatus: res.status, json };
  }

  // ══════════════════════════════════════════════════════════════
  // A. Success Matrix (1-10)
  // ══════════════════════════════════════════════════════════════
  {
    const metrics = ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase'];
    let n = 0;
    for (const metric of metrics) {
      for (const windowMinutes of [5, 30]) {
        n += 1;
        resetAll();
        let captured = [];
        client._setClientForTest({
          async runRealtimeReport(req) {
            captured.push(req);
            const eventName = GA4_EVENT_NAME[metric];
            const dimNames = req.dimensions.map((d) => d.name);
            const dimValues = { city: 'Taoyuan District', countryId: 'TW', eventName: eventName || '', streamId: '9001' };
            const metricNames = req.metrics.map((m) => m.name);
            const metricValues = { activeUsers: 3, eventCount: 7, screenPageViews: 2 };
            return buildResponse([buildRow(dimNames, dimValues, metricNames, metricValues)], dimNames, metricNames);
          },
        });
        const { httpStatus, json } = await getRealtime(metric, windowMinutes);
        const summaryReq = captured.find((r) => !r.dimensions.some((d) => d.name === 'city'));
        const cityReq = captured.find((r) => r.dimensions.some((d) => d.name === 'city'));
        const eventName = GA4_EVENT_NAME[metric];
        const filterOk = eventName
          ? JSON.stringify(summaryReq.dimensionFilter).includes(eventName)
          : true;
        const minuteRangeOk = windowMinutes === 5
          ? summaryReq.minuteRanges[0].startMinutesAgo === 4
          : summaryReq.minuteRanges[0].startMinutesAgo === 29;
        assert(
          httpStatus === 200 && json.success === true && json.data.status !== 'error' && filterOk && minuteRangeOk && !!cityReq,
          `${n}. ${metric} ${windowMinutes}m: correct eventName + minuteRange, Summary+City ok, HTTP 200, no error state`
        );
      }
    }
  }

  // ══════════════════════════════════════════════════════════════
  // B. Zero Event Contract (11-16)
  // ══════════════════════════════════════════════════════════════
  {
    for (const metric of ['view_item', 'add_to_cart', 'checkout', 'purchase']) {
      resetAll();
      client._setClientForTest({
        async runRealtimeReport(req) {
          const dimNames = req.dimensions.map((d) => d.name);
          const metricNames = req.metrics.map((m) => m.name);
          return buildResponse([], dimNames, metricNames); // rows: [] => 0 active users, 0 events
        },
      });
      const { httpStatus, json } = await getRealtime(metric, 30);
      assert(httpStatus === 200 && json.success === true && json.data.status === 'fresh' && json.data.summary.total_active_users_ga4 === 0 && json.data.summary.event_count === 0 && json.data.error_code === null,
        `${metric === 'view_item' ? '11' : metric === 'add_to_cart' ? '12' : metric === 'checkout' ? '13' : '14'}. zero ${metric} → HTTP 200, success:true, legal empty state (not an error)`);
    }

    resetAll();
    client._setClientForTest({ async runRealtimeReport(req) { const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name); return buildResponse([], dn, mn); } });
    const zeroRes = await getRealtime('purchase', 30);
    assert(zeroRes.json.data.status !== 'error', '15. zero event is never misclassified as status=error');

    resetAll();
    client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = 400; throw e; } });
    const errRes = await getRealtime('purchase', 30);
    assert(errRes.json.success === false && errRes.json.status === 'error', '16. a real API error is never silently reported as zero/empty success');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Google Error Family Runtime (17-23)
  // ══════════════════════════════════════════════════════════════
  {
    const errorCases = [
      ['17', 400, 'view_item', '400 / invalid_request'],
      ['19', 403, 'purchase', '403 permission'],
      ['20', 429, 'add_to_cart', '429 rate limit'],
      ['22', 500, 'checkout', '5xx Google server error'],
    ];
    for (const [n, code, metric, label] of errorCases) {
      resetAll();
      client._setClientForTest({ async runRealtimeReport() { const e = new Error('boom'); e.code = code; throw e; } });
      const { httpStatus, json } = await getRealtime(metric, 30);
      const rawStr = JSON.stringify(json);
      assert(json.success === false && json.status === 'error' && typeof json.code === 'string' && typeof json.retryable === 'boolean' && json.stage === 'summary',
        `${n}. ${label}: safe code/stage/retryable/metric surfaced (metric=${metric})`);
      assert(!/boom|stack|at\s+\S+\.js:/i.test(rawStr), `${n}b. ${label}: no raw error.message/stack leaked to route response`);

      const frontendMsg = layer._geoGa4ClassifyErrorFamilyMessage(json.code) || layer.GEO_GA4_ERROR_MESSAGES[json.code] || 'fallback';
      assert(typeof frontendMsg === 'string' && frontendMsg.length > 0 && !/boom/i.test(frontendMsg), `${n}c. ${label}: frontend has a safe, non-raw message for this code`);
    }

    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        const isCity = req.dimensions.some((d) => d.name === 'city');
        if (isCity) { const e = new Error('city boom'); e.code = 400; throw e; }
        const dn = req.dimensions.map((d) => d.name); const mn = req.metrics.map((m) => m.name);
        return buildResponse([buildRow(dn, { eventName: 'view_item', streamId: '9001' }, mn, { activeUsers: 1, eventCount: 1 })], dn, mn);
      },
    });
    const cityFailRes = await getRealtime('view_item', 30);
    assert(cityFailRes.httpStatus === 200 && cityFailRes.json.success === true && cityFailRes.json.data.status === 'partial',
      '18. City-stage 400 alone → Partial Success (HTTP 200, status:partial), consistent with existing Production Contract, not a hard error');

    resetAll();
    process.env.GA4_REALTIME_TIMEOUT_MS = '30';
    client._setClientForTest({ async runRealtimeReport() { await new Promise((r) => setTimeout(r, 300)); return buildResponse([], [], ['activeUsers', 'eventCount']); } });
    const timeoutRes = await getRealtime('purchase', 30);
    assert(timeoutRes.json.success === false && (timeoutRes.json.code === 'TIMEOUT' || timeoutRes.json.retryable === true),
      '21. Timeout surfaced as a safe, retryable error code');
    delete process.env.GA4_REALTIME_TIMEOUT_MS;

    resetAll();
    client._setClientForTest({ async runRealtimeReport() { throw new Error('ECONNRESET'); } });
    const netRes = await getRealtime('add_to_cart', 30);
    assert(netRes.json.success === false && typeof netRes.json.code === 'string', '23. Generic network rejection still produces a safe classified error (no crash)');
  }

  // ══════════════════════════════════════════════════════════════
  // D. Administrative District Regression through Event Metrics (24-27)
  // ══════════════════════════════════════════════════════════════
  {
    async function districtCase(metric, cityName, countryId) {
      resetAll();
      client._setClientForTest({
        async runRealtimeReport(req) {
          const dn = req.dimensions.map((d) => d.name);
          const mn = req.metrics.map((m) => m.name);
          if (dn.includes('city')) {
            return buildResponse([buildRow(dn, { city: cityName, countryId, eventName: GA4_EVENT_NAME[metric], streamId: '9001' }, mn, { activeUsers: 2, eventCount: 3 })], dn, mn);
          }
          return buildResponse([buildRow(dn, { eventName: GA4_EVENT_NAME[metric], streamId: '9001' }, mn, { activeUsers: 2, eventCount: 3 })], dn, mn);
        },
      });
      return getRealtime(metric, 30);
    }

    const pingzhen = await districtCase('view_item', 'Pingzhen District', 'TW');
    assert(pingzhen.json.data.counties.some((c) => c.county_name === '桃園市'), '24. view_item from Pingzhen District maps to 桃園市');
    const yangmei = await districtCase('add_to_cart', 'Yangmei District', 'TW');
    assert(yangmei.json.data.counties.some((c) => c.county_name === '桃園市'), '25. add_to_cart from Yangmei District maps to 桃園市');
    const banqiao = await districtCase('purchase', 'Banqiao District', 'TW');
    assert(banqiao.json.data.counties.some((c) => c.county_name === '新北市'), '26. purchase from Banqiao District maps to 新北市');
    const usPingzhen = await districtCase('view_item', 'Pingzhen District', 'US');
    assert(!usPingzhen.json.data.counties.some((c) => c.county_name === '桃園市') && usPingzhen.json.data.summary.excluded_non_tw_rows >= 1,
      '27. US + Pingzhen District → excluded_non_tw_rows, not mapped to 桃園市');
  }

  // ══════════════════════════════════════════════════════════════
  // E. Dimension/Metric Header reordering robustness (28-29)
  // ══════════════════════════════════════════════════════════════
  {
    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        const isCity = req.dimensions.some((d) => d.name === 'city');
        if (!isCity) {
          const mn = ['eventCount', 'activeUsers'];
          return buildResponse([buildRow([], {}, mn, { activeUsers: 5, eventCount: 9 })], [], mn);
        }
        const dimOrderA = ['eventName', 'city', 'streamId', 'countryId'];
        const mn = ['activeUsers', 'eventCount'];
        return buildResponse([buildRow(dimOrderA, { city: 'Taoyuan District', countryId: 'TW', eventName: 'view_item', streamId: '9001' }, mn, { activeUsers: 4, eventCount: 6 })], dimOrderA, mn);
      },
    });
    const orderA = await getRealtime('view_item', 30);
    assert(orderA.json.data.summary.total_active_users_ga4 === 5 && orderA.json.data.summary.event_count === 9,
      '28. reordered metricHeaders ([eventCount, activeUsers]) still parsed correctly via metricHeaders.indexOf()');
    assert(orderA.json.data.counties.some((c) => c.county_name === '桃園市') && orderA.json.data.counties[0].active_users === 4,
      '28b. reordered dimensionHeaders ([eventName, city, streamId, countryId]) still resolves city/countryId correctly');

    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        const isCity = req.dimensions.some((d) => d.name === 'city');
        if (!isCity) {
          const mn = ['activeUsers', 'eventCount'];
          return buildResponse([buildRow([], {}, mn, { activeUsers: 2, eventCount: 3 })], [], mn);
        }
        const dimOrderB = ['countryId', 'streamId', 'city', 'eventName'];
        const mn = ['activeUsers', 'eventCount'];
        return buildResponse([buildRow(dimOrderB, { city: 'Yangmei District', countryId: 'TW', eventName: 'add_to_cart', streamId: '9001' }, mn, { activeUsers: 7, eventCount: 11 })], dimOrderB, mn);
      },
    });
    const orderB = await getRealtime('add_to_cart', 30);
    assert(orderB.json.data.counties.some((c) => c.county_name === '桃園市' && c.active_users === 7),
      '29. reverse-ordered dimensionHeaders ([countryId, streamId, city, eventName]) still resolves city/countryId correctly (no fixed-index assumption)');
  }

  server.close();

  // ══════════════════════════════════════════════════════════════
  // F. Frontend Interaction Runtime (30-40)
  // ══════════════════════════════════════════════════════════════
  {
    const server2 = app.listen(0);
    const port2 = server2.address().port;
    const BASE2 = `http://localhost:${port2}/api/geo-live`;

    resetAll();
    client._setClientForTest({
      async runRealtimeReport(req) {
        const dn = req.dimensions.map((d) => d.name);
        const mn = req.metrics.map((m) => m.name);
        return buildResponse([buildRow(dn, { city: 'Taoyuan District', countryId: 'TW', eventName: dn.includes('eventName') ? 'view_item' : '', streamId: '9001' }, mn, { activeUsers: 1, eventCount: 1 })], dn, mn);
      },
    });

    const dom = new JSDOM('<div id="c-ga4-toolbar"></div><div id="c-ga4-summary"></div><div id="c-ga4-status"></div><div id="c-ga4-notices"></div>');
    global.window = dom.window;
    global.document = dom.window.document;
    global.L = { layerGroup: () => ({ addTo() { return this; }, clearLayers() {}, addLayer() {} }), geoJSON: () => ({ bindTooltip() { return this; } }) };
    global.window.geoMapState = { instance: {}, featureIndex: { byCountyDistrict: new Map() } };
    global.apiFetch = async (url, opts = {}) => {
      const res = await fetchImpl(`${BASE2}${url.replace('/api/geo-live', '')}`, opts);
      return res;
    };
    global.window.apiFetch = global.apiFetch;

    const layerPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js'));
    delete require.cache[layerPath];
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const freshLayer = require(layerPath);

    let unhandled = 0;
    const onUnhandled = () => { unhandled += 1; };
    process.on('unhandledRejection', onUnhandled);

    await freshLayer.geoGa4FetchAndRender('c-ga4');
    assert(freshLayer.geoGa4State.metric === 'visitors' && freshLayer.geoGa4State.lastPayload && freshLayer.geoGa4State.lastPayload.status !== 'error', '30. initial visitors fetch succeeds via real frontend layer + real HTTP server');

    await freshLayer.geoGa4SetMetric('c-ga4', 'view_item');
    assert(freshLayer.geoGa4State.metric === 'view_item' && freshLayer.geoGa4State.lastPayload.status !== 'error', '30b. Visitors → view_item switch succeeds');
    await freshLayer.geoGa4SetMetric('c-ga4', 'add_to_cart');
    assert(freshLayer.geoGa4State.metric === 'add_to_cart', '31. view_item → add_to_cart switch');
    await freshLayer.geoGa4SetMetric('c-ga4', 'checkout');
    assert(freshLayer.geoGa4State.metric === 'checkout', '32. add_to_cart → checkout switch');
    await freshLayer.geoGa4SetMetric('c-ga4', 'purchase');
    assert(freshLayer.geoGa4State.metric === 'purchase', '32b. checkout → purchase switch');

    await freshLayer.geoGa4SetWindow('c-ga4', 30);
    assert(freshLayer.geoGa4State.windowMinutes === 30, '33. 5m → 30m switch');
    await freshLayer.geoGa4SetWindow('c-ga4', 5);
    assert(freshLayer.geoGa4State.windowMinutes === 5, '34. 30m → 5m switch');

    await freshLayer.geoGa4Refresh('c-ga4');
    assert(freshLayer.geoGa4State.metric === 'purchase', '35. refresh preserves currently selected metric');
    assert(freshLayer.geoGa4State.windowMinutes === 5, '36. refresh preserves currently selected window');

    await Promise.all(Array.from({ length: 20 }, (_, i) => freshLayer.geoGa4SetMetric('c-ga4', ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase'][i % 5])));
    assert(true, '37. 20 rapid metric switches complete without throwing');

    await Promise.all(Array.from({ length: 20 }, (_, i) => freshLayer.geoGa4SetWindow('c-ga4', i % 2 === 0 ? 5 : 30)));
    assert(true, '38. 20 rapid window switches complete without throwing');

    freshLayer.geoGa4FetchAndRender('c-ga4');
    freshLayer.geoGa4Deactivate();
    assert(freshLayer.geoGa4State.active === false, '39. activate/deactivate lifecycle works');

    const abortPromise = freshLayer.geoGa4FetchAndRender('c-ga4');
    freshLayer.geoGa4Deactivate();
    await abortPromise;
    assert(true, '40. abort during a pending request does not throw/crash');

    await new Promise((r) => setTimeout(r, 20));
    process.removeListener('unhandledRejection', onUnhandled);
    assert(unhandled === 0, '40b. zero unhandledRejection observed across the whole frontend interaction sequence, listener removed after');

    server2.close();
  }

  // ══════════════════════════════════════════════════════════════
  // G. event_compat Boolean Contract via real HTTP (41-46)
  // ══════════════════════════════════════════════════════════════
  {
    const server3 = app.listen(0);
    const port3 = server3.address().port;
    let callCount = 0;
    function reinjectClient() {
      client._setClientForTest({
        async runRealtimeReport(req) {
          callCount += 1;
          const dn = req.dimensions.map((d) => d.name);
          const mn = req.metrics.map((m) => m.name);
          return buildResponse(dn.includes('city') ? [buildRow(dn, {}, mn, {})] : [], dn, mn);
        },
      });
    }

    async function postTest(body) {
      const res = await fetchImpl(`http://localhost:${port3}/api/geo-live/ga4-realtime-test`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return res.json();
    }

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({});
    assert(callCount === 2, '41. no event_compat field → Basic Mode (2 calls)', `got ${callCount}`);

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({ event_compat: false });
    assert(callCount === 2, '42. event_compat:false → Basic Mode (2 calls)', `got ${callCount}`);

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({ event_compat: 0 });
    assert(callCount === 2, '43. event_compat:0 → Basic Mode (2 calls)', `got ${callCount}`);

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({ event_compat: 'false' });
    assert(callCount === 2, '44. event_compat:"false" (string) → Basic Mode, NOT coerced truthy (2 calls)', `got ${callCount}`);

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({ event_compat: true });
    assert(callCount === 6, '45. event_compat:true → Event Mode (6 calls: 2 visitors + 4 probes)', `got ${callCount}`);

    resetAll(); reinjectClient(); callCount = 0;
    await postTest({ event_compat: 1 });
    assert(callCount === 6, '46. event_compat:1 → Event Mode (6 calls)', `got ${callCount}`);

    server3.close();
  }

  orch.resetForTest();
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  console.log(`[RESIDUE] unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  printSummary();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
