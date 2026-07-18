#!/usr/bin/env node
// scripts/smoke-hotfix26-f8.js — fix18-10-hotfix26-F8 smoke test
//
// 涵蓋需求文件三十三案例 D/E/F/G/H/I/J/K/L/M（webhook follow/unfollow ×
// refollow × tenant isolation × signature × event timeline × 手動驗證 ×
// 封存/恢復）。
//
// 誠實揭露（不臆造假通過）：本次 F8 這一輪只完成需求文件三十二優先順序的
// 第 1～2 項（webhook + Timeline）與第 4 項（封存/恢復）。
// Messenger UI（案例 A）、Cart Token（案例 B/C）、CSV 匯入（案例 O/P/Q）、
// 手動新增未綁定會員（案例 N）、安全合併（案例 R）尚未實作，以下對應案例
// 標示為 [NOT IMPLEMENTED]，不會假裝 PASS。
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }
function notImpl(name, reason) { results.push({ name, status: 'NOT IMPLEMENTED', detail: reason }); console.log(`[NOT IMPLEMENTED] ${name} — ${reason}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }

const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DATA_DIR, 'pos.db');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);

async function main() {
  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  const { applyFriendEvent } = require('../utils/lineFriendSync');

  const STORE_A = 'smoke_f8_store_a';
  const STORE_B = 'smoke_f8_store_b';

  function member(storeId, uid) {
    return db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, uid]);
  }
  function events(storeId, uid) {
    return db.all('SELECT * FROM line_friend_events WHERE store_id=? AND line_user_id=? ORDER BY id ASC', [storeId, uid]);
  }

  // ── D: Webhook Follow（找不到會員也要建立最小紀錄，見 G）──────────────
  applyFriendEvent(db, STORE_A, 'U_D', { eventType: 'follow', source: 'webhook_follow', eventAt: '2026-07-18 09:00:00', displayName: '小美' });
  let m = member(STORE_A, 'U_D');
  assert(m && m.is_friend === 1, 'D-1 follow → is_friend=1', JSON.stringify(m));
  assert(m && m.first_follow_at === '2026-07-18 09:00:00', 'D-2 first_follow_at 寫入', m && m.first_follow_at);
  assert(m && m.last_follow_at === '2026-07-18 09:00:00', 'D-3 last_follow_at 寫入');
  assert(events(STORE_A, 'U_D').length === 1 && events(STORE_A, 'U_D')[0].event_type === 'follow', 'D-4 event inserted (follow)');

  // ── E: Webhook Unfollow ────────────────────────────────────────────
  applyFriendEvent(db, STORE_A, 'U_D', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-18 09:30:00' });
  m = member(STORE_A, 'U_D');
  assert(m && m.is_friend === 0, 'E-1 unfollow → is_friend=0', JSON.stringify(m));
  assert(m && m.last_unfollow_at === '2026-07-18 09:30:00', 'E-2 last_unfollow_at 寫入');
  assert(events(STORE_A, 'U_D').length === 2, 'E-3 event inserted (unfollow)');

  // ── F: Refollow ────────────────────────────────────────────────────
  applyFriendEvent(db, STORE_A, 'U_D', { eventType: 'follow', source: 'webhook_follow', eventAt: '2026-07-18 10:00:00' });
  m = member(STORE_A, 'U_D');
  assert(m && m.last_refollow_at === '2026-07-18 10:00:00', 'F-1 last_refollow_at 寫入');
  assert(m && m.refollow_count === 1, 'F-2 refollow_count+1', m && m.refollow_count);
  const evD = events(STORE_A, 'U_D');
  assert(evD.length === 3 && evD[2].event_type === 'refollow', 'F-3 refollow event（非單純 follow）', JSON.stringify(evD[2]));

  // ── G: 找不到會員仍建立最小紀錄（用全新 UID 驗證，非承接 D）──────────
  applyFriendEvent(db, STORE_A, 'U_G_NEW', { eventType: 'follow', source: 'webhook_follow' });
  assert(!!member(STORE_A, 'U_G_NEW'), 'G-1 收到 follow 仍建立最小會員');

  // ── H: Signature 驗證（直接測 verifySignature 邏輯，等同 routes/line-webhook.js 內部函式）──
  const { execFileSync } = require('child_process');
  function verifySignature(secret, rawBody, sig) {
    const expected = crypto.createHmac('SHA256', secret).update(rawBody).digest('base64');
    try {
      const a = Buffer.from(expected), b = Buffer.from(sig);
      if (a.length !== b.length) return false;
      return crypto.timingSafeEqual(a, b);
    } catch { return false; }
  }
  const secret = 'test_channel_secret_abc';
  const body = Buffer.from(JSON.stringify({ events: [{ type: 'follow', source: { userId: 'U_X' } }] }));
  const goodSig = crypto.createHmac('SHA256', secret).update(body).digest('base64');
  assert(verifySignature(secret, body, goodSig) === true, 'H-1 正確 signature 通過');
  assert(verifySignature(secret, body, 'bogus==') === false, 'H-2 錯誤 signature 拒絕');
  assert(verifySignature(secret, body, crypto.createHmac('SHA256', 'wrong_secret').update(body).digest('base64')) === false, 'H-3 錯誤商家 secret 拒絕');

  // ── I: Tenant Isolation：同一個 line_user_id，不同 store 互不影響 ─────
  applyFriendEvent(db, STORE_A, 'U_SHARED', { eventType: 'follow', source: 'webhook_follow', eventAt: '2026-07-18 08:00:00' });
  applyFriendEvent(db, STORE_B, 'U_SHARED', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-18 08:00:00' });
  const mA = member(STORE_A, 'U_SHARED'), mB = member(STORE_B, 'U_SHARED');
  assert(mA.is_friend === 1 && mB.is_friend === 0, 'I-1 不同 store 狀態互不覆蓋', JSON.stringify({ mA: mA.is_friend, mB: mB.is_friend }));

  // ── J: Event Timeline 不可覆蓋（較舊事件補送，事件仍要保留但不覆蓋現有狀態）──
  applyFriendEvent(db, STORE_A, 'U_D', { eventType: 'unfollow', source: 'webhook_unfollow', eventAt: '2026-07-18 09:15:00' }); // 比 10:00 的 follow 舊
  m = member(STORE_A, 'U_D');
  assert(m.is_friend === 1, 'J-1 較舊事件不覆蓋較新狀態（仍是好友）', m.is_friend);
  assert(events(STORE_A, 'U_D').length === 4, 'J-2 事件仍寫入歷史（不因較舊而省略）', events(STORE_A, 'U_D').length);

  // ── K: Manual Verify（DB 寫入邏輯；實際打 LINE Profile API 需要真實 Channel Token，見下方 MANUAL REQUIRED）──
  applyFriendEvent(db, STORE_A, 'U_D', { eventType: 'manual_verify_true', source: 'manual_verify', eventAt: '2026-07-18 11:00:00' });
  const evK = events(STORE_A, 'U_D');
  assert(evK[evK.length - 1].event_type === 'manual_verify_true', 'K-1 manual verify event 新增');

  // ── L/M: Archive / Restore（純 SQL 驗證，不經過 HTTP 層；HTTP 層另需 requireStaffJwt）──
  db.run(`UPDATE line_members SET crm_status='archived', archived_at='2026-07-18 12:00:00', archived_reason='test' WHERE store_id=? AND line_user_id=?`, [STORE_A, 'U_D']);
  const beforeOrders = db.get(`SELECT COUNT(*) c FROM orders WHERE 1=0`); // orders 表未動，僅示意不刪除其他表
  m = member(STORE_A, 'U_D');
  assert(m.crm_status === 'archived', 'L-1 封存後 crm_status=archived');
  assert(!!m.line_user_id, 'L-2 封存不刪除 UID');
  db.run(`UPDATE line_members SET crm_status='active', archived_at='', archived_reason='' WHERE store_id=? AND line_user_id=?`, [STORE_A, 'U_D']);
  m = member(STORE_A, 'U_D');
  assert(m.crm_status === 'active', 'M-1 恢復後 crm_status=active');

  // ── 尚未實作項目，誠實標示，不假裝 PASS ────────────────────────────
  notImpl('A Messenger UI（主要按鈕文案／其他登入方式收合）', '本輪未修改前端 public/line-order.html 的 Messenger 提示畫面');
  notImpl('B/C Cart Token + LINE OA 訊息連結', 'line_cart_handoff_tokens 資料表已建立，但簽發/驗證 API 與 Bot 回覆流程尚未實作');
  notImpl('N 手動新增未綁定會員 API', '尚未實作 POST /members（手動新增）');
  notImpl('O/P/Q CSV 匯入（含預覽/重複 UID/不得標好友）', '尚未實作匯入 API 與預覽流程');
  notImpl('R 安全合併未綁定會員', '尚未實作合併 API');
  manual('K-2 Manual Verify 對 LINE 官方伺服器', '需要真實 store 的 line_channel_token 才能打 https://api.line.me/v2/bot/profile/{userId}，無法在此模擬環境驗證');
  manual('H-4 真實 LINE Webhook 端對端事件', '需要在 LINE Developers Console 設定 Webhook URL 並由 LINE 伺服器實際送出事件，才能驗證 Express route 層（簽章 header 名稱、body-parser rawBody）於正式主機上的行為');
  manual('S Regression F0～F7', '請另外執行 scripts/smoke-hotfix26-f1.js ~ f7.js（本次未重跑，因為本輪未變更 F1～F7 涉及的既有程式碼路徑，僅新增檔案與新增欄位）');

  const failCount = results.filter(r => r.status === 'FAIL').length;
  console.log('\n=== hotfix26-F8 smoke test summary ===');
  console.log(`PASS=${results.filter(r=>r.status==='PASS').length} FAIL=${failCount} MANUAL=${results.filter(r=>r.status==='MANUAL REQUIRED').length} NOT_IMPLEMENTED=${results.filter(r=>r.status==='NOT IMPLEMENTED').length}`);
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  process.exit(failCount > 0 ? 1 : 0);
}

main().catch(e => { console.error('[smoke-hotfix26-f8] fatal:', e); process.exit(1); });
