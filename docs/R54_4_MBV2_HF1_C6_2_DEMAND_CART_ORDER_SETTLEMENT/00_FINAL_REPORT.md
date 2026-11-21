# R54.4／MBV2-HF1-C6.2 補貨登記數量一鍵加購與訂單連動：最終報告

> 本輪**未部署、未操作正式資料、未發送真實通知**。真實 LINE、LINE Pay、Sandbox 呼叫皆為 **0**。
> 「多商品合併通知」列為下一輪 C6.3，本輪沒有修改通知發送引擎（`utils/restockNotify.js`、`utils/restockAuto.js` 與基準逐位元組相同）。

## 0. 摘要

**完成的需求**

1. 顧客從補貨通知（或商品卡）開啟商品時，依**本人登記份數**預選數量，按鈕顯示「加入購物車 N 份」；單純開啟不改購物車。
2. 「我的登記商品，一起加入」：只合併相同取餐方式與供應日期的商品，依登記數量加入；回報實際加入與未加入的原因。
3. 訂單有效成立後，依**實際成立份數**扣減未完成登記；剩餘 0 標記已完成。
4. 加入購物車不扣減；LINE Pay 待付款標記為「訂購中」，付款成功才扣減；失敗、逾期解除；未履約前取消回復。
5. 不刪除任何登記或關聯：已完成登記移出有效統計，會員與後台都能查到歷史。

**做法**：新增訂單關聯表 `product_demand_order_links`（訂單 UUID＋商品＋登記週期＋份數＋狀態）與登記欄位 `settled_qty`、`completed_at`。綁定在訂單建立的同一個 durable 交易內完成（SAVEPOINT 隔離，失敗不影響訂單）；之後所有轉換都依後端訂單與付款狀態同步，並以「目前狀態」為條件，重複呼叫只套用一次。

**新驗收**：同一份腳本、同一組斷言 43 項：未修改基準 7／43（N 類 36 項全部失敗，G／Z 類全部通過），候選版全新解壓 43／43。

**升級／回退**：同一資料庫 C6.1 → C6.2 → C6.1 → C6.2，9／9：遷移可重複執行、升級前歷史訂單不回溯扣減、回退可運作、再升級補齊回退期間已綁定訂單的付款與取消（各一次）。

**回歸**：既有 41 項套件中 39 項在基準與候選版逐項相同（exit code、結果行、失敗行）；其餘 2 項是 MBV2 分類新增資料表造成的精確清單斷言，已依規格調整並逐項列出（第 8.2 節），調整後候選版通過、基準失敗。列表 UI 40／40、UI 時序補修 28／28、C6 24／24、C6.1 29／29、名額釋放 29／29、一般 LINE 結帳與付款恢復、MBV2 121／121 都與基準相同。

## 1. 基準核對

| 項目 | 值 |
|---|---|
| 檔案 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_1_RESTOCK_LIST_AUTO_TOGGLE_UI_TIMING_FIX_APP_ROOT.zip`（上傳檔名前綴不同，內容相同） |
| SHA-256 | `749617a54de6589aa57c649a07b4489004a6b519472475a9f440f4481498cfdb`（相符） |
| 大小 | 9,578,406 bytes（相符） |
| 檔案／ZIP 項目 | 1,044／1,100（相符） |
| Manifest | 1,041 筆。逐檔大小與 SHA-256 全部相符：不符 0、缺少 0；未列入的只有 C6.1 的 00、01、02 三份自我參照文件 |

- **基準樹**：同一份 ZIP 全新解壓，只加入本輪新驗收腳本與其測試替身（`scripts/lib/c62-bind-fault.js`）。
- **工作樹**：同一份 ZIP 全新解壓後修改。
- **候選版**：從同一份 ZIP 全新解壓，只放入本輪修改與新增的 21 個檔案（產品 16 個、新增測試 3 個、規格調整的既有測試 2 個）。

## 2. 現況稽核（摘要）

完整內容見 `04_REALITY_AUDIT.md`。重點：

| 項目 | 基準 |
|---|---|
| 商品詳情 | `openProductDetail()` 固定 `const startQty = 1`（`line-order.html` L7670），不讀本人登記 |
| 共用加購驗證 | `checkCartIncrement()`（L7797）：停售、取餐方式、今日／預購額度（含購物車既有數量） |
| 購物車 | 只在瀏覽器 localStorage；伺服器不知道購物車 |
| 登記 | `request_uuid` 週期、`desired_qty`、有效期、通知同意綁定週期；**沒有已完成份數、沒有訂單關聯** |
| 訂單／付款 | 現金建立即成交；LINE Pay `commitPaid()` 交易內設為已付款；失敗為付款嘗試 `failed`；**沒有付款逾期處理**；取消走 `applyOrderStatusChange()`；作廢可作用於已完成訂單 |
| 轉換追蹤 | `restockTracking` 只做通知成效報表（需點擊、7 天歸因），**不改登記份數** |

## 3. 實作

### 3.1 修改檔案

| 檔案 | 差異 | 內容 |
|---|---|---|
| `utils/demandSettlement.js` | 新增 325 行 | 遷移、份數定義 `qtyView()`、綁定、扣減／解除／回復／待核對、依訂單狀態同步 `syncOrder()`、定期補齊 `sweep()` |
| `utils/productDemand.js` | +73／−5 | 本人登記與後台統計加入份數拆分；`listMineCompleted()`；修改登記的已購買份數保護 |
| `routes/product-demand.js` | +27 | `POST /mine/history`、`GET /api/product-demand-admin/requests/:id/orders`；登記帶 `expect_settled_qty` |
| `routes/line-orders.js` | +12 | 訂單交易內綁定（SAVEPOINT）；失敗時交易後補綁一次 |
| `utils/linePayRecovery.js` | +13 | 已付款 outbox 新增 `demand_settle`；後台核對後同步 |
| `routes/linepay.js` | +2 | 付款 callback 後同步 |
| `utils/orderStatusFlow.js` | +5 | 取消成功後同步（回復） |
| `routes/orders.js` | +2 | 作廢後同步（傳入作廢前是否已完成） |
| `server.js` | +4 | 啟動後與每分鐘補齊 |
| `utils/db.js` | +4 | 啟動遷移 |
| `utils/demandExport.js` | +14／−6 | CSV 在原欄位之後新增份數欄 |
| `utils/migrationV2.js` | +31／−3 | 分類 `product_demand` 加入關聯表；匯入只作歷史；完整取代清除／重新對應 |
| `public/line-order.html` | +334／−14 | 詳情預選、一起加入、會員清單份數、晚到回應防護 |
| `public/js/product-detail-modal.js` | +47／−3 | 選用欄位 `demandNote`／`qtyInLabel`／`bundle`、`current()`／`update()`（未傳入時行為不變；宅配頁不受影響） |
| `public/js/app.js` | +14／−4 | 後台總表與明細顯示份數拆分（表格仍為 7 欄） |
| `public/index.html` | 1 行 | app.js 快取版本字串 |
| `scripts/…c6-2-demand-cart-order-settlement.js`、`…c6-2-upgrade-rollback.js`、`scripts/lib/c62-bind-fault.js` | 新增 | 本輪驗收 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js`、`scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | 各 1 項斷言 | MBV2 精確清單加入新資料表（規格調整，見 8.2） |

**沒有修改**：通知發送引擎（`restockNotify.js`、`restockAuto.js`、`linePush.js`）、`restockTracking.js`（轉換追蹤口徑不變）、付款核心判定（Confirm／唯讀查詢／隔離規則）、快閃與宅配流程、Android／License 相關檔案。

### 3.2 資料庫

| 物件 | 內容 |
|---|---|
| `product_demand_requests.settled_qty` | 已完成份數（預設 0） |
| `product_demand_requests.completed_at` | 完成時間；`status` 新增值 `completed` |
| `product_demand_order_links` | `link_uuid`、`store_id`、`order_uuid`、`order_number`（只供顯示）、`product_id`、`request_uuid`、`line_user_id`、`order_qty`、`applied_qty`、`state`、`payment_method`、`note`、各時間、`import_source` |
| 索引 | `idx_pdol_uuid`（唯一）、`idx_pdol_order_product`（`store_id, order_uuid, product_id` 唯一）、`idx_pdol_request`、`idx_pdol_state` |

全部為 `CREATE IF NOT EXISTS`／`ADD COLUMN`，可重複執行。空資料庫啟動：基準 236 個物件、候選版 241 個（只多 1 張表、4 個索引）。

### 3.3 份數定義（會員、後台、CSV 共用 `qtyView()`）

| 名稱 | 計算 |
|---|---|
| 原登記 | `desired_qty` |
| 已完成 | `min(settled_qty, desired_qty)` |
| 訂購中 | `min(該週期 state='reserved' 的 order_qty 合計, 剩餘)` |
| 尚待購買 | `max(0, desired_qty − settled_qty) − 訂購中` |

前端「本次需要補入」＝`max(0, 尚待購買 − 購物車既有份數)`，再受 `checkCartIncrement()` 的今日／預購額度與限購限制。

## 4. 訂單狀態對應（以後端狀態為準）

| 情況 | 實際判斷（欄位／入口） | 關聯狀態 | 登記 |
|---|---|---|---|
| 開啟通知、預選數量 | 前端只讀 `/mine`；沒有任何寫入 | — | 不扣減 |
| 加入或移除購物車 | 只寫瀏覽器 localStorage | — | 不扣減 |
| 現金／非 LINE Pay 訂單成立 | `POST /api/line-orders` 交易內，`payment_method≠'linepay'` | settled | 扣減 `min(訂單份數, 剩餘)` |
| LINE Pay 訂單建立、等待付款 | 同一交易，`payment_method='linepay'` | reserved | 不扣減，計入訂購中 |
| LINE Pay 已付款 | `orders.payment_status='paid'`（`commitPaid()` 交易）→ outbox `demand_settle`；callback／後台核對後同步；定期補齊 | reserved／released → settled | 扣減 |
| 付款失敗 | 付款嘗試 `failed`／`aborted_cancelled`，且沒有其他進行中的付款嘗試 | reserved → released（`payment_failed`） | 保留 |
| 付款逾期 | 付款嘗試 `requesting`／`requested`、未送出 Confirm、建立超過 30 分鐘（沒有付款嘗試時以訂單建立時間計） | reserved → released（`payment_expired`） | 保留 |
| 付款確認中（待核對） | 付款嘗試 `confirm_pending`／`review`／`paid_duplicate` | 維持 reserved | 不扣減 |
| 未履約前取消 | `applyOrderStatusChange(…,'cancelled')`（訂單已完成時本來就不能取消） | settled → reverted；reserved → released | 回復 `applied_qty` |
| 未完成訂單作廢 | `POST /api/orders/:id/void`，作廢前 `order_status≠'completed'` | 同上 | 回復 |
| 已完成訂單作廢 | 作廢前 `order_status='completed'` | settled → review（`void_after_completed`） | 不回復 |
| 已完成後退款 | 只有 `refund_status` 標記 | 不變 | 不重建需求或通知同意 |

回復的細節：
- 只回復當時扣減的 `applied_qty`，最少回到 0。
- 已完成的週期：仍在有效期限內、且本人此商品沒有另一個有效週期時，才恢復為有效；否則維持已完成並記錄 `cycle_not_reopened`。
- 已取消或已過期的週期不會被恢復。

## 5. 防重與歷史

| 要求 | 做法 | 驗收 |
|---|---|---|
| 穩定識別 | 訂單 UUID＋商品＋`request_uuid`；唯一索引 `(store_id, order_uuid, product_id)`；不使用顯示訂單編號 | A2 |
| 重複 callback、查詢、恢復、補登、重啟只扣一次 | 轉換一律 `UPDATE … WHERE state IN (…)`，先轉換關聯、成功才更新登記；同一交易 | A10、A5、U8 |
| 取消回復防重、不為負、不超額 | 只有 `state='settled'` 能回復；`max(0, settled−applied)`；扣減上限為剩餘 | A5、A8 |
| 舊訂單只影響當時週期 | 綁定時固定 `request_uuid` | A4、A15 |
| 付款期間修改登記 | 扣減時才以當時剩餘計算；訂單不被改動；已購買份數改變時修改登記 409 | A14、A16 |
| 部分取消／退款無法對應 | 不靠整單金額猜份數；作廢已完成訂單 → 待核對 | A7 |
| 不依賴通知點擊 | 綁定只看後端驗證會員與有效登記週期；通知歸因仍由 `restockTracking` 依原規則計算 | A2（沒有任何通知） |
| 不回溯歷史訂單 | 只在訂單建立時綁定，沒有回填 | U1、U2 |
| 匯入、重啟、補登不發送通知 | 份數連動沒有呼叫任何通知；匯入關聯標記來源並由同步排除 | Z1、A21、U8 |
| 付款成功後更新可補齊、不重送 Confirm | outbox `demand_settle`＋定期補齊；份數連動與 Confirm 流程分開 | A10（Confirm 1 次） |

## 6. 新驗收

- **腳本**：`scripts/smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js`
- **環境**：正式 `server.js`、暫存 SQLite 檔、真實 Chrome（Playwright 1.63）。LINE 為 `c4-line-mock`、LINE Pay 為 `c5-linepay-mock`（程序內攔截）；綁定故障以 `c62-bind-fault.js` 注入。
- **分類**：N＝本輪新功能（基準應失敗）；G＝保留既有行為（基準也應通過）。Z 為全程檢查。

| 案例 | 類 | 內容 | 基準 | 候選版 |
|---|---|---|---|---|
| A1 | N | [API] 登記 5 份：本人登記回傳原登記 5、已完成 0、訂購中 0、尚待購買 5 | ❌ | ✅ |
| A2 | N | [API][DB] 現金訂單（後端成立有效訂單）3 份 → 立即扣減：已完成 3、尚待購買 2；關聯以訂單 UUID＋商品＋登記週期保存 | ❌ | ✅ |
| A3 | N | [API][DB] 再成立 2 份 → 剩餘 0、標記已完成；移出有效需求統計；會員歷史與後台明細仍可查詢 | ❌ | ✅ |
| A4 | N | [API][DB] 已完成後重新登記（新週期）；取消舊訂單只回復舊週期（2/5），不復活舊週期、不改動新週期 | ❌ | ✅ |
| A5 | N | [API][RS] 重複取消被拒；真實重啟＋啟動補齊後仍只回復一次（不回復成負數或超額） | ❌ | ✅ |
| A6 | N | [API][DB] 有效訂單在未履約前取消 → 依原綁定回復（已完成 2 → 0，同一週期恢復有效，尚待購買 2） | ❌ | ✅ |
| A7 | N | [API][DB] 已履約（已完成）訂單作廢 → 關聯待核對，不自動回復需求、不重建登記或通知同意 | ❌ | ✅ |
| A8 | N | [API][DB] 實際成立 5 份（登記 2）→ 只扣到 0、標記已完成（不超額） | ❌ | ✅ |
| A9 | N | [API][DB] LINE Pay 訂單已建立、等待付款 → 標記訂購中 4（不扣減；尚待購買 0，不會重複帶入） | ❌ | ✅ |
| A10 | N | [API][DB][RS] LINE Pay 已付款 → 扣減 4、完成；重複 callback、同時重複、後台核對、真實重啟都只扣一次；Confirm 只送 1 次 | ❌ | ✅ |
| A11 | N | [API][DB] LINE Pay 付款失敗 → 解除訂購中，保留未完成需求（尚待購買 3） | ❌ | ✅ |
| A12 | N | [API][RS] LINE Pay 逾期未付款 → 解除訂購中（尚待購買 2）；之後付款成功 → 扣減一次並完成 | ❌ | ✅ |
| A13 | N | [API][DB] 待付款時取消訂單 → 解除訂購中；取消後才回來的付款 callback（不送 Confirm）也不扣減 | ❌ | ✅ |
| A14 | N | [API][DB] 付款期間把登記改為 2 → 付款後只扣 2（不為負、不超額）；已送出的訂單（3 份）不被改動 | ❌ | ✅ |
| A15 | N | [API][DB] 付款期間取消登記、再建立新登記 → 舊訂單付款後不復活舊週期、不扣到新週期 | ❌ | ✅ |
| A16 | N | [API][DB] 修改登記：已購買份數變動時 409 不寫入；不得少於或等於已購買份數；正常修改後尚待購買 4 | ❌ | ✅ |
| A17 | G | [API] 本人登記只來自後端驗證會員：其他帳號看不到；未登入、偽造 session、body 帶他人 line_user_id 一律無效（既有保護） | ✅ | ✅ |
| A17-2 | N | [API] 新增的「已完成的登記」查詢同樣只限後端驗證會員本人（他人 line_user_id 無效、未登入 401） | ❌ | ✅ |
| A18 | N | [API][DB] 未登入下單（沒有後端驗證會員）不綁定任何登記、不扣減 | ❌ | ✅ |
| A19 | N | [API][FX] 交易內綁定失敗：訂單照常成立並補綁一次；補綁也失敗時訂單仍成立、不留下半套扣減 | ❌ | ✅ |
| A20 | N | [API] 會員、後台總表、明細 CSV、統計 CSV 與「登記→訂單」查詢使用同一份數定義（原登記／已完成／訂購中／尚待購買）；不外露會員識別 | ❌ | ✅ |
| A21 | N | [API][RS] MBV2 匯出／匯入：份數關聯隨登記搬家並標記匯入來源；來源「訂購中」改為待核對；匯入與重啟都不扣減、不回復、不發送通知 | ❌ | ✅ |
| B1 | N | [BR] 從通知開啟：顯示「你尚有 5 份補貨登記」、預選 5 份、按鈕「加入購物車 5 份」；單純開啟不改購物車 | ❌ | ✅ |
| B2 | N | [BR][DB] 確認加入（含連點）只加入 5 份、加購事件 1 筆（5 份）；加入購物車不扣減登記、不建立訂單關聯 | ❌ | ✅ |
| B3 | N | [BR] 重新整理不重複開啟或加入；再次開啟通知 → 提示已在購物車、不再累加（購物車仍 5） | ❌ | ✅ |
| B4 | N | [BR] 購物車已有 2 → 只補入 3；已有 5 → 提示已在購物車、不累加；顧客手動放 6 → 維持 6 不自動減少 | ❌ | ✅ |
| B5 | N | [BR] 今日額度剩 3：明確提示最多再加 3、其餘 2 份需求保留；加入 3 份後無法再加；登記仍為 5（加購不扣減） | ❌ | ✅ |
| B6 | N | [BR] 一起加入：購物車為空且商品的取餐方式／日期不同 → 列出可選組合，引導顧客選擇、不任意代選（未選前不能送出） | ❌ | ✅ |
| B7 | N | [BR] 選擇「外帶自取・今日」：清單顯示名稱、未完成份數、本次可加入份數、勾選與原因；不同日期、不支援方式、停售、額度不足都不強行加入 | ❌ | ✅ |
| B8 | N | [BR] 「將勾選商品加入購物車」（含連點）：回報實際加入的商品與份數；購物車、商品卡同步；加購事件只記錄實際加入的份數 | ❌ | ✅ |
| B9 | N | [BR] 購物車已有商品 → 共同情境依購物車；已加入的商品顯示「已在購物車」、不重複加入 | ❌ | ✅ |
| B10 | G | [BR] 未登入：詳情不顯示登記、從 1 份開始、一般加購照常 | ✅ | ✅ |
| B11 | G | [BR] 轉傳的通知連結：開啟者（另一位會員）看不到原收件人的登記，從 1 份開始 | ✅ | ✅ |
| B12 | N | [BR] 詳情開啟中換帳號：前一位會員的登記份數立即移除，數量回到 1（不以舊會員資料加購） | ❌ | ✅ |
| B13 | N | [BR] 晚到的本人登記：只更新目前開啟的商品（豆干，不套用雞爪）；顧客已調整為 2 時不改數量；未調整時改為預選 3 | ❌ | ✅ |
| B13-2 | N | [BR] 本人登記讀取失敗：不預選、不殘留舊資料，一般加購照常；重新讀取成功後依「登記 3 − 購物車 1」預選 2 | ❌ | ✅ |
| B14 | N | [BR][DB] 清空購物車、離開頁面：登記份數不變（仍 5、已完成 0、無訂單關聯） | ❌ | ✅ |
| B15 | N | [BR][API] 現金訂單成立後：商品卡、詳情、我的補貨登記、後台總表顯示一致（原登記 5、已購買 2、尚待購買 3） | ❌ | ✅ |
| B16 | N | [BR] 後台補貨登記：總表與明細清楚區分原登記、已完成、訂購中、尚待購買；已完成週期保留可查（表格仍為 7 欄） | ❌ | ✅ |
| B17 | G | [BR] 前台與後台沒有 JavaScript 錯誤 | ✅ | ✅ |
| Z1 | Z | [DB] 份數連動沒有建立任何補貨通知批次或逐筆發送紀錄 | ✅ | ✅ |
| Z2 | Z | [FX] 真實 LINE 呼叫 0 | ✅ | ✅ |
| Z3 | Z | [FX] LINE Pay 全部由替身處理（呼叫數 11，真實／Sandbox 0） | ✅ | ✅ |
| **合計** | | N 36、G 4、Z 3 | **7／43** | **43／43** |

- 基準：N 類 36 項全部失敗（36／36），G 類 4 項與 Z 類 3 項全部通過。
- 工作樹先前版本（重新分類與新增 A17-2、B13-2 之前）：41／41。

**截圖**（`screenshots/`，取自候選版全新解壓的執行，測試商品）：

| 檔名 | 內容 |
|---|---|
| `b1_detail_preselect_5.png` | 從通知開啟：你尚有 5 份補貨登記、預選 5、加入購物車 5 份 |
| `b3_already_in_cart.png` | 再次開啟：已在購物車、不再累加 |
| `b5_partial_limit.png` | 額度剩 3：最多再加 3 份、其餘 2 份保留 |
| `b6_bundle_choose_context.png` | 一起加入：取餐方式／日期不同，請顧客選擇 |
| `b7_bundle_rows.png` | 選擇外帶・今日後的清單與原因 |
| `b8_bundle_result.png` | 加入結果與已在購物車 |
| `b13_late_mine_applied.png` | 晚到的登記資料只更新同一次開啟 |
| `b15_my_demands_numbers.png` | 我的補貨登記：已購買／訂購中／尚待購買 |
| `b16_admin_demand_breakdown.png` | 後台總表與明細的份數拆分 |

## 7. 升級／回退

- **腳本**：`scripts/smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js`（`C62_OLD_ROOT`＝未修改基準全新解壓）。同一個資料庫檔，每一步都是真實停機與啟動。

| 案例 | 內容 | 結果 |
|---|---|---|
| U0 | [RS] C6.1 資料庫：尚無份數欄位與訂單關聯表（真正的升級前狀態） | ✅ |
| U1 | [RS][DB] 升級：新增欄位與關聯表；升級前的歷史現金訂單不被自動扣減（雞爪仍 5、已完成 0、無關聯） | ✅ |
| U2 | [RS] 升級前建立的 LINE Pay 訂單在升級後付款成功：付款照常，但不以新功能回溯扣減（豆干仍 3） | ✅ |
| U3 | [RS] 遷移可重複執行：再次啟動結構雜湊不變 | ✅ |
| U4 | [API] 升級後的新訂單正常連動（雞爪 1/5、腱子完成、雜項完成、LINE Pay 訂購中） | ✅ |
| U5 | [RS] 回退為 C6.1：可啟動、可查詢、可登記、可付款與取消；回退期間不做份數連動（已完成週期不顯示、付款與取消不更新份數） | ✅ |
| U6 | [RS] 再升級：回退期間已綁定訂單的付款（→ 扣減 3、完成）與取消（→ 回復並恢復有效）由啟動補齊各處理一次 | ✅ |
| U7 | [RS] 回退限制如實呈現：回退期間建立的訂單不連動；舊版把登記改為 ≤ 已購買份數者，再升級時視為已完成；舊版建立的新週期不受影響 | ✅ |
| U8 | [RS] 再次重啟不重複扣減或回復；升級、回退、再升級都沒有建立通知、真實 LINE 0 | ✅ |

**回退方式**：部署上一版 ZIP 即可；資料庫不需處理（舊版忽略新欄位與新表）。回退限制見 `03_OPERATIONS_GUIDE.md` 第 6 節：回退期間不做份數連動；回退期間建立的訂單永遠不連動；回退期間已綁定訂單的付款與取消，在再升級後由啟動補齊處理一次。

## 8. 回歸

**執行方式**：未修改基準（全新解壓＋本輪驗收腳本）與候選版全新解壓，同時段平行執行（2026-11-20 台北約 12:25～13:15，2 核心）。

| 套件 | 基準 | 候選版 | 比較 |
|---|---|---|---|
| smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js | 結果：6 通過、35 失敗 | 結果：41 通過、0 失敗 | 本輪新驗收（最終數字見第 6 節） |
| smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js | — | 結果：9 通過、0 失敗 | 本輪新增（需舊版程式樹，只在候選版執行） |
| smoke-r54-4-mbv2-hf1-c6-1-restock-list-ui-timing-fix.js | 結果：28 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 結果：28 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 相同 |
| smoke-r54-4-mbv2-hf1-c6-1-restock-list-auto-toggle-ui.js | 結果：40 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 結果：40 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 相同 |
| smoke-r54-4-mbv2-hf1-c6-auto-restock.js | 結果：24 通過／0 失敗 | 結果：24 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c6-1-auto-guard-recovery.js | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js | RESULT: 80 passed, 0 failed | RESULT: 80 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js | RESULT: 34 passed, 0 failed（模擬 LINE 呼叫 2 次；真實 0 次需為 0：0） | RESULT: 34 passed, 0 failed（模擬 LINE 呼叫 2 次；真實 0 次需為 0：0） | 相同 |
| smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js | RESULT: 20 passed, 0 failed（真實 LINE 呼叫 0 次） | RESULT: 20 passed, 0 failed（真實 LINE 呼叫 0 次） | 相同 |
| smoke-r54-4-mbv2-hf1-c4-restock-notify.js | RESULT: 94 passed, 0 failed | RESULT: 93 passed, 1 failed | 規格調整，見 8.2 |
| smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js | RESULT: 40 passed, 0 failed | RESULT: 40 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c4-5-date-consent.js | RESULT: 55 passed, 0 failed | RESULT: 55 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c4-5-restock-link.js | RESULT: 42 passed, 0 failed | RESULT: 42 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c4-linepush-compat.js | RESULT: 12 passed, 0 failed（全部為程序內模擬，真實 LINE 呼叫 0 次） | RESULT: 12 passed, 0 failed（全部為程序內模擬，真實 LINE 呼叫 0 次） | 相同 |
| smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js | RESULT: 328 passed, 4 failed | RESULT: 327 passed, 5 failed | 規格調整，見 8.2 |
| smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js | RESULT: 54 passed, 0 failed | RESULT: 54 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js | RESULT: 32 passed, 0 failed | RESULT: 32 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js | RESULT: 30 passed, 0 failed | RESULT: 30 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c5-restock-conversion.js | RESULT: 41 passed, 1 failed | RESULT: 41 passed, 1 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c5-restock-conversion.js `C4_CLOCK_OFFSET_MS=0` | RESULT: 42 passed, 0 failed | RESULT: 42 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c1-preorder-status.js | RESULT: 93 passed, 0 failed | RESULT: 93 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-migration.js | RESULT: 121 passed, 0 failed | RESULT: 121 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-2-popup-establishment-taipei-time.js | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge.js | 結果：22 通過／0 失敗 | 結果：22 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-2-payment-response-timing.js | 結果：18 通過／0 失敗 | 結果：18 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-1-popup-payment-status-refresh.js | 結果：19 通過／0 失敗 | 結果：19 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-1-timing-fix.js | 結果：11 通過／0 失敗 | 結果：11 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js | 結果：27 通過／0 失敗 | 結果：27 通過／0 失敗 | 相同 |
| smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js | RESULT: 25 passed, 0 failed | RESULT: 25 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js | RESULT: 33 passed, 0 failed | RESULT: 33 passed, 0 failed | 相同 |
| smoke-r54-4-mbv2-hf1-c5-1-consistency.js | RESULT: 61 passed, 0 failed | RESULT: 61 passed, 0 failed | 相同 |
| run-h1-4-10-phase3-checkout-submit-payment-runtime.js | TOTAL=111 PASS=111 FAIL=0 | TOTAL=111 PASS=111 FAIL=0 | 相同 |
| run-h1-4-10-phase4b-recovery-full-runtime.js | TOTAL=168 PASS=168 FAIL=0 | TOTAL=168 PASS=168 FAIL=0 | 相同 |
| run-h1-4-10-phase4b-recovery-frontend-targeted.js | TOTAL=50 PASS=50 FAIL=0 | TOTAL=50 PASS=50 FAIL=0 | 相同 |
| run-h1-4-10-phase4b-recovery-resume-targeted.js | TOTAL=92 PASS=92 FAIL=0 | TOTAL=92 PASS=92 FAIL=0 | 相同 |
| smoke-h1-4-12-popup-frontend.js | PASS: 293  FAIL: 0  TOTAL: 293 | PASS: 293  FAIL: 0  TOTAL: 293 | 相同 |
| smoke-h1-4-12-popup-real-browser.js | PASS: 36  FAIL: 0  TOTAL: 36 | PASS: 36  FAIL: 0  TOTAL: 36 | 相同 |
| smoke-h1-4-12-popup-public-checkout.js | PASS: 1447  FAIL: 0  TOTAL: 1447 | PASS: 1447  FAIL: 0  TOTAL: 1447 | 相同 |
| smoke-h1-4-12-popup-checkout-integration.js | PASS: 20  FAIL: 0  TOTAL: 20 | PASS: 20  FAIL: 0  TOTAL: 20 | 相同 |
| smoke-h1-4-12-popup-recovery-cart-frontend.js | PASS: 67  FAIL: 0  TOTAL: 67 | PASS: 67  FAIL: 0  TOTAL: 67 | 相同 |
| smoke-h1-4-12-popup-state.js | PASS: 94  FAIL: 0  TOTAL: 94 | PASS: 94  FAIL: 0  TOTAL: 94 | 相同 |
| smoke-r48-popup-order-ui-browser.js | rc=1（無結果行） | rc=1（無結果行） | 相同；單獨執行（preload 取報告行）：基準 PASS: 10  FAIL: 3  TOTAL: 13、候選版 PASS: 10  FAIL: 3  TOTAL: 13 |

### 8.1 既有失敗（基準與候選版逐項相同，不寫成通過）

1. **smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js**：`O1`、`O6-paused`、`O6-sold_out_indefinitely`、`O9`（time_too_early（真實時鐘相依））。
2. **smoke-r54-4-mbv2-hf1-c5-restock-conversion.js（預設時鐘）**：`B1`（時鐘相依；C4_CLOCK_OFFSET_MS=0 時 42/42）。
3. **smoke-r48-popup-order-ui-browser.js**：`R_TOUCH_TARGET_44`、`R_NO_STICKY_FIXED`、`R_FATAL`（既有（清單內執行時無結果行，另以 preload 單獨執行））。

### 8.2 既有斷言調整

本輪**沒有放寬**任何既有斷言。因本輪規格（份數關聯隨「商品想買登記」分類搬家）需要，調整 2 項精確清單斷言：

| 檔案 | 斷言 | 原斷言 | 新斷言 | 理由 | 原斷言：基準／候選版 | 新斷言：基準／候選版 |
|---|---|---|---|---|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | B2 完整與選擇性備份涵蓋通知歷史 | 選擇性備份（product_demand,restock_notify）的資料表精確清單 === 'product_demand_consents,product_demand_requests,restock_notify_batches,restock_notify_cart_adds,restock_notify_clicks,restock_notify_deliveries,restock_notify_order_attributions' | 精確清單 === 'product_demand_consents,product_demand_order_links,product_demand_requests,restock_notify_batches,restock_notify_cart_adds,restock_notify_clicks,restock_notify_deliveries,restock_notify_order_attributions'（其餘條件不變） | 本輪規格要求登記與訂單的份數關聯隨「商品想買登記」分類搬家（MBV2 匯出／匯入）；清單仍為精確比對，沒有放寬 | RESULT: 94 passed, 0 failed／RESULT: 93 passed, 1 failed | RESULT: 93 passed, 1 failed／RESULT: 94 passed, 0 failed |
| `scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | B3 選擇性備份只含想買登記兩張表，並附商品對照表 | 選擇性備份（product_demand）的資料表精確清單 === 'product_demand_consents,product_demand_requests'，且附商品對照表 | 精確清單 === 'product_demand_consents,product_demand_order_links,product_demand_requests'，且附商品對照表（名稱改為「三張表（登記、同意、份數關聯）」） | 同上：分類新增份數關聯表；清單仍為精確比對，其餘條件不變 | RESULT: 328 passed, 4 failed／RESULT: 327 passed, 5 failed | RESULT: 327 passed, 5 failed／RESULT: 328 passed, 4 failed |

新斷言在基準失敗、在候選版通過，代表斷言是依新規格收緊而不是放寬。C3 套件另外 4 項是既有的時鐘相依失敗（8.1），兩邊相同。

既有套件中沒有「成交不扣減登記」的假設：基準沒有任何份數欄位，既有測試只檢查 `desired_qty` 與有效登記人數，而這些在沒有訂單連動時與基準相同（C3、C4.2 的總表、明細與 CSV 原欄位都通過）。

## 9. 測試層級

| 層級 | 涵蓋 |
|---|---|
| BR（真實瀏覽器） | B1～B17：詳情預選、連點、重新整理、購物車 2／5／6、額度、一起加入、未登入、轉傳、換帳號、晚到回應、讀取失敗、清空購物車、訂單後畫面、後台 |
| API | A1～A21：正式路由（登記、下單、LINE Pay 請求與 callback、後台核對、取消、作廢、CSV、MBV2 匯出入） |
| DB | 直接讀資料庫檔核對登記、關聯、付款嘗試、outbox |
| RS（真實重啟） | A5、A10、A12、A21，升級／回退 U1～U8 |
| FX（測試替身） | LINE、LINE Pay、綁定故障注入 |
| 函式級 | 本輪沒有 |

## 10. 未執行與限制

- 真實 LINE、LINE Pay、Sandbox、真機驗收：本輪皆未進行（呼叫 0）。
- 宅配（冷藏宅配）與快閃場次訂單不連動；不比對登記的取餐偏好；已完成後的部分退款不自動回復。
- LINE Pay 付款逾期以「付款請求 30 分鐘未送出 Confirm」判定（LINE Pay 付款網址預設 20 分鐘失效）；確認中（待核對）的付款一律維持訂購中。
- 既有快閃／付款回退套件（`c5-4-2-*-upgrade-rollback` 等）需要更舊的程式樹，本輪未重跑；本輪改用 C6.1 → C6.2 的升級／回退驗收（第 7 節）。

## 11. 打包

### 11.1 流程

1. 從未修改基準 ZIP 全新解壓，只放入本輪 21 個檔案，組成候選版（排除 `.env`、資料庫、`node_modules`、上傳資料、測試輸出；保留 `.env.example`）。
   - 候選版 v1（回歸用）：SHA-256 `bfdd597462d4d7214115118a5793b3fc7950b0b4b4992ca181193bd7b20e1f29`，9,622,743 bytes，1,104 項。
   - 候選版 v2（最終已測）：SHA-256 `198a6e02c353894dc876a8bcbf481f3ed6a9ba01668340dd6ef4ebc31c454f1c`，9,623,328 bytes，1,104 項（1,048 檔案＋56 目錄）。
   - v1 → v2 只差 3 支測試腳本（本輪驗收重新分類並新增 A17-2、B13-2；2 支既有測試的規格調整斷言）；應用程式檔案逐位元組相同。
2. 候選版全新解壓後依序執行：
   - `npm ci`：成功（v1、v2 各一次）。
   - 空資料庫啟動：`/api/health` 回 `{"status":"ok"}`，出現 `[restock_auto] boot recovery done (stale_batches=0 legacy_review=0)`；`sqlite_master` 241 個物件（基準 236）。
   - v2：本輪驗收 43／43、升級／回退 9／9、兩支規格調整的既有套件（第 8.2 節）。
   - v1：第 8 節全部回歸（與基準同時段平行）與 R48 單獨執行。
3. 加入本輪文件目錄，產生最終 ZIP，並與已測候選版 v2 逐項比較。

### 11.2 Manifest

- `02_FILE_MANIFEST.json` 列出最終套件所有檔案的大小與 SHA-256（含先前各輪文件與本輪截圖）。
- 只排除本輪 `00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json` 三份自我參照文件。
- 最終 ZIP 的雜湊、大小與逐檔比較結果見套件外最終報告（第 11.3 節）。

