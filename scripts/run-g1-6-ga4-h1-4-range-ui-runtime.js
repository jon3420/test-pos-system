#!/usr/bin/env node
// scripts/run-g1-6-ga4-h1-4-range-ui-runtime.js
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE — Stage 4
//
// 真實 jsdom：把 public/js/geo-range-resolver.js + geo-range-control.js
// eval 在同一個 window scope 內（跟既有 smoke 慣例一致），真的
// mount()、真的 dispatch click/change 事件，斷言真實 DOM 狀態。

'use strict';

const path = require('path');
const fs = require('fs');
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
  console.log('RANGE UI RUNTIME SUMMARY — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE (Stage 4)');
  console.log(`  PASS:  ${p}`);
  console.log(`  FAIL:  ${f}`);
  console.log(`  TOTAL: ${results.length}`);
  console.log('======================================================================');
  if (f > 0) process.exitCode = 1;
}

async function main() {
  ['public/js/geo-range-resolver.js', 'public/js/geo-range-control.js', 'public/js/date-time-format.js'].forEach((rel) => {
    execFileSync(process.execPath, ['--check', path.join(ROOT, rel)]);
    pass(`0-parse ${rel} node --check 通過`);
  });

  let JSDOM;
  try { ({ JSDOM } = require('jsdom')); } catch (e) {
    results.push({ name: '全部 Range UI 測試項目', status: 'MANUAL REQUIRED', detail: 'jsdom 未安裝' });
    console.log('[MANUAL REQUIRED] jsdom 未安裝');
    printSummary();
    return;
  }

  function readStripped(rel) {
    return fs.readFileSync(path.join(ROOT, rel), 'utf8')
      .replace(/'use strict';\s*\n/, '')
      .replace(/if \(typeof module[\s\S]*?\}\s*$/, '');
  }
  const timeSrc = readStripped('public/js/date-time-format.js');
  const resolverSrc = readStripped('public/js/geo-range-resolver.js');
  const controlSrc = readStripped('public/js/geo-range-control.js');

  const CID_A = 'geoRangeA'; // 模擬 Heatmap Historical
  const CID_B = 'geoRangeB'; // 模擬 Dashboard

  function buildDom() {
    return new JSDOM(`<!DOCTYPE html><html><body>
      <div id="${CID_A}"></div>
      <div id="${CID_B}"></div>
    </body></html>`, { runScripts: 'outside-only', url: 'http://localhost/' });
  }

  const dom = buildDom();
  dom.window.eval(timeSrc + '\n;\n' + resolverSrc + '\n;\n' + controlSrc);
  const W = dom.window;
  const D = dom.window.document;

  function fireChange(containerId, elId, value) {
    const el = D.getElementById(elId);
    el.value = value;
    // jsdom 的 runScripts:'outside-only' 不會執行 inline onchange HTML
    // 屬性（已用獨立測試確認），跟這個專案既有測試慣例一致（見
    // smoke-hotfix30-b5-r5-4-g1-2-layer-switch.js 直接呼叫
    // geoHeatUiSetLayer() 而不是模擬點擊 inline onclick 按鈕）：這裡直接
    // 呼叫真正掛在 window 上的 production handler 函式，而不是依賴
    // inline attribute 執行機制——被測的仍然是同一份真實函式。
    if (elId.endsWith('-single-date')) W.geoRangeControlSetSingleDate(containerId, value);
    else if (elId.endsWith('-start-date')) W.geoRangeControlSetCustomDate(containerId, 'start', value);
    else if (elId.endsWith('-end-date')) W.geoRangeControlSetCustomDate(containerId, 'end', value);
  }
  function clickMode(containerId, mode) {
    W.geoRangeControlSetMode(containerId, mode);
  }
  function countInputs(containerId) {
    return D.querySelectorAll(`#${containerId}-range-control input[type="date"]`).length;
  }
  function statusText(containerId) {
    const el = D.getElementById(`${containerId}-range-status`);
    return el ? el.textContent : '';
  }
  function dayCountText(containerId) {
    const el = D.getElementById(`${containerId}-daycount`);
    return el ? el.textContent : '';
  }

  const changesA = [];
  const handleA = W.GeoRangeControl.mount(CID_A, {
    state: { mode: '7d', singleDate: '', startDate: '', endDate: '' },
    onChange: (payload) => changesA.push(payload),
  });

  // ══════════════════════════════════════════════════════════════
  // 1-8：Preset → 0 個日期 input
  // ══════════════════════════════════════════════════════════════
  const presetModes = ['today', 'yesterday', '7d', '30d', '90d', '180d', 'this_year', 'last_year'];
  presetModes.forEach((mode, idx) => {
    clickMode(CID_A, mode);
    assert(countInputs(CID_A) === 0, `${idx + 1} ${mode} → 0 date inputs`, `got ${countInputs(CID_A)}`);
  });

  // ══════════════════════════════════════════════════════════════
  // 9-14：Single
  // ══════════════════════════════════════════════════════════════
  clickMode(CID_A, 'single');
  assert(countInputs(CID_A) === 1, '9 single → 1 input', `got ${countInputs(CID_A)}`);
  {
    const input = D.getElementById(`${CID_A}-single-date`);
    assert(input.getAttribute('type') === 'date', '10 single input type=date');
    fireChange(CID_A, `${CID_A}-single-date`, '2026-08-01');
    const last = changesA[changesA.length - 1];
    assert(last.resolved.ok === true, '11 select 2026-08-01 resolves ok');
    assert(last.resolved.startDate === '2026-08-01' && last.resolved.endDate === '2026-08-01', '12 resolved start=end=2026-08-01', JSON.stringify(last.resolved));
    assert(last.resolved.dayCount === 1, '13 dayCount=1');
    assert(last.resolved.displayLabel === '2026/08/01', '14 displayLabel correct', last.resolved.displayLabel);
  }

  // ══════════════════════════════════════════════════════════════
  // 15-18：Custom
  // ══════════════════════════════════════════════════════════════
  clickMode(CID_A, 'custom');
  assert(countInputs(CID_A) === 2, '15 custom → 2 inputs', `got ${countInputs(CID_A)}`);
  {
    fireChange(CID_A, `${CID_A}-start-date`, '2026-07-01');
    fireChange(CID_A, `${CID_A}-end-date`, '2026-08-07');
    const last = changesA[changesA.length - 1];
    assert(last.resolved.ok === true, '16 2026-07-01～2026-08-07 resolves ok', JSON.stringify(last.resolved));
    assert(last.resolved.dayCount === 38, '17 dayCount=38', `got ${last.resolved.dayCount}`);
    assert(last.resolved.displayLabel === '2026/07/01 ～ 2026/08/07', '18 label correct', last.resolved.displayLabel);
    assert(dayCountText(CID_A) === '共 38 天', '18b DOM 顯示「共 38 天」', dayCountText(CID_A));
  }

  // ══════════════════════════════════════════════════════════════
  // 19-24：Validation（全部來自 resolveGeoHistoricalRange 的 code，不是
  // Control 自己另外驗證）
  // ══════════════════════════════════════════════════════════════
  clickMode(CID_A, 'single');
  fireChange(CID_A, `${CID_A}-single-date`, '');
  assert(statusText(CID_A) === '請選擇日期', '19 empty single 顯示「請選擇日期」', statusText(CID_A));

  clickMode(CID_A, 'custom');
  fireChange(CID_A, `${CID_A}-start-date`, '');
  fireChange(CID_A, `${CID_A}-end-date`, '');
  assert(statusText(CID_A) === '請選擇日期', '20 empty custom 顯示「請選擇日期」', statusText(CID_A));

  fireChange(CID_A, `${CID_A}-start-date`, '2026-08-07');
  fireChange(CID_A, `${CID_A}-end-date`, '2026-08-01');
  assert(statusText(CID_A) === '開始日期不可晚於結束日期', '21 start>end 顯示正確錯誤', statusText(CID_A));

  fireChange(CID_A, `${CID_A}-start-date`, '2026-02-31');
  fireChange(CID_A, `${CID_A}-end-date`, '2026-03-01');
  assert(statusText(CID_A) === '日期格式不正確', '22 invalid real date（2026-02-31 不存在）顯示正確錯誤', statusText(CID_A));

  fireChange(CID_A, `${CID_A}-start-date`, '2028-01-01');
  fireChange(CID_A, `${CID_A}-end-date`, '2028-12-31');
  assert(statusText(CID_A) === '' && changesA[changesA.length - 1].resolved.dayCount === 366, '23 366 days（閏年全年）resolves ok, dayCount=366', statusText(CID_A));

  fireChange(CID_A, `${CID_A}-start-date`, '2027-01-01');
  fireChange(CID_A, `${CID_A}-end-date`, '2028-01-02');
  assert(statusText(CID_A) === '查詢期間最多 366 天', '24 367 days 顯示「查詢期間最多 366 天」', statusText(CID_A));

  // ══════════════════════════════════════════════════════════════
  // 25-27：Mode switch
  // ══════════════════════════════════════════════════════════════
  clickMode(CID_A, 'single');
  assert(countInputs(CID_A) === 1, 'pre-25 single 顯示 1 個 input（切換前置狀態）');
  clickMode(CID_A, '7d');
  assert(countInputs(CID_A) === 0, '25 single → 7d 隱藏 input', `got ${countInputs(CID_A)}`);

  clickMode(CID_A, 'custom');
  assert(countInputs(CID_A) === 2, 'pre-26 custom 顯示 2 個 input（切換前置狀態）');
  clickMode(CID_A, 'today');
  assert(countInputs(CID_A) === 0, '26 custom → today 隱藏 2 個 input', `got ${countInputs(CID_A)}`);

  {
    // 先製造一個 validation error（custom + start>end），再切回一個合法的
    // preset，錯誤文字必須消失，不能殘留在畫面上。
    clickMode(CID_A, 'custom');
    fireChange(CID_A, `${CID_A}-start-date`, '2026-08-07');
    fireChange(CID_A, `${CID_A}-end-date`, '2026-08-01');
    assert(statusText(CID_A) !== '', 'pre-27 custom start>end 產生錯誤文字（前置狀態）');
    clickMode(CID_A, '30d');
    assert(statusText(CID_A) === '', '27 切到合法的 30d 後，舊的 validation error 已清除', statusText(CID_A));
  }

  // ══════════════════════════════════════════════════════════════
  // 28-30：State Isolation（Dashboard／Heatmap 各自傳入不同物件參考）
  // ══════════════════════════════════════════════════════════════
  const stateA = { mode: '180d', singleDate: '', startDate: '', endDate: '' }; // Heatmap
  const stateB = { mode: '7d', singleDate: '', startDate: '', endDate: '' };   // Dashboard
  const dom2 = buildDom();
  dom2.window.eval(timeSrc + '\n;\n' + resolverSrc + '\n;\n' + controlSrc);
  const changesB2 = [];
  dom2.window.GeoRangeControl.mount(CID_A, { state: stateA, onChange: () => {} });
  dom2.window.GeoRangeControl.mount(CID_B, { state: stateB, onChange: (p) => changesB2.push(p) });

  assert(stateA !== stateB, '28 Dashboard/Heatmap state 不是同一個物件參考');

  dom2.window.geoRangeControlSetMode(CID_A, '90d');
  assert(stateA.mode === '90d' && stateB.mode === '7d', '29 Heatmap change 不 mutate Dashboard state', `A=${stateA.mode} B=${stateB.mode}`);

  dom2.window.geoRangeControlSetMode(CID_B, 'single');
  assert(stateB.mode === 'single' && stateA.mode === '90d', '30 Dashboard change 不 mutate Heatmap state', `A=${stateA.mode} B=${stateB.mode}`);

  printSummary();
}

main().catch((e) => { console.error('[FATAL]', e.stack || e.message); process.exitCode = 1; });
