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
// fix18-10-hotfix30-B5-R5.1-D1：Cart Geo Attribution × Provider Status
const {
  buildCartRowsWithGeo, buildGeoDistrictRanking, buildSourceAreaTable, buildGeoSummary, topAreas,
} = require('../utils/cartGeoAttribution');
const { getProviderStatus } = require('../utils/geoProviders');
// fix18-10-hotfix30-B5-R5.2-A：Taiwan Administrative Area Intelligence
const { getCountySummary } = require('../utils/geoAnalyticsQueries');
const { listCounties, listSubdivisions, getManifest } = require('../utils/taiwanGeoNormalize');

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
// fix18-10-hotfix30-B5-R5.2-A（Stage 5：統一所有 Geo API 行政區格式）——
// 逐支盤點過現有 query 函式（getGeoOverview/getGeoFunnel/getGeoFulfillment/
// getGeoDistance/getGeoSourceArea/getGeoAlerts），確認它們各自用不同的陣列
// 鍵名承載「每一列一個區域」的資料：
//   getGeoOverview      → top_areas
//   getGeoFunnel        → areas
//   getGeoFulfillment   → areas
//   getGeoDistance      → 依距離帶分組，不是行政區分組，不適用此處理
//   getGeoSourceArea    → rows
//   getGeoAlerts        → alerts（每個 alert 物件本身帶 city/district）
// 為了不重寫每支既有 SQL（風險高、且這些查詢已經各自被 R5.1-B/R5.1-D1
// regression 驗證過），這裡改成統一在 route 層對回應做「後處理」：掃描已知
// 的陣列鍵名，對每個帶 city/district 屬性的物件，用同一組
// resolveTaiwanAdministrativeArea() + buildAreaFieldsForApi() 補上完整統一
// 欄位（county_code/county_name/subdivision_code/subdivision_name/
// subdivision_type/area_key/area_label/resolution），舊欄位（city/district）
// 保留不動（需求文件「保留舊欄位相容性」）。
const AREA_ARRAY_KEYS = ['areas', 'top_areas', 'rows', 'alerts', 'district_ranking', 'source_area'];

// fix18-10-hotfix30-B5-R5.2-A（Stage 7.8）——改用 resolveStoredArea() 取代
// R5.2-A 前期版本直接呼叫 resolveTaiwanAdministrativeArea({city,district})
// 的簡化版本。差異：resolveStoredArea() 會先看有沒有已存的官方代碼（優先
// 於名稱），且明確區分 acquisition／fulfillment 兩種 context，不再靠欄位
// 名稱亂猜。
//
// context 參數可以是：
//   - 字串 'acquisition' / 'fulfillment'：整個陣列統一套用同一個 context。
//   - 函式 (item) => 'acquisition' | 'fulfillment' | null：依每一列動態判斷
//     （/alerts 需要，因為同一個 alerts 陣列混雜 acquisition 類與
//     fulfillment 類警示，見 getGeoAlerts() 已經幫每個 alert 物件加上
//     geo_context 欄位）。回傳 null/其他值時，該列不做 enrichment（保留
//     原樣，例如 data_quality 這種不屬於任何區域的全店級 alert）。
function _enrichAreaFields(data, context) {
  if (!data || typeof data !== 'object') return data;
  const { resolveStoredArea } = require('../utils/taiwanGeoNormalize');
  const resolveContext = typeof context === 'function' ? context : () => context;
  AREA_ARRAY_KEYS.forEach((key) => {
    if (!Array.isArray(data[key])) return;
    data[key] = data[key].map((item) => {
      if (!item || typeof item !== 'object') return item;
      const ctx = resolveContext(item);
      if (ctx !== 'acquisition' && ctx !== 'fulfillment') return item; // 未明確指定 context：原樣保留，不猜測

      let lookupRow = item;
      if (ctx === 'fulfillment' && !('fulfillment_geo_city' in item) && !('shipping_city' in item)) {
        // getGeoFulfillment()／getGeoAlerts() 的 fulfillment 類警示，SQL 端
        // 已經用 `fulfillment_geo_city AS city` 選過，回到 JS 層只剩通用的
        // city/district 欄位名稱——這裡只是把同一份、本來就是履約地址的值
        // 對應回 resolveStoredArea() fulfillment context 認得的欄位名稱，
        // 不是另外生出新資料，也不是把 acquisition 資料誤標成 fulfillment。
        lookupRow = { ...item, fulfillment_geo_city: item.city, fulfillment_geo_district: item.district };
      }
      const areaFields = resolveStoredArea(lookupRow, ctx);
      // Stage 7.8.4／7.8.5：保留所有舊欄位（city/district/geo_city/...），
      // 新的統一欄位（county_code 等）用 resolveStoredArea() 的結果覆蓋——
      // 它本身就是「先看官方代碼、代碼無效才 fallback 名稱」的最終權威判斷，
      // 不會用低品質資訊覆蓋掉正確的代碼。
      return { ...item, ...areaFields };
    });
  });
  return data;
}

function _safeHandler(queryFn, context) {
  return async (req, res) => {
    try {
      const db = getDb();
      const storeId = req.storeId; // requireStore 已驗證，不接受 req.query.store_id
      const filters = parseGeoAnalyticsFilters(req.query || {});
      const data = _enrichAreaFields(queryFn(db, storeId, filters), context);
      const body = { success: true, data };
      // 十一之 8：query helper 若本身已回傳 pagination 形狀（page/limit 欄位），
      // 這裡不重複包一層 pagination，維持單一分頁資訊來源。
      if (data && typeof data === 'object' && 'page' in data && 'limit' in data) {
        body.pagination = { page: data.page, limit: data.limit };
      }
      return res.json(body);
    } catch (error) {
      if (error instanceof GeoAnalyticsFilterError) {
        // fix18-10-hotfix30-B5-R5.2-A（Stage 6.1）：行政區篩選錯誤一律附上固定
        // 錯誤代碼（error.code，例如 unknown_county_code／
        // subdivision_not_in_county）；非行政區篩選錯誤（例如日期格式錯誤）
        // 沒有 code，fallback 用 message 本身，維持既有行為不變。
        return res.status(400).json({ success: false, error: error.code || error.message, message: error.message });
      }
      console.error('[GeoAnalytics] query failed:', error.message);
      return res.status(500).json({ success: false, error: '無法讀取區域分析資料' });
    }
  };
}

// fix18-10-hotfix30-B5-R5.2-A（Stage 7.8.2：Route Context 對照）——
//   /overview      acquisition
//   /funnel        acquisition
//   /fulfillment   fulfillment
//   /distance      不需要（距離級距分組，沒有 city/district 逐列資料）
//   /source-area   acquisition
//   /alerts        依每列 geo_context（getGeoAlerts() 已在每個 alert 物件
//                  上明確標記 'acquisition'／'fulfillment'／null，這裡直接
//                  讀那個欄位，不用型別字串猜測）
router.get('/overview', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoOverview, 'acquisition'));
router.get('/funnel', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoFunnel, 'acquisition'));
router.get('/fulfillment', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoFulfillment, 'fulfillment'));
router.get('/distance', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoDistance));
router.get('/source-area', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoSourceArea, 'acquisition'));
router.get('/alerts', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getGeoAlerts, (item) => item.geo_context || null));
// fix18-10-hotfix30-B5-R5.1-D1（十九、Geo Quality Diagnostics）——在既有
// getGeoQuality() 的統計數字之上，疊加「Visitor IP Geo 現在到底是什麼狀態」
// 的白話文案，取代單純顯示 status:'degraded' 這種只有工程師看得懂的字眼。
// 不改變 getGeoQuality() 本身（仍可能被其他呼叫端使用），只在這條 route 額外
// 組裝診斷用欄位。
function _visitorIpStatusLabel(flags, providerStatus) {
  if (!flags.GEO_VISITOR_IP_ENABLED) return 'Visitor IP Geo：尚未啟用';
  if (!providerStatus.configured) return 'Visitor IP Geo：尚未啟用'; // enabled 但沒設定 provider，效果等同未啟用
  if (providerStatus.success_count === 0 && providerStatus.failure_count === 0) return 'Visitor IP Geo：已設定，等待新資料';
  if (providerStatus.status === 'unhealthy') return 'Visitor IP Geo：服務異常';
  return 'Visitor IP Geo：正常';
}

router.get('/quality', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const filters = parseGeoAnalyticsFilters(req.query || {});
    const data = getGeoQuality(db, storeId, filters);
    const flags = getGeoFeatureFlags();
    const providerStatus = getProviderStatus();
    return res.json({
      success: true,
      data: {
        ...data,
        visitor_ip_geo_status_label: _visitorIpStatusLabel(flags, providerStatus),
        provider: {
          enabled: providerStatus.enabled,
          configured: providerStatus.configured,
          provider: providerStatus.provider,
          status: providerStatus.status,
          cache_hits: providerStatus.cache_hits,
          cache_misses: providerStatus.cache_misses,
          last_success_at: providerStatus.last_success_at,
          last_error_code: providerStatus.last_error_code,
        },
      },
    });
  } catch (error) {
    if (error instanceof GeoAnalyticsFilterError) {
      return res.status(400).json({ success: false, error: error.code || error.message, message: error.message });
    }
    console.error('[GeoAnalytics] quality query failed:', error.message);
    return res.status(500).json({ success: false, error: '無法讀取區域分析資料' });
  }
});

// fix18-10-hotfix30-B5-R5.1-D1（十三～十七：Cart Geo Attribution × Geo
// Conversion Table × Source × Geo）——「購物車訪客區域排行／轉換率／來源交叉
// 分析」三個表格共用同一批已套用 Visitor Geo 的購物車列，避免對同一份資料
// 查詢三次。全部依 identity_key 去重（見 utils/cartGeoAttribution.js 註解）。
function getCartGeoAttributionSummary(db, storeId, filters) {
  const { rows, firstTouchMap, truncated } = buildCartRowsWithGeo(db, storeId, filters);
  const districtRanking = buildGeoDistrictRanking(rows, firstTouchMap);
  return {
    summary: buildGeoSummary(rows, firstTouchMap),
    district_ranking: districtRanking,
    top_areas: topAreas(districtRanking, 5),
    source_area: buildSourceAreaTable(rows, firstTouchMap),
    truncated, // MAX_CANDIDATE_CARTS 被截斷時明確告知，不悄悄回傳不完整結果
  };
}
router.get('/cart-attribution', requireFeature('reports'), requireGeoAnalyticsEnabled, _safeHandler(getCartGeoAttributionSummary, 'acquisition'));

// fix18-10-hotfix30-B5-R5.1-D1（十八、Provider Status API）——刻意不套用
// requireGeoAnalyticsEnabled：這是「Visitor IP Geo 這個 provider 現在的健康
// 狀態」診斷端點，即使 GEO_ANALYTICS_ENABLED 關閉，維運者仍應該能查看 Provider
// 本身有沒有設定/是否健康（例如正在排查為什麼 Geo Analytics 顯示沒有資料）。
// 只需要 reports 權限 + store context（見 requireFeature('reports') 與掛載時
// 已套用的 requireStore），不涉及任何店家專屬資料，因此不必依賴 storeId 查詢，
// 但仍要求 reports 權限，避免未登入或無權限的請求探測伺服器內部狀態。
router.get('/provider-status', requireFeature('reports'), (req, res) => {
  try {
    const status = getProviderStatus();
    // 刻意只回傳 getProviderStatus() 已經過濾好的欄位（enabled/configured/
    // provider/status/last_success_at/last_error_code/cache_hits/cache_misses/
    // success_count/failure_count）——不含 API key、GEO_CACHE_SECRET、raw IP、
    // cache key、provider URL、完整例外 stack（見需求文件十八禁止清單）。
    return res.json({ ok: true, ...status });
  } catch (error) {
    console.error('[GeoAnalytics] provider-status failed:', error.message);
    return res.status(500).json({ ok: false, error: '無法讀取 Provider 狀態' });
  }
});

// fix18-10-hotfix30-B5-R5.2-A（二、County Summary API）——
// geo_context 目前只實作 'acquisition'（= Visitor Geo，沿用既有
// _visitorGeoAttributionCTE／identity 去重，不建立第二套）；其他值
// （例如未來的 'fulfillment'）目前一律 fallback 回 acquisition，不報錯，
// 但也不假裝支援（見下方 400 只在明顯拼字錯誤時觸發，讓前端容易除錯）。
const COUNTY_SUMMARY_SORT_FIELDS = new Set([
  'visitor_count', 'product_view_visitor_count', 'cart_visitor_count', 'checkout_visitor_count',
  'purchase_visitor_count', 'order_count', 'revenue',
  'visitor_to_cart_rate', 'cart_to_purchase_rate', 'visitor_to_purchase_rate',
]);
router.get('/county-summary', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const q = req.query || {};
    const filters = parseGeoAnalyticsFilters(q);
    filters.sort = COUNTY_SUMMARY_SORT_FIELDS.has(q.sort) ? q.sort : 'cart_visitor_count';
    filters.order = q.order === 'asc' ? 'asc' : 'desc';
    const limitNum = Number(q.limit);
    filters.limit = Number.isFinite(limitNum) && limitNum > 0 ? Math.min(Math.floor(limitNum), 100) : 50;
    // county_code/subdivision_code 已經在 parseGeoAnalyticsFilters() 內用共用
    // validateAreaFilters() 驗證過（見 utils/geoAnalyticsFilters.js），
    // filters.countyCode/subdivisionCode 已經是合法代碼或 null，這裡不再重複
    // 驗證一次（R5.2-A Stage 6 之前的舊版本在這裡有一段重複、較弱的手動檢查，
    // 已移除，避免兩套驗證邏輯不一致）。
    const result = getCountySummary(db, storeId, filters);
    return res.json(result);
  } catch (error) {
    if (error instanceof GeoAnalyticsFilterError) {
      return res.status(400).json({ ok: false, error: error.code || error.message, message: error.message });
    }
    console.error('[GeoAnalytics] county-summary failed:', error.message);
    return res.status(500).json({ ok: false, error: '無法讀取縣市彙總資料' });
  }
});

// fix18-10-hotfix30-B5-R5.2-A（三、administrative-areas API）——
// 無參數：manifest + 每個縣市附 subdivision_count。
// 指定合法 county_code：改回傳 { county, subdivisions }（不重複帶 manifest/
// counties，避免同一支 API 回應形狀不一致）。
// 指定不存在的 county_code：400 + 友善訊息，不丟 stack trace。
router.get('/administrative-areas', requireFeature('reports'), (req, res) => {
  try {
    const manifest = getManifest();
    const countyCode = req.query.county_code ? String(req.query.county_code).trim() : null;

    if (countyCode) {
      const county = listCounties().find((c) => c.county_code === countyCode);
      if (!county) {
        return res.status(400).json({ ok: false, error: `找不到縣市代碼：${countyCode}` });
      }
      const subdivisions = listSubdivisions(countyCode).map((s) => ({
        subdivision_code: s.subdivision_code, subdivision_name: s.subdivision_name,
        subdivision_type: s.subdivision_type,
        area_key: `${s.county_code}|${s.subdivision_code}`, area_label: `${county.county_name}－${s.subdivision_name}`,
      }));
      return res.json({ ok: true, county: { county_code: county.county_code, county_name: county.county_name }, subdivisions });
    }

    const counties = listCounties().map((c) => ({
      county_code: c.county_code, county_name: c.county_name,
      subdivision_count: listSubdivisions(c.county_code).length,
    }));
    return res.json({
      ok: true,
      manifest: {
        county_count: manifest.county_count, subdivision_count: manifest.subdivision_count,
        source_version: manifest.source_version, checksum: manifest.checksum,
      },
      counties,
    });
  } catch (error) {
    console.error('[GeoAnalytics] administrative-areas failed:', error.message);
    return res.status(500).json({ ok: false, error: '無法讀取行政區資料' });
  }
});

// fix18-10-hotfix30-B5-R5.2-A（四、available-areas API）——「哪些縣市/鄉鎮
// 市區真的有資料」，供前端下拉選單附註人數／灰階顯示用，但仍必須回傳全部
// 22 縣市（含 0 筆），不得只回傳有資料的（見需求文件十：「不要只回傳有資料
// 區域，因為全台完整資料集仍需保留」）。統計口徑重用 getCountySummary()
// 已經驗證過的 identity 去重邏輯，不建立第二套。
router.get('/available-areas', requireFeature('reports'), requireGeoAnalyticsEnabled, (req, res) => {
  try {
    const db = getDb();
    const storeId = req.storeId;
    const filters = parseGeoAnalyticsFilters(req.query || {});
    filters.limit = null; // available-areas 需要全部縣市，不受 county-summary 預設 limit=50 影響
    const summary = getCountySummary(db, storeId, filters);
    const byCounty = new Map(summary.rows.map((r) => [r.county_code, r]));

    const countyCodeFilter = req.query.county_code ? String(req.query.county_code).trim() : null;
    if (countyCodeFilter) {
      const county = listCounties().find((c) => c.county_code === countyCodeFilter);
      if (!county) return res.status(400).json({ ok: false, error: `找不到縣市代碼：${countyCodeFilter}` });
      // subdivision 層級目前沒有現成的「依 subdivision 分組」聚合函式
      // （getCountySummary 只聚合到縣市），本輪不新建第二套 SQL，改用
      // read-time：對這個縣市底下每個 subdivision，用其中文名稱去比對
      // county-summary 內部已經算好的 district-level 原始列——但那些原始
      // 列目前沒有對外暴露。誠實作法：本輪 subdivision 層級 available-areas
      // 一律回傳 visitor_count 等於 0／has_data:false（見 CHANGELOG Known
      // Limitations），縣市層級數字（上面 counties 陣列）才是本輪真正可信的
      // 「有資料判斷」依據。
      const subdivisions = listSubdivisions(countyCodeFilter).map((s) => ({
        subdivision_code: s.subdivision_code, subdivision_name: s.subdivision_name,
        area_label: `${county.county_name}－${s.subdivision_name}`,
        visitor_count: 0, cart_visitor_count: 0, purchase_visitor_count: 0, has_data: false,
      }));
      return res.json({ ok: true, county: { county_code: county.county_code, county_name: county.county_name }, subdivisions });
    }

    const counties = listCounties().map((c) => {
      const r = byCounty.get(c.county_code);
      return {
        county_code: c.county_code, county_name: c.county_name,
        visitor_count: r ? r.visitor_count : 0,
        cart_visitor_count: r ? r.cart_visitor_count : 0,
        purchase_visitor_count: r ? r.purchase_visitor_count : 0,
        has_data: !!r && r.visitor_count > 0,
      };
    });
    return res.json({ ok: true, counties });
  } catch (error) {
    if (error instanceof GeoAnalyticsFilterError) {
      return res.status(400).json({ ok: false, error: error.code || error.message, message: error.message });
    }
    console.error('[GeoAnalytics] available-areas failed:', error.message);
    return res.status(500).json({ ok: false, error: '無法讀取行政區資料狀態' });
  }
});

module.exports = router;
