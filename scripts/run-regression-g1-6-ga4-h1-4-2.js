#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-2.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX
//
// H1.4.2 Full Regression Runner。不修改 scripts/run-regression-g1-6-ga4-h1-4-1.js
// （H1.4.1 final runner 原檔保留不動）。這支新 runner：
//   1. 在執行期直接重新執行 run-regression-g1-6-ga4-h1-4-1.js 原始碼裡「組出
//      最終 SUITE 陣列」那一段程式碼（不是憑印象轉抄、不是手打數字），拿到
//      H1.4.1 真正 inherited 的 unique suite 清單與數量。
//   2. 對其中因本輪（H1.4.2）Intentional Contract Change 而改變的 suite
//      覆寫期待值——全部是 fresh 執行後確認過的真實新數字，理由逐條寫在
//      OVERRIDES 旁的註解裡（Dashboard Sync CTA 取代舊的純文字 empty
//      message／Heatmap Wheel 從 auto-enable 改成 click-to-activate）。
//   3. 加入 H1.4.2 三支新腳本：Browser Target Runtime（117/117）、
//      Persisted Identity Runtime（44/44）、Static Audit（126/126）。
// Process-isolation／Classification／Residue 偵測沿用 H1.4.1 版本同一套
// 邏輯，不重新發明。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// ════════════════════════════════════════════════════════════════
// 1. 重新執行 H1.4.1 runner 原始碼裡「組出最終 SUITE 陣列」的那一段，
//    拿到它真正的 inherited final suite 清單（不是手打轉抄）。
// ════════════════════════════════════════════════════════════════
function parseH141FinalSuite() {
  const rel = 'scripts/run-regression-g1-6-ga4-h1-4-1.js';
  const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
  const marker = 'const SUITE = [...H14_SUITE_UPDATED, ...H141_LEGACY_EXTRA, ...H141_NEW];';
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`[FATAL] 無法在 ${rel} 裡找到 SUITE 組裝那一行，解析邏輯可能已經跟原始碼格式不同步。`);
    process.exit(1);
  }
  const codeUpToSuite = src.slice(0, idx + marker.length).replace(/^#!.*\n/, '');
  const fakeModule = { exports: null };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'require', '__dirname', `${codeUpToSuite}\nmodule.exports = SUITE;`);
  fn(fakeModule, require, path.dirname(path.join(ROOT, rel)));
  return fakeModule.exports;
}
const H141_FINAL_SUITE = parseH141FinalSuite();

{
  const seen = new Set();
  const dups = [];
  H141_FINAL_SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.1 final runner 內部本身有重複 suite path，無法安全繼承：', dups);
    process.exit(1);
  }
  if (H141_FINAL_SUITE.length === 0) {
    console.error('[FATAL] 從 run-regression-g1-6-ga4-h1-4-1.js 解析出的最終 SUITE 是空陣列，解析邏輯可能已經跟原始碼格式不同步。');
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. H1.4.2 Test Migration Count Map（需求文件十一：只能改「expected
//    count」，不能包含「expectedFail > 0」——所有 Intentional Contract
//    Change 造成的舊斷言，本輪已經全部改成符合 H1.4.2 新 Contract 的
//    新斷言，每一支都必須 FAIL=0，沒有任何「已知、可接受的 FAIL」）。
// ════════════════════════════════════════════════════════════════
const OVERRIDES = {
  // Dashboard GA4 Range empty state：舊 Contract 純文字「請至 Heatmap
  // 手動同步」已改成「立即同步並顯示」Sync CTA，相關斷言已 migrate 成
  // 新文案／新 DOM 結構的檢查，全部 59/59 FAIL=0。
  'scripts/run-g1-6-ga4-h1-4-dashboard-source-runtime.js': { pass: 59, total: 59, note: 'H1.4.2 Test Migration: empty-state assertions rewritten for Sync CTA contract (semantic POST/GET separation checks added) — FAIL=0' },
  'scripts/run-g1-6-ga4-h1-4-map-state-runtime.js': { pass: 100, total: 100, note: 'H1.4.2 Test Migration: 同上（Empty-2 empty-state 文案），另加 CTA 存在性檢查 — FAIL=0' },
  // H1.4 Static Audit：E52/E56 改成語意檢查（generation guard 條件本身
  // 不變，只是回傳值從 `return;` 變成 `return { superseded: true };`）；
  // M143/M144 系列改成「Range 切換 GET-only／POST 只在 CTA handler 內／
  // POST 不直接 render／成功後仍走 GET」的完整語意驗證。
  'scripts/static-audit-g1-6-ga4-h1-4.js': { pass: 230, total: 230, note: 'H1.4.2 Test Migration: E52/E56 semantic guard check + M143/M144 rewritten for Sync CTA contract (GET-only range switch, POST-only-in-CTA, no dual render source) — FAIL=0' },
  // H1.4.1 Target Runtime：D14/D15 改成 Heatmap click-to-activate 新
  // Contract；另外，這支 migration 過程中發現並修好一個真實 Production
  // bug（geoDashboardMapBindWheelLifecycle() 的 idempotent 判斷原本只看
  // mapContainerId 字串，沒追蹤實際 DOM element identity，refresh 造成
  // 的 DOM 節點替換會讓 listener 停留在已 detached 的舊節點上）——修好
  // 之後其餘 9 條原本 FAIL 的斷言（D3/D4/D5/D6/D7/D10/IDEMP-3/IDEMP-4/
  // REFRESH-0）全部恢復 PASS，不需要放寬。
  'scripts/run-g1-6-ga4-h1-4-1-geo-dashboard-cleanup-runtime.js': { pass: 112, total: 112, note: 'H1.4.2 Test Migration: D14/D15 rewritten for Heatmap click-to-activate. Real Production Bug #2 fixed (map wheel lifecycle listener orphaned by id-only idempotence after DOM element replacement) — restored the other 9 assertions to PASS without weakening them. FAIL=0' },
  // H1.4.1 Static Audit：E10 改成確認 heatmap 分支呼叫既有
  // geoDashboardMapActivate()、且不再呼叫 geoDashboardMapDeactivateForHeatmap()。
  'scripts/static-audit-g1-6-ga4-h1-4-1.js': { pass: 106, total: 106, note: 'H1.4.2 Test Migration: E10 rewritten for Heatmap click-to-activate (geoDashboardMapActivate() call site, no more auto-enable) — FAIL=0' },
};

const H141_SUITE_UPDATED = H141_FINAL_SUITE.map(([p, pass, total, label]) => {
  if (OVERRIDES[p]) return [p, OVERRIDES[p].pass, OVERRIDES[p].total, label];
  return [p, pass, total, label];
});

// ════════════════════════════════════════════════════════════════
// 3. H1.4.2 新增：Browser Target Runtime／Persisted Identity Runtime／
//    Static Audit（全部 fresh 執行確認過真實 count，且都是 FAIL=0）。
// ════════════════════════════════════════════════════════════════
const H142_NEW = [
  ['scripts/run-g1-6-ga4-h1-4-2-range-map-wheel-runtime.js', 129, 129, 'H1.4.2 Browser Target Runtime (Range/Map/Wheel/Sync CTA/DOM Replacement)'],
  ['scripts/run-g1-6-ga4-h1-4-2-persisted-identity-runtime.js', 44, 44, 'H1.4.2 Persisted Identity Round-Trip Runtime'],
  ['scripts/static-audit-g1-6-ga4-h1-4-2.js', 134, 134, 'H1.4.2 Static Audit'],
];

const SUITE = [...H141_SUITE_UPDATED, ...H142_NEW];

// Final uniqueness gate.
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.2 runner 組出來的最終 SUITE 清單有重複 path：', dups);
    process.exit(1);
  }
}

const NODE_CHECK_FILES = [
  'public/js/geo-ga4-dashboard-layer.js',
  'public/js/geo-heatmap-ui.js',
  'public/js/geo-range-control.js',
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

function classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return (!crashed && exitCode === 0) ? 'PASS' : 'FAIL';
  }
  // 需求文件十、十一：STRICT——沒有任何「已知、可接受的 FAIL」。PASS 只在
  // exit===0 且 fail===0 且 pass/total 都精確吻合 expected 才算。OVERRIDES
  // 只能調整 expected COUNT（因為 Intentional Contract Change 造成斷言內容
  // 改變後的新真實 count），不能也不會調整 expected FAIL（那個永遠是 0）。
  const ok = !crashed && exitCode === 0 && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runRound(roundNum) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  let sumChildFailAssertions = 0;
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      console.log(`[FAIL                 ] ${label.padEnd(60)} <== MISSING SCRIPT: ${rel}`);
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
    const classification = classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
    if (classification === 'FAIL') allOk = false;
    // 需求文件十二：Global Hidden-Failure Guard——即使 pass/total 剛好跟
    // expected 吻合，只要這支 suite 自己回報的 fail > 0，就必須算進
    // sumChildFailAssertions，不能被任何 override 悄悄蓋過去。
    if (typeof fail === 'number' && fail > 0) sumChildFailAssertions += fail;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(60)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}${timedOut ? '  <== TIMEOUT' : ''}`);
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
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function main() {
  console.log('H1.4.2 Full Regression Runner');
  console.log(`  Inherited from H1.4.1 final runner (parsed live): ${H141_FINAL_SUITE.length} unique suites`);
  console.log(`  Overrides for H1.4.2 Intentional Contract Change: ${Object.keys(OVERRIDES).length}`);
  Object.entries(OVERRIDES).forEach(([p, o]) => console.log(`    - ${p}: ${o.pass}/${o.total} — ${o.note}`));
  console.log(`  + H1.4.2 new suites (Browser Target / Persisted Identity / Static): ${H142_NEW.length}`);
  console.log(`  = Total unique suites this round: ${SUITE.length}`);
  console.log('\nnode --check for H1.4.2 touched Production files:');
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
  console.log('H1.4.2 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.2-GA4-RANGE-MAP-WHEEL-UX');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  uniqueSuites: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    console.log(`  Round ${i + 1}: passedSuites=${SUITE.length - r.failedSuiteCount} failedSuites=${r.failedSuiteCount} childFailAssertions=${r.sumChildFailAssertions} residue=${r.residue.length} allOk=${r.allOk}`);
  });
  const assertionMismatch = !consistent ? 1 : 0;
  const exitMismatchTotal = rounds.reduce((acc, r) => acc + r.roundResults.filter((x) => x.exitCode !== 0 && x.expectPass === x.expectTotal).length, 0);
  console.log(`  assertionMismatch: ${assertionMismatch}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
