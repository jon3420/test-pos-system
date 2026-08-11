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
const DB_FILE = path.join(ROOT, 'data', 'pos.db');

// ════════════════════════════════════════════════════════════════
// 1. 重新執行 H1.4.4 runner 原始碼裡「組出最終 SUITE 陣列」的那一段，
//    拿到它真正的 inherited final suite 清單（不是手打轉抄）。
//
//    已知問題修復：用 new Function() 執行擷取出來的原始碼片段時，該片段內部
//    會呼叫 require(...)、使用 __dirname，且它本身可能包含 module.exports 賦值
//    （雖然 H1.4.4 是在片段之後才手動加 module.exports = SUITE;，但為了保險，這裡
//    一律把 module／require／__dirname 三個全部當作參數注入，避免片段內任何一處
//    直接引用到外層作用域不存在的 module，導致「module is not defined」而整支
//    runner 在解析階段就先炸掉、後面所有 suite 都沒有機會真正執行。
// ════════════════════════════════════════════════════════════════
function parseH144FinalSuite() {
  const rel = 'scripts/run-regression-g1-6-ga4-h1-4-4.js';
  const abs = path.join(ROOT, rel);
  const src = fs.readFileSync(abs, 'utf8');
  const marker = 'const SUITE = [...H143_FINAL_SUITE, ...H144_NEW];';
  const idx = src.indexOf(marker);
  if (idx === -1) {
    console.error(`[FATAL] 無法在 ${rel} 裡找到 SUITE 組裝那一行，解析邏輯可能已經跟原始碼格式不同步。`);
    process.exit(1);
  }
  const codeUpToSuite = src.slice(0, idx + marker.length).replace(/^#!.*\n/, '');
  const fakeModule = { exports: null };
  // eslint-disable-next-line no-new-func
  const fn = new Function('module', 'require', '__dirname', `${codeUpToSuite}\nmodule.exports = SUITE;`);
  fn(fakeModule, require, path.dirname(abs));
  if (!Array.isArray(fakeModule.exports)) {
    console.error(`[FATAL] 從 ${rel} 解析出來的 SUITE 不是陣列（module.exports=${JSON.stringify(fakeModule.exports)}），解析邏輯可能已經跟原始碼格式不同步。`);
    process.exit(1);
  }
  return fakeModule.exports;
}
const H144_FINAL_SUITE = parseH144FinalSuite();

{
  const seen = new Set();
  const dups = [];
  H144_FINAL_SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.4 final runner 內部本身有重複 suite path，無法安全繼承：', dups);
    process.exit(1);
  }
  if (H144_FINAL_SUITE.length === 0) {
    console.error('[FATAL] 從 run-regression-g1-6-ga4-h1-4-4.js 解析出的最終 SUITE 是空陣列，解析邏輯可能已經跟原始碼格式不同步。');
    process.exit(1);
  }
  if (H144_FINAL_SUITE.length !== 72) {
    console.error(`[FATAL] 預期從 H1.4.4 繼承 72 個 suite，實際解析出 ${H144_FINAL_SUITE.length} 個。解析邏輯或 H1.4.4 原始碼可能已經改變，請人工確認後再繼續，不得靜默忽略這個不一致。`);
    process.exit(1);
  }
}

// ════════════════════════════════════════════════════════════════
// 2. H1.4.5 新增：Product Exposure-to-Cart Rate Runtime／Static-UI Audit
//    （全部 fresh 執行確認過真實 count，且都是 FAIL=0）。
// ════════════════════════════════════════════════════════════════
const H145_NEW = [
  ['scripts/run-g1-6-ga4-h1-4-5-exposure-runtime.js', 31, 31, 'H1.4.5 Product Exposure-to-Cart Rate Runtime (real getProductRanking() + real sql.js DB: 1/1=100, 3/10=30, view=0→null, 1/2=200 no-cap, delisted product, store isolation, date range, channel filter)'],
  ['scripts/static-audit-g1-6-ga4-h1-4-5.js', 40, 40, 'H1.4.5 Static/UI Audit (主儀表板/Analytics V2/AI Insights 曝光語意標籤 + view_to_cart_rate/view_to_add_rate API 欄位未破壞性改名 + GA4 view_item/Meta Pixel/GA4即時地圖 語意保護 Hard Gate)'],
];

const SUITE = [...H144_FINAL_SUITE, ...H145_NEW];

// Final uniqueness gate.
{
  const seen = new Set();
  const dups = [];
  SUITE.forEach(([p]) => { if (seen.has(p)) dups.push(p); seen.add(p); });
  if (dups.length) {
    console.error('[FATAL] H1.4.5 runner 組出來的最終 SUITE 清單有重複 path：', dups);
    process.exit(1);
  }
  if (SUITE.length !== 74) {
    console.error(`[FATAL] 預期最終應解析出 74 個唯一 suite（72 inherited + 2 new），實際為 ${SUITE.length} 個。`);
    process.exit(1);
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

function detectResidue(preRoundTmpSnapshot) {
  const issues = [];
  if (fs.existsSync(DB_FILE)) issues.push('data/pos.db');
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

function runRound(roundNum) {
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
    if (fs.existsSync(DB_FILE)) fs.unlinkSync(DB_FILE);
    let output = '';
    let crashed = false;
    let exitCode = 0;
    let timedOut = false;
    try {
      // cwd 固定為專案根目錄，避免繼承 suite 因工作目錄不同而讀不到相對路徑檔案；
      // 每個 suite 都是獨立 child process（execFileSync），不共用任何模組快取或
      // 全域狀態，也不會因為前一個 suite 沒清乾淨而互相污染。
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
  const residue = detectResidue(preRoundTmpSnapshot);
  if (residue.length) { allOk = false; console.log(`[RESIDUE] Round ${roundNum} flagged: ${residue.join('; ')}`); }
  else { console.log(`[RESIDUE] Round ${roundNum}: clean`); }
  if (sumChildFailAssertions > 0) allOk = false;
  const failedSuiteCount = roundResults.filter((r) => r.classification === 'FAIL').length;
  console.log(`[ROUND ${roundNum} TOTALS] uniqueSuites=${SUITE.length} passedSuites=${SUITE.length - failedSuiteCount} failedSuites=${failedSuiteCount} childFailAssertions=${sumChildFailAssertions} residue=${residue.length} allOk=${allOk}`);
  return { allOk, roundResults, residue, sumChildFailAssertions, failedSuiteCount };
}

function main() {
  console.log('H1.4.5 Full Regression Runner');
  console.log(`  Inherited from H1.4.4 final runner (parsed live): ${H144_FINAL_SUITE.length} unique suites`);
  console.log(`  + H1.4.5 new suites (Product Exposure-to-Cart Rate Runtime / Static-UI Audit): ${H145_NEW.length}`);
  console.log(`  = Total unique suites this round: ${SUITE.length}`);
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
