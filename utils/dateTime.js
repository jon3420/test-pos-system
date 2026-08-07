// utils/dateTime.js — fix18-10-hotfix30-B5-R5.4-G1.6-A1.2.1
// Geo Event Taiwan Time & Estimate Marker Verification Hotfix
//
// 單一集中的時間 Helper，供伺服器端所有需要「UTC 儲存 → Asia/Taipei 顯示／
// 邊界計算」的模組共用。不得在各自 Renderer/Query 手動 +8 小時（需求文件
// 四）。
//
// Contract（需求文件三）：
//   1. 資料庫（geo_visit_log.event_time／analytics_events.created_at）
//      繼續儲存 UTC，不修改歷史資料、不批次加 8 小時。
//   2. 本模組只負責「解析既有 UTC 字串」與「輸出 Asia/Taipei 顯示字串／
//      日曆日 UTC 邊界」，不寫入資料庫、不改變任何既有欄位。
//   3. 已帶 Z 或 offset 的時間不得再加 8 小時（parseStoredUtcTimestamp 會
//      辨識這兩種情況，只有「純 SQLite datetime('now') 格式（無 Z／無
//      offset）」才會被當作 UTC 補上 Z 解析，避免雙重轉換）。
//   4. invalid/null timestamp 必須安全回傳 null／'—'，不得回傳
//      Invalid Date／NaN／1970-01-01。

'use strict';

const SQLITE_NAIVE_RE = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?$/; // 無 Z、無 offset
const HAS_TZ_RE = /(Z|[+-]\d{2}:?\d{2})$/;

// parseStoredUtcTimestamp(value) → Date | null
//
// 接受：
//   - SQLite naive 字串（'2026-08-05 01:52:36' 或帶 'T'）→ 明確按 UTC 解析
//     （這是本專案 DB DEFAULT (datetime('now')) 產生的格式，見
//     R5.4-G1.6-A1.2.1_TIMEZONE_REALITY_AUDIT.md）。
//   - 已帶 Z 或 offset 的 ISO 字串 → 直接用 Date 解析，不再加 8 小時。
//   - epoch milliseconds（number 或純數字字串）。
//   - 已是 Date 物件。
// 無法辨識來源時區、或值為 null/undefined/空字串/非法字串 → 回傳 null
// （不得自行猜測時區並加 8 小時，見需求文件五 D）。
function parseStoredUtcTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (!s) return null;

  // 純數字（epoch ms 字串）
  if (/^\d{10,}$/.test(s)) {
    const d = new Date(Number(s));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (HAS_TZ_RE.test(s)) {
    // 已帶 Z／offset：直接解析，不做任何 +8 小時調整（需求文件三之 8）。
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  if (SQLITE_NAIVE_RE.test(s)) {
    // 明確按 UTC 解析（需求文件三之 9：SQLite UTC 字串缺少 timezone 時，
    // 必須由單一 helper 明確按 UTC 解析）。
    const iso = s.replace(' ', 'T') + 'Z';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? null : d;
  }

  // 其他無法辨識來源時區的格式：不得自行猜測，回傳 null。
  return null;
}

function isValidTimestamp(value) {
  return parseStoredUtcTimestamp(value) !== null;
}

// toUtcIsoString(value) → 'YYYY-MM-DDTHH:mm:ss.sssZ' | null
function toUtcIsoString(value) {
  const d = parseStoredUtcTimestamp(value);
  return d ? d.toISOString() : null;
}

const TAIPEI_FORMATTER = new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  hour12: false,
});

// formatTaipeiDateTime(value) → 'YYYY-MM-DD HH:mm:ss' | '—'
// 唯一的伺服器端 Asia/Taipei 顯示 Helper。前端（public/js/date-time-format.js）
// 有獨立但等價的實作（瀏覽器端不 require Node 模組）。
function formatTaipeiDateTime(value) {
  const d = parseStoredUtcTimestamp(value);
  if (!d) return '—';
  const parts = TAIPEI_FORMATTER.formatToParts(d);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}:${map.second}`;
}

// getTaipeiDayUtcRange(dateInput) → { startUtc, endUtcExclusive }
//
// dateInput 省略時＝「now」；否則接受 Date／可解析的時間值，用它所在的
// Asia/Taipei 日曆日。回傳的兩個字串是 SQLite 可直接比較的 UTC
// 'YYYY-MM-DD HH:mm:ss' 格式，供 [start, end) 查詢使用（需求文件七：不用
// 23:59:59.999，避免精度與重複計算問題）。
function getTaipeiDayUtcRange(dateInput) {
  const base = dateInput === undefined || dateInput === null
    ? new Date()
    : (parseStoredUtcTimestamp(dateInput) || new Date());

  // 用 Intl 取出 base 對應的 Asia/Taipei 日曆日（年/月/日），再用該日曆日
  // 00:00:00 Asia/Taipei（= 該日 16:00:00 前一天 UTC，固定 UTC+8，台灣不
  // 實行夏令時間，故偏移量固定）換算回 UTC。
  const parts = TAIPEI_FORMATTER.formatToParts(base);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });

  // 該台灣日曆日 00:00:00 對應的 UTC 時間 = 前一日 16:00:00 UTC。
  const startUtcMs = Date.UTC(
    Number(map.year), Number(map.month) - 1, Number(map.day),
    -8, 0, 0, 0 // 減 8 小時，Date.UTC 會自動正確地把日期往前推
  );
  const startUtc = new Date(startUtcMs);
  const endUtc = new Date(startUtcMs + 24 * 60 * 60 * 1000);

  const fmt = (d) => d.toISOString().replace('T', ' ').slice(0, 19);
  return {
    startUtc: fmt(startUtc),
    endUtcExclusive: fmt(endUtc),
  };
}

// getTaipeiCalendarDateString(dateInput, offsetDays) → 'YYYY-MM-DD'
//
// fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.3-EVENT-COMPAT：GA4-H1 Historical
// 「今天／昨天／近 7 天／近 30 天」需要的是 Asia/Taipei 日曆日字串（不是
// getTaipeiDayUtcRange() 回傳的 UTC 邊界字串），且必須可以做 ±N 天位移
// （offsetDays）。這裡刻意重用同一個 TAIPEI_FORMATTER（跟
// getTaipeiDayUtcRange／formatTaipeiDateTime 同一份 Intl 實例，同一套
// Asia/Taipei 解析邏輯，不是第二套 timezone 實作——見
// R5.4-G1.6-GA4-H1.3-EVENT-COMPAT_REALITY_AUDIT.md 一：本專案已有
// utils/dateTime.js 作為集中 Timezone Helper，本函式只是在同一個檔案內
// 新增「回傳日曆日字串＋支援位移」這個既有 Helper 沒提供的能力，不建立
// 第二套 timezone 模組）。
//
// dateInput 省略時＝「now」（可注入任意 Date／可解析時間值做測試，不依賴
// process.env.TZ 或執行機器時區——所有時區判斷都經由 Intl.DateTimeFormat
// 的 timeZone:'Asia/Taipei' 選項，不使用固定 +8 小時字串位移）。
//
// offsetDays 的日期位移用 Date.UTC() 對「已經是 Asia/Taipei 日曆日」的
// 年/月/日字面值做加減（時、分、秒固定用中午 12:00 UTC 當基準，避免任何
// 日期邊界／月份天數/閏年進位誤差；只借用 Date.UTC 的月曆進位計算，不代表
// 這個時間點有任何實際意義）。
function getTaipeiCalendarDateString(dateInput, offsetDays = 0) {
  const base = dateInput === undefined || dateInput === null
    ? new Date()
    : (parseStoredUtcTimestamp(dateInput) || new Date());

  const parts = TAIPEI_FORMATTER.formatToParts(base);
  const map = {};
  parts.forEach((p) => { map[p.type] = p.value; });

  const shifted = new Date(Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day) + Number(offsetDays || 0), 12, 0, 0));
  const y = shifted.getUTCFullYear();
  const m = String(shifted.getUTCMonth() + 1).padStart(2, '0');
  const d = String(shifted.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  parseStoredUtcTimestamp,
  isValidTimestamp,
  toUtcIsoString,
  formatTaipeiDateTime,
  getTaipeiDayUtcRange,
  getTaipeiCalendarDateString,
};
