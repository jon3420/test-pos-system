#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-5.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.5-PRODUCT-EXPOSURE-TO-CART-RATE-QA-full
//
// H1.4.5 Full Regression Runner。不手抄 H1.4.4 的 suite list——在執行期直接重新執行
// scripts/run-regression-g1-6-ga4-h1-4-4.js 原始碼裡「組出最終 SUITE 陣列」那一段
// 程式碼（const SUITE = [...H143_FINAL_SUITE, ...H144_NEW];），拿到 H1.4.4 真正
// inherited 的 72-suite 清單，再加入本輪 H1.4.5 新增的 2 支 suite
// （Product Exposure-to-Cart Rate Runtime／Static-UI Audit）。
//
// Reality Audit 誠實聲明：本輪修改的 4 個 Production 檔案（utils/dashboardAnalytics.js、
// public/js/app.js、public/js/analytics-v2.js、utils/analyticsV2.js）在本輪之前都已經
// 被既有的 72 個 suite 部分覆蓋到（例如商品排行資料流程、Analytics V2 漏斗渲染），但沒有
// 任何既有 suite 專門驗證 view_to_cart_rate 這個新欄位的計算公式與邊界條件，也沒有任何
// 既有 suite 驗證「曝光」這幾個字有沒有正確出現在畫面上。H1.4.5 新增的 2 支 suite 就是
// 第一份專門覆蓋這件事的 regression asset。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// Stage 3A remediation: SUITE is read from the side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation inheritance-resolved
// array, including the exact 74-count invariant this file used to assert at
// runtime). The parseH144FinalSuite() readFileSync+new Function() executor
// is gone -- the catalog already contains the final resolved tuples. Real
// data/pos.db is never touched; each child gets its own mkdtemp-isolated
// temp DB.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1_4_5';
const rawCatalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
if (!rawCatalog.suites || !rawCatalog.suites[CATALOG_KEY]) {
  throw new Error(`[FATAL] Suite catalog missing key "${CATALOG_KEY}" in ${CATALOG_PATH}`);
}
const catalogEntry = rawCatalog.suites[CATALOG_KEY];
if (!Array.isArray(catalogEntry.entries) || catalogEntry.entries.length !== catalogEntry.tupleCount) {
  throw new Error(`[FATAL] Suite catalog entry "${CATALOG_KEY}" is malformed (tupleCount mismatch or entries not an array)`);
}
const SUITE = Object.freeze(catalogEntry.entries.map(([p, pass, total, label]) => {
  const passOk = pass === null || typeof pass === 'number';
  const totalOk = total === null || typeof total === 'number';
  if (typeof p !== 'string' || !passOk || !totalOk || typeof label !== 'string') {
    throw new Error(`[FATAL] Malformed suite tuple in catalog "${CATALOG_KEY}": ${JSON.stringify([p, pass, total, label])}`);
  }
  return Object.freeze([p, pass, total, label]);
}));

// Final uniqueness + exact-count gate (preserved from the original: this
// file's own history shows a real value in asserting the exact expected
// count, not just >0).
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    throw new Error(`[FATAL] H1.4.5 runner 組出來的最終 SUITE 清單有重複 path：${JSON.stringify(dups)}`);
  }
  if (SUITE.length !== 74) {
    throw new Error(`[FATAL] 預期最終應解析出 74 個唯一 suite（72 inherited + 2 new），實際為 ${SUITE.length} 個。`);
  }
}

const NODE_CHECK_FILES = [
  'utils/dashboardAnalytics.js',
  'public/js/app.js',
  'public/js/analytics-v2.js',
  'utils/analyticsV2.js',
  'scripts/run-g1-6-ga4-h1-4-5-exposure-runtime.js',
  'scripts/static-audit-g1-6-ga4-h1-4-5.js',
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
  // H1.4.4／H1.4.5 新增 suite 使用的格式："H1.4.x ... — N/N passed"
  const m7 = output.match(/—\s*(\d+)\/(\d+)\s*passed/);
  if (pass === null && m7) { pass = Number(m7[1]); total = Number(m7[2]); fail = total - pass; }
  if (pass === null) {
    const pM = output.match(/PASS:\s*(\d+)/);
    const fM = output.match(/FAIL:\s*(\d+)/);
    const tM = output.match(/TOTAL:\s*(\d+)/);
    if (pM && fM && tM) { pass = Number(pM[1]); fail = Number(fM[1]); total = Number(tM[1]); }
  }
  return { pass, fail, total };
}

// H1.4.5 測試基礎設施修正（Test Infrastructure Fix）：residue 偵測改成「執行前後
// 快照相減」，而不是單純檢查 os.tmpdir() 目前有沒有符合 pattern 的檔案。
//
// Root Cause（對應交付報告「residue=1 根因」）：舊版寫法只看「這一輪結束時 tmp
// 目錄裡還有沒有殘留」，沒有排除「這個檔案其實是在這一輪開始之前、由更早的一次
// 執行（甚至是同一台機器上完全不相關的操作）留下來的」這種情況——會把不是這一輪
// 造成的殘留，誤算成這一輪的 residue，導致明明這一輪的 74 個 suite 都正確清理，
// 卻被判定 residue>0。改成「開始前拍一張快照、結束後再拍一張快照、只計算快照
// 相減後新增且仍存在的檔案」，才是真正「這一輪造成、而且沒清理」的殘留。
function snapshotTmpMatches() {
  const patterns = [/ga4-h1.*\.db$/, /unique-subdivision.*\.db$/, /h14-mutations.*\.db$/, /^h13-baseline-static-/];
  const all = fs.readdirSync(os.tmpdir());
  const matched = all.filter((f) => patterns.some((re) => re.test(f)));
  return new Set(matched);
}

function detectResidue(preRoundTmpSnapshot, tmpRoot) {
  const issues = [];
  if (tmpRoot && fs.existsSync(tmpRoot)) issues.push('temp DB root: ' + tmpRoot);
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    ['.sqlite', '.sqlite3'].forEach((ext) => {
      if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
    });
  }
  // 只計算「這一輪開始前沒有、這一輪結束時卻還存在」的新增殘留檔案，
  // 不把執行前就已經存在（不是這一輪造成）的檔案算進來。
  const afterSnapshot = snapshotTmpMatches();
  const newLeftovers = [...afterSnapshot].filter((f) => !preRoundTmpSnapshot.has(f));
  if (newLeftovers.length) issues.push(`temp file residue newly created this round: ${newLeftovers.join(', ')}`);
  const mutationTmpJs = [];
  ['public/js', 'services'].forEach((dir) => {
    const full = path.join(ROOT, dir);
    if (fs.existsSync(full)) {
      fs.readdirSync(full).filter((f) => /\.mutation-tmp-/.test(f)).forEach((f) => mutationTmpJs.push(`${dir}/${f}`));
    }
  });
  if (mutationTmpJs.length) issues.push(`mutation temp file residue: ${mutationTmpJs.join(', ')}`);
  if (process.listenerCount('unhandledRejection') > 0) issues.push(`unhandledRejection listeners: ${process.listenerCount('unhandledRejection')}`);
  if (typeof global.jsdom !== 'undefined' || typeof global.window !== 'undefined') issues.push('jsdom global leaked into parent process');
  return issues;
}

function classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut) {
  if (timedOut) return 'FAIL';
  if (expectPass === null && expectTotal === null) {
    return (!crashed && exitCode === 0) ? 'PASS' : 'FAIL';
  }
  // 不得因為沒抓到摘要就放過去——exitCode 與 fail 數字都要明確符合預期，
  // 且 pass/total 必須真的解析得到數字（不能是 undefined/NaN 被 == 混過去）。
  const parsedOk = typeof pass === 'number' && typeof total === 'number' && typeof fail === 'number'
    && Number.isFinite(pass) && Number.isFinite(total) && Number.isFinite(fail);
  const ok = !crashed && exitCode === 0 && parsedOk && fail === 0 && pass === expectPass && total === expectTotal;
  return ok ? 'PASS' : 'FAIL';
}

function runRound(roundNum, tmpRoot) {
  console.log(`\n========================= ROUND ${roundNum} =========================`);
  let allOk = true;
  const roundResults = [];
  let sumChildFailAssertions = 0;
  const preRoundTmpSnapshot = snapshotTmpMatches();
  for (const [rel, expectPass, expectTotal, label] of SUITE) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) {
      console.log(`[FAIL                 ] ${label.padEnd(60)} <== MISSING SCRIPT: ${rel}`);
      roundResults.push({ label, rel, pass: null, fail: null, total: null, expectPass, expectTotal, exitCode: null, classification: 'FAIL', crashed: true, missing: true });
      allOk = false;
      continue;
    }
    const childDbPath = dbHelper.createChildDbPath(tmpRoot, label);
    const childEnv = dbHelper.buildChildEnv(childDbPath, tmpRoot);
    let output = '';
    let crashed = false;
    let exitCode = 0;
    let timedOut = false;
    try {
      // cwd 固定為專案根目錄，避免繼承 suite 因工作目錄不同而讀不到相對路徑檔案；
      // 每個 suite 都是獨立 child process（execFileSync），不共用任何模組快取或
      // 全域狀態，也不會因為前一個 suite 沒清乾淨而互相污染。
      output = execFileSync(process.execPath, [p], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: childEnv });
    } catch (e) {
      output = (e.stdout || '') + (e.stderr || '');
      crashed = true;
      exitCode = e.status === undefined ? 1 : e.status;
      if (e.signal === 'SIGTERM' || /ETIMEDOUT/.test(String(e.code))) timedOut = true;
    } finally {
      dbHelper.cleanupDbFileAndSidecars(childDbPath);
    }
    const { pass, fail, total } = parseSummary(output);
    const classification = classify(expectPass, expectTotal, pass, fail, total, exitCode, crashed, timedOut);
    if (classification === 'FAIL') allOk = false;
    if (typeof fail === 'number' && fail > 0) sumChildFailAssertions += fail;
    roundResults.push({ label, rel, pass, fail, total, expectPass, expectTotal, exitCode, classification, crashed, timedOut });
    console.log(`[${classification.padEnd(22)}] ${label.padEnd(60)} pass=${pass} fail=${fail} total=${total} exit=${exitCode} (expect ${expectPass}/${expectTotal})${crashed ? '  <== CRASHED/NONZERO' : ''}${timedOut ? '  <== TIMEOUT' : ''}`);
    if (classification === 'FAIL') {
      console.log('---- output tail ----');
      console.log(output.split('\n').slice(-25).join('\n'));
      console.log('----------------------');
    }
  }
  const residue = detectResidue(preRoundTmpSnapshot, null);
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function main() {
  console.log('H1.4.5 Full Regression Runner');
  console.log(`  Final resolved suite (from side-effect-free JSON catalog, Stage 3A remediated): ${SUITE.length} unique suites`);
  console.log('\nnode --check for H1.4.5 touched Production/Test files:');
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
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-ga4-h1-4-5');
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
    const vals = rounds.map((r) => JSON.stringify({ p: r.roundResults[s].pass, f: r.roundResults[s].fail, t: r.roundResults[s].total, e: r.roundResults[s].exitCode, c: r.roundResults[s].classification }));
    if (new Set(vals).size !== 1) { consistent = false; console.log(`[INCONSISTENT] ${SUITE[s][3]} 各輪數字不一致：${vals.join(' | ')}`); }
  }

  console.log('\n======================================================================');
  console.log('H1.4.5 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.5-PRODUCT-EXPOSURE-TO-CART-RATE-QA-full');
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
  console.log(`  exitMismatch: ${exitMismatchTotal}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
