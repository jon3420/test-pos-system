# WEB_TEST_REPORT_R1_FIX1 — POS v18 Web Online R1-Fix1

測試日期：2026-05-29  
版本：pos-v18-web-online-r1-fix1  
測試方式：Node.js 自動化整合測試（13 項，curl + Python assert）

---

## 測試結果：13/13 PASS ✅

---

## 問題根因分析

### 問題 1：授權管理 UI 無法新增/編輯/刪除

**根因：**
- `license.js` 中 Modal 使用 `class="btn-primary"` / `class="btn-secondary"`，但這些 class 的 CSS 可能與 Modal 的 `z-index` 衝突
- `showToast()` 呼叫缺少第二參數（type），部分環境無法顯示
- `patchSwitchSettingsTab()` 時序問題：license.js 在 app.js 之後執行，patch 時 `window.switchSettingsTab` 已存在但邏輯正確；然而 DOMContentLoaded 觸發時機導致某些情況 hook 未生效
- Modal 的 `<input>` 和 `<select>` 使用 class 樣式，在深色主題下可能不可見或不可互動

**修正：**
- Modal 全面改為 inline style，不依賴外部 CSS class
- Modal 覆蓋層 z-index 提升至 99999，確保在最上層
- `_hookLicenseTab()` 改為 `document.readyState` 判斷，確保 app.js 定義後才 hook
- 所有按鈕改為 inline style 直接渲染，不依賴 `.btn-primary` / `.btn-secondary`
- `showToast()` 呼叫加上 type 參數

### 問題 2：食材/扣料公式匯入異常

**根因：**
- `/api/import/ingredients` 路由掛在 `/api` 下，**未受授權保護**
- Basic 方案（inventory=false）可成功呼叫並寫入 DB（HTTP 200）
- 但匯入成功後呼叫 `loadIngredientsPage()` → `GET /api/ingredients` 被 `requireFeature('inventory')` 攔截（HTTP 403）
- 結果：資料寫入了 DB，但畫面顯示空白（重新載入失敗）
- `submitImport()` 未檢查 HTTP 狀態，直接解析 response body，遇到 403 仍可能顯示成功訊息

**修正：**
1. `server.js`：對 `/api/import/ingredients`、`/api/import/ingredient-formulas`、`/api/export/ingredients`、`/api/export/ingredient-formulas` 加入 `requireFeature('inventory')` 保護
2. `app.js`：`submitImport()` 新增 `!res.ok` 檢查，HTTP 403/非 200 直接顯示錯誤，不呼叫 `loadIngredientsPage()`，不顯示成功訊息

---

## 測試明細

| # | 測試項目 | 結果 |
|---|---------|------|
| 1 | 新增店家授權（POST /api/license） | ✅ PASS |
| 2 | 編輯店家授權（PUT /api/license/:storeId） | ✅ PASS |
| 3 | 讀取驗證編輯結果 | ✅ PASS |
| 4 | 刪除店家授權（DELETE /api/license/:storeId） | ✅ PASS |
| 5 | 方案切換 basic → pro（features 自動更新） | ✅ PASS |
| 6 | Basic inventory=false → 食材匯入被阻擋 403 | ✅ PASS |
| 7 | Pro inventory=true → 食材匯入成功（added=2） | ✅ PASS |
| 8 | Pro → GET /api/ingredients 有資料（畫面出現） | ✅ PASS |
| 9 | Pro → 扣料公式匯入成功 | ✅ PASS |
| 10 | Pro → 匯出食材 CSV HTTP 200 | ✅ PASS |
| 11 | Pro → 匯出扣料公式 CSV HTTP 200 | ✅ PASS |
| 12 | Basic → 匯出食材被阻擋 403 | ✅ PASS |
| 13 | GET /api/license/plans/defaults 路由正確 | ✅ PASS |

**總計：13/13 PASS ✅**

---

## 受保護的匯入/匯出路徑（需 inventory 授權）

| 路徑 | Method | 需要 Feature |
|------|--------|-------------|
| `/api/import/ingredients` | POST | `inventory` |
| `/api/import/ingredient-formulas` | POST | `inventory` |
| `/api/export/ingredients` | GET | `inventory` |
| `/api/export/ingredient-formulas` | GET | `inventory` |
| `/api/ingredients` | ALL | `inventory` |
| `/api/inventory` | ALL | `inventory` |

其餘匯入（商品、商品庫存）、匯出（商品）不受授權限制。
