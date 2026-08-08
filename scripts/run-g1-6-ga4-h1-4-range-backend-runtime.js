#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-range-backend-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — 第二階段
//
// 直接呼叫正式 services/ga4GeoSyncService.js 的 resolveRangeWindow()，
// 不複製日期算法。驗證 CUSTOM_RANGE_MAX_DAYS = 365（span，exclusive 日期
// 差）等同「最多 366 個 inclusive calendar days」這個 Contract。

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
  console.log('RANGE BACKEND RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (第二階段)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

// inclusiveDaysToDates(startYmd, inclusiveCount) → { start, end }
// 純粹用來「建構測試輸入」的 helper（不是被測邏輯本身，被測邏輯是
// resolveRangeWindow() 自己的 _daysBetween），用 Date.UTC 算日曆天數，
// 不依賴任何專案內部日期模組。
function addDaysUtc(ymd, days) {
  const [y, m, d] = ymd.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function main() {
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'services/ga4GeoSyncService.js')]);
  pass('0-parse services/ga4GeoSyncService.js node --check 通過');

  const svcPath = require.resolve(path.join(ROOT, 'services/ga4GeoSyncService.js'));
  delete require.cache[svcPath];
  const svc = require(svcPath);

  assert(typeof svc.resolveRangeWindow === 'function', '0b. resolveRangeWindow() 已從正式 service 匯出');

  const START = '2026-01-01';

  // 1. same day：span=0，inclusive=1
  {
    const r = svc.resolveRangeWindow('custom', START, START);
    assert(r.ok === true, '1. same day (inclusive=1) PASS');
  }
  // 2. 7 inclusive days → span=6
  {
    const end = addDaysUtc(START, 6);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '2. 7 inclusive days (span=6) PASS');
  }
  // 3. 30 inclusive days → span=29
  {
    const end = addDaysUtc(START, 29);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '3. 30 inclusive days (span=29) PASS');
  }
  // 4. 90 inclusive days → span=89
  {
    const end = addDaysUtc(START, 89);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '4. 90 inclusive days (span=89) PASS');
  }
  // 5. 92 inclusive days → span=91（舊上限剛好在這附近，確認新上限下仍 PASS）
  {
    const end = addDaysUtc(START, 91);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '5. 92 inclusive days (span=91) PASS');
  }
  // 6. 180 inclusive days → span=179
  {
    const end = addDaysUtc(START, 179);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '6. 180 inclusive days (span=179) PASS');
  }
  // 7. 365 inclusive days → span=364
  {
    const end = addDaysUtc(START, 364);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '7. 365 inclusive days (span=364) PASS');
  }
  // 8. 普通年份全年 2027-01-01～2027-12-31 → inclusive=365
  {
    const r = svc.resolveRangeWindow('custom', '2027-01-01', '2027-12-31');
    assert(r.ok === true, '8. 普通年份全年 2027-01-01～2027-12-31（inclusive=365）PASS');
  }
  // 9. 閏年全年 2028-01-01～2028-12-31 → inclusive=366, span=365
  {
    const r = svc.resolveRangeWindow('custom', '2028-01-01', '2028-12-31');
    assert(r.ok === true, '9. 閏年全年 2028-01-01～2028-12-31（inclusive=366, span=365）PASS');
  }
  // 10. 367 inclusive days → span=366 → FAIL range_too_large
  {
    const end = addDaysUtc(START, 366);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === false && r.code === 'range_too_large', '10. 367 inclusive days (span=366) FAIL range_too_large', JSON.stringify(r));
  }
  // 11. start > end
  {
    const r = svc.resolveRangeWindow('custom', '2026-01-10', '2026-01-01');
    assert(r.ok === false && r.code === 'start_after_end', '11. start > end FAIL start_after_end', JSON.stringify(r));
  }
  // 12. invalid YYYY-MM-DD format
  {
    const r = svc.resolveRangeWindow('custom', 'not-a-date', '2026-01-01');
    assert(r.ok === false && r.code === 'invalid_date_format', '12. invalid date format FAIL invalid_date_format', JSON.stringify(r));
  }
  // 13. empty start/end
  {
    const r1 = svc.resolveRangeWindow('custom', '', '2026-01-01');
    const r2 = svc.resolveRangeWindow('custom', '2026-01-01', '');
    const r3 = svc.resolveRangeWindow('custom', null, null);
    assert(r1.ok === false && r1.code === 'missing_custom_range', '13a. empty start FAIL missing_custom_range');
    assert(r2.ok === false && r2.code === 'missing_custom_range', '13b. empty end FAIL missing_custom_range');
    assert(r3.ok === false && r3.code === 'missing_custom_range', '13c. null/null FAIL missing_custom_range');
  }
  // 14. 2028-02-29（合法閏日）在 custom range 內部可用
  {
    const r = svc.resolveRangeWindow('custom', '2028-02-29', '2028-02-29');
    assert(r.ok === true && r.start_date === '2028-02-29' && r.end_date === '2028-02-29', '14. 2028-02-29 合法閏日 PASS');
  }
  // 15. 跨年 range（不是全年，只是單純跨過年份邊界）
  {
    const r = svc.resolveRangeWindow('custom', '2026-12-20', '2027-01-05');
    assert(r.ok === true, '15. 跨年 range（2026-12-20～2027-01-05）PASS');
  }
  // 16（額外）：邊界正上方 366 inclusive → span=365 → PASS（跟 #9 用不同起始日
  // 再驗一次，避免只在閏年全年這一組特殊輸入下巧合通過）。
  {
    const end = addDaysUtc(START, 365);
    const r = svc.resolveRangeWindow('custom', START, end);
    assert(r.ok === true, '16. 366 inclusive days (span=365) PASS（非閏年全年輸入下的邊界重驗）');
  }
  // 17（額外）：既有 preset（today/yesterday/7d/30d）完全不受本輪常數調整影響。
  {
    const t = svc.resolveRangeWindow('today');
    const y = svc.resolveRangeWindow('yesterday');
    const w7 = svc.resolveRangeWindow('7d');
    const w30 = svc.resolveRangeWindow('30d');
    assert(t.ok && t.start_date === t.end_date, '17a. today preset 不受影響');
    assert(y.ok, '17b. yesterday preset 不受影響');
    assert(w7.ok && (new Date(`${w7.end_date}T00:00:00Z`) - new Date(`${w7.start_date}T00:00:00Z`)) / 86400000 === 6, '17c. 7d preset 不受影響（span=6）');
    assert(w30.ok && (new Date(`${w30.end_date}T00:00:00Z`) - new Date(`${w30.start_date}T00:00:00Z`)) / 86400000 === 29, '17d. 30d preset 不受影響（span=29）');
  }
  // 18（額外）：本輪不得新增第二個 endpoint／service——resolveRangeWindow 是
  // 唯一入口，不透過任何新函式名稱重複實作同一段邏輯。
  {
    const fs = require('fs');
    const src = fs.readFileSync(path.join(ROOT, 'services/ga4GeoSyncService.js'), 'utf8');
    const resolveDefs = src.match(/function resolveRangeWindow/g) || [];
    assert(resolveDefs.length === 1, '18. resolveRangeWindow 只有一份定義（沒有第二套 Range Resolver 邏輯）');
  }

  printSummary();
}

main();
