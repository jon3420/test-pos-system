// scripts/lib/geo-fixture-time.js
// fix18-10-hotfix30-B5-R5.4-G1.4 — Fixture Timezone Flakiness Fix
//
// Root Cause：既有 smoke（G1.3.1／G1.3.2）的真實 sql.js DB fixture 用
// `datetime('now','localtime')` 產生 created_at。SQLite 的 'localtime'
// 修飾詞是跟著「執行環境的作業系統時區」走的——本沙盒容器系統時區是 UTC，
// 但應用程式的日期區間（utils/dashboardDate.js resolveDateRange()）永遠
// 用 Asia/Taipei（UTC+8）計算「今天」的起訖邊界。容器 UTC 時間跟 Taipei
// 時間在跨日附近（Taipei 00:00～UTC 16:00 這段）會落在不同公曆日，
// fixture 用容器時間寫入的 created_at 就可能落在 app 查詢範圍之外，
// 導致 business_total_orders 等欄位查回 0——這是 Test Fixture 時區問題，
// 不是 utils/geoAnalyticsQueries.js／utils/dashboardDate.js 的 Bug，也
// 完全不影響真實部署環境（真實伺服器時區設定正確時不會有這個落差）。
//
// 本模組不修改、不重新實作任何正式日期規則——直接呼叫既有、唯一的
// utils/dashboardDate.js resolveDateRange()，拿到這次查詢真正會用到的
// range.startLocal／range.endLocal，然後取「正中間」當作 fixture
// timestamp，保證在任何情境下都落在查詢範圍內：
//   - preset='today' 時，range.endLocal 是「Asia/Taipei 目前時間」
//     （resolveDateRange 對 today/week/month 的既有邊界規則：累積到目前
//     時間，不是 23:59:59）——不管這個時間窗口在 00:00 剛過後有多窄，
//     midpoint 永遠落在 [start, end] 之間。
//   - 不依賴 process.env.TZ、不依賴容器 OS 時區、不 hardcode 任何日期。

'use strict';

const path = require('path');
const { resolveDateRange } = require(path.join(__dirname, '..', '..', 'utils', 'dashboardDate'));

// startLocal/endLocal 都是「YYYY-MM-DD HH:mm:ss」格式的 naive 字串（沒有
// 時區資訊，兩者都是同一個 Asia/Taipei 參照系）。這裡只需要算「兩個時間
// 點之間的中點」，用 Date.UTC 純粹當計算器使用（把字串裡的數字原樣代入
// UTC 建構子），不代表真的是 UTC 時間，只是借用毫秒運算不出錯——因為
// start/end 兩者都用同一套錯誤假設互相抵銷，中點的「日期時間文字」本身
// 仍然正確落在同一個參照系的中間。
function _parseLocalString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(s);
  if (!m) throw new Error(`fixture timestamp 格式不符 YYYY-MM-DD HH:mm:ss：${s}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
function _formatLocalString(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
}

// 方案 A（需求文件三）：兩個 local 字串的正中點，一定落在 [start, end] 內
// （start <= mid <= end，等號只會在 start===end 這種極端窄窗口時發生，
// 仍然合法落在範圍內，不會落在範圍外）。
function midpointLocalString(startLocal, endLocal) {
  const startMs = _parseLocalString(startLocal);
  const endMs = _parseLocalString(endLocal);
  const midMs = startMs + Math.floor(Math.max(0, endMs - startMs) / 2);
  return _formatLocalString(midMs);
}

// 給 smoke fixture 直接呼叫的入口：回傳「這次呼叫當下、Asia/Taipei
// preset 範圍正中間」的 created_at 字串，格式 YYYY-MM-DD HH:mm:ss（不含
// 'Z'、不含時區後綴，跟既有 orders.created_at 欄位既有格式一致）。
function computeFixtureTimestamp(preset = 'today') {
  const range = resolveDateRange({ preset });
  return midpointLocalString(range.startLocal, range.endLocal);
}

// 提供一個「保證落在範圍外」的時間戳，給需要驗證 Store Isolation／Date
// Filter 邊界的測試使用（例如驗證篩選確實排除範圍外的資料）。刻意往前推
// 兩個公曆日，兩位數安全邊界，不會意外落回今天範圍。
function computeOutOfRangeTimestamp(preset = 'today') {
  const range = resolveDateRange({ preset });
  const startMs = _parseLocalString(range.startLocal);
  return _formatLocalString(startMs - 2 * 24 * 60 * 60 * 1000);
}

module.exports = {
  midpointLocalString,
  computeFixtureTimestamp,
  computeOutOfRangeTimestamp,
};
