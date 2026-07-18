// utils/lineApiFetch.js — fix18-10-hotfix27（收尾）
//
// 呼叫 LINE 官方 API（bot/info、bot/profile、message/reply…）一律要有逾時，
// 否則 LINE 平台一時無回應、或部署環境對 api.line.me 網路不通時，會讓
// Webhook handler／Health check／測試按鈕的請求無限期卡住，拖垮整個
// process（Node 單執行緒，一個掛住的 fetch 不會讓其他請求跟著卡，但這支
// 呼叫本身的呼叫端會一直等不到回應）。統一固定 8 秒逾時。
'use strict';

const DEFAULT_TIMEOUT_MS = 8000;

async function fetchLineApi(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { fetchLineApi };
