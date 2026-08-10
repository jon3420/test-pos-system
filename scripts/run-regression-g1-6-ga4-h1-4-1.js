#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-1.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.1-GEO-DASHBOARD-CLEANUP
//
// H1.4.1 Full Regression Runner。不修改 scripts/run-regression-g1-6-ga4-h1-4.js
// （H1.4 final 57-suite runner原檔保留不動）。這支新 runner：
//   1. 在執行期直接從 run-regression-g1-6-ga4-h1-4.js 的原始碼解析出它真實
//      的 SUITE tuple array（不是憑文件手打、不是憑印象轉抄），得到 H1.4
//      真正 inherited 的 unique suite 清單與數量（56——見下方 sanity check，
//      跟 H1.4 文件裡「57 suites」的說法有 1 個落差，這裡用程式碼解析出
//      來的真實數字，不是照抄文件）。
//   2. 對其中因本輪 intentional assertion 新增而改變的 suite（目前只有
//      smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js：101→108），覆寫成
//      fresh 執行後確認過的真實新期待值。
//   3. 加入 6 支跟本輪修改直接相關、但沒有被 H1.4 baseline runner 收進去
//      的既有 legacy smoke（c-geo-ui／b1-5／b1-6／a1-2-visitor-geo-sync／
//      a2-geo-event-engine／a7-geo-kpi-single-source），全部用本輪 migration
//      後 fresh 執行確認過的真實 assertion count。
//   4. 加入 H1.4.1 Target Runtime／Static Audit 這兩支新腳本。
// Process-isolation／Classification／Residue 偵測沿用 H1.4 版本同一套邏輯，
// 不重新發明。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// ════════════════════════════════════════════════════════════════
// 1. 從 H1.4 final runner 原始碼解析出真實 SUITE tuple array
// ════════════════════════════════════════════════════════════════
function parseH14Suite() {
  const src = fs.readFileSync(path.join(ROOT, 'scripts/run-regression-g1-6-ga4-h1-4.js'), 'utf8');
  const re = /\['(scripts\/[a-zA-Z0-9._-]+\.js)',\s*(\d+),\s*(\d+),\s*'([^']*)'\]/g;
  const arr = [];
  let m;
  while ((m = re.exec(src))) arr.push([m[1], Number(m[2]), Number(m[3]), m[4]]);
  return arr;
}
const H14_SUITE = parseH14Suite();

// Sanity check：H1.4 inherited set 必須真的是唯一（無重複 path），數量記錄
// 下來但不假設固定為某個數字——用程式碼算出來的當唯一真相。
{
  const seen = new Set();
  const dups = [];
  H14_SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4 baseline runner 內部本身有重複 suite path，無法安全繼承：', dups);
    process.exit(1);
  }
  if (H14_SUITE.length === 0) {
    console.error('[FATAL] 從 run-regression-g1-6-ga4-h1-4.js 解析出的 SUITE 是空陣列，解析邏輯可能已經跟原始碼格式不同步。');
    process.exit(1);
  }
}

// H1.4.1 對「已確認因本輪 intentional 測試遷移而改變」的 suite 覆寫期待值
// ——只有這一支的 assertion count 真的變了（101→108，多出的 7 個全部是
// H1.4.1 新增的 Intentional UI Contract Change 驗證，非隨意更新，見
// smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js 內文註解）。
const OVERRIDES = {
  'scripts/smoke-hotfix30-b5-r5-2-b1-1-dashboard-rewire.js': [108, 108],
};
const H14_SUITE_UPDATED = H14_SUITE.map(([p, pass, total, label]) => {
  if (OVERRIDES[p]) return [p, OVERRIDES[p][0], OVERRIDES[p][1], label];
  return [p, pass, total, label];
});

// ════════════════════════════════════════════════════════════════
// 2. 本輪額外加入：跟 H1.4.1 修改直接相關、但沒被 H1.4 baseline runner
//    收進去的既有 legacy smoke（fresh 執行確認過的真實 count）。
// ════════════════════════════════════════════════════════════════
const H141_LEGACY_EXTRA = [
  ['scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js', 203, 203, 'H1.4.1 Legacy Migration: R5.1-C Geo UI'],
  ['scripts/smoke-hotfix30-b5-r5-2-b1-5-geo-dashboard-ui.js', 315, 315, 'H1.4.1 Legacy Migration: B1-5 Geo Dashboard UI'],
  ['scripts/smoke-hotfix30-b5-r5-2-b1-6-geo-explorer.js', 376, 376, 'H1.4.1 Legacy Migration: B1-6 Geo Explorer'],
  ['scripts/smoke-hotfix30-b5-r5-3-a1-2-visitor-geo-sync.js', 189, 189, 'H1.4.1 Legacy Migration: A1.2 Visitor Geo Sync'],
  ['scripts/smoke-hotfix30-b5-r5-3-a2-geo-event-engine.js', 229, 229, 'H1.4.1 Legacy Migration: A2 Geo Event Engine'],
  ['scripts/smoke-hotfix30-b5-r5-3-a7-geo-kpi-single-source.js', 87, 87, 'H1.4.1 Legacy Migration: A7 Geo KPI Single Source'],
];

// ════════════════════════════════════════════════════════════════
// 3. H1.4.1 新增的 Target Runtime／Static Audit
// ════════════════════════════════════════════════════════════════
const H141_NEW = [
  ['scripts/run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js', 112, 112, 'H1.4.1 Target Runtime'],
  ['scripts/static-audit-g1-6-ga4-h1-4-1.js', 106, 106, 'H1.4.1 Static Audit'],
];

const SUITE = [...H14_SUITE_UPDATED, ...H141_LEGACY_EXTRA, ...H141_NEW];

// Final uniqueness gate（section 五：duplicate suite -> FAIL）。
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.1 runner 組出來的最終 SUITE 清單有重複 path：', dups);
    process.exit(1);
  }
}

const NODE_CHECK_FILES = [
  'public/js/geo-intelligence.js',
  'public/js/geo-intelligence-map.js',
  'public/js/geo-heatmap-ui.js',
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
  // TOTAL/PASS/FAIL 三個 label 可能以「TOTAL 先出現」的順序印出（例如
  // run-g1-6-ga4-h1-4-map-state-runtime.js），補一個不限順序的寬鬆抓法。
  if (pass === null) {
    const pM = output.match(/PASS:\s*(\d+)/);
    const fM = output.match(/FAIL:\s*(\d+)/);
    const tM = output.match(/TOTAL:\s*(\d+)/);
    if (pM && fM && tM) { pass = Number(pM[1]); fail = Number(fM[1]); total = Number(tM[1]); }
  }
  return { pass, fail, total };
}

function detectResidue() {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
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

function classify(rel, expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return (!crashed && exitCode === 0) ? 'PASS' : 'FAIL';
  }
  const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      console.log(`[FAIL                 ] ${label.padEnd(50)} <== MISSING SCRIPT: ${rel}`);
      roundResults.push({ label, rel, pass: null, fail: null, total: null, expectPass, expectTotal, exitCode: null, classification: 'FAIL', crashed: true, missing: true });
      allOk = false;
      continue;
    }
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    let output = '';
    let crashed = false;
    let exitCode = 0;
    let timedOut = false;
    try {
      output = execFileSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000 });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
      exitCode = e.status === undefined ? 1 : e.status;
      if (e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code))) timedOut = true;
    }
    const { pass, fail, total } = parseSummary(output);
    const classification = classify(rel, expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
    if (classification === 'FAIL') allOk = false;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(50)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}${timedOut ? '  <== TIMEOUT' : ''}`);
    if (classification === 'FAIL') {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
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
  console.log('H1.4.1 Full Regression Runner');
  console.log(`  Inherited from H1.4 baseline runner (parsed live): ${H14_SUITE.length} unique suites`);
  console.log(`  + H1.4.1 legacy migration extras: ${H141_LEGACY_EXTRA.length}`);
  console.log(`  + H1.4.1 new suites (Target Runtime / Static): ${H141_NEW.length}`);
  console.log(`  = Total unique suites this round: ${SUITE.length}`);
  console.log('\nnode --check for H1.4.1 touched Production files:');
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

  let consistent = true;
  for (let s = 0; s < SUITE.length; s += 1) {
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 各輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('H1.4.1 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.1-GEO-DASHBOARD-CLEANUP');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  Suites per round: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    const fails = r.roundResults.filter((x) => x.classification === 'FAIL').length;
    console.log(`  Round ${i + 1}: allOk=${r.allOk} fails=${fails} residue=${r.residue.length}`);
  });
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
