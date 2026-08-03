// utils/ga4Realtime/errors.js — fix18-10-hotfix30-B5-R5.4-G1.5-A
// GA4 Realtime — 錯誤分類（純函式，不含網路/DB 存取，方便單元測試）。

'use strict';

// 可重試的錯誤代碼（HTTP 狀態碼字串化，或已知的網路層錯誤 code）。
const RETRYABLE_CODES = Object.freeze(['429', '500', '502', '503', '504', 'ETIMEDOUT', 'ECONNRESET', 'TIMEOUT']);
// 明確禁止重試（設定/憑證/請求本身錯誤，重試沒有意義）。
const NON_RETRYABLE_CODES = Object.freeze(['400', '401', '403', '404', 'INVALID_CREDENTIALS', 'INVALID_PROPERTY', 'INVALID_STREAM']);

// classifyGa4RealtimeError(err) → 安全、去識別化的錯誤代碼字串。
// 絕不把完整例外物件（可能含 request/response 細節）往上層暴露；呼叫端只
// 應該使用這個函式回傳的 code，不應該再檢查 err 本身的其他欄位。
function classifyGa4RealtimeError(err) {
  if (!err) return 'UNKNOWN_ERROR';
  if (err.code === 'TIMEOUT' || err.message === 'TIMEOUT') return 'TIMEOUT';
  // Google API Node client 慣例：err.code 是數字 gRPC/HTTP 狀態碼，
  // 也可能出現在 err.status 或 err.response?.status（REST fallback）。
  const rawCode = err.code ?? err.status ?? (err.response && err.response.status);
  if (rawCode !== undefined && rawCode !== null) {
    const s = String(rawCode);
    if (RETRYABLE_CODES.includes(s)) return s;
    if (NON_RETRYABLE_CODES.includes(s)) return s;
  }
  const msg = String(err.message || '').toUpperCase();
  if (msg.includes('ETIMEDOUT')) return 'ETIMEDOUT';
  if (msg.includes('ECONNRESET')) return 'ECONNRESET';
  if (msg.includes('PERMISSION') || msg.includes('UNAUTHENTICATED') || msg.includes('401')) return '401';
  if (msg.includes('FORBIDDEN') || msg.includes('403')) return '403';
  if (msg.includes('NOT FOUND') || msg.includes('404')) return '404';
  if (msg.includes('INVALID') && msg.includes('CREDENTIAL')) return 'INVALID_CREDENTIALS';
  return 'GA4_API_ERROR';
}

// isRetryableGa4Error(code) → boolean。未知代碼一律視為不可重試（保守：
// 不確定是否安全重試時，不重試比較安全，避免對設定錯誤無限重打 API）。
function isRetryableGa4Error(code) {
  return RETRYABLE_CODES.includes(String(code));
}

module.exports = {
  RETRYABLE_CODES,
  NON_RETRYABLE_CODES,
  classifyGa4RealtimeError,
  isRetryableGa4Error,
};
