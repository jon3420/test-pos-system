# CHANGELOG — fix18-10-hotfix11

## 問題根本原因（已實測驗證）

### 1. INSERT OR IGNORE 靜默跳過仍 added++（假成功）
- `routes/importExport.js` → `POST /import/ingredients`
- 原本：`db.run("INSERT OR IGNORE ...")` 後直接 `added++`
- 問題：UNIQUE 衝突時 `changes=0` 但 `added` 還是加 1
- 修正：改用 `INSERT`（去掉 OR IGNORE），檢查 `ins.lastInsertRowid` 和 `ins.changes`
  - changes=0 → `skipped++` 並記錯誤訊息，不假報成功

### 2. req.storeId || 'store_001' fallback 全面移除
- 影響範圍：routes/ 下所有檔案（ingredients, importExport, migration, products, orders, categories 等）
- 問題：若 storeGuard 未設 req.storeId，資料靜默寫入 store_001
- 修正：所有 `req.storeId || 'store_001'` 改為 `req.storeId`（無 fallback）
- importExport.js 食材匯入加 guard：storeId 為 null 直接 401

### 3. 加入驗證 log（必查）
- 每筆 INSERT/UPDATE 後印 `[ingredients/import] { storeId, name, changes, insertedId, action }`
- 匯入完成後立即查：
  - `SELECT store_id, COUNT(*) FROM ingredients GROUP BY store_id`
  - `SELECT id, store_id, name FROM ingredients WHERE store_id=? ORDER BY id DESC LIMIT 20`

## 實測結果

### 食材 CSV 匯入（store_002, 11 筆）
```
POST /api/import/ingredients → { success: true, added: 11, updated: 0, failed: 0, errors: [] }
[ingredients/import] GROUP BY store_id: [{ store_id: 'store_002', c: 11 }]
SELECT COUNT(*) FROM ingredients WHERE store_id='store_002' → 11 ✅
GET /api/ingredients → 11 rows ✅
```

### 扣料公式匯入（13 筆）
```
POST /api/import/ingredient-formulas → { success: true, added: 13 }
GET /api/ingredients/formulas/all → 13 rows ✅
```

### Restore（store_001 → store_002, replace mode）
```
ingredients: { added: 11, skipped: 0, failed: 0 }
formulas:    { added: 13, skipped: 0, failed: 0 }
SELECT COUNT(*) FROM ingredients WHERE store_id='store_002' → 11 ✅
SELECT COUNT(*) FROM product_ingredient_formulas → 13 ✅
GET /api/ingredients = 11 ✅
GET /formulas/all = 13 ✅
```

## 修改檔案清單
- `routes/importExport.js` — 食材匯入邏輯修正 + 全路由移除 fallback
- `routes/ingredients.js` — 全路由移除 fallback
- `middleware/featureGate.js` — 移除 fallback
- `routes/migration.js` — 移除 fallback
- `routes/products.js` — 移除 fallback
- `routes/categories.js` — 移除 fallback
- `routes/orders.js` — order.store_id fallback 改為 null
- `routes/line-orders.js` — 移除 fallback
- `routes/discount-campaigns.js` — 移除 fallback
- `routes/discount-categories.js` — 移除 fallback
- `routes/kitchen.js` — 移除 fallback
- `routes/dashboard.js` — 移除 fallback
- `routes/inventory.js` — 移除 fallback
- `routes/sync.js` — 移除 fallback
- `routes/platforms.js` — 移除 fallback
- `routes/customers.js` — 移除 fallback
- `routes/print.js` — 移除 fallback
- `routes/printJobs.js` — 移除 fallback
- `routes/product-analysis-groups.js` — 移除 fallback
- `routes/payment-gateways.js` — 移除 fallback
- `routes/delivery.js` — 移除 fallback
- `routes/settings.js` — 移除 fallback
- `routes/coupons.js` — 移除 fallback
- `routes/online-orders.js` — 移除 fallback
- `routes/linepay.js` — webhook callback fallback 改為 null（原為 store_001）
