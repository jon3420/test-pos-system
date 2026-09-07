// public/js/phone-utils.js — H1.4.10 PHONE-VALIDATION｜台灣手機號碼 SSOT
//
// 單一共用 pure module，供：
//   Frontend（line-order.html / line-shipping.html）：<script src="/js/phone-utils.js">
//     → window.PhoneUtils
//   Backend（routes/line-orders.js / routes/line-shipping.js）：
//     → require('../public/js/phone-utils')
// 兩端使用完全同一套規則，禁止任何一端另外撰寫 regex。
//
// 範圍：本輪只處理「台灣手機號碼」（09 開頭共 10 碼），不做多國電話系統。
// 不修改：LINE Friend Guide／member identity／n8n／Recovery／HMAC／
// checkout_click／two-stage checkout／payment flow／order total／
// delivery fee／shipping fee／既有 order IDs／analytics contracts。

'use strict';
(function (global) {

  // 台灣手機本地格式：09 開頭，共 10 碼
  var LOCAL_RE = /^09\d{8}$/;
  // 台灣手機 E.164：+886 9 開頭，共 9 碼（不含國碼的 9xxxxxxxx）
  var E164_RE = /^\+8869\d{8}$/;

  function invalidResult(reason) {
    return { valid: false, local: '', e164: '', reason: reason };
  }

  // 移除顧客常見 formatting：空白、-、(、)
  function stripFormatting(s) {
    return s.replace(/[\s\-()]/g, '');
  }

  function normalizeTaiwanMobile(input) {
    var raw = String(input == null ? '' : input).trim();

    if (!raw) return invalidResult('required');

    var cleaned = stripFormatting(raw);

    if (!cleaned) return invalidResult('required');

    // 只允許數字，或開頭一個 + 加數字
    if (!/^\+?\d+$/.test(cleaned)) return invalidResult('invalid_format');

    var local;

    if (cleaned.charAt(0) === '+') {
      if (!E164_RE.test(cleaned)) {
        // 判斷是否至少是台灣國碼但長度/前綴錯誤，reason 統一給 invalid_format，
        // 由呼叫端統一顯示同一句文案，不需要對外區分細節。
        return invalidResult('invalid_format');
      }
      // +8869xxxxxxxx → 0912345678
      local = '0' + cleaned.slice(4);
    } else {
      local = cleaned;
    }

    if (!LOCAL_RE.test(local)) {
      if (local.length !== 10) return invalidResult('invalid_length');
      if (local.slice(0, 2) !== '09') return invalidResult('invalid_prefix');
      return invalidResult('invalid_format');
    }

    var e164 = '+886' + local.slice(1);

    return { valid: true, local: local, e164: e164, reason: '' };
  }

  function validateTaiwanMobile(input) {
    return normalizeTaiwanMobile(input).valid;
  }

  // 統一錯誤文案（UI 顯示與 backend response message 共用同一句）
  var MESSAGES = {
    required: '請填寫手機號碼',
    invalid_length: '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）',
    invalid_prefix: '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）',
    invalid_format: '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）',
    default: '請輸入正確的台灣手機號碼（09 開頭，共 10 碼）'
  };

  function messageForReason(reason) {
    return MESSAGES[reason] || MESSAGES.default;
  }

  var PhoneUtils = {
    normalizeTaiwanMobile: normalizeTaiwanMobile,
    validateTaiwanMobile: validateTaiwanMobile,
    messageForReason: messageForReason
  };

  // UMD-ish export：browser (window.PhoneUtils) + CommonJS (module.exports)
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = PhoneUtils;
  }
  if (global) {
    global.PhoneUtils = PhoneUtils;
  }

})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
