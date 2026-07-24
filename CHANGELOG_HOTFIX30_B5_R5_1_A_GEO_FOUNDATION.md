# CHANGELOG — fix18-10-hotfix30-B5-R5.1-A
## Geo Intelligence × Area Funnel × Dashboard Summary — Geo Data Foundation

範圍：**只做 R5.1-A（Geo Data Foundation）**。未動 UI、未動 API endpoints（R5.1-B/C/D 未開始），依需求文件第二十一節分階段要求。

---

## 一、專案盤點（開發前必讀，決定了下面所有設計）

### 1. 基底版本落差（重要，需人工確認）

需求文件寫「以目前完成的 `fix18-10-hotfix30-B5-R5` 為基底開發」，但實際上傳的
專案 zip 是 `pos-web-hotfix31-r4-1-ui-fixes`，比 R5 **多了五輪**：
`hotfix31-R1`（Drill Down/Visitor 360/CRM 後端）、`R2`（身份解析歸戶到
`utils/analyticsIdentity.js`、CRM 動作生命週期）、`R3`（Cart Detail Explorer
前端）、`R4`（Channel 一致性修正 × Visitor 360 Audience × Customer Journey）、
`R4.1`（UI fixes）。

本輪決策：**以實際上傳的 R4.1 為基底**，理由：
- R4.1 是嚴格的 R5 之後的超集合（R1~R4.1 全部是加法、向後相容，各輪 changelog
  均註明「Boss Dashboard／既有 API response contract 未修改」）。
- 需求文件要求沿用的「channel resolver」「identity resolver」在 R4.1 中已經是
  唯一、正確版本（`utils/channelResolver.js` 的 SQL/JS 雙定義漂移已在 R4 修好；
  `utils/analyticsIdentity.js` 是 R2 起唯一的身份判斷入口）。若真的回退到 R5
  再重做 Geo，反而會疊加已知的 R4 bug（channel 誤分類）。

**若這個假設錯誤**（例如你手上實際要接的分支確實是舊的 R5，R1~R4.1 是另一條
未合併的分支），請告知，本輪的 schema/程式碼可以整批 cherry-pick 過去，但
`insertEvent()` 目前的 diff 是相對 R4.1 版本算的，需要重新核對行號。

### 2. 現有可沿用的基礎設施（確認「不建立第二套 Analytics」）

| 需求文件要求沿用的東西 | 實際檔案 | 狀態 |
|---|---|---|
| `analytics_events` | `utils/db.js`（hotfix23-A 建立） | 唯一事件表，繼續沿用 |
| `orders` | `utils/db.js`（ALTER TABLE 逐版擴充） | 唯一訂單表，繼續沿用 |
| channel resolver | `utils/channelResolver.js` | `resolveOrderChannel()` + `ORDER_CHANNEL_SQL_EXPR`，R4 才修好雙版本漂移 |
| identity resolver | `utils/analyticsIdentity.js` | `resolveCanonicalVisitor()`（R2 起唯一入口） |
| 事件寫入唯一出口 | `utils/analyticsLog.js` `insertEvent()` | 本輪選擇在這裡補 Geo 欄位，同一套慣例 |
| Google Maps 地址解析 | `routes/maps.js` `/geocode`、`/reverse-geocode` | 見下方「已知落差」 |
| 外送距離計算 | `routes/delivery.js`（Google Routes API `computeRoutes`） | 只回傳 `distance_km`，不含行政區 |

**結論：本輪沒有新增任何平行的事件表或第二套 Analytics。**Geo 是以擴充既有
`analytics_events` / `orders` 欄位的方式加入，不是新表。

### 3. 已知落差（R5.1-A 範圍內能處理的，跟需要另外決定的）

- **`app.set('trust proxy', ...)` 從未設定**（`server.js` 全文檢查過，沒有這行）。
  現有 `routes/line-member.js`、`routes/line-checkout-handoff.js` 已經有臨時的
  `req.headers['x-forwarded-for']` 讀取，但都沒有驗證來源、沒有 fallback 順序。
  本輪 `utils/geoSanitizer.js` 的 `getTrustedClientIp()` 是新的統一信任來源
  （`cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` 第一段 → socket
  remoteAddress），本輪只新增、不改動既有兩處的行為（避免動到 R1~R4.1 已驗證
  的 diagnostics 邏輯），但建議下一輪把那兩處改成呼叫這個共用函式。
- **`routes/maps.js` 的 `/geocode` 目前只回傳 `{ lat, lng, formatted_address }`**，
  沒有請求 Google 的 `address_components` 欄位，所以拿不到結構化的縣市/鄉鎮區。
  `utils/geoResolver.js` 的 `normalizeDeliveryGeo()` 因此做了兩層：優先吃
  `addressComponents`（未來 `maps.js` 補上後可直接用，會拿到 `confidence=high`
  / `resolution=district`）；沒有的話退化成從 `formatted_address` 字串用台灣
  地址慣例（OO縣市＋OO區鄉鎮市）粗略切，`confidence` 主動降到 `medium`，避免
  資料可信度虛報。**是否要改 `maps.js` 多要 `address_components` 欄位，建議
  排進 R5.1-B**（會影響 Google API 回應大小，屬於 API 設計決策，本輪不動）。
- **IP → 行政區 provider 尚未決定**。目前專案沒有任何 IP geolocation 套件、
  API key 或設定。本輪把整條管線（截斷 IP、隱私規則、unknown fallback、
  資料模型）做完，並提供 `setIpGeoProvider()` 插槽，但預設 provider 一律
  回傳 `null`（等同 `GEO_VISITOR_IP_ENABLED=false` 時的行為）。**要接哪一家
  服務（MaxMind GeoLite2 本地資料庫、廠商 API…）需要另外決定**，本輪不臆測。

---

## 二、新增檔案

- `utils/geoConstants.js` — `GEO_SOURCE` / `GEO_CONFIDENCE` / `GEO_RESOLUTION`
  列舉、`UNKNOWN_GEO` 安全預設值、`DISTANCE_BANDS` 距離帶定義與
  `distanceBandFor()`。
- `utils/geoFeatureFlags.js` — `GEO_ANALYTICS_ENABLED` / `GEO_VISITOR_IP_ENABLED`
  / `GEO_MAP_ENABLED` / `GEO_ALERTS_ENABLED`，env-based，預設值依需求文件
  十八（`GEO_VISITOR_IP_ENABLED` 與 `GEO_MAP_ENABLED` 預設關閉）。
- `utils/geoSanitizer.js` — `getTrustedClientIp()`、`truncateIpForResolution()`
  （IPv4 → /24、IPv6 → /48，只在單次請求內使用，不落地）、
  `sanitizeGeoForOutput()`（對外回應前強制剝除 `ip`/`lat`/`lng`/`full_address`
  等禁止欄位）。
- `utils/geoResolver.js` — `resolveVisitorGeo(req, flags)`（IP 推定，async，
  未開啟/無 provider 一律安全回傳 unknown）、`normalizeDeliveryGeo({...})`
  （正式地址解析，sync，見上方落差說明）、`setIpGeoProvider()` 插槽。
- `scripts/smoke-hotfix30-b5-r5-1-a-geo-foundation.js` — 74 項測試，全數通過
  （見下方「五、測試」）。
- 本檔案。

## 三、修改檔案

- `utils/db.js` — 在既有 hotfix24-A3 identity/channel 欄位遷移區塊之後，新增
  兩段 safe migration（同樣的 PRAGMA table_info 檢查 + ALTER TABLE ADD COLUMN
  慣例，絕不 DROP/重建）：
  - `analytics_events` 新增 11 個欄位：`geo_country` / `geo_region` /
    `geo_city` / `geo_district` / `geo_postal_code` / `geo_source` /
    `geo_confidence` / `geo_resolution` / `geo_distance_km` /
    `geo_distance_band` / `geo_delivery_zone`，加 3 個新索引
    （`(store_id,geo_district,created_at)` / `(store_id,geo_source,created_at)`
    / `(store_id,geo_distance_band,created_at)`）。
  - `orders` 新增 6 個欄位（履約區域，命名加 `fulfillment_` 前綴避免跟上面
    Visitor Geo 混淆）：`fulfillment_geo_city` / `fulfillment_geo_district` /
    `fulfillment_geo_source` / `fulfillment_geo_confidence` /
    `fulfillment_geo_resolution` / `fulfillment_distance_band`，加 1 個索引。
  - **決策記錄**：選擇「metadata/欄位擴充」而非新建
    `analytics_geo_dimensions` 平行表（需求文件十六允許兩者擇一）。理由見
    `db.js` 內的註解：這批欄位都是低基數字串，可直接沿用既有
    `(store_id, created_at)` 系列索引查詢模式，不需要額外 JOIN；且完全比照
    hotfix24-A3 identity/channel 欄位已驗證過的 safe-migration 慣例。
- `utils/analyticsLog.js` — `insertEvent()` 新增可選參數 `geo`（呼叫端已用
  `resolveVisitorGeo()`/`normalizeDeliveryGeo()` 算好的 plain 物件），內部用
  `_sanitizeGeoForWrite()` 防禦性清洗（只接受列舉允許值，其餘退回
  `unknown`/`null`）後寫入上述新欄位。**刻意維持 `insertEvent()` 同步**——
  IP/地址解析都可能是非同步外部呼叫，不能塞進這個既有、必須 fail-open 的
  同步函式；呼叫端（R5.1-B 會修改的 `routes/analytics.js`、
  `routes/delivery.js`、`routes/line-orders.js` 等）負責在呼叫前先 `await
  resolveVisitorGeo(req, flags)` 或同步呼叫 `normalizeDeliveryGeo()`。**未提供
  `geo` 參數時完全等同修改前的行為**（欄位落 NULL / `geo_source='unknown'`），
  對現有全部呼叫端零風險。

本輪**沒有修改**：`routes/*.js`（所有事件寫入呼叫點維持原樣，尚未接上
`geo` 參數——這是刻意的，R5.1-A 只做地基，接線在 R5.1-B）、`routes/maps.js`、
`routes/delivery.js`、任何前端檔案、`middleware/featureGate.js`（GEO_* 是部署層
env flag，跟這裡的 per-store license features 是不同機制，見
`utils/geoFeatureFlags.js` 內註解）。

## 四、隱私原則落實對照（第四節）

| 規則 | 落實方式 |
|---|---|
| IP 只在伺服器端短期解析 | `resolveVisitorGeo()` 只在函式執行期間持有原始 IP，回傳值不含 IP |
| 解析後只留行政區維度 | `truncateIpForResolution()` 傳給 provider 前就已截斷；回傳物件只有 country/region/city |
| 不寫入完整 IP 到 metadata | `insertEvent()` 新欄位裡沒有任何 ip 欄位；`_sanitizeGeoForWrite()` 只認得 `geo_*` 白名單欄位 |
| 不回傳完整 IP 給前端 | `sanitizeGeoForOutput()` 強制剝除 `ip`/`lat`/`lng`/`full_address` |
| 不信任任意客戶端 IP header | `getTrustedClientIp()` 只讀取專案已知的三個反向代理 header，且僅在 `GEO_VISITOR_IP_ENABLED=true` 時被呼叫 |
| 不得依店家地址/channel/referrer/瀏覽器語言猜測區域 | `UNKNOWN_GEO` 是所有 resolver 失敗時的唯一退回值；`normalizeDeliveryGeo()` 抓不到地址就整組回 unknown，不做任何猜測 |

## 五、測試

`scripts/smoke-hotfix30-b5-r5-1-a-geo-foundation.js`：**74/74 通過**。涵蓋
schema 存在性、feature flag 預設值、Visitor Geo（關閉/開啟無 provider/開啟有
provider 三種情境）、`getTrustedClientIp`/IP 截斷、Delivery Geo（成功/字串
fallback/失敗）、距離帶邊界、輸出層 sanitizer、`insertEvent()` 三種情境
（不帶 geo 的 regression、帶正式 delivery geo、帶惡意/非法列舉值的防禦性清洗）、
跨店隔離。

**回歸測試（第二十節要求）**：重新執行以下既有測試，全數維持 0 FAIL：

| 測試檔案 | 結果 |
|---|---|
| `smoke-hotfix30-b5-r5-cart-order-hours.js` | 59 項，55 PASS，0 FAIL，4 MANUAL |
| `smoke-hotfix30-b5-r5-dashboard-ui.js` | 20 項，20 PASS，0 FAIL |
| `smoke-hotfix30-b5-r5-debounce.js` | 32 項，32 PASS，0 FAIL |
| `smoke-hotfix31-r4-channel-visitor360.js` | 116 項，116 PASS，0 FAIL |
| `smoke-hotfix31-r4-1-ui-fixes.js` | 81 項，80 PASS，0 FAIL，1 MANUAL |

## 六、下一步（R5.1-B，本輪未做）

- 把 `routes/analytics.js`（一般前台事件）、`routes/delivery.js`、
  `routes/line-orders.js`、`routes/line-shipping.js` 接上
  `resolveVisitorGeo()` / `normalizeDeliveryGeo()`，實際把 `geo` 參數傳進
  `insertEvent()`（本輪只打好地基，尚未接線，所以目前所有寫入的 geo 欄位
  都還是 `unknown`，這是預期行為，不是 bug）。
- 決定 IP geolocation provider 並實作 `setIpGeoProvider()` 的真正 provider。
- 決定是否要讓 `routes/maps.js` 的 `/geocode` 多要 Google 的
  `address_components` 欄位。
- `GET /api/analytics/geo/*` 系列 endpoint（需求文件十五）。
