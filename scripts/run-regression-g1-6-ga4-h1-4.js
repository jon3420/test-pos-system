#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE
//
// 正式 H1.4 Full Regression Runner。以 scripts/run-regression-g1-6-ga4-h1-3.js
// 的完整 SUITE list（43 支，逐一核對過，不是憑印象重列）為唯一基線，在
// 最後面 append 本輪 H1.4 新增的 12 個 Suite，以及一支原本就存在但沒被
// H1.3 Runner 收進去的 Inherited Hash Smoke（見 Stage 5.1：
// smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js 對
// geo-heatmap.js 的舊 sha256 期望值已證實是 R5.3-A1 之後某次合法修改留下
// 的 stale expectation，H1.4 修正成真實 H1.3 baseline 雜湊，Test-only
// Diff，不計入 Production Diff）。
//
// Process-isolation 設計、Classification 規則（PASS / FAIL /
// KNOWN_BASELINE_MISMATCH）全部沿用 H1.3 版本，不重新發明。

'use strict';


const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// 登記表：[suiteLabel] -> { note }。目前為空表——本輪沒有發現任何新的
// Stale Expectation／Baseline Mismatch。
const KNOWN_MISMATCHES = {};

// [scriptPath, expectedPass, expectedTotal, label]
const SUITE = [
  // ══════════════════ H1.3（本輪新增，見需求文件十三）══════════════════
  ['scripts/run-g1-6-ga4-h1-3-request-builder-contract.js', 68, 68, 'H1.3 Request Builder Contract'],
  ['scripts/run-g1-6-ga4-h1-3-event-compat-connection-test.js', 48, 48, 'H1.3 Event Compat Connection Test'],
  ['scripts/run-g1-6-ga4-h1-3-realtime-event-runtime.js', 65, 65, 'H1.3 Realtime Event Runtime'],
  ['scripts/run-g1-6-ga4-h1-3-historical-runtime.js', 44, 44, 'H1.3 Historical Runtime'],
  ['scripts/run-g1-6-ga4-h1-3-mutations.js', 37, 37, 'H1.3 Mutation Suite'],
  ['scripts/static-audit-g1-6-ga4-h1-3.js', 63, 63, 'H1.3 Static Audit'],

  // ══════════════════ H1.2 ══════════════════
  ['scripts/audit-taiwan-unique-subdivision-aliases.js', null, null, 'H1.2 Unique Alias Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js', 82, 82, 'H1.2 Unique Subdivision Smoke'],
  ['scripts/static-audit-g1-6-ga4-h1-2.js', 36, 36, 'H1.2 Static Audit'],

  // ══════════════════ B2.5 / B2.4 / G1 geo-live ══════════════════
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js', 76, 76, 'B2.5 District Normalization'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js', 139, 139, 'B2.4 City Partial'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js', 212, 212, 'G1 geo-live'],

  // ══════════════════ G1.5-A ══════════════════
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js', 140, 140, 'G1.5-A Smoke'],
  ['scripts/static-audit-g1-5-a.js', 77, 77, 'G1.5-A Static Audit'],

  // ══════════════════ H1 (GA4-H1) ══════════════════
  ['scripts/run-g1-6-ga4-h1-qa.js', 22, 22, 'H1 QA'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-credential-guard.js', 17, 17, 'H1 Credential Guard'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1.js', 108, 108, 'H1 Targeted Smoke'],
  ['scripts/static-audit-g1-6-ga4-h1.js', 190, 190, 'H1 Static Audit'],
  ['scripts/run-g1-6-ga4-h1-frontend-runtime.js', 81, 81, 'H1 Frontend Runtime'],

  // ══════════════════ H1.1 Auth ══════════════════
  ['scripts/run-g1-6-ga4-h1-1-browser-auth-runtime.js', 47, 47, 'H1.1 Browser Auth Runtime'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1-1-auth-mutations.js', 24, 24, 'H1.1 Auth Mutation'],
  ['scripts/run-g1-6-ga4-h1-1-ga4-diagnostic-contract.js', 40, 40, 'H1.1 Diagnostic Contract'],

  // ══════════════════ A1.2 / A1.2.1 / A1.1 / A1 ══════════════════
  ['scripts/verify-authoritative-admin-points.js', 57, 57, 'A1.2 Catalog Verify'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-authoritative-points.js', 251, 251, 'A1.2 Smoke'],
  ['scripts/static-audit-g1-6-a1-2.js', 125, 125, 'A1.2 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-2-1-time-and-marker-qa.js', 190, 190, 'A1.2.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-2-1.js', 106, 106, 'A1.2.1 Static Audit'],
  ['scripts/run-g1-6-a1-2-1-manual-qa.js', 41, 41, 'A1.2.1 QA'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js', 160, 160, 'A1.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-1.js', 90, 90, 'A1.1 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js', 50, 50, 'A1 Smoke'],

  // ══════════════════ Geo Map / Settings / 其餘既有 B1/B2 ══════════════════
  ['scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js', 620, 620, 'Geo Map Settings'],
  ['scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js', 157, 157, 'Geo Settings UI'],
  ['scripts/smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js', 128, 128, 'Order Heatmap'],
  ['scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js', 101, 101, 'Dashboard Rewire'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js', 75, 75, 'B2.3'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js', 95, 95, 'B2.2'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js', 85, 85, 'B2.1'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js', 187, 187, 'B2 Settings'],
  ['scripts/static-audit-g1-5-b2.js', 82, 82, 'B2 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js', 106, 106, 'B2a'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js', 168, 168, 'B1'],
  ['scripts/smoke-g1-6-a2-t1-client-ip-trust-diagnostic.js', 12, 12, 'A2-T1 Smoke'],

  // ══════════════════ H1.4 MAP-STATE（本輪新增，見需求文件二）══════════════════
  ['scripts/run-g1-6-ga4-h1-4-layer-cleanup-runtime.js', 30, 30, 'H1.4 Layer Cleanup Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-range-backend-runtime.js', 25, 25, 'H1.4 Range Backend Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js', 17, 17, 'H1.4 Timezone Parity Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-range-runtime.js', 45, 45, 'H1.4 Range Resolver Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-range-ui-runtime.js', 37, 37, 'H1.4 Range UI Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-h1-range-integration-runtime.js', 35, 35, 'H1.4 H1 Range Integration Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-persisted-range-runtime.js', 23, 23, 'H1.4 Persisted Range Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-dashboard-source-runtime.js', 55, 55, 'H1.4 Dashboard Source Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-map-state-runtime.js', 99, 99, 'H1.4 Map State Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-lifecycle-aba-runtime.js', 22, 22, 'H1.4 Lifecycle ABA Runtime'],
  ['scripts/run-g1-6-ga4-h1-4-map-state-mutations.js', 30, 30, 'H1.4 Mutation Suite'],
  ['scripts/run-g1-6-ga4-h1-4-browser-entry-runtime.js', 24, 24, 'H1.4 Browser Entry Runtime'],
  ['scripts/static-audit-g1-6-ga4-h1-4.js', 227, 227, 'H1.4 Static Audit'],

  // ══════════════════ Inherited SHA Smoke（見需求文件三：H1.3 Runner 原本沒有這支，這輪補上）══════════════════
  ['scripts/smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js', 112, 112, 'Inherited Hash Smoke (Heatmap-Dashboard Integration)'],
];

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
  // ══════════════════ H1.4 新增/修改檔案 ══════════════════
  'public/js/date-time-format.js',
  'public/js/geo-ga4-dashboard-layer.js',
  'public/js/geo-heatmap-ui.js',
  'public/js/geo-range-control.js',
  'public/js/geo-range-resolver.js',
  'public/js/geo-intelligence.js',
  'scripts/run-g1-6-ga4-h1-4-layer-cleanup-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-range-backend-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-range-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-range-ui-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-h1-range-integration-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-persisted-range-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-dashboard-source-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-map-state-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-lifecycle-aba-runtime.js',
  'scripts/run-g1-6-ga4-h1-4-map-state-mutations.js',
  'scripts/static-audit-g1-6-ga4-h1-4.js',
  'scripts/run-g1-6-ga4-h1-4-browser-entry-runtime.js',
  'scripts/smoke-hotfix30-b5-r5-3-a1-1-heatmap-dashboard-integration.js',
];

function parseSummary(output) {
  let pass = null; let fail = null; let total = null;
  const m1 = output.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m1) { pass = Number(m1[1]); fail = Number(m1[2]); total = Number(m1[3]); }
  // H1.4 static-audit-g1-6-ga4-h1-4.js 用 "OK:"（不是 "PASS:"）當通過項目標籤。
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
  return { pass, fail, total };
}

function detectResidue() {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
  ['.sqlite', '.sqlite3'].forEach((ext) => {
    if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
  });
  const tmpDbs = fs.readdirSync(os.tmpdir()).filter((f) => /ga4-h1.*\.db$|unique-subdivision.*\.db$|h14-mutations.*\.db$/.test(f));
  if (tmpDbs.length) issues.push(`temp DB residue: ${tmpDbs.join(', ')}`);
  // H1.4 Mutation Suite（run-g1-6-ga4-h1-4-map-state-mutations.js）在
  // public/js/、services/ 底下寫入 *.mutation-tmp-<pid>.js 暫存檔（原因見
  // 該檔案註解：mutated copy 必須跟原始檔案同資料夾，相對 require 才能
  // 正確解析），跑完必須自行清乾淨，這裡再做一次外部確認。
  const mutationTmpJs = [];
  ['public/js', 'services'].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      fs.readdirSync(full).filter((f) => /\.mutation-tmp-/.test(f)).forEach((f) => mutationTmpJs.push(`${dir}/${f}`));
    }
  });
  if (mutationTmpJs.length) issues.push(`mutation temp file residue: ${mutationTmpJs.join(', ')}`);
  // Static Audit（static-audit-g1-6-ga4-h1-4.js）解壓 H1.3 baseline zip 到
  // os.tmpdir() 做逐位元組比對，理應每次都自行清除；這裡再次外部確認。
  const baselineTmpDirs = fs.readdirSync(os.tmpdir()).filter((f) => /^h13-baseline-static-/.test(f));
  if (baselineTmpDirs.length) issues.push(`baseline temp extraction residue: ${baselineTmpDirs.join(', ')}`);
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

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    const envBefore = JSON.stringify(Object.keys(process.env).sort());
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
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
  const residue = detectResidue();
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

  const roundCount = Number(process.argv[2]) > 0 ? Number(process.argv[2]) : 3;
  const rounds = [];
  for (let i = 1; i <= roundCount; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;
  const anyKnownMismatch = rounds.some((r) => r.roundResults.some((x) => x.classification === 'KNOWN_BASELINE_MISMATCH'));

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 三輪數字不一致：${vals.join(' | ')}`); }
  }

  const h1_4Labels = ['H1.4 Layer Cleanup Runtime', 'H1.4 Range Backend Runtime', 'H1.4 Timezone Parity Runtime',
    'H1.4 Range Resolver Runtime', 'H1.4 Range UI Runtime', 'H1.4 H1 Range Integration Runtime',
    'H1.4 Persisted Range Runtime', 'H1.4 Dashboard Source Runtime', 'H1.4 Map State Runtime',
    'H1.4 Lifecycle ABA Runtime', 'H1.4 Mutation Suite', 'H1.4 Browser Entry Runtime', 'H1.4 Static Audit',
    'Inherited Hash Smoke (Heatmap-Dashboard Integration)'];
  const h1_4Fails = rounds.flatMap((r) => r.roundResults).filter((x) => h1_4Labels.includes(x.label) && x.classification === 'FAIL');

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE');
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  H1.4 new suites FAIL count: ${h1_4Fails.length}`);
  console.log(`  Known baseline mismatches present: ${anyKnownMismatch ? 'YES' : 'NO'}`);
  console.log(`  3 rounds all green (no unexplained FAIL): ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  3 rounds consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  data/pos.db residue: ${fs.existsSync(DB_FILE) ? 'YES (BAD)' : 'no'}`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
