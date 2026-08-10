#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-3.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full
//
// H1.4.3 Full Regression Runner。不手抄 H1.4.2 的 suite list——在執行期直接
// 重新執行 scripts/run-regression-g1-6-ga4-h1-4-2.js 原始碼裡「組出最終
// SUITE 陣列」那一段程式碼，拿到 H1.4.2 真正 inherited 的 67-suite 清單，
// 再加入本輪 H1.4.3 新增的 3 支 suite（Heatmap Range Runtime／Data
// Lineage Runtime／Static Audit）。Process-isolation／Classification／
// Residue 偵測沿用 H1.4.2 版本同一套邏輯，不重新發明。
//
// H1.4.3 本輪沒有任何 Intentional Contract Change 需要覆寫舊 suite 的
// expected count（Cross-range stale fallback 修正／Overseas display
// disambiguation 都是新增行為，沒有改動任何既有 H1.4.2 assertion 的語意），
// 所以這裡沒有 OVERRIDES map——如果未來真的需要，加法必須跟 H1.4.2 runner
// 一樣，只能調整 expected COUNT，不能放寬 expected FAIL（永遠是 0）。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// ════════════════════════════════════════════════════════════════
// 1. 重新執行 H1.4.2 runner 原始碼裡「組出最終 SUITE 陣列」的那一段，
//    拿到它真正的 inherited final suite 清單（不是手打轉抄）。
// ════════════════════════════════════════════════════════════════
function parseH142FinalSuite() {
  const rel = 'scripts/run-regression-g1-6-ga4-h1-4-2.js';
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const marker = 'const SUITE = [...H141_SUITE_UPDATED, ...H142_NEW];';
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`[FATAL] 無法在 ${rel} 裡找到 SUITE 組裝那一行，解析邏輯可能已經跟原始碼格式不同步。`);
    process.exit(1);
  }
  const codeUpToSuite = src.slice(0, idx + marker.length).replace(/^#!.*\n/, '');
  const fakeModule = { exports: null };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'require', '__dirname', `${codeUpToSuite}\nmodule.exports = SUITE;`);
  fn(fakeModule, require, path.dirname(path.join(ROOT, rel)));
  return fakeModule.exports;
}
const H142_FINAL_SUITE = parseH142FinalSuite();

{
  const seen = new Set();
  const dups = [];
  H142_FINAL_SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.2 final runner 內部本身有重複 suite path，無法安全繼承：', dups);
    process.exit(1);
  }
  if (H142_FINAL_SUITE.length === 0) {
    console.error('[FATAL] 從 run-regression-g1-6-ga4-h1-4-2.js 解析出的最終 SUITE 是空陣列，解析邏輯可能已經跟原始碼格式不同步。');
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. H1.4.3 新增：Heatmap Range Runtime／Data Lineage Runtime／Static
//    Audit（全部 fresh 執行確認過真實 count，且都是 FAIL=0）。
// ════════════════════════════════════════════════════════════════
const H143_NEW = [
  ['scripts/run-g1-6-ga4-h1-4-3-heatmap-range-runtime.js', 64, 64, 'H1.4.3 Heatmap Range Runtime (10 ranges + race + empty + cross-range stale fallback guard + custom-transport collision guard + search + Overseas disambiguation)'],
  ['scripts/run-g1-6-ga4-h1-4-3-data-lineage-runtime.js', 33, 33, 'H1.4.3 Data Lineage Runtime (Raw→Normalize→Persist→Read→Heatmap/Dashboard ViewModel, real SQLite)'],
  ['scripts/static-audit-g1-6-ga4-h1-4-3.js', 161, 161, 'H1.4.3 Static Audit (Cross-range cache identity / Overseas display / No snapshot summing / Single payload / Search / Realtime-Historical split / H1.4.2 freeze / Backend scope)'],
];

const SUITE = [...H142_FINAL_SUITE, ...H143_NEW];

// Final uniqueness gate.
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.3 runner 組出來的最終 SUITE 清單有重複 path：', dups);
    process.exit(1);
  }
}

const NODE_CHECK_FILES = [
  'public/js/geo-ga4-h1-panel.js',
  'public/js/geo-ga4-dashboard-layer.js',
  'public/js/geo-range-resolver.js',
  'public/js/geo-range-control.js',
];

function parseSummary(output) {
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
  const m1b = output.match(/OK:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (pass === null && m1b) { pass = Number(m1b[1]); fail = Number(m1b[2]); total = Number(m1b[3]); }
  const m2 = output.match(/總計[：:]\s*(\d+)\s*項，PASS\s*(\d+)，FAIL\s*(\d+)/);
  if (pass === null && m2) { total = Number(m2[1]); pass = Number(m2[2]); fail = Number(m2[3]); }
  const m3 = output.match(/OK:\s*(\d+)\s*\/\s*(\d+)/);
  if (pass === null && m3) { pass = Number(m3[1]); total = Number(m3[2]); fail = total - pass; }
  const m4 = output.match(/(\d+)\s*\/\s*(\d+)\s*OK\b/);
  if (pass === null && m4) { pass = Number(m4[1]); total = Number(m4[2]); fail = total - pass; }
  const m5 = output.match(/(\d+)\/(\d+)\s*PASS,\s*(\d+)\s*FAIL/);
  if (pass === null && m5) { pass = Number(m5[1]); total = Number(m5[2]); fail = Number(m5[3]); }
  const m6 = output.match(/PASS=(\d+)\s+FAIL=(\d+)/);
  if (pass === null && m6) { pass = Number(m6[1]); fail = Number(m6[2]); total = pass + fail; }
  if (pass === null) {
    const pM = output.match(/PASS:\s*(\d+)/);
    const fM = output.match(/FAIL:\s*(\d+)/);
    const tM = output.match(/TOTAL:\s*(\d+)/);
    if (pM && fM && tM) { pass = Number(pM[1]); fail = Number(fM[1]); total = Number(tM[1]); }
  }
  return { pass, fail, total };
}

function detectResidue() {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    ['.sqlite', '.sqlite3'].forEach((ext) => {
      if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
    });
  }
  const tmpDbs = fs.readdirSync(os.tmpdir()).filter((f) => /ga4-h1.*\.db$|unique-subdivision.*\.db$|h14-mutations.*\.db$/.test(f));
  if (tmpDbs.length) issues.push(`temp DB residue: ${tmpDbs.join(', ')}`);
  const mutationTmpJs = [];
  ['public/js', 'services'].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      fs.readdirSync(full).filter((f) => /\.mutation-tmp-/.test(f)).forEach((f) => mutationTmpJs.push(`${dir}/${f}`));
    }
  });
  if (mutationTmpJs.length) issues.push(`mutation temp file residue: ${mutationTmpJs.join(', ')}`);
  const baselineTmpDirs = fs.readdirSync(os.tmpdir()).filter((f) => /^h13-baseline-static-/.test(f));
  if (baselineTmpDirs.length) issues.push(`baseline temp extraction residue: ${baselineTmpDirs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  if (typeof global.jsdom !== 'undefined' || typeof global.window !== 'undefined') issues.push('jsdom global leaked into parent process');
  return issues;
}

function classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return (!crashed && exitCode === 0) ? 'PASS' : 'FAIL';
  }
  // STRICT——沒有任何「已知、可接受的 FAIL」。PASS 只在 exit===0 且
  // fail===0 且 pass/total 都精確吻合 expected 才算。禁止 partial-fail
  // override／known-fail allowance／documented intentional FAIL。
  const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  let sumChildFailAssertions = 0;
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      console.log(`[FAIL                 ] ${label.padEnd(60)} <== MISSING SCRIPT: ${rel}`);
      roundResults.push({ label, rel, pass: null, fail: null, total: null, expectPass, expectTotal, exitCode: null, classification: 'FAIL', crashed: true, missing: true });
      allOk = false;
      continue;
    }
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    let output = '';
    let crashed = false;
    let exitCode = 0;
    let timedOut = false;
    try {
      output = execFileSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
      exitCode = e.status === undefined ? 1 : e.status;
      if (e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code))) timedOut = true;
    }
    const { pass, fail, total } = parseSummary(output);
    const classification = classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
    if (classification === 'FAIL') allOk = false;
    if (typeof fail === 'number' && fail > 0) sumChildFailAssertions += fail;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(60)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}${timedOut ? '  <== TIMEOUT' : ''}`);
    if (classification === 'FAIL') {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
      console.log('----------------------');
    }
  }
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const residue = detectResidue();
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function main() {
  console.log('H1.4.3 Full Regression Runner');
  console.log(`  Inherited from H1.4.2 final runner (parsed live): ${H142_FINAL_SUITE.length} unique suites`);
  console.log(`  + H1.4.3 new suites (Heatmap Range / Data Lineage / Static): ${H143_NEW.length}`);
  console.log(`  = Total unique suites this round: ${SUITE.length}`);
  console.log('\nnode --check for H1.4.3 touched Production files:');
  let checkOk = true;
  for (const rel of NODE_CHECK_FILES) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      console.log(`  [OK]   ${rel}`);
    } catch (e) {
      checkOk = false;
      console.log(`  [FAIL] ${rel} — ${e.message.slice(0, 200)}`);
    }
  }

  const roundCount = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;
  const rounds = [];
  for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 各輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('H1.4.3 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.3-GA4-HEATMAP-RANGE-DATA-CONSISTENCY-QA-full');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  uniqueSuites: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    console.log(`  Round ${i + 1}: passedSuites=${SUITE.length - r.failedSuiteCount} failedSuites=${r.failedSuiteCount} childFailAssertions=${r.sumChildFailAssertions} residue=${r.residue.length} allOk=${r.allOk}`);
  });
  const assertionMismatch = !consistent ? 1 : 0;
  const exitMismatchTotal = rounds.reduce((acc, r) => acc + r.roundResults.filter((x) => x.exitCode !== 0 && x.expectPass === x.expectTotal).length, 0);
  console.log(`  assertionMismatch: ${assertionMismatch}`);
  console.log(`  exitMismatch: ${exitMismatchTotal}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
