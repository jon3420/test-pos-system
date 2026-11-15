# R54.4／MBV2-HF1-C5.4 最終報告：付款狀態與明細顯示修正＋快閃 LINE Pay 付款安全與恢復

> 交付套件的 SHA-256 無法寫在 ZIP 內；見交付訊息與專案報告 `claude/R54_4_MBV2_HF1_C5_4_FINAL_REPORT.md`。

## 0. 摘要

- **基準**：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_3_PAYMENT_VERIFICATION_REPAYMENT_GUARD_FIX_APP_ROOT.zip`
  - SHA-256 `6f48be7822484ca7fb45f1b49d9fa9349f27fe8941fa7398ac89d0a5f058e60f`（已重新核對相符）。
  - 968 個檔案、43 個資料夾項目，共 1011 個 ZIP 項目；根目錄有 `server.js`、`package.json`。
  - ZIP 內 manifest 的 965 筆逐檔 SHA-256 全部相符（另 3 筆為 C5.3 報告檔本身）。
- **兩棵樹**：
  - 「未修改 C5.3 基準樹」只加入測試檔：`scripts/smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`、`scripts/lib/c54-linepay-mock.js`。產品程式未修改。
  - 另以基準 ZIP 全新解壓一份（`npm ci`），作為升級／回退測試的「舊版」。
- **本輪範圍**：未部署、未操作正式資料、未開啟任何通知；未進行正式或 Sandbox 付款。
  - 真實 LINE Messaging API 與 LINE Pay（Request、Confirm、唯讀查詢、退款）呼叫一律 **0 次**；未知 LINE Pay 路徑由替身立即拋錯（紀錄 0 行）。
- **結果**：
  - 同一組 27 個案例：未修改 C5.3 為 **4 通過／23 失敗**（原始缺陷直接重現 19、新功能不存在 4、測試前提 0、連帶 0）；C5.4 為 **27／27**。
  - 真實升級（C5.3 建立並使用的資料庫 → C5.4）與回退（C5.4 → C5.3 → C5.4）：**4／4**。
  - 回歸（同一時段、三棵樹並行逐支比較 81 支）：80 支結果完全相同；唯一不同為既有的畫面時序不穩定案例（未修改 C5.3 單獨重跑也會出現，見第 8 節）。第一輪發現的 2 項真正回歸已修正（第 8.2 節）。
  - 全新解壓驗證：候選 ZIP 全新解壓、`npm ci`、空資料庫啟動後，主驗收 27／27、升級回退 4／4，C5.3／C5.2／C5.1 驗收全數通過（第 9 節）。

---

## 1. 重現：同一組案例，先未修改 C5.3，再 C5.4

腳本：`scripts/smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`（`C54_ONLY=U,A,P` 可分組；`C54_STEP=<正規式>` 可指定案例）。

層級：[API] 正式 routes＋暫存 SQLite 檔（`node server.js`）｜[BR] 真實 Chrome（Playwright）｜[RS] SIGKILL 真正終止程序後以同一資料庫檔重啟｜[FX] fixture 歷史資料（明確標示）。
分類：**D** 原始缺陷直接重現｜**N** 新功能／新介面（基準不存在）｜**P** 測試前提或替身問題｜**C** 連帶失敗｜**G** 主流程回歸保護。

| 案例 | 內容 | 分類 | C5.3 | C5.4 | C5.3 實際表現（摘要） |
|---|---|---|---|---|---|
| U1 | [API] 查詢訂單、我的訂單、狀態輪詢回傳伺服器 `payment_display`：現金、未付款、已付款、確定失敗、待核對、已付款取消（待退款）、已退款、多次嘗試（先拒絕後成功） | N | ❌ | ✅ | 欄位不存在 |
| U2 | [BR] 訂單詳情：訂單狀態與付款狀態分開；確定失敗「付款失敗，本次付款未完成」、現金「取餐時付款」、已付款取消「已付款・待退款」 | D | ❌ | ✅ | 詳情只有「待確認」與付款方式「LINE Pay」 |
| U3 | [BR] 待核對訂單：詳情與我的訂單卡片顯示「付款結果確認中，請勿重複付款」，不提供「再次購買／再購」 | D | ❌ | ✅ | 顯示「再次購買」與「再購」 |
| U4 | [BR] 只改付款狀態（履約仍為待確認）時，輪詢把詳情由「付款結果確認中」更新為「已付款」 | D | ❌ | ✅ | 輪詢只取履約狀態，付款狀態不在畫面上 |
| U5 | [BR] 返回網址 `linepay=success` 但伺服器為待核對：顯示「付款結果確認中」；伺服器已付款才顯示付款成功 | D | ❌ | ✅ | 依網址直接顯示「💚 LINE Pay 付款成功」 |
| U6 | [BR] 我的訂單切換帳號：較慢的舊查詢回應不覆蓋新帳號 | D | ❌ | ✅ | 舊帳號清單最後覆蓋畫面 |
| U7 | [API][FX] 多次付款嘗試：較早待核對＋最新確定失敗 → 仍為「付款結果確認中」、阻擋重新付款 | N | ❌ | ✅ | 欄位不存在 |
| U8 | [API][FX][BR] 宅配：待核對付款顯示「付款結果確認中」；返回成功網址不顯示付款成功、不清空購物車 | D | ❌ | ✅ | 顯示「待付款」；返回頁先清空購物車 |
| U9 | [BR] 後台訂單列表：待核對「付款結果確認中」、確定失敗「付款失敗」、已付款「已付款」 | D | ❌ | ✅ | 待核對顯示「待付款」 |
| A1 | [BR] 一般訂單詳情：1 元顯示 $1、150 元×2 顯示 $300 | D | ❌ | ✅ | 兩者都顯示 $0 |
| A2 | [API][FX][BR] 0 元保留 $0；折扣 -$50、外送費 $60 列出且差額 0；舊資料缺金額「金額資料不足」；合法歷史行小計沿用；查詢不改寫訂單 | D | ❌ | ✅ | 缺金額顯示 $0、沒有折扣／外送費拆分 |
| P1 | [API] 快閃正常付款：Confirm 1 次、名額保留→成立一次；重複 callback ×2 不再 Confirm | G | ✅ | ✅ | — |
| P2 | [API] 付款前顧客取消：確定未付款（Confirm 0）、允許時可改現金 | G | ✅ | ✅ | — |
| P3 | [API] 付款前店家已取消訂單、顧客之後完成授權：不送 Confirm、維持取消與釋放 | D | ❌ | ✅ | 送出 Confirm（1 次）並記為已付款，取消的訂單被請款 |
| P4 | [API] 付款中（Confirm 進行中）店家取消：保留取消、標待退款、不搶回名額 | D | ❌ | ✅ | 記為已付款但沒有待退款標示 |
| P5 | [API] Confirm 回應遺失＋查詢 1150：待核對、再次 callback Confirm 仍 1 次、改現金與重新付款 409 | D | ❌ | ✅ | 直接判 failed，顧客可改現金（200）——金流端其實已扣款 |
| P6 | [API] 19 位交易識別：回應只差最後一位（Number 相等）且查詢失敗 → 待核對、不標已付款 | D | ❌ | ✅ | `Number()` 容錯比對通過，標為已付款 |
| P7 | [API] Confirm 只回 0000 → 唯讀查詢完整核對後才完成；未知代碼 1999＋查無 → 待核對、不能改現金 | D | ❌ | ✅ | 前者判 failed（實際已付款）；後者判 failed、可改現金 |
| P8 | [API] 並行 callback ×3：外部 Confirm 1 次 | D | ❌ | ✅ | 外部 Confirm 3 次 |
| P9 | [API] Confirm 前保存失敗：外部 Confirm 0；下一次 callback 送出第一次並完成 | D | ❌ | ✅ | 先送 Confirm、保存失敗；再次 callback 又送 Confirm（共 2 次）→ 1172 → failed |
| P10 | [API] Confirm 進行中履約逾時：取消並釋放但不判未付款；成功晚到 → 已付款・待退款、不搶回名額 | D | ❌ | ✅ | 逾時判 expired、payment_status=cancelled；成功回應被丟棄（顧客已扣款、無退款標示） |
| P11 | [API][RS] Confirm 送出後 SIGKILL：重啟後待核對；callback 只唯讀查詢（Confirm 仍 1）並完成 | D | ❌ | ✅ | 重啟後 callback 再送 Confirm（共 2 次）→ 1172 → failed |
| P12 | [API] 後台待核對含快閃；唯讀核對查無 → 仍待核對；金流已付款 → 完成（Confirm 1、名額轉換一次） | N | ❌ | ✅ | 沒有快閃待核對與核對介面 |
| P13 | [API] 第一次 Confirm 被明確拒絕（1142）→ 確定未付款、可改現金；callback 驗證失敗 400、Confirm 0 | G | ✅ | ✅ | — |
| P14 | [API][FX][RS] 升級前快閃紀錄：provider_declined 失敗 → 隔離待核對；顧客取消 → 維持失敗；有交易識別的 pending → 只唯讀核對；重啟不變 | N | ❌ | ✅ | 沒有歷史隔離 |
| P15 | [BR] 快閃付款畫面（回應遺失、查詢失敗）：「付款結果確認中」，不提供前往付款或改現金 | D | ❌ | ✅ | 「付款未完成」並提供「改用現金」 |
| Z | 真實 LINE／LINE Pay 呼叫 0；未知 LINE Pay 路徑 0；替身簽章全部正確 | G | ✅ | ✅ | — |
| **合計** | | | **4／27** | **27／27** | |

C5.3 失敗 23 項：原始缺陷直接重現 **D 19**、新功能不存在 **N 4**、測試前提 **P 0**、連帶 **C 0**。

**本輪測試自身的修正（P）**：P10 第一次撰寫時以真實時鐘設定 `expires_at`，但伺服器使用測試時鐘（台北 10:30 偏移），逾時從未發生；已改用伺服器時鐘並加大時間餘裕，在兩版重跑。產品程式未因此修改。

使用者已確認的真機失敗（卡片與電話綁定資料不符）屬於已知操作情況。本輪**沒有**依此硬編碼任何付款結果，也沒有把待核對改為付款失敗；顧客端只呈現後端實際掌握的結果（U1～U9）。

---

## 2. 客戶端付款狀態（統一付款顯示）

**根因**
- `openOrderDetail()`、我的訂單卡片、上一筆訂單卡片只依 `order_status` 顯示（「待確認」＝店家尚未接單）；付款只顯示付款方式（「LINE Pay」）。後端 `payment_status`、`payment_review` 已存在，但畫面沒有使用。
- 輪詢 `/api/line-orders/status/:no` 只回傳履約欄位，只改付款狀態時畫面不會更新；WebSocket 推播只處理履約狀態。
- LINE Pay 返回頁以網址參數 `linepay=success` 直接顯示「付款成功」並清空購物車（宅配頁相同）。
- 我的訂單查詢沒有請求序號，切換帳號後較慢的舊回應會覆蓋新畫面。

**修正**
- 新增 `utils/paymentDisplay.js`：伺服器依可信資料計算 `payment_display`（`state`、`label`、`tone`、`under_review`、`blocks_repay`、`can_repay`、`refund`）。
  - 資料來源只有 `orders.payment_status`／`refund_status`／履約欄位與付款嘗試表（一般：`linepay_payment_attempts`；快閃：`popup_payment_attempts`），不讀返回網址或瀏覽器儲存值。
  - 多次付款嘗試的合併順序：已退款 → 已付款・待退款 → 已付款 → **任何一筆仍不明（待核對）** → 現金／非線上方式 → 最新一筆的確定結果。最新一筆是確定失敗，也不會蓋過另一筆已付款或待核對（U1 multi、U7）。

| 實際情況 | state | 顯示 |
|---|---|---|
| 尚未開始／尚未完成付款 | `awaiting_payment` | 等待付款 |
| 已確認付款成功 | `paid` | 已付款 |
| 已確認被拒絕／未完成（有判定依據） | `failed` | 付款失敗，本次付款未完成 |
| 可能已付款、結果尚未確認 | `under_review` | 付款結果確認中，請勿重複付款 |
| 現金訂單 | `pay_at_pickup` | 取餐時付款 |
| 已付款但訂單取消 | `paid_refund_pending` | 已付款・待退款 |
| 已確認退款完成 | `refunded` | 已退款 |
| 未付款且訂單已取消 | `not_charged_cancelled` | 訂單已取消・未付款 |
| 轉帳、平台付款等 | `offline_pending` | 待店家確認收款 |

- 套用位置（同一份口徑）：
  - 一般點餐：`POST /api/line-orders`（完成頁）、`/query`、`/history`、`/status/:no`（輪詢，另可帶 `?ref=<uuid>`，同號多筆回 409）。
  - 宅配：`/api/line-shipping/history`、`/order/:no`、`/admin/orders`；`payment_status_label` 改用同一份標籤（原本只有「待付款／付款成功」）。
  - 後台：`GET /api/orders`（訂單頁、LINE 預購管理共用）每筆附 `payment_display`；訂單列表、詳情、宅配表、預購表都顯示付款徽章。
  - 快閃：`popupOrderLookup` 的顧客文字與 `derivePopupPaymentState()` 加上「付款結果確認中」「已付款・待退款」。
- 前台（`public/line-order.html`）：
  - 詳情多一列「付款狀態」，與「訂單狀態」分開；待核對、確定失敗、待退款有對應說明區塊，不使用慶祝標題或圖示。
  - 待核對時隱藏「再次購買」「再購」並說明原因（後端確認不再待核對時，輪詢會恢復按鈕）。
  - 輪詢同時套用付款狀態；只套用「目前顯示中訂單」的最新回應，網路錯誤保留最後一次正確狀態，切換訂單後舊請求結果丟棄。WebSocket 推播只觸發重新查詢，不以推播內容推定付款結果。
  - LINE Pay 返回頁先顯示中性的「正在確認付款結果…」，再依伺服器 `payment_display` 顯示；只有伺服器確認已付款才顯示「付款成功」、清空購物車、觸發 Purchase。宅配返回頁相同。
  - 我的訂單（一般、宅配）加入請求序號，切換帳號或重查時舊回應不覆蓋。
- 重新付款：後端（C5.3 `PAYMENT_UNDER_REVIEW`、快閃 `PAYMENT_UNDER_REVIEW`）才是準則；前台不提供任何會引導重複支付的操作。

## 3. 商品明細 $0

**根因**：`buildCanonicalItems()` 保存 `product_id、name、price、qty`，不保存 `subtotal`；一般訂單詳情使用 `i.subtotal||0`、完成頁使用 `$${i.subtotal}`（`undefined`），後台詳情也使用 `i.subtotal`。

**修正**（`utils/paymentDisplay.normalizeItems／amountBreakdown`，前台 `c54LineAmount()`，後台 `c54LineAmountText()`）：
- 行小計：合法的歷史行小計（有限、非負數字，含 0）→ 否則保存的單價 × 數量 → 否則 `null`（畫面「金額資料不足」）。不以 truthy 判斷、不讀商品目前價格。
- 金額明細 `amount_breakdown`：商品小計、折扣、外送費、運費、保存的總額，以及「其他調整」（總額與前述計算的差額；只顯示，不改寫）。不把商品行小計湊成付款總額。
- 不改寫任何歷史訂單的總額、折扣、運費或付款金額（A2 以資料庫前後比對驗證）。
- 驗收：1 元、150 元、數量 2、0 元、折扣、外送費、舊資料缺欄位、合法歷史行小計（A1、A2）。
- 未修改：報表的「熱賣商品營收」等統計仍使用既有欄位（不在本輪範圍，列為已知限制）。

## 4. 快閃 LINE Pay 付款安全與恢復

**根因（C5.3 `routes/popup-public.js` `/popup-payment/linepay-confirm`）**
1. 交易識別以 `Number()` 容錯比對（19 位識別在 JS 數字下會被視為相同）；回應以 `apiRes.json()` 解析（失去精度）。
2. 送出 Confirm 前不保存任何處理階段；並行或重複 callback、程序重啟後的 callback 都會再送 Confirm（P8 3 次、P9／P11 2 次）。
3. 網路錯誤、回應遺失、未知代碼、`0000` 但缺欄位、重複交易一律判 `failed`，並依設定取消訂單、釋放名額或允許改現金（P5、P7）。
4. 送出 Confirm 前不檢查訂單是否已取消（P3 取消的訂單被請款）。
5. 逾時處理把 Confirm 進行中的付款判為 `expired` 並把 `payment_status` 設為 cancelled；之後成功回應因狀態不是 pending 而被丟棄（P10：顧客已扣款、沒有任何紀錄與退款標示）。
6. 付款中取消時，成功回應記為已付款但沒有待退款標示（P4）。

**修正**（新增 `utils/popupPaymentRecovery.js`；`routes/popup-public.js` 的 confirm／cancel 改呼叫它；`utils/popupPayment.js` 調整逾時、改現金、狀態文字）

| 項目 | 實作 |
|---|---|
| 交易識別 | 回應文字經 `linePayRecovery.safeParseLinePay()` 把交易識別轉為字串；callback、保存值、回應全部字串精確比對。沒有保存的交易識別 → 不送 Confirm（授權會逾時，不會請款）。 |
| Confirm 前 durable 保存 | 條件式 `UPDATE … SET status='confirm_pending', confirm_state='sent', confirm_calls+1 WHERE status='pending' AND confirm_state='never' AND confirm_calls=0 AND transaction_id=?` 必須恰好改到 1 列。保存失敗或沒改到列 → 外部 Confirm 0 次（P9）。 |
| 只送第一次 | 只有 `confirm_state='never'`＋`pending`＋`confirm_calls=0` 才能送；同一程序內另以記憶體集合合併同時的 callback（P8）。 |
| 曾送出或可能已送出 | callback、重啟、後台核對一律只做唯讀查詢（共用 `linePayRecovery.inquire()`：交易、orderId、`transactionType='PAYMENT'`、幣別、金額、無退款全部相符才算已付款）。 |
| 結果分類 | `0000` 且 `info.transactionId`、`info.orderId`、`payInfo` 金額全部相符 → 已付款；缺任何一項 → 唯讀查詢；官方明確拒絕清單（沿用 C5.3 `DEFINITIVE_DECLINE_CODES`，只適用這次可信的第一次 Confirm）→ 確定未付款（保存 `failure_basis='first_confirm_declined:<代碼>'`）；網路錯誤、逾時、無法解析、重複交易、處理中、內部錯誤、未知代碼 → 唯讀查詢，查不到維持待核對。 |
| 已取消／作廢／逾時 | 送出前已取消 → `aborted_cancelled`、不送 Confirm（P3）。已確認付款時重新讀取訂單：已取消、作廢或履約已關閉 → `paid_cancelled`，訂單 `payment_status='paid'`、`refund_status='pending_refund'`，保留取消、不轉換已釋放的名額（P4、P10）。 |
| 履約逾時與付款分開 | 結果不明的付款逾時：依既有 `expire_cancel_release` 取消訂單、釋放名額（`fulfillment_closed=1`），但 `payment_status` 維持 pending、付款嘗試維持待核對（不宣告未付款）。 |
| 改現金／重新付款 | `switch-to-cash` 只接受「有判定依據」的確定失敗；待核對一律 409 `POPUP_PAYMENT_UNDER_REVIEW`。`linepay-request` 對待核對或處理階段不明者回 409 `PAYMENT_UNDER_REVIEW`。舊前端呼叫既有 API 也一樣（後端阻擋）。 |
| 名額與副作用 | 只有 `commitPaid` 會轉換名額（`popupSales.commitReservedForOrder` 只動 `active＋reserved` 列，重複呼叫 0 列）。快閃付款沒有食材、會員消費或 Analytics 副作用（沿用既有設計）；P1、P8、P12 核對名額只轉換一次、P4／P10 核對已釋放者不被搶回。 |
| 程序中斷 | 啟動時 `confirm_pending` → 待核對（`interrupted`），不呼叫外部 API；後台「LINE Pay 付款待核對」面板列出快閃待核對、已付款待退款、升級前未驗證的逾時紀錄，提供逐筆唯讀核對（P11、P12）。 |
| 保留的檢查 | 一次性 callback nonce 驗證、公開代碼、店別、活動、場次與授權檢查不變（P13）。快閃仍是獨立流程，不加入 `currentMode`、不套用一般訂單提交邏輯。 |
| 舊交易精度 | 不補零、不以相近數字配對：唯讀查詢以保存值精確查詢，查無或不符一律待人工核對。 |

## 5. 資料庫、API、設定變更

**資料庫**（additive、可重複執行；`utils/popupPaymentRecovery.migrate()` 由 `utils/db.js` 啟動與 `ensurePopupPaymentSchema()` 呼叫）
- `popup_payment_attempts` 新增欄位：`confirm_state`、`confirm_calls`、`review_reason`、`failure_basis`、`result_code`、`inquiry_count`、`last_inquiry_at`、`last_inquiry_result`、`next_check_at`、`fulfillment_closed`、`merchant_ref`、`confirmed_at`、`quarantined_from`、`state_version`；索引 `idx_popup_pay_attempt_open`。
- 觸發器 `trg_ppa_c54_quarantine_upd`：任何版本（含回退後的 C5.3）寫入「送出 Confirm 後的失敗」（`provider_declined`／`amount_or_id_mismatch`、有交易識別、沒有判定依據）時，立即轉為待核對。
- 升級時的歷史判定（只處理 `confirm_state` 為 NULL 的舊列，重複執行不變）：

| 舊紀錄 | 處理 |
|---|---|
| `pending`、沒有交易識別 | `never`（尚未建立 LINE Pay 付款） |
| `pending`、有交易識別 | `unknown`：callback 只做唯讀核對；逾時轉待核對、只關閉履約 |
| `failed` 且 `provider_declined`／`amount_or_id_mismatch`、有交易識別 | 隔離為 `review`（`quarantined_from`），不能改現金 |
| `failed` 且 `customer_cancelled`／`callback_mismatch`／`provider_not_ready` | 維持失敗，`failure_basis='legacy_preconfirm:…'`，可依設定改現金 |
| `expired`、有交易識別 | 狀態不變，標示 `c54_legacy_expired_unverified`，後台可唯讀核對 |
| `paid`、`cancelled` 等 | 只補處理階段 |

- 一般訂單資料表沒有結構變更。

**API**
- 新增欄位（不移除既有欄位）：`payment_display`、`amount_breakdown`、`items[].line_subtotal／line_subtotal_source／unit_price`、`order_ref`（一般查詢、宅配查詢、`POST /api/line-orders` 完成回應、`GET /api/orders`、`/api/line-shipping/admin/orders`）。
- `GET /api/line-orders/status/:no`：改為回傳 `payment_display`（不含個資），可帶 `?ref=`；同一編號多筆回 409 `ORDER_REF_AMBIGUOUS`（原本任取一筆）。
- `GET /api/linepay-admin/review`：多回傳 `popup_attempts`。`POST /api/linepay-admin/reconcile`：可帶 `popup_attempt_id` 只核對該筆快閃付款；未指定時一併核對快閃待核對（唯讀）。
- 快閃：`linepay-confirm` 導回結果新增 `pending`、`order_cancelled`、`paid_cancelled`、`expired`；`popup-payment/status` 新增 `under_review`、`order_status`；`switch-to-cash`、`linepay-request` 新增 409 錯誤碼（見第 4 節）。

**設定**：無新增設定；沿用快閃既有的 `allow_fallback_cash`、`expire_cancel_release`。

**產品程式檔**：
- 新增：`utils/paymentDisplay.js`、`utils/popupPaymentRecovery.js`。
- 修改：`routes/line-orders.js`、`routes/line-shipping.js`、`routes/orders.js`、`routes/linepay.js`、`routes/popup-public.js`、`utils/popupPayment.js`、`utils/popupOrderLookup.js`、`utils/db.js`、`public/line-order.html`、`public/line-shipping.html`、`public/js/app.js`、`public/index.html`（版本參數 `r54-4-mbv2-hf1-c5-4`）。

## 6. 外部呼叫次數（測試替身計數）

| 情境 | 外部 Confirm | 唯讀查詢 | 結果 |
|---|---|---|---|
| 快閃正常付款＋重複 callback ×2（P1） | 1 | 0 | 已付款 |
| 顧客在 LINE Pay 取消（P2） | 0 | 0 | 確定未付款 |
| 付款前店家已取消（P3） | 0 | 0 | 不請款、維持取消 |
| 付款中取消（P4） | 1 | 0 | 已付款・待退款 |
| 回應遺失＋查詢 1150、再次 callback（P5） | 1 | ≥2 | 待核對 |
| 回應識別只差最後一位＋查詢失敗（P6） | 1 | 1 | 待核對 |
| 只回 0000（P7） | 1 | 1 | 查詢核對後已付款 |
| 並行 callback ×3（P8） | 1 | 0 | 已付款 |
| Confirm 前保存失敗、再 callback（P9） | 0 → 1 | 0 | 已付款 |
| Confirm 進行中逾時（P10） | 1 | 0 | 已付款・待退款 |
| Confirm 後 SIGKILL、重啟後 callback（P11） | 1 | 1 | 已付款 |
| 後台唯讀核對（P12） | 0（另加） | 2 | 查無→待核對；已付款→完成 |
| 一般訂單各種狀態顯示（U、A 組） | 與 C5.3 相同（顯示功能不呼叫外部） | — | — |
| 真實 LINE Messaging API／LINE Pay | **0** | **0** | — |

## 7. 既有測試調整

- **沒有修改任何既有測試或斷言**；也沒有放寬付款安全或通知防重送的斷言。
- 新增測試檔（只加測試，基準產品程式未修改）：`scripts/smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-4-upgrade-rollback.js`、`scripts/lib/c54-linepay-mock.js`（由 C5.3 替身複製，另加「回應交易識別只差最後一位」「扣款前回應遺失」兩種變體；C5.3 測試仍使用原檔）。

## 8. 回歸

### 8.1 一致的測試條件

- 測試時鐘預設台北 10:30（`C4_CLOCK_OFFSET_MS` 自動計算）；時段相關案例另以 `C4_CLOCK_OFFSET_MS=0` 執行並註明。
- 未修改 C5.3、C5.4 候選 ZIP 全新解壓樹、C6 候選 ZIP 全新解壓樹**三棵樹在同一時段並行**逐支執行同一份清單（81 支：C5.3 報告的主要回歸 14 支、C5.3／C5.2／C5.1 驗收、`C4_CLOCK_OFFSET_MS=0` 的 C5 驗收、快閃名額相關 2 支，以及既有 61 支）。

### 8.2 第一輪（工作樹）發現並修正的回歸

第一輪（未修改 C5.3 與 C5.4 工作樹並行）有 3 支不同，逐支處理：

| 腳本 | 第一輪結果 | 原因 | 處理 |
|---|---|---|---|
| `smoke-h1-4-12-popup-public-checkout.js` | 1446／1447 | **真正的回歸**：C5.4 在 `POST /api/line-orders` 回應新增的 `items` 原樣帶回 `options`（例如 `<script>…`），違反 R44.2E「描述性資料只保存、不出現在回應」契約。 | 回應的商品項目只保留顯示金額所需欄位（`product_id、name、qty、price、unit_price、line_subtotal、line_subtotal_source`）。重跑 1447／1447。 |
| `smoke-hotfix26-f4.js` | 30／32 | 靜態稽核以「函式開頭 300／400 字元內」比對 `resolvePickupLocation()`、`buildPickupLocationRowsHTML()` 的呼叫；C5.4 在前面插入程式碼，呼叫被推出比對範圍（功能未變）。 | 調整程式位置：`safeOrder()` 的金額正規化移到取餐地點之後；`buildDetailRows()` 先計算取餐地點。沒有修改測試。重跑 32／32。 |
| `smoke-h1-4-12-popup-admin-ui-browser.js` | 424／426（基準 425） | 多出的 BR51（快閃場次取消後「剩餘 1」標示）屬於並行負載下的畫面時序不穩定，與本輪無關。 | 單獨重跑：C5.4 三次皆 425／426；**未修改 C5.3 單獨重跑也出現一次 424／426**。另一項 LINK 失敗兩版皆有（既有）。 |

### 8.3 第二輪（候選 ZIP 全新解壓，同時段逐支比較）

- 81 支中 **80 支的 exit 代碼與通過／失敗數完全相同**；exit 0 的支數兩版皆為 59。
- 唯一不同的是上表的 `smoke-h1-4-12-popup-admin-ui-browser.js` BR51 不穩定案例（C5.4 這次 424／426，同一時段 C6 為 425／426；單獨重跑見 8.2）。
- 兩版相同的非 0 腳本（既有問題或需要參數／真機，與本輪無關）：`smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（預設時鐘的 B1 時段案例；`C4_CLOCK_OFFSET_MS=0` 版本兩版皆 42／42）、`smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js`（328／332，既有時段案例）、`mbv2-rescue-verify.js`（需參數）、GA4 相關凍結檔案稽核與其 wrapper、`smoke-hotfix26-*`／`27`／`29*` 舊字串稽核、`smoke-cart-delivery-live-refresh.js`、`smoke-r48-popup-order-ui-browser.js`、`static-audit-r48-popup-order-ui.js`。

| 腳本 | 未修改 C5.3 | C5.4（候選 ZIP 全新解壓） | 比較 |
|---|---|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | exit 1・41／42 | exit 1・41／42 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | exit 0・42／42 | exit 0・42／42 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | exit 0・55／55 | exit 0・55／55 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | exit 0・20／20 | exit 0・20／20 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | exit 0・34／34 | exit 0・34／34 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | exit 0・80／80 | exit 0・80／80 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | exit 0・40／40 | exit 0・40／40 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | exit 0・94／94 | exit 0・94／94 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | exit 0・12／12 | exit 0・12／12 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | exit 0・30／30 | exit 0・30／30 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | exit 0・32／32 | exit 0・32／32 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | exit 0・54／54 | exit 0・54／54 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | exit 1・328／332 | exit 1・328／332 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | exit 0・93／93 | exit 0・93／93 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js` | exit 0・25／25 | exit 0・25／25 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js` | exit 0・33／33 | exit 0・33／33 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | exit 0・61／61 | exit 0・61／61 | 相同 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js C4_CLOCK_OFFSET_MS=0` | exit 0・42／42 | exit 0・42／42 | 相同 |
| `scripts/smoke-h1-4-12-durable-release.js` | exit 0・95／95 | exit 0・95／95 | 相同 |
| `scripts/smoke-h1-4-12-line-counter-snapshot-boundary.js` | exit 0・73／73 | exit 0・73／73 | 相同 |
| `scripts/mbv2-rescue-verify.js` | exit 2 | exit 2 | 相同 |
| `scripts/run-g1-6-ga4-h1-4-4-view-item-runtime.js` | exit 1 | exit 1 | 相同 |
| `scripts/run-g1-6-ga4-h1-4-7-two-stage-checkout-runtime.js` | exit 0・113／113 | exit 0・113／113 | 相同 |
| `scripts/run-h1-4-10-asset-cache-bust-runtime.js` | exit 0 | exit 0 | 相同 |
| `scripts/run-h1-4-10-friend-live-runtime.js` | exit 0・24／24 | exit 0・24／24 | 相同 |
| `scripts/run-h1-4-10-historical-backend-reconcile-runtime.js` | exit 0・43／43 | exit 0・43／43 | 相同 |
| `scripts/run-h1-4-10-historical-friend-first-touch-runtime.js` | exit 0・37／37 | exit 0・37／37 | 相同 |
| `scripts/run-h1-4-10-phase1-liff-identity-runtime.js` | exit 0・68／68 | exit 0・68／68 | 相同 |
| `scripts/run-h1-4-10-phase2-line-friend-guide-runtime.js` | exit 0・114／114 | exit 0・114／114 | 相同 |
| `scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | exit 0・111／111 | exit 0・111／111 | 相同 |
| `scripts/run-h1-4-10-phase4b-recovery-frontend-targeted.js` | exit 0・50／50 | exit 0・50／50 | 相同 |
| `scripts/run-h1-4-10-phase4b-recovery-full-runtime.js` | exit 0・168／168 | exit 0・168／168 | 相同 |
| `scripts/run-h1-4-10-required-friend-gate-runtime.js` | exit 0 | exit 0 | 相同 |
| `scripts/run-h1-4-9-checkout-order-summary-runtime.js` | exit 0・67／67 | exit 0・67／67 | 相同 |
| `scripts/run-r54-4-mbv2-ui.js` | exit 0・19／19 | exit 0・19／19 | 相同 |
| `scripts/run-regression-g1-6-ga4-h1-4-6.js` | exit 1・69／72 | exit 1・69／72 | 相同 |
| `scripts/run-regression-g1-6-ga4-h1-4-7.js` | exit 1・69／72 | exit 1・69／72 | 相同 |
| `scripts/smoke-cart-delivery-live-refresh.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-delivery-distance-promotion.js` | exit 0・98／98 | exit 0・98／98 | 相同 |
| `scripts/smoke-h1-4-11-1-fixes.js` | exit 0・80／80 | exit 0・80／80 | 相同 |
| `scripts/smoke-h1-4-11-2-fixes.js` | exit 0・84／84 | exit 0・84／84 | 相同 |
| `scripts/smoke-h1-4-11-4-1-both-disabled-product-filter.js` | exit 0・60／60 | exit 0・60／60 | 相同 |
| `scripts/smoke-h1-4-11-4-product-mode-visibility.js` | exit 0・75／75 | exit 0・75／75 | 相同 |
| `scripts/smoke-h1-4-11-line-order-page-mode.js` | exit 0・66／66 | exit 0・66／66 | 相同 |
| `scripts/smoke-h1-4-12-popup-admin-ui-browser.js` | exit 1・425／426 | exit 1・424／426 | **不同** |
| `scripts/smoke-h1-4-12-popup-admin-ui.js` | exit 0・149／149 | exit 0・149／149 | 相同 |
| `scripts/smoke-h1-4-12-popup-checkout-integration.js` | exit 0・20／20 | exit 0・20／20 | 相同 |
| `scripts/smoke-h1-4-12-popup-frontend.js` | exit 0・293／293 | exit 0・293／293 | 相同 |
| `scripts/smoke-h1-4-12-popup-public-checkout.js` | exit 0・1447／1447 | exit 0・1447／1447 | 相同 |
| `scripts/smoke-h1-4-12-popup-real-browser.js` | exit 0・36／36 | exit 0・36／36 | 相同 |
| `scripts/smoke-h1-4-12-popup-recovery-cart-frontend.js` | exit 0・67／67 | exit 0・67／67 | 相同 |
| `scripts/smoke-h1-4-12-popup-recovery-identity-bridge.js` | exit 0・51／51 | exit 0・51／51 | 相同 |
| `scripts/smoke-h1-4-12-popup-recovery-landing.js` | exit 0・83／83 | exit 0・83／83 | 相同 |
| `scripts/smoke-hotfix25.js` | exit 0・26／26 | exit 0・26／26 | 相同 |
| `scripts/smoke-hotfix26-b.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix26-d.js` | exit 1・13／13 | exit 1・13／13 | 相同 |
| `scripts/smoke-hotfix26-f2.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix26-f3.js` | exit 0 | exit 0 | 相同 |
| `scripts/smoke-hotfix26-f4.js` | exit 0 | exit 0 | 相同 |
| `scripts/smoke-hotfix26-f5.js` | exit 0 | exit 0 | 相同 |
| `scripts/smoke-hotfix26-f7.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix26-f8-b.js` | exit 1・43／43 | exit 1・43／43 | 相同 |
| `scripts/smoke-hotfix26-f8.js` | exit 0・43／43 | exit 0・43／43 | 相同 |
| `scripts/smoke-hotfix26-i.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix27-cd.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix29-b.js` | exit 1・43／43 | exit 1・43／43 | 相同 |
| `scripts/smoke-hotfix29-c.js` | exit 1・43／43 | exit 1・43／43 | 相同 |
| `scripts/smoke-hotfix29.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-hotfix30-b5-r5-4-g1-live-geo.js` | exit 0・212／212 | exit 0・212／212 | 相同 |
| `scripts/smoke-hotfix30-b5-r5-debounce.js` | exit 0・32／32 | exit 0・32／32 | 相同 |
| `scripts/smoke-r48-popup-order-ui-browser.js` | exit 1 | exit 1 | 相同 |
| `scripts/smoke-r54-4-mbv2-large-upload.js` | exit 0・25／25 | exit 0・25／25 | 相同 |
| `scripts/smoke-r54-4-mbv2-migration.js` | exit 0・121／121 | exit 0・121／121 | 相同 |
| `scripts/smoke-r54-4-mbv2-system-regression.js` | exit 0 | exit 0 | 相同 |
| `scripts/static-audit-g1-6-ga4-h1-4-4.js` | exit 0 | exit 0 | 相同 |
| `scripts/static-audit-g1-6-ga4-h1-4-5.js` | exit 0・40／40 | exit 0・40／40 | 相同 |
| `scripts/static-audit-g1-6-ga4-h1-4-6.js` | exit 1・69／72 | exit 1・69／72 | 相同 |
| `scripts/static-audit-g1-6-ga4-h1-4-7.js` | exit 1・36／40 | exit 1・36／40 | 相同 |
| `scripts/static-audit-g1.js` | exit 0 | exit 0 | 相同 |
| `scripts/static-audit-r48-popup-order-ui.js` | exit 1・27／37 | exit 1・27／37 | 相同 |
| `scripts/test-phone-validation.js` | exit 0 | exit 0 | 相同 |


## 9. 全新解壓驗證（候選 ZIP → 新目錄 → `npm ci` → 空資料庫啟動 → 重跑）

| 腳本 | 結果 |
|---|---|
| `smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`（本版主驗收） | 27／27 |
| `smoke-r54-4-mbv2-hf1-c5-4-upgrade-rollback.js`（舊版＝基準 ZIP 全新解壓） | 4／4 |
| `smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`（C5.3 主驗收） | 25／25 |
| `smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js`（C5.2） | 33／33 |
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js`（C5.1） | 61／61 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（C5；`C4_CLOCK_OFFSET_MS=0`） | 42／42 |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111／111 |
| `run-h1-4-10-phase4b-recovery-full-runtime.js` | 168／168 |
| `smoke-r54-4-mbv2-migration.js` | 121／121 |
| `smoke-h1-4-12-popup-frontend.js` | 293／293 |
| `smoke-h1-4-12-popup-public-checkout.js` | 1447／1447 |
| `smoke-h1-4-12-popup-checkout-integration.js`／`smoke-h1-4-12-durable-release.js`／`smoke-h1-4-12-line-counter-snapshot-boundary.js` | 20／20、95／95、73／73 |
| C4／C4.x／C3.x／C1 主要回歸 14 支 | 與基準相同（見 8.3 表） |

- 未執行：C5.3／C5.2 的回退與升級腳本（`smoke-r54-4-mbv2-hf1-c5-3-rollback.js`、`…-c5-3-upgrade.js`、`…-c5-2-rollback.js`）需要 C5.2／C5.1 的全新解壓樹，本輪未提供這些舊版套件；C5.4 自己的升級／回退以 C5.3 驗證（第 10.1 節）。
- 最終 ZIP 與通過全新解壓驗證的候選 ZIP 逐檔比對：只有 `docs/R54_4_MBV2_HF1_C5_4/` 三個報告檔不同，產品與測試檔逐檔 SHA-256 相同（第 12 節）。

## 10. 升級、回退、部署

### 10.1 真實升級與回退（`smoke-r54-4-mbv2-hf1-c5-4-upgrade-rollback.js`，`C54_OLD_ROOT`＝基準 ZIP 全新解壓樹）

| 案例 | 內容 | 結果 |
|---|---|---|
| UP1 [RS] | 未修改 C5.3 建立並實際使用資料庫（快閃已付款、回應遺失被 C5.3 判失敗、已建立付款尚未 callback、一般現金訂單商品無行小計）→ C5.4 啟動：失敗者隔離為待核對（改現金 409）；舊 pending callback 不送 Confirm、唯讀核對完成；一般訂單付款顯示與商品金額（1 元×3＝$3）正確；重複啟動不變 | ✅ |
| RB1 [RS] | C5.4 → C5.3：可讀同一資料庫並啟動；待核對快閃付款在 C5.3 callback 不再送 Confirm；C5.3 對回應遺失判定的失敗由觸發器立即轉回待核對（改現金 409） | ✅ |
| RB2 [RS] | 再升級回 C5.4：回退期間被隔離的付款以唯讀核對完成（外部 Confirm 仍 1 次）；新付款正常完成 | ✅ |
| Z | 真實 LINE／LINE Pay 0 次、未知 LINE Pay 路徑 0 次 | ✅ |

### 10.2 部署後最短真機驗收（建議）

1. `GET /api/health` 200；啟動紀錄沒有 `popup_payment migration` 錯誤；若有「已隔離 N 筆」記下來。
2. 一般 LINE 點餐以現金下單：完成頁「付款狀態：取餐時付款」、商品明細金額正確（不再是 $0）。
3. 「查詢訂單」與「我的訂單」：同一訂單的付款狀態與完成頁一致；舊訂單商品金額正確或顯示「金額資料不足」。
4. 後台訂單頁、LINE 預購管理：LINE Pay 訂單顯示付款徽章（已付款／付款失敗／付款結果確認中／已付款・待退款）。
5. 若店家決定以真實小額付款驗證（正式環境、由店家自行決定）：一般 LINE Pay 一筆、快閃 LINE Pay 一筆。確認付款完成、返回頁顯示付款成功、後台「LINE Pay 付款待核對」沒有新增項目。**本輪未做真實或 Sandbox 付款，這是真實金流的第一次驗證。**
6. 後台「LINE Pay 付款待核對」面板：快閃待核對（標示［快閃］）可按「唯讀核對此筆」，核對結果與 LINE Pay 商家後台一致。

### 10.3 保留付款待核對資料的操作

- 不要刪除或手動改寫 `linepay_payment_attempts`、`popup_payment_attempts` 的待核對列；它們是「可能已付款」的唯一本機證據。
- 待核對付款只以唯讀核對處理；金流端已付款會自動完成（訂單已取消者記為已付款・待退款）。查無、空清單、等待時間都不代表未付款，也不能手動標記未付款（C5.3 起停用）。
- 退款仍由店家在 LINE Pay 商家後台處理，再於後台按「標記已退款」；系統**不會自動退款**。

### 10.4 回退條件與會重新暴露的風險

- 回退到 C5.3 可以啟動並讀取同一資料庫（RB1），C5.4 新欄位與觸發器 C5.3 會忽略，觸發器在回退期間仍會把「送出 Confirm 後的失敗」轉為待核對。
- **回退會重新暴露的風險（C5.3 快閃流程本身的缺陷）**：
  - 交易識別 `Number()` 容錯比對；回應遺失、未知代碼、`0000` 缺欄位直接判失敗，並可能依設定取消訂單、釋放名額（觸發器會把付款嘗試改回待核對，但訂單取消與名額釋放已發生）。
  - 並行或重複 callback、程序重啟後再次送 Confirm（由 LINE Pay 端拒絕重複請款，但結果會被誤判）。
  - 送出 Confirm 前不檢查訂單已取消；Confirm 進行中逾時會丟失付款結果（顧客已扣款但沒有退款標示）。
  - 一般訂單畫面回到只顯示履約狀態、商品明細 $0、返回網址 `linepay=success` 直接顯示付款成功。
- 回退前建議：暫停快閃 LINE Pay（快閃付款方式管理取消 LINE Pay），保留同一資料庫，不得還原舊資料庫；不得以人工改寫湊成「可回退」狀態。

## 11. 未驗證項目與已知限制

**未驗證**：正式站、真機、正式 LINE Pay 與 LINE Pay Sandbox（呼叫皆 0）。正式唯讀查詢回應若與官方文件不同，付款會停在待核對、不會誤標已付款，但需人工核對。

**已知限制**
1. 升級當下「已授權、尚未 callback」的快閃付款（舊版已建立 LINE Pay 交易）：處理階段不明，C5.4 只做唯讀核對、不送 Confirm；這類授權會逾時而不被請款，顧客看到「付款結果確認中」，需人工聯繫。建議在付款量低的時段部署。
2. 舊版逾時（`expired`）且有交易識別的快閃紀錄，可能曾與進行中的 Confirm 競爭；不自動改狀態，只在後台列為「升級前逾時，未經查詢核對」供逐筆唯讀核對。
3. 快閃付款嘗試表不在 MBV2 搬家備份內（沿用既有設計）：搬家後的快閃訂單只有訂單本身的付款欄位，`payment_display` 依訂單欄位判斷。
4. 快閃沒有「確定未付款」的人工結案流程（與一般訂單 C5.3 相同）：待核對的快閃付款若金流端確實未付款，只能依設定逾時關閉履約（取消、釋放名額），付款嘗試維持待核對。
5. 報表的「熱賣商品營收」仍以既有欄位計算（不在本輪範圍）。
6. `/api/line-orders/status/:no` 遇到歷史同號多筆改回 409（原本任取一筆）；前台輪詢會帶 `ref`，舊快取頁面只會停止更新狀態，不會顯示他人資料。

## 12. 交付

- 套件：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_4_POPUP_PAYMENT_RECOVERY_AND_PAYMENT_UI_FIX_APP_ROOT.zip`（檔案數、項目數與 SHA-256 見交付訊息與專案報告；ZIP 本身的 SHA-256 無法寫在 ZIP 內）。
- 根目錄直接包含 `server.js`、`package.json`；不含資料庫、憑證、權杖、`.env`（只有 `.env.example`）、`node_modules`、`uploads`、瀏覽器產物或測試輸出。
- 逐檔 SHA-256：`02_FILE_MANIFEST.json`（本目錄三個文件本身除外）。
- **相對於 C5.3 的變更**：
  - 產品新增：`utils/paymentDisplay.js`、`utils/popupPaymentRecovery.js`
  - 產品修改：`public/index.html`、`public/js/app.js`、`public/line-order.html`、`public/line-shipping.html`、`routes/line-orders.js`、`routes/line-shipping.js`、`routes/linepay.js`、`routes/orders.js`、`routes/popup-public.js`、`utils/db.js`、`utils/popupOrderLookup.js`、`utils/popupPayment.js`
  - 測試新增：`scripts/smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-4-upgrade-rollback.js`、`scripts/lib/c54-linepay-mock.js`
  - 測試修改：無；刪除：無
