# CHANGELOG — HOTFIX30-C2：外送滿額免運進度提示

以 HOTFIX30-C1 為基礎的增量修改。本次只新增／調整 LINE 點餐購物車的「滿額免運進度提示」
UI 與其計算邏輯，**不改變**既有外送距離計算、外送費級距、優惠券、付款方式、購物車、
下單 API 或 Android App。

## 一、功能

### 1. 外送購物車滿額進度
- 只在顧客目前選擇「外送」（`currentMode==='delivery'`）時顯示。
- 元件位置：外送地址／地址備註 → 外送距離與外送費 → **滿額免運進度提示** → 付款方式 → 備註 → 確認送出訂單。
- 未啟用（`delivery_free_enabled` 明確為 `'0'`）或門檻無效（`delivery_free_threshold<=0`）時，整個元件 `hidden`，完全不顯示。

### 2. 尚差金額 / 未達門檻
- 顯示「滿 NT$X 享免運／再消費 NT$Y 即可免運」與進度條（0–100%，四捨五入整數）。

### 3. 接近門檻提示
- 進度 ≥ 80% 且尚未達標時，文案改為「🔥 就差一點！再消費 NT$Y 即可免運」。

### 4. 達標折抵顯示
- **full**（外送費完全折抵為 0）：「🎉 已達免運資格／本次已折抵 NT$X 外送費」。
- **distance_only / 部分折抵**（達門檻但外送費仍 >0，例如只折抵基本費、超距離費仍需支付）：
  「🎉 已達滿額外送優惠／本次已折抵 NT$X 外送費／仍需支付 NT$Y 超距離費」，**不使用「免運」字樣**，避免誤導。
- 原始外送費本來就是 0 時：「🎉 已達滿額外送優惠」，不顯示「已折抵 NT$0」。
- 金額已達門檻但外送費尚未計算出來（地址尚未確認）：「🎁 已達滿額門檻／外送費將於確認地址後計算折抵」——**不會**提前宣告「已達免運資格」，因為那時後端尚未真正計算折抵結果。

### 5. 超距離優先警告
- 地址超過 `delivery_max_distance_km` 時，進度元件顯示「⚠️ 超出配送範圍／滿額優惠不適用於超出配送範圍的地址」，
  **不顯示**任何「已達免運」等成功狀態、`reached` 一律為 `false`，避免讓人誤以為滿額可以解除距離限制。
- 送出按鈕仍由既有 `deliveryFeeCalculated` 旗標與後端 `recalcDeliveryFee()` 阻擋（本次未變更）。

### 6. 湊免運推薦（最多 3 項）
- 只在「未達門檻、非超距離、外送模式」時顯示。
- 篩選：LINE 已上架（`show_on_line`）、`sale_status==='available'`、`line_sold_out!==1`、
  `getProductAvailableModes(p).delivery.enabled===true` 且 `!reason`（現在就能立即加入，非僅預約用）、
  今日／預購剩餘份數 >0 且未達購物車內上限、有效售價 >0。
- 排序：`Math.abs(price - remaining)` 由小到大，取前 3。無符合商品時完全不顯示，不顯示不實文案。
- 點擊即呼叫既有 `addCart(id, event)`（與商品卡片「+」按鈕完全相同的呼叫方式與流程：可售驗證、
  今日份數/預購判斷、加入動畫、`updateBar()`、Analytics 事件皆自動觸發），**沒有另外一套加入購物車邏輯**。
- 按鈕為 `<button type="button">`，`id` 一律經 `Number()` 正規化後才插入 inline `onclick`；
  商品名稱一律經專案既有 `esc()` escape helper 處理，不使用未轉義字串插值。

## 二、計算口徑

| 項目 | 來源 |
|---|---|
| 商品小計 | `getCartProductSubtotal()`（新增的單一共用函式）：`Σ (effective_line_price\|\|price) × qty`，優惠券折扣前、外送費加入前。與 `applyCoupon()`、`fetchDeliveryFee()`、`restoreCart()` 完全共用同一函式，不再各自 `reduce`。 |
| 免運門檻判斷金額 (`eligibleSubtotal`) | 與上述商品小計相同（優惠券折扣前）——因為目前 `routes/delivery.js` 的 `calcFee()` 與 `routes/line-orders.js` 的 `recalcDeliveryFee()` 判斷免運門檻本來就是用「優惠券折扣前」的 `subtotal`，前端顯示口徑刻意與後端保持一致，不是照字面上採「商品折扣後」金額。 |
| 免運門檻來源 | `shopData.delivery_free_threshold`（透過 `/api/line-shop` 新增回傳，向下相容 `routes/delivery.js` 既有 `getSetting(...,'delivery_free_threshold','1000')` 的預設值 1000）。 |
| 啟用判斷 | 若店家設定明確存在 `delivery_free_enabled`（`'0'`/`'1'`/`0`/`1`/布林值）→ 用既有 `toBooleanFlag()` 解析；**沒有**設定這個欄位時（目前正式環境的實況），fallback 為 `threshold>0` 即視為啟用，不會因新增此欄位讓已設定門檻的店家看不到功能。 |
| 原始外送費 / 最終外送費 / 折抵金額 | 見下方「前後端一致性」。折抵金額一律用 `Math.max(rawFee-finalFee,0)` 實際差額計算，不假設等於 `delivery_basic_fee`。 |

## 三、前後端一致性（實際 API 欄位對應）

`POST /api/delivery/calculate-fee` 實際回傳欄位（`routes/delivery.js`，未變更）：

| 後端欄位 | 前端統一物件 `_deliveryFeeResult` |
|---|---|
| `raw_fee` | `rawFee` |
| `delivery_fee` | `finalFee` |
| `is_free_delivery` | `isFreeDelivery` |
| `distance_km` | `distanceKm` |
| （前端衍生，後端未回傳） | `discount = Math.max(rawFee-finalFee,0)` |
| （前端衍生，後端未回傳） | `mode = isFreeDelivery ? 'full' : (finalFee<rawFee ? 'distance_only' : 'full')` |
| 失敗且 `reason==='out_of_range'` | `outOfRange = true` |

`_deliveryFeeResult` 為 `null` 表示外送費尚未算出（例如地址尚未確認）。`updateDeliveryFreeProgress()`
只讀這個物件與 `shopData`/`cart`/`currentMode`，不直接散落讀取多個全域變數。

送單時 (`routes/line-orders.js`) 仍由 `recalcDeliveryFee()` 重新計算 `raw_fee`/`delivery_fee`，
前端顯示僅供參考，**不影響**實際收費，後端永遠是最終依據。

## 四、進度更新時機

`updateDeliveryFreeProgress()` 掛在既有 `updateBar()`（= `updateCartTotals()`）尾端，
而 `updateBar()`/`updateCartTotals()` 已經是專案既有系統中，購物車增減、優惠券套用/移除、
外帶外送切換、外送費重新計算、購物車還原、LINE Login/LIFF 回跳恢復後都會呼叫的既有入口，
因此不需要另外新增/重複註冊事件監聽器。`updateDeliveryFreeProgress()` 內部**不會**呼叫
`updateBar()`/`updateCartTotals()`，避免遞迴。

## 五、相容性（未改動項目）

明確**沒有變更**：
- 外送距離計算（`getDrivingDistanceKm()`）與 Google Routes API 串接參數
- 最大配送距離規則（`delivery_max_distance_km`）與其阻擋邏輯（`out_of_range` 仍會使
  `deliveryFeeCalculated` 維持 `false`，客戶端 `submitOrder()` 既有的
  `if(!deliveryFeeCalculated){...return;}` 檢查與後端 `recalcDeliveryFee()` 皆原樣阻擋送單）
- 優惠券驗證/計算 API（`routes/coupons.js`、`coupon_apply_to_delivery_fee`）
- LINE Login／LIFF 流程與 Cart Handoff 還原機制
- 訂單資料表格式與下單 API 主要邏輯（`routes/line-orders.js` 本次唯一變更僅新增
  8 個既有設定 key 到 `/shop` 回傳白名單，未動到下單/驗證/計算邏輯本身）
- Android App（`pos-android-hotfix16.zip` 完全未觸碰——本功能僅屬 LINE Web 點餐購物車）

`/api/line-shop` 新增回傳的欄位僅限顧客頁需要的非敏感設定：
`delivery_free_enabled`、`delivery_free_threshold`、`delivery_free_mode`、
`delivery_free_distance_km`、`delivery_basic_fee`、`delivery_distance_fee_enabled`、
`delivery_max_distance_km`、`coupon_apply_to_delivery_fee`。
**未**一併公開任何 API key、店家內部備註、成本、後台權限設定、Google server key、
LINE secret 或 access token。

## 六、修改/新增檔案

- `public/line-order.html`（修改）：新增 UI 區塊、CSS、`renderDeliveryFreeProgress()`、
  `renderDeliveryFreeRecommendations()`、`updateDeliveryFreeProgress()`、共用
  `getCartProductSubtotal()`；`fetchDeliveryFee()`/`resetDeliveryFee()` 新增狀態追蹤欄位。
- `public/js/delivery-free-progress.js`（新增）：抽出的純函式 `getDeliveryFreeProgressState()`，
  瀏覽器與 Node 測試共用同一份檔案。
- `routes/line-orders.js`（修改）：`/shop` 設定白名單新增 8 個既有外送費/免運相關 key。
- `scripts/smoke-delivery-free-progress.js`（新增）：regression test，31 項斷言，13 個情境。

## 七、測試結果（本輪重新執行）

| 指令 | 結果 | exit code |
|---|---|---|
| `node -c routes/line-orders.js` | PASS | 0 |
| `node -c public/js/delivery-free-progress.js` | PASS | 0 |
| `node scripts/smoke-delivery-free-progress.js` | **31/31 PASS** | 0 |
| `node -c routes/delivery.js` | PASS | 0 |
| `node -c server.js` | PASS | 0 |
| `public/line-order.html` inline `<script>` × 2（抽取後個別語法檢查） | PASS / PASS | 0 / 0 |

專案未提供 `scripts/regression-all.js`、`scripts/smoke-all.js`，`package.json` 也未定義
`"test"` script——因此**沒有**執行、也沒有捏造這些結果。

## 八、尚需部署後人工驗證項目

以下項目在沙盒環境中無法自動驗證，需部署後人工確認：
- 手機 Chrome / LINE 內建瀏覽器實際視覺呈現（RWD、進度條顏色對比、不遮擋付款方式）
- Google Places Autocomplete 下拉選單實際互動
- 實際 GPS 定位權限授權流程
- 正式環境 `/api/delivery/calculate-fee` 真實回應（含真實 Google Routes API 距離結果）
- LINE Login／LIFF 實際回跳後的購物車與免運狀態恢復
- 實際送出訂單、後台檢視實收外送費是否與前端顯示一致
