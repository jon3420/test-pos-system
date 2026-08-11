#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-3-a7-geo-kpi-single-source.js
// fix18-10-hotfix30-B5-R5.3-A7 — Geo KPI Single Source Integration
//
// 驗證：「Geo 訪客/加購/結帳/訂單」（及同一組卡片的 Geo 成交率/Geo 辨識率/
// Unknown 比例）KPI 卡片正式資料來源改為 geoVisitorState.funnel（Geo Event
// Engine），不再讀 vm.funnel（getGeoFunnel()，Unknown 訪客在
// _visitorGeoAttributionCTE() 就被整筆排除——R5.3-A6 診斷出的根因）。
// getGeoFunnel()／/api/analytics/geo/funnel／舊行政區排行榜／Choropleth
// 完全保留，只是不再驅動這一組 KPI。

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
  console.log('SMOKE TEST SUMMARY — fix18-10-hotfix30-B5-R5.3-A7 (Geo KPI Single Source Integration)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 0. JS Parse
  // ══════════════════════════════════════════════════════════════
  ['public/js/geo-intelligence.js', 'public/js/geo-visitor-layer.js', 'public/js/geo-heatmap-ui.js'].forEach((rel) => {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      pass(`0-parse ${rel} node --check 通過`);
    } catch (e) {
      fail(`0-parse ${rel} node --check 通過`, e.message);
    }
  });

  // ══════════════════════════════════════════════════════════════
  // Part A：純函式單元測試（Node require，不需要 jsdom）
  // ══════════════════════════════════════════════════════════════
  global.escHtml = function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };
  global._card = function _card(label, value, sub, color) {
    return `<div style="border:1px solid ${color || '#000'}"><div>${escHtml(label)}</div><div>${escHtml(String(value))}</div>${sub ? `<div>${escHtml(sub)}</div>` : ''}</div>`;
  };

  delete require.cache[path.join(ROOT, 'public/js/geo-intelligence.js')];
  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ── A1. geoKpiSourceStatus()：四態判斷 ──────────────────────────
  {
    delete global.geoVisitorState;
    assert(RE.geoKpiSourceStatus() === 'idle', 'A1-1 geoVisitorState 完全不存在（腳本未載入）時 status=idle');

    global.geoVisitorState = { status: 'idle' };
    assert(RE.geoKpiSourceStatus() === 'idle', 'A1-2 status=idle 時 =idle');

    global.geoVisitorState = { status: 'loading', funnel: null };
    assert(RE.geoKpiSourceStatus() === 'loading', 'A1-3 status=loading、funnel=null 時 =loading');

    global.geoVisitorState = { status: 'error', funnel: null };
    assert(RE.geoKpiSourceStatus() === 'error', 'A1-4 status=error 時 =error（即使 funnel 是 null）');

    global.geoVisitorState = { status: 'error', funnel: { visitors: 99 } };
    assert(RE.geoKpiSourceStatus() === 'error', 'A1-5 status=error 時 =error（即使 funnel 有殘留舊資料，不得被誤判成 ready）');

    global.geoVisitorState = { status: 'ready', funnel: { visitors: 0 } };
    assert(RE.geoKpiSourceStatus() === 'empty', 'A1-6 status=ready 且 visitors=0 時 =empty（跟 loading 不同）');

    global.geoVisitorState = { status: 'ready', funnel: { visitors: 3 } };
    assert(RE.geoKpiSourceStatus() === 'ready', 'A1-7 status=ready 且 visitors>0 時 =ready');

    global.geoVisitorState = { status: 'ready', funnel: null };
    assert(RE.geoKpiSourceStatus() === 'idle', 'A1-8 status=ready 但 funnel=null（防禦性邊界情況）不誤判成 ready/empty');
  }

  // ── A2. geoAdaptEventEngineFunnelForKpi()：Adapter 正確轉換 ─────
  {
    global.geoVisitorState = { status: 'loading', funnel: null };
    const loadingAdapted = RE.geoAdaptEventEngineFunnelForKpi();
    assert(loadingAdapted.status === 'loading', 'A2-1 loading 時 status=loading');
    assert(loadingAdapted.kpi === null && loadingAdapted.quality === null, 'A2-2 loading 時 kpi/quality 皆為 null（呼叫端必須先檢查 status，不得誤取值）');

    global.geoVisitorState = { status: 'error' };
    const errAdapted = RE.geoAdaptEventEngineFunnelForKpi();
    assert(errAdapted.status === 'error' && errAdapted.kpi === null, 'A2-3 error 時 status=error，kpi=null');

    // 情境 A（需求文件十）：Unknown add_to_cart-only visitor
    global.geoVisitorState = {
      status: 'ready',
      funnel: {
        visitors: 1, add_to_cart_visitors: 1, begin_checkout_visitors: 0, purchase_visitors: 0,
        known_district_visitors: 0, unknown_visitors: 1, unknown_rate: 100, visitor_to_purchase_rate: 0,
      },
    };
    const scenarioA = RE.geoAdaptEventEngineFunnelForKpi();
    assert(scenarioA.status === 'ready', 'A2-4（情境A）status=ready');
    assert(scenarioA.kpi.visitors === 1, 'A2-5（情境A）Geo Visitors = 1');
    assert(scenarioA.kpi.add_to_cart_visitors === 1, 'A2-6（情境A）Geo Add To Cart = 1');
    assert(scenarioA.known_visitors === 0, 'A2-7（情境A）Known = 0');
    assert(scenarioA.unknown_visitors === 1, 'A2-8（情境A）Unknown = 1（不得排除、不得讓總數歸零）');
    assert(scenarioA.coverage === 0, 'A2-9（情境A）Coverage = 0%');
    assert(scenarioA.quality.unknown_rate === 1, 'A2-10（情境A）quality.unknown_rate = 1（100%）');
    assert(scenarioA.quality.identified_rate === 0, 'A2-11（情境A）quality.identified_rate = 0');

    // 情境 B：Known page_view visitor
    global.geoVisitorState = {
      status: 'ready',
      funnel: {
        visitors: 1, add_to_cart_visitors: 0, begin_checkout_visitors: 0, purchase_visitors: 0,
        known_district_visitors: 1, unknown_visitors: 0, unknown_rate: 0, visitor_to_purchase_rate: 0,
      },
    };
    const scenarioB = RE.geoAdaptEventEngineFunnelForKpi();
    assert(scenarioB.known_visitors === 1, 'A2-12（情境B）Known = 1');
    assert(scenarioB.unknown_visitors === 0, 'A2-13（情境B）Unknown = 0');
    assert(scenarioB.coverage === 1, 'A2-14（情境B）Coverage = 100%');

    // 情境 C：page_view + view_product + add_to_cart，去重為 1 人
    global.geoVisitorState = {
      status: 'ready',
      funnel: {
        visitors: 1, add_to_cart_visitors: 1, begin_checkout_visitors: 0, purchase_visitors: 0,
        known_district_visitors: 0, unknown_visitors: 1, unknown_rate: 100, visitor_to_purchase_rate: 0,
      },
    };
    const scenarioC = RE.geoAdaptEventEngineFunnelForKpi();
    assert(scenarioC.kpi.visitors === 1, 'A2-15（情境C）多事件仍去重為 Visitors=1（不是 3）');
    assert(scenarioC.kpi.add_to_cart_visitors === 1, 'A2-16（情境C）Add To Cart = 1');

    // conversion_rate / submitted_order_visitors 欄位對應正確（新→舊形狀）
    global.geoVisitorState = {
      status: 'ready',
      funnel: {
        visitors: 10, add_to_cart_visitors: 5, begin_checkout_visitors: 3, purchase_visitors: 2,
        known_district_visitors: 8, unknown_visitors: 2, unknown_rate: 20, visitor_to_purchase_rate: 20,
      },
    };
    const scenarioNum = RE.geoAdaptEventEngineFunnelForKpi();
    assert(scenarioNum.kpi.submitted_order_visitors === 2, 'A2-17 f.purchase_visitors 正確對應成舊形狀的 submitted_order_visitors');
    assert(Math.abs(scenarioNum.kpi.conversion_rate - 0.2) < 1e-9, 'A2-18 f.visitor_to_purchase_rate(20) 正確轉成 0-1 比例 0.2（geoBuildKpiSummaryCards 內部用 _geoPct ×100）');
    assert(Math.abs(scenarioNum.coverage - 0.8) < 1e-9, 'A2-19 coverage = known/visitors = 0.8');
  }

  // ── A3. geoBuildKpiSummaryCards() 保持 100% 不變（純函式，既有 regression 原樣重跑） ──
  {
    const cards = RE.geoBuildKpiSummaryCards(
      { visitors: 128, add_to_cart_visitors: 60, begin_checkout_visitors: 30, submitted_order_visitors: 12, conversion_rate: 0.0938 },
      { identified_rate: 0.91, unknown_rate: 0.09 },
      { fulfillment_geo: { average_distance_km: 3.4 } },
    );
    assert(Array.isArray(cards) && cards.length >= 6, 'A3-1 geoBuildKpiSummaryCards() 簽名/輸出結構未變（至少 6 張卡片）');
    const visitorsCard = cards.find((c) => c.label === 'Geo 訪客');
    assert(visitorsCard && visitorsCard.value === 128, 'A3-2 Geo 訪客卡片仍正確讀 kpi.visitors');
    const zeroCards = RE.geoBuildKpiSummaryCards({ visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, submitted_order_visitors: 0, conversion_rate: 0 }, { identified_rate: 0, unknown_rate: 1 }, {});
    assert(zeroCards.find((c) => c.label === 'Geo 訪客').formatted_value === '0 人', 'A3-3 0 值仍正確格式化為「0 人」（未被 A7 改壞）');
    assert(zeroCards.find((c) => c.label === 'Unknown 比例').status === 'warning', 'A3-4 Unknown 100% 時 status=warning（未被 A7 改壞）');
    const nullCards = RE.geoBuildKpiSummaryCards(null, null, null);
    assert(nullCards.find((c) => c.label === 'Geo 訪客').formatted_value === '0 人', 'A3-5 kpi=null 不崩潰（未被 A7 改壞）');
  }

  // ── A4. _geoRenderKpiLiveHtml()：四態 HTML 輸出正確 ─────────────
  {
    global.geoVisitorState = { status: 'idle', funnel: null };
    const loadingHtml = RE._geoRenderKpiLiveHtml({});
    assert(loadingHtml.includes('載入中…'), 'A4-1 idle/loading 狀態顯示「載入中…」佔位文字');
    assert(!/[>＝=]\s*0\s*人/.test(loadingHtml), 'A4-2 loading 狀態不顯示「0 人」（避免跟真正的 0 混淆，需求文件五）');
    assert(loadingHtml.includes('進站訪客') && loadingHtml.includes('載入中…'), 'A4-3 5-card 相容區塊在 loading 狀態也顯示「載入中…」，不是假數字');

    global.geoVisitorState = { status: 'error', funnel: { visitors: 999 } };
    const errorHtml = RE._geoRenderKpiLiveHtml({});
    assert(errorHtml.includes('無法載入'), 'A4-4 error 狀態顯示「無法載入」');
    assert(!errorHtml.includes('999'), 'A4-5（情境E）error 狀態絕不顯示殘留的舊 funnel 數字（999 不得出現）');
    assert(errorHtml.includes('data-geo-kpi-state="error"'), 'A4-6 error 狀態有明確的 data 屬性可供樣式/測試辨識');

    global.geoVisitorState = { status: 'ready', funnel: { visitors: 0, add_to_cart_visitors: 0, begin_checkout_visitors: 0, purchase_visitors: 0, known_district_visitors: 0, unknown_visitors: 0, unknown_rate: 0, visitor_to_purchase_rate: 0 } };
    const emptyHtml = RE._geoRenderKpiLiveHtml({});
    assert(emptyHtml.includes('0 人'), 'A4-7 empty（ready 但 visitors=0）正確顯示「0 人」，不是「載入中…」');
    assert(!emptyHtml.includes('載入中…'), 'A4-8 empty 不得跟 loading 混為一談（需求文件五）');

    global.geoVisitorState = {
      status: 'ready',
      funnel: { visitors: 7, add_to_cart_visitors: 4, begin_checkout_visitors: 2, purchase_visitors: 1, known_district_visitors: 3, unknown_visitors: 4, unknown_rate: 57.1, visitor_to_purchase_rate: 14.3 },
    };
    const readyHtml = RE._geoRenderKpiLiveHtml({ fulfillment_geo: { average_distance_km: 5.5 } });
    assert(readyHtml.includes('7 人'), 'A4-9 ready 狀態 Geo 訪客顯示正確數字 7 人');
    assert(readyHtml.includes('4 人'), 'A4-10 ready 狀態 Geo 加購顯示正確數字 4 人');
    assert(readyHtml.includes('5.5 km'), 'A4-11 平均外送距離卡片不受 A7 影響，仍正確顯示（獨立資料源 overview.fulfillment_geo）');
    // 5-card 相容區塊必須跟 8-card 用同一個 adapter 結果，不得各自轉換出不同數字
    const sevenCount = (readyHtml.match(/7/g) || []).length;
    assert(sevenCount >= 2, 'A4-12 Single Source：8-card 與 5-card 相容區塊的訪客數字一致（都來自同一次 adapter 呼叫，7 至少出現兩次）');
  }

  // ── A5. Store Isolation：切店時 status 正確重置 ─────────────────
  delete require.cache[path.join(ROOT, 'public/js/geo-visitor-layer.js')];
  const GVL = require(path.join(ROOT, 'public/js/geo-visitor-layer.js'));
  {
    GVL.geoVisitorState.status = 'ready';
    GVL.geoVisitorState.funnel = { visitors: 5 };
    GVL.geoVisitorHandleStoreSwitch();
    assert(GVL.geoVisitorState.status === 'idle', 'A5-1 geoVisitorHandleStoreSwitch() 後 status 重置為 idle（不沿用上一店的 ready）');
    assert(GVL.geoVisitorState.funnel === null, 'A5-2 geoVisitorHandleStoreSwitch() 後 funnel 清空（既有行為，未被 A7 破壞）');

    GVL._geoVisitorResetStateForTest();
    assert(GVL.geoVisitorState.status === 'idle', 'A5-3 _geoVisitorResetStateForTest() 後 status=idle');
  }

  // ── A6. Metric 切換不需要重新 fetch（同一份已載入的 funnel 只是換顯示欄位） ──
  {
    GVL.geoVisitorState.status = 'ready';
    GVL.geoVisitorState.funnel = { visitors: 5, add_to_cart_visitors: 3, begin_checkout_visitors: 1, purchase_visitors: 0, known_district_visitors: 2, unknown_visitors: 3, unknown_rate: 60, visitor_to_purchase_rate: 0 };
    const beforeSwitch = JSON.stringify(GVL.geoVisitorState.funnel);
    GVL.geoVisitorSetMetric('test-container', 'add_to_cart');
    assert(GVL.geoVisitorState.metric === 'add_to_cart', 'A6-1 geoVisitorSetMetric() 正確切換 metric');
    assert(JSON.stringify(GVL.geoVisitorState.funnel) === beforeSwitch, 'A6-2 切換 metric 不清空/不改變已載入的 funnel（不需要重新 fetch，同一份資料換顯示欄位）');
    assert(GVL.geoVisitorState.status === 'ready', 'A6-3 切換 metric 不影響 status（仍是 ready）');
  }

  // ── A7. Static Audit：Source-of-Truth 唯一性 + 保留範圍 ─────────
  {
    const geoIntelSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    const kpiLiveFnMatch = geoIntelSrc.match(/function _geoRenderKpiLiveHtml\([\s\S]*?\n}\n/);
    const kpiLiveFnBody = kpiLiveFnMatch ? kpiLiveFnMatch[0] : '';
    assert(kpiLiveFnBody.length > 0, 'A7-1 找到 _geoRenderKpiLiveHtml() 函式本體');
    assert(!/vm\.funnel/.test(kpiLiveFnBody), 'A7-2 _geoRenderKpiLiveHtml() 本體完全不讀取 vm.funnel（Source-of-Truth Guard）');
    assert(!/computeGeoDashboardKpi/.test(kpiLiveFnBody), 'A7-3 _geoRenderKpiLiveHtml() 本體完全不呼叫 computeGeoDashboardKpi(vm)（不得混用兩套引擎）');

    const adapterMatch = geoIntelSrc.match(/function geoAdaptEventEngineFunnelForKpi\([\s\S]*?\n}\n/);
    const adapterBody = adapterMatch ? adapterMatch[0] : '';
    assert(adapterBody.length > 0, 'A7-4 找到 geoAdaptEventEngineFunnelForKpi() adapter 函式本體');
    assert(!/vm\./.test(adapterBody), 'A7-5 adapter 本身不接受/不讀取 vm，只讀 geoVisitorState（單一 Source of Truth）');
    assert(!/console\.warn|console\.log/.test(adapterBody), 'A7-6 adapter 內沒有 debug log');

    // getGeoFunnel()／/api/analytics/geo/funnel 保留（不得刪除）
    const backendSrc = fs.readFileSync(path.join(ROOT, 'utils/geoAnalyticsQueries.js'), 'utf8');
    assert(backendSrc.includes('function getGeoFunnel('), 'A7-7 getGeoFunnel() 仍存在（未刪除，需求文件三）');
    const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics-geo.js'), 'utf8');
    assert(routeSrc.includes(`router.get('/funnel'`), 'A7-8 GET /api/analytics/geo/funnel 仍存在（未刪除，需求文件三）');
    // 舊 kpi/computeGeoDashboardKpi 保留給行政區聚合/空狀態判斷用途，且有清楚註解標記
    assert(/legacy area aggregation only/.test(geoIntelSrc), 'A7-9 原始碼含「legacy area aggregation only」註解，標記 getGeoFunnel()/vm.funnel 剩餘保留用途');
    assert(geoIntelSrc.includes('function computeGeoDashboardKpi('), 'A7-10 computeGeoDashboardKpi() 仍存在（未刪除，繼續服務行政區排行榜/空狀態判斷）');

    // 呼叫點：refreshGeoDashboardKpiBlock 裡的 kpiCards 不再由 kpi.* 組成
    const refreshFnMatch = geoIntelSrc.match(/async function refreshGeoDashboardKpiBlock\([\s\S]*?\n}\n\n/);
    const refreshFnBody = refreshFnMatch ? refreshFnMatch[0] : '';
    assert(refreshFnBody.length > 0, 'A7-11 找到 refreshGeoDashboardKpiBlock() 函式本體');
    assert(!/geoBuildKpiSummaryCards\(\s*\{\s*visitors:\s*kpi\.visitors/.test(refreshFnBody), 'A7-12 refreshGeoDashboardKpiBlock() 不再把 kpi.visitors（vm.funnel 算出來的）直接塞進 geoBuildKpiSummaryCards()');
    assert(refreshFnBody.includes('_geoRenderKpiLiveHtml('), 'A7-13 refreshGeoDashboardKpiBlock() 改用 _geoRenderKpiLiveHtml() 產生 KPI 卡片');
    assert(refreshFnBody.includes('geo-kpi-live'), 'A7-14 KPI 卡片包在固定 id 容器裡，供之後同步更新（section 8）');

    // 不新增第三套 KPI Engine / 不新增 API
    const geoVisitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8');
    assert(!/\/api\/analytics\/geo\/(?!visitor-log)[a-z-]+.*fetch/i.test(geoVisitorSrc.split('geoVisitorFetchAndRender')[1] || ''), 'A7-15 geoVisitorFetchAndRender() 仍只呼叫 visitor-log 這一支既有端點，沒有新增 API');
    assert(!/Math\.random\(\)/.test(geoIntelSrc.match(/function geoAdaptEventEngineFunnelForKpi[\s\S]*?function _geoRenderKpiLiveHtml[\s\S]*?\n}\n/)?.[0] || geoIntelSrc), 'A7-16 A7 新增的程式碼區塊沒有 Math.random()');
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom 實測（同步更新／No Legacy Fallback／Regression Guard）
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    console.log('[MANUAL REQUIRED] Part B（jsdom 層級行為測試）：jsdom 未安裝，改為人工驗證');
    printSummary();
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2Src = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoVisitorSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-visitor-layer.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  // geo-heatmap.js defines GEO_HEAT_METRICS 等常數，geo-heatmap-ui.js 依賴它
  // （Order Heatmap Engine，本輪完全未修改，純粹是既有相依關係，需要一起載入）。
  const geoHeatSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoHeatUiSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-heatmap-ui.js'), 'utf8').replace(/'use strict';\s*\n/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="db-body-v2"></div></body></html>', { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  function geoOverviewFixture() {
    return {
      visitor_geo: { identified_visitors: 80, unknown_visitors: 15, identified_rate: 0.842 },
      fulfillment_geo: { orders_with_geo: 12, orders_without_geo: 2, average_distance_km: 3.2, average_delivery_fee: 45 },
      top_areas: [{ city: '桃園市', district: '中壢區', visitors: 42 }],
      data_quality: { status: 'healthy', total_events: 200, identified_events: 190, unknown_events: 10, identified_rate: 0.95, unknown_rate: 0.05, minimum_sample: 10 },
    };
  }
  // 需求文件情境 D（本輪最重要的 Regression Guard）：舊 getGeoFunnel().areas
  // 故意留空，模擬 R5.3-A6 診斷出的真實情況（Unknown 訪客被 CTE 排除）。
  function geoFunnelFixtureEmpty() { return { page: 1, limit: 100, areas: [] }; }
  function geoAlertsFixture() { return { alerts: [], rule_thresholds: {} }; }
  function geoCountySummaryFixture() { return { ok: true, rows: [], unknown: { visitor_count: 0, percentage: 0 } }; }
  // Geo Event Engine（新引擎）回應：故意跟上面的舊 funnel 給不同、且非零的數字，
  // 用來證明 KPI 卡片顯示的是「這個」而不是舊 funnel 的空陣列。
  function geoVisitorLogFixture(overrides) {
    return Object.assign({
      range: 'today',
      summary: { geo_visitors: 1, geo_visitors_known: 0, geo_visitors_unknown: 1, unknown_rate: 100 },
      areas: [], recent: [],
      funnel: {
        visitors: 1, view_item_visitors: 0, add_to_cart_visitors: 1, begin_checkout_visitors: 0,
        purchase_visitors: 0, purchase_orders: null, revenue: null, revenue_source: null,
        cart_abandonment_visitors: 1, checkout_abandonment_visitors: 0,
        known_district_visitors: 0, unknown_visitors: 1, unknown_rate: 100,
        visitor_to_cart_rate: 100, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0,
        visitor_to_purchase_rate: 0, cart_conversion_rate: 0, checkout_conversion_rate: 0,
      },
      recommendation_risk: { basis: '規則式計算，非 AI', sufficient_data: false, message: 'Insufficient Data', signals: null },
      coverage: { total: 1, known_district: 0, unknown: 1, unknown_rate: 100, coverage_pct: 0 },
    }, overrides || {});
  }

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url) => {
      const u = String(url);
      fetchCalls.push({ url: u, t: Date.now() });
      let body = { success: false }; let status = 404;
      if (opts.visitorLogFails && u.includes('/api/analytics/geo/visitor-log')) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({ success: false, error: 'forced' }) });
      }
      if (u.includes('/api/analytics/geo/overview')) { body = { success: true, data: geoOverviewFixture() }; status = 200; }
      else if (u.includes('/api/analytics/geo/funnel')) { body = { success: true, data: geoFunnelFixtureEmpty() }; status = 200; }
      else if (u.includes('/api/analytics/geo/alerts')) { body = { success: true, data: geoAlertsFixture() }; status = 200; }
      else if (u.includes('/api/analytics/geo/county-summary')) { body = geoCountySummaryFixture(); status = 200; }
      else if (u.includes('/api/analytics/geo/visitor-log')) { body = { success: true, data: (opts.visitorLogFor ? opts.visitorLogFor() : geoVisitorLogFixture()) }; status = 200; }
      return Promise.resolve({ ok: status === 200, status, json: async () => body });
    };
  }

  async function setupDashboard(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc + '\n;\n' + geoVisitorSrc + '\n;\n' + geoHeatSrc + '\n;\n' + geoHeatUiSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'a7_store' };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '', timezone: 'Asia/Taipei' };
    const containerId = 'geo-a7-test';
    const div = dom.window.document.createElement('div');
    div.id = containerId;
    dom.window.document.body.appendChild(div);
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 30));
    return { dom, container: dom.window.document.getElementById(containerId), fetchCalls, containerId };
  }

  // ── B1.（情境 D，本輪最重要的 Regression Guard）舊 funnel.areas=[]，
  //    新 geoVisitorState.funnel.visitors=1 → KPI 必須顯示 1，不得顯示 0 ──
  {
    const { container, fetchCalls } = await setupDashboard();
    const html = container.innerHTML;
    assert(fetchCalls.some((c) => c.url.includes('/api/analytics/geo/visitor-log')), 'B1-1（需求文件八）頁面初次 mount 就自動呼叫 /visitor-log，不需要手動切 Heatmap Tab');
    assert(html.includes('1 人'), 'B1-2（情境D）KPI 顯示新引擎的 1，即使舊 getGeoFunnel().areas=[]');
    assert(!/(^|[^0-9])0\s*人/.test(html.match(/Geo 訪客[\s\S]{0,200}/)?.[0] || ''), 'B1-3（情境D）Geo 訪客卡片不顯示 0（不得因為舊 areas=[] 而顯示 0）');
    assert(html.includes('進站訪客'), 'B1-4 5-card 相容子字串仍存在（向下相容，需求文件十二 No UI 結構改變）');
    assert(html.includes('Geo 訂單'), 'B1-5 8-card 主卡片仍存在');
    assert(!html.includes('undefined') && !html.includes('NaN'), 'B1-6 渲染結果沒有 undefined/NaN 字面文字');
  }

  // ── B2. 情境 A：Unknown add_to_cart-only visitor ────────────────
  {
    const { container } = await setupDashboard({
      visitorLogFor: () => geoVisitorLogFixture({
        funnel: { visitors: 1, view_item_visitors: 0, add_to_cart_visitors: 1, begin_checkout_visitors: 0, purchase_visitors: 0, purchase_orders: null, revenue: null, revenue_source: null, cart_abandonment_visitors: 1, checkout_abandonment_visitors: 0, known_district_visitors: 0, unknown_visitors: 1, unknown_rate: 100, visitor_to_cart_rate: 100, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visitor_to_purchase_rate: 0, cart_conversion_rate: 0, checkout_conversion_rate: 0 },
      }),
    });
    const html = container.innerHTML;
    assert(html.includes('Unknown 比例'), 'B2-1（情境A）Unknown 比例卡片存在');
    const unknownCardMatch = html.match(/Unknown 比例[\s\S]{0,200}/);
    assert(unknownCardMatch && unknownCardMatch[0].includes('100%'), 'B2-2（情境A）Unknown 比例正確顯示 100%（Coverage 0%）');
  }

  // ── B3. 情境 B：Known visitor → Coverage 100% ───────────────────
  {
    const { container } = await setupDashboard({
      visitorLogFor: () => geoVisitorLogFixture({
        funnel: { visitors: 1, view_item_visitors: 1, add_to_cart_visitors: 0, begin_checkout_visitors: 0, purchase_visitors: 0, purchase_orders: null, revenue: null, revenue_source: null, cart_abandonment_visitors: 0, checkout_abandonment_visitors: 0, known_district_visitors: 1, unknown_visitors: 0, unknown_rate: 0, visitor_to_cart_rate: 0, cart_to_checkout_rate: 0, checkout_to_purchase_rate: 0, visitor_to_purchase_rate: 0, cart_conversion_rate: 0, checkout_conversion_rate: 0 },
      }),
    });
    const html = container.innerHTML;
    const idCardMatch = html.match(/Geo 辨識率[\s\S]{0,200}/);
    assert(idCardMatch && idCardMatch[0].includes('100%'), 'B3-1（情境B）Known 訪客時 Geo 辨識率（Coverage）正確顯示 100%');
  }

  // ── B4.（情境E）新 Geo Event Engine API 失敗 → 顯示錯誤狀態，不得偷偷 fallback 成舊數字或假裝 0 ──
  {
    const { container } = await setupDashboard({ visitorLogFails: true });
    const html = container.innerHTML;
    assert(html.includes('無法載入'), 'B4-1（情境E）API 失敗時 KPI 卡片顯示「無法載入」');
    // H1.4.5 測試基礎設施修正（Test Infrastructure Fix，非 Production 變更）：
    //
    // Reality Audit：這條斷言原本對整個 container.innerHTML（含畫面下方一段真實、
    // 會隨時間變動的「最後更新：HH:MM:SS」時鐘字串，來源是 geo-intelligence.js
    // 第 1772/1876 行的 `new Date(vm.updated_at).toLocaleTimeString(...)`，屬於
    // 正常、正確的 Production 行為，不是這次要抓的 bug）做全文 `includes('42')`
    // 掃描。用 60 次連續重跑＋HTML context dump 實際捉到過一次失敗，證實原因是
    // 當下時鐘剛好落在「秒數＝42」（例如「最後更新：09:18:42」），跟本斷言真正要
    // 驗證的「KPI 卡片不得 fallback 顯示舊 getGeoFunnel() fixture 的 42」完全無關
    // ——重現率約 1/60（≈1.67%，與「每分鐘 60 秒中剛好命中 42 那一秒」的機率一致）。
    // 修正方式：只排除「最後更新」這段已知、確定會隨時間變動的時間戳文字之後的
    // 內容，其餘所有畫面內容（KPI 卡片、5-card 相容區塊等）仍完整檢查，不縮小
    // 對「KPI 卡片本身不得顯示 42」這個原本業務驗證的覆蓋範圍。
    const htmlBeforeTimestamp = html.split('最後更新')[0];
    assert(!htmlBeforeTimestamp.includes('42'), 'B4-2（情境E）不得 fallback 顯示舊 getGeoFunnel() fixture 的數字（42）（排除下方會隨時間變動、內容正常的「最後更新」時鐘文字）');
    assert(html.includes('data-geo-kpi-state="error"'), 'B4-3（情境E）error 狀態有明確 data 屬性');
  }

  // ── B5.（需求文件八）日期切換／重新整理 觸發新的 /visitor-log 請求 ──
  {
    const { dom, fetchCalls, containerId } = await setupDashboard();
    const firstCount = fetchCalls.filter((c) => c.url.includes('/visitor-log')).length;
    assert(firstCount >= 1, 'B5-1 初次 mount 至少有一次 /visitor-log 請求');
    dom.window.dashboardDateState = { preset: 'custom', start_date: '2026-07-10', end_date: '2026-07-15' };
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 30));
    const secondCount = fetchCalls.filter((c) => c.url.includes('/visitor-log')).length;
    assert(secondCount > firstCount, 'B5-2（需求文件八）日期切換後重新整理，/visitor-log 被再次呼叫（不需要手動切 Heatmap Tab）');
  }

  // ── B6. Store Isolation：切店後不沿用上一店的 KPI 數字 ──────────
  {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, {});
    dom.window.addEventListener('error', () => {});
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc + '\n;\n' + geoVisitorSrc + '\n;\n' + geoHeatSrc + '\n;\n' + geoHeatUiSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.dashboardDateState = { preset: 'today', start_date: '', end_date: '' };
    const containerId = 'geo-a7-store-switch';
    const div = dom.window.document.createElement('div');
    div.id = containerId;
    dom.window.document.body.appendChild(div);

    dom.window.currentStore = { store_id: 'store_1' };
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 30));
    assert(dom.window.geoVisitorState.status === 'ready', 'B6-1 store_1 載入後 status=ready');

    dom.window.currentStore = { store_id: 'store_2' };
    // 呼叫 geoHeatUiRegisterContext 前一律先呼叫 geoVisitorHandleStoreSwitch()
    // （見 geo-heatmap-ui.js），這裡直接觸發一次完整重新整理來模擬切店。
    await dom.window.refreshGeoDashboardKpiBlock(containerId);
    await new Promise((r) => setTimeout(r, 30));
    assert(dom.window.geoVisitorState.status === 'ready', 'B6-2 切到 store_2 後重新 fetch 成功，status 仍是 ready（不是殘留 store_1 的中間態）');
  }

  // ── B7. No console warning 混入 legacy 保留區塊（需求文件七） ───
  {
    const geoIntelSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    const legacyCommentIdx = geoIntelSrc.indexOf('legacy area aggregation only');
    assert(legacyCommentIdx > -1, 'B7-1 legacy area aggregation only 註解存在');
    const nearby = geoIntelSrc.slice(Math.max(0, legacyCommentIdx - 200), legacyCommentIdx + 200);
    assert(!/console\.warn/.test(nearby), 'B7-2 legacy 保留區塊註解附近沒有 console.warn（需求文件七：不得使用 console warning）');
  }

  printSummary();
  process.exit(process.exitCode || 0); // jsdom 的 app.js startClock() setInterval 會讓事件迴圈不結束，需明確 exit
}

main().catch((e) => { console.error(e); process.exitCode = 1; process.exit(1); });
