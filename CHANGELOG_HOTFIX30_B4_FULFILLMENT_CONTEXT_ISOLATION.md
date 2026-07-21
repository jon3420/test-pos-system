# fix18-10-hotfix30-B4｜Fulfillment Context 隔離 × 模式表單獨立 × 狀態配色

基礎版本：**Hotfix30-B3**（`pos-web-fix18-10-hotfix30-B3-full.zip`）。只修改
`public/line-order.html`，其餘檔案未變動。

## 0. 真實瀏覽器互動測試方法（本次 RC 驗證新增章節）

**工具選擇過程**：優先嘗試 Playwright（`npx playwright install chromium`），下載瀏覽器
二進位檔時被沙盒網路白名單擋下（`cdn.playwright.dev` 不在允許清單，回傳
`403 Host not in allowlist`）——這是環境限制，非人為選擇。改用 **jsdom**（可透過 npm
安裝，不需要瀏覽器二進位檔）：載入真實 `public/line-order.html`、以
`runScripts:'dangerously'` 真實執行其 inline `<script>`、對真實本機 Node server（啟動
`node server.js`，透過 `x-store-id` header／真實 SQLite）發出真實 HTTP 請求、操作真實
DOM 元素與真實使用者事件路徑（`selectFulfillmentMode()`／`addCart()`／
`submitOrder()`）。**未使用 Playwright/Puppeteer/Cypress**（環境限制），這點如實記錄，
不宣稱有做到完整瀏覽器渲染／CSS layout 測試，但確實是「真實 DOM ＋ 真實 script 執行 ＋
真實本機 API」的測試，非純程式碼推論。

**外部 API 依賴處理**：`/api/delivery/calculate-fee` 內部呼叫外部
`routes.googleapis.com`（Google Maps Routes API），沙盒環境無法真實呼叫且無金鑰，依需求
文件明確允許，對這一支請求做 network stub（回傳固定的 `distance_km`/`delivery_fee`/
`message`）；其餘所有 LINE 點餐 API（`/api/line-orders/shop`、`/menu`、`/timeslots`、
`/validate-cart`、`/api/settings/business-calendar`、`/api/settings`）**全部使用真實本機
API**，未 mock。`POST /api/line-orders`（真正送單）為避免建立正式測試訂單，攔截其
request body 後回傳固定失敗回應，不讓後端真的寫入訂單資料——**只攔截讀取 payload
內容，不建立任何測試訂單**。

**重要方法論發現（誠實記錄）**：測試過程中一度出現 `currentMode` 讀值不一致的假性失敗
（透過 `window.eval('currentMode')` 從測試腳本外部反覆讀取一個頁面內 `let` 宣告的頂層
變數）。追查後確認這是 **jsdom／Node `vm` 模組對「間接 eval 讀取頂層 `let` 綁定」的已知
限制**，不是產品程式碼的 bug——證據：(1) 在 `applyFulfillmentMode()` 內部插入的追蹤
`console.log` 一致且正確地顯示每次 `currentMode = mode` 賦值都成功；(2) 改用純粹的
DOM 屬性讀取（`#oType.value`／`.style.display`／`<input>.value`，透過 `window.document`
存取，不經過 `eval`）重新驗證同樣的操作序列後，**全數穩定通過**，不再出現任何不一致。
本 CHANGELOG 只採用「純 DOM 屬性讀取」得到的結果作為最終判定依據，`eval` 相關的假性
失敗已被排除，不計入下方 Case 結果。

## 1. Root Cause

`updateDeliveryAddressVisibility()` 先前在離開外送模式時會呼叫 `resetDeliveryFee()`，
而 `resetDeliveryFee()` 會直接 `addrEl.value=''` 把 `#deliveryAddress` 輸入框的值清空
——不是隱藏，是真的清空。這是「外送輸入地址後切回外帶、再切回外送地址卻消失」的直接
根因。本輪在此基礎上，把 `fulfillmentFormState` 擴充為完整的 `fulfillmentContext`
（表單 + 營業狀態 + UI 顯示三層），並補齊 RC 階段要求的顯式 mode 參數與 timeslots
Context 化。

## 2. `fulfillmentContext` 架構（含本輪 RC 補強）

```js
const fulfillmentContext = {
  takeout:  { form: fulfillmentFormState.takeout,  availability: { timeslots: [] }, ui: { storeAddress:'', mapsUrl:'' } },
  delivery: { form: fulfillmentFormState.delivery, availability: { timeslots: [] }, ui: { distanceKm:null, deliveryFee:null, rawDeliveryFee:null, freeShippingReason:null, mapsUrl:'' } },
};
```

`.form` 是 `fulfillmentFormState` 的同一個物件參照，不平行維護兩份。`.availability`／
`.ui` 只透過 `syncFulfillmentContext(mode)` 寫入，外帶的同步路徑只讀
`shopData.takeout_status`／`takeout_next_dates`，外送只讀 `delivery_status`／
`delivery_next_dates`／`deliveryLatLng`／`calcDeliveryFee`，結構上不存在互相讀到對方
資料的管道。

**本輪 RC 新增**：`availability.timeslots` 現在由 `buildTimeSelector()` 直接寫入（見
第 5 節），`syncFulfillmentContext()` 重建 `availability` 物件時會保留既有的
`timeslots`（先讀出、再寫回），不會覆蓋掉。

## 3. Async Race Condition（Case AN）

`let fulfillmentRenderToken = 0;`，`buildTimeSelector()`／`fetchDeliveryFee()`／
`applyFulfillmentMode()`（改為 `async`）三處都在呼叫開始時佔用一個 token，await 完成後
檢查 token 是否仍是自己這一份，不是就直接放棄寫回畫面。**實測結果**：快速連續呼叫
`selectFulfillmentMode()` 10 次（takeout/delivery 交替）後，`#oType.value`／
`deliveryAddrWrap.style.display` 皆與最後一次點擊的模式完全一致，無殘留的舊回應覆蓋
畫面，無 JS 例外（`window.addEventListener('error'/'unhandledrejection')` 皆未捕捉到
任何錯誤）。

## 4. `applyFulfillmentMode(mode)` 最終流程

```
1. saveCurrentModeFormState(fromMode)
2. currentMode = mode
3. restoreModeFormState(mode)
4. renderMenu() / refreshModeCutoffUI()
5. renderFulfillmentMode(mode) → syncFulfillmentContext(mode) + 地址/付款/送單按鈕
6. await refreshDateSelectorForCart() → 內部呼叫已補上顯式 mode 參數的 buildDateSelector(forceNextDay, mode)/buildTimeSelector(mode, date)
7. [token 檢查，過期則中止]
8. buildPreorderInfo() / buildFulfillmentOptions()
9. Analytics（fulfillment_method_selected）
10. persistCart()
```

## 5. 明確 mode 參數（RC 第十三點，本輪完成）

`buildDateSelector(forceNextDay=false, mode=currentMode)`：`forceNextDay` 維持第一個
參數位置不變（避免破壞既有 `buildDateSelector(true)` 呼叫點），`mode` 是新增的第二個
參數，在呼叫當下鎖定求值。`buildTimeSelector(mode=currentMode, dateOverride=null)`：
`mode` 在函式一開始就存進 `modeSnapshot` 常數，之後全程只用這個常數，不再讀取可能已
變動的全域 `currentMode`；DOM 寫回前另外檢查 `modeSnapshot===currentMode`（雙重保險：
token 防過期、mode 比對防止「非目前使用中模式」的背景查詢誤寫畫面）。所有既有呼叫點
（`refreshDateSelectorForCart()`／`onDateChange()`／`applyDateTimeToCartSheet()` 等）
維持零參數或既有參數呼叫方式，因為預設值已在呼叫當下正確鎖定 `currentMode`，不需要
修改呼叫端。

## 6. Timeslots 進入 Context（RC 第十四點，本輪完成）

`buildTimeSelector()` 取得 `res.slots` 後，先寫入
`fulfillmentContext[modeSnapshot].availability.timeslots = res.slots.slice()`
（獨立陣列，非參照分享），才視情況寫回 `#pTime` DOM（只在 `modeSnapshot` 仍是目前使用
中模式時才寫 DOM，Context 本身不論是否為目前模式都會更新，因為更新 Context 對其他模式
無副作用）。**實測驗證**：`fulfillmentContext.takeout.availability.timeslots` 與
`fulfillmentContext.delivery.availability.timeslots` 是兩個不同陣列物件
（`!==` 比對為真），內容也不同（takeout 從 15:30 起、delivery 從 16:00 起，對應各自
營業時間與備餐時間）。

## 7. Behavior Regression — 真實 DOM／HTTP 測試結果

**測試場景**（真實設定，透過 `PUT /api/settings` 寫入）：現在時間約 15:xx（沙盒實際
時鐘），外帶營業時間 15:30–20:00、備餐 15 分鐘；外送營業時間 11:00–21:00、備餐 30
分鐘。

| Case | 情境 | 驗證方式 | 結果 |
|---|---|---|---|
| AH | 外帶/外送日期時段互不污染 | 真實 DOM：`#pDate.value`／`#pTime.value`，來回切換三次 | **PASS** — 外帶恆為 15:30（起始格位），外送恆為 16:00，各自獨立且切回原模式時正確恢復，不互相覆蓋 |
| AI | 地址隔離與恢復 | 真實 DOM：`#deliveryAddress`/`#deliveryAddressNote`.value，`#deliveryAddrWrap`/`#pickupAddrWrap`.style.display | **PASS** — 切到外帶時 `deliveryAddrWrap` 為 `none`、`pickupAddrWrap` 可見；切回外送地址與備註逐字保留（"測試地址A"/"測試備註A"） |
| AJ | 外送時段不污染外帶 | 涵蓋於 AH：外帶 timeslots 陣列與 delivery 陣列各自獨立生成，起始格位不同 | **PASS** |
| AK | 外帶時段不污染外送 | 同上，反向驗證 | **PASS** |
| AL | 外帶 payload 隔離 | 真實攔截 `POST /api/line-orders` request body | **PASS** — 實際攔截到的 payload 完全沒有任何 `delivery_*` 開頭欄位（見下方真實 JSON） |
| AM | 外送 payload 完整 | 同上，真實攔截 | **PASS** — 實際攔截到 `delivery_address`／`delivery_address_note`／`delivery_lat`／`delivery_lng`／`delivery_fee_preview`／`delivery_distance_km_preview` 全部齊全且值正確 |
| AN | 快速切換 race condition | 真實連續呼叫 10 次，檢查最終 DOM 狀態與 JS 錯誤事件 | **PASS** — 最終 `#oType.value`／wrap 顯示與最後一次操作一致，`window.__jsErrors` 為空陣列 |
| AO | F5 恢復 | 建立完整狀態→存 localStorage→**關閉整個 jsdom 實例**→用同一份 localStorage 內容建立全新 jsdom 實例（模擬真實 F5：新的頁面載入週期，共用 localStorage） | **PASS**（6/6）— `cart_id` 不變、購物車不清空、模式/地址/備註正確還原、還原後再切換模式地址仍完整保留 |
| AP | `refreshShopStatus()` 不洗掉地址 | 真實呼叫 `refreshShopStatus()`（含真實 API round-trip），之後檢查 DOM | **PASS** — 呼叫前後地址/備註逐字不變，切換模式後再切回仍完整 |
| 狀態配色 | 每個模式獨立顏色 | `window.getComputedStyle()` 讀取瀏覽器／jsdom CSS 引擎解析後的實際顏色值 | **PASS** — `service-open` 計算結果 `rgb(21,128,61)`（= `#15803d`，與 CSS 定義完全吻合），`service-not-started` 計算結果 `rgb(217,119,6)`（= `#d97706`），兩個 `<span>` 顏色確實不同，不是整條同色 |

**Case AL 實際攔截到的 takeout payload**（節錄，已移除 analytics/attribution 內部欄位）：
```json
{
  "order_type": "takeout", "pickup_date": "2026-07-21", "pickup_time": "16:30",
  "payment_method": "cash", "items": [...], "subtotal": 150, "total": 150
}
```
不含任何 `delivery_address`／`delivery_lat`／`delivery_lng`／`delivery_fee` 等鍵值
（不是設為 `null`，是完全不存在這些 key，與 `delivPayload = isDelivery ? {...} : {}`
的既有實作行為一致）。

**Case AM 實際攔截到的 delivery payload**（節錄）：
```json
{
  "order_type": "delivery", "pickup_date": "2026-07-21", "pickup_time": "...",
  "delivery_address": "台北市信義區測試路1號", "delivery_address_note": "",
  "delivery_lat": 25.03, "delivery_lng": 121.56,
  "delivery_fee_preview": 50, "delivery_distance_km_preview": 3.2
}
```

## 8. 語法與結構 Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 186/186；重複 DOM id：0；無測試用 `console.log`／追蹤程式碼殘留（測試期間
插入的 `console.log('[TRACE]...')` 只存在於暫存測試副本 `/tmp/jsdomtest/line-order.html`，
從未寫入正式原始檔 `public/line-order.html`，已於測試結束後隨整個暫存目錄一併刪除）。
本輪未修改 `routes/line-orders.js`、`resolveFulfillmentState()`、`getFulfillmentStatus()`
今日狀態語意、Business Calendar、首頁 Gate、商品模式 intersection、
`product_mode_not_supported`、Mode Conflict Analytics、Dashboard、LINE Member Gate、
LINE Pay 核心。

## 9. 宅配未修改證明

以 **Hotfix30-B3**（`pos-web-fix18-10-hotfix30-B3-full.zip`）作為直接基礎版本逐檔
SHA-256 比對：

```
public/line-shipping.html
  Hotfix30-B3 : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  本版最終    : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f

routes/line-shipping.js
  Hotfix30-B3 : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  本版最終    : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
```

`diff -q` 兩檔案皆無輸出（無差異）。**宅配功能本版完全未修改。**

## 10. 已知限制

1. **未使用完整瀏覽器（Playwright/Puppeteer）測試**：沙盒網路白名單擋下瀏覽器二進位檔
   下載，改用 jsdom（真實 DOM + 真實 script 執行 + 真實本機 API，但沒有真實 CSS
   layout/paint、沒有真實使用者滑鼠事件）。顏色驗證有使用 `getComputedStyle()`
   確認實際解析後的顏色值，一定程度彌補了這個落差，但仍非 100% 等同真實瀏覽器測試。
2. **`/api/delivery/calculate-fee` 使用固定 stub 值**：因其內部依賴外部 Google Maps
   Routes API，沙盒環境無法真實呼叫，依需求文件明確允許對此請求 stub。這代表 Case AM
   驗證的是「payload 組裝邏輯正確」，不是「距離計算公式本身」（本版也明確未修改距離/
   運費計算公式）。
3. **未逐一測試 Business Calendar 各種特殊營業組合下的顏色狀態**（cutoff／
   today_not_open／holiday／unavailable），只驗證了 open／not_started 兩種最常見情境
   的 computed color。這幾個 class 對應的 CSS 規則在 Hotfix30-B3 已完成且本輪未修改，
   風險較低，但未逐一即時驗證。
4. **F5 恢復測試以「關閉並重建 jsdom 實例＋搬移 localStorage 內容」模擬**，非真實瀏覽器
   的 F5 重新整理行為（例如不會有瀏覽器快取層級的差異）。

## 11. 回退方式

1. 還原 `public/line-order.html` 為 Hotfix30-B3 版本內對應檔案即可（本版只修改這一個
   檔案）。
2. `persistCart()` 新增的 `delivery_lat`/`delivery_lng`/`delivery_distance_km`/
   `delivery_fee` 欄位是純附加欄位，回退後舊版程式碼會直接忽略，不影響任何既有欄位。
3. 未新增後端欄位、未修改資料庫、未修改 migration，回退不需要處理資料庫層面。
4. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
