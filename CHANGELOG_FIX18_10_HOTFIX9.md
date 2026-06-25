# CHANGELOG — fix18-10-hotfix9

## 版本：fix18-10-hotfix9
## 輸出：pos-web-fix18-10-hotfix9-full.zip

---

## 任務目標

升級快速搬家（Backup / Restore）為完整版本，支援食材庫存、商品扣料公式、及所有店家營運資料。

---

## 第一階段：資料表分析結果

### 真正使用的資料表（掃描 routes/ utils/ 確認）

| 資料表 | 用途 | 有 store_id | 原備份 | 原還原 | hotfix9 |
|--------|------|-------------|--------|--------|---------|
| products | 商品（含 inventory_enabled, line_quota_* 等） | ✅ | ✅ | ✅ | ✅ 補 line_quota |
| categories | 分類 | ✅ | ✅ | ✅ | ✅ |
| orders | 訂單 | ✅ | ✅ | ✅ | ✅ |
| order_logs | 訂單異動紀錄 | ✅ | ✅ | ✅ | ✅ |
| ingredients | 食材主表 | ✅ | ❌ | ❌ | ✅ 新增 |
| product_ingredient_formulas | 商品扣料公式 | ❌（透過 product_id） | ❌ | ❌ | ✅ 新增 |
| ingredient_logs | 食材異動紀錄 | ❌（透過 ingredient_id） | ❌ | ❌ | ✅ 新增 |
| ingredient_batches | 批號管理 | ❌（透過 ingredient_id） | ❌ | ❌ | ✅ 新增 |
| ingredient_thaw_batches | 解凍批次 | ❌（透過 ingredient_id） | ❌ | ❌ | ✅ 新增 |
| inventory_logs | 庫存變動紀錄 | ✅ | ❌（舊版只有 inventory 欄位） | ❌ | ✅ 新增 |
| discount_categories | 折扣分類 | ✅ | ✅ | ✅ | ✅ |
| discount_campaigns | 折扣活動 | ✅ | ✅ | ✅ | ✅ |
| product_analysis_groups | 商品分析群組 | ✅ | ✅ | ✅ | ✅ |
| product_analysis_group_items | 群組成員 | ✅ | ✅ | ✅ | ✅ |
| product_analysis_group_aliases | 歷史別名 | ✅ | ✅ | ✅ | ✅ |
| settings | 設定 | ✅ | ✅ | ✅ | ✅ |
| delivery_platforms | 外送平台 | ✅ | ✅ | ✅ | ✅ |
| delivery_fees | 外送費率 | ✅ | ✅ | ✅ | ✅ |

### 注意：inventory 不是獨立資料表
`inventory` 功能是從 `products` 表讀取（`inventory_enabled`, `current_stock_grams`, `allocated_grams`, `low_stock_alert` 欄位）。
products 已完整備份，因此商品庫存設定已涵蓋。

### LINE 商品份數設定
`line_quota_*`, `line_sell_start`, `line_sell_end` 欄位存在於 `products` 表中（已有備份），
hotfix9 在 Restore 時補充這些欄位的 remap。

---

## 第二階段：Backup 新增完整營運資料

修改 `routes/migration.js`：

新增匯出欄位（Backup JSON `data` 新增）：
- `ingredients` — 食材主表
- `product_ingredient_formulas` — 商品扣料公式（含 product_name, ingredient_name 冗餘欄位）
- `ingredient_logs` — 食材異動紀錄（限最近 5000 筆/食材）
- `ingredient_batches` — 批號管理
- `ingredient_thaw_batches` — 解凍批次
- `inventory_logs` — 庫存變動紀錄

所有資料表均透過 `tableExists()` 保護：不存在時 warn 並略過，不報錯。

products 匯出補齊 `line_quota_*`, `line_sell_start`, `line_sell_end` 欄位至 `line_products` 清單。

---

## 第三階段：Restore 支援完整營運資料

### ID remap 流程

```
1. categories 先匯入 → catNameToId（category name → new id）
2. products 匯入，category_id 依 catNameToId remap
   → prodNameToId（product name → new id）
3. ingredients 匯入 → ingredientIdRemap（old id → new id）
4. product_ingredient_formulas 匯入：
   - product_id：先查 products WHERE name=product_name，再 fallback prodNameToId
   - ingredient_id：先查 ingredientIdRemap，再查 ingredients WHERE name=ingredient_name
5. ingredient_logs / ingredient_batches / ingredient_thaw_batches：
   依 ingredientIdRemap 重建 ingredient_id
6. inventory_logs：
   product_id 依 prodNameToId remap（product_name 為 key）
```

### 去重邏輯（Merge 模式）

| 資料表 | 去重 key |
|--------|---------|
| ingredients | (store_id, name) |
| product_ingredient_formulas | (product_id, ingredient_id) — 均已 remap |
| ingredient_logs | 不判重，直接 INSERT OR IGNORE |
| ingredient_batches | INSERT OR IGNORE |
| ingredient_thaw_batches | INSERT OR IGNORE |
| inventory_logs | INSERT OR IGNORE |

---

## 第四階段：Replace 模式

Replace 模式清表時，所有可能不存在的資料表均透過 `safeRawDelete()` 保護：
- 存在才 DELETE
- 不存在只 warn，不 rollback

新增清表資料表（Replace 模式）：
- `ingredients`（有 store_id，直接 DELETE WHERE store_id=?）
- `ingredient_logs`（無 store_id，先取本店 ingredient ids，再 DELETE WHERE ingredient_id IN (...)）
- `ingredient_batches`（同上）
- `ingredient_thaw_batches`（同上）
- `product_ingredient_formulas`（無 store_id，先取本店 product ids，再 DELETE WHERE product_id IN (...)）
- `inventory_logs`（有 store_id，直接 DELETE WHERE store_id=?）

---

## 第五階段：Merge 模式

保持既有 Merge 邏輯（INSERT OR IGNORE + store_id+name 判重）。
食材以 (store_id, name) 判重，不因跨店 PK 衝突而 skip。
扣料公式以 (remapped_product_id, remapped_ingredient_id) 判重。

---

## 第六階段：Backup 預覽

Preview 畫面新增統計：
- 食材：N 筆
- 商品扣料公式：N 筆
- 食材異動紀錄：N 筆
- 庫存變動紀錄：N 筆

---

## 第七階段：Restore 驗證檢查項目

Restore 完成後請驗證：
1. 庫存 → 食材庫存 / 備料管理：所有食材正常顯示
2. 商品扣料公式：所有公式存在，ingredient_id 正確對應
3. 商品庫存：inventory_enabled / current_stock_grams 正常
4. LINE 商品管理：line_quota_*, line_sell_start/end, sale_status 正常

---

## 第八階段：舊版相容

舊版 Backup（無 ingredients / ingredient_logs 等欄位）Restore 時：
- `d.ingredients` 為 undefined → `(d.ingredients||[])` = [] → 直接略過
- 不報錯，不 rollback

---

## 修改檔案列表

- `routes/migration.js` — 核心修改（Backup + Restore + Preview）
- `public/js/app.js` — Preview 顯示 / 匯入結果顯示
- `package.json` — 版本更新 18.1.9
- `CHANGELOG_FIX18_10_HOTFIX9.md` — 本文件

---

## 驗證清單

✅ 食材可完整搬家（ingredients + ID remap）
✅ 商品扣料公式可完整搬家（product_ingredient_formulas + product_id/ingredient_id remap）
✅ 食材異動紀錄可搬家（ingredient_logs + ingredient_id remap）
✅ 批號 / 解凍批次可搬家
✅ 庫存變動紀錄可搬家（inventory_logs + product_id remap）
✅ 商品庫存設定可搬家（products.inventory_enabled 等欄位已包含）
✅ LINE 商品份數設定可搬家（products.line_quota_* 欄位已包含）
✅ 舊版 Backup 可正常 Restore（缺少欄位直接略過）
✅ Replace 不會因缺少 ingredient 資料表而失敗（safeRawDelete 保護）
✅ 跨店搬家不因 INTEGER PRIMARY KEY 衝突導致資料消失（name 判重 + remap）
✅ 不影響既有商店資料（只清 WHERE store_id=? 本店）
✅ 正式 ZIP 不包含 data/pos.db、*.db、*.sqlite、node_modules（build-release.sh 保護）
