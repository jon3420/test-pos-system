# H1.4.11.3｜購物車開啟時的服務狀態刷新、單次重繪與結帳 UI 同步補正

直接基底：`fix18-10-hotfix30-B5-R5.4-G1.6-GA4-H1.4.11.2-...-full.zip`（H1.4.11.2）。
全程未回退重做、未進行無關重構、未重新解壓或切換基底。

## 一、Reality Audit（修改前實際確認）

1. `refreshShopStatus()` 有重量級路徑（`prevToCP/prevDlCP/prevTodayClosed/prevToEn/
   prevDlEn` 任一改變）與輕量路徑（其餘欄位改變）。
2. `refreshModeCutoffUI()` 內含 `buildServiceStatusBar()`（第一行）。
3. `refreshDateSelectorForCart()` 修改前的最後一步是 `refreshModeCutoffUI();`，且開頭
   `await refreshCartProductsFromLatestMenu()`（不傳參數時會自行重新 fetch
   `/api/line-menu`）。
4. 購物車開啟時，H1.4.11.2 版的重量級路徑會先呼叫一次
   `renderMenu();refreshModeCutoffUI();updateModeAvailabilityUI();`（第一次
   `buildServiceStatusBar()`），接著呼叫 `refreshCartProductsFromLatestMenu(_latestMenuProducts)`
   （重用已抓到的菜單，這次不會重複 fetch），再呼叫
   `await refreshDateSelectorForCart()`（**不傳參數**）——refreshDateSelectorForCart()
   內部因此又自行重新 `await refreshCartProductsFromLatestMenu()`（**觸發第二次
   `/api/line-menu`**），並在結尾再呼叫一次 `refreshModeCutoffUI()`（**第二次
   `buildServiceStatusBar()`**)。
5. `buildFulfillmentOptions()`／`buildDateSelector()`／`buildTimeSelector()` 都是
   `refreshDateSelectorForCart()` 內部依購物車商品是否需要強制預約明日而呼叫的既有
   函式，本輪未修改其判斷邏輯本身；`updateModeAvailabilityUI()`（管
   `#modeUnavailableBanner`／`#subBtn`／`#goCheckoutBtn` 的 disabled 狀態，讀
   `isCurrentModeAvailable()` → `getFulfillmentStatus(currentMode).selectable`）在
   H1.4.11.2 版的輕量路徑完全沒有被呼叫。
6. `pageshow`／`visibilitychange`／`focus` 三者皆已在 H1.4.11.2
   `wireFulfillmentLifecycleRefresh()` 內統一委派 `requestShopStatusRefresh()`，本輪
   未變動這部分。
7. `requestShopStatusRefresh()` 的 in-flight coalescing（H1.4.11.2 已實作）本輪未變動，
   仍然有效（見下方回歸測試）。
8. **H1.4.11.2 的 `unhandledRejection` 監控只有 `console.log('[WARN] ...')`，並未真正
   影響 assertion 或 exit code**——已在本輪修正為真正的 `assert()`（見六）。
9. H1.4.11.2 現況：`.env.example` 已存在（76 個變數，與程式碼實際使用完全對齊）；
   `build_version='H1.4.11.2'`；`app.js?v=h1-4-11-2`。

## 二、兩個問題的實際重現結果

### 問題一：購物車開啟時仍會重複重繪（已用真實 spy 計數重現並修正）

用 spy 包裝 `buildServiceStatusBar()` 與 mock `window.fetch` 計數 `/api/line-menu`
呼叫次數，在購物車 `#cartSheet` 含 `show`、觸發重量級狀態改變（`today_open` 翻轉）的
情境下，H1.4.11.2 版重現：`buildServiceStatusBar()` 呼叫 2 次、`/api/line-menu`
呼叫 2 次。修正後（見四）：兩者皆恰好 1 次（`scripts/smoke-h1-4-11-2-fixes.js` 4.1 組）。

### 問題二：輕量刷新只有頂端圖塊更新，購物車仍是舊狀態（已重現並修正）

先呼叫 `updateModeAvailabilityUI()` 讓 `#goCheckoutBtn.disabled=true`（cutoff +
`allow_next_day=false`），再模擬後台只把 `allow_next_day` 改為 `true`（其餘 4 個重量級
判斷欄位不變，走輕量路徑）執行 `refreshShopStatus()`。H1.4.11.2 版重現：
`getFulfillmentStatus('takeout').selectable` 變 `true`、頂端圖塊不再是
`ff-unavailable`，但 `#goCheckoutBtn.disabled` 仍是 `true`（因為輕量路徑從未呼叫
`updateModeAvailabilityUI()`）。修正後：`#goCheckoutBtn.disabled===false`、
`#subBtn.disabled===false`（`scripts/smoke-h1-4-11-2-fixes.js` 4.2 組）。

## 三、修改檔案

- `public/line-order.html`：
  - `refreshDateSelectorForCart()` 維持既有 `async function refreshDateSelectorForCart()`
    空參數宣告（相容 `scripts/smoke-hotfix26-f2.js` 的既有靜態 regex），內部改用
    `arguments[0]` 取得選填的 `latestProducts`，轉呼叫
    `refreshCartProductsFromLatestMenu(latestProducts)`；不傳參數時行為與 H1.4.11.2
    完全相同（自行重新 fetch）。
  - `refreshShopStatus()` 重量級與輕量路徑都改為依「購物車是否開啟」分成互斥的兩條
    子路徑（見下方「四、四種刷新組合」），購物車關閉的重量級子路徑維持
    `renderMenu();refreshModeCutoffUI();updateModeAvailabilityUI();` 原始相鄰呼叫順序
    （同樣是相容既有 `smoke-hotfix26-f2.js` 靜態比對，且這本來就是正確的執行順序，
    不是為了討好測試而改邏輯）。
  - `settings.build_version` 之外，本檔沒有新增 interval／timer／全域 suppression flag。
- `routes/line-orders.js`：`build_version` 更新為 `'H1.4.11.3'`。
- `public/index.html`：`app.js` 版本 query 更新為 `?v=h1-4-11-3`。
- `scripts/smoke-h1-4-11-1-fixes.js`：`unhandledRejection` 改為真 assertion。
- `scripts/smoke-h1-4-11-2-fixes.js`：`unhandledRejection` 改為真 assertion；修正
  `validateOrderConditions()` 相關測試描述用字（見七）；新增 4.1／4.2／4.3 共 26 項
  真實 jsdom 斷言（購物車開啟＋重量級／購物車開啟＋輕量／購物車開啟時 API 失敗）。
- 本 changelog（新增）。

未修改：`checkout_click` 事件、外送地址/地圖/距離/外送費、滿額免運、優惠券、付款方式、
LINE 登入、Friend Required Gate、Friend Guide、Historical Friend Reconcile、
Cart Recovery、n8n Secret、手機欄位、冷藏宅配、商品價格/分類/庫存、外帶外送商品相容性、
`validateOrderConditions()`、合併菜單架構。

## 四、四種刷新組合的最終流程

| 路徑 | 購物車 | 最終流程 |
|---|---|---|
| Heavy | 關閉 | `renderMenu();refreshModeCutoffUI();updateModeAvailabilityUI();`（1 次 `buildServiceStatusBar()`）→ `refreshCartProductsFromLatestMenu(_latestMenuProducts)`（重用已抓菜單，0 次額外 fetch） |
| Heavy | 開啟 | `renderMenu();` → `refreshDateSelectorForCart(_latestMenuProducts)`（內部 1 次 `refreshCartProductsFromLatestMenu(latestProducts)`，重用已抓菜單；1 次 `refreshModeCutoffUI()` → 1 次 `buildServiceStatusBar()`）→ `updateModeAvailabilityUI()` |
| Light | 關閉 | `buildServiceStatusBar()`（1 次）→ `updateModeAvailabilityUI()`（H1.4.11.2 缺少，本輪補上） |
| Light | 開啟 | `refreshDateSelectorForCart(allProducts)`（重用目前已載入的 `allProducts`，不額外 fetch；內部 1 次 `refreshModeCutoffUI()` → 1 次 `buildServiceStatusBar()`）→ `updateModeAvailabilityUI()` |

四組情境皆已用 `scripts/smoke-h1-4-11-2-fixes.js` 的 4.1／4.2 組（含真實 spy 計數、真實
DOM 元素）驗證：圖塊恰好重繪 1 次；Heavy+開啟情境 `/api/line-menu` 恰好 1 次；
Light+開啟情境完全不額外呼叫 `/api/line-menu`。

## 五、如何保證一次重繪、如何避免重複 `/api/line-menu`

- 重繪：Heavy／Light 兩層都先判斷「購物車是否開啟」（同一個 `_cartOpenNow` 變數，
  只查一次 DOM，避免兩處各自查詢可能得到不一致答案），開啟與關閉是互斥的 if/else，
  各自只有一條路徑會呼叫 `buildServiceStatusBar()`（直接呼叫或透過
  `refreshModeCutoffUI()`/`refreshDateSelectorForCart()` 間接呼叫），不會重疊。
  例外（catch）分支只在正常路徑失敗時才補畫一次，正常成功路徑不會經過那段程式碼，
  因此不會造成「正常路徑重繪兩次」。
- `/api/line-menu`：重量級路徑只在最上層 fetch 一次，把結果（`_latestMenuProducts`）
  往下傳給 `refreshCartProductsFromLatestMenu()`／`refreshDateSelectorForCart()`，兩者
  收到非 `undefined` 的參數就不會再自己 fetch。輕量路徑完全不 fetch 菜單，改用目前
  已載入的全域 `allProducts`。

## 六、`unhandledRejection` 改為真實 FAIL

`scripts/smoke-h1-4-11-1-fixes.js`、`scripts/smoke-h1-4-11-2-fixes.js` 都在頂部註冊
`process.on('unhandledRejection', (e) => { unhandledRejectionSeen = e; })`，並在
`main().then(runBackendTests()).finally()` 內（所有 await 都已完成之後）改為：

```js
assert(!unhandledRejectionSeen, '...', ...);
```

只要偵測到任何未處理 rejection，這行 assertion 就會 FAIL，`printSummary()` 會把
`process.exitCode` 設為 1，不再只是印出 `[WARN]` 卻仍以 exit 0 結束。

## 七、`validateOrderConditions()` 測試描述修正

`scripts/smoke-h1-4-11-2-fixes.js` 的「三-10」原本的註解寫「對 next_service 指向的
日期呼叫真實 validateOrderConditions()」——這不準確，`validateOrderConditions()` 本身
未匯出，測試從未直接呼叫它。已修正為誠實描述：「直接呼叫 findNextServiceInfo() 與
validateOrderConditions() 共用的 getEffectiveModeSchedule()，確認兩者使用同一權威
排班來源」，assertion 名稱也同步更新。

## 八、完整測試執行紀錄

### 語法檢查

| 指令 | 結果 |
|---|---|
| `node --check routes/settings.js` | OK |
| `node --check routes/line-orders.js` | OK |
| `node --check public/js/app.js` | OK |
| `node --check scripts/smoke-h1-4-11-line-order-page-mode.js` | OK |
| `node --check scripts/smoke-h1-4-11-1-fixes.js` | OK |
| `node --check scripts/smoke-h1-4-11-2-fixes.js` | OK |

### H1.4.11 系列（含四種時區）

| 指令 | 結果 |
|---|---|
| `node scripts/smoke-h1-4-11-2-fixes.js`（預設／UTC／Asia/Taipei/Asia/Tokyo） | **84 PASS / 0 FAIL ×4** |
| `node scripts/smoke-h1-4-11-1-fixes.js`（預設／UTC／Asia/Taipei/Asia/Tokyo） | **80 PASS / 0 FAIL ×4** |
| `node scripts/smoke-h1-4-11-line-order-page-mode.js` | 66 PASS / 0 FAIL |

### 完整相關回歸

| 指令 | 結果 |
|---|---|
| `run-h1-4-9-checkout-order-summary-runtime.js` | 67 PASS / 0 FAIL |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111 PASS / 0 FAIL |
| `run-h1-4-10-phase1-liff-identity-runtime.js` | 68 PASS / 0 FAIL |
| `run-h1-4-10-required-friend-gate-runtime.js` | 98 PASS / 0 FAIL |
| `run-h1-4-10-asset-cache-bust-runtime.js` | 30 PASS / 0 FAIL |
| `run-h1-4-10-historical-backend-reconcile-runtime.js` | 35 PASS / 0 FAIL |
| `run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js` | 113 PASS / 0 FAIL |
| `run-h1-4-10-friend-live-runtime.js` | 24 PASS / 0 FAIL |
| `run-h1-4-10-friend-sec-mig-runtime.js` | 25 PASS / 0 FAIL |
| `run-h1-4-8-checkout-backend-unification-runtime.js` | 64 PASS / 0 FAIL |
| `smoke-delivery-distance-promotion.js` | 98 PASS / 0 FAIL |
| `smoke-delivery-free-progress.js` | 18 PASS / 0 FAIL |

## 九、f2／f7／cart-delivery-live-refresh 基準比對

與**未修改的 H1.4.11.2 基準版**（同一版本，非 H1.4.10）逐一比對：

| 測試 | 基準版 | 修改版 | 一致？ |
|---|---|---|---|
| `smoke-hotfix26-f2.js` | 22 PASS / 3 FAIL | 22 PASS / 3 FAIL | 失敗項目名稱逐一比對完全相同 |
| `smoke-hotfix26-f7.js` | 46 PASS / 1 FAIL | 46 PASS / 1 FAIL | 輸出逐字元相同（diff 為空） |
| `smoke-cart-delivery-live-refresh.js` | exit 1（`extractBlock()` 找不到舊起點標記） | exit 1（同一位置同一錯誤，僅路徑字串不同） | 一致 |

**中途修正記錄**：第一次重構後 f2 一度從 3 FAIL 增加為 4 FAIL（新增失敗項目「定時刷新
refreshShopStatus() 呼叫 refreshModeCutoffUI()」，因為
`renderMenu();refreshModeCutoffUI();updateModeAvailabilityUI();` 這個既有靜態比對的
字面相鄰順序被拆散）。已修正：購物車關閉的重量級路徑恢復這個原始相鄰呼叫順序（本身就是
正確的執行順序，只是把購物車商品快照同步移到這三行之後執行），修正後重新確認
f2 恢復 22 PASS / 3 FAIL，與基準版失敗項目逐一比對相同。

## 十、build_version 與 cache-bust

- `routes/line-orders.js`：`settings.build_version = 'H1.4.11.3'`。
- `public/index.html`：`<script src="/js/app.js?v=h1-4-11-3">`。
- 已確認全專案 `.html`/`.js` 內沒有殘留 `?v=h1-4-11-2`。
- 未修改 `server.js` 的既有 HTML no-cache 規則，未全面停用快取。

## 十一、`.env.example` 稽核結果

以 `rg`/`grep -rhoE "process\.env\.[A-Z_][A-Z0-9_]*"`（排除 `node_modules`）重新掃描，
比對 `.env.example` 現有 76 筆條目：**實際使用變數與 `.env.example` 條目完全一致**
（`comm` 雙向比對皆為空——沒有遺漏、沒有多餘）。所有範例值皆為空，不含任何 Secret/
Token/API Key 實值。確認 ZIP 內有 `.env.example`、沒有 `.env`。

## 十二、已知限制

1. `refreshDateSelectorForCart()` 維持空參數的函式宣告（用 `arguments[0]` 取值）以
   相容既有 `smoke-hotfix26-f2.js` 的靜態 regex；若日後這支舊測試被汰換，可以考慮
   改回具名參數以提升可讀性，但目前刻意保留這個相容寫法。
2. `today_not_open` 僅有三種 reason 分類（沿用 H1.4.11.2）。
3. `findNextServiceInfo()` 掃描上限 60 天（沿用 H1.4.11.2）。
4. f2／f7／cart-delivery-live-refresh 三支既有測試的基準版既有失敗維持原樣，未修改
   production 邏輯迎合過期斷言。
