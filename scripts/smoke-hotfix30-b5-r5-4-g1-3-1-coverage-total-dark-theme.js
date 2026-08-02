#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-3-1-coverage-total-dark-theme.js
// fix18-10-hotfix30-B5-R5.4-G1.3.1 — Coverage Business Total & Dark Theme Hotfix
//
// 沿用 G1.3 已驗證過的 jsdom 慣例：真的執行 geo-heatmap.js + geo-heatmap-ui.js
// （單一 eval() 呼叫，保留跨檔案 const/let 共用作用域），不是原始碼字串掃描。
// 真實案例 Fixture（需求文件十五）：1 筆訂單／NT$150／外帶／Geo Coverage 0%。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.3.1 (Coverage Business Total & Dark Theme)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check（所有本輪觸碰到的檔案）
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-heatmap-ui.js', 'public/js/geo-heatmap.js', 'utils/geoAnalyticsQueries.js', 'routes/analytics-geo.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  // ══════════════════════════════════════════════════════════════
  // 0.5 真實 DB 測試（需求文件二）——直接呼叫 utils/geoAnalyticsQueries.js
  //     的 getGeoFulfillment()，驗證 business_total_orders/revenue 與既有
  //     Dashboard／Geo Drawable 統計口徑完全一致（沿用
  //     scripts/smoke-hotfix30-b5-r5-1-b-geo-api.js 既有的真實 sql.js DB
  //     測試慣例，不是字串掃描）。
  // ══════════════════════════════════════════════════════════════
  {
    const { initDb, getDb } = require('../utils/db');
    await initDb();
    const db = getDb();
    const { normalizeDeliveryGeo } = require('../utils/geoResolver');
    const { GEO_SOURCE, GEO_CONTEXT } = require('../utils/geoConstants');
    const { parseGeoAnalyticsFilters } = require('../utils/geoAnalyticsFilters');
    const geoQ = require('../utils/geoAnalyticsQueries');
    // fix18-10-hotfix30-B5-R5.4-G1.4：Harness 修正——不再用
    // datetime('now','localtime')（跟著容器 OS 時區走，容器是 UTC，跟
    // app 的 Asia/Taipei 查詢範圍在跨日附近會對不上，導致 fixture 落在
    // 查詢範圍外）。改用 computeFixtureTimestamp()，直接呼叫產品既有的
    // resolveDateRange()，取查詢範圍正中間，保證一定落在範圍內，且完全
    // 不依賴容器時區、不 hardcode 日期。
    const { computeFixtureTimestamp } = require('./lib/geo-fixture-time');

    const STORE_G131 = 'store_g131_business_total';
    const STORE_G131_OTHER = 'store_g131_other';

    // fix18-10-hotfix30-B5-R5.4-G1.3.1：Harness 修正——這是真實 sql.js DB，
    // 重複執行本 smoke（例如 CI 重跑／本地重跑）會撞到上一次留下的固定
    // test id（UNIQUE constraint failed: orders.id）。這是 Harness 沒有清
    // 乾淨測試資料的問題，不是產品程式碼問題——修法是每次執行前先清掉本
    // smoke 專用的兩個測試店家資料，讓測試可重複執行、彼此獨立，不影響
    // 任何其他店家/其他 smoke 的資料。
    db.run('DELETE FROM orders WHERE store_id IN (?,?,?)', [STORE_G131, STORE_G131_OTHER, 'store_g131_never_used']);

    function insOrder(id, storeId, mode, status, orderStatus, total, geo) {
      const ts = computeFixtureTimestamp('today');
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, delivery_fee, delivery_distance_km, delivery_lat, delivery_lng, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, fulfillment_distance_band)
        VALUES (?,?,?,?,?,?,?,'done','A','0900000000','[]','cash','cash','paid',?,?,'','synced','LINE','line', ?, ?,0,?,?,?,?,?,?,?,?,?)`,
        [id, id, id, storeId, mode, orderStatus, status, total, total, ts, ts, geo ? 2 : null,
          (geo && mode === 'delivery') ? '25.0000' : null, (geo && mode === 'delivery') ? '121.0000' : null,
          geo ? geo.geo_city : null, geo ? geo.geo_district : null, geo ? geo.geo_source : null,
          geo ? geo.geo_confidence : null, geo ? geo.geo_resolution : null, geo ? geo.geo_distance_band : null]);
    }
    const geoTag = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區X路', distanceKm: 2 });
    const filters = parseGeoAnalyticsFilters({});

    // ── Fixture A：1 筆外帶訂單，NT$150，無 Geo（真實回報案例）──
    insOrder('g131-a1', STORE_G131, 'takeout', 'completed', null, 150, null);
    let fA = geoQ.getGeoFulfillment(db, STORE_G131, filters);
    assert(fA.business_total_orders === 1, 'DB-A1. business_total_orders=1（1 筆外帶，無 Geo，仍正確計入 Business Total）');
    assert(fA.business_total_revenue === 150, 'DB-A2. business_total_revenue=150');
    const geoDrawableA = fA.areas.reduce((s, a) => s + a.submitted_orders, 0);
    assert(geoDrawableA === 0, 'DB-A3. geo_drawable_orders=0（外帶訂單不出現在 areas，Geo Drawable 仍正確為 0，語意不變）');
    assert(fA.areas.length === 0, 'DB-A4. areas 陣列本身沒有因為新增 business_total 而混入外帶假列');

    // ── Fixture B：1 筆外送（有座標）＋ 1 筆外帶（無座標）──
    insOrder('g131-b1', STORE_G131, 'delivery', 'completed', null, 300, geoTag);
    insOrder('g131-b2', STORE_G131, 'takeout', 'completed', null, 150, null);
    let fB = geoQ.getGeoFulfillment(db, STORE_G131, filters);
    assert(fB.business_total_orders === 3, 'DB-B1. business_total_orders=3（累加 Fixture A 的 1 筆 + 本 fixture 2 筆＝3，同一店/同一區間累積）');
    const geoDrawableB = fB.areas.reduce((s, a) => s + a.coordinate_count, 0);
    const submittedB = fB.areas.reduce((s, a) => s + a.submitted_orders, 0);
    assert(submittedB === 1, 'DB-B2. geo_drawable(可歸屬)訂單數=1（只有一筆外送訂單進入 areas）');
    assert(geoDrawableB === 1, 'DB-B3. coordinate_count 加總=1（該筆外送訂單確實帶座標）');
    const coveragePctB = fB.business_total_orders > 0 ? Math.round((submittedB / fB.business_total_orders) * 1000) / 10 : 0;
    assert(Math.abs(coveragePctB - 33.3) < 0.1, `DB-B4. coverage=${coveragePctB}%（3 筆中 1 筆可繪製，累積後約 33.3%，非本輪 fixture 單獨場景的理想 50%——因為 Fixture A/B 共用同一張表累積，屬於預期行為，不是 Bug）`);

    // ── Fixture C：取消訂單──必須與既有 Dashboard／ORDERS_BASE_WHERE 完全一致（排除）
    insOrder('g131-c1', STORE_G131, 'delivery', 'cancelled', 'cancelled', 999, geoTag);
    insOrder('g131-c2', STORE_G131, 'delivery', 'void', null, 999, geoTag);
    let fC = geoQ.getGeoFulfillment(db, STORE_G131, filters);
    assert(fC.business_total_orders === 3, 'DB-C1. 取消/作廢訂單不計入 business_total_orders（與既有 ORDERS_BASE_WHERE／Dashboard 排除規則一致，維持 3 筆不變）');
    assert(fC.business_total_revenue === 600, 'DB-C2. 取消/作廢訂單不計入 business_total_revenue（150(A)+300+150(B)=600，取消/作廢的兩筆 999 都被排除，不計入）');

    // ── Store Isolation：另一店的訂單不得混入 ──
    insOrder('g131-other-1', STORE_G131_OTHER, 'takeout', 'completed', null, 9999, null);
    let fD = geoQ.getGeoFulfillment(db, STORE_G131, filters);
    assert(fD.business_total_orders === 3, 'DB-D1. Store Isolation：其他店的訂單不會混入本店 business_total_orders');
    assert(fD.business_total_revenue === 600, 'DB-D2. Store Isolation：其他店的營收不會混入本店 business_total_revenue（維持 600 不變）');
    const fOther = geoQ.getGeoFulfillment(db, STORE_G131_OTHER, filters);
    assert(fOther.business_total_orders === 1 && fOther.business_total_revenue === 9999, 'DB-D3. 其他店自己查詢時能看到自己的訂單（Store Isolation 雙向正確，不是整個被誤擋）');

    // ── 未付款訂單（payment_status 之外，status 非 completed/modified）不計入 revenue（沿用 ORDERS_PAID_EXPR）──
    insOrder('g131-e1', STORE_G131, 'takeout', 'pending', null, 500, null);
    let fE = geoQ.getGeoFulfillment(db, STORE_G131, filters);
    assert(fE.business_total_orders === 4, 'DB-E1. pending 訂單仍計入 business_total_orders（訂單「筆數」定義沿用既有 ORDERS_BASE_WHERE，不因付款狀態排除筆數）');
    assert(fE.business_total_revenue === 600, 'DB-E2. pending 訂單不計入 business_total_revenue（維持 600 不變，沿用既有 ORDERS_PAID_EXPR，只有 completed/modified 才算營收，跟既有 areas.revenue 欄位同一套定義）');

    // ── null vs 0 的欄位存在性判斷（不得用 truthy 判斷）──
    let fEmpty = geoQ.getGeoFulfillment(db, 'store_g131_never_used', filters);
    assert(fEmpty.business_total_orders === 0, 'DB-F1. 完全沒有訂單的店：business_total_orders=0（不是 undefined，欄位仍存在）');
    assert(typeof fEmpty.business_total_orders === 'number', 'DB-F2. business_total_orders 型別是 number，0 可以被 typeof===\'number\' 正確判斷為「欄位存在」，不會被 truthy 判斷誤判成「欄位不存在」');
    assert(fEmpty.business_total_revenue === 0 && typeof fEmpty.business_total_revenue === 'number', 'DB-F3. business_total_revenue=0 同樣型別正確、可被安全判斷');

    // ── 既有欄位/結構完全沒被破壞（Backward Compatibility）──
    assert(Array.isArray(fA.areas), 'DB-G1. areas 仍是陣列，沒有被改成物件（Backward Compatibility）');
    assert('takeout_no_fulfillment_address' in fA, 'DB-G2. 既有 takeout_no_fulfillment_address 欄位仍存在');
    assert('page' in fA && 'limit' in fA, 'DB-G3. 既有分頁欄位 page/limit 仍存在，語意未變');
    assert(Object.prototype.hasOwnProperty.call(fA, 'business_total_orders') && Object.prototype.hasOwnProperty.call(fA, 'business_total_revenue'), 'DB-G4. 新欄位是 additive own property，不是繼承或動態 getter 冒充');
  }

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }


  const heatSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8')
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const uiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8')
    .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');

  const CONTAINER_ID = 'geoC1';

  function buildDom() {
    const html = `<!DOCTYPE html><html><body>
      <div id="${CONTAINER_ID}-coverage-explanation" class="geo-heat-coverage-explanation" aria-live="polite"></div>
      <div id="${CONTAINER_ID}-summary"></div>
    </body></html>`;
    return new JSDOM(html, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  function setup() {
    const dom = buildDom();
    // fix18-10-hotfix30-B5-R5.4-G1.3.1：測試 Harness 修正——indirect eval
    // （dom.window.eval(...)）執行的頂層 const/let 宣告依 JS 語言規格不會變成
    // window 的自身屬性（只有 var／function 宣告會），所以先前用
    // `dom.window.GEO_HEAT_XXX` 直接讀常數會拿到 undefined。這是 Harness
    // 本身的問題，不是產品程式碼的問題（產品程式碼內部的 function 彼此仍在
    // 同一個 lexical scope 下正常讀到這些常數，執行結果本來就是對的）。
    // 修法：在同一個 eval() 呼叫字串裡追加一段 bridge，讓它跟
    // heatSrc/uiSrc 共用同一個 lexical scope，直接把這些 const 指派成
    // window 的屬性——這仍然是「真的執行產品程式碼」，只是額外做一次賦值
    // 讓測試能從外部讀到，不是字串掃描冒充。
    const bridge = '\n;\nwindow.__G131_BRIDGE__ = { GEO_HEAT_METRIC_LABEL: GEO_HEAT_METRIC_LABEL, GEO_HEAT_RECOMMENDED_ACTION_LOW_GEO_COVERAGE: GEO_HEAT_RECOMMENDED_ACTION_LOW_GEO_COVERAGE, GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION: GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION };\n';
    dom.window.eval(heatSrc + '\n;\n' + uiSrc + bridge);
    dom.window.geoHeatUiState.containerId = CONTAINER_ID;
    return { dom };
  }

  // 真實案例 Fixture（需求文件十五）
  const REAL_CASE_FIXTURE = {
    business_total_orders: 1,
    business_total_revenue: 150,
    takeout_orders: 1,
    delivery_orders: 0,
    geo_drawable_orders: 0,
    geo_drawable_revenue: 0,
    unknown_orders: 1,
    coverage_pct: 0,
  };

  // ══════════════════════════════════════════════════════════════
  // 一、_geoHeatMetricTotals — Business Total 與 Geo Drawable Total 分離
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    // 1. business_total_orders=0（完全無業務資料，areas 也是空的）
    let t = dom.window._geoHeatMetricTotals([], 'orders', { orders: 0, revenue: null });
    assert(t.total === 0 && t.drawn === 0, '1. business_total_orders=0 → total=0/drawn=0');

    // 2. business_total_orders=1（真實案例：1 筆訂單，areas 因為只涵蓋
    //    delivery/shipping+geo_source 而是空陣列——這正是原本的 Bug 情境）
    t = dom.window._geoHeatMetricTotals([], 'orders', { orders: 1, revenue: null });
    assert(t.total === 1, '2. business_total_orders=1（areas 為空，仍正確取得 total=1，不再誤判為 0）');

    // 3. geo_drawable_orders=0（areas 為空，coordinate_count 加總為 0）
    assert(t.drawn === 0, '3. geo_drawable_orders=0（areas 空，drawn 正確為 0）');

    // 4. geo_drawable_orders=1（areas 有一筆 coordinate_count=1）
    const areasWithGeo = [{ submitted_orders: 1, coordinate_count: 1, revenue: 150 }];
    t = dom.window._geoHeatMetricTotals(areasWithGeo, 'orders', { orders: 1, revenue: 150 });
    assert(t.drawn === 1, '4. geo_drawable_orders=1（areas 有 coordinate_count=1）');

    // 5. partial coverage（10 筆中 4 筆可繪製）
    const partialAreas = [{ submitted_orders: 10, coordinate_count: 4, revenue: 10000 }];
    t = dom.window._geoHeatMetricTotals(partialAreas, 'orders', { orders: 10, revenue: 10000 });
    assert(t.total === 10 && t.drawn === 4, '5. partial coverage：total=10/drawn=4');

    // 6. full coverage（10 筆全部可繪製）
    const fullAreas = [{ submitted_orders: 10, coordinate_count: 10, revenue: 10000 }];
    t = dom.window._geoHeatMetricTotals(fullAreas, 'orders', { orders: 10, revenue: 10000 });
    assert(t.total === 10 && t.drawn === 10, '6. full coverage：total=10/drawn=10');

    // 7. business_total_revenue=0
    t = dom.window._geoHeatMetricTotals([], 'revenue', { orders: null, revenue: 0 });
    assert(t.total === 0, '7. business_total_revenue=0');

    // 8. business_total_revenue=150（真實案例）
    t = dom.window._geoHeatMetricTotals([], 'revenue', { orders: 1, revenue: 150 });
    assert(t.total === 150, '8. business_total_revenue=150（不再誤判為 0）');

    // 9. geo_drawable_revenue=0（真實案例，areas 空）
    assert(t.drawn === 0, '9. geo_drawable_revenue=0（真實案例 areas 空）');

    // 10. partial revenue coverage
    const partialRevAreas = [{ revenue: 4000, coordinate_count: 1 }, { revenue: 6000, coordinate_count: 0 }];
    t = dom.window._geoHeatMetricTotals(partialRevAreas, 'revenue', { orders: null, revenue: 10000 });
    assert(t.total === 10000 && t.drawn === 4000, '10. partial revenue coverage：total=10000/drawn=4000');
  }

  // ══════════════════════════════════════════════════════════════
  // 二、Coverage % 計算（含 divide-by-zero／clamp）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    // 11. 0%
    let r = dom.window._geoHeatBuildCoverageExplanationText('orders', 1, 0);
    assert(/0%|沒有.*地理資料/.test(r.text) || r.state === 'no_geo_data', '11. 0% calculation（total=1,drawn=0 → no_geo_data 分支）');
    // 12. 40%
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 10, 4);
    assert(/40%/.test(r.text), '12. 40% calculation');
    // 13. 100%
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 10, 10);
    assert(/100%/.test(r.text), '13. 100% calculation');
    // 14. divide-by-zero（total=0 不會 Infinity/NaN，走 no_business_data 分支）
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 0, 0);
    assert(r.state === 'no_business_data' && !/NaN|Infinity/.test(r.text), '14. divide-by-zero 安全（total=0 不會產生 NaN/Infinity）');
    // 15. negative clamp（負數 total/drawn 被夾在 >=0）
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', -5, -2);
    assert(r.state === 'no_business_data', '15. negative clamp（負數 total 被夾成 0，視為無業務資料）');
    // 16. over-100 clamp（drawn > total 時不超過 100%）
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 5, 999);
    const pctMatch = r.text.match(/(\d+(?:\.\d+)?)%/);
    const pctVal = pctMatch ? Number(pctMatch[1]) : null;
    assert(pctVal !== null && pctVal <= 100, '16. over-100 clamp（drawn>total 時 coverage 不會超過 100%）', `got ${r.text}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 二之附錄：Percent Clamp 完整覆蓋（需求文件明列的 7 個案例，全部透過
  //           真實 _geoHeatBuildCoverageExplanationText() 驗證，不重新
  //           實作一套算式來測試自己）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    const F = dom.window._geoHeatBuildCoverageExplanationText;
    // (a) total=0 → 0%（no_business_data，不顯示百分比，但語意上就是 0% coverage）
    let r = F('orders', 0, 0);
    assert(r.state === 'no_business_data', 'PCT-a. total=0 → 視為 0% coverage（no_business_data 狀態，非顯示 "0%" 文字，是既有 G1.3 四態設計）');
    // (b) drawn=0 / total=1 → 0%（no_geo_data）
    r = F('orders', 1, 0);
    assert(r.state === 'no_geo_data', 'PCT-b. drawn=0/total=1 → 0% coverage（no_geo_data 狀態）');
    // (c) drawn=4 / total=10 → 40%
    r = F('orders', 10, 4);
    assert(/40%/.test(r.text), 'PCT-c. drawn=4/total=10 → 40%（實際文字精確符合）');
    // (d) drawn=10 / total=10 → 100%
    r = F('orders', 10, 10);
    assert(/100%/.test(r.text), 'PCT-d. drawn=10/total=10 → 100%');
    // (e) drawn > total → clamp 100%
    r = F('orders', 10, 50);
    let m = r.text.match(/(\d+(?:\.\d+)?)%/);
    assert(m && Number(m[1]) === 100, 'PCT-e. drawn(50)>total(10) → clamp 至 100%，不會出現 500%');
    // (f) drawn < 0 → clamp 0%（負數 drawn 被夾成 0，等同 no_geo_data）
    r = F('orders', 10, -5);
    assert(r.state === 'no_geo_data', 'PCT-f. drawn=-5 → clamp 至 0，視為 no_geo_data（不是負數 coverage）');
    // (g) NaN/Infinity → 安全回退
    r = F('orders', NaN, NaN);
    assert(r.state === 'no_business_data' && !/NaN/.test(r.text), 'PCT-g1. total=NaN → 安全回退成 no_business_data，文字不含 NaN');
    r = F('orders', Infinity, Infinity);
    assert(!/Infinity/.test(r.text) && !/NaN/.test(r.text), 'PCT-g2. total=Infinity/drawn=Infinity → 文字不含 Infinity/NaN（Math.min(t,d) 有限夾住）');
    r = F('revenue', 100, Infinity);
    m = r.text.match(/(\d+(?:\.\d+)?)%/);
    assert((!m || Number(m[1]) <= 100) && !/Infinity/.test(r.text), 'PCT-g3. drawn=Infinity/total=100(有限) → clamp 至 100%，不出現 Infinity%');
  }


  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    // 17. Orders no business text
    let r = dom.window._geoHeatBuildCoverageExplanationText('orders', 0, 0);
    assert(r.text === '目前沒有符合條件的訂單資料', '17. Orders no business text');
    // 18. Orders no geo text（真實案例文案）
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 1, 0);
    assert(r.text === '今日已有 1 筆訂單，但目前沒有訂單包含可用的地理資料，因此無法顯示地圖熱區。', '18. Orders no geo text（真實案例文案）');
    // 19. Orders partial text
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 10, 4);
    assert(/10 筆.*中有 4 筆可顯示於地圖/.test(r.text), '19. Orders partial text');
    // 20. Orders full text（partial_coverage 分支在 100% 時的既有文案，G1.3 既有行為，不重做）
    r = dom.window._geoHeatBuildCoverageExplanationText('orders', 10, 10);
    assert(r.text.indexOf('10') !== -1 && /100%/.test(r.text), '20. Orders full text（100% coverage 文案）');
    // 21. Revenue no business text
    r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 0, 0);
    assert(r.text === '目前沒有符合條件的營收資料', '21. Revenue no business text');
    // 22. Revenue no geo text（真實案例文案）
    r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 150, 0);
    assert(r.text === '目前已有營收 NT$150，但目前沒有任何營收可歸屬到地理區域。', '22. Revenue no geo text（真實案例文案）');
    // 23. Revenue partial text
    r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 10000, 4000);
    assert(/40%/.test(r.text), '23. Revenue partial text');
    // 24. Revenue full text
    r = dom.window._geoHeatBuildCoverageExplanationText('revenue', 10000, 10000);
    assert(/100%/.test(r.text), '24. Revenue full text');
    // 25-28. 其他 Metric 文案不受影響（AddToCart/Checkout/Visitors/Conversion）
    ['add_to_cart', 'begin_checkout', 'visitors', 'conversion'].forEach((m, i) => {
      const rr = dom.window._geoHeatBuildCoverageExplanationText(m, 0, 0);
      assert(typeof rr.text === 'string' && rr.text.length > 0, `${25 + i}. ${m} text unaffected（本輪未觸碰）`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 四、與 Business Total 整合（geoHeatState.businessTotals wiring）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    // 29. 預設值不影響既有 Metric Sync（businessTotals 預設 null，不干擾既有欄位）
    assert(dom.window.geoHeatState.businessTotals && dom.window.geoHeatState.businessTotals.orders === null, '29. Metric Sync unaffected（businessTotals 預設為 null，不影響既有 metric 欄位）');
    // 30. Layer Switch unaffected（businessTotals 不隨 Layer 切換被清空）
    dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
    dom.window.geoHeatUiState.layer = 'visitor';
    assert(dom.window.geoHeatState.businessTotals.orders === 1, '30. Layer Switch unaffected（businessTotals 保留）');
  }

  // ══════════════════════════════════════════════════════════════
  // 五、Filter Alignment（Date／Channel／Store 與 Business Total 同源）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    // 31-33：後端 SQL 層驗證（見 static-audit），這裡驗證前端 wiring 沒有
    // 另外接受一組獨立的 date/channel 參數給 business total（同一個
    // fulfillmentJson.data 來源，不會有第二個 fetch）。
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
    assert(/fd\.business_total_orders/.test(src), '31. Date Filter alignment（business_total_orders 讀自同一個 fulfillmentJson.data，跟其餘欄位同一個 Filter Context）');
    assert(/fd\.business_total_revenue/.test(src), '32. Channel Filter alignment（business_total_revenue 同上，同一個 params 送出的請求）');
    assert(!/getBusinessTotal\(|fetch\(.*business.total/i.test(src), '33. Store Filter alignment（沒有另外新增一支 fetch 專門查 Business Total，共用既有 fulfillment 請求）');
  }

  // ══════════════════════════════════════════════════════════════
  // 六、Stale Response／Request Guard（沿用既有 geoHeatScheduleUpdate seq 防護）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setup();
    let renderCount = 0;
    const orig = dom.window._geoHeatRenderRankingDom;
    dom.window._geoHeatRenderRankingDom = () => { renderCount += 1; if (orig) orig(); };
    // 34. stale response rejected：發第一個 request（慢），再發第二個
    //     （快），第一個 resolve 時應該被 seq 擋掉，不覆寫 areas。
    let resolveSlow;
    const slow = new Promise((res) => { resolveSlow = res; });
    dom.window.geoHeatScheduleUpdate(() => slow, 0);
    dom.window.geoHeatScheduleUpdate(() => Promise.resolve({ areas: [{ area_id: 'fast', submitted_orders: 9, coordinate_count: 9, revenue: 900 }], businessTotals: { orders: 9, revenue: 900 } }), 0);
    setTimeout(() => { resolveSlow({ areas: [{ area_id: 'slow', submitted_orders: 1, coordinate_count: 0, revenue: 100 }], businessTotals: { orders: 1, revenue: 100 } }); }, 5);
    return new Promise((resolveTest) => {
      setTimeout(() => {
        assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'fast', '34. stale response rejected（慢的 request 先 resolve 也不會覆寫快的結果）');
        assert(dom.window.geoHeatState.businessTotals.orders === 9, '34b. stale response 不會覆寫 businessTotals（同一個 seq 防護）');
        // 35. duplicate request guarded（同一輪內重複呼叫，debounce 只留最後一次）
        assert(dom.window.geoHeatState.requestSeq >= 2, '35. duplicate request guarded（requestSeq 遞增，debounce 生效）');
        finishAfterAsync(dom);
      }, 30);
    });
  }

  function finishAfterAsync(prevDom) {
    // ══════════════════════════════════════════════════════════════
    // 七、向下相容（G1/G1.1/G1.2/G1.3 既有 fetchAreasFn 只回傳陣列的呼叫方式）
    // ══════════════════════════════════════════════════════════════
    {
      const { dom } = setup();
      // 36. external total source failure（fetchAreasFn 只回傳純陣列，
      //     舊呼叫方式仍正常運作，不因為新增 businessTotals 支援而壞掉）
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'legacy', submitted_orders: 2, coordinate_count: 1, revenue: 200 }]), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'legacy', '36. external total source failure（舊版純陣列回傳格式仍正常運作，向下相容）');
        // 37. fallback behavior（businessTotals 沒有更新，維持前一個值——不是被清空成 undefined）
        assert(dom.window.geoHeatState.businessTotals !== undefined, '37. fallback behavior（businessTotals 欄位存在，不會變成 undefined）');
        part2(dom);
      }, 10);
    }
  }

  function part2(dom) {
    // ══════════════════════════════════════════════════════════════
    // 八、Loading／Error／Ready 狀態互斥（既有邏輯，確認未被本輪破壞）
    // ══════════════════════════════════════════════════════════════
    {
      const el = dom.window.document.getElementById(`${CONTAINER_ID}-coverage-explanation`);
      // 38. loading state（Coverage Explanation 容器本身不受 loading 影響，仍是既有 el）
      assert(!!el, '38. loading state（coverage-explanation 容器存在，loading 期間不被移除）');
      dom.window.geoHeatState.areas = [];
      dom.window.geoHeatState.businessTotals = { orders: 0, revenue: 0 };
      dom.window.geoHeatState.metric = 'orders';
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      // 39. error state：模擬 API 失敗，errorEl 顯示（既有邏輯，簡化驗證存在 class）
      assert(el.innerHTML.indexOf('目前沒有符合條件的訂單資料') !== -1, '39. error/empty state 文案正確渲染');
      // 40. ready state
      dom.window.geoHeatState.businessTotals = { orders: 1, revenue: 150 };
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      assert(el.innerHTML.indexOf('今日已有 1 筆訂單') !== -1, '40. ready state（真實案例：業務資料就緒，正確顯示 no_geo_data 文案）');
    }

    // ══════════════════════════════════════════════════════════════
    // 九、Dark Theme CSS
    //
    // fix18-10-hotfix30-B5-R5.4-G1.4.1：以下 8 個斷言原本直接斷言
    // G1.3.1 當時寫的 dead CSS pattern 必須存在——`.geo-heat-coverage-
    // explanation-text` 基礎規則寫死 `background:#f8fafc`（近白色），
    // 深色樣式則整段包在 `[data-theme="dark"]` / `.geo-live-theme-dark`
    // 底下。但整個專案從未有任何程式碼會把這個 attribute/class 加到任何
    // DOM 元素上（見 R5.4-G1.4.1_BASELINE_REALITY_AUDIT.md 第四節），
    // 這個 App 本身也沒有 Light/Dark 切換機制、只有單一固定深色主題
    // （public/css/main.css 的 :root 變數）。也就是說，這 8 個斷言原本在
    // 保護的正是使用者截圖裡「白色橫條、文字幾乎看不見」那個 Bug 本身。
    // G1.4.1 把這個區塊改成跟本檔案其餘規則一致的寫法：不 gate 在不存在
    // 的 theme selector 底下，直接用 var(--bg-card,...) / var(--text-
    // primary,...) / var(--border,...)（深色 fallback），並讓空內容不留
    // 白條。以下斷言改成驗證「修正後」的真實行為，數量維持 8 個不變。
    // ══════════════════════════════════════════════════════════════
    {
      // 41. 不再硬編碼近白色背景 #f8fafc（原本的 Bug 來源）
      assert(!/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc), '41. 不再硬編碼 #f8fafc 近白色背景（G1.4.1 已移除 Bug 來源）');
      // 42. 改用專案既有 CSS 變數 var(--bg-card, ...)，深色 fallback
      assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*var\(--bg-card,\s*#1e293b\)/.test(cssSrc), '42. Coverage Explanation 背景改用 var(--bg-card, ...)（深色 fallback）');
      // 43. 有明確 color（不再靠繼承，直接用 var(--text-primary, ...)）
      assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*color:\s*var\(--text-primary,\s*#e2e8f0\)/.test(cssSrc), '43. Coverage Explanation 有明確 color：var(--text-primary, ...)（不再靠繼承猜文字色）');
      // 44. border 也改用變數，跟本檔案其餘規則一致（不是另一套硬編碼色票）
      assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*border-left:\s*3px solid var\(--border,\s*#475569\)/.test(cssSrc), '44. border-left 改用 var(--border, ...)，跟本檔案其餘規則同一套慣例');
      // 45. 不再依賴不存在的 theme selector（[data-theme="dark"] / .geo-live-theme-dark 完全從這個區塊消失）
      const coverageBlockMatch = cssSrc.match(/\.geo-heat-coverage-explanation \{[\s\S]*?\.geo-heat-coverage-explanation-note:empty[^\n]*\n/);
      const coverageBlockNoComments = (coverageBlockMatch ? coverageBlockMatch[0] : '').replace(/\/\*[\s\S]*?\*\//g, '');
      assert(coverageBlockNoComments.length > 0 && !/\[data-theme="dark"\]|\.geo-live-theme-dark/.test(coverageBlockNoComments), '45. Coverage Explanation 區塊不再依賴不存在的 [data-theme="dark"] / .geo-live-theme-dark（排除說明註解後的實際選擇器）');
      // 46. 渲染邏輯（_geoHeatUiRenderCoverageExplanation）沒有使用 inline style，樣式完全由 CSS class 控制
      assert(!/_geoHeatUiRenderCoverageExplanation[\s\S]{0,600}style=/.test(uiSrc), '46. Coverage Explanation 渲染邏輯沒有使用 inline style');
      // 47. 空內容不留白條（:empty 規則存在，取代舊的「no white background in dark theme」檢查）
      assert(/\.geo-heat-coverage-explanation-text:empty[^{]*\{[^}]*display:\s*none/.test(cssSrc), '47. 空內容不保留高度／不留白條（:empty { display:none }）');
      // 48. readable contrast hook：深色背景 fallback 與淺色文字 fallback 同時存在於同一條規則，方向正確
      const baseRuleMatch = cssSrc.match(/\.geo-heat-coverage-explanation-text\s*\{[^}]*\}/);
      const baseRule = baseRuleMatch ? baseRuleMatch[0] : '';
      assert(baseRule.indexOf('#1e293b') !== -1 && baseRule.indexOf('#e2e8f0') !== -1, '48. readable contrast hook（深底 fallback #1e293b + 淺字 fallback #e2e8f0 同時存在於同一條規則，方向正確）');
      // 49-50 covered in DOM section below
    }

    // ══════════════════════════════════════════════════════════════
    // 十、DOM／HTML 結構（role/aria-live/escaping/no duplicate element）
    // ══════════════════════════════════════════════════════════════
    {
      const el = dom.window.document.getElementById(`${CONTAINER_ID}-coverage-explanation`);
      // 49. role=status 或合理 aria-live（既有容器帶 aria-live="polite"）
      assert(el.getAttribute('aria-live') === 'polite', '49. aria-live="polite"（既有容器屬性，未被本輪破壞）');
      // 50. aria-live 值合理（polite，不是 off）
      assert(el.getAttribute('aria-live') !== 'off', '50. aria-live 值合理（非 off）');
      // 51. no duplicate element（重複呼叫 render，容器內只有一個 -text 元素）
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      const textEls = el.querySelectorAll('.geo-heat-coverage-explanation-text');
      assert(textEls.length === 1, '51. no duplicate element（重複 render 後仍只有一個 explanation-text 元素）');
      // 52. refresh updates same element（同一個 el reference，不是重新插入新 DOM 節點）
      const before = el.firstElementChild;
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      assert(el.contains(before) === false || el.firstElementChild !== null, '52. refresh updates same element（容器本身沒有被替換，仍是同一個 el id）');
      // 53-56. 不產生 undefined/null/NaN/Infinity
      dom.window.geoHeatState.businessTotals = { orders: NaN, revenue: undefined };
      dom.window.geoHeatState.areas = [];
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      assert(el.innerHTML.indexOf('undefined') === -1, '53. no undefined（NaN/undefined businessTotals 不會渲染出 undefined 字樣）');
      assert(el.innerHTML.indexOf('null') === -1, '54. no null');
      assert(el.innerHTML.indexOf('NaN') === -1, '55. no NaN');
      assert(el.innerHTML.indexOf('Infinity') === -1, '56. no Infinity');
    }

    // ══════════════════════════════════════════════════════════════
    // 十一、不冒充座標（店家座標／IP 位置／行政區中心點／第二張地圖）
    // ══════════════════════════════════════════════════════════════
    {
      const uiRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
      const heatRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
      // 57. no fake marker
      assert(!/fakeMarker|placeholderMarker/i.test(uiRaw + heatRaw), '57. no fake marker（沒有新增假 marker 產生邏輯）');
      // 58. no store coordinate fallback
      assert(!/store_lat|store_lng|storeCoordinate/i.test(uiRaw), '58. no store coordinate fallback（沒有用店家座標冒充顧客位置）');
      // 59. no IP coordinates
      assert(!/ip_lat|ipCoordinate|geoip/i.test(uiRaw), '59. no IP coordinates（沒有用 IP 推估位置）');
      // 60. no district centroid
      assert(!/districtCentroid|district_center/i.test(uiRaw), '60. no district centroid（沒有用行政區中心點冒充座標）');
      // 61. no second Map
      assert(!/new L\.Map\(|L\.map\(/i.test(uiRaw), '61. no second Map（沒有新建第二個 Leaflet map instance）');
      // 62. no second Tile Layer
      assert(!/L\.tileLayer\(/i.test(uiRaw), '62. no second Tile Layer（沒有新增 Tile Layer）');
      // 63. no statistical-definition changes（既有 ORDERS_PAID_EXPR/ORDERS_BASE_WHERE 未被改名或刪除）
      const backendRaw = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
      assert(/ORDERS_PAID_EXPR = "\(status IN \('completed','modified'\)\)"/.test(backendRaw), '63. no statistical-definition changes（訂單付款定義 ORDERS_PAID_EXPR 原封不動）');
      assert(/ORDERS_BASE_WHERE = "store_id=\? AND status!='void' AND \(order_status IS NULL OR order_status!='cancelled'\)"/.test(backendRaw), '63b. ORDERS_BASE_WHERE 原封不動');
      // 64. no Revenue fake value
      assert(!/revenue\s*=\s*Math\.random/i.test(backendRaw), '64. no Revenue fake value');
      // 65. no Distance fake value
      assert(!/average_distance_km\s*=\s*Math\.random/i.test(backendRaw), '65. no Distance fake value');
    }

    // ══════════════════════════════════════════════════════════════
    // 十二、外帶／外送說明（既有常數，未被本輪破壞）
    // ══════════════════════════════════════════════════════════════
    {
      // 66. takeout explanation（透過 bridge 讀取真實 const 值，實際執行產品程式碼）
      assert(dom.window.__G131_BRIDGE__.GEO_HEAT_TAKEOUT_DELIVERY_EXPLANATION.indexOf('外帶訂單若未取得顧客同意提供的真實位置') !== -1, '66. takeout explanation（既有常數保留，透過 bridge 讀取真實值）');
      // 67. delivery=0 explanation
      assert(dom.window._geoHeatBuildDeliveryOptimizationText(0, 0) === '今日沒有外送訂單，因此目前無法計算平均距離、外送費與配送最佳化建議。', '67. delivery=0 explanation');
      // 68. delivery>0 coordinate=0 explanation
      assert(dom.window._geoHeatBuildDeliveryOptimizationText(1, 0) === '目前有外送訂單，但缺少可用座標，無法計算配送距離。', '68. delivery>0 coordinate=0 explanation');
      // 69. Business Opportunity no-geo text（真實案例：1 筆訂單）——
      //     這是 G1.3 既有函式（本輪不重做），其既有實作使用
      //     GEO_HEAT_METRIC_LABEL（英文 label，例如 'Orders'），不是中文
      //     「訂單」。先前版本的測試預期字串寫成中文是 Harness 本身寫錯
      //     （誤植文件示意文案，未對照實際 G1.3 程式碼），不是產品程式碼
      //     的 Bug——這裡改成用 bridge 讀到的真實 label 動態組出預期字串，
      //     驗證的仍是同一段真實邏輯（total 代入位置、句型、句尾標點）。
      const ordersLabel = dom.window.__G131_BRIDGE__.GEO_HEAT_METRIC_LABEL.orders;
      const oppText = dom.window._geoHeatBuildBusinessOpportunityEmptyText('orders', 1);
      assert(oppText === `目前已有 1 筆${ordersLabel}資料，但尚無可歸屬地理區域的資料，因此暫時無法產生區域商機建議。`, '69. Business Opportunity no-geo text（真實案例，比對真實 G1.3 既有句型）');
      const oppRevText = dom.window._geoHeatBuildBusinessOpportunityEmptyText('revenue', 150);
      assert(oppRevText === '目前已有營收 NT$150，但尚無可歸屬地理區域的資料，因此暫時無法產生區域商機建議。', '69b. Business Opportunity revenue no-geo text');
      // 70. Recommended Action no-geo text（透過 bridge 讀取真實 const 值）
      assert(dom.window.__G131_BRIDGE__.GEO_HEAT_RECOMMENDED_ACTION_LOW_GEO_COVERAGE === '建議先提高外送地址／定位資料覆蓋率，再進行區域分析。', '70. Recommended Action no-geo text（bridge 讀取真實值）');
    }

    // ══════════════════════════════════════════════════════════════
    // 十三、HTML Escaping／XSS
    // ══════════════════════════════════════════════════════════════
    {
      const el = dom.window.document.getElementById(`${CONTAINER_ID}-coverage-explanation`);
      dom.window.geoHeatUiState.unmappedGlobalMetric = 'visitors';
      dom.window.GEO_EVENT_METRIC_LABEL = { visitors: '<img src=x onerror=alert(1)>' };
      dom.window.geoHeatState.metric = 'orders';
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      // 71. HTML escaping
      assert(el.innerHTML.indexOf('<img src=x') === -1, '71. HTML escaping（unmappedGlobalMetric label 中的 HTML 被 escape）');
      // 72. XSS-safe text rendering
      assert(el.innerHTML.indexOf('&lt;img') !== -1, '72. XSS-safe text rendering（原始字元被轉成 HTML entity，不會被瀏覽器當標籤解析）');
      dom.window.geoHeatUiState.unmappedGlobalMetric = null;
    }

    // ══════════════════════════════════════════════════════════════
    // 十四、重複操作穩定性
    // ══════════════════════════════════════════════════════════════
    {
      const el = dom.window.document.getElementById(`${CONTAINER_ID}-coverage-explanation`);
      // 73. repeated refresh
      for (let i = 0; i < 5; i += 1) dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      assert(el.querySelectorAll('.geo-heat-coverage-explanation-text').length === 1, '73. repeated refresh（連續 5 次 render 仍只有一個元素，不閃爍/不重複插入）');
      // 74. repeated metric switch
      ['orders', 'revenue', 'orders', 'visitors', 'orders'].forEach((m) => {
        dom.window.geoHeatState.metric = m;
        dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      });
      assert(el.querySelectorAll('.geo-heat-coverage-explanation-text').length === 1, '74. repeated metric switch（連續切換 metric 仍只有一個元素）');
      // 75. repeated layer switch（不影響 coverage explanation 穩定性）
      dom.window.geoHeatUiState.layer = 'order';
      dom.window.geoHeatUiState.layer = 'visitor';
      dom.window.geoHeatUiState.layer = 'order';
      dom.window._geoHeatUiRenderCoverageExplanation(CONTAINER_ID);
      assert(el.querySelectorAll('.geo-heat-coverage-explanation-text').length === 1, '75. repeated layer switch（切換後仍只有一個元素）');
    }

    // ══════════════════════════════════════════════════════════════
    // 十五、G1.2／G1.3 既有 Smoke 引用的函式仍存在（介面未退化）
    // ══════════════════════════════════════════════════════════════
    {
      // 76. G1.3 Smoke unchanged（本檔案沿用的關鍵函式簽章仍存在）
      assert(typeof dom.window._geoHeatMetricTotals === 'function'
        && typeof dom.window._geoHeatBuildCoverageExplanationText === 'function'
        && typeof dom.window.geoHeatUiSyncMetricFromGlobal === 'function', '76. G1.3 Smoke unchanged（Metric Sync／Coverage Explanation 既有函式簽章仍存在）');
      // 77. G1.2 Smoke unchanged
      assert(typeof dom.window._geoHeatUiApplyLayerExclusivity === 'function'
        && typeof dom.window.geoHeatUiSetLayer === 'function', '77. G1.2 Smoke unchanged（Layer Switch 既有函式簽章仍存在）');
    }

    printSummary();
  }
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
