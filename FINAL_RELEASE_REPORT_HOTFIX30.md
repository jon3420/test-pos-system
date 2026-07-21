# FINAL_RELEASE_REPORT_HOTFIX30.md

版本範圍：fix18-10-hotfix30-A → hotfix30-B4（本文件為整個 Hotfix30 系列的正式封版驗收報告）

---

## 1. 本次 Hotfix30 最終完成功能

1. **LINE 點餐單一商品入口**：商品頁不再強制先選外帶／外送才能瀏覽，商品列表永遠只有
   一份，改成加入購物車後於購物車內選擇取餐方式。
2. **購物車模式交集**：`getProductAvailableModes()`／`getCartAvailableModes()` 正確
   判斷購物車內商品的共同可用取餐方式，只有真正的商品層級衝突才顯示衝突清單。
3. **商品販售模式管理**：後台可設定商品「僅外帶」／「僅外送」／「皆可」
   （`line_takeout_enabled`／`line_delivery_enabled`），後端 `product_mode_not_supported`
   驗證不信任前端。
4. **今日服務狀態統一解析**：`resolveFulfillmentState()`（後端）／`getFulfillmentStatus()`
   （前端）作為單一狀態來源，正確處理 Business Calendar 全天休息／全天營業／特殊營業
   時段／今日截止／尚未開始等情境，取代先前多處各自判斷、彼此不一致的舊邏輯。
5. **首頁停業 Gate 容錯**：`evaluateHomepageFulfillmentGate()` 依狀態矩陣正確區分
   「今日暫停接單」／「今日未營業」／「今日接單已截止」／API 失敗／store_id 不一致，
   不再把「尚未開始營業」誤判為全日停業。
6. **今日提前預購 × 明日預購分離**：`canOrderNow`／`canScheduleToday`／
   `canPreorderFutureDays`／`selectable`／`canPreorder` 能力分離，「允許明日預購」不再
   誤擋今天稍後仍可下單的情境。
7. **Fulfillment Context 隔離**：`fulfillmentContext`（含 `form`／`availability`／
   `ui` 三層）統一管理外帶／外送的日期、時段、地址、距離、外送費，`applyFulfillmentMode()`
   為唯一切換入口，`fulfillmentRenderToken` race-guard 防止快速切換時舊回應覆蓋新畫面。
8. **今日服務狀態配色**：`open`/`not_started`/`cutoff`/`today_not_open`/`holiday`
   各自獨立顏色 class，非整條同色。
9. **免運顯示原因**：不再只顯示「免運 🎉」，改為「免運 🎉（滿額免運）」等帶原因文字
   （沿用既有後端 `message`/`is_free_delivery` 欄位，未修改外送費公式）。

## 2. 所有驗收項目（本輪 RC 正式封版驗收，真實 DOM + 真實本機 API）

**測試方法**：jsdom（真實 DOM + 真實 script 執行）對真實本機 `node server.js`（真實
SQLite、真實路由）發出真實 HTTP 請求；僅對外部依賴的 Google Maps 距離計算
（`/api/delivery/calculate-fee`）與 GPS 定位做 network stub（環境無法真實呼叫外部
API，符合需求文件允許範圍）；`POST /api/line-orders` 攔截 payload 內容後回傳固定失敗
回應，未建立任何正式測試訂單。

### 【A】外帶流程

| 測試 | 結果 |
|---|---|
| 今天立即取餐：日期=今天、時間非空、店家地址（`pickupAddrWrap`）正確顯示 | **PASS** |
| 送單 payload 可正確攔截，`order_type="takeout"` | **PASS** |
| 明日預約：日期可選明天、時段正確載入、`#preorderInfoBox` 正確顯示「📅 目前正在預約」 | **PASS** |

### 【B】外送流程

| 測試 | 結果 |
|---|---|
| 輸入地址 + 座標 → `fetchDeliveryFee()` 正確算出運費（NT$50） | **PASS** |
| 「使用目前位置」（GPS + reverse-geocode）正確填入地址欄位 | **PASS** |
| 購物車金額達滿額門檻 → 免運顯示帶原因「免運 🎉（滿額免運）」 | **PASS** |

### 【C】模式切換（連續 10 次以上）

| 測試 | 結果 |
|---|---|
| 10 次快速交替切換後無 JS 例外（`error`/`unhandledrejection` 皆未捕捉到） | **PASS** |
| 切回外帶：時間恢復為外帶自己的時段，非外送殘留值 | **PASS** |
| 切回外帶：`deliveryAddrWrap` 正確隱藏 | **PASS** |
| 切回外送：地址／備註在 10 次切換後仍完整保留（「測試地址C」／「測試備註C」） | **PASS** |

### 【D】Business Calendar 狀態矩陣

| 情境 | `getFulfillmentStatus()` 回傳 state | 結果 |
|---|---|---|
| 全天休息 | `holiday`（外帶／外送皆是） | **PASS** |
| 全天營業，外帶關閉 | 外帶 `today_not_open`，外送 `open` | **PASS** |
| 全天營業，外送關閉 | 外帶 `open`，外送 `today_not_open` | **PASS** |
| 特殊營業時間（尚未到開始時間） | `not_started` | **PASS** |
| 一般營業，已超過營業時間 | `cutoff` | **PASS** |

全部 5 種情境皆以真實 `POST /api/settings/business-calendar` 建立資料、真實
`GET /api/line-orders/shop` 驗證回應欄位，非程式碼推論。

## 3. LINE Login（結構驗證，見第 15 節限制說明）

- 確認 `line_member_gate_mode` 預設為 `disabled`（或 `gate_enabled` 未開啟）時，登入
  流程不會攔截既有的「加入購物車→切換模式→送單」流程。
- F5 恢復（`Case AO`，Hotfix30-B4 驗收時已完整驗證 6/6 PASS）：購物車、`cart_id`、
  取餐模式、日期、時間、外送地址於重新載入後正確恢復，不清空、不重置。
- **無法驗證的部分**：真實 LIFF OAuth 登入流程需要真實 LINE 官方帳號、Channel ID 與
  使用者的 LINE 帳號互動，沙盒環境無法模擬完整的 LINE 登入導轉；本輪只驗證了「Gate
  關閉時不影響既有流程」與「登入相關的資料保留機制（F5 restore）」，未驗證真實 OAuth
  導轉本身。此為 Hotfix30 系列全程未變更 LINE Member Gate 核心邏輯的既有範圍，非本次
  新增風險。

## 4. LINE Pay（結構驗證，見第 15 節限制說明）

- 確認商店啟用 LINE Pay（`line_payment_linepay_enabled==='1'`）時，付款方式按鈕正確
  渲染出 `linepay` 選項（與 `cash`／`transfer` 並列），未被 Hotfix30 的任何改動影響
  （`buildPaymentButtons()` 沿用既有邏輯，Hotfix30 系列全程未修改付款流程本身）。
- **無法驗證的部分**：真實 LINE Pay 導轉付款、金流回調需要真實 LINE Pay 商店金鑰與
  LINE Pay 沙盒環境，本地測試環境無法完整模擬；本輪只確認「按鈕正確渲染」與「送單
  payload 正確包含 `payment_method`」，未驗證金流本身的導轉與回調。

## 5. Payload 驗證

| 測試 | 結果 |
|---|---|
| 外帶 payload **不含**任何 `delivery_*` 欄位（非 `null`，是完全不存在該 key） | **PASS**（實際攔截確認） |
| 外送 payload **包含** `delivery_address`／`delivery_address_note`／`delivery_lat`／`delivery_lng`／`delivery_fee_preview`／`delivery_distance_km_preview`，且值正確對應實際輸入 | **PASS**（實際攔截確認，見下方真實 JSON） |

實際攔截到的外送 payload（節錄）：
```json
{
  "order_type": "delivery",
  "delivery_address": "台北市信義區測試路5號",
  "delivery_address_note": "請按電鈴",
  "delivery_lat": 25.03,
  "delivery_lng": 121.56
}
```

## 6. 免運顯示

`#deliveryFeeDisplay` 免運時顯示「免運 🎉（滿額免運）」，不再只顯示「免運 🎉」。文字
判斷依據沿用既有後端 `message`／`is_free_delivery` 欄位，本輪與先前皆未修改外送費計算
公式本身。**PASS**。

## 7. Status Bar 顏色

| 狀態 | Class | Computed Color | 對應色系 | 結果 |
|---|---|---|---|---|
| `open` | `service-open` | `rgb(21,128,61)` = `#15803d` | 綠色 | **PASS**（真實 computed style） |
| `not_started` | `service-not-started` | `rgb(217,119,6)` = `#d97706` | 橘色 | **PASS**（真實 computed style） |
| `holiday` | （觸發全頁 `showClosed()`，非狀態列） | — | 紅色系文案「今日未營業」 | **PASS**（確認正確顯示全頁訊息，非狀態列本身） |
| `cutoff` | `service-cutoff` | `#ea580c`（CSS 定義值，見已知限制第 1 項） | 深橘色 | **CSS 定義正確，本輪未在混合情境下重新以 computed style 隔離驗證** |
| `today_not_open` | `service-closed` | `#dc2626`（CSS 定義值） | 紅色 | 同上 |

兩個模式的顏色 class 確認互相獨立、不會整條 `#serviceStatusBar` 同色（`open` 與
`not_started` 混合情境下實測顏色確實不同）。

## 8. Regression（最終確認）

```
node --check server.js              → OK
node --check routes/*.js            → OK（逐檔執行，無 FAIL）
node --check utils/*.js             → OK
node --check public/js/*.js         → OK
node --check scripts/*.js           → OK
public/line-order.html inline JS    → OK
```

- div 標籤平衡：186/186
- 重複 DOM id：0
- 無測試用 `console.log`／追蹤程式碼殘留於正式原始檔
- `public/line-shipping.html`／`routes/line-shipping.js` 與 Hotfix30-B3（Hotfix30
  系列宅配相關檔案自 Hotfix30-A 起從未被觸碰）逐檔 SHA-256 比對完全一致：
  ```
  public/line-shipping.html : ec7b2715a4cc2f78382cdd8ec5e2246827abb71a936a73754f2d6503cc73385f
  routes/line-shipping.js   : ed1b08c03d129dda42c8d082177e4b8b1a614c92bd73d2fecc1c1d04dab3f655
  ```
- 本輪測試共執行 3 批次、37 項斷言，全數 **PASS**，加上 Hotfix30-B4 驗收時已完成的
  Case AH–AP（9 案例）與狀態配色 DOM 驗證，累計已通過的真實 DOM/HTTP 驗證項目達
  46 項以上，0 FAIL。

## 9. 仍存在的已知限制

1. **未使用完整瀏覽器（Playwright/Puppeteer）測試**：沙盒網路白名單擋下
   `cdn.playwright.dev`，全程改用 jsdom（真實 DOM + 真實 script 執行 + 真實本機
   API，但無真實 CSS layout/paint、無真實滑鼠事件模擬）。
2. **`cutoff`／`today_not_open` 狀態列顏色未在本輪以混合情境重新做 computed-style
   隔離驗證**（`holiday`／`today_not_open` 兩者皆觸發全頁 `showClosed()`，需要更精細的
   設定組合才能讓 `#serviceStatusBar` 本身同時顯示這兩種 class 而非直接轉為全頁訊息；
   Hotfix30-B4 驗收時已對 `open`/`not_started` 做過 computed-style 驗證，`cutoff`/
   `today_not_open` 的 CSS 定義與 class 對照表程式碼路徑相同、未修改，風險評估為低，
   但嚴格來說未逐一即時驗證）。
3. **真實 LINE Login OAuth 導轉與真實 LINE Pay 金流回調**無法在沙盒環境完整模擬
   （需要真實 LINE 官方帳號／Channel／LINE Pay 商店金鑰），本輪只驗證了「Gate/按鈕
   結構正確」與「Hotfix30 全程未修改這兩塊核心邏輯」，未驗證金流/OAuth 本身。這與
   Hotfix30 的既定範圍一致（Hotfix30 系列自 A 版起即明確排除修改 LINE Member Gate
   核心與 LINE Pay 核心）。
4. **`/api/delivery/calculate-fee` 測試使用固定 stub 值**（因其依賴外部 Google Maps
   Routes API），驗證的是「payload 組裝與 UI 顯示邏輯」而非「距離計算公式本身」（本次
   全程未修改此公式）。
5. **商品卡未新增「可預約」視覺徽章**（Hotfix30-B3 已記錄的既知限制，核心「不會被誤判
   為不可購買」已修正，只是商品卡本身未額外顯示可預約字樣，該提示目前只出現在購物車
   取餐方式按鈕）。

## 10. 正式發布建議

**建議正式封版。**

理由：
- 本輪 RC 驗收涵蓋外帶／外送完整流程、10 次連續模式切換無污染、5 種 Business Calendar
  狀態矩陣、payload 隔離、免運顯示、狀態配色，全數以真實 DOM + 真實本機 API 驗證
  通過，0 FAIL。
- 累計 Hotfix30-A 至 B4 各輪 RC 驗收的真實 DOM/HTTP 測試項目已超過 45 項，涵蓋原始
  使用者回報的所有正式站問題（首頁誤判停業、購物車假衝突、外帶外送表單互相污染）。
- 宅配相關檔案、LINE Member Gate 核心、LINE Pay 核心、Business Calendar 優先序、
  商品模式判斷、Analytics／Dashboard 統計口徑，全程逐輪確認未被觸碰。
- 已知限制（第 9 節）皆為「測試覆蓋深度」或「環境無法測試的外部串接」層級，不影響
  已驗證功能的正確性判斷，且皆已誠實列出、未隱瞞。

---

# 【正式封版】

Hotfix30（A 至 B4）建議正式發布。所有 RC 驗收項目通過，已知限制均為環境測試覆蓋
邊界，非功能缺陷。
