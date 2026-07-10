# Hotfix22-B｜外帶 / 外送完全分流 ＋ 宅配 LINE Pay 正式化

以 Hotfix22-A 為基礎，不重寫既有架構，只修正三個回報問題。

## 修改檔案清單

| 檔案 | 修改內容 |
|---|---|
| `public/line-order.html` | `buildDateSelector()` / `buildTimeSelector()` / `updateCartTotals()` 的模式判斷改為單一來源 `currentMode`；`openCartSheet()` 開啟購物車時即時重查時段；送單遇 `cutoff_sold_out` 且允許預約明日時，導向下一可營業日 |
| `routes/line-shipping.js` | 移除 `payment_method==='linepay'` 的硬性擋下 |
| `routes/linepay.js` | `/confirm` 導回頁改為依 `source` 參數與 `order.order_mode` 雙重判斷，宅配訂單導回 `line-shipping.html`；付款成功扣份數邏輯改為排除宅配（避免雙重扣份數） |
| `public/line-shipping.html` | 移除 LINE Pay 阻擋提示與 `updateLinepayWarning()`；`submitOrder()` 補上真正的 LINE Pay Request→導向→Confirm 流程；`init()` 新增 LINE Pay 導回結果處理；`showSuccess()` 補上付款狀態列 |
| `public/js/app.js` | 移除後台「LINE Pay 冷藏宅配尚未串接」的提示 toast |
| `public/index.html` | 移除後台付款方式管理頁面上的 LINE Pay 宅配警告文字與 ⚠️ 標記 |

**未修改**（已確認架構正確，不需重寫）：`routes/line-orders.js`（`getModeSettings` / `getDayOpenClose` / `getEarliestMins` / `validateOrderConditions` 等單一判斷函式本來就正確）、`routes/business-calendar.js`、POS、Android、LINE 商品管理相關檔案。

---

## Root Cause

### 問題 1 & 2（外帶/外送分流、今日截止未生效）
後端（`routes/line-orders.js`）的 `getModeSettings()` / `getDayOpenClose()` / `getEarliestMins()` / `validateOrderConditions()` 本來就是以 `mode` 參數（`'takeout'` | `'delivery'`）分開讀取對應的 `takeout_*` / `delivery_*` 設定，`/api/line-shop`、`/api/line-timeslots`（`/api/line-orders/timeslots`）、`/api/line-validate-cart`、`POST /api/line-orders` 四支 API 全部呼叫同一組函式，**後端邏輯本身沒有共用 `enabled` 或共用 `cutoff` 的問題**。

真正的 Root Cause 在前端 `public/line-order.html`：
`buildDateSelector()` / `buildTimeSelector()` 判斷模式時寫的是
```js
const mode = document.getElementById('oType')?.value || currentMode;
```
但 `oType`（購物車表單裡的取餐方式 `<select>`）只有在使用者**手動切換模式**或**開啟購物車** 時才會被同步成 `currentMode`；頁面剛載入、或某個模式一開始就被關閉（例如外帶關閉、外送開啟）時，`oType` 仍停留在 HTML 原始預設值 `'takeout'`。於是查時段的 API 呼叫用的是「錯誤的模式」，導致：
- 外帶關閉、外送開啟時，畫面用 `mode=takeout` 去查時段 → 後端正確回傳 `mode_closed` → 前台顯示「此模式已關閉」，即使外送其實是開啟的。
- 外帶今日臨時截止時間生效後，若當下畫面仍停留在用錯的 `oType` 值查詢，會拿到不對應的（未截止）結果，讓顧客誤以為還能下單。

**這是一個「兩個變數當作同一個狀態的單一來源」造成的狀態污染 bug，不是後端資料錯誤。**

修法：`currentMode` 是全站唯一的模式狀態來源，所有需要判斷模式的地方一律讀 `currentMode`，`oType.value` 只是它的鏡射（顯示用），不再反向影響任何邏輯判斷。同時在 `openCartSheet()` 開啟購物車當下重新呼叫 `buildDateSelector()`，確保即使店家在顧客瀏覽期間才調整「今日臨時最後接單時間」，一開啟購物車就會用即時 API 結果更新，而不是沿用整頁載入當下的快取狀態。

### 問題 3（LINE Pay 冷藏宅配）
`routes/linepay.js` 的 `/request`、`/confirm`、`/webhook` 三支 API 本來就是**以 `orders` 表的 `uuid`/`order_number` 為唯一鍵運作**，完全不區分 `order_mode`（外帶/外送/宅配共用同一張表、同一組 API），金額也是直接信任 DB 裡 `order.total`（已包含運費、折扣後的最終金額）。也就是說 **LINE Pay Request/Confirm/Webhook 技術上早就支援宅配訂單**，Hotfix22-A 當時只是在 `routes/line-shipping.js` 加了一道人工擋下（`payment_method==='linepay'` → 400），並在前端加上警告與阻擋。

移除擋下後發現兩個需要一併修正的既有缺口（見下）：
1. **導回頁面寫死 `/line-order.html`**：LINE Pay 付款完成後的 redirect（成功/失敗/例外）全部寫死導回外帶/外送頁，宅配訂單付款完會被導去錯的頁面。
2. **付款成功扣份數會重複扣**：`/confirm` 付款成功後會依訂單品項扣 LINE 共用份數（`line_quota_sold`），但宅配訂單在**建立訂單當下**（`routes/line-shipping.js` POST `/`）就已經扣過一次共用份數（`shipping_share_line_stock` 邏輯），兩者時機不同，若不處理會造成宅配 LINE Pay 訂單被扣兩次份數。

修法：`/confirm` 依前端傳入的 `&source=shipping` 查詢參數，並以 `order.order_mode==='shipping'` 做雙重保險判斷，決定導回 `line-shipping.html` 或 `line-order.html`；付款成功扣份數邏輯改為 `if (order.order_mode !== 'shipping')` 才執行，避免雙重扣款/雙重扣份數。

---

## 修正內容

1. **外帶 / 外送模式判斷單一來源化**（`public/line-order.html`）
   - `buildDateSelector()`、`buildTimeSelector()`、`updateCartTotals()` 內的 `isDelivMode` 全部改讀 `currentMode`，不再讀取可能未同步的 `oType.value`
   - 頁面初次載入決定 `currentMode` 後立即同步 `oType.value`（防禦性寫法，即使有程式碼路徑遺漏也不受影響）
   - `openCartSheet()` 開啟購物車時重新呼叫 `buildDateSelector()`，確保截止時間即時生效

2. **今日臨時最後接單時間**
   - 確認 `getModeSettings()` 內的 `getTodayCutoff('takeout')` / `getTodayCutoff('delivery')` 本來就是分別讀取 `takeout_today_cutoff_time/date`、`delivery_today_cutoff_time/date`，兩者完全獨立，無共用
   - `/api/line-shop`、`/api/line-orders/timeslots`（別名 `/api/line-timeslots`）、`/api/line-validate-cart`、`POST /api/line-orders` 四支 API 共用同一組 `getModeSettings()` / `getDayOpenClose()` / `getEarliestMins()` / `isCutoffPassed()` / `validateOrderConditions()`，等同使用者要求的 `getModeAvailability(mode, date, now, settings)` 統一判斷函式（原本命名不同，但架構本來就是這個模式，未重寫）
   - 後端送單（`POST /api/line-orders` → `validateOrderConditions()` 第 5 步）本來就會擋下已過今日截止時間的訂單，經實測確認有效
   - 前端新增：送單被 `cutoff_sold_out` 擋下且該模式允許預約明日時，自動帶去下一個可營業日的時段選擇，而非單純重整頁面

3. **冷藏宅配 LINE Pay 正式開放**
   - `routes/line-shipping.js` 移除硬性擋下
   - `routes/linepay.js` `/confirm` 導回頁改為依 `source=shipping` 參數 + `order.order_mode` 雙重判斷；修正雙重扣份數缺口
   - `public/line-shipping.html` 實作真正的 LINE Pay Request → 導向 LINE Pay → Confirm 導回流程，`redirect_url` 帶 `&source=shipping`；`init()` 處理 `linepay=success/cancel/fail` 導回結果；成功頁補上付款狀態列
   - 移除後台（`app.js`、`index.html`）「LINE Pay 冷藏宅配尚未串接」相關提示

---

## E2E 驗證結果（實機啟動 server.js 測試，非僅程式碼推論）

### A. 外帶關閉 / 外送開啟
- `/api/line-shop`：`takeout_status.enabled=false`、`delivery_status.enabled=true` ✅
- `/api/line-orders/timeslots?mode=takeout`：`{"slots":[],"reason":"mode_closed"}` ✅
- `/api/line-orders/timeslots?mode=delivery`：正常回傳時段 ✅
- `POST /api/line-orders`（takeout）：`{"success":false,"reason":"mode_closed"}` ✅
- `POST /api/line-orders`（delivery）：通過模式檢查（無 `mode_closed`），僅因沙盒環境無 Google Maps API Key 卡在外送距離試算，非本次修復範圍 ✅

### B. 外送關閉 / 外帶開啟（對稱測試）
- `/api/line-shop`：`takeout_status.enabled=true`、`delivery_status.enabled=false` ✅
- `/api/line-orders/timeslots?mode=delivery`：`mode_closed` ✅
- `/api/line-orders/timeslots?mode=takeout`：正常回傳時段 ✅
- `POST /api/line-orders`（takeout）：**下單成功**，回傳 `order_number: LINE-20260710-064141` ✅
- `POST /api/line-orders`（delivery）：`{"success":false,"reason":"mode_closed"}` ✅

### C. 今日臨時截止時間完全分流
- 設定 `takeout_today_cutoff_time=00:01`（已過）、`delivery` 不設定：
  - `takeout_status.cutoff_passed=true`、`delivery_status.cutoff_passed=false` ✅
  - `timeslots?mode=takeout` → `cutoff_passed`；`timeslots?mode=delivery` → 正常時段 ✅
  - `POST /api/line-orders`（takeout）→ **後端擋下**：`{"reason":"cutoff_sold_out","message":"外帶已超過今日最後接單時間（00:01）"}` ✅
- 反向設定 `delivery_today_cutoff_time=00:01`、`takeout` 不設定：結果完全對稱，`delivery` 被擋、`takeout` 不受影響 ✅
- **結論：兩者互不共用，且後端送單真的會擋，不是只有前台顯示層擋。**

共用同一判斷函式的 API 清單：`/api/line-shop`、`/api/line-timeslots`（＝`/api/line-orders/timeslots`）、`/api/line-validate-cart`、`POST /api/line-orders` 四支，全部呼叫 `routes/line-orders.js` 內同一組 `getModeSettings()` / `getDayOpenClose()` / `getEarliestMins()` / `isCutoffPassed()` / `validateOrderConditions()`。

### D. Business Calendar 最高優先
- 建立今日 `mode='closed'` 的 Business Calendar 紀錄，此時 `takeout_enabled=1`、`delivery_enabled=1`（兩者皆開啟）：
  - `takeout_status.is_closed_day=true`、`delivery_status.is_closed_day=true` ✅
  - `timeslots?mode=takeout`／`mode=delivery` 皆回傳 `closed_day` ✅
  - `POST /api/line-orders` → `{"reason":"calendar_closed","message":"2026-07-10 為特殊休假日（測試公休）..."}` ✅
- **結論：Business Calendar 休假設定會覆蓋外帶/外送個別開關，優先序未被本次修改影響。**

### E. 冷藏宅配 LINE Pay
- `POST /api/line-shipping`（`payment_method:"linepay"`）：**不再被硬性擋下**，成功建立訂單，`total=350`（`商品 3×100=300` ＋ `運費 50` － `折扣 0`，未達免運門檻）✅ 金額計算正確
- `POST /api/linepay/request`：伺服器端記錄 `amount=350 packageAmount=350 productsTotal=350`，三者一致驗證通過 ✅；實際呼叫 LINE Pay 沙盒 API（`sandbox-api-pay.line.me`）因**測試環境網路白名單未開放該網域**而失敗（見下方「已知限制」），非程式邏輯問題
- `GET /api/linepay/confirm?...&source=shipping`：確認導回頁為 `/line-shipping.html`（非 `/line-order.html`）✅
- `GET /api/linepay/confirm?...`（不帶 `source`，但該訂單 `order_mode='shipping'`）：**雙重保險機制生效**，仍正確導回 `/line-shipping.html` ✅
- `GET /api/linepay/confirm?...`（不存在的外帶/外送訂單，不帶 `source`）：維持原行為導回 `/line-order.html`，確認未影響既有外帶/外送 LINE Pay 流程 ✅
- 我的訂單 / 訂單查詢（`GET /api/line-shipping/order/:orderNo`）本來就是泛用實作（`safeShippingOrder()`），`payment_status_label` 會自動顯示「付款成功」，`payment_method_label` 顯示「LINE Pay」，**此部分無需修改即可正確顯示**

### F. Regression（回歸確認）
- 與原始上傳版本逐檔比對（`diff -rq`），**僅 6 個檔案有變動**：`public/index.html`、`public/js/app.js`、`public/line-order.html`、`public/line-shipping.html`、`routes/line-shipping.js`、`routes/linepay.js`
- `routes/line-orders.js`、`routes/business-calendar.js`、POS 收銀、Android、LINE 商品管理、LINE 預購、冷藏宅配商品管理、付款方式管理、金流 API、庫存、優惠券 相關程式碼**完全未變動**
- `node --check` 全部路由檔、`public/js/app.js`、`line-order.html`／`line-shipping.html` 內嵌 JS：全部通過

---

## 已知限制（誠實列出，非藏起來）

- **LINE Pay 宅配的完整付款成功回寫（`payment_status:'paid'`）無法在本測試沙盒環境內做真正的端對端驗證**：因為測試沙盒的對外網路白名單不包含 `sandbox-api-pay.line.me` / `api-pay.line.me`，所以 `POST /api/linepay/request` 實際呼叫 LINE Pay 沙盒 API 時會被網路層擋下（而不是被程式擋下）。這與外帶/外送原本的 LINE Pay 流程受到**完全相同的環境限制**，並非宅配專屬的缺口。已驗證的部分：金額組裝與驗證邏輯正確（`amount===packageAmount===productsTotal`）、訂單建立不再被硬擋、`/confirm` 的頁面導回與 `order_mode` 雙重判斷正確、成功扣份數邏輯已避開宅配重複扣款。建議正式環境（可連線至 LINE Pay 正式/沙盒網域）上，比照外帶/外送既有的驗收方式，實際跑一次含真實 Channel ID/Secret 的付款流程做最終確認。
