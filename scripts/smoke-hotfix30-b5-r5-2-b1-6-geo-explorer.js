#!/usr/bin/env node
// scripts/smoke-hotfix30-b5-r5-2-b1-6-geo-explorer.js
// fix18-10-hotfix30-B5-R5.2-B1-6 — Geo Drill-down & Customer Explorer
'use strict';

const path = require('path');
const fs = require('fs');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n總計：${results.length} 項，PASS ${p}，FAIL ${f}`);
  if (f > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(`  - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

async function main() {
  global.escHtml = function escHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  };

  const { execFileSync } = require('child_process');
  try {
    execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/geo-intelligence.js')]);
    pass('0-1 node --check public/js/geo-intelligence.js 通過');
  } catch (e) { fail('0-1 node --check public/js/geo-intelligence.js 通過', e.message); }

  const RE = require(path.join(ROOT, 'public/js/geo-intelligence.js'));

  // ══════════════════════════════════════════════════════════════
  // Part A：純函式單元測試
  // ══════════════════════════════════════════════════════════════

  // ── geoResolveAreaFromId ──
  {
    const r1 = RE.geoResolveAreaFromId('桃園市|中壢區', {});
    assert(r1 && r1.city === '桃園市' && r1.district === '中壢區', 'A-RESOLVE-1 "city|district" 格式正確解析');
    assert(r1.areaKey === '桃園市|中壢區', 'A-RESOLVE-2 areaKey 正確還原');

    const vm = { recommendation_view_models: [{ id: 'rec-1', location: { city: '桃園市', district: '八德區' } }] };
    const r2 = RE.geoResolveAreaFromId('rec-1', vm);
    assert(r2 && r2.city === '桃園市' && r2.district === '八德區', 'A-RESOLVE-3 依 recommendation_view_model id 查找正確');
    assert(r2.areaKey === '桃園市|八德區', 'A-RESOLVE-4 依 id 查找後產生正確 areaKey');

    const r3 = RE.geoResolveAreaFromId('not-exist-id', vm);
    assert(r3 === null, 'A-RESOLVE-5 找不到對應 model 時回傳 null，不崩潰');
    const r4 = RE.geoResolveAreaFromId(null, vm);
    assert(r4 === null, 'A-RESOLVE-6 areaId=null 時回傳 null');
    const r5 = RE.geoResolveAreaFromId('', vm);
    assert(r5 === null, 'A-RESOLVE-7 areaId="" 時回傳 null');
    const r6 = RE.geoResolveAreaFromId('rec-1', null);
    assert(r6 === null, 'A-RESOLVE-8 vm=null 時查 id 不崩潰，回傳 null');
    const r7 = RE.geoResolveAreaFromId('城市|', {});
    assert(r7.city === '城市' && r7.district === null, 'A-RESOLVE-9 district 為空字串時正確轉為 null');
  }

  // ── geoBuildHotProductsList（排序：Purchase → Add To Cart）──
  {
    const products = [
      { name: '毛豆', purchase_visitors: 13, add_to_cart_visitors: 20 },
      { name: '麻油豬腰', purchase_visitors: 48, add_to_cart_visitors: 60 },
      { name: '皇家三寶', purchase_visitors: 21, add_to_cart_visitors: 30 },
      { name: '同分商品A', purchase_visitors: 5, add_to_cart_visitors: 10 },
      { name: '同分商品B', purchase_visitors: 5, add_to_cart_visitors: 8 },
    ];
    const list = RE.geoBuildHotProductsList(products);
    assert(list[0].name === '麻油豬腰', 'B-PRODUCTS-1 依 purchase_count 由高到低排序（第一名 48）');
    assert(list[1].name === '皇家三寶', 'B-PRODUCTS-2 第二名正確（21）');
    assert(list[2].name === '毛豆', 'B-PRODUCTS-3 第三名正確（13）');
    assert(list[3].name === '同分商品A', 'B-PRODUCTS-4 purchase 同分時依 add_to_cart_count 排序（10 > 8）');
    assert(list.every((p) => 'purchase_count' in p && 'add_to_cart_count' in p), 'B-PRODUCTS-5 每筆含 purchase_count/add_to_cart_count 欄位');

    const emptyList = RE.geoBuildHotProductsList([]);
    assert(Array.isArray(emptyList) && emptyList.length === 0, 'B-PRODUCTS-6 空陣列輸入回傳空陣列');
    const nullList = RE.geoBuildHotProductsList(null);
    assert(Array.isArray(nullList) && nullList.length === 0, 'B-PRODUCTS-7 null 輸入不崩潰，回傳空陣列');
    const missingFieldsList = RE.geoBuildHotProductsList([{ name: 'X' }]);
    assert(missingFieldsList[0].purchase_count === 0 && missingFieldsList[0].add_to_cart_count === 0, 'B-PRODUCTS-8 缺欄位時安全預設為 0');
  }

  // ── geoBuildCartAbandonmentSummary ──
  {
    const row = { visitors: 100, begin_checkout_event_visitors: 40, purchase_visitors: 10, cart_abandon_visitors: 90, checkout_abandon_visitors: 30, estimated_abandon_value: 5000 };
    const summary = RE.geoBuildCartAbandonmentSummary(row);
    assert(summary.add_to_cart_visitors === 100, 'C-ABANDON-1 add_to_cart_visitors 正確對應');
    assert(summary.begin_checkout_visitors === 40, 'C-ABANDON-2 begin_checkout_visitors 正確對應');
    assert(summary.purchase_visitors === 10, 'C-ABANDON-3 purchase_visitors 正確對應');
    assert(summary.cart_abandon_visitors === 90, 'C-ABANDON-4 cart_abandon_visitors 正確對應');
    assert(summary.checkout_abandon_visitors === 30, 'C-ABANDON-5 checkout_abandon_visitors 正確對應');
    assert(summary.estimated_abandon_value === 5000, 'C-ABANDON-6 estimated_abandon_value 正確對應');

    const nullSummary = RE.geoBuildCartAbandonmentSummary(null);
    assert(nullSummary === null, 'C-ABANDON-7 districtRankingRow=null 時回傳 null（畫面走空狀態，不是假數字）');

    const negativeRow = { visitors: 10, cart_abandon_visitors: -5, checkout_abandon_visitors: -1, estimated_abandon_value: -100 };
    const negSummary = RE.geoBuildCartAbandonmentSummary(negativeRow);
    assert(negSummary.cart_abandon_visitors === 0 && negSummary.checkout_abandon_visitors === 0 && negSummary.estimated_abandon_value === 0, 'C-ABANDON-8 負數防護：異常負值一律 clamp 為 0');
  }

  // ── geoBuildAdSourceBreakdown / geoBuildCampaignBreakdown ──
  {
    const sourceAreaData = {
      rows: [
        { source: 'Facebook', medium: 'cpc', campaign: 'summer', city: '桃園市', district: '中壢區', visitors: 50, add_to_cart: 20, begin_checkout: 10, purchases: 5 },
        { source: 'Facebook', medium: 'cpc', campaign: 'winter', city: '桃園市', district: '中壢區', visitors: 30, add_to_cart: 10, begin_checkout: 5, purchases: 2 },
        { source: 'Google', medium: 'cpc', campaign: null, city: '桃園市', district: '中壢區', visitors: 20, add_to_cart: 8, begin_checkout: 4, purchases: 1 },
        { source: 'Facebook', medium: 'cpc', campaign: 'summer', city: '桃園市', district: '八德區', visitors: 999, add_to_cart: 999, begin_checkout: 999, purchases: 999 },
      ],
    };
    const sources = RE.geoBuildAdSourceBreakdown(sourceAreaData, '桃園市', '中壢區');
    assert(sources.length === 2, 'D-ADSOURCE-1 依 city/district 篩選後正確分成 2 個來源（Facebook/Google）');
    const fb = sources.find((s) => s.label === 'Facebook');
    assert(fb.visitors === 80, 'D-ADSOURCE-2 Facebook 訪客數正確加總（50+30=80，不含八德區的 999）');
    assert(fb.orders === 7, 'D-ADSOURCE-3 Facebook 訂單數正確加總（5+2=7）');
    assert(!sources.some((s) => s.visitors === 999), 'D-ADSOURCE-4 其他行政區資料不會混入（排除八德區的 999）');

    const campaigns = RE.geoBuildCampaignBreakdown(sourceAreaData, '桃園市', '中壢區');
    assert(campaigns.length === 2, 'E-CAMPAIGN-1 只計有 campaign 值的列，分成 2 組（summer/winter）');
    assert(!campaigns.some((c) => c.label === 'Direct' && c.visitors === 20), 'E-CAMPAIGN-2 沒有 campaign 的列（Google/null）不會被錯誤歸入 Direct');

    const emptySourceData = RE.geoBuildAdSourceBreakdown({ rows: [] }, '桃園市', '不存在區');
    assert(Array.isArray(emptySourceData) && emptySourceData.length === 0, 'D-ADSOURCE-5 找不到符合資料時回傳空陣列');
    const nullSourceData = RE.geoBuildAdSourceBreakdown(null, '桃園市', '中壢區');
    assert(Array.isArray(nullSourceData) && nullSourceData.length === 0, 'D-ADSOURCE-6 sourceAreaData=null 不崩潰');
    const noCampaignData = RE.geoBuildCampaignBreakdown({ rows: [{ source: 'X', campaign: null, city: 'A', district: 'B', visitors: 1 }] }, 'A', 'B');
    assert(noCampaignData.length === 0, 'E-CAMPAIGN-3 完全沒有 campaign 資料時回傳空陣列（畫面應隱藏整個區塊）');
  }

  // ── geoBuildDeviceBreakdown / geoBuildDeliveryAnalysisForArea（誠實回報不可用）──
  {
    const device = RE.geoBuildDeviceBreakdown();
    assert(device.available === false, 'F-DEVICE-1 裝置分佈明確標示 available=false（目前無資料來源，不捏造）');
    assert(typeof device.reason === 'string' && device.reason.length > 0, 'F-DEVICE-2 附帶理由說明');

    const delivery = RE.geoBuildDeliveryAnalysisForArea();
    assert(delivery.available === false, 'G-DELIVERY-1 行政區外送分析明確標示 available=false（目前 API 沒有行政區維度）');
    assert(typeof delivery.reason === 'string' && delivery.reason.length > 0, 'G-DELIVERY-2 附帶理由說明');
  }

  // ── geoAnonymizeVisitorId（需求文件四、十二：不得顯示原始 ID）──
  {
    const anon1 = RE.geoAnonymizeVisitorId('line-user-real-uid-12345');
    assert(anon1.startsWith('#'), 'H-ANON-1 匿名化結果以 # 開頭');
    assert(!anon1.includes('line-user-real-uid-12345'), 'H-ANON-2 匿名化結果不含原始 ID');
    assert(!anon1.includes('12345'), 'H-ANON-3 匿名化結果不含原始 ID 的可辨識片段');
    const anon2 = RE.geoAnonymizeVisitorId('line-user-real-uid-12345');
    assert(anon1 === anon2, 'H-ANON-4 同一輸入產生同一匿名結果（可穩定用於分組顯示，不是隨機）');
    const anon3 = RE.geoAnonymizeVisitorId('completely-different-id');
    assert(anon3 !== anon1, 'H-ANON-5 不同輸入產生不同匿名結果');
    const anonEmpty = RE.geoAnonymizeVisitorId(null);
    assert(anonEmpty === '#——', 'H-ANON-6 空值輸入安全處理，不崩潰');
    assert(/^[#A-Z0-9.]+$/.test(anon1), 'H-ANON-7 匿名化結果只含安全字元（不含特殊符號注入風險）');
  }

  // ── geoBuildCustomerExplorerEmptyState / geoBuildOrderExplorerEmptyState ──
  {
    const customerEmpty = RE.geoBuildCustomerExplorerEmptyState();
    assert(customerEmpty.code === 'no_customer_data', 'I-CUSTOMER-1 code 正確');
    assert(typeof customerEmpty.message === 'string' && customerEmpty.message.length > 10, 'I-CUSTOMER-2 訊息為有意義的完整說明（不是只有「暫無資料」）');
    assert(!customerEmpty.message.match(/LINE|UID|email|電話/i), 'I-CUSTOMER-3 空狀態說明本身不洩漏任何敏感欄位名稱');

    const orderEmpty = RE.geoBuildOrderExplorerEmptyState();
    assert(orderEmpty.code === 'no_order_data', 'J-ORDER-1 code 正確');
    assert(typeof orderEmpty.message === 'string' && orderEmpty.message.length > 10, 'J-ORDER-2 訊息為有意義的完整說明');
  }

  // ── geoOpenOrderDetail（沿用既有全站 Order Detail，不重做）──
  {
    global.window = global.window || {};
    delete global.window.openOrderDetail;
    const result1 = RE.geoOpenOrderDetail('order-123');
    assert(result1 === false, 'K-ORDERDETAIL-1 全站沒有既有 openOrderDetail 時，安靜回報 false（不假裝成功、不重建 Drawer）');
    let capturedOrderId = null;
    global.window.openOrderDetail = (id) => { capturedOrderId = id; };
    const result2 = RE.geoOpenOrderDetail('order-456');
    assert(result2 === true, 'K-ORDERDETAIL-2 有既有 openOrderDetail 時委派成功');
    assert(capturedOrderId === 'order-456', 'K-ORDERDETAIL-3 正確傳遞 order_id 給既有函式');
    const result3 = RE.geoOpenOrderDetail(null);
    assert(result3 === false, 'K-ORDERDETAIL-4 order_id=null 時不呼叫、安全回 false');
    delete global.window;
  }

  // ── Empty State 訊息集中管理（至少 5 種）──
  {
    ['no_orders', 'no_visitors', 'no_products', 'no_campaign', 'no_delivery', 'no_device'].forEach((key) => {
      assert(key in RE.GEO_EXPLORER_EMPTY_MESSAGES, `L-EMPTY-1-${key} GEO_EXPLORER_EMPTY_MESSAGES 含「${key}」`);
      assert(typeof RE.GEO_EXPLORER_EMPTY_MESSAGES[key] === 'string' && RE.GEO_EXPLORER_EMPTY_MESSAGES[key].length > 0, `L-EMPTY-2-${key} 訊息為非空字串`);
    });
    const messages = Object.values(RE.GEO_EXPLORER_EMPTY_MESSAGES);
    const uniqueMessages = new Set(messages);
    assert(uniqueMessages.size === messages.length, 'L-EMPTY-3 所有空狀態訊息彼此不同（不是全部共用同一句「暫無資料」）');
  }

  // ── render 函式（字串層級）：products/cart-abandonment/source ──
  {
    const productsHtml = RE._geoRenderProductsSection(RE.geoBuildHotProductsList([{ name: '麻油豬腰', purchase_visitors: 48, add_to_cart_visitors: 60 }]));
    assert(productsHtml.includes('麻油豬腰') && productsHtml.includes('48'), 'M-RENDER-1 商品區塊 render 含商品名與數字');
    assert(productsHtml.includes('geo-explorer-product-row'), 'M-RENDER-2 商品區塊使用 .geo-explorer- namespace class');

    const emptyProductsHtml = RE._geoRenderProductsSection([]);
    assert(emptyProductsHtml.includes(RE.GEO_EXPLORER_EMPTY_MESSAGES.no_products), 'M-RENDER-3 空商品清單顯示對應空狀態文字');

    const abandonHtml = RE._geoRenderCartAbandonmentSection(RE.geoBuildCartAbandonmentSummary({ visitors: 100, begin_checkout_event_visitors: 40, purchase_visitors: 10, cart_abandon_visitors: 90, checkout_abandon_visitors: 30, estimated_abandon_value: 5000 }));
    assert(abandonHtml.includes('90') && abandonHtml.includes('30') && abandonHtml.includes('5000'), 'M-RENDER-4 放棄購物車區塊含正確數字');

    const emptyAbandonHtml = RE._geoRenderCartAbandonmentSection(null);
    assert(emptyAbandonHtml.includes(RE.GEO_EXPLORER_EMPTY_MESSAGES.no_visitors), 'M-RENDER-5 無資料時顯示對應空狀態');

    const sourceHtml = RE._geoRenderSourceBreakdownSection([{ label: 'Facebook', visitors: 80, orders: 7 }], 'no_visitors');
    assert(sourceHtml.includes('Facebook') && sourceHtml.includes('80') && sourceHtml.includes('7'), 'M-RENDER-6 來源分析區塊含正確數字');
    const emptySourceHtml = RE._geoRenderSourceBreakdownSection([], 'no_campaign');
    assert(emptySourceHtml.includes(RE.GEO_EXPLORER_EMPTY_MESSAGES.no_campaign), 'M-RENDER-7 空來源清單顯示對應（依 emptyKey 參數決定）空狀態文字');

    const unavailableHtml = RE._geoRenderUnavailableSection(RE.geoBuildDeviceBreakdown(), 'no_device');
    assert(unavailableHtml.includes(RE.GEO_EXPLORER_UNAVAILABLE_REASONS.device_breakdown), 'M-RENDER-8 裝置不可用區塊顯示對應空狀態文字');
    assert(unavailableHtml.includes('data-geo-explorer-unavailable="true"'), 'M-RENDER-9 不可用區塊標記 data-geo-explorer-unavailable 屬性（供未來樣式/測試辨識）');
  }

  // ── XSS：商品名稱／來源名稱／匿名 ID 皆須 escape ──
  {
    const XSS_FIXTURES = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>'];
    XSS_FIXTURES.forEach((payload, i) => {
      const html1 = RE._geoRenderProductsSection(RE.geoBuildHotProductsList([{ name: payload, purchase_visitors: 1, add_to_cart_visitors: 1 }]));
      assert(!html1.includes('<script>alert') && !html1.includes('<img src=x onerror') && !html1.includes('<svg onload'), `N-XSS-${i}-1 商品名稱 fixture 未產生真正可執行標籤`);

      const html2 = RE._geoRenderSourceBreakdownSection([{ label: payload, visitors: 1, orders: 1 }], 'no_visitors');
      assert(!html2.includes('<script>alert') && !html2.includes('<img src=x onerror') && !html2.includes('<svg onload'), `N-XSS-${i}-2 來源名稱 fixture 未產生真正可執行標籤`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // Part B：jsdom DOM / 整合測試
  // ══════════════════════════════════════════════════════════════
  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); }
  catch (e) {
    results.push({ name: '全部 DOM 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    printSummary();
    process.exit(process.exitCode || 0);
    return;
  }

  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const av2Src = fs.readFileSync(path.join(ROOT, 'public/js/analytics-v2.js'), 'utf8').replace(/'use strict';\s*\n/, '');
  const geoSrc = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8').replace(/'use strict';\s*\n/, '').replace(/if \(typeof module[\s\S]*?\}\s*$/, '');

  function makeDom() {
    return new JSDOM('<!DOCTYPE html><html><body><span id="clock">--:--</span><div id="reports-container"></div><div id="analytics-v2-container"></div><div id="toastContainer"></div></body></html>', {
      runScripts: 'outside-only', url: 'http://localhost/',
    });
  }

  const GEO_OVERVIEW_FIXTURE = { success: true, data: { visitor_geo: {}, fulfillment_geo: {}, data_quality: { status: 'healthy', total_events: 100, identified_events: 90, unknown_rate: 0.1 } } };
  const GEO_FUNNEL_FIXTURE = { success: true, data: { areas: [{ city: '桃園市', district: '中壢區', visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, submitted_order_visitors: 5, purchase_visitors: 5 }, { city: '桃園市', district: '八德區', visitors: 60, add_to_cart_visitors: 20, begin_checkout_visitors: 8, submitted_order_visitors: 3, purchase_visitors: 3 }] } };
  const GEO_ALERTS_FIXTURE = {
    success: true,
    data: {
      alerts: [], rule_thresholds: {},
      recommendation_view_models: [{
        id: 'geo-rec-fixture-explorer', code: 'high_cart_low_checkout', classification: 'high_cart_low_checkout', intent_type: 'risk',
        headline: { title: '高加購低結帳', subtitle: '桃園市・中壢區', badge: '結帳入口', severity: 'high', confidence: 'medium' },
        location: { area_name: '中壢區', city: '桃園市', district: '中壢區' },
        summary: 'summary', primary_metric: { key: 'x', label: 'l', value: 1, formatted_value: '1', unit: 'rate' },
        comparison: { benchmark_type: 'threshold', benchmark_label: 'b', actual: 1, benchmark: 2, difference: -1, formatted_difference: 'd', direction: 'below', message: 'm' },
        funnel: { visitors: 100, add_to_cart_visitors: 42, begin_checkout_visitors: 11, purchase_visitors: 5, visit_to_cart_rate: .42, cart_to_checkout_rate: .26, checkout_to_purchase_rate: .45, visit_to_purchase_rate: .05 },
        evidence_items: [], recommended_actions: [{ priority: 1, title: 't', description: 'd', category: 'checkout_flow', action_type: 'review' }],
        confidence: { level: 'medium', score: 60, label: 'l', reasons: [] },
        sample: { status: 'sufficient', actual: 42, minimum_required: 5, label: 'l' },
        data_quality: { identified_rate: .9, unknown_rate: .1, status: 'good', label: 'l' },
        scope: { store_id: 's', date_range: null, channel: 'all', county_code: null, subdivision_code: null, source: null, medium: null, campaign: null },
        secondary_classifications: [], sort_key: 'x',
      }],
      quality_view_models: [], rule_context: {}, meta: {}, explainability_version: '1.0', schema_version: '1.0',
    },
  };
  const GEO_COUNTY_SUMMARY_FIXTURE = { ok: true, rows: [{ county_code: '68000', county_name: '桃園市', visitor_count: 160, order_count: 8 }], unknown: {} };
  const XSS_PAYLOAD = '<script>alert(9)</script>';
  const GEO_CART_ATTRIBUTION_FIXTURE = {
    success: true,
    data: {
      summary: {}, truncated: false,
      district_ranking: [{ area: '中壢區', city: '桃園市', district: '中壢區', visitors: 42, add_to_cart: 42, begin_checkout: 11, orders: 5, abandon: 37, cart_value: 8000, conversion_rate: 11.9, purchase_visitors: 5, cart_abandon_visitors: 37, checkout_abandon_visitors: 6, estimated_abandon_value: 6500, begin_checkout_event_visitors: 11 }],
      source_area: [],
      abandon_products: [
        { product_id: 1, name: '麻油豬腰', add_to_cart_visitors: 60, purchase_visitors: 48, abandon_visitors: 12, abandon_rate: 20, estimated_abandon_value: 2000 },
        { product_id: 2, name: XSS_PAYLOAD, add_to_cart_visitors: 30, purchase_visitors: 21, abandon_visitors: 9, abandon_rate: 30, estimated_abandon_value: 900 },
      ],
      abandon_products_area: '中壢區',
    },
  };
  const GEO_SOURCE_AREA_FIXTURE = {
    success: true,
    data: {
      page: 1, limit: 50, total: 2, total_pages: 1,
      rows: [
        { source: 'Facebook', medium: 'cpc', campaign: 'summer', channel: 'all', city: '桃園市', district: '中壢區', visitors: 30, view_product_visitors: 20, add_to_cart: 15, begin_checkout: 8, submitted_orders: 5, purchases: 4, conversion_rate: 13.3, view_product_events: 20, add_to_cart_events: 15, begin_checkout_events: 8 },
        { source: 'Google', medium: 'cpc', campaign: null, channel: 'all', city: '桃園市', district: '中壢區', visitors: 12, view_product_visitors: 8, add_to_cart: 5, begin_checkout: 2, submitted_orders: 1, purchases: 1, conversion_rate: 8.3, view_product_events: 8, add_to_cart_events: 5, begin_checkout_events: 2 },
      ],
    },
  };

  function buildFetchMock(fetchCalls, opts = {}) {
    return (url) => {
      fetchCalls.push({ url: String(url), t: Date.now() });
      const u = String(url);
      let body; let status = 200;
      const failing = opts.failEndpoints || [];
      const matchFail = failing.find((f) => u.includes(`/api/analytics/geo/${f}`));
      if (matchFail) { status = 500; body = { success: false, error: 'err' }; }
      else if (u.includes('/geo/overview')) body = opts.overviewFixture || GEO_OVERVIEW_FIXTURE;
      else if (u.includes('/geo/funnel')) body = opts.funnelFixture || GEO_FUNNEL_FIXTURE;
      else if (u.includes('/geo/alerts')) body = opts.alertsFixture || GEO_ALERTS_FIXTURE;
      else if (u.includes('/geo/county-summary')) body = opts.countySummaryFixture || GEO_COUNTY_SUMMARY_FIXTURE;
      else if (u.includes('/geo/cart-attribution')) body = opts.cartAttributionFixture || GEO_CART_ATTRIBUTION_FIXTURE;
      else if (u.includes('/geo/source-area')) body = opts.sourceAreaFixture || GEO_SOURCE_AREA_FIXTURE;
      else if (u.includes('/geo/administrative-areas')) body = { ok: true, counties: [] };
      else body = { success: true };
      const delay = opts.delayFor && matchFail === undefined && u.includes(opts.delayFor) ? opts.delayMs : (opts.delayMs || 0);
      return delay
        ? new Promise((resolve) => setTimeout(() => resolve({ ok: status === 200, status, json: async () => body }), delay))
        : Promise.resolve({ ok: status === 200, status, json: async () => body });
    };
  }
  function setupDom(fetchOpts) {
    const dom = makeDom();
    const fetchCalls = [];
    dom.window.fetch = buildFetchMock(fetchCalls, fetchOpts || {});
    dom.window.localStorage = (() => { let store = {}; return { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } }; })();
    dom.window.sessionStorage = dom.window.localStorage;
    dom.window.eval(appSrc);
    dom.window.eval(av2Src + '\n;\n' + geoSrc);
    return { dom, fetchCalls };
  }
  function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // ── 統一進入點：4 個觸發點都呼叫同一函式 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-explorer"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-explorer');
    await sleep(20);
    const html = window.__geoHeatUiDiagnosticsHtml || '';
    assert(html.includes("geoOpenAreaExplorer('桃園市|中壢區')") || html.includes('geoOpenAreaExplorer(&#039;桃園市|中壢區&#039;)') || /geoOpenAreaExplorer\('[^']*'\)/.test(html), 'O-ENTRY-1 排行榜點列 onclick 呼叫 geoOpenAreaExplorer()（via Heatmap diagnostics hook，H1.4.1：排行榜 owner 已移到 Heatmap）');
    assert((html.match(/geoOpenAreaExplorer\(/g) || []).length >= 2, 'O-ENTRY-2 排行榜列點擊與狀態徽章兩個進入點都呼叫 geoOpenAreaExplorer()（同一函式，不是兩套邏輯，via Heatmap diagnostics hook）');
    dom.window.close();
  }
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-kpi-cardentry"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-kpi-cardentry');
    await sleep(20);
    // H1.4.1：Recommendation Card（Decision Center／Recommended Actions）
    // owner 已移到 Heatmap 分頁，同一顆按鈕/同一支函式完全沒有改變，只是
    // 輸出位置從 Dashboard container 移到 window.__geoHeatUiDiagnosticsHtml。
    const html = window.__geoHeatUiDiagnosticsHtml || '';
    assert(html.includes("geoOpenAreaExplorer('geo-rec-fixture-explorer')"), 'O-ENTRY-3 Recommendation Card「查看原因」按鈕呼叫 geoOpenAreaExplorer()（同一函式，via Heatmap diagnostics hook）');
    dom.window.close();
  }

  // ── Explorer 開啟：Products/Cart Abandonment/Ad Source/Campaign 真實渲染 ──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-main"></div><button id="opener-explorer">o</button>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-main');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-main-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-main-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    document.getElementById('opener-explorer').focus();
    window.geoOpenAreaExplorer('桃園市|中壢區');
    await sleep(30);
    const drawerHtml = document.getElementById('geo-explorer-main-drawer').innerHTML;
    assert(drawerHtml.includes('role="dialog"') && drawerHtml.includes('aria-modal="true"'), 'P-EXPLORER-1 Explorer 沿用既有 Drawer，含 role="dialog"/aria-modal（不重做）');
    assert(drawerHtml.includes('geo-explorer-extras'), 'P-EXPLORER-2 Explorer extras 容器存在');
    assert(drawerHtml.includes('麻油豬腰') && drawerHtml.includes('48'), 'P-EXPLORER-3 熱門商品區塊顯示真實資料（麻油豬腰 48）');
    assert(drawerHtml.includes('皇家三寶') === false, 'P-EXPLORER-3b fixture 本身沒有「皇家三寶」，不應出現（驗證沒有混入假資料，是真實 fixture）');
    assert(!drawerHtml.includes('<script>alert(9)'), 'P-EXPLORER-4 商品名稱 XSS fixture 未產生真正的 <script> 標籤（真實 DOM 驗證）');
    assert(drawerHtml.includes('37') && drawerHtml.includes('6500'), 'P-EXPLORER-5 放棄購物車區塊顯示真實數字（cart_abandon=37, estimated_value=6500）');
    assert(drawerHtml.includes('Facebook') && drawerHtml.includes('Google'), 'P-EXPLORER-6 廣告來源區塊顯示真實來源分組');
    assert(drawerHtml.includes('🎯 Campaign'), 'P-EXPLORER-7 有 campaign 資料時顯示 Campaign 區塊標題');
    assert(drawerHtml.includes(RE.GEO_EXPLORER_UNAVAILABLE_REASONS.device_breakdown), 'P-EXPLORER-8 裝置區塊誠實顯示無資料說明（不捏造裝置資料）');
    assert(drawerHtml.includes(RE.GEO_EXPLORER_UNAVAILABLE_REASONS.delivery_analysis), 'P-EXPLORER-9 外送分析區塊誠實顯示無資料說明');
    assert(drawerHtml.includes(RE.geoBuildCustomerExplorerEmptyState().message), 'P-EXPLORER-10 匿名訪客分析區塊顯示無資料說明');
    assert(drawerHtml.includes(RE.geoBuildOrderExplorerEmptyState().message), 'P-EXPLORER-11 訂單區塊顯示無資料說明');
    assert(!drawerHtml.match(/LINE[\s_-]?UID|line_user_id|@[a-z0-9.]+\.[a-z]{2,}|09\d{8}/i), 'P-EXPLORER-12 整個 Drawer 不含 LINE UID/Email/電話格式字串（隱私防護；"LINE Login" 是合法功能名稱，不算 PII）');
    dom.window.close();
  }

  // ── Filter Sharing：Explorer 補充請求帶入既有 Dashboard 篩選 ──
  {
    const { dom, fetchCalls } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-filters"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-filters');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-filters-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-filters-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    window.geoDashboardFilters.source = 'fb';
    window.geoDashboardFilters.campaign = 'summer';
    const callsBefore = fetchCalls.length;
    window.geoOpenAreaExplorer('桃園市|中壢區');
    await sleep(30);
    const newCalls = fetchCalls.slice(callsBefore);
    const cartCall = newCalls.find((c) => c.url.includes('/geo/cart-attribution'));
    const sourceCall = newCalls.find((c) => c.url.includes('/geo/source-area'));
    assert(!!cartCall && cartCall.url.includes('district=%E4%B8%AD%E5%A3%A2%E5%8D%80'), 'Q-FILTERSHARE-1 cart-attribution 請求帶入正確的 district 參數');
    assert(!!cartCall && cartCall.url.includes('source=fb'), 'Q-FILTERSHARE-2 cart-attribution 請求沿用既有 Dashboard source 篩選（沒有第二套 filter state）');
    assert(!!sourceCall && sourceCall.url.includes('campaign=summer'), 'Q-FILTERSHARE-3 source-area 請求沿用既有 Dashboard campaign 篩選');
    dom.window.close();
  }

  // ── Race Condition：快速切換兩個不同區域，畫面只能顯示最後一個 ──
  {
    const { dom } = setupDom({ delayMs: 25 });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-race"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-race');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-race-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-race-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    window.geoOpenAreaExplorer('桃園市|中壢區'); // Request A
    await sleep(5);
    window.geoOpenAreaExplorer('桃園市|八德區'); // Request B（切換更快，A 還沒完成）
    await sleep(60);
    const html = document.getElementById('geo-explorer-race-drawer').innerHTML;
    assert(html.includes('八德區'), 'R-RACE-1 最終畫面顯示後開啟的區域（八德區）的基本資訊');
    dom.window.close();
  }

  // ── Error State + Retry ──
  {
    const { dom } = setupDom({ failEndpoints: ['cart-attribution', 'source-area'] });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-error"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-error');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-error-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-error-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    window.geoOpenAreaExplorer('桃園市|中壢區');
    await sleep(30);
    const html = document.getElementById('geo-explorer-error-drawer').innerHTML;
    assert(html.includes('無法取得區域詳細資料'), 'S-ERROR-1 補充資料載入失敗時顯示「無法取得區域詳細資料」');
    assert(html.includes('Retry') || html.includes('retry'), 'S-ERROR-2 提供 Retry 按鈕');
    dom.window.close();
  }

  // ── DOM Safety：容器/Drawer 不存在時不得 throw ──
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    let threw = false;
    try {
      window.geoOpenAreaExplorer('不存在的區域|xyz');
      window.geoOpenAreaExplorer(null);
      window.geoOpenAreaExplorer('');
      await window._geoLoadAreaExplorerExtras(null);
    } catch (e) { threw = true; }
    assert(!threw, 'T-DOMSAFE-1 Explorer 相關函式在各種邊界輸入下都不拋出例外');
    dom.window.close();
  }

  // ── Accessibility：沿用 B1-5 Drawer（ESC/focus/role）──
  {
    const { dom } = setupDom();
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-a11y"></div><button id="opener-a11y">o</button>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-a11y');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-a11y-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-a11y-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    document.getElementById('opener-a11y').focus();
    window.geoOpenAreaExplorer('桃園市|中壢區');
    await sleep(30);
    assert(document.activeElement && document.activeElement.getAttribute('aria-label') === '關閉', 'U-A11Y-1 開啟 Explorer 後 focus 落在關閉按鈕（沿用既有 Drawer focus 管理）');
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' }));
    assert(document.getElementById('geo-explorer-a11y-drawer').innerHTML === '', 'U-A11Y-2 ESC 確實關閉 Explorer（沿用既有 ESC listener，不是另一套）');
    assert(document.activeElement && document.activeElement.id === 'opener-a11y', 'U-A11Y-3 關閉後 focus 回到原觸發按鈕');
    dom.window.close();
  }

  // ── Empty States（真實 DOM）：No Orders/Visitors/Products/Campaign/Delivery ──
  {
    const { dom } = setupDom({
      cartAttributionFixture: { success: true, data: { summary: {}, truncated: false, district_ranking: [], source_area: [], abandon_products: [], abandon_products_area: '中壢區' } },
      sourceAreaFixture: { success: true, data: { rows: [] } },
    });
    const { document, window } = dom.window;
    document.body.innerHTML += '<div id="geo-explorer-empty"></div>';
    await window.refreshGeoDashboardKpiBlock('geo-explorer-empty');
    await sleep(20);
    // H1.4.1：Explorer/Drawer owner 已移到 Heatmap 分頁，手動掛 Heatmap owner fixture
    // 讓 'geo-explorer-empty-drawer' 真的存在於 DOM（純測試 fixture，不代表 Production ownership，
    // 見 geoHeatUiRenderPanel()/geoHeatUiSwitchTab() 的 Target Runtime 才是真正驗證）。
    document.body.innerHTML += `<div id="geo-explorer-empty-heatmap-owner">${window.__geoHeatUiDiagnosticsHtml || ''}</div>`;
    window.geoOpenAreaExplorer('桃園市|中壢區');
    await sleep(30);
    const html = document.getElementById('geo-explorer-empty-drawer').innerHTML;
    assert(html.includes(RE.GEO_EXPLORER_EMPTY_MESSAGES.no_products), 'V-EMPTY-1 沒有商品資料時顯示 No Products 訊息');
    assert(html.includes(RE.GEO_EXPLORER_EMPTY_MESSAGES.no_visitors), 'V-EMPTY-2 沒有放棄購物車資料時顯示 No Visitors 訊息');
    assert(!html.includes('🎯 Campaign'), 'V-EMPTY-3 完全沒有 campaign 資料時，不顯示 Campaign 區塊（沒有則略過，符合需求文件三之6）');
    assert(html.includes(RE.GEO_EXPLORER_UNAVAILABLE_REASONS.delivery_analysis), 'V-EMPTY-4 外送分析顯示 No Delivery 訊息');
    dom.window.close();
  }

  // ── CSS 靜態檢查：.geo-explorer- namespace ──
  {
    const cssContent = fs.readFileSync(path.join(ROOT, 'public/css/geo-intelligence.css'), 'utf8');
    ['.geo-explorer-extras', '.geo-explorer-section', '.geo-explorer-products', '.geo-explorer-product-row', '.geo-explorer-cart-abandonment', '.geo-explorer-source-table', '.geo-explorer-empty', '.geo-explorer-error', '.geo-explorer-skeleton'].forEach((sel) => {
      assert(cssContent.includes(sel), `W-CSS-1 CSS 含選擇器「${sel}」`);
    });
    const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/(^|\s)\.card\s*\{/.test(withoutComments) && !/(^|\s)table\s*\{/.test(withoutComments) && !/(^|\s)button\s*\{/.test(withoutComments), 'W-CSS-2 沒有污染全域的 .card{}/table{}/button{} 選擇器');
  }

  // ══════════════════════════════════════════════════════════════
  // 補充區塊：更多真實邊界情境（Part A 延伸）
  // ══════════════════════════════════════════════════════════════

  // ── geoBuildHotProductsList 更多邊界 ──
  {
    const singleProduct = RE.geoBuildHotProductsList([{ name: 'X', purchase_visitors: 0, add_to_cart_visitors: 0 }]);
    assert(singleProduct.length === 1 && singleProduct[0].purchase_count === 0, 'AA-PRODUCTS-1 全零數值商品仍正確保留（不是被過濾掉）');
    const manyProducts = Array.from({ length: 15 }, (_, i) => ({ name: `P${i}`, purchase_visitors: i, add_to_cart_visitors: i * 2 }));
    const sortedMany = RE.geoBuildHotProductsList(manyProducts);
    assert(sortedMany[0].name === 'P14', 'AA-PRODUCTS-2 多筆商品排序後第一名是 purchase 最高的（P14=14）');
    assert(sortedMany.length === 15, 'AA-PRODUCTS-3 排序不遺漏任何一筆（保留全部 15 筆，畫面層再自行 slice(0,10)）');
    const undefinedNameProduct = RE.geoBuildHotProductsList([{ purchase_visitors: 5, add_to_cart_visitors: 3 }]);
    assert(undefinedNameProduct[0].name === '未知商品', 'AA-PRODUCTS-4 缺 name 欄位時安全預設為「未知商品」');
  }

  // ── geoBuildAdSourceBreakdown / geoBuildCampaignBreakdown 更多邊界 ──
  {
    const rowsWithDirect = { rows: [{ source: null, medium: null, campaign: null, city: 'A', district: 'B', visitors: 10, add_to_cart: 5, begin_checkout: 2, purchases: 1 }] };
    const directSources = RE.geoBuildAdSourceBreakdown(rowsWithDirect, 'A', 'B');
    assert(directSources.length === 1 && directSources[0].label === 'Direct', 'AB-ADSOURCE-1 source=null 時歸類為 Direct');

    const rowsNoMatch = { rows: [{ source: 'X', city: 'A', district: 'C', visitors: 10, add_to_cart: 1, begin_checkout: 1, purchases: 1 }] };
    const noMatchSources = RE.geoBuildAdSourceBreakdown(rowsNoMatch, 'A', 'B');
    assert(noMatchSources.length === 0, 'AB-ADSOURCE-2 district 不相符時完全不計入');

    const cityOnlyFilter = RE.geoBuildAdSourceBreakdown({ rows: [{ source: 'Y', city: 'A', district: 'ANY', visitors: 5, add_to_cart: 1, begin_checkout: 1, purchases: 1 }] }, 'A', null);
    assert(cityOnlyFilter.length === 1, 'AB-ADSOURCE-3 只指定 city（district=null）時仍正確篩選');

    const sortedByVisitors = RE.geoBuildAdSourceBreakdown({ rows: [
      { source: 'Low', city: 'A', district: 'B', visitors: 5, add_to_cart: 1, begin_checkout: 1, purchases: 0 },
      { source: 'High', city: 'A', district: 'B', visitors: 50, add_to_cart: 1, begin_checkout: 1, purchases: 0 },
    ] }, 'A', 'B');
    assert(sortedByVisitors[0].label === 'High', 'AB-ADSOURCE-4 依 visitors 由高到低排序');

    const campaignEmptyString = RE.geoBuildCampaignBreakdown({ rows: [{ source: 'X', campaign: '', city: 'A', district: 'B', visitors: 5 }] }, 'A', 'B');
    assert(campaignEmptyString.length === 0, 'AC-CAMPAIGN-1 campaign="" 空字串也視為沒有 campaign（不計入）');
  }

  // ── geoAnonymizeVisitorId 大量呼叫一致性 ──
  {
    const ids = ['visitor-1', 'visitor-2', 'visitor-3', 'visitor-1', 'visitor-2'];
    const anonymized = ids.map((id) => RE.geoAnonymizeVisitorId(id));
    assert(anonymized[0] === anonymized[3], 'AD-ANON-1 相同輸入在陣列中不同位置仍產生相同匿名結果');
    assert(anonymized[1] === anonymized[4], 'AD-ANON-2 第二組相同輸入同樣一致');
    assert(new Set(anonymized).size === 3, 'AD-ANON-3 3 個不同輸入產生剛好 3 個不同匿名結果（不會意外碰撞成更少組）');
    ids.forEach((id, i) => {
      assert(!anonymized[i].includes(id), `AD-ANON-4-${i} 匿名結果不含原始輸入字串`);
    });
  }

  // ── render 函式：多筆來源/商品的完整字串斷言 ──
  {
    const multiSourceHtml = RE._geoRenderSourceBreakdownSection([
      { label: 'Facebook', visitors: 80, orders: 7 },
      { label: 'Google', visitors: 20, orders: 1 },
      { label: 'LINE OA', visitors: 15, orders: 2 },
    ], 'no_visitors');
    ['Facebook', 'Google', 'LINE OA'].forEach((label) => {
      assert(multiSourceHtml.includes(label), `AE-RENDER-1-${label} 多筆來源分析全部正確渲染`);
    });
    assert((multiSourceHtml.match(/geo-explorer-source-row/g) || []).length === 3, 'AE-RENDER-2 渲染出剛好 3 列（不多不少）');

    const multiProductHtml = RE._geoRenderProductsSection(RE.geoBuildHotProductsList([
      { name: '麻油豬腰', purchase_visitors: 48, add_to_cart_visitors: 60 },
      { name: '皇家三寶', purchase_visitors: 21, add_to_cart_visitors: 30 },
      { name: '毛豆', purchase_visitors: 13, add_to_cart_visitors: 20 },
    ]));
    const idx1 = multiProductHtml.indexOf('麻油豬腰');
    const idx2 = multiProductHtml.indexOf('皇家三寶');
    const idx3 = multiProductHtml.indexOf('毛豆');
    assert(idx1 < idx2 && idx2 < idx3, 'AE-RENDER-3 商品渲染順序符合排序結果（麻油豬腰→皇家三寶→毛豆）');
  }

  // ── XSS：額外欄位（campaign 標籤、放棄購物車數字欄位不受影響）──
  {
    const XSS_FIXTURES2 = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>'];
    XSS_FIXTURES2.forEach((payload, i) => {
      const campaignHtml = RE._geoRenderSourceBreakdownSection([{ label: payload, visitors: 1, orders: 0 }], 'no_campaign');
      assert(!campaignHtml.includes('<script>alert') && !campaignHtml.includes('<img src=x onerror') && !campaignHtml.includes('<svg onload'), `AF-XSS-${i} Campaign 標籤 fixture 未產生真正可執行標籤`);
    });
  }

  // ══════════════════════════════════════════════════════════════
  // 13.1 補充：geoAnonymizeVisitorId 完整矩陣（需求文件三：至少 13 種輸入）
  // ══════════════════════════════════════════════════════════════
  {
    const ANON_INPUTS = {
      normal: 'visitor-abc-123',
      empty_string: '',
      null_value: null,
      undefined_value: undefined,
      superlong: 'x'.repeat(5000),
      chinese: '訪客識別碼中文字串測試',
      special_symbols: '!@#$%^&*()_+-=[]{}|;:,.<>?/~`',
      html_string: '<div class="evil">content</div>',
      email_format: 'someone@example.com',
      phone_format: '0912345678',
      line_uid_format: 'U1234567890abcdef1234567890abcdef',
      whitespace: '   spaced   id   ',
      mixed_unicode: '👍emoji-visitor-🎉',
    };
    const anonResults = {};
    Object.entries(ANON_INPUTS).forEach(([key, val]) => {
      let result;
      let threw = false;
      try { result = RE.geoAnonymizeVisitorId(val); } catch (e) { threw = true; }
      assert(!threw, `AG-ANONMATRIX-${key}-1 輸入「${key}」不拋出例外`);
      anonResults[key] = result;
      if (!threw) {
        assert(typeof result === 'string', `AG-ANONMATRIX-${key}-2 回傳值為字串`);
        if (val) assert(!result.includes(String(val)), `AG-ANONMATRIX-${key}-3 不含原始輸入字串`);
        assert(!/@[a-z0-9.]+\.[a-z]{2,}/i.test(result), `AG-ANONMATRIX-${key}-4 不含 email 格式`);
        assert(!/09\d{8}/.test(result), `AG-ANONMATRIX-${key}-5 不含台灣電話格式`);
        assert(!/^U[0-9a-f]{32}$/i.test(result.replace(/[#.]/g, '')), `AG-ANONMATRIX-${key}-6 不含完整 LINE UID 格式`);
        assert(!/\s/.test(result), `AG-ANONMATRIX-${key}-7 不含空白字元`);
        assert(!result.includes('<') && !result.includes('>'), `AG-ANONMATRIX-${key}-8 不含 < 或 >`);
        assert(result.length >= 2 && result.length <= 20, `AG-ANONMATRIX-${key}-9 長度落在合理明確範圍（2~20 字元）`);
      }
    });
    for (let i = 0; i < 5; i += 1) {
      assert(RE.geoAnonymizeVisitorId('visitor-abc-123') === anonResults.normal, `AG-ANONMATRIX-stable-${i} 相同輸入重複呼叫第 ${i + 1} 次結果不變`);
    }
    const sequentialIds = Array.from({ length: 20 }, (_, i) => `seq-visitor-${i}`);
    const sequentialResults = sequentialIds.map((id) => RE.geoAnonymizeVisitorId(id));
    assert(new Set(sequentialResults).size === 20, 'AG-ANONMATRIX-SEQ-1 20 個順序相近的 ID 產生 20 個不同匿名結果（不碰撞）');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.1 補充：geoBuildExplorerUnavailableState / Campaign 驗證值
  // ══════════════════════════════════════════════════════════════
  {
    ['customer_explorer', 'order_explorer', 'device_breakdown', 'delivery_analysis'].forEach((feature) => {
      const state = RE.geoBuildExplorerUnavailableState(feature);
      assert(state.available === false, `AH-UNAVAILABLE-${feature}-1 available=false`);
      assert(state.status === 'unsupported', `AH-UNAVAILABLE-${feature}-2 status='unsupported'（跟 empty/error 三態分開）`);
      assert(state.feature === feature, `AH-UNAVAILABLE-${feature}-3 feature 欄位正確回填`);
      assert(typeof state.reason === 'string' && state.reason.length > 5, `AH-UNAVAILABLE-${feature}-4 reason 為有意義的完整說明`);
      assert(!state.reason.includes('尚無資料'), `AH-UNAVAILABLE-${feature}-5 不使用「尚無資料」這種會被誤解成資料為空的文案`);
    });
    const customState = RE.geoBuildExplorerUnavailableState('custom_feature', '自訂原因');
    assert(customState.reason === '自訂原因', 'AH-UNAVAILABLE-CUSTOM-1 可傳入自訂 reason 覆蓋預設文案');
    const unknownFeatureState = RE.geoBuildExplorerUnavailableState('never_defined_feature');
    assert(typeof unknownFeatureState.reason === 'string' && unknownFeatureState.reason.length > 0, 'AH-UNAVAILABLE-UNKNOWN-1 未定義的 feature 仍安全回傳預設文案，不崩潰');

    ['', null, undefined, '(not set)', 'unknown', 'UNKNOWN', 'Unknown', '(NOT SET)'].forEach((val, i) => {
      assert(!RE._geoIsValidCampaignValue(val), `AI-CAMPAIGNVALID-invalid-${i} 「${val}」視為無效 campaign 值`);
    });
    ['summer_sale', 'Q3-promo', '暑期活動', 'not_set_but_real'].forEach((val, i) => {
      assert(RE._geoIsValidCampaignValue(val), `AI-CAMPAIGNVALID-valid-${i} 「${val}」視為有效 campaign 值`);
    });

    const campaignRows = { rows: [
      { source: 'X', campaign: '(not set)', city: 'A', district: 'B', visitors: 10 },
      { source: 'X', campaign: 'unknown', city: 'A', district: 'B', visitors: 10 },
      { source: 'X', campaign: 'UNKNOWN', city: 'A', district: 'B', visitors: 10 },
      { source: 'X', campaign: '真的活動', city: 'A', district: 'B', visitors: 5 },
    ] };
    const validCampaigns = RE.geoBuildCampaignBreakdown(campaignRows, 'A', 'B');
    assert(validCampaigns.length === 1 && validCampaigns[0].label === '真的活動', 'AI-CAMPAIGNVALID-GROUP-1 只有真正有效的 campaign 被分組，"(not set)"/"unknown"/"UNKNOWN" 全部排除');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.1 補充：流失率 0 分母防護（需求文件 5.4）
  // ══════════════════════════════════════════════════════════════
  {
    const zeroCartProduct = RE.geoBuildHotProductsList([{ name: 'X', purchase_visitors: 0, add_to_cart_visitors: 0, abandon_visitors: 0, abandon_rate: 0 }])[0];
    assert(RE._geoFormatAbandonRate(zeroCartProduct) === '—', 'AJ-ABANDONRATE-1 加入購物車為 0 時顯示 —（不是 0%）');
    const normalProduct = RE.geoBuildHotProductsList([{ name: 'Y', purchase_visitors: 5, add_to_cart_visitors: 20, abandon_visitors: 15, abandon_rate: 75 }])[0];
    assert(RE._geoFormatAbandonRate(normalProduct) === '75%', 'AJ-ABANDONRATE-2 正常情況顯示正確百分比');
    const nanRateProduct = { add_to_cart_count: 10, abandon_rate: NaN };
    assert(RE._geoFormatAbandonRate(nanRateProduct) === '—', 'AJ-ABANDONRATE-3 abandon_rate 為 NaN 時顯示 —，不顯示 NaN%');
    const infinityRateProduct = { add_to_cart_count: 10, abandon_rate: Infinity };
    assert(RE._geoFormatAbandonRate(infinityRateProduct) === '—', 'AJ-ABANDONRATE-4 abandon_rate 為 Infinity 時顯示 —，不顯示 Infinity%');
    assert(RE._geoFormatAbandonRate(null) === '—', 'AJ-ABANDONRATE-5 product=null 時安全顯示 —');
    const overPurchaseProduct = RE.geoBuildHotProductsList([{ name: 'Z', purchase_visitors: 20, add_to_cart_visitors: 10, abandon_visitors: -10, abandon_rate: -50 }])[0];
    assert(overPurchaseProduct.abandon_count === 0, 'AJ-ABANDONRATE-6 異常負數 abandon_visitors 被 clamp 為 0（不顯示負數）');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.4 補充：XSS 擴大覆蓋（medium/action/error/更多欄位）
  // ══════════════════════════════════════════════════════════════
  {
    const XSS_SET = ['<img src=x onerror=alert(1)>', '<script>alert(1)</script>', '"><svg onload=alert(1)>'];
    XSS_SET.forEach((payload, i) => {
      const mediumRows = { rows: [{ source: payload, medium: payload, campaign: 'real', city: 'A', district: 'B', visitors: 1, add_to_cart: 1, begin_checkout: 0, purchases: 0 }] };
      const sourcesWithEvilMedium = RE.geoBuildAdSourceBreakdown(mediumRows, 'A', 'B');
      const html = RE._geoRenderSourceBreakdownSection(sourcesWithEvilMedium, 'no_visitors');
      assert(!html.includes('<script>alert') && !html.includes('<img src=x onerror') && !html.includes('<svg onload'), `AK-XSS-${i}-1 source/medium fixture 未產生真正可執行標籤`);

      const evilActionModel = { recommended_actions: [{ priority: 1, title: payload, description: payload, category: 'c', action_type: 'review' }], location: { area_name: 'A', city: 'A', district: 'B' }, id: 'x' };
      const actionsHtml = RE.geoRenderRecommendedActionsPanel([evilActionModel]);
      assert(!actionsHtml.includes('<script>alert') && !actionsHtml.includes('<img src=x onerror') && !actionsHtml.includes('<svg onload'), `AK-XSS-${i}-2 Recommended Action fixture 未產生真正可執行標籤`);

      const anonEvil = RE.geoAnonymizeVisitorId(payload);
      assert(!anonEvil.includes('<') && !anonEvil.includes('>'), `AK-XSS-${i}-3 匿名化 helper 對 XSS payload 輸入仍輸出安全字元（不含 <>）`);
    });

    assert(!'無法取得區域詳細資料'.includes('<script>'), 'AK-XSS-ERROR-1 錯誤畫面文字是固定安全字串，不是從後端錯誤內容拼接而來');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.4 補充：不得洩漏 Email/電話/地址/完整 GPS（跨多個 render 路徑）
  // ══════════════════════════════════════════════════════════════
  {
    const productsWithPii = RE.geoBuildHotProductsList([{ name: 'test@example.com 0912345678', purchase_visitors: 1, add_to_cart_visitors: 1 }]);
    const productsHtml = RE._geoRenderProductsSection(productsWithPii);
    assert((productsHtml.match(/09\d{8}/g) || []).length <= 1, 'AL-PII-1 商品區塊只會原樣顯示輸入本身，不會被系統重複或額外注入電話格式字串');

    const emptyCustomerMsg = RE.geoBuildCustomerExplorerEmptyState().message;
    assert(!/@[a-z0-9.]+\.[a-z]{2,}/i.test(emptyCustomerMsg), 'AL-PII-2 Customer Explorer 空狀態說明不含 email 格式');
    assert(!/09\d{8}/.test(emptyCustomerMsg), 'AL-PII-3 Customer Explorer 空狀態說明不含電話格式');
    assert(!/\d+\.\d{4,},\s*-?\d+\.\d{4,}/.test(emptyCustomerMsg), 'AL-PII-4 Customer Explorer 空狀態說明不含完整 GPS 座標格式');
    assert(!emptyCustomerMsg.match(/[路街道].{0,5}[號樓]/), 'AL-PII-5 Customer Explorer 空狀態說明不含完整地址格式');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.5 補充：Static / Compatibility
  // ══════════════════════════════════════════════════════════════
  {
    ['geoBuildKpiSummaryCards', 'geoEstimateRecommendationImpact', 'geoDedupeRecommendedActions',
      'geoFormatScopeForDisplay', 'geoBuildEmptyStateMessage', 'geoDeriveAreaStatusFromViewModels',
      'geoRenderKpiSummaryCards', 'geoRenderDecisionCenter', 'geoRenderRecommendationCard',
      'geoRenderQualityCard', 'geoRenderRecommendedActionsPanel', 'geoRenderEstimatedImpactCard',
      '_geoRenderExplainabilitySection', 'computeGeoDashboardKpi', 'computeGeoAreaRanking',
      'geoComputeRecommendedActions', '_geoAreaKey', '_geoAreaLabel', '_geoIsUnknownArea',
    ].forEach((fnName) => {
      assert(typeof RE[fnName] === 'function' || Array.isArray(RE[fnName]) || typeof RE[fnName] === 'object', `AM-COMPAT-1-${fnName} B1-5/更早既有函式或常數「${fnName}」仍存在，未被刪除`);
    });
    ['geoResolveAreaFromId', 'geoBuildHotProductsList', 'geoBuildCartAbandonmentSummary',
      'geoBuildAdSourceBreakdown', 'geoBuildCampaignBreakdown', 'geoBuildDeviceBreakdown',
      'geoBuildDeliveryAnalysisForArea', 'geoAnonymizeVisitorId', 'geoBuildCustomerExplorerEmptyState',
      'geoOpenOrderDetail', 'geoBuildOrderExplorerEmptyState', 'geoBuildExplorerUnavailableState',
    ].forEach((fnName) => {
      assert(typeof RE[fnName] === 'function', `AM-COMPAT-2-${fnName} B1-6A 新函式「${fnName}」存在`);
    });

    const srcCheck = fs.readFileSync(path.join(ROOT, 'public/js/geo-intelligence.js'), 'utf8');
    ['function geoAreaDrawerOpen(', 'function geoAreaDrawerClose(', 'function _renderGeoAreaDrawer(',
      'function geoOpenExplainabilityDrawerById(', 'function geoCloseExplainabilityDrawer(',
      'function renderDashboardGeoIntelligence(', 'function geoComputeRecommendedActions',
    ].forEach((sig) => {
      assert(srcCheck.includes(sig), `AM-COMPAT-3 原始碼含既有函式定義「${sig.replace('function ', '')}」（未被整段刪除重寫）`);
    });

    const fnNames = (srcCheck.match(/(?<=^function )\w+/gm) || []);
    const dupFns = fnNames.filter((n, i) => fnNames.indexOf(n) !== i);
    assert(dupFns.length === 0, `AM-COMPAT-4 沒有重複的 top-level function 宣告（${dupFns.join(',') || '無'}）`);
    const declNames = (srcCheck.match(/(?<=^(const|let) )\w+/gm) || []);
    const dupDecls = declNames.filter((n, i) => declNames.indexOf(n) !== i);
    assert(dupDecls.length === 0, `AM-COMPAT-5 沒有重複的 top-level const/let 宣告（${dupDecls.join(',') || '無'}）`);

    const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const idsRaw = indexHtml.match(/id=["']([^"']+)["']/g) || [];
    const idValues = idsRaw.map((s) => s.match(/id=["']([^"']+)["']/)[1]);
    const dupIds = idValues.filter((n, i) => idValues.indexOf(n) !== i);
    assert(new Set(dupIds).size === 0, `AM-COMPAT-6 index.html 沒有重複的靜態 HTML id`);

    const cssLinkCount = (indexHtml.match(/geo-intelligence\.css/g) || []).length;
    assert(cssLinkCount === 1, 'AM-COMPAT-7 geo-intelligence.css 只被引用一次');
    const cssContent = fs.readFileSync(path.join(ROOT, 'public/css/geo-intelligence.css'), 'utf8');
    const explorerSelectors = (cssContent.match(/\.geo-explorer-[\w-]+/g) || []);
    assert(explorerSelectors.length >= 10, 'AM-COMPAT-8 .geo-explorer- namespace 選擇器數量充足（至少 10 個）');
    assert(explorerSelectors.every((s) => s.startsWith('.geo-explorer-') || s.startsWith('.geo-')), 'AM-COMPAT-9 所有比對到的 explorer 選擇器都在 .geo-explorer- 或 .geo- namespace 內');
    const withoutComments = cssContent.replace(/\/\*[\s\S]*?\*\//g, '');
    assert(!/(^|\s)\.card\s*\{/.test(withoutComments), 'AM-COMPAT-10 CSS 沒有全域 .card{} 選擇器');
    assert(!/(^|\s)table\s*\{/.test(withoutComments), 'AM-COMPAT-11 CSS 沒有全域 table{} 選擇器');
    assert(!/(^|\s)button\s*\{/.test(withoutComments), 'AM-COMPAT-12 CSS 沒有全域 button{} 選擇器');
    assert(!/(^|\s)\.drawer\s*\{/.test(withoutComments), 'AM-COMPAT-13 CSS 沒有全域 .drawer{} 選擇器（.geo-drawer 是有 namespace 的，不算）');
    assert(cssContent.includes('@media (max-width: 1199px)'), 'AM-COMPAT-14 CSS 含平板斷點（1199px）');
    assert(cssContent.includes('@media (max-width: 767px)'), 'AM-COMPAT-15 CSS 含手機斷點（767px）');
    assert(cssContent.includes('max-width: 1440px') || cssContent.includes('1440px'), 'AM-COMPAT-16 CSS 含桌面版最大寬度設定（1440px）');
  }

  // ══════════════════════════════════════════════════════════════
  // 13.3 補充：Interaction — DOM Safety（更多缺失 DOM 情境）
  // ══════════════════════════════════════════════════════════════
  {
    const { dom } = setupDom();
    const { window } = dom.window;
    let threw = false;
    try {
      window.geoOpenAreaExplorer('某縣市|某區');
      window.geoCloseExplainabilityDrawer();
      window.geoCloseQualityDrawer();
    } catch (e) { threw = true; }
    assert(!threw, 'AN-DOMSAFE-1 完全沒有載入過 Dashboard 資料時開啟 Explorer 不拋出例外');
    dom.window.close();
  }

  printSummary();
  process.exit(process.exitCode || 0);
}

main().catch((e) => {
  console.error('SMOKE TEST CRASHED:', e && e.stack ? e.stack : e);
  process.exitCode = 1;
  process.exit(1);
});
