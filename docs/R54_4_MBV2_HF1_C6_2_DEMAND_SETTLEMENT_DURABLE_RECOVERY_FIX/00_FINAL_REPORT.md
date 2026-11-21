# R54.4／MBV2-HF1-C6.2 補修：登記份數持久化補齊與作廢回復 — 最終報告

> 本輪只修正三個已重現的缺口（A 綁定失敗無法補齊、B 定期補齊沒有公平性、C 作廢原履約狀態在中斷後遺失）。
> 未進行 C6.3 合併通知，未部署，未操作正式資料，未開啟正式自動通知。
> 真實 LINE、LINE Pay 與 Sandbox 呼叫皆為 0。

## 1. 基準與交付

| 項目 | 內容 |
|---|---|
| 基準 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_2_DEMAND_CART_ORDER_SETTLEMENT_APP_ROOT.zip`，SHA-256 `24f7ff067f6d7541b38abf8cfa9ebf1602ff30b08220fa07a884f584afb6605a`（與收到的雜湊相符） |
| 交付 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_DURABLE_RECOVERY_FIX_APP_ROOT.zip`（ZIP 雜湊見交付訊息與套件外報告文末） |
| 套件內文件 | `docs/R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_DURABLE_RECOVERY_FIX/`：`00_FINAL_REPORT.md`（本文件）、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json`、`03_OPS_ROLLBACK_GUIDE.md` |
| 未修改 | Android POS、License API、Android License Sync、Android Feature Gate、Zeabur 部署架構、`.env.example`、付款判定（LINE Pay 確認、付款守門、恢復外送、時間判斷） |

## 2. 未修改 C6.2 的重現結果（新驗收腳本先在基準執行）

腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js`。

| 版本 | 結果 |
|---|---|
| 未修改 C6.2 | **7 通過、15 失敗** |
| 補修版工作樹 | 22 通過、0 失敗 |
| 全新解壓候選版 | 22 通過、0 失敗 |

基準的 15 項失敗全部是業務斷言失敗，沒有任何一項是腳本錯誤或環境問題。

| 編號 | 層級 | 未修改 C6.2 的實際結果 | 補修版 |
|---|---|---|---|
| A2 | API＋DB | 故障解除後沒有任何關聯，已完成 0（無可補齊依據） | 背景補齊 → 已完成 3／5 |
| A3 | 正常重啟 | 已完成 0 | 只扣一次；送單與購買事件不增加（2 → 2） |
| A4 | 正常重啟 | 重啟後仍無關聯 | 啟動補齊 → 4／4、已完成 |
| A5 | API＋DB | 多商品訂單兩個商品都沒有關聯 | 成功的商品立即扣減，失敗的商品故障解除後補齊（803:2、804:3） |
| A6 | API＋DB | 無關聯 | 只綁定原週期（已取消 → 套用 0、`cycle_closed:cancelled`），新週期 0、不復活 |
| A7 | DB 夾具＋API | 無關聯 | 原週期已過期 → 套用 0；新週期不受影響 |
| A8 | API＋重啟 | 付款成功但已完成 0 | 補齊後扣減一次；Confirm 1→1、購買事件 1→1（不重送） |
| A9 | 真實 SIGKILL | 訂單已保存、已完成 0、無關聯 | 同一資料庫重啟後 3／5；再次重啟不變 |
| A10 | API＋DB | HTTP 200，訂單 16→17、預購 3→5、事件 7→8（沒有證據也成立） | HTTP 500，訂單、預購、事件全部不變（整筆回滾） |
| C1 | 真實 SIGKILL | 待核對，仍 3 | 依交易中保存的原狀態（未履約）回復 3 → 0；再次重啟不變 |
| C2-2 | DB | 原因 `void_prior_state_unknown` | 原因 `void_after_completed`（來自交易中保存的原履約狀態） |
| C3 | DB 夾具＋真實 SIGKILL | 待核對，仍 2 | `status='completed'`、`order_status='accepted'` → 以 `order_status` 判斷未履約 → 回復 2 → 0 |
| B1 | DB 夾具＋重啟 | 第 201 筆逾期訂單 12 輪都沒有解除 | 第 3 輪解除 |
| B2 | DB 夾具＋重啟 | 兩店後段逾期訂單全都沒有解除 | store_001 第 451 筆於第 6 輪、store_002 第 301、302 筆於第 5 輪解除 |
| B3 | DB 夾具＋真實 SIGKILL | 第 402 筆排在前 200 筆之後，12 輪都沒有處理到。另外，第 2 輪的 SIGKILL 停點沒有觸發（以逾時結束）：測試替身透過匯出函式掛勾，而基準的補齊直接呼叫內部的 `syncOrder` | 第 2 輪處理 50 筆後 SIGKILL，重啟後從保存的游標繼續；故障筆在故障解除後第 11 輪完成 |

在基準也通過的 7 項（保留既有行為）：
- A1：雙重失敗時沒有半套扣減。
- C2：已履約訂單作廢 → 待核對、不回復。
- C4：取消後再作廢、重複作廢 → 只回復一次。
- C5：沒有證據的歷史作廢 → 待核對。
- B4：待核對付款的 748 筆訂購中全部保留。
- Z1：沒有建立任何通知批次。
- Z2：真實 LINE 0。

### 測試層級標示

| 標示 | 意義 |
|---|---|
| `[API]` | 正式 HTTP 路由 |
| `[DB]` | 直接讀資料庫檔核對 |
| `[FX-DB]` | 以資料庫夾具建立歷史或大量狀態 |
| `[RS]` | 正常停機與重啟 |
| `[KILL]` | 真實 `SIGKILL`（`process.kill(pid,'SIGKILL')`，在測試替身指定的停點） |
| `[BR]` | 真實瀏覽器（本輪新增測試無；瀏覽器回歸見第 9 節） |
| 函式層級 | 本輪沒有僅在函式層級完成的驗收項目 |

故障注入只使用測試 preload `scripts/lib/c62r-fault.js`，由環境變數 `C62R_CTRL` 指定的檔案控制。正式程式碼沒有新增任何可觸發故障、中斷或改寫狀態的端點或旗標。

## 3. 根本原因

| 缺口 | 根本原因 |
|---|---|
| A | C6.2 在訂單交易內綁定，失敗後交易外再補綁一次；兩次都失敗時，沒有在任何地方保存「這筆訂單應綁到哪個登記週期、幾份」。日後的補齊只能依「目前有效的登記」判斷，C6.2 為了避免錯綁而選擇不補，因此永遠補不回來。 |
| B | 定期補齊對每一類工作都用 `ORDER BY id LIMIT 200`，沒有游標。前 200 筆如果長期維持原狀（例如待核對付款），第 201 筆之後永遠排不到；多店時，id 較小的店會長期佔滿名額。 |
| C | 作廢前的履約狀態（`order_status`）只在交易後的同步呼叫中以記憶體變數傳入。程序在作廢交易提交後、同步前被終止，這個資訊就遺失了，重啟後只能一律待核對。另外，C6.2 用來判斷的是交易前讀取的資料，不是交易內重新讀取的值。 |

## 4. 修改檔案與交易邊界

### 4.1 產品檔（5 支修改，0 支新增）

| 檔案 | 修改 |
|---|---|
| `utils/demandSettlement.js` | 新增待辦與游標資料表的建立；綁定改為「交易內保存待辦 → 依待辦綁定」；新增作廢待辦；同步改用作廢待辦判斷作廢前狀態；定期補齊改為依店別游標公平輪替 |
| `routes/orders.js` | 兩個作廢交易的第一個語句保存作廢待辦（交易內重新讀取狀態）；交易後的同步不再傳入記憶體中的狀態 |
| `routes/product-demand.js` | 後台「登記 → 訂單」明細加入此週期的綁定待辦（狀態、嘗試次數、最近錯誤） |
| `server.js` | 啟動補齊不等待退避；補齊間隔可調（`PD_SETTLE_SWEEP_MS`，預設 60 秒）；每輪日誌含輪次 |
| `utils/migrationV2.js` | 完整取代「商品想買登記」時一併清除本店待辦；商品重新對應時，待辦的商品編號跟隨 `request_uuid` |
| `routes/line-orders.js` | **未修改**（仍呼叫 `bindInTx`、交易後 `bindLate`；`bindInTx` 寫入待辦失敗時會拋出，使訂單交易失敗） |

### 4.2 測試檔

| 檔案 | 狀態 |
|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js` | 新增：本輪 22 項驗收 |
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js` | 新增：同一資料庫 C6.2 → 補修 → C6.2 → 補修，6 項 |
| `scripts/lib/c62r-fault.js` | 新增：測試 preload，故障與 SIGKILL 停點 |
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js` | 修改：A19 保留原斷言並新增 A19-2（見第 10 節） |

### 4.3 交易邊界

| 流程 | 交易 | 內容 | 失敗時 |
|---|---|---|---|
| LINE 下單 | 既有訂單 durable 交易 | ① 建立訂單、扣額度（既有）② **寫入綁定待辦**（無 SAVEPOINT）③ SAVEPOINT `pd_settle_bind` 內，每個商品各自一個 SAVEPOINT `pd_task`，依待辦建立關聯（現金等付款立即扣減；LINE Pay 為訂購中） | ② 失敗 → 整筆訂單交易回滾，不送出外部動作。③ 某商品失敗 → 只回滾該商品，待辦保留並記錄嘗試次數 |
| 交易後補綁 | 獨立 durable 交易 | 處理該訂單的待處理待辦，之後依訂單目前狀態同步 | 記錄嘗試次數與退避時間，訂單不受影響 |
| 定期與啟動補齊 | 每筆訂單各自 durable 交易 | 同上；作廢待辦 → 依保存的原狀態同步 | 只計數，繼續下一筆 |
| 作廢 | 既有作廢 durable 交易 | **第一個語句**：交易內重新讀取 `order_status`、`status`，有關聯或有待處理綁定時寫入作廢待辦；之後為既有的紀錄、狀態、庫存語句 | 待辦寫入失敗 → 作廢交易整筆失敗（與既有語句相同） |
| 作廢後同步 | 獨立 durable 交易 | 依作廢待辦回復或待核對，同一交易內把作廢待辦標為完成 | 待辦維持 pending，由補齊重試 |

## 5. 待辦邏輯

### 5.1 資料表 `product_demand_settle_tasks`

- **共同欄位**：`store_id`、`order_uuid`、`order_number`、`kind`（bind／void）、`state`（pending／done／review）、`attempts`、`last_error`、`next_at`、`result`。
- **綁定待辦另保存**：`product_id`、`line_user_id`（已驗證的會員 session）、`request_uuid`、`cycle_no`、`order_qty`（訂單中該商品的合計份數）、`payment_method`。
- **作廢待辦另保存**：`prior_order_status`、`prior_record_status`（皆為交易內讀取）。
- **唯一鍵**：`(store_id, order_uuid, kind, product_id)`。重複寫入會被忽略（INSERT OR IGNORE）。

### 5.2 綁定

1. 寫入待辦時，只為「同店、同會員、同商品、狀態 active 且未過期」的登記寫入，並保存其 `request_uuid` 與 `cycle_no`。
2. 處理待辦時，只使用待辦保存的 `request_uuid`、會員與份數，**不再查詢目前有效的登記**：
   - 原週期在等待期間被取消或過期 → 關聯仍建立，但套用 0（`cycle_closed:*`），新週期不受影響。
   - 同一訂單同一商品已有關聯 → 標為完成（`link_exists`），不重複扣減。
   - 訂單不存在 → `review`（`order_missing`）。
3. 綁定後依訂單目前狀態同步：
   - 已付款或非 LINE Pay → 扣減。
   - LINE Pay 未付款 → 訂購中（既有逾期解除規則）。
   - 已取消或作廢 → 依作廢規則處理。
4. 不重建訂單，不重送 Confirm，不重送購買或送單事件，也不發送通知。補齊只寫入本機的關聯、登記與待辦三張表。

### 5.3 作廢

| 情況 | 結果 |
|---|---|
| 作廢待辦的 `prior_order_status='completed'` | 待核對（`void_after_completed`），不自動回復 |
| 作廢待辦為其他狀態 | 依原關聯回復一次 |
| 沒有作廢待辦（歷史作廢、或 C6.2 時期作廢） | 待核對（`void_prior_state_unknown`），不猜測 |

- 判斷依據是 `order_status`（履約流程），不是 `orders.status`（紀錄狀態）。C3 驗證了 `status='completed'`、`order_status='accepted'` 的情況被正確判為未履約。
- 取消後再作廢、重複作廢、多次重啟：關聯狀態 `reverted` 之後就不再變動，只回復一次（C4）。

### 5.4 重試

| 時機 | 規則 |
|---|---|
| 定期補齊 | 失敗後 15 秒重試，之後倍增（30、60…），最長 30 分鐘 |
| 啟動補齊 | 不等待退避，處理全部待處理待辦 |

待辦不會因為失敗次數而被放棄。

## 6. 公平輪替

### 6.1 掃描順序

每輪依序處理四類工作：
1. 待辦（task）
2. 訂購中（reserved）
3. 已解除但可能已付款（released）
4. 已扣減但訂單已取消或作廢（cancel）

每類工作的處理方式：
- 取出有資料的店別，依店別代碼排序。
- 每店配額 `max(5, floor(200 ÷ 店數))`。
- 每店從資料庫中的游標 `類別:店別` 往後依 id 取資料。
- 取到的筆數少於配額 → 游標歸零（下一輪從頭）；否則游標移到本輪最後一筆。
- 處理中每 25 筆保存一次游標。程序被終止時，重啟後最多重做 25 筆，重做是可重複、不會重複扣減的。
- 單筆失敗只計數，游標照常前進；該筆下一圈再處理。

### 6.2 輪次與結果（DB 夾具＋重啟；每一輪＝一次啟動補齊）

測試資料：
- store_001 有 451 筆 LINE Pay 訂購中訂單，第 201、402、451 筆逾期，其中第 402 筆注入同步故障。
- store_002 有 302 筆訂購中訂單，第 301、302 筆逾期。
- 其他 748 筆是待核對付款，必須保留。

| 輪次 | 實際處理 | 結果 |
|---|---|---|
| 1 | store_001 id 0→113（100 筆）、store_002 id 0→564（100 筆） | 無逾期 |
| 2 | 處理 50 筆後真實 SIGKILL（每 25 筆保存游標） | — |
| 3 | store_001 從保存的游標 138 繼續 → 238（第 2 輪被終止前已保存到 138）；store_002 564 → 664 | **store_001 第 201 筆解除** |
| 4 | store_001 238 → 338；store_002 664 → 764 | — |
| 5 | store_001 338 → 438（含故障的第 402 筆）；store_002 764 → 766，取完一圈、游標歸零 | **store_002 第 301、302 筆解除**；第 402 筆 failed=1，同輪其他 99 筆照常處理，游標照常前進 |
| 6 | store_001 438 → 464，取完一圈、游標歸零；store_002 從頭 0 → 564 | **store_001 第 451 筆解除** |
| 7–10 | 兩店各自第二圈（每輪各 100 筆；store_002 第 9 輪取完一圈） | 無新的逾期訂單；failed=0 |
| 11 | 測試解除故障後，store_001 414 → 463 再次經過第 402 筆 | **第 402 筆解除** |
| 全程 | — | 748 筆待核對付款都保留訂購中，沒有被標成失敗或解除（B4） |

- 每輪的游標起訖記錄在 `01_TEST_RESULTS.json` 的 `new_acceptance.candidate_obs.B.rounds`，取自全新解壓候選版的執行。
- 上限仍為 200（可用 `PD_SETTLE_SWEEP_LIMIT` 調整），沒有改成每分鐘全量掃描。

## 7. 真實 SIGKILL 停點與結果

| 案例 | 停點 | 重啟前狀態 | 重啟後 |
|---|---|---|---|
| A9 | 訂單交易已提交、交易後補綁開始前 | 訂單已保存、HTTP 連線中斷、已完成 0、待辦 pending | 啟動補齊 → 3／5；再次重啟不變 |
| C1 | 作廢交易已提交、作廢後同步開始前（未履約） | 訂單已作廢、仍 3 | 回復 3 → 0，關聯 `reverted`；再次重啟不變 |
| C2 | 同上停點（已履約） | 仍 3 | 待核對 `void_after_completed`，仍 3 |
| C3 | 同上停點（`status='completed'`、`order_status='accepted'`） | 仍 2 | 回復 2 → 0 |
| B3 | 定期補齊第 2 輪處理 50 筆後 | 游標已保存到第 25 或 50 筆 | 從保存的游標繼續，沒有回到開頭 |

全部使用同一資料庫檔重新啟動，以真實程序 `SIGKILL` 終止，不是模擬例外。

## 8. 資料庫與 MBV2

- **只新增、可重複執行**：新增 2 張表與 3 個索引（`CREATE … IF NOT EXISTS`）。
  - 空資料庫啟動：基準 241 個物件，補修版 246 個（+5，沒有任何物件被移除），health 正常。
- **不回溯**：升級時不掃描歷史訂單，也不為升級前的訂單建立待辦（升級測試 V1：待辦 0）。
- **MBV2 政策**：
  - 待辦與游標只屬於本機，不匯出。
  - 合併匯入不清除本機待辦；匯入的關聯帶有 `import_source`，補齊不處理。
  - 完整取代並選取「商品想買登記」時，清除本店待辦（以 `store_id` 限定）。
  - 商品重新對應時，待辦的商品編號跟隨 `request_uuid`。
  - 所有查詢以 `store_id` 限定，不會跨店綁定。
- **同一資料庫升級／回退實測**（`smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js`，6／6）：

| 步驟 | 結果 |
|---|---|
| V0 原 C6.2 | 登記、現金扣減 2／5、LINE Pay 訂購中、通知批次 1 筆、逐筆受理 2 筆 |
| V1 升級補修 | 新表建立、待辦 0；訂單、付款、通知批次、逐筆紀錄與 retry key 完全相同 |
| V2 補修版故障下單 | 待辦 pending，保存原登記週期 |
| V3 回退 C6.2 | 正常運作（作廢回復、LINE Pay 付款扣減、新訂單連動）；舊版不處理新待辦（如實呈現） |
| V4 再升級 | 該待辦補齊為 2／4；回退期間的資料不另建待辦；訂單、付款、通知紀錄不變；結構雜湊相同 |
| V5 再重啟 | 五個登記的已完成份數都不變；retry key 與升級前相同；真實 LINE 0 |

## 9. 回歸
### 9.1 執行方式

- 候選版：全新解壓 C6.2 ＋ 9 支本輪檔案，`npm ci`，空資料庫啟動正常。
- 基準：未修改的 C6.2。
- 兩版使用相同的 47 支清單，在同一天依序執行（2 核心，避免平行造成時間誤差）。
- 測試時鐘預設台北 10:30（`C4_CLOCK_OFFSET_MS` 自動計算），時段相關案例另以 `C4_CLOCK_OFFSET_MS=0` 執行。
- 候選版執行到第 27 支時，雲端環境重新啟動一次。已完成的 26 支結果保留，第 27 支起重新執行。

### 9.2 逐支比較

| 腳本 | 環境 | 未修改 C6.2 | 補修候選版 | 比較 |
|---|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js` | — | 結果：43 通過、0 失敗 | 結果：44 通過、0 失敗 | 差異（預期）：基準執行原 43 項版本；候選版為 44 項（新增 A19-2，見第 10 節）。更新後的 44 項版本在基準執行：43 通過、1 失敗（只有 A19-2） |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js` | C62R_OLD_ROOT=base | （未執行） | 結果：6 通過、0 失敗 | 差異（預期）：只在候選版執行（需要原 C6.2 作為舊版根目錄） |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js` | — | 結果：7 通過、15 失敗 | 結果：22 通過、0 失敗 | 差異（預期）：本輪新驗收：基準 15 項失敗即重現案例 |
| `smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js` | C62_OLD_ROOT=c61 | 結果：9 通過、0 失敗 | 結果：9 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-1-restock-list-ui-timing-fix.js` | — | 結果：28 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 結果：28 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-1-restock-list-auto-toggle-ui.js` | — | 結果：40 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 結果：40 通過／0 失敗（模擬 LINE 呼叫 0 次；真實 LINE 0 次） | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-auto-restock.js` | — | 結果：24 通過／0 失敗 | 結果：24 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-1-auto-guard-recovery.js` | — | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js` | — | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-2-demand-ui-refresh.js` | — | RESULT: 80 passed, 0 failed | RESULT: 80 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-3-async-consistency.js` | — | RESULT: 34 passed, 0 failed（模擬 LINE 呼叫 2 次；真實 0 次需為 0：0） | RESULT: 34 passed, 0 failed（模擬 LINE 呼叫 2 次；真實 0 次需為 0：0） | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-4-mutation-response.js` | — | RESULT: 20 passed, 0 failed（真實 LINE 呼叫 0 次） | RESULT: 20 passed, 0 failed（真實 LINE 呼叫 0 次） | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-restock-notify.js` | — | RESULT: 94 passed, 0 failed | RESULT: 94 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-1-dedupe-resume.js` | — | RESULT: 40 passed, 0 failed | RESULT: 40 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-5-date-consent.js` | — | RESULT: 55 passed, 0 failed | RESULT: 55 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-5-restock-link.js` | — | RESULT: 42 passed, 0 failed | RESULT: 42 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c4-linepush-compat.js` | — | RESULT: 12 passed, 0 failed（全部為程序內模擬，真實 LINE 呼叫 0 次） | RESULT: 12 passed, 0 failed（全部為程序內模擬，真實 LINE 呼叫 0 次） | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | — | RESULT: 328 passed, 4 failed | RESULT: 328 passed, 4 failed | 相同：O1、O6×2、O9：以今日 12:00 取餐，執行時已過台北 12:00（time_too_early），既有時鐘相依失敗，兩版相同 |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | — | RESULT: 54 passed, 0 failed | RESULT: 54 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | — | RESULT: 32 passed, 0 failed | RESULT: 32 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | — | RESULT: 30 passed, 0 failed | RESULT: 30 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | — | RESULT: 41 passed, 1 failed | RESULT: 41 passed, 1 failed | 相同：預設時鐘 B1 既有時鐘相依失敗，兩版相同；C4_CLOCK_OFFSET_MS=0 時 42/42 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | C4_CLOCK_OFFSET_MS=0 | RESULT: 42 passed, 0 failed | RESULT: 42 passed, 0 failed | 相同：預設時鐘 B1 既有時鐘相依失敗，兩版相同；C4_CLOCK_OFFSET_MS=0 時 42/42 |
| `smoke-r54-4-mbv2-hf1-c1-preorder-status.js` | — | RESULT: 93 passed, 0 failed | RESULT: 93 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-migration.js` | — | RESULT: 121 passed, 0 failed | RESULT: 121 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-2-popup-establishment-taipei-time.js` | — | 結果：29 通過／0 失敗 | 結果：29 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-time-merge.js` | — | 結果：22 通過／0 失敗 | 結果：22 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-2-payment-response-timing.js` | — | 結果：18 通過／0 失敗 | 結果：18 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-1-popup-payment-status-refresh.js` | — | 結果：19 通過／0 失敗 | 結果：19 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-1-timing-fix.js` | — | 結果：11 通過／0 失敗 | 結果：11 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js` | — | 結果：27 通過／0 失敗 | 結果：27 通過／0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js` | — | RESULT: 25 passed, 0 failed | RESULT: 25 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js` | — | RESULT: 33 passed, 0 failed | RESULT: 33 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | — | RESULT: 61 passed, 0 failed | RESULT: 61 passed, 0 failed | 相同 |
| `run-h1-4-10-phase3-checkout-submit-payment-runtime.js` | — | TOTAL=111 PASS=111 FAIL=0 | TOTAL=111 PASS=111 FAIL=0 | 相同 |
| `run-h1-4-10-phase4b-recovery-full-runtime.js` | — | TOTAL=168 PASS=168 FAIL=0 | TOTAL=168 PASS=168 FAIL=0 | 相同 |
| `run-h1-4-10-phase4b-recovery-frontend-targeted.js` | — | TOTAL=50 PASS=50 FAIL=0 | TOTAL=50 PASS=50 FAIL=0 | 相同 |
| `run-h1-4-10-phase4b-recovery-resume-targeted.js` | — | TOTAL=92 PASS=92 FAIL=0 | TOTAL=92 PASS=92 FAIL=0 | 相同 |
| `smoke-h1-4-12-popup-frontend.js` | — | PASS: 293  FAIL: 0  TOTAL: 293 | PASS: 293  FAIL: 0  TOTAL: 293 | 相同 |
| `smoke-h1-4-12-popup-real-browser.js` | — | PASS: 36  FAIL: 0  TOTAL: 36 | PASS: 36  FAIL: 0  TOTAL: 36 | 相同 |
| `smoke-h1-4-12-popup-public-checkout.js` | — | PASS: 1447  FAIL: 0  TOTAL: 1447 | PASS: 1447  FAIL: 0  TOTAL: 1447 | 相同 |
| `smoke-h1-4-12-popup-checkout-integration.js` | — | PASS: 20  FAIL: 0  TOTAL: 20 | PASS: 20  FAIL: 0  TOTAL: 20 | 相同 |
| `smoke-h1-4-12-popup-recovery-cart-frontend.js` | — | PASS: 67  FAIL: 0  TOTAL: 67 | PASS: 67  FAIL: 0  TOTAL: 67 | 相同 |
| `smoke-h1-4-12-popup-state.js` | — | PASS: 94  FAIL: 0  TOTAL: 94 | PASS: 94  FAIL: 0  TOTAL: 94 | 相同 |
| `smoke-r48-popup-order-ui-browser.js` | — | exit 1 | exit 1 | 相同：清單內執行時沒有結果行（腳本替換 console.log）；另以 preload 單獨執行，兩版都是 10/13，失敗項目相同（第 9.3 節） |
| `smoke-r54-4-mbv2-system-regression.js` | — | exit 0 | exit 0 | 相同：輸出沒有計數行；exit 0，兩版相同 |
| `smoke-r54-4-mbv2-large-upload.js` | — | RESULT: 25 passed, 0 failed | RESULT: 25 passed, 0 failed | 相同 |

**結果**：兩版都有執行的 46 支中，44 支的 exit 代碼、通過／失敗數與失敗項目完全相同。另外 2 支的差異是預期的：
- 本輪新驗收：基準 7／22，候選版 22／22。
- C6.2 主驗收：新增 A19-2，第 10 節說明。

同一資料庫升級測試只在候選版執行（6／6）。

**新增失敗：0。**

### 9.3 R48 單獨執行（應用程式外 preload 擷取結果行）

| 版本 | 結果 | 失敗項目 |
|---|---|---|
| 未修改 C6.2 | R48 SMOKE SUMMARY — PASS: 10  FAIL: 3  TOTAL: 13 | R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL |
| 補修候選版 | R48 SMOKE SUMMARY — PASS: 10  FAIL: 3  TOTAL: 13 | R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL |

兩版相同；與 C6.2 報告所列的既有失敗相同。

### 9.4 時鐘相依與既有失敗（兩版同時段相同）

| 腳本 | 項目 | 實際結果 | 原因 |
|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | O1、O6-paused、O6-sold_out_indefinitely、O9 | 兩版都是 328／332 | 測試以今日 12:00 取餐，執行時已過台北 12:00，伺服器回 `time_too_early` |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（預設時鐘） | B1 | 兩版都是 41／42；`C4_CLOCK_OFFSET_MS=0` 時兩版都是 42／42 | 時鐘相依 |
| `smoke-r48-popup-order-ui-browser.js` | R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL | 兩版都是 10／13 | 既有 |

### 9.5 涵蓋範圍對照

| 規格要求 | 腳本 | 候選版 |
|---|---|---|
| C6.2 主驗收 43 項 | demand-cart-order-settlement | 44／44（原 43 項＋A19-2） |
| C6.2 升級／回退 9 項（C6.1 → C6.2） | c6-2-upgrade-rollback | 9／9 |
| 清單 UI 40、時序 28 | c6-1-restock-list-auto-toggle-ui、c6-1-restock-list-ui-timing-fix | 40／40、28／28 |
| C6 24、C6.1 29、PAUSE_CLAIM_RELEASE 29 | c6-auto-restock、c6-1-auto-guard-recovery、c6-1-pause-claim-release | 24／24、29／29、29／29 |
| LINE 結帳 | phase3 checkout（111）、popup public checkout（1447）、checkout integration（20） | 全部通過 |
| LINE Pay 恢復 | c5-2-payment-recovery（33）、phase4b recovery（168／50／92） | 全部通過 |
| 取消／作廢 | 本輪 C1–C5、c5-1-consistency（61） | 全部通過 |
| 付款守門、時序、台北時間 | c5-3（25）、c5-4-2 三支（22／18／29）、c5-4-1 兩支（19／11）、c5-4（27） | 全部通過 |
| MBV2 匯出、預覽、合併、取代、回退 | mbv2-migration（121）、c3-1（54）、c3-2（32）、c3-3（30）、large-upload（25）、system-regression（exit 0） | 全部通過 |

## 10. 既有斷言調整

只調整一項，沒有放寬任何付款、原子性或冪等斷言。

| 檔案 | 斷言 | 原本 | 調整後 | 原因 |
|---|---|---|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js` | A19 | 依序：故障 first → 下單 o1；故障 always → 下單 o2；**故障 off**；核對 o1 補綁扣 1、o2 無關聯、已完成 0 | 斷言內容完全相同；「故障 off」移到核對之後 | 補修版有背景補齊。如果先解除故障，核對前就可能已經補齊，就無法核對「不留下半套結果」。移動後，這個核對反而更嚴格 |
| 同上 | A19-2（新增） | — | 故障解除 → 重啟 → o2 由持久化待辦補齊為 1／3，o1 仍為 1（只扣一次） | 規格要求新增恢復斷言 |

| 版本 | 原 43 項版本 | 更新後 44 項版本 |
|---|---|---|
| 未修改 C6.2 | 結果：43 通過、0 失敗 | 結果：43 通過、1 失敗（只有 A19-2 失敗） |
| 補修候選版 | — | 結果：44 通過、0 失敗 |

A19 本身在兩版都通過。`scripts/lib/c62-bind-fault.js`（C6.2 的故障替身）不需修改：它替換的 `_bindRaw` 在補修版仍存在，參數名稱相同。

## 11. 限制

1. **歷史 C6.2 訂單不回溯補綁。** 本版之前「交易內綁定與補綁都失敗」的訂單沒有保存任何證據，本版不依目前有效的登記猜測。如需處理，應由店家人工核對。
2. **歷史作廢不回溯判斷。** 本版之前的作廢、或回退到 C6.2 期間的作廢，都沒有作廢待辦，一律待核對（`void_prior_state_unknown`），不自動回復。
3. **回退期間待辦不處理。** 原 C6.2 不讀取新表。再升級後啟動補齊會處理（已驗證）；回退期間新建立的訂單則沒有待辦。
4. **待辦只屬於本機。** 待辦不匯出，搬到另一台主機時不會帶走未完成的待辦。搬家前應確認沒有 pending 待辦（第 03 文件第 4 節有查詢語句）。
5. **公平輪替不是即時處理。**
   - 每類工作每輪最多約 200 筆（依店數平分，每店至少 5 筆），單一店的完整一圈需要「該店筆數 ÷ 配額」輪。
   - 預設 60 秒一輪。例如單店 1,000 筆訂購中，一圈約 5 分鐘。
   - 四類工作各自計算配額，一輪合計最多約 800 筆。
6. **重新處理範圍。** 程序在補齊中途被終止時，重啟後最多重新處理 25 筆（每 25 筆保存一次游標）。這些處理是可重複、不會重複扣減的。
7. **定期補齊的退避。** 單筆持續失敗時重試間隔最長 30 分鐘；重啟會立即重試。

## 12. 交付與打包

- **組成**：候選版由未修改的 C6.2 全新解壓，加上 9 支本輪檔案（5 支產品檔、4 支測試檔）。
  - 測試前執行 `npm ci`、空資料庫啟動。
  - 以這個樹完成新驗收、升級測試與 47 支回歸。
- **最終 ZIP**：再次從 C6.2 全新解壓，加入同樣的 9 支檔案與本輪文件夾。
  - 打包後再解壓，與測試過的候選版逐檔比對：除了本輪文件夾，內容完全相同。
- **檔案根目錄**：保留 `server.js`、`package.json`、`.env.example`。
- **不含**：`.env`、資料庫、`node_modules`、上傳資料、log、測試輸出或真實憑證。
- **既有文件**：先前各輪的文件全部保留。
- **ZIP 雜湊**：本文件位於 ZIP 內，無法記載 ZIP 自身的雜湊；雜湊見交付訊息與套件外的最終報告。

## 13. 實際呼叫次數

| 對象 | 次數 |
|---|---|
| 真實 LINE Messaging API | 0 |
| 真實 LINE Pay | 0 |
| LINE Pay Sandbox | 0 |
| 補齊流程發出的通知或外部呼叫 | 0 |
| 本輪新驗收的 LINE Pay 替身 | 2（程序內攔截） |

## 14. 本輪停止

已完成交付，等待審核。未部署，未開啟正式自動通知，未進行 C6.3 合併通知。
