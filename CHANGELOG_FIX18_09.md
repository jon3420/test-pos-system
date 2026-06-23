# fix18-09 — 補登訂單日期 ＋ 折扣成本歸類 ＋ 全分頁折扣報表

## 版本：fix18-09
## 基底：fix18-08

---

## 一、訂單日期時間可修改

- 修改訂單 Modal 新增欄位：`editOrderCreatedAt`（datetime-local）
- 位置：訂單編號下方、商品明細上方
- 儲存時更新 `orders.created_at`
- 報表依新日期重新統計（因為查詢以 `DATE(created_at)` 篩選）
- Log 記錄：`created_at_before → created_at_after`

## 二、報表金額拆分

- 統計卡新增：
  - 原價營業額（original_total）
  - 折扣總額（discount_amount）
  - 實收營業額（total）
- `calcStatsFromOrders()` 新增 `total_original`、`total_discount`、`discount_by_category`
- 向下相容：若舊訂單無 `original_total`，前後端均倒推 `total + discount_amount`

## 三、折扣分類功能

- 修改訂單 Modal 新增：
  - `editDiscountCategory`（select）
  - `editDiscountNote`（text input）
- 後端新增 `normalizeDiscountCategory()` 標準化函式
- 有折扣時分類必填（後端驗證）
- 資料庫安全 migration（不重建，不清空）：
  - `ALTER TABLE orders ADD COLUMN discount_category TEXT`
  - `ALTER TABLE orders ADD COLUMN discount_note TEXT`
  - `ALTER TABLE orders ADD COLUMN original_total REAL`

## 四、全分頁折扣統計

- `renderStatCards()` 全面升級：對所有分頁（全部、內用/外帶、外送）均顯示：
  - 原價營業額
  - 折扣總額（有折扣才顯示）
  - 實收營業額
  - 折扣支出卡片（含分類明細）
- 外送報表額外顯示平台抽成、店家實收

## 五、外送抽成計算調整

- 平台抽成改以「實收金額 total」計算（不以原價 original_total）
- `commAmount = total * commRate / 100`
- `storeIncome = total - commAmount`

## 六、修改紀錄 Log 增強

- `after_data.platform_diff` 新增：
  - `created_at_before / created_at_after`
  - `discount_category_before / discount_category_after`
  - `discount_note_before / discount_note_after`
  - `discount_amount_before / discount_amount_after`
- 訂單詳情 Modal 的 log 區塊顯示所有 diff 欄位

## 七、保留相容性

- fix18-07：`currentOrderView`、`refreshCurrentOrderView()` 完整保留
- fix18-08：平台來源修改、抽成率設定完整保留
- 舊訂單無新欄位時不報錯（`COALESCE` + 倒推邏輯）

---

## 修改檔案清單

| 檔案 | 異動說明 |
|---|---|
| `routes/orders.js` | 全面重寫：新增 migration、fix18-09 欄位支援、折扣分類驗證、created_at 修改、log 增強 |
| `public/js/app.js` | 新增 `DISCOUNT_CATEGORY_DISPLAY`、`normalizeDiscountCategory()`、更新 `calcStatsFromOrders()`、`renderStatCards()`、`openEditOrder()`、`saveEditOrder()`、`showOrderDetail()` |
| `public/index.html` | edit order modal 新增 `editOrderCreatedAt`、`editDiscountCategory`、`editDiscountNote` |
| `CHANGELOG_FIX18_09.md` | 本文件 |

## 資料庫 Migration

安全 migration（不重建資料庫，不清空 orders）：

```sql
ALTER TABLE orders ADD COLUMN original_total REAL DEFAULT 0;
ALTER TABLE orders ADD COLUMN discount_category TEXT DEFAULT 'none';
ALTER TABLE orders ADD COLUMN discount_note TEXT DEFAULT '';
```

執行時機：每次 API 請求時 `ensureFix1809Columns(db)` 自動執行，已有欄位時 catch 錯誤忽略。
