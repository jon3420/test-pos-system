# fix18-10-hotfix30-B5-R7｜臨時休息 Banner 去重 × 購物車商品狀態同步 × 特殊營業今日時段修正

基礎版本：**Hotfix30-B5-R6**（`pos-web-fix18-10-hotfix30-B5-R6-full.zip`）。**只修改
`public/line-order.html` 一個檔案**，其餘所有檔案（含 `routes/line-orders.js`、
`routes/business-calendar.js`、`routes/line-shipping.js`、`utils/*.js`、
`public/js/*.js`、`scripts/*.js`、`package.json`）與 R6 逐位元組（byte-identical）——
已用 `diff -rq`（排除 `node_modules`／`data`／測試用暫存腳本）對整個工作目錄逐檔案
比對確認，差異報告只列出 `public/line-order.html` 一個檔案。

## 1. Root Cause A：首頁 Banner 無互斥

審計 `init()`／`buildServiceStatusBar()`／`renderHolidayPreorderBanner()` 後確認：

- `#bizCalBanner`（Business Calendar 特殊營業提示）只獨立判斷 `calToday.matched`，
  完全不檢查 `todayClosed`（即 `holiday_banner.active`，涵蓋今日臨時休息／Business
  Calendar 全休／固定公休三種來源，命名沿用既有全域變數）。
- `buildServiceStatusBar()` 一律無條件執行，`todayClosed=true` 時走
  `toStatus.state==='holiday' && dlStatus.state==='holiday'` 分支，顯示
  「📢 今日未營業」，與 `#holidayBanner` 同時出現。
- `renderHolidayPreorderBanner(gate)` 對 `gate.blockType==='holiday_preorder'`
  （代表整店休假，來源與 `#holidayBanner` 顯示條件完全相同）另外顯示一份
  「📅 今日臨時休息」，與 `#holidayBanner` 內容重複。

四份獨立渲染的結果：今日臨時休息時，首頁同時出現「今日臨時休息」「今日特殊營業」
「今日未營業」「今日臨時休息（藍色框）」四份訊息，其中「今日特殊營業」與實際「今天
完全不營業」互相矛盾。

**修正後**：三處全部改為以 `todayClosed` 做互斥判斷——`todayClosed=true` 時只保留
`#holidayBanner`（本身已依 `holiday_banner.type` 正確區分「今日臨時休息／今日休假中／
今日固定公休」文案，未修改），`#bizCalBanner`／`#serviceStatusBar`／
`#holidayPreorderBanner` 全部隱藏；`todayClosed=false` 時三者維持原有邏輯正常顯示
（`renderHolidayPreorderBanner()` 保留給 `today_not_open_preorder`——即「非整店休假，
只是模式今天沒開，但允許預約」——這種 `#holidayBanner` 本來就不會顯示任何內容的情境）。

## 2. Root Cause B：Cart 商品快照過期

審計 `addCart()`／`addPreorderToCart()`／`refreshDateSelectorForCart()` 後確認：
`cart[id].product` 保存的是「加入購物車那一刻」`/menu` 回應的商品物件快照（含
`takeout_sold_out_reason`／`delivery_sold_out_reason`／`takeout_can_next_day`／
`delivery_can_next_day`）。之後店家取消今日臨時休息、Business Calendar 更新、
`today_state` 改變時，這份快照**不會自動更新**。`refreshDateSelectorForCart()` 的
`needsNextDay` 判斷直接讀取 `cart[id].product` 這幾個欄位，因此會沿用「今日臨時休息時」
留下的舊值（例如 `delivery_sold_out_reason='today_closed'`、
`delivery_can_next_day=true`），即使現在其實已經恢復營業、今天有合法時段，仍把日期
強制跳到明天。問題不在 Timeslot Builder，也不在 Business Calendar 本身（兩者本輪皆
未修改），而是購物車商品快照沒有跟著重新整理。

## 3. Banner 去重規則（實作）

```
todayClosed(holiday_banner.active) === true
  → 只顯示 #holidayBanner（依 type 顯示今日臨時休息／今日休假中／今日固定公休）
  → #bizCalBanner 隱藏
  → #serviceStatusBar 隱藏（不顯示「今日未營業」／「今日服務」）
  → #holidayPreorderBanner 隱藏（不再顯示重複的「今日臨時休息」藍色框）

todayClosed === false
  → #holidayBanner 隱藏
  → #bizCalBanner 依 calToday.matched/mode 正常顯示（既有邏輯，未改）
  → #serviceStatusBar 依 getFulfillmentStatus() 正常顯示（既有邏輯，未改）
  → #holidayPreorderBanner 只在 blockType==='today_not_open_preorder' 時顯示（既有文案，未改）
```

## 4. `refreshCartProductsFromLatestMenu()`（新增函式）

```js
let _cartSyncSeq = 0;
async function refreshCartProductsFromLatestMenu(latestProducts){
  const ids=Object.keys(cart);
  if(!ids.length) return;
  const mySeq = ++_cartSyncSeq;
  let products=latestProducts;
  if(!products){
    try{
      const mr=await apiFetch('/api/line-menu').then(r=>r.json());
      if(!mr.success) return;
      categories=mr.data.categories||[]; allProducts=mr.data.products||[];
      products=allProducts;
    }catch(e){ console.warn('[cart-sync] ... 保留現有購物車商品快照：', e.message); return; }
  }
  if(mySeq !== _cartSyncSeq) return; // 較舊、較慢的回應，放棄寫入（見第 9 節）
  const latestById=new Map(products.map(p=>[String(p.id),p]));
  ids.forEach(id=>{ const latest=latestById.get(String(id)); if(latest) cart[id].product=latest; });
}
```

可傳入已抓取好的 `products` 陣列（`refreshShopStatus()` 使用此路徑，避免重複打
`/menu`）；不傳入時自行呼叫 `/api/line-menu`。找不到對應 id 的商品時保留原快照，
不刪除購物車項目（交由既有 `restoreCart()` 的下架偵測流程處理）。

## 5. Cart 同步欄位

只整份覆蓋 `cart[id].product`（商品物件本身，含 `sold_out_reason`／`can_next_day`／
`line_quota`／`line_preorder`／庫存等所有既有欄位），**不觸碰**購物車其他任何資料：
`qty`（數量）、`customer`（姓名/電話）、`delivery_address`／`delivery_address_note`／
`deliveryLatLng`／`calcDeliveryFee`（外送地址與費用）、`payment_method`、
`order_note`、`cart_id`／`visitor_id`／`session_id`、已選日期/時間（除非該日期/時間
因新資料而失效，此判斷完全沿用既有 `refreshDateSelectorForCart()`/`buildDateSelector()`
邏輯，未新增規則）。第 9 節實測（Case R7-9）已驗證外送地址/lat-lng/姓名/電話在同步前後
逐字元相同。

## 6. API 失敗保護

`refreshCartProductsFromLatestMenu()` 內部 fetch 失敗時：捕捉例外、記錄
`console.warn('[cart-sync] ...')`（不含任何個資／訂單內容，只有錯誤訊息字串）、
`return` 保留現有 `cart` 原樣，不拋出例外中斷呼叫端（`refreshDateSelectorForCart()`／
`refreshShopStatus()`）的後續流程。第 9 節已用模擬網路失敗（`fetch` 直接
reject）實測：購物車資料在失敗前後逐位元組相同，呼叫端無 unhandled rejection。

## 7. `refreshShopStatus()` 整合

在既有「偵測到 `takeoutCutoffPassed`／`deliveryCutoffPassed`／`todayClosed`／
`takeoutEnabled`／`deliveryEnabled` 任一改變」的既有判斷區塊內（未新增新的判斷條件，
只在區塊尾端加呼叫），於既有的 `buildDateSelector()`／`renderMenu()`／
`refreshModeCutoffUI()`／`updateModeAvailabilityUI()` 執行**之後**，呼叫
`refreshCartProductsFromLatestMenu(_latestMenuProducts)`（重用該區塊已經抓取過的
`/menu` 回應，不重複發送請求），若購物車 sheet 正開著，再呼叫一次
`refreshDateSelectorForCart()` 讓日期/時段立即反映最新狀態，不必等使用者手動重新
打開購物車。放在既有 `buildDateSelector()` 呼叫之後執行，確保購物車最終顯示的日期
一定是「用最新快照重新判斷過」的結果。

## 8. `refreshDateSelectorForCart()` 整合

函式最開頭加入 `await refreshCartProductsFromLatestMenu();`（不傳參數，自行抓取
`/menu`），確保 `needsNextDay` 判斷永遠讀取最新的 `cart[id].product`，不再使用
「加入購物車當下」或任何更早時間點的舊快照。`applyFulfillmentMode()`
（切換外帶/外送唯一入口）與 `openCartSheet()`（重新開啟購物車）本身皆已呼叫
`refreshDateSelectorForCart()`（既有呼叫點，未修改呼叫方式），因此「切換外帶/外送」
與「重新開啟 Cart」兩個觸發時機自動獲得同步效果，不需要另外修改這兩個函式。

## 9. Race Condition 結果

實測方式：模擬購物車內有商品，連續呼叫兩次 `refreshCartProductsFromLatestMenu()`
（間隔 20ms，模擬快速切換模式觸發兩次同步），並用假 `fetch` 讓**第一次（較舊）呼叫
延遲 800ms 回應「舊資料」，第二次（較新）呼叫延遲 100ms 回應「新資料」**（完全符合
需求文件第十節的測試腳本）。

- **修正前（無 request 順序保護）實測結果：FAIL**——較舊的回應在較新的回應已經寫入
  之後才 resolve，把 `cart[1].product.takeout_sold_out_reason` 從新值 `null`
  蓋回舊值 `"STALE_OLD"`。**確認存在真實 race condition**，因此依需求文件「只在實測
  確認有 race 問題時才做最小修正」的指示，加入最小修正（`_cartSyncSeq` 呼叫序號保護，
  見第 4 節程式碼），不引入 `AbortController`／取消機制等大改動。
- **修正後實測結果：PASS**——同一測試腳本，`cart[1].product.takeout_sold_out_reason`
  最終正確保持新值 `null`，較舊的回應被序號保護擋下、放棄寫入。
- 額外壓力測試：購物車開啟狀態下，同時併發觸發 `applyFulfillmentMode('delivery')`／
  `applyFulfillmentMode('takeout')`／`refreshShopStatus()`×2（共 4 個併發非同步呼叫），
  全程監聽 `window.onerror`／`unhandledrejection`／`jsdomError`——**PASS，0 個錯誤**，
  購物車數量在混亂併發後仍正確保持為 1，無無限迴圈（無遞迴呼叫鏈：
  `refreshDateSelectorForCart()` 不會呼叫 `refreshShopStatus()`）。
- 請求量：`refreshShopStatus()` 觸發同步時重用已抓取的 `/menu` 陣列（不重複 fetch）；
  `refreshDateSelectorForCart()` 每次被呼叫時固定呼叫一次 `/menu`（呼叫時機本身未變：
  仍是既有的「開啟購物車」「切換模式」兩個既有觸發點，未新增額外的自動觸發頻率），
  無 request storm。

## 10. Case R7-1～R7-10 結果（真實本機伺服器 + jsdom 真實渲染整份 `public/line-order.html`
    + 真實 HTTP 呼叫 `/api/line-shop`／`/api/line-menu`／`/api/settings`／
    `/api/settings/business-calendar`，測試時間點：2026-07-22 台灣時間 21:2x～21:5x）

| Case | 情境 | 結果 |
|---|---|---|
| R7-1 | today_closed=true，Business Calendar 外送開／外帶關 | **PASS** — 只有 `#holidayBanner` 顯示（`display:block`，內容「🌙 今日臨時休息／可預訂其他營業日期」），`#bizCalBanner`／`#serviceStatusBar`／`#holidayPreorderBanner` 皆 `display:none`。 |
| R7-2 | today_closed=true + Business Calendar 外送 14:29~23:29；先加入商品（快照 `delivery_sold_out_reason="today_closed"`）；取消 today_closed；觸發 `refreshShopStatus()`；切外送 | **PASS** — 取消前確認快照為 `"today_closed"`；`refreshShopStatus()` 後 `cart[1].product.delivery_sold_out_reason` 更新為 `null`（可購買），`qty` 保持 `1`；切到外送後 `pDate.value="2026-07-22"`（今天），`pTime` 選項為 `["22:30","23:00"]`（今天剩餘合法時段），未跳明天。 |
| R7-3 | Business Calendar 外帶開／外送關，todayClosed=false | **PASS** — `#bizCalBanner` 正確顯示「🟡 今日特殊營業／外帶：08:00～23:59」；切到外帶後 `pDate.value` 為今天。 |
| R7-4 | Business Calendar 外帶關／外送開 | **PASS** — 切到外送後 `pDate.value` 為今天，`pTime` 提供實際時段。 |
| R7-5 | today_closed=true 時加入商品（快照 `*_sold_out_reason="today_closed"`）；取消 today_closed（無 Business Calendar，回退每週營業 09:00~21:00，測試時間 21:48 已過關店時間）；重新開購物車 | **PASS** — 重新開啟購物車後，兩個模式的 `sold_out_reason` 都從 `"today_closed"` 正確更新為 `"cutoff_sold_out"`（反映「今日已截止」這個目前真實狀態，不是殘留的舊值），`can_next_day` 為 `true`，因此正確跳到明天（`pDate.value="2026-07-23"`）——這是「用最新狀態正確判斷」的結果，不是沿用舊快照。 |
| R7-6 | 一般每週營業（09:00~23:59），無特殊營業、無臨時休息 | **PASS** — `#bizCalBanner` 隱藏，`#serviceStatusBar` 正常顯示「今日服務／外帶（開放中）・外送（開放中）」；加入購物車、切換外帶/外送、`pDate` 皆維持今天；`persistCart()` 後 `localStorage` 完整保存 `session_id`／`visitor_id`／`cart`／`order_mode`／`customer`／`pickup_date`／`pickup_time`／`payment_method`，與修改前既有行為一致。 |
| R7-7 | 商品卡零改動 | **PASS** — 與 R6 的 diff 只有 6 個 hunk，全部落在 `renderHolidayPreorderBanner()`／`init()` 內的 `bizCalBanner` 區塊／`buildServiceStatusBar()`／新函式 `refreshCartProductsFromLatestMenu()`／`refreshDateSelectorForCart()`／`refreshShopStatus()`，`buildCard()`／`updateProductCard()` 兩個函式簽章完全未出現在 diff 中；HTML 結構 `id` 總數（79 個，含唯一性）與 `<div>`/`</div>` 數量（187/187）與 R6 逐一比對完全相同，證實零 HTML 結構改動。 |
| R7-8 | Business Calendar 後端邏輯零改動 | **PASS** — `routes/line-orders.js`、`routes/business-calendar.js` 與 R6 `diff -rq` 確認 byte-identical，`getDateClosedStatus()`／`getEffectiveModeSchedule()`／`resolveFulfillmentState()`／`GET /timeslots` 本輪一行未動。 |
| R7-9 | Google Maps／外送費／會員資料不受影響 | **PASS** — 實測：填入外送地址「台北市信義區測試路100號」、`deliveryLatLng={lat:25.033,lng:121.5654}`、姓名「王小明」、電話「0912345678」後，分別呼叫 `refreshCartProductsFromLatestMenu()` 與 `refreshShopStatus()`，兩次呼叫前後上述五個欄位逐字元/數值相同，未被清空或覆蓋。 |
| R7-10 | LINE Login／LINE Pay／Analytics／Dashboard／Shipping／`public/line-shipping.html`／`routes/line-shipping.js` 零改動 | **PASS** — 已包含在整個工作目錄 `diff -rq`（排除 `node_modules`／`data`）結果內：只有 `public/line-order.html` 一個檔案不同，上述所有檔案（含 Android 相關項目本就不在此 ZIP 範圍內）逐一確認與 R6 byte-identical。 |

**本輪累計：10/10 PASS，0 FAIL**（含 R7-2 stale→fresh 的真實前後對照證據、Race
Condition 修正前 FAIL → 修正後 PASS 的真實對照證據）。

## 11. Regression

```
node --check server.js                    → OK
node --check routes/*.js                  → OK（全部檔案逐一通過）
node --check utils/*.js                   → OK（全部檔案逐一通過）
node --check public/js/*.js               → OK（全部檔案逐一通過）
node --check scripts/*.js                 → OK（全部檔案逐一通過）
抽取 public/line-order.html 內 2 個 <script> 區塊 → node --check → OK
```

另確認：
- HTML `id` 屬性總數 79 個，逐一比對確認**零重複**；`<div>`/`</div>` 開合數 187/187
  **平衡**，且與 R6 完全相同（證實無新增/刪除任何 DOM 元素）。
- 併發壓力測試（第 9 節）過程中 `window.onerror`／`unhandledrejection`／
  `jsdomError` 監聽器**皆為 0 筆**，無 console error、無 unhandled rejection。
- 購物車數量（`qty`）、`cart_id`／`visitor_id`／`session_id`、`localStorage` 內容
  在所有測試情境（R7-2、R7-5、R7-6、R7-9、併發壓力測試）前後皆保持正確/一致。
- 外送地址／lat-lng 在第 9 節實測中確認未被清空（R7-9）。
- R6 優先序邏輯：`routes/line-orders.js` byte-identical，未回歸。
- R5 `preorderRequiredIds`／`refreshDateSelectorForCart()` 的 Mode-Isolation 判斷式
  （`soldOutReason!=='mode_closed' && soldOutReason!=='product_mode_disabled'`）本輪
  逐字保留，只在其前面新增一行 `await refreshCartProductsFromLatestMenu();`，判斷式
  本身未修改，未回歸。
- R4 Mode Isolation（`applyFulfillmentMode()`／`buildDateSelector()`／
  `buildTimeSelector()`／`restoreModeFormState()`）本輪**完全未觸碰**這幾個函式本身，
  未回歸。
- R3 商品 LINE 特殊營業覆蓋（`_computeProductTimeReason()`）為後端函式，本輪後端
  byte-identical，未回歸。
- 商品卡排版（`buildCard()`／`updateProductCard()`／CSS）零改動（見第 10 節 R7-7）。
- shipping 相關檔案（`routes/line-shipping.js`）byte-identical（見第 10 節 R7-10）。
- 無測試資料／trace log／jsdom 暫存檔殘留：本次測試使用的 `data/pos.db`（含測試用
  Business Calendar 記錄、商品欄位變更、購物車測試資料）與測試用的 jsdom 執行腳本
  （`dom_test.js`／`dom_test2.js`，僅用於本機驗證，非交付內容的一部分）皆只存在於
  本機測試執行環境，**已在打包前手動刪除**，未包含在交付的 ZIP 內；`node_modules/`
  （含測試專用的 `jsdom` 套件）同樣已移除，且 `package.json`／`package-lock.json`
  已確認與 R6 完全一致（`jsdom` 從未進入正式相依套件清單）。交付前已用
  `diff -rq`（排除 `node_modules`、`data`、測試腳本）逐檔案比對整個工作目錄，確認
  除 `public/line-order.html` 外，其餘檔案與 R6 來源完全一致。

## 12. 修改檔案與 diff 統計

**只修改一個檔案**：`public/line-order.html`

```
diff r6/.../public/line-order.html r7/.../public/line-order.html
新增（>）：106 行
刪除（<）：14 行
共 6 個 diff hunk，全部落在：
  - renderHolidayPreorderBanner()（Banner 去重）
  - init() 內 bizCalBanner 區塊（Banner 去重）
  - buildServiceStatusBar()（Banner 去重）
  - refreshCartProductsFromLatestMenu()（新增函式）＋ refreshDateSelectorForCart()（整合呼叫）
  - refreshShopStatus()（整合呼叫 ×2 處，含 API 失敗 warning log）
```

其餘所有檔案（`server.js`、`routes/*.js`、`utils/*.js`、`public/js/*.js`、
`scripts/*.js`、`package.json`、`package-lock.json`、
`public/line-shipping.html`）與 R6 逐位元組相同。

## 13. 商品卡未修改證明

見第 10 節 Case R7-7：與 R6 的 6 個 diff hunk 全部落在 Banner／Cart 同步相關函式，
`buildCard()`／`updateProductCard()` 函式簽章完全未出現在 diff 中；HTML `id` 總數
（79）與 `<div>` 開合數（187/187）與 R6 完全相同，證實商品卡 HTML／CSS／Badge 位置／
商品圖片高度／商品名稱、價格、加號位置皆零改動。

## 14. Business Calendar 未修改證明

`routes/line-orders.js`、`routes/business-calendar.js` 與 R6 `diff -rq` 確認
byte-identical（見第 10 節 Case R7-8）。`getDateClosedStatus()`（Hotfix30-B5-R6 的
今日臨時休息最高優先修正）、`getEffectiveModeSchedule()`、`resolveFulfillmentState()`、
`GET /timeslots` 本輪一行未動，本次「今日臨時休息高於 Business Calendar」的優先序
（R6 已完成）完全未被本輪任何改動觸碰或動搖。

## 15. LINE Login／LINE Pay／Analytics／Dashboard／Shipping 未修改證明

已包含在整個工作目錄的 `diff -rq`（排除 `node_modules`／`data`）結果內：只有
`public/line-order.html` 一個檔案不同，`public/line-shipping.html`／
`routes/line-shipping.js` 以及 LINE Login／LINE Pay／Analytics／Dashboard 相關的
所有既有檔案，逐一確認與 R6 byte-identical。Android 相關項目本就不在此 Web ZIP
的交付範圍內。

## 16. 已知限制

1. `refreshShopStatus()`（60 秒定時輪詢）偵測到「相關旗標改變」時，若購物車 sheet
   當下沒有開啟，只會同步 `cart[id].product` 內部資料，不會主動彈出任何提示告知
   使用者「購物車商品狀態已更新」——使用者下次打開購物車時會看到已經同步好的正確
   資料（`openCartSheet()` 本身會再呼叫一次 `refreshDateSelectorForCart()`），但
   購物車關閉期間本身沒有 UI 提示。此為既有 UX 行為模式（先前所有 `refreshShopStatus()`
   的更新皆是靜默生效，例如 cutoff/enabled 狀態改變），本輪未新增或改變這個既有模式，
   非本次 Root Cause 範圍。
2. `_cartSyncSeq` 是模組層級（整個頁面）共用的單一序號計數器，不分商品、不分呼叫
   來源；在極端情況下（例如同時有兩個完全獨立原因觸發同步）任一較新呼叫都會讓較舊
   呼叫的結果作廢，即使兩者理論上要同步的商品沒有重疊。這是「以呼叫時間全域排序」
   的最小實作，實測（第 9 節）已確認能正確解決需求文件描述的 race condition 情境；
   若未來需要「同商品才互相排斥、不同商品可平行」的更細緻版本，建議另開 Hotfix 評估，
   本輪依「最小修正」原則不做更複雜的按商品 id 分別追蹤。
3. `renderHolidayPreorderBanner()` 現在只服務 `blockType==='today_not_open_preorder'`
   這一種情境；若日後 `evaluateHomepageFulfillmentGate()`（本輪未修改）新增其他
   `blockType`，需要一併確認是否也該併入 `#holidayBanner` 互斥規則或维持獨立顯示，
   本輪未預先擴充處理未知的未來情境。

## 17. 回退方式

本次修改僅涉及 `public/line-order.html` 一個檔案，6 個獨立 diff hunk（見第 12 節）。
回退方式：

1. 整檔還原成 Hotfix30-B5-R6 的 `public/line-order.html` 即可完整回退，不影響其他
   任何檔案或功能（後端與所有其他前端檔案本輪皆未修改）。
2. 若只需回退 Race Condition 保護（`_cartSyncSeq`），可單獨移除該序號檢查與遞增，
   但會重新引入第 9 節描述的 race condition，不建議單獨回退這一小段。
3. 本次未新增資料表欄位、未新增 API 端點、未改變任何後端回傳物件結構，回退不需要
   資料庫遷移或後端配合調整。
