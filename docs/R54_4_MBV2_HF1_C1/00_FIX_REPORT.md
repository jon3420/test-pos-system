# R54.4／MBV2-HF1-C1：舊購物車預購額度＋三分頁販售標示修正報告

> 本版有實際修改程式，標記為 **R54.4／MBV2-HF1-C1**。
> **重要：本輪實際開發基準是 MBV2，不是 HF1**（見第一節）。這是在 MBV2 上獨立完成的修正，
> 沒有沿用 HF1 的任何程式或「111 項通過」紀錄。

## 一、Reality Audit

### 1. 實際輸入版本

| 項目 | 需求指定 | 實際收到 |
|---|---|---|
| 檔名 | `P3CD_DEPLOY_R54_4_MBV2_HF1_PREORDER_CART_AND_PRODUCT_STATUS_FIX_FINAL_APP_ROOT.zip` | `P3CD_DEPLOY_R54_4_MBV2_MIGRATION_BACKUP_V2_FINAL_APP_ROOT.zip` |
| SHA-256 | `f933b06404cc8c6959e38b04c0dd044f44eabd9c26f31a11ef9360247a7afe6b` | `fdfb32359d1e221398a47b1ad97757b4345767789a38c04c2881635719856981` |
| `docs/R54_4_MBV2_HF1/*` | 應存在 | **不存在**（只有 `docs/R54_4_MBV2/`） |
| `scripts/smoke-r54-4-mbv2-hf1-preorder-status.js` | 應存在 | **不存在**，無法執行 |

所以「HF1 已處理哪些、還缺哪些」無法從程式核對。實際核對結果：MBV2 程式碼裡兩個問題都**還沒修**。
本輪的新測試在未修改的 MBV2 上跑，問題一與問題二的關鍵案例都失敗（見第四節）。

### 2. 問題一：涉及的檔案、函式與欄位

| 位置 | 原本行為（MBV2） |
|---|---|
| `restoreCart()` | localStorage 只還原 `id → qty`。`preorderRequiredIds` 只存在記憶體，重新整理就消失。日期用 `buildDateSelector()` 非強制版重建，存的是今天就會停在今天。 |
| `addCart()` | 依最新商品資料判斷 `sold_out_reason`／`can_next_day`，必要時轉 `addPreorderToCart()`；否則依 `#pDate` 選今日或預購額度。 |
| `addPreorderToCart()` | 自己檢查預購額度。 |
| `chgQty()` | **根因**：只看 `preorderRequiredIds` 或 `#pDate > 今天`，否則一律套今日 `line_quota`，出現「LINE 份數不足」。它不像 `addCart()` 會重新判斷商品是否已只能預購；也沒擋暫停／長期下架／不支援目前取餐方式／已下架商品。 |
| `refreshDateSelectorForCart()` | 開購物車、切換外帶／外送時，依最新商品資料重算 `needsNextDay`，並把日期改到下個營業日。這段邏輯本身正確，但只在購物車打開時才跑。 |
| `openProductDetail()` | `maxQty` 只在「有今日 quota 且非預購」時套今日份數；沒有扣掉購物車已有數量；明確選了未來日期時也還是套今日份數。 |
| `submitOrder()` | 直接送 `#pDate`，沒有檢查日期跟購物車內商品的額度類型是否一致。 |
| `routes/line-orders.js` POST `/` | `isPreorderOrder = pickup_date > 今天`。預購單驗證並扣 `line_preorder_*`，今日單驗證並扣 `line_quota_*`；交易內會重新讀商品並檢查 `sale_status`／上架／取餐方式開關。**後端行為正確，本輪沒有修改。** |

**是否存在「畫面用預購額度，送單卻送今日日期」？** MBV2 有可能：`chgQty()` 會因為 `preorderRequiredIds` 改用預購額度，
但日期要等購物車打開時的 `refreshDateSelectorForCart()` 才會對齊。如果購物車已經開著時商品才轉為只能預約，
`#pDate` 會停在今天直接送出。後端會以今日額度拒絕，所以不會扣錯，但畫面和送單不一致。
C1 在送單前加了檢查，並用測試 P1-27／P1-27a 驗證。

### 3. 問題二：狀態來源、優先順序、刷新流程

| 位置 | 原本行為（MBV2） |
|---|---|
| `calcLpmStatus()`（今日／預購分頁） | 只看 `show_on_line` 與份數／時段，**完全不讀 `sale_status`／`enabled`**。暫停商品照樣顯示「供應充足」或「可預購」。 |
| `renderLpmShippingTable()`（宅配） | 沒有任何販售狀態欄。 |
| `loadLineProductsPage()` | 不管目前在哪個分頁都呼叫 `renderLpmTable()`，所以在宅配分頁按「重新整理」只會更新隱藏的主表。 |
| `saveLineSettings()` | 儲存後只呼叫 `loadProductsPage()`，LINE 商品頁不會刷新。 |
| 欄數 | 主表表頭 14 欄，但載入中與錯誤列是 13 欄、空資料列是 14 欄；宅配表 11 欄。 |
| `sale_status` 適用範圍 | 只有 `routes/line-orders.js`（`/menu`、送單驗證）會讀。`routes/line-shipping.js` 完全不讀，宅配只看 `enabled`／`shipping_enabled`。 |
| `/api/products/line-products/list` | 只回傳 `enabled=1` 的商品，所以目前三分頁實際上不會出現已停用商品。解析器仍會處理 `enabled=0`。 |

## 二、修正內容

### 問題一（`public/line-order.html`）

1. 新增共用加購驗證 `resolveCartQuantityPolicy()`／`checkCartIncrement()`，只依三個來源判斷：
   **最新商品資料（allProducts）＋目前取餐方式＋購物車日期**。
   - 商品已只能預約下個營業日（條件跟 `refreshDateSelectorForCart()` 的 `needsNextDay` 相同），或明確選了未來日期 → 用預購額度（`line_preorder_*`）；預購不設限時不設上限。
   - 其他情況 → 用今日額度（`line_quota_*`）。
   - 上限會扣掉購物車已有的數量，提示文案會寫明是「今日」還是「預購」額度。
   - 暫停販售、長期下架、外帶外送都停用、`fulfillment_switcher` 下不支援目前取餐方式、商品已下架（不在 `allProducts`）→ 不准增加。
2. 首次加入（`addCart`）、預購加入（`addPreorderToCart`）、商品卡＋與購物車＋（`chgQty`）、商品詳情（`openProductDetail` 的上限與阻擋）全部改用同一份驗證。**減少／移除不經過這道驗證**，暫停或下架商品仍可減少。
3. `submitOrder()`：購物車有「只能預約下個營業日」的商品，日期卻不是未來日時，不送單，改為重新對齊日期／時段後停下來請顧客確認（記錄 `checkout_validation_failed`，reason 用既有白名單裡的 `inventory_unavailable`）。
4. 沒有清空 localStorage、沒有刪舊購物車、沒有寫死 20 份；沒有自動成立訂單或保留庫存；`_trackAddToCart` 呼叫次數不變。價格、運費、優惠券、付款、營業日曆、預購庫存模型和後端都沒動。

### 問題二（`public/js/app.js`、`public/index.html`）

1. 新增 `resolveLpmSaleMarker(p)`，三個分頁共用同一個解析。它只讀商品欄位、只負責顯示：
   `enabled=0`→已停用、`paused`→暫停販售、`sold_out_indefinitely`→長期下架、`sold_out_today`→今日完售。
2. 今日／預購分頁狀態的優先順序：**已停用 > 暫停販售 > 長期下架 > LINE 未上架 > 今日完售 > 各分頁份數／時段狀態**。
   今日分頁另外顯示 `line_sold_out`（LINE今日售完）；預購分頁維持原語意，不受這個旗標影響。
3. 冷藏宅配表新增「商品／LINE販售」欄（12 欄），表頭 title 寫明這是商品／LINE 點餐狀態，宅配能不能下單仍看「宅配啟用」。**沒有新增宅配停售規則。**
4. `loadLineProductsPage()` 依目前分頁渲染（`lpmRenderActiveTab()`），載入中與錯誤狀態同時寫入兩個表；`lpmSwitchTab()` 共用同一個渲染入口。
5. `saveLineSettings()` 儲存後，若 LINE 商品頁正在顯示，立即刷新目前分頁。冷藏宅配 Modal 儲存後，在 LINE 商品頁任何分頁都會刷新。
6. 欄數集中在 `LPM_MAIN_COLS=14`／`LPM_SHIP_COLS=12`，表頭、資料列、載入中、空資料、錯誤列一致。
7. `index.html` 的 `app.js?v=` 改成 `r54-4-mbv2-hf1-c1-1`，避免瀏覽器沿用舊快取。

## 三、修改／新增／刪除檔案

| 動作 | 檔案 |
|---|---|
| 修改 | `public/line-order.html` |
| 修改 | `public/js/app.js` |
| 修改 | `public/index.html`（宅配表頭新增一欄、colspan 11→12、app.js 快取版本） |
| 新增 | `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js`（真實 server.js＋暫存 DB＋真實 Chrome 驗收） |
| 新增 | `scripts/lib/hf1c1-maps-mock.js`（只給測試子程序 `node -r` 用：Google Routes 固定回應 2 公里，其餘外部網址一律拒絕；正式部署不會載入） |
| 新增 | `docs/R54_4_MBV2_HF1_C1/00_FIX_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json` |
| 刪除 | 無 |
| 未修改 | `routes/line-orders.js`、`routes/products.js`、`routes/line-shipping.js`（已核對，後端行為正確） |

## 四、本次實際執行的測試

詳見 `01_TEST_RESULTS.json`。以下全部是本輪實際執行的結果，不含前人報告的數字。

### 1. 新增驗收：`scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js`

測試環境：真實 `server.js` 子程序，使用 `os.tmpdir()` 下的暫存 SQLite（以 `mbv2-seed` 建立 store_001／密碼登入），搭配真實 Google Chrome（Playwright）。
訂單透過正式路由 `POST /api/line-orders` 送出，再讀暫存 DB 核對 `line_quota_sold`／`line_preorder_sold`。

| 版本 | 結果 |
|---|---|
| **C1（本版）** | **60 通過／0 失敗** |
| 原始 MBV2（同一支測試） | **30 通過／31 失敗**：P1-2「舊購物車＋」、P1-25 預購不設限、P2-1 外送預購、S2-0～S2-6 三分頁標示、S2-10～13 欄數等都失敗，證明這支測試抓得到原問題 |

涵蓋的驗收案例：
- 1～2：今日 1 份＋預購 20 份＋舊購物車 1 份 → 可加到 2 份、加到 20 份，第 21 份被擋，文案指向預購額度。
- 3：今日單受 1 份限制。
- 4：預購不設限。
- 5：預購額度已滿。
- 6：重新整理後數量保留，且不錯用今日額度。
- 7：外帶／外送切換，以及 combined_checkout／fulfillment_switcher。
- 8：商品卡、購物車、商品詳情三處上限一致。
- 9：送單日期與扣除的額度一致（今日單扣今日額度、預購單扣預購額度）。
- 10、12：三分頁依序經過暫停 → 長期下架 → 今日完售 → 正常，渲染時沒有任何寫入。
- 11：暫停／長期下架時仍可減少與移除。
- 13：每次＋只送出 1 筆 add_to_cart，不會自動建立訂單。
- 另含：送單日期防呆、表頭與各狀態列欄數、後台與點餐頁都沒有 JavaScript 錯誤。

### 2. 既有回歸（61 支，與本次變更相關：讀 line-order.html／LINE 商品管理／MBV2）

原始 MBV2 與 C1 各跑一次，比較方式如下：
- 結束碼要相同。
- 每支測試的最後摘要行要相同。
- 有失敗的測試，逐條比對失敗項目名稱。

結果：

- **新增失敗：0。**
- C1 修改過程中曾讓 `static-audit-g1-6-ga4-h1-4-6.js` 多出 1 項失敗：它的 regex 要求 `const blocked =`。
  已改寫成保留 `const blocked`、另用 `detailBlocked` 疊加，回到與原版相同的 3 項失敗。這是寫法調整，沒有放寬任何斷言。
- 原版就失敗、C1 失敗項目完全相同的測試（原有失敗，未修改、未刪除）：
  `mbv2-rescue-verify`（缺參數，exit 2）、`run-g1-6-ga4-h1-4-4-view-item-runtime`、`smoke-cart-delivery-live-refresh`、
  `smoke-h1-4-12-popup-admin-ui-browser`（`LINK-published-urls-use-public-code` 兩版每次都失敗；另一項 `BR51-cancel-ui-removes-full-badge` 在 C1 的 4 次執行中有 2 次失敗、2 次通過，它已列在專案 `regression_flaky_note.txt`，是與日期時間相關的既有不穩定項，而且屬於 C1 沒有修改的快閃場次 UI）、`smoke-hotfix26-b`、`smoke-hotfix26-d`（舊網域字串）、`smoke-hotfix26-f2`（22/28）、
  `smoke-hotfix26-f7`（46/47）、`smoke-hotfix26-f8-b`、`smoke-hotfix26-i`、`smoke-hotfix27-cd`（51/52）、
  `smoke-hotfix29`／`29-b`／`29-c`（串接舊測試）、`smoke-r48-popup-order-ui-browser`、
  `static-audit-g1-6-ga4-h1-4-6`（3）、`static-audit-g1-6-ga4-h1-4-7`（4）。
- `static-audit-r48-popup-order-ui`：比對 R48 凍結版位元組雜湊。原版就已經不相等（FAIL），C1 修改 line-order.html 後雜湊值不同，但狀態一樣是 FAIL。
- MBV2 相關：`run-r54-4-mbv2-ui`（真實瀏覽器 19/19）、`smoke-r54-4-mbv2-migration`、`smoke-r54-4-mbv2-large-upload`、`smoke-r54-4-mbv2-system-regression` 在兩版都通過。
- 快閃：`smoke-h1-4-12-popup-*`（含真實瀏覽器 36/36）在兩版結果一致。
- `run-regression-g1-6-ga4-h1-4-6`／`-4-7` 兩個大型串接套件在 240 秒限制下兩版都逾時，另外用 1500 秒限制重跑，兩版失敗的子套件相同：
  H1 Static Audit、H1 Targeted Smoke、H1.4.4、H1.4.6（另外 4-7 還有 H1.4.7 Static Audit）。`B1-6 Geo Explorer` 在兩版各有一輪出現，屬於不穩定項。
  4-6：兩版每輪都是 FAIL=5。4-7：原版各輪 8／9／9，C1 各輪 9／9／9。

### 3. 未驗證項目（環境限制，需真機補驗）

- LINE App 內建瀏覽器／LIFF 真機（本輪用桌面 Chrome 模擬行動視窗）。
- 正式 Google Maps 外送距離：本輪用 mock 固定 2 公里；地址自動完成沒有驗證。
- 真實 LINE Pay 付款（本輪只驗證現金付款送單）。
- Zeabur 正式環境部署與正式資料庫。

## 五、部署後最短驗收

1. 後台 → LINE 商品管理：找一個測試商品，把今日份數設 1、預購份數設 20，確認今日分頁顯示份數狀態。
2. 用手機 LINE 開點餐頁加入 1 份但不結帳。後台把該商品今日已售改成 1（或等今日售完）。重新開點餐頁按商品卡「＋」，應能加到 2 份；打開購物車時日期自動變成下個營業日。
3. 送出測試單（現金）：後台該商品**預購已售**增加、**今日已售**不變。之後取消測試單。
4. 商品管理把該商品改為「暫停販售」：今日／預購／冷藏宅配三分頁都顯示「暫停販售」；點餐頁舊購物車「＋」被擋，「−」可以用。
5. 改回「正常販售」：三分頁回到份數狀態，沒有殘留標籤。

## 六、回退步驟

本版沒有資料庫結構變更，也沒有新增資料欄位，可以直接回退：
1. 重新部署上一版 ZIP（MBV2：`fdfb3235…9856981`）。
2. 不需要還原資料庫，C1 不寫入任何新欄位。
3. 回退後請顧客重新整理頁面：舊版 `app.js?v=r54-4-mbv2-1` 會重新載入。
