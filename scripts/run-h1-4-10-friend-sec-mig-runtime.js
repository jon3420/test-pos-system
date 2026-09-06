#!/usr/bin/env node
// scripts/run-h1-4-10-friend-sec-mig-runtime.js
// H1.4.10 hotfix30-B5-R5.4-FRIEND-LIVE — Security / Reality Gate 1 & 2
//
// 涵蓋（真實 Express + 真實 sql.js DB，不 mock 路由本身）：
//   FRIEND-SEC-1～4：POST /api/line-member/friend-state / /friend-conflict
//     的簽章驗證、跨店隔離、body-supplied UID 不被信任。
//   FRIEND-MIG-1～5：routes/migration.js mode='overwrite' 的好友欄位
//     newer-wins 保護規則（last_friend_check 為唯一比較基準）。
//   額外：一般 deploy（initDb() 重跑 ALTER TABLE 遷移）本身不重置好友狀態。

'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const express = require('express');

const results = [];
function pass(name, detail) { results.push({ name, status: 'PASS', detail }); console.log(`[PASS] ${name}${detail ? ' — ' + detail : ''}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name, detail) : fail(name, detail); }

async function main() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'h1-4-10-friend-sec-mig-'));
  const tmpDbPath = path.join(tmpDir, 'test.db');
  process.env.POS_DB_PATH = tmpDbPath;
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-h1-4-10-friend';
  function cleanup() {
    try { ['', '-wal', '-shm', '-journal'].forEach((s) => { const p = tmpDbPath + s; if (fs.existsSync(p)) fs.unlinkSync(p); }); } catch (e) {}
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (e) {}
  }

  const { initDb, getDb } = require('../utils/db');
  await initDb();
  const db = getDb();
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_001', 'Store 1', 'x', 'pro', 1]);
  db.run(`INSERT OR IGNORE INTO stores (store_id, store_name, contact_name, plan, active) VALUES (?,?,?,?,?)`, ['store_002', 'Store 2', 'x', 'pro', 1]);

  const { createMemberSession } = require('../utils/lineMemberSession');

  function seedMember(storeId, lineUserId, fields) {
    const existing = db.get('SELECT id FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
    const defaults = { display_name: '', is_friend: null, is_blocked: 0, friend_since: '', last_friend_check: '' };
    const row = Object.assign({}, defaults, fields || {});
    if (existing) {
      db.run(
        `UPDATE line_members SET display_name=?, is_friend=?, is_blocked=?, friend_since=?, last_friend_check=? WHERE store_id=? AND line_user_id=?`,
        [row.display_name, row.is_friend, row.is_blocked, row.friend_since, row.last_friend_check, storeId, lineUserId]
      );
    } else {
      db.run(
        `INSERT INTO line_members (store_id, line_user_id, display_name, is_friend, is_blocked, friend_since, last_friend_check)
         VALUES (?,?,?,?,?,?,?)`,
        [storeId, lineUserId, row.display_name, row.is_friend, row.is_blocked, row.friend_since, row.last_friend_check]
      );
    }
    return db.get('SELECT * FROM line_members WHERE store_id=? AND line_user_id=?', [storeId, lineUserId]);
  }

  // ── 真實 Express app：/api/line-member（req.storeId 一律來自
  //    query.store_id，與正式環境 requireStore 的 LINE 點餐相容路徑一致，
  //    這裡刻意不重跑 storeGuard 本身的 store 驗證邏輯，只聚焦本輪新端點）
  const app = express();
  app.use(express.json());
  app.use('/api/line-member', (req, res, next) => { req.storeId = req.query.store_id || 'store_001'; next(); }, require('../routes/line-member'));
  app.use('/api/migration', (req, res, next) => { req.storeId = req.query.store_id || 'store_001'; next(); }, require('../routes/migration'));
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;

  try {
    // ════════════════════════════════════════════════════════════
    // FRIEND-SEC-1：invalid member_session → 不可讀 friend state
    // ════════════════════════════════════════════════════════════
    {
      seedMember('store_001', 'Uchris1', { is_friend: 1, friend_since: '2026-01-01 00:00:00', last_friend_check: '2026-01-01 00:00:00' });
      const res = await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: 'not-a-real-token' }),
      });
      const json = await res.json();
      assert(json.success === false && json.reason === 'invalid_session', 'FRIEND-SEC-1a invalid member_session → success:false/invalid_session', JSON.stringify(json));
      assert(!('is_friend' in json) && !('friend_status' in json), 'FRIEND-SEC-1b invalid session 回應完全不含 friend state（fail closed）', JSON.stringify(json));
      assert(res.status === 200, 'FRIEND-SEC-1c fail closed 仍回 200（不得用 500 暴露內部錯誤，且不阻擋 ordering 本身）');
    }

    // ════════════════════════════════════════════════════════════
    // FRIEND-SEC-2：tampered session → reject
    // ════════════════════════════════════════════════════════════
    {
      const good = createMemberSession({ store_id: 'store_001', line_user_id: 'Uchris1' });
      const parts = good.split('.');
      // 竄改簽章那一段的最後一個字元（保持長度不變，避免只是被 length 檢查擋掉，
      // 真正驗證的是 HMAC 比對本身）。
      const lastChar = parts[1].slice(-1);
      const tamperedChar = lastChar === 'A' ? 'B' : 'A';
      const tampered = parts[0] + '.' + parts[1].slice(0, -1) + tamperedChar;
      const res = await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: tampered }),
      });
      const json = await res.json();
      assert(json.success === false && json.reason === 'invalid_session', 'FRIEND-SEC-2 tampered session（簽章竄改） → reject', JSON.stringify(json));
    }

    // ════════════════════════════════════════════════════════════
    // FRIEND-SEC-3：store spoof → 不可跨店讀取
    // ════════════════════════════════════════════════════════════
    {
      seedMember('store_002', 'Uchris1', { is_friend: 1, friend_since: '2026-01-01 00:00:00', last_friend_check: '2026-01-01 00:00:00' });
      // Uchris1 在 store_001 是 friend=true；在 store_002 也剛好同一個
      // line_user_id 存在一筆 friend=true 的資料。session 是 store_001 核發的，
      // 拿去查 store_002 必須被拒絕（不能因為 line_user_id 相同就跨店讀到）。
      const sessionForStore1 = createMemberSession({ store_id: 'store_001', line_user_id: 'Uchris1' });
      const res = await fetch(`${base}/api/line-member/friend-state?store_id=store_002`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: sessionForStore1 }),
      });
      const json = await res.json();
      assert(json.success === false && json.reason === 'invalid_session', 'FRIEND-SEC-3 store_001 核發的 session 拿去查 store_002 → 拒絕（不可跨店讀取）', JSON.stringify(json));
    }

    // ════════════════════════════════════════════════════════════
    // FRIEND-SEC-4：body 供應的 UID 不被信任
    // ════════════════════════════════════════════════════════════
    {
      seedMember('store_001', 'UchrisA', { is_friend: 0, friend_since: '', last_friend_check: '2026-02-01 00:00:00' });
      seedMember('store_001', 'UchrisB', { is_friend: 1, friend_since: '2026-02-01 00:00:00', last_friend_check: '2026-02-01 00:00:00' });
      const sessionForA = createMemberSession({ store_id: 'store_001', line_user_id: 'UchrisA' });
      const res = await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        // 惡意／誤用：body 額外夾帶一個指向 UchrisB（friend=true）的欄位，
        // 試圖讓端點回報別人的好友狀態。
        body: JSON.stringify({ member_session: sessionForA, line_user_id: 'UchrisB', user_id: 'UchrisB' }),
      });
      const json = await res.json();
      assert(json.success === true && json.is_friend === false, 'FRIEND-SEC-4 body 夾帶的 line_user_id/user_id 完全被忽略，回傳的仍是 session 身份（UchrisA=false）本身的狀態', JSON.stringify(json));
    }

    // ════════════════════════════════════════════════════════════
    // 額外：friend-state 回應不含 PII／token／raw UID
    // ════════════════════════════════════════════════════════════
    {
      const sessionForA = createMemberSession({ store_id: 'store_001', line_user_id: 'UchrisA' });
      const res = await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: sessionForA }),
      });
      const json = await res.json();
      const raw = JSON.stringify(json);
      assert(!raw.includes('UchrisA') && !raw.includes(sessionForA), 'FRIEND-SEC-extra friend-state 回應不含原始 LINE userId／member_session token 內容', raw);
    }

    // ════════════════════════════════════════════════════════════
    // FRIEND-LIVE-5 對應的後端半段：/friend-conflict 只稽核，不改狀態
    // ════════════════════════════════════════════════════════════
    {
      seedMember('store_001', 'UchrisConflict', { is_friend: 0, friend_since: '', last_friend_check: '2026-03-01 00:00:00' });
      const session = createMemberSession({ store_id: 'store_001', line_user_id: 'UchrisConflict' });
      const res = await fetch(`${base}/api/line-member/friend-conflict?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: session, client_signal: 'liff_getFriendship_true' }),
      });
      const json = await res.json();
      assert(json.success === true && json.data.logged === true, 'FRIEND-CONFLICT-1 合法 session → 稽核紀錄寫入成功', JSON.stringify(json));
      const row = db.get('SELECT is_friend, friend_status FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'UchrisConflict']);
      assert(row.is_friend === 0, 'FRIEND-CONFLICT-2 is_friend 完全未被 client 端訊號改變（仍是 false）', JSON.stringify(row));
      const evt = db.get(`SELECT event_type FROM line_friend_events WHERE store_id=? AND line_user_id=? ORDER BY id DESC LIMIT 1`, ['store_001', 'UchrisConflict']);
      assert(evt && evt.event_type === 'friendship_conflict_detected', 'FRIEND-CONFLICT-3 稽核事件確實寫入 line_friend_events（append-only）', JSON.stringify(evt));

      // 短時間內重複衝突 → 去重，不灌爆稽核表
      const before = db.get(`SELECT COUNT(*) AS n FROM line_friend_events WHERE store_id=? AND line_user_id=? AND event_type='friendship_conflict_detected'`, ['store_001', 'UchrisConflict']).n;
      await fetch(`${base}/api/line-member/friend-conflict?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: session, client_signal: 'liff_getFriendship_true' }),
      });
      await fetch(`${base}/api/line-member/friend-conflict?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ member_session: session, client_signal: 'liff_getFriendship_true' }),
      });
      const after = db.get(`SELECT COUNT(*) AS n FROM line_friend_events WHERE store_id=? AND line_user_id=? AND event_type='friendship_conflict_detected'`, ['store_001', 'UchrisConflict']).n;
      assert(after === before, 'FRIEND-CONFLICT-4 同一 member 短時間內重複衝突 → 去重，不重複寫入（避免 lifecycle burst 灌爆稽核表）', `before=${before} after=${after}`);
    }

    // FRIEND-LIVE-9 對應的後端半段：Follow Webhook 更新 backend 之後，
    // friend-state 下一次呼叫必須讀到最新 DB 值（不是快取）。
    {
      seedMember('store_001', 'UchrisWebhook', { is_friend: null, friend_since: '', last_friend_check: '' });
      const session = createMemberSession({ store_id: 'store_001', line_user_id: 'UchrisWebhook' });
      const before = await (await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: session }),
      })).json();
      assert(before.success === true && before.is_friend === null, 'FRIEND-LIVE-9a webhook 前：friend-state 回傳 null（unknown）', JSON.stringify(before));
      // 模擬 Follow Webhook → applyFriendEvent()
      const { applyFriendEvent } = require('../utils/lineFriendSync');
      applyFriendEvent(db, 'store_001', 'UchrisWebhook', { eventType: 'follow', source: 'webhook_follow' });
      const after = await (await fetch(`${base}/api/line-member/friend-state?store_id=store_001`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ member_session: session }),
      })).json();
      assert(after.success === true && after.is_friend === true, 'FRIEND-LIVE-9b webhook 後（不需要新的 session）：friend-state 直接讀到最新 DB true', JSON.stringify(after));
    }

    // ════════════════════════════════════════════════════════════
    // FRIEND-MIG-1～5：routes/migration.js mode='overwrite' newer-wins
    // ════════════════════════════════════════════════════════════
    function buildBackupPayload(storeId, lineMembers) {
      return { type: 'pos_migration_backup', store_id: storeId, data: { line_members: lineMembers } };
    }
    async function doImport(storeId, payload, mode) {
      const res = await fetch(`${base}/api/migration/migration/import?store_id=${storeId}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payload, mode }),
      });
      return { status: res.status, json: await res.json() };
    }

    // FRIEND-MIG-1：current friend=true（較新）+ import older unknown → preserve friend=true
    {
      seedMember('store_001', 'Umig1', { is_friend: 1, friend_since: '2026-05-01 00:00:00', last_friend_check: '2026-05-01 00:00:00' });
      const payload = buildBackupPayload('store_001', [
        { line_user_id: 'Umig1', display_name: 'Mig One (older backup)', is_friend: null, last_friend_check: '2026-01-01 00:00:00' },
      ]);
      const { status, json } = await doImport('store_001', payload, 'overwrite');
      assert(status === 200 && json.success === true, 'FRIEND-MIG-1a import 本身成功（不因保護規則整筆失敗）', JSON.stringify(json));
      const row = db.get('SELECT is_friend, display_name FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Umig1']);
      assert(row.is_friend === 1, 'FRIEND-MIG-1b current friend=true（較新）不被較舊 import 覆蓋回 unknown', JSON.stringify(row));
      assert(row.display_name === 'Mig One (older backup)', 'FRIEND-MIG-1c 非好友相關欄位（display_name）仍照 overwrite contract 正常更新', JSON.stringify(row));
    }

    // FRIEND-MIG-2：current friend=true + import 完全缺 last_friend_check → preserve current
    {
      seedMember('store_001', 'Umig2', { is_friend: 1, friend_since: '2026-05-01 00:00:00', last_friend_check: '2026-05-01 00:00:00' });
      const payload = buildBackupPayload('store_001', [
        { line_user_id: 'Umig2', display_name: 'Mig Two', is_friend: 0 }, // 沒有 last_friend_check 欄位
      ]);
      const { json } = await doImport('store_001', payload, 'overwrite');
      assert(json.success === true, 'FRIEND-MIG-2a import 成功');
      const row = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Umig2']);
      assert(row.is_friend === 1, 'FRIEND-MIG-2b import 缺 last_friend_check（無法比較時間）→ preserve current friend=true', JSON.stringify(row));
    }

    // FRIEND-MIG-3：import 真的比較新（合法的 blocked/friend 狀態轉換）→ 正確更新
    {
      seedMember('store_001', 'Umig3', { is_friend: 1, friend_since: '2026-01-01 00:00:00', last_friend_check: '2026-01-01 00:00:00' });
      const payload = buildBackupPayload('store_001', [
        { line_user_id: 'Umig3', display_name: 'Mig Three', is_friend: 0, is_blocked: 1, last_friend_check: '2026-06-01 00:00:00' },
      ]);
      const { json } = await doImport('store_001', payload, 'overwrite');
      assert(json.success === true, 'FRIEND-MIG-3a import 成功');
      const row = db.get('SELECT is_friend, is_blocked, last_friend_check FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Umig3']);
      assert(row.is_friend === 0 && row.is_blocked === 1 && row.last_friend_check === '2026-06-01 00:00:00', 'FRIEND-MIG-3b import 時間確實比 DB 新 → 正確套用新的好友狀態（依既有 schema semantics）', JSON.stringify(row));
    }

    // FRIEND-MIG-4：brand-new member（DB 尚無此人）→ import 正常建立好友欄位
    {
      const payload = buildBackupPayload('store_001', [
        { line_user_id: 'Umig4New', display_name: 'Mig Four New', is_friend: 1, friend_since: '2026-04-01 00:00:00', last_friend_check: '2026-04-01 00:00:00' },
      ]);
      const { json } = await doImport('store_001', payload, 'overwrite');
      assert(json.success === true, 'FRIEND-MIG-4a import 成功');
      const row = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Umig4New']);
      assert(row && row.is_friend === 1, 'FRIEND-MIG-4b brand-new member 不存在於 current DB → import 正常建立其好友欄位', JSON.stringify(row));
    }

    // FRIEND-MIG-5：non-friend member 的其他欄位仍照 overwrite contract 正常匯入
    {
      seedMember('store_001', 'Umig5', { is_friend: 0, friend_since: '', last_friend_check: '2026-01-01 00:00:00' });
      const payload = buildBackupPayload('store_001', [
        { line_user_id: 'Umig5', display_name: 'Mig Five Updated Name', is_friend: 0, last_friend_check: '2026-01-01 00:00:00' },
      ]);
      const { json } = await doImport('store_001', payload, 'overwrite');
      assert(json.success === true, 'FRIEND-MIG-5a import 成功');
      const row = db.get('SELECT display_name, is_friend FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'Umig5']);
      assert(row.display_name === 'Mig Five Updated Name' && row.is_friend === 0, 'FRIEND-MIG-5b non-friend member 的其他欄位（display_name）仍正常依 overwrite 更新', JSON.stringify(row));
    }

    // ════════════════════════════════════════════════════════════
    // 額外驗證：普通 deploy（initDb() 重跑既有 ALTER TABLE 遷移）本身
    // 不會重置任何既有好友狀態 —— 區分 DEPLOY CODE UPDATE vs MIGRATION
    // OVERWRITE IMPORT 兩種完全不同的風險來源。
    // ════════════════════════════════════════════════════════════
    {
      seedMember('store_001', 'UdeployCheck', { is_friend: 1, friend_since: '2026-01-01 00:00:00', last_friend_check: '2026-01-01 00:00:00' });
      await initDb(); // 模擬一次 redeploy／重啟時會重跑的既有 schema migration
      const row = db.get('SELECT is_friend FROM line_members WHERE store_id=? AND line_user_id=?', ['store_001', 'UdeployCheck']);
      assert(row.is_friend === 1, 'DEPLOY-1 一般 deploy／重啟（重跑既有 ALTER TABLE migration）完全不影響既有好友狀態', JSON.stringify(row));
    }

  } catch (e) {
    console.error('friend-sec-mig runner crashed:', e);
    fail('RUNNER_CRASH', e.message);
  } finally {
    server.close();
    cleanup();
  }

  console.log('\n== FRIEND-SEC / FRIEND-MIG Summary ==');
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

main().catch((e) => { console.error('friend-sec-mig runner crashed:', e); process.exit(1); });
