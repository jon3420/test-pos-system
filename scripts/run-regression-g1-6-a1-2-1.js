#!/usr/bin/env node
// scripts/run-regression-g1-6-a1-2-1.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// 正式 Regression Runner——依序執行本輪＋既有 Regression 清單，每支測試前
// 清除 data/pos.db（既有專案慣例，見 run-regression-g1-6-a1-2.js），統一
// 擷取 PASS/FAIL/TOTAL，三輪結束後檢查殘留狀態。
//
// 用法：node scripts/run-regression-g1-6-a1-2-1.js

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// Stage 3A remediation: SUITE read from side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation literal array). Real
// data/pos.db is never touched; each child gets its own mkdtemp-isolated
// temp DB via scripts/lib/qa-temp-db.js.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'A1_2_1';
const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!rawCatalog.suites || !rawCatalog.suites[CATALOG_KEY]) {
  throw new Error(`[FATAL] Suite catalog missing key "${CATALOG_KEY}" in ${CATALOG_PATH}`);
}
const catalogEntry = rawCatalog.suites[CATALOG_KEY];
if (!Array.isArray(catalogEntry.entries) || catalogEntry.entries.length !== catalogEntry.tupleCount) {
  throw new Error(`[FATAL] Suite catalog entry "${CATALOG_KEY}" is malformed (tupleCount mismatch or entries not an array)`);
}
const SUITE = Object.freeze(catalogEntry.entries.map(([p, pass, total, label]) => {
  if (typeof p !== 'string' || typeof pass !== 'number' || typeof total !== 'number' || typeof label !== 'string') {
    throw new Error(`[FATAL] Malformed suite tuple in catalog "${CATALOG_KEY}": ${JSON.stringify([p, pass, total, label])}`);
  }
  return Object.freeze([p, pass, total, label]);
}));

const NODE_CHECK_FILES = [
  'utils/dateTime.js',
  'utils/geoVisitLog.js',
  'public/js/date-time-format.js',
  'public/js/geo-visitor-layer.js',
  'public/js/geo-live-layer.js',
  'scripts/lib/qa-temp-db.js',
  'scripts/run-g1-6-a1-2-1-manual-qa.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js',
  'scripts/static-audit-g1-6-a1-2-1.js',
  'utils/authoritativeAdminPointCatalog.js',
  'routes/geo-live.js',
  'routes/analytics-geo.js',
];

function parseSummary(output) {
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
  const m2 = output.match(/總計[：:]\s*(\d+)\s*項，PASS\s*(\d+)，FAIL\s*(\d+)/);
  if (!pass && m2) { total = Number(m2[1]); pass = Number(m2[2]); fail = Number(m2[3]); }
  const m3 = output.match(/OK:\s*(\d+)\s*\/\s*(\d+)/);
  if (!pass && m3) { pass = Number(m3[1]); total = Number(m3[2]); fail = total - pass; }
  const m4 = output.match(/(\d+)\s*\/\s*(\d+)\s*OK\b/);
  if (!pass && m4) { pass = Number(m4[1]); total = Number(m4[2]); fail = total - pass; }
  return { pass, fail, total };
}

function residueCheck(tmpRoot) {
  const issues = [];
  if (fs.existsSync(tmpRoot)) issues.push('temp DB root 殘留: ' + tmpRoot);
  const tmpQaFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-geo-store-'));
  if (tmpQaFiles.length > 0) issues.push(`QA temp DB 殘留: ${tmpQaFiles.join(', ')}`);
  return issues;
}

function runRound(roundNum, tmpRoot) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const childDbPath = dbHelper.createChildDbPath(tmpRoot, label);
    const childEnv = dbHelper.buildChildEnv(childDbPath, tmpRoot);
    let output = '';
    let crashed = false;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: childEnv });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
    } finally {
      dbHelper.cleanupDbFileAndSidecars(childDbPath);
    }
    const { pass, fail, total } = parseSummary(output);
    const ok = !crashed && fail === 0 && pass === expectPass && total === expectTotal;
    if (!ok) allOk = false;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, ok, crashed });
    console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label.padEnd(24)} pass=${pass} fail=${fail} total=${total} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED' : ''}`);
    if (!ok) {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
      console.log('----------------------');
    }
  }
  return { allOk, roundResults };
}

function main() {
  console.log('node --check for all touched/added A1.2.1 files:');
  let checkOk = true;
  for (const rel of NODE_CHECK_FILES) {
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      console.log(`  [OK]  ${rel}`);
    } catch (e) {
      checkOk = false;
      console.log(`  [FAIL] ${rel} — ${e.message.slice(0, 200)}`);
    }
  }

  const roundCount = dbHelper.parseRegressionCliArgs(process.argv.slice(2)).roundCount;
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-a1-2-1');
  let rounds;
  try {
    rounds = [];
    for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i, tmpRoot));
  } finally {
    cleanupRoot();
  }
  const residue = residueCheck(tmpRoot);
  const residueOk = residue.length === 0;
  if (!residueOk) console.log(`[RESIDUE] ${residue.join('; ')}`);

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk && residueOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} ${roundCount}輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1');
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  temp DB root residue: ${fs.existsSync(tmpRoot) ? 'YES (BAD)' : 'no'}`);
  console.log('  real data/pos.db: never touched by this runner (Stage 3A remediated)');
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
