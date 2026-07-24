# CHANGELOG — fix18-10-hotfix30-B5-R5.1-B
## Geo Event Wiring × Geo Analytics API × Data Quality

---

## 一、版本基底

實際基底是 `pos-web-hotfix30-b5-r5-1-a-geo-foundation.zip`，也就是
**hotfix31-R4.1 + R5.1-A**，**不是**需求文件字面上提到的舊
`fix18-10-hotfix30-B5-R5` 分支（該落差已在 R5.1-A changelog 記錄過，本輪延續
同一個決定，不重新討論）。

本輪**沒有回退**下列 R1～R4.1 已完成的功能，全程只用既有模組、沒有重寫：

- Identity Resolver（`utils/analyticsIdentity.js` `resolveCanonicalVisitor()`）
- Channel Resolver（`utils/channelResolver.js`）
- Visitor 360（`utils/visitor360.js`）
- Cart Detail Explorer（`utils/cartSnapshot.js`、`public/js/analytics-v2.js`）
- Customer Journey / CRM（`utils/crmActions.js`、`routes/crm.js`）
- R4.1 UI fixes（`public/*`，本輪除 `public/line-order.html` 一處 additive
  欄位新增外，完全未觸碰）

---

## 二、本輪完成範圍

**已完成**：

- Geo Event Wiring（Visitor / Fulfillment / Shipping 三條路徑全部接線）
- Google Maps 結構化地址整理（`routes/maps.js`）
- Geo Analytics Queries（`utils/geoAnalyticsQueries.js`，8 個查詢函式）
- Geo Analytics API（`routes/analytics-geo.js`，7 條 endpoint）
- Geo Quality（`getGeoQuality()`）
- Geo Alerts（`utils/geoAlertRules.js` + `getGeoAlerts()`）
- Dashboard `geo_summary`（`GET /api/analytics/dashboard`）
- 前端 `calculate-fee` 追蹤欄位接線（`public/line-order.html`，additive-only）
- 測試（R5.1-A 更新版 76 項 + R5.1-B 新增 111 項 + Stage 18-F 稽核腳本 11 項，
  執行後即刪除，結果記錄於本文件）
- Privacy / Store Isolation 最終稽核

**明確未開始**（依需求文件，本輪範圍外）：

- R5.1-C UI（老闆儀表板 Geo Summary 卡片、營運分析 Geo 分頁）— 未開始
- 行政區地圖 — 未開始
- 正式 IP Geo Provider 串接 — 未開始，`GEO_VISITOR_IP_ENABLED` 維持預設 `false`

---

## 三、新增檔案

| 檔案 | 用途 |
|---|---|
| `routes/analytics-geo.js` | Geo Analytics API 7 條 endpoint |
| `utils/geoAnalyticsQueries.js` | Geo 查詢層：overview/funnel/fulfillment/distance/source-area/alerts/quality/dashboard-summary |
| `utils/geoAnalyticsFilters.js` | 共用 filter parser（`parseGeoAnalyticsFilters`）、enum 白名單、`SORT_COLUMNS` 固定映射 |
| `utils/geoAlertRules.js` | 集中解析 `GEO_ALERT_*` env，非法值 fail-safe |
| `scripts/smoke-hotfix30-b5-r5-1-b-geo-api.js` | 本輪新測試，111 項 |
| `CHANGELOG_HOTFIX30_B5_R5_1_B_GEO_API.md` | 本檔案 |

（R5.1-A 已建立的 `utils/geoConstants.js`／`geoResolver.js`／`geoSanitizer.js`／
`geoFeatureFlags.js` 本輪是**修改**，不是新增，見下表。）

## 四、修改檔案

| 檔案 | 本輪改動摘要 |
|---|---|
| `server.js` | 新增 `app.set('trust proxy', computeTrustProxySetting(process.env.TRUST_PROXY))`；掛載 `/api/analytics/geo` |
| `routes/analytics.js` | `POST /events` 改 async 並接上 cached Visitor Geo；新增 4 個 delivery geo 事件到 `SERVER_ONLY_EVENTS`；`GET /dashboard` 新增 `geo_summary`（fail-open） |
| `routes/delivery.js` | `/calculate-fee` 接上 `delivery_address_resolved`／`delivery_fee_calculated`／`delivery_out_of_range`／`delivery_geo_failed` 四個事件；新增 sha256 短 TTL 去重；新增可選 `visitor_id`/`session_id`/`cart_id`/`delivery_address` 欄位 |
| `routes/maps.js` | `/geocode`、`/reverse-geocode` 新增安全整理過的 `geo` 區塊（country/region/city/district/postal_code），`lat`/`lng`/`formatted_address` 完全保留不變 |
| `routes/line-orders.js` | 外送訂單建立時計算 `fulfillment_geo_*` 並寫入 `orders`；`submit_order`/`purchase` evtBase 帶上 `buildFulfillmentEventGeo()` |
| `routes/line-shipping.js` | 宅配訂單直接用既有結構化 `shipping_city`/`shipping_district` 產生 high-confidence geo，同樣寫入 `orders.fulfillment_geo_*` 與 evtBase |
| `utils/db.js` | 新增 `geo_context`/`geo_version` 欄位與索引（safe migration，additive） |
| `utils/geoConstants.js` | 新增 `GEO_CONTEXT`、`GEO_VERSION_CURRENT`、`DISTANCE_ALLOWED_CONTEXTS`、`normalizeGeoVersion()` |
| `utils/geoResolver.js` | `resolveVisitorGeo()`/`normalizeDeliveryGeo()` 加上 `geo_context`；新增 `resolveVisitorGeoCached()`（TTL+雜湊 key）、`buildFulfillmentEventGeo()`；修正 Google component 優先序（見七） |
| `utils/geoSanitizer.js` | 重寫 IP 信任模型：`computeTrustProxySetting()`、`GEO_TRUSTED_IP_HEADER` 明確 opt-in、優先用 `req.ip`/`req.ips` |
| `utils/analyticsLog.js` | `_sanitizeGeoForWrite()` 新增 `geo_context`/`geo_version` 驗證與距離欄位強制清空規則；`EVENT_WHITELIST` 新增 4 個 delivery geo 事件；INSERT 語句補上兩個新欄位 |
| `public/line-order.html` | `fetchDeliveryFee()` 的 request body 新增 4 個可選欄位（純 additive） |
| `scripts/smoke-hotfix30-b5-r5-1-a-geo-foundation.js` | 更新 2 組測試固定資料以符合本輪的 intentional contract correction（見二十七） |

---

## 五、Geo Schema 補強

新增 `analytics_events.geo_context`（TEXT）與 `geo_version`（INTEGER）。

`geo_context` 允許值：`visitor` / `fulfillment` / `shipping` / `gps`（列舉保留，
本輪未實作來源） / `unknown`。

**`geo_source` 與 `geo_context`是兩個不同維度，絕不可混用**：

- `geo_source` = 這筆資料**怎麼來的**（`ip` / `delivery_address` /
  `shipping_address` / `gps` / `unknown`）
- `geo_context` = 這筆資料**代表什麼用途**（進站推定 / 外送履約 / 宅配履約 /
  裝置定位 / 無法分類）

`geo_version` 目前恆為 `1`；R5.1-A 建立欄位時寫入的舊資料沒有這個欄位值
（NULL），讀取端一律用 `normalizeGeoVersion()` 將 NULL 正規化為 `1`，不強制
回填舊資料。

---

## 六、Trust Proxy 與來源 IP

- `TRUST_PROXY` 環境變數預設 `false`；**絕不**使用
  `app.set('trust proxy', true)`（會讓任意客戶端偽造的 `X-Forwarded-For`
  被全盤信任）。
- 合法值：`false`（預設）、`loopback`、`linklocal`、`uniquelocal`、
  或 0～10 的整數（代理層數）。
- 非法值（包含裸的 `'true'`）一律 fail-safe 退回 `false`，不讓應用啟動失敗。
- `GEO_TRUSTED_IP_HEADER`：部署商保證「這個 header 一定是反向代理寫的」時才
  設定（例如 Cloudflare 的 `cf-connecting-ip`）；**未設定時完全不讀取任何
  客戶端 header**。
- 來源 IP 解析優先序：`GEO_TRUSTED_IP_HEADER` 指定的 header → Express
  trust-proxy 處理過的 `req.ip`/`req.ips` → socket `remoteAddress`。

---

## 七、Visitor Geo Provider

- **正式 IP Geo Provider 尚未選定**（MaxMind GeoLite2 本地庫／Cloudflare
  location header／經審核的商用 API，三個方向都還沒決定）。
- `GEO_VISITOR_IP_ENABLED` 正式環境預設 `false`；在明確選定 provider 並完成
  安全審查前，**不應該**開啟。
- 目前正式環境下，所有 Visitor Geo 一律是 `geo_source=unknown`——這是預期
  行為，不是 bug。
- 測試中使用的 provider（透過 `setIpGeoProvider()` 注入）僅供本次測試環境
  驗證管線正確性，**不是**任何形式的正式串接。

---

## 八、Google Structured Address

`routes/maps.js` 的 `/geocode`、`/reverse-geocode` 新增 `geo` 區塊：

```json
{ "lat": 0, "lng": 0, "formatted_address": "", "geo": { "country": "", "region": "", "city": "", "district": "", "postal_code": "" } }
```

`lat`/`lng`/`formatted_address` 完全保留、不變動既有 response contract。
`address_components` 原始陣列不整包回傳。

台灣行政區 component 優先序（`utils/geoResolver.js` `normalizeDeliveryGeo()`
與 `routes/maps.js` `extractSafeGeoComponents()` 一致）：

- district：`administrative_area_level_3` → `sublocality_level_1` → `sublocality`
- city：`administrative_area_level_2` → `locality`
- region：`administrative_area_level_1`

**這比 R5.1-A 版本的規則做了修正**：R5.1-A 曾把 `administrative_area_level_2`
也當作 district 候選，本輪依 Google 官方慣例（level_2 在台灣通常對應縣市，
level_3 才是鄉鎮市區）改為上述優先序。這是本輪**刻意的行為修正**，見
二十七的說明。

---

## 九、事件接線

| 事件 | 實際名稱 | 寫入時機 | Geo context |
|---|---|---|---|
| 進站 | `page_view` | 前台 `POST /api/analytics/events` | visitor |
| 商品瀏覽 | **`view_product`**（不是 `view_item`） | 前台 | visitor |
| 加入購物車 | `add_to_cart` | 前台 | visitor |
| 開始結帳 | `begin_checkout` | 前台 | visitor |
| 送出訂單 | `submit_order` | 後端訂單建立成功時（`routes/line-orders.js`／`routes/line-shipping.js`） | fulfillment/shipping/unknown |
| 完成付款 | `purchase` | 非 LINE Pay 訂單於建立當下立即寫入；LINE Pay 訂單於 `routes/linepay.js` `/confirm` 成功時寫入 | fulfillment/shipping/unknown |
| 外送地址解析 | `delivery_address_resolved` | `routes/delivery.js` `/calculate-fee`，僅在能解析出 city/district 時 | fulfillment |
| 外送費計算 | `delivery_fee_calculated` | 同上，距離與費用計算成功時 | fulfillment |
| 超出配送範圍 | `delivery_out_of_range` | 同上，兩個 out-of-range 分支（超過 `delivery_max_distance_km` 或超過距離級距設定） | fulfillment |
| 地址/距離解析失敗 | `delivery_geo_failed` | 同上，Google Routes API 呼叫失敗時 | 無 geo（buildFulfillmentEventGeo(null)） |

**重要澄清**：`submit_order` 與 `purchase` 是兩個獨立事件，不是同一件事的兩個
標籤——`submit_order` 代表「訂單已建立」，`purchase` 才代表「已完成付款」。
本專案沒有另外的 `submit_order_success` 事件。

所有事件寫入都是 fail-open：`insertEvent()`/`logServerEvent()` 內部
try/catch，Geo 解析失敗絕不阻擋事件寫入，事件寫入失敗絕不阻擋訂單/外送費
流程本身。

---

## 十、Visitor Geo Attribution

規則（`utils/geoAnalyticsQueries.js` `_visitorGeoAttributionCTE()`）：**同一
store + 同一 canonical visitor（`identity_key`）+ 同一分析期間，取最早一筆
「有 city 或 district」的 `geo_context='visitor'` 事件，作為這個人在本次
查詢期間的代表區域**，用來補回同一人後續沒有 Geo 的事件（例如 `page_view`
有 Geo、後續 `view_product`/`add_to_cart` 因為 cache 或 provider 暫時失敗而
沒有 Geo）。

**絕不用 `fulfillment`/`shipping` Geo 回填 Visitor Funnel**——兩個 CTE
（`visitor_geo_attributed` vs. 履約訂單查詢）完全獨立，資料來源沒有交集。

採用 SQL 端一次性 CTE + JOIN，而不是 Node.js 逐筆呼叫 JS resolver 的原因：
Identity Resolver（`utils/analyticsIdentity.js`）是寫入時就已經算好存進
`identity_key` 欄位的值，讀取端不需要（也不應該）重新呼叫 JS resolver
逐筆判斷——直接對已存在的 `identity_key` 做 SQL 聚合即可，避免 N+1。

---

## 十一、外送訂單 Geo

`orders.fulfillment_geo_*`（`fulfillment_geo_city`/`_district`/`_source`/
`_confidence`/`_resolution`/`fulfillment_distance_band`）在訂單建立時由
`routes/line-orders.js` 寫入：外送訂單用 `normalizeDeliveryGeo()` 解析
`delivery_address` 字串（見已知限制），外帶訂單一律保持 `NULL`，不寫假
履約區域。`submit_order`/`purchase` 事件的 evtBase 帶上同一組
`buildFulfillmentEventGeo()` 結果，`geo_context=fulfillment`。

---

## 十二、宅配訂單 Geo

`routes/line-shipping.js` 直接使用既有的結構化 `shipping_city`/
`shipping_district`（前端下拉選單填入，不是自由文字），因此
`geo_confidence=high`、`geo_resolution` 依是否有 district 決定，**沒有**
重新解析完整宅配地址字串。`geo_context=shipping`，與外送的
`geo_context=fulfillment` 明確區分。宅配沒有店家外送距離的概念（走貨運/
郵寄），因此 `geo_distance_km` 恆為 `NULL`。

---

## 十三、Delivery Events

四個事件全部只在 `routes/delivery.js` `/calculate-fee` 的對應分支寫入，見
上方九、事件接線表格。去重機制：`sha256(rounded_lat,rounded_lng)` + 30 秒
TTL 記憶體 cache（`_deliveryEventDedupCache`），完整地址/座標不落地、只用
四捨五入到小數點後 3 位（約 110 公尺精度）的座標算指紋。追蹤欄位
（`visitor_id`/`session_id`/`cart_id`/`delivery_address`）全部可選，缺少時
完全跳過事件寫入，不影響外送費計算本身。

---

## 十四、前端 Calculate Fee 接線

`public/line-order.html` 的 `fetchDeliveryFee()` 新增傳送
`visitor_id`/`session_id`/`cart_id`/`delivery_address`（用既有的
`_getVisitorId()`/`_getSessionId()`/`_getCartId()`/`#deliveryAddress` 欄位
取值）。全部是 **additive optional fields**：

- 不改變原本送出的 `order_mode`/`subtotal`/`delivery_lat`/`delivery_lng`。
- 不改變後端回應的任何既有欄位。
- 後端 `_optionalTrackingContext()` 在缺少 `visitor_id`/`session_id` 時直接
  回傳 `null`，呼叫端據此完全跳過事件寫入。

---

## 十五、Geo API

```
GET /api/analytics/geo/overview
GET /api/analytics/geo/funnel
GET /api/analytics/geo/fulfillment
GET /api/analytics/geo/distance
GET /api/analytics/geo/source-area
GET /api/analytics/geo/alerts
GET /api/analytics/geo/quality
```

掛載：`app.use('/api/analytics/geo', requireStore, require('./routes/analytics-geo'))`
（沿用 `routes/analytics.js` 同一組 `requireStore`）。每條 route 另外套用
`requireFeature('reports')`（與既有 `/api/analytics/cart-abandonment`、
`/drilldown`、`/visitor-360` 同一套保護，沒有另創新的權限系統）+ 本輪新增的
`requireGeoAnalyticsEnabled`（`GEO_ANALYTICS_ENABLED=false` 時回
`403 { success:false, error:"Geo Analytics is disabled" }`）。

`store_id` 一律來自 `req.storeId`；所有 7 條 route 都不接受
`req.query.store_id` 決定查詢商家（已用稽核腳本驗證，見二十六）。

---

## 十六、Filter 與 Pagination

`utils/geoAnalyticsFilters.js` `parseGeoAnalyticsFilters()` 支援：
`date_from`/`date_to`（內部轉呼叫 `resolveDateRange({preset:'custom',...})`，
沿用既有 Asia/Taipei 邏輯，不創造第二套時區口徑）、`channel`、`source`、
`medium`、`campaign`、`geo_context`、`geo_source`、`geo_confidence`、
`city`、`district`、`page`（最小 1）、`limit`（預設 50，最大 100）。

`geo_context`/`geo_source`/`geo_confidence` 走 `GEO_*_VALUES` 白名單，
非法值視為「未篩選」而非報錯。所有 SQL 一律參數化（`?`），沒有任何字串拼接
使用者輸入。`getGeoSourceArea()` 用真正的 SQL `LIMIT`/`OFFSET`，並用一條
額外的聚合 COUNT query 算 `total`（不是 Node.js 端 slice，也不是逐筆 N+1）。
排序欄位固定映射在 `SORT_COLUMNS`，目前 API 尚未開放自訂排序參數。

---

## 十七、Funnel 口徑

核心指標一律是 **unique visitor**（`COUNT(DISTINCT identity_key)`），不是
事件次數——同一訪客做 5 次 `add_to_cart` 只算一位（已用測試驗證）。

真實事件映射（`GEO_FUNNEL_EVENTS`，集中定義一次）：

```
visit: 'page_view', productView: 'view_product', cart: 'add_to_cart',
checkout: 'begin_checkout', submitOrder: 'submit_order', purchase: 'purchase'
```

---

## 十八、Fulfillment 口徑

主要資料來源是 `orders.fulfillment_geo_*`，**不是**從 Analytics 事件反推
訂單區域。排除規則沿用既有 `ORDERS_BASE_WHERE`（排除 `status='void'` 與
`order_status='cancelled'`）與 `ORDERS_PAID_EXPR`（`status IN
('completed','modified')` 才算「已付款」），完全沒有創造新的 revenue
定義。外帶訂單（`order_mode='takeout'`）不進區域排行，另外用
`takeout_no_fulfillment_address` 欄位單獨計數，不會被誤標成
`unknown district`。

---

## 十九、Distance Band

固定回傳 `0-3km`/`3-5km`/`5-8km`/`8-10km`/`10-15km`/`15km+`/`unknown` 七個
row，即使某段是 0 也一定出現。邊界值歸屬（左閉右開）：3.0km 落入
`3-5km`、5.0km 落入 `5-8km`、8.0km 落入 `8-10km`、10.0km 落入 `10-15km`、
15.0km 落入 `15km+`（已用邊界測試驗證）。目前集中在
`utils/geoConstants.js` `distanceBandFor()` 單一 helper，尚未提供商家自訂
UI（列為 Future Enhancement，見二十九）。

---

## 二十、Source × Area

維度分開回傳：`source`/`medium`/`campaign`/`channel`（訂單渠道）/`city`/
`district`，六者互相獨立。**`LINE OA` 這個 marketing source 跟 `line_*`
這個 order channel 是兩個完全不同的概念，本輪沒有把兩者合併**，沿用既有
`utils/channelResolver.js` 的 channel 定義。

---

## 二十一、Geo Quality

回傳 `total_events`/`identified_events`/`unknown_events`/`identified_rate`/
`high_count`/`medium_count`/`low_count`/`unknown_confidence_count`/對應
rate/`by_context`/`by_source`/`by_confidence`/`status`/`minimum_sample`。

狀態規則（集中在 `getGeoQuality()`，不散落在 route）：

```
total_events < 20（GEO_QUALITY_MIN_SAMPLE）→ insufficient_data
unknown_rate >= GEO_ALERT_UNKNOWN_RATE     → degraded
其餘                                        → healthy
```

`GEO_ANALYTICS_ENABLED=false` 時（Dashboard `geo_summary` 路徑）狀態為
`disabled`（Geo API 本身走 403，不會回傳 quality 物件）。

---

## 二十二、Geo Alerts

五種型別：`traffic_waste`/`checkout_drop`/`delivery_cost_risk`/
`out_of_range_demand`/`data_quality`。門檻 env（`utils/geoAlertRules.js`）：

```
GEO_ALERT_MIN_VISITORS=20    （最低 1，非法值 fallback 到 20）
GEO_ALERT_LOW_CART_RATE=0.10 （clamp 0~1）
GEO_ALERT_LOW_ORDER_RATE=0.02（clamp 0~1）
GEO_ALERT_UNKNOWN_RATE=0.40  （clamp 0~1）
```

文案一律使用「可能」「趨勢顯示」「建議檢查」，已用測試斷言訊息不含
「一定」「就是」「證明」等絕對因果字眼。

---

## 二十三、Dashboard Geo Summary

`GET /api/analytics/dashboard` 新增 `geo_summary`：

```json
{
  "top_intent_areas": [],
  "high_traffic_low_conversion": [],
  "fulfillment_summary": {},
  "data_quality": {}
}
```

`top_intent_areas`/`high_traffic_low_conversion` 最多各 3 筆。
`GEO_ANALYTICS_ENABLED=false` 時回安全空結構（`data_quality.status='disabled'`）。
Geo 查詢本身用 try/catch 包裹，失敗時回退到同一組安全空結構，**不會**讓
整支 Dashboard API 500（已用測試驗證：刻意讓 geo 計算拋出例外情境下
Dashboard 其餘欄位仍正常回傳）。原有 Dashboard response 欄位（`kpi`/
`range`/`funnel`/... 等）全部保留，只新增這一個欄位，沒有刪除或改名任何
既有欄位。

---

## 二十四、EXPLAIN QUERY PLAN

實際對 `getGeoFunnel`/`getGeoFulfillment`/`getGeoSourceArea`/`getGeoQuality`
的核心 SQL 執行 `EXPLAIN QUERY PLAN`（seeded 假資料，非空表）觀察到：

- Funnel 的事件查詢：`SEARCH analytics_events USING INDEX
  idx_analytics_store_identity (store_id=?)`（用到既有索引，非全表掃描；
  規劃器選了 identity 索引而非
  `idx_analytics_store_event_created`，兩者都能避免全表掃描，暫不視為
  問題，列為觀察項）。
- Fulfillment 的訂單查詢：`SEARCH orders USING INDEX
  idx_orders_store_created (store_id=? AND created_at>? AND
  created_at<?)` + `USE TEMP B-TREE FOR GROUP BY`（GROUP BY 用臨時
  B-tree 是預期行為，不是索引缺失）。
- Source-area 的事件查詢：`SEARCH analytics_events USING INDEX
  idx_analytics_store_source_created (store_id=?)` + `USE TEMP B-TREE
  FOR GROUP BY`。
- Quality 的計數查詢：`SEARCH analytics_events USING COVERING INDEX
  idx_analytics_store_event_created (store_id=? AND event_name=?)`
  （covering index，效率最好的情況）。

**結論**：四條查詢都命中既有索引，沒有全表掃描、沒有 N+1、沒有事件表 ×
訂單表的多對多膨脹 JOIN（履約分析直接讀 `orders.fulfillment_geo_*`，
`out_of_range_attempts` 走獨立的事件表聚合後用記憶體 Map 對應，不是 SQL
JOIN）。**沒有新增任何索引**——R5.1-A/B 已建立的索引組合已經足夠。

---

## 二十五、Privacy Audit

逐條實際檢查結果（非設計文件宣稱）：

| 項目 | 結果 |
|---|---|
| `analytics_events`/`orders` 的 geo 欄位是否含 IP | **否**——schema 稽核（`grep` 所有 `_geoColDefs`/`_geoContextColDefs`/`_orderGeoColDefs`）確認只有 country/region/city/district/postal_code/source/confidence/resolution/distance_km/distance_band/delivery_zone/context/version，無任何 ip 欄位 |
| DB 是否有任何 ip-like 欄位 | **否**——`PRAGMA table_info(analytics_events)` 逐欄檢查，無 |
| 完整地址/`formatted_address`/`lat`/`lng`/`place_id` 是否進入 Analytics | **否**——`buildFulfillmentEventGeo()` 白名單只放行 12 個 `geo_*` 欄位，測試驗證這些禁止欄位都不在白名單輸出裡 |
| Geo API 回應是否含 `ip`/`lat`/`lng`/`place_id`/`formatted_address` | **否**——smoke test 對 `/overview` 實際回應做字串掃描確認 |
| Delivery 事件 dedup 是否保存原始地址 | **否**——只存 `sha256(四捨五入到小數點後3位的座標)`，cache value 只是到期時間戳 |
| IP cache（`resolveVisitorGeoCached`）是否保存完整 IP | **否**——provider 只收到已截斷的 IP/CIDR（`/24`/`/48`），cache key 是 `sha256(storeId:sessionKey)`，cache value 是解析結果物件（country/region/city/confidence/resolution），本身也不含 IP |
| Provider 是否收到完整 IP | **否**——測試斷言 provider 收到的字串永遠不匹配 `^\d+\.\d+\.\d+\.\d+$`（即不是完整 IPv4） |
| API 錯誤是否洩漏 stack/SQL/檔案路徑 | **否**——`_safeHandler()` 統一 catch，只回 `{success:false, error:'無法讀取區域分析資料'}`，測試對回應內容做過 `.js:`/`at Object.` 字串掃描確認不含 stack trace 特徵 |

**Delivery 計算例外的界線**：`routes/delivery.js`/`routes/line-orders.js`
在計算外送費/距離的當下，確實會使用 `delivery_address`/`delivery_lat`/
`delivery_lng`/`formatted_address`（這是完成當次履約計算所必須的），但這些
原始值**不會**被傳進 `insertEvent()`/`logServerEvent()` 的 `geo` 參數——
只有 `normalizeDeliveryGeo()`/`buildFulfillmentEventGeo()` 處理過的安全
摘要（縣市/區/信心/距離帶）會進入 Analytics/Geo API/Dashboard/Alert。

**一個超出本輪範圍、但誠實記錄的既有觀察**：`server.js` 既有的 WebSocket
連線 log（`console.log('[WSS] 新連線 store=... ip=${ip}')`，R1 時期就存在）
會記錄完整連線 IP。這**不屬於** Geo Analytics pipeline（不寫入
`analytics_events`、不經過任何 Geo resolver、不影響本輪任何 API），本輪
沒有修改它，但為了誠實起見在此註記——上面「Privacy Audit」的結論範圍是
「Geo Analytics 相關的程式碼路徑」，不是「這個專案全部的 log 輸出」。

---

## 二十六、Store Isolation Audit

用一次性稽核腳本（執行後即刪除，不納入交付內容）驗證，對相同的
district/`visitor_id`/`cart_id`/`order_id`/`campaign`/distance band 值，
分別寫入兩家不同的店（`store_iso_A`/`store_iso_B`），確認以下 API 都不會
把兩家店的資料混在一起：

`overview`、`funnel`、`fulfillment`、`distance`、`source-area`、`alerts`、
`quality`、Dashboard `geo_summary`。全部 **11/11 通過**，包含
`req.query.store_id=其他商家` 對結果完全沒有影響（`req.storeId` 才是唯一
權威來源）。

---

## 二十七、測試結果

| 測試檔 | PASS | FAIL | MANUAL | exit code |
|---|---|---|---|---|
| `smoke-hotfix30-b5-r5-cart-order-hours.js` | 55/59 | 0 | 4 | 0 |
| `smoke-hotfix30-b5-r5-dashboard-ui.js` | 20/20 | 0 | 0 | 0 |
| `smoke-hotfix30-b5-r5-debounce.js` | 32/32 | 0 | 0 | 0 |
| `smoke-hotfix31-r4-channel-visitor360.js` | 116/116 | 0 | 0 | 0 |
| `smoke-hotfix31-r4-1-ui-fixes.js` | 80/81 | 0 | 1 | 0 |
| `smoke-hotfix30-b5-r5-1-a-geo-foundation.js`（更新版） | 76/76 | 0 | 0 | 0 |
| `smoke-hotfix30-b5-r5-1-b-geo-api.js`（本輪新增） | 111/111 | 0 | 0 | 0 |

**R5.1-A fixture 更新原因（intentional contract correction，不是「改測試
掩蓋 bug」）**：

1. **Trust proxy 安全修正**——R5.1-A 的測試直接假設
   `x-forwarded-for`/`cf-connecting-ip` header 存在就會被信任，這正是
   R5.1-B 要修正的不安全行為本身。修正後，未經
   `GEO_TRUSTED_IP_HEADER` 明確 opt-in 的 header 不再被信任，因此測試
   fixture 改為明確 opt-in 後才驗證，並新增一條驗證「未 opt-in 時 header
   不被信任」的測試（原本沒有這條反向測試）。
2. **Google district/city 優先序修正**——R5.1-A 版本把
   `administrative_area_level_2` 當作 district 候選之一，本輪依 Google
   官方慣例修正為 city（level_2）/district（level_3）分開（見八）。原本
   的 fixture 資料（用 `administrative_area_level_2` 標記「中壢區」等
   鄉鎮市區名稱）改用 `administrative_area_level_3`，語意才正確——這是
   **修正測試資料的欄位型別標記錯誤**，不是放寬驗證標準或刪除斷言（實際
   斷言內容、期望值完全沒變）。

兩處修正後，R5.1-A 測試從 74 項擴充到 76 項（新增的都是額外驗證，不是
刪除既有驗證），76/76 全數通過。

---

## 二十八、Manual Required

1. Zeabur 實際部署的反向代理層數確認，據此設定正確的 `TRUST_PROXY` 值
   （目前只驗證了程式邏輯正確，沒有實際部署環境可測）。
2. 正式 IP Geo Provider 選擇（MaxMind GeoLite2 本地庫／Cloudflare
   location header／經審核商用 API，三個方向都還沒決定）。
3. `GEO_VISITOR_IP_ENABLED` 正式環境是否開啟，需等 2. 決定後再評估。
4. Google `address_components` 正式環境實際回應格式確認（本輪邏輯依
   Google 官方文件撰寫，但沒有真實 `GOOGLE_MAPS_SERVER_KEY` 可在此環境
   測試live 呼叫）。
5. `public/line-order.html` `calculate-fee` 新增欄位後的瀏覽器實測（本輪
   只驗證了注入的 JS 語法正確與變數存在，沒有實際瀏覽器/實際下單流程
   測試）。
6. Geo API `requireFeature('reports')` 權限在瀏覽器/正式登入 session 下的
   實測（本輪用模擬 req 物件測試中介層邏輯，沒有實際 HTTP 全鏈路測試）。
7. Dashboard `geo_summary` 用正式營運資料呈現效果的實測（本輪用少量合成
   測試資料驗證邏輯正確性，未用真實店家資料量驗證）。

---

## 二十九、Known Limitations

- Visitor IP Geo Provider 尚未接：正式環境 Visitor Geo 會全部是
  `geo_source=unknown`，這是預期行為。
- Geo UI（老闆儀表板卡片、營運分析 Geo 分頁）尚未開始，本輪只有 API。
- 行政區地圖尚未開始。
- 距離帶（`0-3/3-5/5-8/8-10/10-15/15+`）尚未開放商家自訂 UI，集中在單一
  程式碼常數，未來若要開放需要改成 store setting。
- 宅配沒有距離分析（宅配走貨運/郵寄，沒有「店家到收件地址」的駕駛距離
  概念，`geo_distance_km` 恆為 NULL）。
- 歷史舊事件（R5.1-A 之前寫入的 `analytics_events`）不會自動擁有 Visitor
  Geo，一律讀取為 `geo_source=unknown`，沒有回填機制。
- `routes/delivery.js` 的 `delivery_address_resolved`/`delivery_fee_calculated`/
  `delivery_out_of_range`/`delivery_geo_failed` 事件雖然後端已完整接線，
  但前端 `calculate-fee` 呼叫目前只會傳 `visitor_id`/`session_id`/
  `cart_id`（本輪新增），實際能否解析出 `geo_city`/`geo_district` 取決於
  是否也傳了 `delivery_address`——目前前端傳的是使用者輸入框的即時值，
  尚未在瀏覽器環境驗證這個欄位在下單流程各階段都能正確取得非空值。
- Distance API 的 `address_resolved_events` 欄位目前恆為 0（見
  `utils/geoAnalyticsQueries.js` 內註解）：`delivery_address_resolved`
  事件的距離帶依賴同一次計算的 `distanceKm`，目前實作把這個計數放進
  `fee_calculation_events`（兩者理論上同時發生），`address_resolved_events`
  保留欄位但未填入獨立計數，避免重複計算造成混淆；未來如果两个事件的
  發生時機分岔（例如地址解析成功但距離計算失敗），需要重新設計這個欄位。

---

## 三十、R5.1-C 下一步（只列規劃，不開始實作）

- 老闆儀表板 Geo Summary UI 卡片
- 營運分析新增 Geo 分頁：
  - 區域總覽
  - Visitor Funnel
  - Fulfillment
  - Distance
  - Source × Area
  - Geo Quality
  - Geo Alerts
