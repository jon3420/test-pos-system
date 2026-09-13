# H1.4.11.4.1｜LINE 點餐雙模式共同隱藏「外帶／外送皆停用」商品

直接基底：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11.4-LINE-ORDER-PRODUCT-MODE-VISIBILITY-FILTER-full.zip`
（H1.4.11.4，SHA-256: `c8f4a5df8146e74a61d436dfcfc2401193493ab44d60fc3b073faeaba6b507ba`，已核對）。
全程未回退重做、未切換基底、未沿用其他未確認的工作目錄。

## 一、Reality Audit

1. `public/line-order.html` 的 `getVisibleProductsForCurrentPage()`（修改前）在
   `getLineOrderPageMode()!=='fulfillment_switcher'` 分支直接 `return allProducts`，
   完全沒有排除 `line_takeout_enabled=0` 且 `line_delivery_enabled=0` 的商品——確認
   為根因。`buildCats()`／`renderMenu()` 都共用這個函式，因此合併點餐模式下這類商品
   會連同分類一起被誤判為「有效可見」。
2. `addCart()`（修改前）在 `combined_checkout` 模式下完全沒有永久支援欄位檢查——
   它只用 `getProductAvailableModes(p)`／`_productModeStatus(p, mode)` 判斷「今天能不
   能買」，而 `_productModeStatus()` 只讀 `takeout_sold_out_reason`／
   `delivery_sold_out_reason`／`sale_status`／`line_sold_out` 等暫時狀態欄位，**從未**
   直接讀取 `line_takeout_enabled`／`line_delivery_enabled`。也就是說，只要商品的暫時
   狀態欄位沒有連動寫成售完（例如舊資料、匯入資料、手動改資料庫），合併模式下
   `addCart()` 對「皆停用」商品完全不會擋。這是比 `getVisibleProductsForCurrentPage()`
   更嚴重的繞過缺口，需求文件第六節的「防止舊 DOM 或直接呼叫繞過」在本輪之前對
   合併模式其實是不存在的。
3. `openProductDetail()`（修改前）與 `addCart()` 情況相同：`fulfillment_switcher` 模式
   有 `isProductSupportedForFulfillmentMode(p, currentMode)` 檔在最前面，但
   `combined_checkout` 模式完全沒有等價檢查。
4. H1.4.11.4 的既有測試 `scripts/smoke-h1-4-11-4-product-mode-visibility.js` 第 1 項，
   把 `combined_checkout` 模式的 `getVisibleProductsForCurrentPage()` 預期為「回傳全部
   商品，包含 ID 4（兩者皆停用商品）」——這項預期與同一份 H1.4.11.4 changelog
   （`CHANGELOG_H1_4_11_4_PRODUCT_MODE_VISIBILITY_FILTER.md`）自己寫的真值表互相矛盾：
   該 changelog 明確寫著「外帶、外送皆停用 → 隱藏」，但測試斷言卻要求合併模式顯示
   皆停用商品。確認為程式／測試／文件三者不一致，不是本輪新引入的需求變更。
5. 後台商品設定（`routes/products.js` `PATCH /:id/line-settings`，第 428～434 行）
   已有「至少必須啟用一種模式」的驗證，本輪完全未修改，用真實 PATCH 請求驗證仍
   生效（見下方測試 37）。
6. 歷史資料／匯入資料／多分頁編輯／API 或快取競態，確實仍可能在資料庫中產生
   `line_takeout_enabled=0` 且 `line_delivery_enabled=0` 的商品（後台驗證只防守「新
   存檔」路徑，不會回頭清理既有異常資料），因此前台仍需要防禦性過濾與防繞過檢查。
7. 後端 `GET /validate-cart`（`routes/line-orders.js` 第 1287～1291 行）與正式送單端點
   （同檔第 1460～1468 行）已經會用 `product_mode_not_supported` 擋下不支援該訂單方式
   的商品，本輪完全未修改，用真實 HTTP + DB fixture 驗證仍生效（見下方測試 31～33）。
8. 商品可見性判斷（`isProductSupportedForFulfillmentMode()`）只讀取
   `line_takeout_enabled`／`line_delivery_enabled`，欄位缺失時透過既有
   `toBooleanFlag(raw, true)` 相容預設值視為啟用，未混入 `sold_out_reason`／
   `today_open`／`cutoff_passed`／`allow_next_day`／`pre_sale_available` 等任何暫時
   狀態欄位——本輪延續 H1.4.11.4 的這個設計，未新增第二套判斷。

## 二、H1.4.11.4 程式／測試／文件不一致的證據

| 項目 | H1.4.11.4 changelog 真值表 | H1.4.11.4 實際程式 | H1.4.11.4 既有測試斷言 |
| --- | --- | --- | --- |
| 外帶、外送皆停用商品在合併模式 | 隱藏 | 顯示（`return allProducts` 未過濾） | 預期顯示（`visibleIds` 應包含 ID 4） |

三者互相矛盾，其中「實際程式」與「既有測試斷言」彼此一致（測試precisely驗證了有
問題的程式行為），但都與 changelog 寫的真值表不符。本輪依 H1.4.11.4.1 需求文件三的
最終真值表為準，修正程式行為並同步修正這一項過期測試預期（詳見五）。

## 三、修改前後差異

### `public/line-order.html`

1. 新增 `isProductSupportedForAnyFulfillmentMode(product)`：重用既有
   `isProductSupportedForFulfillmentMode()`，回傳「至少支援一種取餐方式」的布林值。
   `renderMenu()`／`buildCats()`／`addCart()`／`openProductDetail()` 全部共用這一份，
   沒有各自重寫一套布林判斷。
2. `getVisibleProductsForCurrentPage()`：改為先用
   `isProductSupportedForAnyFulfillmentMode` 過濾出 `supportedProducts`（排除皆停用
   商品），再依頁面模式決定：
   - `combined_checkout` → 直接回傳 `supportedProducts`（任一模式可買即顯示，僅外帶
     ／僅外送徽章邏輯不變）。
   - `fulfillment_switcher` → 在 `supportedProducts` 基礎上，再依 `currentMode` 過濾。
3. `buildCats()`：分類存在性判斷（`catIdsWithProducts`）與 `currentCat` 自動重設為
   `all` 的邏輯，從「只在 `fulfillment_switcher` 模式生效」改成「兩種頁面模式都生
   效」——因為 `getVisibleProductsForCurrentPage()` 現在已經正確處理好兩種模式各自
   該過濾的內容，`buildCats()` 不需要再用 `if(pageMode==='fulfillment_switcher')` 額
   外分支。
4. `renderMenu()`：空狀態文案分兩種——`fulfillment_switcher` 模式維持原本的「目前
   沒有提供外送到府／外帶自取的商品」；`combined_checkout` 模式新增「目前沒有可供
   LINE 點餐的商品」（全店商品都是皆停用時顯示，不是系統錯誤／今日售完／今日公休）。
5. `openProductDetail()`／`addCart()`：在既有 `fulfillment_switcher` 檢查之前，新增
   `isProductSupportedForAnyFulfillmentMode(p)` 檢查——皆停用商品一律用 Toast
   `此商品目前未提供外帶或外送` 擋下（不開啟 Modal、不觸發 `view_item`、不加入購物
   車、不觸發 `add_to_cart`、不使用 `alert()`、不自動切換取餐方式）；僅外帶／僅外送
   商品在 `fulfillment_switcher` 模式下的既有 Toast（`此商品僅提供外帶`／`此商品僅
   提供外送`）維持不變，不會被皆停用文案覆蓋。

### 後端

未修改。Reality Audit 確認 `/validate-cart` 與正式送單端點的
`product_mode_not_supported` 驗證邏輯與後台儲存驗證都已存在且正確，本輪未發現真正
的後端缺口，依需求文件第十四節規定不重寫。

## 四、最終商品顯示真值表

| 商品設定 | 合併點餐模式 | 切換模式－外帶 | 切換模式－外送 |
| --- | ---: | ---: | ---: |
| 外帶、外送皆啟用 | 顯示 | 顯示 | 顯示 |
| 僅外帶啟用 | 顯示「僅外帶」 | 顯示 | 隱藏 |
| 僅外送啟用 | 顯示「僅外送」 | 隱藏 | 顯示 |
| 外帶、外送皆停用 | **隱藏** | **隱藏** | **隱藏** |

欄位缺失時繼續沿用 `toBooleanFlag(raw, true)` 相容規則，不會把舊商品誤判為皆停用。

## 五、修正 H1.4.11.4 舊測試中的過期預期

`scripts/smoke-h1-4-11-4-product-mode-visibility.js` 第 1 項原本斷言
`combined_checkout` 模式的 `getVisibleProductsForCurrentPage()` 回傳全部商品（含 ID 4
「皆停用商品」）。這不是為了迎合 production 而放寬測試強度，而是修正一項本身就與
同一份 H1.4.11.4 changelog 真值表矛盾的過期預期（見二）。修改後：

- 預期值改為 `PRODUCTS_FIXTURE` 扣除 ID 4（即 1,2,3,5,6,7,8,9,10,11）。
- 新增一條斷言明確驗證 ID 4 不在回傳清單中。
- 只修改這一項，未刪除或弱化其餘任何斷言。

修改後該測試結果：**75 PASS / 0 FAIL**（原始 74 項 + 本次新增 1 項細分斷言）。

## 六、商品與分類過濾流程

1. `getVisibleProductsForCurrentPage()` 全域先排除皆停用商品，再依頁面模式細分。
2. `buildCats()` 用同一份可見商品集合計算 `catIdsWithProducts`，兩種頁面模式都適用；
   若某分類過濾後完全沒有可見商品，該分類按鈕不會出現，「全部」固定保留。
3. 若目前 `currentCat` 因過濾後已不存在，自動重設為 `all`，不會留下永遠空白的分類。
4. 若全店商品都是皆停用，`renderMenu()` 在 `combined_checkout` 模式顯示「目前沒有
   可供 LINE 點餐的商品」；`fulfillment_switcher` 模式維持原本的模式專屬空狀態文案。

## 七、防繞過及購物車處理

- `openProductDetail(id)`／`addCart(id)` 直接呼叫（模擬舊 DOM、console、生命週期競態）
  時，皆停用商品一律被擋下並顯示 Toast，不開啟 Modal、不加入購物車、不修改既有
  數量、不自動切換取餐方式、不使用 `alert()`。
- 既有「僅外帶／僅外送」在 `fulfillment_switcher` 模式的防繞過提示維持不變，不會被
  本輪新增的皆停用文案覆蓋（已用真實測試驗證兩種文案不會混淆，見測試 27c）。
- 購物車內既有的皆停用商品（例如加入購物車後才被後台改成皆停用）不會被
  `renderMenu()` 靜默清空，`cart` 物件本身不受商品列表過濾影響；結帳前仍由後端
  `/validate-cart` 與送單端點的既有驗證擋下。

## 八、Analytics 驗證

- 皆停用商品因不會被 `buildCard()` 渲染，DOM 中不存在對應 `#pc-{id}` 元素，因此
  `_setupViewProductObserver()` 掃描不到、不會註冊 `IntersectionObserver`，也就不會
  觸發 `view_product`。
- 直接呼叫 `openProductDetail()` 被擋下時，不會呼叫 `_trackViewItem()`，因此不觸發
  `view_item`。
- 直接呼叫 `addCart()` 被擋下時，不會呼叫 `_trackAddToCart()`，因此不觸發
  `add_to_cart`。
- 僅外帶／僅外送商品在合法模式下的既有 Analytics 行為未受影響。

## 九、測試日期相依問題與修正

本輪續作額外處理兩個「舊測試本身具有日期相依問題」的缺陷（僅修正測試 fixture／日
期 helper，未修改任何 production 營業時間或 next-service 邏輯）：

### 1. `scripts/smoke-h1-4-11-1-fixes.js`「二-4」

- **問題**：舊測試用 `nextSvcDelivery.date !== nextSvc.date` 判定外帶／外送是否分開
  計算 next service，這是一個錯誤假設——兩種模式即使各自使用完全不同的班表，也可
  能合法地落在同一個下一營業日（例如外帶下一個週一，恰好也是外送下一個有營業的
  日子）。日期相同不代表兩者共用了錯誤邏輯；真正能證明兩者獨立運作的證據，是各自
  的開始時間是否正確反映各自班表。
- **重現結果**：`takeout_next_service={date:"2026-09-14", start_time:"16:00"}`、
  `delivery_next_service={date:"2026-09-14", start_time:"09:00"}`——日期相同、開始
  時間不同，已足以證明兩者各自使用自己的設定，不是同一份資料的兩個視圖。
- **修正**：改為驗證 (1) `takeout_next_service` 與 `delivery_next_service` 都存在；
  (2) 外帶開始時間為真實設定的 `16:00`；(3) 外送開始時間為真實設定的 `09:00`；
  (4) 外送沒有錯誤繼承外帶的 `16:00`；不再要求兩者日期必須不同。測試名稱與註解改為
  「外帶／外送的 next service 分開使用各自班表與開始時間」。
- **結果**：修正後該測試在預設時區、`UTC`、`Asia/Taipei`、`Asia/Tokyo` 全部一致回到
  **80 PASS / 0 FAIL**。

### 2. `scripts/smoke-h1-4-11-line-order-page-mode.js` 的 `_futureDateStr()`

- **問題**：測試 helper `_futureDateStr(daysAhead)` 用 `new Date(); d.setDate(...)`
  依賴 host local timezone 計算「N 天後」；但 production 的 `_ffDayLabel()`
  （`public/line-order.html`）是以 `parseLocalDate(fmtD(twNow()))`——也就是
  `Asia/Taipei` 當地日期——作為「今天」基準。當測試主機仍是 UTC 的前一天、但台北時
  間已經跨到下一天時，測試 helper 算出的「兩天後」在 production 眼中會變成「明日」
  （只差一天），導致 D2c 誤判「detail 文字固定寫死明日」。
- **修正**：新增 `taipeiTodayStr()`（用 `Intl.DateTimeFormat` 明確指定
  `timeZone:'Asia/Taipei'` 取得當地日期字串，不依賴 host 時區）與
  `addDaysToDateStr()`（用 `Date.UTC()` 做純 UTC 曆法加減，避開任何 local timezone 的
  DST／日界線問題），`_futureDateStr()` 改為呼叫 `addDaysToDateStr(taipeiTodayStr(),
  daysAhead)`，與 production 認定的「今天」完全一致。**未修改** production 的
  `_ffDayLabel()` 或任何營業時間邏輯。
- **結果**：修正後 D2c 在預設時區、`UTC`、`Asia/Taipei`、`Asia/Tokyo` 全部正確顯示
  非「明日」的真實星期標籤，整份測試回到 **66 PASS / 0 FAIL**。

兩項問題都已證實存在於未修改的 H1.4.11.4 基準版本（`/home/claude/work/baseline/base`
比對結果相同），本次修正僅調整測試 fixture／日期計算 helper，沒有修改任何
production 營業時間或 next-service 計算邏輯。

## 十、實際測試命令與通過數

### 本次新增／主要功能測試

```
node scripts/smoke-h1-4-11-4-1-both-disabled-product-filter.js   → 60 PASS / 0 FAIL
node scripts/smoke-h1-4-11-4-product-mode-visibility.js          → 75 PASS / 0 FAIL
```

### 四時區回歸矩陣（含本輪修正的兩支測試）

| 測試 | 預設時區 | UTC | Asia/Taipei | Asia/Tokyo |
| --- | ---: | ---: | ---: | ---: |
| `smoke-h1-4-11-2-fixes.js` | 84/0 | 84/0 | 84/0 | 84/0 |
| `smoke-h1-4-11-1-fixes.js` | 80/0 | 80/0 | 80/0 | 80/0 |
| `smoke-h1-4-11-line-order-page-mode.js` | 66/0 | 66/0 | 66/0 | 66/0 |

### 12 支核心回歸（全部 exit code 0）

```
node scripts/run-h1-4-9-checkout-order-summary-runtime.js              → 67 PASS / 0 FAIL
node scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js     → 111 PASS / 0 FAIL
node scripts/run-h1-4-10-phase1-liff-identity-runtime.js               → 68 PASS / 0 FAIL
node scripts/run-h1-4-10-required-friend-gate-runtime.js               → 98 PASS / 0 FAIL
node scripts/run-h1-4-10-asset-cache-bust-runtime.js                   → 30 PASS / 0 FAIL
node scripts/run-h1-4-10-historical-backend-reconcile-runtime.js       → 35 PASS / 0 FAIL
node scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js         → 113 PASS / 0 FAIL
node scripts/run-h1-4-10-friend-live-runtime.js                        → 24 PASS / 0 FAIL
node scripts/run-h1-4-10-friend-sec-mig-runtime.js                     → 25 PASS / 0 FAIL
node scripts/run-h1-4-8-checkout-backend-unification-runtime.js        → 64 PASS / 0 FAIL
node scripts/smoke-delivery-distance-promotion.js                      → 98 PASS / 0 FAIL
node scripts/smoke-delivery-free-progress.js                           → 18 PASS / 0 FAIL
```

## 十一、基準既有失敗比對

| 測試 | 未修改基準版 | 本次修改版 | 結論 |
| --- | --- | --- | --- |
| `smoke-hotfix26-f2.js` | Total 28, PASS 22, FAIL 3 | Total 28, PASS 22, FAIL 3（同 3 項失敗名稱） | 一致，未修改 |
| `smoke-hotfix26-f7.js` | Total 47, PASS 46, FAIL 1 | Total 47, PASS 46, FAIL 1（同 1 項失敗名稱） | 一致，未修改 |
| `smoke-cart-delivery-live-refresh.js` | exit=1（module 載入錯誤，環境既有問題） | exit=1（相同錯誤） | 一致，未修改 |

這三支是保留未修正的基準既有失敗（依需求文件規定不得修改這三支測試或修改
production 邏輯迎合過期靜態斷言）。**與九節修正的兩項日期相依測試缺陷是不同性質
的問題**：九節的兩項屬於「測試本身寫錯判斷條件／依賴 host 時區」，本次已修正；
本節三項屬於「測試斷言指向尚未實作或已知環境限制的功能」，本次維持原樣未修改。

## 十二、資產版本及打包資訊

- `build_version` 更新為 `'H1.4.11.4.1'`（`routes/line-orders.js`）。
- `public/index.html` 的 `/js/app.js?v=h1-4-11-4` 更新為
  `/js/app.js?v=h1-4-11-4-1`；已全文搜尋確認無殘留 `?v=h1-4-11-4` 或同一資產混用不同
  版本 query 的情況。
- 沿用既有 HTML no-cache 與資產快取機制，未全面停用快取，未修改其他快取規則。
- ZIP 名稱：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11.4.1-LINE-ORDER-BOTH-DISABLED-PRODUCT-FILTER-FIX-full.zip`
  （大小與 SHA-256 見完成報告）。

## 十三、已知限制

- `smoke-hotfix26-f2.js`／`smoke-hotfix26-f7.js`／`smoke-cart-delivery-live-refresh.js`
  的既有基準失敗（見十一）依需求文件規定保留未修正，與本輪功能無關。
- 本輪只處理前端可見性過濾與防繞過、以及兩項測試本身的日期相依缺陷；未新增資料庫
  migration、未修改後端商品驗證邏輯、未修改營業時間／預訂／Business Calendar 相關
  邏輯，也未拆分商品頁或菜單、未改寫價格／分類／份數／庫存／外送費／地址／地圖／
  免運／`checkout_click`／LINE 登入／Friend Required Gate／購物車找回／n8n Secret／
  會員 reconcile／`line_order_page_mode` enum 等明確禁止修改的範圍。
