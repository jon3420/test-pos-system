# fix18-10-hotfix30-B｜LINE 點餐 UX 重構 × 單一商品入口 × 商品模式管理 × Mode Conflict Analytics

實際基礎版本：**pos-web-fix18-10-hotfix29-C2-migration-upload-config-full.zip**
（人類指示中提到的「pos-web-fix18-10-hotfix29-C-full(1).zip」在專案內找不到對應版本，
專案內唯一存在的是 C2；本次全程以 C2 為唯一基礎，未切換過基礎版本，如實記錄於此。）

---

## 1. Root Cause

`line-order.html` 原本要求顧客先手動選擇「外帶／外送」頁籤，才能看到該模式下的商品狀態。
商品卡與加入購物車邏輯（`buildCard()`／`addCart()`）只依賴單一全域 `currentMode` 判斷
是否可購買。當顧客上次保存的模式（`localStorage.order_mode`）與今日店家開放的模式不一致
時（例如今日外帶已截止、外送仍開放，但顧客上次是用外帶下單），畫面會把「目前模式不可用」
誤判成「全部商品都不可購買」，導致顧客誤以為今日全店停止營業、訂單流失。

## 2. 完成項目（Hotfix30-A + Hotfix30-B 累計）

- 移除商品頁「外帶／外送」可點擊頁籤，改為純資訊的「今日服務」狀態列（`#serviceStatusBar`），
  不含 `onclick`、不控制商品 render、不變更 `cartMode`。
- 商品列表永遠只有一份（`allProducts`／`renderMenu()` 單一來源，未新增第二份商品陣列）。
- 商品卡改用 `getProductAvailableModes()` 的「任一模式可買即可買」判斷，取代單一
  `currentMode` 判斷；只有兩種模式都不可買才整卡變暗＋停用。
- 購物車取餐方式從 `<select>` 改為大按鈕單選（◉/○，≥48px），disabled 時灰色＋顯示原因文字。
- 新增購物車模式衝突清單（`renderModeConflict()`）：列出造成衝突的商品與其「僅外帶／僅外送／
  今日不可購買」標籤，逐項提供「移除」按鈕，不自動刪除商品、不清空購物車、送出按鈕停用。
- 新增商品「LINE 點餐販售模式」管理：後台商品編輯 Modal 新增「外帶可販售／外送可販售」
  勾選框，預設皆啟用，至少須啟用一種。
- 新增 Analytics 事件：`fulfillment_method_view`／`fulfillment_method_selected`／
  `fulfillment_method_unavailable`／`fulfillment_method_auto_switched`／`mode_conflict`。
- 新增 Dashboard「🚦 取餐方式衝突」統計區塊與規則式建議（不呼叫 AI API）。
- 商品管理列表新增「販售模式」膠囊標籤（外帶＋外送／僅外帶／僅外送）。

## 3. 資料庫變更

新增欄位（皆為新增、非破壞性，預設值 1 = 啟用，對既有商品零行為改變）：

```
products.line_takeout_enabled   INTEGER DEFAULT 1
products.line_delivery_enabled  INTEGER DEFAULT 1
```

- Migration script：`scripts/migrate-hotfix30-a-product-mode.js`（可重複執行，已連續執行
  兩次驗證皆無錯誤，第二次全部顯示 `SKIP ... 已存在`）。
- Runtime-safe 補欄位：`routes/products.js` 新增 `ensureProductModeColumns()`（與既有
  `ensureProductPreorderColumns()` 相同模式），並在 `server.js` 的 `initDb().then(...)`
  開機流程中呼叫一次 —— 確保正式環境即使沒有人手動執行過 migration script，伺服器啟動時
  仍會自動安全補上欄位，不會出現「只有跑過 script 的環境才有欄位」的落差。
- 未新增任何資料表；未修改／未刪除既有欄位；未動到 `shipping_*` 系列欄位。

## 4. 商品模式管理（後台 UI × API）

- `public/index.html`：商品編輯 Modal 新增「LINE 點餐販售模式」區塊（☑ 外帶可販售 /
  ☑ 外送可販售），與宅配設定（獨立 Modal）完全分離，未共用勾選框。
- `public/js/app.js`：
  - 開啟 Modal 時正確帶出資料庫值（無值時預設皆勾選，與 DB 預設一致）。
  - 儲存時前端先擋一次「兩者皆未勾選」，顯示提示文字，並在通過後才呼叫 API。
  - 商品管理列表（`renderProductsTable`）新增「販售模式」膠囊：外帶＋外送 / 僅外帶 / 僅外送。
- `routes/products.js`：
  - `PATCH /:id/line-settings` 新增接受 `line_takeout_enabled` / `line_delivery_enabled`。
  - 新增 `_toModeBit()`：只接受布林、`0`/`1`/`"0"`/`"1"`/`"true"`/`"false"`，其餘一律安全
    預設為 `1`，不信任任意字串。
  - 伺服器端二次驗證「至少啟用一種」，即使前端被繞過也會被擋下（400 + 明確訊息）。
  - `enrichProduct()` 回傳兩欄位，未設定時安全預設 `1`。
  - `store_id` 隔離沿用既有 `WHERE id=? AND store_id=?` 模式，未變更。
  - 未影響商品庫存、價格、分類、配方、宅配欄位（`shipping_*` 完全未被本次的 `add()` 白名單
    觸碰）。
- 本版未新增批次商品設定 API（人類指示明確表示本版不需要）。

## 5. 購物車模式交集（沿用 Hotfix30-A，本輪未變更邏輯）

`getProductAvailableModes()` / `getCartAvailableModes()` / `reconcileFulfillmentMode()`
維持 Hotfix30-A 完成時的邏輯不變（本輪指示明確要求不得調整）：

- 商品卡與加入購物車：任一模式可買即可買。
- 購物車：取所有商品可用模式的交集；只剩一種可用時自動切換並提示（不靜默切換）；
  兩種都不可用時列出衝突商品清單、停用送出。
- `localStorage`（`cart` / `cartMode` / `cart_id` 等）永久保留規則沿用 Hotfix22-F，未變更。

## 6. 後端驗證

三處使用一致規則（`line_takeout_enabled` / `line_delivery_enabled` 皆優先於今日截止/份數判斷）：

- `GET /api/line-orders/menu`：`takeout_sold_out_reason` / `delivery_sold_out_reason` 新增
  `product_mode_disabled` 原因（商品自身停用該模式時，優先於店家模式開關判斷），且不允許
  「預約明日」（屬永久性設定，非當日限制）。
- `GET /api/line-orders/validate-cart`：新增商品層級模式檢查，回傳
  `reason: 'product_mode_not_supported'`。
- `POST /api/line-orders`（送單）：逐項商品驗證，若不支援目前選擇模式，回傳
  ```json
  { "success": false, "reason": "product_mode_not_supported",
    "product_id": ..., "product_name": ..., "mode": "takeout|delivery" }
  ```
  不得只依靠前端 `disabled` 狀態。
- 既有 Business Calendar／截止時間／LINE 份數驗證（`validateOrderConditions()`）維持不變，
  本次只在其之外「新增」商品層級的模式檢查，未改動既有判斷順序或條件。

## 7. Analytics

- `utils/analyticsLog.js`：`EVENT_WHITELIST` 新增 5 個事件名稱（見第 2 節），皆為純顯示/
  操作類事件，不含金額、付款、個資。
- `routes/analytics.js`：新增 `sanitizeFulfillmentMetadata()`，只對這 5 個事件生效，其他
  既有事件的 metadata 處理完全不受影響：
  - 只允許 `cart_id` / `reason` / `from_mode` / `to_mode` / `current_mode` /
    `affected_products`。
  - `affected_products` 最多 20 項，每項只允許 `product_id` / `product_name`
    （截斷 60 字）/ `available_modes: {takeout, delivery}`，其餘欄位一律丟棄
    （即使前端不小心夾帶電話／地址／姓名／Token／LINE User ID 也會被過濾掉）。
  - metadata 仍受既有 4KB 上限（`normalizeMetadata()`）約束，未新增第二套大小限制。
- 前端 `_trackModeConflict()`（Hotfix30-A 已完成）以「reason + cart_id + 受影響商品 id
  排序後的組合」做 key，同一衝突組合只送一次，避免重複開關購物車就重複觸發事件。

## 8. Dashboard

- `utils/dashboardAnalytics.js` 新增 `getFulfillmentConflicts(db, storeId, range)`：
  - 沿用 Dashboard 既有日期範圍表達式（`ANALYTICS_CREATED_AT_LOCAL_EXPR` / `range.startLocal`
    ~`range.endLocal`），未新增第二套日期邏輯。
  - 每筆 `mode_conflict` 事件的 `metadata_json` 皆以 `try/catch` 解析，解析失敗只跳過該筆
    metadata 統計（不影響 `total_conflicts` 計數），絕不拋出例外。
  - 統計口徑：
    - `total_conflicts`：區間內 `mode_conflict` 事件數。
    - `affected_carts`：`COUNT(DISTINCT cart_id)`。
    - `resolved_carts`：這些 cart_id 中，最終（不限同一日期區間）有對應
      `submit_order` 或 `purchase` 事件（同 store_id）。
    - `unresolved_carts` = `affected_carts - resolved_carts`。
    - `top_products` / `top_reasons`：由 metadata 安全解析後排行，各取前 10。
  - `store_id` 全程隔離；IN 子句分批（每批 200）避免變數過長。
  - 新增 `getFulfillmentConflictRecommendations(conflicts)`：規則式建議（不呼叫 AI API）。
    - Rule A：`total_conflicts >= 5` → 建議檢查商品販售模式。
    - Rule B：`top_products[0].count >= 3` → 建議調整該商品外帶/外送設定。
- `routes/analytics.js`：`GET /api/analytics/dashboard`（**沿用既有端點，未新增 API**）
  在既有回應物件後方新增 `fulfillment_conflicts` / `fulfillment_recommendations` 兩個欄位，
  整段包在獨立 `try/catch`，計算失敗時回退為 `insufficient_data:true` 的安全預設值，
  不會讓整支 API 500。
- `public/js/app.js`：新增 `renderDashboardFulfillmentConflicts()`，沿用既有 `_card()` /
  `_section()` 版面元件與既有 Dark Theme CSS 變數（未新增樣式系統）：
  - KPI：發生衝突／受影響購物車／已成交／未成交／衝突後成交率（`_fmtPct()` 已內建防
    `NaN`/`Infinity` 顯示，異常值一律顯示「—」）。
  - 「最常造成衝突商品」與「衝突原因排行」兩個表格，皆用既有 `overflow-x:auto` 手機水平
    捲動樣式；無資料時顯示「目前沒有取餐方式衝突資料。」
  - 已掛入 `renderDashboardV2()` 既有組裝序列（緊接在 `renderDashboardLineCrmHealth` 之後）。

## 9. LINE Member Gate 順序

確認 `public/line-order.html` 的 `submitOrder()`：姓名／電話／購物車非空／取餐方式／
店家模式開關／**購物車商品模式相容性（衝突檢查）**／付款方式／日期／時間／外送地址與
運費／截止時間，全部驗證通過後，才在函式最後執行
`LineMemberGate.requireMemberBeforeCheckout(...)`（僅 `gate_mode==='checkout'` 時），
最後才呼叫 `POST /api/line-orders` 送單。確認沒有提前呼叫登入 Gate 的路徑；
`entry` 模式（進站即要求登入）行為未被改動；登入返回後購物車 / 模式 / 日期時間 / 優惠券
/ attribution 由既有 `restoreCart()` / `persistCart()` 機制保留，本次未修改該部分邏輯。

## 10. Regression

```
node --check server.js                → OK
node --check routes/*.js              → OK（全部檔案逐一執行，無 FAIL）
node --check utils/*.js               → OK（全部檔案逐一執行，無 FAIL）
node --check public/js/*.js           → OK
node --check scripts/*.js             → OK
public/line-order.html inline JS 語法 → OK（node --check，抽取後驗證）
public/index.html      inline JS 語法 → OK（新增的商品模式勾選框相關程式碼在內）
```

- `div` 標籤平衡：`line-order.html` 182/182、`index.html` 769/769。
- 重複 DOM id：兩檔案皆為 0。
- 舊版 mode-tab handler（`switchMode` 呼叫、`#modeTabs`、`#tabTakeout`、`#tabDelivery`）
  已確認完全移除，只剩註解文字提及函式名稱（無實際呼叫）。
- `#oType` 已改為 `<input type="hidden">`，確認沒有殘留 `<select id="oType">`。
- 無測試用 `console.log`（`grep console.log public/line-order.html` 無結果）。
- Migration 連續執行兩次：第二次全部欄位顯示 `SKIP ...（已存在）`，無錯誤、無報錯退出碼。
- **Server 實際啟動測試**：`npm install` 後 `node server.js` 成功啟動，看到
  `[products] ✅ ALTER TABLE products ADD COLUMN line_takeout_enabled` /
  `line_delivery_enabled`（開機自動補欄位驗證通過），最終輸出
  `📡 POS: http://localhost:5000` 等啟動訊息，無例外拋出。
  （測試用 `node_modules/` 與 `data/` 已在測試後清除，未包含在交付 ZIP 內。）
  另外確認：開機時出現的 `[DB] ❌ PRAGMA table_info(products) 失敗: w._db.all is not a
  function` 訊息經比對，在**未經任何修改的原始 C2 基礎版本**開機時同樣會出現（已用
  pristine 版本單獨驗證），確認是既有既存訊息、非本次改動造成，本次未處理、亦不在本次
  範圍內。

## 11. 宅配未修改證明

以原始 `pos-web-fix18-10-hotfix29-C2-migration-upload-config-full.zip` 逐檔比對
（SHA-256 完全一致）：

```
public/line-shipping.html
  base : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  final: ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  → 完全一致，無任何修改

routes/line-shipping.js
  base : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  final: ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  → 完全一致，無任何修改
```

**宅配功能本版完全未修改。** 冷藏宅配購物車、宅配優惠券、宅配 LINE Pay、黑貓物流、
宅配公告、宅配會員 Gate 均未被本次改動觸及。Android 專案（`pos-android-hotfix16.zip`）
本版全程未解壓、未讀取、未修改，僅作為既有回歸參考存在於使用者上傳清單中。

## 12. 已知限制

1. **商品列表批次設定**：本版僅支援單一商品編輯 Modal 設定販售模式，未新增批次修改
   多商品販售模式的 API 或 UI（人類指示明確表示本版不需要）。
2. **Dashboard 規則式建議 Rule C 未實作**：需求文件中「外帶關閉但外送仍開放，且有大量
   `fulfillment_method_unavailable` 時提示」的第三條規則，因需要即時查詢當前店家營業
   設定（`takeout_enabled`/`delivery_enabled`）並與歷史事件統計交叉比對，与現有
   `getFulfillmentConflicts()` 純歷史事件統計的計算範疇不同，本版僅完成 Rule A、Rule B，
   Rule C 留待下一版本評估是否需要額外的即時狀態查詢。
3. **`mode_conflict` 去重僅在前端**：目前依賴前端 `_lastModeConflictKey` 做同一衝突組合
   去重；後端 `POST /events` 本身未對 `mode_conflict` 做伺服器端去重（沿用既有事件寫入
   架構，未新增去重表或索引）。正常使用情境下前端去重已足夠避免同一衝突被重複計入
   `total_conflicts`，但理論上惡意繞過前端仍可重複送出。
4. **加入收藏／稍後購買／願望清單**：需求文件第七點提及可預留於 CHANGELOG，本版未實作、
   未新增任何相關資料表或 UI，純粹留白供未來版本評估。
5. **Rule 引擎皆為靜態門檻**（`total_conflicts >= 5`、`top_products[0].count >= 3`），
   未依店家規模或歷史基準動態調整，小店與大店可能需要不同門檻，留待未來版本依實際使用
   數據調整。

## 回退方式

若需回退本版：

1. 還原 `public/line-order.html`、`public/index.html`、`public/js/app.js`、
   `routes/line-orders.js`、`routes/products.js`、`routes/analytics.js`、
   `utils/analyticsLog.js`、`utils/dashboardAnalytics.js`、`server.js` 為
   `pos-web-fix18-10-hotfix29-C2-migration-upload-config-full.zip` 內的對應版本。
2. `products` 表新增的 `line_takeout_enabled` / `line_delivery_enabled` 欄位可保留
   不刪除（預設值 1，不影響回退後的既有邏輯讀取；SQLite 不支援簡單 DROP COLUMN，
   保留欄位比強制移除更安全）。
3. 移除 `scripts/migrate-hotfix30-a-product-mode.js`（若不需要，可安全刪除，不影響
   已補上的欄位）。
4. `line-shipping.html` / `line-shipping.js` 全程未修改，回退時無需處理。
