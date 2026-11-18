# R54.4／MBV2-HF1-C6.1 最終報告：自動補貨通知防護與中斷恢復補修

> 交付套件的 SHA-256 無法寫在 ZIP 內，請見交付訊息與套件外的 `R54_4_MBV2_HF1_C6_1_FINAL_REPORT.md`（內容與本文件相同，另加第 9.3 節最終雜湊）。
> 本輪**未部署、未操作正式資料**。真實 LINE Messaging API、LINE Pay 與 Sandbox 呼叫皆為 **0**。
> **自動通知交付時預設關閉**，商品預設不參與。

## 0. 摘要

- **主基準**：最新 C5.4.2（PAYMENT_RESPONSE_TIMING_FIX）。工作樹以它建立。
- **功能來源**：C6。依 C6 相對共同祖先 C5.4 的變更整合，沒有以 C6 整包覆蓋。
- **三個已重現的缺口全部修正**。同一份新驗收在兩個版本的結果：

  | 版本 | 通過 | 失敗 | 不適用 |
  |---|---|---|---|
  | 未修改 C6 | 9 | 11 | 7 |
  | C6.1 | 29 | 0 | 0 |

  - C6 的 7 項不適用，是需要 C6.1 測試掛勾的 SIGKILL 精確停點案例。
  - 缺口 A：關閉再開啟後，舊批次仍跨越新舊 epoch 繼續送出。
  - 缺口 B：商品退出（或退出後又加入）自動通知後，仍送出後續通知。
  - 缺口 C：預覽已保存、確認前重啟後，通知遺失，事件卻顯示已完成。
- **回歸**：既有測試與斷言一項都沒有修改。
  - C5.4.2 與 C6.1 跑同一份 36 支清單，結果逐項相同。
  - C6 與 C6.1 跑 C6 原套件與補貨回歸 15 支，結果逐項相同。
  - R48 在兩棵樹都是既有的 3 項失敗，逐行相同（第 6.3 節）。
- **升級／回退**：以同一個資料庫檔在三種版本間切換，11／11 通過。路徑包括：最新 C5.4.2 → C6.1、舊 C6 → C6.1、C6.1 → C5.4.2 → C6.1。

## 1. 來源核對

| 來源 | 檔案 | SHA-256 | 大小 | 檔案／ZIP 項目 | Manifest |
|---|---|---|---|---|---|
| 主基準 C5.4.2 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C5_4_2_PAYMENT_RESPONSE_TIMING_FIX_APP_ROOT.zip` | `cb44024ef6b01caaf3fe1aab97db095baaadd91b1b3068cd4f0c85a7e9f81b8b` | 7,624,303 | 1000／1049 | 997 筆，逐檔大小與雜湊相符 |
| 功能來源 C6 | `P3CD_DEPLOY_R54_4_MBV2_HF1_C6_AUTO_RESTOCK_NOTIFY_APP_ROOT.zip` | `f42180897749b216b326162e87db3fb210b0b9c3b82e7e3ce2b724a56bc45abf` | 7,363,972 | 985／1030 | 982 筆，逐檔大小與雜湊相符 |

共同祖先 C5.4 沒有原始 ZIP，改以 C5.4.2 套件內的 `docs/R54_4_MBV2_HF1_C5_4/02_FILE_MANIFEST.json`（973 筆雜湊）做三方比對。逐檔歸類如下：

| 歸類 | 檔案 | 處理 |
|---|---|---|
| 只有 C6 改動（C5.4.2＝C5.4） | `public/index.html`、`routes/product-demand.js`、`routes/products.js`、`server.js`、`utils/restockNotify.js`、`utils/restockTracking.js`；新增 `utils/restockAuto.js`、`utils/demandExport.js`、C6 兩支測試 | 採用 C6 版本，其中 `server.js`、`restockNotify.js`、`restockAuto.js` 再做 C6.1 修正 |
| 只有 C5.4.x 改動（C6＝C5.4） | `public/line-order.html`、`routes/orders.js`、`routes/popup-public.js`、`utils/paymentDisplay.js`、`utils/popupOrderLookup.js`、`utils/popupOrderStatus.js`、`utils/popupOrderTime.js`、`utils/popupPayment.js`、`utils/popupPaymentRecovery.js`、C5.4.1／C5.4.2 測試 | 保留 C5.4.2，**逐位元組相同** |
| 兩邊都改動 | `utils/db.js`、`utils/migrationV2.js`、`public/js/app.js` | 以 C5.4.2 為底，只加入 C6 的變更段落（見下） |

**三方合併證據**（以 C5.4.2 為準的逐行差異）：
- `utils/db.js`：只新增 4 行（呼叫 `restockAuto.migrate()`）、刪除 0 行。C5.4.2 的 `popupOrderTime.migrate()`（快閃台北時間契約、來源標記欄位與觸發器）完整保留。
- `utils/migrationV2.js`：改動 2 行。
  - `PROTECTED_SETTING_KEYS`：加入 C6 的 3 個自動設定 key。
  - `IGNORE_COMPARE.products`：加入 C6.1 的 2 個本地控制欄位。
  - C5.4.2 的 MBV2 時間值與來源標記合併修正（`orders` 不比較 `popup_created_tz`／`popup_updated_tz`）完整保留。
- `public/js/app.js`：C6 的 5 段差異中，套用 4 段（分頁載入、`_RN_PAUSE`、自動通知後台區塊、商品參與勾選、批次來源標示）。
  - 第 1 段在 C6 中等於刪除 C5.4.2 的成立狀態標籤 `c542EstBadge()`，因此**不套用**。
  - 相對 C5.4.2 只替換 2 行（`_RN_PAUSE` 與批次標頭），其餘為新增。
- **付款核心逐位元組相同**：下列 14 個檔案與 C5.4.2 相同。
  - `public/line-order.html`、`routes/orders.js`、`routes/popup-public.js`、`routes/line-orders.js`
  - `utils/paymentDisplay.js`、`utils/popupOrderLookup.js`、`utils/popupOrderStatus.js`、`utils/popupOrderTime.js`、`utils/popupPayment.js`、`utils/popupPaymentRecovery.js`、`utils/linePayRecovery.js`
  - `package.json`、`package-lock.json`、`.env.example`
- **合併驗證**：純整合版（尚未修缺口）跑 C6 原 24 項為 24／24。C5.4.2 的成立／台北時間 29、PAYMENT_GUARD_TIME_MERGE_FIX 22、PAYMENT_RESPONSE_TIMING_FIX 18 在 C6.1 全數通過（第 6 節）。

## 2. 相對最新 C5.4.2 整合的 C6 功能

完整保留 C6 原有功能：
- 恢復販售自動通知（全店開關、商品參與、觸發對照表、取餐方式優先序、最近可訂購日）。
- 手動預覽／確認／續送／取消。
- 「都可以」同週期只通知一次；商品直達連結、`rt` 與成效歸因；手動／自動來源篩選。
- 需求 CSV 匯出（BOM、跳脫、防公式注入、遮罩、權限、店別隔離）。
- 自動設定的備份保護與匯入隔離。

相關檔案與驗收：
- 新增：`utils/restockAuto.js`、`utils/demandExport.js`。
- 修改：`routes/products.js`（寫入掛勾）、`routes/product-demand.js`（`/restock/auto*`、`/export.csv`）、`server.js`（開機恢復與每分鐘檢查）、`public/index.html`、`public/js/app.js`、`utils/restockNotify.js`、`utils/restockTracking.js`、`utils/db.js`、`utils/migrationV2.js`。
- C6 原 24 項、C6 升級／回退 4 項在 C6.1 全數通過（第 6.2 節）。

## 3. 相對 C6 修正的安全與恢復行為

### 3.1 可持久保存的版本

| 版本 | 位置 | 何時改變 | C6 是否已有 |
|---|---|---|---|
| 全店 epoch | `settings.restock_auto_notify_epoch` | 自動通知由關閉變為開啟時 +1 | 有 |
| 商品參與版本 | `products.restock_auto_version`（新增） | 參與狀態**真正改變**時 +1（退出、加入都算）；相同值重複儲存不變 | 無 |
| 事件所屬版本 | `restock_auto_events.epoch`（C6 已有）＋`product_auto_version`（新增） | 事件建立時寫入 | 部分 |
| 批次所屬版本 | `restock_notify_batches.auto_epoch`、`auto_product_version`（新增） | 自動預覽建立時沿用事件版本寫入 | 無 |

版本都存在資料庫檔，重啟後仍有效，不依記憶體旗標。

### 3.2 每一筆實際送出前重新驗證（缺口 A／B）

`utils/restockAuto.staleReasonRaw()` 對未被店家明確接手的自動批次核對：
- 同店、同事件、同商品；非匯入批次。
- 自動通知仍開啟。
- 批次 epoch＝事件 epoch＝目前 epoch。
- 商品仍參與，且參與版本相符。
- 舊批次沒有版本（無法證明）→ 不自動處理。

核對時點：
- **`restockNotify.runBatch()` 取得逐筆發送資格（durable claim，`status='sending'`）的同一個交易內**，再次核對。開關、商品參與、設定的寫入也都在同一執行緒的 durable 交易中，因此兩者不會互相插隊。
- 網路呼叫在交易提交之後，不會跨網路等待持有寫入交易。
- 總開關、必要設定、同意、好友、需求週期、防重送、商品可訂購性與供應日期，沿用原本逐筆送出前的檢查。

核對不通過時（`applyStaleRaw()`）：

| 項目 | 處理 |
|---|---|
| 從未交給 LINE（`attempt_count=0`） | 狀態維持（待發送），**不標為已受理、已通知、已完成**；記錄 `exclusion_reason`；**釋放本週期名額**（`claim=NULL`） |
| 曾交給 LINE（已受理、結果不明、等待重試） | 原樣保留：retry key、名額、錯誤代碼都不動；不改成「確定未送出」、不換 key 重送 |
| 批次 | `sending／paused` → `paused`，`previewed` → `expired`，`pause_reason` 為下列原因之一 |

暫停原因（後台皆有中文說明，並註明可由店家明確續送接手）：
- `auto_disabled`：自動通知已關閉。
- `auto_epoch_stale`：自動通知曾關閉後重新開啟。
- `auto_product_not_participating`：商品已退出自動通知。
- `auto_product_version_stale`：商品曾退出後重新加入。
- `auto_version_unproven`：無法確認版本。
- `auto_event_mismatch`：批次與事件不一致。
- `auto_imported`：由備份匯入。

**名額保留／釋放政策**：
- 未送出的項目釋放名額，所以新基線下真正發生的恢復販售仍可正常通知同一位顧客（`N1`）。已受理的人由 `cycleEvidence()` 排除。
- 店家明確續送（人工接手）時，`resumeBatch()` 會替這些項目**重新取得名額**；同週期已被其他批次占用時擋下（`in_other_batch`）。因此不會重複發送，也不會永久卡住。
- 沒有清空任何防重紀錄。

開關變更的即時處理（`staleSweepRaw()`，與開關寫入在同一交易）：
- 開關或商品參與真正改變時，同店（或同商品）**暫停中、預覽中**的自動批次立即依新狀態判定。
- **送出中**的批次由 worker 在下一筆 claim 前判定。

### 3.3 人工接手

- 只有後台 `POST /restock/batches/:uuid/resume`（店家按「續送未完成項目」）會寫入 `taken_over_by`。
- 接手後沿用原 delivery、retry key、訊息快照與總嘗試次數。
- 接手可解除自動模式與商品參與限制，但不能繞過總開關、同意、好友、取消需求、商品可訂購性（`M1`）。
- 開機恢復、匯入、自動 worker 都不會寫入 `taken_over_by`。匯入批次清空版本欄位，永遠不會被自動續送。

### 3.4 依既有批次狀態恢復（缺口 C）

`processEvent()` 不再把「找到既有批次」當成「事件已完成」。同一事件、同一取餐方式的既有批次（**任何狀態**）都沿用，不重建：

| 既有狀態 | C6.1 處理（`continueAutoBatch()`） |
|---|---|
| `previewed`、尚未確認 | 依序重新檢查：版本、總開關與必要設定、預覽是否逾時（30 分鐘）、商品可訂購性（原供應日期）、連結與訊息快照（`confirmBatch` 內 `batchContext`）。有效 → **沿用同一批次確認**（原日期、原訊息與連結、原候選名單），之後才啟動 worker。無效 → 該預覽改為 `expired`，`pause_reason` 為 `preview_expired`、`link_mismatch`、`auto_*` 或 `date_not_orderable:*` 等原因，**不重建新預覽**。 |
| `sending`／`paused`／`completed` | 沿用原 delivery、名額、retry key；因重啟暫停者由開機恢復依版本與資格處理 |
| `cancelled`／`expired` | 尊重終態，記錄為停止 |
| 有已受理或結果不明項目 | 保留證據（沿用 C4.1 規則） |

- 事件狀態反映真實結果：
  - 有批次確認或沿用 → `completed`。
  - 全部停止 → `skipped`（附原因）。
  - 無法證明版本的舊資料 → `needs_review`（新增，待店家確認）。
  - 沒有合格收件人 → 合法發送 0 則，原因為 `no_eligible_recipient`／`no_eligible_recipient_at_confirm`，與恢復失敗分開。
- 冪等：事件以原子條件 UPDATE 領取，同店循序處理，同事件同方式只會有一個批次。`confirmBatch()` 以 `previewed → sending` 原子轉移防止重複確認。
- **開機恢復**（`bootRecover()`）：
  - `processing` 事件改回排隊。
  - 舊 C6 留下的 `event=completed`＋自動 `batch=previewed`＋無 delivery：
    - 批次有版本（C6.1 建立）→ 事件改回排隊，再走上表驗證。
    - 沒有版本（C6 舊資料）→ 預覽 `expired`（`legacy_unverified`），事件 `needs_review`（`legacy_preview_unverified`）。**不套用目前版本自動發送。**
  - 暫停中的自動批次若已過時 → 依 3.2 處理。
  - 因重啟暫停（`server_restart`）且版本仍有效者 → 只續送從未交給 LINE 的項目。
- 不以「所有重啟後批次一律停用」掩蓋問題：有效預覽在實際 SIGKILL 後會被正確恢復並送出（`C1`、`FX2`）。

### 3.5 測試掛勾（正式服務預設不啟用）

- `after_preview`（預覽 durable 保存後、確認前）、`after_confirm`（確認後、worker 啟動前）。
- 只在同時符合下列條件時生效：`RESTOCK_AUTO_TEST_HOOKS=1`、已設定 `RESTOCK_AUTO_TEST_GATE_DIR`、`NODE_ENV` 不是 `production`。
- `.env.example` 未設定。`H1` 驗證未設定時不會停、`NODE_ENV=production` 時函式判定為停用。
- `server.js` 開機恢復完成後多輸出一行 `[restock_auto] boot recovery done`，供測試等待明確狀態。

## 4. 三個缺口在 C6／C6.1 的實測結果

驗收腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-1-auto-guard-recovery.js`。同一份腳本先跑**未修改 C6**（只加入本腳本與測試 preload `scripts/lib/c61-line-gate.js`），再跑 C6.1 候選 ZIP 全新解壓。

模擬 LINE：
- `c4-line-mock`：有狀態，記錄每次 HTTP 呼叫、retry key、已受理 key；同 key 再送回 409。
- `c61-line-gate`：指定 UID 的請求先由模擬 LINE 受理，再暫停回應，直到測試放行。

分類：G＝回歸保護、D＝C6 缺陷、N＝C6.1 新行為。

| 案例 | 層級 | 內容 | 分類 | C6 | C6.1 |
|---|---|---|---|---|---|
| G1 | API | 沒有變更開關的正常批次送完（3 人各 1 則） | G | ✅ | ✅ |
| A1 | API | 第一筆等待回應時**關閉**自動 → 第一筆照實受理、第二筆不送、批次暫停 | G | ✅ | ✅ |
| A1b | API | 未送出項目維持待發送、記錄原因、釋放名額 | N | ❌（名額仍占用，`claim=1`） | ✅ |
| **A2** | API | **缺口 A**：等待回應時**關閉再開啟**（epoch 2→3）→ 第二筆不得送出 | D | ❌（第二人收到 1 則，批次「已完成」） | ✅ |
| A2b | API | 過時批次記錄「曾關閉後重新開啟」、未送出 1 筆 | D | ❌ | ✅ |
| **B1** | API | **缺口 B**：等待回應時商品退出 → 第二筆不得送出 | D | ❌（第二人收到） | ✅ |
| **B2** | API | **缺口 B**：商品退出後又加入（旗標為 1）→ 舊批次不得恢復 | D | ❌（第二人收到） | ✅ |
| V1 | API | 重複儲存相同開關／參與：epoch 與版本不變、不建事件 | N | ❌（例外：C6 無版本欄位） | ✅ |
| R1 | API | 重啟後 A1／A2／B1／B2 舊批次都沒有被自動撿回 | D | ❌（A2／B1／B2 第二人已收到） | ✅ |
| N1 | API | 新基線下再恢復販售：建立新批次，通知舊批次中未送出者 1 則，已受理者不重送 | N | ❌（C6 舊批次已送出） | ✅ |
| M1 | API | 人工接手：記錄接手人，原 delivery、原 retry key 送出 1 則，已受理者不重送 | G | ✅ | ✅ |
| M2 | API | 自動送出中店家同時手動預覽／確認：每週期 1 筆有效受理 | G | ✅ | ✅ |
| G2 | API | 送出中撤回同意、取消需求：發送前擋下 | G | ✅ | ✅ |
| G3 | API | 送出中關閉總開關：批次暫停 | G | ✅ | ✅ |
| G4 | API | 送出中停售：發送前擋下 | G | ✅ | ✅ |
| S1 | API／DB | 第一店多次切換，第二店自動設定、epoch、商品參與（含版本）不變 | G | ✅ | ✅ |
| **C1／C1b** | **RS** | **缺口 C**：預覽 durable 保存、確認前**實際 SIGKILL** → 同一資料庫檔重啟：同一批次確認並送出（2 人各 1 則）、不重建、事件完成；再次重啟冪等 | D | 不適用（無掛勾） | ✅ |
| C2 | RS | 確認後、worker 啟動前 SIGKILL：沿用原 delivery 與 retry key | N | 不適用 | ✅ |
| C3／C3b | RS | 部分已受理後中斷＋第二位「LINE 已受理但回應遺失」：已受理保留、結果不明者不換 key 重送（HTTP 1 次）、未送出者沿用原 key；再次重啟沒有重送 | N | 不適用 | ✅ |
| C4 | RS | 預覽保存後商品退出，再 SIGKILL：預覽停止、LINE 0、不重建 | N | 不適用 | ✅ |
| C4b | RS | 預覽保存後自動關閉，再 SIGKILL：預覽停止、事件 `skipped`（`auto_disabled`） | N | 不適用 | ✅ |
| C5 | RS | 預覽保存後 SIGKILL，重啟時已過 31 分鐘：`preview_expired`，不重建新預覽追發 | N | 不適用 | ✅ |
| C6 | RS | 預覽保存後 SIGKILL，重啟前 LIFF 改變：`link_mismatch`，LINE 0 | N | 不適用 | ✅ |
| **FX2** | **FX** | **缺口 C 持久狀態**：事件待處理＋自動批次 `previewed`＋無 delivery → 重啟 | D | ❌（送出 0 則、批次停在 `previewed`、事件 `completed`） | ✅（同一批次確認、送出 1 則） |
| FX1 | FX | 舊 C6 留下的 `completed＋previewed＋無 delivery`：標為待店家確認，不自動發送 | D | ❌（維持 `completed`，通知無聲遺失） | ✅ |
| H1 | API／FN | 測試掛勾預設不啟用 | N | ❌（C6 無掛勾函式） | ✅ |
| Z | — | 真實 LINE 呼叫 0 次 | G | ✅ | ✅ |
| **合計** | | | | **9 通過／11 失敗／7 不適用** | **29／29** |

- C6 失敗的缺口案例（A2、A2b、B1、B2、R1、FX2、FX1）都是**業務斷言失敗**：第二人實際收到 LINE、批次顯示已完成、事件已完成但送出 0 則。不是函式不存在。
- 只有 V1、H1 在 C6 失敗的原因是欄位或函式不存在，歸類為 N，不當作缺口證據。
- C6.1 模擬 LINE 統計：HTTP 呼叫 25、使用的 retry key 25、唯一受理 25。同 key 的合法重試（409 已受理）另見升級／回退 `P2e`。

## 5. 測試層級（實際 SIGKILL 與 fixture 分開標示）

| 層級 | 定義 | 本輪案例 |
|---|---|---|
| **RS（實際 SIGKILL）** | 以 `process.kill('SIGKILL')` 中止 `node server.js` 測試服務子程序（確認 `signalCode==='SIGKILL'`），再以同一個資料庫檔重新啟動。停點由測試掛勾或模擬 LINE 閘門精確控制，等待都以檔案或 API 的明確狀態為準 | 缺口驗收 C1～C6（含 C1b、C3b、C4b）；升級／回退 P2（C6 送出中 SIGKILL） |
| **FX（fixture）** | 先以正式 API 建立資料，停機後直接修改資料庫檔，建立指定的持久狀態 | 缺口驗收 FX1、FX2；升級／回退 P2c |
| API | 正式路由＋檔案型暫存 SQLite（`node server.js` 子程序） | 其餘缺口案例；升級／回退 P1～P3c（版本切換以一般停止／啟動，P3 回退時正在送出） |
| FN | 直接呼叫函式 | H1（`NODE_ENV=production` 時 `testHooksEnabled()===false`） |
| Chrome | 真實 Chrome（Playwright） | C6 `D3`（後台自動通知區塊）、`…-c4-2-demand-ui-refresh.js`、C3 系列、快閃前端與真實瀏覽器、R48 |

- 「重啟後不得自動撿回」等負向案例，以 C6.1 開機恢復完成紀錄、加上所有事件與批次都已不在處理中為等待條件。
- C6 基準沒有完成紀錄，改以 5 秒上限等待，只用於基準。

## 6. 回歸

候選版：`P3CD_…_C6_1_…` 候選 ZIP 全新解壓 → `npm ci` → 空資料庫啟動，`/api/health` 回 `ok`。
- 自動設定不存在，等同關閉。
- 參與商品 0、事件 0。
- 三版各以自己的程式建立空資料庫，比對 `sqlite_master`：
  - C5.4.2 為 246 個物件，C6.1 為 250 個。
  - 多出的 4 個是 C6 的 `restock_auto_events` 表與 3 個索引；C5.4.2 的物件一個都沒有少。
  - 未修改 C6 少了 C5.4.2 的 `trg_c542_popup_order_updated_tpe` 觸發器，C6.1 已保留。
  - C6.1 新增的版本欄位是既有表的欄位，不算物件。

測試時鐘：預設台北 10:30（各腳本既有設定）。兩棵樹同時段平行執行。

### 6.1 最新 C5.4.2 對 C6.1（同一份 36 支清單）

| 套件 | C5.4.2 | C6.1 |
|---|---|---|
| C5.4.2 成立／台北時間 | 29／29 | 29／29 |
| PAYMENT_GUARD_TIME_MERGE_FIX | 22／22 | 22／22 |
| PAYMENT_RESPONSE_TIMING_FIX | 18／18 | 18／18 |
| C5.4.1 原驗收／TIMING_FIX | 19／19、11／11 | 19／19、11／11 |
| C5.4 付款畫面 | 27／27 | 27／27 |
| C5.3 付款防護／C5.2 付款恢復／C5.1 訂單識別 | 25／25、33／33、61／61 | 25／25、33／33、61／61 |
| phase3 結帳付款 runtime | 111／111 | 111／111 |
| phase4b recovery full／frontend／resume | 168、50、92（全過） | 168、50、92（全過） |
| 快閃前端／真實瀏覽器／public checkout／checkout integration／recovery cart／state | 293、36、1447、20、67、94（全過） | 相同 |
| R48 快閃前台 UI（瀏覽器） | 10／13 | 10／13（同一組 3 項，見 6.3） |
| MBV2 匯出／合併／預覽 | 121／121 | 121／121 |
| C1 預購狀態 | 93／93 | 93／93 |
| C3 販售狀態與需求／C3.1／C3.2／C3.3 | 332／332、54／54、32／32、30／30 | 相同 |
| C4 補貨通知／C4.1 去重續送／C4.2 畫面更新／C4.3／C4.4 | 94、40、80、34、20（全過） | 相同 |
| C4.5 日期同意／商品直達連結／LINE push 相容 | 55、42、12（全過） | 相同 |
| C5 補貨轉換（預設時鐘／`C4_CLOCK_OFFSET_MS=0`） | 42／42、42／42 | 42／42、42／42 |

36 支結果**逐項相同**；除 R48 外 exit code 全部為 0。

### 6.2 C6 對 C6.1（C6 原功能回歸）

| 套件 | 未修改 C6 | C6.1 |
|---|---|---|
| C6 原 24 項 `…-c6-auto-restock.js` | 24／24 | 24／24 |
| C6 升級／回退 `…-c6-upgrade-rollback.js`（舊版改用最新 C5.4.2） | 4／4 | 4／4 |
| MBV2 搬家 | 121／121 | 121／121 |
| C3／C3.1／C3.3 | 332、54、30（全過） | 相同 |
| C4／C4.1／C4.2／C4.3／C4.4 | 94、40、80、34、20（全過） | 相同 |
| C4.5 日期同意／連結／LINE push 相容 | 55、42、12（全過） | 相同 |
| C5 補貨轉換（`C4_CLOCK_OFFSET_MS=0`） | 42／42 | 42／42 |
| **本輪缺口驗收** | **9／11 失敗／7 不適用** | **29／29** |
| **本輪升級／回退** | — | **11／11** |

- 補修過程中，C6 原 C4 曾在中間版本失敗一次：既有斷言以 `status IN ('pending','retry_wait')` 讀取未送出項目的 retry key。
- 處理方式是修改**產品**：過時批次的未送出項目維持原狀態、只釋放名額。斷言沒有修改。最終版本 24／24。

### 6.3 R48（逐項列出，不寫成全部通過）

`smoke-r48-popup-order-ui-browser.js` 在兩棵樹都是 **10 通過／3 失敗**，失敗項目與內容逐行相同：
1. `R_TOUCH_TARGET_44`：320×568 場次頁頁首「🔍 查詢訂單」「📜 我的訂單」「📅 選擇其他場次」按鈕高 40px（<44）。
2. `R_NO_STICKY_FIXED`：320×568 有 1 個 sticky／fixed 元素。
3. `R_FATAL`：`locator.scrollIntoViewIfNeeded` 逾時 30 秒。

說明：
- 這 3 項與 C5.4.2 報告記載的既有失敗相同。快閃前台（`public/line-order.html`、`popup-order`）與 C5.4.2 逐位元組相同，本輪未修整。
- 執行說明：這支腳本在致命路徑上沒有還原被攔截的 `console.log`，透過管線執行時報告會遺失。因此兩棵樹都另外單獨執行，並以**應用程式外**的 preload 把報告行同步寫檔。腳本本身未修改。

### 6.4 未執行的套件

- `…-c5-4-2-upgrade-rollback.js`（需要 C5.4.1 TIMING_FIX 樹）與 `…-c5-4-2-payment-guard-upgrade-rollback.js`（需要 C5.4.2 原版樹）：本輪沒有這兩個舊版套件，未執行。
- 本輪付款相關後端與 C5.4.2 逐位元組相同。

## 7. 升級、回退與舊資料政策

驗收腳本：`scripts/smoke-r54-4-mbv2-hf1-c6-1-upgrade-rollback.js`，結果 11／11。
- 每條路徑都以**該版本自己的程式**建立空資料庫，避免舊版資料庫被新版欄位預先初始化。
- 每次切換都逐表核對需求、同意、批次、逐筆結果、商品、訂單、自動事件：共同欄位逐列相同，已受理與結果不明的證據、retry key 逐筆保留。
- 唯一允許的差異是各版本相同的既有開機補值：舊外帶訂單 `pickup_type` 空白 → `store`。

| 案例 | 路徑 | 結果 |
|---|---|---|
| P1 | 最新 C5.4.2 → C6.1 | 資料全部保留；自動關閉、epoch 0、商品不參與、版本 0；恢復販售不自動發送 |
| P1b | C6.1 再啟動 | 遷移可重複執行：欄位只有一份、資料不變 |
| P2 | 舊 C6 → C6.1 | 資料全部保留；自動開關／epoch／開啟時間不變；已參與商品版本自 1 起算 |
| P2b | 舊 C6 送出中 SIGKILL 的自動批次 | C6.1 不自動續送（`auto_version_unproven`）：未送出者釋放名額、結果不明者保留 |
| P2c | 舊 C6 `completed＋previewed＋無 delivery` | 預覽 `legacy_unverified`、事件 `needs_review`、LINE 0 |
| P2d | 升級後新恢復販售 | 新批次帶版本；新登記 1 則；C6 時期已受理者不重送 |
| P2e | 店家續送舊 C6 批次 | 未送出者以原 key 送 1 則；結果不明者只以同 key 重試（LINE 回 409 已受理），唯一受理仍為 1 |
| P3 | C6.1 → 最新 C5.4.2 | 可啟動；資料與證據全部保留；C5.4.2 沒有自動功能 → 恢復販售不自動發送；回退時送出中的自動批次停在暫停；手動預覽可用（已受理者排除） |
| P3b | → 再升級 C6.1 | 設定保留；過時批次仍不自動續送；新恢復販售通知新登記 1 則 |
| P3c | 回退時送出中的批次 | 版本仍有效 → 只續送從未交給 LINE 的項目（原 key）；結果不明者不重送 |
| Z | — | 真實 LINE 0 |

**遷移**（additive、可重複執行，由 `restockAuto.migrate()` 執行）：
- `products.restock_auto_version INTEGER NOT NULL DEFAULT 0`：新增時，已參與商品設為 1。
- `restock_notify_batches.auto_epoch`、`auto_product_version`（預設 NULL）。
- `restock_auto_events.product_auto_version`（預設 NULL）。
- 不改寫任何既有資料值。新安裝與從 C5.4.2 升級時，`restock_auto_notify_enabled` 不存在（等同關閉），商品不參與，原有手動通知總開關不變。

**匯入／還原政策**：
- 自動開關、epoch、開啟時間：保護設定（C6 既有）。
- **商品參與與參與版本：本地維護**。不比較、不補入、不覆寫；匯入的新商品一律不參與、版本 0。
- 匯入批次清空 `auto_epoch`／`auto_product_version`，永遠不會被自動續送。
- `restock_auto_events` 不匯出、不匯入（C6 既有）。

**舊資料政策**：
- C6 時期的事件與批次沒有版本，一律視為無法證明，不會被自動發送或自動續送。
- 店家可明確續送（人工接手）、改用手動預覽，或取消。

**回退限制**：
- C5.4.2 不讀取新欄位與 `restock_auto_events`；回退期間沒有自動通知。
- C5.4.2 開機時把送出中的批次暫停（`server_restart`），不自動續送。
- 回退期間若店家在 C5.4.2 手動續送已釋放名額的舊自動項目，C5.4.2 不會重新取得週期名額。防重只靠已受理／曾嘗試證據，仍會排除已通知者。營運說明建議回退期間改用手動預覽。

## 8. 檔案變更（相對最新 C5.4.2）

- 產品新增 2：`utils/restockAuto.js`（C6＋C6.1）、`utils/demandExport.js`（C6）。
- 產品修改 9：
  - 等同 C6：`public/index.html`、`routes/product-demand.js`、`routes/products.js`、`utils/restockTracking.js`。
  - C6＋C6.1：`server.js`、`utils/restockNotify.js`。
  - 三方合併（＋C6.1）：`utils/db.js`、`utils/migrationV2.js`、`public/js/app.js`。
- 測試新增 5：
  - C6：`scripts/smoke-r54-4-mbv2-hf1-c6-auto-restock.js`、`scripts/smoke-r54-4-mbv2-hf1-c6-upgrade-rollback.js`。
  - C6.1：`scripts/smoke-r54-4-mbv2-hf1-c6-1-auto-guard-recovery.js`、`scripts/smoke-r54-4-mbv2-hf1-c6-1-upgrade-rollback.js`、`scripts/lib/c61-line-gate.js`（測試專用 preload，正式部署不載入）。
- 既有測試修改 0、刪除 0。
- 文件新增：`docs/R54_4_MBV2_HF1_C6/`（C6 歷史 5 份，原樣）、`docs/R54_4_MBV2_HF1_C6_1/`（本輪 5 份）。先前各輪文件全部保留。

## 9. 打包

### 9.1 流程
1. 從工作樹打包候選 ZIP。排除 `node_modules`、`.env`、資料庫、上傳、log、測試輸出；保留 `.env.example`。根目錄直接包含應用程式。
2. 全新解壓 → `npm ci` → 空資料庫啟動與健康檢查 → 新驗收與全部回歸（第 4、6 節）。
3. 舊資料升級／回退以各版本建立的暫存資料庫驗證（第 7 節），不以空資料庫替代。
4. 加入本輪文件後產生最終 ZIP，再與已測候選 ZIP 逐檔比較：產品與測試程式完全相同，差異只有本輪 5 份文件（9.3）。

### 9.2 Manifest
- `02_FILE_MANIFEST.json` 列出最終套件中所有檔案的大小與 SHA-256。
- 含先前各輪文件與本輪 `03_OPERATIONS_GUIDE.md`、`04_RESTOCK_V1_COMPLETION_REPORT.md`。
- 只排除本輪 `00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json` 本身。

## 10. 尚未執行的驗收

- **真實 LINE 營運驗收尚未執行**。本輪真實 LINE、LINE Pay、Sandbox 呼叫皆為 0。最短步驟見 `03_OPERATIONS_GUIDE.md` 第 H 節，含 C6.1 關閉再開啟的實機確認。
- 「LINE 已受理」只代表 LINE API 已受理請求，**不代表顧客已收到或已讀**。
- 未部署；未開啟任何正式自動通知。
- 本輪不擴大到快閃場次或宅配自動通知，也沒有新增其他行銷功能。
