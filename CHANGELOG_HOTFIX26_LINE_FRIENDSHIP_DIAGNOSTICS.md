# fix18-10-hotfix26 — LINE 好友狀態同步 × 官方帳號強制加入 × LINE 設定診斷中心 × 會員畫面修正

版本：`18.1.13` → `18.1.14`

本次 Hotfix26 延續 Hotfix25（LINE 會員共用登入中心），分四個子階段完成：

- **Hotfix26-A**：Backend／Database／CRM
- **Hotfix26-B**：LINE Friendship Gate（前台）
- **Hotfix26-C**：會員後台 UI（好友三態／篩選／深色 Modal／台灣時區）
- **Hotfix26-D**：LINE 設定診斷中心

---

## Hotfix26-A｜Backend／Database／CRM

### Database

`is_friend`、`last_friend_check` 欄位在 Hotfix23-E 就已存在（`utils/db.js`，`CREATE TABLE IF NOT EXISTS` ／ try-catch 包住的 `ALTER TABLE`），**本次沒有新增任何欄位或資料表**，直接沿用，migration 維持可重複執行、不刪資料、不重建會員表。

### 修改檔案

- `routes/line-member.js`
  - 新增 `normalizeFriendFlag()`：只接受真正的 `true`/`false`，其餘（`"true"`／`1`／`{}`／`undefined`…）一律視為 `null`。
  - 新增 `friendStatusLabel()`：`1/0/null` → `'friend'/'non_friend'/'unknown'`。
  - 新增 `meetsRequirement(requireFriend, isFriend)`：`requireFriend=false` 恆為 `true`；`requireFriend=true` 時 `1/0/null` → `true/false/null`（未知不可誤判）。
  - `POST /verify`：
    - 接收前端 `friend_flag`（liff.getFriendship() 結果）與 `diagnostic_only`。
    - 好友狀態以後端自行呼叫 LINE Friendship API（`access_token`）的結果為主；只有後端查不到時，才 fallback 採用前端送來的、經 `normalizeFriendFlag()` 正規化過的 `friend_flag`。
    - `diagnostic_only=true` 時，只做 Token 驗證與好友狀態查詢，**不呼叫 `upsertMemberProfile`／`linkMemberSession`／`updateTouchAttribution`／不寫入任何 `logServerEvent`**，回傳後立即 return，不觸碰資料庫寫入路徑。
    - 回應新增：`require_friend`（＝`require_follow`別名）、`friend_status`、`meets_requirement`、`last_friend_check_at`（＝既有 `last_friend_check`別名）。
  - `GET /members`：新增 `friend_status=all|friend|non_friend|unknown` 篩選，與既有 `filter`／`q`／`sort`／分頁／`store_id` 隔離可同時使用。
  - `GET /members/:id`：新增 `friend_status`／`require_friend`／`require_follow`／`meets_requirement`／`last_friend_check_at`。
  - 把 `normalizeFriendFlag`／`friendStatusLabel`／`meetsRequirement` 掛在 `router._test` 上，只供 smoke test 用。
- `utils/lineMemberStats.js`
  - `upsertMemberProfile()` 新增 `crmFriendEvent` 計算：`friend_status_checked`（首次取得好友狀態）／`joined_official_account`（非好友→好友）／`unfollowed_official_account`（好友→非好友），寫入 `line_member_history`（CRM Timeline）。
  - **完全不刪除、不取代**既有的 `friend_added`／`friend_removed`／`friend_restored`（`friendEvent`）—— `utils/dashboardAnalytics.js` 的好友漏斗圖表直接查 `line_member_history` 裡這幾個舊事件名稱，取代掉會讓 Dashboard 少算。新舊事件命名**並存寫入**。
  - `friend_flag=null` 時不覆蓋既有已知的 `is_friend`，也不更新 `last_friend_check`（沿用既有欄位語意：只在成功查到狀態時更新確認時間）。

### 新增檔案

- `scripts/smoke-hotfix26-a.js`

---

## Hotfix26-B｜LINE Friendship Gate（前台）

### 修改檔案

- `public/js/line-member-gate.js`
  - `getClientFriendFlag()`：每次登入／每次 verify 都重新呼叫 `liff.getFriendship()`，失敗一律回 `null`，不阻擋登入流程。
  - `verifyWithBackend()`：每次呼叫都會先取得 `friend_flag` 並送給後端。
  - `normalizeServerFriendStatus(response)`：統一判斷 `is_friend`／`friend_status`（含 `member` 內層）→ `true/false/null`。
  - `normalizeRequireFollow(response)`：`require_follow` 或 `require_friend` 任一為 `true` 即視為要求好友。
  - `friendRequirementMet(requireFollow, isFriend)`：`requireFollow=false` 全放行；`requireFollow=true` 時 `true→放行`／`false→阻擋`／`null→放行`（未知不誤判）。
  - `openFriendAddPage()`：優先 `liff.requestFriendship()`；不支援／拋例外／使用者取消一律 fallback 到 `add_friend_url`（LINE App 內用 `liff.openWindow`，外部瀏覽器用 `window.open`）；沒有網址時顯示友善訊息、不拋例外；**全程不觸碰購物車、sessionStorage 返回網址、登入中旗標**。
  - `recheckFriendship()`：`_friendRecheckInFlight` 旗標防連點併發。
  - `showFriendRequiredGate()` + `ensureFriendRequirement()`：沿用同一個 `#lineMemberGate` Overlay／`closeMemberGate()`，不是另一套 Modal；`_friendGateCompletedStores[storeId]` 記錄「這個分頁這次已通過好友確認」，避免同一 store 重複打開 Gate（防循環，不新增 sessionStorage key）。
  - `requireMemberBeforeCheckout()`／`requireMemberOnEntry()`：**即使已有 session，也會透過 `ensureFriendRequirement()` 再檢查一次好友要求**（涵蓋「設定是後來才開啟」的情境）。
  - 新增匯出：`loadLiffSdk`（供 Hotfix26-D 診斷中心重用，不重複寫 SDK 載入邏輯）。
- `public/line-order.html`／`public/line-shipping.html`：**本階段未修改**，Hotfix25 既有的 checkout 面板自動重開機制原樣保留；送單前一律再跑一次 `requireMemberBeforeCheckout()`，確保視覺恢復不會繞過 `require_follow`。

### 新增檔案

- `scripts/smoke-hotfix26-b.js`

---

## Hotfix26-C｜會員後台 UI

### 修改檔案

- `public/js/app.js`
  - `renderFriendStatus(value)` / `friendStatusHtml(value)`：`true/1/'friend'` → 🟢好友；`false/0/'non_friend'` → 🔴非好友；其餘（含 `null`）→ ⚪未知。不用 truthy 判斷，避免 `0` 被誤判成假值。
  - `parseUtcDate(value)`／`formatTaipeiDateTime(value, includeSeconds)`：資料庫繼續存 UTC；無時區的 SQL `'YYYY-MM-DD HH:MM:SS'` 字串（`datetime('now','localtime')` 寫入）與帶 `Z` 的 JS UTC ISO 字串（`friend_since`／`last_friend_check`）都統一視為 UTC 再轉換為 `Asia/Taipei`，避免瀏覽器把 UTC 字串誤當本地時間；無效輸入一律顯示 `—`。
  - `LINE_MEMBER_EVENT_LABELS` / `friendEventLabel()`：CRM Timeline 事件中文顯示（新舊事件皆有名稱；未知事件顯示原始 `event_name`，不會整段消失）。
  - `loadLineMembersList()`：新增 `friend_status` 篩選（獨立於既有 `lmFilterSelect`）、分頁（`limit`/`offset` + `lmPager`）；篩選改為 `change` listener（只在 `switchSettingsTab('line_members_list')` 時綁定一次，不重複綁定、不重複送出請求），切換篩選一律回到第 1 頁但保留其他搜尋條件。
  - `openLineMemberDetail()`：改用深色 `member-detail-modal` 結構渲染，新增好友狀態／最後確認／官方帳號要求／符合要求（`meets_requirement` 為 `null` 時顯示「無法確認」，不誤顯示為「不符合」），所有時間欄位改用 `formatTaipeiDateTime()`，CRM Timeline 改用 `friendEventLabel()` + `includeSeconds=true`。
- `public/index.html`：`lmDetailModal` 容器改用 `.member-detail-modal` 深色樣式（移除舊的白底 inline style）；新增 `lmFriendStatusSelect`（好友狀態篩選）、`lmPager`（分頁）；移除 `lmFilterSelect`／`lmSortSelect` 的 inline `onchange`（改由 JS 統一綁定）。
- `public/css/main.css`：新增 `.friend-status--yes/no/unknown`、`.member-detail-modal` 系列 class（含手機 RWD、Timeline 可滾動、關閉按鈕樣式）。

### 新增檔案

- `scripts/smoke-hotfix26-c.js`

---

## Hotfix26-D｜LINE 設定診斷中心

### 修改檔案

- `public/js/app.js`：新增診斷中心模組（`_lineDiag*` 系列函式）：
  - `_lineDiagCheckLiffIdFormat`／`_lineDiagCheckChannelConsistency`：LIFF ID 格式與 Channel ID 前綴一致性（不一致時附上目前 LIFF ID／Channel ID 供人工比對）。
  - `_lineDiagInitLiff`：重用 `LineMemberGate.loadLiffSdk()`；同一個 `liff_id` 已初始化過就不重複 `liff.init()`。
  - `_lineDiagCheckLogin`／`_lineDiagCheckFriendApi`：只有已登入才呼叫 `liff.getFriendship()`；未登入不強制跳轉 LINE Login，只顯示「需先登入 LINE」。
  - `_lineDiagCheckBackendVerify`：已登入時呼叫 `POST /api/line-member/verify { diagnostic_only:true }`（沿用 Hotfix26-A，不寫入任何資料）；未登入時退回 `GET /api/settings` 做純連線檢查。
  - `_lineDiagCheckDomain`／`_lineDiagCheckReturnUrl`：HTTPS／origin／`LineMemberGate.validateSafeInternalReturnUrl()` 驗證返回網址。
  - `_lineDiagCheckBasicId`／`_lineDiagCheckAddFriendUrl`：格式檢查（格式錯誤只是警告，不代表無法登入；`require_follow=true` 且未設定加好友網址才算異常）。
  - `_lineDiagCheckOldDomain`：只在**目前設定值／目前頁面網址**實際找到舊網域字串時才回報異常，不會因 changelog／歷史文件而誤判（前端本來就讀不到那些檔案）。
  - `_computeLineDiagHealth`：健康度 0–100 分（LIFF 格式 10／Channel 一致 10／LIFF 初始化 15／LINE Login 10／Friend API 15／Backend Verify 15／HTTPS 10／返返網址 10／OA 設定 5），`warn`/`untested` 給 50% 分數、`error` 給 0 分；**尚未登入不會被判定為整體故障**。90–100 綠燈、70–89 黃燈、0–69 紅燈。
  - `runLineDiagnostics()`：一鍵執行全部檢查，按鈕測試中 disabled、每一項獨立顯示、失敗不讓整頁崩潰、可重新測試。
  - Callback URL／Endpoint 一律顯示「🟡 需人工確認」+ 建議值 + 複製按鈕，**不假裝能自動讀取 LINE Developers 真實設定**。
  - `copyLineDiagText()`：`navigator.clipboard.writeText()` + `execCommand('copy')` fallback。
  - `buildLineDiagSummaryText()`／`copyLineDiagSummary()`：可複製的診斷摘要，**不含 ID Token／Access Token／Channel Secret／完整 LINE User ID／Session Cookie／Authorization header**。
- `public/js/line-member-gate.js`：`loadLiffSdk` 加入 `LineMemberGate` 公開 API（供診斷中心重用）。
- `public/index.html`：載入 `public/js/line-member-gate.js`（原本後台頁面沒有載入這支共用模組）；LINE 會員登入設定分頁新增「🔌 LINE 連線測試」卡片（健康度、逐項狀態、測試／複製診斷結果按鈕）。
- `public/css/main.css`：新增 `.line-diag-*` 系列樣式。

### 新增檔案

- `scripts/smoke-hotfix26-d.js`

---

## 自動測試結果

```
node scripts/smoke-hotfix25.js      → PASS=26 FAIL=0 MANUAL REQUIRED=3
node scripts/smoke-hotfix26-a.js    → PASS=24 FAIL=0 MANUAL REQUIRED=1
node scripts/smoke-hotfix26-b.js    → PASS=30 FAIL=0 MANUAL REQUIRED=4
node scripts/smoke-hotfix26-c.js    → PASS=24 FAIL=0 MANUAL REQUIRED=2
node scripts/smoke-hotfix26-d.js    → PASS=20 FAIL=0 MANUAL REQUIRED=3
```

另外確認：

- 所有觸及 JS `node --check` 通過。
- `line-order.html`／`line-shipping.html` inline `<script>` 抽取後 `node --check` 通過（`index.html` 無 inline script，`app.js` 以外部檔案載入）。
- HTML id／JS `getElementById` selector 交叉檢查通過（會員列表／詳情／診斷中心）。
- `initDb()` 連續呼叫兩次無錯誤；`node server.js` 連續啟動兩次無錯誤（migration idempotent）。
- `grep` 確認：`liff.init(` 在 `line-member-gate.js` 內只出現一次；`friend_flag`／`is_friend`／`last_friend_check_at` 三個關鍵字都存在對應實作；CRM 新事件三個名稱都在 `utils/lineMemberStats.js` 內；`diagnostic_only` 分支內沒有任何 `db.run`／`upsertMemberProfile`／`writeHistory` 呼叫；`routes`／`utils`／`middleware`／`public` 底下的 runtime 程式碼不含舊網域 `pop-system-v13.zeabur.app`（只有 smoke test 的測試環境變數與診斷中心自己的偵測常數會用到這個字串，兩者都不算「仍在使用舊網域」）；`GET /api/settings` 回應不含 `channel_secret`／`access_token`／`id_token` 等欄位名稱。

## MANUAL REQUIRED（無法在此環境自動化，需要真實 LINE App／瀏覽器）

- 真實 LIFF `liff.getFriendship()` / `liff.requestFriendship()` 在真實 LINE App 內的實際行為與回傳值。
- 真實加入官方帳號後按「重新確認」的完整視覺流程。
- `line-order.html`／`line-shipping.html` checkout 面板重新打開的視覺效果（程式碼靜態檢視已確認呼叫條件正確，Hotfix25 既有邏輯未被本次改動）。
- 會員列表／詳情 Modal、診斷中心在真實瀏覽器（桌面／平板／手機）的視覺呈現（RWD、對比度、捲動）。
- 複製按鈕在不支援 `navigator.clipboard` 的舊瀏覽器上的 `execCommand` fallback 實際效果。
- LINE Developers 後台 Callback URL／Endpoint 的實際比對（無公開 API 可讀取，只能人工登入比對）。

## LINE Developers 人工設定提醒

本次 Hotfix26 **不需要**修改 LINE Developers 上的任何既有設定；診斷中心只是「唸出」目前系統認為正確的建議值供人工比對：

- Callback URL 建議值：`https://{目前網域}`（LIFF/LINE Login 現行架構用 `liff.login({redirectUri})` 導回目前頁面，不是固定寫死的路徑）。
- 點餐 Endpoint 建議值：`https://{目前網域}/line-order.html?store_id={store_id}`
- 宅配 Endpoint 建議值：`https://{目前網域}/line-shipping.html?store_id={store_id}`

若店家先前是用舊網域（`pop-system-v13.zeabur.app`）設定 LINE Developers，請比對後手動更新為目前網域；系統本身的 runtime 程式碼已確認不含這個舊網域。

## Zeabur 環境變數

不需要新增環境變數。`PUBLIC_BASE_URL`／`APP_BASE_URL`（Hotfix25 既有）持續用於伺服器端 fallback 網址產生，本次沒有新增依賴。

## 升級方式

```bash
# 1. 備份現有 data/ 目錄（含 pos.db）
cp -r data data.bak.$(date +%Y%m%d)

# 2. 覆蓋程式碼（保留 data/ 目錄不覆蓋）
# 3. 安裝依賴
npm install

# 4. 啟動（migration 會自動執行，可重複執行不影響既有資料）
npm start
# 或
node server.js
```

不需要手動跑額外的 migration script；`is_friend`／`last_friend_check` 等欄位已在 Hotfix23-E 建立，本次沒有新增欄位。

## 回滾方式

若需回滾到 Hotfix25：

```bash
# 還原程式碼到 Hotfix25 版本（pos-web-fix18-10-hotfix25-line-member-shared-login-full.zip）
# data/pos.db 不需要還原——Hotfix26 沒有新增/修改任何資料表結構，
# 新寫入的 CRM Timeline 事件（friend_status_checked/joined_official_account/
# unfollowed_official_account）只是 line_member_history 裡多出來的資料列，
# 回滾後的舊版程式碼會直接忽略、不會報錯。
npm install
node server.js
```
