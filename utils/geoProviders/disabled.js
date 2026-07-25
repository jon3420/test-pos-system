// utils/geoProviders/disabled.js — fix18-10-hotfix30-B5-R5.1-D
//
// 預設 Provider（GEO_VISITOR_IP_PROVIDER 未設定，或設定為 'disabled' 時使用）。
// 完全不對外發出任何網路請求，一律回傳「未設定」，讓上層 fail-open 為
// unknown。這是最安全的預設狀態——沒有明確設定真正的 Provider 之前，
// 系統絕不會把訪客 IP 送到任何第三方服務。

'use strict';

const name = 'disabled';

async function lookupVisitorGeo(_ip, _options = {}) {
  return { ok: false, provider: name, code: 'PROVIDER_DISABLED', message: 'Visitor IP geo provider not configured' };
}

module.exports = { name, lookupVisitorGeo };
