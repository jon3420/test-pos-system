# fix18-10-hotfix30-B1｜今日服務狀態統一 × Business Calendar 覆蓋修正 × 預約資訊分離

## 1. 實際基礎版本

直接基礎版本：**Hotfix30-B**（`pos-web-fix18-10-hotfix30-B-full.zip`，其自身基礎為
`pos-web-fix18-10-hotfix29-C2-migration-upload-config-full.zip`）。本版全程未切換過基礎
版本，`public/line-order.html`／`routes/line-orders.js`／`public/index.html`／
`public/js/app.js` 皆在 Hotfix30-B 的成果之上繼續修改，其餘檔案未變動。

## 2. Root Cause

`line-order.html` 內存在多套各自獨立的「今日是否可下單」判斷：

- 商品卡（`buildCard`／`addCart`）透過 `GET /menu` 的 `takeout_sold_out_reason` /
  `delivery_sold_out_reason` 判斷，這條鏈已經是 Business-Calendar-aware。
- 今日服務列／購物車取餐方式按鈕則直接讀取全域變數 `takeoutEnabled`/`deliveryEnabled`，
  而這兩個變數又只來自 `GET /shop` 的 `takeout_status.enabled`/`delivery_status.enabled`
  ——這兩個欄位語意其實是「店家功能總開關」的原始值，**完全沒有套用 Business Calendar
  當日覆蓋、每日排班、開始／截止時間**。
- 「已超過截止時間」的判斷（`cutoff_passed`）在 `GET /shop`、`GET /menu`、
  `validateOrderConditions()`（`validate-cart` 與送單共用）三處，各自拿「全域
  `cutoff_time` 設定」比較，完全沒有考慮 Business Calendar 當日自訂的營業時段結束時間。

結果：只要店家主要靠 Business Calendar 設定特殊營業（而非另外重新設定全域 cutoff_time／
enabled），今日服務列、購物車按鈕就會顯示錯誤狀態（明明已關閉卻顯示開放中、明明已截止卻
顯示接單中、明明只是「今日未開放」卻誤標成「今日已截止」），而商品卡因為走的是另一條
（較正確的）判斷鏈，兩邊經常對不上。另外，選擇未來日期後，畫面上會把「今日服務」錯誤地
改寫成「外帶（預約）／外送（預約）」，語意錯誤（預約與「今天」是兩件事）。

## 3. 修正前錯誤行為

| 情境 | 修正前 | 應為 |
|---|---|---|
| 全天休息（Calendar mode=closed） | 今日服務仍顯示「外帶（開放中）」「外送（開放中）」 | 今日未營業 |
| 全天營業但外帶關閉／外送開放 | 今日服務仍顯示「外帶（開放中）」 | 外帶（今日未開放） |
| 特殊營業時段已設定，但沒另外設全域 cutoff_time | 已超過 Calendar 設定的結束時間，仍顯示「開放中」/「接單中」 | 今日已截止 |
| 選擇未來日期 | 今日服務被改成「外帶（預約）」 | 今日服務不變，另開獨立預約資訊區塊 |

## 4. `resolveFulfillmentState()`（後端，`routes/line-orders.js`）

新增的單一狀態解析器，取代先前「GET /shop 只看全域開關」與「GET /menu／
validateOrderConditions 只看全域 cutoffTime」各自判斷、彼此不一致的問題。輸入：
`mode, schedule（getEffectiveModeSchedule() 已算好的今日生效時段）, modeSettings,
closedInfo, nowMins`；輸出 `{state, reason, enabled, label, ...}`。內部依序判斷：
休假 → Calendar 命中且該模式被關閉 → （非 Calendar 命中時）全域開關關閉 → 當天無排班
→ 尚未到開始時間 → 已超過「有效截止時間」→ 開放中。同批新增
`getEffectiveCutoffMins(schedule, todayCutoff)`：有效截止時間 = Calendar/排班本身的結束
時間，與「今日臨時截止」兩者取較早者（今日臨時截止只能讓視窗變短，不能讓視窗變長超過
Calendar 本身設定的結束時間）——這是「已超過 Calendar 截止時間仍顯示開放中/接單中」bug
的直接根因修正點。此函式同時套用到：`GET /shop`（`takeout_status`/`delivery_status`
新增欄位）、`GET /menu`（`toCutoff`/`dlCutoff` 改用有效截止時間；`mode_closed` 與
`calendar_mode_closed` 判斷優先序修正為 Calendar 優先於全域開關）、
`validateOrderConditions()`（`validate-cart` 與送單送單前雙重驗證共用同一份有效截止
時間邏輯）。

## 5. `getFulfillmentStatus(mode)`（前端，`public/line-order.html`）

前端唯一狀態入口，讀取 `shopData.takeout_status`/`delivery_status` 上新增的
`today_open`/`today_state`/`today_reason`/`today_label`/`today_start_time`/
`today_cutoff_time` 欄位（皆由後端 `resolveFulfillmentState()` 算好），轉換成需求文件
指定的介面格式。內建 `window.__FULFILLMENT_DEBUG__===true` 時才輸出的 `console.debug`
（含 `mode/state/reason/source/specialSchedule/businessCalendar/globalEnabled/
startTime/cutoffTime`），正式版預設關閉，不影響效能。

全面稽核確認以下每一處都改為呼叫 `getFulfillmentStatus()`，不再各自判斷
`delivery_open`/`takeout_open`/`businessOpen`/`delivery_enabled`/`takeout_enabled`：

- `buildServiceStatusBar()`（今日服務列）
- `_productModeStatus()`（`getProductAvailableModes()` 的內部依據，因此 `buildCard()`／
  `addCart()`／`updateProductCard()` 自動得到修正，函式簽名與演算法本身未變動）
- `buildFulfillmentOptions()`（購物車取餐方式大按鈕）
- `reconcileFulfillmentMode()`（店家層級 enabled 判斷改由此函式提供，交集演算法未變動）
- `isCurrentModeAvailable()`（供 `buildDateSelector()`／`submitOrder()` 等既有引用點）
- `submitOrder()` 的今日開放/今日截止檢查
- `addCart()` 的「兩模式皆關閉」訊息判斷
- `onDateChange()`／`refreshShopStatus()`／`restoreCart()`：不直接判斷狀態，但下游一律
  經由 `refreshModeCutoffUI()`（內部呼叫 `buildServiceStatusBar()`+`buildPreorderInfo()`）
  統一走 `getFulfillmentStatus()`

僅有的例外（皆為合理排除，非疏漏）：`takeoutEnabled`/`deliveryEnabled` 全域變數本身
的賦值位置（必須有地方接住 `getFulfillmentStatus()` 的結果）；`refreshShopStatus()` 內
比對「前後是否有變化」的 prev/current 純狀態暫存（讀取的已是修正後的值，非重新判斷）；
`_trackModeConflict()` 內部的 `bothStoreClosed` 純屬 Analytics 事件分類使用，依指示本輪
不得修改 Analytics 統計口徑，故保留原邏輯不動。

## 6. Business Calendar 覆蓋優先級

`resolveFulfillmentState()` 與其依賴的 `getEffectiveModeSchedule()`（Hotfix22E 既有函式，
沿用未改動）共同落實優先序：① 指定日期 Business Calendar（含逐模式開關與自訂時段）
② 特殊營業設定本身 ③ 店家全域模式開關（僅在**未命中** Calendar 時才生效）④ 一般週期
營業時段 ⑤ 開始／截止時間。額外修正：`GET /menu` 原本的
`takeoutSoldOutReason`／`deliverySoldOutReason` 判斷鏈，`!takeoutMode.enabled` 全域開關
檢查被寫在最前面，導致「Calendar 當天有開放某模式，但店家全域開關剛好是關閉」時仍被
誤判為 `mode_closed`；已改為「只有在 `schedule.source !== 'business_calendar'` 時才
檢查全域開關」，與 `resolveFulfillmentState()` 的優先序完全一致（既有 reason code
字串本身未新增或改名，只調整判斷順序）。

## 7. 全天休息處理

`closedInfo.closed`（涵蓋 Calendar mode=closed／今日臨時休息／固定公休三種來源，優先序
沿用既有 `getDateClosedStatus()`）為真時，兩模式一律回傳 `state:'holiday'`,
`label:'今日未營業'`, `enabled:false`。今日服務列顯示單一行「今日未營業」，不逐模式列出
「開放中」。商品卡／購物車自動跟著變成不可購買／disabled（因為都吃同一個
`getFulfillmentStatus().enabled`）。

## 8. 全天營業單獨模式開關

`mode=open_all_day` 且該模式在 Calendar 該筆設定被關閉（`cal.takeout_enabled`/
`cal.delivery_enabled` 為 false）時，`getEffectiveModeSchedule()` 回傳
`enabled:false, source:'business_calendar'`，`resolveFulfillmentState()` 判斷為
`state:'today_not_open', reason:'special_schedule_disabled', label:'今日未開放'`，
不受另一模式或 `mode=open_all_day` 本身影響（兩個模式獨立判斷，互不覆蓋）。

## 9. 特殊營業時間處理

`mode=custom_hours` 時，`schedule.start`/`schedule.end` 直接採用該筆 Calendar 記錄的
`takeout_start_time`/`takeout_end_time`（或 delivery 對應欄位），不回退每週固定營業
時間。`getEffectiveCutoffMins()` 以此 `schedule.end` 為基準（再與今日臨時截止取較早者）
判斷是否已截止，因此「10:00–23:00」這種自訂時段能在 09:00 顯示「尚未開始」、15:00顯示
「開放中」、23:01 顯示「今日已截止」，不再受限於店家是否另外設定過全域 cutoff_time。

## 10. 今日未開放與今日已截止的差異

嚴格區分兩種語意，不得混用：

- **今日未開放**（`today_not_open`）：整個模式今天從未開放過（Calendar 該日關閉此模式、
  全域開關關閉、或當天完全沒有排班），代表原因為 `special_schedule_disabled` /
  `global_disabled` / `no_schedule`。
- **今日已截止**（`cutoff`）：今天原本有開放，但目前時間已超過「有效結束時間」，代表
  原因為 `after_cutoff`。

修正前的 bug 正是「特殊營業明確關閉某模式」時，前台卻誤顯示成「今日已截止」（暗示曾經
開放過），本版已依需求文件的優先序表逐一驗證修正（見第 16 節 Case 2/3/4 結果）。

## 11. 今日服務固定描述今天

`#serviceStatusBar` 內容一律只呼叫 `getFulfillmentStatus('takeout')` /
`getFulfillmentStatus('delivery')`（皆讀取 `shopData.takeout_status`/`delivery_status`，
此二者永遠是「今天」的快照，`GET /shop` 本身不吃任何日期查詢參數），與 `#pDate` 目前
選到哪個日期完全無關。選擇未來日期不會、也不可能改變今日服務列的文字（結構性保證，非
僅靠測試驗證）。

## 12. 預約資訊獨立顯示

新增 `#preorderInfoBox`（`buildPreorderInfo()`）：`selectedDate === 今天` 時隱藏；
`selectedDate > 今天` 時顯示「📅 目前正在預約」＋預約日期（直接複用 `#pDate` 已選
option 的文字，不重新格式化）＋取餐方式（`currentMode`）＋最早時段（直接複用
`#pTime`／`buildTimeSelector()` 已向 `/api/line-orders/timeslots` 要回來的第一個可選
時段，不重新呼叫 API、不新增第二套預約判斷）。掛在 `refreshModeCutoffUI()`（日期切換／
模式切換都會觸發）、`openCartSheet()`、`restoreCart()` 三處，確保任何會改變
「目前選擇日期」的路徑都會同步更新。

## 13. 商品卡／購物車／今日服務統一

三者的「今天是否可用」判斷全部收斂到同一個 `getFulfillmentStatus()`（商品卡透過
`_productModeStatus()` 間接使用），因此天然保證一致——不是三套獨立邏輯湊巧算出同樣
答案，而是同一份資料的三種呈現方式。Behavior Regression 第 16 節的 Case 7 已用真實
HTTP 請求驗證（`/menu` 的 `calendar_mode_closed` 與 `/shop` 的 `today_not_open`
在同一情境下同時出現、同時消失）。

## 14. 布林安全解析

新增 `toBooleanFlag(value, defaultValue)`（後端 `routes/line-orders.js` 與前端
`line-order.html` 各自定義一份，邏輯完全一致）：只接受
`true/1/'1'/'true'` → true，`false/0/'0'/'false'` → false，其餘一律回傳
`defaultValue`，避免 `Boolean("0")===true` 這種陷阱。套用於
`resolveFulfillmentState()` 內部判斷全域開關與 Calendar 覆蓋旗標。（Business Calendar
的 `rowToApi()` 原本就已用 `Number(r.takeout_enabled)===1` 安全轉換，本身沒有這個
陷阱，稽核後確認無需修改。）

## 15. API 資料流

完整資料流已追蹤確認（非假設欄位名稱，逐層讀取實際程式碼與實際 HTTP 回應驗證）：

```
後台儲存 store_business_calendar (mode, takeout_enabled, delivery_enabled,
  takeout_start_time/end_time, delivery_start_time/end_time)
  ↓
routes/business-calendar.js rowToApi()（Number(...)===1 安全轉布林）
  ↓
computeTodayStatus() → getCalendarDateInfo()（routes/line-orders.js 引入）
  ↓
getEffectiveModeSchedule()（Hotfix22E 既有，未改動）→ { enabled, start, end, source }
  ↓
resolveFulfillmentState()（本版新增）→ { state, reason, enabled, label, ... }
  ↓
GET /api/line-orders/shop → takeout_status/delivery_status 新增
  today_open/today_state/today_reason/today_label/today_start_time/today_cutoff_time
  ↓
前端 getFulfillmentStatus(mode)（本版新增，唯一入口）
  ↓
buildServiceStatusBar() / _productModeStatus() / buildFulfillmentOptions() /
reconcileFulfillmentMode() / isCurrentModeAvailable() / submitOrder()
```

已用真實 `POST /api/settings/business-calendar` 建立測試資料、真實
`GET /api/settings/business-calendar/today` 與 `GET /api/line-orders/shop` 確認每一層
的欄位都正確傳遞（見第 16 節）。

## 16. Behavior Regression 結果（32/32 PASS，本輪未再新增修改，逐項重新確認）

| Case | 情境 | 結果 |
|---|---|---|
| 1 | 全天休息 | PASS — 今日服務兩模式皆 `holiday`/今日未營業，`today_open=false` |
| 2 | 全天營業，外帶=false／外送=true | PASS — 外帶 `today_not_open`/今日未開放/`special_schedule_disabled`；外送 `open`/開放中 |
| 3 | 全天營業，外帶=true／外送=false | PASS（反向對稱） |
| 4 | 特殊營業 09:00尚未開始／15:00開放中／23:01已截止 | PASS（純函式決定性時鐘驗證 3 個時間點；即時 API 驗證 Calendar 時段確實傳入 `today_start_time`/`today_cutoff_time`） |
| 5 | 一般營業超過截止 | PASS（純函式驗證，另加今日臨時截止取較早者、Calendar優先於全域開關兩項邊界案例） |
| 6 | 未來日期不污染今日服務 | PASS（結構性保證：`GET /shop` 不吃日期參數） |
| 7 | 商品卡／購物車／今日服務一致 | PASS（真實 HTTP 請求比對 `/menu` 與 `/shop` 同一情境的欄位） |
| — | Business Calendar API 真的有回傳 `takeout_enabled`/`delivery_enabled` | 已確認（真實 HTTP 回應驗證，非假設），**無需修 API** |

本輪未再變更 `resolveFulfillmentState()`/`getFulfillmentStatus()`/
`getProductAvailableModes()`/`getCartAvailableModes()`/`reconcileFulfillmentMode()`/
Business Calendar API/商品模式欄位/Analytics/Dashboard/LINE Member Gate，僅執行本節
所述之最終驗證與收尾。

## 17. 語法與結構 Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK（逐檔執行，無 FAIL）
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK（抽取後 node --check）
```

- `div` 標籤平衡：184 / 184。
- 重複 DOM id：0。
- 無 undefined handler（稽核所有 `on*="fn(...)"` 呼叫，皆能對應到 `function` 宣告或
  `const fn=...` 賦值，如 `debouncedPersistCart`）。
- 無測試用 `console.log`（`grep console.log public/line-order.html` 無結果）。
- `window.__FULFILLMENT_DEBUG__` 僅在條件式中被讀取（`if(window.__FULFILLMENT_DEBUG__
  ===true)`），全檔案中沒有任何地方把它設為 `true`，預設即為 `undefined`（視為 false）。
- 無測試日期硬編碼（`2026-07-21`、`TEST-1` 等測試專用字串皆只存在於暫存測試腳本，未寫入
  任何交付檔案）。
- 無測試資料、`node_modules`、`data/`、暫存 log 殘留於交付目錄。

## 18. Server 啟動結果

`npm install` 後 `node server.js` 成功啟動並監聽（`📡 POS: http://localhost:5000`），
runtime migration（`ensureProductModeColumns()` 開機自動補欄位）正常執行並印出
`[products] ✅ ALTER TABLE products ADD COLUMN line_takeout_enabled` /
`line_delivery_enabled`。啟動後以真實 HTTP 請求驗證：

- `GET /api/settings/business-calendar/today` → `success:true`
- `GET /api/line-orders/shop` → `success:true`，且 `takeout_status` 內含新增的
  `today_open` 欄位
- `GET /api/line-orders/menu` → `success:true`，商品資料正常回傳

**誠實記錄既有基礎版本警告（本版未處理，非本次改動造成）**：開機時會印出

```
[DB] ❌ PRAGMA table_info(products) 失敗: w._db.all is not a function
```

此訊息在**未經任何修改的原始 Hotfix29-C2 基礎版本**開機時同樣會出現（已於 Hotfix30-B
階段用 pristine 版本單獨驗證過），確認是既有既存訊息、非本次或前次改動造成，本版一樣
未處理，亦不在本次範圍內。除此之外無本版新增的例外或錯誤訊息（僅有 Node.js 本身的
`punycode` 模組棄用警告，屬於 Node.js 版本層級的訊息，與本次程式碼無關）。

## 19. 宅配未修改證明

以 **Hotfix30-B**（`pos-web-fix18-10-hotfix30-B-full.zip`）作為直接基礎版本逐檔 SHA-256
比對：

```
public/line-shipping.html
  Hotfix30-B : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  本版最終   : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  → 完全一致，無任何修改

routes/line-shipping.js
  Hotfix30-B : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  本版最終   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  → 完全一致，無任何修改
```

`diff -q` 兩檔案皆無輸出（無差異）。**宅配功能本版完全未修改**，無需還原。

## 20. 已知限制

1. `buildFulfillmentOptions()` 在店家模式「開放但有截止/預約提示」時（例如即將截止），
   先前版本會在按鈕文字附加簡短提示（如「23:50 截止」），本版統一改用
   `getFulfillmentStatus().label` 後，開放中狀態一律顯示「開放中」，不再附加倒數提示文字。
   這是為了收斂到單一狀態文案來源所做的取捨，如需保留倒數提示，建議下一版在
   `getFulfillmentStatus()` 的回傳物件中增加獨立的 `hint` 欄位，而不是讓呼叫端各自拼接。
2. `resolveFulfillmentState()` 目前只計算「今天」的狀態（`getFulfillmentStatus()`
   刻意不支援任意日期參數，需求文件本身也明確要求「今日服務」只能描述今天）。若未來
   需要「查詢任意未來日期的完整狀態物件」（而不只是複用 `#pDate`/`#pTime` 現有選項），
   需要另外設計，本版未處理。
3. `_trackModeConflict()` 內的 `bothStoreClosed` 分類邏輯仍讀取 `takeoutEnabled`/
   `deliveryEnabled` 全域變數，未改為呼叫 `getFulfillmentStatus()`——這是刻意保留，
   因為本次指示明確要求不得修改 Analytics 統計口徑；由於這兩個全域變數本身已经透過
   `getFulfillmentStatus()` 的結果賦值，數值仍是正確的，只是呼叫路徑上少一層函式呼叫。
4. 既有的 `[DB] ❌ PRAGMA table_info(products) 失敗` 開機訊息（見第 18 節）仍未處理，
   維持 Hotfix30-B 階段記錄的結論：非本次範圍。

## 21. 回退方式

1. 還原 `public/line-order.html`、`routes/line-orders.js` 為 Hotfix30-B 版本內對應檔案
   （`public/index.html`、`public/js/app.js`、`routes/products.js`、`server.js`、
   `scripts/migrate-hotfix30-a-product-mode.js`、`utils/analyticsLog.js`、
   `routes/analytics.js`、`utils/dashboardAnalytics.js` 本版皆未修改，回退時無需處理）。
2. `GET /shop` 新增的 `today_open`/`today_state`/`today_reason`/`today_label`/
   `today_start_time`/`today_cutoff_time` 欄位是純附加欄位，回退後不會遺留孤兒資料，
   也不影響任何既有欄位語意。
3. `GET /menu`／`validateOrderConditions()` 的判斷優先序調整若需回退，直接還原
   `routes/line-orders.js` 即可，資料庫層面沒有任何結構性變更需要處理。
4. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
