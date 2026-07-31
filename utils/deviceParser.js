// utils/deviceParser.js — fix18-10-hotfix30-B5-R5.4-G1 (Geo Intelligence V2 — Live Geo Layer)
//
// 目的：G1 需求文件十八「Device Filter：Android / iPhone / Desktop / Tablet」。
//
// 決策記錄（誠實揭露，比照 utils/geoProviders/ipapi.js 的揭露慣例）：
//   - 專案目前完全沒有裝置分類資料來源（見 public/js/geo-intelligence.js
//     geoBuildDeviceBreakdown() 直接回傳 geoBuildExplorerUnavailableState
//     ('device_breakdown')，即「目前無此資料」）。
//   - 本模組是本輪唯一新增的裝置分類來源：對呼叫端提供的 User-Agent 字串
//     做「純函式、決定性（deterministic）」的規則比對，不使用
//     Math.random()、不讀取任何第三方裝置指紋 API、不臆測沒有 UA 字串時的
//     裝置別。
//   - 只有呼叫端明確提供 User-Agent（例如 req.headers['user-agent']）時才會
//     分類；未提供則一律回傳 'unknown'，不得猜測預設值（見 G1 需求文件
//     二十四「Static Audit：無硬編碼」）。
'use strict';

const DEVICE_TYPES = Object.freeze(['android', 'iphone', 'ipad_tablet', 'desktop', 'unknown']);

const DEVICE_TYPE_LABELS = Object.freeze({
  android: 'Android',
  iphone: 'iPhone',
  ipad_tablet: 'Tablet',
  desktop: 'Desktop',
  unknown: 'Unknown',
});

// 純函式：完全依 User-Agent 字串內容做決定性判斷，同一輸入永遠回傳同一結果。
function classifyDeviceType(userAgent) {
  const ua = String(userAgent || '').trim();
  if (!ua) return 'unknown';
  const low = ua.toLowerCase();

  // iPad／Android 平板：判斷順序在 iPhone/Android 之前，避免 iPad UA 裡
  // 同時含有 'mobile' 關鍵字造成誤判。
  if (low.includes('ipad') || (low.includes('macintosh') && low.includes('touch'))) return 'ipad_tablet';
  if (low.includes('android') && !low.includes('mobile')) return 'ipad_tablet';

  if (low.includes('iphone')) return 'iphone';
  if (low.includes('android')) return 'android';

  if (low.includes('windows') || low.includes('macintosh') || low.includes('linux') || low.includes('x11')) {
    return 'desktop';
  }
  return 'unknown';
}

function isValidDeviceType(v) {
  return DEVICE_TYPES.includes(v);
}

module.exports = {
  DEVICE_TYPES,
  DEVICE_TYPE_LABELS,
  classifyDeviceType,
  isValidDeviceType,
};
