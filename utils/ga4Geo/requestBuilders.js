// utils/ga4Geo/requestBuilders.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// 需求文件五（Historical Query Plan）：不強迫所有指標塞進同一支查詢。
// Realtime 只有一支（country/region/city + activeUsers/eventCount，GA4
// Realtime API 相容性已知沒問題——沿用既有 G1.5-A 已驗證過的維度/指標組合，
// 見 utils/ga4Realtime/requestBuilder.js）。Historical 拆成三支：
//   A. Audience   — country/region/city → activeUsers/newUsers/sessions
//   B. Event Funnel — country/region/city/eventName → eventCount
//   C. Commerce   — country/region/city → transactions/purchaseRevenue
//
// 本輪未實際對線上 GA4 Property 執行 Metadata API 探測（見
// R5.4-G1.6-GA4-H1_REALITY_AUDIT.md「未驗證」章節——正式環境目前無法連線
// GA4 API）。這三支查詢的維度/指標組合是 GA4 官方文件記載的相容組合，但
// 「Production GA4 Gate」在真的對正式 Property 跑過一次之前，仍標示
// READY FOR MANUAL DEPLOYMENT VERIFICATION，不写 PASS（見需求文件二十九）。

'use strict';

const GA4_EVENT_NAMES = Object.freeze({
  page_view: 'page_view',
  view_item: 'view_item',
  view_product: 'view_item', // 部分 GA4 Enhanced Ecommerce 設定用 view_item 涵蓋兩者；
                              // 若正式站台實際使用不同事件名，需在 Reality Audit 後更新此
                              // mapping（event_mapping_version 需同步遞增）。
  add_to_cart: 'add_to_cart',
  begin_checkout: 'begin_checkout',
  checkout_click: 'checkout_click', // 非 GA4 官方預設事件名，僅在站台有自訂事件時才會出現；
                                     // 查無資料時該列 count 一律為 0，不視為錯誤。
  purchase: 'purchase',
});
const EVENT_MAPPING_VERSION = 'v1';

function buildRealtimeGeoRequest(propertyId) {
  return {
    property: `properties/${propertyId}`,
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }],
    metrics: [{ name: 'activeUsers' }, { name: 'eventCount' }],
    minuteRanges: [{ startMinutesAgo: 29, endMinutesAgo: 0 }],
  };
}

function buildAudienceRangeRequest(propertyId, startDate, endDate) {
  return {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }],
    metrics: [{ name: 'activeUsers' }, { name: 'newUsers' }, { name: 'sessions' }],
    limit: 100000,
  };
}

function buildEventFunnelRangeRequest(propertyId, startDate, endDate) {
  return {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }, { name: 'eventName' }],
    metrics: [{ name: 'eventCount' }],
    dimensionFilter: {
      filter: {
        fieldName: 'eventName',
        inListFilter: { values: Object.values(GA4_EVENT_NAMES) },
      },
    },
    limit: 100000,
  };
}

function buildCommerceRangeRequest(propertyId, startDate, endDate) {
  return {
    property: `properties/${propertyId}`,
    dateRanges: [{ startDate, endDate }],
    dimensions: [{ name: 'country' }, { name: 'region' }, { name: 'city' }],
    metrics: [{ name: 'transactions' }, { name: 'purchaseRevenue' }],
    limit: 100000,
  };
}

module.exports = {
  GA4_EVENT_NAMES,
  EVENT_MAPPING_VERSION,
  buildRealtimeGeoRequest,
  buildAudienceRangeRequest,
  buildEventFunnelRangeRequest,
  buildCommerceRangeRequest,
};
