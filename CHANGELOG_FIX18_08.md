# fix18-08 — 訂單平台來源可編輯 + 平台抽成率可設定

## 版本
fix18-08

## 修改摘要

### 1. 修改訂單視窗新增平台來源欄位
- `public/index.html`：editOrderModal 中「付款方式」下方新增「平台來源」下拉選單（id: editOrderPlatform）
- 選項：未知 / POS現場 / Uber Eats / foodpanda / LINE點餐 / 電話訂購 / 其他
- 開啟編輯訂單時自動帶入原訂單平台

### 2. normalizePlatform 標準化函式
- `public/js/app.js`：新增 normalizePlatform(v) 與 platformLabel(code)
- 相容 NULL / '' / unknown / undefined / 未知 / — 等舊資料，統一轉為 'unknown'

### 3. saveEditOrder 送出 platform 欄位
- `public/js/app.js`：saveEditOrder() payload 新增 platform 欄位
- 後端根據 platform 重算抽成率、抽成金額、店家實收

### 4. 後端 PUT /api/orders/:id 同步更新平台與抽成
- `routes/orders.js`：
  - 解析 platform 欄位，normalizePlatform 標準化
  - 從 store_settings 查詢對應抽成率（fallback: ubereats=31, foodpanda=35, 其餘=0）
  - 更新 delivery_platform / platform_commission_rate / platform_commission_amount / store_actual_income
  - order_logs 記錄 platform_diff（含修改前後平台、抽成率、金額）

### 5. 設定中心新增平台抽成率設定
- `public/index.html`：「外送平台」設定分頁新增「訂單修改時平台抽成率設定」卡片
  - Uber Eats（預設 31%）、foodpanda（預設 35%）、LINE、POS、電話、其他、未知
- `routes/settings.js`：新增 COMMISSION_KEYS 到 ALL_ALLOWED
- `public/js/app.js`：
  - loadSettingsPage() 載入各抽成率至輸入框
  - saveCommissionRates() 儲存至 store_settings

### 6. 訂單明細修改紀錄顯示平台變更
- `public/js/app.js`：order log 渲染解析 after_data.platform_diff，顯示平台前後對比

### 7. 向下相容
- 舊資料 NULL / '' / unknown / undefined 自動視為「未知」
- 不清空 orders、不重建資料庫

## 修改檔案清單
1. `public/index.html` — editOrderModal 加平台欄位；設定中心加抽成率設定卡片
2. `public/js/app.js` — normalizePlatform、openEditOrder 帶入平台、saveEditOrder 含 platform、loadSettingsPage 載入率、saveCommissionRates、logs 渲染含 platform diff
3. `routes/orders.js` — PUT /:id 新增平台標準化、從 settings 讀取率、重算三欄位、寫入 log diff
4. `routes/settings.js` — 新增 COMMISSION_KEYS 到 ALL_ALLOWED

## 資料庫 Migration
無需新增欄位（delivery_platform / platform_commission_rate / platform_commission_amount / store_actual_income 已存在）。
store_settings 使用 INSERT OR IGNORE 寫入，不影響現有資料。

## 測試結果
- 測試1：未知訂單 → Uber Eats，470元，抽成 145.7，實收 324.3 ✅
- 測試2：同筆 → foodpanda，抽成率 35%，抽成 164.5，實收 305.5 ✅
- 測試3：設定 Uber Eats 28%，1000元 → 抽成 280，實收 720 ✅
- 測試4：外送報表頁修改後仍停留外送報表 ✅（refreshCurrentOrderView 保持分頁）
- 測試5：內用/外帶頁修改後仍停留原分頁 ✅
- 測試6：訂單明細可見平台來源修改紀錄 ✅
