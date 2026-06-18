# CHANGELOG_R1_FIX1 — POS v18 Web Online R1-Fix1

版本：**pos-v18-web-online-r1-fix1**  
日期：2026-05-29  
基於：pos-v18-web-online-r1

---

## 修正項目

### Fix 1：授權管理 UI（license.js 完整重寫）

**問題：** 後台「店家授權管理」Tab 可顯示 default_store，但無法操作新增/編輯/刪除。

**原因：**
- Modal 使用 `.btn-primary` / `.btn-secondary` CSS class，在 Modal overlay 的 stacking context 下樣式失效
- `showToast()` 缺少 `type` 參數，部分環境靜默失敗
- `patchSwitchSettingsTab()` 時序問題，hook 有時未正確生效

**修正（`public/license.js`）：**
- Modal 全面改用 inline style，不依賴外部 CSS
- `z-index: 99999` 確保 Modal 顯示在最上層
- `_hookLicenseTab()` 改用 `document.readyState` 確保執行時序正確
- `showToast()` 一律傳入 type 參數
- 新增 `licenseEdit()` 函式（`licenseOpenEditModal()` 保留為相容別名）
- 儲存按鈕加入 loading 狀態，防止重複提交

---

### Fix 2：食材匯入/匯出路由授權保護（server.js + app.js）

**問題：** 食材匯入顯示「更新 11 筆」但實際無資料；原因是 `/api/import/ingredients` 無授權保護，Basic 方案也能寫入 DB，但後續 `loadIngredientsPage()` 呼叫 `/api/ingredients` 被 403 攔截，畫面無法顯示資料。

**修正 A（`server.js`）：**
在 `/api/import/ingredients`、`/api/import/ingredient-formulas`、`/api/export/ingredients`、`/api/export/ingredient-formulas` 加入 `requireFeature('inventory')` 授權中介層。

```
Basic 方案 → POST /api/import/ingredients → HTTP 403（阻擋，不寫入 DB）
Pro 方案   → POST /api/import/ingredients → HTTP 200（寫入，畫面有資料）
```

**修正 B（`public/js/app.js`）：**
`submitImport()` 新增 HTTP 狀態檢查（`!res.ok`），403 / 非 200 時：
- 顯示錯誤訊息（不顯示成功）
- 不呼叫 `loadIngredientsPage()`
- 不觸發 `showToast('匯入完成')`

---

## 修改檔案清單

| 檔案 | 修改內容 |
|------|---------|
| `public/license.js` | 完整重寫（Modal inline style、時序修正、showToast 修正） |
| `server.js` | 食材 import/export 路由加 requireFeature('inventory') 保護 |
| `public/js/app.js` | `submitImport()` 加入 HTTP 狀態檢查，正確處理 403 |

---

## 未修改

- `routes/license.js` — 無變動（CRUD API 本身正常）
- `middleware/licenseGuard.js` — 無變動
- `routes/ingredients.js` — 無變動
- `routes/importExport.js` — 無變動（授權由 server.js middleware 控制）
- `routes/inventory.js` — 無變動
- `public/index.html` — 無變動
- Android 專案 — 無需修改（API 回傳格式未變）
