# CHANGELOG — POS Web Online

## pos-v18-web-online-r1（2026-05-29）

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
