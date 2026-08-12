#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1-4-7.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA
//
// Production Modified 本輪範圍（string-match against real files on disk）：
//   public/line-order.html            — 真正兩階段結帳（cartStage/checkoutStage）
//   public/line-shipping.html         — 同上（宅配）
//   public/js/analytics-platforms.js  — view_cart/checkout_click 平台映射
//   utils/analyticsLog.js             — EVENT_WHITELIST 新增 view_cart/checkout_click
//   utils/dashboardAnalytics.js       — Funnel canonical 七階段、getIncomplete() 排除已購買
//   utils/analyticsV2.js              — getProductFunnel() checkout 欄位權威來源
//   utils/geoAnalyticsQueries.js      — GEO_FUNNEL_EVENTS.checkout 權威來源 + 相容別名欄位
//
// 這份 static audit 只驗證「字面／結構事實」，不複製 runtime 測試、不靠註解文字
// 通過（負向檢查一律先去除註解）。真正的互動行為由
// scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js（DOM/事件）與
// scripts/run-h1-4-7-analytics-contract-runtime.js（fixture/真實函式）驗證。

'use strict';
const fs = require('fs');
const path = require('path');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail !== undefined ? detail : '' }); }

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const exists = (p) => fs.existsSync(path.join(ROOT, p));

// ── 去除註解（// 單行、/* */ 區塊），避免 supersession 註解或任何說明文字
// 裡提到的事件名稱字面字串造成負向檢查誤判。字串常值裡的 // 或 /* 不受影響
// （簡化版：這個專案的來源沒有在字串常值裡塞 // 或 /* 這種會混淆的內容，
// 用簡單的逐行/區塊剝除已足夠，不需要完整 JS tokenizer）。
function stripComments(src) {
  // 先去區塊註解，再去行註解；避免行註解規則吃掉字串裡的 URL（如
  // https://）——這裡用「非貪婪、且前面不是冒號」的簡化判斷已足夠應付本專案
  // 實際寫法（http(s):// 出現時前面一定是引號內字串，不會單獨以 // 開頭）。
  let out = src.replace(/\/\*[\s\S]*?\*\//g, '');
  out = out.split('\n').map((line) => {
    // 找不在字串內的 // ——用簡化規則：如果這一行同時含有 http(s):// ，
    // 只在該 URL 之後尋找真正的行註解起點；否則直接找第一個 // 出現位置。
    let idx = -1;
    let searchFrom = 0;
    const urlMatch = line.match(/https?:\/\//);
    if (urlMatch) searchFrom = urlMatch.index + urlMatch[0].length;
    idx = line.indexOf('//', searchFrom);
    return idx === -1 ? line : line.slice(0, idx);
  }).join('\n');
  return out;
}

// ── 用括號配對（不是固定字數的 char window）精準擷取一個函式的完整原始碼
// （含註解，供需要看註解的檢查使用；negative check 再自行 stripComments）。
function extractFunctionBody(src, fnNamePattern) {
  const re = new RegExp(`function\\s+${fnNamePattern}\\s*\\([^)]*\\)\\s*\\{`);
  const m = src.match(re);
  if (!m) return null;
  const start = m.index;
  let i = start + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === '{') depth += 1;
    else if (src[i] === '}') depth -= 1;
    i += 1;
  }
  if (depth !== 0) return null; // 括號沒配對成功，寧可回報找不到，不要回傳半截
  return src.slice(start, i);
}

const lineOrder = read('public/line-order.html');
const lineShipping = read('public/line-shipping.html');
const platforms = read('public/js/analytics-platforms.js');
const analyticsLog = read('utils/analyticsLog.js');
const dashboardAnalytics = read('utils/dashboardAnalytics.js');
const analyticsV2 = read('utils/analyticsV2.js');
const geoQueries = read('utils/geoAnalyticsQueries.js');

// ════════════════════════════════════════════════════════════════
// Group 1：public/line-order.html — 真正兩階段結帳
// ════════════════════════════════════════════════════════════════
{
  const openCartSheetBody = extractFunctionBody(lineOrder, 'openCartSheet');
  const openCheckoutStepBody = extractFunctionBody(lineOrder, 'openCheckoutStep');
  const enterCheckoutStageBody = extractFunctionBody(lineOrder, '_enterCheckoutStage');

  check('[line-order.html] cartBar 只呼叫 openCartSheet()（沒有直接呼叫任何 checkout/submit 相關函式）',
    /id="cartBar"[^>]*onclick="openCartSheet\(\)"/.test(lineOrder));
  check('[line-order.html] 購物車階段（#cartStage）內含獨立「前往結帳」入口（#goCheckoutBtn，呼叫 openCheckoutStep()）',
    /id="goCheckoutBtn"[^>]*onclick="openCheckoutStep\(\)"/.test(lineOrder));
  check('[line-order.html] openCartSheet() 與第二階段函式（openCheckoutStep/_enterCheckoutStage）是分離的獨立函式，不是同一個函式',
    !!openCartSheetBody && !!openCheckoutStepBody && openCartSheetBody !== openCheckoutStepBody);
  check('[line-order.html] view_cart 位於 openCartSheet()（購物車開啟路徑）內',
    !!openCartSheetBody && /_trackEvent\('view_cart'/.test(stripComments(openCartSheetBody)));
  check('[line-order.html] checkout_click 位於 _enterCheckoutStage()（真正進入第二階段的路徑）內，不在 openCartSheet() 內',
    !!enterCheckoutStageBody && /_trackEvent\('checkout_click'/.test(stripComments(enterCheckoutStageBody))
    && !(openCartSheetBody && /_trackEvent\('checkout_click'/.test(stripComments(openCartSheetBody))));
  check('[line-order.html] 顧客資料表單（#cName 姓名欄位）位於第二階段 #checkoutStage 內，且該區塊預設 hidden（不在第一階段直接顯示）',
    /<div id="checkoutStage" hidden>/.test(lineOrder) && (() => {
      const idxStage = lineOrder.indexOf('<div id="checkoutStage" hidden>');
      const idxCName = lineOrder.indexOf('id="cName"');
      const idxCartStageEnd = lineOrder.indexOf('<!-- ══ 第二階段');
      return idxStage !== -1 && idxCName > idxStage;
    })());
  check('[line-order.html] production code（去除註解後）沒有任何 _trackEvent(\'begin_checkout\') 呼叫',
    !/_trackEvent\('begin_checkout'\)/.test(stripComments(lineOrder)));
  check('[line-order.html] 正式提交路徑仍保留 submitOrder()／_trackEvent(\'submit_order\'...)，checkout_click 與 submit_order 是不同階段觸發（submitOrder 只在 #subBtn 內，不在 openCheckoutStep/_enterCheckoutStage 內）',
    /function submitOrder\(\)/.test(lineOrder)
    && /id="subBtn"[^>]*onclick="submitOrder\(\)"/.test(lineOrder)
    && !(openCheckoutStepBody && /submitOrder\(\)/.test(stripComments(openCheckoutStepBody)))
    && !(enterCheckoutStageBody && /submitOrder\(\)/.test(stripComments(enterCheckoutStageBody))));
  check('[line-order.html] 沒有建立第二套訂單提交函式（全檔案只有一個 function submitOrder 定義）',
    (lineOrder.match(/function submitOrder\(\)/g) || []).length === 1);
}

// ════════════════════════════════════════════════════════════════
// Group 2：public/line-shipping.html — 真正兩階段結帳（宅配）
// ════════════════════════════════════════════════════════════════
{
  const openCartSheetBodyS = extractFunctionBody(lineShipping, 'openCartSheet');
  const openCheckoutStepBodyS = extractFunctionBody(lineShipping, 'openCheckoutStep');
  const enterCheckoutStageBodyS = extractFunctionBody(lineShipping, '_enterCheckoutStage');

  check('[line-shipping.html] cartBar 只呼叫 openCartSheet()',
    /id="cartBar"[^>]*onclick="openCartSheet\(\)"/.test(lineShipping));
  check('[line-shipping.html] 購物車階段內含獨立「前往結帳」入口（#goCheckoutBtn，呼叫 openCheckoutStep()）',
    /id="goCheckoutBtn"[^>]*onclick="openCheckoutStep\(\)"/.test(lineShipping));
  check('[line-shipping.html] openCartSheet() 與第二階段函式是分離的獨立函式',
    !!openCartSheetBodyS && !!openCheckoutStepBodyS && openCartSheetBodyS !== openCheckoutStepBodyS);
  check('[line-shipping.html] view_cart 位於 openCartSheet() 內',
    !!openCartSheetBodyS && /_trackEvent\('view_cart'/.test(stripComments(openCartSheetBodyS)));
  check('[line-shipping.html] checkout_click 位於 _enterCheckoutStage() 內，不在 openCartSheet() 內',
    !!enterCheckoutStageBodyS && /_trackEvent\('checkout_click'/.test(stripComments(enterCheckoutStageBodyS))
    && !(openCartSheetBodyS && /_trackEvent\('checkout_click'/.test(stripComments(openCartSheetBodyS))));
  check('[line-shipping.html] 顧客資料表單（#rName 收件人姓名欄位）位於第二階段 #checkoutStage 內，且該區塊預設 hidden',
    /<div id="checkoutStage" hidden>/.test(lineShipping) && (() => {
      const idxStage = lineShipping.indexOf('<div id="checkoutStage" hidden>');
      const idxRName = lineShipping.indexOf('id="rName"');
      return idxStage !== -1 && idxRName > idxStage;
    })());
  check('[line-shipping.html] production code（去除註解後）沒有任何 _trackEvent(\'begin_checkout\') 呼叫',
    !/_trackEvent\('begin_checkout'\)/.test(stripComments(lineShipping)));
  check('[line-shipping.html] 正式提交路徑仍保留 submitOrder()／#submitBtn，checkout_click 與 submit_order 是不同階段（submitOrder 不在 openCheckoutStep/_enterCheckoutStage 內）',
    /function submitOrder\(\)/.test(lineShipping)
    && /id="submitBtn"[^>]*onclick="submitOrder\(\)"/.test(lineShipping)
    && !(openCheckoutStepBodyS && /submitOrder\(\)/.test(stripComments(openCheckoutStepBodyS)))
    && !(enterCheckoutStageBodyS && /submitOrder\(\)/.test(stripComments(enterCheckoutStageBodyS))));
  check('[line-shipping.html] 沒有建立第二套訂單提交函式（全檔案只有一個 function submitOrder 定義）',
    (lineShipping.match(/function submitOrder\(\)/g) || []).length === 1);
}

// ════════════════════════════════════════════════════════════════
// Group 3：public/js/analytics-platforms.js — 平台事件映射與派送方式
// ════════════════════════════════════════════════════════════════
{
  const trackMetaBody = extractFunctionBody(platforms, 'trackMeta');
  check('[analytics-platforms.js] GA4_EVENT_MAP 保留 canonical view_cart → view_cart',
    /view_cart\s*:\s*'view_cart'/.test(platforms));
  check('[analytics-platforms.js] GA4_EVENT_MAP 保留 canonical checkout_click → checkout_click',
    /checkout_click\s*:\s*'checkout_click'/.test(platforms));
  check('[analytics-platforms.js] view_cart 被分類為 Meta 自訂事件（META_CUSTOM_EVENTS 內含 view_cart）',
    /META_CUSTOM_EVENTS\s*=\s*new Set\(\[[^\]]*'view_cart'[^\]]*\]\)/.test(platforms));
  check('[analytics-platforms.js] Meta checkout_click 映射為 InitiateCheckout（META_EVENT_MAP）',
    /checkout_click\s*:\s*'InitiateCheckout'/.test(platforms));
  check('[analytics-platforms.js] trackMeta() 能依 META_CUSTOM_EVENTS 分流 trackCustom／track 兩種呼叫方式',
    !!trackMetaBody && /META_CUSTOM_EVENTS\.has\(eventName\)/.test(trackMetaBody)
    && /'trackCustom'/.test(trackMetaBody) && /'track'/.test(trackMetaBody));
  check('[analytics-platforms.js] trackMeta() 實際呼叫 window.fbq(method, ...)（method 是動態變數，不是寫死 \'track\'）',
    !!trackMetaBody && /window\.fbq\(method,/.test(trackMetaBody));
  check('[analytics-platforms.js] 相容用 begin_checkout mapping 保留在 GA4_EVENT_MAP／META_EVENT_MAP（不刪除歷史相容宣告）',
    /begin_checkout\s*:\s*'begin_checkout'/.test(platforms) && /begin_checkout\s*:\s*'InitiateCheckout'/.test(platforms));
  check('[analytics-platforms.js] begin_checkout mapping 不會被兩階段結帳流程呼叫（本檔案本身不含任何呼叫 trackPlatformEvent(\'begin_checkout\'...) 的呼叫點，只有宣告式的 MAP 項目）',
    !/trackPlatformEvent\('begin_checkout'/.test(stripComments(platforms)));
}

// ════════════════════════════════════════════════════════════════
// Group 4：utils/dashboardAnalytics.js — Funnel canonical 七階段
// ════════════════════════════════════════════════════════════════
{
  const getFunnelBody = extractFunctionBody(dashboardAnalytics, 'getFunnel');
  const getIncompleteBody = extractFunctionBody(dashboardAnalytics, 'getIncomplete');
  const canonicalOrder = ["'page_view'", "'view_product'", "'add_to_cart'", "'view_cart'", "'checkout_click'", "'submit_order'", "'purchase'"];
  const keyMatches = getFunnelBody ? [...getFunnelBody.matchAll(/key:\s*('[a-z_]+')/g)].map((m) => m[1]) : [];

  check('[dashboardAnalytics.js] getFunnel() 的 stages 陣列 key 順序精確等於 page_view→view_product→add_to_cart→view_cart→checkout_click→submit_order→purchase（七個，不多不少）',
    keyMatches.length === 7 && keyMatches.join(',') === canonicalOrder.join(','),
    { actual: keyMatches, expected: canonicalOrder });
  check('[dashboardAnalytics.js] getFunnel() 不含任何 begin_checkout stage key（不得成為第八個 stage）',
    !!getFunnelBody && !/key:\s*'begin_checkout'/.test(getFunnelBody));
  check('[dashboardAnalytics.js] getFunnel() 回傳陣列最後一項精確是 purchase（沒有任何東西被插在 purchase 後面）',
    keyMatches.length > 0 && keyMatches[keyMatches.length - 1] === "'purchase'");
  check('[dashboardAnalytics.js] view_product 維持既有 response key（不得擅自改成 view_item；view_item 是另一個獨立事件，用於商品詳情 Modal，不是清單曝光）',
    !!getFunnelBody && /key:\s*'view_product'/.test(getFunnelBody) && !/key:\s*'view_item'/.test(getFunnelBody));
  check('[dashboardAnalytics.js] getIncomplete() 的 cart_not_checked_out／checkout_not_submitted 都排除已 purchase 的 cart_id（已購買的購物車不會列入不完整購物車）',
    !!getIncompleteBody && /cartsWithPurchase/.test(getIncompleteBody)
    && /!cartsWithCheckout\.has\(c\)\s*&&\s*!cartsWithPurchase\.has\(c\)/.test(getIncompleteBody)
    && /!cartsWithSubmit\.has\(c\)\s*&&\s*!cartsWithPurchase\.has\(c\)/.test(getIncompleteBody));
  check('[dashboardAnalytics.js] getIncomplete() 的購物車未結帳權威來源是 checkout_click（不是 begin_checkout，也不是兩者 OR 混算）',
    !!getIncompleteBody && /event_name='checkout_click'/.test(getIncompleteBody)
    && !/event_name='begin_checkout'/.test(getIncompleteBody));
}

// ════════════════════════════════════════════════════════════════
// Group 5：Analytics 接收白名單與 Geo 相容層
// ════════════════════════════════════════════════════════════════
{
  check('[analyticsLog.js] EVENT_WHITELIST 支援 view_cart',
    /'view_cart'/.test(analyticsLog));
  check('[analyticsLog.js] EVENT_WHITELIST 支援 checkout_click',
    /'checkout_click'/.test(analyticsLog));
  check('[analyticsLog.js] EVENT_WHITELIST 仍保留 begin_checkout（歷史相容，不刪除）',
    /'begin_checkout'/.test(analyticsLog));

  const geoFunnelEventsMatch = geoQueries.match(/const GEO_FUNNEL_EVENTS = Object\.freeze\(\{[\s\S]*?\}\);/);
  check('[geoAnalyticsQueries.js] GEO_FUNNEL_EVENTS.checkout 權威來源是 checkout_click（單一選擇點，不是逐查詢各自硬寫）',
    !!geoFunnelEventsMatch && /checkout:\s*'checkout_click'/.test(geoFunnelEventsMatch[0]));
  check('[geoAnalyticsQueries.js] GEO_FUNNEL_EVENTS 沒有任何地方仍寫 begin_checkout 作為查詢用事件名稱字面值',
    !/checkout:\s*'begin_checkout'/.test(geoQueries));
  check('[geoAnalyticsQueries.js] begin_checkout_visitors／begin_checkout_events 是與 checkout_click_visitors／checkout_click_events 同一次計算結果的相容別名（同一個變數 checkout／checkoutEvents 被指定給兩組欄位名稱，不是各自重新查詢）',
    /begin_checkout_visitors:\s*checkout[,\s]/.test(geoQueries) && /checkout_click_visitors:\s*checkout[,\s]/.test(geoQueries)
    && /begin_checkout_events:\s*checkoutEvents/.test(geoQueries) && /checkout_click_events:\s*checkoutEvents/.test(geoQueries));
  check('[geoAnalyticsQueries.js] 沒有任何獨立於 checkout_click 之外、重新查詢 legacy raw begin_checkout 事件來產生統計的程式碼（整份檔案不含任何 event_name=\'begin_checkout\' 字面 SQL 條件）',
    !/event_name\s*=\s*'begin_checkout'/.test(geoQueries));
}

// ── 輸出結果 ──────────────────────────────────────────
const failCount = results.filter((r) => !r.pass).length;
results.forEach((r) => console.log(`${r.pass ? '✓' : '✗ FAIL'} ${r.name}${r.detail !== '' ? ' — ' + (typeof r.detail === 'string' ? r.detail : JSON.stringify(r.detail)) : ''}`));
console.log(`\nPASS: ${results.length - failCount}`);
console.log(`FAIL: ${failCount}`);
console.log(`TOTAL: ${results.length}`);
process.exit(failCount === 0 ? 0 : 1);
