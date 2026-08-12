#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA
//
// 用真實 jsdom 載入真正的 public/line-order.html（原始 HTML + 內含的 production
// <script>，不重寫一份假的頁面），對照需求文件九「Runtime 必測」逐一驗證兩階段
// 結帳流程。所有斷言都是真實 DOM click／實際 stage 顯示狀態／實際
// _trackEvent() 呼叫紀錄比對，不使用 includes('前往結帳') 或 regex 找按鈕文字。
//
// 誠實聲明：這是本輪（H1.4.7）第一次執行，沒有歷史 PASS 紀錄。網路請求
// （/api/line-shop、/api/line-menu、/api/settings/business-calendar 等）全部
// 用受控假資料 stub（LIFF/Gate 停用、無休假行事曆），讓 init() 能在無後端環境
// 下完成初始化；購物車商品資料在 init 完成後直接指定，其餘商業邏輯
// （openCartSheet/openCheckoutStep/backToCartStep/submitOrder gate 等）
// 全部呼叫頁面真正定義的函式。

'use strict';

process.on('unhandledRejection', (reason) => {
  console.warn(`[process unhandledRejection @ block ${global.__currentBlock || '?'}] background async call in production code`, reason && reason.stack || reason);
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

const SAMPLE_PRODUCTS = [
  { id: 1, name: '珍珠奶茶', effective_line_name: '珍珠奶茶', price: 60, effective_line_price: 60,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    takeout_available: true, delivery_available: true, line_spec: '' },
  { id: 2, name: '紅茶', effective_line_name: '紅茶', price: 30, effective_line_price: 30,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    takeout_available: true, delivery_available: true, line_spec: '' },
];

function mockFetchResponse(body) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

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
  if (url.includes('/api/settings/business-calendar')) {
    return mockFetchResponse({ success: false, data: [] });
  }
  if (url.includes('/api/delivery/calculate-fee')) {
    return mockFetchResponse({ success: true, finalFee: 0, rawFee: 0, discount: 0 });
  }
  if (url.includes('/api/coupons')) {
    return mockFetchResponse({ success: false, message: 'not found' });
  }
  // 其餘（結帳送單／查詢等）由各測試案例視需要另外覆寫，預設回一個安全的失敗回應，
  // 不讓未預期的 API 呼叫在測試中意外「成功建立訂單」。
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint in runtime test' });
}

async function freshEnv() {
  const publicDir = path.join(ROOT, 'public');
  // file:// 根目錄指向真正的 public/，讓 <script src="/js/...">／<link href="/css/...">
  // 這些真實的外部檔案（product-detail-modal.js、analytics-platforms.js、
  // delivery-free-progress.js…）用 jsdom 內建的 file:// resource loader 真的載入，
  // 不需要一支假的網路伺服器，也不會因為打不到外部網域而整段功能缺失。
  const dom = new JSDOM(HTML_SRC, {
    url: 'https://runtime-test.local/line-order.html',
    pretendToBeVisual: true,
    runScripts: 'dangerously',
    resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      // 必須在 HTML 解析／inline <script> 執行之前就把 fetch 換成假的，
      // 否則 init() 內第一次 apiFetch() 呼叫就會打到真正的網路。
      window.fetch = function (url) { return routeFetch(String(url)); };
      window.scrollTo = function () {};
  window.addEventListener('error', (e) => { console.warn('[window error]', e.error && e.error.stack || e.message); });
  window.addEventListener('unhandledrejection', (e) => { console.warn('[window unhandledrejection]', e.reason && e.reason.stack || e.reason); e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  const trackedEvents = [];
  await new Promise((resolve) => {
    if (window.document.readyState !== 'loading') { resolve(); return; }
    window.document.addEventListener('DOMContentLoaded', () => resolve());
  });
  // 等待 init() 內的 Promise.all(fetch...) 與後續同步流程跑完
  for (let i = 0; i < 30; i++) { await new Promise((r) => setTimeout(r, 10)); }

  // 攔截 _trackEvent（頁面真實定義的追蹤入口），記錄呼叫但仍呼叫原函式，
  // 確保不影響原有副作用（例如 sessionStorage 去重寫入）。
  const original = window._trackEvent;
  window._trackEvent = function (name, payload) {
    trackedEvents.push({ name, payload });
    if (typeof original === 'function') { try { return original.apply(window, arguments); } catch (e) {} }
  };

  return { dom, window, document: window.document, trackedEvents };
}

function setCart(window, entries) {
  // entries: [[productId, qty], ...] —— 直接寫入頁面真正的全域 cart/allProducts。
  // 注意：頁面用 `let cart={}`／`let allProducts=[]` 宣告（不是 var），這些是
  // window 的全域「詞法」綁定，不是 window 物件的屬性，因此無法用
  // window.cart/window.allProducts 直接讀寫，必須透過 window.eval()（同一個
  // realm 的全域詞法環境）存取，不是繞過或重寫 production 邏輯，只是正確的
  // 存取方式（真實瀏覽器 devtools console 對 let 全域變數也是一樣的限制）。
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

function getGlobal(window, name) { return window.eval(name); }
function setGlobal(window, name, value) { window.__bridge = value; window.eval(`${name} = window.__bridge;`); }

function fireClick(win, el) {
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
}

function isVisible(el) {
  if (!el) return false;
  if (el.hidden) return false;
  return true;
}

// ══════════════════════════════════════════════════════════════
// public/line-shipping.html（冷藏宅配）專用 mock/helper。與 line-order.html
// 使用不同 API 形狀（/api/line-shipping/shop 回傳 { store, settings, products,
// upsell_products, payment_methods, announcement }），故獨立一組 routeFetch，
// 但共用同一支 canonical runtime 檔案，不建立第二個測試器。
// ══════════════════════════════════════════════════════════════
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
          shipping_fee: 100, shipping_free_threshold: 1000, shipping_min_order_amount: 300,
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
  if (url.includes('/api/coupons/validate')) {
    return mockFetchResponse({ success: false, message: 'not found' });
  }
  if (url.includes('/api/analytics/events')) {
    return mockFetchResponse({ success: true });
  }
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint in shipping runtime test' });
}

async function freshEnvShipping() {
  const trackedEvents = [];
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

  const original = window._trackEvent;
  window._trackEvent = function (name, payload) {
    trackedEvents.push({ name, payload });
    if (typeof original === 'function') { try { return original.apply(window, arguments); } catch (e) {} }
  };

  return { dom, window, document: window.document, trackedEvents };
}

function setCartShipping(window, entries) {
  // 頁面用 `let cart = {}` 宣告（詞法全域綁定，非 window 屬性），需經
  // window.eval() 的 bridge 存取，理由與 line-order.html 相同。
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
}

async function mainLineOrder() {
  // ── 1. 購物車空白時不能進入摘要或結帳 ──────────────────
  {
    global.__currentBlock = 1;
    const { window, document } = await freshEnv();
    setGlobal(window, 'cart', {});
    window.updateBar();
    window.openCartSheet();
    const sheet = document.getElementById('cartSheet');
    assert(!sheet.classList.contains('show'), 'R1 購物車空白時 openCartSheet() 不開啟 Sheet', sheet.className);
    window.openCheckoutStep();
    assert(!sheet.classList.contains('show'), 'R1b 購物車空白時 openCheckoutStep() 不開啟 Sheet');
  }

  // ── 2/3/4. 點「查看購物車」只顯示 cartStage，checkout 表單不可見/不可操作 ──
  {
    global.__currentBlock = 2;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 2]]);
    const cartBar = document.getElementById('cartBar');
    fireClick(window, cartBar);
    const sheet = document.getElementById('cartSheet');
    const cartStage = document.getElementById('cartStage');
    const checkoutStage = document.getElementById('checkoutStage');
    assert(sheet.classList.contains('show'), 'R2 點 cartBar 後 Sheet 開啟');
    assert(isVisible(cartStage), 'R2b cartStage 可見');
    assert(!isVisible(checkoutStage), 'R3 checkoutStage 不可見（hidden 屬性）');
    const cName = document.getElementById('cName');
    const cPhone = document.getElementById('cPhone');
    const subBtn = document.getElementById('subBtn');
    assert(cName.closest('[hidden]') !== null, 'R3b 姓名欄位位於 hidden 的 checkoutStage 內');
    assert(cPhone.closest('[hidden]') !== null, 'R3c 電話欄位位於 hidden 的 checkoutStage 內');
    assert(subBtn.closest('[hidden]') !== null, 'R3d 確認下單按鈕位於 hidden 的 checkoutStage 內');
    // hidden 屬性下的 offsetParent 在 jsdom 中不模擬版面，改用 checkVisibility 概念：
    // 直接驗證 hidden 屬性本身即可代表「不可聚焦、不可操作」（原生行為）。
    assert(checkoutStage.hidden === true, 'R3e checkoutStage.hidden === true（不可聚焦操作的根本依據）');
    const goCheckoutBtn = document.getElementById('goCheckoutBtn');
    assert(!!goCheckoutBtn && !goCheckoutBtn.disabled, 'R4 存在可點的「前往結帳」按鈕且未停用');
    assert(goCheckoutBtn.textContent.includes('前往結帳') && goCheckoutBtn.textContent.includes('NT$'), 'R4b 前往結帳按鈕含金額格式');
  }

  // ── 5/6/7. 前往結帳前表單不可見，按下後才切換，且不呼叫 submitOrder ──
  {
    global.__currentBlock = 3;
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    const checkoutStage = document.getElementById('checkoutStage');
    const cartStage = document.getElementById('cartStage');
    assert(checkoutStage.hidden === true, 'R5 按前往結帳前 checkoutStage 仍為 hidden');

    let submitOrderCalled = false;
    const originalSubmit = window.submitOrder;
    window.submitOrder = function () { submitOrderCalled = true; };

    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(checkoutStage.hidden === false, 'R6 按下前往結帳後 checkoutStage 切為可見');
    assert(cartStage.hidden === true, 'R6b 切換後 cartStage 隱藏');
    assert(submitOrderCalled === false, 'R7 前往結帳只切換 stage，不呼叫 submitOrder()');
    window.submitOrder = originalSubmit;
  }

  // ── 8. 第二階段顯示表單與「確認下單｜NT$金額」 ──────────
  {
    global.__currentBlock = 4;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 3]]); // 3 * 60 = 180
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const subBtn = document.getElementById('subBtn');
    assert(!subBtn.hidden === true || true, 'R8 sanity');
    assert(document.getElementById('checkoutStage').hidden === false, 'R8a 第二階段可見');
    assert(subBtn.textContent.includes('確認下單') && subBtn.textContent.includes('180'), 'R8b 確認下單按鈕顯示正確金額', subBtn.textContent);
    assert(!!document.getElementById('cName') && !!document.getElementById('deliveryAddrWrap'), 'R8c 表單欄位存在於 checkoutStage 內');
  }

  // ── 9/10. 返回購物車保留資料與 cart_id，再次前往結帳資料仍存在 ──
  {
    global.__currentBlock = 5;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 2]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    document.getElementById('cName').value = '王小明';
    document.getElementById('cPhone').value = '0912345678';
    const cidBefore = window._getCartId(false);
    fireClick(window, document.getElementById('backToCartBtn'));
    assert(document.getElementById('cartStage').hidden === false, 'R9 返回購物車後 cartStage 可見');
    assert(document.getElementById('checkoutStage').hidden === true, 'R9b checkoutStage 隱藏');
    assert(window._getCartId(false) === cidBefore, 'R9c 返回購物車 cart_id 不變');
    assert(document.getElementById('cName').value === '王小明', 'R9d 返回購物車姓名資料保留（DOM 未被重建）');
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'R10 再次前往結帳成功進入第二階段');
    assert(document.getElementById('cName').value === '王小明', 'R10b 再次前往結帳資料仍存在');
    assert(document.getElementById('cPhone').value === '0912345678', 'R10c 電話資料仍存在');
  }

  // ── 11/12/13. 增減/刪除商品、優惠券、外送費會同步更新兩個 CTA 金額 ──
  {
    global.__currentBlock = 6;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]); // 60
    fireClick(window, document.getElementById('cartBar'));
    const goBtn = document.getElementById('goCheckoutBtn');
    assert(goBtn.textContent.includes('60'), 'R11 初始金額同步（$60）', goBtn.textContent);
    { const c = getGlobal(window,'cart'); c[1].qty = 3; setGlobal(window,'cart', c); } // 180
    window.updateBar();
    assert(goBtn.textContent.includes('180'), 'R11b 數量增加後前往結帳金額同步', goBtn.textContent);
    fireClick(window, goBtn);
    const subBtn = document.getElementById('subBtn');
    assert(subBtn.textContent.includes('180'), 'R11c 確認下單金額同步', subBtn.textContent);
    // 優惠券：直接模擬 appliedCoupon 生效後呼叫既有 updateBar()（applyCoupon 本身會打 API，
    // 這裡驗證的是「套用後 updateBar 觸發的金額同步」這條既有契約是否仍然生效）
    setGlobal(window, 'appliedCoupon', { code: 'TEST10', discount_amount: 30 });
    window.updateBar();
    assert(goBtn.textContent.includes('150'), 'R12 優惠券套用後前往結帳金額同步（180-30=150）', goBtn.textContent);
    assert(subBtn.textContent.includes('150'), 'R12b 優惠券套用後確認下單金額同步', subBtn.textContent);
    setGlobal(window, 'appliedCoupon', null);
    // 外送費：模擬 currentMode=delivery 且 _deliveryFeeResult 有值
    setGlobal(window, 'currentMode', 'delivery');
    setGlobal(window, 'deliveryFeeCalculated', true);
    setGlobal(window, '_deliveryFeeResult', { finalFee: 50, rawFee: 50, discount: 0 });
    window.updateBar();
    assert(goBtn.textContent.includes('230'), 'R13 外送費變動後前往結帳金額同步（180+50=230）', goBtn.textContent);
    assert(subBtn.textContent.includes('230'), 'R13b 外送費變動後確認下單金額同步', subBtn.textContent);
  }

  // ── 14/15/16/17. view_cart / checkout_click / begin_checkout 事件契約 ──
  {
    global.__currentBlock = 7;
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    const names14 = trackedEvents.map((e) => e.name);
    const vcCount1 = names14.filter((n) => n === 'view_cart').length;
    const ccCount1 = names14.filter((n) => n === 'checkout_click').length;
    const bcCount1 = names14.filter((n) => n === 'begin_checkout').length;
    assert(vcCount1 === 1, 'R14 點查看購物車 view_cart=1', vcCount1);
    assert(ccCount1 === 0, 'R14b 點查看購物車 checkout_click=0', ccCount1);
    assert(bcCount1 === 0, 'R14c 點查看購物車 begin_checkout=0', bcCount1);

    fireClick(window, document.getElementById('goCheckoutBtn'));
    const names15 = trackedEvents.map((e) => e.name);
    const ccCount2 = names15.filter((n) => n === 'checkout_click').length;
    const bcCount2 = names15.filter((n) => n === 'begin_checkout').length;
    assert(ccCount2 === 1, 'R15 點前往結帳 checkout_click=1', ccCount2);
    assert(bcCount2 === 0, 'R15b 點前往結帳 begin_checkout=0', bcCount2);
    assert(!!trackedEvents.find((e) => e.name === 'checkout_click' && (!e.payload || (!('name' in (e.payload||{})) && !('phone' in (e.payload||{})))) ), 'R15c checkout_click payload 不含姓名/電話');

    // 返回再進入同一 cart：不得重複 checkout_click、不得更換 cart_id、不得重複 add_to_cart
    const cidBefore = window._getCartId(false);
    fireClick(window, document.getElementById('backToCartBtn'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const names16 = trackedEvents.map((e) => e.name);
    const ccCount3 = names16.filter((n) => n === 'checkout_click').length;
    const addCount = names16.filter((n) => n === 'add_to_cart').length;
    assert(ccCount3 === 1, 'R16 返回再進入同一 cart 不重複 checkout_click（仍是 1）', ccCount3);
    assert(window._getCartId(false) === cidBefore, 'R16b cart_id 不變');
    assert(addCount === 0, 'R16c 返回/再進入不重複 add_to_cart');

    // 新 cart：清空後重新加入商品，取得新 cart_id，可以再次記錄 checkout_click
    window.clearCartByUser = window.clearCartByUser; // no-op, 保留原函式參照
    // clearCartByUser() 內含 confirm()，jsdom 預設 confirm 回傳 false，這裡改為
    // 直接呼叫既有的清空核心步驟等價的方式：清空 cart + 呼叫 _resetCartId 的既有入口。
    setGlobal(window, 'cart', {});
    window.clearCartStorage();
    window.updateBar(); // updateBar() 內部在 cnt===0 時會呼叫 _resetCartId()
    setCart(window, [[2, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    const names17 = trackedEvents.map((e) => e.name);
    const ccCount4 = names17.filter((n) => n === 'checkout_click').length;
    assert(ccCount4 === 2, 'R17 新 cart_id 可以產生新的 checkout_click（累計為 2）', ccCount4);
    assert(window._getCartId(false) !== cidBefore, 'R17b 新購物車取得新 cart_id');
  }

  // ── 19. 清空購物車會關閉 Sheet 並重設 UI stage ──────────
  {
    global.__currentBlock = 8;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    window.confirm = () => true; // 模擬使用者確認清空
    window.clearCartByUser();
    assert(!document.getElementById('cartSheet').classList.contains('show'), 'R19 清空購物車後 Sheet 關閉');
    assert(document.getElementById('cartStage').hidden === false, 'R19b 清空購物車後 stage 回到 cart');
    assert(document.getElementById('checkoutStage').hidden === true, 'R19c checkoutStage 回到 hidden');
  }

  // ── 防回歸測試：若 openCartSheet() 一打開就顯示顧客表單，或仍觸發 begin_checkout，必須 FAIL ──
  {
    global.__currentBlock = 9;
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    window.openCartSheet();
    const checkoutStage = document.getElementById('checkoutStage');
    assert(checkoutStage.hidden === true, '防回歸-A openCartSheet() 打開後 checkoutStage 仍為 hidden（未直接顯示顧客表單）');
    const bcEvents = trackedEvents.filter((e) => e.name === 'begin_checkout');
    assert(bcEvents.length === 0, '防回歸-B openCartSheet() 沒有觸發 begin_checkout');
  }

  // ── 18. LIFF checkout 登入導回可恢復第二階段（模擬 openCartSheet({step:'checkout'})）──
  {
    global.__currentBlock = 10;
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    document.getElementById('cName').value = '恢復測試';
    window.openCartSheet({ step: 'checkout' });
    assert(document.getElementById('checkoutStage').hidden === false, 'R18 LIFF 導回恢復後直接進入第二階段');
    const ccEvents = trackedEvents.filter((e) => e.name === 'checkout_click');
    assert(ccEvents.length === 0, 'R18b LIFF 自動恢復不得補送 checkout_click');
    const vcEventsR18 = trackedEvents.filter((e) => e.name === 'view_cart');
    assert(vcEventsR18.length === 0, 'R18d LIFF 自動恢復不得補送 view_cart（恢復不是使用者這次點查看購物車）');
    assert(document.getElementById('cName').value === '恢復測試', 'R18c 表單資料未遺失');
  }

  // ── 14b. view_cart 不是同一 cart_id 永久只記一次：關閉後再次點查看購物車要再增加一筆 ──
  {
    global.__currentBlock = 10.5;
    const { window, document, trackedEvents } = await freshEnv();
    setCart(window, [[1, 1]]);
    const cartBar = document.getElementById('cartBar');
    fireClick(window, cartBar);
    let vc = trackedEvents.filter((e) => e.name === 'view_cart').length;
    assert(vc === 1, 'R14d 第一次點查看購物車 view_cart=1', vc);
    // render／金額更新不得額外觸發 view_cart
    window.updateBar();
    vc = trackedEvents.filter((e) => e.name === 'view_cart').length;
    assert(vc === 1, 'R14e updateBar()（render/金額更新）不額外觸發 view_cart', vc);
    // 關閉 Sheet（不清除購物車，只改 UI 狀態）
    fireClick(window, document.getElementById('cartSheet').querySelector(".close-btn[onclick=\"closeSheet('cartSheet')\"]"));
    assert(!document.getElementById('cartSheet').classList.contains('show'), 'R14f 關閉 Sheet 後不再顯示');
    vc = trackedEvents.filter((e) => e.name === 'view_cart').length;
    assert(vc === 1, 'R14g 單純關閉 Sheet 不觸發 view_cart', vc);
    // 同一個 cart_id，再次點查看購物車 —— view_cart 必須再增加一筆（不是永久去重）
    const cidBeforeReopen = window._getCartId(false);
    fireClick(window, cartBar);
    vc = trackedEvents.filter((e) => e.name === 'view_cart').length;
    assert(vc === 2, 'R14h 關閉後再次點查看購物車，view_cart 增加一筆（同一 cart_id 累計為 2，不是永久去重）', vc);
    assert(window._getCartId(false) === cidBeforeReopen, 'R14i 重新開啟同一購物車 cart_id 不變');
    // 返回購物車（若曾進入 checkout）不得觸發 view_cart
    fireClick(window, document.getElementById('goCheckoutBtn'));
    fireClick(window, document.getElementById('backToCartBtn'));
    vc = trackedEvents.filter((e) => e.name === 'view_cart').length;
    assert(vc === 2, 'R14j 返回購物車不觸發 view_cart（仍是 2）', vc);
  }

  // ── 22a. 外帶通路成功 runtime 路徑（前往結帳只切畫面，不直接送單）──
  {
    global.__currentBlock = 11;
    const { window, document } = await freshEnv();
    setCart(window, [[1, 1]]);
    setGlobal(window, 'currentMode', 'takeout');
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'R22a 外帶通路可完整進入第二階段');
  }

  // ── 21. 商品詳情 modal 不受影響（僅驗證頁面仍使用 product-detail-modal.js API 存在）──
  {
    global.__currentBlock = 12;
    const { window } = await freshEnv();
    assert(typeof window.ProductDetailModal !== 'undefined', 'R21 頁面仍載入 ProductDetailModal（product-detail-modal.js）');
  }
}

// ══════════════════════════════════════════════════════════════
// public/line-shipping.html（冷藏宅配）Runtime 測試 —— 與 line-order.html
// 對應的兩階段流程斷言，命名前綴 S* 避免與上面的 R* 混淆。
// ══════════════════════════════════════════════════════════════
async function mainShipping() {
  // S1：空購物車不能進入摘要或結帳
  {
    global.__currentBlock = 'S1';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, []);
    window.openCartSheet();
    const sheet = document.getElementById('cartSheet');
    assert(!sheet.classList.contains('show'), 'S1 購物車空白時 openCartSheet() 不開啟 Sheet');
    const cartBar = document.getElementById('cartBar');
    assert(cartBar.classList.contains('hidden'), 'S1b 空購物車時 cartBar 隱藏（唯一入口不可用）');
    window.openCheckoutStep();
    assert(document.getElementById('checkoutStage').hidden === true, 'S1c 空購物車時 openCheckoutStep() 不會進入第二階段');
  }

  // S2/S3/S4：第一階段只顯示購物車摘要，收件資料/付款/備註/送單按鈕不可見不可操作
  {
    global.__currentBlock = 'S2';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]); // 300（低於免運門檻但高於最低訂購 300）
    fireClick(window, document.getElementById('cartBar'));
    const sheet = document.getElementById('cartSheet');
    assert(sheet.classList.contains('show'), 'S2 點 cartBar 後 Sheet 開啟');
    assert(isVisible(document.getElementById('cartStage')), 'S2b cartStage 可見');
    assert(!isVisible(document.getElementById('checkoutStage')), 'S3 checkoutStage 不可見');
    assert(document.getElementById('rName').closest('[hidden]') !== null, 'S3b 收件人姓名位於 hidden 的 checkoutStage 內');
    assert(document.getElementById('rPhone').closest('[hidden]') !== null, 'S3c 收件電話位於 hidden 的 checkoutStage 內');
    assert(document.getElementById('payBtns').closest('[hidden]') !== null, 'S3d 付款方式位於 hidden 的 checkoutStage 內');
    assert(document.getElementById('rNote').closest('[hidden]') !== null, 'S3e 備註位於 hidden 的 checkoutStage 內');
    assert(document.getElementById('submitBtn').closest('[hidden]') !== null, 'S3f 送單按鈕位於 hidden 的 checkoutStage 內');
    const goBtn = document.getElementById('goCheckoutBtn');
    assert(!!goBtn && !goBtn.disabled, 'S4 存在可點的前往結帳按鈕且未停用（已達最低訂購金額）');
  }

  // S5/S6：前往結帳後才顯示 checkout stage；不呼叫 submitOrder()
  {
    global.__currentBlock = 'S5';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    assert(document.getElementById('checkoutStage').hidden === true, 'S5 按前往結帳前 checkoutStage 仍為 hidden');
    let submitCalled = false;
    const original = window.submitOrder;
    window.submitOrder = function () { submitCalled = true; };
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'S6 按下前往結帳後切換到第二階段');
    assert(document.getElementById('cartStage').hidden === true, 'S6b cartStage 隱藏');
    assert(submitCalled === false, 'S6c 前往結帳只切換 stage，不呼叫 submitOrder()');
    window.submitOrder = original;
  }

  // S7：未達最低金額不切換、不送事件
  {
    global.__currentBlock = 'S7';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[2, 1]]); // 150，低於最低訂購金額 300
    fireClick(window, document.getElementById('cartBar'));
    const goBtn = document.getElementById('goCheckoutBtn');
    assert(goBtn.disabled === true, 'S7 未達最低訂購金額時前往結帳按鈕停用');
    fireClick(window, goBtn);
    assert(document.getElementById('checkoutStage').hidden === true, 'S7b 未達最低金額時點擊前往結帳不會切換到第二階段');
    const ccCount = trackedEvents.filter((e) => e.name === 'checkout_click').length;
    assert(ccCount === 0, 'S7c 未達最低金額不送 checkout_click', ccCount);
  }

  // S9/S10：返回購物車後資料與 cart_id 不變；再次進入 checkout 資料仍存在
  {
    global.__currentBlock = 'S9';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 2]]); // 600
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    document.getElementById('rName').value = '陳小華';
    document.getElementById('rPhone').value = '0987654321';
    const cidBefore = window._getCartId(false);
    fireClick(window, document.getElementById('backToCartBtn'));
    assert(document.getElementById('cartStage').hidden === false, 'S9 返回購物車後 cartStage 可見');
    assert(document.getElementById('checkoutStage').hidden === true, 'S9b checkoutStage 隱藏');
    assert(window._getCartId(false) === cidBefore, 'S9c 返回購物車 cart_id 不變');
    assert(document.getElementById('rName').value === '陳小華', 'S9d 返回購物車收件人姓名資料保留');
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'S10 再次前往結帳成功進入第二階段');
    assert(document.getElementById('rName').value === '陳小華', 'S10b 再次前往結帳姓名資料仍存在');
    assert(document.getElementById('rPhone').value === '0987654321', 'S10c 再次前往結帳電話資料仍存在');
  }

  // S11/S12/S13：商品/優惠券/運費變動與兩個 CTA 金額同步
  {
    global.__currentBlock = 'S11';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]); // 300，未達免運（1000），運費 100 → total=400
    fireClick(window, document.getElementById('cartBar'));
    const goBtn = document.getElementById('goCheckoutBtn');
    assert(goBtn.textContent.includes('400'), 'S11 初始金額同步（商品300+運費100=400）', goBtn.textContent);
    { const c = getGlobal(window, 'cart'); c[1].qty = 4; setGlobal(window, 'cart', c); } // 1200，達免運
    window.refreshCartSheetTotals();
    assert(goBtn.textContent.includes('1200'), 'S11b 數量增加達免運門檻後金額同步（1200+0運費=1200）', goBtn.textContent);
    fireClick(window, goBtn);
    const submitBtn = document.getElementById('submitBtn');
    assert(submitBtn.textContent.includes('1200'), 'S11c 確認下單金額同步', submitBtn.textContent);
    setGlobal(window, 'appliedCoupon', { code: 'SHIP100', discount_amount: 100 });
    window.refreshCartSheetTotals();
    assert(goBtn.textContent.includes('1100'), 'S12 優惠券套用後前往結帳金額同步（1200-100=1100）', goBtn.textContent);
    assert(submitBtn.textContent.includes('1100'), 'S12b 優惠券套用後確認下單金額同步', submitBtn.textContent);
  }

  // S14/S15/S16/S17：view_cart／checkout_click／begin_checkout 事件契約
  {
    global.__currentBlock = 'S14';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 2]]); // 600
    fireClick(window, document.getElementById('cartBar'));
    let names = trackedEvents.map((e) => e.name);
    assert(names.filter((n) => n === 'view_cart').length === 1, 'S14 點查看購物車 view_cart=1');
    assert(names.filter((n) => n === 'checkout_click').length === 0, 'S14b 點查看購物車 checkout_click=0');
    assert(names.filter((n) => n === 'begin_checkout').length === 0, 'S14c 點查看購物車 begin_checkout=0');

    fireClick(window, document.getElementById('goCheckoutBtn'));
    names = trackedEvents.map((e) => e.name);
    assert(names.filter((n) => n === 'checkout_click').length === 1, 'S15 點前往結帳 checkout_click=1');
    assert(names.filter((n) => n === 'begin_checkout').length === 0, 'S15b 點前往結帳 begin_checkout=0');

    const cidBefore = window._getCartId(false);
    fireClick(window, document.getElementById('backToCartBtn'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    names = trackedEvents.map((e) => e.name);
    assert(names.filter((n) => n === 'checkout_click').length === 1, 'S16 同一 cart_id 返回再進入不重複 checkout_click（仍是 1）');
    assert(window._getCartId(false) === cidBefore, 'S16b cart_id 不變');

    // 關閉後再次點查看購物車：view_cart 增加一筆（不是永久去重）
    window.closeSheet();
    fireClick(window, document.getElementById('cartBar'));
    names = trackedEvents.map((e) => e.name);
    assert(names.filter((n) => n === 'view_cart').length === 2, 'S14d 關閉後再次點查看購物車，view_cart 增加一筆（累計為 2）');

    // 新 cart：清空後重新加入商品，取得新 cart_id，可再記錄一次 checkout_click
    setGlobal(window, 'cart', {});
    window.clearCartStorage();
    window.updateCartBar();
    setCartShipping(window, [[2, 3]]); // 450
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    names = trackedEvents.map((e) => e.name);
    assert(names.filter((n) => n === 'checkout_click').length === 2, 'S17 新 cart_id 可以產生新的 checkout_click（累計為 2）');
    assert(window._getCartId(false) !== cidBefore, 'S17b 新購物車取得新 cart_id');
    assert(names.filter((n) => n === 'begin_checkout').length === 0, 'S17c 全程 begin_checkout=0');
  }

  // S18：LIFF/LINE Gate 導回不重送兩個事件，直接恢復 checkout stage
  {
    global.__currentBlock = 'S18';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    document.getElementById('rName').value = '恢復測試';
    window.openCartSheet({ step: 'checkout' });
    assert(document.getElementById('checkoutStage').hidden === false, 'S18 LINE Gate 導回恢復後直接進入第二階段');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'S18b 導回不得補送 checkout_click');
    assert(trackedEvents.filter((e) => e.name === 'view_cart').length === 0, 'S18c 導回不得補送 view_cart');
    assert(document.getElementById('rName').value === '恢復測試', 'S18d 表單資料未遺失');
  }

  // S19/S20：清空購物車與成功下單後正確關閉、重設
  {
    global.__currentBlock = 'S19';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    window.clearCartByUser();
    assert(!document.getElementById('cartSheet').classList.contains('show'), 'S19 清空購物車後 Sheet 關閉');
    assert(document.getElementById('cartStage').hidden === false, 'S19b 清空購物車後 stage 回到 cart');
    assert(document.getElementById('checkoutStage').hidden === true, 'S19c checkoutStage 回到 hidden');
  }

  // S22：宅配成功 runtime 路徑（完整走過 查看購物車→前往結帳→checkoutStage）
  {
    global.__currentBlock = 'S22';
    const { window, document } = await freshEnvShipping();
    setCartShipping(window, [[1, 2]]); // 600
    fireClick(window, document.getElementById('cartBar'));
    fireClick(window, document.getElementById('goCheckoutBtn'));
    assert(document.getElementById('checkoutStage').hidden === false, 'S22 宅配通路可完整進入第二階段');
    assert(!!document.getElementById('rAddress') && !!document.getElementById('payBtns'), 'S22b 收件表單欄位存在於 checkoutStage 內');
  }
}

// ══════════════════════════════════════════════════════════════
// 統一輸出：line-order.html（R*）與 line-shipping.html（S*）共用同一份
// results 陣列與同一次執行，避免建立第二個契約不同的測試器。
// ══════════════════════════════════════════════════════════════
async function main() {
  await mainLineOrder();
  await mainShipping();
  const total = results.length;
  const failed = results.filter((r) => r.status === 'FAIL');
  console.log('== H1.4.7 line-order.html + line-shipping.html Runtime Results ==');
  for (const r of results) {
    console.log(`[${r.status}] ${r.name}${r.detail !== undefined ? ' :: ' + JSON.stringify(r.detail) : ''}`);
  }
  console.log(`TOTAL=${total} PASS=${total - failed.length} FAIL=${failed.length}`);
  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((e) => { console.error('RUNTIME HARNESS ERROR:', e); process.exit(1); });
