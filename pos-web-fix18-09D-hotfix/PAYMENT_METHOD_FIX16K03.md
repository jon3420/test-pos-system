# fix16k-03 — payment-methods debug + seed 根本修正

## 問題確認
/api/payment-methods/debug 回傳 rows=0，代表 store_02 付款方式 seed 未成功持久化。

## 根本原因
舊版 `ensureDefaultPaymentMethods` 中：
- DELETE 空 code 記錄用 `db._db.run(sql, params)` — 繞過 wrapper，不保證 _save()
- INSERT 用 `db._db.run(insertSql, vals)` — 同上，不保證 _save()
- debug endpoint 完全沒有執行 seed，只有 SELECT

## 修正（payment-methods.js fix16k-03）

### 1. ensureDefaultPaymentMethods
- DELETE、INSERT 全部改用 `db.run()` wrapper（prepare+bind+save）
- 回傳 `{ inserted, skipped }` 供 debug 使用

### 2. ensurePaymentMethodsSchema
- code backfill 改用 `db.run()` wrapper

### 3. GET /api/payment-methods/debug
- 先執行 ensurePaymentMethodsSchema + ensureDefaultPaymentMethods
- seed 後才 SELECT rows
- 回傳增加：seedResult / allRows / storeCounts

### 4. GET /api/payment-methods
- 確保 ensure schema → seed → SELECT 全流程
- 0 筆時回傳 storeCounts debug 資訊

## 測試標準（全通過）
- store_02 debug 回傳 seedResult.inserted=6, rows=6
- 重啟後所有店家自動補齊 6 筆
- 冪等：重複 seed 不重複插入（skipped=6）
