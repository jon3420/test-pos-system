// utils/returnUrlValidator.js — fix18-10-hotfix23-E1
//
// LINE Member Return URL allowlist 驗證。
// 只處理 line_member_return_url（LIFF 登入完成後導回的網址），
// 不影響任何其他既有 URL 驗證邏輯。
//
// 允許來源（依序）：
//   1. 系統正式主網域   — 環境變數 APP_BASE_URL / PUBLIC_BASE_URL 的 hostname
//   2. 額外允許網域     — 環境變數 ALLOWED_HOSTS（逗號分隔）
//   3. LINE 會員專屬 allowlist — 環境變數 LINE_MEMBER_RETURN_URL_ALLOWLIST（逗號分隔）
//   4. 目前 request host（僅在已知 proxy/trust 設定正確、且該 host 本身
//      已被上面任一 allowlist 或既有店家網域接受時使用；本專案目前沒有
//      設定 `app.set('trust proxy', ...)`，所以 request host 僅作為
//      「與 allowlist 比對」的來源，不會單獨授權一個未知網域）
//   5. 開發環境 — NODE_ENV !== 'production' 時額外允許 localhost / 127.0.0.1
//                （只允許 http，僅供本機測試）
//
// 拒絕：javascript: / data: / file: / ftp: / blob:、含 user:password@、
// 協定相對 URL（//evil.com）、反斜線混淆（https:\\evil.com）、
// hostname 非完全相符 allowlist（不得用 includes()）、正式環境 HTTP。

'use strict';

const DANGEROUS_PROTOCOLS = new Set(['javascript:', 'data:', 'file:', 'ftp:', 'blob:', 'vbscript:']);

function parseHostList(envValue) {
  if (!envValue) return [];
  return String(envValue)
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean);
}

function getStaticAllowlist() {
  const hosts = new Set();

  for (const envKey of ['APP_BASE_URL', 'PUBLIC_BASE_URL']) {
    const v = process.env[envKey];
    if (v) {
      try {
        const u = new URL(v);
        hosts.add(u.hostname.toLowerCase());
      } catch (e) { /* 忽略格式錯誤的 env 值 */ }
    }
  }

  parseHostList(process.env.ALLOWED_HOSTS).forEach(h => hosts.add(h));
  parseHostList(process.env.LINE_MEMBER_RETURN_URL_ALLOWLIST).forEach(h => hosts.add(h));

  return hosts;
}

// 子網域是否允許必須「明確設定」：
//   'example.com'    → 只允許完全相符 example.com
//   '*.example.com'  → 允許 example.com 的任意子網域（不含 example.com 本身，
//                        如需兩者都允許，allowlist 需同時列出兩筆）
function hostnameAllowed(hostname, allowSet) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return false;
  for (const allowed of allowSet) {
    if (!allowed) continue;
    if (allowed.startsWith('*.')) {
      const base = allowed.slice(2);
      if (base && h.endsWith('.' + base)) return true; // 不得用 includes()/子字串比對
    } else if (h === allowed) {
      return true;
    }
  }
  return false;
}

/**
 * validateLineMemberReturnUrl(url, context)
 *
 * @param {string} url
 * @param {object} context
 *   - req: Express request（可用來取得目前 request host 做比對，選填）
 * @returns {{ ok:true, url:string, hostname:string } | { ok:false, reason:string }}
 */
function validateLineMemberReturnUrl(url, context) {
  context = context || {};
  const raw = (url == null) ? '' : String(url).trim();

  if (!raw) return { ok: false, reason: 'empty' };

  // 反斜線混淆（https:\\evil.com、https:/\evil.com 等）一律拒絕，
  // 在丟進 URL parser 之前就先擋，避免不同瀏覽器/環境解析行為不一致。
  if (raw.includes('\\')) return { ok: false, reason: 'backslash_obfuscation' };

  // 協定相對 URL（//evil.com）
  if (/^\/\//.test(raw)) return { ok: false, reason: 'protocol_relative_url' };

  let parsed;
  try {
    parsed = new URL(raw);
  } catch (e) {
    return { ok: false, reason: 'invalid_url' };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (DANGEROUS_PROTOCOLS.has(protocol)) {
    return { ok: false, reason: 'dangerous_protocol' };
  }
  if (protocol !== 'http:' && protocol !== 'https:') {
    return { ok: false, reason: 'unsupported_protocol' };
  }

  // 含 user:password@
  if (parsed.username || parsed.password) {
    return { ok: false, reason: 'credentials_in_url' };
  }

  const hostname = parsed.hostname.toLowerCase();
  const isProduction = process.env.NODE_ENV === 'production';

  // 本機開發環境
  if (!isProduction && protocol === 'http:' && (hostname === 'localhost' || hostname === '127.0.0.1')) {
    return { ok: true, url: raw, hostname };
  }

  // 正式環境不得使用 HTTP
  if (protocol === 'http:') {
    return { ok: false, reason: isProduction ? 'http_not_allowed_in_production' : 'http_not_allowed' };
  }

  const allowSet = getStaticAllowlist();

  // 目前 request host — 預設不自動信任（避免 Host header poisoning）。
  // server.js 目前沒有設定 `app.set('trust proxy', ...)`，Host header 在
  // 未經代理層清洗前不可視為可信來源。只有在維運者明確設定
  // TRUST_REQUEST_HOST=true（代表 proxy/trust 設定已確認正確）時，才把
  // 目前 request host 加入允許清單。
  if (context.req && context.req.hostname && process.env.TRUST_REQUEST_HOST === 'true') {
    allowSet.add(String(context.req.hostname).toLowerCase());
  }

  if (!hostnameAllowed(hostname, allowSet)) {
    return { ok: false, reason: 'domain_not_allowlisted' };
  }

  return { ok: true, url: raw, hostname };
}

module.exports = { validateLineMemberReturnUrl };
