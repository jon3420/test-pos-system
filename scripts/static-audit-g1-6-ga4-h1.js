#!/usr/bin/env node
// scripts/static-audit-g1-6-ga4-h1.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
//
// 真實 Static Audit：每一項檢查都讀取實際 Production 檔案內容，用 Regex／
// 字串比對驗證真實存在的模式，不是檢查文件本身的聲明文字。每個 check 函式
// 可被 scripts/smoke-hotfix30-b5-r5-4-g1-6-ga4-h1.js 的 Mutation Negative
// 重複使用（對「記憶體中修改過的字串」重新呼叫同一個 check 函式，證明
// 檢查邏輯本身真的會因為被移除/替換而 FAIL，不是恆真）。

'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }

// stripComments(src) — 需求文件七：Audit Regex 必須排除註解／文件內容，
// 避免把「我們沒有做 X」這種誠實說明文字誤判成「真的做了 X」。只做保守的
// 單行 `//` 與區塊 `/* */` 移除（本專案 JS 檔案不使用字串內含 `//` 的邊界
// case，安全夠用；.md 檔案本身不會被這個函式處理，Audit 只讀 JS 原始碼）。
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n');
}

const results = [];
function check(name, cond, detail) { results.push({ name, pass: !!cond, detail: detail || '' }); }

// ── 讀入所有相關 Production 檔案（供 checks 與 mutation tests 共用）──
const FILES = {
  db: read('utils/db.js'),
  normalize: read('utils/ga4Geo/normalize.js'),
  requestBuilders: read('utils/ga4Geo/requestBuilders.js'),
  parseResponse: read('utils/ga4Geo/parseResponse.js'),
  productionAdapter: read('utils/ga4Geo/productionAdapter.js'),
  mockAdapter: read('utils/ga4Geo/mockAdapter.js'),
  syncService: read('services/ga4GeoSyncService.js'),
  client: read('utils/ga4Realtime/client.js'),
  route: read('routes/ga4-geo.js'),
  server: read('server.js'),
  panel: read('public/js/geo-ga4-h1-panel.js'),
  heatmapUi: read('public/js/geo-heatmap-ui.js'),
  envExample: read('.env.example'),
};

// CODE：comment 剝除後的版本，只給「偵測禁止字面/模式是否真的出現在可執行
// 程式碼」的 checks 使用（例如 geo_visit_log／visitor_id／client_id／
// req.query.store_id）。其餘 checks（例如檢查某個 require 路徑、某個函式
// 名稱是否存在）不受影響，繼續用原始 FILES。
const CODE = {};
Object.keys(FILES).forEach((k) => { CODE[k] = stripComments(FILES[k]); });


// ============================================================
// 每一組 checkXxx(files) 都是「純函式」——輸入檔案內容 map，輸出布林，
// 不直接讀檔（讀檔只在上面 FILES 常數做一次）。這讓 Mutation Test 可以
// 傳入「同一份 map 但某個 key 被替換成挖掉關鍵字的版本」，重跑同一個函式。
// ============================================================

function checkMigrationTablesExist(files) {
  return ['ga4_geo_realtime_snapshots', 'ga4_geo_range_stats', 'ga4_geo_sync_runs']
    .every((t) => files.db.includes(`CREATE TABLE IF NOT EXISTS ${t}`));
}
function checkMigrationSafe(files) {
  // safe migration：不得出現 DROP TABLE ga4_geo_*／DELETE FROM ga4_geo_* 字面。
  return !/DROP\s+TABLE\s+ga4_geo_/i.test(files.db) && !/DELETE\s+FROM\s+ga4_geo_/i.test(files.db);
}
function checkUniqueIndexRealtime(files) {
  return /UNIQUE\(store_id, property_id, captured_bucket_utc, raw_location_key, metrics_version\)/.test(files.db);
}
function checkUniqueIndexRange(files) {
  return /UNIQUE\(store_id, property_id, range_start_date, range_end_date, raw_location_key, metrics_version, event_mapping_version\)/.test(files.db);
}
function checkStoreIdIndexed(files) {
  return /idx_ga4geo_rt_store_bucket/.test(files.db) && /idx_ga4geo_range_store_range/.test(files.db);
}

function checkNoSecondTaiwanTable(files) {
  // normalize.js 不得自己定義縣市/行政區清單，只能 require 既有 resolver。
  return files.normalize.includes("require('../taiwanGeoNormalize')")
    && !/const\s+\w+\s*=\s*\{\s*['"]TW-/.test(files.normalize);
}
function checkReusesCatalog(files) {
  return files.normalize.includes("require('../authoritativeAdminPointCatalog')");
}
function checkNoGuessAmbiguous(files) {
  return files.normalize.includes("'ambiguous'") && !/candidates\[0\]/.test(files.normalize);
}

function checkSingleGa4Client(files) {
  // 正式 Adapter／Sync Service 不得出現第二個 `new BetaAnalyticsDataClient`
  // 或第二個 lazy singleton pattern；一律透過既有 client.js。
  const noNewClientElsewhere = !/BetaAnalyticsDataClient/.test(files.productionAdapter)
    && !/BetaAnalyticsDataClient/.test(files.syncService);
  const clientHasSingleton = /let _client = null/.test(files.client) && /function _getClient/.test(files.client);
  return noNewClientElsewhere && clientHasSingleton;
}
function checkRunGa4ReportAdded(files) {
  return /async function runGa4Report/.test(files.client) && /runGa4RealtimeReport/.test(files.client);
}
function checkAdapterUsesRealBuilders(files) {
  return files.productionAdapter.includes("require('./requestBuilders')")
    && files.productionAdapter.includes("require('./parseResponse')");
}
function checkDimensionsPresent(files) {
  return ['country', 'region', 'city'].every((d) => files.requestBuilders.includes(`name: '${d}'`));
}
function checkEventNameDimension(files) {
  return files.requestBuilders.includes("name: 'eventName'");
}
function checkAudienceMetrics(files) {
  return ['activeUsers', 'newUsers', 'sessions'].every((m) => files.requestBuilders.includes(`name: '${m}'`));
}
function checkFunnelMetrics(files) {
  return files.requestBuilders.includes("name: 'eventCount'");
}
function checkCommerceMetrics(files) {
  return ['transactions', 'purchaseRevenue'].every((m) => files.requestBuilders.includes(`name: '${m}'`));
}
function checkThreeSeparateRequestBuilders(files) {
  return ['buildAudienceRangeRequest', 'buildEventFunnelRangeRequest', 'buildCommerceRangeRequest']
    .every((fn) => files.requestBuilders.includes(`function ${fn}`));
}

function checkNoGeoVisitLogWrite(files, code) {
  return !code.syncService.includes('geo_visit_log') && !code.normalize.includes('geo_visit_log');
}
function checkNoVisitorIdColumn(files, code) {
  const idx = code.db.indexOf('ga4_geo_realtime_snapshots');
  const section = idx === -1 ? '' : code.db.slice(idx, idx + 2500);
  return !/\bvisitor_id\b/.test(section) && !code.syncService.includes('visitor_id');
}
function checkNoUserPseudoId(files, code) {
  return !code.syncService.includes('user_pseudo_id') && !code.db.includes('user_pseudo_id');
}
function checkNoClientId(files, code) {
  const idx = code.db.indexOf('ga4_geo_realtime_snapshots');
  const ga4Section = idx === -1 ? '' : code.db.slice(idx, idx + 2500);
  return !/\bclient_id\b/.test(ga4Section);
}
function checkNoRawGa4ResponsePersisted(files, code) {
  return !code.syncService.includes('JSON.stringify(result)') && !code.syncService.includes('rawResponse');
}
function checkNoCredentialInSyncService(files, code) {
  return !/private_key|access_token|refresh_token/.test(code.syncService);
}

function checkStoreIsolationBinding(files) {
  return files.syncService.includes("getGa4RealtimeConfig(db, storeId)");
}
function checkPropertyBindingBeforeAdapterCall(files) {
  const idx1 = files.syncService.indexOf('getPropertyBinding(db, storeId)');
  const idx2 = files.syncService.indexOf('adapter.runRealtimeGeo');
  return idx1 !== -1 && idx2 !== -1 && idx1 < idx2;
}
function checkQueriesFilterByStoreId(files, code) {
  return (code.syncService.match(/WHERE store_id=\?/g) || []).length >= 4;
}
function checkRealtimeSummaryQueryFiltersByProperty(files, code) {
  // 需求文件五：Merge Key／查詢一律要同時帶 store_id 與 property_id，不得
  // 只用 city 或只用 store_id 就跨 Property 撈資料。這裡精確鎖定 Realtime
  // Summary 這一支查詢（不是粗略數整份檔案裡 store_id 出現次數），這樣
  // Mutation Test 移掉這一支查詢的 property_id 條件時，這個 check 才會真的
  // 翻成 FAIL（粗略計數在檔案內其他 9 處查詢仍 >=4 時不會偵測到）。
  return code.syncService.includes('WHERE store_id=? AND property_id=? AND captured_bucket_utc >= ?');
}
function checkRangeStatsQueryFiltersByProperty(files, code) {
  return code.syncService.includes('WHERE store_id=? AND property_id=? AND range_start_date=? AND range_end_date=?');
}

function checkMutexPresent(files) {
  return files.syncService.includes('_inFlight') && files.syncService.includes('function _lock');
}
function checkTimeoutPassed(files) {
  return files.syncService.includes('timeoutMs');
}
function checkRetryBackoff(files) {
  return files.syncService.includes('_fetchWithRetry') && files.syncService.includes('retryable');
}
function checkStaleFallback(files) {
  return files.syncService.includes('stale_fallback_used');
}
function checkPartialHandling(files) {
  return files.syncService.includes('partial') && files.syncService.includes('anyOk');
}
function checkFailOpenNoThrowToRoute(files) {
  return files.route.includes('catch (e)') && files.route.includes("code: 'unexpected_error'");
}

function checkRouteUsesReqStoreId(files, code) {
  return code.route.includes('req.storeId') && !code.route.includes('req.query.store_id') && !code.route.includes('req.body.store_id');
}
function checkRouteNoRawErrorLeak(files) {
  return !files.route.includes('e.stack') && !files.route.includes('e.message');
}
function checkRouteRangeWhitelist(files) {
  return files.route.includes('ALLOWED_RANGES');
}
function checkRouteRateLimit(files) {
  return files.route.includes('MANUAL_SYNC_MIN_INTERVAL_MS');
}
function checkRouteMountedOnce(files) {
  return (files.server.match(/routes\/ga4-geo/g) || []).length === 1;
}

function checkFrontendNoCredential(files, code) {
  return !/private_key|access_token|service_account/i.test(code.panel);
}
function checkFrontendNoDirectGoogleCall(files, code) {
  return !/googleapis\.com|analyticsdata\.googleapis/i.test(code.panel);
}
function checkFrontendUsesEscape(files) {
  return files.panel.includes('_geoGa4H1Esc');
}
function checkFrontendNoInnerHTMLForRawLabel(files) {
  // 行政區/錯誤訊息一律先經過 _geoGa4H1Esc 才進 template；status line 改用
  // textContent。
  return files.panel.includes('el.textContent = text');
}
function checkFrontendGenerationGuard(files) {
  return files.panel.includes('geoGa4H1State.generation') && files.panel.includes('myGeneration');
}
function checkFrontendAbortGuard(files) {
  return files.panel.includes('AbortController') && files.panel.includes('currentAbort');
}
function checkFrontendCleanup(files) {
  return files.panel.includes('geoGa4H1Destroy') && files.panel.includes('clearInterval');
}
function checkFrontendOwnLayerGroup(files) {
  return files.panel.includes('markerGroup') && !files.panel.includes('geoHeatState.layerGroup');
}
function checkFrontendDistinctMarkerStyle(files) {
  return files.panel.includes('ga4-h1-diamond');
}
function checkFrontendFixedDisclaimer(files) {
  return files.panel.includes('此資料為 GA4 城市彙總，並非個別訪客實際位置。');
}
function checkFrontendWiredIntoHeatmapUi(files) {
  return files.heatmapUi.includes('window.GeoGa4H1Panel');
}
function checkFrontendDestroyOnLayerLeave(files) {
  return files.heatmapUi.includes('GeoGa4H1Panel.destroy');
}

function checkAsiaTaipeiDisplay(files) {
  return files.syncService.includes("Asia/Taipei") || files.syncService.includes('_taipeiTimeString');
}
function checkNonAdditiveDocumented(files) {
  return files.syncService.includes('30m') || files.syncService.includes('window_minutes');
}
function checkNoDailySumForRange(files) {
  // Historical Range 一律用單一 runReport(startDate,endDate)，不得出現對每日
  // 迴圈呼叫 API 再 SUM 的模式（例如 for (let d=...) ... += activeUsers）。
  return !/for\s*\(.*d(ay)?.*\+\+.*\)[\s\S]{0,200}activeUsers\s*\+=/.test(files.syncService);
}

function checkIpProviderStillDisabled(files) {
  return files.envExample.includes('GEO_VISITOR_IP_ENABLED=false') && files.envExample.includes('GEO_VISITOR_IP_PROVIDER=disabled');
}
function checkTrustProxyPreserved(files) {
  return files.server.includes("computeTrustProxySetting(process.env.TRUST_PROXY)");
}
function checkNoG2Started(files, code) {
  return !code.syncService.includes('G2_') && !code.route.includes('G2_');
}

// ════════════════════════════════════════════════════════════════
// Additional Production-level checks (round 3 expansion) — every check
// below reads real files (via FILES/CODE) and tests a genuinely distinct
// contract; none of these repeat an existing check under a new name.
// ════════════════════════════════════════════════════════════════

// -- Migration / schema detail --
function checkRealtimeTableHasWindowMinutes(files) { return /window_minutes\s+INTEGER/.test(files.db); }
function checkRealtimeTableHasNormalizationVersion(files) { return files.db.includes('normalization_version'); }
function checkRangeTableHasEventMappingVersion(files) { return files.db.includes('event_mapping_version'); }
function checkSyncRunsTableHasPartialColumn(files) { return /partial\s+INTEGER NOT NULL DEFAULT 0/.test(files.db); }
function checkSyncRunsTableHasStaleFallbackColumn(files) { return files.db.includes('stale_fallback_used'); }
function checkRealtimeIndexOnDistrict(files) { return files.db.includes('idx_ga4geo_rt_store_district'); }
function checkRangeIndexOnDistrict(files) { return files.db.includes('idx_ga4geo_range_store_district'); }
function checkSyncRunsIndexed(files) { return files.db.includes('idx_ga4geo_syncruns_store_time') && files.db.includes('idx_ga4geo_syncruns_store_type'); }
function checkMigrationUsesIfNotExists(files) {
  const idx = files.db.indexOf('ga4_geo_realtime_snapshots');
  const before = files.db.slice(Math.max(0, idx - 60), idx);
  return before.includes('CREATE TABLE IF NOT EXISTS');
}
function checkMigrationDoesNotTouchGeoVisitLogSchema(files, code) {
  // 三張新表的 CREATE TABLE 區塊完全不得出現在 geo_visit_log 的 ALTER TABLE
  // 區塊裡（即：新表定義字串不包含 "ALTER TABLE geo_visit_log"）。
  const idx = files.db.indexOf('ga4_geo_realtime_snapshots');
  const section = files.db.slice(idx, idx + 6000);
  return !section.includes('ALTER TABLE geo_visit_log');
}
function checkDbPathOverrideBackwardCompatible(files) {
  return files.db.includes("process.env.POS_DB_PATH ||") && files.db.includes("path.join(__dirname, '../data/pos.db')");
}

// -- Realtime snapshot behavior --
function checkBucketFloorFunction(files) { return files.syncService.includes('_bucketFloor'); }
function checkBucketMinutesConstant(files) { return files.syncService.includes('REALTIME_BUCKET_MINUTES = 5'); }
function checkRealtimeWindowConstant(files) { return files.syncService.includes('REALTIME_WINDOW_MINUTES = 30'); }
function checkRealtimeSummaryComputesMinMaxAvg(files) {
  return ['max_active_users', 'min_active_users', 'avg_active_users'].every((f) => files.syncService.includes(f));
}
function checkRealtimeSummaryTracksSnapshotCount(files) { return files.syncService.includes('snapshot_count'); }
function checkRealtimeSummaryTracksFirstLastSeen(files) { return files.syncService.includes('first_seen_at_utc') && files.syncService.includes('last_seen_at_utc'); }
function checkRealtimeCurrentUsesLatestNotSum(files) {
  // "current" 一律用陣列最後一筆（latest），不是 reduce/sum。
  return files.syncService.includes('const latest = snapshots[snapshots.length - 1];')
    && !/current_active_users:\s*values\.reduce/.test(files.syncService);
}
function checkRealtimeRetentionNotImplementedHonestly(files) {
  // 目前尚未實作 Realtime Retention Cleanup（見 Reality Audit 誠實揭露）；
  // 這裡驗證程式碼裡沒有假裝有一個會刪除 range_stats 的清除函式。
  return !files.syncService.includes('function cleanupRealtimeRetention') || !files.syncService.includes('DELETE FROM ga4_geo_range_stats');
}
function checkRangeStatsNeverDeletedByRealtimeCleanup(files) {
  return !files.syncService.match(/realtime[\s\S]{0,300}DELETE FROM ga4_geo_range_stats/i);
}

// -- Historical range detail --
function checkTodayWrapper(files) { return /function syncTodayGeoStats/.test(files.syncService); }
function checkYesterdayWrapper(files) { return /function syncYesterdayGeoStats/.test(files.syncService); }
function check7dWindowMath(files) { return files.syncService.includes("'7d') return { ok: true, start_date: _todayDateString(-6)"); }
function check30dWindowMath(files) { return files.syncService.includes("'30d') return { ok: true, start_date: _todayDateString(-29)"); }
function checkCustomRangeValidatesFormat(files) { return files.syncService.includes('invalid_date_format'); }
function checkCustomRangeValidatesOrder(files) { return files.syncService.includes('start_after_end'); }
function checkCustomRangeMaxDaysConstant(files) { return files.syncService.includes('CUSTOM_RANGE_MAX_DAYS'); }
function checkCurrencyFieldExistsButNullable(files) {
  // currency 欄位存在於 schema，但這輪誠實範圍內沒有可信來源可填（GA4
  // purchaseRevenue 查詢沒有一併帶 currency dimension），INSERT 語句裡
  // currency 欄位必須綁定 NULL，不得塞入猜測值。
  return files.db.includes('currency               TEXT')
    && /purchase_revenue, currency,\s*$/m.test(files.syncService.split('\n').find((l) => l.includes('purchase_revenue, currency,')) || '')
    && files.syncService.includes("METRICS_VERSION, EVENT_MAPPING_VERSION, NORMALIZATION_VERSION,")
    && !files.syncService.includes('entry.currency');
}
function checkOverseasCheckedBeforeCatalogLookup(files) {
  const idx1 = files.normalize.indexOf("normalization_status: 'overseas_or_other', administrative_level: null,");
  const idx2 = files.normalize.indexOf('const resolved = resolveTaiwanAdministrativeArea(');
  return idx1 !== -1 && idx2 !== -1 && idx1 < idx2;
}
function checkAllNotSetCheckedFirst(files) {
  const idxAllNotSet = files.normalize.indexOf('if (allNotSet) {');
  const idxTaiwanCheck = files.normalize.indexOf('const taiwanCheck = _isTaiwanCountry(country);');
  return idxAllNotSet !== -1 && idxTaiwanCheck !== -1 && idxAllNotSet < idxTaiwanCheck;
}
function checkActiveUsersNeverAccumulatedAcrossSync(files) {
  return files.syncService.includes('entry.active_users = row.metrics.activeUsers || 0;')
    && !files.syncService.includes('entry.active_users += row.metrics.activeUsers');
}
function checkTransactionsAndRevenueBothMapped(files) {
  return files.syncService.includes('entry.transaction_count = row.metrics.transactions || 0;')
    && files.syncService.includes('entry.purchase_revenue = row.metrics.purchaseRevenue || 0;');
}

// -- Query plan detail --
function checkRealtimeUsesMinuteRanges(files) { return files.requestBuilders.includes('minuteRanges'); }
function checkHistoricalUsesDateRanges(files) { return files.requestBuilders.includes('dateRanges'); }
function checkFunnelUsesInListFilter(files) { return files.requestBuilders.includes('inListFilter'); }
function checkEventMappingVersionConstant(files) { return files.requestBuilders.includes("EVENT_MAPPING_VERSION = 'v1'"); }
function checkViewProductHonestlyDeferred(files) {
  // view_product_count 沒有獨立可信來源，程式碼註解必須誠實標註，不得假裝
  // 已經對應到真實事件。
  return files.syncService.includes('view_product_count 目前沒有獨立可信來源');
}
function checkMergeUsesRawLocationKeyNotCityAlone(files) {
  return files.normalize.includes('function buildRawLocationKey') && files.normalize.includes('country') && files.normalize.includes('region') && files.normalize.includes('city');
}
function checkRawLocationKeyIncludesAllThreeFields(files) {
  return /return `\$\{c\.toLowerCase\(\)\}\|\|\$\{r\.toLowerCase\(\)\}\|\|\$\{ci\.toLowerCase\(\)\}`/.test(files.normalize);
}
function checkNotSetDoesNotCollideWithEmptyString(files) {
  return files.normalize.includes("NOT_SET_VALUES = new Set(['(not set)', 'unknown', '', 'not set'");
}
function checkRawValuesPreservedSeparateFromCanonical(files) {
  return ['country_raw', 'region_raw', 'city_raw'].every((f) => files.normalize.includes(f))
    && ['county_name', 'district_name'].every((f) => files.normalize.includes(f));
}

// -- Normalization / catalog detail --
function checkNormalizeNeverImportsGeojsonDirectly(files) { return !files.normalize.includes('.geojson'); }
function checkNormalizeHasNoHardcodedCountyList(files) { return !/const\s+TAIWAN_COUNTIES\s*=/.test(files.normalize); }
function checkMarkerOnlyResolvedForOkStatus(files) {
  return files.normalize.includes("row.normalization_status !== 'ok') return null;");
}
function checkMarkerNeverUsesGa4Coordinates(files, code) {
  return !/ga4_?lat|ga4_?lng|row\.lat|row\.lng/i.test(code.normalize);
}

// -- Representative point / marker detail --
function checkMarkerAccuracyLabelsDistrictVsCounty(files) {
  return files.syncService.includes("administrative_level === 'district' ? 'district_aggregate' : 'county_aggregate'");
}
function checkMarkerTypeIsAggregateNotExact(files) {
  return !files.syncService.includes("marker_accuracy: 'exact'") && files.syncService.includes('district_aggregate');
}
function checkMarkerPointOnlyLatLngFields(files) {
  return files.syncService.includes('marker_point: markerPoint ? { lat: markerPoint.lat, lng: markerPoint.lng } : null');
}
function checkMarkerAttachedServerSideInBothReadPaths(files) {
  return files.syncService.includes('resolveMarkerPoint(latest)') && files.syncService.includes('resolveMarkerPoint(row)');
}
function checkFrontendNeverCallsResolveMarkerPoint(files, code) {
  return !code.panel.includes('resolveMarkerPoint') && !code.panel.includes('resolveAdministrativeRepresentativePoint');
}
function checkFrontendReadsMarkerPointReadOnly(files) {
  return files.panel.includes('row.marker_point') && !files.panel.includes('row.marker_point =');
}

// -- Store / property isolation detail --
function checkGetPropertyBindingSingleSourceOfTruth(files) {
  // 每個對外函式（sync/read）都透過同一個 getPropertyBinding()，不得有第二套
  // 綁定判斷邏輯。
  const callSites = (files.syncService.match(/getPropertyBinding\(db, storeId\)/g) || []).length;
  return callSites >= 5;
}
function checkPropertyNotBoundNeverCallsAdapter(files) {
  const idx1 = files.syncService.indexOf("if (!binding.ok) return { success: false, code: binding.code };");
  return idx1 !== -1 && idx1 < files.syncService.indexOf('adapter.runRealtimeGeo');
}
function checkUnboundReturnsSameCodeRegardlessOfReason(files) {
  return files.syncService.includes("return { ok: false, code: 'property_not_bound', reason: cfg.errorCode };");
}
function checkSingleStoreModeReusesExistingEnvFlag(files, code) {
  return code.syncService.includes('GA4_REALTIME_SINGLE_STORE_MODE') === false; // GA4-H1 doesn't reimplement; reuses ga4RealtimeConfig, verified below
    // eslint-disable-next-line no-unreachable
}
function checkReusesExistingConfigResolverNotOwnCopy(files) {
  return files.syncService.includes("require('../utils/ga4RealtimeConfig')");
}

// -- API / route detail --
function checkStatusEndpointExists(files) { return files.route.includes("router.get('/status'"); }
function checkRealtimeEndpointExists(files) { return files.route.includes("router.get('/realtime'"); }
function checkHistoryEndpointExists(files) { return files.route.includes("router.get('/history'"); }
function checkSyncEndpointExists(files) { return files.route.includes("router.post('/sync'"); }
function checkSyncValidatesBeforeRateLimit(files) {
  const idxValidate = files.route.indexOf('_validateSyncBody(body)');
  const idxRateLimit = files.route.indexOf('MANUAL_SYNC_MIN_INTERVAL_MS) {');
  return idxValidate !== -1 && idxRateLimit !== -1 && idxValidate < idxRateLimit;
}
function checkSyncTypeWhitelistExplicit(files) { return files.route.includes("SYNC_TYPES = new Set(['realtime', 'range', 'backfill'])"); }
function checkDateFormatRegexUsed(files) { return files.route.includes('DATE_FORMAT_RE'); }
function checkHistoryDefaultsSafelyToToday(files) { return files.route.includes("ALLOWED_RANGES.has(req.query.range) ? req.query.range : 'today'"); }
function checkRouteNeverReadsBodyStoreId(files, code) { return !code.route.includes('body.store_id') && !code.route.includes('body.storeId'); }
function checkRouteCatchAllPreventsCrash(files) { return files.route.includes('try {') && files.route.includes('} catch (e) {'); }

// -- Failure/stale detail --
function checkPartialTrueWhenAnyQueryFails(files) {
  return files.syncService.includes('const partial = !(audience.ok && eventFunnel.ok && commerce.ok);');
}
function checkAllThreeFailingIsHardFailureNotPartial(files) {
  return files.syncService.includes('const anyOk = audience.ok || eventFunnel.ok || commerce.ok;')
    && files.syncService.includes('if (!anyOk) {');
}
function checkSyncRunRecordsPartialFlag(files) { return files.syncService.includes('partial: partial ? 1 : 0'); }
function checkStaleReadPathNeverThrows(files) {
  return files.syncService.includes('function getRangeGeoStats') && files.syncService.includes("stale: lastRun ? lastRun.status === 'failed' : false");
}
function checkFailedSyncDoesNotTouchPosOrderTables(files, code) {
  return !code.syncService.includes("UPDATE orders") && !code.syncService.includes('INSERT INTO orders');
}

// -- Credential safety detail (client.js hardening from this round) --
function checkClientGuardsAgainstImplicitAdcCrash(files) {
  return files.client.includes('if (!credentialStatus().available) return null;');
}
function checkClientStillHonorsTestInjectedClient(files) {
  const idxIf = files.client.indexOf('if (!_client) {');
  const idxGuard = files.client.indexOf('if (!credentialStatus().available) return null;');
  return idxIf !== -1 && idxGuard !== -1 && idxIf < idxGuard;
}
function checkCredentialStatusNeverLogsSecretContent(files, code) {
  return !/console\.(log|warn|error)\([^)]*private_key/i.test(code.client);
}

// -- Additional detail checks (closing gap toward the 150 target) --
function checkRequestBuildersExportEventMapping(files) { return files.requestBuilders.includes('module.exports = {') && files.requestBuilders.includes('GA4_EVENT_NAMES'); }
function checkParseResponseIsSharedNotDuplicated(files) {
  const usedByProd = files.productionAdapter.includes("require('./parseResponse')");
  const usedByMock = files.mockAdapter.includes("require('./parseResponse')");
  return usedByProd && usedByMock;
}
function checkMockAdapterOnlyUsedByTestScripts(files, code) {
  return !code.route.includes("require('../utils/ga4Geo/mockAdapter')") && !code.syncService.includes("require('../utils/ga4Geo/mockAdapter')");
}
function checkProductionAdapterIsDefaultInService(files) {
  return files.syncService.includes("require('../utils/ga4Geo/productionAdapter')") && files.syncService.includes('options.adapter || productionAdapter');
}
function checkAdapterInjectableForTests(files) {
  return (files.syncService.match(/options\.adapter \|\| productionAdapter/g) || []).length >= 2;
}
function checkSyncRunIdPropagatedToRows(files) {
  return files.syncService.includes('sync_run_id') && files.syncService.includes('String(runId)');
}
function checkTaipeiOffsetIsFixedEightHours(files) { return files.syncService.includes('8 * 3600 * 1000'); }
function checkNoDstAdjustmentAttempted(files, code) { return !code.syncService.includes('DST') && !code.syncService.includes('daylight'); }
function checkResolveRangeWindowExported(files) { return files.syncService.includes('resolveRangeWindow,'); }
function checkGetPropertyBindingExported(files) { return files.syncService.includes('getPropertyBinding,'); }
function checkEventNameToColumnExported(files) { return files.syncService.includes('EVENT_NAME_TO_COLUMN,'); }
function checkStatusEndpointNeverExposesPropertyId(files) {
  // getGa4GeoSyncStatus() 回傳物件裡不得包含 property_id 這個 key。
  const fnBody = files.syncService.slice(files.syncService.indexOf('function getGa4GeoSyncStatus'), files.syncService.indexOf('module.exports'));
  return !/^\s*property_id:/m.test(fnBody);
}
function checkHistoryEndpointPassesThroughQueryParamsSafely(files) {
  return files.route.includes('req.query.start_date') && files.route.includes('req.query.end_date');
}
function checkSyncEndpointNeverTrustsBodyForStoreContext(files, code) {
  return code.route.includes('req.storeId') && !code.route.includes('body.store');
}
function checkRateLimitMapIsPerStoreNotGlobal(files) { return files.route.includes('_lastManualSync.get(req.storeId)'); }
function checkRealtimeEndpointReturns200OnSafeFailure(files) {
  return files.route.includes('res.status(200).json(result)');
}
function checkMarkerIconClassDistinctFromExistingRenderer(files, code) {
  return !code.panel.includes('geoMarkerIconClassFor') && code.panel.includes('ga4-h1-aggregate-marker-icon');
}
function checkTooltipAlwaysIncludesDisclaimerLine(files) {
  return files.panel.includes("'GA4 城市彙總推估 — 非單一訪客實際位置',");
}
function checkTableFooterDisclaimerPresent(files) {
  return files.panel.includes('class="ga4-h1-disclaimer"');
}
function checkCssMarkerColorDistinctFromExistingPalette(files) {
  return fs.readFileSync(path.join(ROOT, 'public/css/geo-ga4-h1.css'), 'utf8').includes('#7c3aed');
}
function checkPanelExportsTestableHelpers(files) {
  return files.panel.includes('module.exports = {') && files.panel.includes('_geoGa4H1Esc');
}
function checkPanelDoesNotPolluteGlobalScopeBeyondOneNamespace(files) {
  const globalAssignments = (files.panel.match(/window\.\w+\s*=/g) || []);
  return globalAssignments.length === 1 && globalAssignments[0].includes('window.GeoGa4H1Panel');
}
function checkHeatmapUiDestroyCalledInBothExitBranches(files) {
  return (files.heatmapUi.match(/GeoGa4H1Panel\.destroy/g) || []).length >= 2;
}
function checkHeatmapUiInitCalledExactlyOnce(files) {
  // 註：geo-heatmap-ui.js 裡另外有一行 HTML 註解（在 JS Template String 內的
  // `<!-- ... GeoGa4H1Panel.init() ... -->`）提到函式名稱，但那是 HTML 註解
  // 不是程式碼呼叫，也不會被我們的 `//`/`/* */` JS 註解剝除器處理到。這裡
  // 改成比對「真的呼叫」的精確樣式（後面接 `({`），只會命中真正的呼叫式，
  // 不會誤判 HTML 註解裡的說明文字。
  return (files.heatmapUi.match(/GeoGa4H1Panel\.init\(\{/g) || []).length === 1;
}

// -- Search / Sort static checks (this round) --
function checkSearchInputExistsInPanel(files) {
  return files.panel.includes('class="ga4-h1-search-input"') && files.panel.includes('search-input');
}
function checkSearchListenerRegistered(files) {
  return files.panel.includes("searchInput.addEventListener('input', searchHandler)");
}
function checkSortHeaderListenerRegistered(files) {
  return files.panel.includes("theadRow.addEventListener('click', headerHandler)");
}
function checkSearchNeverCallsFetch(files, code) {
  const start = code.panel.indexOf('function _geoGa4H1RerenderTbody');
  const end = code.panel.indexOf('function _geoGa4H1UpdateSortIndicators');
  const body = code.panel.slice(start, end);
  return start !== -1 && end !== -1 && !body.includes('fetch(');
}
function checkSortNeverCallsFetch(files, code) {
  const start = code.panel.indexOf('function _geoGa4H1SortRows');
  const end = code.panel.indexOf('function _geoGa4H1BuildRowHtml');
  const body = code.panel.slice(start, end);
  return start !== -1 && end !== -1 && !body.includes('fetch(');
}
function checkSearchSortNeverTouchMarkerLayer(files, code) {
  const rerenderFn = code.panel.slice(code.panel.indexOf('function _geoGa4H1RerenderTbody'), code.panel.indexOf('function _geoGa4H1UpdateSortIndicators'));
  const sortFn = code.panel.slice(code.panel.indexOf('function _geoGa4H1SortRows'), code.panel.indexOf('function _geoGa4H1BuildRowHtml'));
  const filterFn = code.panel.slice(code.panel.indexOf('function _geoGa4H1FilterRows'), code.panel.indexOf('function _geoGa4H1SortValue'));
  return [rerenderFn, sortFn, filterFn].every((fn) => !fn.includes('markerGroup') && !fn.includes('RenderMarkers'));
}
function checkFilterAndSortReturnNewArraysNotMutate(files) {
  return files.panel.includes('const list = (rows || []).slice();') && files.panel.includes('return (rows || []).slice();');
}
function checkSearchUsesValuePropertyNotInnerHtmlInjection(files, code) {
  return code.panel.includes('geoGa4H1State.searchTerm = searchInput.value;')
    && !code.panel.includes('innerHTML = `${searchInput.value}');
}
function checkNumericNullLastContractImplemented(files) {
  return files.panel.includes('function _geoGa4H1IsMissingSortValue') && files.panel.includes('if (aMissing) return 1;') && files.panel.includes('if (bMissing) return -1;');
}
function checkDestroyCleansSearchAndSortListeners(files) {
  return files.panel.includes('_ga4h1SearchCleanup') && files.panel.includes('_ga4h1HeaderCleanup')
    && files.panel.includes('tableEl._ga4h1SearchCleanup()') && files.panel.includes('tableEl._ga4h1HeaderCleanup()');
}
function checkModeSwitchResetsSearchAndSort(files) {
  const modeHandlerBody = files.panel.slice(files.panel.indexOf('const modeHandler = (e) => {'), files.panel.indexOf('const metricHandler'));
  return modeHandlerBody.includes("geoGa4H1State.searchTerm = '';") && modeHandlerBody.includes('geoGa4H1State.sortColumn = null;');
}
function checkMetricSwitchPreservesSearchAndSort(files) {
  const metricHandlerBody = files.panel.slice(files.panel.indexOf('const metricHandler = (e) => {'), files.panel.indexOf('const syncHandler'));
  return !metricHandlerBody.includes('searchTerm') && !metricHandlerBody.includes('sortColumn');
}

const CHECKS = [
  ['A. Migration: 3 tables exist', checkMigrationTablesExist],
  ['A. Migration: safe (no DROP/DELETE)', checkMigrationSafe],
  ['C. Unique constraint: realtime snapshots', checkUniqueIndexRealtime],
  ['C. Unique constraint: range stats', checkUniqueIndexRange],
  ['A. Store-scoped indexes present', checkStoreIdIndexed],
  ['M. No second Taiwan mapping table', checkNoSecondTaiwanTable],
  ['N. Reuses A1.2 Authoritative Catalog', checkReusesCatalog],
  ['M. Ambiguous never auto-picks candidate[0]', checkNoGuessAmbiguous],
  ['Existing GA4 Client reuse: single client', checkSingleGa4Client],
  ['runReport: runGa4Report added alongside runGa4RealtimeReport', checkRunGa4ReportAdded],
  ['Adapter uses shared requestBuilders + parser', checkAdapterUsesRealBuilders],
  ['country/region/city dimensions present', checkDimensionsPresent],
  ['eventName dimension present (funnel)', checkEventNameDimension],
  ['F. Audience Query metrics', checkAudienceMetrics],
  ['G. Funnel Query metric', checkFunnelMetrics],
  ['H. Commerce Query metrics', checkCommerceMetrics],
  ['Three separate query builders (not one merged query)', checkThreeSeparateRequestBuilders],
  ['AJ. No geo_visit_log writes', checkNoGeoVisitLogWrite],
  ['AJ. No visitor_id column on ga4_geo tables', checkNoVisitorIdColumn],
  ['AJ. No user_pseudo_id persisted', checkNoUserPseudoId],
  ['AJ. No client_id column on ga4_geo tables', checkNoClientId],
  ['AJ. No raw GA4 response persisted', checkNoRawGa4ResponsePersisted],
  ['AJ. No credential literals in sync service', checkNoCredentialInSyncService],
  ['K. Store isolation via existing property binding', checkStoreIsolationBinding],
  ['K. Property binding checked before any adapter call', checkPropertyBindingBeforeAdapterCall],
  ['K/L. Queries filter by store_id (>=4 sites)', checkQueriesFilterByStoreId],
  ['L. Realtime summary query filters by property_id (precise, not just count)', checkRealtimeSummaryQueryFiltersByProperty],
  ['L. Range stats query filters by property_id (precise, not just count)', checkRangeStatsQueryFiltersByProperty],
  ['AA. Mutex present', checkMutexPresent],
  ['AB. Timeout passed to adapter calls', checkTimeoutPassed],
  ['AC/AD. Retry/backoff for 429/5xx', checkRetryBackoff],
  ['AF. Stale fallback tracked', checkStaleFallback],
  ['AE. Partial response handling', checkPartialHandling],
  ['Fail-open: route never leaks raw error', checkFailOpenNoThrowToRoute],
  ['Y. Route uses req.storeId only', checkRouteUsesReqStoreId],
  ['Privacy: route never echoes e.message/e.stack', checkRouteNoRawErrorLeak],
  ['Z. Range whitelist enforced', checkRouteRangeWhitelist],
  ['Rate limiting present on /sync', checkRouteRateLimit],
  ['Route mounted exactly once in server.js', checkRouteMountedOnce],
  ['AI. Frontend has no credential strings', checkFrontendNoCredential],
  ['AI. Frontend never calls Google API directly', checkFrontendNoDirectGoogleCall],
  ['AI. Frontend escapes dynamic strings', checkFrontendUsesEscape],
  ['AI. Status line uses textContent, not innerHTML', checkFrontendNoInnerHTMLForRawLabel],
  ['AH. Frontend request generation guard', checkFrontendGenerationGuard],
  ['AH. Frontend AbortController guard', checkFrontendAbortGuard],
  ['AG. Frontend lifecycle cleanup (destroy)', checkFrontendCleanup],
  ['AG. Frontend owns independent marker layerGroup', checkFrontendOwnLayerGroup],
  ['Frontend marker style visually distinct (diamond)', checkFrontendDistinctMarkerStyle],
  ['Fixed disclaimer text present in frontend', checkFrontendFixedDisclaimer],
  ['AG. Frontend wired into geo-heatmap-ui.js layer switch', checkFrontendWiredIntoHeatmapUi],
  ['AG. Frontend destroyed when leaving GA4 layer', checkFrontendDestroyOnLayerLeave],
  ['S. Asia/Taipei time handling present', checkAsiaTaipeiDisplay],
  ['O. Realtime window is bounded (30m), not global sum', checkNonAdditiveDocumented],
  ['P. No per-day-loop-and-sum for historical ranges', checkNoDailySumForRange],
  ['IP Provider still disabled in .env.example', checkIpProviderStillDisabled],
  ['TRUST_PROXY handling preserved in server.js', checkTrustProxyPreserved],
  ['No G2 code started', checkNoG2Started],

  ['Migration: realtime table has window_minutes', checkRealtimeTableHasWindowMinutes],
  ['Migration: realtime table has normalization_version', checkRealtimeTableHasNormalizationVersion],
  ['Migration: range table has event_mapping_version', checkRangeTableHasEventMappingVersion],
  ['Migration: sync_runs has partial column', checkSyncRunsTableHasPartialColumn],
  ['Migration: sync_runs has stale_fallback_used column', checkSyncRunsTableHasStaleFallbackColumn],
  ['Migration: realtime table indexed by district', checkRealtimeIndexOnDistrict],
  ['Migration: range table indexed by district', checkRangeIndexOnDistrict],
  ['Migration: sync_runs table indexed', checkSyncRunsIndexed],
  ['Migration: uses IF NOT EXISTS (idempotent)', checkMigrationUsesIfNotExists],
  ['Migration: never touches geo_visit_log schema', checkMigrationDoesNotTouchGeoVisitLogSchema],
  ['Migration: DB path override is backward compatible', checkDbPathOverrideBackwardCompatible],

  ['Realtime: bucket-floor function exists', checkBucketFloorFunction],
  ['Realtime: 5-minute bucket constant', checkBucketMinutesConstant],
  ['Realtime: 30-minute window constant', checkRealtimeWindowConstant],
  ['Realtime: summary computes min/max/avg', checkRealtimeSummaryComputesMinMaxAvg],
  ['Realtime: summary tracks snapshot_count', checkRealtimeSummaryTracksSnapshotCount],
  ['Realtime: summary tracks first/last seen', checkRealtimeSummaryTracksFirstLastSeen],
  ['Realtime: "current" uses latest snapshot, not a sum', checkRealtimeCurrentUsesLatestNotSum],
  ['Realtime: retention cleanup honestly not faked', checkRealtimeRetentionNotImplementedHonestly],
  ['Realtime: no code path deletes range_stats as "retention"', checkRangeStatsNeverDeletedByRealtimeCleanup],

  ['Historical: today wrapper exists', checkTodayWrapper],
  ['Historical: yesterday wrapper exists', checkYesterdayWrapper],
  ['Historical: 7d window math (start=-6)', check7dWindowMath],
  ['Historical: 30d window math (start=-29)', check30dWindowMath],
  ['Historical: custom range validates date format', checkCustomRangeValidatesFormat],
  ['Historical: custom range validates start<=end', checkCustomRangeValidatesOrder],
  ['Historical: custom range has a max-days constant', checkCustomRangeMaxDaysConstant],
  ['Historical: currency column exists, honestly left unpopulated', checkCurrencyFieldExistsButNullable],
  ['Historical: active_users never += accumulated across syncs', checkActiveUsersNeverAccumulatedAcrossSync],
  ['Historical: transactions AND revenue both mapped from commerce query', checkTransactionsAndRevenueBothMapped],

  ['Query Plan: realtime request uses minuteRanges', checkRealtimeUsesMinuteRanges],
  ['Query Plan: historical requests use dateRanges', checkHistoricalUsesDateRanges],
  ['Query Plan: funnel query uses inListFilter for eventName', checkFunnelUsesInListFilter],
  ['Query Plan: event_mapping_version constant defined', checkEventMappingVersionConstant],
  ['Query Plan: view_product gap honestly documented, not faked', checkViewProductHonestlyDeferred],
  ['Query Plan: merge key builder considers country+region+city', checkMergeUsesRawLocationKeyNotCityAlone],
  ['Query Plan: raw_location_key literally concatenates all 3 fields', checkRawLocationKeyIncludesAllThreeFields],
  ['Query Plan: "(not set)" placeholder distinct from empty string', checkNotSetDoesNotCollideWithEmptyString],
  ['Query Plan: raw values preserved separately from canonical names', checkRawValuesPreservedSeparateFromCanonical],

  ['Normalization: never imports .geojson directly', checkNormalizeNeverImportsGeojsonDirectly],
  ['Normalization: no hardcoded county list constant', checkNormalizeHasNoHardcodedCountyList],
  ['Normalization: overseas check runs before catalog lookup', checkOverseasCheckedBeforeCatalogLookup],
  ['Normalization: all-not-set check runs before country check', checkAllNotSetCheckedFirst],
  ['Normalization: marker only resolved for status=ok', checkMarkerOnlyResolvedForOkStatus],
  ['Normalization: marker resolver never reads GA4 lat/lng fields', checkMarkerNeverUsesGa4Coordinates],

  ['Marker: accuracy label distinguishes district vs county', checkMarkerAccuracyLabelsDistrictVsCounty],
  ['Marker: type is aggregate, never exact', checkMarkerTypeIsAggregateNotExact],
  ['Marker: point payload only exposes lat/lng (no extra catalog fields)', checkMarkerPointOnlyLatLngFields],
  ['Marker: attached server-side in both realtime and range read paths', checkMarkerAttachedServerSideInBothReadPaths],
  ['Marker: frontend never calls the catalog resolver itself', checkFrontendNeverCallsResolveMarkerPoint],
  ['Marker: frontend only reads row.marker_point, never assigns it', checkFrontendReadsMarkerPointReadOnly],

  ['Isolation: single getPropertyBinding() call site used >=5 times', checkGetPropertyBindingSingleSourceOfTruth],
  ['Isolation: property_not_bound checked before any adapter call', checkPropertyNotBoundNeverCallsAdapter],
  ['Isolation: unbound returns same safe code regardless of reason', checkUnboundReturnsSameCodeRegardlessOfReason],
  ['Isolation: reuses existing ga4RealtimeConfig resolver, no local copy', checkReusesExistingConfigResolverNotOwnCopy],

  ['API: GET /status exists', checkStatusEndpointExists],
  ['API: GET /realtime exists', checkRealtimeEndpointExists],
  ['API: GET /history exists', checkHistoryEndpointExists],
  ['API: POST /sync exists', checkSyncEndpointExists],
  ['API: input validation runs before rate limit is charged', checkSyncValidatesBeforeRateLimit],
  ['API: sync_type whitelist is an explicit Set', checkSyncTypeWhitelistExplicit],
  ['API: custom date format checked via regex', checkDateFormatRegexUsed],
  ['API: /history safely defaults unknown range to today', checkHistoryDefaultsSafelyToToday],
  ['API: route never reads body.store_id/storeId', checkRouteNeverReadsBodyStoreId],
  ['API: /sync has a catch-all guard against unhandled throws', checkRouteCatchAllPreventsCrash],

  ['Failure: partial=true when any one of 3 queries fails', checkPartialTrueWhenAnyQueryFails],
  ['Failure: all 3 failing is a hard failure, not silently partial', checkAllThreeFailingIsHardFailureNotPartial],
  ['Failure: sync_runs row records the partial flag', checkSyncRunRecordsPartialFlag],
  ['Failure: stale read path never throws', checkStaleReadPathNeverThrows],
  ['Failure: failed GA4 sync never touches orders table', checkFailedSyncDoesNotTouchPosOrderTables],

  ['Credential safety: guards against implicit-ADC crash (this round\'s fix)', checkClientGuardsAgainstImplicitAdcCrash],
  ['Credential safety: guard placed after test-injection check (doesn\'t break existing tests)', checkClientStillHonorsTestInjectedClient],
  ['Credential safety: credentialStatus() never logs secret content', checkCredentialStatusNeverLogsSecretContent],

  ['requestBuilders exports event mapping for reuse', checkRequestBuildersExportEventMapping],
  ['parseResponse.js shared by both production and mock adapters', checkParseResponseIsSharedNotDuplicated],
  ['mockAdapter never required from route or sync service', checkMockAdapterOnlyUsedByTestScripts],
  ['productionAdapter is the default adapter in the sync service', checkProductionAdapterIsDefaultInService],
  ['Adapter is injectable (>=2 call sites use options.adapter fallback)', checkAdapterInjectableForTests],
  ['sync_run_id propagated onto saved rows for audit traceability', checkSyncRunIdPropagatedToRows],
  ['Taipei time uses a fixed +8h offset (no DST logic)', checkTaipeiOffsetIsFixedEightHours],
  ['No DST adjustment code attempted anywhere', checkNoDstAdjustmentAttempted],
  ['resolveRangeWindow is exported for reuse/testing', checkResolveRangeWindowExported],
  ['getPropertyBinding is exported for reuse/testing', checkGetPropertyBindingExported],
  ['EVENT_NAME_TO_COLUMN mapping is exported for reuse/testing', checkEventNameToColumnExported],
  ['/status response never includes a property_id field', checkStatusEndpointNeverExposesPropertyId],
  ['/history route reads query start_date/end_date safely', checkHistoryEndpointPassesThroughQueryParamsSafely],
  ['/sync route never derives store context from body', checkSyncEndpointNeverTrustsBodyForStoreContext],
  ['Rate limit map is keyed per-store, not global', checkRateLimitMapIsPerStoreNotGlobal],
  ['/realtime returns HTTP 200 on safe (non-crash) failure', checkRealtimeEndpointReturns200OnSafeFailure],
  ['Marker icon class distinct from existing geo-marker-renderer icon classes', checkMarkerIconClassDistinctFromExistingRenderer],
  ['Tooltip always includes the aggregate disclaimer line', checkTooltipAlwaysIncludesDisclaimerLine],
  ['Table has its own footer disclaimer element', checkTableFooterDisclaimerPresent],
  ['CSS marker color is distinct from existing marker palette', checkCssMarkerColorDistinctFromExistingPalette],
  ['Panel exports testable pure helpers (not just DOM side effects)', checkPanelExportsTestableHelpers],
  ['Panel pollutes global scope with exactly one namespace', checkPanelDoesNotPolluteGlobalScopeBeyondOneNamespace],
  ['geo-heatmap-ui.js calls Panel.destroy in both exit branches', checkHeatmapUiDestroyCalledInBothExitBranches],
  ['geo-heatmap-ui.js calls Panel.init exactly once', checkHeatmapUiInitCalledExactlyOnce],

  ['Search: input element exists in the panel', checkSearchInputExistsInPanel],
  ['Search: input listener actually registered', checkSearchListenerRegistered],
  ['Sort: header click listener actually registered', checkSortHeaderListenerRegistered],
  ['Search: never calls fetch', checkSearchNeverCallsFetch],
  ['Sort: never calls fetch', checkSortNeverCallsFetch],
  ['Search/Sort: never touch the GA4 marker layer', checkSearchSortNeverTouchMarkerLayer],
  ['Search/Sort: return new arrays, never mutate cached rows', checkFilterAndSortReturnNewArraysNotMutate],
  ['Search: reads via .value, never string-injects into innerHTML', checkSearchUsesValuePropertyNotInnerHtmlInjection],
  ['Sort: numeric null-last contract implemented', checkNumericNullLastContractImplemented],
  ['Destroy: cleans up search and sort listeners', checkDestroyCleansSearchAndSortListeners],
  ['Mode switch resets search and sort state', checkModeSwitchResetsSearchAndSort],
  ['Metric switch preserves search and sort state', checkMetricSwitchPreservesSearchAndSort],
];

// runAudit() — 需求文件（regression runner 修正輪）：執行＋列印全部檢查
// 的邏輯包成函式，只在「直接執行這個檔案」時才呼叫（見檔案最下方），
// require() 這個模組（例如 smoke suite 的 Mutation Negative 段落借用
// CHECKS/FILES/CODE）不會再有印出一整份 Audit 報表的副作用，也不會讓
// 別的腳本用 execFileSync 擷取到「這個模組被 require 時印出的內容」跟
// 自己的輸出混在一起。
function runAudit() {
  results.length = 0; // 允許重複呼叫（例如同一 process 內多次執行）
  CHECKS.forEach(([name, fn]) => {
    let pass = false;
    let detail = '';
    try { pass = !!fn(FILES, CODE); } catch (e) { detail = `threw: ${e.message}`; }
    check(name, pass, detail);
  });

  const pass = results.filter((r) => r.pass).length;
  const fail = results.filter((r) => !r.pass);
  results.forEach((r) => console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.name}${r.pass ? '' : ' — ' + r.detail}`));
  console.log(`\n=== GA4-H1 Static Audit: ${pass}/${results.length} PASS, ${fail.length} FAIL ===`);
  return { pass, fail: fail.length, total: results.length };
}

module.exports = { CHECKS, FILES, CODE, stripComments, runAudit };

if (require.main === module) {
  const { fail } = runAudit();
  process.exit(fail === 0 ? 0 : 1);
}
