# 付款方式 Backfill — fix16h

## 三層機制

| 層 | 位置 | 觸發時機 |
|----|------|---------|
| 1 | utils/db.js | 系統啟動，掃描所有 stores |
| 2 | routes/payment-methods.js GET / | 每次 API 請求 |
| 3 | routes/superAdmin.js POST /stores | 新增店家後 |

## db.js backfill
```js
const { ensureDefaultPaymentMethods } = require('../routes/payment-methods');
const allStores = w.all('SELECT store_id FROM stores');
allStores.forEach(({ store_id }) => ensureDefaultPaymentMethods(store_id, pmDb));
```
不限 active=1，所有 stores 都補齊。

## UNIQUE INDEX（自帶，不依賴 db.js 初始化順序）
```sql
-- 先清理重複
DELETE FROM payment_methods WHERE id NOT IN (
  SELECT MIN(id) FROM payment_methods GROUP BY store_id, code
);
-- 再建 index
CREATE UNIQUE INDEX IF NOT EXISTS idx_payment_methods_store_code
ON payment_methods(store_id, code);
```
