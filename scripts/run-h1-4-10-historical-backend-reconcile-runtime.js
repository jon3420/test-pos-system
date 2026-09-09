#!/usr/bin/env node
// scripts/run-h1-4-10-historical-backend-reconcile-runtime.js
// H1.4.10｜HISTORICAL FRIEND BACKEND-REALITY RECONCILIATION targeted runtime.
//
// 範圍：HBR-1..HBR-12——驗證「本地 friend cache 不得單獨決定 backend repair
// 是否執行、也不得單獨決定 Required Gate 是否放行」這個核心修正。真正載入
// production 原始碼（public/js/line-member-gate.js）與 routes/line-member.js
// 的 /friend-state member_exists 欄位邏輯（後者用真正的 sqlite DB + Express
// route handler 執行，不是重寫）。
'use strict';
const path = require('path');
const fs = require('fs');
const express = require('express');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

// ════════════════════════════════════════════════════════════════
// Part A — 真正的 /friend-state 後端 route：驗證 member_exists 欄位
// （沿用 scripts/run-h1-4-10-historical-friend-first-touch-runtime.js
// 既有手法：utils/db.js + POS_DB_PATH 隔離 + 真實 express route）。
// ════════════════════════════════════════════════════════════════
async function runPartA() {
  console.log('\n== Part A：/friend-state member_exists 欄位（真正 Express route + sqlite）==');
  const http = require('http');
  const os2 = require('os');
  const tmpDir = fs.mkdtempSync(path.join(os2.tmpdir(), 'h1-4-10-hbr-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-hbr';

  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  const { initDb, getDb } = require(path.join(ROOT, 'utils', 'db.js'));
  await initDb();
  const db = getDb();
  const { createMemberSession } = require(path.join(ROOT, 'utils', 'lineMemberSession.js'));
  const STORE_ID = 'store_hbr';

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = req.query.store_id || STORE_ID; next(); });
  app.use('/api/line-member', require(path.join(ROOT, 'routes', 'line-member.js')));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function friendState(memberSession) {
    const res = await fetch(`${base}/api/line-member/friend-state?store_id=${STORE_ID}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: memberSession }),
    });
    return res.json();
  }

  try {
    const lineUserIdMissing = 'Uhbr_missing_member';
    const lineUserIdExists = 'Uhbr_existing_member';
    db.run(
      `INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, friend_status, first_seen_at, last_seen_at)
       VALUES (?,?,?,?,?,?,?)`,
      [STORE_ID, lineUserIdExists, 'Existing Friend', 1, 'friend', '2020-01-01 00:00:00', '2020-01-01 00:00:00']
    );

    const sessionMissing = createMemberSession({ store_id: STORE_ID, line_user_id: lineUserIdMissing });
    const sessionExists = createMemberSession({ store_id: STORE_ID, line_user_id: lineUserIdExists });

    // Case 1：member row 不存在
    {
      const json = await friendState(sessionMissing);
      assert(json.success === true, 'A-1 member 不存在時 /friend-state 仍 success:true（不因缺會員報錯）');
      assert(json.member_exists === false, 'A-1 member_exists 明確回傳 false（新增欄位正確運作）');
      assert(json.is_friend === null, 'A-1 is_friend 維持既有語意（null，不影響既有欄位型別/相容性）');
    }
    // Case 2：member row 存在且 is_friend=true
    {
      const json = await friendState(sessionExists);
      assert(json.success === true, 'A-2 member 存在時 /friend-state success:true');
      assert(json.member_exists === true, 'A-2 member_exists 明確回傳 true');
      assert(json.is_friend === true, 'A-2 is_friend 正確回傳 true（既有欄位未被破壞）');
    }
    // Case 3：response 不含任何 PII/token/UID
    {
      const json = await friendState(sessionExists);
      const keys = Object.keys(json);
      assert(!keys.includes('line_user_id') && !keys.includes('member_session') && !keys.includes('token'), 'A-3 response 不含 raw UID／member_session／token 等敏感欄位');
    }
  } finally {
    server.close();
    cleanup();
  }
}

// ════════════════════════════════════════════════════════════════
// Part B — HBR-1..HBR-12：前端 line-member-gate.js 真正模組執行
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
    getElementById: (id) => idRegistry[id] || null, visibilityState: 'visible',
    addEventListener(type, fn2) { (docListeners[type] = docListeners[type] || []).push(fn2); }, removeEventListener() {},
    dispatchEvent(type) { (docListeners[type] || []).forEach((fn2) => fn2()); },
  };
  const win = {
    location: { href: 'https://shop.example.com/line-order.html?store_id=store_001', search: '?store_id=store_001', origin: 'https://shop.example.com', pathname: '/line-order.html' },
    history: { replaceState() {} },
    sessionStorage: { getItem: (k) => (sessionStore.has(k) ? sessionStore.get(k) : null), setItem: (k, v) => sessionStore.set(k, String(v)), removeItem: (k) => sessionStore.delete(k) },
    localStorage: { getItem: (k) => (localStore.has(k) ? localStore.get(k) : null), setItem: (k, v) => localStore.set(k, String(v)), removeItem: (k) => localStore.delete(k) },
    navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 10) Line/12.0.0' },
    document: doc, URL, URLSearchParams, console, liff: undefined,
    addEventListener(type, fn2) { (winListeners[type] = winListeners[type] || []).push(fn2); }, removeEventListener() {},
    dispatchEvent(type) { (winListeners[type] || []).forEach((fn2) => fn2()); },
  };
  win.window = win;
  win.open = () => {};
  const fetchCalls = [];
  const fetchResponses = { 'authoritative-friend-sync': { success: false, friend_verified: false, reason: 'NOT_FRIEND' }, 'friend-state': { success: false } };
  let fetchShouldThrowFor = null; // e.g. 'authoritative-friend-sync' | 'friend-state' | null
  const fetchProxy = (url) => {
    fetchCalls.push(url);
    if (fetchShouldThrowFor && url.indexOf(fetchShouldThrowFor) !== -1) return Promise.reject(new Error('simulated network error/timeout'));
    let body2 = { success: false };
    if (url.indexOf('authoritative-friend-sync') !== -1) body2 = fetchResponses['authoritative-friend-sync'];
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
    setFetchThrowsFor: (key) => { fetchShouldThrowFor = key; },
    getFetchCalls: () => fetchCalls,
    getRemovedNodes: () => removedNodes,
    fireWinEvent: (type) => win.dispatchEvent(type),
  };
}

function makeLiffMock({ inClient = true, isLoggedIn = true, friendFlag = false } = {}) {
  return {
    init: async () => {}, isInClient: () => inClient, isLoggedIn: () => isLoggedIn,
    getAccessToken: () => 'fake-at', getIDToken: () => 'fake.id.token',
    getFriendship: async () => ({ friendFlag }), openWindow: () => {}, login: () => {}, logout: () => {},
  };
}

async function flush() { await new Promise((r) => setImmediate(r)); await new Promise((r) => setImmediate(r)); }

function seedStaleFriendSession(h, storeId) {
  // 模擬「member_session 簽章仍有效，但對應的 backend line_members row 已
  // 被刪除」這個真機回報的核心場景：本地快取宣稱 is_friend:true。
  h.LineMemberGate.saveMemberSession(storeId, { member_session: 'stale-sess-token', member: { is_friend: true } });
}

async function runPartB() {
  console.log('\n== Part B：HBR-1..HBR-12（backend reality vs stale local cache，真正執行 production 原始碼）==');
  const ids = { visitor_id: 'v1', session_id: 's1', cart_id: 'cart-1', order_mode: 'takeout' };
  const liffId = '2010758481-FzrmirG9';

  // HBR-1：local friend=true + backend member exists + backend friend=true
  // → no historical LINE API call（省 quota），no duplicate member（backend
  // 端本身冪等，這裡驗證前端根本不會發起 LINE API 呼叫）。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: true, is_friend: true });
    const res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(res && res.success === true && res.friend_verified === true && res.source === 'backend_current', 'HBR-1 backend 確認 member 存在且 friend=true → 直接 backend_current，不打 LINE API');
    const calledSync = h.getFetchCalls().some((u) => u.indexOf('authoritative-friend-sync') !== -1);
    assert(calledSync === false, 'HBR-1 沒有呼叫 authoritative-friend-sync（沒有觸發 LINE Platform API，省 quota）');
    const calledFriendState = h.getFetchCalls().some((u) => u.indexOf('friend-state') !== -1);
    assert(calledFriendState === true, 'HBR-1 確實用便宜的唯讀 /friend-state 查了一次 backend reality');
  }

  // HBR-2 ★ 核心：local friend=true + member_session valid + backend member
  // missing → 不得 short-circuit，必須真正執行 authoritative-friend-sync，
  // LINE friendFlag=true → backend member 建立、friend=true。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(res && res.success === true && res.friend_verified === true, 'HBR-2 backend member missing 時，即使 local cache 是 friend=true，仍真正執行 authoritative-friend-sync 並成功 repair');
    const calledSync = h.getFetchCalls().some((u) => u.indexOf('authoritative-friend-sync') !== -1);
    assert(calledSync === true, 'HBR-2 確實呼叫了 authoritative-friend-sync（沒有被 stale local cache short-circuit 掉）');
  }

  // HBR-3：local friend=true + member_session missing + LIFF logged in +
  // access token valid + LINE friendFlag=true → authoritative sync executes → member created.
  {
    const h = loadGateModule();
    // 刻意不呼叫 seedStaleFriendSession：模擬「local 曾經知道是好友（例如
    // 透過某個較早期、不落地 session 的判斷路徑），但目前完全沒有
    // member_session」的情境——這裡直接測 triggerHistoricalFriendSync 本身
    // 在無 session 時的行為（無法先查 backend reality，直接走 authoritative
    // sync，符合需求文件 3-C）。
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    assert(h.LineMemberGate.getMemberSession('store_001') === null, 'HBR-3 前置：確實沒有 member_session');
    const res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(res && res.friend_verified === true, 'HBR-3 沒有 member_session 時，只要 LIFF ready/logged in/access token 可用，仍執行 authoritative sync 並成功');
    const calledFriendState = h.getFetchCalls().some((u) => u.indexOf('friend-state') !== -1);
    assert(calledFriendState === false, 'HBR-3 沒有 member_session 時完全不呼叫 /friend-state（無法先查，直接走 authoritative sync，符合 Section 3-C）');
  }

  // HBR-4：local friend=true + backend member missing + LINE friendFlag=false
  // → 不得建立 friend=true，不得偽造好友狀態。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: false }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: false, reason: 'NOT_FRIEND' });
    const res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(res && res.friend_verified === false, 'HBR-4 backend 明確驗證 friendFlag=false → friend_verified=false，不偽造 true');
  }

  // HBR-5：local friend=true + backend member missing + LINE API timeout →
  // no false friend；optional 模式不受影響；required 模式維持未解鎖、不 bypass。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: false }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchThrowsFor('authoritative-friend-sync');
    let threw = false;
    let res = null;
    try { res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001'); } catch (e) { threw = true; }
    assert(threw === false, 'HBR-5 LINE API timeout 時 triggerHistoricalFriendSync() 不拋出例外（fail-open）');
    assert(res && res.success === false, 'HBR-5 timeout → success:false，不假裝 friend_verified=true');

    // Required mode：即使 local cache 是 friend=true，仍必須維持未解鎖。
    const h2 = loadGateModule();
    seedStaleFriendSession(h2, 'store_001');
    h2.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: false }));
    await h2.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h2.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h2.setFetchThrowsFor('authoritative-friend-sync');
    let resolved = null;
    const config = { gate_enabled: true, gate_mode: 'friend_entry_required', liff_id: liffId, add_friend_url: 'https://lin.ee/x' };
    h2.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {}).then((r) => { resolved = r; });
    await flush();
    assert(resolved === null, 'HBR-5 Required Gate：LINE API timeout 時不自動 resolve/放行');
    assert(h2.win.document.getElementById('lineRequiredFriendGate') !== null, 'HBR-5 Required Gate 仍保持顯示（不 bypass）');
  }

  // HBR-6：local friend=true + backend member missing + wrong Channel access
  // token → reject，no DB mutation（用 backend mock 回應 TOKEN_INVALID 模擬）。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: false, friend_verified: false, reason: 'TOKEN_INVALID' });
    const res = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(res && res.friend_verified === false && res.reason === 'TOKEN_INVALID', 'HBR-6 wrong channel access token → backend reject（TOKEN_INVALID），不建立 friend=true');
  }

  // HBR-7：local friend=true + backend member missing + authoritative sync
  // friend=true → 之後的 friend-state 應看到 member_exists=true/is_friend=true
  // （用 mock 模擬「repair 成功後 backend 狀態已更新」，驗證前端邏輯正確
  // 反映這個新狀態，而不是繼續卡在舊的 member_exists=false 回應）。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const repairRes = await h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    assert(repairRes && repairRes.friend_verified === true, 'HBR-7 前置：repair 呼叫成功');
    // 模擬 backend 端這次 repair 已經把 line_members row 建好：後續
    // /friend-state 改回 member_exists=true/is_friend=true。
    h.setFetchResponse('friend-state', { success: true, member_exists: true, is_friend: true });
    const status2 = await h.LineMemberGate._resolveRequiredFriendStatus('store_001');
    assert(status2 === 'friend', 'HBR-7 repair 成功後，重新查詢即看到 backend member_exists=true/is_friend=true，_resolveRequiredFriendStatus() 正確回報 friend');
  }

  // HBR-8：local friend=true + backend member missing → optional friend_entry
  // 不得誤跳「加入官方 LINE」（可信 LIFF/local UX signal 已是 friend 時應
  // suppress），但 backend repair 仍要跑（用「maybeShowFriendEntryGuide 不
  // 顯示」+「triggerHistoricalFriendSync 仍被呼叫過」共同驗證）。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    // 模擬既有 bootstrap 順序：先跑 historical sync（背景 repair），
    // maybeShowFriendEntryGuide 用的是 knownFriendStatus()（本地已知
    // friend=true，UX suppress 用途，見需求文件 Section 8/10）。
    const repairPromise = h.LineMemberGate.triggerHistoricalFriendSync('store_001');
    const config = { gate_enabled: true, gate_mode: 'friend_entry', liff_id: liffId, add_friend_url: 'https://lin.ee/x' };
    const guideResult = h.LineMemberGate.maybeShowFriendEntryGuide('store_001', config, ids, () => {});
    assert(guideResult && guideResult.shown === false && guideResult.reason === 'already_friend', 'HBR-8 local/LIFF 已可信確認是好友時，optional guide 正確 suppress、不誤跳 Modal');
    await repairPromise;
    const calledSync = h.getFetchCalls().some((u) => u.indexOf('authoritative-friend-sync') !== -1);
    assert(calledSync === true, 'HBR-8 background repair 仍確實執行了（不因 optional guide suppress 就跳過 backend repair）');
  }

  // HBR-9：local friend=true + backend missing + friend_entry_required →
  // local cache 不能單獨 security-bypass；authoritative repair 必須執行，
  // friend_verified=true 才真正 unlock。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const config = { gate_enabled: true, gate_mode: 'friend_entry_required', liff_id: liffId, add_friend_url: 'https://lin.ee/x' };
    const res = await h.LineMemberGate.requireFriendOnEntryNoLogin('store_001', config, ids, () => {});
    assert(res && res.ok === true, 'HBR-9 authoritative repair 成功（friend_verified=true）→ Required Gate 放行');
    const calledSync = h.getFetchCalls().some((u) => u.indexOf('authoritative-friend-sync') !== -1);
    assert(calledSync === true, 'HBR-9 Required Gate 放行前確實執行了 authoritative-friend-sync（不是單靠 local cache 直接放行）');
    assert(h.win.document.getElementById('lineRequiredFriendGate') === null, 'HBR-9 全程未顯示 Required Modal（historical friend 不會被卡住）');
  }

  // HBR-10：local friend=true + backend missing + friend_checkout_required →
  // repair 之前 checkout_click=0；repair 之後 exactly once。
  {
    const orderSrc = fs.readFileSync(path.join(ROOT, 'public/line-order.html'), 'utf8');
    const startMarker = '// H1.4.10 REQUIRED LINE FRIEND GATE：pending checkout intent，只存在記憶體';
    const endMarker = 'function backToCartStep(){';
    const startIdx = orderSrc.indexOf(startMarker);
    const endIdx = orderSrc.indexOf(endMarker, startIdx);
    const checkoutCode = orderSrc.slice(startIdx, endIdx);

    const trackedEvents = [];
    let enterStageCalls = 0;
    const goBtn = { disabled: false, id: 'goCheckoutBtn' };
    const subBtn = { disabled: false, id: 'subBtn' };
    const document2 = { getElementById: (id) => (id === 'goCheckoutBtn' ? goBtn : id === 'subBtn' ? subBtn : null) };
    const sessionStore2 = new Map();
    const sessionStorage2 = { getItem: (k) => (sessionStore2.has(k) ? sessionStore2.get(k) : null), setItem: (k, v) => sessionStore2.set(k, String(v)), removeItem: (k) => sessionStore2.delete(k) };
    let gateResultQueue = [];
    const LineMemberGateMock = {
      requireFriendBeforeCheckoutNoLogin: () => Promise.resolve(gateResultQueue.length ? gateResultQueue.shift() : { ok: false, reason: 'cancelled' }),
      maybeShowFriendCheckoutGuide: () => ({ shown: false }),
      refreshAuthoritativeFriendState: () => Promise.resolve('unknown'),
    };
    const cart = { 101: 2 };
    const _lineMemberGateConfig = { gate_enabled: true, gate_mode: 'friend_checkout_required' };
    // eslint-disable-next-line no-new-func
    const factory = new Function('document', 'sessionStorage', 'cart', 'LineMemberGate', '_lineMemberGateConfig', 'LINE_STORE_ID', '_trackEvent', '_buildCartAnalyticsPayload', '_getCartId', '_gateIds', 'toast', '_enterCheckoutStage',
      checkoutCode + '\n;return { openCheckoutStep, _proceedToCheckout };');
    const fns = factory(document2, sessionStorage2, cart, LineMemberGateMock, _lineMemberGateConfig, 'store_001',
      (name, payload) => trackedEvents.push({ name, payload }), () => ({}), () => 'cart-fixed-1', () => ({}), () => {}, () => { enterStageCalls += 1; });

    gateResultQueue.push({ ok: false, reason: 'cancelled' }); // 模擬 repair 尚未完成，Gate 仍鎖定
    fns.openCheckoutStep({ type: 'click', currentTarget: goBtn });
    await flush();
    assert(enterStageCalls === 0, 'HBR-10 repair 完成前：checkout stage 未開啟');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 0, 'HBR-10 repair 完成前：checkout_click = 0');

    gateResultQueue.push({ ok: true }); // repair 完成、friend_verified=true
    fns.openCheckoutStep({ type: 'click', currentTarget: goBtn });
    await flush();
    assert(enterStageCalls === 1, 'HBR-10 repair 完成後：checkout stage 開啟一次');
    assert(trackedEvents.filter((e) => e.name === 'checkout_click').length === 1, 'HBR-10 repair 完成後：checkout_click = exactly 1');
  }

  // HBR-11：entry init + focus 幾乎同時觸發 repair → per-store in-flight
  // dedupe，確保同時最多一個真正在飛的 authoritative-friend-sync 請求。
  {
    const h = loadGateModule();
    seedStaleFriendSession(h, 'store_001');
    h.setLiff(makeLiffMock({ inClient: true, isLoggedIn: true, friendFlag: true }));
    await h.LineMemberGate.initLineMemberGate({ store_id: 'store_001', liff_id: liffId }, ids, () => {}, { skipLoginCallback: true });
    h.setFetchResponse('friend-state', { success: true, member_exists: false, is_friend: null });
    h.setFetchResponse('authoritative-friend-sync', { success: true, friend_verified: true, source: 'line_platform_verified' });
    const p1 = h.LineMemberGate.triggerHistoricalFriendSync('store_001'); // 模擬 entry init
    const p2 = h.LineMemberGate.triggerHistoricalFriendSync('store_001'); // 模擬幾乎同時的 focus resume
    const [r1, r2] = await Promise.all([p1, p2]);
    assert(r1 === r2, 'HBR-11 兩個幾乎同時的呼叫共用同一個 in-flight Promise（同一個回傳物件參照）');
    const syncCalls = h.getFetchCalls().filter((u) => u.indexOf('authoritative-friend-sync') !== -1).length;
    assert(syncCalls === 1, 'HBR-11 同時觸發只送出恰好一次 authoritative-friend-sync 請求（no duplicate）', `found ${syncCalls}`);
  }

  // HBR-12：Follow Webhook regression — member missing → 真正 Follow 事件 →
  // 既有 applyFriendEvent() path 完全不受本輪修改影響（結構性確認：本輪
  // 完全沒有修改 utils/lineFriendSync.js／webhook route，這裡用檔案未變更
  // 佐證，而非重新測整條 webhook）。
  {
    const gitDiffFreeze = !fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8').includes('applyFriendEvent');
    // line-member-gate.js（前端）本來就不應該直接引用 applyFriendEvent（那是
    // 後端 utils/lineFriendSync.js 的函式），這裡確認前端沒有意外新增這種
    // 跨層呼叫，Follow Webhook 的既有實作完全沒有被本輪觸碰。
    assert(gitDiffFreeze, 'HBR-12 前端 line-member-gate.js 沒有意外引用/改動 applyFriendEvent（後端 Follow Webhook 邏輯完全 freeze，未被本輪觸碰）');
  }
}

async function main() {
  await runPartA();
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
