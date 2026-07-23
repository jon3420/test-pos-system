# C5 — 移除舊版全店滿額免運干擾＋修正折抵顯示 Bug

以 `pos-web-fix18-10-hotfix30-C4-cart-live-delivery-refresh-full` 為基礎的增量修正。
只處理兩件事：①舊版全店「滿額免基本外送費」對新距離級距規則的干擾；②滿額進度元件
顯示「折抵 NT$0」但實際折抵 NT$100 的欄位映射 Bug。C3 shared engine 計算公式、C4
即時同步流程、後端送單重算、price_changed、優惠券及訂單資料格式皆未變動。

## 一、根因

### 根因 1：舊全店門檻造成「一秒錯誤畫面」

`utils/deliveryFeeCalc.js` 原本的 `resolvePromotion()` 只看「這一個級距自己」有沒有
設定 `free_mode`／`free_threshold`／`free_discount`，沒有的話就直接 fallback 舊版全店
`delivery_free_threshold`。這對「真正的舊店」（所有級距都還是裸 `{max_km, fee}`）是
對的，但對「已經在用新版每級距促銷設定的店」則會造成問題：只要有一個級距還沒設定
（或商品異動後 pending 期間、地址尚未解析出真實級距前），畫面就會抓到舊全店門檻
（例如 NT$1,000），而不是這個距離真正命中的級距門檻（例如 11.94km 對應 13km 級距，
門檻其實是 NT$1,500）——使用者會先看到「滿 NT$1,000」，等 API 回來後才跳成
「滿 NT$1,500」，形成商品文件描述的「一秒錯誤狀態」。

### 根因 2：`updateDeliveryFreeProgress()` 在 `fixed` 模式「已達標」時仍誤用設定值當 rawFee

`public/line-order.html` 的 `updateDeliveryFreeProgress()` 組裝要傳給 shared engine
（`getDeliveryFreeProgressState()`）的參數時，原本寫的是：

```js
rawDeliveryFee = fr.mode === 'fixed' ? fr.fixedDiscountValue : fr.rawFee;
```

這行的原始用意是給「**尚未達標**」時的預覽文案用（`滿 NT$1,500 折抵 NT$100 外送費`，
此時 shared engine 確實需要拿到「設定的折抵值」而不是原始外送費，才能顯示這句預覽）。
但這個判斷式沒有排除「**已經達標**」的情況——已達標時 `getDeliveryFreeProgressState()`
是用 `savedAmount = rawFee - finalFee` 算出實際折抵金額，這時候如果 `rawDeliveryFee`
仍然被换成「設定的折抵值」（100）而不是真正的原始外送費（210），就會算成
`100 - 110`，被防負數保護 clamp 成 `0`——這正是「rawFee=210、finalFee=110，畫面卻顯示
本次折抵 NT$0」的真正根因，且是**新增的 C5 專屬 smoke test（見下方 C5-4／C5-8）在本輪
實際跑出來抓到的**，不是憑空猜測的假設性 Bug。

## 二、修改／新增檔案

實際比對乾淨 C3 原始 zip，全部異動檔案：

- `utils/deliveryFeeCalc.js`（新增 `hasTierPromotionConfiguration()`／`isTierPromotionMode`／
  `normalizeDeliveryDistanceFeeRules()` 正規化調整）
- `routes/line-orders.js`（`GET /shop` 額外回傳 `delivery_distance_fee_rules`）
- `public/line-order.html`（`deriveDeliveryDiscount()`／`_lastResolvedDeliveryTier`／
  `hasTierPromotionConfigurationClient()`／pending 畫面／**根因 2 的關鍵一行修正**）
- `public/index.html`（移除「滿額免基本外送費」輸入欄位）
- `public/js/app.js`（不再讀寫 `delivery_free_threshold`；移除 legacy 下拉選項）
- `scripts/smoke-delivery-distance-promotion.js`（更新 2 筆過時斷言＋新增 6 組 C5 測試）
- `scripts/smoke-cart-delivery-live-refresh.js`（新增 8 組 C5 pending／tier 測試）
- 本檔案（新增）

## 三、新版 tier promotion mode 判斷

`hasTierPromotionConfiguration(rules)`（後端 `utils/deliveryFeeCalc.js`）與
`hasTierPromotionConfigurationClient(rules)`（前端 `public/line-order.html`，邏輯逐字
一致）：只要 `distanceRules` 中「任一筆」存在 `free_mode`／`free_threshold`／
`free_discount` 屬性（用 `hasOwnProperty` 判斷，即使值是空字串也算數），就代表這個
店家已經啟用新版「每級距自己的促銷設定」模式。

## 四、legacy fallback 條件

`resolvePromotion(rule, legacySettings, isTierPromotionMode)`：

- 這個級距自己有完整促銷設定（`ruleHasOwnPromotion()` 為真）→ 一律用自己的設定
  （`source:'rule'`），不管店家是不是 tier mode。
- 沒有自己的設定，但 `isTierPromotionMode` 為真（店家已用新模式）→ 視為
  `free_mode:'none'`（`source:'none'`），**禁止 fallback** 舊全店門檻。
- 沒有自己的設定，且 `isTierPromotionMode` 為假（真正舊店，所有級距都還是裸
  `{max_km, fee}`）→ fallback 舊版全店 `delivery_free_enabled`／`delivery_free_threshold`／
  `delivery_free_mode`／`delivery_basic_fee`（`source:'legacy'`，行為與 C3 完全相同）。

`normalizeDeliveryDistanceFeeRules()`（後台儲存驗證）不再保留「純 `{max_km, fee}`」
的 legacy 空欄位寫法——未設定過優惠模式的列，儲存時一律正規化成明確的
`free_mode:'none', free_threshold:0, free_discount:0`。這代表**只要店家按過一次
「儲存外送費設定」，這個店就會變成 tier mode**，之後永久禁止 legacy fallback；只有
「從未在新版後台儲存過」的店（DB 裡仍是舊版 seed 值或舊版程式寫入的裸規則）才會
繼續套用 legacy fallback。DB 舊欄位（`delivery_free_threshold` 等）完全沒有刪除、
沒有做任何破壞性 migration。

## 五、後台移除項目

- `public/index.html`：移除「滿額免基本外送費 (NT$)」數字輸入框
  （`id="set-delivery_free_threshold"`）。
- `public/js/app.js`：`loadDeliveryFeeTab()` 不再載入這個值；`saveDeliveryFeeSettings()`
  不再送出 `delivery_free_threshold`（未送出的 key，後端 `PUT /api/settings` 既有規則
  是完全不動，不會清空店家原本的舊值）。
- `public/js/app.js` 距離級距逐列下拉選單：移除 `'legacy'`／「沿用全店設定」選項，
  只保留 `none`（不優惠）／`full`（滿額全免）／`fixed`（滿額固定折抵）三種。載入
  尚未設定過的舊裸規則時，畫面上先顯示「不優惠」，但在使用者互動或按下「儲存」之前
  不會回頭改寫 DB；第一次儲存後才會正規化寫入明確的 `free_mode:'none'`。
- **保留不動**：`delivery_free_enabled`／`delivery_free_mode`／`delivery_free_distance_km`
  這三個欄位在後台原本就沒有對應的輸入框（純粹是 DB 欄位／API 回傳的相容欄位），
  這次沒有新增也沒有移除任何東西；`delivery_basic_fee`（「基本外送費」欄位）逐項確認
  後保留——它在 `routes/delivery.js` 裡除了作為 legacy fallback 的固定折抵值來源之外，
  **仍是「未啟用距離計費」（`delivery_distance_fee_enabled=false`）時唯一的外送費來源**，
  是現行仍在使用的欄位，不屬於本次移除範圍。
- **保留不動**：`public/js/app.js` 的 `_deliveryFeeMetaModeLabel()`——這是「歷史訂單
  詳情頁」顯示過去訂單當時用哪種優惠模式算出來的中文標籤（`legacy → 沿用全店設定`），
  資料來源是已經下單成立的訂單的 `delivery_fee_meta.free_rule_type`，不是後台可編輯
  的設定介面，過去確實可能有訂單是用 legacy fallback 算出來的，這個標籤必須保留，
  否則歷史訂單詳情頁會顯示錯誤或報錯。

## 六、pending 不閃舊門檻的資料流

新增 `_lastResolvedDeliveryTier`（記住「這次瀏覽階段最近一次成功解析」的距離級距
門檻／優惠模式／設定折抵值），配合 `GET /api/line-shop` 新增回傳的
`delivery_distance_fee_rules`（供前端判斷店家是否為 tier mode），
`updateDeliveryFreeProgress()` 的 fallback 順序改為：

```
1. 有最新 API 結果（_deliveryFeeResult 有效）→ 直接用，畫面即為最終狀態
2. 沒有最新結果，但有 _lastResolvedDeliveryTier（這次瀏覽已經解析過至少一次）
   → renderDeliveryFreePendingWithTier()：沿用「最近一次真實命中」的門檻/模式/
     折抵設定值，percent/remaining 用最新 subtotal 重算，但強制不宣告已達標、
     不顯示「已折抵/已省下」，文案為「正在依最新購物車重新計算外送優惠…」
3. 沒有 _lastResolvedDeliveryTier，且店家已是 tier mode（hasTierPromotionConfigurationClient()
   為真）→ renderDeliveryFreeWaitingForAddress()：顯示「正在依地址計算滿額外送優惠…」，
   不顯示任何門檻數字、不宣告已達標/100%
4. 都不是（真正舊店，從未設定過任何新版促銷）→ 沿用既有 legacy fallback（顯示
   shopData.delivery_free_threshold 的大概門檻，feeResolved 強制 false）
```

`_lastResolvedDeliveryTier` 的清除時機（cart mutation 保留，address/mode mutation 清除）：

| 情境 | 是否清除 `_lastResolvedDeliveryTier` |
|---|---|
| 商品加減／推薦加購（`addCart`/`chgQty`/`removeCartItem`/`scheduleDeliveryFeeRefresh`/`setDeliveryFeePending`） | **否**（靜態驗證：這幾個函式完全不觸碰這個變數） |
| 手動輸入地址（`input` 事件） | 是 |
| Autocomplete 選到沒有座標的地點 | 是 |
| `fetchDeliveryFee()` 失敗／網路錯誤（`catch`） | 是 |
| `resetDeliveryFee()`（超距離、Maps 失敗、訂單成立後重置…所有既有呼叫點） | 是 |
| 切換到外帶模式（`applyFulfillmentMode()`） | 是 |
| 清空購物車（`clearCartByUser()`） | 是 |

## 七、折抵 NT$0 修正

1. **根因 2 的關鍵修正**（見一）：`updateDeliveryFreeProgress()` 內
   `rawDeliveryFee = (fr.mode === 'fixed' && !fr.reached) ? fr.fixedDiscountValue : fr.rawFee;`
   ——只有「尚未達標」的預覽文案才用設定的折抵值代替，已達標一律用真正的 rawFee。
2. **折抵欄位安全推導**（防呆，需求文件七）：`deriveDeliveryDiscount(rawFee, finalFee,
   explicitDiscount)`——後端有明確回傳 `delivery_discount` 時優先採用（並 clamp 在
   `[0, rawFee]` 之間）；後端漏回傳時，改由 `rawFee - finalFee` 差額安全推導，不會
   讓「缺欄位」被誤判成「明確的 0」。已接入 `fetchDeliveryFee()` 與 `submitOrder()`
   的 `price_changed` 分支，兩個寫入 `_deliveryFeeResult.discount` 的地方都經過這個
   統一 helper，不再各自重複一次 `Number(x||0)` 這種會混淆「缺欄位」與「明確 0」的寫法。
3. **欄位命名釐清**（需求文件八，repo-wide grep 逐項確認見下）：API response 用
   `delivery_discount`；前端統一物件用 `_deliveryFeeResult.discount`；進度 pure
   function input 用 `rawDeliveryFee`/`finalDeliveryFee`（本身沒有名為
   `deliveryDiscount` 的參數，`savedAmount` 是引擎內部用差額算出來的，不是外部傳入）；
   規則本身的固定折抵設定用 `free_discount`/`free_discount_value`。沒有發現任何地方
   把「規則設定值」與「本次實際折抵」誤用成同一個欄位。

## 八、測試

```
$ node -c utils/deliveryFeeCalc.js && echo OK          # OK
$ node -c routes/delivery.js && echo OK                # OK
$ node -c routes/line-orders.js && echo OK             # OK
$ node -c routes/settings.js && echo OK                # OK
$ node -c public/js/delivery-free-progress.js && echo OK  # OK
$ node -c public/js/app.js && echo OK                  # OK

$ node scripts/smoke-delivery-distance-promotion.js
[smoke-delivery-distance-promotion] 98 passed, 0 failed   (exit 0)

$ node scripts/smoke-delivery-free-progress.js
[smoke-delivery-free-progress] 18 passed, 0 failed        (exit 0)

$ node scripts/smoke-cart-delivery-live-refresh.js
═══ 總結：89 PASS / 0 FAIL / 4 MANUAL REQUIRED ═══        (exit 0)
```

`public/line-order.html` 抽出的 6 個 `<script>` 區塊（2 個有內容，4 個空白/外部
script）、`public/index.html` 抽出的 6 個 `<script>` 區塊（全部是外部 `src` 載入，
無內嵌內容）皆通過 `node -c`。

repo 內確認**不存在** `npm test`、`scripts/regression-all.js`、`scripts/smoke-all.js`
（如實回報，未執行）。

`scripts/smoke-cart-delivery-live-refresh.js` 與 `scripts/smoke-delivery-distance-promotion.js`
新增的 C5 測試全部直接 `require()` 正式模組（`utils/deliveryFeeCalc.js`、
`public/js/delivery-free-progress.js`）或從 `public/line-order.html` 原始檔抽取真實
函式原始碼在 `vm` sandbox 執行，抽取失敗時 `extractBlock()`/`throw new Error` 會讓
整個測試腳本直接中止（不是靜默跳過），確保測試驗證的是「這次真的改出來的程式碼」。

新增測試涵蓋（案例編號對應需求文件一）：
1. Pending 使用最近命中級距（threshold=1500，subtotal=1050 → 70%/remaining 450，
   不得出現 1,000、不得宣告已達標）
2. 新版 tier mode 但尚未解析過任何地址 → 顯示等待地址，不 fallback 1000
3. 真正 legacy 店（全部裸規則）→ 允許 fallback 1000
4. 折抵顯示使用明確 discount（raw=210/discount=100/final=110 → savedAmount=100）
5. `deriveDeliveryDiscount()` 折抵欄位缺失時安全推導（raw=210/final=110/discount
   缺失 → savedAmount=100）
6. 地址改變／Autocomplete 失效／API 失敗／切外帶 → 靜態驗證程式碼片段確實清除
   `_lastResolvedDeliveryTier`
7. 商品加減／`scheduleDeliveryFeeRefresh`／`setDeliveryFeePending` → 靜態+動態驗證
   完全不觸碰 `_lastResolvedDeliveryTier`
8. C5 原始畫面案例：11.94km 命中 13km 級距，subtotal 1050（未達標，threshold 顯示
   1,500）與 1500（達標，discount=100/finalFee=110，savedAmount 畫面顯示 100）
   全程使用真實 shared engine 計算結果 + 真實前端 render 函式驗證

## 九、Repo-wide grep 結果重點

- `delivery_free_threshold`：只出現在（a）後端 `getSetting`/`getSettingVal` 讀取
  （shared engine 真正舊店 fallback／`GET /shop`、`GET /line-orders` 公開舊值供舊店
  相容）、（b）`routes/settings.js` 允許清單（DB 欄位仍可被外部/API 寫入，只是這次
  的後台表單不再送出）、（c）`utils/db.js` seed 預設值、（d）測試與註解說明。**沒有**
  出現在 `public/index.html` 的可見 UI 標籤或 input id 中。
- `free_mode.*legacy`／`沿用全店設定`：只出現在註解（說明「不再允許」）與
  `_deliveryFeeMetaModeLabel()`（歷史訂單顯示，保留）。**沒有**出現在可互動的後台
  下拉選單選項中。
- `_lastResolvedDeliveryTier`／`deriveDeliveryDiscount`：只出現在
  `public/line-order.html` 實際定義／呼叫處與對應測試檔案，沒有散落第二套實作。
- `deliveryDiscount`／`delivery_discount`：角色分工清楚（見七之 3），沒有混用。

## 十、尚需部署驗證

- LINE iOS 內建瀏覽器上，11.94km／小計 1,050 情境的「一秒閃動」是否真的完全消失
  （沙盒只能驗證程式邏輯與 DOM 文字，無法驗證真實瀏覽器渲染時序）
- 真實地址切換（Google Places Autocomplete／GPS）與 `_lastResolvedDeliveryTier`
  清除時機的實際手感
- 正式環境 API 延遲下，pending 文案與最終文案切換的視覺體驗
- 實際送出訂單（含 LINE Pay 導轉）流程
- 後台實際儲存一組新版距離級距規則，確認儲存後前台立即禁止 legacy fallback
  （沙盒測試已驗證 `normalizeDeliveryDistanceFeeRules()` 的正規化邏輯本身，但完整的
  「後台按下儲存 → 前台下一次讀取」流程建議實機再跑一次）
