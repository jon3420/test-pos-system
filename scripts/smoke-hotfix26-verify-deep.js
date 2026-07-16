#!/usr/bin/env node
// scripts/smoke-hotfix26-verify-deep.js — LINE Verify API 深度診斷 smoke test
//
// 執行方式：
//   node scripts/smoke-hotfix26-verify-deep.js
//
// 範圍：驗證 utils/lineMemberAuth.js 新增的深度 debug 能力：
//   - classifyVerifyApiFailure() 對各種 HTTP status / error / error_description 的分類
//   - buildVerifyDebugObject() 的 request/response/audience/expiry/claims 結構、
//     raw body／非 JSON 內容保留
//   - LINE_MEMBER_DEBUG 環境變數確實控制 debug 資訊是否輸出（用真實的
//     verifyLineIdToken() 呼叫——這個 sandbox 網路白名單本來就不含 api.line.me，
//     所以呼叫一定會落到 exception 分支，剛好可以用來做「debug 開關」的
//     真實端到端驗證，不需要額外注入 fetch mock）

'use strict';
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const auth = require(path.join(ROOT, 'utils/lineMemberAuth'));

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function manual(name, reason) { results.push({ name, status: 'MANUAL REQUIRED', detail: reason }); console.log(`[MANUAL REQUIRED] ${name} — ${reason}`); }

// ════════════════════════════════════════════════════════════════
// 1. classifyVerifyApiFailure：HTTP 200/400/401/429/500 × 各種 error/error_description
// ════════════════════════════════════════════════════════════════
function testClassifyHttpStatuses() {
  // 200 但沒有合法 body（理論上不會發生，但防禦性測試：不當機、有分類）
  const c200 = auth.classifyVerifyApiFailure(true, 200, null);
  if (c200.code) pass('HTTP 200 + 無法解析 body：仍安全回傳分類（防禦性案例）');
  else fail('HTTP 200 + 無法解析 body 應有分類', JSON.stringify(c200));

  const c400invalidRequest = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_request', error_description: 'The id_token is invalid.' });
  if (c400invalidRequest.code === 'INVALID_ID_TOKEN') pass('HTTP 400 invalid_request → INVALID_ID_TOKEN');
  else fail('HTTP 400 invalid_request 分類錯誤', JSON.stringify(c400invalidRequest));

  const c400invalidClient = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_client', error_description: 'client_id is invalid' });
  if (c400invalidClient.code === 'INVALID_ID_TOKEN_AUDIENCE') pass('HTTP 400 invalid_client（含 client_id 字樣）→ INVALID_ID_TOKEN_AUDIENCE');
  else fail('HTTP 400 invalid_client 分類錯誤', JSON.stringify(c400invalidClient));

  const c400invalidGrant = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_grant', error_description: 'ID token is expired' });
  if (c400invalidGrant.code === 'EXPIRED_ID_TOKEN') pass('HTTP 400 invalid_grant（過期）→ EXPIRED_ID_TOKEN');
  else fail('HTTP 400 invalid_grant 過期分類錯誤', JSON.stringify(c400invalidGrant));

  const c400audience = auth.classifyVerifyApiFailure(false, 400, { error: 'invalid_request', error_description: 'audience mismatch' });
  if (c400audience.code === 'INVALID_ID_TOKEN_AUDIENCE') pass('HTTP 400 audience mismatch → INVALID_ID_TOKEN_AUDIENCE');
  else fail('HTTP 400 audience mismatch 分類錯誤', JSON.stringify(c400audience));

  const c401 = auth.classifyVerifyApiFailure(false, 401, { error: 'invalid_client', error_description: 'unauthorized' });
  if (c401.code) pass('HTTP 401 → 有分類（' + c401.code + '）');
  else fail('HTTP 401 應有分類', JSON.stringify(c401));

  const c429 = auth.classifyVerifyApiFailure(false, 429, { error: 'rate_limited', error_description: 'too many requests' });
  if (c429.code) pass('HTTP 429 → 有分類、不當機（' + c429.code + '）');
  else fail('HTTP 429 應有分類', JSON.stringify(c429));

  const c500 = auth.classifyVerifyApiFailure(false, 500, null);
  if (c500.code === 'LINE_VERIFY_API_FAILED') pass('HTTP 500 → LINE_VERIFY_API_FAILED');
  else fail('HTTP 500 分類錯誤', JSON.stringify(c500));
}

// ════════════════════════════════════════════════════════════════
// 2. 非 JSON Response / rawBody 保留
// ════════════════════════════════════════════════════════════════
function testNonJsonAndRawBodyPreserved() {
  const fakeRes = { status: 502, headers: { entries: () => [['content-type', 'text/html']][Symbol.iterator]() } };
  const rawBody = '<html><body>502 Bad Gateway</body></html>';
  let parsed = null; let jsonParsed = false;
  try { parsed = JSON.parse(rawBody); jsonParsed = true; } catch (e) { parsed = null; jsonParsed = false; }
  const dbg = auth.buildVerifyDebugObject({
    channelId: '2010721031', idToken: 'x'.repeat(500), endpoint: 'https://api.line.me/oauth2/v2.1/verify',
    res: fakeRes, rawBody, data: parsed, jsonParsed, elapsedMs: 123, code: 'LINE_VERIFY_API_FAILED',
  });
  if (dbg.response.raw_body === rawBody) pass('非 JSON Response：raw_body 完整保留原始文字（不會因為 JSON.parse 失敗而遺失）');
  else fail('raw_body 應完整保留', dbg.response.raw_body);
  if (dbg.response.json_parsed === false && dbg.response.parsed === null) pass('非 JSON Response：json_parsed=false 且 parsed=null，分類邏輯不會誤用垃圾資料');
  else fail('非 JSON Response 應標記 json_parsed=false', JSON.stringify(dbg.response));
  if (dbg.response.http_status === 502) pass('非 JSON Response：仍正確記錄 HTTP status（502）');
  else fail('HTTP status 應為 502', dbg.response.http_status);
}

// ════════════════════════════════════════════════════════════════
// 3. buildVerifyDebugObject：audience_check（trim 前/後證明，不自動套用）／
//    expiry_check／claims（sub 遮罩）
// ════════════════════════════════════════════════════════════════
function testDebugObjectStructure() {
  const fakeRes = { status: 200, headers: { entries: () => [['content-type', 'application/json']][Symbol.iterator]() } };
  const nowSec = Math.floor(Date.now() / 1000);
  const data = {
    iss: 'https://access.line.me', sub: 'U1234567890abcdef1234567890abcdef', aud: '2010721031',
    exp: nowSec + 500, nonce: 'test-nonce-abc', amr: ['pwd'], name: 'Test User',
  };
  const rawBody = JSON.stringify(data);
  const dbg = auth.buildVerifyDebugObject({
    channelId: '2010721031 ', // 尾端刻意帶一個空白，模擬根因假說一
    idToken: 'y'.repeat(800), endpoint: 'https://api.line.me/oauth2/v2.1/verify',
    res: fakeRes, rawBody, data, jsonParsed: true, elapsedMs: 88, code: null,
  });

  // request：只有 present/length，不含 token 內容
  if (dbg.request.id_token_length === 800 && !('id_token' in dbg.request)) {
    pass('debug.request：只含 id_token_length（800），不含 id_token 本體內容');
  } else {
    fail('debug.request 不應含 token 內容', JSON.stringify(dbg.request));
  }

  // audience_check：trim 前後證明，但不影響 match_raw（因為 channelId 帶空白，aud 是乾淨的 "2010721031"）
  if (dbg.audience_check.db_channel_id_before_trim === '2010721031 ' && dbg.audience_check.db_channel_id_before_trim_length === 11) {
    pass('audience_check：trim 前的原始值與長度正確保留（重現「Channel ID 設定值含空白」情境）');
  } else {
    fail('audience_check trim 前應正確', JSON.stringify(dbg.audience_check));
  }
  if (dbg.audience_check.db_channel_id_after_trim === '2010721031' && dbg.audience_check.db_channel_id_after_trim_length === 10) {
    pass('audience_check：trim 後的值與長度正確（僅供人工判讀）');
  } else {
    fail('audience_check trim 後應正確', JSON.stringify(dbg.audience_check));
  }
  if (dbg.audience_check.match_raw === false && dbg.audience_check.match_if_trimmed_proof_only === true) {
    pass('audience_check：未 trim 時比對「不一致」（match_raw=false），trim 後比對「一致」（match_if_trimmed_proof_only=true）——證明空白字元正是問題所在，且證明過程不影響真正的判斷邏輯（本輪未加 trim()）');
  } else {
    fail('audience_check 應能證明 trim 前後比對結果不同', JSON.stringify(dbg.audience_check));
  }

  // expiry_check
  if (dbg.expiry_check.exp === data.exp && dbg.expiry_check.remaining_seconds > 0 && dbg.expiry_check.is_expired === false) {
    pass('expiry_check：exp／remaining_seconds／is_expired 正確計算（未過期）');
  } else {
    fail('expiry_check 計算錯誤', JSON.stringify(dbg.expiry_check));
  }

  // claims：sub 必須遮罩，不能是完整原始值
  if (dbg.claims.sub_masked && dbg.claims.sub_masked !== data.sub && !dbg.claims.sub_masked.includes(data.sub)) {
    pass('claims：sub 一律用 maskLineUserId() 遮罩，不會輸出完整 LINE User ID');
  } else {
    fail('claims.sub_masked 不應等於原始完整 sub', JSON.stringify(dbg.claims));
  }
  if (dbg.claims.iss === data.iss && dbg.claims.aud === data.aud && dbg.claims.nonce === data.nonce && JSON.stringify(dbg.claims.amr) === JSON.stringify(data.amr)) {
    pass('claims：iss／aud／nonce／amr 完整列出（這些本來就是 LINE 直接回傳給我方的非機密欄位）');
  } else {
    fail('claims iss/aud/nonce/amr 應完整列出', JSON.stringify(dbg.claims));
  }

  // response：elapsed_ms／headers 存在
  if (dbg.response.elapsed_ms === 88 && dbg.response.headers && dbg.response.headers['content-type'] === 'application/json') {
    pass('response：elapsed_ms（LINE Response Time）與 headers 正確帶出');
  } else {
    fail('response elapsed_ms/headers 應正確', JSON.stringify(dbg.response));
  }
}

// ════════════════════════════════════════════════════════════════
// 4. LINE_MEMBER_DEBUG 開關：用真實 verifyLineIdToken()（會因 sandbox 無法連線
//    到 api.line.me 而落入 exception 分支，藉此驗證「關閉時完全不輸出、
//    開啟時輸出但不含 stack」）
// ════════════════════════════════════════════════════════════════
async function testDebugToggleWithRealException() {
  delete process.env.LINE_MEMBER_DEBUG;
  const r1 = await auth.verifyLineIdToken('fake-token-for-smoke-test', 'test-channel-id-debug-off');
  if (r1.ok === false && !('debug' in r1)) {
    pass('LINE_MEMBER_DEBUG 未設定：verifyLineIdToken 失敗回應完全不含 debug 欄位');
  } else {
    fail('LINE_MEMBER_DEBUG 未設定時不應含 debug 欄位', JSON.stringify(Object.keys(r1)));
  }

  process.env.LINE_MEMBER_DEBUG = '1';
  const r2 = await auth.verifyLineIdToken('fake-token-for-smoke-test', 'test-channel-id-debug-on');
  delete process.env.LINE_MEMBER_DEBUG;

  // 這個 sandbox 對 api.line.me 的網路白名單是用「回一個 HTTP 403 拒絕頁」實作
  // 的（不是丟 JS exception），所以這裡實際會走到 verify_failed 分支，而不是
  // catch(e) 的 exception 分支——這件事本身也是一個真實證據：至少在本
  // sandbox 環境，對外部網域的存取限制不是靠丟例外擋下來的。兩種分支都要能
  // 正確處理，所以這裡用 reason 判斷實際落在哪一支，分別驗證。
  console.log(`  [info] 本次真實呼叫落在 reason="${r2.reason}"（sandbox 環境網路限制的實際行為，見上方 log 的 raw_body）`);

  if (r2.ok === false && r2.debug) {
    pass('LINE_MEMBER_DEBUG=1：verifyLineIdToken 失敗回應含 debug 欄位（不論落在 verify_failed 或 exception 分支）');
  } else {
    fail('LINE_MEMBER_DEBUG=1 應含 debug 欄位', JSON.stringify(r2));
  }

  if (r2.reason === 'exception') {
    if (r2.debug.exception && !('stack' in r2.debug.exception)) {
      pass('（exception 分支）debug.exception 存在且不含 stack trace 屬性');
    } else {
      fail('（exception 分支）debug.exception 結構不符預期', JSON.stringify(r2.debug));
    }
  } else {
    if (r2.debug.response && r2.debug.classification) {
      pass('（verify_failed 分支）debug.response／debug.classification 存在（HTTP status／raw_body／分類 code 皆完整保留）');
    } else {
      fail('（verify_failed 分支）debug 結構不符預期', JSON.stringify(r2.debug));
    }
  }

  const debugJson = JSON.stringify(r2.debug);
  const looksLikeStackTrace = /\.js:\d+:\d+/.test(debugJson) || /at\s+\S+\s+\(/.test(debugJson);
  if (!looksLikeStackTrace) {
    pass('LINE_MEMBER_DEBUG=1：回傳值裡的 debug 物件（不論哪個分支）都不含任何 stack trace 樣式的內容');
  } else {
    fail('debug 物件不應包含 stack trace 樣式內容', debugJson.slice(0, 300));
  }

  // 核心不變量：debug 開關本身不能改變既有 ok/reason/code/message 的判斷結果
  // ——兩次呼叫用不同的 channelId（debug-off/debug-on）純粹是為了在 log 裡
  // 分辨是哪一次呼叫，不影響這裡比較的欄位（兩次都是同一組垃圾 token，
  // 且都會被同一個 sandbox 網路限制擋下，理論上分類結果應該相同）。
  if (r1.reason === r2.reason && r1.code === r2.code && r1.message === r2.message) {
    pass('LINE_MEMBER_DEBUG 開／關不影響既有 ok/reason/code/message 判斷結果，只差在多一個 debug 欄位');
  } else {
    fail('debug 開關不應改變既有欄位行為', JSON.stringify({ r1: { reason: r1.reason, code: r1.code, message: r1.message }, r2: { reason: r2.reason, code: r2.code, message: r2.message } }));
  }
}

// ════════════════════════════════════════════════════════════════
// 5. classifyVerifyException：timeout / 其他 fetch 例外
// ════════════════════════════════════════════════════════════════
function testExceptionClassification() {
  const timeoutErr = Object.assign(new Error('network timeout'), { type: 'request-timeout', name: 'FetchError' });
  const c1 = auth.classifyVerifyException(timeoutErr);
  if (c1.code === 'NETWORK_TIMEOUT') pass('classifyVerifyException：node-fetch timeout → NETWORK_TIMEOUT');
  else fail('timeout 分類錯誤', JSON.stringify(c1));

  const dnsErr = new Error('getaddrinfo ENOTFOUND api.line.me');
  const c2 = auth.classifyVerifyException(dnsErr);
  if (c2.code === 'UNKNOWN_VERIFY_ERROR') pass('classifyVerifyException：DNS 類型錯誤 → UNKNOWN_VERIFY_ERROR（未過度分類）');
  else fail('DNS 錯誤分類錯誤', JSON.stringify(c2));

  const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
  const c3 = auth.classifyVerifyException(abortErr);
  if (c3.code === 'NETWORK_TIMEOUT') pass('classifyVerifyException：AbortError → NETWORK_TIMEOUT');
  else fail('AbortError 分類錯誤', JSON.stringify(c3));
}

// ════════════════════════════════════════════════════════════════
// 6. 靜態檢查
// ════════════════════════════════════════════════════════════════
function testStaticChecks() {
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'utils/lineMemberAuth.js')]); pass('node --check utils/lineMemberAuth.js 語法正確'); }
  catch (e) { fail('node --check utils/lineMemberAuth.js', e.message); }
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'routes/line-member.js')]); pass('node --check routes/line-member.js 語法正確'); }
  catch (e) { fail('node --check routes/line-member.js', e.message); }
  try { execFileSync(process.execPath, ['--check', path.join(ROOT, 'public/js/app.js')]); pass('node --check public/js/app.js（含 Verify Debug UI）語法正確'); }
  catch (e) { fail('node --check public/js/app.js', e.message); }
}

// ════════════════════════════════════════════════════════════════
// 7. 回歸：確保沒有改變既有 smoke test 結果
// ════════════════════════════════════════════════════════════════
function runOtherSmoke(scriptName) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', scriptName)], { cwd: ROOT, timeout: 150000 }).toString();
    const m = out.match(/PASS[:=]\s*(\d+)\s*FAIL[:=]\s*(\d+)/i) || out.match(/PASS:\s*(\d+)\s+FAIL:\s*(\d+)/i);
    if (m) return { ok: Number(m[2]) === 0, passCount: Number(m[1]), failCount: Number(m[2]) };
    return { ok: /FAIL:\s*0|FAIL=0/i.test(out) };
  } catch (e) {
    return { ok: false, error: (e.stdout ? e.stdout.toString().slice(-800) : e.message) };
  }
}
function testRegressions() {
  for (const script of ['smoke-hotfix25.js', 'smoke-hotfix26-a.js', 'smoke-hotfix26-b.js', 'smoke-hotfix26-c.js', 'smoke-hotfix26-d.js', 'smoke-hotfix26-verify-debug.js']) {
    const r = runOtherSmoke(script);
    if (r.ok) pass(`回歸測試 ${script} FAIL=0${r.passCount != null ? '（PASS=' + r.passCount + '）' : ''}`);
    else fail(`回歸測試 ${script} 應為 FAIL=0`, JSON.stringify(r).slice(0, 400));
  }
}

async function main() {
  console.log('\n== Hotfix26-Verify-Deep smoke test ==\n');

  console.log('-- Section 1: classifyVerifyApiFailure（HTTP 200/400/401/429/500 × error 分類）--');
  testClassifyHttpStatuses();

  console.log('\n-- Section 2: 非 JSON Response / rawBody 保留 --');
  testNonJsonAndRawBodyPreserved();

  console.log('\n-- Section 3: buildVerifyDebugObject 結構（audience/expiry/claims）--');
  testDebugObjectStructure();

  console.log('\n-- Section 4: LINE_MEMBER_DEBUG 開關（真實例外路徑）--');
  await testDebugToggleWithRealException();

  console.log('\n-- Section 5: classifyVerifyException（timeout／fetch 例外）--');
  testExceptionClassification();

  console.log('\n-- Section 6: 靜態檢查 --');
  testStaticChecks();

  console.log('\n-- Section 7: 回歸測試 --');
  testRegressions();

  manual('真實呼叫 https://api.line.me/oauth2/v2.1/verify 取得的實際 HTTP status／error/error_description', '此 sandbox 網路白名單不含 api.line.me（本輪禁止新增可注入的網路測試點），需在實際部署環境用真實 id_token 執行 LINE_MEMBER_DEBUG=1 並查看伺服器 console log 或診斷中心 Verify Debug 區塊');
  manual('確認 store_001 目前 Channel ID 設定值透過本工具實際印出的 trim 前/後長度是否不同', '需要在正式環境設定 LINE_MEMBER_DEBUG=1 後，用真實登入或診斷中心觸發一次，直接讀取 debug.audience_check 的實際數字');

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
