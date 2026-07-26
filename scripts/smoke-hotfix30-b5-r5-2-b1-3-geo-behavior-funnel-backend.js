#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-3-geo-behavior-funnel-backend.js
// fix18-10-hotfix30-B5-R5.2-B1-3 — Phase 1（後端資料層，範圍依使用者指示限定）：
//   1. 事件「人數」與「次數」分離（getGeoFunnel / getCountySummary）
//   2. 沿用既有 Cart Abandonment 正式定義（cart_id / status，見
//      utils/cartSnapshot.js buildRowFromCandidate 的 last_stage/status
//      判斷），不另造一套
//   3. 行政區層級 Cart Abandonment 聚合（buildGeoDistrictRanking /
//      buildGeoSummary 新增欄位）
//   4. 行政區 × 商品放棄分析（buildAbandonProductsByArea，經
//      GET /api/analytics/geo/cart-attribution?district=... 對外）
//   5. Contract／Store／Date／Channel Scope／Unknown／Privacy
//
// 不含前端、規則分類、Recommended Actions、Dashboard KPI 改版
// （依使用者指示本輪不做，留給後續輪次）。
// 使用真實 sql.js DB（utils/db.js），直接呼叫真實程式碼，不 mock。

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
  const stack = layer.route.stack;
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
      if (idx >= stack.length) return resolve({ statusCode, body: jsonBody });
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
  const { resolveDateRange } = require('../utils/dashboardDate');
  const geoQ = require('../utils/geoAnalyticsQueries');
  const {
    buildCartRowsWithGeo, buildGeoDistrictRanking, buildGeoSummary, buildAbandonProductsByArea,
  } = require('../utils/cartGeoAttribution');
  const analyticsGeoRouter = require('../routes/analytics-geo');

  const STORE_A = 'store_b13_a';
  const STORE_B = 'store_b13_b';

  const geoZhongli = { geo_country: 'TW', geo_city: '桃園市', geo_district: '中壢區', geo_source: 'ip', geo_confidence: 'medium', geo_resolution: 'district', geo_context: 'visitor', geo_accuracy: 'city', geo_provider: 'ipapi', geo_version: 1 };
  const geoPingzhen = { ...geoZhongli, geo_district: '平鎮區' };
  const geoBade = { ...geoZhongli, geo_district: '八德區' };

  // ══════════════════════════════════════════════════════════
  // A. 事件「人數」與「次數」分離（getGeoFunnel）
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const filters = { range, channel: null, page: 1, limit: 50, offset: 0 };

    // 情境：1 人 view_product 12 次；同一人 add_to_cart 3 次
    for (let i = 0; i < 12; i += 1) {
      insertEvent(db, { store_id: STORE_A, visitor_id: 'va1', session_id: 'sa1', event_name: 'page_view', geo: geoZhongli });
      insertEvent(db, { store_id: STORE_A, visitor_id: 'va1', session_id: 'sa1', event_name: 'view_product', product_id: 1, geo: geoZhongli });
    }
    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_A, visitor_id: 'va1', session_id: 'sa1', cart_id: 'cart-a1', event_name: 'add_to_cart', product_id: 1, quantity: 1, geo: geoZhongli });
    }
    // 另一位訪客只瀏覽，沒有加購（情境 A：只瀏覽也要出現在 Funnel）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'va2', session_id: 'sa2', event_name: 'page_view', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'va2', session_id: 'sa2', event_name: 'view_product', product_id: 2, geo: geoZhongli });

    const funnel = geoQ.getGeoFunnel(db, STORE_A, filters);
    const zhongli = funnel.areas.find((a) => a.district === '中壢區');
    assert(!!zhongli, 'A1 中壢區 出現在 Funnel（只瀏覽/未購買訪客也要納入）');
    assert(zhongli.visitors === 2, 'A2 訪客人數去重正確（2 位不同訪客，不是事件筆數）');
    assert(zhongli.view_product_visitors === 2, 'A3 瀏覽商品人數 = 2（去重，不是 12+1=13 次事件）');
    assert(zhongli.view_product_events === 13, 'A4 瀏覽商品次數 = 13（va1 12 次 + va2 1 次，事件筆數，不去重）');
    assert(zhongli.add_to_cart_visitors === 1, 'A5 加入購物車人數 = 1（va1 一人，即使加購 3 次）');
    assert(zhongli.add_to_cart_events === 3, 'A6 加入購物車次數 = 3（同一人 3 次事件筆數）');
    assert(zhongli.begin_checkout_visitors === 0, 'A7 開始結帳人數 = 0（本情境尚未 begin_checkout）');
    assert(zhongli.begin_checkout_events === 0, 'A8 開始結帳次數 = 0');
    assert(zhongli.purchase_visitors === 0, 'A9 完成購買人數 = 0（情境 A：只瀏覽/加購未買）');
  }

  // ══════════════════════════════════════════════════════════
  // B. Funnel 轉換率與流失人數（NaN/Infinity 防護 + dropoff）
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const filters = { range, channel: null, page: 1, limit: 50, offset: 0 };
    const funnel = geoQ.getGeoFunnel(db, STORE_A, filters);
    const zhongli = funnel.areas.find((a) => a.district === '中壢區');
    assert(typeof zhongli.visit_to_view_rate === 'number' && Number.isFinite(zhongli.visit_to_view_rate), 'B1 visit_to_view_rate 是有限數字');
    assert(typeof zhongli.view_to_cart_rate === 'number' && Number.isFinite(zhongli.view_to_cart_rate), 'B2 view_to_cart_rate 是有限數字');
    assert(typeof zhongli.checkout_to_purchase_rate === 'number' && Number.isFinite(zhongli.checkout_to_purchase_rate), 'B3 checkout_to_purchase_rate 是有限數字（分母 0 時應為 0）');
    assert(zhongli.checkout_to_purchase_rate === 0, 'B4 checkout_to_purchase_rate 分母(begin_checkout=0)為 0 時回 0，不是 NaN/Infinity');
    assert(!Number.isNaN(zhongli.checkout_to_purchase_rate) && zhongli.checkout_to_purchase_rate !== Infinity, 'B5 明確排除 NaN/Infinity');
    assert(zhongli.dropoff && zhongli.dropoff.checkout_to_purchase >= 0, 'B6 dropoff 各階段流失人數皆 >= 0');
  }

  // ══════════════════════════════════════════════════════════
  // C. County Summary 事件次數擴充
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const filters = { range, channel: null };
    const summary = geoQ.getCountySummary(db, STORE_A, filters);
    const taoyuan = summary.rows.find((r) => r.county_name === '桃園市');
    assert(!!taoyuan, 'C1 county-summary 出現桃園市（中壢區歸戶）');
    assert(taoyuan.product_view_event_count === 13, 'C2 county-summary product_view_event_count = 13（次數，非人數）');
    assert(taoyuan.cart_event_count === 3, 'C3 county-summary cart_event_count = 3');
    assert(taoyuan.product_view_visitor_count === 2, 'C4 county-summary product_view_visitor_count 仍是去重人數，未被次數污染');
  }

  // ══════════════════════════════════════════════════════════
  // D. 情境 B/C/D/E — 未購買訪客必須出現 + Cart Abandonment 定義沿用既有 status
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const filters = { range, channel: null, source: null, campaign: null, page: 1, limit: 50, offset: 0 };

    // 情境 B：平鎮區，加購未買（無 begin_checkout、無 purchase）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vb1', session_id: 'sb1', cart_id: 'cart-b1', event_name: 'add_to_cart', product_id: 10, quantity: 1, geo: geoPingzhen });

    // 情境 C：八德區，結帳未買
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vc1', session_id: 'sc1', cart_id: 'cart-c1', event_name: 'add_to_cart', product_id: 11, quantity: 1, geo: geoBade });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vc1', session_id: 'sc1', cart_id: 'cart-c1', event_name: 'begin_checkout', geo: geoBade });

    // 情境 D：中壢區，完整購買（另一位訪客，product_id=1）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vd1', session_id: 'sd1', event_name: 'page_view', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vd1', session_id: 'sd1', event_name: 'view_product', product_id: 1, geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vd1', session_id: 'sd1', cart_id: 'cart-d1', event_name: 'add_to_cart', product_id: 1, quantity: 1, geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vd1', session_id: 'sd1', cart_id: 'cart-d1', event_name: 'begin_checkout', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vd1', session_id: 'sd1', cart_id: 'cart-d1', event_name: 'purchase', geo: geoZhongli });

    // 情境 E：無法辨識位置（完全沒有 visitor-context geo 事件）
    insertEvent(db, { store_id: STORE_A, visitor_id: 've1', session_id: 'se1', cart_id: 'cart-e1', event_name: 'add_to_cart', product_id: 12, quantity: 1 });

    const funnel = geoQ.getGeoFunnel(db, STORE_A, filters);
    const pingzhen = funnel.areas.find((a) => a.district === '平鎮區');
    assert(!!pingzhen && pingzhen.add_to_cart_visitors === 1 && pingzhen.purchase_visitors === 0, 'D1 情境B：平鎮區加購未買仍出現在 Funnel，purchase=0');
    const bade = funnel.areas.find((a) => a.district === '八德區');
    assert(!!bade && bade.begin_checkout_visitors === 1 && bade.purchase_visitors === 0, 'D2 情境C：八德區結帳未買仍出現在 Funnel，purchase=0');
    const zhongliFull = funnel.areas.find((a) => a.district === '中壢區');
    assert(zhongliFull.purchase_visitors === 1, 'D3 情境D：中壢區完整購買 purchase_visitors 正確計入');
    assert(!funnel.areas.some((a) => a.city === null && a.district === null), 'D4 情境E：完全無法辨識位置的訪客不會混入具名區域列（獨立於 Unknown 統計，見 quality）');

    // Cart Abandonment：沿用既有 buildGeoDistrictRanking（cart_id/status 定義）
    const { rows, firstTouchMap } = buildCartRowsWithGeo(db, STORE_A, filters);
    const ranking = buildGeoDistrictRanking(rows, firstTouchMap);
    const pingzhenRank = ranking.find((r) => r.district === '平鎮區');
    assert(!!pingzhenRank, 'D5 區域 Cart Abandonment：平鎮區出現在排行榜');
    assert(pingzhenRank.cart_abandon_visitors === pingzhenRank.visitors - pingzhenRank.purchase_visitors, 'D6 購物車放棄人數 = 加入購物車人數 - 完成購買人數（沿用需求文件公式）');
    const badeRank = ranking.find((r) => r.district === '八德區');
    assert(badeRank.checkout_abandon_visitors === badeRank.begin_checkout_event_visitors - badeRank.purchase_visitors, 'D7 結帳放棄人數 = 開始結帳人數(event-based) - 完成購買人數');
    assert(badeRank.checkout_abandon_visitors === 1, 'D8 八德區結帳放棄人數 = 1（情境C）');
    // D7b：明確驗證兩種「開始結帳」定義並存、不混用（見需求文件九-6：已存在的
    // attempt_id-based begin_checkout 跟 raw begin_checkout 事件是不同定義，
    // 本情境 begin_checkout 事件發生但沒有 LINE attempt_id 快照，因此
    // begin_checkout（舊，attempt-based）預期為 0，begin_checkout_event_visitors
    // （新，event-based，與 getGeoFunnel 同定義）預期為 1，兩者不應相等）
    assert(badeRank.begin_checkout === 0 && badeRank.begin_checkout_event_visitors === 1, 'D7c 兩種「開始結帳」定義確實不同：attempt_id-based=0（無 LINE 快照），event-based=1（有 begin_checkout 事件），未被誤合併成一個欄位');
    const zhongliRank = ranking.find((r) => r.district === '中壢區');
    assert(zhongliRank.cart_abandon_visitors >= 0 && zhongliRank.checkout_abandon_visitors >= 0, 'D9 中壢區放棄人數皆 >= 0（含已購買訪客時不會變負數）');
    assert(ranking.every((r) => Number.isFinite(r.estimated_abandon_value) && r.estimated_abandon_value >= 0), 'D10 估算放棄金額皆為有限非負數，不出現 NaN/Infinity');

    const summary = buildGeoSummary(rows, firstTouchMap);
    assert(summary.cart_abandon_visitors === summary.visitor_count - summary.purchase_count, 'D11 全店摘要：cart_abandon_visitors 公式與行政區層級一致');
    assert(summary.checkout_abandon_visitors === summary.begin_checkout_event_count - summary.purchase_count, 'D12 全店摘要：checkout_abandon_visitors 公式正確（event-based）');

    // 商品放棄分析：平鎮區只有 product_id=10，加購未買 -> 100% 放棄
    const abandonProducts = buildAbandonProductsByArea(rows, firstTouchMap, '平鎮區', { limit: 10 });
    assert(abandonProducts.length === 1, 'D13 商品放棄分析：平鎮區只有 1 個商品進榜');
    assert(abandonProducts[0].add_to_cart_visitors === 1 && abandonProducts[0].purchase_visitors === 0, 'D14 商品放棄分析：加購人數/購買人數正確');
    assert(abandonProducts[0].abandon_rate === 100, 'D15 商品放棄分析：放棄率 100%（1 人加購、0 人購買）');
    assert(Number.isFinite(abandonProducts[0].abandon_rate), 'D16 商品放棄分析：放棄率為有限數字');

    // 隱私：商品放棄分析輸出不得含個人識別資訊（檢查實際 fixture 的
    // visitor_id/session_id/cart_id 原始值與內部欄位鍵名，不是「visitor」這種
    // 會誤命中 add_to_cart_visitors 等聚合欄位名稱的過寬字串）
    const serialized = JSON.stringify(abandonProducts);
    assert(!/vb1|sb1|cart-b1|_visitor_id_raw|_line_uid_raw|line_user_id/.test(serialized), 'D17 商品放棄分析輸出不含 visitor_id/session_id/cart_id/LINE UID 等原始個資值或內部欄位');
    assert(Object.keys(abandonProducts[0]).every((k) => !['visitor_id', 'session_id', 'cart_id', 'identity_key', 'line_uid', 'phone'].includes(k)), 'D17b 商品放棄分析輸出欄位鍵名本身不含個資欄位');
  }

  // ══════════════════════════════════════════════════════════
  // E. /cart-attribution 擴充：Drawer 商品放棄分析（透過既有 API，不新建 endpoint）
  // ══════════════════════════════════════════════════════════
  {
    const r1 = await callRoute(analyticsGeoRouter, 'GET', '/cart-attribution', { storeId: STORE_A, query: { district: '平鎮區' } });
    assert(r1.statusCode === 200 && r1.body.success === true, 'E1 /cart-attribution?district=平鎮區 200 success');
    assert(Array.isArray(r1.body.data.abandon_products), 'E2 帶 district 篩選時回傳 abandon_products 陣列');
    assert(r1.body.data.abandon_products_area === '平鎮區', 'E3 abandon_products_area 回報正確的行政區');
    assert(r1.body.data.district_ranking.every((d) => 'cart_abandon_visitors' in d && 'checkout_abandon_visitors' in d && 'estimated_abandon_value' in d), 'E4 district_ranking 每列都有新的放棄欄位');

    const r2 = await callRoute(analyticsGeoRouter, 'GET', '/cart-attribution', { storeId: STORE_A, query: {} });
    assert(r2.statusCode === 200 && !('abandon_products' in r2.body.data), 'E5 未指定行政區時不回傳 abandon_products（既有呼叫端行為不變）');

    const r3 = await callRoute(analyticsGeoRouter, 'GET', '/funnel', { storeId: STORE_A, query: {} });
    assert(r3.statusCode === 200 && r3.body.success === true, 'E6 /funnel 200 success（回應格式未被破壞）');
    const funnelZhongli = r3.body.data.areas.find((a) => a.district === '中壢區');
    assert(funnelZhongli && 'view_product_events' in funnelZhongli && 'add_to_cart_events' in funnelZhongli, 'E7 /funnel 回應含新的次數欄位');
    assert(funnelZhongli && 'view_product_visitors' in funnelZhongli, 'E8 /funnel 回應仍保留既有人數欄位（向下相容）');

    const r4 = await callRoute(analyticsGeoRouter, 'GET', '/county-summary', { storeId: STORE_A, query: {} });
    assert(r4.statusCode === 200 && r4.body.ok === true, 'E9 /county-summary 200 ok（{ok:true} 契約格式維持）');
    const taoyuanRow = r4.body.rows.find((r) => r.county_name === '桃園市');
    assert(taoyuanRow && 'product_view_event_count' in taoyuanRow, 'E10 /county-summary 回應含新的次數欄位');
  }

  // ══════════════════════════════════════════════════════════
  // F. Store Isolation / Date Scope / Channel Scope
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    insertEvent(db, { store_id: STORE_B, visitor_id: 'vf1', session_id: 'sf1', event_name: 'page_view', geo: geoZhongli });
    insertEvent(db, { store_id: STORE_B, visitor_id: 'vf1', session_id: 'sf1', cart_id: 'cart-f1', event_name: 'add_to_cart', product_id: 1, quantity: 1, geo: geoZhongli });

    const funnelA = geoQ.getGeoFunnel(db, STORE_A, { range, channel: null, page: 1, limit: 50, offset: 0 });
    const funnelB = geoQ.getGeoFunnel(db, STORE_B, { range, channel: null, page: 1, limit: 50, offset: 0 });
    const totalA = funnelA.areas.reduce((s, a) => s + a.visitors, 0);
    const totalB = funnelB.areas.reduce((s, a) => s + a.visitors, 0);
    assert(totalB === 1, 'F1 Store Isolation：STORE_B 只看到自己的 1 位訪客，不含 STORE_A 資料');
    assert(totalA > totalB, 'F2 Store Isolation：STORE_A 資料不受 STORE_B 寫入影響（各自獨立）');

    // Channel Scope：帶入不存在的 channel 篩選應回傳空集合，不報錯、不誤混其他 channel
    const filtersWithChannel = { range, channel: 'delivery', page: 1, limit: 50, offset: 0 };
    const funnelChannelFiltered = geoQ.getGeoFunnel(db, STORE_A, filtersWithChannel);
    assert(Array.isArray(funnelChannelFiltered.areas), 'F3 Channel Scope：帶入 delivery 篩選不報錯，回傳陣列（本情境事件皆無 order_channel=delivery，預期為空或子集）');

    // Date Scope：昨天區間應排除今天寫入的資料
    const yesterdayRange = resolveDateRange({ preset: 'yesterday' });
    const funnelYesterday = geoQ.getGeoFunnel(db, STORE_A, { range: yesterdayRange, channel: null, page: 1, limit: 50, offset: 0 });
    const totalYesterday = funnelYesterday.areas.reduce((s, a) => s + a.visitors, 0);
    assert(totalYesterday === 0, 'F4 Date Scope：昨天區間查不到今天才寫入的事件（日期篩選確實生效）');
  }

  // ══════════════════════════════════════════════════════════
  // G. Unknown 行為資料（有事件但無法辨識行政區）
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const quality = geoQ.getGeoQuality(db, STORE_A, { range, channel: null });
    assert(quality.unknown_events >= 1, 'G1 Geo Quality：情境E（無法辨識位置）計入 unknown_events');
    assert(Number.isFinite(quality.unknown_rate) && quality.unknown_rate >= 0 && quality.unknown_rate <= 1, 'G2 Geo Quality：unknown_rate 是 0~1 之間的有限數字');
    assert(quality.status === 'healthy' || quality.status === 'degraded' || quality.status === 'insufficient_data', 'G3 Geo Quality：status 為已知列舉值之一');
  }

  // ══════════════════════════════════════════════════════════
  // H. Privacy — DOM/API 不得暴露個資
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const r = await callRoute(analyticsGeoRouter, 'GET', '/cart-attribution', { storeId: STORE_A, query: { district: '中壢區' } });
    const serialized = JSON.stringify(r.body);
    assert(!/line_user_id|_line_uid_raw|_visitor_id_raw/.test(serialized), 'H1 /cart-attribution 回應不含內部原始識別欄位鍵名');
    assert(!/09\d{8}/.test(serialized), 'H2 /cart-attribution 回應不含台灣手機號碼格式字串');

    const funnelResp = await callRoute(analyticsGeoRouter, 'GET', '/funnel', { storeId: STORE_A, query: {} });
    const funnelSerialized = JSON.stringify(funnelResp.body);
    assert(!/visitor_id|session_id|identity_key/.test(funnelSerialized), 'H3 /funnel 回應不含逐筆 visitor_id/session_id/identity_key（只有聚合數字）');
  }

  // ══════════════════════════════════════════════════════════
  // I. Phase 1.1 — getGeoSourceArea() 事件漏失修正
  // ══════════════════════════════════════════════════════════
  {
    const range = resolveDateRange({ preset: 'today' });
    const geoI1 = { ...geoZhongli, geo_district: '龍潭區' }; // 用全新行政區，避免跟前面情境的既有事件互相污染統計
    const filters = { range, channel: null, page: 1, limit: 50, offset: 0 };

    // 需求文件 Phase 1.1-4：五種「只有單一階段」情境都要各自出現在
    // source-area。getGeoSourceArea() 是依 (source, medium, campaign, channel,
    // city, district) GROUP BY，因此每個情境刻意使用不同的 source，避免被
    // SQL 正常的分組行為合併成一列（合併本身是對的，跟本輪要修的漏失問題
    // 無關，是測試 fixture 必須配合的真實分組語意）。

    // 情境 1：page_view-only（來源 src1）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vi1', session_id: 'si1', event_name: 'page_view', source: 'src1', medium: 'cpc', campaign: 'campA', geo: geoI1 });

    // 情境 2：view_item-only（實際事件名 view_product，來源 src2）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vi2', session_id: 'si2', event_name: 'view_product', product_id: 20, source: 'src2', medium: 'cpc', campaign: 'campA', geo: geoI1 });

    // 情境 3：add_to_cart-only（來源 src3）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vi3', session_id: 'si3', cart_id: 'cart-i3', event_name: 'add_to_cart', product_id: 21, source: 'src3', medium: 'cpc', campaign: 'campA', geo: geoI1 });

    // 情境 4：begin_checkout-only（來源 src4／medium=email／campaign=campB）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vi4', session_id: 'si4', cart_id: 'cart-i4', event_name: 'begin_checkout', source: 'src4', medium: 'email', campaign: 'campB', geo: geoI1 });

    // 情境 5：purchase-only（來源 src5／medium=email／campaign=campB，跟情境4不同 source，避免合併）
    insertEvent(db, { store_id: STORE_A, visitor_id: 'vi5', session_id: 'si5', cart_id: 'cart-i5', event_name: 'purchase', source: 'src5', medium: 'email', campaign: 'campB', geo: geoI1 });

    // 情境 6：view_product 12 次、add_to_cart 3 次（同一人，來源 src6，驗證次數不當成人數）
    for (let i = 0; i < 12; i += 1) {
      insertEvent(db, { store_id: STORE_A, visitor_id: 'vi6', session_id: 'si6', event_name: 'view_product', product_id: 22, source: 'src6', medium: 'cpc', campaign: 'campA', geo: geoI1 });
    }
    for (let i = 0; i < 3; i += 1) {
      insertEvent(db, { store_id: STORE_A, visitor_id: 'vi6', session_id: 'si6', cart_id: 'cart-i6', event_name: 'add_to_cart', product_id: 22, source: 'src6', medium: 'cpc', campaign: 'campA', geo: geoI1 });
    }

    // 情境 7：Unknown（geo_context='visitor' 但無法辨識行政區——這是
    // Funnel/SourceArea 表格內「Unknown」真正對應的既有定義：嘗試過 visitor
    // context 解析但沒有 city/district。省略 geo 參數會退回
    // geo_context='unknown'（完全沒有嘗試過的另一種狀態，getGeoFunnel()/
    // getGeoSourceArea() 本來就用 WHERE geo_context='visitor' 排除它，這是
    // 既有、刻意的設計，不是本輪要修的範圍），兩者不可混用，故這裡明確指定
    // geo_context='visitor' 且 city/district 皆為 null）。
    insertEvent(db, {
      store_id: STORE_A, visitor_id: 'vi7', session_id: 'si7', cart_id: 'cart-i7', event_name: 'add_to_cart', product_id: 23,
      source: 'src7', medium: 'cpc', campaign: 'campA',
      geo: { geo_country: 'TW', geo_city: null, geo_district: null, geo_source: 'ip', geo_confidence: 'low', geo_resolution: 'unknown', geo_context: 'visitor', geo_accuracy: 'unknown', geo_provider: 'ipapi', geo_version: 1 },
    });

    const sourceArea = geoQ.getGeoSourceArea(db, STORE_A, filters);
    const rowsInDistrict = sourceArea.rows.filter((r) => r.district === '龍潭區');

    const srcPageView = rowsInDistrict.find((r) => r.source === 'src1');
    assert(!!srcPageView && srcPageView.visitors === 1, 'I1 情境1（page_view-only, src1）出現在 source-area，visitors=1');

    const srcViewOnly = rowsInDistrict.find((r) => r.source === 'src2');
    assert(!!srcViewOnly && srcViewOnly.view_product_visitors === 1 && srcViewOnly.visitors === 0 && srcViewOnly.add_to_cart === 0, 'I2 情境2（view_item-only, src2）保留在 source-area，即使 visitors(page_view)=0');

    const srcCartOnly = rowsInDistrict.find((r) => r.source === 'src3');
    assert(!!srcCartOnly && srcCartOnly.add_to_cart === 1 && srcCartOnly.visitors === 0 && srcCartOnly.view_product_visitors === 0, 'I3 情境3（add_to_cart-only, src3）保留在 source-area，即使沒有 page_view/view_item');

    const srcCheckout = rowsInDistrict.find((r) => r.source === 'src4');
    assert(!!srcCheckout && srcCheckout.medium === 'email' && srcCheckout.campaign === 'campB' && srcCheckout.begin_checkout === 1 && srcCheckout.purchases === 0, 'I4 情境4（begin_checkout-only, src4/email/campB）保留在 source-area');

    const srcPurchase = rowsInDistrict.find((r) => r.source === 'src5');
    assert(!!srcPurchase && srcPurchase.medium === 'email' && srcPurchase.campaign === 'campB' && srcPurchase.purchases === 1 && srcPurchase.begin_checkout === 0 && srcPurchase.visitors === 0, 'I5 情境5（purchase-only, src5）保留在 source-area，即使沒有其他任何前段事件');

    const srcGroup6 = rowsInDistrict.find((r) => r.source === 'src6');
    assert(!!srcGroup6 && srcGroup6.view_product_events === 12, 'I6 情境6：view_product_events = 12（次數，同一人 12 次事件）');
    assert(srcGroup6.view_product_visitors === 1, 'I7 情境6：view_product_visitors = 1（人數去重，不是 12）');
    assert(srcGroup6.add_to_cart_events === 3 && srcGroup6.add_to_cart === 1, 'I8 情境6：add_to_cart_events=3（次數）／add_to_cart=1（人數），不互相污染');
    assert('begin_checkout_events' in srcGroup6, 'I9 source-area 回應含 begin_checkout_events 欄位（次數，即使本列為 0）');

    // Unknown：city/district 皆為 null，獨立成一列，不混入龍潭區
    const unknownRow = sourceArea.rows.find((r) => r.city === null && r.district === null && r.source === 'src7');
    assert(!!unknownRow && unknownRow.add_to_cart === 1, 'I10 Unknown（無法辨識行政區）情境7 獨立成列，仍保留在 source-area（未混入龍潭區）');
    assert(!rowsInDistrict.some((r) => r.city === null), 'I11 Unknown 沒有污染龍潭區具名列');

    // source/medium/campaign scope 沒有被破壞：不同來源各自分開列，不會被誤合併
    const distinctSourceCombos = new Set(rowsInDistrict.map((r) => `${r.source}|${r.medium}|${r.campaign}`));
    assert(distinctSourceCombos.size === 6, 'I12 source/medium/campaign 分組正確分開（本情境 6 個不同 source 各自一列，沒有被誤合併也沒有多出假列）');

    // Store isolation / channel scope
    const sourceAreaOtherStore = geoQ.getGeoSourceArea(db, STORE_B, filters);
    assert(!sourceAreaOtherStore.rows.some((r) => r.source === 'src5'), 'I13 Store Isolation：STORE_B 看不到 STORE_A 的 src5 資料');
    const sourceAreaChannelFiltered = geoQ.getGeoSourceArea(db, STORE_A, { ...filters, channel: 'delivery' });
    assert(Array.isArray(sourceAreaChannelFiltered.rows), 'I14 Channel Scope：帶入 delivery 篩選不報錯，回傳陣列');

    // Date scope：昨天區間應查不到今天寫入的 source-area 資料
    const yesterdayRange = resolveDateRange({ preset: 'yesterday' });
    const sourceAreaYesterday = geoQ.getGeoSourceArea(db, STORE_A, { ...filters, range: yesterdayRange });
    assert(!sourceAreaYesterday.rows.some((r) => r.source === 'src5'), 'I15 Date Scope：昨天區間查不到今天才寫入的 src5 事件');

    // API contract：透過既有 /source-area endpoint 驗證回應格式與欄位
    const apiResp = await callRoute(analyticsGeoRouter, 'GET', '/source-area', { storeId: STORE_A, query: {} });
    assert(apiResp.statusCode === 200 && apiResp.body.success === true, 'I16 /source-area 200 success（回應格式未被破壞）');
    const apiSrc6 = apiResp.body.data.rows.find((r) => r.source === 'src6' && r.district === '龍潭區' && r.view_product_events === 12);
    assert(!!apiSrc6, 'I17 /source-area API 回應含新的 view_product_visitors/events 欄位且數值正確');
    assert(!JSON.stringify(apiResp.body).match(/vi1|vi2|vi3|vi4|vi5|vi6|vi7|si1|si2|si3|si4|si5|si6|si7/), 'I18 /source-area 回應不含原始 visitor_id/session_id（只有聚合數字）');
  }


  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n總計：${results.length} 項，PASS ${passCount}，FAIL ${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
});
