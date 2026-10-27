#!/usr/bin/env node
// scripts/smoke-h1-4-12-popup-frontend.js
// H1.4.12 Phase 3B — popup frontend foundation smoke test.
//
// Runs public/line-order.html through a real jsdom harness (runScripts:
// 'dangerously'), stubbing fetch/WebSocket/timers via beforeParse (so the
// very first synchronous call made during script execution is captured too
// — stubbing after `new JSDOM()` returns is too late because init() already
// ran during construction). Every jsdom window created by this file is
// closed in a `finally`, every tracked timer is cleared before close, and
// no case relies on an external multi-minute timeout to end — each case
// waits on a short, bounded, polled completion condition.
'use strict';

const path = require('path');
const fs = require('fs');
const { webcrypto } = require('crypto');
const { JSDOM, VirtualConsole } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const HTML_PATH = path.join(ROOT, 'public/line-order.html');
// Committed, reproducible fixture path (was previously a private absolute
// path only present on one author's machine: /home/claude/work/pristine/base/...
// — that made this a non-reproducible test). See scripts/fixtures/README.md
// for the required provenance (origin checkpoint zip name/hash) that this
// file must be extracted from and hash-verified against before use.
const PRISTINE_HTML_PATH = path.join(__dirname, 'fixtures', 'phase3a4-pristine-line-order.html');
const PRISTINE_EXPECTED_SHA256 = 'f314269c197b7ef594a1457838e04a72693676ffcaa059ffce72ab33bfbf28cc';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log(`SMOKE TEST SUMMARY — H1.4.12 Phase 3B popup frontend foundation (TZ=${process.env.TZ || '(default)'})`);
  console.log(`  PASS: ${p}  FAIL: ${f}  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// ══════════════════════════════════════════════════════════════════════
// Harness
// ══════════════════════════════════════════════════════════════════════

function defaultFetchReject(calls) {
  return (u) => { calls.push(String(u)); return Promise.reject(new Error('no fixture registered for ' + u)); };
}

// Creates one jsdom window. `fetchImpl(urlStr, init)` decides the response;
// defaults to always-reject (so any unexpected call surfaces as a rejection,
// not a silent success). Every side-effecting global is stubbed inside
// beforeParse, i.e. before any inline <script> in the page has executed.
async function createHarness(url, opts = {}) {
  const htmlSrc = fs.readFileSync(opts.htmlPath || HTML_PATH, 'utf8');
  const virtualConsole = new VirtualConsole();
  const jsErrors = [];
  virtualConsole.on('jsdomError', (e) => jsErrors.push(e.message));
  const calls = [];
  let wsCount = 0;
  const wsUrls = [];
  const timeoutIds = [];
  const intervalIds = [];
  const unhandled = [];
  const fetchImpl = opts.fetchImpl || defaultFetchReject(calls);

  const dom = new JSDOM(htmlSrc, {
    url,
    runScripts: 'dangerously',
    resources: undefined,
    virtualConsole,
    pretendToBeVisual: true,
    beforeParse(window) {
      // Optional per-harness localStorage preload. Only runs when opts.initialLocalStorage is a non-null object;
      // when it is not passed this block is a no-op. It runs before any production script executes.
      if (opts.initialLocalStorage !== null && typeof opts.initialLocalStorage === 'object') {
        for (const [key, value] of Object.entries(opts.initialLocalStorage)) window.localStorage.setItem(key, value);
      }
      // jsdom 沒有內建 crypto.subtle／TextEncoder，這裡用 Node 內建的
      // Web Crypto 實作補上，讓 handoff/digest 相關程式碼可以在測試裡真的
      // 執行（不是另外模擬一套假的雜湊邏輯）。
      try {
        window.crypto.subtle = require('crypto').webcrypto.subtle;
        window.TextEncoder = require('util').TextEncoder;
      } catch (e) { /* 環境沒有 webcrypto 時，相關 handoff 測試會自然失敗，不隱藏 */ }
      // jsdom's built-in window.crypto only has getRandomValues, not
      // SubtleCrypto — the popup recovery handoff envelope needs real
      // crypto.subtle.digest('SHA-256', ...), so swap in Node's own
      // webcrypto implementation (plain assignment silently no-ops here;
      // the accessor must be redefined). Real browsers already have both.
      try { Object.defineProperty(window, 'crypto', { value: webcrypto, configurable: true }); } catch (e) {}
      // jsdom's vm context has no TextEncoder/TextDecoder globals (Node
      // provides them at the process level, not inside jsdom's realm).
      if (typeof window.TextEncoder === 'undefined') window.TextEncoder = TextEncoder;
      if (typeof window.TextDecoder === 'undefined') window.TextDecoder = TextDecoder;
      // production 頁面透過 <script src="/js/phone-utils.js"> 載入這個 SSOT，
      // 但 harness 用 resources: undefined 關閉外部資源載入（維持隔離、不做
      // 真實 HTTP 請求）。checkout 驗證需要用到真正的
      // window.PhoneUtils.normalizeTaiwanMobile()（跟後端同一份規則），這裡
      // 手動把同一份原始檔案內容注入這個視窗，而不是另外寫一份假的驗證邏輯。
      try {
        window.eval(fs.readFileSync(path.join(ROOT, 'public/js/phone-utils.js'), 'utf8'));
      } catch (e) { /* 檔案不存在等異常不應該讓整個 harness 掛掉；相關 case 會自然反映在驗證結果上 */ }
      window.fetch = (u, init) => {
        calls.push({ url: String(u), method: (init && init.method) || 'GET' });
        return fetchImpl(String(u), init);
      };
      window.WebSocket = class {
        constructor(wsUrl) { wsCount++; wsUrls.push(String(wsUrl)); this.close = () => {}; this.send = () => {}; }
      };
      // navigator.geolocation stub so GeoLiveCoordinate never hangs waiting on a
      // real permission prompt if it were ever (incorrectly) triggered.
      try {
        Object.defineProperty(window.navigator, 'geolocation', {
          value: { getCurrentPosition: (_ok, err) => { if (err) err({ code: 2, message: 'stubbed: no geolocation in test' }); } },
          configurable: true,
        });
      } catch (e) { /* jsdom version without a writable navigator; harmless to skip */ }
      const origSetTimeout = window.setTimeout.bind(window);
      const origSetInterval = window.setInterval.bind(window);
      window.setTimeout = (fn, ms, ...args) => { const id = origSetTimeout(fn, ms, ...args); timeoutIds.push(id); return id; };
      window.setInterval = (fn, ms, ...args) => { const id = origSetInterval(fn, ms, ...args); intervalIds.push(id); return id; };
      window.addEventListener('error', (e) => unhandled.push('window error: ' + (e.message || (e.error && e.error.message) || '')));
      window.addEventListener('unhandledrejection', (e) => unhandled.push('window unhandledrejection: ' + (e.reason && e.reason.message || e.reason)));
    },
  });

  const w = dom.window;

  // A window-level 'unhandledrejection' listener stops being able to fire the
  // moment `dom.window.close()` runs (there is no window left to dispatch
  // on). If a promise created while this window was alive settles its
  // rejection slightly later than that — because init()'s own async chain
  // hadn't finished yet — jsdom/Node surface it as a *process*-level
  // unhandledRejection/uncaughtException instead. Per this round's
  // instruction, that must become a real assertion failure for this specific
  // case, not a globally-ignored no-op — so this listener is scoped to this
  // one ctx (collects into the same `unhandled` array as the window-level
  // listener), and is removed again in cleanup() so it never stays attached
  // past this case and never accumulates across cases.
  const scopedProcessRejection = (reason) => unhandled.push('process unhandledRejection (after this window\'s teardown began): ' + (reason && reason.message || reason));
  const scopedProcessException = (err) => unhandled.push('process uncaughtException (after this window\'s teardown began): ' + (err && err.message || err));
  process.on('unhandledRejection', scopedProcessRejection);
  process.on('uncaughtException', scopedProcessException);

  const ctx = {
    dom, w, calls, jsErrors, unhandled,
    wsCount: () => wsCount, wsUrls,
    // Drains real pending work (any in-flight promise chain the page itself
    // started) for up to `timeoutMs`, polling `extraSettleFn` if provided,
    // otherwise just giving queued microtasks/macrotasks real turns to run —
    // this is what lets a page's own catch/finally handlers finish touching
    // the DOM *before* the window is closed, instead of racing them.
    async settle(extraSettleFn, { timeoutMs = 800 } = {}) {
      if (extraSettleFn) {
        await waitFor(extraSettleFn, { timeoutMs });
      } else {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
          await new Promise((r) => setTimeout(r, 20));
        }
      }
    },
    // Removes the scoped process listeners, clears every tracked timer, then
    // closes the window — in that order, so nothing can fire against a
    // half-torn-down window. Call settle() before cleanup() when a case's
    // page code does real async work, so cleanup() itself never has to guess.
    cleanup() {
      process.removeListener('unhandledRejection', scopedProcessRejection);
      process.removeListener('uncaughtException', scopedProcessException);
      try { timeoutIds.forEach((id) => { try { w.clearTimeout(id); } catch (e) {} }); } catch (e) {}
      try { intervalIds.forEach((id) => { try { w.clearInterval(id); } catch (e) {} }); } catch (e) {}
      try { dom.window.close(); } catch (e) {}
    },
  };
  return ctx;
}

// Every case must call this before ctx.cleanup() (after its own settle()) and
// treat a non-empty result as that case's own failure — never silently
// dropped, and never a global catch-all.
function assertNoUnexpectedErrors(ctx, label) {
  const unexpected = ctx.unhandled.concat(ctx.jsErrors.map((m) => 'jsdomError: ' + m));
  assert(unexpected.length === 0, `${label}-no-unexpected-exceptions 這個 case 沒有任何未預期的 exception/rejection`, JSON.stringify(unexpected));
}

// Bounded poll instead of a single blind sleep: returns true as soon as fn()
// is truthy, or false once timeoutMs has elapsed. Never hangs indefinitely.
async function waitFor(fn, { timeoutMs = 1000, intervalMs = 15 } = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let v;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

// For the standard (non-popup) page: a real, observable completion signal —
// either the #loading screen has been hidden (happy path) or an error
// screen/message has been written into #loading/#content (init()'s own
// catch path) — instead of a flat, guessed delay. Waiting for this concrete
// DOM signal is what actually eliminates the close-before-settled race,
// rather than merely hiding it behind a longer timeout.
async function waitForStandardPageSettled(ctx, { timeoutMs = 1500 } = {}) {
  return waitFor(() => {
    const loading = ctx.w.document.getElementById('loading');
    const content = ctx.w.document.getElementById('content');
    if (!loading) return true;
    if (loading.style && loading.style.display === 'none') return true;
    if (loading.innerHTML && loading.innerHTML.trim().length > 0) return true; // init()'s own inner catch(e2) fallback
    if (content && content.innerHTML && content.innerHTML.trim().length > 0) return true;
    return false;
  }, { timeoutMs });
}

function fixtureSession(overrides) {
  return {
    success: true,
    data: {
      public_code: 'sess-abc', name: 'Test Session',
      pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00',
      order_open_at: '2000-01-01T00:00', order_cutoff_at: '2099-01-01T09:00',
      place_name: 'Test Place', address: 'Test Address', address_note: 'Note',
      lat: 25.03, lng: 121.5,
      product_scope: 'all_takeout',
      products: [
        { product_id: 301, name: '排骨飯', price: 120, quota_qty: null, remaining_qty: null, sold_out: false },
        { product_id: 302, name: '珍珠奶茶', price: 60, quota_qty: 5, remaining_qty: 5, sold_out: false },
      ],
      max_orders: 10, order_count: 2,
      payment_methods: ['cash', 'credit_card'],
      effective_state: 'ordering_open', can_order: true,
      campaign: { public_code: 'camp-abc', name: 'Test Campaign', description: '', image_url: '' },
      ...overrides,
    },
  };
}

function fixtureCampaign(overrides) {
  return {
    success: true,
    data: {
      public_code: 'camp-abc', name: 'Test Campaign', description: '', image_url: '',
      sessions: [
        { public_code: 'sess-abc', name: 'Test Session', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00', effective_state: 'ordering_open', can_order: true },
      ],
      ...overrides,
    },
  };
}

function fixtureEntry(overrides) {
  return {
    success: true,
    data: {
      enabled: true,
      campaigns: [
        { public_code: 'camp-abc', name: 'Test Campaign', description: '', image_url: '', sessions: [
          { public_code: 'sess-abc', name: 'Test Session', pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00', effective_state: 'ordering_open', can_order: true },
        ] },
      ],
      ...overrides,
    },
  };
}

function jsonFetchImpl(routes, calls) {
  // routes: array of { test: (url)=>bool, response: object|{status,body} }
  return (u) => {
    calls.push(String(u));
    const m = routes.find((r) => r.test(u));
    if (!m) return Promise.reject(new Error('no fixture registered for ' + u));
    const status = m.status || 200;
    const body = m.response;
    return Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body });
  };
}

const FORBIDDEN_ENDPOINTS = [
  '/api/line-orders/shop',
  '/api/line-orders/menu',
  '/api/line-orders/timeslots',
  '/api/coupons',
  '/api/delivery',
  '/api/config/maps-browser-key',
  '/api/settings/business-calendar',
];
function assertNoForbiddenCalls(calls, label) {
  const urls = calls.map((c) => (typeof c === 'string' ? c : c.url));
  const hits = urls.filter((u) => FORBIDDEN_ENDPOINTS.some((f) => u.includes(f)));
  assert(hits.length === 0, `${label}-no-forbidden-calls popup 初始化期間沒有呼叫任何一般 API`, JSON.stringify(hits));
  const generalOrderPost = urls.some((u) => /\/api\/line-orders\/?($|\?)/.test(u));
  assert(!generalOrderPost, `${label}-no-general-order-post popup 沒有呼叫一般 order POST 端點`, JSON.stringify(urls));
}

async function main() {
  // ══════════════════════════════════════════════════════════════════
  // 一、Syntax / static invariants
  // ══════════════════════════════════════════════════════════════════
  {
    let html = fs.readFileSync(HTML_PATH, 'utf8');
    html = html.replace(/<!--[\s\S]*?-->/g, '');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
    assert(scripts.length === 3, '1-script-block-count line-order.html 恰好有 3 個內嵌 <script>（沒有意外新增/減少區塊）', String(scripts.length));
    scripts.forEach((s, i) => {
      const tmpFile = path.join(ROOT, `scripts/.tmp-inline-script-${i}.js`);
      fs.writeFileSync(tmpFile, s);
      try {
        require('child_process').execFileSync(process.execPath, ['--check', tmpFile], { stdio: 'pipe' });
        pass(`1-syntax-script-${i} 內嵌 <script> #${i} 通過 node --check`);
      } catch (e) {
        fail(`1-syntax-script-${i} 內嵌 <script> #${i} 通過 node --check`, (e.stderr || e.message || '').toString().slice(0, 300));
      } finally {
        try { fs.unlinkSync(tmpFile); } catch (e) {}
      }
    });
  }

  const pristineExists = fs.existsSync(PRISTINE_HTML_PATH);
  if (pristineExists) {
    const pristineHash = require('crypto').createHash('sha256').update(fs.readFileSync(PRISTINE_HTML_PATH)).digest('hex');
    assert(pristineHash === PRISTINE_EXPECTED_SHA256, '1-pristine-reference-hash Phase 3A.4 reference line-order.html SHA-256 與核准基準一致', pristineHash);
  } else {
    fail('1-pristine-reference-hash Phase 3A.4 reference line-order.html SHA-256 與核准基準一致', 'reference file missing at ' + PRISTINE_HTML_PATH);
  }

  // ══════════════════════════════════════════════════════════════════
  // 二、Entry routing table（規格四）
  // ══════════════════════════════════════════════════════════════════
  const ENTRY_CASES = [
    { url: 'http://localhost/line-order.html', expect: { entryContext: 'standard' } },
    { url: 'http://localhost/line-order.html?session=x', expect: { entryContext: 'standard' } },
    { url: 'http://localhost/popup-order?session=x', expect: { entryContext: 'popup', popupEntryType: 'session', popupEntryCode: 'x' } },
    { url: 'http://localhost/popup-order?campaign=x', expect: { entryContext: 'popup', popupEntryType: 'campaign', popupEntryCode: 'x' } },
    { url: 'http://localhost/popup-order?store_id=x', expect: { entryContext: 'popup', popupEntryType: 'store', popupStoreId: 'x' } },
    { url: 'http://localhost/popup-order', expect: { entryContext: 'popup', malformed: true } },
    { url: 'http://localhost/popup-order?session=a&campaign=b', expect: { entryContext: 'popup', malformed: true } },
    { url: 'http://localhost/popup-order?session=a&store_id=b', expect: { entryContext: 'popup', malformed: true } },
    { url: 'http://localhost/popup-order?campaign=a&store_id=b', expect: { entryContext: 'popup', malformed: true } },
    { url: 'http://localhost/other-path?session=x', expect: { entryContext: 'standard' } },
  ];
  for (const c of ENTRY_CASES) {
    const calls = [];
    const ctx = await createHarness(c.url, { fetchImpl: defaultFetchReject(calls) });
    try {
      await waitFor(() => true, { timeoutMs: 60 }); // let the synchronous parse + microtasks settle
      const entryCtx = ctx.w.eval('POPUP_ENTRY_CONTEXT');
      const currentMode = ctx.w.eval('currentMode');
      const label = `2-entry-routing[${c.url}]`;
      assert(entryCtx.entryContext === c.expect.entryContext, `${label} entryContext=${c.expect.entryContext}`, JSON.stringify(entryCtx));
      if (c.expect.popupEntryType) assert(entryCtx.popupEntryType === c.expect.popupEntryType, `${label} popupEntryType=${c.expect.popupEntryType}`, JSON.stringify(entryCtx));
      if (c.expect.popupEntryCode) assert(entryCtx.popupEntryCode === c.expect.popupEntryCode, `${label} popupEntryCode=${c.expect.popupEntryCode}`, JSON.stringify(entryCtx));
      if (c.expect.popupStoreId) assert(entryCtx.popupStoreId === c.expect.popupStoreId, `${label} popupStoreId=${c.expect.popupStoreId}`, JSON.stringify(entryCtx));
      if (c.expect.malformed) assert(entryCtx.malformed === true, `${label} malformed=true`, JSON.stringify(entryCtx));
      assert(currentMode === 'takeout' || currentMode === 'delivery', `${label} currentMode 永遠不是 popup`, String(currentMode));
      if (c.expect.malformed) {
        await waitFor(() => calls.length > 0 || true, { timeoutMs: 80 });
        assert(calls.length === 0, `${label} invalid popup URL 不發出任何 store/default API request`, JSON.stringify(calls));
      }
    } finally {
      await ctx.settle(null, { timeoutMs: 300 });
      assertNoUnexpectedErrors(ctx, `2-entry-routing[${c.url}]`);
      ctx.cleanup();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  // 三、Normal-mode A/B parity vs Phase 3A.4 reference
  // ══════════════════════════════════════════════════════════════════
  if (pristineExists) {
    const AB_URLS = [
      'http://localhost/line-order.html',
      'http://localhost/line-order.html?session=malicious-popup-code',
      'http://localhost/line-order.html?store_id=store_001',
      'http://localhost/line-order.html?store_id=store_001&mode=delivery',
    ];
    async function snapshot(htmlPath, url, label) {
      const calls = [];
      const ctx = await createHarness(url, { htmlPath, fetchImpl: defaultFetchReject(calls) });
      try {
        const settled = await waitForStandardPageSettled(ctx, { timeoutMs: 1500 });
        assert(settled, `${label} 標準頁 init() 在有限時間內確實走完（#loading 隱藏或 #content/#loading 寫入內容），不是用固定延遲賭時間`, 'timed out waiting for settle signal');
        return {
          currentMode: ctx.w.eval('currentMode'),
          entryContext: ctx.w.eval('typeof POPUP_ENTRY_CONTEXT!=="undefined" ? POPUP_ENTRY_CONTEXT.entryContext : null'),
          calls: calls.slice().sort(),
          wsCount: ctx.wsCount(),
          errorCount: ctx.jsErrors.length,
        };
      } finally {
        // 頁面已經走到可觀察的完成信號，這裡的 settle() 只是再給一個很短的
        // 緩衝讓最後一點微任務跑完，不是用來「賭」完成時間。
        await ctx.settle(null, { timeoutMs: 100 });
        assertNoUnexpectedErrors(ctx, label);
        ctx.cleanup();
      }
    }
    for (const url of AB_URLS) {
      const pristineSnap = await snapshot(PRISTINE_HTML_PATH, url, `3-ab-parity-pristine[${url}]`);
      const modifiedSnap = await snapshot(HTML_PATH, url, `3-ab-parity-modified[${url}]`);
      const label = `3-ab-parity[${url}]`;
      assert(pristineSnap.currentMode === modifiedSnap.currentMode, `${label} currentMode 相同`, JSON.stringify({ pristineSnap, modifiedSnap }));
      assert(JSON.stringify(pristineSnap.calls) === JSON.stringify(modifiedSnap.calls), `${label} fetch URL 清單完全相同（無新增/減少）`, JSON.stringify({ pristine: pristineSnap.calls, modified: modifiedSnap.calls }));
      assert(pristineSnap.wsCount === modifiedSnap.wsCount, `${label} WebSocket 連線次數相同`, JSON.stringify({ pristineSnap, modifiedSnap }));
      assert(modifiedSnap.calls.every((c) => !c.includes('popup')), `${label} modified 版本沒有多出任何 popup fetch`, JSON.stringify(modifiedSnap.calls));
    }
  } else {
    fail('3-ab-parity Phase 3A.4 reference 存在，可執行 A/B 比對', 'reference missing, skipped');
  }

  // ══════════════════════════════════════════════════════════════════
  // 四、Forbidden-side-effect spy（每種 popup 入口）
  // ══════════════════════════════════════════════════════════════════
  {
    const calls = [];
    const sessionCode = 'sess-r05iso6azufsqzqg';
    const routes = [{ test: (u) => u.includes('/api/line-orders/popup-session/' + sessionCode), response: fixtureSession({ public_code: sessionCode }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=' + sessionCode, { fetchImpl: jsonFetchImpl(routes, calls) });
    try {
      const sessionLoaded = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assertNoForbiddenCalls(calls, '4-session-entry');
      const loadedSessionCode = ctx.w.eval('popupSession && popupSession.public_code');
      assert(sessionLoaded === true && loadedSessionCode === sessionCode && calls.some((u) => u.includes('/api/line-orders/popup-session/' + sessionCode)), '4-session-entry-calls-allowed direct session 呼叫了 popup-session 端點', JSON.stringify({ sessionLoaded, loadedSessionCode, calls }));
      assert(!calls.some((u) => /store_id=/.test(u)), '4-session-entry-no-store-id direct session request 沒有附加任何 store_id', JSON.stringify(calls));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case2'); ctx.cleanup(); }
  }
  {
    const calls = [];
    const routes = [
      { test: (u) => u.includes('/api/line-orders/popup-campaign/camp-abc'), response: fixtureCampaign() },
      { test: (u) => u.includes('/api/line-orders/popup-session/sess-abc'), response: fixtureSession() },
    ];
    const ctx = await createHarness('http://localhost/popup-order?campaign=camp-abc', { fetchImpl: jsonFetchImpl(routes, calls) });
    try {
      await waitFor(() => ctx.w.eval('popupSessions') && ctx.w.eval('popupSessions.length') > 0, { timeoutMs: 800 });
      assertNoForbiddenCalls(calls, '4-campaign-entry');
      assert(calls.some((u) => u.includes('popup-campaign/camp-abc')), '4-campaign-entry-loads-campaign campaign 入口呼叫了 popup-campaign 端點', JSON.stringify(calls));
      assert(ctx.w.eval('popupProducts.length') === 0, '4-campaign-entry-no-products-yet 選擇場次前，popupProducts 仍是空的（列表摘要不是權威商品資料）', String(ctx.w.eval('popupProducts.length')));
      // 選擇第一個場次 → 必須重新呼叫 direct session detail。
      ctx.w.eval("document.querySelector('#popupRoot button[data-session-code]').click();");
      const gotSession = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      assert(gotSession, '4-campaign-entry-selects-session 選擇場次後成功載入 direct session', String(ctx.w.eval('popupError')));
      assert(calls.some((u) => u.includes('popup-session/sess-abc')), '4-campaign-entry-refetches-detail 選中場次後重新呼叫 direct session detail 端點，不使用列表摘要', JSON.stringify(calls));
      assert(ctx.w.eval('popupProducts.length') > 0, '4-campaign-entry-products-from-detail 商品資料來自 direct session detail，不是 campaign 列表摘要', String(ctx.w.eval('popupProducts.length')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case3'); ctx.cleanup(); }
  }
  {
    const calls = [];
    const sessionCode = 'sess-r09isould4cdqklw';
    const entryFixture = fixtureEntry();
    entryFixture.data.campaigns[0].sessions[0].public_code = sessionCode;
    const routes = [
      { test: (u) => u.includes('/api/line-orders/popup-entry'), response: entryFixture },
      { test: (u) => u.includes('/api/line-orders/popup-session/' + sessionCode), response: fixtureSession({ public_code: sessionCode }) },
    ];
    const ctx = await createHarness('http://localhost/popup-order?store_id=store_xyz', { fetchImpl: jsonFetchImpl(routes, calls) });
    try {
      await waitFor(() => ctx.w.eval('popupSessions') && ctx.w.eval('popupSessions.length') > 0, { timeoutMs: 800 });
      assertNoForbiddenCalls(calls, '4-store-entry');
      assert(calls.some((u) => u.includes('popup-entry?store_id=store_xyz')), '4-store-entry-uses-explicit-store-id store 入口用了明確、未被 fallback 的 store_id', JSON.stringify(calls));
      assert(!calls.some((u) => u.includes('store_001')), '4-store-entry-no-fallback-store001 store 入口沒有 fallback 成 store_001', JSON.stringify(calls));
      ctx.w.eval("document.querySelector('#popupRoot button[data-session-code]').click();");
      const sessionLoaded = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const loadedSessionCode = ctx.w.eval('popupSession && popupSession.public_code');
      assert(sessionLoaded === true && loadedSessionCode === sessionCode && calls.some((u) => u.includes('popup-session/' + sessionCode)), '4-store-entry-refetches-detail 選中場次後重新呼叫 direct session detail', JSON.stringify({ sessionLoaded, loadedSessionCode, calls }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case4'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 六、Rendering / state（含 XSS fixture）
  // ══════════════════════════════════════════════════════════════════
  {
    const XSS_PAYLOAD = '<img src=x onerror="window.__xssFired=true">評論<script>window.__xssFired=true</script>';
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ name: XSS_PAYLOAD, place_name: XSS_PAYLOAD }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const fired = ctx.w.eval('window.__xssFired');
      assert(!fired, '6-xss-not-executed 惡意 name/place_name fixture 不會被當成可執行 HTML（沒有觸發 onerror/<script>）', String(fired));
      const rootHtml = ctx.w.document.getElementById('popupRoot').innerHTML;
      assert(!/<img/i.test(rootHtml) && !/<script/i.test(rootHtml), '6-xss-no-raw-tags popupRoot 的實際 DOM 不含原始 <img>/<script> 標籤（只有逸出後的文字節點）', rootHtml.slice(0, 200));
      const rootText = ctx.w.document.getElementById('popupRoot').textContent;
      assert(rootText.includes('評論'), '6-xss-text-preserved 文字內容本身仍正確顯示（只是不可執行）', rootText.slice(0, 200));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case5'); ctx.cleanup(); }
  }
  {
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({
      max_orders: 10, order_count: 2,
      products: [{ product_id: 301, name: '排骨飯', price: 120, quota_qty: null, remaining_qty: null, sold_out: false }],
    }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(text.includes('Test Campaign') && text.includes('Test Session'), '6-render-names 顯示活動與場次名稱', text.slice(0, 200));
      assert(text.includes('2099-01-01'), '6-render-date 顯示取貨日期', text.slice(0, 200));
      assert(text.includes('Test Place') && text.includes('Test Address') && text.includes('Note'), '6-render-location 顯示地點、地址、地址備註', text.slice(0, 200));
      assert(ctx.w.document.querySelector('#popupRoot a[href*="google.com/maps"]') !== null, '6-render-map-link 有座標時提供地圖連結', 'no map link found');
      assert(text.includes('2 / 10') || text.includes('2') && text.includes('10'), '6-render-quota 顯示 max_orders/order_count', text.slice(0, 200));
      assert(text.includes('排骨飯') && text.includes('120'), '6-render-products 顯示商品名稱與價格', text.slice(0, 200));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case6'); ctx.cleanup(); }
  }
  {
    // can_order=false → 所有商品加減按鈕必須是真正的 disabled。
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ can_order: false, effective_state: 'ordering_closed' }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const buttons = [...ctx.w.document.querySelectorAll('#popupRoot li[data-product-id] button')];
      assert(buttons.length > 0, '6-readonly-has-buttons 商品列表仍渲染出加減按鈕（供 disabled 狀態檢查）', String(buttons.length));
      assert(buttons.every((b) => b.disabled === true), '6-readonly-buttons-disabled can_order=false 時，所有商品加減按鈕都是真正的 disabled（不是視覺假裝）', JSON.stringify(buttons.map((b) => b.disabled)));
      const payButtons = [...ctx.w.document.querySelectorAll('#popupRoot [data-payment-code]')];
      assert(payButtons.every((b) => b.disabled === true), '6-readonly-payment-disabled can_order=false 時付款按鈕同樣 disabled', JSON.stringify(payButtons.map((b) => b.disabled)));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case7'); ctx.cleanup(); }
  }
  {
    // 404 / draft / disabled / nonexistent 統一安全錯誤畫面。
    const routes = [{ test: () => true, status: 404, response: { success: false, error: 'POPUP_SESSION_NOT_FOUND', message: '找不到此快閃場次' } }];
    const ctx = await createHarness('http://localhost/popup-order?session=nonexistent', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 800 });
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(!/POPUP_SESSION_NOT_FOUND/.test(text), '6-error-no-code-leak 錯誤畫面不顯示內部 error code', text);
      assert(ctx.w.document.querySelector('#popupRoot button') !== null, '6-error-has-retry 錯誤畫面提供可操作的重試按鈕', text);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case8'); ctx.cleanup(); }
  }
  {
    // 空商品清單。
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ products: [] }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(text.includes('沒有可訂購的商品'), '6-empty-products 空商品清單顯示明確的 empty state', text.slice(0, 200));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case9'); ctx.cleanup(); }
  }
  {
    // network error（fetch reject）。
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: () => Promise.reject(new Error('network down')) });
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 800 });
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(!/network down/.test(text), '6-network-error-no-leak network error 訊息不洩漏原始例外文字', text);
      assert(ctx.w.document.querySelector('#popupRoot button') !== null, '6-network-error-has-retry network error 畫面提供重試按鈕', text);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case10'); ctx.cleanup(); }
  }
  {
    // malformed JSON（.json() 本身 throw）。
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', {
      fetchImpl: () => Promise.resolve({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } }),
    });
    try {
      await waitFor(() => ctx.w.eval('popupError') !== null, { timeoutMs: 800 });
      assert(ctx.w.eval('popupError') !== null, '6-malformed-json fail closed，顯示安全錯誤而非 crash', String(ctx.w.eval('popupError')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case11'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 七、Payment display
  // ══════════════════════════════════════════════════════════════════
  {
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ payment_methods: ['cash', 'credit_card'] }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const codes = [...ctx.w.document.querySelectorAll('#popupRoot [data-payment-code]')].map((b) => b.getAttribute('data-payment-code'));
      assert(JSON.stringify(codes.sort()) === JSON.stringify(['cash', 'credit_card']), '7-canonical-codes 只顯示 canonical 代碼 cash/credit_card', JSON.stringify(codes));
      assert(!codes.includes('card'), '7-no-internal-card 內部代碼 "card" 絕不出現在 DOM', JSON.stringify(codes));
      assert(!codes.includes('linepay'), '7-no-linepay LINE Pay 絕不出現在可選清單', JSON.stringify(codes));
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(!/硬編碼|預設現金/.test(text), '7-no-hardcoded-default-marker 沒有硬編碼預設 cash 的殘留文字（防禦性檢查）', text.slice(0, 100));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case12'); ctx.cleanup(); }
  }
  {
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ payment_methods: [] }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const codes = [...ctx.w.document.querySelectorAll('#popupRoot [data-payment-code]')];
      assert(codes.length === 0, '7-empty-payment-methods 空陣列時不渲染任何付款按鈕', String(codes.length));
      const text = ctx.w.document.getElementById('popupRoot').textContent;
      assert(text.includes('目前無可用付款方式'), '7-empty-payment-message 顯示「目前無可用付款方式」', text.slice(0, 200));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case13'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 八、Cart isolation / reconcile
  // ══════════════════════════════════════════════════════════════════
  {
    const sessionCode = 'sess-r20isofs9ksqlqaazm';
    const routes = [{ test: (u) => u.includes('popup-session/' + sessionCode), response: fixtureSession({ public_code: sessionCode }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=' + sessionCode, { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("document.querySelector('#popupRoot li[data-product-id=\"301\"] button[aria-label*=\"增加\"]').click();");
      const itemAdded = await waitFor(() => ctx.w.eval("popupCart.items.find(i=>i.product_id===301)") !== undefined, { timeoutMs: 400 });
      const memory301 = JSON.parse(ctx.w.eval('JSON.stringify(popupCart.items.filter((i) => i.product_id === 301).map((i) => i.qty))'));
      const stored = ctx.w.localStorage.getItem('line_popup_cart_v1_' + sessionCode);
      const rowExists = !!stored;
      let storage301 = [];
      try { storage301 = (JSON.parse(stored).items || []).filter((i) => i.product_id === 301).map((i) => i.qty); } catch (e) { storage301 = []; }
      assert(itemAdded === true && rowExists && memory301.length === 1 && memory301[0] === 1 && storage301.length === 1 && storage301[0] === 1,
        '8-storage-key-written popup cart 寫入了獨立的 line_popup_cart_v1_<code> key',
        JSON.stringify({ itemAdded, rowExists, memory301Count: memory301.length, memory301Qty: memory301.length ? memory301[0] : null, storage301Count: storage301.length, storage301Qty: storage301.length ? storage301[0] : null }));
      const parsed = JSON.parse(stored);
      assert(parsed.entry_context === 'popup' && parsed.session_public_code === sessionCode, '8-storage-shape storage 內容包含 entry_context/session_public_code', JSON.stringify(parsed));
      assert(!('price' in parsed) && !('total' in parsed) && !('subtotal' in parsed) && !('quota_qty' in parsed) && !('location' in parsed), '8-storage-no-authority-fields storage 不包含 price/total/subtotal/quota/location', JSON.stringify(parsed));
      assert(ctx.w.localStorage.getItem('line_order_cart_store_001') === null, '8-general-cart-untouched 一般 cart key（line_order_cart_*）沒有被 popup 寫入', String(ctx.w.localStorage.getItem('line_order_cart_store_001')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case14'); ctx.cleanup(); }
  }
  {
    // corrupted JSON fail closed
    const sessionCode = 'sess-r21iso4p7vnq3igh';
    const routes = [{ test: (u) => u.includes('popup-session/' + sessionCode), response: fixtureSession({ public_code: sessionCode }) }];
    const w21Calls = [];
    const ctx = await createHarness('http://localhost/popup-order?session=' + sessionCode, { fetchImpl: jsonFetchImpl(routes, w21Calls) });
    try {
      ctx.w.localStorage.setItem('line_popup_cart_v1_' + sessionCode, '{not valid json');
      const sessionLoaded = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const loadedSessionCode = ctx.w.eval('popupSession && popupSession.public_code');
      assert(sessionLoaded === true && loadedSessionCode === sessionCode && ctx.w.eval('popupCart.items.length') === 0, '8-corrupted-json-fail-closed 損毀 JSON 時，購物車視為空（fail closed）而非 crash', JSON.stringify({ sessionLoaded, loadedSessionCode, cartItemCount: ctx.w.eval('popupCart.items.length'), requestCount: w21Calls.length }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case15'); ctx.cleanup(); }
  }
  {
    // context/session code 不符時拒絕還原
    const sessionCode = 'sess-r22isoxa0vy3aryr';
    const routes = [{ test: (u) => u.includes('popup-session/' + sessionCode), response: fixtureSession({ public_code: sessionCode }) }];
    const w22Calls = [];
    const ctx = await createHarness('http://localhost/popup-order?session=' + sessionCode, { fetchImpl: jsonFetchImpl(routes, w22Calls) });
    try {
      ctx.w.localStorage.setItem('line_popup_cart_v1_' + sessionCode, JSON.stringify({ schema_version: 1, entry_context: 'popup', session_public_code: 'OTHER-SESSION', items: [{ product_id: 301, qty: 3 }] }));
      const sessionLoaded = await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const loadedSessionCode = ctx.w.eval('popupSession && popupSession.public_code');
      assert(sessionLoaded === true && loadedSessionCode === sessionCode && ctx.w.eval('popupCart.items.length') === 0, '8-session-mismatch-rejected session_public_code 不符時拒絕還原（視為空購物車）', JSON.stringify({ sessionLoaded, loadedSessionCode, cartItemCount: ctx.w.eval('popupCart.items.length'), requestCount: w22Calls.length }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case16'); ctx.cleanup(); }
  }
  {
    // 停售商品移除、qty 超量縮減
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession({ products: [
      { product_id: 301, name: '排骨飯', price: 120, quota_qty: null, remaining_qty: null, sold_out: false },
      { product_id: 302, name: '珍珠奶茶', price: 60, quota_qty: 2, remaining_qty: 2, sold_out: false },
    ] }) }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      ctx.w.localStorage.setItem('line_popup_cart_v1_sess-abc', JSON.stringify({
        schema_version: 1, entry_context: 'popup', session_public_code: 'sess-abc',
        items: [{ product_id: 999, qty: 1 }, { product_id: 302, qty: 10 }],
      }));
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const items = ctx.w.eval('popupCart.items');
      assert(!items.some((i) => i.product_id === 999), '8-reconcile-removes-delisted 已下架/不存在的商品（999）在 fresh fetch 後被移除', JSON.stringify(items));
      const it302 = items.find((i) => i.product_id === 302);
      assert(!!it302 && it302.qty === 2, '8-reconcile-clamps-qty qty 超過 fresh remaining_qty（2）時被縮減', JSON.stringify(it302));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case17'); ctx.cleanup(); }
  }
  {
    // session A / B 使用不同 key，互不合併
    const sessionCodeA = 'sess-r25isoaa34le5iuy6';
    const sessionCodeB = 'sess-r25isobjljnq9rhjd';
    const routesA = [{ test: (u) => u.includes('popup-session/' + sessionCodeA), response: fixtureSession({ public_code: sessionCodeA, name: 'Session A' }) }];
    const ctxA = await createHarness('http://localhost/popup-order?session=' + sessionCodeA, { fetchImpl: jsonFetchImpl(routesA, []) });
    let keyA;
    let aRawSnapshot = null;
    try {
      await waitFor(() => ctxA.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctxA.w.eval("document.querySelector('#popupRoot li[data-product-id=\"301\"] button[aria-label*=\"增加\"]').click();");
      const itemAdded = await waitFor(() => ctxA.w.eval("popupCart.items.length") > 0, { timeoutMs: 400 });
      keyA = ctxA.w.eval('popupCartStorageKey(popupSession.public_code)');
      const loadedSessionCodeA = ctxA.w.eval('popupSession && popupSession.public_code');
      const memRows301 = JSON.parse(ctxA.w.eval('JSON.stringify(popupCart.items)')).filter((i) => i.product_id === 301);
      aRawSnapshot = ctxA.w.localStorage.getItem(keyA);
      let persistedA = null;
      try { persistedA = JSON.parse(aRawSnapshot); } catch (e) { persistedA = null; }
      const persistedRows301 = persistedA && Array.isArray(persistedA.items) ? persistedA.items.filter((i) => i.product_id === 301) : [];
      const bKeyAbsentInA = ctxA.w.localStorage.getItem(ctxA.w.eval('popupCartStorageKey(' + JSON.stringify(sessionCodeB) + ')')) === null;
      assert(itemAdded === true && loadedSessionCodeA === sessionCodeA && memRows301.length === 1 && memRows301[0].qty === 1
        && typeof aRawSnapshot === 'string' && persistedA !== null && typeof persistedA === 'object' && persistedA.session_public_code === sessionCodeA
        && persistedRows301.length === 1 && persistedRows301[0].qty === 1 && bKeyAbsentInA,
        '8-session-a-add-persists-before-switch session A 加入商品 301 後，切換前已以 A 的 key 持久化（單列 qty 1）',
        JSON.stringify({ itemAdded, loadedSessionCodeA, memRows301: memRows301.length, memQty301: memRows301.length ? memRows301[0].qty : null,
          persistedRowPresent: typeof aRawSnapshot === 'string', persistedSessionMatches: !!persistedA && persistedA.session_public_code === sessionCodeA,
          persistedRows301: persistedRows301.length, persistedQty301: persistedRows301.length ? persistedRows301[0].qty : null, bKeyAbsentInA }));
    } finally { await ctxA.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctxA, 'case18'); ctxA.cleanup(); }

    const routesB = [{ test: (u) => u.includes('popup-session/' + sessionCodeB), response: fixtureSession({ public_code: sessionCodeB, name: 'Session B' }) }];
    const ctxB = await createHarness('http://localhost/popup-order?session=' + sessionCodeB, { fetchImpl: jsonFetchImpl(routesB, []), initialLocalStorage: { [keyA]: aRawSnapshot } });
    try {
      await waitFor(() => ctxB.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const keyB = ctxB.w.eval('popupCartStorageKey(popupSession.public_code)');
      const aRawInB = ctxB.w.localStorage.getItem(keyA);
      assert(keyA !== keyB && typeof aRawSnapshot === 'string' && aRawInB === aRawSnapshot, '8-session-ab-different-keys session A/B 使用不同的 storage key',
        JSON.stringify({ keyA, keyB, aRowPresentInB: aRawInB !== null, aRowByteIdentical: aRawInB === aRawSnapshot }));
      const bMemItems = JSON.parse(ctxB.w.eval('JSON.stringify(popupCart.items)'));
      let bRow = null;
      try { bRow = JSON.parse(ctxB.w.localStorage.getItem(keyB)); } catch (e) { bRow = null; }
      const aRawAfterB = ctxB.w.localStorage.getItem(keyA);
      assert(bMemItems.length === 0 && bRow !== null && typeof bRow === 'object' && bRow.session_public_code === sessionCodeB && Array.isArray(bRow.items) && bRow.items.length === 0
        && aRawAfterB === aRawSnapshot, '8-session-ab-no-merge session B 沒有沿用 session A 的購物車內容',
        JSON.stringify({ bMemItemCount: bMemItems.length, bRowPresent: bRow !== null, bRowSessionMatches: !!bRow && bRow.session_public_code === sessionCodeB,
          bRowItemCount: bRow && Array.isArray(bRow.items) ? bRow.items.length : null, aRowUnchanged: aRawAfterB === aRawSnapshot }));
    } finally { await ctxB.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctxB, 'case19'); ctxB.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 九、Refresh / dedup / stale-response 防護
  // ══════════════════════════════════════════════════════════════════
  {
    // 競態：A 先發、B 後發，但 B 先回、A 後回——最終狀態必須是 B。
    let resolveA, resolveB;
    const pendingA = new Promise((r) => { resolveA = r; });
    const pendingB = new Promise((r) => { resolveB = r; });
    let callIndex = 0;
    const fetchImpl = () => {
      callIndex += 1;
      const myIndex = callIndex;
      return (myIndex === 1 ? pendingA : pendingB).then(() => ({
        ok: true, status: 200,
        json: async () => fixtureSession({ name: myIndex === 1 ? 'Session A (stale)' : 'Session B (fresh)' }),
      }));
    };
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl });
    try {
      // A 的初始 initPopup() 呼叫已經在 harness 建立時觸發（callIndex=1，還沒 resolve）。
      await waitFor(() => callIndex >= 1, { timeoutMs: 400 });
      ctx.w.eval('loadPopupDirectSession("sess-abc")'); // 這是 B，callIndex 變成 2
      await waitFor(() => callIndex >= 2, { timeoutMs: 400 });
      // 先讓 B resolve，再讓 A（較舊的）resolve，模擬「較舊的請求比較晚回來」。
      resolveB();
      await waitFor(() => ctx.w.eval('popupSession') !== null && ctx.w.eval('popupSession.name') === 'Session B (fresh)', { timeoutMs: 400 });
      resolveA();
      await waitFor(() => true, { timeoutMs: 100 });
      assert(ctx.w.eval('popupSession.name') === 'Session B (fresh)', '9-stale-response-discarded 較舊的請求（A）比較晚回來時，不會覆蓋較新的結果（B）', String(ctx.w.eval('popupSession.name')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case20'); ctx.cleanup(); }
  }
  {
    // pageshow/focus 去重：短時間內觸發多次，只產生一次額外的 fetch。
    const calls = [];
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession() }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, calls) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const before = calls.length;
      ctx.w.dispatchEvent(new ctx.w.Event('pageshow'));
      ctx.w.dispatchEvent(new ctx.w.Event('pageshow'));
      ctx.w.dispatchEvent(new ctx.w.Event('pageshow'));
      await waitFor(() => calls.length > before, { timeoutMs: 400 });
      await waitFor(() => true, { timeoutMs: 150 }); // 讓 debounce 視窗完全過去
      const extra = calls.length - before;
      assert(extra === 1, '9-refresh-dedup 短時間內連續觸發 3 次 pageshow 只產生 1 次真正的 refresh fetch', String(extra));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case21'); ctx.cleanup(); }
  }
  {
    // popup 的 refresh listener 不得在一般頁生效。
    const calls = [];
    const ctx = await createHarness('http://localhost/line-order.html', { fetchImpl: defaultFetchReject(calls) });
    try {
      await waitFor(() => true, { timeoutMs: 150 });
      const before = calls.length;
      assert(ctx.w.eval('popupRefreshListenersRegistered') === false, '9-standard-no-popup-listener 一般頁的 popupRefreshListenersRegistered 從未被設為 true', String(ctx.w.eval('popupRefreshListenersRegistered')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case22'); ctx.cleanup(); }
  }
  {
    // session 變為不可下單時立即停用操作，但保留 cart。
    const sessionCode = 'sess-r37isojsm6dtadixdx';
    let resolveCount = 0;
    const responses = [
      fixtureSession({ public_code: sessionCode, can_order: true }),
      fixtureSession({ public_code: sessionCode, can_order: false, effective_state: 'ordering_closed' }),
    ];
    const fetchImpl = () => {
      const r = responses[Math.min(resolveCount, responses.length - 1)];
      resolveCount += 1;
      return Promise.resolve({ ok: true, status: 200, json: async () => r });
    };
    const ctx = await createHarness('http://localhost/popup-order?session=' + sessionCode, { fetchImpl });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      ctx.w.eval("document.querySelector('#popupRoot li[data-product-id=\"301\"] button[aria-label*=\"增加\"]').click();");
      await waitFor(() => ctx.w.eval('popupCart.items.length') > 0, { timeoutMs: 400 });
      ctx.w.eval('loadPopupDirectSession(' + JSON.stringify(sessionCode) + ')'); // 模擬 refresh 拿到「已關閉」的新狀態
      const stateChanged = await waitFor(() => ctx.w.eval('popupSession.can_order') === false, { timeoutMs: 800 });
      const buttons = [...ctx.w.document.querySelectorAll('#popupRoot li[data-product-id] button')];
      assert(stateChanged === true && buttons.length > 0 && buttons.every((b) => b.disabled),
        '9-state-change-disables 狀態變為不可下單後，商品按鈕立即停用',
        JSON.stringify({ stateChanged, buttonCount: buttons.length, disabled: buttons.map((b) => b.disabled) }));
      assert(ctx.w.eval('popupCart.items.length') > 0, '9-state-change-keeps-cart 狀態變化沒有清除購物車內容', String(ctx.w.eval('popupCart.items.length')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case23'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 十、ARIA / 行動版基礎
  // ══════════════════════════════════════════════════════════════════
  {
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: () => new Promise(() => {}) }); // 永遠 pending，停在 loading
    try {
      await waitFor(() => true, { timeoutMs: 100 });
      const loadingDiv = ctx.w.document.querySelector('#popupRoot [aria-busy="true"]');
      assert(!!loadingDiv, '10-aria-busy loading 畫面容器有 aria-busy="true"', 'not found');
      const liveDiv = ctx.w.document.querySelector('#popupRoot [aria-live="polite"]');
      assert(!!liveDiv, '10-aria-live 狀態訊息容器有 aria-live="polite"', 'not found');
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case24'); ctx.cleanup(); }
  }
  {
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession() }];
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl: jsonFetchImpl(routes, []) });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      const qtyButtons = [...ctx.w.document.querySelectorAll('#popupRoot li[data-product-id] button')];
      assert(qtyButtons.length > 0 && qtyButtons.every((b) => b.tagName === 'BUTTON' && !!b.getAttribute('aria-label')), '10-qty-buttons-labelled 商品加減按鈕都是真正的 <button> 且有可理解的 aria-label', JSON.stringify(qtyButtons.map((b) => b.getAttribute('aria-label'))));
      const selectorButtons = [...ctx.w.document.querySelectorAll('#popupRoot [data-payment-code]')];
      assert(selectorButtons.every((b) => b.tagName === 'BUTTON'), '10-payment-buttons-keyboard-operable 付款按鈕是原生 <button>（天生可鍵盤操作，不需額外 tabindex hack）', 'n/a');
      // 360px：jsdom 無法驗證實際排版，這裡只確認容器沒有寫死超過 360px 的
      // inline width，避免明顯的固定寬度違規；真正的視覺 RWD 仍以最終 Phase
      // 3B 真機檢查為準，這裡不宣稱已完成視覺 QA。
      const rootEl = ctx.w.document.getElementById('popupRoot');
      const inlineWidth = rootEl.style && rootEl.style.width;
      assert(!inlineWidth || !/^\d+px$/.test(inlineWidth) || parseInt(inlineWidth, 10) <= 360, '10-no-fixed-oversized-width popupRoot 沒有寫死超過 360px 的 inline width（真實視覺驗證仍待最終 gate）', String(inlineWidth));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, 'case25'); ctx.cleanup(); }
  }

  // ══════════════════════════════════════════════════════════════════
  // 十一、Popup checkout（mocked fetch）
  // ══════════════════════════════════════════════════════════════════
  const FORBIDDEN_CHECKOUT_ENDPOINTS = ['/api/line-orders/timeslots', '/api/coupons', '/api/delivery', '/linepay', '/api/orders'];
  function isGeneralOrderPost(u, method) {
    return method === 'POST' && /\/api\/line-orders\/?($|\?)/.test(u);
  }

  async function setupCheckoutSession(overrides, fetchExtra) {
    const calls = [];
    const routes = [{ test: (u) => u.includes('popup-session/sess-abc'), response: fixtureSession(overrides) }];
    const baseFetch = jsonFetchImpl(routes, calls);
    const fetchImpl = fetchExtra ? (u, init) => fetchExtra(u, init, baseFetch, calls) : baseFetch;
    const ctx = await createHarness('http://localhost/popup-order?session=sess-abc', { fetchImpl });
    await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
    return { ctx, calls };
  }

  // 把表單填成「送出前」的狀態：加入一項商品、填姓名/電話、選付款方式。
  // 任一個引數傳 null／undefined 就跳過該欄位（用來製造「缺少某欄位」的情境）。
  function fillPopupCheckoutForm(ctx, { productId = 301, qty = 1, name = '王小明', phone = '0912345678', payment = 'cash' } = {}) {
    if (productId != null && qty) {
      for (let i = 0; i < qty; i++) {
        ctx.w.eval(`document.querySelector('#popupRoot li[data-product-id="${productId}"] button[aria-label*="增加"]').click();`);
      }
    }
    if (name != null) {
      const el = ctx.w.document.getElementById('popupCustomerName');
      el.value = name;
      el.dispatchEvent(new ctx.w.Event('input'));
    }
    if (phone != null) {
      const el = ctx.w.document.getElementById('popupCustomerPhone');
      el.value = phone;
      el.dispatchEvent(new ctx.w.Event('input'));
    }
    if (payment != null) {
      const btn = ctx.w.document.querySelector(`#popupRoot [data-payment-code="${payment}"]`);
      if (btn) btn.click();
      else ctx.w.eval(`popupCart={...popupCart, payment_method:${JSON.stringify(payment)}}; savePopupCart(popupSession.public_code, popupCart); renderPopupSessionScreen();`);
    }
  }

  function successCheckoutFixture(overrides) {
    return {
      success: true,
      data: {
        id: 'order-xyz', order_number: 'POPUP-20990101-100000-abcdef', pickup_type: 'popup',
        popup_session_public_code: 'sess-abc', popup_campaign_name: 'Test Campaign', popup_session_name: 'Test Session',
        pickup_date: '2099-01-01', pickup_start_time: '10:00', pickup_end_time: '20:00',
        place_name: 'Test Place', address: 'Test Address', address_note: 'Note',
        items: [{ product_id: 301, qty: 1 }], subtotal: 120, total: 120,
        ...overrides,
      },
    };
  }

  // 1. Payload allowlist — 成功送單時精確驗證欄位。
  {
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch, calls) => {
      if (init && init.method === 'POST') {
        posts.push({ url: String(u), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
        return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() });
      }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      await waitFor(() => posts.length > 0, { timeoutMs: 600 });
      assert(posts.length === 1, '11-1-single-post 成功送單只產生一個 POST', JSON.stringify(posts.map((p) => p.url)));
      const p = posts[0];
      assert(p.url === '/api/line-orders/popup-checkout', '11-1-endpoint 只呼叫 POST /api/line-orders/popup-checkout', p.url);
      assert(p.method === 'POST', '11-1-method 使用 POST', p.method);
      const bodyKeys = Object.keys(p.body).sort();
      const allowlist = ['customer_name', 'customer_phone', 'items', 'payment_method', 'popup_session_public_code'].sort();
      assert(JSON.stringify(bodyKeys) === JSON.stringify(allowlist) || (bodyKeys.length === allowlist.length + 1 && bodyKeys.includes('note')), '11-1-exact-fields payload 只包含 allowlist 欄位（不多不少，note 為選填）', JSON.stringify(bodyKeys));
      ['store_id', 'price', 'subtotal', 'total', 'address', 'location', 'pickup_address', 'campaign_name', 'session_name', 'quota', 'state', 'card'].forEach((forbidden) => {
        assert(!(forbidden in p.body), `11-1-no-${forbidden} payload 不含 ${forbidden}`, JSON.stringify(p.body));
      });
      assert(Array.isArray(p.body.items) && p.body.items.every((it) => Object.keys(it).sort().join(',') === 'product_id,qty'), '11-1-items-shape items 陣列每項只有 product_id/qty', JSON.stringify(p.body.items));
      assert(!p.url.includes('store_001') && !p.url.includes('store_id'), '11-1-no-store-id-in-url 沒有透過會附加 LINE_STORE_ID 的 apiFetch()（URL 沒有 store_id/store_001）', p.url);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-1-payload-allowlist'); ctx.cleanup(); }
  }

  // 2. Client validation — 各種不合法情境都必須是零 POST。
  const VALIDATION_CASES = [
    { label: 'empty-cart', form: { productId: null, qty: 0 } },
    { label: 'missing-name', form: { name: '' } },
    { label: 'missing-phone', form: { phone: '' } },
    { label: 'invalid-phone', form: { phone: '123' } },
    { label: 'no-payment', form: { payment: null } },
    { label: 'injected-card', form: { payment: 'card' } },
    { label: 'injected-linepay', form: { payment: 'linepay' } },
  ];
  for (const c of VALIDATION_CASES) {
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx, c.form);
      await waitFor(() => true, { timeoutMs: 150 });
      ctx.w.eval('submitPopupCheckout();');
      await waitFor(() => true, { timeoutMs: 150 });
      assert(posts.length === 0, `11-2-${c.label} 此情境下零 POST`, JSON.stringify(posts));
      assert(ctx.w.document.getElementById('popupCheckoutSubmitBtn').disabled === true, `11-2-${c.label}-button-disabled 送出按鈕保持 disabled`, 'n/a');
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, `11-2-${c.label}`); ctx.cleanup(); }
  }
  // qty 異常值：0/負數/小數/NaN/Infinity 直接寫進 popupCart（模擬竄改），必須被 popupValidateCheckout() 擋下。
  for (const badQty of [0, -1, 1.5, NaN, Infinity]) {
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx, { productId: null });
      ctx.w.eval(`popupCart={...popupCart, items:[{product_id:301, qty:${JSON.stringify(badQty)}}]}; renderPopupSessionScreen();`);
      ctx.w.eval('submitPopupCheckout();');
      await waitFor(() => true, { timeoutMs: 150 });
      assert(posts.length === 0, `11-2-bad-qty-${badQty} qty=${badQty} 時零 POST`, JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, `11-2-bad-qty-${badQty}`); ctx.cleanup(); }
  }
  // payment 不在 fresh 清單：session 只允許 cash，手動把 payment_method 設成 transfer。
  {
    const posts = [];
    const { ctx } = await setupCheckoutSession({ payment_methods: ['cash'] }, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx, { payment: null });
      ctx.w.eval("popupCart={...popupCart, payment_method:'transfer'}; renderPopupSessionScreen();");
      ctx.w.eval('submitPopupCheckout();');
      await waitFor(() => true, { timeoutMs: 150 });
      assert(posts.length === 0, '11-2-payment-not-in-fresh-list payment 不在 fresh popupPaymentMethods 時零 POST', JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-2-payment-not-in-fresh-list'); ctx.cleanup(); }
  }
  // can_order=false 時。
  {
    const posts = [];
    const { ctx } = await setupCheckoutSession({ can_order: false, effective_state: 'ordering_closed' }, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      ctx.w.eval("popupCart={...popupCart, items:[{product_id:301,qty:1}], customer_name:'王小明', customer_phone:'0912345678', payment_method:'cash'}; renderPopupSessionScreen();");
      ctx.w.eval('submitPopupCheckout();');
      await waitFor(() => true, { timeoutMs: 150 });
      assert(posts.length === 0, '11-2-can-order-false can_order=false 時零 POST（即使表單資料本身合法）', JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-2-can-order-false'); ctx.cleanup(); }
  }
  // 合法姓名/電話不得被過度嚴格擋下（防止前端規則比後端武斷）。
  {
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx, { name: '王小明 Wang', phone: '0987654321' });
      const ok = await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      assert(ok, '11-2-legit-name-phone-not-blocked 合法的中英混合姓名與台灣手機號碼不會被前端擋下', ctx.w.eval('JSON.stringify(popupValidateCheckout())'));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-2-legit-name-phone-not-blocked'); ctx.cleanup(); }
  }

  // 3. Double-submit 防護
  {
    const posts = [];
    let resolvePost;
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') {
        posts.push(String(u));
        return new Promise((r) => { resolvePost = () => r({ ok: true, status: 201, json: async () => successCheckoutFixture({ order_number: 'POPUP-20990101-100000-r51iso3kzzdpvl4i' }) }); });
      }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      const btn = ctx.w.document.getElementById('popupCheckoutSubmitBtn');
      btn.click(); btn.click(); btn.click(); // 三次快速點擊模擬雙擊/多擊
      await waitFor(() => posts.length > 0, { timeoutMs: 400 });
      assert(posts.length === 1, '11-3-double-click 連續 3 次點擊只產生 1 個 POST', JSON.stringify(posts));
      const btnAfterClick = ctx.w.document.getElementById('popupCheckoutSubmitBtn');
      assert(btnAfterClick.disabled === true, '11-3-button-disabled-while-pending request 進行中按鈕是真正的 disabled', 'n/a');
      resolvePost();
      const restored = await waitFor(() => ctx.w.eval('_popupCheckoutInFlight') === false, { timeoutMs: 400 });
      const inFlightAfterFinally = ctx.w.eval('_popupCheckoutInFlight');
      assert(restored === true && inFlightAfterFinally === false, '11-3-finally-restores request 結束後 in-flight 狀態在 finally 正確恢復', JSON.stringify({ restored, inFlightAfterFinally }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-3-double-click'); ctx.cleanup(); }
  }
  {
    // click + Enter 幾乎同時觸發：Enter 在表單欄位上通常會被瀏覽器轉成對
    // submit 按鈕的一次 click，這裡直接模擬「Enter 觸發的 click」與「滑鼠
    // click」幾乎同時發生。
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture() }); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      const btn = ctx.w.document.getElementById('popupCheckoutSubmitBtn');
      btn.click();
      btn.click(); // 模擬 Enter 冒泡出的第二次 click
      await waitFor(() => posts.length > 0, { timeoutMs: 400 });
      assert(posts.length === 1, '11-3-click-plus-enter click + Enter 同時觸發仍只有一個 POST', JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-3-click-plus-enter'); ctx.cleanup(); }
  }

  // 4. 錯誤處理與購物車保存
  const ERROR_CASES = [
    { label: '400', status: 400, body: { success: false, error: 'POPUP_VALIDATION_ERROR', message: '欄位錯誤' }, expectReload: false },
    { label: '404', status: 404, body: { success: false, error: 'POPUP_SESSION_NOT_FOUND', message: '找不到' }, expectReload: false, expectGenericMsg: true },
    { label: '409-not-orderable', status: 409, body: { success: false, error: 'POPUP_SESSION_NOT_ORDERABLE', message: '不可下單' }, expectReload: true },
    { label: '409-full', status: 409, body: { success: false, error: 'POPUP_SESSION_FULL', message: '已滿' }, expectReload: true },
    { label: '409-sold-out', status: 409, body: { success: false, error: 'POPUP_PRODUCT_SOLD_OUT', message: '售完' }, expectReload: true },
    { label: '409-payment-not-ready', status: 409, body: { success: false, error: 'POPUP_PAYMENT_METHOD_NOT_READY', message: '未開放' }, expectReload: true },
    { label: '500', status: 500, body: { success: false, error: 'POPUP_INTERNAL_ERROR', message: 'internal stack trace leak /home/x/server.js:123' }, expectReload: false },
  ];
  for (const c of ERROR_CASES) {
    const posts = [];
    let reloadCalls = 0;
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch, calls) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return Promise.resolve({ ok: c.status < 300, status: c.status, json: async () => c.body }); }
      if (String(u).includes('popup-session/sess-abc')) reloadCalls += 1;
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      const reloadBefore = reloadCalls;
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      await waitFor(() => posts.length > 0, { timeoutMs: 400 });
      const restored = await waitFor(() => ctx.w.eval('_popupCheckoutInFlight') === false, { timeoutMs: 400 });
      const inFlightAfterFinally = ctx.w.eval('_popupCheckoutInFlight');
      assert(restored === true && inFlightAfterFinally === false && ctx.w.eval('popupCart.items.length') > 0, `11-4-${c.label}-cart-kept 錯誤時保留購物車`, JSON.stringify({ label: c.label, restored, inFlightAfterFinally, cartItems: ctx.w.eval('popupCart.items.length') }));
      const errText = ctx.w.document.getElementById('popupCheckoutErrorRegion').textContent;
      assert(!/stack trace|server\.js|SQL/i.test(errText), `11-4-${c.label}-no-leak 錯誤訊息不洩漏 stack/SQL/path`, errText);
      if (c.expectGenericMsg) assert(errText.includes('場次不存在或目前不可用'), `11-4-${c.label}-generic-message 404 顯示統一「場次不存在或目前不可用」`, errText);
      if (c.expectReload) {
        await waitFor(() => reloadCalls > reloadBefore, { timeoutMs: 400 });
        assert(reloadCalls > reloadBefore, `11-4-${c.label}-fresh-reload 409（狀態/商品/付款已變）時 fresh reload session`, String({ reloadBefore, reloadCalls }));
      }
      assert(posts.length === 1, `11-4-${c.label}-no-auto-retry 錯誤後不自動重送`, JSON.stringify(posts));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, `11-4-${c.label}`); ctx.cleanup(); }
  }
  // network rejection / malformed JSON / malformed 201。
  const NETWORK_ERROR_CASES = [
    { label: 'network-rejection', fetchImpl: () => Promise.reject(new Error('network down')) },
    { label: 'non-json-response', fetchImpl: () => Promise.resolve({ ok: true, status: 201, json: async () => { throw new Error('bad json'); } }) },
    { label: 'malformed-201-missing-fields', fetchImpl: () => Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, data: { id: 'x' } }) }) },
  ];
  for (const c of NETWORK_ERROR_CASES) {
    const posts = [];
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') { posts.push(String(u)); return c.fetchImpl(); }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      await waitFor(() => posts.length > 0, { timeoutMs: 400 });
      const restored = await waitFor(() => ctx.w.eval('_popupCheckoutInFlight') === false, { timeoutMs: 400 });
      const inFlightAfterFinally = ctx.w.eval('_popupCheckoutInFlight');
      assert(restored === true && inFlightAfterFinally === false && ctx.w.eval('popupCart.items.length') > 0, `11-4-${c.label}-cart-kept 保留購物車`, JSON.stringify({ label: c.label, restored, inFlightAfterFinally, cartItems: ctx.w.eval('popupCart.items.length') }));
      assert(posts.length === 1, `11-4-${c.label}-no-auto-retry 不自動重送`, JSON.stringify(posts));
      const root = ctx.w.document.getElementById('popupRoot').textContent;
      assert(!/network down|bad json/i.test(root), `11-4-${c.label}-no-raw-exception-leak 不直接顯示原始例外文字`, root);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, `11-4-${c.label}`); ctx.cleanup(); }
  }

  // 5. 成功行為
  {
    const XSS = '<img src=x onerror="window.__xssFired2=true">名字';
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture({ popup_session_name: XSS, place_name: XSS }) });
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      await waitFor(() => ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), { timeoutMs: 600 });
      const root = ctx.w.document.getElementById('popupRoot');
      assert(root.textContent.includes('訂單編號：POPUP-20990101-100000-abcdef'), '11-5-uses-response-snapshot 成功畫面顯示 response 的 order_number（不是 request 值）', root.textContent);
      assert(root.textContent.includes('2099-01-01') && root.textContent.includes('10:00'), '11-5-shows-pickup-time 顯示取貨日期時間', root.textContent);
      assert(root.textContent.includes('NT$120'), '11-5-shows-total 顯示 total', root.textContent);
      assert(!ctx.w.eval('window.__xssFired2'), '11-5-xss-not-fired 成功畫面的 XSS fixture 沒有被執行', String(ctx.w.eval('window.__xssFired2')));
      assert(!/<img/i.test(root.innerHTML), '11-5-xss-no-raw-tag 成功畫面 DOM 不含原始 <img> 標籤', root.innerHTML.slice(0, 200));
      assert(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-abc') === null, '11-5-clears-current-session-cart 成功後清除當前 session 的 popup cart key', String(ctx.w.localStorage.getItem('line_popup_cart_v1_sess-abc')));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-5-success-snapshot'); ctx.cleanup(); }
  }
  {
    // malformed 201（缺少必要 snapshot 欄位）不得清 cart。
    let postCount = 0;
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') {
        if (String(u) === '/api/line-orders/popup-checkout') postCount += 1;
        return Promise.resolve({ ok: true, status: 201, json: async () => ({ success: true, data: { id: 'w64isoeg419kp4qk' } }) });
      }
      return baseFetch(String(u), init);
    });
    try {
      fillPopupCheckoutForm(ctx, { name: 'w63iso39jvetvqcobp' });
      const validated = await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      const restored = await waitFor(() => ctx.w.eval('_popupCheckoutInFlight') === false, { timeoutMs: 600 });
      const inFlightAfterFinally = ctx.w.eval('_popupCheckoutInFlight');
      const validationOkAfterWait = ctx.w.eval('popupValidateCheckout().ok');
      assert(validated === true && validationOkAfterWait === true && postCount === 1 && restored === true && inFlightAfterFinally === false && ctx.w.eval('popupCart.items.length') > 0,
        '11-5-malformed-201-keeps-cart response 缺少必要欄位（order_number/popup_session_public_code）時不清購物車',
        JSON.stringify({ validated, validationOkAfterWait, postCount, restored, inFlightAfterFinally, cartItems: ctx.w.eval('popupCart.items.length') }));
      assert(!ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), '11-5-malformed-201-no-success-screen 不顯示成功畫面', ctx.w.document.getElementById('popupRoot').textContent);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-5-malformed-201'); ctx.cleanup(); }
  }
  {
    // session A 成功不清 session B、不清一般 cart。
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture({ order_number: 'w66isoahn4kp0nje' }) });
      return baseFetch(String(u), init);
    });
    try {
      ctx.w.localStorage.setItem('line_popup_cart_v1_sess-OTHER', JSON.stringify({ schema_version: 1, entry_context: 'popup', session_public_code: 'sess-OTHER', items: [{ product_id: 301, qty: 2 }] }));
      ctx.w.localStorage.setItem('line_order_cart_store_001', JSON.stringify({ some: 'general-cart-data' }));
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      const otherRowBefore = ctx.w.localStorage.getItem('line_popup_cart_v1_sess-OTHER');
      const generalRowBefore = ctx.w.localStorage.getItem('line_order_cart_store_001');
      const ownKey = ctx.w.eval('popupCartStorageKey(popupSession.public_code)');
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      const successReached = await waitFor(() => ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), { timeoutMs: 600 });
      const w66Marker = 'w66isoahn4kp0nje';
      const w66RootText = ctx.w.document.getElementById('popupRoot').textContent;
      const successShown = w66RootText.includes('訂購成功');
      const successMarkerShown = w66RootText.includes(w66Marker);
      assert(successReached === true && successShown && successMarkerShown && ctx.w.localStorage.getItem('line_popup_cart_v1_sess-OTHER') !== null, '11-5-other-session-not-cleared session A 成功不清 session B 的 popup cart',
        JSON.stringify({ successReached, successShown, successMarkerShown, otherRowPresent: ctx.w.localStorage.getItem('line_popup_cart_v1_sess-OTHER') !== null }));
      assert(ctx.w.localStorage.getItem('line_order_cart_store_001') !== null, '11-5-general-cart-not-cleared session 成功不清一般 cart', String(ctx.w.localStorage.getItem('line_order_cart_store_001')));
      const ownRootText = ctx.w.document.getElementById('popupRoot').textContent;
      const ownMem = JSON.parse(ctx.w.eval('JSON.stringify({ code: popupCart.session_public_code, n: Array.isArray(popupCart.items) ? popupCart.items.length : -1 })'));
      const ownRowAfter = ctx.w.localStorage.getItem(ownKey);
      const otherRowUnchanged = ctx.w.localStorage.getItem('line_popup_cart_v1_sess-OTHER') === otherRowBefore;
      const generalRowUnchanged = ctx.w.localStorage.getItem('line_order_cart_store_001') === generalRowBefore;
      assert(ownRootText.includes('訂購成功') && ownRootText.includes(w66Marker) && ownMem.code === 'sess-abc' && ownMem.n === 0 && ownRowAfter === null && otherRowUnchanged && generalRowUnchanged,
        '11-5-own-session-cart-cleared 成功後本 session 的記憶體與 storage 購物車確實清除（其他 session／一般 cart 原樣保留）',
        JSON.stringify({ successShown: ownRootText.includes('訂購成功'), successMarkerShown: ownRootText.includes(w66Marker), ownSessionMatches: ownMem.code === 'sess-abc', ownMemoryItemCount: ownMem.n, ownRowExists: ownRowAfter !== null, otherRowUnchanged, generalRowUnchanged }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-5-other-carts-untouched'); ctx.cleanup(); }
  }

  // 6. Session race：A 開始 checkout，使用者切到 B，A 的 response 最後才回來。
  {
    let resolveA;
    const pendingA = new Promise((r) => { resolveA = r; });
    let postCount = 0;
    let aResponseJsonReads = 0;
    const routes = [
      { test: (u) => u.includes('popup-session/sess-A'), response: fixtureSession({ public_code: 'sess-A', name: 'Session A' }) },
      { test: (u) => u.includes('popup-session/sess-B'), response: fixtureSession({ public_code: 'sess-B', name: 'Session B' }) },
    ];
    const baseFetch = jsonFetchImpl(routes, []);
    const ctx = await createHarness('http://localhost/popup-order?session=sess-A', {
      fetchImpl: (u, init) => {
        if (init && init.method === 'POST') {
          if (String(u) === '/api/line-orders/popup-checkout') postCount += 1;
          return pendingA.then(() => ({ ok: true, status: 201, json: async () => { aResponseJsonReads += 1; return successCheckoutFixture({ popup_session_public_code: 'sess-A', popup_session_name: 'Session A result' }); } }));
        }
        return baseFetch(String(u), init);
      },
    });
    try {
      await waitFor(() => ctx.w.eval('popupSession') !== null, { timeoutMs: 800 });
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      const postStarted = await waitFor(() => ctx.w.eval('_popupCheckoutInFlight') === true && postCount === 1, { timeoutMs: 400 });
      // 使用者切換到 session B（例如點了 campaign 選單裡的另一場次）。
      ctx.w.eval("loadPopupDirectSession('sess-B');");
      const sessionBLoaded = await waitFor(() => ctx.w.eval('popupSession') !== null && ctx.w.eval('popupSession.public_code') === 'sess-B', { timeoutMs: 800 });
      const loadedSessionCode = ctx.w.eval('popupSession && popupSession.public_code');
      const jsonReadsBeforeResolve = aResponseJsonReads;
      // A 的 checkout response 現在才回來。
      resolveA();
      const staleResponseProcessed = await waitFor(() => aResponseJsonReads === 1 && ctx.w.eval('_popupCheckoutInFlight') === false, { timeoutMs: 300 });
      const inFlightAfterStale = ctx.w.eval('_popupCheckoutInFlight');
      assert(postStarted === true && postCount === 1 && sessionBLoaded === true && loadedSessionCode === 'sess-B' && jsonReadsBeforeResolve === 0
        && staleResponseProcessed === true && aResponseJsonReads === 1 && inFlightAfterStale === false && ctx.w.eval('popupSession.public_code') === 'sess-B',
        '11-6-session-race-state session B 的 state 沒有被慢回來的 session A checkout response 覆蓋',
        JSON.stringify({ postStarted, postCount, sessionBLoaded, loadedSessionCode, jsonReadsBeforeResolve, staleResponseProcessed, aResponseJsonReads, inFlightAfterStale, sessionCodeAtAssert: ctx.w.eval('popupSession && popupSession.public_code') }));
      assert(!ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), '11-6-session-race-no-success-screen session B 畫面上沒有出現 session A 的成功畫面', ctx.w.document.getElementById('popupRoot').textContent);
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-6-session-race'); ctx.cleanup(); }
  }

  // 7. Analytics：popup 不新增 begin_checkout，且不呼叫一般 checkout_click 觸發路徑
  //（本回合刻意不接 checkout_click——見程式內註解與本次回報；這裡只驗證
  // popup 送單流程完全沒有呼叫到一般 openCheckoutStep()/_trackEvent 那條路徑
  // 需要的 DOM 元素，證明兩邊互不干擾）。
  {
    const { ctx } = await setupCheckoutSession(null, (u, init, baseFetch) => {
      if (init && init.method === 'POST') return Promise.resolve({ ok: true, status: 201, json: async () => successCheckoutFixture({ order_number: 'w73isoobdjs8yymz' }) });
      return baseFetch(String(u), init);
    });
    try {
      assert(typeof ctx.w.eval('typeof begin_checkout') === 'string' && ctx.w.eval('typeof begin_checkout') === 'undefined', '11-7-no-begin-checkout 沒有新增 begin_checkout 函式/事件', ctx.w.eval('typeof begin_checkout'));
      fillPopupCheckoutForm(ctx);
      await waitFor(() => ctx.w.eval('popupValidateCheckout().ok') === true, { timeoutMs: 400 });
      ctx.w.document.getElementById('popupCheckoutSubmitBtn').click();
      const successReached = await waitFor(() => ctx.w.document.getElementById('popupRoot').textContent.includes('訂購成功'), { timeoutMs: 600 });
      const w73Marker = 'w73isoobdjs8yymz';
      const w73RootText = ctx.w.document.getElementById('popupRoot').textContent;
      const successShown = w73RootText.includes('訂購成功');
      const successMarkerShown = w73RootText.includes(w73Marker);
      assert(successReached === true && successShown && successMarkerShown && ctx.w.eval('cartUIStage') === 'cart', '11-7-no-general-stage-mutation popup 送單沒有動到一般 cartUIStage（兩套流程互不干擾）',
        JSON.stringify({ successReached, successShown, successMarkerShown, cartUIStage: String(ctx.w.eval('cartUIStage')) }));
    } finally { await ctx.settle(null, { timeoutMs: 250 }); assertNoUnexpectedErrors(ctx, '11-7-analytics-isolation'); ctx.cleanup(); }
  }

  console.log('\n[NOTE] 360px 版面與實際色彩對比度等視覺項目，jsdom 無法完整驗證，仍需在最終 Phase 3B gate 以真實瀏覽器 360px 視窗人工檢查，本測試不宣稱已完成視覺 QA。');
}

main()
  .then(printSummary)
  .catch((e) => { console.error('[FATAL]', e); fail('fatal', e.message); printSummary(); });
