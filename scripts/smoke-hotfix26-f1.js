#!/usr/bin/env node
// scripts/smoke-hotfix26-f1.js — fix18-10-hotfix26-F1 smoke test
//
// 直接呼叫 utils/lineMemberStats.upsertMemberProfile()（不透過 HTTP，因為真正
// 的 LINE ID Token／Friendship API 需要打 LINE 官方伺服器，無法在此模擬），
// 涵蓋需求文件案例 A～H（I／J 為 Webhook follow/unfollow，本專案目前沒有
// LINE Webhook route，依需求文件十五「如系統已有 LINE Webhook」為條件句，
// 系統未有此路由，故標示 MANUAL REQUIRED／N-A，不臆造假路由）。
'use strict';
const path = require('path');
const fs = require('fs');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
// 用全新、獨立的 DB 檔跑測試，測完刪除，不動到任何既有資料。
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const { upsertMemberProfile, isStaleFriendshipUpdate } = require('../utils/lineMemberStats');

  const STORE_A = 'smoke_store_a';
  const STORE_B = 'smoke_store_b';

  function row(storeId, uid) {
    return db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, uid]);
  }

  // ── 案例 C：非好友 → 好友（模擬需求文件情境：原本是好友 → 封鎖/非好友 → 重新加入）
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: true, is_login: true }, { source: 'login_verify', checked_at: '2026-07-16T09:00:00.000Z' });
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: false, is_login: true }, { source: 'login_verify', checked_at: '2026-07-16T10:00:00.000Z' });
  let r = row(STORE_A, 'U_C');
  if (r && r.is_friend === 0 && r.friend_source === 'login_verify') pass('案例C-前置：曾為好友，封鎖後變非好友建立成功');
  else fail('案例C-前置：曾為好友，封鎖後變非好友建立成功', JSON.stringify(r));

  const res1 = upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: true, is_login: true }, { source: 'checkout_recheck', checked_at: '2026-07-16T11:00:00.000Z' });
  r = row(STORE_A, 'U_C');
  if (r && r.is_friend === 1 && res1.friendEvent === 'friend_restored' && r.friend_status_changed_at === '2026-07-16T11:00:00.000Z' && r.friend_source === 'checkout_recheck') {
    pass('案例C：非好友重新加入 → is_friend=1／friend_restored／friend_status_changed_at 更新');
  } else fail('案例C：非好友重新加入', JSON.stringify({ r, res1 }));
  const historyC = db.all("SELECT event_name FROM line_member_history WHERE store_id=? AND line_user_id=? AND event_name IN ('friend_restored')", [STORE_A, 'U_C']);
  if (historyC.length === 1) pass('案例C：history 新增一筆 friend_restored（不重複）');
  else fail('案例C：history 新增一筆 friend_restored（不重複）', JSON.stringify(historyC));

  // ── 案例 A：好友保持好友（同狀態，不應重複寫 history，只更新 last_friend_check）─
  const beforeA = row(STORE_A, 'U_C');
  const res2 = upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: true, is_login: false }, { source: 'liff_friendship', checked_at: '2026-07-16T12:00:00.000Z' });
  const afterA = row(STORE_A, 'U_C');
  if (afterA.is_friend === 1 && afterA.last_friend_check === '2026-07-16T12:00:00.000Z' && afterA.friend_status_changed_at === beforeA.friend_status_changed_at && !res2.friendEvent) {
    pass('案例A：好友保持好友 → 只更新 last_friend_check，不動 friend_status_changed_at，不重複 history');
  } else fail('案例A：好友保持好友', JSON.stringify({ beforeA, afterA, res2 }));

  // ── 案例 B：好友變非好友 ────────────────────────────────────────
  const res3 = upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: false, is_login: false }, { source: 'checkout_recheck', checked_at: '2026-07-16T13:00:00.000Z' });
  const afterB = row(STORE_A, 'U_C');
  if (afterB.is_friend === 0 && res3.friendEvent === 'friend_removed' && afterB.friend_status_changed_at === '2026-07-16T13:00:00.000Z') {
    pass('案例B：好友變非好友 → is_friend=0／friend_removed／changed=true');
  } else fail('案例B：好友變非好友', JSON.stringify({ afterB, res3 }));

  // ── 案例 E：未知結果（friend_flag=null）不覆蓋既有狀態 ───────────
  const beforeE = row(STORE_A, 'U_C');
  const res4 = upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: null, is_login: false }, { source: 'unknown', checked_at: '2026-07-16T14:00:00.000Z' });
  const afterE = row(STORE_A, 'U_C');
  if (afterE.is_friend === beforeE.is_friend && afterE.last_friend_check === beforeE.last_friend_check && afterE.friend_source === beforeE.friend_source) {
    pass('案例E：friend_flag=null 不覆蓋既有狀態、不更新 checked_at/來源');
  } else fail('案例E：friend_flag=null 不覆蓋既有狀態', JSON.stringify({ beforeE, afterE }));

  // ── 案例 H：舊事件晚到（stale checked_at 應被忽略）───────────────
  const beforeH = row(STORE_A, 'U_C'); // is_friend=0, last_friend_check=13:00
  const res5 = upsertMemberProfile(db, STORE_A, { line_user_id: 'U_C', display_name: 'C', is_friend: true, is_login: false }, { source: 'webhook_follow', checked_at: '2026-07-16T12:30:00.000Z' });
  const afterH = row(STORE_A, 'U_C');
  if (afterH.is_friend === beforeH.is_friend && afterH.last_friend_check === beforeH.last_friend_check && res5.staleIgnored === true) {
    pass('案例H：舊事件晚到 → 忽略，狀態與時間不變');
  } else fail('案例H：舊事件晚到', JSON.stringify({ beforeH, afterH, res5 }));

  // pure-function check for stale comparator
  if (isStaleFriendshipUpdate('2026-07-16T13:00:00.000Z', '2026-07-16T12:30:00.000Z') === true
      && isStaleFriendshipUpdate('2026-07-16T13:00:00.000Z', '2026-07-16T13:30:00.000Z') === false
      && isStaleFriendshipUpdate('', '2026-07-16T13:30:00.000Z') === false) {
    pass('isStaleFriendshipUpdate() 純函式行為正確');
  } else fail('isStaleFriendshipUpdate() 純函式行為正確');

  // ── 案例 D 的資料庫端（前端按鈕流程本身需要真實 LIFF，見 MANUAL）────
  manual('案例D：重新確認按鈕端到端（liff.getFriendship→POST→關閉提示窗）', '需要真實 LIFF/LINE App 環境，無法在 smoke test 內模擬');

  // ── 案例 F：相同 IP 不影響（本測試不使用 IP 做任何判斷，兩個不同 line_user_id 各自獨立）
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_F1', display_name: 'F1', is_friend: true, is_login: true }, { source: 'login_verify' });
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_F2', display_name: 'F2', is_friend: false, is_login: true }, { source: 'login_verify' });
  const f1 = row(STORE_A, 'U_F1'); const f2 = row(STORE_A, 'U_F2');
  if (f1.is_friend === 1 && f2.is_friend === 0) pass('案例F：不同 LINE User 各自獨立狀態（未依 IP 合併）');
  else fail('案例F：不同 LINE User 各自獨立狀態', JSON.stringify({ f1, f2 }));

  // ── 案例 G：跨店相同 LINE User ID 各自獨立 ───────────────────────
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_CROSS', display_name: 'Cross', is_friend: true, is_login: true }, { source: 'login_verify' });
  upsertMemberProfile(db, STORE_B, { line_user_id: 'U_CROSS', display_name: 'Cross', is_friend: false, is_login: true }, { source: 'login_verify' });
  const crossA = row(STORE_A, 'U_CROSS'); const crossB = row(STORE_B, 'U_CROSS');
  if (crossA.is_friend === 1 && crossB.is_friend === 0) pass('案例G：跨店相同 LINE User ID 各自獨立，不互相覆蓋');
  else fail('案例G：跨店相同 LINE User ID 各自獨立', JSON.stringify({ crossA, crossB }));

  // ── 已存在會員再次驗證：不得 early return，仍要更新 display_name/is_friend ──
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_EXIST', display_name: 'Old Name', is_friend: false, is_login: true }, { source: 'login_verify' });
  upsertMemberProfile(db, STORE_A, { line_user_id: 'U_EXIST', display_name: 'New Name', is_friend: true, is_login: true }, { source: 'checkout_recheck' });
  const existRow = row(STORE_A, 'U_EXIST');
  if (existRow.display_name === 'New Name' && existRow.is_friend === 1) pass('已存在會員再次驗證：display_name／is_friend 皆有更新（無 early return）');
  else fail('已存在會員再次驗證：無 early return', JSON.stringify(existRow));

  // ── 案例 I／J：Webhook follow/unfollow ───────────────────────────
  manual('案例I：Webhook follow event', '本專案目前沒有 LINE Webhook route（需求文件十五為條件句：如系統已有），未新增假路由');
  manual('案例J：Webhook unfollow event', '同上，未新增假路由');

  // clean up test db
  try { fs.unlinkSync(DB_FILE); } catch (e) {}

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== SUMMARY ===');
  results.forEach(r => console.log(`${r.status}: ${r.name}`));
  console.log(`\nTotal: ${results.length}, PASS: ${results.filter(r=>r.status==='PASS').length}, FAIL: ${failCount}, MANUAL: ${results.filter(r=>r.status==='MANUAL REQUIRED').length}`);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix26-f1] fatal:', e); process.exit(1); });
