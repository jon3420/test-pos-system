// utils/geoVisitLog.js — fix18-10-hotfix30-B5-R5.3-A1.2
// Analytics Visitor Geo Sync：geo_visit_log 是 Geo Intelligence 的「Geo 快速
// 查詢 Layer」，讓 Visitor 相關統計/地圖不必依賴 orders 表。
//
// 原則：
//   - 全新獨立資料表（見 utils/db.js migration），完全不修改 analytics_events
//     本身的欄位、索引或既有查詢。
//   - 寫入 fail-open：任何失敗都不得影響呼叫端（insertEvent() 的主要事件
//     寫入流程），只 console.warn，永不 throw。
//   - 不生出假座標：lat/lng 只在真的有座標值時才寫入（目前系統唯一的
//     Geo Resolver 不提供座標，所以本輪寫入路徑一律是 NULL；欄位保留給
//     未來若真的有座標來源時使用，不是本輪的臆測功能）。
//   - is_unknown 語意：city 與 district 皆缺 → 完全無法辨識 → is_unknown=1，
//     且 city/district 明確寫入字面 'Unknown'（不得留 NULL 讓呼叫端誤判成
//     「還沒查詢」）。city 或 district 任一已知 → is_unknown=0（即使沒有
//     lat/lng，仍是「已知地理位置」，不是 Unknown——避免「Geo Visitors=0
//     但 Unknown=100%」的統計矛盾）。
//   - Store Isolation：所有查詢一律以 store_id 篩選，不同店家的
//     geo_visit_log 資料互不可見。
//   - Performance：所有查詢一律搭配 utils/db.js 建立的
//     (store_id, event_time) / (store_id, event_name, event_time) /
//     (store_id, session_id) / (store_id, visitor_id) 索引，不做全表掃描。

'use strict';

const { GEO_SOURCE } = require('./geoConstants');
const { resolveTaiwanAdministrativeArea } = require('./taiwanGeoNormalize');
const authoritativeAdminPointCatalog = require('./authoritativeAdminPointCatalog');

function _safeStr(val, maxLen = 300) {
  if (val === undefined || val === null) return null;
  const s = String(val).trim();
  if (!s) return null;
  return s.length > maxLen ? s.slice(0, maxLen) : s;
}

// 時間範圍預設（需求文件「Heat Aggregation：近5分鐘/30分鐘/今日/7天/30天」，
// R5.3-A2 需求文件二十再擴充：1小時/24小時/自訂）。回傳 SQLite 可比較的
// ISO-ish 字串（跟 analytics_events/geo_visit_log 的 created_at/event_time
// 一樣用 datetime('now') 格式，字串可直接比較）。
const GEO_VISIT_LOG_TIME_RANGES = Object.freeze(['5m', '30m', '1h', '24h', 'today', '7d', '30d', 'custom']);
function resolveTimeRangeSince(range, now, customStart) {
  const nowDate = now instanceof Date ? now : new Date();
  const r = GEO_VISIT_LOG_TIME_RANGES.includes(range) ? range : 'today';
  if (r === '5m') return new Date(nowDate.getTime() - 5 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === '30m') return new Date(nowDate.getTime() - 30 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === '1h') return new Date(nowDate.getTime() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === '24h') return new Date(nowDate.getTime() - 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === '7d') return new Date(nowDate.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === '30d') return new Date(nowDate.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  if (r === 'custom') {
    // 自訂範圍：呼叫端必須提供合法的 customStart（字串），否則安全 fallback
    // 回 today，不得讓不合法輸入變成「無下限」查詢（等同全表掃描風險）。
    if (customStart && typeof customStart === 'string' && customStart.length >= 10) return customStart;
    return `${nowDate.toISOString().slice(0, 10)} 00:00:00`;
  }
  // 'today'：當天 00:00:00（UTC，跟既有 analytics 慣例一致，不另外處理時區轉換）
  return `${nowDate.toISOString().slice(0, 10)} 00:00:00`;
}

// 供 utils/analyticsLog.js insertEvent() 呼叫的唯一寫入入口。
// fields: { store_id, visitor_id, session_id, event_name, event_time,
//           geo_city, geo_district, geo_country, geo_source, lat, lng }
// 回傳 true/false，絕不拋出例外。
function logGeoVisit(db, fields) {
  try {
    const f = fields || {};
    if (!f.store_id || !f.visitor_id || !f.session_id || !f.event_name) return false;

    const city = _safeStr(f.geo_city, 100);
    const district = _safeStr(f.geo_district, 100);
    const country = _safeStr(f.geo_country, 100);
    const isUnknown = !city && !district;

    // lat/lng：只接受真正的有限數字；沒有值（本輪唯一的 Geo Resolver 從不
    // 提供座標）一律 NULL，絕不用行政區中心點/店家座標/矩形中心補值。
    const lat = Number.isFinite(Number(f.lat)) ? Number(f.lat) : null;
    const lng = Number.isFinite(Number(f.lng)) ? Number(f.lng) : null;

    const source = _safeStr(f.geo_source, 30) || GEO_SOURCE.UNKNOWN;
    const eventTime = f.event_time ? _safeStr(f.event_time, 50) : null;
    // fix18-10-hotfix30-B5-R5.3-A2：order_id 只在呼叫端真的有提供時才寫入
    // （來自既有 analytics_events.order_id，不是本輪臆測產生）。
    const orderId = f.order_id ? _safeStr(f.order_id, 200) : null;
    // fix18-10-hotfix30-B5-R5.3-A3：source_event_id 只在呼叫端真的知道
    // 對應的 analytics_events.id 時才寫入（不是本輪臆測產生）。
    const sourceEventId = Number.isFinite(Number(f.source_event_id)) ? Number(f.source_event_id) : null;
    // fix18-10-hotfix30-B5-R5.4-G1（Geo Live Layer 需求文件十／十七／十八）：
    // 三個欄位都只在呼叫端真的有提供時才寫入，未提供一律 NULL，不臆測。
    const postalCode = f.postal_code ? _safeStr(f.postal_code, 20) : null;
    const channel = f.channel ? _safeStr(f.channel, 30) : null;
    const deviceType = f.device_type ? _safeStr(f.device_type, 30) : null;

    db.run(
      `INSERT INTO geo_visit_log (
        store_id, visitor_id, session_id, event_name, event_time,
        lat, lng, city, district, country, source, is_unknown, order_id, source_event_id,
        postal_code, channel, device_type
      ) VALUES (?,?,?,?, COALESCE(?, datetime('now')), ?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        _safeStr(f.store_id, 100), _safeStr(f.visitor_id, 200), _safeStr(f.session_id, 200),
        _safeStr(f.event_name, 100), eventTime,
        lat, lng,
        isUnknown ? 'Unknown' : city, isUnknown ? 'Unknown' : district, country,
        source, isUnknown ? 1 : 0, orderId, sourceEventId,
        postalCode, channel, deviceType,
      ]
    );
    return true;
  } catch (e) {
    console.warn('[geoVisitLog] logGeoVisit failed:', e.message);
    return false;
  }
}

// ── Dashboard Integration 統計（需求文件「Geo Visitor/AddToCart/Checkout/
//    Orders 一律用 COUNT(DISTINCT session_id)，不得依賴 orders 表」）──────
// ── 正式訪客識別規則（visitor_key，需求文件二）───────────────────────
// visitor_key = 非空 visitor_id → 用 visitor_id；
//               visitor_id 缺失但 session_id 非空 → 用 session_id；
//               兩者皆缺失 → 用 event 本身的 id 當唯一 fallback key（每一列
//               各自獨立，不會被誤併成同一人，也不會跟其他缺值列混在一起）。
// 不得把同一位 visitor_id 在不同 session_id 下的多次造訪，各自算成不同人；
// 也不得把 visitor_id 缺失時的多個不同 session_id 誤併成同一人。
// SQLite NULLIF(x,'') 把空字串視同 NULL，COALESCE 才能正確 fallback。
const VISITOR_KEY_SQL = `COALESCE(NULLIF(visitor_id,''), NULLIF(session_id,''), 'event_' || id)`;

function getGeoVisitSummary(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now);
  try {
    const total = db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ?`,
      [storeId, since]
    ) || { c: 0 };
    const known = db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND is_unknown=0`,
      [storeId, since]
    ) || { c: 0 };
    const byEvent = (eventName) => db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE store_id=? AND event_time >= ? AND event_name=?`,
      [storeId, since, eventName]
    ) || { c: 0 };

    const totalC = Number(total.c) || 0;
    const knownC = Number(known.c) || 0;
    const unknownC = Math.max(0, totalC - knownC);
    // 需求文件「不得再出現 Geo Visitors=0 但 Unknown=100% 的矛盾狀態」：
    // unknownRate 一律以 totalC 為分母；totalC=0 時（完全沒有資料）unknownRate
    // 定義為 0（不是 100%），因為沒有任何訪客就沒有「未知比例」可言。
    const unknownRate = totalC > 0 ? Math.round((unknownC / totalC) * 1000) / 10 : 0;

    return {
      range: opts.range || 'today',
      geo_visitors: totalC,
      geo_visitors_known: knownC,
      geo_visitors_unknown: unknownC,
      unknown_rate: unknownRate,
      geo_add_to_cart: Number(byEvent('add_to_cart').c) || 0,
      geo_checkout: Number(byEvent('begin_checkout').c) || 0,
      geo_orders: Number(byEvent('purchase').c) || 0,
    };
  } catch (e) {
    console.warn('[geoVisitLog] getGeoVisitSummary failed:', e.message);
    return {
      range: opts.range || 'today', geo_visitors: 0, geo_visitors_known: 0,
      geo_visitors_unknown: 0, unknown_rate: 0, geo_add_to_cart: 0, geo_checkout: 0, geo_orders: 0,
    };
  }
}

// ── 依行政區聚合（Ranking／Choropleth／Coverage 用）───────────────────
// 需求文件「Heat 點依 visitor_id 或 session_id 去重，不得 page_view 每刷新
// 一次就增加十個點，同一 Session 只保留一個位置」：這裡直接在 SQL 用
// COUNT(DISTINCT session_id) 依 city/district 分組，天然滿足去重（同一
// session 在同一行政區不論寫入幾筆 geo_visit_log 列，都只算一次）。
// 需求文件「Heat 點依 visitor_id 或 session_id 去重，不得 page_view 每刷新
// 一次就增加十個點，同一 Session 只保留一個位置」——實際去重口徑統一用上面
// 的 visitor_key（visitor_id 優先，session_id 只在 visitor_id 缺失時 fallback，
// 不得把同一人跨 session 的造訪算成多人，也不得把 visitor_id 與 session_id
// 各自獨立計數）。
// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.2：Region-only Marker（Estimate）——
// 把 city/district 這種自由文字，安全轉成 Authoritative Representative
// Point。分兩步，缺一步就安全回 unavailable，不猜測、不 fallback：
//   1. resolveTaiwanAdministrativeArea({city, district}) —— 既有 B2.5／
//      R5.2 引擎，只在能唯一辨識時才回 county_code／subdivision_code
//      （Hsinchu／Chiayi 裸名稱、Taoyuan District 沒有 county_code 佐證
//      時，這一步本身就已經回 unknown，不會走到下一步）。
//   2. authoritativeAdminPointCatalog.resolveAdministrativeRepresentative
//      Point({district_code, county_code}) —— 用官方 NLSC 界線算出的
//      Representative Point 查表，查不到（Catalog unavailable／code 不在
//      表裡）也回 null。
// 兩步都成功才回 { available:true, ... }，任何一步失敗都回
// { available:false }（不影響呼叫端 Summary／Ranking，只是不畫 Marker）。
function resolveAreaRepresentativeMarker(area) {
  const a = area || {};
  if (a.is_unknown) return { available: false };
  const resolved = resolveTaiwanAdministrativeArea({ city: a.city, district: a.district });
  if (!resolved || (!resolved.subdivision_code && !resolved.county_code)) return { available: false };
  const catalogStatus = authoritativeAdminPointCatalog.getCatalogStatus();
  if (!catalogStatus.available) return { available: false, error_code: 'catalog_unavailable' };
  const point = authoritativeAdminPointCatalog.resolveAdministrativeRepresentativePoint({
    district_code: resolved.subdivision_code || null,
    county_code: resolved.county_code || null,
  });
  if (!point) return { available: false };
  const accuracy = point.district_code ? 'district_centroid' : 'county_centroid';
  return {
    available: true,
    lat: point.lat,
    lng: point.lng,
    accuracy,
    coordinate_source: 'nlsc_official_boundary_representative_point',
    county_code: point.county_code,
    district_code: point.district_code || null,
  };
}

function getGeoVisitAreas(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now);
  try {
    const rows = db.all(
      `SELECT city, district, is_unknown,
              COUNT(DISTINCT ${VISITOR_KEY_SQL}) AS visitor_count,
              COUNT(DISTINCT CASE WHEN event_name='add_to_cart' THEN ${VISITOR_KEY_SQL} END) AS add_to_cart_count,
              COUNT(DISTINCT CASE WHEN event_name='begin_checkout' THEN ${VISITOR_KEY_SQL} END) AS checkout_count,
              COUNT(DISTINCT CASE WHEN event_name='purchase' THEN ${VISITOR_KEY_SQL} END) AS order_count
       FROM geo_visit_log
       WHERE store_id=? AND event_time >= ?
       GROUP BY city, district, is_unknown
       ORDER BY visitor_count DESC`,
      [storeId, since]
    ) || [];
    return rows.map((r) => ({
      city: r.city, district: r.district, is_unknown: !!r.is_unknown,
      visitor_count: Number(r.visitor_count) || 0,
      add_to_cart_count: Number(r.add_to_cart_count) || 0,
      checkout_count: Number(r.checkout_count) || 0,
      order_count: Number(r.order_count) || 0,
      marker: resolveAreaRepresentativeMarker({ city: r.city, district: r.district, is_unknown: !!r.is_unknown }),
    }));
  } catch (e) {
    console.warn('[geoVisitLog] getGeoVisitAreas failed:', e.message);
    return [];
  }
}

// fix18-10-hotfix30-B5-R5.3-A2（需求文件二十二，隱私要求）：Recent Geo
// Events 只能顯示遮罩後的訪客識別，不得顯示完整 visitor_id/session_id。
function _maskVisitorIdentifier(visitorId, sessionId) {
  const raw = (visitorId && String(visitorId).trim()) || (sessionId && String(sessionId).trim()) || '';
  if (!raw) return 'vis_***';
  const tail = raw.slice(-3);
  return `vis_***${tail}`;
}

// ── Recent Visitor Log（需求文件：時間／行政區／事件／來源／訪客識別遮罩）─
function getRecentGeoVisits(db, storeId, options) {
  const opts = options || {};
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 20));
  try {
    const rows = db.all(
      `SELECT event_time, city, district, event_name, source, is_unknown, visitor_id, session_id
       FROM geo_visit_log WHERE store_id=? ORDER BY event_time DESC, id DESC LIMIT ?`,
      [storeId, limit]
    ) || [];
    return rows.map((r) => ({
      event_time: r.event_time, city: r.city, district: r.district,
      event_name: r.event_name, source: r.source, is_unknown: !!r.is_unknown,
      // 遮罩後的訪客識別（例：vis_***123），絕不回傳原始 visitor_id/session_id。
      visitor_mask: _maskVisitorIdentifier(r.visitor_id, r.session_id),
    }));
  } catch (e) {
    console.warn('[geoVisitLog] getRecentGeoVisits failed:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════
// fix18-10-hotfix30-B5-R5.4-G1｜Geo Intelligence V2 — Live Geo Layer
//
// 以下都是「新增、additive」查詢函式，完全不修改上面既有的
// getGeoVisitSummary() / getGeoVisitAreas() / getRecentGeoVisits()（也就是
// 不影響 Dashboard KPI／Order Analytics／Revenue Analytics 既有讀取路徑）。
// 全部一律以 store_id 篩選（Store Isolation，需求文件十九）。
// ══════════════════════════════════════════════════════════════════

const GEO_LIVE_CHANNELS = Object.freeze(['全部', 'LINE', 'Facebook', 'Google', 'Organic', 'Direct']);
const GEO_LIVE_DEVICES = Object.freeze(['android', 'iphone', 'ipad_tablet', 'desktop', 'unknown']);

// channel 篩選：'Organic' 目前專案的 classifySource() 分類值裡沒有獨立的
// 'Organic'（見 utils/analyticsV2.js：只有 Facebook/Google/LINE/Instagram/
// Direct/Other）。需求文件十七明確要求 Organic 是獨立篩選項，這裡誠實地把
// 「Other」（非付費廣告來源、非 Direct、也非上述平台）視為 Organic 的資料
// 對應，避免新造一種跟既有分類邏輯不同步的第二套判斷（見決策：兩邊都用同一個
// classifySource()，只是 Other 在 Geo Live 篩選 UI 上顯示為「Organic」）。
function _channelFilterToStoredValues(channel) {
  if (!channel || channel === '全部' || channel === 'all') return null;
  if (channel === 'Organic') return ['Other'];
  return [channel];
}

function _applyCommonFilters(whereParts, params, opts) {
  if (opts.channel) {
    const vals = _channelFilterToStoredValues(opts.channel);
    if (vals && vals.length) {
      whereParts.push(`channel IN (${vals.map(() => '?').join(',')})`);
      params.push(...vals);
    }
  }
  if (opts.device && GEO_LIVE_DEVICES.includes(opts.device)) {
    whereParts.push('device_type = ?');
    params.push(opts.device);
  }
}

// ── 二、三、五：Live Marker / Cluster 用的原始點位（只回傳「真的有座標」的列）
// 需求文件「不得畫假 Marker」：完全不補值，沒有 lat/lng 的列一律不出現在這裡
// （它們的統計歸屬在 getGeoLiveUnknownPool() / getGeoLiveDistricts()）。
function getGeoLivePoints(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?', 'lat IS NOT NULL', 'lng IS NOT NULL'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  const limit = Math.max(1, Math.min(20000, Number(opts.limit) || 5000));
  try {
    const rows = db.all(
      `SELECT ${VISITOR_KEY_SQL} AS visitor_key, lat, lng, city, district, postal_code,
              channel, device_type, event_name, event_time
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       ORDER BY event_time DESC
       LIMIT ?`,
      [...params, limit]
    ) || [];
    // 需求文件「同一 Session 只保留一個位置」：依 visitor_key 去重，只留最新一筆。
    const seen = new Set();
    const dedup = [];
    for (const r of rows) {
      if (seen.has(r.visitor_key)) continue;
      seen.add(r.visitor_key);
      dedup.push({
        visitor_key: r.visitor_key, lat: r.lat, lng: r.lng,
        city: r.city, district: r.district, postal_code: r.postal_code,
        channel: r.channel, device_type: r.device_type,
        event_name: r.event_name, event_time: r.event_time,
      });
    }
    return dedup;
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLivePoints failed:', e.message);
    return [];
  }
}

// ── 五：Unknown Visitor Pool（Known/Unknown/Coverage，city/district 皆缺才算 Unknown）
function getGeoLiveUnknownPool(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  try {
    const total = db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE ${where.join(' AND ')}`,
      params
    ) || { c: 0 };
    const known = db.get(
      `SELECT COUNT(DISTINCT ${VISITOR_KEY_SQL}) c FROM geo_visit_log WHERE ${where.join(' AND ')} AND is_unknown = 0`,
      params
    ) || { c: 0 };
    // Live Map 專用的第三個維度（不是既有 KPI 的一部分）：城市/行政區已知，
    // 但沒有座標，因此無法在地圖上畫點——誠實區分「已知地理位置」與
    // 「可畫成 Marker 的位置」。真正的座標來源是 geo_live_coordinates（見
    // utils/geoLiveCoordinate.js），不是 geo_visit_log.lat/lng（該欄位在目前
    // 系統設計下永遠是 NULL，只保留給未來若真的有同步寫入座標的來源使用）。
    const totalC = Number(total.c) || 0;
    const knownC = Number(known.c) || 0;
    let mappableC = 0;
    try {
      const { getLatestCoordinatesByVisitor } = require('./geoLiveCoordinate');
      const { byVisitor, bySession } = getLatestCoordinatesByVisitor(db, storeId, since);
      // 與 getGeoLiveMarkerPoints() 相同的比對邏輯：同一 visitor_key 只算一次。
      const visitorKeyRows = db.all(
        `SELECT DISTINCT visitor_id, session_id FROM geo_visit_log WHERE ${where.join(' AND ')}`,
        params
      ) || [];
      const countedKeys = new Set();
      for (const r of visitorKeyRows) {
        const key = r.visitor_id || r.session_id;
        if (!key || countedKeys.has(key)) continue;
        const hasCoord = (r.visitor_id && byVisitor.has(r.visitor_id)) || (r.session_id && bySession.has(r.session_id));
        if (hasCoord) { countedKeys.add(key); mappableC++; }
      }
    } catch (e) { console.warn('[geoVisitLog] mappable count via geo_live_coordinates failed:', e.message); }
    const unknownC = Math.max(0, totalC - knownC);
    const coverage = totalC > 0 ? Math.round((knownC / totalC) * 1000) / 10 : 0;
    const mappableRate = totalC > 0 ? Math.round((mappableC / totalC) * 1000) / 10 : 0;
    return {
      range: opts.range || 'today',
      total: totalC,
      known: knownC,
      unknown: unknownC,
      coverage_pct: coverage,
      mappable_with_coordinates: mappableC,
      mappable_rate_pct: mappableRate,
    };
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveUnknownPool failed:', e.message);
    return { range: opts.range || 'today', total: 0, known: 0, unknown: 0, coverage_pct: 0, mappable_with_coordinates: 0, mappable_rate_pct: 0 };
  }
}

// ── 九：District Layer（依 city/district 動態聚合，不硬編碼行政區清單）
function getGeoLiveDistricts(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?', 'is_unknown = 0'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  try {
    const rows = db.all(
      `SELECT city, district,
              COUNT(DISTINCT ${VISITOR_KEY_SQL}) AS visitor_count,
              COUNT(DISTINCT CASE WHEN event_name='add_to_cart' THEN ${VISITOR_KEY_SQL} END) AS add_to_cart_count,
              COUNT(DISTINCT CASE WHEN event_name='begin_checkout' THEN ${VISITOR_KEY_SQL} END) AS checkout_count,
              COUNT(DISTINCT CASE WHEN event_name='purchase' THEN ${VISITOR_KEY_SQL} END) AS order_count
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       GROUP BY city, district
       ORDER BY visitor_count DESC`,
      params
    ) || [];
    return rows.map((r) => {
      const visitors = Number(r.visitor_count) || 0;
      const orders = Number(r.order_count) || 0;
      return {
        city: r.city, district: r.district,
        visitor_count: visitors,
        add_to_cart_count: Number(r.add_to_cart_count) || 0,
        checkout_count: Number(r.checkout_count) || 0,
        order_count: orders,
        conversion_rate_pct: visitors > 0 ? Math.round((orders / visitors) * 1000) / 10 : 0,
      };
    });
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveDistricts failed:', e.message);
    return [];
  }
}

// ── 十：Postal Layer（依 postal_code 動態聚合；postal_code 目前多為 NULL，
// 見 R5.4-G1_GEO_LIVE_ARCHITECTURE.md 資料可用性揭露，NULL 一律排除不計數）
function getGeoLivePostal(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?', "postal_code IS NOT NULL", "postal_code != ''"];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  try {
    const rows = db.all(
      `SELECT postal_code, COUNT(DISTINCT ${VISITOR_KEY_SQL}) AS visitor_count
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       GROUP BY postal_code
       ORDER BY visitor_count DESC`,
      params
    ) || [];
    return rows.map((r) => ({ postal_code: r.postal_code, visitor_count: Number(r.visitor_count) || 0 }));
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLivePostal failed:', e.message);
    return [];
  }
}

// ── 十三：Heat Summary Top5（重用 District 聚合，排序後取前 5）
function getGeoLiveHeatSummaryTop5(db, storeId, options) {
  const districts = getGeoLiveDistricts(db, storeId, options);
  return districts.slice(0, 5).map((d) => ({ city: d.city, district: d.district, visitor_count: d.visitor_count }));
}

// ── 七／十五：Replay／時間軸重算 — 依時間分桶累積人數（給前端動畫用）
// bucketMinutes 預設 10 分鐘一桶；桶數上限 288（等於 48 小時、10 分鐘一桶），
// 避免不合理輸入造成過大回應。
function getGeoLiveReplayBuckets(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const bucketMinutes = Math.max(1, Math.min(180, Number(opts.bucketMinutes) || 10));
  const where = ['store_id = ?', 'event_time >= ?', 'is_unknown = 0'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  try {
    // SQLite strftime 依分鐘桶化：用 (julianday(event_time) 的分鐘數整除法) 較不直覺，
    // 改用 strftime('%Y-%m-%d %H:%M', event_time) 取到分鐘後，在 JS 端依 bucketMinutes
    // 再次分桶（SQL 只負責篩選＋排序，桶化邏輯集中在一處方便單元測試涵蓋）。
    const rows = db.all(
      `SELECT event_time, ${VISITOR_KEY_SQL} AS visitor_key
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       ORDER BY event_time ASC`,
      params
    ) || [];
    const bucketMs = bucketMinutes * 60 * 1000;
    const buckets = new Map();
    const cumulativeSeen = new Set();
    const seenAtBucket = [];
    for (const r of rows) {
      const t = Date.parse(String(r.event_time).replace(' ', 'T') + 'Z');
      if (!Number.isFinite(t)) continue;
      const bucketStart = Math.floor(t / bucketMs) * bucketMs;
      if (!buckets.has(bucketStart)) buckets.set(bucketStart, new Set());
      buckets.get(bucketStart).add(r.visitor_key);
    }
    const sortedKeys = [...buckets.keys()].sort((a, b) => a - b);
    let cumulative = 0;
    const result = sortedKeys.map((k) => {
      const newVisitors = buckets.get(k).size;
      cumulative += newVisitors;
      return {
        bucket_start: new Date(k).toISOString(),
        new_visitors: newVisitors,
        cumulative_visitors: cumulative,
      };
    });
    void cumulativeSeen; void seenAtBucket; // 保留變數命名意圖，未使用之分支不影響行為
    return result;
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveReplayBuckets failed:', e.message);
    return [];
  }
}

// ── 十一／十六：Marker Tooltip + Geo Conversion 漏斗（單一訪客的事件序列）
// 不得顯示個資：只回傳 event_name/event_time/city/district/channel/device_type，
// 絕不回傳原始 visitor_id/session_id（沿用 getRecentGeoVisits() 的遮罩慣例）。
function getGeoLiveVisitorTimeline(db, storeId, visitorKey, options) {
  const opts = options || {};
  if (!visitorKey) return { visitor_mask: 'vis_***', events: [], funnel: { visitor: false, add_to_cart: false, checkout: false, order: false } };
  const limit = Math.max(1, Math.min(200, Number(opts.limit) || 100));
  try {
    const rows = db.all(
      `SELECT event_name, event_time, city, district, channel, device_type, visitor_id, session_id
       FROM geo_visit_log
       WHERE store_id = ? AND ${VISITOR_KEY_SQL} = ?
       ORDER BY event_time ASC
       LIMIT ?`,
      [storeId, visitorKey, limit]
    ) || [];
    const first = rows[0];
    const events = rows.map((r) => ({
      event_name: r.event_name, event_time: r.event_time,
      city: r.city, district: r.district, channel: r.channel, device_type: r.device_type,
    }));
    const has = (name) => rows.some((r) => r.event_name === name);
    return {
      visitor_mask: first ? _maskVisitorIdentifier(first.visitor_id, first.session_id) : 'vis_***',
      events,
      funnel: {
        visitor: rows.length > 0,
        add_to_cart: has('add_to_cart'),
        checkout: has('begin_checkout'),
        order: has('purchase'),
      },
    };
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveVisitorTimeline failed:', e.message);
    return { visitor_mask: 'vis_***', events: [], funnel: { visitor: false, add_to_cart: false, checkout: false, order: false } };
  }
}

// ── 二／三／十九／二十：真正的 Live Marker 點位 ─────────────────────────
// 唯一正確的 Marker 資料來源：geo_visit_log 的訪客/事件 metadata（城市/行政區/
// 郵遞區號/渠道/裝置），JOIN 上 utils/geoLiveCoordinate.js 提供的「使用者裝置
// 自己回報的真實座標」（Browser Geolocation API 等）。純 IP 推定的
// geo_visit_log.lat/lng（目前系統設計上永遠是 NULL，見檔案開頭註解）與這裡
// 完全無關；即使未來 geo_visit_log.lat/lng 真的有值，也一律只信任
// geo_live_coordinates（見需求文件「不要使用 IP 推估座標」，Coordinate
// Acquisition 是唯一真值來源，不是兩套資料各自為政）。
// 沒有真實座標的訪客一律不出現在回傳陣列裡（不得畫假 Marker）。
function getGeoLiveMarkerPoints(db, storeId, options) {
  const opts = options || {};
  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);
  try {
    const { getLatestCoordinatesByVisitor } = require('./geoLiveCoordinate');
    const { byVisitor, bySession } = getLatestCoordinatesByVisitor(db, storeId, since);
    if (byVisitor.size === 0 && bySession.size === 0) return [];

    const rows = db.all(
      `SELECT ${VISITOR_KEY_SQL} AS visitor_key, visitor_id, session_id,
              city, district, postal_code, channel, device_type, event_name, event_time
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       ORDER BY event_time DESC`,
      params
    ) || [];

    const seen = new Set();
    const out = [];
    for (const r of rows) {
      if (seen.has(r.visitor_key)) continue; // 同一 Session/訪客只保留一個位置
      const coord = (r.visitor_id && byVisitor.get(r.visitor_id))
        || (r.session_id && bySession.get(r.session_id))
        || null;
      if (!coord) continue; // 沒有真實座標 → 不畫 Marker，直接跳過
      seen.add(r.visitor_key);
      out.push({
        visitor_key: r.visitor_key,
        lat: coord.lat, lng: coord.lng, accuracy_m: coord.accuracy_m,
        coordinate_source: coord.source, captured_at: coord.captured_at,
        city: r.city, district: r.district, postal_code: r.postal_code,
        channel: r.channel, device_type: r.device_type,
        event_name: r.event_name, event_time: r.event_time,
      });
    }

    // 需求文件情境 A：使用者「只」同意了定位（例如頁面尚未觸發任何
    // page_view/add_to_cart 等 geo_visit_log 事件，或事件還在 fail-open 的
    // try/catch 裡沒寫成功），此時 geo_visit_log 完全沒有這位訪客的列，但
    // 他真的有回報一筆合法座標——不得因為「找不到 metadata」就整個丟棄這個
    // 真實 Marker。用安全預設值（不是 undefined/null 裸值，Tooltip 才不會
    // 顯示 undefined/NaN）補上，city/district/channel/device 一律標示為
    // 「Unknown」/'unknown'，不臆測。
    const coveredKeys = new Set(out.map((o) => o.visitor_key));
    const coveredIdentities = new Set();
    for (const r of rows) {
      if (r.visitor_id) coveredIdentities.add(r.visitor_id);
      if (r.session_id) coveredIdentities.add(r.session_id);
    }
    const addLeftover = (map, source) => {
      for (const [identity, coord] of map.entries()) {
        if (coveredIdentities.has(identity)) continue; // 已經在上面處理過
        if (coveredKeys.has(identity)) continue;
        coveredIdentities.add(identity);
        coveredKeys.add(identity);
        out.push({
          visitor_key: identity,
          lat: coord.lat, lng: coord.lng, accuracy_m: coord.accuracy_m,
          coordinate_source: coord.source, captured_at: coord.captured_at,
          city: 'Unknown', district: 'Unknown', postal_code: null,
          channel: 'Direct', device_type: 'unknown',
          event_name: 'geo_coordinate_consent', event_time: coord.captured_at,
        });
      }
    };
    addLeftover(byVisitor, 'visitor');
    // 注意：不再額外跑 addLeftover(bySession, ...)——geo_live_coordinates 的
    // visitor_id 是 NOT NULL（見 utils/db.js schema），每一筆真實座標一定
    // 已經被上面的 byVisitor pass 涵蓋，若再跑一次 bySession pass 會把同一筆
    // 真實座標當成兩個不同訪客各畫一個 Marker（同一位訪客被算成兩個點）。

    return out;
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveMarkerPoints failed:', e.message);
    return [];
  }
}

// getGeoLiveMarkerModel(db, storeId, options) → { exact_points,
//   estimate_points, unknown_count, capabilities }
//
// fix18-10-hotfix30-B5-R5.4-G1.6-A1.2：Dashboard Region-only Payload。
// 向後相容設計（需求文件十四）：完全不修改 getGeoLiveMarkerPoints()／
// 既有 `if (!coord) continue` 安全過濾，新增一個獨立的 Server Helper，
// 同一個 storeId／filters 下：
//   1. exact_points：直接沿用 getGeoLiveMarkerPoints()（不重複查詢邏輯）。
//   2. estimate_points：只查「沒有出現在 exact_points 的 visitor_key」
//      且 city／district 已知（非 is_unknown）的列，用
//      resolveAreaRepresentativeMarker() 轉成 Representative Point，同
//      accuracy＋district_code／county_code 聚合成一個 Marker（需求文件
//      十六 C：同 metric + district_code → 一個 Marker）。
//   3. unknown_count：is_unknown=1 的 unique visitor_key 數（且未出現在
//      exact_points——理論上 unknown 不會有座標，這裡仍防禦性排除）。
function getGeoLiveMarkerModel(db, storeId, options) {
  const opts = options || {};
  const exactPoints = getGeoLiveMarkerPoints(db, storeId, opts);
  const exactVisitorKeys = new Set(exactPoints.map((p) => p.visitor_key));

  const since = resolveTimeRangeSince(opts.range, opts.now, opts.customStart);
  const where = ['store_id = ?', 'event_time >= ?'];
  const params = [storeId, since];
  _applyCommonFilters(where, params, opts);

  const capabilities = {
    exact_available: true,
    district_estimates_available: false,
    county_estimates_available: false,
    catalog_available: false,
    catalog_source: null,
    catalog_schema_version: null,
  };
  let catalogErrorCode = null;
  try {
    const status = authoritativeAdminPointCatalog.getCatalogStatus();
    capabilities.district_estimates_available = !!status.available;
    capabilities.county_estimates_available = !!status.available;
    capabilities.catalog_available = !!status.available;
    capabilities.catalog_source = status.available ? status.source : null;
    capabilities.catalog_schema_version = status.available ? status.schema_version : null;
    if (!status.available) catalogErrorCode = status.error_code || 'catalog_unavailable';
  } catch (e) {
    catalogErrorCode = 'catalog_unavailable';
  }

  function respond(estimatePoints, unknownCount, errorCode) {
    const districtEntities = estimatePoints.filter((p) => p.accuracy === 'district_centroid').length;
    const countyEntities = estimatePoints.filter((p) => p.accuracy === 'county_centroid').length;
    const summary = {
      exact_entities: exactPoints.length,
      district_estimate_entities: districtEntities,
      county_estimate_entities: countyEntities,
      unknown_entities: unknownCount,
    };
    const out = { exact_points: exactPoints, estimate_points: estimatePoints, unknown_count: unknownCount, summary, capabilities };
    if (errorCode) { out.status = 'partial'; out.error_code = errorCode; } else { out.status = 'ok'; out.error_code = null; }
    return out;
  }

  // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2：Catalog 不可用時，Estimate 安全
  // 停用（不查、不猜），但 Exact 完全不受影響——見需求文件十一 Partial
  // Failure Contract。
  if (catalogErrorCode) {
    return respond([], 0, catalogErrorCode);
  }

  try {
    const rows = db.all(
      `SELECT ${VISITOR_KEY_SQL} AS visitor_key, city, district, is_unknown, event_name
       FROM geo_visit_log
       WHERE ${where.join(' AND ')}
       ORDER BY event_time DESC`,
      params
    ) || [];

    const seenForDedupe = new Set(); // visitor_key -> 每個 unique entity 只算一次（含 unknown 判斷）
    const unknownVisitorKeys = new Set();
    const estimateAgg = new Map(); // key: accuracy|code -> { ...marker fields, visitor_keys:Set, event_count }

    rows.forEach((r) => {
      if (exactVisitorKeys.has(r.visitor_key)) return; // 已經是 Exact，不重複畫（需求文件十六：同一 entity 只能出現在 exact/estimate/unknown 三者之一）
      if (seenForDedupe.has(`${r.visitor_key}|${r.event_name}`)) return; // event_count 另計，不用事件次數重複畫 Marker
      seenForDedupe.add(`${r.visitor_key}|${r.event_name}`);

      if (r.is_unknown) { unknownVisitorKeys.add(r.visitor_key); return; }

      const marker = resolveAreaRepresentativeMarker({ city: r.city, district: r.district, is_unknown: false });
      if (!marker.available) { unknownVisitorKeys.delete(r.visitor_key); return; } // 有 city/district 但查無 Representative Point：誠實的「已知但未顯示」，不計入 unknown

      const code = marker.district_code || marker.county_code;
      // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2（需求文件十二）：aggregate id
      // 用不可逆、非個人識別的 district/county code 組成，不含任何
      // visitor_key／個別識別資訊。
      const key = `${marker.accuracy}:${code}`;
      if (!estimateAgg.has(key)) {
        estimateAgg.set(key, {
          id: marker.district_code ? `district:${marker.district_code}` : `county:${marker.county_code}`,
          source: 'pos_visitor_geo',
          county_code: marker.county_code, county: null, district_code: marker.district_code, district: null,
          lat: marker.lat, lng: marker.lng, accuracy: marker.accuracy,
          coordinate_source: marker.coordinate_source,
          is_estimate: true,
          _visitorKeys: new Set(), event_count: 0,
        });
      }
      const agg = estimateAgg.get(key);
      agg._visitorKeys.add(r.visitor_key);
      agg.event_count += 1;
      if (!agg.district && r.district) agg.district = r.district;
      if (!agg.county && r.city) agg.county = r.city;
    });

    const estimatePoints = Array.from(estimateAgg.values()).map((agg) => ({
      id: agg.id, source: agg.source,
      county_code: agg.county_code, county: agg.county, district_code: agg.district_code, district: agg.district,
      lat: agg.lat, lng: agg.lng, accuracy: agg.accuracy,
      label: agg.district || agg.county || '',
      count: agg._visitorKeys.size, unique_visitors: agg._visitorKeys.size, event_count: agg.event_count,
      coordinate_source: agg.coordinate_source, is_estimate: true,
    }));

    return respond(estimatePoints, unknownVisitorKeys.size, null);
  } catch (e) {
    console.warn('[geoVisitLog] getGeoLiveMarkerModel estimate query failed:', e.message);
    return respond([], 0, 'region_query_failed');
  }
}

module.exports = {
  GEO_VISIT_LOG_TIME_RANGES,
  VISITOR_KEY_SQL,
  resolveTimeRangeSince,
  logGeoVisit,
  getGeoVisitSummary,
  getGeoVisitAreas,
  getRecentGeoVisits,
  // fix18-10-hotfix30-B5-R5.4-G1
  GEO_LIVE_CHANNELS,
  GEO_LIVE_DEVICES,
  getGeoLivePoints,
  getGeoLiveUnknownPool,
  getGeoLiveDistricts,
  getGeoLivePostal,
  getGeoLiveHeatSummaryTop5,
  getGeoLiveReplayBuckets,
  getGeoLiveVisitorTimeline,
  // fix18-10-hotfix30-B5-R5.4-G1-B（真實座標 Marker）
  getGeoLiveMarkerPoints,
  // fix18-10-hotfix30-B5-R5.4-G1.6-A1.2（Region-only Marker）
  resolveAreaRepresentativeMarker,
  getGeoLiveMarkerModel,
};
