// utils/ga4Geo/mockAdapter.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// QA Harness 專用 Mock GA4 Adapter。不得在 production code path require
// 這個檔案（只有 scripts/run-g1-6-ga4-h1-qa.js 會 require）。
//
// 刻意產生跟正式 GA4 API 相同形狀的原始列（dimensionValues/metricValues），
// 再走跟正式 Adapter 完全相同的 parseGa4Rows()，確保 QA 走的是真實 parser
// 程式碼，不是另一份模擬邏輯（見需求文件十九：「必須走真實 Production Sync
// Service」）。

'use strict';

const { parseGa4Rows } = require('./parseResponse');

function _rawRow(dimValues, metricValues) {
  return {
    dimensionValues: dimValues.map((v) => ({ value: v })),
    metricValues: metricValues.map((v) => ({ value: String(v) })),
  };
}

function createMockAdapter(scenario = {}) {
  // scenario shape:
  // {
  //   realtime: [{ country,region,city, activeUsers, eventCount }, ...] | 'timeout' | 'error',
  //   audience: [{ country,region,city, activeUsers,newUsers,sessions }, ...] | 'timeout',
  //   eventFunnel: [{ country,region,city, eventName, eventCount }, ...],
  //   commerce: [{ country,region,city, transactions, purchaseRevenue }, ...],
  //   propertyNotBound: bool (adapter should never even be called in that case),
  // }
  return {
    async runRealtimeGeo(propertyId) {
      if (scenario.realtime === 'timeout') return { ok: false, code: 'TIMEOUT', retryable: true, message: 'mock timeout' };
      if (scenario.realtime === 'error') return { ok: false, code: 'API_ERROR', retryable: false, message: 'mock api error' };
      const rows = (scenario.realtime || []).map((r) => _rawRow(
        [r.country, r.region, r.city],
        [r.activeUsers ?? 0, r.eventCount ?? 0]
      ));
      return { ok: true, rows: parseGa4Rows({ rows }, ['country', 'region', 'city'], ['activeUsers', 'eventCount']) };
    },
    async runAudienceRange(propertyId, startDate, endDate) {
      if (scenario.audience === 'timeout') return { ok: false, code: 'TIMEOUT', retryable: true, message: 'mock timeout' };
      const rows = (scenario.audience || []).map((r) => _rawRow(
        [r.country, r.region, r.city],
        [r.activeUsers ?? 0, r.newUsers ?? 0, r.sessions ?? 0]
      ));
      return { ok: true, rows: parseGa4Rows({ rows }, ['country', 'region', 'city'], ['activeUsers', 'newUsers', 'sessions']) };
    },
    async runEventFunnelRange(propertyId, startDate, endDate) {
      const rows = (scenario.eventFunnel || []).map((r) => _rawRow(
        [r.country, r.region, r.city, r.eventName],
        [r.eventCount ?? 0]
      ));
      return { ok: true, rows: parseGa4Rows({ rows }, ['country', 'region', 'city', 'eventName'], ['eventCount']) };
    },
    async runCommerceRange(propertyId, startDate, endDate) {
      const rows = (scenario.commerce || []).map((r) => _rawRow(
        [r.country, r.region, r.city],
        [r.transactions ?? 0, r.purchaseRevenue ?? 0]
      ));
      return { ok: true, rows: parseGa4Rows({ rows }, ['country', 'region', 'city'], ['transactions', 'purchaseRevenue']) };
    },
  };
}

module.exports = { createMockAdapter };
