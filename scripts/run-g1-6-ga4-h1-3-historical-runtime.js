#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-3-historical-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT
//
// Historical Runtime Gate — Asia/Taipei Calendar Boundary + Sync UX +
// Per-user Metric Semantics（見需求文件一～十三）。
//
// 全部用真實 Production 函式呼叫：
//   - utils/dateTime.js（getTaipeiCalendarDateString，A1.2.1 既有集中
//     timezone helper，本輪重用，未新增第二套實作）。
//   - services/ga4GeoSyncService.js（resolveRangeWindow，透過
//     _setClockForTest 注入固定「現在時刻」）。
//   - public/js/geo-ga4-h1-panel.js（_geoGa4H1HandleSyncResult／
//     _geoGa4H1PerUser／geoGa4H1BuildTooltip／_geoGa4H1SortRows／
//     geoGa4H1RenderTable，真實檔案，不是重寫一份邏輯自測）。
//
// 不觸碰 Historical Query／Merge／DB Schema——本輪範圍只在 Presentation／
// Date Helper 層（見需求文件十八）。

'use strict';

const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const { JSDOM } = require('jsdom');
const ROOT = path.join(__dirname, '..');

const results = [];
function pass(name) { results.push({ name, status: 'PASS' }); console.log(`[PASS] ${name}`); }
function fail(name, detail) { results.push({ name, status: 'FAIL', detail }); console.log(`[FAIL] ${name}${detail ? ' — ' + detail : ''}`); }
function assert(cond, name, detail) { cond ? pass(name) : fail(name, detail); }
function printSummary() {
  const p = results.filter((r) => r.status === 'PASS').length;
  const f = results.filter((r) => r.status === 'FAIL').length;
  console.log('\n======================================================================');
  console.log('HISTORICAL RUNTIME — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

function freshPanelModule(toastCalls) {
  const panelPath = require.resolve(path.join(ROOT, 'public/js/geo-ga4-h1-panel.js'));
  delete require.cache[panelPath];
  const dom = new JSDOM('<div id="c-ga4-h1-toolbar"></div><div id="c-ga4-h1-status"></div><div id="c-ga4-h1-table"></div>');
  global.window = dom.window;
  global.document = dom.window.document;
  global.showToast = (msg, type) => toastCalls.push({ msg, type });
  // eslint-disable-next-line global-require, import/no-dynamic-require
  return require(panelPath);
}

async function main() {
  // ── 0. node --check ──
  ['services/ga4GeoSyncService.js', 'utils/dateTime.js', 'public/js/geo-ga4-h1-panel.js'].forEach((rel) => {
    try { execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]); pass(`0-parse ${rel} node --check 通過`); }
    catch (e) { fail(`0-parse ${rel} node --check 通過`, e.message.slice(0, 200)); }
  });

  const dt = require(path.join(ROOT, 'utils/dateTime.js'));
  const svc = require(path.join(ROOT, 'services/ga4GeoSyncService.js'));

  // ══════════════════════════════════════════════════════════════
  // A. Timezone — absolute-instant boundary cases（1-6）
  // ══════════════════════════════════════════════════════════════
  {
    assert(dt.getTaipeiCalendarDateString(new Date('2026-08-06T16:01:00.000Z'), 0) === '2026-08-07',
      '1. Taiwan 00:01 (2026-08-06T16:01:00Z) → today=2026-08-07');
    assert(dt.getTaipeiCalendarDateString(new Date('2026-08-06T23:59:00.000Z'), 0) === '2026-08-07',
      '2. Taiwan 07:59 (2026-08-06T23:59:00Z) → today=2026-08-07');
    assert(dt.getTaipeiCalendarDateString(new Date('2026-08-07T00:00:00.000Z'), 0) === '2026-08-07',
      '3. Taiwan 08:00 (2026-08-07T00:00:00Z) → today=2026-08-07');
    assert(dt.getTaipeiCalendarDateString(new Date('2026-08-07T15:59:59.000Z'), 0) === '2026-08-07',
      '4. Taiwan 23:59:59 (2026-08-07T15:59:59Z) → today=2026-08-07');
    assert(dt.getTaipeiCalendarDateString(new Date('2026-08-07T16:00:00.000Z'), 0) === '2026-08-08',
      '5. Taiwan midnight rollover: next second (2026-08-07T16:00:00Z) → today=2026-08-08');
    const before = dt.getTaipeiCalendarDateString(new Date('2026-08-07T15:59:59.999Z'), 0);
    const after = dt.getTaipeiCalendarDateString(new Date('2026-08-07T16:00:00.000Z'), 0);
    assert(before === '2026-08-07' && after === '2026-08-08', '5b. rollover instant pair is exactly (D, D+1)');
  }

  // ══════════════════════════════════════════════════════════════
  // B. Range Contract via resolveRangeWindow (injected clock) (6-12)
  // ══════════════════════════════════════════════════════════════
  {
    svc._setClockForTest(() => new Date('2026-08-07T04:00:00.000Z')); // Taipei noon, 2026-08-07
    const today = svc.resolveRangeWindow('today');
    assert(today.ok && today.start_date === '2026-08-07' && today.end_date === '2026-08-07', '6. today range = 2026-08-07..2026-08-07');
    const yesterday = svc.resolveRangeWindow('yesterday');
    assert(yesterday.ok && yesterday.start_date === '2026-08-06' && yesterday.end_date === '2026-08-06', '7. yesterday range = 2026-08-06..2026-08-06');
    const w7 = svc.resolveRangeWindow('7d');
    assert(w7.ok && w7.start_date === '2026-08-01' && w7.end_date === '2026-08-07', '8. 7d range = 2026-08-01..2026-08-07');
    const w30 = svc.resolveRangeWindow('30d');
    assert(w30.ok && w30.start_date === '2026-07-09' && w30.end_date === '2026-08-07', '9. 30d range = 2026-07-09..2026-08-07');

    svc._setClockForTest(() => new Date('2026-03-02T04:00:00.000Z')); // Taipei noon, 2026-03-02
    const crossMonth7d = svc.resolveRangeWindow('7d');
    assert(crossMonth7d.ok && crossMonth7d.start_date === '2026-02-24' && crossMonth7d.end_date === '2026-03-02', '9b. cross month 7d = 2026-02-24..2026-03-02');

    svc._setClockForTest(() => new Date('2027-01-01T01:00:00.000Z')); // Taipei 09:00, 2027-01-01
    const crossYear7d = svc.resolveRangeWindow('7d');
    assert(crossYear7d.ok && crossYear7d.start_date === '2026-12-26' && crossYear7d.end_date === '2027-01-01', '10. cross year 7d = 2026-12-26..2027-01-01');

    svc._setClockForTest(() => new Date('2028-02-29T23:00:00.000Z')); // Taipei 2028-03-01 07:00
    const leapYear7d = svc.resolveRangeWindow('7d');
    assert(leapYear7d.ok && leapYear7d.start_date === '2028-02-24' && leapYear7d.end_date === '2028-03-01', '11. leap year 7d = 2028-02-24..2028-03-01 (crosses Feb 29)');

    svc._resetClockForTest();
    const custom = svc.resolveRangeWindow('custom', '2020-05-05', '2020-05-09');
    assert(custom.ok && custom.start_date === '2020-05-05' && custom.end_date === '2020-05-09', '12. custom range completely unchanged (no offset applied)');
  }

  // ══════════════════════════════════════════════════════════════
  // C. Sync UX（13-19）
  // ══════════════════════════════════════════════════════════════
  let toastCalls = [];
  let panel = freshPanelModule(toastCalls);
  let onChangeCalls = 0;

  toastCalls = []; onChangeCalls = 0;
  panel = freshPanelModule(toastCalls);
  await panel._geoGa4H1HandleSyncResult({ success: true, rows_saved: 0 }, () => { onChangeCalls += 1; return Promise.resolve(); });
  assert(toastCalls.length === 1 && toastCalls[0].type === 'success', '13. rows_saved=0 → success toast (not error)');
  assert(!/已更新\s*0\s*筆/.test(toastCalls[0].msg), '14a. rows_saved=0 message does not use confusing "已更新 0 筆" wording');
  assert(toastCalls[0].msg.includes('尚無可用的區域資料'), '14. 0 rows shows neutral "尚無可用的區域資料" message, not an error');
  assert(onChangeCalls === 1, '15. 0 rows still triggers onChange (Read API refresh), does not skip / clear cache path');

  toastCalls = []; onChangeCalls = 0;
  panel = freshPanelModule(toastCalls);
  await panel._geoGa4H1HandleSyncResult({ success: true, rows_saved: 4 }, () => { onChangeCalls += 1; return Promise.resolve(); });
  assert(toastCalls.length === 1 && toastCalls[0].type === 'success' && toastCalls[0].msg.includes('已更新 4 筆資料'), '16. rows_saved=4 → "同步成功，已更新 4 筆資料"');
  assert(onChangeCalls === 1, '17. rows_saved>0 triggers refresh');

  toastCalls = []; onChangeCalls = 0;
  panel = freshPanelModule(toastCalls);
  await panel._geoGa4H1HandleSyncResult({ success: false, code: 'rate_limited' }, () => { onChangeCalls += 1; return Promise.resolve(); });
  assert(onChangeCalls === 0, '18. failed sync does NOT trigger refresh');
  assert(toastCalls.length === 1 && toastCalls[0].type === 'error', '19. failed sync shows error toast, cache/table untouched (no refresh call)');

  // ══════════════════════════════════════════════════════════════
  // D. Metrics semantics（20-30）
  // ══════════════════════════════════════════════════════════════
  panel = freshPanelModule([]);
  assert(panel._geoGa4H1PerUser(10, 2) === 5, '20. 10/2 = 5.0 (per-user, not %)');
  assert(panel._geoGa4H1PerUser(8, 2) === 4, '21. 8/2 = 4.0 (per-user, not %)');
  assert(panel._geoGa4H1PerUser(5, 0) === null, '22. denominator=0 → null (rendered as —)');

  const dom2 = new JSDOM('<div id="tbl"></div>');
  global.document = dom2.window.document;
  panel.geoGa4H1RenderTable('tbl', [{ district_name: '龍潭區', active_users: 2, add_to_cart_count: 10, purchase_count: 8, normalization_status: 'ok' }]);
  const tableHtml = dom2.window.document.getElementById('tbl').innerHTML;
  assert(!tableHtml.includes('%'), '23. rendered historical table never contains a "%" character');
  assert(!tableHtml.includes('500') && !tableHtml.includes('400'), '23c. no leftover "500"/"400" values from the old ×100 formula');
  assert(!tableHtml.includes('加購率') && !tableHtml.includes('購買率'), '23d. no legacy 加購率/購買率 header text rendered');
  assert(tableHtml.includes('5.0'), '23f. rendered table HTML contains "5.0" (10 add_to_cart / 2 active_users)');
  assert(tableHtml.includes('4.0'), '23g. rendered table HTML contains "4.0" (8 purchase / 2 active_users)');
  assert(tableHtml.includes('加購事件／人') && tableHtml.includes('購買事件／人'), '23h. rendered table header uses 加購事件／人／購買事件／人');

  panel.geoGa4H1RenderTable('tbl', [{ district_name: '零使用者區', active_users: 0, add_to_cart_count: 5, purchase_count: 3, normalization_status: 'ok' }], { showZeroRows: true });
  const zeroUserHtml = dom2.window.document.getElementById('tbl').innerHTML;
  assert(zeroUserHtml.includes('—'), '23i. active_users=0 renders "—" for per-user columns, not Infinity/NaN/0%/100%');
  assert(!/Infinity|NaN/.test(zeroUserHtml), '23j. active_users=0 never renders Infinity/NaN');

  const tooltip = panel.geoGa4H1BuildTooltip({ district_name: '龍潭區', active_users: 2, add_to_cart_count: 10, purchase_count: 8 });
  assert(!tooltip.includes('%'), '23e. tooltip never contains "%"');
  assert(tooltip.includes('加購事件／人：5.0'), '24. tooltip shows 加購事件／人：5.0');
  assert(tooltip.includes('購買事件／人：4.0'), '25. tooltip shows 購買事件／人：4.0');

  const rows = [
    { district_name: 'A區', active_users: 2, add_to_cart_count: 10 },
    { district_name: 'B區', active_users: 5, add_to_cart_count: 5 },
    { district_name: 'C區', active_users: 0, add_to_cart_count: 3 }, // denominator 0 -> null, sorts last
  ];
  const sortedDesc = panel._geoGa4H1SortRows(rows, 'add_to_cart_per_user', 'desc');
  assert(sortedDesc[0].district_name === 'A區' && sortedDesc[sortedDesc.length - 1].district_name === 'C區', '26. sort add_to_cart_per_user numeric desc, null last');
  const sortedAsc = panel._geoGa4H1SortRows(rows, 'purchase_per_user', 'asc');
  assert(sortedAsc[sortedAsc.length - 1].district_name === 'C區', '27. sort purchase_per_user, null(denominator 0) sorts last even ascending');
  const rowsWithNaN = [...rows, { district_name: 'D區', active_users: 'not-a-number', add_to_cart_count: 1 }];
  const sortedWithNaN = panel._geoGa4H1SortRows(rowsWithNaN, 'add_to_cart_per_user', 'desc');
  assert(sortedWithNaN.length === rowsWithNaN.length, '28. NaN-producing sort values do not crash, sort completes (defensive)');

  const syncSrc = fs.readFileSync(path.join(ROOT, 'services/ga4GeoSyncService.js'), 'utf8');
  assert(/active_users:\s*0,\s*new_users:\s*0,\s*sessions:\s*0/.test(syncSrc), '29. merged row still starts with active_users/new_users/sessions fields (API contract unchanged)');
  assert(/add_to_cart_count:\s*0,\s*begin_checkout_count:\s*0,\s*checkout_click_count:\s*0,\s*purchase_count:\s*0/.test(syncSrc), '30. DB/merge field names for event counts unchanged (no schema rename)');

  printSummary();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
