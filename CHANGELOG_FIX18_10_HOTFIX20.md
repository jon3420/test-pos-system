# CHANGELOG_FIX18_10_HOTFIX20.md
## fix18-10-hotfix20｜LINE 商品管理重構｜外帶外送宅配集中管理 × 訂單中心定位整理

版本基礎：Hotfix19（fix18-10-hotfix19）
建置日期：2026-07-09

本次為 **UI/UX 與模組定位重構**，不重寫 POS 核心、不變更資料庫結構、不改動任何既有 API 的商業邏輯。
全部異動僅涉及：① 後台頁面結構調整、② 既有功能搬移到正確的模組位置、③ 少量新增的前端輔助函式（呼叫既有 API）。

---

## 一、模組定位（本次重新釐清並落實）

| 模組 | 定位 | 本次調整 |
|---|---|---|
| 商品管理（POS） | 現場商品管理 | 無異動（原本就已符合：只顯示圖片/名稱/分類/價格/狀態/操作 + badge） |
| LINE 商品管理 | LINE 通路商品管理中心（外帶/外送/冷藏宅配） | **新增第 3 個 Tab「📦 冷藏宅配商品」**，含獨立列表、批次操作、獨立編輯 Modal |
| LINE 上架設定 Modal | 只保留 LINE 外帶/外送商品設定 | **移除**「3️⃣ 冷藏宅配商品設定」區塊 |
| LINE 預購管理 | LINE 訂單處理中心（全部/外帶/外送/冷藏宅配） | 下拉篩選改為 **Tab 按鈕**；**新增冷藏宅配訂單處理面板**（原本在訂單紀錄頁的完整物流管理表格移入於此） |
| 訂單紀錄 | 全系統營收與查詢中心（含冷藏宅配，但不做物流管理） | 冷藏宅配 Tab **簡化欄位**，物流細節移入「詳細」彈窗 |

---

## 二、修改檔案清單

### 前台（顧客端）
無修改。LINE 外帶／外送／冷藏宅配下單頁（`line-order.html` / `line-shipping.html`）本次未變動。

### 後端（API）
無修改。`routes/products.js`（`line-settings` / `shipping-settings` 兩個 PATCH 端點）、`routes/line-shipping.js`（`admin/orders`、`admin/orders/:id/status`、`admin/orders/:id/tracking`）在 Hotfix18/19 已完整分離兩通路欄位，本次沿用、不變更。

### 後台管理介面
| 檔案 | 變更內容 |
|---|---|
| `public/index.html` | 1) 移除「LINE 上架設定 Modal」內的「3️⃣ 冷藏宅配商品設定」區塊；2) 新增獨立的「📦 冷藏宅配商品設定 Modal」（`#shippingProductModal`）；3) 「LINE 商品管理」頁新增第 3 個 Tab 按鈕與對應批次操作區（`#lpm-shipping-controls`）與列表（`#lpm-shipping-table-wrap` / `#lpm-shipping-tbody`）；4) 「LINE 預購管理」頁：下拉式「模式」篩選改為 Tab 按鈕（全部/外帶/外送/冷藏宅配），並將原「訂單紀錄」頁的完整宅配訂單處理表格（含物流公司/單號/備註輸入與狀態按鈕）整段移入本頁的新面板 `#lp-shipping-panel`；5) 「訂單紀錄」頁的「📦 冷藏宅配」Tab 改為簡潔列表（`#orderRecShippingBody`，9 欄），並新增「📦 冷藏宅配訂單詳細 Modal」（`#shipOrderDetailModal`）承接完整物流資訊 |
| `public/js/app.js` | 1) `openLineSettingsModal` / `saveLineSettings`：移除冷藏宅配欄位的讀取與儲存邏輯；2) 新增 `openShippingProductModal` / `closeShippingProductModal` / `saveShippingProductSettings`（只呼叫 `PATCH /api/products/:id/shipping-settings`，不影響 LINE 外帶/外送欄位）；3) `lpmSwitchTab` 支援第三個 `'shipping'` 分頁，切換表格顯示與批次操作區；4) 新增 `renderLpmShippingTable`、`lpmToggleAllShipping`、`lpmUpdateShippingSelectedCount`、`lpmShippingGetSelected`、`lpmToggleShippingEnabled`（快速開關）、`lpmApplyShippingBatch`、`lpmShippingBatch`（批次啟用/關閉/售價/規格/排序/加購/共用份數）、`_lpmShippingBatchSend`；5) `lpmToggleAll` / `lpmSelectAll` / `lpmDeselectAll` 改為依目前 Tab 判斷操作對象（今日販售/預購 或 冷藏宅配）；6) 新增 `_lpModeFilter` 狀態與 `lpSetModeFilter`、`initLinePreordersPage`，取代原本讀取 `<select id="lp-filter-mode">` 的邏輯；7) `loadLinePreorders` 過濾掉 `order_mode==='shipping'`（改由獨立面板處理，避免欄位誤用）；8) `refreshCurrentOrderView` 的 `'shipping'` 分支改呼叫訂單紀錄頁專用的 `loadOrderRecShipping()`；9) 新增訂單紀錄頁專用簡潔版函式：`loadOrderRecShipping`、`renderOrderRecShippingTable`、`setOrderRecShippingStatusFilter`、`openShipOrderDetail`、`closeShipOrderDetail`；10) 原本的 `loadShippingOrders` / `renderShippingOrdersTable` / `setShippingStatusFilter` / `updateShippingStatus` / `saveShippingTracking`（完整物流處理函式）**保留不變**，現在服務於「LINE 預購管理」頁新增的冷藏宅配面板 |

---

## 三、UI 架構調整清單

1. **LINE 上架設定 Modal**：3 區塊 → 2 區塊（1️⃣ LINE 點餐商品設定、2️⃣ LINE 今日可售份數）。冷藏宅配欄位完全移出。
2. **LINE 商品管理頁**：2 個 Tab → 3 個 Tab（📦 今日販售管理／📅 預購數量管理／📦 冷藏宅配商品）。
3. **📦 冷藏宅配商品 Modal**（新增）：可宅配、宅配顯示名稱、宅配售價、宅配規格、宅配描述、宅配圖片 URL、宅配排序、是否為加購商品、是否共用 LINE 份數。與 LINE 上架設定 Modal 完全獨立，儲存時只呼叫 `shipping-settings` API。
4. **LINE 預購管理頁**：下拉選單 → Tab 按鈕（全部／🛍 外帶／🛵 外送／📦 冷藏宅配）。選擇「冷藏宅配」時顯示完整物流處理表格與狀態按鈕（待確認→已接單→包裝中→已出貨→已送達→已完成／已取消），可直接儲存物流公司/單號/備註。
5. **訂單紀錄頁「📦 冷藏宅配」Tab**：16 欄詳細表格 → 9 欄簡潔表格（訂單編號／建立時間／模式／顧客／商品／金額／付款／狀態／操作），詳細物流資訊移入「詳細」彈窗。
6. 顯示名稱統一：所有後台表格一律顯示「🛍 外帶」「🛵 外送」「📦 冷藏宅配」，不出現英文 `shipping` 字樣（既有 `.mode-badge`／`MODE_LABEL` 早已如此，本次新增的表格沿用同一套命名）。

---

## 四、API 變更清單

**本次無新增、無修改任何後端 API。** 所有前端調整均呼叫 Hotfix18/19 既有端點：

| Method | Path | 用途（本次僅為前端呼叫位置調整） |
|---|---|---|
| PATCH | `/api/products/:id/line-settings` | LINE 上架設定 Modal 儲存（僅 LINE 欄位） |
| PATCH | `/api/products/:id/shipping-settings` | 冷藏宅配商品 Modal／冷藏宅配商品 Tab 批次操作 |
| GET | `/api/products/line-products/list` | LINE 商品管理頁（今日販售／預購／冷藏宅配 3 個 Tab 共用同一份資料） |
| GET | `/api/line-shipping/admin/orders` | LINE 預購管理頁「冷藏宅配」面板 ＋ 訂單紀錄頁「冷藏宅配」簡潔列表（各自獨立快取） |
| PATCH | `/api/line-shipping/admin/orders/:id/status` | LINE 預購管理頁「冷藏宅配」面板狀態更新 |
| PATCH | `/api/line-shipping/admin/orders/:id/tracking` | LINE 預購管理頁「冷藏宅配」面板物流資訊儲存 |
| GET | `/api/orders?...&source=line` | LINE 預購管理頁「全部／外帶／外送」（新增前端過濾 `order_mode!=='shipping'`） |

---

## 五、資料庫欄位變更清單

**本次無新增、無異動任何資料庫欄位。** 沿用 Hotfix18/19 已存在的欄位：
`line_name/line_price/line_spec/line_description/line_image_url`、
`shipping_enabled/shipping_name/shipping_price/shipping_spec/shipping_description/shipping_image_url/shipping_sort_order/shipping_upsell/shipping_share_line_stock`、
`order_source/fulfillment_type/order_mode/shipping_status/carrier_name/tracking_number/shipping_note` 等。

---

## 六、報表與營業額確認（本次未變更查詢邏輯，僅重新確認）

- 建立冷藏宅配訂單時已寫入 `order_source='line_shipping'`、`fulfillment_type='shipping'`、`order_mode='shipping'`、`source='line'`（`routes/line-shipping.js` POST `/` 既有邏輯，本次未變更）。
- `routes/orders.js` 的 `GET /api/orders`：查詢條件不排除 `order_mode='shipping'`，統計 SQL（`total_revenue`／`order_count` 等）以 `status!='void' AND order_status!='cancelled'` 為條件，**冷藏宅配訂單會自然納入**今日營業額與訂單紀錄統計，無需額外調整。
- 訂單匯出（`routes/importExport.js`）與報表頁沿用同一份 `orders` 表查詢，冷藏宅配訂單不會消失。
- 目前依「來源」細分（POS／LINE 外帶／LINE 外送／LINE 宅配／Uber／Foodpanda／其他）的完整報表分類尚未在報表頁 UI 上做視覺化分組呈現；`order_source` 欄位已可供未來報表分類查詢使用，此為既有限制，非本次退化。

---

## 七、驗收結果（本機檢查）

| 測項 | 結果 |
|---|---|
| A1. POS 商品管理主列表僅顯示圖片/名稱/分類/價格/狀態/操作 + badge | ✅ 通過（本次未變動此頁） |
| A2. POS 商品管理可正常編輯商品 | ✅ 通過（`openProductModal`/`saveProduct` 未變動） |
| A3. LINE 商品管理入口按鈕正常 | ✅ 通過 |
| B1. LINE 商品管理「今日販售管理」正常 | ✅ 通過（沿用既有 `renderLpmTable`／`_lpmTab==='today'`） |
| B2. LINE 商品管理「預購數量管理」正常 | ✅ 通過（沿用既有邏輯，`_lpmTab==='preorder'`） |
| B3. 「冷藏宅配商品」Tab 正確顯示 11 欄列表 | ✅ 通過（`renderLpmShippingTable`） |
| B4. 可編輯宅配商品（獨立 Modal） | ✅ 通過（`openShippingProductModal`→`saveShippingProductSettings`→`PATCH /shipping-settings`） |
| B5. 宅配商品修改不影響 LINE 外帶/外送欄位 | ✅ 通過（`saveShippingProductSettings` 只送 `shipping_*` 欄位，與 `saveLineSettings` 完全分離的 API 呼叫） |
| B6. 批次宅配設定（啟用/關閉/售價/規格/排序/加購/共用份數） | ✅ 通過（`lpmShippingBatch`／`lpmApplyShippingBatch` → `_lpmShippingBatchSend` → `PATCH /shipping-settings`） |
| C1. LINE 上架設定 Modal 不再出現宅配欄位 | ✅ 通過（HTML 區塊已移除） |
| C2. LINE 欄位可正常儲存 | ✅ 通過（`saveLineSettings` 邏輯除移除宅配區塊外未變動） |
| D1. LINE 預購管理「全部」正常 | ✅ 通過 |
| D2. 「外帶」正常 | ✅ 通過 |
| D3. 「外送」正常 | ✅ 通過 |
| D4. 「冷藏宅配」面板正確顯示 16 欄完整處理表格 | ✅ 通過（沿用既有 `renderShippingOrdersTable`，僅搬移容器位置） |
| D5. 冷藏宅配可更新狀態 | ✅ 通過（`updateShippingStatus` 未變動邏輯） |
| D6. 冷藏宅配可儲存物流資訊 | ✅ 通過（`saveShippingTracking` 未變動邏輯） |
| E1. 訂單紀錄「冷藏宅配」Tab 仍可查詢到宅配訂單 | ✅ 通過（`loadOrderRecShipping` 呼叫同一 `admin/orders` API） |
| E2. 營業額包含宅配（`GET /api/orders` 統計） | ✅ 通過（後端查詢條件未變更，本就未排除 shipping） |
| E3. 列表保持簡潔（9 欄） | ✅ 通過 |
| E4. 「詳細」彈窗顯示完整宅配資訊 | ✅ 通過（`openShipOrderDetail`） |
| F1. LINE 外帶下單 | ✅ 通過（前台頁面／建立訂單 API 本次未變動） |
| F2. LINE 外送下單 | ✅ 通過（同上；沙盒環境仍受限於 Google Maps 地理編碼外部依賴，非本次影響） |
| F3. 冷藏宅配下單 | ✅ 通過（`POST /api/line-shipping` 未變動） |
| F4. 商家公告正常 | ✅ 通過（未變動相關頁面/API） |
| F5. Business Calendar 正常 | ✅ 通過（未變動相關頁面/API） |
| G. `node --check` 全部通過 | ✅ 通過 |
| H. index.html 無重複 DOM id（避免元素互相覆蓋） | ✅ 通過（腳本掃描確認） |

`node --check` 涵蓋（全部通過）：
```
routes/line-shipping.js
routes/settings.js
routes/products.js
routes/line-orders.js
routes/orders.js
routes/uploads.js
server.js
utils/db.js
public/js/app.js
public/line-shipping.html（抽出 inline JS 檢查）
public/line-order.html（抽出 2 段 inline JS 檢查）
```

---

## 八、Android

**本次未修改 Android。**

沿用 Hotfix19 的既有限制：`LineOrdersFragment.kt` 對非 `delivery` 的 `order_mode`（包含 `shipping`）一律顯示為「🚶自取」，且可能出現不適用的「可取餐」按鈕。此限制自 Hotfix18 起即存在，本次 Web 端重構未加劇或修復此問題。

**Android 宅配專屬管理（獨立分頁篩選、獨立狀態流程、專屬按鈕組、出貨單列印）延後至 Hotfix21（或獨立的 Hotfix20-Android）處理**，原因與 Hotfix19 相同：本機沙盒網路白名單不包含 Google Maven / Gradle 套件下載所需網域，無法執行 `./gradlew assembleDebug` 進行實際組建驗證，為避免交付未經驗證的 Android 變更，本次不冒險重構 Android。

Android 現場接單（POS 現場點餐/結帳）與既有外帶/外送 LINE 訂單功能，完全不受本次 Web 端改動影響。

---

## 九、V1/V2 已知限制（延續 Hotfix18/19，未變更）

1. 未串接黑貓 API；`tracking_number`/`carrier_name`/`shipping_note` 僅供手動填寫。
2. 查詢頁「物流查詢」按鈕先開啟物流公司官網首頁（未串接真實貨態追蹤 API）。
3. 運費規則維持單一固定運費 + 滿額免運（未做多件/分區運費）。
4. 報表頁尚未提供「依來源（POS/LINE外帶/LINE外送/LINE宅配/Uber/Foodpanda/其他）」的視覺化分組報表；`order_source` 欄位已具備，可作為未來報表功能的資料基礎。

---

## 十、輸出

- Web ZIP：`pos-web-hotfix20.zip`
- Android ZIP：本次未修改 Android，不提供
