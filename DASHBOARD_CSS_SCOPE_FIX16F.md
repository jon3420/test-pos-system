# Dashboard CSS 範圍限制 — fix16f

## 修正
所有 dashboard CSS 限定在 `#page-reports` 範圍內：
```css
#page-reports .dashboard-grid { display: grid; }
#page-reports .dashboard-card { box-sizing: border-box; }
#page-reports .dashboard-section { width: 100%; margin-bottom: 20px; }
```
不影響點餐頁、商品頁、訂單頁等。
