#!/usr/bin/env node
// scripts/run-h1-4-10-friend-live-runtime.js
// H1.4.10 hotfix30-B5-R5.4-FRIEND-LIVE — FRIEND-LIVE-1～10
//
// 只涵蓋 public/js/line-member-gate.js 的 refreshAuthoritativeFriendState()
// precedence（Backend authoritative refresh > LIFF getFriendship() >
// unknown），用可控制回應內容的 fetch mock 模擬 POST
// /api/line-member/friend-state / /friend-conflict 兩個新端點的回應，
// 不重跑真實後端（那部分見 run-h1-4-10-friend-sec-mig-runtime.js）。
//
// 沿用 scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js 的 harness
// 手法（相同的 module-loading / fake DOM 技巧），這裡獨立成一支檔案是為了
// 讓 fetch mock 可以依測試情境回傳不同的 /friend-state JSON。

'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name, detail) { results.push({ name, status: 'PASS', detail }); console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name, detail) : fail(name, detail); }

function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeAttribute() {}, setAttribute() {}, dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
  };
  let _id = '';
  Object.defineProperty(el, 'id', {
    get() { return _id; },
    set(v) { _id = v; if (v) idRegistry[v] = el; },
  });
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

// fetchRouter(url, opts) => object | null（null 表示走 default {success:false}）
function loadGateModule(fetchRouter) {
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
  let openCalls = [];
  win.open = (url) => { openCalls.push(url); };
  let fetchCalls = [];
  const fetchProxy = (...args) => {
    fetchCalls.push({ url: args[0], opts: args[1] });
    const routed = fetchRouter ? fetchRouter(args[0], args[1]) : null;
    return { json: async () => (routed !== null && routed !== undefined ? routed : { success: false }) };
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch', 'navigator',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy, win.navigator);
  return {
    LineMemberGate, win, sessionStore, localStore,
    setLiff: (l) => { win.liff = l; },
    getOpenCalls: () => openCalls,
    getFetchCalls: () => fetchCalls,
    getRemovedNodes: () => removedNodes,
    fireDocEvent: (type) => doc.dispatchEvent(type),
    fireWinEvent: (type) => win.dispatchEvent(type),
  };
}

function makeLiffMock({ inClient = true, friendFlag = true, throwOnGetFriendship = false } = {}) {
  return {
    init: async () => {},
    isInClient: () => inClient,
    isLoggedIn: () => true,
    getAccessToken: () => 'fake-at',
    getFriendship: async () => {
      if (throwOnGetFriendship) throw new Error('simulated LIFF error');
      return { friendFlag };
    },
    openWindow: () => {},
    login: () => {},
    logout: () => {},
  };
}

async function main() {
  const config = {
    gate_enabled: true, gate_mode: 'friend_entry', liff_id: 'x',
    add_friend_url: 'https://lin.ee/abc123',
  };
  const checkoutConfig = { ...config, gate_mode: 'friend_checkout' };
  const ids = { visitor_id: 'v1', session_id: 's1', order_mode: 'takeout' };

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-1：local session friend=unknown, backend DB friend=true
  // → backend refresh true → guide 0
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: true, friend_status: 'friend', last_friend_check_at: '2026-09-01 00:00:00' };
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: null, member: { is_friend: null } });
    assert(h.LineMemberGate.knownFriendStatus('store_001') === 'unknown', 'FRIEND-LIVE-1 前置：local session 目前是 unknown');
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FRIEND-LIVE-1a local unknown + backend DB true → refresh 回傳 friend');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === false, 'FRIEND-LIVE-1b backend refresh true → guide 0 次', `reason=${r.reason}`);
    assert(h.LineMemberGate.getMemberSession('store_001').is_friend === true, 'FRIEND-LIVE-1c 本地快取也同步更新為 true（不用等下一次完整 verify）');
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-2：local stale false/unknown, backend true → backend wins
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: true, friend_status: 'friend', last_friend_check_at: '2026-09-01 00:00:00' };
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: false, member: { is_friend: false } });
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FRIEND-LIVE-2 local stale false + backend DB true → backend wins（不被本地舊值卡住）');
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-3：backend unknown, LIFF getFriendship=true → guide 0
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: null, friend_status: 'unknown', last_friend_check_at: '' };
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: null, member: { is_friend: null } });
    h.setLiff(makeLiffMock({ inClient: true, friendFlag: true }));
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FRIEND-LIVE-3a backend unknown + LIFF getFriendship=true → refresh 回傳 friend');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === false, 'FRIEND-LIVE-3b guide 0 次', `reason=${r.reason}`);
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-4：backend unknown, LIFF getFriendship=false → guide allowed
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: null, friend_status: 'unknown', last_friend_check_at: '' };
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: null, member: { is_friend: null } });
    h.setLiff(makeLiffMock({ inClient: true, friendFlag: false }));
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'unknown', 'FRIEND-LIVE-4a backend unknown + LIFF getFriendship=false → refresh 回傳 unknown（不誤判）');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FRIEND-LIVE-4b guide allowed（friend_entry 正常顯示）', `reason=${r.reason}`);
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-5：backend false, LIFF true → guide 0，backend friend 不被
  // client 強制改 true，只做 conflict audit（呼叫 /friend-conflict 一次）。
  // ══════════════════════════════════════════════════════════════
  {
    let conflictCalls = 0;
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-conflict')) { conflictCalls += 1; return { success: true, data: { logged: true } }; }
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: false, member: { is_friend: false } });
    h.setLiff(makeLiffMock({ inClient: true, friendFlag: true }));
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FRIEND-LIVE-5a backend false + LIFF true → UX 仍視為 friend（guide 0）');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === false, 'FRIEND-LIVE-5b guide 0 次', `reason=${r.reason}`);
    assert(conflictCalls === 1, 'FRIEND-LIVE-5c 呼叫一次 /friend-conflict 留下稽核紀錄（不直接改 backend friend）', `calls=${conflictCalls}`);
    // is_friend 本地快取沿用 backend false 的事實（沒有被 client 訊號蓋成 true），
    // reconcileFriendGuide() 是靠 hasSeenFriendGuide 標記抑制顯示，不是竄改 session 內容。
    assert(h.LineMemberGate.getMemberSession('store_001').is_friend === false, 'FRIEND-LIVE-5d 本地 session 快取仍誠實反映 backend 目前是 false（沒有被就地竄改成 true）');
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-6：click「加入官方 LINE」→ 不直接 friend=true
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule(() => ({ success: false }));
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FRIEND-LIVE-6 前置：guide 顯示');
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'FRIEND-LIVE-6 點擊「加入官方 LINE」後仍然沒有任何 member_session（click != friendship，不直接 friend=true）');
    assert(h.LineMemberGate.knownFriendStatus('store_001') === 'unknown', 'FRIEND-LIVE-6b knownFriendStatus 仍是 unknown（沒有被點擊本身竄改）');
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-9（前端半段）：一支全新的 refresh 呼叫（模擬 Follow Webhook
  // 之後的下一次 LIFF bootstrap）必須真的打 /friend-state，讀到後端目前值，
  // 不是只讀本地快取就結束。
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: true, friend_status: 'friend', last_friend_check_at: '2026-09-06 00:00:00' };
      return { success: false };
    });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: null, member: { is_friend: null } });
    const before = h.getFetchCalls().length;
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    const after = h.getFetchCalls().length;
    assert(after - before === 1, 'FRIEND-LIVE-9a refresh 確實呼叫一次 /friend-state（不是只讀本地快取）', `before=${before} after=${after}`);
    assert(state === 'friend', 'FRIEND-LIVE-9b 讀到 backend 最新 true');
  }

  // ══════════════════════════════════════════════════════════════
  // FRIEND-LIVE-10：foreground pageshow/focus/visibility burst →
  // refresh 本身的 debounce/in-flight guard（既有 attemptAutoFriendshipResume
  // 機制，本輪未變更）依然只送出一次 verify 請求，不因為新增 /friend-state
  // 呼叫而變成 API storm。
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule((url) => {
      if (String(url).includes('/friend-state')) return { success: true, is_friend: false, friend_status: 'non_friend', last_friend_check_at: '' };
      return { success: false };
    });
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FRIEND-LIVE-10 前置：guide 開著');
    h.setLiff({
      init: async () => {}, isInClient: () => true, isLoggedIn: () => true,
      getAccessToken: () => 'fake-at', getIDToken: () => 'a.b.c',
      getFriendship: async () => ({ friendFlag: true }),
      openWindow: () => {}, login: () => {}, logout: () => {},
    });
    const before = h.getFetchCalls().length;
    h.fireDocEvent('visibilitychange');
    h.fireWinEvent('pageshow');
    h.fireWinEvent('focus');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const after = h.getFetchCalls().length;
    // attemptAutoFriendshipResume() 內部的 debounce/in-flight guard 走的是
    // recheckFriendship()/verifyWithBackend()（打 /verify），不是本輪新增的
    // /friend-state；這裡驗證的是「burst 不會造成 API storm」這個既有保證
    // 本身沒有被本輪修改破壞——恰好只送出一次請求。
    assert(after - before === 1, 'FRIEND-LIVE-10 burst 後仍然只送出一次請求（既有 debounce/in-flight guard 沒有被破壞）', `before=${before} after=${after}`);
  }

  // ══════════════════════════════════════════════════════════════
  // 額外：getFriendship() 拋錯時，Safe Client Diagnostic snapshot 能看到
  // called=true／friendFlag=null／error code（TASK 4／真機案例 CASE B）。
  // ══════════════════════════════════════════════════════════════
  {
    const h = loadGateModule(() => ({ success: false }));
    h.setLiff(makeLiffMock({ inClient: true, throwOnGetFriendship: true }));
    await h.LineMemberGate.getClientFriendFlag();
    const snap = h.LineMemberGate.getFriendDiagnosticSnapshot();
    assert(snap.getFriendshipCalled === true, 'DIAG-1 getFriendship() 確實被呼叫過（called=true）', JSON.stringify(snap));
    assert(snap.friendFlag === null, 'DIAG-2 錯誤時 friendFlag=null', JSON.stringify(snap));
    assert(!!snap.errorCode && !!snap.errorMessage, 'DIAG-3 錯誤時記錄 safe error code／generic error message', JSON.stringify(snap));
    const raw = JSON.stringify(snap);
    assert(!raw.toLowerCase().includes('token') && !raw.includes('U1234'), 'DIAG-4 診斷快照不含任何 token 字樣或範例 UID', raw);
  }

  console.log('\n== FRIEND-LIVE Summary ==');
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

main().catch((e) => { console.error('FRIEND-LIVE runner crashed:', e); process.exit(1); });
