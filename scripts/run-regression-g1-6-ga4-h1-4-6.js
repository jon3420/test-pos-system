#!/usr/bin/env node
// scripts/run-regression-g1-6-ga4-h1-4-6.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW-QA-full
//
// H1.4.6 Full Regression Runner。不手抄 H1.4.5 的 suite list——在執行期直接重新
// 執行 scripts/run-regression-g1-6-ga4-h1-4-5.js 原始碼裡「組出最終 SUITE 陣列」
// 那一段程式碼（const SUITE = [...H144_FINAL_SUITE, ...H145_NEW];），拿到 H1.4.5
// 真正 inherited 的 74-suite 清單，再加入本輪 H1.4.6 新增的 2 支 suite。
//
// 誠實聲明（對應需求文件三之 3）：本輪新增的 2 個 Production 檔案
// （public/js/product-detail-modal.js、public/css/product-detail-modal.css）以及
// 修改的 2 個既有頁面（public/line-order.html、public/line-shipping.html）之前
// 沒有任何既有 suite 涵蓋「商品詳情 Modal」這個全新互動，H1.4.6 新增的 2 支 suite
// 就是第一份專門覆蓋這件事的 regression asset。
//
// H1.4.5 static audit（scripts/static-audit-g1-6-ga4-h1-4-5.js）已經是 H1.4.5
// inherited chain 的一部分（見 H145_NEW），本輪不需要、也不應該重複新增它——
// 該檔案本輪唯一的變更，是把其中 3 項已確認過期的 view_item Hard Gate 換成
// H1.4.6 新契約（見該檔案內 H1.4.6 CHANGELOG 註解），繼承鏈會自動吃到更新後的
// 版本與新的 PASS/TOTAL 數字，不需要另外複製一份。同理 H1.4.5 exposure runtime
// （scripts/run-g1-6-ga4-h1-4-5-exposure-runtime.js）也已在繼承鏈內，本輪未修改
// 其內容，一樣不重複新增。

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');
const dbHelper = require('./lib/qa-temp-db.js');

// Stage 3A remediation: SUITE is read from the side-effect-free JSON catalog
// (verified byte-identical to the pre-remediation inheritance-resolved
// array, including the exact 76-count invariant this file used to assert at
// runtime). The parseH145FinalSuite() readFileSync+new Function() executor
// is gone -- the catalog already contains the final resolved tuples. Real
// data/pos.db is never touched; each child gets its own mkdtemp-isolated
// temp DB.
const CATALOG_PATH = path.join(ROOT, 'scripts/lib/H1.4.8_REGRESSION_SUITE_CATALOG.json');
const CATALOG_KEY = 'GA4_H1_4_6';
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

// suite path 正規化（統一用 '/' 分隔、去除前後空白），用於去重比對。
function normPath(p) { return String(p).trim().replace(/\\/g, '/'); }

// Final normalize + uniqueness + exact-count gate.
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { const n = normPath(p); if (seen.has(n)) dups.push(n); seen.add(n); });
  if (dups.length) {
    throw new Error(`[FATAL] H1.4.6 runner 組出來的最終 SUITE 清單有重複 path（正規化後比對）：${JSON.stringify(dups)}`);
  }
  if (SUITE.length !== 76) {
    throw new Error(`[FATAL] 預期最終應解析出 76 個唯一 suite（74 inherited + 2 new），實際為 ${SUITE.length} 個。`);
  }
}

const NODE_CHECK_FILES = [
  'public/js/product-detail-modal.js',
  'public/css/product-detail-modal.css', // 非 JS，node --check 會跳過（見下方邏輯），僅列出供人工確認檔案存在
  'public/line-order.html',
  'public/line-shipping.html',
  'public/js/analytics-platforms.js',
  'utils/analyticsLog.js',
  'scripts/run-g1-6-ga4-h1-4-6-runtime.js',
  'scripts/static-audit-g1-6-ga4-h1-4-6.js',
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

function snapshotTmpMatches() {
  const patterns = [/ga4-h1.*\.db$/, /unique-subdivision.*\.db$/, /h14-mutations.*\.db$/, /^h13-baseline-static-/];
  const all = fs.readdirSync(os.tmpdir());
  return new Set(all.filter((f) => patterns.some((re) => re.test(f))));
}

function detectResidue(preRoundTmpSnapshot, tmpRoot) {
  const issues = [];
  if (tmpRoot && fs.existsSync(tmpRoot)) issues.push('temp DB root: ' + tmpRoot);
  if (fs.existsSync(path.join(ROOT, 'data'))) {
    ['.sqlite', '.sqlite3'].forEach((ext) => {
      if (fs.readdirSync(path.join(ROOT, 'data')).some((f) => f.endsWith(ext))) issues.push(`data/*${ext}`);
    });
  }
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
  console.log('H1.4.6 Full Regression Runner');
  console.log(`  Final resolved suite (from side-effect-free JSON catalog, Stage 3A remediated): ${SUITE.length} unique suites`);
  console.log('\nnode --check for H1.4.6 touched Production/Test files (.css skipped, not JS):');
  let checkOk = true;
  for (const rel of NODE_CHECK_FILES) {
    if (rel.endsWith('.css')) { console.log(`  [SKIP] ${rel} (not JS, checked separately for existence)`); if (!fs.existsSync(path.join(ROOT, rel))) { checkOk = false; console.log(`  [FAIL] ${rel} — file missing`); } continue; }
    if (rel.endsWith('.html')) {
      // HTML 檔案的 inline <script> 語法已由 H1.4.6 runtime/static suite 間接涵蓋
      // （對話中已個別用 node --check 驗證過抽取出的 inline script），這裡只確認檔案存在。
      if (!fs.existsSync(path.join(ROOT, rel))) { checkOk = false; console.log(`  [FAIL] ${rel} — file missing`); }
      else console.log(`  [OK]   ${rel} (exists; inline <script> syntax verified separately)`);
      continue;
    }
    try {
      execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
      console.log(`  [OK]   ${rel}`);
    } catch (e) {
      checkOk = false;
      console.log(`  [FAIL] ${rel} — ${e.message.slice(0, 200)}`);
    }
  }

  const roundCount = dbHelper.parseRegressionCliArgs(process.argv.slice(2)).roundCount;
  const { tmpRoot, cleanupRoot } = dbHelper.createOrchestratorTempRoot('regression-ga4-h1-4-6');
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
  console.log('H1.4.6 REGRESSION RUNNER SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.6-PRODUCT-DETAIL-CHECKOUT-FLOW-QA-full');
  console.log(`  Rounds run: ${rounds.length}`);
  console.log(`  UNIQUE SUITES: ${SUITE.length}`);
  console.log(`  node --check: ${checkOk ? 'OK' : 'FAIL'}`);
  console.log(`  Round-to-round consistency: ${consistent ? 'CONSISTENT' : 'INCONSISTENT'}`);
  rounds.forEach((r, i) => {
    const totalPass = r.roundResults.reduce((a, x) => a + (x.pass || 0), 0);
    const totalFail = r.roundResults.reduce((a, x) => a + (x.fail || 0), 0);
    const totalTotal = r.roundResults.reduce((a, x) => a + (x.total || 0), 0);
    console.log(`  Round ${i + 1}: UNIQUE_SUITES=${SUITE.length} PASS=${totalPass} FAIL=${totalFail} TOTAL=${totalTotal} passedSuites=${SUITE.length - r.failedSuiteCount} failedSuites=${r.failedSuiteCount} exit=${r.allOk ? 0 : 1} residue=${r.residue.length}`);
  });
  const assertionMismatch = !consistent ? 1 : 0;
  console.log(`  assertionMismatch: ${assertionMismatch}`);
  console.log(`  residue (last round): ${rounds[rounds.length - 1].residue.length}`);
  console.log('======================================================================');

  if (!allRoundsOk || !consistent) process.exitCode = 1;
}

main();
