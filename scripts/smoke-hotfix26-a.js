#!/usr/bin/env node
// scripts/smoke-hotfix26-a.js — fix18-10-hotfix26-A smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-a.js
//
// 範圍（只涵蓋 Hotfix26-A：Backend／Database／CRM，不含前台 Gate／後台 UI／診斷中心）：
//   1. normalizeFriendFlag / friendStatusLabel / meetsRequirement 純函式單元測試
//   2. utils/lineMemberStats.upsertMemberProfile 好友狀態轉換規則（直接對 DB 操作，
//      不透過 HTTP，因為真正的 LINE ID Token 驗證需要呼叫 LINE 官方 API，
//      無法在 smoke test 內模擬）：
//        NULL→true／NULL→false／false→true／true→false／true→true（不重複）／
//        false→false（不重複）／null 不覆蓋已知狀態／last_friend_check 有更新／
//        多店隔離
//   3. Migration idempotency（server 啟動兩次）
//   4. GET /api/line-member/members?friend_status=... 與 GET /members/:id
//      （用測試用 staff JWT 呼叫，驗證三態篩選、require_friend／meets_requirement／
//      friend_status／last_friend_check_at 欄位）
//   5. POST /api/line-member/verify 的 malformed friend_flag／diagnostic_only
//      不得 500、不得洩漏 stack、不得建立假會員
//
// 不在此腳本自動化範圍內（標示 [MANUAL REQUIRED]）：
//   - 真正的 LIFF/LINE Login OAuth 往返、真實 liff.getFriendship() 呼叫

'use strict';
const path = require('path');
const { spawn } = require('child_process');
const jwt = require('jsonwebtoken');

const ROOT = path.join(__dirname, '..');
const PORT = 15000 + Math.floor(Math.random() * 5000);
const BASE = `http://127.0.0.1:${PORT}`;
const JWT_SECRET = process.env.JWT_SECRET || 'pos-saas-secret-2024';

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function staffToken(storeId) {
  return jwt.sign({ role: 'store', store_id: storeId, store_name: 'test' }, JWT_SECRET, { expiresIn: '1h' });
}

// ════════════════════════════════════════════════════════════════
// 1. 純函式單元測試
// ════════════════════════════════════════════════════════════════
function testHelperFunctions() {
  const router = require(path.join(ROOT, 'routes/line-member.js'));
  const helpers = router._test;
  if (!helpers) { fail('helpers exported for testing (router._test)', 'routes/line-member.js 未匯出 _test'); return; }
  const { normalizeFriendFlag, friendStatusLabel, meetsRequirement } = helpers;

  const nfCases = [
    [true, 1], [false, 0], [null, null], [undefined, null],
    ['true', null], ['false', null], [1, null], [0, null], [{}, null], ['', null],
  ];
  let ok = true; let detail = '';
  for (const [input, expected] of nfCases) {
    const got = normalizeFriendFlag(input);
    if (got !== expected) { ok = false; detail = `normalizeFriendFlag(${JSON.stringify(input)}) = ${got}, expected ${expected}`; break; }
  }
  if (ok) pass('normalizeFriendFlag: true/false/null/undefined/string/number/object 全部符合規則');
  else fail('normalizeFriendFlag: true/false/null/undefined/string/number/object 全部符合規則', detail);

  const labelCases = [[1, 'friend'], [0, 'non_friend'], [null, 'unknown'], [undefined, 'unknown'], [true, 'friend'], [false, 'non_friend']];
  ok = true; detail = '';
  for (const [input, expected] of labelCases) {
    const got = friendStatusLabel(input);
    if (got !== expected) { ok = false; detail = `friendStatusLabel(${input}) = ${got}, expected ${expected}`; break; }
  }
  if (ok) pass('friendStatusLabel: 1/0/null → friend/non_friend/unknown');
  else fail('friendStatusLabel: 1/0/null → friend/non_friend/unknown', detail);

  const meetsCases = [
    [false, 1, true], [false, 0, true], [false, null, true],
    [true, 1, true], [true, 0, false], [true, null, null],
  ];
  ok = true; detail = '';
  for (const [requireFriend, isFriend, expected] of meetsCases) {
    const got = meetsRequirement(requireFriend, isFriend);
    if (got !== expected) { ok = false; detail = `meetsRequirement(${requireFriend},${isFriend}) = ${got}, expected ${expected}`; break; }
  }
  if (ok) pass('meetsRequirement: require_friend=false 一律 true；require_friend=true 時 1/0/null → true/false/null（未知不誤判）');
  else fail('meetsRequirement: require_friend=false 一律 true；require_friend=true 時 1/0/null → true/false/null（未知不誤判）', detail);
}

// ════════════════════════════════════════════════════════════════
// 2. upsertMemberProfile 好友狀態轉換規則（直接對 DB，不經 HTTP）
// ════════════════════════════════════════════════════════════════
async function testUpsertMemberProfileTransitions() {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { upsertMemberProfile } = require(path.join(ROOT, 'utils/lineMemberStats'));
  await initDb();
  const db = getDb();

  const STORE = 'store_001';
  const STORE_B = 'store_hotfix26a_isolation_test';
  const uid = 'Utest_hotfix26a_' + Date.now();

  function cleanup() {
    try {
      db.run('DELETE FROM line_members WHERE line_user_id=?', [uid]);
      db.run('DELETE FROM line_member_history WHERE line_user_id=?', [uid]);
    } catch (e) {}
  }
  cleanup();

  try {
    // ── NULL → true（首次建立會員，一併是好友）─────────────────
    const r1 = upsertMemberProfile(db, STORE, { line_user_id: uid, display_name: 'Test A', is_friend: true, is_login: true });
    if (r1 && r1.created === true && r1.isFriend === true && r1.crmFriendEvent === 'friend_status_checked') {
      pass('upsertMemberProfile: NULL → true（新會員）寫入 friend_status_checked');
    } else {
      fail('upsertMemberProfile: NULL → true（新會員）寫入 friend_status_checked', JSON.stringify(r1));
    }
    let row = db.get('SELECT is_friend, last_friend_check FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    const firstCheckAt = row && row.last_friend_check;
    if (row && row.is_friend === 1 && firstCheckAt) {
      pass('upsertMemberProfile: is_friend=1 且 last_friend_check 有寫入');
    } else {
      fail('upsertMemberProfile: is_friend=1 且 last_friend_check 有寫入', JSON.stringify(row));
    }

    // ── true → true（重複登入，不得重複寫入好友事件）───────────
    const r2 = upsertMemberProfile(db, STORE, { line_user_id: uid, display_name: 'Test A', is_friend: true, is_login: true });
    if (r2 && r2.crmFriendEvent === null && r2.friendEvent === null) {
      pass('upsertMemberProfile: true → true 不重複寫入好友事件');
    } else {
      fail('upsertMemberProfile: true → true 不重複寫入好友事件', JSON.stringify(r2));
    }

    // ── true → false（取消好友 / unfollow）──────────────────────
    const r3 = upsertMemberProfile(db, STORE, { line_user_id: uid, is_friend: false, is_login: false });
    if (r3 && r3.crmFriendEvent === 'unfollowed_official_account' && r3.friendEvent === 'friend_removed') {
      pass('upsertMemberProfile: true → false 寫入 unfollowed_official_account');
    } else {
      fail('upsertMemberProfile: true → false 寫入 unfollowed_official_account', JSON.stringify(r3));
    }

    // ── false → false（不得重複寫入）────────────────────────────
    const r4 = upsertMemberProfile(db, STORE, { line_user_id: uid, is_friend: false, is_login: false });
    if (r4 && r4.crmFriendEvent === null) {
      pass('upsertMemberProfile: false → false 不重複寫入好友事件');
    } else {
      fail('upsertMemberProfile: false → false 不重複寫入好友事件', JSON.stringify(r4));
    }

    // ── null 不得覆蓋既有已知狀態（目前是 false，查詢失敗回 null）──
    const beforeNull = db.get('SELECT is_friend, last_friend_check FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    await sleep(1100); // 確保時間戳記若有更新會不同
    const r5 = upsertMemberProfile(db, STORE, { line_user_id: uid, is_friend: null, is_login: true });
    const afterNull = db.get('SELECT is_friend, last_friend_check FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    if (afterNull.is_friend === beforeNull.is_friend && r5 && r5.crmFriendEvent === null) {
      pass('upsertMemberProfile: friend_flag=null 不覆蓋既有已知好友狀態');
    } else {
      fail('upsertMemberProfile: friend_flag=null 不覆蓋既有已知好友狀態', `before=${JSON.stringify(beforeNull)} after=${JSON.stringify(afterNull)}`);
    }
    if (afterNull.last_friend_check === beforeNull.last_friend_check) {
      pass('upsertMemberProfile: friend_flag=null 時不更新 last_friend_check（沿用現有欄位語意，只在成功查到時更新）');
    } else {
      fail('upsertMemberProfile: friend_flag=null 時不更新 last_friend_check', `before=${beforeNull.last_friend_check} after=${afterNull.last_friend_check}`);
    }

    // ── false → true（重新加入 / rejoin）────────────────────────
    const r6 = upsertMemberProfile(db, STORE, { line_user_id: uid, is_friend: true, is_login: true });
    if (r6 && r6.crmFriendEvent === 'joined_official_account' && r6.friendEvent === 'friend_restored') {
      pass('upsertMemberProfile: false → true 寫入 joined_official_account（friend_restored 相容既有 Dashboard）');
    } else {
      fail('upsertMemberProfile: false → true 寫入 joined_official_account', JSON.stringify(r6));
    }

    // ── last_friend_check 在成功查到狀態時確實更新 ───────────────
    const afterRejoin = db.get('SELECT last_friend_check FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    if (afterRejoin.last_friend_check && afterRejoin.last_friend_check !== beforeNull.last_friend_check) {
      pass('upsertMemberProfile: 成功查到好友狀態時，last_friend_check 有更新');
    } else {
      fail('upsertMemberProfile: 成功查到好友狀態時，last_friend_check 有更新', `before=${beforeNull.last_friend_check} after=${afterRejoin.last_friend_check}`);
    }

    // ── 舊事件命名仍然存在（Dashboard 相容）─────────────────────
    const history = db.all('SELECT event_name FROM line_member_history WHERE store_id=? AND line_user_id=? ORDER BY id ASC', [STORE, uid]);
    const names = history.map(h => h.event_name);
    const hasLegacy = names.includes('friend_added') && names.includes('friend_removed') && names.includes('friend_restored');
    const hasNew = names.includes('friend_status_checked') && names.includes('unfollowed_official_account') && names.includes('joined_official_account');
    if (hasLegacy && hasNew) {
      pass('CRM Timeline: 舊事件（friend_added/friend_removed/friend_restored）與新事件（friend_status_checked/joined_official_account/unfollowed_official_account）並存，不破壞 Dashboard 漏斗查詢');
    } else {
      fail('CRM Timeline: 新舊事件並存', `names=${names.join(',')}`);
    }

    // ── 多店隔離：同一個 line_user_id，不同 store_id 各自獨立狀態 ──
    upsertMemberProfile(db, STORE_B, { line_user_id: uid, is_friend: false, is_login: true });
    const rowA = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    const rowB = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', [STORE_B, uid]);
    if (rowA && rowB && rowA.is_friend === 1 && rowB.is_friend === 0) {
      pass('upsertMemberProfile: 多店隔離，同一 line_user_id 在不同 store_id 狀態互不影響');
    } else {
      fail('upsertMemberProfile: 多店隔離', `storeA=${JSON.stringify(rowA)} storeB=${JSON.stringify(rowB)}`);
    }
  } finally {
    cleanup();
    try { db.run('DELETE FROM line_member_history WHERE store_id=?', [STORE_B]); db.run('DELETE FROM line_members WHERE store_id=?', [STORE_B]); } catch (e) {}
  }
}

// ════════════════════════════════════════════════════════════════
// 3. Server 啟動兩次（migration idempotency）
// ════════════════════════════════════════════════════════════════
function startServer(extraEnv) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://pop-system-v13.zeabur.app', ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server start timeout, log:\n' + out)); } }, 15000);
    child.stdout.on('data', (d) => {
      out += d.toString();
      if (!settled && /POS SaaS Foundation R1/.test(out)) { settled = true; clearTimeout(timer); resolve(child); }
    });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('exit', (code) => { if (!settled) { settled = true; clearTimeout(timer); reject(new Error(`server exited early (code ${code}), log:\n${out}`)); } });
  });
}
function stopServer(child) {
  return new Promise((resolve) => {
    if (!child || child.killed) return resolve();
    child.once('exit', () => resolve());
    child.kill('SIGTERM');
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (e) {} resolve(); }, 3000);
  });
}

async function testServerBootTwice() {
  let child;
  try { child = await startServer(); pass('server boot (1st run)'); } catch (e) { fail('server boot (1st run)', e.message.split('\n')[0]); return null; }
  await stopServer(child);
  try { child = await startServer(); pass('migration idempotency (2nd boot, no errors)'); } catch (e) { fail('migration idempotency (2nd boot)', e.message.split('\n')[0]); return null; }
  return child;
}

async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { __raw: text }; }
  return { status: res.status, body, raw: text };
}

async function seedFriendStatusFilterMembers() {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { upsertMemberProfile } = require(path.join(ROOT, 'utils/lineMemberStats'));
  await initDb();
  const db = getDb();
  const STORE = 'store_001';
  const marker = 'Hotfix26AFilterTest_' + Date.now();
  const uidFriend = 'Ufriend_' + Date.now();
  const uidNonFriend = 'Unonfriend_' + Date.now();
  const uidUnknown = 'Uunknown_' + Date.now();
  [uidFriend, uidNonFriend, uidUnknown].forEach(uid => {
    try {
      db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]);
      db.run('DELETE FROM line_member_history WHERE store_id=? AND line_user_id=?', [STORE, uid]);
    } catch (e) {}
  });
  upsertMemberProfile(db, STORE, { line_user_id: uidFriend, display_name: marker, is_friend: true, is_login: true });
  upsertMemberProfile(db, STORE, { line_user_id: uidNonFriend, display_name: marker, is_friend: false, is_login: true });
  upsertMemberProfile(db, STORE, { line_user_id: uidUnknown, display_name: marker, is_friend: null, is_login: true });
  return { STORE, marker, uids: [uidFriend, uidNonFriend, uidUnknown] };
}

function cleanupFriendStatusFilterMembers(seed) {
  const { getDb } = require(path.join(ROOT, 'utils/db'));
  const db = getDb();
  seed.uids.forEach(uid => {
    try {
      db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', [seed.STORE, uid]);
      db.run('DELETE FROM line_member_history WHERE store_id=? AND line_user_id=?', [seed.STORE, uid]);
    } catch (e) {}
  });
}

// ════════════════════════════════════════════════════════════════
// 4. GET /api/line-member/members?friend_status=... 與 /members/:id
// fix18-10-hotfix26-A：測試資料必須在 server 啟動「之前」寫入並存檔——
// server（子行程）在啟動當下把整個 sql.js DB 讀進自己的記憶體，之後父行程
// 這裡另開的 getDb() 寫入不會反映到已經在跑的 server 行程裡，所以呼叫端
// 必須先呼叫 seedFriendStatusFilterMembers() 產生種子資料，等 server 啟動
// 完成後才發送 HTTP 請求。
// ════════════════════════════════════════════════════════════════
async function testMembersFriendStatusFilterAndDetail(seed) {
  const { STORE, marker } = seed;
  const token = staffToken(STORE);
  const authHeader = { Authorization: `Bearer ${token}` };

  try {
    const cases = [
      ['friend', 1], ['non_friend', 1], ['unknown', 1], ['all', 3],
    ];
    let ok = true; let detail = '';
    for (const [fs, expectedCount] of cases) {
      const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(marker)}&friend_status=${fs}`, { headers: authHeader });
      const count = body && body.success ? body.data.length : -1;
      if (status !== 200 || count !== expectedCount) { ok = false; detail = `friend_status=${fs} status=${status} count=${count} expected=${expectedCount}`; break; }
    }
    if (ok) pass('GET /members?friend_status=friend/non_friend/unknown/all 篩選正確且可與 q 搜尋共用');
    else fail('GET /members?friend_status=friend/non_friend/unknown/all 篩選正確且可與 q 搜尋共用', detail);
  } catch (e) { fail('GET /members?friend_status=...', e.message); }

  try {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(marker)}&friend_status=friend`, { headers: authHeader });
    const row = body && body.data && body.data[0];
    if (status === 200 && row && row.friend_status === 'friend' && row.is_friend === 1) {
      pass('GET /members 回應含 friend_status 欄位');
    } else {
      fail('GET /members 回應含 friend_status 欄位', JSON.stringify(row));
    }

    if (row) {
      const detailRes = await jsonFetch(`${BASE}/api/line-member/members/${row.line_user_id_ref}`, { headers: authHeader });
      const d = detailRes.body && detailRes.body.data;
      const hasFields = d && ('require_friend' in d) && ('meets_requirement' in d) && ('friend_status' in d) && ('last_friend_check_at' in d);
      if (detailRes.status === 200 && hasFields) {
        pass('GET /members/:id 回應含 require_friend／meets_requirement／friend_status／last_friend_check_at');
      } else {
        fail('GET /members/:id 回應含 require_friend／meets_requirement／friend_status／last_friend_check_at', JSON.stringify(d));
      }
    }
  } catch (e) { fail('GET /members/:id 欄位檢查', e.message); }

  // 未帶 JWT 應被拒絕
  try {
    const { status } = await jsonFetch(`${BASE}/api/line-member/members?friend_status=all`);
    if (status === 401) pass('GET /members 未帶 JWT 回 401');
    else fail('GET /members 未帶 JWT 回 401', `status=${status}`);
  } catch (e) { fail('GET /members 未帶 JWT 回 401', e.message); }
}

// ════════════════════════════════════════════════════════════════
// 5. verify 端點：malformed friend_flag / diagnostic_only 不得 500 / 不洩漏 stack
// ════════════════════════════════════════════════════════════════
async function testVerifyFriendFlagAndDiagnostic() {
  const cases = [
    { name: 'verify: friend_flag string "true" 不視為有效布林值（後端會 normalize 成 null，仍不建立會員）', body: { id_token: 'not.a.valid.jwt', friend_flag: 'true' } },
    { name: 'verify: friend_flag number 1 不視為有效布林值', body: { id_token: 'not.a.valid.jwt', friend_flag: 1 } },
    { name: 'verify: friend_flag object {} 不視為有效布林值', body: { id_token: 'not.a.valid.jwt', friend_flag: {} } },
    { name: 'verify: diagnostic_only=true 但 token 無效，仍安全回應不建立會員', body: { id_token: 'not.a.valid.jwt', diagnostic_only: true } },
  ];
  for (const c of cases) {
    try {
      const { status, body, raw } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.body),
      });
      const hasStack = /at\s+\S+\s+\(.*:\d+:\d+\)/.test(raw) || /\.js:\d+:\d+/.test(raw);
      const noCrash = status < 500;
      const createdFakeMember = body && body.success === true && !body.diagnostic_only;
      if (noCrash && !hasStack && !createdFakeMember) pass(c.name);
      else fail(c.name, `status=${status} hasStack=${hasStack} body=${JSON.stringify(body).slice(0, 200)}`);
    } catch (e) { fail(c.name, e.message); }
  }
}

async function main() {
  console.log(`\n== Hotfix26-A smoke test (port ${PORT}) ==\n`);

  console.log('-- Section 1: helper unit tests --');
  testHelperFunctions();

  console.log('\n-- Section 2: upsertMemberProfile transition tests --');
  try { await testUpsertMemberProfileTransitions(); } catch (e) { fail('testUpsertMemberProfileTransitions crashed', e.stack); }

  // fix18-10-hotfix26-A：種子資料必須在 server 啟動前寫入並存檔（見
  // testMembersFriendStatusFilterAndDetail 上方註解）。
  let filterSeed = null;
  try { filterSeed = await seedFriendStatusFilterMembers(); } catch (e) { fail('seedFriendStatusFilterMembers crashed', e.stack); }

  console.log('\n-- Section 3: server boot / migration idempotency --');
  const child = await testServerBootTwice();
  if (child) {
    await sleep(300);
    console.log('\n-- Section 4: members list/detail friend_status filter --');
    if (filterSeed) {
      try { await testMembersFriendStatusFilterAndDetail(filterSeed); } catch (e) { fail('testMembersFriendStatusFilterAndDetail crashed', e.stack); }
    } else {
      fail('testMembersFriendStatusFilterAndDetail', 'seed data was not created, skipped');
    }

    console.log('\n-- Section 5: verify endpoint malformed friend_flag / diagnostic_only --');
    try { await testVerifyFriendFlagAndDiagnostic(); } catch (e) { fail('testVerifyFriendFlagAndDiagnostic crashed', e.stack); }

    await stopServer(child);
  }
  if (filterSeed) { try { cleanupFriendStatusFilterMembers(filterSeed); } catch (e) {} }

  manual('真實 LIFF liff.getFriendship() 回傳值與 verify API 的端到端整合', '需要真實 LINE App / LIFF 環境的 ID Token，無法在 smoke test 內模擬 LINE 官方 API 回應');

  console.log('\n== 結果 ==');
  const passCount = results.filter(r => r.status === 'PASS').length;
  const failCount = results.filter(r => r.status === 'FAIL').length;
  const manualCount = results.filter(r => r.status === 'MANUAL REQUIRED').length;
  console.log(`PASS=${passCount} FAIL=${failCount} MANUAL REQUIRED=${manualCount}`);
  if (failCount > 0) {
    console.log('\n失敗項目：');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(` - ${r.name}: ${r.detail || ''}`));
    process.exitCode = 1;
  }
}

main().catch(e => { console.error('smoke test crashed:', e); process.exitCode = 1; });
