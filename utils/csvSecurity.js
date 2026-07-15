// utils/csvSecurity.js — fix18-10-hotfix23-E1
//
// CSV Formula Injection（公式注入）防護。
// 套用於任何會被 Excel / Numbers / Google Sheets 開啟的 CSV 匯出欄位。

'use strict';

// 會被試算表軟體解讀成公式/指令起始字元的字元
const FORMULA_TRIGGER_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * sanitizeCsvCell(value)
 *
 * 1. null/undefined → ''
 * 2. 轉字串
 * 3. 移除危險控制字元（保留一般可列印字元、中文、emoji、換行）
 * 4. trimStart 後第一個字元若為公式觸發字元 → 前面加單引號 '
 * 5. 進行 CSV escaping（雙引號雙寫、整格包雙引號）
 *
 * @param {*} value
 * @returns {string} 已完成 escaping、可直接放入 CSV 的字串（含外層雙引號）
 */
function sanitizeCsvCell(value) {
  if (value === null || value === undefined) return '""';

  let str = String(value);

  // 移除控制字元（保留 \n \r \t 讓後續公式判斷邏輯處理，其餘控制字元移除）
  // eslint-disable-next-line no-control-regex
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');

  const trimmed = str.replace(/^[\s]+/, ''); // 對齊 trimStart，但不改動原字串其餘空白
  const leadIndex = str.length - trimmed.length;
  const firstChar = trimmed.charAt(0);

  if (firstChar && FORMULA_TRIGGER_CHARS.has(firstChar)) {
    str = str.slice(0, leadIndex) + "'" + str.slice(leadIndex);
  }

  // CSV escaping：雙引號改成兩個雙引號，整格包雙引號
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

module.exports = { sanitizeCsvCell };
