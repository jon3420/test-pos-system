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
