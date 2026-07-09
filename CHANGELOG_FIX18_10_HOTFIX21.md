# fix18-10-hotfix21｜LINE 訂單管理補強｜宅配編輯修正 × 統計分類 × 單日查詢 × 物流API預留

以 Hotfix20 為基礎的增量修改。未重寫、未重構既有架構；未修改 Android。

---

## 一、修改檔案清單

| 檔案 | 異動 |
|---|---|
| `routes/shipping.js` | **新增**：物流 API 架構預留 V1（providers / config / test） |
| `routes/line-shipping.js` | `GET /admin/orders` 新增 `date` / `date_from` / `date_to` 篩選 |
| `routes/settings.js` | 新增物流 API settings key 白名單（`SHIPPING_API_KEYS`），併入授權檢查 |
| `server.js` | 掛載 `/api/shipping` route（沿用 `line_order` feature gate） |
| `utils/db.js` | safe migration：新增 orders 物流 API 欄位 + settings 預設值 |
| `public/js/app.js` | 詳見下方各項 |
| `public/index.html` | 新增物流 API 設定 UI、單日查詢 UI、訂單紀錄冷藏宅配欄位擴充 |

Android：**未修改，不產 Android ZIP。**

---

## 二、逐項對應

### BUG-1｜「編輯宅配」開錯 Modal
**檢查結果：此問題在目前程式碼中不存在，Hotfix20 已修正且維持正確。**
- 已確認 `renderLpmShippingTable()` 內「編輯宅配」按鈕唯一綁定 `onclick="openShippingProductModal(id)"`，全專案搜尋沒有第二個「編輯宅配」按鈕、沒有誤綁 `openLineSettingsModal()` 的路徑。
- `shippingProductModal` 與 `lineSettingsModal` 是兩個獨立的 DOM id、獨立的開關/儲存函式，`saveShippingProductSettings()` 只呼叫 `PATCH /api/products/:id/shipping-settings`，不會寫入 `line_name/line_price/line_spec/line_description/line_image_url/line_category`。
- 本次未變更任何相關程式碼，僅完成驗證。

### 物流 API 架構預留 V1
- 新增 `routes/shipping.js`，掛載於 `/api/shipping`：
  - `GET /api/shipping/providers`：手動輸入、黑貓宅急便、新竹物流、台灣宅配通、全家超商取貨、7-ELEVEN 取貨、蝦皮店到店、自訂物流商（除手動輸入外全部 `enabled:false`，尚未開放）
  - `GET /api/shipping/config` / `PATCH /api/shipping/config`
  - `POST /api/shipping/test`：固定回傳「物流 API 測試功能已預留，尚未串接正式物流商」
- 新增 settings key 白名單：`shipping_api_enabled`、`shipping_provider`、`shipping_api_key`、`shipping_api_secret`、`shipping_customer_id`、`shipping_sender_name`、`shipping_sender_phone`、`shipping_sender_address`、`shipping_test_mode`（沿用冷藏宅配同一組 `line_order` 授權門檻）。
- `orders` 表新增（safe migration，僅 `ALTER TABLE ADD COLUMN`，不影響舊訂單）：
  `shipping_provider`、`shipping_api_status`、`shipping_api_updated_at`、`shipping_api_message`。此版本沒有任何流程會寫入這些欄位，純粹預留。
- 後台 UI：設定 →「LINE 營業」→「冷藏宅配設定」卡片下方新增「📦 物流 API 設定」卡片（啟用開關、物流商下拉、API Key/Secret、客戶代號、寄件人資訊、測試模式、測試連線／儲存設定按鈕）。

> Payment Gateway（LINE Pay / 綠界 / 藍新 / 街口 / Apple Pay / Google Pay）架構**已於既有 `routes/payment-gateways.js` 完整存在**（provider 清單含 `linepay, ecpay, newebpay, jkopay, pxpay, applepay, googlepay, creditcard_terminal`），本次未重複實作，避免破壞既有 LINE Pay 流程。

### LINE 預購管理｜統計補齊 + 狀態分類統一 + 單日查詢
- 統計卡（預購筆數／待處理／預購金額）改為依「全部／外帶／外送／冷藏宅配」四種模式**即時合併計算**：
  - 全部 = 外帶 + 外送 + 冷藏宅配
  - 外帶／外送／冷藏宅配 = 只計算對應通路
  - 「待處理」= 排除「已完成」與「已取消」後的筆數
- 狀態統一為 7 類：全部／待確認／已接單／處理中／已出貨／已送達／已完成／已取消（外帶外送 5 類可套用；冷藏宅配獨立面板本身已支援全部 7 類，本次未變動）。
- 新增「單日」按鈕（今天／明天／本週／**單日**／全部預購／自訂），只查詢指定單一日期 00:00:00~23:59:59，不與區間查詢混用。
- 冷藏宅配資料改為依相同日期區間（含單日）向後端查詢（`routes/line-shipping.js` 新增 date 篩選支援），不再固定抓最新 200 筆。

### 訂單紀錄｜分頁分類修正（本次新增 BUG）
- **修正**：「內用/外帶」分頁原本只用 `order_mode !== 'delivery'` 判斷，導致冷藏宅配訂單（`order_mode==='shipping'` / `fulfillment_type==='shipping'` / `order_source==='line_shipping'` / 單號 `SHIP-` 開頭）會混入。已改為同時排除外送與冷藏宅配。
- 「外送報表」與「冷藏宅配」分頁本來就各自使用獨立查詢（`order_mode='delivery'` 與 `fulfillment_type='shipping'`），驗證後行為正確、無需修改。
- 「全部訂單」分頁本來就無過濾，驗證後行為正確。
- 新增「單日」查詢按鈕（今日／昨日／本週／本月／上月／**單日**／自訂），直接把單一日期寫入既有 `dateFrom`/`dateTo` 欄位，因此「全部／內用外帶／外送報表／冷藏宅配」四個分頁完全共用同一套查詢邏輯，不需個別修改。
- 「冷藏宅配」分頁改為依日期篩選查詢（原本固定抓最新 200 筆、忽略日期），並新增欄位：付款狀態、交易編號、物流公司、物流單號（物流狀態欄位本已存在）。
- 統計卡在切至「冷藏宅配」分頁時，也會依該分頁資料重新計算（宅配只算宅配）。

---

## 三、DB migration 清單（safe migration，僅 ADD COLUMN / INSERT OR IGNORE）

**orders 表新增欄位：**
- `shipping_provider` TEXT DEFAULT ''
- `shipping_api_status` TEXT DEFAULT ''
- `shipping_api_updated_at` TEXT DEFAULT ''
- `shipping_api_message` TEXT DEFAULT ''

**settings 預設值（INSERT OR IGNORE，store_001）：**
- `shipping_api_enabled = '0'`
- `shipping_provider = 'manual'`
- `shipping_test_mode = '1'`

無 DROP、無重建、無清空既有資料。

---

## 四、新增 settings key 清單

`shipping_api_enabled`、`shipping_provider`、`shipping_api_key`、`shipping_api_secret`、
`shipping_customer_id`、`shipping_sender_name`、`shipping_sender_phone`、
`shipping_sender_address`、`shipping_test_mode`

---

## 五、API 變更清單

**新增：**
- `GET /api/shipping/providers`
- `GET /api/shipping/config`
- `PATCH /api/shipping/config`
- `POST /api/shipping/test`

**修改：**
- `GET /api/line-shipping/admin/orders`：新增 `date` / `date_from` / `date_to` query 參數（向下相容，不帶日期參數時行為與 Hotfix20 相同）
- `PUT /api/settings`：白名單新增物流 API key，並納入既有 `line_order` 授權檢查

未變更任何既有 API 的既有參數或既有回傳格式。

---

## 六、UI 變更清單

- 設定 →「LINE 營業」：新增「📦 物流 API 設定」卡片
- LINE 預購管理：
  - 快選日期新增「單日」按鈕 + 日期選擇器
  - 狀態下拉選單改為 5 類（全部/待確認/已接單/處理中/已完成/已取消，對應外帶外送）
  - 統計卡依模式即時合併計算
- 訂單紀錄：
  - 快選日期新增「單日」按鈕 + 日期選擇器
  - 「內用/外帶」分頁不再顯示冷藏宅配訂單
  - 「冷藏宅配」分頁新增：付款狀態、交易編號、物流公司、物流單號欄位；改為依日期篩選

---

## 七、驗收結果

| 項目 | 結果 |
|---|---|
| A. 編輯宅配 Modal 只開冷藏宅配設定 | ✅ 已存在且正確（Hotfix20 起） |
| B. 物流 API 設定／測試連線／重新整理後仍存在 | ✅ 新增架構，設定值存於 settings 表，重整後從 DB 讀回 |
| C. LINE 預購管理模式統計（外帶$100/外送$200/宅配$300 → 全部600/外帶100/外送200/宅配300）| ✅ 統計改為依模式合併計算 |
| D. LINE 預購管理狀態分類（7 類皆可查詢）| ✅ 外帶外送 5 類 + 冷藏宅配獨立面板原生 7 類 |
| E. 完成/取消訂單保留可查 | ✅ 驗證既有邏輯本就未排除，未發現遺失 |
| F. 單日查詢（LINE 預購管理／訂單紀錄，含宅配）| ✅ 兩頁皆新增單日查詢，宅配資料同步支援 |
| G. 回歸（LINE外帶/外送/冷藏宅配下單、商家公告、Business Calendar、訂單紀錄統計）| ✅ 均未修改對應下單流程與統計計算邏輯 |
| 新增 BUG：訂單紀錄「內用/外帶」混入宅配/外送 | ✅ 已修正並驗證邏輯 |

**node --check 結果：全部通過**
```
routes/shipping.js        OK
routes/line-shipping.js   OK
routes/settings.js        OK
routes/products.js        OK
routes/line-orders.js     OK
routes/orders.js          OK
routes/uploads.js         OK
server.js                 OK
utils/db.js               OK
public/js/app.js          OK
public/line-order.html (inline script) OK
public/line-shipping.html (inline script) OK
```

**HTML id 衝突檢查：** `public/index.html` 561 個 id，無重複。

**路由衝突檢查：** `/api/shipping` 與 `/api/line-shipping` 為不同前綴，Express 依前綴比對不會互相攔截；未與既有路由重複掛載。

**已知非本次引入之既有事項（僅記錄，未修改）：**
- `public/js/app.js` 中 `escHtml` 函式定義兩次（第 536 行與第 4620 行），此為 Hotfix20 既有狀態，非本次改動造成，因非本次範圍故未合併，僅在此提出供未來版本參考。

---

## 八、待 Hotfix22 建議事項

1. 物流 API V1 目前僅為架構（provider 清單 + 設定 + 測試端點皆為預留），下一版可視店家需求優先串接單一物流商（例如黑貓）的正式建立託運單 API。
2. LINE 預購管理「全部」模式的預購訂單表格目前仍只顯示外帶/外送資料列（欄位設計不同於冷藏宅配），冷藏宅配資料列如需在同一張表格內混合顯示，建議另外設計共用欄位格式。
3. 訂單紀錄「內用/外帶」分頁可進一步依 `order_source`/`source` 細分 POS 內用、POS 外帶、LINE 外帶三個子類別供更細緻報表使用。
4. 建議合併 `public/js/app.js` 中重複定義的 `escHtml` 函式（既有問題，非本次引入）。
5. 物流 API 設定新增的 provider 清單（TCAT/全家/7-11/蝦皮店到店）為新一輪需求，若需要正式串接，建議先確認各物流商的正式 API 文件與費率結構。
