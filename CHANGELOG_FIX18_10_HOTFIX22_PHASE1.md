# fix18-10-hotfix22（Phase 1）｜冷藏宅配前台補強：查詢訂單／我的訂單／購物車物流資訊／快取版本修正

以 Hotfix21 為基礎的增量修改。**未重寫、未重構既有架構；未修改 POS 結帳、Android、LINE 點餐/外送、LINE Pay 既有流程。**

本次僅涵蓋 Hotfix22 規格書中風險最低、且已確認為真實缺口的 UI／客戶端查詢部分（規格書一、二、三、四項的可執行子集）。以下項目**維持原規格書標號**方便對照。

---

## 零、施工前的現況核對（重要）

規格書要求的多項內容，在動工前先逐項核對目前 Hotfix21 原始碼，發現與規格書描述不符：

| 規格書描述 | 核對結果 |
|---|---|
| 一、編輯宅配 Modal 開錯視窗 | ❌ 此 bug 已於 Hotfix20 修正，Hotfix21 也已驗證過。本次**未變更**任何 Modal 相關程式碼。唯一發現的殘留風險是 `public/index.html` 的 `app.js` 快取版本字串停在 `hotfix18`，可能導致舊瀏覽器快取吃到 hotfix18 之前的舊碼 → 本次已修正（見下方一）。 |
| 六、LINE Pay「V1 尚未支援」 | ❌ 已過時。`routes/linepay.js` 已是完整 LINE Pay v3 串接（簽章／Request／Confirm）。**本次不重做**，避免破壞既有外帶/外送已在使用的付款流程。此項留待下一階段做「冷藏宅配串接驗證」，不在本次範圍。 |
| 五、物流 API 預留 | ⚠️ Hotfx21 已新增 `routes/shipping.js`（provider 清單/設定/測試 stub），規格書要的 3 張獨立資料表尚未建立。**本次不做**，留待下一階段。 |
| 二、三、四（首頁按鈕／我的訂單／購物車物流資訊） | ✅ 確認為真實缺口，本次完成。 |

---

## 一、修改檔案清單

| 檔案 | 異動 |
|---|---|
| `public/index.html` | `app.js` 快取版本字串 `?v=fix18-10-hotfix18` → `?v=fix18-10-hotfix22`（僅此一行） |
| `public/line-shipping.html` | 新增首頁查詢/我的訂單按鈕、我的訂單 Sheet、訂單詳情 Sheet、購物車物流資訊區塊、最低訂購金額警示、複製物流單號按鈕；重構查詢訂單詳情樣板為共用函式（外部行為不變） |
| `routes/line-shipping.js` | 新增 `POST /history`（我的訂單）；`GET /order/:orderNo` 回傳新增 `payment_status` / `payment_status_label` 欄位 |

**未修改**：`routes/line-orders.js`、`routes/linepay.js`、`routes/orders.js`、`routes/products.js`、`utils/db.js`、Android 專案（本次無 Android 異動，不產 Android ZIP）。

---

## 二、逐項對應

### 一｜編輯宅配 Modal（規格書最高優先）
- 程式碼確認無誤（同 Hotfix21 驗證結果）。
- 修正殘留風險：`public/index.html` 的 `<script src="/js/app.js?v=...">` 版本字串補上 `hotfix22`，避免舊瀏覽器快取誤用 hotfix18 以前的 `app.js`。

### 二｜冷藏宅配首頁加入「查詢訂單」「我的訂單」
- `line-shipping.html` 首頁 Header 新增 `🔍 查詢訂單` `📋 我的訂單` 兩個按鈕，樣式比照 LINE 點餐首頁（`line-order.html` 的 `.hdr-btns`/`.hdr-btn`）。
- 「查詢訂單」沿用既有 `querySheet`／`queryOrder()`（僅單號查詢），未變更其對外行為。
- 「我的訂單」為全新功能：依電話查詢歷史宅配訂單清單（完整電話查全部；後三碼需搭配收件人姓名查最近3天，邏輯比照 LINE 點餐「我的訂單」）。

### 三｜宅配訂單查詢／我的訂單畫面
- 新增「我的訂單」清單卡片：訂單編號、建立時間、付款狀態徽章、宅配狀態徽章、總金額、查看詳情按鈕。
- 詳情頁（沿用/擴充查詢訂單的詳情樣板）顯示：訂單編號、建立時間、付款狀態、宅配狀態（步驟條）、物流公司、物流單號、希望到貨日、收件人、電話、地址、商品明細、運費、總金額、付款方式、備註。
- 物流單號存在時，新增「複製物流單號」按鈕（`navigator.clipboard`），原有「開啟物流查詢」按鈕保留不變。

### 四｜宅配物流資訊（購物車）
- 購物車 Sheet 新增物流資訊區塊：顯示後台設定的物流公司名稱、目前選擇的配送方式（最快出貨／指定到貨，隨按鈕切換即時更新）、後台「冷藏宅配設定」中的宅配說明／宅配公告（`shipping_notice`）與保存提醒（`shipping_storage_note`）。
- 新增最低訂購金額提示：小計低於後台設定的 `shipping_min_order_amount` 時，購物車顯示警示文字並停用送出按鈕（後端 `validate-cart` / 建立訂單本就有此檢查，此為前端提前攔截，不影響後端既有邏輯）。

---

## 三、API 變更清單

**新增：**
- `POST /api/line-shipping/history`：依電話／後三碼＋姓名查詢歷史宅配訂單清單（供「我的訂單」使用）。查詢邏輯與 `POST /api/line-orders/history` 一致慣例，但完全獨立實作、只查 `fulfillment_type='shipping'` 訂單，不影響 LINE 點餐/外送的歷史查詢。

**修改（向下相容，僅新增回傳欄位）：**
- `GET /api/line-shipping/order/:orderNo`：回應新增 `payment_status`、`payment_status_label` 兩個欄位，既有欄位與格式不變。

**未新增/修改任何 DB 欄位或資料表。**

---

## 四、Migration 清單

無。本次未異動 `utils/db.js`，未新增任何資料表或欄位。

---

## 五、驗證結果

| 項目 | 結果 |
|---|---|
| `node --check` 全部改動的 JS（含 `line-shipping.html` 內嵌 script） | ✅ 全部通過 |
| `public/line-shipping.html` id 是否重複 | ✅ 無重複（新增 id 均為靜態且唯一） |
| 「查詢訂單」單號查詢既有行為 | ✅ 未變更（僅內部改為呼叫共用樣板函式，輸出 HTML 結構相同並新增付款狀態/建立時間/複製按鈕） |
| 「我的訂單」新流程 | ✅ 新增，與既有查詢訂單/購物車/送出訂單流程互不影響 |
| 購物車既有金額計算（小計/運費/免運） | ✅ 未變更計算邏輯，僅新增 `belowMin`/`minAmt` 兩個附加欄位 |
| POS／LINE 點餐／LINE 外送／Android | ✅ 未觸碰對應檔案 |

```
node --check routes/line-shipping.js       OK
node --check public/js/app.js              OK
node --check <line-shipping.html inline script>   OK
```

---

## 六、待下一階段（Phase 2 / 3）

依規格書順序，尚未執行、建議下一階段處理：
1. **物流 Provider 資料表與 API**：新增 `shipping_provider` / `shipping_provider_config` / `shipping_tracking` 三張資料表，擴充 `routes/shipping.js` 的 stub 為可持久化設定。
2. **LINE Pay 冷藏宅配串接驗證**：確認 `routes/linepay.js` 既有 Request/Confirm 流程能否直接套用到 `order_source='line_shipping'` 訂單，付款成功/失敗/取消/逾時的狀態同步（`我的訂單`／`LINE 預購管理`／`訂單紀錄`即時反映）。
3. 後台付款狀態 Badge（規格書七）與統一物流狀態（規格書八）之後台顯示，目前僅完成客戶端顯示，後台管理介面尚未檢查。
