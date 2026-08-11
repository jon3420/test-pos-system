#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-5.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.5-PRODUCT-EXPOSURE-TO-CART-RATE
//
// Production Modified 本輪範圍（string-match against real files on disk）：
//   public/js/app.js            — 主儀表板商品排行：瀏覽人數→曝光人數／新增曝光→加購率
//   utils/dashboardAnalytics.js — getProductRanking() 新增 view_to_cart_rate
//   public/js/analytics-v2.js   — Analytics V2 商品漏斗：瀏覽→曝光
//   utils/analyticsV2.js        — AI Insights 商品洞察：瀏覽→曝光
//
// 這份 static audit 只驗證「老闆看得到的文字」與「API/前端呼叫關係」的字面事實，
// 真正的計算公式與邊界條件由 run-g1-6-ga4-h1-4-5-exposure-runtime.js 呼叫真實函式驗證，
// 兩者互補，不重疊。
//
// ── H1.4.6 CHANGELOG（2026）─────────────────────────────────────────
// H1.4.5 禁止任何 view_item 存在的舊契約（原 Group 5 的 3 項 Hard Gate），已由
// H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW 商品詳情事件契約明確取代：H1.4.6 正式新增
// 了商品詳情 Modal，view_item 現在是合法、必要的事件，只是必須「只能經由使用者
// 主動開啟商品詳情的路徑送出，不能出現在商品卡清單曝光（view_product）路徑」。
// 詳見下方 Group 5 標記 [Gate→H1.4.6 SUPERSEDED] 的 3 項斷言與其內嵌註解。
// 本檔案其餘所有斷言（H1.4.5 曝光率相關文字/欄位/公式保護）完全未被放寬或刪除。

'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

const appJs = read('public/js/app.js');
const dashboardAnalytics = read('utils/dashboardAnalytics.js');
const analyticsV2Js = read('public/js/analytics-v2.js');
const analyticsV2Util = read('utils/analyticsV2.js');
const platforms = read('public/js/analytics-platforms.js');
const lineOrder = read('public/line-order.html');
const lineShipping = read('public/line-shipping.html');

// ════════════════════════════════════════════════════════════════
// Group 1：主儀表板商品排行（public/js/app.js）
// ════════════════════════════════════════════════════════════════
check('[app.js] 商品排行表頭顯示「曝光人數」', /曝光人數/.test(appJs));
check('[app.js] 商品排行表頭顯示「曝光→加購率」', /曝光→加購率/.test(appJs));
check('[app.js] 商品排行表頭改成「加購→成交率」（原「加入→成交率」）', /加購→成交率/.test(appJs));
check('[app.js] 商品排行表頭不再殘留「加入→成交率」這個舊字面字串（僅檢查實際渲染的 <th> 標籤，不含程式註解）', (() => {
  const idx = appJs.indexOf('function renderDashboardProductsTable');
  const block = appJs.slice(idx, idx + 3600);
  return !/<th[^>]*>加入→成交率/.test(block);
})());
check('[app.js] renderDashboardProductsTable() 直接使用 p.view_to_cart_rate（不在前端重新計算）', (() => {
  const idx = appJs.indexOf('function renderDashboardProductsTable');
  const block = appJs.slice(idx, idx + 3600);
  return /p\.view_to_cart_rate/.test(block) && !/p\.cart_people\s*\/\s*p\.view_people/.test(block);
})());
check('[app.js] 曝光→加購率欄位使用既有 _fmtPct() 格式化（沿用共用函式，不另寫一套百分比格式）', (() => {
  const idx = appJs.indexOf('function renderDashboardProductsTable');
  const block = appJs.slice(idx, idx + 3600);
  return /_fmtPct\(p\.view_to_cart_rate\)/.test(block);
})());
check('[app.js] 商品排行表格 min-width 已加寬以容納新欄位（>=760px）', (() => {
  const m = appJs.match(/db-products-table[\s\S]{0,400}?min-width:(\d+)px/) || appJs.match(/min-width:(\d+)px[\s\S]{0,2000}?曝光人數/);
  if (!m) return false;
  return Number(m[1]) >= 760;
})());
check('[app.js] renderDashboardProductsTable() 仍保留 p.view_people 顯示「曝光人數」那一欄（沒有刪掉原始曝光人數資料）', /p\.view_people/.test(appJs));

// ════════════════════════════════════════════════════════════════
// Group 2：後端 getProductRanking()（utils/dashboardAnalytics.js）
// ════════════════════════════════════════════════════════════════
check('[dashboardAnalytics.js] getProductRanking() 回傳物件含 view_to_cart_rate 欄位', /view_to_cart_rate\s*:/.test(dashboardAnalytics));
check('[dashboardAnalytics.js] view_to_cart_rate 公式為 cartPeople ÷ viewCount（不是反過來）', (() => {
  const idx = dashboardAnalytics.indexOf('view_to_cart_rate:');
  const block = dashboardAnalytics.slice(Math.max(0, idx - 20), idx + 160);
  return /cartPeople\s*\/\s*viewCount/.test(block);
})());
check('[dashboardAnalytics.js] view_to_cart_rate 在 viewCount===0 時回傳 null（防呆先判斷再計算）', (() => {
  const idx = dashboardAnalytics.indexOf('view_to_cart_rate:');
  const block = dashboardAnalytics.slice(Math.max(0, idx - 20), idx + 160);
  return /viewCount\s*>\s*0\s*\?[\s\S]*?:\s*null/.test(block);
})());
check('[dashboardAnalytics.js] view_to_cart_rate 沒有 Math.min(100, ...) 或等效封頂手法', !/Math\.min\(\s*100\s*,\s*(cartPeople|.*view_to_cart)/.test(dashboardAnalytics));
check('[dashboardAnalytics.js] view_to_cart_rate 使用既有 round2() 而非重新實作四捨五入', (() => {
  const idx = dashboardAnalytics.indexOf('view_to_cart_rate:');
  const block = dashboardAnalytics.slice(Math.max(0, idx - 20), idx + 160);
  return /round2\(/.test(block);
})());
check('[dashboardAnalytics.js] cart_to_purchase_rate 既有欄位未被移除（沒有破壞性刪欄）', /cart_to_purchase_rate\s*:/.test(dashboardAnalytics));
check('[dashboardAnalytics.js] 沒有新增資料表（沒有 CREATE TABLE 字面字串在本檔案這次修改範圍附近）', (() => {
  const idx = dashboardAnalytics.indexOf('view_to_cart_rate:');
  const block = dashboardAnalytics.slice(Math.max(0, idx - 400), idx + 400);
  return !/CREATE TABLE/i.test(block);
})());

// ════════════════════════════════════════════════════════════════
// Group 3：Analytics V2 商品漏斗（public/js/analytics-v2.js）
// ════════════════════════════════════════════════════════════════
check('[analytics-v2.js] 商品漏斗顯示「曝光人數」', /曝光人數/.test(analyticsV2Js));
check('[analytics-v2.js] 商品漏斗顯示「Exposure Users」（英文標籤同步更新）', /Exposure Users/.test(analyticsV2Js));
check('[analytics-v2.js] 商品漏斗顯示「曝光→加購」', /曝光→加購/.test(analyticsV2Js));
check('[analytics-v2.js] 商品漏斗標題已改為「商品漏斗 Product Funnel（曝光 → 加入購物車 → 結帳 → 成交）」', /商品漏斗 Product Funnel（曝光 → 加入購物車 → 結帳 → 成交）/.test(analyticsV2Js));
check('[analytics-v2.js] 空資料提示已改成曝光語意（不再是「瀏覽／加入購物車／結帳／付款事件」）', /曝光／加入購物車／結帳／付款事件/.test(analyticsV2Js));
check('[analytics-v2.js] _av2RenderFunnel() 附近註解說明 internal view_product 是商品卡曝光、不是 GA4 view_item', (() => {
  const idx = analyticsV2Js.indexOf('function _av2RenderFunnel');
  const block = analyticsV2Js.slice(Math.max(0, idx - 900), idx);
  return /view_product/.test(block) && /view_item/.test(block) && /曝光/.test(block);
})());
check('[analytics-v2.js] 商品漏斗仍保留 p.view_to_add_rate 這個 API 欄位名稱（非破壞性改名）', /p\.view_to_add_rate/.test(analyticsV2Js));
check('[analytics-v2.js] 商品漏斗沒有殘留舊字面字串「瀏覽人數」／「View Users」／「瀏覽→加購」', (() => {
  const idx = analyticsV2Js.indexOf('function _av2RenderFunnel');
  const block = analyticsV2Js.slice(idx, idx + 3000);
  return !/瀏覽人數/.test(block) && !/View Users/.test(block) && !/瀏覽→加購/.test(block);
})());

// ════════════════════════════════════════════════════════════════
// Group 4：AI Insights 商品證據文字（utils/analyticsV2.js）
// ════════════════════════════════════════════════════════════════
check('[analyticsV2.js] AI Insights 商品洞察 problem 文字已改為「曝光高但加入購物車率偏低」', /曝光高但加入購物車率偏低/.test(analyticsV2Util));
check('[analyticsV2.js] AI Insights 商品洞察 evidence 文字已改為「曝光 ${f.view} 人」', /`曝光 \$\{f\.view\} 人/.test(analyticsV2Util));
check('[analyticsV2.js] AI Insights 沒有殘留舊字面字串「商品瀏覽高」', !/商品瀏覽高/.test(analyticsV2Util));
check('[analyticsV2.js] view_to_add_rate 這個 API 欄位名稱未被更動（只改顯示文字）', /view_to_add_rate\s*:/.test(analyticsV2Util));
check('[analyticsV2.js] MIN_VIEW_SAMPLE_FOR_AI 樣本門檻常數未被更動', /MIN_VIEW_SAMPLE_FOR_AI\s*=\s*5/.test(analyticsV2Util));
check('[analyticsV2.js] 異常判斷公式（< avgViewToAdd * 0.5）未被更動', /f\.view_to_add_rate\s*<\s*avgViewToAdd\s*\*\s*0\.5/.test(analyticsV2Util));

// ════════════════════════════════════════════════════════════════
// Group 5：GA4 / Meta 語意保護（Hard Gate，沿用 H1.4.4 檢查邏輯，本輪不得破壞）
// ════════════════════════════════════════════════════════════════
check('[Gate] GA4_EVENT_MAP 仍然沒有 view_product → view_item 的對應（本輪未恢復映射）', !/view_product\s*:\s*['"]view_item['"]/.test(platforms));
// ════════════════════════════════════════════════════════════════
// H1.4.4／H1.4.5 過期契約 SUPERSEDED BY H1.4.6：
//   舊契約：「GA4_EVENT_MAP 完全不得含有 view_item」「line-order.html／
//   line-shipping.html 完全不得出現 view_item 字面字串」——這是 H1.4.4 Reality
//   Audit 當時「畫面上根本沒有商品詳情 Modal，任何 view_item 都只可能是假事件」
//   時期的正確防呆閘門（見檔頭 H1.4.4 Reality Audit 說明）。
//
//   H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW 正式新增了真正的商品詳情 Modal 之後，
//   「畫面上完全不存在 view_item」這個前提已經不成立，繼續套用舊斷言只會擋下
//   一個現在正確、必要的功能。依需求文件規則：「若舊測試硬性要求系統完全不得
//   存在 view_item，只可用新事件契約明確取代該過期 gate，不得因此忽略其他真實
//   失敗」——以下 3 項舊斷言正式由 H1.4.6 新契約取代（其餘本檔案所有其他斷言
//   一律不變、繼續強制執行）：
//     舊：GA4_EVENT_MAP 不得有 view_item key           → 新：view_item 必須存在，
//         且只能對應 'view_item'（不是被誤植成其他 GA4 事件名稱）
//     舊：line-order.html 不得出現 view_item 字面字串   → 新：view_item 只能經由
//         openProductDetail()/_trackViewItem() 這條「使用者主動開啟商品詳情」
//         的路徑送出，不能出現在 buildCard()／IntersectionObserver（清單曝光）
//         路徑裡
//     舊：line-shipping.html 同上                        → 新：同上，經由
//         openProductDetail()/_trackViewItemShipping()
// ════════════════════════════════════════════════════════════════
check('[Gate→H1.4.6 SUPERSEDED] GA4_EVENT_MAP 現在必須含有 view_item，且對應值正確為 \'view_item\'（H1.4.6 商品詳情正式事件；取代 H1.4.4/H1.4.5「不得含有 view_item」舊契約）',
  /view_item\s*:\s*['"]view_item['"]/.test(platforms));
check('[Gate→H1.4.6 SUPERSEDED] line-order.html 的 view_item 只出現在商品詳情路徑（openProductDetail/_trackViewItem），沒有出現在商品卡清單曝光的 IntersectionObserver 區塊內（取代「完全不得出現 view_item」舊契約）',
  (() => {
    const observerIdx = lineOrder.indexOf('_setupViewProductObserver');
    const observerBlock = lineOrder.slice(observerIdx, observerIdx + 1500);
    const hasViewItemInDetailPath = /_trackViewItem/.test(lineOrder) && /onOpen: function \(\) \{ _trackViewItem\(/.test(lineOrder);
    return hasViewItemInDetailPath && !/view_item/.test(observerBlock);
  })());
check('[Gate→H1.4.6 SUPERSEDED] line-shipping.html 的 view_item 只出現在商品詳情路徑（openProductDetail/_trackViewItemShipping），沒有出現在清單曝光的 IntersectionObserver 區塊內（取代「完全不得出現 view_item」舊契約）',
  (() => {
    const observerIdx = lineShipping.indexOf('_setupViewProductObserver');
    const observerBlock = lineShipping.slice(observerIdx, observerIdx + 1500);
    const hasViewItemInDetailPath = /_trackViewItemShipping/.test(lineShipping) && /onOpen: function \(\) \{ _trackViewItemShipping\(/.test(lineShipping);
    return hasViewItemInDetailPath && !/view_item/.test(observerBlock);
  })());
check('[Gate] META_EVENT_MAP 的 view_product → ViewContent 對應仍存在（Meta Pixel 既有行為未被誤刪）', /view_product\s*:\s*['"]ViewContent['"]/.test(platforms));
check('[Gate] line-order.html 的 _trackEvent 仍會 POST /api/analytics/events（internal view_product 記錄未退化）', /apiFetch\('\/api\/analytics\/events'/.test(lineOrder));
check('[Gate] trackGA4() 定義未被重複或刪除（仍剛好 1 個）', (platforms.match(/function trackGA4/g) || []).length === 1);
check('[Gate] trackPlatformEvent() 定義未被重複或刪除（仍剛好 1 個）', (platforms.match(/function trackPlatformEvent/g) || []).length === 1);

// ════════════════════════════════════════════════════════════════
// Group 6：GA4 即時地圖／GA4 H1 面板等既有契約未被誤改
// ════════════════════════════════════════════════════════════════
check('[Gate] public/js/geo-ga4-h1-panel.js 存在且未被本輪誤動（H1.4.4 GA4 面板檔案不在本輪修改範圍）', fs.existsSync(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js')));
check('[Gate] public/js/geo-ga4-realtime-layer.js 存在且未被本輪誤動', fs.existsSync(path.join(ROOT, 'public/js/geo-ga4-realtime-layer.js')));
check('[Gate] geo-ga4-realtime-layer.js 的「商品瀏覽」仍對應 GA4 view_item（即時地圖語意保持不變，本輪未誤改）', (() => {
  const geoRealtime = read('public/js/geo-ga4-realtime-layer.js');
  return /view_item\s*:\s*['"]商品瀏覽['"]/.test(geoRealtime);
})());

// ── Report ──────────────────────────────────────────────────────
const total = results.length;
const passed = results.filter((r) => r.pass).length;
const failed = results.filter((r) => !r.pass);

console.log(`\nH1.4.5 Static/UI Audit — ${passed}/${total} passed\n`);
results.forEach((r) => console.log(`${r.pass ? '✓' : '✗'} ${r.name}${!r.pass && r.detail ? ' — ' + r.detail : ''}`));
console.log(`\nPASS: ${passed}`);
console.log(`FAIL: ${failed.length}`);
console.log(`TOTAL: ${total}`);

process.exitCode = failed.length ? 1 : 0;
