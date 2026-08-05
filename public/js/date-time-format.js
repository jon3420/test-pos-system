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

  global.formatTaipeiDateTime = formatTaipeiDateTime;
  global.formatTaipeiDate = formatTaipeiDate;
  global.parseStoredUtcTimestamp = parseStoredUtcTimestamp;
})(typeof window !== 'undefined' ? window : globalThis);
