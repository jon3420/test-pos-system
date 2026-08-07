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
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// [scriptPath, expectedPass, expectedTotal, label]
const SUITE = [
  // ── GA4-H1（本輪新增，五個測試層）──
  ['scripts/run-g1-6-ga4-h1-qa.js', 22, 22, 'GA4-H1 QA Harness'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-credential-guard.js', 17, 17, 'GA4-H1 Credential Guard'],
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2：以下兩個期望值 73/73、166/166
  // 為 Category B（Outdated Assertion）——已於 H1.2 修正為真實現況 81/81、
  // 190/190（在 H1.2 修改後與未修改的 H1.1-AUTH baseline 上重新各自驗證
  // 三輪，結果完全相同，證明是這支 Runner 腳本本身數字陳舊，不是本輪程式
  // 邏輯或迴歸造成，也不是本輪造成兩者不一致）。詳見
  // R5.4-G1.6-GA4-H1.2-UNIQUE-ADMIN_TEST_REPORT.md 第五節。
  ['scripts/run-g1-6-ga4-h1-frontend-runtime.js', 81, 81, 'GA4-H1 Frontend Runtime'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1.js', 108, 108, 'GA4-H1 Targeted Smoke'],
  ['scripts/static-audit-g1-6-ga4-h1.js', 190, 190, 'GA4-H1 Static Audit'],

  // ── Shared GA4 Client / A2-T1 / geo-live ──
  ['scripts/smoke-g1-6-a2-t1-client-ip-trust-diagnostic.js', 12, 12, 'A2-T1 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js', 140, 140, 'G1.5-A Smoke'],
  ['scripts/static-audit-g1-5-a.js', 77, 77, 'G1.5-A Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js', 212, 212, 'G1 geo-live'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js', 190, 190, 'A1.2.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-2-1.js', 106, 106, 'A1.2.1 Static Audit'],
  ['scripts/run-g1-6-a1-2-1-manual-qa.js', 41, 41, 'A1.2.1 QA'],

  // ── 沿用既有已驗證清單（scripts/run-regression-g1-6-a1-2.js）──
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
  ['scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js', 620, 620, 'Geo Map Settings'],
  ['scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js', 157, 157, 'Geo Settings UI'],
];

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
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
  const tmpDbs = fs.readdirSync(require('os').tmpdir()).filter((f) => /ga4-h1.*\.db$/.test(f));
  if (tmpDbs.length) issues.push(`temp DB residue: ${tmpDbs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
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
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
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

  const rounds = [];
  for (let i = 1; i <= 3; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 三輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1');
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  3 rounds all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  3 rounds consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  data/pos.db residue: ${fs.existsSync(DB_FILE) ? 'YES (BAD)' : 'no'}`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
