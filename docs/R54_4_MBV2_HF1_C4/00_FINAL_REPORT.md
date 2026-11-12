# R54.4／MBV2-HF1-C4 最終報告：LINE 補貨通知與商品直達訂購

- 交付 ZIP：`P3CD_DEPLOY_R54_4_MBV2_HF1_C4_LINE_RESTOCK_NOTIFY_APP_ROOT.zip`（SHA-256、檔案數與 ZIP 項目數見交付說明；ZIP 無法內含自身雜湊）
- 基準：C3.3 `P3CD_DEPLOY_R54_4_MBV2_HF1_C3_3_RESTORE_CANCEL_FIX_APP_ROOT.zip`
  - 實測 SHA-256：`d63a76f95a936dd612f544f03091198b54d4612657cb2fe1576d168646f0c903`（與指定值相符）
  - 910 個檔案／943 個 ZIP 項目；內容與 C3.3 報告一致。未使用原始 MBV2、C3、C3.1、C3.2。
- **本輪未部署任何環境，未呼叫任何真實 LINE API**（真實呼叫 0 次；自動化中的 LINE 呼叫全部在測試程序內攔截並模擬）。
- 安裝或升級到 C4 後，**通知發送預設關閉**；需由店家在後台自行開啟。

---

## 0. 摘要

**實作了什麼**

| 項目 | 結果 |
|---|---|
| 顧客主動訂閱 | 通知可用時入口為「🔔 補貨通知我」，獨立勾選「商品恢復供應或開放預購時，透過 LINE 通知我。」，預設未勾選；未勾選送出「送出想買登記」、勾選後「登記並訂閱通知」。通知不可用時維持「我想買」與「不會發送通知」說明（能力由後端回傳）。 |
| 同意週期 | 同意綁定登記週期 `request_uuid`；記錄會員、店別、商品、週期、時間、文案版本與完整文案。修改份數不算重新同意；取消／過期後的新週期需重新同意；可只取消通知、保留想買登記。 |
| 店家預覽 | LINE 商品管理 → 想買登記 → 查看 → 補貨通知：選取餐方式與供應日期，伺服器計算名單並保存預覽批次（有效登記人數與期望份數、已同意、符合資格、逐項排除原因、可用份數、完整訊息）。 |
| 手動發送 | 店家按「確認發送」才執行；原子狀態轉移；逐筆先落地再呼叫 LINE；固定 `X-Line-Retry-Key`；有上限的退避重試；權杖／額度錯誤整批暫停；可明確續送、取消。 |
| 防重送 | 資料庫部分唯一索引（同店同週期最多一筆占用名額的紀錄）＋原子轉移；連點、兩位管理員並行、重送請求、重啟、跨批次都不會重複通知。 |
| 商品直達 | 連結以商品穩定識別 `product_uuid` 指向商品，沿用店別 LIFF 設定；開啟最新商品資料與既有販售規則，不加購物車、不送單、不付款、不改顧客既有選擇。 |
| MBV2 | 新分類「補貨通知紀錄」；預覽分開顯示需求與同意歷史、批次及已受理紀錄、執行狀態；匯入只合併不清除；未完成工作一律暫停；匯入的同意需顧客重新確認；匯入與啟動都不發送。 |

**尚未驗證**（見第 10 節）：LINE App／LIFF 真機、真實 LINE Messaging API（真實權杖、真實好友、真實送達）、正式 Zeabur 環境、多台伺服器同時連同一資料檔。

---

## 1. Reality Audit

| 對象 | 現況（C3.3） | C4 處理 |
|---|---|---|
| `utils/productDemand.js` | 需求與同意分表；同一店／商品／會員只有一筆 `active`（部分唯一索引）；`NOTIFY_CHANNEL_IMPLEMENTED=false`；同意以「商品」為單位查詢，新週期會把舊的 granted **改綁到新週期**（等於沿用上一週期授權）。 | 能力改由 `restockNotify.getCapability()` 判定；同意改為綁定週期；新週期把上一週期的 granted 標為 `expired`；修改份數不新增同意。 |
| `routes/product-demand.js` | 顧客端只信任 `member_session`（`verifyMemberSession`），後台 `requireStaffJwt`（store 只來自 JWT）。 | 沿用；新增補貨通知後台 API 與公開 `product-ref`。 |
| `utils/linePush.js`／`lineApiFetch.js` | 共用 transport，8 秒逾時；只回 `{success,status,error_code}`；不帶 retry key。 | 新增**選用**參數 `retryKey`／`timeoutMs`／`detailed`；未提供時請求與回傳值與 C3.3 完全相同（單元測試 LC1–LC5）。 |
| `utils/cartRecoveryDelivery.js` | Recovery 的資格判斷：可信好友來源 `line_members.is_friend`（`getFriendStatus`），權杖 `settings.line_channel_token`，連結只用 LIFF（`line_member_liff_id`）。 | 沿用 `getFriendStatus`（另把 `is_blocked=1` 視為非好友）、同一權杖與 LIFF 設定；Recovery 呼叫端未改。 |
| 會員身分 | `member_session` 由後端簽發並驗證，含店別。 | 所有顧客端 API 仍只信任它；前端傳入的 UID／店別一律忽略。 |
| 店別 LINE 設定 | `line_channel_token`、`line_member_liff_id`、`shop_name`（settings）。 | 沿用，未新增第二份權杖；未寫死網址或 LIFF ID。 |
| `public/line-order.html` | C3.3 首屏不等 Gate；Recovery／Handoff 世代＋承諾點取消保護；想買登記表單。 | 商品直達在首屏顯示後背景執行；帶 Recovery／Handoff token 時不處理直達；C3.3 的取消保護未改動。 |
| `public/js/product-detail-modal.js` | 共用詳情元件。 | 未修改；直達透過既有 `openProductDetail()`（沿用販售判斷）。 |
| `public/js/app.js` | 後台想買登記分頁。 | 新增補貨通知面板、能力與開關、批次清單與明細。 |
| `routes/line-orders.js` | 送單、`/validate-cart`、`/timeslots` 的販售／額度／營業判斷。 | 新增唯讀 `evaluateProductOrderability()`，**只由既有函式組成**（validateOrderConditions、getEarliestMins、validateFutureOrderWindow、checkManualSaleStatusForOrder、getLineQuotaStatus、getLinePreorderStatus、販售時段）。 |
| `utils/migrationV2.js`／匯入路由 | 分類匯出、業務鍵合併、預覽＝交易內執行後 ROLLBACK、正式＝`runDurableTransaction`；C3.1／C3.2 的想買登記商品重新對應（互換、循環、最終衝突）。 | 新增分類與步驟；C3.2 的重新對應保留不變並擴充到補貨通知紀錄。 |
| 交易與持久化 | sql.js 單程序記憶體資料庫；`runDurableTransaction(work)` 要求同步 work、COMMIT 後原子檔案替換。 | 所有狀態轉移都在同步交易內；網路呼叫一律在交易外。 |

**注意到的既有限制**：sql.js 為單一程序內的資料庫，跨程序（多台伺服器共用同一檔案）本來就不支援；本版的防重保證以「單一服務程序＋資料庫唯一限制」為前提。

---

## 2. 實作結果

### 2.1 新增／修改檔案（相對 C3.3，完整清單與雜湊見 `02_FILE_MANIFEST.json`）

- 新增 `utils/restockNotify.js`：Schema、能力、資格、預覽、確認、背景逐筆發送、續送、取消、查詢、啟動復原。
- 修改 `utils/productDemand.js`（同意週期、能力、顯示）、`utils/linePush.js`（選用 retry key）、`routes/line-orders.js`（唯讀可訂購判斷）、`routes/product-demand.js`（新 API）、`utils/db.js`（啟動時 migrate 與中斷復原）、`utils/migrationV2.js`（備份還原）。
- 前台 `public/line-order.html`；後台 `public/js/app.js`、`public/index.html`、`public/js/migration-v2.js`（顯示分項；快取版本號更新）。
- 測試：`scripts/smoke-r54-4-mbv2-hf1-c4-restock-notify.js`、`scripts/smoke-r54-4-mbv2-hf1-c4-linepush-compat.js`、`scripts/lib/c4-line-mock.js`（測試專用 LINE 模擬）、`scripts/lib/c4-test-clock.js`（測試專用一致時鐘）。三支既有測試的斷言依規則調整（第 8.3 節）。

### 2.2 後台 API（`/api/product-demand-admin`，`requireStaffJwt`＋`line_order`，store 只信任 JWT）

| 方法 | 路徑 | 說明 |
|---|---|---|
| GET | `/restock/capability` | 能力、必要設定缺漏、啟用狀態；`token_verified` 永遠為 false（只檢查存在，未驗證可發送） |
| PATCH | `/restock/settings` | `{ send_enabled }` |
| POST | `/restock/preview` | `{ product_id, fulfillment_mode: takeout｜delivery, supply_date }` → 伺服器名單、統計、訊息、保存預覽批次（30 分鐘） |
| POST | `/restock/batches/:uuid/confirm` | 確認發送（只有第一個請求生效） |
| POST | `/restock/batches/:uuid/resume` | 明確續送（沿用原逐筆與 retry key） |
| POST | `/restock/batches/:uuid/cancel` | 取消尚未送出的項目 |
| GET | `/restock/batches[?product_id=]`、`/restock/batches/:uuid` | 進度與明細（UID 遮罩） |

顧客端新增 `GET /api/product-demand/product-ref?ref=<product_uuid>`：只回傳目前仍在 LINE 公開的商品 ID，不需要也不接受會員身分。

---

## 3. Schema、同意週期、批次與防重送

### 3.1 Schema（全部為向前相容的新增）

- `products.product_uuid TEXT`＋部分唯一索引 `(store_id, product_uuid)`；啟動時為空值補發。
- `product_demand_consents` 新增欄位：`reconfirm_required`、`consent_source`、`consent_text`、`ended_at`、`import_source`；索引 `(store_id, request_uuid)`。C3 版本文案（`restock-notify-v1` 或空白）的 granted 一律標示需重新確認。
- `restock_notify_batches`：`batch_uuid`（唯一）、店別、商品（ID＋`product_uuid`＋名稱快照）、`fulfillment_mode`、`supply_date`、`notice_kind`（restock／preorder）、`message_text`／`link_url`／`message_hash`（訊息快照）、`status`、`preview_json`（統計與候選 `request_uuid` 清單）、建立／確認者與時間、`preview_expires_at`、`pause_reason`、`import_source`。
- `restock_notify_deliveries`：`delivery_uuid`（唯一）、`batch_uuid`、店別、商品、`request_uuid`、`cycle_no`、`consent_uuid`（同意依據）、`line_user_id`、`retry_key`（唯一）、`claim`、`status`、`exclusion_reason`、`attempt_count`／`max_attempts`、`first_attempt_at`／`last_attempt_at`／`next_attempt_at`／`accepted_at`、`last_http_status`、`error_code`（固定代碼）、`line_request_id`、`accepted_request_id`、`import_source`。
  - 唯一索引：`(store_id, request_uuid) WHERE claim=1`（同週期名額）、`(batch_uuid, request_uuid)`、`retry_key`、`delivery_uuid`。

### 3.2 同意週期

| 情境 | 結果 |
|---|---|
| 新登記、既有 C3 登記 | 無同意；勾選預設未勾選 |
| 明確勾選（`notify_consent === true`）且後端判定可用 | 新增 granted，綁定本週期 `request_uuid` |
| 本週期已同意再送 true／只改份數或偏好 | 不新增、不改變（`unchanged`） |
| 只取消通知 | 該會員此商品的 granted → revoked，登記保留 |
| 撤回後重新勾選 | 新增一筆 granted（保留撤回歷史）；**不重置本週期已通知的事實** |
| 取消整筆登記 | 登記 cancelled，同意 revoked |
| 過期／取消後新週期 | 新的 `request_uuid`；上一週期 granted 標為 `expired`；須重新勾選 |
| 匯入或 C3 版本的同意 | 保留歷史，顯示「需重新確認」，不可作為發送授權；本人可撤回 |
| 登入、加好友、曾下單 | 不構成同意 |

### 3.3 批次與逐筆狀態

批次：`previewed → sending → completed｜paused`，另有 `cancelled`、`expired`（預覽逾時）。

逐筆：

| 狀態 | 意義 |
|---|---|
| `pending` | 已建立、尚未嘗試 |
| `sending` | 已落地並可能已交給 LINE、尚未寫回結果 |
| `retry_wait` | 可重試失敗（逾時、5xx、速率限制），等待退避 |
| `held` | 確定未受理但整批暫停（權杖錯誤、當月額度、未設定、匯入的未完成項目），須店家續送 |
| `accepted` | **LINE API 已受理**（HTTP 200 或官方 retry-key 已受理的 409）；不代表顧客已收到或已讀 |
| `unknown` | 結果待確認（重試上限、送出後服務中斷、無法分類的 409、超過 retry key 期限） |
| `failed` | 確定失敗且重試不會改變結果（400 等） |
| `blocked` | 發送前重新檢查不符（撤回、停售、額度、日期、好友…），未呼叫或不再呼叫 |
| `excluded`／`cancelled` | 確認時排除／批次取消 |

### 3.4 防重送規則

1. **同週期一次**：`restock_notify_deliveries(store_id, request_uuid) WHERE claim=1` 唯一。建立逐筆紀錄時 `claim=1`，插入衝突即記為 `excluded/in_other_batch`。
2. **確認只生效一次**：`UPDATE … SET status='sending' WHERE status='previewed' AND preview_expires_at > now`，只有改到 1 列的請求會建立逐筆紀錄。
3. **先落地再呼叫**：每筆送出前在 durable transaction 內把 `pending/retry_wait → sending`、`attempt_count+1`、寫入首次嘗試時間；回應後再以另一個交易寫回。網路呼叫不在交易內、交易 callback 內沒有 `await`。
4. **名額釋放**：只有「從未交給 LINE」的項目（`attempt_count=0`）在擋下或取消時釋放名額；曾嘗試過的一律保留（可能已受理）。
5. **續送**：只沿用原逐筆紀錄與 retry key（`held`、期限內的 `unknown` → `retry_wait`）；建立新批次無法繞過名額。
6. **登記狀態不變**：通知後登記仍為 `active`（只寫 `notified_at` 資訊欄位），唯一限制不釋放、本人仍可管理。
7. **重啟**：啟動時 `sending → unknown(interrupted)`、批次 `sending → paused(server_restart)`；**不會自動續送**，由店家按「續送未完成項目」。

### 3.5 發送前重新檢查（預覽、確認、每筆送出前同一套）

功能開關與必要設定、商品存在／啟用／LINE 上架／取餐方式、登記有效（未取消、未過期）、本週期有效同意（未撤回、不需重新確認）、取餐偏好、會員資料存在、可信好友（非好友或不明一律排除）、同週期名額、日期與營業時段、今日／預購額度。商品可訂購判斷只用 `routes/line-orders.js` 既有函式（見第 1 節），沒有另寫通知專用庫存判斷。

| 商品情況 | 通知規則 |
|---|---|
| 正常販售 | 所選日期、方式符合訂購條件才可通知（今日＝「已恢復供應」） |
| 今日完售或今日時段結束 | 今日不可；合法未來日期可通知，訊息為「已開放預購」 |
| 暫停販售／長期下架 | 不可 |
| 停用、LINE 未上架、取餐方式停用 | 不可 |

修改庫存、重置已售、修改商品狀態都不會觸發訊息（P13、S8、S9）。

---

## 4. LINE 發送與回應處理（依 LINE 官方 retry 文件核對）

官方規則（developers.line.biz `retrying-api-request`）：retry key 為 UUID，必須在第一次請求就帶；同一 key 受理後再送會回 409 並附 `x-line-accepted-request-id`；2xx、409 與其他 4xx 不應重試；逾時與 5xx 可用同一 key 重試；**key 自第一次請求起 24 小時有效**。429 的訊息可區分速率限制（The API rate limit has been exceeded）與當月額度（You have reached your monthly limit.）。

| 回應 | C4 處理 |
|---|---|
| 200 | `accepted`，保存 `x-line-request-id` |
| 409＋accepted id／已受理訊息 | `accepted`（`retry_key_already_accepted`），不換 key |
| 409 其他 | `unknown`（`conflict_unclassified`），不換 key、不自動重試 |
| 逾時、連線中斷、5xx | 不視為沒送出；同 key、同內容退避重試（預設 2s／10s／30s，上限 4 次），用盡 → `unknown` |
| 429 速率限制 | 同 key 退避重試；用盡 → `held` |
| 429 當月額度 | `held`，整批暫停（`monthly_limit`） |
| 401／403 | `held`，整批暫停（`auth_error`） |
| 400 等 | `failed`，不重試 |

- 自動與手動重試都只在首次嘗試後 **23 小時內**（24 小時官方期限保留 1 小時安全邊界）；超過者維持 `unknown` 並標示 `retry_window_expired`，不換新 key 補送。
- 每位收件人獨立處理，單人失敗不影響其他人。
- 只保存固定錯誤代碼與 LINE request ID；不保存回應內容、完整權杖或會員憑證（S22）。
- **已交給 LINE 的請求無法撤回**：預覽後的變化只能擋下「尚未送出」的項目；畫面與本報告都以「LINE 已受理」「結果待確認」描述，不宣稱送達。

---

## 5. 訊息與商品直達

訊息（純文字，依實際供應情況）：

```
【{店名}】你登記的商品已恢復供應｜已開放預購
商品：{商品名}
供應日期｜預購日期：{M/D（週X）}
取餐方式：外帶自取｜外送
查看商品並訂購：{連結}
數量有限，實際供應以系統為準；本通知不代表訂單成立，也不保留商品。
如不想再收到此商品的通知，可在點餐頁「我的想買登記」取消。
```

連結：`https://liff.line.me/{line_member_liff_id}?store_id=…&product_ref={product_uuid}&src=restock&m=…&d=…`。不含 `member_session`、LINE UID 或可冒用身分的資料；`m`／`d` 只用於提示文字。

點開後：首屏照常顯示 → 背景以 `product_ref` 取得目前公開商品 → 用最新商品資料開啟詳情（沿用既有販售判斷）。不加入購物車、不送單、不付款，不改既有購物車、姓名、日期、取餐方式；顯示「通知對應：日期 方式，請自行確認」提示。商品不存在、隱藏、停售、無額度時明確提示。網址參數擷取後立即移除。頁面同時帶 Recovery／Handoff token 時，還原優先、不開啟直達。開啟商品不記為訂單轉換。

---

## 6. MBV2 備份、還原與撤回保護

- 新分類 `restock_notify`「補貨通知紀錄」（`restock_notify_batches`、`restock_notify_deliveries`）；完整備份自動包含，選擇性備份可單選。
- 匯出預覽分開顯示：
  - **需求與同意歷史**（想買登記分類）：登記／有效登記、同意／同意中筆數，註明匯入後需顧客重新確認。
  - **批次及已受理紀錄**：批次數、LINE 已受理筆數、防重名額筆數。
  - **執行狀態**：待發送、發送中、待重試、暫停、結果不明。
- 匯入規則：
  1. 匯入、啟動服務、搬家完成都不會呼叫發送（B6、B7、B14）。
  2. 未完成工作一律暫停：批次 → `paused(imported)`（預覽中 → `expired`）；逐筆 `pending/held` → `held`，曾嘗試過的 → `unknown`。
  3. 補貨通知紀錄**只合併、不清除**（完整取代也不清除），同 uuid 跳過；目標已有同週期名額時，匯入列只當歷史（`claim=NULL`）。重複匯入不會新增或再通知（B10）。
  4. 匯入的同意一律 `reconfirm_required=1`；既有同 uuid 的同意不被覆蓋（skip 跳過；merge 欄位不同即衝突不動）→ 目前已撤回者不會被舊備份恢復（B11）。
  5. 管理員操作不能代替顧客同意；顧客重新勾選才會產生新的有效同意。
  6. 商品關聯以 ref_maps／條碼／名稱重新對應；無法唯一對應時補貨紀錄改為 `product_id=0`（未連結），**絕不指向另一款商品**。完整取代重建商品時（含只匯入商品等無關分類），保留下來的補貨紀錄依條碼／名稱重新對應；想買登記沿用 C3.1／C3.2 規則（互換、循環、最終衝突，失敗整批回滾）。
  7. 預覽與正式匯入走同一個 `executeImport`（B3 實測數字一致），失敗整批回滾。
  8. **較舊備份（無通知分類）**：無法證明來源環境「從未通知」。保守做法是所有匯入的同意都需顧客重新確認，管理員無法直接對匯入名單發送；文件限制見第 10 節。
- 商品 `product_uuid` 隨商品備份；匯入時若同店已被占用則不沿用（之後自動補發），不比對、不補值。

---

## 7. 部署設定與預設

| 設定 | 位置 | 預設 | 說明 |
|---|---|---|---|
| `restock_notify_enabled` | 店別 settings（後台「啟用 LINE 補貨通知發送」） | `0` | **C4 新鍵**。C3 的 `product_demand_notify_enabled` 不再作為開關，避免升級後自動啟用。 |
| `line_channel_token` | 既有 | — | 必要；只檢查存在，標示「已設定（未驗證可發送）」 |
| `line_member_liff_id` | 既有 | — | 必要（商品直達連結） |
| `product_demand_enabled` | 既有 | `1` | 想買登記入口，維持原設定 |
| `shop_name` | 既有 | — | 訊息店名（未設定時用店家名稱） |

選用環境變數（全部可不設定）：

| 變數 | 預設 | 用途 |
|---|---|---|
| `RESTOCK_NOTIFY_MAX_ATTEMPTS` | 4 | 每筆最多嘗試次數（1–10） |
| `RESTOCK_NOTIFY_BACKOFF_MS` | `2000,10000,30000` | 退避間隔 |
| `RESTOCK_NOTIFY_LINE_TIMEOUT_MS` | 8000 | 單次 LINE 請求逾時 |
| `RESTOCK_NOTIFY_SEND_INTERVAL_MS` | 100 | 每筆之間的間隔 |
| `RESTOCK_NOTIFY_MAX_INLINE_WAIT_MS` | 60000 | 同一輪內等待退避的上限；超過則批次暫停待續送 |

功能關閉時：顧客端顯示「我想買」；既有登記的查詢、修改、取消與撤回同意照常可用；後台仍可預覽（標示不可發送）與查詢批次。

---

## 8. 測試結果與基準差異

詳細逐項見 `01_TEST_RESULTS.json`。執行日期 2026-11-11（台北）。

### 8.1 實際執行通過

「C4」欄為**從候選 ZIP 全新解壓、`npm ci` 後**執行的結果（Playwright 1.63.0 以 `--no-save` 安裝，只供測試）。程式檔與最終 ZIP 完全相同，最終 ZIP 只多了本文件與兩個 JSON 的內容更新。

| 測試 | C3.3（未修改） | C4 |
|---|---|---|
| **新增** C4 驗收 `…c4-restock-notify.js`（N／C／P／S／R／L／B／K／Z） | 中止：補貨通知 API 不存在（N1）；只跑 C 段為 4 通過／5 失敗後中止（無法建立同意） | **96／96** |
| **新增** `…c4-linepush-compat.js` | 6／12（既有呼叫行為 LC1–LC5、LC12 通過；新能力不存在） | **12／12** |
| C2 預購狀態 `…c1-preorder-status.js` | 93／93 | **93／93** |
| C3 販售狀態＋想買 `…c3-sale-status-demand.js`（台北 22 時） | 328／4 | **328／4**（工作目錄；U14 依新文案調整） |
| 　同上，兩版於台北 23:42–23:47 先後執行 | 250／4 | **250／4**（逐項相同，僅 U14 名稱不同） |
| 　O 段，以一致時鐘（台北 09:30，含 sql.js 時間）重跑 | 12／12 | **12／12** |
| C3.1 `…c3-1-backup-manage-login.js` | 54／54 | **54／54**（R1／R2 斷言調整；台北 00 時後全新 ZIP 重跑） |
| C3.2 `…c3-2-firstpaint-remap.js` | 32／32 | **32／32**（X1-7 斷言調整） |
| C3.3 `…c3-3-restore-cancel.js` | 30／30 | **30／30**（台北 00 時後全新 ZIP 重跑） |
| MBV2 介面 `run-r54-4-mbv2-ui.js` | 19／19 | **19／19**（UI1 分類數 13→14） |
| MBV2 搬家 `smoke-r54-4-mbv2-migration.js` | 121／121 | **121／121** |
| MBV2 系統回歸 `smoke-r54-4-mbv2-system-regression.js` | exit 0 | **exit 0** |
| MBV2 大檔上傳 `smoke-r54-4-mbv2-large-upload.js` | 第 1 次 24／1、第 2 次 25／25 | 第 1 次 24／1、第 2 次 **25／25**（見 8.2） |
| Recovery `run-h1-4-10-phase4b-recovery-full-runtime.js` | exit 0 | **exit 0（43 項）** |
| Recovery 前端 `…phase4b-recovery-frontend-targeted.js` | exit 0 | **exit 0** |
| 會員 `…phase1-liff-identity-runtime.js`／好友 `…required-friend-gate-runtime.js` | exit 0 | **exit 0** |
| 61 支既有回歸（同一清單逐支比對） | 41 支 exit 0 | **41 支 exit 0；非 0 的 20 支與 C3.3 相同** |

### 8.2 既有失敗、本版新增失敗、尚未驗證

- **本版新增失敗：0。**
- **既有失敗（兩版同時間、同項目）**：
  - C3 測試 O1、O6-paused、O6-sold_out_indefinitely、O9：固定今日 12:00 取餐，台北 12:00 後執行會先被 `time_too_early` 擋下；一致時鐘重跑兩版皆 12／12。
  - C3.1 M4-1、C3.3 K3-1／K3-2（Handoff、Recovery）／K9／K10：在台北 **23:30 之後**執行時，今日已無可選取餐時段（「請選擇時間」或先被時間檢查擋下 403）。C3.3 在 23:36–23:41 執行得到**完全相同**的失敗項；台北 00 時後以全新 ZIP 重跑皆通過。
  - C3 測試 S 段的案例數依目前時間產生（深夜少於白天），兩版同時間案例數與結果相同。
  - 61 支回歸中非 0 的 20 支與 C3.3 相同（清單與逐支說明見 JSON）。其中 `run-regression-g1-6-ga4-h1-4-7.js` 在與其他測試並行時多出 2 項 DOM 重繪計時失敗，單獨重跑 C4 與 C3.3 皆為相同 6 項；`static-audit-r48-popup-order-ui.js` 的既有失敗訊息含 `line-order.html` 雜湊，本版修改該檔後雜湊不同、失敗項數相同。
  - `smoke-r54-4-mbv2-large-upload.js`：超大上傳途中連線被重設（status=0）的競態，兩版第 1 次各有 1 項（案例不同）、第 2 次皆全通過。
- 環境備註：`smoke-h1-4-12-popup-real-browser.js`／`…popup-admin-ui-browser.js` 使用 Playwright 內建瀏覽器；第一次在基準上以 Playwright 1.65 執行時找不到對應版本瀏覽器。改裝與本機瀏覽器相符的 1.63.0 後，C3.3 為 36／36 與 425／1（與 C3.3 報告一致），C4 相同。
- **尚未驗證**：LINE App／LIFF 真機、真實 Messaging API、正式 Zeabur（第 10 節）。

### 8.3 既有測試斷言調整（逐條理由，未刪情境、未放寬無關條件）

1. `smoke-r54-4-mbv2-hf1-c3-sale-status-demand.js` U14：通知模式文案依 C4 規格改變（同意文字、未勾選時按鈕「送出想買登記」、說明）。仍檢查入口「🔔 補貨通知我」、預設未勾選、免責文案，並新增不得出現「補貨立即通知我」「登記補貨需求」。
2. `smoke-r54-4-mbv2-hf1-c3-1-backup-manage-login.js` R1／R2：A 的同意以 C3 版本建立並經匯入 → C4 規則下為「需重新確認」（不可作為發送授權）。商品重新對應、份數、B 已撤回等條件不變。
3. `smoke-r54-4-mbv2-hf1-c3-2-firstpaint-remap.js` X1-7：同上理由，A 的同意由 `granted` 改為 `reconfirm_required`；其餘不變。
4. `run-r54-4-mbv2-ui.js` UI1：MBV2 新增「補貨通知紀錄」分類，分類數 13 → 14（仍為精確比對），並新增檢查「商品想買登記」「補貨通知紀錄」兩個名稱都在（C3 曾因相同理由由 12 改為 13）。

另：C3.1 M2-1／M2-2 在 C4 初版失敗（需重新確認的同意沒有撤回按鈕、未綁週期的舊同意顯示為 none）。判定為 C4 的缺陷並修正程式（本人可撤回「需重新確認」的同意；未綁週期的舊同意僅供顯示沿用其狀態），斷言未改。

### 8.4 C4 驗收涵蓋（摘要）

- N：預設關閉（含 C3 舊鍵＝1）、設定缺漏、未授權／偽造 JWT、跨店。
- C：不勾不同意、`false` 不同意、明確同意的完整紀錄、修改份數、撤回、重新同意、取消、取消後新週期、過期後新週期、偽造 UID／店別、跨店 session、無 session、功能關閉仍可撤回、隱藏／關閉收集仍可管理、C3 舊登記與舊版同意、訂單與額度不變。
- P：伺服器名單與 8 種排除、外帶／外送、暫停／長期下架、今日完售＋未來預購（「開放預購」）、今日／預購額度為零、過去／超過可預訂天數／格式錯誤日期與非法取餐方式、取餐方式停用與 LINE 未上架、可用份數少於期望、功能關閉、預覽與改庫存不發送。
- S：5 個並行確認（含第二位管理員）只生效 1 次、retry key 第一次就帶、request ID、登記仍有效、同週期跨批次、修改份數／撤回再同意不重置、資料庫唯一限制、預覽後撤回／新會員／停售／額度耗盡／關閉功能、發送途中撤回、真實逾時（AbortController）、200、已受理但回應遺失（同 key → 409）、逾時＋5xx 後受理、5xx 上限、400、非語意 409、429 速率、單人失敗不影響他人、權杖不外洩、401 整批暫停、429 額度、續送沿用 key、訂單與額度不變。
- R：送出後未寫回即 SIGKILL、重啟後不自動發送且可查詢、續送同 key 得 409、超過 24 小時不補送、預覽逾時。
- L：商品直達（正確商品、網址清理、不改購物車／姓名／日期／取餐方式、不送單）、不存在／隱藏／停售提示、數字 ID 被占用仍正確、Recovery 優先、訂閱 UI、同意後狀態與只取消通知、通知不可用文案、後台預覽→確認→重新整理後仍可查。
- B：分類與預覽分項、完整／選擇性備份、匯入預覽與正式一致、未完成暫停、商品對應、同意需重新確認、匯入／重啟不發送、跨環境防重保留、未完成續送被擋、重複匯入、撤回優先、舊格式完整取代不清除且重新對應、商品 ID 互換完整取代不指錯商品。
- K：C3.3 程式讀取 C4 資料庫（首頁、商品、登記、後台、正式送單）；C3.3 拒絕匯入 C4 完整備份。

### 8.5 LINE 呼叫次數

- 模擬（測試程序內攔截，未連外）：C4 驗收每次完整執行 31 次；linePush 相容測試 12 次（程序內替換 fetch）。
- **真實 LINE API 呼叫：0 次**（所有 `api.line.me` 請求在程序內被攔截；`hf1c3-net-mock` 對任何漏網的 LINE 請求計數＝0；既有測試仍維持「LINE 呼叫 0 次」斷言）。
- 模擬 API、模擬 LIFF 與 Node 函式測試**不是** LINE 真機驗證。

---

## 9. 回退

1. **優先只退程式碼、保留現有資料庫**：重新部署 C3.3 ZIP（`d63a76f9…`），不要用舊資料庫覆蓋部署後新增的訂單。
2. 已實測（K1）：C3.3 可直接使用 C4 升級後的資料庫；新資料表與欄位會被忽略並保留；首頁、商品、想買登記、後台、送單正常。
3. 回退後的行為：通知能力回到 C3.3（不可用），C4 的批次與同意資料保留但不使用；之後再部署 C4，未完成批次維持暫停，不會自動發送。
4. 限制：C3.3 無法匯入 C4 產生的完整備份（含新分類，會明確拒絕，K2）。回退期間如需匯入，請使用 C3.3 匯出的備份，或先只選擇 C3.3 認得的分類重新匯出。
5. 回退前若有批次正在發送：先在後台等待本輪結束（或關閉「啟用 LINE 補貨通知發送」使其暫停），再回退。

---

## 10. 已知限制與尚未驗證

- **尚未驗證**：LINE App／LIFF 真機（含 `liff.state` 轉址帶參數）、真實 Messaging API（真實權杖、配額、好友、送達）、正式 Zeabur、多台伺服器同時連同一資料檔（sql.js 本來就不支援）。
- 「LINE 已受理」不等於顧客收到；封鎖、刪除好友等情況 LINE 仍可能回 200。
- 好友狀態依既有 `line_members.is_friend`（Webhook／登入同步）；狀態過舊時可能誤判，未知者一律排除。
- 匯入舊備份無法證明來源環境從未通知；保守處理為所有匯入同意需顧客重新確認。顧客在新環境重新同意後，如果來源環境曾通知過而備份未含通知紀錄，新環境可能再通知一次。
- 結果不明的項目超過 23 小時不再自動或手動補送，需店家自行判斷。
- 每筆通知內容相同（不個人化），因此重試時收件人與訊息內容完全一致。
- 預覽保留 30 分鐘；逾時需重新預覽。

---

## 11. 測試站最短驗收步驟（店家自己的帳號）

前置：測試站部署 C4；店別設定已有 `line_channel_token`、`line_member_liff_id`（LIFF Endpoint 為 `…/line-order.html?store_id=<店別>`）；自己的 LINE 帳號已加官方帳號好友，且曾以 LINE 會員登入點餐頁（`line_members` 有資料、好友狀態為是）。

1. **確認預設關閉**：後台 LINE 商品管理 → 🙋 想買登記，應看到「LINE 補貨通知：尚未啟用」、「啟用 LINE 補貨通知發送」未勾、權杖「已設定（未驗證可發送）」。手機點餐頁商品按鈕仍為「我想買」。
2. **開啟功能**：勾選「啟用 LINE 補貨通知發送」，顯示「必要設定：完整・目前可用」。
3. **準備商品**：選一個測試商品設為「暫停販售」。
4. **訂閱**：在 LINE App 開啟 LIFF 點餐頁 → 該商品按「🔔 補貨通知我」→ 勾選「商品恢復供應或開放預購時，透過 LINE 通知我。」（預設應未勾）→ 按「登記並訂閱通知」。再開一次應顯示「🔔 已訂閱補貨通知」。
5. **恢復販售並預覽**：商品改回「正常販售」→ 後台想買登記 → 該商品「查看」→ 補貨通知選「外帶自取」與今天 →「預覽通知」。確認：符合資格 1 人（你自己）、排除原因合理、訊息內容與連結正確。
6. **單人發送**：按「確認發送（1 人）」。批次顯示「已完成」「LINE 已受理 1」。在手機確認收到訊息（**這是第一次真實送出，請只對自己的帳號**）。
7. **商品直達**：點訊息中的連結 → 應直接開啟該商品詳情、看到「通知對應：…」提示；購物車、姓名、日期、取餐方式不變；不會自動加入或送單。可照常加入購物車並以現金測試單完成下單（可選）。
8. **不重複**：回後台再預覽同商品 → 你應被排除為「本週期已通知」，無法再發送。
9. **取消通知**：點餐頁「🙋 我的想買登記」→ 管理 →「取消補貨通知（保留想買登記）」，登記仍在；或「取消登記」。
10. **收尾**：如不打算上線，取消勾選「啟用 LINE 補貨通知發送」。

---

## 12. 檔案

| 項目 | 位置 |
|---|---|
| 逐項測試結果、回歸逐支比對、LINE 呼叫次數 | `01_TEST_RESULTS.json` |
| 相對 C3.3 的變更清單與 SHA-256 | `02_FILE_MANIFEST.json` |
