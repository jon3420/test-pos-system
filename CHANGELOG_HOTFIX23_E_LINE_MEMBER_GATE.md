# fix18-10-hotfix23-E｜LINE Member Gate × LIFF Login × Friend Status × LINE CRM Foundation × Customer Journey

基礎版本：`fix18-10-hotfix23-D`（Ads Attribution Foundation）
本版不重寫既有點餐系統，所有異動皆為新增資料表 / 新增欄位 / 新增路由 / 附加運算，
既有欄位、既有 API 回傳格式一律不變。

---

## 1. Audit 結果

- 訂單資料表統一為單一 `orders` 表（外帶/外送/宅配皆寫入同一張表，以
  `order_mode` / `source` 欄位區分），因此需求文件所稱「line_orders /
  shipping_orders」實際對應同一張表，本版以 `orders.line_user_id` 單一欄位
  滿足三種通路的會員綁定需求。
- 既有 `routes/settings.js` 的 `GET/PUT /api/settings` 已有完整的 key 白名單
  + LINE 授權（`line_order` feature）檢查機制，沿用不新增第二套設定 API。
- 既有 `utils/analyticsLog.js` / `routes/analytics.js`（Hotfix23-A）已有
  事件白名單、server-only 事件、rate limit、metadata 大小限制等機制，本版
  直接擴充，不重寫。
- 既有 `utils/dashboardAnalytics.js`（Hotfix23-B/C/D）已有
  `ORDERS_PAID_EXPR` / `ORDERS_BASE_WHERE` 兩個「已付款訂單」判斷式，本版
  會員營收/非會員營收直接沿用同一組判斷式，確保兩者相加等於 KPI 總營收。
- 既有 `submit_order` / `purchase` 事件寫入時機（非 LINE Pay 訂單建立時立即
  視為成交；LINE Pay 訂單改在 `/api/linepay/confirm` 成功時才視為成交）已是
  專案既定規則，本版會員 `total_spent` / `lifetime_value` 累加時機直接比照
  這個既有規則，不另創一套「已付款」判斷。

---

## 2. 修改檔案

### 新增檔案
- `utils/lineMemberAuth.js` — LINE ID Token 驗證 / 好友狀態查詢（呼叫 LINE 官方 API）
- `utils/lineMemberStats.js` — line_members 及其周邊表的共用讀寫（好友狀態轉換、
  history、first_cart、first/repeat purchase、lifecycle stage、CSV 遮罩）
- `utils/lineMemberSession.js` — HMAC 簽章的短效 member_session 簽發/驗證
- `routes/line-member.js` — `POST /verify`、`GET /members`、`GET /members/export`、
  `GET /members/:id`
- `public/js/line-member-gate.js` — 前台共用 Gate 模組（LIFF 初始化、Gate UI、
  checkout/entry 兩種流程）

### 修改檔案
- `utils/db.js` — `orders.line_user_id` 欄位；`line_members`
  （含 CRM 擴充欄位）、`line_member_history`、`line_member_sessions`、
  `line_member_order_links`、`line_member_tags` 五張新表與索引
- `utils/analyticsLog.js` — 事件白名單新增 LINE 會員入口 / CRM 事件
- `routes/analytics.js` — `SERVER_ONLY_EVENTS` 擴充；`add_to_cart` 事件的
  first_cart CRM hook；`GET /dashboard` 新增 `line_member_funnel` /
  `line_crm_kpi` / `line_crm_health`
- `utils/dashboardAnalytics.js` — 新增 `getLineMemberFunnel` /
  `getLineCrmKpi` / `getLineCrmHealth`，並 export `ORDERS_PAID_EXPR` /
  `ORDERS_BASE_WHERE` 供重用
- `routes/settings.js` — `LINE_MEMBER_KEYS` 白名單 + 設定驗證
- `routes/line-orders.js` — `member_session` 驗證、`orders.line_user_id` 寫入、
  `touchMemberOnOrder` / `recordMemberPurchase` 呼叫、`/shop` 新增 LINE 會員
  入口設定 key
- `routes/line-shipping.js` — 同上（`getShippingSettings` 也新增同一組 key）
- `routes/linepay.js` — `/confirm` 成功時呼叫 `recordMemberPurchase`
- `server.js` — 註冊 `app.use('/api/line-member', requireStore,
  requireFeature('line_order'), require('./routes/line-member'))`
- `public/line-order.html` / `public/line-shipping.html` — 載入
  `line-member-gate.js`、Gate 初始化、checkout 送單前驗證、`member_session`
  帶入訂單/事件
- `public/index.html` — 新增「👤 LINE 會員入口」「👥 LINE 會員」兩個設定分頁
- `public/js/app.js` — 對應的 load/save/list/export/detail/Dashboard render 函式

---

## 3. Settings Key

新增於 `LINE_MEMBER_KEYS`（沿用既有 `GET/PUT /api/settings`，未新增第二套 API）：

```
line_member_gate_enabled        line_member_gate_mode (disabled|checkout|entry)
line_member_require_friend      line_member_allow_skip
line_member_add_friend_url      line_member_basic_id
line_member_login_channel_id    line_member_liff_id
line_member_return_url          line_member_title
line_member_description         line_member_friend_button_text
line_member_login_button_text   line_member_skip_button_text
```

驗證規則（`routes/settings.js`）：
- 啟用時 `line_member_liff_id` / `line_member_login_channel_id` 不可空白
- `line_member_add_friend_url` 必須是 `https://lin.ee/` 或 `https://line.me/` 開頭
- `line_member_basic_id` 基本格式驗證（英數字/`_`/`-`，可帶 `@` 前綴）
- `line_member_return_url` 必須是 HTTPS
- `line_member_gate_mode` 僅接受 `disabled/checkout/entry`
- 各文字欄位長度上限 200 字
- 未啟用時允許欄位保留舊值，不強制清空
- Channel Secret **不存在**於此白名單 —— 本版沒有前端可設定 Channel Secret 的欄位，
  好友狀態查詢改用 LINE Login 取得的 `access_token`（見第 6 節），不需要 Messaging
  API 的 Channel Access Token / Secret，從架構上避免 Secret 出現在前端或設定表單。

---

## 4. Member Session 安全機制

`utils/lineMemberSession.js`：

- `createMemberSession({store_id, line_user_id, ttl_ms})` 產生
  `base64url(payload).base64url(HMAC-SHA256(payload))`，payload 只有
  `{store_id, line_user_id, issued_at, expires_at}`。
- `verifyMemberSession(token, expectedStoreId)`：
  1. 簽章比對用 `crypto.timingSafeEqual`（避免 timing attack）
  2. 過期（`expires_at`）一律拒絕
  3. `payload.store_id` 必須等於呼叫端目前的 `storeId`（防止 store_001 的
     session 被拿去 store_002 使用）
  4. 任何格式錯誤/例外一律回傳 `null`，不拋出例外
- Secret 沿用 `middleware/storeGuard.js` 既有的 `process.env.JWT_SECRET`，
  不新增第二套 Secret 管理機制。
- 有效期預設 24 小時。
- 前端（`line-order.html` / `line-shipping.html` / `line-member-gate.js`）
  只儲存 `member_session` 字串本身、遮罩後的 profile、`is_friend`、
  `expires_at`；**不儲存** Access Token / ID Token / 完整 `line_user_id`。
- 訂單建立（`routes/line-orders.js` / `routes/line-shipping.js`）與
  `add_to_cart` 首購物車事件（`routes/analytics.js`）一律只接受
  `member_session`，前端直接傳入 `line_user_id` 一律被忽略（程式碼裡已移除
  對該欄位的信任，只解析 `member_session`）。

已實測（見第 19 節）：合法 token 通過／簽章竄改拒絕／過期拒絕／跨店拒絕／
格式錯誤拒絕。

---

## 5. LIFF / LINE Login 流程

1. `initLineMemberGate({store_id, liff_id})` 動態載入 LIFF SDK 並
   `liff.init()`；`liff_id` 空白或初始化失敗時安全降級（`isLiffAvailable()`
   回傳 `false`），不阻擋既有點餐流程。
2. `loginWithLine()` 呼叫 `liff.login({redirectUri})`，`redirectUri` 由
   `buildReturnUrl()` 組出（含 `store_id`），瀏覽器跳轉至 LINE 官方登入頁。
3. 登入完成導回後，`verifyWithBackend()` 取得 `liff.getIDToken()` /
   `liff.getAccessToken()`，POST 到 `POST /api/line-member/verify`。
4. 後端（`routes/line-member.js`）：
   - `utils/lineMemberAuth.verifyLineIdToken()` 呼叫 LINE 官方
     `POST https://api.line.me/oauth2/v2.1/verify`，驗證
     `aud === 店家的 line_member_login_channel_id`、`exp` 未過期、取得
     `sub`（= 可信的 `line_user_id`）。**不信任前端傳入的任何 line_user_id**。
   - 若 `access_token` 存在，呼叫
     `utils/lineMemberAuth.getFriendshipStatus()`（LINE 好友關係 API）取得
     `is_friend`；查詢失敗安全 fallback 為 `null`，不阻擋流程。
   - `upsertMemberProfile()` 寫入/更新 `line_members`，並依好友狀態轉換規則
     （見第 7 節）決定要不要寫 `friend_added/removed/restored` history 與
     analytics 事件。
   - `linkMemberSession()` 把 `visitor_id/session_id/cart_id` 與
     `line_user_id` 串起來（`line_member_sessions`）。
   - `updateTouchAttribution()` 寫入 first_touch（只在為空時寫入，永久保留）
     / last_touch（direct 不覆蓋既有有效廣告來源）。
   - 回傳 `member_session`（簽章 token）與遮罩後的 profile，**不回傳原始
     line_user_id**。
5. 任何一步失敗（Token 驗證失敗、LINE API 逾時/錯誤、Channel 未設定）一律
   回 HTTP 200 + `{success:false, reason, message}`，不回 500，不中斷點餐。

---

## 6. Gate 三種模式

| 模式 | 行為 |
|---|---|
| `disabled` | 完全不初始化 Gate，既有流程零異動 |
| `checkout` | 可瀏覽/加購，`submitOrder()` 真正呼叫下單 API **之前**呼叫
  `LineMemberGate.requireMemberBeforeCheckout()`；若 `require_friend=true`
  則需 `is_friend===true` 才放行；未通過不送單、不清空購物車 |
| `entry` | `initLineMemberGate` 完成後立即呼叫
  `requireMemberOnEntry()`，顯示全螢幕 Gate；`allow_skip=false` 不顯示略過
  按鈕（無法關閉）；`allow_skip=true` 顯示略過按鈕，略過後仍可瀏覽/下單 |

Gate UI（`showMemberGate()`）為動態注入的 DOM（不寫死在 `line-order.html` /
`line-shipping.html` 的靜態 HTML 裡），因此不增加既有頁面的 DOM id 數量，
不影響既有版面。

購物車保留：LINE Login 是同源網址跳轉（`liff.login({redirectUri})`
導向 LINE 網域再導回本店網址），瀏覽器 `localStorage` 本來就會跨這次導轉
持續存在，因此 Hotfix22-F 的購物車永久保留機制（`ORDER_CART_KEY` /
`SHIP_CART_KEY`）**不需要額外處理就能保留**；本版額外驗證的是
`cart_id`/`visitor_id`/`session_id` 也維持不變（`_getCartId(false)`
不會在登入流程中被重置），避免回來後被視為新的一次瀏覽。

---

## 7. 好友狀態 Lifecycle

規則式狀態機（`utils/lineMemberStats.upsertMemberProfile`）：

| 轉換 | 事件 | is_friend | is_blocked | friend_since |
|---|---|---|---|---|
| null/false → true（第一次） | `friend_added` | 1 | 0 | 設定為現在 |
| true → true（重查） | 無 | 1 | 不變 | 不變 |
| true → false | `friend_removed` | 0 | 1 | 不變 |
| false → true（曾經是好友） | `friend_restored` | 1 | 0 | **保留原始值，不覆蓋** |

- `is_friend` 這次查詢結果為 `null`（查不到）時：**不覆蓋既有狀態**，只更新
  `last_friend_check`；不假裝已加好友、也不誤判成移除好友。
- 同狀態重查（true→true、false→false）**不寫 history、不寫 analytics
  事件**（已用單元測試驗證，見第 19 節）。
- `friend_added` / `friend_removed` / `friend_restored` **只能由後端**在
  `POST /api/line-member/verify` 內、依 LINE 官方好友關係 API 的查詢結果寫入，
  前端無法透過任何 API 直接偽造（`analyticsLog.js` 的
  `SERVER_ONLY_EVENTS` 已擋下這三個事件名稱的前台直接寫入）。

---

## 8. `line_members` Schema

```sql
CREATE TABLE line_members (
  id, store_id, line_user_id, display_name, picture_url, is_friend,
  first_seen_at, last_seen_at, first_order_at, last_order_at,
  order_count, total_spent, created_at, updated_at,
  -- CRM 擴充欄位（ALTER TABLE，safe migration）
  is_blocked, friend_since, last_friend_check, last_login_at,
  first_touch_source, first_touch_campaign, last_touch_source, last_touch_campaign,
  first_product_id, first_cart_at, first_purchase_at, last_purchase_at,
  lifetime_value
)
UNIQUE(store_id, line_user_id)
INDEX (store_id, last_seen_at) / (store_id, last_order_at) / (store_id, is_friend)
```

## 9. `line_member_history` Schema

```sql
CREATE TABLE line_member_history (
  id, store_id, line_user_id, event_name, old_value, new_value,
  metadata_json, created_at
)
INDEX (store_id) / (store_id, line_user_id) / (store_id, event_name) / (store_id, created_at)
```
事件：`login / friend_added / friend_removed / friend_restored /
profile_updated / first_cart / first_purchase / repeat_purchase`。

## 10. `line_member_sessions` Schema

```sql
CREATE TABLE line_member_sessions (
  id, store_id, line_user_id, visitor_id, session_id, cart_id,
  first_seen_at, last_seen_at, created_at, updated_at
)
UNIQUE(store_id, line_user_id, visitor_id)
```
用途：把登入前的匿名 Analytics 識別（`visitor_id`/`session_id`/`cart_id`）
與登入後的 `line_user_id` 串接，作為 Customer Journey 的基礎資料。

## 11. `line_member_order_links` Schema

```sql
CREATE TABLE line_member_order_links (
  id, store_id, line_user_id, order_id, created_at
)
UNIQUE(store_id, order_id)
```
唯一索引是「同一張訂單只能被記為一次成交」的最後一道保險：
`recordMemberPurchase()` 先嘗試 `INSERT`，失敗（唯一鍵衝突）就直接回傳
`false` 並略過所有累加，天生防止重複 Confirm / webhook 重放造成的重複計算。

## 12. `line_member_tags` Schema（本版僅預留）

```sql
CREATE TABLE line_member_tags (
  id, store_id, line_user_id, tag_code, tag_name, created_at
)
UNIQUE(store_id, line_user_id, tag_code)
```
本版**不**實作自動標籤、批次標籤、推播、AI 分群，只建立 schema 供未來版本使用。

---

## 13. Customer Journey

`utils/dashboardAnalytics.getLineMemberFunnel()` 串接：

```
進站(page_view, distinct visitor_id)
→ 看到 LINE Gate(line_gate_view, distinct visitor_id)
→ LINE Login(line_member_history.login, distinct line_user_id)
→ 加入好友(friend_added/friend_restored, distinct line_user_id)
→ 加入購物車(add_to_cart, distinct visitor_id)
→ 送出訂單(submit_order, distinct order_id)
→ 完成付款(purchase, distinct order_id)
→ 首次購買(first_purchase history, distinct line_user_id)
→ 回購(repeat_purchase history, distinct line_user_id)
```
每一階都用 `COUNT(DISTINCT ...)`，不使用事件總次數；每階同時回傳
`step_conversion_rate`（相對上一階）與 `overall_conversion_rate`（相對第一階）。
同時回傳 `member_revenue` / `non_member_revenue` / `first_purchase_revenue` /
`repeat_purchase_revenue`，其中會員/非會員營收與 KPI 使用同一個
`ORDERS_PAID_EXPR`，兩者相加等於總營收。

---

## 14. First Cart

`utils/lineMemberStats.recordFirstCart()`：由 `POST /api/analytics/events`
在 `event_name==='add_to_cart'` 且帶有效 `member_session` 時呼叫。只在
`first_cart_at` 尚為空時才寫入（只寫第一次），商品下架仍保留
`first_product_id`（不因商品之後下架而清空）。

**已知限制**：本版判斷「第一次加入購物車」的時機點是「該會員第一次呼叫
`add_to_cart` 事件」，而不是嚴格區分「使用者手動加入」與「`restoreCart()`
還原購物車時觸發」。既有前端邏輯（Hotfix23-A 起）`restoreCart()`
本身**不會**觸發 `add_to_cart` 事件（只有使用者實際點擊加入購物車按鈕的
`_trackAddToCart()` 會觸發），因此第一次購物車事件必然對應真實使用者操作，
但這個保證來自既有 `_trackAddToCart` 呼叫點設計，本版未新增額外防護。

---

## 15. First Purchase / Repeat Purchase / LTV 更新規則

`utils/lineMemberStats.recordMemberPurchase(db, storeId, lineUserId, orderId, amount)`：

1. 先 `INSERT INTO line_member_order_links (store_id, line_user_id, order_id)`；
   若違反 `UNIQUE(store_id, order_id)` 則直接回傳 `false`（已處理過，不重複）。
2. 成功後才累加 `order_count += 1`、`total_spent += amount`、
   `lifetime_value += amount`。
3. `first_purchase_at` 為空 → 寫入現在時間、事件為 `first_purchase`；
   否則只更新 `last_purchase_at`、事件為 `repeat_purchase`。
4. `amount` 一律由呼叫端傳入「後端已確認的訂單金額」
   （`orders.total` / `order.total`），不接受前端傳入的金額。

呼叫時機：
- **非 LINE Pay 訂單**：`routes/line-orders.js` / `routes/line-shipping.js`
  在 `logServerEvent(..., 'purchase')` 回傳 `true`（代表真的新寫入、非重複）
  時才呼叫 `recordMemberPurchase`，訂單建立當下即視為成交。
- **LINE Pay 訂單**：建單當下**只**呼叫 `touchMemberOnOrder`（更新
  `order_count`/`first_order_at`/`last_order_at`，不動 `total_spent`），
  `total_spent`/`lifetime_value` 改在 `routes/linepay.js` 的
  `/api/linepay/confirm` 真正付款成功時才呼叫 `recordMemberPurchase`。
- 取消、void、付款失敗：這些路徑本來就不會呼叫 `recordMemberPurchase`，
  天然不會累加。

`touchMemberOnOrder(db, storeId, lineUserId)`：無論付款方式，訂單成功建立
就更新 `order_count`... **修正說明**：實作上 `order_count` 的累加點統一由
`recordMemberPurchase` 負責（避免同一張訂單被 `touchMemberOnOrder` 和
`recordMemberPurchase` 各加一次而重複），`touchMemberOnOrder` 只更新
`first_order_at` / `last_order_at`（訂單建立時間軸），不動
`order_count`/`total_spent`。這點與需求文件字面「touchMemberOnOrder 更新
order_count」略有差異，是刻意的設計決策，目的是避免 LINE Pay 訂單在
建單與 Confirm 兩個時間點各被計一次 `order_count`；已在單元測試中驗證
`order_count` 不會重複累加（見第 19 節）。

---

## 16. Dashboard 統計口徑

`GET /api/analytics/dashboard` 新增三個欄位（皆為附加運算，失敗時安全
fallback 為 `insufficient_data:true`，不影響既有欄位、不讓整支 API 500）：

- `line_member_funnel`：見第 13 節
- `line_crm_kpi`：會員總數/好友數/封鎖數/解除封鎖數/登入會員/首購會員/
  回購會員/會員營收/平均會員客單/平均回購天數/平均 LTV。資料不足時
  `insufficient_data:true`，`avg_repeat_days`/`avg_ltv` 等數值可能為 `null`
  而非硬湊 0。
- `line_crm_health`：純規則式（**未呼叫任何 AI API**），權重
  好友率25/封鎖率20/登入率15/首購率20/回購率20，回傳 0~100 分與 1~5 星，
  並依規則式產生最多 4 條建議文字（封鎖率高/登入高首購低/首購高回購低/
  好友高登入低）。

前端 `public/js/app.js` 新增
`renderDashboardLineMemberFunnel` / `renderDashboardLineCrmKpi` /
`renderDashboardLineCrmHealth` 三個渲染函式，插入既有 `renderDashboardV2()`
組裝流程中（廣告來源分析區塊之後），不影響既有區塊順序與內容。

---

## 17. Store Isolation

- 所有新表（`line_members` / `line_member_history` / `line_member_sessions`
  / `line_member_order_links` / `line_member_tags`）皆以 `store_id` 為
  第一個查詢條件，唯一索引也都以 `(store_id, ...)` 開頭。
- `member_session` 內含簽發時的 `store_id`，`verifyMemberSession()`
  強制比對「token 內的 store_id」與「這次請求解析出的 store_id」相符，
  不符一律回傳 `null`（已實測：store_001 簽發的 token 在 `expectedStoreId
  ='store_002'` 時驗證失敗）。
- `POST /api/line-member/verify` 的 `channelId` 讀取自
  `settings WHERE store_id=?`，不同店家的 LINE Login Channel 彼此獨立，
  A 店的 ID Token 驗證時 `aud` 必須等於 A 店自己設定的 Channel ID，
  不會被拿去驗證 B 店的 Channel。
- `GET /api/line-member/members*` 皆以 `req.storeId` 過濾，不會跨店查詢。

---

## 18. 安全設計

1. Access Token / ID Token / Channel Secret **不寫入任何 `console.log`**
   （已於第 3 節逐檔確認）。
2. localStorage 只存 `member_session` + 遮罩 profile + `is_friend` +
   `expires_at`，不存 Token / 完整 line_user_id。
3. analytics `metadata` 白名單組裝（`buildTrackingMetadata`），不會意外
   夾帶 Token。
4. `line_member_return_url` 驗證必須 HTTPS（`routes/settings.js`），降低
   open redirect 風險；實際跳轉仍由 LIFF SDK 自己的 `redirectUri`
   機制處理，本版未額外實作白名單網域比對（見「已知限制」）。
5. `line_user_id` 只信任 `member_session` 簽章驗證結果，前端直接傳
   `line_user_id` 一律被忽略。
6. `POST /api/line-member/verify` 有簡易 in-memory rate limit
   （每 IP+store 每 60 秒 20 次）。
7. `store_id` 隔離見第 17 節。
8. LINE User ID 對外一律遮罩（`maskLineUserId()`：`U1234****cdef`），
   會員列表、詳情頁、CSV 匯出皆使用遮罩值；內部參照改用 `line_members.id`
   （自增整數）而非真實 LINE User ID。
9. CSV 匯出：每個欄位值都包在雙引號並跳脫內部雙引號
   （`"${v.replace(/"/g,'""')}"`），可降低 Excel/Sheets 公式注入的基本風險；
   **已知限制**：未額外偵測欄位開頭為 `=`/`+`/`-`/`@` 時加上防注入前綴，
   若顯示名稱剛好以這些符號開頭仍有極低的公式注入風險，建議下一版加強。

---

## 19. E2E / 驗證結果

沙盒環境**沒有**對外網路存取權限（只允許 npm/pypi/github 等套件登錄網域），
因此無法對 LINE 官方 API（`api.line.me`）發出真實請求，也無法啟動真正的
LIFF SDK（需要瀏覽器 + 真實 LINE 帳號）。以下區分「已用自動化方式實際驗證」
與「僅靜態程式碼審查、未實測」：

### 已實測（在沙盒內以獨立 Node 進程對 sql.js 資料庫執行）

- ✅ Migration 重複執行兩次不報錯，schema 正確建立（5 張新表 + `orders.line_user_id`）
- ✅ 好友狀態 lifecycle：null→false（不觸發事件）→true（`friend_added`）→
  true 重查（不重複事件）→false（`friend_removed`,`is_blocked=1`）→
  true（`friend_restored`,`is_blocked=0`，且 `friend_since` 保留原始值）
- ✅ 首購/回購/LTV：第一筆訂單 `first_purchase` + `order_count=1`；
  同一 `order_id` 重複呼叫 `recordMemberPurchase` 回傳 `false`（不重複累加）；
  第二筆訂單 `repeat_purchase` + `order_count=2` + `total_spent`/`lifetime_value`
  正確加總（150+200=350）
- ✅ `computeLifecycleStage()` 正確回傳 `repeat_buyer`
- ✅ Member Session：合法 token 驗證通過／簽章竄改拒絕／過期拒絕／
  跨店（store_001 token 用於 store_002）拒絕／格式錯誤拒絕
- ✅ `GET /api/settings`、`PUT /api/settings`（含「啟用時 LIFF ID 不可空白」
  驗證擋下）
- ✅ `POST /api/line-member/verify` 缺少 `id_token` 回傳結構化 400，不 500
- ✅ `GET /api/line-member/members` 空列表正確回傳 `{success:true,data:[]}`
- ✅ `GET /api/analytics/dashboard` 回傳 `line_member_funnel` /
  `line_crm_kpi` / `line_crm_health` 三個新欄位，資料不足時正確顯示
  `insufficient_data` 而非 NaN
- ✅ 使用 `createMemberSession()` 產生的合法 token 建立外帶訂單（`cash`
  付款），`POST /api/line-orders` 成功回傳訂單（`member_session` 驗證通過、
  `orders.line_user_id` 寫入路徑已執行，見程式碼 `knownLineUserId`）
- ✅ 全部 `node --check`（`server.js` / `routes/*.js` / `utils/*.js` /
  `public/js/*.js`）與 `line-order.html` / `line-shipping.html` 抽取
  inline JS 皆語法通過
- ✅ `index.html` / `line-order.html` / `line-shipping.html` 無重複 DOM id，
  `<div>` 開合數量一致

### 僅程式碼審查、未在沙盒內以真實 LINE 帳號實測（環境限制）

- ⚠️ 真實 LIFF SDK 初始化、真實 LINE Login 跳轉、真實好友關係 API 查詢
  （需要瀏覽器 + 真實 LINE 帳號 + 對外網路，沙盒皆不具備）
- ⚠️ 真實 LINE Pay Confirm 回調（`routes/linepay.js` 的
  `recordMemberPurchase` 呼叫點已加入且程式碼審查通過，但未透過真實
  LINE Pay 沙盒帳號觸發過 `/confirm`）
- ⚠️ Entry/Checkout Gate 的實際瀏覽器互動（Gate 顯示、`allow_skip` 按鈕、
  LIFF 初始化失敗的友善提示畫面）僅靜態審查 `line-member-gate.js` 邏輯，
  未跑無頭瀏覽器測試
- ⚠️ 外送/冷藏宅配訂單的 `member_session` 綁定僅程式碼審查（與外帶走同一段
  邏輯，`line-shipping.js` 已加入相同的 `verifyMemberSession` 呼叫），
  未個別跑過 E2E
- ⚠️ store_001 / store_002 雙店隔離僅以 `verifyMemberSession` 的單元測試
  驗證（已證明 token 跨店驗證會被拒絕），未跑兩個真實店家的完整下單流程

---

## 20. 已知限制

1. 後台會員管理 API（`GET /api/line-member/members*`）沿用專案既有
   `requireStore` 慣例（JWT優先、`x-store-id` header、`query.store_id`
   三種解析方式皆可通過），與 `routes/dashboard.js`、`routes/analytics.js`
   等既有「管理端」API 的授權方式一致，**不是**本版新引入的弱點，但也代表
   若只靠 `?store_id=xxx` 查詢字串就能呼叫，理論上任何知道 store_id 的人
   都能查詢該店的（遮罩過的）會員列表。這是整個專案既有的架構慣例，非本版
   刻意放寬，但建議之後統一收斂成「管理端 API 一律要求 JWT，不接受
   query.store_id」。
2. `first_cart` 的判斷依賴既有 `_trackAddToCart()` 只在使用者實際點擊時
   觸發（見第 14 節），沒有额外的伺服器端防護區分「使用者操作」與「程式
   還原購物車」。
3. Return URL 白名單目前只驗證「必須是 HTTPS」，未驗證網域必須等於本店
   網域，理論上可設定成任何 HTTPS 網址（LIFF SDK 本身的 `redirectUri`
   機制通常已足夠安全，但這是額外可以加強的一層）。
4. CSV 匯出的公式注入防護只有雙引號跳脫，未加上 `=`/`+`/`-`/`@`
   開頭欄位的防注入前綴。
5. `line_member_tags` 只有 schema，沒有任何操作 UI / API（依需求文件刻意
   保留給下一版）。
6. LINE 官方好友關係 API 呼叫使用 LINE Login 的 `access_token`
   （scope 需含相關授權），而非 Messaging API 的 Channel Access Token；
   若店家的 LINE Login Channel 未串接好友關係查詢權限，`getFriendshipStatus`
   會安全 fallback 為 `is_friend:null`，前台顯示「無法確認好友狀態」。
7. `avg_repeat_days`（平均回購天數）目前以 SQLite `julianday()` 計算
   `first_purchase_at` 到 `last_purchase_at` 的天數，只對「回購會員」
   （`order_count>1`）計算，且是「首購到最後一次購買」的天數而非
   「相鄰兩次購買間隔的平均」，兩者在會員回購超過 2 次時定義不同，
   之後若要更精確可能需要另建一張逐筆訂單時間序的輔助表。

## 21. 未實作項目

- LINE 推播 / 自動催單 / 群發 / 標籤分群 / 優惠券自動派發（依需求文件
  刻意保留給下一版）
- Meta Conversion API / 廣告花費 / ROAS 串接（沿用 Hotfix23-D 既有限制）
- 會員標籤（`line_member_tags`）操作介面
- 無頭瀏覽器 / 真實 LINE 帳號的端對端測試（環境限制，見第 19 節）

## 22. 回退方式

- 本版所有資料庫異動皆為 `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ADD
  COLUMN`（包在 try/catch），沒有任何 `DROP` 或破壞性遷移，回退時只需
  還原程式碼版本（`utils/db.js` 等檔案），新增的資料表/欄位保留在資料庫
  中不會造成任何錯誤或資料遺失。
- 若要停用 LINE 會員入口功能但保留程式碼：後台設定頁將
  `line_member_gate_enabled` 設回 `0`（或 `line_member_gate_mode` 設為
  `disabled`）即可，既有點餐流程完全不受影響（`disabled` 模式下
  `_initLineMemberGateFromShopData()` 直接 return，不初始化 LIFF）。
- 若要完全回退程式碼：還原本次修改的檔案清單（見第 2 節）至
  Hotfix23-D 版本即可，新增的 `routes/line-member.js` /
  `utils/lineMember*.js` / `public/js/line-member-gate.js` 未被其他既有
  功能依賴，直接刪除也不影響 POS / Android / LINE 外帶外送 / 冷藏宅配 /
  LINE Pay / 優惠券 / Business Calendar / Meta Pixel / GA4 / Ads
  Attribution / Dashboard V3 等既有功能。
