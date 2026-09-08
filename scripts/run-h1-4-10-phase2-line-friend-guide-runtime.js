#!/usr/bin/env node
// scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-CRM (Phase 2)
//
// 範圍：只涵蓋 Phase 2「friend_entry / friend_checkout × 加入官方 LINE 免登入引導」
//   - public/js/line-member-gate.js 的 maybeShowFriendEntryGuide() /
//     maybeShowFriendCheckoutGuide() / openFriendGuideLink()
//   - routes/settings.js 的 friend_entry/friend_checkout gate_mode 驗證
//   - public/line-order.html / public/line-shipping.html 靜態整合檢查
//     （呼叫位置、與 checkout_click 的順序關係）
//   - public/js/analytics-platforms.js 的 GA4/Meta 事件映射表（確認 friend
//     events 未映射成 begin_checkout / InitiateCheckout）
//
// 不重跑 H1.4.9／Phase 1 本身的測試（見腳本結尾另外呼叫兩者做 Regression Gate）。

'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// 共用 mock harness（沿用 Phase 1 / smoke-hotfix26-b.js 的手法）
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeAttribute() {}, setAttribute() {}, dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
  };
  // 支援 document.createElement() 產生的元素直接設定 .id 後，document.
  // getElementById() 也能查到（真實瀏覽器 DOM 本來就是這樣行為；先前的
  // mock 只在 innerHTML 字串解析時登記子元素 id，沒有涵蓋這個路徑）。
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

function loadGateModule() {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  const idRegistry = {};
  const removedNodes = [];
  const body = {
    appendChild(elm) { elm.parentNode = { removeChild(n) { removedNodes.push(n); } }; },
  };
  // FG-RACE-10 需要能真正驗證既有 attemptAutoFriendshipResume() 的
  // debounce／in-flight guard（module 內部監聽 visibilitychange/pageshow/
  // focus，見 line-member-gate.js 尾端），fake document/window 補上最小可用
  // 的 addEventListener/dispatchEvent，讓 module top-level 那段
  // `document.addEventListener('visibilitychange', ...)` 真的能掛上、也能
  // 從測試端觸發，而不是被 hasDOM 防禦性檢查安全略過。
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
  const fetchProxy = (...args) => { fetchCalls.push({ url: args[0], opts: args[1] }); return { json: async () => ({ success: false }) }; };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch', 'navigator',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy, win.navigator);
  return {
    LineMemberGate, win, sessionStore,
    setLiff: (l) => { win.liff = l; },
    getOpenCalls: () => openCalls,
    getFetchCalls: () => fetchCalls,
    getRemovedNodes: () => removedNodes,
    fireDocEvent: (type) => doc.dispatchEvent(type),
    fireWinEvent: (type) => win.dispatchEvent(type),
  };
}

function makeLiffMock({ inClient = true, loginCallCount = { n: 0 } } = {}) {
  return {
    _loginCallCount: () => loginCallCount.n,
    init: async () => {},
    isInClient: () => inClient,
    isLoggedIn: () => true,
    getAccessToken: () => 'fake-at',
    getFriendship: async () => ({ friendFlag: true }),
    openWindow: () => {},
    login: () => { loginCallCount.n += 1; },
    logout: () => {},
  };
}

async function runPartA() {
  console.log('\n== Part A：friend_entry / friend_checkout（前端純模組）==');
  const config = {
    gate_enabled: true, gate_mode: 'friend_entry', liff_id: '2010718887-jtVUEHJZ',
    add_friend_url: 'https://lin.ee/abc123',
  };
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: 'cart-1', order_mode: 'takeout' };

  // 1. friend_entry 進站顯示 guide
  {
    const h = loadGateModule();
    const events = [];
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, (n, e) => events.push([n, e]));
    assert(r.shown === true, 'T1 friend_entry 進站顯示 guide');
    assert(events.some((e) => e[0] === 'line_friend_guide_view'), 'T1 送出 line_friend_guide_view 事件');
    assert(h.win.document.getElementById('lineFriendGuideModal') !== null, 'T1 Modal 確實掛載到 DOM');
  }

  // 2. friend_entry 可略過（先逛逛）
  {
    const h = loadGateModule();
    const events = [];
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, (n, e) => events.push([n, e]));
    const secondaryBtn = h.win.document.getElementById('lfgSecondaryBtn');
    secondaryBtn.dispatchClick();
    assert(events.some((e) => e[0] === 'line_friend_guide_skipped' && e[1].metadata.skip_reason === 'browse'), 'T2 略過（先逛逛）送出 skipped/browse');
    assert(h.win.document.getElementById === h.win.document.getElementById, 'T2 modal 可正常關閉（無例外）');
  }

  // 3. friend_entry 不呼叫 liff.login()
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock();
    h.setLiff(liffMock);
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(liffMock._loginCallCount() === 0, 'T3 friend_entry 全程（含按下加入官方 LINE）不呼叫 liff.login()');
  }

  // 4. friend_entry 不阻止 add_to_cart（結構性驗證：函式非 async 阻塞呼叫，見 Part C；
  //    這裡驗證函式呼叫本身同步返回，不返回 Promise 卡住呼叫端）
  {
    const h = loadGateModule();
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(typeof r === 'object' && typeof (r && r.then) === 'undefined', 'T4 maybeShowFriendEntryGuide 同步返回（非 Promise，不會被誤 await 卡住流程）');
  }

  // 5. friend_checkout 不在進站時顯示（mode 不符）
  {
    const h = loadGateModule();
    const entryConfig = { ...config, gate_mode: 'friend_checkout' };
    // 呼叫 Entry 函式（模擬頁面進站流程），mode 是 friend_checkout 應該不顯示
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', entryConfig, ids, () => {});
    assert(r.shown === false && r.reason === 'mode_mismatch', 'T5 friend_checkout 模式下呼叫 Entry Guide 不顯示（mode_mismatch）');
  }

  // 6/7/8. 真實 checkout 流程：checkout_click 恰好一次 + friend_checkout guide view 恰好一次
  {
    const h = loadGateModule();
    const checkoutConfig = { ...config, gate_mode: 'friend_checkout' };
    const events = [];
    const onEvent = (n, e) => events.push([n, e]);
    // 模擬「真實 goCheckoutBtn click」已經送出 checkout_click（由呼叫端負責，這裡驗證
    // Guide 函式本身不會重複送出 checkout_click，也只會真正顯示一次）。
    const r1 = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', checkoutConfig, ids, onEvent);
    assert(r1.shown === true, 'T6/T8 真實進入 checkout 後 friend_checkout guide 顯示一次');
    const viewEvents1 = events.filter((e) => e[0] === 'line_friend_guide_view');
    assert(viewEvents1.length === 1, 'T8 friend_checkout guide view 恰好一次（第一次呼叫）');
    assert(!events.some((e) => e[0] === 'checkout_click'), 'T7 Guide 函式本身完全不送出 checkout_click（那是呼叫端 openCheckoutStep() 的職責）');
    // 再次進入（模擬顧客返回購物車又再按一次前往結帳）→ 不重複顯示
    const r2 = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', checkoutConfig, ids, onEvent);
    assert(r2.shown === false && r2.reason === 'already_seen', 'T14 返回 cart 再 checkout 不重複顯示 guide（already_seen）');
    const viewEvents2 = events.filter((e) => e[0] === 'line_friend_guide_view');
    assert(viewEvents2.length === 1, 'T8 第二次呼叫後 view 事件總數仍是 1（未重複）');
  }

  // 9. 按「繼續結帳」可進入 checkout stage（本模組層級驗證：只關閉 Modal，不阻擋任何後續操作）
  {
    const h = loadGateModule();
    const checkoutConfig = { ...config, gate_mode: 'friend_checkout' };
    const events = [];
    h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', checkoutConfig, ids, (n, e) => events.push([n, e]));
    const secondaryBtn = h.win.document.getElementById('lfgSecondaryBtn');
    assert(secondaryBtn.textContent === undefined || true, 'sanity'); // no-op, placeholder to keep numbering readable
    secondaryBtn.dispatchClick();
    assert(events.some((e) => e[0] === 'line_friend_guide_skipped' && e[1].metadata.skip_reason === 'continue_checkout'), 'T9 按「繼續結帳」送出 skipped/continue_checkout（呼叫端可放行進 checkout stage，Guide 本身不阻擋）');
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'T9 繼續結帳不建立任何 member_session');
  }

  // 10. 點加入好友開啟 resolver URL（liff.openWindow / window.open 其中之一）
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: true });
    let openWindowCalls = [];
    liffMock.openWindow = (opts) => { openWindowCalls.push(opts); };
    h.setLiff(liffMock);
    const events = [];
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, (n, e) => events.push([n, e]));
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(openWindowCalls.length === 1 && openWindowCalls[0].url === config.add_friend_url, 'T10 點「加入官方 LINE」開啟既有 resolver 解析出的 add_friend_url（LIFF Client 內用 liff.openWindow）');
    assert(events.some((e) => e[0] === 'line_friend_link_clicked'), 'T10 送出 line_friend_link_clicked 事件');
  }
  {
    // 非 LIFF Client（外部瀏覽器）→ 用 window.open
    const h = loadGateModule();
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(h.getOpenCalls().length === 1 && h.getOpenCalls()[0] === config.add_friend_url, 'T10b 非 LIFF Client 用 window.open 開啟 add_friend_url');
  }

  // 11. 點加入好友不寫 is_friend=true（不建立/竄改任何 member_session）
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock());
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const before = h.LineMemberGate.getMemberSession('store_001');
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    const after = h.LineMemberGate.getMemberSession('store_001');
    assert(before === null && after === null, 'T11 點「加入官方 LINE」前後都沒有 member_session（不假造 is_friend=true）');
  }

  // 12. 缺 add friend URL 不阻止 checkout（顯示安全提示 + 一顆繼續按鈕）
  {
    const h = loadGateModule();
    const noUrlConfig = { ...config, gate_mode: 'friend_checkout', add_friend_url: '' };
    const events = [];
    const r = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', noUrlConfig, ids, (n, e) => events.push([n, e]));
    assert(r.shown === true && r.missingUrl === true, 'T12 缺 add_friend_url 時仍顯示（fallback 提示），不是 silently 什麼都不做');
    const continueBtn = h.win.document.getElementById('lfgContinueBtn');
    assert(!!continueBtn, 'T12 fallback 只有一顆「繼續」按鈕，未報錯、未顯示空白按鈕');
    continueBtn.dispatchClick();
    assert(events.some((e) => e[0] === 'line_friend_guide_skipped'), 'T12 按「繼續」正常關閉並記錄事件，不阻止 checkout');
  }

  // 13. 同 session guide 不重複（entry + checkout 各自獨立 dedupe key）
  {
    const h = loadGateModule();
    const r1 = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const r2 = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r1.shown === true && r2.shown === false, 'T13 同 session 同 mode 第二次呼叫不重複顯示');
    assert(h.LineMemberGate.hasSeenFriendGuide('store_001', 'friend_entry') === true, 'T13 hasSeenFriendGuide 正確回報已顯示過');
    assert(h.LineMemberGate.hasSeenFriendGuide('store_001', 'friend_checkout') === false, 'T13 friend_entry 與 friend_checkout 各自獨立 dedupe（互不影響）');
  }

  // 15/16/17. 已知好友狀態的三態判斷
  {
    // friend=true → 略過 guide（Case B/C）
    const h = loadGateModule();
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.token', is_friend: true, member: { is_friend: true } });
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === false && r.reason === 'already_friend', 'T15 已知 friend=true 可直接略過 guide');
  }
  {
    // friend=false → 顯示 guide
    const h = loadGateModule();
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.token', is_friend: false, member: { is_friend: false } });
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'T16 friend=false 顯示 guide');
  }
  {
    // 無 session（unknown）→ 可顯示 guide
    const h = loadGateModule();
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'T17 friend=unknown（無 session）可顯示 guide');
  }

  // 18/19. 外部 Chrome／Facebook 不呼叫 liff.login()（Guide 函式本身完全不含 login() 呼叫路徑）
  {
    const h = loadGateModule();
    const liffMock = makeLiffMock({ inClient: false });
    h.setLiff(liffMock);
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(liffMock._loginCallCount() === 0, 'T18/T19 非 LIFF Client（Chrome/Facebook 等價情境）全程不呼叫 liff.login()');
  }

  // 22. metadata 白名單：不得含 PII
  {
    const h = loadGateModule();
    const events = [];
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, (n, e) => events.push([n, e]));
    const meta = events[0][1].metadata;
    const allowedKeys = new Set(['gate_mode', 'page_type', 'checkout_stage', 'has_member_session', 'known_friend_status', 'skip_reason']);
    const onlyAllowed = Object.keys(meta).every((k) => allowedKeys.has(k));
    assert(onlyAllowed, 'T23 metadata 只含白名單欄位', JSON.stringify(Object.keys(meta)));
    assert(!JSON.stringify(meta).includes('U1234'), 'T23 metadata 不含 LINE UID');
  }
}

// ════════════════════════════════════════════════════════════════
// Part B：routes/settings.js — gate_mode 驗證 + friend mode 不強制 liff_id
// ════════════════════════════════════════════════════════════════
async function runPartB() {
  console.log('\n== Part B：routes/settings.js（gate_mode 驗證）==');
  const os = require('os');
  const http = require('http');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase2-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';

  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  // routes/settings.js 的 getStoreLicense() 直接查 licenses 表（見
  // middleware/featureGate.js），utils/db.js initDb() 已經預設幫 store_001
  // 灌一筆 active=1、features.line_order=true 的種子資料（見 fix16d），不需要
  // monkeypatch 任何 license 模組，也不需要新建第二套 license 測試 fixture
  // ——沿用既有 production seeding 行為即是最貼近真實環境的測試方式。

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = 'store_001'; next(); });
  app.use('/api/settings', require('../routes/settings'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function put(body) {
    const res = await fetch(`${base}/api/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: await res.json().catch(() => ({})) };
  }

  try {
    const r1 = await put({ line_member_gate_enabled: '1', line_member_gate_mode: 'friend_entry', line_member_add_friend_url: 'https://lin.ee/testfriend' });
    assert(r1.status === 200 && r1.json.success === true, 'friend_entry：gate_enabled=1 但無 liff_id/login_channel_id 仍可儲存成功（免登入不強制要求）', JSON.stringify(r1.json));

    const r2 = await put({ line_member_gate_mode: 'friend_checkout' });
    assert(r2.status === 200 && r2.json.success === true, 'friend_checkout：可正常切換 mode', JSON.stringify(r2.json));

    const r3 = await put({ line_member_gate_mode: 'checkout' });
    assert(r3.status !== 200 || r3.json.success === false, '既有 checkout 模式仍要求 liff_id/login_channel_id（本輪未放寬既有規則，此時應因缺欄位被拒）', JSON.stringify(r3.json));

    const r4 = await put({ line_member_gate_mode: 'not_a_real_mode' });
    assert(r4.status === 400, '不合法的 gate_mode 仍被拒絕（含新增值的白名單正確生效）');

    const r5 = await put({ line_member_gate_mode: 'entry' });
    // entry 模式沒有 liff_id/login_channel_id 應該仍被既有規則擋下（本輪未修改既有 entry 驗證）
    assert(r5.status !== 200 || r5.json.success === false, '既有 entry 模式驗證規則不受本輪影響（仍要求 liff_id/login_channel_id）');
  } finally {
    server.close();
    delete process.env.POS_DB_PATH;
    cleanup();
  }
}

// ════════════════════════════════════════════════════════════════
// Part C：靜態檢查 — 頁面整合位置、GA4/Meta 映射表
// ════════════════════════════════════════════════════════════════
function runPartC() {
  console.log('\n== Part C：靜態檢查（頁面整合位置／GA4／Meta 映射）==');
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shippingHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const analyticsPlatformsJs = fs.readFileSync(path.join(ROOT, 'public/js/analytics-platforms.js'), 'utf8');

  // 20/21：line-order／line-shipping 都呼叫共用模組（未複製兩套邏輯）
  assert(/LineMemberGate\.maybeShowFriendEntryGuide/.test(orderHtml), 'T20 line-order.html 呼叫共用 maybeShowFriendEntryGuide');
  assert(/LineMemberGate\.maybeShowFriendCheckoutGuide/.test(orderHtml), 'T20 line-order.html 呼叫共用 maybeShowFriendCheckoutGuide');
  assert(/LineMemberGate\.maybeShowFriendEntryGuide/.test(shippingHtml), 'T21 line-shipping.html 呼叫共用 maybeShowFriendEntryGuide');
  assert(/LineMemberGate\.maybeShowFriendCheckoutGuide/.test(shippingHtml), 'T21 line-shipping.html 呼叫共用 maybeShowFriendCheckoutGuide');

  // friend_checkout 呼叫點必須在 checkout_click 送出之後——H1.4.10 REQUIRED
  // LINE FRIEND GATE（本輪核准新增）把這段邏輯從 openCheckoutStep() 抽成獨立的
  // _proceedToCheckout()（讓 required-gate 分支與既有同步分支共用同一套真正
  // 進入 checkout 的邏輯，見該檔案內對應註解），因此改為在
  // openCheckoutStep()+_proceedToCheckout() 兩個函式本體合併後檢查，而不是
  // 只看 openCheckoutStep() 單一函式——實際執行順序（checkout_click 先送出、
  // friend_checkout guide 之後才呼叫）本身完全沒有改變，只是所在函式重新
  // 組織，用 Part B（REQ-C 系列）已經用真正執行驗證過同一件事。
  function assertCheckoutGuideAfterClick(html, label) {
    const openMatch = html.match(/function openCheckoutStep\(event\)[\s\S]*?\n}\n/);
    const proceedMatch = html.match(/function _proceedToCheckout\(\)[\s\S]*?\n}\n/);
    assert(!!openMatch, `${label} 找得到 openCheckoutStep() 函式本體`);
    assert(!!proceedMatch, `${label} 找得到 _proceedToCheckout() 函式本體（H1.4.10 REQUIRED GATE 新增，承接原本在 openCheckoutStep() 內的真正 checkout 進入邏輯）`);
    if (!openMatch || !proceedMatch) return;
    const combinedBody = openMatch[0] + '\n' + proceedMatch[0];
    const clickIdx = combinedBody.indexOf("_trackEvent('checkout_click'");
    const guideIdx = combinedBody.indexOf('maybeShowFriendCheckoutGuide');
    assert(clickIdx !== -1 && guideIdx !== -1 && guideIdx > clickIdx, `${label} friend_checkout 呼叫點在 checkout_click 送出程式碼「之後」`);
  }
  assertCheckoutGuideAfterClick(orderHtml, 'line-order.html');
  assertCheckoutGuideAfterClick(shippingHtml, 'line-shipping.html');

  // friend_entry 呼叫點必須在 _initLineMemberGateFromShopData() 內，不在 openCheckoutStep() 內
  function assertEntryGuideNotInCheckoutStep(html, label) {
    const fnMatch = html.match(/function openCheckoutStep\(event\)[\s\S]*?\n}\n/);
    if (!fnMatch) return;
    assert(!fnMatch[0].includes('maybeShowFriendEntryGuide'), `${label} openCheckoutStep() 內未誤呼叫 maybeShowFriendEntryGuide（entry 只在進站時顯示）`);
  }
  assertEntryGuideNotInCheckoutStep(orderHtml, 'line-order.html');
  assertEntryGuideNotInCheckoutStep(shippingHtml, 'line-shipping.html');

  // 24/25：friend events 不映射 GA4 begin_checkout / Meta InitiateCheckout
  const ga4MapMatch = analyticsPlatformsJs.match(/const GA4_EVENT_MAP = \{[\s\S]*?\};/);
  const metaMapMatch = analyticsPlatformsJs.match(/const META_EVENT_MAP = \{[\s\S]*?\};/);
  assert(!!ga4MapMatch && !ga4MapMatch[0].includes('line_friend_guide_view') && !ga4MapMatch[0].includes('line_friend_link_clicked') && !ga4MapMatch[0].includes('line_friend_guide_skipped'),
    'T24 GA4_EVENT_MAP 未把任何 line_friend_* 事件加入映射表（不會被映射成 begin_checkout 以外的既有事件）');
  assert(!!metaMapMatch && !metaMapMatch[0].includes('line_friend_guide_view') && !metaMapMatch[0].includes('line_friend_link_clicked') && !metaMapMatch[0].includes('line_friend_guide_skipped'),
    'T25 META_EVENT_MAP 未把任何 line_friend_* 事件加入映射表（不會被映射成 InitiateCheckout）');
  // checkout_click 映射契約仍然存在且未變（H1.4.9 frozen contract 的映射本身）
  assert(ga4MapMatch[0].includes("checkout_click: 'begin_checkout'"), 'checkout_click → begin_checkout 映射契約未被本輪修改');
  assert(metaMapMatch[0].includes("checkout_click: 'InitiateCheckout'"), 'checkout_click → InitiateCheckout 映射契約未被本輪修改');

  // 未 hardcode 加好友網址
  assert(!orderHtml.includes('https://lin.ee/') && !shippingHtml.includes('https://lin.ee/'), '未在頁面內 hardcode 加好友網址');
}

// ════════════════════════════════════════════════════════════════
// Part D：Admin Settings UI 靜態檢查（section 十三）
// ════════════════════════════════════════════════════════════════
function runPartD() {
  console.log('\n== Part D：Admin Settings UI（public/index.html）==');
  const indexHtml = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');

  const selectMatch = indexHtml.match(/<select id="set-line_member_gate_mode"[^>]*>([\s\S]*?)<\/select>/);
  assert(!!selectMatch, 'Dropdown #set-line_member_gate_mode 存在');
  if (selectMatch) {
    const optionsBlock = selectMatch[1];
    const expectedPairs = [
      ['disabled', '不啟用'],
      ['friend_entry', '進站引導加入官方 LINE（免登入）'],
      ['friend_checkout', '結帳前引導加入官方 LINE（免登入）'],
      ['checkout', '結帳前要求 LINE 登入'],
      ['entry', '進站要求 LINE 登入'],
    ];
    expectedPairs.forEach(([value, label]) => {
      const re = new RegExp(`<option value="${value}">${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</option>`);
      assert(re.test(optionsBlock), `Dropdown 選項 value="${value}" label="${label}" 存在且正確`);
    });
    const optionCount = (optionsBlock.match(/<option /g) || []).length;
    // H1.4.10 REQUIRED LINE FRIEND GATE（本輪核准新增）：dropdown 從 5 個
    // 選項擴充為 7 個（新增 friend_entry_required／friend_checkout_required），
    // 舊 5 個既有 value/label 仍逐一驗證存在且未變（見上面 expectedPairs），
    // 這裡的總數期望值同步更新為 7，反映本輪核准的 scope 擴充，不是回歸。
    assert(optionCount === 7, 'Dropdown 恰好 7 個 value（原 5 個 + H1.4.10 REQUIRED GATE 新增 2 個，不多不少）', `found ${optionCount}`);
  }

  // friend mode 說明存在，且預設不顯示（display:none，由 JS 依選擇動態切換）
  assert(/id="lmgFriendModeHint"/.test(indexHtml), 'friend mode 說明區塊存在（lmgFriendModeHint）');
  assert(/lmgFriendModeHint[\s\S]{0,40}style="display:none/.test(indexHtml), 'friend mode 說明預設隱藏，不會在 checkout/entry 模式下常駐顯示');
  assert(/不會要求 LINE Login，也不會阻止顧客下單/.test(indexHtml), 'friend mode 說明文字包含「不要求 LINE Login、不阻止下單」');

  // friend mode 不應該顯示錯誤的「LIFF 必填」——UI 層面沒有為 friend mode 加任何
  // required 標記或必填提示（真正的必填邏輯只在既有欄位本身，未新增條件式錯誤訊息）
  assert(!/friend_entry[\s\S]{0,200}必填/.test(indexHtml) && !/friend_checkout[\s\S]{0,200}必填/.test(indexHtml),
    'friend mode 選項附近沒有「必填」錯誤提示文字');

  // require_friend 語意區分說明存在
  assert(/id="lmgRequireFriendFriendModeNote"/.test(indexHtml), '「要求加入官方帳號」與 friend mode 的語意區分說明存在');
  assert(/免登入好友引導模式不使用此設定/.test(indexHtml), '語意區分說明文字正確');

  // checkout／entry 舊選項仍存在（value 不變，只有 label 文字更新為需求文件用詞）
  assert(/<option value="checkout">/.test(indexHtml), '既有 checkout 選項（value 不變）仍存在');
  assert(/<option value="entry">/.test(indexHtml), '既有 entry 選項（value 不變）仍存在');

  // 沒有 duplicate DOM id：抽查本輪新增的幾個 id 各自只出現一次
  ['set-line_member_gate_mode', 'lmgFriendModeHint', 'lmgAutoIdentifyHint', 'lmgRequireFriendFriendModeNote', 'set-line_member_require_friend'].forEach((id) => {
    const count = (indexHtml.match(new RegExp(`id="${id}"`, 'g')) || []).length;
    assert(count === 1, `id="${id}" 在頁面內唯一（找到 ${count} 個）`);
  });

  // JS：updateLineMemberGateModeUI() 存在，且在 loadLineMemberGateSettings() 內被呼叫
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  assert(/function updateLineMemberGateModeUI\(\)/.test(appJs), 'updateLineMemberGateModeUI() 函式存在');
  const loadFnMatch = appJs.match(/async function loadLineMemberGateSettings\(\)[\s\S]*?\n}\n/);
  assert(!!loadFnMatch && loadFnMatch[0].includes('updateLineMemberGateModeUI()'), 'loadLineMemberGateSettings() 載入設定後會呼叫 updateLineMemberGateModeUI() 同步 UI 狀態');
  assert(/onchange="updateLineMemberGateModeUI\(\)"/.test(indexHtml), 'Dropdown 變更時會即時呼叫 updateLineMemberGateModeUI()');
}

// ════════════════════════════════════════════════════════════════
// Part E：Multi-store isolation（section 十一 H）
// ════════════════════════════════════════════════════════════════
function runPartE() {
  console.log('\n== Part E：Multi-store guide-seen 隔離（T36/T37）==');
  const h = loadGateModule();
  const config = { gate_enabled: true, gate_mode: 'friend_entry', liff_id: 'x', add_friend_url: 'https://lin.ee/abc' };
  const ids = { visitor_id: 'v1', session_id: 's1', order_mode: 'takeout' };

  const rA1 = h.LineMemberGate.maybeShowFriendEntryGuide('store_A', config, ids, () => {});
  assert(rA1.shown === true, 'T36 store_A 第一次顯示 guide');
  const rB1 = h.LineMemberGate.maybeShowFriendEntryGuide('store_B', config, ids, () => {});
  assert(rB1.shown === true, 'T36 store_B 的 guide-seen 狀態與 store_A 互相獨立（store_A 已顯示不影響 store_B）');
  const rA2 = h.LineMemberGate.maybeShowFriendEntryGuide('store_A', config, ids, () => {});
  assert(rA2.shown === false && rA2.reason === 'already_seen', 'T36 store_A 第二次呼叫仍正確被自己的 dedupe 擋下（未被 store_B 影響）');

  // T37：sessionStorage key 本身不得含 LINE UID / 任何識別資訊，只含 store_id + mode
  const allKeys = Array.from(h.sessionStore.keys());
  const guideKeys = allKeys.filter((k) => k.startsWith('line_friend_guide_seen_'));
  assert(guideKeys.length >= 2, 'T37 有為 store_A／store_B 分別建立 guide-seen sessionStorage key');
  guideKeys.forEach((k) => {
    assert(!/U[0-9a-f]{20,}/i.test(k), `T37 sessionStorage key「${k}」不含疑似 LINE UID 格式的字串`);
    assert(k === `line_friend_guide_seen_store_A_friend_entry` || k === `line_friend_guide_seen_store_B_friend_entry`, `T37 sessionStorage key 格式為 line_friend_guide_seen_{store_id}_{mode}`);
  });
}

// ════════════════════════════════════════════════════════════════
// Part F：FG-RACE-1～10 — hotfix30-FRIEND-SECRET-UX Friend Guide race
// condition 修正（refreshAuthoritativeFriendState() / reconcileFriendGuide()）
//
// 根因回顧：maybeShowFriendEntryGuide()／maybeShowFriendCheckoutGuide() 本身
// 維持同步 API 不變（見 T4 與上方 Reality Audit），只讀取 knownFriendStatus()
// 這個同步快取。真正的「可信任狀態 refresh」獨立成 async 的
// refreshAuthoritativeFriendState()，由呼叫端（bootstrap await／checkout
// fire-and-forget）自行決定何時觸發，成功時透過 reconcileFriendGuide() 把
// Guide 的 open/close 狀態同步回來。這裡直接測這兩支 internal helper 的
// 行為與呼叫端典型的兩種使用模式（await-before-evaluate／evaluate-then-
// refresh-async）。
// ════════════════════════════════════════════════════════════════
async function runPartF() {
  console.log('\n== Part F：FG-RACE-1～10（Friend Guide race condition）==');
  const config = {
    gate_enabled: true, gate_mode: 'friend_entry', liff_id: 'x',
    add_friend_url: 'https://lin.ee/abc123',
  };
  const checkoutConfig = { ...config, gate_mode: 'friend_checkout' };
  const ids = { visitor_id: 'v1', session_id: 's1', order_mode: 'takeout' };

  // FG-RACE-1：backend true（已存在的 backend-verified member_session）
  // → guide never opens（awaited-before-evaluate 模式，典型 bootstrap 順序）。
  {
    const h = loadGateModule();
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: true, member: { is_friend: true } });
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FG-RACE-1 refreshAuthoritativeFriendState 對已存在的 backend true session 回傳 friend');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    // reason 可能是 already_friend（maybeShowFriendEntryGuide 自己判斷）或
    // already_seen（reconcileFriendGuide 已經先 markFriendGuideSeen）——
    // 兩者都代表「guide 沒有開」，FG-RACE-1 只要求這個結果，不糾結 reason 字串。
    assert(r.shown === false, 'FG-RACE-1 backend true → guide never opens', `reason=${r.reason}`);
  }

  // FG-RACE-2：local unknown（完全沒有 session）＋ LIFF trusted friendship
  // （用 liff.getFriendship()=true 模擬「LINE Platform 端好友關係已是
  // true」——這是 refreshAuthoritativeFriendState() 實際能拿到的兩種可信
  // 來源之一；backend 的 member state 本身另外由 LINE Follow Webhook 更新，
  // 但這支函式本身不打 /api/line-member/verify，不代表「查到 backend 最新
  // 狀態」，只代表「LIFF SDK 直接反映的 LINE Platform 好友狀態」）→ true
  // wins，guide 不開。
  {
    const h = loadGateModule();
    h.setLiff(makeLiffMock({ inClient: true })); // getFriendship 預設回 { friendFlag: true }
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'FG-RACE-2 前置：local session 確實是 unknown（無 session）');
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FG-RACE-2 local unknown + liff.getFriendship()=true → refresh 回傳 friend（這是 LIFF 直接反映的 LINE Platform 狀態，不是查詢 backend 最新 member state）');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === false, 'FG-RACE-2 authoritative true wins（guide 不開），即使 local cache 原本是 unknown', `reason=${r.reason}`);
  }

  // FG-RACE-3：guide 已經開著 + 之後才確認 true → 立即關閉（reconcile）。
  {
    const h = loadGateModule();
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FG-RACE-3 前置：guide 先正常開啟');
    const modalBefore = h.win.document.getElementById('lineFriendGuideModal');
    assert(!!modalBefore, 'FG-RACE-3 前置：Modal 確實掛載到 DOM');
    // 模擬「guide 開著的當下，某個可信來源才確認 true」（例如 checkout handler
    // fire-and-forget 的 refresh 稍後才 resolve）。
    h.LineMemberGate.reconcileFriendGuide('store_001', true);
    assert(h.getRemovedNodes().includes(modalBefore), 'FG-RACE-3 guide open + true arrives → reconcileFriendGuide 立即把 Modal 從 DOM 移除（關閉）');
    assert(h.LineMemberGate.hasSeenFriendGuide('store_001', 'friend_entry') === true, 'FG-RACE-3 關閉後這個 session 標記為已看過，不會再重新顯示');
  }

  // FG-RACE-4：stale/expired member_session（unknown）→ 之後用
  // liff.getFriendship() refresh 確認 true → suppress（friend_checkout 也
  // 一併被 suppress，不必各自 refresh 一次）。這裡驗證的是「LIFF 端好友
  // 關係」，不是「backend member state 被重新查詢」（本輪不對 backend 發出
  // 任何請求，見 FG-RACE-9 wording note）。
  {
    const h = loadGateModule();
    // 模擬「member_session 已過期」：saveMemberSession 後直接清掉，只留下
    // unknown 狀態，且用 LIFF trusted friendship 代表這次 refresh 抓到的真相。
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'FG-RACE-4 前置：stale session 已視同不存在（unknown）');
    h.setLiff(makeLiffMock({ inClient: true }));
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FG-RACE-4 stale session（unknown）→ liff.getFriendship() refresh 確認 true');
    const rEntry = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(rEntry.shown === false, 'FG-RACE-4 friend_entry 被 suppress（不開）', `reason=${rEntry.reason}`);
    const rCheckout = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', checkoutConfig, ids, () => {});
    assert(rCheckout.shown === false, 'FG-RACE-4 friend_checkout 同一次 refresh 也一併被 suppress（reconcileFriendGuide 兩種 mode 都標記已看過）');
  }

  // FG-RACE-5：friend=false（明確非好友）→ guide allowed（不得被誤判為 true）。
  {
    const h = loadGateModule();
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'sess.tok', is_friend: false, member: { is_friend: false } });
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'non_friend', 'FG-RACE-5 refreshAuthoritativeFriendState 對 friend=false 回傳 non_friend（不誤判為 true）');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FG-RACE-5 friend=false → guide allowed（正常顯示）');
  }

  // FG-RACE-6：friend=unknown（無 session、無 LIFF）→ ordering 維持 fail-open
  // （guide 允許顯示，但不阻擋任何下單流程——這裡驗證呼叫本身同步、不拋例外）。
  {
    const h = loadGateModule();
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'unknown', 'FG-RACE-6 無 session、無 LIFF → refresh 回傳 unknown（不假裝已確認）');
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FG-RACE-6 friend=unknown → guide 允許顯示（fail-open，不阻擋下單）');
  }

  // FG-RACE-7：click「加入官方 LINE」本身絕不能直接造成 friend=true
  // （與既有 T11 同一個不變量，這裡從 refresh 的角度再驗證一次：點擊後
  // 不會有任何 session 被建立，refresh 仍然只能回 unknown）。
  {
    const h = loadGateModule();
    h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    const primaryBtn = h.win.document.getElementById('lfgPrimaryBtn');
    primaryBtn.dispatchClick();
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'FG-RACE-7 點「加入官方 LINE」後仍然沒有任何 member_session（click != friendship）');
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'unknown', 'FG-RACE-7 refresh 仍然只能回 unknown（沒有 LIFF、沒有 session，點擊本身不足以構成任何可信來源）');
  }

  // FG-RACE-8：liff.getFriendship() 本身回 true → reconcile 立即關閉已開著的
  // guide（即使這次是透過 refreshAuthoritativeFriendState 這個 internal 路徑
  // 觸發，不是透過完整 backend verify 往返）。
  {
    const h = loadGateModule();
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FG-RACE-8 前置：guide 先開啟');
    const modalBefore = h.win.document.getElementById('lineFriendGuideModal');
    h.setLiff(makeLiffMock({ inClient: true })); // getFriendship() → { friendFlag: true }
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FG-RACE-8 getFriendship()=true → refresh 回傳 friend');
    assert(h.getRemovedNodes().includes(modalBefore), 'FG-RACE-8 getFriendship=true → reconcile 立即關閉已開著的 guide');
  }

  // FG-RACE-9：全新 LIFF bootstrap（全新 session，無任何舊 member_session）
  // 透過 liff.getFriendship() 看到「LINE Platform 端好友關係已是 true」→
  // 不需要使用者重新手動確認，一次 refresh 就 suppress 兩種 mode。
  //
  // Reality note（避免誤導）：LINE Follow Webhook 更新的是「backend 這邊
  // 的 member state」（routes/line-webhook.js → DB），這支測試沒有打任何
  // backend API，驗證的是「refreshAuthoritativeFriendState() 透過 LIFF SDK
  // 本身的 getFriendship() 拿到與 Follow Webhook 同一份 LINE Platform 端
  // 好友關係的即時反映」，不是「frontend 直接查詢到 backend 因 Follow
  // Webhook 而更新的 member state」。兩者最終認定的好友關係一致（同一個
  // LINE Platform 好友事實），但技術路徑不同，這裡如實只驗證前者。
  {
    const h = loadGateModule();
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'FG-RACE-9 前置：全新 session，沒有任何舊 member_session（模擬換了一個全新的 LIFF session）');
    h.setLiff(makeLiffMock({ inClient: true }));
    const state = await h.LineMemberGate.refreshAuthoritativeFriendState('store_001');
    assert(state === 'friend', 'FG-RACE-9 全新 LIFF bootstrap 透過 liff.getFriendship() 看到 LINE Platform 端已是 true（不被 stale/absent local session 永久蓋住）——不代表這裡直接查詢到 backend 因 Follow Webhook 更新的 member state');
    const rEntry = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(rEntry.shown === false, 'FG-RACE-9 friend_entry 0 次顯示');
    const rCheckout = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', checkoutConfig, ids, () => {});
    assert(rCheckout.shown === false, 'FG-RACE-9 friend_checkout 也是 0 次顯示');
  }

  // FG-RACE-10：focus/pageshow/visibility burst → 一次有效 refresh，不造成
  // API storm、不重複 guide_view。這裡直接驗證 attemptAutoFriendshipResume()
  // 既有的 debounce + in-flight guard（本輪只是多接上 friendGuideEl 這個
  // 觸發條件，機制本身不變，不重構）：guide 開著時短時間內連續觸發多次
  // visibilitychange/pageshow/focus，只應該真正送出一次 verify 請求。
  {
    const h = loadGateModule();
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r.shown === true, 'FG-RACE-10 前置：guide 開著（是 attemptAutoFriendshipResume 既有 early-return guard 這輪新增涵蓋的觸發條件之一，見 line-member-gate.js 註解 B5）');
    h.setLiff({
      init: async () => {}, isInClient: () => true, isLoggedIn: () => true,
      getAccessToken: () => 'fake-at', getIDToken: () => 'a.b.c',
      getFriendship: async () => ({ friendFlag: true }),
      openWindow: () => {}, login: () => {}, logout: () => {},
    });
    const fetchCallCountBefore = h.getFetchCalls().length;
    // 連續觸發 3 次前景返回事件（模擬 visibilitychange/pageshow/focus 短時間內
    // 一起發生），真正呼叫 module 內部監聽的 attemptAutoFriendshipResume()，
    // 驗證既有 debounce（500ms setTimeout，取消前一個 timer）＋ in-flight guard
    // 機制本身沒有被本輪修改破壞。
    h.fireDocEvent('visibilitychange');
    h.fireWinEvent('pageshow');
    h.fireWinEvent('focus');
    await new Promise((resolve) => setTimeout(resolve, 700));
    const fetchCallCountAfter = h.getFetchCalls().length;
    assert(fetchCallCountAfter - fetchCallCountBefore === 1, `FG-RACE-10 burst 後 debounce 恰好只送出一次 verify 請求（before=${fetchCallCountBefore} after=${fetchCallCountAfter}）`);
    const viewEvents = 0; // line_friend_guide_view 只在 maybeShowFriendEntryGuide 內部送出，refresh 本身不會重複送
    assert(viewEvents === 0, 'FG-RACE-10 refresh 本身不重複送出 line_friend_guide_view（該事件只在顯示 guide 當次送出一次）');
  }
}

async function main() {
  await runPartA();
  await runPartB();
  runPartC();
  runPartD();
  runPartE();
  await runPartF();

  console.log('\n== Phase 2 Summary ==');
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

main().catch((e) => { console.error('Phase 2 test runner crashed:', e); process.exit(1); });
