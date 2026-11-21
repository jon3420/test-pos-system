# R54.4／MBV2-HF1-C6.2 現況稽核（實作前）

> 稽核對象：未修改基準 `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_1_RESTOCK_LIST_AUTO_TOGGLE_UI_TIMING_FIX_APP_ROOT.zip`（SHA-256 `749617a5…8cfdb`）。
> 行號以基準為準。結論：基準只有「轉換追蹤」，沒有「登記份數 ↔ 訂單」的任何連動，也沒有依登記份數加購的入口；只改顯示數字無法滿足需求。

## 1. 通知連結、會員登入與商品直達

| 項目 | 現況（基準） |
|---|---|
| 連結內容 | `utils/restockNotify.buildProductLink()`：LIFF 網址＋`product_ref`（商品穩定識別）＋`src=restock`＋`m`（取餐方式）＋`d`（供應日期）＋`rt`（批次追蹤識別，不含個資）。**不含會員、登記份數或訂單資訊** |
| 前端擷取 | `public/line-order.html` `_parseRestockLinkParams()`（L749）只接受 UUID 格式的 `product_ref`；`m`／`d` 只作提示 |
| 開啟商品 | `_initRestockDeepLink()`（L8877）：等會員 Gate（含 `liff.init()`）→ `GET /api/product-demand/product-ref` 取得目前公開商品 → `openProductDetail(p.id)`；不加購、不改購物車。同一次開啟的重新整理／返回／登入返回不重複開啟（`_restockAlreadyOpened()`） |
| 會員身分 | 只信任後端簽章的 `member_session`（`utils/lineMemberSession.verifyMemberSession`）；前端 `_currentMemberSession()` 讀 `localStorage.line_member_session_<店別>` |
| 本人登記 | `POST /api/product-demand/mine`（body 帶 session）→ `productDemand.listMine()`；前端 `_loadMyDemands()`（L8352）以 session＋世代（`_pdMineGen`）防護舊回應，換帳號即作廢 |

## 2. 商品詳情、數量與加購

| 項目 | 現況（基準） |
|---|---|
| `openProductDetail()` | L7614。可購買判斷與商品卡相同（`computeProductSaleView`），再疊加 `checkCartIncrement(id,p,1)` |
| 數量預選 | **固定 `const startQty = 1;`（L7670）**；完全不讀本人登記 |
| 加入 | 詳情 `onAddToCart` 以迴圈呼叫 `addCart(id)` qty 次（每次各自驗證） |
| 共用加購驗證 | `resolveCartQuantityPolicy()`／`checkCartIncrement()`（L7797）：停售、取餐方式、今日／預購額度（含購物車既有數量）；`addCart()` L7813、`chgQty()` 共用 |
| 購物車儲存 | `persistCart()`（L9170）→ `localStorage.line_order_cart_<店別>`，只存 `product_id → qty` 與取餐方式；**伺服器不知道購物車** |
| 加購事件 | `_trackAddToCart()` → `/api/analytics/events` `add_to_cart`；通知商品另由 `restockTracking.recordCartAdd()` 記錄 |

## 3. 登記資料

| 欄位／規則 | 現況（基準） |
|---|---|
| `product_demand_requests` | `request_uuid`（唯一）、`cycle_no`、`desired_qty`（1–99）、`fulfillment_pref`、`status`（active／cancelled／expired）、`expires_at`（預設 30 天） |
| 週期 | 同店、同商品、同會員只能有一筆 `status='active'`（部分唯一索引 `idx_pdr_active_unique`）；過期後重新登記建立新週期（`cycle_no+1`） |
| 通知同意 | `product_demand_consents` 綁定 `request_uuid`；新週期不沿用舊同意 |
| 已完成份數 | **沒有任何欄位**；登記不會因下單而減少或完成（C3 註解只保留未使用的 `converted_order_id` 規劃） |

## 4. 一般 LINE 訂單與付款狀態機

| 入口 | 現況（基準） | 本輪對應 |
|---|---|---|
| 建立訂單 `POST /api/line-orders` | `routes/line-orders.js` L1535；會員只來自 `verifyMemberSession`（L1865）；單一 durable 交易（L1897）寫入訂單、份數 counter、優惠券、食材 | 同一交易內以 SAVEPOINT 綁定登記週期 |
| 現金／非 LINE Pay | 建立即寫 `purchase`（視為成交），`payment_status` 維持 `pending` | 有效訂單成立即扣減 |
| LINE Pay 付款請求 | `POST /api/linepay/request` 建付款嘗試（`requesting`→`requested`） | 訂購中 |
| LINE Pay 已付款 | `linePayRecovery.settle()`→`commitPaid()`（L244，durable；`orders.payment_status='paid'`）＋ outbox `payment_side_effects` | outbox 新增 `demand_settle`；確認 callback 後另同步一次 |
| LINE Pay 失敗 | 付款嘗試 `failed`（官方明確拒絕）、`aborted_cancelled`；訂單仍為待付款，可重新付款 | 解除訂購中（之後付款成功仍可扣減） |
| LINE Pay 逾期 | **沒有到期處理**（未付款訂單一直待付款） | 付款請求超過 30 分鐘仍未送出 Confirm → 解除訂購中 |
| 取消 | `utils/orderStatusFlow.applyOrderStatusChange()`（L155）：LINE 訂單後台、Android（online-orders）、POS 共用；只能取消未完成訂單 | 取消後依原綁定回復 |
| 作廢 | `POST /api/orders/:id/void`（routes/orders.js L838）：**可作廢已完成訂單** | 作廢前已完成 → 待核對；未完成 → 回復 |
| 退款 | 只有 `refund_status`（pending_refund／refunded）標記；**沒有逐項退款資料** | 不自動處理（不重建需求或同意） |
| 付款恢復 | 後台「LINE Pay 付款待核對」`/api/linepay-admin/reconcile`（只做唯讀查詢，不重送 Confirm）；啟動後補齊 outbox | 同步呼叫；`demand_settle` 可補齊 |

## 5. 補貨轉換追蹤與需求統計

- `utils/restockTracking.js`：`recordOpen()`、`recordCartAdd()`、`attributeOrder()`（最後一次有效點擊後 7 天）、`summary()`。
  **只用於通知成效報表**，需要有通知點擊才歸因，不會改變登記份數 → 「轉換追蹤」不等於「登記已完成」。
- 後台 `productDemand.adminSummary()／adminDetail()`、`/snapshot`、CSV `utils/demandExport.js`：只計算 active 未過期登記的 `desired_qty`。

## 6. MBV2 匯出／匯入與資料庫遷移

- `utils/migrationV2.js` 分類 `product_demand`＝requests＋consents（匯入同意標示需重新確認）；`restock_notify` 只合併、未完成工作暫停；匯入不發送通知。
- 完整取代重建商品時，登記與同意以條碼／名稱重新對應（`remapPreservedDemand()`）。
- 遷移：`utils/db.js` 啟動時依序執行各模組 `migrate()`（只 CREATE IF NOT EXISTS／ADD COLUMN）。

## 7. 缺口與本輪設計對照

| 缺口 | 本輪 |
|---|---|
| 詳情固定 1 份 | 依本人登記「尚待購買 − 購物車既有」預選，受共用驗證上限限制；按鈕顯示份數；不自動加購 |
| 沒有一起加入 | 「我的登記商品，一起加入」：只合併相同取餐方式與供應日期 |
| 沒有已完成份數、沒有訂單關聯 | `settled_qty`／`completed_at`；新表 `product_demand_order_links`（訂單 UUID＋商品＋登記週期＋份數＋狀態） |
| LINE Pay 待付款可能被重複帶入 | 訂購中份數（`state='reserved'`）從「尚待購買」扣除 |
| 取消、失敗、逾期沒有回復機制 | 依後端狀態同步；以目前 state 為條件，重複呼叫只套用一次 |
| 統計口徑只看原登記 | 統一份數定義（原登記／已完成／訂購中／尚待購買），會員、後台、CSV 共用 |
