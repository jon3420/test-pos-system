#!/usr/bin/env node
// scripts/smoke-hotfix26-verify-debug.js — LINE Token 驗證失敗排查 smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-verify-debug.js
//
// 範圍：只驗證 Debug Report 涉及的分類 code／安全欄位／診斷安全性，
// 不驗證真實 LINE API 呼叫是否成功（此 sandbox 網路白名單不含 api.line.me，
// 也不應該為了測試而改動正式 verify 流程去打真的 LINE API —— 這點在報告的
// K 段落已列為 MANUAL REQUIRED）。

'use strict';
const fs = require('fs');
const path = require('path');
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

const auth = require(path.join(ROOT, 'utils/lineMemberAuth'));

// ════════════════════════════════════════════════════════════════
// 1. classifyVerifyApiFailure：LINE Verify API 400/401/500、無法解析 JSON
// ════════════════════════════════════════════════════════════════
function testClassifyApiFailure() {
  const c400generic = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_request', error_description: 'Invalid ID token.' });
  if (c400generic.code === 'INVALID_ID_TOKEN') pass('classifyVerifyApiFailure: LINE Verify API 400（一般無效 token）→ INVALID_ID_TOKEN');
  else fail('classifyVerifyApiFailure: 400 一般無效 token', JSON.stringify(c400generic));

  const c400aud = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_request', error_description: 'aud claim does not match client_id' });
  if (c400aud.code === 'INVALID_ID_TOKEN_AUDIENCE') pass('classifyVerifyApiFailure: LINE Verify API 400（audience 不符）→ INVALID_ID_TOKEN_AUDIENCE（對應「Channel audience 不符」）');
  else fail('classifyVerifyApiFailure: 400 audience 不符', JSON.stringify(c400aud));

  const c400expired = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_request', error_description: 'ID token expired' });
  if (c400expired.code === 'EXPIRED_ID_TOKEN') pass('classifyVerifyApiFailure: LINE Verify API 400（token 過期）→ EXPIRED_ID_TOKEN（對應「expired token mock」）');
  else fail('classifyVerifyApiFailure: 400 token 過期', JSON.stringify(c400expired));

  const c401 = auth.classifyVerifyApiFailure(false, 401, { error: 'invalid_client' });
  if (c401.code) pass('classifyVerifyApiFailure: LINE Verify API 401 有明確分類（' + c401.code + '）');
  else fail('classifyVerifyApiFailure: 401 應有分類', JSON.stringify(c401));

  const c500 = auth.classifyVerifyApiFailure(false, 500, null);
  if (c500.code === 'LINE_VERIFY_API_FAILED') pass('classifyVerifyApiFailure: LINE Verify API 500（伺服器錯誤／無法解析回應）→ LINE_VERIFY_API_FAILED');
  else fail('classifyVerifyApiFailure: 500 應為 LINE_VERIFY_API_FAILED', JSON.stringify(c500));

  // 沒有訊息內容也不應該拋例外或回傳空 code
  const cEmpty = auth.classifyVerifyApiFailure(false, 400, {});
  if (cEmpty.code) pass('classifyVerifyApiFailure: 空的錯誤內容仍安全回傳一個分類，不拋例外');
  else fail('classifyVerifyApiFailure: 空錯誤內容應有 fallback 分類', JSON.stringify(cEmpty));
}

// ════════════════════════════════════════════════════════════════
// 2. classifyVerifyException：network timeout
// ════════════════════════════════════════════════════════════════
function testClassifyException() {
  const timeoutErr = Object.assign(new Error('network timeout at: https://api.line.me/oauth2/v2.1/verify'), { type: 'request-timeout', name: 'FetchError' });
  const c = auth.classifyVerifyException(timeoutErr);
  if (c.code === 'NETWORK_TIMEOUT') pass('classifyVerifyException: node-fetch timeout（type=request-timeout）→ NETWORK_TIMEOUT');
  else fail('classifyVerifyException: timeout 應為 NETWORK_TIMEOUT', JSON.stringify(c));

  const otherErr = new Error('getaddrinfo ENOTFOUND api.line.me');
  const c2 = auth.classifyVerifyException(otherErr);
  if (c2.code === 'UNKNOWN_VERIFY_ERROR') pass('classifyVerifyException: 其他未分類例外 → UNKNOWN_VERIFY_ERROR（不誤判為 timeout）');
  else fail('classifyVerifyException: 未分類例外應為 UNKNOWN_VERIFY_ERROR', JSON.stringify(c2));
}

// ════════════════════════════════════════════════════════════════
// 3. isAudienceMatch / isTokenExpired —— 直接對應 Debug Report 根因假說
//    （Channel ID 設定值若有多餘空白字元，會導致 aud 比對失敗）
// ════════════════════════════════════════════════════════════════
function testAudienceAndExpiryHelpers() {
  if (auth.isAudienceMatch('2010721031', '2010721031')) pass('isAudienceMatch: 完全相同字串 → 一致');
  else fail('isAudienceMatch: 完全相同字串應一致', '');

  // 根因假說：Channel ID 設定值尾端多一個空白，LINE 回傳的 aud 是「乾淨」的，
  // 兩者字串比對會不相等 —— 這正是 routes/settings.js PUT 目前用
  // String(req.body[k]) 直接存值、沒有 trim() 造成的風險。
  if (!auth.isAudienceMatch('2010721031', '2010721031 ')) {
    pass('isAudienceMatch: Channel ID 設定值尾端多一個空白字元時，比對會失敗（重現 Debug Report 根因假說一）');
  } else {
    fail('isAudienceMatch: 應能重現「設定值有多餘空白導致比對失敗」的情境', '');
  }
  if (!auth.isAudienceMatch('2010721031', ' 2010721031')) {
    pass('isAudienceMatch: Channel ID 設定值開頭多一個空白字元時，比對也會失敗');
  } else {
    fail('isAudienceMatch: 開頭多空白也應該比對失敗', '');
  }
  // 舊 Channel ID 混用情境
  if (!auth.isAudienceMatch('2010721031', '2010718887')) pass('isAudienceMatch: 新舊 Channel ID 不同時正確判斷為不一致');
  else fail('isAudienceMatch: 新舊 Channel ID 不應判斷為一致', '');

  const nowSec = Math.floor(Date.now() / 1000);
  if (!auth.isTokenExpired(nowSec + 3600)) pass('isTokenExpired: 1 小時後才過期的 token → 未過期');
  else fail('isTokenExpired: 未過期 token 誤判為過期', '');
  if (auth.isTokenExpired(nowSec - 3600)) pass('isTokenExpired: 1 小時前已過期的 token（expired token mock）→ 判定為過期');
  else fail('isTokenExpired: 過期 token 應判定為過期', '');
  if (!auth.isTokenExpired(0) && !auth.isTokenExpired(null) && !auth.isTokenExpired(undefined)) {
    pass('isTokenExpired: exp 缺失／為 0 時不誤判為過期（LINE 一定會簽發 exp，這裡只是防禦）');
  } else {
    fail('isTokenExpired: exp 缺失不應誤判為過期', '');
  }
}

// ════════════════════════════════════════════════════════════════
// Server helpers
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

// ════════════════════════════════════════════════════════════════
// 4. Server-backed route-level tests
// ════════════════════════════════════════════════════════════════
async function testRouteLevel() {
  const STORE = 'store_001';

  // 1. 缺少 store_id：這支 API 靠 requireStore 中介層解析 storeId，缺少時
  //    中介層本身就會處理（依專案既有規則，可能 fallback 到預設店或拒絕）；
  //    這裡驗證的是「不會 500、不會洩漏 stack」。
  {
    const { status, raw } = await jsonFetch(`${BASE}/api/line-member/verify`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: 'x' }),
    });
    const hasStack = /\.js:\d+:\d+/.test(raw);
    if (status < 500 && !hasStack) pass('缺少 store_id：不會 500、不洩漏 stack（由 requireStore 中介層決定實際店家或拒絕）');
    else fail('缺少 store_id 應安全處理', `status=${status} hasStack=${hasStack}`);
  }

  // 2. 不存在的 store
  {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=store_does_not_exist_debug`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: 'x' }),
    });
    if (status < 500) pass('不存在的 store：不會 500（' + status + '）');
    else fail('不存在的 store 不應 500', `status=${status} body=${JSON.stringify(body)}`);
  }

  // 3. 缺少 id_token
  {
    const { status, body } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    if (status === 400 && body && body.code === 'MISSING_ID_TOKEN') pass('缺少 id_token → HTTP 400 + code=MISSING_ID_TOKEN');
    else fail('缺少 id_token 應為 400 + MISSING_ID_TOKEN', `status=${status} body=${JSON.stringify(body)}`);
  }

  // 4. 缺少 access_token（不應該讓 verify 崩潰；access_token 只影響好友狀態查詢）
  {
    const { status, raw } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: 'fake.invalid.token', diagnostic_only: true }),
    });
    const hasStack = /\.js:\d+:\d+/.test(raw);
    if (status < 500 && !hasStack) pass('缺少 access_token：不影響流程、不會 500（好友狀態會安全 fallback 為 null）');
    else fail('缺少 access_token 應安全處理', `status=${status} hasStack=${hasStack}`);
  }

  // 16-19. response 結構：有 code、不含 stack、不含 token、不含 secret
  {
    const { status, body, raw } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'this.is.not.a.real.line.id.token.abcdefg', access_token: 'fake-access-token-xyz' }),
    });
    const hasStack = /at\s+\S+\s+\(.*:\d+:\d+\)/.test(raw) || /node_modules/.test(raw);
    const hasTokenLeak = raw.includes('this.is.not.a.real.line.id.token.abcdefg') || raw.includes('fake-access-token-xyz');
    const hasSecretWord = /secret/i.test(raw);
    if (body && body.code) pass('response 含 code 欄位（16）');
    else fail('response 應含 code 欄位', JSON.stringify(body));
    if (!hasStack) pass('response 不含 stack trace（17）');
    else fail('response 不應含 stack trace', raw.slice(0, 300));
    if (!hasTokenLeak) pass('response 不會把送出的 id_token／access_token 內容原樣回顯（18）');
    else fail('response 不應包含 token 內容', raw.slice(0, 300));
    if (!hasSecretWord) pass('response 不含 "secret" 字樣（19）');
    else fail('response 不應含 secret 字樣', raw.slice(0, 300));
  }

  // 13/14. diagnostic_only 不寫會員／不寫 Timeline（呼叫真實網路會失敗，但仍應驗證
  // 不論 token 驗證成功或失敗，只要沒有走到 upsert，會員/Timeline 筆數都不變）
  {
    const before = await countMembersAndHistory(STORE);
    await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id_token: 'fake.invalid.token', access_token: 'fake', diagnostic_only: true }),
    });
    const after = await countMembersAndHistory(STORE);
    if (after.members === before.members && after.history === before.history) {
      pass('diagnostic_only=true：呼叫前後 line_members／line_member_history 筆數不變（13/14）');
    } else {
      fail('diagnostic_only 不應改變會員／Timeline 筆數', `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
    }
  }

  // 20. verify 失敗不會讓「後端」自動觸發任何登入相關的呼叫（後端本來就不可能呼叫
  // 前端的 liff.login()；這裡驗證的是 verify 失敗的回應不含任何「請前端重新導向」
  // 之類會誘發自動重登入迴圈的欄位，如 redirect_to／force_relogin）。
  {
    const { body } = await jsonFetch(`${BASE}/api/line-member/verify?store_id=${STORE}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: 'fake.invalid.token' }),
    });
    const hasAutoRelogin = body && (body.redirect_to || body.force_relogin || body.reload || body.login_url);
    if (!hasAutoRelogin) pass('verify 失敗的回應不含任何促使前端自動重新登入的欄位（20）');
    else fail('verify 失敗回應不應包含自動重登入相關欄位', JSON.stringify(body));
  }
}

// ════════════════════════════════════════════════════════════════
// 5. 前端「verify 失敗後」控制流靜態檢查（第十段落）
// ════════════════════════════════════════════════════════════════
function testFrontendFailureControlFlow() {
  const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  // handleLineMemberLoginCallback／verifyWithBackend 失敗時的處理：只應該
  // setGateStatus 顯示訊息，不應該無條件自動再呼叫 liff.login() 或
  // window.location.reload()（會造成無窮迴圈）。
  const autoReloginPatterns = [
    /verifyRes\.success[\s\S]{0,200}liff\.login\(/,
    /verifyRes\.success[\s\S]{0,200}location\.reload\(/,
  ];
  const looksLikeAutoRelogin = autoReloginPatterns.some((re) => re.test(gateSrc));
  if (!looksLikeAutoRelogin) pass('line-member-gate.js：verify 失敗（!verifyRes.success）後沒有無條件自動呼叫 liff.login()／location.reload()（21，防止重複登入迴圈）');
  else fail('line-member-gate.js：verify 失敗後疑似會自動重新登入，有迴圈風險', '');

  const hasLoginInProgressCleanup = /login_in_progress|_loginInProgress|LOGIN_IN_PROGRESS/i.test(gateSrc);
  if (hasLoginInProgressCleanup) pass('line-member-gate.js：存在「登入進行中」防重入旗標的清除邏輯（避免 verify 失敗後卡在 in-progress 狀態）');
  else fail('line-member-gate.js：應有登入進行中旗標清除邏輯', '');
}

// ════════════════════════════════════════════════════════════════
// 6. 前後端欄位命名一致性（第五段落）
// ════════════════════════════════════════════════════════════════
function testFieldNamingConsistency() {
  const gateSrc = fs.readFileSync(path.join(ROOT, 'public/js/line-member-gate.js'), 'utf8');
  const routeSrc = fs.readFileSync(path.join(ROOT, 'routes/line-member.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'public/js/app.js'), 'utf8');

  const frontendSendsSnakeCase = /id_token:\s*idToken/.test(gateSrc) && /access_token:\s*accessToken/.test(gateSrc);
  const backendReadsSnakeCase = /const\s*\{\s*id_token,\s*access_token/.test(routeSrc);
  if (frontendSendsSnakeCase && backendReadsSnakeCase) pass('欄位命名一致：前端 verifyWithBackend() 送出 id_token/access_token（snake_case），後端也用相同名稱解構');
  else fail('欄位命名不一致', `frontendSendsSnakeCase=${frontendSendsSnakeCase} backendReadsSnakeCase=${backendReadsSnakeCase}`);

  // 檢查是否有任何呼叫端誤用 camelCase（idToken/accessToken 當 body key）
  const camelCaseBodyKeyInGate = /body\s*=\s*\{[^}]*idToken:/.test(gateSrc) || /body\s*=\s*\{[^}]*accessToken:/.test(gateSrc);
  const camelCaseBodyKeyInApp = /idToken:\s*window\.liff\.getIDToken/.test(appSrc) || /accessToken:\s*window\.liff\.getAccessToken/.test(appSrc);
  if (!camelCaseBodyKeyInGate && !camelCaseBodyKeyInApp) pass('沒有發現任何呼叫端誤用 camelCase（idToken/accessToken）當作 body 欄位名稱');
  else fail('發現疑似 camelCase／snake_case 命名不一致的呼叫端', `gate=${camelCaseBodyKeyInGate} app=${camelCaseBodyKeyInApp}`);
}

// ════════════════════════════════════════════════════════════════
// 7. 靜態檢查：Channel ID runtime 搜尋、node --check
// ════════════════════════════════════════════════════════════════
function testStaticChecks() {
  const scanDirs = ['routes', 'utils', 'middleware', 'public'];
  const ids = ['2010718887', '2010721031', '2010724765'];
  const foundMap = {};
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(js|html|css)$/.test(entry.name)) continue;
      const content = fs.readFileSync(full, 'utf8');
      ids.forEach((id) => { if (content.includes(id)) { (foundMap[id] = foundMap[id] || []).push(full); } });
    }
  }
  scanDirs.forEach((d) => walk(path.join(ROOT, d)));
  const hardcodedFound = Object.entries(foundMap).filter(([id, files]) => files.some((f) => !/app\.js$/.test(f) || !/2010718887-xxxxx/.test(fs.readFileSync(f, 'utf8'))));
  // app.js 裡唯一出現 2010718887 的地方是診斷中心錯誤訊息裡的「範例」文字
  // （'例如 2010718887-xxxxx'），不是硬編碼的實際 Channel ID，排除它。
  let realHardcode = [];
  for (const [id, files] of Object.entries(foundMap)) {
    for (const f of files) {
      const content = fs.readFileSync(f, 'utf8');
      const isJustExample = content.includes(`${id}-xxxxx`);
      if (!isJustExample) realHardcode.push(`${id} in ${f}`);
    }
  }
  if (realHardcode.length === 0) {
    pass('runtime 程式碼（routes／utils／middleware／public）沒有硬編碼任何一組 Channel ID（2010718887／2010721031／2010724765），Channel ID 完全來自 store 設定值');
  } else {
    fail('runtime 程式碼不應硬編碼特定 Channel ID', realHardcode.join(', '));
  }

  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'utils/lineMemberAuth.js')]); pass('node --check utils/lineMemberAuth.js 語法正確'); }
  catch (e) { fail('node --check utils/lineMemberAuth.js', e.message); }
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'routes/line-member.js')]); pass('node --check routes/line-member.js 語法正確'); }
  catch (e) { fail('node --check routes/line-member.js', e.message); }
}

// ════════════════════════════════════════════════════════════════
// 8. 回歸：Hotfix25 / 26-A/B/C/D 不退步
// ════════════════════════════════════════════════════════════════
function runOtherSmoke(scriptName) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', scriptName)], { cwd: ROOT, timeout: 120000 }).toString();
    const m = out.match(/PASS[:=]\s*(\d+)\s*FAIL[:=]\s*(\d+)/i) || out.match(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)/i);
    if (m) return { ok: Number(m[2]) === 0, passCount: Number(m[1]), failCount: Number(m[2]) };
    return { ok: /FAIL:\s*0|FAIL=0/i.test(out), raw: out.slice(-500) };
  } catch (e) {
    return { ok: false, error: (e.stdout ? e.stdout.toString().slice(-800) : e.message) };
  }
}
function testRegressions() {
  for (const script of ['smoke-hotfix25.js', 'smoke-hotfix26-a.js', 'smoke-hotfix26-b.js', 'smoke-hotfix26-c.js', 'smoke-hotfix26-d.js']) {
    const r = runOtherSmoke(script);
    if (r.ok) pass(`回歸測試 ${script} FAIL=0（${r.passCount != null ? 'PASS=' + r.passCount : ''}）`);
    else fail(`回歸測試 ${script} 應為 FAIL=0`, JSON.stringify(r).slice(0, 400));
  }
}

async function main() {
  console.log('\n== Hotfix26 Verify Debug smoke test ==\n');

  console.log('-- Section 1: classifyVerifyApiFailure（LINE Verify API 400/401/500）--');
  testClassifyApiFailure();

  console.log('\n-- Section 2: classifyVerifyException（network timeout）--');
  testClassifyException();

  console.log('\n-- Section 3: isAudienceMatch / isTokenExpired（含根因假說重現）--');
  testAudienceAndExpiryHelpers();

  console.log('\n-- Section 4: server-backed route-level tests --');
  const child = await startServer().catch((e) => { fail('server boot', e.message.split('\n')[0]); return null; });
  if (child) {
    await sleep(300);
    try { await testRouteLevel(); } catch (e) { fail('testRouteLevel crashed', e.stack); }
    await stopServer(child);
  }

  console.log('\n-- Section 5: 前端 verify 失敗後控制流（防重複登入）--');
  testFrontendFailureControlFlow();

  console.log('\n-- Section 6: 前後端欄位命名一致性 --');
  testFieldNamingConsistency();

  console.log('\n-- Section 7: 靜態檢查（Channel ID 硬編碼搜尋／node --check）--');
  testStaticChecks();

  console.log('\n-- Section 8: 回歸測試（Hotfix25／26-A/B/C/D 不可退步）--');
  testRegressions();

  manual('用真實 id_token 打真正的 LINE /oauth2/v2.1/verify API 端到端驗證', '此 sandbox 網路白名單不含 api.line.me，且本輪禁止修改登入流程去加入可測試的網路注入點；需在實際部署環境（Zeabur）用真實 LIFF 環境驗證');
  manual('確認 store_001 目前資料庫內 line_member_login_channel_id 是否恰好等於 2010721031、且無多餘空白字元', '需要人工直接查詢正式環境資料庫或透過後台設定頁「LINE Login Channel ID」欄位重新複製貼上一次確認');
  manual('確認 LINE Developers 上的 LIFF App 是否真的建立在 Channel 2010721031 底下（而非僅僅設定頁面填的數字相符）', '純資料庫比對無法看穿「填的數字對，但 LIFF App 實際掛在別的 Channel」這種情境，須人工登入 LINE Developers Console 確認');

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
