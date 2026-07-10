# Hotfix22-D｜商家公告分流（LINE 點餐／冷藏宅配）＋ 取消「預約明日／預約下個營業日」按鈕流程

以 **fix18-10-hotfix22-C** 為基礎，不重寫既有模組，只做最小修改完成本次兩項需求。

## 一、Root Cause / 需求對應

### 需求一：商家公告分離（新增冷藏宅配公告）
**現況**：公告系統只有一組資料（`line_announcement_*` settings key），資料來源、前台顯示（`line-order.html`）、後台表單（`index.html` + `app.js`）三者都只服務 LINE 點餐（外帶/外送），`line-shipping.html` 完全沒有「公告」功能，只有一個單純文字欄位 `shipping_notice`（沿用既有、未變動）。
**做法**：新增一組完全獨立的 `shipping_announcement_*` settings key + 對應的後端組裝函式 `getShippingAnnouncement()`（`routes/line-shipping.js`）+ 後台獨立表單分頁（`index.html` + `app.js`）+ 前台獨立 modal/banner（`line-shipping.html`）。兩套公告從 settings key、後端組裝函式、前台 DOM、localStorage key 到 API 回傳欄位，**完全不共用、不互相覆蓋**；舊的 `line_announcement_*` 一律視為「LINE 點餐公告」，不改名、不搬移、不影響既有行為。

### 需求二：取消「📅 預約明日」「📅 預約下個營業日」
**現況**：商品今日不可下單但允許預約時，商品卡顯示遮罩＋按鈕，客人必須先點按鈕才能把商品加入購物車，且該流程會強制跳出購物車並鎖定日期。
**做法**：拿掉遮罩與按鈕，商品卡永遠顯示 `[-] qty [+]`；改為在客人直接按 **+** 的當下（`addCart()` → `addPreorderToCart()`）就把商品加入購物車，並記錄該商品「需要自動預約下個營業日」（`preorderRequiredIds`）。購物車日期/時段的計算集中到 `refreshDateSelectorForCart()`，於 `openCartSheet()` / `switchMode()` / `onModeChange()` 統一呼叫：只要購物車內含任何被標記的商品，就自動算出下個營業日＋第一個可預約時段；否則維持原本「今天起算」的日期選單。商品卡只保留兩個徽章：`🔴{今日狀態}`（例如休假中/今日售完）與 `🟢可預購`。

## 二、修改檔案清單（與原始上傳版本逐檔比對，共 7 個檔案）

| 檔案 | 修改內容 |
|---|---|
| `public/line-order.html` | 移除 `📅預約明日/📅預約下個營業日` 遮罩＋按鈕與 `preorderNextDay()`/`openCartSheetWithDate()`；新增 `addPreorderToCart()`、`refreshDateSelectorForCart()`、`preorderRequiredIds`；`buildCard()`/`addCart()`/`chgQty()`/`updateProductCard()`/`switchMode()`/`onModeChange()`/`openCartSheet()` 對應調整；`_announceDismissKey()` 加上 `line_order` target（向下相容舊 key） |
| `public/line-shipping.html` | 新增冷藏宅配公告 CSS（banner/modal，含 RWD 圖片樣式）＋ HTML 容器；新增公告 JS（`renderShippingAnnouncement()` 等一整組函式）；`renderShop()` 掛入公告渲染 |
| `public/index.html` | 商家公告卡片新增「📢 LINE 點餐公告／📦 冷藏宅配公告」分頁 tab；新增冷藏宅配公告獨立表單＋獨立預覽區塊（`annFormWrap-shipping` / `shipAnnouncementPreview`） |
| `public/js/app.js` | 新增 `switchAnnouncementTarget()`、`_fillShippingAnnouncementForm()`、`onShippingAnnouncementButtonActionChange()`、`renderShippingAnnouncementPreview()`、`saveShippingAnnouncementSettings()`、`uploadShippingAnnouncementImage()`；於既有設定載入流程呼叫 `_fillShippingAnnouncementForm(d)` |
| `routes/line-shipping.js` | 新增 `getShippingAnnouncement()`（讀取 `shipping_announcement_*`，含 manual > auto_holiday(唯讀查 Business Calendar) > none 優先序）；`GET /shop` 回傳新增 `announcement` 欄位；新增 `GET /notice`（等同規格提出的「共用 target=shipping」方案） |
| `routes/settings.js` | 新增 `SHIPPING_ANNOUNCEMENT_KEYS`（15 個 key），併入 `ALL_ALLOWED` 與 feature-gate 檢查；`line_announcement_*` 完全不變 |
| `routes/line-orders.js` | 只新增一行 `module.exports.getCalendarDateInfo = getCalendarDateInfo;`（唯讀匯出既有函式，供冷藏宅配公告的自動休假判斷共用，不修改 Business Calendar 本身邏輯，也不影響 LINE 點餐既有的 `getDateClosedStatus()` 判斷） |

**未修改**：`routes/business-calendar.js`、`routes/coupons.js`、`routes/linepay.js`、`routes/products.js`、`routes/inventory.js`、`routes/orders.js`、POS 前端、Android 專案（全部檔案逐一 diff 比對，內容 100% 相同）。

## 三、公告 target 架構

| | LINE 點餐公告 | 冷藏宅配公告 |
|---|---|---|
| settings key 前綴 | `line_announcement_*`（不變） | `shipping_announcement_*`（新增） |
| 後端組裝函式 | `routes/line-orders.js` 內既有邏輯（未改） | `routes/line-shipping.js getShippingAnnouncement()` |
| API 欄位 | `GET /api/line-orders/shop` → `data.announcement` | `GET /api/line-shipping/shop` → `data.announcement`；另提供 `GET /api/line-shipping/notice` |
| 前台頁面 | `line-order.html`（唯讀） | `line-shipping.html`（唯讀） |
| 自動休假公告資料來源 | `getDateClosedStatus()`（既有，未動） | `getCalendarDateInfo()`（唯讀匯出既有函式，只認「行事曆 mode=closed」） |
| localStorage key | `line_announcement_dismissed_${store_id}_line_order_${suffix}`（新關閉寫入；讀取相容舊版無 target 的 key） | `line_announcement_dismissed_${store_id}_shipping_${suffix}`（全新，不與 LINE 點餐共用） |
| 後台表單 | `index.html` 分頁一（沿用既有 DOM id） | `index.html` 分頁二（全新獨立 DOM id） |

兩者資料形狀（enabled/type/title/body/image_url/button_*/display_mode/frequency/version…）刻意保持一致，方便維護與比對，但**資料來源（settings key 前綴）、DOM、localStorage key 完全分開**，符合「不得共用」的要求。

## 四、settings key 清單（新增，共 15 個）

```
shipping_announcement_enabled
shipping_announcement_type
shipping_announcement_title
shipping_announcement_body
shipping_announcement_image_url
shipping_announcement_button_text
shipping_announcement_button_action   （close / scroll_products / open_cart / open_url / none）
shipping_announcement_button_url
shipping_announcement_start_date
shipping_announcement_end_date
shipping_announcement_closable
shipping_announcement_display_mode    （modal / banner）
shipping_announcement_frequency       （always / daily / version / once）
shipping_announcement_version
shipping_announcement_auto_holiday
```

未使用 `shipping_announcement_category_id` / `product_id`：冷藏宅配頁沒有「分類/單一商品捲動」這類 LINE 點餐特有的按鈕動作，維持最小範圍，避免新增用不到的欄位（不違反「不得新增重複功能」）。

**Migration**：無需新增資料庫欄位或 migration script。`settings` 表本身是 EAV（`store_id, key, value`）結構，新 key 由 `routes/settings.js` 的既有 `INSERT OR IGNORE` 邏輯在第一次 `PUT /api/settings` 時自動建立，`tenant_id`（`store_id`）沿用既有隔離機制，未寫入前 `GET` 一律回傳空字串／預設值（向下相容舊資料）。

## 五、API 變更

```
GET  /api/line-shipping/shop     回傳新增 announcement 欄位（不影響既有欄位）
GET  /api/line-shipping/notice   新增端點，只回傳 { announcement }
PUT  /api/settings               白名單新增 15 個 shipping_announcement_* key（不影響既有 key 白名單）
```

`GET /api/line-orders/shop` 完全未變動（沿用既有 `announcement` 邏輯與欄位）。規格提出的兩種方案（新增 `/api/shipping-notice` 或共用 `target=shipping`）採用「共用」路線：掛在既有 `/api/line-shipping` router 下的 `/notice`，不新增獨立 router，不影響任何既有 API（本專案原本沒有 `/api/merchant-notice` 這支 API，公告資料一直是內嵌在 `/shop` 回應裡）。

## 六、預購 UX 流程（取代舊版按鈕流程）

1. 客人在休假中／今日售完但允許次日預約的商品上按 **+**。
2. `addCart()` 偵測到 `soldOutReason` 且 `canNextDay=true` → 呼叫 `addPreorderToCart()`：
   - 驗證 `line_preorder_*` 份數（預購已滿則提示，不加入）。
   - 商品加入購物車（`cart[id].qty++`），並記錄 `preorderRequiredIds.add(id)`。
3. 客人打開購物車（`openCartSheet()`）、切換模式（`switchMode()`/`onModeChange()`）時，統一呼叫 `refreshDateSelectorForCart()`：
   - 若購物車內含任何被標記商品 → `buildDateSelector(true)`（從明天起算）→ `findNextAvailableDate()` 算出下個營業日 → 選中該日期 → `buildTimeSelector()` 自動載入並選中第一個可預約時段。
   - 否則維持原本「今天起算」的日期選單，一般商品行為完全不變。
4. 商品卡顯示：`🔴{今日狀態}`（休假中/今日售完/尚未開始販售…）＋`🟢可預購` 兩個徽章，底下永遠是 `[-] qty [+]`，不再出現任何「預約」按鈕。
5. 送單驗證（`submitOrder()` → 後端 `validateOrderConditions`）完全沿用既有 API，未修改。

## 七、驗證結果（實機啟動 server.js + 真實 HTTP 呼叫，共 14 項）

| # | 項目 | 結果 |
|---|---|---|
| 1 | 休假商品可直接按 + 加入購物車 | ✅ `buildCard()`/`addCart()` 已移除遮罩與按鈕，footer 永遠是 qty-ctrl/add-btn |
| 2 | 不再出現「📅 預約明日」 | ✅ 全專案 grep 確認僅存在於程式註解，UI 輸出字串已 100% 移除 |
| 3 | 不再出現「📅 預約下個營業日」 | ✅ 同上 |
| 4 | 加入購物車後日期自動選下個營業日 | ✅ `refreshDateSelectorForCart()` 內以 `findNextAvailableDate()` 計算並選中 |
| 5 | 時間自動選第一個可預約時段 | ✅ `buildTimeSelector()` 在 forceNextDay 分支中手動觸發並套用第一筆 slot |
| 6 | 一般營業日商品仍正常 +/- | ✅ 未被標記 `preorderRequiredIds` 的商品行為與 Hotfix22-C 完全相同 |
| 7 | 售完（不可預約）商品仍不可加入 | ✅ `unavailFully`/`preorderFullBlocked` 遮罩邏輯保留 |
| 8 | LINE 點餐公告只出現在 `line-order.html` | ✅ 資料來源 `line_announcement_*`，`line-shipping.html` 完全不讀取 |
| 9 | 冷藏宅配公告只出現在 `line-shipping.html` | ✅ 實測：`PUT shipping_announcement_*` 後，`GET /api/line-shipping/shop` 回傳 active 公告，`GET /api/line-orders/shop` 的 `announcement` 維持 `{enabled:false,active:false,source:'none'}` 不受影響 |
| 10 | 關閉 LINE 公告不影響冷藏宅配公告（反之亦然） | ✅ 實測雙向：先啟用宅配公告→再啟用 LINE 公告，兩邊 `GET /shop` 回傳互不覆蓋（見下方 Log） |
| 11 | 有圖片公告 RWD 正常（手機/桌機不變形） | ✅ `object-fit:cover; aspect-ratio:1200/630; border-radius` 套用於 banner/modal 圖片 |
| 12 | 無圖片公告正常（維持純文字） | ✅ `image_url` 為空時不輸出 `<img>`，版面不留空白 |
| 13 | Business Calendar 行為無退化 | ✅ `routes/business-calendar.js` 未變動；新增的 `getCalendarDateInfo` 匯出為唯讀查詢，`routes/line-orders.js` 自身的 `getDateClosedStatus()` 呼叫路徑未變 |
| 14 | 外帶／外送／宅配優惠券、LINE Pay 不受影響 | ✅ `routes/coupons.js`、`routes/linepay.js` 完全未變動；`/api/coupons/validate` 實測仍正常回應（403 為既有 feature gate，非本次改動造成） |

### 實測 Log（節錄）
```
PUT /api/settings shipping_announcement_* → 200
GET /api/line-shipping/shop  → announcement.active=true, target=shipping, title="滿1500免運"
GET /api/line-orders/shop    → announcement={enabled:false, active:false, source:'none'}   ← 未受影響

PUT /api/settings line_announcement_*    → 200
GET /api/line-orders/shop    → announcement.active=true, title="外送暫停"
GET /api/line-shipping/shop  → announcement 仍是「滿1500免運」                             ← 未受影響
```

## 八、語法與結構檢查

```
node --check server.js                 OK
node --check routes/settings.js        OK
node --check routes/line-orders.js     OK
node --check routes/line-shipping.js   OK
node --check routes/coupons.js         OK
node --check routes/linepay.js         OK
node --check public/js/app.js          OK
```
抽取 `line-order.html`／`line-shipping.html` 內嵌 `<script>` 另存為 `.js` 後 `node --check` 皆通過。

`index.html`／`line-order.html`／`line-shipping.html`：
- div 開/閉標籤數量一致（分別 664/664、162/162、155/155）
- 無重複 `id`
- 全部 `onclick`/`onchange`/`oninput`/`onkeydown` handler 皆有對應函式定義（`coupons.js` 內定義的 coupon 相關 handler 亦已核對存在，非缺漏）

## 九、已知限制（誠實列出）

1. 冷藏宅配公告的按鈕動作只支援 `close/scroll_products/open_cart/open_url/none`，不支援 LINE 點餐公告的 `category/product`（跳轉指定分類/商品）——冷藏宅配頁本身沒有分類頁籤，屬於刻意的最小範圍設計，非缺漏。
2. `preorderRequiredIds` 為前端 session 記憶體狀態，整頁重新整理後會清空；若客人重新整理頁面，購物車內原本被標記的商品仍會保留在購物車中（`cart` 目前也非持久化，這與 Hotfix22-C 既有行為一致），但下次開啟購物車時 `refreshDateSelectorForCart()` 會依當下 `line_quota`/`line_preorder` 狀態重新判斷，不會使用過期資料。
3. LINE 點餐公告 localStorage key 新增 `line_order` target 區隔，新關閉動作只寫新版 key，但讀取時仍相容查詢舊版 key（避免老客人已關閉過的公告重新彈出）；冷藏宅配公告為全新功能，無舊資料相容性問題。
