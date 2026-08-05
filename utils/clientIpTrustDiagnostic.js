// utils/clientIpTrustDiagnostic.js — fix18-10-hotfix30-B5-R5.4-G1.6-A2-T1
// Zeabur Client IP Trust Verification — 純診斷、不啟用/不影響 Geo 功能
//
// 目的：確認 X-Forwarded-For／req.ip／socket.remoteAddress 在 Zeabur 正式
// 部署中的可信關係與代理跳數，供之後 Client IP Trust Gate 判定使用。
//
// 嚴格範圍限制：
//   - 本檔案完全獨立於 utils/geoSanitizer.js／utils/geoResolver.js／
//     utils/geoProviders/——不是第二套 Resolver，只是唯讀觀察既有請求物件
//     並輸出「分類後的統計形狀」，不做任何信任判斷或下游查詢。
//   - 不呼叫任何 IP Geo Provider。
//   - 不寫入 DB、不寫入 Log、不寫入任何持久化儲存。
//   - 所有回傳欄位都經過白名單，原始 IP／Header 字串永遠不會離開這支函式
//     的呼叫堆疊。
//
// Ephemeral fingerprint：
//   - process 啟動時產生一次隨機 32-byte secret（不寫入任何地方）。
//   - fingerprint = HMAC-SHA256(secret, rawIp 或 rawIp+xff組合).slice(0,16)。
//   - process 重啟後這把 secret 消失，所有先前的 fingerprint 立即失效且
//     無法逆推回真實 IP（HMAC 單向、secret 只存在記憶體）。

'use strict';

const crypto = require('crypto');

const _processStartedAt = new Date().toISOString();
const _ephemeralSecret = crypto.randomBytes(32); // 只存在此 process 的記憶體

const SENTINEL_IP = '198.51.100.77'; // RFC 5737 TEST-NET-2，文件保留位址，不會是任何真實訪客

function _fingerprint(...parts) {
  const material = parts.filter(Boolean).join('|');
  if (!material) return null;
  return crypto.createHmac('sha256', _ephemeralSecret).update(material).digest('hex').slice(0, 16);
}

// 還原 IPv4-mapped IPv6 → 純 IPv4，方便分類（不影響回傳，只影響分類結果）。
function _unwrapMapped(ip) {
  if (!ip || typeof ip !== 'string') return ip;
  const m = ip.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i);
  return m ? m[1] : ip;
}

function _family(ip) {
  if (!ip || typeof ip !== 'string') return null;
  const v = _unwrapMapped(ip.trim());
  if (!v) return null;
  if (v.includes('.') && !v.includes(':')) return 4;
  if (v.includes(':')) return 6;
  return null;
}

// scope 分類：public / private / loopback / invalid
// 刻意獨立實作（不 import utils/geoSanitizer.isPrivateOrLocalIp），因為這裡
// 需要更細的四分類（含 loopback 獨立於 private，且要能標示 invalid），
// 而 geoSanitizer 那支是給 Geo 查詢用的二分類「可不可以送 Provider」。
// 兩者用途不同，維持獨立、不互相耦合，避免未來改動其中一支影響到另一支。
function _scope(ip) {
  if (!ip || typeof ip !== 'string') return 'invalid';
  let v = _unwrapMapped(ip.trim());
  if (!v) return 'invalid';

  if (v.includes('.') && !v.includes(':')) {
    const parts = v.split('.').map((p) => Number(p));
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return 'invalid';
    const [a, b] = parts;
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'private'; // link-local，歸入 private 類別（非公開可路由）
    if (a === 0) return 'invalid';
    if (a === 100 && b >= 64 && b <= 127) return 'private'; // 100.64.0.0/10 CGNAT
    return 'public';
  }

  if (v.includes(':')) {
    const low = v.toLowerCase();
    if (low === '::1') return 'loopback';
    if (low === '::') return 'invalid';
    if (/^f[cd][0-9a-f]{2}:/.test(low)) return 'private'; // fc00::/7 unique local
    if (/^fe[89ab][0-9a-f]:/.test(low)) return 'private'; // fe80::/10 link-local
    return 'public';
  }

  return 'invalid';
}

// 解析 X-Forwarded-For（唯讀分類，不回傳原始字串）。
function _parseXff(req) {
  const raw = req && req.headers ? req.headers['x-forwarded-for'] : null;
  if (!raw || typeof raw !== 'string') {
    return { present: false, hops: [] };
  }
  const hops = raw.split(',').map((s) => s.trim()).filter(Boolean);
  return { present: hops.length > 0, hops };
}

// Sentinel 位置判斷：leftmost（客戶端自己塞在最前面，符合 XFF 慣例的「原始
// 客戶端在最左」）／rightmost（被附加在最後，通常代表某一跳代理原樣轉發了
// 客戶端塞的值，且自己沒有再往後加）／middle（介於中間，代表至少有一層在
// sentinel 之後又追加了東西）。
function _sentinelPosition(hops) {
  const idx = hops.findIndex((h) => _unwrapMapped(h) === SENTINEL_IP);
  if (idx === -1) return { seen: false, position: null };
  if (idx === 0) return { seen: true, position: hops.length === 1 ? 'leftmost' : 'leftmost' };
  if (idx === hops.length - 1) return { seen: true, position: 'rightmost' };
  return { seen: true, position: 'middle' };
}

// 主要診斷函式。req 是本次請求物件（若呼叫端要測試 Sentinel Spoof，必須
// 自己在請求的 X-Forwarded-For 帶入 198.51.100.77，這支函式只負責觀察與
// 分類，不主動發送任何測試請求）。
function buildClientIpTrustDiagnostic(req) {
  const socketIp = (req.socket && req.socket.remoteAddress)
    || (req.connection && req.connection.remoteAddress)
    || null;
  const reqIp = req.ip || (Array.isArray(req.ips) && req.ips[0]) || null;

  const xff = _parseXff(req);
  const sentinel = _sentinelPosition(xff.hops);
  const reqIpIsSentinel = !!(reqIp && _unwrapMapped(reqIp) === SENTINEL_IP);

  // trust_proxy_configured：Express 是否曾經以非 false 的值設定 trust proxy
  // （app.get('trust proxy') 在 server.js 用 computeTrustProxySetting() 設定，
  // 這裡唯讀查詢當下生效值，不重新計算）。
  const trustProxySetting = req.app ? req.app.get('trust proxy') : false;
  const trustProxyConfigured = trustProxySetting !== false && trustProxySetting !== undefined;

  const trustedHeaderConfigured = !!(process.env.GEO_TRUSTED_IP_HEADER || '').trim();

  return {
    trust_proxy_configured: trustProxyConfigured,
    trusted_header_configured: trustedHeaderConfigured,
    socket_ip_family: _family(socketIp),
    socket_ip_scope: _scope(socketIp),
    req_ip_family: _family(reqIp),
    req_ip_scope: _scope(reqIp),
    xff_present: xff.present,
    xff_hop_count: xff.hops.length,
    xff_hop_scopes: xff.hops.map((h) => _scope(h)),
    sentinel_seen: sentinel.seen,
    sentinel_position: sentinel.position,
    req_ip_is_sentinel: reqIpIsSentinel,
    // fingerprint 同時綁定 socket IP 與 req.ip，兩者任一改變（例如換網路）
    // fingerprint 就會改變；同一 process 內、同一組來源多次請求 fingerprint
    // 保持一致，方便比對「這是不是同一個 Client」而不需要看到真實 IP。
    ephemeral_client_fingerprint: _fingerprint(socketIp, reqIp) || 'unavailable',
    process_started_at: _processStartedAt,
  };
}

module.exports = { buildClientIpTrustDiagnostic, SENTINEL_IP };
