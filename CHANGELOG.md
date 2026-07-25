# CHANGELOG — POS Web Online

## fix18-10-hotfix30-B5-R5.2-B1-2（2026-07-25）

Geo Intelligence 行政區排行榜 + 區域 Funnel + Drill Down。基準版本：`fix18-10-hotfix30-B5-R5.2-B1-1`。

### New

- 行政區排行榜（Dashboard「Geo Intelligence」區塊內新增，欄位：行政區／訪客／加入購物車／開始結帳／完成訂單／成交率，資料全部沿用既有 `/overview` `/funnel` `/county-summary`，不重新查 SQL、不建新 API）
- 縣市／行政區雙層篩選（資料來源 `/administrative-areas`；縣市變更會自動清除不相容的行政區篩選）
- 排序（訪客／加入購物車／開始結帳／完成訂單／成交率，升冪／降冪；Unknown 永遠排最後，不受排序方向影響）
- 搜尋（依行政區名稱子字串比對，純前端，不重新 fetch）
- 分頁（>20 筆時顯示上一頁／下一頁，純前端切片已載入的 `funnel.areas`）
- 行政區 Funnel 展開／收合（每列可展開看訪客→加購→結帳→完成訂單四步驟，用已載入資料，不重新 request）
- 行政區 Drawer（Drill Down：點擊行政區開啟側邊詳情，含訪客數據、Geo Quality、對應 Recommended Actions，同樣不重新 request）
- Dashboard KPI／Top3／Recommended Actions 同步（切換縣市／行政區會觸發同一次 `loadGeoDashboardData()` 重新載入，KPI、Top 3、排行榜、建議一起更新，不維護第二份資料）
- Admin Areas Cache（依 county_code 快取行政區清單；store 切換或 county_code 改變才重新抓取）
- `_geoExposeWindowState()`：把 Dashboard Geo 區塊的內部狀態（篩選、排行榜排序狀態、快取、最近一次載入結果）明確掛到 `window` 上，供除錯與測試觀察（沿用既有 `window.__geoDashboardLegacyDisabled` 的模式）

### Fixed

- **API Response Contract Bug**：`/county-summary`、`/administrative-areas`、`/available-areas` 回傳的是 raw `{ok:true, ...}`，不是其他 Geo API 用的 `{success:true, data:{...}}`。B1-1 原本用同一套 `readJson()` 解析全部端點，導致 `county-summary` 在真的接正式後端時無論成功與否都會被誤判為失敗（`county_partial` 永遠是 true）。新增 `readOkJson()` 專門解析這三支端點，`readJson()` 維持給 `/overview` `/funnel` `/alerts` 用
- `loadGeoDashboardData()`：`county-summary` 改為允許局部失敗（只有 `/overview` `/funnel` 是必要 API），失敗時只讓「行政區排行榜」與「外送成交 Top 3」顯示暫時無法載入，KPI／其餘 Top 3 仍正常
- `_geoFilterAreasBySearch(null, ...)` 原本會直接丟出 TypeError（沒有防呆 null 陣列），修正為安全回傳空陣列
- Drawer「建議動作」原本用 city 或 district 任一相符就算數（OR），導致同一縣市底下所有行政區的 Drawer 互相顯示到不相關的 alert；改成要求 city 與 district「同時」相符
- Drawer 的 dialog wrapper 補上 `geo-drawer` class（配合既有 a11y 規則：只有背景遮罩／dialog wrapper 這類非互動控制項的 `<div onclick>` 允許不進 Tab 順序）

### Tests

```
B1-2 Smoke   150/150 PASS
B1-1 Smoke   100/100 PASS（回歸驗證，含 Response Parser 修正後）
Stage 7      140/140 PASS
Stage 8       90/90  PASS
Stage 9       62/62  PASS
Stage 10     230/230 PASS
R5.1-A        76/76  PASS
R5.1-B       111/111 PASS
R5.1-C       196/196 PASS（新增 8 endpoint 上限與 drawer class 對應調整後）
R5.1-D1      164/164 PASS
Dashboard UI  20/20  PASS
0 new regressions
```

### Known Limitations（本輪未做，留給後續）

- 尚無 Cart Attribution 詳情頁、Source/Campaign 詳情頁
- 尚無地圖（Leaflet／Heatmap／Marker／Polygon）
- 尚無 AI 分析／ROI 地圖預測

## fix18-10-hotfix30-B5-R5.2-B1-1（2026-07-25）

Geo Intelligence Dashboard API 換線。基準版本：`fix18-10-hotfix30-B5-R5.2-A-RC1`。

### Changed

- `renderDashboardGeoIntelligence()` 的 KPI／Geo Quality／Top 3 區塊換線到統一 Geo Analytics API（`/overview` `/funnel` `/alerts` `/county-summary`），不再以 `data.geo_summary` 驅動任何數字
- 新增 Geo Dashboard API Client（`getGeoOverview` / `getGeoFunnel` / `getGeoAlerts` / `getGeoCountySummary`）、AbortController、聚合載入 `loadGeoDashboardData()`
- 舊 `getGeoDashboardSummary()` 與 `data.geo_summary` 欄位保留（標記 `@deprecated`），不刪除，避免其他既有呼叫端受影響

### Tests

```
B1-1 Smoke   100/100 PASS
Stage 7      140/140 PASS
Stage 8       90/90  PASS
Stage 9       62/62  PASS
Stage 10     230/230 PASS
R5.1-A        76/76  PASS
R5.1-B       111/111 PASS
R5.1-C       195/195 PASS
R5.1-D1      164/164 PASS
0 new regressions
```

## fix18-10-hotfix30-B5-R5.2-A-RC1（2026-07-25）

Release Candidate 1 — Taiwan Administrative Area Intelligence 正式封版。

### New

- Taiwan Administrative Dataset（22 縣市／368 鄉鎮市區，含 manifest 與 SHA-256 checksum）
- County/Subdivision Normalization（`normalizeCounty()` / `normalizeSubdivision()` / `resolveTaiwanAdministrativeArea()`，含台/臺別名、離島覆蓋）
- Unified Area Enrichment（`resolveStoredArea()` × `_enrichAreaFields()`，acquisition/fulfillment context 完全隔離）
- Overview Area Filtering（county/subdivision 篩選真正影響全部 KPI，非只篩 top_areas）
- Funnel Area Filtering
- Fulfillment Geo Analytics（履約行政區獨立於 Visitor IP Geo）
- County Summary API（`GET /api/analytics/geo/county-summary`）
- Administrative Areas / Available Areas API
- Mixed Context Alerts（acquisition + fulfillment 同時存在、互不覆蓋）
- Order Fulfillment Geo Write（`routes/line-orders.js` 外送、`routes/line-shipping.js` 宅配）
- Business Area Reserved Columns（`business_area_code` / `business_area_name`，nullable，本輪僅保留欄位，未啟用）
- Privacy Scan（遞迴掃描所有 Geo API response，確認無 raw IP／完整地址／電話／secret）
- Store Isolation（`/overview` / `/funnel` / `/fulfillment` / `/alerts` / `/county-summary` 皆已驗證跨店隔離）
- Legacy Compatibility（read-time normalization，舊事件無官方代碼時仍可正確解析）

詳見 `docs/R5.2-A-completion.md`、`docs/RC1-release-notes.md`。

### Tests

```
Stage 7    140/140 PASS
Stage 8     90/90  PASS
Stage 9     62/62  PASS
Stage 10   230/230 PASS

R5.1-A、R5.1-B（111/111）、R5.1-C、R5.1-D1（164/164）
13 suites PASS
0 new regressions
```

### Known Limitations

- `routes/orders.js` / `routes/sync.js` 未寫入履約行政區代碼（僅有原始地址字串／第三方 payload，本輪不猜測地址）
- Business Area 欄位僅保留（reserved），尚未啟用任何 writer/reader/API/UI
- 無明確多語句 transaction 包裹訂單建立
- `orders.items` 為 JSON blob，非獨立資料表
- 郵遞區號輔助解析：NOT IMPLEMENTED
- 地圖視覺化：尚未實作（規劃於 R5.2-B）

---



### 新增
- 雲端授權系統（`routes/license.js`）
- 店家授權管理後台 UI（設定 → 🔑 店家授權 Tab）
- License API（6 個端點：GET/POST/PUT/DELETE）
- API 功能權限阻擋（`middleware/licenseGuard.js`）
  - `/api/inventory` — 需要 `inventory` 授權
  - `/api/ingredients` — 需要 `inventory` 授權
  - `/api/line-orders` / `/api/line-shop` / `/api/line-menu` — 需要 `line_order` 授權
  - `/api/online-orders` — 需要 `line_order` 授權
- 未授權功能一律回傳 HTTP 403

### 修正
- `GET /api/license/plans/defaults` 路由移至 `GET /api/license/:storeId` 之前，避免被動態路由攔截
- `licenseGuard.js` 新增 `ensureLicenseTable`，確保第一次啟動即使未進入授權管理頁，licenses 表也已建立，不會導致 API 崩潰
- 未授權功能回傳標準 403 JSON（`{ success:false, message:"此功能尚未開通…" }`）

### 保留原有功能
- 點餐 / 訂單 / 商品 / 分類 / 出單 / 營收 / LINE 點餐 / 庫存 / 外送 / 食材管理

---

## 方案功能對照

| 功能 | Basic | Pro | Enterprise |
|------|-------|-----|-----------|
| 點餐/訂單/商品/出單/營收 | ✅ | ✅ | ✅ |
| 庫存管理 | ❌ | ✅ | ✅ |
| LINE 點餐 | ❌ | ✅ | ✅ |
| 外送整合 | ❌ | ✅ | ✅ |
| 標籤列印 | ❌ | ✅ | ✅ |
| 行銷/會員/優惠券 | ❌ | ❌ | ✅ |

---

版本：**pos-v18-web-online-r1**

## fix16k-02 (2025-06) — 付款方式 seed 根本修正

### 問題
新建店家（如 store_02）的付款方式頁面顯示「初始化失敗」，結帳頁無付款選項。

### 根本原因（兩處）
1. `payment-methods.js` 的 `ensureDefaultPaymentMethods()` 使用 `db._db.exec(sql, params)` 查詢，
   此呼叫在部分環境下不正確，改用 `db.get(sql, params)` wrapper 介面
2. `utils/db.js` 的 `pmDb.run()` 未呼叫 `_save()`，導致 INSERT 在某些路徑不持久化
3. `superAdmin.js` 新建店家時未先呼叫 `ensurePaymentMethodsSchema()`

### 修正
- `routes/payment-methods.js`: checkSql 改用 `db.get()`, INSERT 改用 `db.run()`
- `utils/db.js`: pmDb.run() 加上 `w._save()`
- `routes/superAdmin.js`: 新建店家時先 `ensurePaymentMethodsSchema()` 再 seed
- 啟動時 fix16k-02 backfill 掃描所有 stores（含 store_002 等後建店家）
