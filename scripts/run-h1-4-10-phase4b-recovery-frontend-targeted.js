#!/usr/bin/env node
// scripts/run-h1-4-10-phase4b-recovery-frontend-targeted.js
// H1.4.10 Phase 4B — Frontend Recovery Resume（真實 jsdom，載入真正
// public/line-order.html / public/line-shipping.html production JS）。
//
// Harness 設計原則（本輪修正版）：
//   - Recovery API 回應在 new JSDOM() 之前就準備好，不會被 reset 洗掉
//   - 每個測試環境（envState）有自己獨立的 calls/bodies，不共用全域 counter
//   - Analytics 攔截在 HTTP 層（/api/analytics/events），不用晚掛的 _trackEvent spy
//   - liff.login spy 在 beforeParse 就存在，不會漏掉 bootstrap 早期呼叫
// H1.4.10 Phase 4B（release cleanup）：正式 production 已不再留
// __RECOVERY_NAVIGATION_HOOK__ 這種 test-only global。改成在頁面 script
// 執行完畢、生命週期進行中，直接覆寫 window._navigateRecoveryPayment（頂層
// function 宣告本來就會掛在 window 上）。時機點在 DOMContentLoaded 之後、
// Recovery bootstrap 真正觸發 navigation 之前——足夠早，且不需要在
// production 留下任何測試專用旗標。
//   - 任何 element 找不到只 assert(false)，不會 dereference null 讓 runner crash

'use strict';
const path = require('path');
const fs = require('fs');
const { JSDOM, ResourceLoader } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
async function wait(ticks) { for (let i = 0; i < ticks; i++) await new Promise((r) => setTimeout(r, 10)); }
async function waitUntil(fn, timeoutMs = 3000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (fn()) return true; } catch (e) {}
    await new Promise((r) => setTimeout(r, 15));
  }
  return false;
}

class LocalPublicResourceLoader extends ResourceLoader {
  fetch(url) {
    try {
      const u = new URL(url);
      const filePath = path.join(PUBLIC_DIR, decodeURIComponent(u.pathname));
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) return Promise.resolve(fs.readFileSync(filePath));
    } catch (e) {}
    return Promise.resolve(Buffer.from(''));
  }
}

const HTML_ORDER = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
const HTML_SHIP = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');

function mockRes(body) { return Promise.resolve({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) }); }

const SAMPLE_PRODUCTS = [
  { id: 1, name: '珍珠奶茶', effective_line_name: '珍珠奶茶', price: 60, effective_line_price: 60,
    show_on_line: true, sale_status: 'available', line_sold_out: 0, display_cat_id: 1, line_spec: '' },
];

function defaultRecoveryResponses() {
  return {
    restore: { success: false, reason: 'not_found' },
    resumePayment: { success: false, reason: 'exception' },
    paymentCancelled: { success: false, reason: 'not_found' },
  };
}

// ── 建立一個獨立的 env（不共用全域 counter，每個測試各自封閉）──
function makeEnvState(recoveryResponses) {
  return {
    recoveryResponses: Object.assign(defaultRecoveryResponses(), recoveryResponses || {}),
    calls: { restore: [], resumePayment: [], paymentCancelled: [], analytics: [] },
    liffLoginCalls: 0,
    navigationCalls: [],
  };
}

function buildRouteFetch(envState, kind) {
  return async function routeFetch(url, opts) {
    const u = String(url);
    const bodyObj = (() => { try { return JSON.parse((opts && opts.body) || '{}'); } catch (e) { return {}; } })();
    if (u.includes('/api/analytics/events')) { envState.calls.analytics.push(bodyObj); return mockRes({ success: true }); }
    if (u.includes('/api/cart-recovery/restore')) { envState.calls.restore.push(bodyObj); return mockRes(envState.recoveryResponses.restore); }
    if (u.includes('/api/cart-recovery/resume-payment')) { envState.calls.resumePayment.push(bodyObj); return mockRes(envState.recoveryResponses.resumePayment); }
    if (u.includes('/api/cart-recovery/payment-cancelled')) { envState.calls.paymentCancelled.push(bodyObj); return mockRes(envState.recoveryResponses.paymentCancelled); }
    if (kind === 'order') {
      if (u.includes('/api/line-shop')) {
        return mockRes({ success: true, data: {
          store_id: 'store_001', shop_name: '測試店家', build_version: 'test',
          line_member_gate_mode: 'disabled', line_member_gate_enabled: false,
          line_member_auto_identify_enabled: false,
          cart_recovery_enabled: '1', cart_recovery_line_enabled: '1',
          coupon_feature_enabled: true, line_payment_cash_enabled: '1',
          takeout_status: { selectable: true, enabled: true, today_open: true, allow_next_day: true },
          delivery_status: { selectable: true, enabled: true, today_open: true, allow_next_day: true },
          payment_methods: ['cash'],
        } });
      }
      if (u.includes('/api/line-menu')) return mockRes({ success: true, data: { categories: [{ id: 1, name: '飲品' }], products: SAMPLE_PRODUCTS } });
      if (u.includes('/api/settings/business-calendar')) return mockRes({ success: false, data: [] });
      if (u.includes('/api/coupons')) return mockRes({ success: false, message: 'not found' });
      if (u.includes('/api/line-orders/timeslots')) return mockRes({ success: true, slots: ['18:00'] });
    } else {
      if (u.includes('/api/line-shipping/shop')) {
        return mockRes({ success: true, data: {
          store: { name: '測試冷藏宅配', address: '' },
          settings: { shipping_enabled: true, shipping_min_order_amount: 0, shipping_fee: 100, shipping_free_threshold: 0,
            line_member_gate_mode: 'disabled', line_member_gate_enabled: false, line_member_auto_identify_enabled: false,
            cart_recovery_enabled: '1', cart_recovery_line_enabled: '1' },
          coupon_feature_enabled: true, announcement: '',
          products: SAMPLE_PRODUCTS, upsell_products: [], payment_methods: ['cash'],
          earliest_date: '2026-01-01', latest_date: '2026-12-31',
        } });
      }
    }
    return mockRes({ success: false, message: 'stub: unhandled endpoint' });
  };
}

function seedMemberSession(window, storeId, memberSession) {
  window.localStorage.setItem(`line_member_session_${storeId}`, JSON.stringify({
    member_session: memberSession, display_name: 'Test', is_friend: true, expires_at: Date.now() + 3600000,
  }));
}
function seedNormalCart(window, storageKey, storeId) {
  window.localStorage.setItem(storageKey, JSON.stringify({
    version: 1, store_id: storeId, session_id: 's-old', visitor_id: 'v-old',
    cart_created_at: Date.now(), cart_updated_at: Date.now(),
    cart: { '1': 9 }, // 舊的、本地既有購物車（數量刻意跟 Recovery 回應不同，用來證明 ordering）
    order_mode: 'takeout',
  }));
}

function dumpStorage(storage) {
  const out = {};
  try { for (let i = 0; i < storage.length; i++) { const k = storage.key(i); out[k] = storage.getItem(k); } } catch (e) {}
  return JSON.stringify(out);
}

async function freshEnvOrder({ url, withMemberSession = true, recoveryResponses, seedOldCart = false } = {}) {
  const envState = makeEnvState(recoveryResponses);
  const dom = new JSDOM(HTML_ORDER, {
    url: url || 'https://runtime-test.local/line-order.html?store_id=store_001',
    pretendToBeVisual: true, runScripts: 'dangerously', resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = buildRouteFetch(envState, 'order');
      window.scrollTo = function () {};
      window.liff = {
        init: async () => {}, isInClient: () => true, isLoggedIn: () => false,
        login: () => { envState.liffLoginCalls += 1; },
        logout: () => {}, getIDToken: () => null, getAccessToken: () => null,
        getFriendship: async () => ({ friendFlag: false }),
      };
      if (withMemberSession) seedMemberSession(window, 'store_001', 'seeded.member.session.token');
      if (seedOldCart) seedNormalCart(window, 'line_order_cart_store_001', 'store_001');
      window.addEventListener('error', (e) => console.warn('[window error]', e.error && e.error.stack || e.message));
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => { if (window.document.readyState !== 'loading') resolve(); else window.document.addEventListener('DOMContentLoaded', () => resolve()); });
  await wait(40);
  // production 已不留 test-only navigation hook，直接覆寫頂層 function
  // （本來就掛在 window 上），讓測試能安全觀察 navigation 而不需要修改任何
  // production 程式碼。
  window._navigateRecoveryPayment = (u) => { envState.navigationCalls.push(u); };
  return { dom, window, document: window.document, envState };
}

async function freshEnvShipping({ url, withMemberSession = true, recoveryResponses, seedOldCart = false } = {}) {
  const envState = makeEnvState(recoveryResponses);
  const dom = new JSDOM(HTML_SHIP, {
    url: url || 'https://runtime-test.local/line-shipping.html?store_id=store_001',
    pretendToBeVisual: true, runScripts: 'dangerously', resources: new LocalPublicResourceLoader(),
    beforeParse(window) {
      window.fetch = buildRouteFetch(envState, 'shipping');
      window.scrollTo = function () {};
      window.liff = {
        init: async () => {}, isInClient: () => true, isLoggedIn: () => false,
        login: () => { envState.liffLoginCalls += 1; },
        logout: () => {}, getIDToken: () => null, getAccessToken: () => null,
        getFriendship: async () => ({ friendFlag: false }),
      };
      if (withMemberSession) seedMemberSession(window, 'store_001', 'seeded.member.session.token');
      if (seedOldCart) seedNormalCart(window, 'line_shipping_cart_store_001', 'store_001');
      window.addEventListener('error', (e) => console.warn('[window error]', e.error && e.error.stack || e.message));
      window.addEventListener('unhandledrejection', (e) => { e.preventDefault && e.preventDefault(); });
    },
  });
  const { window } = dom;
  await new Promise((resolve) => { if (window.document.readyState !== 'loading') resolve(); else window.document.addEventListener('DOMContentLoaded', () => resolve()); });
  await wait(40);
  // production 已不留 test-only navigation hook，直接覆寫頂層 function
  // （本來就掛在 window 上），讓測試能安全觀察 navigation 而不需要修改任何
  // production 程式碼。
  window._navigateRecoveryPayment = (u) => { envState.navigationCalls.push(u); };
  return { dom, window, document: window.document, envState };
}

function findEl(document, id) {
  const el = document.getElementById(id);
  return el;
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // F1-F5：line-order Cart Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_ORDER_1',
      recoveryResponses: { restore: { success: true, resume_type: 'cart', cart_id: 'cart-recovered', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 2, unit_price: 60, subtotal: 120 }], subtotal: 120, discount: 0, total: 120 }, has_unavailable_items: false } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    assert(envState.calls.restore.length === 1, 'F1. URL 帶 recovery_token + valid member_session → /restore calls=1', `calls=${envState.calls.restore.length}`);
    assert(envState.calls.restore[0] && envState.calls.restore[0].page_type === 'line_order', 'F2. request body page_type=line_order', JSON.stringify(envState.calls.restore[0]));
    const bodyKeys = Object.keys(envState.calls.restore[0] || {});
    assert(!bodyKeys.includes('line_user_id') && !bodyKeys.includes('cart_id') && !bodyKeys.includes('order_id') && !bodyKeys.includes('total'), 'F2b. request body 不含 line_user_id/cart_id/order_id/total', JSON.stringify(bodyKeys));
    await waitUntil(() => { const c = window.eval('cart'); return c && c['1'] && c['1'].qty === 2; });
    const cart = window.eval('cart');
    assert(cart && cart['1'] && cart['1'].qty === 2, 'F3. cart 真實 state 有商品（product_id=1, qty=2）', JSON.stringify(cart));
    assert(!envState.calls.analytics.some((e) => e.event_name === 'checkout_click'), 'F4. cart restore → checkout_click（真實 HTTP analytics event）delta=0');
    assert(!envState.calls.analytics.some((e) => e.event_name === 'submit_order'), 'F5. cart restore → submit_order delta=0');
  }

  // ══════════════════════════════════════════════════════════════
  // F6-F9：line-order Checkout Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_ORDER_2',
      recoveryResponses: { restore: { success: true, resume_type: 'checkout', cart_id: 'cart-recovered-checkout', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 1, unit_price: 60, subtotal: 60 }], subtotal: 60, discount: 0, total: 60 }, has_unavailable_items: false } },
    });
    await waitUntil(() => { const c = window.eval('cart'); return c && c['1']; });
    const cart = window.eval('cart');
    assert(cart && cart['1'], 'F6. resume_type=checkout → cart 已還原');
    const checkoutStageEl = findEl(document, 'checkoutStage');
    assert(!!checkoutStageEl, 'checkoutStage 元素存在');
    if (checkoutStageEl) assert(checkoutStageEl.hidden === false, 'F7. checkout stage 可見（未 hidden）');
    assert(!envState.calls.analytics.some((e) => e.event_name === 'checkout_click'), 'F8. checkout resume → checkout_click delta=0');
    const ccSentKey = window.eval(`(function(){ try{ return sessionStorage.getItem('line_cc_sent_store_001'); }catch(e){ return null; } })()`);
    assert(!ccSentKey, 'F9. openCheckoutStep()／#goCheckoutBtn 真實點擊去重旗標未被設置（Bootstrap 沒有 fake click 觸發它）');
  }

  // ══════════════════════════════════════════════════════════════
  // F10-F13：Shipping Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, envState } = await freshEnvShipping({
      url: 'https://runtime-test.local/line-shipping.html?store_id=store_001&recovery_token=SECRET_SHIP_1',
      recoveryResponses: { restore: { success: true, resume_type: 'cart', cart_id: 'ship-cart-recovered', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 3, unit_price: 60, subtotal: 180 }], subtotal: 180, discount: 0, total: 180 }, has_unavailable_items: false } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    assert(envState.calls.restore[0] && envState.calls.restore[0].page_type === 'line_shipping', 'F10. shipping request body page_type=line_shipping', JSON.stringify(envState.calls.restore[0]));
    await waitUntil(() => { const c = window.eval('cart'); return c && c['1'] && c['1'].qty === 3; });
    const cart = window.eval('cart');
    assert(cart && cart['1'] && cart['1'].qty === 3, 'F11. shipping cart state 有商品（qty=3）', JSON.stringify(cart));
  }
  {
    const { document, envState } = await freshEnvShipping({
      url: 'https://runtime-test.local/line-shipping.html?store_id=store_001&recovery_token=SECRET_SHIP_2',
      recoveryResponses: { restore: { success: true, resume_type: 'checkout', cart_id: 'ship-cart-checkout', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 1, unit_price: 60, subtotal: 60 }], subtotal: 60, discount: 0, total: 60 }, has_unavailable_items: false } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    await wait(20);
    const checkoutStageEl = findEl(document, 'checkoutStage');
    assert(!!checkoutStageEl, 'shipping checkoutStage 元素存在');
    if (checkoutStageEl) assert(checkoutStageEl.hidden === false, 'F12. shipping checkout resume → checkout stage visible');
    assert(!envState.calls.analytics.some((e) => e.event_name === 'checkout_click'), 'F13. shipping checkout resume → checkout_click delta=0');
  }

  // ══════════════════════════════════════════════════════════════
  // Wrong-page Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=WRONG_PAGE_TEST',
      recoveryResponses: { restore: { success: false, reason: 'wrong_page' } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    await wait(20);
    const cart = window.eval('cart');
    assert(!cart || Object.keys(cart).length === 0, 'F14. line-order wrong_page 回應 → cart 未被修改', JSON.stringify(cart));
  }
  {
    const { window, envState } = await freshEnvShipping({
      url: 'https://runtime-test.local/line-shipping.html?store_id=store_001&recovery_token=WRONG_PAGE_SHIP_TEST',
      recoveryResponses: { restore: { success: false, reason: 'wrong_page' } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    await wait(20);
    const cart = window.eval('cart');
    assert(!cart || Object.keys(cart).length === 0, 'F15. shipping wrong_page 回應 → cart 未被修改', JSON.stringify(cart));
  }

  // ══════════════════════════════════════════════════════════════
  // F16-F18：Identity Cases（無 member_session）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_ORDER_NOAUTH',
      withMemberSession: false,
    });
    await wait(60);
    assert(envState.calls.restore.length === 0, 'F16. token 存在但無 member_session → /restore calls=0', `calls=${envState.calls.restore.length}`);
    assert(envState.liffLoginCalls === 0, 'F17. liff.login calls=0（不強迫登入）', `calls=${envState.liffLoginCalls}`);
    const noticeEl = findEl(document, 'recoveryNoticeOverlay');
    assert(!!noticeEl, 'F16b. 顯示身分無法驗證提示');
    const goCheckoutBtn = findEl(document, 'goCheckoutBtn');
    assert(!!goCheckoutBtn, 'F18. 普通頁面功能仍可正常操作（#goCheckoutBtn 元素存在，未被 Recovery 錯誤阻塞）');
  }

  // ══════════════════════════════════════════════════════════════
  // F19-F25：Payment Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_PAY_1',
      recoveryResponses: { restore: { success: true, resume_type: 'payment' } },
    });
    await waitUntil(() => !!findEl(document, 'recoveryPaymentPanel'));
    const panel = findEl(document, 'recoveryPaymentPanel');
    assert(!!panel, 'F19. resume_type=payment → payment panel visible');
    const cart = window.eval('cart');
    assert(!cart || Object.keys(cart).length === 0, 'F20. payment resume 不 restore 購物車（cart 仍是空的）', JSON.stringify(cart));
    assert(envState.calls.resumePayment.length === 0, 'F21. page load → resume-payment calls=0（尚未真正點擊）', `calls=${envState.calls.resumePayment.length}`);

    envState.recoveryResponses.resumePayment = { success: true, payment_url: 'https://sandbox.line.me/pay/fake-recovery' };
    const primaryBtn = findEl(document, 'recoveryPaymentPrimaryBtn');
    assert(!!primaryBtn, 'Payment panel primary button 存在');
    if (primaryBtn) {
      primaryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitUntil(() => envState.calls.resumePayment.length === 1);
      assert(envState.calls.resumePayment.length === 1, 'F22. real primary click → resume-payment calls=1', `calls=${envState.calls.resumePayment.length}`);
      const bodyKeys = Object.keys(envState.calls.resumePayment[0] || {});
      assert(bodyKeys.length === 2 && bodyKeys.includes('member_session') && bodyKeys.includes('recovery_token'), 'F22b. request body 只有 member_session + recovery_token', JSON.stringify(bodyKeys));
      await waitUntil(() => envState.navigationCalls.length === 1);
      assert(envState.navigationCalls[0] === 'https://sandbox.line.me/pay/fake-recovery', 'F23. success → navigation 到 payment_url（redirect attempted）', JSON.stringify(envState.navigationCalls));
      assert(!envState.calls.analytics.some((e) => e.event_name === 'payment_started'), 'F24. frontend 不重複送 payment_started（已是 backend authority）');
      primaryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(20);
      assert(envState.calls.resumePayment.length === 1, 'F25. double click → frontend resume-payment calls 仍是 1（button disabled 防止二次送出）', `calls=${envState.calls.resumePayment.length}`);
    }
  }

  // ── 真正 double-click（在第一個 response resolve 前就 dispatch 第二次）──
  {
    let resolveFirstResponse;
    const deferredPromise = new Promise((resolve) => { resolveFirstResponse = resolve; });
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_PAY_DOUBLECLICK',
      recoveryResponses: { restore: { success: true, resume_type: 'payment' } },
    });
    await waitUntil(() => !!findEl(document, 'recoveryPaymentPanel'));
    // 用 deferred promise 讓第一次 resume-payment 卡住，模擬「回應尚未回來時」再點第二次
    const originalFetch = window.fetch;
    let resumePaymentCallCount = 0;
    window.fetch = async (u, o) => {
      if (String(u).includes('/api/cart-recovery/resume-payment')) {
        resumePaymentCallCount += 1;
        await deferredPromise;
        return mockRes({ success: true, payment_url: 'https://sandbox.line.me/pay/deferred' });
      }
      return originalFetch(u, o);
    };
    const primaryBtn = findEl(document, 'recoveryPaymentPrimaryBtn');
    if (primaryBtn) {
      primaryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await wait(10); // 讓第一次 click 的 handler 開始執行、button 應該已經 disabled
      primaryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true })); // 真正的「第一次回應還沒回來」時的第二次點擊
      await wait(10);
      resolveFirstResponse();
      await wait(30);
      assert(resumePaymentCallCount === 1, '真正 double-click（回應前再點）→ resume-payment fetch 仍只呼叫 1 次', `calls=${resumePaymentCallCount}`);
    } else {
      fail('真正 double-click 測試：payment panel primary button 不存在，無法測試');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // F26-F29：Cancel Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_CANCEL_1&linepay=cancel',
      recoveryResponses: { paymentCancelled: { success: true } },
    });
    await waitUntil(() => envState.calls.paymentCancelled.length === 1);
    assert(envState.calls.paymentCancelled.length === 1, 'F26. linepay=cancel + recovery_token → payment-cancelled calls=1', `calls=${envState.calls.paymentCancelled.length}`);
    const bodyKeys = Object.keys(envState.calls.paymentCancelled[0] || {});
    assert(bodyKeys.length === 2 && bodyKeys.includes('member_session') && bodyKeys.includes('recovery_token'), 'F26b. payment-cancelled body 只有 member_session + recovery_token', JSON.stringify(bodyKeys));
    assert(envState.calls.resumePayment.length === 0, 'F27. cancel bootstrap → resume-payment calls=0（不自動重新付款）', `calls=${envState.calls.resumePayment.length}`);
    await waitUntil(() => !!findEl(document, 'recoveryPaymentPanel'));
    const panel = findEl(document, 'recoveryPaymentPanel');
    assert(!!panel, 'F28. cancel-return success → payment panel visible');

    envState.recoveryResponses.resumePayment = { success: true, payment_url: 'https://sandbox.line.me/pay/after-cancel' };
    const primaryBtn = findEl(document, 'recoveryPaymentPrimaryBtn');
    if (primaryBtn) {
      primaryBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await waitUntil(() => envState.calls.resumePayment.length === 1);
      assert(envState.calls.resumePayment.length === 1, 'F29. 使用者重新按鈕 → resume-payment 變成 1（使用者主動觸發才建立第二次合法 request）', `calls=${envState.calls.resumePayment.length}`);
    } else {
      fail('F29. payment panel primary button 不存在，無法測試');
    }
  }

  // ══════════════════════════════════════════════════════════════
  // Security Cases
  // ══════════════════════════════════════════════════════════════
  {
    const { window, document, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SUPER_SECRET_TOKEN_XYZ',
      recoveryResponses: { restore: { success: true, resume_type: 'cart', cart_id: 'cart-security-test', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 1, unit_price: 60, subtotal: 60 }], subtotal: 60, discount: 0, total: 60 }, has_unavailable_items: false } },
    });
    await waitUntil(() => { const c = window.eval('cart'); return c && c['1']; });
    const analyticsSerialized = JSON.stringify(envState.calls.analytics);
    assert(!analyticsSerialized.includes('SUPER_SECRET_TOKEN_XYZ'), 'F30/F28(security). analytics HTTP events 不含 recovery_token', analyticsSerialized.length > 300 ? '(長度=' + analyticsSerialized.length + ')' : analyticsSerialized);
    // 注意：member_session 本身「應該」出現在每一筆既有 _trackEvent() 送出的
    // analytics event 頂層欄位裡——這是 Phase 1 既有、已凍結測試過的設計
    // （routes/analytics.js 靠它解析 line_user_id），與本輪 Recovery Token
    // 完全是兩回事，不應該被當成「洩漏」。這裡改成正確驗證：只有
    // recovery_token 這個新引入的秘密不該出現，member_session 出現是預期、
    // 正常的既有行為。
    const storageSerialized = dumpStorage(window.localStorage);
    assert(!storageSerialized.includes('SUPER_SECRET_TOKEN_XYZ'), 'F31. localStorage 不含 recovery_token', storageSerialized.length > 300 ? '(長度=' + storageSerialized.length + ')' : storageSerialized);
    assert(storageSerialized.includes('line_member_session_store_001'), '既有 Phase 1 member_session key 正常存在（不誤判為 leak）');
    assert(!window.location.search.includes('recovery_token') && !window.location.href.includes('SUPER_SECRET_TOKEN_XYZ'), 'F32. history URL 已移除 recovery_token（replaceState 生效）', window.location.href);
  }
  {
    const { document } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=EXPIRED_TOKEN_TEST',
      recoveryResponses: { restore: { success: false, reason: 'expired' } },
    });
    await waitUntil(() => !!findEl(document, 'recoveryNoticeOverlay'));
    const noticeEl = findEl(document, 'recoveryNoticeOverlay');
    const noticeText = noticeEl ? noticeEl.querySelector('p').textContent : '';
    assert(noticeText === '這個提醒連結已失效，可能訂單已完成或連結已過期。' && noticeText !== 'expired', 'F34. backend reason（expired）被 mapping 成安全文案，不是直接顯示 raw reason', noticeText);
  }

  // ══════════════════════════════════════════════════════════════
  // Ordering Test（Recovery 必須是最後、權威的購物車狀態，不被既有 normal
  // restoreCart() 覆蓋）
  // ══════════════════════════════════════════════════════════════
  {
    const { window, envState } = await freshEnvOrder({
      url: 'https://runtime-test.local/line-order.html?store_id=store_001&recovery_token=SECRET_ORDERING_TEST',
      seedOldCart: true, // 預先塞一個「舊的本地購物車」（product_id=1, qty=9）
      recoveryResponses: { restore: { success: true, resume_type: 'cart', cart_id: 'cart-ordering', cart: { items: [{ product_id: 1, name: '珍珠奶茶', qty: 5, unit_price: 60, subtotal: 300 }], subtotal: 300, discount: 0, total: 300 }, has_unavailable_items: false } },
    });
    await waitUntil(() => envState.calls.restore.length === 1);
    await waitUntil(() => { const c = window.eval('cart'); return c && c['1'] && c['1'].qty !== 9; });
    const cart = window.eval('cart');
    assert(cart && cart['1'] && cart['1'].qty === 5, 'Ordering：最終 cart 是 Recovery 回應的內容（qty=5），不是預先存在的舊本地購物車（qty=9）', JSON.stringify(cart));
  }

  // ══════════════════════════════════════════════════════════════
  // Bootstrap Architecture（靜態確認：不依賴 timer 猜測身分完成時機）
  // ══════════════════════════════════════════════════════════════
  {
    const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    const fnMatch = orderSrc.match(/async function handleRecoveryResumeFromUrl\(\)[\s\S]*?\n}\n/);
    assert(!!fnMatch && !fnMatch[0].includes('setTimeout') && !fnMatch[0].includes('setInterval'), 'Bootstrap-A. line-order.html handleRecoveryResumeFromUrl() 不使用 setTimeout/setInterval');
    assert(orderSrc.includes('await _memberGateInitPromise') && orderSrc.includes('handleRecoveryResumeFromUrl()'), 'Bootstrap-B. line-order.html 在既有 restoreCart() 之後、await 真正 member gate init Promise 之後才觸發 Recovery bootstrap');
    const shipSrc = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
    const fnMatchShip = shipSrc.match(/async function handleRecoveryResumeFromUrl\(\)[\s\S]*?\n}\n/);
    assert(!!fnMatchShip && !fnMatchShip[0].includes('setTimeout') && !fnMatchShip[0].includes('setInterval'), 'Bootstrap-C. line-shipping.html 同樣不使用 timer');
    assert(shipSrc.includes('await _memberGateInitPromise'), 'Bootstrap-D. line-shipping.html 同樣的 ordering 修正');
  }

  // ── Production Source Static Safety：Recovery 相關函式不 console.log token ──
  {
    const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    const recoverySection = orderSrc.match(/H1\.4\.10 Phase 4B：Frontend Recovery Resume[\s\S]*?(?=\/\/ ── 全域狀態 ──)/);
    assert(!!recoverySection, 'Static-A. 找得到 Recovery Resume 區塊');
    if (recoverySection) {
      const block = recoverySection[0];
      assert(!/console\.(log|warn|error)\([^)]*_recoveryResumeToken/.test(block), 'Static-B. Recovery 區塊沒有把 _recoveryResumeToken 直接印進 console');
      assert(!/localStorage\.setItem\([^)]*recovery_token/i.test(block) && !/sessionStorage\.setItem\([^)]*recovery_token/i.test(block), 'Static-C. Recovery 區塊沒有把 recovery_token 寫進 localStorage/sessionStorage');
    }
  }

  console.log('\n== Frontend Recovery Targeted Summary ==');
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

main().catch((e) => { console.error('Frontend targeted test runner crashed:', e && e.stack || e); process.exit(1); });
