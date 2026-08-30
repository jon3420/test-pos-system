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
async function sendLinePush({ channelAccessToken, lineUserId, messages }) {
  try {
    if (!channelAccessToken || typeof channelAccessToken !== 'string' || !channelAccessToken.trim()) {
      return { success: false, status: 0, error_code: 'not_configured' };
    }
    if (!lineUserId || typeof lineUserId !== 'string' || !Array.isArray(messages) || messages.length === 0) {
      return { success: false, status: 0, error_code: 'invalid_input' };
    }

    const res = await fetchLineApi(LINE_PUSH_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // Authorization header 內含真實 token，但絕不落地到任何 log／回傳值
        // ——這裡只在記憶體中組成，函式結束後不留存。
        'Authorization': `Bearer ${channelAccessToken}`,
      },
      body: JSON.stringify({ to: lineUserId, messages }),
    });

    if (res.status === 200) {
      return { success: true, status: 200 };
    }
    // 官方回傳非 200：只記安全的 status code，不解析/回傳 body（body 可能含
    // 顧客相關除錯資訊，不適合冒然存進 DB 或印到 log）。
    return { success: false, status: res.status, error_code: 'line_api_error' };
  } catch (e) {
    // 網路錯誤／timeout／AbortError 等，全部安全吞掉，絕不 throw、絕不印出
    // e.message 以外的內容（e.message 本身也不含 token，因為 token 只出現在
    // header 物件裡，不會被序列化進錯誤訊息）。
    console.warn('[linePush] sendLinePush network error:', e.message);
    return { success: false, status: 0, error_code: 'network_error' };
  }
}

/**
 * 供 log／debug 使用的安全 token 摘要（絕不回傳完整 token）。
 */
function describeToken(token) {
  return _maskToken(token);
}

module.exports = { sendLinePush, describeToken };
