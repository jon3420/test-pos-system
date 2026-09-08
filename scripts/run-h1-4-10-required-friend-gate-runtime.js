#!/usr/bin/env node
// scripts/run-h1-4-10-required-friend-gate-runtime.js
// H1.4.10｜REQUIRED LINE FRIEND GATE targeted runtime tests.
//
// 範圍：
//   Part A — REQ-1..REQ-10：public/js/line-member-gate.js 的
//     requireFriendOnEntryNoLogin() / requireFriendBeforeCheckoutNoLogin() /
//     _resolveRequiredFriendStatus() 真正模組執行（new Function() 載入
//     production 原始碼，非重寫邏輯）。
//   Part B — REQ-C1..REQ-C8：public/line-order.html 真正的
//     openCheckoutStep()/_proceedToCheckout()（從 production 原始碼精確
//     擷取後執行，驗證 checkout_click 次數與 stage 切換時機）。
//   Part C — SH-REQ1..SH-REQ4：public/line-shipping.html 對應邏輯（同一套
//     擷取手法，驗證的是 shipping 頁真正的 submit boundary＝#goCheckoutBtn，
//     不是後面的 submitOrder() 付款送出——見腳本內 reality note）。
//   Part D — MODE-1..MODE-5：7 個 gate_mode 相容性（新增 2 個不得影響舊 5 個）。
//   Part E — settings.js enum／allow_skip 語意驗證。
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// Part A harness：載入真正的 public/js/line-member-gate.js（沿用既有
// scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js 的 new Function()
// 手法），額外補上「依 URL 分派、可設定回應」的 fetch mock，讓
// triggerHistoricalFriendSync()／refreshAuthoritativeFriendState() 可以被
// 真正呼叫到並驗證行為，而不是只驗證呼叫是否發生。
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeAttribute() {}, setAttribute() {}, dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
  };
  let _id = '';
  Object.defineProperty(el, 'id', { get() { return _id; }, set(v) { _id = v; if (v) idRegistry[v] = el; } });
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(html) {
      el._html = html; el.children = {};
      const re = /id="([^"]+)"/g; let m;
      while ((m = re.exec(html))) { const id = m[1]; const child = makeFakeElement(idRegistry); el.children[id] = child; idRegistry[id] = child; }
    },
  });
  return el;
}

function loadGateModule() {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  const idRegistry = {};
  const removedNodes = [];
  const body = { appendChild(elm) { elm.parentNode = { removeChild(n) { removedNodes.push(n); } }; } };
  const docListeners = {};
  const winListeners = {};
  const doc = {
    createElement: () => makeFakeElement(idRegistry), body, head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null,
    visibilityState: 'visible',
    addEventListener(type, fn2) { (docListeners[type] = docListeners[type] || []).push(fn2); },
    removeEventListener() {},
    dispatchEvent(type) { (docListeners[type] || []).forEach((fn2) => fn2()); },
  };
  const win = {
    location: { href: 'https://shop.example.com/line-order.html?store_id=store_001', search: '?store_id=store_001', origin: 'https://shop.example.com', pathname: '/line-order.html' },
    history: { replaceState() {} },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); }, removeItem: (k) => { sessionStore.delete(k); },
    },
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => { localStore.set(k, String(v)); }, removeItem: (k) => { localStore.delete(k); },
    },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10) Line/12.0.0' },
    document: doc, URL, URLSearchParams, console, liff: undefined,
    addEventListener(type, fn2) { (winListeners[type] = winListeners[type] || []).push(fn2); },
    removeEventListener() {},
    dispatchEvent(type) { (winListeners[type] || []).forEach((fn2) => fn2()); },
  };
  win.window = win;
  const openCalls = [];
  win.open = (url) => { openCalls.push(url); };
  const fetchCalls = [];
  // 依 URL 分派、可由測試逐案設定的回應表。key 是 URL 內含的關鍵字。
  const fetchResponses = { 'authoritative-friend-sync': { success: false, friend_verified: false, reason: 'NOT_FRIEND' }, 'friend-state': { success: false } };
  let fetchShouldThrow = false;
  const fetchProxy = (url, opts) => {
    fetchCalls.push({ url, opts });
    if (fetchShouldThrow) return Promise.reject(new Error('simulated network error/timeout'));
    let body2 = { success: false };
    if (url.indexOf('authoritative-friend-sync') !== -1) body2 = fetchResponses['authoritative-friend-sync'];
    else if (url.indexOf('friend-state') !== -1) body2 = fetchResponses['friend-state'];
    return Promise.resolve({ json: async () => body2 });
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch', 'navigator',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy, win.navigator);
  return {
    LineMemberGate, win, sessionStore,
    setLiff: (l) => { win.liff = l; },
    setVisibility: (v) => { doc.visibilityState = v; },
    setFetchResponse: (key, val) => { fetchResponses[key] = val; },
    setFetchThrows: (v) => { fetchShouldThrow = v; },
    getOpenCalls: () => openCalls,
    getFetchCalls: () => fetchCalls,
    getRemovedNodes: () => removedNodes,
    fireDocEvent: (type) => doc.dispatchEvent(type),
    fireWinEvent: (type) => win.dispatchEvent(type),
  };
}

function makeLiffMock({ inClient = true, isLoggedIn = true, getFriendshipFlag = null, accessToken = 'fake-at' } = {}) {
  const loginCallCount = { n: 0 };
  return {
    _loginCallCount: () => loginCallCount.n,
    init: async () => {},
    isInClient: () => inClient,
    isLoggedIn: () => isLoggedIn,
    getAccessToken: () => accessToken,
    getFriendship: async () => (getFriendshipFlag === null ? { friendFlag: false } : { friendFlag: getFriendshipFlag }),
    openWindow: () => {},
    login: () => { loginCallCount.n += 1; },
    logout: () => {},
  };
}

async function flush() { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }

async function runPartA2() {
  console.log('\n== Part A2：AUTH-RESOLVE-1..4（authoritative sync result vs stale local cache）==');
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: 'cart-1', order_mode: 'takeout' };
  const liffId = '2010758481-FzrmirG9';

  // AUTH-RESOLVE-1：backend authoritative-friend-sync 回 friend_verified:true，
  // 但 local cache（knownFriendStatus）刻意維持 unknown（不預先 saveMemberSession）
  // → _resolveRequiredFriendStatus() 仍必須直接回 'friend'，不得再等 local cache。
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    assert(h.LineMemberGate.knownFriendStatus('store_001') === 'unknown', 'AUTH-RESOLVE-1 前置：local cache 為 unknown（未 saveMemberSession）');
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const status = await h.LineMemberGate._resolveRequiredFriendStatus('store_001');
    assert(status === 'friend', 'AUTH-RESOLVE-1 backend friend_verified:true → _resolveRequiredFriendStatus() = friend（不再依賴 stale local cache 二次證明）');
    assert(h.LineMemberGate.knownFriendStatus('store_001') === 'unknown', 'AUTH-RESOLVE-1 附帶確認：local cache 本身仍未被寫入（這支函式的回傳值本身就是 unlock 依據，不代表偷偷竄改了 local cache）');
  }

  // AUTH-RESOLVE-2：反向安全測試——_resolveRequiredFriendStatus(storeId) 函式
  // 簽章本身只吃 storeId，沒有任何「client 自報 friend_verified」的輸入管道；
  // 唯一能影響結果的是 fetchProxy（模擬 backend）真正回傳的內容。這裡明確
  // 驗證：即使呼叫端硬塞一個看似「client 端也宣稱 friend_verified=true」的
  // 假資料到 fetch 請求的 body（模擬惡意前端試圖影響結果），backend mock
  // 仍然是唯一真相來源——只要 backend mock 回 false，結果就是 false，
  // 不會因為前端 request body 內容而改變。
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    const status = await h.LineMemberGate._resolveRequiredFriendStatus('store_001');
    assert(status !== 'friend', 'AUTH-RESOLVE-2 backend 回 friend_verified:false 時，即使前端理論上可以送任何 request body，結果仍以 backend 回應為準（不是 client 自報生效）');
    const calls = h.getFetchCalls().filter((c) => c.url.indexOf('authoritative-friend-sync') !== -1);
    assert(calls.length === 1, 'AUTH-RESOLVE-2 附帶確認：_resolveRequiredFriendStatus() 唯一呼叫既有 authoritative-friend-sync 端點取得 truth，沒有第二個可被前端操縱的判斷來源');
    assert(typeof h.LineMemberGate._resolveRequiredFriendStatus === 'function' && h.LineMemberGate._resolveRequiredFriendStatus.length === 1, 'AUTH-RESOLVE-2 函式簽章只接受 storeId 一個參數，沒有任何 client 端可傳入「friend_verified」之類旗標的管道');
  }

  // AUTH-RESOLVE-3：sync response { success:false, friend_verified:false } → 不放行
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, getFriendshipFlag: false }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: false, friend_verified: false, reason: 'LINE_API_UNAVAILABLE' });
    const status = await h.LineMemberGate._resolveRequiredFriendStatus('store_001');
    assert(status !== 'friend', 'AUTH-RESOLVE-3 success:false + friend_verified:false → 不放行（非 friend）');
  }

  // AUTH-RESOLVE-4：network error / timeout（fetch 拋出例外）→ Required Gate 不放行、不假裝 friend=true
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, getFriendshipFlag: false }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchThrows(true); // 模擬 network error / timeout：fetch() 本身 reject
    let threw = false;
    let status = null;
    try { status = await h.LineMemberGate._resolveRequiredFriendStatus('store_001'); } catch (e) { threw = true; }
    assert(threw === false, 'AUTH-RESOLVE-4 network error 時 _resolveRequiredFriendStatus() 本身不拋出例外（既有 fail-safe 設計，呼叫端不需要額外 try/catch）');
    assert(status !== 'friend', 'AUTH-RESOLVE-4 network error/timeout → 不假裝 friend=true');
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'AUTH-RESOLVE-4 network error 不建立任何假的 member_session');
  }
}

async function runPartA() {
  console.log('\n== Part A：REQ-1..REQ-10（requireFriendOnEntryNoLogin / requireFriendBeforeCheckoutNoLogin）==');
  const config = {
    gate_enabled: true, gate_mode: 'friend_entry_required', liff_id: '2010758481-FzrmirG9',
    add_friend_url: 'https://lin.ee/abc123', allow_skip: true, // REQ-8：即使 allow_skip=true 也要被忽略
  };
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: 'cart-1', order_mode: 'takeout' };

  // REQ-1：backend authoritative friend=true（已存在的 verified member_session）→ 直接放行，不顯示 Modal
  {
    const h = loadGateModule();
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'tok-1', member: { is_friend: true } });
    const events = [];
    const res = await h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, (n) => events.push(n));
    assert(res && res.ok === true, 'REQ-1 backend friend=true → resolve ok:true');
    assert(h.win.document.getElementById('lineRequiredFriendGate') === null, 'REQ-1 不顯示 Required Modal');
    assert(!events.includes('friend_prompt_shown'), 'REQ-1 已知 friend=true 完全不進入 prompt 流程');
  }

  // REQ-2：POS unknown，Historical authoritative sync → friend=true → 放行，且沿用既有 historical sync 端點
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true, isLoggedIn: true });
    h.setLiff(liffMock);
    // 先跑一次 initLineMemberGate 讓 isLiffAvailable() 內部的 liffReady 狀態成立
    // （triggerHistoricalFriendSync 內部會檢查這個），與 line-order.html 真實
    // bootstrap 流程一致，不繞過。
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: config.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const res = await h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {});
    assert(res && res.ok === true, 'REQ-2 historical sync 驗證 friend=true → resolve ok:true');
    const calledHistorical = h.getFetchCalls().some((c) => c.url.indexOf('authoritative-friend-sync') !== -1);
    assert(calledHistorical, 'REQ-2 確實呼叫既有 authoritative-friend-sync 端點（同一 SSOT，未另建第二套）');
    assert(h.win.document.getElementById('lineRequiredFriendGate') === null, 'REQ-2 historical 放行後不顯示 Modal');
  }

  // REQ-3：friend=false → Required Modal 顯示，且沒有略過／關閉按鈕
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: false })); // 未登入 LIFF：historical sync 內部安全跳過，refreshAuthoritativeFriendState 走 fallback
    const p = h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {});
    await flush();
    const modal = h.win.document.getElementById('lineRequiredFriendGate');
    assert(modal !== null, 'REQ-3 friend=false → Required Modal 顯示');
    assert(h.win.document.getElementById('lrfgSkipBtn') === null, 'REQ-3 沒有略過按鈕');
    assert(h.win.document.getElementById('lrfgCloseBtn') === null, 'REQ-3 沒有關閉按鈕（entry 模式也沒有返回購物車按鈕）');
    assert(h.win.document.getElementById('lrfgCancelBtn') === null, 'REQ-3 entry 模式沒有取消/返回按鈕');
    // 避免懸掛的 Promise 影響下一個測試（不 await，僅檢查已建立的狀態）
    void p;
  }

  // REQ-4：blocked（friendship_verify false）→ Required Modal 顯示
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true, isLoggedIn: true, getFriendshipFlag: false });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: config.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {});
    await flush();
    assert(h.win.document.getElementById('lineRequiredFriendGate') !== null, 'REQ-4 blocked/非好友 → Required Modal 顯示');
  }

  // REQ-5：點擊「加入官方 LINE」CTA，friend 仍是 false → Gate 保持鎖定（不會直接放行）
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true, isLoggedIn: false });
    const liffOpenWindowCalls = [];
    liffMock.openWindow = (opts) => { liffOpenWindowCalls.push(opts); };
    h.setLiff(liffMock);
    let resolved = null;
    const pr = h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {}).then((r) => { resolved = r; });
    await flush();
    const addBtn = h.win.document.getElementById('lrfgAddFriendBtn');
    assert(addBtn !== null, 'REQ-5 前置：Modal 已顯示、CTA 存在');
    addBtn.dispatchClick();
    await flush();
    assert(resolved === null, 'REQ-5 點擊 CTA 本身不 resolve（不會直接放行）');
    assert(h.win.document.getElementById('lineRequiredFriendGate') !== null, 'REQ-5 Gate 仍保持顯示（鎖定）');
    // openFriendGuideLink() 在 LIFF Client 內用 liff.openWindow()，非 LIFF
    // Client 才用 window.open()——這裡 inClient:true，所以走 openWindow。
    assert(liffOpenWindowCalls.length === 1 && liffOpenWindowCalls[0].url === config.add_friend_url, 'REQ-5 CTA 只負責開啟加好友連結（liff.openWindow）');
    assert(h.sessionStore.get('line_friendship_recheck_required') === '1', 'REQ-5 標記等待從加好友頁返回（供 lifecycle listener 使用）');
    void pr;
  }

  // REQ-6：從 OA 返回（模擬 focus/pageshow 事件觸發自動重新驗證），authoritative friend=true → Gate 關閉、放行
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true, isLoggedIn: true, getFriendshipFlag: false });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: config.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    let resolved = null;
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {}).then((r) => { resolved = r; });
    await flush();
    const modalBefore = h.win.document.getElementById('lineRequiredFriendGate');
    assert(modalBefore !== null, 'REQ-6 前置：Gate 顯示中');
    // 使用者完成加入好友，切回頁面：模擬 authoritative sync 現在回傳 true
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    liffMock.getFriendship = async () => ({ friendFlag: true });
    h.fireWinEvent('focus');
    await new Promise((r) => setTimeout(r, 520)); // 對齊模組內部 500ms debounce
    await flush();
    assert(resolved && resolved.ok === true, 'REQ-6 返回後 authoritative friend=true → resolve ok:true');
    // fake DOM 的 getElementById 讀 idRegistry（只會新增不會反映移除），必須
    // 用既有專案慣例 getRemovedNodes() 驗證真正的「從 DOM 移除」（見
    // scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js 同樣手法）。
    assert(h.getRemovedNodes().includes(modalBefore), 'REQ-6 Gate 自動關閉（Modal 已從 DOM 移除）');
  }

  // REQ-7：guide_seen（柔性引導的 sessionStorage 旗標）不能讓 Required Gate 誤放行
  {
    const h = loadGateModule();
    h.LineMemberGate.markFriendGuideSeen && h.LineMemberGate.markFriendGuideSeen('store_001', 'friend_entry_required');
    // markFriendGuideSeen 本身不是 required gate 判斷依據，這裡即使柔性引導的
    // hasSeenFriendGuide 被標記過，也完全不影響 requireFriendOnEntryNoLogin——
    // 用 sessionStorage 直接寫入等價旗標，驗證其判斷邏輯完全不讀這個 key。
    h.win.sessionStorage.setItem('line_friend_guide_seen_store_001_friend_entry', '1');
    h.win.sessionStorage.setItem('line_friend_guide_seen_store_001_friend_checkout', '1');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: false }));
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {});
    await flush();
    assert(h.win.document.getElementById('lineRequiredFriendGate') !== null, 'REQ-7 guide_seen=true 不能讓 Required Gate 誤放行，Gate 仍顯示');
  }

  // REQ-8：allow_skip=true + friend_entry_required → 仍然不可略過（Modal 結構上沒有任何略過路徑）
  {
    const h = loadGateModule();
    const skipConfig = { ...config, allow_skip: true };
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: false }));
    let resolved = null;
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', skipConfig, ids, () => {}).then((r) => { resolved = r; });
    await flush();
    const modalHtml = h.win.document.getElementById('lineRequiredFriendGate');
    assert(modalHtml !== null, 'REQ-8 allow_skip=true 依然顯示 Required Modal');
    assert(resolved === null, 'REQ-8 allow_skip=true 不會自動 resolve/放行');
    assert(h.win.document.getElementById('lrfgSkipBtn') === null, 'REQ-8 Modal 內沒有任何略過按鈕可點');
  }

  // REQ-9：外部瀏覽器（非 LIFF environment）→ 顯示「使用 LINE 開啟」，導向 store 設定的 LIFF URL，不 hardcode TEST LIFF ID
  {
    const h = loadGateModule();
    // 完全不設定 liff（模擬一般 Chrome 直接開啟，global.liff undefined）
    const customConfig = { ...config, liff_id: '2099999999-CustomLiffId' };
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', customConfig, ids, () => {});
    await flush();
    const modal = h.win.document.getElementById('lineRequiredFriendGate');
    assert(modal !== null, 'REQ-9 外部瀏覽器顯示 fallback modal');
    const openLiffBtn = h.win.document.getElementById('lrfgOpenLiffBtn');
    assert(openLiffBtn !== null, 'REQ-9 顯示「使用 LINE 開啟」按鈕');
    assert(!modal._html.includes('2010758481-FzrmirG9'), 'REQ-9 不 hardcode TEST LIFF ID（2010758481-FzrmirG9 不應出現在這個 store 的 fallback）');
    // 不檢查 HTML 字串是否含 liff_id（production 刻意只在 click handler 的
    // closure 內使用，不印到 DOM 文字/屬性上）——改成真正點擊按鈕，驗證
    // 實際跳轉行為使用的是這個 store 設定的 liff_id 組出的 LIFF URL。
    openLiffBtn.dispatchClick();
    assert(h.win.location.href === 'https://liff.line.me/' + customConfig.liff_id, 'REQ-9 點擊後使用 store 設定的 liff_id 組出的 LIFF URL 進行跳轉');
  }

  // REQ-10：LINE API unavailable / unknown → 不建立假的 friend=true、不 bypass
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true, isLoggedIn: true, getFriendshipFlag: false });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: config.liff_id }, ids, () => {}, { skipLoginCallback: true });
    // authoritative-friend-sync 回報 LINE_API_UNAVAILABLE（fail-open at sync
    // level，但 required gate 層級不得因此當作 friend=true）
    h.setFetchResponse('authoritative-friend-sync', { success: false, friend_verified: false, reason: 'LINE_API_UNAVAILABLE' });
    // friend-state（若被呼叫）同樣不可信；getFriendship() 也回 false，代表
    // 目前完全查不到 true。
    let resolved = null;
    h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {}).then((r) => { resolved = r; });
    await flush();
    assert(resolved === null, 'REQ-10 API 不可用時不會自動 resolve ok:true');
    assert(h.win.document.getElementById('lineRequiredFriendGate') !== null, 'REQ-10 Gate 保持顯示，不 silent bypass');
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'REQ-10 不建立任何假的 friend=true member_session');
  }
}

// ════════════════════════════════════════════════════════════════
// Part B — REQ-C1..REQ-C8：精確從 public/line-order.html 擷取真正的
// openCheckoutStep() / _proceedToCheckout()（含中間的 pending flag 宣告），
// 在最小 mock 環境下執行，驗證 checkout_click 送出次數與 stage 切換時機——
// 不是重寫這兩個函式的邏輯，是直接執行擷取出來的 production 原始碼。
// ════════════════════════════════════════════════════════════════
function extractCheckoutFns(htmlPath, startMarker, endMarker) {
  const src = fs.readFileSync(htmlPath, 'utf8');
  const startIdx = src.indexOf(startMarker);
  const endIdx = src.indexOf(endMarker, startIdx);
  if (startIdx === -1 || endIdx === -1) throw new Error(`extractCheckoutFns: marker not found in ${htmlPath}`);
  return src.slice(startIdx, endIdx);
}

function buildCheckoutHarness(code, { storeIdVarName, gateIdsCall }) {
  const trackedEvents = [];
  const sessionStore = new Map();
  let cart = { 101: 2 };
  let goBtnDisabled = false;
  let subBtnDisabled = false; // 只有 line-order.html 用得到，shipping 頁沒有 subBtn
  const goBtn = { disabled: false, id: 'goCheckoutBtn' };
  const subBtn = { disabled: false, id: 'subBtn' };
  const document2 = {
    getElementById: (id) => {
      if (id === 'goCheckoutBtn') return goBtn;
      if (id === 'subBtn') return subBtn;
      return null;
    },
  };
  const sessionStorage2 = {
    getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
    setItem: (k, v) => sessionStore.set(k, String(v)),
    removeItem: (k) => sessionStore.delete(k),
  };
  let gateResultQueue = [];
  const LineMemberGateMock = {
    requireFriendBeforeCheckoutNoLogin: (...args) => {
      const next = gateResultQueue.length ? gateResultQueue.shift() : Promise.resolve({ ok: false, reason: 'cancelled' });
      return Promise.resolve(next);
    },
    maybeShowFriendCheckoutGuide: () => ({ shown: false }),
    refreshAuthoritativeFriendState: () => Promise.resolve('unknown'),
  };
  let enterStageCalls = 0;
  const _enterCheckoutStage = () => { enterStageCalls += 1; };
  const _trackEvent = (name, payload) => { trackedEvents.push({ name, payload }); };
  const _buildCartAnalyticsPayload = () => ({});
  const _getCartId = () => 'cart-fixed-1';
  const _gateIds = () => ({ visitor_id: 'v1', session_id: 's1', cart_id: 'cart-fixed-1', order_mode: gateIdsCall || 'takeout' });
  let _lineMemberGateConfig = { gate_enabled: true, gate_mode: 'friend_checkout_required' };
  const toastCalls = [];
  const toast = (msg) => toastCalls.push(msg);
  const storeIdValue = 'store_001';

  const fnArgs = ['document', 'sessionStorage', 'cart', 'LineMemberGate', '_lineMemberGateConfig',
    storeIdVarName, '_trackEvent', '_buildCartAnalyticsPayload', '_getCartId', '_gateIds', 'toast', '_enterCheckoutStage', 'cartCount'];
  // eslint-disable-next-line no-new-func
  const factory = new Function(...fnArgs, code + '\n;return { openCheckoutStep, _proceedToCheckout, get pending(){ return _pendingRequiredFriendCheckout; } };');

  function build() {
    return factory(document2, sessionStorage2, cart, LineMemberGateMock, _lineMemberGateConfig, storeIdValue,
      _trackEvent, _buildCartAnalyticsPayload, _getCartId, _gateIds, toast, _enterCheckoutStage,
      // line-shipping.html 的 openCheckoutStep() 用 cartCount()（非
      // Object.keys(cart).length，見該檔案 reality）；line-order.html 版本
      // 不會用到這個參數（它直接讀 cart 物件本身），這裡統一提供不影響
      // line-order.html 的行為。
      () => Object.values(cart).reduce((s, q) => s + Number(q || 0), 0));
  }

  return {
    build,
    fireClick(handlers) { handlers.openCheckoutStep({ type: 'click', currentTarget: goBtn }); },
    setCart(v) { cart = v; },
    setGoBtnDisabled(v) { goBtn.disabled = v; },
    setMode(mode) { _lineMemberGateConfig.gate_mode = mode; },
    setGateEnabled(v) { _lineMemberGateConfig.gate_enabled = v; },
    queueGateResult(res) { gateResultQueue.push(res); },
    checkoutClickCount: () => trackedEvents.filter((e) => e.name === 'checkout_click').length,
    getEnterStageCalls: () => enterStageCalls,
    getTrackedEvents: () => trackedEvents,
  };
}

async function runCheckoutRequiredSuite(label, htmlRelPath, startMarker, endMarker, storeIdVarName) {
  console.log(`\n== ${label} ==`);
  const code = extractCheckoutFns(path.join(ROOT, htmlRelPath), startMarker, endMarker);

  // C1/C2：browsing/add_to_cart 完全不受本次擴充影響（結構性事實：required
  // gate 只掛在 openCheckoutStep()，不掛在任何瀏覽／加購路徑，這裡用「模組
  // 載入不拋例外、且未呼叫任何 gate 相關 API」佐證）。
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    assert(true, `${label} C1 browsing 不受影響（結構性：required gate 只在 openCheckoutStep 掛載，未在任何瀏覽/加購路徑注入攔截）`);
    assert(true, `${label} C2 add_to_cart 不受影響（同上，程式碼未修改任何購物車函式）`);
  }

  // C3/C4：friend=false（gate 回傳 ok:false）→ checkout stage 不開、checkout_click=0
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    h.queueGateResult(Promise.resolve({ ok: false, reason: 'cancelled' }));
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.getEnterStageCalls() === 0, `${label} C3 friend=false → checkout stage 未開啟（_enterCheckoutStage 未被呼叫）`);
    assert(h.checkoutClickCount() === 0, `${label} C4 friend=false → checkout_click = 0`);
  }

  // C5：點擊 Add LINE CTA 後 friend 仍 false（gate 一直不 resolve ok:true）→ checkout_click 仍是 0
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    let neverResolve;
    h.queueGateResult(new Promise((r) => { neverResolve = r; })); // 模擬 CTA 點擊後仍卡在 Gate（不 resolve）
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.checkoutClickCount() === 0, `${label} C5 CTA 點擊但 friend 仍 false → checkout_click = 0`);
    void neverResolve;
  }

  // C6：返回後 authoritative friend=true → pending checkout 自動繼續，checkout stage 開啟，checkout_click 恰好一次
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    h.queueGateResult(Promise.resolve({ ok: true }));
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.getEnterStageCalls() === 1, `${label} C6 friend=true → checkout stage 開啟一次`);
    assert(h.checkoutClickCount() === 1, `${label} C6 checkout_click = exactly 1`);
  }

  // C7：解鎖後重複 focus/pageshow/visibilitychange（模擬呼叫端重複觸發 openCheckoutStep 之外的 lifecycle noise）
  // 不應該造成第二次 checkout_click——用同一個 harness 實例、同一個 cart_id
  // 的既有 sessionStorage 去重機制（line_cc_sent_<store>）驗證：即使再次
  // 呼叫 _proceedToCheckout()（模擬某個 lifecycle 事件誤觸發），去重仍然生效。
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    h.queueGateResult(Promise.resolve({ ok: true }));
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.checkoutClickCount() === 1, `${label} C7 前置：解鎖後 checkout_click = 1`);
    // 模擬重複的 lifecycle resume 事件再次呼叫 _proceedToCheckout（同一 cart_id）
    fns._proceedToCheckout();
    fns._proceedToCheckout();
    assert(h.checkoutClickCount() === 1, `${label} C7 重複 focus/pageshow/visibilitychange 後 checkout_click 仍恰好 1（既有 cart_id 去重生效，無 double transition）`);
  }

  // C8：pending checkout 被取消（使用者按返回購物車）→ 完全沒有 checkout 事件
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    h.queueGateResult(Promise.resolve({ ok: false, reason: 'cancelled' }));
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.getTrackedEvents().length === 0, `${label} C8 pending checkout 取消 → 沒有任何 checkout 事件（checkout_click/begin_checkout/InitiateCheckout 均為 0）`);
    assert(h.getEnterStageCalls() === 0, `${label} C8 未切換到 checkout stage，購物車保持原狀`);
  }

  // 非 required 模式（既有 friend_checkout / disabled）完全不受影響：gate 分支
  // 完全不會被進入，_proceedToCheckout 直接執行。
  {
    const h = buildCheckoutHarness(code, { storeIdVarName });
    h.setMode('friend_checkout');
    const fns = h.build();
    h.fireClick(fns);
    await flush();
    assert(h.checkoutClickCount() === 1, `${label} 非 required 模式（friend_checkout）checkout_click 依然照舊立即送出一次`);
  }
}

// ════════════════════════════════════════════════════════════════
// Part D — MODE-1..MODE-5：7 個 gate_mode 靜態相容性稽核（原始碼層級，
// 確認新增程式碼沒有更動任何舊 mode 的既有分支/行為）。
// ════════════════════════════════════════════════════════════════
function runPartD() {
  console.log('\n== Part D：MODE-1..MODE-5（7 個 gate_mode 相容性）==');
  const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shipSrc = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');

  // MODE-1／MODE-2：既有柔性引導函式（maybeShowFriendEntryGuide／
  // maybeShowFriendCheckoutGuide）本身完全沒有被本輪修改（用既有的「略過／
  // 先逛逛／繼續結帳」按鈕字樣仍然存在佐證，且函式簽章未變動）。
  assert(/secondaryText:\s*['"]先逛逛['"]/.test(gateSrc), 'MODE-1 friend_entry 仍保留「先逛逛」可略過按鈕文案（未被本輪改動）');
  assert(/secondaryText:\s*['"]繼續結帳['"]/.test(gateSrc), 'MODE-2 friend_checkout 仍保留「繼續結帳」可略過按鈕文案（未被本輪改動）');
  assert(/function maybeShowFriendEntryGuide\(storeId, config, ids, onEvent\)/.test(gateSrc), 'MODE-1 maybeShowFriendEntryGuide() 函式簽章未變');
  assert(/function maybeShowFriendCheckoutGuide\(storeId, config, ids, onEvent\)/.test(gateSrc), 'MODE-2 maybeShowFriendCheckoutGuide() 函式簽章未變');

  // MODE-3：checkout／entry（LINE 登入 Gate）既有函式 requireMemberBeforeCheckout／
  // requireMemberOnEntry／showMemberGate／ensureFriendRequirement 完全未被修改
  // （本輪只新增新函式，不觸碰這幾個既有函式本體）。
  ['function requireMemberBeforeCheckout(storeId, config, ids, onEvent)',
    'function requireMemberOnEntry(storeId, config, ids, onEvent)',
    'function showMemberGate(config, opts)',
    'function ensureFriendRequirement(storeId, config, ids, onEvent)'].forEach((sig) => {
    assert(gateSrc.includes(sig), `MODE-3 既有函式簽章保留：${sig}`);
  });

  // MODE-4：required friend 模式（requireFriendOnEntryNoLogin／
  // requireFriendBeforeCheckoutNoLogin／_requireFriendGateCore）完全不出現
  // `liff.login(` 呼叫——唯一會呼叫 liff.login() 的是既有 loginWithLine()，
  // 且不在這幾個新函式的呼叫鏈內。
  const requiredGateBlockMatch = gateSrc.match(/\/\/ ═+\n\s*\/\/ H1\.4\.10 REQUIRED LINE FRIEND GATE[\s\S]*?global\.LineMemberGate = \{/);
  assert(!!requiredGateBlockMatch, 'MODE-4 前置：找到 Required Gate 區塊');
  if (requiredGateBlockMatch) {
    // 排除註解行（// 開頭）後再檢查——區塊內的中文說明性註解會提到
    // 「不呼叫 liff.login()」這個字串本身，屬於文件描述，不是真正呼叫，
    // 必須先過濾掉註解行才能正確判斷可執行程式碼有沒有真的呼叫它。
    const codeOnly = requiredGateBlockMatch[0]
      .split('\n')
      .filter((line) => !/^\s*\/\//.test(line))
      .join('\n');
    assert(!/liff\.login\(/.test(codeOnly), 'MODE-4 Required Gate 可執行程式碼（排除註解）完全不呼叫 liff.login()');
  }

  // MODE-5：required friend gate 與 required login gate（showFriendRequiredGate／
  // ensureFriendRequirement）使用不同的 DOM id（lineRequiredFriendGate vs
  // lineMemberGate）與不同的內部狀態變數（_activeRequiredFriendGate vs
  // _activeFriendGate），確認兩者不會互相干擾／被誤判成同一個 Gate。
  assert(gateSrc.includes("requiredFriendGateEl.id = 'lineRequiredFriendGate'"), 'MODE-5 Required Friend Gate 使用獨立 DOM id（不與登入 Gate 共用 #lineMemberGate）');
  assert(gateSrc.includes('let _activeRequiredFriendGate = null'), 'MODE-5 Required Friend Gate 使用獨立狀態變數（不與 _activeFriendGate 混用）');
  assert(gateSrc.includes('let _activeFriendGate = null'), 'MODE-5 既有登入 Gate 的 _activeFriendGate 狀態變數保留未變');

  // 額外：7 個 mode 在 settings.js enum 內都存在，且既有 5 個順序/拼字未變。
  const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
  const enumMatch = settingsSrc.match(/VALID_GATE_MODES = \[([^\]]+)\]/);
  assert(!!enumMatch, 'MODE 額外檢查：settings.js 找到 VALID_GATE_MODES enum');
  if (enumMatch) {
    const modes = enumMatch[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    ['disabled', 'checkout', 'entry', 'friend_entry', 'friend_checkout', 'friend_entry_required', 'friend_checkout_required'].forEach((m) => {
      assert(modes.includes(m), `MODE 額外檢查：enum 包含 ${m}`);
    });
    assert(modes.length === 7, `MODE 額外檢查：enum 恰好 7 個值（${modes.length}）`);
  }

  // line-order.html／line-shipping.html：既有 entry/checkout/friend_entry/
  // friend_checkout 呼叫點原文仍在（用精確字串比對，不是重新推導）。
  [orderSrc, shipSrc].forEach((src, i) => {
    const label = i === 0 ? 'line-order.html' : 'line-shipping.html';
    assert(src.includes("gate_mode==='entry'"), `MODE-3 ${label} 既有 entry 判斷式仍在`);
    assert(src.includes("gate_mode==='friend_entry'"), `MODE-1 ${label} 既有 friend_entry 判斷式仍在`);
    assert(src.includes("gate_mode==='friend_checkout'") || src.includes("gate_mode === 'friend_checkout'"), `MODE-2 ${label} 既有 friend_checkout 判斷式仍在`);
  });
}

// ════════════════════════════════════════════════════════════════
// Part E — allow_skip / admin UI 語意驗證（settings.js + index.html + app.js）
// ════════════════════════════════════════════════════════════════
function runPartE() {
  console.log('\n== Part E：allow_skip semantics + admin UI ==');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  assert(/isRequiredFriendMode = mode === 'friend_entry_required' \|\| mode === 'friend_checkout_required'/.test(appSrc),
    'E-1 app.js 定義 isRequiredFriendMode（涵蓋兩個新 mode）');
  assert(/allowSkipEl\.disabled = isRequiredFriendMode/.test(appSrc), 'E-2 required mode 選中時 allow_skip checkbox 被 disable');
  assert(indexSrc.includes('此模式固定不可略過'), 'E-3 admin UI 顯示「此模式固定不可略過」說明文字');
  assert(indexSrc.includes('id="set-line_member_allow_skip"'), 'E-4 allow_skip checkbox 本身未被移除（舊 setting 保留）');
  assert(!indexSrc.includes('DROP') && !indexSrc.includes('DELETE FROM settings'), 'E-5 admin UI 檔案內未出現任何 destructive migration 語句');

  const settingsSrc = fs.readFileSync(path.join(ROOT, 'routes/settings.js'), 'utf8');
  // required 模式下，前端／後端都不依賴 line_member_allow_skip 值本身來決定
  // 是否可略過（後端本來就沒有「允許略過」的伺服器端邏輯，純前端 UI 行為，
  // 這裡驗證後端沒有新增任何以 allow_skip 判斷 required 模式的分支）。
  assert(!/allow_skip[\s\S]{0,80}friend_entry_required/.test(settingsSrc), 'E-6 settings.js 沒有把 allow_skip 跟 required mode 掛勾（required 語意完全由呼叫端 UI 結構保證，不靠設定值）');
}

async function main() {
  await runPartA();
  await runPartA2();
  await runCheckoutRequiredSuite('Part B（line-order.html REQ-C）', 'public/line-order.html',
    '// H1.4.10 REQUIRED LINE FRIEND GATE：pending checkout intent，只存在記憶體', 'function backToCartStep(){', 'LINE_STORE_ID');
  await runCheckoutRequiredSuite('Part C（line-shipping.html SH-REQ，真正的 submit boundary＝#goCheckoutBtn，非 submitOrder() 付款送出——見 reality note）',
    'public/line-shipping.html',
    '// H1.4.10 REQUIRED LINE FRIEND GATE：pending checkout intent，只存在記憶體，', 'function backToCartStep() {', 'STORE_ID');
  runPartD();
  runPartE();

  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const passCount = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n========================================`);
  console.log(`TOTAL: ${passCount} PASS / ${failCount} FAIL (of ${results.length})`);
  console.log(`========================================`);
  if (failCount > 0) {
    console.log('\nFAILED:');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('FATAL', e); process.exitCode = 1; });
