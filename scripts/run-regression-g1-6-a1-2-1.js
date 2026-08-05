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
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// [scriptPath, expectedPass, expectedTotal, label, opts?]
// QA Harness 的 script path 帶一個第五參數 { args: ['--check-only'] } 不需要
// （non-serve 模式本身就是一次性跑完就結束，不需額外參數）。
const SUITE = [
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js', 190, 190, 'A1.2.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-2-1.js', 106, 106, 'A1.2.1 Static Audit'],
  ['scripts/run-g1-6-a1-2-1-manual-qa.js', 41, 41, 'A1.2.1 QA Harness'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-authoritative-points.js', 251, 251, 'A1.2 Smoke'],
  ['scripts/static-audit-g1-6-a1-2.js', 125, 125, 'A1.2 Static Audit'],
  ['scripts/verify-authoritative-admin-points.js', 57, 57, 'Catalog Verify'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js', 160, 160, 'A1.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-1.js', 90, 90, 'A1.1 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js', 50, 50, 'A1 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js', 128, 128, 'Order Heatmap'],
  ['scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js', 101, 101, 'Dashboard Rewire'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js', 76, 76, 'B2.5'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js', 139, 139, 'B2.4'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js', 75, 75, 'B2.3'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js', 95, 95, 'B2.2'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js', 85, 85, 'B2.1'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js', 187, 187, 'B2 Settings'],
  ['scripts/static-audit-g1-5-b2.js', 82, 82, 'B2 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js', 106, 106, 'B2a'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js', 168, 168, 'B1'],
  ['scripts/static-audit-g1-5-b1.js', 71, 71, 'B1 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js', 140, 140, 'G1.5-A'],
  ['scripts/static-audit-g1-5-a.js', 77, 77, 'G1.5-A Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js', 620, 620, 'Geo Map Settings'],
  ['scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js', 157, 157, 'Geo Settings UI'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js', 212, 212, 'G1 geo-live'],
];

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

function residueCheck() {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db 存在');
  const tmpQaFiles = fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('qa-geo-store-'));
  if (tmpQaFiles.length > 0) issues.push(`QA temp DB 殘留: ${tmpQaFiles.join(', ')}`);
  return issues;
}

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    let output = '';
    let crashed = false;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
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
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const residue = residueCheck();
  if (residue.length > 0) { allOk = false; console.log(`[RESIDUE] ${residue.join('; ')}`); }
  return { allOk, roundResults, residue };
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

  const rounds = [];
  for (let i = 1; i <= 3; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 三輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1');
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  3 rounds all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  3 rounds consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  data/pos.db residue: ${fs.existsSync(DB_FILE) ? 'YES (BAD)' : 'no'}`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
