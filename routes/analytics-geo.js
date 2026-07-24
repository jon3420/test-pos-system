// routes/analytics-geo.js — fix18-10-hotfix30-B5-R5.1-B
// Geo Event Wiring × Geo Analytics API × Data Quality — 第七階段：Geo Analytics API Routes
//
// 掛載方式沿用 routes/analytics.js 的既有慣例（見 server.js:
// `app.use('/api/analytics', requireStore, require('./routes/analytics'))`）：
// requireStore 在掛載時套用一次，本檔案內每條 route 各自套用
// requireFeature('reports')（與 /cart-abandonment、/drilldown、/visitor-360
// 等既有端點同一組保護，不另創新的權限系統）。
//
// store_id 一律來自 req.storeId（由 requireStore middleware 解析、驗證過），
// 絕不接受 req.query.store_id 來決定查詢商家（十二、第七階段：Store Isolation）。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireFeature } = require('../middleware/featureGate');
const { getGeoFeatureFlags } = require('../utils/geoFeatureFlags');
const { parseGeoAnalyticsFilters, GeoAnalyticsFilterError } = require('../utils/geoAnalyticsFilters');
const {
  getGeoOverview, getGeoFunnel, getGeoFulfillment, getGeoDistance,
  getGeoSourceArea, getGeoAlerts, getGeoQuality,
} = require('../utils/geoAnalyticsQueries');

// fix18-10-hotfix30-B5-R5.1-B（七之 A）：GEO_ANALYTICS_ENABLED=false 時，Geo
// API 系列統一回 403 + 安全訊息（不是安全空結果——這系列端點本身就是「Geo
// Analytics」，關閉時沒有部分結果可言）。Dashboard 的 geo_summary 是另一條
// 路徑（routes/analytics.js 的 GET /dashboard），關閉時回空結構、不影響整個
// Dashboard，兩者刻意不同（見十、Stage 10 Dashboard 規則）。
function requireGeoAnalyticsEnabled(req, res, next) {
  const flags = getGeoFeatureFlags();
  if (!flags.GEO_ANALYTICS_ENABLED) {
    return res.status(403).json({ success: false, error: 'Geo Analytics is disabled' });
  }
  return next();
}

// 統一的安全錯誤處理：production 不回 stack trace，SQL/內部錯誤只回安全訊息。
function _safeHandler(queryFn) {
  return async (req, res) => {
    try {
      const db = getDb();
      const storeId = req.storeId; // requireStore 已驗證，不接受 req.query.store_id
      const filters = parseGeoAnalyticsFilters(req.query || {});
      const data = queryFn(db, storeId, filters);
      const body = { success: true, data };
      // 十一之 8：query helper 若本身已回傳 pagination 形狀（page/limit 欄位），
      // 這裡不重複包一層 pagination，維持單一分頁資訊來源。
      if (data && typeof data === 'object' && 'page' in data && 'limit' in data) {
        body.pagination = { page: data.page, limit: data.limit };
      }
      return res.json(body);
    } catch (error) {
      if (error instanceof GeoAnalyticsFilterError) {
        return res.status(400).json({ success: false, error: error.message });
      }
      console.error('[GeoAnalytics] query failed:', error.message);
      return res.status(500).json({ success: false, error: '無法讀取區域分析資料' });
    }
  };
}

router.get('/overview', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoOverview));
router.get('/funnel', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoFunnel));
router.get('/fulfillment', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoFulfillment));
router.get('/distance', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoDistance));
router.get('/source-area', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoSourceArea));
router.get('/alerts', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoAlerts));
router.get('/quality', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoQuality));

module.exports = router;
