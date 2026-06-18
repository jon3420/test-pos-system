# 報表分析頁修正 — fix16b

## 頁面結構
- 主選單 → 📊 報表分析 → `showPage('reports')` → `loadReportsPage()`
- `#page-reports .page`（無 display:none）→ `#reports-container`（由 JS 動態填入）

## Feature Gate
- `hasFeature('reports') === false` → 顯示「報表分析功能尚未授權」提示
- `hasFeature('reports') === true` → 呼叫 `_loadDashboard()`，拉取 GET /api/dashboard

## 舊版問題
`loadReportsPage` 只有 `container.innerHTML = '<div id="reports-page-inner"></div>'`，
`renderReportsTab` / `loadTodayStats` 均不存在，導致頁面空白。

fix16b 用完整的 `_renderDashboard()` 取代。
