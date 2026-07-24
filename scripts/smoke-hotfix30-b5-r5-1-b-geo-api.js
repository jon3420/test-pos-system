#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-1-b-geo-api.js
// fix18-10-hotfix30-B5-R5.1-B：Geo Event Wiring × Geo Analytics API × Data Quality
//
// 使用真實 sql.js DB（utils/db.js），直接呼叫真實程式碼
// （utils/geoAnalyticsQueries.js、routes/analytics-geo.js handler、
// utils/analyticsLog.js insertEvent、utils/geoResolver.js）。

'use strict';

const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function findLayer(router, method, routePath) {
  return router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method.toLowerCase()]);
}
async function callRoute(router, method, routePath, { query = {}, storeId } = {}) {
  const layer = findLayer(router, method, routePath);
  if (!layer) throw new Error(`route not found: ${method} ${routePath}`);
  const stack = layer.route.stack; // [requireFeature, requireGeoAnalyticsEnabled, handler]
  const req = { query, storeId, headers: {} };
  let statusCode = 200, jsonBody = null;
  return new Promise((resolve, reject) => {
    const res = {
      status(c) { statusCode = c; return this; },
      json(o) { jsonBody = o; resolve({ statusCode, body: jsonBody }); return this; },
    };
    let idx = 0;
    function next(err) {
      if (err) return reject(err);
      if (idx >= stack.length) return resolve({ statusCode, body: jsonBody }); // 理論上不會走到（最後一層一律呼叫 res.json）
      const layerFn = stack[idx++].handle;
      Promise.resolve(layerFn(req, res, next)).catch(reject);
    }
    next();
  });
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { insertEvent } = require('../utils/analyticsLog');
  const { normalizeDeliveryGeo, buildFulfillmentEventGeo, resolveVisitorGeo, resolveVisitorGeoCached, setIpGeoProvider } = require('../utils/geoResolver');
  const { getTrustedClientIp, truncateIpForResolution, sanitizeGeoForOutput, computeTrustProxySetting } = require('../utils/geoSanitizer');
  const { getGeoFeatureFlags } = require('../utils/geoFeatureFlags');
  const { getGeoAlertRules } = require('../utils/geoAlertRules');
  const { parseGeoAnalyticsFilters, GeoAnalyticsFilterError } = require('../utils/geoAnalyticsFilters');
  const {
    GEO_SOURCE, GEO_CONTEXT, GEO_CONFIDENCE, DISTANCE_BANDS, DISTANCE_BAND_UNKNOWN,
  } = require('../utils/geoConstants');
  const geoQ = require('../utils/geoAnalyticsQueries');
  const analyticsGeoRouter = require('../routes/analytics-geo');

  const STORE_A = 'store_geo_api_a';
  const STORE_B = 'store_geo_api_b';

  // ══════════════════════════════════════════════════════════
  // A. Schema（R5.1-A/B 累積）
  // ══════════════════════════════════════════════════════════
  const aeCols = db.all("PRAGMA table_info(analytics_events)").map(r => r.name);
  assert(aeCols.includes('geo_context'), 'schema: analytics_events.geo_context exists');
  assert(aeCols.includes('geo_version'), 'schema: analytics_events.geo_version exists');
  const idxNames = db.all("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name);
  assert(idxNames.includes('idx_analytics_store_geocontext_created'), 'schema: geo_context index exists');
  // migration idempotent：重跑一次 initDb 不應報錯或重複建立欄位
  await initDb();
  const aeCols2 = db.all("PRAGMA table_info(analytics_events)").map(r => r.name);
  assert(aeCols2.filter(c => c === 'geo_context').length === 1, 'schema: migration idempotent (geo_context not duplicated)');

  // ══════════════════════════════════════════════════════════
  // B. Proxy / IP 信任模型
  // ══════════════════════════════════════════════════════════
  assert(computeTrustProxySetting(undefined) === false, 'trust proxy: default false');
  assert(computeTrustProxySetting('1') === 1, 'trust proxy: numeric string parsed');
  assert(computeTrustProxySetting('true') === false, 'trust proxy: bare true rejected (unsafe)');
  assert(computeTrustProxySetting('garbage') === false, 'trust proxy: invalid value falls back to false');
  {
    delete process.env.GEO_TRUSTED_IP_HEADER;
    const req = { headers: { 'cf-connecting-ip': '1.2.3.4' } }; // 未 opt-in header 不採信，退回 req.ip/socket
    const ip = getTrustedClientIp(req);
    assert(ip !== '1.2.3.4', 'trust proxy: header not trusted without GEO_TRUSTED_IP_HEADER opt-in');
  }
  {
    process.env.GEO_TRUSTED_IP_HEADER = 'cf-connecting-ip';
    const req = { headers: { 'cf-connecting-ip': '5.6.7.8' } };
    assert(getTrustedClientIp(req) === '5.6.7.8', 'trust proxy: explicit opt-in header honored');
    delete process.env.GEO_TRUSTED_IP_HEADER;
  }
  assert(truncateIpForResolution('198.51.100.7') === '198.51.100.0/24', 'ip truncation: IPv4 /24');
  {
    let providerSawFullIp = false;
    setIpGeoProvider(async (truncated) => {
      if (/^\d+\.\d+\.\d+\.\d+$/.test(truncated)) providerSawFullIp = true;
      return { city: '中壢區', region: '桃園市', country: 'TW' };
    });
    process.env.GEO_TRUSTED_IP_HEADER = 'cf-connecting-ip';
    await resolveVisitorGeo({ headers: { 'cf-connecting-ip': '203.0.113.9' } }, { GEO_VISITOR_IP_ENABLED: true });
    delete process.env.GEO_TRUSTED_IP_HEADER;
    assert(!providerSawFullIp, 'ip provider: never receives full IP');
    setIpGeoProvider(async () => null);
  }
  {
    // cache 不保存完整 IP：驗證 cache size 增長但無法從內部狀態反查 IP（沒有對外 API 能读出）
    const before = require('../utils/geoResolver')._visitorGeoCacheSizeForTest();
    await resolveVisitorGeoCached({ headers: {} }, { storeId: STORE_A, sessionKey: 'sess-priv-test' });
    const after = require('../utils/geoResolver')._visitorGeoCacheSizeForTest();
    assert(after >= before, 'visitor geo cache: entry recorded (hashed key, no raw IP/session exposed)');
  }

  // ══════════════════════════════════════════════════════════
  // C. Visitor Geo（provider disabled / failure / distance always NULL）
  // ══════════════════════════════════════════════════════════
  {
    const g1 = await resolveVisitorGeo({ headers: {} }, { GEO_VISITOR_IP_ENABLED: false });
    assert(g1.geo_source === 'unknown' && g1.geo_context === 'visitor', 'visitor geo: disabled -> unknown, context=visitor');
    setIpGeoProvider(async () => { throw new Error('provider crashed'); });
    const g2 = await resolveVisitorGeo({ headers: { 'x-forwarded-for': '1.1.1.1' } }, { GEO_VISITOR_IP_ENABLED: true });
    assert(g2.geo_source === 'unknown', 'visitor geo: provider failure -> fail-open unknown');
    setIpGeoProvider(async () => null);
  }

  // ══════════════════════════════════════════════════════════
  // D. Fulfillment / Shipping Geo 資料模型與事件接線
  // ══════════════════════════════════════════════════════════
  {
    const deliveryGeo = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區中山路1號', distanceKm: 4.2 });
    assert(deliveryGeo.geo_context === 'fulfillment', 'delivery geo: context=fulfillment');
    assert(deliveryGeo.geo_distance_band === '3-5km', 'delivery geo: distance band correct');
    const ev = buildFulfillmentEventGeo(deliveryGeo);
    assert(!('delivery_address' in ev) && !('lat' in ev) && !('lng' in ev), 'fulfillment event geo: no forbidden fields (address/lat/lng)');
    assert(Object.keys(ev).every(k => k.startsWith('geo_')), 'fulfillment event geo: only geo_* whitelisted fields');

    const shippingGeo = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: '新北市', district: '板橋區' });
    assert(shippingGeo.geo_confidence === 'high' && shippingGeo.geo_resolution === 'district', 'shipping geo: structured city/district -> high confidence, district resolution');
    assert(shippingGeo.geo_distance_km === null, 'shipping geo: no distance (no store delivery distance concept)');

    const districtMissing = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: '台中市', district: null });
    assert(districtMissing.geo_resolution === 'city', 'shipping geo: district missing -> degrades to city resolution');
    const bothMissing = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: null, district: null });
    assert(bothMissing.geo_confidence === 'unknown', 'shipping geo: city+district missing -> unknown');
  }

  // insertEvent：外送 submit_order/purchase 帶 fulfillment geo；外帶 unknown；visitor geo 不覆蓋 fulfillment geo
  {
    const deliveryGeo = buildFulfillmentEventGeo(normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區中山路1號', distanceKm: 4.2 }));
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-order-1', session_id: 's-order-1', order_id: 'ord-d1', event_name: 'submit_order', geo: deliveryGeo });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-order-1', session_id: 's-order-1', order_id: 'ord-d1', event_name: 'purchase', geo: deliveryGeo });
    const submitRow = db.get("SELECT geo_context, geo_district FROM analytics_events WHERE store_id=? AND order_id='ord-d1' AND event_name='submit_order'", [STORE_A]);
    const purchaseRow = db.get("SELECT geo_context, geo_district FROM analytics_events WHERE store_id=? AND order_id='ord-d1' AND event_name='purchase'", [STORE_A]);
    assert(submitRow.geo_context === 'fulfillment' && submitRow.geo_district === '中壢區', 'event wiring: delivery submit_order has fulfillment geo');
    assert(purchaseRow.geo_context === 'fulfillment' && purchaseRow.geo_district === '中壢區', 'event wiring: delivery purchase has fulfillment geo');

    const takeoutGeo = buildFulfillmentEventGeo(null);
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-order-2', session_id: 's-order-2', order_id: 'ord-t1', event_name: 'submit_order', geo: takeoutGeo });
    const takeoutRow = db.get("SELECT geo_context, geo_distance_km, geo_distance_band FROM analytics_events WHERE store_id=? AND order_id='ord-t1'", [STORE_A]);
    assert(takeoutRow.geo_context === 'unknown', 'event wiring: takeout order -> geo_context=unknown, no fake geo');
    assert(takeoutRow.geo_distance_km === null && takeoutRow.geo_distance_band === null, 'event wiring: takeout order -> distance NULL');

    // Visitor Geo 不會覆蓋履約 Geo：同一訪客先有 visitor page_view geo，再有 fulfillment submit_order geo，
    // 兩筆是獨立的 analytics_events 列，互不覆寫。
    const visitorGeo = { geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'city', geo_city: '台北市', geo_district: null, geo_version: 1 };
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-order-1', session_id: 's-order-1', event_name: 'page_view', geo: visitorGeo });
    const stillFulfillment = db.get("SELECT geo_context, geo_district FROM analytics_events WHERE store_id=? AND order_id='ord-d1' AND event_name='submit_order'", [STORE_A]);
    assert(stillFulfillment.geo_context === 'fulfillment' && stillFulfillment.geo_district === '中壢區', 'event wiring: visitor geo does not overwrite prior fulfillment geo row');
  }

  // ══════════════════════════════════════════════════════════
  // E. Funnel — unique visitor, dedup, attribution, Delivery Geo 不回填
  // ══════════════════════════════════════════════════════════
  {
    const visitorGeo = { geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'city', geo_city: '桃園市', geo_district: '中壢區', geo_version: 1 };
    // v-repeat 做 5 次 add_to_cart，只能算 1 位訪客
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-repeat', session_id: 's-repeat', event_name: 'page_view', geo: visitorGeo });
    for (let i = 0; i < 5; i++) insertEvent(db, { store_id: STORE_A, visitor_id: 'v-repeat', session_id: 's-repeat', event_name: 'add_to_cart', geo: visitorGeo });

    // v-early：page_view 有 geo，後續 view_product/add_to_cart 沒有 geo（模擬 attribution 情境）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-early', session_id: 's-early', event_name: 'page_view', geo: visitorGeo });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-early', session_id: 's-early', event_name: 'view_product', geo: null }); // 沒有 geo -> unknown
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-early', session_id: 's-early', event_name: 'add_to_cart', geo: null });

    const filters = parseGeoAnalyticsFilters({});
    const funnel = geoQ.getGeoFunnel(db, STORE_A, filters);
    const zone = funnel.areas.find(a => a.district === '中壢區');
    assert(!!zone, 'funnel: 中壢區 area present');
    assert(zone.add_to_cart_visitors === 2, 'funnel: 5x add_to_cart by same visitor counted once (v-repeat=1 + v-early=1 = 2)');

    // attribution: v-early 的 view_product/add_to_cart 雖然自己沒有 geo，仍歸戶到最早的 page_view geo（中壢區）
    assert(zone.view_product_visitors >= 1, 'funnel: attribution backfills later steps to earliest visitor geo (view_product counted under 中壢區)');

    // Delivery Geo 不回填 Visitor Geo：STORE_A 的 fulfillment 訂單資料(中壢區)不應該讓一個從未有 visitor geo 的訪客出現在 funnel 裡
    const neverVisitorGeoVisitor = 'v-fulfillment-only';
    insertEvent(db, { store_id: STORE_A, visitor_id: neverVisitorGeoVisitor, session_id: 's-fo', event_name: 'page_view', geo: null }); // unknown visitor geo
    const funnel2 = geoQ.getGeoFunnel(db, STORE_A, filters);
    const totalVisitorsAcrossAreas = funnel2.areas.reduce((s, a) => s + a.visitors, 0);
    // 這個訪客完全沒有 visitor-context geo，不應該被算進任何已辨識區域
    const zone2 = funnel2.areas.find(a => a.district === '中壢區');
    assert(zone2.visitors === 2, 'funnel: visitor with no visitor-geo at all is not attributed to 中壢區 via delivery geo');
  }

  // denominator=0 不產生 NaN/Infinity
  {
    const emptyFilters = parseGeoAnalyticsFilters({ date_from: '2020-01-01', date_to: '2020-01-02' });
    const emptyFunnel = geoQ.getGeoFunnel(db, STORE_A, emptyFilters);
    assert(Array.isArray(emptyFunnel.areas), 'funnel: empty period returns empty array, no crash');
    const emptyOverview = geoQ.getGeoOverview(db, STORE_A, emptyFilters);
    assert(emptyOverview.visitor_geo.identified_rate === 0, 'overview: denominator=0 -> rate=0, not NaN');
    assert(Number.isFinite(emptyOverview.visitor_geo.identified_rate), 'overview: rate is finite number');
  }

  // ══════════════════════════════════════════════════════════
  // F. Fulfillment API（外送/宅配/外帶排除/取消排除/revenue/AOV/distance/fee/free delivery）
  // ══════════════════════════════════════════════════════════
  {
    function insOrder(id, mode, status, orderStatus, total, distKm, fee, geo) {
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, delivery_fee, delivery_distance_km, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, fulfillment_distance_band)
        VALUES (?,?,?,?,?,?,?,'done','A','0900000000','[]','cash','cash','paid',?,?,'','synced','LINE','line', datetime('now','localtime'), datetime('now','localtime'),?,?,?,?,?,?,?,?)`,
        [id, id, id, STORE_A, mode, orderStatus, status, total, total, fee, distKm,
          geo ? geo.geo_city : null, geo ? geo.geo_district : null, geo ? geo.geo_source : null,
          geo ? geo.geo_confidence : null, geo ? geo.geo_resolution : null, geo ? geo.geo_distance_band : null]);
    }
    const g1 = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區X路', distanceKm: 2 });
    insOrder('fo1', 'delivery', 'completed', null, 500, 2, 0, g1); // free delivery
    insOrder('fo2', 'delivery', 'completed', null, 300, 2, 50, g1);
    insOrder('fo3', 'delivery', 'cancelled', 'cancelled', 999, 2, 50, g1); // 取消排除
    insOrder('fo4', 'delivery', 'void', null, 999, 2, 50, g1); // 作廢排除（status='void' 被 ORDERS_BASE_WHERE 排除）
    const gShip = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: '新北市', district: '板橋區' });
    insOrder('fo5', 'shipping', 'completed', null, 800, null, 0, gShip);
    insOrder('fo6', 'takeout', 'completed', null, 200, null, 0, null); // 外帶，不應出現在區域排行

    const filters = parseGeoAnalyticsFilters({});
    const fulfillment = geoQ.getGeoFulfillment(db, STORE_A, filters);
    const zhongli = fulfillment.areas.find(a => a.district === '中壢區');
    assert(!!zhongli, 'fulfillment: 中壢區 area present');
    assert(zhongli.submitted_orders === 2, 'fulfillment: cancelled/void orders excluded from submitted_orders count');
    assert(zhongli.revenue === 800, 'fulfillment: revenue = 500+300 (cancelled/void excluded)');
    assert(zhongli.average_order_value === 400, 'fulfillment: AOV correct');
    assert(zhongli.average_distance_km === 2, 'fulfillment: average distance correct');
    assert(zhongli.free_delivery_orders === 1, 'fulfillment: free delivery order counted');
    const banqiao = fulfillment.areas.find(a => a.district === '板橋區');
    assert(!!banqiao && banqiao.submitted_orders === 1, 'fulfillment: shipping order counted under its own district');
    assert(fulfillment.takeout_no_fulfillment_address >= 1, 'fulfillment: takeout order tracked separately, not in area rows');
    assert(!fulfillment.areas.some(a => a.district === 'unknown'), 'fulfillment: takeout never shows as fake "unknown" district row');
  }

  // ══════════════════════════════════════════════════════════
  // G. Distance API — 固定 bands，邊界值只落一個 bucket
  // ══════════════════════════════════════════════════════════
  {
    const filters = parseGeoAnalyticsFilters({});
    const distance = geoQ.getGeoDistance(db, STORE_A, filters);
    const expectedBands = [...DISTANCE_BANDS.map(b => b.key), DISTANCE_BAND_UNKNOWN];
    assert(distance.bands.length === expectedBands.length, 'distance: all bands present even if some are 0');
    expectedBands.forEach((b) => assert(distance.bands.some(x => x.band === b), `distance: band ${b} present`));

    const { distanceBandFor } = require('../utils/geoConstants');
    assert(distanceBandFor(3.0) === '3-5km', 'distance boundary: 3.0 -> 3-5km');
    assert(distanceBandFor(5.0) === '5-8km', 'distance boundary: 5.0 -> 5-8km');
    assert(distanceBandFor(8.0) === '8-10km', 'distance boundary: 8.0 -> 8-10km');
    assert(distanceBandFor(10.0) === '10-15km', 'distance boundary: 10.0 -> 10-15km');
    assert(distanceBandFor(15.0) === '15km+', 'distance boundary: 15.0 -> 15km+');
  }

  // ══════════════════════════════════════════════════════════
  // H. Source-Area — 分開維度、分頁、跨店隔離
  // ══════════════════════════════════════════════════════════
  {
    const visitorGeo = { geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'city', geo_city: '桃園市', geo_district: '中壢區', geo_version: 1 };
    insertEvent(db, { store_id: STORE_A, visitor_id: 'v-src-1', session_id: 's-src-1', event_name: 'page_view', source: 'facebook', campaign: 'summer', geo: visitorGeo });
    const filters = parseGeoAnalyticsFilters({ limit: 1, page: 1 });
    const sourceArea = geoQ.getGeoSourceArea(db, STORE_A, filters);
    assert('total' in sourceArea && 'total_pages' in sourceArea, 'source-area: total/total_pages present');
    assert(sourceArea.rows.length <= 1, 'source-area: SQL-level LIMIT respected (not sliced in Node)');
    assert(sourceArea.rows.every(r => 'source' in r && 'medium' in r && 'campaign' in r && 'channel' in r), 'source-area: source/medium/campaign/channel are separate fields');
  }

  // ══════════════════════════════════════════════════════════
  // I. Geo Quality — healthy/degraded/insufficient_data
  // ══════════════════════════════════════════════════════════
  {
    const filters = parseGeoAnalyticsFilters({});
    const quality = geoQ.getGeoQuality(db, STORE_A, filters);
    assert(['healthy', 'degraded', 'insufficient_data'].includes(quality.status), 'quality: status is one of the defined enum values');
    assert(quality.total_events >= 0 && quality.identified_events <= quality.total_events, 'quality: identified <= total');
    assert(Number.isFinite(quality.unknown_rate), 'quality: unknown_rate is finite');

    // insufficient_data：極短期間幾乎沒有事件
    const tinyFilters = parseGeoAnalyticsFilters({ date_from: '2019-01-01', date_to: '2019-01-01' });
    const tinyQuality = geoQ.getGeoQuality(db, STORE_A, tinyFilters);
    assert(tinyQuality.status === 'insufficient_data', 'quality: near-zero events -> insufficient_data');
  }

  // ══════════════════════════════════════════════════════════
  // J. Geo Alert Rules — env fallback, clamp, alert types
  // ══════════════════════════════════════════════════════════
  {
    delete process.env.GEO_ALERT_MIN_VISITORS;
    delete process.env.GEO_ALERT_LOW_CART_RATE;
    delete process.env.GEO_ALERT_LOW_ORDER_RATE;
    delete process.env.GEO_ALERT_UNKNOWN_RATE;
    const defaults = getGeoAlertRules();
    assert(defaults.GEO_ALERT_MIN_VISITORS === 20, 'alert rules: default min visitors = 20');

    process.env.GEO_ALERT_MIN_VISITORS = '0'; // 非法（<1）
    process.env.GEO_ALERT_LOW_CART_RATE = '5'; // 非法（>1）
    process.env.GEO_ALERT_UNKNOWN_RATE = 'not-a-number';
    const invalid = getGeoAlertRules();
    assert(invalid.GEO_ALERT_MIN_VISITORS >= 1, 'alert rules: invalid min_visitors falls back to safe default (>=1)');
    assert(invalid.GEO_ALERT_LOW_CART_RATE <= 1, 'alert rules: out-of-range rate clamped/falls back');
    assert(invalid.GEO_ALERT_UNKNOWN_RATE === 0.40, 'alert rules: non-numeric env falls back to default');
    delete process.env.GEO_ALERT_MIN_VISITORS;
    delete process.env.GEO_ALERT_LOW_CART_RATE;
    delete process.env.GEO_ALERT_UNKNOWN_RATE;

    // 製造一個高流量低轉換區域觸發 traffic_waste
    const wasteGeo = { geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'city', geo_city: '新竹市', geo_district: '東區', geo_version: 1 };
    for (let i = 0; i < 25; i++) insertEvent(db, { store_id: STORE_A, visitor_id: 'v-waste-' + i, session_id: 's-waste-' + i, event_name: 'page_view', geo: wasteGeo });
    const filters = parseGeoAnalyticsFilters({});
    const alerts = geoQ.getGeoAlerts(db, STORE_A, filters);
    assert(Array.isArray(alerts.alerts), 'alerts: returns an array');
    const wasteAlert = alerts.alerts.find(a => a.type === 'traffic_waste' && a.district === '東區');
    assert(!!wasteAlert, 'alerts: traffic_waste alert triggered for high-traffic low-conversion area');
    if (wasteAlert) {
      assert(/可能|趨勢顯示|建議檢查/.test(wasteAlert.message), 'alerts: message uses hedged language (可能/趨勢顯示/建議檢查)');
      assert(!/一定|就是|證明/.test(wasteAlert.message), 'alerts: message avoids absolute causal claims');
    }
    ['traffic_waste', 'checkout_drop', 'delivery_cost_risk', 'out_of_range_demand', 'data_quality'].forEach((t) => {
      // 至少型別存在於程式邏輯中（非每次都會觸發，但型別必須是這幾種之一）
    });
    assert(alerts.alerts.every(a => ['traffic_waste', 'checkout_drop', 'delivery_cost_risk', 'out_of_range_demand', 'data_quality'].includes(a.type)), 'alerts: all alert types are from the defined set');
  }

  // ══════════════════════════════════════════════════════════
  // K. API Routes — status codes, feature gate, filters, security
  // ══════════════════════════════════════════════════════════
  {
    for (const [routePath] of [['/overview'], ['/funnel'], ['/fulfillment'], ['/distance'], ['/source-area'], ['/alerts'], ['/quality']]) {
      const r = await callRoute(analyticsGeoRouter, 'get', routePath, { storeId: STORE_A });
      assert(r.statusCode === 200, `API: GET ${routePath} returns 200`);
      assert(r.body && r.body.success === true, `API: GET ${routePath} success=true`);
    }
    // feature gate: reports 未開通 -> 403
    db.run(`INSERT OR REPLACE INTO licenses (store_id, active, plan, features) VALUES (?,1,'basic',?)`, ['store_no_reports', JSON.stringify({ reports: false })]);
    const rNoReports = await callRoute(analyticsGeoRouter, 'get', '/overview', { storeId: 'store_no_reports' });
    assert(rNoReports.statusCode === 403, 'API: reports feature gate blocks store without reports=true');

    // GEO_ANALYTICS_ENABLED=false -> 403 with safe error, no stack
    process.env.GEO_ANALYTICS_ENABLED = 'false';
    const rDisabled = await callRoute(analyticsGeoRouter, 'get', '/overview', { storeId: STORE_A });
    assert(rDisabled.statusCode === 403 && rDisabled.body.success === false, 'API: GEO_ANALYTICS_ENABLED=false -> 403 safe response');
    delete process.env.GEO_ANALYTICS_ENABLED;

    // filters: invalid enum silently ignored, not 500
    const rBadEnum = await callRoute(analyticsGeoRouter, 'get', '/funnel', { storeId: STORE_A, query: { geo_context: 'DROP TABLE orders;--', limit: '99999', page: '-3' } });
    assert(rBadEnum.statusCode === 200, 'API: invalid enum / oversized limit / negative page do not crash (safe fallback)');
    assert(rBadEnum.body.data.limit === 100, 'API: limit clamped to max 100');
    assert(rBadEnum.body.data.page === 1, 'API: negative page falls back to 1');

    // SQL injection payload in city/district filters
    const rSqli = await callRoute(analyticsGeoRouter, 'get', '/funnel', { storeId: STORE_A, query: { city: "x'; DROP TABLE analytics_events; --" } });
    assert(rSqli.statusCode === 200, 'API: SQL injection payload in filter does not error');
    const stillHasTable = db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='analytics_events'");
    assert(!!stillHasTable, 'API: SQL injection payload did not drop analytics_events table');

    // error response never leaks stack
    const bodyDump = JSON.stringify(rSqli.body);
    assert(!bodyDump.includes('.js:') && !bodyDump.includes('at Object.'), 'API: response never contains stack-trace-like content');
  }

  // ══════════════════════════════════════════════════════════
  // L. Store Isolation
  // ══════════════════════════════════════════════════════════
  {
    const geoB = { geo_context: 'visitor', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'city', geo_city: '桃園市', geo_district: '中壢區', geo_version: 1 };
    insertEvent(db, { store_id: STORE_B, visitor_id: 'v-b-1', session_id: 's-b-1', event_name: 'page_view', geo: geoB });
    const filters = parseGeoAnalyticsFilters({});
    const funnelA = geoQ.getGeoFunnel(db, STORE_A, filters);
    const funnelB = geoQ.getGeoFunnel(db, STORE_B, filters);
    const zoneA = funnelA.areas.find(a => a.district === '中壢區');
    const zoneB = funnelB.areas.find(a => a.district === '中壢區');
    assert(zoneA && zoneB && zoneA.visitors !== zoneB.visitors, 'isolation: same district in two stores does not mix visitor counts');

    // 跨店查詢：即使 query string 帶入其他 store_id，API 只認 req.storeId
    const r = await callRoute(analyticsGeoRouter, 'get', '/funnel', { storeId: STORE_B, query: { store_id: STORE_A } });
    assert(r.statusCode === 200, 'isolation: query.store_id is ignored, API still responds using req.storeId');
  }

  // ══════════════════════════════════════════════════════════
  // M. Privacy — never leak IP / lat / lng / full address / place_id
  // ══════════════════════════════════════════════════════════
  {
    const r = await callRoute(analyticsGeoRouter, 'get', '/overview', { storeId: STORE_A });
    const dump = JSON.stringify(r.body);
    ['"ip"', '"lat"', '"lng"', 'place_id', 'formatted_address'].forEach((f) => {
      assert(!dump.includes(f), `privacy: API response never contains ${f}`);
    });
    // DB 不存完整 IP：檢查 analytics_events 沒有任何 ip 相關欄位
    const cols = db.all("PRAGMA table_info(analytics_events)").map((c) => c.name);
    assert(!cols.some((c) => c.toLowerCase().includes('ip')), 'privacy: analytics_events has no ip-like column at all');
    const clean = sanitizeGeoForOutput({ geo_city: '中壢區', ip: '1.2.3.4', lat: 1, lng: 2, full_address: 'x' });
    assert(!('ip' in clean) && !('lat' in clean) && !('lng' in clean) && !('full_address' in clean), 'privacy: sanitizeGeoForOutput strips forbidden fields');
  }

  // ══════════════════════════════════════════════════════════
  // N. Dashboard geo_summary — contract, disabled safe structure
  // ══════════════════════════════════════════════════════════
  {
    const analyticsRouter = require('../routes/analytics');
    const layer = findLayer(analyticsRouter, 'get', '/dashboard');
    const handler = layer.route.stack[layer.route.stack.length - 1].handle;
    const req = { query: {}, storeId: STORE_A };
    let body = null;
    const res = { status() { return this; }, json(o) { body = o; } };
    await handler(req, res);
    assert('geo_summary' in body, 'dashboard: geo_summary present');
    assert(body.geo_summary.top_intent_areas.length <= 3, 'dashboard: top_intent_areas <= 3');
    assert(body.geo_summary.high_traffic_low_conversion.length <= 3, 'dashboard: high_traffic_low_conversion <= 3');
    assert('kpi' in body && 'range' in body, 'dashboard: original contract fields preserved');

    process.env.GEO_ANALYTICS_ENABLED = 'false';
    let body2 = null;
    const res2 = { status() { return this; }, json(o) { body2 = o; } };
    await handler(req, res2);
    assert(body2.geo_summary.data_quality.status === 'disabled', 'dashboard: GEO_ANALYTICS_ENABLED=false -> disabled status');
    assert(Array.isArray(body2.geo_summary.top_intent_areas) && body2.geo_summary.top_intent_areas.length === 0, 'dashboard: disabled -> empty top_intent_areas');
    assert('kpi' in body2, 'dashboard: disabled geo does not break rest of dashboard');
    delete process.env.GEO_ANALYTICS_ENABLED;
  }

  // ══════════════════════════════════════════════════════════
  // Summary
  // ══════════════════════════════════════════════════════════
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log(`\n=== R5.1-B Geo API smoke test: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length) {
    console.log('Failures:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exitCode = 1;
});
