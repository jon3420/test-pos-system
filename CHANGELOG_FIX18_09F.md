# fix18-09F — 商品分析群組 + 老闆報表統計

## 核心原則
- 不修改訂單原始商品名稱
- 報表分析可將多個商品歸類至同一群組統計
- 未設群組的商品維持原始名稱顯示

## 新功能

### 1. 設定中心 → 📊 商品分析群組
- 新增 Tab：`商品分析群組`
- 支援：新增群組、編輯群組、刪除群組、啟用/停用、排序
- 群組內可勾選任意多個商品（支援搜尋過濾、全選/取消全選）

### 2. 資料庫新表（safe migration，不影響現有資料）
- `product_analysis_groups`：群組主表
- `product_analysis_group_items`：群組成員（商品名稱對應）

### 3. 後端 API
- `GET /api/product-analysis-groups` — 取得所有群組（含成員）
- `POST /api/product-analysis-groups` — 新增群組
- `PUT /api/product-analysis-groups/:id` — 更新群組
- `PATCH /api/product-analysis-groups/:id/toggle` — 切換啟用
- `DELETE /api/product-analysis-groups/:id` — 刪除群組

### 4. 訂單列表商品群組標籤
- 商品下方顯示：`📊 群組：冷拌麻油腰子`
- 可在 **👁 顯示設定** → `商品分析群組標籤` 開關

### 5. 統計模式切換（商品群組 / 原始商品）
- 支援位置：熱賣商品卡、折扣商品排行卡、老闆儀表板熱銷排行
- 預設模式：商品群組
- 設定持久化（localStorage）

### 6. 老闆儀表板新增
- 📊 商品群組排行 TOP10（群組模式下自動顯示）

### 7. 相容性
- fix18-07 分頁停留 ✅
- fix18-08 平台來源修改 ✅
- fix18-09 日期補登 ✅
- fix18-09B 折扣追蹤 ✅
- fix18-09C 折扣活動 ✅
- fix18-09D 多商品折扣 ✅
- fix18-09E 折扣分類與卡片顯示設定 ✅
