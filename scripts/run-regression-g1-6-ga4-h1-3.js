#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-3.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// 正式 H1.3 Full Regression Runner。延續 scripts/run-regression-g1-6-ga4-h1-2.js
// 的 process-isolation 設計（每個 Suite 都是獨立 child process），在最前面
// 加上本輪（H1.3 Event Compat）新增的 6 個 Suite，其餘全部延用 H1.2 既有
// 清單（實際腳本名稱／預期數字皆已於本輪重新逐一執行驗證，非憑印象照抄）。
//
// Classification 規則與 H1.2 版本相同：PASS / FAIL / KNOWN_BASELINE_MISMATCH。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// 登記表：[suiteLabel] -> { note }。目前為空表——本輪沒有發現任何新的
// Stale Expectation／Baseline Mismatch。
const KNOWN_MISMATCHES = {};

// Stage 3A remediation: SUITE read from side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation literal array, including
// null/null "self-contained runner" entries). Real data/pos.db is never
// touched; each child gets its own mkdtemp-isolated temp DB.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1_3';
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

const NODE_CHECK_FILES = [
  'utils/taiwanGeoNormalize.js',
  'utils/ga4Realtime/index.js',
  'utils/ga4Realtime/requestBuilder.js',
  'utils/ga4Realtime/requestPair.js',
  'utils/ga4Realtime/connectionTest.js',
  'utils/ga4Realtime/client.js',
  'utils/ga4Realtime/errors.js',
  'utils/dateTime.js',
  'services/ga4GeoSyncService.js',
  'routes/geo-live.js',
  'public/js/geo-ga4-realtime-layer.js',
  'public/js/geo-ga4-h1-panel.js',
  'scripts/audit-taiwan-unique-subdivision-aliases.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js',
  'scripts/static-audit-g1-6-ga4-h1-2.js',
  'scripts/static-audit-g1-6-ga4-h1-3.js',
  'scripts/run-g1-6-ga4-h1-3-request-builder-contract.js',
  'scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js',
  'scripts/run-g1-6-ga4-h1-3-realtime-event-runtime.js',
  'scripts/run-g1-6-ga4-h1-3-historical-runtime.js',
  'scripts/run-g1-6-ga4-h1-3-mutations.js',
  'scripts/run-regression-g1-6-ga4-h1-3.js',
];

function parseSummary(output) {
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
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
  return { pass, fail, total };
}

function detectResidue(tmpRoot) {
  const issues = [];
  if (tmpRoot && fs.existsSync(tmpRoot)) issues.push('temp DB root: ' + tmpRoot);
  ['.sqlite', '.sqlite3'].forEach((ext) => {
    if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
  });
  const tmpDbs = fs.readdirSync(os.tmpdir()).filter((f) => /ga4-h1.*\.db$|unique-subdivision.*\.db$/.test(f));
  if (tmpDbs.length) issues.push(`temp DB residue: ${tmpDbs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  if (typeof global.jsdom !== 'undefined' || typeof global.window !== 'undefined') issues.push('jsdom global leaked into parent process');
  return issues;
}

function classify(rel, expectPass, expectTotal, pass, fail, total, exitCode, crashed) {
  if (expectPass === null && expectTotal === null) {
    return (!crashed && exitCode === 0) ? 'PASS' : 'FAIL';
  }
  const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
  if (ok) return 'PASS';
  const known = KNOWN_MISMATCHES[rel];
  if (known) return 'KNOWN_BASELINE_MISMATCH';
  return 'FAIL';
}

function runRound(roundNum, tmpRoot) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const childDbPath = dbHelper.createChildDbPath(tmpRoot, label);
    const childEnv = dbHelper.buildChildEnv(childDbPath, tmpRoot);
    const envBefore = JSON.stringify(Object.keys(process.env).sort());
    let output = '';
    let crashed = false;
    let exitCode = 0;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', env: childEnv });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
      exitCode = e.status === undefined ? 1 : e.status;
    } finally {
      dbHelper.cleanupDbFileAndSidecars(childDbPath);
    }
    const envAfter = JSON.stringify(Object.keys(process.env).sort());
    const { pass, fail, total } = parseSummary(output);
    const classification = classify(rel, expectPass, expectTotal, pass, fail, total, exitCode, crashed);
    if (classification === 'FAIL') allOk = false;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, envLeaked: envBefore !== envAfter });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(28)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}`);
    if (classification === 'FAIL') {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-20).join('\n'));
      console.log('----------------------');
    }
  }
  const residue = detectResidue(null);
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  return { allOk, roundResults, residue };
}

function main() {
  console.log('node --check for H1.2 touched/new files:');
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
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-ga4-h1-3');
  let rounds;
  try {
    rounds = [];
    for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i, tmpRoot));
  } finally {
    cleanupRoot();
  }
  const finalResidue = detectResidue(tmpRoot);
  const finalResidueOk = finalResidue.length === 0;
  if (!finalResidueOk) console.log(`[RESIDUE] final: ${finalResidue.join('; ')}`);

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk && finalResidueOk;
  const anyKnownMismatch = rounds.some((r) => r.roundResults.some((x) => x.classification === 'KNOWN_BASELINE_MISMATCH'));

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} ${roundCount}輪數字不一致：${vals.join(' | ')}`); }
  }

  const h1_3Labels = ['H1.3 Request Builder Contract', 'H1.3 Event Compat Connection Test', 'H1.3 Realtime Event Runtime', 'H1.3 Historical Runtime', 'H1.3 Mutation Suite', 'H1.3 Static Audit'];
  const h1_3Fails = rounds.flatMap((r) => r.roundResults).filter((x) => h1_3Labels.includes(x.label) && x.classification === 'FAIL');

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  H1.3 new suites FAIL count: ${h1_3Fails.length}`);
  console.log(`  Known baseline mismatches present: ${anyKnownMismatch ? 'YES' : 'NO'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} all green (no unexplained FAIL): ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  temp DB root residue: ${fs.existsSync(tmpRoot) ? 'YES (BAD)' : 'no'}`);
  console.log('  real data/pos.db: never touched by this runner (Stage 3A remediated)');
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
