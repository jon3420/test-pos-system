# fix18-10-hotfix22-A（付款設定架構釐清）｜三區塊分離：POS 付款方式 / 金流 API / 線上付款方式管理

以 Hotfix21 為基礎的增量修改。**未重寫既有架構、未修改 POS 核心結帳邏輯、未修改 Android。**

本輪目的：釐清並整理付款相關設定的三個區塊，避免互相覆蓋。

---

## 一、三區塊確認（核對現況，不是新建）

| 區塊 | 位置 | 用途 | 本次是否變動 |
|---|---|---|---|
| 付款方式管理 | 系統設定 → 💳 付款方式（`stab-payment`） | 實體 POS／現場結帳，獨立的 `payment_methods` 資料表，依「內用/外帶/外送」三個 legacy 訂單模式控制 | ❌ **完全未動** |
| 金流 API | 系統設定 → 💳 金流 API（`stab-gateway`） | LINE Pay／綠界／藍新等金流憑證設定（`payment-gateways`） | ❌ **完全未動** |
| 線上付款方式管理 | 設定 → 📡 LINE 營業（`stab-line_biz`）**【本次整理】** | LINE 線上點餐三通路（外帶/外送/冷藏宅配）各自可用付款方式 | ✅ 本次新增/整理 |

核對後確認：前兩者使用完全不同的資料表/設定 key（`payment_methods` 資料表、金流憑證 key），與「線上付款方式管理」使用的 `takeout_payment_methods` / `delivery_payment_methods` / `shipping_payment_methods`（`settings` 表 JSON 陣列）**互不重疊**，本次修改沒有觸碰前兩者的任何程式碼或資料。

---

## 二、線上付款方式管理（本次整理內容）

### 問題：先前散落、重複的付款方式區塊
在整理前，LINE 營業分頁底下同時存在三個各自獨立、會互相覆蓋同一份資料的付款方式 UI：
1. 「LINE 點餐付款方式」（全域 5 個勾選框，寫 `line_payment_*_enabled`）
2. 「外帶付款方式（獨立開關）」「外送付款方式（獨立開關）」（上次新增，寫 `takeout_payment_methods`/`delivery_payment_methods`）
3. 「冷藏宅配設定」卡片內嵌的付款方式勾選框（寫 `shipping_payment_methods`）

三處各自有各自的「儲存」按鈕，容易造成困惑或誤觸覆蓋。

### 整理後：統一成一個區塊
新增單一卡片「💳 線上付款方式管理」，位置維持在 **設定 → LINE 營業**，同時管理三個通路：
- 🛍️ 外帶付款方式：現金／LINE Pay／轉帳／信用卡／平台付款
- 🛵 外送付款方式：現金／LINE Pay／轉帳／信用卡／平台付款
- 📦 冷藏宅配付款方式：現金／LINE Pay ⚠️／轉帳／信用卡／平台付款

一個「💾 儲存線上付款方式管理」按鈕，一次驗證並寫入三個通路的設定。

**移除的重複區塊：**
- 「LINE 點餐付款方式」全域卡片（`linePaymentToggles`／`lp-*`／`saveLinePaymentSettings()`）— 已移除
- 「外帶/外送付款方式（獨立開關）」兩張卡片（上次新增，`takeoutPaymentToggles`/`deliveryPaymentToggles`）— 已併入統一區塊
- 「冷藏宅配設定」卡片內的付款方式勾選框（`.ship-pay-chk`）— 已移除，卡片內改為文字提示指向新區塊，`shipping_payment_methods` 改由統一區塊唯一寫入

### 規則落實
| 規則 | 落實方式 |
|---|---|
| 4. 三通路皆至少選一種付款方式 | `saveOnlinePaymentMethods()` 逐一驗證，任一通路勾選數為 0 就阻擋儲存並提示是哪個通路 |
| 5. 冷藏宅配 LINE Pay 尚未支援正式付款，後台可勾但前台需擋下 | 後台勾選框旁加註警語；`line-shipping.html` 選擇 LINE Pay 時顯示常駐警示橫幅；`submitOrder()` 送出前硬性擋下（不只是提示，而是直接 return 不送出）；**後端 `POST /api/line-shipping` 也加了同樣的擋下邏輯**，即使前端檢查被繞過也無法建立 LINE Pay 冷藏宅配訂單 |
| 6. 前台各自讀取線上付款方式管理對應通路 | `line-order.html` 外帶/外送已依模式讀取 `takeout_payment_methods`/`delivery_payment_methods`（前一輪已完成，本輪未變更邏輯）；`line-shipping.html` 沿用既有讀取 `shipping_payment_methods` 的邏輯（本來就正確，本輪只是把可選代碼從 3 種擴充為 5 種，配合新增的信用卡/平台付款選項） |
| 7. 移除/隱藏重複區塊，統一到「線上付款方式管理」 | 見上方「整理後」 |

---

## 三、修改檔案清單

| 檔案 | 異動 |
|---|---|
| `public/index.html` | 移除 3 個重複付款方式卡片，新增 1 個統一「線上付款方式管理」卡片；移除冷藏宅配設定卡片內的付款方式勾選框 |
| `public/js/app.js` | 移除 `saveLinePaymentSettings()`／`_fillModePaymentToggles()`／`saveModePaymentSettings()`；新增統一的 `_fillOnlinePaymentToggles()`／`saveOnlinePaymentMethods()`；`_fillShippingSettingsForm()`／`saveShippingSettings()` 移除付款方式相關程式碼（避免與新區塊互相覆蓋同一筆設定） |
| `routes/line-shipping.js` | `SHIP_PAYMENT_METHOD_LABELS` 擴充支援 `credit_card`／`platform`；訂單建立路由新增 LINE Pay 後端硬性擋下 |
| `public/line-shipping.html` | 付款方式標籤擴充支援 5 種代碼；新增常駐 LINE Pay 警示橫幅；`submitOrder()` 新增前端硬性擋下 |

**未修改**：`stab-payment`（付款方式管理）、`stab-gateway`（金流 API）相關的任何檔案/程式碼；`routes/payment-gateways.js`；POS 核心結帳；Android。

---

## 四、Migration 清單

無。`takeout_payment_methods` / `delivery_payment_methods` / `shipping_payment_methods` 皆沿用既有 `settings` key-value 結構，本次未新增/修改任何資料表欄位。

## 五、API 變更清單

無新增/修改 API 路由本身，僅：
- `routes/line-shipping.js` 訂單建立路由新增一段 LINE Pay 驗證（早退回 400）
- `SHIP_PAYMENT_METHOD_LABELS` 擴充標籤對照

---

## 六、驗證結果

| 項目 | 結果 |
|---|---|
| `node --check`：`server.js`、全部 `routes/*.js`、`utils/*.js`、`middleware/*.js`、`services/*.js`、`public/js/app.js` | ✅ 全部通過 |
| `node --check`：`index.html`（0 內嵌）、`line-order.html`（2）、`line-shipping.html`（1）、`system-admin.html`（1） | ✅ 全部通過 |
| `index.html` `<div>`／`</div>` 總數平衡 | ✅ 639 / 639 |
| `index.html` id 重複檢查 | ✅ 569 個 id，無重複 |
| 「系統設定 → 付款方式管理」是否被觸碰 | ✅ 完全未觸碰 |
| 「系統設定 → 金流 API」是否被觸碰 | ✅ 完全未觸碰 |
| 舊的 3 個重複付款方式區塊是否已移除、無殘留引用 | ✅ 已逐一 grep 確認 `lp-*`／`ship-pay-chk`／`saveLinePaymentSettings`／`saveModePaymentSettings`／`_fillModePaymentToggles`／`takeoutPaymentToggles`／`deliveryPaymentToggles` 皆無殘留 |
| 三通路皆至少需選一種付款方式才能儲存 | ✅ `saveOnlinePaymentMethods()` 逐一驗證 |
| 冷藏宅配 LINE Pay：後台可勾選、前台清楚提示且擋下送出 | ✅ 前端警示橫幅 + `submitOrder()` 擋下 + 後端路由擋下（雙重防護） |
| `line-order` 外帶/外送、`line-shipping` 宅配各自讀取對應通路設定 | ✅ 沿用/延續前一輪已完成的讀取邏輯 |
| POS 結帳、Android | ✅ 未觸碰對應檔案 |
