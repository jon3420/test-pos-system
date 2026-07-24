// utils/geoFeatureFlags.js — fix18-10-hotfix30-B5-R5.1-A Geo Data Foundation
//
// 全域 env-based feature flag（獨立於既有 middleware/featureGate.js 的
// per-store license/plan features——GEO_* 是部署層級開關，不是店家授權，
// 兩者概念不同，不合併）。
//
// 預設值依需求文件十八：
//   GEO_ANALYTICS_ENABLED=true   —— Geo 維度／API 本身
//   GEO_VISITOR_IP_ENABLED=false —— IP 推定進站區域（涉及外部服務/隱私/部署環境，預設關閉）
//   GEO_MAP_ENABLED=false        —— 行政區地圖（缺乏可信 GeoJSON 依賴前先關閉）
//   GEO_ALERTS_ENABLED=true      —— 高流量低轉換等規則式警示
//
// 讀取一律用 truthy 字串比對（'0'/'false'/'' → false，其餘含明確 'true' → true），
// 未設定時使用上述預設值，避免部署環境忘記設定 env 就整批開關錯誤。

'use strict';

function _boolFromEnv(raw, defaultVal) {
  if (raw === undefined || raw === null || raw === '') return defaultVal;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return defaultVal;
}

function getGeoFeatureFlags() {
  return {
    GEO_ANALYTICS_ENABLED:    _boolFromEnv(process.env.GEO_ANALYTICS_ENABLED, true),
    GEO_VISITOR_IP_ENABLED:   _boolFromEnv(process.env.GEO_VISITOR_IP_ENABLED, false),
    GEO_MAP_ENABLED:          _boolFromEnv(process.env.GEO_MAP_ENABLED, false),
    GEO_ALERTS_ENABLED:       _boolFromEnv(process.env.GEO_ALERTS_ENABLED, true),
  };
}

module.exports = { getGeoFeatureFlags };
