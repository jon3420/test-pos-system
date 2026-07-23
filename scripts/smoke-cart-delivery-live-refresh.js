#!/usr/bin/env node
// scripts/smoke-cart-delivery-live-refresh.js — C4
//
// 涵蓋需求文件十六：商品增加／減少／推薦加購後，購物車商品、小計、滿額進度、
// 外送費必須在購物車仍開啟時即時更新，不得等到關閉重開或送出訂單。
//
// 做法：直接從 public/line-order.html 原始檔案「抽取」本次新增/修改的實際函式原始碼
// （hasValidDeliveryLocation／setDeliveryFeePending／scheduleDeliveryFeeRefresh／
// refreshCartAfterMutation／fetchDeliveryFee／getCartProductSubtotal），在 vm sandbox
// 內用假的 apiFetch／document／timer 執行，驗證的是「這次真的改出來的那份程式碼」，
// 不是另外重寫一份簡化邏輯來測試，避免測試與實際 UI 行為漂移。
//
// 誠實揭露：line-order.html 是內嵌在 HTML 頁面中的 script，並非獨立模組，仍有大量
// 其他函式（renderCartItems 實際 DOM 內容、真正的 fetch 網路層、Google Maps
// Autocomplete、真實瀏覽器 debounce 計時精準度）本測試以 mock 取代，無法在沙盒環境
// 完整驗證，標記為 MANUAL REQUIRED，需要真機/瀏覽器交叉測試。
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ROOT = path.join(__dirname, '..');
const SRC = fs.readFileSync(path.join(ROOT, 'public', 'line-order.html'), 'utf8');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

// ── 抽取原始碼區塊（用函式名稱定位起點，用下一個已知函式名稱定位終點，
//    確保抽出來的就是目前實際檔案裡的那段程式碼，而不是憑印象複製）──────────
function extractBlock(src, startMarker, endMarker) {
  const s = src.indexOf(startMarker);
  if (s === -1) throw new Error(`找不到起點標記：${startMarker}`);
  const e = src.indexOf(endMarker, s + startMarker.length);
  if (e === -1) throw new Error(`找不到終點標記：${endMarker}`);
  return src.slice(s, e);
}

const getCartProductSubtotalSrc = extractBlock(
  SRC,
  'function getCartProductSubtotal(){',
  '// fix18-10-hotfix26-F8-B'
);
const cartDeliverySyncSrc = extractBlock(
  SRC,
  'function hasValidDeliveryLocation(){',
  '// ═══════════════════════════════════════════════════════'
);
const fetchDeliveryFeeSrc = extractBlock(SRC, 'async function fetchDeliveryFee(){', '\n// 使用目前位置');

['function hasValidDeliveryLocation(){', 'function setDeliveryFeePending(){', 'function scheduleDeliveryFeeRefresh(){', 'function refreshCartAfterMutation(){']
  .forEach((marker) => {
    if (!cartDeliverySyncSrc.includes(marker)) throw new Error(`抽取範圍未包含預期函式：${marker}`);
  });

// ── vm sandbox：模擬 fetchDeliveryFee()/scheduleDeliveryFeeRefresh() 依賴的全域狀態 ──
function makeSandbox({ fetchImpl } = {}) {
  const timers = []; // { id, fn, delay }
  let timerSeq = 0;
  const cartSheetEl = { _show: false, classList: { contains: (c) => c === 'show' && cartSheetEl._show } };
  const renderCartItemsCalls = [];
  const updateCartTotalsCalls = [];

  const sandbox = {
    console,
    // ── 全域狀態（沿用 line-order.html 實際變數名稱）──
    cart: {},
    currentMode: 'delivery',
    deliveryLatLng: { lat: null, lng: null },
    _deliveryFeeResult: null,
    deliveryFeeCalculated: false,
    calcDeliveryFee: 0,
    deliveryDistKm: 0,
    _lastDeliveryRawFee: null,
    _lastFreeShippingReason: null,
    _lastIsFreeDelivery: null,
    _deliveryOutOfRange: false,
    fulfillmentRenderToken: 0,
    // ── 依賴函式 mock ──
    getCartProductSubtotal: null, // 稍後注入抽出來的真實原始碼
    apiFetch: (url, opts) => (fetchImpl ? fetchImpl(url, opts) : Promise.reject(new Error('no fetchImpl'))),
    syncFulfillmentContext: () => {},
    updateCartTotals: () => { updateCartTotalsCalls.push(1); },
    renderCartItems: () => { renderCartItemsCalls.push(1); },
    document: {
      getElementById: (id) => (id === 'cartSheet' ? cartSheetEl : { style: {}, textContent: '', innerHTML: '' }),
    },
    setTimeout: (fn, delay) => { const id = ++timerSeq; timers.push({ id, fn, delay, fired: false }); return id; },
    clearTimeout: (id) => { const t = timers.find((x) => x.id === id); if (t) t.fired = true; /* 標記已取消 */ },
  };
  sandbox.global = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(getCartProductSubtotalSrc, sandbox);
  vm.runInContext(cartDeliverySyncSrc, sandbox);
  vm.runInContext(fetchDeliveryFeeSrc, sandbox);

  return {
    sandbox,
    cartSheetEl,
    renderCartItemsCalls,
    updateCartTotalsCalls,
    // 手動推進「debounce 到期」：找出尚未被 clearTimeout 標記取消、且尚未執行過的最新一顆 timer 觸發
    flushLatestTimer() {
      const pending = timers.filter((t) => !t.fired);
      if (!pending.length) return false;
      const t = pending[pending.length - 1];
      t.fired = true;
      t.fn();
      return true;
    },
  };
}

// ── 1. 減少後失去免運：_deliveryFeeResult 必須被清空進入 pending，不得沿用舊 reached ──
(function () {
  console.log('\n[1] 商品減少後，pending 狀態清空舊的「已達免運」結果');
  const { sandbox, updateCartTotalsCalls } = makeSandbox();
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } }; // 減少後只剩 NT$150
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };
  // 減少前殘留的舊結果（NT$300 時算出的免運）
  sandbox._deliveryFeeResult = { threshold: 300, mode: 'full', rawFee: 50, finalFee: 0, discount: 50, reached: true, remaining: 0, outOfRange: false };
  sandbox.deliveryFeeCalculated = true;

  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox);

  assert(sandbox._deliveryFeeResult === null, '_deliveryFeeResult 被清空進入 pending（不再沿用 reached:true）');
  assert(sandbox.deliveryFeeCalculated === false, 'deliveryFeeCalculated 被設回 false（送單按鈕會被既有 submitOrder 檢查擋下）');
  assert(updateCartTotalsCalls.length >= 1, 'pending 狀態已呼叫 updateCartTotals() 讓畫面立即反映（不必等 API 回來）');
})();

// ── 2. 加購後達標：debounce 到期後打 API，套用最新結果 ──
(function () {
  console.log('\n[2] 加購達標：購物車立即 render＋debounce 到期後打 API，finalFee 變成 0，進度 100%');
  const { sandbox, cartSheetEl, flushLatestTimer, renderCartItemsCalls } = makeSandbox({
    fetchImpl: async () => ({
      json: async () => ({
        success: true, raw_fee: 50, delivery_fee: 0, delivery_discount: 50,
        is_free_delivery: true, free_rule_type: 'full', free_threshold: 300,
        remaining_for_free_delivery: 0, free_rule_applied: true,
        distance_km: 2.1, matched_max_km: 3, out_of_range: false, message: '滿額免運',
      }),
    }),
  });
  cartSheetEl._show = true;
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 }, 2: { product: { id: 2, price: 150 }, qty: 1 } };
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };

  vm.runInContext('refreshCartAfterMutation()', sandbox);
  assert(renderCartItemsCalls.length === 1, '購物車開啟時，refreshCartAfterMutation() 立即呼叫 renderCartItems()（Bug 2 修正）');
  const didFire = flushLatestTimer();
  assert(didFire, 'debounce timer 確實被排入（150ms 後應觸發 fetchDeliveryFee）');

  // fetchDeliveryFee 是 async；等待其內部 await 完成
  return new Promise((resolve) => setImmediate(() => {
    assert(sandbox.deliveryFeeCalculated === true, 'API 回應後 deliveryFeeCalculated 恢復 true');
    assert(sandbox._deliveryFeeResult && sandbox._deliveryFeeResult.finalFee === 0, 'finalFee 套用最新結果（達標後為 0）');
    assert(sandbox._deliveryFeeResult && sandbox._deliveryFeeResult.reached === true, 'reached 套用最新結果（true）');
    resolve();
  }));
})();

// ── 3. 快速連點競態：舊回應不得覆蓋新回應（fetchDeliveryFee 既有 fulfillmentRenderToken 序號保護）──
(function () {
  console.log('\n[3] 快速連點競態：150 → 300 → 150，最後必須用最後一次 150 的結果');
  const responses = {
    150: { delivery_fee: 50, raw_fee: 50, delivery_discount: 0, free_rule_applied: false, remaining_for_free_delivery: 150, free_threshold: 300 },
    300: { delivery_fee: 0, raw_fee: 50, delivery_discount: 50, free_rule_applied: true, remaining_for_free_delivery: 0, free_threshold: 300 },
  };
  const pendingResolvers = [];
  const { sandbox } = makeSandbox({
    fetchImpl: (url, opts) => {
      const body = JSON.parse(opts.body);
      return new Promise((resolve) => {
        pendingResolvers.push(() => resolve({ json: async () => ({ success: true, is_free_delivery: body.subtotal === 300, free_rule_type: 'full', distance_km: 2, matched_max_km: 3, out_of_range: false, message: '', ...responses[body.subtotal] }) }));
      });
    },
  });
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };

  // request A：150（觸發，先不 resolve）
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } };
  vm.runInContext('fetchDeliveryFee()', sandbox);
  // request B：300（觸發，先不 resolve；token 前進，A 已經過期）
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 }, 2: { product: { id: 2, price: 150 }, qty: 1 } };
  vm.runInContext('fetchDeliveryFee()', sandbox);
  // request C：150（觸發，先不 resolve；token 再前進，A、B 都過期）
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } };
  vm.runInContext('fetchDeliveryFee()', sandbox);

  // 刻意讓 B 最後才 resolve（模擬「較舊的請求較慢回來」），順序：C 先回來，B 最後回來
  return new Promise((resolve) => {
    setImmediate(() => {
      pendingResolvers[2](); // C（最新，150）先回來
      pendingResolvers[1](); // B（較舊，300）最後回來——必須被 token 檔掉，不得覆蓋
      pendingResolvers[0](); // A（最舊，150 但已過期）
      setImmediate(() => {
        assert(sandbox._deliveryFeeResult && sandbox._deliveryFeeResult.finalFee === 50, '最終 finalFee 必須是最後一次(C, 150)的結果 50，不被較舊的 B(300→0) 覆蓋', JSON.stringify(sandbox._deliveryFeeResult));
        resolve();
      });
    });
  });
})();

// ── 4. 刪除最後一件商品：subtotal 歸零，非外送模式/無地址時不打 API，直接 fallback ──
(function () {
  console.log('\n[4] 刪除最後一件商品後（外送模式、地址有效）：清空舊結果並排入重算');
  const { sandbox } = makeSandbox();
  sandbox.cart = {}; // 已清空
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };
  sandbox._deliveryFeeResult = { threshold: 300, finalFee: 0, reached: true, outOfRange: false };
  sandbox.deliveryFeeCalculated = true;

  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox);
  assert(sandbox._deliveryFeeResult === null, '購物車清空後，不得繼續顯示舊的「已達免運」結果');
})();

// ── 5. 外帶模式：商品加減不得呼叫外送費 API ──
(function () {
  console.log('\n[5] 外帶模式下商品異動：不觸發外送費 API');
  let apiCalled = false;
  const { sandbox } = makeSandbox({ fetchImpl: async () => { apiCalled = true; return { json: async () => ({ success: true }) }; } });
  sandbox.currentMode = 'takeout';
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 }; // 即使先前選過外送地址
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 2 } };

  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox);
  assert(!apiCalled, '外帶模式下 scheduleDeliveryFeeRefresh() 不得呼叫 fetchDeliveryFee()/API');
  assert(sandbox.deliveryLatLng.lat === 25.03, '外帶模式下不清除已保存的外送地址座標（供切回外送沿用）');
})();

// ── 6. 無有效地址：商品加減更新小計，但不得使用舊 finalFee（沿用 pending 清空邏輯）──
(function () {
  console.log('\n[6] 外送模式但地址尚未選好座標：不得沿用舊 finalFee，也不呼叫 API');
  let apiCalled = false;
  const { sandbox } = makeSandbox({ fetchImpl: async () => { apiCalled = true; return { json: async () => ({ success: true }) }; } });
  sandbox.currentMode = 'delivery';
  sandbox.deliveryLatLng = { lat: null, lng: null };
  sandbox._deliveryFeeResult = { threshold: 300, finalFee: 0, reached: true, outOfRange: false }; // 殘留舊結果
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } };

  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox);
  assert(!apiCalled, '無有效地址座標時不呼叫 API（沒有後端結果可算）');
})();

// ── 7. 重算中禁止送單（既有 submitOrder() 的 deliveryFeeCalculated 檢查）─────
(function () {
  console.log('\n[7] 重算中 deliveryFeeCalculated===false（送單需由既有 submitOrder() 擋下）');
  const submitOrderSrc = extractBlock(SRC, 'if(!deliveryFeeCalculated){toast(', ';return;}');
  assert(
    submitOrderSrc.includes("toast('請稍候，外送費計算中…')"),
    'submitOrder() 仍保留既有「外送費計算中」阻擋文案，重算期間 deliveryFeeCalculated=false 會被此檢查擋下送單'
  );
  manual('7b 真實點擊「送出訂單」按鈕反應', '需在瀏覽器/真機驗證 disabled 狀態與 toast 顯示時機是否符合體感');
})();

// ── 8. Regression：refreshCartAfterMutation() 未改變既有 updateBar()/persistCart() 呼叫順序 ──
(function () {
  console.log('\n[8] Regression：addCart/chgQty/removeCartItem 仍先呼叫既有 updateBar()/persistCart()，才呼叫新入口');
  const fns = [
    { name: 'addCart', body: extractBlock(SRC, 'function addCart(id,evt){', 'function addPreorderToCart') },
    { name: 'chgQty', body: extractBlock(SRC, 'function chgQty(id,d){', 'function updateProductCard') },
    { name: 'removeCartItem', body: extractBlock(SRC, 'function removeCartItem(id){', 'function reconcileFulfillmentMode') },
  ];
  fns.forEach(({ name, body }) => {
    assert(body.includes('persistCart();') && body.includes('refreshCartAfterMutation();'), `${name}() 同時保留 persistCart() 與新的 refreshCartAfterMutation() 呼叫`);
    const persistIdx = body.indexOf('persistCart();');
    const refreshIdx = body.indexOf('refreshCartAfterMutation();');
    assert(refreshIdx > persistIdx, `${name}() 內 refreshCartAfterMutation() 在 persistCart() 之後呼叫（不打亂既有儲存時機）`);
  });
})();

// ── 9. 300 → 150：finalFee 0 → 50（減少商品後重新試算） ──────────────────
(function () {
  console.log('\n[9] 300 → 150：finalFee 0 → 50');
  const { sandbox, flushLatestTimer } = makeSandbox({
    fetchImpl: async () => ({
      json: async () => ({
        success: true, raw_fee: 50, delivery_fee: 50, delivery_discount: 0,
        is_free_delivery: false, free_rule_type: 'full', free_threshold: 300,
        remaining_for_free_delivery: 150, free_rule_applied: false,
        distance_km: 2.1, matched_max_km: 3, out_of_range: false, message: '',
      }),
    }),
  });
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } }; // 減少後只剩 150
  sandbox._deliveryFeeResult = { threshold: 300, finalFee: 0, reached: true, outOfRange: false };
  sandbox.deliveryFeeCalculated = true;

  vm.runInContext('refreshCartAfterMutation()', sandbox);
  assert(sandbox._deliveryFeeResult === null, '減少後立即進入 pending，不沿用舊 finalFee:0');
  flushLatestTimer();
  return new Promise((resolve) => setImmediate(() => {
    assert(sandbox._deliveryFeeResult && sandbox._deliveryFeeResult.finalFee === 50, '重算後 finalFee 變成 50', JSON.stringify(sandbox._deliveryFeeResult));
    assert(sandbox._deliveryFeeResult.reached === false, '重算後 reached 變成 false');
    resolve();
  }));
})();

// ── 10. 購物車關閉時：不強制 render modal（一般加入購物車不必打開購物車）──────
(function () {
  console.log('\n[10] 購物車關閉時，refreshCartAfterMutation() 不呼叫 renderCartItems()');
  const { sandbox, renderCartItemsCalls, cartSheetEl } = makeSandbox({
    fetchImpl: async () => ({ json: async () => ({ success: true, raw_fee: 50, delivery_fee: 50, is_free_delivery: false, free_rule_type: 'full', free_threshold: 300, remaining_for_free_delivery: 150, free_rule_applied: false, distance_km: 2, matched_max_km: 3, out_of_range: false, message: '' }) }),
  });
  cartSheetEl._show = false; // 購物車關閉中
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } };

  vm.runInContext('refreshCartAfterMutation()', sandbox);
  assert(renderCartItemsCalls.length === 0, '購物車關閉時不強制 renderCartItems()（一般加入購物車不必打開購物車）');
})();

// ── 11. 清空購物車：取消尚未送出的 debounce（模擬 clearCartByUser() 內的清除邏輯）──
(function () {
  console.log('\n[11] 清空購物車：取消尚未送出的重算 debounce，並清除舊結果');
  let apiCalled = false;
  const { sandbox, flushLatestTimer } = makeSandbox({ fetchImpl: async () => { apiCalled = true; return { json: async () => ({ success: true }) }; } });
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } };

  // 步驟一：商品異動排入 debounce（尚未觸發）
  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox);
  // 步驟二：模擬 clearCartByUser() 收尾那段「取消 debounce + 清除舊結果」邏輯
  // （與 public/line-order.html 內 clearCartByUser() 實際呼叫的 API 完全相同：
  //  clearTimeout(_cartDeliveryRefreshTimer); _deliveryFeeResult=null; deliveryFeeCalculated=false;）
  vm.runInContext('clearTimeout(_cartDeliveryRefreshTimer); _deliveryFeeResult=null; deliveryFeeCalculated=false;', sandbox);
  sandbox.cart = {};

  const fired = flushLatestTimer();
  assert(!fired || !apiCalled, '清空購物車後，先前排入的 debounce 不再觸發配送 API', `fired=${fired} apiCalled=${apiCalled}`);
  assert(sandbox._deliveryFeeResult === null, '清空購物車後 _deliveryFeeResult 已清除');
  assert(sandbox.deliveryFeeCalculated === false, '清空購物車後 deliveryFeeCalculated 已清除');
})();

// ── 12. debounce collapse：快速連續呼叫三次 scheduleDeliveryFeeRefresh() 只送一次 API ──
(function () {
  console.log('\n[12] 快速連續呼叫 scheduleDeliveryFeeRefresh() 三次，只應真正送出最後一次 API');
  let apiCallCount = 0;
  const { sandbox, flushLatestTimer } = makeSandbox({
    fetchImpl: async (url, opts) => {
      apiCallCount++;
      const body = JSON.parse(opts.body);
      return { json: async () => ({ success: true, raw_fee: 50, delivery_fee: body.subtotal >= 300 ? 0 : 50, delivery_discount: body.subtotal >= 300 ? 50 : 0, is_free_delivery: body.subtotal >= 300, free_rule_type: 'full', free_threshold: 300, remaining_for_free_delivery: Math.max(300 - body.subtotal, 0), free_rule_applied: body.subtotal >= 300, distance_km: 2, matched_max_km: 3, out_of_range: false, message: '' }) };
    },
  });
  sandbox.deliveryLatLng = { lat: 25.03, lng: 121.56 };

  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } }; // 150
  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox); // 排入，尚未觸發
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 }, 2: { product: { id: 2, price: 150 }, qty: 1 } }; // 300
  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox); // 應取消前一顆，重新排入
  sandbox.cart = { 1: { product: { id: 1, price: 150 }, qty: 1 } }; // 150（最後一次）
  vm.runInContext('scheduleDeliveryFeeRefresh()', sandbox); // 應再次取消前一顆，重新排入

  const fired = flushLatestTimer(); // 只應剩下最後一顆計時器尚未被取消
  assert(fired, '最後一次排程的 debounce timer 有確實觸發');
  return new Promise((resolve) => setImmediate(() => {
    assert(apiCallCount === 1, `debounce 期間三次商品異動只應真正送出 1 次 API（實際 ${apiCallCount} 次）`);
    assert(sandbox._deliveryFeeResult && sandbox._deliveryFeeResult.finalFee === 50, '最終套用的是最後一次(150)的結果，finalFee=50', JSON.stringify(sandbox._deliveryFeeResult));
    resolve();
  }));
})();

// ── 13. 達標後推薦區隱藏／未達標後推薦區重新顯示（直接測試實際 renderDeliveryFreeRecommendations()）──
(function () {
  console.log('\n[13] renderDeliveryFreeRecommendations()：達標隱藏／未達標顯示');
  const recoSrc = extractBlock(SRC, 'function renderDeliveryFreeRecommendations(state) {', '\n// 統一調度入口');
  const wrap = { style: {}, };
  const list = { innerHTML: '' };
  const els = { deliveryFreeReco: wrap, deliveryFreeRecoList: list };
  const sandbox2 = {
    console,
    document: { getElementById: (id) => els[id] || null },
    allProducts: [
      { id: 1, effective_line_name: '珍珠奶茶', price: 60, show_on_line: true, sale_status: 'available', line_sold_out: 0 },
    ],
    _isRecommendableForFreeDelivery: () => true,
    _getRecommendPrice: (p) => p.price,
    esc: (s) => s,
  };
  vm.createContext(sandbox2);
  vm.runInContext(recoSrc, sandbox2);

  // 達標：state.reached === true → 必須隱藏
  vm.runInContext('renderDeliveryFreeRecommendations({visible:true, reached:true, isOutOfRange:false, remaining:0})', sandbox2);
  assert(wrap.style.display === 'none', '達標後 (reached:true) 推薦區被隱藏（display=none）');

  // 未達標：state.reached === false → 應重新顯示並列出候選商品
  vm.runInContext('renderDeliveryFreeRecommendations({visible:true, reached:false, isOutOfRange:false, remaining:60})', sandbox2);
  assert(wrap.style.display === '', '未達標後 (reached:false) 推薦區重新顯示（清除 display:none）');
  assert(list.innerHTML.includes('珍珠奶茶'), '未達標後推薦區重新 render 出候選商品');
})();

// ── 14. addCart() 只記錄一次 add_to_cart Analytics（不因同步流程重複觸發）────
(function () {
  console.log('\n[14] addCart() 只呼叫一次 _trackAddToCart()（靜態檢查，避免同步流程重複觸發）');
  const addCartSrc = extractBlock(SRC, 'function addCart(id,evt){', 'function addPreorderToCart');
  const matches = addCartSrc.match(/_trackAddToCart\(/g) || [];
  assert(matches.length === 1, `addCart() 內只呼叫一次 _trackAddToCart()（實際 ${matches.length} 次）`);
  assert(!addCartSrc.includes('refreshCartAfterMutation();\n  refreshCartAfterMutation();'), 'addCart() 沒有重複呼叫 refreshCartAfterMutation()（避免雙重刷新）');
  const refreshCount = (addCartSrc.match(/refreshCartAfterMutation\(\)/g) || []).length;
  assert(refreshCount === 1, `addCart() 只呼叫一次 refreshCartAfterMutation()（實際 ${refreshCount} 次）`);
})();

// ── 15. 靜態驗證：refreshCartAfterMutation() 不直接呼叫 fetchDeliveryFee()，避免繞過 debounce/pending ──
(function () {
  console.log('\n[15] refreshCartAfterMutation() 只呼叫 scheduleDeliveryFeeRefresh()，不直接呼叫 fetchDeliveryFee()');
  assert(!cartDeliverySyncSrc.match(/function refreshCartAfterMutation\(\)\{[^}]*fetchDeliveryFee/), 'refreshCartAfterMutation() 內未直接呼叫 fetchDeliveryFee()（一律經 scheduleDeliveryFeeRefresh() 的 debounce+pending）');
  assert(cartDeliverySyncSrc.includes('_cartDeliveryRefreshTimer'), 'scheduleDeliveryFeeRefresh() 使用單一共用的 debounce timer 變數（不會同時存在多顆計時器互相打架）');
})();


manual('16 手機瀏覽器真實網路延遲下的 debounce/loading 體感', '150ms debounce 與「計算外送費中…」文案切換節奏需要真機交叉測試');
manual('17 LINE Login 購物車還原後的即時重算', '需要實際 LIFF/LINE Login 環境驗證 restoreCart() 流程是否也觸發 scheduleDeliveryFeeRefresh()（本次未修改 restoreCart()，範圍外）');
manual('18 真實送單按鈕點擊體感', '需在瀏覽器/真機驗證 disabled 狀態切換與 toast 顯示時機是否符合體感');

setTimeout(() => {
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`\n═══ 總結：${passCount} PASS / ${failCount} FAIL / ${manualCount} MANUAL REQUIRED ═══`);
  if (failCount > 0) process.exit(1);
}, 300);
