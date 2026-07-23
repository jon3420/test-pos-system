# CHANGELOG — fix18-10-hotfix30-B5-R5

## Cart Detail × Accurate Cart Snapshot × Order Hour Analysis

日期：2026-07-23
基礎版本：fix18-10-hotfix30-C5-remove-legacy-free-rule-fix-discount-display-full（Hotfix30-B5-R4 之後）

---

## 一、修改摘要

本版在既有老闆儀表板（`GET /api/analytics/dashboard`）之上，新增兩個獨立但互補的功能區塊，
**不建立第二套 Analytics 系統**，全部沿用既有 `analytics_events` 表、既有 `store_id` 隔離慣例、
既有 `utils/dashboardDate.js` 日期範圍解析、既有 `utils/channelResolver.js` 渠道判斷：

1. **Accurate Cart Snapshot（準確購物車快照）**
   購物車每次內容變動時，記錄一筆 `cart_updated` 事件，內含完整快照（商品名稱／數量／
   當下單價／小計／優惠折抵／外送費／總計／取餐模式），取代舊版單純加總
   `add_to_cart.quantity` 的估算法。新增「目前未完成購物車」清單與詳情 Modal，供老闆
   逐筆查看每個未完成購物車的內容、身分、來源、最後階段、放置時間與狀態。

2. **Order Hour Analysis（訂單時段分析）**
   在既有 Dashboard API 中新增 `order_hour_analysis`（24 小時完整資料、生意最多時段、
   餐飲時段摘要）與 `order_period_analysis`，統計口徑為「訂單成立時間」（Asia/Taipei），
   只計算有效訂單（排除作廢／取消），沿用既有 channel／日期篩選。

---

## 二、修改檔案清單

### 後端
- `utils/cartSnapshot.js`（新增）— 購物車快照解析、開放購物車清單、購物車詳情/Timeline、
  metadata 白名單 sanitizer
- `utils/dashboardAnalytics.js` — 新增 `getOrderHourAnalysis()`、`getOrderPeriodAnalysis()`
- `utils/analyticsLog.js` — event 白名單新增 `cart_updated`、`cart_restored`
- `utils/db.js` — 新增兩個索引：`orders(store_id, created_at)`、
  `analytics_events(store_id, cart_id, created_at)`（皆為 `CREATE INDEX IF NOT EXISTS`，
  不修改任何既有欄位或資料表）
- `routes/analytics.js` — `POST /events` 接上 cart 快照 sanitizer；`GET /dashboard` 新增
  `cart.current_open_summary`、`order_hour_analysis`、`order_period_analysis`；新增
  `GET /cart-abandonment`、`GET /cart-abandonment/:cartId`

### 前端
- `public/js/app.js` — `formatDuration()`、渠道篩選 UI、未完成購物車明細表格與 KPI、
  購物車詳情 Modal、訂單時段分析 KPI／圖表／餐飲時段摘要、購物車分析卡片文案更新
- `public/line-order.html` — 購物車快照追蹤核心（`_buildCartTrackingMetadata`／
  `_trackCartUpdated`／`_scheduleCartUpdatedTrack`／`_trackCartUpdatedImmediate`），
  接上 `persistCart()`／`clearCartByUser()`／`restoreCart()`
- `public/line-shipping.html` — 同上（冷藏宅配版本，`order_mode` 固定為 `shipping`）

### 測試（新增）
- `scripts/smoke-hotfix30-b5-r5-cart-order-hours.js` — Cart R5-1~12、Hour R5-1~9、
  sanitizer／limit／store 隔離／estimated fallback／損壞 JSON
- `scripts/smoke-hotfix30-b5-r5-debounce.js` — Debounce R5-1~5、呼叫順序稽核
- `scripts/smoke-hotfix30-b5-r5-dashboard-ui.js` — 前端 runtime smoke（jsdom 實際執行
  `public/js/app.js`，非僅語法檢查）

---

## 三、cart_updated / cart_restored 事件設計

### 觸發時機與分派方式

| 情境 | 事件 | 分派方式 |
|---|---|---|
| 加入商品／增減數量／套用優惠券／移除優惠券／切換取餐模式／外送費重算 | `cart_updated` | **600ms trailing debounce**（`_scheduleCartUpdatedTrack()`） |
| 使用者主動清空購物車 | `cart_updated`，`metadata.status='cleared'` | **立即送出**（`_trackCartUpdatedImmediate()`），會先取消任何等待中的 debounce |
| 頁面重新整理／同瀏覽器重新進站，購物車內容有效 | `cart_restored` | **立即送出**，同樣會先取消 pending debounce |
| 還原時因商品下架或優惠券失效被系統自動移除 | 額外一筆 `cart_updated`，帶 `metadata.correction_reason` | **立即送出**，緊接在 `cart_restored` 之後 |

### 為什麼需要 debounce + immediate 兩種分派

一般性 `cart_updated`（加減數量等）用 600ms trailing debounce：快速連續點擊 +/- 只會在停止
操作 600ms 後送出**最終**狀態一筆事件，不會遺失最終快照，也不會因為快速操作洪水式產生
大量事件。`cleared`／`cart_restored`／校正事件語意上都是「這一刻發生的明確事件」，
必須立即送出且不能被稍後才觸發的舊 debounce 蓋過去——因此這三種情況呼叫
`_trackCartUpdatedImmediate()`，內部會先 `clearTimeout()` 任何等待中的一般性 debounce，
確保事件依照真實發生順序被記錄，不會發生「舊的排隊快照事後蓋掉新的明確事件」。

已用 `scripts/smoke-hotfix30-b5-r5-debounce.js`（32/32 PASS）以假時鐘（非真實等待
600ms）驗證：
- 連續 qty 1→2→3 最終只送出 1 筆、qty=3 的快照（Debounce R5-1）
- 修改後、600ms 未到就清空 → pending 被取消，只留下 1 筆 `cleared` 事件（R5-2）
- 修改後、600ms 未到就 restore → pending 被取消，正確送出 `cart_restored`（R5-3）
- 單純 restore、內容未變 → 只有 1 筆 `cart_restored`，隨後的 debounce 因內容相同被
  去重擋下，不會多送一筆多餘的 `cart_updated`（R5-4）
- restore 後因售完/優惠券失效被校正 → 先 `cart_restored`、再 1 筆帶
  `correction_reason` 的 `cart_updated`（R5-5）
- 額外以原始碼字串位置稽核 `persistCart()`／`clearCartByUser()`／`restoreCart()`
  三個函式的實際呼叫順序（不是靠假設），確認 `cleared` 在 `_resetCartId()` 之前送出、
  `cart_restored` 在結尾 `persistCart()` 之前送出、`restoreCart()` 全程未呼叫
  `_trackAddToCart()`

### correction_reason 與系統自動校正 Timeline

`sanitizeCartSnapshotMetadata()` 新增選填欄位 `correction_reason`（白名單、長度上限 80
字元）。購物車詳情 Timeline（`getCartDetail()`）看到帶 `correction_reason` 的
`cart_updated` 時，顯示為「**購物車內容校正（系統自動）**」，跟單純的「重新開啟購物車」
（`cart_restored`）與一般的「購物車內容更新」明確區分，方便老闆判斷這筆變動是使用者自己
改的、系統自動恢復的、還是系統自動校正的。

### cart_restored 不增加 add_to_cart 人數

`getCartAnalysis()`／`getFunnel()` 的「加入購物車人數」只統計 `event_name='add_to_cart'`
的事件，`cart_restored` 是獨立事件名稱，不會被計入。已用真實資料驗證：同一購物車在
`cart_restored` 前後，`add_to_cart_visitors` 與漏斗 `add_to_cart` 事件數完全不變
（Cart R5-7 / reload 不重複增加購物車）。

### cleared／purchased 後不得沿用舊 cart_id

- 清空：`clearCartByUser()` 在送出 `cleared` 快照之後才呼叫 `clearCartStorage()`
  （內部呼叫 `_resetCartId()`），下次加入商品時 `_getCartId(true)` 會產生全新 cart_id。
- 完成訂單：既有付款成功流程本來就會呼叫 `clearCartStorage()`（本版未變動這段邏輯），
  同樣確保下一台購物車使用新的 cart_id。
- 後端：`purchased`／`status='cleared'` 的購物車一律從「目前未完成購物車」清單移除
  （`getOpenCartRows()`），不會被誤判為仍在進行中。

---

## 四、資料口徑（新資料 vs 舊資料）

| 項目 | 新資料（有 `cart_updated` 快照） | 舊資料（只有 `add_to_cart`，無快照） |
|---|---|---|
| 資料來源 | 最新一筆 `cart_updated`／`cart_restored` 快照 | `SUM(add_to_cart.quantity) - SUM(remove_from_cart.quantity)`，單價取「目前」`products.price` 回推 |
| `estimated` 欄位 | `false` | `true` |
| UI 顯示 | 不顯示估計警告 | 顯示「舊資料估計」標記 |
| 商品單價 | 事件寫入當下凍結的單價（不隨後續調價變動） | 用目前商品售價回推（可能與實際歷史單價不同） |

**「目前未完成商品金額」不等於損失營業額**：可能不包含最終確認的外送費、折扣或優惠券
（尤其是舊資料回退估算時，只有商品金額，UI 標示「商品估計金額」）。這是既有需求文件
明確要求的揭露，非本版新增限制。

---

## 五、API

### `GET /api/analytics/cart-abandonment`
- 權限：`requireStore`（登入驗證）+ `requireFeature('reports')`
- Query：`status`（all/active/checkout/abandoned）、`age_bucket`（all/30m/30m_1h/1h_24h/
  1d_3d/3d_7d/7d_plus）、`identity`（all/line/visitor）、`order_mode`（all/takeout/
  delivery/shipping）、`page`（≥1）、`limit`（1~100，超過 100 強制夾到 100）
- 回應：`current_open_summary`（`open_carts`／`open_amount`／`over_24h`／
  `line_identified`，獨立於「所選期間」，統計最近 30 天內仍未完成的購物車）、
  分頁後的 `rows`（每列含 `estimated` 欄位、`line_uid_masked` 遮罩、`cart_id_short`
  短碼）
- 隔離：`store_id` 一律取自 `req.storeId`（由 `requireStore` 從已驗證的 JWT／
  x-store-id／query 解析並驗證店家存在且啟用），不接受前端另外指定查詢範圍以外的
  store_id

### `GET /api/analytics/cart-abandonment/:cartId`
- 權限同上
- `cartId` 經過長度截斷（200 字元）與參數化查詢，查無資料回傳 404（不是 500），
  且查詢一律以 `store_id + cart_id` 同時比對，不同店家相同 `cart_id` 無法互讀
  （見 Cart R5-10 測試）
- 回應含完整事件 Timeline（中文事件名稱）、`estimated` 標記、`other_device_cart_count`
  （同一 LINE 會員在其他裝置的購物車數量提示，內容不合併）

### `GET /api/analytics/dashboard`（既有端點，新增欄位）
- 新增：`cart.current_open_summary`、`order_hour_analysis`、`order_period_analysis`
- 既有欄位（`kpi`／`funnel`／`cart`／`products`／`payments`／`analytics_v2`… 等）
  **完全保留，未刪除或改變結構**
- `channel` 篩選沿用既有 `ORDER_CHANNELS`（pos/line_takeout/line_delivery/shipping/
  reservation），套用到 `order_hour_analysis` 與 `order_period_analysis`

---

## 六、Asia/Taipei 時區處理

- `orders.created_at` 本身在應用層寫入時就已是 Asia/Taipei 本地時間字串，
  `getOrderHourAnalysis()` 直接用 `strftime('%H', created_at)` 取小時，**不再額外
  +8 小時**（沿用既有 `getKpi()` 的處理方式，未新創第二套換算邏輯）。
- `analytics_events.created_at` 是 UTC 字串，購物車相關查詢一律透過既有
  `ANALYTICS_CREATED_AT_LOCAL_EXPR`（`datetime(created_at,'+8 hours')`）換算，
  沒有新增獨立的時區換算邏輯。
- 已用 Hour R5-1 驗證台灣時間 18:30 建立的訂單正確歸入 18:00–18:59，不會因 UTC
  誤差被歸到 10:00。

---

## 七、測試結果

### R5 專屬測試
| 測試檔案 | 結果 |
|---|---|
| `scripts/smoke-hotfix30-b5-r5-cart-order-hours.js` | **55/55 PASS**（另有 4 項 UI 視覺相關 MANUAL REQUIRED），exit 0 |
| `scripts/smoke-hotfix30-b5-r5-debounce.js` | **32/32 PASS**，exit 0 |
| `scripts/smoke-hotfix30-b5-r5-dashboard-ui.js` | **20/20 PASS**，exit 0 |

R5 Regression：**0**（本次修改沒有讓既有 regression 從 PASS 變成 FAIL）

### 既有 Regression Baseline（29 支既有 smoke script 全部執行）
- **16 支 PASS**
- **12 支 PRE-EXISTING FAILURE**
- **1 支 PRE-EXISTING TIMEOUT**（`smoke-hotfix29-c.js`）

每一支 FAIL／TIMEOUT 都已個別與 pristine original ZIP（未經本次修改的版本）逐行比對
（數字/PID 正規化後 `diff` 結果為 0，或僅有無關的即時時間戳差異），確認：
- 12 支 FAIL 在 original 與本版**結果完全相同**（同樣的 exit code、同樣的第一個失敗點），
  屬於既有問題（LINE 好友狀態文案、截止時間判斷、DOM mock 相容性、LINE Login Channel ID
  設定檢查等），與本次 Cart/Order Hours 功能無關，**不是 R5 Regression**
- `smoke-hotfix29-c.js` 的 timeout 經原始碼確認為巢狀 meta-regression 架構
  （`execFileSync(..., {timeout:180000})` 依序重跑 4 支其他 smoke script，任一支變慢
  即可能讓總時間超過外層測試的等待時間），original 與本版同樣在相同位置 timeout，
  屬於**既有架構限制，不是 R5 Regression**
- `smoke-hotfix29.js`：original 與本版皆 exit 1（6/12 個子腳本 exit 0），結果一致
- `smoke-hotfix29-c2-migration-upload.js`：62/63 PASS，1 項 MANUAL REQUIRED
  （Zeabur／上游 reverse proxy body size 限制需部署後人工實測，非本版程式碼問題）
- `smoke-hotfix26-verify-deep.js` 的 log 差異僅為一行即時 HTTP 回應標頭時間戳
  （非功能性差異）

---

## 八、安全稽核

| 項目 | 結論 |
|---|---|
| `POST /events`／`GET /dashboard`／`GET /cart-abandonment`／`GET /cart-abandonment/:cartId` 皆掛在 `requireStore` 之下（登入驗證 + store 存在/啟用驗證） | PASS |
| 兩個新端點額外掛 `requireFeature('reports')` | PASS |
| `GET /dashboard` 本身沒有 `requireFeature('reports')` 閘門 | **PASS WITH KNOWN LIMITATION** — 這是既有行為（pristine original 即是如此），本版未新增也未修補此既有缺口，超出本次範圍 |
| `store_id` 一律來自 `req.storeId`（`requireStore` 解析自 JWT／x-store-id／query，並驗證店家存在且啟用） | PASS — 與專案其他既有 Analytics 端點採用相同信任模型，非本版新增風險 |
| cart detail 查詢同時比對 `store_id + cart_id`，不同店相同 cart_id 無法互讀 | PASS（Cart R5-10 驗證） |
| `limit` 最大值 100，非法 page/limit 有安全預設 | PASS |
| API 錯誤只回傳 `message`，不回傳 `stack` | PASS |
| 新增欄位不刪除／不改變既有欄位結構 | PASS |
| 所有 SQL 皆為參數化查詢，購物車/商品/會員批次查詢皆含 `store_id` | PASS（12/12 cartSnapshot.js 查詢逐一檢查） |
| metadata JSON parse 全部包在 try/catch，損壞 JSON 不會造成 API 500（Cart R5-12 驗證） | PASS |
| 舊資料回退估算查詢商品價格時同樣以 `store_id` 限定，不會跨店取商品 | PASS |
| sanitizer 白名單只允許 items/subtotal/discount/delivery_fee/total/order_mode/item_count/status/attempt_id/previous_attempt_id/checkout_stage/browser_environment/attribution_reference/correction_reason，其餘欄位（含 access_token/id_token 等）一律不寫入 | PASS |
| LINE UID 預設遮罩（`maskLineUserId`），`includeFullUid` 目前所有呼叫端皆為 `false` | PASS |
| visitor_id／cart_id 前端顯示一律短碼（`shortId()`） | PASS |
| 前端輸出（商品名稱／顧客名稱／campaign／source／Timeline label）皆經 `escHtml()` | PASS |
| Modal 內容全部經 escape 後才組字串插入 `innerHTML` | PASS |
| `openCartDetailModal()` 的 `cart_id` 僅做單引號逸出，未做完整 HTML attribute escape | **PASS WITH KNOWN LIMITATION** — `cart_id` 為系統內部產生的識別碼（`c_timestamp_random`），非使用者可自由輸入的欄位，目前無可利用途徑；建議未來一併改用完整 escape 作為深度防禦 |
| Analytics 寫入失敗（`insertEvent` 內部 try/catch）不影響購物車操作或下單流程 | PASS（fail-open，多處驗證） |
| 無未捕捉 Promise rejection（`smoke-hotfix30-b5-r5-dashboard-ui.js` 驗證） | PASS |

**安全稽核結論：PASS WITH KNOWN LIMITATION**（兩項既有限制，皆非本版引入，詳見上表）

---

## 九、效能稽核

| 項目 | 結論 |
|---|---|
| `getOpenCartRows()` 全部採批次 `IN (...)` 查詢（候選 cart／最新 snapshot／首次加入時間／首筆事件／最後事件／舊資料商品明細／商品資訊／會員名稱），無逐 cart 查詢 | PASS |
| 商品／會員批次查詢皆含 `store_id` | PASS |
| 分頁（`page`/`limit`）目前在**應用層**進行（批次取得候選購物車後於 JS 端篩選/切頁），不是 SQL `LIMIT/OFFSET` | **PASS WITH KNOWN LIMITATION** — 已於程式註解明確揭露；在單店 30 天內未完成購物車量級（典型餐飲/電商規模）下效能無虞，極端高流量店家未來可再優化為 SQL 層分頁 |
| `limit` 上限 100，避免單次回應過大 | PASS |
| 購物車詳情查詢範圍限定 `store_id + cart_id`，不會載入整店事件 | PASS |
| Timeline 沒有額外的事件數量上限（依賴單一購物車事件量天然有限，通常數十筆內） | **PASS WITH KNOWN LIMITATION** |
| metadata JSON 每筆事件只 parse 一次，沒有重複解析 | PASS |
| `getOrderHourAnalysis()` 用 2 次 SQL（`GROUP BY hour` + 總計）取得全部資料，不逐訂單查詢 | PASS |
| 固定回傳 24 rows（`Array.from({length:24})`） | PASS |
| Asia/Taipei 判斷沿用既有 `orders.created_at` 本地字串慣例／既有 `ANALYTICS_CREATED_AT_LOCAL_EXPR`，未新增獨立換算邏輯 | PASS |
| channel／日期篩選重用既有 `_channelWhereClause`／`resolveDateRange`，非另寫一套 | PASS |
| 作廢／取消訂單在 SQL `WHERE` 層排除（`ORDERS_BASE_WHERE`） | PASS |
| 索引：`orders(store_id, created_at)`、`analytics_events(store_id, cart_id, created_at)` 皆已建立且非重複建立（`CREATE INDEX IF NOT EXISTS`，`PRAGMA index_list` 驗證無重名） | PASS |
| 既有 `idx_analytics_store_cart (store_id, cart_id)` 與新索引 `(store_id, cart_id, created_at)` 有欄位前綴重疊 | **PASS WITH KNOWN LIMITATION** — 非完全重複索引（欄位數不同），保留舊索引是為了不變動既有查詢路徑，非本版錯誤 |
| 日期／channel 切換透過 `innerHTML` 整段重繪，不使用 `addEventListener` 疊加（皆為 inline `onclick`），不會重複綁定 listener | PASS |
| Modal 每次開啟先 `closeCartDetailModal()` 移除舊 Modal 才建立新的，不會累積 | PASS |
| 圖表（訂單時段長條圖）為 CSS/DIV 實作，非 canvas 圖表函式庫，切換 metric 用 `outerHTML` 整段替換，沒有需要額外清理的圖表物件 | PASS |
| Dashboard 未完成購物車清單為單一批次 API，不逐列另發 API | PASS |
| 分頁僅請求當前頁（`page`/`limit` 帶入查詢字串） | PASS |
| 600ms debounce 保留最終快照、restore／clear immediate 會取消 pending timer | PASS（Debounce R5-1~5 驗證） |

**效能稽核結論：PASS WITH KNOWN LIMITATION**（分頁與 Timeline 上限為應用層設計取捨，
已於程式碼與本文件明確揭露，非隱藏風險）

---

## 十、Known Limitations（已知限制）

1. 舊資料（無 `cart_updated` 快照）一律標示 `estimated=true`，商品單價為目前售價回推，
   可能與歷史實際單價不同——這是資料本質限制，非程式錯誤。
2. IP／地理區域分析（Geo Analytics）不在本版範圍。
3. LINE Checkout Funnel 完整功能不在本版範圍；本版僅預留 `attempt_id`／
   `checkout_stage`／`browser_environment`／`attribution_reference` 等選填欄位供未來擴充。
4. `public/js/app.js` 存在既有重複宣告的 `function escHtml`（第二個定義覆蓋第一個）——
   已確認 pristine original 版本本來就存在此重複，非本版引入，不影響 runtime（JS 允許
   同名函式宣告，後者覆蓋前者，兩個定義行為等價），本版未重構此既有問題。
5. 既有 regression baseline 本身有 12 支 FAIL＋1 支 TIMEOUT（詳見第七節），皆與
   pristine original 比對結果一致，非本版引入。
6. `smoke-hotfix29-c2-migration-upload.js` 有 1 項 MANUAL REQUIRED（Zeabur／上游
   reverse proxy 的 body size 限制需部署後人工以真實檔案驗證）。
7. 未完成購物車清單分頁在應用層而非 SQL 層（見效能稽核）；Timeline 無額外事件數上限。
8. `cart_id` 在前端 onclick 屬性中僅做單引號逸出，未做完整 HTML attribute escape
   （見安全稽核）。
9. UI R5-1～R5-4（實際手機/平板/桌面視覺呈現、真實瀏覽器渲染效果）為 MANUAL REQUIRED，
   已用 jsdom runtime smoke 驗證 DOM 結構與函式執行邏輯，但無法取代真實瀏覽器/真機測試。

---

## 十一、回滾方式

1. 還原本次修改的檔案即可完全回滾功能本身：
   `utils/cartSnapshot.js`（刪除此檔案）、`utils/dashboardAnalytics.js`、
   `utils/analyticsLog.js`、`utils/db.js`、`routes/analytics.js`、`public/js/app.js`、
   `public/line-order.html`、`public/line-shipping.html`。
2. **新增的兩個資料庫索引可安全保留**，不需要回滾——它們是純粹的查詢加速結構
   （`CREATE INDEX IF NOT EXISTS`），不影響任何既有資料或查詢結果，即使回滾程式碼本身
   也不需要一併移除索引。
3. **新的 `cart_updated`／`cart_restored` 事件不影響舊資料讀取**——回滾後，既有的
   `getCartAnalysis()`（期間轉換口徑）等既有函式邏輯完全不變，繼續正常運作；即使
   資料庫裡已經累積了新版寫入的 `cart_updated`／`cart_restored` 事件，舊版程式碼也
   只是不會讀取/使用這些事件，不會因為它們的存在而出錯或影響既有功能。
4. **不需要刪除任何資料表欄位**——本版完全沒有修改既有欄位，只在既有
   `analytics_events.metadata_json` 欄位裡存放新的 JSON 結構。
5. **回滾前務必備份正式資料庫**，這是所有資料庫變更（即使是安全的索引新增）的標準
   作業程序，並非本版特有風險。
