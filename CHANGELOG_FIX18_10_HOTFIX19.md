# CHANGELOG_FIX18_10_HOTFIX19.md
## fix18-10-hotfix19｜LINE 冷藏宅配中心 V2｜多通路商品、宅配入口與訂單管理優化

版本基礎：Hotfix18（fix18-10-hotfix18）
建置日期：2026-07-08

---

## 一、修改檔案清單

### 後端
| 檔案 | 變更內容 |
|---|---|
| `utils/db.js` | safe migration 新增 `line_spec`、`shipping_price`、`shipping_description`、`shipping_image_url`（已存在的 `line_name/line_price/line_description/line_image_url/shipping_name/shipping_spec` 沿用不動） |
| `routes/products.js` | `enrichProduct()` 回傳新欄位；`PATCH /:id/line-settings` 支援 `line_spec`；`PATCH /:id/shipping-settings` 支援 `shipping_price/description/image_url` |
| `routes/line-shipping.js` | **BUG 修正**：商品欄位改為優先 `shipping_*`、fallback 回 POS 主商品欄位（`name/price/description/image`），不再誤用 `line_*` 欄位；`GET /shop`、`validate-cart`、建立訂單皆已修正。新增 `PATCH /admin/orders/:id/tracking`（物流資訊獨立更新端點） |
| `routes/line-orders.js` | 移除 `/shop` 回應中的 `shipping_enabled`（LINE 點餐頁不再需要判斷是否顯示宅配入口） |
| `routes/uploads.js` | **新檔案**：通用圖片上傳 API（`POST /api/uploads/image`，base64 上傳），供商家公告圖片上傳共用，不新增重複端點 |
| `server.js` | 掛載 `/api/uploads` 路由 |

### 前台
| 檔案 | 變更內容 |
|---|---|
| `public/line-shipping.html` | **BUG1 修正**：+ / − 按鈕改用事件委派（event delegation），不再依賴逐次重繪的 inline onclick，商品卡與購物車內皆可正確加減、數量 0 自動移除、購物車開啟中即時同步；查詢頁全面重寫為「📦 宅配訂單狀態」專用樣式，含狀態 stepper、收件人／電話／地址／到貨日／商品明細／小計／運費／總金額／物流公司／物流單號／備註，`tracking_number` 有值時顯示「物流查詢」按鈕 |
| `public/line-order.html` | **移除**冷藏宅配入口按鈕與 `goToShippingPage()`（顧客點餐頁只保留外帶/外送）；商品卡新增 `line_spec` 顯示；商品卡狀態徽章改為兩排（`.badge-row-main` + `.badge-row-action`），修正原本三排堆疊跑版問題 |
| `public/css/main.css` | （沿用 Hotfix18 `.mode-shipping`，本次無異動） |

### 後台管理介面
| 檔案 | 變更內容 |
|---|---|
| `public/index.html` | 商品 LINE 設定 Modal 重整為三區塊（1️⃣ LINE 點餐商品設定／2️⃣ LINE 今日可售份數／3️⃣ 冷藏宅配商品設定），新增 LINE 規格欄位與宅配售價／描述／圖片 URL 欄位；設定 → LINE 點餐入口新增「📦 冷藏宅配入口」卡片（獨立網址／複製／開啟／QR Code，不動原本 LINE 點餐入口卡片）；商家公告圖片 URL 旁新增「上傳圖片」按鈕；訂單頁新增「📦 冷藏宅配」Tab 與對應表格（含宅配狀態篩選列） |
| `public/js/app.js` | `openLineSettingsModal`/`saveLineSettings` 支援 `line_spec` 與 `shipping_price/description/image_url`；新增 `renderShippingEntry()` 與獨立 QR/複製/開啟/下載函式（與既有 LINE 點餐入口函式完全分離，不共用 DOM id）；新增 `uploadAnnouncementImage()`；`switchOrderTab`/`refreshCurrentOrderView` 支援 `shipping` 分頁；新增 `loadShippingOrders()`、`renderShippingOrdersTable()`、`setShippingStatusFilter()`、`updateShippingStatus()`、`saveShippingTracking()` |

---

## 二、新增欄位清單

### `products` 表（safe migration，僅新增缺少欄位）
```
line_spec              TEXT DEFAULT ''     -- LINE 通路獨立規格（Hotfix18 缺少，本次補上）
shipping_price          REAL DEFAULT 0      -- 宅配通路獨立售價
shipping_description    TEXT DEFAULT ''     -- 宅配通路獨立描述
shipping_image_url      TEXT DEFAULT ''     -- 宅配通路獨立圖片
```
（`line_name/line_price/line_description/line_image_url/shipping_name/shipping_spec/shipping_enabled/shipping_sort_order/shipping_upsell/shipping_share_line_stock` 為 Hotfix17/18 既有欄位，沿用不動）

`orders` 表本次無新增欄位（Hotfix18 已具備 `carrier_name/tracking_number/shipping_note` 供本次 `/tracking` 端點使用）。

---

## 三、多通路商品欄位規則（本次核心修正）

| 通路 | 名稱 | 售價 | 規格 | 描述 | 圖片 |
|---|---|---|---|---|---|
| LINE 點餐 | `line_name` | `line_price` | `line_spec` | `line_description` | `line_image_url` |
| 冷藏宅配 | `shipping_name` | `shipping_price` | `shipping_spec` | `shipping_description` | `shipping_image_url` |

- 兩通路各自獨立，皆為「通路欄位為空 → fallback 回 POS 主商品欄位（`name/price/description/image`）」，**不會互相 fallback**（宅配不會 fallback 到 LINE 欄位，反之亦然）。
- 已於 `routes/line-shipping.js` 修正 Hotfix18 遺留的錯誤 fallback（原本宅配頁誤用 `line_price/line_description/line_image_url`）。

---

## 四、API 變更清單

| Method | Path | 變更 |
|---|---|---|
| PATCH | `/api/products/:id/line-settings` | 新增 `line_spec` 欄位支援 |
| PATCH | `/api/products/:id/shipping-settings` | 新增 `shipping_price` / `shipping_description` / `shipping_image_url` |
| GET | `/api/line-shipping/shop` | 商品欄位 fallback 規則修正（shipping_* → POS 主欄位） |
| POST | `/api/line-shipping` | 建立訂單計價改用 `shipping_price` fallback（原誤用 `line_price`） |
| POST | `/api/line-shipping/validate-cart` | 同上 |
| PATCH | `/api/line-shipping/admin/orders/:id/tracking` | **新增**：獨立更新 `carrier_name` / `tracking_number` / `shipping_note`，不影響 `shipping_status` |
| GET | `/api/line-orders/shop` | 移除 `shipping_enabled`（不再供前台判斷是否顯示宅配入口） |
| POST | `/api/uploads/image` | **新增**：通用圖片上傳（base64），供商家公告圖片沿用 |

---

## 五、settings key 清單

本次無新增 settings key（沿用 Hotfix18 的 15 個 `shipping_*` key）。

---

## 六、驗收結果（本機 E2E 實測）

| 測項 | 結果 |
|---|---|
| A. 宅配 +/- ：+3 次 → −1 次 → 送單 quantity | ✅ 通過（實測訂單 `SHIP-20260708-102313`，`items[0].qty === 2`） |
| B. 多通路規格：LINE `line_spec=200g`、宅配 `shipping_spec=500g` 互不影響 | ✅ 通過 |
| C. 多通路售價：LINE `line_price=150`、宅配 `shipping_price=350` 互不影響 | ✅ 通過 |
| D. 建立宅配訂單：`order_source=line_shipping`、`fulfillment_type=shipping`、`shipping_status=pending` | ✅ 通過 |
| E. Web 宅配管理：狀態更新 pending→accepted、物流單號／物流公司／備註儲存（`/tracking` 端點） | ✅ 通過 |
| F. 宅配查詢頁：狀態顯示、物流資訊（carrier_name/tracking_number/shipping_note）顯示正確 | ✅ 通過 |
| G. LINE 點餐回歸：外帶下單正常；外送因沙盒環境無法連線 Google Maps 地理編碼而回傳「地址座標無效」——此為既有地址驗證邏輯與外部依賴限制，非本次改動造成的回歸 | ✅（外帶）／⚠️（外送受限於測試環境，邏輯本身未變動） |
| H. LINE 點餐頁不再顯示冷藏宅配按鈕（`GET /api/line-shop` 已確認回應不含 `shipping_enabled`） | ✅ 通過 |
| I. 商家公告圖片上傳：`POST /api/uploads/image` 成功、URL 可回填、`GET /api/settings` 讀回正確、`GET /api/line-shop` 的 `announcement.image_url` 正確顯示 | ✅ 通過 |
| J. Business Calendar 回歸：`GET /api/settings/business-calendar` 正常回應 | ✅ 通過 |
| K. `node --check` 全部通過 | ✅ 通過 |

`node --check` 涵蓋：
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
public/line-shipping.html（抽出 inline JS）
public/line-order.html（抽出 2 段 inline JS）
```

---

## 七、Android

**本次未修改 Android。** 原因：

1. 目前 Android 專案（`LineOrdersFragment.kt`）的模式判斷為二元邏輯
   `val modeLabel = if (orderMode == "delivery") "🛵外送" else "🚶自取"`，
   即任何非 `delivery` 的 `order_mode`（包含 Hotfix18 新增的 `shipping`）都會被歸類為「🚶自取」，
   這是 **Hotfix18 就已存在**的既有限制，本次未新增或加劇此問題。
2. 若要正確支援「宅配」分頁、獨立狀態流程（待確認→已接單→包裝中→已出貨→已送達→已完成）、
   且讓宅配訂單不誤用外帶「可取餐」流程、不顯示外送路線按鈕，需要對 `LineOrdersFragment.kt`
   的分類邏輯、狀態機、按鈕組進行較大範圍修改，風險與工作量超出本次 Web 優先的範圍。
3. 本機沙盒的網路白名單不包含 Google Maven / Gradle 套件下載所需網域，
   即使本次修改 Android 也**無法執行 `./gradlew assembleDebug`** 進行實際組建驗證，
   為避免交付未經組建驗證的 Android 變更，決定延後處理。

**Android 宅配專屬管理（分頁篩選、獨立狀態流程、專屬按鈕組、出貨單列印）正式排入 Hotfix20。**
在 Hotfix20 之前，宅配訂單仍會寫入既有 `orders` 表並可能出現在 Android LINE 訂單列表中，
但會被顯示為「🚶自取」且可能出現不適用的「可取餐」按鈕——這是已知限制，不影響
Android 現場接單（POS 現場點餐/结帳）与既有外帶/外送 LINE 訂單功能，**兩者完全不受本次改動影響**。

---

## 八、V1/V2 已知限制（延續 Hotfix18，未變更）

1. 未串接黑貓 API；`tracking_number`/`carrier_name`/`shipping_note` 僅供手動填寫
2. 查詢頁「物流查詢」按鈕 V2 先開啟物流公司官網首頁（未串接真實貨態追蹤 API）
3. 運費規則維持單一固定運費 + 滿額免運（未做多件/分區運費）

---

## 九、輸出

- Web ZIP：`pos-web-hotfix19.zip`
- Android ZIP：本次未修改 Android，不提供
