# fix18-10-hotfix30-B5-R4｜Mode Isolation 完整修正 × 預約提示優化

基礎版本：**Hotfix30-B5-R3**（`pos-web-fix18-10-hotfix30-B5-R3-full.zip`）。**只修改
`public/line-order.html` 一個檔案**，`routes/line-orders.js` 逐行 diff 確認**零差異**
（兩個 bug 都是純前端狀態管理問題，後端資料本身完全正確，不需要修改）。

## 1. 真正 Root Cause（實測重現後找到，非猜測）

以真實 jsdom + 真實本機 server 重現使用者回報的確切情境（特殊營業：外送 07:44–23:44
開放、外帶關閉），並在關鍵函式插入暫時性追蹤 log 逐行比對執行順序，找到兩個完全獨立
的根因：

### Bug-1 根因：`buildServiceStatusBar()` 有 side effect 會覆蓋使用者剛選的模式

`buildServiceStatusBar()`（純顯示函式，本身描述「今日服務」狀態列文字）內含一段
沿用自 Hotfix30-A 的邏輯：

```js
if(!modeForcedVisible){
  if(toStatus.enabled && !dlStatus.enabled) currentMode='takeout';
  else if(!toStatus.enabled && dlStatus.enabled) currentMode='delivery';
}
```

這段邏輯原本的用途是「頁面剛載入、還沒有使用者操作時，自動決定預設模式」。但
`buildServiceStatusBar()` 其實會在**每一次** `applyFulfillmentMode()` 切換模式時、透過
`refreshModeCutoffUI()` 被重新呼叫一次——追蹤 log 實測證實：

```
applyFulfillmentMode ENTER mode=takeout currentMode(before)=delivery
after currentMode=mode assignment, currentMode=takeout      ← 正確
after renderMenu, currentMode=takeout                        ← 正確
after refreshModeCutoffUI, currentMode=delivery               ← 被改回去了！
```

只要「今天只有一種模式現在能立即下單」（例如外送因特殊營業正在開放中，外帶因特殊營業
今日未開放但允許明日預約），`buildServiceStatusBar()` 每次執行就會把 `currentMode`
無聲地改回那個「現在能立即下單」的模式——完全無視使用者剛剛透過
`selectFulfillmentMode('takeout')` 做出的明確選擇。這正是「切到外帶，畫面卻一直吃到
外送的日期/時間」的根因：`oType.value` 一開始被 `applyFulfillmentMode()` 正確設成
`'takeout'`，但緊接著 `currentMode`（`buildDateSelector()`/`buildTimeSelector()` 實際
依賴的全域變數）又被 `buildServiceStatusBar()` 偷偷改回 `'delivery'`，導致後續的
日期/時段渲染全部依照 `'delivery'` 計算。

### Bug-1 附帶發現的第二個問題：`fulfillmentRenderToken` 被內外兩層共用，外層守衛恆假

即使修正上面那段，購物車的「取餐方式」按鈕（`fulfillBtns`）仍然一直停留在切換前的
狀態、沒有反映使用者剛選的新模式。追蹤發現：`applyFulfillmentMode()` 自己也會
`++fulfillmentRenderToken` 取一個 `myToken`，並在 `await refreshDateSelectorForCart()`
之後比對 `myToken !== fulfillmentRenderToken` 來判斷「這次呼叫是否已經過期」；但
`refreshDateSelectorForCart()` 內部呼叫的 `buildTimeSelector()` **也**會
`++fulfillmentRenderToken`（同一個全域計數器，Hotfix30-B4 為了防止「快速連點模式時
較慢的舊回應蓋掉新畫面」而加的機制）。結果是：只要 `buildTimeSelector()` 成功執行
過一次（幾乎每次切換模式都會發生），`applyFulfillmentMode()` 捕捉到的 `myToken` 必定
已經落後於目前的 `fulfillmentRenderToken`，導致這個「防止過期」的檢查**永遠**判斷成
「已過期」而提早 `return`——`buildPreorderInfo()`／`buildFulfillmentOptions()`／
Analytics 事件記錄／`persistCart()` 全部被跳過不執行。

### Bug-2 根因：`buildPreorderInfo()` 在時段還沒真正載入完成前就先執行了一次

`buildDateSelector()` 最後一行 `if(!forceNextDay) buildTimeSelector(mode);` **沒有
`await`**，`refreshDateSelectorForCart()` 在「購物車內沒有強制預約商品」的一般情況下
也**沒有 `await` `buildTimeSelector()` 的結果**就直接返回。這代表
`applyFulfillmentMode()` 的 `await refreshDateSelectorForCart();` 這一行，在「一般
情況」下其實在 `buildTimeSelector()` 的 `timeslots` API 請求**還沒回應**時就已經
繼續往下執行——此時如果緊接著呼叫 `buildPreorderInfo()`，讀到的 `#pTime` 還只是
「載入中…」的暫時佔位選項（沒有任何有值的 `<option>`），因而誤判成「這個日期沒有
可預約時段」，顯示「此日暫無可預約時段，請改選其他日期」。幾百毫秒後，
`buildTimeSelector()` 的 API 請求真正回應、填入了正確的時段選項，但畫面已經不會再
自動更新這句提示文字，讓使用者誤以為系統判斷「不能預約」，即使系統其實已經正確自動
切到明天並算出正確的最早時段。

## 2. 修正內容

### Bug-1 修正一：移除 `buildServiceStatusBar()` 的 `currentMode` 側效應

```diff
- if(!modeForcedVisible){
-   if(toStatus.enabled && !dlStatus.enabled) currentMode='takeout';
-   else if(!toStatus.enabled && dlStatus.enabled) currentMode='delivery';
- }
+ // （整段移除，只留下說明性註解）
```

`buildServiceStatusBar()` 現在是純粹的顯示函式，絕對不會再修改 `currentMode`。
「頁面初次載入時決定預設模式」這件事本來就已經獨立存在於 `init()` 自己的流程裡
（`else if(takeoutEnabled) currentMode='takeout'; else if(deliveryEnabled)
currentMode='delivery';`，只在頁面載入、尚未有任何使用者操作時執行一次），移除這裡
不會影響「初次載入自動選擇唯一開放模式」的既有行為；「使用者操作後模式是否需要改變」
完全交給 `reconcileFulfillmentMode()`（本輪未修改，該函式有完整的 Analytics 記錄與
toast 提示，且只在購物車商品衝突或店家狀態改變時才動作，不會跟使用者的明確選擇打架）。

### Bug-1 修正二：`applyFulfillmentMode()` 的「是否過期」改用 `currentMode` 比對

```diff
- const myToken = ++fulfillmentRenderToken;
  ...
  await refreshDateSelectorForCart();
- if(myToken!==fulfillmentRenderToken) return;
+ if(currentMode!==mode) return;
```

不再讓 `applyFulfillmentMode()` 從跟 `buildTimeSelector()`／`fetchDeliveryFee()`
**共用的同一個全域計數器**取號碼比對，改成直接比對「目前 `currentMode` 是否還是我
被要求套用的 `mode`」——若在等待期間有更新一次的 `applyFulfillmentMode()` 呼叫進來，
它會把 `currentMode` 設成**它自己的** mode，跟這裡捕捉到的 `mode` 不同，才代表真的
過期；不會被 `buildTimeSelector()`/`fetchDeliveryFee()` 各自內部的 token 遞增誤傷。
`buildTimeSelector()`/`fetchDeliveryFee()` 自己的 race-guard（Hotfix30-B4 完成，
防止「快速連點時較慢的舊回應蓋掉新畫面」）完全不受影響、繼續正常運作。

### Bug-2 修正：`buildPreorderInfo()` 改在 `buildTimeSelector()` 時段真正載入完成後才呼叫

```diff
  await refreshDateSelectorForCart();
  if(currentMode!==mode) return;
- buildPreorderInfo();
  buildFulfillmentOptions();
```

移除 `applyFulfillmentMode()` 裡這個「時機過早」的呼叫。改為在 `buildTimeSelector()`
內部、`timeslots` API 真正回應之後才呼叫（無論是「有時段」或「這個原因下沒有時段」
兩種分支都補上），確保 `#preorderInfoBox` 顯示的永遠是「實際載入結果」，不是呼叫
當下的暫時空狀態：

```js
// 有時段的分支（成功路徑尾端）
syncFulfillmentContext(modeSnapshot);
buildPreorderInfo();

// 沒有時段的分支（reason 分支尾端，寫完 disabled option 之後）
sel.innerHTML=`<option value="" disabled>${msg}</option>`;
buildPreorderInfo();
```

「不新增第二套預約判斷」——這裡沒有新增任何判斷邏輯，只是把**既有**的
`buildPreorderInfo()` 呼叫，從「時機錯誤（太早）的位置」搬到「時機正確（時段真正
載入完成後）的位置」。

## 3. Mode Isolation 是否完成

**是**。`buildFulfillmentOptions()`／`reconcileFulfillmentMode()`／
`buildDateSelector()`／`buildTimeSelector()`／`restoreModeFormState()`／
`applyFulfillmentMode()` 全部逐一檢查：

- `buildDateSelector(mode)`／`buildTimeSelector(mode)` 本身（Hotfix30-B4 已完成的
  明確 mode 參數）**從未讀取過另一個模式的資料**——問題不在這兩個函式內部，而是在
  「呼叫它們的時候，`mode` 參數／`currentMode` 已經被 `buildServiceStatusBar()`
  偷偷改掉」，本輪修正的正是這個上游污染源。
- `restoreModeFormState(mode)`／`reconcileFulfillmentMode()` 本輪逐行確認，未發現
  額外的 fallback 到另一個模式的路徑。
- 真實驗證：Case R4-1（外帶關閉/外送開放）與 Case R4-2（外帶開放/外送關閉，反向
  對稱）皆確認：`oType.value`、`#pDate`/`#pTime` 的實際值、購物車按鈕（`fulfillBtns`）
  的 active 狀態，三者在切換後都正確反映「使用者剛選的模式自己的資料」，不會等於
  另一個模式先前的值。

## 4. 哪些 Fallback 被移除

嚴格來說，本輪移除的不是「fallback 到另一個模式」的程式碼（`buildDateSelector`/
`buildTimeSelector` 本身從未有這種 fallback），而是移除了兩個**會讓已經正確設定好的
`currentMode`／render 結果被意外覆蓋或跳過**的機制性問題：

1. `buildServiceStatusBar()` 對 `currentMode` 的自動改寫（第 2 節修正一）。
2. `applyFulfillmentMode()` 使用共用計數器導致的自我失效判斷（第 2 節修正二）。

## 5. Case R4-1～R4-4 結果（真實 jsdom + 真實本機 API + 真實 DOM 檢查）

| Case | 情境 | 結果 |
|---|---|---|
| R4-1 | 特殊營業外帶關閉／外送開放，切到外帶 | **PASS** — `oType.value="takeout"`；`#pDate`/`#pTime` 正確顯示外帶自己的資料（明天 11:00，非外送的今天 12:30）；`fulfillBtns` 正確顯示外帶為 active |
| R4-2 | 特殊營業外帶開放／外送關閉，切到外送（反向對稱） | **PASS** — `oType.value="delivery"`；日期不等於外帶的值；`fulfillBtns` 正確顯示外送為 active |
| R4-3 | 今天無時段、明天有時段，系統已自動切到明天 | **PASS** — `#preorderInfoBox` 正確顯示「📅 目前正在預約／預約日期：明天／取餐方式：外帶／最早時段：11:00」，**不含**「此日暫無可預約時段」字樣 |
| R4-4 | （與 R4-3 同一測試，驗證「只有真的完全沒有可預約時段才顯示改選提示」） | **PASS** — 沿用 R4-3 的驗證斷言，確認錯誤訊息不會誤現 |

額外驗證：整個切換流程中 `window.addEventListener('error'/'unhandledrejection')`
皆未捕捉到任何 JS 例外（`window.__jsErrors.length === 0`）。

**本輪累計：9/9 PASS，0 FAIL。**

## 6. Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 187/187（與 Hotfix30-B5-R3 完全相同，本輪未新增或刪除任何 HTML 元素）；
重複 DOM id：0；無測試用 `console.log`／追蹤程式碼殘留於正式檔案（暫時性 trace log
只存在於 `/tmp/r4test/` 這個暫存測試副本，從未寫入 `public/line-order.html` 正式
原始檔，已於測試結束後隨整個暫存目錄一併刪除）。`routes/line-orders.js` 本輪**完全
未修改**（逐行 diff 對比 Hotfix30-B5-R3 為零差異）。本輪未修改
`fulfillmentContext`／Business Calendar／特殊營業權重／LINE 商品販售時段／
Google Maps／外送費／商品卡／商品排版／Badge／Analytics／Dashboard／LINE Login／
LINE Pay／宅配／Android。

## 7. 宅配未修改證明

以 **Hotfix30-B5-R3** 作為直接基礎版本逐檔 SHA-256 比對：

```
public/line-shipping.html : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f（完全一致）
routes/line-shipping.js   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655（完全一致）
```

## 8. 已知限制

1. **`fulfillmentRenderToken` 這個全域計數器目前仍是「多個用途共用一份」**：
   `buildTimeSelector()`／`fetchDeliveryFee()` 各自的 race-guard 機制未變動（本輪
   只修正 `applyFulfillmentMode()` 自己不再依賴這個計數器判斷過期），未來若再新增
   其他也需要 race-guard 的 async 函式，建議評估是否要讓每個用途各自持有獨立的
   計數器，避免類似的「內外層共用同一個計數器」問題再次出現。
2. **未使用完整瀏覽器（Playwright/Puppeteer）測試**：延續前幾輪環境限制（沙盒網路
   白名單擋下瀏覽器二進位檔下載），本輪驗證改用 jsdom（真實 DOM + 真實 script 執行
   + 真實本機 API），並透過暫時性追蹤 log 逐行確認實際執行順序與變數狀態，找到
   兩個 root cause 皆有明確的「修正前重現、修正後驗證通過」對照，但仍非 100%
   等同真實瀏覽器測試（無真實 CSS layout/paint、無真實使用者滑鼠事件）。

## 9. 回退方式

1. 還原 `public/line-order.html` 為 Hotfix30-B5-R3 版本內對應檔案即可（本版只修改
   這一個檔案，`routes/line-orders.js` 與 Hotfix30-B5-R3 完全相同，回退時甚至不需要
   處理）。
2. 未新增資料庫欄位、未修改 migration，回退不需要處理資料庫層面。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
