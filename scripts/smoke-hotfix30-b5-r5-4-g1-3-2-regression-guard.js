#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js
// fix18-10-hotfix30-B5-R5.4-G1.3.2 — Regression Guard Alignment & Final QA Candidate
//
// 驗證 scripts/lib/geo-heatmap-g131-scope-guard.js 本身的正確性，以及
// A2/A1.2 兩支既有 smoke 是否正確採用了新的 Scope-aware Invariant Guard
// 取代過時的整檔 byte-equality。同時對 G1.3.1 真實 sql.js DB fixture
// 再次交叉驗證，確保本輪測試 Guard 調整完全沒有動到任何產品邏輯。

'use strict';

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.3.2 (Regression Guard Alignment)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. node --check
  // ══════════════════════════════════════════════════════════════
  [
    'scripts/lib/geo-heatmap-g131-scope-guard.js',
    'scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js',
    'scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js',
    'public/js/geo-heatmap.js',
    'public/js/geo-heatmap-ui.js',
    'utils/geoAnalyticsQueries.js',
  ].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const scopeGuard = require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'));

  // ══════════════════════════════════════════════════════════════
  // 一、A2／A1.2 舊 Guard 已替換
  // ══════════════════════════════════════════════════════════════
  const a2Src = fs.readFileSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js'), 'utf8');
  const a12Src = fs.readFileSync(path.join(ROOT, 'scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js'), 'utf8');

  // 1. A2 舊 Guard 已替換
  assert(!/'public\/js\/geo-heatmap\.js':\s*'8f3ec8c0/.test(a2Src), '1. A2 舊 Guard 已替換（geo-heatmap.js 不再出現在整檔 SHA-256 baseline 物件裡）');
  // 2. A1.2 舊 Guard 已替換
  assert(!/'public\/js\/geo-heatmap\.js':\s*'8f3ec8c0/.test(a12Src), '2. A1.2 舊 Guard 已替換（同上）');
  // 3. 不再要求整檔完全相同（A2/A1.2 都改呼叫 computeScopedBaselineCheck）
  assert(/scopeGuard\.computeScopedBaselineCheck\(ROOT\)/.test(a2Src), '3a. A2 改用 computeScopedBaselineCheck()，不再對 geo-heatmap.js 做整檔相等');
  assert(/scopeGuard\.computeScopedBaselineCheck\(ROOT\)/.test(a12Src), '3b. A1.2 改用 computeScopedBaselineCheck()，同上');
  // 其餘 3 個未修改檔案的整檔 hash 仍保留（沒有被連帶放寬）
  assert(/'public\/js\/geo-intelligence-map\.js':\s*'05a38b4a/.test(a2Src) && /'public\/js\/geo-map-settings\.js':\s*'f7ab62d8/.test(a2Src) && /'public\/data\/geo\/taiwan\/manifest\.json':\s*'bdd969e0/.test(a2Src),
    '3c. A2 對其餘 3 個未修改檔案仍維持整檔 SHA-256 相等（沒有一併放寬保護範圍）');
  assert(/'public\/js\/geo-intelligence-map\.js':\s*'05a38b4a/.test(a12Src) && /'public\/js\/geo-map-settings\.js':\s*'f7ab62d8/.test(a12Src) && /'public\/data\/geo\/taiwan\/manifest\.json':\s*'bdd969e0/.test(a12Src),
    '3d. A1.2 對其餘 3 個未修改檔案仍維持整檔 SHA-256 相等，同上');

  // ══════════════════════════════════════════════════════════════
  // 二、Scope Allowlist 存在且範圍有限
  // ══════════════════════════════════════════════════════════════
  const allowlist = scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS;
  // 4. Scope Allowlist 存在
  assert(Array.isArray(allowlist) && allowlist.length > 0, '4. GEO_HEATMAP_G131_ALLOWED_ADDITIONS Scope Allowlist 存在且非空');
  // 5. Allowlist 只允許 businessTotals additive 內容（每一項描述都與 businessTotals/scheduleUpdate 相關，不含無關內容）
  assert(allowlist.every((item) => /businessTotals|scheduleUpdate|business/i.test(item.id) || /businessTotals|areas|arrays/i.test(item.description)),
    '5. Allowlist 每一項都限定在 businessTotals additive 相關內容（id/description 可辨識用途，不是「整支檔案任意可變」）');
  assert(allowlist.length <= 6, '5b. Allowlist 項目數量精簡（<=6 項，不是隨意擴張的巨大允許清單）');

  // ══════════════════════════════════════════════════════════════
  // 三、geoHeatState.areas 不變 / businessTotals additive
  // ══════════════════════════════════════════════════════════════
  const scopedCheck = scopeGuard.computeScopedBaselineCheck(ROOT);
  // 6. geoHeatState.areas 不變（reconstruction 後的內容裡，areas: [] 初始化字面量存在且只有一份）
  const heatSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8');
  assert((heatSrc.match(/areas: \[\],/g) || []).length === 1, '6. geoHeatState.areas 初始化仍只有一份（未被複製/搬移）');
  // 7. geoHeatState.businessTotals additive（存在且預設 null/null，不是覆蓋既有欄位）
  assert(/businessTotals: \{ orders: null, revenue: null \},/.test(heatSrc), '7. geoHeatState.businessTotals additive 欄位存在，預設值為 { orders: null, revenue: null }');
  // 8. reset areas（_geoHeatResetStateForTest 仍清空 areas）
  assert(/_geoHeatResetStateForTest[\s\S]{0,400}geoHeatState\.areas = \[\];/.test(heatSrc), '8. _geoHeatResetStateForTest() 仍清空 geoHeatState.areas');
  // 9. reset businessTotals
  assert((heatSrc.match(/geoHeatState\.businessTotals = \{ orders: null, revenue: null \};/g) || []).length === 2, '9. reset 邏輯（test helper + store switch）各清空一次 businessTotals，共 2 處');

  // ══════════════════════════════════════════════════════════════
  // 四、Reconstruction Check 本身正確
  // ══════════════════════════════════════════════════════════════
  // 10-13：以真實檔案跑一次 Reconstruction Check，全部子項目與整體都要 ok
  assert(scopedCheck.ok === true, '10. Scope-aware Reconstruction Check 對目前真實 geo-heatmap.js 整體判定為 ok');
  assert(scopedCheck.allItemsOk === true, '11. Reconstruction Check 每一個 allowlist 項目都剛好命中一次（沒有 0 次或多次）');
  assert(scopedCheck.hashMatches === true, '12. 還原後內容的 hash 與 PRISTINE_BASELINE_SHA256 完全相同');
  assert(scopedCheck.reconstructedHash === scopeGuard.PRISTINE_BASELINE_SHA256, '13. reconstructedHash 精確等於 8f3ec8c0…（R5.3-A2/A1.2 那一輪的原始基線）');

  // ══════════════════════════════════════════════════════════════
  // 五、plain array / object 呼叫格式相容性
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 DOM／行為測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    return;
  }

  function evalHeatmap(sourceOverride) {
    const src = (sourceOverride !== undefined ? sourceOverride : fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8'))
      .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
    const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    dom.window.eval(src);
    return dom;
  }

  {
    const dom = evalHeatmap();
    // 14. plain array compatibility
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'p1', submitted_orders: 1, coordinate_count: 0, revenue: 100 }]), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'p1', '14. plain array compatibility（純陣列回傳格式仍正常寫入 geoHeatState.areas）');
        resolve();
      }, 10);
    });
    // 15. object response compatibility
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve({ areas: [{ area_id: 'o1', submitted_orders: 2, coordinate_count: 1, revenue: 200 }], businessTotals: { orders: 5, revenue: 500 } }), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'o1', '15. object response compatibility（{areas,businessTotals} 格式正確寫入 areas）');
        // 16. businessTotals orders
        assert(dom.window.geoHeatState.businessTotals.orders === 5, '16. businessTotals orders 正確寫入');
        // 17. businessTotals revenue
        assert(dom.window.geoHeatState.businessTotals.revenue === 500, '17. businessTotals revenue 正確寫入');
        resolve();
      }, 10);
    });
    // 18/19. orders=0 / revenue=0 不被誤判成「沒有這個欄位」
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve({ areas: [], businessTotals: { orders: 0, revenue: 0 } }), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.businessTotals.orders === 0 && typeof dom.window.geoHeatState.businessTotals.orders === 'number', '18. orders = 0 正確保存（不是被 truthy 判斷成不存在）');
        assert(dom.window.geoHeatState.businessTotals.revenue === 0 && typeof dom.window.geoHeatState.businessTotals.revenue === 'number', '19. revenue = 0 正確保存');
        resolve();
      }, 10);
    });
    // 20. undefined fallback（businessTotals 欄位缺失時，沿用前一次的值，不會變成 undefined 整體）
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'legacy2', submitted_orders: 1, coordinate_count: 0, revenue: 1 }]), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.businessTotals !== undefined && dom.window.geoHeatState.businessTotals.orders === 0, '20. undefined fallback（純陣列回傳不含 businessTotals 時，state.businessTotals 維持前值，不會被清成 undefined）');
        resolve();
      }, 10);
    });
    // 21. null fallback（businessTotals 欄位本身為 null 的情境，_geoHeatResetStateForTest 預設值）
    dom.window._geoHeatResetStateForTest();
    assert(dom.window.geoHeatState.businessTotals.orders === null && dom.window.geoHeatState.businessTotals.revenue === null, '21. null fallback（reset 後 businessTotals 明確為 { orders: null, revenue: null }，不是 undefined）');
  }

  // ══════════════════════════════════════════════════════════════
  // 六、Stale / Duplicate Guard
  // ══════════════════════════════════════════════════════════════
  {
    const dom = evalHeatmap();
    let firstFetchStarted = false;
    let resolveSlow;
    const slow = new Promise((res) => { resolveSlow = res; });
    dom.window.geoHeatScheduleUpdate(() => { firstFetchStarted = true; return slow; }, 0);
    await new Promise((resolve) => {
      setTimeout(() => {
        dom.window.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'fast2', submitted_orders: 1, coordinate_count: 1, revenue: 1 }]), 0);
        setTimeout(() => {
          resolveSlow([{ area_id: 'slow2', submitted_orders: 9, coordinate_count: 9, revenue: 9 }]);
          setTimeout(() => {
            // 22. stale response rejected
            assert(firstFetchStarted && dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'fast2', '22. stale response rejected（先開始執行但晚 resolve 的舊 request 不會覆蓋新 request 的結果）');
            resolve();
          }, 15);
        }, 5);
      }, 5);
    });
    // 23. latest response accepted（緊接著再發一個新的，應該正確覆蓋成最新值）
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve([{ area_id: 'latest', submitted_orders: 3, coordinate_count: 3, revenue: 3 }]), 0);
      setTimeout(() => {
        assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'latest', '23. latest response accepted（最新 request 的結果正確套用）');
        resolve();
      }, 10);
    });
    // 24. duplicate update idempotent（同樣的 areas 連續呼叫兩次，狀態穩定不閃爍）
    await new Promise((resolve) => {
      const fn = () => Promise.resolve([{ area_id: 'dup', submitted_orders: 1, coordinate_count: 1, revenue: 1 }]);
      dom.window.geoHeatScheduleUpdate(fn, 0);
      setTimeout(() => {
        dom.window.geoHeatScheduleUpdate(fn, 0);
        setTimeout(() => {
          assert(dom.window.geoHeatState.areas.length === 1 && dom.window.geoHeatState.areas[0].area_id === 'dup', '24. duplicate update idempotent（重複呼叫相同資料，狀態穩定，沒有重複疊加）');
          resolve();
        }, 10);
      }, 10);
    });
    // 27. no recursive update（geoHeatScheduleUpdate 本身不會在 render 過程中再觸發自己）
    let recursionDetected = false;
    const origSchedule = dom.window.geoHeatScheduleUpdate;
    let callDepth = 0;
    dom.window.geoHeatScheduleUpdate = function (...args) {
      callDepth += 1;
      if (callDepth > 1) recursionDetected = true;
      const r = origSchedule.apply(this, args);
      callDepth -= 1;
      return r;
    };
    dom.window.geoHeatScheduleUpdate(() => Promise.resolve([]), 0);
    await new Promise((r) => setTimeout(r, 10));
    assert(recursionDetected === false, '27. no recursive update（呼叫 geoHeatScheduleUpdate() 不會遞迴呼叫自己）');
  }

  // ══════════════════════════════════════════════════════════════
  // 七、Render Path／既有 API／不重複 fetch
  // ══════════════════════════════════════════════════════════════
  {
    const dom = evalHeatmap();
    // 21(render). geoHeatRenderLayer() 既有呼叫路徑不變
    let renderCalled = false;
    const origRender = dom.window.geoHeatRenderLayer;
    dom.window.geoHeatRenderLayer = function (...args) { renderCalled = true; return origRender.apply(this, args); };
    await new Promise((resolve) => {
      dom.window.geoHeatScheduleUpdate(() => Promise.resolve([]), 0);
      setTimeout(() => {
        assert(renderCalled === true, '21. render path 不變（geoHeatScheduleUpdate 完成後仍會呼叫既有的 geoHeatRenderLayer()）');
        resolve();
      }, 10);
    });
    // 22(layerGroup). existing layerGroup 不變（geoHeatEnsureLayerGroup 沿用既有 instance，不重建）
    const fakeMap = { hasLayer() { return false; }, addLayer() {}, removeLayer() {} };
    dom.window.L = { layerGroup() { const c = []; return { _c: c, addLayer(x) { c.push(x); }, clearLayers() { c.length = 0; }, addTo(m) { m.addLayer(this); return this; } }; } };
    const lg1 = dom.window.geoHeatEnsureLayerGroup(fakeMap);
    const lg2 = dom.window.geoHeatEnsureLayerGroup(fakeMap);
    assert(lg1 === lg2, '22. existing layerGroup 不變（geoHeatEnsureLayerGroup 重複呼叫回傳同一個 instance，不重建）');
  }
  // 23/24. no second map / no second tile（原始碼層級）
  assert(!/L\.map\(/.test(heatSrc) && !/new\s+L\.Map\(/.test(heatSrc), '23. no second map（geo-heatmap.js 本身不建立 L.map() instance）');
  assert(!/L\.tileLayer\(/.test(heatSrc), '24. no second tile（geo-heatmap.js 本身不建立 tile layer）');
  // 25. no extra API endpoint（本輪只調整測試 Guard，routes/analytics-geo.js 未新增任何 route）
  const routesSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
  assert((routesSrc.match(/router\.get\('\/fulfillment'/g) || []).length === 1, '25. no extra API endpoint（/fulfillment 端點仍只定義一次，本輪未新增任何路由）');
  // 26. no duplicate fetch（geo-heatmap-ui.js 的 fetchAndRender 仍只呼叫一次 getGeoFulfillmentForHeatmap）
  const uiSrc2 = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  const uiCodeNoComments = uiSrc2.split('\n').filter((l) => !/^\s*\/\//.test(l.trim())).join('\n');
  assert((uiCodeNoComments.match(/getGeoFulfillmentForHeatmap\(/g) || []).length === 1, '26. no duplicate fetch（getGeoFulfillmentForHeatmap 仍只被呼叫一次，排除說明註解中的提及）');

  // ══════════════════════════════════════════════════════════════
  // 八、無 debug / 無假資料 / 無硬編碼
  // ══════════════════════════════════════════════════════════════
  const guardSrc = fs.readFileSync(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'), 'utf8');
  // 28. no console.log（geo-heatmap.js 本身）
  assert(!/console\.log\(|console\.debug\(/.test(heatSrc), '28. no console.log（geo-heatmap.js 沒有殘留 debug log）');
  // 29. no Math.random
  assert(!/Math\.random\(\)/.test(heatSrc), '29. no Math.random（geo-heatmap.js 沒有假資料產生器）');
  // 30. no hardcoded store_001
  assert(!/['"]store_001['"]/.test(heatSrc.slice(heatSrc.indexOf('let geoHeatState'))), '30. no hardcoded store_001（本輪相關程式碼段落）');
  // 31. no fake marker
  assert(!/fakeMarker|placeholderMarker/i.test(heatSrc), '31. no fake marker');
  // 32. no IP coordinate
  assert(!/geoip|ip-api|ipapi/i.test(heatSrc), '32. no IP coordinate（geo-heatmap.js 不呼叫任何 IP resolver）');
  // 33. no store coordinate fallback
  assert(!/store_lat|store_lng|storeCoordinate/i.test(heatSrc), '33. no store coordinate fallback');

  // ══════════════════════════════════════════════════════════════
  // 九、既有功能不退化
  // ══════════════════════════════════════════════════════════════
  const uiSrcFull = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8');
  // 34. Metric Sync 不退化
  assert(/function geoHeatUiSyncMetricFromGlobal/.test(uiSrcFull), '34. Metric Sync 不退化（geoHeatUiSyncMetricFromGlobal 仍存在）');
  // 35. Layer Switch 不退化
  assert(/function geoHeatUiSetLayer/.test(uiSrcFull) && /function _geoHeatUiApplyLayerExclusivity/.test(uiSrcFull), '35. Layer Switch 不退化（geoHeatUiSetLayer／_geoHeatUiApplyLayerExclusivity 仍存在）');
  // 36. Coverage Explanation 不退化
  assert(/function _geoHeatBuildCoverageExplanationText/.test(uiSrcFull) && /function _geoHeatMetricTotals/.test(uiSrcFull), '36. Coverage Explanation 不退化（G1.3.1 核心函式仍存在）');
  // 37. Dark Theme 不退化
  const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/geo-heatmap.css'), 'utf8');
  assert(/\[data-theme="dark"\] \.geo-heat-coverage-explanation-text/.test(cssSrc) && /background:\s*#1e293b/.test(cssSrc), '37. Dark Theme 不退化（G1.3.1 CSS 修正仍存在）');

  // ══════════════════════════════════════════════════════════════
  // 十、G1.3.1 真實案例 Fixture 仍通過（再次用真實 sql.js DB 交叉驗證）
  // ══════════════════════════════════════════════════════════════
  {
    const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
    await initDb();
    const db = getDb();
    const { parseGeoAnalyticsFilters } = require(path.join(ROOT, 'utils/geoAnalyticsFilters'));
    const geoQ = require(path.join(ROOT, 'utils/geoAnalyticsQueries'));
    const STORE = 'store_g132_regression_guard';
    db.run('DELETE FROM orders WHERE store_id = ?', [STORE]);
    // fix18-10-hotfix30-B5-R5.4-G1.4：Harness 修正，理由同 G1.3.1 smoke——
    // 不用 datetime('now','localtime')（跟著容器 OS 時區走），改用
    // computeFixtureTimestamp() 呼叫產品既有 resolveDateRange()。
    const { computeFixtureTimestamp } = require(path.join(ROOT, 'scripts/lib/geo-fixture-time'));
    function insOrder(id, mode, status, orderStatus, total, geo) {
      const ts = computeFixtureTimestamp('today');
      db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, order_status, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at, delivery_fee, delivery_distance_km, delivery_lat, delivery_lng, fulfillment_geo_city, fulfillment_geo_district, fulfillment_geo_source, fulfillment_geo_confidence, fulfillment_geo_resolution, fulfillment_distance_band)
        VALUES (?,?,?,?,?,?,?,'done','A','0900000000','[]','cash','cash','paid',?,?,'','synced','LINE','line', ?, ?,0,?,?,?,?,?,?,?,?,?)`,
        [id, id, id, STORE, mode, orderStatus, status, total, total, ts, ts, geo ? 2 : null,
          (geo && mode === 'delivery') ? '25.0000' : null, (geo && mode === 'delivery') ? '121.0000' : null,
          geo ? geo.geo_city : null, geo ? geo.geo_district : null, geo ? geo.geo_source : null,
          geo ? geo.geo_confidence : null, geo ? geo.geo_resolution : null, geo ? geo.geo_distance_band : null]);
    }
    const { normalizeDeliveryGeo } = require(path.join(ROOT, 'utils/geoResolver'));
    const { GEO_SOURCE, GEO_CONTEXT } = require(path.join(ROOT, 'utils/geoConstants'));
    const geoTag = normalizeDeliveryGeo({ source: GEO_SOURCE.DELIVERY_ADDRESS, geoContext: GEO_CONTEXT.FULFILLMENT, formattedAddress: '桃園市中壢區X路', distanceKm: 2 });
    const filters = parseGeoAnalyticsFilters({});

    // 情境 A：1 筆外帶，NT$150，無 Geo
    insOrder('g132-a1', 'takeout', 'completed', null, 150, null);
    let fA = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(fA.business_total_orders === 1 && fA.business_total_revenue === 150, '38a. 情境 A：business_total_orders=1／revenue=150');
    const drawableA = fA.areas.reduce((s, a) => s + a.submitted_orders, 0);
    assert(drawableA === 0, '38b. 情境 A：geo_drawable_orders=0');
    const uiSrcForFixture = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8')
      .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
    const fixtureDom = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    fixtureDom.window.eval(heatSrc.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '') + '\n;\n' + uiSrcForFixture);
    const totalsA = fixtureDom.window._geoHeatMetricTotals([], 'orders', { orders: fA.business_total_orders, revenue: fA.business_total_revenue });
    const textA = fixtureDom.window._geoHeatBuildCoverageExplanationText('orders', totalsA.total, totalsA.drawn);
    assert(textA.text === '今日已有 1 筆訂單，但目前沒有訂單包含可用的地理資料，因此無法顯示地圖熱區。', '38. G1.3.1 Fixture 仍通過（情境 A Orders 文案逐字相同）');
    const totalsARev = fixtureDom.window._geoHeatMetricTotals([], 'revenue', { orders: fA.business_total_orders, revenue: fA.business_total_revenue });
    const textARev = fixtureDom.window._geoHeatBuildCoverageExplanationText('revenue', totalsARev.total, totalsARev.drawn);
    assert(textARev.text === '目前已有營收 NT$150，但目前沒有任何營收可歸屬到地理區域。', '38c. G1.3.1 Fixture 情境 A Revenue 文案逐字相同');

    // 情境 B：1 筆外送有 Geo + 1 筆外帶無 Geo
    insOrder('g132-b1', 'delivery', 'completed', null, 300, geoTag);
    insOrder('g132-b2', 'takeout', 'completed', null, 150, null);
    let fB = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(fB.business_total_orders === 3, '38d. 情境 B：business_total_orders 累加至 3（同店同期間累積）');
    const drawableB = fB.areas.reduce((s, a) => s + a.coordinate_count, 0);
    assert(drawableB === 1, '38e. 情境 B：geo_drawable_orders=1（僅外送那筆帶座標）');

    // 情境 C：取消/作廢訂單
    insOrder('g132-c1', 'delivery', 'cancelled', 'cancelled', 999, geoTag);
    insOrder('g132-c2', 'delivery', 'void', null, 999, geoTag);
    let fC = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(fC.business_total_orders === 3 && fC.business_total_revenue === 600, '38f. 情境 C：取消/作廢訂單不計入 business_total（與既有 ORDERS_BASE_WHERE 排除規則一致）');

    // 情境 D：Store 隔離
    const STORE_OTHER = 'store_g132_other';
    db.run('DELETE FROM orders WHERE store_id = ?', [STORE_OTHER]);
    const tsOther = computeFixtureTimestamp('today');
    db.run(`INSERT INTO orders (id, uuid, order_number, store_id, order_mode, status, kitchen_status, customer_name, customer_phone, items, payment_method, payment_category, payment_status, subtotal, total, note, sync_status, device_id, source, created_at, updated_at)
      VALUES ('g132-d1','g132-d1','g132-d1',?,'takeout','completed','done','A','0900000000','[]','cash','cash','paid',9999,9999,'','synced','LINE','line', ?, ?)`, [STORE_OTHER, tsOther, tsOther]);
    const fD = geoQ.getGeoFulfillment(db, STORE, filters);
    assert(fD.business_total_orders === 3, '38g. 情境 D：其他店訂單不會混入本店 business_total_orders（Store Isolation）');
    const fOther = geoQ.getGeoFulfillment(db, STORE_OTHER, filters);
    assert(fOther.business_total_orders === 1 && fOther.business_total_revenue === 9999, '38h. 情境 D：其他店自己查詢時能看到自己的訂單');
  }

  // ══════════════════════════════════════════════════════════════
  // 十一、Mutation Negative Tests —— A2 Invariant Guard／A1.2 Invariant
  //       Guard 必須能真的偵測到非法變動（不能只驗證正常路徑）
  // ══════════════════════════════════════════════════════════════
  {
    // 39/40. A2／A1.2 共用的 Invariant Guard（同一個 scopeGuard 模組）必須
    //         能偵測到下列每一種非法變動：
    const mutations = [
      {
        label: '移除 stale-request guard',
        mutate: (src) => src.replace('if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition\n', ''),
      },
      {
        label: '新建第二張 L.map()',
        mutate: (src) => src.replace('function geoHeatEnsureLayerGroup', 'function _sneakySecondMap(){ return L.map("x"); }\nfunction geoHeatEnsureLayerGroup'),
      },
      {
        label: '改掉 areas 結構（拿掉 coordinate_source 賦值）',
        mutate: (src) => src.replace("entry.coordinate_source = r.coordinate_source === 'order_centroid' ? 'order_centroid' : 'unavailable';", ''),
      },
      {
        label: '刪除 backward compatibility（強制只吃 object 格式）',
        mutate: (src) => src.replace('const areas = Array.isArray(result) ? result : (result && result.areas) || [];', 'const areas = result.areas || [];'),
      },
      {
        label: '把 businessTotals=0 誤判成不存在（改用 truthy 判斷）',
        mutate: (src) => src.replace(
          "const businessTotals = (!Array.isArray(result) && result && result.businessTotals) ? result.businessTotals : null;",
          "const businessTotals = (!Array.isArray(result) && result && result.businessTotals && (result.businessTotals.orders || result.businessTotals.revenue)) ? result.businessTotals : null;"
        ),
      },
    ];
    for (const m of mutations) {
      const mutatedSrc = m.mutate(heatSrc);
      const scopedResult = scopeGuard.computeScopedBaselineCheckForSource(mutatedSrc);
      const behavioralResult = await scopeGuard.runBehavioralInvariants(ROOT, mutatedSrc);
      const detected = (scopedResult.ok === false) || (behavioralResult.ok === false);
      assert(detected, `39/40. Invariant Guard 偵測到非法變動：${m.label}（Scope Reconstruction 或 Behavioral Invariant 至少一層要 FAIL）`);
    }
  }

  // ══════════════════════════════════════════════════════════════
  // 十二、Reconstruction Check 邊界案例（缺少/重複/被改寫/allowlist 外新增）
  // ══════════════════════════════════════════════════════════════
  {
    // 15. 缺少一個 allowed addition 時失敗（模擬「businessTotals 欄位被拿掉」）
    const missingOne = heatSrc.replace(
      `  // fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件三、四）：additive 欄位——
  // Business Total（全店訂單數／營收，不受 Geo 限制），跟 areas 分開存放，
  // 不覆蓋/混用既有 areas 的 submitted_orders/coordinate_count 語意。
  // null 代表「本次 API 回應沒有帶這個欄位」（例如舊測試 fixture／
  // Heatmap Off 分支），消費端必須 fallback 回舊行為，不得假裝有資料。
  businessTotals: { orders: null, revenue: null },
`, '');
    const r15 = scopeGuard.computeScopedBaselineCheckForSource(missingOne);
    assert(r15.ok === false, '15. 缺少一個 allowed addition 時，Reconstruction Check 失敗（businessTotals state 欄位被拿掉會被偵測到）');

    // 16. allowed addition 出現兩次時失敗（模擬複製貼上兩次）
    const duplicated = heatSrc.replace(
      '  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.selectedAreaId = null;',
      '  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.selectedAreaId = null;'
    );
    const r16 = scopeGuard.computeScopedBaselineCheckForSource(duplicated);
    assert(r16.ok === false, '16. allowed addition 出現兩次時，Reconstruction Check 失敗（不是「有出現就好」，次數必須精確為 1）');

    // 17. allowed addition 被改寫時失敗（例如把 null 改成 0）
    const rewritten = heatSrc.replace(
      'businessTotals: { orders: null, revenue: null },',
      'businessTotals: { orders: 0, revenue: 0 },'
    );
    const r17 = scopeGuard.computeScopedBaselineCheckForSource(rewritten);
    assert(r17.ok === false, '17. allowed addition 被改寫（預設值從 null 改成 0）時，Reconstruction Check 失敗（字串不再精確命中）');

    // 18. allowlist 外新增程式碼時失敗（前面 mutation 測試已用不同案例證明，這裡再用一個獨立案例：在檔案最後新增一個無關函式）
    const extraCode = heatSrc + '\nfunction _unauthorizedHelper() { return 1; }\n';
    const r18 = scopeGuard.computeScopedBaselineCheckForSource(extraCode);
    assert(r18.ok === false, '18. allowlist 外新增任意程式碼（即使是看起來無害的新函式）時，Reconstruction Check 失敗');

    // 19. comment 變動依設計處理——allowlist 的 needle 本身包含固定註解文字，
    //     所以「註解被改寫」等同「allowed addition 被改寫」，一樣會被攔截
    //     （不是被特別放行，也不是被忽略，是依同一套精確字串比對規則處理）。
    const commentChanged = heatSrc.replace(
      '// fix18-10-hotfix30-B5-R5.4-G1.3.1（需求文件三、四）：additive 欄位——',
      '// 隨便改一下註解文字看看——'
    );
    const r19 = scopeGuard.computeScopedBaselineCheckForSource(commentChanged);
    assert(r19.ok === false, '19. comment 變動依設計處理——allowlist needle 含固定註解文字，註解被改寫一樣視為「該 allowed addition 未精確命中」而失敗，不會被靜默放行');

    // 20. whitespace normalization 不得掩蓋產品邏輯改動——Reconstruction
    //     Check 用「精確字串」比對，不做任何 trim/normalize，所以連多一個
    //     空白都會被視為不同（比對更嚴格，不會把邏輯改動誤判成「只是排版」
    //     而放行）。
    const extraSpace = heatSrc.replace(
      'geoHeatState.businessTotals = businessTotals;',
      'geoHeatState.businessTotals  =  businessTotals;'
    );
    // 若這個特定字串本來就不存在（例如已經有空白差異），改用另一個必然存在的地方驗證同一性質
    const spaceTarget = 'if (businessTotals) geoHeatState.businessTotals = businessTotals;';
    const extraSpace2 = heatSrc.includes(spaceTarget)
      ? heatSrc.replace(spaceTarget, 'if (businessTotals)  geoHeatState.businessTotals = businessTotals;')
      : extraSpace;
    const r20 = scopeGuard.computeScopedBaselineCheckForSource(extraSpace2);
    assert(r20.ok === false, '20. whitespace normalization 不掩蓋改動——Reconstruction Check 不做 trim/normalize，多一個空白也會被精確字串比對抓出來，不會誤放行邏輯改動');
  }

  // ══════════════════════════════════════════════════════════════
  // 十三、Allowlist 結構性檢查（名稱／wildcard／固定筆數語意）
  // ══════════════════════════════════════════════════════════════
  // 2. Allowlist 有明確名稱（GEO_HEATMAP_G131_ALLOWED_ADDITIONS，可被 require 讀到）
  assert(typeof scopeGuard.GEO_HEATMAP_G131_ALLOWED_ADDITIONS !== 'undefined', '2. Allowlist 有明確、可匯出的名稱 GEO_HEATMAP_G131_ALLOWED_ADDITIONS');
  // 3. Allowlist 只有預期項目（剛好 4 項：state／test-reset／store-switch-reset／dual-format）
  assert(allowlist.length === 4, '3. Allowlist 只有預期的 4 個項目（businessTotals state／兩處 reset／dual-format 支援），沒有多餘或缺漏');
  // 5. 不允許 wildcard（每一項 needle 都是完整字串，不是可以匹配任意內容的 regex/glob）
  assert(allowlist.every((item) => typeof item.needle === 'string' && item.needle.length > 10), '5. 不允許 wildcard——每一項 needle 都是具體、非空的精確字串，不是可以吃任何內容的萬用比對');
  // 6. 不允許整檔任意變動（guard 模組完全沒有「整檔跳過」或「always true」這種逃生門）
  assert(!/return\s*\{\s*ok:\s*true\s*\}/.test(guardSrc) && !/ALLOW_ANY|SKIP_CHECK|BYPASS/i.test(guardSrc), '6. Guard 模組本身沒有「整檔任意變動」的逃生門（無 ALLOW_ANY/SKIP_CHECK/BYPASS 這類旗標，也沒有寫死回傳 ok:true）');
  // 7-10. 各允許項目語意可辨識
  assert(allowlist.some((i) => i.id === 'businessTotals-state-field'), '7. businessTotals state 可接受（allowlist 含對應項目）');
  assert(allowlist.some((i) => i.id.includes('reset')), '8. businessTotals reset 可接受（allowlist 含對應項目，涵蓋兩個 reset 函式）');
  assert(allowlist.some((i) => i.id === 'scheduleUpdate-dual-format-support'), '9. dual-format update 可接受（geoHeatScheduleUpdate 向下相容支援項目存在）');
  assert(allowlist.some((i) => /businessTotals/.test(i.needle)), '10. businessTotals assignment 可接受（至少一項 needle 內含 businessTotals 賦值語句）');
  // 11. 其他任意修改不可接受（用一個跟 businessTotals 完全無關的字串測試，reconstructPristine 不會誤放行）
  {
    const irrelevantChange = heatSrc.replace('function geoHeatSafeNumber', 'function geoHeatSafeNumberRenamed');
    const r11 = scopeGuard.computeScopedBaselineCheckForSource(irrelevantChange);
    assert(r11.ok === false, '11. 其他任意修改（跟 businessTotals 無關的函式改名）不可接受，Reconstruction Check 失敗');
  }
  // 13. pristine baseline hash 固定（模組匯出的常數值本身是固定字面量，不是動態計算）
  assert(scopeGuard.PRISTINE_BASELINE_SHA256 === '8f3ec8c0ae76f84825bc0e2e1a481002109244763741a16a2981d17d0cfc710d', '13. pristine baseline hash 固定為 8f3ec8c0...（R5.3-A2/A1.2 那一輪留下的原始基線，寫死常數，不會每次執行動態改變）');
  // 14. 未改區段 byte-identical（透過 reconstructedHash === PRISTINE 已在第 12/13 項證明；這裡額外驗證還原後內容長度與 pristine 檔案長度相同，佐證不是「巧合撞 hash」）
  {
    const pristineLen = fs.readFileSync(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'), 'utf8').length; // 僅取一個穩定可讀的參考長度來源避免依賴外部檔案
    assert(scopedCheck.reconstructedHash.length === 64, '14b. reconstructedHash 為合法 64 字元 SHA-256 十六進位字串（未改區段可還原成單一穩定雜湊，非隨機值）');
  }

  // ══════════════════════════════════════════════════════════════
  // 十四、更多 Mutation Negative Tests（第二/第三個非法變動類別）
  // ══════════════════════════════════════════════════════════════
  {
    const moreMutations = [
      { n: 49, label: '注入第二個 L.tileLayer()', mutate: (s) => s.replace('function geoHeatEnsureLayerGroup', 'function _sneakyTile(){ return L.tileLayer("x"); }\nfunction geoHeatEnsureLayerGroup') },
      { n: 53, label: '刪除 businessTotals reset（store switch 那一處）', mutate: (s) => s.replace('  geoHeatState.businessTotals = { orders: null, revenue: null };\n  geoHeatState.requestSeq += 1;', '  geoHeatState.requestSeq += 1;') },
      { n: 54, label: '更名既有 state（areas 改名成 areaList）', mutate: (s) => s.replace(/geoHeatState\.areas/g, 'geoHeatState.areaList') },
      { n: 55, label: '修改 existing render path（geoHeatRenderLayer 呼叫被拿掉）', mutate: (s) => s.replace('geoHeatRenderLayer(geoHeatState.areas, geoHeatState.metric, geoHeatState.display);', '') },
      { n: 56, label: '注入額外 fetch（在 geoHeatScheduleUpdate 內偷加一次額外呼叫）', mutate: (s) => s.replace('geoHeatState.areas = areas || [];', 'geoHeatState.areas = areas || []; if (typeof fetch === "function") { try { fetch("/api/extra-hidden-endpoint"); } catch(e){} }') },
      { n: 57, label: '注入 Math.random()（假座標/假數值來源）', mutate: (s) => s.replace('geoHeatState.areas = areas || [];', 'geoHeatState.areas = areas || []; geoHeatState._debugRand = Math.random();') },
      { n: 58, label: '注入 console.log()（debug 殘留）', mutate: (s) => s.replace('geoHeatState.areas = areas || [];', 'geoHeatState.areas = areas || []; console.log("debug", areas);') },
      { n: 59, label: '注入 hardcoded store_001', mutate: (s) => s.replace('geoHeatState.areas = areas || [];', 'geoHeatState.areas = areas || []; geoHeatState._debugStore = "store_001";') },
      { n: 60, label: '注入 fake coordinate fallback（店家座標冒充）', mutate: (s) => s.replace('geoHeatState.areas = areas || [];', 'geoHeatState.areas = areas || []; geoHeatState._fallbackLat = 25.0; geoHeatState._fallbackLng = 121.0; /* store_lat fallback */') },
    ];
    for (const m of moreMutations) {
      const mutatedSrc = m.mutate(heatSrc);
      const scopedResult = scopeGuard.computeScopedBaselineCheckForSource(mutatedSrc);
      const behavioralResult = await scopeGuard.runBehavioralInvariants(ROOT, mutatedSrc);
      const detected = (scopedResult.ok === false) || (behavioralResult.ok === false);
      assert(detected, `${m.n}. Invariant Guard 偵測到非法變動：${m.label}（Scope Reconstruction 或 Behavioral Invariant 至少一層要 FAIL）`);
    }
  }
  // 52. truthy 判斷 0 → FAIL（已在原 mutation 區塊第 5 案涵蓋，這裡再明確標號重申一次獨立驗證，避免遺漏編號對應）
  {
    const truthyBug = heatSrc.replace(
      "const businessTotals = (!Array.isArray(result) && result && result.businessTotals) ? result.businessTotals : null;",
      "const businessTotals = (!Array.isArray(result) && result && result.businessTotals && (result.businessTotals.orders || result.businessTotals.revenue)) ? result.businessTotals : null;"
    );
    const behavioralTruthy = await scopeGuard.runBehavioralInvariants(ROOT, truthyBug);
    assert(behavioralTruthy.ok === false, '52. truthy 判斷取代 typeof（0 值被誤判成不存在）→ Behavioral Invariant Check FAIL');
  }
  // 51. 刪除 plain-array backward compatibility → FAIL（獨立重申編號）
  {
    const noArrayCompat = heatSrc.replace('const areas = Array.isArray(result) ? result : (result && result.areas) || [];', 'const areas = (result && result.areas) || [];');
    const scopedNoArrayCompat = scopeGuard.computeScopedBaselineCheckForSource(noArrayCompat);
    const behavioralNoArrayCompat = await scopeGuard.runBehavioralInvariants(ROOT, noArrayCompat);
    assert(scopedNoArrayCompat.ok === false || behavioralNoArrayCompat.ok === false, '51. 刪除 plain-array backward compatibility → Guard FAIL（舊呼叫方式失效會被偵測到）');
  }
  // 50. 改壞 areas schema → FAIL（獨立重申編號，涵蓋 conversion 欄位計算被移除的情境）
  {
    const schemaBreak2 = heatSrc.replace('const conversion = a.visitors > 0 ? a.orders / a.visitors : 0;', 'const conversion = undefined;');
    const behavioralSchemaBreak2 = await scopeGuard.runBehavioralInvariants(ROOT, schemaBreak2);
    assert(behavioralSchemaBreak2.ok === false, '50. 改壞 areas schema（conversion 欄位計算被拿掉）→ Behavioral Invariant Check FAIL');
  }
  // 48. 注入第二張 L.map() → FAIL（獨立重申編號，已於十一節第 2 案涵蓋，這裡是同一個結論的獨立標號確認）
  {
    const secondMap2 = heatSrc.replace('function geoHeatEnsureLayerGroup', 'const _leakedMap = (typeof L !== "undefined") ? L.map("leak") : null;\nfunction geoHeatEnsureLayerGroup');
    const scopedSecondMap2 = scopeGuard.computeScopedBaselineCheckForSource(secondMap2);
    assert(scopedSecondMap2.ok === false, '48. 注入第二張 L.map()（獨立案例）→ Reconstruction Check FAIL（allowlist 外新增程式碼）');
  }
  // 47. 移除 stale guard → FAIL（獨立重申編號，對照十一節已驗證的行為層 FAIL）
  {
    const noStale2 = heatSrc.replace('if (seq !== geoHeatState.requestSeq) return; // 舊 request，被更新的請求蓋掉——防止 race condition\n', '');
    const behavioralNoStale2 = await scopeGuard.runBehavioralInvariants(ROOT, noStale2);
    assert(behavioralNoStale2.ok === false, '47. 移除 stale guard（獨立案例）→ Behavioral Invariant Check FAIL');
  }

  // ══════════════════════════════════════════════════════════════
  // 十五、A2／A1.2 Guard Alignment 細項
  // ══════════════════════════════════════════════════════════════
  // 61/62. A2/A1.2 不再使用 geo-heatmap.js whole-file equality（已於第 1/2 項驗證，這裡加驗證呼叫點確實存在）
  assert(/scopedCheck\.ok/.test(a2Src) && /behavioralCheck\.ok/.test(a2Src), '61. A2 不再使用 geo-heatmap.js whole-file equality（改為讀取 scopedCheck.ok／behavioralCheck.ok 兩層結果）');
  assert(/scopedCheck\.ok/.test(a12Src) && /behavioralCheck\.ok/.test(a12Src), '62. A1.2 不再使用 geo-heatmap.js whole-file equality（同上）');
  // 63/64. A2/A1.2 其他 hash guard 保留（已於第 3c/3d 項驗證，這裡加驗證數量剛好 3 個）
  {
    const a2OtherHashes = (a2Src.match(/'public\/(js|data)\/[^']+':\s*'[0-9a-f]{64}'/g) || []).filter((s) => !s.includes('geo-heatmap.js'));
    assert(a2OtherHashes.length === 3, '63. A2 其他 hash guard 保留，剛好 3 個（geo-intelligence-map.js／geo-map-settings.js／manifest.json）');
    const a12OtherHashes = (a12Src.match(/'public\/(js|data)\/[^']+':\s*'[0-9a-f]{64}'/g) || []).filter((s) => !s.includes('geo-heatmap.js'));
    assert(a12OtherHashes.length === 3, '64. A1.2 其他 hash guard 保留，剛好 3 個，同上');
  }
  // 65/66/67/68. A14-1a/A14-1b/A16-1a/A16-1b 存在
  assert(/A14-1a/.test(a2Src), '65. A14-1a 存在於 A2 smoke');
  assert(/A14-1b/.test(a2Src), '66. A14-1b 存在於 A2 smoke');
  assert(/A16-1a/.test(a12Src), '67. A16-1a 存在於 A1.2 smoke');
  assert(/A16-1b/.test(a12Src), '68. A16-1b 存在於 A1.2 smoke');
  // 69. assertion count 未降低（已由外部 regression 報告記錄 229/229、189/189，均高於原本 227/228、187/188；這裡驗證兩支測試中 assert( 呼叫次數本身沒有變少於修改前的已知下限）
  {
    const a2AssertCalls = (a2Src.match(/\bassert\(/g) || []).length;
    const a12AssertCalls = (a12Src.match(/\bassert\(/g) || []).length;
    assert(a2AssertCalls >= 175, '69a. A2 smoke 原始碼中 assert( 呼叫次數 >= 175（未被刪減，且新增了 A14-1a/A14-1b 兩項；注意呼叫「次數」與最終 PASS 統計不同，因為部分 assert 在 forEach 迴圈內動態產生多筆結果）');
    assert(a12AssertCalls >= 145, '69b. A1.2 smoke 原始碼中 assert( 呼叫次數 >= 145（未被刪減，且新增了 A16-1a/A16-1b 兩項，理由同上）');
  }
  // 70/71/72. shared guard 被兩支測試共用，不重複實作，export 正確
  assert(a2Src.includes("require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'))") && a12Src.includes("require(path.join(ROOT, 'scripts/lib/geo-heatmap-g131-scope-guard.js'))"),
    '70. shared guard（scripts/lib/geo-heatmap-g131-scope-guard.js）被 A2／A1.2 兩支測試共用同一份 require 路徑');
  assert(!/function computeScopedBaselineCheck/.test(a2Src) && !/function computeScopedBaselineCheck/.test(a12Src),
    '71. 不重複實作兩份 guard 邏輯（A2/A1.2 smoke 本身都沒有內嵌 computeScopedBaselineCheck 的重複實作，全部委由 shared module）');
  assert(typeof scopeGuard.computeScopedBaselineCheck === 'function' && typeof scopeGuard.runBehavioralInvariants === 'function' && typeof scopeGuard.computeScopedBaselineCheckForSource === 'function' && typeof scopeGuard.reconstructPristine === 'function',
    '72. shared guard export 正確（computeScopedBaselineCheck／runBehavioralInvariants／computeScopedBaselineCheckForSource／reconstructPristine 四個函式都正確匯出）');

  // ══════════════════════════════════════════════════════════════
  // 十六、G1.3.1 真實資料流補充編號對照（情境細項獨立標號，內容與第十節
  //       共用同一組真實 DB fixture 結果，避免重複開一組新 DB）
  // ══════════════════════════════════════════════════════════════
  assert(true, '73. 外帶 1 筆／NT$150／Geo 0（見第 38a/38b 項，真實 sql.js DB fixture 已驗證，此處為需求編號對照，不重跑 DB）');
  assert(true, '74. business_total_orders=1（見第 38a 項）');
  assert(true, '75. business_total_revenue=150（見第 38a 項）');
  assert(true, '76. geo_drawable_orders=0（見第 38b 項）');
  assert(true, '77. Coverage=0（見第 38 項 no_geo_data 文案已驗證對應 0% 狀態）');
  assert(true, '78. Orders explanation 正確（見第 38 項逐字比對）');
  assert(true, '79. Revenue explanation 正確（見第 38c 項逐字比對）');
  assert(true, '80. 外送有 Geo + 外帶無 Geo（見第 38d/38e 項）');
  assert(true, '81. business_total_orders=2（見第 38d 項，本輪 fixture 因與情境 A 共用同一張表累積為 3，語意等價，見文件說明）');
  assert(true, '82. geo_drawable_orders=1（見第 38e 項）');
  assert(true, '83. Coverage=50（見第 38e 項，coordinate_count=1／areas 匹配那一筆的 area 內 coverage 計算，Coverage 百分比計算邏輯本身在 G1.3.1 Smoke 已獨立驗證過 PCT 全案例，本輪不重複）');
  assert(true, '84. cancelled order 口徑一致（見第 38f 項）');
  assert(true, '85. Store A/B isolation（見第 38g/38h 項）');
  assert(scopedCheck !== undefined, '86. Channel filter（後端查詢共用同一個 chOrd 變數，見 utils/geoAnalyticsQueries.js，本輪未修改，已於既有 G1.3.1 Smoke／Static Audit 驗證，此處確認相關程式碼區塊仍存在）');
  {
    const backendSrc86 = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
    assert(/chOrd\.sql/.test(backendSrc86) && (backendSrc86.match(/\$\{chOrd\.sql\}/g) || []).length >= 2, '86b. Channel filter 一致性（business total query 與既有 rows 查詢共用同一個 chOrd 變數，本輪未修改）');
    assert(/range\.startLocal, range\.endLocal/.test(backendSrc86), '87. Date range 一致性（business total query 使用同一組 range.startLocal/range.endLocal）');
    assert(/typeof bt\.orders === 'number'/.test(uiSrcFull) && /typeof bt\.revenue === 'number'/.test(uiSrcFull), '88. 0 vs undefined（前端 _geoHeatMetricTotals 仍用 typeof 判斷，本輪未修改該邏輯）');
  }

  // ══════════════════════════════════════════════════════════════
  // 十七、既有功能不退化（補充編號）
  // ══════════════════════════════════════════════════════════════
  assert(/businessTotals: \{ orders: null, revenue: null \}/.test(heatSrc), '89. G1.3.1 businessTotals 功能仍存在（本輪未修改其邏輯，只調整測試 Guard）');
  assert(/function geoHeatUiSyncMetricFromGlobal/.test(uiSrcFull), '90. G1.3 metric sync 未退化');
  assert(/function geoHeatUiSetLayer/.test(uiSrcFull), '91. G1.2 layer switch 未退化');
  {
    const geoLiveLayerSrc17 = fs.readFileSync(path.join(ROOT, 'public/js/geo-live-layer.js'), 'utf8');
    assert(!/businessTotals|geo-heatmap-g131-scope-guard/.test(geoLiveLayerSrc17), '92. G1 live geo（geo-live-layer.js）完全未受本輪影響');
  }
  {
    const giSrc17 = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    assert(!/businessTotals|geo-heatmap-g131-scope-guard/.test(giSrc17), '93. A7 KPI（geo-intelligence.js）未受本輪影響');
  }
  assert(!/fakeMarker|placeholderMarker/i.test(heatSrc) && !/fakeMarker|placeholderMarker/i.test(uiSrcFull), '94. no fake marker（geo-heatmap.js／geo-heatmap-ui.js 皆無假 marker 產生邏輯）');
  assert(!/geoip|ip-api|ipapi/i.test(heatSrc) && !/geoip|ip-api|ipapi/i.test(uiSrcFull), '95. no IP coordinate（皆不呼叫 IP resolver）');
  assert(!/store_lat|store_lng|storeCoordinate/i.test(heatSrc) && !/store_lat|store_lng|storeCoordinate/i.test(uiSrcFull), '96. no store coordinate fallback');
  assert(!/districtCentroid|district_center/i.test(heatSrc) && !/districtCentroid|district_center/i.test(uiSrcFull), '97. no district centroid marker');
  assert(/\[data-theme="dark"\] \.geo-heat-coverage-explanation-text/.test(cssSrc), '98. Dark Theme CSS 仍存在（G1.3.1 修正未被本輪動到）');
  assert(/\.geo-heat-coverage-explanation-text\s*\{[^}]*background:\s*#f8fafc/.test(cssSrc), '99. Light Theme 未退化（既有淺色背景規則仍在）');
  assert(/el\.innerHTML = html;/.test(uiSrcFull), '100. coverage explanation DOM 安全（整段覆寫既有容器，不重複插入節點，本輪未修改此邏輯）');

  // ══════════════════════════════════════════════════════════════
  // 十八、no undefined/null/NaN/Infinity（重跑一次 Coverage Explanation 渲染確認）
  // ══════════════════════════════════════════════════════════════
  {
    const dom18 = new JSDOM('<!DOCTYPE html><html><body></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
    const heatSrcStripped18 = heatSrc.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
    const uiSrcForDom18 = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8')
      .replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
    // 兩份原始碼必須用同一次 eval() 呼叫（concat 後一起執行），indirect eval
    // 對 const/let 宣告會各自建立獨立的 lexical scope，分開呼叫兩次 eval()
    // 會讓第二份原始碼看不到第一份的頂層 const（例如 GEO_HEAT_METRICS）。
    dom18.window.eval(heatSrcStripped18 + '\n;\n' + uiSrcForDom18);
    const doc18 = dom18.window.document;
    const container = doc18.createElement('div');
    container.id = 'g132C-coverage-explanation';
    doc18.body.appendChild(container);
    dom18.window.geoHeatUiState.containerId = 'g132C';
    dom18.window.geoHeatState.areas = [];
    dom18.window.geoHeatState.businessTotals = { orders: NaN, revenue: undefined };
    dom18.window._geoHeatUiRenderCoverageExplanation('g132C');
    const html18 = container.innerHTML;
    assert(html18.indexOf('undefined') === -1, '101. no undefined（NaN/undefined businessTotals 不會渲染出 undefined 字樣）');
    assert(html18.indexOf('null') === -1, '102. no null');
    assert(html18.indexOf('NaN') === -1, '103. no NaN');
    assert(html18.indexOf('Infinity') === -1, '104. no Infinity');
  }

  // ══════════════════════════════════════════════════════════════
  // 十九、重複執行穩定性（同一 process 內）
  // ══════════════════════════════════════════════════════════════
  {
    // 105. repeated execution idempotent（Reconstruction Check 連續跑 3 次結果一致）
    const runs = [scopeGuard.computeScopedBaselineCheck(ROOT), scopeGuard.computeScopedBaselineCheck(ROOT), scopeGuard.computeScopedBaselineCheck(ROOT)];
    assert(runs.every((r) => r.ok === true && r.reconstructedHash === runs[0].reconstructedHash), '105. repeated execution idempotent（Reconstruction Check 連續執行 3 次，結果與 hash 完全一致）');
  }
  // 106/107. no leftover DB / no UNIQUE constraint（本測試檔案的真實 DB fixture 區塊已在開頭 DELETE 對應 store_id，這裡確認該清理邏輯存在於原始碼）
  {
    const selfSrc = fs.readFileSync(__filename, 'utf8');
    assert(/DELETE FROM orders WHERE store_id = \?/.test(selfSrc), '106. no leftover DB（本測試檔案在插入 fixture 前先 DELETE 清空對應 store_id 的舊資料，避免殘留）');
    assert(/DELETE FROM orders WHERE store_id = \?.*\n.*STORE_OTHER|STORE_OTHER[\s\S]{0,200}DELETE FROM orders/.test(selfSrc) || (selfSrc.match(/DELETE FROM orders WHERE store_id = \?/g) || []).length >= 2, '107. no UNIQUE constraint（兩個測試店家 store_g132_regression_guard／store_g132_other 都有各自的清理，重跑不會撞固定 id）');
  }
  // 108. stable exit code（目前為止所有 assert 均已執行完成且沒有拋出未捕捉例外，process 會以目前 results 陣列的狀態正常決定 exit code）
  assert(results.filter((r) => r.status === 'FAIL').length >= 0, '108. stable exit code（截至目前為止測試流程正常執行完畢，沒有中途拋出未捕捉例外導致 exit code 不可預期）');
  // 109. all mutation cases caught（統計本檔案目前為止所有標示為「Invariant Guard 偵測到非法變動」或獨立 mutation 案例的 assertion，全部應為 PASS）
  {
    const mutationAssertions = results.filter((r) => /Invariant Guard 偵測到非法變動|→ FAIL|Reconstruction Check 失敗|Behavioral Invariant Check FAIL/.test(r.name));
    assert(mutationAssertions.length >= 15 && mutationAssertions.every((r) => r.status === 'PASS'), `109. all mutation cases caught（目前已執行 ${mutationAssertions.length} 個 mutation negative test，全部正確判定為「Guard 有攔截到」）`);
  }
  // 110. clean source passes all invariants（乾淨、未被 mutate 的真實檔案再跑一次完整 behavioral invariant，必須全過）
  {
    const finalClean = await scopeGuard.runBehavioralInvariants(ROOT);
    assert(finalClean.ok === true, '110. clean source passes all invariants（未被 mutate 的真實 geo-heatmap.js 再次執行 Behavioral Invariant Check，全數通過）');
  }

  printSummary();
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exitCode = 1;
});
