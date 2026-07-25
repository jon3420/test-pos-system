// utils/geoProviders/ipapi.js — fix18-10-hotfix30-B5-R5.1-D
//
// 真正可用的 Visitor IP Geo Provider adapter（ip-api.com）。
// 統一介面（見需求文件五）：
//   lookupVisitorGeo(ip, options) → { ok, provider, country, region, city,
//                                     district, postal_code, accuracy,
//                                     source, raw } 或 { ok:false, provider,
//                                     code, message }
//
// 重要：本檔案只在單次呼叫的記憶體中處理 IP／回應內容，回傳值不含完整
// Provider response（raw 一律 undefined），呼叫端（utils/geoProviders/index.js）
// 也絕不把 IP 或完整回應寫入 cache/DB（見需求文件三、六）。
//
// 免費額度：http://ip-api.com/json/{ip}（HTTP、無需 key，45 req/分鐘）。
// 若設定 GEO_VISITOR_IP_API_KEY，改用付費 https://pro.ip-api.com/json/{ip}?key=...
// （HTTPS、更高額度）。兩者回應格式相同，共用同一個 parser。
//
// 已知限制（見 CHANGELOG「Known Limitations」）：本 adapter 的免費／付費端點
// 目前只驗證 IPv4 查詢；IPv6 一律回傳 code=IPV6_UNSUPPORTED，不嘗試呼叫
// （避免對不支援的位址格式發出無意義的外部請求）。
//
// ⚠️ 商用狀態（十九、正式啟用指引 — 誠實標示，不得宣稱已適合正式商用）：
//   - 免費端點（http://ip-api.com/json/...）條款明確禁止「commercial use」，
//     且限制 45 requests/分鐘、只提供 HTTP（不支援 HTTPS）。
//   - 這代表：**免費端點只適合 development / evaluation，不適合正式 SaaS
//     營運使用**。正式上線前必須：
//       (a) 向 ip-api.com 購買 Pro（GEO_VISITOR_IP_API_KEY 設定後會自動改走
//           https://pro.ip-api.com/...，支援 HTTPS 與更高額度、無 commercial
//           use 限制），或
//       (b) 改接其他正式 Provider（ipinfo.io／ipdata.co／MaxMind GeoLite2
//           本地資料庫／Cloudflare 等）——Provider Registry（見
//           utils/geoProviders/index.js 的 PROVIDERS 白名單）本來就是為了
//           讓「換 Provider」只需要新增一個 adapter 檔案＋在白名單註冊，
//           不必更動 geoResolver.js 或任何呼叫端。
//   - 本專案預設 GEO_VISITOR_IP_PROVIDER=disabled，需要維運者明確評估過
//     商用條款、自行選擇並設定後才會啟用，不會有任何預設安裝在未經確認下
//     就對外呼叫 ip-api.com。

'use strict';

const fetch = require('node-fetch');
const { providerError } = require('./base');

const name = 'ipapi';

const RESPONSE_FIELDS = 'status,message,country,countryCode,regionName,city,district,zip,query';

function _endpointFor(ip, apiKey) {
  if (apiKey) {
    return `https://pro.ip-api.com/json/${encodeURIComponent(ip)}?key=${encodeURIComponent(apiKey)}&fields=${RESPONSE_FIELDS}`;
  }
  return `http://ip-api.com/json/${encodeURIComponent(ip)}?fields=${RESPONSE_FIELDS}`;
}

// 純函式：解析 ip-api.com 回應 body（已 JSON.parse 過的物件）→ 統一介面結果。
// 抽成獨立函式方便單元測試（不需要真的打網路）。
function _parseIpApiBody(body) {
  if (!body || typeof body !== 'object') {
    return providerError(name, 'INVALID_JSON', 'Provider response is not a valid object');
  }
  if (body.status === 'fail') {
    // ip-api 對私有/保留位址、格式錯誤等回傳 status=fail + message
    const msg = String(body.message || '').toLowerCase();
    if (msg.includes('private range') || msg.includes('reserved range')) {
      return providerError(name, 'PRIVATE_OR_LOCAL_IP', body.message);
    }
    return providerError(name, 'PROVIDER_LOOKUP_FAILED', body.message || 'lookup failed');
  }
  if (body.status !== 'success') {
    return providerError(name, 'PROVIDER_LOOKUP_FAILED', 'Unexpected provider status');
  }
  if (!body.city && !body.regionName && !body.country) {
    return providerError(name, 'MISSING_CITY', 'Provider response missing city/region/country');
  }
  return {
    ok: true,
    provider: name,
    country: body.countryCode || body.country || null,
    region: body.regionName || null,
    city: body.city || null,
    district: body.district || null, // ip-api 的 district 欄位覆蓋率有限，常為空字串
    postal_code: body.zip || null,
    accuracy: body.city ? 'city' : (body.regionName ? 'region' : 'country'),
    source: 'ip',
    raw: undefined, // 絕不把完整 Provider response 往上傳（見需求文件五）
  };
}

async function lookupVisitorGeo(ip, options = {}) {
  if (!ip || typeof ip !== 'string') {
    return providerError(name, 'INVALID_IP', 'Missing IP');
  }
  if (ip.includes(':')) {
    // 見檔案頂端「已知限制」：本 adapter 尚未驗證 IPv6 查詢，直接回不支援，
    // 不對外發出無意義的請求。
    return providerError(name, 'IPV6_UNSUPPORTED', 'IPv6 lookup not supported by this adapter');
  }

  const timeoutMs = Number(options.timeoutMs) || 2500;
  const url = _endpointFor(ip, options.apiKey);

  // fix18-10-hotfix30-B5-R5.1-D1（六、Provider Timeout 與 Fail-Open）：
  // 用 AbortController 真正中斷底層 socket，而不只是讓呼叫端的 Promise
  // 提前 resolve/reject（node-fetch 若沒有收到 abort signal，request 仍會
  // 繼續在背景跑，逾時後應立即釋放）。
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let res;
  try {
    res = await fetch(url, { method: 'GET', signal: controller.signal });
  } catch (e) {
    if (e && (e.name === 'AbortError' || /aborted/i.test(e.message || ''))) {
      return providerError(name, 'TIMEOUT', 'Geo provider timeout');
    }
    return providerError(name, 'NETWORK_ERROR', e.message || 'network error');
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) return providerError(name, 'RATE_LIMITED', 'Provider rate limit (429)');
  if (res.status === 403) return providerError(name, 'FORBIDDEN', 'Provider forbidden (403)');
  if (res.status >= 500) return providerError(name, 'PROVIDER_SERVER_ERROR', `Provider server error (${res.status})`);
  if (!res.ok) return providerError(name, 'PROVIDER_HTTP_ERROR', `Provider HTTP ${res.status}`);

  let body;
  try {
    body = await res.json();
  } catch (e) {
    return providerError(name, 'INVALID_JSON', 'Provider returned invalid JSON');
  }

  return _parseIpApiBody(body);
}

module.exports = { name, lookupVisitorGeo, _parseIpApiBody };
