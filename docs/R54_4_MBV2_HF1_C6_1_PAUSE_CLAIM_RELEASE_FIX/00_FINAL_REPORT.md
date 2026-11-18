# R54.4／MBV2-HF1-C6.1 補修最終報告：暫停分支的過期通知名額釋放

> ZIP 自身的 SHA-256 無法寫在 ZIP 內，請見交付訊息與套件外的 `R54_4_MBV2_HF1_C6_1_PAUSE_CLAIM_RELEASE_FIX_FINAL_REPORT.md`（內容相同，另加第 10.3 節最終雜湊）。
> 本輪**未部署、未操作正式資料**，也未開啟正式自動通知。真實 LINE、LINE Pay、Sandbox 呼叫皆為 **0**。
> 本輪只處理下述漏通知缺口，不進行 C6.2。

## 0. 摘要

- **缺口**：自動批次的第一筆（A）已交給 LINE、回應尚未返回時，版本改變（全店關閉再開啟，或商品退出再加入）；接著批次又因總開關關閉、授權錯誤或額度不足而暫停。
  - 第二筆（B）從未送出，卻仍占週期名額（`claim=1`），也沒有記錄失效原因。
  - 之後新的合法恢復販售事件把 B 排除為 `in_other_batch`，以 `no_eligible_recipient` 跳過。
- **根因**：worker 所有「`break` 後收尾」的出口都只把批次標成暫停，沒有核對版本。這些出口包括總開關、必要設定、授權、額度、權杖、等待重試；worker 例外收尾也一樣。開關變更當下的清理只處理暫停中與預覽中的批次，此時批次仍是送出中，因此被略過。
- **修正**：2 個產品檔，沒有資料庫變更。
  - 所有收尾都經過同一個函式，在同一個 durable 交易中以目前資料重新判定，確定過期才釋放「從未送出」項目的名額。
  - 判定與清理都沿用 C6.1 既有的 `staleReasonRaw()`／`applyStaleRaw()`。
- **新驗收**：同一份腳本、同一組斷言。

  | 受測版本 | 結果 |
  |---|---|
  | 未修改 C6.1 | 14 通過／15 失敗（業務斷言失敗） |
  | 補修版（工作樹） | 29／29 |
  | 補修版（候選 ZIP 全新解壓） | 29／29 |

- **升級／回退**：C6.1 → 補修版 → 回退 C6.1 → 再升級補修版，7／7。
- **回歸**：同一份 40 支清單在未修改 C6.1 與補修版逐項相同，R48 單獨執行也相同。既有失敗見第 7 節。

## 1. 基準核對

| 項目 | 值 |
|---|---|
| 檔案 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_1_AUTO_RESTOCK_GUARD_RECOVERY_FIX_APP_ROOT.zip`（工作區已存在的同一份） |
| SHA-256 | `a1b5f56bca0e5c920b9201e5c52b324d671dc51529bba95c8cd13720657de8ea`（相符） |
| 大小 | 7,814,999 bytes（相符） |
| 檔案／ZIP 項目 | 1,017／1,068（相符） |
| Manifest | 1,014 筆，逐檔大小與 SHA-256 全部相符；未列入的只有該輪 `00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json` 三份自我參照文件 |

- **基準樹**：同一份 ZIP 全新解壓，只加入本輪新驗收腳本 `smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js`；產品程式與既有測試未修改。
- **工作樹**：同一份 ZIP 全新解壓後修改。

## 2. 根因

`utils/restockNotify.js` 的 `runBatch()` 有兩類出口：

| 出口 | 原本行為 | 是否核對版本 |
|---|---|---|
| 逐筆送出前的版本預檢（C6.1） | `stopStaleAuto()` → `applyStaleRaw()` | ✅ |
| durable claim 交易內核對（C6.1） | `applyStaleRaw()` | ✅ |
| 連結／訊息快照失配 | `voidMismatchedBatchRaw()`：從未送出者 `blocked`，`claim=NULL` | 安全（已釋放） |
| **`!cap.notify_available`**（總開關關閉 `send_disabled`、必要設定不完整 `config_incomplete`） | `break` → `finalizeBatch()` 只標暫停 | ❌ |
| **`applyResult()` 回傳暫停**（授權錯誤 `auth_error`、額度不足 `monthly_limit`、未設定權杖 `not_configured`） | `break` → `finalizeBatch()` 只標暫停 | ❌ |
| **等待重試超過程序內等待上限**（`retry_pending`） | `break` → `finalizeBatch()` | ❌ |
| 正常結束 | `finalizeBatch()` → `completed` | （沒有未送出項目） |
| **worker 例外**（`startWorker()` catch） | 直接標 `worker_error` | ❌ |

開關變更時的 `staleSweepRaw()` 只處理 `paused`／`previewed` 批次。A 等待回應時批次仍是 `sending`，所以被略過；等批次因上述原因暫停時，已經沒有任何步驟再核對版本。結果是 B 的名額一直留到下次重啟，才會由開機清理釋放。重啟前就發生的新事件已經被跳過，也不會補送。

## 3. 修改的檔案

| 檔案 | 修改內容 | 對應根因 |
|---|---|---|
| `utils/restockNotify.js` | `finalizeBatch()`：在既有收尾交易的最後，加入 `releaseIfStaleRaw(raw, storeId, batchUuid)` | 涵蓋 `send_disabled`、`config_incomplete`、`auth_error`、`monthly_limit`、`not_configured`、`retry_pending`；正常結束也呼叫（沒有未送出項目，等於不動作） |
| `utils/restockNotify.js` | `startWorker()` 例外收尾：把 `worker_error` 標記與 `releaseIfStaleRaw()` 放進同一個 durable 交易 | worker 例外出口 |
| `utils/restockAuto.js` | 新增 `releaseIfStaleRaw()`，只是組合既有的 `staleReasonRaw()` 與 `applyStaleRaw()` | 共用收尾判定 |
| `utils/restockAuto.js` | `applyStaleRaw()`：批次已因外部原因（`EXTERNAL_PAUSE`：`send_disabled`、`config_incomplete`、`auth_error`、`monthly_limit`、`not_configured`、`worker_error`）暫停時，**保留原暫停原因**，不覆寫成版本原因 | 讓授權、額度等原因與版本失效原因都可追查 |

收尾規則：
1. **以交易內重新讀取的目前資料判定**：`staleReasonRaw()` 在同一個 durable 交易內讀取批次、事件、設定與商品，不沿用 worker 開始時的批次物件。全店 epoch、商品參與版本與人工接手的判定，都沿用 C6.1 的既有規則。
2. **只有確定過期才釋放**：手動批次、已人工接手的自動批次、版本仍有效的自動批次，`staleReasonRaw()` 回傳空字串，完全不動作。
3. **只釋放從未送出的項目**：`applyStaleRaw()` 只更新 `attempt_count=0` 且狀態為 `pending`／`retry_wait`／`held` 的列。
   - 保留狀態（未受理）、記錄 `exclusion_reason`，並設 `claim=NULL`。
   - delivery 與 retry key 不動，所以店家明確接手時，`resumeBatch()` 會重新取得名額（C6.1 既有規則）。
4. **已嘗試的項目不動**：已受理、結果不明、已嘗試、正在送出（`attempt_count>0` 或 `sending`）的名額、retry key、HTTP 狀態、錯誤碼、受理證據與嘗試次數都原樣保留。
5. **可重複執行**：對已釋放的列再執行一次結果相同，不產生通知，也不改變統計。

**資料庫變更：無。** 既有欄位已足以判定：`claim`、`attempt_count`、`exclusion_reason`、`pause_reason`、批次與事件版本欄位都在 C6.1 已有。

前端未修改：新原因沿用 C6.1 已有的中文標籤。付款頁、付款核心與無關介面也都未修改。

## 4. 新增驗收與結果

腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js`。

執行方式：
- 正式事件建立（`PATCH /api/products/:id/line-status`）＋正式 worker 流程。
- `c4-line-mock` 依收件人指定回應序列：200、401、`429_quota`、500。
- `c61-line-gate` 讓 A 的請求先由模擬 LINE 產生結果，再暫停回應，直到測試放行。
- 等待一律以檔案或 API 的明確狀態為準，不靠固定 sleep。

分類：D＝C6.1 缺陷重現、G＝保留既有行為。

| 案例 | 層級 | 內容 | 分類 | 未修改 C6.1 | 補修版（全新解壓） |
|---|---|---|---|---|---|
| I1／I1b／I1c | API | 全店關閉再開啟＋**總開關關閉** | D | ❌／✅／❌ | ✅✅✅ |
| I2／I2b／I2c | API | 全店關閉再開啟＋**授權錯誤** | D | ❌／✅／❌ | ✅✅✅ |
| I3／I3b／I3c | API | 全店關閉再開啟＋**額度不足** | D | ❌／✅／❌ | ✅✅✅ |
| I4／I4b／I4c | API | 商品退出再加入＋**總開關關閉** | D | ❌／✅／❌ | ✅✅✅ |
| I5／I5b／I5c | API | 商品退出再加入＋**授權錯誤** | D | ❌／✅／❌ | ✅✅✅ |
| I6／I6b／I6c | API | 商品退出再加入＋**額度不足** | D | ❌／✅／❌ | ✅✅✅ |
| O1 | API | 版本未改變、只有總開關關閉：B 名額保留，恢復後續送以原 key 送出 1 則 | G | ✅ | ✅ |
| O2 | API | 版本未改變、只有授權錯誤：B 名額保留 | G | ✅ | ✅ |
| O3 | API | 手動批次＋商品參與切換＋授權錯誤：名額保留、不記錄自動原因 | G | ✅ | ✅ |
| O4 | API | 已人工接手的自動批次再遇版本改變＋授權錯誤：維持接手規則（名額保留） | G | ✅ | ✅ |
| O5 | API | 已受理、已嘗試未受理（401／429）、結果不明（5xx 等待重試）：名額、嘗試次數、retry key 全部保留；只有從未送出的 B 釋放 | G | ✅ | ✅ |
| O6 | API | 正常自動批次（沒有切換或暫停）全部送完 | G | ✅ | ✅ |
| M1 | API | 清理後店家明確續送：B 以原 delivery、原 retry key 送出 1 則並重新取得名額；A 以同一 key 重試受理 | D | ❌（續送前 B 仍占名額 `claim=1`，未清理） | ✅ |
| M2 | API | 新批次已通知 B 後，接手舊批次兩次：B 不再送出 | D | ❌（前提不成立：基準的新事件被跳過，B 未被通知，接手時才送出） | ✅ |
| D1 | **RS** | 實際 SIGKILL 後同一資料庫檔重啟：epoch、版本、名額、retry key、嘗試次數一致，沒有新發送 | G | ✅ | ✅ |
| D2 | **FX** | 停機修改資料庫檔，建立基準可能留下的「過期暫停批次（`auth_error`）＋未送出仍占名額＋被跳過的 `skipped` 事件」 → 重啟後安全清理、保留授權暫停原因；歷史 `skipped` 事件不重排、不補發 | D | ❌（名額有清除，但暫停原因被覆寫成 `auto_epoch_stale`，授權原因無法追查） | ✅ |
| Z | — | 真實 LINE 呼叫 0 次 | G | ✅ | ✅ |
| **合計** | | | | **14 通過／15 失敗** | **29／29** |

- 每組 I 案例分三個斷言：
  - `In`：A 結果照實保存；B 的 HTTP 呼叫 0 次、未標示已通知、retry key 不變；過期名額已釋放並記錄原因。
  - `Inb`：批次保留原暫停原因。
  - `Inc`：新的合法恢復販售事件通知 B 1 則，A 不重複受理。
- **未修改 C6.1 的失敗都是業務斷言失敗**，沒有任何一項是因為補修版新增的函式不存在（新驗收只透過 API 與資料庫觀察）。
  - I1～I6：B 為 `pending`、`attempt_count=0`、`claim=1`、失效原因空白。
  - I1c～I6c：新事件 `skipped／no_eligible_recipient`，B 收到 0 則。
- 補修版 D1 註記：重啟時，既有的 C4.1 開機防重規則把 5 列「本週期已由新批次通知」的舊未送出列改為 `blocked／already_notified`。這是既有保護，名額、retry key、嘗試次數都沒有變。

### 4.1 各類項目實測資料（補修版全新解壓）

| 項目類型 | 案例 | 狀態 | HTTP | 錯誤碼 | 嘗試次數 | claim | retry key | 結果 |
|---|---|---|---|---|---|---|---|---|
| 已受理 | I1／I4 的 A | `accepted` | 200 | — | 1 | 1 | 不變 | 保留，不重送 |
| 已嘗試、授權錯誤 | I2／I5 的 A | `held` | 401 | `unauthorized` | 1 | 1 | 不變 | 保留；M1 店家續送時以同一 key 重試 |
| 已嘗試、額度不足 | I3／I6 的 A | `held` | 429 | `monthly_limit` | 1 | 1 | 不變 | 保留 |
| 結果不明 | O5 的 A（5xx） | `retry_wait` | 500 | — | 1 | 1 | 不變 | 保留，不自動補送 |
| 未送出（過期） | I1～I6 的 B | `pending` | — | — | 0 | **NULL** | 不變 | 記錄 `auto_epoch_stale`／`auto_product_version_stale`；HTTP 0；新事件通知 1 則 |
| 未送出（版本有效） | O1／O2 的 B | `pending` | — | — | 0 | 1 | 不變 | 保留名額，可續送 |

模擬 LINE（補修版全新解壓）：HTTP 呼叫 26、使用的 retry key 24、唯一受理 17。差額是同一 key 的合法重試（409 已受理），以及 401、429、5xx 未受理的嘗試。

## 5. 暫停出口覆蓋

| 出口 | 程式位置 | 黑箱實測 |
|---|---|---|
| 總開關關閉（`send_disabled`） | `finalizeBatch()` | I1、I4、O1 |
| 必要設定不完整（`config_incomplete`） | 與總開關同一分支 → `finalizeBatch()` | 未單獨實測（同一行程式分支） |
| 授權錯誤（`auth_error`） | `applyResult()` → `finalizeBatch()` | I2、I5、O2、O3、O4 |
| 額度不足（`monthly_limit`） | 同上 | I3、I6 |
| 未設定權杖（`not_configured`） | 與授權同一分支 | 未單獨實測（同一行程式分支） |
| 等待重試（`retry_pending`） | `finalizeBatch()` | 未單獨實測：程序內等待時，未送出項目的 B 會先被選取，由 C6.1 的版本預檢處理（O5 已實測） |
| worker 例外（`worker_error`） | `startWorker()` catch，與標記同一交易 | **未實測**：無法以黑箱方式穩定觸發，僅經程式檢查 |
| 連結失配 | `voidMismatchedBatchRaw()`（C6.1 已安全） | C6.1 原驗收 C6 |
| 版本預檢與 claim 交易（C6.1） | 既有 | C6.1 原驗收 A2／B1／B2 |
| 開機清理 | `bootRecover()` → `staleSweepRaw()` | D2、升級 U1、R3 |

## 6. 升級／回退

腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release-upgrade-rollback.js`。
- 以 C6.1 自己的程式建立空資料庫，之後在未修改 C6.1 與補修版之間切換**同一個資料庫檔**（實際停止／啟動服務程序）。結果 7／7。
- 每次切換都逐表核對：需求、同意、批次、逐筆結果、retry key、版本（商品參與版本、批次 epoch 與參與版本、事件版本、全店 epoch）、訂單與時間。
- 唯一允許的差異是各版本相同的既有開機補值：舊外帶訂單 `pickup_type` 空白 → `store`。

| 案例 | 步驟 | 結果 |
|---|---|---|
| U1 | C6.1 產生缺口狀態 → 升級補修版 | C6.1 留下的 B（`claim=1`、無原因）在開機時清理：釋放名額、記錄 `auto_epoch_stale`、retry key 不變、保留 `auth_error`。資料與版本全部保留 |
| U2 | 補修版新事件 | 通知 B 1 則 |
| U3 | 補修版交錯（關閉再開啟＋額度不足） | 即時釋放，不需要重啟 |
| R1 | 回退 C6.1 | 資料、證據、retry key、版本全部保留；已釋放的名額維持釋放 |
| R2 | C6.1 期間 | 已釋放的 B 可由新事件通知 1 則；但**新的交錯情境缺口恢復**（B 仍占名額，`claim=1`，沒有原因） |
| R3 | 再升級補修版 | 回退期間留下的過期名額在開機時清理；資料與版本保留；新事件通知 B 1 則；每位會員唯一受理 ≤ 1 |
| Z | — | 真實 LINE 0 |

**回退限制**：
- 回退到 C6.1 後，本缺口會恢復：交錯情境下，從未送出的項目仍占名額，直到下次重啟由開機清理釋放。重啟前已被跳過的新事件不會補送。
- C6.1 的開機清理會把「授權錯誤／額度不足」等暫停原因覆寫成版本原因。原始錯誤仍保留在 A 的逐筆紀錄（HTTP 狀態與錯誤碼）。

**未執行的升級套件**：
- `smoke-r54-4-mbv2-hf1-c5-4-2-upgrade-rollback.js`：需要 C5.4.1 TIMING_FIX 程式樹，工作區沒有，未執行。
- `smoke-r54-4-mbv2-hf1-c5-4-2-payment-guard-upgrade-rollback.js`：需要 C5.4.2 原始（PAYMENT_GUARD 前）程式樹，工作區沒有，未執行。

C6 與 C6.1 的升級套件**有執行**（第 7 節），需要的 C5.4.2 與 C6 程式樹都在工作區。

## 7. 回歸

同一份 40 支清單（C6.1 報告的 36 支，加上 C6 與 C6.1 的 4 支）：
- 一次在**未修改 C6.1**、一次在**補修版候選 ZIP 全新解壓**上執行。
- 兩棵樹同時段平行執行（2026-11-18 約 16:53～17:45 台北時間）。
- **40 支結果逐項相同**（exit code 與結果行），既有測試與斷言未修改。

| 套件 | 未修改 C6.1 | 補修版 |
|---|---|---|
| C5.4.2 成立／台北時間 | 29／29 | 29／29 |
| PAYMENT_GUARD_TIME_MERGE_FIX | 22／22 | 22／22 |
| PAYMENT_RESPONSE_TIMING_FIX | 18／18 | 18／18 |
| C5.4.1 原驗收／TIMING_FIX | 19／19、11／11 | 相同 |
| C5.4 付款畫面／C5.3／C5.2／C5.1 | 27、25、33、61（全過） | 相同 |
| phase3／phase4b full、frontend、resume | 111、168、50、92（全過） | 相同 |
| 快閃前端、真實瀏覽器、public checkout、integration、recovery cart、state | 293、36、1447、20、67、94（全過） | 相同 |
| MBV2 匯出／合併／預覽 | 121／121 | 121／121 |
| C1 預購狀態 | 93／93 | 93／93 |
| **C3 販售狀態與需求** | **328／332（4 項失敗）** | **328／332（同 4 項）** |
| C3.1／C3.2／C3.3 | 54、32、30（全過） | 相同 |
| C4 手動通知、C4.1 去重續送、C4.2、C4.3、C4.4 | 94、40、80、34、20（全過） | 相同 |
| C4.5 日期同意、商品連結、LINE push 相容 | 55、42、12（全過） | 相同 |
| **C5 補貨轉換（預設時鐘）** | **41／42（1 項失敗）** | **41／42（同 1 項）** |
| C5 補貨轉換（`C4_CLOCK_OFFSET_MS=0`） | 42／42 | 42／42 |
| C6 原自動補貨通知 | 24／24 | 24／24 |
| C6 升級／回退 | 4／4 | 4／4 |
| C6.1 原新增驗收 | 29／29 | 29／29 |
| C6.1 升級／回退 | 11／11 | 11／11 |
| R48（單獨執行，見下） | 10／13 | 10／13（同 3 項） |
| **本輪新驗收** | **14／29** | **29／29** |
| **本輪升級／回退** | — | **7／7** |

### 7.1 既有失敗（與未修改 C6.1 逐項相同，不寫成全部通過）

1. **C3 販售狀態與需求，4 項**：`O1`、`O6-paused`、`O6-sold_out_indefinitely`、`O9`。
   - 失敗訊息為「此時段距離現在太近」（`time_too_early`）：今日訂單在預期的完售原因之前，就先被時段規則擋下。
   - 這支腳本使用真實時鐘，本次在台北 17:00 後執行。同一份 C6.1 程式於上午執行時為 332／332。
   - 兩棵樹在同一時段失敗的項目與訊息逐項相同，判定與執行時段有關、與本輪無關。
2. **C5 補貨轉換（預設時鐘），1 項**：`B1`（LIFF 導向後最終頁開啟商品）。指定 `C4_CLOCK_OFFSET_MS=0` 時兩棵樹都是 42／42。C6 報告已記載預設時鐘下的這項時段相依失敗。
3. **R48，3 項**：`R_TOUCH_TARGET_44`、`R_NO_STICKY_FIXED`、`R_FATAL`（`scrollIntoViewIfNeeded` 逾時）。
   - 與 C5.4.2、C6.1 報告記載相同；快閃前台本輪未修改。
   - 這支腳本在致命路徑上不還原 `console.log`，所以以應用程式外的 preload 同步寫出報告行，兩棵樹各單獨執行一次；腳本未修改。

補充：我曾嘗試以 `NODE_OPTIONS` 預載測試時鐘，把 C3／C5 固定在 10:30。但這會干擾其他項目（兩棵樹都產生不同的新失敗），所以**不採用為證據**，也不列為通過。

### 7.2 保留範圍確認

- 付款成立判定、付款操作防護、畫面時序修正、台北時間與 MBV2 時間標記合併政策：相關付款檔案與 C6.1 逐位元組相同，相關套件結果相同。
- 自動通知及商品參與的本地控制政策：`migrationV2.js` 未修改，MBV2 與 C6.1 升級套件結果相同。
- 不因初始化、重啟、匯入、退款或每日額度重設而建立自動通知事件：`restockAuto` 的觸發規則未修改，C6 原 24 項（含相關不觸發案例）結果相同。D1／D2 也驗證重啟不補發歷史 `skipped` 事件。

## 8. 檔案變更（相對未修改 C6.1）

- 產品修改 2：`utils/restockNotify.js`、`utils/restockAuto.js`。
- 測試新增 2：`scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release.js`、`scripts/smoke-r54-4-mbv2-hf1-c6-1-pause-claim-release-upgrade-rollback.js`。
- 既有測試修改 0、刪除 0。前端、付款、遷移、資料庫結構修改 0。
- 文件新增：`docs/R54_4_MBV2_HF1_C6_1_PAUSE_CLAIM_RELEASE_FIX/`（00、01、02）。既有文件全部保留。

## 9. 測試層級標示

- **RS（實際 SIGKILL）**：新驗收 D1（`process.kill('SIGKILL')`，確認 `signalCode==='SIGKILL'`，以同一資料庫檔重啟）。
- **FX（停機修改資料庫檔的 fixture）**：新驗收 D2。
- **API**：其餘新驗收案例；升級／回退以一般停止／啟動服務程序切換版本。
- **函式級**：本輪沒有。worker 例外出口未實測，見第 5 節。

## 10. 打包

### 10.1 流程
1. 從未修改 C6.1 解壓樹加上本輪變更組裝候選 ZIP。排除 `node_modules`、`.env`、資料庫、上傳、log、測試輸出；保留 `.env.example`。
2. 全新解壓 → `npm ci` → 空資料庫啟動，`/api/health` 回 `ok`，並出現開機恢復完成紀錄 → 新驗收、升級／回退、40 支回歸、R48。
3. 加入本輪文件後產生最終 ZIP，並與已測候選 ZIP 逐項比較（10.3）。

### 10.2 Manifest
- `02_FILE_MANIFEST.json` 列出最終套件所有檔案的大小與 SHA-256，包含先前各輪文件。
- 只排除本輪 `00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json` 三份自我參照文件。

## 11. 尚未執行

- **真實 LINE 營運驗收與真機驗收尚未執行**。本輪真實 LINE、LINE Pay、Sandbox 呼叫皆為 0。
- 所有結果都來自實際產品模組、檔案型 SQLite（sql.js）與模擬 LINE，不代表真實 LINE 行為。
- 「LINE 已受理」不代表顧客已收到或已讀。
- 未部署、未開啟正式自動通知；正式環境的測試掛勾維持預設停用（本輪未修改）。
