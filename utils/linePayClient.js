// utils/linePayClient.js
// H1.4.10 Phase 4B — LINE Pay v3 簽章／設定 primitives 的唯一 SSOT。
//
// 這支模組只放「真的與訂單來源無關」的最底層機制：讀 LINE Pay 設定、
// 官方 API base URL、HMAC-SHA256 簽章公式、POST headers。routes/linepay.js
// 既有的 POST /request（Phase 3 已凍結測試過的既有 client 下單流程）與
// utils/linePayService.js（Recovery Payment Resume 專用）都從這裡 import，
// 全專案只能有這一份簽章公式，不得各自重複定義。
//
// 這支模組完全不知道「訂單」「Recovery」「client body」是什麼，純粹是
// LINE Pay API 的通用工具函式，不做任何業務邏輯判斷。

'use strict';

const crypto = require('crypto');

function getApiBase(mode) {
  // mode='test' → sandbox；mode='live'/'prod' → 正式
  return (mode === 'live' || mode === 'prod') ? 'https://api-pay.line.me' : 'https://sandbox-api-pay.line.me';
}

// 讀 LINE Pay 設定（不過濾 is_active 供測試時也能讀，與既有行為一致）
function getLinePayConfig(db, storeId, requireActive = true) {
  const sql = requireActive
    ? "SELECT * FROM payment_gateways WHERE store_id=? AND code='linepay' AND is_active=1"
    : "SELECT * FROM payment_gateways WHERE store_id=? AND code='linepay'";
  const gw = db.get(sql, [storeId]);
  if (!gw) return null;
  return {
    channelId: (gw.merchant_id || '').trim(),   // Channel ID 存在 merchant_id
    channelSecret: (gw.secret_key || '').trim(), // Channel Secret 存在 secret_key
    mode: gw.mode || 'test',
    apiBase: getApiBase(gw.mode || 'test'),
    webhookUrl: gw.webhook_url || '',
    callbackUrl: gw.callback_url || '',
  };
}

// ══════════════════════════════════════════════════════════
// LINE Pay v3 簽章函數（精確對應官方文件）
// POST: message = channelSecret + uri + requestBodyString + nonce
// GET:  message = channelSecret + uri + queryString + nonce
// 全專案唯一一份，不得重複定義（見本檔案頂部說明與 Reality Audit）。
// ══════════════════════════════════════════════════════════
function signLinePayPost(channelSecret, uri, bodyObj, nonce) {
  const bodyStr = JSON.stringify(bodyObj);
  const message = channelSecret + uri + bodyStr + nonce;
  const signature = crypto.createHmac('sha256', channelSecret).update(message, 'utf8').digest('base64');
  // 需求文件五／六：不回傳 message（signing preimage 本身含 channelSecret，
  // 即使目前呼叫端沒有 log，也不應該把敏感值從這支 helper 帶出去）。
  return { bodyStr, signature };
}

function signLinePayGet(channelSecret, uri, queryStr, nonce) {
  const message = channelSecret + uri + queryStr + nonce;
  const signature = crypto.createHmac('sha256', channelSecret).update(message, 'utf8').digest('base64');
  return { signature };
}

function makePostHeaders(channelId, signature, nonce) {
  return {
    'Content-Type': 'application/json',
    'X-LINE-ChannelId': String(channelId),
    'X-LINE-Authorization-Nonce': String(nonce),
    'X-LINE-Authorization': signature,
  };
}

function makeGetHeaders(channelId, signature, nonce) {
  return {
    'Content-Type': 'application/json',
    'X-LINE-ChannelId': String(channelId),
    'X-LINE-Authorization-Nonce': String(nonce),
    'X-LINE-Authorization': signature,
  };
}

module.exports = {
  getApiBase, getLinePayConfig,
  signLinePayPost, signLinePayGet,
  makePostHeaders, makeGetHeaders,
};
