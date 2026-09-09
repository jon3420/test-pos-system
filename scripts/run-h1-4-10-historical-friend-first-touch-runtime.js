#!/usr/bin/env node
// scripts/run-h1-4-10-historical-friend-first-touch-runtime.js
// H1.4.10 HISTORICAL-FRIEND-FIRST-TOUCH targeted tests (HIST-1..15).
//
// 做法：monkey-patch utils/lineMemberAuth 的三個對外呼叫（LINE Platform
// verifyLineAccessToken／getLineProfile／getFriendshipStatus），必須在
// require routes/line-member.js 之前完成（沿用 scripts/run-h1-4-10-phase1-*
// 既有手法）。其餘全部走真實 route（express + routes/line-member.js）與
// 真實暫存 sqlite DB（utils/db.js，POS_DB_PATH 隔離）。
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');

const ROOT = path.join(__dirname, '..');
const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}`, detail || ''); }
function assert(cond, name, detail) { if (cond) pass(name); else fail(name, detail); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-hist-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-hist';

  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  const TEST_CHANNEL_ID = '2010758481'; // 與需求文件的 TEST LINE Login Channel 一致

  // ── monkey-patch，必須在 require routes/line-member.js 之前完成 ──────
  const lineMemberAuth = require(path.join(ROOT, 'utils', 'lineMemberAuth.js'));

  let accessTokenVerifyBehavior = { ok: true, client_id: TEST_CHANNEL_ID, scopes: ['openid', 'profile'] };
  let profileBehavior = { ok: true, userId: 'Uhistorical0000000000000001', displayName: 'Historical Friend', pictureUrl: '' };
  let friendshipBehavior = { ok: true, is_friend: true };
  let friendshipCallCount = 0;
  let lastSeenAccessTokenArgs = [];

  lineMemberAuth.verifyLineAccessToken = async (accessToken, channelId) => {
    lastSeenAccessTokenArgs.push(accessToken);
    if (!accessTokenVerifyBehavior.ok) return { ok: false, reason: accessTokenVerifyBehavior.reason || 'verify_failed', code: accessTokenVerifyBehavior.code || 'INVALID_ACCESS_TOKEN' };
    if (String(channelId) !== String(accessTokenVerifyBehavior.client_id)) return { ok: false, reason: 'client_id_mismatch', code: 'CHANNEL_ID_MISMATCH' };
    return { ok: true, client_id: accessTokenVerifyBehavior.client_id, scopes: accessTokenVerifyBehavior.scopes };
  };
  lineMemberAuth.getLineProfile = async (accessToken) => {
    lastSeenAccessTokenArgs.push(accessToken);
    if (!profileBehavior.ok) return { ok: false, reason: 'profile_api_failed', code: 'LINE_PROFILE_API_FAILED' };
    return { ok: true, userId: profileBehavior.userId, displayName: profileBehavior.displayName, pictureUrl: profileBehavior.pictureUrl };
  };
  lineMemberAuth.getFriendshipStatus = async (accessToken) => {
    friendshipCallCount++;
    lastSeenAccessTokenArgs.push(accessToken);
    if (!friendshipBehavior.ok) return { ok: false, is_friend: null };
    return { ok: true, is_friend: friendshipBehavior.is_friend };
  };

  const { initDb, getDb } = require(path.join(ROOT, 'utils', 'db.js'));
  await initDb();
  const db = getDb();

  function setSetting(storeId, key, value) {
    db.run('DELETE FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    db.run('INSERT INTO settings (store_id, key, value) VALUES (?,?,?)', [storeId, key, value]);
  }
  const STORE_ID = 'store_001';
  setSetting(STORE_ID, 'line_member_login_channel_id', TEST_CHANNEL_ID);

  const express = require('express');
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.storeId = req.query.store_id || STORE_ID; next(); });
  app.use('/api/line-member', require(path.join(ROOT, 'routes', 'line-member.js')));

  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  async function sync(storeId, body) {
    const res = await fetch(`${base}/api/line-member/authoritative-friend-sync?store_id=${encodeURIComponent(storeId)}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  function memberRow(storeId, lineUserId) {
    return db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
  }
  function countMembers(storeId, lineUserId) {
    return db.all('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]).length;
  }
  function friendEvents(storeId, lineUserId) {
    return db.all('SELECT * FROM line_friend_events WHERE store_id=? AND line_user_id=? ORDER BY id', [storeId, lineUserId]);
  }

  try {
    // ══════════════════════════════════════════════════════════
    // HIST-1：無 member，token valid，profile UID authoritative，
    // friendFlag=true → member created, is_friend=true
    // ══════════════════════════════════════════════════════════
    {
      accessTokenVerifyBehavior = { ok: true, client_id: TEST_CHANNEL_ID, scopes: ['openid', 'profile'] };
      profileBehavior = { ok: true, userId: 'Uhist0001', displayName: 'Hist One', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-1' });
      assert(r.status === 200 && r.json.success === true && r.json.friend_verified === true,
        'HIST-1 friendFlag=true → friend_verified=true', JSON.stringify(r.json));
      const row = memberRow(STORE_ID, 'Uhist0001');
      assert(!!row && row.is_friend === 1, 'HIST-1 member created with is_friend=1', JSON.stringify(row));
    }

    // ══════════════════════════════════════════════════════════
    // HIST-2：無 member，friendFlag=false → 不建立 friend=true（也不建立任何 row）
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'Uhist0002', displayName: 'Hist Two', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: false };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-2' });
      assert(r.json.friend_verified === false, 'HIST-2 friendFlag=false → friend_verified=false', JSON.stringify(r.json));
      const row = memberRow(STORE_ID, 'Uhist0002');
      assert(!row || row.is_friend !== 1, 'HIST-2 不建立 friend=true', JSON.stringify(row));
    }

    // ══════════════════════════════════════════════════════════
    // HIST-3：已存在 member（friend unknown），friendFlag=true → 同一 row 更新，no duplicate
    // ══════════════════════════════════════════════════════════
    {
      const lineUserId = 'Uhist0003';
      db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, friend_status, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,?,?)`,
        [STORE_ID, lineUserId, 'Pre-existing', null, 'unknown', '2020-01-01 00:00:00', '2020-01-01 00:00:00']);
      const beforeId = memberRow(STORE_ID, lineUserId).id;
      profileBehavior = { ok: true, userId: lineUserId, displayName: 'Hist Three', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-3' });
      assert(r.json.friend_verified === true, 'HIST-3 friendFlag=true → friend_verified=true', JSON.stringify(r.json));
      const afterRow = memberRow(STORE_ID, lineUserId);
      assert(afterRow.is_friend === 1, 'HIST-3 is_friend updated to 1');
      assert(afterRow.id === beforeId, 'HIST-3 same row updated (id unchanged)');
      assert(countMembers(STORE_ID, lineUserId) === 1, 'HIST-3 no duplicate row created');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-4：已 friend=true → 不呼叫 LINE friendship API，unchanged
    // ══════════════════════════════════════════════════════════
    {
      const lineUserId = 'Uhist0004';
      db.run(`INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, friend_status, first_seen_at, last_seen_at)
              VALUES (?,?,?,?,?,?,?)`,
        [STORE_ID, lineUserId, 'Already Friend', 1, 'friend', '2020-01-01 00:00:00', '2020-01-01 00:00:00']);
      profileBehavior = { ok: true, userId: lineUserId, displayName: 'Hist Four', pictureUrl: '' };
      const callsBefore = friendshipCallCount;
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-4' });
      assert(r.json.success === true && r.json.friend_verified === true && r.json.source === 'backend_current',
        'HIST-4 backend already friend=true → source=backend_current', JSON.stringify(r.json));
      assert(friendshipCallCount === callsBefore, 'HIST-4 不呼叫 LINE Friendship API（call count 不變）');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-5：wrong LINE Login client_id → reject, no DB mutation
    // ══════════════════════════════════════════════════════════
    {
      accessTokenVerifyBehavior = { ok: true, client_id: '9999999999', scopes: ['openid', 'profile'] }; // 與 store 設定不符
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-5' });
      assert(r.status === 400 && r.json.success === false, 'HIST-5 wrong client_id → 400 reject', JSON.stringify(r.json));
      assert(!memberRow(STORE_ID, 'Uhist0005'), 'HIST-5 no DB mutation');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-6：token expired/invalid → no DB mutation, ordering unaffected
    // ══════════════════════════════════════════════════════════
    {
      accessTokenVerifyBehavior = { ok: false, reason: 'expired', code: 'EXPIRED_ACCESS_TOKEN' };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-6' });
      assert(r.status === 400 && r.json.success === false && r.json.friend_verified === false,
        'HIST-6 token expired/invalid → no mutation', JSON.stringify(r.json));
    }

    // ══════════════════════════════════════════════════════════
    // HIST-7：access token 缺 profile scope → no friend write
    // ══════════════════════════════════════════════════════════
    {
      accessTokenVerifyBehavior = { ok: true, client_id: TEST_CHANNEL_ID, scopes: ['openid'] };
      // verifyLineAccessToken mock 本身要能反映缺 scope（沿用真實實作邏輯：
      // 這裡直接模擬「scope 檢查後判定失敗」的行為，等同真實 verifyLineAccessToken()
      // 對 scope.includes('profile') 的判斷）。
      const originalMock = lineMemberAuth.verifyLineAccessToken;
      lineMemberAuth.verifyLineAccessToken = async (accessToken, channelId) => {
        if (String(channelId) !== TEST_CHANNEL_ID) return { ok: false, reason: 'client_id_mismatch', code: 'CHANNEL_ID_MISMATCH' };
        if (!accessTokenVerifyBehavior.scopes.includes('profile')) return { ok: false, reason: 'missing_profile_scope', code: 'MISSING_PROFILE_SCOPE' };
        return { ok: true, client_id: channelId, scopes: accessTokenVerifyBehavior.scopes };
      };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-7' });
      assert(r.status === 400 && r.json.success === false, 'HIST-7 missing profile scope → no friend write', JSON.stringify(r.json));
      lineMemberAuth.verifyLineAccessToken = originalMock;
      accessTokenVerifyBehavior = { ok: true, client_id: TEST_CHANNEL_ID, scopes: ['openid', 'profile'] };
    }

    // ══════════════════════════════════════════════════════════
    // HIST-8：frontend forged friend=true / line_user_id=xxx → backend ignores
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'Uhist0008real', displayName: 'Real User', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const r = await sync(STORE_ID, {
        userAccessToken: 'fake-token-hist-8',
        friend: true, line_user_id: 'Uforged0008fake', // 前端偽造欄位，contract 根本不接受
      });
      assert(r.json.friend_verified === true, 'HIST-8 sync 仍成功（用 authoritative UID）');
      assert(!memberRow(STORE_ID, 'Uforged0008fake'), 'HIST-8 forged line_user_id 未被使用');
      assert(!!memberRow(STORE_ID, 'Uhist0008real'), 'HIST-8 只用 authoritative UID 建立 member');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-9：LINE profile 回 UID A，「前端聲稱」UID B → 只有 authoritative UID A 生效
    // （與 HIST-8 同一機制：body 完全沒有被信任的 UID 欄位，profile API 回傳值
    //  是唯一權威來源，這裡用不同的偽造值再次驗證同一保證）
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'UhistA_authoritative', displayName: 'A', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-9', line_user_id: 'UhistB_claimed_by_frontend' });
      assert(r.json.friend_verified === true, 'HIST-9 sync 成功');
      assert(!!memberRow(STORE_ID, 'UhistA_authoritative'), 'HIST-9 使用 profile API 回傳的 UID A');
      assert(!memberRow(STORE_ID, 'UhistB_claimed_by_frontend'), 'HIST-9 前端聲稱的 UID B 未被建立');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-10：Friendship API timeout → fail-open, no order blocking, no false friend
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'Uhist0010', displayName: 'Timeout', pictureUrl: '' };
      friendshipBehavior = { ok: false, is_friend: null }; // 模擬 getFriendshipStatus() 對 timeout 的既有 fail-safe 回傳
      const r = await sync(STORE_ID, { userAccessToken: 'fake-token-hist-10' });
      assert(r.status === 200 && r.json.success === false && r.json.reason === 'LINE_API_UNAVAILABLE',
        'HIST-10 friendship API timeout → fail-open, reason=LINE_API_UNAVAILABLE', JSON.stringify(r.json));
      assert(!memberRow(STORE_ID, 'Uhist0010') || memberRow(STORE_ID, 'Uhist0010').is_friend !== 1,
        'HIST-10 no false friend written');
      friendshipBehavior = { ok: true, is_friend: true };
    }

    // ══════════════════════════════════════════════════════════
    // HIST-11：raw access token 不得存在於 DB／logs／response／analytics／Timeline
    // ══════════════════════════════════════════════════════════
    {
      const rawToken = 'RAW-SECRET-ACCESS-TOKEN-should-never-leak-0011';
      profileBehavior = { ok: true, userId: 'Uhist0011', displayName: 'Leak Check', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const r = await sync(STORE_ID, { userAccessToken: rawToken });
      const responseStr = JSON.stringify(r.json);
      assert(!responseStr.includes(rawToken), 'HIST-11 raw token 不在 response 內');
      const row = memberRow(STORE_ID, 'Uhist0011');
      const rowStr = JSON.stringify(row || {});
      assert(!rowStr.includes(rawToken), 'HIST-11 raw token 不在 DB member row 內');
      const events = friendEvents(STORE_ID, 'Uhist0011');
      const eventsStr = JSON.stringify(events);
      assert(!eventsStr.includes(rawToken), 'HIST-11 raw token 不在 line_friend_events metadata 內');
      // 原始碼層級掃描：確保 route 本身不會把 userAccessToken 塞進任何
      // console.log／logServerEvent／db 呼叫（靜態掃描，補強動態驗證）。
      const routeSrc = fs.readFileSync(path.join(ROOT, 'routes', 'line-member.js'), 'utf8');
      const syncBlock = routeSrc.slice(routeSrc.indexOf("router.post('/authoritative-friend-sync'"));
      const noTokenLogging = !/console\.(log|warn|error)\([^)]*userAccessToken/.test(syncBlock);
      assert(noTokenLogging, 'HIST-11 原始碼掃描：userAccessToken 未被傳入任何 console.* 呼叫');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-12：concurrent 2 sync requests → exactly one member, deterministic friend state
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'Uhist0012', displayName: 'Concurrent', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      const [r1, r2] = await Promise.all([
        sync(STORE_ID, { userAccessToken: 'fake-token-hist-12-a' }),
        sync(STORE_ID, { userAccessToken: 'fake-token-hist-12-b' }),
      ]);
      assert(r1.json.friend_verified === true && r2.json.friend_verified === true, 'HIST-12 兩個併發請求都成功');
      assert(countMembers(STORE_ID, 'Uhist0012') === 1, 'HIST-12 exactly one member row', countMembers(STORE_ID, 'Uhist0012'));
      const row = memberRow(STORE_ID, 'Uhist0012');
      assert(row.is_friend === 1, 'HIST-12 deterministic friend state (is_friend=1)');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-13：CRM event 為 historical_friend_first_touch，不得偽造 Follow Webhook
    // ══════════════════════════════════════════════════════════
    {
      profileBehavior = { ok: true, userId: 'Uhist0013', displayName: 'CRM Event Check', pictureUrl: '' };
      friendshipBehavior = { ok: true, is_friend: true };
      await sync(STORE_ID, { userAccessToken: 'fake-token-hist-13' });
      const events = friendEvents(STORE_ID, 'Uhist0013');
      assert(events.length >= 1, 'HIST-13 friend event 已寫入');
      const ev = events[0];
      assert(ev.source === 'historical_friend_first_touch', 'HIST-13 source=historical_friend_first_touch', JSON.stringify(ev));
      assert(ev.event_type !== 'follow' && ev.event_type !== 'unfollow', 'HIST-13 event_type 不是 follow/unfollow（未偽造 Webhook 事件）', ev.event_type);
      const historyRows = db.all(
        `SELECT * FROM line_member_history WHERE store_id=? AND line_user_id=? ORDER BY id`,
        [STORE_ID, 'Uhist0013']
      );
      const hasForgedFollowLabel = historyRows.some((h) => String(h.new_value || '').includes('加入好友') && h.event_name && h.event_name.startsWith('friend_friendship_verify'));
      assert(!hasForgedFollowLabel, 'HIST-13 Timeline 標籤未偽稱「加入好友」（使用「驗證為好友」而非 Follow 事件標籤）');
    }

    // ══════════════════════════════════════════════════════════
    // HIST-14：friend_since 不得偽造未知歷史加入日期
    // ══════════════════════════════════════════════════════════
    {
      const row = memberRow(STORE_ID, 'Uhist0001'); // 沿用 HIST-1 建立的 member
      assert(!row.friend_since || row.friend_since === '', 'HIST-14 friend_since 未被偽造（維持空值，不代表真正加入時間）', JSON.stringify(row.friend_since));
    }

    // ══════════════════════════════════════════════════════════
    // HIST-15：line-order 與 line-shipping 共用同一 authoritative sync endpoint/helper
    // ══════════════════════════════════════════════════════════
    {
      const gateSrc = fs.readFileSync(path.join(ROOT, 'public', 'js', 'line-member-gate.js'), 'utf8');
      // H1.4.10 BACKEND-RECONCILIATION：triggerHistoricalFriendSync() 現在是
      // 一個同步 wrapper function（做 per-store in-flight dedupe），真正的
      // async 邏輯移到 _triggerHistoricalFriendSyncInner()——外部呼叫端行為
      // 完全不變（一樣回傳可 await 的 Promise），這裡放寬成同時接受
      // `async function` 或一般 `function` 兩種宣告形式。
      const hasSharedFn = /(?:async )?function triggerHistoricalFriendSync/.test(gateSrc);
      const postsToEndpoint = /\/api\/line-member\/authoritative-friend-sync/.test(gateSrc);
      const orderHtml = fs.readFileSync(path.join(ROOT, 'public', 'line-order.html'), 'utf8');
      const shipHtml = fs.readFileSync(path.join(ROOT, 'public', 'line-shipping.html'), 'utf8');
      const orderCalls = /LineMemberGate\.triggerHistoricalFriendSync\(/.test(orderHtml);
      const shipCalls = /LineMemberGate\.triggerHistoricalFriendSync\(/.test(shipHtml);
      assert(hasSharedFn && postsToEndpoint, 'HIST-15 共用 helper 存在且指向同一 endpoint');
      assert(orderCalls && shipCalls, 'HIST-15 line-order.html 與 line-shipping.html 都呼叫同一 helper', `order=${orderCalls} ship=${shipCalls}`);
      // 不得各自另建一套 fetch('/api/line-member/authoritative-friend-sync'...) —
      // 只有 line-member-gate.js 內部這一處會直接呼叫該 URL。
      const orderHasOwnFetch = /fetch\(['"`]\/api\/line-member\/authoritative-friend-sync/.test(orderHtml);
      const shipHasOwnFetch = /fetch\(['"`]\/api\/line-member\/authoritative-friend-sync/.test(shipHtml);
      assert(!orderHasOwnFetch && !shipHasOwnFetch, 'HIST-15 兩頁都沒有另外直接 fetch 該 endpoint（只透過共用 helper）');
    }

  } catch (e) {
    fail('FATAL', e.stack || e.message);
  } finally {
    server.close();
    cleanup();
  }

  const total = results.length;
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = total - passed;
  console.log('\n== HISTORICAL-FRIEND-FIRST-TOUCH Summary ==');
  console.log(`TOTAL=${total} PASS=${passed} FAIL=${failed}`);
  if (failed > 0) process.exitCode = 1;
}

main().catch((e) => { console.error('[HIST runtime] fatal error:', e); process.exitCode = 1; });
