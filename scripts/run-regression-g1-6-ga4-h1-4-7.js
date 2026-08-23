#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-7.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA-full
//
// H1.4.7 Full Regression Runner。
//
// Stage 3A remediation note: the previous readFileSync()+new Function() live
// parser and the frozen H146_INHERITED_SUITES/H147_NEW_SUITES arrays have
// been removed entirely. SUITE is now read from the side-effect-free JSON
// catalog (scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json, key GA4_H1_4_7),
// which was itself verified byte-identical to this file's original frozen
// 79-entry list via scripts/lib/H1.4.8_STAGE3A_SUITE_BASELINE.json.

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.resolve(__dirname, '..'); // 動態解析 repo root，不寫死 /home/claude/work/base
const dbHelper = require('./lib/qa-temp-db.js');

// Stage 3A remediation: SUITE is read from the side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation frozen H146_INHERITED_SUITES
// + H147_NEW_SUITES concatenation). H146_INHERITED_SUITES, H147_NEW_SUITES,
// and parseH146FinalSuiteForDiagnosticsOnly() (the residual diagnostic-only
// new Function() executor) are all removed entirely -- no "doesn't affect
// exit code" exception. Real data/pos.db is never touched; each child gets
// its own mkdtemp-isolated temp DB.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1_4_7';
const EXPECTED_H146_COUNT = 76;
const EXPECTED_H147_NEW_COUNT = 3;
const EXPECTED_TOTAL = EXPECTED_H146_COUNT + EXPECTED_H147_NEW_COUNT;
const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!rawCatalog.suites || !rawCatalog.suites[CATALOG_KEY]) {
  throw new Error(`[FATAL] Suite catalog missing key "${CATALOG_KEY}" in ${CATALOG_PATH}`);
}
const catalogEntry = rawCatalog.suites[CATALOG_KEY];
if (!Array.isArray(catalogEntry.entries) || catalogEntry.entries.length !== catalogEntry.tupleCount) {
  throw new Error(`[FATAL] Suite catalog entry "${CATALOG_KEY}" is malformed (tupleCount mismatch or entries not an array)`);
}
const SUITE = Object.freeze(catalogEntry.entries.map(([p, pass, total, label]) => {
  const passOk = pass === null || typeof pass === 'number';
  const totalOk = total === null || typeof total === 'number';
  if (typeof p !== 'string' || !passOk || !totalOk || typeof label !== 'string') {
    throw new Error(`[FATAL] Malformed suite tuple in catalog "${CATALOG_KEY}": ${JSON.stringify([p, pass, total, label])}`);
  }
  return Object.freeze([p, pass, total, label]);
}));
if (SUITE.length !== EXPECTED_TOTAL) {
  throw new Error(`[FATAL] 預期最終應解析出 ${EXPECTED_TOTAL} 個唯一 suite（${EXPECTED_H146_COUNT} inherited + ${EXPECTED_H147_NEW_COUNT} new），實際為 ${SUITE.length} 個。`);
}

// suite path 正規化（統一用 '/' 分隔、去除前後空白），用於去重與存在性檢查。
function normPath(p) { return String(p).trim().replace(/\\/g, '/'); }
function absPath(p) { return path.resolve(ROOT, normPath(p)); }

// Final normalize + uniqueness + existence gate。
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dups.push(n); seen.add(n); });
  if (dups.length) {
    throw new Error(`[FATAL] H1.4.7 runner 組出來的最終 SUITE 清單有重複 path（正規化後比對）：${JSON.stringify(dups)}`);
  }
  const missing = SUITE.filter(([p]) => !fs.existsSync(absPath(p)));
  if (missing.length) {
    throw new Error(`[FATAL] 以下 suite path 解析後不存在：${JSON.stringify(missing.map(([p]) => p))}`);
  }
  const outsideRoot = SUITE.filter(([p]) => !absPath(p).startsWith(ROOT + path.sep));
  if (outsideRoot.length) {
    throw new Error(`[FATAL] 以下 suite path 解析後位於 repo root 之外：${JSON.stringify(outsideRoot.map(([p]) => p))}`);
  }
  // 明確排除：不得把 H1.4.6/H1.4.7 regression runner 自身列為（或意外混入）leaf suite。
  const forbidden = ['scripts/run-regression-g1-6-ga4-h1-4-6.js', 'scripts/run-regression-g1-6-ga4-h1-4-7.js'];
  const nested = SUITE.filter(([p]) => forbidden.includes(normPath(p)));
  if (nested.length) {
    throw new Error(`[FATAL] SUITE 裡混入了 regression runner 自身（巢狀彙總），不允許：${JSON.stringify(nested)}`);
  }
}

const NODE_CHECK_FILES = [
  'public/line-order.html',
  'public/line-shipping.html',
  'public/js/analytics-platforms.js',
  'utils/analyticsLog.js',
  'utils/dashboardAnalytics.js',
  'utils/analyticsV2.js',
  'utils/geoAnalyticsQueries.js',
  'scripts/static-audit-g1-6-ga4-h1-4-7.js',
  'scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js',
  'scripts/run-h1-4-7-analytics-contract-runtime.js',
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
  const m7 = output.match(/—\s*(\d+)\/(\d+)\s*passed/);
  if (pass === null && m7) { pass = Number(m7[1]); total = Number(m7[2]); fail = total - pass; }
  if (pass === null) {
    const pM = output.match(/PASS:\s*(\d+)/);
    const fM = output.match(/FAIL:\s*(\d+)/);
    const tM = output.match(/TOTAL:\s*(\d+)/);
    if (pM && fM && tM) { pass = Number(pM[1]); fail = Number(fM[1]); total = Number(tM[1]); }
  }
  return { pass, fail, total };
}

function snapshotTmpMatches() {
  const patterns = [/ga4-h1.*\.db$/, /unique-subdivision.*\.db$/, /h14-mutations.*\.db$/, /^h13-baseline-static-/, /^h1-4-7-analytics-/];
  const all = fs.readdirSync(os.tmpdir());
  return new Set(all.filter((f) => patterns.some((re) => re.test(f))));
}

function detectResidue(preRoundTmpSnapshot, tmpRoot) {
  const issues = [];
  if (tmpRoot && fs.existsSync(tmpRoot)) issues.push('temp DB root: ' + tmpRoot);
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    ['.sqlite', '.sqlite3'].forEach((ext) => {
      if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
    });
  }
  const afterSnapshot = snapshotTmpMatches();
  const newLeftovers = [...afterSnapshot].filter((f) => !preRoundTmpSnapshot.has(f));
  if (newLeftovers.length) issues.push(`temp file residue newly created this round: ${newLeftovers.join(', ')}`);
  const mutationTmpJs = [];
  ['public/js', 'services'].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      fs.readdirSync(full).filter((f) => /\.mutation-tmp-/.test(f)).forEach((f) => mutationTmpJs.push(`${dir}/${f}`));
    }
  });
  if (mutationTmpJs.length) issues.push(`mutation temp file residue: ${mutationTmpJs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  if (typeof global.jsdom !== 'undefined' || typeof global.window !== 'undefined') issues.push('jsdom global leaked into parent process');
  return issues;
}

function classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  // 一律以 child exit code 為成功判定基礎，不能只搜尋輸出文字裡有沒有出現 'PASS'。
  if (exitCode !== 0 || crashed) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return 'PASS';
  }
  const parsedOk = typeof pass === 'number' && typeof total === 'number' && typeof fail === 'number'
    && Number.isFinite(pass) && Number.isFinite(total) && Number.isFinite(fail);
  const ok = parsedOk && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runSuite(rel, expectPass, expectTotal, label, tmpRoot) {
  const p = absPath(rel);
  if (!fs.existsSync(p)) {
    return { label, rel, pass: null, fail: null, total: null, expectPass, expectTotal, exitCode: null, classification: 'FAIL', crashed: true, missing: true, output: '' };
  }
  const childDbPath = dbHelper.createChildDbPath(tmpRoot, label);
  const childEnv = dbHelper.buildChildEnv(childDbPath, tmpRoot);
  let output = '';
  let crashed = false;
  let exitCode = 0;
  let timedOut = false;
  try {
    output = execFileSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: childEnv });
  } catch (e) {
    output = (e.stdout || '') + (e.stderr || '');
    crashed = true;
    exitCode = e.status === undefined ? 1 : e.status;
    if (e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code))) timedOut = true;
  } finally {
    dbHelper.cleanupDbFileAndSidecars(childDbPath);
  }
  const { pass, fail, total } = parseSummary(output);
  const classification = classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
  return { label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut, output };
}

function runRound(roundNum, tmpRoot) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  let sumChildFailAssertions = 0;
  const preRoundTmpSnapshot = snapshotTmpMatches();
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const r = runSuite(rel, expectPass, expectTotal, label, tmpRoot);
    if (r.classification === 'FAIL') allOk = false;
    if (typeof r.fail === 'number' && r.fail > 0) sumChildFailAssertions += r.fail;
    roundResults.push(r);
    console.log(`[${r.classification.padEnd(22)}] ${label.padEnd(60)} pass=${r.pass} fail=${r.fail} total=${r.total} exit=${r.exitCode} (expect ${expectPass}/${expectTotal})${r.crashed ? '  <== CRASHED/NONZERO' : ''}${r.timedOut ? '  <== TIMEOUT' : ''}${r.missing ? '  <== MISSING SCRIPT' : ''}`);
    if (r.classification === 'FAIL') {
      console.log('---- full stdout+stderr ----');
      console.log(r.output || '(no output captured)');
      console.log('---- signal:', r.signal || 'none', ' exit:', r.exitCode, '----');
    }
  }
  const residue = detectResidue(preRoundTmpSnapshot, null); // 不因 suite 失敗而略過
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function dryRunInventory() {
  console.log('H1.4.7 Regression Runner — DRY RUN (inventory only, no suites executed)');
  console.log(`  ROOT: ${ROOT}`);
  const h146PrefixCount = SUITE.slice(0, EXPECTED_H146_COUNT).length;
  console.log(`  H1.4.6 inherited suites (from catalog, first ${EXPECTED_H146_COUNT} of SUITE): ${h146PrefixCount}（預期 ${EXPECTED_H146_COUNT}，缺少 = ${EXPECTED_H146_COUNT - h146PrefixCount}）`);
  const h147NewSlice = SUITE.slice(EXPECTED_H146_COUNT);
  const staticAuditCount = h147NewSlice.filter(([p]) => p === 'scripts/static-audit-g1-6-ga4-h1-4-7.js').length;
  const twoStageCount = h147NewSlice.filter(([p]) => p === 'scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js').length;
  const analyticsCount = h147NewSlice.filter(([p]) => p === 'scripts/run-h1-4-7-analytics-contract-runtime.js').length;
  console.log(`  H1.4.7 static audit：恰好 ${staticAuditCount}`);
  console.log(`  H1.4.7 two-stage runtime：恰好 ${twoStageCount}`);
  console.log(`  H1.4.7 analytics runtime：恰好 ${analyticsCount}`);
  const seen = new Set();
  const dupList = [];
  SUITE.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dupList.push(n); seen.add(n); });
  console.log(`  duplicate resolved paths：${dupList.length}`);
  const missingList = SUITE.filter(([p]) => !fs.existsSync(absPath(p)));
  console.log(`  missing files：${missingList.length}`);
  const forbidden = ['scripts/run-regression-g1-6-ga4-h1-4-6.js', 'scripts/run-regression-g1-6-ga4-h1-4-7.js'];
  const selfRecursion = SUITE.filter(([p]) => forbidden.includes(normPath(p)));
  console.log(`  self-recursion：${selfRecursion.length}`);
  const nestedRunners = SUITE.filter(([p]) => /run-regression-/.test(normPath(p)));
  console.log(`  nested regression runners：${nestedRunners.length}`);
  console.log(`  UNIQUE SUITES (total)：${SUITE.length}`);
  const ok = staticAuditCount === 1 && twoStageCount === 1 && analyticsCount === 1
    && dupList.length === 0 && missingList.length === 0 && selfRecursion.length === 0 && nestedRunners.length === 0
    && h146PrefixCount === EXPECTED_H146_COUNT;
  console.log(`  DRY RUN RESULT: ${ok ? 'OK' : 'FAIL'}`);
  console.log('  (dry-run: no temp root created, no child process spawned, no file written/deleted, no DB/route/service/server required)');
  process.exitCode = ok ? 0 : 1;
}

function main() {
  const cliArgs = dbHelper.parseRegressionCliArgs(process.argv.slice(2), { allowDryRun: true });
  if (cliArgs.mode === 'dry-run') {
    dryRunInventory();
    return;
  }
  const roundCount = cliArgs.roundCount;

  console.log('H1.4.7 Full Regression Runner');
  console.log(`  Final resolved suite (from side-effect-free JSON catalog, Stage 3A remediated): ${SUITE.length} unique suites (${EXPECTED_H146_COUNT} inherited-prefix + ${EXPECTED_H147_NEW_COUNT} new)`);
  console.log('\nnode --check for H1.4.7 touched Production/Test files:');
  let checkOk = true;
  for (const rel of NODE_CHECK_FILES) {
    if (rel.endsWith('.html')) {
      if (!fs.existsSync(path.join(ROOT, rel))) { checkOk = false; console.log(`  [FAIL] ${rel} — file missing`); }
      else console.log(`  [OK]   ${rel} (exists; inline <script> syntax verified separately)`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      console.log(`  [OK]   ${rel}`);
    } catch (e) {
      checkOk = false;
      console.log(`  [FAIL] ${rel} — ${e.message.slice(0, 200)}`);
    }
  }

  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-ga4-h1-4-7');
  let rounds;
  try {
    rounds = [];
    for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i, tmpRoot));
  } finally {
    cleanupRoot();
  }

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 各輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('H1.4.7 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.7-TWO-STAGE-CHECKOUT-QA-full');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  UNIQUE SUITES: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    const totalPass = r.roundResults.reduce((a, x) => a + (x.pass || 0), 0);
    const totalFail = r.roundResults.reduce((a, x) => a + (x.fail || 0), 0);
    const totalTotal = r.roundResults.reduce((a, x) => a + (x.total || 0), 0);
    console.log(`  Round ${i + 1}: UNIQUE_SUITES=${SUITE.length} PASS=${totalPass} FAIL=${totalFail} TOTAL=${totalTotal} passedSuites=${SUITE.length - r.failedSuiteCount} failedSuites=${r.failedSuiteCount} exit=${r.allOk ? 0 : 1} residue=${r.residue.length}`);
  });
  const assertionMismatch = !consistent ? 1 : 0;
  console.log(`  assertionMismatch: ${assertionMismatch}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
