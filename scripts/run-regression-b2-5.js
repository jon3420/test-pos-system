#!/usr/bin/env node
// scripts/run-regression-b2-5.js — fix18-10-hotfix30-B5-R5.4-G1.5-B2.5
// 正式 Regression Runner——依序執行本輪 Regression 清單，每支測試前清除
// data/pos.db，統一擷取 PASS/FAIL/TOTAL，輪次結束後檢查殘留狀態。
//
// 用法：node scripts/run-regression-b2-4.js
// exit code：全部通過為 0，任何一支有 FAIL 或無法解析結果則為 1。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// ════════════════════════════════════════════════════════════════
// Stage 3A remediation (H1.4.8 destructive-script cleanup):
//   - SUITE is no longer a hand-maintained literal array in this file; it is
//     read from the side-effect-free JSON catalog (single source of truth,
//     verified byte-identical to the pre-remediation literal array via
//     scripts/lib/H1.4.8_STAGE3A_SUITE_BASELINE.json + deepStrictEqual).
//   - The real data/pos.db is never touched by this runner anymore. Each
//     child gets its own mkdtemp-isolated temp DB via scripts/lib/qa-temp-db.js,
//     passed through POS_DB_PATH in the child's env. No fallback to the real
//     DB path is possible: dbHelper throws fail-fast if a path can't be
//     verified as a safe temp path.
// ════════════════════════════════════════════════════════════════
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'B2_5';
const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!rawCatalog.suites || !rawCatalog.suites[CATALOG_KEY]) {
  throw new Error(`[FATAL] Suite catalog missing key "${CATALOG_KEY}" in ${CATALOG_PATH}`);
}
const catalogEntry = rawCatalog.suites[CATALOG_KEY];
if (!Array.isArray(catalogEntry.entries) || catalogEntry.entries.length !== catalogEntry.tupleCount) {
  throw new Error(`[FATAL] Suite catalog entry "${CATALOG_KEY}" is malformed (tupleCount mismatch or entries not an array)`);
}
// Independent immutable copy -- never share the require() cache's array/object
// references with anything else that might load the same JSON module.
const SUITE = Object.freeze(catalogEntry.entries.map(([p, pass, total, label]) => {
  if (typeof p !== 'string' || typeof pass !== 'number' || typeof total !== 'number' || typeof label !== 'string') {
    throw new Error(`[FATAL] Malformed suite tuple in catalog "${CATALOG_KEY}": ${JSON.stringify([p, pass, total, label])}`);
  }
  return Object.freeze([p, pass, total, label]);
}));

const NODE_CHECK_FILES = [
  'utils/taiwanGeoNormalize.js',
  'utils/ga4Realtime/requestBuilder.js',
  'utils/ga4Realtime/requestPair.js',
  'utils/ga4Realtime/connectionTest.js',
  'utils/ga4Realtime/index.js',
  'routes/geo-live.js',
  'public/js/geo-ga4-realtime-layer.js',
  'public/js/geo-ga4-settings.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js',
  'scripts/static-audit-g1-5-b2.js',
];

function parseSummary(output) {
  // 兩種既有輸出格式都要能解析：
  //   "PASS:  N" / "FAIL:  N" / "TOTAL: N"（多數 smoke test）
  //   "總計：N 項，PASS N，FAIL 0"（geo-map/geo-settings-ui 舊格式）
  //   "OK: N / N"（static audit 舊格式）
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
  const m2 = output.match(/總計[：:]\s*(\d+)\s*項，PASS\s*(\d+)，FAIL\s*(\d+)/);
  if (!pass && m2) { total = Number(m2[1]); pass = Number(m2[2]); fail = Number(m2[3]); }
  const m3 = output.match(/OK:\s*(\d+)\s*\/\s*(\d+)/);
  if (!pass && m3) { pass = Number(m3[1]); total = Number(m3[2]); fail = total - pass; }
  // static-audit-g1-5-*.js 用的是 "N / N OK"（OK 在後面，不是 "OK: N/N"）。
  const m4 = output.match(/(\d+)\s*\/\s*(\d+)\s*OK\b/);
  if (!pass && m4) { pass = Number(m4[1]); total = Number(m4[2]); fail = total - pass; }
  return { pass, fail, total };
}

function runRound(roundNum, tmpRoot) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    // Fresh, isolated temp DB per child -- equivalent "clean DB before each
    // test" semantics as the old real-DB unlink, but never touches the real
    // data/pos.db. dbHelper.createChildDbPath fail-fasts if tmpRoot isn't a
    // verified mkdtemp path.
    const childDbPath = dbHelper.createChildDbPath(tmpRoot, label);
    const childEnv = dbHelper.buildChildEnv(childDbPath, tmpRoot);
    let output = '';
    let crashed = false;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', env: childEnv });
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
    console.log(`${ok ? '[OK]  ' : '[FAIL]'} ${label.padEnd(22)} pass=${pass} fail=${fail} total=${total} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED' : ''}`);
    if (!ok) {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
      console.log('----------------------');
    }
  }
  return { allOk, roundResults };
}

function main() {
  console.log('node --check for all touched files:');
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
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-b2-5');
  let rounds;
  try {
    rounds = [];
    for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i, tmpRoot));
  } finally {
    cleanupRoot();
  }

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  // 三輪數字是否完全一致（同一 suite 三輪的 pass/fail/total 相同）
  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} ${roundCount}輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.5-B2.5');
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  temp DB root residue: ${fs.existsSync(tmpRoot) ? 'YES (BAD)' : 'no'}`);
  console.log(`  real data/pos.db: never touched by this runner (Stage 3A remediated)`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
