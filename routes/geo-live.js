// routes/geo-live.js — fix18-10-hotfix30-B5-R5.4-G1
// Geo Intelligence V2｜Live Geo Map + Heatmap Foundation（G1）
//
// 掛載方式（見 server.js）：
//   app.use('/api/geo-live', requireStore, require('./routes/geo-live'));
// requireStore 在掛載時套用一次（沿用 routes/analytics-geo.js 既有慣例）。
//
// 兩種截然不同的存取層級，全部掛在同一支 router 裡（沿用
// routes/analytics-geo.js 同一個 router 也混合不同保護等級端點的慣例）：
//   1. GET 系列（Marker/District/Postal/Replay/Heat Summary/Visitor Timeline）
//      ——後台看板讀取，套用 requireFeature('reports') + requireGeoAnalyticsEnabled，
//      跟其餘 Geo Analytics API 同一組保護。
//   2. POST /coordinate ——前台顧客頁面在使用者「同意定位」後回報真實座標，
//      不套用 requireFeature('reports')（顧客沒有後台權限），只靠 requireStore
//      做 Store Isolation（req.storeId 支援 query.store_id，相容 LINE 點餐頁面
//      既有慣例，見 middleware/storeGuard.js）。
//
// 需求文件十九（Store Isolation）：所有查詢一律用 req.storeId，絕不接受
// req.query.store_id 來「決定」查詢哪一家店的資料（storeGuard 已經把
// query.store_id 解析驗證成 req.storeId，這裡只用 req.storeId）。

'use strict';

const express = require('express');
const router = express.Router();
const { getDb } = require('../utils/db');
const { requireFeature } = require('../middleware/featureGate');
const { getGeoFeatureFlags } = require('../utils/geoFeatureFlags');
const {
  GEO_VISIT_LOG_TIME_RANGES,
  GEO_LIVE_CHANNELS, GEO_LIVE_DEVICES,
  getGeoLiveMarkerPoints, getGeoLiveUnknownPool, getGeoLiveDistricts,
  getGeoLivePostal, getGeoLiveHeatSummaryTop5, getGeoLiveReplayBuckets,
  getGeoLiveVisitorTimeline,
} = require('../utils/geoVisitLog');
const { recordLiveCoordinate, GEO_LIVE_COORD_SOURCES, GEO_COORD_STATUSES, recordCoordinateStatus, getCoordinateStatusSummary } = require('../utils/geoLiveCoordinate');
const { resolveTimeRangeSince } = require('../utils/geoVisitLog');
// fix18-10-hotfix30-B5-R5.4-G1.5：GA4 Realtime Visitor Geo Layer——單一新增
// 端點，沿用同一個 router／同一組 requireFeature('reports') +
// requireGeoAnalyticsEnabled 防護。所有 Google 憑證/Property ID 只在
// utils/ga4Realtime/ 內讀取，本檔案只呼叫聚合後的結果。
const { getGa4RealtimeData, getGa4RealtimeStatus, Ga4RealtimeError } = require('../utils/ga4Realtime');
const { runGa4ConnectionTest } = require('../utils/ga4Realtime/connectionTest');

// 同 routes/analytics-geo.js：GEO_ANALYTICS_ENABLED=false 時，Geo 系列 API
// 統一回 403，不回「安全空結果」（避免看起來像「目前沒有訪客」的誤導）。
function requireGeoAnalyticsEnabled(req, res, next) {
  const flags = getGeoFeatureFlags();
  if (!flags.GEO_ANALYTICS_ENABLED) {
    return res.status(403).json({ success: false, error: 'Geo Analytics is disabled' });
  }
  return next();
}

// 共用的查詢參數解析：range/channel/device（需求文件七／十七／十八）。
// 不合法的 range 一律安全退回 'today'（resolveTimeRangeSince 內部已處理），
// channel/device 不合法值一律視同「全部」，絕不讓不合法輸入變成例外或全表掃描。
function _parseCommonQuery(req) {
  const range = GEO_VISIT_LOG_TIME_RANGES.includes(req.query.range) ? req.query.range : (req.query.range || 'today');
  const channel = typeof req.query.channel === 'string' ? req.query.channel : null;
  const device = GEO_LIVE_DEVICES.includes(req.query.device) ? req.query.device : null;
  return { range, channel, device };
}

function _safeHandler(fn) {
  return (req, res) => {
    try {
      const db = getDb();
      const opts = _parseCommonQuery(req);
      const data = fn(db, req.storeId, opts);
      return res.json({ success: true, data });
    } catch (e) {
      console.error('[geo-live]', e.message);
      return res.status(500).json({ success: false, message: 'Geo Live API 發生錯誤，請稍後再試' });
    }
  };
}

// ── 二／三／十九／二十：Live Marker（只回傳真實座標，見 utils/geoLiveCoordinate.js）
router.get('/markers', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoLiveMarkerPoints));

// ── 五：Unknown Visitor Pool（Known/Unknown/Coverage + Mappable）
router.get('/unknown-pool', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoLiveUnknownPool));

// ── 九：District Layer（動態聚合，不硬編碼行政區）
router.get('/districts', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoLiveDistricts));

// ── 十：Postal Layer
router.get('/postal', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoLivePostal));

// ── 十三：Heat Summary Top5
router.get('/heat-summary', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoLiveHeatSummaryTop5));

// ── 七／十五：Replay 時間軸重算
router.get('/replay', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const opts = _parseCommonQuery(req);
    opts.bucketMinutes = req.query.bucket_minutes;
    const data = getGeoLiveReplayBuckets(db, req.storeId, opts);
    return res.json({ success: true, data });
  } catch (e) {
    console.error('[geo-live/replay]', e.message);
    return res.status(500).json({ success: false, message: 'Geo Live Replay API 發生錯誤，請稍後再試' });
  }
});

// ── 十一／十六：Marker Tooltip + Geo Conversion 漏斗（單一訪客）
// visitor_key 是 VISITOR_KEY_SQL 算出來的值（visitor_id 優先），不是原始
// PII——回應本身也再次遮罩，不回傳完整 visitor_id/session_id（見需求文件十一
// 「不得顯示個資」）。
router.get('/visitor/:key', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const data = getGeoLiveVisitorTimeline(db, req.storeId, req.params.key);
    return res.json({ success: true, data });
  } catch (e) {
    console.error('[geo-live/visitor]', e.message);
    return res.status(500).json({ success: false, message: 'Geo Live Visitor API 發生錯誤，請稍後再試' });
  }
});

// ── 十七／十八：Filters 選項列舉（前端動態產生篩選按鈕用，不硬編碼在前端）
router.get('/filters', requireFeature('reports'), (req, res) => {
  return res.json({
    success: true,
    data: {
      time_ranges: GEO_VISIT_LOG_TIME_RANGES,
      channels: GEO_LIVE_CHANNELS,
      devices: GEO_LIVE_DEVICES,
    },
  });
});

// ── 真實座標來源狀態（誠實揭露：目前系統唯二允許的 Marker 座標來源）
router.get('/coordinate-sources', requireFeature('reports'), (req, res) => {
  return res.json({
    success: true,
    data: {
      allowed_sources: GEO_LIVE_COORD_SOURCES,
      // google_geolocation_api 只有在呼叫端真的握有 wifi/cell 訊號時才會啟用，
      // 純瀏覽器網頁沒有這類硬體訊號存取權，因此目前實務上永遠是
      // available:false（誠實揭露，不假裝已經在運作，見架構文件）。
      google_geolocation_api_available: false,
    },
  });
});

// ══════════════════════════════════════════════════════════════════
// POST /coordinate — 真實座標回報（Browser Geolocation API 等）
//
// 公開端點（顧客頁面呼叫，非後台）：不套用 requireFeature('reports')，只靠
// requireStore 做 Store Isolation。body 大小/型別由 utils/geoLiveCoordinate.js
// 的 validateCoordinate() 嚴格驗證；驗證失敗一律 400，絕不「盡量猜測」寫入。
// ══════════════════════════════════════════════════════════════════
// ── 二：座標同意 Coverage（總訪客／可畫座標／拒絕／逾時／不支援／無法取得／未知）
router.get('/coverage', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const opts = _parseCommonQuery(req);
    const since = resolveTimeRangeSince(opts.range);
    const data = getCoordinateStatusSummary(db, req.storeId, since);
    return res.json({ success: true, data });
  } catch (e) {
    console.error('[geo-live/coverage]', e.message);
    return res.status(500).json({ success: false, message: 'Geo Live Coverage API 發生錯誤，請稍後再試' });
  }
});

// ══════════════════════════════════════════════════════════════════
// POST /coordinate — 真實座標／同意狀態回報
//
// 公開端點（顧客頁面呼叫，非後台）：不套用 requireFeature('reports')，只靠
// requireStore 做 Store Isolation。
//
// body.status：
//   'granted'   → 必須同時提供合法 lat/lng/source，由
//                 utils/geoLiveCoordinate.js validateCoordinate() 嚴格驗證；
//                 驗證通過才同時寫入 geo_live_coordinates（Marker 用）與
//                 geo_coordinate_status_log（稽核／Coverage 用）。驗證失敗
//                 一律 400，不寫入任何一張表（不得「盡量猜測」）。
//   其餘狀態值   → denied/timeout/unavailable/unsupported/error/unknown 都
//                 不需要、也不接受 lat/lng（就算呼叫端誤傳也不會被寫入座標
//                 表），只記錄到 geo_coordinate_status_log，供 Coverage KPI
//                 與「使用者已經拒絕過，不得再次彈出」的前端判斷使用。
// ══════════════════════════════════════════════════════════════════
router.post('/coordinate', (req, res) => {
  try {
    const db = getDb();
    const b = req.body || {};
    const status = GEO_COORD_STATUSES.includes(b.status) ? b.status : (b.status ? 'unknown' : 'granted');

    if (status === 'granted') {
      const result = recordLiveCoordinate(db, {
        store_id: req.storeId,
        visitor_id: b.visitor_id,
        session_id: b.session_id,
        lat: b.lat,
        lng: b.lng,
        accuracy_m: b.accuracy_m,
        source: b.source,
      });
      if (!result.ok) {
        // granted 但驗證沒過 → 誠實回 400，不偷偷改記成別的狀態掩蓋失敗原因。
        return res.status(400).json({ success: false, message: result.reason || '座標驗證失敗' });
      }
      recordCoordinateStatus(db, {
        store_id: req.storeId, visitor_id: b.visitor_id, session_id: b.session_id,
        status: 'granted', source: b.source, accuracy_m: b.accuracy_m,
      });
      return res.json({ success: true });
    }

    // 非 granted：只記錄狀態，不接受／不寫入任何座標資料。
    if (!b.visitor_id || !b.session_id) {
      return res.status(400).json({ success: false, message: 'visitor_id/session_id 必填' });
    }
    const statusResult = recordCoordinateStatus(db, {
      store_id: req.storeId, visitor_id: b.visitor_id, session_id: b.session_id,
      status, source: b.source || null, accuracy_m: null,
    });
    if (!statusResult.ok) {
      return res.status(400).json({ success: false, message: statusResult.reason || '狀態寫入失敗' });
    }
    return res.json({ success: true, status: statusResult.status });
  } catch (e) {
    console.error('[geo-live/coordinate]', e.message);
    return res.status(500).json({ success: false, message: '座標寫入暫時失敗，請稍後再試' });
  }
});

// ══════════════════════════════════════════════════════════════════
// GET /ga4-realtime — fix18-10-hotfix30-B5-R5.4-G1.5
// GA4 Realtime Visitor Geo Layer（依 county 聚合，見 utils/ga4Realtime/）。
//
// 刻意不回傳任何「combined_total」欄位——GA4 活躍使用者與系統
// geo_visit_log/geo_live_coordinates 訪客人數口徑不同（GA4 是帳號層級全站
// 即時活躍數，系統 Visitor 是本店 event log 統計），不得相加，見架構文件。
// ══════════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════════
// GET /ga4-realtime — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime Visitor Geo Layer（Summary Request 去重 + City Request 聚合，
// 見 utils/ga4Realtime/index.js）。
//
// Store／Property／Stream 隔離：一律用 req.storeId 查該店自己的 GA4 設定
// （utils/ga4RealtimeConfig.js），完全不接受 query.property_id／
// query.stream_id／query.credentials（就算呼叫端傳了也直接忽略，不讀取）。
//
// 刻意不回傳任何「combined_total」欄位——GA4 活躍使用者與系統
// geo_visit_log/geo_live_coordinates 訪客人數口徑不同，不得相加，見架構文件。
// ══════════════════════════════════════════════════════════════════
const GA4_ROUTE_WINDOWS = ['5', '30'];
const GA4_ROUTE_METRICS = ['visitors', 'view_item', 'add_to_cart', 'checkout', 'purchase'];

router.get('/ga4-realtime', requireFeature('reports'), requireGeoAnalyticsEnabled, async (req, res) => {
  const windowRaw = GA4_ROUTE_WINDOWS.includes(req.query.window) ? req.query.window : '5';
  const metricRaw = GA4_ROUTE_METRICS.includes(req.query.metric) ? req.query.metric : 'visitors';
  const forceRefresh = req.query.refresh === '1';
  try {
    const db = getDb();
    const data = await getGa4RealtimeData({
      db, storeId: req.storeId, window: Number(windowRaw), metric: metricRaw, forceRefresh,
    });
    return res.json({ success: true, data });
  } catch (e) {
    const code = (e instanceof Ga4RealtimeError) ? e.code : 'GA4_API_ERROR';
    const retryable = (e instanceof Ga4RealtimeError) ? e.retryable : false;
    const httpStatus = (e instanceof Ga4RealtimeError) ? e.httpStatus : 500;
    // fix18-10-hotfix30-B5-R5.4-G1.5-B2.4：新增 stage（'summary'|null）——
    // 只有 Summary 失敗（或 Request 本身不合法）才會走到這個 catch，City
    // 單獨失敗已在 orchestrator 轉成 Partial Success（HTTP 200），不會拋到
    // 這裡（見需求文件八）。
    const stage = (e instanceof Ga4RealtimeError) ? e.stage : null;
    // 需求文件十七、八：Error response 只能回
    // success/code/stage/message/retryable/status，不得回
    // stack/rawError/credential 內容。
    console.error('[geo-live/ga4-realtime]', code);
    return res.status(httpStatus).json({ success: false, code, stage, message: 'GA4 Realtime API 發生錯誤，請稍後再試', retryable, status: 'error' });
  }
});

// GET /ga4-realtime-status — 診斷用（enabled/configured/健康狀態），不含憑證，
// 預設不呼叫 Google API（live_check 權限判斷延後到有可靠管理者判斷機制的
// 階段；本階段擴充欄位見 utils/ga4Realtime/index.js 的 getGa4RealtimeStatus()）。
router.get('/ga4-realtime-status', requireFeature('reports'), (req, res) => {
  const db = getDb();
  return res.json({ success: true, data: getGa4RealtimeStatus(db, req.storeId) });
});

// ══════════════════════════════════════════════════════════════════
// POST /ga4-realtime-test — fix18-10-hotfix30-B5-R5.4-G1.5-B2
// Connection Test：只讀，只用「目前已儲存的該店設定」（req.storeId），
// 完全不接受 body 傳入的 property/stream/credentials（見需求文件八）。
// Rate limit／single-flight 由 utils/ga4Realtime/connectionTest.js 內部處理
// （同店 30 秒內最多一次真正的 Google 呼叫）。
// ══════════════════════════════════════════════════════════════════
router.post('/ga4-realtime-test', requireFeature('reports'), async (req, res) => {
  try {
    const db = getDb();
    const result = await runGa4ConnectionTest(db, req.storeId);
    return res.json({ success: true, data: result });
  } catch (e) {
    console.error('[geo-live/ga4-realtime-test]', e.message);
    return res.status(500).json({ success: false, message: '連線測試發生錯誤，請稍後再試' });
  }
});

module.exports = router;
