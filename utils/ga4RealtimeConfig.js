// utils/ga4RealtimeConfig.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime — Store Config Resolver（單一權威來源）
//
// 沿用既有 settings key-value 表（store_id, key, value），不新增 DB Schema
// （已確認 routes/settings.js 等既有端點大量使用同一張表存任意 key，見
// R5.4-G1.5-A_BACKEND_CORRECTNESS_REPORT.md §一）。設計上刻意跟
// utils/geoMapScope.js 同一種切法：純函式 parser 吃/吐 plain object，
// DB 存取另外包一層薄 wrapper，方便測試不用真的連 DB。
//
// 多店隔離規則（不得違反）：
//   - propertyId／streamId 一律來自該店自己的 settings row，不得跨店讀取
//     （呼叫端一律用 req.storeId 查自己的 settings，SQL 本身也帶 WHERE
//     store_id=?，物理上不可能讀到別店）。
//   - Server 環境變數 GA4_PROPERTY_ID／GA4_STREAM_ID 只有在該店自己的
//     ga4_realtime_single_property_mode 設定為 true，且部署層級
//     GA4_REALTIME_SINGLE_STORE_MODE=true 同時成立時，才會被當作 fallback
//     使用（兩個條件缺一都不行——只有部署層級允許還不夠，還需要店家自己
//     明確選擇「使用共用 Property」，避免只設定環境變數就讓所有店家意外
//     共用同一個 Property）。
//   - 前端／Route query 傳入的 propertyId/streamId/credentials 一律忽略，
//     不作為設定來源（見 routes/geo-live.js）。

'use strict';

const GA4_REALTIME_SETTINGS_KEYS = Object.freeze([
  'ga4_realtime_enabled',
  'ga4_realtime_property_id',
  'ga4_realtime_stream_id',
  'ga4_realtime_single_property_mode',
  'ga4_realtime_cache_seconds',
  'ga4_realtime_auto_refresh_enabled',
]);

const GA4_CACHE_SECONDS_MIN = 30;
const GA4_CACHE_SECONDS_MAX = 300;
const GA4_CACHE_SECONDS_DEFAULT = 60;

function _boolFromSetting(raw, def) {
  if (raw === undefined || raw === null || raw === '') return def;
  const s = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'off'].includes(s)) return false;
  return def;
}

// normalizeGa4PropertyId(raw) → { ok, value, code }
//   - 只接受純數字字串（GA4 Property ID 本身是數字）。
//   - 不接受已經帶 `properties/` 前綴的值（避免組出
//     `properties/properties/xxx`）、URL、負數、空白、特殊符號。
function normalizeGa4PropertyId(raw) {
  if (raw === undefined || raw === null) return { ok: false, code: 'missing_property' };
  const s = String(raw).trim();
  if (!s) return { ok: false, code: 'missing_property' };
  if (!/^[0-9]+$/.test(s)) return { ok: false, code: 'invalid_property' };
  return { ok: true, value: s };
}

function formatGa4PropertyPath(propertyId) {
  return `properties/${propertyId}`;
}

// validateGa4StreamId(raw) → { ok, value, code }
//   GA4 Web Stream ID 本身也是純數字字串（例如 GA 後台「資料串流詳情」頁
//   顯示的「串流 ID」）。不當作 secret（不需要遮蔽），但一律只用來源自
//   該店自己的設定，不接受跨店/前端傳入。
function validateGa4StreamId(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return { ok: false, code: 'missing_stream' };
  const s = String(raw).trim();
  if (!/^[0-9]+$/.test(s)) return { ok: false, code: 'invalid_stream' };
  return { ok: true, value: s };
}

// normalizeGa4CacheSeconds(raw, def) → clamp 到 [30,300]；NaN/undefined 用預設值。
function normalizeGa4CacheSeconds(raw, def = GA4_CACHE_SECONDS_DEFAULT) {
  if (raw === undefined || raw === null || raw === '') return def;
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(GA4_CACHE_SECONDS_MAX, Math.max(GA4_CACHE_SECONDS_MIN, Math.trunc(n)));
}

// parseGa4RealtimeSettingsRow(rawSettings, envFallback) → 完整 config（純函式，
// 不碰 DB）。
//   rawSettings：{ ga4_realtime_enabled, ga4_realtime_property_id, ... }（字串值，
//     跟 DB row 的 value 欄位一致）。
//   envFallback：{ globalEnabled, singleStoreMode, envPropertyId, envStreamId,
//     defaultCacheSeconds }（呼叫端從 process.env 讀好傳進來，這裡不直接讀
//     process.env，方便測試）。
function parseGa4RealtimeSettingsRow(rawSettings, envFallback = {}) {
  const s = rawSettings || {};
  const globalEnabled = !!envFallback.globalEnabled;
  const storeEnabled = _boolFromSetting(s.ga4_realtime_enabled, false);
  const enabled = globalEnabled && storeEnabled;

  const cacheSeconds = normalizeGa4CacheSeconds(
    s.ga4_realtime_cache_seconds,
    normalizeGa4CacheSeconds(envFallback.defaultCacheSeconds, GA4_CACHE_SECONDS_DEFAULT)
  );
  const autoRefreshEnabled = _boolFromSetting(s.ga4_realtime_auto_refresh_enabled, true);

  if (!enabled) {
    return {
      enabled: false, configured: false, propertyId: null, streamId: null,
      singlePropertyMode: false, cacheSeconds, autoRefreshEnabled,
      source: 'disabled', errorCode: 'ga4_realtime_disabled',
    };
  }

  // 店家是否選擇「使用共用 Property」——需求文件三 B：這是店家自己的選擇，
  // 不是只靠部署層級環境變數就自動套用。
  const storeOptsIntoSingleProperty = _boolFromSetting(s.ga4_realtime_single_property_mode, false);
  const deploymentAllowsSingleStore = !!envFallback.singleStoreMode;
  const useSingleStoreFallback = storeOptsIntoSingleProperty && deploymentAllowsSingleStore;

  let propertySource = s.ga4_realtime_property_id;
  let streamSource = s.ga4_realtime_stream_id;
  let source = 'store_settings';

  const ownPropertyResult = normalizeGa4PropertyId(propertySource);
  if (!ownPropertyResult.ok && useSingleStoreFallback) {
    propertySource = envFallback.envPropertyId;
    streamSource = envFallback.envStreamId;
    source = 'env_single_store';
  }

  const propertyResult = normalizeGa4PropertyId(propertySource);
  if (!propertyResult.ok) {
    return {
      enabled: true, configured: false, propertyId: null, streamId: null,
      singlePropertyMode: useSingleStoreFallback, cacheSeconds, autoRefreshEnabled,
      source, errorCode: propertyResult.code,
    };
  }

  // singlePropertyMode 店家：允許沒有 streamId（查整個 Property，不分
  // Stream）；非 singlePropertyMode 店家：streamId 必填，缺少一律
  // configured:false（不得默默查整個共用 Property，見需求文件三 C）。
  if (!useSingleStoreFallback) {
    const streamResult = validateGa4StreamId(streamSource);
    if (!streamResult.ok) {
      return {
        enabled: true, configured: false, propertyId: propertyResult.value, streamId: null,
        singlePropertyMode: false, cacheSeconds, autoRefreshEnabled,
        source, errorCode: streamResult.code === 'missing_stream' ? 'stream_not_configured' : streamResult.code,
      };
    }
    return {
      enabled: true, configured: true, propertyId: propertyResult.value, streamId: streamResult.value,
      singlePropertyMode: false, cacheSeconds, autoRefreshEnabled, source, errorCode: null,
    };
  }

  // useSingleStoreFallback：streamId 是選填（可能整個共用 Property 沒有切
  // Stream，或該店確實只對應單一 Stream 環境變數）。
  const streamResult = validateGa4StreamId(streamSource);
  return {
    enabled: true, configured: true, propertyId: propertyResult.value,
    streamId: streamResult.ok ? streamResult.value : null,
    singlePropertyMode: true, cacheSeconds, autoRefreshEnabled, source, errorCode: null,
  };
}

// getGa4RealtimeConfig(db, storeId) → 讀既有 settings 表（WHERE store_id=?，
// 物理上不可能讀到別店），組成 rawSettings 後交給純函式 parser。
function getGa4RealtimeConfig(db, storeId) {
  const rows = db.all(
    `SELECT key, value FROM settings WHERE store_id=? AND key IN (${GA4_REALTIME_SETTINGS_KEYS.map(() => '?').join(',')})`,
    [storeId, ...GA4_REALTIME_SETTINGS_KEYS]
  );
  const rawSettings = {};
  (rows || []).forEach((r) => { rawSettings[r.key] = r.value; });

  const envFallback = {
    globalEnabled: _boolFromSetting(process.env.GA4_REALTIME_ENABLED, false),
    singleStoreMode: _boolFromSetting(process.env.GA4_REALTIME_SINGLE_STORE_MODE, false),
    envPropertyId: process.env.GA4_PROPERTY_ID,
    envStreamId: process.env.GA4_STREAM_ID,
    defaultCacheSeconds: process.env.GA4_REALTIME_CACHE_SECONDS,
  };
  return parseGa4RealtimeSettingsRow(rawSettings, envFallback);
}

// validateGa4RealtimeSettingsPatch(body) → { ok, message } — 純函式，
// 供 routes/settings.js 的 PATCH /api/settings/ga4-realtime 與 smoke test
// 共用同一份規則（沿用 utils/geoMapScope.js 的
// validateGeoMapSettingsPatch() 同一種切法，見需求文件二）。
//
// 白名單（不得接受清單外任何欄位，尤其是 credentials/private_key/
// client_email/service_account_json/access_token/refresh_token/store_id/
// property path）：
function validateGa4RealtimeSettingsPatch(body) {
  const b = body || {};
  const allowed = new Set(GA4_REALTIME_SETTINGS_KEYS);
  const forbiddenKeys = ['store_id', 'storeId', 'credentials', 'private_key', 'client_email', 'service_account_json', 'access_token', 'refresh_token', 'property_path', 'property_id', 'stream_id'];
  for (const k of Object.keys(b)) {
    if (forbiddenKeys.includes(k)) {
      return { ok: false, message: `不允許透過此欄位設定：${k}` };
    }
    if (!allowed.has(k)) {
      return { ok: false, message: `未知的設定欄位：${k}` };
    }
  }
  if (b.ga4_realtime_property_id !== undefined && b.ga4_realtime_property_id !== '' && b.ga4_realtime_property_id !== null) {
    if (!/^[0-9]+$/.test(String(b.ga4_realtime_property_id))) {
      return { ok: false, message: 'GA4 Property ID 必須是純數字（或留空）' };
    }
  }
  if (b.ga4_realtime_stream_id !== undefined && b.ga4_realtime_stream_id !== '' && b.ga4_realtime_stream_id !== null) {
    if (!/^[0-9]+$/.test(String(b.ga4_realtime_stream_id))) {
      return { ok: false, message: 'GA4 Stream ID 必須是純數字（或留空）' };
    }
  }
  if (b.ga4_realtime_cache_seconds !== undefined && b.ga4_realtime_cache_seconds !== '' && b.ga4_realtime_cache_seconds !== null) {
    const n = Number(b.ga4_realtime_cache_seconds);
    if (!Number.isFinite(n) || n < GA4_CACHE_SECONDS_MIN || n > GA4_CACHE_SECONDS_MAX) {
      return { ok: false, message: `Cache 秒數必須介於 ${GA4_CACHE_SECONDS_MIN}～${GA4_CACHE_SECONDS_MAX} 秒之間` };
    }
  }
  // 若啟用 GA4 且不是 single-property mode，Property 與 Stream 必填
  // （需求文件六）。這裡只能檢查「這次 PATCH body 本身」，不知道其他欄位
  // 之前的既有值，所以只在 body 同時帶了 enabled=true 且明確不是
  // single-property mode 時才擋；缺少完整 context 的部分驗證交給
  // getGa4RealtimeConfig() 之後讀出來的 configured:false 處理。
  const enabling = String(b.ga4_realtime_enabled) === 'true' || b.ga4_realtime_enabled === true;
  const explicitlyNotSingle = b.ga4_realtime_single_property_mode !== undefined
    && !(String(b.ga4_realtime_single_property_mode) === 'true' || b.ga4_realtime_single_property_mode === true);
  if (enabling && explicitlyNotSingle) {
    const hasProperty = b.ga4_realtime_property_id !== undefined && String(b.ga4_realtime_property_id).trim() !== '';
    const hasStream = b.ga4_realtime_stream_id !== undefined && String(b.ga4_realtime_stream_id).trim() !== '';
    if (!hasProperty || !hasStream) {
      return { ok: false, message: '啟用 GA4 即時推估圖層且未使用單一 Property 模式時，Property ID 與 Stream ID 為必填' };
    }
  }
  return { ok: true };
}

module.exports = {
  GA4_REALTIME_SETTINGS_KEYS,
  GA4_CACHE_SECONDS_MIN,
  GA4_CACHE_SECONDS_MAX,
  GA4_CACHE_SECONDS_DEFAULT,
  normalizeGa4PropertyId,
  formatGa4PropertyPath,
  validateGa4StreamId,
  normalizeGa4CacheSeconds,
  validateGa4RealtimeSettingsPatch,
  parseGa4RealtimeSettingsRow,
  getGa4RealtimeConfig,
};
