#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-2.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX
//
// H1.4.2 Full Regression Runner。不修改 scripts/run-regression-g1-6-ga4-h1-4-1.js
// （H1.4.1 final runner 原檔保留不動）。這支新 runner：
//   1. 在執行期直接重新執行 run-regression-g1-6-ga4-h1-4-1.js 原始碼裡「組出
//      最終 SUITE 陣列」那一段程式碼（不是憑印象轉抄、不是手打數字），拿到
//      H1.4.1 真正 inherited 的 unique suite 清單與數量。
//   2. 對其中因本輪（H1.4.2）Intentional Contract Change 而改變的 suite
//      覆寫期待值——全部是 fresh 執行後確認過的真實新數字，理由逐條寫在
//      OVERRIDES 旁的註解裡（Dashboard Sync CTA 取代舊的純文字 empty
//      message／Heatmap Wheel 從 auto-enable 改成 click-to-activate）。
//   3. 加入 H1.4.2 三支新腳本：Browser Target Runtime（117/117）、
//      Persisted Identity Runtime（44/44）、Static Audit（126/126）。
// Process-isolation／Classification／Residue 偵測沿用 H1.4.1 版本同一套
// 邏輯，不重新發明。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// Stage 3A remediation: SUITE is read from the side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation inheritance-resolved array,
// including the OVERRIDES transformation that used to happen at runtime via
// new Function()). The parseH141FinalSuite() readFileSync+new Function()
// executor and the OVERRIDES map are gone -- the catalog already contains
// the final resolved tuples. Real data/pos.db is never touched; each child
// gets its own mkdtemp-isolated temp DB.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1_4_2';
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

// Final uniqueness gate.
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    throw new Error(`[FATAL] H1.4.2 runner 組出來的最終 SUITE 清單有重複 path：${JSON.stringify(dups)}`);
  }
}

const NODE_CHECK_FILES = [
  'public/js/geo-ga4-dashboard-layer.js',
  'public/js/geo-heatmap-ui.js',
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

function detectResidue(tmpRoot) {
  const issues = [];
  if (tmpRoot && fs.existsSync(tmpRoot)) issues.push('temp DB root: ' + tmpRoot);
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
  // 需求文件十、十一：STRICT——沒有任何「已知、可接受的 FAIL」。PASS 只在
  // exit===0 且 fail===0 且 pass/total 都精確吻合 expected 才算。OVERRIDES
  // 只能調整 expected COUNT（因為 Intentional Contract Change 造成斷言內容
  // 改變後的新真實 count），不能也不會調整 expected FAIL（那個永遠是 0）。
  const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runRound(roundNum, tmpRoot) {
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
    if (classification === 'FAIL') allOk = false;
    // 需求文件十二：Global Hidden-Failure Guard——即使 pass/total 剛好跟
    // expected 吻合，只要這支 suite 自己回報的 fail > 0，就必須算進
    // sumChildFailAssertions，不能被任何 override 悄悄蓋過去。
    if (typeof fail === 'number' && fail > 0) sumChildFailAssertions += fail;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(60)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}${timedOut ? '  <== TIMEOUT' : ''}`);
    if (classification === 'FAIL') {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
      console.log('----------------------');
    }
  }
  const residue = detectResidue(null);
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function main() {
  console.log('H1.4.2 Full Regression Runner');
  console.log(`  Final resolved suite (from side-effect-free JSON catalog, Stage 3A remediated): ${SUITE.length} unique suites`);
  console.log('\nnode --check for H1.4.2 touched Production files:');
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

  const roundCount = dbHelper.parseRegressionCliArgs(process.argv.slice(2)).roundCount;
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-ga4-h1-4-2');
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
  console.log('H1.4.2 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX');
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
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
