# Hotfix22-E｜Business Calendar 特殊營業時間未真正覆蓋週營業時間

範圍說明：本次需求單原列兩項（商家公告圖片上傳即時預覽 / Business Calendar 特殊營業修正）。
依對話進度，本輪只完成並驗證「Business Calendar 特殊營業時間」這一項；「商家公告圖片上傳即時預覽」
**尚未開始**，並未包含在本次交付內，請視為下一輪待辦（避免誤報已完成）。

## 一、Root Cause

`GET /api/line-orders/menu`（商品列表 API，前台商品卡的 `takeout_sold_out_reason` /
`delivery_sold_out_reason` 資料來源）在計算「今日售完原因」時，只檢查了：

1. 模式全域開關（`takeout_enabled`/`delivery_enabled`）
2. **整店**休假狀態（`getDateClosedStatus()` → 只有 Business Calendar `mode='closed'` 才會觸發)
3. 截止時間 / 商品販售時段 / LINE 份數

完全沒有檢查「Business Calendar 命中 `custom_hours`（特殊營業），但只關閉其中一個模式（例如只關閉外帶、
開放外送）」這種情況。因為 Business Calendar 的 `mode` 是 `custom_hours` 而不是 `closed`，
`getDateClosedStatus().closed` 會是 `false`，於是這個模式被關閉的事實完全沒有被 `/menu` 察覺，
導致該模式的商品仍顯示為「正常可下單」，即使 `GET /timeslots` 與送單驗證（`validateOrderConditions`）
其實已經正確地在擋（因為這兩處先前就已經有各自獨立、但正確的 Business Calendar 檢查）。

換句話說：**時段來源本身（/timeslots）與送單驗證（POST /line-orders）先前就是對的**；真正壞掉的是
`/menu` 這一個端點的「今日售完原因」欄位，以及 `/shop` 的 `takeout_status.is_closed_day` /
`delivery_status.is_closed_day`（同樣只看整店休假，沒看單一模式的行事曆覆蓋），這兩處資料不一致，
才會讓人感覺「特殊營業設定只顯示在後台摘要，前台/送單沒有真的套用」。

## 二、修正做法

新增單一來源 helper `getEffectiveModeSchedule(db, storeId, mode, dateStr, modeSettings)`，
回傳 `{ enabled, start, end, source }`（`source` 為 `'business_calendar'` 或 `'weekly_schedule'`），
取代原本各自為政的 `resolveModeHoursForDate()` + 內聯判斷，並把它接到所有需要「今日/某日某模式是否可下單、
幾點到幾點」的地方：

- `getDayOpenClose()`（供 `getEarliestMins()`、`GET /timeslots` 使用）→ 內部改為委派 `getEffectiveModeSchedule()`
- `GET /menu`（商品售完原因）→ 新增 `calendar_mode_closed` 判斷，插入在「模式全域關閉」之後、
  「今日截止時間」之前
- `GET /shop`（`takeout_status`/`delivery_status`）→ `is_closed_day` 一併考慮該模式的 Business Calendar
  覆蓋；新增 `schedule_source`、`today_schedule` 欄位供前台判斷
- `validateOrderConditions()`（`POST /validate-cart`、`POST /` 新增訂單共用）→ 原本用
  `closedInfo.calendar.takeout_enabled/delivery_enabled` 直接判斷，邏輯已經正確，這次改為呼叫同一顆
  `getEffectiveModeSchedule()`，訊息文字與行為完全不變，只是換成單一來源，避免以後兩邊各自修改導致再次不一致

## 三、修改檔案

只有一個檔案：`routes/line-orders.js`

- 新增 `getEffectiveModeSchedule()`
- `getDayOpenClose()` 內部改為委派新 helper（移除 `resolveModeHoursForDate()`，功能等價）
- `GET /menu`：新增 `takeoutSchedule`/`deliverySchedule`/`takeoutCalendarModeClosed`/`deliveryCalendarModeClosed`，
  並在 `takeoutSoldOutReason`/`deliverySoldOutReason` 優先序中插入 `calendar_mode_closed`
- `GET /shop`：`takeout_status`/`delivery_status` 新增 `schedule_source`、`today_schedule`，
  修正 `is_closed_day`
- `validateOrderConditions()`：3b 段落改用 `getEffectiveModeSchedule()`（訊息文字不變）
- `module.exports` 新增匯出 `getEffectiveModeSchedule`

**未修改**：`routes/business-calendar.js`（CRUD／優先權架構完全未動）、`getDateClosedStatus()` 的
整店休假優先序判斷邏輯、`routes/coupons.js`、`routes/linepay.js`、POS、Android、`public/*.html`、
`public/js/app.js`。

## 四、API 驗證結果（實機啟動 server.js + 真實 HTTP 呼叫）

測試資料：`2026-07-10`，Business Calendar 特殊營業，外帶不開放，外送 `15:33～23:33`。

### A. `GET /api/line-shop`
```
takeout_status:  { enabled:true, is_closed_day:true,  earliest_today:null,
                    schedule_source:"business_calendar",
                    today_schedule:{ enabled:false, start:null, end:null, source:"business_calendar" } }
delivery_status: { enabled:true, is_closed_day:false, earliest_today:1320,
                    schedule_source:"business_calendar",
                    today_schedule:{ enabled:true, start:"15:33", end:"23:33", source:"business_calendar" } }
```
✅ 外帶 `enabled:false`、來源 `business_calendar`，沒有回退週營業時間；外送時段正確為 `15:33~23:33`。

### B. `GET /api/line-orders/timeslots`（即 `/api/line-timeslots`）
```
takeout  → {"slots":[],"reason":"no_slots_today"}
delivery → {"slots":["22:00","22:30","23:00","23:30"],"earliest":"22:00"}
```
✅ 外帶沒有任何時段；外送只產生 `15:33~23:33` 範圍內的合法時段（22:00 起是因為測試當下實際時間已是
21:17，`max(現在+備餐時間, 15:33)` 算出來就是 22:00，非 bug）；沒有出現任何每週營業時間（`11:00~21:00`）的時段。

### C. `POST /validate-cart`
```
takeout  → {"mode_ok":false,"mode_reason":"calendar_mode_closed"}
delivery → {"mode_ok":true}
```
✅ 完全符合預期。

### D. `POST /api/line-orders`（送單）
```
takeout  → HTTP 403 {"reason":"calendar_mode_closed","message":"2026-07-10 外帶服務依營業行事曆設定暫停服務"}
delivery → 通過 Business Calendar／模式驗證，最終止步於「GOOGLE_MAPS_SERVER_KEY 未設定」
           （沙盒環境無 Google Maps API Key，屬既有外送費計算需求，與本次修正無關）
```
✅ 外帶直接拒絕；外送確認未被 `calendar_mode_closed`/`mode_closed` 擋下，驗證邏輯層完全通過。

### F. 刪除 Business Calendar 後
```
takeout_status.today_schedule:  { enabled:true, start:"11:00", end:"20:00", source:"weekly_schedule" }
delivery_status.today_schedule: { enabled:true, start:"11:00", end:"21:00", source:"weekly_schedule" }
/menu → takeout_sold_out_reason:null, delivery_sold_out_reason:null
```
✅ 刪除後正確恢復每週營業時間（`source` 變回 `weekly_schedule`）。

### G. 今日臨時休息 vs Business Calendar 優先序（誠實回報，未修改任何邏輯）
測試：先只設定「今日臨時休息」→ `today_closed_info.closed:true`（✅ 生效）。
接著**額外**新增一筆 Business Calendar `custom_hours`（兩模式皆開放）→
`today_closed_info.closed` 變回 `false`，`is_closed_day` 變回 `false`，`validate-cart` 變回可下單。

**這代表現行 `getDateClosedStatus()` 的既有優先序是「Business Calendar 命中即優先，不再檢查今日臨時休息」**，
與需求單「今日臨時休息應為最高優先」的描述不一致。這是**既有（本次之前就存在）行為**，本次
completely 沒有修改 `getDateClosedStatus()` 或其優先序（遵照指示「不要改 getDateClosedStatus() 的休假優先邏輯」），
因此如實回報此落差，不在本次自行調整；是否要改優先序，建議另開任務單獨處理及確認影響範圍
（因為這牽動所有既有「Business Calendar 優先」的商家可能已依賴的既有行為）。

## 五、前台驗證結果（程式碼走查，非實機瀏覽器操作）

- **時段刷新**：`switchMode()`/`onModeChange()` 每次都會呼叫 `buildTimeSelector()`，該函式每次都重新打
  `GET /api/line-orders/timeslots`（沒有任何前端快取），因此切換外帶/外送時，時段一定是當下重新查詢
  的結果，不會殘留舊時段。由於後端 `/timeslots` 這次的 root cause 已修正，前台會自動拿到正確結果，
  不需要另外改前端這一段。
- **已知限制（未修改，如實回報）**：日期選單的狀態後綴 `bizCalOptionSuffix()` 目前判斷「是否顯示
  🟡特殊營業」時沒有區分外帶/外送——只要當天有 `custom_hours` 行事曆命中就顯示同樣文字、且不會停用
  該日期，即使該模式其實被行事曆關閉。**這不影響最終能否下單**（因為 `/timeslots`、送單驗證都已經
  正確擋下），只是日期選單上少一個「此模式今日不開放」的視覺提示。由於這次的指示是「不要重新修改架構，
  只完成最後驗證」，這項純前端顯示的微調本次未動，留待下一輪視需要再處理。

## 六、`node --check`

```
node --check server.js                    OK
node --check routes/settings.js           OK
node --check routes/line-orders.js        OK
node --check routes/line-shipping.js      OK
node --check routes/business-calendar.js  OK
node --check public/js/app.js             OK
```
抽取 `public/line-order.html`／`public/line-shipping.html` 內嵌 `<script>` 另存 `.js` 後 `node --check`
皆通過。`index.html`／`line-order.html`／`line-shipping.html`：div 開/閉數量一致（664/664、162/162、
155/155），無重複 `id`。

## 七、Zip 內容

`pos-web-hotfix22-E.zip`，以 Hotfix22-D 為基礎，僅 `routes/line-orders.js` 一個檔案有變動
（已 diff 確認）。不含 `node_modules`／`data/`／`.env`／`*.db`。
