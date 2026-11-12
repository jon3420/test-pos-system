// utils/linePush.js
// H1.4.10 Phase 4B — 純粹的「安全呼叫 LINE Messaging API」transport 模組。
//
// 這支模組不做任何 Recovery 狀態判斷、不做 eligibility 檢查、不知道什麼是
// cart_recovery_jobs——它唯一的職責是把 messages 陣列安全送到 LINE
// Messaging API 的 push endpoint，並把結果轉成安全（不含敏感資料）的回傳值。
// 未來 CRM campaign 的 line_push（見 utils/crmActions.js CHANNEL_AVAILABLE）
// 也應該直接 reuse 這支模組，不建立第二套 Messaging API 呼叫邏輯。
//
// 安全原則：
//   - 絕不 throw 到呼叫端（任何網路/API 錯誤都轉成 { success:false, ... }）
//   - 絕不在任何 log／回傳值／錯誤訊息中出現完整 channelAccessToken
//   - 沒有 token 就直接回 not_configured，完全不打對外網路請求

'use strict';

const { fetchLineApi } = require('./lineApiFetch');

const LINE_PUSH_ENDPOINT = 'https://api.line.me/v2/bot/message/push';

function _maskToken(token) {
  if (!token || typeof token !== 'string') return '(empty)';
  if (token.length <= 8) return '****';
  return `${token.slice(0, 4)}...${token.slice(-4)}`;
}

/**
 * sendLinePush({ channelAccessToken, lineUserId, messages })
 *
 * 回傳：
 *   { success: true,  status: <http status> }
 *   { success: false, status: 0,   error_code: 'not_configured' }   — 沒有 token，完全沒打網路
 *   { success: false, status: 0,   error_code: 'invalid_input' }    — 缺 lineUserId/messages
 *   { success: false, status: <http status>, error_code: 'line_api_error' } — LINE 官方回傳非 200
 *   { success: false, status: 0,   error_code: 'network_error' }    — fetch 本身失敗/timeout
 *
 * 絕不 throw。
 */
async function sendLinePush({ channelAccessToken, lineUserId, messages, retryKey, timeoutMs, detailed } = {}) {
  // R54.4／MBV2-HF1-C4：retryKey／timeoutMs／detailed 皆為「選用」參數。
  //   - 三者都沒有提供時（Recovery 等既有呼叫端），請求內容與回傳值與 C3.3 完全相同。
  //   - retryKey：在「第一次」請求就帶 X-Line-Retry-Key（LINE 官方：沒帶 key 的請求永遠不能安全重試）。
  //   - detailed=true（或有 retryKey）：回傳值額外帶 result_class／request_id／accepted_request_id，
  //     只保存可安全追查的 LINE 請求 ID 與分類，不回傳完整回應內容。
  const extended = !!(retryKey || detailed);
  try {
    if (!channelAccessToken || typeof channelAccessToken !== 'string' || !channelAccessToken.trim()) {
      return extended ? { success: false, status: 0, error_code: 'not_configured', result_class: 'not_configured' }
        : { success: false, status: 0, error_code: 'not_configured' };
    }
    if (!lineUserId || typeof lineUserId !== 'string' || !Array.isArray(messages) || messages.length === 0) {
      return extended ? { success: false, status: 0, error_code: 'invalid_input', result_class: 'invalid_input' }
        : { success: false, status: 0, error_code: 'invalid_input' };
    }
    if (retryKey !== undefined && retryKey !== null && !RETRY_KEY_RE.test(String(retryKey))) {
      return { success: false, status: 0, error_code: 'invalid_retry_key', result_class: 'invalid_input' };
    }

    const headers = {
      'Content-Type': 'application/json',
      // Authorization header 內含真實 token，但絕不落地到任何 log／回傳值
      // ——這裡只在記憶體中組成，函式結束後不留存。
      'Authorization': `Bearer ${channelAccessToken}`,
    };
    if (retryKey) headers['X-Line-Retry-Key'] = String(retryKey);
    const fetchArgs = [LINE_PUSH_ENDPOINT, {
      method: 'POST',
      headers,
      body: JSON.stringify({ to: lineUserId, messages }),
    }];
    if (Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0) fetchArgs.push(Number(timeoutMs));
    const res = await fetchLineApi(...fetchArgs);

    if (!extended) {
      if (res.status === 200) {
        return { success: true, status: 200 };
      }
      // 官方回傳非 200：只記安全的 status code，不解析/回傳 body（body 可能含
      // 顧客相關除錯資訊，不適合冒然存進 DB 或印到 log）。
      return { success: false, status: res.status, error_code: 'line_api_error' };
    }
    return await _classifyExtended(res);
  } catch (e) {
    // 網路錯誤／timeout／AbortError 等，全部安全吞掉，絕不 throw、絕不印出
    // e.message 以外的內容（e.message 本身也不含 token，因為 token 只出現在
    // header 物件裡，不會被序列化進錯誤訊息）。
    console.warn('[linePush] sendLinePush network error:', e && e.message);
    if (!extended) return { success: false, status: 0, error_code: 'network_error' };
    const isTimeout = !!(e && (e.name === 'AbortError' || e.name === 'TimeoutError'));
    // 逾時／連線中斷：LINE 可能「已受理但回應遺失」，不可視為確定沒送出（result_class=unknown_retryable）。
    return { success: false, status: 0, error_code: isTimeout ? 'timeout' : 'network_error', result_class: 'unknown_retryable' };
  }
}

// R54.4／MBV2-HF1-C4：官方 retry-key 規則（developers.line.biz/en/docs/messaging-api/retrying-api-request/）
//   2xx  → 已受理，不可再重試
//   409  → 同一 retry key 已受理（x-line-accepted-request-id），不可換新 key 再送
//   其他 4xx → 請求有問題，重試不會改變結果
//   5xx／逾時 → 可用「同一 retry key、同一內容」重試
// 只讀取 LINE 官方錯誤 message 的固定字串做分類，不保存 body。
const RETRY_KEY_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
function _safeHeader(res, name) {
  try {
    const v = res && res.headers && typeof res.headers.get === 'function' ? res.headers.get(name) : null;
    if (!v) return null;
    const s = String(v).trim();
    return /^[A-Za-z0-9-]{1,80}$/.test(s) ? s : null;
  } catch { return null; }
}
async function _safeMessage(res) {
  try {
    const t = await res.text();
    const j = JSON.parse(t);
    return j && typeof j.message === 'string' ? j.message.slice(0, 200) : '';
  } catch { return ''; }
}
async function _classifyExtended(res) {
  const status = Number(res.status) || 0;
  const request_id = _safeHeader(res, 'x-line-request-id');
  const accepted_request_id = _safeHeader(res, 'x-line-accepted-request-id');
  const base = { status, request_id, accepted_request_id };
  if (status >= 200 && status < 300) return { success: true, ...base, result_class: 'accepted' };
  const msg = await _safeMessage(res);
  if (status === 409) {
    if (accepted_request_id || /retry key is already accepted/i.test(msg)) {
      return { success: true, ...base, result_class: 'accepted_conflict', error_code: 'retry_key_already_accepted' };
    }
    // 409 但無法確認是 retry-key 已受理：結果不明，不可換新 key 重送
    return { success: false, ...base, result_class: 'unknown_final', error_code: 'conflict_unclassified' };
  }
  if (status === 429) {
    if (/monthly limit/i.test(msg)) return { success: false, ...base, result_class: 'quota', error_code: 'monthly_limit' };
    return { success: false, ...base, result_class: 'rate_limited', error_code: 'rate_limited' };
  }
  if (status === 401 || status === 403) return { success: false, ...base, result_class: 'auth', error_code: status === 401 ? 'unauthorized' : 'forbidden' };
  if (status >= 500) return { success: false, ...base, result_class: 'unknown_retryable', error_code: 'server_error' };
  return { success: false, ...base, result_class: 'rejected', error_code: status === 400 ? 'bad_request' : 'client_error' };
}

/**
 * 供 log／debug 使用的安全 token 摘要（絕不回傳完整 token）。
 */
function describeToken(token) {
  return _maskToken(token);
}

module.exports = { sendLinePush, describeToken, RETRY_KEY_RE };
