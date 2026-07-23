# C4 — 購物車商品變動後即時重算滿額外送優惠

以 `pos-web-fix18-10-hotfix30-C3-distance-free-rules-full` 為基礎的增量修正。
只處理「購物車商品增加／減少／推薦加購後，外送費與滿額提示沒有即時更新」的前端同步問題，
不修改 C3 shared engine、距離級距規則、後端重算、price_changed、優惠券及訂單資料格式。

## 一、根因

`addCart()` / `chgQty()` / `removeCartItem()` / `addPreorderToCart()` 原本只更新
`cart` 物件、`localStorage`、部分小計 DOM，但沒有在每次異動後：

1. 重新呼叫 `/api/delivery/calculate-fee` → `_deliveryFeeResult` 停留在「異動前」那次
   API 算出的舊值（`reached`/`finalFee` 都是舊的），造成商品減少後仍顯示已達免運，
   必須送出訂單或重開購物車才會更新。
2. 重新呼叫 `renderCartItems()` → 購物車 modal 內的商品列表從未因 `addCart()`
   （含湊免運推薦按鈕，兩者共用同一函式）而更新，必須關閉重開才看得到新加入的商品。

## 二、修改檔案

- `public/line-order.html`（唯一修改的程式檔）
- `scripts/smoke-cart-delivery-live-refresh.js`（新增）
- 本檔案（新增）

比對乾淨的 C3 原始 zip 確認：**只有這兩個檔案有變動**，其餘檔案（routes/、middleware/、
services/、其他 public/ 頁面）位元組完全相同。

## 三、統一購物車同步流程

新增 4 個函式，全部加在 `public/line-order.html` 內（`resetDeliveryFee()` 之後）：

```js
function hasValidDeliveryLocation(){ ... }      // deliveryLatLng 是否已有效
function setDeliveryFeePending(){ ... }         // 清空 _deliveryFeeResult，防止沿用舊「已達免運」
function scheduleDeliveryFeeRefresh(){ ... }    // 依模式/地址狀態決定要不要打 API，150ms debounce
function refreshCartAfterMutation(){ ... }      // 單一同步入口：render 購物車列表 ＋ 排程重算外送費
```

`addCart()`、`addPreorderToCart()`、`chgQty()`、`removeCartItem()` 在原有的
`updateBar()` → `persistCart()` 之後，統一改呼叫 `refreshCartAfterMutation()`
（各自只呼叫一次，順序不變、儲存/追蹤時機不變）。`clearCartByUser()` 則直接取消
debounce 並清除舊結果（見下）。

### 資料流

```
商品異動（addCart/chgQty/removeCartItem/addPreorderToCart）
  → cart 資料修改（不變）
  → updateBar()（不變，立即更新角標/小計/畫面）
  → persistCart()（不變，立即寫入 localStorage）
  → refreshCartAfterMutation()
      → 購物車 sheet 開啟中？→ renderCartItems()（立即重繪商品列）
      → scheduleDeliveryFeeRefresh()
          → 非外送模式 → 只 updateCartTotals()，不動已存的外送地址
          → 外送模式但地址無座標 → 清除殘留 _deliveryFeeResult/deliveryFeeCalculated，
            只 updateCartTotals()，不呼叫 API
          → 外送模式且地址有效
              → setDeliveryFeePending()：_deliveryFeeResult=null，
                deliveryFeeCalculated=false，updateCartTotals()（畫面立即回到
                「已達滿額門檻，外送費將於確認地址後計算」而非舊的「已免運」）
              → clearTimeout(既有 debounce) + setTimeout(fetchDeliveryFee, 150)
  → 150ms 後：fetchDeliveryFee()（既有函式，未修改內部邏輯）
      → fulfillmentRenderToken 序號保護較舊回應
      → applyDeliveryFeeResult（寫回 _deliveryFeeResult/calcDeliveryFee/…）
      → updateCartTotals() → updateBar() → updateDeliveryFreeProgress()
        → renderDeliveryFreeProgress() + renderDeliveryFreeRecommendations()
```

`renderCartItems()`、`updateBar()`、`updateCartTotals()`、`updateDeliveryFreeProgress()`
的內部實作與呼叫方向完全沒有變動：`renderCartItems()` 只讀 `cart` 重繪 DOM，不改寫
`cart`；`updateDeliveryFreeProgress()` 一律不呼叫 `updateBar()`/`fetchDeliveryFee()`
（原有註解已明確聲明，本次未破壞這個約定）；`fetchDeliveryFee()` 結束時只呼叫既有的
`updateCartTotals()`，不會反向呼叫 `refreshCartAfterMutation()`——因此不會出現
`cart mutation → refresh → render → updateBar → fetch → updateBar → fetch` 這種遞迴。

## 四、商品加減行為

- **`chgQty()`**：庫存/今日份數/售完/預購餘量檢查沒有通過時，函式在到達
  `cart[id].qty+=d` 之前就已 `return`（沿用既有邏輯，未修改），因此不會呼叫
  `refreshCartAfterMutation()`，不會有「擋下的異動也觸發重算」的問題。
  數量 2→1、1→0（移除商品）都會走到 `refreshCartAfterMutation()`。
- **`removeCartItem()`**：移除後立即 `renderCartItems()`（若 sheet 開啟）、小計立即
  更新（`updateBar()` 本來就會做）、外送費立即進入 pending、debounce 到期後套用
  最新 API 結果。
- **`addCart()` / `addPreorderToCart()`**：加入後同樣立即重繪購物車列表＋排程重算；
  湊免運推薦按鈕呼叫的是同一個 `addCart(productId, event)`，沒有另外疊加第二套
  加購或第二次 `refreshCartAfterMutation()`（靜態檢查：`addCart()` 內
  `refreshCartAfterMutation()`、`_trackAddToCart()` 都只出現 1 次）。

## 五、推薦商品行為

`renderDeliveryFreeRecommendations()` 未修改：達標（`state.reached===true`）時隱藏
推薦區並清空列表；未達標時依「剩餘金額」重新排序、重新 render 候選商品。因為
`refreshCartAfterMutation()` 會在 API 回來後觸發 `updateDeliveryFreeProgress()`
→ `renderDeliveryFreeRecommendations()`，加購達標後推薦區會在同一輪重算中立即隱藏，
不需要額外程式碼。

## 六、pending 狀態與 race guard

- **Pending**：`setDeliveryFeePending()` 清空 `_deliveryFeeResult`／
  `deliveryFeeCalculated`，讓 `updateDeliveryFreeProgress()` 落回既有的
  「地址尚未確認座標」fallback 分支——這個分支本來就會把 `feeResolved` 設為
  `false`，而 C3 shared engine（`public/js/delivery-free-progress.js`，**未修改**）
  在 `feeResolved===false` 時的文案本就是「🎁 已達滿額門檻／外送費將於確認地址後
  計算折抵」，不會顯示「已免 NT$50」這類已折抵成功的文案。
- **Race guard**：沿用既有 `fulfillmentRenderToken`（`fetchDeliveryFee()` 內
  `const myToken = ++fulfillmentRenderToken`）。實測（見下方測試 [3][9][12]）
  確認：連續三次商品異動（150→300→150）觸發三次
  `fetchDeliveryFee()`，即使中間那次（300）的回應最晚才 resolve，最終
  `_deliveryFeeResult` 仍是最後一次（150）呼叫的結果，不會被較舊、較慢的回應覆蓋。
  因此**沒有新增 `_deliveryFeeRequestSeq`**——既有 token 機制已經同時涵蓋
  render 過期判斷與外送費請求排序，重複實作一套序號只會增加維護成本，已在
  smoke test 中對真實程式碼驗證過，而非憑函式名稱推測。
- **Debounce**：`scheduleDeliveryFeeRefresh()` 只使用單一 `_cartDeliveryRefreshTimer`
  變數，每次呼叫先 `clearTimeout` 前一顆，因此快速連續呼叫最終只會真正送出一次
  API（見測試 [12]）。

## 七、送單防護

`submitOrder()` 既有檢查（本次未修改）：

```js
if(!deliveryFeeCalculated){toast('請稍候，外送費計算中…');return;}
```

由於 `setDeliveryFeePending()` 會把 `deliveryFeeCalculated` 設回 `false`，
重算期間點擊送出訂單會被這行既有檢查擋下，不會清空購物車、不會關閉購物車、
不會自動送出、也不會使用上一筆 preview。API 回來、`deliveryFeeCalculated`
恢復 `true` 後即可正常送單。此檢查只在 `type==='delivery'` 時生效（外帶模式
`deliveryFeeCalculated` 不影響送單，與既有行為一致）。送出按鈕的 `disabled`
只在 `submitOrder()` 執行期間短暫設定（`btn.disabled=true;...'送出中…'`），
非永久停用。

## 八、清空購物車

`clearCartByUser()` 改成不透過 `scheduleDeliveryFeeRefresh()`（原本會在 subtotal=0
時多打一次不必要的 `/api/delivery/calculate-fee`），而是直接：

```js
clearTimeout(_cartDeliveryRefreshTimer);
_deliveryFeeResult = null;
deliveryFeeCalculated = false;
```

取消任何尚未送出的重算 debounce，並清除舊結果，避免殘留清空前的「已達免運」畫面。

## 九、相容性（未改動）

- C3 shared engine（`public/js/delivery-free-progress.js`）
- 距離級距規則、`utils/deliveryFeeCalc.js`
- 訂單後端重算、`routes/line-orders.js`、`routes/delivery.js`
- `price_changed` 檢查與 UI 處理
- Google Places Autocomplete / GPS 定位 / 手動輸入地址 → 這些既有流程仍各自呼叫
  `fetchDeliveryFee()`（`place_changed` 用既有 300ms `_calcFeeTimer`、GPS 用
  `useCurrentLocation()`、外帶切外送用 `applyFulfillmentMode()` 內既有呼叫），
  完全沒有被新的 `_cartDeliveryRefreshTimer` 取消或覆蓋——兩顆 debounce timer
  各自獨立，最終都會呼叫同一個 `fetchDeliveryFee()`，由其內部既有的
  `fulfillmentRenderToken` 決定「最後一次呼叫」的結果生效，不論呼叫來源是地址
  變更還是商品變更。
- LINE Login／LIFF、優惠券 API、Analytics 事件定義（`_trackAddToCart` /
  `_trackRemoveFromCart` / `_trackEvent`）
- 優惠券：本次沒有修改優惠券驗證邏輯。`getCartProductSubtotal()`（外送費/滿額
  判斷用的小計口徑）本來就不含優惠券折扣前後差異，商品增減後優惠券是否仍有效，
  沿用原本既有規則（`applyCoupon()`/`clearCoupon()` 未變動）——如果現有規則本來
  就不會在商品異動後自動重新驗證優惠券，C4 沒有新增這個行為，僅新增了外送費即時
  重算，不影響優惠券計算路徑。

## 十、測試

```
$ node scripts/smoke-cart-delivery-live-refresh.js
═══ 總結：38 PASS / 0 FAIL / 4 MANUAL REQUIRED ═══

$ node scripts/smoke-delivery-free-progress.js
[smoke-delivery-free-progress] 18 passed, 0 failed

$ node scripts/smoke-delivery-distance-promotion.js
[smoke-delivery-distance-promotion] 75 passed, 0 failed
```

`node -c` 語法檢查：`public/js/delivery-free-progress.js`、`routes/delivery.js`、
`routes/line-orders.js`、`utils/deliveryFeeCalc.js`，以及從 `public/line-order.html`
抽出的全部 6 個 `<script>` 區塊（其中 4 個為空白/外部 script，2 個有內容），全數
`node -c` 通過。

repo 內沒有 `npm test`、`scripts/regression-all.js`、`scripts/smoke-all.js`，
如實回報：不存在，未執行。

`scripts/smoke-cart-delivery-live-refresh.js` 的做法是直接從
`public/line-order.html` 抽取本次實際改動/新增的原始碼（而不是另外重寫一份簡化
邏輯），在 Node `vm` sandbox 中搭配假的 `apiFetch`/`document`/計時器執行，涵蓋：

1. 商品減少後 pending 清空舊「已達免運」結果
2. 推薦加購：購物車立即 render＋debounce 到期打 API、finalFee/reached 套用最新結果
3. 快速連點競態（150→300→150，舊回應晚到不覆蓋）
4. 刪除最後一件商品後清空舊結果
5. 外帶模式不觸發外送費 API，且不清除已保存的地址座標
6. 無地址不呼叫 API
7. 送單既有「外送費計算中」阻擋文案仍在
8. Regression：既有 `updateBar()`/`persistCart()` 呼叫順序與時機不變
9. 300→150／150→300 兩個方向的 finalFee 重算
10. 購物車關閉時不強制 `renderCartItems()`
11. 清空購物車取消尚未送出的 debounce
12. debounce collapse：連續三次商品異動只真正送出一次 API
13. `renderDeliveryFreeRecommendations()` 達標隱藏／未達標重新顯示（含候選商品 render）
14. `addCart()` 只記錄一次 `add_to_cart` Analytics、只呼叫一次 `refreshCartAfterMutation()`
15. `refreshCartAfterMutation()` 未繞過 debounce 直接呼叫 `fetchDeliveryFee()`

### 部署後手動驗證（MANUAL REQUIRED，無法在沙盒環境自動化）

- iPhone Safari／LINE 內建瀏覽器快速連點的 150ms debounce／「計算外送費中…」
  文案切換節奏是否符合體感
- 真實 GPS／地址變更與商品異動交錯時的畫面表現
- LIFF 回跳、LINE Login 購物車還原（`restoreCart()`）後是否也該觸發即時重算
  （本次範圍外，未修改 `restoreCart()`）
- 正式環境 API 延遲下的實際使用者體感
- 實際送出訂單（含 LINE Pay 導轉）流程
