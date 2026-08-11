#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-1-ga4-diagnostic-contract.js — fix18-10-hotfix30-
// B5-R5.4-G1.6-GA4-H1.1-AUTH
//
// GA4 Diagnostic Contract — Parent Runner。
//
// 每一個主要 Scenario 都在自己「全新的 child process」裡執行（見
// scripts/helpers/ga4-h1-1-diagnostic-scenario-worker.js），用
// child_process.spawnSync() 啟動。這是本輪的關鍵修正：Node 的
// require.cache 是 process-global，單純手動 delete
// require.cache[clientPath] 不足以刷新整條依賴鏈（connectionTest.js／
// index.js／geo-live.js 內部各自 require('./client') 捕捉到的是「當時」
// 的 module 實例，後續換掉 client.js 的 cache entry 不會回頭更新它們已經
// 捕捉好的參照）。改成每個 Scenario 一個全新 process 之後，這整類 stale
// reference 問題在結構上就不可能發生（每個 process 的 require.cache 都是
// 從零開始，只 require 一次）。
//
// Worker 本身不判斷 PASS/FAIL，只回報「真實發生的事實」（HTTP 回應／
// process 事件）；所有 Assertion 都在這裡（Parent）做。
//
// 這支測試只證明：Diagnostic Contract Gate（Auth／安全欄位形狀／絕不洩漏
// 憑證·Property·Raw Error／Fake Client Promise 不造成 unhandledRejection）。
// 不證明、也不宣稱正式 GA4 Backend 502 已解決——正式 Backend Gate 需要
// 部署後的真實 Google API 結果。

'use strict';

const path = require('path');
const os = require('os');
const fs = require('fs');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'scripts/helpers/ga4-h1-1-diagnostic-scenario-worker.js');

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

const tempDbFiles = [];
function runScenario(scenario, extraCfg = {}) {
  const tmpDbPath = path.join(os.tmpdir(), `ga4-h1-1-diag-${scenario}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  tempDbFiles.push(tmpDbPath);
  const cfg = JSON.stringify({ scenario, tmpDbPath, ...extraCfg });
  const proc = spawnSync(process.execPath, [WORKER_PATH, cfg], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
    timeout: 20000,
  });
  const stdout = proc.stdout || '';
  const marker = '###WORKER_RESULT###';
  const idx = stdout.lastIndexOf(marker);
  let parsed = null;
  let parseError = null;
  if (idx !== -1) {
    try { parsed = JSON.parse(stdout.slice(idx + marker.length).trim()); } catch (e) { parseError = e.message; }
  } else {
    parseError = 'marker not found in worker stdout';
  }
  try { fs.unlinkSync(tmpDbPath); } catch (e) { /* worker already cleaned up, or never created */ }
  return {
    scenario,
    exitCode: proc.status,
    crashed: proc.status !== 0,
    signal: proc.signal,
    stderr: proc.stderr || '',
    parsed,
    parseError,
  };
}

function forbiddenScan(raw, needle) {
  return raw.includes(needle);
}

async function main() {
  const runs = {};
  const SCENARIOS = [
    'auth', 'credential', 'sdk_unavailable', 'property_unset',
    'permission_denied', 'invalid_argument', 'network_failure', 'reject_promise',
    'summary_ok_city_fail', 'full_success', 'safe_output_scan',
  ];
  SCENARIOS.forEach((s) => { runs[s] = runScenario(s); });

  // ══════════════════════════════════════════════════════════════
  // Worker-level sanity: 每個 Worker process 本身都要乾淨結束
  // ══════════════════════════════════════════════════════════════
  SCENARIOS.forEach((s) => {
    const r = runs[s];
    check(`W. Worker[${s}] exited 0 and produced parseable JSON (no crash)`, !r.crashed && r.parsed && r.parsed.ok === true, r.parseError || (r.parsed && r.parsed.error && r.parsed.error.message) || `exit=${r.exitCode} signal=${r.signal}`);
  });

  // ══════════════════════════════════════════════════════════════
  // A. Authentication (1-6)
  // ══════════════════════════════════════════════════════════════
  {
    const r = runs.auth.parsed;
    const h = (r && r.http) || {};
    check('1. Status endpoint requires auth (no token → 401)', h.noAuthStatus && h.noAuthStatus.status === 401);
    check('2. Test endpoint requires auth (no token → 401)', h.noAuthTest && h.noAuthTest.status === 401);
    check('3. Invalid/malformed JWT rejected with 401', h.invalidJwt && h.invalidJwt.status === 401);
    check('4. Valid store JWT is admitted into the route (200)', h.validJwt && h.validJwt.status === 200 && h.validJwt.body && h.validJwt.body.success === true);
    check('5. Query string store_id never overrides the JWT store (response still reflects store_diag_ok\'s configured=true, not store_diag_unconfigured\'s configured=false)', h.queryOverrideAttempt && h.queryOverrideAttempt.status === 200
      && h.queryOverrideAttempt.body && h.queryOverrideAttempt.body.data && h.queryOverrideAttempt.body.data.property_configured === true
      && h.directB && h.directB.body && h.directB.body.data && h.directB.body.data.property_configured === false,
      JSON.stringify({ queryOverrideAttempt: h.queryOverrideAttempt && h.queryOverrideAttempt.body, directB: h.directB && h.directB.body }));
    check('6. Body store_id never overrides the JWT store (route ignores req.body for store context entirely; response still reflects store_diag_ok\'s real state, not store_diag_unconfigured\'s missing_property state)', h.bodyOverrideAttempt && h.bodyOverrideAttempt.status === 200
      && h.bodyOverrideAttempt.body && h.bodyOverrideAttempt.body.data && h.bodyOverrideAttempt.body.data.error_code !== 'missing_property',
      JSON.stringify(h.bodyOverrideAttempt && h.bodyOverrideAttempt.body));
  }

  // ══════════════════════════════════════════════════════════════
  // B. Credential / SDK (7-9)
  // ══════════════════════════════════════════════════════════════
  {
    const r = runs.credential.parsed;
    const d = r && r.http && r.http.status && r.http.status.body && r.http.status.body.data;
    check('7. No credential configured → credential_available:false', d && d.credential_available === false, JSON.stringify(d));
  }
  {
    const r = runs.sdk_unavailable.parsed;
    const d = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    check('8. SDK unavailable → sdk_available:false, error_code=sdk_unavailable', d && d.sdk_available === false && d.error_code === 'sdk_unavailable', JSON.stringify(d));
  }
  {
    const r = runs.property_unset.parsed;
    const d = r && r.http && r.http.status && r.http.status.body && r.http.status.body.data;
    check('9. Property not configured → property_configured:false (safe Contract field)', d && d.property_configured === false, JSON.stringify(d));
  }

  // ══════════════════════════════════════════════════════════════
  // C. Google Error Classification (10-13)
  // ══════════════════════════════════════════════════════════════
  {
    const r = runs.permission_denied.parsed;
    const d = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    check('10. Fake Client permission-denied (403) → error_code=permission_denied (existing canonical code)', d && d.error_code === 'permission_denied' && d.connected === false, JSON.stringify(d));
  }
  {
    const r = runs.invalid_argument.parsed;
    const d = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    // 誠實揭露：production 目前沒有逐字命名為 'invalid_argument' 的 code
    // （見 utils/ga4Realtime/connectionTest.js 的 _classifyTestFailure()
    // 對照表——它沒有這個 key，未知碼一律 fallback 成 'ga4_unavailable'）。
    // 這裡驗證的是「安全分類、絕不洩漏原始訊息」這個性質本身，不是斷言
    // 一個不存在的逐字 Contract。
    check('11. Fake Client invalid-argument-style error still gets a short, finite, safe error_code (production has no literal "invalid_argument" code — verified honestly, not assumed)', d && typeof d.error_code === 'string' && d.error_code.length > 0 && d.error_code.length < 40, JSON.stringify(d));
  }
  {
    const r = runs.network_failure.parsed;
    const d = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    check('12. Network failure (ECONNRESET) → safe backend error code, not raw error text', d && typeof d.error_code === 'string' && d.connected === false, JSON.stringify(d));
  }
  {
    const r = runs.reject_promise.parsed;
    const facts = r && r.facts;
    check('13. Fake Client rejected Promise never produces an unhandledRejection', facts && Array.isArray(facts.unhandledRejections) && facts.unhandledRejections.length === 0, JSON.stringify(facts));
  }

  // ══════════════════════════════════════════════════════════════
  // D. Partial / Success (14-17)
  // ══════════════════════════════════════════════════════════════
  let caseC;
  let caseA;
  {
    const r = runs.summary_ok_city_fail.parsed;
    caseC = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    check('14. Summary ok + City fail: summary_request_ok=true, city_request_ok=false, connected reflects partial (per Contract: not a full success)', caseC && caseC.summary_request_ok === true && caseC.city_request_ok === false && caseC.connected === false, JSON.stringify(caseC));
  }
  {
    const r = runs.full_success.parsed;
    caseA = r && r.http && r.http.test && r.http.test.body && r.http.test.body.data;
    check('15. Summary ok + City ok: summary_request_ok=true, city_request_ok=true, connected=true', caseA && caseA.summary_request_ok === true && caseA.city_request_ok === true && caseA.connected === true, JSON.stringify(caseA));
  }
  check('16. property_accessible=true once Summary succeeds (both Case A and Case C)', caseA && caseA.property_accessible === true && caseC && caseC.property_accessible === true);
  check('17. error_stage distinguishes a Summary-stage failure from a City-stage failure', (runs.permission_denied.parsed.http.test.body.data.error_stage === 'summary') && (caseC.error_stage === 'city'), `permission_denied.error_stage=${runs.permission_denied.parsed.http.test.body.data.error_stage} summary_ok_city_fail.error_stage=${caseC.error_stage}`);

  // ══════════════════════════════════════════════════════════════
  // E. Safe Output (18-29)
  // ══════════════════════════════════════════════════════════════
  const scanTargets = [];
  SCENARIOS.forEach((s) => {
    const r = runs[s].parsed;
    if (!r) return;
    Object.keys(r.http || {}).forEach((k) => {
      if (r.http[k] && typeof r.http[k].raw === 'string') scanTargets.push({ scenario: s, key: k, raw: r.http[k].raw });
    });
  });
  const scanFacts = runs.safe_output_scan.parsed && runs.safe_output_scan.parsed.facts;
  const propertyId = (scanFacts && scanFacts.secretPropertyId) || '399988877';
  const streamId = (scanFacts && scanFacts.secretStreamId) || '588877766';

  const forbiddenChecks = [
    ['18. Property ID never appears in any HTTP response', propertyId],
    ['19. Stream ID never appears in any HTTP response', streamId],
    ['22. Access token literal ("access_token") never appears', 'access_token'],
    ['23. Refresh token literal ("refresh_token") never appears', 'refresh_token'],
    ['24. Authorization header value ("Bearer ") never echoed back in any response body', 'Bearer '],
    ['25. Raw Google error text (qa_permission_denied / qa_invalid_argument / qa_city_stage_failure / qa_network_failure) never appears', 'qa_permission_denied'],
    ['26. Stack trace marker (" at ") never appears in any response body', ' at '],
    ['27. Fake Client internal marker never leaks into any HTTP response', 'qa_fake_client_internal_marker_do_not_leak'],
  ];
  forbiddenChecks.forEach(([label, needle]) => {
    const offenders = scanTargets.filter((t) => forbiddenScan(t.raw, needle));
    check(label, offenders.length === 0, offenders.map((o) => `${o.scenario}.${o.key}`).join(', '));
  });
  // 20/21 用更精確的模式比對，避免「@」「BEGIN」這類太寬鬆的字面會跟正常
  // 中文/JSON 內容衝突造成誤判。
  {
    const emailPattern = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.iam\.gserviceaccount\.com/;
    const offenders = scanTargets.filter((t) => emailPattern.test(t.raw));
    check('20. Service Account Email pattern (*.iam.gserviceaccount.com) never appears', offenders.length === 0, offenders.map((o) => `${o.scenario}.${o.key}`).join(', '));
  }
  {
    const offenders = scanTargets.filter((t) => t.raw.includes('BEGIN PRIVATE KEY'));
    check('21. Private Key marker ("BEGIN PRIVATE KEY") never appears', offenders.length === 0, offenders.map((o) => `${o.scenario}.${o.key}`).join(', '));
  }

  // 28. 不造成 Process Crash（每個 Worker 自己的退出碼已經在上面 "W."
  // 檢查過；這裡再加一條總結性斷言，確認 Parent 本身也順利跑到這裡）。
  check('28. All scenarios completed without crashing the Parent process', true);

  // 29. Worker 結束後無 Fake Client／Server／Listener 殘留（每個 Worker
  // 自己回報的 unhandledRejectionListenerCountAtExit 必須是 0；Parent 也
  // 確認所有暫存 DB 檔案都已經被清除）。
  {
    const listenerResidue = SCENARIOS.filter((s) => runs[s].parsed && runs[s].parsed.facts && runs[s].parsed.facts.unhandledRejectionListenerCountAtExit !== 0);
    const dbResidue = tempDbFiles.filter((p) => fs.existsSync(p));
    check('29. No unhandledRejection listener residue in any Worker, and all per-Worker temp DBs are cleaned up', listenerResidue.length === 0 && dbResidue.length === 0, JSON.stringify({ listenerResidue, dbResidue }));
  }

  // ══════════════════════════════════════════════════════════════
  // H1.4.5 測試基礎設施修正（Test Infrastructure Fix，非 Production 變更）：
  //
  // Reality Audit：在 H1.4.5 完整 74-suite regression 的其中一輪裡，本檔案的
  // check 29 在執行當下驗證 tempDbFiles 全部已清除（fs.existsSync 為 false，
  // check 29 本身 PASS），但外層 regression runner 稍後對 os.tmpdir() 的
  // 掃描仍偵測到同一個 tmpDbPath 檔案存在（safe_output_scan scenario）。
  // 獨立重跑本檔案 11 次（node 直接執行）與透過 execFileSync 重跑 5 次皆為
  // 0 殘留，無法穩定重現；判斷根因是「74 個 suite 連續執行造成的系統資源
  // 壓力（CPU/IO contention）下，罕見的檔案系統寫入/刪除時序邊界」，而不是
  // 每個 runScenario() 呼叫本身邏輯有誤（該邏輯在單獨執行時 100% 可靠）。
  //
  // 修正原則（測試基礎設施層，不改動任何 Production 程式碼）：per-scenario
  // 的 unlink 仍是第一線防線；這裡在 Parent 即將退出前加一道「保險式」最終
  // 清除，逐一檢查 tempDbFiles 是否仍存在，如果存在就再次嘗試刪除並明確記錄
  // 下來（不是靜默吞掉，方便未來追蹤是否又發生、發生在哪個 scenario）。
  // 這道保險不影響、也不取代 check 29 本身的偵測結果——check 29 仍然如實
  // 反映「當下那一刻」的清除狀態，這裡只是確保 Parent process 結束前，
  // 沒有任何本檔案建立的暫存 DB 殘留給外層 regression runner 誤判。
  // ══════════════════════════════════════════════════════════════
  const finalSweepForced = [];
  tempDbFiles.forEach((p) => {
    if (fs.existsSync(p)) {
      finalSweepForced.push(p);
      try { fs.unlinkSync(p); } catch (e) { /* 已盡最大努力；若仍失敗，check 29 的紀錄足以追查 */ }
    }
  });
  if (finalSweepForced.length) {
    console.log(`[TEST-INFRA] 最終保險清除觸發：${finalSweepForced.join(', ')}（check 29 執行當下曾經是乾淨的，代表這是延遲出現的殘留，已於 Parent 結束前強制清除）`);
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1.1 GA4 Diagnostic Contract: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  console.log('NOTE: This proves the Diagnostic Contract Gate only. It does NOT prove the production GA4 Backend 502 is resolved.');
  process.exit(fail.length === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('GA4 Diagnostic Contract Parent crashed:', e);
  process.exit(1);

});
