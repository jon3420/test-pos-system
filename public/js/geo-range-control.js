// public/js/geo-range-control.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE
// Geo Range Control — Reusable Frontend Range UI（需求文件一）。
//
// 唯一職責：render 快捷按鈕／單日輸入框／自訂起訖輸入框／天數／驗證錯誤
// 文字，並把每次變動都透過 resolveGeoHistoricalRange()（本輪 Stage 3
// 既有純函式）換算成標準輸出，回呼給呼叫端。
//
// 明確不做（需求文件一）：不打 GA4 API、不畫 Leaflet marker、不觸發
// Sync、不含任何 Dashboard／Heatmap 專屬商業邏輯——那些完全交給呼叫端
// （geo-heatmap-ui.js 的 H1 Historical 面板、未來的 Dashboard GA4 Layer）
// 自己在 onChange callback 裡處理。
//
// Dashboard 與 Heatmap Historical 共用同一份控制項程式碼，但呼叫端各自
// 傳入自己獨立的 state 物件（geoGa4H1State.range／dashboardGa4State.range）
// ——State Isolation 是「呼叫端傳了兩個不同物件參考」這件事本身保證的，
// 這個檔案完全不知道、也不需要知道「誰在用它」（需求文件十）。

'use strict';

var _geoRangeControlResolve = (typeof resolveGeoHistoricalRange === 'function') ? resolveGeoHistoricalRange : null;
if (!_geoRangeControlResolve && typeof require === 'function') {
  try { _geoRangeControlResolve = require('./geo-range-resolver.js').resolveGeoHistoricalRange; } catch (e) { /* 安靜失敗 */ }
}

var GEO_RANGE_CONTROL_PRESETS = Object.freeze([
  ['today', '今天'], ['yesterday', '昨日'], ['single', '單日'],
  ['7d', '近7天'], ['30d', '近30天'], ['90d', '近90天'], ['180d', '近180天'],
  ['this_year', '今年'], ['last_year', '去年'], ['custom', '自訂'],
]);

// 需求文件七：UI 中文錯誤文字集中在這裡，但「哪一種錯誤」永遠由
// resolveGeoHistoricalRange() 的 code 決定，這裡只是 code → 中文的對照表，
// 不是第二份驗證邏輯。
var GEO_RANGE_CONTROL_ERROR_MESSAGES = Object.freeze({
  invalid_mode: '請選擇查詢模式',
  timezone_helper_unavailable: '時區資料暫時無法使用，請重新整理頁面',
  missing_single_date: '請選擇日期',
  missing_custom_range: '請選擇日期',
  invalid_date_format: '日期格式不正確',
  start_after_end: '開始日期不可晚於結束日期',
  range_too_large: '查詢期間最多 366 天',
});

var _geoRangeControlInstances = Object.create(null); // containerId -> { state, onChange, lastResolved }

function _geoRangeControlEsc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _geoRangeControlErrorMessage(code) {
  return GEO_RANGE_CONTROL_ERROR_MESSAGES[code] || '查詢範圍設定有誤';
}

// geoRangeControlHtml(containerId, state) → 純字串渲染（供 static/snapshot
// 測試直接呼叫，不需要 mount 一個真的 DOM）。
function geoRangeControlHtml(containerId, state) {
  var mode = state.mode;
  var buttons = GEO_RANGE_CONTROL_PRESETS.map(function (pair) {
    var key = pair[0];
    var label = pair[1];
    var active = key === mode;
    return '<button type="button" class="geo-range-btn' + (active ? ' is-active' : '') + '"'
      + ' data-mode="' + key + '" aria-pressed="' + active + '"'
      + ' onclick="geoRangeControlSetMode(\'' + _geoRangeControlEsc(containerId) + '\',\'' + key + '\')">'
      + _geoRangeControlEsc(label) + '</button>';
  }).join('');

  // 需求文件四：Preset 模式 → 0 個日期 input；單日 → 1 個；自訂 → 2 個。
  // 三種互斥，一次只會渲染其中一組（或完全不渲染）。
  var inputsHtml = '';
  if (mode === 'single') {
    inputsHtml = '<div class="geo-range-inputs geo-range-inputs-single">'
      + '<label>單日：<input type="date" class="geo-range-input-single" id="' + containerId + '-single-date"'
      + ' value="' + _geoRangeControlEsc(state.singleDate || '') + '"'
      + ' onchange="geoRangeControlSetSingleDate(\'' + _geoRangeControlEsc(containerId) + '\', this.value)"></label>'
      + '</div>';
  } else if (mode === 'custom') {
    inputsHtml = '<div class="geo-range-inputs geo-range-inputs-custom">'
      + '<label>開始日期：<input type="date" class="geo-range-input-start" id="' + containerId + '-start-date"'
      + ' value="' + _geoRangeControlEsc(state.startDate || '') + '"'
      + ' onchange="geoRangeControlSetCustomDate(\'' + _geoRangeControlEsc(containerId) + '\', \'start\', this.value)"></label>'
      + ' ～ '
      + '<label>結束日期：<input type="date" class="geo-range-input-end" id="' + containerId + '-end-date"'
      + ' value="' + _geoRangeControlEsc(state.endDate || '') + '"'
      + ' onchange="geoRangeControlSetCustomDate(\'' + _geoRangeControlEsc(containerId) + '\', \'end\', this.value)"></label>'
      + ' <span class="geo-range-daycount" id="' + containerId + '-daycount"></span>'
      + '</div>';
  }

  return '<div class="geo-range-control" id="' + containerId + '-range-control" role="group" aria-label="查詢時間範圍">'
    + '<div class="geo-range-presets">' + buttons + '</div>'
    + inputsHtml
    + '<div class="geo-range-status" id="' + containerId + '-range-status" role="status" aria-live="polite"></div>'
    + '</div>';
}

function _geoRangeControlResolveOptionsFor(state) {
  var o = {};
  if (state.mode === 'single') o.singleDate = state.singleDate;
  if (state.mode === 'custom') { o.startDate = state.startDate; o.endDate = state.endDate; }
  return o;
}

function _geoRangeControlRecompute(containerId) {
  var inst = _geoRangeControlInstances[containerId];
  if (!inst) return null;
  var resolved = _geoRangeControlResolve
    ? _geoRangeControlResolve(inst.state.mode, _geoRangeControlResolveOptionsFor(inst.state))
    : { ok: false, mode: inst.state.mode, code: 'timezone_helper_unavailable' };
  inst.lastResolved = resolved;

  if (typeof document !== 'undefined') {
    var statusEl = document.getElementById(containerId + '-range-status');
    if (statusEl) statusEl.textContent = resolved.ok ? '' : _geoRangeControlErrorMessage(resolved.code);
    var dayCountEl = document.getElementById(containerId + '-daycount');
    if (dayCountEl) dayCountEl.textContent = (resolved.ok && typeof resolved.dayCount === 'number') ? ('共 ' + resolved.dayCount + ' 天') : '';
  }

  if (typeof inst.onChange === 'function') {
    inst.onChange({
      mode: inst.state.mode,
      singleDate: inst.state.singleDate,
      startDate: inst.state.startDate,
      endDate: inst.state.endDate,
      resolved: resolved,
    });
  }
  return resolved;
}

function _geoRangeControlRerender(containerId) {
  var inst = _geoRangeControlInstances[containerId];
  if (!inst || typeof document === 'undefined') return;
  var mountEl = document.getElementById(containerId);
  if (!mountEl) return;
  mountEl.innerHTML = geoRangeControlHtml(containerId, inst.state);
  _geoRangeControlRecompute(containerId);
}

// geoRangeControlSetMode()／SetSingleDate()／SetCustomDate() 是實際掛在
// onclick/onchange 上的全域函式（跟這個專案既有的 geoHeatUiSwitchTab 等
// classic-script 慣例一致）。
function geoRangeControlSetMode(containerId, mode) {
  var inst = _geoRangeControlInstances[containerId];
  if (!inst) return;
  inst.state.mode = mode;
  // 需求文件十六之 27：切換 mode 一律整段重繪，舊的 validation error 文字
  // 自然被換掉（不是刻意保留舊錯誤訊息又疊加新的）。
  _geoRangeControlRerender(containerId);
}

function geoRangeControlSetSingleDate(containerId, value) {
  var inst = _geoRangeControlInstances[containerId];
  if (!inst) return;
  inst.state.singleDate = value;
  _geoRangeControlRecompute(containerId);
}

function geoRangeControlSetCustomDate(containerId, which, value) {
  var inst = _geoRangeControlInstances[containerId];
  if (!inst) return;
  if (which === 'start') inst.state.startDate = value; else inst.state.endDate = value;
  _geoRangeControlRecompute(containerId);
}

// GeoRangeControl.mount(containerId, { state, onChange }) → { getState, getResolved, destroy }
//
// state 是呼叫端自己持有的物件參考（例如 geoGa4H1State.range 或
// dashboardGa4State.range）——這個函式直接就地修改它，不複製一份，這樣
// 呼叫端讀自己的 state 永遠是最新的，且兩個呼叫端只要傳不同物件參考，
// 天生互不污染（需求文件十）。
function geoRangeControlMount(containerId, opts) {
  var o = opts || {};
  var state = o.state || { mode: '7d', singleDate: '', startDate: '', endDate: '' };
  _geoRangeControlInstances[containerId] = { state: state, onChange: o.onChange || null, lastResolved: null };
  _geoRangeControlRerender(containerId);
  return {
    getState: function () { return _geoRangeControlInstances[containerId] ? _geoRangeControlInstances[containerId].state : null; },
    getResolved: function () { return _geoRangeControlInstances[containerId] ? _geoRangeControlInstances[containerId].lastResolved : null; },
    destroy: function () { delete _geoRangeControlInstances[containerId]; },
  };
}

(function (global) {
  if (typeof global === 'undefined') return;
  global.geoRangeControlHtml = geoRangeControlHtml;
  global.geoRangeControlSetMode = geoRangeControlSetMode;
  global.geoRangeControlSetSingleDate = geoRangeControlSetSingleDate;
  global.geoRangeControlSetCustomDate = geoRangeControlSetCustomDate;
  global.GeoRangeControl = { mount: geoRangeControlMount };
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_RANGE_CONTROL_PRESETS, GEO_RANGE_CONTROL_ERROR_MESSAGES,
    geoRangeControlHtml, geoRangeControlSetMode, geoRangeControlSetSingleDate, geoRangeControlSetCustomDate,
    geoRangeControlMount,
    _geoRangeControlErrorMessage,
    get _geoRangeControlInstances() { return _geoRangeControlInstances; },
  };
}
