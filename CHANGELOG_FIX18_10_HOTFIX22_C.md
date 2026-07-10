# Hotfix22-C｜LINE 預購管理整合冷藏宅配 ＋ 冷藏宅配優惠券

以 Hotfix22-B 為基礎，不重寫既有模組，只修正兩個回報問題並完成收尾驗證。

## 修改檔案清單

| 檔案 | 修改內容 |
|---|---|
| `public/js/app.js` | 新增 `normalizePreorder()`；`lpBucketOf()` 改吃正規化欄位；`renderLinePreordersTable()` 改為合併外帶/外送/冷藏宅配並統一計算 badge／統計卡；`renderShippingOrdersTable()` 新增優惠折扣欄位 |
| `routes/line-shipping.js` | 新增優惠券驗證與折扣計算（共用 `routes/coupons.js`）；免運門檻改用「折扣後小計」；`INSERT` 補上 `coupon_code`；新增 `coupon_redemptions` 寫入；`/shop` 新增 `coupon_feature_enabled`；`safeShippingOrder()` 與 `GET /order/:orderNo` 補上折扣欄位 |
| `public/line-shipping.html` | 新增優惠券輸入區、折扣列、`applyCoupon()`/`clearCoupon()`/`revalidateAppliedCoupon()`；`persistCart()`/`restoreCart()` 改為保存與重新驗證優惠券（絕不信任 localStorage 折扣金額）；`calcFee()` 改用折扣後小計判斷免運；`submitOrder()` 送出 `coupon_code`；`showSuccess()` 補上折扣列 |
| `public/index.html` | 冷藏宅配訂單表新增「優惠折扣」欄位（colspan 16→17） |

**未修改**：`routes/coupons.js`、`routes/line-orders.js`、`routes/business-calendar.js`、`routes/settings.js`、POS、Android、既有外帶/外送優惠券流程。與原始上傳版本逐檔比對，本次 Hotfix22-B + 22-C 累計只異動 6 個原始檔案。

---

## Root Cause

### 問題一：LINE 預購管理「全部」看不到冷藏宅配、宅配 Tab 顯示共 0 筆
`renderLinePreordersTable()` 過去用兩份不同陣列：表格用的 `orders`（設計上永遠不含 shipping）與統計用的 `statOrders`（另外合併了 `_shippingOrdersCache`）。右上角「共 N 筆」badge 誤用了表格用的 `orders.length`，而「全部」Tab 的表格本身也從未把 shipping 併入。根本原因是外帶/外送與冷藏宅配用兩套不同欄位命名（`order_status` vs `shipping_status`、`customer_phone` vs `shipping_phone`…），從未有一個共用的資料形狀可以讓同一段渲染/統計邏輯直接處理兩種來源。

修法：新增 `normalizePreorder(order, source)` 把兩種訂單轉成同一組欄位（`id/order_no/created_at/fulfillment_type/order_source/customer_name/phone/items/subtotal/shipping_fee/delivery_fee/coupon_code/discount_amount/total/payment_method/payment_status/order_status/logistics_status/note/pickup_display`），之後 modeFilter／statusFilter／badge／三張統計卡／表格列全部只讀這份正規化後的合併陣列，不再各自為政。

### 問題二：冷藏宅配沒有優惠券
`routes/coupons.js` 的 `validateCoupon()` 本來就完全不區分外帶/外送/冷藏宅配（純粹依 `store_id + code + subtotal + phone` 運作），`coupons` 資料表也從未有任何限制通路的欄位——純粹是 Hotfix22-A 當時 `routes/line-shipping.js` 從未呼叫這支函式。直接共用同一支 `validateCoupon()`，不需擴充 schema、不影響外帶/外送既有行為。

---

## normalizePreorder() 正規化欄位表

| 欄位 | 外帶/外送來源 | 冷藏宅配來源 |
|---|---|---|
| `id` | `o.id \|\| o.uuid \|\| o.order_number` | 同左 |
| `order_no` | `o.order_number` | `o.order_number` |
| `created_at` | `o.created_at` | `o.created_at` |
| `fulfillment_type` | `o.order_mode`（takeout/delivery） | 固定 `'shipping'` |
| `order_source` | `o.source`（line） | `o.order_source`（line_shipping） |
| `customer_name` | `o.customer_name` | `o.shipping_recipient_name \|\| o.customer_name` |
| `phone` | `o.customer_phone` | `o.shipping_phone \|\| o.customer_phone` |
| `items` | 解析後的商品陣列 | 解析後的商品陣列 |
| `subtotal` | `o.subtotal ?? o.total` | `o.subtotal` |
| `shipping_fee` | 固定 0 | `o.shipping_fee` |
| `delivery_fee` | `o.delivery_fee` | 固定 0 |
| `coupon_code` / `discount_amount` | `o.coupon_code` / `o.discount_amount` | 同左 |
| `total` | `o.total` | `o.total`（已含運費、已扣折扣） |
| `payment_method` / `payment_status` | 對應欄位 | 對應欄位 |
| `order_status` | `o.order_status \|\| o.status` | 借用 `o.shipping_status` |
| `logistics_status` | 空字串（不適用） | `o.shipping_status` |
| `pickup_display` | 預約取餐日期時間 | 到貨日期／最快出貨 |

`lpBucketOf(n)` 依 `fulfillment_type==='shipping'` 決定要看 `logistics_status`（宅配狀態機）或 `order_status`（外帶/外送狀態機），分類到共用的 7 個 bucket（confirm/accepted/processing/shipped/delivered/done/cancel）。

---

## 優惠券 API 與計算規則

沿用既有 `POST /api/coupons/validate`（不需修改，本來就通路無關），`routes/line-shipping.js` 新增後端二次驗證：

```
POST /api/line-shipping            body 新增 coupon_code（可選）
                                    response 新增 coupon_code, discount_amount
GET  /api/line-shipping/shop       response 新增 coupon_feature_enabled
GET  /api/line-shipping/order/:no  response 新增 coupon_code, discount_amount
```

**計算公式（前後端一致）**：
```
discount_amount    = validateCoupon(store_id, code, subtotal, phone)   // 只吃商品小計，折扣封頂在 subtotal 以內
discounted_subtotal = max(0, subtotal - discount_amount)
shipping_fee        = discounted_subtotal >= free_shipping_threshold ? 0 : base_shipping_fee
total               = discounted_subtotal + shipping_fee
```
- 優惠券只折商品小計，不折運費；折扣不可能超過小計（`validateCoupon()` 內建 `Math.min(disc, subtotal)`）。
- 免運門檻固定用「折扣後小計」判斷（前端 `calcFee()` 與後端 `POST /api/line-shipping` 使用同一條公式）。
- LINE Pay Request 的實際金額完全由後端 `order.discount_amount`／`order.total` 決定（`routes/linepay.js` 既有邏輯：折扣>0 時整筆收合成一個以 `order.total` 計價的品項），前端送出的 `items`／`total` 只是預覽用，若與後端不符會被 400 擋下，不會被信任送出。

---

## E2E 驗證結果（皆為實機啟動 server.js + 真實 HTTP 呼叫）

### A. 未定義函式檢查
`line-shipping.html`：`applyCoupon / clearCoupon / persistCart / restoreCart / clearCartStorage / refreshCartSheetTotals / calcFee / submitOrder / showSuccess / queryOrder / openShipOrderDetail` 皆已定義，onclick/onchange/oninput 掃描比對後**無缺漏**（`revalidateAppliedCoupon` 為內部呼叫，非 DOM handler，同樣已定義）。`app.js` 的 `normalizePreorder / lpBucketOf / renderLinePreordersTable / renderShippingOrdersTable / openShipOrderDetail` 均存在；`updateLinePreorderSummary` 經全專案搜尋**從未被呼叫過**（統計更新邏輯內嵌於 `renderLinePreordersTable()` 的 `setStat()`），非缺漏。已確認無 `__ship` 舊判斷殘留、無寫死的「共 0 筆」。

### B. LINE 預購管理 E2E
建立外帶 1 筆（LINE-...-084119）、外送 1 筆（直接寫入模擬，因 Google Maps API 在此環境無法連線，屬 Hotfix22-B 已記錄的環境限制，非本次範疇）、冷藏宅配 1 筆（套用 FIX100）。用實際 API 回傳資料驅動抽出的 `normalizePreorder`/`lpBucketOf` 邏輯模擬前端渲染：

| Tab | badge（共N筆） | 預購筆數 | 待處理 | 預購金額 |
|---|---|---|---|---|
| 全部 | 3 | 3 | 3 | 510 |
| 外帶 | 1 | 1 | 1 | 100 |
| 外送 | 1 | 1 | 1 | 160 |
| 冷藏宅配 | 1 | 1 | 1 | 250（=300小計-100折扣+50運費）|

再將外帶標記 cancelled、外送標記 completed 後重跑「全部」：badge=3（含取消，符合「實際筆數」定義）、**預購筆數=2**（排除取消）、**待處理=1**（只剩宅配的 confirm，外送因 done 被排除）、**預購金額=410**（160+250，排除已取消外帶的 100）。全部符合規則。

### C. 冷藏宅配優惠券 E2E
| 情境 | 結果 |
|---|---|
| 固定折扣 FIX100（小計300） | ✅ discount_amount=100, final_total=200 |
| 百分比折扣 PERCENT10（小計300） | ✅ discount_amount=30, final_total=270 |
| 無效代碼 | ✅ 400「優惠券「NOTEXIST」不存在」|
| 已過期 | ✅ 400「此優惠券已過期」|
| 未達最低消費（小計300 < 500門檻） | ✅ 400「未達最低消費 NT$500」；小計600 → ✅ 成功折50 |
| 使用次數已滿 | ✅ 400「此優惠券已達使用上限」|
| 不限通路（無 shipping 專屬限制） | 檢查 `coupons` 資料表與 `validateCoupon()`，**本來就沒有任何通路限制欄位**，故無「shipping 不適用」情境可測；已在下方「已知限制」說明 |
| 偽造 `discount_amount:99999` + `total:1` | ✅ 後端完全忽略，仍以真實 coupon 重新算出 discount=100, total=150 |
| 折扣後失去免運（小計1000-折扣100=900<1000門檻） | ✅ shipping_fee=50, total=950 |
| 折扣後仍達免運（小計1200-折扣100=1100≥1000門檻） | ✅ shipping_fee=0, total=1100 |

### D. LINE Pay 金額驗證
建立宅配訂單套用 PERCENT10（小計300→折30→270+運費50=320），呼叫 `/api/linepay/request`：伺服器日誌 `amount=320 packageAmount=320 productsTotal=320 discount=30 coupon=PERCENT10` —— `discount`／最終金額完全來自 DB 的 `order.discount_amount`／`order.total`，前端送的 items（未折扣的原價300+運費50=350）被完全忽略（因 `discountAmt>0` 時 `routes/linepay.js` 既有邏輯會整筆收合成單一品項，價格=DB `finalTotal`）。額外測試偽造 `total:1`：✅ 被拒絕，回傳「LINE Pay 金額驗證失敗：amount(1) ≠ products加總(320)，訂單未送出」。確認金流無法被前端竄改的金額欺騙。

### E. 優惠券使用次數原子性
`coupon_redemptions` 寫入永遠在 `orders` INSERT **成功之後**才執行（即使中途拋錯，外層 try/catch 会讓整支 request 一起失敗，不會產生「訂單失敗但已計入使用次數」的孤兒紀錄）；`coupon_redemptions` 已有 `UNIQUE(store_id, order_id)` 索引搭配 `INSERT OR IGNORE`，可防止同一張訂單重複寫入。**未另外包一層 `db.transaction()`**：檢查後發現 `routes/line-orders.js`（外帶/外送，行為完全相同的既有模組）本身也從未使用 `db.transaction()` 包住這段邏輯，且 `sql.js` 在單一 request handler 內是同步、單執行緒執行（呼叫之間沒有 `await` 讓出控制權），不存在其他請求插隊造成競態的可能；為了與既有模組保持一致、且不引入本次範疇外的新模式，故未新增 transaction 包裝，這點在下方「已知限制」誠實列出。「LINE Pay Request 失敗永久占用優惠券」的疑慮：優惠券使用次數是在**訂單建立當下**（而非付款完成當下）計入，這是外帶/外送/宅配三者共用的既有系統設計（非本次引入），詳見已知限制。

### F. 回歸驗證
- LINE 外帶優惠券：✅ 套用 PERCENT10（小計300）→ 訂單 total=270，成功建立
- 與原始上傳版本逐檔 diff：Hotfix22-B + 22-C 累計只改動 `public/index.html`、`public/js/app.js`、`public/line-order.html`、`public/line-shipping.html`、`routes/line-shipping.js`、`routes/linepay.js` 六個檔案；`routes/coupons.js`、`routes/line-orders.js`、`routes/business-calendar.js`、`routes/settings.js`、POS、Android **完全未變動**，故 Business Calendar、外帶/外送臨時截止時間、LINE 商品份數、冷藏宅配商品管理、訂單紀錄營業額統計等功能結構上不受影響。

### G. 語法與結構檢查
`node --check`：`server.js`、`routes/line-orders.js`、`routes/line-shipping.js`、`routes/coupons.js`、`routes/linepay.js`、`public/js/app.js` 全數通過。抽取 `line-order.html`／`line-shipping.html` 內嵌 JS 語法檢查通過。`index.html`／`line-order.html`／`line-shipping.html` 皆無重複 `id`、`<div>`／`</div>` 數量平衡。打包前已移除 `node_modules`、`data`（測試用 sqlite 檔），專案內無 `.env`、`*.db` 殘留。

---

## 已知限制（誠實列出）

1. **優惠券通路限制欄位**：`coupons` 資料表本來就沒有任何通路限制欄位，`validateCoupon()` 對所有通路一視同仁。若店家未來需要「只給外帶用」這類限制，需新增 `applicable_channel` 欄位與對應後台 UI，這是一個新功能，本次範疇內未實作（避免違反「不要新增其他功能」的指示）。
2. **未使用 DB transaction 包裝**：如上方 E 節說明，`sql.js` 同步單執行緒特性下無實際競態風險，且與既有 `line-orders.js` 的既有模式保持一致，故未新增。
3. **優惠券使用次數計入時機**：與外帶/外送既有設計相同，於「建立訂單」當下計入使用次數，而非「付款成功」當下。若顧客建立宅配訂單後 LINE Pay 未完成付款即放棄，該次優惠券使用仍會被計入次數。此為三種通路共用的既有系統行為，非本次新增的落差。
4. **LINE Pay 沙盒無法連線**：本測試環境網路白名單不含 `sandbox-api-pay.line.me`，因此無法完整走完「使用者實際在 LINE Pay 頁面付款」這段外部流程；已驗證的是金額組裝、驗證、拒絕偽造金額、以及 Confirm 導回頁邏輯，與 Hotfix22-B 記錄的限制相同。
