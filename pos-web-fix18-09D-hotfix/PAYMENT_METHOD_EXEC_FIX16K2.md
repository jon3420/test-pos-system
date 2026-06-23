# PAYMENT_METHOD_EXEC_FIX16K2 — 根本修正 v2

## 問題根因

`ensureDefaultPaymentMethods()` 在 `payment-methods.js` 第 140 行使用：

```js
const existing = db._db.exec(checkSql, [storeId, code]);
```

**`sql.js` 的 `db.exec()` 方法不支援帶參數 (params) 呼叫。**
它只接受靜態 SQL 字串，傳入 `[storeId, code]` 會被忽略或拋錯。

結果：
- `existing` 永遠是 `undefined` 或 `[]`
- `exists` 永遠是 `false`
- 6 筆 DEFAULT_PM 都嘗試 INSERT
- 但 `db._db.run(insertSql, vals)` 也是直接呼叫底層，若 UNIQUE INDEX 存在會拋錯，若不存在則重複插入
- 新建店家（如 store_02）在 GET `/api/payment-methods` 時 seed 不穩定，最終 0 筆 → 500 錯誤

## 修正

**`routes/payment-methods.js`：**

| 位置 | 修改前 | 修改後 |
|------|--------|--------|
| checkSql 查詢 | `db._db.exec(checkSql, [storeId, code])` | `db.get(checkSql, [storeId, code])` |
| INSERT 執行 | `db._db.run(insertSql, vals)` | `db.run(insertSql, vals)` |

統一使用 wrapper 介面（`db.get`、`db.run`），正確執行 `prepare + bind`。

## 影響範圍

- 新建店家第一次進入「付款方式」設定頁，不再出現「初始化失敗」錯誤
- 結帳頁面付款選項（現金、刷卡等）正確顯示
- store_001（既有店家）不受影響（已有資料，skip 邏輯依然正確）
