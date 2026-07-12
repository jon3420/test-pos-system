# CHANGELOG — fix18-10-hotfix23-A｜Analytics Foundation

基礎版本：fix18-10-hotfix22-F（LINE 外帶外送宅配購物車永久保留 × 模式關閉不自動切換 × 商品卡狀態辨識）

本階段只完成 **Hotfix23-A（Analytics Foundation）**，Hotfix23-B/C/D 尚未開始。

---

## 1. Root Cause / 架構說明

目標：在不重寫既有報表系統、不破壞既有訂單/付款/購物車流程的前提下，建立前台轉換事件收集
的基礎建設，供未來 Hotfix23-B（老闆儀表板日期系統）與 Hotfix23-C（Conversion Analytics）使用。

核心設計原則：

1. **全新獨立資料表**（`analytics_events`），只用 `CREATE TABLE IF NOT EXISTS` /
   `CREATE INDEX IF NOT EXISTS`，不動既有 `orders`、`products` 等資料表結構。
2. **前端不可信任**：`submit_order` 與 `purchase` 這兩個「代表金流／成交」的事件，一律由後端
   在訂單真正建立成功 / 付款真正確認成功時才寫入；前台一般事件端點 `POST /api/analytics/events`
   明確拒絕（403）這兩種事件名稱，不論前端如何偽造請求內容。
3. **識別碼沿用 Hotfix22-F 架構**：`visitor_id`（localStorage）／`session_id`（sessionStorage）
   維持原有機制，只補上 `_${store_id}` 後綴避免同一瀏覽器逛多家店時互相污染；`cart_id` 是本階段
   新增的第三個識別碼，購物車第一次有商品時建立，訂單成立或使用者清空購物車後重建。
4. **後端不信任前端傳來的訂單金額 / 付款狀態**：analytics 的 `visitor_id/session_id/cart_id/UTM`
   欄位屬於「純追蹤資訊」，不參與任何金額計算或付款判斷，即使前端偽造也不影響訂單正確性——
   訂單金額/份數/付款方式驗證邏輯完全未變動。
5. **purchase 防重複兩層防線**：(a) `logServerEvent()` 在寫入前先同步查詢是否已存在同一
   `store_id + order_id + event_name`，Node.js 單執行緒特性保證查重與寫入之間不會被其他請求
   插入；(b) `analytics_events` 額外建立 partial UNIQUE INDEX 作為資料庫層級的最後防線。

---

## 2. 修改檔案清單

### 新增檔案
- `utils/analyticsLog.js` — 共用事件寫入 / 查重 / 驗證工具（前後端共用核心邏輯）
- `routes/analytics.js` — `POST /api/analytics/events` 前台事件收集端點
- `CHANGELOG_HOTFIX23_A_ANALYTICS_FOUNDATION.md`（本檔案）

### 修改檔案
- `utils/db.js` — 新增 `analytics_events` 資料表 + 8 個索引（含 1 個 partial unique index）
- `server.js` — 掛載 `/api/analytics` 路由（`requireStore` middleware）
- `routes/line-orders.js` — 訂單建立成功後寫入 `submit_order`；非 LINE Pay 訂單額外寫入 `purchase`
- `routes/line-shipping.js` — 同上邏輯，`order_mode='shipping'`
- `routes/linepay.js` — `/api/linepay/confirm` 付款成功後寫入 `purchase`（讀取訂單建立時的
  `submit_order` 事件取得追蹤欄位，因為 `/request`、`/confirm` 本身收不到 visitor/session）
- `public/line-order.html` — 前台事件追蹤（見第 6 節）+ store-scoped visitor/session id +
  cart_id 生命週期管理
- `public/line-shipping.html` — 同上（冷藏宅配版本）

### 未修改（依需求文件明確排除）
- Android（完全未觸碰任何 Android 相關檔案）
- 既有報表系統 / 老闆儀表板（`routes/dashboard.js` 未修改）
- POS、優惠券、Business Calendar、LINE 預購管理、AI 行銷中心

---

## 3. analytics_events Schema

```sql
CREATE TABLE IF NOT EXISTS analytics_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  store_id        TEXT NOT NULL,
  visitor_id      TEXT NOT NULL,
  session_id      TEXT NOT NULL,
  cart_id         TEXT,
  order_id        TEXT,
  event_name      TEXT NOT NULL,
  product_id      INTEGER,
  quantity        INTEGER DEFAULT 1,
  order_mode      TEXT,
  source          TEXT,
  medium          TEXT,
  campaign        TEXT,
  referrer        TEXT,
  landing_page    TEXT,
  fbclid          TEXT,
  gclid           TEXT,
  metadata_json   TEXT,
  created_at      TEXT DEFAULT (datetime('now'))
);
```

`created_at` 一律由資料庫產生，`routes/analytics.js` 不接受前端指定的建立時間。

---

## 4. 索引清單（共 8 個）

| 索引名稱 | 欄位 | 用途 |
|---|---|---|
| `idx_analytics_store_created` | `store_id, created_at` | 依店家 + 時間範圍查詢 |
| `idx_analytics_store_event_created` | `store_id, event_name, created_at` | 依事件類型統計 |
| `idx_analytics_store_visitor` | `store_id, visitor_id` | 訪客維度分析 |
| `idx_analytics_store_session` | `store_id, session_id` | session 維度分析 / rate limit 查詢 |
| `idx_analytics_store_cart` | `store_id, cart_id` | 購物車放棄率分析 |
| `idx_analytics_store_product_created` | `store_id, product_id, created_at` | 商品轉換排行 |
| `idx_analytics_store_order_event` | `store_id, order_id, event_name` | 查詢某訂單的事件 |
| `idx_analytics_order_event_unique` | `store_id, order_id, event_name`（partial，僅 `order_id IS NOT NULL AND event_name IN ('submit_order','purchase')`） | **防重複寫入**的資料庫層保險 |

全部使用 `CREATE INDEX IF NOT EXISTS`，重複執行 migration 不會報錯或重建。

---

## 5. Event 白名單

| event_name | 前台可寫 | 說明 |
|---|:---:|---|
| `page_view` | ✅ | 頁面初始化成功後，每 session 一次 |
| `view_product` | ✅ | 商品卡進入 viewport，每 session + product_id 一次 |
| `add_to_cart` | ✅ | 數量 0→1，或既有商品數量增加 |
| `remove_from_cart` | ✅ | 數量降為 0，或使用者主動清空購物車 |
| `begin_checkout` | ✅ | 開啟購物車，每 cart_id 一次 |
| `payment_started` | ✅ | 選定付款方式並送出 / 跳轉 LINE Pay 前 |
| `submit_order` | ❌（403） | **只能由後端**在訂單建立成功時寫入 |
| `purchase` | ❌（403） | **只能由後端**在成交/付款成功時寫入 |

`routes/analytics.js` 對 `submit_order` / `purchase` 明確回傳 `403`，訊息說明「只能由伺服器寫入」，
不是單純的白名單 400 錯誤——刻意與其他非法 event_name 分開處理，方便未來監控是否有異常嘗試。

---

## 6. 前端事件觸發點

### public/line-order.html（外帶／外送）
| 事件 | 觸發位置 | 去重方式 |
|---|---|---|
| `page_view` | `init()` 成功載入商店資料後 | sessionStorage flag `line_pv_sent_${store_id}` |
| `view_product` | `_setupViewProductObserver()`（`renderMenu()` 之後呼叫，IntersectionObserver threshold 0.5） | sessionStorage 已讀清單 `line_viewed_products_${store_id}` |
| `add_to_cart` | `addCart()`、`addPreorderToCart()`、`chgQty(id,+d)` | 不去重（事件本身即代表一次異動）；同時確保 `cart_id` 已建立 |
| `remove_from_cart` | `chgQty(id,-d)` 數量降到 0 時；`clearCartByUser()`（`metadata.reason='clear_cart'`，一筆彙總事件） | — |
| `begin_checkout` | `openCartSheet()` | sessionStorage flag 記錄「已送出的 cart_id」，同一 cart_id 只送一次 |
| `payment_started` | `submitOrder()`：非 LINE Pay 於送出訂單前；LINE Pay 於取得 `payment_url` 準備跳轉前 | — |

### public/line-shipping.html（冷藏宅配）
觸發點與去重方式與上表完全對應（函式名稱：`changeQty()` 取代 `chgQty()`，其餘相同）。

### 明確排除的觸發（避免誤判）
- `restoreCart()`（兩檔案皆是）直接寫入 `cart` 物件，不呼叫任何 `_track*()` 函式 → 不會把「還原
  購物車」誤判為使用者主動加購。
- 下單成功後的 `clearCartStorage()` 只重建 `cart_id`，**不**觸發 `remove_from_cart`，避免把成交
  誤算成放棄購物車。

---

## 7. 後端 submit_order / purchase 寫入點

| 情境 | 寫入位置 | submit_order | purchase |
|---|---|:---:|:---:|
| 外帶/外送，現金／轉帳／平台／信用卡 | `routes/line-orders.js` `POST /`（訂單 INSERT 成功後） | ✅ 立即 | ✅ 立即 |
| 外帶/外送，LINE Pay | `routes/line-orders.js` `POST /` | ✅ 立即 | ❌（等待付款） |
| 外帶/外送，LINE Pay 付款成功 | `routes/linepay.js` `GET /confirm`（`returnCode==='0000'` 之後） | — | ✅ 補寫 |
| 冷藏宅配，非 LINE Pay | `routes/line-shipping.js` `POST /` | ✅ 立即 | ✅ 立即 |
| 冷藏宅配，LINE Pay | `routes/line-shipping.js` `POST /` → `routes/linepay.js` `GET /confirm` | ✅ 立即 | ✅ Confirm 成功才補寫 |
| LINE Pay 取消 / 失敗 | 不會進入 confirm 成功分支 | 已寫（訂單建立時） | ❌ 不寫 |

追蹤欄位（`visitor_id/session_id/cart_id/UTM`）由前端在 `POST /api/line-orders`、
`POST /api/line-shipping` request body 的 `analytics: {...}` 欄位一併送出；LINE Pay
`/request`、`/confirm` 兩支 API 本身收不到這些欄位，因此 `/confirm` 寫 `purchase` 時改為呼叫
`getOrderTrackingContext()` 回頭讀取該訂單建立當下寫入的 `submit_order` 事件，取用同一組
追蹤欄位，確保 `submit_order` 與 `purchase` 可用 `order_id` 正確關聯。

---

## 8. purchase / submit_order 防重複策略

1. **同步查重**（主要防線）：`logServerEvent()` 在寫入 `submit_order` 或 `purchase` 前，先用
   `hasEventForOrder(db, store_id, order_id, event_name)` 查詢是否已存在。因為 Node.js
   單執行緒特性，查重與寫入之間沒有任何 `await`／I/O 讓出，天然避免了「兩個請求同時通過查重
   檢查」的競態條件。
2. **Partial UNIQUE INDEX**（保險防線）：`idx_analytics_order_event_unique` 對
   `(store_id, order_id, event_name)` 加上唯一限制（僅套用在 `order_id IS NOT NULL AND
   event_name IN ('submit_order','purchase')`），即使查重邏輯未來被繞過，資料庫也會拒絕第二筆
   insert；`insertEvent()` 的 try/catch 會吞下該錯誤並回傳 `false`，不會讓例外往外拋出中斷主流程。
3. **實測驗證**：直接呼叫與 `routes/linepay.js /confirm` 相同的程式碼路徑（`getOrderTrackingContext`
   + `logServerEvent`），對同一 `order_id` 連續呼叫 3 次寫入 `purchase`——第 1 次成功，第 2、3 次
   皆回傳 `false`，最終該訂單只有 1 筆 `purchase`（見第 11 節 E2E 結果）。

---

## 9. Rate Limit 規則

- 範圍：同一 `store_id + session_id`
- 規則：每 60 秒最多 60 筆事件，超過回傳 `429`
- 實作：`routes/analytics.js` 內建 in-memory `Map`（單一 process 即可，不需額外套件；重啟後計數
  歸零屬預期行為），並用 `setInterval` 每 5 分鐘清除過期 bucket，避免記憶體無限成長
- 實測：連續送出 65 筆 `page_view`，第 61～65 筆皆回傳 `429`，前 60 筆皆 `200`（見第 11 節）

---

## 10. Tenant Isolation 驗證

1. 建立第二家測試店 `store_002`，兩店同時寫入事件與訂單。
2. 直接查詢 `analytics_events`：`store_001` 71 筆、`store_002` 3 筆，`GROUP BY store_id` 結果
   完全分離，交叉查詢（`store_id='store_001' AND visitor_id IN ('v_store2','v_ship1')`）回傳
   0 筆，證明沒有資料互相污染。
3. 嘗試用 `store_002` 的 `store_id` 查詢 `store_001` 建立的訂單（`POST /api/line-orders/query`），
   回傳 `查無此訂單`（既有 `storeGuard` / SQL `WHERE store_id=?` 機制，本階段未變動，行為正常）。
4. 所有 analytics 寫入（前台事件 + 後端 submit_order/purchase）均帶正確 `store_id`，未發現任何
   一筆事件的 `store_id` 與實際下單店家不符。

---

## 11. E2E 測試結果（真實啟動 server.js 執行，非僅 node --check）

執行環境：`node server.js`（sql.js 檔案型資料庫），全新 `data/pos.db`，兩家測試店
（`store_001` 既有種子店、`store_002` 手動建立）。

| # | 測試項目 | 結果 |
|---|---|---|
| 1 | `analytics_events` 全新建立 + 8 個索引 | ✅ 通過 |
| 2 | 前台白名單事件（`page_view/view_product/add_to_cart/remove_from_cart/begin_checkout/payment_started`）各送 1 筆 | ✅ 全部 `200` 且正確寫入 DB |
| 3 | 前端直送 `submit_order` | ✅ `403` 拒絕 |
| 4 | 前端直送 `purchase` | ✅ `403` 拒絕 |
| 5 | 不支援的 `event_name` | ✅ `400` 拒絕 |
| 6 | 缺少 `visitor_id` | ✅ `400` 拒絕 |
| 7 | `product_id` 非合法整數（`"abc"`） | ✅ `400` 拒絕 |
| 8 | `quantity` 超出範圍（`1000`，允許 1~999） | ✅ `400` 拒絕 |
| 9 | `metadata` 超過 4KB | ✅ 該欄位被丟棄，事件仍成功寫入（不擋整筆事件） |
| 10 | 不存在的 `store_id` | ✅ `403`（`storeGuard` 既有機制） |
| 11 | Rate limit：同 session 連續送 65 筆 | ✅ 前 60 筆 `200`，第 61~65 筆 `429` |
| 12 | 外帶現金訂單建立成功 | ✅ `submit_order` + `purchase` 各 1 筆，`order_mode='takeout'` |
| 13 | 外帶 LINE Pay 訂單建立成功 | ✅ 只寫 `submit_order`，未寫 `purchase` |
| 14 | 模擬 LINE Pay Confirm 成功（呼叫與 `routes/linepay.js` 相同程式碼路徑） | ✅ 補寫 `purchase` 1 筆，追蹤欄位取自訂單建立時的 `submit_order`（含 `source=facebook, fbclid=fb123` 等 UTM 欄位正確帶出） |
| 15 | 模擬同一筆訂單 Confirm 被呼叫 3 次（callback 重試 / webhook 重疊 / 使用者重整成功頁的等價情境） | ✅ 第 1 次成功寫入，第 2、3 次皆被查重擋下，最終仍只有 1 筆 `purchase` |
| 16 | 冷藏宅配訂單（`store_002`，現金付款） | ✅ `submit_order` + `purchase` 各 1 筆，`order_mode='shipping'`，`cart_id='c_ship1'` |
| 17 | Tenant isolation | ✅ 見第 10 節，`store_001`/`store_002` 完全隔離，交叉查詢 0 筆 |
| 18 | 全域重複檢查：`GROUP BY store_id, order_id HAVING COUNT(*)>1` | ✅ `purchase`、`submit_order` 皆為空集合（無重複） |
| 19 | Migration 重複執行（連續啟動 server.js 兩次） | ✅ `analytics_events` 列數（74）、索引數（8）、`orders`（3）、`products`（13）啟動前後完全一致，無報錯、無重建 |
| 20 | `node --check`：`server.js`、`routes/*.js`、`utils/db.js`、`utils/analyticsLog.js`、`public/js/*.js` | ✅ 全部通過 |
| 21 | 抽取 `line-order.html` / `line-shipping.html` inline JS 語法檢查 | ✅ 全部通過 |
| 22 | 重複 DOM id 檢查 | ✅ 無重複（掃描結果的 `${p.id}` 誤判來自 `data-pid="${p.id}"`，非真正的 `id` 屬性） |
| 23 | `<div>` 標籤平衡 | ✅ `line-order.html` 165/165、`line-shipping.html` 156/156 |
| 24 | onclick/onchange/oninput handler 是否皆有定義 | ✅ 全部有定義（`debouncedPersistCart` 誤判為既有 `const ... = _debounce(...)` 寫法，非新增問題） |
| 25 | 回歸：外帶下單、冷藏宅配下單、跨店訂單查詢隔離 | ✅ 皆正常運作，金額/份數驗證邏輯完全未變動 |

---

## 12. 已知限制

1. **LINE Pay 沙盒網路限制**：本測試環境的對外網路白名單不含 LINE Pay 沙盒網域
   （`sandbox-api-pay.line.me`），因此無法透過真實 HTTP 請求觸發完整的
   `POST /api/linepay/request → 導轉 LINE Pay → GET /api/linepay/confirm` 流程。
   取而代之，直接呼叫 `routes/linepay.js` `/confirm` 成功分支所使用的**同一段程式碼**
   （`getOrderTrackingContext()` + `logServerEvent()`）驗證 purchase 寫入與防重複邏輯，
   邏輯與正式流程完全一致，但未涵蓋 LINE Pay API 簽章/網路層本身的行為。
2. **Rate limit 為單一 process 記憶體**：若未來改為多 process / cluster 部署，需改用共用儲存
   （如 Redis）才能讓 rate limit 在多 process 間生效；本階段單機部署下行為正確。
3. **既有 bug（非本次修改範圍）**：`utils/db.js` 第 203 行 `w._db.all('PRAGMA table_info(products)')`
   呼叫的是尚未包裝過的原生 sql.js 物件方法，實際應呼叫 `w.all(...)`（包裝過的介面）。此為
   Hotfix23-A 之前就存在的既有問題，發生時已被同一段程式碼的 `try/catch` 攔截（`console.error`
   後繼續往下執行，不會中斷 migration 或 server 啟動），且與 `products` 表的欄位遷移檢查有關，
   與 `analytics_events` 或本階段任何 analytics 寫入路徑無關。經反覆測試（含 2 次完整重啟、
   74 筆 analytics 事件、3 筆訂單）確認此既有問題**不影響 Hotfix23-A 任何功能**，依需求文件
   「只在確定會影響本次測試或 analytics 寫入時才做最小修正、不擴大修改其他模組」的原則，
   本次**刻意不修改**，僅在此如實記錄，留給未來處理 `products` 相關 migration 時一併修正。
4. **`view_product` 去重範圍是「同一分頁 session」**：使用 `sessionStorage`，分頁關閉或
   逾時後視為新 session，可重新記錄，符合需求規格；但同一使用者開多個分頁會各自視為
   獨立 session（沿用 Hotfix22-F 既有 `session_id` 設計，非本階段新增行為）。
5. **`quantity` 上限 999**：`clear_cart` 彙總事件的 `quantity` 為購物車內全部商品數量加總，
   理論上極端情況（購物車超過 999 件商品）會被 `routes/analytics.js` 拒絕（`400`），前端以
   `fire-and-forget` 方式呼叫、失敗會被靜默吞掉，不影響清空購物車本身的功能，僅該筆追蹤
   事件遺失。屬極端邊界情況，發生機率極低。

---

## 13. 回歸驗證結論

實際啟動 server.js 並以真實 HTTP 請求測試以下項目，皆正常：

- ✅ Hotfix22-F 購物車永久保留（localStorage 機制未變動，只補上 store_id 後綴避免跨店污染）
- ✅ 外帶下單（含商品驗證、LINE 份數扣除、優惠券、金額後端重算）
- ✅ 冷藏宅配下單（含運費計算、優惠券、份數共用邏輯）
- ✅ LINE Pay request 建立流程（`/request` 端點邏輯未變動）
- ✅ 跨店訂單查詢隔離（`store_id` 驗證機制未變動）
- ✅ Business Calendar、商品狀態、份數扣除邏輯完全未觸碰
- POS / Android：未修改任何相關檔案，無需重新測試

---

## 交付檔案

- `CHANGELOG_HOTFIX23_A_ANALYTICS_FOUNDATION.md`（本檔案）
- `pos-web-hotfix23-A.zip`

ZIP 內容排除：`node_modules/`、`data/`、`.env`、`*.db`、`*.sqlite`、測試 log。

---

**Hotfix23-A 完成，等待驗收。未開始 Hotfix23-B。**
