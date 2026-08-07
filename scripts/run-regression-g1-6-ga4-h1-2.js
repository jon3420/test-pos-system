#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-2.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2
//
// 正式 H1.2 Regression Runner。每個 Suite 都在獨立的 child process 執行
// （execFileSync 各自開一個新的 node process），Mutation Test 用到的任何
// in-memory monkey-patch／module cache 修改天然無法跨 process 殘留到下一個
// Suite——這就是需求文件七要求的「process 隔離」，不需要額外機制。
//
// Classification 只允許三種：
//   PASS                  — 本輪實際數字與期望值完全相符，fail=0，exit=0
//   FAIL                  — 本輪出現非預期失敗（新增迴歸）
//   KNOWN_BASELINE_MISMATCH — 期望值與實際不符，但同一份 Suite 在完全未
//                             修改的 H1.1-AUTH baseline 上跑出來的數字也
//                             一模一樣（見 KNOWN_MISMATCHES 登記表），證明
//                             落差在本輪之前就已存在，不是本輪造成。
//
// 目前登記表為空——本輪唯一發現的兩個歷史 stale expectation（GA4-H1
// Frontend Runtime 73→81、GA4-H1 Static Audit 166→190）已直接在
// scripts/run-regression-g1-6-ga4-h1.js 修正為真實數字（Category B，
// Outdated Assertion，已在 baseline 與 H1.2 兩邊各自重新驗證三輪一致），
// 所以這裡不需要再標記為 mismatch。KNOWN_MISMATCHES 機制保留，供未來若再
// 發現類似情況時使用，不得因為目前是空的就刪除這個機制。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// 登記表：[suiteLabel] -> { note }。目前為空表（見上方說明）。
const KNOWN_MISMATCHES = {};

// [scriptPath, expectedPass, expectedTotal, label]
// expectedPass/expectedTotal 為 null 表示這個 Suite 是「自我完備的
// Runner／report-only 腳本」（自己內部已經跑 3 輪一致性檢查，或本身就是
// 純掃描報告，沒有單一 PASS/TOTAL 數字），只檢查 exit code === 0。
const SUITE = [
  // ══════════════════ H1.2（本輪新增）══════════════════
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
];

const NODE_CHECK_FILES = [
  'utils/taiwanGeoNormalize.js',
  'utils/ga4Realtime/index.js',
  'scripts/audit-taiwan-unique-subdivision-aliases.js',
  'scripts/smoke-hotfix30-b5-r5-4-g1-5-b2-6-unique-subdivision-normalization.js',
  'scripts/static-audit-g1-6-ga4-h1-2.js',
  'scripts/run-regression-g1-6-ga4-h1-2.js',
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

function detectResidue() {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
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

  const rounds = [];
  for (let i = 1; i <= 3; i += 1) rounds.push(runRound(i));

  const allRoundsOk = rounds.every((r) => r.allOk) && checkOk;
  const anyKnownMismatch = rounds.some((r) => r.roundResults.some((x) => x.classification === 'KNOWN_BASELINE_MISMATCH'));

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 三輪數字不一致：${vals.join(' | ')}`); }
  }

  const h1_2Labels = ['H1.2 Unique Alias Audit', 'H1.2 Unique Subdivision Smoke', 'H1.2 Static Audit'];
  const h1_2Fails = rounds.flatMap((r) => r.roundResults).filter((x) => h1_2Labels.includes(x.label) && x.classification === 'FAIL');

  console.log('\n======================================================================');
  console.log('REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.2 (Unique Administrative Subdivision Safe Mapping)');
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  H1.2 new suites FAIL count: ${h1_2Fails.length}`);
  console.log(`  Known baseline mismatches present: ${anyKnownMismatch ? 'YES' : 'NO'}`);
  console.log(`  3 rounds all green (no unexplained FAIL): ${allRoundsOk ? 'YES' : 'NO'}`);
  console.log(`  3 rounds consistent: ${consistent ? 'YES' : 'NO'}`);
  console.log(`  data/pos.db residue: ${fs.existsSync(DB_FILE) ? 'YES (BAD)' : 'no'}`);
  console.log('======================================================================');

  process.exitCode = (allRoundsOk && consistent) ? 0 : 1;
}

main();
