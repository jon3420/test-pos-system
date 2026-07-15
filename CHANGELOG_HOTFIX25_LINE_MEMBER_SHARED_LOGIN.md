# fix18-10-hotfix25 — LINE 會員共用登入 × 登入後返回原入口

## 背景

外帶／外送（`/line-order.html`）與冷藏宅配（`/line-shipping.html`）在
hotfix23/24 已經共用同一組 LIFF ID／LINE Login Channel ID／LINE 官方帳號、
同一份 `line_members` 會員主檔（`UNIQUE(store_id, line_user_id)`），登入導回
機制也已經是「導回目前頁面」（`liff.login({redirectUri: 目前完整網址})`），
而不是寫死回 `line-order.html`。

本次 hotfix25 在既有架構上補強：

1. sessionStorage 備援返回機制 + 路徑白名單驗證（防止未來改動時退化成開放跳轉）
2. 回到頁面後**自動**完成登入驗證，不需要使用者再按一次登入按鈕
3. 登入中旗標 + 2 分鐘逾時，避免無限跳轉／卡死
4. 移除一次性／LINE OAuth callback 參數，避免重新整理後又觸發登入
5. checkout 模式下，登入完成自動重新打開結帳／購物車面板
6. 後台「登入成功返回網址」欄位改為唯讀說明，不再讓店家手動填入固定網址
7. 後端在啟用 Gate 且未送 return_url 時，自動補一份 fallback 值（純相容用途）

## 修改檔案

- `public/js/line-member-gate.js`（共用模組，主要邏輯所在）
  - 新增：`getCurrentStoreId`、`saveLineMemberReturnUrl`、
    `getSavedLineMemberReturnUrl`、`clearSavedLineMemberReturnUrl`、
    `validateSafeInternalReturnUrl`（路徑白名單版）、`startLineMemberLogin`
    （`loginWithLine` 別名）、`handleLineMemberLoginCallback`（自動恢復登入
    狀態的核心函式）、`getLineMemberSession`（`getMemberSession` 別名）、
    `renderLineMemberStatus`。
  - `initLineMemberGate()` 新增 `ids`/`onEvent` 參數，LIFF init 完成後自動呼叫
    `handleLineMemberLoginCallback()`，並把結果掛在回傳的 state 物件上
    （`state.loginCallbackResult`）。
  - `loginWithLine()` 呼叫前先 `markLoginInProgress()`。
  - 新增登入中旗標（`line_member_login_in_progress`，2 分鐘逾時）與一次性
    參數清除（`member_gate_test`／`line_login`／`login_required`／
    `login_callback`／`code`／`state`／`liff.state`）。
  - 所有 early return 路徑都會清除登入中旗標（LIFF init 失敗／使用者取消／
    後端驗證失敗／成功）。
- `public/line-order.html`：`initLineMemberGate()` 呼叫改帶 `_gateIds()`／
  `_trackEvent`；checkout 模式下，剛自動完成登入驗證時重新打開購物車面板
  （`openCartSheet()`），且僅在購物車非空時才打開。
- `public/line-shipping.html`：同上（宅配版，`openCartSheet()` 為宅配頁自己
  的既有函式，未跟點餐頁共用同一個 DOM/實例）。
- `public/index.html`：LINE 會員設定頁：
  - 分頁按鈕與標題改為「LINE 會員登入設定」
  - 移除「登入成功返回網址」可編輯欄位，改為唯讀說明區塊
    （`#lmgFallbackReturnUrlHint`）
  - 新增「LINE 會員資料由外帶、外送及冷藏宅配共用」說明文字
- `public/js/app.js`：`LINE_MEMBER_GATE_KEYS` 移除 `line_member_return_url`
  （不再從表單送出這個欄位）；`loadLineMemberGateSettings()` 改為填入唯讀
  fallback 網址提示，不再讀取/寫入編輯欄位。
- `routes/settings.js`：Gate 啟用且本次請求未送 `line_member_return_url`
  時，後端依 `PUBLIC_BASE_URL`/`APP_BASE_URL` 自動產生一份 fallback 值寫入
  （沿用既有 `validateLineMemberReturnUrl()`，通不過驗證就略過，不擋這次
  儲存）。純粹是相容用途——前端目前不會讀這個值來決定跳轉目的地。
- `package.json`：版本號 18.1.12 → 18.1.13。

## 新增檔案

- `scripts/smoke-hotfix25.js`：可重複執行的 smoke test（見下方「如何驗證」）。
- `CHANGELOG_HOTFIX25_LINE_MEMBER_SHARED_LOGIN.md`（本檔案）。

## 未變更（沿用既有、已符合需求的機制，未重做）

- `line_members` 主檔與 `UNIQUE(store_id, line_user_id)` 唯一索引
  （`utils/db.js`）——同店同一 LINE 使用者只會對應一筆會員資料，點餐／外送／
  宅配訂單都是查同一份主檔，沒有另外的 `shipping_members` 表。
- `routes/line-orders.js`、`routes/line-shipping.js` 寫入訂單時的
  `line_user_id` 皆來自後端驗證過的 `member_session`，不接受前端直接指定。
- `utils/returnUrlValidator.js`（後端 allowlist：HTTPS-only、hostname 完全比對、
  `*.` 子網域語法、不信任未設定 `TRUST_REQUEST_HOST` 時的 request host）。

## 如何驗證

```bash
npm install
node scripts/smoke-hotfix25.js
```

會依序執行：純函式單元測試（`validateSafeInternalReturnUrl`、
save/get/clear return url、逾時邏輯）→ 啟動兩次 server 驗證 migration
idempotency → shop-data / verify / settings API sanity。最後會列出
`[PASS]` / `[FAIL]` / `[MANUAL REQUIRED]` 清單；`[MANUAL REQUIRED]` 的項目
（真實 LIFF OAuth 往返、結帳面板重開的完整瀏覽器 DOM 行為）已在清單中說明
無法自動化的原因與替代的靜態驗證方式。
