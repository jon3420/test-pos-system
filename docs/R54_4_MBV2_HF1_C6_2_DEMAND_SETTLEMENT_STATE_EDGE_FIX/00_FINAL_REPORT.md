# R54.4／MBV2-HF1-C6.2 登記份數狀態邊界修正 — 最終報告

本輪保留上一輪（持久化待辦、公平輪替、作廢原狀態保存）的全部成果，只修正三個已重現的狀態邊界問題：
- **A**：延遲綁定後已履約作廢，購買份數被忽略。
- **B**：補齊扣減前沒有檢查實際有效期限。
- **C**：原履約狀態缺失時被當成未履約。

未部署，未操作正式資料，未開啟正式自動通知，未進行 C6.3。真實 LINE、LINE Pay、Sandbox 呼叫皆為 0。

## 1. 基準

| 項目 | 核對結果 |
|---|---|
| 檔名 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_DURABLE_RECOVERY_FIX_APP_ROOT.zip` |
| SHA-256 | `7d5e1ec09748d7153378780e3c689c80994992c4a9ba6466d471d341b6588857`（相符） |
| 大小 | 10,734,732 bytes（相符） |
| 檔案數 | 1,069（相符） |
| ZIP 項目 | 1,128（相符） |
| Manifest | 1,066 筆，逐筆雜湊相符 |

工作方式：
- 建立未修改基準樹與隔離工作樹，各自執行 `npm ci`。
- 新驗收腳本與測試替身以相同內容放入兩個樹執行。這些都是測試檔，基準的產品程式沒有任何修改。

## 2. 三個基準重現（新驗收：同一腳本、同一組斷言）

腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-2-state-edge-fix.js`，31 項。

| 版本 | 結果 |
|---|---|
| 未修改基準 | **12 通過、19 失敗** |
| 修正版工作樹 | 31 通過、0 失敗 |
| 全新解壓候選版（回歸清單內） | 31 通過、0 失敗 |

基準的 19 項失敗：
- 全部是本輪修正項目（N）。
- 全部是份數、關聯狀態或待辦結果的業務斷言，**0 項例外**，沒有任何一項是「新函式不存在」造成的。
- 12 項保留既有行為（G）在基準全部通過。

| 編號 | 層級 | 未修改基準（實際） | 修正版（實際） |
|---|---|---|---|
| A1 現金延遲綁定 → 履約 → 作廢 → 補齊 | API＋DB | 已完成 0、顧客端尚待購買 5；關聯 `released`／0／`void_after_completed`；兩個待辦都是 done | 已完成 3、尚待購買 2；關聯 `review`／3；作廢待辦 result `review:void_after_completed` |
| A2 LINE Pay 已付款（正式模擬付款） | API＋DB | 後端 paid，但已完成 0、尚待購買 5，關聯 `released` | 已完成 3、尚待購買 2、`review`；Confirm 1 次 |
| A3 LINE Pay 待付款＋履約＋作廢 | API＋DB | 已完成 0，關聯 `released`，看不出需核對 | 已完成 0，關聯 `review`、note `void_after_completed:payment_unconfirmed` |
| A5 多商品部分延遲 | API＋DB | 準時綁定商品 2（`review`）；延遲商品 0（`released`） | 2／3，皆 `review`，不重複扣減 |
| A6 重複 callback、重啟兩次 | API＋RS＋DB | 已完成仍 0 | 維持 3；Confirm 2→2、事件 2→2、通知 0→0 |
| B1 自然到期、status 仍 active | FX-DB＋DB | **扣 3** | 扣 0，note `cycle_closed:expired_at`；資料列 status 不變 |
| B3 到期邊界（TZ=UTC） | FX-DB＋TZ | 到期前扣 3；**剛過期仍扣 3** | 到期前 3、剛過期 0 |
| B3 到期邊界（TZ=Asia/Taipei） | FX-DB＋TZ | 同上，剛過期仍扣 3 | 到期前 3、剛過期 0 |
| B5 期限無法解析 | FX-DB＋DB | 扣 3 | 扣 0，`review`，`cycle_validity_unknown` |
| C1 原狀態 NULL | FX-DB＋API | **回復 3→0**，`reverted`，待辦 `cancel` | 保留 3，`review`，`void_prior_state_missing` |
| C2 原狀態空字串 | FX-DB＋API | 回復 3→0 | 保留 3，`review`，`void_prior_state_missing` |
| C3 原狀態不合法（`shipped_x`） | FX-DB＋API | 回復 3→0 | 保留 3，`review`，`void_prior_state_invalid` |
| C9 原狀態 NULL＋作廢提交後真實 SIGKILL | FX-DB＋KILL | 重啟後回復 3→0 | 重啟後保留 3、`review`；再次重啟不變 |
| H1 歷史 A 型（現金） | FX-DB＋RS | 維持 0，`released` | 啟動時依證據補記 3，`review`，`…:legacy_repaired`；再重啟不變 |
| H2 歷史 C 型（空白原狀態已回復） | FX-DB | 沒有任何可查標記 | 份數不改；關聯 note 與待辦 result 標 `legacy_review:void_prior_state_missing` |
| K1 綁定交易提交後、同步前真實 SIGKILL | KILL＋RS | 重啟後 `released`、0 | 重啟後 3、`review`、作廢待辦 done |
| K2 補記交易提交前保存失敗 | FAULT＋DB | （基準沒有此交易，故障點不存在）最後 `released`、0 | 故障期間扣 0、關聯 `reserved`、作廢待辦 pending（整筆回滾）；解除後 3、`review` |
| K3 補記交易提交前真實 SIGKILL | KILL＋RS | （基準沒有此停點，未中斷）最後 `released`、0 | 磁碟上扣 0、`reserved`、待辦 pending；重啟後 3、`review` |
| K4 綁定未完成、作廢提交後真實 SIGKILL | KILL＋RS | 重啟後 0 | 重啟後 3、`review` |

基準也通過的 G 項：A3-2、A4、B2、B2-2、B4、C4、C5、C6、C7、C8、H3、Z1（逐項見第 8 節）。

### 測試層級標示

| 標示 | 意義 |
|---|---|
| `[API]` | 正式 HTTP 路由：顧客登記與下單、LINE Pay request／confirm、店家改狀態、作廢、取消登記 |
| `[DB]` | 直接讀資料庫檔核對份數、關聯與待辦 |
| `[FX-DB]` | 停機後以資料庫夾具改寫：期限、NULL／空字串／不合法原狀態、`status`／`order_status` 組合、歷史錯誤終態 |
| `[KILL]` | 真實 `SIGKILL`：測試 preload 在停點呼叫 `process.kill(pid,'SIGKILL')`，同一資料庫重啟 |
| `[FAULT]` | 測試 preload 注入的保存失敗（交易內拋出例外） |
| `[RS]` | 一般停機重啟 |
| `[TZ]` | 以 `TZ=UTC`／`TZ=Asia/Taipei` 啟動伺服器 |

- 本輪沒有函式級或瀏覽器驗收項目；夾具案例都標示 `[FX-DB]`，不視為正式 API。
- 故障注入只使用測試 preload `scripts/lib/c62r-fault.js`，本輪新增三個停點（見第 7 節）。正式程式沒有新增任何可觸發故障或改寫狀態的端點或旗標。

## 3. 狀態對照表

實作前訂定。即時 hook、啟動補齊、定期補齊共用同一套判斷。
### 3.1 判斷順序（每個訂單商品關聯各自判斷）

1. **證據**：綁定只使用待辦保存的店別、已驗證會員、原訂單 UUID、商品、原登記 `request_uuid`、份數。
   - 訂單不存在 → 待辦 `review`（`order_missing`），不建立關聯。
   - 不重新尋找最新 active 登記。
2. **作廢前履約狀態**：只採用作廢交易內保存的作廢待辦，並先分類（第 3 節）。
3. **購買證據**：非 LINE Pay 有效訂單，或 LINE Pay 且後端 `payment_status='paid'`。
   - 履約欄位、紀錄狀態都不能當作付款證據。
4. **原週期有效性**：只有在**新增扣減**的那一刻，於同一 durable 交易內核對（第 2 節）。

### 3.2 原週期有效性（只影響「新增扣減」）

| 原週期 | 新增扣減 | 關聯結果 |
|---|---|---|
| `active`／`completed` 且 `julianday(expires_at) > julianday('now')` | 依剩餘份數扣減 | `settled` |
| `active` 但 `expires_at` 已過（自然到期，尚未被改成 expired） | **0** | `settled`，`applied_qty=0`，note `cycle_closed:expired_at` |
| `expired`／`cancelled` | 0 | `settled`，`applied_qty=0`，note `cycle_closed:<status>` |
| `expires_at` 為 NULL、空白或無法解析 | 0 | **`review`**，`applied_qty=0`，note `cycle_validity_unknown` |
| 週期不存在 | 0 | `settled`，`applied_qty=0`，note `cycle_missing` |

補充規則：
- 新增扣減不會移到新週期，也不會讓已過期或已取消的週期復活。
- **既有已完成份數**（已 `settled` 的關聯）不重新判斷期限：
  - 週期之後到期、重試、重啟、補齊，都不清除也不重複回復。
  - 只有訂單取消或作廢的規則會回復這些份數。
- 期限一律以資料庫的 UTC 字串與 SQLite `julianday('now')` 比較，與既有 `expires_at > datetime('now')` 同一時間基準，不受主機 TZ 影響。

### 3.3 作廢前履約狀態分類（共用 `classifyVoidPrior`）

正式流程允許的值（`utils/orderStatusFlow.js` `ORDER_STATUSES`）：

| 分類 | 值 | 作廢時 |
|---|---|---|
| 已履約 | `completed` | 待核對（`void_after_completed`），不自動回復 |
| 有充分證據的未履約 | `pending`、`accepted`、`preparing`、`ready`、`delivering` | 依原扣減回復一次 |
| 已取消 | `cancelled` | 與取消規則相同（取消時已處理者不再處理；未處理者依原扣減回復一次） |
| 未知或不合法 | NULL、空字串、其他值、沒有作廢待辦 | 待核對（`void_prior_state_missing`／`void_prior_state_invalid`／`void_prior_state_unknown`），**不自動回復** |

補充：
- 判斷只看 `order_status`（履約流程），不看 `orders.status`（紀錄狀態），也不看付款狀態。
- `status='completed'` 配 `order_status='accepted'` 判為未履約。

### 3.4 有效週期下的訂單狀態 × 綁定時點

綁定時點的兩種情況：
- **準時綁定**：訂單交易內完成綁定。
- **延遲綁定**：綁定故障，由待辦稍後補齊。

原則：**延遲綁定的最終結果，必須與準時綁定再經過相同事件的結果一致。**

| 訂單狀態 | 準時綁定 | 延遲綁定（修正後） |
|---|---|---|
| 現金等有效訂單 | `settled` | `settled` |
| LINE Pay 待付款（付款請求仍有效） | `reserved` | `reserved` |
| LINE Pay 已付款（後端確認） | `settled` | `settled` |
| LINE Pay 付款失敗或逾期 | `released` | `released` |
| LINE Pay 付款待核對（confirm_pending／review） | `reserved` | `reserved`（不推定已付款） |
| 未履約取消／作廢 | 已扣減 → `reverted`（回復一次）；訂購中 → `released` | 從未扣減 → `released`（不回復、不多扣） |
| 已履約作廢＋購買證據 | 已扣減 → `review`（保留份數） | **先依原週期扣減，再轉 `review`**（保留份數；週期若已過期或取消則扣 0） |
| 已履約作廢、LINE Pay 未付款或付款不明 | 訂購中 → `review`（扣 0，note `…:payment_unconfirmed`） | 同左，不扣減 |
| 作廢前狀態未知（含 NULL、空字串、不合法、沒有待辦） | 已扣減 → `review`（保留） | 有購買證據：先扣再 `review`；沒有：`review`（扣 0） |

### 3.5 待辦結果可追查

- **綁定待辦**：`done`（`linked`／`link_exists`），或 `review`（`order_missing`）。
- **作廢待辦**：`done`，result 記錄實際動作：
  - `cancel`
  - `review:void_after_completed`
  - `review:void_prior_state_missing`
  - 依此類推
- 業務結果以關聯的 `state`、`applied_qty`、`note` 表達。
- 後台登記明細同時列出關聯與待辦。

## 4. 根本原因

| 缺口 | 根本原因 |
|---|---|
| A | `syncOrder()` 只依訂單「最後狀態」決定動作。作廢時一律走 `review_void`，而 `review_void` 對 `reserved` 關聯只做 `release`。延遲綁定時，`_applyTaskRaw()` 先建立 `reserved` 關聯，訂單此時早已作廢，所以「訂單成立（或已付款）時就應扣減」這個事實被跳過。兩個待辦又都被標成 done，結果看似完成，份數卻是錯的。 |
| B | `settleRaw()` 只檢查 `status IN ('active','completed')`。過期判斷在其他地方是惰性的（顧客重新登記時才把舊週期改成 expired；查詢時以 `EFFECTIVE_STATUS_SQL` 計算），所以自然到期、尚未被其他操作改寫的週期仍會被扣減。 |
| C | `syncOrder()` 以 `prior_order_status === 'completed' ? 'completed' : 'open'` 判斷，NULL、空字串與任何不合法值都被當成「已證明未履約」，因而自動回復。 |

## 5. 修改檔案與交易邊界

### 5.1 產品檔（1 支修改、0 支新增、0 結構變更）

`utils/demandSettlement.js` 新增或修改：

| 項目 | 內容 |
|---|---|
| `cycleValidity()` | 新增。用 `julianday(expires_at)` 與 `julianday('now')` 判斷 valid／expired／unknown |
| `settleRaw()` | 新增扣減前核對有效性。到期扣 0；無法判斷 → `review`、扣 0 |
| `classifyVoidPrior()` | 新增。作廢前履約狀態的唯一分類，合法值取自 `orderStatusFlow.ORDER_STATUSES` |
| `hasPurchaseEvidence()` | 新增。購買證據判斷 |
| `targetFor()` | void 改用分類結果；`review_void` 帶出購買證據 |
| `_voidSettleRaw()` | 新增。補記扣減後轉 `review`，同一交易內完成 |
| `unconfirmedReviewRaw()` | 新增。扣 0 並轉 `review` |
| `syncOrder()` | `review_void` 也處理 `reserved`／`released` 關聯；作廢待辦 result 改為 `review:<原因>`／`cancel`／`no_links` |
| `repairLegacy()` | 新增。歷史錯誤終態處理，由啟動補齊呼叫 |
| 匯出 | 新增匯出上述函式（測試替身與回歸需要） |

以下檔案都**未修改**：
- `routes/orders.js`、`routes/line-orders.js`、`routes/linepay.js`、`utils/orderStatusFlow.js`
- `utils/migrationV2.js`、`server.js`、`.env.example`
- 付款判定、通知系統

### 5.2 測試檔

| 檔案 | 狀態 |
|---|---|
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-state-edge-fix.js` | 新增：31 項 |
| `scripts/smoke-r54-4-mbv2-hf1-c6-2-state-edge-upgrade-rollback.js` | 新增：同一資料庫 DURABLE → 本輪 → DURABLE → 本輪，6 項 |
| `scripts/lib/c62r-fault.js` | 修改：新增 `killBeforeSyncOrder`、`voidSettleFail`、`killInVoidSettle` 三個停點；原有停點不變 |

既有測試沒有修改或放寬（第 9 節）。

### 5.3 交易邊界

都沿用既有 durable 交易，沒有新增交易：

| 流程 | 交易 | 本輪內容 |
|---|---|---|
| 新增扣減（`settleRaw`） | 呼叫端的 durable 交易：下單、`syncOrder`、補齊 | 同一交易內先讀原週期與 `julianday`，再以 `state IN ('reserved','released')` 為條件轉換、扣減 |
| 作廢後同步（即時 hook、啟動、定期） | `syncOrder` 的 durable 交易 | 把作廢待辦標為 done（result 寫實際動作），並依分類對每個關聯執行。例如 `_voidSettleRaw`：扣減＋轉 review。任一步失敗整筆回滾，作廢待辦維持 pending（K2、K3 已驗證） |
| 延遲綁定 | `processOrderTasks`：綁定交易 → `syncOrder` 交易 | 綁定交易提交後、同步前中斷：關聯 `reserved`、作廢待辦 pending。之後由 `task` 與 `reserved` 兩類補齊接手（K1 已驗證） |
| 歷史處理（`repairLegacy`） | 每筆關聯各自一個 durable 交易 | 交易內重新讀取並確認仍符合條件才處理（可重複執行） |

## 6. 歷史錯誤終態的處理政策

依據：只依可信證據；證據不足者列為待核對；不無差別回溯。

| 類型 | 識別條件（全部成立） | 處理 |
|---|---|---|
| A 型：已履約作廢、延遲綁定未扣減 | 關聯 `released`；`applied_qty=0`；note 恰為 `void_after_completed`；訂單 `status='void'`；作廢待辦 done 且保存的原狀態為 `completed`；同一訂單、同一商品、同一 `request_uuid` 的綁定待辦 done | 有購買證據（現金，或後端 paid）→ 依原週期補記扣減（含有效性核對）並轉 `review`，note `…:legacy_repaired`。沒有購買證據 → `review`、扣 0，note `void_after_completed:payment_unconfirmed:legacy_review` |
| C 型：原狀態缺失卻被回復 | 關聯 `reverted`；note 以 `order_cancelled` 開頭；訂單已作廢；最新作廢待辦的原狀態為 NULL、空字串或不合法 | **不改份數**（當時的回復同樣缺乏證據，無法判斷正確份數）。關聯 note 加 `:legacy_review:<原因>`，作廢待辦 result 改為 `legacy_review:<原因>`，交由人工核對 |
| B 型：自然到期後仍被扣減 | — | **不處理**。已扣減的歷史份數依規則保留。基準無法區分「到期前已扣」與「到期後才扣」，沒有可信證據 |
| 其他 | 沒有作廢待辦的歷史作廢、上一輪之前就是 review 的資料 | 不回溯 |

執行時機與驗證：
- 每次啟動補齊執行；選取條件會排除已處理者，因此可重複執行。
- 驗證：
  - 新驗收 H1、H2、H3（夾具）。
  - 升級測試 V1、V4：由 DURABLE_RECOVERY_FIX 程式**實際產生**的錯誤終態。

## 7. 真實 SIGKILL 與保存失敗停點

| 案例 | 停點 | 中斷後磁碟狀態 | 同一資料庫重啟後 |
|---|---|---|---|
| C9 | 作廢交易已提交、作廢後同步前（原狀態 NULL） | 訂單已作廢、仍 3 | `review`、保留 3；再次重啟不變 |
| K1 | 延遲綁定交易已提交（關聯 `reserved`、綁定待辦 done）、`syncOrder` 前 | 扣 0，作廢待辦 pending（沒有錯誤完成的待辦） | 補記 3、`review`、作廢待辦 done；再次重啟不變 |
| K2（保存失敗） | `_voidSettleRaw` 已扣減、同一交易提交前拋出例外 | 整筆回滾：扣 0、`reserved`、作廢待辦 pending | 解除後補記 3、`review` |
| K3 | `_voidSettleRaw` 已扣減（記憶體中）、交易提交前 SIGKILL | 扣 0、`reserved`、作廢待辦 pending（沒有半套） | 補記 3、`review` |
| K4 | 綁定待辦未完成、已履約作廢交易提交後 SIGKILL | 訂單已作廢、綁定與作廢待辦都 pending | 補記 3、`review` |

說明：
- 停點由測試 preload 在對應函式的前後呼叫 `process.kill(pid,'SIGKILL')`，伺服器確實以 `SIGKILL` 結束（測試核對 signal）。
- 基準沒有 `_voidSettleRaw`，所以 K2、K3 的停點在基準不存在：K3 在基準沒有中斷，K2 沒有注入。兩者在基準的失敗都來自最終份數。

## 8. 新驗收與回歸結果

### 8.1 執行方式

- **候選版組成**：未修改基準全新解壓，加上 4 支本輪檔案（1 支產品檔、3 支測試檔），執行 `npm ci`。
- **空資料庫啟動**：兩版都是 246 個物件，結構雜湊 `14c0f17e16256a3b` 相同，health 正常。
- **執行清單**：兩版使用相同清單；候選版另加 1 支只能在候選版執行的升級測試。
- **時段**：候選版 2026-11-20 22:10～23:14（台北），基準 23:15～11-21 00:25（台北）；依序執行（2 核心，不平行）。基準執行跨過台北午夜
- **測試時鐘**：預設台北 10:30（`C4_CLOCK_OFFSET_MS` 自動計算）。

### 8.2 逐支比較

| 腳本 | 環境 | 未修改基準 | 候選版 | 比較 |
|---|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c6-2-state-edge-fix.js` | — | 結果：12 通過、19 失敗 | 結果：31 通過、0 失敗 | 差異：本輪新驗收：基準 19 項失敗即重現案例（全部為業務斷言，0 項例外） |
| `smoke-r54-4-mbv2-hf1-c6-2-state-edge-upgrade-rollback.js` | C62S_OLD_ROOT=base | （未執行） | 結果：6 通過、0 失敗 | 差異：只在候選版執行（需要 DURABLE_RECOVERY_FIX 作為舊版根目錄） |
| `smoke-r54-4-mbv2-hf1-c6-2-demand-cart-order-settlement.js` | — | 結果：44 通過、0 失敗 | 結果：44 通過、0 失敗 | 相同 |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-upgrade-rollback.js` | C62R_OLD_ROOT=base | 結果：6 通過、0 失敗 | 結果：6 通過、0 失敗 | 相同：上一輪同一資料庫升級／回退：原 C6.2 ↔ 受測版 |
| `smoke-r54-4-mbv2-hf1-c6-2-durable-recovery-fix.js` | — | 結果：22 通過、0 失敗 | 結果：22 通過、0 失敗 | 相同：上一輪新驗收 22 項（含公平輪替：超過 200 筆、多店別、單筆故障、中斷後續行） |
| `smoke-r54-4-mbv2-hf1-c6-2-upgrade-rollback.js` | C62_OLD_ROOT=c61 | 結果：9 通過、0 失敗 | 結果：9 通過、0 失敗 | 相同：C6.1 → C6.2 升級／回退（舊樹：C6.1 timing-fix 全新解壓） |
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
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | — | RESULT: 250 passed, 4 failed | RESULT: 250 passed, 4 failed | 相同：O1、O6×2、O9：以今日 12:00 取餐、執行時已過台北 12:00 的既有時鐘相依失敗；夜間執行時部分區段不執行，總數 254（下午為 332），兩版相同 |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | — | RESULT: 53 passed, 1 failed | RESULT: 54 passed, 0 failed | 差異：清單內基準 M4-1 單次失敗（明細值皆符合：隱藏、訂單 403，屬瀏覽器時序）；同時段成對重跑兩版皆 54/54（第 8.4 節） |
| `smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` | — | RESULT: 32 passed, 0 failed | RESULT: 32 passed, 0 failed | 相同 |
| `smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | — | RESULT: 24 passed, 6 failed | RESULT: 30 passed, 0 failed | 差異：清單內基準執行跨過台北午夜（K3 系列：「請選擇時間」，當下無取餐時段）24/30；同時段成對重跑兩版皆 30/30（第 8.4 節） |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | — | RESULT: 41 passed, 1 failed | RESULT: 41 passed, 1 failed | 相同：預設時鐘 B1 為既有時鐘相依失敗；C4_CLOCK_OFFSET_MS=0 時 42/42；兩版相同 |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js` | C4_CLOCK_OFFSET_MS=0 | RESULT: 42 passed, 0 failed | RESULT: 42 passed, 0 failed | 相同：預設時鐘 B1 為既有時鐘相依失敗；C4_CLOCK_OFFSET_MS=0 時 42/42；兩版相同 |
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
| `smoke-r48-popup-order-ui-browser.js` | — | exit 1 | exit 1 | 相同：清單內執行沒有結果行（腳本替換 console.log）；另以 preload 單獨執行（第 8.3 節） |
| `smoke-r54-4-mbv2-system-regression.js` | — | exit 0 | exit 0 | 相同：輸出沒有計數行；以 exit code 比較 |
| `smoke-r54-4-mbv2-large-upload.js` | — | RESULT: 25 passed, 0 failed | RESULT: 24 passed, 1 failed | 差異：清單內候選版 L8（256MB+1 byte 應回 413）單次失敗（與本輪修改無關的上傳上限路徑）；同時段成對重跑兩版皆 25/25（第 8.4 節） |

**結果**：兩版都執行的 48 支中，44 支的 exit 代碼、通過／失敗數與失敗項目完全相同。其餘 4 支：

1. **本輪新驗收**：基準 12／31，候選版 31／31（預期差異）。
2. **三支單次差異，同時段成對重跑後兩版相同**（第 8.4 節）：
   - c3-1：基準單次失敗（瀏覽器時序）。
   - c3-3：基準跨過午夜。
   - large-upload L8：候選版單次失敗。

本輪升級測試只在候選版執行，6／6。

**新增失敗：0。既有測試沒有修改或放寬任何斷言。**

### 8.3 R48 單獨執行（應用程式外 preload 擷取結果行；台北 11-21 00:4x）

| 版本 | 結果 | 失敗項目 |
|---|---|---|
| 未修改基準 | R48 SMOKE SUMMARY — PASS: 9  FAIL: 4  TOTAL: 13 | R_FIXTURE_STATES、R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL |
| 候選版 | R48 SMOKE SUMMARY — PASS: 9  FAIL: 4  TOTAL: 13 | R_FIXTURE_STATES、R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL |

- 兩版相同。
- 上一輪下午執行為 10／13（沒有 `R_FIXTURE_STATES`）。本次在午夜後執行，營業狀態夾具與時段相關，兩版同樣多 1 項失敗。

### 8.4 單次差異的同時段成對重跑（台北 11-21 00:25～00:40，候選版與基準依序）

| 腳本 | 清單內（基準／候選版） | 重跑：候選版 | 重跑：基準 |
|---|---|---|---|
| `smoke-r54-4-mbv2-large-upload.js` | RESULT: 25 passed, 0 failed／RESULT: 24 passed, 1 failed | RESULT: 25 passed, 0 failed | RESULT: 25 passed, 0 failed |
| `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` | RESULT: 53 passed, 1 failed／RESULT: 54 passed, 0 failed | RESULT: 54 passed, 0 failed | RESULT: 54 passed, 0 failed |
| `smoke-r54-4-mbv2-hf1-c3-3-restore-cancel.js` | RESULT: 24 passed, 6 failed／RESULT: 30 passed, 0 failed | RESULT: 30 passed, 0 failed | RESULT: 30 passed, 0 failed |

large-upload L8 測的是遷移上傳上限（`MIGRATION_UPLOAD_LIMIT_MB`），與本輪唯一修改的 `utils/demandSettlement.js` 沒有程式路徑交集。

### 8.5 時鐘相依與既有失敗（實際結果，不算全部通過）

| 腳本 | 項目 | 基準 | 候選版 | 原因 |
|---|---|---|---|---|
| `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` | O1、O6-paused、O6-sold_out_indefinitely、O9 | 250／254 | 250／254 | 測試以今日 12:00 取餐，執行時已過；夜間執行時部分區段不執行（下午為 332 項） |
| `smoke-r54-4-mbv2-hf1-c5-restock-conversion.js`（預設時鐘） | B1 | 41／42 | 41／42 | 時鐘相依；`C4_CLOCK_OFFSET_MS=0` 時兩版 42／42 |
| `smoke-r48-popup-order-ui-browser.js` | R_FIXTURE_STATES、R_TOUCH_TARGET_44、R_NO_STICKY_FIXED、R_FATAL | 9／13 | 9／13 | 既有；R_FIXTURE_STATES 與執行時段相關 |

### 8.6 涵蓋範圍對照

| 規格要求 | 腳本 | 候選版 |
|---|---|---|
| 上一輪 durable recovery 新驗收 22 項（含公平輪替：超過 200 筆、多店別、單筆故障、中斷後續行） | durable-recovery-fix | 22／22 |
| C6.2 主驗收 44 項（含 A19、A19-2） | demand-cart-order-settlement | 44／44 |
| 上一輪同一資料庫升級／回退 6 項 | durable-recovery-upgrade-rollback | 6／6 |
| C6.1 → C6.2 升級／回退 9 項 | c6-2-upgrade-rollback（舊樹：C6.1 timing-fix） | 9／9 |
| 列表 UI 40、時序補修 28 | c6-1-restock-list-auto-toggle-ui、c6-1-restock-list-ui-timing-fix | 40／40、28／28 |
| C6、C6.1、PAUSE_CLAIM_RELEASE_FIX | c6-auto-restock、c6-1-auto-guard-recovery、c6-1-pause-claim-release | 24／24、29／29、29／29 |
| 一般 LINE 結帳 | phase3 checkout（111）、popup public checkout（1447）、checkout integration（20） | 全部通過 |
| 付款恢復、付款防重 | c5-2-payment-recovery（33）、phase4b recovery（168／50／92）、c5-3 payment-guard（25）、c5-4-2 三支、c5-4-1 兩支、c5-4 | 全部通過 |
| 取消、作廢 | 本輪 A4、C4～C9、c5-1-consistency（61） | 全部通過 |
| MBV2 匯出、合併、完整取代、預覽回滾 | mbv2-migration（121）、c3-1（54）、c3-2（32）、c3-3（30）、large-upload（25）、system-regression（exit 0） | 全部通過（c3-3、large-upload 依第 8.4 節） |

### 8.7 新驗收逐項（候選版全新解壓：31／31）

| 編號 | 分類 | 基準 | 修正版 | 候選版 |
|---|---|---|---|---|
| A1 | N | 失敗 | 通過 | 通過 |
| A2 | N | 失敗 | 通過 | 通過 |
| A3 | N | 失敗 | 通過 | 通過 |
| A3-2 | G | 通過 | 通過 | 通過 |
| A4 | G | 通過 | 通過 | 通過 |
| A5 | N | 失敗 | 通過 | 通過 |
| A6 | N | 失敗 | 通過 | 通過 |
| B1 | N | 失敗 | 通過 | 通過 |
| B2 | G | 通過 | 通過 | 通過 |
| B2-2 | G | 通過 | 通過 | 通過 |
| B3-UTC | N | 失敗 | 通過 | 通過 |
| B3-Asia/Taipei | N | 失敗 | 通過 | 通過 |
| B4 | G | 通過 | 通過 | 通過 |
| B5 | N | 失敗 | 通過 | 通過 |
| C1 | N | 失敗 | 通過 | 通過 |
| C2 | N | 失敗 | 通過 | 通過 |
| C3 | N | 失敗 | 通過 | 通過 |
| C4 | G | 通過 | 通過 | 通過 |
| C5 | G | 通過 | 通過 | 通過 |
| C6 | G | 通過 | 通過 | 通過 |
| C7 | G | 通過 | 通過 | 通過 |
| C8 | G | 通過 | 通過 | 通過 |
| C9 | N | 失敗 | 通過 | 通過 |
| H1 | N | 失敗 | 通過 | 通過 |
| H2 | N | 失敗 | 通過 | 通過 |
| H3 | G | 通過 | 通過 | 通過 |
| K1 | N | 失敗 | 通過 | 通過 |
| K2 | N | 失敗 | 通過 | 通過 |
| K3 | N | 失敗 | 通過 | 通過 |
| K4 | N | 失敗 | 通過 | 通過 |
| Z1 | G | 通過 | 通過 | 通過 |

### 8.8 同一資料庫升級／回退（DURABLE_RECOVERY_FIX → 本輪 → 回退 → 再升級）：6／6

| 步驟 | 結果 |
|---|---|
| V0 舊版產生的資料 | 由 DURABLE_RECOVERY_FIX **實際執行**產生 A 型（延遲綁定＋已履約作廢 → `released`、0）與 C 型（原狀態 NULL → 回復）；另有現金扣減 2／5、LINE Pay 付款扣減 3／4、通知批次 1 筆、逐筆受理 2 筆 |
| V1 升級 | A 型依證據補記 3、`review`、`legacy_repaired`；C 型標記 `legacy_review`、份數不改；其他份數、訂單、付款、通知批次、逐筆紀錄與 retry key 完全相同；結構雜湊與舊版相同（沒有結構變更） |
| V2 修正版運作 | 同樣的交錯直接得到 3、`review` |
| V3 回退 | 已修正的份數保留（3、3）。回退期間缺口重新出現（如實呈現）：延遲綁定＋已履約作廢又得到 0；自然到期仍扣 3 |
| V4 再升級 | 回退期間的 A 型依證據補記 3；回退期間已扣減的到期份數保留（不清除、不回復）；訂單、付款、通知紀錄不變；結構相同 |
| V5 再次重啟 | 7 個登記的份數都不重複扣減或回復；無待處理待辦；retry key 與最初相同；真實 LINE 0 |

游標：升級與回退都沿用同一張 `product_demand_sweep_cursors`，沒有清除或重設。V1 的明細記錄前後筆數。

## 9. 既有斷言調整

**無。** 本輪沒有修改任何既有測試或斷言。

`scripts/lib/c62r-fault.js` 只新增停點，原有停點的行為不變；上一輪 22 項與 C6.2 主驗收 44 項仍全部通過。

## 10. 未測項目與限制

1. **真正的「自然經過時間」到期**：以 `[FX-DB]` 把 `expires_at` 改成過去時間代替，沒有讓測試等待真實天數。
   - 判定使用與正式相同的 `julianday('now')`。
   - B3 以伺服器 `TZ=UTC` 與 `TZ=Asia/Taipei` 各驗證到期前後。
2. **NULL、空字串、不合法的 `order_status`**：正式流程無法產生，以夾具建立（C1～C3、C9）。
3. **B 型歷史資料不處理**：基準在自然到期後仍扣減的份數，無法區分扣減發生在到期前或到期後，依「已完成歷史不因期限清除」保留，需要時人工核對。
4. **C 型歷史資料只標記、不改份數**：當時的回復缺乏證據，無法判斷正確份數。
5. **作廢以外的取消路徑未改**（本輪範圍外，未修改這些路由）：
   - 店家取消（`applyOrderStatusChange`）只允許 `isCancellable` 的狀態；`order_status` 為 NULL 時，既有規則視為可取消並依取消規則回復。
   - 宅配狀態路由（`routes/line-shipping.js`）可以直接把 `order_status` 設為 `cancelled`，且不觸發份數同步。這種訂單之後作廢時，原狀態為 `cancelled`，依取消規則處理。
6. **退款**：已履約後退款仍不處理（沿用 C6.2 規則）。
7. **瀏覽器**：本輪新驗收沒有瀏覽器案例；份數顯示以會員 `/api/product-demand/mine`（正式 API）核對。
8. **回退期間的缺口**：回退到 DURABLE_RECOVERY_FIX 期間，三個缺口都會重新出現（第 03 文件第 6 節）。

## 11. 交付與打包

- **組成**：由未修改基準全新解壓，加上 4 支本輪檔案。
  - 執行 `npm ci`、空資料庫啟動，並以這個樹完成新驗收、升級測試與完整回歸。
- **最終 ZIP**：再次全新解壓基準，加入同樣 4 支檔案與本輪文件夾。打包後解壓，與已測候選版逐檔比對：除了本輪文件夾完全相同。
- **根目錄**：直接有 `server.js`、`package.json`，保留 `.env.example` 及既有各輪文件。
- **不含**：`.env`、資料庫、`node_modules`、上傳資料、log、測試輸出或真實憑證。
- **套件內文件**：`docs/R54_4_MBV2_HF1_C6_2_DEMAND_SETTLEMENT_STATE_EDGE_FIX/`
  - `00_FINAL_REPORT.md`
  - `01_TEST_RESULTS.json`
  - `02_FILE_MANIFEST.json`
  - `03_OPS_ROLLBACK_GUIDE.md`
  - `04_STATE_TABLE.md`
- **ZIP 雜湊**：本文件位於 ZIP 內，無法記載 ZIP 自身的雜湊；見交付訊息與套件外報告文末。

## 12. 外部呼叫次數

| 對象 | 次數 |
|---|---|
| 真實 LINE Messaging API | 0 |
| 真實 LINE Pay | 0 |
| LINE Pay Sandbox | 0 |
| 補齊與歷史處理發出的通知或外部呼叫 | 0（Z1：通知批次與逐筆紀錄 0 → 0） |
| 本輪新驗收的 LINE Pay 替身（程序內攔截） | 共 6 次：Request 3（A2、A3、A3-2）、Confirm 2（A2 成功、A3-2 回 9000）、付款查詢 1（既有恢復流程查詢 A3-2 待核對的付款）。A6 的重複 callback 沒有再送 Confirm（2 → 2） |

## 13. 本輪停止

已完成交付，等待審核。未部署，未開啟正式通知，未進行 C6.3。
