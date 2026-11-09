# R54.4-MBV2 測試結果

所有測試都以真實 `node server.js` ＋ 位於 `os.tmpdir()` 的暫存 SQLite 執行；沒有連線正式站、沒有讀寫專案內 `data/pos.db`（測試 Z 以 SHA 檢查）。本次未以語法檢查代替任何測試。

## 總表

| 測試 | 指令 | 結果 |
|---|---|---|
| V2 主要回歸 | `node scripts/smoke-r54-4-mbv2-migration.js` | **121／121** |
| 大檔案／記憶體 | `node scripts/smoke-r54-4-mbv2-large-upload.js` | **25／25**（約 6 分鐘，會在暫存目錄產生 190–257MB 測試檔並刪除） |
| 前端實機（Playwright＋Chrome） | `NODE_PATH=<playwright> node scripts/run-r54-4-mbv2-ui.js` | **19／19** |
| 系統回歸（原始 R54.4 vs 修改版逐項比對） | `node scripts/smoke-r54-4-mbv2-system-regression.js --out x.json` | **25／25 項狀態碼與回應形狀完全相同** |
| 既有上傳限制測試（已更新斷言） | `node scripts/smoke-hotfix29-c2-migration-upload.js` | **62 PASS／0 FAIL**／1 需人工（Zeabur proxy 上限） |
| 既有專案回歸 18 支（原始 R54.4 與修改版各跑一次） | 見下表 | 與原始版一致（差異逐項說明） |

## 既有專案回歸：原始 R54.4（A0）vs 修改版

| Suite | A0 通過／失敗 | 修改版 | 判定 |
|---|---|---|---|
| run-h1-4-10-friend-sec-mig-runtime | 25／0 | 首跑 16／9 → 更新測試後 **25／0** | 9 項失敗皆為 `NO_JWT`：此測試把舊搬家路由直接掛在自建 app、不帶任何憑證。這正是本次修正的安全漏洞。已把測試改為帶入同一 `JWT_SECRET` 簽發的店家 token，斷言一字未改 |
| smoke-h1-4-12-popup-public-checkout | 1492／0 | 1492／0 | 相同 |
| smoke-h1-4-12-popup-admin-api | 191／0 | 191／0 | 相同 |
| smoke-h1-4-12-popup-checkout-integration | 64／0 | 64／0 | 相同 |
| smoke-h1-4-11-line-order-page-mode | 110／1 | 110／1 | 相同（既有失敗） |
| smoke-h1-4-12-line-pricing-lifecycle | 246／0 | 246／0 | 相同 |
| smoke-h1-4-12-durable-release | 139／0 | 139／0 | 相同 |
| smoke-h1-4-12-line-counter-snapshot-security | 238／0 | 238／0 | 相同 |
| smoke-hotfix27 | 50／3 | 50／3 | 相同（既有失敗） |
| smoke-hotfix26-f6 | 95／0 | 95／0 | 相同 |
| run-h1-4-9-checkout-order-summary-runtime（優惠券） | 68／0 | 68／0 | 相同 |
| smoke-hotfix30-…-g1-6-ga4-h1（GA4） | 152／1 | 152／1 | 相同（既有失敗） |
| smoke-hotfix31-r2-hardening | 84／0 | 84／0 | 相同 |
| test-phone-validation-integration | 60／0 | 60／0 | 相同 |
| smoke-h1-4-12-popup-frontend | 294／0 | 294／0 | 相同 |
| smoke-h1-4-12-popup-admin-ui-browser | 473／1 | 首跑 472／2；重跑兩次 **473／1** | 多出的 1 項是 **BR51**（`rowShowsRemaining1:false`，讀回值正確、無「已額滿」），與 R54.4-C1 報告記載的隨機公開代碼數字開頭誤判完全相同。出貨的測試檔仍是舊版 regex；重跑兩次皆通過。剩下的 1 項 `LINK-published-urls-use-public-code` 在 A0 也失敗 |
| static-audit-r48-popup-order-ui | 29／10 | 29／10 | 此為「與 R47 檔案集合逐位元組比對」的凍結稽核，A0 本來就 10 項失敗；修改版同樣 10 項，只是清單多列出本次新增／修改的檔名，屬預期 |
| smoke-r48-popup-order-ui-browser | 無輸出 | 無輸出 | 此環境兩邊都沒有產生任何輸出，**未能執行**，不列為通過 |

系統回歸涵蓋項目：Android POS 既有 API（只帶 `x-store-id`：商品、分類、POS 收銀建單、今日訂單、sync config、sync 上傳與重複上傳）、License 查詢、訂單紀錄日期查詢與單筆查詢、商品管理、食材與扣料公式、食材紀錄、庫存、設定、優惠券（此店方案未開 coupon 功能，兩版皆 403）、LINE 點餐菜單、舊版搬家匯出入（帶 JWT）。

## 需求對照
| 需求項目 | 對應測試 |
|---|---|
| 完整匯出／單獨匯出（商品、訂單、會員、Analytics）／多分類／全選與取消全選／空選擇 | E1–E5、UI3–UI5 |
| 指定月份、自訂範圍、台灣時區跨日邊界、範圍無訂單 | U1–U14、E6–E11、UI6、UI8 |
| 舊版完整 JSON、新版完整、單分類、多分類 | I5–I5c、I2、I6–I6b |
| 跳過已存在、安全合併、重複匯入 | I1b、I3、I4、L16 |
| 主鍵衝突、外鍵關聯、跨店隔離、缺少關聯 | X1–X12、I2e–I2g、I6、I6d |
| 匯入中斷、交易回滾 | T1–T4、I7–I7c |
| 預覽唯讀 | I1c、UI11 |
| 192MB 以下通過、以上拒絕、256MB、超過 256 拒絕、HTTP 413、gzip 炸彈、記憶體 | L1–L19 |
| 不得提高一般 API 限制 | L4 |
| 權限 | A1–A6、X4、R4–R5 |
| 完整取代（管理員、完整備份、快照驗證、二次確認、影響範圍） | R1–R9、UI14 |
| 回滾相容 | I5d、I5e |

## 逐項實測紀錄

### V2 主要回歸（匯出／匯入／權限／跨店／完整取代）：121 通過／0 失敗

| 結果 | 項目 | 實測值 |
|---|---|---|
| ✅ | U1 全部歷史 → 無篩選 |  |
| ✅ | U2 今日 = 2026-11-09 |  |
| ✅ | U3 昨日 = 2026-11-08 |  |
| ✅ | U4 本週（週一起）= 11/09～11/09 |  |
| ✅ | U5 本月起 11/01 |  |
| ✅ | U6 上個月 = 10/01～10/31 |  |
| ✅ | U7 指定月份 2028-02 結束日為 29（閏年） |  |
| ✅ | U8 UTC 16:30 已是台北隔日 → 今日=11/10（不因 UTC 跨日漏算） |  |
| ✅ | U9 開始日晚於結束日 → INVALID_DATE_RANGE |  |
| ✅ | U10 不存在的日期 2026-02-30 → 拒絕 |  |
| ✅ | U11 帶 Z 的訂單時間轉台北日期 |  |
| ✅ | U12 naive 訂單時間（台北當地）取原日期 |  |
| ✅ | U13 analytics UTC naive 16:10 → 台北 10/01 |  |
| ✅ | U14 analytics UTC 15:59:59 → 台北 9/30 |  |
| ✅ | A1 V2 匯出：只有 x-store-id、沒有 JWT → 401 | status=401 |
| ✅ | A2 舊版 /api/migration/export：沒有 JWT → 401（修正前可用 x-store-id 直接下載） | status=401 |
| ✅ | A3 舊版匯入（replace）沒有 JWT → 401 | status=401 |
| ✅ | A4 舊版訂單匯出 ?store_id= 沒有 JWT → 401 | status=401 |
| ✅ | A5 帶 JWT 時舊版完整匯出仍可用（舊流程相容） |  |
| ✅ | A6 其他 API（/api/products）仍接受 x-store-id（Android 相容，未受影響） | status=200 |
| ✅ | E0 匯出預覽回傳全部分類 | count=12 |
| ✅ | E0b 商品預覽標示「含圖片網址、無內嵌圖片」 |  |
| ✅ | E0c 預估大小為抽樣估算數字或 null（尚未估算），無虛構文字 |  |
| ✅ | E1 完整匯出：backup_type=full、type 與舊版相容、schema_version=2 |  |
| ✅ | E1b 完整匯出檔名 | pos_backup_store_001_full_20261109.json |
| ✅ | E1c 檔名日期＝實際匯出日（台北） |  |
| ✅ | E1d 完整匯出各表筆數＝資料庫實際筆數 |  |
| ✅ | E1e 完整匯出不含 pos_password |  |
| ✅ | E1f 金流設定匯出不含 API 金鑰 |  |
| ✅ | E1g 會員歷程 metadata 的 token 已移除 |  |
| ✅ | E1h 完整匯出不含 store_002 資料 |  |
| ✅ | E1i 退款資訊完整保留（refund_status／refunded_at／refund_note） |  |
| ✅ | E1j 作廢訂單與作廢原因保留 |  |
| ✅ | E2 products 單獨匯出（partial、只含該分類資料表、檔名 products） | pos_backup_store_001_products_20261109.json products,product_analysis_groups,product_analysis_group_items,product_analysis_group_aliases |
| ✅ | E2 orders 單獨匯出（partial、只含該分類資料表、檔名 orders） | pos_backup_store_001_orders_20261109.json orders,order_logs,coupon_redemptions |
| ✅ | E2 line_members 單獨匯出（partial、只含該分類資料表、檔名 members） | pos_backup_store_001_members_20261109.json line_members,line_member_tags |
| ✅ | E2 analytics 單獨匯出（partial、只含該分類資料表、檔名 analytics） | pos_backup_store_001_analytics_20261109.json analytics_events,geo_visit_log |
| ✅ | E3 多分類匯出（selected 檔名） | pos_backup_store_001_selected_20261109.json |
| ✅ | E4 全選（無日期篩選）→ 視為完整備份 |  |
| ✅ | E5 空選擇 → 400 EMPTY_SELECTION |  |
| ✅ | E5b 未知分類 → 400 |  |
| ✅ | E6 指定月份 2026-10：含 10/01 00:00、UTC 換算的 10/01 00:30、10/31 23:59，排除 9/30 23:59 與 11/01 00:00 | O-1001-0000,O-1001-ISOZ,O-1015-LINE,O-1020-REFD,O-1031-2359 |
| ✅ | E6b 日期範圍檔名 | pos_backup_store_001_orders_20261001_20261031.json |
| ✅ | E6c 只匯出範圍內訂單的操作紀錄 | 5 |
| ✅ | E6d 範圍內訂單的優惠券使用紀錄一併匯出 |  |
| ✅ | E6e 檔頭記錄篩選條件與時區 |  |
| ✅ | E7 自訂日期範圍 10/31～11/01（含首尾日） |  |
| ✅ | E8 日期範圍無訂單 → 正常匯出 0 筆 |  |
| ✅ | E9 錯誤的日期範圍 → 400 |  |
| ✅ | E10 LINE 預購依月份匯出（只含 source=line） | pos_backup_store_001_preorders_20261001_20261031.json |
| ✅ | E11 Analytics 依台北日期篩選（UTC 9/30 16:10 屬 10/01、UTC 10/31 16:00 屬 11/01） | 2026-09-30 16:10:00,2026-10-15 04:00:00 |
| ✅ | E12 gzip 匯出可解壓且內容正確 | 2242 bytes |
| ✅ | I1 上傳新版完整 JSON，正確辨識 |  |
| ✅ | I1b 同店同資料預覽：新增 0、全部跳過 | {"source":177,"added":0,"updated":0,"skipped":177,"duplicate_in_file":0,"conflict":0,"missing_relation":0,"invalid":0,"failed":0,"purged":0,"protected":0} |
| ✅ | I1c 預覽後資料庫檔 SHA-256 完全不變（唯讀） |  |
| ✅ | I2 新版完整 JSON 匯入新環境成功、交易內筆數核對通過 | {"source":177,"added":58,"updated":0,"skipped":119,"duplicate_in_file":0,"conflict":0,"missing_relation":0,"invalid":0,"failed":0,"purged":0,"protected":0} |
| ✅ | I2b 正式匯入新增筆數＝預覽預計新增 | 58 vs 58 |
| ✅ | I2-0 同名商品（來源有 2 筆「滷蛋」）不會被當成重複而遺失 | src=15 dst=15 |
| ✅ | I2c 訂單／紀錄／會員／事件／快閃場次筆數正確 |  |
| ✅ | I2d 訂單原始 id 與退款欄位保留（舊版匯入會改寫 id、遺失退款欄位） |  |
| ✅ | I2e 訂單操作紀錄全部對得到訂單 |  |
| ✅ | I2f 扣料公式商品／食材對應正確 |  |
| ✅ | I2g 快閃保留量對應原場次與訂單 |  |
| ✅ | I2h 匯入不會帶入 pos_password（新環境密碼維持原狀） |  |
| ✅ | I2i 一般設定值（含 LINE 設定）可還原 |  |
| ✅ | I2j 新增食材帶入備份當時庫存快照；庫存異動紀錄不會再次扣減（8000 不變） |  |
| ✅ | I3 重複匯入同一份檔案：新增 0 筆 | {"source":177,"added":0,"updated":0,"skipped":177,"duplicate_in_file":0,"conflict":0,"missing_relation":0,"invalid":0,"failed":0,"purged":0,"protected":0} |
| ✅ | I3b 重複匯入後 Analytics 事件／訂單筆數不變（不重複計算） |  |
| ✅ | I4 安全合併：1 筆補空白欄位（更新）、1 筆衝突並列出欄位 | {"u":1,"c":1,"s":[{"key":"O-1031-2359","fields":["total"]}]} |
| ✅ | I4b 空白欄位已補齊；衝突欄位維持現有值 120（未被覆蓋） |  |
| ✅ | I4c 有衝突時狀態為 completed_with_warnings（不是單純成功） |  |
| ✅ | I5 舊版完整 JSON 可辨識 | ["products","categories","orders","ingredients","line_preorders","discounts","inventory_movements","line_members","member_history","analytics","settings"] |
| ✅ | I5b 舊版完整 JSON 匯入成功 | {"source":150,"added":44,"updated":0,"skipped":106,"duplicate_in_file":0,"conflict":0,"missing_relation":0,"invalid":0,"failed":0,"purged":0,"protected":1} |
| ✅ | I5c 舊版檔匯入：8 筆訂單、操作紀錄全部對得到訂單 |  |
| ✅ | I5d 回滾相容：V2 完整備份可由舊版匯入器（/api/migration/import）匯入 | status=200 orders=8 |
| ✅ | I5e 部分備份交給舊版匯入器（replace）→ 400 拒絕，不會清空資料 | status=400 |
| ✅ | I6 單分類（訂單）匯入：8 筆新增；優惠券紀錄因缺少優惠券列為「缺少關聯」 | [{"key":"uuid-O-1015-LINE","reason":"找不到優惠券代碼 OCT10（請一併匯入折扣活動）"}] |
| ✅ | I6b 多分類檔只選部分分類匯入（未選的訂單不處理） |  |
| ✅ | I6c 選擇檔案沒有的分類 → 400 |  |
| ✅ | I6d 快閃關聯資料：找不到商品／訂單時列為缺少關聯，不寫入孤兒資料 | {"psp":[{"key":null,"reason":"找不到對應商品"}],"pal":[{"key":null,"reason":"找不到對應商品"}]} |
| ✅ | I7 預覽即揭露 1 筆會寫入失敗的資料 | [{"key":"9001\u0001adjust\u00012026-10-01 00:00:00\u0001\u0001","error":"NOT NULL constraint failed: ingredient_logs.ingredient_name"}] |
| ✅ | I7b 正式匯入失敗回報 error（不回報成功） | {"code":"IMPORT_ROW_FAILED","message":"有 1 筆資料寫入失敗，已整批回滾，資料庫未變更"} |
| ✅ | I7c 整批回滾：同批的食材也沒有寫入 |  |
| ✅ | I7d 回滾後僅新增一筆 migration_logs 失敗紀錄 | db file changed=true |
| ✅ | I8 未知 schema_version=3 → 明確拒絕 | 備份檔版本 schema_version=3 比目前系統支援的版本（2）新，請先升級系統再匯入 |
| ✅ | I8b 筆數與檔頭不符（截斷／被修改）→ 拒絕 |  |
| ✅ | I8c 原型污染欄位 → 拒絕 |  |
| ✅ | I8d 損壞 JSON → 400 |  |
| ✅ | I8e 非備份檔 → 400 |  |
| ✅ | I8f 不認識的資料表：明確提示並忽略 |  |
| ✅ | I8g gzip 備份檔可上傳並解析 |  |
| ✅ | I9 未預覽直接匯入 → 409 |  |
| ✅ | I9b 預覽與匯入選項不同（skip→merge）→ 409 |  |
| ✅ | X1 store_002 上傳 store_001 的備份 → 標示跨店 |  |
| ✅ | X2 未勾選跨店確認 → 403 |  |
| ✅ | X3 跨店不可完整取代 |  |
| ✅ | X4 store_001 不能使用 store_002 的上傳（upload 綁定店家） |  |
| ✅ | X5 明確確認後跨店匯入成功 | {"source":43,"added":41,"updated":0,"skipped":1,"duplicate_in_file":0,"conflict":0,"missing_relation":1,"invalid":0,"failed":0,"purged":0,"protected":0} |
| ✅ | X6 訂單 id 已被 store_001 使用 → 全部改配新 id（不覆蓋他店） | added=8 remapped=8 |
| ✅ | X7 store_001 資料完全未變動 | {"orders":8,"order_logs":8,"products":15,"popup_sessions":1,"analytics_events":4} |
| ✅ | X8 store_002 的訂單操作紀錄對應到 store_002 的新訂單 id |  |
| ✅ | X9 快閃場次公開代碼全域唯一：跨店匯入改配新代碼，原店代碼不變 |  |
| ✅ | X10 store_002 既有同名商品視為同一商品，不重複建立 |  |
| ✅ | X11 相同 LINE 身分在兩店各自一筆，不合併 |  |
| ✅ | X12 store_002 密碼不受影響 |  |
| ✅ | T1 上傳到一半中斷連線 |  |
| ✅ | T2 中斷後服務正常 |  |
| ✅ | T3 中斷的上傳不影響資料庫 |  |
| ✅ | T4 中斷上傳的暫存檔已清除 | remaining completed uploads=2 |
| ✅ | R1 部分備份不可完整取代（不會清除任何資料） |  |
| ✅ | R2 完整取代必須選擇全部分類 |  |
| ✅ | R3 預覽列出每張表將刪除筆數 | [{"table":"analytics_events","scope":"analytics_events","rows_to_delete":4},{"table":"geo_visit_log","scope":"geo_visit_log","rows_to_delete":1},{"table":"line_ |
| ✅ | R4 未輸入店家代碼確認 → 拒絕 |  |
| ✅ | R5 密碼錯誤 → 403 |  |
| ✅ | R6 完整取代成功；取代前安全快照已建立並驗證 | "pre-replace-store_001-20261109T130142.sqlite" |
| ✅ | R6b 安全快照檔存在於資料庫同目錄 migration-safety/ | pre-replace-store_001-20261109T130142.sqlite |
| ✅ | R6c 安全快照可開啟且內容＝取代前資料（可還原） |  |
| ✅ | R7 取代後資料＝備份內容（商品筆數與取代前相同，同名商品不遺失） | {"before":{"orders":8,"products":15,"analytics_events":4,"line_members":2},"after":{"orders":8,"products":15,"analytics_events":4,"line_members":2}} |
| ✅ | R8 完整取代後店家密碼不變（pos_password 受保護） |  |
| ✅ | R9 完整取代只影響 store_001，store_002 資料仍在 | {"orders":9,"products":15} |
| ✅ | Z 專案內 data/pos.db 未被任何測試觸碰 | null |

### 大檔案／記憶體：25 通過／0 失敗

| 結果 | 項目 | 實測值 |
|---|---|---|
| ✅ | L1 未設定環境變數 → 預設 192MB，最高 256MB | {"u":192,"m":256} |
| ✅ | L1b 舊版 /api/migration/config 同步回報 192MB |  |
| ✅ | L2 191.0MB（192MB 以下）上傳並解析成功 | status=200 |
| ✅ | L3 192.001MB（超過 192MB）→ HTTP 413 JSON | status=413 |
| ✅ | L3b 無 Content-Length（chunked）超過上限 → 串流中途拒絕（413 或連線關閉） | status=413 |
| ✅ | L3c 被拒的超大上傳沒有留下暫存檔 | upload files=1 |
| ✅ | L3d 拒絕後服務正常 |  |
| ✅ | L4 一般 API（/api/products）6MB body 仍回 413（未提高一般 API 限制） | status=413 |
| ✅ | L5 gzip 炸彈（壓縮 239KB、解壓 240MB）→ 413 拒絕 | status=413 MIGRATION_DECOMPRESSED_TOO_LARGE |
| ✅ | L6 MIGRATION_UPLOAD_LIMIT_MB=256 → 256MB |  |
| ✅ | L7 250.0MB 在 256MB 設定下上傳並解析成功 | status=200 1721ms peakRSS=676MB |
| ✅ | L8 超過 256MB（256MB+1 byte）→ 413 |  |
| ✅ | L9 MIGRATION_UPLOAD_LIMIT_MB=500 → 硬上限 256MB |  |
| ✅ | L10 真實結構 184.7MB（255,579 筆事件）上傳＋解析＋檔頭筆數核對 | 2748ms |
| ✅ | L11a 預覽後記憶體峰值 | peak=1346MB |
| ✅ | L11 預覽完成：預計新增 255,579 筆 | 29147ms |
| ✅ | L11b 預覽期間送出的其他請求在預覽結束後正常回應（服務未崩潰） |  |
| ✅ | L12 正式匯入完成並通過筆數核對 | 31902ms |
| ✅ | L13 記憶體量測（伺服器行程 VmHWM 峰值） | idle=171MB peak=1728MB dbFile=268.2MB upload=2748ms preview=29147ms import=31902ms |
| ✅ | L14 匯入後服務正常 |  |
| ✅ | L15 磁碟上的資料庫檔筆數＝匯入筆數（已持久化） | 255579 |
| ✅ | L16 大檔重複匯入預覽：新增 0（事件去重） |  |
| ✅ | L17 第二次（重複）預覽後記憶體峰值 | peak=1728MB |
| ✅ | L18 heap 512MB 主機上傳 185MB：回 507 記憶體不足並提示分批，服務不中斷（修正前會 V8 OOM 使整個 POS 程序結束） | status=507 803/543MB |
| ✅ | L19 heap 1GB 主機可完成 185MB 匯入 | peakRSS=1625MB |

### 前端實機（Chrome）：19 通過／0 失敗

| 結果 | 項目 | 實測值 |
|---|---|---|
| ✅ | UI1 匯出區顯示 12 個分類 | 12 |
| ✅ | UI2 顯示上傳上限 192MB | 目前上限 192MB（壓縮檔解壓後也不得超過）。 |
| ✅ | UI3 一鍵完整匯出下載 | pos_backup_store_001_full_20261109.json |
| ✅ | UI4 取消全選 → 提示並停用下載鈕 |  |
| ✅ | UI5 全選 → 全部勾選 |  |
| ✅ | UI6 選指定月份 2026-10 後預覽筆數即時更新為 11 筆（全部 17 筆） | 11 筆 · 15.1 KB（抽樣估算） |
| ✅ | UI7 提示建議一起匯出的關聯分類 |  |
| ✅ | UI8 依月份匯出訂單檔名 | pos_backup_store_001_orders_20261001_20261031.json |
| ✅ | UI9 顯示備份來源／版本／類型 |  |
| ✅ | UI10 預覽表格含新增／更新／跳過／衝突／缺少關聯欄位 |  |
| ✅ | UI11 前端預覽後資料庫檔案未變更 |  |
| ✅ | UI12 同店同資料（新增 0）→ 確認匯入鈕停用 |  |
| ✅ | UI13 變更匯入模式後需重新預覽（確認鈕隱藏） |  |
| ✅ | UI14 完整取代模式：分類全選並鎖定 |  |
| ✅ | UI15 部分備份／跨店：完整取代選項停用 |  |
| ✅ | UI16 跨店未勾選確認 → 不送出預覽並提示 | ❌ 跨店匯入請先勾選確認 |
| ✅ | UI17 跨店匯入 10 月訂單：新增 10 筆（訂單 5＋操作紀錄 5）、優惠券紀錄缺少關聯 1 筆並以警告呈現 | ⚠️ 匯入完成，但有項目未匯入（衝突／缺少關聯／格式無效，詳見下表） 新增 10更新 0跳過 0 衝突 0缺少關聯 1 筆數核對：✅ 每張表「匯入後筆數＝基準＋新增」一致 分類／資料表備份筆數現有筆數新增更新跳過衝突缺少關聯格式無效寫入失敗訂單紀錄orde |
| ✅ | UI18 資料庫：store_002 新增 5 筆、store_001 不變 | {"c1":{"orders":8},"c2":{"orders":6}} |
| ✅ | UI19 頁面無 JavaScript 錯誤 |  |