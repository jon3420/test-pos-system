#!/usr/bin/env node
// scripts/run-h1-4-10-asset-cache-bust-runtime.js
// H1.4.10｜LINE MEMBER ASSET CACHE-BUST FIX targeted runtime tests.
//
// 範圍：
//   CACHE-1..8：public/line-order.html／public/line-shipping.html／
//     public/index.html 的 <script src> version query，以及 server.js
//     的 defense-in-depth Cache-Control 設定（static 原始碼層級稽核，
//     不需要真的啟動 HTTP server）。
//   LEGACY-AUTO-1..3：既有 friend_entry 模式的 Auto Identify／
//     maybeShowFriendEntryGuide、以及 friend_checkout 完全不受本輪影響
//     （真正執行既有函式，非重寫）。
//   REQ-ASSET-1：新版 HTML 依賴的新 API 在新版 line-member-gate.js 內確實
//     存在、可呼叫，不會被 try/catch 靜默吞掉。
'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// Part A — CACHE-1..8：原始碼層級稽核
// ════════════════════════════════════════════════════════════════
function runPartA() {
  console.log('\n== Part A：CACHE-1..8（asset version query + server 端 defense-in-depth）==');
  const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shipSrc = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const indexSrc = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const serverSrc = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

  const orderGateTag = orderSrc.match(/<script src="\/js\/line-member-gate\.js\?v=([^"]+)"><\/script>/);
  const shipGateTag = shipSrc.match(/<script src="\/js\/line-member-gate\.js\?v=([^"]+)"><\/script>/);
  const indexGateTag = indexSrc.match(/<script src="\/js\/line-member-gate\.js\?v=([^"]+)"><\/script>/);

  // CACHE-1／CACHE-2：line-order.html／line-shipping.html 必須引用有 version query 的 line-member-gate.js
  assert(!!orderGateTag, 'CACHE-1 line-order.html 引用有 version query 的 line-member-gate.js');
  assert(!!shipGateTag, 'CACHE-2 line-shipping.html 引用有 version query 的 line-member-gate.js');

  // CACHE-3：index.html 不得再使用 fix18-10-hotfix26-D 當作
  // line-member-gate.js 的 cache-bust version query（注意：檔案內其他地方
  // 可能仍有同名字串出現在功能區塊註解裡，例如「LINE 設定診斷中心」——那是
  // 無關的歷史命名巧合，不是這裡要抓的過期 cache key，所以只檢查
  // <script src> 標籤本身的 version query 值）。
  assert(!(indexGateTag && indexGateTag[1] === 'fix18-10-hotfix26-D'), 'CACHE-3 index.html 的 line-member-gate.js version query 不再是過期 cache key fix18-10-hotfix26-D');
  assert(!!indexGateTag, 'CACHE-3 附帶確認：index.html 仍正確引用有 version query 的 line-member-gate.js');

  // CACHE-4：三個頁面 line-member-gate.js 版本必須一致
  if (orderGateTag && shipGateTag && indexGateTag) {
    const versions = new Set([orderGateTag[1], shipGateTag[1], indexGateTag[1]]);
    assert(versions.size === 1, 'CACHE-4 三個頁面 line-member-gate.js version query 完全一致', `found versions: ${[...versions].join(', ')}`);
  } else {
    fail('CACHE-4 三個頁面 line-member-gate.js version query 完全一致', '前置的 CACHE-1/2/3 有未找到 tag');
  }

  // CACHE-5：phone-utils.js line-order/shipping 版本一致
  const orderPhoneTag = orderSrc.match(/<script src="\/js\/phone-utils\.js\?v=([^"]+)"><\/script>/);
  const shipPhoneTag = shipSrc.match(/<script src="\/js\/phone-utils\.js\?v=([^"]+)"><\/script>/);
  assert(!!orderPhoneTag, 'CACHE-5 前置：line-order.html phone-utils.js 有 version query');
  assert(!!shipPhoneTag, 'CACHE-5 前置：line-shipping.html phone-utils.js 有 version query');
  if (orderPhoneTag && shipPhoneTag) {
    assert(orderPhoneTag[1] === shipPhoneTag[1], 'CACHE-5 phone-utils.js line-order / line-shipping 版本一致', `order=${orderPhoneTag[1]} ship=${shipPhoneTag[1]}`);
  }

  // CACHE-6／CACHE-7：server.js 對這兩支檔案送 no-store/no-cache
  const setHeadersMatch = serverSrc.match(/app\.use\(express\.static\(path\.join\(__dirname, 'public'\), \{\s*setHeaders:[\s\S]*?\n\}\)\);/);
  assert(!!setHeadersMatch, 'CACHE-6/7 前置：找到 express.static setHeaders 區塊');
  if (setHeadersMatch) {
    const block = setHeadersMatch[0];
    assert(/line-member-gate\.js/.test(block) && /no-store, no-cache, must-revalidate/.test(block), 'CACHE-6 server.js 對 line-member-gate.js 送 no-store/no-cache');
    assert(/phone-utils\.js/.test(block), 'CACHE-7 server.js 對 phone-utils.js 送 no-store/no-cache（同一個 setHeaders 條件涵蓋兩者）');
  }

  // CACHE-8：其他一般圖片/CSS 不要被全面改成 no-store——用真正執行
  // setHeaders() 邏輯驗證（抽取真正的 setHeaders function 並直接呼叫），
  // 而不是只看字串「有沒有提到 .css/.png」（那種字串比對容易誤判）。
  {
    const fnMatch = serverSrc.match(/setHeaders: \(res, filePath\) => \{[\s\S]*?\n  \},/);
    assert(!!fnMatch, 'CACHE-8 前置：找到 setHeaders 函式本體');
    if (fnMatch) {
      const fakeRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      // eslint-disable-next-line no-new-func
      const setHeadersFn = new Function('path', 'return (res, filePath) => { ' + fnMatch[0].replace(/^setHeaders: \(res, filePath\) => \{/, '').replace(/\n  \},$/, '') + ' };')(path);
      const cssRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(cssRes, path.join(ROOT, 'public/css/style.css'));
      assert(!cssRes.headers['Cache-Control'], 'CACHE-8 一般 CSS 檔案未被設定 no-store（維持既有預設快取行為）');
      const pngRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(pngRes, path.join(ROOT, 'public/images/logo.png'));
      assert(!pngRes.headers['Cache-Control'], 'CACHE-8 一般圖片檔案未被設定 no-store（維持既有預設快取行為）');
      const otherJsRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(otherJsRes, path.join(ROOT, 'public/js/app.js'));
      assert(!otherJsRes.headers['Cache-Control'], 'CACHE-8 附帶確認：其他一般 JS（如 app.js）也未被全面 no-cache，只有點名的兩支 runtime 檔案受影響');
      const gateRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(gateRes, path.join(ROOT, 'public/js/line-member-gate.js'));
      assert(gateRes.headers['Cache-Control'] === 'no-store, no-cache, must-revalidate', 'CACHE-8 附帶確認：line-member-gate.js 實際執行 setHeaders() 真的會被設定 no-store');
      const phoneRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(phoneRes, path.join(ROOT, 'public/js/phone-utils.js'));
      assert(phoneRes.headers['Cache-Control'] === 'no-store, no-cache, must-revalidate', 'CACHE-8 附帶確認：phone-utils.js 實際執行 setHeaders() 真的會被設定 no-store');
      const htmlRes = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
      setHeadersFn(htmlRes, path.join(ROOT, 'public/line-order.html'));
      assert(htmlRes.headers['Cache-Control'] === 'no-store, no-cache, must-revalidate', 'CACHE-8 附帶確認：既有 .html no-store 規則未被破壞');
    }
  }
}

// ════════════════════════════════════════════════════════════════
// Part B — LEGACY-AUTO-1..3 + REQ-ASSET-1：真正載入
// public/js/line-member-gate.js（沿用既有 harness 手法）執行既有函式。
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
  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const doc = {
    createElement: () => makeFakeElement(idRegistry), body, head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null, visibilityState: 'visible',
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  const win = {
    location: { href: 'https://shop.example.com/line-order.html?store_id=store_001', search: '?store_id=store_001', origin: 'https://shop.example.com', pathname: '/line-order.html' },
    history: { replaceState() {} },
    sessionStorage: { getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null), setItem: (k, v) => sessionStore.set(k, String(v)), removeItem: (k) => sessionStore.delete(k) },
    localStorage: { getItem: (k) => (localStore.has(k) ? localStore.get(k) : null), setItem: (k, v) => localStore.set(k, String(v)), removeItem: (k) => localStore.delete(k) },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10) Line/12.0.0' },
    document: doc, URL, URLSearchParams, console, liff: undefined,
    addEventListener() {}, removeEventListener() {}, dispatchEvent() {},
  };
  win.window = win;
  win.open = () => {};
  const fetchCalls = [];
  const fetchResponses = { verify: { success: true, member: { is_friend: false }, member_session: 'sess-token' }, 'authoritative-friend-sync': { success: false, friend_verified: false }, 'friend-state': { success: false } };
  const fetchProxy = (url) => {
    fetchCalls.push(url);
    let body2 = { success: false };
    if (url.indexOf('/api/line-member/verify') !== -1) body2 = fetchResponses.verify;
    else if (url.indexOf('authoritative-friend-sync') !== -1) body2 = fetchResponses['authoritative-friend-sync'];
    else if (url.indexOf('friend-state') !== -1) body2 = fetchResponses['friend-state'];
    return Promise.resolve({ json: async () => body2 });
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch', 'navigator', code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy, win.navigator);
  return {
    LineMemberGate, win,
    setLiff: (l) => { win.liff = l; },
    setFetchResponse: (key, val) => { fetchResponses[key] = val; },
    getFetchCalls: () => fetchCalls,
  };
}

function makeLiffMock({ inClient = true, isLoggedIn = true, idToken = 'fake.header.body' } = {}) {
  return {
    init: async () => {}, isInClient: () => inClient, isLoggedIn: () => isLoggedIn,
    getAccessToken: () => 'fake-at', getIDToken: () => idToken,
    getFriendship: async () => ({ friendFlag: false }), openWindow: () => {}, login: () => {}, logout: () => {},
  };
}

async function flush() { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }

async function runPartB() {
  console.log('\n== Part B：LEGACY-AUTO-1..3 + REQ-ASSET-1（既有邏輯真正執行，未被本輪影響）==');
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: 'cart-1', order_mode: 'takeout' };

  // LEGACY-AUTO-1：friend_entry + auto_identify_enabled=true + LIFF
  // isInClient/isLoggedIn=true + backend /verify success
  // → tryPassiveLiffIdentification 真正執行、member_session 建立。
  {
    const h = loadGateModule();
    const config = { gate_enabled: true, gate_mode: 'friend_entry', liff_id: '2010758481-FzrmirG9', auto_identify_enabled: true, add_friend_url: 'https://lin.ee/x' };
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: config.liff_id }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('verify', { success: true, member: { is_friend: true, display_name: 'Old Friend' }, member_session: 'sess-legacy-1' });
    const result = await h.LineMemberGate.tryPassiveLiffIdentification('store_001', config, ids, () => {});
    assert(result && result.attempted === true && result.ok === true, 'LEGACY-AUTO-1 tryPassiveLiffIdentification 真正執行且成功');
    const session = h.LineMemberGate.getMemberSession('store_001');
    assert(session && session.member_session === 'sess-legacy-1', 'LEGACY-AUTO-1 member_session 建立（auto identify success，既有既有會員自動辨識行為未被本輪破壞）');
    const calledVerify = h.getFetchCalls().some((u) => u.indexOf('/api/line-member/verify') !== -1);
    assert(calledVerify, 'LEGACY-AUTO-1 確實呼叫既有 /api/line-member/verify（gate_stage=liff_auto_identify），未被替換成別的端點');
  }

  // LEGACY-AUTO-2：friend_entry + 非好友/無 member → maybeShowFriendEntryGuide() 顯示 Modal（柔性引導，非本輪 required gate）
  {
    const h = loadGateModule();
    const config = { gate_enabled: true, gate_mode: 'friend_entry', liff_id: '2010758481-FzrmirG9', add_friend_url: 'https://lin.ee/x' };
    const r = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(r && r.shown === true, 'LEGACY-AUTO-2 非好友/無 member → maybeShowFriendEntryGuide() 顯示 Modal（既有柔性引導行為未被本輪影響）');
    const modal = h.win.document.getElementById('lineMemberGate') || h.win.document.getElementById('lfgPrimaryBtn');
    assert(modal !== null, 'LEGACY-AUTO-2 Modal DOM 確實被建立');
  }

  // LEGACY-AUTO-3：friend_checkout 不受 required mode 修改影響——真正呼叫
  // maybeShowFriendCheckoutGuide()，且允許略過（有「繼續結帳」次要按鈕）。
  {
    const h = loadGateModule();
    const config = { gate_enabled: true, gate_mode: 'friend_checkout', liff_id: '2010758481-FzrmirG9', add_friend_url: 'https://lin.ee/x' };
    const events = [];
    const r = h.LineMemberGate.maybeShowFriendCheckoutGuide('store_001', config, ids, (n, e) => events.push([n, e]));
    assert(r && r.shown === true, 'LEGACY-AUTO-3 friend_checkout guide 正常顯示（未被 required gate 邏輯攔截或取代）');
    const secondaryBtn = h.win.document.getElementById('lfgSecondaryBtn');
    assert(secondaryBtn !== null, 'LEGACY-AUTO-3 仍保留「繼續結帳」次要按鈕（可略過，不是 required 語意）');
    secondaryBtn.dispatchClick();
    assert(events.some((e) => e[0] === 'line_friend_guide_skipped'), 'LEGACY-AUTO-3 點擊仍可送出 skipped 事件（既有可略過行為完整保留）');
  }

  // REQ-ASSET-1：friend_entry_required 在新版 line-member-gate.js 內，
  // requireFriendOnEntryNoLogin / requireFriendBeforeCheckoutNoLogin 確實
  // 存在且可呼叫（不是 undefined，呼叫不會被外層 try/catch 靜默吞掉）。
  {
    const h = loadGateModule();
    assert(typeof h.LineMemberGate.requireFriendOnEntryNoLogin === 'function', "REQ-ASSET-1 typeof LineMemberGate.requireFriendOnEntryNoLogin === 'function'");
    assert(typeof h.LineMemberGate.requireFriendBeforeCheckoutNoLogin === 'function', "REQ-ASSET-1 typeof LineMemberGate.requireFriendBeforeCheckoutNoLogin === 'function'");
    // 真正呼叫一次（friend=true 快速放行路徑），確認呼叫本身不拋出例外——
    // 對應真機回報的「新版 HTML 呼叫舊版 JS 缺 API → throw → 被 try/catch
    // 靜默吞掉」風險，這裡驗證的是「新版 HTML 配新版 JS」時呼叫本身正常。
    h.LineMemberGate.saveMemberSession('store_001', { member_session: 'tok', member: { is_friend: true } });
    let threw = false;
    let res = null;
    try {
      res = await h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', { gate_enabled: true, gate_mode: 'friend_entry_required', liff_id: 'x', add_friend_url: 'https://lin.ee/x' }, ids, () => {});
    } catch (e) { threw = true; }
    assert(threw === false, 'REQ-ASSET-1 新版 HTML + 新版 JS：requireFriendOnEntryNoLogin() 呼叫不拋出例外');
    assert(res && res.ok === true, 'REQ-ASSET-1 呼叫結果正確（friend=true → ok:true）');
  }
}

async function main() {
  runPartA();
  await runPartB();

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
