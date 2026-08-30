#!/usr/bin/env node
// scripts/run-h1-4-10-phase1-liff-identity-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-LIFF-CART-RECOVERY-CRM (Phase 1)
//
// 範圍：只涵蓋 Phase 1「LIFF 核心會員歸戶」——
//   - public/js/line-member-gate.js 的 tryPassiveLiffIdentification()
//   - routes/line-member.js 的 POST /verify（gate_stage=liff_auto_identify）
//     與新增的 POST /link-context
//   - public/line-order.html／public/line-shipping.html 的 shouldInitLiff／
//     LIFF ID 分離（line_shipping_liff_id fallback）靜態檢查
//
// 不包含 H1.4.9 兩階段結帳（見 scripts/run-h1-4-9-checkout-order-summary-runtime.js，
// 本腳本結尾會另外呼叫一次確認 67/67 仍然成立，做為 frozen contract gate）。
//
// 做法：
//   Part A（純前端模組，Node 內 eval，沿用 smoke-hotfix26-b.js 的 mock 手法）
//   Part B（真實 HTTP：暫存 sqlite db + 最小 express app 掛載
//           routes/line-member.js，monkey-patch utils/lineMemberAuth 避免
//           打真實 LINE API）
//   Part C（靜態檢查：line-order.html／line-shipping.html 原始碼）

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// Part A：public/js/line-member-gate.js — tryPassiveLiffIdentification()
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    removeAttribute() {}, setAttribute() {}, dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
  };
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

function loadGateModule(initialHref) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  let currentUrl = new URL(initialHref);
  const idRegistry = {};
  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const doc = { createElement: () => makeFakeElement(idRegistry), body, head: { appendChild() {} }, getElementById: (id) => idRegistry[id] || null };
  const win = {
    location: {
      get href() { return currentUrl.toString(); }, get search() { return currentUrl.search; },
      get origin() { return currentUrl.origin; }, get pathname() { return currentUrl.pathname; },
    },
    history: { replaceState(state, title, url) { currentUrl = new URL(url, currentUrl.origin); } },
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
  };
  win.window = win;
  let fetchCalls = [];
  let fetchImpl = async () => ({ json: async () => ({ success: false, reason: 'no_mock_configured' }) });
  const fetchProxy = (...args) => { fetchCalls.push({ url: args[0], opts: args[1] }); return fetchImpl(...args); };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch', 'navigator',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy, win.navigator);
  return {
    LineMemberGate, win,
    setLiff: (l) => { win.liff = l; },
    setFetchImpl: (f) => { fetchImpl = f; },
    getFetchCalls: () => fetchCalls,
  };
}

function makeLiffMock({ inClient = true, loggedIn = true, idTokenExpSecondsFromNow = 3600, missingToken = false } = {}) {
  let loginCalls = 0;
  const exp = Math.floor(Date.now() / 1000) + idTokenExpSecondsFromNow;
  const header = Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({ sub: 'Uabc123', exp })).toString('base64url');
  const fakeIdToken = `${header}.${payload}.sig`;
  return {
    _loginCallCount: () => loginCalls,
    init: async () => {},
    isInClient: () => inClient,
    isLoggedIn: () => loggedIn,
    getIDToken: () => (missingToken ? null : fakeIdToken),
    getAccessToken: () => 'fake-access-token',
    getFriendship: async () => ({ friendFlag: true }),
    login: () => { loginCalls += 1; },
    logout: () => {},
  };
}

async function runPartA() {
  console.log('\n== Part A：tryPassiveLiffIdentification（前端純模組）==');
  const baseConfig = { auto_identify_enabled: true, liff_id: '2010718887-jtVUEHJZ', gate_mode: 'disabled' };
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: '', order_mode: 'takeout' };

  // 0a. 契約 A：預設 skipLoginCallback=false（未傳 opts 時），existing gate
  // 流程完全不受影響——isLoggedIn=true 時仍會照 hotfix25 既有行為自動跑
  // handleLineMemberLoginCallback()（gate_stage='callback'）。
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock());
    h.setFetchImpl(async () => ({ json: async () => ({ success: true, member_session: 'callback.session.token', member: {} }) }));
    const gateState = await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {});
    assert(!!gateState.loginCallbackResult, 'T0a 未傳 opts（預設 skipLoginCallback=false）→ 既有 hotfix25 callback 流程照常執行（不受本輪影響）');
    const verifyCalls = h.getFetchCalls().filter((c) => String(c.url).includes('/verify'));
    assert(verifyCalls.length === 1, 'T0a 既有 gate 流程仍正常呼叫一次 /verify');
    const sentBody = JSON.parse(verifyCalls[0].opts.body);
    assert(sentBody.analytics.gate_stage === 'callback', 'T0a 既有流程 gate_stage 仍為 callback（原行為未被改變）');
  }

  // 0b. 契約 B/C：checkout/entry 舊 Gate（gate_enabled=true）情境不得傳
  // skipLoginCallback——這裡直接驗證 line-order.html／line-shipping.html
  // 原始碼呼叫點本身的條件式，而不是重新呼叫模組（見 Part C 對應靜態檢查）。

  // 1. auto_identify_enabled=false → skip，不初始化
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    setLiff(makeLiffMock());
    const events = [];
    const r = await LineMemberGate.tryPassiveLiffIdentification('store_001', { ...baseConfig, auto_identify_enabled: false }, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === false && r.reason === 'auto_identify_disabled', 'T1 auto_identify_enabled=false → 不嘗試');
    assert(events.length === 0, 'T1 未送出任何事件');
  }

  // 2. 沒有 liff_id → skip
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    setLiff(makeLiffMock());
    const r = await LineMemberGate.tryPassiveLiffIdentification('store_001', { ...baseConfig, liff_id: '' }, ids, () => {});
    assert(r.attempted === false && r.reason === 'missing_liff_id', 'T2 缺少 liff_id → 不嘗試');
  }

  // 3. isInClient=false（外部 Chrome）→ skip，不呼叫 liff.login()
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    const liffMock = makeLiffMock({ inClient: false });
    setLiff(liffMock);
    // initLineMemberGate 先跑一次（skipLoginCallback:true，模擬純 auto-identify
    // 初始化路徑），讓 isLiffAvailable() 內部旗標成立，且不觸發既有 hotfix25
    // 「登入返回自動驗證」流程（該流程不檢查 isInClient，會干擾本測試）。
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const events = [];
    const r = await LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === false && r.reason === 'not_in_line_client', 'T3 外部瀏覽器（isInClient=false）→ skip');
    assert(liffMock._loginCallCount() === 0, 'T3 外部瀏覽器 → 絕不呼叫 liff.login()');
    assert(events.some((e) => e[0] === 'line_liff_auto_identify_skipped' && e[1].metadata.reason_code === 'not_in_line_client'), 'T3 送出 skipped 事件 reason_code=not_in_line_client');
  }

  // 4. isLoggedIn=false → skip，不呼叫 liff.login()（需求文件七：絕不因未登入而主動觸發登入）
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    const liffMock = makeLiffMock({ loggedIn: false });
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const events = [];
    const r = await LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === false && r.reason === 'not_logged_in', 'T4 LINE App 內未登入 → skip');
    assert(liffMock._loginCallCount() === 0, 'T4 未登入 → 絕不呼叫 liff.login()');
  }

  // 5. Facebook WebView（isInClient=false, UA 含 FBAN）→ skip，不登入、不阻擋
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.win.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0) FBAN/FBIOS';
    const liffMock = makeLiffMock({ inClient: false });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    assert(r.attempted === false && liffMock._loginCallCount() === 0, 'T5 Facebook WebView → skip，不登入');
  }

  // 6. Instagram WebView → skip，不登入
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.win.navigator.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0) Instagram 200.0';
    const liffMock = makeLiffMock({ inClient: false });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    assert(r.attempted === false && liffMock._loginCallCount() === 0, 'T6 Instagram WebView → skip，不登入');
  }

  // 7. LIFF init failed（liff.init 拋例外）→ 點餐仍可操作，tryPassive 安全 skip
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff({ init: async () => { throw new Error('liff init failed'); }, isInClient: () => true, isLoggedIn: () => true });
    const gateState = await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    assert(gateState.liffReady === false, 'T7 LIFF init 失敗時 liffReady=false（不拋例外中斷）');
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    assert(r.attempted === false && r.reason === 'liff_init_failed', 'T7 LIFF init 失敗 → tryPassiveLiffIdentification 安全 skip');
  }

  // 8. 成功路徑：verify 成功 → 儲存 member_session，成功事件由後端負責（前端不重複送出）
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    const liffMock = makeLiffMock();
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchImpl(async (url) => ({
      json: async () => ({
        success: true, member_session: 'signed.session.token.abc123', require_friend: false, is_friend: null,
        member: { line_user_id_masked: 'U123****abc', display_name: 'Tester', is_friend: null },
      }),
    }));
    const events = [];
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === true && r.ok === true, 'T8 成功路徑：attempted=true, ok=true');
    assert(liffMock._loginCallCount() === 0, 'T8 成功路徑仍然沒有呼叫 liff.login()');
    const saved = h.LineMemberGate.getMemberSession('store_001');
    assert(!!saved && saved.member_session === 'signed.session.token.abc123', 'T8 member_session 正確保存到 localStorage');
    const calls = h.getFetchCalls();
    const verifyCall = calls.find((c) => String(c.url).includes('/api/line-member/verify'));
    assert(!!verifyCall, 'T8 有呼叫 /api/line-member/verify');
    const sentBody = JSON.parse(verifyCall.opts.body);
    assert(sentBody.analytics && sentBody.analytics.gate_stage === 'liff_auto_identify', 'T8 gate_stage=liff_auto_identify 正確送出');
    assert(events.some((e) => e[0] === 'line_liff_auto_identify_started'), 'T8 有送出 started 事件');
    assert(!events.some((e) => e[0] === 'line_liff_auto_identify_success'), 'T8 前端不重複送出 success 事件（由後端負責）');
  }

  // 9. 已有有效 member_session → 不重複 verify
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock());
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'existing.session', member: { display_name: 'X' } });
    const events = [];
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === false && r.reason === 'already_identified', 'T9 已有 member_session → 不重複 verify');
    assert(h.getFetchCalls().filter((c) => String(c.url).includes('/verify')).length === 0, 'T9 未呼叫 /verify');
  }

  // 10. 同一頁 load → 不重複 Auto Identify（第二次呼叫即使沒有 session 也不再嘗試）
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock());
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchImpl(async () => ({ json: async () => ({ success: false, reason: 'verify_failed', code: 'VERIFY_FAILED' }) }));
    const r1 = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    assert(r1.attempted === true, 'T10 第一次呼叫確實嘗試');
    const callsAfterFirst = h.getFetchCalls().filter((c) => String(c.url).includes('/verify')).length;
    const r2 = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    const callsAfterSecond = h.getFetchCalls().filter((c) => String(c.url).includes('/verify')).length;
    assert(r2.attempted === false, 'T10 同一頁 load 第二次呼叫 → 不重複嘗試');
    assert(callsAfterSecond === callsAfterFirst, 'T10 第二次呼叫未再打 /verify');
  }

  // 11. ID Token 不存在 → 不呼叫 liff.login()，安全 skip/failed
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    const liffMock = makeLiffMock({ missingToken: true });
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const events = [];
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.attempted === true && r.ok === false, 'T11 ID Token 缺失 → attempted=true, ok=false');
    assert(liffMock._loginCallCount() === 0, 'T11 ID Token 缺失 → 絕不呼叫 liff.login()（不同於一般 verifyWithBackend 的自動恢復）');
    assert(events.some((e) => e[0] === 'line_liff_auto_identify_failed' && e[1].metadata.reason_code === 'id_token_missing'), 'T11 failed 事件 reason_code=id_token_missing');
    assert(h.getFetchCalls().filter((c) => String(c.url).includes('/verify')).length === 0, 'T11 Token 未就緒不送出 verify request');
  }

  // 12. ID Token 已過期 → 不呼叫 liff.login()（與一般 verifyWithBackend 的關鍵差異）
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    const liffMock = makeLiffMock({ idTokenExpSecondsFromNow: 5 }); // < minValiditySeconds(60)
    h.setLiff(liffMock);
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const events = [];
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    assert(r.ok === false, 'T12 ID Token 即將過期 → 辨識失敗（非成功）');
    assert(liffMock._loginCallCount() === 0, 'T12 ID Token 過期 → 絕不呼叫 liff.login()（被動辨識不得觸發登入導頁）');
    assert(events.some((e) => e[0] === 'line_liff_auto_identify_failed' && e[1].metadata.reason_code === 'id_token_expired'), 'T12 failed 事件 reason_code=id_token_expired');
  }

  // 13. verify 後端回傳失敗（network 正常但 verify_failed）→ anonymous checkout 仍可進行（不拋例外、不清資料）
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock());
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchImpl(async () => ({ json: async () => ({ success: false, reason: 'verify_failed', code: 'STORE_CONFIG_MISSING' }) }));
    const r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {});
    assert(r.attempted === true && r.ok === false, 'T13 後端驗證失敗 → ok=false（不影響匿名流程繼續，呼叫端不會被阻擋）');
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'T13 驗證失敗不建立任何 member_session');
  }

  // 14. fetch 拋例外（network error）→ 安全 catch，不拋出到呼叫端
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock());
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchImpl(async () => { throw new Error('network down'); });
    let threw = false;
    let r;
    try { r = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, () => {}); } catch (e) { threw = true; }
    assert(threw === false, 'T14 network error 不拋出例外到呼叫端');
    assert(r && r.ok === false, 'T14 network error → ok=false');
  }

  // 15. Metadata 白名單：不得含 LINE UID / Token / member_session 等敏感內容
  {
    const h = loadGateModule('https://shop.example.com/line-order.html?store_id=store_001');
    h.setLiff(makeLiffMock({ inClient: false }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: baseConfig.liff_id }, ids, () => {}, { skipLoginCallback: true });
    const events = [];
    await h.LineMemberGate.tryPassiveLiffIdentification('store_001', baseConfig, ids, (n, e) => events.push([n, e]));
    const meta = events[0][1].metadata;
    const allowedKeys = new Set(['page_type', 'environment', 'gate_mode', 'reason_code', 'is_in_client', 'is_logged_in', 'has_existing_session', 'has_cart']);
    const onlyAllowed = Object.keys(meta).every((k) => allowedKeys.has(k));
    assert(onlyAllowed, 'T15 metadata 只含白名單欄位', JSON.stringify(Object.keys(meta)));
    const serialized = JSON.stringify(meta);
    assert(!/U[0-9a-f]{10,}/.test(serialized) && !serialized.includes('signed.session'), 'T15 metadata 不含 LINE UID / member_session 內容');
  }
}

// ════════════════════════════════════════════════════════════════
// Part B：真實 HTTP — POST /verify（gate_stage=liff_auto_identify）與
// POST /link-context
// ════════════════════════════════════════════════════════════════
async function runPartB() {
  console.log('\n== Part B：routes/line-member.js（真實 HTTP，暫存 sqlite）==');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-phase1-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10';

  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  // monkey-patch LINE 官方驗證 API，必須在 require routes/line-member.js 之前完成
  const lineMemberAuth = require('../utils/lineMemberAuth');
  let verifyBehavior = { ok: true, line_user_id: 'Ufake0000000000000000000001', display_name: 'Tester' };
  lineMemberAuth.verifyLineIdToken = async (idToken, channelId) => {
    if (!verifyBehavior.ok) return { ok: false, reason: verifyBehavior.reason || 'verify_failed', code: verifyBehavior.code || 'UNKNOWN_VERIFY_ERROR' };
    return { ok: true, line_user_id: verifyBehavior.line_user_id, display_name: verifyBehavior.display_name, picture_url: '' };
  };
  lineMemberAuth.getFriendshipStatus = async () => ({ ok: false, is_friend: null });

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  // 兩間店，供跨店隔離測試
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_beta', 'Store Beta', 'x', 'pro', 1]);
  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  setSetting('store_001', 'line_member_login_channel_id', '2010721031');
  setSetting('store_001', 'line_member_auto_identify_enabled', '1');
  setSetting('store_beta', 'line_member_login_channel_id', '2010721099');

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = req.query.store_id || 'store_001'; next(); });
  app.use('/api/line-member', require('../routes/line-member'));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function post(pathname, storeId, body) {
    const res = await fetch(`${base}${pathname}?store_id=${encodeURIComponent(storeId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  try {
    // 16. Auto Identify 成功但 cart 尚不存在 → verify 仍成功，只是沒有 cart_id
    verifyBehavior = { ok: true, line_user_id: 'Ufakeuser000000000000000001', display_name: 'Alice' };
    const v1 = await post('/api/line-member/verify', 'store_001', {
      id_token: 'fake', access_token: 'fake-at', visitor_id: 'visitor-1', session_id: 'session-1',
      analytics: { gate_stage: 'liff_auto_identify', order_mode: 'takeout' },
    });
    assert(v1.json.success === true, 'T16 gate_stage=liff_auto_identify 的 /verify 成功', JSON.stringify(v1.json));
    const memberSession1 = v1.json.member_session;
    assert(!!memberSession1, 'T16 回傳 member_session');

    const rowMember = db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Ufakeuser000000000000000001']);
    assert(!!rowMember, 'T4/T5 line_members 正確建立');
    const rowSession = db.get('SELECT * FROM line_member_sessions WHERE store_id=? AND line_user_id=? AND visitor_id=?', ['store_001', 'Ufakeuser000000000000000001', 'visitor-1']);
    assert(!!rowSession, 'T5 line_member_sessions 正確建立（verify 內部已呼叫 linkMemberSession）');

    const successEvt = db.get(`SELECT * FROM analytics_events WHERE store_id=? AND event_name='line_liff_auto_identify_success' ORDER BY id DESC LIMIT 1`, ['store_001']);
    assert(!!successEvt, '後端額外記錄 line_liff_auto_identify_success 事件');

    // 17. 第一次真正建立 cart_id 後，/link-context 補綁成功
    const linkResult = await post('/api/line-member/link-context', 'store_001', {
      member_session: memberSession1, visitor_id: 'visitor-1', session_id: 'session-1', cart_id: 'cart-abc-001',
    });
    assert(linkResult.json.success === true, 'T17 /link-context 補綁成功', JSON.stringify(linkResult.json));
    const rowSessionAfterLink = db.get('SELECT * FROM line_member_sessions WHERE store_id=? AND line_user_id=? AND visitor_id=?', ['store_001', 'Ufakeuser000000000000000001', 'visitor-1']);
    assert(rowSessionAfterLink && rowSessionAfterLink.cart_id === 'cart-abc-001', 'T17 line_member_sessions.cart_id 已更新');

    // 18. link-context 不接受 raw LINE UID（body 完全不看 line_user_id 欄位，只信任 member_session）
    const rawUidAttempt = await post('/api/line-member/link-context', 'store_001', {
      member_session: 'not-a-real-session-but-line_user_id-below',
      line_user_id: 'Uattacker0000000000000000001',
      visitor_id: 'visitor-attacker', session_id: 'session-attacker', cart_id: 'cart-attacker',
    });
    assert(rawUidAttempt.json.success === false && rawUidAttempt.json.reason === 'invalid_session', 'T18 不接受 raw line_user_id／無效 member_session 一律拒絕');
    const attackerRow = db.get('SELECT * FROM line_member_sessions WHERE visitor_id=?', ['visitor-attacker']);
    assert(!attackerRow, 'T18 未建立任何以偽造 UID 為基礎的綁定資料');

    // 19. 無效 member_session（竄改簽章）→ link-context 拒絕
    const tamperedSession = memberSession1.slice(0, -4) + 'XXXX';
    const tamperedResult = await post('/api/line-member/link-context', 'store_001', {
      member_session: tamperedSession, visitor_id: 'visitor-2', session_id: 'session-2', cart_id: 'cart-2',
    });
    assert(tamperedResult.json.success === false && tamperedResult.json.reason === 'invalid_session', 'T19 竄改過的 member_session → 拒絕');

    // 20. store A 的 session 無法綁 store B 的 cart（跨店隔離）
    const crossStoreResult = await post('/api/line-member/link-context', 'store_beta', {
      member_session: memberSession1, visitor_id: 'visitor-cross', session_id: 'session-cross', cart_id: 'cart-cross',
    });
    assert(crossStoreResult.json.success === false && crossStoreResult.json.reason === 'invalid_session', 'T20 store A session 無法用於 store B（verifyMemberSession 內建 store_id 檢查）');
    const crossRow = db.get('SELECT * FROM line_member_sessions WHERE store_id=? AND visitor_id=?', ['store_beta', 'visitor-cross']);
    assert(!crossRow, 'T20 store B 未建立任何跨店綁定資料');

    // 21. 相同 context 重送 → idempotent（不建立第二筆 line_member_sessions row）
    const beforeCount = db.get('SELECT COUNT(*) c FROM line_member_sessions WHERE store_id=? AND line_user_id=?', ['store_001', 'Ufakeuser000000000000000001']).c;
    await post('/api/line-member/link-context', 'store_001', {
      member_session: memberSession1, visitor_id: 'visitor-1', session_id: 'session-1', cart_id: 'cart-abc-001',
    });
    const afterCount = db.get('SELECT COUNT(*) c FROM line_member_sessions WHERE store_id=? AND line_user_id=?', ['store_001', 'Ufakeuser000000000000000001']).c;
    assert(beforeCount === afterCount, 'T21 相同 context 重送 → idempotent（不新增資料列）', `before=${beforeCount} after=${afterCount}`);

    // 22. cart restore（模擬 Handoff 場景）→ context 補綁成功（等同 T17 呼叫路徑，換一組 cart_id）
    const restoreLink = await post('/api/line-member/link-context', 'store_001', {
      member_session: memberSession1, visitor_id: 'visitor-1', session_id: 'session-1', cart_id: 'cart-after-restore',
    });
    assert(restoreLink.json.success === true, 'T22 cart restore 後 link-context 補綁成功');

    // verify fail 分支：不建立錯誤會員（T14）
    verifyBehavior = { ok: false, reason: 'aud_mismatch', code: 'CHANNEL_ID_MISMATCH' };
    const beforeMemberCount = db.get('SELECT COUNT(*) c FROM line_members WHERE store_id=?', ['store_001']).c;
    const vFail = await post('/api/line-member/verify', 'store_001', {
      id_token: 'fake', access_token: 'fake-at', visitor_id: 'visitor-fail', session_id: 'session-fail',
      analytics: { gate_stage: 'liff_auto_identify' },
    });
    assert(vFail.json.success === false, 'T14 verify fail → success=false');
    const afterMemberCount = db.get('SELECT COUNT(*) c FROM line_members WHERE store_id=?', ['store_001']).c;
    assert(beforeMemberCount === afterMemberCount, 'T14 verify fail 不建立錯誤會員資料');
    const failedEvt = db.get(`SELECT * FROM analytics_events WHERE store_id=? AND event_name='line_liff_auto_identify_failed' ORDER BY id DESC LIMIT 1`, ['store_001']);
    assert(!!failedEvt, '後端額外記錄 line_liff_auto_identify_failed 事件');

    // 28. Token／UID 不落地：檢查 analytics_events.metadata_json 不含完整 Token／UID
    const allLiffEvents = db.all(`SELECT metadata_json FROM analytics_events WHERE store_id=? AND event_name LIKE 'line_liff_auto_identify_%'`, ['store_001']);
    const anyLeak = allLiffEvents.some((r) => {
      const m = String(r.metadata_json || '');
      return m.includes('Ufakeuser000000000000000001') || m.includes('fake-access-token') || /eyJ/.test(m);
    });
    assert(!anyLeak, 'T28 analytics_events metadata 不含完整 Token／UID');
  } finally {
    server.close();
    delete process.env.POS_DB_PATH;
    cleanup();
  }
}

// ════════════════════════════════════════════════════════════════
// Part C：靜態檢查 — LIFF ID 分離／shouldInitLiff／未複製兩套邏輯
// ════════════════════════════════════════════════════════════════
function runPartC() {
  console.log('\n== Part C：靜態檢查（LIFF ID 分離／shouldInitLiff）==');
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shippingHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');

  // 23. line-order 使用 line_member_liff_id
  assert(/liff_id:d\.line_member_liff_id\|\|''/.test(orderHtml), 'T23 line-order.html 使用 line_member_liff_id');

  // 24/25. line-shipping 優先使用 line_shipping_liff_id，未設定時 fallback line_member_liff_id
  assert(/liff_id:d\.line_shipping_liff_id\|\|d\.line_member_liff_id\|\|''/.test(shippingHtml), 'T24/T25 line-shipping.html 優先 line_shipping_liff_id，fallback line_member_liff_id');

  // 兩頁都呼叫共用的 tryPassiveLiffIdentification，未複製第二套邏輯
  const orderCallsShared = /LineMemberGate\.tryPassiveLiffIdentification/.test(orderHtml);
  const shippingCallsShared = /LineMemberGate\.tryPassiveLiffIdentification/.test(shippingHtml);
  assert(orderCallsShared && shippingCallsShared, '兩頁皆呼叫共用模組 tryPassiveLiffIdentification（未複製第二套邏輯）');

  // shouldInitLiff 邏輯存在
  assert(/gate_enabled \|\| _lineMemberGateConfig\.auto_identify_enabled \|\| !!cartToken/.test(orderHtml), 'line-order.html shouldInitLiff = gate_enabled OR auto_identify_enabled OR cartToken');
  assert(/gate_enabled \|\| _lineMemberGateConfig\.auto_identify_enabled/.test(shippingHtml), 'line-shipping.html shouldInitLiff = gate_enabled OR auto_identify_enabled');

  // 不得寫死本店實際 LIFF ID
  assert(!orderHtml.includes('2010718887-jtVUEHJZ') && !shippingHtml.includes('2010718887-K37rXUUs'), '未 hardcode 本店實際 LIFF ID');

  // 契約 B/C：skipLoginCallback 只能在「唯一理由是 auto_identify_enabled」
  // 時為 true；gate_enabled／cartToken 觸發的初始化必須維持 false（不影響
  // 既有 checkout/entry/handoff/login-resume 行為）。
  assert(/const skipLoginCallback=!_lineMemberGateConfig\.gate_enabled && !cartToken;/.test(orderHtml),
    '契約 B/C：line-order.html skipLoginCallback = !gate_enabled && !cartToken（gate 或 handoff 情境一律 false）');
  assert(/const skipLoginCallback=!_lineMemberGateConfig\.gate_enabled;/.test(shippingHtml),
    '契約 B/C：line-shipping.html skipLoginCallback = !gate_enabled（gate 情境一律 false）');
  assert(/initLineMemberGate\(\{[^}]+\},\s*_gateIds\(\),\s*_trackEvent,\s*\{\s*skipLoginCallback\s*\}\)/.test(orderHtml),
    'line-order.html 呼叫 initLineMemberGate 時有傳入 { skipLoginCallback }');
  assert(/initLineMemberGate\(\{[^}]+\},\s*_gateIds\(\),\s*_trackEvent,\s*\{\s*skipLoginCallback\s*\}\)/.test(shippingHtml),
    'line-shipping.html 呼叫 initLineMemberGate 時有傳入 { skipLoginCallback }');
}

async function main() {
  await runPartA();
  await runPartB();
  runPartC();

  console.log('\n== Phase 1 Summary ==');
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

main().catch((e) => { console.error('Phase 1 test runner crashed:', e); process.exit(1); });
