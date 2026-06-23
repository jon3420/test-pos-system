# Payment Gateway Seed — fix16d

## seedPaymentGateways(storeId)
使用 `INSERT OR IGNORE` + `UNIQUE INDEX (store_id, code)` 防重複。
啟動 backfill 掃描所有 active stores。
POST /stores 新增店家時自動呼叫。

## UNIQUE INDEX
```sql
CREATE UNIQUE INDEX IF NOT EXISTS idx_pg_store_code ON payment_gateways(store_id, code)
```
建立前先 DELETE 重複資料（清理舊有 bug 遺留）。

## 預設值
is_active=0, mode='test', 所有 key/id 為空字串。
