# R54.4｜Migration & Backup V2 — 最終報告

```text
R54.4-MBV2 資料備份／搬家 V2 — 已實作並通過實測
部署 ZIP：P3CD_DEPLOY_R54_4_MBV2_MIGRATION_BACKUP_V2_FINAL_APP_ROOT.zip（SHA-256 見交付訊息與 .sha256 檔）
起點：R54.4 27667eda66658af84dc35e495d1232030f8d042c56352e4a86ea7e1651cef80d
沒有部署任何環境．沒有讀寫正式資料庫．沒有 schema 變更或 migration
```

## 一、交付內容

| # | 交付項目 | 位置 |
|---|---|---|
| 1 | 完整可部署 ZIP | 交付訊息附檔（flat app root） |
| 2 | 修改檔案清單 | 本文件第三節 |
| 3 | Reality Audit | `01_REALITY_AUDIT.md` 第 1–3 節 |
| 4 | 資料表與分類對照表 | `01_REALITY_AUDIT.md` 第 4 節 |
| 5 | 匯出匯入相依性規格 | `01_REALITY_AUDIT.md` 第 5 節 |
| 6 | 歷史資料救援驗證報告 | `02_HISTORICAL_RESCUE_VERIFICATION.md`（**原始檔案未提供，數字全部待確認**；附驗證工具） |
| 7 | 測試結果 | `04_TEST_RESULTS.md` |
| 8 | 環境變數清單 | `03_PERSISTENCE_DEPLOY_ROLLBACK_SOP.md` 第二節 |
| 9 | 正式部署 SOP | 同上第三節 |
| 10 | 回滾 SOP | 同上第四節 |
| 11 | SHA256 | ZIP 旁的 `.sha256` 檔；本節以下列出每個變更檔的 SHA |

## 二、功能摘要

**匯出**（系統設定 → 資料備份／搬家）
- 完整匯出（一鍵）＋選擇性匯出（12 個分類，單選／多選／全選／取消全選）。
- 分類：商品資料、商品分類、訂單紀錄、食材與扣料公式、LINE 預購、折扣活動、庫存異動、LINE 會員、會員歷程、Analytics 事件，以及新增的「快閃取餐活動」「系統設定與其他資料」。
- 訂單、LINE 預購、Analytics 支援日期：全部、今日、昨日、本週（週一起）、本月、上個月、指定月份、自訂範圍；Asia/Taipei、含首尾日。庫存異動、會員歷程不提供日期篩選（時間欄位時區不一致，篩選可能切斷關聯，詳見稽核）。
- 匯出預覽：筆數、依實際資料抽樣估算的大小（無法估算時顯示「尚未估算」）、是否含圖片／歷史、建議一起匯出的分類。
- 檔名：`pos_backup_store_001_full_YYYYMMDD.json`、`…_orders_YYYYMMDD.json`、`…_orders_20261001_20261031.json`、`…_members_…`、`…_analytics_…`、`…_selected_…`；可選 `.json.gz`。

**匯入**
- 選檔 → 串流上傳（瀏覽器自動 gzip 壓縮大檔、顯示進度）→ 驗證格式 → 備份資訊 → 選分類 → 選模式 → 唯讀預覽（備份筆數、現有筆數、預計新增／更新／跳過、衝突、缺少關聯、格式無效、寫入失敗，附範例明細）→ 二次確認 → 執行 → 結果與筆數核對。
- 模式：跳過已存在（預設）、安全合併（只補空白欄位，不同值列為衝突且不覆蓋）、完整取代（僅完整備份、需全部分類、輸入店家代碼＋登入密碼、自動建立並驗證整份資料庫安全快照、不可跨店）。
- 正式匯入必須帶預覽 token：選項與預覽不同就拒絕。
- 任一列寫入失敗 → 整批回滾，回報失敗；交易內逐表核對「匯入後筆數＝基準＋新增」，不一致也整批回滾。
- 支援舊版完整 JSON、新版完整、新版部分；未知 `schema_version`、筆數與檔頭不符、原型污染、不認識的資料表都會明確提示或拒絕。

**上傳限制**：預設 192MB，最高 256MB（`MIGRATION_UPLOAD_LIMIT_MB`）；同一上限也限制 gzip 解壓後大小；一般 API 維持 5MB；HTTP 413 一律回 JSON；解析前記憶體保護（不足時回 507，不會讓 POS 程序 OOM 中斷）。

## 三、修改檔案清單（相對 R54.4；新增 15、修改 9、刪除 0）

| 類型 | SHA-256（前 16 碼） | 位元組 | 檔案 | 說明 |
|---|---|---:|---|---|
| 新增 | b657dfa333e7a097 | 90085 | utils/migrationV2.js | 分類定義、匯出、檔案解析、匯入引擎（預覽＝交易內試算後回滾） |
| 新增 | 574d27f39b7785de | 25634 | routes/migration-v2.js | `/api/migration/v2/*`：config、export、export/preview、upload、preview、import、jobs、storage-status |
| 新增 | 8e8d5f090fc385fe | 31105 | public/js/migration-v2.js | 前端 V2 介面 |
| 新增 | 68f3bea4fbb89048 | 7343 | public/css/migration-v2.css | 介面樣式（範圍限定 `#stab-migration`） |
| 修改 | afae70c593a451f7 | 327258 | public/index.html | 搬家分頁改為 V2 版面、完整取代確認視窗、載入新 JS／CSS、`app.js?v=` 版本字串 |
| 修改 | 135d4dd765d59646 | 950350 | public/js/app.js | 只加 1 行：切到搬家分頁時呼叫 `mbv2Init()`；舊函式保留 |
| 修改 | 71a6c1c00f3b6f8b | 41692 | server.js | 只加 3 行：掛載 `/api/migration/v2` |
| 修改 | 24fc7326b480fbfc | 137475 | routes/migration.js | 舊搬家／匯出入路由改為只接受 JWT；舊 replace 保留 `pos_password`；舊匯入略過 `pos_password` |
| 修改 | 366291c3a8c21d59 | 2703 | utils/migrationUploadLimit.js | 預設 25→192MB、上限 100→256MB；加入 V2 上傳路徑 |
| 修改 | 5531a9e288ebb46d | 200897 | utils/db.js | 只新增：建立 `POS_DB_PATH` 所在目錄、啟動儲存資訊 `getStorageInfo()`、`DB_PATH` 無效警告。資料庫路徑解析規則**不變** |
| 修改 | 37c075ac74971762 | 7029 | .env.example | 文件註解：`POS_DB_PATH`／`DB_PATH`、上傳上限、暫存與快照目錄 |
| 修改 | 3c50b71635eced62 | 25420 | scripts/smoke-hotfix29-c2-migration-upload.js | 6 個斷言 25→192、100→256 |
| 修改 | 7172a6b19b26404e | 23247 | scripts/run-h1-4-10-friend-sec-mig-runtime.js | 匯入請求帶店家 JWT（斷言不變） |
| 新增 | 029e514bf7c845da | 39680 | scripts/smoke-r54-4-mbv2-migration.js | 主要回歸 121 項 |
| 新增 | 8be737c5b62b7d0b | 14397 | scripts/smoke-r54-4-mbv2-large-upload.js | 大檔案／記憶體 25 項 |
| 新增 | 081d931828adcee0 | 10186 | scripts/run-r54-4-mbv2-ui.js | 前端實機 19 項 |
| 新增 | 488c0ac897abdec6 | 4789 | scripts/smoke-r54-4-mbv2-system-regression.js | 系統回歸比對 |
| 新增 | b7f9b5639b1605ee | 8419 | scripts/lib/mbv2-harness.js | 測試工具（只用暫存 DB） |
| 新增 | 6dd2d97c266719ab | 9396 | scripts/lib/mbv2-seed.js | 測試種子資料 |
| 新增 | fb324fe715400308 | 8031 | scripts/mbv2-rescue-verify.js | 歷史資料救援驗證工具（離線唯讀） |
| 新增 | — | — | docs/R54_4_MBV2/*.md | 本報告與 4 份文件 |

未修改：schema／migration、其他 routes、middleware、`package.json`／lockfile、Android 相關 API、License API、Zeabur 部署架構、LINE 點餐與快閃前台。

## 四、行為變更（請部署前知悉）
1. 舊搬家與訂單／預購匯出入端點不再接受只帶 `x-store-id` 或 `?store_id=` 的請求（需店家登入 JWT）。後台網頁本來就帶 JWT，不受影響；其他 API（含 Android 使用的商品、訂單、sync）不受影響（系統回歸逐項比對相同）。**待確認**：Android App 是否曾直接呼叫 `/api/migration/*` 或 `/api/export/orders`（原始碼與文件中未發現）。
2. 備份檔不再包含 `pos_password`；任何匯入都不會改動店家密碼。把資料搬到全新資料庫後，請在總控台重設該店密碼。
3. 金流設定（`payment_gateways`）的 API 金鑰不匯出；搬到新環境後需重新輸入。

## 五、未完成／待確認
- 10/07、11/09、合併救援 JSON 與合併稽核報告未提供 → Phase 8 全部數字待確認（已附工具）。
- 「256MB 上傳修改版本」未提供 → 本次直接在 R54.4 上實作，未比對該版本。
- Zeabur 的 Volume、`POS_DB_PATH`、`TZ`、服務記憶體、反向代理的 body 上限與逾時無法在此環境讀取 → 依 SOP 由店家確認。
- 實測 185MB 匯入時伺服器行程 RSS 峰值約 1.7GB、匯入期間約 30 秒無法回應其他請求；「設定 256MB」不代表任何規格的主機都能匯入 256MB 檔。
- `smoke-r48-popup-order-ui-browser.js` 在此環境無輸出（原始版亦同），未能執行。
- 出貨的 `smoke-h1-4-12-popup-admin-ui-browser.js` 仍含 BR51 隨機誤判（R54.4-C1 已記載，本次未修改該測試）。
