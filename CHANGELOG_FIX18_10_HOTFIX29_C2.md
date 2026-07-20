# Hotfix29-C2｜資料備份／搬家匯入 413／HTML 錯誤解析修正（migration-upload-config）

以 **fix18-10-hotfix29-C-full** 為基礎，不重寫既有架構，只針對「資料備份／搬家」匯入這一條功能線做最小必要修改。

## 一、根因（Root Cause）

1. `server.js` 對**全站所有 API** 掛一個全域的 `bodyParser.json({ limit: '5mb' })`，此 middleware 在所有路由（包含搬家路由）之前執行。
2. 「資料備份／搬家」匯出的 JSON（約 9.92MB）遠超過這個 5MB 上限，全域 parser 在請求進到 `routes/migration.js` 之前就先讀取 body、判斷超限，丟出 `entity.too.large` 錯誤。
3. 專案原本**完全沒有錯誤處理 middleware**，Express 對未攔截的錯誤預設回傳純文字／HTML 錯誤頁（`413 Payload Too Large` 的預設頁面，內容以 `<!DOCTYPE ...` 開頭）。
4. 前端 `onMigrationFileSelected()` 呼叫 `POST /api/migration/import/preview` 後直接 `await res.json()`，對著這個 HTML 內容做 `JSON.parse`，因而拋出：
   ```
   Unexpected token '<', "<!DOCTYPE "... is not valid JSON
   ```

這不是搬家 JSON 本身壞掉，而是「body size 上限 + 錯誤沒有轉成 JSON + 前端沒有防禦性解析」三件事疊加造成的。

## 二、修改檔案清單

| 檔案 | 修改內容 |
|---|---|
| `utils/migrationUploadLimit.js`（新增） | 統一計算 `MIGRATION_UPLOAD_LIMIT_MB` / `MIGRATION_UPLOAD_LIMIT_BYTES`（環境變數可調，預設 25，最低 1，最高硬性 100，無效值回退 25）；提供 `isMigrationImportPath(req)` 共用路徑判斷（用 `originalUrl` 而非 `req.path`，避免 router mount 造成相對路徑誤判） |
| `server.js` | 全域 JSON parser 改為對 `POST /api/migration/import` 與 `POST /api/migration/import/preview` 這兩條路徑「跳過」（body 留給路由層專用 parser），其餘 API 仍固定 5MB 不變；新增統一錯誤處理 middleware（四參數 `(err,req,res,next)`，放在所有路由之後、`server.listen()` 之前），把 413 / JSON 解析錯誤 / 其他未攔截錯誤一律轉成 JSON 回應，不回傳 stack trace |
| `routes/migration.js` | 新增 `migrationJsonParser`（`express.json({limit: MIGRATION_UPLOAD_LIMIT_MB+'mb'})`），只掛在 `POST /migration/import/preview` 與 `POST /migration/import` 兩條路由；新增 `GET /migration/config`（回傳目前上限與支援副檔名）；新增 `containsDangerousKeys()` 遞迴檢查，`__proto__` / `prototype` / `constructor` 出現在搬家 payload 任何位置一律拒絕（400 `MIGRATION_UNSAFE_PAYLOAD`），不嘗試「清掉後繼續」 |
| `public/js/app.js` | 新增 `getMigrationConfig()`（快取讀取 `/api/migration/config`）、`validateMigrationFile()`（選檔當下先做副檔名／大小預檢，超過上限不送出 preview 請求）、`parseMigrationApiResponse()`（安全解析：讀 text 再嘗試 `JSON.parse`，非 JSON 內容合成清楚的中文錯誤訊息，不對 `!response.ok` 拋例外，維持既有 `cross_store` 分流邏輯）；`onMigrationFileSelected()` / `executeMigrationImport()` 改用上述 helper |
| `.env.example`（新增） | 記錄 `MIGRATION_UPLOAD_LIMIT_MB` 預設值、範圍、範例 |
| `README.md` | 新增「十一、資料備份／搬家 JSON 上傳大小上限」章節，含 Zeabur 設定步驟與已知限制說明 |
| `scripts/smoke-hotfix29-c2-migration-upload.js`（新增） | 真實 Express pipeline + 真實 HTTP request 的整合測試（詳見下方「測試結果」） |

**未修改**：Analytics／Verify history／LINE Login history／既有完整備份欄位、既有搬家匯入商業邏輯（categories/products/orders/ingredients/…的 remap、transaction、mode=skip/overwrite/replace）、`payload.store_id` 選填的既有相容行為。本次刻意**不要求** `store_id` 為必填、也**不引入** `schema_version` 這類新的強制欄位，避免讓現有搬家檔或前端行為被破壞。

## 三、Parser 架構

```
一般 API（其餘所有路由）
  → app.use(bodyParser.json({ limit: '5mb' }))         ← 完全不變

搬家匯入（僅這兩條）
  POST /api/migration/import/preview
  POST /api/migration/import
  → 全域 parser 用 isMigrationImportPath(req) 判斷後直接 next() 跳過
  → 進入 routes/migration.js 後才套用
     migrationJsonParser = express.json({ limit: `${MIGRATION_UPLOAD_LIMIT_MB}mb` })
```

`isMigrationImportPath()` 用 `req.originalUrl`（去掉 query string）比對完整路徑字串，不用 `req.path`，因為 `req.path` 在掛載於 sub-router 底下時只會是「相對於掛載點」的路徑，若日後路由掛載方式調整，用 `req.path` 判斷容易悄悄失效；`originalUrl` 從外部視角看永遠是完整路徑，兩個判斷點（parser 跳過邏輯、錯誤 middleware 內判斷上限值）共用同一份函式，不會各自維護一份、之後改一邊忘了改另一邊。

## 四、環境變數

```bash
# 預設 25MB；最低 1MB；最高硬性上限 100MB（無法透過環境變數繞過）
# 非數字／空字串／NaN 一律回退為預設 25MB
MIGRATION_UPLOAD_LIMIT_MB=25
```

**Zeabur 設定方式**：專案 → Service → Variables → 新增 `MIGRATION_UPLOAD_LIMIT_MB` → 值設定為所需數字（例如 `25` 或 `50`）→ Redeploy。修改環境變數通常需要重新部署或重新啟動服務才會生效。

## 五、安全性

- **不開放無上限**：硬性上限 100MB 寫死在 `utils/migrationUploadLimit.js` 的 `Math.min(...)`，環境變數無法覆蓋超過這個值。
- **只放寬搬家路由**：全域 5MB 限制對其餘所有 API 完全不變；只有 `POST /api/migration/import` 與 `POST /api/migration/import/preview` 這兩條路徑改用可調上限。
- **Prototype pollution 防護**：`containsDangerousKeys()` 遞迴掃描整個 payload，發現 `__proto__` / `prototype` / `constructor` 任一 key 就整份拒絕（400），不嘗試部分清洗後繼續處理；已用整合測試驗證 `Object.prototype` 實際未被污染。
- **JSON error response**：413 / 400（parse failed）/ 其他未攔截例外，一律回傳 `application/json`，不回傳 stack trace 或內部路徑。
- **不影響 store isolation**：`requireStore` middleware 掛載位置未變（`app.use('/api', requireStore, require('./routes/migration'))`），`GET /api/migration/config` 仍需登入才能存取，但只回傳 `upload_limit_mb` / `upload_limit_bytes` / `supported_extensions` 這三個不含機密的欄位，不綁定特定 store_id、不需要額外權限。
- **不降低既有認證**：`/import` 與 `/preview` 的跨店保護（`cross_store` / `allowCrossStoreImport`）、`mode=replace` 二次確認等既有邏輯完全未變動。

## 六、測試結果

執行環境：Node.js v22.22.2（專案要求 Node 18+），`npm install` 後於本機執行。

| 指令 | Exit Code | 結果 |
|---|---|---|
| `node -c server.js` | 0 | 通過 |
| `node -c routes/migration.js` | 0 | 通過 |
| `node -c public/js/app.js` | 0 | 通過 |
| `node -c utils/migrationUploadLimit.js` | 0 | 通過 |
| `node -c scripts/smoke-hotfix29-c2-migration-upload.js` | 0 | 通過 |
| `node scripts/smoke-hotfix29-c2-migration-upload.js` | 0 | **PASS 62 ／ FAIL 0 ／ MANUAL REQUIRED 1 ／ 共 63 項** |
| `node scripts/smoke-hotfix27.js` | 0 | 自身 PASS=42 FAIL=0 MANUAL=3；並串連執行 F1～F7＋F8-A／F8-B 既有 regression，**9/9 個腳本 exit 0** |
| `node scripts/smoke-hotfix28.js` | 0 | 串連執行既有 regression，**11/11 個腳本 exit 0**（含上方 hotfix27 整組） |
| `node scripts/smoke-hotfix29.js` | 0 | 串連執行既有 regression，**12/12 個腳本 exit 0**（含上方 hotfix28 整組） |
| `node scripts/smoke-hotfix29-b.js` | 0 | 串連執行既有 regression，**11/11 個腳本 exit 0** |
| `node scripts/smoke-hotfix29-c.js` | 0 | 串連執行既有 regression，**exit 0**（含上方 hotfix29 整組） |

`package.json` 未定義 `test` script（無 `npm test` 入口），專案內也沒有 `scripts/regression-all.js`；已確認過，不是遺漏執行，而是這個專案本來就用 `scripts/smoke-hotfix*.js` 這種「新版串連呼叫前一版」的串接式 regression（例如 `smoke-hotfix29-c.js` 內部會呼叫 `smoke-hotfix29.js`，後者再呼叫 `smoke-hotfix28.js`……一路串到 F1），所以執行最新的 `smoke-hotfix29-c.js` 等同於跑過從 F1 到 hotfix29-c 的完整既有 regression 鏈，加上本次新增的 `smoke-hotfix29-c2-migration-upload.js`，涵蓋範圍已包含 migration／settings（secret 不洩漏）／store isolation（多店隔離）／LINE 整合等既有相關測試。

`smoke-hotfix29-c2-migration-upload.js` 涵蓋項目：
- 環境變數：未設定→25、合法值 50、非法值（`abc`/`0`/`-1`）回退或限制、超過上限 500→限制為 100
- `isMigrationImportPath()` 對含 query string 的路徑、非搬家路徑、缺 `originalUrl` 的 mount-relative path 均正確判斷
- 前端 `parseMigrationApiResponse()`：直接從 `public/js/app.js` 擷取真實函式原始碼執行（非重寫版本），驗證 HTML 413 不拋例外、合成訊息為「伺服器未回傳有效 JSON，HTTP 413」、正常 JSON 錯誤/成功回應正確解析
- 真實 HTTP：`GET /api/migration/config` 回應內容與安全性（不含密鑰／路徑／stack）
- 真實 HTTP：100KB／500KB／900KB 合法 JSON（上限 1MB）→ 非 413、`application/json`、`success:true`
- 真實 HTTP：1.1MB／1.3MB／1.5MB 超限 JSON（上限 1MB）→ `HTTP 413`、`application/json`、不含 HTML、`code=MIGRATION_FILE_TOO_LARGE`、`max_size_mb=1`
- 真實 HTTP：損壞 JSON → `HTTP 400`、`application/json`、`code=INVALID_JSON_BODY`、不含 HTML
- 真實 HTTP：`__proto__` 直接污染、`constructor.prototype` 污染 → 均 `HTTP 400`、`code=MIGRATION_UNSAFE_PAYLOAD`；並驗證測試 process 本身 `Object.prototype` 未被污染
- 真實 HTTP：以 `Buffer.byteLength()` 精確產生 10,408,207 bytes（9.92MB 基準）payload，在 1MB 上限下正確被擋（驗證 body parser 真的有量測位元組數）、在**預設 25MB 上限**下正確通過（`status !== 413`、`success:true`）—— 對應本次修復的核心驗收目標

## 七、已知限制

**Zeabur／上游 reverse proxy 限制未驗證**：應用程式層（Node.js / Express / body-parser）已確認支援可調整的上傳上限（本機測試預設 25MB 下，9.92MB 等效檔案可正常通過 body parser）。但 Zeabur 平台本身或其上游 reverse proxy／CDN，若另外設有更低的 body size 限制，仍可能在請求抵達 Node.js process 之前就先回應 413 —— 這屬於平台層設定，本專案原始碼內搜尋不到 `nginx.conf`、`Caddyfile`、`Dockerfile` 或任何 `client_max_body_size` / proxy body limit 設定，因此**無法在應用程式層面確認或覆蓋**，需要在實際 Zeabur 部署環境用真實 9.92MB 搬家檔案實測才能確認最終結果。

## 八、本次刻意不做的事（留待後續規劃）

依需求文件第七點，本次刻意不擴大範圍實作：ZIP 匯入、streaming parser、queue worker、分片上傳、background job、S3/object storage、多檔 manifest。這些列為後續規劃項目，不在本次修復範圍內。
