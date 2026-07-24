// utils/geoSanitizer.js — fix18-10-hotfix30-B5-R5.1-A Geo Data Foundation
//
// 隱私規則的唯一實作點（四、IP Geo 隱私原則）：
//   - IP 只允許在伺服器端短期解析，解析完成後只保留行政區維度。
//   - 不得將完整 IP 寫入 Analytics metadata / 回傳給前端。
//   - 不得信任任意客戶端傳入的 IP Header——只信任專案已知反向代理會設定的
//     header 名稱（x-forwarded-for / cf-connecting-ip / x-real-ip），且僅在
//     GEO_VISITOR_IP_ENABLED 開啟時才會被讀取。
//
// 目前部署環境（server.js）尚未設定 `app.set('trust proxy', ...)`，也沒有任何
// 既有程式碼對 X-Forwarded-For 做「只信任最外層反向代理」的驗證（見專案盤點：
// routes/line-member.js、routes/line-checkout-handoff.js 目前是直接讀
// `req.headers['x-forwarded-for']` 第一段，未驗證來源）。這裡新增的
// getTrustedClientIp() 是本輪唯一信任來源，之後應取代那些既有的臨時寫法，
// 但本輪範圍只新增，不改動既有呼叫點的行為（避免影響 R1~R4 既有 diagnostics）。

'use strict';

const TRUSTED_PROXY_HEADERS = ['cf-connecting-ip', 'x-real-ip', 'x-forwarded-for'];

// fix18-10-hotfix30-B5-R5.1-B：修正來源 IP 信任模型（四、修正 Proxy 與來源 IP
// 信任模型）。R5.1-A 版本只要 header 存在就相信，這是不安全的——任何客戶端都
// 能自己塞 X-Forwarded-For。本輪原則：
//   1. 優先使用 Express 經 `app.set('trust proxy', ...)` 處理過的 `req.ip`/
//      `req.ips`（Express 只有在受信任的代理層數內才會採信 header，見
//      computeTrustProxySetting() 與 server.js）。
//   2. 只有在部署環境明確用 GEO_TRUSTED_IP_HEADER 指定「這一個 header 一定是
//      反向代理設定的、不可能被客戶端覆蓋」時，才允許直接讀取該 header（例如
//      Cloudflare 在 edge 層會覆寫 cf-connecting-ip，不管 Express trust proxy
//      設定為何都可信任）。未設定時完全不讀取任何原始 header，只依賴
//      Express trust proxy 機制。
//   3. 兩者都沒有時，回退 socket remoteAddress（可能是代理本身的 IP，仍優於
//      直接相信任意 header）。

// 解析 TRUST_PROXY env 成 Express app.set('trust proxy', ...) 可接受的值。
// 支援 false / loopback / linklocal / uniquelocal / 數字（代理層數）/ '1'。
// 刻意不支援裸的 `true`（等同信任任何 X-Forwarded-For，任何客戶端都能偽造），
// 未知值一律安全退回 false，不讓應用啟動失敗、也不讓行為意外變得更寬鬆。
function computeTrustProxySetting(rawEnv) {
  const KNOWN_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'];
  if (rawEnv === undefined || rawEnv === null || String(rawEnv).trim() === '') return false;
  const s = String(rawEnv).trim();
  if (s.toLowerCase() === 'false') return false;
  if (s.toLowerCase() === 'true') return false; // 刻意不支援，見上方註解
  if (KNOWN_KEYWORDS.includes(s.toLowerCase())) return s.toLowerCase();
  const n = Number(s);
  if (Number.isInteger(n) && n >= 0 && n <= 10) return n;
  return false; // 非法值一律 fail-safe 回 false，不得造成應用啟動失敗
}

// 部署環境明確指定「這個 header 一定是可信反向代理寫的」時才讀取（見上方說明）。
// 只讀取一個名稱，避免像 R5.1-A 那樣依序嘗試多個 header 造成混淆的信任來源。
function _trustedHeaderOverride(req) {
  const headerName = (process.env.GEO_TRUSTED_IP_HEADER || '').trim().toLowerCase();
  if (!headerName || !req || !req.headers) return null;
  const raw = req.headers[headerName];
  if (!raw) return null;
  const first = String(raw).split(',')[0].trim();
  return first || null;
}

// 取得「可信任」的來源 IP：
//   1. GEO_TRUSTED_IP_HEADER 明確指定時優先採用（部署商保證的 header）。
//   2. 否則使用 Express trust-proxy 處理過的 req.ip（需 server.js 已設定
//      app.set('trust proxy', ...)，見 computeTrustProxySetting()）。
//   3. 都沒有時退回 socket remoteAddress。
// 舊版（R5.1-A）依序嘗試 cf-connecting-ip/x-real-ip/x-forwarded-for 的行為保留
// 在 _legacyHeaderScan() 中，僅供尚未設定 trust proxy 時的 diagnostics 相容
// 呼叫端（routes/line-member.js 等既有程式碼）比對測試使用，Geo 解析本身
// 不再使用它，避免同一個不安全的信任來源被新功能繼續放大使用。
function _legacyHeaderScan(req) {
  if (!req || !req.headers) return null;
  for (const h of TRUSTED_PROXY_HEADERS) {
    const raw = req.headers[h];
    if (raw) {
      const first = String(raw).split(',')[0].trim();
      if (first) return first;
    }
  }
  return null;
}

function getTrustedClientIp(req) {
  if (!req) return null;

  const override = _trustedHeaderOverride(req);
  if (override) return override;

  // req.ip / req.ips 只有在 Express trust proxy 設定妥當時才反映真正的客戶端 IP；
  // 未設定 trust proxy 時，req.ip 就是 socket remoteAddress（通常是反向代理自己
  // 的 IP），這是安全但精度較低的預設狀態——比起相信任意客戶端 header 好。
  if (req.ip) return req.ip;
  if (Array.isArray(req.ips) && req.ips.length > 0) return req.ips[0];

  if (req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  if (req.connection && req.connection.remoteAddress) return req.connection.remoteAddress;
  return null;
}

// 短期解析用：把 IP 截斷到「不可定位單一使用者」的精度，僅供本次請求內傳給
// IP→行政區 provider 使用，絕不儲存、絕不回傳、絕不寫入 metadata。
function truncateIpForResolution(ip) {
  if (!ip || typeof ip !== 'string') return null;
  if (ip.includes('.')) {
    // IPv4：只保留前三段（/24），足夠做縣市等級推定又不可定位單一住戶
    const parts = ip.split('.');
    if (parts.length === 4) return `${parts[0]}.${parts[1]}.${parts[2]}.0/24`;
    return null;
  }
  if (ip.includes(':')) {
    // IPv6：只保留前 3 組（約 /48）
    const parts = ip.split(':').filter(Boolean);
    if (parts.length >= 3) return `${parts[0]}:${parts[1]}:${parts[2]}::/48`;
    return null;
  }
  return null;
}

// 一般 Analytics API／前端絕不可見的欄位。任何要對外（API、前端、一般商家
// 後台）回傳的 geo 紀錄，一律先過這個函式。
const FORBIDDEN_OUTPUT_FIELDS = [
  'ip', 'raw_ip', 'client_ip', 'full_address', 'address', 'lat', 'lng',
  'latitude', 'longitude', 'gps_lat', 'gps_lng', 'visitor_id_raw',
];

function sanitizeGeoForOutput(rec) {
  if (!rec || typeof rec !== 'object') return null;
  const out = {};
  for (const [k, v] of Object.entries(rec)) {
    if (FORBIDDEN_OUTPUT_FIELDS.includes(k)) continue;
    out[k] = v;
  }
  return out;
}

module.exports = {
  TRUSTED_PROXY_HEADERS,
  getTrustedClientIp,
  truncateIpForResolution,
  sanitizeGeoForOutput,
  FORBIDDEN_OUTPUT_FIELDS,
  computeTrustProxySetting,
  _legacyHeaderScan,
};
