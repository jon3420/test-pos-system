// public/js/date-time-format.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// Geo Event Taiwan Time & Estimate Marker Verification Hotfix
//
// 瀏覽器端唯一的 Asia/Taipei 顯示 Helper。所有 Renderer 都必須呼叫這裡，
// 不得各自手動 + 8 * 60 * 60 * 1000（需求文件四）。
// 與伺服器端 utils/dateTime.js 的 parseStoredUtcTimestamp/formatTaipeiDateTime
// 邏輯等價（瀏覽器端不能 require Node 模組，故獨立一份，規則保持一致）。

(function (global) {
  'use strict';

  var SQLITE_NAIVE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/;
  var HAS_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/;

  var formatter = null;
  function getFormatter() {
    if (!formatter) {
      formatter = new Intl.DateTimeFormat('zh-TW', {
        timeZone: 'Asia/Taipei',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
      });
    }
    return formatter;
  }

  // parseStoredUtcTimestamp(value) → Date | null
  // 規則跟伺服器端 utils/dateTime.js 一致：
  //   - 已帶 Z／offset → 直接解析，不再加 8 小時（避免雙重轉換）。
  //   - SQLite naive 字串（無 Z、無 offset）→ 明確按 UTC 解析。
  //   - 無法辨識 → null（不得自行猜測時區）。
  function parseStoredUtcTimestamp(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) {
      return isNaN(value.getTime()) ? null : value;
    }
    if (typeof value === 'number') {
      var dn = new Date(value);
      return isNaN(dn.getTime()) ? null : dn;
    }
    var s = String(value).trim();
    if (!s) return null;

    if (/^\d{10,}$/.test(s)) {
      var de = new Date(Number(s));
      return isNaN(de.getTime()) ? null : de;
    }

    if (HAS_TZ_RE.test(s)) {
      var d1 = new Date(s);
      return isNaN(d1.getTime()) ? null : d1;
    }

    if (SQLITE_NAIVE_RE.test(s)) {
      var d2 = new Date(s.replace(' ', 'T') + 'Z');
      return isNaN(d2.getTime()) ? null : d2;
    }

    return null;
  }

  // formatTaipeiDateTime(value) → 'YYYY-MM-DD HH:mm:ss' | '—'
  function formatTaipeiDateTime(value) {
    var d = parseStoredUtcTimestamp(value);
    if (!d) return '—';
    var parts = getFormatter().formatToParts(d);
    var map = {};
    for (var i = 0; i < parts.length; i++) { map[parts[i].type] = parts[i].value; }
    return map.year + '-' + map.month + '-' + map.day + ' ' + map.hour + ':' + map.minute + ':' + map.second;
  }

  // formatTaipeiDate(value) → 'YYYY-MM-DD' | '—'
  function formatTaipeiDate(value) {
    var full = formatTaipeiDateTime(value);
    return full === '—' ? full : full.slice(0, 10);
  }

  // getTaipeiCalendarDateString(dateInput, offsetDays) → 'YYYY-MM-DD'
  //
  // fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4-MAP-STATE：瀏覽器端對照
  // utils/dateTime.js 的 getTaipeiCalendarDateString()（Node 端集中
  // Timezone Helper 既有函式，本輪未修改），演算法必須完全等價（同一組
  // absolute timestamp 必須得到同一個 Asia/Taipei 日曆日字串）——見
  // scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js。
  //
  // 前端 Range Resolver（single/90d/180d/this_year/last_year）需要「回傳
  // 日曆日字串＋支援 ±N 天位移」這個既有 formatTaipeiDate() 沒提供的能力，
  // 不 require('../utils/dateTime')（瀏覽器不能 require Node 模組），也
  // 不自己另外寫 new Date().toISOString().slice(0,10)（那是 UTC 日曆日，
  // 在 Asia/Taipei 00:00～07:59 之間會誤判成前一天，見
  // R5.4-G1.6-GA4-H1.3-EVENT-COMPAT_REALITY_AUDIT.md 既有教訓）。
  //
  // dateInput 省略時＝「now」；offsetDays 用 Date.UTC() 對「已經是
  // Asia/Taipei 日曆日」的年/月/日字面值做加減，時分秒固定用中午 12:00
  // UTC 當基準（避免任何日期邊界／月份天數／閏年進位誤差；跟 Node 端
  // 演算法逐行對應）。
  function getTaipeiCalendarDateString(dateInput, offsetDays) {
    var base = (dateInput === undefined || dateInput === null)
      ? new Date()
      : (parseStoredUtcTimestamp(dateInput) || new Date());

    var parts = getFormatter().formatToParts(base);
    var map = {};
    for (var i = 0; i < parts.length; i++) { map[parts[i].type] = parts[i].value; }

    var shifted = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day) + Number(offsetDays || 0), 12, 0, 0));
    var y = shifted.getUTCFullYear();
    var m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    var d = String(shifted.getUTCDate()).padStart(2, '0');
    return y + '-' + m + '-' + d;
  }

  global.formatTaipeiDateTime = formatTaipeiDateTime;
  global.formatTaipeiDate = formatTaipeiDate;
  global.parseStoredUtcTimestamp = parseStoredUtcTimestamp;
  global.getTaipeiCalendarDateString = getTaipeiCalendarDateString;
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof module !== 'undefined' && module.exports) {
  // 供 Node 測試環境（scripts/run-g1-6-ga4-h1-4-timezone-parity-runtime.js／
  // Range Resolver 純函式測試）直接 require，不需要真的啟動瀏覽器。
  // 正式瀏覽器執行路徑完全不受影響（module.exports 在瀏覽器不存在）。
  module.exports = {
    formatTaipeiDateTime: (typeof window !== 'undefined' ? window : globalThis).formatTaipeiDateTime,
    formatTaipeiDate: (typeof window !== 'undefined' ? window : globalThis).formatTaipeiDate,
    parseStoredUtcTimestamp: (typeof window !== 'undefined' ? window : globalThis).parseStoredUtcTimestamp,
    getTaipeiCalendarDateString: (typeof window !== 'undefined' ? window : globalThis).getTaipeiCalendarDateString,
  };
}
