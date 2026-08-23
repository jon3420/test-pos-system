#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// 正式 Regression Runner。SUITE 清單裡的每一項都是專案裡真實存在、已經逐一
// 手動確認過真實 PASS/FAIL/TOTAL 的檔案（GA4-H1 五項本輪新增，其餘沿用
// scripts/run-regression-g1-6-a1-2.js 既有清單裡已驗證過的真實檔名與數字，
// 並額外加入 A2-T1／G1 geo-live／A1.2.1 三項）。不得依摘要猜測檔名。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// ════════════════════════════════════════════════════════════════
// Stage 3A remediation (H1.4.8 destructive-script cleanup):
//   - SUITE is read from the side-effect-free JSON catalog (single source of
//     truth, verified byte-identical to the pre-remediation literal array via
//     scripts/lib/H1.4.8_STAGE3A_SUITE_BASELINE.json + deepStrictEqual).
//   - The real data/pos.db is never touched by this runner anymore. Each
//     child gets its own mkdtemp-isolated temp DB via scripts/lib/qa-temp-db.js.
// ════════════════════════════════════════════════════════════════
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1';
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

// 需求文件三：node --check 所有新增／修改過的 JS（本輪 GA4-H1 觸碰過的檔案）。
const NODE_CHECK_FILES = [
  'utils/db.js',
  'utils/ga4Realtime/client.js',
  'utils/ga4Geo/normalize.js',
  'utils/ga4Geo/requestBuilders.js',
  'utils/ga4Geo/parseResponse.js',
  'utils/ga4Geo/productionAdapter.js',
  'utils/ga4Geo/mockAdapter.js',
  'services/ga4GeoSyncService.js',
  'routes/ga4-geo.js',
  'server.js',
  'public/js/geo-ga4-h1-panel.js',
  'public/js/geo-heatmap-ui.js',
  'scripts/run-g1-6-ga4-h1-qa.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1.js',
  'scripts/static-audit-g1-6-ga4-h1.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-credential-guard.js',
  'scripts/run-g1-6-ga4-h1-frontend-runtime.js',
  'scripts/static-audit-g1-5-a.js',
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
  const m5 = output.match(/(\d+)\/(\d+)\s*PASS,\s*(\d+)\s*FAIL/); // GA4-H1 本輪五個新腳本共用格式
  if (pass === null && m5) { pass = Number(m5[1]); total = Number(m5[2]); fail = Number(m5[3]); }
  const m6 = output.match(/PASS=(\d+)\s+FAIL=(\d+)/); // A2-T1 舊格式
  if (pass === null && m6) { pass = Number(m6[1]); fail = Number(m6[2]); total = pass + fail; }
  return { pass, fail, total };
}

function detectResidue() {
  const issues = [];
  const tmpDbs = fs.readdirSync(require('os').tmpdir()).filter((f) => /ga4-h1.*\.db$/.test(f));
  if (tmpDbs.length) issues.push(`temp DB residue: ${tmpDbs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
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
    let exitCode = 0;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
      exitCode = e.status === undefined ? 1 : e.status;
    }
    const { pass, fail, total } = parseSummary(output);
    const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
    if (!ok) allOk = false;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, ok, crashed });
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${label.padEnd(26)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}`);
    if (!ok) {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-20).join('\n'));
      console.log('----------------------');
    }
  }
  const residue = detectResidue();
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  return { allOk, roundResults, residue };
}

function main() {
  console.log('node --check for all touched files:');
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
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('ga4_h1');
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
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} ${roundCount}輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1');
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  ${roundCount} round${roundCount === 1 ? '' : 's'} consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  temp DB root residue: ${fs.existsSync(tmpRoot) ? 'YES (BAD)' : 'no'}`);
  console.log('  real data/pos.db: never touched by this runner (Stage 3A remediated)');
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
