// utils/linePaymentMethods.js — H1.4.12 Phase 3A.4
//
// 「LINE 通路層級允許哪些付款代碼」的單一事實來源。這是既有一般 LINE 外帶/
// 外送（fix18-10-hotfix22A，`routes/line-orders.js` 的 `getModePaymentMethods()`）
// 已經在用、GET /shop 拿去決定要顯示哪些付款按鈕的判斷規則；popup checkout
// 的 `utils/popupCheckout.js` 現在改為呼叫**這個真正共用的函式**，不再各自
// 維護一份會漂移的規則。
//
// 語意（既有一般 LINE 通路的正式行為，不得為了配合任何其他呼叫端而改變）：
//   1. `settingKey`（例如 `takeout_payment_methods`）存在、能解析成合法 JSON，
//      且解析結果是「非空陣列」→ 直接使用該陣列，視為權威，不 fallback。
//   2. 空陣列 `[]`、空值／未設定、非法 JSON、或解析結果不是陣列 → 全部視為
//      「沒有明確設定新版陣列」，一律 fallback 到 legacy 的
//      `line_payment_*_enabled` 個別開關。
//   3. legacy 開關全部是 `'0'`（或都沒設定過）→ 回傳空陣列 `[]`，代表「這個
//      通路目前不允許任何付款方式」——呼叫端（GET /shop 的按鈕顯示、popup
//      checkout 的允許清單）都必須把空陣列當成「什麼都不允許」，不是「沒有
//      額外限制」。
//
// 輸出一律是對外 canonical 代碼：cash／linepay／transfer／platform／
// credit_card。`payment_methods` 資料表內部代碼（例如信用卡在該表是
// `card`）不在這個函式的職責範圍——那個映射只發生在真正查 `payment_methods`
// 表的那一步（`utils/popupCheckout.js` 的 `toPaymentMethodsTableCode()`）。
'use strict';

const LEGACY_FLAG_MAP = [
  ['cash', 'line_payment_cash_enabled'],
  ['linepay', 'line_payment_linepay_enabled'],
  ['transfer', 'line_payment_transfer_enabled'],
  ['platform', 'line_payment_platform_enabled'],
  ['credit_card', 'line_payment_credit_card_enabled'],
];

function getSettingValue(db, storeId, key, def = '') {
  const row = db.get('SELECT value FROM settings WHERE store_id=? AND key=?', [storeId, key]);
  return row ? row.value : def;
}

// resolveLineChannelPaymentCodes(db, storeId, settingKey)
//
// settingKey 通常是 'takeout_payment_methods' 或 'delivery_payment_methods'
// （popup 目前只使用 'takeout_payment_methods'，因為快閃訂單一律外帶）。
function resolveLineChannelPaymentCodes(db, storeId, settingKey) {
  const raw = getSettingValue(db, storeId, settingKey, '');
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.filter((c) => typeof c === 'string');
      }
    } catch (e) { /* 非法 JSON，往下 fallback legacy，不讓壞資料炸掉判斷 */ }
  }
  return LEGACY_FLAG_MAP
    .filter(([, legacyKey]) => getSettingValue(db, storeId, legacyKey, '') === '1')
    .map(([code]) => code);
}

module.exports = {
  LEGACY_FLAG_MAP,
  resolveLineChannelPaymentCodes,
};
