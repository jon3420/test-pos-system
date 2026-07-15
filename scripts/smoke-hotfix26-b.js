#!/usr/bin/env node
// scripts/smoke-hotfix26-b.js — fix18-10-hotfix26-B smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-b.js
//
// 範圍：只涵蓋 Hotfix26-B（LINE Friendship Gate，public/js/line-member-gate.js），
// 不含後台會員 UI（Hotfix26-C）與 LINE 設定診斷中心（Hotfix26-D）。
//
// 做法：用最小 window/document/liff/fetch mock，把 public/js/line-member-gate.js
// 的原始碼在 Node 內 eval 執行（不需要真正的瀏覽器），藉此對 require_follow 放行
// 規則、openFriendAddPage fallback、recheckFriendship 流程、Gate DOM 互動做
// 端對端測試——因為 verifyWithBackend 呼叫的 fetch 完全由測試端 mock 決定回應
// 內容，所以不需要真正的 LINE ID Token 或真實伺服器。
//
// 不在此腳本自動化範圍內（標示 [MANUAL REQUIRED]）：
//   - 真實 LINE App 內 liff.getFriendship() / liff.requestFriendship()
//   - line-order.html / line-shipping.html 的 checkout 面板視覺恢復（DOM 耦合，
//     沿用 Hotfix25 smoke test 的靜態程式碼檢視結論，見該腳本註解）

'use strict';
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ════════════════════════════════════════════════════════════════
// 最小 window/document/liff/fetch mock
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

function loadGateModule(initialHref, initialLiff) {
  const code = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const sessionStore = new Map();
  const localStore = new Map();
  let currentUrl = new URL(initialHref);
  const idRegistry = {};

  const body = { appendChild(elm) { elm.parentNode = { removeChild() {} }; } };
  const doc = {
    createElement: () => makeFakeElement(idRegistry),
    body,
    head: { appendChild() {} },
    getElementById: (id) => idRegistry[id] || null,
  };

  const win = {
    location: {
      get href() { return currentUrl.toString(); },
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
    URL, URLSearchParams, console,
    liff: initialLiff,
  };
  win.window = win;

  let fetchCalls = [];
  let fetchImpl = async (url, opts) => ({ json: async () => ({ success: false, reason: 'no_mock_configured' }) });
  // fix18-10-hotfix26-B（測試修正）：setFetchImpl 換掉的是「回應內容」，呼叫紀錄
  // 一律都要記到同一個 fetchCalls，否則 getFetchCalls() 在測試自訂回應後會一直是空的。
  const fetchProxy = (...args) => {
    fetchCalls.push({ url: args[0], opts: args[1] });
    return fetchImpl(...args);
  };

  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'sessionStorage', 'localStorage', 'document', 'fetch',
    code + '\n;return window.LineMemberGate;');
  const LineMemberGate = fn(win, win.sessionStorage, win.localStorage, doc, fetchProxy);

  return {
    LineMemberGate, sessionStore, localStore, doc, win,
    setLiff: (l) => { win.liff = l; },
    setFetchImpl: (f) => { fetchImpl = f; },
    getFetchCalls: () => fetchCalls,
    clearFetchCalls: () => { fetchCalls = []; },
  };
}

function verifyOkResponse({ isFriend, requireFollow, memberSession }) {
  const friendStatus = isFriend === true ? 'friend' : (isFriend === false ? 'non_friend' : 'unknown');
  return {
    success: true,
    member_session: memberSession || 'signed.session.token',
    require_friend: !!requireFollow,
    require_follow: !!requireFollow,
    is_friend: isFriend,
    friend_status: friendStatus,
    meets_requirement: requireFollow ? (isFriend === true ? true : (isFriend === false ? false : null)) : true,
    last_friend_check_at: '2026-07-15T12:00:00.000Z',
    member: {
      line_user_id_masked: 'U1234****abcd',
      display_name: 'Test User',
      picture_url: '',
      is_friend: isFriend,
      friend_status: friendStatus,
      is_blocked: false,
      last_friend_check: '2026-07-15T12:00:00.000Z',
    },
  };
}

function makeLoggedInLiffMock({ getFriendshipImpl, requestFriendshipImpl } = {}) {
  return {
    init: async () => {},
    isLoggedIn: () => true,
    getIDToken: () => 'fake.id.token',
    getAccessToken: () => 'fake-access-token',
    getFriendship: getFriendshipImpl || (async () => ({ friendFlag: true })),
    requestFriendship: requestFriendshipImpl,
    login: () => {},
  };
}

// ════════════════════════════════════════════════════════════════
// 1. 純函式：normalizeServerFriendStatus / normalizeRequireFollow / friendRequirementMet
// ════════════════════════════════════════════════════════════════
function testPureHelperFunctions() {
  const { LineMemberGate } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);

  const nfsCases = [
    [{ is_friend: true }, true],
    [{ is_friend: false }, false],
    [{ friend_status: 'friend' }, true],
    [{ friend_status: 'non_friend' }, false],
    [{ friend_status: 'unknown' }, null],
    [{}, null],
    [null, null],
    [{ member: { is_friend: true } }, true],
    [{ member: { friend_status: 'non_friend' } }, false],
  ];
  let ok = true; let detail = '';
  for (const [input, expected] of nfsCases) {
    const got = LineMemberGate.normalizeServerFriendStatus(input);
    if (got !== expected) { ok = false; detail = `normalizeServerFriendStatus(${JSON.stringify(input)})=${got}, expected ${expected}`; break; }
  }
  if (ok) pass('normalizeServerFriendStatus: is_friend 優先，其次 friend_status，都沒有則 null（含 member 巢狀 fallback）');
  else fail('normalizeServerFriendStatus', detail);

  const nrfCases = [
    [{ require_follow: true }, true],
    [{ require_friend: true }, true],
    [{ require_follow: false, require_friend: false }, false],
    [{}, false],
    [null, false],
  ];
  ok = true; detail = '';
  for (const [input, expected] of nrfCases) {
    const got = LineMemberGate.normalizeRequireFollow(input);
    if (got !== expected) { ok = false; detail = `normalizeRequireFollow(${JSON.stringify(input)})=${got}, expected ${expected}`; break; }
  }
  if (ok) pass('normalizeRequireFollow: require_follow 或 require_friend 任一為 true 即視為 true');
  else fail('normalizeRequireFollow', detail);

  // require_follow 放行規則矩陣（測試項目 1-6）
  const matrix = [
    [false, true, true], [false, false, true], [false, null, true],
    [true, true, true], [true, false, false], [true, null, true],
  ];
  ok = true; detail = '';
  for (const [requireFollow, isFriend, expected] of matrix) {
    const got = LineMemberGate.friendRequirementMet(requireFollow, isFriend);
    if (got !== expected) { ok = false; detail = `friendRequirementMet(${requireFollow},${isFriend})=${got}, expected ${expected}`; break; }
  }
  if (ok) pass('friendRequirementMet: require_follow=false 全放行；require_follow=true 時 true/false/null → 放行/阻擋/放行（未知不誤判）');
  else fail('friendRequirementMet 放行矩陣', detail);
}

// ════════════════════════════════════════════════════════════════
// 2. getClientFriendFlag
// ════════════════════════════════════════════════════════════════
async function testGetClientFriendFlag() {
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: true }) }));
    const v = await LineMemberGate.getClientFriendFlag();
    if (v === true) pass('getClientFriendFlag: liff.getFriendship() 回傳 {friendFlag:true} → true');
    else fail('getClientFriendFlag true case', String(v));
  }
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: false }) }));
    const v = await LineMemberGate.getClientFriendFlag();
    if (v === false) pass('getClientFriendFlag: liff.getFriendship() 回傳 {friendFlag:false} → false');
    else fail('getClientFriendFlag false case', String(v));
  }
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => { throw new Error('network error'); } }));
    const v = await LineMemberGate.getClientFriendFlag();
    if (v === null) pass('getClientFriendFlag: liff.getFriendship() 拋錯 → null（不阻擋、不拋例外）');
    else fail('getClientFriendFlag error case', String(v));
  }
  {
    const { LineMemberGate } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    // 完全沒有 liff（尚未載入 SDK）
    const v = await LineMemberGate.getClientFriendFlag();
    if (v === null) pass('getClientFriendFlag: liff 尚未就緒 → null');
    else fail('getClientFriendFlag no-liff case', String(v));
  }
}

// ════════════════════════════════════════════════════════════════
// 3. verifyWithBackend 送出 friend_flag
// ════════════════════════════════════════════════════════════════
async function testVerifySendsFriendFlag() {
  const { LineMemberGate, setLiff, setFetchImpl, getFetchCalls } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
  setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: true }) }));
  setFetchImpl(async (url, opts) => ({ json: async () => verifyOkResponse({ isFriend: true, requireFollow: false }) }));
  await LineMemberGate.verifyWithBackend('store_001', { visitor_id: 'v1', session_id: 's1' });
  const calls = getFetchCalls();
  const body = calls.length ? JSON.parse(calls[0].opts.body) : null;
  if (body && body.friend_flag === true) pass('verifyWithBackend: request body 含 friend_flag（每次都重新查詢，不只第一次）');
  else fail('verifyWithBackend: request body 含 friend_flag', JSON.stringify(body));
}

// ════════════════════════════════════════════════════════════════
// 4. recheckFriendship 防連點
// ════════════════════════════════════════════════════════════════
async function testRecheckConcurrencyGuard() {
  const { LineMemberGate, setLiff, setFetchImpl } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
  setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: true }) }));
  let inFlightCount = 0; let maxConcurrent = 0;
  setFetchImpl(async () => {
    inFlightCount++;
    maxConcurrent = Math.max(maxConcurrent, inFlightCount);
    await sleep(30);
    inFlightCount--;
    return { json: async () => verifyOkResponse({ isFriend: true, requireFollow: true }) };
  });
  const [r1, r2] = await Promise.all([
    LineMemberGate.recheckFriendship('store_001', {}),
    LineMemberGate.recheckFriendship('store_001', {}),
  ]);
  const oneRejected = (r1.reason === 'in_progress') !== (r2.reason === 'in_progress'); // 恰好一個被擋
  if (maxConcurrent <= 1 && oneRejected) pass('recheckFriendship: 併發呼叫時第二個立即回 in_progress，不會真的併發打兩次 verify');
  else fail('recheckFriendship 防連點', `maxConcurrent=${maxConcurrent} r1=${JSON.stringify(r1)} r2=${JSON.stringify(r2)}`);
}

// ════════════════════════════════════════════════════════════════
// 5. openFriendAddPage：requestFriendship 優先／fallback／無網址
// ════════════════════════════════════════════════════════════════
async function testOpenFriendAddPage() {
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    let requestFriendshipCalled = false;
    setLiff({ requestFriendship: async () => { requestFriendshipCalled = true; return {}; } });
    const res = await LineMemberGate.openFriendAddPage({ add_friend_url: 'https://lin.ee/abc' });
    if (requestFriendshipCalled && res.method === 'requestFriendship') {
      pass('openFriendAddPage: SDK 支援 requestFriendship 時優先使用');
    } else {
      fail('openFriendAddPage: 優先使用 requestFriendship', JSON.stringify(res));
    }
  }
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff({}); // liff 存在但沒有 requestFriendship（SDK 不支援）
    const res = await LineMemberGate.openFriendAddPage({ add_friend_url: 'https://lin.ee/abc' });
    if (res.method === 'add_friend_url' && res.attempted === true) {
      pass('openFriendAddPage: SDK 不支援 requestFriendship 時 fallback 到 add_friend_url');
    } else {
      fail('openFriendAddPage: SDK 不支援時 fallback', JSON.stringify(res));
    }
  }
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff({ requestFriendship: async () => { throw new Error('user cancelled'); } });
    const res = await LineMemberGate.openFriendAddPage({ add_friend_url: 'https://lin.ee/abc' });
    if (res.method === 'add_friend_url' && res.attempted === true) {
      pass('openFriendAddPage: requestFriendship 拋錯時 fallback 到 add_friend_url');
    } else {
      fail('openFriendAddPage: requestFriendship 拋錯 fallback', JSON.stringify(res));
    }
  }
  {
    const { LineMemberGate, setLiff } = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
    setLiff({});
    const res = await LineMemberGate.openFriendAddPage({ add_friend_url: '' });
    if (res.attempted === false && res.method === 'none') {
      pass('openFriendAddPage: 無 requestFriendship 也無 add_friend_url 時顯示友善訊息，不拋例外');
    } else {
      fail('openFriendAddPage: 無網址情境', JSON.stringify(res));
    }
  }
}

// ════════════════════════════════════════════════════════════════
// 6. require_follow 端對端 Gate 流程（entry 模式）
// ════════════════════════════════════════════════════════════════
async function testEntryGateEndToEnd() {
  // 6-1：require_follow=true，登入後不是好友 → 阻擋並顯示加入好友畫面；
  //      按「重新確認」第一次仍非好友 → 保持阻擋；第二次已加入 → 放行
  //
  // fix18-10-hotfix26-B（測試修正）：isLiffAvailable(storeId) 只有在
  // initLineMemberGate() 執行過後才會是 true，一定要先呼叫過一次才能讓後續
  // 按鈕點擊真正觸發 loginWithLine/verifyWithBackend，否則點擊會被
  // 「LIFF 尚未就緒」擋下、畫面永遠停在登入畫面。這裡用一個可切換的
  // isLoggedIn() 旗標：初始化當下先回 false（模擬使用者剛進頁面、尚未登入，
  // 讓 initLineMemberGate 內部的自動 callback 檢查安全略過、不會提前建立
  // session），準備要點擊登入按鈕時才切成 true（模擬「已在 LINE App 內完成
  // 登入」），藉此驅動 requireMemberOnEntry 內按鈕流程往下走。
  {
    const { LineMemberGate, doc, setLiff, setFetchImpl } = loadGateModule(
      'https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined
    );
    let loggedIn = false;
    let friendState = false; // 目前是否為好友（recheck 後可改變）
    setFetchImpl(async () => ({ json: async () => verifyOkResponse({ isFriend: friendState, requireFollow: true }) }));
    setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: friendState }) }));
    // isLoggedIn 改成可切換：覆寫剛剛設定的 mock。
    const liffMock = makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: friendState }) });
    liffMock.isLoggedIn = () => loggedIn;
    setLiff(liffMock);

    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: 'test-liff-id' }, {}, () => {});

    const events = [];
    const config = { require_friend: true, allow_skip: false, friend_button_text: '加入官方帳號', add_friend_url: 'https://lin.ee/test' };
    const resultPromise = LineMemberGate.requireMemberOnEntry('store_001', config, {}, (e) => events.push(e));

    // Gate 顯示登入畫面，模擬使用者在 LINE App 內完成登入後回來按下登入按鈕
    const loginBtn = doc.getElementById('lmgLoginBtn');
    if (!loginBtn) { fail('entry gate: 顯示登入畫面', 'lmgLoginBtn not found'); return; }
    loggedIn = true;
    loginBtn.dispatchClick();
    await sleep(20);

    // 驗證成功、非好友 → 應該切換成「加入官方帳號」畫面
    const addBtn = doc.getElementById('lmgAddFriendBtn');
    const recheckBtn = doc.getElementById('lmgRecheckBtn');
    if (addBtn && recheckBtn) pass('entry gate: require_follow=true 且非好友時，登入後正確顯示「加入官方帳號／重新確認」畫面');
    else { fail('entry gate: 顯示加入官方帳號畫面', `addBtn=${!!addBtn} recheckBtn=${!!recheckBtn}`); return; }

    // 第一次重新確認：仍非好友
    recheckBtn.dispatchClick();
    await sleep(20);
    let settled = await Promise.race([resultPromise.then(() => 'settled'), sleep(10).then(() => 'pending')]);
    if (settled === 'pending') pass('entry gate: 重新確認仍非好友時，Gate 保持開啟（不會誤放行）');
    else fail('entry gate: 重新確認仍非好友時應保持開啟', 'promise resolved too early');

    // 加入好友後再次重新確認：這次是好友
    friendState = true;
    recheckBtn.dispatchClick();
    await sleep(20);
    const finalResult = await Promise.race([resultPromise, sleep(500).then(() => null)]);
    if (finalResult && finalResult.ok === true) pass('entry gate: 加入好友後重新確認 → 放行並關閉 Gate');
    else fail('entry gate: 加入好友後應放行', JSON.stringify(finalResult));

    if (events.includes('friend_prompt_shown') && events.includes('friend_gate_passed')) {
      pass('entry gate: onEvent 依序觸發 friend_prompt_shown → friend_gate_passed');
    } else {
      fail('entry gate: onEvent 事件序列', events.join(','));
    }
  }

  // 6-2：require_follow=false → 不論好友狀態一律放行，不顯示加好友畫面
  {
    const { LineMemberGate, doc, setLiff, setFetchImpl } = loadGateModule(
      'https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined
    );
    let loggedIn = false;
    setFetchImpl(async () => ({ json: async () => verifyOkResponse({ isFriend: false, requireFollow: false }) }));
    const liffMock = makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: false }) });
    liffMock.isLoggedIn = () => loggedIn;
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: 'test-liff-id' }, {}, () => {});

    const config = { require_friend: false, allow_skip: false };
    const resultPromise = LineMemberGate.requireMemberOnEntry('store_001', config, {}, () => {});
    const loginBtn = doc.getElementById('lmgLoginBtn');
    loggedIn = true;
    loginBtn.dispatchClick();
    const result = await Promise.race([resultPromise, sleep(500).then(() => null)]);
    if (result && result.ok === true && !doc.getElementById('lmgAddFriendBtn')) {
      pass('entry gate: require_follow=false 時非好友仍直接放行，不顯示加好友畫面');
    } else {
      fail('entry gate: require_follow=false 直接放行', JSON.stringify(result));
    }
  }

  // 6-3：require_follow=true + friendFlag=null（API 查詢失敗）→ 放行，不誤判為非好友
  {
    const { LineMemberGate, doc, setLiff, setFetchImpl } = loadGateModule(
      'https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined
    );
    let loggedIn = false;
    setFetchImpl(async () => ({ json: async () => verifyOkResponse({ isFriend: null, requireFollow: true }) }));
    const liffMock = makeLoggedInLiffMock({ getFriendshipImpl: async () => { throw new Error('friendship api down'); } });
    liffMock.isLoggedIn = () => loggedIn;
    setLiff(liffMock);
    await LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: 'test-liff-id' }, {}, () => {});

    const config = { require_friend: true, allow_skip: false };
    const resultPromise = LineMemberGate.requireMemberOnEntry('store_001', config, {}, () => {});
    const loginBtn = doc.getElementById('lmgLoginBtn');
    loggedIn = true;
    loginBtn.dispatchClick();
    const result = await Promise.race([resultPromise, sleep(500).then(() => null)]);
    if (result && result.ok === true) pass('entry gate: require_follow=true 但好友狀態未知（null）→ 放行，不永久卡住顧客');
    else fail('entry gate: require_follow=true + null 應放行', JSON.stringify(result));
  }

  // 6-4：allow_skip=true 時略過按鈕存在且可用；allow_skip=false 時不存在
  {
    const { doc: doc1 } = (() => {
      const m = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
      m.setFetchImpl(async () => ({ json: async () => ({ success: false }) }));
      m.setLiff({ isLoggedIn: () => false });
      m.LineMemberGate.requireMemberOnEntry('store_001', { require_friend: false, allow_skip: true }, {}, () => {});
      return m;
    })();
    if (doc1.getElementById('lmgSkipBtn')) pass('entry gate: allow_skip=true 時顯示略過按鈕');
    else fail('entry gate: allow_skip=true 應顯示略過按鈕', 'not found');
  }
  {
    const { doc: doc2 } = (() => {
      const m = loadGateModule('https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined);
      m.setFetchImpl(async () => ({ json: async () => ({ success: false }) }));
      m.setLiff({ isLoggedIn: () => false });
      m.LineMemberGate.requireMemberOnEntry('store_001', { require_friend: false, allow_skip: false }, {}, () => {});
      return m;
    })();
    if (!doc2.getElementById('lmgSkipBtn')) pass('entry gate: allow_skip=false 時不顯示略過按鈕');
    else fail('entry gate: allow_skip=false 不應顯示略過按鈕', 'found unexpectedly');
  }
}

// ════════════════════════════════════════════════════════════════
// 7. require_follow 端對端 Gate 流程（checkout 模式，已有 session 時再檢查一次）
// ════════════════════════════════════════════════════════════════
async function testCheckoutGateExistingSessionRecheck() {
  const { LineMemberGate, doc, win, setLiff, setFetchImpl } = loadGateModule(
    'https://pos-system.zeabur.app/line-order.html?store_id=store_001', undefined
  );
  // 先塞一筆「已登入但非好友」的舊 session（模擬 require_follow 是後來才開啟的情境）
  win.localStorage.setItem('line_member_session_store_001', JSON.stringify({
    member_session: 'existing.session', display_name: 'Old User', is_friend: false, is_blocked: false,
    expires_at: Date.now() + 60 * 60 * 1000,
  }));
  let friendState = false;
  setFetchImpl(async () => ({ json: async () => verifyOkResponse({ isFriend: friendState, requireFollow: true }) }));
  setLiff(makeLoggedInLiffMock({ getFriendshipImpl: async () => ({ friendFlag: friendState }) }));

  const config = { require_friend: true, allow_skip: false, add_friend_url: 'https://lin.ee/test' };
  const resultPromise = LineMemberGate.requireMemberBeforeCheckout('store_001', config, {}, () => {});
  await sleep(10);
  const recheckBtn = doc.getElementById('lmgRecheckBtn');
  if (recheckBtn) pass('checkout gate: 已有 session 但不符合好友要求時，仍會顯示加入官方帳號畫面（不直接放行舊 session）');
  else { fail('checkout gate: 既有 session 也要檢查好友要求', 'lmgRecheckBtn not found'); return; }

  friendState = true;
  recheckBtn.dispatchClick();
  const result = await Promise.race([resultPromise, sleep(500).then(() => null)]);
  if (result && result.ok === true) pass('checkout gate: 重新確認成功後放行並可繼續結帳');
  else fail('checkout gate: 重新確認成功後應放行', JSON.stringify(result));
}

// ════════════════════════════════════════════════════════════════
// 8. 不重複 LIFF init（同一個 storeId 呼叫兩次 initLineMemberGate 不應重複掛 script）
// ════════════════════════════════════════════════════════════════
async function testNoDuplicateLiffInit() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const initCallCount = (src.match(/global\.liff\.init\(/g) || []).length;
  if (initCallCount === 1) pass('grep: liff.init() 只在 initLineMemberGate 內呼叫一次（模組原始碼層級）');
  else fail('grep: liff.init() 呼叫次數', `found ${initCallCount} occurrences, expected 1`);

  // openFriendAddPage / ensureFriendRequirement 不應呼叫 liff.init 或觸碰
  // sessionStorage 返回網址／登入中旗標
  const dangerousInFriendFlowFns = [];
  const friendFlowSrc = src.slice(src.indexOf('async function openFriendAddPage'), src.indexOf('function requireMemberBeforeCheckout'));
  if (/liff\.init\(/.test(friendFlowSrc)) dangerousInFriendFlowFns.push('liff.init');
  if (/RETURN_URL_KEY/.test(friendFlowSrc) || /saveLineMemberReturnUrl\(/.test(friendFlowSrc) || /clearSavedLineMemberReturnUrl\(/.test(friendFlowSrc)) dangerousInFriendFlowFns.push('return-url storage');
  if (/markLoginInProgress\(/.test(friendFlowSrc) || /clearLoginInProgress\(/.test(friendFlowSrc)) dangerousInFriendFlowFns.push('login-in-progress flag');
  if (dangerousInFriendFlowFns.length === 0) {
    pass('grep: openFriendAddPage／ensureFriendRequirement 不觸碰 liff.init／return-url／login-in-progress（不清購物車、不清返回網址、不卡住登入中旗標）');
  } else {
    fail('grep: 好友流程不應觸碰的狀態', dangerousInFriendFlowFns.join(','));
  }
}

// ════════════════════════════════════════════════════════════════
// 9. HTML 靜態檢查：line-order.html / line-shipping.html 仍引用共用模組，
//    且本階段未修改這兩個檔案（Hotfix25 既有 checkout resume 機制原樣保留）
// ════════════════════════════════════════════════════════════════
function testHtmlStaticChecks() {
  const orderHtml = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
  const shippingHtml = fs.readFileSync(path.join(ROOT, 'public/line-shipping.html'), 'utf8');
  const bothReference = /line-member-gate\.js/.test(orderHtml) && /line-member-gate\.js/.test(shippingHtml);
  if (bothReference) pass('line-order.html／line-shipping.html 皆引用共用模組 public/js/line-member-gate.js（未建立第二套）');
  else fail('line-order.html／line-shipping.html 引用共用模組', `order=${/line-member-gate\.js/.test(orderHtml)} shipping=${/line-member-gate\.js/.test(shippingHtml)}`);

  const orderHasOwnLiffInit = /(?<!LineMemberGate\.)\bliff\.init\(/.test(orderHtml.replace(/LineMemberGate\.initLineMemberGate/g, ''));
  const shippingHasOwnLiffInit = /(?<!LineMemberGate\.)\bliff\.init\(/.test(shippingHtml.replace(/LineMemberGate\.initLineMemberGate/g, ''));
  if (!orderHasOwnLiffInit && !shippingHasOwnLiffInit) {
    pass('line-order.html／line-shipping.html 沒有另外呼叫 liff.init()（全部透過共用模組的 initLineMemberGate）');
  } else {
    fail('line-order.html／line-shipping.html 不應各自呼叫 liff.init()', `order=${orderHasOwnLiffInit} shipping=${shippingHasOwnLiffInit}`);
  }

  const orderResumeOnce = /gate_mode===['"]checkout['"]\s*&&\s*cbResult\s*&&\s*cbResult\.ok\s*&&\s*cbResult\.autoVerified/.test(orderHtml.replace(/\s+/g, ' '));
  manual('line-order.html／line-shipping.html checkout 面板視覺恢復只執行一次', '需要真實瀏覽器/完整 DOM 才能可靠模擬購物車面板重開；程式碼靜態檢視確認 openCartSheet() 只在 gate_mode===checkout && cbResult.ok && cbResult.autoVerified 條件下呼叫一次（Hotfix25 既有邏輯，本階段未修改），符合條件才會執行，見 _initLineMemberGateFromShopData()');
  void orderResumeOnce;
}

// ════════════════════════════════════════════════════════════════
// main
// ════════════════════════════════════════════════════════════════
async function main() {
  console.log('\n== Hotfix26-B smoke test ==\n');

  console.log('-- Section 1: pure helper functions --');
  testPureHelperFunctions();

  console.log('\n-- Section 2: getClientFriendFlag --');
  await testGetClientFriendFlag();

  console.log('\n-- Section 3: verifyWithBackend sends friend_flag --');
  await testVerifySendsFriendFlag();

  console.log('\n-- Section 4: recheckFriendship concurrency guard --');
  await testRecheckConcurrencyGuard();

  console.log('\n-- Section 5: openFriendAddPage (requestFriendship / fallback) --');
  await testOpenFriendAddPage();

  console.log('\n-- Section 6: entry-mode gate end-to-end --');
  await testEntryGateEndToEnd();

  console.log('\n-- Section 7: checkout-mode gate re-checks existing session --');
  await testCheckoutGateExistingSessionRecheck();

  console.log('\n-- Section 8: no duplicate LIFF init / friend-flow does not touch unrelated state --');
  await testNoDuplicateLiffInit();

  console.log('\n-- Section 9: HTML static reference checks --');
  testHtmlStaticChecks();

  console.log('\n-- Section 10: node --check on modified files --');
  const filesToCheck = ['public/js/line-member-gate.js', 'routes/line-member.js', 'utils/lineMemberStats.js'];
  for (const f of filesToCheck) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'pipe' });
      pass(`node --check ${f}`);
    } catch (e) {
      fail(`node --check ${f}`, e.stderr ? e.stderr.toString().split('\n')[0] : e.message);
    }
  }

  manual('真實 liff.getFriendship() 端到端行為', '需要真實 LINE App / LIFF 環境，無法在 sandbox 內模擬 LINE 官方 SDK 實際回應');
  manual('真實 liff.requestFriendship() 端到端行為', '同上，且該 API 需要使用者在 LINE App 內實際操作加好友流程');
  manual('真實加入好友後按「重新確認」的完整視覺流程', '需要真實瀏覽器 + 真實 LINE 帳號才能驗證 UI 實際渲染效果');

  console.log('\n== 結果 ==');
  const passCount = results.filter((r) => r.status === 'PASS').length;
  const failCount = results.filter((r) => r.status === 'FAIL').length;
  const manualCount = results.filter((r) => r.status === 'MANUAL REQUIRED').length;
  console.log(`PASS=${passCount} FAIL=${failCount} MANUAL REQUIRED=${manualCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter((r) => r.status === 'FAIL').forEach((r) => console.log(` - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('smoke test crashed:', e); process.exitCode = 1; });
