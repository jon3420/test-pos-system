// utils/cartRecoveryOrchestration.js
// H1.4.10 Phase 4C — Recovery n8n Orchestration
//
// 責任分工（本輪核心原則）：
//   n8n：負責「什麼時候叫醒 POS」（排程/等待）。
//   POS：永遠是 authority，負責「現在到底能不能發」——n8n 絕對不自行判斷
//        consent/好友/購買/converted/max_attempts/token/LIFF/cart snapshot，
//        即使 n8n 認為「應該提醒」，POS 收到 due request 後仍會重新
//        evaluateLineRecoveryEligibility()（見 utils/cartRecoveryDelivery.js，
//        本模組完全不重複那套邏輯，只負責 orchestration 本身）。
//
// 這支模組完全獨立於既有 n8n_webhook_url（訂單通知 webhook，
// routes/line-orders.js／routes/line-shipping.js／routes/orders.js 在用），
// 不共用 settings key、不共用簽章機制。

'use strict';

const crypto = require('crypto');

function _safe(fn, fallback) {
  try { return fn(); } catch (e) {
    console.warn('[cartRecoveryOrchestration] fail-open:', e.message);
    return fallback;
  }
}
function _getSetting(db, storeId, key, fallback) {
  return _safe(() => {
    const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
    if (!row || row.value === undefined || row.value === null || row.value === '') return fallback;
    return row.value;
  }, fallback);
}

function isOrchestrationEnabled(db, storeId) {
  return _getSetting(db, storeId, 'cart_recovery_n8n_enabled', '0') === '1';
}
function getWebhookUrl(db, storeId) {
  return _getSetting(db, storeId, 'cart_recovery_n8n_webhook_url', '');
}
function getSharedSecret(db, storeId) {
  return _getSetting(db, storeId, 'cart_recovery_n8n_secret', '');
}
function hasSharedSecret(db, storeId) {
  return !!getSharedSecret(db, storeId);
}

// ══════════════════════════════════════════════════════════════════
// Shared Secret 格式驗證 SSOT。正式格式固定為 crypto.randomBytes(32)
// 的 base64url 編碼（32 random bytes → 43 字元、無 padding，見
// rotate 端點實際產生方式）。routes/settings.js（手動輸入路徑）與
// routes/cart-recovery-orchestration.js 的 /secret/rotate（自動產生路徑）
// 都必須呼叫這裡，不得各自寫一份判斷邏輯。
//
// 拒絕：
//   - 長度不是 43（42/44 都不行，不是「至少 32 字元」這種寬鬆長度檢查）
//   - 非 base64url 字元集（只允許 A-Z a-z 0-9 _ -）
//   - 單一字元重複（如 'a'.repeat(43)）
//   - 兩字元循環（如 'ab' 循環 43 字元）
//   - 字元多樣性過低（unique 字元數過少，防禦更長週期的簡單循環樣式）
// ══════════════════════════════════════════════════════════════════
const SHARED_SECRET_EXPECTED_LENGTH = 43; // base64url(crypto.randomBytes(32))
const SHARED_SECRET_CHARSET_RE = /^[A-Za-z0-9_-]+$/;
const SHARED_SECRET_MIN_UNIQUE_CHARS = 12; // 43 字元的高熵隨機字串，實務上 unique 字元數通常遠高於這個門檻

function validateSharedSecret(secret) {
  if (typeof secret !== 'string') return { valid: false, reason: 'not_a_string' };
  if (secret.length !== SHARED_SECRET_EXPECTED_LENGTH) {
    return { valid: false, reason: 'invalid_length' };
  }
  if (!SHARED_SECRET_CHARSET_RE.test(secret)) {
    return { valid: false, reason: 'invalid_charset' };
  }
  // 單一字元重複：'a'.repeat(43)、'b'.repeat(43) 之類。
  if (/^(.)\1+$/.test(secret)) {
    return { valid: false, reason: 'repeated_single_char' };
  }
  // 兩字元循環：例如 'ab' 重複到 43 字元（含奇數長度時最後截斷的情況）。
  const twoCharCycle = secret.slice(0, 2);
  if (twoCharCycle.length === 2) {
    let isCycle = true;
    for (let i = 0; i < secret.length; i++) {
      if (secret[i] !== twoCharCycle[i % 2]) { isCycle = false; break; }
    }
    if (isCycle) return { valid: false, reason: 'repeated_two_char_cycle' };
  }
  // 一般化：更長週期的簡單循環樣式（例如 4~8 字元循環撐滿 43 字元）一律用
  // unique 字元數這個更寬的門檻擋下，不用窮舉每一種週期長度。
  const uniqueChars = new Set(secret.split('')).size;
  if (uniqueChars < SHARED_SECRET_MIN_UNIQUE_CHARS) {
    return { valid: false, reason: 'low_entropy' };
  }
  return { valid: true, reason: null };
}

// ══════════════════════════════════════════════════════════════════
// HMAC 簽章（POS→n8n 與 n8n→POS 共用同一份 canonical string 規則，只是
// 呼叫端不同）。canonical string 固定順序，不得依賴 JSON.stringify 的 key
// 順序（那不保證穩定）。
// ══════════════════════════════════════════════════════════════════
// 需求文件三／四（Phase 4C 本輪 Reality Audit 確認）：utils/cartRecovery.js
// 的 _nowIso()／_plusMinutesIso() 都是用 Date.toISOString()（永遠是 UTC）
// 產生，只是把 'T'/'Z' 拿掉存成 'YYYY-MM-DD HH:MM:SS' 給 SQLite 文字比較用。
// 所以 DB 的 due_at 確定是 UTC，不是 server local time——這裡可以安全直接
// 補回 'Z' 變成明確 timezone 的 ISO8601，不是用猜的。只用在 n8n payload／
// HMAC canonical dueAt，完全不改 DB schema 或既有 eligibility SQL。
function toOrchestrationDueAt(dueAt) {
  if (!dueAt) return null;
  // 已經是 ISO8601 帶 timezone（含 Z 或 +/-HH:MM）就原樣使用，避免重複轉換。
  if (/[Zz]$|[+-]\d{2}:\d{2}$/.test(dueAt)) return dueAt;
  return dueAt.replace(' ', 'T') + 'Z';
}
function buildCanonicalString({ version, storeId, timestamp, requestId, dueAt }) {
  return ['v1', String(storeId), String(timestamp), String(requestId), dueAt !== undefined ? String(dueAt) : ''].join('\n');
}
function sign(secret, fields) {
  const canonical = buildCanonicalString(fields);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex');
}
// 需求文件二十：timing-safe compare，不得用 ===。
function verifySignature(secret, fields, providedSignatureHex) {
  return _safe(() => {
    if (!secret || !providedSignatureHex) return false;
    const expected = sign(secret, fields);
    const a = Buffer.from(expected, 'hex');
    const b = Buffer.from(String(providedSignatureHex), 'hex');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }, false);
}

// 需求文件二十一：timestamp window（±5 分鐘）。
const TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;
function isTimestampFresh(timestamp, nowMs) {
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = nowMs !== undefined ? nowMs : Date.now();
  return Math.abs(now - ts) <= TIMESTAMP_WINDOW_MS;
}

// ══════════════════════════════════════════════════════════════════
// SSRF-safe URL 驗證（需求文件三十一／三十二）。只允許正式 https:// 網址，
// 拒絕 localhost/loopback/link-local/private network/file/ftp。
// ══════════════════════════════════════════════════════════════════
const BLOCKED_HOSTNAME_PATTERNS = [
  /^localhost$/i,
  /^127\./, /^0\.0\.0\.0$/,
  /^169\.254\./, // link-local
  /^10\./, /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./, // 172.16.0.0 - 172.31.255.255
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,
  // IPv6 literals（需求文件十九）：URL 裡的 IPv6 host 會被中括號包住，
  // 例如 https://[::1]/webhook，u.hostname 拿到的是「不含中括號」的
  // ::1／fc00::.../fe80::...，這裡用前綴比對涵蓋常見危險範圍。
  /^::1$/, /^::$/, // loopback／unspecified
  /^fc[0-9a-f]{2}:/i, /^fd[0-9a-f]{2}:/i, // fc00::/7 unique local
  /^fe[89ab][0-9a-f]:/i, // fe80::/10 link-local
  /^::ffff:127\./i, /^::ffff:10\./i, /^::ffff:192\.168\./i, // IPv4-mapped private
];
function isSafeWebhookUrlByHostname(rawUrl) {
  return _safe(() => {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let u;
    try { u = new URL(rawUrl); } catch (e) { return false; }
    if (u.protocol !== 'https:') return false;
    const hostname = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
    if (BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(hostname))) return false;
    return true;
  }, false);
}

// 需求文件二十／二十一（本輪收緊）：字串比對只能擋「明顯寫死的內網
// hostname」，擋不住 https://evil.example 這種公開網域但 DNS 指向內網 IP
// 的情況。這裡額外用 dns.lookup 解析實際 IP 逐一檢查。
//
// 已知限制（誠實記錄，非隱瞞）：這裡驗證的是「檢查當下」DNS 解析出的 IP，
// 真正 fetch 發生時 Node/底層 http agent 會重新做一次 DNS 查詢——如果攻擊者
// 在這兩次查詢之間切換 DNS 記錄（DNS rebinding），這裡的檢查可能被繞過。
// 要完全防禦需要在 fetch 階段用自訂 Agent pin 住已驗證過的 IP，目前
// Node 內建 fetch／node-fetch 沒有提供夠低階的 API 安全做到這件事，這是
// Phase 4C 已知、未完全解決的限制，而不是假裝已經完整防護。
function isPublicIp(ip, family) {
  if (family === 4) {
    if (/^127\./.test(ip) || ip === '0.0.0.0') return false;
    if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(ip)) return false;
    if (/^169\.254\./.test(ip)) return false;
    return true;
  }
  // IPv6
  const lower = ip.toLowerCase();
  if (lower === '::1' || lower === '::') return false;
  if (/^fc[0-9a-f]{2}:/.test(lower) || /^fd[0-9a-f]{2}:/.test(lower)) return false;
  if (/^fe[89ab][0-9a-f]:/.test(lower)) return false;
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice(7);
    return isPublicIp(mapped, 4);
  }
  return true;
}
async function resolveSafeWebhookTarget(rawUrl) {
  if (!isSafeWebhookUrlByHostname(rawUrl)) return { safe: false, reason: 'invalid_or_unsafe_url' };
  try {
    const dns = require('dns').promises;
    const u = new URL(rawUrl);
    const addresses = await dns.lookup(u.hostname, { all: true });
    if (!addresses.length) return { safe: false, reason: 'dns_resolution_failed' };
    const allPublic = addresses.every((a) => isPublicIp(a.address, a.family));
    if (!allPublic) return { safe: false, reason: 'dns_resolved_to_private_ip' };
    return { safe: true };
  } catch (e) {
    return { safe: false, reason: 'dns_resolution_failed' };
  }
}
// 向下相容：既有呼叫端（含既有測試）用的同步版本，只做 hostname 字串檢查。
// 真正發送前（sendWakeUp）額外呼叫 resolveSafeWebhookTarget() 做 DNS 檢查。
function isSafeWebhookUrl(rawUrl) {
  return isSafeWebhookUrlByHostname(rawUrl);
}

// ══════════════════════════════════════════════════════════════════
// Replay Protection（持久化在 DB，不用 in-memory Map/Set，process restart
// 仍然有效）。
// ══════════════════════════════════════════════════════════════════
function recordOrchestrationRequest(db, storeId, requestId, direction, extra) {
  return _safe(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    try {
      db.run(
        `INSERT INTO cart_recovery_orchestration_requests (store_id, request_id, direction, status, http_status, error_code, requested_at, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [storeId, requestId, direction, (extra && extra.status) || 'received', (extra && extra.httpStatus) || 0, (extra && extra.errorCode) || '', now, now]
      );
      return { ok: true, replay: false };
    } catch (e) {
      // UNIQUE(store_id, request_id, direction) 撞到 → 這是 replay
      return { ok: false, replay: true };
    }
  }, { ok: false, replay: false });
}
function markOrchestrationRequestProcessed(db, storeId, requestId, direction, extra) {
  return _safe(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.run(
      `UPDATE cart_recovery_orchestration_requests SET status=?, http_status=?, error_code=?, processed_at=? WHERE store_id=? AND request_id=? AND direction=?`,
      [(extra && extra.status) || 'processed', (extra && extra.httpStatus) || 0, (extra && extra.errorCode) || '', now, storeId, requestId, direction]
    );
  }, undefined);
}

// ══════════════════════════════════════════════════════════════════
// POS → n8n Wake-Up（fire-and-forget，fail-open，5-10 秒 timeout，不跟隨
// redirect，payload 最小化，不含任何 PII）。
// ══════════════════════════════════════════════════════════════════
async function sendWakeUp(db, storeId, { stage, dueAt } = {}) {
  // 需求文件十二：_safe(async () => {...}) 這個 pattern 本身是同步
  // try/catch，包不住 async function 內部真正的 Promise rejection——改成
  // 真正的 async try/catch，讓例外真的被這支函式自己捕捉，不會變成
  // unhandledRejection 一路傳到呼叫端。
  try {
    if (!isOrchestrationEnabled(db, storeId)) return { sent: false, reason: 'disabled' };
    const webhookUrl = getWebhookUrl(db, storeId);
    const targetCheck = await resolveSafeWebhookTarget(webhookUrl);
    if (!targetCheck.safe) return { sent: false, reason: targetCheck.reason };
    const secret = getSharedSecret(db, storeId);
    if (!secret) return { sent: false, reason: 'secret_missing' };

    // 需求文件八～十一：outbound wake-up 用專屬的 claim helper，語意與
    // inbound replay protection 完全不同——inbound 是「同一個 request_id
    // 只能處理一次」，outbound 需要的是「同一個 due_at 在真正送達 n8n 之前
    // 允許因為暫時性網路失敗而重試」。
    const stableKey = `wakeup:${stage || 'unknown'}:${dueAt || 'unknown'}`;
    const claim = claimOutboundWakeUp(db, storeId, stableKey);
    if (!claim.claimed) return { sent: false, reason: claim.reason };

    const requestId = crypto.randomUUID();
    const timestamp = Date.now();
    // 需求文件三／四：n8n payload／HMAC 用明確 timezone 的 dueAt，不是原始
    // DB 格式（那沒有 Z，n8n 自己的 parser 可能依它自己的 timezone 誤解讀）。
    const orchestrationDueAt = toOrchestrationDueAt(dueAt);
    const signature = sign(secret, { version: 'v1', storeId, timestamp, requestId, dueAt: orchestrationDueAt });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    let res;
    try {
      const fetchFn = (typeof fetch !== 'undefined') ? fetch : require('node-fetch');
      res = await fetchFn(webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-POS-Recovery-Version': 'v1',
          'X-POS-Recovery-Timestamp': String(timestamp),
          'X-POS-Recovery-Request-Id': requestId,
          'X-POS-Recovery-Signature': `sha256=${signature}`,
        },
        body: JSON.stringify({ version: 'v1', store_id: storeId, due_at: orchestrationDueAt, stage: stage || null, request_id: requestId, sent_at: timestamp }),
        signal: controller.signal,
        redirect: 'error', // 需求文件三十三：不跟隨 redirect
      });
    } catch (fetchErr) {
      clearTimeout(timeoutId);
      // 需求文件十三／三十六：wake-up 失敗絕對 fail-open，不影響任何顧客
      // 流程，也絕不把 Recovery Job 標記成 failed（還沒有真的嘗試過 LINE
      // Push）。這裡只把 outbound claim 退回 failed，允許之後同 due_at 重試。
      releaseOutboundWakeUpAsFailed(db, storeId, stableKey);
      const reason = fetchErr && fetchErr.name === 'AbortError' ? 'timeout' : 'network_error';
      return { sent: false, reason };
    }
    clearTimeout(timeoutId);

    // 需求文件六：只有 2xx 才算真的送達 n8n。4xx/5xx 一律視為失敗，允許重試，
    // 不得誤判成 sent=true。
    if (res.status >= 200 && res.status < 300) {
      markOrchestrationRequestProcessed(db, storeId, stableKey, 'outbound_wakeup', { status: 'processed', httpStatus: res.status });
      return { sent: true, status: res.status };
    }
    releaseOutboundWakeUpAsFailed(db, storeId, stableKey);
    return { sent: false, reason: 'http_error', status: res.status };
  } catch (e) {
    console.warn('[cartRecoveryOrchestration] sendWakeUp exception:', e.message);
    return { sent: false, reason: 'exception' };
  }
}

// ══════════════════════════════════════════════════════════════════
// 需求文件十：Outbound Claim Helper（與 inbound replay 語意分開）。
//
//   沒有 row              → INSERT status='sending' → claimed:true
//   status='processed'    → claimed:false, reason='already_processed'
//   status='sending'（近期）→ claimed:false, reason='in_progress'
//   status='failed'       → UPDATE 回 'sending'，attempt_count+=1 → claimed:true
//
// 需求文件九：additive attempt_count／updated_at 欄位，不做 destructive
// migration（見 utils/db.js 的 ALTER TABLE ADD COLUMN）。
// ══════════════════════════════════════════════════════════════════
const OUTBOUND_IN_PROGRESS_WINDOW_MS = 30 * 1000; // sending 狀態的短期 claim window，避免真正並發時重複送出

function claimOutboundWakeUp(db, storeId, stableKey) {
  return _safe(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    const existing = db.get(
      `SELECT * FROM cart_recovery_orchestration_requests WHERE store_id=? AND request_id=? AND direction='outbound_wakeup'`,
      [storeId, stableKey]
    );
    if (!existing) {
      try {
        db.run(
          `INSERT INTO cart_recovery_orchestration_requests (store_id, request_id, direction, status, attempt_count, requested_at, created_at, updated_at)
           VALUES (?,?,?,?,?,?,?,?)`,
          [storeId, stableKey, 'outbound_wakeup', 'sending', 1, now, now, now]
        );
        return { claimed: true };
      } catch (e) {
        // 極短窗口內的真正並發 race：兩個呼叫同時 INSERT，其中一個會撞
        // UNIQUE constraint，視為「已經有人在處理」，安全不重複送。
        return { claimed: false, reason: 'in_progress' };
      }
    }
    if (existing.status === 'processed') {
      return { claimed: false, reason: 'already_sent_for_this_due_at' };
    }
    if (existing.status === 'sending') {
      const sentAtMs = Date.parse((existing.updated_at || existing.requested_at || '').replace(' ', 'T') + 'Z');
      if (Number.isFinite(sentAtMs) && Date.now() - sentAtMs < OUTBOUND_IN_PROGRESS_WINDOW_MS) {
        return { claimed: false, reason: 'in_progress' };
      }
      // sending 狀態卡太久（例如 process 中途崩潰），視同 failed，允許重新 claim。
    }
    // status === 'failed' 或 sending 但已超過 in-progress window → 允許 retry
    db.run(
      `UPDATE cart_recovery_orchestration_requests SET status='sending', attempt_count=attempt_count+1, updated_at=? WHERE id=?`,
      [now, existing.id]
    );
    return { claimed: true };
  }, { claimed: false, reason: 'exception' });
}
function releaseOutboundWakeUpAsFailed(db, storeId, stableKey) {
  return _safe(() => {
    const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
    db.run(
      `UPDATE cart_recovery_orchestration_requests SET status='failed', updated_at=? WHERE store_id=? AND request_id=? AND direction='outbound_wakeup'`,
      [now, storeId, stableKey]
    );
  }, undefined);
}

module.exports = {
  isOrchestrationEnabled, getWebhookUrl, getSharedSecret, hasSharedSecret,
  validateSharedSecret, SHARED_SECRET_EXPECTED_LENGTH,
  buildCanonicalString, sign, verifySignature, isTimestampFresh, TIMESTAMP_WINDOW_MS,
  toOrchestrationDueAt,
  isSafeWebhookUrl, isSafeWebhookUrlByHostname, resolveSafeWebhookTarget, isPublicIp,
  recordOrchestrationRequest, markOrchestrationRequestProcessed,
  claimOutboundWakeUp, releaseOutboundWakeUpAsFailed,
  sendWakeUp,
};
