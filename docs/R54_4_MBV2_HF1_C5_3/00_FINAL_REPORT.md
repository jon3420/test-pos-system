# R54.4／MBV2-HF1-C5.3 最終報告：付款待核對防重送、完整回應驗證與重新付款阻擋修正

> 交付套件的 SHA-256 無法寫在 ZIP 內；見交付訊息與專案報告 `claude/R54_4_MBV2_HF1_C5_3_FINAL_REPORT.md`。

## 0. 摘要

- **基準**：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_2_SUBSCRIPTION_PAYMENT_RECOVERY_FIX_APP_ROOT.zip`
  - SHA-256 `d25187b7e70671553e4296af9657051c2b001487233336ae44108a51bb15ce0c`（已重新核對相符）。
  - 961 個檔案、1003 個 ZIP 項目；根目錄有 `server.js`、`package.json`。
  - ZIP 內 manifest 的 958 筆逐檔 SHA-256 全部相符（另 3 筆為 C5.2 報告檔本身）。
- **兩棵樹**：
  - 「未修改 C5.2 基準樹」只加入測試檔：
    - `scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`
    - `scripts/smoke-r54-4-mbv2-hf1-c5-3-upgrade.js`
    - `scripts/lib/c53-linepay-mock.js`
  - 產品程式未修改。
- **本輪範圍**：未部署、未操作正式資料、未開啟通知；未進行正式或 Sandbox 付款。
  - 真實 LINE Messaging API 與 LINE Pay（Request、Confirm、唯讀查詢、退款）呼叫一律 **0 次**。
  - 未知的 LINE Pay 路徑由測試替身立即拋錯並記錄，紀錄為 0 行。
- **結果**：
  - 同一組 25 個案例：未修改 C5.2 為 **7 通過／18 失敗**（原始缺陷直接重現 14、新功能不存在 3、連帶 1；見第 2 節）。
  - C5.3（候選 ZIP 全新解壓）為 **25／25**。
  - F1～F4 都已以正式 routes 重現並修正。重啟情境使用真正的程序終止（SIGKILL）與檔案資料庫。
  - C5.2、C5.1、C5、C4.5 主要驗收、phase3、phase4b 全部通過。主要回歸 14 支、既有 61 支在同一時段與未修改 C5.2 逐支比較，結果完全相同。
  - 真實 LINE／LINE Pay 呼叫 0 次。

---

## 1. 官方文件核對（2026-11-14 讀取）

| 文件 | 本輪採用的內容 |
|---|---|
| [Online API v3／結果代碼](https://developers-pay.line.me/online-api-v3) | 代碼意義，例如：1145 付款處理中、1150 沒有交易紀錄、1152 重複交易、1172 相同 orderId 已有交易、1179 目前無法處理、1198 API 請求重複、1199／9000 內部錯誤、1142 餘額不足、1124 金額資訊錯誤、1180 付款時間已過期。交易識別為 19 位整數，須以 64 位元或字串處理。 |
| [Confirm payment](https://developers-pay.line.me/online-api-v3/confirm-payment) | 回應 `info` 範例只有 `orderId`、`transactionId`、`payInfo[].method／amount`，**不含幣別**。幣別以本機保存的 Request 幣別，加上唯讀查詢的 `currency` 核對。 |
| [Retrieve payment details](https://developers-pay.line.me/online-api-v3/retrieve-payment-details) | `GET /v3/payments?transactionId=&orderId=`。`info[]` 欄位：`transactionId`、`transactionType`（範例：`PAYMENT`、`PARTIAL_REFUND`）、`payInfo`、`currency`、`orderId`、`refundList` 等。只定義 `0000`；相關錯誤 1104／1105／1106／1150／1177／9000。 |
| Check payment request status（`GET /v3/payments/requests/{transactionId}/check`） | 頁面說明是查詢**顧客是否完成 LINE Pay 認證**，未定義回傳代碼，也未說明能否證明付款已完成或終止。總表雖列出 0121（顧客取消或認證逾時）、0122（付款失敗）、0123（付款完成），但未說明是此介面的回傳。**本輪不採用它作為「確定未付款」的依據**（第 6 節）。 |

### 1.1 付款結果判定分類表（C5.3 實作）

| 類別 | 條件 | C5.3 處理 |
|---|---|---|
| **可確認已付款** | ①Confirm `0000`，且 `info.transactionId`＝送出的交易識別（字串比對）、`info.orderId`＝送出的 orderId、`payInfo[].amount` 每筆都是合法數字且合計＝本機付款金額。②唯讀查詢 `0000`，且 `info[]` 中恰有一筆交易識別相同，`orderId` 相同、`transactionType` 恰為字串 `PAYMENT`、`currency`＝保存幣別、`payInfo` 金額合法且合計相符、沒有 `refundList` 內容。 | 完成本機付款（訂單已取消／作廢 → 已付款・待退款） |
| **只能待核對** | 網路錯誤、timeout、回應遺失、無法解析；Confirm `0000` 但缺 `info`、缺 `orderId`、缺 `payInfo`、金額為字串或 null、交易識別不同；1145、1152、1172、1179、1198、1199、9000 與任何未列入下一列的代碼；唯讀查詢回 1150、空清單、查無此交易、多筆、欄位缺少或不符、已退款、查詢失敗。 | `review`（待核對），先做唯讀查詢；查詢無法確認 → 維持待核對、**拒絕重新付款**（409 `PAYMENT_UNDER_REVIEW`），消費者看到「付款結果確認中」 |
| **可確認該交易已終止且未付款** | 只限「可信的第一次 Confirm」，也就是付款嘗試由 C5.3 `/request` 建立，持久化紀錄證明先前從未送出 Confirm，且本次是唯一一次送出。官方回應是明確拒絕代碼：1101、1102、1104、1105、1106、1110、1124、1141、1142、1150、1153、1159、1169、1170、1178、1180、1183、1184、2101、2102。 | `failed`，保存 `failure_basis='first_confirm_declined:<代碼>'`，允許重新付款（新交易）。之後不會再對這筆交易送 Confirm，因此它不會被請款。 |
| | 送出 Confirm 前已知訂單取消、作廢，或金額已變更（從未送出 Confirm） | `aborted_cancelled`／`failed`，保存 `failure_basis` |
| **需要額外唯讀核對才能下結論** | 上述「只能待核對」的全部情況；舊付款 callback（沒有可靠處理階段）；歷史隔離紀錄；可能已送出 Confirm 的付款。 | 只做唯讀查詢，不送 Confirm、不退款 |

> 「這次 API 操作失敗」不等於「這筆付款從未成功」。只有上表第三類有結論，其他情況一律以唯讀核對為準，查不到也不推定未付款。

---

## 2. 重現：同一組案例，先未修改 C5.2，再 C5.3

腳本：`scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`（`C53_ONLY=F1,F2,F3,F4,H,R,FN` 可分組）。

測試層級：

| 標記 | 意義 |
|---|---|
| [API] | 正式 routes＋暫存 SQLite 檔（`node server.js`） |
| [BR] | 真實 Chrome（Playwright） |
| [RS] | 以 SIGKILL 真正終止伺服器程序，再用同一資料庫檔重新啟動（不是模組重載） |
| [FX] | 以 fixture 建立的歷史資料（明確標示） |
| [FN] | 函式層：直接呼叫受測模組，不替換任何函式 |

分類：

| 代號 | 意義 |
|---|---|
| **D** | 原始缺陷直接重現 |
| **N** | 新功能或新介面在基準尚不存在 |
| **P** | 測試前提或測試替身問題 |
| **C** | 連帶失敗 |
| **G** | 付款主流程回歸保護（基準本來就應通過） |

| 案例 | 內容 | 分類 | C5.2 | C5.2 外部 Confirm／重新付款 | C5.3 | C5.3 外部 Confirm／重新付款 |
|---|---|---|---|---|---|---|
| F1-1 | [API] 已送 Confirm、查詢回 1150、再次 callback：維持待核對、外部 Confirm 仍 1 次、confirm_calls 仍 1、重新付款被阻擋 | **D** C5.2 再送 Confirm（共 2 次，confirm_calls=2） | ❌ | 2／阻擋 409 | ✅ | 1／阻擋 409 |
| F1-2 | [API] 已送 Confirm、查詢回 空清單、再次 callback：維持待核對、外部 Confirm 仍 1 次、confirm_calls 仍 1、重新付款被阻擋 | **D** 同上（空清單） | ❌ | 2／阻擋 409 | ✅ | 1／阻擋 409 |
| F1-3 | [API][RS] 同一待核對付款：重複 callback ×3、後台核對 ×2、程序 SIGKILL 重啟後再 callback：外部 Confirm 仍 1 次、維持待核對、重新付款被阻擋 | **D** 重複 callback／核對／SIGKILL 重啟後累計 Confirm 4 次 | ❌ | 4／阻擋 409 | ✅ | 1／阻擋 409 |
| F1-4 | [RS] Confirm 送出後程序被 SIGKILL：重啟後 callback 只做唯讀查詢（回 1150），外部 Confirm 仍 1 次、重新付款被阻擋 | **D** 重啟後 callback 再送 Confirm（共 2 次） | ❌ | 2／阻擋 409 | ✅ | 1／阻擋 409 |
| F1-5 | [API] Confirm 前 durable 保存失敗：當次外部 Confirm 0 次；下一次 callback 正常送出第一次並完成（全程 1 次） | **G** 兩版皆通過（保存失敗時 Confirm 0 次） | ✅ | 1／允許 200 | ✅ | 1／允許 200 |
| F2-1 | [API][FX] 舊付款（沒有可靠處理階段）、金流端已付款、Confirm 會回 1152：不先補送 Confirm，以唯讀查詢確認後完成付款 | **D** C5.2 對舊付款補送 Confirm，得 1152 → failed，重新付款 200 | ❌ | 1／允許 200 | ✅ | 0／阻擋 409 |
| F2-2 | [API][FX] 舊付款查不到（空清單）：不補送 Confirm、持續待核對、不開放重新付款 | **D** C5.2 對舊付款補送 Confirm（本機第一次被當成金流端第一次） | ❌ | 1／阻擋 409 | ✅ | 0／阻擋 409 |
| F2-3 | [API] Confirm 回 1152（重複交易）、金流端已扣款：不判未付款，唯讀查詢完整核對後完成付款（Confirm 1 次） | **D** 1152 → failed（未查詢），重新付款 200 | ❌ | 1／允許 200 | ✅ | 1／阻擋 409 |
| F2-4 | [API] Confirm 回未知代碼（1999）、查無資料：維持待核對、重新付款被阻擋 | **D** 未知代碼 1999 → failed，重新付款 200 | ❌ | 1／允許 200 | ✅ | 1／阻擋 409 |
| F2-5 | [API] 新付款第一次 Confirm 回 1142（官方明確拒絕）：判定未扣款、顧客可重新付款 | **G** 兩版皆通過（明確拒絕可重新付款） | ✅ | 1／允許 200 | ✅ | 1／允許 200 |
| F3a | [API] 唯讀查詢的交易、訂單、金額、幣別都符合，但缺少 transactionType：不標記已付款、維持待核對 | **D** 缺 transactionType 仍標已付款 | ❌ | 1／阻擋 409 | ✅ | 1／阻擋 409 |
| F3a-2 | [API] 查詢 transactionType 空字串／null／PARTIAL_REFUND／數字、多筆無法唯一對應、金額為字串／null、缺 payInfo、金額／幣別／訂單不符、已退款：全部不標記已付款 | **D** transactionType 空字串、null、金額字串仍標已付款（其餘 9 種 C5.2 已擋） | ❌ | each 1／— | ✅ | each 1／— |
| F3b | [API] Confirm 只回 returnCode=0000、沒有 info，且唯讀查詢失敗：不標記已付款、先查詢、維持待核對 | **D** Confirm 只回 0000 → 不查詢直接標已付款 | ❌ | 1／阻擋 409 | ✅ | 1／阻擋 409 |
| F3b-2 | [API] Confirm 只回 0000、唯讀查詢完整相符：先以查詢核對，再完成付款（Confirm 1 次） | **D** 同上（查詢 0 次；結果剛好正確但未經核對） | ❌ | 1／— | ✅ | 1／— |
| F3b-3 | [API] Confirm 0000 但缺 orderId／缺 payInfo／金額為字串／交易識別不同，查詢失敗：不標記已付款、維持待核對 | **D** 缺 orderId／缺 payInfo／金額字串 → 不查詢直接標已付款 | ❌ | each 1／— | ✅ | each 1／— |
| F4-1 | [API] 待核對 31 分鐘＋最近查詢 not_found:1150＋人工備註，呼叫既有 mark-unpaid API：409、維持待核對、重新付款仍被阻擋 | **D** mark-unpaid 回 200 → failed，重新付款 200 | ❌ | 1／允許 200 | ✅ | 1／阻擋 409 |
| F4-2 | [BR] 後台待核對面板：顯示「目前無法確認付款結果，請勿重新付款」，不再提供「標記未付款」按鈕 | **N** 新畫面文字不存在；C5.2 仍顯示「標記未付款」按鈕（另受 F4-1 連帶） | ❌ | —／— | ✅ | —／— |
| H1 | [FX][RS] 歷史紀錄升級：manual_unpaid、1152 判失敗、舊付款 callback 判失敗、未知代碼判失敗、送過 Confirm 的取消中止 → 隔離為待核對並阻擋重新付款；官方明確拒絕、未送出、已付款不變；重複遷移結果相同 | **N** 歷史隔離是新功能；C5.2 不轉換 | ❌ | —／見說明 | ✅ | —／見說明 |
| H2 | [API][FX] 隔離的歷史紀錄以唯讀核對恢復：金流端已付款 → 完成付款；已取消訂單 → 已付款・待退款、維持取消；不送 Confirm | **C** 依賴 H1 的隔離結果 | ❌ | —／— | ✅ | —／— |
| R1 | [API] 完整正常付款：完成付款（Confirm 1 次）、purchase／payment_success 各一次；重複 callback 不增加 | **G**  | ✅ | 1／阻擋 409 | ✅ | 1／阻擋 409 |
| R2 | [API] 金流成功、本機提交失敗：顯示確認中、阻擋重新付款；再次 callback 以唯讀查詢恢復（不再 Confirm） | **G**  | ✅ | 1／阻擋 409 | ✅ | 1／阻擋 409 |
| R3 | [API] 付款中取消：保留取消、已付款者標待退款、不恢復出餐、不記購買 | **G**  | ✅ | 1／— | ✅ | 1／— |
| R4 | [API] 已付款訂單不能再付款；付款前已取消的訂單 callback 不送 Confirm | **G**  | ✅ | —／阻擋 409 | ✅ | —／阻擋 409 |
| FN1 | [FN] 19 位交易識別以字串解析（不經 Number）；只有 never＋requested＋confirm_calls=0 視為從未送出；重複／處理中／內部錯誤代碼不在明確拒絕清單 | **N** C5.3 新函式不存在 | ❌ | —／— | ✅ | —／— |
| Z | 真實 LINE Messaging API 與 LINE Pay 呼叫 0 次；未知 LINE Pay 路徑 0 次；替身核對簽章全部正確 | **G** 兩版皆 0 | ✅ | —／— | ✅ | —／— |
| **合計** | | | **7／25** | | **25／25** | |

註：「重新付款」欄是對同一訂單再次呼叫 `/api/linepay/request` 的 HTTP 狀態。C5.2 在 F2-2、F3a、F3b 等案例回 409，是因為訂單已被（未經完整核對地）標為已付款（ALREADY_PAID），不是待核對阻擋；C5.3 的 409 則是待核對阻擋（PAYMENT_UNDER_REVIEW），已付款者除外。

C5.2 失敗 18 項分類：原始缺陷直接重現 **D 14**、新功能不存在 **N 3**、連帶失敗 **C 1**、測試前提／替身問題 **P 0**（本輪替身與前提問題已在 C5.3 執行前修正：H1 快照誤取重新付款新建的付款嘗試，已改取 fixture 原列並在兩版重跑）。

### 2.1 各層級覆蓋範圍

| 層級 | 案例 | 涵蓋內容 |
|---|---|---|
| 正式 routes [API] | F1-1～F1-5、F2-1～F2-5、F3a、F3a-2、F3b、F3b-2、F3b-3、F4-1、H2、R1～R4 | 實際 `node server.js`，透過 `/api/line-orders`、`/api/linepay/request`、`/api/linepay/confirm`（顧客 callback）、`/api/linepay-admin/reconcile`、`/api/linepay-admin/attempts/:uuid/mark-unpaid` |
| 重啟 [RS] | F1-3、F1-4、H1、U2、U4（升級測試）、回退測試 | 以 SIGKILL 終止伺服器程序（F1-4 是 Confirm 送出、回應未回時終止），用同一資料庫檔重新啟動，不是模組重載 |
| 瀏覽器 [BR] | F4-2 | 真實 Chrome 開啟後台 `index.html`，呼叫正式的 `loadLinePayReview()` 渲染待核對面板 |
| 函式 [FN] | FN1 | 直接呼叫 `safeParseLinePay()`、`confirmNeverSent()`、`DEFINITIVE_DECLINE_CODES`，不替換任何受測函式。`settle()`、`inquire()`、`commitPaid()` 一律經正式 routes 驗證 |
| 歷史資料 [FX] | F2-1、F2-2（刪除付款嘗試列模擬升級前付款）、H1、H2（C5.2 紀錄形態） | 明確標示為 fixture；另以真實升級測試（U1～U4）補足 |
| 真實升級 | `smoke-r54-4-mbv2-hf1-c5-3-upgrade.js` U1～U4 | 由未修改 C5.2 建立並實際使用資料庫檔，再以 C5.3 啟動 |
| 回退 | `smoke-r54-4-mbv2-hf1-c5-3-rollback.js` RB1～RB3、RB-L | C5.3 → 未修改 C5.2 → C5.3，同一資料庫檔 |

外部呼叫：
- LINE Pay 由 `c53-linepay-mock` 有狀態替身攔截，Request、Confirm、唯讀查詢都核對簽章。未知 LINE Pay 路徑立即拋錯並記錄（0 行）。
- LINE Messaging API 由 `c4-line-mock`／`hf1c3-net-mock` 攔截。

---

## 3. F1：結果不明時禁止再次送出 Confirm

**根因（C5.2 `settle()`）**：
- `priorConfirmPossible` 成立時，若唯讀查詢回 `not_found`（1150 或空清單）且 `allowConfirm=true`（顧客 callback），程式會落入「（再）送出 Confirm」的分支。
- 因此「已送過 Confirm、結果不明」的付款，在顧客重新整理返回頁、程序重啟後再 callback 時都會再送 Confirm。
- 實測：F1-1、F1-2 各 2 次；F1-3 重複 callback、核對、重啟後累計 4 次；F1-4 重啟後 2 次。
- 這與 C5.2 報告「只有從未送出過 Confirm 才能送第一次」不符。

**修正**：
1. 新欄位 `confirm_state`：
   - `never`：持久化紀錄證明從未送出 Confirm。
   - `sent`：已保存並可能已送出。
   - `unknown`：沒有可靠處理階段，例如舊付款 callback、歷史匯入、升級前資料、隔離紀錄。
2. 只有同時符合以下條件才會送第一次 Confirm（`confirmNeverSent()`）：`confirm_state='never'`、`status` 為 `requesting`／`requested`、`confirm_calls=0`、顧客 callback。`allowConfirm=true` 不能繞過；不只看 `confirm_calls=0`。
3. **送出前的 durable 保存是條件式更新**：
   - `WHERE confirm_state='never' AND status IN (...) AND confirm_calls=0`，同一交易內把它改為 `sent／confirm_pending`，必須恰好改到 1 列。
   - 保存失敗：狀態維持原樣，本次外部 Confirm 0 次，下一次 callback 可正常送出第一次（F1-5）。
   - 沒改到列：另一處理已取得，或已非「從未送出」，本次只做唯讀核對。
   - 「送出前保存失敗」與「已保存且可能送出」因此分開處理。
4. 其他所有情況只做唯讀核對。查無、空清單、timeout、網路錯誤、解析失敗、欄位不符，都維持待核對。
5. 處理階段以資料庫為準。記憶體鎖只用來合併同一程序內同時的請求，不作為「是否送過」的判斷依據。
6. 資料庫觸發器 `trg_lpa_c53_never_guard`：任何版本（含回退後的舊版）送出 Confirm（`confirm_calls>0`）或改變狀態時，都會自動把 `never` 撤銷為 `unknown`。

---

## 4. F2：舊付款與重複交易回應不能誤判為確定失敗

**根因**：
- `ensureLegacyAttempt()` 建立的舊付款嘗試，與一般付款同樣視為「第一次 Confirm」（本機第一次記錄被等同於金流端第一次）。
- 錯誤碼分類採「不在少數模糊代碼（1172／1198／1199／9000）清單內，就確定失敗」。因此 1152、未知代碼直接判 `failed`，重新付款阻擋解除（F2-1、F2-3、F2-4）。
- 舊付款 callback 也會補送 Confirm（F2-2：C5.2 補送 Confirm 並完成扣款）。

**修正**：
- 舊付款 callback 一律 `confirm_state='unknown'`，只做唯讀核對：
  - 查詢確認完整已付款 → 完成（F2-1，外部 Confirm 0 次）。
  - 查不到 → 持續待核對、阻擋重新付款（F2-2）。
- 改為「明確拒絕清單」（第 1.1 節），只適用於可信的第一次 Confirm。1152 等重複交易、未知代碼 → 唯讀核對；完整核對成功才完成付款（F2-3），否則待核對（F2-4）。
- 正常的明確拒絕仍可重新付款，不被新防護擋住（F2-5：1142 → failed → 重新付款 200）。

---

## 5. F3：付款成功資料完整驗證

**根因**：
- 唯讀查詢只在 `transactionType` 存在時才檢查（缺少、空字串、null 都會通過），金額用 `Number()`（字串 `"100"` 會通過）。
- Confirm `0000` 時，缺少的欄位一律視為「沒有不符」，只有 `{"returnCode":"0000"}` 也直接標成已付款，完全不查詢。

**修正**：
- **F3a（唯讀查詢）**：
  - `transactionType` 必須恰為字串 `PAYMENT`；缺少、空字串、null、其他類型都不通過。
  - 必須恰有一筆交易識別相同（多筆 → 不符）；`orderId`、`currency` 必須為字串且相同。
  - `payInfo` 必須是非空陣列，每筆 `amount` 都是有限、非負的 number（排除字串、null、NaN、缺值），合計以「分」比對。
  - `refundList` 有內容 → 不符；`info` 不是陣列 → 錯誤。
- **F3b（Confirm）**：`0000` 必須同時有 `info.transactionId`、`info.orderId`（字串）、`info.payInfo`（合法金額）且全部相符。缺任何一項 → 唯讀核對；查詢仍不足 → 待核對，不誤報成功或確定失敗。不要求 Confirm 提供官方原本不提供的幣別。
- **交易識別**：回應文字在解析前，先把 `transactionId`／`refundTransactionId`／`originalTransactionId` 的數字轉為字串（`safeParseLinePay`），全程不經 `Number`（FN1 驗證 19 位識別完整保留）。
- 測試替身的成功資料保持完整。缺欄位的情境由替身明確產生（`confirmBody`／`inquiry` 變體），沒有為了通過而刪除驗證。

---

## 6. F4：停用「查不到＋經過時間」即可解除付款阻擋

**根因**：C5.2 `markUnpaid()` 只要「最近一次查詢為 not_found、一小時內、付款嘗試建立超過 30 分鐘」就可改為 `failed`，解除重新付款阻擋（F4-1：API 200 → `failed` → 重新付款 200）。

**修正**：
- `markUnpaid()` 與 `POST /api/linepay-admin/attempts/:uuid/mark-unpaid` 一律回 **409 `TERMINAL_EVIDENCE_REQUIRED`**，訊息為「目前無法確認付款結果，請勿重新付款……」。後端阻擋，舊版前端呼叫既有 API 也一樣（F4-1）。
- 付款狀態維持待核對，重新付款維持阻擋。
- 後台待核對面板移除「標記未付款」按鈕，改為顯示「目前無法確認付款結果，請勿重新付款」，並說明查無交易或等待時間都不代表顧客未付款（F4-2 [BR]）。舊快取頁面若呼叫 `markLinePayUnpaid()`，只會顯示同樣訊息。
- 沒有新增「強制標未付款」或「管理者自行承擔風險」等繞過方式。
- **確定未付款的結案流程**：本輪不保留。目前沒有可證明交易已終止的官方唯讀介面（第 1 節），因此不提供。待核對付款只能：
  - 由唯讀核對確認已付款而完成（訂單已取消 → 已付款・待退款）；
  - 或由店家在 LINE Pay 商家後台處理後，以取消訂單等既有營運方式處理。訂單取消後若之後核對確認已付款，會記為已付款・待退款。

---

## 7. 歷史資料（C5.2 以前寫下的紀錄）

**隔離規則**（遷移與資料庫觸發器使用同一條件，可重複執行）：

| 紀錄形態 | 處理 |
|---|---|
| `failed`＋有交易識別＋沒有 C5.3 判定依據（`failure_basis` 空白），且不符合「可信第一次 Confirm＋明確拒絕代碼」。涵蓋：C5.2 `manual_unpaid`、1152 等重複交易判失敗、未知代碼判失敗、舊付款 callback（`source='legacy_callback'`）判失敗、重送 Confirm 後判失敗。 | → `review`。`review_reason='c53_quarantine:failed:<代碼>'`，`quarantined_from` 保存原狀態，`confirm_state='unknown'`，阻擋重新付款 |
| `aborted_cancelled` 且 `confirm_calls>0`（C5.2 F1 路徑下，先送過 Confirm 才因取消中止） | → `review`（隔離） |
| C5.2 可信的第一次 Confirm 明確拒絕（例如 1142，`confirm_calls=1`，來源為正式付款請求） | 不變（`failed`） |
| Request 階段失敗（沒有交易識別）、`amount_changed`、從未送出的取消中止、已付款 | 不變 |
| 跨店匯入的歷史付款（`origin_store` 有值） | 不變（只當歷史） |

- **觸發器**：
  - `trg_lpa_c53_quarantine_upd`／`trg_lpa_c53_quarantine_ins`：任何版本寫入或插入符合條件的 `failed`／`aborted_cancelled`，立即轉為待核對。回退到 C5.2 期間、搬家匯入也有效（RB2、H1）。
  - 沿用 C5.2 的 `trg_lpa_legacy_writer`。
- **處理階段判定**（`confirm_state` 為 NULL 的既有紀錄）：
  - C5.2 建立（`state_version=2`、來源為正式付款請求）且仍為 `requesting`／`requested`、`confirm_calls=0` → `never`。依據：C5.2 送出 Confirm 前一定先 durable 保存並累加 `confirm_calls`；回退到 C5.1 時另有觸發器把版本改回 0。
  - 其他 → `unknown`。
- **不做的事**：不批量把所有失敗付款改為待核對；不把已付款訂單改回未付款；不刪除任何紀錄。
- **恢復**：隔離紀錄以後台「向 LINE Pay 查詢核對（唯讀）」處理。金流端已付款 → 完成付款，訂單已取消則記為已付款・待退款（H2、U3）。
- **限制（需人工核對）**：
  - C5.1 時代仍為 `requested`、沒有 callback 的付款嘗試，不主動隔離。避免永久阻擋大量已放棄的舊訂單；其 `confirm_state` 為 `unknown`，若之後收到 callback 也只做唯讀核對。
  - 無法判斷金流端結果的歷史紀錄，只能以 LINE Pay 商家後台人工核對。
- **驗證**：fixture（H1，[FX][RS]）與真實升級（U1～U4：由未修改 C5.2 建立並使用資料庫檔，再以 C5.3 啟動）都已驗證，遷移重跑結果不變。

---

## 8. 資料庫、API、畫面變更

**資料庫**（additive、可重複執行；`utils/linePayRecovery.js` `migrate()`，由 `utils/db.js` 啟動時呼叫）：

- `linepay_payment_attempts` 新增欄位：
  - `confirm_state`：never／sent／unknown。
  - `failure_basis`：判定未付款的依據。
  - `quarantined_from`：隔離前狀態。
- 新增觸發器：
  - `trg_lpa_c53_quarantine_upd`、`trg_lpa_c53_quarantine_ins`：歷史與回退期間的隔離。
  - `trg_lpa_c53_never_guard`：撤銷「從未送出」的證明。
- `state_version` 升為 3。啟動紀錄只在有變動時，輸出「已判定 N 筆」與「已隔離 N 筆」。
- 搬家匯入的付款嘗試一律 `confirm_state='unknown'`。

**API**：

- `POST /api/linepay-admin/attempts/:uuid/mark-unpaid`：一律回 **409 `TERMINAL_EVIDENCE_REQUIRED`**（原本在條件成立時回 200 並改為 failed）。
- `GET /api/linepay-admin/review`：每筆多回傳 `confirm_state`、`quarantined_from`、`blocks_repay`。
- 其他 API 路徑與回應格式不變。
- `/api/linepay/confirm` 的導回結果不變（success／pending／fail／error），只是更多情況會落在 pending（付款結果確認中）。

**畫面**：

- 後台訂單頁「LINE Pay 付款待核對」面板：
  - 移除「標記未付款」按鈕；阻擋中的付款顯示「目前無法確認付款結果，請勿重新付款」。
  - 加上說明：查無交易或等待時間都不代表未付款、不能手動標記。
  - 新增隔離、舊付款、Confirm 回應不完整等原因的中文說明。
- `app.js` 版本參數改為 `r54-4-mbv2-hf1-c5-3`。
- 消費者付款結果頁不變，沿用 C5.2 的「付款結果確認中・請勿重複付款」。

**產品程式檔**：`utils/linePayRecovery.js`、`utils/orderIdentity.js`、`utils/migrationV2.js`、`utils/db.js`、`routes/linepay.js`、`public/js/app.js`、`public/index.html`。

---

## 9. 回歸

### 9.1 一致的測試時間

- 所有比較都使用相同條件：測試時鐘預設台北 10:30（`C4_CLOCK_OFFSET_MS` 自動計算），未修改 C5.2 與 C5.3 在同一時段（2026-11-14 20:47～22:35）依序執行。
- 時段相關案例另以 `C4_CLOCK_OFFSET_MS=0` 執行並註明。

### 9.2 主要回歸（14 支，同時段逐支比較）

| 腳本 | 未修改 C5.2 | C5.3 | 備註 |
|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | 41／42 | 41／42 | B1：預設時鐘、執行時已過 11:30 的既有時段問題，兩版相同；以 `C4_CLOCK_OFFSET_MS=0` 執行 C5.3 為 42／42（第 9.4 節） |
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | 42／42 | 42／42 |  |
| `smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | 55／55 | 55／55 |  |
| `smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 | 20／20 |  |
| `smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 | 34／34 |  |
| `smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | 80／80 | 80／80 |  |
| `smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | 40／40 | 40／40 |  |
| `smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 | 94／94 |  |
| `smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | 12／12 | 12／12 |  |
| `smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | 30／30 | 30／30 |  |
| `smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | 32／32 | 32／32 |  |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | 54／54 | 54／54 |  |
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | 328／332 | 328／332 | O1、O6×2、O9：測試以今日 12:00 取餐、執行時已過 12:00 的既有時段問題，兩版相同 |
| `smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 | 93／93 |  |

**結果**：14 支的 exit 代碼與通過／失敗數，兩版完全相同。

### 9.3 既有 61 支回歸（同時段逐支比較）

- C5.3 有 41 支 exit 0；未修改 C5.2 有 41 支（C5.1、C5.2 報告也是 41 支）。
- **逐支比較**：exit 代碼、通過數、失敗數與輸出中的計數，**61／61 支相同**。
- 兩版相同的非 0 腳本：`mbv2-rescue-verify.js`、`run-g1-6-ga4-h1-4-4-view-item-runtime.js`、`run-regression-g1-6-ga4-h1-4-6.js`、`run-regression-g1-6-ga4-h1-4-7.js`、`smoke-cart-delivery-live-refresh.js`、`smoke-h1-4-12-popup-admin-ui-browser.js`、`smoke-hotfix26-b.js`、`smoke-hotfix26-d.js`、`smoke-hotfix26-f2.js`、`smoke-hotfix26-f7.js`、`smoke-hotfix26-f8-b.js`、`smoke-hotfix26-i.js`、`smoke-hotfix27-cd.js`、`smoke-hotfix29-b.js`、`smoke-hotfix29-c.js`、`smoke-hotfix29.js`、`smoke-r48-popup-order-ui-browser.js`、`static-audit-g1-6-ga4-h1-4-6.js`、`static-audit-g1-6-ga4-h1-4-7.js`、`static-audit-r48-popup-order-ui.js`。這些包含：
  - 凍結檔案位元組的靜態稽核；
  - 需要參數或真機的腳本；
  - 以原始碼字串比對的舊稽核；
  - 這些腳本的 wrapper（一支失敗，wrapper 也跟著失敗）。

  都與本輪無關。

### 9.4 全新解壓驗證（候選 ZIP → 新目錄 → `npm ci` → 空資料庫啟動 `/api/health` 200 → 重跑）

| 腳本 | 結果 |
|---|---|
| `smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js（本版付款主驗收）` | 25／25 |
| `smoke-r54-4-mbv2-hf1-c5-3-rollback.js（舊版＝未修改 C5.2）` | 4／4 |
| `smoke-r54-4-mbv2-hf1-c5-3-upgrade.js（C5.2 建立資料庫 → 全新解壓 C5.3）` | 5／5 |
| `smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js（C5.2 主驗收）` | 33／33 |
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js（C5.1 驗收）` | 61／61 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js（C5；`C4_CLOCK_OFFSET_MS=0`）` | 42／42 |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | 111／111 |
| `run-h1-4-10-phase4b-recovery-full-runtime.js` | 168／168 |
| `smoke-r54-4-mbv2-hf1-c5-2-rollback.js（回退到 C5.1）` | 5／5 |
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js（C4.5）` | 42／42 |
| `smoke-r54-4-mbv2-hf1-c4-5-date-consent.js（C4.5）` | 55／55 |
| `smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | 20／20 |
| `smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | 34／34 |
| `smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | 94／94 |
| `smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | 93／93 |
| `smoke-r54-4-mbv2-migration.js` | 121／121 |
| `smoke-h1-4-12-popup-frontend.js` | 293／293 |
| `smoke-h1-4-12-popup-public-checkout.js` | 1447／1447 |

### 9.5 既有測試調整（逐項）

| 腳本／案例 | 原前提 | 調整原因 | 斷言差異 |
|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` R7-B1 | 升級前付款（沒有付款嘗試紀錄）的 callback 由相容路徑補送 Confirm 完成（替身 `allowUnknown`） | F2：舊付款沒有可靠處理階段，C5.3 不補送 Confirm | 前提改為「金流端已在升級前完成付款」（替身狀態），斷言 B 以唯讀查詢恢復為已付款、A 不受影響（原斷言全部保留）。**新增**「外部 Confirm 0 次」。 |
| 同上 R7-B8 | 同上（唯一編號的升級前付款） | 同上 | 同上；保留「已付款＋成功導回」，**新增**「外部 Confirm 0 次」。 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` P1 | 沒有付款嘗試的 callback 先 1150、再以另一交易代碼成功（舊付款路徑會補送 Confirm） | F2：同上；舊付款 callback 不能再用來模擬「確認成功」 | 改走正式 `/api/linepay/request`＋付款嘗試綁定 callback：第一次 Confirm 1150（明確拒絕）→ 重新付款 → 成功 → 重複 callback。斷言（失敗不算成交、成功才成交、purchase 1、歸因 1）**不變**。 |
| `scripts/lib/c5-linepay-mock.js`（C5 測試替身） | Confirm 成功只回 `info.transactionId` | F3b：C5.3 不接受缺 `orderId`／`payInfo` 的 Confirm 為已付款 | 成功回應改為官方結構（`orderId` 取自 Request、`transactionId`、`payInfo` 金額取自 Confirm 請求）；失敗代碼不變。 |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` Part D | 成功與失敗情境都用沒有付款嘗試的 callback；假 Confirm 成功回應只有 `{returnCode:'0000'}` | F2＋F3b：該回應正是 C5.3 修正的「只有 0000 直接標已付款」 | 以受測模組 `createAttempt`＋`attemptRequested`（與 `/request` 內部相同）建立付款嘗試，callback 帶 `attempt`；假成功回應改為官方結構。斷言（amount 來自 DB order.total、payment_success／purchase 各 1、失敗不標已付款、重複 callback 不累加）**全部不變**。 |
| `run-h1-4-10-phase4b-recovery-full-runtime.js` Scenario2 | Recovery 付款請求後，以另一個交易代碼、不帶付款嘗試的 callback 確認；假 Confirm 回應只有 `transactionId` | 同上 | callback 改帶 Recovery 付款請求建立的付款嘗試與交易代碼；假成功回應改為官方結構。斷言（payment job converted、purchase 1、訂單數不變、token invalidated）**不變**。 |

- 沒有放寬任何付款安全斷言：R7-B1、R7-B8 反而新增「Confirm 0 次」。
- 新增的測試檔（只加測試，基準產品程式未修改）：
  - `scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`
  - `scripts/smoke-r54-4-mbv2-hf1-c5-3-rollback.js`
  - `scripts/smoke-r54-4-mbv2-hf1-c5-3-upgrade.js`
  - `scripts/lib/c53-linepay-mock.js`：未知 LINE Pay 路徑立即拋錯；新增回應變體，並保留 C5.2 替身的全部行為。

### 9.6 本輪測試自身的修正

- 本版主驗收 H1 第一次執行時，「重複遷移結果相同」比較的是每張訂單最新的付款嘗試。
- 但 `trusted1142` 的重新付款檢查（預期 200）會另建新的付款嘗試，造成誤判（測試前提問題 P）。
- 已改為比較 fixture 原本那一筆，並在兩版重跑。產品程式未因此修改。

---

## 10. 回退、升級、部署

### 10.1 升級

- 啟動即自動遷移（additive、可重複執行，U4 驗證重啟後不再變動）。
- 啟動紀錄會列出「已判定 N 筆處理階段」與「已隔離 N 筆」。
- 被隔離的付款會出現在後台「LINE Pay 付款待核對」面板。

### 10.2 部署後最短驗收（建議）

1. `GET /api/health` 回 200。啟動紀錄沒有 `linepay_recovery migration` 錯誤；若有隔離筆數，記下來。
2. 後台訂單頁的「LINE Pay 付款待核對」面板可開啟、沒有「標記未付款」按鈕；阻擋中的付款顯示「目前無法確認付款結果，請勿重新付款」。
3. 以已登入的店家身分，對任一待核對付款呼叫 `POST /api/linepay-admin/attempts/<uuid>/mark-unpaid`，應回 409 `TERMINAL_EVIDENCE_REQUIRED`。
4. 若可安排，由店家以小額真實訂單完成一次 LINE Pay 付款（正式環境，由店家自行決定）。確認訂單為已付款、後台沒有新增待核對。本輪未做真實或 Sandbox 付款，這一步是真實金流的第一次驗證。
5. 對被隔離的付款：在後台按「向 LINE Pay 查詢核對（唯讀）」，並對照 LINE Pay 商家後台。已付款者會自動完成，訂單已取消者會記為待退款。

### 10.3 回退條件

- **C5.2 本身仍有本輪修正的付款缺口（F1～F4），「可以啟動」不等於安全回退。** 實測（`smoke-r54-4-mbv2-hf1-c5-3-rollback.js`，4／4）：
  - RB1：C5.2 可讀同一資料庫並啟動，資料完整。
  - **RB-L（限制）**：C5.2 對待核對付款（查詢回 1150）在顧客重新整理返回頁時，**會再次送出 Confirm**（實測外部 Confirm 1→2）。
  - RB2：資料庫觸發器在 C5.2 執行期間仍有效：
    - C5.2 對 1152 判 `failed`、C5.2 人工標記未付款（C5.2 API 回 200）都會立即轉回待核對，重新付款仍被阻擋。
    - 但 C5.2 畫面可能顯示「付款失敗」或「已標記為未付款」，與資料庫狀態不一致。
  - RB3：升級回 C5.3 後，待核對付款不再送 Confirm；回退期間建立的付款可正常完成。
- **回退前**：
  - 待核對付款**不得**以人工標記未付款來湊成「可回退」狀態（C5.3 也已不允許）。
  - 仍有結果不明的付款時，回退會讓這些付款暴露在 C5.2 的再次 Confirm 缺口下。
  - 建議只在無法以其他方式處理的事故才回退，回退期間暫停 LINE Pay 付款（後台關閉 LINE Pay 付款方式）。
- **保留同一個資料庫**，不得還原舊資料庫。
- C5.3 新增的欄位與觸發器，C5.2／C5.1 可忽略（`smoke-r54-4-mbv2-hf1-c5-2-rollback.js` 在 C5.3 樹上驗證回退到 C5.1：通過）。

---

## 11. 未驗證項目與已知限制

**未驗證**：
- 正式站、真機、正式 LINE Pay 與 LINE Pay Sandbox（本輪真實與 Sandbox 呼叫皆 0）。
- 正式 LINE Pay 唯讀查詢回應若與官方文件範例不同（例如欄位名稱、`transactionType` 值），C5.3 會判為「欄位不符」並維持待核對，**不會誤標已付款**。但這會讓正常付款在回應遺失時無法自動恢復，需人工核對。

**已知限制**：
1. **沒有「確定未付款」的結案流程**：
   - 待核對付款若金流端確實未付款，C5.3 無法自動或人工解除重新付款阻擋。
   - 營運上可取消該訂單、請顧客重新下單。若之後核對確認已付款，會記為已付款・待退款。
   - 若之後要支援，需要能證明交易已終止的官方唯讀介面，並以官方回應作為保存的核對證據。
2. **舊付款（升級前已授權、尚未 Confirm）不會被 Confirm**：
   - 升級當下若有顧客已在 LINE Pay 授權、但尚未返回的付款，C5.3 只做唯讀核對。這類授權會逾時而不被請款，顧客看到「付款結果確認中」，需人工聯繫。
   - C5.2 建立且仍為 `requested` 的付款判定為可信未送出，可正常完成（U3 驗證）。受影響的只有 C5.1 以前或沒有付款嘗試紀錄的付款。
   - 建議在 LINE Pay 付款量低的時段部署。
3. **C5.1 時代仍為 `requested`、沒有 callback 的付款嘗試**不主動隔離（避免永久阻擋大量已放棄的舊訂單）；若收到 callback，只做唯讀核對。
4. **快閃（popup）付款**（`routes/popup-public.js` `/popup-payment/linepay-confirm`）是另一條獨立流程，**本輪未修改**。它在網路錯誤或回應不符時直接判失敗，以 `Number()` 比對交易識別。與本輪 F1～F3 屬同類風險，建議另立一輪處理。
5. 回退期間 C5.2 仍會對待核對付款再次送 Confirm（第 10.3 節）。
6. 待核對付款的自動唯讀查詢每筆最多 20 次（沿用 C5.2），超過後需店家在後台手動核對。

---

## 12. 交付

- 套件：`P3CD_DEPLOY_R54_4_MBV2_HF1_C5_3_PAYMENT_VERIFICATION_REPAYMENT_GUARD_FIX_APP_ROOT.zip`。
- 內容：968 個檔案、43 個資料夾項目，共 1011 個 ZIP 項目。
- 根目錄直接包含 `server.js`、`package.json`。
- 不含：資料庫、憑證、權杖、`.env`（只有 `.env.example`）、`node_modules`、`uploads`、瀏覽器產物或測試輸出殘留。
- ZIP 本身的 SHA-256 無法寫在 ZIP 內，見交付訊息與專案報告 `claude/R54_4_MBV2_HF1_C5_3_FINAL_REPORT.md`。
- 最終 ZIP 與通過全新解壓驗證的候選 ZIP 逐檔比對：只有 `docs/R54_4_MBV2_HF1_C5_3/` 三個報告檔不同，產品與測試檔逐檔 SHA-256 相同。

**相對於 C5.2 的變更**（逐檔 SHA-256 見 `02_FILE_MANIFEST.json`）：

- 產品程式修改：`public/index.html`、`public/js/app.js`、`routes/linepay.js`、`utils/db.js`、`utils/linePayRecovery.js`、`utils/migrationV2.js`、`utils/orderIdentity.js`
- 產品程式新增：無
- 測試新增：`scripts/smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-3-rollback.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-3-upgrade.js`、`scripts/lib/c53-linepay-mock.js`
- 測試修改：`scripts/run-h1-4-10-phase3-checkout-submit-payment-runtime.js`、`scripts/run-h1-4-10-phase4b-recovery-full-runtime.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-1-consistency.js`、`scripts/smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`、`scripts/lib/c5-linepay-mock.js`（原因見第 9.5 節）
- 刪除：無

**部署建議**：

- 本版可作為 C5.2 的付款安全修正部署：F1～F4 已以正式 routes、重啟、真實升級驗證；同一時段的回歸與 C5.2 逐支相同。
- 部署前：選在 LINE Pay 付款量低的時段；先備份資料庫檔。
- 部署後：依第 10.2 節最短驗收，並處理被隔離的歷史付款。
- 第一筆真實 LINE Pay 付款的結果需要觀察，因為本輪沒有真實或 Sandbox 付款驗證。若正式唯讀查詢的格式與文件不同，付款會停在待核對、不會誤標已付款，屆時再依實際回應調整。
- 快閃（popup）付款流程有同類風險、本輪未處理，建議下一輪處理。
