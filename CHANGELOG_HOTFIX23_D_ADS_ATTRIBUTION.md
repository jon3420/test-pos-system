# CHANGELOG — fix18-10-hotfix23-D｜Ads Attribution Foundation × UTM Tracking × Meta/GA4 Ready × Campaign Analytics

基礎版本：fix18-10-hotfix23-C（Manager Dashboard V3 × AI 經營助理 × 趨勢分析）

依需求文件開發原則，**不重寫**：POS、Android、LINE Pay 原有金流邏輯、優惠券、
Business Calendar、LINE 外帶／外送、冷藏宅配、購物車永久保留、模式關閉不自動
切換、Hotfix22 全部功能、Hotfix23-A Analytics Foundation、Hotfix23-B/23-C Dashboard。

---

## 1. 開場稽核結果（開發前）

| 項目 | 稽核結果 |
|---|---|
| `analytics_events` schema | 已有 `source/medium/campaign/referrer/landing_page/fbclid/gclid/metadata_json`，本次**沒有改表結構**，只多加兩個索引 |
| `line-order.html` / `line-shipping.html` | 兩頁**各自重複**一份 `_deriveSource()`／`_getAnalyticsContext()`／`_trackEvent()`／`_analyticsPayloadForOrder()`，且 `_getAnalyticsContext()` 只用 `sessionStorage` 快取一次，同一 session 內不會更新、也沒有真正的 first_touch／last_touch 概念、`_deriveSource()` 沒有判斷 `fbclid`／`gclid` |
| `submit_order`／`purchase` 後端寫入 | `routes/line-orders.js`、`routes/line-shipping.js`（非 LINE Pay 立即寫）、`routes/linepay.js`（LINE Pay Confirm 成功才寫）三處，寫法一致；**Purchase 去重機制已存在**（`analytics_events` 有 `UNIQUE(store_id, order_id, event_name) WHERE event_name IN ('submit_order','purchase')` 的 partial unique index，加上 `hasEventForOrder()` 查重），本次**沿用、沒有重建** |
| Dashboard `getSources()` | 舊版「Analytics 廣告來源」只统計進站訪客數，沒有轉換漏斗、沒有 Campaign、沒有 UTM |
| 既有索引 | `(store_id,created_at)`／`(store_id,event_name,created_at)`／`(store_id,visitor_id)`／`(store_id,session_id)`／`(store_id,cart_id)`／`(store_id,product_id,created_at)`／`(store_id,order_id,event_name)` 都已存在；**缺少** `(store_id,source,created_at)` 與 `(store_id,campaign,created_at)`，本次補上 |

結論：本次真正需要新建的是「共用歸因模組」「first_touch/last_touch 儲存」「Meta Pixel／GA4 Ready」「Dashboard 廣告來源分析」，其餘（事件白名單、Purchase 去重、metadata 大小限制）**全部沿用既有機制**。

---

## 2. 修改檔案清單

### 後端
- **`utils/db.js`** — 新增兩個索引（`CREATE INDEX IF NOT EXISTS`，可重複執行）：
  `idx_analytics_store_source_created`、`idx_analytics_store_campaign_created`。
- **`utils/analyticsLog.js`** —
  - `getOrderTrackingContext()` 的 SELECT 補上 `metadata_json`，讓 LINE Pay Confirm 的
    purchase 事件可以沿用 submit_order 當下存的 first_touch/last_touch。
  - 新增 `buildTrackingMetadata(ap)`：把前端送單時附帶的
    `first_touch`／`last_touch`／`metadata.utm_content`／`metadata.utm_term` 組成
    submit_order 的 metadata，**白名單固定欄位**，前端塞入姓名/電話/金額等其他欄位不會被寫入。
- **`routes/line-orders.js`** / **`routes/line-shipping.js`** — submit_order／purchase
  的 `evtBase` 加上 `metadata: buildTrackingMetadata(ap)`。
- **`routes/linepay.js`**（`/confirm`）— purchase 事件的 `metadata` 改用
  `ctx.metadata_json`（沿用 submit_order 當下存的 first_touch/last_touch，不因
  callback URL 沒有 UTM 就變成 direct）。
- **`utils/dashboardAnalytics.js`** — 新增第 13 節 `getAdsAttribution(db, storeId, range)`：
  一次算出 Last Touch／First Touch 兩種模式的來源漏斗表、Campaign 明細表、各自的
  廣告營收，回傳單一 `ads_attribution` 物件（見下方「Dashboard 統計口徑」）。
- **`routes/analytics.js`** — `GET /api/analytics/dashboard` 回應新增 `ads_attribution`
  欄位（既有欄位不變）；解析失敗有 try/catch fallback，不會讓整支 API 500。
- **`routes/settings.js`** — 新增 `ANALYTICS_KEYS`（見下方 Settings key），加入
  `ALL_ALLOWED` 白名單；`PUT /api/settings` 新增 Meta Pixel ID／GA4 Measurement ID
  基本格式驗證。
- **`routes/line-orders.js`**（`/shop`）／**`routes/line-shipping.js`**
  （`getShippingSettings()`）— 公開的 `/shop` API 白名單加入 4 個廣告追蹤 key
  （Pixel ID／Measurement ID 本身非密鑰，前台本來就要明碼載入才能初始化）。

### 前端
- **`public/js/analytics-attribution.js`**（新檔）— 共用歸因模組：
  `normalizeTrafficSource()`、`captureAttribution()`、`getAttribution()`、
  `buildAnalyticsEventContext()`、`buildOrderAnalyticsContext()`。
- **`public/js/analytics-platforms.js`**（新檔）— 共用 Meta Pixel／GA4 模組：
  `init()`、`initMetaPixel()`、`initGA4()`、`trackMeta()`、`trackGA4()`、
  `trackPlatformEvent()`。
- **`public/line-order.html`** / **`public/line-shipping.html`** —
  - 載入順序：`analytics-attribution.js` → `analytics-platforms.js` → 既有 inline script。
  - `_deriveSource()`／`_getAnalyticsContext()`／`_trackEvent()`／
    `_analyticsPayloadForOrder()` 改為 delegate 到共用模組，**函式名稱與既有呼叫點
    完全不變**（`_trackEvent('page_view')` 等呼叫處都不用改）。
  - `init()` 內在讀到店家設定後呼叫 `AnalyticsPlatforms.init(settings)`。
  - 新增 `_firePurchaseOnce()`：只在「後端已確認訂單成立／付款成功」的頁面觸發一次
    Meta/GA4 Purchase，用 `order_number` 去重。兩頁使用**不同的 localStorage key 前綴**
    （`analytics_purchase_fired_${store}_${order}` vs
    `analytics_purchase_fired_shipping_${store}_${order}`），避免互相污染。
  - 非 LINE Pay 立即成功：用當下 API 回應的 `order_number`/`total`（後端權威值）觸發。
  - LINE Pay 導回成功：**不使用 URL 上的任何金額**（可被竄改），改用既有查詢 API
    （`/api/line-orders/query`、`/api/line-shipping/order/:orderNo`）取得後端權威的
    `total`/`items` 後才觸發。
- **`public/index.html`** — 新增設定分頁「📣 廣告追蹤」（Meta Pixel／GA4 開關 + ID 欄位，
  刻意不放 CAPI Token／Test Event Code）。
- **`public/js/app.js`** —
  - `switchSettingsTab()` 加上 `ads_attribution` 分派；新增
    `loadAdsTrackingSettings()`／`saveAdsTrackingSettings()`（沿用既有
    `GET`/`PUT /api/settings`，沒有第二套 API）。
  - Dashboard V3 新增「📣 廣告來源分析」：`renderDashboardAdsAttribution()` +
    `setAdsAttributionMode()`（Last/First Touch 切換純前端 render，不重打 API）+
    `_adsSourceTableHtml()` / `_adsCampaignTableHtml()`；`renderDashboardSources()`
    移除舊版陽春的「Analytics 廣告來源」子區塊（已被新版取代，避免重複顯示同一件事）。

### 未修改（依需求文件明確排除）
POS、Android、LINE Pay 金流邏輯本身（`routes/linepay.js` 只多了一段 metadata 帶入，
付款流程判斷完全沒動）、優惠券、Business Calendar、`routes/dashboard.js`（舊版）、
Hotfix23-A 事件白名單與寫入規則、Hotfix23-B/C Dashboard 既有區塊。

---

## 3. Settings Key

| Key | 說明 |
|---|---|
| `analytics_meta_pixel_enabled` | `'1'`/`'0'` |
| `analytics_meta_pixel_id` | 純數字，6~20 位 |
| `analytics_ga4_enabled` | `'1'`/`'0'` |
| `analytics_ga4_measurement_id` | `G-` 開頭格式 |

刻意**沒有**加入 `analytics_meta_capi_token`／`analytics_meta_test_event_code`——
本版本沒有實作 Meta Conversion API，加了這兩個欄位反而會讓店家誤以為已經完成
伺服器對伺服器回傳。沿用既有 `GET`/`PUT /api/settings` 與 `ALL_ALLOWED` 白名單，
沒有建立第二套設定 API。

---

## 4. Attribution localStorage 格式

Key：`analytics_attribution_${store_id}`（store 之間完全隔離，同瀏覽器逛不同店家
不會互相污染）。

```json
{
  "version": 1,
  "first_touch": { "source":"facebook","medium":"paid_social","campaign":"...","content":"...","term":"","referrer":"...","landing_page":"...","fbclid":"...","gclid":"","captured_at":"..." },
  "last_touch":  { "source":"google","medium":"cpc","campaign":"...","content":"","term":"...","referrer":"...","landing_page":"...","fbclid":"","gclid":"...","captured_at":"..." }
}
```

### First Touch / Last Touch 規則
1. `first_touch`：第一次有效進站（帶有 UTM／fbclid／gclid，或完全沒有任何歸因參數的
   第一次進站）保存後**永不覆蓋**，只有使用者自行清除瀏覽器資料才會消失。
2. `last_touch`：**只有這次進站帶著新的 `utm_source`／`utm_medium`／`utm_campaign`／
   `fbclid`／`gclid` 才更新**；純粹的 direct 造訪（站內導覽、之後空手回訪）不會把
   既有的廣告來源覆蓋成 `direct`。
3. `utm_content`／`utm_term` 放在事件的 `metadata.utm_content`／`metadata.utm_term`，
   不佔用 `analytics_events` 既有欄位。
4. 欄位長度限制：`source≤50`／`medium≤100`／`campaign≤200`／`content≤200`／
   `term≤200`／`fbclid≤500`／`gclid≤500`／`referrer≤1000`／`landing_page≤1000`；
   超過直接截斷，不會讓事件寫入失敗。

---

## 5. Source Normalize 規則（`normalizeTrafficSource`）

判斷順序：`utm_source`（含別名：fb/facebook/meta→facebook、ig/instagram→instagram、
google/adwords→google、line/line_oa→line_oa）→ `fbclid` 存在 → `facebook` →
`gclid` 存在 → `google` → referrer domain（facebook.com/instagram.com/threads.net/
google.*/line.me/liff.line.me/lin.ee）→ 同網域 → `direct` → 其他 referrer →
`referral` → 都沒有 → `direct`。前端（`analytics-attribution.js`）是唯一規則來源，
`line-order.html` 與 `line-shipping.html` 都是呼叫同一份函式，沒有各寫一套。

---

## 6. Meta Pixel／GA4 事件對照

| 內部事件 | Meta Pixel | GA4 |
|---|---|---|
| page_view | PageView | page_view |
| view_product | ViewContent | view_item |
| add_to_cart | AddToCart | add_to_cart |
| begin_checkout | InitiateCheckout | begin_checkout |
| payment_started | AddPaymentInfo | add_payment_info |
| purchase | Purchase | purchase |

Purchase 規則：**只在後端已確認訂單成立／付款成功的結果頁觸發一次**（非 LINE Pay
立即成功頁 / LINE Pay 導回成功頁），`value`／`transaction_id` 一律用後端回傳的
`order_number`/`total`，`currency` 固定 `TWD`，Meta 用 `order_number` 當 `eventID` 去重，
不送姓名／電話／地址。LINE Pay 取消／失敗不觸發。

---

## 7. Dashboard 統計口徑（`ads_attribution`）

```json
{
  "mode": "last_touch",
  "sources": [ { "source":"facebook","entry":120,"view_product":85,"add_to_cart":43,"begin_checkout":28,"submit_order":22,"purchase":20,"conversion_rate":16.67,"ad_revenue":18400 } ],
  "campaigns": [ { "campaign":"（未設定活動）","source":"direct", "...": "同上欄位", "ad_revenue": 0 } ],
  "revenue": { "last_touch": 18400, "first_touch": 15200 },
  "first_touch_available": true,
  "note": "",
  "by_mode": { "last_touch": {...}, "first_touch": {...} }
}
```

- 進站／商品瀏覽／加購／開始結帳：`COUNT(DISTINCT visitor_id)`；送出訂單／完成付款：
  `COUNT(DISTINCT order_id)`——**不用事件總次數假裝人數**。
- `sources`/`campaigns` 每一列的 `ad_revenue` 是「該來源／該活動對應 purchase 訂單
  的 `orders.total` 加總」，`revenue.last_touch`/`revenue.first_touch` 則是排除
  `direct`/`unknown` 後的「廣告營收」總額（給 ROAS 卡片用）。
- Last Touch 用 `analytics_events.source`/`campaign` 欄位；First Touch 解析
  `metadata_json.first_touch`，解析失敗或缺欄位一律視為沒有 first_touch 資料，
  不會讓 API 500。
- 完全沒有 first_touch 資料時，`first_touch_available:false`，前端顯示「First Touch
  資料自 Hotfix23-D 上線後開始累積」。
- 分母為 0 一律回傳 `null`（前端顯示 `—`），不會出現 `NaN`/`Infinity`。
- 前端 Last/First Touch 切換純粹重新 render `by_mode` 裡已經有的資料，**不會再打
  一次 API**。
- 全部查詢都帶 `store_id`；同一批 6 個階段各自一次 SQL group-by（camp,src），
  沒有逐來源／逐 campaign 各打一次查詢（不是 N+1）。

---

## 8. 廣告營收定義

**只能來自** `purchase` 事件對應的 `order_id` → `orders.total`。明確**不使用**：
Hotfix23-C 的今日預估營收、購物車估計金額、`payment_started`（尚未成交）。
廣告花費／ROAS 本版本沒有串接 Meta/Google 花費 API，Dashboard 如實顯示
「尚未串接」，不偽造任何數字。

---

## 9. Purchase 去重

- **後端**：沿用 Hotfix23-A 既有的 `hasEventForOrder()` 查重 + `analytics_events` 的
  partial unique index（`store_id, order_id, event_name` where event_name in
  submit_order/purchase），本次沒有新建。
- **前端 Pixel／GA4**：新增 `_firePurchaseOnce()`，用 localStorage 記錄
  「這個 store + 這張訂單已經觸發過 Purchase」，重整成功頁或使用者重新整理
  LINE Pay 導回頁不會重複計算。line-order 與 line-shipping 用不同 key 前綴。

---

## 10. Store Isolation

- `analytics_events`／`orders` 所有查詢都帶 `store_id`（沿用既有 middleware `requireStore`）。
- `analytics_attribution_${store_id}` localStorage key 本身就含 store_id，不同店家
  的歸因資料在同一瀏覽器裡完全分開。
- 設定（Meta Pixel／GA4）透過既有 `settings` 表 `WHERE store_id=?`，沒有共用。

---

## 11. E2E 測試結果（本地模擬，邏輯層級）

| 案例 | 結果 |
|---|---|
| KPI 上一期間比較（今日 vs 昨日） | ✅ 通過（見 Hotfix23-C 測試，本次沒有動這段邏輯） |
| `getAdsAttribution()` 來源/活動漏斗 + 廣告營收（fake DB 單元測試） | ✅ 數字正確、first_touch/last_touch 一致 |
| KPI/健康度/health_score_v2（Hotfix23-C 既有邏輯回歸） | ✅ 沒有受影響（本次未修改對應函式） |
| `node --check` 全部後端檔案 | ✅ 全部通過 |
| `node --check` 抽取的 line-order.html / line-shipping.html inline script | ✅ 全部通過 |
| index.html / line-order.html / line-shipping.html div 開合數 | ✅ 相等 |
| 新增 DOM id 是否重複 | ✅ 無重複 |
| `_trackEvent`/`_deriveSource`/`_getAnalyticsContext`/`_analyticsPayloadForOrder`/`_firePurchaseOnce` 是否每頁各只定義一次 | ✅ 是 |
| Purchase 去重 index 是否重複建立 | ✅ 沿用既有 index，沒有重建 |

**未在本沙盒完成的部分**：真正的瀏覽器端 E2E（實際點擊 UTM 連結、真的呼叫 Meta/GA4
SDK、真的用 LINE Pay 沙盒付款）需要有實際部署環境與 Meta/Google 測試帳號才能執行，
建議上線前用 Meta Pixel Helper／GA4 DebugView 實測一次本 changelog 第八節列出的
測試項目。

---

## 12. 已知限制

1. **只支援固定的來源分類**：`normalizeTrafficSource()` 對於 `utm_source` 不在既定
   別名清單內時，會原樣保留該字串（而不是全部歸類 `unknown`），Dashboard 來源表
   可能因此出現店家自訂的來源名稱，這是設計上刻意的行為（保留原始資訊，而非
   丟失資料），但也代表來源表的列數不是固定的 8 種。
2. **Campaign 表的活動名稱完全依賴 `utm_campaign` 字串**，同一個活動如果打
   UTM 時打錯字（例如一次 `test_campaign` 一次 `test-campaign`）會被當成兩個
   不同活動，本版本沒有活動名稱正規化或合併機制。
3. **今日預估營收（Hotfix23-C）明確沒有拿來計算廣告營收**，兩者是獨立欄位。
4. **/api/line-orders/query 用 order_number 查詢時目前不需要驗證電話**（這是
   Hotfix23-D 之前就存在的既有行為，本次沿用作為 LINE Pay 導回頁取得權威金額的
   資料來源，沒有新增或擴大這個既有的公開查詢範圍）。

---

## 13. 未實作項目（依需求文件明確排除，留待後續版本）

- Meta Conversion API（伺服器對伺服器回傳）
- 真正的廣告花費同步（Meta Marketing API／Google Ads API）與完整 ROAS
- LTV（顧客終身價值）
- 自動寄信催單／LINE OA 自動推播／自動發優惠券／購物車放棄提醒
- 廣告自動投放、AI 自動修改廣告、AI 自動經營建議／每日推播摘要

---

## 14. 回退方式

本次全部改動都是「附加」性質（新增欄位、新增函式、新增檔案），沒有刪除或
覆蓋既有邏輯：

- 若要整體回退到 Hotfix23-C：還原以下檔案到 Hotfix23-C 版本即可：
  `utils/db.js`、`utils/analyticsLog.js`、`utils/dashboardAnalytics.js`、
  `routes/analytics.js`、`routes/settings.js`、`routes/line-orders.js`、
  `routes/line-shipping.js`、`routes/linepay.js`、`public/index.html`、
  `public/js/app.js`、`public/line-order.html`、`public/line-shipping.html`；
  刪除 `public/js/analytics-attribution.js`、`public/js/analytics-platforms.js`。
- 若只要關閉 Meta Pixel／GA4（不用回退程式碼）：到「系統設定 → 📣 廣告追蹤」
  關閉兩個開關即可，前台完全不會載入任何第三方 script。
- 兩個新增索引（`idx_analytics_store_source_created`／
  `idx_analytics_store_campaign_created`）即使回退程式碼也不需要特別移除，
  留著不影響任何既有查詢。
