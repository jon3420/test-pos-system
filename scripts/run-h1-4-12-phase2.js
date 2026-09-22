#!/usr/bin/env node
// scripts/run-h1-4-12-phase2.js
// H1.4.12 Phase 2 orchestrator：依序執行（各自獨立 child process，各自獨立
// 暫存 DB／port，避免互相污染）：
//   1. Phase 1.2 migration smoke test（scripts/smoke-h1-4-12-popup-migration.js）
//   2. popup state resolver test（scripts/smoke-h1-4-12-popup-state.js）× TZ=UTC/Asia-Taipei/Asia-Tokyo
//   3. popup admin API test（scripts/smoke-h1-4-12-popup-admin-api.js）× TZ=UTC/Asia-Taipei/Asia-Tokyo
//
// 任一 child process exit code 非 0 → 本程序最終 exit 1。
// 不吞掉 stderr（直接透傳到本程序的 stderr）。
// 不使用「檔案存在」或 regex 檢查冒充 runtime 測試——全部是真的 child process
// 執行、真的 exit code。

'use strict';

const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NODE = process.execPath;

const suites = [
  { label: 'Phase 1.2 migration', script: 'scripts/smoke-h1-4-12-popup-migration.js', tz: null },
  { label: 'popup state resolver', script: 'scripts/smoke-h1-4-12-popup-state.js', tz: 'UTC' },
  { label: 'popup state resolver', script: 'scripts/smoke-h1-4-12-popup-state.js', tz: 'Asia/Taipei' },
  { label: 'popup state resolver', script: 'scripts/smoke-h1-4-12-popup-state.js', tz: 'Asia/Tokyo' },
  { label: 'popup admin API', script: 'scripts/smoke-h1-4-12-popup-admin-api.js', tz: 'UTC' },
  { label: 'popup admin API', script: 'scripts/smoke-h1-4-12-popup-admin-api.js', tz: 'Asia/Taipei' },
  { label: 'popup admin API', script: 'scripts/smoke-h1-4-12-popup-admin-api.js', tz: 'Asia/Tokyo' },
  { label: 'Phase 2.1 corrective audit', script: 'scripts/smoke-h1-4-12-popup-phase2-1-audit.js', tz: 'UTC' },
  { label: 'Phase 2.1 corrective audit', script: 'scripts/smoke-h1-4-12-popup-phase2-1-audit.js', tz: 'Asia/Taipei' },
  { label: 'Phase 2.1 corrective audit', script: 'scripts/smoke-h1-4-12-popup-phase2-1-audit.js', tz: 'Asia/Tokyo' },
];

function extractSummary(stdout) {
  const m = stdout.match(/PASS:\s*(\d+)[\s\S]*?FAIL:\s*(\d+)[\s\S]*?TOTAL:\s*(\d+)/);
  if (m) return { pass: Number(m[1]), fail: Number(m[2]), total: Number(m[3]) };
  return null;
}

function main() {
  console.log('======================================================================');
  console.log('H1.4.12 Phase 2 Orchestrator — run-h1-4-12-phase2.js');
  console.log(`Node: ${process.version}  Host default TZ: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  console.log('======================================================================\n');

  const rows = [];
  let overallExit = 0;

  suites.forEach((s, idx) => {
    const env = { ...process.env };
    if (s.tz) env.TZ = s.tz; else delete env.TZ;
    // 每個 suite 各自獨立的暫存 DB／port（各測試腳本內部自己用 fs.mkdtempSync
    // 建立暫存目錄並在結束時清除，這裡不重複處理，只需確保不同 child process
    // 之間不共用同一個 POS_DB_PATH 環境變數殘留）。
    delete env.POS_DB_PATH;

    const label = `[${idx + 1}/${suites.length}] ${s.label}${s.tz ? ` (TZ=${s.tz})` : ''}`;
    console.log(`\n---- ${label} ----`);
    console.log(`command: ${s.tz ? `TZ=${s.tz} ` : ''}node ${s.script}`);

    const result = spawnSync(NODE, [s.script], { cwd: ROOT, env, encoding: 'utf8' });

    // 不吞掉 stderr：直接印出來（不截斷、不 swallow）。
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    const summary = extractSummary(result.stdout || '');
    const exitCode = result.status === null ? 1 : result.status; // null 代表被 signal 中止，視為失敗
    if (exitCode !== 0) overallExit = 1;

    rows.push({
      label: s.label,
      tz: s.tz || '(none)',
      exitCode,
      pass: summary ? summary.pass : 'N/A',
      fail: summary ? summary.fail : 'N/A',
      total: summary ? summary.total : 'N/A',
    });

    console.log(`---- ${label}: exit=${exitCode}${summary ? ` PASS=${summary.pass} FAIL=${summary.fail} TOTAL=${summary.total}` : ' (無法解析 summary)'} ----`);
  });

  console.log('\n======================================================================');
  console.log('H1.4.12 Phase 2 Orchestrator — 總表');
  console.log('======================================================================');
  console.log('Suite                      | TZ           | Exit | PASS | FAIL | TOTAL');
  console.log('---------------------------|--------------|------|------|------|------');
  rows.forEach((r) => {
    console.log(
      `${r.label.padEnd(27)}| ${String(r.tz).padEnd(13)}| ${String(r.exitCode).padEnd(5)}| ${String(r.pass).padEnd(5)}| ${String(r.fail).padEnd(5)}| ${r.total}`
    );
  });
  console.log('======================================================================');
  console.log(overallExit === 0 ? 'OVERALL: ALL SUITES PASSED (exit 0 全數)' : 'OVERALL: 至少一個 suite 失敗（見上表 Exit 欄非 0 者）');
  console.log('======================================================================');

  process.exit(overallExit);
}

main();
