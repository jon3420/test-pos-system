// utils/dashboardDate.js — fix18-10-hotfix23-B
//
// 統一的日期篩選解析器，供 GET /api/analytics/dashboard 使用。
// 所有 KPI／漏斗／購物車／商品／付款／來源／回購／未完成訂單／健康度／建議
// 都必須呼叫同一個函式取得同一組日期範圍，不得各自計算（需求文件二）。
//
// 重要時區細節（實測確認，見 CHANGELOG）：
//   - orders.created_at 是應用層寫入時就已換算好的「Asia/Taipei 本地時間字串」
//     （不是 DB 的 datetime('now','localtime') 產生的，是 JS 端算好才 INSERT 進去）。
//   - analytics_events.created_at 是資料庫 DEFAULT (datetime('now')) 產生的
//     **UTC 時間字串**（sql.js 這個環境下 'localtime' 修飾詞是 no-op，不會真的轉時區）。
//   本模組統一輸出「Asia/Taipei 本地時間字串」作為查詢邊界；查 orders 表直接用這組字串；
//   查 analytics_events 表時，呼叫端要用 SQL 端把 created_at 加 8 小時再比較
//   （見 ANALYTICS_CREATED_AT_LOCAL_EXPR 這個 SQL 片段），不要直接拿本模組算出的字串去比。

'use strict';

const PRESETS = ['today', 'yesterday', 'week', 'month', 'lastmonth', 'single', 'custom'];

// analytics_events.created_at 轉成 Asia/Taipei 本地時間的 SQL 運算式，供 WHERE / SELECT 共用
const ANALYTICS_CREATED_AT_LOCAL_EXPR = "datetime(created_at,'+8 hours')";

// fix18-10-hotfix24-A1（Part 7：舊資料與新資料分離）
// Analytics Event Tracking（analytics_events 表）是從這個日期才開始寫入的
// （見 CHANGELOG_HOTFIX23_A_ANALYTICS_FOUNDATION.md）。在這之前的 orders 屬於
// 「Legacy Orders」——那些訂單完全沒有對應的瀏覽/加購/結帳事件，如果直接把
// Funnel／轉換率跟 orders 表的歷史營收放在一起看，會出現「轉換率 800%」這種
// 失真數字。這裡只新增一個常數 + 判斷函式，不新增資料表、不回填舊資料、
// 不改變 orders 表任何欄位。
const TRACKING_START_DATE = '2026-07-15';

// 判斷查詢區間是否完全或部分落在 Tracking 啟用「之前」
function getTrackingPeriodInfo(range) {
  const startsBeforeTracking = range.start_date < TRACKING_START_DATE;
  const endsBeforeTracking = range.end_date < TRACKING_START_DATE;
  return {
    tracking_start_date: TRACKING_START_DATE,
    is_legacy_period: endsBeforeTracking, // 整個查詢區間都在 Tracking 啟用之前
    is_mixed_period: startsBeforeTracking && !endsBeforeTracking, // 區間橫跨啟用日，前段是 Legacy
  };
}

class DashboardDateError extends Error {
  constructor(message) { super(message); this.name = 'DashboardDateError'; this.status = 400; }
}

function twNowParts() {
  const n = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Taipei' }));
  return n;
}
function fmtDate(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function isValidDateStr(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(new Date(s + 'T00:00:00').getTime());
}

// preset → { start_date, end_date }（YYYY-MM-DD，Asia/Taipei 日曆日）
// start/end 的時分秒邊界另外在 resolveDateRange() 決定（今日/本週/本月結束於「目前時間」，
// 其餘結束於當天 23:59:59）
function computePresetDates(preset, now) {
  const today = fmtDate(now);
  if (preset === 'today') return { start_date: today, end_date: today };
  if (preset === 'yesterday') {
    const y = new Date(now); y.setDate(y.getDate() - 1);
    const ys = fmtDate(y);
    return { start_date: ys, end_date: ys };
  }
  if (preset === 'week') {
    const mon = new Date(now);
    const dow = now.getDay(); // 0=Sun
    mon.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
    return { start_date: fmtDate(mon), end_date: today };
  }
  if (preset === 'month') {
    const first = new Date(now.getFullYear(), now.getMonth(), 1);
    return { start_date: fmtDate(first), end_date: today };
  }
  if (preset === 'lastmonth') {
    const firstOfThis = new Date(now.getFullYear(), now.getMonth(), 1);
    const lastMonthFirst = new Date(firstOfThis); lastMonthFirst.setMonth(lastMonthFirst.getMonth() - 1);
    const lastMonthLast = new Date(firstOfThis); lastMonthLast.setDate(0);
    return { start_date: fmtDate(lastMonthFirst), end_date: fmtDate(lastMonthLast) };
  }
  return null; // single / custom 由呼叫端提供 start_date/end_date
}

/**
 * 解析 dashboard 查詢參數，回傳統一的日期範圍狀態。
 * @param {{preset?:string, start_date?:string, end_date?:string, timezone?:string}} query
 * @throws {DashboardDateError} 400：preset 不合法 / 日期格式錯誤 / end < start
 */
function resolveDateRange(query = {}) {
  const preset = (query.preset || 'today').trim();
  if (!PRESETS.includes(preset)) {
    throw new DashboardDateError(`preset 不合法（允許：${PRESETS.join(', ')}）`);
  }
  const timezone = query.timezone || 'Asia/Taipei';
  if (timezone !== 'Asia/Taipei') {
    // 本期只支援 Asia/Taipei，避免日期計算隱性出錯
    throw new DashboardDateError('timezone 目前僅支援 Asia/Taipei');
  }

  const now = twNowParts();
  const today = fmtDate(now);
  let start_date, end_date;

  if (preset === 'single' || preset === 'custom') {
    if (preset === 'single') {
      start_date = end_date = query.start_date || query.date || '';
    } else {
      start_date = query.start_date || '';
      end_date = query.end_date || '';
    }
    if (!isValidDateStr(start_date)) throw new DashboardDateError('start_date 格式錯誤（需為 YYYY-MM-DD）');
    if (!isValidDateStr(end_date)) throw new DashboardDateError('end_date 格式錯誤（需為 YYYY-MM-DD）');
    if (end_date < start_date) throw new DashboardDateError('end_date 不得早於 start_date');
  } else {
    const computed = computePresetDates(preset, now);
    start_date = computed.start_date;
    end_date = computed.end_date;
  }

  // 結束邊界：若 end_date === 今日 且 preset 屬於「累積到目前時間」類型（today/week/month），
  // 結束時間用「目前時間」；其餘（yesterday/lastmonth/single/custom 且非今日）用 23:59:59。
  const nowTimeStr = `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}:${String(now.getSeconds()).padStart(2,'0')}`;
  const cumulativeToNow = ['today', 'week', 'month'].includes(preset) && end_date === today;

  const startLocal = `${start_date} 00:00:00`;
  const endLocal = cumulativeToNow ? `${end_date} ${nowTimeStr}` : `${end_date} 23:59:59`;

  return {
    preset, start_date, end_date, timezone,
    startLocal, endLocal,
  };
}

module.exports = {
  resolveDateRange,
  DashboardDateError,
  ANALYTICS_CREATED_AT_LOCAL_EXPR,
  PRESETS,
  // fix18-10-hotfix24-A1（Part 7）
  TRACKING_START_DATE,
  getTrackingPeriodInfo,
};
