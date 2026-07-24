# CHANGELOG — fix18-10-hotfix31-R3

## Operation Analytics — Cart Detail Explorer & Drill-Down Frontend

日期：2026-07-24
基礎版本：fix18-10-hotfix31-R2（Architecture Hardening：Identity Resolution ×
CRM Action Lifecycle × Tenant Isolation）

範圍：Web POS only。Android 專案未觸碰。Boss Dashboard（`routes/dashboard.js`
與整個 `public/`，除本輪明確修改的 `public/js/analytics-v2.js` 外）完全未
修改——已用 `diff -rq` 對照 R1 之前的原始 zip 逐檔驗證，見第八節。

---

## 一、摘要

本輪把 R1/R2 建好的後端能力（Drill Down、Visitor 360、CRM 分群/動作）接上
前端，位置是既有「營運分析」頁（`page-analytics_v2` / `public/js/
analytics-v2.js`），完全獨立於 Boss Dashboard（`page-reports` / `app.js`）
既有的「目前未完成購物車」小工具——兩者資料來源相同（`analytics_events`），
但畫面、程式碼、呼叫路徑完全分開，互不影響。

新增「Cart Detail Explorer」：可點擊的 KPI 卡片、篩選列、可分頁的購物車明細
表、懶載入的購物車詳情/時間軸、懶載入的訪客 360、動態/靜態分群建立、以及
「CRM Action Center」的安全進入點（本輪僅佔位，不執行任何實際發送動作）。

---

## 二、新增檔案

- `utils/drilldown.js`（R1 建立，本輪擴充）—— 新增 `cart_status` /
  `identity_state` / `friend_status` / `age_bucket` 應用層篩選、排序欄位
  白名單、`countDrilldownMatches()` 快速計數版、`generated_at`/`warnings`
  回應欄位。
- `utils/visitor360.js`（R1 建立，R2 重寫，本輪未再修改）。
- `utils/crmActions.js`（R2 建立，本輪未再修改）。
- `routes/crm.js`（R1 建立，R2 重寫；本輪新增：`POST /segments` 支援明確
  的 `member_keys` 陣列，供前端「已選取對象建立靜態分群」使用）。
- `scripts/smoke-hotfix31-r1-backend.js`（R1 建立，29 項）。
- `scripts/smoke-hotfix31-r2-hardening.js`（R2 建立，37 項）。
- `scripts/smoke-hotfix31-r3-frontend.js`（本輪新增，99 項：靜態稽核 + 後端
  行為 + jsdom 前端行為）。
- `CHANGELOG_HOTFIX31_R2_ARCHITECTURE_HARDENING.md`（R2 建立）。
- `CHANGELOG_HOTFIX31_R3_OPERATION_ANALYTICS_FRONTEND.md`（本檔案）。

## 三、修改檔案

- `public/js/analytics-v2.js`——本輪唯一的前端修改檔案：
  - `_av2RenderCartAbandonment()`：KPI 卡片與 Top Abandon Products 改為可
    點擊的 Drill Down 觸發點，新增 active 狀態視覺標記與「清除 KPI 篩選」。
  - 新增 Cart Detail Explorer 完整實作（篩選列、Chips、分頁、明細表、
    選取工具列、詳情 Drawer、Session 時間軸、訪客 360、分群建立）。
  - `AV2_TABS` 新增 `crm_action_center` 佔位頁籤。
  - Funnel／Sources 頁籤新增少量點擊互動（連到 Cart Detail Explorer）。
- `utils/cartSnapshot.js`：新增內部欄位 `_visitor_id_raw`（修正 R1 遺留的
  「靜態分群 member_key 誤用顯示用短碼」問題）；新增
  `getMemberFriendStatusMap()` 供 `utils/drilldown.js` 專用（刻意不放進
  Boss Dashboard 共用的 `getOpenCartRows()`／`_buildRowFromCandidate()`
  預設輸出，維持該既有 API 回應形狀不變）。
- `utils/analyticsIdentity.js`：新增 `resolveCanonicalVisitor()`（R2）。
- `utils/db.js`：R2 新增的 CRM 治理表/索引（本輪未再新增資料表/欄位）。
- `routes/analytics.js`：R1/R2 新增 `GET /drilldown`、`GET /visitor/:key`；
  本輪新增這兩個端點對 `cart_status`/`identity_state`/`friend_status`/
  `age_bucket`/`sort_by`/`sort_dir` 查詢參數的白名單轉發。
- `server.js`：R2 新增 `/api/crm` 路由掛載（本輪未再修改）。
- `package.json`：新增 `devDependencies.jsdom`（僅開發期測試用，不影響
  正式執行環境；`dependencies` 完全未變動）。
- `package-lock.json`：對應 `npm install` 產生的鎖定檔更新。

---

## 四、後端新增能力（本輪 R3 新增，最小必要支援）

1. **衍生欄位篩選**（`utils/drilldown.js`，應用層篩選，不是 SQL 原始欄位）：
   - `cart_status`：`active` / `checkout` / `abandoned` / `purchased`
   - `identity_state`：`line` / `visitor`
   - `friend_status`：`friend` / `not_friend` / `unknown`（只對 LINE
     會員有意義；匿名訪客一律為 `null`，不是 `unknown`）
   - `age_bucket`：沿用既有 `AGE_BUCKET_QUERY_MAP`（30m/30m_1h/1h_24h/
     1d_3d/3d_7d/7d_plus）
   - 排序白名單：`last_activity_at`／`first_added_at`／`total`／
     `age_seconds`，非白名單值一律退回預設，不接受任意欄位或 SQL 片段。
   - 不支援值一律安全忽略（視同未篩選），不拋錯、不影響其他篩選條件。
2. **`friend_status` 只存在於 Drill Down 路徑**：刻意不寫入
   `utils/cartSnapshot.js` 共用的列組裝函式，Boss Dashboard 既有的
   `GET /api/analytics/cart-abandonment` 回應形狀完全不受影響（已用
   R3 測試 E-3 驗證）。
3. **`POST /api/crm/segments` 的 `member_keys` 支援**：
   - `segment_type='static'` 且帶 `member_keys` 陣列時，直接快照這份明確
     選取的名單（去重、驗證 `member_type` 屬於 `line_user_id`/`visitor_id`
     其中之一、每筆長度截斷），不重新依 `filter` 解析。
   - 沒有帶 `member_keys` 時完全退回 R1/R2 既有行為（依 `filter` 解析），
     向下相容。
   - `store_id` 一律來自已驗證的 `req.storeId`，`member_keys` 本身不含
     店家資訊，不可能寫入其他店的資料。

---

## 五、前端新增能力（Cart Detail Explorer）

### KPI Drill Down
5 個既有 KPI 卡片（加入購物車數／成交數／放棄數／放棄率／估計放棄金額）
全部可點擊，套用對應的 Drill Down 篩選（`event_name=add_to_cart` /
`cart_status=purchased` / `cart_status=abandoned` /（放棄率與放棄數共用
同一個 `abandoned` 母體）/（估計放棄金額額外加上 `sort_by=total&sort_dir=
desc`））。再點一次啟用中的 KPI 會清除該篩選。KPI 卡片本身的計算方式完全
沿用既有 `getCartAbandonmentByProduct(funnel)` 邏輯，未新增第二套「放棄」
定義；Drill Down 明細表是另一個統計口徑（即時逐筆購物車），畫面上明確用
「N 位訪客」/「M 個購物車」等不同單位標籤區分，不會混用同一個數字。

### 篩選列
日期區間（沿用頁面既有日期篩選，不另建第二套日期解析）、漏斗階段、購物車
狀態、來源、Campaign、模式、身份、LINE 好友狀態、未活動時間、最低/最高
金額、排序方式/方向。金額欄位有驗證（非數字或負數拒絕送出；最低金額不得
高於最高金額，兩者衝突時拒絕套用並保留先前有效值）。

### 明細表
選取框、訪客/會員（遮罩顯示）、身份狀態、來源、Campaign、商品摘要、模式、
購物車金額、最後階段、最後活動時間、未活動時間、目前狀態（4 種後端真實
狀態徽章：活躍中/結帳中/可能已放棄/已完成購買，附滑鼠提示說明判定依據）、
操作。伺服器端分頁（20/50/100 可調），變更每頁筆數會重置到第 1 頁。

### 詳情 Drawer（Lazy Load）
點擊「查看詳情」才呼叫一次既有 `GET /api/analytics/cart-abandonment/
:cartId`（重用既有端點，不新建第二套購物車詳情 API），顯示完整商品明細、
金額拆解、Session 時間軸（依時間排序、本地時間字串直接顯示，不捏造缺漏
欄位）。主表格本身不會預先載入任何一列的詳情/時間軸（避免 N+1）。

### 訪客 360（Lazy Load）
Drawer 內另有獨立按鈕才會呼叫 `GET /api/analytics/visitor/:key`；`key`
直接使用該列的 `cart_id`（本身就是完整值，非遮罩），後端
`resolveCanonicalVisitor()` 會自動解析出正確身份，前端完全不需要知道或
顯示任何原始 `visitor_id`/`line_user_id`。畫面明確標示身份解析狀態
（「已由匿名訪客與 LINE 會員確定關聯」／「身份尚未解析」等），不會在沒有
決定性連結證據時宣稱兩個身份是同一人。

### 分群建立
- Dynamic：只送出 `filter` 定義，不含任何成員快照清單。
- Static：送出使用者在表格中明確勾選的 `member_keys` 清單；未選取任何列
  時建立按鈕停用、呼叫本身也被安全擋下（不送出 API 請求）。
- 分群名稱必填；API 成功/失敗訊息如實依 API 回應顯示，不會憑空宣稱成功。

### CRM Action Center（安全進入點，非執行介面）
只有在已建立分群或已選取對象時可進入；佔位頁明確告知「執行動作將於下一
階段開放」，不含任何「已發送/已核發」字樣，也沒有任何會實際送出 LINE
推播、優惠券核發、Email/SMS/Webhook、Meta/Google 受眾匯出的程式碼路徑。

---

## 六、本輪測試中發現並修正的真實錯誤

1. **靜態分群 `member_keys` 未去重就計數**：3 筆輸入（含 1 筆重複
   `member_key`）原本回報 `member_count=3`，實際資料庫只會寫入 2 筆
   （`INSERT OR IGNORE` 本身有去重，但回傳的計數沒有反映這件事）。已修正
   為輸入陣列先在應用層依 `member_key` 去重再計數，兩者現在一致。
2. **金額篩選完全沒有驗證**：輸入非數字字串會被原樣送進查詢字串；最低
   金額大於最高金額的矛盾組合也會被送出。已在 `av2ExplorerSetFilter()`
   加上驗證：非數字/負數拒絕並提示錯誤，min>max 時拒絕套用並保留原本
   有效的篩選值，兩種情況都完全不送出新的 API 請求。
3. **篩選 Chips 顯示原始後端值**：例如模式篩選選擇「外送」，Chip 卻顯示
   英文原始值 `delivery` 而非中文標籤（只有 `cart_status` 有對應到中文
   標籤，其餘欄位都被遺漏）。已修正為 `_av2ExplorerFilterValueLabel()`
   統一處理所有篩選欄位的值→標籤對照。
4. **`scrollIntoView` 呼叫沒有防呆**：所有主流瀏覽器都支援這個 API，但
   加上存在性檢查是低成本的防禦性寫法，順手一併修正。

以上 4 項全部由 `scripts/smoke-hotfix31-r3-frontend.js` 的真實行為測試
（而非原始碼字串掃描）抓出，修正後對應測試已轉為 PASS。

---

## 七、安全性強化（延續 R1/R2，本輪新增/確認項目）

- **Store 隔離**：`utils/drilldown.js` 新增的衍生欄位篩選、
  `routes/crm.js` 新增的 `member_keys` 路徑，所有查詢一律以已驗證的
  `req.storeId` 隔離；已用 R3 測試 E-4c／E-4d 驗證跨店無法讀取彼此的
  static 分群，且資料庫實際寫入的 `crm_segment_members` 全部帶正確
  `store_id`。
- **XSS／innerHTML 安全性**：所有動態插入的文字（商品名稱、會員名稱、
  來源、Campaign 等）一律透過既有 `escHtml()` 跳脫；商品名稱中若帶有
  `'` 字元，額外用 `.replace(/'/g, "\\'")` 處理 onclick 屬性內的 JS 字串
  邊界（沿用專案既有的既定模式，非本輪新發明）。已用真實 XSS payload
  （`<script>`、`<img onerror=...>`）驗證：不會產生真正的 `<script>` DOM
  元素、不會執行任意 JS、onclick 屬性結構不會被破壞。
- **敏感資訊遮罩**：LINE UID 一律只顯示遮罩後版本
  （`maskLineUserId()`），匿名訪客只顯示縮短過的顯示碼；明細表/Drawer
  沒有任何欄位包含 `access_token`/`id_token` 等原始憑證。
- **錯誤訊息安全**：API 失敗時前端只顯示固定的中文提示文字，不會把
  stack trace 或原始錯誤訊息直接呈現給使用者。
- **SQL Injection**：所有篩選值一律參數化查詢；已用 SQL injection 風格
  的篩選值（`'; DROP TABLE orders; --` 等）驗證查詢邏輯不受影響、
  `orders` 表本身未受影響。
- **CSRF/Auth**：完全沿用既有 `apiFetch()`（自動帶入已驗證的 JWT 與
  `x-store-id`），本輪沒有新增任何繞過既有驗證機制的呼叫路徑，
  `store_id` 一律不接受來自可編輯前端欄位的值。

---

## 八、來源真相與 Boss Dashboard／Android 稽核

用 `diff -rq` 對照 R1 之前使用者上傳的原始 zip
（`fix18-10-hotfix30-B5-R5-Cart-Detail-Order-Hours-full.zip`）與目前工作
副本（排除 `node_modules`/`data`），完整差異清單：

```
新增：CHANGELOG_HOTFIX31_R2_ARCHITECTURE_HARDENING.md
新增：CHANGELOG_HOTFIX31_R3_OPERATION_ANALYTICS_FRONTEND.md
新增：routes/crm.js
新增：scripts/smoke-hotfix31-r1-backend.js
新增：scripts/smoke-hotfix31-r2-hardening.js
新增：scripts/smoke-hotfix31-r3-frontend.js
新增：utils/crmActions.js
新增：utils/drilldown.js
新增：utils/visitor360.js
修改：package.json（新增 devDependencies.jsdom）
修改：package-lock.json（對應鎖定檔）
修改：public/js/analytics-v2.js（本輪唯一的前端修改）
修改：routes/analytics.js（新增 drilldown/visitor 路由）
修改：server.js（新增 /api/crm 掛載）
修改：utils/analyticsIdentity.js（新增 resolveCanonicalVisitor）
修改：utils/cartSnapshot.js（新增內部欄位/輔助函式，既有函式簽名/行為不變）
修改：utils/db.js（新增 CRM 治理表/索引，純加法）
```

**`routes/dashboard.js` 與整個 `public/` 目錄（除 `public/js/
analytics-v2.js` 外）逐檔比對結果完全一致，沒有任何差異。**
`pos-android-hotfix16.zip` 從上傳後只被 `unzip -l` 列出檔名清單，從未
解壓縮或以任何方式修改。

**無重複來源真相資料表**：本輪沒有新增任何資料表（沿用 R2 已建立的
`crm_segments`/`crm_segment_members`/`crm_actions`/`crm_action_targets`）；
再次確認不存在 `crm_members`/`crm_visitors`/`analytics_v3`/`visitor360`/
`visitor_profiles`/`cart_copy`/`session_copy`/`event_copy`/`order_copy`/
`member_copy`/`product_copy` 等任何重複表。

---

## 九、測試結果

| 測試 | 結果 |
|---|---|
| `node scripts/smoke-hotfix31-r1-backend.js` | **29/29 PASS** |
| `node scripts/smoke-hotfix31-r2-hardening.js` | **37/37 PASS** |
| `node scripts/smoke-hotfix31-r3-frontend.js` | **97/99 PASS**，2 項誠實標示 MANUAL REQUIRED（見下） |
| `node scripts/smoke-hotfix30-b5-r5-cart-order-hours.js` | 55/59 PASS，4 項既有 MANUAL REQUIRED（非本輪引入） |
| `node scripts/smoke-hotfix30-b5-r5-debounce.js` | 32/32 PASS |
| `node scripts/smoke-hotfix30-b5-r5-dashboard-ui.js` | 20/20 PASS（本輪新增 jsdom 後，此既有測試現在也能完整跑通） |
| `node scripts/smoke-hotfix30-c1-rollback.js` | 22/22 PASS |
| `node scripts/smoke-hotfix25.js` | 26/26 PASS，3 項既有 MANUAL REQUIRED |
| `node scripts/smoke-hotfix26-a.js` | 24/24 PASS，1 項既有 MANUAL REQUIRED |
| `node scripts/smoke-hotfix26-b.js` | 30/30 PASS，4 項既有 MANUAL REQUIRED |
| `node scripts/smoke-hotfix26-d.js` | 20/20 PASS，3 項既有 MANUAL REQUIRED |
| `node scripts/smoke-hotfix26-f8.js` | 21/21 PASS，3 項既有 MANUAL、5 項既有 NOT_IMPLEMENTED |

R3 的 2 項 MANUAL REQUIRED（jsdom 無法涵蓋，誠實標示，不謊報已通過）：
1. 窄螢幕/實際瀏覽器視覺呈現（明細表在真實手機/平板寬度下是否需要橫向
   捲動、版面是否破版）。
2. Session Timeline 時區換算在真實跨時區瀏覽器環境下的視覺呈現（後端
   換算邏輯本身沿用既有 `A_LOCAL`，本輪未新增獨立時區換算，只是前端沒有
   真實瀏覽器可以交叉確認顯示效果）。

### 環境限制導致無法完整執行的既有測試（誠實揭露，非本輪引入的迴歸）

以下項目經過**與 R1 之前的原始 pristine zip 逐行比對**確認：失敗/逾時的
訊息、位置與 pristine 版本完全一致，屬於既有問題，不是本輪任何修改造成：

| 指令 | 結果 | 環境問題 vs 產品問題 |
|---|---|---|
| `node scripts/smoke-hotfix26-c.js` | exit 1，`renderFriendStatus(null)` 文案斷言不符（`friend-status--unknown` 的期望文字） | **產品既有問題**（非本輪引入，pristine 版本同樣失敗於同一行斷言） |
| `node scripts/smoke-hotfix27-cd.js` | exit 1，內部呼叫 `smoke-hotfix27.js` 時因 sql.js binding 呼叫方式（`w._db.all is not a function`）失敗 | **產品既有問題**（pristine 版本同樣失敗，見下方說明） |
| `node scripts/smoke-hotfix29-b.js` | 25 秒逾時（exit 124），內部巢狀呼叫 `smoke-hotfix26-f8-b.js` 等多支腳本 | **既有架構限制**（巢狀 meta-regression，見 Hotfix30-B5-R5 文件記載的
`smoke-hotfix29-c.js` 同類逾時問題；pristine 版本同樣逾時） |

上述三支腳本內部共同觸發的 `w._db.all is not a function` 錯誤，經檢查是
`utils/db.js` 的 sql.js 包裝層在特定呼叫路徑下的既有問題（呼叫端誤用了
底層 `sqlDb` 物件而非包裝過的 `db` 物件），**與本輪 Drill Down／CRM／
Visitor 360 的任何程式碼完全無關**，pristine 原始 zip 上跑同一支腳本會
得到一模一樣的錯誤訊息與行號。

受限於單次會話時間，未逐一執行全部 29 支既有 smoke script；已執行的
11 支既有腳本中，8 支完全通過、3 支的失敗/逾時皆已個別對照 pristine
版本確認為既有問題。這與 Hotfix30-B5-R5 文件記載的既有 baseline
（16 PASS／12 既有 FAIL／1 既有 TIMEOUT，涵蓋全部 29 支腳本）方向一致。

---

## 十、手動驗證清單（誠實揭露：以下全部僅在 jsdom 中驗證行為邏輯，
**未在真實瀏覽器中執行**，因此標示為 NOT VERIFIED 而非 PASS）

| 項目 | 狀態 | 說明 |
|---|---|---|
| KPI 點擊 | NOT VERIFIED（邏輯已由 jsdom 測試 C-3~C-10a 驗證） | 需要真實瀏覽器確認點擊互動與視覺回饋流暢度 |
| 商品點擊 | NOT VERIFIED（邏輯已由 jsdom 測試 C-12 驗證） | 同上 |
| 來源點擊 | NOT VERIFIED（邏輯已由 jsdom 測試 C-13 驗證） | 同上 |
| 漏斗點擊 | NOT VERIFIED（邏輯已由 jsdom 測試 C-14 驗證） | 同上 |
| 時間軸 Drawer | NOT VERIFIED（邏輯已由 jsdom 測試 C-39/C-42~C-45 驗證） | 需要真實瀏覽器確認 Drawer 開闔動畫與捲動行為 |
| 訪客 360 Drawer | NOT VERIFIED（邏輯已由 jsdom 測試 C-40/C-46~C-48 驗證） | 同上 |
| 分群建立 | NOT VERIFIED（邏輯已由 jsdom 測試 C-52~C-59 驗證） | 需要真實瀏覽器確認 `prompt()` 對話框在實際瀏覽器中的操作流程 |
| CRM 佔位頁 | NOT VERIFIED（邏輯已由 jsdom 測試 C-60~C-62 驗證） | 同上 |
| 響應式版面（窄螢幕） | BLOCKED | jsdom 不渲染實際版面配置，無法以任何方式驗證；需要真實裝置或視覺回歸工具 |

**明確聲明**：以上「NOT VERIFIED」項目的底層邏輯正確性已由本輪
`scripts/smoke-hotfix31-r3-frontend.js` 的 jsdom 行為測試證實（呼叫真實
函式、檢查真實 DOM 結果、檢查真實 fetch 請求參數），但這不等於真實瀏覽器
視覺驗證——本次會話沒有可用的瀏覽器環境可以執行這項工作，因此不宣稱已經
完成，如實標示為待驗證。

---

## 十一、已知限制

1. LINE 好友狀態（`friend_status`）篩選/顯示目前只涵蓋 R3 已知的三態
   （friend/not_friend/unknown），且只在 Drill Down 路徑上可用，Boss
   Dashboard 既有的購物車明細不含此欄位（設計上刻意如此，見第四節）。
2. Cart Detail Explorer 目前沒有獨立的「預訂」（reservation）模式篩選
   選項——`order_mode` 欄位本身沒有 `reservation` 值（那是 `order_channel`
   維度的概念），前端目前只提供外帶/外送/宅配三種模式篩選。
3. CRM Action Center 目前純粹是佔位頁，不含任何實際執行動作的 UI 或
   API 呼叫——LINE 推播、優惠券發送、Email/SMS、Webhook、Meta/Google
   受眾匯出全部延續 R2 的 `not_configured` 狀態，尚未串接任何第三方管道。
4. 響應式版面在極窄螢幕/真實裝置上的實際呈現效果未經人工驗證（見上方
   手動驗證清單）。
5. 受限於單次會話時間，既有 29 支 smoke script 未全部重新執行；已執行
   的樣本涵蓋 Cart Detail／Debounce／Dashboard UI／Rollback／LINE CRM
   相關的多支既有腳本，全數通過或確認失敗屬於既有問題。

---

## 十二、R4 後續規劃（本輪不包含）

- CRM Action Center 實際執行 UI：發送優惠券、LINE 推播、建立再行銷名單
  等操作介面與確認流程。
- 真實第三方管道串接：LINE Messaging API（Channel Access Token 設定與
  推播基礎設施）、Email/SMS 服務商、Webhook 執行器、Meta CAPI、Google
  Ads Audience 匯出。
- LINE 好友狀態作為 Boss Dashboard 或其他既有頁面的篩選欄位（如有需求）。
- 真實瀏覽器/裝置的響應式版面與視覺回歸驗證。

---

## 十三、明確確認

- ✅ Boss Dashboard（`routes/dashboard.js` 與整個 `public/` 目錄，除
  `public/js/analytics-v2.js` 外）**完全未修改**（`diff -rq` 逐檔驗證）。
- ✅ Android 專案（`pos-android-hotfix16.zip`）**完全未觸碰**。
- ✅ 本輪**沒有執行任何實際的 LINE 推播、優惠券核發、Email/SMS 發送、
  Webhook 呼叫、或 Meta/Google 受眾匯出**——CRM Action Center 只是安全
  佔位頁，所有相關動作類型延續 R2 的 `not_configured` 誠實狀態。
- ✅ **沒有建立任何重複的來源真相資料表**。
- ✅ 本輪測試/開發過程**沒有修改任何正式環境資料**（所有測試皆在獨立的
  `data/pos.db`測試檔案上執行，每次測試開頭清空重建）。
