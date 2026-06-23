# 付款方式初始化 — fix16

## 問題
store_001 有付款方式，store_002 等新店家沒有，導致「付款方式設定」空白。

## 修正：utils/db.js

### seedPaymentMethods(storeId) 函式
- 傳入 `storeId`，若該店已有資料則不覆蓋
- 建立：現金(啟用)、刷卡、LINE Pay、街口支付、轉帳、平台付款

### 啟動時 Backfill
```js
const allStores = w.all('SELECT store_id FROM stores WHERE active=1');
allStores.forEach(({ store_id }) => seedPaymentMethods(store_id));
// log: [DB] fix16: 付款方式 backfill 完成，共掃描 N 家店
```

### 新增店家時（superAdmin.js POST /stores）
新增後自動呼叫同一組邏輯補齊付款方式。

## 防重複
`SELECT COUNT(*) WHERE store_id=?` > 0 時跳過，不覆蓋原設定。
