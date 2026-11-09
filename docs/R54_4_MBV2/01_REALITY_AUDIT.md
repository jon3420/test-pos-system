# R54.4-MBV2 Reality Audit（資料備份／搬家 V2）

起點：`P3CD_DEPLOY_R54_4_POPUP_SESSION_SWITCHER_AND_SALES_SETTINGS_COPY_CONSISTENCY_HOTFIX_FINAL_APP_ROOT.zip`
SHA-256 `27667eda66658af84dc35e495d1232030f8d042c56352e4a86ea7e1651cef80d`（與 R54.4-C1 報告記載一致）。
Flat app root（根目錄直接有 `server.js`、`package.json`），864 entries。

本稽核在修改產品檔之前完成。schema 不是從原始碼推測，而是以真實 `utils/db.js` 初始化一個暫存資料庫後，用 `PRAGMA table_info` / `index_list` 讀出（54 張表 + 路由 lazy 建立的 `discount_categories`、`discount_campaigns`、`print_jobs`、`migration_logs`）。

## 1. 輸入檔案狀態

| 項目 | 狀態 |
|---|---|
| R54.4 原始版本 | ✅ 已提供並解壓（上方 SHA） |
| 「256MB 上傳修改版本」 | ❌ **未提供**。R54.4 內 `utils/migrationUploadLimit.js` 仍是預設 25MB／上限 100MB。本次直接在 R54.4 上實作 192／256MB，未沿用任何外部版本。 |
| 2026/10/07 歷史 JSON | ❌ **未提供 — 待確認** |
| 2026/11/09 最新 JSON | ❌ **未提供 — 待確認** |
| 合併救援 JSON | ❌ **未提供 — 待確認** |
| 合併稽核報告 | ❌ **未提供 — 待確認**（專案文件與過往對話中也查無） |

## 2. 現有架構

| 項目 | 實際情況 |
|---|---|
| 專案根目錄 | ZIP 根目錄即 app root |
| package.json | `foodtruck-pos`，`node server.js`；資料庫為 **sql.js**（整份 SQLite 載入記憶體） |
| server.js | 全域 JSON parser 5MB；`isMigrationImportPath()` 讓兩條舊搬家路徑略過全域 parser；統一 JSON 錯誤處理（413 → `MIGRATION_FILE_TOO_LARGE`） |
| utils/db.js | `DB_PATH = process.env.POS_DB_PATH \|\| <app>/data/pos.db`；`runDurableTransaction()`（temp＋fsync＋rename 原子替換）；一般 `db.run()` 每次寫入都會 `export()` 整份 DB 並覆寫檔案 |
| 搬家路由 | `routes/migration.js`（2450 行）：`/migration/config`、`/migration/export`、`/migration/export/preview`、`/migration/import/preview`、`/migration/import`、`/export/orders`、`/import/orders`、`/export/preorders`、`/import/preorders` |
| 掛載 | `app.use('/api', requireStore, require('./routes/migration'))` |
| storeGuard | `requireStore`：JWT → **x-store-id header** → **?store_id=**，後兩者不需任何憑證（Android POS 相容用）；`requireStaffJwt`：只信任 JWT |
| featureGate | 搬家路由沒有 feature gate |
| 前端 | `public/index.html` 設定頁 `#stab-migration`；`public/js/app.js` 14253–14634（`exportMigrationFile`、`onMigrationFileSelected`、`executeMigrationImport`…） |
| 既有 regression | `scripts/smoke-hotfix29-c2-migration-upload.js`（63 項，斷言 25MB／100MB）；`run-h1-4-10-friend-sec-mig-runtime.js`（好友狀態覆寫保護） |

## 3. 稽核發現（依嚴重度）

### 嚴重

1. **未登入即可匯出或清空整店資料。** 舊搬家路由掛在 `requireStore` 之下，只要帶 `x-store-id: store_001`（或 `?store_id=store_001`）就能：
   - `GET /api/migration/export` 下載全店訂單、顧客電話、LINE 會員、`settings`（含 `line_channel_secret`、`pos_password` 雜湊）；
   - `POST /api/migration/import` 以 `mode=replace` 清空店家資料。
   - 已以真實伺服器驗證（測試 A1–A4）：修正前可下載、修正後回 401。
2. **舊版「清空本店後還原」會重設店家密碼。** replace 模式 `DELETE FROM settings WHERE store_id=?` 會刪掉 `pos_password`；備份檔若沒有該 key（或跨店匯入帶入他店的 key），登入密碼會變成預設值（= store_id）或他店密碼。
3. **舊版匯入改寫訂單主鍵，讓操作紀錄失聯。** `buildOrderSrc` 把 `orders.id` 改成 `store_id + '_' + order_number`，但 `order_logs.order_id`、`popup_order_allocations.order_id`、`line_member_order_links.order_id`、`coupon_redemptions.order_id` 仍指向原本的 UUID。
4. **舊版匯入遺失約 50 個訂單欄位。** 匯入白名單只有約 60 欄，`orders` 實際 105 欄。遺失的包括 `refund_status`、`refund_note`、`refunded_at`（退款）、`line_user_id`、`coupon_code`、`fulfillment_type`、`shipping_*`、`delivery_lat/lng`、`popup_*_snapshot`（快閃）等。
5. **持久化設定陷阱。** `.env.example` 列出 `DB_PATH`，但程式**只讀 `POS_DB_PATH`**。如果正式站只設了 `DB_PATH=/data/pos.db`，資料庫實際仍寫在容器內 `<app>/data/pos.db`，重新部署就會遺失。這是「重新部署後訂單遺失」的**可能**成因之一；正式站實際設定**待確認**（本環境無法讀取 Zeabur 設定）。
6. **大型匯入可能讓整個 POS 程序結束。** 實測：heap 512MB 的 Node 程序解析 185MB 備份時 V8 OOM abort（`FATAL ERROR: Reached heap limit`），所有收銀／LINE 點餐同時中斷。

### 高

7. **舊備份漏掉多類資料**：`coupons`、`coupon_redemptions`、全部快閃表（`popup_*`）、`store_business_calendar`、`payment_methods`、`payment_gateways`、`line_member_tags`、`line_member_order_links`、`line_friend_events`、`line_member_sessions`、`geo_visit_log`、`customers`、`crm_segments`。
8. 舊匯出 `ingredient_logs` 每 200 個食材一批 `LIMIT 5000`，食材紀錄多時會**被截斷**。
9. 舊匯出讀取不存在的 `inventory`、`delivery_fees` 表（永遠是空陣列）。
10. 舊匯入的商品以 `(store_id, name)` 判重，但 `products` **沒有**這個唯一索引，預設種子資料本身就有兩筆「滷蛋」；同名商品會被合併成一筆。
11. 舊匯入以整份 `express.json` 解析，沒有記憶體保護；舊前端先 `readJsonFile()` 在瀏覽器解析整份檔案，再把整份 JSON 上傳兩次（預覽一次、匯入一次）。

### 中

12. `orders.created_at` 時區不一致：LINE／快閃訂單以台北時間字串寫入（`twNow()`），POS 收銀建單使用 DB 預設 `datetime('now','localtime')`，取決於容器 TZ（Zeabur 預設推測為 UTC）。**待確認**正式站 `TZ`。
13. 每次寫入都 `export()` 整份 DB：資料庫越大（例如大量 Analytics 事件）每筆訂單寫入越慢。實測 25.5 萬筆事件使 DB 檔增加到 268MB。
14. 商品圖片存放在 `public/uploads/`（容器檔案系統），資料庫只有網址；圖片檔不在任何備份內，重新部署同樣會遺失。

## 4. 資料表 × 分類對照表

欄位說明：**PK** 實體主鍵；**業務鍵** V2 判斷「是否同一筆」所用；**店** 是否有 `store_id`；**單獨匯出／匯入** 該分類可單獨進行；**相依** 匯入時需要對應的資料；**量** 是否可能大量。

| 資料表 | 分類 | PK | 業務鍵（V2） | 店 | 外鍵／邏輯關聯 | 單獨匯出 | 單獨匯入 | 相依 | 圖片／大量 |
|---|---|---|---|---|---|---|---|---|---|
| products | 商品資料 | id INT AI | 同 id＋同名 → 條碼（目標唯一）→ 名稱（目標唯一）；新商品以來源 id 區分 | ✓ | category_id→categories | ✓ | ✓ | 分類（以名稱對應，找不到清空 category_id，保留 category 文字） | 圖片網址（image／line_image_url／shipping_image_url），無內嵌 |
| product_analysis_groups | 商品資料 | id INT | group_name | ✓ | — | ✓ | ✓ | — | — |
| product_analysis_group_items | 商品資料 | id INT | (group, product) | ✓ | group_id、product_id | ✓ | ✓ | 群組、商品 | — |
| product_analysis_group_aliases | 商品資料 | id INT | (group, alias_name) | ✓ | group_id | ✓ | ✓ | 群組 | — |
| categories | 商品分類 | id INT | name（唯一索引 store_id,name） | ✓ | — | ✓ | ✓ | — | — |
| orders | 訂單紀錄／LINE 預購 | id TEXT（UUID） | (store_id, order_number)；id 全域唯一，被他店占用時改配新 UUID | ✓ | popup_session_id、popup_campaign_id；items JSON 為快照 | ✓（可依日期） | ✓ | 無（快照自足） | 可能大量 |
| order_logs | 訂單紀錄 | id INT | (order_id, action, created_at, before/after_total, reason) | ✓ | order_id→orders.id | 隨訂單 | 隨訂單 | 訂單 | — |
| coupon_redemptions | 訂單紀錄 | id INT | order_id（唯一索引 store_id,order_id） | ✓ | coupon_id→coupons、order_id | 隨訂單 | 隨訂單 | 訂單＋優惠券（以 coupon_code 對應） | — |
| ingredients | 食材與扣料公式 | id INT | name（唯一索引 store_id,name） | ✓ | — | ✓ | ✓ | — | — |
| product_ingredient_formulas | 食材與扣料公式 | id INT | (product, ingredient) | ✗（經 products） | product_id、ingredient_id | ✓ | ✓ | 商品＋食材（名稱／條碼對應） | — |
| ingredient_batches | 食材與扣料公式 | id INT | (ingredient, batch_no, purchase_date, created_at, quantity) | ✗（經 ingredients） | ingredient_id | ✓ | ✓ | 食材 | — |
| ingredient_thaw_batches | 食材與扣料公式 | id INT | (ingredient, started_at, amount, created_at) | ✗（經 ingredients） | ingredient_id | ✓ | ✓ | 食材 | — |
| coupons | 折扣活動 | id INT | code（唯一 store_id,code） | ✓ | — | ✓ | ✓ | — | — |
| discount_categories | 折扣活動 | id INT | name | ✓ | — | ✓ | ✓ | — | — |
| discount_campaigns | 折扣活動 | id INT | name | ✓ | orders.discount_campaign_id 為快照 | ✓ | ✓ | — | — |
| inventory_logs | 庫存異動 | id INT | (product_name, action, created_at, change, after, order_id) | ✓ | product_id（找不到則清空，保留名稱） | ✓ | ✓ | 商品（軟相依） | 歷史 |
| ingredient_logs | 庫存異動 | id INT | (ingredient, log_type, created_at, change_amount, batch_no) | ✗（經 ingredients） | ingredient_id | ✓ | ✓ | 食材（必要） | 歷史 |
| line_members | LINE 會員 | id INT | (store_id, line_user_id) | ✓ | first_product_id、merged_into_id | ✓ | ✓ | — | 含電話／Email（PII） |
| line_member_tags | LINE 會員 | id INT | (line_user_id, tag_code) | ✓ | line_user_id | ✓ | ✓ | — | — |
| line_member_history | 會員歷程 | id INT | (line_user_id, event, created_at, old, new) | ✓ | line_user_id | ✓ | ✓ | 會員（邏輯） | 歷史 |
| line_member_order_links | 會員歷程 | id INT | order_id（唯一 store_id,order_id） | ✓ | order_id | ✓ | ✓ | 訂單（邏輯） | — |
| line_friend_events | 會員歷程 | id INT | (line_user_id, event_type, event_at, source, created_at) | ✓ | member_id→line_members.id | ✓ | ✓ | 會員（以 line_user_id 重新對應） | 歷史 |
| line_member_sessions | 會員歷程 | id INT | (line_user_id, visitor_id) | ✓ | — | ✓ | ✓ | — | — |
| analytics_events | Analytics 事件 | id INT | event_uuid（若有）→ (event, order_id)（＝唯一索引）→ 登入事件 (event, identity_key, created_at) → (event, session, cart, product, created_at, visitor) | ✓ | product_id（找不到則清空）、order_id | ✓（可依日期） | ✓ | 商品（軟相依） | **大量**（實測 25.5 萬筆＝185MB） |
| geo_visit_log | Analytics 事件 | id INT | source_event_id → (visitor, session, event, event_time) | ✓ | order_id | ✓（可依日期） | ✓ | — | 大量 |
| popup_locations | 快閃取餐 | id TEXT | id | ✓ | — | ✓ | ✓ | — | — |
| popup_campaigns | 快閃取餐 | id TEXT | id；public_code 全域唯一 | ✓ | — | ✓ | ✓ | — | — |
| popup_sessions | 快閃取餐 | id TEXT | id；public_code 全域唯一 | ✓ | campaign_id、location_id | ✓ | ✓ | 活動（必要）、地點（軟） | — |
| popup_session_products | 快閃取餐 | id INT | (session, product) | ✓ | session_id、product_id | ✓ | ✓ | 場次＋商品 | — |
| popup_session_product_sales | 快閃取餐 | id INT | (session, product) | ✓ | session_id、product_id | ✓ | ✓ | 場次＋商品 | — |
| popup_order_allocations | 快閃取餐 | id INT | (session, order, product) | ✓ | session/order/product | ✓ | ✓ | 場次＋商品＋訂單 | — |
| popup_session_change_logs | 快閃取餐 | id INT | (session, revision_before, revision_after, created_at) | ✓ | session_id | ✓ | ✓ | 場次 | 歷史 |
| settings | 系統設定與其他 | (store_id, key) | key | ✓ | — | ✓ | ✓ | — | 含 LINE 金鑰等設定值；`pos_password` 受保護 |
| delivery_platforms | 系統設定與其他 | id INT | name（唯一 store_id,name） | ✓ | — | ✓ | ✓ | — | — |
| store_business_calendar | 系統設定與其他 | id INT | (start, end, mode, takeout_start, delivery_start) | ✓ | — | ✓ | ✓ | — | — |
| payment_methods | 系統設定與其他 | id INT | code（唯一 store_id,code） | ✓ | gateway_code | ✓ | ✓ | — | — |
| payment_gateways | 系統設定與其他 | id INT | code（唯一 store_id,code） | ✓ | — | ✓ | ✓ | — | **api_key／secret_key 不匯出、不匯入** |
| customers | 系統設定與其他 | id INT | phone → name | ✓ | — | ✓ | ✓ | — | PII |
| crm_segments | 系統設定與其他 | id INT | name | ✓ | — | ✓ | ✓ | — | — |

### 不納入備份的資料表（明確排除，附原因）

| 資料表 | 原因 |
|---|---|
| stores、super_admins | 帳號主檔，由總控台管理 |
| licenses、devices | 授權與 Android 裝置；依專案原則不動 License／Android |
| migration_logs | 系統稽核紀錄 |
| print_jobs | 暫存列印佇列 |
| line_cart_handoff_tokens、popup_restore_receipts | 短期 token |
| cart_recovery_jobs／consents／orchestration_requests | 重新匯入可能觸發重複 LINE 推播 |
| crm_actions、crm_action_targets、crm_segment_members | 推播執行紀錄／快取；重新匯入可能重複推播 |
| ga4_geo_range_stats、ga4_geo_realtime_snapshots、ga4_geo_sync_runs | GA4 API 同步快取，可重新同步 |
| geo_live_coordinates、geo_coordinate_status_log | 即時座標暫存 |

### 原需求列出的「其他重要資料」對應

| 原需求項目 | 實際資料表 | V2 分類 |
|---|---|---|
| 快閃取餐活動、場次與地點 | popup_* | 快閃取餐活動（新增分類） |
| 外送平台設定 | delivery_platforms | 系統設定與其他資料 |
| LINE 營業設定、商店設定、GA4 設定 | settings（key/value） | 系統設定與其他資料 |
| 付款設定 | payment_methods、payment_gateways（不含金鑰） | 系統設定與其他資料 |
| LINE 預購 | 本系統沒有獨立預購表：預購訂單＝`orders.source='line'`；預購／限量設定在 `products.line_preorder_*`／`line_quota_*` | 「LINE 預購」只匯出 LINE 訂單；設定隨「商品資料」 |

## 5. 匯出匯入相依性規格

1. **相依只影響匯入，不強迫一起匯出。** 每份備份都附 `ref_maps`（商品 id→名稱／條碼、分類、食材、優惠券代碼、會員 line_user_id、分析群組），體積很小，讓部分備份也能對應到目標環境既有資料。
2. **匯入順序**：分類 → 商品（＋分析群組）→ 食材（＋公式、批號、解凍）→ 折扣 → 快閃主資料（地點、活動、場次、場次商品、販售設定）→ 訂單（＋操作紀錄、優惠券使用）→ 快閃保留量與場次異動 → 庫存異動 → LINE 會員（＋標籤）→ 會員歷程 → Analytics → 系統設定。
3. **整數 ID**：目標庫該 id 未被占用時保留原 id（同庫還原時 `orders.items` 內的商品 id 仍正確）；被占用時配發新 id，並記入舊→新對照，所有子資料以對照表改寫。
4. **TEXT 主鍵**（orders、popup_*）：全域唯一；被其他列（含他店）占用時改配新 UUID，快閃 `public_code` 被占用時改配新代碼，並同步更新 `orders.popup_session_id／popup_campaign_id` 與子資料。
5. **必要相依找不到** → 該列計為「缺少關聯」，**不寫入**（不產生孤兒資料）：扣料公式、批號、食材紀錄、場次商品／販售設定／保留量、優惠券使用紀錄、場次（無活動時）。
6. **軟相依找不到** → 寫入紀錄本身，關聯欄位清空並計入「關聯清空」：`inventory_logs.product_id`、`analytics_events.product_id`、`line_members.first_product_id`、`line_friend_events.member_id`、`products.category_id`。
7. **歷程類資料**（logs、history、events、allocations）為 append-only：已存在就跳過，合併模式也不改寫。
8. **庫存**：只匯入歷史異動紀錄，不重算、不扣減、不增加任何現有庫存；既有商品／食材的庫存欄位在合併時不比較也不補值；新建立的商品／食材帶入備份當時的庫存快照。
9. **LINE 會員跨店**：唯一鍵是 (store_id, line_user_id)；同一 LINE 身分在兩店各自一筆，不合併（測試 X11）。
10. **Analytics 去重**：與資料庫唯一索引 `idx_analytics_order_event_unique(store_id, order_id, event_name)` 一致；同一份檔案重複匯入新增 0 筆（測試 I3、L16），購買／轉換／營收不會重複計算。
