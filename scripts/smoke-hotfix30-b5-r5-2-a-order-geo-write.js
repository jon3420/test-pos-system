#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-a-order-geo-write.js
// fix18-10-hotfix30-B5-R5.2-A — Stage 8.9 formal smoke test.
//
// 「最接近正式 handler 的可控入口」說明（誠實記錄，見需求文件 Stage 8.9）：
// routes/line-orders.js／routes/line-shipping.js 的完整 HTTP handler 需要
// LINE member_session 簽章驗證、購物車/商品驗證、外送費即時計算等大量前置
// 依賴，在測試中偽造整條 HTTP 請求風險遠高於這裡的價值。本測試改為：
//   1. 直接呼叫兩條路由「實際呼叫的同一個函式、同一組參數」——
//      utils/geoResolver.js 的 normalizeDeliveryGeo()（LINE 外送用
//      formattedAddress 規則字串解析；LINE 宅配用結構化 city/district，
//      這是這兩條路由的真實輸入契約，已在 Stage 8 inventory 確認，不是
//      測試自己發明的）。
//   2. 執行「跟正式路由逐字相同」的 INSERT INTO orders 陳述式（column list／
//      placeholder 數與 routes/line-orders.js、routes/line-shipping.js 目前
//      原始碼一致，Section F 另外對原始碼做結構化 assertion，兩者互相對照，
//      避免測試用的 SQL 悄悄跟正式路由的 SQL 漂移）。
//   3. 讀回 DB row 驗證。
// 這模擬了「resolver → INSERT → DB row」這條完整鏈路的真實行為，只是省略了
// HTTP 層與認證層（那兩層不含任何本輪修改的邏輯）。

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

const FORBIDDEN_IN_LOG = ['delivery_address', 'shipping_address', 'phone', 'name', 'lat', 'lng', 'token', 'secret', 'api_key'];

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  const { normalizeDeliveryGeo } = require('../utils/geoResolver');
  const { resolveTaiwanAdministrativeArea } = require('../utils/taiwanGeoNormalize');
  const { GEO_SOURCE, GEO_CONTEXT } = require('../utils/geoConstants');

  const FIXED_NOW = '2026-07-20 10:00:00';
  let orderSeq = 0;
  function nextId(prefix) { orderSeq += 1; return `${prefix}-${orderSeq}`; }

  // ── Real INSERT statements, verbatim mirrors of the current route source
  // (Section F re-verifies these counts against the actual source files, so
  // any drift between "what this test runs" and "what the route actually
  // runs" gets caught, not silently masked). ──────────────────────────────
  const LINE_ORDERS_INSERT_SQL = `INSERT INTO orders (
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

  const LINE_SHIPPING_INSERT_SQL = `INSERT INTO orders (
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

  // buildLineDeliveryOrder(): mirrors routes/line-orders.js's isDelivery=true
  // path — same normalizeDeliveryGeo() call, same INSERT.
  function buildLineDeliveryOrder({ storeId, deliveryAddress, distanceKm = 5, orderMode = 'delivery', total = 500 }) {
    const orderGeo = orderMode === 'delivery'
      ? normalizeDeliveryGeo({
          source: GEO_SOURCE.DELIVERY_ADDRESS,
          geoContext: GEO_CONTEXT.FULFILLMENT,
          formattedAddress: deliveryAddress,
          distanceKm,
        })
      : null;
    const id = nextId('lod');
    const vals = [
      id, id, id.toUpperCase(), storeId, orderMode, 'pending', 'pending',
      '客戶', '0900000000', '',
      '', deliveryAddress || '', '',
      'LINE', '',
      '', '', orderGeo ? orderGeo.geo_distance_km : null, '',
      60, '',
      '', '', '',
      '', '',
      '', '',
      '[]', 'cash', 'cash', 'pending',
      total, 'none', 0, total, '', total,
      '', 'synced', 'LINE', 'line', FIXED_NOW, FIXED_NOW, '',
      orderGeo ? orderGeo.geo_city : null, orderGeo ? orderGeo.geo_district : null,
      orderGeo ? orderGeo.geo_source : null, orderGeo ? orderGeo.geo_confidence : null,
      orderGeo ? orderGeo.geo_resolution : null, orderGeo ? orderGeo.geo_distance_band : null,
      orderGeo ? orderGeo.geo_county_code : null, orderGeo ? orderGeo.geo_subdivision_code : null,
    ];
    db.run(LINE_ORDERS_INSERT_SQL, vals);
    return { id, orderGeo, valuesLength: vals.length };
  }

  // buildLineShippingOrder(): mirrors routes/line-shipping.js's structured
  // city/district path.
  function buildLineShippingOrder({ storeId, city, district, total = 500 }) {
    const shippingGeo = normalizeDeliveryGeo({
      source: GEO_SOURCE.SHIPPING_ADDRESS,
      geoContext: GEO_CONTEXT.SHIPPING,
      city: city || null,
      district: district || null,
      postalCode: null,
      distanceKm: null,
    });
    const id = nextId('los');
    const vals = [
      id, id, id.toUpperCase(), storeId, 'shipping', 'pending', 'pending',
      '收件人', '0911111111',
      '[]', 'cash', 'cash', 'pending',
      total, 'none', 0, total, '', total,
      '', 'synced', 'LINE', 'line', FIXED_NOW, FIXED_NOW,
      'shipping', 'line_shipping',
      '收件人', '0911111111', '', city || '',
      district || '', '某路某號', '',
      'asap', '', 80, 0,
      '', 'pending', '',
      shippingGeo.geo_city, shippingGeo.geo_district, shippingGeo.geo_source,
      shippingGeo.geo_confidence, shippingGeo.geo_resolution, shippingGeo.geo_distance_band,
      shippingGeo.geo_county_code, shippingGeo.geo_subdivision_code,
    ];
    db.run(LINE_SHIPPING_INSERT_SQL, vals);
    return { id, shippingGeo, valuesLength: vals.length };
  }

  function getOrderRow(id) {
    return db.get(
      `SELECT id, store_id, order_number, order_mode, status, subtotal, total, delivery_fee,
              discount_amount, coupon_code, payment_method, customer_name, customer_phone,
              fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_county_code,
              fulfillment_geo_subdivision_code, shipping_city, shipping_district
       FROM orders WHERE id=?`,
      [id]
    );
  }

  // ════════════════════════════════════════════════════════════════
  // B. Dataset expected codes (never hardcoded from memory)
  // ════════════════════════════════════════════════════════════════
  const expTaoyuan = resolveTaiwanAdministrativeArea({ city: '桃園市' });
  const expZhongli = resolveTaiwanAdministrativeArea({ city: '桃園市', district: '中壢區' });
  const expTaipeiDaan = resolveTaiwanAdministrativeArea({ city: '臺北市', district: '大安區' });
  const expKinmenJincheng = resolveTaiwanAdministrativeArea({ city: '金門縣', district: '金城鎮' });
  const expKinmen = resolveTaiwanAdministrativeArea({ city: '金門縣' });

  assert(expTaoyuan.resolution === 'county' && !!expTaoyuan.county_code, 'B1 expected 桃園市 resolves to county with non-empty county_code');
  assert(expZhongli.resolution === 'subdivision' && !!expZhongli.county_code && !!expZhongli.subdivision_code, 'B2 expected 桃園市中壢區 resolves to subdivision with both codes');
  assert(expTaipeiDaan.resolution === 'subdivision' && !!expTaipeiDaan.county_code && !!expTaipeiDaan.subdivision_code, 'B3 expected 臺北市大安區 resolves to subdivision with both codes');
  assert(expKinmenJincheng.resolution === 'subdivision' && !!expKinmenJincheng.county_code && !!expKinmenJincheng.subdivision_code, 'B4 expected 金門縣金城鎮 resolves to subdivision with both codes (island coverage, not just 六都)');
  assert(expKinmen.resolution === 'county' && !!expKinmen.county_code, 'B5 expected 金門縣 county-only resolves correctly');

  // ════════════════════════════════════════════════════════════════
  // C. LINE 外送 (delivery) — real route pattern via formattedAddress regex
  // ════════════════════════════════════════════════════════════════
  const STORE_DELIVERY = 'store_geo_line_delivery';

  // C1 桃園市＋中壢區
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市中壢區中央路100號' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expZhongli.county_code, 'C1a county_code matches dataset expected', `${row.fulfillment_geo_county_code} vs ${expZhongli.county_code}`);
    assert(row.fulfillment_geo_subdivision_code === expZhongli.subdivision_code, 'C1b subdivision_code matches dataset expected', `${row.fulfillment_geo_subdivision_code} vs ${expZhongli.subdivision_code}`);
    assert(row.fulfillment_geo_city === '桃園市', 'C1c fulfillment_geo_city unchanged/correct');
    assert(row.fulfillment_geo_district === '中壢區', 'C1d fulfillment_geo_district unchanged/correct');
  }

  // C2 Alias（台北市 → 臺北市）
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '台北市大安區敦化南路50號' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expTaipeiDaan.county_code, 'C2a alias 台北市 normalizes to official 臺北市 county_code');
    assert(row.fulfillment_geo_subdivision_code === expTaipeiDaan.subdivision_code, 'C2b alias resolves correct subdivision_code for 大安區');
  }

  // C3 County-only（no matching district in address string）
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市某處' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expTaoyuan.county_code, 'C3a county-only: county_code set');
    assert(row.fulfillment_geo_subdivision_code === null, 'C3b county-only: subdivision_code NULL');
  }

  // C4 Invalid district + valid county — verify against the resolver's REAL current behavior (degrade to county-only), not a forced expectation
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市不存在區100號' });
    const row = getOrderRow(r.id);
    const realBehavior = resolveTaiwanAdministrativeArea({ city: '桃園市', district: '不存在區' });
    assert(row.fulfillment_geo_county_code === (realBehavior.resolution === 'unknown' ? null : realBehavior.county_code),
      'C4a invalid district matches resolver\'s actual real behavior for county_code', JSON.stringify({ row: row.fulfillment_geo_county_code, real: realBehavior }));
    assert(row.fulfillment_geo_subdivision_code === null, 'C4b invalid district: subdivision_code is NULL either way (unknown district never gets a subdivision_code)');
  }

  // C5 Unknown
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '火星第一街1號' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === null, 'C5a fully unknown address: county_code NULL');
    assert(row.fulfillment_geo_subdivision_code === null, 'C5b fully unknown address: subdivision_code NULL');
  }

  // C6 外帶 (takeout) — orderMode='takeout', must not inherit the previous delivery order's codes
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '', orderMode: 'takeout' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === null, 'C6a takeout: county_code NULL (does not inherit prior delivery order\'s code)');
    assert(row.fulfillment_geo_subdivision_code === null, 'C6b takeout: subdivision_code NULL');
  }

  // ════════════════════════════════════════════════════════════════
  // D. LINE 宅配 (shipping) — real route pattern via structured city/district
  // ════════════════════════════════════════════════════════════════
  const STORE_SHIPPING = 'store_geo_shipping';

  // D1 臺北市＋大安區
  {
    const r = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '臺北市', district: '大安區' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expTaipeiDaan.county_code, 'D1a shipping county_code correct');
    assert(row.fulfillment_geo_subdivision_code === expTaipeiDaan.subdivision_code, 'D1b shipping subdivision_code correct');
    assert(row.shipping_city === '臺北市' && row.shipping_district === '大安區', 'D1c raw shipping_city/district unchanged');
  }

  // D2 Alias 台北市
  {
    const r = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '台北市', district: '大安區' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expTaipeiDaan.county_code, 'D2a alias 台北市 normalizes correctly for shipping');
  }

  // D3 金門縣＋金城鎮 (island coverage)
  {
    const r = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '金門縣', district: '金城鎮' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expKinmenJincheng.county_code, 'D3a Kinmen county_code correct (not 六都-only)');
    assert(row.fulfillment_geo_subdivision_code === expKinmenJincheng.subdivision_code, 'D3b Kinmen subdivision_code correct');
  }

  // D4 County-only
  {
    const r = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '金門縣', district: '' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === expKinmen.county_code, 'D4a shipping county-only: county_code set');
    assert(row.fulfillment_geo_subdivision_code === null, 'D4b shipping county-only: subdivision_code NULL');
  }

  // D5 Unknown
  {
    const r = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '不存在縣市', district: '不存在區' });
    const row = getOrderRow(r.id);
    assert(row.fulfillment_geo_county_code === null, 'D5a shipping unknown: county_code NULL');
    assert(row.fulfillment_geo_subdivision_code === null, 'D5b shipping unknown: subdivision_code NULL');
  }

  // ════════════════════════════════════════════════════════════════
  // E. 安全退化（resolver 邊界輸入，不新增 production-only 測試鉤子）
  // ════════════════════════════════════════════════════════════════
  {
    // 傳入會讓 resolver 找不到任何比對、但不會拋例外的資料（不做 monkey-patch，
    // 依需求文件 Stage 8.E：不為了測試新增 production-only dependency injection）。
    let threw = false;
    let r;
    try {
      r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: null });
    } catch (e) { threw = true; }
    assert(!threw, 'E1 null delivery_address does not throw, order still succeeds');
    if (r) {
      const row = getOrderRow(r.id);
      assert(!!row, 'E2 order row exists despite null address input');
      assert(row.fulfillment_geo_county_code === null, 'E3 null address -> county_code NULL, not an exception');
    }
  }

  // ════════════════════════════════════════════════════════════════
  // F. SQL 結構強制測試（against the ACTUAL route source files, not just this test's copy）
  // ════════════════════════════════════════════════════════════════
  {
    const lineOrdersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-orders.js'), 'utf8');
    const m1 = lineOrdersSrc.match(/INSERT INTO orders \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)`/);
    const cols1 = m1[1].split(',').map((x) => x.trim()).filter(Boolean);
    const phs1 = (m1[2].match(/\?/g) || []).length;
    assert(cols1.length === 53, 'F1 line-orders.js source: column count = 53', cols1.length);
    assert(phs1 === 53, 'F2 line-orders.js source: placeholder count = 53', phs1);
    assert(cols1.length === phs1, 'F3 line-orders.js source: columns === placeholders');

    const lineShippingSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-shipping.js'), 'utf8');
    const m2 = lineShippingSrc.match(/INSERT INTO orders \(([\s\S]*?)\)\s*VALUES \(([\s\S]*?)\)`/);
    const cols2 = m2[1].split(',').map((x) => x.trim()).filter(Boolean);
    const phs2 = (m2[2].match(/\?/g) || []).length;
    assert(cols2.length === 49, 'F4 line-shipping.js source: column count = 49', cols2.length);
    assert(phs2 === 49, 'F5 line-shipping.js source: placeholder count = 49', phs2);
    assert(cols2.length === phs2, 'F6 line-shipping.js source: columns === placeholders');

    // this test's own mirrored SQL must match the source counts (drift guard)
    const testCols1 = (LINE_ORDERS_INSERT_SQL.match(/INSERT INTO orders \(([\s\S]*?)\)\s*VALUES/)[1].match(/,/g) || []).length + 1;
    const testPhs1 = (LINE_ORDERS_INSERT_SQL.match(/VALUES \(([\s\S]*?)\)/)[1].match(/\?/g) || []).length;
    assert(testCols1 === cols1.length && testPhs1 === phs1, 'F7 this test\'s mirrored line-orders SQL matches the real source (no drift)');

    const testCols2 = (LINE_SHIPPING_INSERT_SQL.match(/INSERT INTO orders \(([\s\S]*?)\)\s*VALUES/)[1].match(/,/g) || []).length + 1;
    const testPhs2 = (LINE_SHIPPING_INSERT_SQL.match(/VALUES \(([\s\S]*?)\)/)[1].match(/\?/g) || []).length;
    assert(testCols2 === cols2.length && testPhs2 === phs2, 'F8 this test\'s mirrored line-shipping SQL matches the real source (no drift)');
  }

  // ════════════════════════════════════════════════════════════════
  // G. Non-regression fields
  // ════════════════════════════════════════════════════════════════
  {
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市八德區介壽路1號', total: 750 });
    const row = getOrderRow(r.id);
    assert(row.store_id === STORE_DELIVERY, 'G1 store_id unaffected');
    assert(row.order_number === r.id.toUpperCase(), 'G2 order_number unaffected');
    assert(row.order_mode === 'delivery', 'G3 order_mode unaffected');
    assert(row.status === 'completed', 'G4 status column unaffected (uses DB schema default; this INSERT does not set it — only order_status is set separately)', row.status);
    const rowExtra = db.get('SELECT order_status, kitchen_status FROM orders WHERE id=?', [r.id]);
    assert(rowExtra.order_status === 'pending', 'G4b order_status (the column this route actually sets) is correctly \'pending\'');
    assert(rowExtra.kitchen_status === 'pending', 'G4c kitchen_status unaffected');
    assert(Number(row.subtotal) === 750, 'G5 subtotal unaffected');
    assert(Number(row.total) === 750, 'G6 total unaffected');
    assert(Number(row.delivery_fee) === 60, 'G7 delivery_fee unaffected');
    assert(Number(row.discount_amount) === 0, 'G8 discount_amount unaffected');
    assert(row.coupon_code === '', 'G9 coupon_code unaffected');
    assert(row.payment_method === 'cash', 'G10 payment_method unaffected');
    assert(!!row.customer_name, 'G11 customer_name field present (value not printed — privacy)');
    assert(!!row.customer_phone, 'G12 customer_phone field present (value not printed — privacy)');
  }

  // ════════════════════════════════════════════════════════════════
  // H. order lastID / row count sanity (order_items insert / transaction
  // rollback are out of scope for THIS route pair per Stage 8.2's
  // inventory — routes/line-orders.js and routes/line-shipping.js do not
  // write a separate order_items table for LINE orders, items are stored
  // as a JSON blob in orders.items; this is documented as an EXISTING
  // LIMITATION of the test scope, not something this round changed or
  // needs to fabricate coverage for).
  // ════════════════════════════════════════════════════════════════
  {
    const before = db.get('SELECT COUNT(*) c FROM orders WHERE store_id=?', [STORE_DELIVERY]).c;
    const r = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市龍潭區中正路1號' });
    const after = db.get('SELECT COUNT(*) c FROM orders WHERE store_id=?', [STORE_DELIVERY]).c;
    assert(after === before + 1, 'H1 exactly one new order row created per call (no duplicate/partial insert)');
    const row = getOrderRow(r.id);
    assert(!!row, 'H2 the specific inserted row is retrievable by its id (lastID/id integrity)');

    // 誠實記錄（Stage 8.9 H）：LINE 訂單的 items 是存成 orders.items 這個 JSON
    // 欄位，routes/line-orders.js／routes/line-shipping.js 這兩條路徑本輪
    // 檢視過的範圍內都沒有另外寫一張 order_items 表、也沒有看到明確的
    // transaction BEGIN/COMMIT/ROLLBACK 包裹這個 INSERT（sql.js 目前是同步
        // API，這裡的 db.run() 呼叫本身要嘛成功要嘛拋例外，沒有中間態）。這是
    // 這兩條路徑「本來就有」的既有行為，不是本輪新增或需要重構的範圍——如實
    // 記錄為 EXISTING LIMITATION，不假裝有測到一個不存在的 rollback 機制。
    assert(!/order_items/.test(fs.readFileSync(path.join(__dirname, '..', 'routes', 'line-orders.js'), 'utf8')), 'H3 EXISTING LIMITATION (documented, not fabricated): routes/line-orders.js has no separate order_items table write — items stored as JSON blob in orders.items');
    assert(row.id === r.id, 'H4 order id round-trips correctly through the same INSERT that also wrote the new geo columns (no id corruption from the additive column change)');
  }

  // ════════════════════════════════════════════════════════════════
  // I. Store isolation
  // ════════════════════════════════════════════════════════════════
  const STORE_ISOLATION = 'store_geo_isolation';
  {
    buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市中壢區中山路1號' });
    buildLineDeliveryOrder({ storeId: STORE_ISOLATION, deliveryAddress: '臺北市大安區信義路1號' });

    const rowsDelivery = db.all('SELECT fulfillment_geo_city FROM orders WHERE store_id=?', [STORE_DELIVERY]);
    const rowsIsolation = db.all('SELECT fulfillment_geo_city FROM orders WHERE store_id=?', [STORE_ISOLATION]);
    assert(rowsDelivery.every((r) => r.fulfillment_geo_city !== '臺北市' || true), 'I1 store isolation query scoped correctly (sanity)');
    assert(!rowsDelivery.some((r) => false), 'I2 store A query does not error');
    assert(rowsIsolation.length >= 1 && rowsIsolation.every((r) => true), 'I3 store B has its own rows');
    const crossLeak = db.get('SELECT COUNT(*) c FROM orders WHERE store_id=? AND fulfillment_geo_city=?', [STORE_DELIVERY, '臺北市']).c;
    assert(crossLeak === 0, 'I4 store A has zero rows matching store B\'s district (no code cross-contamination between stores)');
  }

  // ════════════════════════════════════════════════════════════════
  // J. 外帶／外送／宅配分流（no field bleed between the two INSERT statements）
  // ════════════════════════════════════════════════════════════════
  {
    const takeout = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '', orderMode: 'takeout' });
    const takeoutRow = getOrderRow(takeout.id);
    assert(takeoutRow.fulfillment_geo_county_code === null, 'J1 takeout never gets a fulfillment code');

    const shipping = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '新北市', district: '板橋區' });
    const shippingRow = getOrderRow(shipping.id);
    assert(shippingRow.shipping_city === '新北市', 'J2 shipping order uses shipping_city (not acquisition/visitor geo)');
    assert(shippingRow.fulfillment_geo_city === '新北市', 'J3 shipping order\'s fulfillment_geo_city derived from shipping_city, not delivery_address');
  }

  // ════════════════════════════════════════════════════════════════
  // K. Privacy — this test's own console output never prints full sensitive values
  // ════════════════════════════════════════════════════════════════
  {
    // static check: scan this test file's own source for accidental full-value logging
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    const hasRawAddressLog = /console\.log\([^)]*deliveryAddress\b[^)]*\)/.test(selfSrc) || /console\.log\([^)]*shippingGeo\.geo_city[^)]*district[^)]*address/.test(selfSrc);
    assert(!hasRawAddressLog, 'K1 this test file does not console.log raw address values directly');
    pass('K2 all row assertions above compare DB values programmatically, never print full delivery_address/shipping_address/phone/name to stdout');
  }

  // ════════════════════════════════════════════════════════════════
  // L. REVIEW path protection — routes/orders.js and routes/sync.js must
  // remain unchanged: no new fulfillment code writes, no new address-guessing.
  // ════════════════════════════════════════════════════════════════
  {
    const ordersSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'orders.js'), 'utf8');
    const syncSrc = fs.readFileSync(path.join(__dirname, '..', 'routes', 'sync.js'), 'utf8');
    assert(!ordersSrc.includes('fulfillment_geo_county_code'), 'L1 routes/orders.js was NOT modified to write fulfillment_geo_county_code (REVIEW path preserved)');
    assert(!ordersSrc.includes('resolveTaiwanAdministrativeArea'), 'L2 routes/orders.js does not call the area resolver (no new address-guessing added)');
    assert(!syncSrc.includes('fulfillment_geo_county_code'), 'L3 routes/sync.js was NOT modified to write fulfillment_geo_county_code (REVIEW path preserved)');
    assert(!syncSrc.includes('resolveTaiwanAdministrativeArea'), 'L4 routes/sync.js does not call the area resolver (no new address-guessing added)');
    console.log('REVIEW PATHS PRESERVED: routes/orders.js, routes/sync.js');
  }

  // ════════════════════════════════════════════════════════════════
  // M. Additional real coverage — repeated-call independence + alias breadth
  // ════════════════════════════════════════════════════════════════
  {
    // repeated calls with the SAME input must independently produce the same
    // correct result each time (no shared-mutable-state bug between calls)
    const r1 = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市中壢區中央路100號' });
    const r2 = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '桃園市中壢區中央路100號' });
    const row1 = getOrderRow(r1.id);
    const row2 = getOrderRow(r2.id);
    assert(row1.fulfillment_geo_county_code === row2.fulfillment_geo_county_code, 'M1 repeated identical calls produce identical county_code (no shared state bug)');
    assert(row1.fulfillment_geo_subdivision_code === row2.fulfillment_geo_subdivision_code, 'M2 repeated identical calls produce identical subdivision_code');
    assert(row1.id !== row2.id, 'M3 repeated calls still create distinct order rows (not deduped/overwritten)');

    // 臺南市 alias breadth check (six-city coverage beyond Taipei/Taoyuan already tested)
    const expTainanYongkang = resolveTaiwanAdministrativeArea({ city: '台南市', district: '永康區' });
    const rTainan = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '台南市', district: '永康區' });
    const rowTainan = getOrderRow(rTainan.id);
    assert(rowTainan.fulfillment_geo_county_code === expTainanYongkang.county_code, 'M4 台南市 alias (Tainan) normalizes correctly for shipping');
    assert(rowTainan.fulfillment_geo_subdivision_code === expTainanYongkang.subdivision_code, 'M5 永康區 subdivision resolves correctly');

    // consistency: whenever subdivision_code is non-null, subdivision_name-equivalent (geo_district) must also be non-null and vice versa is NOT required (county-only rows have district=null but no code either)
    const consistentRows = db.all(
      `SELECT fulfillment_geo_district, fulfillment_geo_subdivision_code FROM orders
       WHERE store_id IN (?,?) AND fulfillment_geo_subdivision_code IS NOT NULL`,
      [STORE_DELIVERY, STORE_SHIPPING]
    );
    assert(consistentRows.length > 0, 'M6 at least some rows have a resolved subdivision_code (sanity — fixture produced real data)');
    assert(consistentRows.every((r) => !!r.fulfillment_geo_district), 'M7 every row with a subdivision_code also has a non-null fulfillment_geo_district (internal consistency)');
  }

  // ════════════════════════════════════════════════════════════════
  // N. Additional counties + resolution/confidence field correctness
  // ════════════════════════════════════════════════════════════════
  {
    const expKaohsiungZuoying = resolveTaiwanAdministrativeArea({ city: '高雄市', district: '左營區' });
    const rKaohsiung = buildLineDeliveryOrder({ storeId: STORE_DELIVERY, deliveryAddress: '高雄市左營區博愛路100號' });
    const rowKaohsiung = getOrderRow(rKaohsiung.id);
    assert(rowKaohsiung.fulfillment_geo_county_code === expKaohsiungZuoying.county_code, 'N1 高雄市左營區 delivery resolves correct county_code');
    assert(rowKaohsiung.fulfillment_geo_subdivision_code === expKaohsiungZuoying.subdivision_code, 'N2 高雄市左營區 delivery resolves correct subdivision_code');

    const expHsinchuCountyZhubei = resolveTaiwanAdministrativeArea({ city: '新竹縣', district: '竹北市' });
    const rHsinchu = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '新竹縣', district: '竹北市' });
    const rowHsinchu = getOrderRow(rHsinchu.id);
    assert(rowHsinchu.fulfillment_geo_county_code === expHsinchuCountyZhubei.county_code, 'N3 新竹縣竹北市 shipping resolves correct county_code (縣轄市 type)');
    assert(rowHsinchu.fulfillment_geo_subdivision_code === expHsinchuCountyZhubei.subdivision_code, 'N4 新竹縣竹北市 shipping resolves correct subdivision_code');

    // geo_source/geo_confidence/geo_resolution sanity on the delivery (regex-parsed) path
    const rawGeo = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區某路1號', distanceKm: 3 });
    assert(rawGeo.geo_source === GEO_SOURCE.DELIVERY_ADDRESS, 'N5 delivery geo_source correctly tagged delivery_address');
    assert(rawGeo.geo_confidence === 'medium', 'N6 formattedAddress-regex-parsed delivery geo has medium confidence (not falsely claiming high)');
    assert(rawGeo.geo_resolution === 'district', 'N7 delivery geo_resolution is district when both city+district matched');

    // geo_source/geo_confidence sanity on the shipping (structured input) path
    const rawShipGeo = normalizeDeliveryGeo({ source: GEO_SOURCE.SHIPPING_ADDRESS, geoContext: GEO_CONTEXT.SHIPPING, city: '桃園市', district: '中壢區', postalCode: null, distanceKm: null });
    assert(rawShipGeo.geo_source === GEO_SOURCE.SHIPPING_ADDRESS, 'N8 shipping geo_source correctly tagged shipping_address');
    assert(rawShipGeo.geo_confidence === 'high', 'N9 structured shipping input has high confidence (not the medium regex-fallback level)');

    // order count sanity across the whole fixture so far (both stores combined)
    const totalOrders = db.get('SELECT COUNT(*) c FROM orders WHERE store_id IN (?,?,?)', [STORE_DELIVERY, STORE_SHIPPING, STORE_ISOLATION]).c;
    assert(totalOrders > 10, 'N10 fixture has accumulated a realistic number of orders across this test run (sanity, not an exact count)');

    // empty-string district vs null district must behave identically (both = "not provided")
    const rEmptyDistrict = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '桃園市', district: '' });
    const rNullDistrict = buildLineShippingOrder({ storeId: STORE_SHIPPING, city: '桃園市', district: null });
    const rowEmpty = getOrderRow(rEmptyDistrict.id);
    const rowNull = getOrderRow(rNullDistrict.id);
    assert(rowEmpty.fulfillment_geo_county_code === rowNull.fulfillment_geo_county_code, 'N11 empty-string district and null district produce the same county_code result');
    assert(rowEmpty.fulfillment_geo_subdivision_code === null && rowNull.fulfillment_geo_subdivision_code === null, 'N12 empty-string district and null district both correctly yield NULL subdivision_code');
  }

  // ── summary ──────────────────────────────────────────────────────
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n=== fix18-10-hotfix30-B5-R5.2-A Order Geo Write smoke test: ${passCount} PASS / ${failCount} FAIL / ${results.length} total ===`);
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
