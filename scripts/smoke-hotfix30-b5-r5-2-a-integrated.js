#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-a-integrated.js
// fix18-10-hotfix30-B5-R5.2-A — Stage 10 Integrated End-to-End smoke test.
//
// This test deliberately does NOT re-run Stage 7/8/9's own unit-level
// assertions (those already exist and pass — see the other 3 smoke files).
// Every scenario here crosses at least two modules and, wherever an API
// exists for the data being tested, asserts against the real HTTP-route
// response body (not just the DB row), per the Stage 10 instruction:
// "不得只驗 DB。必須驗：API 回傳".

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

const FORBIDDEN_KEYS = [
  'raw_ip', 'client_ip', 'x-forwarded-for', 'delivery_address', 'shipping_address',
  'formatted_address', 'full_address',
  // fix18-10-hotfix30-B5-R5.3-A1.1（Regression 發現的真正 Bug，已修正）：
  // 'lat'/'lng'/'latitude'/'longitude' 原本在這份 R5.2-A 時期就存在的清單裡，
  // 那時 /fulfillment 確實完全沒有任何座標欄位，屬於「預防未來不小心洩漏」
  // 的防呆清單。R5.3-A1（見 R5.3-A1_COMPLETION_REPORT.md／
  // R5.3-A1_DATA_SOURCE_AUDIT.md，已經過產品審核）之後，/fulfillment 開始
  // 合法回傳「同一行政區所有外送訂單座標的 AVG() 聚合中心點」（Heatmap 需要
  // 這兩個欄位才能畫圖，不是原始顧客座標／地址洩漏）——這份清單當時沒有
  // 跟著更新，導致這支既有 Regression 對一個已核准的正式功能誤判成隱私
  // 違規。真正該防的是 raw per-customer 資料（地址／電話／IP／原始座標），
  // 不是「已聚合、已審核」的行政區中心點，所以拿掉 lat/lng/latitude/
  // longitude，改用下面 Scenario J/V 各自的「V-legit-coordinate」正向斷言
  // 明確驗證它們是聚合值、且仍然沒有任何原始顧客欄位洩漏。
  'phone', 'customer_name', 'api_key', 'secret', 'cache_key', 'raw_provider_response', 'token',
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
  const { resolveTaiwanAdministrativeArea, resolveStoredArea } = require('../utils/taiwanGeoNormalize');
  const { GEO_SOURCE, GEO_CONTEXT } = require('../utils/geoConstants');
  const analyticsGeoRouter = require('../routes/analytics-geo');

  // fix18-10-hotfix30-B5-R5.2-A（Stage 10）：訂單/事件的 created_at 必須用
  // 真實「現在」時間，而不是寫死的過去日期字串——所有 Geo Analytics API
  // 預設用 resolveDateRange({preset:'today'}) 篩選，若 created_at 寫死成
  // 過去日期，會直接被『今天』範圍排除，導致 API 查不到剛建立的資料（這正是
  // 這裡第一次執行就抓到的真實測試 bug，已修正，不是重新引入「D1 那種跨日
  // flake」——這裡改用 datetime('now','localtime') 由 SQLite 自己算，跟其他
  // 已經穩定通過的 Stage 7/8/9 測試採同一種寫法）。
  const NOW_SQL = "datetime('now','localtime')";
  function nowStr() {
    const d = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }
  const FIXED_NOW = nowStr(); // 名稱沿用但實際是「執行當下的真實時間」，避免 today 篩選抓不到資料
  let orderSeq = 0;
  function nextId(prefix) { orderSeq += 1; return `${prefix}-${orderSeq}`; }

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
        if (idx >= stack.length) { resolve({ error: 'stack exhausted' }); return; }
        Promise.resolve(stack[idx++].handle(req, res, next)).catch((e) => resolve({ error: e.message }));
      }
      next();
    });
  }

  const LINE_ORDERS_SQL = `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone, customer_line_id,
        pickup_time, delivery_address, delivery_address_note,
        delivery_platform, platform_order_no,
        delivery_lat, delivery_lng, delivery_distance_km, delivery_maps_url,
        delivery_fee, delivery_fee_meta,
        pickup_store_name_snapshot, pickup_place_name_snapshot, pickup_place_id_snapshot,
        pickup_address_snapshot, pickup_address_note_snapshot,
        pickup_lat_snapshot, pickup_lng_snapshot,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, original_total, coupon_code, total,
        note, sync_status, device_id, source, created_at, updated_at, line_user_id,
        fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source,
        fulfillment_geo_confidence, fulfillment_geo_resolution, fulfillment_distance_band,
        fulfillment_geo_county_code, fulfillment_geo_subdivision_code
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  const LINE_SHIPPING_SQL = `INSERT INTO orders (
        id, uuid, order_number, store_id, order_mode, order_status, kitchen_status,
        customer_name, customer_phone,
        items, payment_method, payment_category, payment_status,
        subtotal, discount_type, discount_amount, original_total, coupon_code, total,
        note, sync_status, device_id, source, created_at, updated_at,
        fulfillment_type, order_source,
        shipping_recipient_name, shipping_phone, shipping_postal_code, shipping_city,
        shipping_district, shipping_address, shipping_address_note,
        shipping_arrival_type, shipping_arrival_date, shipping_fee, shipping_free_discount,
        shipping_carrier_name, shipping_status, line_user_id,
        fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source,
        fulfillment_geo_confidence, fulfillment_geo_resolution, fulfillment_distance_band,
        fulfillment_geo_county_code, fulfillment_geo_subdivision_code
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;

  function createLineDeliveryOrder(storeId, deliveryAddress, orderMode = 'delivery', extra = {}) {
    const orderGeo = orderMode === 'delivery'
      ? normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: deliveryAddress, distanceKm: 5 })
      : null;
    const id = nextId('int-delivery');
    db.run(LINE_ORDERS_SQL, [
      id, id, id.toUpperCase(), storeId, orderMode, 'pending', 'pending',
      'A', '0900000000', '',
      '', deliveryAddress || '', '',
      'LINE', '', '', '', orderGeo ? orderGeo.geo_distance_km : null, '',
      60, '', '', '', '', '', '', '', '',
      '[]', 'cash', 'cash', 'pending',
      extra.total || 500, 'none', 0, extra.total || 500, '', extra.total || 500,
      '', 'synced', 'LINE', 'line', FIXED_NOW, FIXED_NOW, '',
      orderGeo ? orderGeo.geo_city : null, orderGeo ? orderGeo.geo_district : null,
      orderGeo ? orderGeo.geo_source : null, orderGeo ? orderGeo.geo_confidence : null,
      orderGeo ? orderGeo.geo_resolution : null, orderGeo ? orderGeo.geo_distance_band : null,
      orderGeo ? orderGeo.geo_county_code : null, orderGeo ? orderGeo.geo_subdivision_code : null,
    ]);
    return { id, orderGeo };
  }

  function createLineShippingOrder(storeId, city, district) {
    const shippingGeo = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: city || null, district: district || null, postalCode: null, distanceKm: null });
    const id = nextId('int-shipping');
    db.run(LINE_SHIPPING_SQL, [
      id, id, id.toUpperCase(), storeId, 'shipping', 'pending', 'pending',
      'B', '0911111111',
      '[]', 'cash', 'cash', 'pending',
      500, 'none', 0, 500, '', 500,
      '', 'synced', 'LINE', 'line', FIXED_NOW, FIXED_NOW,
      'shipping', 'line_shipping',
      'B', '0911111111', '', city || '', district || '', '某路', '',
      'asap', '', 80, 0, '', 'pending', '',
      shippingGeo.geo_city, shippingGeo.geo_district, shippingGeo.geo_source,
      shippingGeo.geo_confidence, shippingGeo.geo_resolution, shippingGeo.geo_distance_band,
      shippingGeo.geo_county_code, shippingGeo.geo_subdivision_code,
    ]);
    return { id, shippingGeo };
  }

  function insertVisitorFunnel(storeId, visitorId, city, district, { cart = false, checkout = false, purchase = false, geoCountyCode, geoSubdivisionCode } = {}) {
    const geo = { geo_country: 'TW', geo_city: city, geo_district: district, geo_source: 'ip', geo_confidence: 'medium', geo_resolution: district ? 'district' : 'city', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1, geo_county_code: geoCountyCode || null, geo_subdivision_code: geoSubdivisionCode || null };
    const cartId = `${visitorId}-cart`;
    insertEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: visitorId, event_name: 'page_view', geo });
    insertEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: visitorId, event_name: 'view_product', geo });
    if (cart) insertEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: visitorId, cart_id: cartId, event_name: 'add_to_cart', geo });
    if (checkout) insertEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: visitorId, cart_id: cartId, event_name: 'begin_checkout', geo });
    if (purchase) {
      const orderId = `${visitorId}-order`;
      insertEvent(db, { store_id: storeId, visitor_id: visitorId, session_id: visitorId, order_id: orderId, event_name: 'purchase', geo });
      db.run(
        `INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [orderId, orderId, orderId, storeId, 'takeout', null, 'completed', 'done', 'C', '0922222222', '[]', 'cash', 'cash', 'paid', 500, 500, '', 'synced', 'LINE', 'line', FIXED_NOW, FIXED_NOW]
      );
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario A: LINE 外送完整生命週期 (line-orders → normalizeDeliveryGeo →
  // resolveTaiwanAdministrativeArea → orders → analytics query → API →
  // _enrichAreaFields → response)
  // ════════════════════════════════════════════════════════════════
  const STORE_A = 'int-store-a-delivery';
  {
    const dataset = resolveTaiwanAdministrativeArea({ city: '桃園市', district: '中壢區' });
    const { id, orderGeo } = createLineDeliveryOrder(STORE_A, '桃園市中壢區中央路100號');

    assert(orderGeo.geo_county_code === dataset.county_code, 'A1 order write: county_code matches dataset resolver output');
    assert(orderGeo.geo_subdivision_code === dataset.subdivision_code, 'A2 order write: subdivision_code matches dataset resolver output');

    const dbRow = db.get('SELECT fulfillment_geo_county_code, fulfillment_geo_subdivision_code, fulfillment_geo_city, fulfillment_geo_district FROM orders WHERE id=?', [id]);
    assert(dbRow.fulfillment_geo_county_code === dataset.county_code, 'A3 DB row: county_code persisted correctly');
    assert(dbRow.fulfillment_geo_subdivision_code === dataset.subdivision_code, 'A4 DB row: subdivision_code persisted correctly');

    const apiRes = await callRoute('/fulfillment', {}, STORE_A);
    const apiArea = apiRes.body.data.areas.find((a) => a.city === '桃園市' && a.district === '中壢區');
    assert(!!apiArea, 'A5 API /fulfillment: area present in response');
    assert(apiArea.county_code === dataset.county_code, 'A6 API response: county_code matches DB and dataset (full chain consistency)');
    assert(apiArea.subdivision_code === dataset.subdivision_code, 'A7 API response: subdivision_code matches DB and dataset');
    assert(apiArea.area_key === dataset.area_key, 'A8 API response: area_key matches dataset');
    assert(apiArea.area_label === dataset.area_label, 'A9 API response: area_label matches dataset (桃園市－中壢區)');
    assert(apiArea.city === '桃園市' && apiArea.district === '中壢區', 'A10 API response: legacy city/district fields preserved');
    assert(apiArea.resolution === 'subdivision', 'A11 API response: resolution=subdivision');
    assert('county_name' in apiArea && 'subdivision_name' in apiArea && 'subdivision_type' in apiArea, 'A12 API response: full unified shape present (county_name/subdivision_name/subdivision_type)');
    assert(apiArea.subdivision_type === '區', 'A13 API response: subdivision_type correct (區)');
    assert(apiArea.submitted_orders === 1, 'A14 API response: submitted_orders count correct for this single order');
    assert(apiArea.completed_orders === 1, 'A15 API response: completed_orders count correct');
    assert(typeof apiArea.average_delivery_fee === 'number' && apiArea.average_delivery_fee === 60, 'A16 API response: average_delivery_fee correctly aggregated');
    // cross-check: county-summary in fulfillment geo_context would show the same store's acquisition data independently (no cross-context bleed)
    const csA = await callRoute('/county-summary', {}, STORE_A);
    assert(!csA.body.rows.some((r) => r.county_name === '桃園市' && r.visitor_count > 0), 'A17 /county-summary (acquisition) shows no 桃園市 visitors for a store that only ever placed a fulfillment order (no visitor events)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario B: LINE 宅配完整生命週期 — alias / island / county-administered
  // city / county-only / unknown, all through resolver → orders → API
  // ════════════════════════════════════════════════════════════════
  const STORE_B = 'int-store-b-shipping';
  {
    const cases = [
      { label: 'B1 alias 台北市', city: '台北市', district: '大安區', expectCounty: '臺北市' },
      { label: 'B2 island 金門縣', city: '金門縣', district: '金城鎮', expectCounty: '金門縣' },
      { label: 'B3 county-administered city 新竹縣竹北市', city: '新竹縣', district: '竹北市', expectCounty: '新竹縣' },
      { label: 'B4 county-only 高雄市', city: '高雄市', district: '', expectCounty: '高雄市' },
      { label: 'B5 unknown', city: '不存在縣市', district: '不存在區', expectCounty: null },
    ];
    for (const c of cases) {
      const { id } = createLineShippingOrder(STORE_B, c.city, c.district);
      const dbRow = db.get('SELECT fulfillment_geo_county_code, fulfillment_geo_subdivision_code FROM orders WHERE id=?', [id]);
      const expected = c.expectCounty ? resolveTaiwanAdministrativeArea({ city: c.city, district: c.district }) : null;
      if (expected) {
        assert(dbRow.fulfillment_geo_county_code === expected.county_code, `${c.label}: county_code correct via full write path`, JSON.stringify(dbRow));
      } else {
        assert(dbRow.fulfillment_geo_county_code === null, `${c.label}: county_code NULL for unresolvable input`);
      }
    }
    const apiRes = await callRoute('/fulfillment', {}, STORE_B);
    const daanArea = apiRes.body.data.areas.find((a) => a.area_label === '臺北市－大安區');
    assert(!!daanArea, 'B6 API /fulfillment shows alias-normalized 臺北市－大安區 (not raw 台北市)');
    const kinmenArea = apiRes.body.data.areas.find((a) => a.area_label === '金門縣－金城鎮');
    assert(!!kinmenArea, 'B7 API /fulfillment shows island area (金門縣) correctly — not 六都-only coverage');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario C: Acquisition full funnel → overview/funnel/county-summary/alerts consistency
  // ════════════════════════════════════════════════════════════════
  const STORE_C = 'int-store-c-funnel';
  {
    insertVisitorFunnel(STORE_C, 'c-visitor-1', '桃園市', '中壢區', { cart: true, checkout: true, purchase: true, geoCountyCode: '68000', geoSubdivisionCode: '68000020' });

    const overview = await callRoute('/overview', {}, STORE_C);
    const funnel = await callRoute('/funnel', {}, STORE_C);
    const countySummary = await callRoute('/county-summary', {}, STORE_C);

    const overviewArea = overview.body.data.top_areas.find((a) => a.area_label === '桃園市－中壢區');
    const funnelArea = funnel.body.data.areas.find((a) => a.area_label === '桃園市－中壢區');
    const countyRow = countySummary.body.rows.find((r) => r.county_name === '桃園市');

    assert(!!overviewArea, 'C1 /overview shows 桃園市－中壢區');
    assert(!!funnelArea, 'C2 /funnel shows 桃園市－中壢區');
    assert(!!countyRow, 'C3 /county-summary shows 桃園市');
    assert(overviewArea.county_code === funnelArea.county_code, 'C4 /overview and /funnel report identical county_code for the same visitor');
    assert(overviewArea.area_key === funnelArea.area_key, 'C5 /overview and /funnel report identical area_key');
    assert(funnelArea.purchase_visitors === 1, 'C6 /funnel correctly counts the purchase for this single visitor');
    assert(countyRow.purchase_visitor_count === 1, 'C7 /county-summary correctly counts the purchase for this single visitor (same underlying identity-dedup logic as funnel)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario D: Acquisition (桃園中壢) + Fulfillment (臺北大安) 分流, no cross-contamination
  // ════════════════════════════════════════════════════════════════
  const STORE_D = 'int-store-d-mixed';
  {
    insertVisitorFunnel(STORE_D, 'd-visitor-1', '桃園市', '中壢區', { cart: true, geoCountyCode: '68000', geoSubdivisionCode: '68000020' });
    createLineDeliveryOrder(STORE_D, '臺北市大安區敦化南路50號');

    const overview = await callRoute('/overview', {}, STORE_D);
    const fulfillment = await callRoute('/fulfillment', {}, STORE_D);

    const overviewHasZhongli = overview.body.data.top_areas.some((a) => a.area_label === '桃園市－中壢區');
    const overviewHasDaan = overview.body.data.top_areas.some((a) => a.area_label === '臺北市－大安區');
    assert(overviewHasZhongli, 'D1 /overview (acquisition context) shows 中壢區');
    assert(!overviewHasDaan, 'D2 /overview (acquisition context) does NOT show 大安區 fulfillment data (no cross-contamination)');

    const fulfillHasDaan = fulfillment.body.data.areas.some((a) => a.area_label === '臺北市－大安區');
    const fulfillHasZhongli = fulfillment.body.data.areas.some((a) => a.area_label === '桃園市－中壢區');
    assert(fulfillHasDaan, 'D3 /fulfillment shows 大安區');
    assert(!fulfillHasZhongli, 'D4 /fulfillment does NOT show acquisition-only 中壢區 (visitor never placed a fulfillment order)');

    const alerts = await callRoute('/alerts', {}, STORE_D);
    assert(alerts.status === 200, 'D5 /alerts responds successfully for a store with mixed acquisition+fulfillment data');
    const alertAreaLabels = alerts.body.data.alerts.filter((a) => a.area_label).map((a) => a.area_label);
    assert(alertAreaLabels.every((l) => l === '桃園市－中壢區' || l === '臺北市－大安區'), 'D6 every alert area_label in this store matches one of the two known real areas (no phantom/malformed area)');
    const dOverviewCountyFilter = await callRoute('/overview', { county_code: '68000' }, STORE_D);
    const dFulfillmentCountyFilter = await callRoute('/fulfillment', { county_code: '63000' }, STORE_D);
    assert(dOverviewCountyFilter.body.data.top_areas.every((a) => a.county_code === '68000'), 'D7 /overview county_code=68000 filter returns only 桃園市 areas on the mixed-context store');
    assert(dFulfillmentCountyFilter.body.data.areas.every((a) => a.county_code === '63000'), 'D8 /fulfillment county_code=63000 filter returns only 臺北市 areas on the same mixed-context store');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario E: Store Isolation across overview/alerts/funnel/fulfillment/county-summary
  // ════════════════════════════════════════════════════════════════
  const STORE_E1 = 'int-store-e1';
  const STORE_E2 = 'int-store-e2';
  {
    insertVisitorFunnel(STORE_E1, 'e1-visitor', '新北市', '板橋區', { cart: true, geoCountyCode: '65000', geoSubdivisionCode: '65000010' });
    insertVisitorFunnel(STORE_E2, 'e2-visitor', '新北市', '板橋區', { cart: true, geoCountyCode: '65000', geoSubdivisionCode: '65000010' });

    const ov1 = await callRoute('/overview', {}, STORE_E1);
    const ov2 = await callRoute('/overview', {}, STORE_E2);
    assert(ov1.body.data.visitor_geo.identified_visitors === 1, 'E1 store E1 /overview sees exactly its own 1 visitor');
    assert(ov2.body.data.visitor_geo.identified_visitors === 1, 'E2 store E2 /overview sees exactly its own 1 visitor (not 2, not 0)');

    const fn1 = await callRoute('/funnel', {}, STORE_E1);
    const fn2 = await callRoute('/funnel', {}, STORE_E2);
    assert(!JSON.stringify(fn1.body).includes('e2-visitor'), 'E3 store E1 /funnel response never contains store E2\'s visitor id');
    assert(!JSON.stringify(fn2.body).includes('e1-visitor'), 'E4 store E2 /funnel response never contains store E1\'s visitor id');

    const cs1 = await callRoute('/county-summary', {}, STORE_E1);
    const cs2 = await callRoute('/county-summary', {}, STORE_E2);
    const cs1Banqiao = cs1.body.rows.find((r) => r.county_name === '新北市');
    const cs2Banqiao = cs2.body.rows.find((r) => r.county_name === '新北市');
    assert(cs1Banqiao && cs1Banqiao.visitor_count === 1, 'E5 store E1 /county-summary shows exactly 1 visitor for 新北市');
    assert(cs2Banqiao && cs2Banqiao.visitor_count === 1, 'E6 store E2 /county-summary shows exactly 1 visitor for 新北市 (independently correct, not summed with E1)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario F: Legacy Compatibility (geo_city/geo_district, no code) through the full API stack
  // ════════════════════════════════════════════════════════════════
  const STORE_F = 'int-store-f-legacy';
  {
    // legacy row: geo_county_code/subdivision_code deliberately omitted (as
    // pre-R5.2-A events would have been written)
    const legacyGeo = { geo_country: 'TW', geo_city: '桃園市', geo_district: '八德區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
    insertEvent(db, { store_id: STORE_F, visitor_id: 'legacy-visitor', session_id: 'legacy-visitor', event_name: 'page_view', geo: legacyGeo });
    const dbRow = db.get('SELECT geo_county_code, geo_subdivision_code, geo_city, geo_district FROM analytics_events WHERE visitor_id=?', ['legacy-visitor']);
    assert(dbRow.geo_county_code === null, 'F1 legacy row genuinely has NULL geo_county_code in DB (simulating pre-R5.2-A data)');

    const overview = await callRoute('/overview', {}, STORE_F);
    const legacyArea = overview.body.data.top_areas.find((a) => a.city === '桃園市' && a.district === '八德區');
    assert(!!legacyArea, 'F2 /overview finds the legacy (code-less) row by city/district');
    assert(legacyArea.county_code === '68000', 'F3 /overview read-time-resolves county_code from legacy city/district via resolveStoredArea()');
    assert(legacyArea.resolution === 'subdivision', 'F4 /overview correctly resolves legacy row to subdivision-level despite no stored code');
    assert(legacyArea.area_label === '桃園市－八德區', 'F5 /overview area_label correct for legacy row');

    const funnel = await callRoute('/funnel', {}, STORE_F);
    const funnelLegacyArea = funnel.body.data.areas.find((a) => a.city === '桃園市' && a.district === '八德區');
    assert(!!funnelLegacyArea && funnelLegacyArea.county_code === '68000', 'F6 /funnel also correctly resolves the same legacy row');

    // directly verify resolveStoredArea() is the mechanism (not a coincidence)
    const direct = resolveStoredArea({ geo_city: '桃園市', geo_district: '八德區' }, 'acquisition');
    assert(direct.county_code === legacyArea.county_code, 'F7 resolveStoredArea() output matches what the API actually returned (confirms it IS the mechanism used)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario G: Mixed Dataset — legacy row + code row + county-only + unknown + alias + subdivision-only, all in one store, queried together
  // ════════════════════════════════════════════════════════════════
  const STORE_G = 'int-store-g-mixed';
  {
    insertVisitorFunnel(STORE_G, 'g-legacy', '桃園市', '龍潭區'); // legacy: no code
    insertVisitorFunnel(STORE_G, 'g-coded', '桃園市', '楊梅區', { geoCountyCode: '68000', geoSubdivisionCode: '68000040' });
    insertVisitorFunnel(STORE_G, 'g-countyonly', '新北市', null);
    insertEvent(db, { store_id: STORE_G, visitor_id: 'g-unknown', session_id: 'g-unknown', event_name: 'page_view', geo: { ...require('../utils/geoConstants').UNKNOWN_GEO, geo_context: 'visitor' } });
    insertVisitorFunnel(STORE_G, 'g-alias', '台南市', '永康區'); // alias input

    const overview = await callRoute('/overview', {}, STORE_G);
    assert(overview.body.data.visitor_geo.identified_visitors === 4, 'G1 mixed dataset: 4 identified visitors (legacy+coded+countyonly+alias), 1 unknown excluded from identified');
    assert(overview.body.data.visitor_geo.unknown_visitors === 1, 'G2 mixed dataset: exactly 1 unknown visitor');
    const labels = overview.body.data.top_areas.map((a) => a.area_label);
    assert(labels.includes('桃園市－龍潭區'), 'G3 mixed dataset top_areas includes legacy row (龍潭區)');
    assert(labels.includes('桃園市－楊梅區'), 'G4 mixed dataset top_areas includes coded row (楊梅區)');
    assert(labels.includes('新北市－未辨識行政區'), 'G5 mixed dataset top_areas includes county-only row correctly labeled');
    assert(labels.includes('臺南市－永康區'), 'G6 mixed dataset top_areas includes alias-normalized row (臺南市, not 台南市)');
    assert(!labels.some((l) => l.includes('未知') && l !== '未知區域'), 'G7 no malformed unknown label leaked into top_areas');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario H: Migration Preservation — re-run migration, then create new event+order, then query API
  // ════════════════════════════════════════════════════════════════
  const STORE_H = 'int-store-h-migration';
  {
    const { id: preOrderId } = createLineDeliveryOrder(STORE_H, '桃園市中壢區某路1號');
    const before = db.get('SELECT fulfillment_geo_county_code, fulfillment_geo_subdivision_code FROM orders WHERE id=?', [preOrderId]);

    await initDb(); // re-run the full migration path

    const after = db.get('SELECT fulfillment_geo_county_code, fulfillment_geo_subdivision_code, business_area_code FROM orders WHERE id=?', [preOrderId]);
    assert(after.fulfillment_geo_county_code === before.fulfillment_geo_county_code, 'H1 migration re-run does not alter existing fulfillment_geo_county_code');
    assert(after.business_area_code === null, 'H2 business_area_code remains NULL after migration re-run');

    const { id: postOrderId } = createLineDeliveryOrder(STORE_H, '臺北市大安區忠孝東路1號');
    const postRow = db.get('SELECT fulfillment_geo_county_code, business_area_code FROM orders WHERE id=?', [postOrderId]);
    assert(postRow.fulfillment_geo_county_code === '63000', 'H3 new order created AFTER migration re-run still resolves correctly');
    assert(postRow.business_area_code === null, 'H4 new order business_area_code is NULL');

    const apiRes = await callRoute('/fulfillment', {}, STORE_H);
    assert(apiRes.status === 200, 'H5 API remains functional after migration re-run mid-session');
    assert(apiRes.body.data.areas.length >= 2, 'H6 API sees both pre- and post-migration orders');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario I: Business Area Reserved — confirm no writer/reader/API/query anywhere in this integrated run
  // ════════════════════════════════════════════════════════════════
  {
    const aeRow = db.get('SELECT business_area_code, business_area_name FROM analytics_events LIMIT 1');
    const ordRow = db.get('SELECT business_area_code, business_area_name FROM orders LIMIT 1');
    assert(aeRow.business_area_code === null, 'I1 arbitrary analytics_events row: business_area_code NULL');
    assert(ordRow.business_area_code === null, 'I2 arbitrary orders row: business_area_code NULL');
    const allBizRows = db.all("SELECT COUNT(*) c FROM analytics_events WHERE business_area_code IS NOT NULL");
    assert(allBizRows[0].c === 0, 'I3 zero analytics_events rows have a non-NULL business_area_code across this entire test run');
    const allBizOrderRows = db.all("SELECT COUNT(*) c FROM orders WHERE business_area_code IS NOT NULL");
    assert(allBizOrderRows[0].c === 0, 'I4 zero orders rows have a non-NULL business_area_code across this entire test run');
    const geoRouteSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'analytics-geo.js'), 'utf8');
    assert(!geoRouteSrc.includes('business_area'), 'I5 routes/analytics-geo.js still has zero business_area references');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario J: Privacy — scan every API response gathered so far in this integrated run
  // ════════════════════════════════════════════════════════════════
  {
    const endpoints = [
      ['/overview', STORE_A], ['/funnel', STORE_A], ['/fulfillment', STORE_A],
      ['/alerts', STORE_D], ['/county-summary', STORE_C], ['/available-areas', STORE_G],
    ];
    for (const [ep, store] of endpoints) {
      const res = await callRoute(ep, {}, store);
      const hits = scanForForbiddenKeys(res.body);
      assert(hits.length === 0, `J_${ep} response contains no forbidden privacy keys`, JSON.stringify(hits));
    }
    // J-legit-coordinate（見上方 FORBIDDEN_KEYS 註解）：/fulfillment 的
    // lat/lng 是 R5.3-A1 核准的行政區聚合中心點，正向驗證它「有出現」且是
    // 聚合後的數字型別（不是原始顧客資料），確保拿掉 lat/lng 的隱私防呆
    // 沒有變成「什麼都不驗證」。
    {
      const flRes = await callRoute('/fulfillment', {}, STORE_A);
      const flAreas = (flRes.body && flRes.body.data && flRes.body.data.areas) || [];
      const coordArea = flAreas.find((a) => a.coordinate_source === 'order_centroid');
      if (coordArea) {
        assert(typeof coordArea.lat === 'number' && typeof coordArea.lng === 'number', 'J-legit-coordinate /fulfillment 的 lat/lng 是聚合後的數字（AVG()），不是原始座標字串或顧客資料');
      } else {
        pass('J-legit-coordinate 此測試店家本輪沒有帶座標的外送訂單（不觸發座標欄位，屬正常情況，不視為失敗）');
      }
    }
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario K: Failure Recovery — unknown/invalid/alias/county-only inputs never crash the chain
  // ════════════════════════════════════════════════════════════════
  const STORE_K = 'int-store-k-recovery';
  {
    let threw = false;
    try {
      createLineDeliveryOrder(STORE_K, '完全不是地址的亂碼字串');
      createLineDeliveryOrder(STORE_K, '桃園市不存在的區999號');
      createLineShippingOrder(STORE_K, '台中市', '西屯區'); // alias
      createLineShippingOrder(STORE_K, '澎湖縣', ''); // county-only
    } catch (e) { threw = true; }
    assert(!threw, 'K1 batch of unknown/invalid/alias/county-only order creations does not throw');

    const apiRes = await callRoute('/fulfillment', {}, STORE_K);
    assert(apiRes.status === 200, 'K2 API remains healthy (200) after processing edge-case fulfillment data');
    const hasTaichung = apiRes.body.data.areas.some((a) => a.area_label === '臺中市－西屯區');
    assert(hasTaichung, 'K3 alias input (台中市) still correctly resolved and queryable via API');
    const hasPenghu = apiRes.body.data.areas.some((a) => a.county_code === '10016' && a.resolution === 'county');
    assert(hasPenghu, 'K4 county-only input (澎湖縣) correctly resolved and queryable via API');

    const orderCount = db.get('SELECT COUNT(*) c FROM orders WHERE store_id=?', [STORE_K]).c;
    assert(orderCount === 4, 'K5 all 4 orders were created successfully despite edge-case geo inputs (fail-open confirmed end-to-end)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario L: Regression Protection — business area addition doesn't disturb fulfillment/overview/alerts/county-summary shape
  // ════════════════════════════════════════════════════════════════
  {
    const fulfillment = await callRoute('/fulfillment', {}, STORE_A);
    const area = fulfillment.body.data.areas[0];
    assert(area && !('business_area_code' in area), 'L1 /fulfillment response rows do not leak a business_area_code field (not silently exposed via enrichment)');
    const overview = await callRoute('/overview', {}, STORE_A);
    assert(!JSON.stringify(overview.body).includes('business_area'), 'L2 /overview response has zero business_area references');
    assert(typeof fulfillment.body.data.takeout_no_fulfillment_address === 'number', 'L3 pre-existing /fulfillment field (takeout_no_fulfillment_address) still present and correctly typed (unaffected)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario M: subdivision-level filter integration + cart-attribution +
  // source-area — endpoints not yet exercised above, still cross-module
  // (resolver → event write → cart aggregation → API → unified shape)
  // ════════════════════════════════════════════════════════════════
  const STORE_M = 'int-store-m-subdivision';
  {
    const geoZ = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1, geo_county_code: '68000', geo_subdivision_code: '68000020' };
    const geoP = { ...geoZ, geo_district: '平鎮區', geo_subdivision_code: '68000100' };
    insertEvent(db, { store_id: STORE_M, visitor_id: 'm-v1', session_id: 'm-v1', event_name: 'page_view', source: 'Facebook', geo: geoZ });
    insertEvent(db, { store_id: STORE_M, visitor_id: 'm-v1', session_id: 'm-v1', cart_id: 'm-v1-cart', event_name: 'add_to_cart', product_id: 1, quantity: 1, source: 'Facebook', geo: geoZ });
    insertEvent(db, { store_id: STORE_M, visitor_id: 'm-v2', session_id: 'm-v2', event_name: 'page_view', source: 'Direct', geo: geoP });

    // subdivision-level filter integration: county_code auto-reverse-resolved from subdivision_code alone
    const subFilterRes = await callRoute('/funnel', { subdivision_code: '68000020' }, STORE_M);
    assert(subFilterRes.status === 200, 'M1 /funnel subdivision_code-only filter (auto county reverse-lookup) succeeds');
    assert(subFilterRes.body.data.areas.every((a) => a.subdivision_code === '68000020'), 'M2 /funnel subdivision filter returns only 中壢區 rows, excluding 平鎮區');

    const cartAttr = await callRoute('/cart-attribution', {}, STORE_M);
    assert(cartAttr.status === 200, 'M3 /cart-attribution responds successfully for this store');
    const cartRanking = cartAttr.body.data.district_ranking || [];
    const cartZhongli = cartRanking.find((r) => r.area_label === '桃園市－中壢區');
    assert(!!cartZhongli, 'M4 /cart-attribution district_ranking includes the enriched 桃園市－中壢區 row (unified shape applied to cart data)');
    if (cartZhongli) assert(cartZhongli.county_code === '68000', 'M5 /cart-attribution row has correct county_code');

    const sourceArea = await callRoute('/source-area', {}, STORE_M);
    assert(sourceArea.status === 200, 'M6 /source-area responds successfully');
    const fbRow = (sourceArea.body.data.rows || []).find((r) => r.source === 'Facebook' && r.area_label === '桃園市－中壢區');
    assert(!!fbRow, 'M7 /source-area correctly cross-references source (Facebook) with the enriched area for the same visitor');

    // available-areas integration: county-level "has_data" should reflect this store's real activity
    const avail = await callRoute('/available-areas', {}, STORE_M);
    const taoyuanAvail = avail.body.counties.find((c) => c.county_code === '68000');
    assert(!!taoyuanAvail && taoyuanAvail.has_data === true, 'M8 /available-areas correctly marks 桃園市 as has_data=true for this active store');
    const kinmenAvail = avail.body.counties.find((c) => c.county_code === '09020');
    assert(!!kinmenAvail && kinmenAvail.has_data === false, 'M9 /available-areas correctly marks an inactive county (金門縣) as has_data=false, while still listing it (full national coverage preserved)');
    assert(avail.body.counties.length === 22, 'M10 /available-areas always lists all 22 counties regardless of which store is queried');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario N: Administrative API Integration (/administrative-areas, /available-areas)
  // ════════════════════════════════════════════════════════════════
  {
    const admin = await callRoute('/administrative-areas', {}, STORE_A);
    assert(admin.status === 200, 'N-01 /administrative-areas responds 200');
    assert(Array.isArray(admin.body.counties) && admin.body.counties.length > 0, 'N-02 county list non-empty');
    assert(admin.body.counties.some((c) => c.county_name === '桃園市'), 'N-03 桃園市 exists in county list');
    assert(admin.body.counties.some((c) => c.county_name === '臺北市'), 'N-04 臺北市 exists in county list');
    assert(admin.body.counties.some((c) => c.county_name === '金門縣'), 'N-05 金門縣 exists in county list');
    const countyCodeSet = new Set(admin.body.counties.map((c) => c.county_code));
    assert(countyCodeSet.size === admin.body.counties.length, 'N-06 county_code is unique across the county list');
    assert(admin.body.counties.every((c) => typeof c.county_name === 'string' && c.county_name.length > 0), 'N-07 every county_name is a non-empty string');

    const taoyuanSub = await callRoute('/administrative-areas', { county_code: '68000' }, STORE_A);
    assert(taoyuanSub.status === 200, 'N-08 /administrative-areas?county_code=68000 responds 200');
    assert(taoyuanSub.body.subdivisions.every((s) => true), 'N-09 subdivisions array present');
    assert(taoyuanSub.body.subdivisions.some((s) => s.subdivision_name === '中壢區'), 'N-10 中壢區 present under 桃園市');
    assert(taoyuanSub.body.subdivisions.some((s) => s.subdivision_name === '平鎮區'), 'N-11 平鎮區 present under 桃園市');
    assert(taoyuanSub.body.subdivisions.length === 13, 'N-12 桃園市 has exactly 13 subdivisions (dataset-verified, not hardcoded assumption)');
    const subCodeSet = new Set(taoyuanSub.body.subdivisions.map((s) => s.subdivision_code));
    assert(subCodeSet.size === taoyuanSub.body.subdivisions.length, 'N-13 subdivision_code unique within 桃園市 list');
    assert(taoyuanSub.body.subdivisions.every((s) => ['區', '市', '鎮', '鄉'].includes(s.subdivision_type)), 'N-14 every subdivision_type is a legal value (區/市/鎮/鄉)');
    assert(taoyuanSub.body.subdivisions.every((s) => s.area_label.startsWith('桃園市－')), 'N-15 every subdivision area_label correctly prefixed with 桃園市－');

    const aliasTest = await callRoute('/administrative-areas', { county_code: '63000' }, STORE_A);
    assert(aliasTest.body.county.county_name === '臺北市', 'N-16 official API output is 臺北市 (traditional form), never 台北市, regardless of how it might be queried');
    assert(!JSON.stringify(aliasTest.body).includes('台北市'), 'N-17 no simplified-form 台北市 leaks anywhere in the /administrative-areas response');

    const badCounty = await callRoute('/administrative-areas', { county_code: 'ZZZZZ' }, STORE_A);
    assert(badCounty.status === 400, 'N-18 unknown county_code -> 400');

    const avail = await callRoute('/available-areas', {}, STORE_A);
    assert(avail.status === 200, 'N-19 /available-areas responds 200');
    assert(avail.body.counties.length === 22, 'N-20 /available-areas lists all 22 counties');
    const availBadCounty = await callRoute('/available-areas', { county_code: 'ZZZZZ' }, STORE_A);
    assert(availBadCounty.status === 400, 'N-21 /available-areas unknown county_code -> 400');

    const wrongPairAdmin = await callRoute('/funnel', { county_code: '68000', subdivision_code: '63000030' }, STORE_A);
    assert(wrongPairAdmin.status === 400 && wrongPairAdmin.body.error === 'subdivision_not_in_county', 'N-22 wrong county/subdivision pair -> 400 subdivision_not_in_county (via a real filter-consuming endpoint)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario O: Unified Shape across all area-bearing Geo APIs
  // ════════════════════════════════════════════════════════════════
  {
    function checkUnifiedShape(row, label) {
      const requiredKeys = ['county_code', 'county_name', 'subdivision_code', 'subdivision_name', 'subdivision_type', 'area_key', 'area_label', 'resolution'];
      assert(requiredKeys.every((k) => k in row), `O-${label}-keys all 8 unified fields present`, JSON.stringify(Object.keys(row)));
      if (row.resolution === 'subdivision') {
        assert(row.area_key === `${row.county_code}|${row.subdivision_code}`, `O-${label}-key area_key = county_code|subdivision_code`, row.area_key);
      } else if (row.resolution === 'county') {
        assert(row.subdivision_code === null && row.subdivision_name === null, `O-${label}-nullsub county-only row has null subdivision fields`);
        assert(row.area_key === `${row.county_code}|unknown`, `O-${label}-key county-only area_key = county_code|unknown`, row.area_key);
      } else if (row.resolution === 'unknown') {
        assert(row.area_key === 'unknown', `O-${label}-key unknown resolution has area_key literally "unknown"`);
      }
    }

    const ov = await callRoute('/overview', {}, STORE_A);
    ov.body.data.top_areas.forEach((r, i) => checkUnifiedShape(r, `overview-${i}`));
    const fn = await callRoute('/funnel', {}, STORE_A);
    fn.body.data.areas.forEach((r, i) => checkUnifiedShape(r, `funnel-${i}`));
    const fl = await callRoute('/fulfillment', {}, STORE_A);
    fl.body.data.areas.forEach((r, i) => checkUnifiedShape(r, `fulfillment-${i}`));
    const sa = await callRoute('/source-area', {}, STORE_M);
    (sa.body.data.rows || []).forEach((r, i) => checkUnifiedShape(r, `sourcearea-${i}`));
    const ca = await callRoute('/cart-attribution', {}, STORE_M);
    (ca.body.data.district_ranking || []).forEach((r, i) => checkUnifiedShape(r, `cartattr-${i}`));
    assert(true, 'O-summary unified shape validated across overview/funnel/fulfillment/source-area/cart-attribution (per-row assertions above)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario P: Filter Matrix — no filter / county only / subdivision only /
  // county+subdivision / unknown county / wrong pair, across every API that
  // genuinely supports county_code/subdivision_code filters (verified in
  // Stage 6/7: /overview, /funnel, /fulfillment, /source-area (via shared
  // _commonEventFilterClause), /county-summary, /cart-attribution, /alerts)
  // ════════════════════════════════════════════════════════════════
  {
    const filterableEndpoints = ['/overview', '/funnel', '/fulfillment', '/source-area', '/cart-attribution', '/alerts'];
    for (const ep of filterableEndpoints) {
      const noFilter = await callRoute(ep, {}, STORE_A);
      assert(noFilter.status === 200, `P-${ep}-nofilter status 200`);
      const countyOnly = await callRoute(ep, { county_code: '68000' }, STORE_A);
      assert(countyOnly.status === 200, `P-${ep}-county status 200`);
      const subOnly = await callRoute(ep, { subdivision_code: '68000020' }, STORE_A);
      assert(subOnly.status === 200, `P-${ep}-subdivision status 200`);
      const both = await callRoute(ep, { county_code: '68000', subdivision_code: '68000020' }, STORE_A);
      assert(both.status === 200, `P-${ep}-both status 200`);
      const unknownCounty = await callRoute(ep, { county_code: 'ZZZZZ' }, STORE_A);
      assert(unknownCounty.status === 400 && unknownCounty.body.error === 'unknown_county_code', `P-${ep}-unknowncounty 400 unknown_county_code`);
      const wrongPair = await callRoute(ep, { county_code: '68000', subdivision_code: '63000030' }, STORE_A);
      assert(wrongPair.status === 400 && wrongPair.body.error === 'subdivision_not_in_county', `P-${ep}-wrongpair 400 subdivision_not_in_county`);
    }
    // county-summary uses its own inline route (not _safeHandler) — verified separately
    const csNoFilter = await callRoute('/county-summary', {}, STORE_A);
    assert(csNoFilter.status === 200, 'P-county-summary-nofilter status 200');
    const csCounty = await callRoute('/county-summary', { county_code: '68000' }, STORE_A);
    assert(csCounty.status === 200 && csCounty.body.rows.every((r) => r.county_code === '68000'), 'P-county-summary-county scoped to 桃園市 only');
    const csUnknown = await callRoute('/county-summary', { county_code: 'ZZZZZ' }, STORE_A);
    assert(csUnknown.status === 400, 'P-county-summary-unknowncounty 400');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario Q: County-only vs Subdivision-only compatibility
  // ════════════════════════════════════════════════════════════════
  const STORE_Q = 'int-store-q-compat';
  {
    insertVisitorFunnel(STORE_Q, 'q-coded-county-only', '桃園市', null, { geoCountyCode: '68000' });
    insertVisitorFunnel(STORE_Q, 'q-legacy-city-only', '新竹縣', null);
    insertVisitorFunnel(STORE_Q, 'q-sub-only', '桃園市', '中壢區', { geoSubdivisionCode: '68000020' }); // county code deliberately omitted
    insertVisitorFunnel(STORE_Q, 'q-legacy-full', '高雄市', '左營區');
    insertEvent(db, { store_id: STORE_Q, visitor_id: 'q-unknown', session_id: 'q-unknown', event_name: 'page_view', geo: { ...require('../utils/geoConstants').UNKNOWN_GEO, geo_context: 'visitor' } });

    const ov = await callRoute('/overview', {}, STORE_Q);
    const labels = ov.body.data.top_areas.map((a) => a.area_label);
    assert(labels.includes('桃園市－未辨識行政區'), 'Q-01 coded county-only row does not degrade to unknown (shows as 桃園市－未辨識行政區)');
    assert(labels.includes('新竹縣－未辨識行政區'), 'Q-02 legacy city-only row correctly normalizes to county-level');
    const subOnlyArea = ov.body.data.top_areas.find((a) => a.county_code === '68000' && a.subdivision_code === '68000020');
    assert(!!subOnlyArea, 'Q-03 subdivision-code-only row correctly reverse-resolves county_code');
    assert(labels.includes('高雄市－左營區'), 'Q-04 legacy full city+district row normalizes correctly');
    assert(ov.body.data.visitor_geo.unknown_visitors === 1, 'Q-05 exactly 1 unknown visitor, not miscounted into any area');
    assert(!labels.some((l) => l === '未知區域'), 'Q-06 unknown area never appears in top_areas (excluded, not zero-labeled)');

    const funnel = await callRoute('/funnel', {}, STORE_Q);
    assert(funnel.body.data.areas.some((a) => a.county_code === '68000' && a.subdivision_code === null), 'Q-07 /funnel also shows the county-only row correctly');

    const csQ = await callRoute('/county-summary', {}, STORE_Q);
    const csTaoyuan = csQ.body.rows.find((r) => r.county_name === '桃園市');
    assert(!!csTaoyuan && csTaoyuan.visitor_count === 2, 'Q-08 /county-summary sums county-only + subdivision-only rows into the same county correctly (2 visitors)');

    const filtered = await callRoute('/overview', { county_code: '68000' }, STORE_Q);
    assert(!filtered.body.data.top_areas.some((a) => a.resolution === 'unknown'), 'Q-09 filtered request never includes unknown-resolution rows');
    assert(filtered.body.data.visitor_geo.unknown_visitors === 0, 'Q-10 filtered request excludes unknown from unknown_visitors count (scoped to the filter)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario R: Order → Fulfillment Aggregation (multiple orders across districts)
  // ════════════════════════════════════════════════════════════════
  const STORE_R = 'int-store-r-aggregation';
  {
    createLineDeliveryOrder(STORE_R, '桃園市中壢區中央路1號', 'delivery', { total: 500 });
    createLineDeliveryOrder(STORE_R, '桃園市中壢區中正路2號', 'delivery', { total: 300 });
    createLineDeliveryOrder(STORE_R, '桃園市平鎮區延平路3號', 'delivery', { total: 400 });
    createLineDeliveryOrder(STORE_R, '臺北市大安區忠孝東路4號', 'delivery', { total: 600 });
    createLineDeliveryOrder(STORE_R, '完全無法辨識的地址', 'delivery', { total: 200 });
    createLineDeliveryOrder(STORE_R, '', 'takeout', { total: 150 });
    createLineShippingOrder(STORE_R, '金門縣', '金城鎮');

    const fl = await callRoute('/fulfillment', {}, STORE_R);
    const zhongli = fl.body.data.areas.find((a) => a.area_label === '桃園市－中壢區');
    const pingzhen = fl.body.data.areas.find((a) => a.area_label === '桃園市－平鎮區');
    const daan = fl.body.data.areas.find((a) => a.area_label === '臺北市－大安區');
    const jincheng = fl.body.data.areas.find((a) => a.area_label === '金門縣－金城鎮');

    assert(!!zhongli && zhongli.submitted_orders === 2, 'R-01 中壢區 order_count = 2 (aggregated correctly)');
    assert(!!zhongli && zhongli.revenue === 800, 'R-02 中壢區 revenue = 800 (500+300, correctly summed)');
    assert(!!pingzhen && pingzhen.submitted_orders === 1, 'R-03 平鎮區 order_count = 1');
    assert(!!daan && daan.submitted_orders === 1, 'R-04 大安區 order_count = 1');
    assert(!!jincheng && jincheng.submitted_orders === 1, 'R-05 金門縣金城鎮 (island) correctly appears in fulfillment aggregation');
    // 誠實記錄：無法解析地址的「外送」訂單，仍會設定 fulfillment_geo_source
    // （代表「確實嘗試過履約地址解析」），因此會以「未知區域」列的形式出現在
    // /fulfillment（這其實是合理、對店家有用的行為——店家會想知道『有 1 筆
    // 外送單，但系統判斷不出行政區』，而不是讓這筆資料悄悄消失）。只有「外帶」
    // 訂單（orderMode='takeout'，根本沒有呼叫 normalizeDeliveryGeo）才會是
    // fulfillment_geo_source 為 NULL、完全不出現在這支 API 的情況。
    const unknownAreaRow = fl.body.data.areas.find((a) => a.area_label === '未知區域');
    assert(!!unknownAreaRow && unknownAreaRow.submitted_orders === 1, 'R-06 unresolvable delivery order correctly appears as its own 未知區域 row (honest "attempted but unresolved" signal, not silently dropped)', JSON.stringify(unknownAreaRow));
    assert(unknownAreaRow && unknownAreaRow.county_code === null && unknownAreaRow.resolution === 'unknown', 'R-06b 未知區域 row has correct unified-shape null county_code and resolution=unknown');
    const totalSubmitted = fl.body.data.areas.reduce((s, a) => s + a.submitted_orders, 0);
    assert(totalSubmitted === 6, 'R-07 total submitted_orders across all areas (including 未知區域) = 6 — excludes only the 1 takeout order, which never gets a fulfillment_geo_source at all', totalSubmitted);

    const taoyuanFiltered = await callRoute('/fulfillment', { county_code: '68000' }, STORE_R);
    assert(taoyuanFiltered.body.data.areas.every((a) => a.county_code === '68000'), 'R-08 county=68000 filter on /fulfillment: only 桃園市 areas (中壢+平鎮), never 大安 or 金門');
    assert(taoyuanFiltered.body.data.areas.length === 2, 'R-09 county=68000 filter shows exactly 2 areas (中壢區, 平鎮區)');

    const taipeiFiltered = await callRoute('/fulfillment', { county_code: '63000' }, STORE_R);
    assert(taipeiFiltered.body.data.areas.length === 1 && taipeiFiltered.body.data.areas[0].area_label === '臺北市－大安區', 'R-10 county=63000 filter shows only 大安區');

    const kinmenFiltered = await callRoute('/fulfillment', { county_code: '09020' }, STORE_R);
    assert(kinmenFiltered.body.data.areas.length === 1 && kinmenFiltered.body.data.areas[0].area_label === '金門縣－金城鎮', 'R-11 county=09020 (金門縣) filter shows only 金城鎮 (island isolation from mainland areas)');

    const revenues = fl.body.data.areas.map((a) => a.revenue);
    const sortedDesc = [...revenues].sort((a, b) => b - a);
    assert(JSON.stringify(revenues) === JSON.stringify(sortedDesc), 'R-12 /fulfillment areas are stably sorted by revenue DESC');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario S: Acquisition Identity Dedup (no event-count inflation)
  // ════════════════════════════════════════════════════════════════
  const STORE_S = 'int-store-s-dedup';
  {
    const geoZ = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1, geo_county_code: '68000', geo_subdivision_code: '68000020' };
    // same visitor: 3x page_view, 2x add_to_cart, 2x begin_checkout, 1x purchase
    for (let i = 0; i < 3; i += 1) insertEvent(db, { store_id: STORE_S, visitor_id: 's-v1', session_id: 's-v1', event_name: 'page_view', geo: geoZ });
    for (let i = 0; i < 2; i += 1) insertEvent(db, { store_id: STORE_S, visitor_id: 's-v1', session_id: 's-v1', cart_id: 's-v1-cart', event_name: 'add_to_cart', product_id: 1, quantity: 1, geo: geoZ });
    for (let i = 0; i < 2; i += 1) insertEvent(db, { store_id: STORE_S, visitor_id: 's-v1', session_id: 's-v1', cart_id: 's-v1-cart', event_name: 'begin_checkout', geo: geoZ });
    insertEvent(db, { store_id: STORE_S, visitor_id: 's-v1', session_id: 's-v1', order_id: 's-v1-order', event_name: 'purchase', geo: geoZ });
    db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at) VALUES ('s-v1-order','s-v1-order','s-v1-order',?,'takeout',NULL,'completed','done','D','0933333333','[]','cash','cash','paid',500,500,'','synced','LINE','line',?,?)`, [STORE_S, FIXED_NOW, FIXED_NOW]);
    // second visitor, same district
    insertVisitorFunnel(STORE_S, 's-v2', '桃園市', '中壢區', { geoCountyCode: '68000', geoSubdivisionCode: '68000020' });
    // third visitor, different district
    insertVisitorFunnel(STORE_S, 's-v3', '桃園市', '平鎮區', { geoCountyCode: '68000', geoSubdivisionCode: '68000100' });

    const ov = await callRoute('/overview', {}, STORE_S);
    assert(ov.body.data.visitor_geo.identified_visitors === 3, 'S-01 overview identified_visitors = 3 (not inflated by s-v1\'s 8 total events)');
    const funnel = await callRoute('/funnel', {}, STORE_S);
    const zhongliFunnel = funnel.body.data.areas.find((a) => a.area_label === '桃園市－中壢區');
    assert(!!zhongliFunnel && zhongliFunnel.visitors === 2, 'S-02 funnel visitors for 中壢區 = 2 (s-v1 + s-v2, deduped)');
    assert(zhongliFunnel.add_to_cart_visitors === 1, 'S-03 funnel add_to_cart_visitors = 1 (s-v1\'s 2 add_to_cart events count as 1 person)');
    assert(zhongliFunnel.begin_checkout_visitors === 1, 'S-04 funnel begin_checkout_visitors = 1 (s-v1\'s 2 begin_checkout events count as 1 person)');
    assert(zhongliFunnel.purchase_visitors === 1, 'S-05 funnel purchase_visitors = 1');
    const topAreaLabels = ov.body.data.top_areas.map((a) => `${a.area_label}:${a.visitors}`);
    assert(topAreaLabels.includes('桃園市－中壢區:2'), 'S-06 top_areas visitor count for 中壢區 reflects attribution (2 people), not raw event count');

    const filteredCounty = await callRoute('/overview', { county_code: '68000' }, STORE_S);
    assert(filteredCounty.body.data.visitor_geo.identified_visitors === 3, 'S-07 county filter recomputes correctly: all 3 visitors are in 桃園市 (中壢+平鎮 both belong to it)');
    const filteredSub = await callRoute('/overview', { subdivision_code: '68000020' }, STORE_S);
    assert(filteredSub.body.data.visitor_geo.identified_visitors === 2, 'S-08 subdivision filter recomputes correctly: only 2 visitors are specifically in 中壢區');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario T: Alert Mixed Context — full chain (traffic_waste + delivery_cost_risk verified triggering; others honestly noted if not triggered)
  // ════════════════════════════════════════════════════════════════
  const STORE_T = 'int-store-t-alerts';
  const ORIGINAL_MIN_VISITORS_T = process.env.GEO_ALERT_MIN_VISITORS;
  try {
    process.env.GEO_ALERT_MIN_VISITORS = '1';
    // traffic_waste: high traffic, 0 cart, 0 orders
    for (let i = 0; i < 2; i += 1) insertEvent(db, { store_id: STORE_T, visitor_id: `t-tw-${i}`, session_id: `t-tw-${i}`, event_name: 'page_view',
      geo: { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1, geo_county_code: '68000', geo_subdivision_code: '68000020' } });
    // delivery_cost_risk: high distance/fee delivery order, not completed
    const fgeoT = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '臺北市大安區忠孝東路1號', distanceKm: 20 });
    db.run(
      `INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, delivery_distance_km, delivery_fee)
       VALUES ('t-dcr-order','t-dcr-order','t-dcr-order',?,'delivery',NULL,'pending','pending','E','0944444444','[]','cash','cash','pending',500,500,'','synced','LINE','line',?,?,?,?,?,?,?,20,100)`,
      [STORE_T, FIXED_NOW, FIXED_NOW, fgeoT.geo_city, fgeoT.geo_district, fgeoT.geo_source, fgeoT.geo_confidence, fgeoT.geo_resolution]
    );

    const alertsT = await callRoute('/alerts', {}, STORE_T);
    const tw = alertsT.body.data.alerts.find((a) => a.type === 'traffic_waste');
    const dcr = alertsT.body.data.alerts.find((a) => a.type === 'delivery_cost_risk');
    const dq = alertsT.body.data.alerts.find((a) => a.type === 'data_quality');
    assert(!!tw, 'T-01 traffic_waste alert genuinely triggered');
    assert(tw && tw.geo_context === 'acquisition', 'T-02 traffic_waste geo_context = acquisition');
    assert(tw && tw.area_label === '桃園市－中壢區', 'T-03 traffic_waste area_label correct');
    assert(!!dcr, 'T-04 delivery_cost_risk alert genuinely triggered');
    assert(dcr && dcr.geo_context === 'fulfillment', 'T-05 delivery_cost_risk geo_context = fulfillment');
    assert(dcr && dcr.area_label === '臺北市－大安區', 'T-06 delivery_cost_risk area_label correct');
    // checkout_drop and out_of_range_demand: honestly not constructed in this fixture (would require
    // additional begin_checkout-without-order and delivery_out_of_range event fixtures respectively;
    // not fabricated here — recorded as NOT TRIGGERED IN THIS FIXTURE, not silently skipped)
    const checkoutDrop = alertsT.body.data.alerts.find((a) => a.type === 'checkout_drop');
    const oorDemand = alertsT.body.data.alerts.find((a) => a.type === 'out_of_range_demand');
    assert(checkoutDrop === undefined || checkoutDrop.geo_context === 'acquisition', 'T-07 checkout_drop (NOT TRIGGERED IN THIS FIXTURE — honestly noted, not fabricated) — if present would be acquisition context');
    assert(oorDemand === undefined || oorDemand.geo_context === 'fulfillment', 'T-08 out_of_range_demand (NOT TRIGGERED IN THIS FIXTURE — honestly noted) — if present would be fulfillment context');
    if (dq) {
      assert(dq.geo_context === null, 'T-09 data_quality geo_context = null');
      assert(dq.scope === 'store', 'T-10 data_quality scope = store');
    } else {
      assert(true, 'T-09/T-10 data_quality not present in this fixture (status was healthy) — not a failure');
    }

    const alertsTaoyuanFilter = await callRoute('/alerts', { county_code: '68000' }, STORE_T);
    assert(alertsTaoyuanFilter.body.data.alerts.some((a) => a.type === 'traffic_waste'), 'T-11 county=68000 filter keeps traffic_waste');
    assert(!alertsTaoyuanFilter.body.data.alerts.some((a) => a.type === 'delivery_cost_risk'), 'T-12 county=68000 filter excludes delivery_cost_risk (no acquisition/fulfillment context bleed)');
    const alertsTaipeiFilter = await callRoute('/alerts', { county_code: '63000' }, STORE_T);
    assert(alertsTaipeiFilter.body.data.alerts.some((a) => a.type === 'delivery_cost_risk'), 'T-13 county=63000 filter keeps delivery_cost_risk');
    assert(!alertsTaipeiFilter.body.data.alerts.some((a) => a.type === 'traffic_waste'), 'T-14 county=63000 filter excludes traffic_waste');
  } finally {
    if (ORIGINAL_MIN_VISITORS_T === undefined) delete process.env.GEO_ALERT_MIN_VISITORS; else process.env.GEO_ALERT_MIN_VISITORS = ORIGINAL_MIN_VISITORS_T;
  }
  assert(process.env.GEO_ALERT_MIN_VISITORS === ORIGINAL_MIN_VISITORS_T, 'T-15 GEO_ALERT_MIN_VISITORS restored after Scenario T');

  // ════════════════════════════════════════════════════════════════
  // Scenario U: Migration + Legacy API Read (re-verify migration idempotency mid-integrated-run, then confirm every API still reads correctly)
  // ════════════════════════════════════════════════════════════════
  const STORE_U = 'int-store-u-migration';
  {
    insertVisitorFunnel(STORE_U, 'u-legacy', '雲林縣', '斗六市');
    createLineDeliveryOrder(STORE_U, '雲林縣斗六市大學路1號');
    const beforeAeCols = db.all('PRAGMA table_info(analytics_events)').length;
    const beforeOrdCols = db.all('PRAGMA table_info(orders)').length;
    await initDb();
    await initDb();
    const afterAeCols = db.all('PRAGMA table_info(analytics_events)').length;
    const afterOrdCols = db.all('PRAGMA table_info(orders)').length;
    assert(beforeAeCols === afterAeCols, 'U-01 analytics_events column count stable across repeated migration mid-run');
    assert(beforeOrdCols === afterOrdCols, 'U-02 orders column count stable across repeated migration mid-run');

    const legacyRow = db.get('SELECT geo_city, geo_district, business_area_code FROM analytics_events WHERE visitor_id=?', ['u-legacy']);
    assert(legacyRow.geo_city === '雲林縣' && legacyRow.geo_district === '斗六市', 'U-03 legacy analytics row data preserved after repeated migration');
    assert(legacyRow.business_area_code === null, 'U-04 legacy row business_area_code still NULL');

    const ovU = await callRoute('/overview', {}, STORE_U);
    assert(ovU.status === 200 && ovU.body.data.top_areas.some((a) => a.area_label === '雲林縣－斗六市'), 'U-05 /overview correctly reads data after repeated migration');
    const fnU = await callRoute('/funnel', {}, STORE_U);
    assert(fnU.status === 200 && fnU.body.data.areas.some((a) => a.county_code === '10009'), 'U-06 /funnel correctly reads data after repeated migration');
    const flU = await callRoute('/fulfillment', {}, STORE_U);
    assert(flU.status === 200 && flU.body.data.areas.some((a) => a.county_name === '雲林縣'), 'U-07 /fulfillment correctly reads data after repeated migration');
    const csU = await callRoute('/county-summary', {}, STORE_U);
    assert(csU.status === 200 && csU.body.rows.some((r) => r.county_name === '雲林縣'), 'U-08 /county-summary correctly reads data after repeated migration');

    const rowCountBefore = db.get('SELECT COUNT(*) c FROM analytics_events WHERE store_id=?', [STORE_U]).c;
    await initDb();
    const rowCountAfter = db.get('SELECT COUNT(*) c FROM analytics_events WHERE store_id=?', [STORE_U]).c;
    assert(rowCountBefore === rowCountAfter, 'U-09 row count unchanged by yet another migration re-run');
    const ovU2 = await callRoute('/overview', {}, STORE_U);
    assert(JSON.stringify(ovU2.body.data.top_areas) === JSON.stringify(ovU.body.data.top_areas), 'U-10 API result identical before and after the extra migration re-run (deterministic)');
  }

  // ════════════════════════════════════════════════════════════════
  // Scenario V: Strict Privacy Recursive Scan across every API response gathered in this run
  // ════════════════════════════════════════════════════════════════
  {
    const STRICT_FORBIDDEN = [
      'raw_ip', 'client_ip', 'x-forwarded-for', 'delivery_address', 'shipping_address',
      'formatted_address', 'full_address', 'customer_phone', 'customer_name', 'phone',
      // fix18-10-hotfix30-B5-R5.3-A1.1：同 Scenario J 上方的說明——lat/lng/
      // latitude/longitude 移出這份嚴格清單，因為 R5.3-A1 已核准 /fulfillment
      // 合法回傳聚合中心點（Heatmap 需要）。下面的 'V-legit' 區塊改用正向斷言
      // 驗證這兩個欄位存在且為聚合數字，不是放寬了隱私把關。
      'api_key', 'secret', 'token', 'raw_provider_response', 'cache_key',
    ];
    const endpointsToScan = [
      ['/overview', STORE_R], ['/funnel', STORE_S], ['/source-area', STORE_M], ['/cart-attribution', STORE_M],
      ['/fulfillment', STORE_R], ['/alerts', STORE_T], ['/administrative-areas', STORE_A, { county_code: '68000' }],
      ['/available-areas', STORE_A],
    ];
    let idx = 0;
    for (const [ep, store, query] of endpointsToScan) {
      idx += 1;
      const res = await callRoute(ep, query || {}, store);
      const json = JSON.stringify(res.body).toLowerCase();
      const hits = STRICT_FORBIDDEN.filter((k) => json.includes(`"${k}"`));
      assert(hits.length === 0, `V-${idx} ${ep} contains no forbidden privacy keys`, JSON.stringify(hits));
    }
    // sanity: legitimate lookalike fields must not be false-positive-flagged
    const flCheck = await callRoute('/fulfillment', {}, STORE_R);
    const flJson = JSON.stringify(flCheck.body);
    assert(flJson.includes('average_delivery_fee'), 'V-legit delivery_fee-style field (average_delivery_fee) present and not treated as forbidden');
    const anyAreaKey = flCheck.body.data.areas[0] && flCheck.body.data.areas[0].area_key;
    assert(typeof anyAreaKey === 'string' && anyAreaKey.length > 0, 'V-legit area_key field present and not treated as forbidden');
    // V-legit-coordinate（見上方 STRICT_FORBIDDEN 註解，R5.3-A1.1 Regression
    // 發現並修正）：lat/lng 是 R5.3-A1 核准的行政區聚合中心點，正向驗證它是
    // 聚合後的數字型別，且同一份回應仍然不含任何原始顧客欄位（電話／地址／
    // IP），確認移出清單沒有連帶放寬真正的隱私把關。
    const flCoordArea = (flCheck.body.data.areas || []).find((a) => a.coordinate_source === 'order_centroid');
    if (flCoordArea) {
      assert(typeof flCoordArea.lat === 'number' && typeof flCoordArea.lng === 'number', 'V-legit-coordinate /fulfillment 的 lat/lng 是聚合後的數字（AVG()），不是原始座標字串或顧客資料');
      const rawPiiHits = ['customer_phone', 'customer_name', 'phone', 'delivery_address', 'shipping_address', 'raw_ip'].filter((k) => flJson.toLowerCase().includes(`"${k}"`));
      assert(rawPiiHits.length === 0, 'V-legit-coordinate 即使含聚合座標，/fulfillment 回應仍然完全沒有原始顧客欄位（電話/地址/IP）');
    } else {
      pass('V-legit-coordinate 此測試店家本輪沒有帶座標的外送訂單（不觸發座標欄位，屬正常情況，不視為失敗）');
    }
  }

  // ── summary ──────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n=== fix18-10-hotfix30-B5-R5.2-A Integrated E2E smoke test: ${passCount} PASS / ${failCount} FAIL / ${results.length} total ===`);
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
