// utils/ga4Geo/productionAdapter.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// 正式 GA4 Adapter：完全沿用既有 utils/ga4Realtime/client.js 的 lazy
// singleton Client 與憑證載入邏輯（需求文件五「不得為了只打一支 API 而
// 使用語意錯誤的指標組合」／「單一 GA4 Client」）——本檔案不重新建立任何
// Client 或憑證解析邏輯，只組 Request 與呼叫既有 runGa4RealtimeReport /
// runGa4Report，再用共用 parser 轉成 plain rows。

'use strict';

const client = require('../ga4Realtime/client');
const {
  buildRealtimeGeoRequest, buildAudienceRangeRequest,
  buildEventFunnelRangeRequest, buildCommerceRangeRequest,
} = require('./requestBuilders');
const { parseGa4Rows } = require('./parseResponse');

async function runRealtimeGeo(propertyId, options = {}) {
  const req = buildRealtimeGeoRequest(propertyId);
  const result = await client.runGa4RealtimeReport(req, options);
  if (!result.ok) return result;
  return { ok: true, rows: parseGa4Rows(result, ['country', 'region', 'city'], ['activeUsers', 'eventCount']) };
}

async function runAudienceRange(propertyId, startDate, endDate, options = {}) {
  const req = buildAudienceRangeRequest(propertyId, startDate, endDate);
  const result = await client.runGa4Report(req, options);
  if (!result.ok) return result;
  return { ok: true, rows: parseGa4Rows(result, ['country', 'region', 'city'], ['activeUsers', 'newUsers', 'sessions']) };
}

async function runEventFunnelRange(propertyId, startDate, endDate, options = {}) {
  const req = buildEventFunnelRangeRequest(propertyId, startDate, endDate);
  const result = await client.runGa4Report(req, options);
  if (!result.ok) return result;
  return { ok: true, rows: parseGa4Rows(result, ['country', 'region', 'city', 'eventName'], ['eventCount']) };
}

async function runCommerceRange(propertyId, startDate, endDate, options = {}) {
  const req = buildCommerceRangeRequest(propertyId, startDate, endDate);
  const result = await client.runGa4Report(req, options);
  if (!result.ok) return result;
  return { ok: true, rows: parseGa4Rows(result, ['country', 'region', 'city'], ['transactions', 'purchaseRevenue']) };
}

module.exports = { runRealtimeGeo, runAudienceRange, runEventFunnelRange, runCommerceRange };
