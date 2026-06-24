# CHANGELOG — fix18-10-hotfix4

## 問題描述

**跨店匯入被誤判重複，導致 store_02 無資料**

- store_002 匯入訂單 JSON，畫面顯示「匯入完成：跳過 162 筆」
- store_02 訂單頁仍然 0 筆

---

## 根因分析

### BUG-1：跨店 id PK 衝突導致全部 INSERT 被靜默略過

`orders` 表結構：`id TEXT PRIMARY KEY`，預設使用 `order_number` 作為 id。

當 store_001 與 store_02 有相同 `order_number` 時：
- `INSERT OR IGNORE` 因 PK 衝突而靜默忽略
- 即使 `store_id` 不同，系統看到相同 `id` 就跳過
- 導致 store_02 匯入全部 162 筆被「跳過」，計數顯示 `skipped: 162`

**錯誤邏輯**：
```sql
-- 舊（錯誤）：依賴 INSERT OR IGNORE，但 PK 是 order_number，跨店衝突
INSERT OR IGNORE INTO orders (..., id, order_number, ...) VALUES (?, ?, ...)
-- id = order_number（例如 'ORD-001'），store_001 與 store_02 共用同一 PK → 跳過
```

**正確邏輯**：
```sql
-- 新（正確）：明確用 store_id + order_number 查重
SELECT id FROM orders WHERE store_id = ? AND order_number = ?
-- id 改為 storeId + '_' + order_number，確保跨店不衝突
INSERT OR REPLACE INTO orders (..., id, ...) VALUES (storeId + '_' + orderNo, ...)
```

### BUG-2：order_logs 寫入固定欄位 old_value/new_value，但表中無此欄位

```
SQLITE_ERROR: table order_logs has no column named old_value
```

舊程式硬寫：
```sql
INSERT OR IGNORE INTO order_logs (id, order_id, action, old_value, new_value, note, operator, created_at)
```

`order_logs` 實際欄位為 `before_data`, `after_data`（非 `old_value`, `new_value`）。

---

## 修正內容

### routes/migration.js

**一、POST /api/import/orders（訂單匯入）**
- `buildVals()` 中 `id` 改為 `storeId + '_' + order_number`，防止跨店 PK 衝突
- `INSERT OR IGNORE` 改為 `INSERT OR REPLACE`（id 已含 storeId 前綴，不影響其他店）
- copy 模式的新 order_number 也屬於本店（`buildVals({ ..., order_number: newNo }, storeId)`）

**二、POST /api/migration/import（快速搬家檔匯入）orders 區段**
- 新增 `buildOrderMap(o, storeId)` helper，`id` 使用 `storeId + '_' + order_number`
- skip 模式：`SELECT WHERE store_id=? AND order_number=?`，只跳過本店已有的資料
- overwrite 模式：`UPDATE WHERE store_id=? AND order_number=?`，只更新本店
- copy 模式：新 id 與 order_number 都屬於本店
- 本店不存在時：`INSERT OR REPLACE`（跨店 PK 不再衝突）

**三、order_logs 匯入（BUG-2）**
- 使用 `PRAGMA table_info(order_logs)` 動態取得實際欄位
- 候選欄位包含新舊版所有欄位（`old_value`/`new_value` 與 `before_data`/`after_data`）
- 只 INSERT 實際存在的欄位，防止欄位不存在錯誤

**四、所有匯入資料的 store_id 強制改為目前登入店家**
- `orders.store_id = storeId`（已覆蓋）
- `products.store_id = storeId`（已覆蓋）
- `categories.store_id = storeId`（已覆蓋）
- `discount_categories.store_id = storeId`（已覆蓋）
- `discount_campaigns.store_id = storeId`（已覆蓋）
- `product_analysis_groups.store_id = storeId`（已覆蓋）
- `product_analysis_group_items.store_id = storeId`（已覆蓋）
- `product_analysis_group_aliases.store_id = storeId`（已覆蓋）
- `settings.store_id = storeId`（已覆蓋）

---

## 驗證測試

| 測試 | 預期結果 | 狀態 |
|------|----------|------|
| store_001 匯出 → store_02 匯入（skip 模式） | store_02 新增 162 筆，不顯示跳過 | ✅ 修正 |
| 再次匯入同一檔到 store_02（skip 模式） | 第二次跳過 162 筆 | ✅ 修正 |
| `SELECT COUNT(*) FROM orders WHERE store_id='store_02'` | > 0 | ✅ 修正 |
| store_001 原本訂單不受影響 | `COUNT WHERE store_id='store_001'` 不變 | ✅ 修正 |
| order_logs 匯入不報錯 | 不再拋 old_value 欄位錯誤 | ✅ 修正 |
