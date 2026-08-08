// public/js/geo-range-resolver.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE
// Geo Historical Range Resolver — 純函式，不綁 DOM。
//
// 把 UI 的 10 種 Historical Range mode（today/yesterday/single/7d/30d/
// 90d/180d/this_year/last_year/custom）全部 resolve 成同一個標準輸出
// contract（startDate/endDate/dayCount/displayLabel/apiRange），供
// Dashboard 與 Heatmap Historical 共用（各自持有自己的 mode/state，只是
// 呼叫同一個 resolve 函式，不是共用同一個 global range 變數——見需求
// 文件二十一）。
//
// API Mapping（需求文件十一）：today/yesterday/7d/30d 維持既有
// `range=` preset 值；single/90d/180d/this_year/last_year/custom 全部
// resolve 成 apiRange='custom' + startDate/endDate，走既有
// GET /api/analytics/ga4-geo/history?range=custom&start_date=&end_date=
// （services/ga4GeoSyncService.js 的 resolveRangeWindow()，本輪只調整過
// CUSTOM_RANGE_MAX_DAYS 常數，查詢路徑本身沒有新增 endpoint）。
//
// 日期一律用 utils/dateTime.js／public/js/date-time-format.js 既有集中
// Asia/Taipei Timezone Helper（getTaipeiCalendarDateString），不在這裡
// 另外實作第二套時區換算。

'use strict';

var _geoRangeGetTaipeiCalendarDateString = (typeof getTaipeiCalendarDateString === 'function') ? getTaipeiCalendarDateString : null;
if (!_geoRangeGetTaipeiCalendarDateString && typeof require === 'function') {
  // Node 測試環境：browser 全域尚未載入 date-time-format.js 時，直接
  // require 同一份正式檔案（不是重寫演算法）。正式瀏覽器執行路徑不會
  // 走到這裡（typeof require === 'undefined'）。
  try {
    _geoRangeGetTaipeiCalendarDateString = require('./date-time-format.js').getTaipeiCalendarDateString;
  } catch (e) { /* 安靜失敗，resolveGeoHistoricalRange() 會回 timezone_helper_unavailable */ }
}

var GEO_RANGE_MODES = Object.freeze(['today', 'yesterday', 'single', '7d', '30d', '90d', '180d', 'this_year', 'last_year', 'custom']);
// 需求文件十一：既有 preset 維持原 apiRange 值；其餘全部 apiRange='custom'。
var GEO_RANGE_API_MAP = Object.freeze({ today: 'today', yesterday: 'yesterday', '7d': '7d', '30d': '30d' });
var GEO_RANGE_DATE_FORMAT_RE = /^\d{4}-\d{2}-\d{2}$/;
// 對齊 services/ga4GeoSyncService.js 的 CUSTOM_RANGE_MAX_DAYS=365（span，
// exclusive 日期差）——這裡直接用 inclusive 天數表示，365+1=366，避免
// 前端又用「span」語意重算一次容易搞混（見
// R5.4-G1.6-GA4-H1.4-MAP-STATE_REALITY_AUDIT.md 章節 L）。
var GEO_RANGE_MAX_INCLUSIVE_DAYS = 366;

function _geoRangeIsValidDateStr(s) {
  if (typeof s !== 'string' || !GEO_RANGE_DATE_FORMAT_RE.test(s)) return false;
  var d = new Date(s + 'T00:00:00Z');
  if (isNaN(d.getTime())) return false;
  // new Date('2026-02-30') 會被 JS 引擎自動滾動成 3 月而不是回傳
  // Invalid Date，這裡用 UTC 分量比對回輸入本身，確保「看起來合法但實際
  // 不存在的日期」（例如非閏年的 2/29）會被擋下，而合法閏日（2028-02-29）
  // 正常通過。
  var parts = s.split('-').map(Number);
  return d.getUTCFullYear() === parts[0] && (d.getUTCMonth() + 1) === parts[1] && d.getUTCDate() === parts[2];
}

function _geoRangeInclusiveDayCount(startDate, endDate) {
  var a = new Date(startDate + 'T00:00:00Z');
  var b = new Date(endDate + 'T00:00:00Z');
  return Math.round((b - a) / 86400000) + 1;
}

function _geoRangeDisplayLabel(startDate, endDate) {
  var s = startDate.replace(/-/g, '/');
  var e = endDate.replace(/-/g, '/');
  return startDate === endDate ? s : (s + ' ～ ' + e);
}

// resolveGeoHistoricalRange(mode, options) →
//   成功：{ ok:true, mode, apiRange, startDate, endDate, dayCount, displayLabel }
//   失敗：{ ok:false, mode, code }
//
// options：
//   now          — 可注入的 Date／可解析時間值，測試用（省略＝真實現在）
//   singleDate   — mode==='single' 時的 'YYYY-MM-DD'
//   startDate    — mode==='custom' 時的起日 'YYYY-MM-DD'
//   endDate      — mode==='custom' 時的迄日 'YYYY-MM-DD'
function resolveGeoHistoricalRange(mode, options) {
  var o = options || {};
  if (GEO_RANGE_MODES.indexOf(mode) === -1) {
    return { ok: false, mode: mode, code: 'invalid_mode' };
  }
  if (typeof _geoRangeGetTaipeiCalendarDateString !== 'function') {
    return { ok: false, mode: mode, code: 'timezone_helper_unavailable' };
  }

  function dateStr(offsetDays) { return _geoRangeGetTaipeiCalendarDateString(o.now, offsetDays); }

  var startDate = null;
  var endDate = null;

  if (mode === 'today') {
    startDate = endDate = dateStr(0);
  } else if (mode === 'yesterday') {
    startDate = endDate = dateStr(-1);
  } else if (mode === '7d') {
    startDate = dateStr(-6); endDate = dateStr(0);
  } else if (mode === '30d') {
    startDate = dateStr(-29); endDate = dateStr(0);
  } else if (mode === '90d') {
    // 需求文件十三：today - 89 days ～ today（inclusive 90），不是 -90。
    startDate = dateStr(-89); endDate = dateStr(0);
  } else if (mode === '180d') {
    // 同上，today - 179 days ～ today（inclusive 180），不是 -180。
    startDate = dateStr(-179); endDate = dateStr(0);
  } else if (mode === 'this_year') {
    var todayThisYear = dateStr(0);
    startDate = todayThisYear.slice(0, 4) + '-01-01';
    endDate = todayThisYear;
  } else if (mode === 'last_year') {
    var todayForLastYear = dateStr(0);
    var lastYear = Number(todayForLastYear.slice(0, 4)) - 1;
    startDate = lastYear + '-01-01';
    endDate = lastYear + '-12-31';
  } else if (mode === 'single') {
    var single = o.singleDate;
    if (!single) return { ok: false, mode: mode, code: 'missing_single_date' };
    if (!_geoRangeIsValidDateStr(single)) return { ok: false, mode: mode, code: 'invalid_date_format' };
    startDate = endDate = single;
  } else if (mode === 'custom') {
    var cs = o.startDate;
    var ce = o.endDate;
    if (!cs || !ce) return { ok: false, mode: mode, code: 'missing_custom_range' };
    if (!_geoRangeIsValidDateStr(cs) || !_geoRangeIsValidDateStr(ce)) return { ok: false, mode: mode, code: 'invalid_date_format' };
    if (cs > ce) return { ok: false, mode: mode, code: 'start_after_end' }; // 'YYYY-MM-DD' 字串序等同日期序
    var customDayCount = _geoRangeInclusiveDayCount(cs, ce);
    if (customDayCount > GEO_RANGE_MAX_INCLUSIVE_DAYS) return { ok: false, mode: mode, code: 'range_too_large' };
    startDate = cs; endDate = ce;
  }

  var dayCount = _geoRangeInclusiveDayCount(startDate, endDate);
  return {
    ok: true,
    mode: mode,
    apiRange: GEO_RANGE_API_MAP[mode] || 'custom',
    startDate: startDate,
    endDate: endDate,
    dayCount: dayCount,
    displayLabel: _geoRangeDisplayLabel(startDate, endDate),
  };
}

(function (global) {
  if (typeof global !== 'undefined') {
    global.resolveGeoHistoricalRange = resolveGeoHistoricalRange;
    global.GEO_RANGE_MODES = GEO_RANGE_MODES;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GEO_RANGE_MODES, GEO_RANGE_API_MAP, GEO_RANGE_MAX_INCLUSIVE_DAYS,
    resolveGeoHistoricalRange,
    _geoRangeIsValidDateStr, _geoRangeInclusiveDayCount, _geoRangeDisplayLabel,
  };
}
