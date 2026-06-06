# LINE 接單與可售管理中心 v1
版本：pos-saas-r1 + line-order-center-v1
日期：2026-06

---

## 一、本版修改摘要

### A. LINE 商品管理總表（全新功能）
- 新增獨立頁面「📲 LINE 商品管理」，側邊欄與商品管理頁均有入口
- 13 欄商品總表：勾選框、圖片、名稱、LINE上架、份數管理、今日份數、已售、剩餘、快售完門檻、充足門檻、販售開始、販售結束、目前狀態
- 行內快速編輯（✏️ 編輯 → 💾 儲存）
- 批量操作主按鈕「💾 套用設定」：一鍵同時更新份數 + 門檻 + 時段 + 啟用份數管理
- 批量單項操作：只更新份數／只更新門檻／只更新時段／重置已售／開啟 LINE 販售／關閉 LINE 販售／只啟用份數管理／只停用份數管理
- 所有批量操作均有確認提示，防止誤操作
- 防呆：未選商品、份數空白、門檻矛盾、時段倒置均有提示
- 全部重置按鈕（⟳ 全部重置已售）

### B. LINE 接單規則優先順序（重新整理）
四個位階，所有位階只限制「今日下單」，不阻擋明日/未來預約：

| 位階 | 設定 | 作用範圍 |
|------|------|---------|
| 第一 | 每週營業時間 | 日期選擇器、時段基礎（bizHours）|
| 第二 | 今日最後接單時間 | 只限今日（cutoff_time）|
| 第三 | 商品販售開始/結束 | 只限今日（line_sell_start/end）|
| 第四 | LINE 今日可售份數 | 只限今日（line_quota_sold）|

### C. LINE 預約/預購流程（全面修正）
- 今日售完（任何位階）+ 允許明日預購 → 商品卡片顯示「📅 預約明日」按鈕
- 點擊「預約明日」：
  1. 自動找下一個可營業日（跳過公休/店休）
  2. 商品加入購物車
  3. 呼叫 timeslots API 取得次日時段
  4. 購物車自動打開並設定日期+時段
  5. 預設選第一個可用時段
- 明日預約訂單：不扣今日 line_quota_sold
- 明日預約訂單：不受今日 cutoff_time、line_sell_end、line_quota 限制
- 客戶端文案：「📅 預約日期：YYYY-MM-DD，請依選擇時段取餐 / 收餐」（已移除「不扣今日份數」等管理員用語）

### D. LINE 預購管理分頁（全新功能）
- 新增側邊欄入口「📅 LINE預購」
- 篩選：今天、明天、本週、全部預購、自訂日期
- 篩選：外帶/外送、待接單/已完成/已取消
- 統計卡：預購筆數、待處理、預購金額
- 訂單表格：含預購日期時段、顧客資訊、商品明細、狀態、操作
- 快速接單/取消操作
- 訂單記錄中預購單顯示「📅 預購：MM-DD HH:MM」（紫色）

### E. BUG 修正
| Bug | 修正 |
|-----|------|
| app.js SyntaxError（confirm 多行字串）| 所有 confirm() 字串合併為單行 |
| NO_STORE_TOKEN（JS 中斷導致）| 根本原因是 SyntaxError，修正後恢復 |
| 時間選擇器深色模式黑底黑字 | main.css 新增 input[type="time"] 全站樣式 |
| 商品份數充足卻顯示「備料不足」| LINE quota 有剩餘時覆蓋食材庫存限制 |
| 週一有營業但時段顯示「明日暫無可選時段」| openCartSheetWithDate 改為同步設定，移除雙層 setTimeout |
| bizHours 空物件時跳過所有可訂日 | 加入 bizEmpty fallback，空物件視為全天可訂 |
| 批量設定份數後未真正啟用份數管理 | lpmBatch 改為詢問是否同時啟用；lpmApplyAll 預設啟用 |
| 預約明日只跳提示但未加入購物車 | 重寫 preorderNextDay，流程完整：找日 → 加購 → 載時段 → 開購物車 |

---

## 二、修改檔案清單

| 檔案 | 修改原因 |
|------|---------|
| `utils/db.js` | 新增 7 個 products 欄位（line_quota_*）；新增外帶/外送 settings 預設值 |
| `routes/settings.js` | LINE_KEYS 擴充外帶/外送 9 個新設定 key |
| `routes/line-orders.js` | 全面改寫：商品狀態優先順序、預購驗證、timeslots、nextAvailableDates |
| `routes/products.js` | PATCH /line-settings 補上 7 個 quota 欄位；GET /line-products/list 改回傳全部商品 |
| `public/index.html` | 新增 page-line_products、page-line_preorders、nav 按鈕、批量操作區重構 |
| `public/js/app.js` | 新增 LINE 商品管理（16 個函數）、LINE 預購管理（4 個函數）、修正語法錯誤 |
| `public/line-order.html` | 全面改寫：buildCard 優先順序、openCartSheetWithDate 同步設定、preorderNextDay 完整流程 |
| `public/css/main.css` | 新增 input[type="time"] 全站樣式（130 行） |
| `server.js` | 新增 scheduleDailyQuotaReset（每日 00:05 重置 LINE 已售份數）|

---

## 三、新增 API / 函數清單

### 後端 API

| Method | Path | 說明 |
|--------|------|------|
| GET | `/api/line-orders/timeslots?mode=&date=` | 取得指定模式/日期的可選時段 |
| GET | `/api/line-orders/validate-cart?mode=&product_ids=` | 加入購物車前驗證 |
| POST | `/api/line-orders/quota-reset` | 手動重置今日已售份數 |
| GET | `/api/products/line-products/list` | LINE 商品管理總表資料（含全部商品） |

### 前端函數（app.js）

LINE 商品管理：`initLineProductsNav` / `loadLineProductsPage` / `calcLpmStatus` / `renderLpmTable` / `lpmSelectAll` / `lpmDeselectAll` / `lpmUpdateCount` / `lpmGetSelected` / `lpmEditRow` / `lpmCancelRow` / `lpmSaveRow` / `lpmToggleOnline` / `lpmToggleQuota` / `lpmResetSold` / `resetAllLineQuota` / `lpmApplyAll` / `lpmBatch`

LINE 預購管理：`loadLinePreorders` / `renderLinePreordersTable` / `lpSetFilter` / `lpUpdateStatus`

LINE 設定 Modal：`setQuotaEnabled` / `toggleLineQuotaFields` / `updateLineQuotaStatusBar` / `resetLineQuotaSold`

外帶/外送規則：`renderModeHoursGrid` / `saveTakeoutDeliveryRule` / `saveModeHoursFromGrid`

### 前端函數（line-order.html）

`preorderNextDay` / `openCartSheetWithDate` / `buildDateSelector`（更新）

---

## 四、不影響 Android POS 說明

本版所有修改均限於：
- Web 後台（`public/index.html`、`public/js/app.js`）
- LINE 前台（`public/line-order.html`）
- LINE 接單 API（`routes/line-orders.js`）
- 商品 LINE 設定 API（`routes/products.js` 的 `/line-settings` 端點）

**Android POS 使用的端點均未修改：**
- `POST /api/orders`（POS 下單）
- `GET /api/products`（商品查詢）
- `GET /api/categories`
- `GET /api/ingredients`
- `PATCH /api/orders/:id`（訂單狀態）

新增欄位（`line_quota_*`）使用 `ALTER TABLE ... ADD COLUMN` + `INSERT OR IGNORE`，不影響現有資料與 Android POS 的資料結構。

---

## 五、部署測試步驟

```bash
# 1. 停止現有服務
pm2 stop all  # 或 pkill node

# 2. 備份現有資料庫
cp -r data/ data_backup_$(date +%Y%m%d)/

# 3. 解壓新版本（覆蓋現有檔案）
unzip pos-saas-line-order-center-v1-complete.zip -d /your/deploy/path/

# 4. 安裝/確認相依套件
npm install

# 5. 語法驗證
node --check server.js
node --check routes/line-orders.js
node --check public/js/app.js

# 6. 啟動
node server.js
# 或
pm2 start server.js --name pos-saas

# 7. 確認啟動
curl http://localhost:3000/api/settings -H "Authorization: Bearer <token>"
```

**首次啟動時 db.js 會自動執行：**
- `ALTER TABLE products ADD COLUMN line_quota_enabled INTEGER DEFAULT 0`（及其他 6 個欄位）
- `INSERT OR IGNORE INTO settings ...`（外帶/外送設定預設值）

不會清空現有資料。

---

## 六、驗收案例

### 案例 1：批量套用 LINE 份數設定
1. 進入「📲 LINE 商品管理」→ 全選商品
2. 填入：今日份數=10、快售完=2、充足=8、販售時段 11:00~20:00
3. 按「💾 套用設定」→ 確認提示 → 確定
4. 結果：所有商品 `line_quota_enabled=1`、`line_quota_daily=10`
5. LINE 前台依份數顯示供應充足/即將售完/今日售完

### 案例 2：今日售完，週日店休，週一預約
1. LINE 前台找到今日售完商品（`allow_next_day=true`）
2. 點擊「📅 預約明日」
3. 結果：
   - 日期自動跳至週一（跳過週日店休）
   - 時段顯示週一營業時段
   - 商品已加入購物車
   - 購物車自動打開
   - 預設選第一個可用時段
4. 直接送出 → 後端不扣今日份數

### 案例 3：商品販售時段已過，可預約明日
- 商品設定：`line_sell_end = 19:00`，現在時間 19:30
- 外帶 `allow_next_day = true`
- 前台顯示：「今日售完」+「📅 預約明日」按鈕（可點）

### 案例 4：預購管理後台
1. 進入「📅 LINE預購」分頁
2. 選擇篩選「明天」
3. 看到預購訂單列表，含日期時段、顧客、狀態
4. 可點「✅ 接單」或「❌ 取消」

### 案例 5：訂單記錄顯示預購標籤
- 訂單列表中，預購單顯示「📅 預購：06-08 17:00」（紫色）
- 今日單顯示「⏰17:00」（綠色）

---

## 七、版本備注

- Android POS：**未修改**
- 主庫存（`current_stock_grams`、食材庫存）：**未修改**
- LINE 份數（`line_quota_sold`）：只在今日訂單下單時更新，明日預約不扣
- 每日 00:05 台灣時間自動重置 `line_quota_sold` 為 0
