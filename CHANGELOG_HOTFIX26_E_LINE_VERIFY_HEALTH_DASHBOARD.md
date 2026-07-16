# fix18-10-hotfix26-E — LINE Verify Health Dashboard × LINE Analytics Center

版本：`18.1.14` → `18.1.15`

本版新增「📡 LINE 管理」後台頁面，讓管理者不用開 Console／看 server log，就能知道
LINE Login／Verify 是否正常。**完全沒有修改 verifyLineIdToken()、Verify API 判斷邏輯、
Login／會員建立流程、CRM Timeline 寫入邏輯、JWT、LIFF Login、LINE Pay、Android**——
本版只新增「唯讀報表」與最小必要的分析用 metadata 欄位。

---

## 一、不得修改事項（確認清單）

- `utils/lineMemberAuth.js` 的 `verifyLineIdToken()` 本體、`ok/reason/message/code` 判斷邏輯：**未修改**（只有先前 Hotfix26-verify-debug/-deep 已完成的診斷 code／debug 物件，本版未再變動）。
- 登入流程、Callback、Friendship Gate、Timeline 寫入規則、CRM 判斷邏輯：**未修改**。
- 第二套 Verify／Login／路由：**未新增**——`routes/line-analytics.js` 全部是 `GET`，沒有任何 endpoint 會驗證 token、建立會員或改變登入判斷結果。
- Android：本專案沒有獨立原生 Android 專案目錄，Android 平板功能是透過既有 `public/js/app.js` 的 `android_features`／`loadAndroidFeaturesTab` 分頁提供；本版**未觸碰**這兩個既有程式碼路徑（smoke test 已驗證其仍完整存在）。

## 二、實際修改檔案

- `routes/line-member.js`
  - 在路由層（`verifyLineIdToken()` **外部**）加計時器量測耗時（`elapsed_ms`），完全不改動該函式本身。
  - 既有的 `logServerEvent(..., 'line_login_success'/'line_login_failed', ...)` 呼叫（沒有新增事件、沒有新增寫入路徑）的 `metadata` 裡新增：`http_status`、`elapsed_ms`、`diagnostic_only`（布林值，標記這筆是不是後台診斷中心自己的測試呼叫）。這是唯一新增的持久化欄位，全部存在既有的 `analytics_events.metadata_json`（TEXT JSON 欄位）裡，沒有新增資料表、沒有新增資料表欄位。
  - `verify_debug` 三條件缺一不可（需求文件十）：新增 `hasValidStaffAuth(req, storeId)`，只有「`diagnostic_only=true` **且** 伺服器設定 `LINE_MEMBER_DEBUG=1`（`verifyResult.debug` 才會存在）**且** 呼叫端帶這個 store 的有效管理員 JWT」三者同時成立，才會把 `verify_debug` 放進回應；三者缺一，回應完全不含 `verify_debug` 欄位（不是給 null，是整個 key 都不存在）。
- `public/js/app.js`
  - 新增「LINE 管理」頁籤的完整前端模組：日期選擇器（今日／昨日／近 7 天／近 30 天／本月／自訂，全部共用同一份 API 回應，不會每個區塊各打一支 API）、Verify Health 摘要卡、Error Breakdown、Verify Summary、Verify Timeline（9 欄）、LINE Analytics Funnel（含「尚未追蹤」顯示）、LINE Health、LINE OA Center。
  - `_lineDiagCheckBackendVerify()` 改用 `apiFetch()`（原本用沒帶 Authorization 的原生 `fetch()`），確保診斷中心呼叫 verify 時會帶上管理員 JWT，才能通過上面新增的三條件閘門。
  - Verify Debug 區塊改用 `<details>` 原生展開／收合（需求文件八「可展開 Verify Debug」）。
- `public/index.html`：新增「📡 LINE 管理」頁籤按鈕與完整面板（健康度卡片、Error Breakdown、Verify Summary、Timeline 表格、Funnel、Health/OA Center 網格）。
- `public/css/main.css`：沿用既有 `.line-diag-*` 系列樣式，未新增額外樣式規則需求（Hotfix26-D 已建立）。
- `server.js`：掛載 `app.use('/api/line-analytics', requireStore, requireFeature('line_order'), require('./routes/line-analytics'))`。

## 三、新增檔案

- `routes/line-analytics.js` — 唯一新增的路由檔案，只有一個 endpoint：`GET /health`。
- `scripts/smoke-hotfix26-e.js`

## 四、API 路由

```
GET /api/line-analytics/health?period=today|yesterday|last7|last30|month|custom
                               &start_date=&end_date=（period=custom 時必填）
```

- 需要有效的店家管理員 JWT（`requireStaffJwt`），未帶或無效一律 401。
- 一次回傳所有區塊需要的資料（不得每個區塊各打一支 API — 需求文件九）：

```json
{
  "success": true,
  "period": { "preset": "today", "start_date": "...", "end_date": "..." },
  "summary": {
    "total": 0, "success": 0, "failed": 0,
    "success_rate": 0, "failure_rate": 0,
    "last_success_at": null, "last_failure_at": null, "last_http_status": null
  },
  "health": { "status": "healthy|warning|critical|insufficient_data", "icon": "🟢", "text": "正常", "reasons": [] },
  "error_breakdown": [ { "label": "Audience Mismatch", "count": 2 } ],
  "timeline": [ { "created_at": "...", "store": "...", "result": "Success|Failed", "http_status": 200, "code": null, "reason": null, "elapsed_ms": 55, "diagnostic_only": false, "identity_masked": "Uxxxx****xxxx" } ],
  "line_health": { "login": {...}, "verify": {...}, "liff": {...}, "messaging_api": {...}, "friendship": {...} },
  "oa_center": { "login": {...}, "verify": {...}, "liff": {...}, "messaging_api": {...}, "friendship": {...}, "member": {...}, "timeline": {...}, "coupon": {...}, "rich_menu": {...}, "crm": {...} },
  "analytics": { "funnel": [ { "key": "login_attempts", "label": "Login Attempts", "count": 12, "tracked": true } ] }
}
```

## 五、日期計算方式

完全重用既有 `utils/dashboardDate.js` 的 `resolveDateRange()`（Hotfix23-B 建立，Dashboard 本來就在用），**沒有另外寫第二套日期邏輯**：

- `today`/`yesterday`/`month` 直接對應 `resolveDateRange` 既有的 `today`/`yesterday`/`month` preset。
- `last7`/`last30` 用 `custom` preset，起訖日期用 `subtractDays(今天, 6)`／`subtractDays(今天, 29)` 算出。
- `custom` 直接把使用者指定的 `start_date`/`end_date` 傳給 `resolveDateRange({preset:'custom', ...})`。
- 時區固定 `Asia/Taipei`（`resolveDateRange` 本身就只支援這個時區）。
- 查詢 `analytics_events` 時，比對用的是既有的 `ANALYTICS_CREATED_AT_LOCAL_EXPR`（把 UTC 的 `created_at` +8 小時再比較），與 Dashboard／老闆儀表板完全一致的做法，不是另一套時區換算。

## 六、Verify Health 規則（Rule Engine）

```
insufficient_data：期間內完全沒有 Verify 紀錄（total === 0）
critical：  成功率 < 95%  或  連續失敗 ≥ 5 次  或  HTTP 500 次數 ≥ 5
warning：   成功率 95%～97.99%  或  Audience Mismatch ≥ 1 次  或  連續失敗 3～4 次
healthy：   成功率 ≥ 98%  且  連續失敗 < 3 次  且  無 HTTP 500
```
判斷優先權：critical > warning > healthy；資料不足一律 insufficient_data，不會被誤判成 healthy。

## 七、Verify Timeline 資料來源

`analytics_events` 表（既有表，Hotfix23-A 建立），`event_name IN ('line_login_success','line_login_failed')`，依 `created_at DESC LIMIT 50`。欄位對應：

| 顯示欄位 | 來源 |
|---|---|
| 時間 | `created_at`（顯示時轉 Asia/Taipei） |
| Store | `stores.store_name`（依目前 JWT 的 store_id 查一次，不是逐列查） |
| Result | `event_name` 是 success 還是 failed |
| HTTP Status | `metadata_json.http_status`（本版新增欄位） |
| Code / Reason | `metadata_json.code` / `metadata_json.reason`（既有欄位，Hotfix26-verify-debug 就有） |
| Elapsed ms | `metadata_json.elapsed_ms`（本版新增欄位） |
| Diagnostic Only | `metadata_json.diagnostic_only`（本版新增欄位） |
| Identity（遮罩） | `analytics_events.identity_key`（既有欄位，格式 `line_user:Uxxxx`），取出後用既有 `maskLineUserId()` 遮罩 |

**沒有新增資料表**——`analytics_events` 的既有欄位／既有 `metadata_json` 完全足以承載這次需要的所有資訊，故未建立新表。

## 八、LINE Analytics Funnel 資料來源

| 項目 | 來源 | 是否可靠追蹤 |
|---|---|---|
| Login Attempts / Verify Success / Verify Failed | `analytics_events`（line_login_success/failed 計數） | ✅ |
| Member Created / Member Updated | `line_member_history`（event_name = new_member / profile_updated，既有表） | ✅ |
| Friend Added | `line_member_history`（friend_added + friend_restored） | ✅ |
| Timeline Written | `line_member_history` 期間內總筆數 | ✅ |
| Coupon Issued | 無 | ❌ 顯示「尚未追蹤」，`count:null`，不假造為 0 |

## 九、權限與 Debug 閘門

- 所有 `/api/line-analytics/*` endpoint：`requireStaffJwt`（本專案目前的店家管理員角色即 `role:'store'`；本專案架構本身沒有再往下分「一般 POS 員工」的獨立登入角色，`requireStaffJwt` 已是現有架構中對應「Store Admin」的最高相關管制點，已誠實在報告中註記此架構限制）。
- `verify_debug` 三條件缺一不可：`LINE_MEMBER_DEBUG=1`（伺服器環境變數）**且** `diagnostic_only=true` **且** 呼叫端帶該 store 的有效管理員 JWT。三者缺一，回應完全不含 `verify_debug` 這個 key。

## 十、敏感資料保護方式

- Timeline／Verify Debug 皆不含：完整 `id_token`／`access_token`／`Authorization` header／`client_secret`／`channel_secret`／完整 LINE User ID。
- Identity 一律用既有 `maskLineUserId()`（`utils/lineMemberStats.js`）遮罩後才顯示。
- `metadata_json` 只新增 `http_status`/`elapsed_ms`/`diagnostic_only` 這三個非敏感欄位，沒有新增任何 token/secret 相關欄位。

## 十一、tenant isolation 驗證

- 所有 SQL 查詢一律 `WHERE store_id=?`（`req.storeId`，由 `requireStaffJwt` 從 JWT payload 設定，不接受前端傳入覆蓋）。
- Smoke test 已驗證：另一店家的資料不會出現在 store_001 的回應裡；未在 `stores` 表註冊的 store_id 即使帶「看似有效」的 JWT，也會被更前面的 `requireStore` 中介層擋下（403）。

## 十二、Smoke Test 結果

```
node scripts/smoke-hotfix26-e.js          → PASS=48 FAIL=0 MANUAL REQUIRED=2
```

回歸（全部沿用既有 smoke test，皆 FAIL=0）：
```
smoke-hotfix25.js               → PASS=26
smoke-hotfix26-a.js             → PASS=24
smoke-hotfix26-b.js             → PASS=30
smoke-hotfix26-c.js             → PASS=24
smoke-hotfix26-d.js             → PASS=20
smoke-hotfix26-verify-debug.js  → PASS=37
smoke-hotfix26-verify-deep.js   → PASS=36
```

另外確認：所有觸及 JS `node --check` 通過；`index.html` 無重複 HTML id；新增 HTML id 與 JS selector 全部一致；`main.css` 大括號配對；`server.js` 已掛載 `/api/line-analytics`；`initDb()` 連續呼叫兩次無錯誤。

MANUAL REQUIRED（2 項，皆與環境變數在 process 啟動時就固定有關，無法在同一支 smoke test 內用不同 `LINE_MEMBER_DEBUG` 值重啟 server 驗證所有排列組合）：
- `LINE_MEMBER_DEBUG=1` 但無有效 JWT 時是否正確不回傳 `verify_debug`（已用程式碼檢視確認 `hasValidStaffAuth()` 在條件式的 `&&` 中）。
- `LINE_MEMBER_DEBUG=1` + 有效 JWT + `diagnostic_only=true` 時是否完整回傳 `verify_debug`（`verifyLineIdToken()` 本身產生 debug 物件的正確性已在 `smoke-hotfix26-verify-deep.js` 驗證過）。

## 十三、確認 Verify 邏輯未修改

`utils/lineMemberAuth.js` 的 `verifyLineIdToken()` 函式本體、`classifyVerifyApiFailure()`、`isAudienceMatch()`、`isTokenExpired()` 等既有判斷邏輯，本版**完全沒有修改**（比對 Hotfix26-verify-deep 版本與本版檔案內容一致）。本版對 `routes/line-member.js` 的唯一改動是：① 在該函式呼叫**外部**加計時器（不改函式本身）；② 既有 `logServerEvent` 呼叫的 metadata 新增三個非判斷用欄位；③ `verify_debug` 的三條件缺一不可閘門（只影響「要不要多回傳一個除錯用欄位」，不影響 `success`/`code`/`message` 等既有判斷欄位）。`smoke-hotfix26-verify-debug.js`／`smoke-hotfix26-verify-deep.js` 兩支涵蓋 Verify 邏輯本身的既有 smoke test 全數 FAIL=0，證明判斷邏輯未受影響。

## 十四、確認 Android 未修改

本專案沒有獨立 Android 原生專案（Android 平板是透過既有後台網頁的 `android_features` 分頁 + WebView 存取），本版 diff 範圍只涉及：`routes/line-analytics.js`（新增）、`routes/line-member.js`（metadata 與 debug 閘門）、`public/js/app.js`（新增 LINE 管理頁籤模組）、`public/index.html`（新增頁籤）、`server.js`（掛載路由）、`package.json`（版本號）。與 Android 平板功能相關的 `loadAndroidFeaturesTab()`／`android_features` 程式碼路徑未被觸碰，smoke test 已確認其仍完整存在。
