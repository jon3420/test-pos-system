# fix18-10-hotfix22-F｜LINE 外帶外送宅配購物車永久保留 × 商品卡狀態辨識

## 一、修改檔案
- `public/line-order.html`（LINE 外帶／外送）
- `public/line-shipping.html`（冷藏宅配）
- 未修改：POS、Android、Business Calendar、LINE Pay API（`routes/linepay.js`）、優惠券核心、訂單資料表、商品資料表、老闆儀表板、Conversion Analytics、`server.js`、任何 `routes/*.js`。

## 二、localStorage key（各通路獨立，不共用）
- 外帶／外送：`line_order_cart_${store_id}`
- 冷藏宅配：`line_shipping_cart_${store_id}`
- 另有共用（非通路專屬）：`line_visitor_id`（localStorage，永久）、`line_session_id`（sessionStorage，關閉分頁即結束）

## 三、保存欄位（統一基礎格式 v1）
```json
{
  "version": 1,
  "store_id": "store_001",
  "session_id": "",
  "visitor_id": "",
  "cart_created_at": 0,
  "cart_updated_at": 0,
  "cart": { "商品ID": "數量" },
  "order_mode": "takeout | delivery | shipping",
  "customer": { "name": "", "phone": "" },
  "coupon_code": "",
  "pickup_date": "",
  "pickup_time": "",
  "payment_method": "",
  "order_note": ""
}
```
外帶／外送在 `customer` 內額外保存 `delivery_address` / `delivery_address_note`。
冷藏宅配額外保存：`arrival_type`、`arrival_date`、`postal_code`、`city`、`district`、`address`、`address_note`。
- `session_id` / `visitor_id` / `cart_created_at` / `cart_updated_at`：**目前只存不分析**，預留給未來 Conversion Analytics（AddToCart / BeginCheckout / Purchase）串接使用。
- 折扣金額、商品價格/名稱/圖片**一律不存**，還原時強制重新取得最新資料，避免用到過期或被竄改的金額。

## 四、清除條件（三通路完全統一）
只有以下情況會清空購物車（含 localStorage）：
1. 一般訂單成功建立（現金／轉帳／其他非 LINE Pay 立即確認的付款方式）
2. LINE Pay **Confirm 成功**（頁面帶 `linepay=success` 導回時才清除，而不是送出 LINE Pay 請求或導轉當下）
3. 使用者主動按購物車視窗右上角「🗑️ 清空購物車」
4. 商品已刪除／停用／LINE 未上架 → 只移除該項商品，其餘商品保留
5.（保留擴充）商家後台手動清除 — 本版未提供後台清除按鈕，介面/API 待下一版

以下情況**不會**清空：F5、關閉瀏覽器、關閉 LINE 內建瀏覽器、重新開啟、任意時間長度（無 TTL）、LINE Pay 取消、LINE Pay 失敗、API 錯誤、日期或時段失效。

## 五、TTL 移除位置
- `public/line-shipping.html`：移除 `SHIP_CART_TTL_MS = 24 * 60 * 60 * 1000` 常數，以及 `restoreCart()` 內 `(Date.now() - data.savedAt) > SHIP_CART_TTL_MS` 到期判斷與對應 `clearCartStorage()`。`savedAt` 欄位保留於資料結構中僅供相容舊資料，不再參與任何清除判斷。
- `public/line-order.html`：原本就沒有購物車 localStorage 持久化（每次關閉分頁即清空），本次是**新增**永久保留機制，同樣未加入任何 `expires_at` / 24hr 判斷。

## 六、LINE Pay 成功／取消／失敗行為
- 送出 `/api/linepay/request` 並取得 `payment_url` 準備導轉時：**不清空**購物車，只呼叫 `persistCart()` 確保最新狀態已寫入 localStorage。
- 導回頁面帶 `linepay=success`：呼叫 `clearCartStorage()`，這是唯一因 LINE Pay 而清空購物車的時機。
- 導回頁面帶 `linepay=cancel` 或 `linepay=fail` / `linepay=error`：只顯示 toast 提示，不清空，並繼續走一般初始化流程，`restoreCart()` 會把購物車還原回來。
- 未修改 `routes/linepay.js`（LINE Pay API 本身），只調整前端在什麼時機呼叫 `clearCartStorage()` / `persistCart()`。

## 七、商品失效處理
- 還原購物車前，先呼叫既有 API 取得最新商品清單（`/api/line-menu`、`line-shipping` 的 `SHOP_DATA.products`），localStorage 只提供「商品 ID → 數量」。
- 商品 ID 在最新清單中找不到（代表已刪除／停用／LINE 未上架，後端 API 已排除）→ 只移除該項商品，並 toast 提示移除件數；其餘商品全部保留。
- 商品僅「今日售完／休假中／未到販售時間／已過接單時間／目前模式關閉」等**暫時性**狀態，不會被移除，仍保留在購物車，並在商品卡上以狀態列顯示目前不可下單。
- 商品名稱、價格、圖片、描述一律採還原當下的最新 API 資料，不使用 localStorage 內的舊值。

## 八、日期／時段恢復規則
- 一律先以「今天」重新產生完整日期選單／到貨日期範圍（沿用既有今日臨時休息、今日最後接單、Business Calendar、每週營業時間判斷，未另寫新規則）。
- 外帶／外送：還原日期若仍是選單中未停用的選項才套用；否則自動落在目前模式下一個可預約日期，時段則落在該日期第一個可用時段，並 toast「⏰ 原預約日期或時段已失效，已更新為下一個可用時段」。**不清空商品**。
- 冷藏宅配：還原到貨日期若超出目前 `earliest_date` ~ `latest_date` 範圍，自動改為最早可到貨日期，並 toast「⏰ 原到貨日期已超出可選範圍，已更新為最早可到貨日期」。**不清空商品**。

## 九、優惠券恢復
- 只保存 `coupon_code`，還原時一律重新呼叫既有 `/api/coupons/validate`，不信任 localStorage 內的折扣金額。
- 驗證失敗（過期／停用／未達門檻／使用次數已滿等）：只清除優惠券並 toast「原優惠券目前已失效，購物車商品已保留」，**不影響購物車商品**。

## 十、保存時機（涵蓋動作）
`persistCart()` 立即呼叫：商品卡 +／-、購物車內增減、移除商品（數量到 0）、切換外帶／外送、選擇日期、選擇時間、選擇付款方式、套用優惠券、清除優惠券、系統自動改為下一可用日期／時段（`refreshDateSelectorForCart()` / `applyDateTimeToCartSheet()`）、`preorderRequiredIds` 變動（透過 `addPreorderToCart()` / `chgQty()`）。
姓名、電話、地址、地址備註、訂單備註等文字輸入框改用 400ms debounce（`debouncedPersistCart()`），避免每個按鍵都寫入 localStorage，但仍保證停止輸入後會存到。

## 十一、商品卡視覺規則（`public/line-order.html`）
- 不可立即購買時，**只讓照片變暗**（`filter: brightness/saturate`），商品名稱、說明、價格維持正常顯示（移除舊版整卡覆蓋式 `.sold-mask`）。
- 照片下方固定保留一排「狀態列」（`.status-row`，`min-height:20px`），顯示「休假中／今日售完／可預購」等狀態，無狀態時保留空列，避免商品卡高度跳動、版面錯位。
- 行銷標籤：左上主緞帶＋右上小膠囊，最多顯示 2 個，疊在照片上不佔版面；預設優先順序 **優惠 > 新品 > 店長推薦 > 熱銷**。本版僅支援既有商品資料表欄位 `line_promo`（優惠）／`line_hot`（熱銷）；「新品」「店長推薦」需要商品資料表新增欄位才能支援，依規範本輪**不修改商品資料表**，故暫緩，延後至下一版與後台自訂名稱/排序功能一起處理。

## 十二、程式檢查結果
- `node --check server.js`：通過
- `node --check routes/*.js`（全部檔案逐一檢查）：通過
- `node --check public/js/*.js`：通過
- `line-order.html` / `line-shipping.html` 內嵌 `<script>` 抽出後以 `node --check` 驗證：通過
- HTML `<div>` / `</div>` 標籤數量比對：`line-order.html` 164/164、`line-shipping.html` 156/156，平衡
- 兩檔案 DOM id 重複檢查：無重複
- 兩檔案 HTML 事件屬性（onclick/oninput/onchange/onkeydown）引用的函式名稱，均已在對應檔案中定義（僅 `debouncedPersistCart` 以 `const` 宣告而非 `function` 關鍵字，已人工確認存在）
- 全文搜尋 `SHIP_CART_TTL_MS`、`24hr`、`24 * 60 * 60`、到期自動清除判斷：僅存在於註解說明「已移除」，程式邏輯中已無任何相關判斷
- ZIP 內容確認不含 `node_modules`、`.env`、任何 `.db` / `.sqlite` 測試資料庫檔案

## 十三、驗收結果（人工程式碼審查，非實機測試）
| 項目 | 結果 |
|---|---|
| 外帶加入商品，F5 後仍在 | ✅ `restoreCart()` 於 `init()` 內執行，商品依 id 從最新 `allProducts` 重建 |
| 外送加入商品，F5 後仍在 | ✅ 同上，並還原 `order_mode`、外送地址 |
| 關閉 Chrome / LINE 內建瀏覽器再開仍在 | ✅ 資料存於 localStorage，非 sessionStorage，且無 TTL |
| 冷藏宅配超過模擬 24 小時仍在 | ✅ `SHIP_CART_TTL_MS` 與到期判斷已完全移除 |
| 不存在任何 TTL 判斷 | ✅ 全文搜尋確認 |
| 模式（外帶/外送）正確恢復 | ✅ 一律沿用 localStorage 保存的 `order_mode`；即使該模式目前被店家關閉，也**不會**自動切回另一個開放中的模式（詳見下方「十五、最後補正」） |
| 姓名、電話、地址、備註仍在 | ✅ |
| 日期、時間仍在（有效時） | ✅ |
| 日期/時間失效自動更新 | ✅ 並 toast 提示，不清空商品 |
| 優惠券重新驗證 | ✅ 一律呼叫 `/api/coupons/validate`，不信任舊折扣金額 |
| 商品價格採最新 API | ✅ 還原時以 `allProducts` / `findProduct()` 查找最新資料，只採用 localStorage 的數量 |
| 商品下架只移除該商品 | ✅ 找不到對應 id 就跳過該項，其餘保留，並提示移除件數 |
| 暫時售完不自動移除 | ✅ 只在商品「完全不存在於最新清單」時才移除，售完/休假等暫時狀態維持在購物車並顯示狀態 |
| 一般訂單成功清空 | ✅ |
| LINE Pay 成功清空 | ✅ 僅於 `linepay=success` 導回時清空 |
| LINE Pay 取消/失敗不清空 | ✅ 已移除送出 Request 前的提前清空 |
| 不同 store_id 完全隔離 | ✅ key 內含 `store_id`，兩通路 key 前綴不同、互不共用 |
| 冷藏宅配其他流程不受影響 | ✅ 僅調整購物車保存/還原/清除相關函式，未觸碰商品渲染、下單、物流查詢等其他邏輯 |
| 商品卡變暗與標籤排列不破版 | ✅ CSS 採固定高度 `.prod-img-wrap`（110px）與 `.status-row`（min-height:20px），標籤為絕對定位疊加於照片上，不影響版面流動 |
| 手機三欄 / 桌機版不破版 | ⚠️ 僅完成程式碼審查與語法檢查，**未在真實瀏覽器/裝置實機測試畫面呈現**，建議上線前人工檢視一次 |

## 十四、已知限制
1. 「新品」「店長推薦」行銷標籤因需要商品資料表新增欄位，依規範本輪不修改商品資料表，暫緩至下一版（連同後台自訂名稱/排序/啟用/最多顯示數量一起處理）。
2. 「商家手動清除購物車」目前僅止於保留清除條件的設計位（`clearCartStorage()` 可被任意呼叫），未提供後台介面或 API 供商家對指定顧客購物車遠端清除；如需此功能請於下一版另行規劃。
3. 本次驗收為程式碼靜態審查 + Node.js 語法檢查，並非實機瀏覽器測試；正式上線前建議實際在手機瀏覽器（含 LINE 內建瀏覽器）操作一次完整流程再確認。
4. `visitor_id` / `session_id` 僅在前端產生與儲存，尚未接上任何後端 Analytics 事件或報表，純粹是本版預留的資料欄位。

## 十五、最後補正：模式（外帶/外送）被關閉時不得自動切換

**問題**：原版 CHANGELOG 誤寫「模式關閉時退回預設模式」，且原程式碼 `restoreCart()` 確實只在 `order_mode` 對應的模式仍開放時才套用，否則靜默改用 `init()` 算好的另一個開放模式——這與需求不符，已修正。

**修正後正確行為**（只改 `public/line-order.html`，未修改冷藏宅配、Business Calendar、LINE Pay、優惠券等）：
1. `localStorage` 儲存 `order_mode=delivery` 時，重新進入永遠維持 `delivery`（`init()` 內新增 `_peekSavedOrderMode()`，在決定預設模式前先讀取 localStorage，一律優先套用保存的模式）。
2. 即使目前 `delivery` 已被店家關閉（`delivery_status.enabled=false`），也**不會**自動切回 `takeout`；新增 `modeForcedVisible` 旗標，讓原本「只剩一種模式開放就隱藏頁籤並強制切換」的 `buildModeTabsUI()` 邏輯改為：只要目前模式是使用者/購物車保留下來的，頁籤永遠保持可見。
3. 商品、顧客資料（姓名/電話/外送地址/備註）、優惠券**完全不受影響**，正常還原保留。
4. 新增 `#modeUnavailableBanner` 橫幅，模式關閉時顯示「🔴 外送目前未開放，購物車內容已為您保留，請切換至外帶下單，或稍後再試。」（`updateModeAvailabilityUI()`）。
5. `buildDateSelector()` 新增守衛：目前模式未開放時，日期/時段選單只會出現一個 `disabled` 的「外送目前未開放」提示選項，不會產生任何可選（可送單）的日期或時段。
6. 送出按鈕（`#subBtn`）在模式未開放時自動 `disabled=true` 並改文字為「外送目前未開放」；`submitOrder()` 內也另外加一道相同判斷作為保險，雙重防止誤送單。
7. 使用者可隨時點擊「🛍️ 外帶」頁籤或購物車內的取餐方式下拉選單，自行切換到目前開放的模式（`switchMode()` / `onModeChange()`）。
8. 只有使用者**主動**切換模式時，`persistCart()` 才會把新的 `order_mode` 寫回 localStorage；系統本身絕不會替使用者切換並保存新模式。
9. 外帶模式若被關閉，套用完全相同的規則（雙向對稱，非只針對外送特例處理）。
10. 全程都不會因為模式關閉而清空商品、優惠券、或顧客資料——這些資料的清除條件仍只有第四節列出的五種情況。

**同步調整**：
- `openCartSheet()` 內購物車表單的取餐方式下拉選單，改為固定顯示「外帶／外送」兩個選項（並標註「(未開放)」/「(已截止)」），不再依 `enabled` 動態拿掉整個選項，避免使用者看不到自己原本選的模式。
- `refreshShopStatus()`（每 60 秒定時輪詢）新增追蹤 `takeoutEnabled` / `deliveryEnabled` 本身的變化（先前只追蹤 `cutoff_passed`），確保顧客瀏覽期間店家臨時關閉某模式時，畫面能即時反映「未開放」狀態，但同樣不會自動切換 `currentMode`。

**重新驗證結果**：
| 驗證項目 | 結果 |
|---|---|
| 儲存外送模式（`order_mode=delivery`） | ✅ `persistCart()` 寫入 localStorage |
| 後台關閉外送（模擬 `delivery_status.enabled=false`） | ✅ |
| 重新進入頁面 | ✅ `init()` 讀取 `_peekSavedOrderMode()` |
| 仍停留在外送 | ✅ `currentMode` 維持 `'delivery'`，未被 `buildModeTabsUI()` 強制改回外帶 |
| 顯示外送目前未開放 | ✅ `#modeUnavailableBanner` 顯示提示文字，送單按鈕停用 |
| 購物車仍存在 | ✅ 商品/優惠券/顧客資料/外送地址皆正常還原，未被清空 |
| 日期/時段不產生可送單選項 | ✅ `buildDateSelector()` 守衛只輸出一個 disabled 提示選項 |
| 切換外帶後才恢復可下單 | ✅ 點擊「🛍️ 外帶」頁籤或下拉選單切換後，`isCurrentModeAvailable()` 為 true，banner 隱藏、送單按鈕恢復、日期/時段恢復正常選單；此時才呼叫 `persistCart()` 更新保存的 `order_mode` |

**程式檢查**：`node --check`（抽出 `line-order.html` 內嵌 `<script>`）通過；HTML `<div>`/`</div>` 標籤數量 165/165 平衡；DOM id 檢查無重複。

**已知限制**：此驗證同樣為程式碼審查 + 語法檢查，未在實機瀏覽器操作驗證畫面呈現與互動手感，建議上線前實機測試一次「保存外送 → 後台關閉外送 → 重新整理 → 看到未開放 → 切回外帶 → 正常下單」的完整流程。
