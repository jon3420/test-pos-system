# R54.4／MBV2-HF1-C6 最終報告：恢復販售自動補貨通知（保留手動發送）＋需求資料 CSV 匯出

> 交付套件的 SHA-256 無法寫在 ZIP 內；見交付訊息與專案報告 `claude/R54_4_MBV2_HF1_C6_FINAL_REPORT.md`。
> 本套件以最終 C5.4 套件為基準，**包含 C5.4 的全部修正**（`docs/R54_4_MBV2_HF1_C5_4/` 一併附上）。
> 補貨系統第一版完成度核對見 `04_RESTOCK_V1_COMPLETION_REPORT.md`；營運操作說明見 `03_OPERATIONS_GUIDE.md`。

## 0. 摘要

- **基準**：最終 C5.4 套件 `P3CD_DEPLOY_R54_4_MBV2_HF1_C5_4_POPUP_PAYMENT_RECOVERY_AND_PAYMENT_UI_FIX_APP_ROOT.zip`（SHA-256 `7956751b0f146ec6894f96b9ebc53d5f138e966b57513376e5c8d2b3d32c91c6`，976 個檔案、44 個資料夾項目，共 1020 個 ZIP 項目；C6 的產品與測試檔是在 C5.4 最終產品檔上增修，C5.4 與 C6 之間沒有其他差異）。
- **範圍**：未部署、未操作正式資料；真實 LINE Messaging API 與 LINE Pay 呼叫 **0 次**。自動發送功能**交付時預設關閉**，商品預設不參與。
- **結果**：
  - C6 驗收 `smoke-r54-4-mbv2-hf1-c6-auto-restock.js`：C6 **24／24**；同一組案例在 C5.4 為 **5／24**（全部 19 項失敗皆為新功能不存在 N；5 項通過者是 A0、Z 兩項回歸保護，以及 B2、C7、C8 三項「沒有自動功能時本來就不會發送」的空真通過）。
  - 真實升級（C5.4 建立並使用的資料庫 → C6）與回退（C6 → C5.4 → C6）：**4／4**。
  - C5.4 驗收在 C6 全新解壓樹重跑 27／27；同時段 81 支回歸中 80 支與 C5.4 完全相同，唯一不同為既有畫面時序不穩定案例（第 8 節）。

## 0.1 案例一覽（C5.4 → C6）

| 案例 | 內容 | 分類 | C5.4 | C6 |
|---|---|---|---|---|
| A0 | [API] 自動通知預設關閉：恢復販售時自動 LINE 0 次；手動預覽照常 | G | ✅ | ✅ |
| A1 | [API] 預設關閉、商品預設不參與；設定回傳適用商品、取餐方式、供應日期規則 | N | ❌ | ✅ |
| A2 | [API] 開啟只建立觀測基線：已可售的參與商品不建立事件、不追發 | N | ❌ | ✅ |
| A3 | [API] 外帶可訂、外送不可訂：只通知外帶偏好與「都可以」的同意登記；外送偏好、未同意、撤回、取消排除；訊息含商品直達與 rt | N | ❌ | ✅ |
| A4 | [API] 重複儲存、連點、改名稱／價格不建立事件；停售再恢復有紀錄但本週期已通知者不再發送 | N | ❌ | ✅ |
| A5 | [API] 外帶與外送同時合格：「都可以」只通知一次（外帶優先），各偏好收到對應方式 | N | ❌ | ✅ |
| A6 | [API] 今日販售時段已結束 → 明天、「已開放預購」；休息日 → 下一個營業日 | N | ❌ | ✅ |
| A7 | [API] 額度 0：改名稱不觸發；手動增加額度使今日可訂購 → 通知 1 次 | N | ❌ | ✅ |
| B1 | [API] 自動先送 → 手動預覽排除；手動先送 → 自動不再發送 | N | ❌ | ✅ |
| B2 | [API] 手動確認與自動恢復同時進行：每人只 1 則、同週期最多 1 筆已受理 | N | ✅（空真） | ✅ |
| B3 | [API] 排隊後撤回／取消／停售：發送前排除並保留原因 | N | ❌ | ✅ |
| C1 | [API] timeout 與「已受理但回應遺失」：同一 retry key 重試、後者 409 已受理 | N | ❌ | ✅ |
| C2 | [API][RS] 送出後程序中斷：結果待確認不重送，其餘自動續送 | N | ❌ | ✅ |
| C3 | [API] retry key 超過有效時間窗：不換新 key 重送 | N | ❌ | ✅ |
| C4 | [API] 進行中關閉自動：下一筆前暫停；重新開啟不追發；店家續送＝人工接手（原 key） | N | ❌ | ✅ |
| C5 | [API] 總開關關閉：事件記錄「總開關關閉」、LINE 0 次 | N | ❌ | ✅ |
| C6 | [API] 關閉期間的恢復販售不建立事件、重新開啟不追發；未參與商品不建立事件 | N | ❌ | ✅ |
| C7 | [API] 備份還原使商品變回可售：不建立事件、LINE 0、重啟不補發；備份不含自動設定 | N | ✅（空真） | ✅ |
| C8 | [API] 訂單取消回補額度：不觸發 | N | ✅（空真） | ✅ |
| D1 | [API] 自動通知的點擊、加購、訂單、成交進入成效報表（與手動同一口徑，可依來源篩選） | N | ❌ | ✅ |
| D2 | [API] 需求 CSV 匯出：BOM 中文、跳脫、防公式注入、遮罩、無權杖、401、店別隔離 | N | ❌ | ✅ |
| D3 | [BR] 後台：開關、規則、觸發紀錄（含未發送原因）、商品參與、批次「自動」 | N | ❌ | ✅ |
| Z | 真實 LINE 呼叫 0 次 | G | ✅ | ✅ |
| **合計** | | | **5／24** | **24／24** |

**本輪測試自身的修正（P，皆在 C6 首次執行時發現、產品程式未因此修改）**：A3 原以「只支援外帶的商品」模擬外送不可訂，但該商品本來就不接受「都可以」與外送偏好的登記，改為「外送全週不營業」；D1 的 open_key 少於 8 碼；D3 讀取摺疊區塊的 `innerText` 為空，改用 `textContent` 並等待非同步讀取；C7 的取代匯入需全部分類與確認文字。

---

## 1. 觸發對照表（實際寫入路徑盤點）

| 寫入路徑 | 操作入口 | 可能改變可訂購性的欄位 | C6 是否觸發 | 說明 |
|---|---|---|---|---|
| `PATCH /api/products/:id/line-settings` | 後台「LINE 商品管理」單項編輯、批次面板（逐筆呼叫）、快速完售／上架切換、可售份數設定、重設已售 | `sale_status`、`line_sold_out`、`show_on_line`、`line_takeout_enabled`／`line_delivery_enabled`、`line_quota_daily`／`line_quota_sold`、`line_preorder_daily`／`line_preorder_sold`、`line_quota_enabled`／`line_preorder_enabled` | **是**（全店開啟＋商品參與時） | 恢復販售、取消完售、上架、開啟取餐方式、增加可售額度（含把已售重設）才算；改名稱、價格、說明、圖片、時段等不算 |
| `PATCH /api/products/:id/line-status` | 後台快速販售狀態切換 | `sale_status`、`show_on_line` | **是** | 同上 |
| `PUT /api/products/:id` | 一般商品編輯（含啟用／停用） | `enabled` | **是**（只有 `enabled` 0→1） | 名稱、價格、庫存欄位不算 |
| `POST /api/products/reset-sold-out-today` | 後台「重置今日完售」按鈕（店家明確批量操作） | `sale_status`（sold_out_today→available） | **是** | 逐商品判斷 |
| `server.js` 每日排程（午夜自動恢復 `auto_restore_next_day`） | 系統排程 | `sale_status` | 否 | 不是店家明確恢復 |
| `POST /api/line-orders/quota-reset` | 每日份數重設（排程用） | `line_quota_sold`／`line_preorder_sold` | 否 | 排程，不是店家明確增加額度 |
| `utils/orderStatusFlow.js`、`routes/line-orders.js`、`routes/line-shipping.js` 訂單建立／取消 | 下單、取消、作廢 | `line_quota_sold` | 否 | 訂單取消回補不觸發（C8 驗證） |
| `routes/importExport.js`、`utils/migrationV2.js` | 匯入、搬家、備份還原 | 全部商品欄位 | 否 | 不經過觸發掛勾（C7 驗證） |
| `PATCH /api/products/:id/shipping-settings`、批次食材控管 | 宅配設定、食材 | 不影響外帶／外送可訂購性 | 否 | 第一版不含宅配 |
| `routes/popup-pickup.js`、`utils/popupSales.js` | 快閃場次份數 | 快閃份數 | 否 | 第一版不含快閃場次 |
| 所有 GET、預覽、日期檢查、初始化 | — | — | 否 | 唯讀 |

**判定方式**（`utils/restockAuto.js`）：寫入前後各以既有 `evaluateProductOrderability()`（Asia/Taipei、最後接單、行事曆、休息日、可預訂範圍、手動販售狀態、額度）找出外帶、外送各自的最近可訂購日。只有「寫入的欄位屬於明確恢復販售或增加額度」**且**「某取餐方式寫入前不可訂購（或最近可訂購日較晚）→ 寫入後可訂購（或提早）」時才建立事件；事件記錄寫入前後各方式的日期與變動欄位，可追溯本次恢復影響哪些日期與方式。沒有可可靠對應的供應範圍時不建立事件。

## 2. 設定與畫面

- 全店「恢復販售時自動發送補貨通知」（`restock_auto_notify_enabled`，預設 `0`）；商品「參與恢復販售自動通知」（`products.restock_auto_notify`，預設 0）。
- 沿用「啟用 LINE 補貨通知發送」總開關（`restock_notify_enabled`）：總開關關閉時事件記錄「總開關關閉」、不發送（C5）。手動發送不受自動開關影響。
- 開啟時跳出確認視窗並在設定區顯示規則：適用商品、取餐方式（外帶自取、外送；第一版不含宅配與快閃）、供應日期（各方式最近可訂購日，伺服器計算）、不觸發的情況、同意與好友條件、總開關、觀測基線。
- 初次啟用（或關閉後再開啟）只建立觀測基線：產生新的 epoch，不建立事件、不追發；目前已可售的商品不會因此發送（A2）。
- 訂閱方式維持既有設定；自動發送只使用既有、屬於目前週期的同意紀錄，不新增同意（A3：未同意者排除）。
- 後台畫面（`public/index.html`、`public/js/app.js`，只新增元素，不改既有表格欄位）：補貨登記分頁的自動通知區塊（開關、狀態、規則、觸發紀錄）、商品明細的「參與恢復販售自動通知」、通知批次的「手動／自動（已人工接手）」標示、暫停原因「自動通知已關閉」、需求 CSV 匯出。

## 3. 發送：沿用既有引擎

- 事件處理呼叫 `restockNotify.previewBatch()`→`confirmBatch()`（與店家「預覽 → 確認發送」同一份名單資格、日期檢查、訊息快照、批次、逐筆投遞、retry key、同店同週期唯一 claim、C5 追蹤識別 `rt`）。沒有另寫直接呼叫 LINE 的捷徑。
- 批次多記錄 `source='auto'`、`auto_event_uuid`；發送前逐筆重新確認登記有效、同意屬於目前週期且未撤回、偏好相符、好友狀態、商品與日期仍可訂購（沿用 `runBatch`）。
- 「都可以」在外帶、外送同時合格時：先處理外帶批次，再處理外送批次；同一登記週期的唯一 claim 保證只通知一次（A5）。
- 日期在事件建立後失效（截止、額度歸零、停售）：該方式不建立批次並記錄 `date_not_orderable:<原因>`，不換日期；批次建立後才失效者，由既有逐筆發送前檢查擋下並保留原因（B3）。
- 通知不建立訂單、不扣份數、不保留庫存（沿用 C4 文案與流程）。

## 4. 持久化與防重送

| 要求 | 實作 |
|---|---|
| 事件持久化 | `restock_auto_events`（queued→processing→completed／skipped／cancelled／failed）；商品 UPDATE 與事件 INSERT 在同一個 durable 交易內；外部發送在交易提交後（`setImmediate` 交給處理程序）。 |
| 原子領取 | `UPDATE … SET status='processing' WHERE event_uuid=? AND status='queued'` 必須改到 1 列；同一程序內每店循序處理。 |
| 手動／自動共用防重送 | 完全沿用 `restock_notify_deliveries` 的 `idx_rnd_cycle_claim`（同店、同一登記週期最多一筆占用）與 `cycleEvidence()`（已受理／可能已受理證據）。沒有改成以商品、日期或批次防重送（A4、B1、B2）。 |
| 停售再恢復 | 會記錄新事件，但本週期已通知者不再發送（A4：原因「本週期已通知」）。已受理或可能已受理的紀錄不會被清除。 |
| 重試 | 沿用原 retry key、收件人與訊息；超過 23 小時有效時間窗不換新 key 重送結果不明的訊息（C1、C3）。 |
| 重啟 | `processing` 事件回到 `queued`（每個取餐方式以既有批次檢查冪等）；因重啟暫停的自動批次只續送「從未交給 LINE」的項目（pending／retry_wait），結果不明者維持待店家確認（C2）。超過 12 小時的排隊事件不再發送（`event_stale`）。匯入的批次（`import_source`）、人工接手的批次不自動續送。 |
| 自動開關關閉 | 排隊事件取消（`auto_disabled`）；執行中的自動批次在下一筆送出前暫停（`pause_reason='auto_disabled'`）；已送出的請求照常保存回應。重新開啟建立新基線，不追發停用期間的事件（C4、C6）。 |
| 人工接手 | 店家在批次按「續送未完成項目」＝明確接手（`taken_over_by`），沿用原逐筆紀錄與 retry key（C4）。 |
| 備份、搬家 | 自動開關、epoch、基線時間列入 `PROTECTED_SETTING_KEYS`（不匯出、不覆寫）；匯入不經過觸發掛勾（C7）。 |

## 5. 紀錄與成效

- 後台「自動通知紀錄」：觸發時間、商品、觸發來源、日期與取餐方式、狀態（排隊中／處理中／已建立通知批次／未發送／已取消／處理失敗）、每個方式的結果（排入人數、排除人數與原因）與未發送原因（無合格登記、本週期已通知、未同意、偏好不符、日期不可訂、總開關關閉、商品未參與…）。
- 批次清單：來源（手動／自動／已人工接手）、批次狀態、逐筆狀態（LINE 已受理、待發送、結果待確認、發送前擋下、排除…）。顯示「LINE 已受理」，說明不代表顧客已收到或已讀。
- 成效報表（`/api/analytics/restock-notify/summary`）：自動批次與手動同一口徑（商品直達、`rt`、點擊、加購、訂單、付款成交、金額）；新增 `source=manual|auto` 篩選與每列 `source`（D1：合計＝手動＋自動）。

## 6. 需求資料匯出（補齊）

- 盤點結果：C5.3 只有 MBV2 搬家備份能取出 `product_demand_requests`，沒有商家可用的營運匯出（列為缺口並補上）。
- `GET /api/product-demand-admin/export.csv?type=summary|details&product_id=&status=active|expired|cancelled&pref=&from=&to=`（`utils/demandExport.js`）：
  - 店別只信任員工 JWT（未登入 401、他店無法取得）。
  - UTF-8＋BOM（Excel 直接開啟中文不亂碼）、CRLF；每格經 `utils/csvSecurity.sanitizeCsvCell`（雙引號跳脫、公式開頭加單引號）。
  - 會員 LINE 識別一律遮罩；不輸出 member_session、retry key、追蹤識別、request／consent uuid、權杖。
  - 單次上限 20,000 列（超過以標頭提示，請縮小篩選）。
- 後台補貨登記分頁「⬇️ 統計 CSV／明細 CSV」，可依狀態與登記日期篩選。

## 7. 資料庫、API、設定變更

- 資料庫（additive、可重複執行；`utils/restockAuto.migrate()` 由 `utils/db.js` 啟動呼叫）：`products.restock_auto_notify`；`restock_notify_batches.source`（預設 manual）、`auto_event_uuid`、`taken_over_by`；新表 `restock_auto_events`（索引 `idx_rae_uuid`、`idx_rae_store_status`、`idx_rae_store_product`）。遷移本身不建立事件、不發送。
- 設定：`restock_auto_notify_enabled`（預設 0）、`restock_auto_notify_epoch`、`restock_auto_notify_enabled_at`。
- API（皆在 `/api/product-demand-admin`，員工 JWT＋`line_order`）：`GET/PATCH /restock/auto`、`PATCH /restock/auto/products/:id`、`GET /restock/auto/events`、`GET /export.csv`。既有 `/restock/batches*` 回應多 `source`、`auto_event_uuid`、`taken_over_by`；成效報表多 `source` 篩選與欄位。
- 共用引擎變更（`utils/restockNotify.js`）：`previewBatch()` 可帶 `{ source:'auto', event_uuid }`；`runBatch()` 對未被人工接手的自動批次檢查自動開關；`resumeBatch()` 對自動批次記錄人工接手；`batchOut()` 多回傳來源欄位。手動流程行為不變。
- 寫入掛勾（`routes/products.js`）：全店自動關閉或商品未參與時維持原本的寫入方式（行為完全不變）；否則商品 UPDATE 與事件在同一個 durable 交易內。
- `server.js`：啟動 2 秒後恢復合法工作、每分鐘檢查排隊事件（自動關閉時不做事）。
- `utils/migrationV2.js`：自動通知設定列為保護設定（不隨備份移轉）。

## 8. 回歸

- 條件：測試時鐘預設台北 10:30；C5.4 候選 ZIP 全新解壓樹與 C6 候選 ZIP 全新解壓樹（另含未修改 C5.3）**在同一時段並行**逐支執行同一份 81 支清單。
- 結果：**81 支中 80 支的 exit 代碼與通過／失敗數完全相同**（exit 0 皆 59 支）。唯一不同的 `smoke-h1-4-12-popup-admin-ui-browser.js` 是既有的畫面時序不穩定案例（同一時段 C5.4 為 424／426、C6 為 425／426；C5.4 與未修改 C5.3 單獨重跑也會在 424／425 之間變動，見 C5.4 報告第 8.2 節）。
- 補貨通知相關的既有回歸（C4／C4.1／C4.2／C4.3／C4.4／C4.5／C5、C3.x、搬家）在 C6 全部與 C5.4 相同：例如 `…-c4-restock-notify.js` 94／94、`…-c4-2-demand-ui-refresh.js` 80／80、`…-c4-1-dedupe-resume.js` 40／40、`…-c4-5-restock-link.js` 42／42、`…-c5-restock-conversion.js`（`C4_CLOCK_OFFSET_MS=0`）42／42、`smoke-r54-4-mbv2-migration.js` 121／121。
- **沒有修改任何既有測試或斷言**；手動「預覽 → 確認發送」的既有行為不變（自動功能關閉或商品未參與時，商品寫入路徑完全走原本的程式）。

| 腳本 | C5.4（全新解壓） | C6（候選 ZIP 全新解壓） | 比較 |
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
| `scripts/smoke-h1-4-12-popup-admin-ui-browser.js` | exit 1・424／426 | exit 1・425／426 | **不同** |
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


## 9. 全新解壓驗證（C6 候選 ZIP → 新目錄 → `npm ci` → 空資料庫啟動 → 重跑）

| 腳本 | 結果 |
|---|---|
| `smoke-r54-4-mbv2-hf1-c6-auto-restock.js`（本版主驗收） | 24／24 |
| `smoke-r54-4-mbv2-hf1-c6-upgrade-rollback.js`（舊版＝C5.4 候選 ZIP 全新解壓） | 4／4 |
| `smoke-r54-4-mbv2-hf1-c5-4-payment-ui-popup.js`（C5.4 主驗收，於 C6 上重跑） | 27／27 |
| `smoke-r54-4-mbv2-hf1-c5-3-payment-guard.js`／`…-c5-2-payment-recovery.js`／`…-c5-1-consistency.js` | 25／25、33／33、61／61 |
| `smoke-h1-4-12-popup-public-checkout.js`／`…-popup-frontend.js`／`…-durable-release.js` | 1447／1447、293／293、95／95 |
| 其餘 81 支 | 見第 8 節 |

- 最終 ZIP 與通過全新解壓驗證的候選 ZIP 逐檔比對：只有 `docs/R54_4_MBV2_HF1_C6/` 的 `00_FINAL_REPORT.md`、`01_TEST_RESULTS.json`、`02_FILE_MANIFEST.json`（列出前述文件的雜湊）、`04_RESTOCK_V1_COMPLETION_REPORT.md`，以及換成最終版的 `docs/R54_4_MBV2_HF1_C5_4/00_FINAL_REPORT.md`、`01_TEST_RESULTS.json` 不同；產品與測試檔逐檔 SHA-256 相同（另列於交付訊息）。

## 9.1 外部呼叫次數（測試替身計數）

| 情境 | LINE push（替身） |
|---|---|
| 自動關閉時恢復販售（A0）、開啟基線（A2）、改名稱／價格／重複儲存（A4）、總開關關閉（C5）、關閉期間恢復（C6）、備份還原（C7）、訂單取消回補（C8） | 0 |
| 外帶可訂、外送不可訂（A3） | 2（合格同意者各 1） |
| 兩種方式同時合格（A5） | 3（每人 1） |
| 手動與自動競爭（B2） | 每人 1 |
| timeout／已受理但回應遺失（C1） | 每人 2 次呼叫、同一 retry key；LINE 端各受理 1 次 |
| 送出後中斷、重啟（C2） | 中斷者 1（結果待確認不重送），其餘每人 1 |
| 真實 LINE Messaging API | **0** |

## 10. 升級、回退、部署

### 10.1 真實升級與回退（`smoke-r54-4-mbv2-hf1-c6-upgrade-rollback.js`，`C6_OLD_ROOT`＝C5.4 候選 ZIP 全新解壓樹（產品檔與最終 C5.4 相同））

| 案例 | 內容 | 結果 |
|---|---|---|
| U1 [RS] | C5.4 建立並使用（登記、同意、手動批次已受理）→ C6：自動通知預設關閉、既有批次標示「手動」、成效報表批次數不變、恢復販售不自動發送 | ✅ |
| R1 [RS] | C6 開啟自動並產生自動批次 → 退回 C5.4：可啟動、手動預覽可用（已受理者排除）、恢復販售不會自動發送、自動批次紀錄保留 | ✅ |
| R2 [RS] | 再升級回 C6：自動設定保留；已受理者不重送；新的恢復販售正常自動通知 | ✅ |
| Z | 真實 LINE 0 次 | ✅ |

### 10.2 部署後最短驗收（建議；自動通知維持關閉直到完成）

1. `GET /api/health` 200；啟動紀錄沒有 `restock_auto migration` 錯誤。
2. 後台補貨登記分頁：看得到「恢復販售時自動發送補貨通知」（未勾選）與規則說明；商品明細看得到「參與恢復販售自動通知」（未勾選）。
3. 匯出統計與明細 CSV，以 Excel 開啟確認中文、遮罩與欄位。
4. 依 `03_OPERATIONS_GUIDE.md` 第 F 節以測試帳號完成手動通知真機驗收，再開啟自動通知驗收（恢復販售 → 收到 1 則；再恢復 → 不重複；關閉 → 不再發送）。
5. 同時完成 C5.4 報告第 10.2 節的付款顯示驗收。

### 10.3 停用自動通知、處理未送工作

- 停用：取消勾選全店開關。排隊事件取消；執行中的自動批次在下一筆送出前暫停（原因「自動通知已關閉」）；已送出的請求保存結果。重新開啟不追發。
- 未送出的自動批次：店家可「續送未完成項目」（人工接手，原 retry key）或「取消未送出項目」（從未送出者釋放名額；曾送出者保留紀錄、不補送）。
- 緊急停止所有補貨通知：取消勾選「啟用 LINE 補貨通知發送」（總開關）；自動與手動都會停止。

### 10.4 回退條件與會重新暴露的風險

- C6 → C5.4：C5.4 可讀同一資料庫並啟動（R1），會忽略新欄位與事件表。回退後**沒有**自動通知；排隊中的事件不會被處理。自動批次若在回退當下執行中，C5.4 啟動時會依既有規則暫停（`server_restart`），需店家手動續送或取消。
- 再升級回 C6：12 小時內的排隊事件會被處理，超過者記錄為過期不發送；自動設定保留。
- C6 → C5.3 或更早：同 C5.4 報告第 10.4 節（會重新暴露付款顯示與快閃付款缺陷）。
- 保留同一個資料庫，不得還原舊資料庫。

## 11. 未驗證項目與已知限制

**未驗證**：正式站、真機、正式 LINE Messaging API（呼叫 0）、LIFF 一次／二次導向的真機行為、正式 LINE Pay。

**已知限制**
1. 第一版只支援外帶自取與外送；宅配與快閃場次不會自動通知。
2. 每日排程自動恢復（午夜 `auto_restore_next_day`）與份數每日重設不視為「店家明確恢復」，不會觸發（若營運需要，可在後續版本以明確設定開啟）。
3. 觸發後若同一商品兩種取餐方式都合格，會建立兩個批次（各自的日期與文案）；「都可以」的登記只會收到外帶那一則。
4. 事件建立後、處理前若日期失效，不會改用其他日期；需店家手動預覽發送或等下一次恢復。
5. 超過 12 小時未處理的排隊事件不再發送（例如長時間停機）。
6. 自動與手動共用「同店、同一登記週期只通知一次」：顧客必須取消後重新登記（新週期）才會再次收到。
7. CSV 單次上限 20,000 列。
8. 「LINE 已受理」不代表顧客已收到或已讀；系統不保證訊息送達。

## 12. 交付

- 套件：`P3CD_DEPLOY_R54_4_MBV2_HF1_C6_AUTO_RESTOCK_NOTIFY_APP_ROOT.zip`（檔案數、項目數與 SHA-256 見交付訊息與專案報告）。
- 根目錄直接包含 `server.js`、`package.json`；不含資料庫、憑證、權杖、`.env`（只有 `.env.example`）、`node_modules`、`uploads`、瀏覽器產物或測試輸出。
- 逐檔 SHA-256：`02_FILE_MANIFEST.json`（本目錄 00～02 三個文件本身除外）。
- **相對於 C5.4 的變更**：
  - 產品新增：`utils/restockAuto.js`、`utils/demandExport.js`
  - 產品修改：`public/index.html`、`public/js/app.js`、`routes/product-demand.js`、`routes/products.js`、`server.js`、`utils/db.js`、`utils/migrationV2.js`、`utils/restockNotify.js`、`utils/restockTracking.js`
  - 測試新增：`scripts/smoke-r54-4-mbv2-hf1-c6-auto-restock.js`、`scripts/smoke-r54-4-mbv2-hf1-c6-upgrade-rollback.js`
  - 文件新增：`docs/R54_4_MBV2_HF1_C6/`（00～04）；`docs/R54_4_MBV2_HF1_C5_4/` 為最終 C5.4 文件
  - 測試修改：無；刪除：無
