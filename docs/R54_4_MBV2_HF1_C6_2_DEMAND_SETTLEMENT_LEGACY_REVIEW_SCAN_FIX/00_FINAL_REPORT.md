# R54.4／MBV2-HF1-C6.2 歷史待核對紀錄掃描漏標修正 — 最終報告

本輪只修正 `repairLegacy()` C 型歷史處理在大量資料下，後段應待核對紀錄可能永久漏標的問題。上一輪的狀態邊界修正全部保留。

未部署，未操作正式資料，未開啟正式通知，未進行 C6.3。真實 LINE、LINE Pay、Sandbox 呼叫皆為 0。

## 1. 基準

| 項目 | 核對結果 |
|---|---|
| 檔名 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_STATE_EDGE_FIX_APP_ROOT.zip` |
| SHA-256 | `f0ab3ee3860ddf64aeacf77d58eba742ee897061a83fc3ccda59401d85c95dc1`（相符） |
| 大小 | 10,843,964 bytes（相符） |
| 檔案數 | 1,076（相符） |
| ZIP 項目 | 1,136（相符） |
| Manifest | 1,073 筆，逐筆雜湊相符 |

工作方式：
- 建立未修改基準樹與隔離工作樹，各自執行 `npm ci`。
- 新驗收腳本與測試替身以相同內容放入兩個樹。這些都是測試檔，基準的產品程式沒有修改。

## 2. 根本原因

`repairLegacy()` 的 C 型處理流程：
1. SQL 依基本條件 `ORDER BY l.id LIMIT 500` 取資料。
2. 取出後才在 JS 呼叫 `classifyVoidPrior()` 分類。
3. 原狀態合法的紀錄直接 `continue`。

被略過的紀錄沒有改變任何查詢條件，下一次啟動仍然是同樣的前 500 筆，而且只有啟動時才執行。所以只要前 500 筆都是合法紀錄，第 501 筆以後就永遠排不到。

另一個相關問題：每筆標記各自寫一次 durable 檔案，基準處理 500 筆就要約 60 秒。

## 3. 修正方式

只修改 `utils/demandSettlement.js`，**沒有資料庫結構變更**。

### 3.1 篩選放在 LIMIT 之前

C 型查詢在 `LIMIT` 前先排除「原狀態屬合法值」的紀錄：

```sql
v.prior_order_status IS NULL OR trim(v.prior_order_status, ' '||char(9)||char(10)||char(11)||char(12)||char(13)) NOT IN (<合法值>)
```

合法值清單直接取自 `classifyVoidPrior()` 使用的同一組常數（`completed`、`orderStatusFlow.ORDER_STATUSES` 中的未履約值、`cancelled`）。

- SQL 只去除 ASCII 空白，JS `trim` 去除的空白更多，所以 SQL 選出的是「JS 判為未知」的超集。
- 結果：不會漏掉任何應標記者；多選進來的少數紀錄（例如前後是全形空白的合法值）由 JS 再判斷一次並略過。

### 3.2 向後推進的游標

- A 型與 C 型各自以 `l.id > 游標 ORDER BY l.id LIMIT 500` 分批。
- 被略過、失敗或已標記的紀錄都會推進游標，不會停在同一批。

### 3.3 批次上限與續行

| 項目 | 設定 |
|---|---|
| 每批筆數 | 500（固定，`LEGACY_BATCH`） |
| 每輪最多批數 | 4（`LEGACY_BATCHES_PER_ROUND`） |
| 續行方式 | 啟動補齊開始一輪；沒掃完的由定期補齊（預設每 60 秒）接續，直到掃完 |

### 3.4 完成後停止

- 整輪掃完且沒有失敗 → 停止。之後的補齊輪次不再執行歷史查詢，直到下一次啟動。
- 下一次啟動時的查詢只回傳尚未標記的候選，通常是 0 筆，會立即完成。

### 3.5 單筆失敗

- C 型每批一個 durable 交易，批內每筆各自一個 SAVEPOINT：單筆失敗只回滾該筆，同批其他紀錄照常提交。
- 一輪掃完後若有失敗，`PD_LEGACY_RETRY_MS`（預設 5 分鐘）後只重掃尚未標記的候選。

### 3.6 中斷恢復

- 游標只在記憶體中。已提交的標記會被 SQL 排除，所以重啟後從頭掃「尚未標記」者就等於續行。
- 中斷時，只會損失最後一批尚未提交的部分（不會留下半批）。
- 不需要新增游標資料表。

### 3.7 C 型只做標記

`_markLegacyReviewRaw()`：
- 只更新關聯 note（加 `:legacy_review:<原因>`）、最新作廢待辦 result（`legacy_review:<原因>`）與兩者的 `updated_at`。
- 寫入條件包含 `store_id`、`order_uuid`、`state='reverted'`、非匯入、note 尚未含 `legacy_review`，所以不覆寫正常紀錄，也不重複追加。
- 只有關聯確實被更新時，才更新作廢待辦。

### 3.8 A 型

證據門檻、有效期檢查、防重條件與每筆一個 durable 交易，都與 STATE_EDGE_FIX 相同；只改為同一游標方式分批，沒有擴大範圍。

### 3.9 新增選用環境變數

`PD_LEGACY_RETRY_MS`：失敗重試間隔。

## 4. 測試層級

| 標示 | 意義 |
|---|---|
| `[FX-DB]` | 大量歷史資料以 SQLite fixture 在停機時寫入資料庫檔。舊版錯誤終態與 NULL／不合法原狀態無法由正式流程產生 |
| `[BOOT]` | **正式啟動流程整合**：`node server.js` 啟動後由既有啟動補齊與定期補齊處理。所有案例都經由這個流程，**沒有直接呼叫函式的案例** |
| `[API]` | 範本資料以正式 HTTP 路由建立：通知批次與逐筆受理、LINE Pay 付款、現金訂單 |
| `[RS]` | 一般重啟 |
| `[KILL]` | 真實 SIGKILL（測試 preload 停點），同一資料庫重啟 |
| `[FAULT]` | 測試 preload 注入的單筆保存失敗 |
| `[DB]` | 直接讀資料庫檔核對 |

故障注入只使用測試 preload `scripts/lib/c62r-fault.js`（本輪新增 `legacyFailLinkIds`、`killAfterLegacyMarks`）。正式程式沒有新增任何可觸發故障的端點或旗標。

## 5. 重現與新驗收

腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-fix.js`，11 項。同一腳本、同一組斷言。

| 版本 | 結果 |
|---|---|
| 未修改基準 | **3 通過、8 失敗**（0 項例外；8 項失敗全是本輪修正項目，都是「未標記或未處理完」的業務斷言） |
| 修正版工作樹 | 11 通過、0 失敗 |
| 全新解壓候選版（回歸清單內） | 11 通過、0 失敗 |

| 編號 | 案例 | 未修改基準（實際） | 修正版（實際） |
|---|---|---|---|
| L1 | 500 筆 accepted＋第 501 筆 NULL，第一次正式啟動 | 未標記（12 輪補齊都沒有處理） | 第一次啟動補齊（第 2 輪）即標記 `void_prior_state_missing`：1 批、標記 1 |
| L1-2 | 連續三次啟動 | 三次都是 0 | 三次都只有 1 個標記、不重複；後兩次啟動掃描 0 筆即完成；所有比對項目不變 |
| L2 | 1,100 筆正常（含 `' accepted '`、`'\taccepted\n'`、`'\u3000accepted'`、`'completed '`）之後混入 NULL、`''`、`'   '`、`'\u3000'`、`'Completed'`、`'shipped_x'` | 6 筆都未標記 | 6 筆依原因正確標記（missing×4、invalid×2）；`\u3000accepted` 110 筆被 SQL 選入但經 JS 判為合法而略過、未被改動 |
| L3 | 應標記者 2,300 筆、兩店交錯 | 啟動時只處理前 500 筆（耗時 62 秒），之後不再處理 | 同一次啟動 6 秒內全部完成：第 2 輪 4 批、2,000 筆；第 3 輪 1 批、300 筆並標示完成 |
| L3-2 | 有界工作量與完成後停止 | 無歷史處理輪次 | 每輪 ≤ 4 批；完成後再觀察 4 輪補齊，都沒有歷史掃描 |
| L3K | 1,500 筆，第 2 批處理到第 700 筆時 SIGKILL | 停點不存在，未中斷；每次啟動只處理 500 筆，重啟後 1,000 | SIGKILL 後磁碟上剛好 500 筆（只有已提交的第 1 批）；同一資料庫重啟後續行到 1,500，不重複 |
| L4 | 600 筆正常與已標記、匯入、未作廢訂單穿插；跨店同訂單 UUID；後段 3 筆應標記 | 3 筆都未標記 | 只有 3 筆變動（store_002 的同 UUID 訂單只更新 store_002 的關聯與待辦）；兩次啟動不重複 |
| L4-A（G） | A 型：現金證據、LINE Pay 未付款、匯入、缺綁定待辦 | 通過 | 通過：現金只補記一次 3；LINE Pay 只轉待核對、不扣；匯入與缺證據者不處理 |
| L5 | 600 筆正常＋3 筆應標記，其中 1 筆注入保存失敗 | 3 筆都未標記 | 其餘 2 筆照常標記（第 2 輪：標記 2、失敗 1）；故障解除後不需重啟，3 秒後重試輪（第 5 輪）補齊第 3 筆 |
| T0、Z1（G） | 範本與外部呼叫 | 通過 | 通過 |

說明：
- 「第 2 輪」是啟動補齊（啟動後 2.5 秒）。第 1 輪是測試設定的 1.5 秒定期補齊，早於啟動補齊。
- 輪次明細來自伺服器日誌（`PD_SETTLE_SWEEP_LOG=1` 時每輪輸出的 `legacy` 欄位），完整數值記在 `01_TEST_RESULTS.json` 的 `new_acceptance.observed_rounds`。

### 5.1 前後資料比對（每個情境都做）

比對方式：先對範本做一次中性啟動，讓既有的啟動回填（例如舊訂單 `pickup_type`）先完成；之後比對建立 fixture 前與處理後的資料庫。

**C 型標記案例中必須完全不變的項目：**
- 登記：`settled_qty`、status、`request_uuid`、`expires_at`、cycle、desired、`completed_at`。
- 關聯：state、`applied_qty`、`order_qty`、`request_uuid`、店別、訂單、`import_source`。
- 作廢待辦：result 以外的欄位。
- 訂單全表。
- LINE Pay 付款紀錄全表。
- 通知批次全表、逐筆紀錄與 retry key。

**允許的變動：**
- 只有預期紀錄的關聯 note 等於「原 note＋`:legacy_review:<原因>`」。
- 只有對應作廢待辦的 result 等於 `legacy_review:<原因>`。

**結果：**
- 修正版每個情境的差異數都是 0。
- 基準的差異只有「預期該標記卻沒有標記」，沒有任何非預期的改動。
- A 型（L4-A）另外比對預期的份數與關聯狀態。

## 6. 實測處理輪數

| 情境 | 應標記筆數 | 輪次（第幾輪：批數／標記數） | 完成時間 |
|---|---|---|---|
| L1 | 1 | 第 2 輪：1／1，完成 | 啟動補齊 |
| L2 | 6（另略過 110） | 第 2 輪：1／6，完成 | 啟動補齊 |
| L3 | 2,300 | 第 2 輪：4／2,000；第 3 輪：1／300，完成 | 啟動後 6 秒 |
| L3K | 1,500 | 第 1 次啟動：第 1 批 500 已提交，第 2 批第 700 筆被終止；重啟後：2 批／1,000，完成 | 重啟後同一輪 |
| L5 | 3 | 第 2 輪：標記 2、失敗 1；第 5 輪（重試）：標記 1，完成 | 故障解除後 3 秒（測試設定 `PD_LEGACY_RETRY_MS=3000`） |

## 7. 回歸

### 7.1 執行方式

- **候選版**：未修改基準全新解壓，加上 4 支本輪檔案，執行 `npm ci`。
- **空資料庫啟動**：兩版都是 246 個物件，結構雜湊 `14c0f17e16256a3b` 相同。
- **時段**：2026-11-21 台北約 09:46～11:00；候選版先、基準後，依序執行（2 核心）。

### 7.2 逐支比較

| 腳本 | 環境 | 未修改基準 | 候選版 | 比較 |
|---|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-fix.js` | — | 結果：3 通過、8 失敗 | 結果：11 通過、0 失敗 | 差異：本輪新驗收（基準即重現案例） |
| `smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-upgrade-rollback.js` | C62L_OLD_ROOT=r4 | （未執行） | 結果：4 通過、0 失敗 | 只在候選版執行（需要 STATE_EDGE_FIX 舊樹）；結果見第 8.3 節 |
| `smoke-r54-4-mbv2-hf1-c6-2-state-edge-fix.js` | — | 結果：31 通過、0 失敗 | 結果：31 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-state-edge-upgrade-rollback.js` | C62S_OLD_ROOT=r3 | 結果：6 通過、0 失敗 | 結果：6 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js` | — | 結果：22 通過、0 失敗 | 結果：22 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js` | C62R_OLD_ROOT=r2 | 結果：6 通過、0 失敗 | 結果：6 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js` | — | 結果：44 通過、0 失敗 | 結果：44 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js` | C62_OLD_ROOT=r2 | 結果：9 通過、0 失敗 | 結果：9 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-1-consistency.js` | — | RESULT: 61 passed, 0 failed | RESULT: 61 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c5-2-payment-recovery.js` | — | RESULT: 33 passed, 0 failed | RESULT: 33 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-migration.js` | — | RESULT: 121 passed, 0 failed | RESULT: 121 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | — | RESULT: 54 passed, 0 failed | RESULT: 54 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | — | RESULT: 32 passed, 0 failed | RESULT: 32 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | — | RESULT: 30 passed, 0 failed | RESULT: 30 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-large-upload.js` | — | RESULT: 24 passed, 1 failed | RESULT: 25 passed, 0 failed | 差異：清單內基準 L8（256MB+1 byte 應回 413）單次失敗；同時段成對重跑兩版皆 25／25（上一輪候選版也出現同樣單次失敗） |
| `smoke-r54-4-mbv2-system-regression.js` | — | exit 0 | exit 0 | 相同（輸出沒有計數行，以 exit code 比較） |

**同時段成對重跑**：large-upload 候選版 RESULT: 25 passed, 0 failed；基準 RESULT: 25 passed, 0 failed。

**結果**：
- 兩版都執行的 15 支中，13 支完全相同。
- 其餘 2 支：
  - 本輪新驗收（預期差異）。
  - large-upload：單次差異，重跑後兩版相同。L8 測的是遷移上傳上限，與本輪修改沒有程式路徑交集。
- **新增失敗：0。既有斷言沒有修改或放寬。**

### 7.3 涵蓋範圍

| 規格要求 | 腳本 | 候選版 |
|---|---|---|
| STATE_EDGE_FIX 原 31 項 | state-edge-fix | 31／31 |
| DURABLE_RECOVERY_FIX 原 22 項（含公平輪替） | durable-recovery-fix | 22／22 |
| C6.2 主驗收 44 項 | demand-cart-order-settlement | 44／44 |
| 受影響的歷史修復 | 本輪 L4-A、state-edge-fix H1～H3、state-edge-upgrade（6） | 全部通過 |
| MBV2 | mbv2-migration（121）、c3-1（54）、c3-2（32）、c3-3（30）、large-upload（25）、system-regression（exit 0） | 全部通過 |
| 作廢、付款恢復 | c5-1-consistency（61）、c5-2-payment-recovery（33） | 全部通過 |
| 先前各輪升級／回退 | durable-recovery-upgrade（6）、c6-2-upgrade（9） | 全部通過 |

### 7.4 未執行的套件

先前完整清單中的其他 33 支本輪未執行：
- 列表 UI、時序補修、C6、C6.1、PAUSE_CLAIM_RELEASE。
- C4 通知系列、C5.3／C5.4 付款 UI 與付款守門。
- h1-4 popup 系列、phase3／phase4b、R48、C1、C3 售完狀態。

理由：本輪只修改 `utils/demandSettlement.js` 的歷史處理掃描，這些套件測試的前端、付款與通知程式逐檔相同（第 9 節）。上一輪（STATE_EDGE_FIX）的完整清單結果仍可參考：已知時鐘相依失敗（c3 售完狀態 O1／O6／O9、c5 轉換 B1）與 R48 既有失敗，本輪沒有重新執行。

### 7.5 時鐘相依與既有失敗

本輪執行的 15 支在兩版都沒有時鐘相依失敗。

## 8. 同一資料庫升級／回退

### 8.1 順序

STATE_EDGE_FIX → 本輪 → 回退 STATE_EDGE_FIX → 再升級（`smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-upgrade-rollback.js`）：**4／4**。

### 8.2 各步驟結果

| 步驟 | 結果 |
|---|---|
| U0 | STATE_EDGE_FIX 執行後，600 筆合法紀錄之後的 2 筆未知原狀態沒有被標記（重現）；通知逐筆 2 筆、LINE Pay 付款扣減 3 |
| U1 升級 | 2 筆依原因標記（missing、invalid）；份數、關聯 state／`applied_qty`、待辦（result 以外）、訂單、付款、通知與 retry key 不變；結構雜湊與舊版相同 |
| U2 回退 | 已完成的標記（關聯 note、待辦 result）不被移除或改寫；回退版本照常下單扣減 |
| U3 再升級並再重啟 | 不重複標記；份數、待辦、訂單、付款、通知與 retry key 與回退後相同；結構與最初相同；真實 LINE 0 |

回退期間 STATE_EDGE_FIX 仍會漏標後段資料（缺口重新出現）。再升級後第一次啟動就會補標。

### 8.3 測試本身的修正

這支新測試在回歸清單內執行時：
- 4 項斷言全部通過，但結果行沒有輸出。
- 原因是測試的 `stop()` 只檢查 `exitCode`。已被 SIGTERM 結束的程序 `exitCode` 為 null，最後一個 `finally` 會一直等待，Node 因事件迴圈清空而以 0 結束。這也可能掩蓋失敗。

處理：
- 已修正為同時檢查 `signalCode`，並在結果行寫出後才結束程序。
- 修正後在候選版重跑：結果 4 通過、0 失敗，結果行正常輸出。最終 ZIP 內是修正後的版本。

## 9. 未變更檔案的逐檔相同證據

候選版與未修改基準逐檔比對：
- 只有 `utils/demandSettlement.js` 與 `scripts/lib/c62r-fault.js` 不同。
- 另外新增 2 支測試腳本。
- 其他檔案全部相同。

| 類別 | 檔案數 | 結果 |
|---|---|---|
| 前端（`public/`） | 78 | 全部相同 |
| 付款核心（`routes/linepay.js`、`utils/linePayService.js`、`utils/linePayRecovery.js`、`utils/popupPayment.js`、`routes/line-orders.js`、`routes/orders.js`、`utils/orderStatusFlow.js`） | 7 | 全部相同 |
| 通知引擎（`utils/restockNotify.js`、`utils/restockAuto.js`、`utils/linePush.js`） | 3 | 全部相同 |
| 其他（`server.js`、`utils/db.js`、`utils/migrationV2.js`、`routes/product-demand.js`、`.env.example`、`package.json`、`package-lock.json`） | 7 | 全部相同 |

逐檔 SHA-256 記在 `01_TEST_RESULTS.json` 的 `unchanged_files`。

## 10. 修改檔案

| 檔案 | 狀態 |
|---|---|
| `utils/demandSettlement.js` | 修改：`repairLegacyBatch()`、`_markLegacyReviewRaw()`、新的 `repairLegacy()`（一整輪）、`_legacyStart`／`_legacyStep`（補齊每輪驅動）、`sweep()` 呼叫方式 |
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-fix.js` | 新增：11 項 |
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-legacy-review-scan-upgrade-rollback.js` | 新增：4 項 |
| `scripts/lib/c62r-fault.js` | 修改：新增 2 個停點；原有停點不變 |

## 11. 未測項目與限制

1. **自然產生的大量歷史錯誤資料**：以 fixture 建立，沒有由舊版長時間運作產生。升級測試 U0 的 2 筆在 STATE_EDGE_FIX 上實際啟動並確認漏標。
2. **SQL 超集與 JS 正規化差異**：前後是非 ASCII 空白的合法值會被 SQL 選入、再由 JS 略過。這不影響正確性，只增加少量掃描（L2 實測 110 筆）。
3. **持續失敗的紀錄**：每 `PD_LEGACY_RETRY_MS` 重掃一次尚未標記的候選，沒有次數上限。每次只查候選，不會全表掃描；可用第 03 文件的 SQL 找出。
4. **33 支未執行套件**：見第 7.4 節。
5. **作廢以外的取消流程、前端、付款及通知**：不在本輪範圍，未修改。

## 12. 交付與打包

- **組成**：由未修改基準全新解壓，加上 4 支本輪檔案。
  - 執行 `npm ci`、空資料庫啟動，再執行新驗收、升級測試與回歸。
  - 升級測試修正後已在候選版重跑。
- **最終 ZIP**：再次全新解壓基準，加入同樣 4 支檔案與本輪文件夾。打包後解壓，與已測候選版逐檔比對：除了本輪文件夾完全相同。
- **根目錄**：直接有 `server.js`、`package.json`，保留 `.env.example` 及既有各輪文件。
- **不含**：`.env`、資料庫、`node_modules`、上傳資料、log、測試輸出或真實憑證。
- **套件內文件**：`docs/R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_LEGACY_REVIEW_SCAN_FIX/`
  - `00_FINAL_REPORT.md`
  - `01_TEST_RESULTS.json`
  - `02_FILE_MANIFEST.json`
  - `03_OPS_ROLLBACK_GUIDE.md`
- **ZIP 雜湊**：本文件位於 ZIP 內，無法記載 ZIP 自身的雜湊；見交付訊息與套件外報告文末。

## 13. 外部呼叫次數

| 對象 | 次數 |
|---|---|
| 真實 LINE Messaging API | 0 |
| 真實 LINE Pay | 0 |
| LINE Pay Sandbox | 0 |
| 歷史處理發出的通知或外部呼叫 | 0（只寫本機資料庫） |
| LINE Pay 替身（程序內） | 只在建立範本時：新驗收 Request 1、Confirm 1；升級測試 Request 1、Confirm 1 |

## 14. 本輪停止

已完成交付，等待審核。未部署，未開啟正式通知，未進行 C6.3。
