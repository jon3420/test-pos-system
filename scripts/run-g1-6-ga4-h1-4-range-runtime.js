#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-range-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — 第三階段
//
// 直接呼叫正式 public/js/geo-range-resolver.js 的 resolveGeoHistoricalRange()。

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
  console.log('RANGE RESOLVER RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (第三階段)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function main() {
  ['public/js/geo-range-resolver.js', 'public/js/date-time-format.js', 'utils/dateTime.js'].forEach((rel) => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
    pass(`0-parse ${rel} node --check 通過`);
  });

  const R = require(path.join(ROOT, 'public/js/geo-range-resolver.js'));
  const resolve = R.resolveGeoHistoricalRange;
  const NOW = new Date('2026-08-07T04:00:00Z'); // Asia/Taipei 2026-08-07（一般白天時刻）

  // ── 1-10：10 個正式 mode 都能成功 resolve ──
  assert(resolve('today', { now: NOW }).ok === true, '1 today PASS');
  assert(resolve('yesterday', { now: NOW }).ok === true, '2 yesterday PASS');
  assert(resolve('single', { singleDate: '2026-08-01', now: NOW }).ok === true, '3 single PASS');
  assert(resolve('7d', { now: NOW }).ok === true, '4 7d PASS');
  assert(resolve('30d', { now: NOW }).ok === true, '5 30d PASS');
  assert(resolve('90d', { now: NOW }).ok === true, '6 90d PASS');
  assert(resolve('180d', { now: NOW }).ok === true, '7 180d PASS');
  assert(resolve('this_year', { now: NOW }).ok === true, '8 this_year PASS');
  assert(resolve('last_year', { now: NOW }).ok === true, '9 last_year PASS');
  assert(resolve('custom', { startDate: '2026-07-01', endDate: '2026-08-07' }).ok === true, '10 custom PASS');

  // ── 11：same-day = 1 ──
  {
    const r = resolve('today', { now: NOW });
    assert(r.startDate === r.endDate && r.dayCount === 1, '11 same-day (today) dayCount=1');
  }
  // ── 12：custom inclusive 38（需求文件十六原始範例）──
  {
    const r = resolve('custom', { startDate: '2026-07-01', endDate: '2026-08-07' });
    assert(r.dayCount === 38, '12 custom inclusive 38（2026-07-01～2026-08-07）', `got ${r.dayCount}`);
  }
  // ── 13：90d exactly 90 ──
  {
    const r = resolve('90d', { now: NOW });
    assert(r.dayCount === 90, '13 90d exactly 90', `got ${r.dayCount}`);
  }
  // ── 14：180d exactly 180 ──
  {
    const r = resolve('180d', { now: NOW });
    assert(r.dayCount === 180, '14 180d exactly 180', `got ${r.dayCount}`);
  }
  // ── 15：ordinary year this_year（Taipei today 2026-08-07）──
  {
    const r = resolve('this_year', { now: NOW });
    assert(r.startDate === '2026-01-01' && r.endDate === '2026-08-07', '15 ordinary year this_year 2026-01-01～2026-08-07', JSON.stringify(r));
  }
  // ── 16：leap-year last_year（今天在 2029，去年 2028 是閏年，須允許 366）──
  {
    const r = resolve('last_year', { now: new Date('2029-03-01T04:00:00Z') });
    assert(r.ok === true && r.startDate === '2028-01-01' && r.endDate === '2028-12-31' && r.dayCount === 366, '16 leap-year last_year 2028 全年 dayCount=366', JSON.stringify(r));
  }
  // ── 17：366 PASS（custom 邊界）──
  {
    const r = resolve('custom', { startDate: '2028-01-01', endDate: '2028-12-31' });
    assert(r.ok === true && r.dayCount === 366, '17 custom 366 inclusive days PASS', JSON.stringify(r));
  }
  // ── 18：367 FAIL（custom 邊界；span=366 → inclusive=367）──
  {
    const r = resolve('custom', { startDate: '2027-01-01', endDate: '2028-01-02' }); // 367 inclusive days
    assert(r.ok === false && r.code === 'range_too_large', '18 custom 367 inclusive days FAIL range_too_large', JSON.stringify(r));
  }
  // ── 19：leap date（2028-02-29 合法，single 模式）──
  {
    const r = resolve('single', { singleDate: '2028-02-29' });
    assert(r.ok === true && r.startDate === '2028-02-29', '19 leap date 2028-02-29 合法（single）', JSON.stringify(r));
  }
  {
    const rBad = resolve('single', { singleDate: '2027-02-29' }); // 非閏年，不存在
    assert(rBad.ok === false && rBad.code === 'invalid_date_format', '19b 非閏年 2027-02-29 不存在 FAIL invalid_date_format', JSON.stringify(rBad));
  }
  // ── 20：cross-month（custom 跨月）──
  {
    const r = resolve('custom', { startDate: '2026-07-25', endDate: '2026-08-05' });
    assert(r.ok === true && r.dayCount === 12, '20 cross-month custom 2026-07-25～2026-08-05 dayCount=12', JSON.stringify(r));
  }
  // ── 21：cross-year（custom 跨年）──
  {
    const r = resolve('custom', { startDate: '2026-12-20', endDate: '2027-01-05' });
    assert(r.ok === true && r.dayCount === 17, '21 cross-year custom 2026-12-20～2027-01-05 dayCount=17', JSON.stringify(r));
  }
  // ── 22：invalid（格式錯誤／不存在日期）──
  {
    const r1 = resolve('custom', { startDate: 'not-a-date', endDate: '2026-08-07' });
    const r2 = resolve('single', { singleDate: '2026-13-01' });
    assert(r1.ok === false && r1.code === 'invalid_date_format', '22a invalid custom start format FAIL', JSON.stringify(r1));
    assert(r2.ok === false && r2.code === 'invalid_date_format', '22b invalid single 月份 13 FAIL', JSON.stringify(r2));
  }
  // ── 23：start>end ──
  {
    const r = resolve('custom', { startDate: '2026-08-07', endDate: '2026-08-01' });
    assert(r.ok === false && r.code === 'start_after_end', '23 start>end FAIL start_after_end', JSON.stringify(r));
  }
  // ── 24：empty single ──
  {
    const r = resolve('single', { singleDate: '' });
    const r2 = resolve('single', {});
    assert(r.ok === false && r.code === 'missing_single_date', '24a empty singleDate FAIL missing_single_date', JSON.stringify(r));
    assert(r2.ok === false && r2.code === 'missing_single_date', '24b singleDate 完全未提供 FAIL missing_single_date', JSON.stringify(r2));
  }
  // ── 25-27：Taiwan 00:01 / 07:59 / rollover（跟 timezone-parity-runtime 互補：
  // 這裡驗證的是 Resolver 輸出的 startDate/endDate，不是底層 helper 本身）──
  {
    const r = resolve('today', { now: new Date('2026-08-06T16:01:00Z') }); // Asia/Taipei 2026-08-07 00:01
    assert(r.startDate === '2026-08-07', '25 Taiwan 00:01 (UTC 16:01 前一日) → today=2026-08-07', JSON.stringify(r));
  }
  {
    const r = resolve('today', { now: new Date('2026-08-06T23:59:00Z') }); // Asia/Taipei 2026-08-07 07:59
    assert(r.startDate === '2026-08-07', '26 Taiwan 07:59 (UTC 23:59 前一日) → today=2026-08-07', JSON.stringify(r));
  }
  {
    const before = resolve('today', { now: new Date('2026-08-06T15:59:00Z') }); // Taipei 2026-08-06 23:59
    const after = resolve('today', { now: new Date('2026-08-06T16:00:00Z') }); // Taipei 2026-08-07 00:00
    assert(before.startDate === '2026-08-06' && after.startDate === '2026-08-07', '27 Taiwan midnight rollover：UTC 15:59→08-06, UTC 16:00→08-07', JSON.stringify({ before, after }));
  }
  // ── 28：API range mapping ──
  {
    assert(resolve('today', { now: NOW }).apiRange === 'today', '28a today → apiRange=today');
    assert(resolve('yesterday', { now: NOW }).apiRange === 'yesterday', '28b yesterday → apiRange=yesterday');
    assert(resolve('7d', { now: NOW }).apiRange === '7d', '28c 7d → apiRange=7d');
    assert(resolve('30d', { now: NOW }).apiRange === '30d', '28d 30d → apiRange=30d');
    assert(resolve('90d', { now: NOW }).apiRange === 'custom', '28e 90d → apiRange=custom');
    assert(resolve('180d', { now: NOW }).apiRange === 'custom', '28f 180d → apiRange=custom');
    assert(resolve('this_year', { now: NOW }).apiRange === 'custom', '28g this_year → apiRange=custom');
    assert(resolve('last_year', { now: NOW }).apiRange === 'custom', '28h last_year → apiRange=custom');
    assert(resolve('single', { singleDate: '2026-08-01' }).apiRange === 'custom', '28i single → apiRange=custom');
    assert(resolve('custom', { startDate: '2026-08-01', endDate: '2026-08-01' }).apiRange === 'custom', '28j custom → apiRange=custom');
  }
  // ── 29：no second endpoint（本檔案完全不含任何 fetch/URL/endpoint 呼叫
  // ——只檢查真正的程式碼行，排除註解，因為檔頭註解本身會提到既有 API
  // 路徑作為文件說明，那不是「本檔案又打了一次 API」）──
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-range-resolver.js'), 'utf8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert(!/fetch\(|XMLHttpRequest/.test(codeOnly), '29 Resolver 是純函式，程式碼本身完全不含 fetch/XHR 呼叫（不新增第二個 endpoint）');
  }
  // ── 30：no auto sync（程式碼本身不含任何 sync/POST 呼叫，排除註解）──
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'public/js/geo-range-resolver.js'), 'utf8');
    const codeOnly = src.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
    assert(!/\bPOST\b|\.sync\(|syncGeo|runReport/i.test(codeOnly), '30 Resolver 程式碼本身不含任何 POST/sync 呼叫（不自動觸發同步）');
  }

  printSummary();
}

main();
