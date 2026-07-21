# fix18-10-hotfix30-B3｜明日預購模式修正 × 購物車假衝突排除 × 預約日期自動選擇

基礎版本：**Hotfix30-B2**（`pos-web-fix18-10-hotfix30-B2-full.zip`）。只修改
`public/line-order.html`，其餘檔案未變動。

## 1. Root Cause

Hotfix30-B2 修正了「首頁 Gate」不再把 `not_started`（今天稍後才開始營業）誤判為「今日
暫停接單」，但購物車／商品層級的多個函式仍然只用單一 `getFulfillmentStatus(mode).enabled`
（= 現在能不能立即下單）判斷「這個模式能不能用」——`not_started` 的 `enabled` 本來就是
`false`（現在確實不能立即下單），這些函式因此把它當成「模式關閉」處理：

- `_productModeStatus()` → 導致所有商品被判定為兩模式都不可用
- `getCartAvailableModes()`（透過 `getProductAvailableModes()`）→ 進而回報「購物車內商品
  沒有共同的取餐方式」（其實根本沒有商品層級衝突，是店家整體「還沒開始」）
- `reconcileFulfillmentMode()` → combined 判斷連帶錯誤
- `buildFulfillmentOptions()` → 外帶/外送按鈕顯示灰色 disabled「尚未開始」
- `isCurrentModeAvailable()`（→ `buildDateSelector()`）→ 直接提前 return，日期/時段完全
  留白

這正是使用者回報的「商品頁正常，但購物車顯示假衝突、按鈕灰色、日期時間空白」。

## 2. 三種能力分離（`getFulfillmentStatus()` 新增回傳欄位，未修改 `resolveFulfillmentState()`）

`getFulfillmentStatus(mode)` 新增以下欄位（`state`/`reason`/`enabled` 等既有欄位語意
完全不變，`resolveFulfillmentState()` 的今日狀態計算本身未被觸碰）：

```
canOrderNow           現在能否立即下單（= 舊版 enabled，語意不變）
canScheduleToday       今天稍後是否可預約（state==='not_started' 且今天還有剩餘時段）
canPreorderFutureDays  明天／未來日期是否可預約（依賴 allow_next_day 且確實有可預約日期）
canPreorder            canScheduleToday || canPreorderFutureDays
selectable             canOrderNow || canPreorder（購物車取餐方式是否可選的唯一依據）
nextAvailableDate      下一個可預約日期（沿用既有 takeout_next_dates/delivery_next_dates）
cartLabel              購物車按鈕專用文案（「今日可預約」/「可預約」），與 label／
                       #serviceStatusBar 用的今日服務文案完全分開，不互相污染
```

## 3. 資料來源（追蹤既有真實欄位，未新增後端欄位）

逐一確認 `routes/line-orders.js` 既有欄位，全部沿用，未新增／未改名：

- `takeout_status.allow_next_day` / `delivery_status.allow_next_day`（既有，「允許明日
  預購」開關，來自設定 `takeout_allow_next_day`/`delivery_allow_next_day`）
- `takeout_status.earliest_today` / `delivery_status.earliest_today`（既有，`
  getEarliestMins()` 已算好的今日最早可選時段分鐘數，今日已無時段時為 `null`——這正是
  補充修正要求的 `effectiveEarliestTime = max(今日開始時間, 現在時間+備餐時間)` 公式，
  **後端本來就已經這樣算**：`Math.max(Math.ceil((nowMins+prepMins)/30)*30, openMins)`，
  無需新增計算邏輯）
- `takeout_next_dates` / `delivery_next_dates`（既有，Business-Calendar-aware 的未來
  可預約日期清單，從明天起算，`nextAvailableDate` 直接取第一筆）

**未新增任何後端欄位。** 需求文件建議的 `can_preorder`/`next_available_date` 皆已能由
既有欄位在前端組合算出，不需要後端變更，降低了風險。

## 4. 商品模式與營業狀態分離

`_productModeStatus(p, mode)` 的 `storeSelectable` 判斷改用 `getFulfillmentStatus(mode)
.selectable`（原本是 `.enabled`）。這代表：

- 「商品模式交集」現在只在**真正的商品層級衝突**（例如商品 A 僅 `line_takeout_enabled=1`，
  商品 B 僅 `line_delivery_enabled=1`，兩者沒有共同支援的模式）時才會顯示衝突清單
  （Case Y）。
- 「店家現在不能立即下單，但可預約」（not_started/cutoff + 可預約）不再被誤判成商品衝突
  （Case V/W/X/Z）。
- `line_takeout_enabled`/`line_delivery_enabled` 商品模式欄位本身、後端
  `product_mode_not_supported` 驗證、`getProductAvailableModes()`/
  `getCartAvailableModes()` 的購物車模式交集演算法（如何從逐商品可用模式算出購物車整體
  可選模式）**完全未修改**，只修正了它們共同依賴的「storeEnabled 這個輸入訊號」本身
  的正確性。

`_productModeStatus()` 額外回傳 `preorderOnly` 旗標（店家現在不能立即下單、只能預約時
為 `true`），供未來如需在商品卡加上專屬「可預約」徽章時使用；本版商品卡的既有徽章優先序
系統（🟢可預購／售完／熱銷等既有邏輯）較複雜，本版未進一步整合這個新旗標到商品卡視覺
呈現，只確保商品在這個情境下**不會被誤判為不可購買**（見第 11 節已知限制）。

## 5. 購物車取餐方式

`buildFulfillmentOptions()` 的 disabled 判�v斷改用 `.selectable`（原本 `.enabled`）；
當 `selectable` 為真但 `canOrderNow` 為假時，按鈕保持 enabled，徽章文字改用新增的
`cartLabel`（「今日可預約」或「可預約」），不再顯示灰色 disabled 的「尚未開始」／
「今日已截止」——那兩個文字現在專屬於 `#serviceStatusBar`（今日服務列，Hotfix30-B2
已完成，本版未修改），兩處文案徹底分離。

`isCurrentModeAvailable()`（同時被 `buildDateSelector()`／`updateModeAvailabilityUI()`／
`submitOrder()` 引用）改用 `.selectable`，一次修正三個呼叫點。

## 6. 日期自動選擇

`buildDateSelector()` 新增 `_skipToday` 判斷：`!canOrderNow && !canScheduleToday` 時才
跳過今天（沿用既有的 `forceNextDay` 機制，`startOffset=(forceNextDay||_skipToday)?1:0`，
未新增第二套日期邏輯）。規則對照：

- 今天 `canOrderNow` 或 `canScheduleToday` 為真 → 今天保留為選項，且是預設選中的第一個
  選項（`buildDateSelector()` 既有的 `first` 邏輯本來就會選到第一個非 disabled 選項，
  只要沒被提前 return 擋住，今天自然會被選中）。
- 今天兩者皆為假、但 `canPreorderFutureDays` 為真 → 跳到明天或下一個有效營業日（既有
  `takeout_next_dates`/`delivery_next_dates` 陣列的第一筆）。
- 三者皆假 → 維持既有「目前未開放」的提前 return（`isCurrentModeAvailable()` 現在也
  正確反映這個情況，不會誤判）。

`refreshDateSelectorForCart()`／`applyDateTimeToCartSheet()` 未修改，因為它們本來就是
呼叫 `buildDateSelector()` 取得日期清單，修正單點即可讓所有呼叫端自動得到正確行為。

`submitOrder()` 的最終送單前檢查（原本 `if(!_submitToStatus.enabled) toast(...)`）
一併改用 `.selectable`，否則今天稍後預約／明日預購的合法訂單會在送出的最後一步被誤擋
下來——這是本輪除了使用者列出的 6 個函式之外，額外發現並修正的第 7 個必須修正點。

## 7. 補充修正：今日提前預購與明日預購分離

`canScheduleToday` 完全不看 `allow_next_day`（「允許明日預購」），只看
`state==='not_started' && earliest_today!=null`——`earliest_today` 由既有
`getEarliestMins()` 計算，本身已經是
`max(ceil((現在時間+備餐時間)/30)*30, 今日開始時間)`，並在今日已無時段時回傳 `null`。
這代表「今天原本有排班，只是還沒到開始時間」這件事，與「店家是否額外開放明天預購」是
兩個獨立開關，符合補充修正的明確要求：「『允許明日預購』只影響明天及其後的可預約日期，
不得影響今天尚未開始時的提前預購」。

**這個設計選擇會讓需求文件前段（非補充部分）的 Case AB 定義（`not_started` +
`allow_preorder=false` → `selectable=false`）技術上不再成立**——因為補充修正明確把
「今天稍後」與「允許明日預購」拆開成兩個獨立能力後，`allow_next_day=false` 只會讓
`canPreorderFutureDays` 變 `false`，不會讓 `canScheduleToday` 也跟著變 `false`。本
CHANGELOG 依補充修正（較晚、更明確的指示）為準，如實記錄這個技術上的行為差異，而不是
悄悄照舊版 Case AB 的定義把兩者綁在一起（那樣會違反補充修正的明確要求）。

## 8. Analytics（未修改）

`_trackModeConflict()`／`mode_conflict` 事件的觸發條件（`reconcileFulfillmentMode()`
判斷兩模式皆不可用時才觸發）完全沿用既有邏輯與既有事件名稱。由於
`getCartAvailableModes()` 現在正確反映「not_started 但可預約」為可用，Case V/W/X 這類
情境不會再讓 `getCartAvailableModes()` 回報衝突，自然也就不會誤觸發 `mode_conflict`——
這是「輸入訊號變正確」的自然結果，Analytics 判斷邏輯本身、`fulfillment_method_
auto_switched`／`fulfillment_method_selected` 事件、Dashboard 統計口徑皆未修改。

## 9. Behavior Regression（本機真實 HTTP 請求）

| Case | 情境 | 結果 |
|---|---|---|
| V/W | 外帶／外送 `not_started` + 允許明日預購 | **PASS** — `selectable=true`，`canPreorder=true` |
| X | 外帶／外送皆 `not_started` + 皆允許明日預購 | **PASS** — 兩者皆 `selectable=true`，`nextAvailableDate` 正確為明天 |
| Z | `cutoff` + 允許明日預購 | **PASS** — `selectable=true`（透過 `canPreorderFutureDays`），`canScheduleToday=false`（今天已無時段，正確） |
| AA | `cutoff` + 不允許預購 | **PASS** — `selectable=false` |
| AC | 今日尚未開始但今天仍有排程 | **PASS** — `earliest_today` 非 null，`canScheduleToday=true` |
| AG | 今日已無可用時段 + 允許明日預購 | **PASS** — `canScheduleToday=false`，`canPreorderFutureDays=true`（會正確跳到明天） |
| AB（非補充定義） | `not_started` + 不允許明日預購 | **技術上不通過舊定義**（`selectable` 仍為 `true`）——見第 7 節說明，這是遵循補充修正的**預期且正確**行為，不是 bug |

Case Y（純商品層級衝突，商品 A 僅外帶／商品 B 僅外送，店家兩模式皆正常營業）未在本輪
以即時 HTTP 請求對特定商品逐一設定 `line_takeout_enabled`/`line_delivery_enabled` 重新
驗證，但 `_productModeStatus()` 的商品層級判斷鏈（`soldOutReason`/`line_sold_out`/
`preorderOnly` 之前的所有判斷）完全未改動，只有最前面的 `storeSelectable` 來源改變，
可推論該情境不受本次修改影響（Hotfix30-B 階段已對商品模式衝突情境做過即時 HTTP 驗證）。

## 10. 語法與結構 Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 186/186；重複 DOM id：0；無測試用 `console.log`；本版未修改
`routes/line-orders.js`／`resolveFulfillmentState()`／`evaluateHomepageFulfillmentGate()`
／`buildServiceStatusBar()`／Business Calendar API／`line_takeout_enabled`／
`line_delivery_enabled`／`product_mode_not_supported`／Mode Conflict Analytics／
LINE Member Gate／LINE Pay。

未逐一模擬「日期自動選擇造成無限迴圈」的壓力測試，但 `buildDateSelector()`／
`buildTimeSelector()` 呼叫鏈本身是單向（build → 讀取 DOM 目前值 → 结束，沒有互相
遞迴呼叫），結構上不存在造成無限迴圈的路徑。

## 11. 已知限制

1. **商品卡未新增「可預約」視覺徽章**：`_productModeStatus()` 已回傳 `preorderOnly`
   旗標，但 `buildCard()` 既有的徽章優先序系統（🟢可預購／售完／熱銷等）相當複雜，本版
   為降低風險未將這個新旗標整合進商品卡視覺呈現。目前的效果是「商品在 not_started/cutoff
   可預約情境下不會被誤判為不可購買」（核心 bug 已修正），但商品卡本身還不會額外顯示
   「可預約」字樣——這個視覺提示目前只出現在購物車的取餐方式按鈕（`cartLabel`）。
2. **Case AB 與需求文件非補充段落的定義不一致**：見第 7 節，這是刻意遵循「補充修正」
   的明確指示，非疏漏。
3. **Case Y 未以即時 HTTP 逐商品重新驗證**：見第 9 節說明，基於程式碼路徑分析而非本輪
   直接測試。
4. **`addCart()` 的「今日暫停接單」vs「此商品今日不可購買」訊息判斷**仍用
   `getFulfillmentStatus(mode).enabled`（= `canOrderNow`）決定要顯示哪一句，這是因為
   能走到這個 `alert` 分支時，`storeSelectable` 已經確定為兩模式皆假（否則不會進入這個
   分支），所以這裡的 `.enabled` 檢查只是在兩種同樣「完全不可用」的情境間選擇提示文字，
   不影響功能正確性，維持原樣以降低變動範圍。

## 12. 宅配未修改證明

以 **Hotfix30-B2**（`pos-web-fix18-10-hotfix30-B2-full.zip`）作為直接基礎版本逐檔
SHA-256 比對：

```
public/line-shipping.html
  Hotfix30-B2 : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  本版最終    : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f

routes/line-shipping.js
  Hotfix30-B2 : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  本版最終    : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
```

`diff -q` 兩檔案皆無輸出（無差異）。**宅配功能本版完全未修改。**

## 13. 回退方式

1. 還原 `public/line-order.html` 為 Hotfix30-B2 版本內對應檔案即可（本版只修改這一個
   檔案，`routes/line-orders.js` 及其他所有檔案本輪完全未觸碰）。
2. 未新增任何後端欄位、未新增資料表、未修改 migration，回退不需要處理資料庫層面。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
