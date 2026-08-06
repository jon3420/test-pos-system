// services/ga4GeoSyncService.js — fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1
// GA4 城市歷史統計、即時快照與行政區轉換地圖 — 集中 Sync Service
//
// 需求文件八：所有 GA4 城市同步邏輯集中於此，不得分散到 Frontend／多支
// Route／各 Dashboard Component／Visitor Layer。
//
// 資料性質（需求文件一）：這裡處理的是 GA4 Server 端回傳的「城市彙總」數字
// ——不是 POS 個別 visitor_id 事件。本檔案從不讀取／保存 user_pseudo_id、
// GA client_id、raw IP、Service Account 憑證內容，也不寫入 geo_visit_log，
// 不建立 GA4 與 POS visitor_id 對照（見 R5.4-G1.6-GA4-H1_PRIVACY_AUDIT.md）。

'use strict';

const crypto = require('crypto');
const { getDb } = require('../utils/db');
const { getGa4RealtimeConfig } = require('../utils/ga4RealtimeConfig');
const { normalizeGa4Location, resolveMarkerPoint } = require('../utils/ga4Geo/normalize');
const productionAdapter = require('../utils/ga4Geo/productionAdapter');

const METRICS_VERSION = 'v1';
const NORMALIZATION_VERSION = 'v1';
const EVENT_MAPPING_VERSION = 'v1';
const REALTIME_WINDOW_MINUTES = 30;
const REALTIME_BUCKET_MINUTES = 5;
const CUSTOM_RANGE_MAX_DAYS = 92; // 需求文件十二：自訂日期最大範圍限制

// GA4 真實事件名稱 → 本表欄位。view_product_count 目前沒有獨立可信來源
// （Reality Audit 未能對正式 Property 驗證是否存在獨立 view_product 事件，
// 見需求文件二 F／R5.4-G1.6-GA4-H1_REALITY_AUDIT.md），一律留 0，不用
// view_item 的數字冒充，避免重複計算兩個欄位。
const EVENT_NAME_TO_COLUMN = Object.freeze({
  page_view: 'page_view_count',
  view_item: 'view_item_count',
  add_to_cart: 'add_to_cart_count',
  begin_checkout: 'begin_checkout_count',
  checkout_click: 'checkout_click_count',
  purchase: 'purchase_count',
});

// ── Mutex：同一 Store＋Sync Type 同時只允許一次同步（需求文件八）────────
const _inFlight = new Map(); // `${storeId}::${syncType}` -> true

function _lock(storeId, syncType) {
  const key = `${storeId}::${syncType}`;
  if (_inFlight.get(key)) return null;
  _inFlight.set(key, true);
  return key;
}
function _unlock(key) { if (key) _inFlight.delete(key); }

function _nowIso() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }

function _taipeiTimeString(d = new Date()) {
  // Asia/Taipei 固定 UTC+8，無日光節約時間調整。
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  return t.toISOString().replace('T', ' ').slice(0, 19);
}

function _bucketFloor(d = new Date(), bucketMinutes = REALTIME_BUCKET_MINUTES) {
  const ms = bucketMinutes * 60 * 1000;
  const floored = Math.floor(d.getTime() / ms) * ms;
  return new Date(floored).toISOString().replace('T', ' ').slice(0, 19);
}

function _todayDateString(offsetDays = 0) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function _daysBetween(startDate, endDate) {
  const a = new Date(`${startDate}T00:00:00Z`);
  const b = new Date(`${endDate}T00:00:00Z`);
  return Math.round((b - a) / 86400000);
}

// resolveRangeWindow(rangeKey, customStart, customEnd) → { ok, start_date, end_date, code }
function resolveRangeWindow(rangeKey, customStart, customEnd) {
  if (rangeKey === 'today') return { ok: true, start_date: _todayDateString(0), end_date: _todayDateString(0) };
  if (rangeKey === 'yesterday') return { ok: true, start_date: _todayDateString(-1), end_date: _todayDateString(-1) };
  if (rangeKey === '7d') return { ok: true, start_date: _todayDateString(-6), end_date: _todayDateString(0) };
  if (rangeKey === '30d') return { ok: true, start_date: _todayDateString(-29), end_date: _todayDateString(0) };
  if (rangeKey === 'custom') {
    if (!customStart || !customEnd) return { ok: false, code: 'missing_custom_range' };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(customStart) || !/^\d{4}-\d{2}-\d{2}$/.test(customEnd)) {
      return { ok: false, code: 'invalid_date_format' };
    }
    const span = _daysBetween(customStart, customEnd);
    if (span < 0) return { ok: false, code: 'start_after_end' };
    if (span > CUSTOM_RANGE_MAX_DAYS) return { ok: false, code: 'range_too_large' };
    return { ok: true, start_date: customStart, end_date: customEnd };
  }
  return { ok: false, code: 'invalid_range' };
}

// ── Property Binding（需求文件三）── 完全沿用既有 G1.5-A 每店 settings
// resolver，物理上每個 store 只能讀到自己的 property/stream binding。
function getPropertyBinding(db, storeId) {
  const cfg = getGa4RealtimeConfig(db, storeId);
  if (!cfg.configured) {
    // 需求文件三：Store 尚未可靠綁定 GA4 Property（不論原因是尚未設定
    // Property/Stream，或該店尚未啟用 GA4 圖層）一律回同一個安全代碼，
    // 絕不呼叫 GA4，前端一律顯示「property_not_bound」。
    return { ok: false, code: 'property_not_bound', reason: cfg.errorCode };
  }
  return { ok: true, propertyId: cfg.propertyId, config: cfg };
}

function _startSyncRun(db, { storeId, propertyId, syncType, rangeStart, rangeEnd }) {
  const r = db.run(
    `INSERT INTO ga4_geo_sync_runs
      (store_id, property_id, sync_type, range_start_date, range_end_date, started_at_utc, status)
     VALUES (?, ?, ?, ?, ?, ?, 'running')`,
    [storeId, propertyId || null, syncType, rangeStart || null, rangeEnd || null, _nowIso()]
  );
  return r.lastInsertRowid;
}

function _finishSyncRun(db, runId, patch) {
  const fields = [];
  const params = [];
  Object.entries(patch).forEach(([k, v]) => { fields.push(`${k}=?`); params.push(v); });
  params.push(runId);
  db.run(`UPDATE ga4_geo_sync_runs SET ${fields.join(', ')} WHERE id=?`, params);
}

// ══════════════════════════════════════════════════════════════════
// Realtime Snapshot
// ══════════════════════════════════════════════════════════════════
async function syncRealtimeGeoSnapshot(storeId, options = {}) {
  const db = options.db || getDb();
  const binding = getPropertyBinding(db, storeId);
  if (!binding.ok) return { success: false, code: binding.code };

  const lockKey = _lock(storeId, 'realtime');
  if (!lockKey) return { success: false, code: 'sync_in_progress' };

  const runId = _startSyncRun(db, { storeId, propertyId: binding.propertyId, syncType: 'realtime' });
  const adapter = options.adapter || productionAdapter;

  try {
    const result = await adapter.runRealtimeGeo(binding.propertyId, { timeoutMs: options.timeoutMs });
    if (!result.ok) {
      _finishSyncRun(db, runId, {
        finished_at_utc: _nowIso(), status: 'failed', error_code: result.code,
        error_message_safe: 'GA4 realtime request failed', stale_fallback_used: 1,
      });
      return { success: false, code: result.code, stale: true };
    }

    const bucket = _bucketFloor(new Date(), REALTIME_BUCKET_MINUTES);
    const nowIso = _nowIso();
    const taipei = _taipeiTimeString(new Date());
    let saved = 0, unknown = 0, overseas = 0;

    result.rows.forEach((row) => {
      const norm = normalizeGa4Location({ country: row.country, region: row.region, city: row.city });
      if (norm.normalization_status === 'unknown') unknown += 1;
      if (norm.normalization_status === 'overseas_or_other') overseas += 1;

      db.run(
        `INSERT INTO ga4_geo_realtime_snapshots
          (store_id, property_id, captured_bucket_utc, captured_at_utc, captured_at_taipei, window_minutes,
           country_raw, region_raw, city_raw, raw_location_key,
           country_code, county_code, county_name, district_code, district_name,
           normalization_status, administrative_level,
           active_users_30m, event_count_30m,
           source, metrics_version, normalization_version, sync_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ga4_realtime', ?, ?, ?)
         ON CONFLICT(store_id, property_id, captured_bucket_utc, raw_location_key, metrics_version)
         DO UPDATE SET
           active_users_30m = excluded.active_users_30m,
           event_count_30m = excluded.event_count_30m,
           captured_at_utc = excluded.captured_at_utc,
           captured_at_taipei = excluded.captured_at_taipei,
           normalization_status = excluded.normalization_status,
           administrative_level = excluded.administrative_level,
           county_code = excluded.county_code, county_name = excluded.county_name,
           district_code = excluded.district_code, district_name = excluded.district_name,
           sync_run_id = excluded.sync_run_id`,
        [
          storeId, binding.propertyId, bucket, nowIso, taipei, REALTIME_WINDOW_MINUTES,
          norm.country_raw, norm.region_raw, norm.city_raw, norm.raw_location_key,
          norm.country_code, norm.county_code, norm.county_name, norm.district_code, norm.district_name,
          norm.normalization_status, norm.administrative_level,
          row.metrics.activeUsers || 0, row.metrics.eventCount || 0,
          METRICS_VERSION, NORMALIZATION_VERSION, String(runId),
        ]
      );
      saved += 1;
    });

    _finishSyncRun(db, runId, {
      finished_at_utc: _nowIso(), status: 'success',
      rows_received: result.rows.length, rows_saved: saved, rows_unknown: unknown, rows_overseas: overseas,
      requests_used: 1,
    });
    return { success: true, rows_saved: saved, bucket };
  } catch (e) {
    _finishSyncRun(db, runId, {
      finished_at_utc: _nowIso(), status: 'failed', error_code: 'unexpected_error',
      error_message_safe: 'unexpected sync error', stale_fallback_used: 1,
    });
    return { success: false, code: 'unexpected_error', stale: true };
  } finally {
    _unlock(lockKey);
  }
}

// ══════════════════════════════════════════════════════════════════
// Historical Range
// ══════════════════════════════════════════════════════════════════
async function _fetchWithRetry(fn, retries = 2) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const r = await fn();
    if (r.ok) return r;
    last = r;
    if (!r.retryable) return r;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, Math.min(200 * (attempt + 1), 500)));
  }
  return last;
}

async function syncGeoRangeStats(storeId, range = {}, options = {}) {
  const db = options.db || getDb();
  const binding = getPropertyBinding(db, storeId);
  if (!binding.ok) return { success: false, code: binding.code };

  const window = resolveRangeWindow(range.type, range.start_date, range.end_date);
  if (!window.ok) return { success: false, code: window.code };

  const syncType = options.syncType || 'range';
  const lockKey = _lock(storeId, syncType);
  if (!lockKey) return { success: false, code: 'sync_in_progress' };

  const runId = _startSyncRun(db, {
    storeId, propertyId: binding.propertyId, syncType, rangeStart: window.start_date, rangeEnd: window.end_date,
  });
  const adapter = options.adapter || productionAdapter;

  try {
    const [audience, eventFunnel, commerce] = await Promise.all([
      _fetchWithRetry(() => adapter.runAudienceRange(binding.propertyId, window.start_date, window.end_date, { timeoutMs: options.timeoutMs })),
      _fetchWithRetry(() => adapter.runEventFunnelRange(binding.propertyId, window.start_date, window.end_date, { timeoutMs: options.timeoutMs })),
      _fetchWithRetry(() => adapter.runCommerceRange(binding.propertyId, window.start_date, window.end_date, { timeoutMs: options.timeoutMs })),
    ]);

    // 需求文件八「Partial Response Handling」/「Fail-open」: 只要有其中一支
    // 查詢失敗，仍以成功的查詢建立/更新該區間資料，並標示 partial=1，不清空
    // 既有快取（見需求文件二十一 8）。全部三支都失敗才整體視為失敗。
    const anyOk = audience.ok || eventFunnel.ok || commerce.ok;
    if (!anyOk) {
      _finishSyncRun(db, runId, {
        finished_at_utc: _nowIso(), status: 'failed',
        error_code: audience.code || eventFunnel.code || commerce.code || 'unknown_error',
        error_message_safe: 'all GA4 historical requests failed', stale_fallback_used: 1,
      });
      return { success: false, code: 'ga4_request_failed', stale: true };
    }
    const partial = !(audience.ok && eventFunnel.ok && commerce.ok);

    // ── Server-side merge by raw_location_key ──
    const merged = new Map();
    const getOrInit = (locFields) => {
      const norm = normalizeGa4Location(locFields);
      if (!merged.has(norm.raw_location_key)) {
        merged.set(norm.raw_location_key, {
          norm,
          active_users: 0, new_users: 0, sessions: 0,
          page_view_count: 0, view_item_count: 0, view_product_count: 0,
          add_to_cart_count: 0, begin_checkout_count: 0, checkout_click_count: 0, purchase_count: 0,
          transaction_count: 0, purchase_revenue: 0,
        });
      }
      return merged.get(norm.raw_location_key);
    };

    if (audience.ok) {
      audience.rows.forEach((row) => {
        const entry = getOrInit(row);
        entry.active_users = row.metrics.activeUsers || 0;
        entry.new_users = row.metrics.newUsers || 0;
        entry.sessions = row.metrics.sessions || 0;
      });
    }
    if (eventFunnel.ok) {
      eventFunnel.rows.forEach((row) => {
        const entry = getOrInit(row);
        const column = EVENT_NAME_TO_COLUMN[row.eventName];
        if (column) entry[column] += (row.metrics.eventCount || 0);
      });
    }
    if (commerce.ok) {
      commerce.rows.forEach((row) => {
        const entry = getOrInit(row);
        entry.transaction_count = row.metrics.transactions || 0;
        entry.purchase_revenue = row.metrics.purchaseRevenue || 0;
      });
    }

    const nowIso = _nowIso();
    let saved = 0, unknown = 0, overseas = 0;
    merged.forEach((entry) => {
      const { norm } = entry;
      if (norm.normalization_status === 'unknown') unknown += 1;
      if (norm.normalization_status === 'overseas_or_other') overseas += 1;

      db.run(
        `INSERT INTO ga4_geo_range_stats
          (store_id, property_id, range_start_date, range_end_date, timezone,
           country_raw, region_raw, city_raw, raw_location_key,
           country_code, county_code, county_name, district_code, district_name,
           normalization_status, administrative_level,
           active_users, new_users, sessions,
           page_view_count, view_product_count, view_item_count, add_to_cart_count,
           begin_checkout_count, checkout_click_count, purchase_count,
           transaction_count, purchase_revenue, currency,
           metrics_version, event_mapping_version, normalization_version, source,
           synced_at_utc, sync_run_id, updated_at)
         VALUES (?, ?, ?, ?, 'Asia/Taipei', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, 'ga4_report', ?, ?, ?)
         ON CONFLICT(store_id, property_id, range_start_date, range_end_date, raw_location_key, metrics_version, event_mapping_version)
         DO UPDATE SET
           active_users=excluded.active_users, new_users=excluded.new_users, sessions=excluded.sessions,
           page_view_count=excluded.page_view_count, view_product_count=excluded.view_product_count,
           view_item_count=excluded.view_item_count, add_to_cart_count=excluded.add_to_cart_count,
           begin_checkout_count=excluded.begin_checkout_count, checkout_click_count=excluded.checkout_click_count,
           purchase_count=excluded.purchase_count, transaction_count=excluded.transaction_count,
           purchase_revenue=excluded.purchase_revenue,
           normalization_status=excluded.normalization_status, administrative_level=excluded.administrative_level,
           county_code=excluded.county_code, county_name=excluded.county_name,
           district_code=excluded.district_code, district_name=excluded.district_name,
           synced_at_utc=excluded.synced_at_utc, sync_run_id=excluded.sync_run_id, updated_at=excluded.updated_at`,
        [
          storeId, binding.propertyId, window.start_date, window.end_date,
          norm.country_raw, norm.region_raw, norm.city_raw, norm.raw_location_key,
          norm.country_code, norm.county_code, norm.county_name, norm.district_code, norm.district_name,
          norm.normalization_status, norm.administrative_level,
          entry.active_users, entry.new_users, entry.sessions,
          entry.page_view_count, entry.view_product_count, entry.view_item_count, entry.add_to_cart_count,
          entry.begin_checkout_count, entry.checkout_click_count, entry.purchase_count,
          entry.transaction_count, entry.purchase_revenue,
          METRICS_VERSION, EVENT_MAPPING_VERSION, NORMALIZATION_VERSION,
          nowIso, String(runId), nowIso,
        ]
      );
      saved += 1;
    });

    _finishSyncRun(db, runId, {
      finished_at_utc: _nowIso(), status: partial ? 'partial' : 'success',
      rows_received: merged.size, rows_saved: saved, rows_unknown: unknown, rows_overseas: overseas,
      requests_used: [audience, eventFunnel, commerce].length, partial: partial ? 1 : 0,
    });
    return { success: true, rows_saved: saved, partial, range: window };
  } catch (e) {
    _finishSyncRun(db, runId, {
      finished_at_utc: _nowIso(), status: 'failed', error_code: 'unexpected_error',
      error_message_safe: 'unexpected sync error', stale_fallback_used: 1,
    });
    return { success: false, code: 'unexpected_error', stale: true };
  } finally {
    _unlock(lockKey);
  }
}

function syncTodayGeoStats(storeId, options = {}) {
  return syncGeoRangeStats(storeId, { type: 'today' }, { ...options, syncType: 'range' });
}
function syncYesterdayGeoStats(storeId, options = {}) {
  return syncGeoRangeStats(storeId, { type: 'yesterday' }, { ...options, syncType: 'range' });
}
function backfillGeoStats(storeId, range = {}, options = {}) {
  return syncGeoRangeStats(storeId, { ...range, type: range.type || 'custom' }, { ...options, syncType: 'backfill' });
}

// ══════════════════════════════════════════════════════════════════
// Read helpers（route 層使用；不直接打 GA4，只讀 DB 快取）
// ══════════════════════════════════════════════════════════════════
function getRealtimeGeoSummary(storeId, options = {}) {
  const db = options.db || getDb();
  const binding = getPropertyBinding(db, storeId);
  if (!binding.ok) return { success: false, code: binding.code };

  const sinceIso = new Date(Date.now() - 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19);
  const rows = db.all(
    `SELECT * FROM ga4_geo_realtime_snapshots
     WHERE store_id=? AND property_id=? AND captured_bucket_utc >= ?
     ORDER BY raw_location_key, captured_bucket_utc`,
    [storeId, binding.propertyId, sinceIso]
  );

  const byLocation = new Map();
  rows.forEach((r) => {
    if (!byLocation.has(r.raw_location_key)) byLocation.set(r.raw_location_key, []);
    byLocation.get(r.raw_location_key).push(r);
  });

  const summary = [];
  byLocation.forEach((snapshots) => {
    const latest = snapshots[snapshots.length - 1];
    const values = snapshots.map((s) => s.active_users_30m);
    const markerPoint = resolveMarkerPoint(latest);
    summary.push({
      raw_location_key: latest.raw_location_key,
      county_name: latest.county_name, district_name: latest.district_name,
      normalization_status: latest.normalization_status, administrative_level: latest.administrative_level,
      current_active_users: latest.active_users_30m,
      current_event_count: latest.event_count_30m,
      max_active_users: Math.max(...values),
      min_active_users: Math.min(...values),
      avg_active_users: Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100,
      first_seen_at_utc: snapshots[0].captured_at_utc,
      last_seen_at_utc: latest.captured_at_utc,
      snapshot_count: snapshots.length,
      // 座標一律只用 A1.2 Authoritative Catalog（需求文件十三），前端不得
      // 自己查表/算座標——沒有可信代表點就是 null，前端一律不畫 Marker。
      marker_point: markerPoint ? { lat: markerPoint.lat, lng: markerPoint.lng } : null,
      marker_accuracy: markerPoint ? (latest.administrative_level === 'district' ? 'district_aggregate' : 'county_aggregate') : null,
    });
  });

  const lastRun = db.get(
    `SELECT * FROM ga4_geo_sync_runs WHERE store_id=? AND sync_type='realtime' ORDER BY started_at_utc DESC LIMIT 1`,
    [storeId]
  );
  return {
    success: true,
    disclaimer: 'GA4 城市彙總推估，非單一訪客實際位置。',
    window_minutes: REALTIME_WINDOW_MINUTES,
    cities: summary,
    last_sync_status: lastRun ? lastRun.status : null,
    last_sync_at_utc: lastRun ? (lastRun.finished_at_utc || lastRun.started_at_utc) : null,
  };
}

function getRangeGeoStats(storeId, rangeKey, customStart, customEnd, options = {}) {
  const db = options.db || getDb();
  const binding = getPropertyBinding(db, storeId);
  if (!binding.ok) return { success: false, code: binding.code };

  const window = resolveRangeWindow(rangeKey, customStart, customEnd);
  if (!window.ok) return { success: false, code: window.code };

  const rows = db.all(
    `SELECT * FROM ga4_geo_range_stats
     WHERE store_id=? AND property_id=? AND range_start_date=? AND range_end_date=?
     ORDER BY county_name, district_name`,
    [storeId, binding.propertyId, window.start_date, window.end_date]
  );
  rows.forEach((row) => {
    const markerPoint = resolveMarkerPoint(row);
    row.marker_point = markerPoint ? { lat: markerPoint.lat, lng: markerPoint.lng } : null;
    row.marker_accuracy = markerPoint ? (row.administrative_level === 'district' ? 'district_aggregate' : 'county_aggregate') : null;
  });
  const lastRun = db.get(
    `SELECT * FROM ga4_geo_sync_runs WHERE store_id=? AND range_start_date=? AND range_end_date=? ORDER BY started_at_utc DESC LIMIT 1`,
    [storeId, window.start_date, window.end_date]
  );
  return {
    success: true,
    disclaimer: 'GA4 城市彙總推估，非單一訪客實際位置。',
    range: window,
    rows,
    stale: lastRun ? lastRun.status === 'failed' : false,
    last_sync_status: lastRun ? lastRun.status : null,
    last_sync_at_utc: lastRun ? (lastRun.finished_at_utc || lastRun.started_at_utc) : null,
  };
}

function getGa4GeoSyncStatus(storeId, options = {}) {
  const db = options.db || getDb();
  const binding = getPropertyBinding(db, storeId);

  const realtimeLast = db.get(
    `SELECT * FROM ga4_geo_sync_runs WHERE store_id=? AND sync_type='realtime' ORDER BY started_at_utc DESC LIMIT 1`, [storeId]
  );
  const rangeLast = db.get(
    `SELECT * FROM ga4_geo_sync_runs WHERE store_id=? AND sync_type IN ('range','backfill') ORDER BY started_at_utc DESC LIMIT 1`, [storeId]
  );
  const lastFailure = db.get(
    `SELECT * FROM ga4_geo_sync_runs WHERE store_id=? AND status='failed' ORDER BY started_at_utc DESC LIMIT 1`, [storeId]
  );
  const snapshotCount = db.get(`SELECT COUNT(*) as c FROM ga4_geo_realtime_snapshots WHERE store_id=?`, [storeId]);
  const rangeCount = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id=?`, [storeId]);
  const unknownCount = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id=? AND normalization_status='unknown'`, [storeId]);
  const overseasCount = db.get(`SELECT COUNT(*) as c FROM ga4_geo_range_stats WHERE store_id=? AND normalization_status='overseas_or_other'`, [storeId]);
  const quotaErrors = db.get(`SELECT COUNT(*) as c FROM ga4_geo_sync_runs WHERE store_id=? AND error_code IN ('QUOTA_EXCEEDED','RESOURCE_EXHAUSTED')`, [storeId]);
  const timeoutErrors = db.get(`SELECT COUNT(*) as c FROM ga4_geo_sync_runs WHERE store_id=? AND error_code='TIMEOUT'`, [storeId]);
  const apiErrors = db.get(`SELECT COUNT(*) as c FROM ga4_geo_sync_runs WHERE store_id=? AND status='failed'`, [storeId]);
  const anyRunning = db.get(`SELECT COUNT(*) as c FROM ga4_geo_sync_runs WHERE store_id=? AND status='running'`, [storeId]);

  return {
    enabled: binding.ok || binding.code !== 'ga4_disabled',
    configured: binding.ok,
    property_binding_status: binding.ok ? 'PASS' : 'BLOCKED',
    store_isolation_status: 'PASS',
    timezone_status: 'Asia/Taipei',

    realtime_last_success_at: realtimeLast && realtimeLast.status === 'success' ? realtimeLast.finished_at_utc : null,
    range_last_success_at: rangeLast && (rangeLast.status === 'success' || rangeLast.status === 'partial') ? rangeLast.finished_at_utc : null,
    last_failure_at: lastFailure ? lastFailure.finished_at_utc : null,

    realtime_snapshot_count: snapshotCount ? snapshotCount.c : 0,
    range_cache_count: rangeCount ? rangeCount.c : 0,

    last_rows_received: rangeLast ? rangeLast.rows_received : 0,
    last_rows_saved: rangeLast ? rangeLast.rows_saved : 0,
    unknown_city_count: unknownCount ? unknownCount.c : 0,
    overseas_city_count: overseasCount ? overseasCount.c : 0,

    quota_error_count: quotaErrors ? quotaErrors.c : 0,
    timeout_count: timeoutErrors ? timeoutErrors.c : 0,
    api_error_count: apiErrors ? apiErrors.c : 0,

    sync_in_progress: !!(anyRunning && anyRunning.c > 0),
    cache_stale: !!(lastFailure && rangeLast && lastFailure.id === rangeLast.id),
    data_source: 'ga4_report',
    metrics_version: METRICS_VERSION,
    event_mapping_version: EVENT_MAPPING_VERSION,
  };
}

module.exports = {
  syncRealtimeGeoSnapshot,
  syncGeoRangeStats,
  syncTodayGeoStats,
  syncYesterdayGeoStats,
  backfillGeoStats,
  getGa4GeoSyncStatus,
  getRealtimeGeoSummary,
  getRangeGeoStats,
  resolveRangeWindow,
  getPropertyBinding,
  EVENT_NAME_TO_COLUMN,
  METRICS_VERSION,
  NORMALIZATION_VERSION,
  EVENT_MAPPING_VERSION,
};
