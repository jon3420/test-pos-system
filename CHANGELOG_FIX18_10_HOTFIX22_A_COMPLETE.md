# fix18-10-hotfix22-A（完成版）｜Modal 巢狀真正原因修正 × 通路獨立付款方式 × 購物車完整持久化

以 Hotfix21 為基礎的增量修改。**未重寫既有架構、未修改 POS 核心結帳邏輯、未修改 Android。**

本輪是接續前一版 Hotfix22-A 的未完成事項，並依指示找出 Modal 問題的**真正原因**（非 workaround）。

---

## 一、修改檔案清單

| 檔案 | 異動 |
|---|---|
| `public/index.html` | **真正原因修正**：補上 `lineSettingsModal` 內缺漏的 `.modal-body` 收尾 `</div>`，移除後方對應多出來的孤兒 `</div>`；新增外帶/外送獨立付款方式勾選 UI |
| `public/js/app.js` | 新增 `_fillModePaymentToggles()` / `saveModePaymentSettings()`（通路獨立付款方式設定） |
| `routes/line-orders.js` | 新增 `getModePaymentMethods()`，`/shop` 回應新增 `takeout_payment_methods` / `delivery_payment_methods` |
| `routes/settings.js` | 白名單新增 `takeout_payment_methods` / `delivery_payment_methods` |
| `public/line-order.html` | `buildPaymentButtons()` 改為依模式（外帶/外送）挑選付款方式；`switchMode()` / `onModeChange()` 切換時立即重建付款按鈕，不重新整理頁面 |
| `public/line-shipping.html` | 完成購物車＋表單完整 localStorage 持久化（`persistCart()` / `restoreCart()` / `clearCartStorage()`） |

---

## 二、逐項對應

### 【3】編輯宅配 Modal 沒開 / 之後兩個 Modal 一起跑出 —— 真正原因

**不是** JS 事件綁定、`open` class 狀態、Promise 時序或 event bubbling 的問題。

**真正原因：`public/index.html` 裡 `lineSettingsModal` 的 `<div class="modal-body">` 缺少對應的收尾 `</div>`。**

具體位置：「2️⃣ LINE 今日可售份數」區塊（原第 2884～2966 行）結束後，直接接上 `<div class="modal-footer">`，但中間漏了一個關閉 `.modal-body` 的 `</div>`。這造成往後所有標籤的巢狀深度多算一層，`lineSettingsModal` 自己的最外層 `<div>`因此**永遠沒有真正關閉**，導致緊接在它後面宣告的 `shippingProductModal` 整個被吃進 `lineSettingsModal` 的 DOM 子樹裡（巢狀，而非兩個獨立 Modal）。

**連帶發現的第二個問題：** 因為少一個關閉標籤，原本應該在檔案更後面出現的「深度歸零」被延後了一層——而剛好在 `shippingProductModal` 結束後（原第 3042 行）多了一個**沒有對應開啟標籤的孤兒 `</div>`**，把這一層意外「補」回來，使得**整份檔案的 `<div>`／`</div>` 總數剛好相等（639/639）**。這就是為什麼單純用「開始標籤數 = 結束標籤數」檢查完全抓不出問題——兩個錯誤互相抵銷了總數，但中間的巢狀結構整個是錯的。

**為什麼會出現「編輯宅配沒開」→「LINE設定又兩個一起跳出」：**
- `shippingProductModal` 是 `lineSettingsModal` 的子元素。`.modal-overlay{display:none}`，只有加上 `.open` 才會 `display:flex`。
- 在「冷藏宅配商品」分頁點「編輯宅配」時，`shippingProductModal` 確實有被加上 `open` class，但因為它的祖先 `lineSettingsModal` 沒有 `open`（`display:none`），子元素無論自己是不是 `open`，都不會被畫出來 → **這就是「沒開 Modal」的真正原因**。
- 這個殘留的 `open` class 留在 `shippingProductModal` 上不會消失。等使用者之後點「今日販售管理 → LINE設定」，`lineSettingsModal` 被加上 `open`（祖先變成可見），這時候巢狀在裡面、早就偷偷帶著 `open` class 的 `shippingProductModal` **也一起顯示出來** → **這就是「兩個 Modal 一起跑出」的真正原因**。

**修正方式：**
1. 補上 `.modal-body` 缺漏的 `</div>`。
2. 移除後方多出來的孤兒 `</div>`。
3. 修正後重新驗證：`lineSettingsModal` 的最外層 `<div>` 在第 2981 行正確關閉，`shippingProductModal` 在第 2984 行以**完全獨立的同層級 `<div>`** 開始，兩者是真正的手足關係，不再巢狀。

前一版 Hotfix22-A 加上的 JS 互斥防護（`openShippingProductModal`/`openLineSettingsModal` 互相強制關閉對方、`lpmSwitchTab`/`showPage` 切換前清空）**予以保留**，作為額外的安全防護（非承載修正的主因），不會與本次的 HTML 修正衝突。

---

### 【1】購物車 localStorage 完整持久化（`public/line-shipping.html`）

`persistCart()` 保存欄位：`cart`（商品/數量）、`paymentMethod`、`deliveryMode`（asap/date）、`recipient`、`phone`、`zipcode`、`city`、`district`、`address`、`addressNote`、`shippingDate`、`shippingTime`（目前畫面無獨立到貨時段欄位，保留空值供未來擴充）、`remark`、`savedAt`。

- **input**：收件人/電話/郵遞區號/縣市/鄉鎮市區/地址/地址備註/備註欄位皆加上 `oninput="persistCart()"`；到貨日期欄位加上 `onchange="persistCart()"`。
- **change**：付款方式按鈕點擊時呼叫 `persistCart()`；到貨模式切換（`setArrivalType()`）呼叫 `persistCart()`。
- **plus / minus / remove**：三者共用同一個 `changeQty()` 函式（qty 歸零即等同移除），已加入 `persistCart()`。
- **頁面初始化**：`init()` 在 `renderShop()` 之後呼叫 `restoreCart()`，依商品清單重建購物車項目（已下架商品自動略過）、還原表單欄位、還原到貨模式、還原付款方式勾選狀態。
- **有效期限**：`savedAt` 超過 24 小時（`SHIP_CART_TTL_MS`）自動視為過期並清除，不還原。
- **下單成功**：`submitOrder()` 成功後呼叫 `clearCartStorage()`，只有下單成功才清空暫存；使用者純粹關閉分頁或重新整理不會清空。

---

### 【2】付款方式 Mode 切換（外帶／外送／冷藏宅配）

- **外帶／外送**（`line-order.html`）：`buildPaymentButtons()` 改為依目前模式讀取 `takeout_payment_methods` 或 `delivery_payment_methods`（後端 `/api/line-shop` 回應新增這兩個陣列欄位）。`switchMode()` 與 `onModeChange()` 切換時立即呼叫 `buildPaymentButtons(shopData)` 重新渲染，**不重新整理頁面**。
- **冷藏宅配**（`line-shipping.html`）：本來就已使用獨立的 `shipping_payment_methods`（Hotfix18 起），本次未變更其邏輯。
- **Fallback（向下相容）**：若店家尚未設定 `takeout_payment_methods` / `delivery_payment_methods`（新版陣列格式為空），後端 `getModePaymentMethods()` 會自動改用目前實際存在的全域布林欄位 `line_payment_cash_enabled`／`line_payment_linepay_enabled`／`line_payment_transfer_enabled`／`line_payment_platform_enabled`／`line_payment_credit_card_enabled` 組成清單，行為與舊版完全相同。

  > 附註：您在需求中列的 fallback 鍵名 `line_pay_enabled` / `cash_enabled` / `bank_transfer_enabled` 目前程式碼庫中並不存在；核對後實際使用的既有鍵名是 `line_payment_linepay_enabled` / `line_payment_cash_enabled` / `line_payment_transfer_enabled`。為避免無中生有的鍵名造成 fallback 永遠失效（進而導致付款方式清單全部清空、無法下單），這裡採用的是**目前資料庫實際存在**的鍵名，維持向下相容。若您指的是其他系統/其他版本的鍵名，請提供實際存在的欄位名稱，我再對應調整。

- **管理後台 UI**：設定頁新增「🛍️ 外帶付款方式」「🛵 外送付款方式」兩張獨立卡片（勾選框），未勾選任何項目時自動 fallback 顯示與全域設定一致的狀態；一旦勾選並儲存，該通路即改用獨立設定，不再受全域設定影響。

---

## 三、Migration 清單

無。本次未新增/修改任何資料表欄位，`takeout_payment_methods` / `delivery_payment_methods` 沿用既有 `settings` key-value 表結構（與 `shipping_payment_methods` 相同存放方式）。

## 四、API 變更清單

**修改（向下相容，僅新增回傳欄位）：**
- `GET /api/line-shop`：回應新增 `takeout_payment_methods`、`delivery_payment_methods`（陣列）。

**新增可寫入 settings key：**
- `takeout_payment_methods`、`delivery_payment_methods`（JSON 陣列字串，與既有 `shipping_payment_methods` 格式一致）。

---

## 五、驗證結果

| 項目 | 結果 |
|---|---|
| `node --check`：`server.js`、全部 `routes/*.js`、`utils/*.js`、`middleware/*.js`、`services/*.js`、`public/js/app.js` | ✅ 全部通過 |
| `node --check`：`index.html`（0 個內嵌 script，全為外部 `<script src>`）、`line-order.html`（2 個內嵌 script）、`line-shipping.html`（1 個）、`system-admin.html`（1 個） | ✅ 全部通過 |
| `index.html` `<div>`／`</div>` 總數平衡 | ✅ 639 / 639（修正前為「639/640」，已定位並移除多餘的孤兒 `</div>`） |
| `lineSettingsModal` 最外層 `<div>` 是否正確關閉、`shippingProductModal` 是否為真正獨立同層級元素 | ✅ 逐行深度追蹤確認：`lineSettingsModal` 於第 2981 行關閉，`shippingProductModal` 於第 2984 行以獨立 `<div>` 開始 |
| `index.html` id 重複檢查 | ✅ 573 個 id，無重複 |
| 編輯宅配 → 只開 `shippingProductModal` | ✅ 巢狀結構修正後，`.open` class 不再受祖先 `display:none` 影響 |
| LINE設定 → 只開 `lineSettingsModal`，不再一併帶出冷藏宅配設定 | ✅ 兩者已是真正獨立元素，且前版加入的互斥防護仍保留 |
| 購物車 localStorage：關閉分頁/重新整理後商品、收件資料、付款方式、備註是否保留 | ✅ `restoreCart()` 於 `init()` 後執行還原 |
| 24 小時過期自動清除 | ✅ `savedAt` 比對 `SHIP_CART_TTL_MS`（86400000ms） |
| 下單成功才清空暫存 | ✅ `submitOrder()` 成功分支呼叫 `clearCartStorage()`；失敗/取消不清空 |
| 外帶/外送切換模式即時重繪付款按鈕，未重新整理頁面 | ✅ `switchMode()`/`onModeChange()` 呼叫 `buildPaymentButtons(shopData)` |
| 舊店家未設定新版付款方式陣列時，行為是否與 Hotfix21 一致 | ✅ fallback 至既有全域布林欄位，結果相同 |
| POS 結帳、Android | ✅ 未觸碰對應檔案 |

---

## 六、未在本次範圍內（依指示未新增其他功能）

物流 Provider 資料表、LINE Pay 冷藏宅配串接驗證：維持先前共識，本次未處理。
