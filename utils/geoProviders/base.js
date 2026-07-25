// utils/geoProviders/base.js — fix18-10-hotfix30-B5-R5.1-D
// 共用工具：Provider 統一逾時包裝。任何 Provider adapter 都應該用這支包住
// 自己的網路呼叫，確保逾時一律拋出可辨識的 'TIMEOUT' 訊息（供上層轉成
// code: 'TIMEOUT'），不依賴各 adapter 自己實作逾時邏輯（容易漏改／不一致）。

'use strict';

function withTimeout(promise, ms) {
  let timer = null;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('TIMEOUT')), Math.max(1, Number(ms) || 2500));
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Provider adapter 標準失敗結果建構器，統一格式，避免各 adapter 各自拼欄位。
function providerError(providerName, code, message) {
  return { ok: false, provider: providerName, code, message: message || code };
}

module.exports = { withTimeout, providerError };
