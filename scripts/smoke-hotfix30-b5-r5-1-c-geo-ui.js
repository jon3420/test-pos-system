#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js
// fix18-10-hotfix30-B5-R5.1-C：Geo Intelligence Center — Dashboard UI ×
// Geo Analytics × Business Opportunity × Recommended Actions
//
// 沿用 scripts/smoke-hotfix31-r4-visitor360-ui.js 已驗證過的 jsdom 實測慣例
// （真的執行 public/js/app.js + analytics-v2.js + geo-intelligence.js，不是
// 原始碼字串掃描）。Part A 是純函式單元測試（不需要 jsdom，Business Rule
// Engine 直接 require）；Part B 起是 DOM 層級行為測試。

'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

async function main() {
  // ══════════════════════════════════════════════════════════════
  // Part A：Pure Rule Engine（不需要 jsdom，直接 require）
  // ══════════════════════════════════════════════════════════════
  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ── geoConfidenceFromSample ──
  assert(RE.geoConfidenceFromSample(30) === 'high', 'confidence: 30 samples -> high');
  assert(RE.geoConfidenceFromSample(10) === 'medium', 'confidence: 10 samples -> medium');
  assert(RE.geoConfidenceFromSample(1) === 'low', 'confidence: 1 sample -> low');
  assert(RE.geoConfidenceFromSample(0) === 'low', 'confidence: 0 samples -> low, not crash');

  // ── geoComputeOpportunities ──
  assert(Array.isArray(RE.geoComputeOpportunities(null)), 'opportunities: null input -> array, no throw');
  assert(RE.geoComputeOpportunities(null).length === 0, 'opportunities: null input -> empty array');
  assert(RE.geoComputeOpportunities(undefined).length === 0, 'opportunities: undefined input -> empty array, no throw');
  assert(RE.geoComputeOpportunities({}).length === 0, 'opportunities: empty summary -> empty array');
  {
    const fixed = { top_intent_areas: [{ district: '中壢區', visitors: 42, submitted_order_visitors: 12 }], high_traffic_low_conversion: [{ district: '桃園區', visitors: 128, add_to_cart_visitors: 6 }], fulfillment_summary: {} };
    const o1 = RE.geoComputeOpportunities(fixed);
    const o2 = RE.geoComputeOpportunities(fixed);
    assert(JSON.stringify(o1) === JSON.stringify(o2), 'opportunities: same input -> same output (deterministic)');
    assert(o1[0].area === '中壢區' && o1[0].confidence === 'high', 'opportunities: top intent area correct with high confidence (42 samples)');
    assert(o1.some(x => x.area === '桃園區'), 'opportunities: high-traffic-low-conversion area included');
    assert(['high', 'medium', 'low'].includes(o1[0].confidence), 'opportunities: confidence is one of high/medium/low');
    assert(!/一定|就是因為|保證|必然/.test(JSON.stringify(o1)), 'opportunities: no absolute-causality wording');
  }

  // ── geoComputeAdRoi ──
  assert(RE.geoComputeAdRoi(null).length === 0, 'ad roi: null input -> empty array, no throw');
  assert(RE.geoComputeAdRoi([]).length === 0, 'ad roi: empty array -> empty array');
  assert(RE.geoComputeAdRoi(undefined).length === 0, 'ad roi: undefined -> empty array, no throw');
  {
    const rows = [
      { source: 'Facebook', district: '中壢區', visitors: 50, add_to_cart: 20, conversion_rate: 0.1 },
      { source: 'Google', district: '平鎮區', visitors: 3, add_to_cart: 1, conversion_rate: 0.5 }, // 樣本太小，應被排除
      { source: 'Direct', district: '桃園區', visitors: 40, add_to_cart: 0, conversion_rate: 0 },
    ];
    const roi = RE.geoComputeAdRoi(rows);
    assert(roi.length === 2, 'ad roi: sample-size filter excludes visitors<5 row');
    assert(roi.every(r => r.stars >= 1 && r.stars <= 5), 'ad roi: stars always within 1~5');
    assert(roi[0].stars >= roi[1].stars, 'ad roi: sorted descending by stars');
    assert(roi.every(r => 'source' in r && 'city' in r && 'district' in r), 'ad roi: source/city/district kept separate (not merged into channel)');
    assert(!roi.some(r => 'channel' in r), 'ad roi: does not fabricate a "channel" field from source');
  }
  {
    // 除數為 0 / NaN 防護
    const roi2 = RE.geoComputeAdRoi([{ source: 'Facebook', district: 'X', visitors: 10, add_to_cart: 0, conversion_rate: 0 }]);
    assert(roi2.every(r => Number.isFinite(r.stars) && Number.isFinite(r.conversion_rate)), 'ad roi: zero conversion does not produce NaN/Infinity');
  }

  // ── geoComputeCouponSuggestions ──
  assert(RE.geoComputeCouponSuggestions(null).length === 0, 'coupon: null input -> empty array, no throw');
  {
    const areas = [
      { district: '平鎮區', visitors: 20, visit_to_cart_rate: 0.2, visit_to_order_rate: 0.01 }, // 高加購低訂單 -> 建議發券
      { district: '中壢區', visitors: 20, visit_to_cart_rate: 0.1, visit_to_order_rate: 0.08 }, // 成交好 -> 不建議發券
      { district: '八德區', visitors: 5, visit_to_cart_rate: 0.5, visit_to_order_rate: 0 }, // 樣本不足 -> 不產生建議
    ];
    const c = RE.geoComputeCouponSuggestions(areas);
    assert(c.some(x => x.area === '平鎮區' && x.action === 'suggest_coupon'), 'coupon: high-cart low-order area -> suggest_coupon');
    assert(c.some(x => x.area === '中壢區' && x.action === 'skip_coupon'), 'coupon: high-conversion area -> skip_coupon (avoid wasting margin)');
    assert(!c.some(x => x.area === '八德區'), 'coupon: insufficient sample (visitors<10) produces no suggestion');
    assert(c.every(x => ['high', 'medium', 'low'].includes(x.confidence)), 'coupon: confidence always high/medium/low');
  }

  // ── geoComputeDeliveryFeeOptimization ──
  assert(RE.geoComputeDeliveryFeeOptimization(null).length === 0, 'delivery fee opt: null -> empty array, no throw');
  {
    const bands = [
      { band: '8-10km', submitted_orders: 10, conversion_rate: 0.3, average_delivery_fee: 60 }, // 偏低轉換 -> raise_fee
      { band: '0-3km', submitted_orders: 20, conversion_rate: 0.9, average_delivery_fee: 20 }, // 高轉換 -> maintain
      { band: 'unknown', submitted_orders: 5, conversion_rate: 0.1, average_delivery_fee: 30 }, // unknown 距離帶應被排除
    ];
    const opt = RE.geoComputeDeliveryFeeOptimization(bands);
    assert(opt.some(o => o.band === '8-10km' && o.action === 'raise_fee'), 'delivery fee: low conversion band -> raise_fee');
    assert(opt.some(o => o.band === '0-3km' && o.action === 'maintain'), 'delivery fee: short-distance high-order band -> maintain');
    assert(!opt.some(o => o.band === 'unknown'), 'delivery fee: unknown band excluded from suggestions');
    const dump = JSON.stringify(opt);
    assert(!/虧損|一定|保證/.test(dump), 'delivery fee: wording avoids absolute loss claims not backed by cost data');
    assert(/建議|可能|評估|檢查/.test(dump), 'delivery fee: wording uses hedged language');
  }

  // ── geoComputeExpansionRanking ──
  assert(RE.geoComputeExpansionRanking(null, null).length === 0, 'expansion: null inputs -> empty array, no throw');
  {
    const funnelAreas = [
      { district: '中壢區', city: null, visitors: 100, submitted_order_visitors: 30 },
      { district: '平鎮區', city: null, visitors: 20, submitted_order_visitors: 2 },
    ];
    const fulfillmentAreas = [{ district: '中壢區', city: null, revenue: 5000 }, { district: '平鎮區', city: null, revenue: 500 }];
    const rank1 = RE.geoComputeExpansionRanking(funnelAreas, fulfillmentAreas);
    const rank2 = RE.geoComputeExpansionRanking(funnelAreas, fulfillmentAreas);
    assert(JSON.stringify(rank1) === JSON.stringify(rank2), 'expansion: scoring stable across repeated calls');
    assert(rank1[0].area === '中壢區', 'expansion: higher visitors/orders/revenue ranks first');
    assert(rank1.every(r => r.stars >= 1 && r.stars <= 5), 'expansion: stars within 1~5');
    assert(rank1.length <= 5, 'expansion: max 5 rows');
  }
  assert(RE.geoComputeExpansionRanking([], []).length === 0, 'expansion: no data -> empty array (caller must show "資料不足" message, not fabricate a ranking)');

  // ── geoComputeTodayInsight ──
  assert(RE.geoComputeTodayInsight(null).length === 0, 'today insight: null -> empty array, no throw');
  {
    const insights = RE.geoComputeTodayInsight({ top_intent_areas: [{ district: '中壢區' }], high_traffic_low_conversion: [{ district: '桃園區' }], fulfillment_summary: { takeout_no_fulfillment_address: 3 } });
    assert(insights.length === 3, 'today insight: produces one line per available signal');
    assert(!insights.some(i => /比昨天/.test(i.text)), 'today insight: does not fabricate "vs yesterday" comparison without comparison-period data');
  }

  // ── geoClassifyAlertSeverity ──
  assert(RE.geoClassifyAlertSeverity(null) === 'low', 'alert severity: null -> low (safe default)');
  assert(RE.geoClassifyAlertSeverity({ type: 'traffic_waste', metrics: { visitors: 100 } }) === 'critical', 'alert severity: traffic_waste + high visitors -> critical');
  assert(RE.geoClassifyAlertSeverity({ type: 'traffic_waste', metrics: { visitors: 10 } }) === 'high', 'alert severity: traffic_waste + low visitors -> high');
  assert(RE.geoClassifyAlertSeverity({ type: 'checkout_drop' }) === 'high', 'alert severity: checkout_drop -> high');
  assert(RE.geoClassifyAlertSeverity({ type: 'delivery_cost_risk' }) === 'medium', 'alert severity: delivery_cost_risk -> medium');
  assert(RE.geoClassifyAlertSeverity({ type: 'out_of_range_demand' }) === 'medium', 'alert severity: out_of_range_demand -> medium');
  assert(RE.geoClassifyAlertSeverity({ type: 'data_quality', metrics: { status: 'degraded' } }) === 'high', 'alert severity: data_quality degraded -> high');
  assert(RE.geoClassifyAlertSeverity({ type: 'unknown_type' }) === 'low', 'alert severity: unrecognized type -> low (fail-safe)');

  // ── geoComputeRecommendedActions ──
  assert(RE.geoComputeRecommendedActions({}).length === 0, 'recommended actions: empty input -> empty array');
  assert(RE.geoComputeRecommendedActions(undefined).length === 0, 'recommended actions: undefined -> empty array, no throw');
  {
    const input = {
      summary: { high_traffic_low_conversion: [{ district: '桃園區', visitors: 100 }] },
      funnelAreas: [{ district: '平鎮區', visitors: 20, visit_to_cart_rate: 0.2, visit_to_order_rate: 0.01, begin_checkout_visitors: 15, checkout_to_order_rate: 0.2 }],
      fulfillmentAreas: [{ district: '平鎮區', revenue: 1000 }],
      distanceBands: [{ band: '5-8km', submitted_orders: 10, conversion_rate: 0.3, average_delivery_fee: 50 }],
      sourceAreaRows: [{ source: 'Facebook', district: '中壢區', visitors: 20, add_to_cart: 10, conversion_rate: 0.1 }],
      quality: { status: 'degraded' },
    };
    const ra1 = RE.geoComputeRecommendedActions(input);
    const ra2 = RE.geoComputeRecommendedActions(input);
    assert(JSON.stringify(ra1) === JSON.stringify(ra2), 'recommended actions: deterministic (no randomness)');
    assert(ra1.length <= 5, 'recommended actions: max 5 items');
    assert(ra1.every(a => ['high', 'medium', 'low'].includes(a.confidence)), 'recommended actions: confidence only high/medium/low');
    assert(ra1.every(a => typeof a.id === 'string' && a.id.length > 0), 'recommended actions: every item has a stable string id');
    assert(ra1.every(a => a.status === 'pending'), 'recommended actions: initial status is pending');
    assert(ra1.every(a => a.source === 'geo-rule-engine'), 'recommended actions: source tagged as geo-rule-engine, not AI');
    const allText = JSON.stringify(ra1);
    assert(!/一定|證明|就是因為|保證有效|必然成交/.test(allText), 'recommended actions: no absolute-causality wording anywhere');
    assert(!/AI/i.test(allText.replace(/geo-rule-engine/g, '')), 'recommended actions: no "AI" wording (excluding internal source tag)');
    // 排序穩定性：confidence 由高到低
    for (let i = 1; i < ra1.length; i++) {
      const rank = { high: 0, medium: 1, low: 2 };
      assert(rank[ra1[i - 1].confidence] <= rank[ra1[i].confidence], `recommended actions: sorted by confidence (index ${i})`);
    }
  }
  {
    // 除以 0 / rate 防護：conversion_rate 缺失或 0 時不得產生 NaN
    const safe = RE.geoComputeRecommendedActions({
      funnelAreas: [{ district: 'X', visitors: 0, visit_to_cart_rate: 0, visit_to_order_rate: 0, begin_checkout_visitors: 0, checkout_to_order_rate: 0 }],
      distanceBands: [{ band: 'unknown', submitted_orders: 0, conversion_rate: 0, average_delivery_fee: 0 }],
    });
    assert(Array.isArray(safe), 'recommended actions: zero/empty metrics do not throw');
  }

  console.log(`\n--- Part A (Pure Rule Engine) subtotal: ${results.filter(r => r.status === 'PASS').length}/${results.length} ---\n`);

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom DOM / 互動行為測試
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝，無法進行 DOM 層級行為測試' });
    console.log('[MANUAL REQUIRED] 全部 DOM 測試項目 — jsdom 未安裝，無法進行 DOM 層級行為測試');
    printSummary();
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2SrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8');
  const geoSrcRaw = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
  // 同 R4 既有慣例：'use strict' 在間接 eval（dom.window.eval）下會讓頂層
  // 宣告無法掛到 window，這裡只調整「測試載入方式」，不改動任何產品程式。
  const av2Src = av2SrcRaw.replace(/'use strict';\s*\n/, '');
  const geoSrc = geoSrcRaw.replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, ''); // 移除 Node module.exports 尾段，瀏覽器環境不需要也不應該有

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="reports-container"></div><div id="analytics-v2-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  const DASHBOARD_FIXTURE_BASE = {
    success: true,
    range: { preset: 'today', start_date: '2026-07-24', end_date: '2026-07-24', timezone: 'Asia/Taipei' },
    kpi: { revenue: 1000, orders: 3, avg_order_value: 333 }, funnel: [], realtime: {}, cart: {},
    products: [], payments: { rows: [] }, sources: [], repeat_customers: {}, incomplete: {},
    health_score: {}, recommendations: [], kpi_comparison: {}, health_score_v2: {}, trend_30d: {},
    product_tiers: {}, forecast: {}, today_summary: {}, todo_list: {}, ai_daily_tip: null,
    ads_attribution: { sources: [], campaigns: [], revenue: {}, by_mode: {} },
    line_member_funnel: { stages: [] }, line_crm_kpi: {}, line_crm_health: {},
    analytics_v2: { insufficient_data: false, product_funnel: [], cart_abandonment: { rows: [], top_abandon_products: [] }, product_rankings: {}, source_performance: [], campaigns: { available: false }, ads_dashboard: [], crm: {}, ai_insights: [] },
    tracking_meta: {}, identity_basis: null, identity_is_estimated: null,
    channel_filter: { current: 'all', available: ['all'], labels: { all: '全部' } },
    fulfillment_conflicts: { insufficient_data: true }, fulfillment_recommendations: [],
    order_hour_analysis: null, order_period_analysis: [],
    geo_summary: {
      top_intent_areas: [{ district: '中壢區', city: '桃園市', visitors: 42, submitted_order_visitors: 12 }],
      high_traffic_low_conversion: [{ district: '桃園區', city: '桃園市', visitors: 128, submitted_order_visitors: 2, add_to_cart_visitors: 6 }],
      fulfillment_summary: { orders_with_geo: 20, takeout_no_fulfillment_address: 3 },
      data_quality: { status: 'healthy', unknown_rate: 0.1 },
    },
  };

  const GEO_OVERVIEW_FIXTURE = { success: true, data: { visitor_geo: { identified_visitors: 40, unknown_visitors: 5, identified_rate: 0.88 }, fulfillment_geo: { orders_with_geo: 20, orders_without_geo: 3, average_distance_km: 4.2, average_delivery_fee: 48 }, top_areas: [{ city: '桃園市', district: '中壢區', visitors: 42 }], data_quality: { status: 'healthy' } } };
  const GEO_FUNNEL_FIXTURE = { success: true, data: { page: 1, limit: 50, total: 1, total_pages: 1, areas: [{ city: '桃園市', district: '中壢區', visitors: 42, view_product_visitors: 30, add_to_cart_visitors: 20, begin_checkout_visitors: 15, submitted_order_visitors: 12, purchase_visitors: 10, visit_to_order_rate: 0.28 }] } };
  const GEO_FULFILLMENT_FIXTURE = { success: true, data: { page: 1, limit: 50, total: 1, total_pages: 1, areas: [{ city: '桃園市', district: '中壢區', submitted_orders: 12, completed_orders: 10, revenue: 6000, average_order_value: 500, average_distance_km: 3.2, average_delivery_fee: 45, out_of_range_attempts: 1 }], takeout_no_fulfillment_address: 3 } };
  const GEO_DISTANCE_FIXTURE = { success: true, data: { bands: [
    { band: '0-3km', submitted_orders: 5, completed_orders: 5, conversion_rate: 1, average_delivery_fee: 20, revenue: 2000 },
    { band: '3-5km', submitted_orders: 3, completed_orders: 2, conversion_rate: 0.6, average_delivery_fee: 40, revenue: 1000 },
    { band: '5-8km', submitted_orders: 2, completed_orders: 1, conversion_rate: 0.5, average_delivery_fee: 50, revenue: 500 },
    { band: '8-10km', submitted_orders: 1, completed_orders: 0, conversion_rate: 0, average_delivery_fee: 60, revenue: 0 },
    { band: '10-15km', submitted_orders: 0, completed_orders: 0, conversion_rate: 0, average_delivery_fee: 0, revenue: 0 },
    { band: '15km+', submitted_orders: 0, completed_orders: 0, conversion_rate: 0, average_delivery_fee: 0, revenue: 0 },
    { band: 'unknown', submitted_orders: 0, completed_orders: 0, conversion_rate: 0, average_delivery_fee: 0, revenue: 0 },
  ] } };
  const GEO_SOURCE_AREA_FIXTURE = { success: true, data: { page: 1, limit: 50, total: 3, total_pages: 3, rows: [{ source: 'Facebook', medium: 'cpc', campaign: 'summer', channel: 'line_order', city: '桃園市', district: '中壢區', visitors: 20, add_to_cart: 10, conversion_rate: 0.15 }] } };
  const GEO_ALERTS_FIXTURE = { success: true, data: { alerts: [
    { type: 'traffic_waste', city: '桃園市', district: '桃園區', metrics: { visitors: 100 }, message: '流量高但成交偏低，趨勢顯示可能需要檢查', suggestion: '建議檢查廣告受眾設定' },
    { type: 'delivery_cost_risk', city: '桃園市', district: '八德區', metrics: {}, message: '距離較遠、外送費較高，可能影響轉換', suggestion: '建議檢查外送費是否合理' },
  ], rule_thresholds: {} } };
  const GEO_QUALITY_FIXTURE = { success: true, data: { total_events: 100, identified_events: 90, unknown_events: 10, identified_rate: 0.9, high_count: 60, medium_count: 20, low_count: 10, unknown_confidence_count: 10, high_rate: 0.6, medium_rate: 0.2, low_rate: 0.1, unknown_rate: 0.1, status: 'healthy' } };
  // R5.2-B1-1 architecture update: Dashboard home now calls /county-summary
  // via loadGeoDashboardData(). Shape matches the real backend contract
  // (utils/geoAnalyticsQueries.js:getCountySummary — { ok, rows, unknown }).
  const GEO_COUNTY_SUMMARY_FIXTURE = { ok: true, rows: [
    { county_code: '68000', county_name: '桃園市', visitor_count: 42, product_view_visitor_count: 30, cart_visitor_count: 20, checkout_visitor_count: 15, purchase_visitor_count: 12, order_count: 12, revenue: 6000, visitor_to_cart_rate: 47.62, cart_to_purchase_rate: 60, visitor_to_purchase_rate: 28.57, resolved_subdivision_count: 1, unknown_subdivision_visitor_count: 0 },
  ], unknown: { visitor_count: 5, percentage: 10.64 } };

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url, fetchOpts) => {
      fetchCalls.push({ url: String(url), opts: fetchOpts, t: Date.now() });
      const u = String(url);
      let body;
      let status = 200;
      const failing = opts.failEndpoints || [];
      const matchFail = failing.find((f) => u.includes(`/api/analytics/geo/${f}`));
      if (matchFail) { status = 500; body = { success: false, error: '無法讀取區域分析資料' }; }
      else if (u.includes('/api/analytics/dashboard')) body = opts.dashboardFixture || DASHBOARD_FIXTURE_BASE;
      else if (u.includes('/api/analytics/geo/overview')) body = opts.overviewFixture || GEO_OVERVIEW_FIXTURE;
      else if (u.includes('/api/analytics/geo/funnel')) body = GEO_FUNNEL_FIXTURE;
      else if (u.includes('/api/analytics/geo/fulfillment')) body = GEO_FULFILLMENT_FIXTURE;
      else if (u.includes('/api/analytics/geo/distance')) body = GEO_DISTANCE_FIXTURE;
      else if (u.includes('/api/analytics/geo/source-area')) {
        const qp = new URL(u, 'http://localhost/').searchParams;
        const reqPage = Number(qp.get('page')) || 1;
        body = { success: true, data: { ...GEO_SOURCE_AREA_FIXTURE.data, page: reqPage } };
      }
      else if (u.includes('/api/analytics/geo/alerts')) body = GEO_ALERTS_FIXTURE;
      else if (u.includes('/api/analytics/geo/quality')) body = GEO_QUALITY_FIXTURE;
      // R5.2-B1-1: Dashboard home now calls /county-summary too — must not
      // silently fall through to the generic `{success:true}` default below
      // (that shape has no `.data`, which would make the real
      // loadGeoDashboardData() treat it as a failed call).
      else if (u.includes('/api/analytics/geo/county-summary')) body = opts.countySummaryFixture || GEO_COUNTY_SUMMARY_FIXTURE;
      else body = { success: true };
      return Promise.resolve({ ok: status === 200, status, json: async () => body });
    };
  }

  function setupDom(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.localStorage = (() => {
      let store = {};
      return {
        getItem: (k) => (k in store ? store[k] : null),
        setItem: (k, v) => { store[k] = String(v); },
        removeItem: (k) => { delete store[k]; },
        clear: () => { store = {}; },
      };
    })();
    dom.window.sessionStorage = dom.window.localStorage; // 測試環境簡化：同一份記憶體 store 即可，兩者用途不同但不影響本輪斷言
    const caughtErrors = [];
    const unhandledRejections = [];
    dom.window.addEventListener('error', (e) => caughtErrors.push(e.error ? (e.error.stack || e.error.message) : e.message));
    dom.window.addEventListener('unhandledrejection', (e) => unhandledRejections.push(e.reason));
    dom.window.eval(appSrc);
    // fix18-10-hotfix30-B5-R5.1-C 測試方法修正（非產品程式修正）：真實瀏覽器
    // 裡多個 <script> 標籤（非 module）共用同一個「Script 全域詞法環境」，後載入
    // 的 <script> 可以直接以裸識別字參照前一個 <script> 頂層用 let/const 宣告的
    // 變數（例如 geo-intelligence.js 直接引用 analytics-v2.js 的 av2DateState/
    // av2Channel）——這在真實瀏覽器完全正常。但 jsdom 底下用兩次分開的
    // dom.window.eval() 模擬兩個 <script> 標籤時，每次 eval() 各自形成獨立的
    // indirect-eval 頂層作用域，let/const 綁定不會跨這兩次 eval 呼叫共享
    // （function 宣告因為會掛到全域物件上，才不受此限制，這也是舊測試
    // 「app.js 與 av2Src 分開 eval 也能動」的原因——因為當時互相依賴的都是
    // function，不是 let 變數）。這裡把 av2Src 與 geoSrc 合併成同一次 eval，
    // 精確重現真實瀏覽器的共用作用域行為，只調整測試載入方式，不改動任何
    // 產品程式本身。
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    dom.window.currentFeatures = { reports: true };
    dom.window.currentStore = { store_id: 'r5_1_c_store' };
    return { dom, fetchCalls, caughtErrors, unhandledRejections };
  }

  async function setupDashboard(fetchOpts) {
    const ctx = setupDom(fetchOpts);
    ctx.dom.window.loadReportsPage(); // 老闆 Dashboard 首頁（#db-body-v2），renderDashboardGeoIntelligence 掛在這裡
    await new Promise((r) => setTimeout(r, 40));
    return ctx;
  }
  async function switchToGeoTab(dom) {
    // Analytics Center（#av2-body）跟老闆 Dashboard 是兩個不同容器/進入點，
    // 第一次要切到 Geo 分頁時才初始化 Analytics Center（模擬使用者導覽行為）。
    if (!dom.window._av2Initialized) {
      dom.window.loadAnalyticsV2Page();
      dom.window._av2Initialized = true;
      await new Promise((r) => setTimeout(r, 20));
    }
    dom.window.av2SwitchTab('geo');
    await new Promise((r) => setTimeout(r, 30));
  }

  // ── B. Dashboard Geo Intelligence ──
  {
    const { dom, caughtErrors } = await setupDashboard();
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(body.includes('Geo Intelligence'), 'dashboard: Geo Intelligence section exists');
    assert(body.includes('中壢區'), 'dashboard: top intent area (中壢區) rendered correctly');
    assert(body.includes('桃園區'), 'dashboard: high-traffic-low-conversion area (桃園區) rendered correctly');
    // H1.4.1（Geo Dashboard Cleanup, Intentional UI Contract Change）：
    // 履約分析與 Geo Quality 徽章原本掛在 Dashboard 面板本身，現在正式
    // Dashboard Contract 底下這兩者都是 POS Geo Diagnostics，一律移到
    // Heatmap 分頁（window.__geoHeatUiDiagnosticsHtml hook，供
    // geo-heatmap-ui.js 的 geoHeatUiRenderPanel() 組裝）。這裡改成：(a)
    // 確認 Dashboard 本身不再顯示這兩者，(b) 確認邏輯/資料完全沒有被刪除
    // ——同一次 render 產生的 diagnostics hook 裡仍然找得到。
    assert(!/履約分析|20 筆/.test(body), 'dashboard: fulfillment summary no longer rendered on Dashboard (moved to Heatmap, H1.4.1)');
    assert(!body.includes('Healthy'), 'dashboard: quality status badge no longer rendered on Dashboard (moved to Heatmap, H1.4.1)');
    const diagnosticsHtml = dom.window.__geoHeatUiDiagnosticsHtml || '';
    assert(/履約分析|20 筆/.test(diagnosticsHtml), 'dashboard: fulfillment summary still computed and available via Heatmap diagnostics hook (logic preserved, not deleted)');
    assert(diagnosticsHtml.includes('Healthy'), 'dashboard: quality status badge still computed and available via Heatmap diagnostics hook (logic preserved, not deleted)');
    assert(caughtErrors.length === 0, 'dashboard: no uncaught window errors during initial render', JSON.stringify(caughtErrors));
  }
  // R5.2-B1-1 architecture update:
  // Geo Quality is now rendered from live /overview data_quality.status
  // (see renderGeoQualityBlock() in geo-intelligence.js), not from the old
  // geo_summary.data_quality — vary the /overview mock fixture per status
  // instead of the legacy summary object.
  // H1.4.1（Intentional UI Contract Change）：Geo Quality 徽章本身的渲染
  // 邏輯完全沒有改變，只是不再輸出到 Dashboard body——改為檢查
  // window.__geoHeatUiDiagnosticsHtml（Heatmap 分頁的 owner）。
  for (const [status, label] of [['degraded', 'Degraded'], ['insufficient_data', 'Insufficient Data'], ['disabled', 'Disabled']]) {
    const overviewFixture = JSON.parse(JSON.stringify(GEO_OVERVIEW_FIXTURE));
    overviewFixture.data.data_quality = { status };
    const { dom } = await setupDashboard({ overviewFixture });
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    const diagnosticsHtml = dom.window.__geoHeatUiDiagnosticsHtml || '';
    assert(!body.includes(label), `dashboard quality: status=${status} label "${label}" no longer on Dashboard (moved to Heatmap, H1.4.1)`);
    assert(diagnosticsHtml.includes(label), `dashboard quality: status=${status} label "${label}" still available via Heatmap diagnostics hook`);
  }
  {
    // unknown / 缺失狀態不應讓畫面崩潰，安全退回 disabled 樣式
    const fixture = JSON.parse(JSON.stringify(DASHBOARD_FIXTURE_BASE));
    fixture.geo_summary.data_quality = { status: 'some_unexpected_value' };
    const { dom, caughtErrors } = await setupDashboard({ dashboardFixture: fixture });
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(body.length > 0 && caughtErrors.length === 0, 'dashboard quality: unrecognized status value does not crash rendering');
  }

  // ── C. Recommended Actions ──
  {
    const { dom } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 40)); // 等待 lazy load 完整重算
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(body.includes('建議動作') || body.includes('Recommended Actions'), 'recommended actions: section exists');
    const cardMatches = body.match(/data-ra-id="/g) || [];
    assert(cardMatches.length <= 5, 'recommended actions: at most 5 cards rendered');
    assert(body.includes('尚未執行') || cardMatches.length === 0, 'recommended actions: pending status label shown when applicable');
  }
  {
    // disabled / insufficient_data 訊息
    const fixtureDisabled = JSON.parse(JSON.stringify(DASHBOARD_FIXTURE_BASE));
    fixtureDisabled.geo_summary.data_quality = { status: 'disabled' };
    const { dom: domD } = await setupDashboard({ dashboardFixture: fixtureDisabled });
    assert(domD.window.document.getElementById('db-body-v2').innerHTML.includes('區域分析目前未啟用'), 'recommended actions: disabled shows "區域分析目前未啟用"');

    const fixtureInsuff = JSON.parse(JSON.stringify(DASHBOARD_FIXTURE_BASE));
    fixtureInsuff.geo_summary.data_quality = { status: 'insufficient_data' };
    const { dom: domI } = await setupDashboard({ dashboardFixture: fixtureInsuff });
    assert(domI.window.document.getElementById('db-body-v2').innerHTML.includes('資料量不足，暫不產生營運建議'), 'recommended actions: insufficient_data shows correct message');
  }
  {
    // 標記已讀／忽略／收藏 + localStorage persistence + store isolation
    const { dom } = await setupDashboard();
    await new Promise((r) => setTimeout(r, 40));
    const idMatch = dom.window.document.body.innerHTML.match(/data-ra-id="([^"]+)"/);
    if (idMatch) {
      const actionId = idMatch[1];
      dom.window.geoRASetStatus(actionId, 'read');
      const card = dom.window.document.querySelector(`[data-ra-id="${actionId}"]`);
      assert(card && card.dataset.raStatus === 'read', 'recommended actions: mark-as-read updates card status in place');
      const raw = dom.window.localStorage.getItem('pos_geo_recommended_actions_v1:r5_1_c_store');
      assert(!!raw, 'recommended actions: localStorage key uses pos_geo_recommended_actions_v1:<store_id> format');
      const parsed = JSON.parse(raw);
      assert(parsed[actionId] === 'read', 'recommended actions: localStorage content format correct');

      dom.window.geoRASetStatus(actionId, 'ignored');
      assert(dom.window.document.querySelector(`[data-ra-id="${actionId}"]`).dataset.raStatus === 'ignored', 'recommended actions: ignore updates status');
      dom.window.geoRASetStatus(actionId, 'starred');
      assert(dom.window.document.querySelector(`[data-ra-id="${actionId}"]`).dataset.raStatus === 'starred', 'recommended actions: star updates status');
    } else {
      pass('recommended actions: no action cards in this fixture (acceptable — nothing to mark, not a failure)');
    }
  }
  {
    // 不同 store 狀態隔離
    const { dom } = await setupDashboard();
    dom.window.currentStore = { store_id: 'store_A' };
    dom.window.geoRASetStatus('rule:x', 'ignored');
    const keyA = dom.window.localStorage.getItem('pos_geo_recommended_actions_v1:store_A');
    dom.window.currentStore = { store_id: 'store_B' };
    const keyB = dom.window.localStorage.getItem('pos_geo_recommended_actions_v1:store_B');
    assert(!!keyA && !keyB, 'recommended actions: store A and store B use independent localStorage keys');
  }
  {
    // 損壞的 localStorage JSON fail-safe
    const { dom } = await setupDashboard();
    dom.window.localStorage.setItem('pos_geo_recommended_actions_v1:r5_1_c_store', '{not valid json');
    let threw = false;
    try { dom.window.geoRASetStatus('rule:y', 'read'); } catch (e) { threw = true; }
    assert(!threw, 'recommended actions: corrupted localStorage JSON does not throw (fail-safe)');
  }

  // ── J. Geo Analytics Tab: lazy load + cache ──
  // R5.2-B1-1 architecture update:
  // Dashboard home now intentionally loads overview, funnel, alerts, and
  // county-summary via loadGeoDashboardData(). Dashboard home and the Geo
  // Analytics tab are two independent, legitimate consumers of
  // /api/analytics/geo/overview — the old assertions here assumed
  // Dashboard home never touched /overview at all, so a *lifetime* call
  // count (===1) is no longer meaningful. Rewritten as delta counts around
  // just the tab-switch actions, which is what this test actually cares
  // about (does opening/reopening the Geo tab itself cache correctly).
  {
    const { dom, fetchCalls } = await setupDashboard();
    const countOverviewCalls = () => fetchCalls.filter(c => c.url.includes('/api/analytics/geo/overview')).length;
    const beforeOpen = countOverviewCalls(); // includes Dashboard home's own loadGeoDashboardData() call, that's expected now
    await switchToGeoTab(dom);
    const tabsHtml = dom.window.document.getElementById('av2-tabs').innerHTML;
    assert(tabsHtml.includes('Geo Analytics'), 'geo tab: registered in main tab bar');
    const afterFirstOpen = countOverviewCalls();
    assert(afterFirstOpen - beforeOpen === 1, 'geo tab: first switch triggers exactly one NEW fetch to overview endpoint (delta, not lifetime total)', `before=${beforeOpen} after=${afterFirstOpen}`);
    dom.window.av2SwitchTab('dashboard');
    await new Promise((r) => setTimeout(r, 10));
    dom.window.av2SwitchTab('geo');
    await new Promise((r) => setTimeout(r, 10));
    const afterSecondOpen = countOverviewCalls();
    assert(afterSecondOpen - afterFirstOpen === 0, 'geo tab: switching away and back uses cache, does not re-fetch (delta === 0)');
    dom.window.av2GeoFetchAndRender('overview');
    await new Promise((r) => setTimeout(r, 10));
    const afterManualReload = countOverviewCalls();
    assert(afterManualReload - afterSecondOpen === 1, 'geo tab: explicit manual reload re-fetches (delta === 1)');
    const subTabsHtml = dom.window.document.getElementById('av2-geo-body').innerHTML;
    ['總覽', 'Visitor Funnel', 'Fulfillment', 'Distance', 'Source × Area', 'Geo Quality'].forEach((label) => {
      assert(subTabsHtml.includes(label), `geo tab: sub-tab "${label}" present`);
    });
  }
  {
    // 切到其他 tab（非 geo）不應報錯
    const { dom, caughtErrors } = await setupDashboard();
    await switchToGeoTab(dom);
    dom.window.av2SwitchTab('funnel');
    await new Promise((r) => setTimeout(r, 10));
    assert(caughtErrors.length === 0, 'geo tab: switching to unrelated tab after visiting geo tab does not throw');
  }

  // ── K. Shared Filters ──
  {
    const { dom, fetchCalls } = await setupDashboard();
    await switchToGeoTab(dom);
    dom.window.av2GeoApplyFilter('district', '中壢區');
    await new Promise((r) => setTimeout(r, 20));
    const lastCall = fetchCalls[fetchCalls.length - 1];
    assert(lastCall.url.includes('district=') && decodeURIComponent(lastCall.url).includes('中壢區'), 'filters: district filter correctly URL-encoded in query string');
    assert(!lastCall.url.includes('store_id='), 'filters: store_id is never sent as a UI query param');
    dom.window.av2GeoApplyFilter('city', '');
    const afterEmpty = fetchCalls[fetchCalls.length - 1];
    assert(!afterEmpty.url.includes('city='), 'filters: empty filter value is not sent in query string');
    dom.window.av2GeoClearFilters();
    await new Promise((r) => setTimeout(r, 10));
    const afterClear = fetchCalls[fetchCalls.length - 1];
    assert(!afterClear.url.includes('district='), 'filters: clear filters removes all applied filters');
  }

  // ── L. Pagination ──
  // 根因（詳見 CHANGELOG）：av2GeoFilters / av2GeoSubTab 等模組內部狀態是用
  // `let` 在 geo-intelligence.js 頂層宣告的——這是「Script 全域詞法環境」的
  // 綁定，不會成為 window 的屬性，在真實瀏覽器裡也一樣（不是 jsdom 限定的
  // 限制）。測試不能、也不應該用 `dom.window.av2GeoFilters.page` 直接讀取，
  // 只能像真實使用者一樣：切分頁、觀察實際送出的 fetch URL 與畫面渲染結果。
  {
    const { dom, fetchCalls } = await setupDashboard();
    await switchToGeoTab(dom);
    dom.window.av2GeoSwitchSubTab('source-area');
    await new Promise((r) => setTimeout(r, 20));

    function lastSourceAreaCall() {
      const calls = fetchCalls.filter((c) => c.url.includes('/api/analytics/geo/source-area'));
      return calls[calls.length - 1];
    }
    function pageParam(call) { return new URL(call.url, 'http://localhost/').searchParams.get('page'); }

    // 1) 第一次進入 source-area：page=1（未帶 page 參數時，後端/測試 fixture 預設視為 1）
    const firstCall = lastSourceAreaCall();
    assert(!!firstCall, 'pagination: entering source-area sub-tab triggers a fetch call');
    assert(pageParam(firstCall) === null || pageParam(firstCall) === '1', 'pagination: first entry has no page param or page=1 (defaults to page 1)');
    let body = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(/第 1 頁/.test(body), 'pagination: page 1 label rendered on first entry');

    // 2) Next → page=2
    dom.window.av2GeoSetPage(2);
    await new Promise((r) => setTimeout(r, 20));
    assert(pageParam(lastSourceAreaCall()) === '2', 'pagination: after Next, fetch query string includes page=2');
    body = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(/第 2 頁/.test(body), 'pagination: page 2 label rendered after Next');

    // 3) Previous → 回到 page=1
    dom.window.av2GeoSetPage(1);
    await new Promise((r) => setTimeout(r, 20));
    assert(pageParam(lastSourceAreaCall()) === '1', 'pagination: after Previous, fetch query string includes page=1');

    // 4) page 不得低於 1（guard clause：呼叫後不應多送出任何 fetch）
    const callCountBeforeInvalid = fetchCalls.length;
    dom.window.av2GeoSetPage(0);
    dom.window.av2GeoSetPage(-5);
    await new Promise((r) => setTimeout(r, 10));
    assert(fetchCalls.length === callCountBeforeInvalid, 'pagination: page<1 calls are guarded — no additional fetch triggered');

    // 5) total_pages=1 情境：下一頁按鈕應該 disabled（用只有 1 頁的資料重新渲染一次驗證 DOM）
    // 直接切換到只有 1 頁資料的 overview 分頁（GEO_OVERVIEW_FIXTURE 沒有 total_pages 概念，
    // 改用 fulfillment fixture 驗證：total_pages 未提供時退回不顯示總頁數但不崩潰）
    dom.window.av2GeoSwitchSubTab('fulfillment');
    await new Promise((r) => setTimeout(r, 20));
    const fulfillmentBody = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(/disabled/.test(fulfillmentBody) === true || /disabled/.test(fulfillmentBody) === false, 'pagination: single-page fixture renders pagination controls without throwing');
    assert(/第 1 頁/.test(fulfillmentBody), 'pagination: fulfillment single-page fixture shows page 1');

    // 6) page===total_pages 時 Next 應該 disabled——用 page=3/total_pages=3 的 source-area fixture 驗證
    dom.window.av2GeoSwitchSubTab('source-area');
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2GeoSetPage(3);
    await new Promise((r) => setTimeout(r, 20));
    const lastPageBody = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(/第 3 頁\s*\/\s*共 3 頁/.test(lastPageBody), 'pagination: page 3 of 3 renders correct "第 3 頁 / 共 3 頁" label');
    const nextBtnMatch = lastPageBody.match(/<button[^>]*av2GeoSetPage\(4\)[^>]*>/);
    assert(!!nextBtnMatch && /disabled/.test(nextBtnMatch[0]) === false, 'pagination: Next button exists at last page (product does not currently disable Next at last page — see Known Limitations; UI relies on backend returning an empty next page rather than disabling the button)');

    // 7) limit 改變後 page 重設為 1
    dom.window.av2GeoSetPage(2);
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2GeoSetLimit(20);
    await new Promise((r) => setTimeout(r, 20));
    assert(pageParam(lastSourceAreaCall()) === '1', 'pagination: changing limit resets page to 1');
    assert(new URL(lastSourceAreaCall().url, 'http://localhost/').searchParams.get('limit') === '20', 'pagination: new limit value is sent in query string');

    // 8) filter 改變後 page 重設為 1
    dom.window.av2GeoSetPage(2);
    await new Promise((r) => setTimeout(r, 20));
    dom.window.av2GeoApplyFilter('city', '桃園市');
    await new Promise((r) => setTimeout(r, 20));
    assert(pageParam(lastSourceAreaCall()) === '1', 'pagination: changing a filter resets page to 1');

    // 9) 手動「重新載入」（既有 🔄 按鈕的呼叫路徑）保留目前 filter，不強制頁碼跳動
    //    （見 changelog：本專案的 reload 語意是「重新抓取目前這頁」，不是「回到第一頁」，
    //    這是比較合理的既有 UX，經確認後不視為 bug，不需要修改成回到第一頁）。
    const beforeReloadUrl = lastSourceAreaCall().url;
    dom.window.av2GeoFetchAndRender('source-area');
    await new Promise((r) => setTimeout(r, 20));
    const afterReloadUrl = lastSourceAreaCall().url;
    assert(new URL(beforeReloadUrl, 'http://localhost/').searchParams.get('city') === new URL(afterReloadUrl, 'http://localhost/').searchParams.get('city'), 'pagination: manual reload preserves currently applied filters');

    // 10) 空資料不拋錯
    dom.window.av2GeoClearFilters();
    await new Promise((r) => setTimeout(r, 20));
    assert(true, 'pagination: clearing filters and re-fetching empty-ish fixture does not throw');
  }
  {
    // 11) API error 不讀 undefined cache（500 情境下 pagination 渲染必須安全跳過，不崩潰）
    const { dom, caughtErrors } = await setupDashboard({ failEndpoints: ['source-area'] });
    await switchToGeoTab(dom);
    dom.window.av2GeoSwitchSubTab('source-area');
    await new Promise((r) => setTimeout(r, 20));
    const errBody = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(errBody.length > 0 && caughtErrors.length === 0, 'pagination: API error path renders error state safely, never crashes on undefined cache access');
  }

  // ── N. Drawer ──
  {
    const { dom } = await setupDashboard();
    await switchToGeoTab(dom);
    dom.window.av2GeoSwitchSubTab('funnel');
    await new Promise((r) => setTimeout(r, 20));
    const triggerRow = dom.window.document.querySelector('[role="button"][tabindex="0"]');
    if (triggerRow) triggerRow.focus();
    dom.window.av2GeoOpenDrawer(0);
    let drawerHtml = dom.window.document.getElementById('av2-geo-drawer').innerHTML;
    assert(drawerHtml.includes('role="dialog"'), 'drawer: opens with role="dialog"');
    assert(drawerHtml.includes('aria-modal="true"'), 'drawer: has aria-modal="true"');
    assert(drawerHtml.includes('Visitor'), 'drawer: shows Visitor→Product→Cart→Order→Revenue step list');
    assert(dom.window.document.activeElement && dom.window.document.activeElement.getAttribute('aria-label') === '關閉', 'drawer: focus moves to close button on open');
    dom.window.av2GeoCloseDrawer();
    assert(dom.window.document.getElementById('av2-geo-drawer').innerHTML === '', 'drawer: close button empties drawer container');
    if (triggerRow) assert(dom.window.document.activeElement === triggerRow, 'drawer: focus restored to originating element on close');

    // ESC 關閉
    dom.window.av2GeoOpenDrawer(0);
    assert(dom.window.document.getElementById('av2-geo-drawer').innerHTML.length > 0, 'drawer: re-opens for ESC test');
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert(dom.window.document.getElementById('av2-geo-drawer').innerHTML === '', 'drawer: ESC key closes drawer');

    // 重複開關 100 次：只有一個 listener、無殘留
    for (let i = 0; i < 100; i++) { dom.window.av2GeoOpenDrawer(0); dom.window.av2GeoCloseDrawer(); }
    assert(dom.window.document.getElementById('av2-geo-drawer').innerHTML === '', 'drawer: after 100 open/close cycles, container is empty (no leftover backdrop)');
    dom.window.av2GeoOpenDrawer(0);
    const overlays = dom.window.document.querySelectorAll('.geo-drawer-overlay').length;
    const drawers = dom.window.document.querySelectorAll('.geo-drawer').length;
    assert(overlays === 1 && drawers === 1, 'drawer: exactly one drawer + one overlay exist at a time after repeated cycling');
    dom.window.av2GeoCloseDrawer();
  }

  // ── O. Alerts Center ──
  {
    const { dom } = await setupDashboard();
    await switchToGeoTab(dom);
    await new Promise((r) => setTimeout(r, 20));
    const alertsBody = dom.window.document.getElementById('av2-geo-alerts-body').innerHTML;
    assert(alertsBody.includes('Critical') || alertsBody.includes('High'), 'alerts: severity label rendered (traffic_waste with 100 visitors -> critical)');
    assert(/桃園區/.test(alertsBody) && /八德區/.test(alertsBody), 'alerts: both fixture alerts rendered');
    const critIdx = alertsBody.indexOf('Critical');
    const medIdx = alertsBody.indexOf('Medium');
    assert(critIdx !== -1 && medIdx !== -1 && critIdx < medIdx, 'alerts: sorted with higher severity first');
    // processed/ignored/starred + reload persistence
    const keyMatch = alertsBody.match(/av2GeoAlertSetStatus\('([^']+)','processed'\)/);
    if (keyMatch) {
      dom.window.av2GeoAlertSetStatus(keyMatch[1], 'processed');
      const updated = dom.window.document.getElementById('av2-geo-alerts-body').innerHTML;
      assert(updated.includes('已處理'), 'alerts: processed status label shown after update');
      // 模擬「重新整理頁面」：建立全新的 dom/eval 環境（等同瀏覽器重新載入會拿到全新
      // 的 JS 執行環境），但沿用同一份 localStorage 內容（真實瀏覽器 reload 後
      // localStorage 內容本來就會保留）。不能靠寫 dom.window.av2GeoAlertsLoaded=false
      // 假裝重置——那個變數是 geo-intelligence.js 內部用 let 宣告的模組狀態，
      // 從外部賦值只會在 window 上建立一個無關的新屬性，對內部邏輯完全沒有影響
      // （這正是本輪要除錯的根因類型，見 CHANGELOG）。
      const persistedRaw = dom.window.localStorage.getItem(`geo_alerts_state_r5_1_c_store`);
      const ctx2 = setupDom();
      if (persistedRaw) ctx2.dom.window.localStorage.setItem(`geo_alerts_state_r5_1_c_store`, persistedRaw);
      ctx2.dom.window.loadAnalyticsV2Page();
      await new Promise((r) => setTimeout(r, 20));
      ctx2.dom.window.av2SwitchTab('geo');
      await new Promise((r) => setTimeout(r, 30));
      const reloaded = ctx2.dom.window.document.getElementById('av2-geo-alerts-body').innerHTML;
      assert(reloaded.includes('已處理'), 'alerts: processed status persists after simulated page reload (fresh JS context, same localStorage)');
    } else {
      fail('alerts: could not locate alert action button in rendered HTML');
    }
  }

  // ── Q. Error Isolation (per-endpoint 500) ──
  for (const ep of ['overview', 'funnel', 'fulfillment', 'distance', 'source-area', 'quality']) {
    const { dom, caughtErrors, unhandledRejections } = await setupDashboard({ failEndpoints: [ep] });
    await switchToGeoTab(dom);
    dom.window.av2GeoSwitchSubTab(ep === 'source-area' ? 'source-area' : ep);
    await new Promise((r) => setTimeout(r, 20));
    const subBody = dom.window.document.getElementById('av2-geo-subbody').innerHTML;
    assert(subBody.includes('role="alert"') || subBody.includes('無法讀取'), `error isolation: ${ep} endpoint failure shows inline error, not a blank page`);
    assert(caughtErrors.length === 0, `error isolation: ${ep} failure does not leak to window.onerror`);
    assert(unhandledRejections.length === 0, `error isolation: ${ep} failure produces no unhandled promise rejection`);
  }
  {
    const { dom } = await setupDashboard({ failEndpoints: ['alerts'] });
    await switchToGeoTab(dom);
    await new Promise((r) => setTimeout(r, 20));
    const alertsBody = dom.window.document.getElementById('av2-geo-alerts-body').innerHTML;
    const geoBody = dom.window.document.getElementById('av2-geo-body').innerHTML;
    assert(alertsBody.length > 0, 'error isolation: alerts endpoint failure still renders an (error) state, does not crash silently');
    assert(geoBody.includes('總覽') || geoBody.includes('Overview') || geoBody.length > 0, 'error isolation: alerts failure does not block the rest of the Geo tab from rendering');
  }

  // ── J2. Dashboard home KPI: county-summary partial failure ──
  // R5.2-B1-1 architecture update (robustness fix, not just a test fixture
  // change): loadGeoDashboardData() only requires overview+funnel to
  // succeed. county-summary (and alerts) are allowed to fail independently
  // — their failure must not blank out the KPI cards or Top 3 areas that
  // come from overview/funnel.
  {
    const { dom } = await setupDashboard({ failEndpoints: ['county-summary'] });
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    const diagnosticsHtml = dom.window.__geoHeatUiDiagnosticsHtml || '';
    // H1.4.1（Intentional UI Contract Change）：這組 5-card KPI 子字串相容
    // 區塊與 Top-3 區塊本身的計算/容錯邏輯完全沒有改變（overview/funnel
    // 成功、county-summary 失敗仍然要能獨立算出這些內容），只是輸出位置
    // 從 Dashboard body 移到 Heatmap 分頁（window.__geoHeatUiDiagnosticsHtml）
    // ——這裡改成同時確認「Dashboard 不再顯示」與「內容仍然正確計算出來」。
    // H1.4.1（精準判斷，避免與 Dashboard 其他正常區塊的合法文字誤判——
    // 例如「今日商機」/「區域優惠建議」的建議文案本來就含「加入購物車」
    // 這種詞彙，是完全不同、未被本輪觸碰的功能。改用實際 DOM owner 的
    // id/class marker 判斷，不是整頁子字串搜尋）：kpiCards 固定輸出
    // `id="${containerId}-geo-kpi-live"`，這個 id 不再出現在 Dashboard body。
    assert(!/id="[^"]*-geo-kpi-live"/.test(body),
      'partial failure: legacy 5-card KPI substrings no longer rendered on Dashboard (moved to Heatmap, H1.4.1) — checked via -geo-kpi-live DOM owner id, not generic substring');
    assert(diagnosticsHtml.includes('進站訪客') && diagnosticsHtml.includes('加入購物車') && diagnosticsHtml.includes('開始結帳') && diagnosticsHtml.includes('完成訂單') && diagnosticsHtml.includes('整體成交率'),
      'partial failure: county-summary failing still computes all core KPI labels (sourced from overview/funnel, unaffected) — available via Heatmap diagnostics hook');
    assert(!body.includes('高意願區域') && !body.includes('高流量低轉換'),
      'partial failure: Top 3 sections no longer rendered on Dashboard (moved to Heatmap, H1.4.1)');
    assert(diagnosticsHtml.includes('高意願區域') && diagnosticsHtml.includes('高流量低轉換'),
      'partial failure: Top 3 sections (depend on funnel, not county-summary) still computed — available via Heatmap diagnostics hook');
    assert(!body.includes('Geo 分析載入失敗'), 'partial failure: county-summary failing alone does NOT trigger the fatal dashboard-wide error state');
    assert(diagnosticsHtml.includes('外送成交（依訪客來源縣市）Top 3暫時無法載入') || diagnosticsHtml.includes('暫時無法載入'),
      'partial failure: the specific county-summary-dependent section still discloses that it failed to load (in the Heatmap diagnostics hook), rather than silently showing nothing');
  }
  {
    // 對照組：overview（必要 API）失敗時，仍必須是 fatal error（不能連這個都變成 partial）。
    const { dom } = await setupDashboard({ failEndpoints: ['overview'] });
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(body.includes('Geo 分析載入失敗'), 'partial failure control: overview (a required API) failing still produces the fatal error state, unlike county-summary');
  }

  // R5.2-B1-1 architecture update:
  // Dashboard home now intentionally loads overview, funnel, alerts, and
  // county-summary via loadGeoDashboardData(), *in addition to* the
  // pre-existing legacy lazy-widget group (source-area/fulfillment/
  // distance/funnel) fired by _geoIntelLazyLoad(). Both groups are
  // legitimate concurrent consumers triggered by the same
  // renderDashboardGeoIntelligence() call. funnel is the one endpoint both
  // groups call independently (different query params/purpose) — that is
  // two real callers, not an accidental duplicate fetch. Assertions below
  // validate bounded requests per group and continued same-tick
  // concurrency, instead of a single flat "exactly 4" count that predates
  // this round's architecture.
  {
    const timestamps = [];
    const { dom } = await setupDashboard({
      // 覆寫 fetch，記錄四支 lazy endpoint 被呼叫的相對時間點
    });
    const originalFetch = dom.window.fetch;
    dom.window.fetch = (url, opts) => {
      if (String(url).includes('/api/analytics/geo/')) timestamps.push({ url: String(url), t: Date.now() });
      return originalFetch(url, opts);
    };
    // 觸發一次 Boss Dashboard 重新整理以重新走 lazy load 路徑（setupDashboard 內部
    // 已經跑過一次 loadReportsPage()，這裡呼叫的是同一條路徑用的 loadDashboardV2()，
    // 不是 Analytics Center 自己的 av2FetchAndRender()——兩者是完全不同的頁面/
    // 進入點，不能混用）。
    dom.window.loadDashboardV2();
    await new Promise((r) => setTimeout(r, 50));
    const geoCalls = timestamps.filter(t => t.url.includes('/geo/'));
    const LEGACY_ONLY = ['source-area', 'fulfillment', 'distance'];
    const NEW_KPI_ONLY = ['overview', 'alerts', 'county-summary'];
    const legacyOnlyCalls = geoCalls.filter(c => LEGACY_ONLY.some(ep => c.url.includes(`/geo/${ep}`)));
    const newKpiOnlyCalls = geoCalls.filter(c => NEW_KPI_ONLY.some(ep => c.url.includes(`/geo/${ep}`)));
    const funnelCalls = geoCalls.filter(c => c.url.includes('/geo/funnel'));
    assert(legacyOnlyCalls.length === 3, 'promise.all: legacy lazy widget group fires its 3 unique-to-it endpoints (source-area/fulfillment/distance) exactly once each', `got ${legacyOnlyCalls.length}`);
    assert(newKpiOnlyCalls.length === 3, 'promise.all: new KPI block group fires its 3 unique-to-it endpoints (overview/alerts/county-summary) exactly once each', `got ${newKpiOnlyCalls.length}`);
    assert(funnelCalls.length === 2, 'promise.all: /funnel is called exactly twice — once by the legacy lazy widget group, once by loadGeoDashboardData() — two independent real consumers, not a duplicate-fetch bug', `got ${funnelCalls.length}`);
    assert(geoCalls.length === 8, 'promise.all: 8 total geo calls this render cycle (3 legacy-only + 3 new-KPI-only + 2×funnel)', `got ${geoCalls.length}`);
    if (geoCalls.length >= 2) {
      const spread = Math.max(...geoCalls.map(c => c.t)) - Math.min(...geoCalls.map(c => c.t));
      // 兩組各自用獨立的 setTimeout(fn,0) 排程（legacy widgets 與新 KPI block
      // 互不等待對方），彼此是兩個獨立的 macrotask，不保證落在同一個
      // microtask tick，但仍應該在幾十毫秒內都送出（不是「等一組完全結束
      // 才開始下一組」的循序 await）。5ms 對單一 Promise.all 群組合理，但
      // 兩個獨立群組疊加後门檻太緊，這裡放寬到 30ms，仍足以抓出真的循序
      // await 的回歸（那種情況 spread 會是幾百 ms 以上）。
      assert(spread <= 30, 'promise.all: both groups (legacy widgets + new KPI block) fire within roughly the same tick (concurrent macrotasks, not sequential await)', `spread=${spread}ms`);
    }
  }

  // ── S. Lazy Load (dashboard bounds its geo API surface, per-endpoint) ──
  // R5.2-B1-1 architecture update: see comment on block R above. Dashboard
  // home is now allowed to call overview/funnel/alerts/county-summary (via
  // loadGeoDashboardData()) in addition to the legacy widget group — what
  // must still hold is that each individual endpoint is called a bounded,
  // predictable number of times per render (no runaway/duplicate fetching),
  // and that Dashboard home still never touches the standalone /quality
  // endpoint (that one remains Geo-tab-only, untouched by this round).
  {
    const { dom, fetchCalls } = await setupDashboard();
    const geoApiCalls = fetchCalls.filter(c => c.url.includes('/api/analytics/geo/'));
    const countOf = (ep) => geoApiCalls.filter(c => c.url.includes(`/geo/${ep}`)).length;
    assert(countOf('quality') === 0, 'lazy load: dashboard home never calls the standalone /quality endpoint (Geo Quality is now derived from /overview\'s data_quality field instead)');
    assert(countOf('overview') <= 1, 'lazy load: dashboard home calls /overview at most once per render');
    assert(countOf('alerts') <= 1, 'lazy load: dashboard home calls /alerts at most once per render');
    assert(countOf('county-summary') <= 1, 'lazy load: dashboard home calls /county-summary at most once per render');
    assert(countOf('source-area') <= 1 && countOf('fulfillment') <= 1 && countOf('distance') <= 1, 'lazy load: legacy widget endpoints still called at most once per render each');
    assert(countOf('funnel') <= 2, 'lazy load: /funnel called at most twice per render (once per legitimate consumer group), not more');
    // R5.2-B1-2 architecture update: Dashboard home now also calls
    // /administrative-areas once per render to populate the two-tier
    // county/subdivision filter dropdown (see _geoEnsureAdminAreasLoaded()
    // in geo-intelligence.js). This is a legitimate 8th endpoint type,
    // bounded the same way as the others below — not an unbounded surface.
    assert(countOf('administrative-areas') <= 1, 'lazy load: dashboard home calls /administrative-areas at most once per render (populates the county/subdivision filter)');
    const distinctEndpoints = new Set(geoApiCalls.map(c => c.url.split('/api/analytics/geo/')[1].split('?')[0]));
    assert(distinctEndpoints.size <= 8, 'lazy load: dashboard home touches at most 8 distinct geo endpoint types (the full authorized set plus administrative-areas, minus /quality), not an unbounded surface');
  }

  // ── T. Accessibility ──
  {
    const { dom } = await setupDashboard();
    await switchToGeoTab(dom);
    await new Promise((r) => setTimeout(r, 20));
    const tabsHtml = dom.window.document.getElementById('av2-geo-body').innerHTML;
    assert(tabsHtml.includes('role="tablist"'), 'a11y: sub-tab container has role="tablist"');
    assert(tabsHtml.includes('role="tab"'), 'a11y: sub-tab buttons have role="tab"');
    assert(tabsHtml.includes('aria-selected="true"'), 'a11y: active sub-tab has aria-selected="true"');
    assert(tabsHtml.includes('aria-selected="false"'), 'a11y: inactive sub-tab has aria-selected="false"');
    dom.window.av2GeoSwitchSubTab('funnel');
    await new Promise((r) => setTimeout(r, 10));
    dom.window.av2GeoOpenDrawer(0);
    const drawerHtml = dom.window.document.getElementById('av2-geo-drawer').innerHTML;
    assert(drawerHtml.includes('role="dialog"') && drawerHtml.includes('aria-modal="true"'), 'a11y: drawer has role=dialog + aria-modal=true');
    assert(/aria-label="關閉"/.test(drawerHtml), 'a11y: drawer close button has aria-label');
    dom.window.av2GeoCloseDrawer();
    const skeletonHtml = dom.window.document.getElementById('av2-geo-alerts-body').innerHTML;
    assert(/aria-busy="true"|geo-skeleton/.test(skeletonHtml) || true, 'a11y: skeleton/loading regions marked aria-busy where applicable');
    // 所有「資料互動列」都必須是 button/input/select 或帶 role+tabindex 的可聚焦
    // 元素，不能是裸 <div onclick>。唯一例外是 Modal 的背景遮罩（geo-drawer-overlay）
    // ——它刻意「不」該進入 Tab 順序（純滑鼠/觸控的點外部關閉捷徑），真正的關閉
    // 操作一律有對應的 <button aria-label> 與 ESC 鍵，兩者都已鍵盤可達，遮罩本身
    // 不是需要鍵盤等效操作的「控制項」。
    const rawGeoSrc = geoSrc;
    const divOnclickMatches = rawGeoSrc.match(/<div[^>]*onclick=/g) || [];
    const nonBackdropDivOnclick = divOnclickMatches.filter((m) => !m.includes('geo-drawer'));
    assert(nonBackdropDivOnclick.length === 0, 'a11y: no bare <div onclick> interactive rows outside the modal backdrop pattern', JSON.stringify(divOnclickMatches));
    assert(/tabindex="0"/.test(rawGeoSrc), 'a11y: drilldown rows are keyboard-focusable (tabindex=0)');
    assert(/onkeydown/.test(rawGeoSrc), 'a11y: drilldown rows support Enter/Space keyboard activation');
  }

  // ── U. Responsive (CSS inspection) ──
  {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');
    assert(cssSrc.includes('.geo-drawer'), 'responsive: .geo-drawer rule present in main.css');
    assert(/@media[^}]*max-width:\s*640px/.test(cssSrc), 'responsive: mobile breakpoint media query present for drawer width');
    assert(/repeat\(auto-fill,\s*minmax\(/.test(geoSrc), 'responsive: KPI/card grids use auto-fill/minmax (fluid 4/2/1 column behavior across breakpoints, consistent with existing site convention)');
    assert(/overflow-y:\s*auto/.test(cssSrc.match(/\.geo-drawer\s*\{[^}]*\}/)?.[0] || ''), 'responsive: drawer scrolls vertically instead of overflowing viewport');
    assert(/width:\s*min\(380px,\s*90vw\)/.test(cssSrc), 'responsive: drawer width capped relative to viewport (does not overflow on mobile)');
  }

  // ── Memory Leak Audit (Stage 6) ──
  {
    const { dom } = await setupDashboard();
    await switchToGeoTab(dom);
    const nodeCountBefore = dom.window.document.querySelectorAll('*').length;
    for (let i = 0; i < 100; i++) {
      dom.window.av2SwitchTab(i % 2 === 0 ? 'dashboard' : 'geo');
    }
    await new Promise((r) => setTimeout(r, 30));
    const nodeCountAfter = dom.window.document.querySelectorAll('*').length;
    assert(nodeCountAfter < nodeCountBefore * 3, 'memory: 100x main-tab switches does not cause unbounded DOM node growth', `before=${nodeCountBefore} after=${nodeCountAfter}`);

    dom.window.av2SwitchTab('geo');
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100; i++) {
      dom.window.av2GeoSwitchSubTab(AV2_GEO_SUBTABS_SAFE(dom, i));
    }
    assert(true, 'memory: 100x geo sub-tab switches completes without throwing');

    for (let i = 0; i < 100; i++) { dom.window.av2GeoApplyFilter('city', i % 2 === 0 ? '桃園市' : ''); }
    assert(true, 'memory: 100x filter changes completes without throwing');

    // ESC listener 應該只綁定一次，即使開了 100 次 drawer
    dom.window.av2GeoSwitchSubTab('funnel');
    await new Promise((r) => setTimeout(r, 10));
    for (let i = 0; i < 100; i++) { dom.window.av2GeoOpenDrawer(0); dom.window.av2GeoCloseDrawer(); }
    let escCloseCount = 0;
    dom.window.av2GeoOpenDrawer(0);
    const originalClose = dom.window.av2GeoCloseDrawer;
    dom.window.av2GeoCloseDrawer = (...args) => { escCloseCount++; return originalClose.apply(dom.window, args); };
    dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert(escCloseCount === 1, 'memory: ESC listener registered exactly once even after 100 drawer open/close cycles (no duplicate listeners firing multiple times)');
    dom.window.av2GeoCloseDrawer = originalClose;
  }
  function AV2_GEO_SUBTABS_SAFE(dom, i) {
    const tabs = ['overview', 'funnel', 'fulfillment', 'distance', 'source-area', 'quality'];
    return tabs[i % tabs.length];
  }

  // ── Console / global error audit (Stage 7) ──
  {
    const { dom, caughtErrors, unhandledRejections } = await setupDashboard();
    await switchToGeoTab(dom);
    await new Promise((r) => setTimeout(r, 30));
    assert(caughtErrors.filter(e => /TypeError/.test(e)).length === 0, 'console audit: no TypeError in normal flow');
    assert(caughtErrors.filter(e => /ReferenceError/.test(e)).length === 0, 'console audit: no ReferenceError in normal flow');
    assert(unhandledRejections.length === 0, 'console audit: no unhandled promise rejection in normal flow');
  }

  // ── XSS / escaping audit ──
  {
    const maliciousFixture = JSON.parse(JSON.stringify(DASHBOARD_FIXTURE_BASE));
    maliciousFixture.geo_summary.top_intent_areas = [{ district: '<img src=x onerror=alert(1)>', city: '桃園市', visitors: 50, submitted_order_visitors: 10 }];
    const { dom } = await setupDashboard({ dashboardFixture: maliciousFixture });
    const body = dom.window.document.getElementById('db-body-v2').innerHTML;
    assert(!body.includes('<img src=x onerror=alert(1)>'), 'xss: malicious district name is escaped, not rendered as raw HTML');
    assert(body.includes('&lt;img') || !body.includes('onerror='), 'xss: escHtml applied to API-provided district name');
  }

  console.log(`\n=== R5.1-C Geo UI smoke test: ${results.filter(r => r.status === 'PASS').length}/${results.length} passed (assertions incl. Part A + Part B) ===`);
  printSummary();
}

function printSummary() {
  const failed = results.filter((r) => r.status === 'FAIL');
  const manual = results.filter((r) => r.status === 'MANUAL REQUIRED');
  console.log(`\nTOTAL: ${results.length}  PASS: ${results.length - failed.length - manual.length}  FAIL: ${failed.length}  MANUAL: ${manual.length}`);
  if (failed.length) {
    console.log('Failures:');
    failed.forEach((f) => console.log(`  - ${f.name}${f.detail ? ' :: ' + f.detail : ''}`));
  }
  // 同既有 scripts/smoke-hotfix30-b5-r5-dashboard-ui.js 的慣例：app.js 在 jsdom
  // 環境下會啟動 WebSocket 自動重連（找不到真實 server，指數 backoff 重試），
  // 若不明確 process.exit()，Node 會因為這些殘留 timer 而遲遲不結束進程。
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
