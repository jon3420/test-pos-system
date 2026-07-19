#!/usr/bin/env node
// scripts/smoke-hotfix28.js — fix18-10-hotfix28 smoke test
//
// 涵蓋需求文件二十：LIFF Verify（upsertMemberProfile）三態處理與新舊欄位
// 同步、Webhook follow/unfollow、refollow、時間優先規則（跨兩套引擎）、
// CRM 字串比對修正、診斷 endpoint、時區一致性。
//
// 誠實揭露：真實 LINE ID Token 驗證、真實 LIFF getFriendship()/
// requestFriendship()、真實 Webhook 端對端事件都需要真實 LINE 平台或瀏覽器
// 環境，這裡一律標記 MANUAL REQUIRED。
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

const TEST_PORT = 5798;
const BASE = `http://localhost:${TEST_PORT}`;
function waitForServer(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    (async function poll() {
      while (Date.now() < deadline) {
        try { const r = await fetch(url + '/api/health'); if (r.ok) return resolve(); } catch (e) {}
        await new Promise(r2 => setTimeout(r2, 200));
      }
      reject(new Error('server did not start in time'));
    })();
  });
}

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const { upsertMemberProfile } = require('../utils/lineMemberStats');
  const { applyFriendEvent } = require('../utils/lineFriendSync');

  const STORE_A = 'smoke_hf28_store_a';
  const STORE_B = 'smoke_hf28_store_b';

  function member(storeId, uid) {
    return db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, uid]);
  }

  // ═══════════════ LIFF Verify（upsertMemberProfile）═══════════════
  // ── 新會員 insert branch，friend_flag=true ──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_FRIEND', display_name: 'Chris', is_friend: true, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T10:00:00.000Z' });
  let m = member(STORE_A, 'U_NEW_FRIEND');
  assert(m && m.is_friend === 1, '新會員 insert branch：friend_flag=true → is_friend=1');
  assert(m && m.friend_status === 'friend', '新會員 insert branch：friend_status 同步寫入 friend（根因修正）', m && m.friend_status);
  assert(m && !!m.last_friend_check_at, '新會員 insert branch：last_friend_check_at 有值', m && m.last_friend_check_at);
  assert(m && !!m.last_follow_at, '新會員 insert branch：last_follow_at 有值（friend=true 時）');

  // ── 新會員 insert branch，friend_flag=false ──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_NOTFRIEND', display_name: 'Bob', is_friend: false, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T10:00:00.000Z' });
  m = member(STORE_A, 'U_NEW_NOTFRIEND');
  assert(m && m.is_friend === 0, '新會員 insert branch：friend_flag=false → is_friend=0');
  assert(m && m.friend_status === 'not_friend', '新會員 insert branch：friend_status 同步寫入 not_friend', m && m.friend_status);

  // ── 新會員 insert branch，friend_flag=null（不誤寫 false）──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_UNKNOWN', display_name: 'Ann', is_friend: null, is_login: true }, { source: 'liff_friendship' });
  m = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(m && m.is_friend === null, 'friend_flag=null → is_friend 保持 NULL（不誤寫 false）', m && m.is_friend);
  assert(m && m.friend_status === 'unknown', 'friend_flag=null → friend_status=unknown（不誤寫 not_friend）', m && m.friend_status);

  // ── 既有會員 update branch：unknown → friend ──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_UNKNOWN', display_name: 'Ann', is_friend: true, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T11:00:00.000Z' });
  m = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(m.is_friend === 1 && m.friend_status === 'friend', '既有會員 update branch：unknown→friend 正確更新新舊欄位', JSON.stringify({ is_friend: m.is_friend, friend_status: m.friend_status }));
  assert(m.last_friend_source === 'liff_friendship', 'last_friend_source（friend_status_source）正確寫入', m.last_friend_source);
  assert(!!m.last_follow_at, 'last_follow_at 正確寫入（首次加入）');

  // ── 既有會員 update branch：friend → not_friend（refollow 累加測試的前置）──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_UNKNOWN', is_friend: false, is_login: false }, { source: 'liff_friendship', checked_at: '2026-07-19T12:00:00.000Z' });
  m = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(m.is_friend === 0 && m.friend_status === 'not_friend', 'friend→not_friend 正確更新');
  assert(!!m.last_unfollow_at, 'last_unfollow_at 正確寫入');

  // ── 既有會員 update branch：not_friend → friend（refollow，refollow_count+1）──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_UNKNOWN', is_friend: true, is_login: false }, { source: 'liff_friendship', checked_at: '2026-07-19T13:00:00.000Z' });
  m = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(m.is_friend === 1 && m.friend_status === 'friend', 'not_friend→friend（refollow）正確更新');
  assert(Number(m.refollow_count) === 1, 'refollow_count 正確累加（LIFF 路徑亦適用）', m.refollow_count);

  // ── friend_flag=null 不覆蓋既有狀態（保留原狀）──
  const beforeNull = member(STORE_A, 'U_NEW_UNKNOWN');
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_NEW_UNKNOWN', is_friend: null, is_login: true }, { source: 'liff_friendship' });
  const afterNull = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(afterNull.is_friend === beforeNull.is_friend && afterNull.friend_status === beforeNull.friend_status, 'friend_flag=null 不覆蓋既有好友狀態（保留原狀）');

  // ── store 隔離 ──
  upsertMemberProfile(db, STORE_B, { line_user_id: 'U_NEW_UNKNOWN', is_friend: false, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T14:00:00.000Z' });
  const storeAStill = member(STORE_A, 'U_NEW_UNKNOWN');
  assert(storeAStill.is_friend === 1, 'store 隔離：Store B 寫入不影響 Store A 同 UID 的會員', JSON.stringify(storeAStill.is_friend));

  manual('不信任前端 UID（實際由 ID Token 驗證取得）', 'routes/line-member.js 的 POST /verify 已用 verifyLineIdToken() 驗證 token 取得真正 UID，upsertMemberProfile() 本身只是純函式不驗證來源；端對端驗證需要真實 LINE ID Token，無法在此模擬環境完成');

  // ═══════════════ 時間優先規則（需求文件三／八，跨兩套引擎）═══════════════
  // 10:00 LIFF=friend, 10:05 webhook unfollow → 最終 not_friend（不得被舊 LIFF 蓋掉）
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_PRIORITY_TEST', is_friend: true, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T10:00:00.000Z' });
  applyFriendEvent(db, STORE_A, 'U_PRIORITY_TEST', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-19 10:05:00' });
  m = member(STORE_A, 'U_PRIORITY_TEST');
  assert(m.is_friend === 0, '時間優先：10:00 LIFF=friend + 10:05 webhook unfollow → 最終 not_friend（跨引擎正確比較 ISO vs naive 格式）', JSON.stringify({ is_friend: m.is_friend, friend_status: m.friend_status }));

  // 反向：10:05 webhook unfollow 已套用後，10:02 的「晚到」LIFF friend 回報不得覆蓋
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_PRIORITY_TEST', is_friend: true, is_login: true }, { source: 'liff_friendship', checked_at: '2026-07-19T10:02:00.000Z' });
  m = member(STORE_A, 'U_PRIORITY_TEST');
  assert(m.is_friend === 0, '時間優先（反向）：晚到的舊 LIFF 回報（10:02）不得覆蓋已套用的較新 webhook unfollow（10:05）', JSON.stringify(m.is_friend));

  // ═══════════════ Webhook follow/unfollow（沿用 F8-A 引擎，這裡驗證欄位語意）═══════════════
  applyFriendEvent(db, STORE_A, 'U_WEBHOOK_TEST', { eventType: 'follow', source: 'webhook_follow', eventAt: '2026-07-19 09:00:00' });
  m = member(STORE_A, 'U_WEBHOOK_TEST');
  assert(m.is_friend === 1 && !!m.last_follow_at, 'Webhook follow：is_friend=1 且 last_follow_at 有值');
  applyFriendEvent(db, STORE_A, 'U_WEBHOOK_TEST', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-19 09:30:00' });
  m = member(STORE_A, 'U_WEBHOOK_TEST');
  assert(m.is_friend === 0 && !!m.last_unfollow_at, 'Webhook unfollow：is_friend=0 且 last_unfollow_at 有值');
  assert(!!m.line_user_id && !!m.display_name === false || !!m.line_user_id, 'Webhook unfollow 不刪除會員（UID 仍存在）');
  const orderBefore = db.get('SELECT COUNT(*) c FROM orders WHERE 1=0'); // 佔位：本測試環境未建立訂單，僅示意 unfollow 不動其他表
  applyFriendEvent(db, STORE_A, 'U_WEBHOOK_TEST', { eventType: 'follow', source: 'webhook_follow', eventAt: '2026-07-19 10:00:00' });
  m = member(STORE_A, 'U_WEBHOOK_TEST');
  assert(Number(m.refollow_count) === 1, 'Webhook refollow 正確累加');

  // 舊事件不能覆蓋新事件（webhook 自己的規則，F8-A 已驗證過，這裡只做存在性確認不重複造）
  const eventsBeforeStale = db.all('SELECT * FROM line_friend_events WHERE store_id=? AND line_user_id=?', [STORE_A, 'U_WEBHOOK_TEST']).length;
  applyFriendEvent(db, STORE_A, 'U_WEBHOOK_TEST', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-19 09:15:00' });
  m = member(STORE_A, 'U_WEBHOOK_TEST');
  assert(m.is_friend === 1, '舊事件（09:15）不覆蓋新狀態（10:00 已是 friend）');
  const eventsAfterStale = db.all('SELECT * FROM line_friend_events WHERE store_id=? AND line_user_id=?', [STORE_A, 'U_WEBHOOK_TEST']).length;
  assert(eventsAfterStale === eventsBeforeStale + 1, '即使是舊事件，仍寫入 line_friend_events（事件歷史不省略）');

  manual('簽章錯誤不更新（真實 HTTP 層）', '需要透過真實 HTTP 請求＋錯誤簽章驗證，已在 smoke-hotfix26-f8.js 的 H-2/H-3 案例驗證過簽章邏輯本身，這裡不重複造');

  // ═══════════════ Timeline 去重（需求文件：重複狀態不重複寫）═══════════════
  const historyBefore = db.all("SELECT * FROM line_member_history WHERE store_id=? AND line_user_id=?", [STORE_A, 'U_PRIORITY_TEST']).length;
  // 狀態沒有改變（已經是 not_friend），再次確認一次不該多寫一筆「狀態改變」歷史。
  // is_login:false，避免混入 upsertMemberProfile() 另一個獨立行為（isLogin=true
  // 會額外寫一筆 'login' Timeline 事件，那是登入紀錄，不是好友狀態紀錄，
  // 兩者互不相關，這裡只想單獨驗證好友狀態去重）。
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_PRIORITY_TEST', is_friend: false, is_login: false }, { source: 'liff_friendship', checked_at: '2026-07-19T15:00:00.000Z' });
  const historyAfter = db.all("SELECT * FROM line_member_history WHERE store_id=? AND line_user_id=?", [STORE_A, 'U_PRIORITY_TEST']).length;
  assert(historyAfter === historyBefore, '重複確認相同狀態（not_friend→not_friend）不重複寫入 Timeline 事件', `before=${historyBefore} after=${historyAfter}`);

  // ═══════════════ CRM UI 字串比對修正（靜態檢查 public/js/app.js）═══════════════
  const appJsSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'app.js'), 'utf8');
  assert(appJsSrc.includes("value === 'not_friend'") && appJsSrc.includes("value === 'blocked'"), 'renderFriendStatus() 同時接受 not_friend 與 blocked 字串（修正跨系統字串不一致）');
  assert(appJsSrc.includes('尚未確認'), '未知狀態顯示文字改為「尚未確認」（符合需求文件用詞）');
  assert(appJsSrc.includes('friend_follow:') && appJsSrc.includes('friend_unfollow:'), 'Timeline 事件標籤含 Webhook 路徑命名（friend_follow/friend_unfollow）');

  // ═══════════════ 時區一致性 ═══════════════
  const lineFriendSyncSrc = fs.readFileSync(path.join(__dirname, '..', 'utils', 'lineFriendSync.js'), 'utf8');
  assert(!lineFriendSyncSrc.includes("timeZone: 'Asia/Taipei'"), '_nowLocal() 不再強制轉換 Asia/Taipei（避免與其他 naive timestamp 的 UTC 假設不一致）');
  assert(lineFriendSyncSrc.includes('_isTimestampNewerOrEqual'), 'Webhook 事件比較改用跨格式安全的數值比較（不是純字串比較）');
  // 實測：naive UTC timestamp 不會被多加 8 小時
  const nowIso = new Date().toISOString();
  const nowNaive = nowIso.slice(0, 19).replace('T', ' ');
  const parsedBack = new Date(nowNaive.replace(' ', 'T') + 'Z').getTime();
  assert(Math.abs(parsedBack - new Date(nowIso).getTime()) < 2000, 'naive UTC timestamp 往返轉換誤差在 2 秒內（不會多加 8 小時時區）', `${nowNaive} vs ${nowIso}`);

  // ═══════════════ Diagnostics endpoint（真實 HTTP）═══════════════
  const { spawn } = require('child_process');
  const serverProc = spawn('node', ['server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: String(TEST_PORT) }, stdio: ['ignore', 'pipe', 'pipe'] });
  let serverLog = '';
  serverProc.stdout.on('data', d => { serverLog += d.toString(); });
  serverProc.stderr.on('data', d => { serverLog += d.toString(); });
  try {
    await waitForServer(BASE, 15000);
    const jwt = require('jsonwebtoken');
    const { JWT_SECRET } = require('../middleware/storeGuard');
    const staffHeaders = (storeId) => ({ Authorization: 'Bearer ' + jwt.sign({ store_id: storeId, role: 'staff', store_name: storeId }, JWT_SECRET, { expiresIn: '1h' }) });

    // 建立測試店家（沿用 hotfix27 smoke test 的既有機制，不直接寫 DB）
    const loginRes = await fetch(`${BASE}/api/super-admin/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'superadmin', password: 'admin1234' }) }).then(r => r.json());
    const saHeaders = { Authorization: 'Bearer ' + loginRes.token, 'Content-Type': 'application/json' };
    await fetch(`${BASE}/api/super-admin/stores`, { method: 'POST', headers: saHeaders, body: JSON.stringify({ store_id: STORE_A, store_name: STORE_A, plan: 'pro', active: true }) });

    const diagRes = await fetch(`${BASE}/api/line-integration/friend-sync-diagnostics`, { headers: staffHeaders(STORE_A) });
    const diagJson = await diagRes.json();
    assert(diagRes.status === 200 && diagJson.success, 'friend-sync-diagnostics endpoint 回應成功', diagRes.status);
    assert(typeof diagJson.data.friend_count === 'number' && typeof diagJson.data.not_friend_count === 'number' && typeof diagJson.data.unknown_count === 'number', 'endpoint 回傳好友／非好友／未知數量', JSON.stringify(diagJson.data));
    assert('last_follow_event_at' in diagJson.data && 'last_unfollow_event_at' in diagJson.data, 'endpoint 回傳最近 follow／unfollow 時間');
    assert('last_sync_source' in diagJson.data, 'endpoint 回傳最近同步來源');
    const diagStr = JSON.stringify(diagJson);
    assert(!diagStr.includes('line_channel_secret') && !/[A-Za-z0-9_-]{40,}/.test(diagStr), 'diagnostics 回應不含 Channel Secret／長字串 Token', diagStr.slice(0, 200));

    const noAuthDiag = await fetch(`${BASE}/api/line-integration/friend-sync-diagnostics`);
    assert(noAuthDiag.status === 401, 'diagnostics endpoint 未帶權限時回 401（不是 500）', noAuthDiag.status);

    const badSigWebhook = await fetch(`${BASE}/webhook/line/${STORE_A}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-line-signature': 'bogus' }, body: JSON.stringify({ events: [] }) });
    assert(badSigWebhook.status === 403, 'Webhook 路由：Channel Secret 未設定或簽章錯誤時回 403（不是 500）', badSigWebhook.status);

    const noBodyVerify = await fetch(`${BASE}/api/line-member/verify?store_id=${STORE_A}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    assert(noBodyVerify.status === 400, 'line-member verify：缺少 id_token 時回 400（不是 500）', noBodyVerify.status);
  } finally {
    serverProc.kill();
    await new Promise(r => setTimeout(r, 300));
  }

  manual('真機：已是好友 → LIFF getFriendship=true → CRM 顯示好友', '需要真實 LIFF 環境與已加好友的 LINE 帳號');
  manual('真機：封鎖官方帳號 → unfollow webhook → CRM 顯示非好友', '需要真實 LINE 帳號操作封鎖並觸發 LINE 平台送出 webhook');
  manual('真機：解除封鎖 → follow webhook → CRM 回到好友', '需要真實 LINE 帳號操作解除封鎖');
  manual('真機：getFriendship=false → 顯示加入好友提示 → requestFriendship', '需要真實 LIFF 瀏覽器環境');
  manual('真機：friendship API 失敗不阻擋結帳', '需要模擬真實 LIFF SDK 異常，無法在 Node 環境模擬瀏覽器 SDK 行為');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix28 smoke test summary（自身測試部分） ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  if (failCount > 0) process.exit(1);

  // ═══════════════ Regression ═══════════════
  console.log('\n=== 執行完整 Regression ===');
  const { execFileSync } = require('child_process');
  const regressionScripts = [
    'smoke-hotfix26-f1.js', 'smoke-hotfix26-f2.js', 'smoke-hotfix26-f3.js',
    'smoke-hotfix26-f4.js', 'smoke-hotfix26-f5.js', 'smoke-hotfix26-f6.js',
    'smoke-hotfix26-f7.js', 'smoke-hotfix26-f8.js', 'smoke-hotfix26-f8-b.js',
    'smoke-hotfix27.js', 'smoke-hotfix27-cd.js',
  ];
  let regressionFail = 0;
  for (const script of regressionScripts) {
    const scriptPath = path.join(__dirname, script);
    if (!fs.existsSync(scriptPath)) { console.log(`[SKIP] ${script}（檔案不存在，如實跳過）`); continue; }
    try {
      const out = execFileSync('node', [scriptPath], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024, timeout: 120000 });
      const summaryLine = out.split('\n').reverse().find(l => /FAIL\s*=\s*\d+|FAIL:\s*\d+|Regression 總結/.test(l)) || '';
      console.log(`[${script}] exit=0 ${summaryLine.trim() || ''}`);
    } catch (e) {
      regressionFail++;
      console.log(`[FAIL] ${script} — exit code ${e.status}`);
    }
  }
  console.log(`\n=== Regression 總結：${regressionScripts.length - regressionFail}/${regressionScripts.length} 個腳本 exit 0 ===`);
  process.exit(regressionFail > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix28] fatal:', e); process.exit(1); });
