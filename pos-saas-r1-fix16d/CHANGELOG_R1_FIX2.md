# CHANGELOG_R1_FIX2 — POS v18 Web Online R1-Fix2

版本：**pos-v18-web-online-r1-fix2**
日期：2026-05-29
基於：pos-v18-web-online-r1-fix1

---

## 修正項目

### Fix 1：編輯按鈕無反應（根本原因修正）

**根因：**
`renderLicenseList()` 使用 template literal 產生 HTML，將 `store_id` 透過
`JSON.stringify()` 嵌入 `onclick="licenseEdit("default_store")"` 屬性中。
雙引號衝突導致 HTML parser 截斷 onclick，按鈕完全無效。

**修正（`public/license.js`）：**
- 移除 onclick 屬性，改用 `data-idx` attribute + `addEventListener` 事件委派
- `el.addEventListener('click', _licenseListClick)` 統一處理編輯/刪除
- `licenseEdit()` 改為接受 lic 物件（非字串），徹底避免引號問題
- Modal 改用 `document.createElement` + `appendChild`，不用 innerHTML 插入

### Fix 2：Web POS 不再自鎖功能

**問題：** r1-fix1 在 Web API 層加了授權 middleware，Basic 方案的 Web POS
無法使用庫存、食材、LINE 點餐等功能。

**修正（`server.js`）：**
- 移除 `/api/ingredients` 的 `requireFeature('inventory')` 保護
- 移除 `/api/inventory` 的 `requireFeature('inventory')` 保護
- 移除 `/api/line-shop` / `/api/line-orders` / `/api/line-menu` 的 `requireFeature('line_order')` 保護
- 移除 `/api/online-orders` 的 `requireFeature('line_order')` 保護
- 移除 importExport 的 ingredient 路徑授權 middleware
- Web POS 所有功能完整開放

### Fix 3：ADMIN_MODE 簡易管理員模式

**新增（`middleware/adminGuard.js`）：**
- `requireAdminMode` middleware：`ADMIN_MODE=true` 時通過，否則回傳 403

**修改（`routes/license.js`）：**
- POST / PUT / DELETE 加上 `requireAdminMode`
- GET 路由不受限（Android 查詢授權正常）

**新增（`server.js`）：**
- `GET /api/admin/status` → 回傳 `{ admin_mode: true/false }`

**修改（`public/license.js`）：**
- 啟動時呼叫 `/api/admin/status`
- `_adminMode=false` 時隱藏授權管理 Tab，阻擋 CRUD 操作

**修改（`public/index.html`）：**
- 授權 Tab button 預設 `style="display:none"`，由 JS 依 ADMIN_MODE 控制顯示

### Fix 4：架構文件

**新增（`ADMIN_ARCHITECTURE_NOTES.md`）：**
- 目前架構說明（Web POS + Android POS + ADMIN_MODE）
- API 權限表格
- 未來 Admin Console 架構預留
- 資料庫擴充預留欄位

---

## 修改檔案

| 檔案 | 修改內容 |
|------|---------|
| `public/license.js` | 完整重寫：事件委派修正、ADMIN_MODE 支援 |
| `server.js` | 移除所有 Web API 授權鎖、加入 /api/admin/status |
| `routes/license.js` | POST/PUT/DELETE 加 requireAdminMode |
| `public/index.html` | 授權 Tab 預設 display:none |

## 新增檔案

| 檔案 | 說明 |
|------|------|
| `middleware/adminGuard.js` | ADMIN_MODE 保護 middleware |
| `ADMIN_ARCHITECTURE_NOTES.md` | 架構說明與未來規劃 |
| `CHANGELOG_R1_FIX2.md` | 本版本更新紀錄 |
| `WEB_TEST_REPORT_R1_FIX2.md` | 測試報告 |
