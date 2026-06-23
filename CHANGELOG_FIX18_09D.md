# fix18-09D — 多商品折扣綁定＋折扣活動設定頁修正

## 版本
fix18-09D（基於 fix18-09C）

## 一、折扣套用商品改為多選

### 新欄位（safe migration）
```sql
ALTER TABLE orders ADD COLUMN discount_product_ids   TEXT DEFAULT '';
ALTER TABLE orders ADD COLUMN discount_product_names TEXT DEFAULT '';
```
- `discount_product_ids`：JSON 陣列（預留，目前存商品名）
- `discount_product_names`：JSON 陣列，如 `["宜蘭鴨賞","糖醋排骨"]`
- `discount_target_type`：`order` / `products`（原 `product` 向下相容）
- `discount_product_name`：同步存多商品逗號串（向下相容欄位）

### UI 變更
- 修改訂單 Modal「折扣套用商品」選項改為：
  - 整張訂單
  - 指定商品 → 顯示本訂單商品 checkbox 清單，可複選
- 商品清單：去重後列出，顯示數量（例：宜蘭鴨賞 ×2）

## 二、訂單列表顯示多商品名稱
- 有多個折扣商品時：`📦 宜蘭鴨賞、糖醋排骨`

## 三、折扣明細 Modal 顯示多商品名稱
- 折扣商品欄：`宜蘭鴨賞、糖醋排骨`

## 四、折扣商品排行榜平均分攤
- 若折扣綁定多個商品，折扣金額平均分攤
- 例：折扣 NT$220，宜蘭鴨賞＋糖醋排骨 → 各 +NT$110

## 五、折扣活動設定頁修正（fix18-09D 主修）
- **版面重疊修正**：新增/列表不再混排
- **改用 Table 佈局**：欄位清晰（活動名稱｜說明｜狀態｜排序｜操作）
- **新增 Modal**：點「＋ 新增活動」開啟 Modal，欄位：名稱、說明、啟用、排序
- **編輯 Modal**：點「✏️ 編輯」開啟同一 Modal 預填資料
- **刪除**：確認後刪除
- 移除舊版 `prompt()` 彈窗編輯，改為 `campaignEditModal`

## 六、向下相容
- 舊 `discount_target_type = 'product'` → 自動視為 `products`
- 舊 `discount_product_name` 字串 → 用 `'、'` 分割後顯示
- 所有歷史訂單不受影響

## 七、語法驗證
```
node --check routes/orders.js            → OK
node --check routes/discount-campaigns.js → OK
node --check public/js/app.js            → OK
node --check server.js                   → OK
```
