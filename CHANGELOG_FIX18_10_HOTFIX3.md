# fix18-10-hotfix3

## 修正項目（逐一驗證）

### RC-1：訂單匯入顯示「新增 162 筆」但訂單頁空白

**根因**
- `orders.created_at` 保留備份原始日期（舊日期如 2026-01-15）
- `GET /api/orders` 預設 `DATE(created_at) = today`（台北時間）
- 舊日期訂單完全不在今日範圍 → 頁面看到 0 筆
- INSERT 本身是成功的，資料確實寫入 DB

**修正**
- `POST /api/import/orders` 回傳 `date_range: { min, max }` — 備份的最早/最晚日期
- 前端 `doOrderImport()` 收到後顯示藍色提示框：
  「訂單已匯入，請切換至自訂日期範圍 2026-01-15 ～ 2026-02-10 查看」

### RC-2：快速搬家檔匯出 — 折扣分類/活動顯示 0

**根因**
- `discount_categories` / `discount_campaigns` 兩張表**不在 `db.js` 初始化**
- 只在各自 route handler 的 `ensureTable()` 中建立（on-demand）
- 若 `/api/discount-categories` 從未被呼叫過，表格不存在
- `safeAll()` 捕獲 `no such table` 錯誤並靜默回傳 `[]`

**修正**
- `migration/export` 和 `migration/import` 開頭各加：
  ```js
  try { ensureDiscountCategoriesTable(db); } catch {}
  try { ensureDiscountCampaignsTable(db); } catch {}
  ```
- 確保查詢前表格必定存在

### RC-3：成功計數不準確

**根因**
- `INSERT OR IGNORE` 若記錄已存在 → 不寫入但不拋錯，`results.xxx++` 仍計數
- 顯示「新增 162 筆」但實際是「插入被忽略 162 次」

**修正**
- 改用 `rawRunCount(raw, sql, params)` 回傳 `raw.getRowsModified()`
- 只有實際寫入（`getRowsModified > 0`）才 `added++`，否則 `skipped++`

### RC-4：PRAGMA 動態欄位過濾

**修正**
- `import/orders` 和 `migration/import` 的 orders 段落改用：
  ```js
  const validCols = getTableCols(db, 'orders');  // PRAGMA table_info
  const importCols = [...].filter(c => validCols.has(c));
  ```
- 防止未來欄位缺失導致整批 INSERT 失敗

## 測試結果（sql.js 單元測試）

| 測試 | 結果 |
|---|---|
| discount_categories 匯出 1 筆 | ✅ |
| discount_campaigns 匯出 1 筆 | ✅ |
| analysis_groups/items/aliases 匯出 1 筆 | ✅ |
| 162 筆訂單匯入 store_02，store_id 正確為 store_02 | ✅ |
| date_range 回傳正確範圍 | ✅ |
| 重複單號 skip：added=0 skipped=1 | ✅ |
| discount_categories 匯入 store_02 | ✅ |
| store_001 資料不受影響 | ✅ |
| COMMIT 成功（無 cannot commit 錯誤） | ✅ |
