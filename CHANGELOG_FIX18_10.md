# fix18-10 — 快速搬家檔 + 訂單/LINE預購 匯出匯入系統

## 新增功能

### 後端 routes/migration.js

| API | 功能 |
|-----|------|
| GET /api/export/orders | 匯出訂單（JSON 含 order_items/order_logs，或 CSV）|
| POST /api/import/orders | 匯入訂單（skip / overwrite / copy）|
| GET /api/export/preorders | 匯出 LINE 預購（JSON/CSV）|
| POST /api/import/preorders | 匯入 LINE 預購（skip / overwrite / copy）|
| GET /api/migration/export | 下載完整快速搬家檔 JSON |
| POST /api/migration/import/preview | 預覽搬家檔筆數，不寫入 DB |
| POST /api/migration/import | 實際匯入（skip / overwrite / replace）|

### 匯出內容（快速搬家檔）
- products, categories
- orders, order_items, order_logs
- LINE 預購（orders WHERE source='line'）
- line_products（LINE 商品設定摘要）
- inventory
- discount_categories, discount_campaigns
- product_analysis_groups, _items, _aliases
- delivery_platforms, delivery_fees
- settings

### 安全機制
- 所有匯出/匯入均限制 store_id，不可跨店
- replace 模式僅清空目前 store_id，禁止影響其他店家
- 所有寫入使用 SQLite transaction，失敗自動 rollback
- 跨店匯入需 allowCrossStoreImport=true（前端預設警告）

### 前端
- 訂單紀錄頁：右上角新增「📤 匯出訂單」「📥 匯入訂單」按鈕
- LINE 預購管理頁：右上角新增「📤 匯出預購」「📥 匯入預購」按鈕
- 系統設定 → 新增「📦 資料備份/搬家」分頁
- replace 模式需輸入「確認還原」二次確認

### migration_logs 資料表
記錄所有匯出/匯入操作，欄位：id, store_id, action, file_name, mode, summary_json, status, error_message, created_at

## 相容性
不破壞 fix18-07 ~ fix18-09F-hotfix4 所有功能
