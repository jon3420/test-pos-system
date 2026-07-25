// utils/geoProviders/index.js — fix18-10-hotfix30-B5-R5.1-D / R5.1-D1
// Visitor IP Geo Provider — Registry × Cache × Privacy Gate × Status
//
// 這是本輪唯一「真正打 Provider」的地方。utils/geoResolver.js 只負責事件
// 層的欄位模型與 fail-open 語意，實際 Provider 選型／cache／隱私守門／
// 統計統一收斂在這裡，之後要換 Provider 或調整 cache 策略只需要改這一個
// 檔案（見 R5.1-D1 需求文件三：架構必須可替換為 ipinfo/ipdata/maxmind/
// cloudflare 等其他正式 provider——新增一個 adapter 檔案＋在 PROVIDERS 白名單
// 註冊即可，不必更動 geoResolver.js 或任何呼叫端）。
//
// 隱私守門（見需求文件三、六、七、九、十）：
//   - 原始 IP 只活在這個函式呼叫的 stack 內，用完即丟，不儲存、不回傳。
//   - Cache key 一律是 HMAC-SHA256(IP, GEO_CACHE_SECRET)，絕非明文 IP 或
//     單純 SHA-256(IP)（避免可逆字典猜測）。
//   - Cache value 只保留正規化後的行政區維度，不含 Provider 原始回應。
//   - 私有／保留／loopback IP 一律不送 Provider（見 geoSanitizer.isPrivateOrLocalIp）。
//   - Provider 未設定（disabled，預設值）時，完全不建立任何 cache entry、
//     不發出任何網路請求。

'use strict';

const crypto = require('crypto');
const { withTimeout } = require('./base');
const disabledProvider = require('./disabled');
const ipapiProvider = require('./ipapi');
const { isPrivateOrLocalIp } = require('../geoSanitizer');
const { normalizeTaiwanGeo } = require('../taiwanGeoNormalize');
const { getGeoFeatureFlags } = require('../geoFeatureFlags');

const PROVIDERS = {
  disabled: disabledProvider,
  ipapi: ipapiProvider,
};

// ── env 讀取（獨立於 utils/geoFeatureFlags.js 的布林開關，這裡是 Provider
//    本身的設定值：選型／金鑰／逾時／cache TTL）──────────────────────────
function _envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || String(raw).trim() === '') return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : def;
}

function getActiveProviderName() {
  const raw = (process.env.GEO_VISITOR_IP_PROVIDER || 'disabled').trim().toLowerCase();
  // 未知的設定值（例如打錯字、還沒實作的 provider 名稱）一律 fail-safe 退回
  // disabled，不得讓應用啟動失敗，也不得意外把 IP 送到未預期的地方。
  return PROVIDERS[raw] ? raw : 'disabled';
}

function getProvider() {
  return PROVIDERS[getActiveProviderName()] || disabledProvider;
}

// fix18-10-hotfix30-B5-R5.1-D1（七、Cache 安全）——
// GEO_CACHE_SECRET 未設定時，不得靜默使用固定內建字串（那等於全部部署共用
// 同一把可預期的鑰匙，退化成幾乎等同明文 cache key）。改用行程啟動時產生的
// 隨機值，並且只警告一次、不外洩任何敏感內容。
let _warnedNoCacheSecret = false;
function _cacheSecret() {
  if (!process.env.GEO_CACHE_SECRET) {
    if (!_cacheSecret._fallback) {
      _cacheSecret._fallback = crypto.randomBytes(32).toString('hex');
    }
    if (!_warnedNoCacheSecret) {
      _warnedNoCacheSecret = true;
      console.warn('[GeoProvider] Geo cache secret not configured; using process-local ephemeral key');
    }
    return _cacheSecret._fallback;
  }
  return process.env.GEO_CACHE_SECRET;
}

function _hmacKey(rawIp) {
  return crypto.createHmac('sha256', _cacheSecret()).update(String(rawIp)).digest('hex');
}

// ── 記憶體 cache（成功/失敗分開 TTL，見需求文件七）───────────────────────
const _cache = new Map(); // hmacKey -> { ok, result, expiresAt }
const _stats = {
  cache_hits: 0, cache_misses: 0,
  success_count: 0, failure_count: 0,
  last_success_at: null, last_error_code: null,
};

// 測試專用 reset（不影響 production 行為——只有測試腳本會呼叫）。
function resetProviderStatusForTest() {
  _stats.cache_hits = 0;
  _stats.cache_misses = 0;
  _stats.success_count = 0;
  _stats.failure_count = 0;
  _stats.last_success_at = null;
  _stats.last_error_code = null;
}
function clearGeoCacheForTest() {
  _cache.clear();
}
// 舊名稱保留（R5.1-D 既有呼叫端/測試相容），行為等同上面兩者合併。
function _resetForTest() {
  clearGeoCacheForTest();
  resetProviderStatusForTest();
}

function _cacheSize() { return _cache.size; }

// lookupViaConfiguredProvider(rawIp)
//   → { country, region, city, district, postal_code, accuracy, provider } 或 null（unknown / 失敗 / 未設定 / 私有IP）
// rawIp 只在這個函式的呼叫堆疊內使用，函式回傳後不再持有任何參照
// （呼叫端 utils/geoResolver.js 也不得把 rawIp 存進閉包或模組層變數）。
async function lookupViaConfiguredProvider(rawIp) {
  if (!rawIp) return null;

  if (isPrivateOrLocalIp(rawIp)) {
    // 私有/保留位址不算「Provider 呼叫」，不計入 success/failure 統計，
    // 只記錄最近一次判定原因供診斷使用。
    _stats.last_error_code = 'PRIVATE_OR_LOCAL_IP';
    return null;
  }

  const provider = getProvider();
  if (provider === disabledProvider) {
    return null; // 未設定 Provider：不建立 cache entry，不呼叫任何網路服務，不計入統計
  }

  const key = _hmacKey(rawIp);
  const cached = _cache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    _stats.cache_hits++;
    if (cached.ok) { _stats.success_count++; return cached.result; }
    _stats.failure_count++;
    return null;
  }
  _stats.cache_misses++;

  const timeoutMs = _envInt('GEO_VISITOR_IP_TIMEOUT_MS', 2500);
  const successTtlMs = _envInt('GEO_VISITOR_IP_CACHE_TTL_SECONDS', 86400) * 1000;
  const failureTtlMs = _envInt('GEO_VISITOR_IP_FAILURE_CACHE_TTL_SECONDS', 900) * 1000;

  let outcome;
  try {
    outcome = await withTimeout(
      provider.lookupVisitorGeo(rawIp, {
        apiKey: process.env.GEO_VISITOR_IP_API_KEY || '',
        timeoutMs,
      }),
      timeoutMs
    );
  } catch (e) {
    outcome = { ok: false, provider: provider.name, code: e.message === 'TIMEOUT' ? 'TIMEOUT' : 'NETWORK_ERROR', message: e.message };
  }

  if (outcome && outcome.ok) {
    const normalized = normalizeTaiwanGeo({ city: outcome.city, district: outcome.district, region: outcome.region });
    const result = {
      country: outcome.country || null,
      region: outcome.region || null,
      city: normalized.city || outcome.city || null,
      district: normalized.district || null,
      postal_code: outcome.postal_code || null,
      accuracy: outcome.accuracy || (outcome.city ? 'city' : 'unknown'),
      provider: outcome.provider || provider.name,
    };
    _stats.success_count++;
    _stats.last_success_at = new Date().toISOString();
    _stats.last_error_code = null;
    _cache.set(key, { ok: true, result, expiresAt: Date.now() + successTtlMs });
    return result;
  }

  _stats.failure_count++;
  _stats.last_error_code = (outcome && outcome.code) || 'UNKNOWN_ERROR';
  _cache.set(key, { ok: false, result: null, expiresAt: Date.now() + failureTtlMs });
  return null;
}

// R5.1-D1 需求文件四要求的對外名稱（單一 IP 版本，內部委派同一支實作）。
async function lookupVisitorGeo(ip) {
  return lookupViaConfiguredProvider(ip);
}

// GET /api/analytics/geo/provider-status 的資料來源（見 routes/analytics-geo.js）。
// 刻意不回傳：API key、GEO_CACHE_SECRET、raw IP、cache key、provider URL、
// 完整例外 stack——只回不涉密的計數與最近狀態代碼。
function getProviderStatus() {
  const flags = getGeoFeatureFlags();
  const providerName = getActiveProviderName();
  const configured = providerName !== 'disabled';
  const enabled = !!flags.GEO_VISITOR_IP_ENABLED;

  let status = 'disabled';
  if (!enabled) status = 'disabled';
  else if (!configured) status = 'not_configured';
  else if (_stats.failure_count > 0 && _stats.success_count === 0) status = 'unhealthy';
  else status = 'healthy';

  return {
    enabled,
    configured,
    provider: providerName,
    status,
    last_success_at: _stats.last_success_at,
    last_error_code: _stats.last_error_code,
    cache_hits: _stats.cache_hits,
    cache_misses: _stats.cache_misses,
    success_count: _stats.success_count,
    failure_count: _stats.failure_count,
  };
}

module.exports = {
  lookupViaConfiguredProvider,
  lookupVisitorGeo,
  getProvider,
  getProviderStatus,
  getActiveProviderName,
  resetProviderStatusForTest,
  clearGeoCacheForTest,
  _resetForTest,
  _cacheSize,
  _hmacKeyForTest: _hmacKey,
};
