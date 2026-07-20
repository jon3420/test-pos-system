#!/usr/bin/env node
// scripts/regression-all.js — fix18-10-hotfix30
//
// Sequential, non-nested regression runner.
//
// 目的：取代過去每支 smoke test 自己在檔案結尾巢狀呼叫其他 smoke test 的
// 做法（cascade）。這裡由這支腳本從頭到尾依序、各執行一次下列腳本：
//   smoke-hotfix27-cd.js
//   smoke-hotfix28.js
//   smoke-hotfix29.js
//   smoke-hotfix29-b.js
//   smoke-hotfix29-c.js --self-only
//   smoke-hotfix30-direct-liff.js
//
// 要求（本檔案本身，不影響各腳本內部仍可能保留自己的舊版巢狀 cascade——
// 那是既有腳本自己的歷史行為，本檔案不修改任何 Production 或既有測試檔的
// 邏輯，只負責「從外面再跑一次、不重複疊加」）：
//   - 逐一（sequential）執行，不平行——平行執行會造成 SQLite data/pos.db
//     檔案 contention，導致假性失敗（Baseline Isolation 已驗證過這一點）。
//   - 每支只呼叫一次。
//   - 每支都有 timeout，逾時視為該腳本失敗，但仍會繼續跑下一支。
//   - 每支結束後清理 child process（execFileSync 本身是同步呼叫，逾時由
//     timeout 選項處理，process 會被 SIGTERM／SIGKILL 收掉，不會殘留）。
//   - 收集 stdout/stderr，解析每支腳本「自身測試部分」的 PASS/FAIL/MANUAL
//     （取檔案裡第一個 `PASS=N FAIL=N MANUAL=N` 那一行，也就是該腳本自己
//     的 summary，不是它內部舊版巢狀 cascade 疊加後的數字）。
//   - 最後輸出 TOTAL PASS／TOTAL FAIL／TOTAL MANUAL／HOTFIX30 REGRESSION FAIL。
'use strict';

const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

// 依序執行的腳本清單（含各自的額外參數）。
const SCRIPTS = [
  { file: 'smoke-hotfix27-cd.js', args: [], timeoutMs: 5 * 60 * 1000 },
  { file: 'smoke-hotfix28.js', args: [], timeoutMs: 5 * 60 * 1000 },
  { file: 'smoke-hotfix29.js', args: [], timeoutMs: 5 * 60 * 1000 },
  { file: 'smoke-hotfix29-b.js', args: [], timeoutMs: 5 * 60 * 1000 },
  // 需求：非巢狀——smoke-hotfix29-c.js 本身在檔案結尾會巢狀呼叫
  // hotfix27-cd／28／29／29-b（見該檔案），--self-only 讓它只跑自己的
  // 測試，交給這支 runner 統一、只執行一次每支腳本。
  { file: 'smoke-hotfix29-c.js', args: ['--self-only'], timeoutMs: 3 * 60 * 1000 },
  { file: 'smoke-hotfix30-direct-liff.js', args: [], timeoutMs: 3 * 60 * 1000 },
  // 風險驗證（requireMemberOnEntry／requireMemberBeforeCheckout 共用
  // showExternalBrowserLoginGuide()）新增的隔離測試——確保 Entry Login 與
  // Checkout Handoff 不會互相污染。
  { file: 'smoke-hotfix30-entry-checkout-isolation.js', args: [], timeoutMs: 60 * 1000 },
];

// 這支 runner 涵蓋的所有腳本裡，只有 hotfix30 相關的腳本才算「Hotfix30
// Regression」；其餘四支（27-cd／28／29／29-b）本身測的是更早的既有功能，
// 若失敗優先視為既有既存問題，不自動歸類成 Hotfix30 造成（除非確實查得
// 到成因是本版修改所致——這是人工 RCA 的結論，這支腳本只負責忠實列出
// 「哪些腳本失敗」，不代替 RCA 做判斷）。
const HOTFIX30_SCRIPTS = new Set(['smoke-hotfix30-direct-liff.js', 'smoke-hotfix30-entry-checkout-isolation.js']);

function parseSummary(output) {
  const m = output.match(/PASS\s*=\s*(\d+)\s*FAIL\s*=\s*(\d+)\s*MANUAL\s*=\s*(\d+)/);
  if (!m) return { pass: null, fail: null, manual: null, parsed: false };
  return { pass: Number(m[1]), fail: Number(m[2]), manual: Number(m[3]), parsed: true };
}

function runOne(entry) {
  const scriptPath = path.join(ROOT, 'scripts', entry.file);
  const label = [entry.file, ...entry.args].join(' ');
  if (!fs.existsSync(scriptPath)) {
    return {
      label, file: entry.file, exitCode: null, durationMs: 0,
      pass: null, fail: null, manual: null, parsed: false,
      timedOut: false, missing: true, stdout: '', stderr: '',
    };
  }

  const start = Date.now();
  let exitCode = 0;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  try {
    stdout = execFileSync('node', [scriptPath, ...entry.args], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: entry.timeoutMs,
      maxBuffer: 64 * 1024 * 1024,
      killSignal: 'SIGKILL',
    });
  } catch (e) {
    // execFileSync 對逾時／非 0 exit code 都會拋例外；e.stdout/e.stderr
    // 仍帶有子行程實際輸出，用來解析 PASS/FAIL/MANUAL。
    stdout = (e && e.stdout) ? String(e.stdout) : '';
    stderr = (e && e.stderr) ? String(e.stderr) : String((e && e.message) || e);
    exitCode = (e && typeof e.status === 'number') ? e.status : 1;
    timedOut = !!(e && e.signal === 'SIGTERM') || !!(e && e.killed && !e.status);
  }
  const durationMs = Date.now() - start;
  const summary = parseSummary(stdout);

  return {
    label, file: entry.file, exitCode, durationMs,
    pass: summary.pass, fail: summary.fail, manual: summary.manual, parsed: summary.parsed,
    timedOut, missing: false, stdout, stderr,
  };
}

function fmtDuration(ms) {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function main() {
  console.log('=== fix18-10-hotfix30 Sequential Regression Runner ===');
  console.log(`腳本數：${SCRIPTS.length}（依序執行，不平行，避免 SQLite data/pos.db contention）\n`);

  const runResults = [];
  for (const entry of SCRIPTS) {
    console.log(`--- 執行 ${entry.file}${entry.args.length ? ' ' + entry.args.join(' ') : ''} ---`);
    const r = runOne(entry);
    runResults.push(r);
    if (r.missing) {
      console.log(`[SKIP] ${r.label}（檔案不存在，如實跳過，不計入 TOTAL）`);
      continue;
    }
    const statusTag = r.exitCode === 0 && !r.timedOut ? 'OK' : (r.timedOut ? 'TIMEOUT' : 'NONZERO_EXIT');
    console.log(`[${statusTag}] ${r.label} — exit=${r.exitCode} duration=${fmtDuration(r.durationMs)} PASS=${r.pass ?? '?'} FAIL=${r.fail ?? '?'} MANUAL=${r.manual ?? '?'}`);
    if (!r.parsed) {
      console.log(`  [WARN] 無法從輸出解析出 PASS=/FAIL=/MANUAL= 摘要行（可能腳本本身 crash，見下方 stderr 節錄）`);
    }
    if (r.exitCode !== 0 || r.timedOut) {
      const tail = (r.stderr || r.stdout || '').split('\n').filter(Boolean).slice(-8).join('\n  ');
      if (tail) console.log(`  最後幾行輸出：\n  ${tail}`);
    }
    console.log('');
  }

  const present = runResults.filter((r) => !r.missing);
  let totalPass = 0, totalFail = 0, totalManual = 0, hotfix30RegressionFail = 0;
  const unparsed = [];

  for (const r of present) {
    if (r.parsed) {
      totalPass += r.pass || 0;
      totalManual += r.manual || 0;
      // 腳本自身斷言的 FAIL，加上「exit 非 0 但摘要行卻顯示 FAIL=0」這種
      // 矛盾情況（例如逾時、未捕捉例外）額外算 1 筆 FAIL，避免漏記。
      const scriptFail = r.fail || 0;
      totalFail += scriptFail;
      if (scriptFail === 0 && (r.exitCode !== 0 || r.timedOut)) {
        totalFail += 1;
        if (HOTFIX30_SCRIPTS.has(r.file)) hotfix30RegressionFail += 1;
      } else if (scriptFail > 0 && HOTFIX30_SCRIPTS.has(r.file)) {
        hotfix30RegressionFail += scriptFail;
      }
    } else {
      unparsed.push(r.label);
      totalFail += 1;
      if (HOTFIX30_SCRIPTS.has(r.file)) hotfix30RegressionFail += 1;
    }
  }

  console.log('=== Summary ===');
  console.table(present.map((r) => ({
    script: r.label,
    exit_code: r.exitCode,
    PASS: r.pass ?? '?',
    FAIL: r.fail ?? '?',
    MANUAL: r.manual ?? '?',
    duration: fmtDuration(r.durationMs),
  })));

  console.log(`TOTAL PASS = ${totalPass}`);
  console.log(`TOTAL FAIL = ${totalFail}`);
  console.log(`TOTAL MANUAL = ${totalManual}`);
  console.log(`HOTFIX30 REGRESSION FAIL = ${hotfix30RegressionFail}`);
  if (unparsed.length) {
    console.log(`\n[WARN] 以下腳本無法解析出摘要行（視為 FAIL 計入 TOTAL FAIL）：${unparsed.join(', ')}`);
  }
  console.log(`\n封版標準：TOTAL FAIL = 0 且 HOTFIX30 REGRESSION FAIL = 0`);
  console.log(hotfix30RegressionFail === 0
    ? '[RELEASE GATE] HOTFIX30 REGRESSION FAIL = 0 ✅'
    : '[RELEASE GATE] HOTFIX30 REGRESSION FAIL > 0 ❌ — 不得封版');

  process.exit(totalFail > 0 ? 1 : 0);
}

main();
