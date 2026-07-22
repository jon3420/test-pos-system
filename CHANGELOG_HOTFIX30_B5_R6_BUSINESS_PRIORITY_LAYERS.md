# fix18-10-hotfix30-B5-R6｜今日臨時休息最高優先 × 店家營業層與商品販售層分離

基礎版本：**Hotfix30-B5-R5**（`pos-web-fix18-10-hotfix30-B5-R5-full.zip`）。**只修改
`routes/line-orders.js` 一個檔案的一個函式**（`getDateClosedStatus()`），其餘所有檔案
（含 `routes/line-shipping.js`、`public/line-order.html`、`utils/*.js`、`scripts/*.js`
等）與 R5 逐位元組（byte-identical）——已用 `diff -rq` 對整個工作目錄逐檔案比對確認，
差異報告只列出 `routes/line-orders.js` 一個檔案。

## 1. Root Cause（先回答需求文件第十四項要求的五個問題）

1. **今日臨時休息在哪裡被特殊營業覆蓋**：`getDateClosedStatus()`。舊版函式的判斷順序是
   「先查 Business Calendar（命中就直接回傳），查不到才查今日臨時休息」：
   ```js
   function getDateClosedStatus(db, storeId, dateStr) {
     const cal = getCalendarDateInfo(db, storeId, dateStr);
     if (cal.matched) {                          // ← Business Calendar 先判斷
       return { closed: cal.mode === 'closed', source: 'calendar', ... };
     }
     // 今日臨時休息只有在 Business Calendar 沒有命中時才會被檢查到
     if (dateStr === todayStr) {
       const todayClosed = ...line_today_closed...
       if (todayClosed) return { closed: true, source: 'today_closed', ... };
     }
     ...
   }
   ```
   只要店家當天「同時」設定了今日臨時休息＝ON，又剛好有一筆 Business Calendar 特殊營業
   （`custom_hours`／`open_all_day`）涵蓋當天，`cal.matched` 會先成立並直接 return，
   今日臨時休息的檢查永遠不會被執行到——今日臨時休息因此形同虛設。
2. **`/shop` 是否先判斷臨時休息**：**修正前否，修正後是**。`/shop` 本身沒有另外判斷休假，
   完全委派 `getDateClosedStatus()` 的回傳值（`todayClosedStatus`／`closedInfo`），
   函式內部順序錯了，`/shop` 就跟著錯。
3. **`/timeslots` 是否先判斷臨時休息**：**修正前否，修正後是**。`/timeslots` 呼叫
   `isClosedDate()`（`getDateClosedStatus()` 的相容包裝），同樣的問題。
4. **`/menu` 是否仍會因特殊營業把今日臨時休息變成可買**：**修正前是，修正後否**。`/menu`
   的 `dayClosedReason` 同樣來自 `getDateClosedStatus()`；一旦該函式回傳
   `source:'calendar', closed:false`（因為特殊營業是 `custom_hours` 而非 `closed`），
   `dayClosedReason` 就是 `null`，商品的 `takeout_sold_out_reason` 便會往下走到
   `calendar_mode_closed`／`cutoff_sold_out`／`product_time_ended` 等判斷，商品因此在
   今日臨時休息時仍可能顯示為可購買。
5. **前端是否有自行重新覆蓋狀態**：**沒有**。`public/line-order.html` 的
   `getFulfillmentStatus()`／`evaluateHomepageFulfillmentGate()`／`buildServiceStatusBar()`
   等函式全部只讀取後端回傳的 `today_state`／`today_holiday_source`／
   `takeout_sold_out_reason` 等欄位，本身沒有第二套判斷邏輯，也沒有自行比較
   Business Calendar 與今日臨時休息的優先序。前端已經正確處理 `holidaySource`
   （`today_closed` vs `calendar`/`weekly`/`specific` 顯示不同文案），問題 100% 在後端
   單一函式的判斷順序，不需要修改任何前端程式碼。

**結論**：Root Cause 是 `getDateClosedStatus()` 內部的優先序寫反了（Business Calendar
被放在今日臨時休息之前），不是「混用一條權重鏈」本身有邏輯錯誤，而是這條鏈的其中兩個
環節順序對調了。修正方式：把「今日臨時休息」的判斷移到函式最前面，命中即直接回傳，
不再讀取／套用 Business Calendar。

## 2. 舊版單一權重鏈的問題

舊版並非完全沒有優先序，而是優先序本身錯誤：

```
舊：Business Calendar  >  今日臨時休息  >  固定公休/指定店休
新：今日臨時休息        >  Business Calendar  >  固定公休/指定店休
```

這個錯誤只在「今日臨時休息與 Business Calendar 特殊營業同一天同時存在」時才會爆發，
平常任一邊沒設定時完全看不出問題，這也是為什麼這個 bug 在先前的 Hotfix30-B5-R2～R5
（皆聚焦在「Business Calendar 本身判斷是否正確」）都沒有被抓到——先前的 Case 沒有同時
測試「今日臨時休息 + Business Calendar 同天並存」這個組合。

## 3. 店家營業層（本次審計結果：其餘部分本來就已經是獨立分層，不需重新設計）

審計 `getEffectiveModeSchedule()`／`resolveFulfillmentState()`／`GET /shop`／
`GET /timeslots`／`validateOrderConditions()` 後確認：這些函式本來就只處理「店家今天
是否營業」，且已經是單一資料來源（`getEffectiveModeSchedule()`），沒有跟商品層邏輯
混在一起。實際優先序（修正後）：

```
LINE 點餐總開關（line_ordering_enabled，validateOrderConditions() 第 1 項既有邏輯，
                本次未改，送單時最優先攔截，不受本次修正影響）
  → 今日臨時休息（getDateClosedStatus()，本次修正：改為最高優先）
    → 今日特殊營業 Business Calendar（getEffectiveModeSchedule()，既有邏輯不變）
      → 每週營業時間（getEffectiveModeSchedule() 回退分支，既有邏輯不變）
        → takeoutStatus / deliveryStatus（resolveFulfillmentState()，既有邏輯不變）
```

`resolveFulfillmentState()` 本身完全未修改一行——它一開始就是先檢查
`closedInfo.closed`（來自 `getDateClosedStatus()`）才看 `schedule`，只要
`getDateClosedStatus()` 回傳正確，`resolveFulfillmentState()` 自然正確。

## 4. 商品販售層（本次審計結果：本來就已經正確分離，不需修改）

審計 `GET /menu` 內的商品判斷鏈（`_computeProductTimeReason()`／
`takeoutSoldOutReason`／`deliverySoldOutReason` 的組成順序）後確認，優先序本來就是：

```
商品自身模式開關(product_mode_disabled)
  → dayClosedReason（今日休假，來自 getDateClosedStatus()）
    → calendarModeClosed（Business Calendar 單一模式關閉）
      → 全域模式開關(mode_closed)
        → cutoff(cutoff_sold_out)
          → 商品 LINE 時段(product_time_ended / product_not_started)
            → LINE 份數(real_sold_out)
```

`dayClosedReason` 已經排在 `calendarModeClosed` 之前，商品層本來就不會、也不能讓
「特殊營業」或「商品自己的 LINE 時段／庫存」反過來改寫「今日是否營業」這個結論——只要
`getDateClosedStatus()` 回傳的 `closed` 正確，商品層的判斷自動正確，這也是為什麼本次
只需要修正一個後端函式就能同時修好 `/shop`／`/timeslots`／`/menu` 三個端點。

## 5. 今日臨時休息最高優先（實際程式碼修正）

```diff
- function getDateClosedStatus(db, storeId, dateStr) {
-   const cal = getCalendarDateInfo(db, storeId, dateStr);
-   if (cal.matched) {
-     return { closed: cal.mode === 'closed', source: 'calendar', isWeekly: false, calendar: cal };
-   }
-   const todayStr = twDateStr();
-   if (dateStr === todayStr) {
-     const todayClosed = getSetting(db, storeId, 'line_today_closed', '0') === '1'
-       && getSetting(db, storeId, 'line_today_closed_date', '') === todayStr;
-     if (todayClosed) {
-       return { closed: true, source: 'today_closed', isWeekly: false, calendar: null };
-     }
-   }
+ function getDateClosedStatus(db, storeId, dateStr) {
+   const todayStr = twDateStr();
+   if (dateStr === todayStr) {
+     const todayClosed = getSetting(db, storeId, 'line_today_closed', '0') === '1'
+       && getSetting(db, storeId, 'line_today_closed_date', '') === todayStr;
+     if (todayClosed) {
+       // 今日臨時休息命中：最高優先，直接回傳，不再讀取／套用 Business Calendar 當天設定。
+       return { closed: true, source: 'today_closed', isWeekly: false, calendar: null };
+     }
+   }
+   const cal = getCalendarDateInfo(db, storeId, dateStr);
+   if (cal.matched) {
+     return { closed: cal.mode === 'closed', source: 'calendar', isWeekly: false, calendar: cal };
+   }
    const dow = WD_KEYS[parseLocalDate(dateStr).getDay()];
    ...
  }
```

只調換兩段程式碼的先後順序，沒有新增判斷條件、沒有改變任何回傳欄位的結構
（`{ closed, source, isWeekly, calendar }` 完全不變），`isClosedDate()`（相容包裝）與
所有呼叫端（`/shop`、`/menu`、`/timeslots`、`validateOrderConditions()`）的介面
零改動，只有回傳「值」在「今日臨時休息與 Business Calendar 同天並存」這一種情境下
會不同（改為正確值）。另外同步更新了函式上方與周邊 5 處已經過時的優先序註解
（原本寫「Business Calendar > 今日臨時休息」），使其反映修正後的實際順序，純文件性
修改、不影響任何執行邏輯。

## 6. 特殊營業覆蓋每週營業（審計結果：既有邏輯，本次未改，Case R6-3/R6-4 驗證通過）

`getEffectiveModeSchedule()` 本次一行未改。當天命中 Business Calendar
（`cal.matched && cal.mode!=='closed'`）時，直接用該筆行事曆的
`takeout_enabled`／`takeout_start_time`／`takeout_end_time`（或 delivery 對應欄位）
回傳，完全不讀取每週營業時間設定；只有沒命中行事曆時才回退每週營業時間。

## 7. 特殊營業覆蓋商品 LINE 販售時間（審計結果：Hotfix30-B5-R3 既有邏輯，本次未改）

`_computeProductTimeReason(schedule, sellStart, sellEnd)`：當 `schedule.source ===
'business_calendar'` 時直接回傳 `{reason:null, preSale:false}`，完全略過商品自己的
`line_sell_start`／`line_sell_end`。本次追蹤確認這段邏輯從 R3 開始就是正確的，
唯一的風險是它依賴 `schedule.source`，而 `schedule`（`takeoutSchedule`／
`deliverySchedule`）本身不看 `closedInfo`——但因為 `dayClosedReason`（來自已修正的
`getDateClosedStatus()`）在商品判斷鏈中排在 `calendarModeClosed`／商品時段判斷之前
（見上方第 4 節），今日臨時休息命中時商品一律先被 `dayClosedReason` 攔截，不會、也
不需要走到 `_computeProductTimeReason()` 這一段，兩者不會互相干擾。

## 8. 硬性商品限制保留（審計結果：既有邏輯，本次未改，Case R6-6/R6-7 驗證通過）

商品自身模式開關（`product_mode_disabled`）、LINE 份數售罄（`real_sold_out`）等
判斷在 `takeoutSoldOutReason`／`deliverySoldOutReason` 三元運算鏈中的位置本次完全
未變動，Business Calendar 的開放與否無法覆蓋這些欄位（見下方 Case R6-6、R6-7 的
真實 API 回應）。

## 9. Case R6-1～R6-10 結果（真實本機伺服器 + 真實 API 請求，非模擬）

測試環境：`npm install` 安裝相依套件後，於本機以 `PORT=5099 node server.js` 啟動
Hotfix30-B5-R6 程式碼（修正後），另外在獨立埠號以未修正的 R5 程式碼啟動對照組
（僅用於第 R6-1 節重現舊版 bug 之對照，測完即關閉、未保留於交付內容）。所有請求皆為
真實 HTTP 呼叫 `/api/line-shop`、`/api/line-menu`、`/api/line-timeslots`、
`/api/settings`、`/api/settings/business-calendar`，測試時間點：2026-07-22（台灣時間）
17:5x。

| Case | 情境 | 結果 |
|---|---|---|
| R6-1 | 今日臨時休息 ON，同時特殊營業外帶開 06:42~23:42／外送關 | **PASS** — `/shop`：`takeout_status.today_state="holiday"`、`delivery_status.today_state="holiday"`、兩者 `today_holiday_source="today_closed"`（未被 Business Calendar 覆蓋成 `"calendar"`）、`is_open=false`；`/timeslots?mode=takeout`／`?mode=delivery` 皆回傳 `slots:[]`、`reason:"closed_day"`。**對照組（未修正的 R5 程式碼，相同情境）**：`takeout_status.today_state="open"`、`schedule_source="business_calendar"`，`/timeslots?mode=takeout` 回傳非空的 11 個時段（18:30~23:30）——**證實修正前確實存在此 bug，修正後已消除**。 |
| R6-2 | 今日臨時休息 ON，`takeout_allow_next_day=1` | **PASS** — `/shop` 回傳 `takeout_status.allow_next_day=true`（`resolveFulfillmentState()` 的 `canPreorder` 欄位），`holiday_banner={active:true, type:"today_closed"}`，前端既有 `evaluateHomepageFulfillmentGate()`／`renderHolidayPreorderBanner()` 邏輯（本次未改）依此顯示「今日臨時休息，可預約其他營業日」而非整頁封鎖，今天本身仍是 `today_state="holiday"`（不可今日取餐）。 |
| R6-3 | 今日臨時休息 OFF，特殊營業外帶開 06:42~23:42／外送關 | **PASS** — `/shop`：`takeout_status.schedule_source="business_calendar"`、`today_state="open"`、`today_start_time="06:42"`、`today_cutoff_time="23:42"`；`delivery_status.today_state="today_not_open"`、`today_reason="special_schedule_disabled"`。`/timeslots?mode=takeout` 回傳 11 個時段（18:30~23:30，與 `/shop` 的 `today_start_time`/`today_cutoff_time` 一致）；`/timeslots?mode=delivery` 回傳 `slots:[], reason:"mode_closed"`。每週營業時間（09:00~21:00）完全未被使用。 |
| R6-4 | 今天沒有任何 Business Calendar 記錄 | **PASS** — `/shop`：`takeout_status.schedule_source="weekly_schedule"`、`today_state="open"`、時段為每週營業設定的 `09:00~21:00`；`delivery_status` 同步一致。 |
| R6-5 | 特殊營業開放外送 00:10~22:10，商品自己的 LINE 時段設為 06:00~12:00（已結束，現在 17:5x） | **PASS** — `/menu` 回傳 `delivery_sold_out_reason=null`（可正常購買），未出現 `product_time_ended`，證實特殊營業正確覆蓋商品自身 LINE 販售時段。 |
| R6-6 | 承上情境，額外開啟商品 LINE 份數（`line_quota_daily=5, line_quota_sold=5`，已售罄） | **PASS** — `/menu` 回傳 `delivery_sold_out_reason="real_sold_out"`，特殊營業無法覆蓋份數售罄，硬性限制保留。 |
| R6-7 | 特殊營業只開外帶（00:10~22:10），商品設為只支援外送（`line_takeout_enabled=0`） | **PASS** — `/menu` 回傳 `takeout_sold_out_reason="product_mode_disabled"`（維持不可購買），`delivery_sold_out_reason="calendar_mode_closed"`（因為當天外送本身被行事曆關閉，屬預期的另一個獨立限制，非本 Case 驗證重點），證實特殊營業不會忽略商品自身模式限制。 |
| R6-8 | 沒有 Business Calendar 記錄，商品 LINE 時段尚未開始（23:50~23:59，現在 17:5x） | **PASS** — `/menu` 回傳 `takeout_sold_out_reason="product_not_started"`、`delivery_sold_out_reason="product_not_started"`，保持原本商品 LINE 時段限制。 |
| R6-9 | 今日臨時休息 ON，商品 LINE 時段清空（不受限）、份數未啟用（無限制），`allow_next_day=1` | **PASS** — `/menu` 回傳 `takeout_sold_out_reason="today_closed"`、`delivery_sold_out_reason="today_closed"`（今天不可立即下單），`takeout_can_next_day=true`、`delivery_can_next_day=true`（可預約明日）。 |
| R6-10 | 今日臨時休息取消後重新載入：(a) Business Calendar 仍在 (b) 之後移除 Business Calendar | **PASS** — (a) `/shop` 回傳 `schedule_source="business_calendar"`、`takeout` `today_state="open"`（恢復特殊營業）；(b) 移除行事曆後 `/shop` 回傳 `schedule_source="weekly_schedule"`、雙模式 `today_state="open"`（恢復每週營業）。 |

**本輪累計：10/10 PASS，0 FAIL**（含 Case R6-1 修正前 FAIL → 修正後 PASS 的
真實對照組證據）。

## 10. Regression（依需求文件第十七項執行）

```
node --check server.js                    → OK
node --check routes/*.js                  → OK（全部檔案逐一通過）
node --check utils/*.js                   → OK（全部檔案逐一通過）
node --check public/js/*.js               → OK（全部檔案逐一通過）
node --check scripts/*.js                 → OK（全部檔案逐一通過）
抽取 public/line-order.html 內 2 個 <script> 區塊 → node --check → OK
```

另確認：

- `/shop` 優先序正確（Case R6-1、R6-3、R6-4、R6-10）。
- `/timeslots` 優先序正確，且與 `/shop` 一致（Case R6-1、R6-3）。
- `/menu` 商品狀態正確（Case R6-5～R6-9）。
- 今日臨時休息高於特殊營業（Case R6-1，含 R5 對照組證實修正前後差異）。
- 特殊營業高於每週營業（Case R6-3、R6-4、R6-10）。
- 特殊營業高於商品 LINE 時段（Case R6-5）。
- 特殊營業不能覆蓋庫存／模式／停售（Case R6-6、R6-7）。
- 商品卡排版完全未變（見第 11 節）。
- shipping 相關檔案與 R5 byte-identical（見第 12 節）。
- 無測試資料與 trace log 殘留：本次修正未新增任何 `console.log`／trace 敘述；本次
  測試使用的 `data/pos.db`（含測試用 Business Calendar 記錄、商品欄位變更）只存在於
  本機測試執行環境，**未包含在交付的原始碼與 ZIP 內**（`data/` 為執行期自動產生的
  資料庫檔案，原始 R5 zip 本身也不包含 `data/` 目錄，已用 `unzip -l` 確認）；
  `node_modules/` 同樣不在交付內容內。交付前已用 `diff -rq`（排除 `node_modules`、
  `data`）逐檔案比對整個工作目錄，確認除 `routes/line-orders.js` 外，其餘檔案與 R5
  來源 zip 完全一致，無殘留測試用暫存檔案。

## 11. 商品卡未修改證明

本次**完全沒有修改** `public/line-order.html`（0 bytes 差異，已用 diff 逐位元組確認），
因此 `buildCard()`／`updateProductCard()`／商品卡 HTML／CSS／Badge 位置全部未變動。
本次唯一修改的檔案是後端 `routes/line-orders.js` 內的 `getDateClosedStatus()`
（純粹調整判斷順序），`fulfillmentContext` 結構、Mode Isolation
（`applyFulfillmentMode()`／`buildDateSelector()`／`buildTimeSelector()`
／`restoreModeFormState()`）、Hotfix30-B5-R5 完成的 `preorderRequiredIds` 修正
（`refreshDateSelectorForCart()`）皆完全未觸碰。

## 12. 宅配未修改證明

`routes/line-shipping.js` 與 R5 逐位元組（byte-identical）比對確認零差異
（`diff -rq` 排除 `node_modules`／`data` 後，僅回報 `routes/line-orders.js` 一個檔案
不同，其餘所有檔案，包含 `routes/line-shipping.js`、地址／Google Maps／外送費相關
`utils/`、LINE Login／LINE Pay／Analytics／Dashboard／Android 相關檔案，全部確認
與 R5 完全一致）。

## 13. 已知限制

需求文件第三項描述「LINE 點餐總開關」為最高層系統總開關，審計確認此開關
（`line_ordering_enabled`）已經在 `validateOrderConditions()`（送單驗證，第 1 項
優先判斷）正確攔截送單；`GET /shop` 的 `settings.is_open` 欄位也已正確反映此開關狀態
（`is_open = line_ordering_enabled==='1' && !todayClosedStatus.closed`）。**但**
`resolveFulfillmentState()`（供 `takeout_status.today_state`／`delivery_status.
today_state` 使用）目前未把此開關納入判斷，理論上若店家關閉此總開關、但當天有
Business Calendar 或每週營業時間設定，`/shop`／`/menu` 逐模式狀態欄位（`today_state`）
仍可能顯示為 `open`，僅在實際送出訂單時才會被 `validateOrderConditions()` 攔截
（`line_disabled`）。經追蹤確認，`public/line-order.html` 目前也沒有任何地方讀取
`settings.is_open` 這個欄位。本次需求文件的 10 個 Regression Case（R6-1～R6-10）
未包含「LINE 點餐總開關關閉」這個組合，且此為既有（R5 以前即存在）行為，非本輪
「今日臨時休息 vs 特殊營業」Root Cause 的一部分，本次依「找到 Root Cause 後做最小
修正」原則，未擴大修改範圍觸碰 `resolveFulfillmentState()` 或前端顯示邏輯。若需要
把「總開關關閉」也反映在逐模式顯示狀態上，建議另開一個獨立 Hotfix 處理，避免本次
單一函式的最小修正被放大成多函式改動。

## 14. 回退方式

本次修改僅涉及 `routes/line-orders.js` 一個檔案的一個函式
（`getDateClosedStatus()`，行號約 182～219）。回退方式：

1. 還原成 Hotfix30-B5-R5 的 `routes/line-orders.js`（或僅將
   `getDateClosedStatus()` 函式內「今日臨時休息」與「Business Calendar」兩段判斷
   的先後順序換回舊版順序）即可完整回退，不影響其他任何檔案或功能。
2. 由於本次未新增資料表欄位、未新增 API 欄位、未改變任何回傳物件結構，回退不需要
   額外的資料庫遷移或前端配合調整。
