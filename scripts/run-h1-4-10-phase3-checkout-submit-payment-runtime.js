#!/usr/bin/env node
// scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-CRM (Phase 3)
//
// 範圍：CHECKOUT-SUBMIT-DIAGNOSTICS + PAYMENT-SUCCESS
//   Part A：public/line-order.html 真實 jsdom（沿用 H1.4.9 策略：載入真正
//           production HTML+script，不重寫假的 submitOrder()）
//   Part B：public/line-shipping.html 真實 jsdom
//   Part C：真實 HTTP — client 偽造 payment_success 必須被拒絕
//   Part D：routes/linepay.js /confirm 真實 HTTP + node-fetch 依賴注入
//           （LINE Pay 官方 API 本身不能真的打網路，用 require.cache 注入
//           假的 node-fetch module，不修改 production 程式碼）
//   Part E：靜態檢查 — GA4/Meta 映射表未包含任何本輪新事件

'use strict';
process.on('unhandledRejection', (reason) => {
  console.warn(`[process unhandledRejection @ ${global.__currentBlock || '?'}]`, reason && reason.stack || reason);
});

const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

class LocalPublicResourceLoader extends ResourceLoader {
  fetch(url) {
    try {
      const u = new URL(url);
      const filePath = path.join(PUBLIC_DIR, decodeURIComponent(u.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return Promise.resolve(fs.readFileSync(filePath));
    } catch (e) { /* fall through */ }
    return Promise.resolve(Buffer.from(''));
  }
}

const HTML_SRC = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
const HTML_SRC_SHIP = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');

function mockFetchResponse(body) {
  return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });
}
function fireClick(win, el) { const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(ev); }
function setGlobal(window, name, value) { window.__bridge = value; window.eval(`${name} = window.__bridge;`); }
async function wait(ticks) { for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 10)); }

const SAMPLE_PRODUCTS = [
  { id: 1, name: '珍珠奶茶', effective_line_name: '珍珠奶茶', price: 60, effective_line_price: 60,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    takeout_available: true, delivery_available: true, line_spec: '大杯' },
  { id: 4, name: '外送限定套餐', effective_line_name: '外送限定套餐', price: 200, effective_line_price: 200,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1,
    // production 的 _productModeStatus() 判斷商品是否支援某模式，看的是
    // {mode}_sold_out_reason／{mode}_can_next_day，不是 takeout_available 這種
    // 布林欄位（該欄位在這支函式裡完全不會被讀取）——這裡用真實會被讀取的欄位
    // 讓 takeout 對這個商品回傳 enabled:false，藉此製造真實的
    // product_mode_conflict（購物車商品與目前選擇的取餐方式衝突）。
    takeout_sold_out_reason: 'delivery_only', takeout_can_next_day: false,
    line_spec: '' },
];

let ORDER_RESPONSE_OVERRIDE = null; // 測試可覆寫 /api/line-orders、/api/line-shipping 回應

async function routeFetch(url, opts) {
  if (url.includes('/api/line-shop')) {
    return mockFetchResponse({
      success: true,
      data: {
        store_id: 'store_001', shop_name: '測試店家', shop_address: '', shop_hours: '',
        shop_announcement: '', build_version: 'test',
        line_member_gate_mode: 'disabled', line_member_gate_enabled: false,
        coupon_feature_enabled: true,
        line_payment_cash_enabled: '1',
        takeout_status: { selectable: true, enabled: true, today_open: true, allow_next_day: true },
        delivery_status: { selectable: true, enabled: true, today_open: true, allow_next_day: true },
        payment_methods: ['cash'],
      },
    });
  }
  if (url.includes('/api/line-menu')) {
    return mockFetchResponse({ success: true, data: { categories: [{ id: 1, name: '飲品' }], products: SAMPLE_PRODUCTS } });
  }
  if (url.includes('/api/settings/business-calendar')) return mockFetchResponse({ success: false, data: [] });
  if (url.includes('/api/delivery/calculate-fee')) return mockFetchResponse({ success: true, finalFee: 30, rawFee: 30, discount: 0 });
  if (url.includes('/api/coupons')) return mockFetchResponse({ success: false, message: 'not found' });
  // 需求文件六：合法時段回應，讓 buildDateSelector()/buildTimeSelector() 走真正
  // production 演算法產生 pDate/pTime 合法值，不偽造第二套日期演算法。
  if (url.includes('/api/line-orders/timeslots')) return mockFetchResponse({ success: true, slots: ['16:00', '16:30', '17:00'] });
  if (url.includes('/api/analytics/events')) return mockFetchResponse({ success: true });
  if (url.includes('/api/line-orders')) {
    if (ORDER_RESPONSE_OVERRIDE) return mockFetchResponse(ORDER_RESPONSE_OVERRIDE);
    return mockFetchResponse({ success: true, data: { uuid: 'order-uuid-1', order_number: 'ORD0001', total: 60, delivery_fee: 0, distance_km: 0 } });
  }
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint' });
}

async function freshEnvOrder() {
  ORDER_RESPONSE_OVERRIDE = null;
  const dom = new JSDOM(HTML_SRC, {
    url: 'https://runtime-test.local/line-order.html',
    pretendToBeVisual: true, runScripts: 'dangerously', resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = (url, opts) => routeFetch(String(url), opts);
      window.scrollTo = function () {};
      window.addEventListener('error', (e) => console.warn('[window error]', e.error && e.error.stack || e.message));
      window.addEventListener('unhandledrejection', (e) => { console.warn('[window unhandledrejection]', e.reason && e.reason.stack || e.reason); e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => { if (window.document.readyState !== 'loading') resolve(); else window.document.addEventListener('DOMContentLoaded', () => resolve()); });
  await wait(40);
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
  for (const [pid, qty] of entries) { const p = products.find((x) => x.id === pid); cart[pid] = { product: p, qty }; }
  window.__bridge = cart;
  window.eval('cart = window.__bridge;');
  window.updateBar();
  window.renderCartItems();
}

async function enterCheckout(window, document) {
  fireClick(window, document.getElementById('cartBar'));
  fireClick(window, document.getElementById('goCheckoutBtn'));
  await wait(25); // 等待 buildDateSelector()/buildTimeSelector() 的真實 timeslots 請求完成
}

// 需求文件七：只操作真正 DOM/state，不直接送 analytics event。
async function setValidLineOrderCheckoutState(window, document, { mode = 'takeout' } = {}) {
  document.getElementById('cName').value = '王小明';
  document.getElementById('cPhone').value = '0912345678';
  if (mode === 'delivery') {
    setGlobal(window, 'currentMode', 'delivery');
    window.eval("document.getElementById('oType').value='delivery';");
    document.getElementById('deliveryAddress').value = '台北市中正區測試路100號';
    setGlobal(window, 'deliveryLatLng', { lat: 25.03, lng: 121.5 });
    setGlobal(window, 'deliveryFeeCalculated', true);
  }
  setGlobal(window, 'selectedPay', 'cash');
  // pDate/pTime 由 buildDateSelector()/buildTimeSelector() 真實演算法在
  // enterCheckout() 內已自動選好合法值（見上方 timeslots stub），這裡不重複
  // 手動賦值，維持「只驗證真實 production 行為」的原則。
}

async function main() {
  await runPartA();
  await runPartB();
  await runPartCD(); // 需求文件：initDb() 是 process 內單例（一次初始化後 wrappedDb 快取，
  // 第二次呼叫直接回傳同一個連線，不會依 POS_DB_PATH 切換檔案）——Part C／Part D
  // 因此必須共用同一個暫存 DB／同一次 initDb()，不能各自建立、各自刪除，
  // 否則後呼叫的 Part 會對著已被前一個 Part 清掉的檔案寫入。
  runPartE();

  console.log('\n== Phase 3 Summary ==');
  const total = results.length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  console.log(`TOTAL=${total} PASS=${passCount} FAIL=${failCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}${r.detail ? ' — ' + r.detail : ''}`));
  }
  process.exit(failCount > 0 ? 1 : 0);
}

// ════════════════════════════════════════════════════════════════
// Part A：line-order.html
// ════════════════════════════════════════════════════════════════
async function runPartA() {
  console.log('\n== Part A：line-order.html submitOrder(event) 因果契約 ==');

  // L1：直接 await window.submitOrder() → 0 個 submit/validation 事件
  {
    global.__currentBlock = 'A-L1';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    trackedEvents.length = 0;
    await window.eval('submitOrder()');
    await wait(15);
    assert(!trackedEvents.some((e) => e.name === 'checkout_submit_click'), 'L1 直接呼叫 submitOrder() 不產生 checkout_submit_click');
    assert(!trackedEvents.some((e) => e.name === 'checkout_validation_failed'), 'L1 直接呼叫 submitOrder() 不產生 checkout_validation_failed');
  }

  // L2：傳其他元素的 click event → submit=0, validation_failed=0
  {
    global.__currentBlock = 'A-L2';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    document.getElementById('cName').value = ''; // 故意留一個會擋下的欄位，確認即使會 fail 也不因非真實點擊而送出
    trackedEvents.length = 0;
    window.eval(`
      const fakeEl = document.getElementById('cName');
      const fakeEvent = new MouseEvent('click', { bubbles: true, cancelable: true });
      Object.defineProperty(fakeEvent, 'currentTarget', { value: fakeEl });
      submitOrder(fakeEvent);
    `);
    await wait(15);
    assert(!trackedEvents.some((e) => e.name === 'checkout_submit_click'), 'L2 傳其他元素 click event 不產生 checkout_submit_click');
    assert(!trackedEvents.some((e) => e.name === 'checkout_validation_failed'), 'L2 傳其他元素 click event 不產生 checkout_validation_failed');
  }

  // L3：真正 #subBtn click → checkout_submit_click 恰好一次
  {
    global.__currentBlock = 'A-L3';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const submitClicks = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    assert(submitClicks.length === 1, 'L3 真正 #subBtn click → checkout_submit_click 恰好一次', `found ${submitClicks.length}`);
  }

  // 需求文件九：Retry 核心測試 —— 單一 fresh env 內連續兩次真實點擊
  {
    global.__currentBlock = 'A-retry';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    document.getElementById('cName').value = '';
    document.getElementById('cPhone').value = '0912345678';
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const submit1 = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed1 = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit1.length === 1, '第一次點擊 checkout_submit_click=1');
    assert(failed1.length === 1 && failed1[0].payload.metadata.reason_code === 'missing_name', '第一次 validation_failed reason=missing_name', JSON.stringify(failed1.map((e) => e.payload.metadata)));

    document.getElementById('cName').value = '王小明';
    document.getElementById('cPhone').value = '';
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const submit2 = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed2 = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit2.length === 2, '補姓名再按一次 → 總 checkout_submit_click=2（無 cart_id 永久去重）', `found ${submit2.length}`);
    assert(failed2.length === 2 && failed2[1].payload.metadata.reason_code === 'missing_phone', '第二次 validation_failed reason=missing_phone', JSON.stringify(failed2.map((e) => e.payload.metadata)));
  }

  // 需求文件十：同時缺 name/phone/payment，一次 click 只記第一個 reason
  {
    global.__currentBlock = 'A-multi-missing';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    document.getElementById('cName').value = '';
    document.getElementById('cPhone').value = '';
    setGlobal(window, 'selectedPay', '');
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const submit = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit.length === 1, '同時多欄位缺漏：checkout_submit_click 仍是 1');
    assert(failed.length === 1, '同時多欄位缺漏：只送出一筆 checkout_validation_failed（不是三筆）', `found ${failed.length}`);
    assert(failed[0].payload.metadata.reason_code === 'missing_name', '多欄位缺漏時 reason 是第一個真正擋下送出的（missing_name）');
  }

  // 需求文件十一：Validation Matrix —— 每個 case 用 fresh env，只破壞一個條件
  const matrixCases = [
    {
      name: 'empty_cart',
      setup: async (window, document) => {
        window.eval("openCheckoutStep({type:'click', currentTarget: document.getElementById('goCheckoutBtn')});");
        await wait(15);
        await setValidLineOrderCheckoutState(window, document);
      },
      skipCart: true,
    },
    {
      name: 'missing_fulfillment',
      setup: async (window, document) => {
        await setValidLineOrderCheckoutState(window, document);
        window.eval("document.getElementById('oType').value='';");
      },
    },
    {
      name: 'mode_unavailable',
      setup: async (window, document) => {
        window.eval("shopData.delivery_status = { selectable:false, enabled:false, today_open:false, allow_next_day:false };");
        setGlobal(window, 'currentMode', 'delivery');
        window.eval("document.getElementById('oType').value='delivery';");
        await setValidLineOrderCheckoutState(window, document, { mode: 'delivery' });
      },
    },
    {
      name: 'product_mode_conflict',
      setup: async (window, document) => {
        // 明確鎖定 currentMode=takeout（不依賴頁面初始化時的自動判斷邏輯），
        // 聚焦測試「購物車商品與目前模式不相容」這個分支本身。
        setGlobal(window, 'currentMode', 'takeout');
        window.eval("document.getElementById('oType').value='takeout';");
        await setValidLineOrderCheckoutState(window, document);
      },
      cartOverride: [[4, 1]], // takeout_sold_out_reason 已設定，對 takeout 回傳 enabled:false
    },
    {
      name: 'missing_payment',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document); setGlobal(window, 'selectedPay', ''); },
    },
    {
      name: 'missing_date',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document); document.getElementById('pDate').value = ''; },
    },
    {
      name: 'missing_time',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document); document.getElementById('pTime').value = ''; },
    },
    {
      name: 'missing_address',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document, { mode: 'delivery' }); document.getElementById('deliveryAddress').value = ''; },
    },
    {
      name: 'address_not_resolved',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document, { mode: 'delivery' }); setGlobal(window, 'deliveryLatLng', { lat: null, lng: null }); },
    },
    {
      name: 'delivery_fee_pending',
      setup: async (window, document) => { await setValidLineOrderCheckoutState(window, document, { mode: 'delivery' }); setGlobal(window, 'deliveryFeeCalculated', false); },
    },
    {
      name: 'order_cutoff',
      setup: async (window, document) => {
        await setValidLineOrderCheckoutState(window, document);
        window.eval(`
          shopData.takeout_status.today_state = 'cutoff';
          _submitToStatus_override = true;
        `);
        // getFulfillmentStatus() 讀 shopData.takeout_status.today_state；同時要讓
        // pickupDate 落在「今天」才會真正觸發 cutoff 分支（isNextDayOrder=false）。
        window.eval(`
          (function(){
            const pd = document.getElementById('pDate');
            const now = twNow(); const nowStr = fmtD(now);
            if (pd) pd.value = nowStr;
          })();
        `);
      },
    },
  ];

  for (const c of matrixCases) {
    global.__currentBlock = `A-matrix-${c.name}`;
    const { window, document, trackedEvents } = await freshEnvOrder();
    if (!c.skipCart) setCart(window, c.cartOverride || [[1, 1]]);
    if (!c.skipCart) await enterCheckout(window, document);
    await c.setup(window, document);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const submit = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit.length === 1, `${c.name}: checkout_submit_click=1`, `found ${submit.length}`);
    assert(failed.length === 1, `${c.name}: checkout_validation_failed=1`, `found ${failed.length}`);
    if (failed.length === 1) {
      assert(failed[0].payload.metadata.reason_code === c.name, `${c.name}: reason_code 正確`, JSON.stringify(failed[0].payload.metadata));
    }
  }

  // line_member_required：強制 checkout gate 擋下
  {
    global.__currentBlock = 'A-line-member-required';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    window.eval(`
      _lineMemberGateConfig = { gate_enabled: true, gate_mode: 'checkout', liff_id: 'x' };
      LineMemberGate.requireMemberBeforeCheckout = async () => ({ ok: false });
    `);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(15);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'line_member_required', 'line_member_required reason 正確（強制 checkout Gate 擋下）', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // friend_checkout（非 blocking）不應產生 line_member_required
  {
    global.__currentBlock = 'A-friend-checkout-no-required';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    window.eval(`_lineMemberGateConfig = { gate_enabled: true, gate_mode: 'friend_checkout', liff_id: 'x' };`);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(20);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(!failed.some((e) => e.payload.metadata.reason_code === 'line_member_required'), 'friend_checkout 模式不產生 line_member_required（非 blocking Gate）');
  }

  // 需求文件十二：Successful Cash Order
  {
    global.__currentBlock = 'A-success';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document);
    ORDER_RESPONSE_OVERRIDE = { success: true, data: { uuid: 'order-uuid-success', order_number: 'ORD-SUCCESS', total: 60, delivery_fee: 0, distance_km: 0 } };
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(25);
    const submitClicks = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    const paymentStarted = trackedEvents.filter((e) => e.name === 'payment_started');
    assert(submitClicks.length === 1, 'Success: checkout_submit_click=1');
    assert(failed.length === 0, 'Success: checkout_validation_failed=0（全部驗證通過）');
    assert(paymentStarted.length === 1, 'Success: 既有 payment_started 契約不變（cash 送出時仍記錄一次）');
    assert(document.getElementById('successScreen').classList.contains('show'), 'Success: 訂單成立畫面正確顯示（既有 submitOrder 成功流程未被破壞）');
  }

  // 需求文件十四：Privacy Assertion
  {
    global.__currentBlock = 'A-privacy';
    const { window, document, trackedEvents } = await freshEnvOrder();
    setCart(window, [[1, 1]]);
    await enterCheckout(window, document);
    await setValidLineOrderCheckoutState(window, document, { mode: 'delivery' });
    document.getElementById('cName').value = '王小明';
    document.getElementById('cPhone').value = '0912345678';
    document.getElementById('deliveryAddress').value = '桃園市測試路123號';
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('subBtn'));
    await wait(25);
    const diagEvents = trackedEvents.filter((e) => e.name === 'checkout_submit_click' || e.name === 'checkout_validation_failed');
    assert(diagEvents.length > 0, 'Privacy: 至少捕捉到一筆診斷事件供檢查');
    const serialized = JSON.stringify(diagEvents.map((e) => e.payload.metadata));
    assert(!serialized.includes('王小明'), 'metadata 不含姓名');
    assert(!serialized.includes('0912345678'), 'metadata 不含電話');
    assert(!serialized.includes('桃園市測試路123號'), 'metadata 不含地址');
    assert(!serialized.includes('U_SECRET_TEST'), 'metadata 不含 LINE UID（防呆確認，未曾放入相關欄位）');
    assert(!serialized.includes('SECRET_TOKEN'), 'metadata 不含 Token（防呆確認，未曾放入相關欄位）');
    assert(!serialized.toLowerCase().includes('lat') && !serialized.toLowerCase().includes('lng'), 'metadata 不含經緯度欄位');
    assert(!serialized.includes('member_session') && !serialized.includes('coupon_code') && !serialized.includes('note'), 'metadata 不含 member_session/coupon_code/note');
    diagEvents.forEach((e) => {
      const keys = Object.keys(e.payload.metadata || {});
      const allowed = new Set(['checkout_stage', 'submit_trigger', 'order_mode', 'item_count', 'cart_value', 'reason_code', 'has_cart', 'payment_method_type']);
      assert(keys.every((k) => allowed.has(k)), `${e.name} metadata 只含白名單欄位`, JSON.stringify(keys));
    });
  }
}

// ════════════════════════════════════════════════════════════════
// Part B：line-shipping.html
// ════════════════════════════════════════════════════════════════
async function freshEnvShipping() {
  const dom = new JSDOM(HTML_SRC_SHIP, {
    url: 'https://runtime-test.local/line-shipping.html',
    pretendToBeVisual: true, runScripts: 'dangerously', resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = (url, opts) => routeFetchShipping(String(url), opts);
      window.scrollTo = function () {};
      window.addEventListener('error', (e) => console.warn('[window error]', e.error && e.error.stack || e.message));
      window.addEventListener('unhandledrejection', (e) => { console.warn('[window unhandledrejection]', e.reason && e.reason.stack || e.reason); e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => { if (window.document.readyState !== 'loading') resolve(); else window.document.addEventListener('DOMContentLoaded', () => resolve()); });
  await wait(40);
  const trackedEvents = [];
  const original = window._trackEvent;
  window._trackEvent = function (name, payload) {
    trackedEvents.push({ name, payload });
    if (typeof original === 'function') { try { return original.apply(window, arguments); } catch (e) {} }
  };
  return { dom, window, document: window.document, trackedEvents };
}
async function routeFetchShipping(url, opts) {
  if (url.includes('/api/line-shipping/shop')) {
    return mockFetchResponse({
      success: true,
      data: {
        store: { name: '測試冷藏宅配', address: '', logo: '' },
        settings: {
          shipping_title: '冷藏宅配', shipping_description: '', shipping_enabled: true,
          shipping_min_order_amount: 0, shipping_fee: 100, shipping_free_threshold: 0,
          line_member_gate_mode: 'disabled', line_member_gate_enabled: false,
        },
        coupon_feature_enabled: true,
        announcement: '',
        products: SAMPLE_PRODUCTS,
        upsell_products: [],
        payment_methods: ['cash'],
        earliest_date: '2026-01-01', latest_date: '2026-12-31',
      },
    });
  }
  if (url.includes('/api/analytics/events')) return mockFetchResponse({ success: true });
  if (url.includes('/api/line-shipping')) {
    if (ORDER_RESPONSE_OVERRIDE) return mockFetchResponse(ORDER_RESPONSE_OVERRIDE);
    return mockFetchResponse({ success: true, data: { uuid: 'ship-uuid-1', order_number: 'SHIP0001', total: 60 } });
  }
  return mockFetchResponse({ success: false, message: 'stub: unhandled endpoint' });
}
function setCartShipping(window, entries) {
  const products = window.eval('SHOP_DATA.products');
  const cart = {};
  for (const [pid, qty] of entries) { const p = products.find((x) => x.id === pid); cart[pid] = { product: p, qty }; }
  window.__bridge = cart;
  window.eval('cart = window.__bridge;');
  window.eval('typeof updateCartBar === "function" && updateCartBar();');
  window.eval('typeof renderCartItems === "function" && renderCartItems();');
}
async function enterCheckoutShipping(window, document) {
  if (document.getElementById('cartBar')) fireClick(window, document.getElementById('cartBar'));
  fireClick(window, document.getElementById('goCheckoutBtn'));
  await wait(20);
}
async function setValidShippingCheckoutState(document) {
  document.getElementById('rName').value = '王小明';
  document.getElementById('rPhone').value = '0912345678';
  document.getElementById('rCity').value = '台北市';
  document.getElementById('rDistrict').value = '中正區';
  document.getElementById('rAddress').value = '測試路1號';
}

async function runPartB() {
  console.log('\n== Part B：line-shipping.html submitOrder(event) 因果契約 ==');
  ORDER_RESPONSE_OVERRIDE = null;

  // S1：直接 submitOrder() → diagnostic event 0
  {
    global.__currentBlock = 'B-S1';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    await setValidShippingCheckoutState(document);
    setGlobal(window, 'selectedPayment', 'cash');
    trackedEvents.length = 0;
    await window.eval('submitOrder()');
    await wait(15);
    assert(!trackedEvents.some((e) => e.name === 'checkout_submit_click'), 'S1 直接呼叫 submitOrder() 不產生 checkout_submit_click');
    assert(!trackedEvents.some((e) => e.name === 'checkout_validation_failed'), 'S1 直接呼叫 submitOrder() 不產生 checkout_validation_failed');
  }

  // S2：真正 #submitBtn click → checkout_submit_click=1
  {
    global.__currentBlock = 'B-S2';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    await setValidShippingCheckoutState(document);
    setGlobal(window, 'selectedPayment', 'cash');
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(20);
    const submitClicks = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    assert(submitClicks.length === 1, 'S2 真正 #submitBtn click → checkout_submit_click 恰好一次', `found ${submitClicks.length}`);
  }

  // S3：empty_cart
  {
    global.__currentBlock = 'B-S3';
    const { window, document, trackedEvents } = await freshEnvShipping();
    window.eval("openCheckoutStep({type:'click', currentTarget: document.getElementById('goCheckoutBtn')});");
    await wait(15);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const submit = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit.length === 1, 'S3 empty_cart: checkout_submit_click=1');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'empty_cart', 'S3 empty_cart reason 正確', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S4：minimum_order_not_met
  {
    global.__currentBlock = 'B-S4';
    const { window, document, trackedEvents } = await freshEnvShipping();
    window.eval("SHOP_DATA.settings.shipping_min_order_amount = 500;");
    setCartShipping(window, [[1, 1]]); // 60 < 500
    await enterCheckoutShipping(window, document);
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const submit = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submit.length === 1, 'S4 minimum_order: checkout_submit_click=1');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'minimum_order_not_met', 'S4 minimum_order_not_met reason 正確', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S5：missing_name（production 目前 !name||!phone 共用一個 branch，Phase 3 用
  // reason_code 三元判斷指出真正缺的欄位，未拆分 toast/業務邏輯順序本身）
  {
    global.__currentBlock = 'B-S5';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    document.getElementById('rName').value = '';
    document.getElementById('rPhone').value = '0912345678';
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'missing_name', 'S5 missing_name reason 正確（name 缺、phone 有）', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S6：missing_phone
  {
    global.__currentBlock = 'B-S6';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    document.getElementById('rName').value = '王小明';
    document.getElementById('rPhone').value = '';
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'missing_phone', 'S6 missing_phone reason 正確（name 有、phone 缺）', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S7：missing_address
  {
    global.__currentBlock = 'B-S7';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    document.getElementById('rName').value = '王小明';
    document.getElementById('rPhone').value = '0912345678';
    document.getElementById('rCity').value = '';
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'missing_address', 'S7 missing_address reason 正確', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S8：missing_payment
  {
    global.__currentBlock = 'B-S8';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    await setValidShippingCheckoutState(document);
    setGlobal(window, 'selectedPayment', '');
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(15);
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(failed.length === 1 && failed[0].payload.metadata.reason_code === 'missing_payment', 'S8 missing_payment reason 正確', JSON.stringify(failed.map((e) => e.payload.metadata)));
  }

  // S9：successful submit
  {
    global.__currentBlock = 'B-S9';
    const { window, document, trackedEvents } = await freshEnvShipping();
    setCartShipping(window, [[1, 1]]);
    await enterCheckoutShipping(window, document);
    await setValidShippingCheckoutState(document);
    setGlobal(window, 'selectedPayment', 'cash');
    ORDER_RESPONSE_OVERRIDE = { success: true, data: { uuid: 'ship-uuid-success', order_number: 'SHIP-SUCCESS', total: 60 } };
    trackedEvents.length = 0;
    fireClick(window, document.getElementById('submitBtn'));
    await wait(25);
    const submitClicks = trackedEvents.filter((e) => e.name === 'checkout_submit_click');
    const failed = trackedEvents.filter((e) => e.name === 'checkout_validation_failed');
    assert(submitClicks.length === 1, 'S9 Success: checkout_submit_click=1');
    assert(failed.length === 0, 'S9 Success: checkout_validation_failed=0');
  }
}

// ════════════════════════════════════════════════════════════════
// Part C+D：真實 HTTP，共用同一個暫存 DB（initDb() 是 process 內單例，見上方
// main() 的說明，Part C／Part D 不能各自建立、各自刪除 DB 檔案）
// ════════════════════════════════════════════════════════════════
async function runPartCD() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase3-cd-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';
  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();

  try {
    await runPartC(db);
    await runPartD(db);
  } finally {
    delete process.env.POS_DB_PATH;
    cleanup();
  }
}

// ════════════════════════════════════════════════════════════════
// Part C：真實 HTTP — client 偽造 payment_success 必須被拒
// ════════════════════════════════════════════════════════════════
async function runPartC(db) {
  console.log('\n== Part C：真實 HTTP — client 偽造 payment_success ==');
  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/analytics', require('../routes/analytics'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function post(body) {
    const res = await fetch(`${base}/api/analytics/events`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  try {
    const beforeCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND event_name='payment_success'`, ['store_001']).c;
    const r = await post({
      visitor_id: 'v-forge', session_id: 's-forge', event_name: 'payment_success',
      metadata: { value: 999999, payment_provider: 'linepay' },
    });
    assert(r.status === 400 || r.status === 403, 'client POST payment_success 被拒絕（HTTP 400/403）', `status=${r.status}`);
    const afterCount = db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND event_name='payment_success'`, ['store_001']).c;
    assert(afterCount === beforeCount && afterCount === 0, 'DB event_name=payment_success 計數仍是 0', `before=${beforeCount} after=${afterCount}`);

    const r2 = await post({ visitor_id: 'v1', session_id: 's1', event_name: 'checkout_submit_click', metadata: { checkout_stage: 'checkout', order_mode: 'takeout', item_count: 1, cart_value: 60 } });
    assert(r2.status === 200 && r2.json.success === true, 'checkout_submit_click 仍允許 client 寫入', JSON.stringify(r2.json));

    const r3 = await post({ visitor_id: 'v1', session_id: 's1', event_name: 'checkout_validation_failed', metadata: { reason_code: 'missing_name', order_mode: 'takeout' } });
    assert(r3.status === 200 && r3.json.success === true, 'checkout_validation_failed 仍允許 client 寫入', JSON.stringify(r3.json));
  } finally {
    server.close();
  }
}

// ════════════════════════════════════════════════════════════════
// Part D：routes/linepay.js /confirm — LINE Pay authoritative test
// ════════════════════════════════════════════════════════════════
async function runPartD(db) {
  console.log('\n== Part D：routes/linepay.js（LINE Pay authoritative）==');

  // 需求文件十六：在 routes/linepay.js 第一次 require 前，patch 它實際 import 的
  // node-fetch 依賴（require.cache 注入），不打真實 api.line.me，不修改
  // production 程式碼本身的 dependency injection 方式。
  let confirmReturnCode = '0000';
  let lastConfirmRequestBody = null;
  const nodeFetchPath = require.resolve('node-fetch');
  const fakeFetch = async (url, opts) => {
    if (String(url).includes('/confirm')) {
      try { lastConfirmRequestBody = JSON.parse((opts && opts.body) || '{}'); } catch (e) { lastConfirmRequestBody = null; }
      return { json: async () => ({ returnCode: confirmReturnCode, returnMessage: confirmReturnCode === '0000' ? 'Success' : 'test failure' }) };
    }
    if (String(url).includes('/request')) {
      return { json: async () => ({ returnCode: '0000', info: { paymentUrl: { web: 'https://sandbox.line.me/pay/fake' }, transactionId: 'txn-req-1' } }) };
    }
    return { json: async () => ({ returnCode: '9999' }) };
  };
  require.cache[nodeFetchPath] = { id: nodeFetchPath, filename: nodeFetchPath, loaded: true, exports: fakeFetch };

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  // 需求文件十七：建立 LINE Pay config。routes/linepay.js getLinePayConfig()
  // 實際查的是 payment_gateways 表（code='linepay'，欄位 merchant_id/secret_key/
  // mode/is_active），不是 settings key-value（初次 Audit 時筆誤，此處已修正
  // 為 production 真實讀取的資料表與欄位）。
  db.run(`DELETE FROM payment_gateways WHERE store_id=? AND code='linepay'`, ['store_001']);
  db.run(`INSERT INTO payment_gateways (store_id, name, code, is_active, mode, merchant_id, secret_key)
    VALUES (?,?,?,?,?,?,?)`, ['store_001', 'LINE Pay', 'linepay', 1, 'test', 'test-channel-id', 'test-channel-secret']);
  setSetting('store_001', 'line_payment_linepay_enabled', '1');

  function makeOrder(uuid, orderNumber, total) {
    // orders 表的 id 是 PRIMARY KEY（非 uuid 欄位本身），items/subtotal/total 皆
    // NOT NULL 無預設值（見 utils/db.js CREATE TABLE orders）。uuid 是另外
    // migration 加上的獨立欄位，routes/linepay.js /confirm 用
    // WHERE store_id=? AND (order_number=? OR uuid=?) 查詢，這裡兩者填相同值。
    db.run(`INSERT OR REPLACE INTO orders
      (id, uuid, store_id, order_number, items, subtotal, total, payment_method, payment_status, status, order_status, kitchen_status, order_mode, created_at, updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'),datetime('now'))`,
      [uuid, uuid, 'store_001', orderNumber, JSON.stringify([{ product_id: 1, qty: 1 }]), total, total, 'linepay', 'unpaid', 'pending', 'pending', 'pending', 'takeout']);
  }
  // 需求文件十七：submit_order tracking context，確保 getOrderTrackingContext() 能取到
  // visitor_id/session_id/cart_id/source。
  function insertTrackingContext(orderUuid) {
    db.run(`INSERT INTO analytics_events (store_id, visitor_id, session_id, cart_id, order_id, event_name, order_mode, source, created_at)
      VALUES (?,?,?,?,?,?,?,?,datetime('now'))`, ['store_001', 'visitor-lp', 'session-lp', 'cart-lp', orderUuid, 'submit_order', 'takeout', 'direct']);
  }

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = req.query.store_id || 'store_001'; next(); });
  app.use('/api/linepay', require('../routes/linepay'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function confirmGet(orderId, transactionId) {
    return fetch(`${base}/api/linepay/confirm?store_id=store_001&orderId=${orderId}&transactionId=${transactionId}`, { redirect: 'manual' });
  }
  function countEvents(orderUuid, eventName) {
    return db.get(`SELECT COUNT(*) c FROM analytics_events WHERE store_id=? AND order_id=? AND event_name=?`, ['store_001', orderUuid, eventName]).c;
  }

  try {
    // 需求文件十九：Confirm Success（含二十：Authoritative Value 防偽 —— stub
    // 的 confirm request body 裡刻意檢查 amount 是否真的來自 DB order.total，
    // 而不是任何前端/query 傳入值——因為 route 本身建構 confirmBody 時只用
    // order.total，這裡驗證的正是這一點）。
    makeOrder('phase3-order-001', 'P3-001', 1234);
    insertTrackingContext('phase3-order-001');
    confirmReturnCode = '0000';
    const resB = await confirmGet('P3-001', 'txn-success-1');
    assert(resB.status === 302, 'Confirm Success：正常導回頁面（302 redirect）', `status=${resB.status}`);
    assert(lastConfirmRequestBody && lastConfirmRequestBody.amount === 1234, 'Confirm 送給 LINE Pay 官方 API 的 amount 使用 DB order.total（=1234），非任何前端/query 傳入值', JSON.stringify(lastConfirmRequestBody));
    const orderAfterB = db.get('SELECT * FROM orders WHERE uuid=?', ['phase3-order-001']);
    assert(orderAfterB.payment_status === 'paid', 'Confirm Success：orders.payment_status 更新為 paid');
    assert(countEvents('phase3-order-001', 'payment_success') === 1, 'Confirm Success：payment_success count=1');
    assert(countEvents('phase3-order-001', 'purchase') === 1, 'Confirm Success：purchase count=1（既有 authoritative 語意）');
    const paymentSuccessRow = db.get(`SELECT order_id, metadata_json FROM analytics_events WHERE store_id=? AND order_id=? AND event_name='payment_success'`, ['store_001', 'phase3-order-001']);
    assert(paymentSuccessRow.order_id === 'phase3-order-001', 'payment_success.order_id = DB order.uuid');
    const meta = JSON.parse(paymentSuccessRow.metadata_json || '{}');
    assert(meta.value === 1234, 'payment_success.value 來源為 DB order.total（=1234），非 query/body 傳入值', JSON.stringify(meta));
    const allowedMetaKeys = new Set(['order_number', 'payment_provider', 'payment_method', 'currency', 'value']);
    assert(Object.keys(meta).every((k) => allowedMetaKeys.has(k)), 'metadata 不含任何白名單外欄位（無 channel secret／transactionId／customer data）', JSON.stringify(Object.keys(meta)));
    assert(meta.payment_provider === 'linepay' && meta.payment_method === 'linepay' && meta.currency === 'TWD', 'metadata 內容正確（payment_provider/payment_method/currency）');

    // 需求文件二十一：Duplicate Confirm
    const resDup = await confirmGet('P3-001', 'txn-success-1-retry');
    assert(resDup.status === 302, 'Duplicate Confirm：仍正常導回（不因重複而報錯）');
    assert(countEvents('phase3-order-001', 'payment_success') === 1, 'Duplicate Confirm：payment_success 仍是 1（idempotent，未重複累加）');
    assert(countEvents('phase3-order-001', 'purchase') === 1, 'Duplicate Confirm：purchase 仍是 1（既有 dedupe 機制持續生效）');

    // 需求文件十八：Confirm Failure
    makeOrder('phase3-order-fail', 'P3-FAIL-1', 777);
    insertTrackingContext('phase3-order-fail');
    confirmReturnCode = '9999';
    const resA = await confirmGet('P3-FAIL-1', 'TX-P3-FAIL');
    assert(resA.status === 302, 'Confirm Failure：仍安全導回（不 500）', `status=${resA.status}`);
    assert(countEvents('phase3-order-fail', 'payment_success') === 0, 'Confirm Failure：payment_success count=0');
    assert(countEvents('phase3-order-fail', 'purchase') === 0, 'Confirm Failure：purchase count=0（既有 authoritative 語意不變）');
    const orderAfterA = db.get('SELECT * FROM orders WHERE uuid=?', ['phase3-order-fail']);
    assert(orderAfterA.payment_status !== 'paid', 'Confirm Failure：payment_status 未被標記為 paid');

    // 需求文件二十二：LINE Pay Request 階段不得 payment_success
    makeOrder('phase3-order-req', 'P3-REQ-1', 500);
    const reqRes = await fetch(`${base}/api/linepay/request?store_id=store_001`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order_uuid: 'phase3-order-req', order_number: 'P3-REQ-1', total: 500, items: [{ name: '測試商品', qty: 1, price: 500 }], customer_name: '王小明' }),
    });
    const reqJson = await reqRes.json().catch(() => ({}));
    assert(reqJson.success === true && !!reqJson.payment_url, 'LINE Pay Request：成功建立付款請求並取得 payment_url', JSON.stringify(reqJson));
    assert(countEvents('phase3-order-req', 'payment_success') === 0, 'LINE Pay Request 階段：payment_success count=0（只是建立請求，不是付款成功）');
  } finally {
    server.close();
    delete require.cache[nodeFetchPath];
  }

  // 靜態確認：/request 路由完全沒有 payment_success 寫入呼叫，且全檔案只有唯一一處寫入
  const linepaySrc = fs.readFileSync(path.join(ROOT, 'routes/linepay.js'), 'utf8');
  const requestFnMatch = linepaySrc.match(/router\.post\('\/request'[\s\S]*?\nrouter\./);
  const paymentSuccessMarker = "event_name: 'payment_success'";
  assert(!!requestFnMatch && !requestFnMatch[0].includes(paymentSuccessMarker), 'LINE Pay /request 路由原始碼完全沒有 payment_success 寫入呼叫（靜態確認）');
  const paymentSuccessWriteCount = (linepaySrc.match(/event_name: 'payment_success'/g) || []).length;
  assert(paymentSuccessWriteCount === 1, 'payment_success 在 routes/linepay.js 只有唯一一處寫入（/confirm 的 Confirm 成功分支）', `found ${paymentSuccessWriteCount}`);
}

// ════════════════════════════════════════════════════════════════
// Part E：靜態檢查 — Static Contract（GA4／Meta 映射表、白名單）
// ════════════════════════════════════════════════════════════════
function runPartE() {
  console.log('\n== Part E：Static Contract（EVENT_WHITELIST／SERVER_ONLY／GA4／Meta）==');
  const analyticsLogSrc = fs.readFileSync(path.join(ROOT, 'utils/analyticsLog.js'), 'utf8');
  ['checkout_submit_click', 'checkout_validation_failed', 'payment_success'].forEach((evt) => {
    assert(new RegExp(`'${evt}'`).test(analyticsLogSrc), `EVENT_WHITELIST 包含 ${evt}`);
  });

  const analyticsRouteSrc = fs.readFileSync(path.join(ROOT, 'routes/analytics.js'), 'utf8');
  const serverOnlyMatch = analyticsRouteSrc.match(/const SERVER_ONLY_EVENTS = new Set\(\[[\s\S]*?\]\);/);
  assert(!!serverOnlyMatch && serverOnlyMatch[0].includes("'payment_success'"), 'SERVER_ONLY_EVENTS 包含 payment_success');
  assert(!!serverOnlyMatch && !serverOnlyMatch[0].includes("'checkout_submit_click'") && !serverOnlyMatch[0].includes("'checkout_validation_failed'"), 'checkout_submit_click／checkout_validation_failed 未被誤列為 SERVER_ONLY');

  assert(/event_name === 'payment_success'/.test(analyticsLogSrc), 'logServerEvent() 已將 payment_success 納入 hasEventForOrder() 查重（與 submit_order/purchase 同一套機制）');

  const analyticsPlatformsJs = fs.readFileSync(path.join(ROOT, 'public/js/analytics-platforms.js'), 'utf8');
  const ga4MapMatch = analyticsPlatformsJs.match(/const GA4_EVENT_MAP = \{[\s\S]*?\};/);
  const metaMapMatch = analyticsPlatformsJs.match(/const META_EVENT_MAP = \{[\s\S]*?\};/);
  ['checkout_submit_click', 'checkout_validation_failed', 'payment_success'].forEach((evt) => {
    assert(!!ga4MapMatch && !ga4MapMatch[0].includes(`${evt}:`), `GA4_EVENT_MAP 未包含 ${evt} 映射`);
    assert(!!metaMapMatch && !metaMapMatch[0].includes(`${evt}:`), `META_EVENT_MAP 未包含 ${evt} 映射`);
  });
  assert(ga4MapMatch[0].includes("checkout_click: 'begin_checkout'"), 'checkout_click → GA4 begin_checkout 映射契約未被本輪修改');
  assert(metaMapMatch[0].includes("checkout_click: 'InitiateCheckout'"), 'checkout_click → Meta InitiateCheckout 映射契約未被本輪修改');
}

main().catch((e) => { console.error('Phase 3 test runner crashed:', e); process.exit(1); });
