# fix18-10-hotfix30-B5-R3｜特殊營業覆蓋 LINE 商品販售時段 × 保留庫存限制 × 商品卡正常販售

基礎版本：**Hotfix30-B5-R2**（`pos-web-fix18-10-hotfix30-B5-R2-full.zip`）。**只修改
`routes/line-orders.js` 一個檔案**，`public/line-order.html` 逐行 diff 確認**零差異**
（商品卡 HTML/CSS/判斷邏輯完全未觸碰，問題根源在後端 `GET /menu` 的商品售完原因
計算，不需要動前端）。

## 1. Root Cause

依需求文件第八點指示，先找出真正來源，不猜測：

1. **商品卡「今日售完」/「可預購」實際來自哪個欄位**：`GET /menu` 回傳的
   `takeout_sold_out_reason`/`delivery_sold_out_reason`，前端 `buildCard()`/
   `updateProductCard()`（Hotfix30-B5 已完成 `anyImmediate` 修正，本輪未再修改）
   直接使用這兩個欄位的值決定顯示文字。
2. **商品 LINE 販售時段在哪裡被判斷**：`routes/line-orders.js` 的 `GET /menu`
   handler 內，變數 `productTimeReason`（修正前為單一共用變數），比對
   `p.line_sell_start`/`p.line_sell_end`（商品自己的 LINE 販售時段設定）與現在時間
   `nowHHMM`。
3. **特殊營業資料在哪裡可以取得**：`takeoutSchedule`/`deliverySchedule`（
   `getEffectiveModeSchedule()` 的回傳值，`.source==='business_calendar'` 代表當天
   命中 Business Calendar 特殊營業）。

**確認的 root cause**：`productTimeReason` 是**單一共用變數**，只拿商品自己的
`line_sell_start`/`line_sell_end` 跟現在時間比較，完全沒有檢查
`takeoutSchedule.source`/`deliverySchedule.source` 是否為 `business_calendar`。
導致即使當天外送已經被特殊營業設定為 00:10–22:10 開放，商品自己的 LINE 販售時段
（例如 15:30–19:50）仍然生效，把明明可以買的商品誤判成「尚未販售」／「今日售完」。

## 2. 商品 LINE 販售時段來源

確認欄位為 `line_sell_start`／`line_sell_end`（`routes/products.js` 既有欄位，
本輪未修改），比對邏輯原本在 `GET /menu`（`routes/line-orders.js`）第 958-969 行
（修正前行號），本輪只修改這一段的比對依據，未修改欄位本身或其他讀取/寫入邏輯。

## 3. 特殊營業覆蓋規則

新增內部函式 `_computeProductTimeReason(schedule, sellStart, sellEnd)`（沿用既有
`getEffectiveModeSchedule()` 的回傳值判斷 `source`，**未新增第二套 Business
Calendar 解析邏輯**，符合需求文件第九點「不要建立平行第二套 Business Calendar
parser，優先沿用現有 `getEffectiveModeSchedule()`」的要求）：

```js
function _computeProductTimeReason(schedule, sellStart, sellEnd) {
  if (schedule.source === 'business_calendar') {
    // 特殊營業覆蓋商品自身 LINE 販售時段：今天這個模式不套用 line_sell_start/line_sell_end。
    return { reason: null, preSale: false };
  }
  if (sellEnd && nowHHMM >= sellEnd) return { reason: 'time_ended', preSale: false };
  if (sellStart && nowHHMM < sellStart) {
    if (allowPreorderBeforeStart) return { reason: null, preSale: true };
    return { reason: 'not_started', preSale: false };
  }
  return { reason: null, preSale: false };
}
const productTimeReasonTakeout  = _computeProductTimeReason(takeoutSchedule,  p.line_sell_start, p.line_sell_end).reason;
const productTimeReasonDelivery = _computeProductTimeReason(deliverySchedule, p.line_sell_start, p.line_sell_end).reason;
```

`productTimeReason` 從**一份共用變數**拆成 `productTimeReasonTakeout`／
`productTimeReasonDelivery` 兩份，各自依照自己模式的 `schedule.source` 決定要不要
套用商品自己的 LINE 販售時段。當天沒有命中 Business Calendar（`schedule.source===
'weekly_schedule'`）時，比對邏輯與修正前完全相同（既有行為零改變，見第 8 節 Case
R3-7 驗證）。

## 4. 保留庫存／停售限制

本輪**完全未修改**：

- `realSoldOut`（LINE 份數／配額用罄，`quota.hasQuota && quota.remaining<=0`）
- `productTakeoutDisabled`／`productDeliveryDisabled`（商品自身模式開關，
  `line_takeout_enabled`/`line_delivery_enabled`）
- `sale_status`（人工停售／商品未上架相關，`ss!=='available'` 檢查在
  `_productModeStatus()`，前端既有邏輯，本輪未觸碰）

這些判斷在 `takeoutSoldOutReason`/`deliverySoldOutReason` 的 if/else 鏈中，優先序
排在 `productTimeReasonTakeout`/`productTimeReasonDelivery` 判斷**之前**（`dayClosedReason`
→ `calendarModeClosed`→ `globalClosed` → `cutoff` → 商品時段 → `realSoldOut`），
特殊營業覆蓋只發生在「商品時段」這一個位階，不會、也不可能影響庫存/停售/模式支援
這些更高優先或更後面的獨立判斷。真實驗證：Case R3-5（份數用罄）、Case R3-6
（商品模式不支援）皆確認 Business Calendar 沒有覆蓋這些限制。

## 5. 外帶外送模式獨立

`productTimeReasonTakeout` 只看 `takeoutSchedule.source`，`productTimeReasonDelivery`
只看 `deliverySchedule.source`，兩者完全獨立計算——特殊營業只開放外送時，外送的商品
時段判斷會被覆蓋（因為 `deliverySchedule.source==='business_calendar'`），但外帶的
商品時段判斷不受影響（因為 `takeoutSchedule.source` 若當天沒有命中特殊營業，仍是
`'weekly_schedule'`，沿用既有邏輯；若外帶當天也被特殊營業關閉，則走
`calendar_mode_closed`/`mode_closed`分支，根本不會進入商品時段判斷）。真實驗證：
Case R3-1（外送覆蓋、外帶關閉）、Case R3-2（外帶覆蓋、外送關閉）皆確認兩模式互不
影響。

## 6. sold_out_reason 修正結果

真實 API 驗證（詳見第 8 節），修正後：

- 特殊營業時段覆蓋商品原本的「尚未開始」/「已結束」限制，讓 `takeout_sold_out_reason`/
  `delivery_sold_out_reason` 正確回傳 `null`（可購買）。
- 沒有特殊營業時，商品原本的 `product_not_started`/`product_time_ended` 判斷維持
  完全不變（Case R3-7 驗證前後行為一致）。

## 7. 商品卡排版未修改證明

`public/line-order.html` 以 Hotfix30-B5-R2 為基準逐行 `diff`，**輸出完全空白（零
差異）**。本輪的 root cause 與修正點都在後端 `routes/line-orders.js` 的商品售完原因
計算，商品卡的 HTML 結構、CSS、標籤顯示邏輯、`anyImmediate`/`canPreorderNextDay`
判斷式（Hotfix30-B5 已完成）完全沒有被觸碰——因為後端已經把正確的
`sold_out_reason`（`null`）算好並回傳，前端既有的「`reason===null` 代表可以買」
判斷邏輯自然就會正確顯示商品卡為正常可購買，不需要也沒有修改前端任何一行。

## 8. Case R3-1～R3-8 結果（真實本機 API）

| Case | 情境 | 結果 |
|---|---|---|
| R3-7（基準） | 無特殊營業，商品 LINE 時段 15:30–19:50（尚未開始） | **PASS** — `takeout_sold_out_reason="product_not_started"`（維持既有限制） |
| R3-1 | 特殊營業外送 00:10–22:10 開／外帶關，商品 LINE 時段 15:30–19:50 | **PASS** — 外送 `null`（覆蓋成功），外帶 `calendar_mode_closed` |
| R3-2 | 特殊營業外帶 00:10–22:10 開／外送關，商品 LINE 時段 15:30–19:50 | **PASS** — 外帶 `null`（覆蓋成功） |
| R3-3 | 特殊營業皆開，商品原時段尚未開始 | **PASS** — `null`（覆蓋成功，不顯示「尚未販售」） |
| R3-4 | 特殊營業皆開，商品原時段已結束 | **PASS** — `null`（覆蓋成功，不顯示「今日售完」/「已截止」） |
| R3-5 | 特殊營業開放，商品 LINE 份數用罄 | **PASS** — `real_sold_out`（Business Calendar 未覆蓋真實售完） |
| R3-6 | 特殊營業只開外送，商品只支援外帶 | **PASS** — 外送 `product_mode_disabled`（商品模式限制未被覆蓋） |
| R3-7（再次確認） | 今天沒有特殊營業 | **PASS** — 維持 `product_not_started`，行為與修正前一致 |
| R3-8 | 特殊營業兩模式皆關，允許未來預約 | **PASS** — `takeout_status.today_state="holiday"`（沿用既有休假中＋可預購邏輯，Hotfix30-B5 已完成，本輪未修改） |

**本輪累計：10/10 PASS，0 FAIL。**

## 9. Regression

```
node --check server.js              → OK
node --check routes/*.js            → OK
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

div 標籤平衡 187/187（與 Hotfix30-B5-R2 完全相同）；重複 DOM id：0；無測試用
`console.log`／除錯程式碼殘留；`GET /shop` 商品狀態正確、`GET /timeslots` 仍使用
特殊營業時段（Hotfix30-B5-R2 已修正，本輪未回歸）；`buildCard()`/
`updateProductCard()` 因為讀取同一份 `sold_out_reason` 欄位，顯示結果自然一致；
商品卡排版完全未變（第 7 節）；宅配檔案與 Hotfix30-B5-R2 完全一致（SHA-256 比對，
見第 10 節）。本輪未修改 `fulfillmentContext`／地址／外送費／Google Maps／
LINE Login／LINE Pay／Analytics／Dashboard／宅配／Android／商品卡排版。

## 10. 宅配未修改證明

以 **Hotfix30-B5-R2** 作為直接基礎版本逐檔 SHA-256 比對：

```
public/line-shipping.html : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f（完全一致）
routes/line-shipping.js   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655（完全一致）
```

## 11. 已知限制

1. **`pre_sale_available` 欄位維持單一共用值**（未拆成外帶/外送兩份），計算方式為
   「任一模式符合預售條件即為 true」，避免修改既有 API 回應結構；若未來需要區分
   「外帶可預售、外送不行」這種精細情境，需要另外評估是否要拆分此欄位。
2. **未使用完整瀏覽器測試**：延續前幾輪環境限制，本輪驗證全部透過真實本機 Node
   server + 真實 HTTP API 完成，未透過真實 DOM 操作重新確認商品卡在瀏覽器中的
   實際渲染結果（僅透過商品資料層 `sold_out_reason` 欄位與既有前端判斷邏輯的
   程式碼確認一致性）。

## 12. 回退方式

1. 還原 `routes/line-orders.js` 為 Hotfix30-B5-R2 版本內對應檔案即可（本版只修改
   這一個檔案，`public/line-order.html` 與 Hotfix30-B5-R2 完全相同，回退時甚至
   不需要處理）。
2. 未新增資料庫欄位、未修改 migration，回退不需要處理資料庫層面。
3. `line-shipping.html`／`line-shipping.js` 全程未修改，回退時無需處理。
