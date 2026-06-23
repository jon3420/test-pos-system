# PAYMENT_METHOD_TABLE_REBUILD_FIX16K04

## 重建流程（`rebuildPaymentMethodsTable`）

SQLite 不支援 DROP CONSTRAINT，因此採用安全重建方式：

```
1. CREATE TABLE payment_methods_new (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     store_id TEXT NOT NULL,
     name TEXT NOT NULL,
     code TEXT NOT NULL,
     -- ... 其他欄位
     -- 注意：code 無 UNIQUE，name 無 UNIQUE
   )

2. INSERT INTO payment_methods_new (...)
   SELECT ... FROM payment_methods
   WHERE id IN (
     SELECT MIN(id) FROM payment_methods GROUP BY store_id, code
   )
   -- 去重：同 store_id + code 只保留最早那筆

3. DROP TABLE payment_methods

4. ALTER TABLE payment_methods_new RENAME TO payment_methods

5. CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
   ON payment_methods(store_id, code)
```

## 安全性保證

- `IF NOT EXISTS`：重複執行不會 crash
- `MIN(id)` 去重：保留既有資料，不遺失
- 只在偵測到壞 constraint 時才重建（正常 DB 不觸發）
- 重建後立即 `_save()` 持久化

## 執行時機

1. **伺服器啟動**：`initTables` → `ensurePaymentMethodsSchema` → `ensureDefaultPaymentMethods`（逐店）
2. **每次 GET /api/payment-methods**：on-demand seed
3. **每次 GET /api/payment-methods/debug**：顯示 detection + seedResult

## 測試標準（全通過）

| 場景 | 描述 | 結果 |
|------|------|------|
| A | `code TEXT UNIQUE`（table DDL） | ✅ 重建 + 6筆/店 |
| B | `CREATE UNIQUE INDEX ON (code)` | ✅ 重建 + 6筆/店 |
| C | 正確 `UNIQUE(store_id, code)` | ✅ 不重建 + 6筆/店 |
| D | 全新 DB | ✅ 直接 seed 6筆/店 |
