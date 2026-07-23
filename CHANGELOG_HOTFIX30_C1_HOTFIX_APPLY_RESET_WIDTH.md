# fix18-10-hotfix30-C1-hotfix｜LINE 商品管理－販售時間功能完善

## 1. 版本資訊

- **基礎版本**：`fix18-10-hotfix30-C1`（`CHANGELOG_HOTFIX30_C1_PRODUCT_SALE_WINDOWS.md`）
- **本次性質**：Hotfix（不新增資料庫欄位、不變更後端 API 行為，僅前端 UI / JS 修正）
- **修改檔案**：
  - `public/index.html`
  - `public/js/app.js`
  - `public/css/main.css`

## 2. 修正內容

### 2.1 「💾 套用今日設定」納入外帶／外送販售時間

- 修改前：`lpmApplyAll()`（今日販售管理主按鈕）只送出
  `line_quota_enabled` / `line_quota_daily` / `line_quota_low_threshold` /
  `line_quota_high_threshold`，外帶／外送販售時間欄位必須另外按各自的
  「套用至勾選商品」按鈕才會生效。
- 修改後：`lpmApplyAll()` 會一併讀取 `#lpm-to-sell-start` / `#lpm-to-sell-end` /
  `#lpm-dl-sell-start` / `#lpm-dl-sell-end` 目前的輸入值，與今日開放份數／門檻
  一起寫入所有勾選商品（PATCH body 新增
  `line_takeout_sell_start` / `line_takeout_sell_end` /
  `line_delivery_sell_start` / `line_delivery_sell_end`）。空字串代表「不限
  販售時間」，交由既有後端邏輯清空對應欄位（`routes/products.js` 的
  `add()` 慣例：欄位值為 `''` 時仍會寫入，`undefined` 才會跳過，本次未變更
  後端一行程式碼）。
- 確認彈窗文案同步新增「外帶販售時間」「外送販售時間」兩行，讓操作者送出前
  能清楚看到即將套用的時間範圍。
- 個別的「套用至勾選商品」「只更新外帶販售時段」「只更新外送販售時段」
  「同時更新外帶+外送時段」按鈕（`lpmBatch('sell_time_takeout'|'sell_time_delivery'|'sell_time_both')`）
  維持不變，作為單獨更新單一欄位群的備用操作，保持向下相容。

### 2.2 新增「取消設定（重置）」按鈕

- 外帶／外送販售時間各自新增一顆「取消設定（重置）」按鈕。
- 新函式 `lpmResetSaleWindow(mode)`：清空對應的開始／結束時間輸入框後，直接
  重用既有 `lpmBatch('sell_time_takeout')` / `lpmBatch('sell_time_delivery')`
  流程送出空字串，讓後端清空該模式的欄位（等同「不限販售時間」），且完全不
  影響另一個模式的欄位，並沿用既有確認彈窗與成功/失敗提示，不需新增後端
  程式碼。

### 2.3 修正 Time Picker 寬度裁切問題

- 問題：批次操作區（`#lpm-to-sell-start` / `#lpm-to-sell-end` /
  `#lpm-dl-sell-start` / `#lpm-dl-sell-end`，原寬度 100px）與表格逐行編輯
  （`lpm-ed-to-start-*` / `lpm-ed-to-end-*` / `lpm-ed-dl-start-*` /
  `lpm-ed-dl-end-*`，原寬度 78px）的 `input[type="time"]` 寬度不足，導致中文
  瀏覽器 12 小時制格式（例如「上午 06:00」）被裁切成「上午 06:」，看不到
  分鐘。
- 修正：於 `public/css/main.css` 新增對應選擇器，統一設定
  `min-width:130px !important; width:140px !important;`（沿用專案既有
  BUG-002 FIX 的做法與寬度區間 120～145px），並確認外層容器
  `#lpm-table-wrap` 本身已是 `overflow-x:auto`，放寬欄位寬度不會被父層
  `overflow:hidden` 裁切，必要時表格可水平捲動。
- 未修改 `input[type="time"]` 全站基礎樣式，不影響其他頁面既有顯示。

## 3. 相容性 / 不影響範圍

- 未新增／修改任何資料庫欄位、未修改 `routes/products.js`、
  `routes/line-orders.js` 等後端邏輯。
- 未變更今日開放份數、快售完／供應充足門檻、LINE 商品同步（`show_on_line`）、
  預購數量管理、冷藏宅配商品分頁等既有功能的程式碼路徑。
- 個別「只更新○○」單項按鈕與逐行編輯（`lpmSaveRow`）行為維持不變（逐行編輯
  原本就已包含外帶/外送販售時間欄位）。

## 4. 驗收對照

| 需求 | 對應修改 |
|---|---|
| 按「💾 套用今日設定」即可同步外帶/外送販售時間 | `lpmApplyAll()` 新增讀取＋送出 4 個時間欄位 |
| 外帶/外送皆可獨立取消販售時間限制 | 新增 `lpmResetSaleWindow('takeout'|'delivery')`，各自獨立操作 |
| 時間欄位完整顯示小時與分鐘，不裁切 | `main.css` 新增 min-width/width 140px 規則（批次區＋逐行編輯） |
| 不影響既有今日販售數、庫存門檻、LINE 商品同步等功能 | 未修改後端與其他既有前端邏輯 |
