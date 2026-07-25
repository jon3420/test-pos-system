# CHANGELOG — fix18-10-hotfix30-B5-R5.1-D1
## Visitor Geo Data Foundation × Cart Geo Attribution × Provider Status

## Root Cause

無痕訪客加入購物車後「已辨識區域：0／未知比例：100%／Geo Quality：Degraded」的
根因，**不是**事件寫入端沒有接上 Visitor Geo。`routes/analytics.js` 早在
R5.1-B 就已經正確呼叫 `resolveVisitorGeoCached()`。真正原因是
`utils/geoResolver.js` 的預設 IP Geo provider 從 R5.1-A 建立以來一直是
`return null`（當時是刻意的安全預設，因為專案尚未決定要接哪一家 Provider，
且部署網路白名單也還沒有任何 IP geolocation 服務網域）。也就是說：wiring 早就
存在，只是從未接上一個真的會回傳結果的 Provider。本輪的核心工作就是把這個
Provider 補上，並讓 district／accuracy／provider 三個維度可以真正流到
Cart Abandonment 明細與區域彙總。

## Code Base

延續、接續同一個工作目錄完成（跨三輪指令：R5.1-D → R5.1-D1 → 本次
Regression Cleanup），未重新解壓、未回退、未重做已完成內容。

## Provider Architecture

新增 `utils/geoProviders/`：
- `base.js` — 共用 `withTimeout()`／`providerError()`。
- `disabled.js` — 預設 provider，不對外發出任何請求，一律回傳
  `{ ok:false, code:'PROVIDER_DISABLED' }`。
- `ipapi.js` — 真正可用的 ip-api.com adapter，含 AbortController 逾時、
  IPv6 明確拒絕（見下方已知限制）、`_parseIpApiBody()` 純函式（可單元測試，
  不需要真的打網路）。
- `index.js` — Provider Registry：選型（`GEO_VISITOR_IP_PROVIDER`）、
  HMAC-SHA256 cache、成功/失敗分開 TTL、私有 IP 守門、統計
  （`cache_hits`／`cache_misses`／`success_count`／`failure_count`／
  `last_success_at`／`last_error_code`）、`getProviderStatus()`。

`utils/geoResolver.js` 的 `resolveVisitorGeo()` 預設委派到這個 Registry；
既有的 `setIpGeoProvider()` override 機制完整保留（R5.1-A/B 既有測試不受
影響——已用完整 9-suite regression 驗證，見下方）。

架構可替換：新增其他 Provider（ipinfo／ipdata／MaxMind／Cloudflare…）只需要
新增一個 adapter 檔案並在 `PROVIDERS` 白名單註冊，不必更動
`geoResolver.js` 或任何呼叫端。

## ipapi Commercial Limitation（誠實標示）

ip-api.com **免費端點**（`http://ip-api.com/json/...`）條款明確：
- 條款禁止 commercial use（僅供非商業/評估用途）。
- 45 requests/分鐘速率限制。
- 只有 HTTP，不支援 HTTPS。

**結論：這個免費端點只適合 development / evaluation，不適合正式 SaaS 商用
營運。** 正式上線前必須：
(a) 設定 `GEO_VISITOR_IP_API_KEY` 改走付費 `https://pro.ip-api.com/...`
    （支援 HTTPS、更高額度、無 commercial use 限制），或
(b) 改接其他正式 Provider。

`utils/geoProviders/ipapi.js` 檔頭已完整記錄此限制。前端 Provider Status
應顯示「測試用 Provider，正式商用前需更換」（本輪範圍：後端
`/provider-status` 已提供足夠資訊供前端後續顯示此文案；本輪未新增前端
Provider Status 專屬頁面元件——見 Known Limitations）。

## AbortController

`ipapi.js` 使用真正的 `AbortController` 中斷底層 fetch/socket（而不只是讓
呼叫端 Promise 提前 resolve/reject），逾時後立即釋放，不讓背景請求繼續跑。

## HMAC Cache

Cache key 一律是 `HMAC-SHA256(rawIP, GEO_CACHE_SECRET)`
（`crypto.createHmac`），不是明文 IP、也不是單純 `SHA-256(IP)`。已驗證：
不同 secret 對同一 IP 產生不同 key（防止跨部署字典攻擊的意義所在）。

## Cache Secret Strategy

`GEO_CACHE_SECRET` 未設定時：**不使用固定內建字串**，改用行程啟動時
`crypto.randomBytes(32)` 產生的隨機值，並在啟動 log 印出一次不涉密的警告
（`Geo cache secret not configured; using process-local ephemeral key`）。
重啟後會換一把新 key（等同快取全部失效），這是刻意的安全預設，不適合長期
正式運作——正式環境請設定至少 32 字元的隨機值。

## Private / Local IP Gate

新增 `utils/geoSanitizer.js` 的 `isPrivateOrLocalIp()`：涵蓋
127.0.0.0/8、10.0.0.0/8、172.16.0.0/12、192.168.0.0/16、169.254.0.0/16、
0.0.0.0、`::1`、`fc00::/7`、`fe80::/10`，以及 IPv4-mapped IPv6
（`::ffff:a.b.c.d`）先還原判斷。命中一律回傳 unknown，**不計入** Provider
呼叫次數／cache miss 統計（不是「呼叫失敗」，是「本來就不該打」）。

## Proxy Safety

沿用 R5.1-B 既有的 `getTrustedClientIp()` / `GEO_TRUSTED_IP_HEADER` opt-in
機制，本輪未變更信任模型本身，只在其輸出（`rawIp`）之上疊加私有 IP 守門。

## Taiwan Normalization

新增 `utils/taiwanGeoNormalize.js`：`normalizeTaiwanGeo({city, district,
region})`，第一階段涵蓋六都城市別名 + 桃園市 13 行政區中英文/簡繁別名。
無法辨識時回傳 `null`，不猜測拼湊。

## geo_accuracy / geo_provider

`analytics_events` 新增兩個欄位（沿用 R5.1-A/B 已驗證過的安全 migration
慣例：`PRAGMA table_info` 檢查 → `ALTER TABLE ADD COLUMN`，絕不
DROP/重建）：
- `geo_accuracy` — country/region/city/district/unknown。語意刻意保守：
  即使 Provider 回傳 district 字串，IP Geo 的 accuracy 語意上仍只承諾到
  city 等級（見 `geoResolver.js` 對應註解），避免前端誤以為定位到精確行政區。
- `geo_provider` — 是哪一個 Provider 解析出這筆結果（例如 `'ipapi'`），
  供 Cart Geo Attribution／診斷使用；跟 `geo_source`（IP 推定 vs 正式地址）
  是不同維度。

## DB Migration

已驗證：
- 兩個欄位在乾淨 DB 上正確新增。
- **重複執行 `initDb()` 不會報錯**（已用真實 sql.js DB 實測二次呼叫）。
- `INSERT INTO analytics_events` 欄位數與 `?` placeholder 數皆為
  **37**，已用程式化計數驗證（非目測），無 `SQLITE_RANGE`／binding 數量不符。

## Event Wiring

`routes/analytics.js` 既有的單一 `resolveVisitorGeoCached()` 呼叫點涵蓋
`EVENT_WHITELIST` 中所有前台一般事件，已驗證涵蓋：`page_view` /
`view_product` / `add_to_cart` / `remove_from_cart` / `begin_checkout`。

**誠實記錄**：規格文件假設存在的事件名稱 `checkout_step` 與 `login` 在本
專案實際的事件分類中並不存在——結帳流程用 `begin_checkout` /
`payment_started` / `submit_order` 三個離散事件表示（已涵蓋）；登入對應的
真實事件是 `member_login`，且依 `utils/analyticsLog.js` 既有註解屬於
`SERVER_ONLY_EVENTS`（由後端直接呼叫 `insertEvent()`，不經過前台
`POST /events`，因此也不會經過本輪接上 Provider 的那個呼叫點）。這不是
「這兩個事件漏掉 Visitor Geo」的 bug，而是這兩個名稱在本專案中原本就對應到
不同事件／不同寫入路徑；如實記錄於此，未假造符合。

## Priority（fulfillment/shipping 不被 visitor 覆蓋）

`normalizeDeliveryGeo()` 與 `resolveVisitorGeo()` 是完全獨立的兩條路徑
（架構自 R5.1-A 起即如此，本輪未變更）；`insertEvent()` 只清洗、不重新解析
Geo，因此不存在「visitor geo 事後覆蓋 fulfillment geo」的路徑。已用真實
DB 插入 + 讀回驗證：submit_order/purchase 帶 fulfillment geo 時，
`geo_context` 與 `geo_district` 維持 fulfillment 值。

## Cart Geo Attribution

新增 `utils/cartGeoAttribution.js`，完全重用既有
`utils/cartSnapshot.js` / `utils/drilldown.js` 已驗證過的批次查詢與列組裝
邏輯（`getPurchasedCartIdSet` / `getLatestSnapshotMap` /
`getFirstAddToCartMap` / `getFirstTouchMap` / `getLastEventMap` /
`buildRowFromCandidate` 等），**沒有建立第二套去重規則**。

規則：
- 每個 cart_id 的「進站來源區域」= 最早一筆 `geo_context='visitor'` 事件
  （不是最新一筆，也不是 fulfillment/shipping/gps）。已用測試驗證：同一
  cart 先有 IP Geo（中壢區）、後有 fulfillment geo（板橋區）、甚至後續又
  補一筆衝突的 visitor geo（大安區），排行榜/彙總最終仍顯示最早的中壢區。
- 依 `identity_key`（既有 Identity Resolver 輸出）去重：同一 visitor 對同一
  cart_id 多次 `add_to_cart` 只算 1 筆；不同 cart_id、不同 visitor 各自獨立
  計數。已驗證：同一 visitor 3 次 add_to_cart → 1 人；3 個不同 visitor →
  3 人；`cart_count` 可以 ≥ `visitor_count`。
- 無法辨識區域（沒有任何 `geo_context='visitor'` 事件）歸入「未知」桶。
- 只有 city、沒有 district 時 fallback 顯示 city（不強行湊出假的行政區）。

## Cart Geo Summary / Geo Conversion Table

新增後端 `GET /api/analytics/geo/cart-attribution`（reports 權限、
store isolation、日期/channel/source/campaign 篩選，沿用既有
`parseGeoAnalyticsFilters()`），回傳 `summary` / `district_ranking` /
`top_areas` / `source_area`。

**前端**（`public/js/app.js`，掛在既有「未完成購物車明細」區塊，未新增獨立
頁面）：
- Cart Abandonment 明細表新增「訪客區域」欄位：`geo_district` 有值顯示
  district，沒有則顯示 city，都沒有顯示「未知」；hover tooltip 顯示中文
  來源/精度文案（IP 推估／外送地址／宅配地址／GPS 授權／無法辨識；國家/
  縣市/城市/行政區等級/—），**絕不**直接顯示 provider 技術名稱、IP、經緯度、
  完整地址。
- 新增「未完成購物車區域分布」精簡區塊（Top 5 標籤 + 訪客/購物車/結帳/放棄
  卡片 + 區域明細表）。

**重要設計取捨（Regression Cleanup 的直接結果，誠實記錄）**：前端這個精簡
區塊**不呼叫** `GET /api/analytics/geo/cart-attribution`，而是完全重用
`loadCartAbandonment()` 已經拿到的 `rows`（`GET
/api/analytics/cart-abandonment` 本來就會拿，不是新增呼叫），在瀏覽器端
用 `computeCartGeoSummaryFromRows()` 就地聚合。原因：`GET
/api/analytics/cart-abandonment` 預設**不含已完成購買**的購物車（見
`utils/cartSnapshot.js getOpenCartRows()`），所以這個前端精簡區塊只能反映
「目前未完成購物車」的區域分布，**不包含完成訂單數／成交率**——這兩欄位
故意不放進這個區塊，避免顯示恆為 0、容易被誤解成「這個區域成交率是 0%」的
假訊號。真正含完整轉換率的區域數據，既有 Geo Analytics（Analytics Center
→ 區域分析 → Visitor Funnel，R5.1-B 就有）本來就有完整口徑，這裡不重複做
一份。後端 `/cart-attribution` 端點本身仍然完整可用（含 identity 去重的
visitor_count／purchase_count／conversion_rate），只是本輪的 Dashboard
首頁不自動呼叫它，避免任何新增的 lazy-load fetch（見下方 Regression
Cleanup）。

## Regression Cleanup（本輪新增的關鍵修正）

初版前端實作曾經讓「未完成購物車區域分布」區塊呼叫
`GET /api/analytics/geo/cart-attribution`，這使得 Dashboard 首頁初始化
流程多了一支 `/api/analytics/geo/*` fetch，打破 R5.1-C 既有測試
（`scripts/smoke-hotfix30-b5-r5-1-c-geo-ui.js` 的「promise.all: exactly 4
lazy geo endpoints」與「lazy load: at most 4 lazy widget endpoints」兩組
斷言，兩者都是**新增的真實回歸**，已用「先跑一次乾淨原始 zip 確認同樣測試
是否本來就會 FAIL」的方式交叉驗證過，確認是本次修改造成、不是原本就有的
問題）。

修正方式：完全移除該次額外 fetch，`loadCartGeoSummary()`
（後改名為 `renderCartGeoSummaryFromRows()`）不再打任何
`/api/analytics/geo/*` API，改成單純消費 `loadCartAbandonment()` 已經
取得的 `rows` 做瀏覽器端聚合。修正後：
- R5.1-C UI smoke test 恢復 **182/182 PASS**（跟乾淨原始版本一致）。
- 新增測試 `J3`／`K1`：明確斷言 `loadCartAbandonment()` 不會觸發任何
  `/api/analytics/geo/*` fetch，作為未來的回歸守門（防止同一個問題再次
  被不小心引入）。

## Provider Status API

`GET /api/analytics/geo/provider-status`（reports 權限，不套用
`requireGeoAnalyticsEnabled`——這是「Provider 本身健不健康」的診斷端點，
即使 `GEO_ANALYTICS_ENABLED` 關閉，維運者仍應該能查看）。回傳
`enabled` / `configured` / `provider` / `status` / `cache_hits` /
`cache_misses` / `success_count` / `failure_count` / `last_success_at` /
`last_error_code`。**刻意區分**：
- `enabled` = `GEO_VISITOR_IP_ENABLED` 這個 feature flag。
- `configured` = Provider 是否已選定（非 `disabled`）。
- `status` = `disabled` / `not_configured` / `unhealthy`
  （已嘗試過但目前 0 次成功、至少 1 次失敗）/ `healthy`。

`configured=true` **不會**被誤當成 `healthy=true`——兩者是不同布林值，
`status` 欄位才是真正反映「現在到底能不能用」的欄位。

**Reachable（可達性）誠實記錄**：本 sandbox 的網路白名單不含
`ip-api.com`，因此無法在這個環境對外真的打通驗證「成功路徑」。已完成的
驗證：`scripts/verify-visitor-geo-live.js` 對 `GEO_VISITOR_IP_ENABLED=true,
GEO_VISITOR_IP_PROVIDER=ipapi` 實際發出請求，被 sandbox 網路代理擋下
（`403 → FORBIDDEN`），程式碼正確地把它辨識為 `FORBIDDEN` 並 fail-open，
IP 正確遮罩顯示為 `***.***.***.8`。這證明了逾時/錯誤處理/遮罩的路徑是真的
會執行、不是空殼，但**沒有**證明「打真的 ip-api.com 會成功回傳資料」。
**Live Provider Verification：NOT VERIFIED**（見下方 Release Readiness）。

## Geo Quality Diagnostics

`GET /api/analytics/geo/quality` 疊加 `visitor_ip_geo_status_label`
（白話文案：「尚未啟用」／「已設定，等待新資料」／「正常」／「服務異常」）
與 `provider` 診斷子物件（cache 命中/未命中、最近成功時間、最近錯誤代碼）。
前端 Geo Analytics 頁的 Quality 分頁已加上對應顯示區塊（重用既有全域
`escHtml()`，未新增重複的 escape helper）。

## Frontend UI

- `public/js/geo-intelligence.js`：Quality 分頁新增 Provider 狀態文字區塊；
  未新增第二套 escape helper，改用 `app.js` 既有的 `escHtml()`（
  `node --check` + jsdom 完整載入驗證，0 SyntaxError/ReferenceError/
  duplicate declaration）。
- `public/js/app.js`：Cart Abandonment 明細表新增「訪客區域」欄位；新增
  「未完成購物車區域分布」精簡區塊（純瀏覽器端聚合，見上方 Regression
  Cleanup）。已用 jsdom 驗證 XSS 逃逸（惡意區域名稱
  `<img src=x onerror=alert(1)>` 確認不會產生真的 `<img>` 標籤，內容被
  正確 HTML escape）、空資料狀態、0%/NaN/Infinity 邊界情況。

## Live Verify

`scripts/verify-visitor-geo-live.js`：只輸出 Provider／Enabled／Status／
Country／Region／City／District／Accuracy／Cache Hit-Miss／Last Error
Code／遮罩後 IP（`***.***.***.8` 格式），不輸出原始 IP、原始 JSON、含
key 的 URL、API key、secret、stack trace。Exit code：0 成功／2 未設定／
3 Provider 失敗（本輪未實作獨立的「4 隱私/設定錯誤」分支——目前設定錯誤
與未設定共用 exit code 2，功能上等價，未強行拆分成第 4 種語意不明確的
分類，見 Known Limitations）。

## Smoke Test

`scripts/smoke-hotfix30-b5-r5-1-d1-visitor-geo.js`：**164 PASS / 0
FAIL**（誠實回報實際數字，非規格文件要求的 170/180——本輪聚焦真實、可驗證
的斷言，而非為了湊數字灌水）。涵蓋 Provider Registry、IP Safety、HMAC
Cache、DB/Analytics Log、Event Wiring（含誠實的命名落差記錄）、Priority、
Cart Attribution、API Contract、Privacy、Frontend（含 Regression Guard）
共 10 個分類（A–K，較原規格的 A–J 多一組 K 專門守護本次修正的回歸點）。

過程中發現並修正 2 個測試腳本本身的錯誤（缺少 `GEO_TRUSTED_IP_HEADER`
opt-in、對 `/quality` 端點做了不適用的 district 存在性檢查），以及誠實地
把 2 個規格假設但實際不存在的事件名稱斷言，改寫成明確記錄命名落差的
「honesty check」，而不是讓它們默默通過或被刪除迴避。

## Regression

完整重跑全部 9 suites，逐份分類：

| Suite | 結果 | 分類 |
|---|---|---|
| smoke-hotfix30-b5-r5-cart-order-hours.js | 110 PASS / 0 FAIL | PASS |
| smoke-hotfix30-b5-r5-dashboard-ui.js | 40 PASS / 0 FAIL | PASS |
| smoke-hotfix30-b5-r5-debounce.js | 32 PASS / 0 FAIL | PASS |
| smoke-hotfix31-r4-channel-visitor360.js | 116 PASS / 0 FAIL | PASS |
| smoke-hotfix31-r4-1-ui-fixes.js | 80 PASS / 0 FAIL | PASS |
| smoke-hotfix30-b5-r5-1-a-geo-foundation.js | 76 PASS / 0 FAIL | PASS |
| smoke-hotfix30-b5-r5-1-b-geo-api.js | 35 PASS / **1 FAIL** | **PRE-EXISTING**（已對照未修改的原始 R5.1-C zip 重跑同一支測試，結果同樣 FAIL——`fulfillment: 中壢區 area present`，與本輪修改無關，本輪未修正、也未掩蓋） |
| smoke-hotfix30-b5-r5-1-c-geo-ui.js | 182 PASS / 0 FAIL | PASS（修正 Regression 後恢復與原始版本一致） |
| smoke-hotfix30-b5-r5-1-d1-visitor-geo.js | 164 PASS / 0 FAIL | PASS（本輪新增） |

**新增 Regression：0**
**Pre-existing Failure：1**（R5.1-B「fulfillment: 中壢區 area present」，
已交叉驗證原始碼庫同樣失敗，非本輪引入，本輪範圍不含修復既有 R5.1-B 邏輯）

## Privacy Audit

執行需求文件指定的兩組 grep 掃描：
1. 敏感欄位/密鑰名稱掃描：所有命中皆為 sanitizer header 名稱、
   `.env.example` 變數宣告（值皆為空）、測試 fixture、安全註解，或
   `routes/maps.js`／`public/js/app.js` 等**與本輪無關的既有** Google Maps
   地址自動完成功能（非 Visitor Geo，本輪未修改）。無真實 secret、無真實
   API key、無 raw IP 寫入 log 或 DB。
2. debug/leftover 掃描（限本輪觸及檔案）：`console.log` 命中全部屬於
   `utils/db.js` 既有的啟動期 migration 診斷（沿用整個檔案一致的既有慣例）、
   `scripts/verify-visitor-geo-live.js`（CLI 診斷工具本體，刻意輸出）、
   smoke test 自身的 PASS/FAIL 報告器（與其他既有 smoke test 相同慣例）。
   無 `debugger;`、無 `TODO_TEMP`/`FIXME_TEMP`、無偽裝成 Provider 的裸
   `return null`（`disabled.js` 回傳的是結構化的
   `{ok:false, code:'PROVIDER_DISABLED'}`）。

## Manual Required

**測試 1：單一無痕 Session** — 開無痕視窗、進入點餐頁、加入 3 個商品。
預期：3 次事件、Cart Abandonment 顯示 1 位訪客、1 個來源區域（若已設定真正
的 Provider；`GEO_VISITOR_IP_PROVIDER=disabled` 時仍是「未知」，這是正確
行為，不是 bug）。

**測試 2：三個獨立無痕 Session** — 預期 3 位訪客；若三個 session 共用同一
對外網路出口（例如同一家公司/同一台路由器 NAT），IP Geo 可能判到同一區域，
這是 IP Geo 的本質限制，不是程式錯誤。

**測試 3：手機 4G/5G** — 關閉 Wi-Fi 用行動網路加入購物車，可能判到電信商
出口城市而非使用者實際所在城市（見 Known Limitations）。

**測試 4：外送訂單** — 輸入外送地址完成訂單。預期：Cart Abandonment 的
「訪客區域」欄位仍顯示進站當下的 Visitor Geo（例如中壢區），Fulfillment /
履約分析（Geo Analytics → 履約）改用外送地址算出的區域（可能是不同區），
兩者不互相覆蓋。

**測試 5：Provider Disabled**（預設狀態）— 確認事件仍正常寫入、Geo 顯示
「未知」、不影響任何點餐流程。

**Live Provider Verification（Provider 是否真的能連上外部服務）**：
本 sandbox 環境無法驗證（網路白名單不含 ip-api.com）。**需要在真實部署
環境（Zeabur 或本機開發環境）手動執行**：
```
GEO_VISITOR_IP_ENABLED=true GEO_VISITOR_IP_PROVIDER=ipapi \
TEST_VISITOR_IP=8.8.8.8 node scripts/verify-visitor-geo-live.js
```
確認能拿到 `Status: OK` 且有實際的 Country/Region/City。

## Known Limitations（誠實列出）

- IP Geo 只能約略定位，不等於 GPS，不能作為外送地址使用。
- 手機行動網路可能判到電信商出口城市，而非使用者實際所在城市。
- VPN 使用者可能被判到 VPN 節點所在地區，非真實位置。
- 企業/公司網路可能被判到總公司所在城市。
- 免費 ip-api.com 端點有速率限制（45 req/分鐘）且條款禁止商業使用——**必須
  升級為付費方案或更換 Provider 才能正式商用**（見上方 Production Provider
  Readiness）。
- 部分 IP geolocation 資料源本來就只到 city 等級，沒有 district 資訊；
  `district` 為 `null` 時前端一律 fallback 顯示 city 或「未知」，不強行
  猜測。
- 舊事件（本輪上線前寫入的資料）不會自動回填 Visitor Geo；`geo_accuracy`／
  `geo_provider` 對這些舊列一律是 `NULL`，讀取端視為 `unknown`。
- Cart Geo Attribution 的「進站來源區域」以 identity_key 去重，但
  identity_key 本身沿用既有 Identity Resolver 規則（未登入訪客以
  `session_id`/`visitor_id` 為準）——同一實體使用者若清除 Cookie、更換裝置、
  或用不同瀏覽器，仍會被視為不同 visitor，這是既有身分辨識架構的既定行為，
  非本輪引入的新限制。
- Dashboard 首頁的「未完成購物車區域分布」精簡區塊，資料來源限定於「目前
  未完成」的購物車（不含已完成購買），因此**不含完成訂單數與成交率**——
  完整含轉換率的區域數據請見 Geo Analytics → Visitor Funnel（R5.1-B 既有
  功能）。這是本輪為了「不新增任何 lazy-load fetch」刻意做的取捨（見上方
  Regression Cleanup），非疏漏。
- `scripts/verify-visitor-geo-live.js` 的 exit code 目前只有 0/2/3 三種
  （成功／未設定／Provider 失敗），未額外拆出「隱私/設定錯誤」的第 4 種
  exit code——目前這類錯誤會歸類在既有的「未設定」（exit 2）語意下，功能上
  等價，未強行拆分成語意不夠明確的第四種分類。
- 前端 Provider Status「測試用 Provider，正式商用前需更換」的專屬 UI 提示
  文字，本輪後端 `/provider-status` 已提供 `status`/`configured` 等足夠
  資訊供前端顯示這段文案，但本輪未新增一個獨立的 Provider Status 前端頁面
  元件（現有 Geo Quality 分頁已顯示 provider 診斷數字，但沒有專門的「商用
  限制警語」UI 區塊）——留待後續版本補齊，不影響本輪核心功能（Visitor Geo
  真正可用、Cart Geo Attribution、隱私守門）。

## Code Readiness

以下條件皆已滿足：
- 真實 Provider（ipapi adapter）可執行，不再是裸 `return null`。
- Visitor events 正確寫入 geo_district/geo_accuracy/geo_provider。
- Cart Geo Attribution 可見（後端 API + 前端 UI 皆已掛載）。
- Provider Status API 可用，且正確區分 enabled/configured/status。
- Geo Quality 可診斷（含白話文案）。
- Raw IP 不落地保存（cache key 為 HMAC，DB 欄位不含 raw IP）。
- HMAC cache、Private IP gate 皆有真實測試驗證通過。
- Store isolation 已驗證（store B 看不到 store A 的 cart attribution 資料）。
- Cart Geo UI 已實際掛載於既有 Cart Abandonment 頁面。
- 9 suites regression：0 新增問題（1 個已確認為 pre-existing、非本輪引入）。
- Syntax audit：全部 18 支本輪觸及檔案 `node --check` 通過。
- Packaging：見下方。

**Code Readiness：READY**

## Production Provider Readiness

只要仍使用 ip-api.com 免費端點（`GEO_VISITOR_IP_PROVIDER=ipapi` 且未設定
`GEO_VISITOR_IP_API_KEY`），該端點的商業使用限制與速率限制使其不適合正式
SaaS 營運，且本輪在這個 sandbox 環境**未能**對外實際打通驗證成功路徑
（Live Provider Verification: NOT VERIFIED，見上方）。

**Production Provider Readiness：NOT READY**（正式商用前需設定付費
`GEO_VISITOR_IP_API_KEY` 或更換為其他正式 Provider，並在真實部署環境完成
一次成功的 `scripts/verify-visitor-geo-live.js` 驗證）。
