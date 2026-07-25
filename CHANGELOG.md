# CHANGELOG — POS Web Online

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
