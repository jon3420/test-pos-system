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

    db.run(
      `INSERT INTO geo_visit_log (
        store_id, visitor_id, session_id, event_name, event_time,
        lat, lng, city, district, country, source, is_unknown, order_id
      ) VALUES (?,?,?,?, COALESCE(?, datetime('now')), ?,?,?,?,?,?,?,?)`,
      [
        _safeStr(f.store_id, 100), _safeStr(f.visitor_id, 200), _safeStr(f.session_id, 200),
        _safeStr(f.event_name, 100), eventTime,
        lat, lng,
        isUnknown ? 'Unknown' : city, isUnknown ? 'Unknown' : district, country,
        source, isUnknown ? 1 : 0, orderId,
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

module.exports = {
  GEO_VISIT_LOG_TIME_RANGES,
  VISITOR_KEY_SQL,
  resolveTimeRangeSince,
  logGeoVisit,
  getGeoVisitSummary,
  getGeoVisitAreas,
  getRecentGeoVisits,
};
