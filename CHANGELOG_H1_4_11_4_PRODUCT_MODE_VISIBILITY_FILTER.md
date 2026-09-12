# H1.4.11.4｜LINE 點餐依外帶／外送模式篩選商品與分類同步修正

直接基底：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11.3-...-full.zip`（H1.4.11.3，
SHA-256: f509c6e80ffb2274b6d365913d65b89455f12c9a3733a7f1900bca268e1c0a68，已核對）。
全程未回退重做、未切換基底。

## 一、Reality Audit

1. `renderMenu()`（修改前）只依 `currentCat` 過濾 `allProducts`，完全不依頁面模式或
   `currentMode` 過濾——確認為根因。
2. `buildCats()`（修改前）永遠顯示全部分類、且重建時 active 樣式永遠寫死指向
   `'all'`（因為當時只在 init() 呼叫一次，從未真正暴露這個潛在問題）。
3. `_productModeStatus()`／`getProductAvailableModes()` **不會**直接讀取
   `line_takeout_enabled`／`line_delivery_enabled`；它們只讀 `takeout_sold_out_reason`／
   `delivery_sold_out_reason`（後端 `routes/line-orders.js` 已經把
   `line_takeout_enabled=0` 正確折算成 `sold_out_reason='product_mode_disabled'`）。
   這代表「僅外送」徽章的判斷資料本身是對的，只是 `renderMenu()` 從未用它來決定
   商品要不要從列表消失。
4. `/api/line-menu`（`routes/line-orders.js`）已回傳 `line_takeout_enabled`／
   `line_delivery_enabled`（皆 `Number(...??1)`，缺席時視為 1）。
5. `GET /validate-cart` 與正式送單端點（`routes/line-orders.js`）已對
   `product_mode_not_supported` 做驗證，本輪完全未修改，用真實 HTTP 請求驗證仍生效。
6. `getLineOrderPageMode()` 兩個真實值：`'combined_checkout'`、`'fulfillment_switcher'`
   （H1.4.11 起）。
7. `applyFulfillmentMode()` 已經是唯一的模式切換入口，且已經呼叫 `renderMenu()` 一次
   （H1.4.11.3 未變動這點），是本輪整合 `buildCats()` 呼叫的正確位置。
8. H1.4.11.3 的 `refreshShopStatus()` 單次重繪／購物車開關互斥路徑，本輪延續沿用，
   詳見四。

## 二、原始問題重現

顧客在 `fulfillment_switcher` 模式選擇「🛍️ 外帶自取」（`currentMode='takeout'`）後，
`line_takeout_enabled=0, line_delivery_enabled=1`（僅外送）的商品仍出現在外帶商品列表，
商品卡右下角顯示「僅外送」徽章——徽章文字正確，但商品本身不該出現在外帶列表。反向
（外送模式看到僅外帶商品）情況相同。

## 三、根因

`renderMenu()`／`buildCats()` 從未依頁面模式（`fulfillment_switcher`）與
`currentMode` 過濾商品；`_productModeStatus()` 判斷的是「今天能不能買」（暫時狀態），
不是「這個商品永久支不支援這個取餐方式」（商品自身設定），兩者職責原本就不同，只是從
未有任何函式把後者拿來做「要不要顯示在列表」的判斷。

## 四、兩種頁面模式行為差異（真值表）

| 商品設定 | `fulfillment_switcher`+外帶頁 | `fulfillment_switcher`+外送頁 | `combined_checkout` |
|---|---:|---:|---:|
| 外帶、外送皆啟用 | 顯示 | 顯示 | 顯示（無徽章） |
| 僅外帶 | 顯示 | 隱藏 | 顯示（「僅外帶」徽章） |
| 僅外送 | 隱藏 | 顯示 | 顯示（「僅外送」徽章） |
| 外帶、外送皆停用 | 隱藏 | 隱藏 | 隱藏（既有規則，兩模式皆不可買） |

`combined_checkout` 完全未變動：仍顯示任一模式可買的商品、保留既有徽章、`_ffViewMode`
改變不觸發任何商品/分類重繪、不寫入 `currentMode`／`oType`。

## 五、商品永久支援欄位與暫時營業狀態的區別

新增的可見性判斷**只**讀取 `line_takeout_enabled`／`line_delivery_enabled`（商家對
商品的固定通路設定），完全不讀取：`_productModeStatus().enabled`、
`getFulfillmentStatus().selectable`、`sold_out_reason`、`today_open`、`cutoff_passed`、
`allow_next_day`、`pre_sale_available`、份數、公休、Business Calendar 等——這些欄位
繼續只影響 `buildCard()` 既有的徽章／可購買狀態顯示，不影響商品是否出現在列表。
新增第 24～27 項測試逐一驗證：尚未開始／今日售完／可預訂明日／Business Calendar 公休
但永久支援目前模式的商品，皆保留在列表中。

## 六、商品及分類過濾流程

- 新增 `isProductSupportedForFulfillmentMode(product, mode)`：讀
  `line_takeout_enabled`／`line_delivery_enabled`，用既有 `toBooleanFlag(raw, true)`
  解析（缺席預設啟用；正確處理 `0`／`1`／`"0"`／`"1"`／布林值）。
- 新增 `getVisibleProductsForCurrentPage()`：`combined_checkout` 回傳 `allProducts`
  原樣；`fulfillment_switcher` 依 `currentMode` 過濾。`renderMenu()`／`buildCats()`
  共用同一份，不各寫一套判斷。
- `renderMenu()`：改用 `getVisibleProductsForCurrentPage()` 取代 `allProducts`，
  `fulfillment_switcher` 下若整個模式沒有任何可見商品，顯示模式專屬空狀態文案
  （不是系統錯誤/今日售完/今日公休/載入失敗）。
- `buildCats()`：`fulfillment_switcher` 下只顯示至少一項可見商品的分類（「全部」固定
  保留），並修正了一個連帶發現的既有小 bug——原本重建分類列時 active 樣式永遠寫死指向
  `all`，不管 `currentCat` 實際是什麼；現在正確依目前 `currentCat` 標記 active，且
  `currentCat` 若已無可見商品會自動重設為 `all`。

## 七、頁面模式動態切換補正（H1.4.11.4 續作二）

後台可能只把 `line_order_page_mode` 改變（`enabled`/`cutoff`/`todayClosed` 都不變），
此時 `refreshShopStatus()` 走輕量路徑。H1.4.11.3 的輕量路徑只重繪頂端圖塊
（`combined_checkout`↔`fulfillment_switcher` 切換不會反映到商品列表），修正為：

```js
const _pageModeChangedLight = _pageModeAfter!==_pageModeBefore;
if(_pageModeChangedLight){ buildCats(); renderMenu(); }
```

只在頁面模式真的改變、且屬於輕量路徑時才補這一次 `buildCats()`／`renderMenu()`
（重用既有 `allProducts`，不重新 fetch `/api/line-menu`）；重量級路徑本來就會透過
menu-fetch 成功後的 `buildCats()`＋接下來的 `renderMenu()` 反映新頁面模式，本輪未在
重量級路徑額外加呼叫。用真實 `refreshShopStatus()`＋真實 fetch spy＋真實 DOM 驗證：
合併→切換、切換→合併兩個方向皆 `buildCats()`／`renderMenu()` 恰好一次、零額外
`/api/line-menu`、購物車/`currentMode`/`#oType` 不受影響。

## 八、切換取餐方式呼叫鏈

`applyFulfillmentMode()`（唯一模式切換入口，未新增第二條路徑）新增一行
`buildCats();`，緊接在既有 `renderMenu();` 之前，两者皆只在這一個函式裡各呼叫一次。
真實呼叫 `applyFulfillmentMode('delivery')` 驗證：`buildCats()`／`renderMenu()` 恰好
各一次、購物車不清空、`currentMode`/`#oType` 正確更新、不整頁重載。

## 九、商品詳情與加入購物車防繞過

`addCart(id)`／`openProductDetail(id)` 新增守衛：`fulfillment_switcher` 模式下，若
商品不永久支援 `currentMode`，一律 `toast()`（不用 `alert()`）+ `return`，不加入購物車
／不開啟詳情，不使用 `_representativeMode()` 偷改模式。`combined_checkout` 模式完全
不受影響（任一模式可買即可加入，既有規則）。真實呼叫 `addCart()`／
`openProductDetail()`（含用 spy 驗證 `ProductDetailModal.open()` 未被呼叫）驗證繞過
防護生效。

## 十、購物車衝突處理

未變動既有 `getCartAvailableModes()`／`renderModeConflict()`；切換模式後購物車內不
相容商品不會被自動移除，用真實呼叫 `getCartAvailableModes()` 驗證正確偵測到衝突。
後端 `/validate-cart`（真實 HTTP，真實 DB fixture）與正式送單端點皆仍對
`product_mode_not_supported` 拒絕，本輪未修改這兩個既有端點。

## 十一、Analytics

未修改 `checkout_click`／`view_item`／`add_to_cart`／`purchase` 事件語意。隱藏商品
因為從未被 `buildCard()` 渲染進 DOM，天然不會被 `_setupViewProductObserver()` 觀察
（用真實 DOM 查詢驗證）。用真實模擬一次 IntersectionObserver 的 intersecting callback
（觸發一次真正的 `view_product`）+ 重新渲染同一批商品，驗證 seenSet／sessionStorage
去重機制正確阻止同一商品卡被重複加入 observe 清單，`view_product` 總呼叫次數維持 1。

## 十二、實際修改檔案

- `public/line-order.html`：新增 `isProductSupportedForFulfillmentMode()`／
  `getVisibleProductsForCurrentPage()`；改寫 `renderMenu()`／`buildCats()`；
  `applyFulfillmentMode()` 新增一行 `buildCats()`；`addCart()`／`openProductDetail()`
  新增防繞過守衛；`refreshShopStatus()` 輕量路徑新增 `pageModeChanged` 補正。
- `routes/line-orders.js`：僅 `build_version` 更新為 `H1.4.11.4`。
- `public/index.html`：僅 `app.js` cache-bust 更新為 `?v=h1-4-11-4`。
- 新增 `scripts/smoke-h1-4-11-4-product-mode-visibility.js`。
- 新增本 changelog。

`diff -rq` 對照未修改的 H1.4.11.3 基準（排除 `node_modules`/`data`）確認**僅**上述
檔案變動，`routes/settings.js`、舊測試檔、`public/js/app.js` production 邏輯、DB
schema/migration 完全未觸碰。

## 十三、測試命令與通過數

| 指令 | 結果 |
|---|---|
| `node --check routes/settings.js` | OK |
| `node --check routes/line-orders.js` | OK |
| `node --check public/js/app.js` | OK |
| `node --check scripts/smoke-h1-4-11-4-product-mode-visibility.js` | OK |
| `node --check scripts/smoke-h1-4-11-line-order-page-mode.js` | OK |
| `node --check scripts/smoke-h1-4-11-1-fixes.js` | OK |
| `node --check scripts/smoke-h1-4-11-2-fixes.js` | OK |
| `node scripts/smoke-h1-4-11-4-product-mode-visibility.js` | **74 PASS / 0 FAIL** |
| `smoke-h1-4-11-2-fixes.js`（預設/UTC/Asia-Taipei/Asia-Tokyo） | **84 PASS / 0 FAIL ×4** |
| `smoke-h1-4-11-1-fixes.js`（預設/UTC/Asia-Taipei/Asia-Tokyo） | **80 PASS / 0 FAIL ×4** |
| `smoke-h1-4-11-line-order-page-mode.js` | 66 PASS / 0 FAIL |
| 12 支核心回歸（checkout/friend/liff/asset-cache/reconcile/delivery 等） | 全部 0 FAIL |

`unhandledRejection` 在 `smoke-h1-4-11-4-product-mode-visibility.js`／
`smoke-h1-4-11-1-fixes.js`／`smoke-h1-4-11-2-fixes.js` 中皆已是真正的 `assert()`（會
影響 exit code），全程未偵測到任何未處理 rejection。

## 十四、基準既有失敗比對

| 測試 | 結果 | 與 H1.4.11.3 基準比對 |
|---|---|---|
| `smoke-hotfix26-f2.js` | 22 PASS / 3 FAIL | 失敗項目名稱完全相同（switchMode/refreshModeCutoffUI 呼叫比對、後端截止判斷、/timeslots 截止判斷） |
| `smoke-hotfix26-f7.js` | 46 PASS / 1 FAIL | 失敗項目相同（INSERT 欄位數硬編碼已過期） |
| `smoke-cart-delivery-live-refresh.js` | exit 1 | 同一位置同一錯誤（`extractBlock()` 找不到舊起點標記） |

未修改這三支舊測試，也未修改 production 邏輯迎合過期靜態斷言。

## 十五、build_version 與 cache-bust

`build_version='H1.4.11.4'`；`app.js?v=h1-4-11-4`；已確認無殘留 `?v=h1-4-11-3`。

## 十六、已知限制

1. `today_not_open` 三種 reason 分類、`findNextServiceInfo()` 60 天掃描上限（沿用
   H1.4.11.2/.3，未變動）。
2. 商品可見性判斷不考慮購物車內既有不相容商品的「移除建議」，僅沿用既有衝突提示流程
   （符合需求文件十不得自動移除的要求）。
3. f2/f7/cart-delivery-live-refresh 三支既有測試的基準版既有失敗維持原樣。
