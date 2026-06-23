# 報表分析頁修正 — fix16a

## 問題
`<div id="page-reports" class="page" style="display:none">`
inline style 優先級高於 CSS class `.page.active { display: block }`，
導致 `showPage('reports')` 加上 active class 後頁面仍不顯示。

## 修正（public/index.html）
移除 `style="display:none"`：
```html
<!-- fix16 舊版（錯誤）-->
<div id="page-reports" class="page" style="display:none">

<!-- fix16a 修正 -->
<div id="page-reports" class="page">
```
頁面顯示完全交由 CSS class `.page` / `.page.active` 控制。
