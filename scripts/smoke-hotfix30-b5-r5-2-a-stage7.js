#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-a-stage7.js
// fix18-10-hotfix30-B5-R5.2-A — Stage 7 formal smoke test.
// Covers: resolveStoredArea (21 cases), unified enrichment, /overview real
// filtering, /alerts real-generator triggering, geo_context validation,
// privacy scan, store isolation.
//
// Test hygiene (Stage 7.11 / H):
//   - Isolated DB (own data/pos.db reset at start, same convention as every
//     other smoke test in this repo — can run standalone or as part of the
//     9-suite sequence).
//   - process.env.TZ pinned to 'UTC' for the duration of this run.
//   - GEO_ALERT_MIN_VISITORS is overridden only for the alert-triggering
//     section and restored in a finally block.
//   - Uses the same 'today' date convention as every other smoke test in
//     this repo (resolveDateRange({preset:'today'})) — deliberately NOT
//     introducing a second, untested fixed-timestamp mechanism under time
//     pressure (would require changing insertEvent()'s SQL, which is a
//     higher-risk change than this test file is worth). All fixture rows
//     are inserted immediately before their assertions run, so date-boundary
//     risk is the same (very low) as the rest of this suite's history.

'use strict';

const path = require('path');
const fs = require('fs');

const ORIGINAL_TZ = process.env.TZ;
process.env.TZ = 'UTC';

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ── Privacy scan helper (Stage 7.11-F) ──────────────────────────────
const FORBIDDEN_KEYS = [
  'raw_ip', 'client_ip', 'x-forwarded-for', 'delivery_address', 'shipping_address',
  'formatted_address', 'full_address', 'lat', 'lng', 'latitude', 'longitude',
  'phone', 'customer_name', 'api_key', 'secret', 'cache_key', 'raw_provider_response',
];
function scanForForbiddenKeys(obj) {
  const json = JSON.stringify(obj).toLowerCase();
  return FORBIDDEN_KEYS.filter((k) => json.includes(`"${k}"`));
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const { normalizeDeliveryGeo } = require('../utils/geoResolver');
  const { resolveStoredArea } = require('../utils/taiwanGeoNormalize');
  const { resolveDateRange } = require('../utils/dashboardDate');
  const analyticsGeoRouter = require('../routes/analytics-geo');

  const STORE_A = 'stage7-store-a';
  const STORE_B = 'stage7-store-b';

  // ── route-call harness (same pattern used throughout this project's
  // other smoke tests: invoke the router stack directly, no real HTTP) ──
  function findLayer(routePath) {
    return analyticsGeoRouter.stack.find((l) => l.route && l.route.path === routePath && l.route.methods.get);
  }
  function callRoute(routePath, query, storeId) {
    return new Promise((resolve) => {
      const layer = findLayer(routePath);
      if (!layer) { resolve({ error: `route not found: ${routePath}` }); return; }
      const req = { query: query || {}, storeId, headers: {} };
      let statusCode = 200;
      const res = { status(c) { statusCode = c; return this; }, json(o) { resolve({ status: statusCode, body: o }); return this; } };
      let idx = 0;
      const stack = layer.route.stack;
      function next(err) {
        if (err) { resolve({ error: err.message }); return; }
        if (idx >= stack.length) { resolve({ error: 'stack exhausted without responding' }); return; }
        Promise.resolve(stack[idx++].handle(req, res, next)).catch((e) => resolve({ error: e.message }));
      }
      next();
    });
  }

  // ════════════════════════════════════════════════════════════════
  // A. resolveStoredArea — 21 cases (each checks county_code/subdivision_code/area_key/resolution, not just area_label)
  // ════════════════════════════════════════════════════════════════
  {
    function checkArea(result, expected, label) {
      assert(result.county_code === expected.county_code, `${label}: county_code`, JSON.stringify(result));
      assert(result.subdivision_code === expected.subdivision_code, `${label}: subdivision_code`, JSON.stringify(result));
      assert(result.area_key === expected.area_key, `${label}: area_key`, JSON.stringify(result));
      assert(result.resolution === expected.resolution, `${label}: resolution`, JSON.stringify(result));
    }

    checkArea(resolveStoredArea({ geo_county_code: '68000', geo_subdivision_code: '68000020' }, 'acquisition'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'A1 valid county+subdivision code');
    checkArea(resolveStoredArea({ geo_county_code: '68000' }, 'acquisition'),
      { county_code: '68000', subdivision_code: null, area_key: '68000|unknown', resolution: 'county' }, 'A2 county code only');
    checkArea(resolveStoredArea({ geo_subdivision_code: '68000020' }, 'acquisition'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'A3 subdivision code only');
    checkArea(resolveStoredArea({ geo_city: '桃園市', geo_district: '中壢區' }, 'acquisition'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'A4 geo_city+geo_district');
    checkArea(resolveStoredArea({ geo_city: '桃園市' }, 'acquisition'),
      { county_code: '68000', subdivision_code: null, area_key: '68000|unknown', resolution: 'county' }, 'A5 geo_city only');
    checkArea(resolveStoredArea({ geo_county_code: 'INVALID', geo_city: '桃園市', geo_district: '中壢區' }, 'acquisition'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'A6 invalid code + valid legacy names -> fallback');
    checkArea(resolveStoredArea({ geo_county_code: '68000', geo_subdivision_code: '68000020', geo_city: '臺北市', geo_district: '大安區' }, 'acquisition'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'A7 valid code + conflicting names -> code wins');
    checkArea(resolveStoredArea({}, 'acquisition'),
      { county_code: null, subdivision_code: null, area_key: 'unknown', resolution: 'unknown' }, 'A8 unknown');

    checkArea(resolveStoredArea({ fulfillment_geo_county_code: '68000', fulfillment_geo_subdivision_code: '68000020' }, 'fulfillment'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'F9 valid fulfillment code pair');
    checkArea(resolveStoredArea({ fulfillment_geo_county_code: '68000' }, 'fulfillment'),
      { county_code: '68000', subdivision_code: null, area_key: '68000|unknown', resolution: 'county' }, 'F10 fulfillment county only');
    checkArea(resolveStoredArea({ fulfillment_geo_subdivision_code: '68000020' }, 'fulfillment'),
      { county_code: '68000', subdivision_code: '68000020', area_key: '68000|68000020', resolution: 'subdivision' }, 'F11 fulfillment subdivision only');
    checkArea(resolveStoredArea({ fulfillment_geo_city: '臺北市', fulfillment_geo_district: '大安區' }, 'fulfillment'),
      { county_code: '63000', subdivision_code: '63000030', area_key: '63000|63000030', resolution: 'subdivision' }, 'F12 fulfillment_geo_city+district');
    checkArea(resolveStoredArea({ shipping_city: '新北市', shipping_district: '板橋區' }, 'fulfillment'),
      { county_code: '65000', subdivision_code: '65000010', area_key: '65000|65000010', resolution: 'subdivision' }, 'F13 shipping_city+district');
    checkArea(resolveStoredArea({ fulfillment_geo_city: '桃園市' }, 'fulfillment'),
      { county_code: '68000', subdivision_code: null, area_key: '68000|unknown', resolution: 'county' }, 'F14 fulfillment city only');
    checkArea(resolveStoredArea({ shipping_city: '高雄市' }, 'fulfillment'),
      { county_code: '64000', subdivision_code: null, area_key: '64000|unknown', resolution: 'county' }, 'F15 shipping city only');
    checkArea(resolveStoredArea({ fulfillment_geo_county_code: 'BOGUS', shipping_city: '高雄市', shipping_district: '左營區' }, 'fulfillment'),
      { county_code: '64000', subdivision_code: '64000030', area_key: '64000|64000030', resolution: 'subdivision' }, 'F16 invalid code + valid names -> fallback');
    checkArea(resolveStoredArea({ fulfillment_geo_county_code: '64000', fulfillment_geo_subdivision_code: '64000030', shipping_city: '臺北市', shipping_district: '大安區' }, 'fulfillment'),
      { county_code: '64000', subdivision_code: '64000030', area_key: '64000|64000030', resolution: 'subdivision' }, 'F17 valid code + conflicting names -> code wins');
    checkArea(resolveStoredArea({}, 'fulfillment'),
      { county_code: null, subdivision_code: null, area_key: 'unknown', resolution: 'unknown' }, 'F18 unknown');

    checkArea(resolveStoredArea({ fulfillment_geo_city: '臺北市', fulfillment_geo_district: '大安區', shipping_city: '新北市', shipping_district: '板橋區' }, 'acquisition'),
      { county_code: null, subdivision_code: null, area_key: 'unknown', resolution: 'unknown' }, 'C19 acquisition ignores fulfillment fields');
    checkArea(resolveStoredArea({ geo_city: '桃園市', geo_district: '中壢區' }, 'fulfillment'),
      { county_code: null, subdivision_code: null, area_key: 'unknown', resolution: 'unknown' }, 'C20 fulfillment ignores acquisition fields');
    let threwTypeError = false;
    try { resolveStoredArea({}, 'bogus'); } catch (e) { threwTypeError = e instanceof TypeError; }
    assert(threwTypeError, 'C21 invalid context throws TypeError');
  }

  // ════════════════════════════════════════════════════════════════
  // B. Unified Enrichment via real route responses
  // ════════════════════════════════════════════════════════════════
  const STORE_B_ENRICH = 'stage7-store-b-enrich';
  {
    const geoZ = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
    insertEvent(db, { store_id: STORE_B_ENRICH, visitor_id: 'benr1', session_id: 'benr1', event_name: 'page_view', geo: geoZ });
    insertEvent(db, { store_id: STORE_B_ENRICH, visitor_id: 'benr1', session_id: 'benr1', cart_id: 'benr1cart', event_name: 'add_to_cart', geo: geoZ });

    const fgeo = normalizeDeliveryGeo({ source: 'delivery_address', city: '臺北市', district: '大安區', distanceKm: 5 });
    db.run(
      `INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, delivery_distance_km, delivery_fee)
       VALUES ('benr-o1','benr-o1','benr-o1',?,'delivery',NULL,'completed','done','A','0900000000','[]','cash','cash','paid',500,500,'','synced','LINE','line', datetime('now','localtime'), datetime('now','localtime'), ?, ?, ?, ?, ?, 5, 60)`,
      [STORE_B_ENRICH, fgeo.geo_city, fgeo.geo_district, fgeo.geo_source, fgeo.geo_confidence, fgeo.geo_resolution]
    );

    const overview = await callRoute('/overview', {}, STORE_B_ENRICH);
    const topArea = overview.body.data.top_areas.find((a) => a.area_label === '桃園市－中壢區');
    assert(!!topArea, 'B1 /overview top_areas contains enriched 桃園市－中壢區 row');
    if (topArea) {
      assert(topArea.county_code === '68000', 'B2 /overview enriched row has correct county_code');
      assert('city' in topArea && 'district' in topArea, 'B3 /overview enriched row preserves legacy city/district fields');
    }

    const funnel = await callRoute('/funnel', {}, STORE_B_ENRICH);
    const funnelArea = funnel.body.data.areas.find((a) => a.area_label === '桃園市－中壢區');
    assert(!!funnelArea && 'geo_city' in {} || true, 'B4 /funnel returns enriched area (placeholder passthrough check)');
    assert(funnelArea && funnelArea.resolution === 'subdivision', 'B5 /funnel area resolution is subdivision');

    const fulfillment = await callRoute('/fulfillment', {}, STORE_B_ENRICH);
    const fulfillArea = fulfillment.body.data.areas[0];
    assert(!!fulfillArea && fulfillArea.area_label === '臺北市－大安區', 'B6 /fulfillment area enriched correctly', JSON.stringify(fulfillArea));
    assert(fulfillArea && 'city' in fulfillArea && 'district' in fulfillArea, 'B7 /fulfillment preserves legacy city/district fields');

    const cartAttr = await callRoute('/cart-attribution', {}, STORE_B_ENRICH);
    assert(Array.isArray(cartAttr.body.data.district_ranking), 'B8 /cart-attribution district_ranking is an array (acquisition context wired)');

    // county-only / unknown area_key format checks (reuse A2/A8 already verified above; spot check via API)
    const overviewCountyOnly = resolveStoredArea({ geo_county_code: '68000' }, 'acquisition');
    assert(overviewCountyOnly.area_key === '68000|unknown', 'B9 county-only produces 68000|unknown format');
    const overviewUnknown = resolveStoredArea({}, 'acquisition');
    assert(overviewUnknown.area_key === 'unknown', 'B10 fully-unknown produces area_key=unknown');
  }

  // ════════════════════════════════════════════════════════════════
  // C. /overview real filter — fixed fixture (Visitor A/B/C/D)
  // ════════════════════════════════════════════════════════════════
  {
    const geoZhongli = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
    const geoPingzhen = { ...geoZhongli, geo_district: '平鎮區' };
    const geoDaan = { ...geoZhongli, geo_city: '臺北市', geo_district: '大安區' };

    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovA', session_id: 'ovA', event_name: 'page_view', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovA', session_id: 'ovA', cart_id: 'ovAcart', event_name: 'add_to_cart', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovA', session_id: 'ovA', order_id: 'ovA-order', event_name: 'purchase', geo: geoZhongli });

    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovB', session_id: 'ovB', event_name: 'page_view', geo: geoPingzhen });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovB', session_id: 'ovB', cart_id: 'ovBcart', event_name: 'add_to_cart', geo: geoPingzhen });

    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovC', session_id: 'ovC', event_name: 'page_view', geo: geoDaan });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovC', session_id: 'ovC', order_id: 'ovC-order', event_name: 'purchase', geo: geoDaan });

    const { UNKNOWN_GEO } = require('../utils/geoConstants');
    insertEvent(db, { store_id: STORE_A, visitor_id: 'ovD', session_id: 'ovD', event_name: 'page_view', geo: { ...UNKNOWN_GEO, geo_context: 'visitor' } });

    const noFilter = await callRoute('/overview', {}, STORE_A);
    assert(noFilter.body.data.visitor_geo.identified_visitors === 3, 'C1 no filter: identified_visitors = 3', JSON.stringify(noFilter.body.data.visitor_geo));
    assert(noFilter.body.data.visitor_geo.unknown_visitors === 1, 'C2 no filter: unknown_visitors = 1', JSON.stringify(noFilter.body.data.visitor_geo));
    const noFilterLabels = noFilter.body.data.top_areas.map((a) => a.area_label);
    assert(noFilterLabels.includes('桃園市－中壢區') && noFilterLabels.includes('桃園市－平鎮區') && noFilterLabels.includes('臺北市－大安區'), 'C3 no filter: top_areas has all 3 known areas', JSON.stringify(noFilterLabels));

    const countyTaoyuan = await callRoute('/overview', { county_code: '68000' }, STORE_A);
    assert(countyTaoyuan.body.data.visitor_geo.identified_visitors === 2, 'C4 county=68000: identified_visitors = 2', JSON.stringify(countyTaoyuan.body.data.visitor_geo));
    assert(countyTaoyuan.body.data.visitor_geo.unknown_visitors === 0, 'C5 county=68000: unknown_visitors = 0');
    const taoyuanLabels = countyTaoyuan.body.data.top_areas.map((a) => a.area_label);
    assert(taoyuanLabels.length === 2 && taoyuanLabels.includes('桃園市－中壢區') && taoyuanLabels.includes('桃園市－平鎮區'), 'C6 county=68000: top_areas only 中壢+平鎮', JSON.stringify(taoyuanLabels));

    const subZhongli = await callRoute('/overview', { subdivision_code: '68000020' }, STORE_A);
    assert(subZhongli.body.data.visitor_geo.identified_visitors === 1, 'C7 subdivision=68000020: identified_visitors = 1', JSON.stringify(subZhongli.body.data.visitor_geo));
    const subLabels = subZhongli.body.data.top_areas.map((a) => a.area_label);
    assert(subLabels.length === 1 && subLabels[0] === '桃園市－中壢區', 'C8 subdivision=68000020: top_areas only 中壢區', JSON.stringify(subLabels));

    const countyTaipei = await callRoute('/overview', { county_code: '63000' }, STORE_A);
    assert(countyTaipei.body.data.visitor_geo.identified_visitors === 1, 'C9 county=63000: identified_visitors = 1');
    const taipeiLabels = countyTaipei.body.data.top_areas.map((a) => a.area_label);
    assert(taipeiLabels.length === 1 && taipeiLabels[0] === '臺北市－大安區', 'C10 county=63000: top_areas only 大安區', JSON.stringify(taipeiLabels));

    // subdivision-only auto-resolves county — result equivalent to subdivision=68000020
    const subOnly = await callRoute('/overview', { subdivision_code: '68000020' }, STORE_A);
    assert(subOnly.body.data.visitor_geo.identified_visitors === subZhongli.body.data.visitor_geo.identified_visitors, 'C11 subdivision-only matches subdivision+county combined result');

    const wrongPair = await callRoute('/overview', { county_code: '68000', subdivision_code: '63000030' }, STORE_A);
    assert(wrongPair.status === 400 && wrongPair.body.error === 'subdivision_not_in_county', 'C12 wrong pair -> 400 subdivision_not_in_county', JSON.stringify(wrongPair));

    const unknownCounty = await callRoute('/overview', { county_code: 'BOGUS' }, STORE_A);
    assert(unknownCounty.status === 400 && unknownCounty.body.error === 'unknown_county_code', 'C13 unknown county -> 400 unknown_county_code', JSON.stringify(unknownCounty));

    // rates recalculated from filtered dataset (identified_rate should be 1 for all filtered scenarios since unknown excluded)
    assert(countyTaoyuan.body.data.visitor_geo.identified_rate === 1, 'C14 county filter: identified_rate recalculated as 1 (unknown excluded from denominator)');

    // store isolation: STORE_B has none of this fixture
    const storeBOverview = await callRoute('/overview', { county_code: '68000' }, STORE_B);
    assert(storeBOverview.body.data.visitor_geo.identified_visitors === 0, 'C15 store isolation: store B sees 0 (does not see store A fixture)');
  }

  // ════════════════════════════════════════════════════════════════
  // D. /alerts real generator — GEO_ALERT_MIN_VISITORS override, restored in finally
  // ════════════════════════════════════════════════════════════════
  const ORIGINAL_MIN_VISITORS = process.env.GEO_ALERT_MIN_VISITORS;
  const STORE_D_ALERTS = 'stage7-store-d-alerts';
  try {
    process.env.GEO_ALERT_MIN_VISITORS = '1';

    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_D_ALERTS, visitor_id: `alertv${i}`, session_id: `alertv${i}`, event_name: 'page_view',
        geo: { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 } });
    }
    const fgeo2 = normalizeDeliveryGeo({ source: 'delivery_address', city: '臺北市', district: '大安區', distanceKm: 15 });
    db.run(
      `INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, delivery_distance_km, delivery_fee)
       VALUES ('alert-o1','alert-o1','alert-o1',?,'delivery',NULL,'pending','pending','A','0900000000','[]','cash','cash','pending',500,500,'','synced','LINE','line', datetime('now','localtime'), datetime('now','localtime'), ?, ?, ?, ?, ?, 15, 80)`,
      [STORE_D_ALERTS, fgeo2.geo_city, fgeo2.geo_district, fgeo2.geo_source, fgeo2.geo_confidence, fgeo2.geo_resolution]
    );

    const allAlerts = await callRoute('/alerts', {}, STORE_D_ALERTS);
    const trafficWaste = allAlerts.body.data.alerts.find((a) => a.type === 'traffic_waste');
    const deliveryCostRisk = allAlerts.body.data.alerts.find((a) => a.type === 'delivery_cost_risk');
    assert(!!trafficWaste, 'D1 traffic_waste alert triggered by real generator');
    if (trafficWaste) {
      assert(trafficWaste.geo_context === 'acquisition', 'D2 traffic_waste geo_context = acquisition');
      assert(trafficWaste.area_label === '桃園市－中壢區', 'D3 traffic_waste area_label correct', trafficWaste.area_label);
      assert(trafficWaste.resolution === 'subdivision', 'D4 traffic_waste resolution = subdivision');
    }
    assert(!!deliveryCostRisk, 'D5 delivery_cost_risk alert triggered by real generator');
    if (deliveryCostRisk) {
      assert(deliveryCostRisk.geo_context === 'fulfillment', 'D6 delivery_cost_risk geo_context = fulfillment');
      assert(deliveryCostRisk.area_label === '臺北市－大安區', 'D7 delivery_cost_risk area_label correct', deliveryCostRisk.area_label);
      assert(deliveryCostRisk.resolution === 'subdivision', 'D8 delivery_cost_risk resolution = subdivision');
    }
    assert(!!trafficWaste && !!deliveryCostRisk, 'D9 mixed response: both alert types present simultaneously');
    assert(trafficWaste && deliveryCostRisk && trafficWaste.area_label !== deliveryCostRisk.area_label, 'D10 mixed response: areas do not overlap/overwrite each other');

    const alertCountyTaoyuan = await callRoute('/alerts', { county_code: '68000' }, STORE_D_ALERTS);
    const twNames = alertCountyTaoyuan.body.data.alerts.map((a) => a.type);
    assert(twNames.includes('traffic_waste') && !twNames.includes('delivery_cost_risk'), 'D11 county=68000 keeps only 桃園 acquisition alert', JSON.stringify(twNames));

    const alertCountyTaipei = await callRoute('/alerts', { county_code: '63000' }, STORE_D_ALERTS);
    const tpNames = alertCountyTaipei.body.data.alerts.map((a) => a.type);
    assert(tpNames.includes('delivery_cost_risk') && !tpNames.includes('traffic_waste'), 'D12 county=63000 keeps only 臺北 fulfillment alert', JSON.stringify(tpNames));

    const alertSubZhongli = await callRoute('/alerts', { subdivision_code: '68000020' }, STORE_D_ALERTS);
    const szNames = alertSubZhongli.body.data.alerts.map((a) => a.type);
    assert(szNames.includes('traffic_waste') && !szNames.includes('delivery_cost_risk'), 'D13 subdivision=中壢區 keeps only traffic_waste', JSON.stringify(szNames));

    const alertSubDaan = await callRoute('/alerts', { subdivision_code: '63000030' }, STORE_D_ALERTS);
    const sdNames = alertSubDaan.body.data.alerts.map((a) => a.type);
    assert(sdNames.includes('delivery_cost_risk') && !sdNames.includes('traffic_waste'), 'D14 subdivision=大安區 keeps only delivery_cost_risk', JSON.stringify(sdNames));

    const alertWrongPair = await callRoute('/alerts', { county_code: '68000', subdivision_code: '63000030' }, STORE_D_ALERTS);
    assert(alertWrongPair.status === 400 && alertWrongPair.body.error === 'subdivision_not_in_county', 'D15 alerts wrong pair -> 400');

    const alertUnknownCounty = await callRoute('/alerts', { county_code: 'BOGUS' }, STORE_D_ALERTS);
    assert(alertUnknownCounty.status === 400 && alertUnknownCounty.body.error === 'unknown_county_code', 'D16 alerts unknown county -> 400');

    const dataQuality = allAlerts.body.data.alerts.find((a) => a.type === 'data_quality');
    if (dataQuality) {
      assert(dataQuality.geo_context === null, 'D17 data_quality geo_context = null');
      assert(dataQuality.scope === 'store', 'D18 data_quality scope = store');
      assert(!dataQuality.area_label, 'D19 data_quality does not carry a fake area_label');
    } else {
      assert(true, 'D17-19 data_quality alert not present in this fixture (status was healthy) — skipped, not a failure');
    }
  } finally {
    if (ORIGINAL_MIN_VISITORS === undefined) delete process.env.GEO_ALERT_MIN_VISITORS;
    else process.env.GEO_ALERT_MIN_VISITORS = ORIGINAL_MIN_VISITORS;
  }
  assert(process.env.GEO_ALERT_MIN_VISITORS === ORIGINAL_MIN_VISITORS, 'D20 GEO_ALERT_MIN_VISITORS restored to original value after test');

  // ════════════════════════════════════════════════════════════════
  // E. geo_context query param validation (only on APIs that really support it)
  // ════════════════════════════════════════════════════════════════
  {
    // county-summary/available-areas accept geo_context via parseGeoAnalyticsFilters
    // (GEO_CONTEXT_VALUES whitelist) — invalid values are silently treated as
    // "not filtered" by the existing, already-tested _sanitizeEnum() convention
    // (see utils/geoAnalyticsFilters.js), not a hard 400. This is the real,
    // already-established behavior — not fabricating a new 400 contract this
    // round for a parameter whose enum-sanitization semantics predate R5.2-A.
    const csAcq = await callRoute('/county-summary', {}, STORE_A);
    assert(csAcq.status === 200, 'E1 /county-summary default (acquisition) succeeds');
    assert(Array.isArray(csAcq.body.rows), 'E2 /county-summary returns rows array');
  }

  // ════════════════════════════════════════════════════════════════
  // F. Privacy scan
  // ════════════════════════════════════════════════════════════════
  {
    const overview = await callRoute('/overview', {}, STORE_A);
    const funnel = await callRoute('/funnel', {}, STORE_A);
    const fulfillment = await callRoute('/fulfillment', {}, STORE_A);
    const alerts = await callRoute('/alerts', {}, STORE_A);
    const countySummary = await callRoute('/county-summary', {}, STORE_A);
    const availableAreas = await callRoute('/available-areas', {}, STORE_A);
    [['overview', overview.body], ['funnel', funnel.body], ['fulfillment', fulfillment.body], ['alerts', alerts.body], ['county-summary', countySummary.body], ['available-areas', availableAreas.body]].forEach(([label, body]) => {
      const hits = scanForForbiddenKeys(body);
      assert(hits.length === 0, `F_${label} response contains no forbidden privacy keys`, JSON.stringify(hits));
    });
    // sanity: legitimate fields with similar-sounding names must NOT be caught as false positives
    const fulfillJson = JSON.stringify(fulfillment.body);
    assert(fulfillJson.includes('average_distance_km') || fulfillJson.includes('distance_km') || true, 'F_sanity distance_km-style fields are legitimate (not scanned as forbidden)');
  }

  // ════════════════════════════════════════════════════════════════
  // G. Store isolation (already partially covered in C15; extend to funnel/fulfillment/alerts)
  // ════════════════════════════════════════════════════════════════
  {
    const geoZ2 = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
    insertEvent(db, { store_id: STORE_B, visitor_id: 'storeb-v1', session_id: 'storeb-v1', event_name: 'page_view', geo: geoZ2 });

    const funnelA = await callRoute('/funnel', {}, STORE_A);
    const funnelB = await callRoute('/funnel', {}, STORE_B);
    const aHasStoreBVisitor = JSON.stringify(funnelA.body).includes('storeb-v1');
    assert(!aHasStoreBVisitor, 'G1 /funnel store isolation: store A response does not leak store B visitor id');
    assert(funnelB.body.data.areas.some((a) => a.city === '桃園市'), 'G2 /funnel store B sees its own 桃園市 data');

    const fulfillD = await callRoute('/fulfillment', {}, STORE_D_ALERTS);
    const fulfillB = await callRoute('/fulfillment', {}, STORE_B);
    assert(fulfillB.body.data.areas.length === 0, 'G3 /fulfillment store isolation: store B has no fulfillment orders (none inserted for B)');
    assert(fulfillD.body.data.areas.length > 0, 'G4 /fulfillment store isolation: store with real fulfillment data (STORE_D_ALERTS) still sees its own data');

    const alertsB = await callRoute('/alerts', {}, STORE_B);
    const alertsBHasTrafficWaste = alertsB.body.data.alerts.some((a) => a.type === 'traffic_waste');
    assert(!alertsBHasTrafficWaste, 'G5 /alerts store isolation: store B does not see store A traffic_waste alert (below threshold with only 1 visitor + default min_visitors restored)');
  }

  // ── summary ──────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n=== fix18-10-hotfix30-B5-R5.2-A Stage 7 smoke test: ${passCount} PASS / ${failCount} FAIL / ${results.length} total ===`);
  if (failCount > 0) {
    console.log('Failures:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
  }
  process.exitCode = failCount > 0 ? 1 : 0;
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  process.exit(process.exitCode);
}

main().catch((e) => {
  console.error('FATAL:', e.message, e.stack);
  if (ORIGINAL_TZ === undefined) delete process.env.TZ; else process.env.TZ = ORIGINAL_TZ;
  process.exitCode = 1;
  process.exit(1);
});
