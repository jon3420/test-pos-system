# R54.4／MBV2-HF1-C5.2 最終報告：訂閱週期保護、取消與付款競態、付款恢復

- 交付套件：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_2_SUBSCRIPTION_PAYMENT_RECOVERY_FIX_APP_ROOT.zip`（檔案數見第 9 節；ZIP 本身的 SHA-256 無法寫在 ZIP 內，見交付訊息與專案報告 `claude/R54_4_MBV2_HF1_C5_2_FINAL_REPORT.md`）
- 唯一基準：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_1_RESTOCK_CONSISTENCY_ORDER_ID_FIX_APP_ROOT.zip`，SHA-256 `97e50298637422733b92794fcb32b5ba540c8d3ab1184a515afd4baf6ccf8d51`（已重新核對相符），955 檔／996 項。
- 基準樹只加入測試檔（新測試腳本、更新後的 LINE Pay 測試替身），產品程式未修改（已與原 ZIP 逐檔比對）。
- 本輪**未部署**、未操作正式資料、未開啟店家通知開關。真實 LINE Messaging API 與 LINE Pay（Request、Confirm、查詢、退款）呼叫一律 **0 次**，全部在測試程序內攔截。
- 測試層級標示：**[API]** 正式路由＋暫存 SQLite（`node server.js`）；**[BR]** 真實 Chrome（Playwright，LIFF SDK 以測試替身提供）；**[DB]** 直接核對暫存資料庫檔；**[RS]** 以 SIGKILL 真的終止伺服器程序後，用同一資料庫檔重新啟動。以上都**不是**真機、正式金流或正式站驗證。
- 執行時間（台北）：2026-11-14 17:00–18:50（台北；測試時鐘預設 10:30）

---

## 1. 結論

- **A 類**：舊頁面（沒有可驗證的登記週期識別）訂閱一律 `409 REQUEST_CHANGED`，不推定、不自動補入目前週期。新版頁面與 `/subscribe` 改以 `request_uuid` 綁定週期。
- **B 類**：
  - 已取消或作廢的訂單不再送 Confirm。
  - Confirm 期間被取消時，記錄已付款、保留取消、標示待退款；不恢復出餐、不重扣份數、不建立訂單、不發通知。
  - 同時修正 C5.1 以前既有的 **LINE Pay 付款確認時份數重複扣除**。
- **C 類**：
  - 送出 Confirm 前先 durable 保存處理階段，保存失敗不送 Confirm。
  - 結果不明一律待核對，以官方唯讀查詢逐項核對後才標記已付款；恢復流程不送新 Confirm、不退款。
  - 副作用以 outbox 補齊且各只一次；程序被 SIGKILL 後重新啟動仍可找到並恢復。
  - 後台新增待核對與核對功能，消費者看到「付款結果確認中」。
- **驗證**：
  - 同一組 33 個案例：未修改的 C5.1 為 5／33（重現 19 項，另 7 項為功能缺口）；C5.2 全新解壓為 **33／33**。
  - C5.1 一致性驗收、主要回歸、61 支回歸、回退驗證見第 7 節。
  - 真實 LINE、LINE Pay 呼叫 0 次。
- 本輪回歸發現並修正兩個本輪引入的問題（fetch 取得時機、回退後狀態），詳見第 7 節。

---

## 2. 重現與驗收：同一組核心案例，先 C5.1、再 C5.2

腳本：`scripts/smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js`（環境變數 `C52_ONLY=A,B,C,U` 可分組執行）。

分類說明：
- **重現**：C5.1 實際產生錯誤結果（資料被錯誤改寫、錯誤推定、重複扣除等）。
- **C5.1 已正確**：C5.1 在該情境沒有錯誤結果，案例只作為回歸保護。
- **功能缺口**：只因 C5.2 的新介面或新畫面在 C5.1 不存在而失敗（例如後台核對 API 回 404、沒有確認中提示）。依要求**不作為原始問題已重現的證據**，另列。

| 案例 | 層級與內容 | C5.1（未修改） | 分類 | C5.2 |
|---|---|---|---|---|
| A1 | [API] 舊頁面（沒有週期識別）訂閱，資料未變：409 REQUEST_CHANGED，不新增同意、不改登記 | ❌ | **重現**：C5.1 回 200 並新增同意：舊頁面（沒有週期識別）訂閱被接受 | ✅ |
| A2 | [API] 取消後以相同份數、偏好重建：舊頁面不能授權新週期 | ❌ | **重現**：C5.1 回 200：取消後以相同份數、偏好重建，舊頁面仍授權到新週期 | ✅ |
| A3 | [API] 取消後以不同內容重建：舊頁面被拒絕，新週期內容不變 | ✅ | **C5.1 已正確**：C5.1 因內容不一致已回 409 | ✅ |
| A4 | [API] 明確指定舊週期、過期週期、他人週期、他店週期：全部拒絕，不新增同意 | ❌ | **C5.1 已正確**：C5.1 也全部拒絕且未新增同意，只是狀態碼為 400／409／403（C5.2 統一為 409） | ✅ |
| A5 | [API]〔新版〕有效週期訂閱、重送、撤回後重新訂閱：只改同意；份數、偏好、期限、週期不變 | ❌ | **功能缺口**：`/subscribe` 帶 `request_uuid` 是 C5.2 新介面 | ✅ |
| A6 | [BR]〔新版頁面〕訂閱帶週期識別、不帶份數；另一裝置改成 5 份外送後仍維持最新內容 | ❌ | **功能缺口**：C5.1 頁面不送 `request_uuid`；資料本身維持最新內容 | ✅ |
| B1 | [API] 訂單已取消後才收到 callback：不呼叫 Confirm、維持取消、不改付款、不動份數 | ❌ | **重現**：C5.1 仍送 Confirm，付款改為 paid、份數再扣 2 | ✅ |
| B2 | [API] 訂單已作廢後才收到 callback：不呼叫 Confirm、維持作廢 | ❌ | **重現**：C5.1 對已作廢訂單仍送 Confirm 並記為已付款 | ✅ |
| B3 | [API] Confirm 已送出、金流處理前取消：金流已付款 → 記錄已付款、保留取消、標示待退款；不恢復出餐、不重扣份數、不記購買或會員消費 | ❌ | **重現**：C5.1 Confirm 成功後把已取消訂單改回待接單，並記購買事件與會員消費 | ✅ |
| B4 | [API] 金流已扣款、成功回應放行前取消：金流已付款 → 記錄已付款、保留取消、標示待退款；不恢復出餐、不重扣份數、不記購買或會員消費 | ❌ | **重現**：同上（取消發生在扣款後、回應放行前） | ✅ |
| B5 | [API] 已付款取消單重複 callback／重複核對：不再呼叫 Confirm，訂單、份數、事件不變 | ❌ | **重現**：取消已被 B 類問題改回，訂單成為「已付款、待接單」 | ✅ |
| B6 | [API] 可正常履約的訂單付款成功：完成付款流程；份數不再額外扣除；purchase、payment_success、會員消費各一次 | ❌ | **重現**：份數重複扣除：建立時 2、付款確認又 2（2/2 → 2/4） | ✅ |
| B7 | [BR] 消費者畫面：已付款取消單顯示「已取消、店家處理退款」；確認中顯示「請勿重複付款、可稍後查詢」，不顯示成功或失敗 | ❌ | **功能缺口**：C5.1 沒有「確認中」與「已付款取消」畫面，只顯示一般付款失敗 | ✅ |
| C1 | [API] Confirm 前的 durable 保存失敗：當次外部 Confirm 0 次、不推定結果；下一次 callback 正常完成（全程 Confirm 1 次） | ❌ | **重現**：C5.1 保存失敗後下一次 callback 再送 Confirm（共 2 次），並顯示付款失敗 | ✅ |
| C2 | [API] 金流成功、本機 durable 保存失敗：顯示確認中；再次 callback 以唯讀查詢核對後恢復（不再送 Confirm、不標記失敗） | ❌ | **C5.1 已正確（此注入點）**：C5.1 的 durable 寫入順序不同，此注入點未造成錯誤；金流成功、本機失敗的情境由 C3、C4、C8 重現 | ✅ |
| C3 | [API] 金流成功但回應遺失：以唯讀查詢確認已付款後完成本機紀錄（Confirm 只送 1 次） | ❌ | **重現**：回應遺失 → 停在 confirming、顯示錯誤、沒有查詢 | ✅ |
| C4 | [API] 金流成功但回應內容無法解析：以唯讀查詢確認已付款後完成本機紀錄（Confirm 只送 1 次） | ❌ | **重現**：回應無法解析 → 金流已付款卻標為 failed | ✅ |
| C5 | [API] 回應遺失且查詢失敗：保留待核對、顯示確認中、拒絕再次付款；重試 callback 先查詢再完成（不因重複交易代碼判定） | ❌ | **重現**：允許再次付款請求（200），重試 callback 再送 Confirm（共 2 次）仍未付款 | ✅ |
| C6 | [API] 查詢顯示未完成／失敗／timeout／無資料／無法解析／訂單識別、金額、幣別不符／已退款：一律維持待核對、不標記付款或失敗、不允許再次付款 | ❌ | **重現**：9 種查詢情境下都允許再次付款請求（200） | ✅ |
| C6b | [API]〔新介面〕後台核對：唯讀查詢確認已付款者恢復本機紀錄（已退款者仍待人工核對）；不送新的 Confirm | ❌ | **功能缺口**：後台核對 API 在 C5.1 不存在（404） | ✅ |
| C7 | [API] LINE Pay 商家設定已更換：不以新商家查詢或確認舊交易，保留待人工核對 | ❌ | **重現**：商家設定更換後，舊交易被直接標為 failed，未核對；核對 API 404 另列缺口 | ✅ |
| C8 | [RS] Confirm 送出後程序被終止：處理階段已保存在檔案，重新啟動後列入待核對；核對後恢復（Confirm 仍只 1 次） | ❌ | **重現**：重新啟動後 callback 再送 Confirm（共 2 次）並標為失敗；待核對清單 404 另列缺口 | ✅ |
| C9 | [RS] 核心付款已提交、Analytics 寫入失敗後程序被終止：重新啟動自動補齊 purchase、payment_success 各一次；再次 callback／核對不增加 | ❌ | **重現**：Analytics 失敗後沒有待辦，重新啟動也不補 purchase、payment_success | ✅ |
| C10 | [RS] 會員消費補登第一次失敗、重啟後再次失敗：不留下半套（關聯與累計同交易）；故障排除後完成且只累加一次 | ❌ | **重現**：會員消費寫一半：已建立訂單關聯，但累計金額 0 | ✅ |
| C11 | [API] 同時兩個 callback 與後台核對：Confirm 1 次、事件與會員消費各一次 | ✅ | **C5.1 已正確**：並發 callback 時 Confirm 1 次、事件各 1 次 | ✅ |
| C12 | [API] 交易識別與付款嘗試、訂單、店別不符：全部拒絕，不呼叫 Confirm、不改任何訂單 | ✅ | **C5.1 已正確**：交易識別不符全部拒絕 | ✅ |
| C13 | [API] 完成後再次 callback 與核對：庫存／份數、事件、會員消費、轉換數都不增加 | ✅ | **C5.1 已正確**：完成後重複 callback 不增加 | ✅ |
| C14 | [API]〔新介面〕待核對清單與付款網址不含密鑰、JWT 或會員憑證；未登入不能讀取或核對 | ❌ | **功能缺口**：待核對清單、核對 API 在 C5.1 不存在 | ✅ |
| C15 | [API] 所有 Request／Confirm／查詢的簽章經替身核對正確（GET：secret＋path＋query＋nonce） | ❌ | **功能缺口**：C5.1 沒有 GET 唯讀查詢（簽章核對只涵蓋 POST） | ✅ |
| U1 | [DB][API] 升級：C5.1 的 confirming、failed（有交易識別）轉為待核對；金流其實已付款的那筆以查詢核對恢復（不送 Confirm） | ❌ | **重現**：金流其實已付款、C5.1 標為 failed 的那筆，無法恢復 | ✅ |
| U2 | [API] 同店搬移：待核對付款（含完整交易識別）隨訂單匯入、維持待核對；匯入不呼叫 LINE Pay | ❌ | **重現**：C5.1 的搬家匯出不含付款嘗試：待核對付款的交易識別在新主機遺失 | ✅ |
| U3 | [API] 同一資料庫跨店匯入：付款嘗試只當歷史（imported_history），核對不呼叫 LINE Pay、不啟用 | ❌ | **功能缺口**：C5.1 不匯出付款嘗試，無資料可啟用（不構成風險） | ✅ |
| Z | 真實 LINE Messaging API 與 LINE Pay（Request／Confirm／查詢／退款）呼叫 0 次 | ✅ | **—**：兩版都是 0 | ✅ |
| **合計** | | **5 通過／28 失敗** | | **33 通過／0 失敗** |

C5.1 的 28 項失敗中：**重現 19 項**、**功能缺口 7 項**（只因新介面或新畫面不存在，不作為問題已重現的證據）、其他 2 項。C5.1 執行時記錄到的 404 新介面：`POST /api/linepay-admin/reconcile`。

---

## 3. A 類：舊訂閱請求不得授權新的登記週期

**根因**：C5.1 的「訂閱通知」沿用 `register` 端點並帶 `consent_action='subscribe'`，後端以「同商品、同會員、目前有效登記」找登記列，沒有核對送出頁面所看到的是哪一個登記週期。顧客在另一裝置取消後重建（即使份數、偏好完全相同），舊頁面送出的訂閱仍會授權到新週期（A1、A2 重現）。

**修正**：
- `/api/product-demand/subscribe` 只接受明確的登記週期識別：`request_uuid`（優先）或 `request_id`；兩者同時提供時必須指向同一列。
- 在 durable 交易內，以「識別＋店別＋商品＋會員」查詢，且該列必須為 `active`、未過期，才只對該週期新增同意紀錄；不改份數、偏好、期限、週期。
- 缺少識別：
  - 舊頁面（`register`＋`consent_action='subscribe'`）→ 一律 `409 REQUEST_CHANGED`，不寫入。
  - 新端點缺少識別 → `400 INVALID_REQUEST`。
- **不**以商品、份數、取餐偏好推定同一週期；後端**不**自動補入「目前有效週期」。
- 前端（`line-order.html`）訂閱時送出畫面上那一筆登記的 `request_uuid`（A6 [BR] 確認），不送份數。

---

## 4. B 類：付款 callback 不得改回已取消／作廢的訂單

**根因**：
1. C5.1 的 `/api/linepay/confirm` 只依付款嘗試的識別與金額決定是否送 Confirm，沒有在送出前重新讀取訂單狀態；Confirm 成功後直接把訂單改回 `pending`（待接單）、`payment_status='paid'`，覆寫了取消或作廢（B1～B4 重現）。
2. **份數重複扣除（C5.1 以前既有，自 R44.2 起）**：LINE 訂單在建立時已依 `line_counter_allocation_snapshot` 扣 `line_quota_sold`／`line_preorder_sold`，LINE Pay Confirm 成功後又再扣一次（B6 重現：`2/2 → 2/4`）。取消時只依快照還原一次，因此每筆 LINE Pay 訂單會多占一份。C5.2 移除付款確認時的扣除；份數只在建立時扣、取消時依快照還原。

**修正**：
- Confirm 前在同一流程內重新讀取訂單：已取消或已作廢 → 不呼叫 Confirm（付款嘗試記為 `aborted_cancelled`），返回頁顯示「此訂單已取消，本次付款未完成扣款」。
- 金流已付款後，以 durable 交易重新讀取訂單：
  - 可履約 → 已付款並建立副作用待辦。
  - 已取消或作廢 → 記錄 `payment_status='paid'`、`refund_status='pending_refund'`，保留取消或作廢；不恢復出餐、不扣份數、不建立新訂單、不發通知、不記購買或會員消費；返回頁顯示「此訂單已取消，款項已收到，店家將處理退款」。
- 本輪**不**新增自動退款 API 呼叫。

**付款結果 × 訂單狀態**：

| 付款結果（金流端） | 訂單仍可履約 | 訂單已取消 | 訂單已作廢 |
|---|---|---|---|
| Confirm 前已知取消／作廢 | — | 不送 Confirm；付款嘗試 `aborted_cancelled`；訂單不變 | 同左 |
| 已付款（Confirm 成功或查詢核對成功） | `payment_status=paid`、訂單 `pending`（照既有流程）；付款嘗試 `paid`；副作用 outbox：purchase、payment_success、會員消費 | `payment_status=paid`、`refund_status=pending_refund`；維持 `cancelled`；付款嘗試 `paid_cancelled`；副作用全部略過 | 同左，維持 `void` |
| 同一訂單已由另一筆交易付款 | 付款嘗試 `paid_duplicate`；訂單不變；列入待核對（人工退款判斷） | 同左 | 同左 |
| 金額已變更 | 不送 Confirm；`failed`（amount_changed） | 不送 Confirm | 不送 Confirm |
| 明確失敗（首次 Confirm、非模糊代碼） | `failed`；訂單維持未付款，可重新付款 | 訂單不變 | 訂單不變 |
| 結果不明（timeout、回應遺失、無法解析、本機保存失敗、1172／1198／1199／9000、查詢失敗或不符） | `review`（待核對）；訂單維持未付款；**拒絕再次付款請求**（409 PAYMENT_UNDER_REVIEW）；消費者看到「付款結果確認中」 | `review`；核對確認已付款時依上一列「已付款 × 已取消」處理 | 同左 |

---

## 5. C 類：金流成功、本機失敗的可恢復處理

**根因**：
- C5.1 的處理階段只保存在記憶體（`_confirmInflight`）；送出 Confirm 前沒有可存活的紀錄。
- 網路錯誤、回應遺失、無法解析或本機保存失敗時，會直接標為失敗或留在 `confirming`。
- 沒有唯讀查詢。下一次 callback 會再送一次 Confirm，若金流回 1172（同一 orderId 已存在）就被當成失敗。
- 已付款的訂單可能被顯示為失敗並允許再次付款（C1、C3～C6、C8 重現）。
- 副作用沒有待辦紀錄，中斷後不會補（C9）；會員消費工具吞錯，關聯與累計可能只寫一半（C10）。

**修正**：
1. **處理階段持久化**：送出 Confirm 前，以 durable 交易把付款嘗試記為 `confirm_pending` 並寫入資料庫檔。保存失敗則**不呼叫**外部 Confirm（C1：Confirm 0 次），返回頁顯示確認中。等待外部 API 期間不持有 SQLite 寫入交易。
2. **不推定**：timeout、回應遺失、無法解析、本機提交失敗、重複交易代碼（1172／1198）、內部錯誤（1199／9000）都不推定成功或失敗，一律轉入唯讀查詢；查詢無法確定 → `review`。
3. **唯讀核對**：使用官方 Retrieve payment details `GET /v3/payments?transactionId=&orderId=`。簽章為 `Base64(HMAC-SHA256(secret, secret + path + queryString + nonce))`，測試替身會逐一驗證簽章（C15）。只有以下**全部**符合才視為已付款：
   - `returnCode='0000'`（**單看 0000 不足**）；
   - `info[]` 中恰有一筆交易識別完全相同。19 位數交易識別從原始回應文字擷取，不經 JSON Number，避免精度遺失；
   - `orderId` 與送出時相同（升級前的付款用保存的 `query_order_id`）；
   - `transactionType='PAYMENT'`；
   - 幣別相同；
   - `payInfo[].amount` 合計等於付款金額；
   - 沒有 `refundList`（已退款 → 待人工核對）。

   以下情況一律維持 `review`，且不會只因「查不到」就允許再次付款（C6）：查無資料（1150 或空清單）、查詢失敗、timeout、無法解析、識別、金額或幣別不符。
4. **商家設定更換**：付款嘗試保存送出時的 `merchant_ref`（channel id）；目前設定不同時，不以新商家查詢或確認舊交易，轉 `review`（`merchant_changed`，C7）。
5. **恢復流程不送新的 Confirm、不退款**：
   - 後台核對、啟動補齊、重複 callback 只做唯讀查詢與本機補登。
   - 唯一可能送 Confirm 的是「從未送出過 Confirm」的付款嘗試，且查詢結果為查無交易時，由 callback 送第一次。
6. **副作用 outbox**：付款提交與 `payment_side_effects` 待辦（`purchase`、`payment_success`、`member_purchase`）在同一 durable 交易內寫入。
   - 每項完成後核對實際保存結果（事件列確實存在；會員消費的關聯、累計、紀錄在同一 durable 交易內寫入），才標記完成。
   - 不因 `payment_status='paid'` 就略過未完成的待辦。
   - 程序重新啟動後 3 秒，以及之後每 5 分鐘，自動補齊本機待辦（不呼叫外部 API）。
7. **防重入**：記憶體鎖只用於同一程序內合併，可存活的狀態以資料庫為準（`confirm_pending`、`review`、`paid`）。並發 callback 與後台核對只會有一次 Confirm、一次副作用（C11）。
8. **消費者畫面**：`linepay=pending` 顯示「⏳ 付款結果確認中…請勿重複付款」，不清空購物車、不記 Purchase、不顯示成功或失敗（B7 [BR]）。
9. **後台**：
   - 新增訂單頁待核對面板 `#lpReviewPanel`，以中文顯示原因。
   - API：`GET /api/linepay-admin/review`、`POST /api/linepay-admin/reconcile`、`POST /api/linepay-admin/attempts/:uuid/mark-unpaid`。
   - 權限沿用既有付款權限（店家 JWT＋`payment_api` 功能）。
   - 頻率限制：整店核對 20 秒一次、單筆 10 秒一次、同時只允許一個，自動查詢每筆最多 20 次。
   - 「標記未付款」只在最近一小時內查詢結果為查無交易、且付款嘗試超過 30 分鐘時允許。
   - 清單與網址不含密鑰、JWT 或會員憑證（C14）。

---

## 6. 升級、搬家、回退

- **升級（additive、可重複）**：
  - `linepay_payment_attempts` 新增欄位；新增 `payment_side_effects` 表。
  - C5.1 留下的付款嘗試不憑名稱推定未付款：
    - `confirmed` → `paid`；`confirmed_duplicate` → `paid_duplicate`；
    - `confirming` → `review`（`upgrade_confirming_unknown`）；
    - 有交易識別的 `failed` → `review`（`upgrade_failed_unverified`）。
  - 金流其實已付款的那筆，以查詢核對恢復，不送 Confirm（U1）。
- **同店搬移**：付款嘗試與副作用待辦隨訂單匯出、匯入（append-only），待核對維持待核對（保留完整交易識別）；匯入不呼叫 LINE Pay（U2）。
- **跨店匯入**：付款嘗試只當歷史（`imported_history`），不會被 callback 或核對啟用；副作用待辦不匯入（U3）。
- **回退到 C5.1（有條件）**：
  1. **回退前**：
     - 在後台「LINE Pay 待核對」面板執行核對，直到待核對（`confirm_pending`、`review`）為 0，且付款副作用待辦為 0。
     - 待退款（`pending_refund`）與重複付款（`paid_duplicate`）屬於人工事項，C5.1 也能讀取，不阻擋回退。
     - 確認方式：`GET /api/linepay-admin/review` 的 `attempts` 沒有 `confirm_pending`／`review`，且 `side_effects_pending` 為空（RB1）。
  2. **保留同一個資料庫**，換回 C5.1 程式（不得還原舊資料庫）。C5.1 可啟動、讀取既有訂單、建立新訂單；已付款或已付款取消的訂單重複 callback 不再送 Confirm，取消不會被改回（RB2）。
  3. **限制（實測記錄 RB-L）**：若仍留有待核對付款，C5.1 不認得 `review`。顧客重新整理返回頁時，C5.1 會再送一次 Confirm（實測 Confirm 次數 [1, 2]，返回頁顯示付款失敗，付款嘗試被標為 `failed`，訂單付款狀態 `pending`）。C5.1 也不會補齊副作用待辦。因此回退前必須先清空。
  4. **再次升級到 C5.2**：
     - 遷移可重複執行。
     - 回退期間被 C5.1 改寫的付款嘗試，由觸發器標回升級前格式，轉為待核對，再以查詢核對恢復。購買事件只一次（RB3）。
  5. 回退驗證：`scripts/smoke-r54-4-mbv2-hf1-c5-2-rollback.js`（`C52_OLD_ROOT` 指向 C5.1 全新解壓樹），結果 **5／5**。

---

## 7. 回歸

### 7.1 重現／驗收主腳本

- `smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js`：
  - 未修改的 C5.1：**5 通過／28 失敗**。
  - C5.2（候選 ZIP 全新解壓）：**33 通過／0 失敗**。
- 真實 LINE Messaging API 與 LINE Pay 呼叫：0 次（兩版 Z 案例）。

### 7.2 C5.1 一致性驗收（保留 C5.1 全部修正）

- `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` 在 C5.2：**61／61**（全新解壓）。
- 含 R7-B1、R7-B3、R1-6 的必要調整，見下方「測試調整」。

### 7.3 主要回歸（C5.2 工作樹）

| 腳本 | C5.2 | 備註 |
|---|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | 40／42 | 第一次 40／42：P1（測試調整，見下表）＋B1（預設時鐘 11:30 後的既有時段問題，未修改的 C5.1 同時段同樣 41／42）。調整後以 `C4_CLOCK_OFFSET_MS=0` 執行：**42／42** |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | 42／42 | 含 C5.1 的 L3-4 調整（真實 reload；再次點擊仍產生新的開啟紀錄） |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | 30／31 | 第一次 S5-2 例外中止（舊頁面訂閱改為 409，見測試調整）。調整後 **55／55**（原 54 項＋新增 S5-2a） |
| `scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | 80／80 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | 40／40 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | 12／12 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | 30／30 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | 32／32 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | 54／54 |  |
| `scripts/smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | 328／332 | O1、O6×2、O9：測試以今日 12:00 取餐，執行時已過 12:00（既有）；未修改的 C5.1 於 18:09 重跑同樣 328／332 |
| `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 |  |

### 7.4 61 支既有回歸（與 C5.1 報告逐支比較）

- C5.2：**41 支 exit 0**（C5.1 報告為 41 支）。
- 第一次執行時 phase3 付款、phase4b Recovery 全量失敗，原因是 fetch 取得時機的缺陷（見「回歸中發現並修正的缺陷」）。修正後重跑：phase3 **111／111**、phase4b **168／168**，與 C5.1 相同，並於全新解壓再次驗證。
- 其餘腳本的 exit 結果與通過數和 C5.1 報告逐支相同（61/61 支 exit 結果一致）。
- `static-audit-r48-popup-order-ui`、`smoke-hotfix27-cd`、`mbv2-rescue-verify`（需要參數）等既有非 0 與 C5.1 報告相同。

### 7.5 全新解壓驗證（候選 ZIP → 新目錄 → `npm ci` → 空資料庫啟動 `/api/health` 200 → 重跑）

| 腳本 | 結果 |
|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js` | 33／33 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | 61／61 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | 42／42 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | 55／55 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |
| `scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | 12／12 |
| `scripts/smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 |
| `scripts/smoke-r54-4-mbv2-migration.js` | 121／121 |
| `scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111／111 |
| `scripts/run-h1-4-10-phase4b-recovery-full-runtime.js` | 168／168 |
| `scripts/smoke-h1-4-12-popup-frontend.js` | 293／293 |
| `scripts/smoke-h1-4-12-popup-public-checkout.js` | 1447／1447 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（`C4_CLOCK_OFFSET_MS=0`） | 42／42 |
| `scripts/smoke-r54-4-mbv2-hf1-c5-2-rollback.js`（舊版＝C5.1 基準樹） | 5／5 |

### 7.6 失敗分類

- **既有、與時段有關**（同時段對未修改的 C5.1 重跑，結果相同）：
  - C5 成效 B1（預設時鐘、11:30 後）；
  - C3 O1／O6／O9（12:00 後）；
  - C4.5 日期 D1-3（`C4_CLOCK_OFFSET_MS=0` 時）。本輪以預設時鐘執行，未出現。
- **本輪造成、已修正**：fetch 取得時機（phase3、phase4b）、回退後的舊版狀態（RB3）。
- **測試調整**：見下表，每項都對應本輪的行為修正。

### 測試調整（必要、已逐項說明）

| 腳本 | 案例 | 調整 | 原因 |
|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | R7-B1 | 斷言由「付款後份數改變」改為「付款後份數不變」 | 舊斷言把付款時的第二次扣除當成正確行為；C5.2 修正這個重複扣除（第 4 節）。 |
| 同上 | R7-B3 | 付款嘗試狀態接受 `confirmed` 或 `paid` | C5.2 狀態名稱改為 `paid`（升級時自動對應）。 |
| `smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | S5-2、S6-1 | 明確訂閱改走 `/subscribe` 並帶目前登記的 `request_uuid`；新增 S5-2a，斷言舊頁面寫法得到 409 且不授權 | A 類要求：沒有登記週期識別的舊請求一律 409。 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | P1 | 「確認失敗後成功」改為：第一筆交易確認失敗（1150），重新付款用新的交易代碼成功 | 確認失敗是該筆 LINE Pay 交易的確定結果，同一交易不會再確認成功。舊寫法只在無狀態替身下成立；C5.2 不對已確定失敗的交易再送 Confirm。 |
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | R1-6 | 舊版前端「表單與伺服器一致」也改為斷言 409；授權改走 `/subscribe` 帶 `request_uuid` | A 類明文要求：「一致即授權」不再列為可接受的舊版限制。 |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 靜態檢查 | 「`payment_success` 只在 `routes/linepay.js` 寫入一處」改為「LINE Pay 付款流程（路由＋`utils/linePayRecovery.js`）合計只有一處寫入」 | C5.2 把寫入移到付款副作用 outbox，才能在中斷後補齊且只寫一次；`/request` 不寫入的靜態檢查不變。 |
| `scripts/lib/c5-linepay-mock.js`（測試替身） | — | Confirm 回應不再帶固定的假 `orderId:'x'` | C5.2 會核對 Confirm 回應中的 orderId，不符就改用唯讀查詢。舊替身回 `'x'` 會被正確地判為不符。 |
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | L3-4 | 沿用 C5.1 的真實 `reload()` 調整；再次點擊仍產生新的開啟紀錄（未變更） | — |
| `scripts/lib/c51-linepay-mock.js`（測試替身） | — | 新增 GET 查詢、簽章驗證、回應遺失、無法解析、卡住、延遲、查詢變體等控制 | 故障注入只放在測試邊界；正式程式沒有任何繞過驗證或假成功開關。 |

---

### 回歸中發現並修正的缺陷

- **LINE Pay 呼叫的 fetch 取得時機**：
  - `utils/linePayRecovery.js` 最初在模組載入時就固定 `node-fetch`。這個模組在 `utils/db.js` 啟動遷移時就會被載入，早於 `routes/linepay.js`。
  - 因此，在路由載入前才以 `require.cache` 注入假 `node-fetch` 的既有測試（phase3 付款、phase4b Recovery 全量），其替身被繞過。
  - 第一次 61 支回歸時，這兩支各有付款案例失敗（phase3 失敗 4 項，phase4b 165／168）。
  - 當次的對外請求被工作環境的網路允許清單擋下，沒有回應，沒有到達 LINE Pay。
  - 修正：改為呼叫當下才取得 `node-fetch`，與 C5.1 的 `routes/linepay.js`、`linePayService` 相同。
  - 修正後 phase3 111／111、phase4b 168／168，全新解壓後再次驗證。
- **回退期間被舊版改寫的付款嘗試**：
  - 回退測試發現，回退到 C5.1 時若有未清空的待核對付款，C5.1 會再送一次 Confirm，得到 1172 並標為 `failed`。
  - 再升級回 C5.2 時，這筆已經是新格式，不會被重新判定，會一直停在失敗。
  - 修正：遷移時在資料庫建立觸發器 `trg_lpa_legacy_writer`。任何版本把付款嘗試寫成 `confirming`、`confirmed` 或 `confirmed_duplicate`（C5.2 從不寫這些狀態）時，就標回升級前格式。再次升級時依升級規則轉為待核對，再以查詢核對恢復（RB3）。

---

## 8. 未驗證與限制

- 未在正式站、真機、正式 LINE Pay（含 sandbox）上執行。LINE Pay 查詢回應格式依官方文件實作，並以測試替身驗證；正式回應若有差異，結果會落在 `review`，不會被誤判為已付款。
- 不會自動退款。`pending_refund` 與 `paid_duplicate` 需店家人工處理。
- 回退到 C5.1 前必須先清空待核對與副作用待辦（第 6 節）。
- 既有、與執行時段有關的測試失敗見第 7 節，未修改的基準在同時段結果相同。

---

## 9. 交付

- 套件：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_2_SUBSCRIPTION_PAYMENT_RECOVERY_FIX_APP_ROOT.zip`。
- 內容：961 個檔案、42 個資料夾項目，共 1003 項。
- 根目錄直接包含 `server.js`、`package.json`。
- 不含：資料庫、憑證、權杖、`.env`（只有 `.env.example`）、`node_modules`、`uploads`、實際顧客資料、測試產物（截圖、暫存資料庫）。

**相對於 C5.1 的變更**（逐檔 SHA-256 見 `02_FILE_MANIFEST.json`）：

- 產品程式新增：`utils/linePayRecovery.js`
- 產品程式修改：`server.js`、`public/index.html`、`public/line-order.html`、`public/line-shipping.html`、`public/js/app.js`、`routes/line-orders.js`、`routes/linepay.js`、`routes/product-demand.js`、`utils/db.js`、`utils/linePayService.js`、`utils/migrationV2.js`、`utils/orderIdentity.js`、`utils/productDemand.js`
- 測試新增：`scripts/smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-2-rollback.js`
- 測試修改：`scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js`、`scripts/smoke-r54-4-mbv2-hf1-c4-5-date-consent.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`、`scripts/lib/c5-linepay-mock.js`、`scripts/lib/c51-linepay-mock.js`（調整原因見第 7 節）
- 刪除：無

**部署注意**（本輪未部署）：
- 啟動時自動執行 additive 遷移：新增欄位、`payment_side_effects` 表、回退保護觸發器。
- 啟動 3 秒後及每 5 分鐘只補齊本機副作用待辦，不呼叫外部 API。
- LINE Pay 唯讀查詢只在 callback 或店家在後台按「核對」時發生。
- 部署後，店家可在訂單頁的「LINE Pay 待核對」面板查看；權限沿用付款設定權限（`payment_api`）。
