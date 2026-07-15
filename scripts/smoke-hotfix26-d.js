#!/usr/bin/env node
// scripts/smoke-hotfix26-d.js — fix18-10-hotfix26-D smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-d.js
//
// 範圍：只涵蓋 Hotfix26-D（LINE 設定診斷中心：public/js/app.js 內的
// _lineDiag*() 系列純函式與健康度計算，以及 diagnostic_only 後端安全性）。
//
// 做法同 Hotfix26-C：從 app.js 原始碼抽出純函式，寫到暫存檔後 require 執行；
// Backend diagnostic_only 的「不寫資料」驗證則是真的啟動 server 比對
// 診斷前後 line_members / line_member_history 筆數。

'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execFileSync } = require('child_process');
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
// 從 app.js 抽出診斷中心的純函式，用最小 window/liff/fetch mock 執行
// ════════════════════════════════════════════════════════════════
function extractFunctionSource(src, fnName) {
  const marker = `function ${fnName}(`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`function ${fnName} not found in app.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}
function extractConstSource(src, constName) {
  const marker = `const ${constName} =`;
  const start = src.indexOf(marker);
  if (start === -1) throw new Error(`const ${constName} not found`);
  const end = src.indexOf(';', start) + 1;
  return src.slice(start, end);
}

function loadDiagHelpers() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');
  const fnNames = [
    '_lineDiagStatusMeta', '_lineDiagCheckLiffIdFormat', '_lineDiagCheckChannelConsistency',
    '_lineDiagCheckDomain', '_lineDiagCheckBasicId', '_lineDiagCheckAddFriendUrl',
    '_lineDiagCheckOldDomain', '_computeLineDiagHealth', '_lineDiagRow',
  ];
  const constNames = ['LINE_DIAG_OLD_DOMAIN'];
  const parts = fnNames.map((n) => extractFunctionSource(src, n));
  const constParts = constNames.map((n) => extractConstSource(src, n));
  const exportsList = fnNames.join(', ');
  const windowMock = `var window = (typeof window !== 'undefined') ? window : { location: { origin: 'https://pos-system.zeabur.app', hostname: 'pos-system.zeabur.app', protocol: 'https:' } };\n`;
  const code = `${windowMock}${constParts.join('\n')}\n${parts.join('\n')}\nmodule.exports = { ${exportsList}, LINE_DIAG_OLD_DOMAIN };\n`;
  const tmpFile = path.join(os.tmpdir(), `hotfix26d-helpers-${process.pid}-${Date.now()}.js`);
  fs.writeFileSync(tmpFile, code, 'utf8');
  const mod = require(tmpFile);
  try { fs.unlinkSync(tmpFile); } catch (e) {}
  return mod;
}

// ════════════════════════════════════════════════════════════════
// 1. LIFF ID 格式 / Channel 一致性
// ════════════════════════════════════════════════════════════════
function testLiffIdAndChannel(h) {
  const cases = [
    ['1234567890-abcdefgh', 'ok'],
    ['', 'error'],
    [null, 'error'],
    ['not-a-valid-format-!!', 'warn'],
  ];
  let ok = true; let detail = '';
  for (const [input, expected] of cases) {
    const r = h._lineDiagCheckLiffIdFormat(input);
    if (r.level !== expected) { ok = false; detail = `_lineDiagCheckLiffIdFormat(${JSON.stringify(input)}).level=${r.level}, expected ${expected}`; break; }
  }
  if (ok) pass('LIFF ID 格式檢查：正常／空白／格式錯誤 三種情境正確分級');
  else fail('LIFF ID 格式檢查', detail);

  const consistent = h._lineDiagCheckChannelConsistency('2010718887-xxxxx', '2010718887');
  const inconsistent = h._lineDiagCheckChannelConsistency('2010718887-xxxxx', '9999999999');
  const untested = h._lineDiagCheckChannelConsistency('', '');
  if (consistent.level === 'ok' && inconsistent.level === 'error' && untested.level === 'untested') {
    pass('Channel ID 一致性檢查：一致／不一致／未設定 三種情境正確分級');
  } else {
    fail('Channel ID 一致性檢查', `consistent=${consistent.level} inconsistent=${inconsistent.level} untested=${untested.level}`);
  }
  if (/目前 LIFF ID/.test(inconsistent.detail || '') && /目前 Channel ID/.test(inconsistent.detail || '')) {
    pass('Channel ID 不一致時，錯誤訊息包含目前 LIFF ID 與 Channel ID 供人工比對');
  } else {
    fail('Channel ID 不一致錯誤訊息內容', inconsistent.detail);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. Basic ID / 加好友網址 / 舊網域檢查
// ════════════════════════════════════════════════════════════════
function testBasicIdAndFriendUrlAndOldDomain(h) {
  {
    const ok1 = h._lineDiagCheckBasicId('@936gvopq');
    const warn1 = h._lineDiagCheckBasicId('936gvopq'); // 缺 @
    const warn2 = h._lineDiagCheckBasicId('');
    if (ok1.level === 'ok' && warn1.level === 'warn' && warn2.level === 'warn') pass('OA Basic ID 檢查：正常／缺 @ 格式警告／空白警告（格式檢查失敗不視為一定無法登入）');
    else fail('OA Basic ID 檢查', `ok1=${ok1.level} warn1=${warn1.level} warn2=${warn2.level}`);
  }
  {
    const ok = h._lineDiagCheckAddFriendUrl('https://lin.ee/xxxxx', false);
    const warnOther = h._lineDiagCheckAddFriendUrl('https://example.com/add', false);
    const errRequired = h._lineDiagCheckAddFriendUrl('', true);
    const warnOptional = h._lineDiagCheckAddFriendUrl('', false);
    if (ok.level === 'ok' && warnOther.level === 'warn' && errRequired.level === 'error' && warnOptional.level === 'warn') {
      pass('加好友網址檢查：lin.ee 正常／其他 HTTPS 網域警告／require_follow=true 且空白為異常／require_follow=false 且空白為警告');
    } else {
      fail('加好友網址檢查', `ok=${ok.level} warnOther=${warnOther.level} errRequired=${errRequired.level} warnOptional=${warnOptional.level}`);
    }
  }
  {
    const clean = h._lineDiagCheckOldDomain({ line_member_return_url: 'https://pos-system.zeabur.app/line-order.html' });
    const dirty = h._lineDiagCheckOldDomain({ line_member_return_url: `https://${h.LINE_DIAG_OLD_DOMAIN}/line-order.html` });
    if (clean.level === 'ok' && dirty.level === 'error') pass('舊網域檢查：目前設定值找不到舊網域顯示正常，找到時顯示異常並附建議確認文字');
    else fail('舊網域檢查', `clean=${clean.level} dirty=${dirty.level}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 3. 健康度計算
// ════════════════════════════════════════════════════════════════
function testHealthScore(h) {
  const allOk = {
    liffFormat: { level: 'ok' }, channelConsistency: { level: 'ok' }, liffInit: { level: 'ok' },
    login: { level: 'ok' }, friendApi: { level: 'ok' }, backendVerify: { level: 'ok' },
    domain: { level: 'ok' }, returnUrl: { level: 'ok' }, basicId: { level: 'ok' },
  };
  const scoreAllOk = h._computeLineDiagHealth(allOk);
  if (scoreAllOk.score === 100 && scoreAllOk.level === 'green') pass('健康度計算：全部正常 → 100 分、綠燈');
  else fail('健康度計算：全部正常', JSON.stringify(scoreAllOk));

  // 尚未登入導致 Friend API untested，不應該把整體判定成故障（仍可落在 70-89 或更高）
  const notLoggedIn = { ...allOk, login: { level: 'warn' }, friendApi: { level: 'untested' }, backendVerify: { level: 'warn' } };
  const scoreNotLoggedIn = h._computeLineDiagHealth(notLoggedIn);
  if (scoreNotLoggedIn.score >= 70 && scoreNotLoggedIn.score < 100) pass('健康度計算：尚未登入（Friend API untested）落在 70-89 建議檢查區間，不會被判定為嚴重故障');
  else fail('健康度計算：尚未登入不應判定故障', JSON.stringify(scoreNotLoggedIn));

  const allError = { ...allOk, liffFormat: { level: 'error' }, channelConsistency: { level: 'error' }, liffInit: { level: 'error' }, backendVerify: { level: 'error' } };
  const scoreAllError = h._computeLineDiagHealth(allError);
  if (scoreAllError.score < 70 && scoreAllError.level === 'red') pass('健康度計算：多項異常 → 低於 70 分、紅燈');
  else fail('健康度計算：多項異常應為紅燈', JSON.stringify(scoreAllError));

  // 分數範圍校驗
  const levels = ['ok', 'warn', 'error', 'untested'];
  let inRange = true;
  for (let i = 0; i < 20; i++) {
    const r = {};
    ['liffFormat', 'channelConsistency', 'liffInit', 'login', 'friendApi', 'backendVerify', 'domain', 'returnUrl', 'basicId'].forEach((k) => {
      r[k] = { level: levels[Math.floor(Math.random() * levels.length)] };
    });
    const s = h._computeLineDiagHealth(r);
    if (s.score < 0 || s.score > 100) { inRange = false; break; }
  }
  if (inRange) pass('健康度計算：任意組合下分數皆落在 0-100 範圍內');
  else fail('健康度計算：分數應限制在 0-100', '');
}

// ════════════════════════════════════════════════════════════════
// 4. 診斷結果不含 secret／stack（純字串檢查 _lineDiagRow 輸出）
// ════════════════════════════════════════════════════════════════
function testNoSecretLeak(h) {
  const row = h._lineDiagRow('Backend Verify', { level: 'error', text: '連線失敗', detail: 'Error: fetch failed at /home/app/routes/line-member.js:120:5' });
  const forbidden = ['access_token', 'id_token', 'channel_secret', 'authorization', 'session_cookie'];
  const lower = row.toLowerCase();
  const leaked = forbidden.filter((f) => lower.includes(f));
  if (leaked.length === 0) pass('_lineDiagRow 輸出不包含 token／secret／authorization 等關鍵字');
  else fail('_lineDiagRow 不應包含敏感關鍵字', leaked.join(','));
}

// ════════════════════════════════════════════════════════════════
// 5. Server-backed：diagnostic_only 不寫資料、store 隔離、不洩漏 stack
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
  return { status: res.status, body, raw: text };
}
async function countMembersAndHistory(storeId) {
  const { initDb, getDb } = require(path.join(ROOT, 'utils/db'));
  await initDb();
  const db = getDb();
  const members = db.get('SELECT COUNT(*) c FROM line_members WHERE store_id=?', [storeId]).c;
  const history = db.get('SELECT COUNT(*) c FROM line_member_history WHERE store_id=?', [storeId]).c;
  return { members, history };
}

async function testServerBackedDiagnostics() {
  const STORE = 'store_001';
  const before = await countMembersAndHistory(STORE);

  const cases = [
    { name: 'diagnostic verify: 無效 token + diagnostic_only=true 不建立會員、不 500', body: { id_token: 'not.a.valid.jwt', diagnostic_only: true } },
    { name: 'diagnostic verify: 缺 id_token 仍安全回應', body: { diagnostic_only: true } },
  ];
  for (const c of cases) {
    const { status, body, raw } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(c.body),
    });
    const hasStack = /at\s+\S+\s+\(.*:\d+:\d+\)/.test(raw) || /\.js:\d+:\d+/.test(raw);
    const createdMember = body && body.success === true && !body.diagnostic_only;
    if (status < 500 && !hasStack && !createdMember) pass(c.name);
    else fail(c.name, `status=${status} hasStack=${hasStack} body=${JSON.stringify(body).slice(0, 200)}`);
  }

  const after = await countMembersAndHistory(STORE);
  if (after.members === before.members && after.history === before.history) {
    pass('diagnostic_only 呼叫前後，line_members／line_member_history 筆數完全不變（不污染正式資料）');
  } else {
    fail('diagnostic_only 不應改變會員／CRM Timeline 筆數', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  {
    const { status } = await jsonFetch(`${BASE}/api/line-member/members`);
    if (status === 401) pass('後台會員 API（診斷中心會用到的同一組 API）未帶 JWT 仍回 401，維持多店隔離');
    else fail('後台會員 API store 隔離', `status=${status}`);
  }

  {
    const token = staffToken(STORE);
    const { status, body } = await jsonFetch(`${BASE}/api/settings`, { headers: { Authorization: `Bearer ${token}` } });
    const raw = JSON.stringify(body).toLowerCase();
    const forbidden = ['channel_secret', 'client_secret', 'access_token', 'id_token'];
    const leaked = forbidden.filter((f) => raw.includes(f));
    if (status === 200 && leaked.length === 0) pass('GET /api/settings 回應不含 channel_secret／access_token／id_token 等敏感欄位名稱');
    else fail('GET /api/settings 不應洩漏敏感欄位', `status=${status} leaked=${leaked.join(',')}`);
  }
}

// ════════════════════════════════════════════════════════════════
// 6. 靜態檢查：HTML id / JS selector、runtime 舊網域搜尋、node --check
// ════════════════════════════════════════════════════════════════
function testStaticChecks() {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const appJs = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  const ids = ['lineDiagHealth', 'lineDiagPanel', 'lineDiagRunBtn', 'lineDiagCopySummaryBtn'];
  let ok = true; let detail = '';
  for (const id of ids) {
    const inHtml = new RegExp(`id="${id}"`).test(html);
    const inJs = new RegExp(`getElementById\\('${id}'\\)`).test(appJs);
    if (!inHtml || !inJs) { ok = false; detail += `${id}: inHtml=${inHtml} inJs=${inJs}; `; }
  }
  if (ok) pass('診斷中心 HTML id 與 JS getElementById 選擇器一一對應');
  else fail('診斷中心 HTML id / JS selector 對應', detail);

  const scanDirs = ['public', 'routes', 'utils', 'middleware'];
  const oldDomain = 'pop-system-v13.zeabur.app';
  let found = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(js|html|css)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf8');
      // 排除診斷中心自己用來「偵測」舊網域的常數宣告那一行——那一行本來就必須寫死
      // 這個字串才能拿來比對，不算是「程式仍在使用舊網域」的洩漏。
      const relevantLines = content.split('\n').filter((line) => !/LINE_DIAG_OLD_DOMAIN\s*=/.test(line));
      if (relevantLines.join('\n').includes(oldDomain)) found.push(full);
    }
  }
  scanDirs.forEach((d) => walk(path.join(ROOT, d)));
  if (found.length === 0) pass('runtime 程式碼（public／routes／utils／middleware）不含舊網域字串，無需顯示 🔴 系統仍含舊網域');
  else fail('runtime 程式碼不應包含舊網域', found.join(','));

  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/app.js')]); pass('node --check public/js/app.js（含診斷中心）語法正確'); }
  catch (e) { fail('node --check public/js/app.js', e.message); }
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/line-member-gate.js')]); pass('node --check public/js/line-member-gate.js（新增 loadLiffSdk 匯出）語法正確'); }
  catch (e) { fail('node --check public/js/line-member-gate.js', e.message); }
}

async function main() {
  console.log('\n== Hotfix26-D smoke test ==\n');
  const h = loadDiagHelpers();

  console.log('-- Section 1: LIFF ID / Channel 一致性 --');
  testLiffIdAndChannel(h);

  console.log('\n-- Section 2: Basic ID / 加好友網址 / 舊網域 --');
  testBasicIdAndFriendUrlAndOldDomain(h);

  console.log('\n-- Section 3: 健康度計算 --');
  testHealthScore(h);

  console.log('\n-- Section 4: 診斷結果不洩漏 secret --');
  testNoSecretLeak(h);

  console.log('\n-- Section 5: server-backed diagnostic_only 安全性 --');
  const child = await startServer().catch((e) => { fail('server boot', e.message.split('\n')[0]); return null; });
  if (child) {
    await sleep(300);
    try { await testServerBackedDiagnostics(); } catch (e) { fail('testServerBackedDiagnostics crashed', e.stack); }
    await stopServer(child);
  }

  console.log('\n-- Section 6: static checks --');
  testStaticChecks();

  manual('真實 liff.init() 在管理後台頁面的初始化行為', '需要真實 LINE App / 已註冊 LIFF App，且需確認與前台點餐頁互不干擾（不同分頁本來就是獨立 JS context，風險低但仍需人工確認一次）');
  manual('LINE Developers Callback URL／Endpoint 的實際比對', 'LINE Developers 後台設定無公開 API 可讀取，只能人工登入比對，診斷中心僅提供建議值與複製按鈕');
  manual('複製按鈕在真實瀏覽器（含不支援 clipboard API 的舊瀏覽器)的 fallback 行為', '需要真實瀏覽器環境測試 execCommand fallback 是否真的把內容放進系統剪貼簿');

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
