#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-recovery-cart-frontend.js
// H1.4.12 Phase 3B — Popup Recovery Cart Restore, frontend jsdom suite.
'use strict';

const path = require('path');
const fs = require('fs');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public/line-order.html');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup recovery cart restore FRONTEND (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function createHarness(url, opts = {}) {
  const htmlSrc = fs.readFileSync(opts.htmlPath || HTML_PATH, 'utf8');
  const virtualConsole = new VirtualConsole();
  const jsErrors = [];
  virtualConsole.on('jsdomError', (e) => jsErrors.push(e.message));
  const calls = [];
  const timeoutIds = []; const intervalIds = [];
  const unhandled = [];
  const fetchImpl = opts.fetchImpl || ((u) => { calls.push(String(u)); return Promise.reject(new Error('no fixture for ' + u)); });
  const dom = new JSDOM(htmlSrc, {
    url, runScripts: 'dangerously', resources: undefined, virtualConsole,
    beforeParse(window) {
      try { window.crypto.subtle = require('crypto').webcrypto.subtle; window.TextEncoder = require('util').TextEncoder; } catch (e) {}
      window.fetch = (u, init) => { calls.push({ url: String(u), method: (init && init.method) || 'GET', body: init && init.body }); return fetchImpl(String(u), init); };
      window.WebSocket = class { constructor() { this.close = () => {}; this.send = () => {}; } };
      const origST = window.setTimeout.bind(window);
      const origSI = window.setInterval.bind(window);
      window.setTimeout = (fn, ms, ...a) => { const id = origST(fn, ms, ...a); timeoutIds.push(id); return id; };
      window.setInterval = (fn, ms, ...a) => { const id = origSI(fn, ms, ...a); intervalIds.push(id); return id; };
      window.addEventListener('error', (e) => unhandled.push('window error: ' + (e.message || '')));
      window.addEventListener('unhandledrejection', (e) => unhandled.push('window unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
      if (opts.presetSessionStorage) {
        for (const [k, v] of Object.entries(opts.presetSessionStorage)) {
          try { window.sessionStorage.setItem(k, v); } catch (e) {}
        }
      }
    },
  });
  const w = dom.window;
  try { w.eval('window.__testNavigatedTo = null; if (typeof _popupNavigateTo === "function") { _popupNavigateTo = (url) => { window.__testNavigatedTo = String(url); }; }'); } catch (e) {}
  if (opts.disableAutoRestore) {
    // 有些 case 需要在「session 載入完成、但 restore pipeline 還沒自動跑完」
    // 的那個時間點插入 storage mock，但 loadPopupDirectSession() 一旦偵測到
    // popupRecoveryContext.active 就會立刻自動觸發 triggerPopupCartRestoreFlow()
    // ——這個自動觸發本身在別的 case 已經測過（見「verified entry 成功啟動
    // restore」），這裡先暫時停用它，讓測試自己在正確時機呼叫
    // proceedWithPopupCartRestore()，之後再由測試自己還原。
    try { w.eval('window.__origTriggerPopupCartRestoreFlow = triggerPopupCartRestoreFlow; triggerPopupCartRestoreFlow = () => {};'); } catch (e) {}
  }
  return {
    dom, w, calls, jsErrors, unhandled,
    async settle(fn, { timeoutMs = 800, intervalMs = 15 } = {}) {
      const start = Date.now();
      while (Date.now() - start < timeoutMs) {
        let v; try { v = fn ? fn() : false; } catch (e) { v = false; }
        if (v) return true;
        await new Promise((r) => setTimeout(r, intervalMs));
      }
      return !fn;
    },
    cleanup() {
      try { timeoutIds.forEach((id) => { try { w.clearTimeout(id); } catch (e) {} }); } catch (e) {}
      try { intervalIds.forEach((id) => { try { w.clearInterval(id); } catch (e) {} }); } catch (e) {}
      try { dom.window.close(); } catch (e) {}
    },
  };
}
function assertNoUnexpectedErrors(ctx, label) {
  const unexpected = ctx.unhandled.concat(ctx.jsErrors.map((m) => 'jsdomError: ' + m));
  assert(unexpected.length === 0, `${label}-no-unexpected-exceptions 沒有未預期的 exception/rejection`, JSON.stringify(unexpected));
}
async function waitFor(fn, { timeoutMs = 1500, intervalMs = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let v; try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

function sessionFixture(overrides) {
  return {
    success: true,
    data: {
      public_code: 'sess-restore', name: 'RestoreSession', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00',
      place_name: 'P', address: 'A', address_note: '', product_scope: 'all_takeout',
      products: [
        { product_id: 301, name: '排骨飯', price: 120, quota_qty: null, remaining_qty: null, sold_out: false },
        { product_id: 302, name: '珍珠奶茶', price: 60, quota_qty: 3, remaining_qty: 3, sold_out: false },
      ],
      max_orders: null, order_count: null, payment_methods: ['cash'], effective_state: 'ordering_open', can_order: true,
      campaign: { public_code: 'camp-restore', name: 'C' },
      ...overrides,
    },
  };
}

// 建立一個「已經完成 handoff、即將載入 session」的 verified recovery entry harness。
async function createVerifiedEntryHarness(fetchImpl, opts = {}) {
  const ctx = await createHarness('http://localhost/popup-order?session=sess-restore&recovery_token=RAWTOK&recovery_handoff=HOFF1', { fetchImpl });
  // 直接注入一個「已通過驗證」的 handoff envelope（模擬 landing 階段已經完成，
  // 這裡只測 restore 邏輯本身，不重測上一輪已經驗證過的 handoff 機制）。
  await ctx.settle(() => ctx.w.eval('typeof createPopupRecoveryHandoff==="function"'), { timeoutMs: 300 });
  await ctx.w.eval("createPopupRecoveryHandoff('member-session-verified','sess-restore','RAWTOK').then(id => { window.__handoffId = id; })");
  await ctx.settle(() => ctx.w.eval('window.__handoffId') != null, { timeoutMs: 500 });
  const realHandoffId = ctx.w.eval('window.__handoffId');
  const handoffKey = ctx.w.eval(`popupRecoveryHandoffKey(${JSON.stringify(realHandoffId)})`);
  const handoffValue = ctx.w.sessionStorage.getItem(handoffKey);
  ctx.cleanup();
  // jsdom 的 sessionStorage 不會在不同 JSDOM 實例之間共用（模擬「同一分頁
  // navigation 後 sessionStorage 仍在」這件事，靠 presetSessionStorage 手動
  // 把剛剛那份 envelope 值複製進新視窗——這就是在模擬真實瀏覽器同源
  // navigation 時 sessionStorage 本來就會保留的行為）。
  const seed = {}; seed[handoffKey] = handoffValue;
  return createHarness(`http://localhost/popup-order?session=sess-restore&recovery_token=RAWTOK&recovery_handoff=${encodeURIComponent(realHandoffId)}`, {
    fetchImpl,
    presetSessionStorage: seed,
    disableAutoRestore: !!opts.disableAutoRestore,
  });
}

async function main() {
  // ══════════════════════════════════════════════════════════════
  // 一、Verified recovery entry 成功啟動 restore；prepare payload allowlist。
  // ══════════════════════════════════════════════════════════════
  {
    const posts = [];
    const fetchImpl = (u, init) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) { posts.push(JSON.parse(init.body)); return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT1', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 2 }], removed_items: [] } }) }); }
      if (url.includes('commit-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const settled = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(settled, '1-verified-entry-restores verified recovery entry 成功走完整個 restore 流程到 done', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(posts.length === 1, '1-prepare-called-once prepare 端點被呼叫一次', JSON.stringify(posts));
      const bodyKeys = Object.keys(posts[0]).sort();
      assert(JSON.stringify(bodyKeys) === JSON.stringify(['member_session', 'popup_session_public_code', 'recovery_token'].sort()), '1-prepare-allowlist prepare payload 只有 recovery_token/member_session/popup_session_public_code', JSON.stringify(bodyKeys));
      const savedRaw = ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore');
      assert(savedRaw && JSON.parse(savedRaw).items.some((it) => it.product_id === 301 && it.qty === 2), '1-cart-saved-correct-session 恢復的購物車正確寫入 session-specific key', String(savedRaw));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '1-verified-entry'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二、Ordinary popup entry 完全不呼叫 prepare/commit；standard 頁不呼叫 popup recovery API。
  // ══════════════════════════════════════════════════════════════
  {
    const calls = [];
    const fetchImpl = (u) => { calls.push(String(u)); if (String(u).includes('popup-session/sess-ordinary')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture({ public_code: 'sess-ordinary' }) }); return Promise.reject(new Error('unexpected')); };
    const ctx = await createHarness('http://localhost/popup-order?session=sess-ordinary', { fetchImpl });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assert(!calls.some((u) => u.includes('prepare-popup-restore') || u.includes('commit-popup-restore')), '2-ordinary-no-restore-calls 一般 popup entry 完全不呼叫 prepare/commit', JSON.stringify(calls));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '2-ordinary'); ctx.cleanup(); }
  }
  {
    const calls = [];
    const fetchImpl = (u) => { calls.push(String(u)); return Promise.reject(new Error('no fixture')); };
    const ctx = await createHarness('http://localhost/line-order.html', { fetchImpl });
    try {
      await ctx.settle(null, { timeoutMs: 300 });
      assert(!calls.some((u) => u.includes('prepare-popup-restore') || u.includes('commit-popup-restore') || u.includes('resolve-target') || u.includes('bootstrap-member')), '3-standard-no-popup-recovery-calls 標準 /line-order.html 不呼叫任何 popup recovery API', JSON.stringify(calls));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '3-standard'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 四、Prepare 失敗不覆蓋 cart。
  // ══════════════════════════════════════════════════════════════
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: false, status: 401, json: async () => ({ success: false, reason: 'prepare_failed' }) });
      return Promise.reject(new Error('unexpected'));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const settled = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(settled, '4-prepare-failure-stage prepare 失敗時 restore 進入 failed 狀態', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      const savedRaw2 = ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore');
      const savedItems2 = savedRaw2 ? JSON.parse(savedRaw2).items : [];
      assert(savedItems2.length === 0, '4-prepare-failure-no-cart-write prepare 失敗時沒有把任何恢復內容寫入 cart（一般 session 載入本身會存一個空 cart，這是正常行為，不是 restore 寫入的）', String(savedRaw2));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '4-prepare-failure'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 五、Invalid snapshot 顯示安全錯誤，不顯示空 cart 確認；valid_empty_after_reconcile 才顯示空 cart 確認。
  // ══════════════════════════════════════════════════════════════
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, reason: 'invalid_snapshot' }) });
      return Promise.reject(new Error('unexpected'));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const settled = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(settled, '5-invalid-snapshot-failed-stage invalid_snapshot 進入 failed（不是 empty-confirm）', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      const rootText = ctx.w.document.getElementById('popupRoot').textContent;
      assert(!rootText.includes('空購物車') && !rootText.includes('確認（空購物車）'), '5-invalid-snapshot-no-empty-confirm-ui invalid_snapshot 畫面不顯示任何「空購物車確認」文字/按鈕', rootText);
      assert(ctx.w.document.querySelector('#popupRoot button') !== null, '5-invalid-snapshot-has-retry invalid_snapshot 畫面仍提供重試按鈕', 'n/a');
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '5-invalid-snapshot'); ctx.cleanup(); }
  }
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-EMPTY', popup_session_public_code: 'sess-restore', cart_state: 'valid_empty_after_reconcile', items: [], removed_items: [{ product_id: 999, reason: 'unavailable' }] } }) });
      return Promise.reject(new Error('unexpected'));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const settled = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'empty-confirm', { timeoutMs: 1500 });
      assert(settled, '6-empty-after-reconcile-confirm-stage valid_empty_after_reconcile 進入 empty-confirm 狀態', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      const confirmBtn = ctx.w.document.querySelector('#popupRoot button[aria-label*="空購物車"]');
      assert(confirmBtn !== null, '6-empty-confirm-has-button 顯示明確的空購物車確認按鈕', 'not found');
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '6-empty-confirm'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 七/八：空 cart 未確認前不 commit；明確確認後才 commit。
  // ══════════════════════════════════════════════════════════════
  {
    let commitCalled = false;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-EMPTY2', popup_session_public_code: 'sess-restore', cart_state: 'valid_empty_after_reconcile', items: [], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) { commitCalled = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) }); }
      return Promise.reject(new Error('unexpected'));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'empty-confirm', { timeoutMs: 1500 });
      assert(commitCalled === false, '7-empty-not-auto-committed 未確認前不自動 commit', String(commitCalled));
      const confirmBtn = ctx.w.document.querySelector('#popupRoot button[aria-label*="空購物車"]');
      confirmBtn.click();
      const done = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(done && commitCalled === true, '8-empty-confirm-then-commit 明確點擊確認後才 commit 並完成', String({ done, commitCalled }));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '7-8-empty-confirm-commit'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 九～十三：既有非空 cart 顯示兩個按鈕；保留/使用恢復購物車兩條分支。
  // ══════════════════════════════════════════════════════════════
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      // 手動塞一個既有非空 popup cart。
      ctx.w.eval("savePopupCart('sess-restore', { schema_version:1, entry_context:'popup', session_public_code:'sess-restore', items:[{product_id:301,qty:1}], customer_name:'', customer_phone:'', payment_method:'', note:'' });");
      ctx.w.eval('triggerPopupCartRestoreFlow();');
      await ctx.settle(() => ctx.w.eval('popupRestoreUI.stage') === 'conflict', { timeoutMs: 500 });
      const buttons = [...ctx.w.document.querySelectorAll('#popupRoot button')];
      assert(buttons.length === 2, '9-existing-cart-two-buttons 既有非空 cart 顯示兩個真實按鈕', String(buttons.length));
      assert(ctx.w.eval('popupRestoreUI.stage') === 'conflict', '10-no-default-selection 呈現衝突選擇畫面後，狀態停在 conflict，沒有自動選擇任何一邊', ctx.w.eval('popupRestoreUI.stage'));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '9-10-existing-cart-conflict'); ctx.cleanup(); }
  }
  {
    // 選「保留目前購物車」：cart 不變、不 commit、可重試。
    let commitCalled = false;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('commit-popup-restore')) { commitCalled = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) }); }
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("savePopupCart('sess-restore', { schema_version:1, entry_context:'popup', session_public_code:'sess-restore', items:[{product_id:301,qty:1}], customer_name:'', customer_phone:'', payment_method:'', note:'' });");
      ctx.w.eval('triggerPopupCartRestoreFlow();');
      await ctx.settle(() => ctx.w.eval('popupRestoreUI.stage') === 'conflict', { timeoutMs: 500 });
      const keepBtn = ctx.w.document.querySelector('#popupRoot button[aria-label*="保留"]');
      keepBtn.click();
      await ctx.settle(() => ctx.w.eval('popupRestoreUI.stage') === 'idle', { timeoutMs: 500 });
      const cartAfter = JSON.parse(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore'));
      assert(cartAfter.items.length === 1 && cartAfter.items[0].product_id === 301, '12-keep-existing-cart-unchanged 選「保留目前購物車」後 cart 內容不變', JSON.stringify(cartAfter));
      assert(commitCalled === false, '12-keep-existing-no-commit 選保留時不 commit', String(commitCalled));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '12-keep-existing'); ctx.cleanup(); }
  }
  {
    // 選「使用恢復的購物車」：精確覆蓋該 session cart，不碰其他 session/general cart。
    const fetchImpl = (u, init) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-OVERWRITE', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 302, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("savePopupCart('sess-restore', { schema_version:1, entry_context:'popup', session_public_code:'sess-restore', items:[{product_id:301,qty:1}], customer_name:'', customer_phone:'', payment_method:'', note:'' });");
      ctx.w.localStorage.setItem('line_popup_cart_v1_sess-OTHER', JSON.stringify({ items: [{ product_id: 1, qty: 9 }] }));
      ctx.w.localStorage.setItem('line_order_cart_store_001', JSON.stringify({ some: 'general-cart' }));
      ctx.w.eval('triggerPopupCartRestoreFlow();');
      await ctx.settle(() => ctx.w.eval('popupRestoreUI.stage') === 'conflict', { timeoutMs: 500 });
      const useBtn = ctx.w.document.querySelector('#popupRoot button[aria-label*="使用恢復"]');
      useBtn.click();
      const done = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(done, '13-use-recovered-completes 選「使用恢復的購物車」成功完成', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      const cartAfter = JSON.parse(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore'));
      assert(cartAfter.items.length === 1 && cartAfter.items[0].product_id === 302, '13-use-recovered-overwrites 精確覆蓋該 session cart（302 取代 301）', JSON.stringify(cartAfter));
      assert(JSON.parse(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-OTHER')).items[0].product_id === 1, '13-other-session-untouched 不碰其他 session 的 cart', 'n/a');
      assert(JSON.parse(ctx.w.localStorage.getItem('line_order_cart_store_001')).some === 'general-cart', '13-general-cart-untouched 不碰一般 cart', 'n/a');
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '13-use-recovered'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 十四/十五：Server qty 只能被 client 降低/刪除，不能增加；fresh 移除的商品不會被重新加入。
  // ══════════════════════════════════════════════════════════════
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture({ products: [{ product_id: 301, name: '排骨飯', price: 120, quota_qty: null, remaining_qty: null, sold_out: false }, { product_id: 302, name: '珍珠奶茶', price: 60, quota_qty: 1, remaining_qty: 1, sold_out: false }] }) });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-CLAMP', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 302, qty: 5 }, { product_id: 999, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const done = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(done, '14-clamp-precondition restore 完成', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      const cartAfter = JSON.parse(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore'));
      const it302 = cartAfter.items.find((i) => i.product_id === 302);
      assert(it302 && it302.qty === 1, '14-qty-clamped-not-increased server 回傳 qty=5，但 fresh remaining_qty=1，client 端只能降低不能增加，最終是 1', JSON.stringify(cartAfter));
      assert(!cartAfter.items.some((i) => i.product_id === 999), '15-unlisted-product-not-added product 999 不在 fresh products 清單中，不會被加入 cart', JSON.stringify(cartAfter.items));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '14-15-clamp'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 十六～十八：Storage write throw／read-back malformed／read-back 值不一致 → 不 commit。
  // ══════════════════════════════════════════════════════════════
  {
    let commitCalled = false;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-STORAGE-FAIL', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) { commitCalled = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) }); }
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl, { disableAutoRestore: true });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("_popupStorageSetItem = () => { throw new Error('storage full'); };");
      ctx.w.eval('proceedWithPopupCartRestore();');
      const failed = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed' || ctx.w.eval('popupRestoreUI.stage') === 'commit-failed', { timeoutMs: 1500 });
      assert(failed, '16-storage-write-throw-fails localStorage.setItem 丟例外時，restore 不會顯示成功', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(commitCalled === false, '16-storage-write-throw-no-commit storage 寫入失敗時不 commit', String(commitCalled));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '16-storage-throw'); ctx.cleanup(); }
  }
  {
    let commitCalled = false;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-READBACK-BAD', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) { commitCalled = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) }); }
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl, { disableAutoRestore: true });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      // 用新的 seam 精確注入：set 照常成功寫入真正的值，但 get 永遠回傳另一份
      // 不同內容的合法 JSON（模擬 read-back 值不一致，例如被瀏覽器擴充功能
      // 或其他分頁改掉）。
      ctx.w.eval(`
        _popupStorageGetItem = (k) => {
          if (k === popupCartStorageKey('sess-restore')) return JSON.stringify({ schema_version:1, entry_context:'popup', session_public_code:'sess-restore', items:[{product_id:999,qty:99}], customer_name:'', customer_phone:'', payment_method:'', note:'' });
          return window.localStorage.getItem(k);
        };
      `);
      ctx.w.eval('proceedWithPopupCartRestore();');
      const failed = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(failed, '18-readback-mismatch-fails 寫入後讀回的值跟預期不一致時，restore 標示失敗', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(commitCalled === false, '18-readback-mismatch-no-commit 讀回不一致時不 commit', String(commitCalled));
      assert(ctx.w.eval('popupRestoreUI.preparedReceipt') === 'RECEIPT-READBACK-BAD', '18-readback-mismatch-keeps-receipt 保留同一張 receipt 供重試', ctx.w.eval('popupRestoreUI.preparedReceipt'));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '18-readback-mismatch'); ctx.cleanup(); }
  }
  {
    // Read-back malformed JSON：get 回傳不合法 JSON，不得讓整個 suite crash。
    let commitCalled = false;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-READBACK-MALFORMED', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) { commitCalled = true; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) }); }
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl, { disableAutoRestore: true });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("_popupStorageGetItem = (k) => { if (k === popupCartStorageKey('sess-restore')) return '{not valid json'; return window.localStorage.getItem(k); };");
      ctx.w.eval('proceedWithPopupCartRestore();');
      const failed = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(failed, '20-readback-malformed-fails 讀回不合法 JSON 時，restore 標示失敗（不 crash）', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(commitCalled === false, '20-readback-malformed-no-commit 讀回不合法 JSON 時不 commit', String(commitCalled));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '20-readback-malformed'); ctx.cleanup(); }
  }
  {
    // Rollback 驗證：storage 寫入失敗後，key 必須恢復成寫入前的原始狀態（這個 session 原本沒有 cart，寫入前也不存在，所以 rollback 後應該仍是「不存在」）。
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-ROLLBACK', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl, { disableAutoRestore: true });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assert(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore') === null || JSON.parse(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore')).items.length === 0, 'rollback-precondition 這個 session 一開始沒有已存在的購物車內容', String(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore')));
      ctx.w.eval("_popupStorageSetItem = () => { throw new Error('forced storage failure'); };");
      ctx.w.eval('proceedWithPopupCartRestore();');
      await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      const afterRollback = ctx.w.localStorage.getItem('line_popup_cart_v1_sess-restore');
      const afterRollbackItems = afterRollback ? JSON.parse(afterRollback).items : [];
      assert(afterRollbackItems.length === 0, 'rollback-storage-restored storage 寫入失敗後，rollback 正確恢復到寫入前的狀態（沒有殘留恢復的商品）', String(afterRollback));
      assert(ctx.w.eval('popupCart.items.length') === 0, 'rollback-runtime-restored runtime popupCart 也正確 rollback', String(ctx.w.eval('popupCart.items.length')));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, 'rollback'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二十／二十一：Commit network failure 保留 receipt 並顯示 retry；retry 使用同一 receipt，不重新 prepare。
  // ══════════════════════════════════════════════════════════════
  {
    let prepareCalls = 0; let commitCalls = 0;
    let commitShouldFail = true;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) { prepareCalls += 1; return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-RETRY', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) }); }
      if (url.includes('commit-popup-restore')) {
        commitCalls += 1;
        if (commitShouldFail) return Promise.reject(new Error('network down'));
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      }
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      const commitFailedStage = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'commit-failed' || ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(commitFailedStage, '20-commit-network-failure-retry-stage commit network failure 時進入可重試狀態', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(prepareCalls === 1, '20-precondition-one-prepare 到目前為止只 prepare 過一次', String(prepareCalls));
      commitShouldFail = false;
      const retryBtn = ctx.w.document.querySelector('#popupRoot button[aria-label*="重新嘗試"]') || ctx.w.document.querySelector('#popupRoot button');
      retryBtn.click();
      const done = await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(done, '21-retry-uses-same-receipt-succeeds retry 成功完成', ctx.w.eval('JSON.stringify(popupRestoreUI)'));
      assert(prepareCalls === 1, '21-retry-no-reprepare retry 沒有重新呼叫 prepare（沿用同一張 receipt）', String(prepareCalls));
      assert(commitCalls === 2, '21-retry-calls-commit-again retry 呼叫了 commit 第二次（用同一張 receipt）', String(commitCalls));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '20-21-retry'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二十四：Double-click 最多一條 prepare/commit pipeline。
  // ══════════════════════════════════════════════════════════════
  {
    let prepareCalls = 0;
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) { prepareCalls += 1; return new Promise((resolve) => setTimeout(() => resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'RECEIPT-DBL', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) }), 100)); }
      if (url.includes('commit-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      // 快速連續呼叫兩次（模擬 double-click 觸發的邏輯路徑）。
      ctx.w.eval('proceedWithPopupCartRestore(); proceedWithPopupCartRestore();');
      await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      assert(prepareCalls === 1, '24-double-click-single-pipeline 連續呼叫兩次只產生一次真正的 prepare pipeline', String(prepareCalls));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '24-double-click'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 二十七/二十八/二十九/三十：XSS inert；currentMode 未新增 popup；不觸發 begin_checkout；不碰 general cartUIStage。
  // ══════════════════════════════════════════════════════════════
  {
    const xssPayload = '<img src=x onerror="window.__cartXss=true">';
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture({ removed_items_test: xssPayload }) });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: false, status: 400, json: async () => ({ success: false, reason: xssPayload }) });
      return Promise.reject(new Error('unexpected'));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'failed', { timeoutMs: 1500 });
      assert(!ctx.w.eval('window.__cartXss'), '27-xss-inert XSS payload（即使出現在 reason 欄位）不會被執行', String(ctx.w.eval('window.__cartXss')));
      assert(ctx.w.eval('currentMode') === 'takeout' || ctx.w.eval('currentMode') === 'delivery', '28-current-mode-unchanged currentMode 全程未被設成 popup', ctx.w.eval('currentMode'));
      assert(ctx.w.eval('typeof begin_checkout') === 'undefined', '29-no-begin-checkout 沒有出現 begin_checkout', ctx.w.eval('typeof begin_checkout'));
      assert(ctx.w.eval('cartUIStage') === 'cart', '30-general-cartuistage-untouched 一般 cartUIStage 未被觸碰', ctx.w.eval('cartUIStage'));
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '27-30-xss-mode-checkout'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════
  // 三十二：Token/member session/receipt 不進 DOM／URL。
  // ══════════════════════════════════════════════════════════════
  {
    const fetchImpl = (u) => {
      const url = String(u);
      if (url.includes('popup-session/sess-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => sessionFixture() });
      if (url.includes('prepare-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { restore_receipt: 'SECRET-RECEIPT-VALUE', popup_session_public_code: 'sess-restore', cart_state: 'valid_non_empty', items: [{ product_id: 301, qty: 1 }], removed_items: [] } }) });
      if (url.includes('commit-popup-restore')) return Promise.resolve({ ok: true, status: 200, json: async () => ({ success: true, data: { consumed: true } }) });
      return Promise.reject(new Error('unexpected: ' + url));
    };
    const ctx = await createVerifiedEntryHarness(fetchImpl);
    try {
      await waitFor(() => ctx.w.eval('popupRestoreUI.stage') === 'done', { timeoutMs: 1500 });
      const domHtml = ctx.w.document.documentElement.innerHTML;
      assert(!domHtml.includes('SECRET-RECEIPT-VALUE') && !domHtml.includes('RAWTOK') && !domHtml.includes('member-session-verified'), '32-no-secrets-in-dom receipt/token/member session 不出現在 DOM', 'n/a');
      assert(!ctx.w.location.href.includes('SECRET-RECEIPT-VALUE') && !ctx.w.location.href.includes('member-session-verified'), '32-no-secrets-in-url receipt/member session 不出現在 URL', ctx.w.location.href);
    } finally { await ctx.settle(null, { timeoutMs: 200 }); assertNoUnexpectedErrors(ctx, '32-no-secrets'); ctx.cleanup(); }
  }
}

main().then(printSummary).catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
