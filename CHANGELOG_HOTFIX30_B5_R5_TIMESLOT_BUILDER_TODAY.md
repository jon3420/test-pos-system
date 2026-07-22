# fix18-10-hotfix30-B5-R5｜Timeslot Builder 今日時段修正 × 尚未營業不跳明日 × 特殊營業今日可取餐

基礎版本：**Hotfix30-B5-R4**（`pos-web-fix18-10-hotfix30-B5-R4-full.zip`）。**只修改
`public/line-order.html` 一個檔案的一個函式**，`routes/line-orders.js` 逐行 diff 確認
**零差異**（後端 `resolveFulfillmentState()`／`getEffectiveModeSchedule()`／
`getEffectiveCutoffMins()`／`getEarliestMins()`／`GET /timeslots` 全部確認本來就已經
正確，不需要修改）。

## 1. Root Cause（實測重現、非猜測，依需求文件第十二項要求先列出五個問題答案）

**先回答需求文件要求先列出的五個問題**：

1. **哪個條件把 not_started 當成不可選今天**：不是 `not_started` 本身的判斷有問題
   （`_skipToday = !canOrderNow && !canScheduleToday`，Hotfix30-B3 已正確實作，
   `canScheduleToday` 為 `true` 時 `_skipToday` 正確為 `false`）。真正的問題出在
   `refreshDateSelectorForCart()` 呼叫 `buildDateSelector()` 時傳入的
   **`forceNextDay` 參數本身就是 `true`**，直接繞過了 `_skipToday` 的判斷。
2. **哪個函式觸發 forceNextDay**：`refreshDateSelectorForCart()`，依據
   `needsNextDay = Object.keys(cart).some(id=>preorderRequiredIds.has(Number(id)))`
   決定要不要傳 `forceNextDay=true`。
3. **`/timeslots` 在 not_started 情境回傳什麼**：**回傳正確的今日時段**（已用真實
   API 請求驗證，例如 not_started 17:51 開始，`/timeslots` 正確回傳
   `["17:51","18:21",...]`），backend 完全沒有問題。
4. **`buildDateSelector()` 如何決定排除今天**：`startOffset=(forceNextDay||
   _skipToday)?1:0`——本輪追蹤實測發現 `_skipToday` 在 bug 情境下正確是 `false`，
   但 `forceNextDay` 是 `true`，所以還是排除了今天。
5. **`buildTimeSelector()` 如何決定跳明天**：`buildTimeSelector()` 本身沒有主動決定
   跳明天，它只是忠實地依照 `refreshDateSelectorForCart()` 已經算好的
   `forceNextDay`/日期參數執行，問題完全不在這裡。

**真正的 Root Cause**：`preorderRequiredIds` 是一個**全域、不分外帶/外送模式**的
`Set`。商品在 `addCart()` 時，若當下 `currentMode` 恰好是「該模式已被關閉但允許
預約明日」（例如外送因特殊營業關閉、`delivery_can_next_day=true`），`addCart()`
會呼叫 `addPreorderToCart()`，把該商品 id 加進 `preorderRequiredIds`。這個標記
**永久存在，不會因為使用者之後切換模式而重新評估**。當使用者切到外帶（`not_started`，
今天稍後就有合法時段，根本不需要強制跳明天）時，`refreshDateSelectorForCart()`
的 `needsNextDay` 檢查仍然看到這個商品 id 在 `preorderRequiredIds` 裡（那是加入
購物車那一刻、外送模式留下的舊標記），於是無條件把 `forceNextDay=true` 傳給
`buildDateSelector('takeout', ...)`，導致外帶也被錯誤地跳過今天——這正是使用者
回報的兩個 bug 共同的根因：**同一個全域標記，被不同模式誤用**，本質上是一個
Mode Isolation 缺口（本輪修正它，不修改 R4 已完成的架構本身）。

實測追蹤（暫時性 trace log，只存在於暫存測試副本，修正前）：
```
[TRACE] mode=takeout _skipToday=false canOrderNow=false canScheduleToday=true forceNextDay=true
pDate: 2026-07-23 pTime: 11:00   ← 錯誤跳到明天
```
`_skipToday` 明明是 `false`（正確），但 `forceNextDay=true` 讓它照樣跳過今天。

## 2. not_started 與 cutoff 混用問題

**確認：不存在**。`_skipToday` 本身已經正確區分兩者
（`canScheduleToday`——只有 `not_started` 且 `earliest_today!=null` 才為 `true`；
`cutoff`／`holiday`／`today_not_open` 皆為 `false`），本輪未修改這個判斷式。混用
問題其實是 `forceNextDay` 這個「外部旗標」蓋掉了 `_skipToday` 的正確判斷，不是
`_skipToday` 自己分不清楚兩者。

## 3. 特殊營業今日時段

`resolveFulfillmentState()`／`getEffectiveModeSchedule()`／`getEffectiveCutoffMins()`
／`getEarliestMins()`／`GET /timeslots` 全部經真實 API 請求驗證，**確認本來就完全
正確**：特殊營業視窗內、視窗前（not_started）、視窗後（cutoff）三種情境，`/shop`
與 `/timeslots` 回傳的 `today_state` 與實際 `slots` 陣列**完全一致**（見第 9 節
Case R5-1/R5-2/R5-4 的真實 API 回應）。本輪未修改這些函式一行。

## 4. 一般營業尚未開始

同樣確認後端完全正確；問題只出現在**特殊營業（Business Calendar）觸發
`addPreorderToCart()` 標記商品之後，切到另一個模式**這個特定組合下——單純測試
「一般營業尚未開始」而不涉及購物車內有商品被 Business Calendar 標記過（Case
R5-3）本來就是正確的，這也是為什�麼 Case R5-3（一般週期營業）通過、但情境幾乎
相同的 Case R5-2（特殊營業）卻失敗的原因：R5-2 的購物車商品在加入時，`currentMode`
是預設的 `delivery`，而 `delivery` 恰好被同一筆 Business Calendar 記錄關閉，
觸發了 `addPreorderToCart()` 標記；R5-3 沒有設定 Business Calendar，delivery
維持全天開放，商品用一般 `addCart()` 加入，未被標記。

## 5. forceNextDay 修正

```diff
- const needsNextDay=Object.keys(cart).some(id=>preorderRequiredIds.has(Number(id)));
+ const needsNextDay = Object.values(cart).some(({product:p}) => {
+   if(!p) return false;
+   const soldOutReason = mode==='delivery' ? p.delivery_sold_out_reason : p.takeout_sold_out_reason;
+   const canNextDay    = mode==='delivery' ? p.delivery_can_next_day    : p.takeout_can_next_day;
+   return !!soldOutReason && !!canNextDay && soldOutReason!=='mode_closed' && soldOutReason!=='product_mode_disabled';
+ });
```

不再查詢「加入購物車那一刻、可能是別的模式留下的」全域標記，改成對「目前這個
`mode`」重新檢查購物車內每個商品是否**真的**需要強制預約明日——判斷依據跟
`addCart()` 用來決定要不要呼叫 `addPreorderToCart()` 的依據完全一致（沿用既有
`p.takeout_sold_out_reason`／`p.delivery_sold_out_reason`／`p.takeout_can_next_day`
／`p.delivery_can_next_day` 這些既有欄位，未新增任何欄位或第二套判斷邏輯）。
`preorderRequiredIds` 本身（`addCart()`／`addPreorderToCart()`／購物車增減數量時
的維護邏輯）完全未修改，只是 `refreshDateSelectorForCart()` 不再單純信任它。

## 6. `/shop` 與 `/timeslots` 一致性

確認一致，且本輪未修改。真實 API 驗證（Case R5-2）：
- `GET /shop`：`takeout_status.today_state="not_started"`
- `GET /timeslots?mode=takeout`：回傳非空 `slots` 陣列，第一格等於
  `today_start_time`

兩者完全對應，符合需求文件第六項的要求。

## 7. `buildDateSelector()` 修正

**未修改**。`buildDateSelector()` 本身的 `_skipToday` 邏輯（Hotfix30-B3 完成）
確認正確，本輪不需要、也沒有修改這個函式。

## 8. `buildTimeSelector()` 修正

**未修改**。`buildTimeSelector()` 本身沒有問題，本輪不需要、也沒有修改這個函式。

## 9. Case R5-1～R5-10 結果（真實 jsdom + 真實本機 API + 真實 DOM 檢查）

| Case | 情境 | 結果 |
|---|---|---|
| R5-1 | 特殊營業外帶窄視窗，現在在範圍內，外送關閉 | **PASS** — `state="open"`，日期保留今天，有時段值 |
| R5-2 | 特殊營業外帶尚未開始 | **PASS**（修正前 FAIL）— `state="not_started"`，日期保留今天，第一個時段=開始時間 |
| R5-3 | 一般每週外帶尚未開始 | **PASS** — 同上（本來就正確，用於對照 R5-2） |
| R5-4 | 特殊營業已真正結束，允許未來預約 | **PASS** — `state="cutoff"`，正確跳到未來日期 |
| R5-5 | 一般營業已截止 | **PASS** — `state="cutoff"`，正確跳到未來日期 |
| R5-6 | 今天公休，明天可預約 | **PASS** — 正確跳明天，顯示「目前正在預約」，無誤導訊息 |
| R5-7 | not_started + 長備餐時間，仍有合法時段 | **PASS** — 日期保留今天，有時段值 |
| R5-8 | not_started + 備餐時間超過視窗，無合法時段 | **PASS** — 正確跳到未來日期 |
| R5-9 | 特殊營業只開外帶 | **PASS** — 外帶自動選中、日期為今天，`fulfillBtns` 正確顯示外送為「可預約」（非強制不可選） |
| R5-10 | 特殊營業只開外送 | **PASS** — 外送自動選中、日期為今天，與外帶互不干擾（Mode Isolation 對稱驗證） |

**本輪累計：24/24 PASS，0 FAIL**（含 Case R5-2/R5-7 修正前 FAIL → 修正後 PASS 的
明確對照）。

## 10. Mode Isolation 無回歸

Case R5-9／R5-10 為對稱驗證：特殊營業只開外帶時，外帶自動選中且資料正確、外送
顯示「可預約」但不強制選中；反過來特殊營業只開外送時同樣對稱正確。Hotfix30-B5-R4
完成的 `buildServiceStatusBar()` 移除 `currentMode` 副作用、`applyFulfillmentMode()`
改用 `currentMode!==mode` 判斷過期，本輪**完全未觸碰**這兩處，`applyFulfillmentMode()`
／`buildDateSelector()`／`buildTimeSelector()`／`restoreModeFormState()` 這些
R4 已修正的函式本輪一行未改。

## 11. 商品卡未修改證明

本輪**完全沒有修改** `buildCard()`／`updateProductCard()`／商品卡 HTML／CSS／
Badge。修改的 `refreshDateSelectorForCart()` 雖然讀取了 `cart[id].product` 裡的
`takeout_sold_out_reason`／`delivery_sold_out_reason`／`takeout_can_next_day`／
`delivery_can_next_day` 這些既有欄位，但只是**讀取**，用於「日期選單要不要跳過
今天」這個判斷，完全不涉及商品卡本身的渲染或狀態判斷邏輯，商品卡的顯示規則
（Hotfix30-B5 的 `anyImmediate`／`canPreorderNextDay`）本輪一行未改。

## 12. 宅配未修改證明

以 **Hotfix30-B5-R4** 作為直接基礎版本逐檔 SHA-256 比對：

```
public/line-shipping.html : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f（完全一致）
routes/line-shipping.js   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655（完全一致）
```

`routes/line-orders.js` 逐行 diff 對比 Hotfix30-B5-R4 為**零差異**。

## 13. Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 187/187（與 Hotfix30-B5-R4 完全相同，本輪未新增或刪除任何 HTML
元素）；重複 DOM id：0；無測試用 `console.log`／追蹤程式碼殘留於正式檔案（暫時性
trace log 只存在於 `/tmp/r5test/` 這個暫存測試副本，已於測試結束後隨整個暫存目錄
一併刪除）。本輪未修改 Business Calendar 優先序、特殊營業覆蓋 LINE 商品時段、
`fulfillmentContext` 結構、Mode Isolation 既有架構（`applyFulfillmentMode()`／
`buildServiceStatusBar()`／`buildDateSelector()`／`buildTimeSelector()`）、地址、
Google Maps、外送費、localStorage、LINE Login、LINE Pay、Analytics、Dashboard、
商品卡、商品卡排版、Badge、宅配、Android。

## 14. 已知限制

1. **`preorderRequiredIds` 這個全域 Set 本身未重新設計**：本輪只是讓
   `refreshDateSelectorForCart()` 不再單純信任它、改為對目前模式重新驗證，但
   `preorderRequiredIds` 這個資料結構本身（誰、何時被加入/移除）維持不變。若未來
   `preorderRequiredIds` 被其他函式（`chgQty()`／購物車渲染等）以「不分模式」的
   方式使用，可能仍有類似風險，建議日後評估是否要把這個 Set 也改成依模式分開
   （`preorderRequiredIds.takeout`／`.delivery`），但那屬於較大範圍的重構，超出
   本輪「只修今天時段是否應該產生／何時才可以跳明日」的範圍，未執行。
2. **未使用完整瀏覽器（Playwright/Puppeteer）測試**：延續前幾輪環境限制（沙盒
   網路白名單擋下瀏覽器二進位檔下載），本輪驗證改用 jsdom（真實 DOM + 真實
   script 執行 + 真實本機 API），並透過暫時性追蹤 log 逐行確認實際執行順序與
   變數狀態，找到 root cause 有明確的「修正前重現、修正後驗證通過」對照，但
   仍非 100% 等同真實瀏覽器測試。

## 15. 回退方式

1. 還原 `public/line-order.html` 為 Hotfix30-B5-R4 版本內對應檔案即可（本版只
   修改這一個檔案裡的 `refreshDateSelectorForCart()` 這一個函式，`routes/
   line-orders.js` 與 Hotfix30-B5-R4 完全相同，回退時甚至不需要處理）。
2. 未新增資料庫欄位、未修改 migration，回退不需要處理資料庫層面。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
