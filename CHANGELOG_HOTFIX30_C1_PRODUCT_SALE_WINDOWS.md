# fix18-10-hotfix30-C1｜LINE 商品外帶外送販售時段分流

## 1. 版本資訊

- **正式版本**：`fix18-10-hotfix30-C1`
- **名稱**：LINE 商品外帶外送販售時段分流
- **基礎版本**：Hotfix30-B5-R7（`pos-web-fix18-10-hotfix30-B5-R7-full.zip`）
- **交付物**：`pos-web-fix18-10-hotfix30-C1-full.zip` + 本 CHANGELOG

## 2. 為什麼從 B5-R8 升級為 C1

本次修改包含：新增 4 個資料庫欄位（DB Migration）、後端 API 行為變更（`PATCH
/:id/line-settings` 新增欄位與格式驗證、`GET /menu` 商品時段計算規則反轉）、管理後台
UI 重新設計（LINE 商品管理列表／單筆編輯 Modal／批次設定面板）。依原始需求文件第
二十五節「若實際修改包含 DB Migration、API 與管理 UI，請不要再沿用小型 R 版命名」
的指示，且審視後確認修改範圍確實不小，故採用正式版本 `fix18-10-hotfix30-C1`，不再
沿用 `Hotfix30-B5-R8` 這個小型 R 版命名。

## 3. 需求背景

系統原本只有一組共用的商品「LINE 販售時段」（`line_sell_start`/`line_sell_end`），
同時套用外帶與外送。這與「店家營業時間」是兩件不同的事：

- **店家營業時間**（`takeout_start/end`、`delivery_start/end`、cutoff、prep time）：
  決定店家今天是否接單、外帶/外送是否開放、可選時段。
- **LINE 商品販售時間**：決定「單一商品」何時開始/提前結束販售，用來實現限時販售、
  提前完銷、稀缺行銷策略，**不代表**店家停止營業，**不代表**其他商品停止販售。

共用一組時間的問題：店家外帶營業到 20:00、外送營業到 23:00，若商品販售時間設為
20:00 結束（原意只想限制外帶），外送也會被一起誤停售。

## 4. 店家營業時間與商品販售時間分工

```
第一層：店家營業層（本輪未修改一行）
  LINE 點餐總開關 → 今日臨時休息 → 今日特殊營業 → 每週營業時間
  → takeoutStatus / deliveryStatus / takeout|delivery effective schedule
  （getEffectiveModeSchedule()、resolveFulfillmentState()、getDateClosedStatus()
   全部 byte-identical，見第 20 節）

第二層：商品販售層（本輪修改）
  商品是否 LINE 上架 → 商品是否人工停售 → 商品是否支援目前取餐方式
  → 商品庫存／今日份數／配額 → 商品對應模式的 LINE 商品販售時間
  （getEffectiveProductSaleWindow()，見第 11 節）
```

商品販售時間**不得**、也**沒有**反過來改寫店家營業狀態——兩層資料流完全單向。

## 5. 四個新欄位

| 欄位 | 型別 | 用途 |
|---|---|---|
| `line_takeout_sell_start` | TEXT，可 NULL | 外帶商品販售開始時間 |
| `line_takeout_sell_end`   | TEXT，可 NULL | 外帶商品販售結束時間 |
| `line_delivery_sell_start`| TEXT，可 NULL | 外送商品販售開始時間 |
| `line_delivery_sell_end`  | TEXT，可 NULL | 外送商品販售結束時間 |

舊欄位 `line_sell_start`/`line_sell_end` **完全保留**，作為向下相容 fallback，未
刪除、未改變語意、未強制搬移既有資料。

## 6. Migration

`routes/products.js` 新增 `ensureProductSaleWindowColumns(db)`，與既有
`ensureProductPreorderColumns()`/`ensureProductModeColumns()` 完全同一套 runtime-safe
模式：

```js
function ensureProductSaleWindowColumns(db) {
  const COLS = [
    ['line_takeout_sell_start',  'TEXT'],
    ['line_takeout_sell_end',    'TEXT'],
    ['line_delivery_sell_start', 'TEXT'],
    ['line_delivery_sell_end',   'TEXT'],
  ];
  // PRAGMA table_info(products) 取得現有欄位 → 缺欄位才 ALTER TABLE ADD COLUMN
  // 已存在則 continue 略過；不重建整張表；例外訊息含 "already exists" 時安全忽略。
}
```

呼叫時機：`server.js` 開機時（`initDb().then()` 內，與 `ensureProductModeColumns`
同一位置）自動呼叫一次；`PATCH /:id/line-settings` 每次請求也會呼叫一次（雙重保險，
即使開機時因故未執行成功，第一次編輯商品時仍會自動補欄位）。

**實測驗證**（本機真實 SQLite 檔案資料庫，非模擬）：

1. 空白資料庫啟動 → log 印出 4 行 `✅ ALTER TABLE products ADD COLUMN
   line_takeout_sell_start/end`、`line_delivery_sell_start/end`，欄位成功建立。
2. 同一個資料庫檔案重新啟動伺服器（欄位已存在）→ **不再印出任何 ALTER TABLE
   訊息**，也沒有任何 error，確認冪等（可重複執行不報錯）。
3. 兩次啟動之間，透過 `GET /api/line-menu` 確認既有商品資料（名稱、既有欄位）
   完整保留，未被清空或搬移。
4. Migration 全程只使用 `ALTER TABLE products ADD COLUMN`，未執行任何
   `DROP TABLE`/`CREATE TABLE`，不重建整張表。
5. 新欄位定義為 `TEXT`（無 `NOT NULL`），允許 NULL；實測 `GET /api/line-menu`
   回傳新商品的這 4 個欄位皆為 `null`（尚未編輯過）。
6. 回退相容性：由於本次只用 `ADD COLUMN`（不修改任何既有欄位定義、不刪除任何
   既有欄位），若之後需要回退到 R7 版本程式碼，R7 版本的 SQL 陳述式（`SELECT *`、
   既有的 `UPDATE products SET ...`）在含有這 4 個新欄位的資料庫上依然能正常執行
   ——多出來的欄位只是被忽略，不會造成 R7 程式碼讀取失敗。

## 7. API partial update

`PATCH /api/products/:id/line-settings` 新增支援 4 個欄位，遵循既有 `add()` 慣例
（`if (val !== undefined) 才寫入`），因此：

- 只傳外帶欄位 → **外送欄位完全不受影響**（實測：先設定外帶=10:00~12:00、
  外送=13:00~15:00，之後只 PATCH 外帶=09:00~11:00，回應確認外送仍是
  13:00~15:00 原封不動）。
- 只傳外送欄位 → **外帶欄位完全不受影響**（同一產品，只 PATCH
  外送=14:00~16:00，外帶仍是剛才設定的 09:00~11:00，未被清空或改變）。
- 完全不傳這 4 個欄位（例如只更新 `line_hot`）→ 4 個欄位**維持原值**，未被清空。
- 新增 HH:mm 格式驗證：`/^([01]\d|2[0-3]):[0-5]\d$/`，空字串允許（代表清空/
  fallback），非空但格式錯誤時回傳 `400`＋清楚訊息（實測：傳入
  `line_takeout_sell_start:"25:99"` → `HTTP 400 {"success":false,"message":
  "line_takeout_sell_start 時間格式錯誤，必須是 HH:mm（例如 09:30）"}`）。

`GET /api/products`、`GET /api/products/line-products/list`、
`GET /api/products/:id` 皆透過 `enrichProduct()` 回傳新增的 4 個欄位（空值統一回傳
空字串，與既有 `line_sell_start`/`line_sell_end` 慣例一致）。

`GET /api/line-menu` 依 `mode` 分別計算並回傳獨立的
`takeout_sold_out_reason`／`delivery_sold_out_reason`，兩者可以不同（見第 13 節）。

## 8. 單筆 LINE 設定 Modal

`public/index.html` 的「⚙️ LINE 設定」Modal 原本只有一組共用的「LINE 販售開始/
結束時間」（`lineSellStart`/`lineSellEnd`），本輪拆成兩個獨立分組：

```
【🛍️ 外帶商品販售時間】
  外帶開始（lineTakeoutSellStart）
  外帶結束（lineTakeoutSellEnd）

【🛵 外送商品販售時間】
  外送開始（lineDeliverySellStart）
  外送結束（lineDeliverySellEnd）
```

- 開啟 Modal 時（`openLineSettingsModal()`），輸入框只顯示**該商品新欄位的實際值**
  （空就是空，絕不把 fallback 後的舊欄位值填進輸入框），避免使用者誤以為那是系統
  幫忙帶入的自訂設定。
- 新欄位為空、但舊共用欄位 `line_sell_start`/`line_sell_end` 有值時，輸入框下方
  顯示橘色提示文字：「目前沿用舊版共用販售時段：HH:mm～HH:mm（未另外設定此模式的
  自訂時段）」，清楚區分「實際自訂值」與「舊欄位 fallback」。
- 儲存時（`saveLineSettings()`）只送出這 4 個新欄位輸入框當下的值，**完全不讀取、
  不寫回** `line_sell_start`/`line_sell_end`——舊欄位只在載入時被讀取用來組成上方
  提示文字，儲存動作永遠不會修改到它們。
- Modal 底部另有一行通用提示：「外帶／外送販售時間各自獨立，互不影響。留空時沿用
  舊版共用販售時段；若舊版時段也為空，則跟隨店家該模式營業時間（不額外限制）。」

## 9. 管理列表四欄

`LINE 商品管理` 表格原本的「販售開始／販售結束」2 欄，拆成 4 欄：**外帶起／外帶迄／
外送起／外送迄**（欄位標題皆有 `title` tooltip 說明用途），表格 `colspan` 隨之從
14 調整為 16。行內顯示值＝「新欄位有值就顯示新欄位；新欄位空、舊欄位有值就顯示
舊欄位的值（fallback 顯示，與 Modal 提示文字同一套規則）；兩者皆空顯示『不限』」。
`calcLpmStatus()`（決定該行狀態徽章文字）比照顧客端 union-of-modes 原則調整：
外帶／外送兩個模式各自獨立判斷「是否已結束/尚未開始」，只有兩個（有效啟用的）
模式都結束/都還沒開始時，才顯示「今日售完」／「尚未開賣」；任一模式仍在有效
販售視窗內就視為可販售。

## 10. 批次設定

批次面板的共用「販售時段」輸入（`lpm-today-start`/`lpm-today-end`）**已移除**，
改為兩個獨立區塊：

```
【🛍️ 外帶商品販售時間】開始/結束 + 「套用至勾選商品」按鈕 → lpmBatch('sell_time_takeout')
【🛵 外送商品販售時間】開始/結束 + 「套用至勾選商品」按鈕 → lpmBatch('sell_time_delivery')
```

單項操作按鈕列同步從 1 個「只更新販售時段」拆成 3 個：「只更新外帶販售時段」／
「只更新外送販售時段」／「同時更新外帶+外送時段」（`sell_time_takeout` /
`sell_time_delivery` / `sell_time_both`），各自只把對應模式的欄位放進 PATCH
body，不放的欄位不會被 `add()` 覆蓋，因此不會誤動未選擇的模式。「套用今日設定」
主按鈕（份數/門檻）已移除對舊共用時段輸入框的殘留讀取，避免引用已從畫面移除的
DOM 元素。

**實測驗證**：模擬批次操作套用到商品 1、2（改為外帶=07:00~08:30），商品 3 事先
設定外帶=08:00~09:00 且**不在**本次批次範圍內——套用後商品 1、2 確認變更生效，
商品 3 確認完全維持原值 `08:00~09:00`，未被誤動。

## 11. `getEffectiveProductSaleWindow(product, mode)`

新增於 `routes/line-orders.js`：

```js
function getEffectiveProductSaleWindow(product, mode) {
  const p = product || {};
  const start = mode === 'delivery'
    ? (p.line_delivery_sell_start || p.line_sell_start || null)
    : (p.line_takeout_sell_start  || p.line_sell_start || null);
  const end = mode === 'delivery'
    ? (p.line_delivery_sell_end || p.line_sell_end || null)
    : (p.line_takeout_sell_end  || p.line_sell_end || null);
  return { start: start || null, end: end || null };
}
```

`_computeProductTimeReason()`（`GET /menu` 內）改為呼叫此函式取得每個模式各自的
有效販售時段，取代原本共用 `p.line_sell_start`/`p.line_sell_end` 的寫法。

## 12. 舊欄位 fallback

嚴格規則（與需求文件第七節、第十二節一致）：

```
takeout: line_takeout_sell_start/end 有值 → 用它
         皆空 → fallback line_sell_start/end
         舊欄位也空 → null（不額外限制，跟隨店家外帶營業時間）

delivery 同理，使用 line_delivery_sell_start/end
```

新欄位優先、舊欄位只作 fallback，兩者不會互相覆蓋（見第 15 節 Case R8-6/R8-7 實測）。

## 13. 特殊營業不再取消商品販售時間（規則反轉，本版核心變更）

**R3～R7 的舊規則**：只要當天命中 Business Calendar 特殊營業，就完全不套用商品
自己的 `line_sell_start`/`line_sell_end`（`_computeProductTimeReason()` 內
`if (schedule.source === 'business_calendar') return {reason:null}`）。

**C1 新規則**：移除上述判斷式。特殊營業只決定「店家這個模式今天的營業區間」
（`takeoutSchedule`/`deliverySchedule.enabled`、`toCutoff`/`dlCutoff`，完全不變），
商品自己的 LINE 販售時間在該區間內**仍然獨立生效**，用來實現「提前完銷」「限時
販售」等行銷策略。店家是否營業與商品是否在自己的販售時段內，兩者必須**同時成立**
商品才可立即購買。

## 14. `sold_out_reason` 外帶／外送獨立

`takeout_sold_out_reason`／`delivery_sold_out_reason` 分別依各自模式的
`getEffectiveProductSaleWindow()` 計算，可以不同（例如外帶已 `product_time_ended`、
外送仍為 `null` 可購買），不再共用一份 `productTimeReason`。硬性限制優先序完全
未變：`product_mode_disabled` → 今日休假 → `calendar_mode_closed` → `mode_closed`
→ `cutoff_sold_out` → **商品時段**（`product_time_ended`/`product_not_started`，
本輪唯一變更計算方式的一環）→ `real_sold_out`。商品時段判斷排在庫存/模式/停售
之後，因此無法覆蓋這些硬性限制（見第 15 節 Case R8-8/R8-9）。

## 15. Case R8-1～R8-10 結果（真實本機伺服器 + 真實 API 呼叫，測試時間點 2026-07-22
    台灣時間 23:1x～23:2x，時間相關 Case 均以「當下實際系統時間」為基準推算相對窗口，
    而非直接套用文件範例中的絕對時刻，測試邏輯與文件描述完全對應）

| Case | 情境 | 結果 |
|---|---|---|
| R8-1 | 特殊營業外送涵蓋現在，商品外送販售視窗涵蓋現在 | **PASS** — 店家 `delivery today_state="open"`，`delivery_sold_out_reason=null` |
| R8-2 | 同上，商品外送販售視窗已結束（店家仍營業） | **PASS** — 店家仍 `open`，該商品 `delivery_sold_out_reason="product_time_ended"`；另一商品（外送販售到更晚）確認仍為 `null`，證實其他商品不受影響 |
| R8-3 | 特殊營業外帶＋外送皆開，商品外帶視窗已結束、外送視窗未結束 | **PASS** — `takeout_sold_out_reason="product_time_ended"`，`delivery_sold_out_reason=null`，`is_orderable=true`（商品卡整體仍可購買） |
| R8-4 | 一般每週外帶營業（`schedule_source="weekly_schedule"`），商品外帶視窗已結束 | **PASS** — 店家 `open`，商品 `takeout_sold_out_reason="product_time_ended"` |
| R8-5 | 一般每週外送營業，商品外送視窗邊界測試 | **PASS** — 結束時間仍在未來（now 之後 3 分鐘）時 `delivery_sold_out_reason=null`；結束時間已過（now 之前 1 分鐘）時變為 `"product_time_ended"`，邊界轉換正確 |
| R8-6 | 只有舊欄位 `line_sell_start/end` 有值，新欄位全空 | **PASS** — 外帶／外送在視窗內時皆 `null`，視窗結束後外帶／外送**同時**變為 `"product_time_ended"`（證實兩者共用同一份 fallback，等同舊版單一時段行為，行為不變） |
| R8-7 | 舊欄位視窗已過期（30 分鐘前結束），新欄位視窗仍開放 | **PASS** — 外帶／外送皆為 `null`（可購買），證實新欄位完全優先於舊欄位，即使舊欄位已經「過期」也不影響新欄位生效中的判斷 |
| R8-8 | 商品時間視窗仍有效，但 LINE 今日份數已用罄（quota daily=3, sold=3） | **PASS** — 外帶／外送皆為 `"real_sold_out"`，時間有效不能恢復銷售 |
| R8-9 | 商品只支援外帶（`line_delivery_enabled=0`），但設有外送販售視窗 | **PASS** — `delivery_sold_out_reason="product_mode_disabled"`（保留），`takeout_sold_out_reason=null`（不受影響） |
| R8-10 | 今日臨時休息 ON，商品外帶／外送視窗皆有效 | **PASS** — `takeout_status.today_state="holiday"`，`delivery_status.today_state="holiday"`，商品 `takeout_sold_out_reason`/`delivery_sold_out_reason` 皆為 `"today_closed"`，商品時段完全未能覆蓋臨時休息 |

**本輪累計：10/10 PASS，0 FAIL。**

## 16. API 與批次更新結果

| 驗證項目 | 結果 |
|---|---|
| 只傳外帶欄位，外送欄位不變 | **PASS**（第 7 節實測） |
| 只傳外送欄位，外帶欄位不變 | **PASS**（第 7 節實測） |
| 完全不傳這 4 個欄位（只改 `line_hot`），4 個欄位維持原值 | **PASS** |
| 非法時間格式（`"25:99"`）→ `400` + 清楚錯誤訊息 | **PASS** |
| 批次「只更新外帶」只影響勾選商品，未勾選商品完全不變 | **PASS**（第 10 節實測，商品 3 未受影響） |

## 17. Regression

```
node --check server.js                    → OK
node --check routes/*.js                  → OK（全部檔案逐一通過）
node --check utils/*.js                   → OK（全部檔案逐一通過）
node --check public/js/*.js               → OK（全部檔案逐一通過）
node --check scripts/*.js                 → OK（全部檔案逐一通過）
抽取 public/index.html 內 <script> 區塊    → 0 個（邏輯全在 public/js/app.js，
                                              已於上方 node --check 驗證）
抽取 public/line-order.html 內 2 個 <script> 區塊 → node --check → OK
```

另確認：
- `public/index.html`：`id` 屬性總數 713 個，**零重複**；`<div>`/`</div>` 780/780
  **平衡**。
- `public/line-order.html`：`id` 屬性總數 79 個，**零重複**；`<div>`/`</div>`
  187/187 **平衡**，與 R7 完全相同（此檔案本身與 R7 byte-identical，見第 19 節）。
- Migration 可重複執行（第 6 節）。
- 新欄位 API 正常、partial update 不清空未傳欄位、外帶/外送時段獨立、legacy
  fallback 正常（第 7、15、16 節）。
- R8-1～R8-10 全部 PASS（第 15 節）。
- R7 Cart Sync 無回歸：實測 `addCart()`→`persistCart()` 正常、`applyFulfillmentMode()`
  切換模式後 `pDate` 正確維持在今天、`cart` 數量正確保留——因為
  `public/line-order.html` 本輪 byte-identical，R7 的
  `refreshCartProductsFromLatestMenu()`/`refreshDateSelectorForCart()` 邏輯本身
  一行未動，只是它們消費的後端 `takeout_sold_out_reason`/`delivery_sold_out_reason`
  資料現在由新規則計算，資料流向未變。
- R6 今日臨時休息優先序無回歸：實測今日臨時休息 ON + Business Calendar 全天候
  開放的情境，`takeout_status`/`delivery_status` 仍正確回傳 `"holiday"`，未被
  Business Calendar 覆蓋（`getDateClosedStatus()` byte-identical，見第 20 節）。
- R5 Timeslot Builder／R4 Mode Isolation 無回歸：兩者相關函式
  （`resolveFulfillmentState()`、`getEffectiveModeSchedule()`、
  `applyFulfillmentMode()`、`buildDateSelector()`、`buildTimeSelector()`）本輪
  完全未修改，且 `public/line-order.html`／`routes/line-orders.js` 內這些函式
  部分皆 byte-identical 或未被觸碰（`routes/line-orders.js` 只有
  `_computeProductTimeReason()`／`getEffectiveProductSaleWindow()`／其呼叫端
  三處改動，其餘函式一行未動）。
- `public/line-shipping.html`、`routes/line-shipping.js` 與 R7 `diff` 確認
  byte-identical（第 19 節）。
- `package.json`／`package-lock.json` 與 R7 `diff` 確認 byte-identical（未因本機
  測試安裝 jsdom 而產生任何變更，本次測試自始至終使用 `--no-save` 或於交付前
  完整移除 `node_modules`，未寫入任何測試專用套件到正式相依清單）。
- 無測試資料／trace log／jsdom 暫存殘留：交付前已手動移除 `node_modules/`、`data/`
  （執行期 SQLite 檔案，含測試用商品/行事曆/臨時休息設定），原始 R7 zip 本身也不
  包含這兩個目錄（沿用 R6/R7 一貫的打包排除規則）。

## 18. 顧客端商品卡零修改證明

`public/line-order.html` 與 R7 **byte-identical**（`diff` 結果為空），因此
`buildCard()`／`updateProductCard()`／商品卡 HTML／CSS／Badge 位置／商品圖片高度／
商品名稱／價格／加號位置**全部保持原樣、零改動**。前台看到的「外帶已結束、外送
仍可買 → 商品卡整體正常（union-of-modes 判斷本身完全沒動）」「兩模式都
`product_time_ended` → 沿用既有完售/預購顯示」等行為變化，完全是因為後端傳來的
`takeout_sold_out_reason`/`delivery_sold_out_reason` 值不同而自然呈現，前端判斷式
與渲染邏輯本身一行未改。

## 19. R7 Cart Sync 無回歸／Shipping byte-identical 證明

已用 `diff -rq`（排除 `node_modules`/`data`）對整個工作目錄與 R7 逐檔案比對，確認
只有以下 5 個檔案不同：

```
public/index.html          +69 / -20
public/js/app.js            +121 / -35
routes/line-orders.js       +45 / -19
routes/products.js          +78 / -0
server.js                   +4  / -1
```

其餘所有檔案，包含 `public/line-order.html`、`public/line-shipping.html`、
`routes/line-shipping.js`、`package.json`、`package-lock.json`、
`utils/*.js`、`public/js/`（除 `app.js` 外的其他檔案）、`scripts/*.js` 皆確認與
R7 byte-identical。

## 20. R6 臨時休息優先序無回歸證明

`routes/line-orders.js` 內 `getDateClosedStatus()`（R6 完成的「今日臨時休息 >
Business Calendar > 固定公休」優先序）、`resolveFulfillmentState()`、
`getEffectiveModeSchedule()` 三個函式本輪**一行未改**（本輪唯一觸碰
`routes/line-orders.js` 的部分是新增 `getEffectiveProductSaleWindow()` 這個獨立
函式，以及 `_computeProductTimeReason()` 與其兩個呼叫點）。第 17 節已用真實 API
請求重新驗證：今日臨時休息 ON 時，即使 Business Calendar 當天為全天候開放
（`00:00~23:59`），`takeout_status`/`delivery_status` 仍正確為 `holiday`，未被
覆蓋。

## 21. Known Limitations（誠實揭露，未隱瞞）

**目前 fallback 規則只有兩層，沒有第三種狀態**：

```
新欄位（line_takeout_sell_start/end 或 line_delivery_sell_start/end）有值
  → 使用新欄位

新欄位為空
  → fallback 舊欄位 line_sell_start / line_sell_end

舊欄位也空
  → 跟隨店家該模式營業時間（不額外限制）
```

**已知限制（明確且刻意，非疏漏）**：若商家的舊欄位 `line_sell_start`/
`line_sell_end` 仍有值，單純把某一個模式的新欄位（例如 `line_delivery_sell_start`/
`line_delivery_sell_end`）清空，**不能**代表「取消該模式的商品時間限制」——因為
系統會自動 fallback 回舊欄位，該模式仍然會受舊欄位的時間限制。

**本版沒有新增 tri-state flag / use_custom flag**。若未來需要把以下三種狀態
完全區分（例如透過一個獨立的 `line_delivery_sell_mode` 欄位，值可能是
`'inherit_legacy'` / `'follow_store_hours'` / `'custom'`）：

1. 跟隨舊共用設定（目前 fallback 行為）
2. 完全不限制、跟隨店家該模式營業時間（目前商家必須「舊欄位也清空」才能達成，
   若舊欄位還有其他模式在用就做不到「只取消其中一個模式」）
3. 使用自訂模式時間（目前的新欄位有值時的行為）

則需要另開版本設計新的 schema（新增旗標欄位），本版依照原始需求文件第七節
「本版請先依原規格：空值 = fallback 舊欄位」的指示，刻意不新增額外欄位/flag。

另外兩項次要限制：

1. 管理列表的狀態徽章（`calcLpmStatus()`）為求呈現一致性，採「任一模式仍在視窗
   內即視為可販售」的 union-of-modes 簡化邏輯；若商家需要「分別看外帶/外送各自
   的即時狀態」，需要展開成兩個獨立徽章，本版為避免管理頁 UI 過度複雜，維持單一
   狀態欄位（實際的四個時間值仍分開顯示於表格四欄，商家可自行判讀）。
2. `GET /api/line-menu` 的商品物件是輕量直接展開（`...p`）而非透過
   `routes/products.js` 的 `enrichProduct()`，因此新欄位在該端點若尚未編輯過
   會回傳原生 `null`（而非 `enrichProduct()` 慣用的空字串 `''`）；兩者在 JS 中
   都是 falsy，不影響任何判斷邏輯，但直接消費 `/api/line-menu` 原始回應的第三方
   整合若對 `null` vs `''` 做嚴格型別比對，需注意此差異（既有其他可為空欄位在
   `/menu` 端點也是同樣行為，非本輪新增的不一致）。

## 22. 回退方式

本次修改僅涉及 5 個檔案：`public/index.html`、`public/js/app.js`、
`routes/line-orders.js`、`routes/products.js`、`server.js`。回退方式：

1. 將這 5 個檔案還原成 Hotfix30-B5-R7 的版本即可完整回退。由於 Migration 只用
   `ADD COLUMN`（未刪除/修改既有欄位），回退後的 R7 程式碼可以正常讀寫同一個
   資料庫檔案，4 個新欄位會被 R7 的 `SELECT *`/`enrichProduct()` 忽略（R7 版
   `enrichProduct()` 不會特別處理這幾個新欄位名稱，但也不會因為它們存在而出錯），
   不需要額外的資料庫遷移或欄位清理。
2. 若只需要回退「特殊營業不再取消商品時間」這個規則反轉，但保留欄位拆分本身，
   可以單獨在 `_computeProductTimeReason()` 內重新加回
   `if (schedule.source === 'business_calendar') return {reason:null}` 這個
   判斷式（等同還原成 R3～R7 的規則），但不建議這樣局部回退，容易造成
   「規則版本」與「欄位版本」不一致，若需要回退建議整批回退到 R7。
