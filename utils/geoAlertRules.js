// utils/geoAlertRules.js — fix18-10-hotfix30-B5-R5.1-B
// 集中解析高流量低轉換等警示門檻，env 可覆寫，非法值一律 fail-safe 退回預設值，
// 絕不因為設定錯誤讓應用啟動失敗（十六、Geo Alerts 要求）。

'use strict';

const DEFAULTS = Object.freeze({
  GEO_ALERT_MIN_VISITORS: 20,
  GEO_ALERT_LOW_CART_RATE: 0.10,
  GEO_ALERT_LOW_ORDER_RATE: 0.02,
  GEO_ALERT_UNKNOWN_RATE: 0.40,
});

function _num(raw, fallback, { min = null, max = null, isInt = false } = {}) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  if (isInt && !Number.isInteger(n)) return fallback;
  if (min !== null && n < min) return fallback;
  if (max !== null && n > max) return fallback;
  return n;
}

function getGeoAlertRules() {
  return {
    // 最低樣本數：至少 1（防止 0 或負數造成任何區域都觸發警示）
    GEO_ALERT_MIN_VISITORS: _num(process.env.GEO_ALERT_MIN_VISITORS, DEFAULTS.GEO_ALERT_MIN_VISITORS, { min: 1, isInt: true }),
    // 比例限制在 0～1
    GEO_ALERT_LOW_CART_RATE: _num(process.env.GEO_ALERT_LOW_CART_RATE, DEFAULTS.GEO_ALERT_LOW_CART_RATE, { min: 0, max: 1 }),
    GEO_ALERT_LOW_ORDER_RATE: _num(process.env.GEO_ALERT_LOW_ORDER_RATE, DEFAULTS.GEO_ALERT_LOW_ORDER_RATE, { min: 0, max: 1 }),
    GEO_ALERT_UNKNOWN_RATE: _num(process.env.GEO_ALERT_UNKNOWN_RATE, DEFAULTS.GEO_ALERT_UNKNOWN_RATE, { min: 0, max: 1 }),
  };
}

module.exports = { getGeoAlertRules, DEFAULTS };
