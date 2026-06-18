# WEB_TEST_REPORT_R1_FIX2 — POS v18 Web Online R1-Fix2

測試日期：2026-05-29
版本：pos-v18-web-online-r1-fix2
測試方式：Node.js 自動化整合測試（20 項）

---

## 測試結果：20/20 PASS ✅

---

## ADMIN_MODE=false 測試（T1-T11）

| # | 測試項目 | 結果 |
|---|---------|------|
| T1 | GET /api/admin/status → { admin_mode: false } | ✅ |
| T2 | POST /api/license → HTTP 403（非管理員模式） | ✅ |
| T3 | PUT /api/license/:storeId → HTTP 403 | ✅ |
| T4 | GET /api/license/:storeId → 正常（Android 查詢） | ✅ |
| T5 | GET /api/online-orders → 無授權錯誤，不回傳「尚未開通」 | ✅ |
| T6 | GET /api/line-orders → 無授權錯誤 | ✅ |
| T7 | GET /api/ingredients → Basic 方案 Web POS 正常 | ✅ |
| T8 | GET /api/inventory → HTTP 200 | ✅ |
| T9 | POST /api/import/ingredients → 食材匯入成功 | ✅ |
| T10 | GET /api/export/ingredients → HTTP 200 | ✅ |
| T11 | GET /api/license/plans/defaults → 正常 | ✅ |

## ADMIN_MODE=true 測試（T12-T20）

| # | 測試項目 | 結果 |
|---|---------|------|
| T12 | GET /api/admin/status → { admin_mode: true } | ✅ |
| T13 | 新增店家授權（POST） | ✅ |
| T14 | 編輯授權 Basic → Pro + 讀取驗證 | ✅ |
| T15 | Pro 切回 Basic | ✅ |
| T16 | active=false → 停用訊息正確 | ✅ |
| T17 | Enterprise 功能全開儲存 | ✅ |
| T18 | 刪除店家授權 | ✅ |
| T19 | 扣料公式匯入成功 | ✅ |
| T20 | 匯出扣料公式 CSV HTTP 200 | ✅ |

**總計：20/20 PASS ✅**

---

## 編輯按鈕根因說明

**問題：** `onclick="licenseEdit("default_store")"` — 雙引號衝突，HTML parser
截斷 onclick 屬性，`licenseEdit` 從未被呼叫。

**修正：** 改用 `data-idx` attribute + `addEventListener('click', _licenseListClick)`
事件委派，不在 HTML 屬性中嵌入任何字串值。

## Web POS 自鎖問題說明

**r1-fix1 問題：** `/api/inventory`、`/api/ingredients`、`/api/import/ingredients`、
`/api/online-orders`、`/api/line-orders` 全部加了 `requireFeature()` middleware，
Basic 方案 Web POS 無法正常使用這些功能。

**r1-fix2 修正：** 授權 middleware 僅用於 `/api/license` CRUD 的管理員保護。
Web POS 所有 API 完整開放。Android POS 由自身 `LicenseManager` 控制功能開關。
