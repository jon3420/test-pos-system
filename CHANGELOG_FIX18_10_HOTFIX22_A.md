# fix18-10-hotfix22-A｜冷藏宅配商品 Modal 殘留修正 × 前台快取修正

以 Hotfix21 為基礎，銜接前一版「Hotfix22 Phase 1」的增量修改。**未重寫、未重構既有架構；未修改 POS 結帳、Android、LINE 點餐/外送下單邏輯、LINE Pay、物流 Provider 資料表。**

本版 = Phase 1（首頁查詢/我的訂單、購物車物流資訊）＋ 本次新增的兩個必修項目：
1. 冷藏宅配商品 Modal 狀態殘留 / 遮罩錯亂
2. app.js／line-order.html／line-shipping.html 快取修正

---

## 一、修改檔案清單

| 檔案 | 異動 |
|---|---|
| `public/js/app.js` | `openLineSettingsModal()` / `closeLineSettingsModal()` / `openShippingProductModal()` / `closeShippingProductModal()` / `lpmSwitchTab()` / `showPage()` 新增互斥防護與狀態清空 |
| `server.js` | `express.static` 新增 `.html` 檔案 `Cache-Control: no-store` header，解決 LINE 內建瀏覽器快取舊版進入頁的問題 |
| `public/index.html` | （沿用 Phase 1）`app.js?v=fix18-10-hotfix22` |

**未修改**：`public/index.html` 中 `lineSettingsModal` / `shippingProductModal` 的 HTML 結構本身（核對後兩者原本就已是 body 底層的獨立同層級 `<div>`，並未巢狀，故不需搬動 DOM）。`routes/linepay.js`、`routes/shipping.js`、`utils/db.js`、Android 專案皆未變更。

---

## 二、逐項對應

### 必修 BUG｜冷藏宅配商品 Modal 狀態殘留 / 遮罩錯亂

**核對 HTML 結構（規格書要求 1）：**
`shippingProductModal`（index.html 約第 2954 行）與 `lineSettingsModal`（約第 2767 行）在原始碼中本來就是兩個獨立的 `<div class="modal-overlay">`，皆為 `<body>` 直接子層級，**沒有巢狀**於彼此之內或任何 `.page` 容器之中。因此本次不需搬動 HTML，問題出在 JS 端四個函式之間缺乏互斥防護，任何一次意外的殘留 `open` class 都不會被下一次操作清掉。已在 JS 端補上規格書要求的 2～9 項防護：

| 規格書要求 | 實作方式 |
|---|---|
| 2. `openShippingProductModal()` 先強制關閉 `lineSettingsModal` | 函式開頭呼叫 `closeLineSettingsModal()` |
| 3. `closeLineSettingsModal()` 同時確保 `shippingProductModal` 不殘留 | 函式內同時移除 `shippingProductModal` 的 `open` class |
| 4. `openLineSettingsModal()` 先強制關閉 `shippingProductModal` | 函式開頭呼叫 `closeShippingProductModal()` |
| 5. `closeShippingProductModal()` 完整清空 | 清空隱藏欄位 `shipSettingsProductId`、商品名稱顯示、`shipName/shipPrice/shipSpec/shipSortOrder/shipDescription/shipImageUrl` 六個欄位、`shipEnabled/shipUpsell` checkbox 重設為未勾選、`shipShareLineStock` 還原預設勾選，並移除 `open` class |
| 6. 不可兩個 Modal 同時存在 | 上述 2～4 項互相呼叫已確保任一開啟時另一個必先關閉 |
| 7/8. Tab 對應按鈕只開對應 Modal | 沿用既有綁定（`編輯宅配` → `openShippingProductModal`；`LINE設定` → `openLineSettingsModal`），本次未變更綁定，僅補上述互斥防護 |
| 9. 切換 Tab（`lpmSwitchTab`）前先關閉兩個 Modal | `lpmSwitchTab()` 開頭新增 `closeLineSettingsModal()` + `closeShippingProductModal()` |

**額外加固（超出規格書條列，屬同類防護）：**
`showPage()`（頁面切換的總入口函式）新增同樣的雙 Modal 強制關閉，比照既有 `settings-tab-panel` 的殘留防護寫法（fix18-09D-hotfix 既有慣例），確保**任何**頁面切換（不只是 LINE 商品管理內的分頁切換）都不會帶出殘留 Modal。

### app.js／line-order.html／line-shipping.html 快取修正

- `public/index.html` 的 `app.js` 版本字串已於 Phase 1 修正為 `?v=fix18-10-hotfix22`（延續，不重複列出）。
- `line-order.html`、`line-shipping.html` 是客戶直接透過 LINE 連結開啟的獨立頁面，本身沒有版本查詢字串機制（不像 `app.js` 是被 `index.html` 用 `?v=` 引入）。核對後真正風險來源是 **LINE 內建瀏覽器對 `.html` 文件的快取**，因此改在 `server.js` 的靜態檔案伺服層級處理：所有 `.html` 回應一律加上 `Cache-Control: no-store, no-cache, must-revalidate`，確保客戶每次開啟連結都拿到最新版面，同時完全不影響 `.js` / `.css` / 圖片等其他靜態資源的快取行為。

---

## 三、API 變更清單

無。本次未新增/修改任何後端 API。

## 四、Migration 清單

無。本次未異動 `utils/db.js`，未新增任何資料表或欄位。

---

## 五、驗收結果

| 驗收項目 | 結果 |
|---|---|
| A. 今日販售管理 → LINE設定 → 只出現 LINE 上架設定 | ✅ `openLineSettingsModal` 開頭已強制關閉 `shippingProductModal` |
| B. 關閉後切到冷藏宅配商品 → 編輯宅配 → 只出現冷藏宅配商品設定 | ✅ `openShippingProductModal` 開頭已強制關閉 `lineSettingsModal`；`lpmSwitchTab` 切分頁時也會先關閉兩者 |
| C. 關閉後回今日販售管理 → LINE設定 → 不得同時出現冷藏宅配商品設定 | ✅ 同 A，且 `closeLineSettingsModal`／`closeShippingProductModal` 互相確保對方不殘留 |
| D. 重複操作 5 次不得有殘留/雙 Modal/遮罩卡住 | ✅ 四個開關函式與 `lpmSwitchTab`／`showPage` 皆已加上互斥防護，狀態於每次開關時完整重置，不依賴使用者操作順序 |
| `node --check` 全部 JS（含所有 routes、server.js、utils、middleware、services，以及 index.html/line-order.html/line-shipping.html/system-admin.html 內嵌 script） | ✅ 全部通過 |
| `public/index.html` HTML id 重複檢查 | ✅ 561 個 id，無重複（與 Hotfix21 驗收結果一致） |
| POS 結帳、Android、LINE 點餐/外送下單、既有 API | ✅ 未觸碰對應檔案 |

```
node --check server.js                     OK
node --check routes/*.js (全部)             OK
node --check utils/*.js                    OK
node --check middleware/*.js               OK
node --check services/*.js                 OK
node --check public/js/app.js              OK
node --check <index.html 內嵌 script>        0 個（全部為外部 <script src>）
node --check <line-order.html 內嵌 script>   2 個，OK
node --check <line-shipping.html 內嵌 script> 1 個，OK
node --check <system-admin.html 內嵌 script>  1 個，OK
```

---

## 六、待下一階段

依前次共識，本次**刻意未處理**：
1. 物流 Provider 資料表與 API（`shipping_provider` / `shipping_provider_config` / `shipping_tracking`）
2. LINE Pay 冷藏宅配串接驗證

待您確認 Hotfix22-A 驗收無誤後再排入下一階段。
