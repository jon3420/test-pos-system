# CHANGELOG — fix18-10-hotfix6

## 問題描述

**快速搬家檔匯入後：商品管理 0 筆 / 分類管理 0 筆**

搬家檔預覽顯示 products=15, categories=9，但匯入後前端顯示無商品、無分類。
訂單 124 筆正常，分析、報表正常。

---

## 根因分析

### BUG-4：categories / products（及 discount_categories、discount_campaigns、analysis_groups）
###         有 `id INTEGER PRIMARY KEY` 跨店衝突，INSERT OR IGNORE 全部靜默略過

```
categories:  id INTEGER PRIMARY KEY AUTOINCREMENT
products:    id INTEGER PRIMARY KEY AUTOINCREMENT
```

store_001 的分類 id=1,2,...9，商品 id=1,2,...15。
store_03 匯入時，這些 id 在 DB 中**已被 store_001 的資料占用**。
`INSERT OR IGNORE` 因 PK 衝突被靜默跳過，`rowsModified=0`，
計數卻顯示「skipped」而非「failed」，導致誤判為成功。

`orders` 無此問題因為 hotfix4 已改用 `storeId + '_' + order_number` 作為 id。

---

## 修正內容

### 策略：不寫入 id，改用 (store_id, name) 判斷重複

**categories**
- INSERT 候選欄位移除 `id`，讓 AUTOINCREMENT 自動指派新 id
- 重複判斷：`SELECT id FROM categories WHERE store_id=? AND name=?`
- 建立 `catNameToId` 對照表，供 products.category_id 重新對應

**products**
- INSERT 候選欄位移除 `id`，讓 AUTOINCREMENT 自動指派新 id
- 重複判斷：`SELECT id FROM products WHERE store_id=? AND name=?`
- `category_id` 使用 `catNameToId[p.category]` 重新對應本店實際 id

**discount_categories / discount_campaigns**
- 同樣移除 `id`，以 `(store_id, name)` 判斷重複

**product_analysis_groups**
- 移除 `id`，以 `(store_id, group_name)` 判斷重複
- 建立 `groupIdRemap`：舊 group_id → 本店新 group_id

**product_analysis_group_items**
- 移除 `id`，使用 `groupIdRemap[gi.group_id]` 取新 group_id
- 用 `product_name` 查本店 `products` 取新 product_id

**product_analysis_group_aliases**
- 移除 `id`，使用 `groupIdRemap[a.group_id]` 取新 group_id

---

## 驗證

| 測試 | 預期結果 |
|------|----------|
| `SELECT COUNT(*) FROM products WHERE store_id='store_03'` | 15 |
| `SELECT COUNT(*) FROM categories WHERE store_id='store_03'` | 9 |
| `SELECT COUNT(*) FROM products WHERE store_id='store_001'` | 不減少 |
| 商品管理 store_03 | 正常顯示 15 筆 |
| 分類管理 store_03 | 正常顯示 9 筆 |
| 訂單、分析、報表 | 繼續正常 |
