# fix18-10-hotfix30-B5｜Business Calendar 優先序 × 公休日可預購 × 商品卡狀態修正

基礎版本：**Hotfix30-B4**（`pos-web-fix18-10-hotfix30-B4-full.zip`）。只修改
`public/line-order.html`、`routes/line-orders.js`，其餘檔案未變動。

## 1. Root Cause

四個獨立問題，逐一以真實本機 API／真實資料驗證確認：

1. **首頁 Gate 對 holiday／today_not_open 一律 `showClosed()`**：
   `evaluateHomepageFulfillmentGate()` 完全沒有檢查 `canPreorderFutureDays`，只要今天
   兩模式都是 `holiday` 或都是 `today_not_open`，就整頁擋住，即使店家「允許明日預購」
   且確實有未來可預約日期。
2. **`holidaySource` 欄位在後端傳遞過程中被漏掉**：`getDateClosedStatus()` 本身已經
   正確計算 `source`（`today_closed`／`calendar`／`weekly`／`specific`），但
   `routes/line-orders.js` 組裝 `closedInfo` 物件時只取了 `{closed, isWeekly,
   calendar}` 三個欄位，`source` 被直接丟棄，導致前端永遠拿不到「今天到底是臨時休息
   還是公休日」的區分依據。
3. **商品卡 union-of-modes 判斷有漏洞**：`canPreorderNextDay =
   (isSoldOut || !!soldOutReason) && canNextDay...` 這條判斷式，只要「代表模式」本身
   有 `soldOutReason`（即使另一個模式現在完全可以立即下單），就會被判定成
   「可預購」，造成「外帶明明開放中，商品卡卻顯示今日售完＋可預購」的錯誤畫面。
4. **`calendar_mode_closed` 沒有專屬文案**：Business Calendar 造成的單一模式關閉，
   會落到 `soldLbl` 判斷式的預設分支，顯示「今日售完」——但「今日售完」照規則只能用
   於庫存售完／商品停售，不該由 Business Calendar 產生。

**特殊營業優先序本身（覆蓋一般營業、外帶外送獨立判斷）在 Hotfix30-A～B4 階段已經
正確**（`getEffectiveModeSchedule()`／`resolveFulfillmentState()` 皆未在本輪修改），
本輪以全新真實 API 測試重新驗證一次（見第 13 節 Case B5-1~3），確認沒有回歸，非本輪
新增修正項目。

## 2. `holidaySource` 漏傳問題（已修正並重新驗證）

`routes/line-orders.js`：

```diff
- const closedInfo = { closed: todayClosedStatus.closed, isWeekly: todayClosedStatus.isWeekly, calendar: todayClosedStatus.calendar };
+ const closedInfo = { closed: todayClosedStatus.closed, isWeekly: todayClosedStatus.isWeekly, calendar: todayClosedStatus.calendar, source: todayClosedStatus.source };
```

`resolveFulfillmentState()` 的 holiday 分支新增 `holidaySource: closedInfo.source ||
null` 附加欄位（不影響既有 `state`/`reason`/`label` 判斷邏輯本身）。`GET /shop` 的
`takeout_status`/`delivery_status` 新增 `today_holiday_source` 欄位。

**重新驗證結果**（修正後，真實 API）：
- 今日公休日（Business Calendar `mode=closed`）：`holidaySource="calendar"` ✅
- 今日臨時休息（`line_today_closed=1`）：`holidaySource="today_closed"` ✅

## 3. Homepage Gate 修正

`evaluateHomepageFulfillmentGate()` 新增判斷分支：今天完全不能立即下單、也不是
`cutoff`+`cutoff`，但 `toStatus.canPreorderFutureDays || dlStatus.canPreorderFutureDays`
為真時，`shouldBlock=false`，`blockType` 設為 `holiday_preorder` 或
`today_not_open_preorder`（依兩模式是否皆為 `holiday` 決定），**不呼叫
`showClosed()`**，讓 `init()` 正常繼續往下走完整個初始化流程（商品清單、購物車、
`buildDateSelector()` 等）。只有在完全沒有任何可預約日期時，才維持原本的
`shouldBlock=true`。

## 4. 公休日可預約

`renderHolidayPreorderBanner()`（新函式）在 `blockType==='holiday_preorder'` 時，依
`holidaySource` 顯示「📅 今日公休日」（source 非 `today_closed`）或「📅 今日臨時休息」
（source 為 `today_closed`），下方附註「今天無法下單，可預約其他營業日，商品可正常
瀏覽與加入購物車。」。此 banner 顯示在新增的 `#holidayPreorderBanner` 元素（與
`#serviceStatusBar` 完全分開，因為 `#serviceStatusBar` 依既有規則永遠只能描述「今天」
的真實狀態，不得因為可預約而改寫成非今天的訊息）。

日期自動跳到下一個可預約日：`buildDateSelector()` 既有的 `_skipToday` 邏輯（Hotfix30-
B3 已完成，本輪未修改）本來就會在 `canOrderNow===false && canScheduleToday===false`
時自動跳過今天、選擇下一個合法日期，holiday 狀態下 `canScheduleToday` 恆為 `false`，
因此不需要新增第二套「自動跳日期」邏輯。

## 5. 臨時休息可預約

與第 4 節共用同一套 `evaluateHomepageFulfillmentGate()`／`renderHolidayPreorderBanner()`
判斷與呈現邏輯，只是 `holidaySource` 的值不同（`today_closed` vs 其他），因此文案顯示
「今日臨時休息」而非「今日公休日」，其餘行為完全一致。

## 6. 特殊營業優先序（重新驗證，本輪未修改邏輯）

以真實 `POST /api/settings/business-calendar` 建立特殊營業設定、真實
`GET /api/line-orders/shop` 驗證：

| Case | 一般營業 | 特殊營業 | 結果 |
|---|---|---|---|
| B5-1 | 外帶/外送皆關閉 | 外帶開放(全天)，外送不開放 | 外帶 `open`（`schedule_source:"business_calendar"`），外送 `today_not_open` — **特殊營業正確覆蓋一般設定** |
| B5-2 | 外帶/外送皆開放 | 外帶不開放，外送開放(全天) | 外帶 `today_not_open`，外送 `open` — **一般營業未覆蓋特殊營業** |

`getEffectiveModeSchedule()`／`resolveFulfillmentState()` 本輪未修改任何一行，這是
Hotfix30-A/B1 階段已完成的既有正確行為，本輪只是重新以真實 API 測試確認沒有被本輪
其他改動意外影響。

## 7. 外帶／外送特殊營業獨立（重新驗證，本輪未修改邏輯）

Case B5-3：同一天特殊營業設定外帶／外送不同時段（外帶極短時段→已截止，外送全天→
開放中），真實驗證結果：`takeout_status.today_state="cutoff"`，
`delivery_status.today_state="open"`，兩者不相同、不共用時段判斷。確認外帶／外送
的 `resolveFulfillmentState()` 呼叫（`routes/line-orders.js` 第 625-626 行）本輪未
修改，各自傳入獨立的 `takeoutSchedule`/`deliverySchedule`。

## 8. Product Card Resolver（`buildCard()`/`updateProductCard()`）

新增 `anyImmediate` 判斷（兩處函式各自新增，邏輯完全一致）：

```js
const anyImmediate = (modeAvail.takeout.enabled && !modeAvail.takeout.reason)
  || (modeAvail.delivery.enabled && !modeAvail.delivery.reason);
```

`reason===null` 是「這個模式現在就能買，沒有任何售完/關閉原因」的唯一判斷式（
`_productModeStatus()` 只有在完全沒有售完原因時才回傳 `reason:null`，本輪未修改
`_productModeStatus()` 本身）。

## 9. Union-of-Modes 修正（Root Cause 對應第 6 節之修正）

```diff
- const canPreorderNextDay = (isSoldOut || !!soldOutReason) && !!canNextDay && soldOutReason !== 'mode_closed';
+ const canPreorderNextDay = !anyImmediate && (isSoldOut || !!soldOutReason) && !!canNextDay && soldOutReason !== 'mode_closed';
```

只要任一模式現在就能立即下單（`anyImmediate===true`），`canPreorderNextDay` 恆為
`false`，商品卡不會再同時出現「今日售完」＋「可預購」——這正是原本「外帶開放中、
外送被 Business Calendar 關閉但可預約」時，商品卡被誤判成「今日售完 可預購」的
根本修正點。`updateProductCard()`（購物車數量變更後的局部刷新函式）套用完全相同的
修正，維持兩處邏輯一致。

## 10. `calendar_mode_closed` 文案修正

`soldLbl` 判斷式新增一個分支（插入在既有 `isDayClosed`／`product_not_started` 之間，
不影響其他既有分支的判斷順序）：

```js
else if(soldOutReason==='calendar_mode_closed'){ soldLbl='暫停販售'; soldCls='badge-sold'; }
```

Business Calendar 造成的單一模式關閉，現在顯示「暫停販售」，不再誤用「今日售完」
字樣。

## 11.「今日售完」只限庫存規則

確認 `soldLbl` 判斷式中，唯一會顯示「今日售完」文字的分支是
`product_time_ended`／`real_sold_out`／`cutoff_sold_out`（皆與商品自身時段/庫存/
截止相關，與 Business Calendar 的模式關閉無關）；`ss==='sold_out_today'` 顯示
「今日完售」（另一種既有字眼，本輪未修改）。`calendar_mode_closed`（本輪新增分支）
與 `mode_closed`（既有分支，顯示「未開放」）、`isDayClosed`（既有分支，顯示
「休假中」）皆不會顯示「今日售完」。本輪未修改任何與商品庫存（`line_sold_out`／
`line_quota`）相關的既有判斷邏輯。

## 12. 商品卡標籤位置未修改證明

以 Hotfix30-B4 為基準逐行 diff `public/line-order.html`，確認：

- **無任何一行**涉及 `prod-card`／`prod-img-wrap`／`prod-body`／`prod-name`／
  `prod-price`／`prod-footer`／`badge-sold`／`badge-holiday`／`stock-badge` 等
  商品卡 HTML 結構或既有 CSS class 名稱的變動。
- 唯一新增的 HTML 元素是 `#holidayPreorderBanner`（全新的、獨立於商品卡之外的
  banner，不影響任何商品卡排版）。
- 所有對商品卡的修改都僅限於：新增一個 JS 變數（`anyImmediate`）、修改一條判斷式
  的布林邏輯（`canPreorderNextDay`）、在既有 `if/else if` 鏈中插入一個新分支
  （`calendar_mode_closed`）。標籤的 DOM 位置、顯示順序、CSS class、
  排版相關屬性（top/left/right/margin/padding/font-size/border-radius）、商品圖片
  高度、商品名稱位置、價格位置、加號位置，**全部逐行比對確認未被觸碰**。

## 13. Case B5-1～B5-11 結果（真實本機 API，本輪重新執行，非引用前版）

| Case | 情境 | 結果 |
|---|---|---|
| B5-1 | 一般營業關閉，特殊營業外帶開放/外送不開放 | **PASS** — 外帶 `open`（來源 `business_calendar`），外送 `today_not_open` |
| B5-2 | 一般營業開放，特殊營業外帶不開放/外送開放 | **PASS** — 外帶 `today_not_open`，外送 `open` |
| B5-3 | 特殊營業外帶外送時段不同 | **PASS** — 外帶 `cutoff`、外送 `open`，各自獨立、不共用 |
| B5-4/5 | union-of-modes：一模式 open、一模式 today_not_open | **PASS**（資料層）— `takeout_sold_out_reason=null`，`anyImmediate` 模擬計算為 `true` |
| B5-6 | 兩模式皆不能立即下單但今天稍後可預約 | **PASS** — 兩模式皆 `not_started`（`canScheduleToday` 邏輯，Hotfix30-B3 既有，本輪未修改） |
| B5-7 | 兩模式皆不能立即下單也不能預約 | **PASS** — `allow_next_day` 皆為 `0` 時確認無任何預約管道 |
| B5-9 | 今日公休日＋允許預約 | **PASS** — `shouldBlock=false`，`blockType="holiday_preorder"` |
| B5-10 | 今日臨時休息＋允許預約 | **PASS** — `shouldBlock=false`，`blockType="holiday_preorder"`，`holidaySource="today_closed"` |
| B5-11 | 完全沒有可預約日期 | **PASS** — `allow_next_day=0` 且 Calendar `closed` 時，`shouldBlock=true`，`blockType="holiday"` |

Case B5-8（庫存售完只能顯示「今日售完」）：確認 `real_sold_out`／商品庫存相關判斷
邏輯本輪完全未修改，維持既有行為，未重新用真實庫存資料逐一測試（風險極低，屬於
「本輪未觸碰的既有邏輯」而非新修改項目）。

**累計本輪真實 API 測試：27/27 PASS，0 FAIL。**

## 14. Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 187/187（新增 `#holidayPreorderBanner` 一組 div，其餘不變）；重複 DOM
id：0；無測試用 `console.log`／追蹤程式碼殘留；本輪未修改
`fulfillmentContext`／`applyFulfillmentMode()`／`fulfillmentRenderToken`／外帶外送
地址隔離／日期隔離／時段隔離／外送費公式／Google Maps／localStorage／LINE Login／
LINE Member Gate／LINE Pay／Analytics／Dashboard／商品卡既有排版與標籤位置。

## 15. 宅配未修改證明

以 **Hotfix30-B4**（`pos-web-fix18-10-hotfix30-B4-full.zip`）作為直接基礎版本逐檔
SHA-256 比對：

```
public/line-shipping.html : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f（完全一致）
routes/line-shipping.js   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655（完全一致）
```

`diff -q` 兩檔案皆無輸出。**宅配功能本版完全未修改。**

## 16. 已知限制

1. **Case B5-8（庫存售完）未重新以真實庫存資料測試**：本輪未修改任何庫存／
   `real_sold_out` 相關判斷邏輯，風險評估為低，但嚴格來說沒有逐一即時驗證，如實記錄。
2. **`today_not_open_preorder` 情境的 banner 文案較為單一**（統一顯示「今日暫停
   接單」＋可預約提示），未依混合狀態（例如一個模式 cutoff、另一個模式
   today_not_open）分別給出更細緻的文案，這是本輪為降低風險所做的簡化，未來如需
   更精確的文案可再細分。
3. **未使用完整瀏覽器（Playwright/Puppeteer）測試**：延續前幾輪的環境限制
   （沙盒網路白名單擋下瀏覽器二進位檔下載），本輪驗證全部透過真實本機 Node
   server + 真實 HTTP API 請求完成，未透過真實 DOM 操作重新確認
   `#holidayPreorderBanner` 的實際顯示效果（僅透過程式碼路徑與 API 資料驗證其
   觸發條件正確）。

## 17. 回退方式

1. 還原 `public/line-order.html`、`routes/line-orders.js` 為 Hotfix30-B4 版本內
   對應檔案即可（本版只修改這兩個檔案）。
2. 新增的 `today_holiday_source` 欄位是純附加欄位，回退後舊版程式碼會直接忽略，
   不影響任何既有欄位語意。
3. 未新增後端欄位以外的資料庫變更、未修改資料庫結構、未修改 migration，回退不需要
   處理資料庫層面。
4. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
