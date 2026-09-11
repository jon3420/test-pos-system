# H1.4.11｜LINE 點餐頁模式設定＋外送／外帶雙圖塊＋服務狀態 Toast

## 1. 基礎版本

直接基礎版本：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.10-...-full.zip`（H1.4.10）。
全程未切換基礎版本。

## 2. Reality Audit 摘要

- 設定：`routes/settings.js` 為 key-value 架構（`settings(store_id, key, value)`），
  透過 `LINE_KEYS` allowlist 控制哪些 key 受 `line_order` feature gate 保護、經
  `PUT /api/settings` 統一寫入。無需 schema migration。
- 服務狀態單一權威來源：後端 `resolveFulfillmentState()`（`routes/line-orders.js`）
  與前端 `getFulfillmentStatus(mode)`（`public/line-order.html`）已由 Hotfix30-B1
  統一，本輪完全沿用，未新增第二套判斷。
- 舊版「今日服務」黃色文字列由 `buildServiceStatusBar()` 產生，本輪在同一個函式
  的渲染內容替換為雙圖塊，呼叫點（`refreshModeCutoffUI()`／`applyFulfillmentMode()`
  ／`refreshShopStatus()`／初始化）完全不變。
- 取餐方式的既有寫入入口是 `selectFulfillmentMode()` → `applyFulfillmentMode()`，
  本輪「取餐切換模式」直接委派這個既有函式，未另寫預選邏輯。
- Toast：`public/line-order.html` 已有共用 `#toast` 元件與 `toast(msg)` 函式，
  本輪擴充為 `toast(msg, durationMs)`（向下相容，原有 100+ 呼叫點行為不變）並加上
  `aria-live="polite"`、safe-area、計時器去重。
- 後端送單驗證：`validateOrderConditions()`（`routes/line-orders.js`）在真正建立
  訂單前重新計算截止時間／營業狀態，與前端圖塊狀態完全獨立，本輪未修改此函式。

## 3. 修改檔案

- `routes/settings.js` — 新增 `line_order_page_mode` 至 `LINE_KEYS`、PUT 端點 enum
  驗證、`router.__test` 匯出合法值清單。
- `routes/line-orders.js` — `GET /shop` 新增並正規化 `line_order_page_mode`
  （fallback `combined_checkout`）；新增 `module.exports.resolveFulfillmentState`／
  `getEffectiveCutoffMins`（純測試可見性匯出，判斷邏輯本身未變動）。
- `public/index.html` — 系統設定 → LINE 點餐入口新增「LINE 點餐頁模式」設定卡片。
- `public/js/app.js` — 新增 `renderLineOrderPageModeCard()`／
  `saveLineOrderPageMode()`／`onLineOrderPageModeCardChange()`；`app.js` 的
  cache-bust version query 由 `fix18-10-hotfix22` 更新為 `h1-4-11-1`。
- `public/line-order.html` — 新增外送／外帶雙圖塊渲染（`buildServiceStatusBar()`
  整合點）、`handleFulfillmentTileClick()`、`_ffShortLabel()`／`_ffDetailText()`／
  `_ffToastText()`、`getLineOrderPageMode()`、`_ffViewMode`（合併模式查看狀態）、
  `toast()` 擴充、`refreshShopStatus()` 內補上取餐切換模式的失效 Toast、
  `visibilitychange`／`pageshow` 生命週期刷新（單次註冊，`_lifecycleWired` guard）、
  對應 CSS。
- `scripts/smoke-h1-4-11-line-order-page-mode.js`（新增）— 目標 smoke test。
- 本檔案（新增）。

未修改：Friend Required Gate、Friend Guide、歷史好友同步、Cart Recovery、n8n
Secret、手機欄位驗證、會員 backend reconcile、`checkout_click` 事件語意、外送費
計算、折扣券／滿額免運規則、商品資料與價格、LINE 點餐網址與 QR Code 產生邏輯。

## 4. 測試證據

### 4.1 本輪新增測試

`node scripts/smoke-h1-4-11-line-order-page-mode.js`
→ **62 PASS / 0 FAIL**（settings API + store 隔離 + feature gate、GET /shop
fallback、`resolveFulfillmentState()` 8 狀態真值表、jsdom 實際執行的圖塊/Toast
行為、生命週期去重）。

### 4.2 直接相關既有 runtime suites（全部重新執行，未省略）

| Suite | 結果 |
|---|---|
| `run-h1-4-9-checkout-order-summary-runtime.js` | 67 PASS / 0 FAIL |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111 PASS / 0 FAIL |
| `run-h1-4-10-phase1-liff-identity-runtime.js` | 68 PASS / 0 FAIL |
| `run-h1-4-10-required-friend-gate-runtime.js` | 98 PASS / 0 FAIL |
| `run-h1-4-10-asset-cache-bust-runtime.js` | 30 PASS / 0 FAIL |
| `run-h1-4-10-historical-backend-reconcile-runtime.js` | 35 PASS / 0 FAIL |

### 4.3 基準版比對（本輪修改版 vs. 未修改的 H1.4.10 原始 ZIP，同環境同時間執行）

以下三組在**修改版與原始 H1.4.10 基準版**兩邊執行結果**逐字元相同**
（`diff` 輸出為空），證明為基準版既有問題，與本輪修改無關，因此未修改任何
production 邏輯：

- `smoke-hotfix26-f2.js` — 兩邊皆 `Total: 28, PASS: 22, FAIL: 3`。三個失敗經追查
  皆為**寫死舊原始碼樣式的靜態 regex 斷言**，斷言的是已被後續合法重構取代的舊寫法
  （`switchMode(mode){...}` 已被 Hotfix30-A 重構為
  `selectFulfillmentMode()`/`applyFulfillmentMode()`；`isCutoffPassed(modeSettings.cutoffTime, nowMins)`
  已被 Hotfix30-B1 的 `getEffectiveCutoffMins()`/`resolveFulfillmentState()`
  取代）。實際 production 邏輯本身正確（`validateOrderConditions()` 仍正確以
  `orderDate === todayStr` 限定截止判斷才生效，本輪 C 組測試以真實函式呼叫驗證過）。
- `smoke-hotfix26-f7.js` — 兩邊皆 `Total: 47, PASS: 46, FAIL: 1`。唯一失敗斷言硬編碼
  `INSERT INTO orders` 欄位數必須恰好等於 `44`；實際欄位數與 placeholder 數本身一致
  （`cols=53 ph=53`，無真正錯位），只是欄位總數在 F7 之後的多輪合法新增（Geo
  Context／GA4 等）已成長到 53，斷言裡的寫死數字未同步更新。
- `smoke-hotfix27-cd.js` 及其鏈中的 `smoke-hotfix26-f8-b.js`／`smoke-hotfix27.js` —
  兩邊 `Regression 總結` 完全相同（各自的「自身測試部分」100% 通過，鏈狀失敗純粹是
  上述 f2/f7 斷言被其內部 regression runner 引用所致的連鎖）。
- `smoke-hotfix29-b.js`／`smoke-hotfix29-c.js` 的巢狀 regression chain：兩邊在相同
  200 秒觀察窗內呈現相同的「自身測試全過、進入巢狀鏈後同樣卡在 f2/f7 連鎖」行為，
  且巢狀鏈本身層層呼叫 F1～F9 全系列，執行時間遠超過內部每支 180 秒 timeout，此為
  測試架構本身既有的巢狀特性，基準版與修改版行為一致。

**未在本次修改任何 production 邏輯以強行讓上述基準既有失敗變綠**，因為造成失敗的
斷言本身已過期（比對已被合法取代的舊程式碼寫法／硬編碼數字），修改 production
邏輯去配合過期斷言只會製造新的不一致。

### 4.4 檔案差異稽核

`diff -rq` 基準 H1.4.10 目錄與本輪工作目錄（排除 `node_modules`／`data`／
`package-lock.json`）確認**只有**下列檔案被改動：
`routes/settings.js`、`routes/line-orders.js`、`public/index.html`、
`public/js/app.js`、`public/line-order.html`，外加新增
`scripts/smoke-h1-4-11-line-order-page-mode.js` 與本 changelog。無任何無關檔案
被觸碰。

## 5. 資產快取

`.html` 檔案已由 `server.js` 既有規則對所有 `.html` 一律
`Cache-Control: no-store, no-cache, must-revalidate`（Hotfix22-A defense-in-depth，
本輪未修改 `server.js`），因此 `line-order.html`／`index.html` 的內容變更不需要
另外處理版本 query。本輪唯一需要更新版本 query 的是 `public/js/app.js`
（`?v=fix18-10-hotfix22` → `?v=h1-4-11-1`），因為它是一般 `.js` 靜態資源，會被
瀏覽器快取。已確認 `run-h1-4-10-asset-cache-bust-runtime.js`（H1.4.10 既有測試）
更新後仍 30/30 通過，未破壞既有 asset-cache/backend-reconcile 行為。

## 6. 已知限制

- `today_not_open` 狀態目前對應「後台手動暫停」與「後台完全未提供該服務方式」兩種
  情境（沿用既有 `resolveFulfillmentState()` 的既有語意，未新增區分欄位），圖塊一律
  顯示「目前未提供」。若日後需要精確區分「暫停」與「未提供」兩種文案，需要後端
  `resolveFulfillmentState()` 本身新增欄位，本輪未做此擴充（避免另立第二套狀態
  計算）。
- 取餐切換模式下，若使用者已選定的 `currentMode` 因店家狀態變動而失效，沿用既有
  Hotfix22-F 的設計原則：不靜默清除/切換 `currentMode`（避免使用者選擇被無聲覆
  蓋），只更新圖塊外觀（自動失去綠框/勾選）、擋下送單（既有
  `isCurrentModeAvailable()`/`updateModeAvailabilityUI()`）、並新增 Toast 告知。
  這與需求文件字面「清除失效的預選狀態」在實作細節上略有差異，是刻意的、有留存
  既有行為一致性考量的設計選擇，而非遺漏。
- `smoke-hotfix26-f2.js`／`smoke-hotfix26-f7.js`／其巢狀鏈中的 F8-B／F27／F28／F29
  等既有測試存在基準版就有的失敗與長執行時間特性（詳見 4.3），本輪未修改，
  維持原樣記錄。
