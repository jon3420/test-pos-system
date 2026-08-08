#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — 第三階段
//
// utils/dateTime.js（Node）與 public/js/date-time-format.js（Browser，本輪
// 新增 getTaipeiCalendarDateString()）必須對同一個 absolute timestamp
// 得到同一個 Asia/Taipei 日曆日字串（需求文件九）。這裡不重新實作任何
// 日期演算法，兩邊都直接呼叫各自的正式檔案。

'use strict';

const path = require('path');
const { execFileSync } = require('child_process');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('TIMEZONE PARITY RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (第三階段)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function main() {
  ['utils/dateTime.js', 'public/js/date-time-format.js'].forEach((rel) => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
    pass(`0-parse ${rel} node --check 通過`);
  });

  const nodeDt = require(path.join(ROOT, 'utils/dateTime.js'));
  const browserDt = require(path.join(ROOT, 'public/js/date-time-format.js'));

  assert(typeof nodeDt.getTaipeiCalendarDateString === 'function', '0a. Node utils/dateTime.js 匯出 getTaipeiCalendarDateString()');
  assert(typeof browserDt.getTaipeiCalendarDateString === 'function', '0b. Browser date-time-format.js 匯出 getTaipeiCalendarDateString()');

  const CASES = [
    // [label, isoUtc, offsetDays]
    ['Taiwan 00:01（UTC 前一日 16:01）', '2026-08-06T16:01:00Z', 0],
    ['Taiwan 07:59（UTC 前一日 23:59）', '2026-08-06T23:59:00Z', 0],
    ['Taiwan midnight rollover：UTC 15:59', '2026-08-06T15:59:00Z', 0],
    ['Taiwan midnight rollover：UTC 16:00', '2026-08-06T16:00:00Z', 0],
    ['一般白天時刻', '2026-08-07T04:00:00Z', 0],
    ['跨月邊界（8/1 台灣時間）', '2026-07-31T16:05:00Z', 0],
    ['跨年邊界（1/1 台灣時間）', '2025-12-31T16:05:00Z', 0],
    ['閏年 2/29', '2028-02-28T16:05:00Z', 0],
    ['offsetDays=-89（90d 起點語意）', '2026-08-07T04:00:00Z', -89],
    ['offsetDays=-179（180d 起點語意）', '2026-08-07T04:00:00Z', -179],
    ['offsetDays=+1', '2026-08-07T04:00:00Z', 1],
    ['offsetDays=-365（跨閏年）', '2029-01-01T04:00:00Z', -365],
  ];

  for (const [label, iso, offsetDays] of CASES) {
    const d = new Date(iso);
    const nodeResult = nodeDt.getTaipeiCalendarDateString(d, offsetDays);
    const browserResult = browserDt.getTaipeiCalendarDateString(d, offsetDays);
    assert(nodeResult === browserResult, `Parity: ${label} (offsetDays=${offsetDays}) — Node=${nodeResult} Browser=${browserResult}`,
      `Node=${nodeResult} Browser=${browserResult}`);
  }

  // 額外：browser 端沒有 require Node 模組（本輪禁止項）。
  const fs = require('fs');
  const browserSrc = fs.readFileSync(path.join(ROOT, 'public/js/date-time-format.js'), 'utf8');
  const nodeRequireInIIFE = browserSrc.split('module.exports')[0] // 只檢查 IIFE 主體，不含測試用的 module.exports guard
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n'); // 排除註解行，只檢查真正的程式碼
  assert(!/require\(['"]\.\.\/utils\/dateTime/.test(nodeRequireInIIFE), 'Guard: browser helper 沒有 require(\'../utils/dateTime\')');

  printSummary();
}

main();
