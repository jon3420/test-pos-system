# Store Isolation Design — R1

## 原則

每筆資料都帶 `store_id`，所有 API 必須依 store_id 查詢。

---

## 已隔離資料表

| 資料表 | store_id 欄位 | Migration |
|--------|--------------|-----------|
| products | ✅ | 所有舊資料補 store_001 |
| categories | ✅ | 所有舊資料補 store_001 |
| orders | ✅ | 所有舊資料補 store_001 |
| order_logs | ✅ | 預設 store_001 |
| settings | ✅ | (store_id, key) UNIQUE |
| inventory_logs | ✅ | 預設 store_001 |
| ingredients | ✅ | 預設 store_001 |
| customers | ✅ | 預設 store_001 |
| payment_methods | ✅ | 預設 store_001 |
| payment_gateways | ✅ | 預設 store_001 |
| delivery_platforms | ✅ | 預設 store_001 |
| devices | ✅ | 預設 store_001 |

## 共用資料表（跨店，不隔離）

| 資料表 | 說明 |
|--------|------|
| stores | 店家總表（Super Admin 管理）|
| super_admins | 總控台帳號 |
| licenses | Android 授權（保持原有相容）|
| ingredient_batches | 食材批次（跟隨 ingredient）|
| ingredient_logs | 食材異動（跟隨 ingredient）|
| product_ingredient_formulas | 扣料公式（跟隨 product）|
| ingredient_thaw_batches | 解凍批次（跟隨 ingredient）|

---

## API 隔離方式

```javascript
// 所有 API 路由前套用 requireStore middleware
app.use('/api/products', requireStore, require('./routes/products'));

// Route 內部強制帶入 store_id
const storeId = req.storeId || 'store_001';
db.all('SELECT * FROM products WHERE store_id=?', [storeId]);
```

---

## 錯誤防護

- GET /:id：加上 `AND store_id=?` 確保跨店不可存取
- PUT /:id：加上 `AND store_id=?` 確保只能改自己的資料
- DELETE /:id：加上 `AND store_id=?` 確保只能刪自己的資料

