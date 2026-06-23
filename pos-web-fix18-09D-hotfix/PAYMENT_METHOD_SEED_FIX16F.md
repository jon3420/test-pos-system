# 付款方式初始化 — fix16f

## 三層保護
1. **db.js UNIQUE INDEX** — `CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code ON payment_methods(store_id, code)`
2. **db.js seedPaymentMethods()** — `INSERT OR IGNORE`，可重複呼叫
3. **payment-methods.js API 防呆** — GET 時若無資料自動補齊

## 結果
store_001 / store_002 / 任何新店：6 筆付款方式（現金啟用，其他停用），不重複不覆蓋。
