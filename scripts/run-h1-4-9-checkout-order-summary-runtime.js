#!/usr/bin/env node
// scripts/run-h1-4-9-checkout-order-summary-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.9-CHECKOUT-SYNC-ORDER-SUMMARY-QA
//
// 用真實 jsdom 載入真正的 public/line-order.html／public/line-shipping.html
// （原始 HTML + 內含的 production <script>，不重寫一份假的頁面），驗證 H1.4.9
// 兩大需求：
//   (1) 需求文件二「結帳頁本次訂單摘要」：商品／數量／小計／折扣／運費／應付
//       金額顯示，以及金額與購物車、兩顆 CTA（前往結帳／確認下單）永遠同步。
//   (2) explicit-button-only hardening：checkout_click 只能由真正的
//       #goCheckoutBtn click 觸發（event.type==='click' 且
//       event.currentTarget===goCheckoutBtn），直接呼叫 openCheckoutStep()
//       或傳入其他元素的 click event 都不得切換 stage、不得送出事件；
//       _enterCheckoutStage() 是純 UI transition，不含任何 _trackEvent()。
//
// 這支獨立於 H1.4.7 catalog-managed 的 run-g1-6-ga4-h1-4-7-two-stage-checkout-
// runtime.js（該檔案維持 pristine H1.4.8 基底的 113/113，不因本輪 H1.4.9 的
// explicit-button-only 斷言而被永久改寫成 138/138），explicit-button-only
// hardening 的 25 項斷言改為收錄在這裡，與原本 42 項訂單摘要斷言合計 67 項。
//
// 誠實聲明：這是本輪（H1.4.9）第一次執行，沒有歷史 PASS 紀錄。網路請求全部用
// 受控假資料 stub（沿用 H1.4.7 two-stage-checkout-runtime.js 相同的 stub 策略），
// 購物車/優惠券/外送費/取餐模式狀態透過頁面真正的全域變數（cart／appliedCoupon／
// currentMode／_deliveryFeeResult／deliveryFeeCalculated）以 window.eval() bridge
// 直接設定後，呼叫頁面真正的 updateBar()/refreshCartSheetTotals() 重新渲染，
// 不重寫或繞過任何 production 計價或事件邏輯。

'use strict';

process.on('unhandledRejection', (reason) => {
  console.warn(`[process unhandledRejection @ block ${global.__currentBlock || '?'}]`, reason && reason.stack || reason);
});

const path = require('path');
const fs = require('fs');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

class LocalPublicResourceLoader extends ResourceLoader {
  fetch(url, options) {
    try {
      const u = new URL(url);
      const filePath = path.join(PUBLIC_DIR, decodeURIComponent(u.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
        return Promise.resolve(fs.readFileSync(filePath));
      }
    } catch (e) { /* fall through */ }
    return Promise.resolve(Buffer.from(''));
  }
}

const HTML_PATH = path.join(ROOT, 'public/line-order.html');
const HTML_SRC = fs.readFileSync(HTML_PATH, 'utf8');
const HTML_PATH_SHIP = path.join(ROOT, 'public/line-shipping.html');
const HTML_SRC_SHIP = fs.readFileSync(HTML_PATH_SHIP, 'utf8');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

function mockFetchResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
}

// ── line-order.html ──────────────────────────────────────────
const SAMPLE_PRODUCTS = [
  { id: 1, name: '珍珠奶茶', effective_line_name: '珍珠奶茶', price: 60, effective_line_price: 60,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    takeout_available: true, delivery_available: true, line_spec: '大杯' },
  { id: 2, name: '紅茶', effective_line_name: '紅茶', price: 30, effective_line_price: 30,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    takeout_available: true, delivery_available: true, line_spec: '' },
  // XSS 測試商品：名稱含有需要 escape 的字元。
  { id: 3, name: '<img src=x onerror=alert(1)>"品項"', effective_line_name: '<img src=x onerror=alert(1)>"品項"',
    price: 50, effective_line_price: 50, show_on_line: true, sale_status: 'available', line_sold_out: 0,
    display_cat_id: 1, takeout_available: true, delivery_available: true, line_spec: '' },
];

function routeFetch(url) {
  if (url.includes('/api/line-shop')) {
    return mockFetchResponse({
      success: true,
      data: {
        store_id: 'store_001', shop_name: '測試店家', shop_address: '', shop_hours: '',
        shop_announcement: '', build_version: 'test',
        line_member_gate_mode: 'disabled', line_member_gate_enabled: false,
        coupon_feature_enabled: true,
        takeout_status: { selectable: true, enabled: true, allow_next_day: true },
        delivery_status: { selectable: true, enabled: true, allow_next_day: true },
        payment_methods: ['cash'],
      },
    });
  }
  if (url.includes('/api/line-menu')) {
    return mockFetchResponse({ success: true, data: { categories: [{ id: 1, name: '飲品' }], products: SAMPLE_PRODUCTS } });
  }
  if (url.includes('/api/settings/business-calendar')) return mockFetchResponse({ success: false, data: [] });
  if (url.includes('/api/delivery/calculate-fee')) return mockFetchResponse({ success: true, finalFee: 0, rawFee: 0, discount: 0 });
  if (url.includes('/api/coupons')) return mockFetchResponse({ success: false, message: 'not found' });
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint in runtime test' });
}

async function freshEnv() {
  const dom = new JSDOM(HTML_SRC, {
    url: 'https://runtime-test.local/line-order.html',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = function (url) { return routeFetch(String(url)); };
      window.scrollTo = function () {};
      window.addEventListener('error', (e) => { console.warn('[window error]', e.error && e.error.stack || e.message); });
      window.addEventListener('unhandledrejection', (e) => { console.warn('[window unhandledrejection]', e.reason && e.reason.stack || e.reason); e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState !== 'loading') { resolve(); return; }
    window.document.addEventListener('DOMContentLoaded', () => resolve());
  });
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 10)); }
  // H1.4.9：攔截 _trackEvent（頁面真實定義的追蹤入口），記錄呼叫但仍呼叫原函式，
  // 供 explicit-button-only hardening 斷言使用（沿用 H1.4.7 two-stage-checkout
  // runtime 相同的攔截方式，確保不影響原有副作用，例如 sessionStorage 去重寫入）。
  const trackedEvents = [];
  const original = window._trackEvent;
  window._trackEvent = function (name, payload) {
    trackedEvents.push({ name, payload });
    if (typeof original === 'function') { try { return original.apply(window, arguments); } catch (e) {} }
  };
  return { dom, window, document: window.document, trackedEvents };
}

function setCart(window, entries) {
  const products = window.eval('allProducts');
  const cart = {};
  for (const [pid, qty] of entries) {
    const p = products.find((x) => x.id === pid);
    cart[pid] = { product: p, qty };
  }
  window.__bridge = cart;
  window.eval('cart = window.__bridge;');
  window.updateBar();
  window.renderCartItems();
}

function setGlobal(window, name, value) { window.__bridge = value; window.eval(`${name} = window.__bridge;`); }

function fireClick(win, el) {
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

function summaryText(document) {
  const items = document.getElementById('checkoutOrderSummaryItems');
  const totals = document.getElementById('checkoutOrderSummaryTotals');
  return { itemsHTML: items ? items.innerHTML : '', itemsText: items ? items.textContent : '', totalsText: totals ? totals.textContent : '' };
}

function amt(el) { return el ? el.textContent.replace(/[^0-9]/g, '') : null; }

async function mainLineOrder() {
  // R1：只開購物車（未進結帳）不應顯示訂單摘要金額（摘要只存在於 #checkoutStage 內）
  {
    global.__currentBlock = 'R1';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 2]]);
    fireClick(window, document.getElementById('cartBar'));
    assert(document.getElementById('checkoutStage').hidden === true, 'R1 只開購物車時 checkoutStage 仍隱藏');
  }

  // R2：前往結帳後，摘要顯示商品名稱、規格、數量、應付金額，且與 #orderTotal／兩顆 CTA 一致
  {
    global.__currentBlock = 'R2';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 2], [2, 1]]); // 60*2 + 30*1 = 150
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'R2 成功進入結帳頁');
    const { itemsText, totalsText } = summaryText(document);
    assert(itemsText.includes('珍珠奶茶') && itemsText.includes('× 2'), 'R2 摘要顯示商品名稱與數量');
    assert(itemsText.includes('大杯'), 'R2 摘要顯示商品規格（line_spec）');
    assert(totalsText.includes('商品小計') && totalsText.includes('150'), 'R2 摘要顯示商品小計');
    assert(totalsText.includes('應付金額'), 'R2 摘要含應付金額標籤');
    const orderTotal = amt(document.getElementById('orderTotal'));
    const goBtn = document.getElementById('goCheckoutBtn').textContent;
    const subBtn = document.getElementById('subBtn').textContent;
    assert(orderTotal === '150', 'R2 #orderTotal=150');
    assert(goBtn.includes('150') && subBtn.includes('150'), 'R2 前往結帳／確認下單兩顆 CTA 皆顯示 150');
    assert(totalsText.includes('150'), 'R2 摘要應付金額與 CTA/#orderTotal 一致（150）');
  }

  // R3：外帶模式下數量變更（結帳頁內）即時同步摘要、#orderTotal、兩顆 CTA
  {
    global.__currentBlock = 'R3';
    const { window, document } = await freshEnv();
    setCart(window, [[2, 1]]); // 30
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    setCart(window, [[2, 3]]); // 90，模擬購物車數量變更後 updateBar() 會被呼叫
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('90'), 'R3 數量變更後摘要應付金額更新為 90');
    assert(amt(document.getElementById('orderTotal')) === '90', 'R3 #orderTotal 同步更新為 90');
    assert(document.getElementById('goCheckoutBtn').textContent.includes('90'), 'R3 前往結帳 CTA 同步更新為 90');
  }

  // R4：優惠券折抵反映在摘要
  {
    global.__currentBlock = 'R4';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]); // 60
    setGlobal(window, 'appliedCoupon', { code: 'TEST10', discount_amount: 10, final_total: 50 });
    window.updateBar();
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('優惠折扣') && totalsText.includes('-$10'), 'R4 摘要顯示優惠折扣 -$10');
    assert(totalsText.includes('50'), 'R4 摘要應付金額反映折扣後金額 50');
  }

  // R5：外送模式、外送費尚未計算（地址未填）時顯示提示文字，不得顯示為 $0
  {
    global.__currentBlock = 'R5';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]); // 60
    setGlobal(window, 'currentMode', 'delivery');
    setGlobal(window, 'deliveryFeeCalculated', false);
    setGlobal(window, '_deliveryFeeResult', null);
    window.updateBar();
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('外送費將於填寫地址後計算'), 'R5 外送費未知時顯示提示文字');
    assert(!/外送費<\/span><span>\$0/.test(document.getElementById('checkoutOrderSummaryTotals').innerHTML), 'R5 外送費未知時不得顯示為 $0');
  }

  // R6：外送模式、外送費已計算，應付金額含運費且與 CTA 一致
  {
    global.__currentBlock = 'R6';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]); // 60
    setGlobal(window, 'currentMode', 'delivery');
    setGlobal(window, 'deliveryFeeCalculated', true);
    setGlobal(window, '_deliveryFeeResult', { finalFee: 40, rawFee: 40, discount: 0 });
    window.updateBar();
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('外送費') && /外送費.*\$40/s.test(totalsText), 'R6 摘要顯示外送費 $40');
    assert(amt(document.getElementById('orderTotal')) === '100', 'R6 #orderTotal=100（60+40）');
    assert(totalsText.includes('100'), 'R6 摘要應付金額=100，與 #orderTotal 一致');
    assert(document.getElementById('subBtn').textContent.includes('100'), 'R6 確認下單 CTA 同步顯示 100');
  }

  // R7：商品名稱內含 XSS 字元時必須被安全 escape，不得產生可執行標籤或破壞屬性
  {
    global.__currentBlock = 'R7';
    const { window, document } = await freshEnv();
    setCart(window, [[3, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const html = document.getElementById('checkoutOrderSummaryItems').innerHTML;
    assert(!/<img[^>]*onerror/i.test(html), 'R7 商品名稱內的 <img onerror> 未被當成可執行標籤插入');
    assert(html.includes('&lt;img') || !html.includes('<img '), 'R7 商品名稱已被 escape（無原始 <img 標籤）');
  }

  // R8：重複 DOM id 檢查（訂單摘要新增的 id 不得與既有頁面重複）
  {
    global.__currentBlock = 'R8';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    for (const id of ['checkoutOrderSummary', 'checkoutOrderSummaryItems', 'checkoutOrderSummaryTotals']) {
      const matches = document.querySelectorAll(`#${id}`);
      assert(matches.length === 1, `R8 id="${id}" 在頁面內唯一（找到 ${matches.length} 個）`);
    }
  }

  // R9：清空購物車後摘要顯示「購物車是空的」，不殘留舊金額
  {
    global.__currentBlock = 'R9';
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    setCart(window, []);
    const { itemsText, totalsText } = summaryText(document);
    assert(itemsText.includes('購物車是空的'), 'R9 購物車清空後摘要顯示空狀態');
    assert(totalsText === '', 'R9 購物車清空後摘要不殘留舊的金額列');
  }

  // ── H1.4.9：explicit-button-only hardening（LINE 點餐）──────────
  // checkout_click 只能由真正的 #goCheckoutBtn click 觸發，直接呼叫
  // openCheckoutStep() 或傳入其他元素的 click event 都不得切換 stage、不得送事件。
  {
    global.__currentBlock = 'H149-order';
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));

    // B：無 event 直接呼叫 openCheckoutStep()
    window.openCheckoutStep();
    assert(document.getElementById('checkoutStage').hidden === true, 'H149-B 無 event 直接呼叫 openCheckoutStep() 不切換 stage');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'H149-B 無 event 直接呼叫不送 checkout_click');

    // C：傳入其他元素（非 #goCheckoutBtn）的 click event
    const otherEl = document.getElementById('backToCartBtn');
    const fakeEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(fakeEvent, 'currentTarget', { value: otherEl });
    window.openCheckoutStep(fakeEvent);
    assert(document.getElementById('checkoutStage').hidden === true, 'H149-C 其他元素的 click event 不切換 stage');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'H149-C 其他元素的 click event 不送 checkout_click');

    // D：真正 #goCheckoutBtn click
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'H149-D 真實按鈕 click 成功切換 stage');
    const ccEventsD = trackedEvents.filter((e) => e.name === 'checkout_click');
    assert(ccEventsD.length === 1, 'H149-D 真實按鈕 click checkout_click=1', ccEventsD.length);
    assert(trackedEvents.filter((e) => e.name === 'submit_order').length === 0, 'H149-D submit_order=0（尚未按確認下單）');

    // E：payload 含 checkout_trigger/checkout_stage，且無姓名/電話/地址等 PII
    const payloadD = ccEventsD[0].payload || {};
    assert(payloadD.checkout_trigger === 'go_checkout_button', 'H149-E payload.checkout_trigger=go_checkout_button', payloadD.checkout_trigger);
    assert(payloadD.checkout_stage === 'checkout', 'H149-E payload.checkout_stage=checkout', payloadD.checkout_stage);
    assert(!('name' in payloadD) && !('phone' in payloadD) && !('address' in payloadD) && !('line_id' in payloadD), 'H149-E payload 不含姓名/電話/地址/LINE ID 等個資');

    // F：render／金額刷新不額外送 checkout_click
    window.updateBar();
    window.updateBar();
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 1, 'H149-F render/updateBar() 不額外觸發 checkout_click');
  }

  // G：silent LIFF/gate restore（opts.step==='checkout'）不得送出 checkout_click／view_cart
  {
    global.__currentBlock = 'H149-order-restore';
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    window.openCartSheet({ step: 'checkout' });
    assert(document.getElementById('checkoutStage').hidden === false, 'H149-G silent restore 成功恢復到 checkoutStage');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'H149-G silent restore 不送 checkout_click');
    assert(trackedEvents.filter((e) => e.name === 'view_cart').length === 0, 'H149-G silent restore 不送 view_cart');
  }
}

// ── line-shipping.html ───────────────────────────────────────
const SAMPLE_PRODUCTS_SHIP = [
  { id: 1, name: '冷凍牛肉', price: 300, spec: '500g' },
  { id: 2, name: '冷凍雞胸', price: 150, spec: '300g' },
];

function routeFetchShipping(url) {
  if (url.includes('/api/line-shipping/shop')) {
    return mockFetchResponse({
      success: true,
      data: {
        store: { name: '測試宅配店', address: '', logo: '' },
        settings: {
          shipping_enabled: true, shipping_title: '冷藏宅配', shipping_description: '',
          shipping_fee: 200, shipping_free_threshold: 2000, shipping_min_order_amount: 0,
          shipping_upsell_enabled: false,
          line_member_gate_mode: 'disabled', line_member_gate_enabled: false,
        },
        coupon_feature_enabled: true,
        products: SAMPLE_PRODUCTS_SHIP,
        upsell_products: [],
        payment_methods: ['cash'],
        announcement: null,
        shipping_notice: '',
      },
    });
  }
  if (url.includes('/api/coupons/validate')) return mockFetchResponse({ success: false, message: 'not found' });
  if (url.includes('/api/analytics/events')) return mockFetchResponse({ success: true });
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint in shipping runtime test' });
}

async function freshEnvShipping() {
  const dom = new JSDOM(HTML_SRC_SHIP, {
    url: 'https://runtime-test.local/line-shipping.html?store_id=store_001',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = function (url) { return routeFetchShipping(String(url)); };
      window.scrollTo = function () {};
      window.confirm = function () { return true; };
      window.addEventListener('error', (e) => { console.warn('[ship window error]', e.error && e.error.stack || e.message); });
      window.addEventListener('unhandledrejection', (e) => { console.warn('[ship window unhandledrejection]', e.reason && e.reason.stack || e.reason); e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => {
    if (window.document.readyState !== 'loading') { resolve(); return; }
    window.document.addEventListener('DOMContentLoaded', () => resolve());
  });
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 10)); }
  // H1.4.9：同上，攔截 _trackEvent 供宅配頁的 explicit-button-only hardening 斷言使用。
  const trackedEvents = [];
  const original = window._trackEvent;
  window._trackEvent = function (name, payload) {
    trackedEvents.push({ name, payload });
    if (typeof original === 'function') { try { return original.apply(window, arguments); } catch (e) {} }
  };
  return { dom, window, document: window.document, trackedEvents };
}

function setCartShipping(window, entries) {
  const shopData = window.eval('SHOP_DATA');
  const products = [...(shopData.products || []), ...(shopData.upsell_products || [])];
  const cart = {};
  for (const [pid, qty] of entries) {
    const p = products.find((x) => x.id === pid);
    cart[pid] = { product: p, qty };
  }
  window.__bridge = cart;
  window.eval('cart = window.__bridge;');
  window.updateCartBar();
  window.renderCartItems();
  window.refreshCartSheetTotals();
}

async function mainShipping() {
  // S1：進入結帳頁後摘要顯示商品／規格／小計／運費／應付金額，且與 CTA 一致
  {
    global.__currentBlock = 'S1';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 2], [2, 1]]); // 300*2+150 = 750, 未達免運(2000) => +200 = 950
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'S1 成功進入結帳頁');
    const { itemsText, totalsText } = summaryText(document);
    assert(itemsText.includes('冷凍牛肉') && itemsText.includes('500g') && itemsText.includes('× 2'), 'S1 摘要顯示商品名稱/規格/數量');
    assert(totalsText.includes('商品小計') && totalsText.includes('750'), 'S1 摘要商品小計=750');
    assert(totalsText.includes('宅配運費') && totalsText.includes('200'), 'S1 摘要顯示運費=200');
    assert(amt(document.getElementById('orderTotal')) === '950', 'S1 #orderTotal=950');
    assert(totalsText.includes('950'), 'S1 摘要應付金額=950，與 #orderTotal 一致');
    assert(document.getElementById('submitBtn').textContent.includes('950'), 'S1 確認下單 CTA 同步顯示 950');
  }

  // S2：達免運門檻時摘要顯示運費 $0 並標註「已達免運」，不得誤植為尚未計算
  {
    global.__currentBlock = 'S2';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 7]]); // 300*7=2100 >= 2000 免運門檻
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('已達免運'), 'S2 摘要標註已達免運');
    assert(amt(document.getElementById('orderTotal')) === '2100', 'S2 #orderTotal=2100（運費0）');
  }

  // S3：數量變更即時同步摘要與 CTA
  {
    global.__currentBlock = 'S3';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[2, 1]]); // 150+200=350
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    setCartShipping(window, [[2, 4]]); // 600+200=800
    const { totalsText } = summaryText(document);
    assert(totalsText.includes('800'), 'S3 數量變更後摘要應付金額更新為 800');
    assert(amt(document.getElementById('orderTotal')) === '800', 'S3 #orderTotal 同步更新為 800');
    assert(document.getElementById('goCheckoutBtn').textContent.includes('800'), 'S3 前往結帳 CTA 同步更新為 800');
  }

  // S4：重複 DOM id 檢查
  {
    global.__currentBlock = 'S4';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    for (const id of ['checkoutOrderSummary', 'checkoutOrderSummaryItems', 'checkoutOrderSummaryTotals']) {
      const matches = document.querySelectorAll(`#${id}`);
      assert(matches.length === 1, `S4 id="${id}" 在頁面內唯一（找到 ${matches.length} 個）`);
    }
  }

  // ── H1.4.9：explicit-button-only hardening（宅配）──────────────
  {
    global.__currentBlock = 'H149-ship';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]); // 300 + 200 運費 = 500
    fireClick(window, document.getElementById('cartBar'));

    // B：無 event 直接呼叫 openCheckoutStep()
    window.openCheckoutStep();
    assert(document.getElementById('checkoutStage').hidden === true, 'H149-ship-B 無 event 直接呼叫不切換 stage');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'H149-ship-B 無 event 直接呼叫不送 checkout_click');

    // C：傳入其他元素的 click event
    const otherEl = document.getElementById('backToCartBtn');
    const fakeEvent = new window.MouseEvent('click', { bubbles: true, cancelable: true });
    Object.defineProperty(fakeEvent, 'currentTarget', { value: otherEl });
    window.openCheckoutStep(fakeEvent);
    assert(document.getElementById('checkoutStage').hidden === true, 'H149-ship-C 其他元素的 click event 不切換 stage');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'H149-ship-C 其他元素的 click event 不送 checkout_click');

    // D：真正 #goCheckoutBtn click
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'H149-ship-D 真實按鈕 click 成功切換 stage');
    const ccEventsD = trackedEvents.filter((e) => e.name === 'checkout_click');
    assert(ccEventsD.length === 1, 'H149-ship-D 真實按鈕 click checkout_click=1', ccEventsD.length);
    assert(trackedEvents.filter((e) => e.name === 'submit_order').length === 0, 'H149-ship-D submit_order=0');

    // E：payload 含 checkout_trigger/checkout_stage，且無收件人姓名/電話/地址等 PII
    const payloadD = ccEventsD[0].payload || {};
    assert(payloadD.checkout_trigger === 'go_checkout_button', 'H149-ship-E payload.checkout_trigger=go_checkout_button', payloadD.checkout_trigger);
    assert(payloadD.checkout_stage === 'checkout', 'H149-ship-E payload.checkout_stage=checkout', payloadD.checkout_stage);
    assert(!('name' in payloadD) && !('phone' in payloadD) && !('address' in payloadD) && !('address_note' in payloadD) && !('line_id' in payloadD), 'H149-ship-E payload 不含收件人姓名/電話/地址/地址備註/LINE ID 等個資');

    // F：render／金額刷新不額外送 checkout_click
    window.refreshCartSheetTotals();
    window.refreshCartSheetTotals();
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 1, 'H149-ship-F render/refreshCartSheetTotals() 不額外觸發 checkout_click');
  }
}

async function main() {
  await mainLineOrder();
  await mainShipping();
  const total = results.length;
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('== H1.4.9 Checkout Order Summary Runtime Results ==');
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail !== undefined ? ' :: ' + JSON.stringify(r.detail) : ''}`);
  }
  console.log(`TOTAL=${total} PASS=${total - failed.length} FAIL=${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('RUNTIME HARNESS ERROR:', e); process.exit(1); });
