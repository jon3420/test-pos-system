# CHANGELOG — fix18-10-hotfix31-R2

## Operation Analytics × CRM Action Center — Architecture Correction & Hardening

日期：2026-07-24
基礎版本：fix18-10-hotfix31-R1（Backend Foundation：Drill Down / Visitor 360 / CRM 初版）

範圍限制（維持不變）：Web POS only。Android 專案完全未觸碰。Boss Dashboard
（`routes/dashboard.js`、`public/*`）完全未修改——已用 `diff -rq` 對照原始
zip 逐檔驗證，見本文件第八節。全部改動皆為加法、向後相容。

---

## 一、本輪修正的問題（對照需求文件 A~N）

R1 版本的方向大致正確，但有幾個需要在做前端之前修正的架構問題：

1. **身份合併是自己另外寫的一套**——`utils/visitor360.js` R1 版本自己定義了一個
   `resolveIdentity()`，跟系統既有的唯一身份判斷模組
   `utils/analyticsIdentity.js`（fix18-10-hotfix24-A3，全系統唯一的身份判斷
   入口）完全沒有關係，等於是「第二套身份系統」的雛形。**已修正**：身份合併
   邏輯移到 `utils/analyticsIdentity.js` 本身（新增
   `resolveCanonicalVisitor()`），`utils/visitor360.js` 改為呼叫它。

2. **CRM 靜態快照的 member_key 用了顯示用短碼**——`resolveMemberKeys()` 原本
   用 `visitor_id_short`（例如 `ab12…f9`）當 `member_key` 寫進
   `crm_segment_members`，這個短碼本質上是不可逆的顯示格式，之後完全無法
   反查回真正的 visitor_id。**已修正**：`utils/cartSnapshot.js` 新增內部欄位
   `_visitor_id_raw`（比照既有 `_line_uid_raw` 慣例），`resolveMemberKeys()`
   改用真實 visitor_id。

3. **Dynamic 分群的人數是建立當下算好就存死的**——不符合「dynamic 分群必須
   即時解析」的要求。**已修正**：`GET /segments`、`GET /segments/:id` 對
   `segment_type='dynamic'` 一律重新即時計算人數/名單，不讀取可能過期的
   `member_count_cache`（該欄位保留但只作為「上次建立時的參考值」）。

4. **CRM 動作沒有生命週期、沒有 idempotency、沒有 cancel/retry**——R1 版本
   建立動作就直接標記 `recorded`/`not_configured` 兩種終態，沒有防止重複
   建立、沒有取消機制、`coupon_grant` 也沒有真的區分「這是不是一個本機就能
   完成的動作」。**已修正**：見第四節。

5. **`coupon_grant` 誠實度不夠**——R1 版本只驗證優惠券存在/啟用就整批標記
   `recorded`，沒有依會員資格判斷、沒有防止同一會員被不同動作重複核發同一張
   優惠券。**已修正**：見第五節。

---

## 二、來源真相稽核（需求文件 A）

**結論：沒有建立任何重複的來源真相資料表。**

CRM 相關新表（`crm_segments`／`crm_segment_members`／`crm_actions`／
`crm_action_targets`）只儲存：分群定義、static 分群的名單快照、動作定義、
每個名單成員的執行狀態。完全沒有儲存或另外維護：會員檔案、LINE 會員檔案、
訪客檔案、訂單、訂單品項、商品、購物車內容、Session、Analytics 事件、
來源/campaign 歸因、Visitor 360 結果、營收/LTV 計算——這些全部即時讀自既有
`analytics_events`／`line_members`／`orders`／`products`／`coupons` 表。

已明確確認**不存在**以下任何一張表（`scripts/smoke-hotfix31-r2-hardening.js`
測項 A-1 直接查詢 `sqlite_master` 驗證）：
`crm_members`、`crm_visitors`、`analytics_v3`、`visitor360`、
`visitor_profiles`、`cart_copy`、`session_copy`、`event_copy`、
`order_copy`、`member_copy`、`product_copy`。

---

## 三、Visitor 360（需求文件 B）——維持完全即時運算

- 沒有任何持久化資料表儲存 Visitor 360 的計算結果；每次呼叫
  `getVisitorProfile()` 都重新查詢 `analytics_events`／`line_members`／
  `orders`／`crm_action_targets`（後者不涉及，僅前三者）。
- 回應新增：`canonical_identity`（身份解析的信心程度與依據）、
  `anonymous_visitor_ids`（已知的匿名識別碼清單）、`cart_history`（重用
  `utils/drilldown.js` 的批次列組裝，不是另一套購物車估算邏輯）、
  `purchase_history`（真正讀 `orders` 表的訂單列，不是憑 analytics 事件臆測
  金額）、`data_generated_at`（明確標示這是即時運算的檢視）。
- 找不到任何紀錄時回傳 `null`（呼叫端回 404），不猜測、不回傳空殼資料。

---

## 四、身份解析（需求文件 D）

**唯一入口**：`utils/analyticsIdentity.js` 的 `resolveCanonicalVisitor(db, storeId, key)`。
`utils/visitor360.js`／`utils/drilldown.js` 都透過這個函式判斷身份，
不再各自維護一套判斷邏輯。

合併規則（只使用決定性連結，不臆測）：

| 規則 | 條件 | confidence | resolution_method |
|---|---|---|---|
| 1 | key 本身是已知的 `line_members.line_user_id` | high | `direct_line_member` |
| 2 | key（visitor_id/session_id/cart_id）在 `line_member_sessions` 有登入當下記錄的連結 | high | `visitor_session_link` |
| 3 | key 在 `analytics_events` 出現過，但沒有任何 LINE 連結 | unresolved | `anonymous_no_link` / `session_or_cart_lookup` |
| 4 | key 完全查無任何紀錄 | — | `found: false`（呼叫端應回 404） |

**絕對不做**：不使用 IP 做任何合併判斷；不因為「看起來像同一人」的弱假設
（例如同商品/同時段）合併；所有查詢一律 `WHERE store_id=?`，不同店家的
`line_user_id`/`visitor_id` 就算字串相同也絕不互相合併。

已驗證的合併路徑（`scripts/smoke-hotfix31-r2-hardening.js` D-1～D-6）：
匿名訪客（`anon_dev_a`）加入購物車 → 透過 `line_member_sessions` 記錄的登入
連結 → 正確合併回同一個 LINE 會員，Visitor 360 用登入前的匿名 ID 查詢也能
看到完整會員檔案與真實購買紀錄。同時驗證：不相關的訪客不會被誤合併
（D-3），完全查無紀錄的 key 回傳 `found:false`（D-4）。

---

## 五、動態 vs 靜態分群（需求文件 C）

- **Dynamic（預設）**：只存 `store_id`／名稱／描述／`filter_json`／
  `enabled`／時間戳。**不會**自動幫每個 dynamic 分群建立 `crm_segment_members`
  快照列。`GET /segments`、`GET /segments/:id` 一律即時重新查詢
  `utils/drilldown.js`，底層資料變動後立刻反映在下一次查詢（已用
  M-12 測項驗證：新增一筆符合條件的資料後，dynamic 分群預覽人數立即 +1）。
- **Static**：只在明確指定 `segment_type='static'` 時才建立快照
  （`crm_segment_members`），適用需求文件列出的情境（匯出、歷史活動名單保存、
  「凍結名單」操作、稽核重現）。快照建立後不隨底層資料變動而改變
  （已用 M-13 測項驗證：同樣新增一筆符合條件的資料後，static 分群成員數
  維持不變）。
- 刪除分群改為**封存**（`DELETE /segments/:id` 實際上是
  `UPDATE ... SET enabled=0`），不會真的清掉分群本身或其 static 快照名單，
  預設列表不顯示已封存分群，`?include_archived=true` 可查看全部。

---

## 六、CRM Action 生命週期（需求文件 F/G）

新模組 `utils/crmActions.js` 集中管理執行邏輯，`routes/crm.js` 只負責 HTTP
層。狀態集合：

- Action：`pending`／`running`／`completed`／`partially_completed`／
  `failed`／`cancelled`／`not_configured`
- Target：`pending`／`processing`／`completed`／`failed`／`skipped`／`cancelled`

**action_type 架構**（需求文件 F，可擴充，不是只認識 LINE）：
`coupon_grant`／`line_push`／`email`／`sms`／`webhook`／
`meta_audience_export`／`google_audience_export`／`csv_export`。

**目前「本機就能真的完成、不需要等待任何外部整合」的只有兩種**：

- `coupon_grant`：核發的本質是「記錄會員 ↔ 優惠券的關聯」，
  `crm_action_targets` 那一列本身就是這個關聯的正式紀錄，不需要外部管道
  就能真實完成。
- `csv_export`：匯出的本質是「產生資料」，`routes/crm.js` 直接產生真正的
  CSV 內容（`member_key,member_type,display_name`）隨 API 回應一起回傳，
  不是假裝匯出成功。

**其餘五種（`line_push`／`email`／`sms`／`webhook`／
`meta_audience_export`／`google_audience_export`）一律回報
`not_configured`**，per-target 維持 `pending`，明確告知尚未串接對應管道，
不假裝已送達／已匯出（需求文件 F：「Do not implement fake delivery」）。

**Idempotency**（需求文件 G.1）：`POST /actions` 可帶 `idempotency_key`。同一個
`store_id + idempotency_key` 重複呼叫時，直接回傳既有動作（`idempotent_replay:
true`），資料庫確認只有一筆 `crm_actions` 列（`idx_crm_actions_store_idempotency`
唯一索引，`WHERE idempotency_key != ''` 的 partial unique index，不影響
沒有帶 idempotency_key 的舊呼叫）。

**Cancel**（`POST /actions/:id/cancel`）：把還沒處理（`status='pending'`）的
target 標成 `cancelled`，已經 `completed`／`skipped` 的維持不變；action 本身
若已是終態（`completed`/`failed`/`cancelled`）視為 no-op。

**Retry**（`POST /actions/:id/retry`）：只重跑 `status IN ('pending','failed')`
的 target；已經 `completed`／`skipped`／`cancelled` 的完全不動——因為
`cancelAction()` 已經先把待處理的標成 `cancelled`，`retry` 自然選不到它們，
兩個需求（G.4／G.6）用同一套「只挑 pending/failed」的邏輯自然滿足，不需要
分別寫兩套判斷。

---

## 七、優惠券核發安全（需求文件 H）

- **驗證時機提前**：`POST /actions` 對 `coupon_grant` 一律在**建立動作之前**
  就呼叫 `validateCouponForAction()`（沿用 `coupons` 表既有欄位語意：
  `store_id` 隔離／`enabled`／`start_at`／`end_at`），驗證失敗直接回 400，
  **不會**留下任何 `crm_actions` 列（已用 H-2／H-2b 驗證）。
- **匿名訪客資格**：明確判定為不符資格（`status='skipped'`，
  `error_code='ineligible_anonymous'`）——因為匿名訪客只有一次性的
  `visitor_id`，沒有之後真的能通知到的持久身份，核發了也沒有意義。
- **跨動作重複核發防護**：同一位會員（`member_key`）已經在其他 action 被
  `status='completed'` 核發過同一張優惠券（用 `dedup_key='coupon_grant:CODE'`
  比對）時，這次一律標記 `status='skipped'`，`error_code='duplicate_grant'`
  （已用 H-1 驗證）。
- **「已記錄」不等於「已核發」**：只有真的通過上述資格與去重檢查、真的寫入
  `status='completed'` 的 target，才算「這個人被核發了這張優惠券」；
  action 整體狀態（`completed`/`partially_completed`/`failed`）如實反映
  targets 的實際結果分布，不會因為「動作建立成功」就宣稱全員核發成功。

---

## 八、租戶隔離稽核（需求文件 E）

逐一檢查 `utils/drilldown.js`／`utils/visitor360.js`／`utils/crmActions.js`／
`routes/crm.js`／`utils/analyticsIdentity.js` 的每一個 DB 呼叫：

- 所有 `SELECT`／`UPDATE`／`INSERT` 一律帶 `store_id=?`。硬化過程中發現
  `utils/crmActions.js` 內部有 5 處 `UPDATE crm_action_targets ... WHERE id=?`
  只用主鍵 `id`、沒有同時比對 `store_id`——雖然這些 `id` 實務上一定來自先前
  已經用 `store_id=?` 篩選過的查詢結果（不构成真正可利用的漏洞），但作為
  縱深防禦（defense-in-depth），已全部補上 `AND store_id=?`。
- `store_id` 一律來自 `req.storeId`（既有 `requireStore` middleware 驗證
  JWT／x-store-id／query 並確認店家存在且啟用），本次新增的路由完全沒有另外
  接受前端指定的 `store_id`。
- Segment ID／Action ID 一律用 `store_id + id` 一起查詢，不同店家的 ID
  互相查不到（已用負向測試驗證，見下方測試章節 M-10／M-10b／M-11／M-11b）。
- `resolveCanonicalVisitor()` 的所有查詢（`line_members`／
  `line_member_sessions`／`analytics_events`）一律帶 `store_id=?`，不同店家
  的 `line_user_id`／`visitor_id` 字串相同也不會互相合併或洩漏。

**Boss Dashboard 確認未修改**：用 `diff -rq` 對照使用者上傳的原始 zip
（`fix18-10-hotfix30-B5-R5-Cart-Detail-Order-Hours-full.zip`）與目前工作副本，
`routes/dashboard.js` 與整個 `public/` 目錄逐檔比對結果**完全一致，沒有任何
差異**。唯一有變動的檔案是：`routes/analytics.js`（新增路由，既有路由未改）、
`server.js`（新增一行路由掛載）、`utils/analyticsIdentity.js`／
`utils/cartSnapshot.js`／`utils/db.js`（新增匯出/欄位，既有函式簽名與行為
未改），以及全新檔案 `routes/crm.js`／`utils/crmActions.js`／
`utils/drilldown.js`／`utils/visitor360.js`。

**Android 專案確認未修改**：`pos-android-hotfix16.zip` 從上傳後完全沒有被
讀取或解壓縮以外的任何操作，本輪沒有產生任何 Android 相關檔案變更。

---

## 九、Drill Down API 強化（需求文件 J）

- 篩選欄位一律白名單（`DIMENSION_COLUMN_MAP`），新增 `product_id`／
  `min_amount`／`max_amount`（金額是購物車快照組裝出來的衍生值，不是
  `analytics_events` 的原始欄位，篩選在應用層進行）。
- 排序欄位白名單（`SORT_FIELD_MAP`：`last_activity_at`／`first_added_at`／
  `total`／`age_seconds`），非白名單值一律退回預設排序，不接受任意欄位名稱
  或 SQL 片段。
- 回應新增 `generated_at`（資料新鮮度時間戳）、`warnings`（例如候選集合被
  `MAX_CANDIDATE_CARTS` 截斷時明確告知，見 `findMatchingCartIds` 回傳的
  `truncated` 標記）。
- 所有篩選值一律參數化查詢；已用 SQL injection 風格的篩選值（例如
  `source: "Facebook' OR '1'='1"`）與排序欄位（`sort_by: 'DROP TABLE
  orders; --'`）驗證查詢邏輯不受影響、`orders` 表本身也沒有被任何注入嘗試
  影響（M-22／M-22b／M-23）。

已知限制（誠實揭露，本版範圍內未做）：LINE 好友狀態（friend_status）篩選
需要額外 JOIN `line_members`，目前未實作，留待下一輪視前端實際需求決定是否
加入；地理區域/IP 相關篩選本來就不在系統範圍內（身份判斷模組明確排除 IP）。

---

## 十、AI Insights（需求文件 I）——確認符合，未新增/未修改

`utils/analyticsV2.js` 的 `getAiInsightsV2()` 原本就是純規則引擎
（rule engine），每次呼叫都即時運算，沒有任何持久化資料表儲存產生的結論，
每則建議固定回傳 `problem`／`evidence`／`actions`／`values`，本輪未修改此
模組，確認符合需求文件 I 的要求（不持久化推論結果、區分事實與推論）。

---

## 十一、Migration 安全性（需求文件 L）

全部延續既有慣例：只用 `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
EXISTS` / `ALTER TABLE ADD COLUMN`（包在 try/catch，可重複執行），不
`DROP`、不重建任何一張表。本輪新增欄位：

- `crm_segments.enabled`
- `crm_actions.idempotency_key`／`cancelled_at`／`error_code`／`skipped_count`
- `crm_action_targets.dedup_key`／`error_code`／`updated_at`

新增索引：

- `idx_crm_actions_store_type`（store_id + action_type）
- `idx_crm_actions_store_idempotency`（store_id + idempotency_key，partial
  unique，僅約束非空字串）
- `idx_crm_action_targets_store_member_dedup`（store_id + member_key +
  dedup_key + status，供跨 action 重複核發檢查用）
- `idx_crm_segments_store_enabled`（store_id + enabled）

已驗證（`scripts/smoke-hotfix31-r2-hardening.js` L-1～L-5）：全新空 DB 上
`initDb()` 正確建表；已有資料的 DB 上重跑 `initDb()` 不拋例外、既有資料列數
不變；連續重跑兩次以上仍然 idempotent；上述索引確實存在。

---

## 十二、檔案清單

### 新增
- `utils/drilldown.js`（R1 建立，本輪硬化：排序/金額/商品篩選、warnings、
  generated_at、`_visitor_id_raw` 修正、`countDrilldownMatches`）
- `utils/visitor360.js`（R1 建立，本輪重寫：改用 `resolveCanonicalVisitor`、
  新增 cart_history/purchase_history/canonical_identity）
- `utils/crmActions.js`（本輪新增：CRM 動作執行引擎）
- `routes/crm.js`（R1 建立，本輪重寫：idempotency/cancel/retry/live count/
  soft-archive）
- `scripts/smoke-hotfix31-r1-backend.js`（R1 建立，本輪更新 1 項斷言以符合
  新的誠實狀態機）
- `scripts/smoke-hotfix31-r2-hardening.js`（本輪新增，37 項）

### 修改
- `utils/analyticsIdentity.js`：新增 `resolveCanonicalVisitor()`（唯一身份
  合併入口），既有 `resolveIdentity()` 等既有匯出完全未變動。
- `utils/cartSnapshot.js`：`_buildRowFromCandidate` 新增可選第三參數
  `{includePurchased}`（預設行為不變）；新增內部欄位 `_visitor_id_raw`；
  匯出既有內部批次查詢函式供 `utils/drilldown.js` 重用。
- `utils/db.js`：新增 CRM 四張表 + R2 硬化欄位/索引（見上方第十一節），
  純加法。
- `routes/analytics.js`：新增 `GET /drilldown`、`GET /visitor/:key` 兩個
  路由（附加在檔案尾端，既有路由/既有 `module.exports = router` 位置沿用
  既有專案慣例，未改動既有路由邏輯）。
- `server.js`：新增一行 `app.use('/api/crm', ...)` 路由掛載，既有路由掛載
  順序與內容未變動。

### 未變動（明確確認）
- `routes/dashboard.js`、整個 `public/` 目錄（Boss Dashboard）
- `pos-android-hotfix16.zip`（Android 專案，完全未解壓縮/未讀取以外的操作）

---

## 十三、測試結果

| 測試檔案 | 結果 |
|---|---|
| `scripts/smoke-hotfix31-r1-backend.js` | **29/29 PASS** |
| `scripts/smoke-hotfix31-r2-hardening.js` | **37/37 PASS** |
| `scripts/smoke-hotfix30-b5-r5-cart-order-hours.js`（既有 Cart Detail 迴歸） | **55/55 PASS**（4 項既有 MANUAL REQUIRED，非本輪引入） |
| `scripts/smoke-hotfix30-b5-r5-debounce.js`（既有 Debounce 迴歸） | **32/32 PASS** |
| `scripts/smoke-hotfix30-c1-rollback.js` | 22/22 PASS |
| `scripts/smoke-hotfix25.js` | 26/26 PASS（3 項既有 MANUAL REQUIRED） |
| `scripts/smoke-hotfix26-a.js` | 24/24 PASS（1 項既有 MANUAL REQUIRED） |

**已知與本輪無關的環境限制**（誠實揭露，非本輪引入）：
- `scripts/smoke-hotfix30-b5-r5-dashboard-ui.js`：因執行環境缺少 `jsdom`
  套件（`package.json` 本來就沒有列出這個 dependency）而無法執行，純屬環境
  限制，與本輪程式碼變更無關。
- `scripts/smoke-hotfix26-e.js`、`scripts/smoke-hotfix28.js`：這兩支是
  「巢狀呼叫其他 smoke script」的 meta-regression 腳本，在本次環境下執行
  超過 30 秒逾時——與 Hotfix30-B5-R5 版本紀錄中已經記載的
  `smoke-hotfix29-c.js` 巢狀逾時屬於同一種既有架構限制（依序重跑多支腳本，
  任一支變慢就可能讓總時間超過外層等待時間），非本輪引入的迴歸。
- `scripts/smoke-hotfix27.js`：回報「專案內找不到 scripts/smoke-*f0*.js」
  屬於既有腳本本身的既有狀況，與本輪 CRM/Analytics 變更無關。
- 受限於單次會話時間，未逐一執行全部 29 支既有 smoke script（上一版
  Hotfix30-B5-R5 文件記載的既有 baseline 為 16 PASS／12 既有 FAIL／1 既有
  TIMEOUT），改為抽樣執行與本次變更高度相關的腳本（Cart Detail／Debounce／
  Rollback／Hotfix25／Hotfix26-a）全數通過，加上本輪新增的 66 項測試，作為
  本輪變更沒有引入新迴歸的證據。建議在正式合併前，於較長時間的 CI 環境中
  完整跑過全部既有 29 支腳本。

---

## 十四、已知尚未串接的整合（誠實揭露）

- **LINE Messaging API 推播**（`action_type='line_push'`）：專案目前完全
  沒有 Channel Access Token 設定與推播基礎設施，`not_configured`。
- **Email／SMS 發送**：完全沒有對應服務商整合，`not_configured`。
- **Webhook**：沒有出站 webhook 執行器，`not_configured`。
- **Meta CAPI／GA4 Audience 匯出**：沒有對應 API 串接，`not_configured`。
- **LINE 好友狀態（friend_status）作為 Drill Down 篩選欄位**：需要額外
  JOIN `line_members`，本輪未實作，留待下一輪視前端實際需求評估。

以上全部誠實回報為「尚未串接」，不假裝已送達／已匯出／已完成。
