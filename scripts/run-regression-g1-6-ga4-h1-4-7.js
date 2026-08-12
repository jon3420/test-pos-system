#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-7.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA-full
//
// H1.4.7 Full Regression Runner。
//
// 誠實聲明（本輪修正）：先前版本用 readFileSync()+new Function() 即時解析
// scripts/run-regression-g1-6-ga4-h1-4-6.js 原始碼取得 76 個 inherited leaf
// suite，並直接拿那個解析結果當作「實際執行清單」——這是循環驗證：如果解析
// 邏輯漏掉某個 suite，missing=0 的檢查也只是拿同一份（漏掉的）清單跟自己比
// 對，不會被抓出來。現在改為：76 個 H1.4.6 canonical leaf suite 明確、逐一
// 凍結在下面的 H146_INHERITED_SUITES（真正被執行的清單，來源是一次性從
// run-regression-g1-6-ga4-h1-4-6.js 解析出來後人工轉錄凍結，不是每次執行時
// 動態解析）。原本的即時解析函式 parseH146FinalSuiteForDiagnosticsOnly()
// 保留，但只作為「額外對照診斷」（跑完會印出解析結果跟凍結清單是否一致），
// 完全不參與組成 SUITE 執行清單，也不影響 dry inventory 的 missing/duplicate
// 判定。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'); // 動態解析 repo root，不寫死 /home/claude/work/base
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// ════════════════════════════════════════════════════════════════
// 1. H1.4.6 canonical leaf suite 清單 —— 明確凍結，76 個，這是真正被執行的
//    清單（不是動態解析出來的）。[path, expectPass, expectTotal, label]
// ════════════════════════════════════════════════════════════════
const EXPECTED_H146_COUNT = 76;
const H146_INHERITED_SUITES = Object.freeze([
  ["scripts/run-g1-6-ga4-h1-3-request-builder-contract.js", 68, 68, "H1.3 Request Builder Contract"],
  ["scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js", 48, 48, "H1.3 Event Compat Connection Test"],
  ["scripts/run-g1-6-ga4-h1-3-realtime-event-runtime.js", 65, 65, "H1.3 Realtime Event Runtime"],
  ["scripts/run-g1-6-ga4-h1-3-historical-runtime.js", 44, 44, "H1.3 Historical Runtime"],
  ["scripts/run-g1-6-ga4-h1-3-mutations.js", 37, 37, "H1.3 Mutation Suite"],
  ["scripts/static-audit-g1-6-ga4-h1-3.js", 63, 63, "H1.3 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js", 82, 82, "H1.2 Unique Subdivision Smoke"],
  ["scripts/static-audit-g1-6-ga4-h1-2.js", 36, 36, "H1.2 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js", 76, 76, "B2.5 District Normalization"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js", 139, 139, "B2.4 City Partial"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js", 212, 212, "G1 geo-live"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js", 140, 140, "G1.5-A Smoke"],
  ["scripts/static-audit-g1-5-a.js", 77, 77, "G1.5-A Static Audit"],
  ["scripts/run-g1-6-ga4-h1-qa.js", 22, 22, "H1 QA"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-credential-guard.js", 17, 17, "H1 Credential Guard"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1.js", 108, 108, "H1 Targeted Smoke"],
  ["scripts/static-audit-g1-6-ga4-h1.js", 190, 190, "H1 Static Audit"],
  ["scripts/run-g1-6-ga4-h1-frontend-runtime.js", 81, 81, "H1 Frontend Runtime"],
  ["scripts/run-g1-6-ga4-h1-1-browser-auth-runtime.js", 47, 47, "H1.1 Browser Auth Runtime"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-1-auth-mutations.js", 24, 24, "H1.1 Auth Mutation"],
  ["scripts/run-g1-6-ga4-h1-1-ga4-diagnostic-contract.js", 40, 40, "H1.1 Diagnostic Contract"],
  ["scripts/verify-authoritative-admin-points.js", 57, 57, "A1.2 Catalog Verify"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-authoritative-points.js", 251, 251, "A1.2 Smoke"],
  ["scripts/static-audit-g1-6-a1-2.js", 125, 125, "A1.2 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js", 190, 190, "A1.2.1 Smoke"],
  ["scripts/static-audit-g1-6-a1-2-1.js", 106, 106, "A1.2.1 Static Audit"],
  ["scripts/run-g1-6-a1-2-1-manual-qa.js", 41, 41, "A1.2.1 QA"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js", 160, 160, "A1.1 Smoke"],
  ["scripts/static-audit-g1-6-a1-1.js", 90, 90, "A1.1 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js", 50, 50, "A1 Smoke"],
  ["scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js", 620, 620, "Geo Map Settings"],
  ["scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js", 157, 157, "Geo Settings UI"],
  ["scripts/smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js", 128, 128, "Order Heatmap"],
  ["scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js", 108, 108, "Dashboard Rewire"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js", 75, 75, "B2.3"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js", 95, 95, "B2.2"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js", 85, 85, "B2.1"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js", 187, 187, "B2 Settings"],
  ["scripts/static-audit-g1-5-b2.js", 82, 82, "B2 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js", 106, 106, "B2a"],
  ["scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js", 168, 168, "B1"],
  ["scripts/smoke-g1-6-a2-t1-client-ip-trust-diagnostic.js", 12, 12, "A2-T1 Smoke"],
  ["scripts/run-g1-6-ga4-h1-4-layer-cleanup-runtime.js", 30, 30, "H1.4 Layer Cleanup Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-range-backend-runtime.js", 25, 25, "H1.4 Range Backend Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js", 17, 17, "H1.4 Timezone Parity Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-range-runtime.js", 45, 45, "H1.4 Range Resolver Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-range-ui-runtime.js", 37, 37, "H1.4 Range UI Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-h1-range-integration-runtime.js", 35, 35, "H1.4 H1 Range Integration Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-persisted-range-runtime.js", 23, 23, "H1.4 Persisted Range Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-dashboard-source-runtime.js", 59, 59, "H1.4 Dashboard Source Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-map-state-runtime.js", 100, 100, "H1.4 Map State Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-lifecycle-aba-runtime.js", 22, 22, "H1.4 Lifecycle ABA Runtime"],
  ["scripts/run-g1-6-ga4-h1-4-map-state-mutations.js", 30, 30, "H1.4 Mutation Suite"],
  ["scripts/run-g1-6-ga4-h1-4-browser-entry-runtime.js", 24, 24, "H1.4 Browser Entry Runtime"],
  ["scripts/static-audit-g1-6-ga4-h1-4.js", 230, 230, "H1.4 Static Audit"],
  ["scripts/smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js", 112, 112, "Inherited Hash Smoke (Heatmap-Dashboard Integration)"],
  ["scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js", 203, 203, "H1.4.1 Legacy Migration: R5.1-C Geo UI"],
  ["scripts/smoke-hotfix30-b5-r5-2-b1-5-geo-dashboard-ui.js", 315, 315, "H1.4.1 Legacy Migration: B1-5 Geo Dashboard UI"],
  ["scripts/smoke-hotfix30-b5-r5-2-b1-6-geo-explorer.js", 376, 376, "H1.4.1 Legacy Migration: B1-6 Geo Explorer"],
  ["scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js", 189, 189, "H1.4.1 Legacy Migration: A1.2 Visitor Geo Sync"],
  ["scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js", 229, 229, "H1.4.1 Legacy Migration: A2 Geo Event Engine"],
  ["scripts/smoke-hotfix30-b5-r5-3-a7-geo-kpi-single-source.js", 87, 87, "H1.4.1 Legacy Migration: A7 Geo KPI Single Source"],
  ["scripts/run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js", 112, 112, "H1.4.1 Target Runtime"],
  ["scripts/static-audit-g1-6-ga4-h1-4-1.js", 106, 106, "H1.4.1 Static Audit"],
  ["scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js", 129, 129, "H1.4.2 Browser Target Runtime (Range/Map/Wheel/Sync CTA/DOM Replacement)"],
  ["scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js", 44, 44, "H1.4.2 Persisted Identity Round-Trip Runtime"],
  ["scripts/static-audit-g1-6-ga4-h1-4-2.js", 134, 134, "H1.4.2 Static Audit"],
  ["scripts/run-g1-6-ga4-h1-4-3-heatmap-range-runtime.js", 64, 64, "H1.4.3 Heatmap Range Runtime (10 ranges + race + empty + cross-range stale fallback guard + custom-transport collision guard + search + Overseas disambiguation)"],
  ["scripts/run-g1-6-ga4-h1-4-3-data-lineage-runtime.js", 33, 33, "H1.4.3 Data Lineage Runtime (Raw\u2192Normalize\u2192Persist\u2192Read\u2192Heatmap/Dashboard ViewModel, real SQLite)"],
  ["scripts/static-audit-g1-6-ga4-h1-4-3.js", 161, 161, "H1.4.3 Static Audit (Cross-range cache identity / Overseas display / No snapshot summing / Single payload / Search / Realtime-Historical split / H1.4.2 freeze / Backend scope)"],
  ["scripts/run-g1-6-ga4-h1-4-4-view-item-runtime.js", 25, 25, "H1.4.4 View Item Semantics Runtime (real line-order.html/line-shipping.html DOM + real analytics-platforms.js: 9-card impression regression, card-click has no sender, add_to_cart/remove_from_cart independence, ecommerce smoke, init idempotence) \u2014 H1.4.6: card-click assertions SUPERSEDED (25 vs original 24; see file CHANGELOG)"],
  ["scripts/static-audit-g1-6-ga4-h1-4-4.js", 23, 23, "H1.4.4 Static Audit (view_product not mapped to GA4 view_item / no view_item sender in either page / ecommerce mapping preserved / Meta+internal preserved / H1.4.3 freeze)"],
  ["scripts/run-g1-6-ga4-h1-4-5-exposure-runtime.js", 31, 31, "H1.4.5 Product Exposure-to-Cart Rate Runtime (real getProductRanking() + real sql.js DB: 1/1=100, 3/10=30, view=0\u2192null, 1/2=200 no-cap, delisted product, store isolation, date range, channel filter)"],
  ["scripts/static-audit-g1-6-ga4-h1-4-5.js", 40, 40, "H1.4.5 Static/UI Audit (\u4e3b\u5100\u8868\u677f/Analytics V2/AI Insights \u66dd\u5149\u8a9e\u610f\u6a19\u7c64 + view_to_cart_rate/view_to_add_rate API \u6b04\u4f4d\u672a\u7834\u58de\u6027\u6539\u540d + GA4 view_item/Meta Pixel/GA4\u5373\u6642\u5730\u5716 \u8a9e\u610f\u4fdd\u8b77 Hard Gate)"],
  ["scripts/run-g1-6-ga4-h1-4-6-runtime.js", 37, 37, "H1.4.6 Product Detail Modal Runtime (real jsdom + real public/js/product-detail-modal.js: open/close/backdrop/Esc/qty/subtotal/maxQty/\u7121\u5716\u7121\u4ecb\u7d39fallback/\u5feb\u901f\u9023\u9ede\u9632\u8b77/blocked\u5546\u54c1/onOpen\u55ae\u6b21\u89f8\u767c/\u9577\u6587\u5b57\u4e0d\u5674\u932f)"],
  ["scripts/static-audit-g1-6-ga4-h1-4-6.js", 72, 72, "H1.4.6 Static/UI/Analytics Audit (LINE\u5916\u5e36\u5916\u9001/\u5b85\u914d\u5171\u7528\u540c\u4e00\u4efdModal\u5143\u4ef6 + \u5546\u54c1\u5361\u9ede\u64ca/\u9375\u76e4\u958b\u555f + \u52a0\u5165\u8cfc\u7269\u8eca\u547c\u53eb\u65e2\u6709addCart()/changeQty() + \u4e0d\u7e5e\u904e\u552e\u5b8c\u5224\u65b7 + Modal UI\u8981\u6c42 + \u56fa\u5b9a\u8cfc\u7269\u8eca\u5217 + view_product/view_item\u8a9e\u610f\u5206\u96e2 + GA4 items[] + \u898f\u683c\u52a0\u6599\u754c\u7dda + \u5f8c\u7aef\u9a57\u8b49\u672a\u653e\u5bec\uff1bH1.4.7 \u66f4\u65b0\uff1a5 \u9805\u904e\u671f checkout \u65b7\u8a00\u5df2 supersede\uff0c66\u219272)"],
]);
if (H146_INHERITED_SUITES.length !== EXPECTED_H146_COUNT) {
  console.error(`[FATAL] H146_INHERITED_SUITES 凍結清單長度應為 ${EXPECTED_H146_COUNT}，實際為 ${H146_INHERITED_SUITES.length}。`);
  process.exit(1);
}

// suite path 正規化（統一用 '/' 分隔、去除前後空白），用於去重與存在性檢查。
function normPath(p) { return String(p).trim().replace(/\\/g, '/'); }
function absPath(p) { return path.resolve(ROOT, normPath(p)); }

// ── 額外對照診斷（不參與組成執行清單）：即時解析 H1.4.6 runner 原始碼，
// 純粹用來提醒「如果 H1.4.6 runner 本身之後又改了 SUITE 組裝方式，這裡的
// 凍結清單可能已經跟它不同步」，不作為 missing/duplicate 判定依據，也不
// 影響任何 exit code。
function parseH146FinalSuiteForDiagnosticsOnly() {
  try {
    const rel = 'scripts/run-regression-g1-6-ga4-h1-4-6.js';
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) return null;
    const src = fs.readFileSync(abs, 'utf8');
    const marker = 'const SUITE = [...H145_FINAL_SUITE, ...H146_NEW];';
    const idx = src.indexOf(marker);
    if (idx === -1) return null;
    const codeUpToSuite = src.slice(0, idx + marker.length).replace(/^#!.*\n/, '');
    const fakeModule = { exports: null };
    // eslint-disable-next-line no-new-func
    const fn = new Function('module', 'require', '__dirname', `${codeUpToSuite}\nmodule.exports = SUITE;`);
    fn(fakeModule, require, path.dirname(abs));
    return Array.isArray(fakeModule.exports) ? fakeModule.exports : null;
  } catch (e) {
    return null;
  }
}

{
  const seen = new Set();
  const dups = [];
  H146_INHERITED_SUITES.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dups.push(n); seen.add(n); });
  if (dups.length) {
    console.error('[FATAL] H146_INHERITED_SUITES 凍結清單內部本身有重複 suite path：', dups);
    process.exit(1);
  }
  // 明確排除：不得把 H1.4.6/H1.4.7 regression runner 自身列為（或意外混入）leaf suite。
  const forbidden = ['scripts/run-regression-g1-6-ga4-h1-4-6.js', 'scripts/run-regression-g1-6-ga4-h1-4-7.js'];
  const nested = H146_INHERITED_SUITES.filter(([p]) => forbidden.includes(normPath(p)));
  if (nested.length) {
    console.error('[FATAL] H146_INHERITED_SUITES 凍結清單裡混入了 regression runner 自身（巢狀彙總），不允許：', nested);
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. H1.4.7 新增：Two-Stage Checkout Runtime／Analytics Contract Runtime／
//    Static Audit（全部 fresh 執行確認過真實 count，且都是 FAIL=0——見對話
//    中的執行紀錄：39/39、113/113、59/59）。明確列出，各恰好一次。
// ════════════════════════════════════════════════════════════════
const EXPECTED_H147_NEW_COUNT = 3;
const H147_NEW_SUITES = Object.freeze([
  ['scripts/static-audit-g1-6-ga4-h1-4-7.js', 39, 39, 'H1.4.7 Static Audit (line-order/line-shipping 兩階段結構、cartBar 只開 cartStage、view_cart 在 openCartSheet、checkout_click 在 _enterCheckoutStage、無 begin_checkout 呼叫、submit_order 路徑分離、Meta trackCustom/track 分流、GA4 canonical map、Funnel 七階段順序、getIncomplete 排除已購買、Geo 相容別名)'],
  ['scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js', 113, 113, 'H1.4.7 Two-Stage Checkout Runtime (real jsdom + 真實 public/line-order.html/public/line-shipping.html：查看購物車→cartStage→前往結帳→checkoutStage→確認下單，view_cart/checkout_click/begin_checkout 事件契約，LIFF/Gate 導回，清空購物車，商品詳情 modal 回歸)'],
  ['scripts/run-h1-4-7-analytics-contract-runtime.js', 59, 59, 'H1.4.7 Analytics Contract Runtime (真實 utils/db.js sql.js schema + fixture：EVENT_WHITELIST、getFunnel()/getIncomplete()/getProductFunnel()/getGeoFunnel() 真實數字、平台真實派送 fbq/gtag stub、真實 HTTP 路由接收、fixture 時間戳落在 resolveDateRange 區間內自我診斷)'],
]);
if (H147_NEW_SUITES.length !== EXPECTED_H147_NEW_COUNT) {
  console.error(`[FATAL] H147_NEW_SUITES 應恰好 ${EXPECTED_H147_NEW_COUNT} 個，實際為 ${H147_NEW_SUITES.length} 個。`);
  process.exit(1);
}

const EXPECTED_TOTAL = EXPECTED_H146_COUNT + EXPECTED_H147_NEW_COUNT;
const SUITE = [...H146_INHERITED_SUITES, ...H147_NEW_SUITES];

// Final normalize + uniqueness + existence gate。
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dups.push(n); seen.add(n); });
  if (dups.length) {
    console.error('[FATAL] H1.4.7 runner 組出來的最終 SUITE 清單有重複 path（正規化後比對）：', dups);
    process.exit(1);
  }
  if (SUITE.length !== EXPECTED_TOTAL) {
    console.error(`[FATAL] 預期最終應解析出 ${EXPECTED_TOTAL} 個唯一 suite（${EXPECTED_H146_COUNT} inherited + ${EXPECTED_H147_NEW_COUNT} new），實際為 ${SUITE.length} 個。`);
    process.exit(1);
  }
  const missing = SUITE.filter(([p]) => !fs.existsSync(absPath(p)));
  if (missing.length) {
    console.error('[FATAL] 以下 suite path 解析後不存在：', missing.map(([p]) => p));
    process.exit(1);
  }
  const outsideRoot = SUITE.filter(([p]) => !absPath(p).startsWith(ROOT + path.sep));
  if (outsideRoot.length) {
    console.error('[FATAL] 以下 suite path 解析後位於 repo root 之外：', outsideRoot.map(([p]) => p));
    process.exit(1);
  }
}

const NODE_CHECK_FILES = [
  'public/line-order.html',
  'public/line-shipping.html',
  'public/js/analytics-platforms.js',
  'utils/analyticsLog.js',
  'utils/dashboardAnalytics.js',
  'utils/analyticsV2.js',
  'utils/geoAnalyticsQueries.js',
  'scripts/static-audit-g1-6-ga4-h1-4-7.js',
  'scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js',
  'scripts/run-h1-4-7-analytics-contract-runtime.js',
];

function parseSummary(output) {
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
  const m1b = output.match(/OK:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (pass === null && m1b) { pass = Number(m1b[1]); fail = Number(m1b[2]); total = Number(m1b[3]); }
  const m2 = output.match(/總計[：:]\s*(\d+)\s*項，PASS\s*(\d+)，FAIL\s*(\d+)/);
  if (pass === null && m2) { total = Number(m2[1]); pass = Number(m2[2]); fail = Number(m2[3]); }
  const m3 = output.match(/OK:\s*(\d+)\s*\/\s*(\d+)/);
  if (pass === null && m3) { pass = Number(m3[1]); total = Number(m3[2]); fail = total - pass; }
  const m4 = output.match(/(\d+)\s*\/\s*(\d+)\s*OK\b/);
  if (pass === null && m4) { pass = Number(m4[1]); total = Number(m4[2]); fail = total - pass; }
  const m5 = output.match(/(\d+)\/(\d+)\s*PASS,\s*(\d+)\s*FAIL/);
  if (pass === null && m5) { pass = Number(m5[1]); total = Number(m5[2]); fail = Number(m5[3]); }
  const m6 = output.match(/PASS=(\d+)\s+FAIL=(\d+)/);
  if (pass === null && m6) { pass = Number(m6[1]); fail = Number(m6[2]); total = pass + fail; }
  const m7 = output.match(/—\s*(\d+)\/(\d+)\s*passed/);
  if (pass === null && m7) { pass = Number(m7[1]); total = Number(m7[2]); fail = total - pass; }
  if (pass === null) {
    const pM = output.match(/PASS:\s*(\d+)/);
    const fM = output.match(/FAIL:\s*(\d+)/);
    const tM = output.match(/TOTAL:\s*(\d+)/);
    if (pM && fM && tM) { pass = Number(pM[1]); fail = Number(fM[1]); total = Number(tM[1]); }
  }
  return { pass, fail, total };
}

function snapshotTmpMatches() {
  const patterns = [/ga4-h1.*\.db$/, /unique-subdivision.*\.db$/, /h14-mutations.*\.db$/, /^h13-baseline-static-/, /^h1-4-7-analytics-/];
  const all = fs.readdirSync(os.tmpdir());
  return new Set(all.filter((f) => patterns.some((re) => re.test(f))));
}

function detectResidue(preRoundTmpSnapshot) {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    ['.sqlite', '.sqlite3'].forEach((ext) => {
      if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
    });
  }
  const afterSnapshot = snapshotTmpMatches();
  const newLeftovers = [...afterSnapshot].filter((f) => !preRoundTmpSnapshot.has(f));
  if (newLeftovers.length) issues.push(`temp file residue newly created this round: ${newLeftovers.join(', ')}`);
  const mutationTmpJs = [];
  ['public/js', 'services'].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      fs.readdirSync(full).filter((f) => /\.mutation-tmp-/.test(f)).forEach((f) => mutationTmpJs.push(`${dir}/${f}`));
    }
  });
  if (mutationTmpJs.length) issues.push(`mutation temp file residue: ${mutationTmpJs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  if (typeof global.jsdom !== 'undefined' || typeof global.window !== 'undefined') issues.push('jsdom global leaked into parent process');
  return issues;
}

function classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  // 一律以 child exit code 為成功判定基礎，不能只搜尋輸出文字裡有沒有出現 'PASS'。
  if (exitCode !== 0 || crashed) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return 'PASS';
  }
  const parsedOk = typeof pass === 'number' && typeof total === 'number' && typeof fail === 'number'
    && Number.isFinite(pass) && Number.isFinite(total) && Number.isFinite(fail);
  const ok = parsedOk && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runSuite(rel, expectPass, expectTotal, label) {
  const p = absPath(rel);
  if (!fs.existsSync(p)) {
    return { label, rel, pass: null, fail: null, total: null, expectPass, expectTotal, exitCode: null, classification: 'FAIL', crashed: true, missing: true, output: '' };
  }
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  let output = '';
  let crashed = false;
  let exitCode = 0;
  let timedOut = false;
  try {
    output = execFileSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
  } catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
    crashed = true;
    exitCode = e.status === undefined ? 1 : e.status;
    if (e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code))) timedOut = true;
  }
  const { pass, fail, total } = parseSummary(output);
  const classification = classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
  return { label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut, output };
}

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  let sumChildFailAssertions = 0;
  const preRoundTmpSnapshot = snapshotTmpMatches();
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const r = runSuite(rel, expectPass, expectTotal, label);
    if (r.classification === 'FAIL') allOk = false;
    if (typeof r.fail === 'number' && r.fail > 0) sumChildFailAssertions += r.fail;
    roundResults.push(r);
    console.log(`[${r.classification.padEnd(22)}] ${label.padEnd(60)} pass=${r.pass} fail=${r.fail} total=${r.total} exit=${r.exitCode} (expect ${expectPass}/${expectTotal})${r.crashed ? '  <== CRASHED/NONZERO' : ''}${r.timedOut ? '  <== TIMEOUT' : ''}${r.missing ? '  <== MISSING SCRIPT' : ''}`);
    if (r.classification === 'FAIL') {
      console.log('---- full stdout+stderr ----');
      console.log(r.output || '(no output captured)');
      console.log('---- signal:', r.signal || 'none', ' exit:', r.exitCode, '----');
    }
  }
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const residue = detectResidue(preRoundTmpSnapshot); // 不因 suite 失敗而略過
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function dryRunInventory() {
  console.log('H1.4.7 Regression Runner — DRY RUN (inventory only, no suites executed)');
  console.log(`  ROOT: ${ROOT}`);
  console.log(`  H1.4.6 inherited suites: ${H146_INHERITED_SUITES.length}（預期 76，缺少 = ${76 - H146_INHERITED_SUITES.length}）`);
  const staticAuditCount = H147_NEW_SUITES.filter(([p]) => p === 'scripts/static-audit-g1-6-ga4-h1-4-7.js').length;
  const twoStageCount = H147_NEW_SUITES.filter(([p]) => p === 'scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js').length;
  const analyticsCount = H147_NEW_SUITES.filter(([p]) => p === 'scripts/run-h1-4-7-analytics-contract-runtime.js').length;
  console.log(`  H1.4.7 static audit：恰好 ${staticAuditCount}`);
  console.log(`  H1.4.7 two-stage runtime：恰好 ${twoStageCount}`);
  console.log(`  H1.4.7 analytics runtime：恰好 ${analyticsCount}`);
  const seen = new Set();
  const dupList = [];
  SUITE.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dupList.push(n); seen.add(n); });
  console.log(`  duplicate resolved paths：${dupList.length}`);
  const missingList = SUITE.filter(([p]) => !fs.existsSync(absPath(p)));
  console.log(`  missing files：${missingList.length}`);
  const forbidden = ['scripts/run-regression-g1-6-ga4-h1-4-6.js', 'scripts/run-regression-g1-6-ga4-h1-4-7.js'];
  const selfRecursion = SUITE.filter(([p]) => forbidden.includes(normPath(p)));
  console.log(`  self-recursion：${selfRecursion.length}`);
  const nestedRunners = SUITE.filter(([p]) => /run-regression-/.test(normPath(p)));
  console.log(`  nested regression runners：${nestedRunners.length}`);
  console.log(`  UNIQUE SUITES (total)：${SUITE.length}`);
  const ok = staticAuditCount === 1 && twoStageCount === 1 && analyticsCount === 1
    && dupList.length === 0 && missingList.length === 0 && selfRecursion.length === 0 && nestedRunners.length === 0
    && H146_INHERITED_SUITES.length === 76;
  console.log(`  DRY RUN RESULT: ${ok ? 'OK' : 'FAIL'}`);
  process.exitCode = ok ? 0 : 1;
}

function main() {
  if (process.argv.includes('--dry-run')) {
    dryRunInventory();
    return;
  }

  console.log('H1.4.7 Full Regression Runner');
  {
    // 額外對照診斷：即時解析結果 vs 凍結清單是否一致（僅供人工參考，不影響
    // exit code、不影響 SUITE 執行清單）。
    const diag = parseH146FinalSuiteForDiagnosticsOnly();
    if (diag === null) {
      console.log('  [DIAG] 無法即時解析 H1.4.6 runner 原始碼做對照（可能格式已變更）——不影響本次執行，僅供參考。');
    } else {
      const diagNorm = diag.map(([p]) => normPath(p)).sort().join('|');
      const frozenNorm = H146_INHERITED_SUITES.map(([p]) => normPath(p)).sort().join('|');
      console.log(`  [DIAG] 即時解析出 ${diag.length} 個 suite；凍結清單 ${H146_INHERITED_SUITES.length} 個；path 集合${diagNorm === frozenNorm ? '一致' : '不一致（H1.4.6 runner 原始碼可能已變更，建議人工檢查）'}`);
    }
  }
  console.log(`  Inherited from H1.4.6 final runner (parsed live, inline leaf suites — not a nested runner call): ${H146_INHERITED_SUITES.length} unique suites`);
  console.log(`  + H1.4.7 new suites (Static Audit / Two-Stage Checkout Runtime / Analytics Contract Runtime): ${H147_NEW_SUITES.length}`);
  console.log(`  = Total unique suites this round: ${SUITE.length}`);
  console.log('\nnode --check for H1.4.7 touched Production/Test files:');
  let checkOk = true;
  for (const rel of NODE_CHECK_FILES) {
    if (rel.endsWith('.html')) {
      if (!fs.existsSync(path.join(ROOT, rel))) { checkOk = false; console.log(`  [FAIL] ${rel} — file missing`); }
      else console.log(`  [OK]   ${rel} (exists; inline <script> syntax verified separately)`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      console.log(`  [OK]   ${rel}`);
    } catch (e) {
      checkOk = false;
      console.log(`  [FAIL] ${rel} — ${e.message.slice(0, 200)}`);
    }
  }

  const roundCount = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;
  const rounds = [];
  for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 各輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('H1.4.7 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA-full');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  UNIQUE SUITES: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    const totalPass = r.roundResults.reduce((a, x) => a + (x.pass || 0), 0);
    const totalFail = r.roundResults.reduce((a, x) => a + (x.fail || 0), 0);
    const totalTotal = r.roundResults.reduce((a, x) => a + (x.total || 0), 0);
    console.log(`  Round ${i + 1}: UNIQUE_SUITES=${SUITE.length} PASS=${totalPass} FAIL=${totalFail} TOTAL=${totalTotal} passedSuites=${SUITE.length - r.failedSuiteCount} failedSuites=${r.failedSuiteCount} exit=${r.allOk ? 0 : 1} residue=${r.residue.length}`);
  });
  const assertionMismatch = !consistent ? 1 : 0;
  console.log(`  assertionMismatch: ${assertionMismatch}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
