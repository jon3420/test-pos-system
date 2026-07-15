# fix18-10-hotfix23-E1｜LINE Member Admin JWT × Return URL Allowlist × CSV Security

基礎版本：`fix18-10-hotfix23-E`（LINE Member Gate × LIFF Login × Friend Status × LINE CRM Foundation × Customer Journey）

本版只修正 Hotfix23-E 已知的三項安全缺口，不擴充任何新功能（會員點數／等級／手機會員／QR 會員／LINE 推播／自動催單／自動優惠券／Membership Center／Hotfix24 一律不在本版範圍）。

---

## 1. Root Cause

現況稽核（修改前）確認的三個問題：

1. **管理端 API 只靠 `requireStore`**：`app.use('/api/line-member', requireStore, requireFeature('line_order'), ...)` 中的 `requireStore`（`middleware/storeGuard.js`）會依序嘗試 `Bearer JWT → x-store-id header → query.store_id` 解析 `store_id`，且沒有 fallback 以外的拒絕條件。這代表 `GET /api/line-member/members`、`GET /api/line-member/members/:id`、`GET /api/line-member/members/export` 這三個「管理端」路由，只要帶對的 `x-store-id` 或 `?store_id=` 就能查到會員資料，完全不需要登入 JWT。
2. **Return URL 只驗證 HTTPS**：`routes/settings.js` 儲存 `line_member_return_url` 時只用 `/^https:\/\//i` 檢查開頭是不是 `https://`，沒有網域白名單，理論上可以存入 `https://evil.com/phish` 這種值。
3. **CSV 匯出只做雙引號跳脫**：`routes/line-member.js` 的 `GET /members/export` 只把值包雙引號、把 `"` 轉成 `""`，沒有處理以 `=` `+` `-` `@` 開頭的欄位，用 Excel／Numbers 開啟時可能被解讀成公式（CSV Formula Injection / DDE injection）。

`POST /api/line-member/verify`（顧客登入用）本身沒有這些問題，維持不動。

---

## 2. 修改檔案

| 檔案 | 修改內容 |
|---|---|
| `middleware/storeGuard.js` | 新增 `requireStaffJwt` middleware（新增函式，不改動既有 `requireStore` / `requireSuperAdmin` 行為） |
| `routes/line-member.js` | `GET /members`、`GET /members/:id`、`GET /members/export` 套用 `requireStaffJwt`；CSV 匯出改用 `sanitizeCsvCell()`；CSV 檔名改為 `line-members-YYYY-MM-DD.csv` |
| `routes/settings.js` | `line_member_return_url` 儲存驗證改用 `validateLineMemberReturnUrl()`（allowlist），且只在該欄位「本次請求有實際送值」時才驗證，避免舊資料擋住其他欄位的儲存 |
| `utils/returnUrlValidator.js` | 新增。Return URL allowlist 驗證共用函式 |
| `utils/csvSecurity.js` | 新增。CSV Formula Injection 防護共用函式 |
| `public/js/line-member-gate.js` | `buildReturnUrl()` 加入執行時安全檢查（同源檢查）與安全 fallback，不改動 LIFF 登入核心流程（仍以 `window.location.href` 組網址） |
| `public/js/app.js` | LINE 會員 CSV 匯出改用既有的 `downloadWithAuth()`（帶 Authorization header 的 blob 下載），取代 `window.open()` |

沒有修改：`line_member` DB schema、LTV／CRM 統計規則、LINE Pay、Analytics schema、POS、Android、任何 migration。

---

## 3. JWT 管理端授權規則

新增 `requireStaffJwt`（`middleware/storeGuard.js`），套用於：

```
GET /api/line-member/members
GET /api/line-member/members/:id
GET /api/line-member/members/export
```

規則：

1. 必須有 `Authorization: Bearer <JWT>`，否則 **401** `NO_JWT`。
2. JWT 簽章無效或已過期 → **401** `INVALID_JWT`。
3. JWT `role === 'super_admin'` → **403** `SUPER_ADMIN_NOT_ALLOWED`（沿用 `requireStore` 既有原則：Super Admin token 不可直接用於店家 API）。
4. JWT 缺少 `store_id` → **401** `NO_STORE_IN_TOKEN`。
5. `store_id` 對應店家不存在／已停用 → **403**。
6. 通過後，`req.auth = { store_id, role, store_name }`，並且 **覆蓋** `req.storeId = req.auth.store_id`——後續查詢一律用這個值，`query.store_id` / `body.store_id` / `x-store-id` header 完全不影響管理端授權判斷（`requireStore` 本身仍會先跑一次並可能用 `x-store-id`/`query` 設定暫時的 `req.storeId`，但 `requireStaffJwt` 會用 JWT 內的值覆蓋掉，等於管理端最終只認 JWT）。

一般顧客的 `member_session`（`utils/lineMemberSession.js` 簽發，供 `POST /verify` 之後前台下單使用）與這裡的 staff JWT 是不同的簽章內容／用途，`requireStaffJwt` 只認 `store-login` 簽發、`role !== 'super_admin'` 且含 `store_id` 的 JWT，`member_session` 拿來當 `Authorization: Bearer` 一樣會被 `jwt.verify` 判無效 → 401。

## 4. 公開 verify endpoint 保留方式

`POST /api/line-member/verify` **沒有**加上 `requireStaffJwt`，維持只受：

- `requireStore`（`app.use('/api/line-member', requireStore, requireFeature('line_order'), ...)`）
- `requireFeature('line_order')`
- 檔案內既有的每店 + IP rate limit（60 秒 20 次）

保護。做法是把 `requireStaffJwt` **個別**掛在三個管理端 route 上（`router.get('/members', requireStaffJwt, ...)` 等），而不是掛在整個 router 或 `app.use('/api/line-member', ...)` 上，所以顧客登入流程完全不受影響。

## 5. Store isolation

- `requireStaffJwt` 只信任 JWT payload 裡的 `store_id`，不接受 `req.query.store_id` / `req.body.store_id` / `req.headers['x-store-id']` 作為管理端授權依據（這三個 route handler 內部原本就是用 `req.storeId` 做 `WHERE store_id=?`，現在這個值保證來自 JWT）。
- Super Admin 目前**沒有**對應的跨店 line-member 管理端點；`requireStaffJwt` 直接拒絕 `role === 'super_admin'` 的 token，避免有人拿 Super Admin token 冒充店家 staff。如果未來需要跨店查詢，應該比照 `routes/superAdmin.js` 既有模式另外開一支 `/api/super-admin/...` 端點，本版不新增。

## 6. Return URL allowlist 規則

新增 `utils/returnUrlValidator.js` 的 `validateLineMemberReturnUrl(url, context)`。

**允許來源（依序）：**

1. `APP_BASE_URL` / `PUBLIC_BASE_URL`（環境變數，解析出 hostname）
2. `ALLOWED_HOSTS`（環境變數，逗號分隔）
3. `LINE_MEMBER_RETURN_URL_ALLOWLIST`（環境變數，逗號分隔，LINE 會員專用）
4. 開發環境（`NODE_ENV !== 'production'`）額外允許 `http://localhost` / `http://127.0.0.1`

子網域規則明確化，不使用 `includes()` / 子字串比對：

- allowlist 寫 `example.com` → 只允許完全等於 `example.com`
- allowlist 寫 `*.example.com` → 允許 `example.com` 的任意子網域（不含 apex 本身，若要兩者都允許需各寫一筆）

**一律拒絕：**

- `javascript:` `data:` `file:` `ftp:` `blob:` `vbscript:`
- 含 `user:password@`
- 協定相對 URL `//evil.com`
- 反斜線混淆 `https:\\evil.com`（丟進 URL parser 前就先擋）
- 非 allowlist 網域，包含後綴欺騙 `pos-system.zeabur.app.evil.com`（`h.endsWith('.'+allowed)` 而不是 `includes()`，所以 `xxx.evil.com` 不會誤配到 `evil.com` 以外的允許網域）
- 正式環境（`NODE_ENV==='production'`）使用 `http:`

`routes/settings.js` 的 `PUT /api/settings`：

- 只在**本次請求實際送了 `line_member_return_url`** 時才驗證（避免歷史舊值擋住這次請求裡其他欄位的儲存——符合「未啟用 Gate 時可保留合法舊值，非法舊值不得重新儲存」的原則：沒重新送這個欄位，就不會被要求重新驗證/也不會被重寫）。
- 驗證失敗回 400，訊息：「登入返回網址不在允許的網域內，請使用目前 POS 系統網域的 HTTPS 網址。」

## 7. Host header 防護

`validateLineMemberReturnUrl` **預設不信任** `req.hostname`（Express 在沒有設定 `app.set('trust proxy', ...)` 時，`req.hostname` 就是直接讀 client 送來的 `Host` header，屬於可被偽造的輸入）。只有維運者明確設定環境變數 `TRUST_REQUEST_HOST=true`（代表已經確認 proxy/trust 設定正確）時，才會把當下 request host 加入允許清單。預設情況下，allowlist 完全由 `APP_BASE_URL` / `PUBLIC_BASE_URL` / `ALLOWED_HOSTS` / `LINE_MEMBER_RETURN_URL_ALLOWLIST` 這幾個環境變數決定，不會因為換了 Host header 就自動放行新網域。

## 8. Runtime fallback

`public/js/line-member-gate.js` 的 `buildReturnUrl()`：

- 目前 LIFF 登入的 `redirectUri` 一律是用 `window.location.href` 組出來的（本來就是同源網址，不是直接採用店家設定的 `line_member_return_url`），所以嚴格來說目前程式碼路徑本身沒有可利用的漏洞；這裡加的 `isSafeReturnUrl()` 檢查是防禦性的第二道保險，避免未來若改成直接採用店家設定值卻忘記驗證。
- 檢查失敗（理論上不會發生於現有流程，但仍保留 fallback 邏輯）時，改用 `window.location.origin + window.location.pathname + '?store_id=' + storeId`，絕不直接把未經驗證的網址交給 `liff.login({ redirectUri })`。
- `console.warn` 只印出「驗證失敗，改用安全 fallback」的固定文字，不印完整網址。

伺服器端（`routes/settings.js`）在儲存時驗證失敗，也只用 `console.warn` 記錄 `store_id` / `hostname`（從送進來的網址取出的 hostname） / `reason`，不記錄完整網址或 query string。

> 已知限制：本版沒有把 `line_member_return_url_rejected` 寫進 `analytics_events` 資料表（那張表的欄位設計是給有 `visitor_id` / `session_id` 的顧客行為事件用，這裡是後台設定操作，型態不同；專案目前也沒有通用的 audit log 機制）。目前只用 `console.warn` 做最小化、不含敏感資訊的伺服器端記錄，符合本版「不得為此大改架構」的原則，未來如需要正式稽核紀錄，建議另外開一張獨立的 admin audit log 資料表，不與 analytics_events 混用。

## 9. CSV Formula Injection 防護

新增 `utils/csvSecurity.js` 的 `sanitizeCsvCell(value)`：

1. `null`/`undefined` → `''`
2. 轉字串
3. 移除危險控制字元（保留 `\t` `\r` `\n`、中文、emoji，讓步驟 4 判斷得到 `\t`/`\r` 開頭）
4. `trimStart` 後第一個字元若為 `=` `+` `-` `@` `\t` `\r`，在**該字元前**（保留原本的前導空白）插入單引號 `'`
5. 雙引號 escape（`"` → `""`），整格包雙引號

套用在 `GET /api/line-member/members/export` 每一個欄位（含 header）。已用以下測資實測（見章節 11）：

```
=SUM(1+1)          → '=SUM(1+1)
+cmd|' /C calc'!A0 → '+cmd|' /C calc'!A0
-10+20              → '-10+20
@SUM(A1:A2)         → '@SUM(A1:A2)
  =SUM(A1:A2)        → 前導空白保留，"  '=SUM(A1:A2)"
包含"雙引號          → 雙引號正確 escape
包含,逗號            → 整格加雙引號，逗號不會逃逸欄位
包含換行             → 換行保留在雙引號欄位內，不逃逸
```

其餘既有規則維持：

- LINE User ID 只匯出 `maskLineUserId()` 遮罩值，不匯出完整 `line_user_id`。
- 不匯出 `member_session` / Access Token / ID Token / Channel Secret / JWT。
- `Content-Type: text/csv; charset=utf-8`，內容前綴 `\uFEFF`（UTF-8 BOM，Excel 中文正常顯示）。
- `Content-Disposition: attachment; filename="line-members-YYYY-MM-DD.csv"`（改自舊版 `line_members_${storeId}.csv`）。

## 10. CSV 前端下載方式

`public/js/app.js`：

- 新增 `downloadLineMembersCsv()`，直接呼叫既有（本來就用在其他匯出功能上的）`downloadWithAuth('/api/line-member/members/export', 'line-members.csv')`：`apiFetch`（帶 `Authorization: Bearer` header）→ 檢查 `response.ok` → `blob()` → `URL.createObjectURL()` → 建立隱藏 `<a>` → `click()` → `URL.revokeObjectURL()`。失敗時用既有 `showToast('❌ ' + msg, 'error')` 顯示錯誤（401 時 `apiFetch` 本身會 `clearToken()` + 顯示登入畫面，等於「請重新登入後再試」）。
- 保留舊函式名稱 `exportLineMembersCsv()`（內部呼叫 `downloadLineMembersCsv()`），因為 `public/index.html` 的按鈕 `onclick="exportLineMembersCsv()"` 沒有更動，維持相容。
- 不再使用 `window.open('/api/line-member/members/export?store_id=...')`，JWT 不會出現在 query string / 瀏覽器歷史紀錄。
- 會員列表（`loadLineMembersList`）、會員詳情（`openLineMemberDetail`）本來就是透過 `apiFetch()` 呼叫，`apiFetch` 本來就會自動帶 `Authorization` header，不需修改。

## 11. 安全測試結果

實際啟動 server（`node server.js`，本機 sqlite/sql.js 測試資料庫）以 `curl` 測試，測完已清除測試資料。

**A. JWT**

| 測試 | 結果 |
|---|---|
| 無 JWT 查 `/members` | `401` ✅ |
| 無 JWT 查 `/members/:id` | `401` ✅ |
| 無 JWT 查 `/members/export` | `401` ✅ |
| 假 JWT（`Bearer not.a.jwt`） | `401` ✅ |
| 合法 store_001 JWT 查 `/members` | `200` ✅ |
| store_001 JWT + `?store_id=store_002` | 回傳的是 JWT 內 `store_001` 的資料（不是 `store_002`），實測 `store_002` 這家店根本不存在也不受影響 ✅ |
| `POST /verify` 無 JWT（帶假 `id_token`） | `400`（因為 `id_token` 驗證失敗，不是被 JWT 擋下的 `401`）→ 確認公開路徑仍可執行 ✅ |

過期 JWT / 權限不足角色：程式邏輯上由 `jwt.verify` 過期例外走 `401` 分支、`role` 非 `store` 時走 `403` 分支（本專案目前 staff JWT 只有 `role:'store'` 這一種角色，没有更細的權限分級，見「已知限制」）。

**B. Return URL** — 見章節 6，`node -e` 單元測試全數通過，涵蓋 evil.com／後綴欺騙／`javascript:`／`data:`／`//evil.com`／反斜線混淆／`user:pass@`／正式環境 HTTP／開發環境 localhost／子網域規則。

**C. CSV** — 見章節 9，實際插入 9 筆惡意測試資料到 `line_members` 後匯出，確認：公式字首全部加上 `'`、逗號/雙引號/換行沒有讓欄位逃逸、中文正常、`line_user_id` 只有遮罩值（`Utest****xxxx`）、沒有任何 Token/Secret 字樣。

**D. Store Isolation** — `requireStaffJwt` 直接把 `req.storeId` 覆蓋成 JWT 內的 `store_id`，`/members`、`/members/:id`、`/members/export` 三支都吃同一個 `req.storeId`，程式碼層級保證不會跨店。

## 12. Regression 結果

- `node --check` 全數通過：`server.js`、`routes/*.js`、`utils/*.js`、`middleware/*.js`、`public/js/*.js`。
- `public/line-order.html`、`public/line-shipping.html` inline `<script>` 抽出後 `node --check` 通過。
- `public/index.html`、`public/line-order.html`、`public/line-shipping.html` `<div>`/`</div>` 數量一致；`line-shipping.html` 唯二的「重複 id」是樣板字串 `id="${p.id}"` / `id="${c.product.id}"`（清單項目動態 id，非靜態重複，正常）。
- 修改範圍只有 7 個檔案（`middleware/storeGuard.js`、`routes/line-member.js`、`routes/settings.js`、`utils/returnUrlValidator.js`、`utils/csvSecurity.js`、`public/js/app.js`、`public/js/line-member-gate.js`），沒有動到 migration、schema、其他 route。
- Server 實測啟動成功，`GET /api/store-me`、`POST /api/store-login` 等既有 API 正常回應。
- 沒有修改：`POST /api/line-member/verify` 的驗證/好友狀態/upsert/CRM history 邏輯、`member_session`、LIFF Login 核心流程、Entry/Checkout Gate 判斷邏輯、外帶/外送/冷藏宅配、LINE Pay、優惠券、Business Calendar、購物車永久保留、Meta Pixel、GA4、Ads Attribution、LINE CRM Dashboard / LTV / 首購回購統計、POS、Android。

## 13. 已知限制

1. Super Admin 沒有專用的跨店 line-member 查詢端點；目前設計是直接拒絕 super_admin token 存取這三支管理端 API，如需要跨店查詢須另外比照 `routes/superAdmin.js` 開發，本版不包含。
2. 目前 staff JWT 只有單一角色 `role:'store'`（`routes/storeLogin.js` 簽發），沒有更細的權限分級（例如唯讀 vs 可匯出），所以「JWT 有效但權限不足 → 403」目前等同於「非 store/非本店」的情況；若未來要做角色分級，需要先在 `storeLogin.js` / JWT payload 設計新的 `permissions` 欄位。
3. `line_member_return_url_rejected` 沒有寫入 `analytics_events`，只做 `console.warn`（見章節 8 已知限制說明）；`line_members_list_view` / `line_member_detail_view` / `line_members_csv_export` 這三個管理端操作也**沒有**寫入任何 audit log —— 專案目前沒有通用 audit log 機制，本版依需求文件原則不為此大改架構。
4. Return URL allowlist 中 request host 的信任預設關閉（見章節 7），如果維運者手動把 `TRUST_REQUEST_HOST=true` 又沒有正確設定反向代理 / `trust proxy`，Host header 仍可能被偽造；正式環境建議一律設定 `APP_BASE_URL`，不要開啟 `TRUST_REQUEST_HOST`。
5. `line_member_return_url` 目前在既有的 LIFF 登入流程中實際上還沒有被拿來當作跳轉目標（`buildReturnUrl()` 用的是 `window.location.href`），本版的 allowlist 驗證主要是保護「儲存」與「未來若真的拿此值做跳轉」時的資料安全，不代表現在就存在可被利用的開放重導向漏洞。

## 14. 回退方式

本版只改了 7 個檔案且都是新增邏輯／收緊授權，沒有動 DB schema 與 migration，回退方式：

1. 還原這 7 個檔案到 `fix18-10-hotfix23-E` 版本：
   - `middleware/storeGuard.js`
   - `routes/line-member.js`
   - `routes/settings.js`
   - `public/js/app.js`
   - `public/js/line-member-gate.js`
2. 刪除新增檔案：
   - `utils/returnUrlValidator.js`
   - `utils/csvSecurity.js`
3. 若正式環境已經設定 `APP_BASE_URL` / `PUBLIC_BASE_URL` / `ALLOWED_HOSTS` / `LINE_MEMBER_RETURN_URL_ALLOWLIST` / `TRUST_REQUEST_HOST` 這些新環境變數，回退後可以保留不動（回退版本不會讀取它們，不影響行為）。
4. 不需要任何資料庫還原操作（沒有新增/修改資料表欄位、沒有跑過會變更既有資料的 migration）。
