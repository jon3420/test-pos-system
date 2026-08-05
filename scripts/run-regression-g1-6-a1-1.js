#!/usr/bin/env node
// scripts/run-regression-b2-5.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.1
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
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// [scriptPath, expectedPass, expectedTotal, label]
const SUITE = [
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js', 160, 160, 'G1.6-A1.1 Smoke'],
  ['scripts/static-audit-g1-6-a1-1.js', 90, 90, 'G1.6-A1.1 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js', 50, 50, 'G1.6-A1 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-3-a1-geo-heatmap.js', 128, 128, 'Order Heatmap (A1)'],
  ['scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js', 101, 101, 'Dashboard Rewire'],
  ['scripts/static-audit-g1.js', 30, 30, 'Static Audit G1'],
  ['scripts/static-audit-g1-2.js', 37, 37, 'Static Audit G1.2'],
  ['scripts/static-audit-g1-3.js', 32, 32, 'Static Audit G1.3'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-5-district-normalization.js', 76, 76, 'B2.5 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-4-ga4-city-partial.js', 139, 139, 'B2.4 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-3-ga4-endpoint-unification.js', 75, 75, 'B2.3 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-2-ga4-layer-auth.js', 95, 95, 'B2.2 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-1-ga4-settings-persistence.js', 85, 85, 'B2.1 Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-ga4-settings.js', 187, 187, 'B2 Settings Smoke'],
  ['scripts/static-audit-g1-5-b2.js', 82, 82, 'B2 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b2a-ga4-settings-ui.js', 106, 106, 'B2a Smoke'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-b1-ga4-frontend-choropleth.js', 168, 168, 'B1 Smoke'],
  ['scripts/static-audit-g1-5-b1.js', 71, 71, 'B1 Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-5-a-ga4-backend-correctness.js', 140, 140, 'G1.5-A Smoke'],
  ['scripts/static-audit-g1-5-a.js', 77, 77, 'G1.5-A Static Audit'],
  ['scripts/smoke-hotfix30-b5-r5-2-b2-geo-map.js', 620, 620, 'Geo Map Settings'],
  ['scripts/smoke-hotfix30-b5-r5-2-b3-geo-settings-ui.js', 157, 157, 'Geo Settings UI'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js', 212, 212, 'G1 geo-live'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-4-1-dark-card-metric-rendering.js', 149, 149, 'G1.4.1'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-4-map-label-rendering.js', 148, 148, 'G1.4'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-3-2-regression-guard.js', 148, 148, 'G1.3.2'],
  ['scripts/smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js', 83, 83, 'G1.2'],
  ['scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js', 229, 229, 'A2'],
  ['scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js', 189, 189, 'A1.2'],
  ['scripts/static-audit-g1-4-1.js', 56, 56, 'Static Audit G1.4.1'],
  ['scripts/static-audit-g1-4.js', 52, 52, 'Static Audit G1.4'],
  ['scripts/static-audit-g1-3-2.js', 48, 48, 'Static Audit G1.3.2'],
];

const NODE_CHECK_FILES = [
  'public/js/geo-marker-renderer.js',
  'public/js/geo-visitor-layer.js',
  'public/js/geo-live-layer.js',
  'public/js/geo-heatmap.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-1-runtime-wiring.js',
  'scripts/static-audit-g1-6-a1-1.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-6-a1-marker-unification.js',
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

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    let output = '';
    let crashed = false;
    try {
      output = execFileSync(process.execPath, [path.join(ROOT, rel)], { cwd: ROOT, encoding: 'utf8' });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
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
  if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
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

  const rounds = [];
  for (let i = 1; i <= 3; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;

  // 三輪數字是否完全一致（同一 suite 三輪的 pass/fail/total 相同）
  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 三輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-A1.1');
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  3 rounds all green: ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  3 rounds consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  data/pos.db residue: ${fs.existsSync(DB_FILE) ? 'YES (BAD)' : 'no'}`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
