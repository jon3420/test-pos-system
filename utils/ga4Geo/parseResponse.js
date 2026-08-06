// utils/ga4Geo/parseResponse.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// 把 GA4 Data API 的原始列（dimensionValues/metricValues 陣列，@google-
// analytics/data SDK 與正式 REST API 共用的形狀）轉成 plain object，供
// services/ga4GeoSyncService.js 使用。同一份 parser 同時被正式 Adapter 與
// Mock Adapter 呼叫（QA Harness 走真實 parser，不是各自模擬一份）。

'use strict';

function parseGa4Rows(response, dimensionNames, metricNames) {
  const rows = (response && response.rows) || [];
  return rows.map((row) => {
    const dims = {};
    (row.dimensionValues || []).forEach((dv, i) => {
      dims[dimensionNames[i]] = dv && dv.value !== undefined ? dv.value : null;
    });
    const metrics = {};
    (row.metricValues || []).forEach((mv, i) => {
      const raw = mv && mv.value !== undefined ? mv.value : '0';
      const num = Number(raw);
      metrics[metricNames[i]] = Number.isFinite(num) ? num : 0;
    });
    return { ...dims, metrics };
  });
}

module.exports = { parseGa4Rows };
