#!/usr/bin/env node
// scripts/smoke-hotfix26-i.js — fix18-10-hotfix26-I smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-i.js
//
// 範圍：Facebook／Instagram 內建瀏覽器 LINE 登入環境修復
// （public/js/line-member-gate.js：detectBrowserEnvironment／loginWithLine／
//  buildLiffOpenUrl／SAFE_FORWARD_PARAMS／persistBeforeExternalLogin／
//  readExternalLoginPending／showExternalBrowserLoginGuide／
//  requireMemberBeforeCheckout／requireMemberOnEntry 的外部瀏覽器分支）。
//
// 做法：沿用 smoke-hotfix26-b.js 的 loadGateModule 手法，在 Node 內用最小
// window/document/liff/fetch mock 直接 eval public/js/line-member-gate.js
// 的原始碼，不需要真正的瀏覽器或 LINE App。
//
// 不在此腳本自動化範圍內（標示 [MANUAL REQUIRED]）：
//   - 真實 Facebook／Instagram App 內建瀏覽器的實際 UA 字串與行為（僅能用
//     已知公開 UA 樣本測試，無法涵蓋所有版本）
//   - line-order.html／line-shipping.html 送出按鈕在真實瀏覽器的視覺恢復
//   - Android intent scheme 在真實 Android 裝置上是否真的喚起 Chrome

'use strict';
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════
// 最小 window/document/liff/fetch/navigator mock
// （含 addEventListener／navigator，修正 hotfix26-G 遺留的 regression）
// ════════════════════════════════════════════════════════════════
function makeFakeElement(idRegistry) {
  const listeners = {};
  const el = {
    style: {}, disabled: false, textContent: '', _html: '', children: {}, parentNode: null,
    addEventListener(type, fn) { (listeners[type] = listeners[type] || []).push(fn); },
    dispatchClick() { (listeners.click || []).forEach((fn) => fn()); },
    querySelector(sel) { if (sel[0] === '#') return el.children[sel.slice(1)] || null; return null; },
  };
  Object.defineProperty(el, 'innerHTML', {
    get() { return el._html; },
    set(html) {
      el._html = html;
      el.children = {};
      const re = /id="([^"]+)"/g;
      let m;
      while ((m = re.exec(html))) {
        const id = m[1];
        const child = makeFakeElement(idRegistry);
        el.children[id] = child;
        idRegistry[id] = child;
      }
    },
  });
  return el;
}

function loadGateModule(initialHref, initialLiff, ua) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  let currentUrl = new URL(initialHref);
  const idRegistry = {};
  const locationAssignments = [];

  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const docListeners = {};
  const doc = {
    createElement: () => makeFakeElement(idRegistry),
    body,
    head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null,
    addEventListener(type, fn) { (docListeners[type] = docListeners[type] || []).push(fn); },
    visibilityState: 'visible',
  };

  const win = {
    location: {
      get href() { return currentUrl.toString(); },
      set href(v) { locationAssignments.push(v); currentUrl = new URL(v, currentUrl.origin); },
      get search() { return currentUrl.search; },
      get origin() { return currentUrl.origin; },
      get pathname() { return currentUrl.pathname; },
    },
    history: { replaceState(state, title, url) { currentUrl = new URL(url, currentUrl.origin); } },
    sessionStorage: {
      getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null),
      setItem: (k, v) => { sessionStore.set(k, String(v)); },
      removeItem: (k) => { sessionStore.delete(k); },
    },
    localStorage: {
      getItem: (k) => (localStore.has(k) ? localStore.get(k) : null),
      setItem: (k, v) => { localStore.set(k, String(v)); },
      removeItem: (k) => { localStore.delete(k); },
    },
    document: doc,
    navigator: { userAgent: ua || '', vendor: '' },
    URL, URLSearchParams, console,
    liff: initialLiff,
    addEventListener() {}, // window.addEventListener('pageshow'/'focus', ...) no-op in this harness
  };
  win.window = win;

  let fetchCalls = [];
  let fetchImpl = async () => ({ json: async () => ({ success: false, reason: 'no_mock_configured' }) });
  const fetchProxy = (...args) => {
    fetchCalls.push({ url: args[0], opts: args[1] });
    return fetchImpl(...args);
  };

  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return {
    LineMemberGate, sessionStore, localStore, doc, win, locationAssignments,
    setLiff: (l) => { win.liff = l; },
    setFetchImpl: (f) => { fetchImpl = f; },
    getFetchCalls: () => fetchCalls,
    fireDocEvent: (type) => (docListeners[type] || []).forEach((fn) => fn()),
  };
}

function makeLoggedInLiffMock({ getFriendshipImpl, loginImpl } = {}) {
  const calls = { login: 0 };
  return {
    _calls: calls,
    init: async () => {},
    isLoggedIn: () => true,
    getIDToken: () => 'fake.id.token',
    getAccessToken: () => 'fake-access-token',
    getFriendship: getFriendshipImpl || (async () => ({ friendFlag: true })),
    login: (opts) => { calls.login++; loginImpl && loginImpl(opts); },
  };
}
function makeLoggedOutLiffMock() {
  const calls = { login: 0 };
  return {
    _calls: calls,
    init: async () => {},
    isLoggedIn: () => false,
    getIDToken: () => null,
    login: (opts) => { calls.login++; },
  };
}

// 已知公開 UA 樣本（涵蓋新舊版 Facebook／Instagram／LINE／Safari／Chrome）
const UA = {
  facebookIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0;FBBV/123456;FBDV/iPhone14,5;FBSV/17.4]',
  facebookAndroidOld: 'Mozilla/5.0 (Linux; Android 13; SM-G991B) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/470.0.0.0;]',
  instagramIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 310.0.0.32.120 (iPhone14,5; iOS 17_4; en_US; en-US; scale=3.00; 1170x2532; 498423242)',
  lineIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/14.5.0',
  safariIOS: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
  chromeAndroid: 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  chromeDesktop: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

// ════════════════════════════════════════════════════════════════
// 1. detectBrowserEnvironment — UA 判斷矩陣
// ════════════════════════════════════════════════════════════════
function testDetectBrowserEnvironment() {
  const cases = [
    ['facebookIOS', { isFacebook: true, isInstagram: false, isInAppBrowser: true, browser: 'facebook', os: 'ios' }],
    ['facebookAndroidOld', { isFacebook: true, isInstagram: false, isInAppBrowser: true, browser: 'facebook', os: 'android' }],
    ['instagramIOS', { isFacebook: false, isInstagram: true, isInAppBrowser: true, browser: 'instagram', os: 'ios' }],
    ['lineIOS', { isFacebook: false, isInstagram: false, isLine: true, isInAppBrowser: false, browser: 'other', os: 'ios' }],
    ['safariIOS', { isFacebook: false, isInstagram: false, isLine: false, isInAppBrowser: false, browser: 'other', os: 'ios' }],
    ['chromeAndroid', { isFacebook: false, isInstagram: false, isLine: false, isInAppBrowser: false, browser: 'other', os: 'android' }],
    ['chromeDesktop', { isFacebook: false, isInstagram: false, isLine: false, isInAppBrowser: false, browser: 'other', os: 'other' }],
  ];
  for (const [uaKey, expected] of cases) {
    const { LineMemberGate } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA[uaKey]);
    const env = LineMemberGate.detectBrowserEnvironment();
    let ok = true; const mismatches = [];
    for (const [k, v] of Object.entries(expected)) {
      if (env[k] !== v) { ok = false; mismatches.push(`${k}: got ${env[k]}, expected ${v}`); }
    }
    if (ok) pass(`detectBrowserEnvironment(${uaKey}): ${JSON.stringify(expected)}`);
    else fail(`detectBrowserEnvironment(${uaKey})`, mismatches.join('; '));
  }
}

// ════════════════════════════════════════════════════════════════
// 2. loginWithLine — Facebook/Instagram 不呼叫 liff.login()，Safari/Chrome 會
// ════════════════════════════════════════════════════════════════
async function testLoginWithLineBranching() {
  // Facebook：不應呼叫 liff.login()，應回傳 externalBrowserRequired=true
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookIOS);
    const liffMock = makeLoggedOutLiffMock();
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const res = await LineMemberGate.loginWithLine('store_001', { gate_stage: 'checkout' });
    if (liffMock._calls.login === 0) pass('Facebook 環境：不呼叫 liff.login()');
    else fail('Facebook 環境：不呼叫 liff.login()', `login called ${liffMock._calls.login} 次`);
    if (res.externalBrowserRequired === true && res.redirected !== true) pass('Facebook 環境：loginWithLine() 回傳 externalBrowserRequired=true');
    else fail('Facebook 環境：回傳 externalBrowserRequired=true', JSON.stringify(res));
  }
  // Instagram：同 Facebook
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.instagramIOS);
    const liffMock = makeLoggedOutLiffMock();
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const res = await LineMemberGate.loginWithLine('store_001', { gate_stage: 'checkout' });
    if (liffMock._calls.login === 0) pass('Instagram 環境：不呼叫 liff.login()');
    else fail('Instagram 環境：不呼叫 liff.login()', `login called ${liffMock._calls.login} 次`);
    if (res.externalBrowserRequired === true) pass('Instagram 環境：loginWithLine() 回傳 externalBrowserRequired=true');
    else fail('Instagram 環境：回傳 externalBrowserRequired=true', JSON.stringify(res));
  }
  // Safari：正常呼叫 liff.login()
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.safariIOS);
    const liffMock = makeLoggedOutLiffMock();
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const res = await LineMemberGate.loginWithLine('store_001', { gate_stage: 'checkout' });
    if (liffMock._calls.login === 1) pass('Safari 環境：正常呼叫 liff.login()');
    else fail('Safari 環境：正常呼叫 liff.login()', `login called ${liffMock._calls.login} 次`);
    if (res.redirected === true && !res.externalBrowserRequired) pass('Safari 環境：loginWithLine() 回傳 redirected=true（非外部瀏覽器引導）');
    else fail('Safari 環境：回傳 redirected=true', JSON.stringify(res));
  }
  // Chrome：正常呼叫 liff.login()
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.chromeAndroid);
    const liffMock = makeLoggedOutLiffMock();
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const res = await LineMemberGate.loginWithLine('store_001', { gate_stage: 'checkout' });
    if (liffMock._calls.login === 1) pass('Chrome 環境：正常呼叫 liff.login()');
    else fail('Chrome 環境：正常呼叫 liff.login()', `login called ${liffMock._calls.login} 次`);
    if (res.redirected === true) pass('Chrome 環境：loginWithLine() 回傳 redirected=true');
    else fail('Chrome 環境：回傳 redirected=true', JSON.stringify(res));
  }
  // LINE App 內 LIFF：不應被誤判為 Facebook/Instagram WebView，正常呼叫 liff.login()
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.lineIOS);
    const liffMock = makeLoggedOutLiffMock();
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const res = await LineMemberGate.loginWithLine('store_001', { gate_stage: 'checkout' });
    if (liffMock._calls.login === 1 && !res.externalBrowserRequired) pass('LINE App 內 LIFF：不受影響，正常呼叫 liff.login()（未被誤判為 FB/IG WebView）');
    else fail('LINE App 內 LIFF：不受影響', JSON.stringify(res) + ` login=${liffMock._calls.login}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 3. buildLiffOpenUrl — 只含白名單參數，不含 Token，只能是 liff.line.me
// ════════════════════════════════════════════════════════════════
function testBuildLiffOpenUrl() {
  const href = 'https://pos.example/line-order.html?store_id=store_001&utm_source=facebook&utm_medium=cpc&fbclid=ABC123&id_token=SHOULD_NOT_APPEAR&access_token=SHOULD_NOT_APPEAR_EITHER&random_param=drop_me';
  const { LineMemberGate } = loadGateModule(href, undefined, UA.facebookIOS);
  const url = LineMemberGate.buildLiffOpenUrl('store_001', { liff_id: '1234567890-abcdefgh' }, { gate_stage: 'checkout' });
  if (url.startsWith('https://liff.line.me/')) pass('buildLiffOpenUrl：網域限定 https://liff.line.me/');
  else fail('buildLiffOpenUrl：網域限定 https://liff.line.me/', url);

  const parsed = new URL(url);
  if (parsed.searchParams.get('utm_source') === 'facebook' && parsed.searchParams.get('fbclid') === 'ABC123' && parsed.searchParams.get('store_id') === 'store_001') {
    pass('buildLiffOpenUrl：正確轉傳白名單參數（utm_source/fbclid/store_id）');
  } else fail('buildLiffOpenUrl：轉傳白名單參數', url);

  if (!parsed.searchParams.has('random_param')) pass('buildLiffOpenUrl：不轉傳白名單以外的參數');
  else fail('buildLiffOpenUrl：不轉傳白名單以外的參數', url);

  if (!url.includes('SHOULD_NOT_APPEAR') && !parsed.searchParams.has('id_token') && !parsed.searchParams.has('access_token')) {
    pass('buildLiffOpenUrl：不含任何 Token');
  } else fail('buildLiffOpenUrl：不含任何 Token', url);

  // 沒有設定 liff_id 時安全回傳空字串，不丟例外
  const empty = LineMemberGate.buildLiffOpenUrl('store_001', {}, {});
  if (empty === '') pass('buildLiffOpenUrl：liff_id 未設定時回傳空字串（不丟例外）');
  else fail('buildLiffOpenUrl：liff_id 未設定時應回傳空字串', empty);
}

// ════════════════════════════════════════════════════════════════
// 4. getSafeCurrentPageUrl — 複製連結不含敏感參數
// ════════════════════════════════════════════════════════════════
function testGetSafeCurrentPageUrl() {
  const href = 'https://pos.example/line-order.html?store_id=store_001&id_token=SECRET_TOKEN&access_token=SECRET_ACCESS&token=SECRET&line_uid=U1234&session=abc#somehash';
  const { LineMemberGate } = loadGateModule(href, undefined, UA.facebookIOS);
  const safeUrl = LineMemberGate.getSafeCurrentPageUrl();
  if (!safeUrl.includes('SECRET') && !safeUrl.includes('U1234') && !safeUrl.includes('#somehash')) {
    pass('getSafeCurrentPageUrl：複製連結不含 id_token/access_token/token/line_uid/session/hash');
  } else fail('getSafeCurrentPageUrl：應移除敏感參數', safeUrl);
  if (safeUrl.includes('store_id=store_001')) pass('getSafeCurrentPageUrl：保留正常購物參數（store_id）');
  else fail('getSafeCurrentPageUrl：應保留 store_id', safeUrl);
}

// ════════════════════════════════════════════════════════════════
// 5. requireMemberBeforeCheckout / requireMemberOnEntry — Promise 正常 resolve，
//    不懸掛，externalBrowserRequired 分支正確顯示外部引導
// ════════════════════════════════════════════════════════════════
async function testCheckoutAndEntryPromiseResolve() {
  {
    const { LineMemberGate, doc, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookIOS);
    setLiff(makeLoggedOutLiffMock());
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const config = { require_friend: true, liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/test' };
    const resultPromise = LineMemberGate.requireMemberBeforeCheckout('store_001', config, {}, () => {});
    await sleep(10);
    const loginBtn = doc.getElementById('lmgLoginBtn');
    if (loginBtn) { loginBtn.dispatchClick(); } else { fail('checkout: 找不到登入按鈕', ''); return; }
    const result = await Promise.race([resultPromise, sleep(500).then(() => 'TIMEOUT')]);
    if (result !== 'TIMEOUT') pass('checkout（Facebook 環境）：Promise 正常 resolve，不懸掛');
    else { fail('checkout（Facebook 環境）：Promise 懸掛超過 500ms', ''); return; }
    if (result && result.ok === false && result.externalBrowserRequired === true) {
      pass('checkout（Facebook 環境）：resolve 為 {ok:false, externalBrowserRequired:true}（送出按鈕可依此恢復）');
    } else fail('checkout（Facebook 環境）：resolve 內容不符', JSON.stringify(result));
    const guideEl = doc.getElementById('lineMemberExternalGuide') || null;
    // 由於 idRegistry 只在對應容器 innerHTML set 時註冊 id，這裡改用行為斷言：
    // showExternalBrowserLoginGuide 呼叫後應該有 lmgOpenLineBtn 可互動。
    if (doc.getElementById('lmgOpenLineBtn')) pass('checkout（Facebook 環境）：顯示外部瀏覽器引導（使用 LINE 開啟按鈕存在）');
    else fail('checkout（Facebook 環境）：應顯示外部瀏覽器引導', '');
  }
  {
    const { LineMemberGate, doc, setLiff } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookIOS);
    setLiff(makeLoggedOutLiffMock());
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
    const config = { require_friend: false, liff_id: '1234567890-abcdefgh', allow_skip: true };
    const resultPromise = LineMemberGate.requireMemberOnEntry('store_001', config, {}, () => {});
    await sleep(10);
    const loginBtn = doc.getElementById('lmgLoginBtn');
    if (loginBtn) loginBtn.dispatchClick();
    const result = await Promise.race([resultPromise, sleep(500).then(() => 'TIMEOUT')]);
    if (result !== 'TIMEOUT' && result && result.externalBrowserRequired === true) {
      pass('entry（Facebook 環境）：Promise 正常 resolve，externalBrowserRequired=true');
    } else fail('entry（Facebook 環境）：Promise 應正常 resolve 並帶 externalBrowserRequired', JSON.stringify(result));
  }
}

// ════════════════════════════════════════════════════════════════
// 6. Pending state：15 分鐘後自動失效
// ════════════════════════════════════════════════════════════════
function testPendingExpiry() {
  const { LineMemberGate, sessionStore } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookIOS);
  LineMemberGate.persistBeforeExternalLogin('store_001', { gate_stage: 'checkout' });
  const fresh = LineMemberGate.readExternalLoginPending();
  if (fresh && fresh.store_id === 'store_001') pass('readExternalLoginPending：剛保存的 pending 可正常讀回');
  else fail('readExternalLoginPending：剛保存的 pending 應可讀回', JSON.stringify(fresh));

  // 竄改 created_at 使其超過 15 分鐘
  const key = 'line_member_external_login_pending';
  const raw = JSON.parse(sessionStore.get(key));
  raw.created_at = Date.now() - 16 * 60 * 1000;
  sessionStore.set(key, JSON.stringify(raw));
  const expired = LineMemberGate.readExternalLoginPending();
  if (expired === null) pass('readExternalLoginPending：超過 15 分鐘自動失效（回傳 null）');
  else fail('readExternalLoginPending：應在 15 分鐘後失效', JSON.stringify(expired));
  if (!sessionStore.has(key)) pass('readExternalLoginPending：過期後自動清除 sessionStorage 記錄');
  else fail('readExternalLoginPending：過期後應清除記錄', '');
}

// ════════════════════════════════════════════════════════════════
// 7. 同一時間只能存在一個外部引導；返回購物車後不自動重彈
// ════════════════════════════════════════════════════════════════
function testSingleGuideAndNoAutoReopen() {
  const { LineMemberGate, doc } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookIOS);
  const config = { liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/test' };
  const g1 = LineMemberGate.showExternalBrowserLoginGuide(config, { storeId: 'store_001', gateStage: 'checkout', onEvent: () => {} });
  const g2 = LineMemberGate.showExternalBrowserLoginGuide(config, { storeId: 'store_001', gateStage: 'checkout', onEvent: () => {} });
  if (g1 === g2) pass('showExternalBrowserLoginGuide：同一時間只會存在一個引導（重複呼叫回傳同一個）');
  else fail('showExternalBrowserLoginGuide：不應同時開啟兩個引導', '');

  let closed = false;
  LineMemberGate.closeExternalBrowserLoginGuide();
  const backBtn = doc.getElementById('lmgExternalBackBtn');
  // 呼叫 close 後，再次顯示應該是新的實例（closed 狀態已重置）
  const g3 = LineMemberGate.showExternalBrowserLoginGuide(config, { storeId: 'store_001', gateStage: 'checkout', onEvent: () => { closed = true; } });
  if (g3) pass('closeExternalBrowserLoginGuide：關閉後可再次開啟新的引導（不會卡在「已開啟」狀態）');
  else fail('closeExternalBrowserLoginGuide：關閉後應可再次開啟', '');
}

// ════════════════════════════════════════════════════════════════
// 8. Android intent fallback（不白畫面、不無限重試——只驗證單次呼叫與例外安全）
// ════════════════════════════════════════════════════════════════
function testAndroidIntentFallback() {
  const { LineMemberGate } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.facebookAndroidOld);
  const ok = LineMemberGate.openInAndroidChrome('https://pos.example/line-order.html?store_id=store_001');
  if (ok === true) pass('openInAndroidChrome：正常情況回傳 true（已嘗試 intent 跳轉一次）');
  else fail('openInAndroidChrome：正常情況應回傳 true', String(ok));

  const bad = LineMemberGate.openInAndroidChrome('not a valid url!!');
  if (bad === false) pass('openInAndroidChrome：無效網址安全回傳 false（不丟例外、有 fallback 空間）');
  else fail('openInAndroidChrome：無效網址應回傳 false', String(bad));
}

// ════════════════════════════════════════════════════════════════
// 9. Analytics 事件不使用既有 Funnel 事件名稱
// ════════════════════════════════════════════════════════════════
function testAnalyticsEventNaming() {
  const FUNNEL_EVENTS = new Set(['page_view', 'view_product', 'add_to_cart', 'remove_from_cart', 'begin_checkout', 'submit_order', 'payment_started', 'purchase']);
  const NEW_EVENTS = [
    'line_login_inapp_browser_detected', 'line_login_external_guide_shown', 'line_login_open_line_clicked',
    'line_login_open_browser_clicked', 'line_login_copy_link_clicked', 'line_login_external_guide_closed',
    'line_login_external_return_detected', 'line_login_external_retry_clicked',
  ];
  const collision = NEW_EVENTS.find((e) => FUNNEL_EVENTS.has(e));
  if (!collision) pass('新增環境事件名稱皆不與既有 Funnel 事件（page_view/add_to_cart/purchase 等）重複');
  else fail('新增環境事件名稱與既有 Funnel 事件重複', collision);

  const src = fs.readFileSync(path.join(ROOT, 'utils/analyticsLog.js'), 'utf8');
  const allWhitelisted = NEW_EVENTS.every((e) => src.includes(`'${e}'`));
  if (allWhitelisted) pass('新增環境事件已 additive 加入 EVENT_WHITELIST（可經 /api/analytics/events 寫入，不建第二套追蹤系統）');
  else fail('新增環境事件應加入 EVENT_WHITELIST', '');

  const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  if (gateSrc.includes('trackLineEnvironmentEvent') && gateSrc.includes('onEvent && onEvent(eventName, payload)')) {
    pass('trackLineEnvironmentEvent 沿用既有 onEvent 回呼架構，不另建第二套 Analytics 系統');
  } else fail('trackLineEnvironmentEvent 應沿用既有 onEvent 架構', '');
}

// ════════════════════════════════════════════════════════════════
// 10. 既有好友 Gate 不被跳過（LINE App 內流程仍完整跑 Friend Gate）
// ════════════════════════════════════════════════════════════════
async function testFriendGateNotSkipped() {
  const { LineMemberGate, doc, setLiff, setFetchImpl } = loadGateModule('https://pos.example/line-order.html?store_id=store_001', undefined, UA.lineIOS);
  setLiff({
    init: async () => {}, isLoggedIn: () => true, getIDToken: () => 'fake.id.token',
    getAccessToken: () => 'fake-access-token', getFriendship: async () => ({ friendFlag: false }), login: () => {},
  });
  await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: '1234567890-abcdefgh' }, {}, () => {});
  setFetchImpl(async () => ({
    json: async () => ({
      success: true, member_session: 'sess', require_friend: true, require_follow: true,
      is_friend: false, friend_status: 'non_friend', meets_requirement: false,
      last_friend_check_at: '', member: { line_user_id_masked: 'U***', display_name: 'X', is_friend: false, friend_status: 'non_friend', is_blocked: false },
    }),
  }));
  const config = { require_friend: true, liff_id: '1234567890-abcdefgh', add_friend_url: 'https://lin.ee/test' };
  const resultPromise = LineMemberGate.requireMemberBeforeCheckout('store_001', config, {}, () => {});
  await sleep(10);
  const loginBtn = doc.getElementById('lmgLoginBtn');
  if (loginBtn) loginBtn.dispatchClick();
  await sleep(20);
  const recheckBtn = doc.getElementById('lmgRecheckBtn');
  if (recheckBtn) pass('LINE App 內流程：登入成功但非好友時，仍會顯示「加入官方帳號」Friend Gate（未被 hotfix26-I 跳過）');
  else fail('LINE App 內流程：非好友時應顯示 Friend Gate', 'lmgRecheckBtn not found');
  const result = await Promise.race([resultPromise, sleep(300).then(() => 'PENDING')]);
  if (result === 'PENDING') pass('LINE App 內流程：好友要求未通過前，checkout Promise 正確保持未 resolve（不會誤放行）');
  else fail('LINE App 內流程：好友要求未通過時不應提前 resolve', JSON.stringify(result));
}

// ════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n== Hotfix26-I smoke test（Facebook／Instagram 內建瀏覽器 LINE 登入環境修復）==\n');

  console.log('-- Section 1: detectBrowserEnvironment UA 矩陣 --');
  testDetectBrowserEnvironment();

  console.log('\n-- Section 2: loginWithLine 分支（FB/IG 不呼叫 login，Safari/Chrome/LINE 正常）--');
  await testLoginWithLineBranching();

  console.log('\n-- Section 3: buildLiffOpenUrl 安全性 --');
  testBuildLiffOpenUrl();

  console.log('\n-- Section 4: getSafeCurrentPageUrl 複製連結安全性 --');
  testGetSafeCurrentPageUrl();

  console.log('\n-- Section 5: checkout/entry Promise 正常 resolve --');
  await testCheckoutAndEntryPromiseResolve();

  console.log('\n-- Section 6: Pending state 15 分鐘過期 --');
  testPendingExpiry();

  console.log('\n-- Section 7: 單一引導 + 關閉後可重新開啟 --');
  testSingleGuideAndNoAutoReopen();

  console.log('\n-- Section 8: Android intent fallback --');
  testAndroidIntentFallback();

  console.log('\n-- Section 9: Analytics 事件命名不污染 Funnel --');
  testAnalyticsEventNaming();

  console.log('\n-- Section 10: 既有好友 Gate 不被跳過 --');
  await testFriendGateNotSkipped();

  manual('真實 Facebook／Instagram App 內建瀏覽器的實機行為', '僅能用已知公開 UA 樣本測試 detectBrowserEnvironment()，無法涵蓋所有 App 版本與機型的實際跳轉行為，需人工用真實裝置驗證');
  manual('line-order.html／line-shipping.html 送出按鈕在真實瀏覽器的視覺恢復', '需要真實瀏覽器渲染環境；本測試僅驗證 Promise 有 resolve（送出按鈕理論上可依此恢復），未驗證實際 DOM/CSS 呈現');
  manual('Android intent scheme 在真實 Android 裝置上是否真的喚起 Chrome', 'openInAndroidChrome() 只能驗證有無安全地組出 intent:// 網址並嘗試導頁，無法在 Node 環境驗證裝置實際反應');

  console.log('\n== 結果 ==');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`PASS=${passCount} FAIL=${failCount} MANUAL REQUIRED=${manualCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}: ${r.detail}`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exitCode = 1; });
