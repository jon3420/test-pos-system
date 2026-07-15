#!/usr/bin/env node
// scripts/smoke-hotfix26-c.js — fix18-10-hotfix26-C smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-c.js
//
// 範圍：只涵蓋 Hotfix26-C（會員後台 UI：好友三態／篩選／深色 Modal／台灣時區／
// CRM Timeline 中文顯示），不含 Hotfix26-D 診斷中心。
//
// 做法：public/js/app.js 是一支 11000+ 行、依賴大量全域 DOM/apiFetch 的檔案，
// 不適合整支 require 進 Node 執行。這裡改用「原始碼字串擷取＋eval 單一函式」
// 的方式，把 renderFriendStatus / formatTaipeiDateTime / parseUtcDate /
// friendEventLabel 這幾個純函式各自抽出來單獨測試（不牽動其餘 app.js 的全域
// 狀態），並輔以對 routes/line-member.js 的 HTTP 呼叫驗證 friend_status 篩選、
// 排序、分頁、lifecycle 篩選可以共同作用，以及 member/:id 回應欄位完整。

'use strict';
const fs = require('fs');
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
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function staffToken(storeId) { return jwt.sign({ role: 'store', store_id: storeId, store_name: 't' }, JWT_SECRET, { expiresIn: '1h' }); }

// ════════════════════════════════════════════════════════════════
// 從 app.js 原始碼中擷取指定函式的原始碼字串（用函式名稱找起訖大括號配對）
// ════════════════════════════════════════════════════════════════
function extractFunctionSource(src, fnName) {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${fnName} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  const bodyStart = i;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

function loadPureHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const names = ['renderFriendStatus', 'friendStatusHtml', 'parseUtcDate', 'formatTaipeiDateTime', 'friendEventLabel'];
  const parts = names.map((n) => extractFunctionSource(src, n));
  // LINE_MEMBER_EVENT_LABELS 是 const 物件，friendEventLabel 依賴它，一併取出。
  const labelMarker = 'const LINE_MEMBER_EVENT_LABELS = {';
  const labelStart = src.indexOf(labelMarker);
  const labelEnd = src.indexOf('};', labelStart) + 2;
  const labelSrc = src.slice(labelStart, labelEnd);
  const code = `${labelSrc}\n${parts.join('\n')}\nmodule.exports = { renderFriendStatus, friendStatusHtml, parseUtcDate, formatTaipeiDateTime, friendEventLabel };\n`;
  const tmpFile = path.join(require('os').tmpdir(), `hotfix26c-helpers-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  try {
    delete require.cache[require.resolve(tmpFile)];
  } catch (e) { /* not cached yet, ignore */ }
  const mod = require(tmpFile);
  try { fs.unlinkSync(tmpFile); } catch (e) { /* best effort cleanup */ }
  return mod;
}

// ════════════════════════════════════════════════════════════════
// 1. renderFriendStatus / friendStatusHtml
// ════════════════════════════════════════════════════════════════
function testRenderFriendStatus(helpers) {
  const cases = [
    [true, '好友', 'friend-status--yes'],
    [1, '好友', 'friend-status--yes'],
    ['friend', '好友', 'friend-status--yes'],
    [false, '非好友', 'friend-status--no'],
    [0, '非好友', 'friend-status--no'],
    ['non_friend', '非好友', 'friend-status--no'],
    [null, '未知', 'friend-status--unknown'],
    [undefined, '未知', 'friend-status--unknown'],
    ['unknown', '未知', 'friend-status--unknown'],
  ];
  let ok = true; let detail = '';
  for (const [input, text, cls] of cases) {
    const r = helpers.renderFriendStatus(input);
    if (r.text !== text || r.className !== cls) { ok = false; detail = `renderFriendStatus(${JSON.stringify(input)}) = ${JSON.stringify(r)}, expected text=${text} class=${cls}`; break; }
  }
  if (ok) pass('renderFriendStatus: true/1/"friend" → 好友；false/0/"non_friend" → 非好友；null/undefined/"unknown" → 未知（不用 truthy 誤判 0/null）');
  else fail('renderFriendStatus 三態判斷', detail);

  // 0 和 null 容易被 truthy 判斷混淆，特別驗證
  const zero = helpers.renderFriendStatus(0);
  const nul = helpers.renderFriendStatus(null);
  if (zero.className === 'friend-status--no' && nul.className === 'friend-status--unknown' && zero.className !== nul.className) {
    pass('renderFriendStatus: 0（非好友）與 null（未知）不會被誤判成同一種狀態');
  } else {
    fail('renderFriendStatus: 0 與 null 必須是不同狀態', `zero=${JSON.stringify(zero)} null=${JSON.stringify(nul)}`);
  }

  const html = helpers.friendStatusHtml(true);
  if (/好友/.test(html) && /🟢/.test(html) && /friend-status--yes/.test(html)) {
    pass('friendStatusHtml: 輸出同時含文字、icon、class（不可只靠顏色）');
  } else {
    fail('friendStatusHtml 輸出內容', html);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. parseUtcDate / formatTaipeiDateTime
// ════════════════════════════════════════════════════════════════
function testTaipeiTime(helpers) {
  // UTC ISO 字串（friend_since/last_friend_check 寫入格式）
  {
    const r = helpers.formatTaipeiDateTime('2026-07-15T12:56:08.853Z');
    if (r === '2026/07/15 20:56' || /2026\/07\/15\s?20:56/.test(r)) pass('formatTaipeiDateTime: UTC ISO 字串正確轉為台灣時間（UTC+8）');
    else fail('formatTaipeiDateTime: UTC ISO 字串轉換', r);
  }
  // 無時區的 SQL datetime('now','localtime') 格式（first_order_at 等欄位寫入格式）
  {
    const r = helpers.formatTaipeiDateTime('2026-07-15 12:56:08');
    if (/2026\/07\/15\s?20:56/.test(r)) pass('formatTaipeiDateTime: 無時區 SQL datetime 字串視為 UTC 再轉換（不誤當本地時間）');
    else fail('formatTaipeiDateTime: SQL datetime 字串轉換', r);
  }
  // includeSeconds
  {
    const r = helpers.formatTaipeiDateTime('2026-07-15T12:56:08.853Z', true);
    if (/:56:08/.test(r)) pass('formatTaipeiDateTime: includeSeconds=true 時輸出含秒');
    else fail('formatTaipeiDateTime: includeSeconds', r);
  }
  // invalid / empty
  {
    const r1 = helpers.formatTaipeiDateTime('');
    const r2 = helpers.formatTaipeiDateTime(null);
    const r3 = helpers.formatTaipeiDateTime('not-a-date');
    if (r1 === '—' && r2 === '—' && r3 === '—') pass('formatTaipeiDateTime: 空值／null／無效日期一律顯示 —（不拋例外、不顯示 Invalid Date）');
    else fail('formatTaipeiDateTime: 無效輸入', `r1=${r1} r2=${r2} r3=${r3}`);
  }
  // 確認不會直接把 UTC ISO 原字串顯示出來
  {
    const r = helpers.formatTaipeiDateTime('2026-07-15T12:56:08.853Z');
    if (!/T\d{2}:\d{2}:\d{2}\.\d{3}Z/.test(r)) pass('formatTaipeiDateTime: 輸出不含原始 UTC ISO 字串格式（已正確轉換顯示）');
    else fail('formatTaipeiDateTime: 不應直接顯示 UTC ISO 原字串', r);
  }
}

// ════════════════════════════════════════════════════════════════
// 3. friendEventLabel（CRM Timeline 中文顯示）
// ════════════════════════════════════════════════════════════════
function testFriendEventLabel(helpers) {
  const known = [
    ['friend_status_checked', '已確認官方帳號好友狀態'],
    ['joined_official_account', '已加入 LINE 官方帳號'],
    ['unfollowed_official_account', '已取消好友或封鎖官方帳號'],
    ['friend_added', '加入好友'],
    ['friend_removed', '取消好友'],
    ['login', '登入'],
  ];
  let ok = true; let detail = '';
  for (const [name, label] of known) {
    const got = helpers.friendEventLabel(name);
    if (got !== label) { ok = false; detail = `friendEventLabel(${name}) = ${got}, expected ${label}`; break; }
  }
  if (ok) pass('friendEventLabel: 新舊 CRM Timeline 事件皆有正確中文顯示名稱');
  else fail('friendEventLabel 已知事件', detail);

  const unknown = helpers.friendEventLabel('some_future_event_type');
  if (unknown === 'some_future_event_type') pass('friendEventLabel: 未知事件仍顯示原始 event_name，不會整段消失');
  else fail('friendEventLabel: 未知事件 fallback', unknown);
}

// ════════════════════════════════════════════════════════════════
// 4. Server-backed：friend_status 篩選、排序、分頁、lifecycle 共存；member/:id 欄位完整
// ════════════════════════════════════════════════════════════════
function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['server.js'], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), NODE_ENV: 'production', PUBLIC_BASE_URL: 'https://pop-system-v13.zeabur.app' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = ''; let settled = false;
    const timer = setTimeout(() => { if (!settled) { settled = true; reject(new Error('server start timeout, log:\n' + out)); } }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); if (!settled && /POS SaaS Foundation R1/.test(out)) { settled = true; clearTimeout(timer); resolve(child); } });
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
async function jsonFetch(url, opts) {
  const res = await fetch(url, opts);
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (e) { body = { __raw: text }; }
  return { status: res.status, body };
}

async function seedMembersForSort() {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  const { upsertMemberProfile, recordMemberPurchase } = require(path.join(ROOT, 'utils/lineMemberStats'));
  await initDb();
  const db = getDb();
  const STORE = 'store_001';
  const marker = 'Hotfix26CTest_' + Date.now();
  const uidFriend = 'Cfriend_' + Date.now();
  const uidNonFriend = 'Cnonfriend_' + Date.now();
  const uidUnknown = 'Cunknown_' + Date.now();
  [uidFriend, uidNonFriend, uidUnknown].forEach((uid) => {
    try { db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', [STORE, uid]); db.run('DELETE FROM line_member_history WHERE store_id=? AND line_user_id=?', [STORE, uid]); } catch (e) {}
  });
  upsertMemberProfile(db, STORE, { line_user_id: uidFriend, display_name: marker, is_friend: true, is_login: true });
  upsertMemberProfile(db, STORE, { line_user_id: uidNonFriend, display_name: marker, is_friend: false, is_login: true });
  upsertMemberProfile(db, STORE, { line_user_id: uidUnknown, display_name: marker, is_friend: null, is_login: true });
  recordMemberPurchase(db, STORE, uidFriend, 'hotfix26c_test_order_' + Date.now(), 500);
  return { STORE, marker, uidFriend, uidNonFriend, uidUnknown };
}
function cleanupMembersForSort(seed) {
  const { getDb } = require(path.join(ROOT, 'utils/db'));
  const db = getDb();
  [seed.uidFriend, seed.uidNonFriend, seed.uidUnknown].forEach((uid) => {
    try { db.run('DELETE FROM line_members WHERE store_id=? AND line_user_id=?', [seed.STORE, uid]); db.run('DELETE FROM line_member_history WHERE store_id=? AND line_user_id=?', [seed.STORE, uid]); } catch (e) {}
  });
  try { db.run("DELETE FROM line_member_order_links WHERE order_id LIKE 'hotfix26c_test_order_%'"); } catch (e) {}
}

async function testServerBacked(seed) {
  const token = staffToken(seed.STORE);
  const authHeader = { Authorization: `Bearer ${token}` };

  // friend_status 篩選各狀態
  for (const [fs, expected] of [['friend', 1], ['non_friend', 1], ['unknown', 1], ['all', 3]]) {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}&friend_status=${fs}`, { headers: authHeader });
    const count = body && body.success ? body.data.length : -1;
    if (status === 200 && count === expected) pass(`GET /members?friend_status=${fs} 篩選正確（count=${count}）`);
    else fail(`GET /members?friend_status=${fs} 篩選正確`, `status=${status} count=${count} expected=${expected}`);
  }

  // friend_status 與 q（關鍵字）共存
  {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}&friend_status=friend`, { headers: authHeader });
    if (status === 200 && body.data.length === 1 && body.data[0].display_name === seed.marker) pass('friend_status 篩選可與關鍵字 q 搜尋共同作用');
    else fail('friend_status 與 q 共存', JSON.stringify(body));
  }

  // friend_status 與既有 filter（lifecycle-ish）共存：repeat_buyer 篩選應該只留下有購買紀錄的好友
  {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}&friend_status=friend&filter=first_buyer`, { headers: authHeader });
    if (status === 200 && body.data.length === 1) pass('friend_status 篩選可與既有 lifecycle-ish filter（first_buyer）共同作用');
    else fail('friend_status 與既有 filter 共存', JSON.stringify(body));
  }

  // 排序 + 分頁參數仍正常
  {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}&friend_status=all&sort=last_login&limit=2&offset=0`, { headers: authHeader });
    if (status === 200 && body.success && body.data.length <= 2 && body.limit === 2) pass('friend_status 篩選不影響既有排序／分頁參數（limit/offset）運作');
    else fail('friend_status 篩選與排序／分頁共存', JSON.stringify(body).slice(0, 200));
  }

  // member/:id 欄位完整性
  {
    const { body: listBody } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}&friend_status=friend`, { headers: authHeader });
    const row = listBody && listBody.data && listBody.data[0];
    if (!row) { fail('GET /members/:id 欄位完整性', 'seed row not found'); return; }
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/members/${row.line_user_id_ref}`, { headers: authHeader });
    const d = body && body.data;
    const requiredFields = ['is_friend', 'friend_status', 'last_friend_check_at', 'require_friend', 'require_follow', 'meets_requirement', 'timeline'];
    const missing = requiredFields.filter((f) => !(f in (d || {})));
    if (status === 200 && missing.length === 0) pass('GET /members/:id 回傳所有 Hotfix26-C 後台 UI 需要的欄位');
    else fail('GET /members/:id 欄位完整性', `missing=${missing.join(',')}`);
  }

  // store isolation：另一店家搜不到這批種子資料
  {
    const otherToken = staffToken('store_isolation_nonexistent');
    const { status } = await jsonFetch(`${BASE}/api/line-member/members?q=${encodeURIComponent(seed.marker)}`, { headers: { Authorization: `Bearer ${otherToken}` } });
    if (status === 403 || status === 401) pass('店家隔離：不存在／未授權的 store_id JWT 無法查詢會員列表');
    else fail('店家隔離', `status=${status}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 5. 靜態檢查：HTML id / JS selector 對應、CSS class 存在、Dashboard JS 語法
// ════════════════════════════════════════════════════════════════
function testStaticChecks() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'public/css/main.css'), 'utf8');

  const ids = ['lmFriendStatusSelect', 'lmPager', 'lmFilterSelect', 'lmSortSelect', 'lmSearchInput', 'lmDetailModal', 'lmDetailBody', 'lmTableBody'];
  let ok = true; let detail = '';
  for (const id of ids) {
    const inHtml = new RegExp(`id="${id}"`).test(html);
    const inJs = new RegExp(`getElementById\\('${id}'\\)`).test(appJs);
    if (!inHtml || !inJs) { ok = false; detail += `${id}: inHtml=${inHtml} inJs=${inJs}; `; }
  }
  if (ok) pass('HTML id 與 JS getElementById 選擇器一一對應（無孤兒 id、無寫錯的 selector）');
  else fail('HTML id / JS selector 對應', detail);

  const cssClasses = ['.friend-status--yes', '.friend-status--no', '.friend-status--unknown', '.member-detail-modal', '.member-detail-modal__body', '.member-detail-modal__close'];
  const missingCss = cssClasses.filter((c) => !css.includes(c));
  if (missingCss.length === 0) pass('main.css 含所有 Hotfix26-C 需要的 class（好友三態／深色 Modal）');
  else fail('main.css class 缺漏', missingCss.join(','));

  if (html.includes('class="member-detail-modal"')) pass('lmDetailModal 容器已套用深色 member-detail-modal class（不再是白底 inline style）');
  else fail('lmDetailModal 容器套用深色樣式', 'not found');

  // 確認不再有殘留的白底 inline style（原本 background:#fff 的那顆 detail modal 容器）
  const modalBlockMatch = html.match(/<div id="lmDetailModal"[\s\S]*?<\/div>\s*<\/div>/);
  const modalBlock = modalBlockMatch ? modalBlockMatch[0] : '';
  if (!/background:#fff/.test(modalBlock)) pass('lmDetailModal 區塊已移除舊的白底 inline style（無白底淺字對比問題）');
  else fail('lmDetailModal 舊白底樣式應已移除', 'still found background:#fff');

  try { require('child_process').execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/app.js')]); pass('node --check public/js/app.js（含 Dashboard 相關程式碼）語法正確'); }
  catch (e) { fail('node --check public/js/app.js', e.message); }
}

async function main() {
  console.log('\n== Hotfix26-C smoke test ==\n');
  const helpers = loadPureHelpers();

  console.log('-- Section 1: renderFriendStatus / friendStatusHtml --');
  testRenderFriendStatus(helpers);

  console.log('\n-- Section 2: parseUtcDate / formatTaipeiDateTime --');
  testTaipeiTime(helpers);

  console.log('\n-- Section 3: friendEventLabel (CRM Timeline 中文顯示) --');
  testFriendEventLabel(helpers);

  console.log('\n-- Section 4: server-backed friend_status filter / sort / pagination / detail fields --');
  let seed = null;
  try { seed = await seedMembersForSort(); } catch (e) { fail('seedMembersForSort crashed', e.stack); }
  const child = seed ? await startServer().catch((e) => { fail('server boot', e.message.split('\n')[0]); return null; }) : null;
  if (child) {
    await sleep(300);
    try { await testServerBacked(seed); } catch (e) { fail('testServerBacked crashed', e.stack); }
    await stopServer(child);
  }
  if (seed) { try { cleanupMembersForSort(seed); } catch (e) {} }

  console.log('\n-- Section 5: static checks (HTML id / CSS / node --check) --');
  testStaticChecks();

  manual('會員列表／詳情 Modal 在真實瀏覽器（桌面／平板／手機）的視覺呈現', '需要真實瀏覽器渲染環境確認 RWD、捲動、對比度等視覺細節');
  manual('Dashboard 頁面在有大量會員資料時的實際渲染效果', '需要真實瀏覽器 + 大量資料集才能完整驗證版面');

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
